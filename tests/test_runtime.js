'use strict';

// Tests the bot's secret files (scripts/lib/secrets.js), its runtime folder
// (scripts/lib/runtime.js: state, lock, log) and the project rules (scripts/lib/projects.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { loadToken, loadOwnerChatId, SecretsError } = require('../scripts/lib/secrets');
const { createRuntime, writeFileAtomic, writeJsonAtomic, readJsonSafe, isAlive, LOCK_STALE_MS } = require('../scripts/lib/runtime');
const { createRedactor } = require('../scripts/lib/redact');
const { nameProblem, existingEntry, createProject } = require('../scripts/lib/projects');
const { botSettings, ConfigError, DEFAULT_SECRETS_DIR } = require('../scripts/lib/config');

const TMP = path.join(__dirname, 'tmp', 'runtime');
const TOKEN = '7000000001:CANARYtoken_abcdefghijklmnopqrstuvw';

function folder(t) {
  const dir = path.join(TMP, crypto.randomBytes(5).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return dir;
}

const errorOf = (fn) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
};

// ---- secrets ----

test('the two secret files are read and trimmed, however Notepad saved them', (t) => {
  const dir = folder(t);
  const tokenFile = path.join(dir, 'bot-token.txt');
  const ownerFile = path.join(dir, 'owner-chat-id.txt');
  const variants = [
    Buffer.from(TOKEN),
    Buffer.from(`${TOKEN}\r\n`),
    Buffer.from(`  ${TOKEN}  \n\n`),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${TOKEN}\r\n`)]), // UTF-8 with a mark
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${TOKEN}\r\n`, 'utf16le')]), // "Unicode" in old Notepad
  ];
  for (const bytes of variants) {
    fs.writeFileSync(tokenFile, bytes);
    assert.equal(loadToken(dir), TOKEN);
  }
  fs.writeFileSync(ownerFile, ' 5551234567\r\n');
  assert.equal(loadOwnerChatId(dir), 5551234567);
});

test('a missing or malformed secret file gives a message that names the file and never its content', (t) => {
  const dir = folder(t);
  const missing = errorOf(() => loadToken(dir));
  assert.ok(missing instanceof SecretsError);
  assert.equal(missing.missing, true);
  assert.match(missing.message, /^bot-token\.txt was not found in .*\. Create it with Notepad/);
  assert.match(errorOf(() => loadOwnerChatId(dir)).message, /^owner-chat-id\.txt was not found in .* whoami/);

  const badTokens = ['SECRETMARK', `${TOKEN} SECRETMARK`, `SECRETMARK\n${TOKEN}`, '123:SECRETMARK', `bot${TOKEN}`, ''];
  for (const text of badTokens) {
    fs.writeFileSync(path.join(dir, 'bot-token.txt'), text);
    const err = errorOf(() => loadToken(dir));
    assert.ok(err instanceof SecretsError, `accepted: ${JSON.stringify(text)}`);
    assert.equal(err.missing, false);
    assert.match(err.message, /^bot-token\.txt in .* does not look like a bot token/);
    assert.equal(/SECRETMARK|CANARY/.test(err.message), false, err.message);
  }
  for (const text of ['SECRETMARK', '12 34', '-100123', '0', '12.5', '@SECRETMARK', '']) {
    fs.writeFileSync(path.join(dir, 'owner-chat-id.txt'), text);
    const err = errorOf(() => loadOwnerChatId(dir));
    assert.ok(err instanceof SecretsError, `accepted: ${JSON.stringify(text)}`);
    assert.match(err.message, /^owner-chat-id\.txt in .* must hold one whole number above 0/);
    assert.equal(/SECRETMARK|100123/.test(err.message), false, err.message);
  }
});

test('a Telegram base URL of its own is refused together with the real secrets folder', () => {
  const base = { projectsRoot: 'C:\\Projects', roundCap: 3 };
  assert.equal(botSettings(base, 'x').secretsDir, DEFAULT_SECRETS_DIR);
  assert.equal(botSettings(base, 'x').roundCap, 3);
  assert.equal(botSettings(base, 'x').n8nEnvFile, path.join(__dirname, '..', 'n8n-loop', '.env'));
  for (const roundCap of [undefined, 0, -1, 2.5, '3']) {
    assert.throws(() => botSettings({ ...base, roundCap }, 'x'), /"roundCap" must be a whole number above 0/);
  }
  assert.equal(botSettings(base, 'x').telegramBaseUrl, null);
  assert.throws(() => botSettings({ ...base, telegramBaseUrl: 'http://127.0.0.1:1' }, 'x'), ConfigError);
  assert.throws(() => botSettings({ ...base, telegramBaseUrl: 'http://127.0.0.1:1', secretsDir: DEFAULT_SECRETS_DIR }, 'x'),
    /the real token is never sent to another server/);
  assert.equal(botSettings({ ...base, telegramBaseUrl: 'http://127.0.0.1:1', secretsDir: 'C:\\somewhere\\else' }, 'x').telegramBaseUrl, 'http://127.0.0.1:1');
  assert.throws(() => botSettings({ roundCap: 3 }, 'x'), /"projectsRoot" must be an absolute folder path/);
  assert.throws(() => botSettings({ projectsRoot: 'relative\\folder', roundCap: 3 }, 'x'), /"projectsRoot"/);
});

// ---- state, lock, log ----

test('state is written through a temp file, and a missing state file gives the empty state', (t) => {
  const dir = folder(t);
  const runtime = createRuntime(dir);
  assert.deepEqual(runtime.readState(), { offset: null, conversations: {}, outbox: [], jobs: [], nextId: 1, loop: null });
  assert.equal(runtime.writeState({ ...runtime.readState(), offset: 7 }), true);
  assert.equal(runtime.readState().offset, 7);
  assert.deepEqual(fs.readdirSync(dir), ['state.json'], 'no temp file is left behind');
  writeJsonAtomic(path.join(dir, 'deep', 'er', 'file.json'), { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'deep', 'er', 'file.json'), 'utf8')), { a: 1 });
});

test('a state file of Phase 3a loads as it is: it has no "loop" key, and its offset and jobs are kept', (t) => {
  const dir = folder(t);
  const old = { offset: 734002911, conversations: {}, outbox: [], jobs: [{ id: 1, kind: 'build', name: 'Loop_Smoke_Test', ended: true }], nextId: 2 };
  fs.writeFileSync(path.join(dir, 'state.json'), `${JSON.stringify(old, null, 2)}\n`);
  const runtime = createRuntime(dir);
  assert.deepEqual(runtime.readState(), { ...old, loop: null });
  assert.equal(fs.existsSync(path.join(dir, 'logs')), false, 'nothing was logged: the file is good');
  // The live file after the reset of 2026-10-12: offset 0 is an offset, not a first tick.
  fs.writeFileSync(path.join(dir, 'state.json'), '{\n  "offset": 0,\n  "conversations": {},\n  "outbox": [],\n  "jobs": [],\n  "nextId": 2\n}\n');
  assert.equal(createRuntime(dir).readState().offset, 0);
});

test('every write of the state keeps the file before it as state.json.bak, and an unchanged state is not written again', (t) => {
  const dir = folder(t);
  const runtime = createRuntime(dir);
  const state = runtime.readState();
  state.offset = 1;
  assert.equal(runtime.writeState(state), true);
  state.offset = 2;
  assert.equal(runtime.writeState(state), true);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['state.json', 'state.json.bak']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json.bak'), 'utf8')).offset, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).offset, 2);

  // Nothing changed: no write, the file keeps its time, and the backup is not replaced.
  const before = fs.statSync(path.join(dir, 'state.json')).mtimeMs;
  assert.equal(runtime.writeState(state), false);
  assert.equal(runtime.writeState({ ...state }), false);
  assert.equal(fs.statSync(path.join(dir, 'state.json')).mtimeMs, before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json.bak'), 'utf8')).offset, 1);
  // A fresh process that reads the same file does not write it either.
  const next = createRuntime(dir);
  assert.equal(next.writeState(next.readState()), false);
});

test('a damaged state.json is never fatal: its backup is used, or the bot starts again as on a first tick', (t) => {
  const damage = { '510 zero bytes': Buffer.alloc(510), 'half a JSON': Buffer.from('{"offset": 5, "conv'), empty: Buffer.alloc(0), 'the wrong JSON': Buffer.from('[1, 2]'), 'a wrong field': Buffer.from('{"offset": "five"}') };
  for (const [what, bytes] of Object.entries(damage)) {
    const dir = folder(t);
    const file = path.join(dir, 'state.json');
    const runtime = createRuntime(dir);
    const logLines = () => (fs.existsSync(runtime.logFile) ? fs.readFileSync(runtime.logFile, 'utf8').trim().split('\n') : []);

    // With a good backup.
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ offset: 41, nextId: 9 }));
    fs.writeFileSync(file, bytes);
    const recovered = runtime.readState();
    assert.equal(recovered.offset, 41, what);
    assert.equal(recovered.nextId, 9, what);
    assert.equal(logLines().length, 1, what);
    assert.match(logLines()[0], /state recovered: state\.json was .*, moved aside as state\.json\.corrupt-\d{8}-\d{6}; state\.json\.bak was used$/);
    const aside = fs.readdirSync(dir).filter((name) => name.startsWith('state.json.corrupt-'));
    assert.equal(aside.length, 1, what);
    assert.deepEqual(fs.readFileSync(path.join(dir, aside[0])), bytes, 'the damaged file is kept to look at');
    // The next write makes the file whole again, and the good backup stays.
    assert.equal(runtime.writeState(recovered), true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).offset, 41);
    assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).offset, 41);

    // With a backup that is damaged too, and with none.
    fs.writeFileSync(file, bytes);
    fs.writeFileSync(`${file}.bak`, bytes);
    assert.equal(runtime.readState().offset, null, what);
    assert.match(logLines()[1], /state lost: state\.json was .*; state\.json\.bak was .*; starting again as a first tick$/);
    fs.writeFileSync(file, bytes);
    assert.equal(runtime.readState().offset, null, what);
    assert.match(logLines()[2], /state lost: state\.json was .*; there is no state\.json\.bak; starting again as a first tick$/);
    assert.equal(fs.existsSync(file), false, 'the damaged file is out of the way');

    // repair false (whoami) changes and logs nothing.
    fs.writeFileSync(file, bytes);
    const before = fs.readdirSync(dir).sort();
    assert.equal(runtime.readState({ repair: false }).offset, null);
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
    assert.equal(logLines().length, 3);
  }
});

test('a state.json that is missing while its backup is there is read from the backup', (t) => {
  // That is the moment between the two renames of a write.
  const dir = folder(t);
  fs.writeFileSync(path.join(dir, 'state.json.bak'), JSON.stringify({ offset: 77 }));
  const runtime = createRuntime(dir);
  assert.equal(runtime.readState().offset, 77);
  assert.match(fs.readFileSync(runtime.logFile, 'utf8'), /state recovered: state\.json was missing; state\.json\.bak was used\n$/);
});

test('writeFileAtomic flushes to disk, keeps the last good copy as .bak, and never makes a damaged file the backup', (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'record.json');
  const realFsync = fs.fsyncSync;
  let flushed = 0;
  fs.fsyncSync = (fd) => {
    flushed += 1;
    return realFsync(fd);
  };
  t.after(() => { fs.fsyncSync = realFsync; });

  writeJsonAtomic(file, { n: 1 }, { backup: true });
  assert.equal(flushed, 1, 'the temp file is flushed before it is renamed');
  assert.deepEqual(fs.readdirSync(dir), ['record.json'], 'no backup of nothing');
  writeJsonAtomic(file, { n: 2 }, { backup: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { n: 1 });

  // The file is damaged behind our back: the next write does not turn it into the backup.
  fs.writeFileSync(file, Buffer.alloc(64));
  writeJsonAtomic(file, { n: 3 }, { backup: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 3 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { n: 1 }, 'the last good copy is still the backup');
  assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith('record.json.corrupt-')).length, 1);
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false, 'no temp file is left behind');

  // Without backup, as for text files: only the file itself.
  const text = path.join(dir, 'plain.md');
  writeFileAtomic(text, 'one\n');
  writeFileAtomic(text, 'two\n');
  assert.equal(fs.readFileSync(text, 'utf8'), 'two\n');
  assert.equal(fs.existsSync(`${text}.bak`), false);
});

test('readJsonSafe never throws: it says where the value came from and what it found', (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'job.json');
  assert.deepEqual(readJsonSafe(file), { value: null, text: null, source: 'none', note: null, busy: false, damaged: false });
  fs.writeFileSync(file, '{"status":"running"}');
  const good = readJsonSafe(file);
  assert.deepEqual([good.value, good.source, good.note, good.damaged], [{ status: 'running' }, 'file', null, false]);

  // Damaged, no backup. Without repair nothing is moved.
  fs.writeFileSync(file, '{"status":');
  const bad = readJsonSafe(file);
  assert.deepEqual([bad.value, bad.source, bad.damaged, bad.busy], [null, 'none', true, false]);
  assert.equal(bad.note, 'job.json was not valid JSON (10 bytes); there is no job.json.bak');
  assert.deepEqual(fs.readdirSync(dir), ['job.json']);

  // Damaged, with a backup, and with repair.
  fs.writeFileSync(`${file}.bak`, '{"status":"ended"}');
  const repaired = readJsonSafe(file, { repair: true });
  assert.deepEqual([repaired.value, repaired.source, repaired.damaged], [{ status: 'ended' }, 'backup', true]);
  assert.match(repaired.note, /^job\.json was not valid JSON \(10 bytes\), moved aside as job\.json\.corrupt-\d{8}-\d{6}; job\.json\.bak was used$/);
  assert.equal(fs.existsSync(file), false);
  // Missing, with a backup: the moment between the two renames of a write. Not damage.
  const between = readJsonSafe(file, { repair: true });
  assert.deepEqual([between.value, between.source, between.damaged], [{ status: 'ended' }, 'backup', false]);
  // A check of the caller's own: valid JSON of the wrong shape counts as damaged too.
  fs.writeFileSync(file, '{"status":"ended"}');
  fs.writeFileSync(`${file}.bak`, '{"id":7}');
  const checked = readJsonSafe(file, { check: (value) => (value.id ? null : 'not a record') });
  assert.deepEqual([checked.value, checked.source, checked.note], [{ id: 7 }, 'backup', 'job.json was not a record; job.json.bak was used']);
});

test('the lock lets one tick in: a second one is turned away until the first releases it', (t) => {
  const runtime = createRuntime(folder(t));
  const release = runtime.acquireLock();
  assert.equal(typeof release, 'function');
  assert.equal(runtime.acquireLock(), null);
  release();
  const again = runtime.acquireLock();
  assert.equal(typeof again, 'function');
  again();
  assert.equal(fs.existsSync(runtime.lockFile), false);
});

test('a stale lock is taken over: its process is gone, or it is older than two minutes', (t) => {
  const runtime = createRuntime(folder(t));
  const ended = spawnSync(process.execPath, ['-e', '']);
  assert.equal(isAlive(ended.pid), false);
  const old = (ms) => {
    const when = new Date(Date.now() - ms);
    fs.utimesSync(runtime.lockFile, when, when);
  };

  // Held by a process that has ended, written 5 seconds ago.
  fs.writeFileSync(runtime.lockFile, JSON.stringify({ pid: ended.pid, at: Date.now() - 5000 }));
  old(5000);
  const first = runtime.acquireLock();
  assert.equal(typeof first, 'function', 'a lock of a dead process is taken over');
  first();

  // Held by a living process (this one), but far too old.
  fs.writeFileSync(runtime.lockFile, JSON.stringify({ pid: process.pid, at: 0 }));
  old(LOCK_STALE_MS + 5000);
  const second = runtime.acquireLock();
  assert.equal(typeof second, 'function', 'a lock older than two minutes is taken over');
  second();

  // Held by a living process and fresh: not stale.
  fs.writeFileSync(runtime.lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.equal(runtime.acquireLock(), null);
  const lines = fs.readFileSync(runtime.logFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /took over a stale lock \(pid \d+, \d+ s old\)$/);
});

test('every log line has the time, goes through the token filter and stays on one line', (t) => {
  const runtime = createRuntime(folder(t), createRedactor([TOKEN]));
  runtime.log(`failed: https://api.telegram.org/bot${TOKEN}/getUpdates\nsecond line`);
  const text = fs.readFileSync(runtime.logFile, 'utf8');
  assert.match(text, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d failed: https:\/\/api\.telegram\.org\/bot<bot-token>\/getUpdates \| second line\n$/);
});

test('the log starts a new file above 1 MB and keeps the one before', (t) => {
  const runtime = createRuntime(folder(t));
  fs.mkdirSync(path.dirname(runtime.logFile), { recursive: true });
  fs.writeFileSync(runtime.logFile, 'x'.repeat(1024 * 1024 + 1));
  runtime.log('after the rotation');
  assert.equal(fs.statSync(`${runtime.logFile}.1`).size, 1024 * 1024 + 1);
  assert.match(fs.readFileSync(runtime.logFile, 'utf8'), /after the rotation\n$/);
});

// ---- projects ----

test('a project name: letters, digits, "-" and "_", up to 40 characters, no Windows device name', () => {
  for (const good of ['Loop_Smoke_Test', 'a', 'A-1_b', '9lives', 'x'.repeat(40), 'console', 'com10', 'nulls']) {
    assert.equal(nameProblem(good), null, good);
  }
  const bad = ['', 'x'.repeat(41), 'has space', 'dot.name', 'slash/name', 'back\\slash', '..', 'ünïcode', 'semi;colon', 'quote"', '-leading', '_leading',
    'CON', 'con', 'PRN', 'AUX', 'nul', 'COM1', 'com9', 'LPT1', 'lpt0'];
  for (const name of bad) assert.equal(typeof nameProblem(name), 'string', `accepted: ${JSON.stringify(name)}`);
  assert.equal(typeof nameProblem(undefined), 'string');
});

test('createProject makes the folder, the repo, the commit "Loop: GOAL.md" and the first prompt', (t) => {
  const root = folder(t);
  const { dir, commit } = createProject({ root, name: 'Demo_1', goal: '# GOAL\nBuild it.', prompt: 'Start here.\n' });
  assert.equal(dir, path.join(root, 'Demo_1'));
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout.trim();
  assert.equal(git('log', '--format=%s'), 'Loop: GOAL.md');
  assert.equal(git('rev-parse', '--short', 'HEAD'), commit);
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['.gitignore', 'GOAL.md']);
  // .audit/ holds the loop's records, .env is the usual home of secrets: neither is ever committed.
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '.audit/\n.env\n');
  fs.writeFileSync(path.join(dir, '.env'), 'KEY=value\n');
  assert.equal(git('status', '--porcelain'), '', '.env is ignored too');
  assert.equal(fs.readFileSync(path.join(dir, 'GOAL.md'), 'utf8'), '# GOAL\nBuild it.\n');
  assert.equal(fs.readFileSync(path.join(dir, '.audit', 'round-01-prompt.md'), 'utf8'), 'Start here.\n');
  assert.equal(git('status', '--porcelain'), '', '.audit/ is ignored, so the tree is clean');
});

test('createProject refuses a name that exists in any letter case, and leaves nothing behind when it fails', (t) => {
  const root = folder(t);
  fs.mkdirSync(path.join(root, 'Existing'));
  assert.equal(existingEntry(root, 'EXISTING'), 'Existing');
  assert.equal(existingEntry(root, 'other'), null);
  assert.throws(() => createProject({ root, name: 'existing', goal: 'g', prompt: 'p' }), /"Existing" already exists/);
  assert.throws(() => createProject({ root, name: 'bad name', goal: 'g', prompt: 'p' }), /may only have letters/);
  assert.throws(() => createProject({ root: path.join(root, 'missing'), name: 'x', goal: 'g', prompt: 'p' }), /does not exist/);
  // A step that fails after the folder was made: the folder is removed again.
  assert.throws(() => createProject({ root, name: 'Broken', goal: 'g', prompt: undefined }));
  assert.deepEqual(fs.readdirSync(root), ['Existing']);
});
