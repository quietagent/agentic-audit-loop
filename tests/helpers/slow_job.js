'use strict';

// A background job for the job tests: it says that it runs (job.pid), works for a
// while, and says that it finished (job.done). Usage: node slow_job.js <folder> <ms>

const fs = require('node:fs');
const path = require('node:path');

const [dir, ms] = process.argv.slice(2);
fs.writeFileSync(path.join(dir, 'job.pid'), String(process.pid));
setTimeout(() => fs.writeFileSync(path.join(dir, 'job.done'), new Date().toISOString()), Number(ms));
