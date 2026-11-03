'use strict';

// A sandbox for start-n8n-loop.cmd and stop-n8n-loop.cmd: copies of the two scripts
// in a scratch folder, with a fake n8n (tests/helpers/fake_n8n.js) and a port of
// their own. Only two things differ from the real scripts: the path of n8n.cmd, and
// the port number 5690.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REAL = path.join(ROOT, 'n8n-loop');
const FAKE_N8N = path.join(__dirname, 'fake_n8n.js');
const TMP = path.join(ROOT, 'tests', 'tmp', 'launcher');
const COMSPEC = process.env.ComSpec || 'cmd.exe';
const N8N_CMD = '"%APPDATA%\\npm\\n8n.cmd"';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(check, what, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Whether a process holds the launcher's lock file open (Phase 7d). The launcher opens it
// for writing and lets nobody else write it, so opening it for writing here fails while
// it is held. Not on the disk counts as not held. Never call it while a launcher starts:
// for that moment this check holds the file itself.
function isLockHeld(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r+');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) return true;
    throw err;
  }
  fs.closeSync(fd);
  return false;
}

// The way Explorer starts a .cmd file: cmd.exe /c ""<full path>" "
function explorerArgs(file) {
  return ['/c', `""${file}" "`];
}

async function buildSandbox(t) {
  const dir = path.join(TMP, crypto.randomBytes(5).toString('hex'), 'n8n-loop');
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const port = await freePort();

  const startSource = fs.readFileSync(path.join(REAL, 'start-n8n-loop.cmd'), 'utf8');
  const stopSource = fs.readFileSync(path.join(REAL, 'stop-n8n-loop.cmd'), 'utf8');
  assert.equal(startSource.split(N8N_CMD).length, 2, 'the launcher calls n8n.cmd exactly once');
  assert.ok(startSource.includes('5690') && stopSource.includes('5690'), 'both scripts name port 5690');
  const fakeCmd = path.join(dir, 'fake-n8n.cmd');
  const start = path.join(dir, 'start-n8n-loop.cmd');
  const stop = path.join(dir, 'stop-n8n-loop.cmd');
  fs.writeFileSync(start, startSource.replace(N8N_CMD, `"${fakeCmd}"`).replaceAll('5690', String(port)));
  fs.writeFileSync(stop, stopSource.replaceAll('5690', String(port)));
  fs.copyFileSync(path.join(REAL, 'launcher-util.js'), path.join(dir, 'launcher-util.js'));
  fs.writeFileSync(fakeCmd, `@"${process.execPath}" "${FAKE_N8N}" %*\r\n`);
  fs.writeFileSync(path.join(dir, '.env'), `# test settings\r\nFAKE_N8N_DIR=${dir}\r\nFAKE_N8N_PORT=${port}\r\n`);

  const children = new Set();
  const env = (extra) => {
    const merged = { ...process.env, N8N_LOOP_NO_PAUSE: '1', ...extra };
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    return merged;
  };
  const readLog = (name) => {
    const file = path.join(logs, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  };
  const starts = () => {
    const file = path.join(dir, 'starts.log');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  };
  const state = () => {
    const file = path.join(logs, 'launcher-state.txt');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
  };

  // Starts the launcher and returns { exited: Promise<exit code>, output() }.
  function launch({ waitS = 1, longRunS, cwd, extraEnv = {} } = {}) {
    const child = spawn(COMSPEC, explorerArgs(start), {
      cwd: cwd || dir,
      env: env({ ...extraEnv, N8N_LOOP_TEST_RESTART_WAIT_S: String(waitS), N8N_LOOP_TEST_LONG_RUN_S: longRunS === undefined ? undefined : String(longRunS) }),
      windowsVerbatimArguments: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise((resolve) => { child.on('close', (code) => { children.delete(child); resolve(code); }); });
    return { child, exited, output: () => output };
  }

  // Runs the stop script and returns { status, stdout }. extraEnv may switch the pause check back on.
  function runStop(extraEnv = {}) {
    const r = spawnSync(COMSPEC, explorerArgs(stop), {
      cwd: ROOT,
      env: env(extraEnv),
      windowsVerbatimArguments: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 60000,
    });
    return { status: r.status, stdout: `${r.stdout || ''}${r.stderr || ''}`, timedOut: Boolean(r.error) };
  }

  t.after(async () => {
    // Whatever a failed test left behind: the fake n8n processes this sandbox started.
    for (const entry of starts()) {
      if (isAlive(entry.pid)) spawnSync('taskkill', ['/pid', String(entry.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    }
    for (const child of children) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    await sleep(200);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  return {
    dir, logs, port, start, stop,
    plan: (steps) => fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(steps)),
    launch, runStop, readLog, starts, state,
    flagExists: () => fs.existsSync(path.join(logs, 'stop-requested.flag')),
    listening: () => isListening(port),
    lockFile: path.join(logs, 'n8n-loop.lock'),
    lockHeld: () => isLockHeld(path.join(logs, 'n8n-loop.lock')),
  };
}

module.exports = { buildSandbox, waitFor, sleep, isAlive, isListening, isLockHeld, freePort, explorerArgs, ROOT, COMSPEC };
