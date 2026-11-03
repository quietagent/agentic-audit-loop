'use strict';

// Tests the loop's background jobs: a job must outlive the tick that starts it, must
// not hold up whoever waits for the tick, must get none of n8n's settings, and must
// survive a stop of n8n.
// The tick is run here the way n8n's Execute Command node runs a command in 2.42.5
// (spawn with shell: true, through cmd.exe, waiting for "close"), and with
// child_process.exec. n8n itself is the fake of tests/helpers/fake_n8n.js. Windows only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, exec } = require('node:child_process');
const { botSandbox, BOT, ROOT, N8N_ENV_NAMES } = require('./helpers/bot_sandbox');
const { buildSandbox, waitFor, isAlive } = require('./helpers/launcher_sandbox');
const D = require('./helpers/loop_driver');

const windowsOnly = { skip: process.platform === 'win32' ? false : 'the commands are run through cmd.exe' };
const LINGERING_TICK = path.join(__dirname, 'helpers', 'lingering_tick.js');

const tickCommand = (s) => `node "${BOT}" tick --config "${s.config}"`;
// A JSON file that another process is writing: null while it is not there or not whole.
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// As in n8n 2.42.5, nodes/ExecuteCommand/ExecuteCommand.node.js.
function runLikeN8n(command, env) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: process.cwd(), shell: true, detached: false, env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), ms: Date.now() - started }));
  });
}

function runWithExec(command, env) {
  const started = Date.now();
  return new Promise((resolve) => {
    exec(command, { env, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout: stdout.trim(), stderr: stderr.trim(), ms: Date.now() - started });
    });
  });
}

for (const [how, run] of [['spawn with shell: true, as n8n does', runLikeN8n], ['child_process.exec', runWithExec]]) {
  test(`a tick run through cmd.exe (${how}) returns at once, and the job it started runs on`, windowsOnly, async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Background');
    // The goal check takes 6 seconds. The tick that starts it must not wait for it.
    s.script({ auditor: [{ reply: 'stop', delayMs: 6000 }] });
    s.fake.message(s.owner, '/loop Background');

    const tick = await run(tickCommand(s), s.env());
    assert.equal(tick.code, 0, tick.stderr);
    assert.equal(tick.stdout, 'ok: 1 update, 1 sent');
    assert.ok(tick.ms < 5000, `the tick took ${tick.ms} ms`);
    assert.match(s.fake.sentTexts().pop(), /^Background: the loop started/);

    // The tick is over and the job is still at work: its record says so, with a heartbeat.
    const job = D.loopState(project).job;
    assert.equal(job.kind, 'goal-check');
    const running = await waitFor(() => readJson(job.recordFile), 'the job\'s record');
    assert.equal(running.status, 'running');
    assert.equal(running.kind, 'goal-check');
    assert.ok(Date.parse(running.heartbeat_at) >= Date.parse(running.started_at));
    assert.ok(isAlive(running.runner_pid), 'the job is alive after the tick ended');
    t.diagnostic(`${how}: the tick returned after ${tick.ms} ms; the job was still running then`);

    // Later ticks see the end and carry the loop on.
    await waitFor(async () => {
      await run(tickCommand(s), s.env());
      return D.endMessage(s);
    }, 'the report of the end', 60000);
    const done = readJson(job.recordFile);
    assert.equal(done.status, 'ended');
    assert.equal(done.exit_code, 0);
    assert.equal(JSON.parse(done.stdout).verdict, 'STOP_FOR_HUMAN', 'the record holds what the job printed');
    assert.ok(Date.parse(done.finished_at) - Date.parse(done.started_at) >= 5500, 'the job ran its full 6 seconds');
    assert.match(D.endMessage(s), /^Background: the loop ended\. The goal check says STOP_FOR_HUMAN/);
    assert.match(fs.readFileSync(job.logFile, 'utf8'), /\[run_auditor\] goal check 1: STOP_FOR_HUMAN/, 'the job\'s log has what it wrote to stderr');
  });
}

test('a tick started with an environment like n8n\'s: none of n8n\'s settings reach claude', windowsOnly, async (t) => {
  const s = await botSandbox(t);
  await s.firstTick();
  D.newProject(s, 'Clean');
  s.script({ auditor: ['continue', 'done'], builder: ['ok'] });
  // What start-n8n-loop.cmd loads from n8n-loop\.env, and what n8n's Execute Command
  // node then passes to every command it runs. The last ones are in no env file of ours.
  const n8nLike = {
    N8N_HOST: 'localhost',
    N8N_PORT: '5690',
    N8N_PROTOCOL: 'http',
    N8N_LISTEN_ADDRESS: '127.0.0.1',
    N8N_WEBHOOK_URL: 'http://localhost:5690/',
    N8N_EDITOR_BASE_URL: 'http://localhost:5690/',
    N8N_RUNNERS_BROKER_PORT: '5691',
    N8N_USER_FOLDER: 'C:\\somewhere\\n8n-loop\\data',
    N8N_LOG_FILE_LOCATION: 'C:\\somewhere\\n8n-loop\\logs\\n8n.log',
    GENERIC_TIMEZONE: 'Asia/Tokyo',
    TZ: 'Asia/Tokyo',
    EXECUTIONS_DATA_PRUNE: 'true',
    EXECUTIONS_DATA_MAX_AGE: '336',
    NODES_EXCLUDE: '["n8n-nodes-base.localFileTrigger"]',
    NODE_OPTIONS: `--require=${path.join(ROOT, 'n8n-loop', 'dns-fallback.cjs')}`,
    LOOP_TEST_NAMED_IN_ENV_FILE: 'only the env file names this one',
    WEBHOOK_URL: 'http://localhost:5690/',
    NODES_INCLUDE: '[]',
    DB_TYPE: 'sqlite',
    QUEUE_HEALTH_CHECK_PORT: '5678',
  };
  for (const name of N8N_ENV_NAMES) assert.ok(name in n8nLike, `${name} is in the sandbox's env file`);
  const env = s.env({ ...n8nLike, LOOP_TEST_KEPT: 'kept' });

  s.fake.message(s.owner, '/loop Clean');
  await waitFor(async () => {
    const tick = await runLikeN8n(tickCommand(s), env);
    assert.equal(tick.code, 0, tick.stderr);
    assert.equal(tick.stderr, '');
    return D.endMessage(s);
  }, 'the end of the loop', 90000);
  assert.match(D.endMessage(s), /^Clean: the loop ended\. DONE after round 1 of 3\./);

  // The goal check, the builder and the auditor: each claude was started by a job,
  // and each job by a tick that had all of n8n's settings.
  const calls = s.calls();
  assert.deepEqual(calls.map((call) => call.kind), ['auditor', 'builder', 'auditor']);
  // DNS_FALLBACK_QUIET is the bot's own switch for the DNS fix: it stops at the tick too.
  const removed = [...Object.keys(n8nLike), 'DNS_FALLBACK_QUIET'];
  for (const call of calls) {
    const seen = call.envNames.map((name) => name.toUpperCase());
    for (const name of removed) assert.equal(seen.includes(name), false, `${name} reached the ${call.kind}`);
    assert.deepEqual(seen.filter((name) => /^(N8N_|NODES_|EXECUTIONS_|DB_|QUEUE_)/.test(name)), [], 'nothing with one of n8n\'s prefixes');
    assert.ok(seen.includes('LOOP_TEST_KEPT') && seen.includes('PATH'), 'the rest is passed on');
  }
  t.diagnostic(`${removed.length} n8n-like variables in the tick's environment, ${calls.length} claude calls, none of them saw one`);
});

test('stop-n8n-loop.cmd stops n8n and leaves a running job of the loop alone', windowsOnly, async (t) => {
  const s = await botSandbox(t);
  await s.firstTick();
  const project = D.newProject(s, 'Survivor');
  s.script({ auditor: ['continue', 'done'], builder: [{ mode: 'ok', delayMs: 8000 }] });
  // The goal check comes first. The tick that sees its end starts the builder: that
  // tick is the one the fake n8n runs, the way n8n does.
  await D.startLoop(s, 'Survivor');
  const goalCheck = D.loopState(project).job;
  await waitFor(() => (readJson(goalCheck.recordFile) || {}).status === 'ended', 'the goal check to end');

  const n8n = await buildSandbox(t);
  n8n.plan([{ listen: true, tick: tickCommand(s) }]);
  const launcher = n8n.launch({ extraEnv: s.env() });
  const tickResult = path.join(n8n.dir, 'tick-result.json');
  await waitFor(() => fs.existsSync(tickResult), 'the tick inside the fake n8n to end');
  const tick = JSON.parse(fs.readFileSync(tickResult, 'utf8'));
  assert.equal(tick.code, 0, tick.stderr);
  assert.match(tick.stdout.trim(), /^ok: \d+ sent$/);
  assert.ok(tick.ms < 6000, `n8n waited ${tick.ms} ms for the tick`);

  // The builder (8 seconds) runs: the job's runner, run_builder.js below it, and claude.
  const job = D.loopState(project).job;
  assert.equal(job.kind, 'builder');
  const summary = await waitFor(() => {
    const found = readJson(job.summaryFile);
    return found && found.session_id && s.calls().some((call) => call.kind === 'builder') ? found : null;
  }, 'the builder to report its session');
  const runnerPid = readJson(job.recordFile).runner_pid;
  const claudePid = s.calls().find((call) => call.kind === 'builder').pid;
  const n8nPid = n8n.starts()[0].pid;
  assert.ok(isAlive(runnerPid) && isAlive(summary.runner_pid) && isAlive(claudePid) && isAlive(n8nPid));

  const stopped = n8n.runStop();
  assert.equal(stopped.status, 0, stopped.stdout);
  assert.match(stopped.stdout, /Stopped\. Port \d+ is free\./);
  assert.equal(await launcher.exited, 0);
  assert.equal(isAlive(n8nPid), false, 'the fake n8n is stopped');
  assert.ok(isAlive(runnerPid), 'the job\'s runner survived the stop');
  assert.ok(isAlive(summary.runner_pid), 'run_builder.js survived the stop');
  assert.ok(isAlive(claudePid), 'claude survived the stop');
  assert.equal(readJson(job.recordFile).status, 'running');
  // Phase 7d: the launcher started n8n without passing its handles on, so the running job
  // does not hold logs\n8n-loop.lock, and the next start is not blocked.
  assert.equal(n8n.lockHeld(), false, 'the running job does not hold the launcher\'s lock');

  // The builder finishes its round with n8n gone. Once ticks come again, the loop goes on to its end.
  const done = await waitFor(() => {
    const record = readJson(job.recordFile);
    return record && record.status === 'ended' ? record : null;
  }, 'the builder to finish');
  assert.equal(done.exit_code, 0);
  assert.equal(readJson(job.summaryFile).handoff_written, true);
  await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
  assert.match(D.endMessage(s), /^Survivor: the loop ended\. DONE after round 1 of 3\./);
  assert.deepEqual(D.git(project, 'log', '--format=%s').split('\n'), ['Loop: round 1', 'Loop: GOAL.md']);
  t.diagnostic(`stop killed the fake n8n (PID ${n8nPid}); the job's runner ${runnerPid}, run_builder ${summary.runner_pid} and claude ${claudePid} lived on, and the loop went on to DONE`);
});

// Starts a fake n8n whose tick starts a 4-second job and then stays alive, stops
// that n8n with the stop script, and says what was left.
async function stopWithLivingTick(t, how) {
  const n8n = await buildSandbox(t);
  n8n.plan([{ listen: true, tick: `node "${LINGERING_TICK}" "${n8n.dir}" 4000 ${how}` }]);
  const launcher = n8n.launch();
  const pidOf = (name) => {
    const file = path.join(n8n.dir, name);
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8') ? Number(fs.readFileSync(file, 'utf8')) : null;
  };
  const tickPid = await waitFor(() => pidOf('tick.pid'), 'the lingering tick');
  const jobPid = await waitFor(() => pidOf('job.pid'), 'the job');
  const n8nPid = n8n.starts()[0].pid;
  assert.ok(isAlive(tickPid) && isAlive(jobPid) && isAlive(n8nPid));

  const stopped = n8n.runStop();
  assert.equal(stopped.status, 0, stopped.stdout);
  assert.equal(await launcher.exited, 0);
  assert.equal(isAlive(n8nPid), false, 'the fake n8n is stopped');
  assert.equal(isAlive(tickPid), false, 'the tick was in n8n\'s process tree and went with it');
  return { jobAlive: isAlive(jobPid), done: path.join(n8n.dir, 'job.done') };
}

test('a stop while the tick that started the job is still alive kills the tick, not the job', windowsOnly, async (t) => {
  const { jobAlive, done } = await stopWithLivingTick(t, '');
  assert.equal(jobAlive, true, 'the job has no living parent, so the stop did not reach it');
  await waitFor(() => fs.existsSync(done), 'the job to finish');
});

test('the same stop does kill a job that was started without the helper process', windowsOnly, async (t) => {
  // This is why jobs.startDetached() goes through lib/detach.js.
  const { jobAlive, done } = await stopWithLivingTick(t, 'one-hop');
  assert.equal(jobAlive, false, 'the job was a child of the tick and went with it');
  await new Promise((resolve) => { setTimeout(resolve, 4500); });
  assert.equal(fs.existsSync(done), false, 'it never finished');
});
