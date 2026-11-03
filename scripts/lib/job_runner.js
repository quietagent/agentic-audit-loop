'use strict';

// Runs one background job and keeps its record, for every kind of job: a builder
// round, an audit, a goal check. It is started through lib/detach.js, so it has no
// living parent. The one argument is the job as base64 JSON:
//   { id, kind, command, args, cwd, recordFile }
//
// The record exists from the start with status "running". While the command runs,
// heartbeat_at is renewed every 20 seconds: a record that says "running" with an old
// heartbeat belongs to a job that died. At the end the record gets status "ended",
// the command's exit code and what it printed on stdout (run_auditor.js and
// run_builder.js print one JSON object there).
// The record also names this process and the command's process, each with the time
// it started: runner_pid and started_at, child_pid and child_started_at. /abort
// ends exactly these, and only while they are still the same processes.
// The command's stdout and stderr also go to this process's own, the job's log file.
// The command gets this process's environment, which jobs.launchJob() has cleaned.

const { spawn } = require('node:child_process');
const { writeJsonAtomic } = require('./runtime');

const HEARTBEAT_MS = 20 * 1000;
const STDOUT_MAX = 2 * 1024 * 1024;

const job = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const startedAt = new Date();
const record = {
  id: job.id,
  kind: job.kind,
  status: 'running',
  runner_pid: process.pid,
  command: [job.command, ...job.args],
  cwd: job.cwd,
  started_at: startedAt.toISOString(),
  heartbeat_at: startedAt.toISOString(),
  finished_at: null,
  exit_code: null,
  stdout: null,
};

function save() {
  try {
    writeJsonAtomic(job.recordFile, record, { backup: true });
  } catch (err) {
    process.stderr.write(`[job ${job.id}] could not write ${job.recordFile}: ${err.message}\n`);
  }
}

save();
const heartbeat = setInterval(() => {
  record.heartbeat_at = new Date().toISOString();
  save();
}, HEARTBEAT_MS);

let stdout = '';
let ended = false;
function end(code, error) {
  if (ended) return;
  ended = true;
  clearInterval(heartbeat);
  record.status = 'ended';
  record.exit_code = code;
  record.finished_at = new Date().toISOString();
  record.stdout = stdout;
  if (error) record.error = error;
  save();
  process.exitCode = Number.isInteger(code) ? code : 1;
}

const child = spawn(job.command, job.args, {
  cwd: job.cwd,
  env: process.env,
  stdio: ['ignore', 'pipe', 'inherit'],
  windowsHide: true,
});
// For /abort: which process the command is, and since when (see lib/process_tree.js).
if (child.pid) {
  record.child_pid = child.pid;
  record.child_started_at = new Date().toISOString();
  save();
}
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout = (stdout + chunk).slice(-STDOUT_MAX);
  process.stdout.write(chunk);
});
child.on('error', (err) => end(null, `could not start ${job.command}: ${err.message}`));
child.on('close', (code) => end(code, null));
