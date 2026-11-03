'use strict';

// What the loop's tests need to play the owner: run ticks until something has
// happened, find the bot's messages, files and buttons, and press a button.
// `s` is a sandbox of tests/helpers/bot_sandbox.js.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createProject } = require('../../scripts/lib/projects');

const GOAL = '# GOAL: say hello\n\nA script that prints hello.\n\n## Definition of done\n- [ ] hello.js prints hello\n';
const PROMPT = 'FIRST_PROMPT_MARKER Create hello.js that prints hello.\n';
const SESSION = '11111111-2222-4333-8444-555555555555';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();

// Ticks until check() is true, as the real ticks come every 5 seconds.
async function tickUntil(s, check, what, { tries = 240, tickOptions } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const r = await s.tick(tickOptions);
    if (r.status !== 0) throw new Error(`a tick failed while waiting for ${what}: exit ${r.status}, ${r.stderr || r.stdout}`);
    if (await check()) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}. The bot sent:\n${s.fake.sentTexts().slice(-6).join('\n---\n')}`);
}

const texts = (s) => s.fake.sentTexts();
// The last message whose text matches, or undefined.
const lastText = (s, pattern) => texts(s).filter((text) => pattern.test(text)).pop();
const said = (s, pattern) => texts(s).some((text) => pattern.test(text));
const keyboards = (s) => s.fake.sent.filter((m) => m.replyMarkup);
const lastKeyboard = (s) => keyboards(s).pop();
const documents = (s) => s.fake.sent.filter((m) => m.method === 'sendDocument');
const buttonAnswers = (s) => s.fake.sent.filter((m) => m.method === 'answerCallbackQuery').map((m) => m.text);
// The message with the buttons of a question, by the question's number.
const questionMessage = (s, n) => keyboards(s).filter((m) => new RegExp(`: Question ${n} of \\d+ \\[`).test(m.text)).pop();
const proposalMessage = (s) => keyboards(s).filter((m) => /: start the builder with this prompt\?$/.test(m.text)).pop();
const endMessage = (s) => lastText(s, /: the loop ended\. /);

// The button of a message whose label starts with `label`.
function button(message, label) {
  const found = message.replyMarkup.inline_keyboard.flat().find((b) => b.text.startsWith(label));
  if (!found) throw new Error(`no button "${label}" on: ${message.text}`);
  return found;
}

function press(s, message, label) {
  return s.fake.press(s.owner, button(message, label).callback_data);
}

// A project as /new makes it, in the sandbox's projects root.
function newProject(s, name, { goal = GOAL, prompt = PROMPT } = {}) {
  return createProject({ root: s.projectsRoot, name, goal, prompt }).dir;
}

// Sends /loop and runs the tick that starts it.
async function startLoop(s, name, tickOptions) {
  s.fake.message(s.owner, `/loop ${name}`);
  return s.tick(tickOptions);
}

// Phase 4: the three buttons after a builder was cut off, and the Confirm of /abort.
const choiceMessage = (s) => keyboards(s).filter((m) => m.replyMarkup.inline_keyboard.flat().some((b) => b.text === 'Redo the round')).pop();
const abortMessage = (s) => keyboards(s).filter((m) => m.replyMarkup.inline_keyboard.flat().some((b) => b.text === 'Confirm')).pop();
// The LOOP_REPORT.md files the bot sent, oldest first.
const reports = (s) => documents(s).filter((m) => /-LOOP_REPORT\.md$/.test(m.filename));

// Sends one message and runs the tick that handles it. Returns the bot's last text.
async function say(s, text, tickOptions) {
  s.fake.message(s.owner, text);
  const r = await s.tick(tickOptions);
  if (r.status !== 0) throw new Error(`the tick for "${text.slice(0, 40)}" failed: exit ${r.status}, ${r.stderr || r.stdout}`);
  return texts(s).pop();
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Waits until none of the processes is left. Returns the ones that still are.
async function waitGone(pids, ms = 8000) {
  const until = Date.now() + ms;
  let left = pids.filter(isAlive);
  while (left.length && Date.now() < until) {
    await sleep(100);
    left = left.filter(isAlive);
  }
  return left;
}

const audit = (project, name) => path.join(project, '.audit', name);
const readAudit = (project, name) => fs.readFileSync(audit(project, name), 'utf8');
const loopState = (project) => JSON.parse(readAudit(project, 'loop.json'));
// The record of a loop's running job, and its builder's summary: null until they are written.
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const jobRecord = (project) => {
  const job = loopState(project).job;
  return job ? readJson(job.recordFile) : null;
};
// The process IDs of the job that runs now: its runner, its command, and claude (the fake).
function jobPids(s, project, kind) {
  const record = jobRecord(project) || {};
  const summary = kind === 'builder' ? readJson(audit(project, `round-0${loopState(project).round}-builder.json`)) || {} : {};
  const fake = s.calls().filter((call) => (kind === 'builder' ? call.kind === 'builder' : call.kind === 'auditor')).pop();
  return [record.runner_pid, record.child_pid, summary.claude_pid, fake && fake.pid].filter(Number.isInteger);
}
// True once the job of a step runs, with everything /abort needs written down and
// the fake claude started: more calls of its kind than `callsBefore`.
function jobIsUp(s, project, step, callsBefore = 0) {
  const loop = loopState(project);
  if (loop.step !== step || !loop.job) return false;
  const record = jobRecord(project);
  if (!record || !record.child_pid) return false;
  const kind = step === 'builder' ? 'builder' : 'auditor';
  if (s.calls().filter((call) => call.kind === kind).length <= callsBefore) return false;
  if (step !== 'builder') return true;
  // The builder's session was reported too: no message of the loop is still on its way.
  const summary = readJson(audit(project, `round-0${loop.round}-builder.json`));
  return Boolean(summary && summary.claude_pid && loop.job.sessionReported && fs.existsSync(audit(project, `round-0${loop.round}-builder.log`)));
}
const callsOfKind = (s, kind) => s.calls().filter((call) => call.kind === kind).length;
// loop.log without the time at the start of each line.
const loopLog = (project) => readAudit(project, 'loop.log').trim().split('\n').map((line) => line.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d /, ''));

module.exports = {
  GOAL, PROMPT, SESSION, sleep, git, tickUntil, texts, lastText, said, keyboards, lastKeyboard, documents, buttonAnswers,
  questionMessage, proposalMessage, endMessage, button, press, newProject, startLoop, audit, readAudit, loopState, loopLog,
  choiceMessage, abortMessage, reports, say, isAlive, waitGone, readJson, jobRecord, jobPids, jobIsUp, callsOfKind,
};
