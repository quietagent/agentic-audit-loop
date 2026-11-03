'use strict';

// The commands that look at a loop without changing it (/status, /log), the two
// that keep a project's keys (/secret, /secrets), and /testmode, which sets the
// short timers of a test run. The commands that change a loop (/loop, /stop,
// /abort, /resume) are in lib/loop.js.

const fs = require('node:fs');
const path = require('node:path');
const { activeLoop, liveLogFile, findProject, loopLogFile, openQuestions } = require('./loop');
const { jobState } = require('./jobs');
const O = require('./overnight');
const { readJsonSafe } = require('./runtime');
const { ignoresEnv } = require('./loop_git');
const { setEnvValue, envNames, envFile, NAME_SHAPE } = require('./project_env');
const { SECRET_MIN_LENGTH } = require('./redact');
const { readConfig, botSettings } = require('./config');
const T = require('./test_settings');
const M = require('./loop_messages');
const { telegramLine } = require('./telegram_outage');

const LOG_LINES_DEFAULT = 20;
const LOG_LINES_MAX = 100;
// A longer answer goes out as a file.
const LOG_TEXT_MAX = 3500;
const OUT_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const percent = (share) => `${Math.round(share * 100)}%`;

// ---- /status ----

// The step of a loop, in the owner's words.
function stepWords(loop, nowMs) {
  const stopping = loop.stopping ? ', stopping: the loop ends when this step ends' : '';
  switch (loop.step) {
    case 'goal-check': return `goal check: the auditor is checking GOAL.md${stopping}`;
    case 'builder': return `building${stopping}`;
    case 'auditor': return `auditing${stopping}`;
    case 'followup': return `auditing: the follow-up after your answers${stopping}`;
    case 'questions': {
      const open = loop.questions.items.filter((item) => !item.answer);
      return `waiting for you: ${M.plural(open.length, 'question')} of the auditor (${open.map((item) => `${item.n} [${item.tag}]`).join(', ')})`;
    }
    case 'proposal': return `waiting for you: Approve, Edit or Stop on the prompt for round ${loop.proposal.round}`;
    case 'choice': return `waiting for you: Redo the round, Keep and audit or Stop (the builder of round ${loop.choice.round} was cut off)`;
    case 'prompt-wait': return `waiting for you: your prompt for round ${loop.promptWait.round}`;
    case 'paused': return `paused until ${M.when(loop.pause.resumeAt, nowMs)}: the ${M.jobWords(loop.pause.step)} hit the plan's usage limit`;
    default: return loop.step;
  }
}

// "5-hour window 21% used, resets 07:10; 7-day window 9% used (as of 06:55)"
// old: the usage may be hours old (no loop runs). A window whose reset time has
// passed since then has reset: its old percentage is not shown. The "as of" time is
// left to the caller.
function usageWords(usage, nowMs, { old = false } = {}) {
  if (!usage) return null;
  const parts = [];
  const resetSince = (at) => old && at && Date.parse(at) <= nowMs;
  for (const [key, title] of [['five_hour', '5-hour window'], ['seven_day', '7-day window']]) {
    const window = usage[key];
    if (window && resetSince(window.resets_at)) {
      parts.push(`${title} has reset since (at ${M.when(window.resets_at, nowMs)})`);
    } else if (window && Number.isFinite(window.utilization)) {
      parts.push(`${title} ${percent(window.utilization)} used${window.resets_at ? `, resets ${M.when(window.resets_at, nowMs)}` : ''}`);
    }
  }
  if (!parts.length && resetSince(usage.resets_at)) {
    parts.push(`${usage.type || 'the limit'} has reset since (at ${M.when(usage.resets_at, nowMs)})`);
  } else {
    if (!parts.length && Number.isFinite(usage.utilization)) parts.push(`${usage.type || 'limit'} ${percent(usage.utilization)} used`);
    if (!parts.length && usage.resets_at) parts.push(`${usage.type || 'the limit'} resets ${M.when(usage.resets_at, nowMs)}`);
    if (usage.status && usage.status !== 'allowed') parts.push(`status "${usage.status}"`);
  }
  if (!parts.length) return null;
  return old ? parts.join('; ') : `${parts.join('; ')} (as of ${M.when(usage.seen_at, nowMs)})`;
}

// With no loop running: the last usage that any job reported (state.lastUsage),
// with the time it was seen.
function idleUsageLine(usage, nowMs) {
  const words = usage && typeof usage === 'object' ? usageWords(usage, nowMs, { old: true }) : null;
  return words ? `Usage (as of ${M.when(usage.seen_at, nowMs)}): ${words}` : 'Usage: not known yet: it comes with a Claude call.';
}

function offlineLine(ctx, nowMs) {
  const last = ctx.state.lastOffline;
  if (!last) return 'Bot last offline: none on record.';
  const until = M.when(last.to, nowMs);
  return last.from
    ? `Bot last offline: ${M.when(last.from, nowMs)} to ${until} (about ${Math.max(1, Math.round((Date.parse(last.to) - Date.parse(last.from)) / 60000))} min).`
    : `Bot last offline: until ${until}. Since when is not known.`;
}

function statusCommand(ctx) {
  const nowMs = ctx.now();
  const loop = activeLoop(ctx);
  const lines = [];
  // Test settings must never be forgotten: while any is on, /status starts with them.
  if (ctx.testSettings) lines.push(T.testSettingsLine(ctx.testSettings.values));
  if (loop) {
    lines.push(`${loop.name}: ${loop.round > 0 ? `Round ${loop.round} of ${loop.cap}` : `before round 1, at most ${M.plural(loop.cap, 'round')}`}`);
    if (O.isOvernight(loop)) {
      // Phase 7: the overnight run, its 7-day stop with the last share seen, and the open questions.
      const share = O.sevenDayShare(loop.usage || ctx.state.lastUsage);
      lines.push(`Overnight run: round ${loop.round} of ${loop.cap}. It stops at ${ctx.settings.overnightSevenDayPercent}% of the 7-day window `
        + `(now ${share === null ? 'not known yet' : percent(share)}). ${M.plural(openQuestions(loop).length, 'open question')}.`);
    }
    lines.push(`Step: ${stepWords(loop, nowMs)}`);
    const since = (loop.job && loop.job.clockStartedAt) || loop.stepSince || loop.updatedAt;
    lines.push(`In this step for: ${M.span(nowMs - Date.parse(since))} (since ${M.when(since, nowMs)})`);
    let live = null;
    if (loop.job) {
      // The heartbeat is written by the job itself, on the PC's own clock.
      const { phase, record } = jobState(loop.job);
      const beat = record && (record.heartbeat_at || record.started_at);
      lines.push(`Job ${loop.job.id}: ${phase}${beat ? `, heartbeat ${M.span(Date.now() - Date.parse(beat))} ago` : ', its record is not written yet'}`);
      if (loop.job.kind === 'builder') live = readJsonSafe(loop.job.summaryFile).value;
    }
    const verdict = loop.lastVerdict;
    lines.push(verdict
      ? `Last verdict: ${verdict.verdict} (${verdict.kind === 'goal-check' ? 'goal check' : `round ${verdict.round}`}): ${M.oneLine(verdict.reason)}`
      : 'Last verdict: none yet.');
    const done = Object.keys(loop.rounds).map(Number).filter((round) => loop.rounds[round].builder).sort((a, b) => b - a)[0];
    const context = [];
    if (done) {
      const info = loop.rounds[done].builder;
      context.push(`round ${done}: ${info.peak_percent !== null ? `${info.peak_percent}% of the window at the peak` : `${Number(info.peak_tokens || 0).toLocaleString('en-US')} tokens at the peak`}`
        + `${info.compactions ? `, compacted ${M.plural(info.compactions, 'time')}` : ''}`);
    }
    if (live && live.context) context.push(`this round so far: ${Number(live.context.peak_tokens || 0).toLocaleString('en-US')} tokens at the peak (the % comes when the round ends)`);
    lines.push(`Context: ${context.join('; ') || 'no builder round has ended yet.'}`);
    lines.push(`Usage: ${usageWords((live && live.rate_limit) || loop.usage, nowMs) || 'not known yet: it comes with a Claude call.'}`);
  } else {
    lines.push('No loop is running.');
    const last = ctx.state.lastLoop;
    lines.push(last
      ? `Last loop: ${last.name}, ended ${M.when(last.endedAt, nowMs)}: ${last.why}${last.resumable ? ` /resume ${last.name} continues it.` : ''}`
      : 'Last loop: none on record.');
    lines.push(idleUsageLine(ctx.state.lastUsage, nowMs));
  }
  lines.push(offlineLine(ctx, nowMs));
  // Phase 7b: the last time Telegram was unreachable for 5 minutes or more, when there was one.
  const telegram = telegramLine(ctx.state, nowMs);
  if (telegram) lines.push(telegram);
  return ctx.send(lines.join('\n'));
}

// ---- /log ----

// The builder's log of the round with the highest number, or of `round` when it has one.
function builderLog(project, round) {
  const dir = path.join(project, '.audit');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => /^round-\d+-builder\.log$/.test(name)).sort();
  } catch {
    return null;
  }
  const own = `round-${M.pad(round)}-builder.log`;
  const name = names.includes(own) ? own : names.pop();
  return name ? path.join(dir, name) : null;
}

function removeOldOutFiles(dir) {
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (Date.now() - fs.statSync(file).mtimeMs > OUT_FILE_MAX_AGE_MS) fs.unlinkSync(file);
    }
  } catch {
    // no such folder yet
  }
}

function logCommand(arg, ctx) {
  const usage = 'Use it like this: /log, /log 50, /log builder, /log loop 100 (at most 100 lines).';
  let which = null;
  let wanted = LOG_LINES_DEFAULT;
  for (const token of arg.split(/\s+/).filter(Boolean)) {
    if (/^(builder|loop)$/i.test(token)) which = token.toLowerCase();
    else if (/^\d+$/.test(token) && Number(token) > 0) wanted = Number(token);
    else return ctx.send(`I do not understand "${token.slice(0, 40)}".\n${usage}`);
  }
  const count = Math.min(wanted, LOG_LINES_MAX);

  const loop = activeLoop(ctx);
  const last = ctx.state.lastLoop;
  const name = loop ? loop.name : (last && last.name);
  const project = loop ? loop.project : (last && last.project);
  if (!project) return ctx.send('There is no loop to show a log of: none is running, and none has ended since the bot keeps track.');
  const running = Boolean(loop && loop.job && loop.job.kind === 'builder');
  if (!which) which = running ? 'builder' : 'loop';

  const file = which === 'builder' ? (running ? liveLogFile(loop) : builderLog(project, loop ? loop.round : 0)) : loopLogFile(project);
  let lines = null;
  try {
    lines = file ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim()) : null;
  } catch {
    // handled below
  }
  if (!lines) return ctx.send(which === 'builder' ? `${name}: there is no builder log yet.` : `${name}: there is no loop.log yet.`);
  const shown = lines.slice(-count);
  const what = which === 'builder'
    ? `the builder's ${running ? 'live ' : ''}log (.audit\\${path.basename(file)})`
    : `the loop's log (.audit\\loop.log)${loop ? '' : ', of the loop that ended last'}`;
  const head = `${name}: the last ${M.plural(shown.length, 'line')} of ${what}${wanted > LOG_LINES_MAX ? `. ${LOG_LINES_MAX} is the most` : ''}:`;
  const text = `${head}\n${shown.join('\n')}`;
  if (text.length <= LOG_TEXT_MAX) return ctx.send(text);

  // Too long for a message: as a file. It is written in the bot's own folder.
  const dir = path.join(ctx.settings.runtimeDir, 'out');
  removeOldOutFiles(dir);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `log-${ctx.nextId()}.txt`);
  fs.writeFileSync(out, ctx.redact(`${shown.join('\n')}\n`));
  return ctx.sendFile(out, `${name}-${which === 'builder' ? path.basename(file) : 'loop.log'}-last-${shown.length}.txt`, head.replace(/:$/, '.'));
}

// ---- /secret and /secrets ----

// Marks that Telegram applied formatting to a message: it then delivers the text
// without the marks (* _ ~ |), so a value that holds them arrives changed.
const FORMATTED = ['bold', 'italic', 'underline', 'strikethrough', 'spoiler', 'blockquote', 'expandable_blockquote', 'custom_emoji'];

// /secret <project> NAME value: saves a key in the project's .env. The value is
// never repeated, logged or kept: the message itself is deleted from the chat.
function secretCommand(arg, msg, ctx) {
  const usage = 'Use it like this: /secret My_Project NAME value';
  // Deleted in every case: even a message I refuse may hold a key.
  ctx.deleteMessage(msg.message_id, {
    okText: 'Your /secret message was deleted from this chat.',
    failText: 'I could not delete your /secret message. Delete it yourself: it may hold the value.',
  });
  const match = /^(\S+)\s+(\S+)\s+([\s\S]*\S)\s*$/.exec(arg);
  if (!match) return ctx.send(`/secret needs a project, a name and a value. Nothing was saved.\n${usage}`);
  const [, projectName, name, value] = match;
  // From here on the value is replaced in everything this tick writes or sends.
  const filtered = ctx.redact.add(NAME_SHAPE.test(name) ? name : 'SECRET', value);

  const found = findProject(projectName, ctx);
  if (found.problem) return ctx.send(`/secret was refused: ${found.problem.replace(/\.$/, '')}. Nothing was saved.\n${usage}`);
  const { entry, project } = found;
  if (!NAME_SHAPE.test(name)) {
    return ctx.send('/secret was refused: the name may only have capital letters, digits and "_", and must not start with a digit (like API_KEY). Nothing was saved.');
  }
  if (/[\r\n]/.test(value)) return ctx.send('/secret was refused: the value must be on one line. Nothing was saved.');
  if (!fs.existsSync(path.join(project, '.git'))) return ctx.send(`/secret was refused: ${entry} is not a git repository. Nothing was saved.`);
  if (!ignoresEnv(project, { n8nEnvFile: ctx.settings.n8nEnvFile })) {
    return ctx.send(`/secret was refused: ${entry}'s .gitignore does not ignore .env, so the key could end up in a commit. `
      + 'Add the line ".env" to .gitignore and commit that. Nothing was saved.');
  }
  const { replaced } = setEnvValue(project, name, value);
  ctx.log(`/secret ${entry}: ${name} ${replaced ? 'replaced' : 'added'} in .env (${value.length} characters; the value is never logged)`);
  const lines = [`Saved ${name} in ${envFile(project)}: ${replaced ? 'it replaced the value that was there' : 'a new name'}. I do not show the value.`];
  if (!filtered) {
    lines.push(`Note: the value has fewer than ${SECRET_MIN_LENGTH} characters. It is saved, but too short to be filtered out of logs, messages and commits.`);
  }
  if (Array.isArray(msg.entities) && msg.entities.some((entity) => FORMATTED.includes(entity.type))) {
    lines.push('Note: Telegram applied formatting to your message, so characters such as * or _ may be missing from the value. '
      + 'Check the file, or send it again with the value between backticks.');
  }
  lines.push(`/secrets ${entry} lists the names.`);
  return ctx.send(lines.join('\n'));
}

// /secrets <project>: the names in the project's .env, never a value.
function secretsCommand(arg, ctx) {
  const found = findProject(arg, ctx);
  if (found.usage) return ctx.send(`${found.problem}\nUse it like this: /secrets My_Project`);
  if (found.problem) return ctx.send(found.problem.replace(/^there/, 'There'));
  const names = envNames(found.project);
  if (!names.length) return ctx.send(`${found.entry} has no key yet: ${fs.existsSync(envFile(found.project)) ? 'its .env names none' : 'there is no .env'}. /secret ${found.entry} NAME value saves one.`);
  return ctx.send(`${found.entry}: ${M.plural(names.length, 'name')} in .env, values not shown:\n${names.join('\n')}`);
}

// ---- /testmode ----

// The six keys with the values the config file gives them, without any test setting.
function normalValues(ctx) {
  const normal = botSettings(readConfig(ctx.configFile, { testSettings: false }), ctx.configFile);
  return Object.fromEntries(T.KEYS.map((key) => [key, normal[key]]));
}

// After /testmode changed the file: the rest of this tick works with the new values,
// as every later tick does. The config is read again, through the same one place.
function applyTestSettings(ctx) {
  const fresh = botSettings(readConfig(ctx.configFile), ctx.configFile);
  for (const key of T.KEYS) ctx.settings[key] = fresh[key];
  const test = T.readTestSettings(ctx.settings.runtimeDir, ctx.now());
  ctx.testSettings = test.on ? test : null;
}

// What is on, with the normal value of each key next to it.
function testModeLines(ctx) {
  const test = ctx.testSettings;
  const normal = normalValues(ctx);
  const nowMs = ctx.now();
  return [
    T.testSettingsLine(test.values),
    `Normal values: ${T.describeTestSettings(Object.fromEntries(Object.keys(test.values).map((key) => [key, normal[key]])))}`,
    `Last changed at ${M.when(test.changedAt, nowMs)}. They switch off by themselves at ${M.when(test.expiresAt, nowMs)}, 24 hours after the last /testmode change.`,
    '/testmode off removes them now.',
  ];
}

// /testmode                    shows what is on
// /testmode on                 the main test run's timers: a default answer after 2 minutes, a reminder every 5
// /testmode set <key> <value>  one key: one of T.KEYS, and a number above 0
// /testmode off                removes every test setting
// Anything else is refused. Only a key of the list and a number are ever saved: no
// path, URL, token or folder can come in through this command.
function testModeCommand(arg, ctx) {
  const usage = 'Use it like this: /testmode (shows what is on), /testmode on, /testmode set <key> <value>, /testmode off.';
  const keys = `Keys: ${T.KEYS.join(', ')}. Each value is a number above 0.`;
  const refuse = (why) => ctx.send(`/testmode was refused: ${why} Nothing was changed.\n${usage}\n${keys}`);
  const tokens = arg.split(/\s+/).filter(Boolean);
  const action = (tokens[0] || '').toLowerCase();
  const before = ctx.testSettings ? ctx.testSettings.values : {};
  const preset = T.describeTestSettings(T.PRESET);

  if (!tokens.length) {
    if (ctx.testSettings) return ctx.send(testModeLines(ctx).join('\n'));
    return ctx.send([
      'No test setting is on: every timer has its normal value.',
      `/testmode on sets the main test run's timers: ${preset} (a default answer after 2 minutes, a reminder every 5 minutes).`,
      '/testmode set <key> <value> sets one key.',
      keys,
    ].join('\n'));
  }

  let next;
  if (action === 'off' && tokens.length === 1) {
    if (!T.clearTestSettings(ctx.settings.runtimeDir)) return ctx.send('The file of the test settings (runtime\\test-settings.json) could not be removed. Send /testmode off again.');
    applyTestSettings(ctx);
    const were = T.describeTestSettings(before);
    ctx.log(`/testmode off: ${were ? `removed ${were}` : 'none was on'}`);
    return ctx.send(were
      ? `Test settings are off. They were: ${were}. Every timer has its normal value again.`
      : 'No test setting was on. Every timer has its normal value.');
  }
  if (action === 'on' && tokens.length === 1) {
    next = { ...before, ...T.PRESET };
  } else if (action === 'set') {
    if (tokens.length !== 3) return refuse('"set" needs a key and a value, like /testmode set stuckBuilderMinutes 0.5.');
    const key = T.canonicalKey(tokens[1]);
    // What was typed is repeated only when it is a plain word.
    if (!key) return refuse(`${/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(tokens[1]) ? `"${tokens[1]}"` : 'that'} is not a test setting.`);
    const value = T.parseValue(tokens[2]);
    if (value === null) return refuse(`the value of ${key} must be a number above 0, like 2 or 0.5.`);
    next = { ...before, [key]: value };
  } else {
    return refuse('I do not understand that.');
  }
  T.writeTestSettings(ctx.settings.runtimeDir, next, ctx.now());
  applyTestSettings(ctx);
  ctx.log(`/testmode ${action}: ${T.describeTestSettings(next)}`);
  return ctx.send(testModeLines(ctx).join('\n'));
}

module.exports = { statusCommand, logCommand, secretCommand, secretsCommand, testModeCommand, stepWords, usageWords, idleUsageLine };
