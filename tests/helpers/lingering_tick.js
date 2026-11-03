'use strict';

// Stands in for a tick that is still alive long after it started a job: the worst
// moment for a stop, because the job was started from inside n8n's process tree.
// It starts tests/helpers/slow_job.js, then stays.
// Usage: node lingering_tick.js <folder> <job ms> [one-hop]
//   without "one-hop"  the way the bot starts the builder: jobs.startDetached()
//   with "one-hop"     directly, detached, without the helper process in between

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startDetached } = require('../../scripts/lib/jobs');

const [dir, ms, how] = process.argv.slice(2);
const job = { command: process.execPath, args: [path.join(__dirname, 'slow_job.js'), dir, ms], cwd: dir, logFile: path.join(dir, 'job.log') };
if (how === 'one-hop') {
  const out = fs.openSync(job.logFile, 'a');
  spawn(job.command, job.args, { cwd: job.cwd, detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
} else {
  startDetached(job);
}
fs.writeFileSync(path.join(dir, 'tick.pid'), String(process.pid));
setInterval(() => {}, 60000);
