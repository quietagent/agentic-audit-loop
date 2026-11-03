'use strict';

// Stand-in for n8n, used by the launcher tests so that start-n8n-loop.cmd and
// stop-n8n-loop.cmd can be tested without the real n8n. The test's copy of the
// launcher runs it in place of n8n.cmd.
//
// FAKE_N8N_DIR holds plan.json, a list of steps: start number N follows step N,
// and every later start follows the last step. Each start is one line in starts.log.
// A step: { listen, listenDelayMs, exitAfterMs, code, tick }
//   listen         open FAKE_N8N_PORT on 127.0.0.1 (exit 1 when the port is taken, as n8n does)
//   listenDelayMs  wait this long before opening the port (a slow start)
//   exitAfterMs    exit with "code" after this long; without it the fake runs until it is killed
//   tick           a command to run once the way n8n's Execute Command node runs one
//                  (spawn with shell: true, wait for "close"); the result goes to tick-result.json

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const dir = process.env.FAKE_N8N_DIR;
const port = Number(process.env.FAKE_N8N_PORT);
const startsFile = path.join(dir, 'starts.log');
const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
const earlier = fs.existsSync(startsFile) ? fs.readFileSync(startsFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;
const step = plan[Math.min(earlier, plan.length - 1)];
fs.appendFileSync(startsFile, `${JSON.stringify({ n: earlier + 1, pid: process.pid, argv: process.argv.slice(2), step })}\n`);

function runTick(command) {
  const started = Date.now();
  const child = spawn(command, { cwd: process.cwd(), shell: true, detached: false });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  child.on('close', (code) => {
    fs.writeFileSync(path.join(dir, 'tick-result.json'), JSON.stringify({ code, stdout, stderr, ms: Date.now() - started }));
  });
}

function afterStart() {
  if (step.tick) runTick(step.tick);
  if (typeof step.exitAfterMs === 'number') setTimeout(() => process.exit(step.code ?? 0), step.exitAfterMs);
  else setInterval(() => {}, 60000);
}

setTimeout(() => {
  if (!step.listen) {
    afterStart();
    return;
  }
  const server = net.createServer((socket) => socket.end());
  server.on('error', () => process.exit(1));
  server.listen(port, '127.0.0.1', afterStart);
}, step.listenDelayMs || 0);
