'use strict';

// Tests the loop's controls (Phase 4): /status, /log, /abort, the stuck alert, the
// usage-limit pause, /resume, the offline message and lost jobs, reminders and
// default answers, /secret, LOOP_REPORT.md, and the hardening of the loop's git.
// Like tests/test_loop.js: real ticks against a fake Telegram server and a fake
// claude. The clock of a tick is moved with s.tickAt(): no test waits an hour.
// No real Claude call, no real Telegram call; every project is under tests/tmp/.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { botSandbox, filesUnder, DEFAULT_CONFIG, ROOT } = require('./helpers/bot_sandbox');
const D = require('./helpers/loop_driver');
const { localStamp } = require('../scripts/lib/runtime');
const { killJobProcesses } = require('../scripts/lib/process_tree');
const { secretValues, setEnvValue, envNames } = require('../scripts/lib/project_env');
const { createLimitWatch, resetFromText } = require('../scripts/lib/usage_limit');
const { when } = require('../scripts/lib/loop_messages');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const records = (project) => `Records: ${path.join(project, '.audit')} (loop.log, loop.json and the round-NN-* files)`;
const hhmm = (ms) => localStamp(new Date(ms)).slice(11, 16);
const callsOf = (s) => s.calls().map((call) => (call.kind === 'builder' ? `builder:${call.mode}` : `auditor:${call.audit}:${call.round}:${call.reply}`));
// What the bot sent since `from`, as texts.
const textsSince = (s, from) => s.fake.sent.slice(from).filter((m) => m.method === 'sendMessage').map((m) => m.text);
const stashList = (project) => D.git(project, 'stash', 'list').split('\n').filter(Boolean);

// Sends /abort, presses Confirm, and waits for the loop's end.
async function abortNow(s) {
  await D.say(s, '/abort');
  D.press(s, D.abortMessage(s), 'Confirm');
  const r = await s.tick();
  assert.equal(r.status, 0, r.stderr);
}

describe('the controls', { concurrency: 4 }, () => {
  // ---- 1. /status ----

  test('/status: with no loop, in every step, and after a loop', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const status = async () => (await D.say(s, '/status')).split('\n');
    assert.deepEqual(await status(), ['No loop is running.', 'Last loop: none on record.', 'Usage: not known yet: it comes with a Claude call.', 'Bot last offline: none on record.']);

    D.newProject(s, 'Stat');
    // Each step runs long enough to be looked at, also on a PC that is busy with other things.
    s.script({
      auditor: [{ reply: 'ask', delayMs: 6000 }, 'continue', { reply: 'continue', delayMs: 6000 }],
      builder: [{ mode: 'ok', delayMs: 10000 }],
    });
    await D.startLoop(s, 'Stat');

    // The goal check runs.
    let lines = await status();
    assert.equal(lines[0], 'Stat: before round 1, at most 3 rounds');
    assert.equal(lines[1], 'Step: goal check: the auditor is checking GOAL.md');
    assert.match(lines[2], /^In this step for: \d+ s \(since \d\d:\d\d\)$/);
    assert.match(lines[3], /^Job \d+: (starting, its record is not written yet|(starting|running), heartbeat \d+ s ago)$/);
    assert.deepEqual(lines.slice(4), [
      'Last verdict: none yet.',
      'Context: no builder round has ended yet.',
      'Usage: not known yet: it comes with a Claude call.',
      'Bot last offline: none on record.',
    ]);

    // It waits for answers.
    await D.tickUntil(s, () => D.questionMessage(s, 2), 'the questions');
    lines = await status();
    assert.equal(lines[1], 'Step: waiting for you: 2 questions of the auditor (1 [MUST], 2 [DEFAULT])');
    assert.equal(lines[3], 'Last verdict: ASK_HUMAN (goal check): GOAL.md leaves the greeting to the owner.');
    assert.match(lines[5], /^Usage: 5-hour window 34% used, resets \d\d:\d\d; 7-day window 12% used, resets \d{4}-\d\d-\d\d \d\d:\d\d \(as of \d\d:\d\d\)$/);
    assert.equal(lines.some((line) => line.startsWith('Job ')), false, 'no job while it waits');

    // The builder runs.
    D.press(s, D.questionMessage(s, 1), '1. hello');
    D.press(s, D.questionMessage(s, 2), '1. Yes');
    await D.tickUntil(s, () => D.jobIsUp(s, path.join(s.projectsRoot, 'Stat'), 'builder'), 'the builder to run');
    lines = await status();
    assert.equal(lines[0], 'Stat: Round 1 of 3');
    assert.equal(lines[1], 'Step: building');
    assert.match(lines[3], /^Job \d+: running, heartbeat \d+ s ago$/);
    assert.equal(lines[4], 'Last verdict: CONTINUE (goal check): GOAL.md is clear enough to start.');
    assert.match(lines[5], /^Context: this round so far: [\d,]+ tokens at the peak \(the % comes when the round ends\)$/);

    // /stop during a job shows in the step.
    await D.say(s, '/stop');
    assert.equal((await status())[1], 'Step: building, stopping: the loop ends when this step ends');
    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
    lines = await status();
    assert.equal(lines[0], 'No loop is running.');
    assert.match(lines[1], /^Last loop: Stat, ended \d\d:\d\d: Stopped by \/stop after the builder of round 1: the round is committed, not audited\. \/resume Stat continues it\.$/);
    // Since Phase 6: the last usage that a job reported, here the builder's.
    assert.match(lines[2], /^Usage \(as of \d\d:\d\d\): 5-hour window 21% used, resets \d\d:\d\d; 7-day window 9% used, resets \d{4}-\d\d-\d\d \d\d:\d\d$/);
    assert.equal(lines[3], 'Bot last offline: none on record.');

    // The auditor runs, then the loop waits at the proposal.
    await D.say(s, '/resume Stat');
    lines = await status();
    assert.equal(lines[1], 'Step: auditing');
    assert.equal(lines[5], 'Context: round 1: 5% of the window at the peak');
    assert.match(lines[6], /^Usage: 5-hour window 21% used, resets \d\d:\d\d; 7-day window 9% used, /, 'the builder\'s rate_limit_event is the latest');
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal');
    lines = await status();
    assert.equal(lines[1], 'Step: waiting for you: Approve, Edit or Stop on the prompt for round 2');
    assert.equal(lines[3], 'Last verdict: CONTINUE (round 1): Round 1 did part of the work.');
    D.press(s, D.proposalMessage(s), 'Stop');
    await s.tick();
  });

  // ---- 2. /log ----

  test('/log: the builder\'s live log while a builder runs and the loop\'s log otherwise, as a message or, when long, as a file', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    assert.equal(await D.say(s, '/log'), 'There is no loop to show a log of: none is running, and none has ended since the bot keeps track.');
    const project = D.newProject(s, 'Logs');
    // The builder runs long enough for the eight /log commands below, also on a busy PC.
    s.script({ auditor: ['continue', 'continue'], builder: [{ mode: 'ok', delayMs: 20000 }] });
    await D.startLoop(s, 'Logs');
    // While the goal check runs, /log is the loop's own log.
    let text = await D.say(s, '/log');
    assert.match(text, /^Logs: the last 2 lines of the loop's log \(\.audit\\loop\.log\):\n\S+ \S+ \S+ ---- \/loop Logs: loop [0-9a-f]{8} started.*\n\S+ \S+ \S+ goal check started \(job \d+\)$/);

    await D.tickUntil(s, () => D.jobIsUp(s, project, 'builder'), 'the builder to run');
    text = await D.say(s, '/log');
    const lines = text.split('\n');
    assert.match(lines[0], /^Logs: the last \d lines? of the builder's live log \(\.audit\\round-01-builder\.log\):$/);
    assert.match(lines[1], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d round 1: builder starting in .*Logs, prompt of \d+ bytes/);
    assert.ok(lines.some((line) => /session 11111111-2222-4333-8444-555555555555 started/.test(line)));
    // The other one by name, and a number of lines.
    assert.match(await D.say(s, '/log loop 1'), /^Logs: the last 1 line of the loop's log \(\.audit\\loop\.log\):\n\S+ \S+ \S+ round 1: builder started \(job \d+\)$/);
    assert.match(await D.say(s, '/log 1 builder'), /^Logs: the last 1 line of the builder's live log \(\.audit\\round-01-builder\.log\):\n[^\n]+$/);
    assert.equal(await D.say(s, '/log everything'), 'I do not understand "everything".\nUse it like this: /log, /log 50, /log builder, /log loop 100 (at most 100 lines).');
    assert.match(await D.say(s, '/log 0'), /^I do not understand "0"\./);

    // More than 3,500 characters go out as a file. 100 lines are the most.
    const long = Array.from({ length: 150 }, (_, i) => `${localStamp()} LONG_LINE ${String(i + 1).padStart(3, '0')} ${'x'.repeat(40)}`);
    fs.appendFileSync(D.audit(project, 'loop.log'), `${long.join('\n')}\n`);
    const before = D.documents(s).length;
    s.fake.message(s.owner, '/log loop 400');
    await s.tick();
    const file = D.documents(s)[before];
    assert.equal(file.filename, 'Logs-loop.log-last-100.txt');
    assert.equal(file.caption, 'Logs: the last 100 lines of the loop\'s log (.audit\\loop.log). 100 is the most.');
    assert.deepEqual(file.content.trimEnd().split('\n'), long.slice(-100));
    // A short one stays a message.
    assert.match(await D.say(s, '/log loop 3'), /LONG_LINE 148 x+\n.*LONG_LINE 149 x+\n.*LONG_LINE 150 x+$/);

    // After the loop: the log of the loop that ended last, and its last builder log.
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal');
    D.press(s, D.proposalMessage(s), 'Stop');
    await s.tick();
    text = await D.say(s, '/log 2');
    assert.match(text, /^Logs: the last 2 lines of the loop's log \(\.audit\\loop\.log\), of the loop that ended last:\n.*\n\S+ \S+ \S+ loop ended: Stopped by you at the prompt for round 2\.$/);
    assert.match(await D.say(s, '/log builder 1'), /^Logs: the last 1 line of the builder's log \(\.audit\\round-01-builder\.log\):\n\S+ \S+ round 1: builder ended: completed, exit code 0, HANDOFF\.md written$/);
  });

  // ---- 3. /abort ----

  test('/abort ends the builder at once after a Confirm: Cancel and an expired button do nothing, only the job\'s own processes end, nothing is committed', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    // A process that is not the job's. It must outlive every abort.
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    t.after(() => bystander.kill());
    assert.equal(await D.say(s, '/abort'), 'No loop is running.');

    const project = D.newProject(s, 'Abort');
    s.script({ auditor: ['continue'], builder: ['hang'] });
    await D.startLoop(s, 'Abort');
    await D.tickUntil(s, () => D.jobIsUp(s, project, 'builder'), 'the builder to run');
    const pids = D.jobPids(s, project, 'builder');
    assert.equal(pids.length, 4, 'the runner, run_builder.js, claude and the fake behind it');
    assert.deepEqual(pids.filter((pid) => !D.isAlive(pid)), []);

    await D.say(s, '/abort');
    const first = D.abortMessage(s);
    assert.equal(first.text, [
      'Abort, round 1 of 3: end the builder at once?',
      'Its processes are killed, nothing is committed, and the loop ends as aborted. The files stay as they are. /resume Abort continues from there.',
      'These buttons expire in 2 minutes.',
    ].join('\n'));
    assert.deepEqual(first.replyMarkup.inline_keyboard.map((row) => row.map((b) => b.text)), [['Confirm', 'Cancel']]);
    for (const b of first.replyMarkup.inline_keyboard[0]) assert.match(b.callback_data, /^la:[0-9a-f]{8}:[0-9a-f]{6}:[yn]$/);

    // Cancel: the builder runs on, and the buttons of that question are spent.
    D.press(s, first, 'Cancel');
    await s.tick();
    assert.equal(D.texts(s).pop(), 'Abort, round 1 of 3: not aborted. The builder runs on.');
    assert.equal(D.buttonAnswers(s).pop(), 'Cancelled');
    D.press(s, first, 'Confirm');
    await s.tick();
    assert.equal(D.buttonAnswers(s).pop(), 'This button has expired.');

    // A Confirm that comes more than two minutes late has expired.
    await D.say(s, '/abort');
    const second = D.abortMessage(s);
    D.press(s, second, 'Confirm');
    await s.tickAt(2 * MIN + 5000);
    assert.equal(D.buttonAnswers(s).pop(), 'This button has expired.');
    assert.equal(D.loopState(project).step, 'builder');
    assert.deepEqual(pids.filter((pid) => !D.isAlive(pid)), [], 'nothing was ended so far');

    // Confirm, in time.
    await abortNow(s);
    assert.equal(D.buttonAnswers(s).pop(), 'Aborted');
    const end = D.endMessage(s).split('\n');
    assert.equal(end[0], 'Abort: the loop ended. Aborted by you: the builder of round 1 was ended at once.');
    assert.match(end[1], /^Ended: the job's runner \(PID \d+\) with the processes it started\.$/);
    assert.deepEqual(end.slice(2), [
      'Nothing was committed: what the builder had changed is still in the folder, for you to look at.',
      '/resume Abort continues from there.',
      records(project),
    ]);
    assert.deepEqual(await D.waitGone(pids), [], 'the job\'s processes are gone');
    assert.equal(D.isAlive(bystander.pid), true, 'a process that is not the job\'s was not touched');
    assert.equal(D.git(project, 'log', '--format=%s'), 'Loop: GOAL.md', 'nothing was committed');
    assert.equal(D.git(project, 'status', '--porcelain'), '?? hello.js\n?? work.log', 'the files stay as they are');
    assert.equal(D.readJson(D.audit(project, 'round-01-builder.json')).status, 'aborted');
    const loop = D.loopState(project);
    assert.equal(loop.step, 'ended');
    assert.deepEqual(loop.end.resume, { how: 'choice', round: 1, reason: 'aborted' });
    assert.equal(s.state().loop, null);
    assert.ok(D.loopLog(project).some((line) => /^\/abort: the builder \(job \d+\) was ended at once: the job's runner \(PID \d+\) with the processes it started$/.test(line)));
    assert.equal((await s.tick()).stdout, 'idle\n');
    assert.deepEqual(callsOf(s), ['auditor:goal-check:0:continue', 'builder:hang'], 'no auditor ran');

    // The report of an aborted loop.
    const report = D.reports(s).pop();
    assert.equal(report.filename, 'Abort-LOOP_REPORT.md');
    assert.equal(report.content, D.readAudit(project, 'LOOP_REPORT.md'));
    assert.match(report.content, /^- How it ended: Aborted by you: the builder of round 1 was ended at once\.$/m);
    assert.match(report.content, /^- Rounds: 1 of 3$/m);
    assert.match(report.content, /^\| 1 \| cut off by \/abort \| - \| cost not known \| [\d,]+ tokens \| no \| 0 \| none \| no verdict \| - \| - \|$/m);
    assert.match(report.content, /Not in it: 1 call whose cost is not known, because it was cut off or failed\.$/m);

    // While no step runs, there is nothing to abort.
    await D.say(s, '/resume Abort');
    assert.match(await D.say(s, '/abort'), /^Abort, round 1 of 3: no step is running \(waiting for Redo the round, Keep and audit or Stop: the builder of round 1 was cut off\)\. \/abort only ends a running step; \/stop ends the loop\.$/);
    await D.say(s, '/stop');
  });

  test('/abort during the goal check and during the auditor: the step ends at once and can be resumed', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    t.after(() => bystander.kill());

    const goal = D.newProject(s, 'AbortGoal');
    s.script({ auditor: ['hang', 'continue'], builder: ['ok'] });
    await D.startLoop(s, 'AbortGoal');
    await D.tickUntil(s, () => D.jobIsUp(s, goal, 'goal-check'), 'the goal check to run');
    let pids = D.jobPids(s, goal, 'goal-check');
    assert.equal(pids.length, 3, 'the runner, run_auditor.js and the fake claude');
    assert.match(await D.say(s, '/abort'), /^AbortGoal, goal check: end the goal check at once\?\n/);
    D.press(s, D.abortMessage(s), 'Confirm');
    await s.tick();
    let end = D.endMessage(s).split('\n');
    assert.equal(end[0], 'AbortGoal: the loop ended. Aborted by you: the goal check was ended at once.');
    assert.equal(end[2], 'Nothing was decided, and nothing was committed.');
    assert.deepEqual(await D.waitGone(pids), []);
    assert.deepEqual(D.loopState(goal).end.resume, { how: 'goal-check' });
    assert.equal(fs.existsSync(D.audit(goal, 'goal-check-01-verdict.json')), false);
    // /resume: the goal check runs again, with no question, under the same number.
    assert.equal(await D.say(s, '/resume AbortGoal'), 'AbortGoal, goal check: the auditor checks GOAL.md again (goal check 1).');
    await D.tickUntil(s, () => D.said(s, /^AbortGoal, round 1 of 3: GOAL\.md is clear\. The builder started/), 'round 1 to start');
    assert.equal(fs.existsSync(D.audit(goal, 'goal-check-01-verdict.json')), true);
    assert.equal(fs.existsSync(D.audit(goal, 'goal-check-02-verdict.json')), false);
    await D.say(s, '/stop');
    await D.tickUntil(s, () => s.state().loop === null, 'the resumed loop to end');

    const audited = D.newProject(s, 'AbortAudit');
    s.script({ auditor: ['continue', 'hang', 'done'], builder: ['ok'] });
    const auditorCalls = D.callsOfKind(s, 'auditor');
    await D.startLoop(s, 'AbortAudit');
    await D.tickUntil(s, () => D.jobIsUp(s, audited, 'auditor', auditorCalls + 1), 'the auditor to run');
    pids = D.jobPids(s, audited, 'auditor');
    await abortNow(s);
    end = D.endMessage(s).split('\n');
    assert.equal(end[0], 'AbortAudit: the loop ended. Aborted by you: the auditor of round 1 was ended at once.');
    assert.deepEqual(await D.waitGone(pids), []);
    assert.equal(D.isAlive(bystander.pid), true);
    assert.deepEqual(D.git(audited, 'log', '--format=%s').split('\n'), ['Loop: round 1', 'Loop: GOAL.md'], 'the round was committed before its audit, and stays so');
    assert.deepEqual(D.loopState(audited).end.resume, { how: 'auditor', round: 1, step: 'auditor' });
    // /resume: the audit runs again, with no question.
    const commit = D.git(audited, 'rev-parse', '--short', 'HEAD');
    await D.say(s, '/resume AbortAudit');
    assert.deepEqual(D.texts(s).slice(-2), [
      'AbortAudit: resuming. It had ended: Aborted by you: the auditor of round 1 was ended at once.',
      `AbortAudit, round 1 of 3: the auditor runs on the round (commit ${commit}).`,
    ]);
    await D.tickUntil(s, () => /DONE after round 1/.test(D.endMessage(s) || ''), 'the end of the loop');
    assert.equal(JSON.parse(D.readAudit(audited, 'round-01-verdict.json')).verdict, 'DONE');
  });

  test('a process ID that another process took over is never killed: /abort goes by the ID and by when the process started', async (t) => {
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    t.after(() => other.kill());
    await D.sleep(300);
    // A job that says it started an hour ago under this ID: the process there now is younger, so it is another one.
    const stale = killJobProcesses([{ pid: other.pid, startedAt: new Date(Date.now() - HOUR).toISOString(), what: 'a job of an hour ago' }]);
    assert.deepEqual(stale.killed, []);
    assert.equal(stale.skipped.length, 1);
    assert.match(stale.skipped[0].why, /^another process has this ID now \(node\.exe\), and it was left alone$/);
    assert.equal(D.isAlive(other.pid), true);
    // An ID that nobody has, and a record without a time.
    assert.deepEqual(killJobProcesses([{ pid: 4999999, startedAt: new Date().toISOString(), what: 'nobody' }]).skipped.map((item) => item.why), ['it had ended already']);
    assert.deepEqual(killJobProcesses([{ pid: other.pid, startedAt: null, what: 'no time' }]).killed, []);
    assert.equal(D.isAlive(other.pid), true);
    // The same ID with the time it really started: that is the job's own process.
    const own = killJobProcesses([{ pid: other.pid, startedAt: new Date().toISOString(), what: 'the job' }]);
    assert.deepEqual(own.killed, [{ pid: other.pid, what: 'the job' }]);
    assert.deepEqual(await D.waitGone([other.pid]), []);
  });

  // ---- 4. the stuck alert ----

  test('the stuck alert: once at the limit, once at twice the limit, and never for a step that ended', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Stuck');
    s.script({ auditor: ['continue'], builder: ['hang'] });
    await D.startLoop(s, 'Stuck');
    await D.tickUntil(s, () => D.jobIsUp(s, project, 'builder'), 'the builder to run');
    const alerts = () => D.texts(s).filter((text) => /has been running for/.test(text));

    await s.tickAt(59 * MIN);
    assert.equal(alerts().length, 0, 'not before the limit');
    await s.tickAt(61 * MIN);
    assert.equal(alerts().length, 1);
    const first = alerts()[0].split('\n');
    assert.equal(first[0], 'Stuck, round 1 of 3: the builder has been running for 61 min. That is over the limit of 60 min for an alert.');
    assert.match(first[1], /^The last line of its log: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d Write .*hello\.js$/);
    assert.equal(first[2], '/log shows more. /abort ends it at once, after a Confirm. It is not cut off by itself.');
    await s.tickAt(62 * MIN);
    await s.tickAt(119 * MIN);
    assert.equal(alerts().length, 1, 'one alert for the limit');
    await s.tickAt(121 * MIN);
    assert.equal(alerts().length, 2);
    assert.equal(alerts()[1].split('\n')[0], 'Stuck, round 1 of 3: the builder has been running for 2 h 1 min. That is twice the limit of 60 min for an alert.');
    assert.match(alerts()[1], /It is not cut off by itself\. This is the last alert for this step\.$/);
    await s.tickAt(10 * HOUR);
    assert.equal(alerts().length, 2, 'and no third one');
    assert.equal(D.loopState(project).job.alerts, 2);
    assert.equal(D.loopState(project).step, 'builder', 'the step is not cut off');
    assert.deepEqual(D.jobPids(s, project, 'builder').filter((pid) => !D.isAlive(pid)), []);
    assert.ok(D.loopLog(project).includes('round 1: stuck alert 1 of 2: the builder has run for 61 min (the limit is 60 min)'));
    await abortNow(s);

    // The limits are config keys, one per kind of step: 10 minutes for a goal check.
    const goal = D.newProject(s, 'StuckGoal');
    s.script({ auditor: ['hang'] });
    await D.startLoop(s, 'StuckGoal');
    await D.tickUntil(s, () => D.jobIsUp(s, goal, 'goal-check', 1), 'the goal check to run');
    await s.tickAt(9 * MIN);
    assert.equal(alerts().length, 2);
    await s.tickAt(11 * MIN);
    assert.match(alerts()[2], /^StuckGoal, goal check: the goal check has been running for 11 min\. That is over the limit of 10 min for an alert\.\nThe last line of its log: \[run_auditor\] starting /);
    await abortNow(s);

    // 20 minutes for the auditor, and a limit from the config.
    const audited = D.newProject(s, 'StuckAudit');
    s.script({ auditor: ['continue', 'hang'], builder: ['ok'] });
    await D.startLoop(s, 'StuckAudit');
    await D.tickUntil(s, () => D.jobIsUp(s, audited, 'auditor', 3), 'the auditor to run');
    await s.tickAt(19 * MIN);
    assert.equal(alerts().length, 3);
    await s.tickAt(19 * MIN, { config: { stuckAuditorMinutes: 15 } });
    assert.match(alerts()[3], /^StuckAudit, round 1 of 3: the auditor has been running for 19 min\. That is over the limit of 15 min for an alert\./);
    await abortNow(s);

    // A step that ended is never reported: here the loop waits at a proposal for ten hours.
    const quick = D.newProject(s, 'Quick');
    s.script({ auditor: ['continue', 'continue'], builder: ['ok'] });
    await D.startLoop(s, 'Quick');
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal');
    await s.tickAt(10 * HOUR);
    assert.equal(alerts().length, 4, 'no alert for a step that ended');
    await D.say(s, '/stop');
  });

  // ---- 5. the usage limit ----

  test('the usage limit in a goal check and in an audit: the loop pauses, says when the limit resets, and goes on by itself two minutes after; /resume goes on at once', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Limit');
    s.script({ auditor: [{ reply: 'limit', resetInS: 3600 }, 'continue', { reply: 'limit', resetInS: 1800 }, 'continue'], builder: ['ok'] });
    const started = Date.now();
    await D.startLoop(s, 'Limit');
    await D.tickUntil(s, () => D.loopState(project).step === 'paused', 'the pause');
    let pause = D.loopState(project).pause;
    const reset = Date.parse(pause.resetsAt);
    assert.ok(Math.abs(reset - (started + 3600 * 1000)) < MIN, 'the reset time is the one in the rate_limit_event');
    assert.equal(Date.parse(pause.resumeAt), reset + 2 * MIN, 'two minutes after the reset');
    assert.deepEqual(pause.next, { how: 'goal-check' });
    assert.deepEqual(D.texts(s).pop().split('\n'), [
      'Limit, goal check: paused. The goal check hit the plan\'s usage limit ("You\'ve hit your session limit · resets 3:45pm").',
      `The limit resets at ${when(reset)} (this PC's time). The loop goes on by itself at ${when(reset + 2 * MIN)}: the goal check runs again.`,
      '/resume Limit goes on at once (and may hit the limit again). /stop ends the loop.',
    ]);
    assert.equal(fs.existsSync(D.audit(project, 'goal-check-01-verdict.json')), false, 'a refused call leaves no record');
    assert.equal((await D.say(s, '/status')).split('\n')[1], `Step: paused until ${when(reset + 2 * MIN)}: the goal check hit the plan's usage limit`);
    assert.ok(D.loopLog(project).some((line) => /^the goal check hit the plan's usage limit \(You've hit your session limit · resets 3:45pm\): paused, resets at .*, going on at /.test(line)));

    // Not before the reset time plus two minutes.
    const offset = reset + 2 * MIN - Date.now();
    await s.tickAt(offset - 30 * 1000);
    assert.equal(D.loopState(project).step, 'paused');
    assert.equal(s.calls().length, 1);
    let before = s.fake.sent.length;
    await s.tickAt(offset + 5000);
    assert.deepEqual(textsSince(s, before), [
      'Limit, goal check: the usage limit has reset, so the loop goes on by itself. The goal check runs again.',
      'Limit, goal check: the auditor checks GOAL.md again (goal check 1).',
    ]);

    // The goal check passes, round 1 runs, and its audit hits the limit.
    await D.tickUntil(s, () => D.loopState(project).step === 'paused', 'the second pause');
    pause = D.loopState(project).pause;
    const commit = D.git(project, 'rev-parse', '--short', 'HEAD');
    assert.equal(D.git(project, 'log', '--format=%s').split('\n')[0], 'Loop: round 1', 'the round was committed before its audit');
    assert.deepEqual(pause.next, { how: 'auditor', round: 1, step: 'auditor' });
    assert.equal(D.texts(s).pop().split('\n')[0], 'Limit, round 1 of 3: paused. The auditor hit the plan\'s usage limit ("You\'ve hit your session limit · resets 3:45pm").');
    assert.match(D.texts(s).pop().split('\n')[1], /: the auditor runs again\.$/);
    assert.equal(fs.existsSync(D.audit(project, 'round-01-verdict.json')), false);

    // /resume during the pause goes on at once.
    before = s.fake.sent.length;
    await D.say(s, '/resume limit');
    assert.deepEqual(textsSince(s, before), [
      'Limit, round 1 of 3: going on now, as you asked. The auditor runs again.',
      `Limit, round 1 of 3: the auditor runs on the round (commit ${commit}).`,
    ]);
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal');
    assert.deepEqual(callsOf(s), ['auditor:goal-check:0:limit', 'auditor:goal-check:0:continue', 'builder:ok', 'auditor:round:1:limit', 'auditor:round:1:continue']);
    assert.equal(D.loopState(project).pause, null);
    await D.say(s, '/stop');
  });

  test('the usage limit: /stop during the pause ends the loop, an unknown reset time means a fixed wait, and a limit that does not lift is not hammered', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();

    const stopped = D.newProject(s, 'LimitStop');
    s.script({ auditor: [{ reply: 'limit', resetInS: 600 }, 'stop'] });
    await D.startLoop(s, 'LimitStop');
    await D.tickUntil(s, () => D.loopState(stopped).step === 'paused', 'the pause');
    await D.say(s, '/stop');
    assert.equal(D.endMessage(s), `LimitStop: the loop ended. Stopped at once by /stop, during the pause for the plan's usage limit. The goal check did not run again.\n${records(stopped)}`);
    assert.deepEqual(D.loopState(stopped).end.resume, { how: 'goal-check' });
    assert.equal(s.state().loop, null);
    await s.tickAt(HOUR);
    assert.equal(s.calls().length, 1, 'a loop that was stopped does not go on by itself');
    // It can be resumed later.
    assert.equal(await D.say(s, '/resume LimitStop'), 'LimitStop, goal check: the auditor checks GOAL.md again (goal check 1).');
    await D.tickUntil(s, () => s.state().loop === null, 'the end of the loop');

    // No reset time at all: the bot says so and tries again after usageLimitFallbackMinutes.
    const unknown = D.newProject(s, 'LimitUnknown');
    s.script({ auditor: [{ reply: 'limit', resetInS: 'none' }, 'stop'] });
    await D.startLoop(s, 'LimitUnknown');
    await D.tickUntil(s, () => D.loopState(unknown).step === 'paused', 'the pause');
    let pause = D.loopState(unknown).pause;
    assert.equal(pause.resetsAt, null);
    assert.ok(Math.abs(Date.parse(pause.resumeAt) - Date.parse(pause.hitAt) - 30 * MIN) < 2000);
    assert.equal(D.texts(s).pop().split('\n')[1], `When the limit resets is not known, so I try again in 30 minutes. The loop goes on by itself at ${when(Date.parse(pause.resumeAt))}: the goal check runs again.`);
    await s.tickAt(29 * MIN);
    assert.equal(D.loopState(unknown).step, 'paused');
    await s.tickAt(31 * MIN);
    await D.tickUntil(s, () => s.state().loop === null, 'the end of the loop');

    // A reset time that has passed and did not help: the second pause is the fixed wait.
    const again = D.newProject(s, 'LimitAgain');
    s.script({ auditor: [{ reply: 'limit', resetInS: -120 }, { reply: 'limit', resetInS: -120 }, 'stop'] });
    await D.startLoop(s, 'LimitAgain');
    await D.tickUntil(s, () => D.loopState(again).step === 'paused', 'the pause');
    pause = D.loopState(again).pause;
    assert.ok(Math.abs(Date.parse(pause.resumeAt) - Date.parse(pause.hitAt) - 2 * MIN) < 2000, 'a reset time in the past: two minutes from now');
    await s.tickAt(2 * MIN + 5000);
    await D.tickUntil(s, () => D.loopState(again).step === 'paused' && D.loopState(again).limitHits === 2, 'the second pause');
    pause = D.loopState(again).pause;
    assert.ok(Math.abs(Date.parse(pause.resumeAt) - Date.parse(pause.hitAt) - 30 * MIN) < 2000, 'the second time in a row: 30 minutes');
    await D.say(s, '/stop');
  });

  test('the usage limit in the middle of a builder round: a round that changed nothing runs again by itself, one that changed files asks with the three buttons', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();

    const clean = D.newProject(s, 'LimitClean');
    s.script({ auditor: ['continue', 'done'], builder: [{ mode: 'usage_limit', resetInS: 600 }, 'ok'] });
    await D.startLoop(s, 'LimitClean');
    await D.tickUntil(s, () => D.loopState(clean).step === 'paused', 'the pause');
    let pause = D.loopState(clean).pause;
    assert.deepEqual(pause.next, { how: 'builder-rerun', round: 1 });
    assert.equal(D.texts(s).pop().split('\n')[0], 'LimitClean, round 1 of 3: paused. The builder hit the plan\'s usage limit ("You\'ve hit your session limit · resets 3:45pm").');
    const summary = D.readJson(D.audit(clean, 'round-01-builder.json'));
    assert.equal(summary.status, 'usage_limit');
    assert.equal(summary.resets_at, pause.resetsAt);
    assert.equal(summary.exit_code, 1);
    assert.equal(D.git(clean, 'status', '--porcelain'), '', 'the round changed nothing');
    assert.equal(D.git(clean, 'log', '--format=%s'), 'Loop: GOAL.md');

    const before = s.fake.sent.length;
    await s.tickAt(Date.parse(pause.resumeAt) - Date.now() + 5000);
    assert.deepEqual(textsSince(s, before), [
      'LimitClean, round 1 of 3: the usage limit has reset, so the loop goes on by itself. The builder runs again.',
      'LimitClean, round 1 of 3: the builder runs the round again with the same prompt.\nThere was nothing to put aside: the working tree was clean.\n'
        + 'The old builder records are kept as .audit\\round-01-builder-attempt-1.*',
    ]);
    assert.deepEqual(fs.readdirSync(path.join(clean, '.audit')).filter((name) => name.includes('attempt')).sort(), [
      'round-01-builder-attempt-1-input.md', 'round-01-builder-attempt-1.json', 'round-01-builder-attempt-1.json.bak',
      'round-01-builder-attempt-1.jsonl', 'round-01-builder-attempt-1.log',
    ]);
    assert.equal(D.readJson(D.audit(clean, 'round-01-builder-attempt-1.json')).status, 'usage_limit');
    assert.deepEqual(stashList(clean), [], 'nothing was there to put aside');
    await D.tickUntil(s, () => /DONE after round 1/.test(D.endMessage(s) || ''), 'the end of the loop');
    const builds = s.calls().filter((call) => call.kind === 'builder');
    assert.equal(builds.length, 2);
    assert.equal(builds[1].stdin, builds[0].stdin, 'the same prompt');
    assert.deepEqual(D.loopState(clean).rounds[1].attempts, [{ attempt: 1, status: 'usage_limit', cost_usd: 0, stash: null }]);
    assert.match(D.reports(s).pop().content, /^Round 1, attempt 1, which was cut off and done again: stopped by the usage limit, \$0\.0000\. Its records: round-01-builder-attempt-1\.\*\.$/m);

    // A builder that had changed files: the loop asks, and does not go on by itself.
    const dirty = D.newProject(s, 'LimitDirty');
    s.script({ auditor: ['continue', 'continue'], builder: [{ mode: 'usage_limit_dirty', resetInS: 600 }] });
    const auditorCalls = D.callsOfKind(s, 'auditor');
    await D.startLoop(s, 'LimitDirty');
    await D.tickUntil(s, () => D.loopState(dirty).step === 'choice', 'the three buttons');
    const asked = D.choiceMessage(s);
    const lines = asked.text.split('\n');
    assert.match(lines[0], /^LimitDirty, round 1 of 3: the builder hit the plan's usage limit\. It resets at \d\d:\d\d \(this PC's time\)\. A choice you make before then can hit the limit again\.$/);
    assert.deepEqual(lines.slice(1, 5), [
      'LimitDirty, round 1 of 3: the builder was cut off (the plan\'s usage limit stopped it in the middle of its round). Nothing was committed.',
      'What the round left (git status --short):',
      '?? hello.js',
      '?? work.log',
    ]);
    await s.tickAt(HOUR);
    assert.equal(D.loopState(dirty).step, 'choice', 'it waits for the owner');
    assert.equal(D.git(dirty, 'log', '--format=%s'), 'Loop: GOAL.md');

    // Keep and audit: committed as cut off, and the auditor is told.
    D.press(s, asked, 'Keep and audit');
    await s.tick();
    const commit = D.git(dirty, 'rev-parse', '--short', 'HEAD');
    assert.equal(D.git(dirty, 'log', '--format=%s').split('\n')[0], 'Loop: round 1 (cut off)');
    assert.equal(D.buttonAnswers(s).pop(), 'Kept');
    assert.equal(D.texts(s).pop(), `LimitDirty, round 1 of 3: kept. Committed as ${commit} "Loop: round 1 (cut off)". The auditor is checking the round: `
      + 'it is told that the builder was cut off and that HANDOFF.md may be old or missing.');
    await D.tickUntil(s, () => D.callsOfKind(s, 'auditor') > auditorCalls + 1 && D.proposalMessage(s) && /LimitDirty/.test(D.proposalMessage(s).text), 'the proposal');
    const material = s.calls().filter((call) => call.kind === 'auditor').pop().stdin;
    assert.match(material, /^Status: stopped by the plan's usage limit, before it was done$/m);
    assert.match(material, /^CUT OFF: the builder was cut off before it finished \(the plan's usage limit stopped it\)\. The owner chose to keep what was there and to have it audited\. HANDOFF\.md may be old or missing\.$/m);
    assert.match(material, /^HANDOFF\.md: there is none\. The builder was cut off before it wrote one\.$/m);
    const round = D.lastText(s, /^LimitDirty, round 1 of 3: audited\./).split('\n');
    assert.ok(round.includes('Builder: stopped by the usage limit, 1 turn, $0.0000, context peak 2.5%, not compacted, 0 denied calls'));
    assert.ok(round.includes(`Commit: ${commit} "Loop: round 1 (cut off)"`));
    await D.say(s, '/stop');
  });

  // ---- 6. /resume ----

  test('/resume after a builder was cut off: Stop changes nothing, and Redo the round puts the partial work in git stash and runs the round again', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Redo');
    s.script({ auditor: ['continue', 'done'], builder: ['hang', 'ok'] });
    await D.startLoop(s, 'Redo');
    await D.tickUntil(s, () => D.jobIsUp(s, project, 'builder'), 'the builder to run');
    assert.match(await D.say(s, '/resume Redo'), /^Redo, round 1 of 3 is running: builder running since \d\d:\d\d:\d\d\. There is nothing to resume\.$/, 'a loop that runs cannot be resumed');
    await abortNow(s);

    let before = s.fake.sent.length;
    await D.say(s, '/resume redo');
    assert.equal(textsSince(s, before)[0], 'Redo: resuming. It had ended: Aborted by you: the builder of round 1 was ended at once.');
    const first = D.choiceMessage(s);
    assert.equal(first.text, [
      'Redo, round 1 of 3: the builder was cut off (you ended it with /abort). Nothing was committed.',
      'What the round left (git status --short):',
      '?? hello.js',
      '?? work.log',
      'Redo the round: the partial work is put aside with git stash (never deleted), and the builder runs again with the same prompt.',
      'Keep and audit: what is there is committed as "Loop: round 1 (cut off)" and audited.',
      'Stop: the loop ends, and nothing changes.',
    ].join('\n'));
    assert.equal(s.state().loop.name, 'Redo');
    assert.deepEqual(D.loopState(project).ends.map((end) => end.why), ['Aborted by you: the builder of round 1 was ended at once.']);

    // Stop: the loop ends again, and nothing changes.
    D.press(s, first, 'Stop');
    await s.tick();
    assert.equal(D.endMessage(s), `Redo: the loop ended. Stopped by you, after the builder of round 1 was cut off.\nNothing was changed: what the round left is still in the folder, uncommitted.\n${records(project)}`);
    assert.equal(D.git(project, 'status', '--porcelain'), '?? hello.js\n?? work.log');
    assert.deepEqual(stashList(project), []);

    // /resume again: the buttons come back, and the old ones have expired.
    await D.say(s, '/resume Redo');
    const second = D.choiceMessage(s);
    assert.notEqual(D.button(second, 'Redo').callback_data, D.button(first, 'Redo').callback_data);
    D.press(s, first, 'Redo the round');
    await s.tick();
    assert.equal(D.buttonAnswers(s).pop(), 'This button has expired.');

    // Redo the round.
    const workLog = fs.readFileSync(path.join(project, 'work.log'), 'utf8');
    D.press(s, second, 'Redo the round');
    await s.tick();
    assert.equal(D.buttonAnswers(s).pop(), 'Redo');
    assert.equal(D.texts(s).pop(), [
      'Redo, round 1 of 3: the round runs again with the same prompt (.audit\\round-01-prompt.md).',
      'The partial work was put aside, not deleted: "git stash list" shows it as "Loop: round 1, cut off", and "git stash pop" brings it back.',
      'The old builder records are kept as .audit\\round-01-builder-attempt-1.*',
    ].join('\n'));
    const stashes = stashList(project);
    assert.equal(stashes.length, 1);
    assert.match(stashes[0], /^stash@\{0\}: On \S+: Loop: round 1, cut off$/);
    // Nothing is lost: the stash holds both files, as they were.
    assert.deepEqual(D.git(project, 'show', '--name-only', '--format=', 'stash@{0}^3').split('\n').sort(), ['hello.js', 'work.log']);
    assert.equal(D.git(project, 'show', 'stash@{0}^3:work.log'), workLog.trim());
    assert.equal(D.readJson(D.audit(project, 'round-01-builder-attempt-1.json')).status, 'aborted');
    assert.equal(fs.existsSync(D.audit(project, 'round-01-builder-attempt-1.log')), true);

    await D.tickUntil(s, () => /DONE after round 1/.test(D.endMessage(s) || ''), 'the end of the loop');
    const builds = s.calls().filter((call) => call.kind === 'builder');
    assert.equal(builds[1].stdin, builds[0].stdin, 'the same prompt');
    assert.deepEqual(D.loopState(project).rounds[1].attempts, [{ attempt: 1, status: 'aborted', cost_usd: null, stash: 'Loop: round 1, cut off' }]);
    assert.deepEqual(D.git(project, 'log', '--format=%s').split('\n'), ['Loop: round 1', 'Loop: GOAL.md']);
    assert.equal(stashList(project).length, 1, 'the stash is still there at the end: it is never deleted');
    assert.equal(D.git(project, 'status', '--porcelain'), '');
    // A loop that is resumed and ends again writes its report again.
    const reports = D.reports(s);
    assert.equal(reports.length, 3, 'one per end');
    const report = reports.pop().content;
    assert.equal(report, D.readAudit(project, 'LOOP_REPORT.md'));
    assert.match(report, /^- How it ended: DONE after round 1 of 3\.$/m);
    assert.match(report, /^- It ended and was resumed 2 times before:$/m);
    assert.match(report, /^Round 1, attempt 1, which was cut off and done again: cut off by \/abort, cost not known\. Its records: round-01-builder-attempt-1\.\*\. Its work was put aside: git stash list shows "Loop: round 1, cut off"\.$/m);
    assert.doesNotMatch(report, /\bunknown\b/, 'no bare "unknown" stands for a cost');
    assert.equal(await D.say(s, '/resume Redo'), '/resume was refused: Redo\'s loop is finished: DONE after round 1 of 3. There is nothing to continue.');
  });

  test('/resume: a stopped proposal comes back with its notes, Approve raises the round cap, and after STOP_FOR_HUMAN the owner writes the next prompt and the audit covers his own commits', async (t) => {
    const s = await botSandbox(t, { config: { roundCap: 2 } });
    await s.firstTick();
    const project = D.newProject(s, 'Back');
    s.script({ auditor: ['continue', 'continue', 'continue', 'stop', 'done'], builder: ['ok', 'ok', 'ok', 'ok'] });
    await D.startLoop(s, 'Back');
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal');

    // A note, then Stop.
    D.press(s, D.proposalMessage(s), 'Edit');
    s.fake.message(s.owner, 'KEEP_THIS_NOTE');
    await s.tick();
    const stoppedAt = D.proposalMessage(s);
    D.press(s, stoppedAt, 'Stop');
    await s.tick();
    assert.deepEqual(D.loopState(project).end.resume, { how: 'proposal', round: 2 });

    // /resume: the proposal is back, with the note and with new buttons.
    let before = s.fake.sent.length;
    await D.say(s, '/resume Back');
    assert.deepEqual(s.fake.sent.slice(before).map((m) => m.method), ['sendMessage', 'sendMessage', 'sendDocument', 'sendMessage']);
    assert.deepEqual(textsSince(s, before), [
      'Back: resuming. It had ended: Stopped by you at the prompt for round 2.',
      'Back, round 2 of 2: the proposed prompt is back.',
      'Back, round 2 of 2: start the builder with this prompt?',
    ]);
    assert.match(D.documents(s).pop().content, /^## Note from the owner[^\n]*\n\nKEEP_THIS_NOTE\n/);
    D.press(s, stoppedAt, 'Approve');
    await s.tick();
    assert.equal(D.buttonAnswers(s).pop(), 'This button has expired.');
    D.press(s, D.proposalMessage(s), 'Approve');
    await s.tick();
    assert.match(D.readAudit(project, 'round-02-prompt.md'), /KEEP_THIS_NOTE/);

    // Round 2 of 2 ends with CONTINUE: the cap ends the loop.
    await D.tickUntil(s, () => /The round cap is reached/.test(D.endMessage(s) || ''), 'the cap');
    assert.ok(D.endMessage(s).split('\n').includes('/resume Back brings it back with Approve, Edit and Stop: Approve raises the cap by one round.'));
    assert.deepEqual(D.loopState(project).end.resume, { how: 'proposal', round: 3 });
    before = s.fake.sent.length;
    await D.say(s, '/resume Back');
    assert.equal(textsSince(s, before)[1], 'Back, round 3 of 2: the proposed prompt is back. The round cap is 2: Approve raises it to 3.');
    assert.match(D.documents(s).pop().content, /^AUDITOR_PROMPT_MARKER for round 3\n/);
    D.press(s, D.proposalMessage(s), 'Approve');
    await s.tick();
    assert.equal(D.texts(s).pop(), 'Back, round 3 of 3: approved. The builder started with .audit\\round-03-prompt.md.\nThe round cap is now 3.');
    assert.equal(D.loopState(project).cap, 3);

    // Round 3: the auditor says STOP_FOR_HUMAN.
    await D.tickUntil(s, () => /STOP_FOR_HUMAN after round 3 of 3/.test(D.endMessage(s) || ''), 'STOP_FOR_HUMAN');
    assert.deepEqual(D.loopState(project).end.resume, { how: 'new-prompt', round: 4 });
    const head3 = D.git(project, 'rev-parse', 'HEAD');

    // The owner fixes something by hand. With the change uncommitted, /resume is refused.
    fs.writeFileSync(path.join(project, 'fix.txt'), 'OWNER_FIX_MARKER\n');
    assert.equal(await D.say(s, '/resume Back'), '/resume was refused: Back: its working tree is not clean. Commit or remove these first (git status --porcelain):\n?? fix.txt');
    assert.equal(s.state().loop, null);
    D.git(project, 'add', 'fix.txt');
    D.git(project, 'commit', '-q', '-m', 'the owner\'s own fix');

    // Now the bot shows the reason and asks for the next round's prompt.
    before = s.fake.sent.length;
    await D.say(s, '/resume Back');
    assert.deepEqual(textsSince(s, before), [
      'Back: resuming. It had ended: The auditor says STOP_FOR_HUMAN after round 3 of 3.',
      [
        'The auditor stopped after round 3: The same problem failed twice in a row.',
        'What it asked of you: STOP_NOTE_MARKER decide whether to fix hello.js by hand.',
        'Back, round 4 of 3: send the prompt for round 4, as a text message, or as a .md or .txt file (up to 100 KB).',
        'I show it to you with Approve, Edit and Stop before anything starts. /cancel ends the loop again; nothing changes.',
      ].join('\n'),
    ]);
    assert.equal(D.loopState(project).step, 'prompt-wait');
    assert.equal((await D.say(s, '/status')).split('\n')[1], 'Step: waiting for you: your prompt for round 4');
    // A file of the wrong kind is refused, with the same rules as for /new.
    s.fake.document(s.owner, 'prompt.pdf', 'x');
    await s.tick();
    assert.match(D.texts(s).pop(), /^Back, round 4 of 3: That file is not a \.md or \.txt file\.\nSend the prompt as a text message, or as a \.md or \.txt file \(up to 100 KB\), or \/cancel\.$/);
    before = s.fake.sent.length;
    await D.say(s, 'OWNER_PROMPT_MARKER fix hello.js.');
    assert.deepEqual(s.fake.sent.slice(before).map((m) => m.method), ['sendMessage', 'sendDocument', 'sendMessage']);
    assert.equal(textsSince(s, before)[0], 'Back, round 4 of 3: your prompt is saved (34 bytes).\n'
      + 'Note: it does not ask for HANDOFF.md. The fixed preface in front of every prompt still does.\nThe round cap is 3: Approve raises it to 4.');
    assert.equal(D.documents(s).pop().content, 'OWNER_PROMPT_MARKER fix hello.js.\n');
    assert.equal(D.readAudit(project, 'round-04-prompt-owner.md'), 'OWNER_PROMPT_MARKER fix hello.js.\n');
    D.press(s, D.proposalMessage(s), 'Approve');
    await D.tickUntil(s, () => /DONE after round 4 of 4/.test(D.endMessage(s) || ''), 'the end of the loop');

    // The audit of round 4 covers everything since the last commit that was audited:
    // the owner's own commit and the round's, not only HEAD~1.
    const material = s.calls().filter((call) => call.kind === 'auditor').pop().stdin;
    const head4 = D.git(project, 'rev-parse', 'HEAD');
    assert.ok(material.includes(`Diff range: ${head3} (${head3}) to ${head4} (HEAD)`), 'the base is the head of the last audit');
    assert.match(material, /diff --git a\/fix\.txt b\/fix\.txt/);
    assert.match(material, /\+OWNER_FIX_MARKER/);
    assert.deepEqual(D.git(project, 'log', '--format=%s').split('\n'), ['Loop: round 4', 'the owner\'s own fix', 'Loop: round 3', 'Loop: round 2', 'Loop: round 1', 'Loop: GOAL.md']);
    assert.match(s.calls().filter((call) => call.kind === 'builder').pop().stdin, /\n---\n\nOWNER_PROMPT_MARKER fix hello\.js\.\n$/);

    // The report of a loop that was resumed three times.
    const report = D.readAudit(project, 'LOOP_REPORT.md');
    assert.match(report, /^- It ended and was resumed 3 times before:$/m);
    assert.match(report, /^- Round 2, note: KEEP_THIS_NOTE$/m);
    assert.match(report, /^- Round 4: the prompt was the owner's own, sent after \/resume\.$/m);
    assert.match(report, /^- Rounds: 4 of 4$/m);
    assert.equal(report.split('\n').filter((line) => /^\| \d \| /.test(line)).length, 4, 'one row per round');
    assert.equal(await D.say(s, '/resume Back'), '/resume was refused: Back\'s loop is finished: DONE after round 4 of 4. There is nothing to continue.');
  });

  test('/resume: what cannot be resumed, /cancel at the prompt, and a loop that the bot lost track of', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    assert.equal(await D.say(s, '/resume'), 'A project needs a name.\nUse it like this: /resume My_Project');
    assert.equal(await D.say(s, '/resume Nowhere'), `/resume was refused: there is no project named Nowhere in ${s.projectsRoot}.`);
    const fresh = D.newProject(s, 'Fresh');
    assert.equal(await D.say(s, '/resume Fresh'), '/resume was refused: Fresh has no loop to continue (.audit\\loop.json is not there). Start one with /loop Fresh.');
    assert.equal(fs.existsSync(D.audit(fresh, 'loop.json')), false);

    // STOP_FOR_HUMAN, /resume, then /cancel: the loop ends again and can be resumed again.
    const project = D.newProject(s, 'Lost');
    s.script({ auditor: ['continue', 'stop', 'continue'], builder: ['ok', { mode: 'ok', delayMs: 6000 }] });
    await D.startLoop(s, 'Lost');
    await D.tickUntil(s, () => D.endMessage(s), 'STOP_FOR_HUMAN');
    // While another loop runs, nothing else is resumed.
    await D.say(s, '/resume Lost');
    assert.equal(await D.say(s, '/resume Fresh'), '/resume was refused: another loop is running: Lost, round 1 of 3 (waiting for your prompt for round 2). One loop at a time; /stop ends it.');
    await D.say(s, '/cancel');
    assert.equal(D.endMessage(s), `Lost: the loop ended. No prompt for round 2 was sent (/cancel), so the loop ended again. Nothing changed.\n${records(project)}`);
    assert.deepEqual(D.loopState(project).end.resume, { how: 'new-prompt', round: 2 });

    // The prompt as a file, then the loop waits at the proposal.
    await D.say(s, '/resume Lost');
    s.fake.document(s.owner, 'next.md', 'FILE_PROMPT_MARKER\nThen write HANDOFF.md.\n');
    await s.tick();
    assert.equal(D.lastText(s, /your prompt is saved/), 'Lost, round 2 of 3: your prompt is saved (42 bytes).');
    const proposal = D.proposalMessage(s);

    // runtime\state.json and its backup are lost: the bot starts again and knows of no loop.
    fs.rmSync(s.stateFile);
    fs.rmSync(`${s.stateFile}.bak`, { force: true });
    await s.tick();
    assert.equal(s.state().loop, null);
    assert.equal(await D.say(s, '/status').then((text) => text.split('\n')[0]), 'No loop is running.');
    // /resume works from the project's .audit\loop.json: the loop is picked up where it stands.
    let before = s.fake.sent.length;
    await D.say(s, '/resume Lost');
    assert.equal(textsSince(s, before)[0], 'Lost: this loop never ended, but the bot had lost track of it. It is picked up where it stands.');
    assert.deepEqual(s.fake.sent.slice(before).map((m) => m.method), ['sendMessage', 'sendDocument', 'sendMessage']);
    assert.equal(s.state().loop.name, 'Lost');
    // The old buttons still belong to this proposal: nothing about it changed.
    D.press(s, proposal, 'Approve');
    await s.tick();
    assert.equal(D.texts(s).pop(), 'Lost, round 2 of 3: approved. The builder started with .audit\\round-02-prompt.md.');

    // Lost again, this time while the builder runs: it is picked up, and simply waited for.
    await D.tickUntil(s, () => D.jobIsUp(s, project, 'builder', 1), 'the builder to run');
    fs.rmSync(s.stateFile);
    fs.rmSync(`${s.stateFile}.bak`, { force: true });
    await s.tick();
    before = s.fake.sent.length;
    await D.say(s, '/resume Lost');
    assert.deepEqual(textsSince(s, before).map((text) => text.replace(/since \d\d:\d\d:\d\d/, 'since T')), [
      'Lost: this loop never ended, but the bot had lost track of it. It is picked up where it stands.',
      'Lost, round 2 of 3: builder running since T.',
    ]);
    await D.tickUntil(s, () => D.proposalMessage(s) && /round 3 of 3/.test(D.proposalMessage(s).text), 'the proposal for round 3');
    assert.deepEqual(D.git(project, 'log', '--format=%s').split('\n'), ['Loop: round 2', 'Loop: round 1', 'Loop: GOAL.md']);
    assert.ok(D.loopLog(project).some((line) => line === '---- /resume Lost: the bot had lost track of this loop; picked up again at step "builder" ----'));
    await D.say(s, '/stop');
  });

  // ---- 7. after the PC or n8n was down ----

  // Ends a job's processes the hard way, as a power cut would, and makes its record old.
  function loseJob(s, project, kind) {
    const job = D.loopState(project).job;
    const record = D.jobRecord(project);
    for (const pid of D.jobPids(s, project, kind)) {
      try {
        process.kill(pid);
      } catch {
        // gone already
      }
    }
    fs.writeFileSync(job.recordFile, JSON.stringify({ ...record, heartbeat_at: new Date(Date.now() - 10 * MIN).toISOString() }));
    return job;
  }
  const OFFLINE = (minutes) => new RegExp(`^The bot was offline from (\\d{4}-\\d\\d-\\d\\d )?\\d\\d:\\d\\d to (\\d{4}-\\d\\d-\\d\\d )?\\d\\d:\\d\\d \\(about ${minutes} min\\)\\.$`);

  test('after the bot was offline it says so by itself; a gap of three minutes or less is none, and a note of the last tick that cannot be read means "not known"', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    assert.equal(fs.existsSync(s.lastTickFile), true, 'the first tick writes down when it ran');
    assert.equal(D.texts(s).length, 0, 'and says nothing: there was no tick before it');
    await D.say(s, '/ping');

    // No tick for ten minutes.
    let before = s.fake.sent.length;
    const r = await s.tickAt(10 * MIN, { gap: true });
    assert.equal(r.stdout, 'ok: 1 sent\n');
    assert.equal(textsSince(s, before).length, 1);
    assert.match(textsSince(s, before)[0], OFFLINE(10));
    // Since Phase 5 prep the same tick also skips what waited through the gap: here nothing.
    const logged = s.logTexts().slice(-2);
    assert.match(logged[0], /^the bot was offline from \d{4}-\d\d-\d\dT[\d:.]+Z to \d{4}-\d\d-\d\dT[\d:.]+Z$/);
    assert.equal(logged[1], 'after the gap: skipped 0 updates that were waiting, 0 of them from the owner. None was acted on.');
    assert.ok(Math.abs(Date.parse(fs.readFileSync(s.lastTickFile, 'utf8').trim()) - (Date.now() + 10 * MIN)) < 5000, 'the note is written again');
    // The tick after it is quiet, and the note is written at most once a minute.
    const note = fs.readFileSync(s.lastTickFile, 'utf8');
    assert.equal((await s.tickAt(10 * MIN + 20 * 1000, { gap: true })).stdout, 'idle\n');
    assert.equal(fs.readFileSync(s.lastTickFile, 'utf8'), note, 'not written again within a minute');
    // Just under three minutes without a tick is not a gap.
    assert.equal((await s.tickAt(12 * MIN + 50 * 1000, { gap: true })).stdout, 'idle\n');
    assert.notEqual(fs.readFileSync(s.lastTickFile, 'utf8'), note);
    // Four minutes are.
    before = s.fake.sent.length;
    await s.tickAt(17 * MIN, { gap: true });
    assert.match(textsSince(s, before)[0], OFFLINE(4));
    s.fake.message(s.owner, '/status');
    await s.tickAt(17 * MIN + 5000);
    assert.match(D.texts(s).pop().split('\n').pop(), /^Bot last offline: (\S+ )?\d\d:\d\d to (\S+ )?\d\d:\d\d \(about 4 min\)\.$/);

    // A note that cannot be read: the bot still says that it was away, and that it does not know since when.
    fs.writeFileSync(s.lastTickFile, '\u0000\u0000\u0000');
    before = s.fake.sent.length;
    await s.tick();
    assert.match(textsSince(s, before)[0], /^The bot was offline until \d\d:\d\d\. Since when is not known: its note of the last tick \(runtime\\last-tick\.txt\) was missing or not readable\.$/);
    assert.match(await D.say(s, '/status'), /\nBot last offline: until \d\d:\d\d\. Since when is not known\.$/);
    assert.equal((await s.tick()).stdout, 'idle\n', 'it is said once');
    assert.equal(s.state().outbox.length, 0);
  });

  test('after a gap: a builder that is still alive is simply waited for, a builder that was lost gets the three buttons, and a lost audit or goal check runs again by itself', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();

    // The builder outlived the gap: the bot says where the loop stands, and waits.
    const alive = D.newProject(s, 'GapAlive');
    s.script({ auditor: ['continue', 'continue'], builder: [{ mode: 'ok', delayMs: 6000 }] });
    await D.startLoop(s, 'GapAlive');
    await D.tickUntil(s, () => D.jobIsUp(s, alive, 'builder'), 'the builder to run');
    let before = s.fake.sent.length;
    await s.tickAt(20 * MIN, { gap: true });
    let said = textsSince(s, before);
    assert.match(said[0], OFFLINE(20));
    assert.match(said[1], /^GapAlive, round 1 of 3: builder running since \d\d:\d\d:\d\d\.$/);
    assert.equal(said.length, 2);
    assert.equal(D.loopState(alive).step, 'builder');
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal');
    assert.equal(D.said(s, /ended without a result/), false, 'it was never taken for lost');
    assert.equal(JSON.parse(D.readAudit(alive, 'round-01-builder.json')).status, 'completed');
    await D.say(s, '/stop');

    // The builder died in the gap: the three buttons come by themselves, without /resume.
    const lost = D.newProject(s, 'GapLost');
    s.script({ auditor: ['continue'], builder: ['hang'] });
    await D.startLoop(s, 'GapLost');
    await D.tickUntil(s, () => D.jobIsUp(s, lost, 'builder', 1), 'the builder to run');
    const job = loseJob(s, lost, 'builder');
    before = s.fake.sent.length;
    await s.tickAt(30 * MIN, { gap: true });
    said = textsSince(s, before);
    assert.match(said[0], OFFLINE(30));
    assert.match(said[1], /^GapLost, round 1 of 3: builder running since /, 'where it stood');
    assert.deepEqual(said[2].split('\n').slice(0, 3), [
      'GapLost, round 1 of 3: the builder ended without a result: its process is gone and its record has no end.',
      `Its log: ${job.logFile}`,
      'GapLost, round 1 of 3: the builder was cut off (its process is gone and its record has no end, as after a restart of the PC). Nothing was committed.',
    ]);
    assert.equal(D.choiceMessage(s).text, said[2]);
    assert.equal(D.loopState(lost).step, 'choice');
    assert.equal(s.state().loop.name, 'GapLost', 'the loop is still the active one');
    D.press(s, D.choiceMessage(s), 'Stop');
    await s.tick();

    // An auditor that died in the gap: nothing was decided, so it runs again, with no question.
    const audited = D.newProject(s, 'GapAudit');
    s.script({ auditor: ['continue', 'hang', 'continue'], builder: ['ok'] });
    let auditorCalls = D.callsOfKind(s, 'auditor');
    await D.startLoop(s, 'GapAudit');
    await D.tickUntil(s, () => D.jobIsUp(s, audited, 'auditor', auditorCalls + 1), 'the auditor to run');
    loseJob(s, audited, 'auditor');
    before = s.fake.sent.length;
    await s.tickAt(40 * MIN, { gap: true });
    said = textsSince(s, before);
    assert.match(said[0], OFFLINE(40));
    assert.equal(said[2], 'GapAudit, round 1 of 3: the auditor ended without a result: its process is gone and its record has no end. Nothing was decided, so it runs again by itself.');
    assert.equal(said.length, 3);
    await D.tickUntil(s, () => D.proposalMessage(s) && /GapAudit/.test(D.proposalMessage(s).text), 'the proposal');
    assert.deepEqual(callsOf(s).slice(-3), ['builder:ok', 'auditor:round:1:hang', 'auditor:round:1:continue']);
    assert.equal(D.loopState(audited).lostRuns, 0, 'the count starts anew once an audit has ended');
    await D.say(s, '/stop');

    // The same for a goal check. One that dies every time ends the loop after three tries.
    const goal = D.newProject(s, 'GapGoal');
    s.script({ auditor: ['hang', 'hang', 'hang'] });
    auditorCalls = D.callsOfKind(s, 'auditor');
    await D.startLoop(s, 'GapGoal');
    for (let i = 1; i <= 3; i += 1) {
      await D.tickUntil(s, () => D.jobIsUp(s, goal, 'goal-check', auditorCalls + i - 1), `goal check ${i} to run`);
      loseJob(s, goal, 'goal-check');
      await s.tick();
    }
    assert.equal(D.texts(s).filter((text) => text === 'GapGoal, goal check: the goal check ended without a result: its process is gone and its record has no end. Nothing was decided, so it runs again by itself.').length, 2);
    assert.match(D.endMessage(s), /^GapGoal: the loop ended\. The goal check ended without a result 3 times in a row: its process is gone each time\.\nNothing was decided\.\n/);
    assert.deepEqual(D.loopState(goal).end.resume, { how: 'goal-check' });
    assert.equal(D.loopState(goal).goalChecks, 0, 'none of them left a record');
  });

  // ---- 8. reminders and default answers ----

  const TWO_DEFAULTS = [
    'VERDICT: ASK_HUMAN', 'REASON: Two small choices are open.', 'FINDINGS:', '- none', 'QUESTIONS:',
    '1. [DEFAULT] Which greeting?', '   options: hello | hi', '   recommended: hello',
    '2. [DEFAULT] End with a line break?', '   options: Yes | No', '   recommended: Yes',
    'NEXT_PROMPT:', 'Write hello.js once the choices are made.',
  ].join('\n');

  test('questions: a DEFAULT one is assumed after an hour and marked so, a MUST one is waited for with a reminder every three hours; a restart in between neither loses nor repeats a timer', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Rem');
    s.script({ auditor: ['ask', 'continue', 'continue'], builder: ['ok'] });
    await D.startLoop(s, 'Rem');
    await D.tickUntil(s, () => D.questionMessage(s, 2), 'the questions');
    const q1 = D.questionMessage(s, 1);
    const q2 = D.questionMessage(s, 2);
    const quiet = async (offset, what) => {
      const sent = s.fake.sent.length;
      const r = await s.tickAt(offset);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(s.fake.sent.length, sent, what);
    };

    // The DEFAULT question: after 60 minutes the recommended option is used.
    await quiet(59 * MIN, 'nothing before the hour is over');
    let before = s.fake.sent.length;
    await s.tickAt(61 * MIN);
    assert.deepEqual(textsSince(s, before), [[
      'Rem, goal check: no answer to question 2 [DEFAULT] within 60 minutes, so I used the recommended option: Yes',
      'It is marked (assumed) in .audit\\DECISIONS.md. You can change it later.',
      '1 question still open, tagged MUST: the loop waits for your answer.',
    ].join('\n')]);
    assert.equal(D.loopState(project).questions.items[1].answer.how, 'assumed');
    assert.equal(D.loopState(project).questions.items[0].answer, null, 'a MUST question is never assumed');
    assert.equal(fs.existsSync(D.audit(project, 'DECISIONS.md')), false, 'the round still waits for the MUST question');
    assert.equal(s.calls().length, 1, 'the auditor is not asked again yet');
    await quiet(62 * MIN, 'it is assumed once');
    D.press(s, q2, '2. No');
    await s.tickAt(63 * MIN);
    assert.equal(D.buttonAnswers(s).pop(), 'This button has expired.', 'the assumed question is closed');

    // The MUST question: a reminder every three hours, with its buttons again.
    await quiet(3 * HOUR - MIN, 'no reminder before three hours');
    before = s.fake.sent.length;
    await s.tickAt(3 * HOUR + MIN);
    assert.deepEqual(textsSince(s, before), ['Rem, goal check: a reminder. 1 question of the auditor is still open, and the loop waits for your answer.', q1.text]);
    assert.deepEqual(D.lastKeyboard(s).replyMarkup, q1.replyMarkup, 'the same buttons: the first ones still work too');
    await quiet(3 * HOUR + 2 * MIN, 'one reminder, not one per tick');

    // The bot is down from 3:02 to 7:30. One reminder fell into that time. When it is back
    // it says so and shows the open question: once, not once more as a reminder.
    before = s.fake.sent.length;
    await s.tickAt(7.5 * HOUR, { gap: true });
    let said = textsSince(s, before);
    assert.equal(said.length, 3);
    assert.match(said[0], OFFLINE(268));
    assert.deepEqual(said.slice(1), ['Rem, goal check: 1 question of the auditor is still open.', q1.text]);
    await quiet(7.5 * HOUR + MIN, 'the reminder is not sent on top of that');
    await quiet(10.5 * HOUR - MIN, 'the next one is three hours after the last time it was shown');
    before = s.fake.sent.length;
    await s.tickAt(10.5 * HOUR + MIN);
    assert.equal(textsSince(s, before)[0], 'Rem, goal check: a reminder. 1 question of the auditor is still open, and the loop waits for your answer.');

    // The answer, by a button of the very first message.
    D.press(s, q1, '2. hello, world');
    before = s.fake.sent.length;
    await s.tickAt(10.5 * HOUR + 2 * MIN);
    assert.deepEqual(textsSince(s, before), [
      'Rem, goal check: answer 1 of 2 saved: hello, world',
      'Rem, goal check: 2 answers saved in .audit\\DECISIONS.md. Asking the auditor again (goal check 2).',
    ]);
    assert.match(D.readAudit(project, 'DECISIONS.md'), /\n- Q: Which greeting should hello\.js print\?\n {2}A: hello, world \(answered\)\n- Q: Should the output end with a line break\?\n {2}A: Yes \(assumed\)\n$/);
    assert.deepEqual(D.loopState(project).decisions[0].items.map((item) => item.how), ['button', 'assumed']);

    // The auditor reads "assumed" as an answer, and the loop goes on.
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal');
    assert.match(s.calls()[1].stdin, /A: Yes \(assumed\)/);
    const log = D.loopLog(project);
    assert.ok(log.includes('goal check: question 2 [DEFAULT] had no answer within 60 minutes: assumed the recommended option: Yes'));
    assert.equal(log.filter((line) => line === 'reminder: 1 question still open').length, 2);

    // A proposal: a reminder every three hours too.
    const proposal = D.proposalMessage(s);
    await quiet(3 * HOUR - MIN, 'no reminder before three hours');
    before = s.fake.sent.length;
    await s.tickAt(3 * HOUR + MIN);
    assert.deepEqual(textsSince(s, before), ['Rem, round 2 of 3: a reminder. The prompt for round 2 still waits for you (.audit\\round-02-prompt-proposed.md).']);
    assert.deepEqual(D.lastKeyboard(s).replyMarkup, proposal.replyMarkup);
    await quiet(3 * HOUR + 2 * MIN, 'one reminder');
    await quiet(6 * HOUR, 'not before three more hours');
    before = s.fake.sent.length;
    await s.tickAt(6 * HOUR + 2 * MIN);
    assert.equal(textsSince(s, before).length, 1);
    D.press(s, D.lastKeyboard(s), 'Stop');
    await s.tick();
    assert.match(D.endMessage(s), /^Rem: the loop ended\. Stopped by you at the prompt for round 2\./);
  });

  test('questions that are all DEFAULT: an answer typed after "Other" counts as answered, the rest is assumed on time, and the loop goes on by itself', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Defaults');
    s.script({ auditor: [{ text: TWO_DEFAULTS }, 'stop'] });
    await D.startLoop(s, 'Defaults');
    await D.tickUntil(s, () => D.questionMessage(s, 2), 'the questions');
    D.press(s, D.questionMessage(s, 1), 'Other');
    s.fake.message(s.owner, 'salam');
    // "Other" on the second one, and then nothing is typed.
    D.press(s, D.questionMessage(s, 2), 'Other');
    await s.tick();
    assert.equal(s.state().conversations[s.owner].kind, 'loop-other');
    assert.equal(fs.existsSync(D.audit(project, 'DECISIONS.md')), false);

    const before = s.fake.sent.length;
    await s.tickAt(61 * MIN);
    assert.deepEqual(textsSince(s, before), [
      'Defaults, goal check: no answer to question 2 [DEFAULT] within 60 minutes, so I used the recommended option: Yes\nIt is marked (assumed) in .audit\\DECISIONS.md. You can change it later.',
      'Defaults, goal check: 2 answers saved in .audit\\DECISIONS.md. Asking the auditor again (goal check 2).',
    ]);
    assert.match(D.readAudit(project, 'DECISIONS.md'), /\n- Q: Which greeting\?\n {2}A: salam \(answered\)\n- Q: End with a line break\?\n {2}A: Yes \(assumed\)\n$/);
    assert.deepEqual(s.state().conversations, {}, 'the wait for a typed answer went with the question');
    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
    assert.deepEqual(callsOf(s), ['auditor:goal-check:0:text', 'auditor:goal-check:0:stop']);
    // The limits are config keys.
    assert.equal(DEFAULT_CONFIG.defaultAnswerMinutes, 60);
    assert.equal(DEFAULT_CONFIG.reminderHours, 3);
  });

  // ---- 9. /secret, and 13. the canary search ----

  test('/secret saves a key in the project\'s .env, deletes the owner\'s message and never shows the value; /secrets lists the names', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Keys');
    const envFile = path.join(project, '.env');
    const value = 'sk-test-SECRET-abcdef0123456789';
    const other = 'another-value-0123456789';
    const secret = async (text, options) => {
      const before = s.fake.sent.length;
      const update = s.fake.message(s.owner, text, options);
      const r = await s.tick();
      assert.equal(r.status, 0, r.stderr);
      return { id: update.message.message_id, said: textsSince(s, before) };
    };

    let done = await secret(`/secret keys API_KEY ${value}`);
    assert.deepEqual(s.fake.deleted, [{ chatId: s.owner, messageId: done.id }], 'the bot deleted the owner\'s message itself');
    assert.deepEqual(done.said, [
      'Your /secret message was deleted from this chat.',
      `Saved API_KEY in ${envFile}: a new name. I do not show the value.\n/secrets Keys lists the names.`,
    ]);
    assert.equal(fs.readFileSync(envFile, 'utf8'), `API_KEY=${value}\n`);
    assert.equal(D.git(project, 'status', '--porcelain'), '', '.env is not in git: nothing to commit');

    // A name that is there is replaced, and the bot says so. Other lines stay.
    fs.appendFileSync(envFile, '# a comment\nPLAIN=1\n');
    done = await secret(`/secret Keys API_KEY   ${other}  `);
    assert.equal(done.said[1], `Saved API_KEY in ${envFile}: it replaced the value that was there. I do not show the value.\n/secrets Keys lists the names.`);
    done = await secret(`/secret Keys OTHER_KEY ${value}`);
    assert.equal(fs.readFileSync(envFile, 'utf8'), `API_KEY=${other}\n# a comment\nPLAIN=1\nOTHER_KEY=${value}\n`);
    assert.equal(await D.say(s, '/secrets keys'), 'Keys: 3 names in .env, values not shown:\nAPI_KEY\nPLAIN\nOTHER_KEY');
    D.newProject(s, 'Fresh');
    assert.equal(await D.say(s, '/secrets Fresh'), 'Fresh has no key yet: there is no .env. /secret Fresh NAME value saves one.');
    assert.equal(await D.say(s, '/secrets Nowhere'), `There is no project named Nowhere in ${s.projectsRoot}.`);

    // Names that are not allowed, and what else is refused. Each such message is deleted too.
    const kept = fs.readFileSync(envFile, 'utf8');
    for (const name of ['api_key', '1KEY', 'KEY-X', 'KEY.X', 'K\u00c9Y']) {
      done = await secret(`/secret Keys ${name} ${value}`);
      assert.equal(done.said[1], '/secret was refused: the name may only have capital letters, digits and "_", and must not start with a digit (like API_KEY). Nothing was saved.', name);
      assert.equal(s.fake.deleted[s.fake.deleted.length - 1].messageId, done.id, 'a refused message may hold a key as well');
    }
    assert.equal((await secret('/secret Keys ONLY_A_NAME')).said[1], '/secret needs a project, a name and a value. Nothing was saved.\nUse it like this: /secret My_Project NAME value');
    assert.equal((await secret(`/secret Nowhere API_KEY ${value}`)).said[1], `/secret was refused: there is no project named Nowhere in ${s.projectsRoot}. Nothing was saved.\nUse it like this: /secret My_Project NAME value`);
    assert.equal((await secret(`/secret Keys TWO_LINES ${value}\nand a second line`)).said[1], '/secret was refused: the value must be on one line. Nothing was saved.');
    assert.equal(fs.readFileSync(envFile, 'utf8'), kept);
    // A project whose .gitignore does not ignore .env.
    const open = D.newProject(s, 'Open');
    fs.writeFileSync(path.join(open, '.gitignore'), '.audit/\n');
    D.git(open, 'commit', '-q', '-am', 'no .env line');
    assert.equal((await secret(`/secret Open API_KEY ${value}`)).said[1],
      '/secret was refused: Open\'s .gitignore does not ignore .env, so the key could end up in a commit. Add the line ".env" to .gitignore and commit that. Nothing was saved.');
    assert.equal(fs.existsSync(path.join(open, '.env')), false);

    // Two notes: a value too short to be filtered, and a message that Telegram formatted.
    assert.deepEqual((await secret('/secret Keys PIN 1234')).said[1].split('\n'), [
      `Saved PIN in ${envFile}: a new name. I do not show the value.`,
      'Note: the value has fewer than 8 characters. It is saved, but too short to be filtered out of logs, messages and commits.',
      '/secrets Keys lists the names.',
    ]);
    done = await secret(`/secret Keys FORMATTED ${value}`, { entities: [{ type: 'bot_command', offset: 0, length: 7 }, { type: 'italic', offset: 24, length: 6 }] });
    assert.ok(done.said[1].split('\n').includes('Note: Telegram applied formatting to your message, so characters such as * or _ may be missing from the value. Check the file, or send it again with the value between backticks.'));
    done = await secret(`/secret Keys IN_CODE ${value}`, { entities: [{ type: 'bot_command', offset: 0, length: 7 }, { type: 'code', offset: 22, length: value.length }] });
    assert.equal(done.said[1].includes('formatting'), false, 'a value between backticks arrives as it is');

    // When Telegram refuses the delete, the owner is asked to delete the message.
    s.fake.undeletable = true;
    const deleted = s.fake.deleted.length;
    done = await secret(`/secret Keys LAST_ONE ${value}`);
    assert.deepEqual(done.said, ['I could not delete your /secret message. Delete it yourself: it may hold the value.', `Saved LAST_ONE in ${envFile}: a new name. I do not show the value.\n/secrets Keys lists the names.`]);
    assert.equal(s.fake.deleted.length, deleted);
    assert.ok(s.logTexts().includes('outbox: dropped a deleteMessage: Telegram deleteMessage: 400 Bad Request: message can\'t be deleted'));
    assert.equal(s.fake.callsOf('deleteMessage').length, 16, 'one for every /secret message');

    // The value is nowhere: not in an output, not in the log, not in state.json or its backup.
    assert.ok(s.logTexts().includes(`/secret Keys: API_KEY added in .env (${value.length} characters; the value is never logged)`));
    const hits = [];
    for (const needle of [value, other, 'and a second line']) {
      s.outputs.forEach((text, i) => { if (text.includes(needle)) hits.push(`output ${i}`); });
      for (const { file, text } of filesUnder(s.runtimeDir)) if (text.includes(needle)) hits.push(file);
    }
    assert.deepEqual(hits, [], 'the value of a /secret message was found');
    assert.deepEqual(s.state().conversations, {}, 'nothing of it is kept in a conversation');
    assert.deepEqual(s.state().outbox, []);
    assert.deepEqual(envNames(project), ['API_KEY', 'PLAIN', 'OTHER_KEY', 'PIN', 'FORMATTED', 'IN_CODE', 'LAST_ONE']);
  });

  test('the values of the project\'s .env are treated like the bot token: in no log, message or record, and a round whose files hold one is not committed', async (t) => {
    const s = await botSandbox(t);
    const key = s.token.slice(s.token.indexOf(':') + 1);
    await s.firstTick();
    const project = D.newProject(s, 'Vault');
    const secret = 'sk-live-CANARY-9f8e7d6c5b4a3210';
    await D.say(s, `/secret Vault API_KEY ${secret}`);
    await D.say(s, '/secret Vault SHORT abc');

    // Round 1: the builder copies the key into config.js, and repeats it in what it says and in HANDOFF.md.
    s.script({ auditor: ['ask', 'continue', 'continue', 'done'], builder: [{ mode: 'leak', leak: secret }, 'ok'] });
    await D.startLoop(s, 'Vault');
    await D.tickUntil(s, () => D.questionMessage(s, 2), 'the questions');
    // The owner pastes the key into a typed answer.
    D.press(s, D.questionMessage(s, 1), 'Other');
    s.fake.message(s.owner, `use ${secret} for it`);
    D.press(s, D.questionMessage(s, 2), '1. Yes');
    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');

    // The commit check goes by what the files hold, not only by their names. It names the files, never the value.
    const end = D.endMessage(s).split('\n');
    assert.deepEqual(end.slice(0, 5), [
      'Vault: the loop ended. Round 1 was NOT committed: these files hold a value that is saved in the project\'s .env.',
      '- HANDOFF.md',
      '- config.js',
      'Nothing was committed, and everything was unstaged. The round\'s files are still in the folder.',
      'Take the value out of those files: a key belongs in .env only. The round was not audited.',
    ]);
    assert.equal(D.git(project, 'log', '--format=%s'), 'Loop: GOAL.md');
    assert.equal(D.git(project, 'diff', '--cached', '--name-only'), '');
    assert.ok(D.loopLog(project).includes('round 1: NOT committed, staged files hold a value of the project\'s .env: HANDOFF.md, config.js'));
    assert.match(fs.readFileSync(path.join(project, 'config.js'), 'utf8'), new RegExp(secret), 'the builder really wrote the key into the file');
    assert.deepEqual(callsOf(s), ['auditor:goal-check:0:ask', 'auditor:goal-check:0:continue', 'builder:leak'], 'no audit');

    // The filter was at work in what the bot and the builder's runner wrote.
    assert.match(D.readAudit(project, 'DECISIONS.md'), /A: use <secret:API_KEY> for it \(answered\)/);
    assert.match(D.readAudit(project, 'round-01-builder.jsonl'), /I put the key <secret:API_KEY> into config\.js\./);
    assert.match(D.readAudit(project, 'round-01-builder.log'), /text: I put the key <secret:API_KEY> into config\.js\./);
    assert.match(D.readAudit(project, 'round-01-builder-input.md'), /A: use <secret:API_KEY> for it/, 'round 1 gets the decisions, filtered');

    // /resume: the three buttons. While the files still hold the key, Keep and audit is refused again.
    await D.say(s, '/resume Vault');
    const asked = D.choiceMessage(s);
    assert.match(asked.text, /^Vault, round 1 of 3: the builder was cut off \(the round ran, and the loop did not commit it\)\. Nothing was committed\.\n/);
    D.press(s, asked, 'Keep and audit');
    await s.tick();
    assert.deepEqual(D.texts(s).pop().split('\n'), [
      'Vault, round 1 of 3: Round 1 was NOT committed: these files hold a value that is saved in the project\'s .env.',
      '- HANDOFF.md',
      '- config.js',
      'Nothing was committed, and everything was unstaged. The round\'s files are still in the folder.',
      'Fix that, then press a button again: they still work.',
    ]);
    assert.equal(D.buttonAnswers(s).pop(), 'Not committed');
    // The owner takes the key out of both files, and presses the same button again.
    for (const name of ['config.js', 'HANDOFF.md']) {
      const file = path.join(project, name);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split(secret).join('process.env.API_KEY'));
    }
    D.press(s, asked, 'Keep and audit');
    await s.tick();
    const commit = D.git(project, 'rev-parse', '--short', 'HEAD');
    assert.equal(D.texts(s).pop(), `Vault, round 1 of 3: kept. Committed as ${commit}. The auditor is checking the round.`);
    assert.equal(D.git(project, 'log', '--format=%s').split('\n')[0], 'Loop: round 1', 'a round that ran to its end keeps its own name');
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal');
    assert.doesNotMatch(s.calls().filter((call) => call.kind === 'auditor').pop().stdin, /CUT OFF/, 'it was not cut off, so the auditor is not told so');

    // A note with the key in it, then to the end.
    D.press(s, D.proposalMessage(s), 'Edit');
    s.fake.message(s.owner, `the key is ${secret}`);
    await s.tick();
    D.press(s, D.proposalMessage(s), 'Approve');
    await D.tickUntil(s, () => /DONE after round 2/.test(D.endMessage(s) || ''), 'the end of the loop');
    assert.match(D.readAudit(project, 'round-02-prompt.md'), /the key is <secret:API_KEY>/);
    assert.match(D.readAudit(project, 'LOOP_REPORT.md'), /^- Round 2, note: the key is <secret:API_KEY>$/m);

    // The canary search, with two canaries: the bot token in its three forms, and the /secret value.
    const needles = [s.token, key, encodeURIComponent(s.token), secret];
    const hits = [];
    s.outputs.forEach((text, i) => needles.forEach((needle) => { if (text.includes(needle)) hits.push(`output ${i}`); }));
    const runtimeFiles = filesUnder(s.runtimeDir);
    // Everything in the project but .git and .env itself, which holds the key by design.
    const projectFiles = filesUnder(project).filter(({ file }) => !file.includes(`${path.sep}.git${path.sep}`) && path.basename(file) !== '.env');
    for (const { file, text } of [...runtimeFiles, ...projectFiles]) needles.forEach((needle) => { if (text.includes(needle)) hits.push(file); });
    assert.ok(runtimeFiles.some(({ file }) => /jobs.job-\d+\.json$/.test(file)) && runtimeFiles.some(({ file }) => /logs.job-\d+\.log$/.test(file)) && runtimeFiles.some(({ file }) => file.endsWith('bot.log')));
    for (const name of ['loop.json', 'loop.log', 'LOOP_REPORT.md', 'DECISIONS.md', 'round-01-builder.jsonl', 'round-01-builder.log', 'round-01-builder.json', 'round-01-verdict.json', 'round-02-prompt.md']) {
      assert.ok(projectFiles.some(({ file }) => file.endsWith(`${path.sep}.audit${path.sep}${name}`)), `${name} was searched`);
    }
    assert.deepEqual(hits, [], 'a canary was found');
    t.diagnostic(`canary search over the controls: ${s.outputs.length} outputs, ${runtimeFiles.length} runtime files and ${projectFiles.length} project files searched for `
      + `3 forms of the token and for the /secret value, ${hits.length} hits`);
  });

  test('the project\'s .env: how it is read and written, and which values count as secrets', (t) => {
    const dir = path.join(ROOT, 'tests', 'tmp', 'bot', `env-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.deepEqual(secretValues(dir), [], 'no .env, no secrets');
    fs.writeFileSync(path.join(dir, '.env'), [
      '# API_KEY=commented-out-value', 'PLAIN=plain-value-123', 'export EXPORTED = exported-value-123', 'QUOTED="quoted value 12345"',
      'WITH_COMMENT=commented-value-1 # the test key', 'SHORT=1234567', 'EMPTY=', 'not a line', '',
    ].join('\r\n'));
    assert.deepEqual(envNames(dir), ['PLAIN', 'EXPORTED', 'QUOTED', 'WITH_COMMENT', 'SHORT', 'EMPTY']);
    assert.deepEqual(secretValues(dir).map(({ name, value }) => `${name}=${value}`), [
      'PLAIN=plain-value-123', 'EXPORTED=exported-value-123', 'QUOTED="quoted value 12345"', 'QUOTED=quoted value 12345',
      'WITH_COMMENT=commented-value-1 # the test key', 'WITH_COMMENT=commented-value-1',
    ], 'eight characters or more, in every way a program may read the line');
    assert.deepEqual(setEnvValue(dir, 'PLAIN', 'new-plain'), { replaced: true });
    assert.deepEqual(setEnvValue(dir, 'ADDED', 'x'), { replaced: false });
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /^# API_KEY=commented-out-value\nPLAIN=new-plain\nexport EXPORTED = exported-value-123\n[\s\S]*\nnot a line\nADDED=x\n$/);
    assert.throws(() => setEnvValue(dir, 'bad-name', 'x'), /the name is not allowed/);
    assert.throws(() => setEnvValue(dir, 'TWO', 'a\nb'), /one line/);
  });

  test('the usage limit is told apart from other errors by three signs, and the reset time comes from the event or from the text', () => {
    const refused = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1791778200, rateLimitType: 'five_hour' } };
    const allowed = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1791778200, rateLimitType: 'five_hour' } };
    const limitText = 'You\'ve hit your session limit \u00b7 resets 3:45pm';
    const errorResult = (text) => ({ type: 'result', subtype: 'success', is_error: true, result: text });
    const verdict = (events, result) => {
      const watch = createLimitWatch();
      events.forEach((event) => watch.onEvent(event));
      return watch.verdict(result);
    };
    // 1. A refused event, with an error result or with none at all.
    assert.equal(verdict([refused], errorResult('API Error')).sign, 'a rate_limit_event with status "rejected"');
    assert.equal(verdict([refused], null).resets_at, '2026-10-12T04:10:00.000Z');
    // 2. The text of an error result.
    assert.equal(verdict([allowed], errorResult(limitText)).sign, 'the text of the result');
    assert.equal(verdict([allowed], errorResult(limitText)).resets_at, '2026-10-12T04:10:00.000Z', 'the latest event names the reset time');
    assert.equal(verdict([], errorResult('You\'ve reached your Opus limit')).resets_at, null);
    // 3. An assistant message that says rate_limit, with an error result.
    assert.equal(verdict([{ type: 'assistant', error: 'rate_limit' }], errorResult('something else')).sign, 'an assistant message with error "rate_limit"');
    // Not a usage limit: a call that worked, any other error, and a reply that only talks about limits.
    assert.equal(verdict([allowed], { type: 'result', subtype: 'success', is_error: false, result: 'VERDICT: DONE' }), null);
    assert.equal(verdict([allowed], errorResult('API Error: overloaded')), null);
    assert.equal(verdict([allowed], { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (30)'] }), null);
    assert.equal(verdict([allowed], { type: 'result', subtype: 'success', is_error: false, result: limitText }), null, 'a good result is a good result');
    assert.equal(verdict([refused, allowed], errorResult('API Error')), null, 'a call that was allowed again after a refusal went on');
    assert.equal(verdict([], null), null, 'a claude that ended without a result is a crash, not a limit');
    // The time in the text, on this PC's clock.
    const at = new Date(2026, 9, 12, 16, 0);
    assert.equal(new Date(resetFromText('resets 3:45pm', at)).toString(), new Date(2026, 9, 13, 15, 45).toString(), 'the next 3:45pm');
    assert.equal(new Date(resetFromText('resets 5pm', at)).toString(), new Date(2026, 9, 12, 17, 0).toString());
    assert.equal(new Date(resetFromText('resets Mon 12:00am', at)).toString(), new Date(2026, 9, 19, 0, 0).toString(), 'the 12th is a Monday: the next one');
    assert.equal(resetFromText('no time here', at), null);
  });

  // ---- 10. LOOP_REPORT.md, and the context warning ----

  test('LOOP_REPORT.md is written and sent when a loop ends: every part of it for DONE, and the round message warns about a round that filled its context', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Report');
    s.script({ auditor: ['ask', 'continue', 'continue', 'done'], builder: ['context', 'compact'] });
    await D.startLoop(s, 'Report');
    await D.tickUntil(s, () => D.questionMessage(s, 2), 'the questions');
    D.press(s, D.questionMessage(s, 1), '2. hello, world');
    D.press(s, D.questionMessage(s, 2), 'Other');
    s.fake.message(s.owner, 'Only | on Fridays');
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal');

    // The round message: one warning line at the top, with the %.
    const round = D.lastText(s, /: audited\./).split('\n');
    assert.equal(round[0], 'Report, round 1 of 3: WARNING: the builder\'s round used 85% of its context window (a warning starts at 80%). '
      + 'The round was too big: the auditor was told, and is to make the next step smaller.');
    assert.equal(round[1], 'Report, round 1 of 3: audited.');
    assert.ok(round.includes('Builder: completed, 3 turns, $0.0123, context peak 85%, not compacted, 0 denied calls'));
    // The auditor learns it from the BUILDER ROUND part of its material.
    assert.match(s.calls()[3].stdin, /^CONTEXT WARNING: the builder's round used 85% of its context window\. That is 80% or more\.$/m);

    D.press(s, D.proposalMessage(s), 'Edit');
    s.fake.message(s.owner, 'REPORT_NOTE keep it small');
    await s.tick();
    D.press(s, D.proposalMessage(s), 'Approve');
    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
    // A round that was compacted is warned about too, also when the loop ends with it.
    const end = D.endMessage(s).split('\n');
    assert.equal(end[0], 'Report: the loop ended. DONE after round 2 of 3.');
    assert.equal(end[1], 'Report, round 2 of 3: WARNING: the builder\'s round was compacted 1 time, at a context peak of 75%. '
      + 'The round was too big: the auditor was told, and is to make the next step smaller.');
    assert.match(s.calls()[5].stdin, /^CONTEXT WARNING: the builder's conversation was compacted during the round\.$/m);

    // The report: written into .audit\, and sent as a file after the end message.
    const last = s.fake.sent.slice(-2);
    assert.match(last[0].text, /^Report: the loop ended\. DONE after round 2 of 3\./);
    assert.equal(last[1].method, 'sendDocument');
    assert.equal(last[1].filename, 'Report-LOOP_REPORT.md');
    assert.equal(last[1].caption, 'Report: the loop\'s report. Bring this file to Claude in chat for the final check.');
    const report = D.readAudit(project, 'LOOP_REPORT.md');
    assert.equal(last[1].content, report);
    const [c2, c1] = D.git(project, 'log', '--format=%h').split('\n');
    const loop = D.loopState(project);
    const lines = report.split('\n');
    assert.deepEqual(lines.slice(0, 10).map((line) => line.replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d/, 'TIME')), [
      '# Loop report: Report',
      '',
      `- Project: ${project}`,
      `- Loop: ${loop.id}`,
      '- Started: TIME',
      '- Ended: TIME',
      '- How it ended: DONE after round 2 of 3.',
      '- Rounds: 2 of 3',
      '- Total cost: $0.1046 (builder $0.0246, auditor $0.0400, goal checks $0.0400)',
      // Phase 7c: the shipped config's model and effort, which the bot's settings carry.
      '- Model: claude-opus-5-5, effort xhigh',
    ]);
    const at = (title) => lines.indexOf(title);
    assert.deepEqual(lines.slice(at('## Rounds') + 2, at('## Rounds') + 6), [
      '| Round | Builder | Turns | Cost | Context peak | Compacted | Denied calls | Commit | Verdict | Reason | Auditor cost |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      `| 1 | completed | 3 | $0.0123 | 85% | no | 0 | ${c1} | CONTINUE | Round 1 did part of the work. | $0.0200 |`,
      `| 2 | completed | 3 | $0.0123 | 75% | yes, 1 time | 0 | ${c2} | DONE | Every definition-of-done item has evidence. | $0.0200 |`,
    ]);
    assert.ok(lines.includes('Round 1: WARNING: the builder\'s round used 85% of its context window (a warning starts at 80%). The round was too big: the auditor was told, and is to make the next step smaller.'));
    assert.ok(lines.includes('Goal checks: 1 ASK_HUMAN ($0.0200), 2 CONTINUE ($0.0200).'));
    assert.deepEqual(lines.slice(at('## Questions and answers') + 3, at('## Questions and answers') + 8), [
      '',
      '- Q1 [MUST] Which greeting should hello.js print?',
      '  A: hello, world (answered, by button)',
      '- Q2 [DEFAULT] Should the output end with a line break?',
      '  A: Only | on Fridays (answered, typed)',
    ]);
    assert.deepEqual(lines.slice(at('## The owner\'s notes and edits') + 2, at('## The owner\'s notes and edits') + 3), ['- Round 2, note: REPORT_NOTE keep it small']);
    assert.deepEqual(lines.slice(at('## The last verdict') + 2, at('## The last verdict') + 9), [
      'Round 2: DONE. Every definition-of-done item has evidence.',
      '',
      'Open findings: none.',
      '',
      'Summary:',
      '',
      'DONE_SUMMARY_MARKER hello.js prints hello and has a test.',
    ]);
    const commits = lines.slice(at('## Commits'));
    assert.ok(commits.includes(`${c2} Loop: round 2`) && commits.includes(`${c1} Loop: round 1`));
    assert.equal(commits.some((line) => /Loop: GOAL\.md/.test(line)), false, 'only the loop\'s own commits');
    assert.ok(commits.some((line) => /^ hello\.js +\| +\d+ \+/.test(line)), 'git diff --stat from the first to the last');
    assert.equal(commits.some((line) => /HANDOFF\.md +\|/.test(line)), false);
    assert.deepEqual(lines.slice(-4), ['---', '', 'Bring this file to Claude in chat for the final check.', '']);

    // A loop that ends by Stop: the last verdict's open findings and the prompt that did not run.
    const stopped = D.newProject(s, 'RepStop');
    s.script({ auditor: ['continue', 'continue'], builder: ['ok'] });
    await D.startLoop(s, 'RepStop');
    await D.tickUntil(s, () => D.proposalMessage(s) && /RepStop/.test(D.proposalMessage(s).text), 'the proposal');
    D.press(s, D.proposalMessage(s), 'Stop');
    await s.tick();
    const second = D.readAudit(stopped, 'LOOP_REPORT.md');
    assert.equal(D.reports(s).pop().content, second);
    assert.match(second, /^- How it ended: Stopped by you at the prompt for round 2\.$/m);
    assert.match(second, /\nOpen findings:\n- hello\.js: there is no test yet\n- HANDOFF\.md: the output of node hello\.js is not shown\n\nThe next prompt \(not run\):\n\nAUDITOR_PROMPT_MARKER for round 2\n/);
    assert.match(second, /\nThe auditor asked nothing\.\n/);
    assert.match(second, /\nNone\. Every prompt was approved as it was proposed\.\n/);
  });

  // ---- 11. hardening ----

  test('the loop\'s own git never runs a project\'s hooks: not on its commit, and not when the project\'s own config names a hooks folder', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const marker = path.join(s.dir, 'hook-ran.txt');
    const hook = `#!/bin/sh\necho ran >> "${marker.replace(/\\/g, '/')}"\nexit 1\n`;

    // A pre-commit hook in the project's own .git\hooks. It would also refuse the commit.
    const project = D.newProject(s, 'Hooked');
    fs.writeFileSync(path.join(project, '.git', 'hooks', 'pre-commit'), hook);
    s.script({ auditor: ['continue', 'done', 'continue', 'done'], builder: ['ok', 'ok'] });
    await D.startLoop(s, 'Hooked');
    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
    assert.match(D.endMessage(s), /^Hooked: the loop ended\. DONE after round 1 of 3\./);
    assert.deepEqual(D.git(project, 'log', '--format=%s').split('\n'), ['Loop: round 1', 'Loop: GOAL.md'], 'the loop committed');
    assert.equal(fs.existsSync(marker), false, 'and the project\'s pre-commit hook did not run');
    // The hook is a real one: a plain commit in the project runs it, and is refused by it.
    fs.writeFileSync(path.join(project, 'by-hand.txt'), 'x\n');
    D.git(project, 'add', 'by-hand.txt');
    const plain = spawnSync('git', ['commit', '-q', '-m', 'by hand'], { cwd: project, encoding: 'utf8' });
    assert.notEqual(plain.status, 0, 'the hook refuses a plain commit');
    assert.equal(fs.existsSync(marker), true, 'a plain git commit runs the hook');
    fs.rmSync(marker);

    // A hooks folder that the project's own .git\config names: the loop's "-c" wins over it.
    const named = D.newProject(s, 'HooksPath');
    const folder = path.join(s.dir, 'project-hooks');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'pre-commit'), hook);
    D.git(named, 'config', 'core.hooksPath', folder.replace(/\\/g, '/'));
    await D.startLoop(s, 'HooksPath');
    await D.tickUntil(s, () => /^HooksPath: the loop ended\. DONE/.test(D.endMessage(s) || ''), 'the end of the second loop');
    assert.deepEqual(D.git(named, 'log', '--format=%s').split('\n'), ['Loop: round 1', 'Loop: GOAL.md']);
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(fs.readdirSync(path.join(ROOT, '.no-hooks')), [], 'the folder the loop points git at is empty');

    // The builder cannot touch .audit\ or .git\: the deny rules are in its command line.
    const denied = s.calls().find((call) => call.kind === 'builder').argv;
    const rules = denied.slice(denied.indexOf('--disallowedTools') + 1, denied.indexOf('--permission-mode'));
    for (const rule of ['Read(./.audit/**)', 'Edit(./.audit/**)', 'Read(./.git/**)', 'Edit(./.git/**)']) {
      assert.ok(rules.includes(rule), `${rule} is passed to claude`);
      assert.ok(DEFAULT_CONFIG.builderDeniedTools.includes(rule), `${rule} is in the shipped config`);
    }
    assert.equal(DEFAULT_CONFIG.builderDeniedTools.some((rule) => /^Write\(/.test(rule)), false,
      'no Write(path) rule: Claude Code never consults one, and an Edit rule covers the Write tool');
  });
});
