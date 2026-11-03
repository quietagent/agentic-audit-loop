'use strict';

// Stand-in for the claude CLI in the bot's and the loop's tests: one fake for
// everything the loop starts. What it does follows from its arguments:
//   --version                  prints a version (FAKE_CLAUDE_VERSION=fail: exit 1)
//   auth status --json         prints { "loggedIn": true } (FAKE_CLAUDE_AUTH=out: false)
//   --system-prompt-file ...   an auditor call: it replies as scripted, in AUDITOR.md's format
//   anything else              a builder call: fake_claude_builder.js, in the scripted mode
//
// The script is the JSON file named by FAKE_LOOP_SCRIPT:
//   { "auditor": ["ask", "continue", { "reply": "done", "delayMs": 500 }], "builder": ["ok", "no_handoff"] }
// Call number K of a kind takes entry K of its list. A list that is used up is a
// mistake in the test: the fake then answers with an error. Without a list the
// auditor says CONTINUE and the builder runs in FAKE_BUILDER_MODE (default "ok").
//
// Auditor replies: continue, done, ask, ask_must (one MUST question), ask_default (one
// DEFAULT question), stop, many (CONTINUE with 13 findings),
// invalid (not in the format), error (an API error, exit 1), hang (never ends),
// limit (the plan's usage limit refuses the call: see fake_claude_builder.js;
// "resetInS" is the reset time in seconds from now, "none" leaves it out, and
// "limitType" is the rateLimitType of the refusal, "five_hour" unless given),
// or { "text": "<the whole reply>" }. Its rate_limit_event says 34% of the 5-hour window
// and 12% of the 7-day window are used; "fiveHour" and "sevenDay" give other shares.
// The auditor's output is one event per line, as --output-format stream-json prints it.
// Builder entries: "ok" and the other modes of fake_claude_builder.js, or
// { "mode": "ok", "delayMs": 500, "resetInS": 60, "leak": "<a value to copy into a file>" }.
// Every call is appended to the file named by FAKE_CLAUDE_RECORD.

const fs = require('node:fs');

const argv = process.argv.slice(2);
const scriptFile = process.env.FAKE_LOOP_SCRIPT;
const recordFile = process.env.FAKE_CLAUDE_RECORD;
const FINAL_TASK = 'Final task: overwrite HANDOFF.md in the project root with these sections: What was done, Files changed, '
  + 'How it was verified (exact commands and their real output), Problems and open questions, What\'s left. Report only what you actually did and saw.';

function nextEntry(kind) {
  if (!scriptFile) return null;
  let list = null;
  try {
    list = JSON.parse(fs.readFileSync(scriptFile, 'utf8'))[kind];
  } catch {
    // no script: the defaults
  }
  const counter = `${scriptFile}.${kind}.count`;
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(n + 1));
  if (!Array.isArray(list)) return null;
  if (n >= list.length) return { reply: 'unscripted' };
  return typeof list[n] === 'string' ? { reply: list[n] } : list[n];
}

function record(entry) {
  if (recordFile) fs.appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);
}

function auditReply(reply, { goalCheck, round }) {
  const lines = {
    continue: goalCheck
      ? ['VERDICT: CONTINUE', 'REASON: GOAL.md is clear enough to start.', 'FINDINGS:', '- none', 'NEXT_PROMPT:', 'GOAL.md is clear.']
      : [
        'VERDICT: CONTINUE',
        `REASON: Round ${round} did part of the work.`,
        'FINDINGS:',
        '- hello.js: there is no test yet',
        '- HANDOFF.md: the output of node hello.js is not shown',
        'NEXT_PROMPT:',
        `AUDITOR_PROMPT_MARKER for round ${round + 1}`,
        'Add hello.test.js with one test for hello.js, and run node --test.',
        '',
        FINAL_TASK,
      ],
    many: [
      'VERDICT: CONTINUE',
      `REASON: Round ${round} left a lot open.`,
      'FINDINGS:',
      ...Array.from({ length: 13 }, (_, i) => `- finding number ${i + 1}`),
      'NEXT_PROMPT:',
      `AUDITOR_PROMPT_MARKER for round ${round + 1}`,
      FINAL_TASK,
    ],
    done: ['VERDICT: DONE', 'REASON: Every definition-of-done item has evidence.', 'FINDINGS:', '- none', 'NEXT_PROMPT:', 'DONE_SUMMARY_MARKER hello.js prints hello and has a test.'],
    ask: [
      'VERDICT: ASK_HUMAN',
      'REASON: GOAL.md leaves the greeting to the owner.',
      'FINDINGS:',
      '- none',
      'QUESTIONS:',
      '1. [MUST] Which greeting should hello.js print?',
      '   options: hello | hello, world | A greeting that is long enough to be cut off on a button, so that the list in the message matters',
      '   recommended: hello',
      '2. [DEFAULT] Should the output end with a line break?',
      '   options: Yes | No',
      '   recommended: Yes',
      'NEXT_PROMPT:',
      'ASK_NEXT_MARKER write hello.js once the greeting is chosen.',
    ],
    ask_must: [
      'VERDICT: ASK_HUMAN',
      'REASON: GOAL.md leaves the data file to the owner.',
      'FINDINGS:',
      '- none',
      'QUESTIONS:',
      '1. [MUST] Where should hello.js keep its data file?',
      '   options: In the project folder | In the home folder',
      '   recommended: In the project folder',
      'NEXT_PROMPT:',
      'ASK_MUST_MARKER write the data file once its place is chosen.',
    ],
    ask_default: [
      'VERDICT: ASK_HUMAN',
      'REASON: The output format is easy to change.',
      'FINDINGS:',
      '- none',
      'QUESTIONS:',
      '1. [DEFAULT] Should the output end with a line break?',
      '   options: Yes | No',
      '   recommended: Yes',
      'NEXT_PROMPT:',
      'ASK_DEFAULT_MARKER write hello.js once the format is chosen.',
    ],
    stop: [
      'VERDICT: STOP_FOR_HUMAN',
      'REASON: The same problem failed twice in a row.',
      'FINDINGS:',
      '- hello.js: still prints nothing',
      'NEXT_PROMPT:',
      'STOP_NOTE_MARKER decide whether to fix hello.js by hand.',
    ],
    invalid: ['Everything looks fine to me.'],
  }[reply];
  return lines ? lines.join('\n') : null;
}

function auditor() {
  const entry = nextEntry('auditor') || { reply: 'continue' };
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { stdin += chunk; });
  process.stdin.on('end', () => {
    const goalCheck = /^AUDIT MATERIAL: GOAL CHECK$/m.test(stdin);
    const followup = /^AUDIT MATERIAL: FOLLOW-UP of round (\d+)$/m.exec(stdin);
    const plain = /^AUDIT MATERIAL: round (\d+)$/m.exec(stdin);
    const round = Number((followup || plain || [0, 0])[1]);
    record({
      kind: 'auditor', audit: goalCheck ? 'goal-check' : (followup ? 'followup' : 'round'), round, reply: entry.reply || 'text',
      argv, cwd: process.cwd(), stdin, pid: process.pid, envNames: Object.keys(process.env),
    });
    const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
    const seconds = (fromNow) => Math.round(Date.now() / 1000) + fromNow;
    const rateLimit = (info) => emit({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: entry.limitType || 'five_hour', ...info } });
    const print = (result) => emit({
      type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.02, permission_denials: [], ...result,
    });
    emit({ type: 'system', subtype: 'init', model: 'fake-model-1', tools: ['Read', 'Glob', 'Grep', 'Bash'], mcp_servers: [] });
    setTimeout(() => {
      if (entry.reply === 'hang') {
        setInterval(() => {}, 1000);
      } else if (entry.reply === 'limit') {
        const known = entry.resetInS !== 'none';
        const text = `You've hit your session limit${known ? ' · resets 3:45pm' : ''}`;
        rateLimit({ status: 'rejected', ...(known ? { resetsAt: seconds(Number(entry.resetInS ?? 3600)) } : {}) });
        emit({ type: 'assistant', error: 'rate_limit', message: { role: 'assistant', content: [{ type: 'text', text }] } });
        print({ is_error: true, api_error_status: 429, num_turns: 1, total_cost_usd: 0, result: text });
        process.exitCode = 1;
      } else if (entry.reply === 'error' || entry.reply === 'unscripted') {
        print({
          is_error: true,
          subtype: 'error_during_execution',
          result: entry.reply === 'error' ? 'API Error: overloaded' : 'fake claude: the test\'s script has no entry for this auditor call',
        });
        process.exitCode = 1;
      } else {
        rateLimit({
          status: 'allowed', resetsAt: seconds(3600),
          unifiedWindows: {
            five_hour: { utilization: entry.fiveHour ?? 0.34, resetsAt: seconds(3600) },
            seven_day: { utilization: entry.sevenDay ?? 0.12, resetsAt: seconds(5 * 86400) },
          },
        });
        print({ result: typeof entry.text === 'string' ? entry.text : auditReply(entry.reply, { goalCheck, round }) });
      }
    }, entry.delayMs || 0);
  });
}

function builder() {
  const entry = nextEntry('builder');
  if (entry) {
    process.env.FAKE_BUILDER_MODE = entry.reply === 'unscripted' ? 'crash' : (entry.mode || entry.reply || 'ok');
    if (entry.delayMs) process.env.FAKE_BUILDER_DELAY_MS = String(entry.delayMs);
    if (entry.resetInS !== undefined) process.env.FAKE_LIMIT_RESET_S = String(entry.resetInS);
    if (entry.leak) process.env.FAKE_BUILDER_LEAK = entry.leak;
  }
  require('./fake_claude_builder.js');
}

if (argv[0] === '--version') {
  if (process.env.FAKE_CLAUDE_VERSION === 'fail') {
    process.stderr.write('fake claude: cannot start\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('9.9.9 (Fake Claude)\n');
  }
} else if (argv[0] === 'auth' && argv[1] === 'status') {
  const loggedOut = process.env.FAKE_CLAUDE_AUTH === 'out';
  process.stdout.write(`${JSON.stringify({ loggedIn: !loggedOut, authMethod: loggedOut ? 'none' : 'claude.ai', email: 'someone@example.invalid' })}\n`);
  process.exitCode = loggedOut ? 1 : 0;
} else if (argv.includes('--system-prompt-file')) {
  auditor();
} else {
  builder();
}
