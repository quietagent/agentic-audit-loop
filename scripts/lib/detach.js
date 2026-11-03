'use strict';

// Second hop of jobs.startDetached(): starts the real job and ends at once.
// The job's parent process is then gone, so nothing that kills the tree of the
// tick that asked for it (n8n's stop, taskkill /t) can reach the job.
// The one argument is the job as base64 JSON: { command, args, cwd, logFile }.
// The job gets this process's environment.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const job = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
fs.mkdirSync(path.dirname(job.logFile), { recursive: true });
const out = fs.openSync(job.logFile, 'a');
const child = spawn(job.command, job.args, {
  cwd: job.cwd,
  env: process.env,
  detached: true,
  stdio: ['ignore', out, out],
  windowsHide: true,
});
child.on('error', (err) => {
  fs.writeSync(out, `could not start ${job.command}: ${err.message}\n`);
  process.exit(1);
});
child.unref();
