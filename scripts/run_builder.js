#!/usr/bin/env node
'use strict';

// Runs one builder round on a project, the way the loop runs it: `claude -p` in the
// project folder, in a fresh session. On stdin claude gets the fixed preface
// (templates/BUILDER_PREFACE.md), then the owner's decisions, when there are any,
// then the round's prompt: see lib/builder_input.js.
// Usage: node scripts/run_builder.js --project <path> --round <n> [--config <file>]
// stdout carries one JSON object, the summary; logs go to stderr.
// Exit codes: 0 = claude ended with a result (done, or stopped at the turn limit),
// 1 = claude failed or ended without a result, 2 = bad input,
// 3 = the call ended because the plan's usage limit was reached (status "usage_limit").
//
// Records, in <project>/.audit/ (N = the round, two digits):
//   round-NN-builder-input.md  exactly what claude got on stdin, saved before it starts
//   round-NN-builder.jsonl  every event claude printed, as it came
//   round-NN-builder.log    one readable line per step, written while the round runs
//   round-NN-builder.json   the summary; it exists from the start with status "running"
//
// There is no time limit: a round is never cut off halfway.
// Everything written here goes through a filter that replaces the values of the
// project's .env (lib/project_env.js): the builder works with those keys, so they
// can turn up in what it prints.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { findClaude, spawnClaude, modelArgs, describeModel } = require('./lib/claude_process');
const { createTracker } = require('./lib/builder_events');
const { readConfig, builderSettings, ConfigError, DEFAULT_CONFIG } = require('./lib/config');
const { writeFileAtomic, localStamp } = require('./lib/runtime');
const { roundFile } = require('./lib/projects');
const { buildInput, decisionsPart } = require('./lib/builder_input');
const { projectRedactor } = require('./lib/project_env');
const { guardOutput } = require('./lib/redact');

// Never available to the builder, whatever the config says.
const DISALLOWED_TOOLS = ['WebFetch', 'WebSearch'];
const HEARTBEAT_MS = 20 * 1000;
const USAGE = 'Usage: node scripts/run_builder.js --project <path> --round <n> [--config <file>]';

class InputError extends Error {}

function log(message) {
  process.stderr.write(`[run_builder] ${message}\n`);
}

function parseArgs(argv) {
  const known = ['project', 'round', 'config'];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m || !known.includes(m[1])) throw new InputError(`unknown argument "${argv[i]}"\n${USAGE}`);
    const value = m[2] !== undefined ? m[2] : argv[i += 1];
    if (value === undefined || value === '') throw new InputError(`--${m[1]} needs a value\n${USAGE}`);
    opts[m[1]] = value;
  }
  if (!opts.project) throw new InputError(`--project is required\n${USAGE}`);
  if (!opts.round || !/^[1-9]\d*$/.test(opts.round)) throw new InputError(`--round must be a positive whole number\n${USAGE}`);
  opts.round = Number(opts.round);
  return opts;
}

// The builder's session: locked to the project folder as far as claude's own tools go.
//   --restricted         Read, Edit and Write only inside the working directory
//   --tools              only the tools named in builderAllowedTools exist
//   --allowedTools       and only those rules are approved; dontAsk denies the rest
//   --disallowedTools    WebFetch, WebSearch and builderDeniedTools: git commit, push and
//                        reset, and Read and Edit on .audit\ and .git\ (an Edit rule
//                        covers the Write tool too)
//   --strict-mcp-config  with no MCP config: no MCP server at all
//   --safe-mode          no CLAUDE.md, hooks, plugins or skills from the user or the project
//   --model, --effort    when the config sets them (lib/claude_process.js, as for the auditor)
// The session is saved (no --no-session-persistence): `claude --resume <id>` takes it over.
function builderArgs(settings) {
  const toolNames = [...new Set(settings.allowedTools.map((rule) => rule.replace(/\(.*$/, '').trim()))]
    .filter((name) => !DISALLOWED_TOOLS.includes(name));
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(settings.maxTurns),
    '--tools', ...toolNames,
    '--allowedTools', ...settings.allowedTools,
    '--disallowedTools', ...DISALLOWED_TOOLS, ...settings.deniedTools,
    '--permission-mode', 'dontAsk',
    '--safe-mode',
    '--restricted',
    '--strict-mcp-config',
    ...modelArgs(settings),
  ];
  return args;
}

function fingerprint(file) {
  return fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
}

// Starts claude and feeds every event to onLine as it arrives. onStart gets the
// process, once it exists.
function runClaude(file, args, { cwd, input, onLine, onStart, n8nEnvFile }) {
  return new Promise((resolve) => {
    const child = spawnClaude(file, args, { cwd, n8nEnvFile });
    if (child.pid && onStart) onStart(child);
    let pending = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        if (line.trim()) onLine(line);
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.stdin.on('error', () => {});
    child.on('error', (err) => resolve({ code: null, stderr: `${stderr}${err.message}` }));
    child.on('close', (code) => {
      if (pending.trim()) onLine(pending.trim());
      resolve({ code, stderr });
    });
    child.stdin.end(input, 'utf8');
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const configFile = opts.config ? path.resolve(opts.config) : DEFAULT_CONFIG;
  const settings = builderSettings(readConfig(configFile), configFile);
  const project = path.resolve(opts.project);
  const round = opts.round;

  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) throw new InputError(`project folder not found: ${project}`);
  // .git must be in the project folder itself: a parent repo does not count.
  if (!fs.existsSync(path.join(project, '.git'))) throw new InputError(`not a git repository: ${project}`);
  const file = (suffix) => roundFile(project, round, suffix);
  if (!fs.existsSync(file('prompt.md'))) throw new InputError(`no prompt for round ${round}: ${file('prompt.md')} not found`);
  const prompt = fs.readFileSync(file('prompt.md'), 'utf8');
  if (!prompt.trim()) throw new InputError(`the prompt for round ${round} is empty: ${file('prompt.md')}`);
  for (const suffix of ['builder.json', 'builder.jsonl', 'builder.log', 'builder-input.md']) {
    if (fs.existsSync(file(suffix))) throw new InputError(`round ${round}'s builder already ran: ${file(suffix)} exists`);
  }
  // The values of the project's .env never reach a record, a log or stdout.
  const redact = projectRedactor(project);
  guardOutput(redact);
  // The builder cannot open DECISIONS.md: it is denied .audit/. So the owner's answers
  // are part of its input in every round, between the preface and the prompt. The
  // round's prompt file stays as it is; round-NN-builder-input.md shows what the builder got.
  const decisionsFile = path.join(project, '.audit', 'DECISIONS.md');
  const decisions = fs.existsSync(decisionsFile) ? fs.readFileSync(decisionsFile, 'utf8') : null;
  let input;
  try {
    input = redact(buildInput({ allowedTools: settings.allowedTools, prompt, decisions }));
  } catch (err) {
    throw new InputError(`cannot build the builder's input: ${err.message}`);
  }

  const claude = findClaude();
  const args = builderArgs(settings);
  const handoffFile = path.join(project, 'HANDOFF.md');
  const handoffBefore = fingerprint(handoffFile);
  const startedAt = new Date();
  const tracker = createTracker();

  const summary = {
    round,
    project,
    status: 'running',
    runner_pid: process.pid,
    claude_pid: null,
    claude_started_at: null,
    session_id: null,
    // "model" is the one claude names in its first event; the two after it are what the
    // config asked for (Phase 7c), null for Claude Code's default.
    model: null,
    model_requested: settings.model,
    effort_requested: settings.effort,
    started_at: startedAt.toISOString(),
    heartbeat_at: startedAt.toISOString(),
    finished_at: null,
    duration_s: null,
    exit_code: null,
    result_subtype: null,
    turns: null,
    cost_usd: null,
    context: tracker.context(),
    compacted: false,
    compactions: [],
    handoff_written: null,
    rate_limit: null,
    permission_denials: [],
    tools: null,
    mcp_servers: null,
    decisions_included: decisionsPart(decisions) !== '',
    files: {
      prompt: path.relative(project, file('prompt.md')),
      input: path.relative(project, file('builder-input.md')),
      events: path.relative(project, file('builder.jsonl')),
      log: path.relative(project, file('builder.log')),
    },
  };
  // The loop reads the summary back: it is written so that it survives a power cut.
  const save = () => writeFileAtomic(file('builder.json'), redact(`${JSON.stringify(summary, null, 2)}\n`), { backup: true });
  const logLine = (text) => fs.appendFileSync(file('builder.log'), redact(`${localStamp().slice(0, 19)} ${text}\n`));

  // Saved before claude starts: this file is exactly what the builder was told.
  writeFileAtomic(file('builder-input.md'), input);
  save();
  logLine(`round ${round}: builder starting in ${project}, prompt of ${Buffer.byteLength(prompt, 'utf8')} bytes`
    + `${summary.decisions_included ? ', plus the decisions of the owner' : ''}, input of ${Buffer.byteLength(input, 'utf8')} bytes, at most ${settings.maxTurns} turns`);
  log(`round ${round}: starting ${claude} in ${project}; model ${describeModel(settings)}, maxTurns ${settings.maxTurns}, no time limit`);

  // A sign of life for whoever watches the round: while the status is "running" and
  // heartbeat_at is fresh, the runner is alive. A process ID alone cannot say that,
  // because Windows hands the ID of an ended process to a new one.
  const heartbeat = setInterval(() => {
    summary.heartbeat_at = new Date().toISOString();
    summary.context = tracker.context();
    summary.rate_limit = tracker.rateLimit();
    save();
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const run = await runClaude(claude, args, {
    cwd: project,
    input,
    n8nEnvFile: settings.n8nEnvFile,
    // For /abort: which process claude is, and since when (see lib/process_tree.js).
    onStart: (child) => {
      summary.claude_pid = child.pid;
      summary.claude_started_at = new Date().toISOString();
      save();
    },
    onLine: (line) => {
      fs.appendFileSync(file('builder.jsonl'), redact(`${line}\n`));
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        logLine(`not an event: ${line.slice(0, 200)}`);
        return;
      }
      const hadSession = tracker.seen.sessionId;
      for (const text of tracker.onEvent(event)) logLine(text);
      if (!hadSession && tracker.seen.sessionId) {
        // Saved at once, so that whoever watches the round can name the session.
        summary.session_id = tracker.seen.sessionId;
        summary.model = tracker.seen.model;
        summary.tools = tracker.seen.tools;
        summary.mcp_servers = tracker.seen.mcpServers;
        save();
        log(`session ${summary.session_id}`);
      }
    },
  });

  clearInterval(heartbeat);
  const finishedAt = new Date();
  const result = tracker.seen.result;
  const handoffAfter = fingerprint(handoffFile);
  summary.session_id = tracker.seen.sessionId;
  summary.model = tracker.seen.model;
  summary.tools = tracker.seen.tools;
  summary.mcp_servers = tracker.seen.mcpServers;
  summary.finished_at = finishedAt.toISOString();
  summary.duration_s = Math.round((finishedAt - startedAt) / 100) / 10;
  summary.exit_code = run.code;
  summary.result_subtype = result ? result.subtype : null;
  summary.turns = result ? result.num_turns : null;
  summary.cost_usd = result && Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null;
  summary.context = tracker.context();
  summary.compactions = tracker.seen.compactions;
  summary.compacted = summary.compactions.length > 0;
  summary.handoff_written = handoffAfter !== null && handoffAfter !== handoffBefore;
  summary.permission_denials = tracker.denials();
  summary.rate_limit = tracker.rateLimit();
  const limit = tracker.usageLimit();
  if (limit) {
    // The plan's usage limit ended the round: the loop pauses until it resets.
    summary.status = 'usage_limit';
    summary.resets_at = limit.resets_at;
    summary.usage_limit = limit;
    summary.error = `the plan's usage limit was reached (${limit.message}); it resets at ${limit.resets_at || 'an unknown time'}`;
  } else if (!result) {
    summary.status = 'crashed';
    summary.error = `claude ended with exit code ${run.code} and no result. ${run.stderr.trim().slice(-1000) || 'Nothing on stderr.'}`;
  } else if (result.subtype === 'success' && !result.is_error) {
    summary.status = 'completed';
  } else if (result.subtype === 'error_max_turns') {
    summary.status = 'max_turns';
    summary.error = `the builder was stopped at the turn limit (${settings.maxTurns})`;
  } else {
    summary.status = 'error';
    summary.error = `claude reported an error (${result.subtype}): ${String(result.result || (result.errors || []).join('; ') || '').slice(0, 1000)}`;
  }
  if (!summary.handoff_written) {
    summary.note = 'HANDOFF.md was not written in this round: there is nothing to audit.';
  }
  save();
  logLine(`round ${round}: builder ended: ${summary.status}, exit code ${run.code}, HANDOFF.md ${summary.handoff_written ? 'written' : 'NOT written'}`);
  log(`round ${round}: ${summary.status} in ${summary.duration_s}s, turns=${summary.turns}, cost_usd=${summary.cost_usd}, `
    + `denied_tool_calls=${summary.permission_denials.length}, handoff_written=${summary.handoff_written}`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = { completed: 0, max_turns: 0, usage_limit: 3 }[summary.status] ?? 1;
}

main().catch((err) => {
  log(`error: ${err.message}`);
  process.stdout.write(`${JSON.stringify({ error: err.message })}\n`);
  process.exitCode = err instanceof InputError || err instanceof ConfigError ? 2 : 1;
});
