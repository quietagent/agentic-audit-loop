'use strict';

// Long work runs as a background job: a builder round, an audit, a goal check.
// A tick starts it and returns at once; later ticks read the job's record to see
// where it stands. All kinds of jobs are started and watched by this one file.
//
// A job is `node lib/job_runner.js`, which runs the real command and keeps the
// record: runtime\jobs\job-N.json. The record says "running" with a heartbeat that
// is renewed every 20 seconds, then "ended" with the exit code and what the command
// printed. A process ID cannot prove that a job is alive (Windows hands the ID of an
// ended process to a new one); a fresh heartbeat can.

const path = require('node:path');
const { spawn } = require('node:child_process');
const { cleanEnv } = require('./clean_env');
const { readJsonSafe } = require('./runtime');

const DETACH = path.join(__dirname, 'detach.js');
const JOB_RUNNER = path.join(__dirname, 'job_runner.js');
const JOB_START_GRACE_MS = 60 * 1000;
const JOB_HEARTBEAT_STALE_MS = 90 * 1000;

// Starts `command args` so that it outlives this process and everything above it:
//   - nothing of this process's stdin, stdout or stderr is passed on, so whoever
//     waits for this process's output (n8n's Execute Command node) is not held up;
//   - the job is started by a helper process that ends at once (lib/detach.js), so
//     the job has no living parent to be killed with.
// The job's stdout and stderr are appended to logFile. Nothing is returned: the job
// reports through the files it writes.
function startDetached({ command, args, cwd, logFile, env = process.env }) {
  const job = Buffer.from(JSON.stringify({ command, args, cwd, logFile }), 'utf8').toString('base64');
  const helper = spawn(process.execPath, [DETACH, job], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  helper.unref();
}

// The entry of a new job, as it is saved in the loop's state. Nothing is started yet:
// the caller saves the entry first, so that a job is never running without a trace.
function newJob({ id, kind, runtimeDir, ...extra }) {
  return {
    id,
    kind,
    startedAt: new Date().toISOString(),
    recordFile: path.join(runtimeDir, 'jobs', `job-${id}.json`),
    logFile: path.join(runtimeDir, 'logs', `job-${id}.log`),
    ...extra,
  };
}

// Starts the job's process. It gets the clean environment of clean_env.js: none of
// n8n's settings, no NODE_OPTIONS.
function launchJob(job, { command, args, cwd, n8nEnvFile }) {
  const spec = Buffer.from(JSON.stringify({
    id: job.id, kind: job.kind, command, args, cwd, recordFile: job.recordFile,
  }), 'utf8').toString('base64');
  startDetached({
    command: process.execPath,
    args: [JOB_RUNNER, spec],
    cwd,
    logFile: job.logFile,
    env: cleanEnv(process.env, { envFile: n8nEnvFile }),
  });
}

// Where a job stands, read from its record:
//   starting   no record yet, and the job is young
//   running    the record says running and its heartbeat is fresh
//   ended      the record has a final status
//   lost       no record after a minute, or a "running" one without a sign of life
// A job entry from Phase 3a (kind "build") has no record of this kind: its record
// is the builder's summary (summaryFile), which has the same status and heartbeat.
// onNote gets one line when a damaged record was found and moved aside.
function jobState(job, { now = Date.now(), onNote = null } = {}) {
  const read = readJsonSafe(job.recordFile || job.summaryFile, { repair: true });
  if (read.damaged && onNote) onNote(`job ${job.id}: ${read.note}`);
  const record = read.value;
  if (record && record.status !== 'running') return { phase: 'ended', record };
  // The record could not be opened this time: nothing is known, so nothing is decided.
  if (!record && read.busy) return { phase: 'running', record: null };
  if (!record) return { phase: now - Date.parse(job.startedAt) < JOB_START_GRACE_MS ? 'starting' : 'lost', record: null };
  const fresh = now - Date.parse(record.heartbeat_at || record.started_at) < JOB_HEARTBEAT_STALE_MS;
  return { phase: fresh ? 'running' : 'lost', record };
}

module.exports = { startDetached, newJob, launchJob, jobState, JOB_START_GRACE_MS, JOB_HEARTBEAT_STALE_MS };
