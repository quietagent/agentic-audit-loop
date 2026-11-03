'use strict';

// The loop: a goal check, then rounds of builder -> commit -> auditor -> the owner's
// Approve / Edit / Stop, until DONE, a stop, or the round cap.
//
// The tick drives it. Each tick looks at the active loop (driveLoop): when the job
// of its step has ended, the next step starts, and the timers of a step are checked
// (the stuck alert, reminders, the default answer, the end of a pause). The owner's
// commands, button presses and texts come in through the other functions here.
// Nothing in this file waits for a job: the goal check, the builder and the auditor
// run as background jobs.
//
// State: <project>/.audit/loop.json, written after every step (temp file, flushed,
//   renamed, with loop.json.bak). runtime/state.json only points to the active loop.
// Log:   <project>/.audit/loop.log, one line per step, with the time.
//
// The steps (loop.step):
//   goal-check   a job: run_auditor.js --goal-check
//   questions    waiting for the owner's answers to the auditor's questions
//   builder      a job: run_builder.js --round N
//   auditor      a job: run_auditor.js --round N
//   followup     a job: the same again, once the answers are in DECISIONS.md
//   proposal     waiting for Approve / Edit / Stop on the prompt for round N+1
//   paused       the plan's usage limit was reached: the step runs again when it resets
//   choice       a builder was cut off: waiting for Redo the round / Keep and audit / Stop
//   prompt-wait  after /resume: waiting for the owner's own prompt for the next round
//   ended        loop.end says why, and how /resume can go on from there (end.resume)
//
// One loop at a time, and one job at a time. Every timer works from a time that is
// saved in loop.json, so a restart of the bot neither loses nor repeats one.
//
// The overnight run (Phase 7, /overnight <name> <rounds>): the same machine with
// loop.mode === 'overnight'. The loop approves every proposed prompt itself
// (approveByLoop), checks the 7-day window before every builder round, answers
// DEFAULT questions at once, leaves MUST questions after a round open
// (loop.openQuestions, with live buttons) and runs the follow-up at once, ends instead
// of a long usage-limit pause, and sends everything it sends on its own without a
// sound (ctx.silent, set in driveLoop). The readers and rules are in lib/overnight.js.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ROOT } = require('./config');
const { nameProblem, existingEntry, roundFile } = require('./projects');
const { newJob, launchJob, jobState } = require('./jobs');
const { checkClaude } = require('./claude_process');
const { projectProblem, repoProblem, treeProblem, commitRound, headCommit, statusShort, stashRound, historySince, roundRecords } = require('./loop_git');
const { appendDecisions, answerOpenQuestion } = require('./decisions');
const O = require('./overnight');
const { readInput, TEXT_MAX, HOW_TO_SEND } = require('./owner_input');
const { writeFileAtomic, writeJsonAtomic, appendDurable, readJsonSafe, localStamp, isPlainObject } = require('./runtime');
const { killJobProcesses } = require('./process_tree');
const { buildReport, reportFile } = require('./loop_report');
const { describeTestSettings, testSettingsLine } = require('./test_settings');
const M = require('./loop_messages');

const RUN_AUDITOR = path.join(ROOT, 'scripts', 'run_auditor.js');
const RUN_BUILDER = path.join(ROOT, 'scripts', 'run_builder.js');
const STEPS = ['goal-check', 'questions', 'builder', 'auditor', 'followup', 'proposal', 'paused', 'choice', 'prompt-wait', 'ended'];
const VERDICTS = ['CONTINUE', 'DONE', 'ASK_HUMAN', 'STOP_FOR_HUMAN'];
// Button data, at most 20 of Telegram's 64 bytes:
//   lp:<loop id>:<proposal id>:a|e|s        Approve, Edit, Stop
//   lq:<loop id>:<question id>:0..3|o       option number, or Other
//   lc:<loop id>:<choice id>:r|k|s          Redo the round, Keep and audit, Stop
//   la:<loop id>:<abort id>:y|n             Confirm, Cancel
const BUTTON = /^l([pqca]):([0-9a-f]{8}):([0-9a-f]{6}):([a-z0-9])$/;
const BUTTON_ACTIONS = { p: 'aes', q: '0123o', c: 'rks', a: 'yn' };
const EXPIRED = 'This button has expired.';
const EDIT_HOW = 'Send a note as a text message: it goes to the top of the prompt and takes priority. '
  + 'Or send a .md or .txt file (up to 100 KB): it replaces the whole prompt.';
const ABORT_BUTTON_MS = 2 * 60 * 1000;
// After the limit's reset time, before the step runs again.
const AFTER_RESET_MS = 2 * 60 * 1000;
// An audit or a goal check whose process died runs again by itself, this often in a row.
const LOST_RERUNS = 2;
const BUILDER_RECORDS = [['builder.json', '.json'], ['builder.json.bak', '.json.bak'], ['builder.jsonl', '.jsonl'], ['builder.log', '.log'], ['builder-input.md', '-input.md']];

const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const nowIso = (ctx) => new Date(ctx.now()).toISOString();
const clock = (iso) => localStamp(new Date(iso)).slice(11, 19);
const loopFile = (project) => path.join(project, '.audit', 'loop.json');
const loopLogFile = (project) => path.join(project, '.audit', 'loop.log');
const gitOptions = (ctx) => ({ n8nEnvFile: ctx.settings.n8nEnvFile });
const where = (loop) => (loop.round > 0 ? `round ${loop.round}: ` : '');
const ofRound = (loop) => (loop.round > 0 ? ` of round ${loop.round}` : '');
// The MUST questions an overnight run left open and nobody has answered yet.
const openQuestions = (loop) => (Array.isArray(loop.openQuestions) ? loop.openQuestions : []).filter((q) => !q.answer);
const readGoal = (project) => {
  try {
    return fs.readFileSync(path.join(project, 'GOAL.md'), 'utf8');
  } catch {
    return '';
  }
};
const OVERNIGHT_USAGE = `Use it like this: /overnight My_Project 5 (the number is how many more rounds the run may do, from 1 to ${O.ROUNDS_MAX}).`;

// null for a usable loop.json, else the reason.
function loopProblem(value) {
  if (!isPlainObject(value)) return 'not a JSON object';
  const good = typeof value.id === 'string' && typeof value.name === 'string' && typeof value.project === 'string'
    && STEPS.includes(value.step) && Number.isInteger(value.rev) && Number.isInteger(value.round)
    && Number.isInteger(value.cap) && isPlainObject(value.rounds);
  return good ? null : 'not a loop state file';
}

// ---- state and log ----

// One line in <project>/.audit/loop.log and in the bot's log.
function logStep(ctx, loop, text) {
  const line = ctx.redact(String(text)).replace(/\r?\n/g, ' | ');
  try {
    appendDurable(loopLogFile(loop.project), `${localStamp()} ${line}\n`);
  } catch (err) {
    ctx.log(`loop ${loop.name}: could not write loop.log: ${err.message}`);
  }
  ctx.log(`loop ${loop.name}: ${line}`);
}

// Every save has the next "rev". runtime/state.json keeps the rev it last saw: a
// tick that was cut off between the two writes is found by the two numbers.
function saveLoop(ctx, loop) {
  loop.rev += 1;
  loop.updatedAt = nowIso(ctx);
  writeFileAtomic(loopFile(loop.project), ctx.redact(`${JSON.stringify(loop, null, 2)}\n`), { backup: true, check: loopProblem });
  if (ctx.state.loop && ctx.state.loop.id === loop.id) ctx.state.loop.rev = loop.rev;
}

// A new step, and since when: /status and the stuck alert count from here.
function setStep(ctx, loop, step) {
  loop.step = step;
  loop.stepSince = nowIso(ctx);
}

// ---- test settings (/testmode) ----

// The line that the start and end messages of every loop carry while a test setting
// is on, as a list of zero or one lines.
function testLines(ctx) {
  return ctx.testSettings ? [testSettingsLine(ctx.testSettings.values)] : [];
}

// Keeps in loop.json which test settings were on during the loop, and since when:
// LOOP_REPORT.md lists them. Returns true when they changed since the last look.
function noteTestSettings(ctx, loop) {
  const now = ctx.testSettings ? describeTestSettings(ctx.testSettings.values) : '';
  const seen = Array.isArray(loop.testSettings) ? loop.testSettings : [];
  const last = seen.length ? seen[seen.length - 1].settings : '';
  if (now === last) return false;
  loop.testSettings = [...seen, { at: nowIso(ctx), settings: now }];
  return true;
}

// The owner's pending text wait (an Edit, a typed answer, a prompt), when it belongs to a loop.
function loopWait(ctx) {
  const conversation = ctx.conversation();
  return conversation && ['loop-edit', 'loop-other', 'loop-prompt'].includes(conversation.kind) ? conversation : null;
}

function dropLoopWait(ctx) {
  if (loopWait(ctx)) ctx.setConversation(null);
}

// What the bot was waiting for, in words: for the line that says it was dropped.
function describeWait(conversation) {
  if (conversation.kind === 'new') return `the new project ${conversation.name} (nothing was created)`;
  if (conversation.kind === 'loop-edit') return `the edit of ${conversation.name}'s prompt for round ${conversation.round} (the prompt is as it was, and its buttons still work)`;
  if (conversation.kind === 'loop-other') return `the typed answer to ${conversation.name}'s question ${conversation.n} (its buttons still work)`;
  if (conversation.kind === 'loop-prompt') return `the prompt for ${conversation.name}'s round ${conversation.round} (the loop still waits for it: send it afterwards)`;
  return 'what I was waiting for';
}

// Text messages go to what the bot asked for last. Returns a line about what was
// dropped to make room, or ''.
function replaceWait(ctx, next) {
  const old = ctx.conversation();
  ctx.setConversation(next);
  const same = old && old.kind === next.kind && old.buttonId && old.buttonId === next.buttonId;
  return old && !same ? `Dropped: ${describeWait(old)}.\n` : '';
}

// The active loop, read once per tick. A loop.json that is damaged is never fatal:
// its backup is used, and when that is damaged too the loop ends with a message.
function activeLoop(ctx) {
  if (ctx.loopLoaded) return ctx.loop;
  ctx.loopLoaded = true;
  ctx.loop = null;
  const pointer = ctx.state.loop;
  if (!pointer) return null;

  const read = readJsonSafe(loopFile(pointer.project), { repair: true, check: loopProblem });
  const loop = read.value && read.value.id === pointer.id ? read.value : null;
  if (!loop) {
    const why = read.value ? 'loop.json there belongs to another loop' : (read.note || 'loop.json is missing');
    ctx.log(`loop ${pointer.name}: its state is lost (${why}): the loop is ended`);
    ctx.state.loop = null;
    dropLoopWait(ctx);
    ctx.send([
      `${pointer.name}: the loop ended. Its state file .audit\\loop.json could not be used, and neither could its backup: ${why}.`,
      'Nothing was changed in the project. If a builder or an auditor was running, it runs on to its end, but nobody reports it.',
      `Records: ${path.join(pointer.project, '.audit')} (loop.log and the round-NN-* files say how far it got)`,
    ].join('\n'));
    return null;
  }
  if (read.source === 'backup') {
    ctx.log(`loop ${loop.name}: state recovered: ${read.note}`);
    ctx.send(`${loop.name}: .audit\\loop.json could not be used (${read.note}). The loop goes on from its last good copy, which can be one step behind.`);
    // loop.json is made whole again at once, so that this is found and said one time only.
    try {
      writeFileAtomic(loopFile(loop.project), `${JSON.stringify(loop, null, 2)}\n`);
    } catch (err) {
      ctx.log(`loop ${loop.name}: could not write loop.json again: ${err.message}`);
    }
  }
  if (loop.step === 'ended') {
    // The tick that ended it was cut off before it could say so.
    ctx.send(loop.end && loop.end.text ? loop.end.text : M.endText(loop, 'It had ended already.'));
    ctx.state.loop = null;
    dropLoopWait(ctx);
    return null;
  }
  ctx.loop = loop;
  if (loop.rev !== pointer.rev) {
    // loop.json and state.json are two files: the last tick got to write only one of them.
    ctx.log(`loop ${loop.name}: loop.json is at write ${loop.rev} and state.json saw write ${pointer.rev}: showing where the loop stands`);
    pointer.rev = loop.rev;
    announce(ctx, loop);
  }
  return loop;
}

// ---- jobs ----

// Starts the job of a step. The step and the job are saved before the process
// starts: a job is never running without a trace in loop.json.
function startJob(ctx, loop, { step, kind, script, args }) {
  const extra = kind === 'builder' ? { summaryFile: roundFile(loop.project, loop.round, 'builder.json'), sessionReported: false } : {};
  const job = newJob({ id: ctx.nextId(), kind, runtimeDir: ctx.settings.runtimeDir, round: loop.round, ...extra });
  // On the bot's own clock: the stuck alert counts from here.
  job.clockStartedAt = nowIso(ctx);
  job.alerts = 0;
  // A record left behind under the same number must not be taken for this job's.
  for (const old of [job.recordFile, `${job.recordFile}.bak`]) fs.rmSync(old, { force: true });
  setStep(ctx, loop, step);
  loop.job = job;
  loop.abort = null;
  saveLoop(ctx, loop);
  launchJob(job, {
    command: process.execPath,
    args: [script, ...args, '--config', ctx.configFile],
    cwd: ROOT,
    n8nEnvFile: ctx.settings.n8nEnvFile,
  });
  logStep(ctx, loop, `${where(loop)}${M.jobWords(kind)} started (job ${job.id})`);
}

function startGoalCheck(ctx, loop) {
  loop.goalChecks += 1;
  loop.round = 0;
  startJob(ctx, loop, { step: 'goal-check', kind: 'goal-check', script: RUN_AUDITOR, args: ['--project', loop.project, '--goal-check'] });
}

function startBuilder(ctx, loop, round) {
  loop.round = round;
  // Round 1 has no Approve: its prompt is the one the owner sent with /new. The
  // record of it is kept here, as approve() keeps it for every later round: the
  // auditor's material names who wrote the prompt (PROMPT RECORD).
  if (round === 1 && !(loop.rounds[1] && loop.rounds[1].prompt)) {
    const file = roundFile(loop.project, 1, 'prompt.md');
    loop.rounds[1] = {
      ...(loop.rounds[1] || {}),
      prompt: {
        startedAt: nowIso(ctx), edits: 0, notes: 0, bytes: fs.existsSync(file) ? fs.statSync(file).size : null,
        noteTexts: [], fromFile: false, source: 'new',
      },
    };
  }
  startJob(ctx, loop, { step: 'builder', kind: 'builder', script: RUN_BUILDER, args: ['--project', loop.project, '--round', String(round)] });
}

// A round and its follow-up are the same command: run_auditor.js sees that the round
// asked the human and that DECISIONS.md is newer than that, and runs the follow-up.
// A round's audit covers everything since the last commit that was audited: that is
// HEAD~1 in a loop that ran without a break, and more after a round that was not
// audited or after the owner's own commits.
function startAuditor(ctx, loop, step) {
  const base = step === 'auditor' && loop.auditedHead ? ['--base', loop.auditedHead] : [];
  startJob(ctx, loop, { step, kind: step, script: RUN_AUDITOR, args: ['--project', loop.project, '--round', String(loop.round), ...base] });
}

// What an audit job gave: { verdict }, { limit, error } when the plan's usage limit
// ended the call, or { error }.
function auditOutcome(record) {
  let printed = null;
  try {
    printed = JSON.parse(record.stdout);
  } catch {
    // nothing usable was printed
  }
  if (record.exit_code === 0 && isPlainObject(printed) && VERDICTS.includes(printed.verdict)) return { verdict: printed };
  const detail = record.error || (isPlainObject(printed) && printed.error) || `it ended with exit code ${record.exit_code} and no verdict`;
  if (isPlainObject(printed) && isPlainObject(printed.usage_limit)) return { limit: printed.usage_limit, error: String(detail).slice(0, 1500) };
  return { error: String(detail).slice(0, 1500) };
}

// The latest word on the plan's usage, for /status. It is kept in runtime\state.json
// too, with the time it was seen: /status shows it when no loop runs.
function noteUsage(ctx, loop, rateLimit) {
  if (!isPlainObject(rateLimit)) return;
  loop.usage = rateLimit;
  ctx.state.lastUsage = { ...rateLimit, seen_at: rateLimit.seen_at || nowIso(ctx) };
}

// ---- the end ----

// Writes .audit\LOOP_REPORT.md and sends it. A report that cannot be written never
// keeps a loop from ending.
function sendReport(ctx, loop) {
  try {
    const file = reportFile(loop.project);
    const history = historySince(loop.project, loop.baseCommit || null, gitOptions(ctx));
    writeFileAtomic(file, ctx.redact(buildReport(loop, history, { goal: readGoal(loop.project), model: ctx.settings.model, effort: ctx.settings.effort })));
    ctx.sendFile(file, `${loop.name}-LOOP_REPORT.md`, `${loop.name}: the loop's report. Bring this file to Claude in chat for the final check.`);
  } catch (err) {
    ctx.log(`loop ${loop.name}: could not write LOOP_REPORT.md: ${err.message}`);
  }
}

// resume says how /resume can go on from this end: { how: 'none' } for a loop that is done.
function endLoop(ctx, loop, why, lines = [], resume = { how: 'none' }) {
  // Questions an overnight run left open outlive the run: /resume asks them first.
  const open = openQuestions(loop);
  const openLines = open.length
    ? [`${M.plural(open.length, 'question')} of the auditor ${open.length === 1 ? 'is' : 'are'} still open (left for later during the overnight run): `
      + `/resume ${loop.name} asks ${open.length === 1 ? 'it' : 'them'} again before it goes on.`]
    : [];
  const text = ctx.redact(M.endText(loop, why, [...lines, ...openLines], testLines(ctx)));
  noteTestSettings(ctx, loop);
  if (O.isOvernight(loop) && loop.overnight) {
    loop.overnight.endedAt = nowIso(ctx);
    loop.overnight.lastRound = loop.round;
    loop.overnight.how = M.oneLine(why).slice(0, 300);
  }
  setStep(ctx, loop, 'ended');
  loop.job = null;
  loop.stopping = false;
  loop.pause = null;
  loop.abort = null;
  loop.end = { at: nowIso(ctx), why, text, resume };
  try {
    saveLoop(ctx, loop);
  } catch (err) {
    ctx.log(`loop ${loop.name}: could not save its end in loop.json: ${err.message}`);
  }
  logStep(ctx, loop, `loop ended: ${why}`);
  ctx.send(text);
  sendReport(ctx, loop);
  dropLoopWait(ctx);
  ctx.state.loop = null;
  ctx.state.lastLoop = { id: loop.id, name: loop.name, project: loop.project, endedAt: loop.end.at, why: M.oneLine(why).slice(0, 300), resumable: resume.how !== 'none' };
  ctx.loop = null;
}

// ---- /loop: the pre-flight check and the start ----

// The project folder of a name, or { problem }.
function findProject(name, ctx) {
  const root = ctx.settings.projectsRoot;
  const problem = nameProblem(name);
  if (problem) return { problem, usage: true };
  const entry = fs.existsSync(root) ? existingEntry(root, name) : null;
  if (!entry) return { problem: `there is no project named ${name} in ${root}.` };
  const project = path.join(root, entry);
  if (!fs.statSync(project).isDirectory()) return { problem: `${entry} in ${root} is not a folder.` };
  return { entry, project };
}

// A line about what keeps a loop from starting or going on, or null.
function busyProblem(ctx) {
  const running = activeLoop(ctx);
  if (running) return `a loop is already running: ${M.label(running)} (${standing(running)}). One loop at a time; /stop ends it.`;
  const oldJob = ctx.state.jobs.find((job) => !job.ended && ['starting', 'running'].includes(jobState(job).phase));
  if (oldJob) return `a job is still running: the builder for ${oldJob.name}, started at ${clock(oldJob.startedAt)}.`;
  return null;
}

// A refused /loop or /resume: the message to the owner, and the same as one line in bot.log.
function refusal(ctx, command, why) {
  const text = `${command} was refused: ${why}`;
  ctx.log(text);
  return ctx.send(text);
}

function startLoop(name, ctx) {
  const refuse = (why) => refusal(ctx, '/loop', why);
  const found = findProject(name, ctx);
  if (found.usage) return ctx.send(`${found.problem}\nUse it like this: /loop My_Project`);
  if (found.problem) return refuse(found.problem);
  const { entry, project } = found;
  // One loop at a time comes first: while a loop runs, that is the reason, whatever
  // else is wrong with the project that was named.
  const busy = busyProblem(ctx);
  if (busy) return refuse(busy);
  const projectIssue = projectProblem(project, gitOptions(ctx));
  if (projectIssue) return refuse(`${entry}: ${projectIssue}`);

  const claude = checkClaude({ n8nEnvFile: ctx.settings.n8nEnvFile });
  if (!claude.ok) return refuse(`${claude.problem}. Nothing was started.`);

  const loop = newLoop(ctx, { entry, project, cap: ctx.settings.roundCap });
  logStep(ctx, loop, `---- /loop ${entry}: loop ${loop.id} started, at most ${loop.cap} rounds, claude ${claude.version} ----`);
  if (noteTestSettings(ctx, loop)) logStep(ctx, loop, `test settings are on: ${describeTestSettings(ctx.testSettings.values)}`);
  startGoalCheck(ctx, loop);
  return ctx.send([
    `${entry}: the loop started, with at most ${M.plural(loop.cap, 'round')}. First the auditor checks GOAL.md (goal check ${loop.goalChecks}).`,
    '/stop ends the loop.',
    ...testLines(ctx),
  ].join('\n'));
}

// A new loop on a project, made the active one. Nothing is started yet.
function newLoop(ctx, { entry, project, cap }) {
  // A loop.json of an earlier loop here (one that ended before round 1) must not
  // become this loop's backup.
  const file = loopFile(project);
  if (fs.existsSync(file)) fs.renameSync(file, path.join(project, '.audit', `loop-before-${localStamp().slice(0, 19).replace(/[-:]/g, '').replace(' ', '-')}.json`));
  fs.rmSync(`${file}.bak`, { force: true });

  const started = nowIso(ctx);
  const loop = {
    version: 2,
    id: hex(4),
    rev: 0,
    name: entry,
    project,
    cap,
    startedAt: started,
    updatedAt: started,
    stepSince: started,
    step: 'goal-check',
    round: 0,
    stopping: false,
    job: null,
    goalChecks: 0,
    questions: null,
    proposal: null,
    rounds: {},
    decisions: [],
    lastVerdict: null,
    end: null,
    // Since Phase 4:
    baseCommit: headCommit(project, gitOptions(ctx)),
    auditedHead: null,
    goalCheckRuns: [],
    usage: null,
    pause: null,
    choice: null,
    promptWait: null,
    abort: null,
    ends: [],
    // Since Phase 5 prep: the test settings that were on, and since when.
    testSettings: [],
    // Since Phase 7: 'normal' or 'overnight' (a loop from before has no mode and is
    // normal); the overnight run's record; the MUST questions it left open.
    mode: 'normal',
    overnight: null,
    openQuestions: [],
  };
  ctx.state.loop = { id: loop.id, name: entry, project, rev: 0 };
  ctx.loopLoaded = true;
  ctx.loop = loop;
  return loop;
}

// Where a loop stands, in a few words.
function standing(loop) {
  if (loop.job) return `${M.jobWords(loop.job.kind)} running since ${clock(loop.job.startedAt)}${loop.stopping ? ', stopping' : ''}`;
  if (loop.step === 'questions') {
    const open = loop.questions.items.filter((item) => !item.answer).length;
    return `waiting for your ${open === 1 ? 'answer to 1 question' : `answers to ${open} questions`}`;
  }
  if (loop.step === 'proposal') return `waiting for Approve, Edit or Stop on the prompt for round ${loop.proposal.round}`;
  if (loop.step === 'paused') return `paused until ${clock(loop.pause.resumeAt).slice(0, 5)}: the plan's usage limit was reached`;
  if (loop.step === 'choice') return `waiting for Redo the round, Keep and audit or Stop: the builder of round ${loop.choice.round} was cut off`;
  if (loop.step === 'prompt-wait') return `waiting for your prompt for round ${loop.promptWait.round}`;
  return loop.step;
}

// ---- /stop ----

function stopLoop(ctx) {
  const loop = activeLoop(ctx);
  if (!loop) return ctx.send('No loop is running.');
  if (!loop.job) {
    // It waits for the owner, or for the usage limit: it ends at once.
    if (loop.step === 'proposal') {
      return endLoop(ctx, loop, `Stopped at once by /stop: no job was running, it waited for your Approve, Edit or Stop on the prompt for round ${loop.proposal.round}.`,
        [`The proposed prompt stays in .audit\\${path.basename(M.proposalFiles(loop, loop.proposal.round).proposed)}.`], { how: 'proposal', round: loop.proposal.round });
    }
    if (loop.step === 'paused') {
      return endLoop(ctx, loop, `Stopped at once by /stop, during the pause for the plan's usage limit. The ${M.jobWords(loop.pause.step)}${ofRound(loop)} did not run again.`, [], loop.pause.next);
    }
    if (loop.step === 'choice') {
      return endLoop(ctx, loop, `Stopped at once by /stop: no job was running, it waited for your choice after the builder of round ${loop.choice.round} was cut off.`,
        ['Nothing was changed: what the round left is still in the folder, uncommitted.'], { how: 'choice', round: loop.choice.round, reason: loop.choice.reason });
    }
    if (loop.step === 'prompt-wait') {
      return endLoop(ctx, loop, `Stopped at once by /stop: no job was running, it waited for your prompt for round ${loop.promptWait.round}.`, [], { how: 'new-prompt', round: loop.promptWait.round });
    }
    return endLoop(ctx, loop, 'Stopped at once by /stop: no job was running, it waited for your answers to the auditor\'s questions.', [], { how: 'questions' });
  }
  const words = M.jobWords(loop.job.kind);
  if (loop.stopping) return ctx.send(`${M.label(loop)}: already stopping. The loop ends when the ${words} ends.`);
  loop.stopping = true;
  saveLoop(ctx, loop);
  logStep(ctx, loop, `/stop while the ${words} runs: the loop ends after this step`);
  const after = {
    'goal-check': 'When it ends, the loop ends: no builder starts.',
    builder: 'When it ends, its round is committed, not audited, and the loop ends.',
    auditor: 'When it has its verdict, I report it and the loop ends.',
    followup: 'When it has its verdict, I report it and the loop ends.',
  }[loop.job.kind];
  return ctx.send(`${M.label(loop)}: stopping, not at once. The ${words} is at work and is not cut off. ${after}`);
}

// ---- questions ----

// The set a question belongs to, for its message: the pending questions of the step,
// or, for a question an overnight run left open, its own round's set.
const setOf = (loop, found) => (found.open ? { round: found.item.round, items: new Array(found.item.total || 1) } : loop.questions);

function sendQuestion(ctx, loop, item, found = { item, open: false }) {
  ctx.send(M.questionText(loop, setOf(loop, found), item), { replyMarkup: M.questionKeyboard(loop, item) });
}

// The question a button belongs to: one of the step's pending questions, or one that
// the overnight run left open (its buttons stay live while the loop goes on).
// { item, open } or null.
function findQuestion(loop, buttonId) {
  if (!loop) return null;
  const pending = loop.step === 'questions' && loop.questions ? loop.questions.items.find((q) => q.buttonId === buttonId) : null;
  if (pending) return { item: pending, open: false };
  const open = (loop.openQuestions || []).find((q) => q.buttonId === buttonId);
  return open ? { item: open, open: true } : null;
}

// The auditor asked (ASK_HUMAN): one message per question, each with its buttons.
// In an overnight run the DEFAULT ones are answered at once, and the MUST ones after a
// round are left open: see overnightQuestions().
function askQuestions(ctx, loop, verdict, intro) {
  // run_auditor.js never lets this through. Without a question nobody could ever answer.
  if (!Array.isArray(verdict.questions) || !verdict.questions.length) {
    return endLoop(ctx, loop, 'The auditor said ASK_HUMAN without a question.', [`Reason: ${M.oneLine(verdict.reason)}`],
      verdict.kind === 'goal-check' ? { how: 'goal-check' } : { how: 'auditor', round: loop.round, step: 'auditor' });
  }
  setStep(ctx, loop, 'questions');
  loop.job = null;
  loop.questions = {
    source: verdict.kind === 'goal-check' ? 'goal-check' : 'round',
    round: loop.round,
    askedAt: verdict.finished_at,
    // On the bot's clock: the reminders and the default answer count from here.
    sentAt: nowIso(ctx),
    remindedAt: null,
    items: verdict.questions.map((q) => ({
      n: q.n, tag: q.tag, question: q.question, options: q.options, recommended: q.recommended, buttonId: hex(3), answer: null,
    })),
  };
  saveLoop(ctx, loop);
  ctx.send(intro.join('\n'));
  for (const item of loop.questions.items) sendQuestion(ctx, loop, item);
  if (O.isOvernight(loop)) return overnightQuestions(ctx, loop, verdict);
  return undefined;
}

// Questions in an overnight run (Phase 7). DEFAULT ones get the recommended option at once. MUST
// ones: at the goal check the loop waits (the owner is there when he starts the run);
// after a round they are left open and the follow-up runs at once; when a follow-up
// asks again, the loop waits, and nothing more runs on its own in that round.
function overnightQuestions(ctx, loop, verdict) {
  const questions = loop.questions;
  const defaults = questions.items.filter((item) => item.tag === 'DEFAULT');
  if (defaults.length) assumeDefaults(ctx, loop, defaults, { atOnce: true });
  if (loop.step !== 'questions') return undefined; // every question was DEFAULT: the auditor is asked again already
  const must = questions.items.filter((item) => !item.answer);
  const place = M.label(loop, questions.round);
  const them = must.length === 1 ? 'it' : 'them';
  if (questions.source === 'goal-check') {
    return ctx.send(`${place}: ${M.plural(must.length, 'question')} tagged MUST: the loop waits for your answer. The overnight run starts its rounds only after the goal check.`);
  }
  if (verdict.kind === 'followup') {
    return ctx.send(`${place}: the follow-up asks again: ${M.plural(must.length, 'question')} tagged MUST. Every overnight item that is left depends on an open question, or a new one came up, `
      + `so the loop waits for your answer to ${them}. Nothing more runs on its own in this round.`);
  }
  return leaveOpen(ctx, loop, must);
}

// An overnight run leaves the MUST questions of a round open: they go to DECISIONS.md
// marked "(open)", their buttons stay live, and the follow-up runs at once so that the
// auditor can pick an overnight item that does not depend on them.
function leaveOpen(ctx, loop, items) {
  const questions = loop.questions;
  const place = M.label(loop, questions.round);
  const title = `Round ${questions.round}`;
  const written = appendDecisions(loop.project, {
    title,
    answers: questions.items.map((q) => (q.answer
      ? { question: q.question, answer: q.answer.text, mark: q.answer.how === 'assumed' ? 'assumed' : 'answered' }
      : { question: q.question, answer: '', mark: 'open' })),
    newerThan: questions.askedAt,
  });
  loop.decisions.push({
    at: nowIso(ctx), title, items: questions.items.map((q) => ({ n: q.n, tag: q.tag, question: q.question, answer: q.answer ? q.answer.text : null, how: q.answer ? q.answer.how : 'open' })),
  });
  loop.openQuestions = [
    ...(loop.openQuestions || []),
    ...items.map((q) => ({ ...q, round: questions.round, total: questions.items.length, askedAt: questions.askedAt, openedAt: nowIso(ctx), answer: null })),
  ];
  loop.questions = null;
  dropLoopWait(ctx);
  logStep(ctx, loop, `round ${questions.round}: ${M.plural(items.length, 'MUST question')} left open (an overnight run does not wait for an answer): written as (open) in ${path.basename(written.file)}; the follow-up runs now`);
  startAuditor(ctx, loop, 'followup');
  const one = items.length === 1;
  return ctx.send(`${place}: ${M.plural(items.length, 'question')} tagged MUST ${one ? 'is' : 'are'} left open: the overnight run does not wait for your answer. `
    + `${one ? 'It is' : 'They are'} written as (open) in .audit\\DECISIONS.md, ${one ? 'its' : 'their'} buttons stay live, `
    + `and the auditor's follow-up runs now to go on with an overnight item that does not depend on ${one ? 'it' : 'them'}.`);
}

// All questions have an answer: they go to DECISIONS.md, each marked "answered" or
// "assumed", and the auditor is asked again. Questions that an overnight run left open
// and /resume asked again (source 'open') replace their "(open)" entries instead, and
// the loop goes on where it was.
function finishQuestions(ctx, loop) {
  const questions = loop.questions;
  const total = questions.items.length;
  const place = M.label(loop, questions.round);
  if (questions.source === 'open') {
    for (const q of questions.items) resolveOpen(ctx, loop, q, q.answer.text, q.answer.how);
    loop.questions = null;
    dropLoopWait(ctx);
    logStep(ctx, loop, `${M.plural(total, 'open question')} answered after /resume: the (open) entries in DECISIONS.md are replaced; going on`);
    ctx.send(`${place}: ${M.plural(total, 'answer')} saved in .audit\\DECISIONS.md, in place of the (open) ${total === 1 ? 'entry' : 'entries'}. The loop goes on.`);
    return continueFrom(ctx, loop, questions.resumeNext || { how: 'none' });
  }
  const title = questions.source === 'goal-check' ? 'Goal check' : `Round ${questions.round}`;
  const written = appendDecisions(loop.project, {
    title,
    answers: questions.items.map((q) => ({ question: q.question, answer: q.answer.text, mark: q.answer.how === 'assumed' ? 'assumed' : 'answered' })),
    newerThan: questions.askedAt,
  });
  loop.decisions.push({ at: nowIso(ctx), title, items: questions.items.map((q) => ({ n: q.n, tag: q.tag, question: q.question, answer: q.answer.text, how: q.answer.how })) });
  // The same question, left open earlier by the overnight run and asked again now: it is answered too.
  for (const q of questions.items) {
    const twin = openQuestions(loop).find((open) => M.oneLine(open.question) === M.oneLine(q.question));
    if (twin) resolveOpen(ctx, loop, twin, q.answer.text, q.answer.how);
  }
  loop.questions = null;
  dropLoopWait(ctx);
  logStep(ctx, loop, `${M.plural(total, 'answer')} saved in ${path.basename(written.file)} under "${title}": asking the auditor again`);
  if (questions.source === 'goal-check') startGoalCheck(ctx, loop);
  else startAuditor(ctx, loop, 'followup');
  // One line: saved, asking the auditor again.
  return ctx.send(`${place}: ${M.plural(total, 'answer')} saved in .audit\\DECISIONS.md. Asking the auditor again`
    + `${questions.source === 'goal-check' ? ` (goal check ${loop.goalChecks})` : ''}.`);
}

// An open question gets its answer: the "(open)" entry in DECISIONS.md becomes the
// answer, and the loop's own records say so. Nothing is started.
function resolveOpen(ctx, loop, item, text, how) {
  const open = (loop.openQuestions || []).find((q) => q.buttonId === item.buttonId || (!q.answer && M.oneLine(q.question) === M.oneLine(item.question)));
  if (open) open.answer = { text, how, at: nowIso(ctx) };
  const result = answerOpenQuestion(loop.project, { question: item.question, answer: text });
  if (!result.replaced) {
    appendDecisions(loop.project, { title: `Round ${item.round || loop.round} (an open question, answered later)`, answers: [{ question: item.question, answer: text, mark: 'answered' }] });
  }
  for (const group of loop.decisions || []) {
    for (const d of group.items) {
      if (d.how === 'open' && M.oneLine(d.question) === M.oneLine(item.question)) {
        d.answer = text;
        d.how = how;
      }
    }
  }
  logStep(ctx, loop, `round ${item.round || loop.round}: open question ${item.n} answered (${how}): ${text}${result.replaced ? '' : ' (its (open) entry was not found in DECISIONS.md: the answer was added as a section)'}`);
}

// The owner answered a question the overnight run left open, while the loop goes on
// (or waits at other questions). No follow-up runs for it: the answer reaches the
// builder with the next round's input and the auditor with the next audit.
function answerOpen(ctx, loop, item, text, how) {
  resolveOpen(ctx, loop, item, text, how);
  ctx.send(`${M.label(loop, item.round)}: your answer to open question ${item.n} is saved: ${text}. It replaces the (open) entry in .audit\\DECISIONS.md, `
    + 'and reaches the builder with the next round and the auditor with the next audit.');
  // The same question, asked again by a follow-up and waiting now: it is answered too.
  const twin = loop.step === 'questions' && loop.questions ? loop.questions.items.find((q) => !q.answer && M.oneLine(q.question) === M.oneLine(item.question)) : null;
  if (twin) return recordAnswer(ctx, loop, twin, text, how);
  return saveLoop(ctx, loop);
}

// The first answer to a question counts. When all are answered, they go to
// DECISIONS.md and the auditor is asked again.
function recordAnswer(ctx, loop, item, text, how) {
  const questions = loop.questions;
  item.answer = { text, how, at: nowIso(ctx) };
  logStep(ctx, loop, `${questions.source === 'goal-check' ? 'goal check' : `round ${questions.round}`}: question ${item.n} answered (${how}): ${text}`);
  const total = questions.items.length;
  const open = questions.items.filter((other) => !other.answer).length;
  ctx.send(`${M.label(loop, questions.round)}: answer ${item.n} of ${total} saved: ${text}${open ? `\n${M.plural(open, 'question')} still open.` : ''}`);
  if (open) return saveLoop(ctx, loop);
  return finishQuestions(ctx, loop);
}

// Nobody answered a DEFAULT question in time: the recommended option is used and
// marked "assumed". MUST questions are never assumed: the round waits for them.
// atOnce (an overnight run): the DEFAULT questions are assumed as soon as they are asked.
function assumeDefaults(ctx, loop, items, { atOnce = false } = {}) {
  const questions = loop.questions;
  const place = M.label(loop, questions.round);
  const wait = loopWait(ctx);
  const within = `within ${ctx.settings.defaultAnswerMinutes} minutes`;
  for (const item of items) {
    item.answer = { text: item.recommended, how: 'assumed', at: nowIso(ctx) };
    if (wait && wait.kind === 'loop-other' && wait.buttonId === item.buttonId) ctx.setConversation(null);
    logStep(ctx, loop, `${questions.source === 'goal-check' ? 'goal check' : `round ${questions.round}`}: question ${item.n} [DEFAULT] `
      + `${atOnce ? 'is answered at once (overnight run)' : `had no answer ${within}`}: assumed the recommended option: ${item.recommended}`);
  }
  const open = questions.items.filter((item) => !item.answer);
  ctx.send([
    ...items.map((item) => (atOnce
      ? `${place}: question ${item.n} [DEFAULT] gets the recommended option at once (an overnight run does not wait for a DEFAULT answer): ${item.recommended}`
      : `${place}: no answer to question ${item.n} [DEFAULT] ${within}, so I used the recommended option: ${item.recommended}`)),
    'It is marked (assumed) in .audit\\DECISIONS.md. You can change it later.',
    ...(open.length && !atOnce ? [`${M.plural(open.length, 'question')} still open, tagged MUST: the loop waits for your answer.`] : []),
  ].join('\n'));
  if (open.length) return saveLoop(ctx, loop);
  return finishQuestions(ctx, loop);
}

function pressQuestion(query, ctx, [, , id, buttonId, choice]) {
  const loop = activeLoop(ctx);
  const found = loop && loop.id === id ? findQuestion(loop, buttonId) : null;
  if (!found || found.item.answer) return ctx.answerButton(query.id, EXPIRED);
  const { item, open } = found;
  const round = open ? item.round : loop.questions.round;
  if (choice === 'o') {
    const dropped = replaceWait(ctx, { kind: 'loop-other', loop: loop.id, buttonId, n: item.n, name: loop.name });
    ctx.answerButton(query.id, 'Type your answer');
    return ctx.send(`${dropped}${M.label(loop, round)}: ${open ? 'open ' : ''}question ${item.n}: type your answer as the next message.\n/cancel goes back to the buttons.`);
  }
  const option = item.options[Number(choice)];
  if (option === undefined) return ctx.answerButton(query.id, EXPIRED);
  const wait = loopWait(ctx);
  if (wait && wait.buttonId === buttonId) ctx.setConversation(null);
  ctx.answerButton(query.id, 'Saved');
  return open ? answerOpen(ctx, loop, item, option, 'button') : recordAnswer(ctx, loop, item, option, 'button');
}

// The text after "Other (type it)".
function otherInput(conversation, msg, ctx) {
  const loop = activeLoop(ctx);
  const found = loop && loop.id === conversation.loop ? findQuestion(loop, conversation.buttonId) : null;
  if (!found || found.item.answer) {
    ctx.setConversation(null);
    return ctx.send('That question is no longer open. Nothing was saved.');
  }
  const { item, open } = found;
  const place = `${M.label(loop, open ? item.round : loop.questions.round)}, ${open ? 'open ' : ''}question ${item.n}`;
  if (typeof msg.text !== 'string' || !msg.text.trim()) return ctx.send(`${place}: type the answer as a text message, or send /cancel to go back to the buttons.`);
  if (msg.text.length >= TEXT_MAX) return ctx.send(`${place}: that answer is too long for one message. Send a shorter one, or /cancel.`);
  ctx.setConversation(null);
  const text = ctx.redact(M.oneLine(msg.text));
  return open ? answerOpen(ctx, loop, item, text, 'typed') : recordAnswer(ctx, loop, item, text, 'typed');
}

// ---- the proposed prompt: Approve, Edit, Stop ----

function proposalText(loop) {
  const p = loop.proposal;
  return M.withNotes(p.notes, fs.readFileSync(path.join(loop.project, '.audit', p.baseFile), 'utf8'));
}

// The proposal as a file, then the three buttons.
function sendProposal(ctx, loop) {
  const p = loop.proposal;
  const files = M.proposalFiles(loop, p.round);
  ctx.sendFile(files.proposed, files.sentAs, `${loop.name}: the proposed prompt for round ${p.round}${p.edits ? `, after ${M.plural(p.edits, 'edit')}` : ''}`);
  sendProposalButtons(ctx, loop);
}

function sendProposalButtons(ctx, loop) {
  ctx.send(`${M.label(loop, loop.proposal.round)}: start the builder with this prompt?`, { replyMarkup: M.proposalKeyboard(loop) });
}

// Saves the auditor's next prompt as the proposal for round N+1.
function saveProposal(loop, verdict) {
  const next = loop.round + 1;
  const files = M.proposalFiles(loop, next);
  const text = verdict.next_prompt.endsWith('\n') ? verdict.next_prompt : `${verdict.next_prompt}\n`;
  writeFileAtomic(files.auditor, text);
  writeFileAtomic(files.proposed, text);
  return { next, files };
}

// The proposal for a round: file is the one that counts, in .audit\. baseFile is the
// prompt under the owner's notes. shownAt is on the bot's clock, for the reminders.
// For the PROMPT RECORD: ownerFile, the owner's own prompt came as a file;
// proposedAgain, the proposal came back with /resume.
function newProposal(ctx, round, files, base, source, { ownerFile = false } = {}) {
  return {
    round, buttonId: hex(3), file: path.basename(files.proposed), baseFile: path.basename(base), notes: [], edits: 0, source, fromFile: false,
    ownerFile, proposedAgain: false, shownAt: nowIso(ctx), remindedAt: null,
  };
}

function propose(ctx, loop, verdict) {
  const { next, files } = saveProposal(loop, verdict);
  setStep(ctx, loop, 'proposal');
  loop.job = null;
  loop.proposal = newProposal(ctx, next, files, files.auditor, 'auditor');
  saveLoop(ctx, loop);
  logStep(ctx, loop, `round ${loop.round}: the prompt for round ${next} is proposed (${path.basename(files.proposed)}): waiting for Approve, Edit or Stop`);
  ctx.send(M.roundMessage(loop, loop.round));
  sendProposal(ctx, loop);
}

// ---- the overnight run: the loop approves the prompt itself (Phase 7) ----

// Before every builder round of an overnight run: the 7-day window. At or above the
// limit the loop ends, resumable, and the round does not start. proposalFiles is null
// for round 1 (its prompt is the owner's own). Returns true when the loop ended.
function overnightSevenDayStop(ctx, loop, round, proposalFiles) {
  const limit = ctx.settings.overnightSevenDayPercent;
  const stop = O.sevenDayCheck(loop.usage || ctx.state.lastUsage, limit);
  if (!stop) return false;
  const reset = stop.resetsAt ? M.when(stop.resetsAt, ctx.now()) : 'at a time that is not known';
  const why = `Overnight: stopped before round ${round}: the 7-day window is at ${stop.percent}% (an overnight run stops at ${limit}%); it resets ${reset}.`;
  const lines = round > 1 ? [...M.warningLines(loop, round - 1), ...M.roundLines(loop, round - 1)] : [];
  let resume;
  if (proposalFiles) {
    lines.push(
      `The auditor's prompt for round ${round} follows as a file. It is saved as .audit\\${path.basename(proposalFiles.proposed)}; no round starts.`,
      `/resume ${loop.name} brings it back with Approve, Edit and Stop. /overnight ${loop.name} <rounds> continues in overnight mode once the window is below ${limit}%.`,
    );
    resume = { how: 'proposal', round };
  } else {
    lines.push(`No round starts. /resume ${loop.name} starts round 1 with your first prompt; /overnight ${loop.name} <rounds> starts the run again once the window is below ${limit}%.`);
    resume = { how: 'builder', round: 1 };
  }
  logStep(ctx, loop, `overnight: the 7-day window is at ${stop.percent}% (the limit is ${limit}%): round ${round} does not start`);
  endLoop(ctx, loop, why, lines, resume);
  if (proposalFiles) ctx.sendFile(proposalFiles.proposed, proposalFiles.sentAs, `${loop.name}: the auditor's prompt for a round ${round}. The loop has ended: nothing starts.`);
  return true;
}

// The auditor's next prompt in an overnight run: saved as a proposal, as in propose(),
// then approved by the loop at once. The round message and the prompt file are still
// sent, so that the owner can read later what each round got.
function overnightPropose(ctx, loop, verdict) {
  const { next, files } = saveProposal(loop, verdict);
  loop.job = null;
  logStep(ctx, loop, `round ${loop.round}: the prompt for round ${next} is proposed (${path.basename(files.proposed)}): the overnight run approves it itself`);
  ctx.send(M.roundMessage(loop, loop.round, { overnight: true }));
  if (overnightSevenDayStop(ctx, loop, next, files)) return;
  ctx.sendFile(files.proposed, files.sentAs, `${loop.name}: the prompt for round ${next}, approved by the overnight run`);
  loop.proposal = newProposal(ctx, next, files, files.auditor, 'auditor');
  approveByLoop(ctx, loop);
}

// Approves the proposal without the owner: the same files and the same record as
// approve(), plus the mark approvedBy: "overnight". Then the builder starts.
function approveByLoop(ctx, loop) {
  const p = loop.proposal;
  const files = M.proposalFiles(loop, p.round);
  const text = fs.readFileSync(files.proposed, 'utf8');
  writeFileAtomic(roundFile(loop.project, p.round, 'prompt.md'), text);
  dropLoopWait(ctx);
  loop.rounds[p.round] = {
    prompt: {
      approvedAt: nowIso(ctx), edits: p.edits, notes: p.notes.length, bytes: Buffer.byteLength(text, 'utf8'),
      noteTexts: p.notes.slice(), fromFile: p.fromFile === true, source: p.source || 'auditor',
      ownerFile: p.ownerFile === true, proposedAgain: p.proposedAgain === true, approvedBy: 'overnight',
    },
  };
  loop.proposal = null;
  logStep(ctx, loop, `round ${p.round}: prompt approved by the overnight run, without the owner's Approve, ${Buffer.byteLength(text, 'utf8')} bytes`);
  startBuilder(ctx, loop, p.round);
  return ctx.send(`${M.label(loop)}: approved by the overnight run, without your Approve. The builder started with .audit\\${path.basename(roundFile(loop.project, p.round, 'prompt.md'))}.`);
}

function approve(query, ctx, loop) {
  const p = loop.proposal;
  const files = M.proposalFiles(loop, p.round);
  const text = fs.readFileSync(files.proposed, 'utf8');
  writeFileAtomic(roundFile(loop.project, p.round, 'prompt.md'), text);
  dropLoopWait(ctx);
  loop.rounds[p.round] = {
    prompt: {
      approvedAt: nowIso(ctx), edits: p.edits, notes: p.notes.length, bytes: Buffer.byteLength(text, 'utf8'),
      noteTexts: p.notes.slice(), fromFile: p.fromFile === true, source: p.source || 'auditor',
      ownerFile: p.ownerFile === true, proposedAgain: p.proposedAgain === true,
    },
  };
  loop.proposal = null;
  logStep(ctx, loop, `round ${p.round}: prompt approved after ${M.plural(p.edits, 'edit')}, ${Buffer.byteLength(text, 'utf8')} bytes`);
  // Approve on a prompt past the cap is the owner's word to go on: the cap moves with it.
  const raised = p.round > loop.cap;
  if (raised) {
    logStep(ctx, loop, `the round cap is raised from ${loop.cap} to ${p.round}, by your Approve`);
    loop.cap = p.round;
  }
  startBuilder(ctx, loop, p.round);
  ctx.answerButton(query.id, 'Approved');
  return ctx.send(`${M.label(loop)}: approved. The builder started with .audit\\${path.basename(roundFile(loop.project, p.round, 'prompt.md'))}.`
    + `${raised ? `\nThe round cap is now ${loop.cap}.` : ''}`);
}

function pressProposal(query, ctx, [, , id, buttonId, action]) {
  const loop = activeLoop(ctx);
  const live = loop && loop.id === id && loop.step === 'proposal' && loop.proposal.buttonId === buttonId;
  // Buttons on an old proposal expire: every edit gives the proposal new ones.
  if (!live) return ctx.answerButton(query.id, EXPIRED);
  const p = loop.proposal;
  if (action === 'a') return approve(query, ctx, loop);
  if (action === 'e') {
    const dropped = replaceWait(ctx, { kind: 'loop-edit', loop: loop.id, buttonId, round: p.round, name: loop.name });
    ctx.answerButton(query.id, 'Send your note or file');
    return ctx.send(`${dropped}${M.label(loop, p.round)}: edit the prompt. ${EDIT_HOW}\n/cancel keeps the prompt as it is.`);
  }
  ctx.answerButton(query.id, 'Stopped');
  return endLoop(ctx, loop, `Stopped by you at the prompt for round ${p.round}.`,
    [`The proposed prompt stays in .audit\\${path.basename(M.proposalFiles(loop, p.round).proposed)}.`], { how: 'proposal', round: p.round });
}

// The note or the file after Edit. A note is added on top of the prompt, and notes
// stack up. A file replaces the whole prompt, the notes included.
async function editInput(conversation, msg, ctx) {
  const loop = activeLoop(ctx);
  const live = loop && loop.id === conversation.loop && loop.step === 'proposal' && loop.proposal.buttonId === conversation.buttonId;
  if (!live) {
    ctx.setConversation(null);
    return ctx.send('That prompt is no longer waiting for an edit. Nothing was changed.');
  }
  const input = await readInput(msg, ctx);
  if (input.problem) return ctx.send(`${M.label(loop, loop.proposal.round)}: ${input.problem}\n${EDIT_HOW}\nOr send /cancel.`);

  const p = loop.proposal;
  const files = M.proposalFiles(loop, p.round);
  p.edits += 1;
  const editFile = files.edit(p.edits);
  let said;
  if (input.fromFile) {
    p.notes = [];
    p.fromFile = true;
    p.baseFile = path.basename(editFile);
    const text = input.text.endsWith('\n') ? input.text : `${input.text}\n`;
    writeFileAtomic(editFile, text);
    said = `the prompt was replaced by your file (${Buffer.byteLength(text, 'utf8')} bytes).`;
    if (!/HANDOFF\.md/i.test(text)) said += '\nNote: your file does not ask for HANDOFF.md. The fixed preface in front of every prompt still does.';
  } else {
    p.notes.push(input.text.trim());
    writeFileAtomic(editFile, proposalText(loop));
    said = `your note was added at the top of the prompt (${M.plural(p.notes.length, 'note')} now).`;
  }
  // Each edit is kept as round-NN-prompt-edit-K.md; round-NN-prompt-proposed.md is the one that counts.
  writeFileAtomic(files.proposed, proposalText(loop));
  p.buttonId = hex(3);
  p.shownAt = nowIso(ctx);
  p.remindedAt = null;
  ctx.setConversation(null);
  saveLoop(ctx, loop);
  logStep(ctx, loop, `round ${p.round}: prompt edit ${p.edits}: ${input.fromFile ? 'replaced by a file' : `note added: ${M.oneLine(input.text).slice(0, 200)}`} (${path.basename(editFile)})`);
  ctx.send(`${M.label(loop, p.round)}: ${said}`);
  return sendProposal(ctx, loop);
}

// /cancel while the bot waits for an Edit, a typed answer or a prompt: the wait is
// dropped, nothing changes, and the buttons are shown again.
function cancelWait(conversation, ctx) {
  ctx.setConversation(null);
  const loop = activeLoop(ctx);
  if (conversation.kind === 'loop-prompt') {
    const live = loop && loop.id === conversation.loop && loop.step === 'prompt-wait';
    if (!live) return ctx.send('Cancelled.');
    return endLoop(ctx, loop, `No prompt for round ${loop.promptWait.round} was sent (/cancel), so the loop ended again. Nothing changed.`, [],
      { how: 'new-prompt', round: loop.promptWait.round });
  }
  if (conversation.kind === 'loop-edit') {
    const live = loop && loop.id === conversation.loop && loop.step === 'proposal' && loop.proposal.buttonId === conversation.buttonId;
    if (!live) return ctx.send('Cancelled.');
    ctx.send(`${M.label(loop, loop.proposal.round)}: the edit was cancelled. The prompt is as it was.`);
    return sendProposalButtons(ctx, loop);
  }
  const found = loop && loop.id === conversation.loop ? findQuestion(loop, conversation.buttonId) : null;
  if (!found || found.item.answer) return ctx.send('Cancelled.');
  const { item, open } = found;
  ctx.send(`${M.label(loop, open ? item.round : loop.questions.round)}: no answer was typed. ${open ? 'Open question' : 'Question'} ${item.n} is still open:`);
  return sendQuestion(ctx, loop, item, found);
}

// ---- the usage limit: a pause that ends by itself ----

// The plan's usage limit ended a step. The loop pauses, and goes on by itself two
// minutes after the limit resets: `next` says how (as end.resume does for /resume).
function pauseForLimit(ctx, loop, { step, limit, next }) {
  const nowMs = ctx.now();
  const resetMs = limit && limit.resets_at ? Date.parse(limit.resets_at) : NaN;
  const known = !Number.isNaN(resetMs);
  loop.limitHits = (loop.limitHits || 0) + 1;
  // A reset time that is not known, or one that has passed and did not help: wait a
  // fixed time instead, so that the loop cannot hammer on a limit.
  const fallback = !known || (resetMs <= nowMs && loop.limitHits > 1);
  const resumeMs = fallback ? nowMs + ctx.settings.usageLimitFallbackMinutes * 60000 : Math.max(resetMs, nowMs) + AFTER_RESET_MS;
  const words = M.jobWords(step);
  // An overnight run does not wait out a long pause: the 7-day limit, or a reset time
  // more than overnightLongPauseHours away. It ends instead, resumable.
  if (O.isOvernight(loop)) {
    const hours = ctx.settings.overnightLongPauseHours;
    const type = (limit && (limit.limit || (limit.rate_limit && limit.rate_limit.type))) || null;
    const long = O.longPause({ type, resetMs: known ? resetMs : NaN, nowMs, hours });
    if (long) {
      const message = M.oneLine(limit && limit.message).slice(0, 300);
      logStep(ctx, loop, `${where(loop)}the ${words} hit the plan's usage limit (${message || 'no text'}): ${long === 'seven_day' ? 'it is the 7-day limit' : `it resets at ${localStamp(new Date(resetMs))}`}, `
        + `longer than the ${hours} hours an overnight run waits: the loop ends instead`);
      return endLoop(ctx, loop, `Overnight: the ${words}${ofRound(loop)} hit the plan's usage limit${message ? ` ("${message}")` : ''}, and the pause would last longer than ${hours} hours `
        + `(${long === 'seven_day' ? 'it is the 7-day limit' : 'the reset time is far off'}${known ? `; it resets ${M.when(resetMs, nowMs)}` : ''}). The run ends instead of waiting.`,
      [`/resume ${loop.name} continues it after the reset, in normal mode: the ${words} runs again.`], next);
    }
  }
  setStep(ctx, loop, 'paused');
  loop.job = null;
  loop.pause = {
    kind: 'usage-limit', step, round: loop.round, hitAt: nowIso(ctx), resetsAt: known ? new Date(resetMs).toISOString() : null,
    resumeAt: new Date(resumeMs).toISOString(), message: M.oneLine(limit && limit.message).slice(0, 300), next,
  };
  saveLoop(ctx, loop);
  logStep(ctx, loop, `${where(loop)}the ${words} hit the plan's usage limit (${loop.pause.message || 'no text'}): `
    + `paused, resets ${known ? `at ${localStamp(new Date(resetMs))}` : 'at an unknown time'}, going on at ${localStamp(new Date(resumeMs))}`);
  return ctx.send(pauseText(ctx, loop));
}

function pauseText(ctx, loop) {
  const pause = loop.pause;
  const nowMs = ctx.now();
  const words = M.jobWords(pause.step);
  const reset = pause.resetsAt
    ? `The limit resets at ${M.when(pause.resetsAt, nowMs)} (this PC's time).`
    : `When the limit resets is not known, so I try again in ${ctx.settings.usageLimitFallbackMinutes} minutes.`;
  return [
    `${M.label(loop)}: paused. The ${words} hit the plan's usage limit${pause.message ? ` ("${pause.message}")` : ''}.`,
    `${reset} The loop goes on by itself at ${M.when(pause.resumeAt, nowMs)}: the ${words} runs again.`,
    `/resume ${loop.name} goes on at once (and may hit the limit again). /stop ends the loop.`,
  ].join('\n');
}

// The pause is over: by the clock, or by /resume.
function endPause(ctx, loop, byOwner) {
  const pause = loop.pause;
  loop.pause = null;
  logStep(ctx, loop, `${where(loop)}the pause is over (${byOwner ? '/resume' : 'the limit\'s reset time has passed'}): the ${M.jobWords(pause.step)} runs again`);
  ctx.send(`${M.label(loop)}: ${byOwner ? 'going on now, as you asked' : 'the usage limit has reset, so the loop goes on by itself'}. The ${M.jobWords(pause.step)} runs again.`);
  return continueFrom(ctx, loop, pause.next);
}

// ---- a builder that was cut off: Redo the round, Keep and audit, Stop ----

// Says in the builder's summary that its round was cut off. run_auditor.js reads it.
function markSummary(loop, round, change) {
  const file = roundFile(loop.project, round, 'builder.json');
  const summary = readJsonSafe(file, { repair: true }).value || { round, project: loop.project, status: 'running' };
  change(summary);
  writeJsonAtomic(file, summary, { backup: true });
  return summary;
}

// Moves a round's builder records to round-NN-builder-attempt-K.*, so that the
// round can run again. Returns K, or 0 when there was nothing to move.
function moveBuilderRecords(loop, round) {
  const name = (suffix) => roundFile(loop.project, round, suffix);
  if (!BUILDER_RECORDS.some(([from]) => fs.existsSync(name(from)))) return 0;
  let attempt = 1;
  while (BUILDER_RECORDS.some(([, to]) => fs.existsSync(name(`builder-attempt-${attempt}${to}`)))) attempt += 1;
  for (const [from, to] of BUILDER_RECORDS) {
    if (fs.existsSync(name(from))) fs.renameSync(name(from), name(`builder-attempt-${attempt}${to}`));
  }
  return attempt;
}

// What is known of a builder that did not end by itself, from its summary: for the
// report, and for the round's numbers when its work is kept.
function cutOffInfo(loop, round) {
  const summary = readJsonSafe(roundFile(loop.project, round, 'builder.json')).value;
  if (!summary) return null;
  return M.builderInfo({ ...summary, status: summary.status === 'running' ? 'cut_off' : summary.status }, { stdout: '', exit_code: null });
}

// One message: what the round left, and the three buttons.
function askCutOff(ctx, loop, { round, reason, intro = [] }) {
  loop.round = round;
  setStep(ctx, loop, 'choice');
  loop.job = null;
  const info = cutOffInfo(loop, round);
  if (info) loop.rounds[round] = { ...(loop.rounds[round] || {}), builder: info };
  loop.choice = { round, reason, buttonId: hex(3), askedAt: nowIso(ctx), remindedAt: null };
  saveLoop(ctx, loop);
  logStep(ctx, loop, `round ${round}: the builder was cut off (${reason}): waiting for Redo the round, Keep and audit or Stop`);
  return ctx.send(M.cutOffText(loop, loop.choice, statusShort(loop.project, 20, gitOptions(ctx)), intro), { replyMarkup: M.choiceKeyboard(loop) });
}

// Runs a round's builder again with the same prompt. The partial work is put aside
// with git stash, and the old records are kept as attempt K. Returns a line for the
// owner, or { error }.
function redoRound(ctx, loop, round) {
  const stash = stashRound(loop.project, round, gitOptions(ctx));
  if (stash.error) return { error: stash.error };
  const data = loop.rounds[round] || {};
  loop.rounds[round] = data;
  const summary = readJsonSafe(roundFile(loop.project, round, 'builder.json')).value;
  const attempt = moveBuilderRecords(loop, round);
  if (attempt) {
    data.attempts = [...(data.attempts || []), {
      attempt, status: summary ? summary.status : 'unknown', cost_usd: summary && Number.isFinite(summary.cost_usd) ? summary.cost_usd : null,
      stash: stash.stashed ? stash.message : null,
    }];
  }
  delete data.builder;
  delete data.commit;
  delete data.warning;
  logStep(ctx, loop, `round ${round}: redo. ${stash.stashed ? `The partial work was put aside with git stash ("${stash.message}")` : 'Nothing to put aside: the working tree was clean'}`
    + `${attempt ? `; the old builder records are round-${M.pad(round)}-builder-attempt-${attempt}.*` : ''}`);
  startBuilder(ctx, loop, round);
  return {
    said: [
      stash.stashed
        ? `The partial work was put aside, not deleted: "git stash list" shows it as "${stash.message}", and "git stash pop" brings it back.`
        : 'There was nothing to put aside: the working tree was clean.',
      ...(attempt ? [`The old builder records are kept as .audit\\round-${M.pad(round)}-builder-attempt-${attempt}.*`] : []),
    ].join('\n'),
  };
}

// The lines for a commit that was refused because of what it would have taken along.
function refusedCommitLines(commit) {
  const named = commit.secrets || [];
  const holding = commit.holders || [];
  const list = (files) => [...files.slice(0, 20).map((file) => `- ${file}`), ...(files.length > 20 ? [`and ${files.length - 20} more`] : [])];
  return [
    ...list(named),
    ...(holding.length ? [...(named.length ? ['These files hold a value that is saved in the project\'s .env:'] : []), ...list(holding)] : []),
    commit.unstaged
      ? 'Nothing was committed, and everything was unstaged. The round\'s files are still in the folder.'
      : 'Nothing was committed. Unstaging failed: run "git reset" in the folder.',
    named.length
      ? `Remove those files or add them to .gitignore.${holding.length ? ' Take the value out of the other files: a key belongs in .env only.' : ''} The round was not audited.`
      : 'Take the value out of those files: a key belongs in .env only. The round was not audited.',
  ];
}

const refusedCommitWhy = (commit, round) => ((commit.secrets || []).length
  ? `Round ${round} was NOT committed: these paths look like secrets.`
  : `Round ${round} was NOT committed: these files hold a value that is saved in the project's .env.`);

function pressChoice(query, ctx, [, , id, buttonId, action]) {
  const loop = activeLoop(ctx);
  const live = loop && loop.id === id && loop.step === 'choice' && loop.choice.buttonId === buttonId;
  if (!live) return ctx.answerButton(query.id, EXPIRED);
  const { round, reason } = loop.choice;
  const place = M.label(loop, round);

  if (action === 's') {
    ctx.answerButton(query.id, 'Stopped');
    return endLoop(ctx, loop, `Stopped by you, after the builder of round ${round} was cut off.`,
      ['Nothing was changed: what the round left is still in the folder, uncommitted.'], { how: 'choice', round, reason });
  }
  if (action === 'r') {
    const redo = redoRound(ctx, loop, round);
    if (redo.error) {
      ctx.answerButton(query.id, 'Not done');
      return ctx.send(`${place}: the round was not started again: ${redo.error}\nNothing was changed. The buttons still work.`);
    }
    loop.choice = null;
    saveLoop(ctx, loop);
    ctx.answerButton(query.id, 'Redo');
    return ctx.send(`${place}: the round runs again with the same prompt (.audit\\${path.basename(roundFile(loop.project, round, 'prompt.md'))}).\n${redo.said}`);
  }

  // Keep and audit. A round that ran to its end and was only not committed keeps its
  // own name; one that was cut off is marked as such, for the commit and for the auditor.
  const before = readJsonSafe(roundFile(loop.project, round, 'builder.json')).value;
  const whole = Boolean(before && ['completed', 'max_turns'].includes(before.status) && before.handoff_written);
  const commit = commitRound(loop.project, round, { ...gitOptions(ctx), ...(whole ? {} : { message: `Loop: round ${round} (cut off)` }) });
  if (commit.secrets || commit.holders) {
    logStep(ctx, loop, `round ${round}: keep and audit: NOT committed: ${[...(commit.secrets || []), ...(commit.holders || [])].join(', ')}`);
    ctx.answerButton(query.id, 'Not committed');
    return ctx.send([`${place}: ${refusedCommitWhy(commit, round)}`, ...refusedCommitLines(commit).slice(0, -1), 'Fix that, then press a button again: they still work.'].join('\n'));
  }
  if (commit.error) {
    ctx.answerButton(query.id, 'Not committed');
    return ctx.send(`${place}: the round could not be committed: ${commit.error}\nNothing was changed. The buttons still work.`);
  }
  if (!commit.committed) {
    ctx.answerButton(query.id, 'Nothing to keep');
    return ctx.send(`${place}: there is nothing to keep: the round changed no file that git tracks. Redo the round, or Stop.`);
  }
  const summary = whole ? before : markSummary(loop, round, (s) => {
    if (s.status === 'running') s.status = 'cut_off';
    s.cut_off = { reason, kept_at: nowIso(ctx) };
  });
  const data = loop.rounds[round] || {};
  loop.rounds[round] = data;
  data.builder = M.builderInfo(summary, { stdout: '', exit_code: null });
  data.commit = commit.commit;
  data.cutOff = whole ? null : reason;
  data.warning = M.contextWarning(data.builder, ctx.settings.contextWarnPercent);
  loop.choice = null;
  logStep(ctx, loop, `round ${round}: keep and audit: committed ${commit.commit} "${whole ? `Loop: round ${round}` : `Loop: round ${round} (cut off)`}"`);
  startAuditor(ctx, loop, 'auditor');
  ctx.answerButton(query.id, 'Kept');
  return ctx.send(`${place}: kept. Committed as ${commit.commit}${whole ? '' : ` "Loop: round ${round} (cut off)"`}. The auditor is checking the round`
    + `${whole ? '.' : ': it is told that the builder was cut off and that HANDOFF.md may be old or missing.'}`);
}

// ---- /abort: ends the running step at once ----

function abortLoop(ctx) {
  const loop = activeLoop(ctx);
  if (!loop) return ctx.send('No loop is running.');
  if (!loop.job) return ctx.send(`${M.label(loop)}: no step is running (${standing(loop)}). /abort only ends a running step; /stop ends the loop.`);
  const words = M.jobWords(loop.job.kind);
  loop.abort = { buttonId: hex(3), jobId: loop.job.id, askedAt: nowIso(ctx) };
  saveLoop(ctx, loop);
  return ctx.send([
    `${M.label(loop)}: end the ${words} at once?`,
    `Its processes are killed, nothing is committed, and the loop ends as aborted. The files stay as they are. /resume ${loop.name} continues from there.`,
    'These buttons expire in 2 minutes.',
  ].join('\n'), { replyMarkup: M.abortKeyboard(loop) });
}

// How /resume goes on after a step that did not end: see continueFrom().
function resumeOfJob(loop, kind, reason) {
  if (kind === 'builder') return { how: 'choice', round: loop.round, reason };
  if (kind === 'goal-check') return { how: 'goal-check' };
  return { how: 'auditor', round: loop.round, step: kind };
}

function pressAbort(query, ctx, [, , id, buttonId, action]) {
  const loop = activeLoop(ctx);
  const live = loop && loop.id === id && loop.abort && loop.abort.buttonId === buttonId && loop.job && loop.job.id === loop.abort.jobId
    && ctx.now() - Date.parse(loop.abort.askedAt) <= ABORT_BUTTON_MS;
  if (!live) return ctx.answerButton(query.id, EXPIRED);
  const job = loop.job;
  const words = M.jobWords(job.kind);
  loop.abort = null;
  if (action === 'n') {
    saveLoop(ctx, loop);
    ctx.answerButton(query.id, 'Cancelled');
    return ctx.send(`${M.label(loop)}: not aborted. The ${words} runs on.`);
  }

  const record = readJsonSafe(job.recordFile).value;
  if (record && record.status !== 'running') {
    saveLoop(ctx, loop);
    ctx.answerButton(query.id, 'It has just ended');
    return ctx.send(`${M.label(loop)}: the ${words} ended by itself just now, so nothing was aborted.`);
  }
  // The job's own record names its processes, each with the time it started. One is
  // only ended while it is still that process: see lib/process_tree.js.
  const targets = [];
  if (record) {
    targets.push({ pid: record.runner_pid, startedAt: record.started_at, what: 'the job\'s runner' });
    if (record.child_pid) targets.push({ pid: record.child_pid, startedAt: record.child_started_at, what: job.kind === 'builder' ? 'run_builder.js' : 'run_auditor.js' });
  }
  const summary = job.kind === 'builder' ? readJsonSafe(job.summaryFile).value : null;
  if (summary && summary.claude_pid) targets.push({ pid: summary.claude_pid, startedAt: summary.claude_started_at, what: 'claude' });
  if (!targets.length) {
    saveLoop(ctx, loop);
    ctx.answerButton(query.id, 'Not yet');
    return ctx.send(`${M.label(loop)}: the ${words} is only just starting and has not written down its process yet. Send /abort again in a few seconds.`);
  }
  const result = killJobProcesses(targets);
  if (!result.killed.length && (result.error || result.skipped.some((item) => /another process|could not/.test(item.why)))) {
    saveLoop(ctx, loop);
    ctx.answerButton(query.id, 'Not aborted');
    return ctx.send([
      `${M.label(loop)}: the ${words} was NOT ended.`,
      ...(result.error ? [result.error] : []),
      ...result.skipped.map((item) => `- ${item.what} (PID ${item.pid}): ${item.why}`),
      'Nothing was changed. The loop goes on watching the step.',
    ].join('\n'));
  }
  const what = [
    ...result.killed.map((item) => `${item.what} (PID ${item.pid}) with the processes it started`),
    ...result.skipped.filter((item) => /another process|could not/.test(item.why)).map((item) => `not ${item.what} (PID ${item.pid}): ${item.why}`),
  ];
  // The runner is gone, so the record and the summary would say "running" for ever.
  const at = nowIso(ctx);
  if (record) {
    try {
      writeJsonAtomic(job.recordFile, { ...record, status: 'aborted', finished_at: at }, { backup: true });
    } catch (err) {
      ctx.log(`loop ${loop.name}: could not mark job ${job.id} as aborted: ${err.message}`);
    }
  }
  if (job.kind === 'builder' && summary) {
    markSummary(loop, loop.round, (s) => {
      s.status = 'aborted';
      s.finished_at = at;
      s.error = 'cut off by the owner with /abort';
    });
    loop.rounds[loop.round] = { ...(loop.rounds[loop.round] || {}), builder: cutOffInfo(loop, loop.round) };
  }
  if (job.kind === 'goal-check') loop.goalChecks -= 1;
  logStep(ctx, loop, `/abort: the ${words} (job ${job.id}) was ended at once: ${what.join('; ') || 'its processes had ended already'}`);
  ctx.answerButton(query.id, 'Aborted');
  return endLoop(ctx, loop, `Aborted by you: the ${words}${ofRound(loop)} was ended at once.`, [
    `Ended: ${what.join('; ') || 'nothing: its processes had ended already'}.`,
    job.kind === 'builder'
      ? 'Nothing was committed: what the builder had changed is still in the folder, for you to look at.'
      : 'Nothing was decided, and nothing was committed.',
    `/resume ${loop.name} continues from there.`,
  ], resumeOfJob(loop, job.kind, 'aborted'));
}

// ---- what a tick does when a job has ended ----

function afterGoalCheck(ctx, loop, record) {
  const outcome = auditOutcome(record);
  if (outcome.limit) {
    loop.goalChecks -= 1; // it left no record: the next one has the same number
    noteUsage(ctx, loop, outcome.limit.rate_limit);
    return pauseForLimit(ctx, loop, { step: 'goal-check', limit: outcome.limit, next: { how: 'goal-check' } });
  }
  if (outcome.error) {
    logStep(ctx, loop, `goal check ${loop.goalChecks} failed: ${outcome.error}`);
    const logFile = loop.job.logFile;
    loop.goalChecks -= 1;
    return endLoop(ctx, loop, 'The goal check failed, so no builder started.', [`Error: ${outcome.error}`, `Its log: ${logFile}`], { how: 'goal-check' });
  }
  const verdict = outcome.verdict;
  loop.lastVerdict = verdict;
  loop.limitHits = 0;
  loop.lostRuns = 0;
  const usage = verdict.usage || {};
  noteUsage(ctx, loop, usage.rate_limit);
  loop.goalCheckRuns = [...(loop.goalCheckRuns || []), { n: loop.goalChecks, verdict: verdict.verdict, cost_usd: Number.isFinite(usage.cost_usd) ? usage.cost_usd : null }];
  logStep(ctx, loop, `goal check ${loop.goalChecks}: ${verdict.verdict}: ${M.oneLine(verdict.reason)}`);
  if (verdict.verdict === 'STOP_FOR_HUMAN') {
    return endLoop(ctx, loop, 'The goal check says STOP_FOR_HUMAN: no builder started.',
      [...M.verdictLines(verdict), `What you need to do: ${verdict.next_prompt}`], { how: 'goal-check' });
  }
  if (loop.stopping) {
    return endLoop(ctx, loop, `Stopped by /stop after the goal check (its verdict: ${verdict.verdict}). No builder started.`,
      verdict.verdict === 'ASK_HUMAN' ? [`The auditor had ${M.plural(verdict.questions.length, 'question')}: see goal-check-${M.pad(loop.goalChecks)}-verdict.json.`] : [],
      verdict.verdict === 'CONTINUE' ? { how: 'builder', round: 1 } : (verdict.verdict === 'ASK_HUMAN' ? { how: 'ask' } : { how: 'goal-check' }));
  }
  if (verdict.verdict === 'ASK_HUMAN') {
    return askQuestions(ctx, loop, verdict, [
      `${M.label(loop, 0)}: the auditor has ${M.plural(verdict.questions.length, 'question')} before the builder can start.`,
      `Reason: ${M.oneLine(verdict.reason)}`,
    ]);
  }
  if (verdict.verdict !== 'CONTINUE') return endLoop(ctx, loop, `The goal check gave a verdict it cannot give: ${verdict.verdict}.`, [], { how: 'goal-check' });
  // Round 1 needs no Approve: its prompt is the owner's own, from /new.
  if (O.isOvernight(loop) && overnightSevenDayStop(ctx, loop, 1, null)) return undefined;
  startBuilder(ctx, loop, 1);
  return ctx.send(`${M.label(loop)}: GOAL.md is clear. The builder started with your first prompt (.audit\\round-01-prompt.md).`);
}

function afterBuilder(ctx, loop, record) {
  const round = loop.round;
  // Exit code 2: run_builder.js refused to run (bad input, or this round's records
  // exist already). No builder worked, so nothing is committed and nothing is audited.
  if (record.exit_code === 2) {
    const refused = M.builderInfo(null, record);
    logStep(ctx, loop, `round ${round}: the builder did not run: ${refused.error}`);
    return endLoop(ctx, loop, `Round ${round}: the builder did not run.`,
      [`Error: ${String(refused.error).slice(0, 500)}`, 'Nothing was committed.', `Its log: ${loop.job.logFile}`], { how: 'choice', round, reason: 'refused' });
  }
  const summary = readJsonSafe(loop.job.summaryFile, { repair: true }).value;
  const info = M.builderInfo(summary, record);
  const data = { ...(loop.rounds[round] || {}), builder: info, commit: null };
  loop.rounds[round] = data;
  data.warning = M.contextWarning(info, ctx.settings.contextWarnPercent);
  noteUsage(ctx, loop, summary && summary.rate_limit);
  logStep(ctx, loop, `round ${round}: builder ended: ${info.status}, ${info.turns ?? 'unknown'} turns, `
    + `${info.cost_usd === null ? 'cost unknown' : `$${info.cost_usd.toFixed(4)}`}, HANDOFF.md ${info.handoff_written ? 'written' : 'NOT written'}`);

  // The plan's usage limit stopped the builder in the middle of its round.
  if (info.status === 'usage_limit') {
    const limit = (summary && summary.usage_limit) || { resets_at: (summary && summary.resets_at) || null, message: info.error };
    const tree = treeProblem(loop.project, gitOptions(ctx));
    if (!tree) {
      // It changed nothing: the round simply runs again when the limit has reset.
      return pauseForLimit(ctx, loop, { step: 'builder', limit, next: { how: 'builder-rerun', round } });
    }
    loop.limitHits = 0;
    return askCutOff(ctx, loop, {
      round,
      reason: 'usage-limit',
      intro: [`${M.label(loop)}: the builder hit the plan's usage limit${limit.resets_at ? `. It resets at ${M.when(limit.resets_at, ctx.now())} (this PC's time)` : ', and when it resets is not known'}. `
        + 'A choice you make before then can hit the limit again.'],
    });
  }
  loop.limitHits = 0;
  const numbers = [M.builderLine(info), ...M.sessionLines(loop, info)];

  // The loop commits, after every builder round and before the auditor runs.
  const commit = commitRound(loop.project, round, gitOptions(ctx));
  if (commit.secrets || commit.holders) {
    logStep(ctx, loop, (commit.secrets || []).length
      ? `round ${round}: NOT committed, staged paths look like secrets: ${commit.secrets.join(', ')}`
      : `round ${round}: NOT committed, staged files hold a value of the project's .env: ${commit.holders.join(', ')}`);
    return endLoop(ctx, loop, refusedCommitWhy(commit, round), [...refusedCommitLines(commit), ...numbers], { how: 'choice', round, reason: 'not-committed' });
  }
  if (commit.error) {
    logStep(ctx, loop, `round ${round}: commit failed: ${commit.error}`);
    return endLoop(ctx, loop, `Round ${round} could not be committed.`,
      [commit.error, 'The round\'s changes are still in the folder. The round was not audited.', ...numbers], { how: 'choice', round, reason: 'not-committed' });
  }
  data.commit = commit.committed ? commit.commit : null;
  logStep(ctx, loop, commit.committed ? `round ${round}: committed ${commit.commit} "Loop: round ${round}"` : `round ${round}: nothing to commit`);
  numbers.push(M.commitLine(data, round));

  // A round without an audit: the owner's own prompt for the next round is the way on.
  const nextPrompt = { how: 'new-prompt', round: round + 1 };
  const failed = !['completed', 'max_turns'].includes(info.status);
  if (failed) {
    return endLoop(ctx, loop, `Round ${round}: the builder failed, so there is no audit.`, [
      `Error: ${String(info.error).slice(0, 500)}`,
      ...numbers,
      ...(commit.committed ? ['What the builder had changed is committed, and not audited.'] : []),
    ], nextPrompt);
  }
  if (!info.handoff_written) {
    return endLoop(ctx, loop, `Round ${round}: no new handoff, no audit.`,
      ['The builder ended without writing or changing HANDOFF.md.', ...numbers], nextPrompt);
  }
  if (!commit.committed) {
    return endLoop(ctx, loop, `Round ${round}: the builder wrote HANDOFF.md, but git found nothing to commit, so there is nothing to audit.`,
      ['Is HANDOFF.md ignored by the project\'s .gitignore?', ...numbers], nextPrompt);
  }
  if (loop.stopping) {
    return endLoop(ctx, loop, `Stopped by /stop after the builder of round ${round}: the round is committed, not audited.`, numbers, { how: 'auditor', round, step: 'auditor' });
  }
  startAuditor(ctx, loop, 'auditor');
  return ctx.send(`${M.label(loop)}: the builder ended (${M.builderLine(info).replace(/^Builder: /, '')}). `
    + `Committed as ${commit.commit}. The auditor is checking the round.`);
}

function afterAudit(ctx, loop, record) {
  const round = loop.round;
  const step = loop.step;
  const outcome = auditOutcome(record);
  if (outcome.limit) {
    noteUsage(ctx, loop, outcome.limit.rate_limit);
    return pauseForLimit(ctx, loop, { step, limit: outcome.limit, next: { how: 'auditor', round, step } });
  }
  if (outcome.error) {
    logStep(ctx, loop, `round ${round}: the auditor failed: ${outcome.error}`);
    return endLoop(ctx, loop, `Round ${round}: the auditor failed, so the round has no verdict.`, [
      `Error: ${outcome.error}`,
      `Its log: ${loop.job.logFile}`,
      ...M.roundLines(loop, round),
      `The round is committed. To audit it by hand: node scripts\\run_auditor.js --project ${loop.project} --round ${round}`,
    ], { how: 'auditor', round, step });
  }
  const verdict = outcome.verdict;
  const data = loop.rounds[round] || {};
  loop.rounds[round] = data;
  const usage = verdict.usage || {};
  noteUsage(ctx, loop, usage.rate_limit);
  if (Number.isFinite(usage.cost_usd)) data.auditCost = (data.auditCost || 0) + usage.cost_usd;
  loop.limitHits = 0;
  loop.lostRuns = 0;
  return applyVerdict(ctx, loop, verdict);
}

// What a round's verdict leads to. Also used by /resume for a verdict that was
// saved and never acted on.
function applyVerdict(ctx, loop, verdict) {
  const round = loop.round;
  const data = loop.rounds[round] || {};
  loop.rounds[round] = data;
  data.verdict = verdict;
  loop.lastVerdict = verdict;
  // The next round's audit starts where this one ended.
  if (typeof verdict.head === 'string' && verdict.head) loop.auditedHead = verdict.head;
  logStep(ctx, loop, `round ${round}: ${verdict.kind === 'followup' ? 'follow-up ' : ''}verdict ${verdict.verdict}: ${M.oneLine(verdict.reason)}`);

  if (verdict.verdict === 'DONE') {
    if (O.isOvernight(loop)) {
      // Every item of "## Overnight" is done: the rest of GOAL.md is the owner's.
      return endLoop(ctx, loop, `Overnight: every item of ## Overnight is done after round ${round} of ${loop.cap}.`, [
        ...M.warningLines(loop, round), ...M.roundLines(loop, round), `Summary: ${verdict.next_prompt}`,
        `The rest of GOAL.md waits for your review: /resume ${loop.name} asks you for the next round's prompt.`,
      ], { how: 'new-prompt', round: round + 1 });
    }
    return endLoop(ctx, loop, `DONE after round ${round} of ${loop.cap}.`, [...M.warningLines(loop, round), ...M.roundLines(loop, round), `Summary: ${verdict.next_prompt}`]);
  }
  if (verdict.verdict === 'STOP_FOR_HUMAN') {
    return endLoop(ctx, loop, `The auditor says STOP_FOR_HUMAN after round ${round} of ${loop.cap}.`,
      [...M.warningLines(loop, round), ...M.roundLines(loop, round), `What you need to do: ${verdict.next_prompt}`], { how: 'new-prompt', round: round + 1 });
  }
  if (loop.stopping) {
    const lines = M.roundLines(loop, round);
    let resume = { how: 'ask' };
    if (verdict.verdict === 'CONTINUE') {
      const { next, files } = saveProposal(loop, verdict);
      lines.push(`The auditor's prompt for a next round is saved as .audit\\${path.basename(files.proposed)}.`);
      resume = { how: 'proposal', round: next };
    } else {
      lines.push(`The auditor had ${M.plural(verdict.questions.length, 'question')}: see round-${M.pad(round)}-verdict.json.`);
    }
    return endLoop(ctx, loop, `Stopped by /stop after the audit of round ${round}.`, lines, resume);
  }
  if (verdict.verdict === 'ASK_HUMAN') {
    return askQuestions(ctx, loop, verdict, [
      ...M.warningLines(loop, round),
      `${M.label(loop)}: audited. The auditor has ${M.plural(verdict.questions.length, 'question')} before it can go on.`,
      ...M.roundLines(loop, round),
      `After your answers: ${M.oneLine(verdict.next_prompt)}`,
    ]);
  }
  if (round < loop.cap) return O.isOvernight(loop) ? overnightPropose(ctx, loop, verdict) : propose(ctx, loop, verdict);

  // CONTINUE in the last round: the cap ends the loop. The prompt is still sent, without buttons.
  const { next, files } = saveProposal(loop, verdict);
  endLoop(ctx, loop, `The round cap is reached: round ${round} of ${loop.cap} ended with CONTINUE, and the work is not done.`, [
    ...M.warningLines(loop, round),
    ...M.roundLines(loop, round),
    `The auditor's prompt for a round ${next} follows as a file. It is saved as .audit\\${path.basename(files.proposed)}; no round starts.`,
    `/resume ${loop.name} brings it back with Approve, Edit and Stop: Approve raises the cap by one round.`,
    ...(O.isOvernight(loop) ? [`/overnight ${loop.name} <rounds> continues in overnight mode instead, for that many more rounds.`] : []),
  ], { how: 'proposal', round: next });
  return ctx.sendFile(files.proposed, files.sentAs, `${loop.name}: the auditor's prompt for a round ${next}. The loop has ended: nothing starts.`);
}

// ---- /resume: continues a loop that ended, or paused, without being finished ----

// A loop.json from before Phase 4 has no end.resume: what its records allow.
function resumeOfOldEnd(loop) {
  const verdict = loop.lastVerdict;
  if (verdict && verdict.verdict === 'DONE') return { how: 'none' };
  if (verdict && verdict.kind !== 'goal-check' && verdict.verdict === 'CONTINUE'
    && fs.existsSync(M.proposalFiles(loop, verdict.round + 1).proposed)) return { how: 'proposal', round: verdict.round + 1 };
  if (verdict && verdict.kind !== 'goal-check' && verdict.verdict === 'STOP_FOR_HUMAN') return { how: 'new-prompt', round: verdict.round + 1 };
  return null;
}

// The saved verdict of a round, or null.
function savedVerdict(loop, round) {
  const value = readJsonSafe(roundFile(loop.project, round, 'verdict.json')).value;
  return value && VERDICTS.includes(value.verdict) ? value : null;
}

// Runs a round's audit again, or acts on a verdict that was saved and never acted on.
// quiet: the caller has said already that the audit runs again.
function resumeAudit(ctx, loop, plan, { quiet = false } = {}) {
  loop.round = plan.round;
  const say = (text) => (quiet ? undefined : ctx.send(text));
  if (plan.step === 'followup') {
    startAuditor(ctx, loop, 'followup');
    return say(`${M.label(loop)}: the auditor's follow-up runs again.`);
  }
  const saved = savedVerdict(loop, plan.round);
  if (saved && saved.verdict === 'ASK_HUMAN') {
    return askQuestions(ctx, loop, saved, [`${M.label(loop)}: the audit of this round had ${M.plural(saved.questions.length, 'question')} that were never asked.`]);
  }
  if (saved) {
    ctx.send(`${M.label(loop)}: this round has a verdict that was never acted on. I go on from it.`);
    return applyVerdict(ctx, loop, saved);
  }
  startAuditor(ctx, loop, 'auditor');
  return say(`${M.label(loop)}: the auditor runs on the round${loop.rounds[plan.round] && loop.rounds[plan.round].commit ? ` (commit ${loop.rounds[plan.round].commit})` : ''}.`);
}

// The proposal for a round comes back, with Approve / Edit / Stop.
function showProposalAgain(ctx, loop, plan) {
  const files = M.proposalFiles(loop, plan.round);
  if (!fs.existsSync(files.proposed)) return askForPrompt(ctx, loop, plan.round, [`The proposed prompt .audit\\${path.basename(files.proposed)} is gone.`]);
  const kept = loop.proposal && loop.proposal.round === plan.round && fs.existsSync(path.join(loop.project, '.audit', loop.proposal.baseFile));
  if (kept) {
    loop.proposal = { ...loop.proposal, buttonId: hex(3), shownAt: nowIso(ctx), remindedAt: null };
  } else {
    loop.proposal = newProposal(ctx, plan.round, files, fs.existsSync(files.auditor) ? files.auditor : files.proposed, 'auditor');
  }
  loop.proposal.proposedAgain = true;
  setStep(ctx, loop, 'proposal');
  loop.job = null;
  saveLoop(ctx, loop);
  logStep(ctx, loop, `the prompt for round ${plan.round} is proposed again (${path.basename(files.proposed)}): waiting for Approve, Edit or Stop`);
  ctx.send(`${M.label(loop, plan.round)}: the proposed prompt is back.${plan.round > loop.cap ? ` The round cap is ${loop.cap}: Approve raises it to ${plan.round}.` : ''}`);
  return sendProposal(ctx, loop);
}

// After a round without a usable verdict (STOP_FOR_HUMAN, a builder that failed):
// the owner writes the next round's prompt himself.
function askForPrompt(ctx, loop, round, intro = []) {
  setStep(ctx, loop, 'prompt-wait');
  loop.job = null;
  loop.proposal = null;
  loop.promptWait = { round, askedAt: nowIso(ctx), remindedAt: null };
  saveLoop(ctx, loop);
  const dropped = replaceWait(ctx, { kind: 'loop-prompt', loop: loop.id, round, name: loop.name });
  logStep(ctx, loop, `waiting for the owner's prompt for round ${round}`);
  const verdict = loop.lastVerdict;
  const stopped = verdict && verdict.verdict === 'STOP_FOR_HUMAN' && verdict.round === round - 1;
  return ctx.send([
    ...intro,
    ...(stopped ? [`The auditor stopped after round ${verdict.round}: ${M.oneLine(verdict.reason)}`, `What it asked of you: ${M.oneLine(verdict.next_prompt)}`] : []),
    `${dropped}${M.label(loop, round)}: send the prompt for round ${round}, ${HOW_TO_SEND}.`,
    'I show it to you with Approve, Edit and Stop before anything starts. /cancel ends the loop again; nothing changes.',
  ].join('\n'));
}

// The owner's prompt after /resume: it becomes the proposal for the round.
async function promptInput(conversation, msg, ctx) {
  const loop = activeLoop(ctx);
  const live = loop && (!conversation || loop.id === conversation.loop) && loop.step === 'prompt-wait';
  if (!live) {
    ctx.setConversation(null);
    return ctx.send('No loop is waiting for a prompt. Nothing was saved.');
  }
  const round = loop.promptWait.round;
  const input = await readInput(msg, ctx);
  if (input.problem) return ctx.send(`${M.label(loop, round)}: ${input.problem}\nSend the prompt ${HOW_TO_SEND}, or /cancel.`);
  const files = M.proposalFiles(loop, round);
  const text = input.text.endsWith('\n') ? input.text : `${input.text}\n`;
  writeFileAtomic(files.owner, text);
  writeFileAtomic(files.proposed, text);
  setStep(ctx, loop, 'proposal');
  loop.promptWait = null;
  loop.proposal = newProposal(ctx, round, files, files.owner, 'owner', { ownerFile: input.fromFile === true });
  ctx.setConversation(null);
  saveLoop(ctx, loop);
  logStep(ctx, loop, `round ${round}: the owner's prompt is proposed (${path.basename(files.owner)}, ${Buffer.byteLength(text, 'utf8')} bytes): waiting for Approve, Edit or Stop`);
  ctx.send(`${M.label(loop, round)}: your prompt is saved (${Buffer.byteLength(text, 'utf8')} bytes).`
    + `${/HANDOFF\.md/i.test(text) ? '' : '\nNote: it does not ask for HANDOFF.md. The fixed preface in front of every prompt still does.'}`
    + `${round > loop.cap ? `\nThe round cap is ${loop.cap}: Approve raises it to ${round}.` : ''}`);
  return sendProposal(ctx, loop);
}

// Goes on from a plan: loop.end.resume after an end, or pause.next after a pause.
function continueFrom(ctx, loop, plan) {
  const place = () => M.label(loop);
  switch (plan.how) {
    case 'goal-check':
      startGoalCheck(ctx, loop);
      return ctx.send(`${place()}: the auditor checks GOAL.md again (goal check ${loop.goalChecks}).`);
    case 'builder':
      startBuilder(ctx, loop, plan.round);
      return ctx.send(`${place()}: the builder started with .audit\\${path.basename(roundFile(loop.project, plan.round, 'prompt.md'))}.`);
    case 'builder-rerun': {
      loop.round = plan.round;
      const redo = redoRound(ctx, loop, plan.round);
      if (redo.error) return askCutOff(ctx, loop, { round: plan.round, reason: 'usage-limit', intro: [`${place()}: the round could not simply run again: ${redo.error}`] });
      return ctx.send(`${place()}: the builder runs the round again with the same prompt.\n${redo.said}`);
    }
    case 'choice':
      return askCutOff(ctx, loop, { round: plan.round, reason: plan.reason });
    case 'auditor':
      return resumeAudit(ctx, loop, plan);
    case 'questions': {
      if (!loop.questions || !loop.questions.items.some((item) => !item.answer)) return endLoop(ctx, loop, 'There is no open question to go back to.', [], { how: 'none' });
      setStep(ctx, loop, 'questions');
      loop.questions.sentAt = nowIso(ctx);
      announce(ctx, loop);
      return saveLoop(ctx, loop);
    }
    case 'ask':
      if (!loop.lastVerdict || loop.lastVerdict.verdict !== 'ASK_HUMAN') return endLoop(ctx, loop, 'The auditor\'s questions are not on record any more.', [], { how: 'none' });
      loop.round = loop.lastVerdict.round;
      return askQuestions(ctx, loop, loop.lastVerdict, [`${place()}: the auditor has ${M.plural(loop.lastVerdict.questions.length, 'question')}.`, `Reason: ${M.oneLine(loop.lastVerdict.reason)}`]);
    case 'proposal':
      return showProposalAgain(ctx, loop, plan);
    case 'new-prompt':
      return askForPrompt(ctx, loop, plan.round);
    default:
      return endLoop(ctx, loop, `I do not know how to go on from here (${plan.how}).`, [], { how: 'none' });
  }
}

function resumeLoop(name, ctx) {
  const refuse = (why) => refusal(ctx, '/resume', why);
  const found = findProject(name, ctx);
  if (found.usage) return ctx.send(`${found.problem}\nUse it like this: /resume My_Project`);
  if (found.problem) return refuse(found.problem);
  const { entry, project } = found;

  const active = activeLoop(ctx);
  if (active && active.project !== project) return refuse(`another loop is running: ${M.label(active)} (${standing(active)}). One loop at a time; /stop ends it.`);
  if (active && active.step === 'paused') return endPause(ctx, active, true);
  if (active) return ctx.send(`${M.label(active)} is running: ${standing(active)}. There is nothing to resume.`);

  const read = readJsonSafe(loopFile(project), { repair: true, check: loopProblem });
  if (!read.value) return refuse(`${entry} has no loop to continue (.audit\\loop.json ${read.note ? `could not be used: ${read.note}` : 'is not there'}). Start one with /loop ${entry}.`);
  const loop = read.value;
  const pointer = { id: loop.id, name: loop.name, project, rev: loop.rev };

  if (loop.step !== 'ended') {
    // The bot lost track of a loop that never ended (runtime\state.json was lost):
    // it is picked up where it stands. A job that ended or died meanwhile is handled
    // by this same tick, as after any gap.
    const oldJob = ctx.state.jobs.find((job) => !job.ended && ['starting', 'running'].includes(jobState(job).phase));
    if (oldJob) return refuse(`a job is still running: the builder for ${oldJob.name}, started at ${clock(oldJob.startedAt)}.`);
    ctx.state.loop = pointer;
    ctx.loop = loop;
    logStep(ctx, loop, `---- /resume ${entry}: the bot had lost track of this loop; picked up again at step "${loop.step}" ----`);
    ctx.send(`${entry}: this loop never ended, but the bot had lost track of it. It is picked up where it stands.`);
    return announce(ctx, loop);
  }

  const plan = (loop.end && loop.end.resume) || resumeOfOldEnd(loop);
  if (!plan) return refuse(`${entry}'s loop ended before the bot kept track of how to continue (${M.oneLine(loop.end && loop.end.why)}). Its records are in ${path.join(project, '.audit')}.`);
  if (plan.how === 'none') return refuse(`${entry}'s loop is finished: ${M.oneLine(loop.end && loop.end.why)} There is nothing to continue.`);
  const busy = busyProblem(ctx);
  if (busy) return refuse(busy);
  const repo = repoProblem(project, gitOptions(ctx));
  if (repo) return refuse(`${entry}: ${repo}`);
  // A builder comes next: it must not start on changes that nobody committed. After a
  // builder was cut off, the uncommitted work is the very thing to decide about.
  if (['goal-check', 'builder', 'proposal', 'new-prompt', 'questions', 'ask'].includes(plan.how)) {
    const tree = treeProblem(project, gitOptions(ctx));
    if (tree) return refuse(`${entry}: ${tree}`);
  }
  const claude = checkClaude({ n8nEnvFile: ctx.settings.n8nEnvFile });
  if (!claude.ok) return refuse(`${claude.problem}. Nothing was started.`);

  const ended = reopenLoop(ctx, loop, pointer);
  logStep(ctx, loop, `---- /resume ${entry}: it had ended with "${M.oneLine(ended.why)}"; claude ${claude.version} ----`);
  if (noteTestSettings(ctx, loop)) logStep(ctx, loop, `test settings: ${ctx.testSettings ? describeTestSettings(ctx.testSettings.values) : 'none is on any more'}`);
  // After an overnight run /resume continues in normal mode: every prompt waits for Approve.
  const wasOvernight = O.isOvernight(loop);
  if (wasOvernight) {
    loop.mode = 'normal';
    logStep(ctx, loop, 'the overnight run is over: /resume continues in normal mode, every prompt waits for Approve');
  }
  ctx.send([
    `${entry}: resuming. It had ended: ${M.oneLine(ended.why)}`,
    ...(wasOvernight ? ['The overnight run is over: from here every prompt waits for your Approve.'] : []),
    ...testLines(ctx),
  ].join('\n'));
  // Questions the overnight run left open are asked again first.
  const open = openQuestions(loop);
  if (open.length) return askOpenAgain(ctx, loop, open, plan);
  return continueFrom(ctx, loop, plan);
}

// A loop that ended is made the active one again. Returns its end record.
function reopenLoop(ctx, loop, pointer) {
  const ended = loop.end;
  loop.ends = [...(loop.ends || []), { at: ended.at, why: ended.why, resumedAt: nowIso(ctx) }];
  loop.end = null;
  loop.stopping = false;
  loop.job = null;
  loop.abort = null;
  loop.pause = null;
  loop.limitHits = 0;
  loop.lostRuns = 0;
  ctx.state.loop = pointer;
  ctx.loop = loop;
  ctx.loopLoaded = true;
  return ended;
}

// After /resume: the questions the overnight run left open come back with their
// buttons, before anything else. Once all are answered, their "(open)" entries are
// replaced and the loop goes on from `next` (see finishQuestions).
function askOpenAgain(ctx, loop, open, next) {
  setStep(ctx, loop, 'questions');
  loop.job = null;
  loop.proposal = null;
  loop.questions = {
    source: 'open',
    round: open[open.length - 1].round,
    askedAt: nowIso(ctx),
    sentAt: nowIso(ctx),
    remindedAt: null,
    resumeNext: next,
    items: open.map((q, i) => ({ n: i + 1, tag: q.tag, question: q.question, options: q.options, recommended: q.recommended, buttonId: q.buttonId, answer: null, round: q.round })),
  };
  saveLoop(ctx, loop);
  logStep(ctx, loop, `${M.plural(open.length, 'question')} left open by the overnight run ${open.length === 1 ? 'is' : 'are'} asked again before the loop goes on`);
  ctx.send(`${M.label(loop, loop.questions.round)}: ${M.plural(open.length, 'question')} of the auditor ${open.length === 1 ? 'was' : 'were'} left open during the overnight run. `
    + `Answer ${open.length === 1 ? 'it' : 'them'} first; then the loop goes on.`);
  for (const item of loop.questions.items) sendQuestion(ctx, loop, item);
  return undefined;
}

// ---- /overnight <name> <rounds>: rounds back to back, with no Approve (Phase 7) ----

// Two ways it starts: a new loop on a project no loop has run on (the same pre-flight
// as /loop, then the goal check), or a loop that ended at a proposed prompt (the round
// cap, Stop or /stop at a proposal, an earlier overnight run): the loop approves that
// prompt itself and the builder starts, with no goal check. Everything else is refused.
function overnightLoop(arg, ctx) {
  const refuse = (why) => refusal(ctx, '/overnight', why);
  const match = /^(\S+)\s+(\S+)$/.exec(String(arg || '').trim());
  const rounds = match ? O.parseRounds(match[2]) : null;
  if (!match || rounds === null) return ctx.send(OVERNIGHT_USAGE);
  const found = findProject(match[1], ctx);
  if (found.usage) return ctx.send(`${found.problem}\n${OVERNIGHT_USAGE}`);
  if (found.problem) return refuse(found.problem);
  const { entry, project } = found;

  const active = activeLoop(ctx);
  const busy = busyProblem(ctx);
  if (busy) return refuse(`${busy}${active && active.step === 'proposal' ? ' To turn that loop into an overnight run: press Stop on its prompt, then send /overnight again.' : ''}`);

  const limit = ctx.settings.overnightSevenDayPercent;
  // The two checks of this command, after /loop's or /resume's own.
  const ownProblem = (usage) => {
    const section = O.overnightSection(readGoal(project));
    if (!section.present) {
      return `${entry}: GOAL.md has no "## Overnight" section. An overnight run builds only the items of that section: add it (see templates/GOAL.template.md), commit it, and send /overnight again. /loop ${entry} runs the normal loop.`;
    }
    if (!section.items.length) return `${entry}: the "## Overnight" section of GOAL.md has no item. Add the items an overnight run may build with no review, commit, and send /overnight again.`;
    const stop = O.sevenDayCheck(usage, limit);
    if (stop) {
      return `${entry}: the 7-day window is at ${stop.percent}% (seen ${stop.seenAt ? M.when(stop.seenAt, ctx.now()) : 'at an unknown time'}), and an overnight run stops at ${limit}%. `
        + `It resets ${stop.resetsAt ? M.when(stop.resetsAt, ctx.now()) : 'at a time that is not known'}. Try again after that; /loop ${entry} runs the normal loop meanwhile.`;
    }
    return null;
  };
  const stopsAt = `It stops at DONE (every overnight item done), STOP_FOR_HUMAN, the round cap or ${limit}% of the 7-day window. Its messages come without sound. /stop ends it.`;

  const read = readJsonSafe(loopFile(project), { repair: true, check: loopProblem });
  const old = read.value;
  if (!old || !roundRecords(project).length) {
    // A project no loop has run on yet (or one whose loop ended before round 1): a new loop.
    const projectIssue = projectProblem(project, gitOptions(ctx));
    if (projectIssue) return refuse(`${entry}: ${projectIssue}`);
    const claude = checkClaude({ n8nEnvFile: ctx.settings.n8nEnvFile });
    if (!claude.ok) return refuse(`${claude.problem}. Nothing was started.`);
    const own = ownProblem(ctx.state.lastUsage);
    if (own) return refuse(own);

    const loop = newLoop(ctx, { entry, project, cap: rounds });
    loop.mode = 'overnight';
    loop.overnight = { startedAt: nowIso(ctx), rounds, cap: rounds, fromRound: 0, continued: false };
    logStep(ctx, loop, `---- /overnight ${entry} ${rounds}: loop ${loop.id} started in overnight mode, at most ${rounds} rounds, stops at ${limit}% of the 7-day window, claude ${claude.version} ----`);
    if (noteTestSettings(ctx, loop)) logStep(ctx, loop, `test settings are on: ${describeTestSettings(ctx.testSettings.values)}`);
    startGoalCheck(ctx, loop);
    return ctx.send([
      `${entry}: the overnight run started, with at most ${M.plural(rounds, 'round')} (the round cap is ${rounds}). The rounds run back to back without your Approve, on the items of GOAL.md's "## Overnight" section only.`,
      stopsAt,
      `First the auditor checks GOAL.md (goal check ${loop.goalChecks}).`,
      ...testLines(ctx),
    ].join('\n'));
  }

  // A loop ran here. Only one that ended at a proposed prompt can go on as an overnight run.
  if (old.step !== 'ended') return refuse(`${entry}: this loop never ended, but the bot had lost track of it. Send /resume ${entry} first: it picks the loop up where it stands.`);
  const plan = (old.end && old.end.resume) || resumeOfOldEnd(old);
  const why = M.oneLine(old.end && old.end.why);
  if (!plan) return refuse(`${entry}'s loop ended before the bot kept track of how to continue (${why}). /resume ${entry} cannot continue it either. Its records are in ${path.join(project, '.audit')}.`);
  if (plan.how === 'none') return refuse(`${entry}'s loop is finished: ${why} There is nothing to continue, so there is nothing for an overnight run.`);
  if (plan.how !== 'proposal') {
    return refuse(`${entry}'s loop ended with: ${why} An overnight run continues only from a proposed prompt that waits (after the round cap, Stop or /stop at a proposal, or an earlier overnight run). `
      + `Send /resume ${entry} first: ${O.resumeDoes(plan)}.`);
  }
  const repo = repoProblem(project, gitOptions(ctx));
  if (repo) return refuse(`${entry}: ${repo}`);
  const tree = treeProblem(project, gitOptions(ctx));
  if (tree) return refuse(`${entry}: ${tree}`);
  const claude = checkClaude({ n8nEnvFile: ctx.settings.n8nEnvFile });
  if (!claude.ok) return refuse(`${claude.problem}. Nothing was started.`);
  const own = ownProblem(ctx.state.lastUsage || old.usage);
  if (own) return refuse(own);
  const files = M.proposalFiles(old, plan.round);
  if (!fs.existsSync(files.proposed)) return refuse(`${entry}: the proposed prompt .audit\\${path.basename(files.proposed)} is gone. /resume ${entry} asks you for the prompt instead.`);

  const loop = old;
  const ended = reopenLoop(ctx, loop, { id: loop.id, name: loop.name, project, rev: loop.rev });
  if (loop.overnight) loop.overnightRuns = [...(loop.overnightRuns || []), loop.overnight];
  loop.mode = 'overnight';
  loop.cap = loop.round + rounds;
  loop.overnight = { startedAt: nowIso(ctx), rounds, cap: loop.cap, fromRound: loop.round, continued: true, round: plan.round };
  // The proposal, as /resume brings it back: the kept one with its notes, or a new one.
  const kept = loop.proposal && loop.proposal.round === plan.round && fs.existsSync(path.join(project, '.audit', loop.proposal.baseFile));
  loop.proposal = kept
    ? { ...loop.proposal, buttonId: hex(3), shownAt: nowIso(ctx), remindedAt: null }
    : newProposal(ctx, plan.round, files, fs.existsSync(files.auditor) ? files.auditor : files.proposed, 'auditor');
  loop.proposal.proposedAgain = true;
  logStep(ctx, loop, `---- /overnight ${entry} ${rounds}: it had ended with "${M.oneLine(ended.why)}"; continuing in overnight mode from the prompt for round ${plan.round}, `
    + `the round cap is now ${loop.cap} (${loop.round} done plus ${rounds}), stops at ${limit}% of the 7-day window; claude ${claude.version} ----`);
  if (noteTestSettings(ctx, loop)) logStep(ctx, loop, `test settings: ${ctx.testSettings ? describeTestSettings(ctx.testSettings.values) : 'none is on any more'}`);
  ctx.send([
    `${entry}: the overnight run started from the prompt that waited for round ${plan.round}, with at most ${M.plural(rounds, 'more round')} (the round cap is now ${loop.cap}). `
      + 'The rounds run back to back without your Approve, on the items of GOAL.md\'s "## Overnight" section only.',
    stopsAt,
    `No goal check: it had ended with "${M.oneLine(ended.why)}"`,
    ...testLines(ctx),
  ].join('\n'));
  ctx.sendFile(files.proposed, files.sentAs, `${entry}: the prompt for round ${plan.round}, approved by the overnight run`);
  return approveByLoop(ctx, loop);
}

// ---- where a loop stands ----

// Tells the owner where the loop stands, with its buttons. Used when the tick before
// was cut off between its two writes, after the bot was offline, and after /resume.
function announce(ctx, loop) {
  if (loop.job) return ctx.send(`${M.label(loop)}: ${standing(loop)}.`);
  if (loop.step === 'questions') {
    const open = loop.questions.items.filter((item) => !item.answer);
    loop.questions.remindedAt = nowIso(ctx);
    ctx.send(`${M.label(loop, loop.questions.round)}: ${M.plural(open.length, 'question')} of the auditor ${open.length === 1 ? 'is' : 'are'} still open.`);
    return open.forEach((item) => sendQuestion(ctx, loop, item));
  }
  if (loop.step === 'proposal') {
    loop.proposal.remindedAt = nowIso(ctx);
    // The round's message belongs to a prompt that the auditor wrote after that round.
    const verdict = loop.rounds[loop.round] && loop.rounds[loop.round].verdict;
    if (verdict && verdict.verdict === 'CONTINUE' && loop.proposal.round === loop.round + 1 && loop.proposal.source !== 'owner') ctx.send(M.roundMessage(loop, loop.round));
    return sendProposal(ctx, loop);
  }
  if (loop.step === 'paused') return ctx.send(pauseText(ctx, loop));
  if (loop.step === 'choice') {
    loop.choice.remindedAt = nowIso(ctx);
    return ctx.send(M.cutOffText(loop, loop.choice, statusShort(loop.project, 20, gitOptions(ctx))), { replyMarkup: M.choiceKeyboard(loop) });
  }
  if (loop.step === 'prompt-wait') {
    loop.promptWait.remindedAt = nowIso(ctx);
    return ctx.send(`${M.label(loop, loop.promptWait.round)}: I am waiting for your prompt for round ${loop.promptWait.round}, ${HOW_TO_SEND}. /cancel ends the loop again.`);
  }
  return undefined;
}

// After the bot was offline: where the active loop stands. The reminders start anew.
function announceAfterGap(ctx) {
  const loop = activeLoop(ctx);
  if (!loop) return;
  ctx.silent = O.isOvernight(loop);
  try {
    announce(ctx, loop);
    saveLoop(ctx, loop);
  } catch (err) {
    ctx.log(`loop ${loop.name}: could not save loop.json: ${err.message}`);
  } finally {
    ctx.silent = false;
  }
}

// Reports the builder's session once, as soon as its summary names it.
function reportSession(ctx, loop) {
  const job = loop.job;
  if (job.kind !== 'builder' || job.sessionReported) return;
  const summary = readJsonSafe(job.summaryFile).value;
  if (!summary || !summary.session_id) return;
  job.sessionReported = true;
  saveLoop(ctx, loop);
  ctx.send([`${M.label(loop)}: builder session ${summary.session_id}`, `To take it over on the PC, run this in ${loop.project}:`, `claude --resume ${summary.session_id}`].join('\n'));
}

// The file a step writes while it runs, and its last line.
function liveLogFile(loop) {
  return loop.job.kind === 'builder' ? roundFile(loop.project, loop.round, 'builder.log') : loop.job.logFile;
}

function lastLine(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim());
    return lines.length ? lines[lines.length - 1].slice(0, 300) : '(the log is empty)';
  } catch {
    return '(no log yet)';
  }
}

// The stuck alert: one message when a step has run longer than its limit, and one
// more at twice the limit. Nothing is cut off: /abort is the owner's.
function checkStuck(ctx, loop) {
  const job = loop.job;
  const minutes = { builder: ctx.settings.stuckBuilderMinutes, 'goal-check': ctx.settings.stuckGoalCheckMinutes }[job.kind] || ctx.settings.stuckAuditorMinutes;
  const ranMs = ctx.now() - Date.parse(job.clockStartedAt || job.startedAt);
  const due = ranMs >= 2 * minutes * 60000 ? 2 : (ranMs >= minutes * 60000 ? 1 : 0);
  if (due <= (job.alerts || 0)) return;
  job.alerts = due;
  saveLoop(ctx, loop);
  const words = M.jobWords(job.kind);
  logStep(ctx, loop, `${where(loop)}stuck alert ${due} of 2: the ${words} has run for ${M.span(ranMs)} (the limit is ${minutes} min)`);
  ctx.send([
    `${M.label(loop)}: the ${words} has been running for ${M.span(ranMs)}. That is ${due === 2 ? 'twice the limit' : 'over the limit'} of ${minutes} min for an alert.`,
    `The last line of its log: ${lastLine(liveLogFile(loop))}`,
    `/log shows more. /abort ends it at once, after a Confirm. It is not cut off by itself.${due === 2 ? ' This is the last alert for this step.' : ''}`,
  ].join('\n'));
}

// The timers of a step that waits for the owner: the default answer after an hour,
// and a reminder every three hours. Each counts from a time saved in loop.json.
function checkWaits(ctx, loop) {
  const nowMs = ctx.now();
  const remindMs = ctx.settings.reminderHours * 3600000;
  const due = (since) => nowMs - Date.parse(since) >= remindMs;

  if (loop.step === 'questions') {
    const questions = loop.questions;
    const sentAt = questions.sentAt || questions.askedAt;
    if (nowMs - Date.parse(sentAt) >= ctx.settings.defaultAnswerMinutes * 60000) {
      const defaults = questions.items.filter((item) => !item.answer && item.tag === 'DEFAULT');
      if (defaults.length) {
        assumeDefaults(ctx, loop, defaults);
        if (loop.step !== 'questions') return;
      }
    }
    if (due(questions.remindedAt || sentAt)) {
      const open = questions.items.filter((item) => !item.answer);
      questions.remindedAt = nowIso(ctx);
      saveLoop(ctx, loop);
      logStep(ctx, loop, `reminder: ${M.plural(open.length, 'question')} still open`);
      ctx.send(`${M.label(loop, questions.round)}: a reminder. ${M.plural(open.length, 'question')} of the auditor ${open.length === 1 ? 'is' : 'are'} still open, and the loop waits for your answer.`);
      open.forEach((item) => sendQuestion(ctx, loop, item));
    }
  } else if (loop.step === 'proposal') {
    const p = loop.proposal;
    if (due(p.remindedAt || p.shownAt || loop.stepSince || loop.updatedAt)) {
      p.remindedAt = nowIso(ctx);
      saveLoop(ctx, loop);
      logStep(ctx, loop, `reminder: the prompt for round ${p.round} still waits for Approve, Edit or Stop`);
      ctx.send(`${M.label(loop, p.round)}: a reminder. The prompt for round ${p.round} still waits for you (.audit\\${p.file}).`, { replyMarkup: M.proposalKeyboard(loop) });
    }
  } else if (loop.step === 'choice') {
    const choice = loop.choice;
    if (due(choice.remindedAt || choice.askedAt)) {
      choice.remindedAt = nowIso(ctx);
      saveLoop(ctx, loop);
      logStep(ctx, loop, `reminder: round ${choice.round} still waits for Redo the round, Keep and audit or Stop`);
      ctx.send(M.cutOffText(loop, choice, statusShort(loop.project, 20, gitOptions(ctx)), [`${M.label(loop, choice.round)}: a reminder.`]), { replyMarkup: M.choiceKeyboard(loop) });
    }
  } else if (loop.step === 'prompt-wait') {
    const wait = loop.promptWait;
    if (due(wait.remindedAt || wait.askedAt)) {
      wait.remindedAt = nowIso(ctx);
      saveLoop(ctx, loop);
      logStep(ctx, loop, `reminder: still waiting for the owner's prompt for round ${wait.round}`);
      ctx.send(`${M.label(loop, wait.round)}: a reminder. I am waiting for your prompt for round ${wait.round}, ${HOW_TO_SEND}. /cancel ends the loop again.`);
    }
  }
}

// A job whose process is gone: its record says "running" and its heartbeat stopped.
// A builder gets the three buttons. An audit or a goal check runs again by itself.
function afterLostJob(ctx, loop) {
  const job = loop.job;
  const words = M.jobWords(job.kind);
  logStep(ctx, loop, `the ${words} (job ${job.id}) is lost: its process is gone and its record has no end`);
  const said = `${M.label(loop)}: the ${words} ended without a result: its process is gone and its record has no end.`;
  if (job.kind === 'builder') {
    return askCutOff(ctx, loop, { round: loop.round, reason: 'lost', intro: [said, `Its log: ${job.logFile}`] });
  }
  if (job.kind === 'goal-check') loop.goalChecks -= 1;
  loop.lostRuns = (loop.lostRuns || 0) + 1;
  if (loop.lostRuns > LOST_RERUNS) {
    return endLoop(ctx, loop, `The ${words}${ofRound(loop)} ended without a result ${LOST_RERUNS + 1} times in a row: its process is gone each time.`,
      ['Nothing was decided.', `Its log: ${job.logFile}`], resumeOfJob(loop, job.kind, 'lost'));
  }
  ctx.send(`${said} Nothing was decided, so it runs again by itself.`);
  if (job.kind === 'goal-check') return startGoalCheck(ctx, loop);
  return resumeAudit(ctx, loop, { round: loop.round, step: job.kind }, { quiet: true });
}

// One look at the active loop: when the job of its step has ended, the next step
// starts; while it runs or waits, its timers are checked.
function driveLoop(ctx) {
  const loop = activeLoop(ctx);
  if (!loop) return;
  // What the loop sends on its own during an overnight run arrives without a sound.
  // The owner's own commands and button presses are handled before this, with sound.
  ctx.silent = O.isOvernight(loop);
  try {
    // /testmode during a loop, or test settings that switched off by themselves.
    if (noteTestSettings(ctx, loop)) {
      saveLoop(ctx, loop);
      logStep(ctx, loop, `test settings changed: ${ctx.testSettings ? describeTestSettings(ctx.testSettings.values) : 'none is on any more'}`);
    }
    if (!loop.job) {
      if (loop.step === 'paused') {
        if (ctx.now() >= Date.parse(loop.pause.resumeAt)) endPause(ctx, loop, false);
        return;
      }
      checkWaits(ctx, loop);
      return;
    }
    const { phase, record } = jobState(loop.job, { onNote: ctx.log });
    if (phase === 'starting' || phase === 'running') {
      reportSession(ctx, loop);
      checkStuck(ctx, loop);
      return;
    }
    if (phase === 'lost') {
      afterLostJob(ctx, loop);
      return;
    }
    if (loop.step === 'goal-check') afterGoalCheck(ctx, loop, record);
    else if (loop.step === 'builder') afterBuilder(ctx, loop, record);
    else afterAudit(ctx, loop, record);
  } catch (err) {
    // A step that fails must never fail every tick: the loop ends, with the error.
    ctx.log(`loop ${loop.name}: unexpected error at step ${loop.step}: ${err.stack || err.message}`);
    const step = loop.step;
    const resume = {
      'goal-check': { how: 'goal-check' },
      builder: { how: 'choice', round: loop.round, reason: 'lost' },
      auditor: { how: 'auditor', round: loop.round, step: 'auditor' },
      followup: { how: 'auditor', round: loop.round, step: 'followup' },
      questions: { how: 'questions' },
      choice: loop.choice ? { how: 'choice', round: loop.choice.round, reason: loop.choice.reason } : { how: 'none' },
      proposal: loop.proposal ? { how: 'proposal', round: loop.proposal.round } : { how: 'none' },
      paused: loop.pause ? loop.pause.next : { how: 'none' },
      'prompt-wait': loop.promptWait ? { how: 'new-prompt', round: loop.promptWait.round } : { how: 'none' },
    }[step] || { how: 'none' };
    try {
      endLoop(ctx, loop, 'It stopped on an unexpected error.', [`Error: ${String(err.message).slice(0, 500)}`, `It was at: ${step}${loop.round > 0 ? `, round ${loop.round}` : ''}.`], resume);
    } catch (again) {
      ctx.log(`loop ${loop.name}: could not end it cleanly: ${again.message}`);
      ctx.state.loop = null;
      ctx.loop = null;
    }
  } finally {
    ctx.silent = false;
  }
}

// A press on one of the loop's buttons. Returns false for a button that is not the loop's.
function handleLoopButton(query, ctx) {
  if (!/^l[pqca]:/.test(query.data || '')) return false;
  const match = BUTTON.exec(query.data);
  if (!match || !BUTTON_ACTIONS[match[1]].includes(match[4])) ctx.answerButton(query.id, EXPIRED);
  else if (match[1] === 'p') pressProposal(query, ctx, match);
  else if (match[1] === 'q') pressQuestion(query, ctx, match);
  else if (match[1] === 'c') pressChoice(query, ctx, match);
  else pressAbort(query, ctx, match);
  return true;
}

module.exports = {
  startLoop, stopLoop, resumeLoop, abortLoop, driveLoop, handleLoopButton, editInput, otherInput, promptInput, cancelWait, activeLoop, describeWait, loopWait,
  announceAfterGap, standing, liveLogFile, findProject, loopFile, loopLogFile, loopProblem, STEPS, overnightLoop, openQuestions,
};
