'use strict';

// The environment for what the loop starts: its background jobs, and the claude
// processes of the builder and the auditor. It is the caller's environment without
// three kinds of variables:
//
//   - NODE_OPTIONS. The loop's n8n sets it to preload dns-fallback.cjs, and every
//     command n8n runs inherits it. The builder, the auditor and the tests they run
//     in a project must not get a patched DNS lookup.
//   - The settings of the loop's n8n. n8n's Execute Command node passes n8n's own
//     environment to the tick, and that holds everything start-n8n-loop.cmd loaded
//     from n8n-loop\.env. A project that runs n8n in its tests would otherwise use
//     the loop's data folder and port. Removed: every variable named in that file,
//     every N8N_*, NODES_*, EXECUTIONS_*, DB_* and QUEUE_* variable, and three names.
//   - What a Claude Code session sets for the processes it starts. They only show up
//     when the loop is started from inside Claude Code (the tests, a builder at work
//     on this repo). A claude started with them would take itself for a nested child
//     of that session.
//
// Names are compared without regard to case, as Windows does.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_N8N_ENV_FILE = path.resolve(__dirname, '..', '..', 'n8n-loop', '.env');

// Set by Claude Code for the commands its tools run.
const SESSION = [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_JOB_DIR', 'CLAUDE_PREVIEW_CLASSIFIER_FLOOR',
  'AI_AGENT', 'TRACEPARENT',
];
// Set by the app that hosts the session (seen with Claude Desktop 2.31226.1) and passed on.
const HOST = [
  'ANTHROPIC_BASE_URL', 'API_TIMEOUT_MS', 'DISABLE_AUTOUPDATER', 'DISABLE_MICROCOMPACT',
  'MCP_CONNECTION_NONBLOCKING', 'MCP_SERVER_CONNECTION_BATCH_SIZE', 'USE_LOCAL_OAUTH', 'USE_STAGING_OAUTH',
  'BAGGAGE', 'SENTRY-TRACE', 'CHROME_CRASHPAD_PIPE_NAME',
];
// Set by Claude Code's Bash and PowerShell tools for each command.
const SHELL_TOOLS = [
  'GIT_EDITOR', 'GIT_TERMINAL_PROMPT', 'GIT_ASKPASS', 'GCM_INTERACTIVE', 'NO_COLOR', 'COREPACK_ENABLE_AUTO_PIN',
  'NODEFAULTCURRENTDIRECTORYINEXEPATH', 'PSEXECUTIONPOLICYPREFERENCE', 'PYTHONDONTWRITEBYTECODE', 'PYTHONIOENCODING',
  'NODE_USE_SYSTEM_CA',
];
// n8n settings that have none of the prefixes below, and the bot's own switch for dns-fallback.cjs.
const N8N = ['WEBHOOK_URL', 'GENERIC_TIMEZONE', 'DNS_FALLBACK_QUIET'];
const REMOVED_NAMES = new Set(['NODE_OPTIONS', ...SESSION, ...HOST, ...SHELL_TOOLS, ...N8N]);
// Every CLAUDE_CODE_* and CLAUDE_AGENT_SDK_* variable goes, a user-level one included,
// and every variable that n8n reads its settings from.
const REMOVED_PREFIXES = ['CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_', 'N8N_', 'NODES_', 'EXECUTIONS_', 'DB_', 'QUEUE_'];
// Never removed, even when the env file names it: without PATH nothing could be started.
const ALWAYS_KEPT = new Set(['PATH']);

// The names of the variables that an env file like n8n-loop\.env sets, in upper case.
// Only names are read: the part of each line before the first "=", as
// start-n8n-loop.cmd reads the file. No value leaves this function.
// A file that is not there gives no names: n8n was not started from it then.
function envFileNames(file = DEFAULT_N8N_ENV_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return new Set();
  }
  const names = new Set();
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const match = /^([^#=][^=]*)=/.exec(line);
    if (!match || !match[1].trim()) continue;
    // cmd.exe keeps a space before the "=" as part of the name: both spellings go.
    names.add(match[1].toUpperCase());
    names.add(match[1].trim().toUpperCase());
  }
  return names;
}

function isRemoved(name, fileNames = new Set()) {
  const upper = name.toUpperCase();
  if (ALWAYS_KEPT.has(upper)) return false;
  return REMOVED_NAMES.has(upper) || fileNames.has(upper) || REMOVED_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

// envFile: the env file of the loop's n8n. It is read on every call, names only.
function cleanEnv(base = process.env, { envFile = DEFAULT_N8N_ENV_FILE } = {}) {
  const fileNames = envFileNames(envFile || DEFAULT_N8N_ENV_FILE);
  const env = {};
  for (const [name, value] of Object.entries(base)) {
    if (!isRemoved(name, fileNames)) env[name] = value;
  }
  return env;
}

module.exports = { cleanEnv, isRemoved, envFileNames, REMOVED_NAMES, REMOVED_PREFIXES, DEFAULT_N8N_ENV_FILE };
