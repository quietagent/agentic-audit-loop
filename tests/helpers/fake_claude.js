'use strict';

// Stand-in for the claude CLI, used by tests/test_run_auditor.js so that run_auditor
// can be tested without real Claude calls. FAKE_CLAUDE_MODE picks the behaviour and
// every call is appended to the file named by FAKE_CLAUDE_RECORD.

const fs = require('node:fs');

const mode = process.env.FAKE_CLAUDE_MODE || 'valid';
const recordFile = process.env.FAKE_CLAUDE_RECORD;

const VALID_REPLY = [
  'VERDICT: CONTINUE',
  'REASON: add() is done, divide() is missing.',
  'FINDINGS:',
  '- calc.js: no divide()',
  'NEXT_PROMPT:',
  'Implement divide(a, b) in calc.js.',
].join('\n');

// The first "recommended:" is in lower case on purpose: the parser must hand back
// the option's own spelling.
const ASK_REPLY = [
  'VERDICT: ASK_HUMAN',
  'REASON: GOAL.md leaves the division-by-zero behaviour open.',
  'FINDINGS:',
  '- none',
  'QUESTIONS:',
  '1. [MUST] How should divide() handle division by zero?',
  '   options: Throw an Error | Return null | Return Infinity',
  '   recommended: throw an error',
  '2. [DEFAULT] What should the error message say?',
  '   options: Division by zero | Cannot divide by zero',
  '   recommended: Division by zero',
  'NEXT_PROMPT:',
  'ASK_MARKER implement divide() once the questions are answered.',
].join('\n');

const DONE_REPLY = [
  'VERDICT: DONE',
  'REASON: Everything is built.',
  'FINDINGS:',
  '- none',
  'NEXT_PROMPT:',
  'calc.js is complete.',
].join('\n');

function record(entry) {
  if (recordFile) fs.appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);
}

// What the tests check about the environment claude was started with.
function seenEnv() {
  return {
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
    CLAUDECODE: process.env.CLAUDECODE ?? null,
    sessionNames: Object.keys(process.env).filter((name) => /^CLAUDE_(CODE|AGENT_SDK)_/i.test(name)).sort(),
    AUDIT_LOOP_TEST_KEPT: process.env.AUDIT_LOOP_TEST_KEPT ?? null,
  };
}

function callCount() {
  return recordFile ? fs.readFileSync(recordFile, 'utf8').trim().split('\n').length : 1;
}

function reply(text, extra = {}) {
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0, permission_denials: [], result: text, ...extra,
  }));
}

const LIMIT_TEXT = 'You\'ve hit your session limit · resets 3:45pm';
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (mode === 'hang') {
  record({ pid: process.pid });
  setInterval(() => {}, 1000);
} else {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { stdin += chunk; });
  process.stdin.on('end', () => {
    record({ argv: process.argv.slice(2), cwd: process.cwd(), stdin, env: seenEnv(), envNames: Object.keys(process.env) });
    if (mode === 'invalid' || (mode === 'invalid_then_valid' && callCount() === 1)) {
      reply('Everything looks fine to me.');
    } else if (mode === 'error') {
      reply('API Error: overloaded', { is_error: true, subtype: 'error_during_execution' });
      process.exitCode = 1;
    } else if (mode === 'max_turns') {
      // The shape claude 2.1.292 prints when --max-turns stops it: no "result" key, exit code 1.
      process.stdout.write(JSON.stringify({
        type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 31, total_cost_usd: 0, permission_denials: [],
        terminal_reason: 'max_turns', errors: ['Reached maximum number of turns (30)'],
      }));
      process.exitCode = 1;
    } else if (mode === 'text') {
      // Phase 7b: the whole reply, as it is, from the file named by FAKE_CLAUDE_TEXT_FILE,
      // or from file K of the JSON list in FAKE_CLAUDE_TEXT_FILES for call K (the last
      // file for every call after that).
      const files = process.env.FAKE_CLAUDE_TEXT_FILES ? JSON.parse(process.env.FAKE_CLAUDE_TEXT_FILES) : [process.env.FAKE_CLAUDE_TEXT_FILE];
      reply(fs.readFileSync(files[Math.min(callCount(), files.length) - 1], 'utf8'));
    } else if (mode === 'ask') {
      reply(ASK_REPLY);
    } else if (mode === 'done') {
      reply(DONE_REPLY);
    } else if (mode === 'stream') {
      // One event per line, as --output-format stream-json prints: with a rate_limit_event.
      emit({ type: 'system', subtype: 'init', model: 'fake-model-1' });
      emit({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed', resetsAt: 1791778200, rateLimitType: 'five_hour',
          unifiedWindows: { five_hour: { utilization: 0.21, resetsAt: 1791778200 }, seven_day: { utilization: 0.09, resetsAt: 1792263600 } },
        },
      });
      emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: VALID_REPLY }] } });
      emit({
        type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: 0.05, permission_denials: [], result: VALID_REPLY, session_id: 'fake-session',
        modelUsage: { 'fake-model-1': { costUSD: 0.05, contextWindow: 200000 } },
      });
    } else if (mode === 'limit') {
      // The plan's usage limit refuses the call, the way lib/usage_limit.js expects it.
      emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1791778200, rateLimitType: 'five_hour' } });
      emit({ type: 'assistant', error: 'rate_limit', message: { role: 'assistant', content: [{ type: 'text', text: LIMIT_TEXT }] } });
      emit({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, num_turns: 1, total_cost_usd: 0, result: LIMIT_TEXT });
      process.exitCode = 1;
    } else if (mode === 'limit_text') {
      // No event at all: only the text of the result says that it is the limit.
      reply('You\'ve hit your weekly limit · resets Mon 12:00am', { is_error: true });
      process.exitCode = 1;
    } else if (mode === 'leak') {
      // An auditor that repeats a key of the project's .env in its reply.
      const value = /^[A-Z_]+=(.+)$/m.exec(fs.readFileSync('.env', 'utf8'))[1].trim();
      reply(VALID_REPLY.replace('no divide()', `no divide(), and the key is ${value}`).replace('in calc.js.', `in calc.js with the key ${value}.`));
    } else {
      reply(VALID_REPLY);
    }
  });
}
