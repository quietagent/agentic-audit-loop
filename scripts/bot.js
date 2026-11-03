#!/usr/bin/env node
'use strict';

// The loop's Telegram bot. n8n is only the clock: one workflow runs
// `node scripts/bot.js tick` every 5 seconds.
//
//   node scripts/bot.js tick [--config <file>]      one round of work, a few seconds at most
//   node scripts/bot.js whoami [--config <file>]    show who wrote to the bot (to find your chat ID)
//   node scripts/bot.js netcheck [--config <file>]  one request to Telegram, without the token
//
// A tick reads the new Telegram updates, handles them, moves the loop on when the
// job of its step has ended, sends what is waiting to be sent, and ends. Long work
// (the goal check, the builder, the auditor) runs as a background job that a tick
// starts without waiting for it. When Telegram does not answer, the tick still moves
// the loop on, and what it sends waits in the outbox (Phase 7b, lib/telegram_outage.js).
// A tick prints at most one short line. Its exit code is 0 unless the bot itself is
// broken: no network, a missing secret file or a tick that is still running are not errors.

// The router's DNS on this network does not answer for api.telegram.org. n8n loads
// this fix through NODE_OPTIONS, a plain terminal does not, so the bot loads it too.
// Loading it twice does nothing: the file checks whether it is installed already.
// The fix writes a log line per process; a tick is a new process every 5 seconds,
// so the bot switches that line off. The fix reads the switch when it would log.
process.env.DNS_FALLBACK_QUIET = '1';
require('../n8n-loop/dns-fallback.cjs');

const fs = require('node:fs');
const path = require('node:path');
const { createTelegram, TelegramError, splitText } = require('./lib/telegram');
const { createRedactor, guardOutput } = require('./lib/redact');
const { loadToken, loadOwnerChatId, SecretsError } = require('./lib/secrets');
const { createRuntime } = require('./lib/runtime');
const { readConfig, botSettings, ConfigError, DEFAULT_CONFIG } = require('./lib/config');
const { handleUpdate, reportJobs, isFromOwner, senderOf, describeUnrun } = require('./lib/bot_commands');
const { driveLoop, announceAfterGap, activeLoop } = require('./lib/loop');
const { isOvernight } = require('./lib/overnight');
const { noteUnreachable, endOutage } = require('./lib/telegram_outage');
const { secretValues } = require('./lib/project_env');
const { when } = require('./lib/loop_messages');
const { readTestSettings, clearTestSettings, describeTestSettings } = require('./lib/test_settings');

const USAGE = 'Usage: node scripts/bot.js tick|whoami|netcheck [--config <file>]';
// A tick stops taking on new work after this long; what is left waits for the next tick.
const TICK_BUDGET_MS = 20 * 1000;
const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DOCUMENT_MAX_BYTES = 1024 * 1024;
// No tick for longer than this: the PC or n8n was down, and the owner is told.
const OFFLINE_GAP_MS = 3 * 60 * 1000;
// The message about what was sent while the bot was offline names this many of them.
const UNRUN_SHOWN = 20;

let redact = (text) => String(text);
// Set once a tick knows its runtime folder: an unexpected error then goes to bot.log too.
let logFailure = null;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  let config = DEFAULT_CONFIG;
  for (let i = 0; i < rest.length; i += 1) {
    const m = /^--config(?:=(.*))?$/.exec(rest[i]);
    if (!m) throw new ConfigError(`unknown argument "${rest[i]}"\n${USAGE}`);
    const value = m[1] !== undefined ? m[1] : rest[i += 1];
    if (!value) throw new ConfigError(`--config needs a value\n${USAGE}`);
    config = path.resolve(value);
  }
  if (!['tick', 'whoami', 'netcheck'].includes(command)) throw new ConfigError(USAGE);
  return { command, config };
}

// Ends the process once the last line is out. Telegram's connection would
// otherwise keep it alive for a few more seconds.
function finish(code, line) {
  const done = () => process.exit(code);
  setTimeout(done, 2000).unref();
  if (line) process.stdout.write(`${redact(line)}\n`, done);
  else done();
}

// ---- the outbox: what is waiting to be sent ----

// The token filter for everything that goes into the outbox: every text in an item,
// the labels of its buttons included.
function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, redactDeep(inner)]));
  return value;
}

async function sendItem(item, telegram) {
  // item.silent (Phase 7): a message of an overnight run arrives without a sound. The
  // flag is kept on the outbox entry, so a message that goes out on a later tick keeps it.
  if (item.method === 'sendMessage') {
    await telegram.sendMessage(item.chatId, item.text, { replyMarkup: item.replyMarkup || null, silent: item.silent === true });
  } else if (item.method === 'answerCallbackQuery') {
    await telegram.answerCallbackQuery(item.callbackQueryId, { text: item.text });
  } else if (item.method === 'deleteMessage') {
    await telegram.deleteMessage(item.chatId, item.messageId);
  } else if (item.method === 'sendDocument') {
    if (!fs.existsSync(item.file)) throw new TelegramError(`sendDocument: ${item.file} is gone`, { method: 'sendDocument', transient: false });
    let content = fs.readFileSync(item.file);
    let caption = item.caption;
    if (content.length > DOCUMENT_MAX_BYTES) {
      content = content.subarray(content.length - DOCUMENT_MAX_BYTES);
      caption = `${caption} (the last 1 MB of it)`;
    }
    if (!content.length) content = Buffer.from('(empty)\n');
    // The files the bot sends are text. They go through the token filter like every message.
    const text = content.toString('utf8');
    if (Buffer.from(text, 'utf8').equals(content)) content = Buffer.from(redact(text), 'utf8');
    await telegram.sendDocument(item.chatId, { filename: item.filename, content, caption, silent: item.silent === true });
  }
}

// Sends the outbox in order. A message that cannot be sent now stays, and the
// ones after it wait behind it. One that Telegram refuses for good is dropped.
async function flushOutbox({ state, runtime, telegram, deadline }) {
  let sent = 0;
  while (state.outbox.length && Date.now() < deadline) {
    const item = state.outbox[0];
    let done = false;
    if (Date.now() - item.queuedAt > OUTBOX_MAX_AGE_MS) {
      runtime.log(`outbox: dropped a ${item.method} that waited more than 24 hours`);
    } else {
      try {
        await sendItem(item, telegram);
        sent += 1;
        done = true;
      } catch (err) {
        if (err instanceof TelegramError && err.transient) {
          runtime.log(`${err.network ? 'no network' : 'not sent'}: ${err.message}; ${state.outbox.length} waiting to be sent`);
          return { sent, stuck: true };
        }
        // Refused for good by Telegram, or not sendable at all (its file cannot be
        // read): dropped, so that one item can never block every tick after it.
        runtime.log(`outbox: dropped a ${item.method}: ${err.message}`);
      }
    }
    state.outbox.shift();
    // A deleted message leaves no trace in the chat, so the owner is told how it went.
    const follow = item.method === 'deleteMessage' ? (done ? item.okText : item.failText) : null;
    if (follow) state.outbox.unshift({ method: 'sendMessage', chatId: item.chatId, text: follow, replyMarkup: null, queuedAt: Date.now() });
    runtime.writeState(state);
  }
  return { sent, stuck: false };
}

// ---- after the bot was offline ----

// What the owner sent while the bot was offline is not acted on: after a kill switch
// (/abort, then stopping n8n), nothing he sent in between may run by itself later.
// Every update that was waiting is fetched and skipped, as on the very first tick,
// and one message names them. A /secret message is still deleted, and its text goes
// nowhere. state.skipWaiting stays set until all of that is done, so a tick without
// network cannot let the waiting updates through to the next one.
// Returns how many updates were skipped.
async function skipWaitingUpdates(updates, { state, runtime, telegram, ctx, owner }) {
  const unrun = [];
  let skipped = 0;
  let complete = true;
  for (let page = updates; ;) {
    for (const update of page) {
      skipped += 1;
      if (isFromOwner(update, owner)) {
        unrun.push(describeUnrun(update, ctx));
      } else {
        const { chat, from } = senderOf(update);
        runtime.log(`not the owner: chat ${chat ? chat.id : 'unknown'}, username ${from && from.username ? `@${from.username}` : '(none)'}`);
      }
      state.offset = update.update_id + 1;
    }
    if (page.length < 100) break;
    try {
      page = await telegram.getUpdates({ offset: state.offset });
    } catch (err) {
      if (!(err instanceof TelegramError)) throw err;
      // The rest is skipped by the next tick: state.skipWaiting stays.
      runtime.log(`${err.network ? 'no network' : 'no updates'}: ${err.message}`);
      complete = false;
      break;
    }
  }
  if (complete) delete state.skipWaiting;
  runtime.log(`after the gap: skipped ${skipped} update${skipped === 1 ? '' : 's'} that ${skipped === 1 ? 'was' : 'were'} waiting, `
    + `${unrun.length} of them from the owner. None was acted on.`);
  if (unrun.length) {
    const shown = unrun.slice(0, UNRUN_SHOWN).join(', ');
    const more = unrun.length > UNRUN_SHOWN ? `, and ${unrun.length - UNRUN_SHOWN} more` : '';
    ctx.send(`While I was offline you sent: ${shown}${more}. `
      + `${unrun.length === 1 ? 'It did not run. Send it again if you still want it.' : 'None of them ran. Send them again if you still want them.'}`);
  }
  runtime.writeState(state);
  return skipped;
}

// ---- tick ----

async function tick(settings, configFile) {
  let runtime = createRuntime(settings.runtimeDir);
  logFailure = (text) => createRuntime(settings.runtimeDir, redact).log(text);
  let token;
  let owner;
  try {
    token = loadToken(settings.secretsDir);
    redact = createRedactor([token]);
    guardOutput(redact);
    runtime = createRuntime(settings.runtimeDir, redact);
    owner = loadOwnerChatId(settings.secretsDir);
  } catch (err) {
    if (!(err instanceof SecretsError)) throw err;
    // Without the two secret files the tick does nothing else: no request to Telegram.
    runtime.log(`not set up: ${err.message}`);
    return finish(0, `not set up: ${path.basename(err.file)} is ${err.missing ? 'missing' : 'not valid'}`);
  }

  const release = runtime.acquireLock();
  if (!release) return finish(0, 'busy: another tick is running');
  try {
    const state = runtime.readState();
    // The keys of the active loop's project (its .env) are filtered like the bot
    // token: out of the log, the outbox and everything the loop writes.
    if (state.loop && typeof state.loop.project === 'string') {
      for (const { name, value } of secretValues(state.loop.project)) redact.add(name, value);
    }
    const telegram = createTelegram({ token, baseUrl: settings.telegramBaseUrl || undefined });
    const deadline = Date.now() + TICK_BUDGET_MS;
    // The outbox is saved in state.json, so everything in it goes through the token filter too.
    const queue = (item) => state.outbox.push({ ...redactDeep(item), queuedAt: Date.now() });
    const ctx = {
      state,
      settings,
      configFile,
      telegram,
      redact,
      log: runtime.log,
      // The bot's clock, for every timer of the loop. It is the PC's clock; only the
      // tests move it (config key testClockOffsetMs).
      now: () => Date.now() + settings.clockOffsetMs,
      conversation: () => state.conversations[owner] || null,
      setConversation: (value) => {
        if (value) state.conversations[owner] = value;
        else delete state.conversations[owner];
      },
      nextId: () => {
        const id = state.nextId;
        state.nextId += 1;
        return id;
      },
      // A text above Telegram's limit becomes several messages; the keyboard hangs on the last.
      // While ctx.silent is set (the loop at work on its own during an overnight run, see
      // driveLoop in lib/loop.js) every message and file goes out without a sound.
      silent: false,
      send: (text, { replyMarkup = null } = {}) => {
        const parts = splitText(text);
        parts.forEach((part, i) => queue({ method: 'sendMessage', chatId: owner, text: part, replyMarkup: i === parts.length - 1 ? replyMarkup : null, silent: ctx.silent === true }));
      },
      sendFile: (file, filename, caption) => queue({ method: 'sendDocument', chatId: owner, file, filename, caption, silent: ctx.silent === true }),
      answerButton: (callbackQueryId, text) => queue({ method: 'answerCallbackQuery', callbackQueryId, text }),
      // Deletes a message of the owner's chat. okText or failText is sent once it is known how that went.
      deleteMessage: (messageId, { okText = null, failText = null } = {}) => queue({ method: 'deleteMessage', chatId: owner, messageId, okText, failText }),
    };

    // The end of an outage of Telegram: one line in bot.log and, after 5 minutes or more,
    // one message to the owner that goes out first, before what waited in the outbox. In
    // an overnight run it comes without a sound, like the run's own messages.
    const tellOutageEnd = ({ line, text }) => {
      runtime.log(line);
      if (!text) return;
      const loop = activeLoop(ctx);
      state.outbox.unshift({ ...redactDeep({ method: 'sendMessage', chatId: owner, text, replyMarkup: null, silent: Boolean(loop && isOvernight(loop)) }), queuedAt: Date.now() });
    };

    // The test settings of /testmode. The config was read with them laid over it
    // (readConfig in lib/config.js); ctx.testSettings is what /status and the loop's
    // messages show.
    const nowMs = ctx.now();
    const test = readTestSettings(settings.runtimeDir, nowMs);
    ctx.testSettings = test.on ? test : null;

    // After the PC or n8n was down, the bot says so by itself: the first tick after a
    // gap of more than three minutes, then where the active loop stands. What this
    // queues is saved before the time of this tick is written down, so it cannot be lost.
    const lastTick = runtime.readLastTick();
    if (state.offset !== null && (lastTick === null || nowMs - lastTick > OFFLINE_GAP_MS)) {
      // An outage of Telegram that was still on when the bot went offline ends here, at
      // the last tick before the gap: what came after it is the gap's own message.
      if (state.telegramDown) tellOutageEnd(endOutage(state, { endMs: lastTick, nowMs, gap: true }));
      state.lastOffline = { from: lastTick === null ? null : new Date(lastTick).toISOString(), to: new Date(nowMs).toISOString() };
      // What the owner sent in the gap is skipped, not acted on: see skipWaitingUpdates().
      state.skipWaiting = true;
      if (lastTick === null) {
        runtime.log('the bot was offline: since when is not known (last-tick.txt was missing or not readable)');
        ctx.send(`The bot was offline until ${when(nowMs, nowMs)}. Since when is not known: its note of the last tick (runtime\\last-tick.txt) was missing or not readable.`);
      } else {
        runtime.log(`the bot was offline from ${new Date(lastTick).toISOString()} to ${new Date(nowMs).toISOString()}`);
        ctx.send(`The bot was offline from ${when(lastTick, nowMs)} to ${when(nowMs, nowMs)} (about ${Math.max(1, Math.round((nowMs - lastTick) / 60000))} min).`);
      }
      announceAfterGap(ctx);
      runtime.writeState(state);
    }
    runtime.writeLastTick(nowMs, lastTick);

    // Test settings switch off by themselves 24 hours after the last /testmode change.
    // From then on they count for nobody; here the file goes, and the owner is told.
    if (test.present && !test.on) {
      const gone = clearTestSettings(settings.runtimeDir);
      if (test.expired) {
        runtime.log(`test settings switched off by themselves, 24 hours after the last /testmode change: ${describeTestSettings(test.values)}`);
        if (gone) {
          ctx.send(`Test settings switched off by themselves: 24 hours have passed since the last /testmode change (${when(test.changedAt, nowMs)}). `
            + `They were: ${describeTestSettings(test.values)}. Every timer has its normal value again.`);
        }
      } else {
        runtime.log('runtime\\test-settings.json could not be used and was removed: no test setting is on');
        if (gone) ctx.send('The file of the test settings (runtime\\test-settings.json) could not be used, so I removed it. No test setting is on: every timer has its normal value. Send /testmode on again if you need them.');
      }
      runtime.writeState(state);
    }

    let updates;
    try {
      updates = await telegram.getUpdates({ offset: state.offset });
    } catch (err) {
      if (!(err instanceof TelegramError)) throw err;
      if (!err.network) {
        // Telegram answered and refused: the tick ends here.
        runtime.log(`no updates: ${err.message}`);
        return finish(0, 'Telegram refused getUpdates: see the log');
      }
      // Telegram is unreachable (Phase 7b). No update is handled, but the loop goes on:
      // a builder that ended is committed and audited, the next step starts, the timers
      // run. What it sends waits in the outbox, which is not sent now: each send would
      // wait for its own timeout. bot.log gets a line when the outage starts and every
      // 10 minutes while it lasts, not one per tick.
      const line = noteUnreachable(state, nowMs, err.message);
      if (line) runtime.log(line);
      reportJobs(ctx);
      driveLoop(ctx);
      runtime.writeState(state);
      return finish(0, 'no network');
    }
    // The first tick that reaches Telegram again ends the outage.
    if (state.telegramDown) {
      tellOutageEnd(endOutage(state, { endMs: nowMs, nowMs }));
      runtime.writeState(state);
    }

    let handled = 0;
    let skippedAfterGap = 0;
    if (state.offset === null) {
      // The very first tick: what was sent before the bot existed is not acted on.
      let skipped = 0;
      state.offset = 0;
      while (updates.length) {
        skipped += updates.length;
        state.offset = updates[updates.length - 1].update_id + 1;
        if (updates.length < 100) break;
        updates = await telegram.getUpdates({ offset: state.offset });
      }
      runtime.log(`first tick: skipped ${skipped} updates that were already waiting`);
      delete state.skipWaiting;
      runtime.writeState(state);
    } else if (state.skipWaiting) {
      skippedAfterGap = await skipWaitingUpdates(updates, { state, runtime, telegram, ctx, owner });
    } else {
      for (const update of updates) {
        if (Date.now() > deadline) break;
        if (isFromOwner(update, owner)) {
          try {
            await handleUpdate(update, ctx);
          } catch (err) {
            // One bad update must never block the ones after it.
            runtime.log(`update ${update.update_id} failed and was skipped: ${err.message}`);
            ctx.send(`That did not work and was skipped: ${String(err.message).slice(0, 300)}`);
          }
        } else {
          // No answer at all, and nothing of the message in the log.
          const { chat, from } = senderOf(update);
          runtime.log(`not the owner: chat ${chat ? chat.id : 'unknown'}, username ${from && from.username ? `@${from.username}` : '(none)'}`);
        }
        state.offset = update.update_id + 1;
        runtime.writeState(state);
        handled += 1;
      }
    }

    reportJobs(ctx);
    driveLoop(ctx);
    runtime.writeState(state);
    const { sent, stuck } = await flushOutbox({ state, runtime, telegram, deadline });
    const parts = [];
    if (handled) parts.push(`${handled} update${handled === 1 ? '' : 's'}`);
    if (skippedAfterGap) parts.push(`${skippedAfterGap} skipped after a gap`);
    if (sent) parts.push(`${sent} sent`);
    if (stuck) parts.push(`${state.outbox.length} waiting to be sent`);
    return finish(0, parts.length ? `ok: ${parts.join(', ')}` : 'idle');
  } finally {
    release();
  }
}

// ---- whoami ----

// Shows who wrote to the bot, so that the owner can read off his chat ID.
// It only reads: the saved offset is not moved and nothing is answered.
async function whoami(settings) {
  let token;
  try {
    token = loadToken(settings.secretsDir);
  } catch (err) {
    if (!(err instanceof SecretsError)) throw err;
    return finish(2, err.message);
  }
  redact = createRedactor([token]);
  guardOutput(redact);
  // Only a look: a damaged state file is not repaired here. That is the tick's work.
  const state = createRuntime(settings.runtimeDir, redact).readState({ repair: false });
  const telegram = createTelegram({ token, baseUrl: settings.telegramBaseUrl || undefined });
  let updates;
  try {
    updates = await telegram.getUpdates({ offset: state.offset });
  } catch (err) {
    if (!(err instanceof TelegramError)) throw err;
    return finish(1, err.message);
  }
  const seen = new Map();
  for (const update of updates) {
    const { chat, from } = senderOf(update);
    if (!chat) continue;
    const name = from ? [from.first_name, from.last_name].filter(Boolean).join(' ') : '';
    seen.set(`${chat.id}/${from ? from.id : ''}`,
      `chat ID ${chat.id} (${chat.type} chat), name: ${name || '(none)'}, username: ${from && from.username ? `@${from.username}` : '(none)'}`);
  }
  if (!seen.size) {
    return finish(0, 'No message is waiting. Send any message to your bot in Telegram, then run this again.\n'
      + 'If the bot\'s workflow is already active in n8n, it has taken the messages: deactivate it first.');
  }
  return finish(0, [`${updates.length} waiting update(s), from:`, ...seen.values(),
    '', 'Put your chat ID, the number only, in owner-chat-id.txt next to bot-token.txt.'].join('\n'));
}

// ---- netcheck ----

// One request to Telegram's server, without the token: does this process reach it?
async function netcheck(settings) {
  const telegram = createTelegram({ token: 'not-used', baseUrl: settings.telegramBaseUrl || undefined });
  try {
    const status = await telegram.reach();
    return finish(0, `${telegram.baseUrl}/ answered with HTTP ${status}`);
  } catch (err) {
    if (!(err instanceof TelegramError)) throw err;
    return finish(1, `${telegram.baseUrl}/ did not answer: ${err.message}`);
  }
}

async function main() {
  const { command, config } = parseArgs(process.argv.slice(2));
  const settings = botSettings(readConfig(config), config);
  if (command === 'tick') return tick(settings, config);
  if (command === 'whoami') return whoami(settings);
  return netcheck(settings);
}

// A tick that fails on something unexpected says so in bot.log too. Otherwise the
// error would only be in n8n's list of failed executions, where nobody looks.
function fail(err) {
  const bad = err instanceof ConfigError;
  if (!bad && logFailure) {
    try {
      logFailure(`tick failed: ${err && err.message ? err.message : err}`);
    } catch {
      // the log itself cannot be written: stderr below is all that is left
    }
  }
  process.stderr.write(`${redact(`[bot] ${bad ? '' : 'error: '}${err && err.message ? err.message : err}`)}\n`, () => process.exit(bad ? 2 : 1));
  setTimeout(() => process.exit(bad ? 2 : 1), 2000).unref();
}

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
main().catch(fail);
