'use strict';

// Ends the processes of one background job, for /abort.
//
// A job's processes are known by the IDs that the job itself wrote down: the runner
// (lib/job_runner.js), the command it runs (run_builder.js or run_auditor.js), and
// for a builder the claude process. A process ID alone proves nothing: Windows hands
// the ID of an ended process to a new one. So next to each ID the job wrote down when
// that process started, and a process is only ended when it is still that one:
//   - a process with that ID exists, and
//   - it was created no later than the job says it started.
// A process that took over the ID after the job's own process ended was created
// later than that, so it is never touched.
// Nothing here goes by a program's name: both n8n instances, the bot and the jobs
// are all node.exe.

const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The job writes its time down just after its process was created: a little slack
// for the clock's steps.
const START_SLACK_MS = 3000;
const QUERY_TIMEOUT_MS = 20000;

// What runs now under these IDs: Map of pid -> { pid, parent, createdAt (ms), name }.
// null when the process list could not be read at all.
function processTable(pids) {
  const ids = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  const table = new Map();
  if (!ids.length) return table;
  if (process.platform === 'win32') {
    const filter = ids.map((pid) => `ProcessId=${pid}`).join(' OR ');
    const script = `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { `
      + "'{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString('o'), $_.Name }";
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: QUERY_TIMEOUT_MS });
    if (r.error || r.status !== 0) return null;
    for (const line of r.stdout.split(/\r?\n/)) {
      const [pid, parent, created, name] = line.trim().split('|');
      const createdAt = Date.parse(created);
      if (/^\d+$/.test(pid || '') && !Number.isNaN(createdAt)) table.set(Number(pid), { pid: Number(pid), parent: Number(parent), createdAt, name: name || '' });
    }
    return table;
  }
  const r = spawnSync('ps', ['-o', 'pid=,ppid=,lstart=,comm=', '-p', ids.join(',')], { encoding: 'utf8', timeout: QUERY_TIMEOUT_MS });
  if (r.error) return null;
  for (const line of r.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
    const createdAt = match ? Date.parse(match[3]) : NaN;
    if (match && !Number.isNaN(createdAt)) table.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), createdAt, name: match[4] });
  }
  return table;
}

// Is the process that runs under this ID now the one the job wrote down?
function sameProcess(found, target) {
  const startedAt = Date.parse(target.startedAt);
  return Boolean(found) && !Number.isNaN(startedAt) && found.createdAt <= startedAt + START_SLACK_MS;
}

// Ends a process and, on Windows, the processes it started. Whether that worked is
// read from the process list afterwards, not from here.
function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: QUERY_TIMEOUT_MS });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // gone already
  }
}

// Ends the processes of a job, each with the processes it started.
//   targets  [{ pid, startedAt, what }], the outermost first
// Returns { killed: [{ pid, what }], skipped: [{ pid, what, why }], error }.
// After the outermost process and its tree are gone, the others are looked up again:
// usually they went with it, and one that did not is ended the same way.
function killJobProcesses(targets) {
  const killed = [];
  const skipped = [];
  let waiting = targets.filter((target) => Number.isInteger(target.pid) && target.pid > 0).map((target) => ({ ...target, tried: false }));
  while (waiting.length) {
    const table = processTable(waiting.map((target) => target.pid));
    if (!table) return { killed, skipped, error: 'the list of running processes could not be read' };
    const next = [];
    let acted = false;
    for (const target of waiting) {
      const found = table.get(target.pid);
      const still = sameProcess(found, target);
      if (target.tried) {
        // What counts is whether the process is gone now. taskkill's own exit code says
        // little: it reports an error for a child that went a moment before its turn.
        if (still) skipped.push({ pid: target.pid, what: target.what, why: 'it could not be ended' });
        else killed.push({ pid: target.pid, what: target.what });
      } else if (!found) {
        skipped.push({ pid: target.pid, what: target.what, why: killed.length ? 'it went with the process above it' : 'it had ended already' });
      } else if (!still) {
        skipped.push({ pid: target.pid, what: target.what, why: `another process has this ID now (${found.name}), and it was left alone` });
      } else if (acted) {
        next.push(target); // looked up again: it may have gone with the tree above it
      } else {
        acted = true;
        killTree(target.pid);
        next.push({ ...target, tried: true });
      }
    }
    waiting = next;
  }
  return { killed, skipped, error: null };
}

module.exports = { killJobProcesses, processTable, sameProcess, START_SLACK_MS };
