'use strict';

// Stand-in for the claude CLI in builder mode: it prints stream-json events as
// Claude Code 2.1.292 does, so that run_builder.js and the loop can be tested
// without real Claude calls. FAKE_BUILDER_MODE picks the behaviour:
//   ok          writes hello.js and HANDOFF.md, ends with a success result
//   no_handoff  the same without HANDOFF.md
//   compact     ok, with a compaction on the way
//   context     ok, with a context peak of 85% of the window
//   denied      ok, with one denied tool call
//   outside     ok, with one denied tool call: a Write to C:\Projects\outside_test.txt, a
//               file outside the project folder. Nothing is written there: the call is denied.
//   max_turns   ends with an error_max_turns result and exit code 1
//   crash       prints two events, then exits with code 3 and no result
//   secret      ok, and also writes .env.local and config/secrets/api-token.txt
//   dotenv      ok, and also writes .env
//   leak        ok, and also writes config.js with the value of FAKE_BUILDER_LEAK in it,
//               and repeats that value in a text and in HANDOFF.md
//   usage_limit        the plan's usage limit refuses the call before any work: nothing is written
//   usage_limit_dirty  the same after hello.js was written
//   hang        writes hello.js, then never ends
// The usage limit is printed the way lib/usage_limit.js expects it (what a refused
// call really prints was never seen: see that file): a rate_limit_event with status
// "rejected", an assistant message with error "rate_limit", an error result with
// Claude Code's limit text, and exit code 1. FAKE_LIMIT_RESET_S is the reset time,
// in seconds from now (default 3600); "none" leaves it out.
// FAKE_BUILDER_DELAY_MS makes it wait before it finishes. Every call is appended to
// the file named by FAKE_CLAUDE_RECORD. HANDOFF.md and work.log differ from call to
// call, as the work of two rounds does.

const fs = require('node:fs');
const path = require('node:path');

const mode = process.env.FAKE_BUILDER_MODE || 'ok';
const delayMs = Number(process.env.FAKE_BUILDER_DELAY_MS || 0);
const recordFile = process.env.FAKE_CLAUDE_RECORD;
const SESSION = '11111111-2222-4333-8444-555555555555';
const MODEL = 'fake-model-1';
const LIMIT_TEXT = 'You\'ve hit your session limit \u00b7 resets 3:45pm';

const argv = process.argv.slice(2);
const emit = (event) => process.stdout.write(`${JSON.stringify({ ...event, session_id: SESSION })}\n`);
const usage = (cacheRead, cacheCreation) => ({ input_tokens: 10, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation, output_tokens: 5 });
const assistant = (id, tokens, content, extra = {}) => emit({ type: 'assistant', parent_tool_use_id: null, message: { id, role: 'assistant', content, usage: tokens }, ...extra });
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const seconds = (fromNow) => Math.round(Date.now() / 1000) + fromNow;

function toolsFromArgv() {
  const start = argv.indexOf('--tools') + 1;
  if (!start) return [];
  const end = argv.findIndex((arg, i) => i >= start && arg.startsWith('--'));
  return argv.slice(start, end === -1 ? argv.length : end);
}

// A rate_limit_event as Claude Code 2.1.292 prints it for a call that was allowed.
function rateLimit(status, extra = {}) {
  emit({
    type: 'rate_limit_event',
    rate_limit_info: {
      status,
      resetsAt: seconds(3600),
      rateLimitType: 'five_hour',
      overageStatus: 'allowed',
      isUsingOverage: false,
      unifiedWindows: { five_hour: { utilization: 0.21, resetsAt: seconds(3600) }, seven_day: { utilization: 0.09, resetsAt: seconds(5 * 86400) } },
      ...extra,
    },
  });
}

function result(extra) {
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 3,
    total_cost_usd: 0.0123,
    permission_denials: [],
    modelUsage: { [MODEL]: { contextWindow: 200000, costUSD: 0.0123 } },
    result: 'hello.js is written.',
    ...extra,
  });
}

// The plan's usage limit refuses the call: see the head of this file.
function refuse() {
  const reset = process.env.FAKE_LIMIT_RESET_S;
  const at = reset === 'none' ? {} : { resetsAt: seconds(Number(reset || 3600)) };
  const info = { utilization: 1, ...at };
  // Without a reset time the text names none either: then it is really not known.
  const text = reset === 'none' ? LIMIT_TEXT.replace(/ ·.*$/, '') : LIMIT_TEXT;
  rateLimit('rejected', { ...(reset === 'none' ? { resetsAt: undefined } : at), unifiedWindows: { five_hour: info, seven_day: { utilization: 0.4, resetsAt: seconds(5 * 86400) } } });
  assistant('msg_limit', usage(4000, 1000), [{ type: 'text', text }], { error: 'rate_limit' });
  result({ is_error: true, api_error_status: 429, num_turns: 1, total_cost_usd: 0, result: text });
  process.exit(1);
}

async function main() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) stdin += chunk;
  if (recordFile) {
    fs.appendFileSync(recordFile, `${JSON.stringify({
      kind: 'builder',
      mode,
      argv,
      cwd: process.cwd(),
      stdin,
      pid: process.pid,
      env: {
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
        CLAUDECODE: process.env.CLAUDECODE ?? null,
        sessionNames: Object.keys(process.env).filter((name) => /^CLAUDE_(CODE|AGENT_SDK)_/i.test(name)).sort(),
      },
      envNames: Object.keys(process.env),
    })}\n`);
  }

  emit({ type: 'system', subtype: 'init', cwd: process.cwd(), model: MODEL, tools: toolsFromArgv(), mcp_servers: [], permissionMode: 'dontAsk' });
  emit({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 });
  if (mode === 'usage_limit') refuse();
  const hello = path.join(process.cwd(), 'hello.js');
  // 10 + 4000 + 1000 = 5010 tokens of context on the first call.
  assistant('msg_1', usage(4000, 1000), [{ type: 'thinking', thinking: '' }]);
  assistant('msg_1', usage(4000, 1000), [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: hello, content: "console.log('hello');\n" } }]);
  fs.writeFileSync(hello, "console.log('hello');\n");
  fs.appendFileSync(path.join(process.cwd(), 'work.log'), `call at ${new Date().toISOString()} by ${process.pid}\n`);
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'File created' }] } });

  if (mode === 'crash') {
    process.stderr.write('fake claude: crashing as asked\n');
    process.exit(3);
  }
  if (mode === 'usage_limit_dirty') refuse();
  if (mode === 'hang') {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if (delayMs) await sleep(delayMs);

  if (mode === 'compact') {
    emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } });
  }
  // A call that the session's lock denies: a Read, or (mode "outside") a Write, of a file outside the project folder.
  const deniedCall = { denied: { tool: 'Read', file: 'C:\\somewhere\\else\\secret.txt' }, outside: { tool: 'Write', file: 'C:\\Projects\\outside_test.txt' } }[mode] || null;
  if (deniedCall) {
    const input = deniedCall.tool === 'Write' ? { file_path: deniedCall.file, content: 'test\n' } : { file_path: deniedCall.file };
    assistant('msg_2', usage(9000, 990), [{ type: 'tool_use', id: 'toolu_2', name: deniedCall.tool, input }]);
    emit({ type: 'system', subtype: 'permission_denied', tool_name: deniedCall.tool, tool_use_id: 'toolu_2', decision_reason: '--restricted: path outside the working directory' });
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: `${deniedCall.file} is outside the project` }] } });
  }
  if (mode === 'secret') {
    fs.writeFileSync(path.join(process.cwd(), '.env.local'), 'API_KEY=not-a-real-key\n');
    fs.mkdirSync(path.join(process.cwd(), 'config', 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), 'config', 'secrets', 'api-token.txt'), 'not-a-real-token\n');
  }
  if (mode === 'dotenv') fs.writeFileSync(path.join(process.cwd(), '.env'), 'API_KEY=not-a-real-key\n');
  const leak = mode === 'leak' ? process.env.FAKE_BUILDER_LEAK || '' : '';
  if (leak) {
    // A builder that copies a key from .env into a file, and repeats it in what it says.
    fs.writeFileSync(path.join(process.cwd(), 'config.js'), `module.exports = { key: '${leak}' };\n`);
    assistant('msg_2', usage(9000, 990), [{ type: 'text', text: `I put the key ${leak} into config.js.` }]);
  }
  // 10 + 9000 + 990 = 10000 tokens: the peak. In mode "context" it is 170000 of 200000: 85%.
  const peak = mode === 'context' ? usage(165000, 4990) : usage(9000, 990);
  assistant('msg_2', peak, [{ type: 'tool_use', id: 'toolu_3', name: 'Bash', input: { command: 'node hello.js', description: 'Run it' } }]);
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_3', is_error: false, content: 'hello' }] } });
  if (mode !== 'no_handoff') {
    fs.writeFileSync(path.join(process.cwd(), 'HANDOFF.md'), `# HANDOFF\nhello.js prints hello.${leak ? ` The key is ${leak}.` : ''}\nWritten at ${new Date().toISOString()} by ${process.pid}.\n`);
  }
  rateLimit('allowed');

  if (mode === 'max_turns') {
    result({ subtype: 'error_max_turns', is_error: true, num_turns: 301, result: undefined, errors: ['Reached maximum number of turns (300)'] });
    process.exit(1);
  }
  // 10 + 7000 + 990 = 8000 tokens on the last call.
  assistant('msg_3', usage(7000, 990), [{ type: 'text', text: 'hello.js is written.\nHANDOFF.md says what was done.' }]);
  result(deniedCall
    ? { permission_denials: [{ tool_name: deniedCall.tool, tool_use_id: 'toolu_2', tool_input: { file_path: deniedCall.file } }] }
    : {});
}

main();
