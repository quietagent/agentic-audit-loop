'use strict';

// How the loop starts the claude CLI, for the builder and the auditor alike:
// found on PATH, started without a window, and always with the clean environment
// of clean_env.js (no NODE_OPTIONS, no n8n settings, nothing a Claude Code session sets).

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { cleanEnv } = require('./clean_env');

function findClaude() {
  if (process.platform !== 'win32') return 'claude';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of ['.exe', '.cmd', '.bat']) {
      const candidate = path.join(dir, `claude${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('claude was not found on PATH');
}

// The levels that `claude --effort` takes (Claude Code 2.1.292, `claude --help`).
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// The model and the effort, for the builder and the auditor alike: `--model <name>`
// and `--effort <level>`, each only when it is set; null leaves Claude Code's own
// default. The clean environment drops every CLAUDE_CODE_* variable, so an effort level
// never comes in from outside: this flag is the one way it reaches claude.
function modelArgs({ model = null, effort = null } = {}) {
  if (effort != null && !EFFORT_LEVELS.includes(effort)) throw new Error(`effort must be one of ${EFFORT_LEVELS.join(', ')}, got ${JSON.stringify(effort)}`);
  return [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
}

// The same two in words, for the logs and LOOP_REPORT.md: "claude-opus-5-5, effort xhigh",
// with "Claude Code's default" for what is not set.
function describeModel({ model = null, effort = null } = {}) {
  return `${model || 'Claude Code\'s default'}, ${effort ? `effort ${effort}` : 'effort: Claude Code\'s default'}`;
}

// One argument for a command line that cmd.exe runs. It goes in double quotes, so
// that &, |, < and > in it mean nothing to cmd.
// A double quote inside it is written twice (""): cmd then still sees the whole
// argument as quoted, and the program reads the pair as one quote (the rule of
// Microsoft's C runtime for a quoted argument). Backslashes right before a quote, or at
// the end, are doubled, so that they stay backslashes. A deny rule such as
// Bash(node *"-*) needs this.
// % cannot be passed through a batch file safely at all, and a line break ends the command.
function quoteForCmd(arg) {
  if (/[%\r\n]/.test(arg)) throw new Error(`argument cannot be passed through cmd.exe safely: ${arg}`);
  return `"${arg.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, '$1$1')}"`;
}

// claude.exe is started directly. claude.cmd / claude.bat (npm installs) can only
// run through cmd.exe, so the command line is quoted here and passed verbatim.
// options.env is ignored on purpose: the environment is always the clean one.
// options.n8nEnvFile names the env file of the loop's n8n (default: n8n-loop\.env).
function launchPlan(file, args, { n8nEnvFile, ...options } = {}) {
  const spawnOptions = { ...options, env: cleanEnv(process.env, { envFile: n8nEnvFile }), windowsHide: true };
  if (/\.(cmd|bat)$/i.test(file)) {
    const line = [file, ...args].map(quoteForCmd).join(' ');
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      options: { ...spawnOptions, windowsVerbatimArguments: true },
    };
  }
  return { command: file, args, options: spawnOptions };
}

function spawnClaude(file, args, options = {}) {
  const plan = launchPlan(file, args, options);
  return spawn(plan.command, plan.args, plan.options);
}

function runClaudeSync(file, args, options = {}) {
  const plan = launchPlan(file, args, { encoding: 'utf8', timeout: 30000, ...options });
  return spawnSync(plan.command, plan.args, plan.options);
}

// Can claude be started, and is it logged in? Two short commands, no model call:
// `claude --version` and `claude auth status --json` (Claude Code 2.1.292 prints
// { "loggedIn": true, ... } there). Returns { ok, version } or { ok: false, problem }.
// Nothing else of the status is kept: it names the account.
function checkClaude({ n8nEnvFile } = {}) {
  let file;
  try {
    file = findClaude();
  } catch (err) {
    return { ok: false, problem: err.message };
  }
  const detail = (run) => (run.error ? run.error.message : `exit code ${run.status}${run.stderr && run.stderr.trim() ? `: ${run.stderr.trim().slice(0, 200)}` : ''}`);
  const version = runClaudeSync(file, ['--version'], { n8nEnvFile });
  if (version.error || version.status !== 0) return { ok: false, problem: `"claude --version" failed (${detail(version)})` };
  const auth = runClaudeSync(file, ['auth', 'status', '--json'], { n8nEnvFile });
  let status = null;
  try {
    status = JSON.parse(auth.stdout);
  } catch {
    // handled below
  }
  if (auth.error || !status || typeof status !== 'object') {
    return { ok: false, problem: `"claude auth status --json" gave no answer that can be read (${detail(auth)})` };
  }
  if (status.loggedIn !== true) return { ok: false, problem: 'claude is not logged in: run "claude" on the PC and log in' };
  return { ok: true, version: String(version.stdout).trim() };
}

function killTree(child) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

module.exports = { findClaude, spawnClaude, checkClaude, killTree, quoteForCmd, modelArgs, describeModel, EFFORT_LEVELS };
