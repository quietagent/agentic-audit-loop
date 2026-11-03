'use strict';

// Tests n8n-loop/start-n8n-loop.cmd and stop-n8n-loop.cmd against a fake n8n, each
// test in its own sandbox with its own port (tests/helpers/launcher_sandbox.js).
// The real n8n, port 5690 and the Scheduled Task are never touched. Both scripts are
// started the way Explorer starts a .cmd file. Windows only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { buildSandbox, waitFor, sleep, isAlive, COMSPEC } = require('./helpers/launcher_sandbox');

const windowsOnly = { skip: process.platform === 'win32' ? false : 'the launcher is a Windows .cmd file' };
const LINGERING_TICK = path.join(__dirname, 'helpers', 'lingering_tick.js');
const FAKE_N8N = path.join(__dirname, 'helpers', 'fake_n8n.js');
const CRASH = { listen: false, exitAfterMs: 200, code: 3 };
const UP = { listen: true };

const count = (lines, pattern) => lines.filter((line) => pattern.test(line)).length;

test('a crash restarts n8n, and a stop then ends the launcher with code 0', windowsOnly, async (t) => {
  const s = await buildSandbox(t);
  s.plan([CRASH, UP]);
  const launcher = s.launch({ waitS: 1 });
  await waitFor(() => s.listening(), 'the restarted fake n8n to listen');
  assert.equal(s.starts().length, 2);
  assert.equal(s.state(), 'running');

  const stopped = s.runStop();
  assert.equal(stopped.status, 0, stopped.stdout);
  assert.match(stopped.stdout, new RegExp(`Stopping the loop's n8n: PID ${s.starts()[1].pid} on 127\\.0\\.0\\.1:${s.port}`));
  assert.match(stopped.stdout, /Stopped\. Port \d+ is free\./);
  assert.equal(await launcher.exited, 0);
  assert.equal(await s.listening(), false);
  assert.equal(s.state(), null);

  const log = s.readLog('launcher.log');
  assert.equal(log.length, 4, log.join('\n'));
  assert.match(log[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d start: n8n is starting, restart 0 of 3$/);
  assert.match(log[1], /n8n ended: exit code 3 after \d+ s, stop flag seen: no, restart 1 of 3 in 1 s$/);
  assert.match(log[2], /start: n8n is starting, restart 1 of 3$/);
  assert.match(log[3], /n8n ended: exit code \d+ after \d+ s, stop flag seen: yes, no restart, launcher exits 0$/);
  const stopLog = s.readLog('stop.log');
  assert.equal(stopLog.length, 1);
  // Since Phase 7e the stop also waits until the launcher has let go of its lock.
  assert.match(stopLog[0], /started by a terminal or a script: stopped PID \d+, port \d+ is free, taskkill exit code 0, lock free after \d+ s, exit code 0$/);
});

test('3 crashes in a row end the restarts, and the launcher passes on the exit code', windowsOnly, async (t) => {
  const s = await buildSandbox(t);
  s.plan([CRASH]);
  const launcher = s.launch({ waitS: 1 });
  assert.equal(await launcher.exited, 3);
  assert.equal(s.starts().length, 4, 'one start and three restarts');
  const log = s.readLog('launcher.log');
  assert.deepEqual(log.filter((line) => /restart \d of 3 in/.test(line)).map((line) => /restart (\d) of 3 in/.exec(line)[1]), ['1', '2', '3']);
  assert.match(log[log.length - 1], /stop flag seen: no, 3 restarts in a row are used up, launcher exits 3$/);
  assert.equal(s.state(), null);
});

test('a long run resets the count of restarts', windowsOnly, async (t) => {
  const s = await buildSandbox(t);
  // Two crashes, then a run that outlasts "long run" (8 s here, 10 minutes for real), then crashes only.
  // The measured time of a run includes PowerShell's start of n8n (Phase 7d), about a second and
  // more on a busy PC, so a crash after 200 ms must stay well under the 8 s.
  s.plan([CRASH, CRASH, { listen: false, exitAfterMs: 12000, code: 3 }, CRASH]);
  const launcher = s.launch({ waitS: 1, longRunS: 8 });
  assert.equal(await launcher.exited, 3);
  const log = s.readLog('launcher.log');
  assert.equal(s.starts().length, 6, log.join('\n'));
  assert.deepEqual(log.filter((line) => /restart \d of 3 in/.test(line)).map((line) => /restart (\d) of 3 in/.exec(line)[1]), ['1', '2', '1', '2', '3']);
  t.diagnostic(`measured run times: ${log.map((line) => / after (\d+) s/.exec(line)).filter(Boolean).map((m) => `${m[1]} s`).join(', ')}`);
});

test('a stop during the wait cancels the restart', windowsOnly, async (t) => {
  const s = await buildSandbox(t);
  s.plan([CRASH, UP]);
  const launcher = s.launch({ waitS: 60 });
  await waitFor(() => s.state() === 'waiting', 'the launcher to wait for its restart');

  const stopped = s.runStop();
  // Phase 7e: the stop returns only once the launcher has let go of the lock.
  const heldAfterStop = s.lockHeld();
  assert.equal(stopped.status, 0, stopped.stdout);
  assert.match(stopped.stdout, /n8n was not running\. A restart was waiting: cancelled\./);
  assert.equal(heldAfterStop, false, 'the lock was still held when the stop returned');
  assert.equal(await launcher.exited, 0);
  assert.equal(s.starts().length, 1, 'n8n was not started again');
  assert.equal(s.state(), null);
  assert.match(s.readLog('launcher.log').pop(), /stop flag seen during the wait: restart 1 cancelled, launcher exits 0$/);
  assert.match(s.readLog('stop.log')[0], /a waiting restart was cancelled, lock free after \d+ s, exit code 0$/);
});

test('a start while the port listens exits quietly with 0', windowsOnly, async (t) => {
  const s = await buildSandbox(t);
  s.plan([UP]);
  const server = net.createServer();
  await new Promise((resolve) => { server.listen(s.port, '127.0.0.1', resolve); });
  t.after(() => server.close());

  const launcher = s.launch();
  assert.equal(await launcher.exited, 0);
  assert.equal(launcher.output().trim(), '');
  assert.equal(s.starts().length, 0, 'n8n was not started');
  assert.deepEqual(s.readLog('launcher.log').map((line) => line.replace(/^.{26} /, '')), [`port ${s.port} already listens: n8n was not started, quiet exit 0`]);
});

const LOCK_LINE = /^.{26} another launcher holds logs\\n8n-loop\.lock: quiet exit 0$/;

test('two launchers started at the same moment: one n8n runs, the other launcher exits 0 at once with the lock line (Phase 7d)', windowsOnly, async (t) => {
  const s = await buildSandbox(t);
  // A slow start, as on 2026-10-10 at 20:28: the port does not listen yet when the second one looks.
  s.plan([{ listen: true, listenDelayMs: 3000 }]);
  const launchers = [s.launch({ waitS: 2 }), s.launch({ waitS: 2 })];
  const started = Date.now();
  const quit = await Promise.race(launchers.map((launcher, i) => launcher.exited.then((code) => ({ i, code }))));
  const quitAfterMs = Date.now() - started;
  assert.equal(quit.code, 0);
  assert.ok(quitAfterMs < 20000, `the second launcher took ${quitAfterMs} ms`);
  const winner = launchers[1 - quit.i];

  await waitFor(() => s.listening(), 'the one fake n8n to listen');
  await sleep(3000);
  assert.equal(s.starts().length, 1, 'exactly one n8n was started');
  assert.ok(isAlive(s.starts()[0].pid));
  assert.equal(s.lockHeld(), true, 'the launcher that runs holds the lock');
  const log = s.readLog('launcher.log');
  assert.equal(count(log, LOCK_LINE), 1, log.join('\n'));
  assert.equal(count(log, /start: n8n is starting, restart 0 of 3$/), 1, log.join('\n'));
  assert.equal(count(log, /n8n ended/), 0, log.join('\n'));

  assert.equal(s.runStop().status, 0);
  assert.equal(await winner.exited, 0);
  t.diagnostic(`the second launcher exited 0 after ${quitAfterMs} ms`);
});

test('after the launcher ends through the stop flag, the lock is free and a new start works (Phase 7d)', windowsOnly, async (t) => {
  const s = await buildSandbox(t);
  s.plan([UP]);
  const first = s.launch();
  await waitFor(() => s.listening(), 'the fake n8n to listen');
  assert.equal(s.lockHeld(), true);
  assert.equal(s.runStop().status, 0);
  assert.equal(await first.exited, 0);
  assert.equal(fs.existsSync(s.lockFile), true, 'the lock file stays on the disk');
  assert.equal(s.lockHeld(), false, 'nobody holds it once the launcher ended');

  const second = s.launch();
  await waitFor(() => s.listening(), 'the second fake n8n to listen');
  assert.equal(s.starts().length, 2);
  assert.equal(s.runStop().status, 0);
  assert.equal(await second.exited, 0);
  assert.equal(count(s.readLog('launcher.log'), LOCK_LINE), 0);
});

test('a lock file left on the disk by a crash, with nobody holding it, does not block a start (Phase 7d)', windowsOnly, async (t) => {
  const s = await buildSandbox(t);
  s.plan([UP]);
  fs.writeFileSync(s.lockFile, 'left over from a crash\r\n');
  assert.equal(s.lockHeld(), false);
  const launcher = s.launch();
  await waitFor(() => s.listening(), 'the fake n8n to listen');
  assert.equal(s.starts().length, 1);
  assert.equal(s.lockHeld(), true);
  assert.equal(s.runStop().status, 0);
  assert.equal(await launcher.exited, 0);
  const log = s.readLog('launcher.log');
  assert.equal(count(log, LOCK_LINE), 0, log.join('\n'));
  assert.match(log[0], /start: n8n is starting, restart 0 of 3$/);
});

test('a job that n8n started and that outlives the stop does not hold the lock: the next start works (Phase 7d)', windowsOnly, async (t) => {
  const s = await buildSandbox(t);
  // The first n8n runs one tick that starts a job the way the bot does (jobs.startDetached())
  // and stays alive; the job runs a minute. The second n8n runs no tick.
  s.plan([{ listen: true, tick: `node "${LINGERING_TICK}" "${s.dir}" 60000` }, UP]);
  const first = s.launch();
  const jobPid = await waitFor(() => {
    const file = path.join(s.dir, 'job.pid');
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8') ? Number(fs.readFileSync(file, 'utf8')) : null;
  }, 'the job to start', 60000);
  // The job's working folder is the sandbox: it must be gone before the sandbox is removed.
  const endJob = async () => {
    if (isAlive(jobPid)) process.kill(jobPid);
    await waitFor(() => !isAlive(jobPid), 'the job to end');
  };
  t.after(endJob);
  assert.equal(s.runStop().status, 0);
  assert.equal(await first.exited, 0);
  assert.ok(isAlive(jobPid), 'the job survived the stop');
  assert.equal(s.lockHeld(), false, 'the job does not hold the lock');

  const second = s.launch();
  await waitFor(() => s.listening(), 'the second fake n8n to listen');
  assert.equal(s.starts().length, 2);
  assert.ok(isAlive(jobPid), 'the job still runs');
  assert.equal(count(s.readLog('launcher.log'), LOCK_LINE), 0);
  assert.equal(s.runStop().status, 0);
  assert.equal(await second.exited, 0);
  await endJob();
});

test('the stop returns only once the launcher has let go of the lock: a start right after it runs n8n (Phase 7e)', windowsOnly, async (t) => {
  const s = await buildSandbox(t);
  s.plan([UP]);
  const first = s.launch();
  await waitFor(() => s.listening(), 'the fake n8n to listen');
  assert.equal(s.lockHeld(), true);

  const stopped = s.runStop();
  // No wait of any kind between the stop and these two: that moment is the gap of Phase 7d.
  const heldAfterStop = s.lockHeld();
  const second = s.launch();
  assert.equal(stopped.status, 0, stopped.stdout);
  assert.equal(heldAfterStop, false, 'the lock was still held when the stop returned');
  assert.equal(await first.exited, 0);

  await waitFor(() => s.listening(), 'the second fake n8n to listen');
  assert.equal(s.starts().length, 2, 'the start right after the stop ran n8n');
  const log = s.readLog('launcher.log');
  assert.equal(count(log, LOCK_LINE), 0, log.join('\n'));
  assert.equal(count(log, /start: n8n is starting, restart 0 of 3$/), 2, log.join('\n'));
  assert.match(s.readLog('stop.log')[0], /stopped PID \d+, port \d+ is free, taskkill exit code 0, lock free after \d+ s, exit code 0$/);
  assert.equal(s.runStop().status, 0);
  assert.equal(await second.exited, 0);
});

test('stop and the lock without a launcher: free at once for an n8n started by hand; a lock held 10 s longer is reported, with the same exit code (Phase 7e)', windowsOnly, async (t) => {
  const s = await buildSandbox(t);
  s.plan([UP]);
  const byHand = () => spawn(process.execPath, [FAKE_N8N], {
    env: { ...process.env, FAKE_N8N_DIR: s.dir, FAKE_N8N_PORT: String(s.port) }, stdio: 'ignore', windowsHide: true,
  });

  // n8n started by hand, and no lock file at all: free at once, and no lock file is made.
  byHand();
  await waitFor(() => s.listening(), 'the fake n8n started by hand to listen');
  const noFile = s.runStop();
  assert.equal(noFile.status, 0, noFile.stdout);
  assert.match(s.readLog('stop.log')[0], /stopped PID \d+, port \d+ is free, taskkill exit code 0, lock free after 0 s, exit code 0$/);
  assert.equal(fs.existsSync(s.lockFile), false, 'the stop made no lock file');

  // The same, with a lock file that nobody holds (an earlier launcher left it): free at once.
  fs.writeFileSync(s.lockFile, '');
  byHand();
  await waitFor(() => s.listening(), 'the second fake n8n to listen');
  assert.equal(s.runStop().status, 0);
  assert.match(s.readLog('stop.log')[1], /lock free after 0 s, exit code 0$/);

  // A lock that something else holds for longer: the stop gives up after 10 s, says so, and still exits 0.
  const holderCmd = path.join(s.dir, 'hold-lock.cmd');
  fs.writeFileSync(holderCmd, '@echo off\r\ncall :hold 9>"%~1"\r\nexit /b 0\r\n:hold\r\n"%SystemRoot%\\System32\\ping.exe" -n 40 127.0.0.1 >nul\r\nexit /b 0\r\n');
  const holder = spawn(COMSPEC, ['/d', '/c', `""${holderCmd}" "${s.lockFile}""`], { windowsVerbatimArguments: true, stdio: 'ignore', windowsHide: true });
  const endHolder = () => spawnSync('taskkill', ['/pid', String(holder.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
  try {
    await waitFor(() => s.lockHeld(), 'the holder to take the lock');
    byHand();
    await waitFor(() => s.listening(), 'the third fake n8n to listen');
    const started = Date.now();
    const held = s.runStop();
    const tookMs = Date.now() - started;
    assert.equal(held.status, 0, held.stdout);
    assert.match(held.stdout, /Stopped\. Port \d+ is free\.\r?\nThe launcher still holds logs\\n8n-loop\.lock after 10 seconds: it has not exited yet\. A start right now may exit quietly; wait a moment\./);
    assert.match(s.readLog('stop.log')[2], /port \d+ is free, taskkill exit code 0, lock still held after 10 s: the launcher has not exited yet, exit code 0$/);
    assert.ok(tookMs >= 9000, `the stop waited only ${tookMs} ms`);
    assert.equal(s.lockHeld(), true, 'the holder still has it');
    t.diagnostic(`the stop gave up on the held lock after ${tookMs} ms`);
  } finally {
    endHolder();
    await waitFor(() => !isAlive(holder.pid), 'the holder to end');
  }
  assert.equal(s.lockHeld(), false);
  assert.equal(s.readLog('stop.log').length, 3, 'one line per run');
});

test('n8n gets the launcher\'s environment, .env included, through Start-Process (Phase 7d)', windowsOnly, async (t) => {
  const s = await buildSandbox(t);
  s.plan([{ listen: true, tick: 'node -e "process.stdout.write(JSON.stringify({ fromEnv: process.env.FAKE_N8N_PORT, extra: process.env.LAUNCHER_TEST_EXTRA }))"' }]);
  const launcher = s.launch({ extraEnv: { LAUNCHER_TEST_EXTRA: 'passed on' } });
  const tickResult = path.join(s.dir, 'tick-result.json');
  await waitFor(() => fs.existsSync(tickResult), 'the tick inside the fake n8n to end');
  const tick = JSON.parse(fs.readFileSync(tickResult, 'utf8'));
  assert.equal(tick.code, 0, tick.stderr);
  assert.deepEqual(JSON.parse(tick.stdout), { fromEnv: String(s.port), extra: 'passed on' });
  assert.equal(s.runStop().status, 0);
  assert.equal(await launcher.exited, 0);
});

test('a new start removes a stop flag that an earlier stop left behind', windowsOnly, async (t) => {
  const s = await buildSandbox(t);
  s.plan([CRASH]);
  fs.writeFileSync(path.join(s.logs, 'stop-requested.flag'), 'left over\r\n');
  const launcher = s.launch({ waitS: 1 });
  assert.equal(await launcher.exited, 3, 'the old flag did not turn the crashes into a stop');
  assert.equal(s.starts().length, 4);
  assert.equal(s.flagExists(), false);
});

test('the launcher refuses to start without .env', windowsOnly, async (t) => {
  const s = await buildSandbox(t);
  s.plan([UP]);
  fs.rmSync(path.join(s.dir, '.env'));
  const launcher = s.launch();
  assert.equal(await launcher.exited, 1);
  assert.match(launcher.output(), /\.env not found in .* - n8n was not started/);
  assert.equal(s.starts().length, 0);
});

test('stop with nothing running says so, and deals with a left-over state file', windowsOnly, async (t) => {
  const s = await buildSandbox(t);
  const nothing = s.runStop();
  assert.equal(nothing.status, 0);
  assert.deepEqual(nothing.stdout.trim().split(/\r?\n/), [
    `Looking for the loop's n8n on 127.0.0.1:${s.port}. This takes a few seconds...`,
    `Nothing was running: no process listens on 127.0.0.1:${s.port}.`,
  ]);
  assert.equal(s.flagExists(), false);

  const stateFile = path.join(s.logs, 'launcher-state.txt');
  fs.writeFileSync(stateFile, 'running\r\n');
  const starting = s.runStop();
  assert.equal(starting.status, 1);
  assert.match(starting.stdout, /the launcher says it started n8n/);
  assert.equal(s.flagExists(), false);

  fs.writeFileSync(stateFile, 'waiting\r\n');
  const leftOver = s.runStop();
  assert.equal(leftOver.status, 0);
  assert.match(leftOver.stdout, /no launcher answered: the file was left over and is removed/);
  assert.equal(fs.existsSync(stateFile), false);
  assert.equal(s.flagExists(), false);

  const stopLog = s.readLog('stop.log');
  assert.equal(stopLog.length, 3, 'one line per run');
  assert.match(stopLog[0], /started by a terminal or a script: nothing was running, exit code 0$/);
});

test('stop does not wait for a key when a script starts it, even with the pause check on', windowsOnly, async (t) => {
  const s = await buildSandbox(t);
  const started = Date.now();
  const r = s.runStop({ N8N_LOOP_NO_PAUSE: undefined });
  assert.equal(r.timedOut, false);
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /Press any key/);
  assert.ok(Date.now() - started < 30000);
  assert.match(s.readLog('stop.log')[0], /started by a terminal or a script: nothing was running/);
});

test('stop refuses a process on the port that is not node.exe', windowsOnly, async (t) => {
  const s = await buildSandbox(t);
  // The port is held by the Node binary under another file name, so "not node.exe" is true.
  const { spawn } = require('node:child_process');
  const holderExe = path.join(s.dir, 'holder.exe');
  try {
    fs.linkSync(process.execPath, holderExe);
  } catch {
    fs.copyFileSync(process.execPath, holderExe);
  }
  const holder = spawn(holderExe, ['-e', `require('node:net').createServer().listen(${s.port}, '127.0.0.1'); setInterval(() => {}, 60000);`],
    { stdio: 'ignore', windowsHide: true });
  t.after(() => new Promise((resolve) => { holder.on('close', resolve); holder.kill(); }));
  await waitFor(() => s.listening(), 'holder.exe to listen');

  const r = s.runStop();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /Refusing: PID \d+ listens on 127\.0\.0\.1:\d+ but is not node\.exe\. Nothing was stopped\./);
  assert.equal(await s.listening(), true);
  assert.equal(s.flagExists(), false);
  await sleep(50);
});
