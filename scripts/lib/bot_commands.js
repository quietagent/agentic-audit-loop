'use strict';

// What the bot does with the owner's messages and button presses: the commands and
// the /new conversation. The loop itself is in lib/loop.js.
// A handler never talks to Telegram to answer: it calls ctx.send(), which puts the
// message in the outbox, and the tick sends the outbox afterwards. The one network
// call in here is the download of a file the owner sent.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inlineKeyboard } = require('./telegram');
const { nameProblem, existingEntry, createProject, roundFile } = require('./projects');
const { jobState } = require('./jobs');
const { localStamp } = require('./runtime');
const { readInput, FILE_MAX_BYTES, TEXT_MAX, HOW_TO_SEND } = require('./owner_input');
const loop = require('./loop');
const controls = require('./loop_controls');
const { overnightSection } = require('./overnight');

const JOBS_KEPT = 20;

const HELP = [
  'Commands:',
  '/help - this list',
  '/ping - check that the bot is alive',
  '/new <name> - start a new project: I ask for GOAL.md, then for the first prompt',
  '/loop <name> - run the loop on a project: goal check, then rounds of builder, commit and auditor. You approve every next prompt.',
  '/overnight <name> <rounds> - run that many rounds back to back with no Approve, on the items of GOAL.md\'s "## Overnight" section only, '
    + 'until they are done, STOP_FOR_HUMAN, the round cap or 70% of the 7-day window. Its messages come without sound. It also continues a loop that ended at a proposed prompt.',
  '/status - where the loop stands: round, step, how long, the last verdict, context and usage',
  '/log [builder|loop] [N] - the last N lines (20, at most 100) of the builder\'s live log or of the loop\'s log',
  '/stop - stop the loop: at once when it waits for you, otherwise after the step that is running',
  '/abort - end the running step at once, after a Confirm. Nothing is committed.',
  '/resume <name> - continue a loop that ended or paused without being finished',
  '/secret <project> NAME value - save a key in the project\'s .env. I delete your message and never show the value.',
  '/secrets <project> - the names of the keys in the project\'s .env, never the values',
  '/testmode [on|off|set <key> <value>] - short timers for a test run. Alone it shows what is on. They switch off by themselves after 24 hours.',
  '/cancel - drop what I am waiting for: a /new step, an edit, a typed answer, a prompt',
].join('\n');

// Every command the bot knows, as the owner types it after the "/".
const COMMANDS = ['help', 'ping', 'new', 'loop', 'overnight', 'status', 'log', 'stop', 'abort', 'resume', 'secret', 'secrets', 'testmode', 'cancel'];
const COMMAND_SHAPE = /^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/;
const UNRUN_ARG_MAX = 60;

const bytesOf = (text) => Buffer.byteLength(text, 'utf8');
const clock = (iso) => localStamp(new Date(iso)).slice(11, 19);

function duration(seconds) {
  const s = Math.round(seconds);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

// ---- the owner check ----

// Who sent an update: its chat and its sender, or nulls.
function senderOf(update) {
  if (update.message) return { chat: update.message.chat || null, from: update.message.from || null };
  if (update.callback_query) {
    return { chat: (update.callback_query.message && update.callback_query.message.chat) || null, from: update.callback_query.from || null };
  }
  return { chat: null, from: null };
}

// Only the owner, in the private chat with the bot: the chat and the sender must both match.
function isFromOwner(update, owner) {
  const { chat, from } = senderOf(update);
  return Boolean(chat && from && chat.type === 'private' && chat.id === owner && from.id === owner);
}

// ---- /new ----

function startNew(name, ctx) {
  const root = ctx.settings.projectsRoot;
  const problem = nameProblem(name);
  if (problem) return ctx.send(`${problem}\nUse it like this: /new My_Project (letters, digits, "-" and "_", up to 40 characters).`);
  if (!fs.existsSync(root)) return ctx.send(`The projects root ${root} does not exist.`);
  const taken = existingEntry(root, name);
  if (taken) return ctx.send(`"${taken}" already exists in ${root}. Pick another name.`);
  // Text messages go to what the bot asked for last: an edit or a typed answer that
  // was pending is dropped, and the owner is told.
  const waiting = ctx.conversation();
  const dropped = waiting ? `Dropped: ${loop.describeWait(waiting)}.\n` : '';
  ctx.setConversation({ kind: 'new', step: 'goal', name });
  return ctx.send(`${dropped}New project ${name}, step 1 of 2: send GOAL.md, ${HOW_TO_SEND}.\n/cancel stops this.`);
}

function summaryOf(conversation, root) {
  const { name, goal, prompt } = conversation;
  const lines = goal.split(/\r?\n/);
  const first = lines.filter((line) => line.trim()).slice(0, 5).map((line) => `  ${line.length > 100 ? `${line.slice(0, 100)}...` : line}`);
  const text = [
    'Ready to create the project. Nothing exists yet.',
    `Name: ${name}`,
    `Folder: ${path.join(root, name)}`,
    `GOAL.md: ${bytesOf(goal)} bytes, ${lines.length} lines. It starts:`,
    ...first,
  ];
  if (!/definition of done/i.test(goal)) text.push('WARNING: GOAL.md has no "Definition of done". The auditor needs one to know when the project is finished.');
  // Phase 7: whether /overnight can run on it.
  const overnight = overnightSection(goal);
  if (!overnight.present) text.push('Overnight: GOAL.md has no "## Overnight" section, so /overnight cannot run on it; /loop can.');
  else if (!overnight.items.length) text.push('Overnight: GOAL.md has a "## Overnight" section with no item, so /overnight cannot run on it until it has one.');
  else text.push(`Overnight: GOAL.md has a "## Overnight" section with ${overnight.items.length === 1 ? '1 item' : `${overnight.items.length} items`}: /overnight can build ${overnight.items.length === 1 ? 'it' : 'them'} with no review.`);
  text.push(`First prompt: ${bytesOf(prompt)} bytes`);
  return text.join('\n');
}

async function continueNew(conversation, msg, ctx) {
  if (conversation.step === 'confirm') return ctx.send('Press Save or Cancel on the summary above, or send /cancel.');
  const input = await readInput(msg, ctx);
  const what = conversation.step === 'goal' ? 'GOAL.md' : 'the first prompt';
  if (input.problem) return ctx.send(`${input.problem}\nSend ${what} ${HOW_TO_SEND}, or /cancel.`);

  if (conversation.step === 'goal') {
    ctx.setConversation({ ...conversation, step: 'prompt', goal: input.text });
    return ctx.send(`GOAL.md received: ${bytesOf(input.text)} bytes.\nStep 2 of 2: send the first prompt for the builder, ${HOW_TO_SEND}.`);
  }
  const confirmId = crypto.randomBytes(6).toString('hex');
  const next = { ...conversation, step: 'confirm', prompt: input.text, confirmId };
  ctx.setConversation(next);
  return ctx.send(summaryOf(next, ctx.settings.projectsRoot), {
    replyMarkup: inlineKeyboard([[{ text: 'Save', data: `new:save:${confirmId}` }, { text: 'Cancel', data: `new:cancel:${confirmId}` }]]),
  });
}

function handleButton(query, ctx) {
  if (loop.handleLoopButton(query, ctx)) return undefined;
  const match = /^new:(save|cancel):([0-9a-f]+)$/.exec(query.data || '');
  const conversation = ctx.conversation();
  const live = match && conversation && conversation.kind === 'new' && conversation.step === 'confirm' && conversation.confirmId === match[2];
  // A button on an old message only answers that it has expired.
  if (!live) return ctx.answerButton(query.id, 'This button has expired.');

  if (match[1] === 'cancel') {
    ctx.setConversation(null);
    ctx.answerButton(query.id, 'Cancelled');
    return ctx.send(`Cancelled: ${conversation.name} was not created.`);
  }
  let created;
  try {
    created = createProject({
      root: ctx.settings.projectsRoot, name: conversation.name, goal: conversation.goal, prompt: conversation.prompt, n8nEnvFile: ctx.settings.n8nEnvFile,
    });
  } catch (err) {
    ctx.log(`/new ${conversation.name}: could not create the project: ${err.message}`);
    ctx.answerButton(query.id, 'Not created');
    return ctx.send(`The project was not created: ${err.message}\nNothing was left behind. Press Save to try again, or Cancel.`);
  }
  ctx.setConversation(null);
  ctx.log(`/new ${conversation.name}: created ${created.dir}, commit ${created.commit}`);
  ctx.answerButton(query.id, 'Saved');
  return ctx.send([
    `Created ${created.dir}`,
    `Commit ${created.commit} "Loop: GOAL.md" (.gitignore and GOAL.md)`,
    'The first prompt is saved as .audit\\round-01-prompt.md',
    `Next: /loop ${conversation.name}`,
  ].join('\n'));
}

// ---- jobs that Phase 3a's /build started ----

// /build is gone, but a state file from Phase 3a can still hold its job entries
// (kind "build"). Their record is the builder's summary. One that had not ended
// yet is reported here, as it was then.
function describeEnd(job, summary) {
  const status = {
    completed: 'completed',
    max_turns: 'stopped at the turn limit',
    error: 'claude reported an error',
    crashed: 'claude ended without a result',
  }[summary.status] || summary.status;
  const c = summary.context || {};
  const tokens = (n, percent) => `${Number(n || 0).toLocaleString('en-US')} tokens${percent === null || percent === undefined ? '' : ` (${percent}%)`}`;
  const lines = [
    `Builder finished: ${job.name}, round ${job.round}`,
    `Result: ${status} (exit code ${summary.exit_code})`,
  ];
  if (summary.error) lines.push(`Error: ${String(summary.error).slice(0, 500)}`);
  lines.push(
    `Time: ${clock(summary.started_at)} to ${clock(summary.finished_at)} (${duration(summary.duration_s)})`,
    `Turns: ${summary.turns ?? 'unknown'}, cost: ${Number.isFinite(summary.cost_usd) ? `$${summary.cost_usd.toFixed(4)}` : 'unknown'}`,
    `Context: peak ${tokens(c.peak_tokens, c.peak_percent)}, at the end ${tokens(c.final_tokens, c.final_percent)}`
      + `${c.window ? `, window ${c.window.toLocaleString('en-US')}` : ', window unknown'}`,
    `Compacted: ${summary.compacted ? `yes, ${summary.compactions.length} time(s)` : 'no'}`,
    summary.handoff_written
      ? 'HANDOFF.md: written in this round'
      : 'HANDOFF.md: NOT written in this round, so there is nothing to audit.',
  );
  const denials = summary.permission_denials || [];
  lines.push(`Denied tool calls: ${denials.length}`);
  for (const d of denials.slice(0, 5)) lines.push(`  ${d.tool} ${String(d.input).slice(0, 150)}`);
  if (denials.length > 5) lines.push(`  and ${denials.length - 5} more`);
  lines.push(
    `Session: ${summary.session_id || 'unknown'}`,
    `Records: ${path.dirname(job.summaryFile)} (round-${String(job.round).padStart(2, '0')}-builder.json, .log, .jsonl)`,
  );
  return lines.join('\n');
}

function reportJobs(ctx) {
  const { state } = ctx;
  for (const job of state.jobs) {
    if (job.ended) continue;
    const { phase, record: summary } = jobState(job, { onNote: ctx.log });
    if (summary && summary.session_id && !job.sessionReported) {
      job.sessionReported = true;
      ctx.send(`Builder session for ${job.name}: ${summary.session_id}\nTo take it over on the PC, run this in ${job.project}:\nclaude --resume ${summary.session_id}`);
    }
    if (phase === 'ended') {
      job.ended = true;
      ctx.log(`job ${job.id} (${job.name}, round ${job.round}) ended: ${summary.status}`);
      ctx.send(describeEnd(job, summary));
      ctx.sendFile(roundFile(job.project, job.round, 'builder.log'), `${job.name}-round-${String(job.round).padStart(2, '0')}-builder.log`,
        `The builder's log for ${job.name}, round ${job.round}`);
    } else if (phase === 'lost') {
      job.ended = true;
      ctx.log(`job ${job.id} (${job.name}, round ${job.round}) is lost: no sign of life`);
      ctx.send(`The builder for ${job.name}, round ${job.round}, ended without a result: its process is gone and its record has no end.\n`
        + `Look at ${job.logFile} and at ${job.summaryFile}.`);
    }
  }
  state.jobs = state.jobs.slice(-JOBS_KEPT);
}

// ---- messages ----

function cancel(ctx) {
  const conversation = ctx.conversation();
  if (!conversation) {
    // A loop that waits for the owner's prompt, after the wait itself was dropped.
    const active = loop.activeLoop(ctx);
    if (active && active.step === 'prompt-wait') return loop.cancelWait({ kind: 'loop-prompt', loop: active.id }, ctx);
    return ctx.send('There is nothing to cancel.');
  }
  if (conversation.kind === 'new') {
    ctx.setConversation(null);
    return ctx.send(`Cancelled: ${conversation.name} was not created.`);
  }
  return loop.cancelWait(conversation, ctx);
}

// What the owner sent while the bot was offline, in a few words, for the one message
// that says it did not run. Nothing of it is acted on. Two things are still done:
//   - a button press is answered, so that the button stops spinning;
//   - a /secret message is deleted from the chat. Its text goes nowhere: it is not
//     read past the command's name, not logged, not stored and not shown.
// A command the bot knows is named with what followed it; one it does not know is
// named alone, because what follows an unknown command could be anything.
function describeUnrun(update, ctx) {
  if (update.callback_query) {
    ctx.answerButton(update.callback_query.id, 'pressed while I was offline: press it again');
    return 'a button press';
  }
  const msg = update.message || {};
  if (msg.document) return 'a file';
  if (typeof msg.text !== 'string') return 'a message';
  const command = COMMAND_SHAPE.exec(msg.text.trim());
  if (!command) return 'a text message';
  const name = command[1].toLowerCase();
  if (name === 'secret') {
    ctx.deleteMessage(msg.message_id, {
      failText: 'I could not delete a /secret message that you sent while I was offline. Delete it yourself: it may hold the value.',
    });
    return '/secret (deleted, not saved)';
  }
  if (!COMMANDS.includes(name)) return `/${command[1].slice(0, 30)}`;
  const arg = (command[2] || '').replace(/\s+/g, ' ').trim();
  return `/${name}${arg ? ` ${arg.length > UNRUN_ARG_MAX ? `${arg.slice(0, UNRUN_ARG_MAX)}...` : arg}` : ''}`;
}

async function handleMessage(msg, ctx) {
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  const command = COMMAND_SHAPE.exec(text);
  if (command) {
    const name = command[1].toLowerCase();
    const arg = (command[2] || '').trim();
    if (name === 'help') return ctx.send(HELP);
    if (name === 'ping') return ctx.send(`pong ${localStamp()}`);
    if (name === 'new') return startNew(arg, ctx);
    if (name === 'loop') return loop.startLoop(arg, ctx);
    if (name === 'overnight') return loop.overnightLoop(arg, ctx);
    if (name === 'stop') return loop.stopLoop(ctx);
    if (name === 'abort') return loop.abortLoop(ctx);
    if (name === 'resume') return loop.resumeLoop(arg, ctx);
    if (name === 'status') return controls.statusCommand(ctx);
    if (name === 'log') return controls.logCommand(arg, ctx);
    // The text of a /secret message holds a key: it goes nowhere but into this call.
    if (name === 'secret') return controls.secretCommand(arg, msg, ctx);
    if (name === 'secrets') return controls.secretsCommand(arg, ctx);
    if (name === 'testmode') return controls.testModeCommand(arg, ctx);
    if (name === 'cancel') return cancel(ctx);
    return ctx.send(`I do not know /${command[1]}. Send /help for the list of commands.`);
  }
  // A text or a file goes to what the bot asked for last.
  const conversation = ctx.conversation();
  if (conversation && conversation.kind === 'new') return continueNew(conversation, msg, ctx);
  if (conversation && conversation.kind === 'loop-edit') return loop.editInput(conversation, msg, ctx);
  if (conversation && conversation.kind === 'loop-other') return loop.otherInput(conversation, msg, ctx);
  if (conversation && conversation.kind === 'loop-prompt') return loop.promptInput(conversation, msg, ctx);
  // A loop that waits for the owner's prompt takes it even after that wait was dropped.
  const active = conversation ? null : loop.activeLoop(ctx);
  if (active && active.step === 'prompt-wait') return loop.promptInput(null, msg, ctx);
  return ctx.send('I did not understand that. Send /help for the list of commands.');
}

async function handleUpdate(update, ctx) {
  if (update.message) return handleMessage(update.message, ctx);
  if (update.callback_query) return handleButton(update.callback_query, ctx);
  return undefined;
}

module.exports = { handleUpdate, reportJobs, isFromOwner, senderOf, describeEnd, describeUnrun, HELP, COMMANDS, FILE_MAX_BYTES, TEXT_MAX };
