'use strict';

// The bot's own folder, runtime\ (not in git): its state, its lock and its log.
//   state.json       the update offset, conversations, messages waiting to be sent, old jobs, the active loop
//   state.json.bak   the state file before its last write
//   tick.lock        held by the tick that is running
//   last-tick.txt    when the last tick ran, written at most once a minute
//   logs\bot.log     one line per event; bot.log.1 is the file before the last rotation
//   jobs\job-N.json  the record of background job N (written by lib/job_runner.js)
//
// The JSON files that are written and read back must survive a power cut or a hard
// restart. This file has the two halves of that, for the bot, the loop and the jobs:
//   writing   The content goes to a temp file, is flushed to the disk (fsync), and
//             only then takes the file's name. A rename alone is not enough on
//             Windows: it can reach the disk before the data does. The file that is
//             replaced is kept as <name>.bak.
//   reading   A file that is empty, all zero bytes or not valid JSON is never fatal.
//             It is moved aside as <name>.corrupt-<time>, and <name>.bak is used.

const fs = require('node:fs');
const path = require('node:path');

const LOG_MAX_BYTES = 1024 * 1024;
const LOCK_STALE_MS = 2 * 60 * 1000;
const TEMP_STALE_MS = 10 * 60 * 1000;
const LAST_TICK_EVERY_MS = 60 * 1000;

function localStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} `
    + `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())} ${offset < 0 ? '-' : '+'}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const isBusy = (err) => ['EPERM', 'EBUSY', 'EACCES'].includes(err.code);

// Windows refuses a rename for a moment while another program (a virus scanner,
// a reader) has the target open. A few tries get past that.
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= 20 || !isBusy(err)) throw err;
      sleepMs(25);
    }
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const objectProblem = (value) => (isPlainObject(value) ? null : 'not a JSON object');

// What a JSON file holds, without ever throwing:
//   { state: 'ok', value, text }
//   { state: 'missing' }
//   { state: 'busy', why }   it could not be opened, even after a few tries
//   { state: 'bad', why }    empty, all zero bytes, not valid JSON, or refused by `check`
// check(value) returns null for a good value, else the reason.
function inspectJson(file, check = objectProblem) {
  let bytes;
  for (let attempt = 0; ; attempt += 1) {
    try {
      bytes = fs.readFileSync(file);
      break;
    } catch (err) {
      if (err.code === 'ENOENT') return { state: 'missing', why: 'missing' };
      if (attempt >= 5 || !isBusy(err)) return { state: 'busy', why: `could not be read (${err.code || err.message})` };
      sleepMs(25);
    }
  }
  if (!bytes.length) return { state: 'bad', why: 'empty' };
  if (bytes.every((byte) => byte === 0)) return { state: 'bad', why: `${bytes.length} zero bytes` };
  const text = bytes.toString('utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: 'bad', why: `not valid JSON (${bytes.length} bytes)` };
  }
  const problem = check(value);
  return problem ? { state: 'bad', why: problem } : { state: 'ok', value, text };
}

// Moves a damaged file out of the way as <name>.corrupt-<time>, so that it can be
// looked at later and can never be read again. Returns the new path, or null.
function moveAside(file) {
  const stamp = localStamp().slice(0, 19).replace(/[-:]/g, '').replace(' ', '-');
  let target = `${file}.corrupt-${stamp}`;
  for (let n = 2; fs.existsSync(target); n += 1) target = `${file}.corrupt-${stamp}-${n}`;
  try {
    renameWithRetry(file, target);
    return target;
  } catch {
    return null;
  }
}

// Reads a JSON file that this project wrote. It never throws. Returns
// { value, source, note, text, busy, damaged }:
//   source 'file'    the file was good
//   source 'backup'  the file was missing or damaged, and <name>.bak was used
//   source 'none'    nothing usable: value is null
// note is null when all was well, else one line that says what was found and done.
// busy is true when the file could not be opened and there was no backup either:
// then nothing is known about it, and the caller should try again later.
// damaged is true when the file or its backup was there but not usable.
// With repair, a damaged file is moved aside as <name>.corrupt-<time>.
function readJsonSafe(file, { repair = false, check = objectProblem } = {}) {
  const main = inspectJson(file, check);
  if (main.state === 'ok') return { value: main.value, text: main.text, source: 'file', note: null, busy: false, damaged: false };

  const name = path.basename(file);
  const backupFile = `${file}.bak`;
  const backup = inspectJson(backupFile, check);
  const notes = [];
  if (main.state === 'bad') {
    const moved = repair ? moveAside(file) : null;
    notes.push(`${name} was ${main.why}${moved ? `, moved aside as ${path.basename(moved)}` : ''}`);
  } else if (main.state === 'busy') {
    notes.push(`${name} ${main.why}`);
  } else if (backup.state !== 'missing') {
    notes.push(`${name} was missing`);
  }
  if (backup.state === 'ok') {
    notes.push(`${name}.bak was used`);
    return { value: backup.value, text: null, source: 'backup', note: notes.join('; '), busy: false, damaged: main.state === 'bad' };
  }
  if (backup.state === 'bad') {
    const moved = repair ? moveAside(backupFile) : null;
    notes.push(`${name}.bak was ${backup.why}${moved ? `, moved aside as ${path.basename(moved)}` : ''}`);
  } else if (backup.state === 'busy') {
    notes.push(`${name}.bak ${backup.why}`);
  } else if (main.state !== 'missing') {
    notes.push(`there is no ${name}.bak`);
  }
  return {
    value: null,
    text: null,
    source: 'none',
    note: notes.length ? notes.join('; ') : null,
    busy: main.state === 'busy',
    damaged: main.state === 'bad' || backup.state === 'bad',
  };
}

// Before a file is replaced: a good one becomes <name>.bak, a damaged one is moved
// aside, so that <name>.bak always holds the last good copy.
function keepBackup(file, check) {
  const current = inspectJson(file, check);
  if (current.state === 'ok') renameWithRetry(file, `${file}.bak`);
  else if (current.state === 'bad') moveAside(file);
}

// Writes a file so that a power cut cannot leave it half written or empty: temp
// file, flush to disk, rename. With backup (JSON files only), the file it replaces
// is kept as <name>.bak. Between the two renames the file is missing for a moment;
// readJsonSafe() reads <name>.bak then.
function writeFileAtomic(file, content, { backup = false, check = objectProblem } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'w');
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (backup) keepBackup(file, check);
    renameWithRetry(temp, file);
  } catch (err) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // never written, or already renamed
    }
    throw err;
  }
}

function writeJsonAtomic(file, value, options = {}) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

// Adds text to the end of a file and flushes it to the disk.
function appendDurable(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// For a file that must exist and be good: throws on anything else.
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function emptyState() {
  // offset null = no tick has read updates yet. loop = the active loop: { id, name, project, rev }.
  return { offset: null, conversations: {}, outbox: [], jobs: [], nextId: 1, loop: null };
}

// null for a usable state file, else the reason. A file from Phase 3a has no "loop" key.
function stateProblem(value) {
  if (!isPlainObject(value)) return 'not a JSON object';
  const bad = (key) => `not a state file ("${key}" has the wrong type)`;
  if ('offset' in value && value.offset !== null && !(Number.isSafeInteger(value.offset) && value.offset >= 0)) return bad('offset');
  if ('conversations' in value && !isPlainObject(value.conversations)) return bad('conversations');
  if ('outbox' in value && !(Array.isArray(value.outbox) && value.outbox.every(isPlainObject))) return bad('outbox');
  if ('jobs' in value && !(Array.isArray(value.jobs) && value.jobs.every(isPlainObject))) return bad('jobs');
  if ('nextId' in value && !(Number.isSafeInteger(value.nextId) && value.nextId > 0)) return bad('nextId');
  if ('loop' in value && value.loop !== null && !isPlainObject(value.loop)) return bad('loop');
  // Since Phase 4: the loop that ended last, and when the bot was last offline.
  // Since Phase 6: the last usage that a job reported (rate_limit, with seen_at).
  // Since Phase 7b: an outage of Telegram that goes on, and the last one of 5 minutes or more.
  for (const key of ['lastLoop', 'lastOffline', 'lastUsage', 'telegramDown', 'lastTelegramDown']) {
    if (key in value && value[key] !== null && !isPlainObject(value[key])) return bad(key);
  }
  return null;
}

function createRuntime(dir, redact = (text) => text) {
  const stateFile = path.join(dir, 'state.json');
  const lockFile = path.join(dir, 'tick.lock');
  const logFile = path.join(dir, 'logs', 'bot.log');
  // The text of state.json as this process last read or wrote it: an unchanged state is not written again.
  let lastText = null;

  function log(message) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    try {
      if (fs.statSync(logFile).size > LOG_MAX_BYTES) renameWithRetry(logFile, `${logFile}.1`);
    } catch {
      // no log file yet
    }
    const line = redact(String(message)).replace(/\r?\n/g, ' | ');
    fs.appendFileSync(logFile, `${localStamp()} ${line}\n`);
  }

  // One tick at a time. Returns a release function, or null when another tick holds
  // the lock. A lock is stale when its process is gone or when it is older than two
  // minutes: then it is taken over. The takeover renames the old lock first, and
  // only one of two ticks can win that rename.
  function acquireLock() {
    fs.mkdirSync(dir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
        return () => {
          try {
            fs.unlinkSync(lockFile);
          } catch {
            // already gone
          }
        };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      } catch {
        // unreadable or just removed: judged by its age below
      }
      let ageMs = Infinity;
      try {
        ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
      } catch {
        continue; // the holder just released it: try again
      }
      const stale = ageMs > LOCK_STALE_MS || (holder && !isAlive(holder.pid) && ageMs > 1000);
      if (!stale) return null;
      try {
        fs.renameSync(lockFile, `${lockFile}.stale.${process.pid}`);
        fs.unlinkSync(`${lockFile}.stale.${process.pid}`);
        log(`took over a stale lock (pid ${holder ? holder.pid : 'unknown'}, ${Math.round(ageMs / 1000)} s old)`);
      } catch {
        return null; // another tick took it over first
      }
    }
    return null;
  }

  // Temp files of a tick that was killed between its write and its rename.
  function removeOldTempFiles() {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!/^state\.json\.\d+\.\d+\.tmp$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > TEMP_STALE_MS) fs.unlinkSync(file);
      } catch {
        // gone already
      }
    }
  }

  // The saved state. It never throws because of what is in the file:
  //   a damaged state.json is moved aside and state.json.bak is used, with one log line;
  //   when the backup is damaged or missing too, the bot starts again as on a first tick.
  // repair false only reads: nothing is moved, nothing is logged (for whoami).
  // The one case that throws: the file is there but cannot be opened. Then nothing
  // is known, and starting again from nothing would throw the offset away.
  function readState({ repair = true } = {}) {
    if (repair) removeOldTempFiles();
    const read = readJsonSafe(stateFile, { repair, check: stateProblem });
    if (read.busy) throw new Error(`${read.note}: nothing was done, the next tick tries again`);
    lastText = read.source === 'file' ? read.text : null;
    if (read.value) {
      if (read.note && repair) log(`state recovered: ${read.note}`);
      return { ...emptyState(), ...read.value };
    }
    if (read.note && repair) log(`state lost: ${read.note}; starting again as a first tick`);
    return emptyState();
  }

  // Returns false when the state is the same as on disk: then nothing is written.
  function writeState(state) {
    const text = `${JSON.stringify(state, null, 2)}\n`;
    if (text === lastText) return false;
    writeFileAtomic(stateFile, text, { backup: true, check: stateProblem });
    lastText = text;
    return true;
  }

  // When the last tick ran: runtime\last-tick.txt holds one time. state.json is not
  // written by an idle tick, so it cannot say that. The file is written at most once
  // a minute, with a plain write: a missing or damaged one only means "unknown".
  const lastTickFile = path.join(dir, 'last-tick.txt');

  // The time in last-tick.txt, in ms since 1970, or null when it is not known.
  function readLastTick() {
    try {
      const at = Date.parse(fs.readFileSync(lastTickFile, 'utf8').trim());
      return Number.isNaN(at) ? null : at;
    } catch {
      return null;
    }
  }

  // previous is what readLastTick() gave in this tick. Returns true when it wrote.
  function writeLastTick(now, previous) {
    if (previous !== null && now - previous < LAST_TICK_EVERY_MS && now >= previous) return false;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(lastTickFile, `${new Date(now).toISOString()}\n`);
      return true;
    } catch {
      return false; // it only costs the next offline message its start time
    }
  }

  return { dir, stateFile, lockFile, logFile, lastTickFile, log, acquireLock, readState, writeState, readLastTick, writeLastTick };
}

module.exports = {
  createRuntime, writeFileAtomic, writeJsonAtomic, appendDurable, readJson, readJsonSafe, inspectJson, moveAside,
  isAlive, localStamp, emptyState, stateProblem, isPlainObject, LOCK_STALE_MS,
};
