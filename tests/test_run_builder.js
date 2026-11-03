'use strict';

// Tests run_builder.js end to end against a fake claude that prints stream-json
// (tests/helpers/fake_claude_builder.js), put first on PATH. No real Claude calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createTracker } = require('../scripts/lib/builder_events');
const { buildInput, renderPreface, allowedCommands, otherTools, answersOf, decisionsPart, DECISIONS_HEADING, DECISIONS_INTRO } = require('../scripts/lib/builder_input');

const ROOT = path.resolve(__dirname, '..');
const RUN_BUILDER = path.join(ROOT, 'scripts', 'run_builder.js');
const FAKE_CLAUDE = path.join(__dirname, 'helpers', 'fake_claude_builder.js');
const DEFAULT_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit_loop.config.json'), 'utf8'));
const TMP = path.join(__dirname, 'tmp', 'builder');
const SESSION = '11111111-2222-4333-8444-555555555555';
const PROMPT = 'PROMPT_MARKER create hello.js that prints hello, and write HANDOFF.md\n';

function gitIn(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid',
    '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

// The values that follow a flag on the fake claude's command line.
function valuesOf(argv, flag) {
  const start = argv.indexOf(flag) + 1;
  assert.ok(start > 0, `${flag} missing`);
  const end = argv.findIndex((arg, i) => i >= start && arg.startsWith('--'));
  return argv.slice(start, end === -1 ? argv.length : end);
}

function sandbox(t, { prompt = PROMPT } = {}) {
  const dir = path.join(TMP, crypto.randomBytes(5).toString('hex'));
  const project = path.join(dir, 'project');
  const bin = path.join(dir, 'bin');
  const audit = path.join(project, '.audit');
  fs.mkdirSync(audit, { recursive: true });
  fs.mkdirSync(bin);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "${FAKE_CLAUDE}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`, { mode: 0o755 });
  }
  gitIn(project, 'init', '-q');
  fs.writeFileSync(path.join(project, '.gitignore'), '.audit/\n');
  fs.writeFileSync(path.join(project, 'GOAL.md'), '# GOAL\nA script that prints hello.\n');
  gitIn(project, 'add', '-A');
  gitIn(project, 'commit', '-q', '-m', 'Loop: GOAL.md');
  if (prompt !== null) fs.writeFileSync(path.join(audit, 'round-01-prompt.md'), prompt);

  const recordFile = path.join(dir, 'calls.jsonl');
  const calls = () => (fs.existsSync(recordFile)
    ? fs.readFileSync(recordFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    : []);
  // Every config names a runtime folder of the sandbox's own: the test settings of
  // /testmode are read from there, never from the live bot's runtime\.
  let configs = 0;
  const writeConfig = (overrides) => {
    const file = path.join(dir, `config-${configs += 1}.json`);
    const config = { ...DEFAULT_CONFIG, runtimeDir: path.join(dir, 'runtime'), ...overrides };
    for (const key of Object.keys(config)) if (config[key] === undefined) delete config[key];
    fs.writeFileSync(file, JSON.stringify(config));
    return file;
  };

  function run(args, { mode = 'ok', extraEnv = {} } = {}) {
    const env = { ...process.env, FAKE_BUILDER_MODE: mode, FAKE_CLAUDE_RECORD: recordFile, ...extraEnv };
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
    env[pathKey] = `${bin}${path.delimiter}${env[pathKey]}`;
    const withConfig = args.some((arg) => /^--config(=|$)/.test(arg)) ? args : [...args, '--config', writeConfig({})];
    const r = spawnSync(process.execPath, [RUN_BUILDER, ...withConfig], { env, encoding: 'utf8', timeout: 60000 });
    let json = null;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      // left as null: the test asserts on it
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
  }

  const read = (name) => fs.readFileSync(path.join(audit, name), 'utf8');
  const logLines = () => read('round-01-builder.log').trim().split('\n').map((line) => line.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d /, ''));
  return { dir, project, audit, bin, run, calls, writeConfig, read, logLines };
}

test('a round gives exit 0, the summary on stdout and its records in .audit/', (t) => {
  const s = sandbox(t);
  const r = s.run(['--project', s.project, '--round', '1']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.status, 'completed');
  assert.equal(r.json.round, 1);
  assert.equal(r.json.session_id, SESSION);
  assert.equal(r.json.model, 'fake-model-1');
  assert.equal(r.json.exit_code, 0);
  assert.equal(r.json.result_subtype, 'success');
  assert.equal(r.json.turns, 3);
  assert.equal(r.json.cost_usd, 0.0123);
  assert.equal(r.json.compacted, false);
  assert.equal(r.json.handoff_written, true);
  assert.equal('note' in r.json, false);
  assert.deepEqual(r.json.permission_denials, []);
  assert.deepEqual(r.json.mcp_servers, []);
  assert.ok(Date.parse(r.json.finished_at) >= Date.parse(r.json.started_at));

  assert.deepEqual(fs.readdirSync(s.audit).sort(),
    ['round-01-builder-input.md', 'round-01-builder.json', 'round-01-builder.json.bak', 'round-01-builder.jsonl', 'round-01-builder.log', 'round-01-prompt.md']);
  assert.deepEqual(r.json.files, {
    prompt: path.join('.audit', 'round-01-prompt.md'),
    input: path.join('.audit', 'round-01-builder-input.md'),
    events: path.join('.audit', 'round-01-builder.jsonl'),
    log: path.join('.audit', 'round-01-builder.log'),
  });
  assert.deepEqual(JSON.parse(s.read('round-01-builder.json')), r.json, 'the saved summary is what was printed');
  const events = s.read('round-01-builder.jsonl').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events[0].subtype, 'init');
  assert.equal(events[events.length - 1].type, 'result');
  assert.equal(fs.existsSync(path.join(s.project, 'hello.js')), true);
});

test('the context use comes from the usage of each turn and the window in the result', (t) => {
  const s = sandbox(t);
  const r = s.run(['--project', s.project, '--round', '1']);
  assert.deepEqual(r.json.context, { window: 200000, peak_tokens: 10000, peak_percent: 5, final_tokens: 8000, final_percent: 4 });
});

test('the readable log has one line per step, with the time', (t) => {
  const s = sandbox(t);
  s.run(['--project', s.project, '--round', '1']);
  const raw = s.read('round-01-builder.log').trim().split('\n');
  assert.ok(raw.every((line) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \S/.test(line)), raw.join('\n'));
  const lines = s.logLines();
  assert.match(lines[0], /^round 1: builder starting in .*project, prompt of \d+ bytes, input of \d+ bytes, at most 300 turns$/);
  assert.equal(lines[1], `session ${SESSION} started: model fake-model-1, tools Read Edit Write Glob Grep Bash, 0 MCP servers`);
  assert.equal(lines[2], `Write ${path.join(s.project, 'hello.js')}`);
  assert.equal(lines[3], 'Bash node hello.js');
  assert.equal(lines[4], 'text: hello.js is written. HANDOFF.md says what was done.');
  assert.equal(lines[5], 'result: success, 3 turns, cost $0.0123');
  assert.equal(lines[6], 'round 1: builder ended: completed, exit code 0, HANDOFF.md written');
  assert.equal(lines.length, 7);
});

test('claude gets the prompt on stdin, the project as working directory and the lock-down flags', (t) => {
  const s = sandbox(t);
  s.run(['--project', s.project, '--round', '1']);
  const [call] = s.calls();
  assert.equal(call.stdin, `${renderPreface(DEFAULT_CONFIG.builderAllowedTools)}${PROMPT}`);
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(s.project));
  assert.deepEqual(valuesOf(call.argv, '--output-format'), ['stream-json']);
  assert.deepEqual(valuesOf(call.argv, '--max-turns'), ['300']);
  assert.deepEqual(valuesOf(call.argv, '--tools'), ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']);
  assert.deepEqual(valuesOf(call.argv, '--allowedTools'), DEFAULT_CONFIG.builderAllowedTools);
  assert.deepEqual(valuesOf(call.argv, '--disallowedTools'), ['WebFetch', 'WebSearch', ...DEFAULT_CONFIG.builderDeniedTools]);
  assert.deepEqual(valuesOf(call.argv, '--permission-mode'), ['dontAsk']);
  for (const flag of ['--print', '--verbose', '--safe-mode', '--restricted', '--strict-mcp-config']) {
    assert.ok(call.argv.includes(flag), `${flag} missing`);
  }
  // The session is kept, there is no MCP config, and no session is resumed.
  for (const flag of ['--no-session-persistence', '--mcp-config', '--resume', '--continue', '--add-dir']) {
    assert.equal(call.argv.includes(flag), false, `${flag} must not be passed`);
  }
  // The shipped config's model and effort (Phase 7c): see test_phase7c.js for null.
  assert.deepEqual(valuesOf(call.argv, '--model'), [DEFAULT_CONFIG.model]);
  assert.deepEqual(valuesOf(call.argv, '--effort'), [DEFAULT_CONFIG.effort]);
});

test('the builder\'s input is the fixed preface, then the prompt, and it is saved before claude starts', (t) => {
  const s = sandbox(t);
  const r = s.run(['--project', s.project, '--round', '1']);
  const preface = renderPreface(DEFAULT_CONFIG.builderAllowedTools);
  const input = s.read('round-01-builder-input.md');
  assert.equal(input, `${preface}${PROMPT}`);
  assert.equal(s.calls()[0].stdin, input, 'the saved file is exactly what claude got');
  assert.equal(r.json.decisions_included, false);
  assert.equal(input.includes('The owner\'s decisions'), false, 'without DECISIONS.md nothing is added');
  assert.ok(preface.split('\n').includes('The prompt for this round follows.'));

  // What the preface says, as the owner decided it.
  assert.match(preface, /^# Rules of this session \(fixed, from the loop\)\n/);
  for (const line of [
    '- `node`, alone or followed by arguments',
    '- `npm test`, alone or followed by arguments',
    '- `npm run` followed by arguments',
    '- `git status`, alone or followed by arguments',
    '- `git diff`, alone or followed by arguments',
    '- `git log`, alone or followed by arguments',
    '- One command per Bash call. No `cd`, no `&&`, no `;`, no pipes (`|`) and no redirection (`>`): a call that chains commands is denied as a whole.',
    '- To look at files, use Read, Glob and Grep: `ls`, `cat`, `find` and `grep` are not allowed.',
    '**Your other tools:** Read, Edit, Write, Glob, Grep. They work only inside the project folder. There is no web access.',
    '- commit, push or reset. The loop commits your work when the round ends.',
    '- read or change anything in the `.audit/` folder or in the `.git/` folder. They hold the loop\'s own records and git\'s own files, and every call on them is denied.',
  ]) assert.ok(preface.split('\n').includes(line), line);
  assert.match(preface, /overwrite `HANDOFF\.md` in the project root with these five sections: What was done, Files changed, How it was verified \(exact commands and their real output\), Problems and open questions, What's left\./);
  assert.match(preface, /\n---\n\n$/, 'the preface ends with a line that sets it apart from the prompt');
  assert.equal(/\{\{|\}\}/.test(preface), false, 'no mark of the template is left');

  // A claude that crashes at once still leaves the input on file.
  const crashed = sandbox(t);
  crashed.run(['--project', crashed.project, '--round', '1'], { mode: 'crash' });
  assert.equal(crashed.read('round-01-builder-input.md'), input);
});

test('the list of allowed commands in the preface comes from builderAllowedTools', (t) => {
  const s = sandbox(t);
  const rules = ['Read', 'Write', 'Bash(npm test)', 'Bash(python *)', 'Bash(git status)', 'Bash(git status *)'];
  const r = s.run(['--project', s.project, '--round', '1', '--config', s.writeConfig({ builderAllowedTools: rules })]);
  assert.equal(r.status, 0, r.stderr);
  const { stdin } = s.calls()[0];
  assert.equal(stdin, `${renderPreface(rules)}${PROMPT}`);
  const commands = stdin.slice(stdin.indexOf('**Bash runs only these commands:**'), stdin.indexOf('- One command per Bash call'));
  assert.equal(commands, '**Bash runs only these commands:**\n\n- `npm test`, exactly like this\n- `python` followed by arguments\n- `git status`, alone or followed by arguments\n\n');
  assert.ok(stdin.includes('**Your other tools:** Read, Write. They work only inside the project folder.'));

  assert.deepEqual(allowedCommands(['Read', 'Bash(node)', 'Bash(node *)', 'Grep']), ['- `node`, alone or followed by arguments']);
  assert.deepEqual(otherTools(['Read', 'Bash(node)', 'Edit', 'Read(//c/x/**)']), ['Read', 'Edit']);
  assert.match(renderPreface(['Read']), /- none: Bash is not available/);
  // A template that lost its marks would quietly drop the list.
  assert.throws(() => renderPreface(rules, 'No marks here.'), /has no \{\{ALLOWED_COMMANDS\}\}/);
  assert.throws(() => renderPreface(rules, '{{ALLOWED_COMMANDS}} only'), /has no \{\{OTHER_TOOLS\}\}/);
  assert.throws(() => renderPreface(rules, '{{ALLOWED_COMMANDS}} {{OTHER_TOOLS}}'), /has no \{\{WHAT_FOLLOWS\}\}/);
});

test('every round gets the owner\'s answers from DECISIONS.md, answered and assumed, between the preface and the prompt', (t) => {
  const s = sandbox(t);
  const head = fs.readFileSync(path.join(ROOT, 'templates', 'DECISIONS.template.md'), 'utf8').split(/^## /m)[0];
  const answers = [
    '## Goal check, 2026-10-12',
    '- Q: Which greeting?',
    '  A: DECISION_MARKER hello (answered)',
    '- Q: A line break at the end?',
    '  A: ASSUMED_MARKER Yes (assumed)',
  ].join('\n');
  fs.writeFileSync(path.join(s.audit, 'DECISIONS.md'), `${head}${answers}\n`);
  const preface = renderPreface(DEFAULT_CONFIG.builderAllowedTools, undefined, { withDecisions: true });
  // The heading says whose they are, and that they come from a file the builder cannot open.
  assert.equal(DECISIONS_HEADING, '## The owner\'s decisions (from `.audit/DECISIONS.md`, a file you cannot open)');
  const part = `${DECISIONS_HEADING}\n\n${DECISIONS_INTRO}\n\n${answers.replace('## Goal check', '### Goal check')}\n\n---\n\n`;
  assert.ok(preface.split('\n').includes('The owner\'s decisions follow, then the prompt for this round.'));
  assert.match(preface, /\n---\n\n$/);

  const first = s.run(['--project', s.project, '--round', '1']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(s.calls()[0].stdin, `${preface}${part}${PROMPT}`);
  assert.equal(s.read('round-01-builder-input.md'), s.calls()[0].stdin, 'the round\'s record shows exactly what the builder got');
  assert.equal(s.read('round-01-prompt.md'), PROMPT, 'the round\'s prompt file stays as it is');
  assert.equal(first.json.decisions_included, true);
  assert.match(s.logLines()[0], /prompt of \d+ bytes, plus the decisions of the owner, input of \d+ bytes/);
  // The file's own head speaks to the auditor: it is not passed on.
  assert.equal(s.calls()[0].stdin.includes('The auditor reads it every round'), false);

  // A later round gets them too, with an answer that was added since.
  fs.appendFileSync(path.join(s.audit, 'DECISIONS.md'), '\n## Round 1, 2026-10-13\n- Q: Which colour?\n  A: LATER_MARKER blue (answered)\n');
  fs.writeFileSync(path.join(s.audit, 'round-02-prompt.md'), 'ROUND_TWO_PROMPT without a final line break');
  const second = s.run(['--project', s.project, '--round', '2']);
  assert.equal(second.status, 0, second.stderr);
  const later = s.calls()[1].stdin;
  assert.equal(later, `${preface}${part.replace('\n\n---\n\n', '\n\n### Round 1, 2026-10-13\n- Q: Which colour?\n  A: LATER_MARKER blue (answered)\n\n---\n\n')}ROUND_TWO_PROMPT without a final line break\n`);
  assert.ok(later.indexOf('ASSUMED_MARKER Yes (assumed)') < later.indexOf('ROUND_TWO_PROMPT') && later.indexOf('# Rules of this session') < later.indexOf('DECISION_MARKER'));
  assert.equal(second.json.decisions_included, true);
  assert.equal(s.read('round-02-builder-input.md'), later);

  // When there are none, nothing is added: no file, an empty file, or only the file's head.
  const plain = `${renderPreface(['Read'])}p\n`;
  assert.equal(buildInput({ allowedTools: ['Read'], prompt: 'p', decisions: null }), plain);
  assert.equal(buildInput({ allowedTools: ['Read'], prompt: 'p\n', decisions: '  \n' }), plain);
  assert.equal(buildInput({ allowedTools: ['Read'], prompt: 'p\n', decisions: head }), plain);
  assert.equal(answersOf(head), null);
  assert.equal(decisionsPart(null), '');
  // A file that was written by hand, without a section, counts as a whole, without its title.
  assert.equal(answersOf(`${String.fromCharCode(0xFEFF)}# DECISIONS\r\n\r\nUse tabs.\r\n`), 'Use tabs.');
  const empty = sandbox(t);
  fs.writeFileSync(path.join(empty.audit, 'DECISIONS.md'), head);
  const none = empty.run(['--project', empty.project, '--round', '1']);
  assert.equal(none.json.decisions_included, false);
  assert.equal(empty.calls()[0].stdin, `${renderPreface(DEFAULT_CONFIG.builderAllowedTools)}${PROMPT}`);
});

test('the shipped config keeps the builder to its commands and away from commit, push and reset', () => {
  const allowed = DEFAULT_CONFIG.builderAllowedTools;
  for (const rule of ['Read', 'Edit', 'Write', 'Bash(node *)', 'Bash(npm test)', 'Bash(npm run *)', 'Bash(git status)', 'Bash(git diff *)', 'Bash(git log *)']) {
    assert.ok(allowed.includes(rule), `${rule} missing`);
  }
  for (const rule of ['Bash', 'Bash(*)', 'Bash(git *)', 'WebFetch', 'WebSearch']) {
    assert.equal(allowed.includes(rule), false, `${rule} must not be allowed`);
  }
  assert.equal(allowed.some((rule) => /^mcp__/.test(rule)), false);
  for (const command of ['git commit', 'git push', 'git reset']) {
    assert.ok(DEFAULT_CONFIG.builderDeniedTools.includes(`Bash(${command})`), `${command} is not denied`);
    assert.ok(DEFAULT_CONFIG.builderDeniedTools.includes(`Bash(${command} *)`), `${command} with arguments is not denied`);
  }
  assert.equal(DEFAULT_CONFIG.projectsRoot, 'C:\\Projects');
});

test('config.model is passed as --model, config.effort as --effort, and builderMaxTurns as --max-turns', (t) => {
  const s = sandbox(t);
  const r = s.run(['--project', s.project, '--round', '1', '--config', s.writeConfig({ model: 'some-model', effort: 'max', builderMaxTurns: 7 })]);
  const [call] = s.calls();
  assert.deepEqual(valuesOf(call.argv, '--model'), ['some-model']);
  assert.deepEqual(valuesOf(call.argv, '--effort'), ['max']);
  assert.deepEqual(valuesOf(call.argv, '--max-turns'), ['7']);
  // The summary keeps what was asked for next to the model claude named.
  assert.deepEqual([r.json.model, r.json.model_requested, r.json.effort_requested], ['fake-model-1', 'some-model', 'max']);
});

test('NODE_OPTIONS and the variables of a Claude Code session do not reach claude', (t) => {
  const s = sandbox(t);
  const preload = path.join(s.dir, 'preload.cjs');
  fs.writeFileSync(preload, '');
  const r = s.run(['--project', s.project, '--round', '1'], {
    extraEnv: {
      NODE_OPTIONS: `--require=${preload}`,
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 'outer-session',
      CLAUDE_AGENT_SDK_VERSION: '0.0.0',
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.calls()[0].env, { NODE_OPTIONS: null, CLAUDECODE: null, sessionNames: [] });
});

test('a compaction is recorded, and its token count is the peak', (t) => {
  const s = sandbox(t);
  const r = s.run(['--project', s.project, '--round', '1'], { mode: 'compact' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.compacted, true);
  assert.deepEqual(r.json.compactions, [{ trigger: 'auto', pre_tokens: 150000 }]);
  assert.deepEqual(r.json.context, { window: 200000, peak_tokens: 150000, peak_percent: 75, final_tokens: 8000, final_percent: 4 });
  assert.ok(s.logLines().includes('COMPACTED: the conversation was summarised (auto, 150000 tokens before)'));
});

test('a round without a new HANDOFF.md says so clearly', (t) => {
  const s = sandbox(t);
  const r = s.run(['--project', s.project, '--round', '1'], { mode: 'no_handoff' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.status, 'completed');
  assert.equal(r.json.handoff_written, false);
  assert.equal(r.json.note, 'HANDOFF.md was not written in this round: there is nothing to audit.');
  assert.match(s.logLines().pop(), /HANDOFF\.md NOT written$/);
});

test('a HANDOFF.md that was there before and did not change does not count as written', (t) => {
  const s = sandbox(t);
  fs.writeFileSync(path.join(s.project, 'HANDOFF.md'), '# HANDOFF of an earlier round\n');
  const unchanged = s.run(['--project', s.project, '--round', '1'], { mode: 'no_handoff' });
  assert.equal(unchanged.json.handoff_written, false);

  // The same file, changed by the builder in the next round, counts.
  fs.writeFileSync(path.join(s.audit, 'round-02-prompt.md'), PROMPT);
  const changed = s.run(['--project', s.project, '--round', '2']);
  assert.equal(changed.json.handoff_written, true);
  assert.equal(changed.json.round, 2);
});

test('a claude that crashes gives exit 1 and a summary that says crashed', (t) => {
  const s = sandbox(t);
  const r = s.run(['--project', s.project, '--round', '1'], { mode: 'crash' });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.json.status, 'crashed');
  assert.equal(r.json.exit_code, 3);
  assert.equal(r.json.session_id, SESSION, 'the session ID was read before the crash');
  assert.equal(r.json.result_subtype, null);
  assert.equal(r.json.turns, null);
  assert.equal(r.json.cost_usd, null);
  assert.match(r.json.error, /claude ended with exit code 3 and no result\. fake claude: crashing as asked/);
  // Without a result the size of the context window is unknown.
  assert.deepEqual(r.json.context, { window: null, peak_tokens: 5010, peak_percent: null, final_tokens: 5010, final_percent: null });
  assert.equal(r.json.handoff_written, false);
  assert.deepEqual(JSON.parse(s.read('round-01-builder.json')), r.json);
  assert.match(s.logLines().pop(), /builder ended: crashed, exit code 3, HANDOFF\.md NOT written$/);
});

test('denied tool calls are listed in the summary and in the log, once each', (t) => {
  const s = sandbox(t);
  const r = s.run(['--project', s.project, '--round', '1'], { mode: 'denied' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.permission_denials, [{ tool: 'Read', input: 'C:\\somewhere\\else\\secret.txt' }]);
  const lines = s.logLines();
  assert.equal(lines.filter((line) => line === 'DENIED Read: --restricted: path outside the working directory').length, 1);
  assert.equal(lines.filter((line) => line.startsWith('tool error:')).length, 0, 'the denial is not logged a second time as a tool error');
});

test('a stop at the turn limit is a result: status max_turns, exit 0', (t) => {
  const s = sandbox(t);
  const r = s.run(['--project', s.project, '--round', '1'], { mode: 'max_turns' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.status, 'max_turns');
  assert.equal(r.json.result_subtype, 'error_max_turns');
  assert.equal(r.json.exit_code, 1);
  assert.match(r.json.error, /stopped at the turn limit \(300\)/);
});

test('bad input exits with code 2 and one JSON error object on stdout', (t) => {
  const s = sandbox(t);
  const noRepo = path.join(s.dir, 'norepo');
  fs.mkdirSync(path.join(noRepo, '.audit'), { recursive: true });
  fs.writeFileSync(path.join(noRepo, '.audit', 'round-01-prompt.md'), PROMPT);
  fs.writeFileSync(path.join(s.audit, 'round-03-prompt.md'), '  \n');

  const cases = [
    [['--round', '1'], /--project is required/],
    [['--project', s.project], /--round must be/],
    [['--project', s.project, '--round', '0'], /--round must be/],
    [['--project', path.join(s.dir, 'missing'), '--round', '1'], /project folder not found/],
    [['--project', noRepo, '--round', '1'], /not a git repository/],
    [['--project', s.project, '--round', '2'], /no prompt for round 2/],
    [['--project', s.project, '--round', '3'], /the prompt for round 3 is empty/],
    [['--project', s.project, '--round', '1', '--bogus', 'x'], /unknown argument/],
    [['--project', s.project, '--round', '1', '--config', path.join(s.dir, 'nope.json')], /cannot read config/],
    [['--project', s.project, '--round', '1', '--config', s.writeConfig({ builderDeniedTools: undefined })], /"builderDeniedTools" must be a list/],
    [['--project', s.project, '--round', '1', '--config', s.writeConfig({ builderMaxTurns: 0 })], /"builderMaxTurns" must be/],
  ];
  for (const [args, pattern] of cases) {
    const r = s.run(args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.json.error, pattern);
  }
  assert.deepEqual(s.calls(), [], 'claude was never started');
  assert.deepEqual(fs.readdirSync(s.audit).sort(), ['round-01-prompt.md', 'round-03-prompt.md']);
});

test('a round whose builder already ran is refused, and its records stay as they were', (t) => {
  const s = sandbox(t);
  assert.equal(s.run(['--project', s.project, '--round', '1']).status, 0);
  const before = s.read('round-01-builder.json');
  const again = s.run(['--project', s.project, '--round', '1']);
  assert.equal(again.status, 2);
  assert.match(again.json.error, /round 1's builder already ran/);
  assert.equal(s.read('round-01-builder.json'), before);
  assert.equal(s.calls().length, 1);
});

test('the tracker ignores what it does not know and counts only the main conversation', () => {
  const tracker = createTracker();
  assert.deepEqual(tracker.onEvent(null), []);
  assert.deepEqual(tracker.onEvent({ type: 'something_new', session_id: 's1' }), []);
  assert.equal(tracker.seen.sessionId, 's1');
  tracker.onEvent({ type: 'assistant', parent_tool_use_id: null, message: { content: [], usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } });
  // A subagent's turn: a context of its own.
  tracker.onEvent({ type: 'assistant', parent_tool_use_id: 'toolu_9', message: { content: [], usage: { input_tokens: 5, cache_read_input_tokens: 900000, cache_creation_input_tokens: 0 } } });
  assert.deepEqual(tracker.context(), { window: null, peak_tokens: 125, peak_percent: null, final_tokens: 125, final_percent: null });
  assert.deepEqual(tracker.onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'TODO', path: 'src' } }] } }), ['Grep TODO in src']);
  const long = 'x'.repeat(300);
  assert.deepEqual(tracker.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: long }] } }), [`text: ${'x'.repeat(200)}...`]);
});

// ---- Phase 4 ----

test('a round that the plan\'s usage limit ended: status usage_limit with resets_at, and exit code 3', (t) => {
  const s = sandbox(t);
  const before = Date.now();
  const r = s.run(['--project', s.project, '--round', '1'], { mode: 'usage_limit', extraEnv: { FAKE_LIMIT_RESET_S: '900' } });
  assert.equal(r.status, 3, r.stderr);
  assert.equal(r.json.status, 'usage_limit');
  assert.ok(Math.abs(Date.parse(r.json.resets_at) - (before + 900 * 1000)) < 60 * 1000, 'the reset time of the refused rate_limit_event');
  assert.equal(r.json.usage_limit.sign, 'a rate_limit_event with status "rejected"');
  assert.equal(r.json.usage_limit.limit, 'five_hour');
  assert.equal(r.json.rate_limit.status, 'rejected');
  assert.match(r.json.error, /^the plan's usage limit was reached \(You've hit your session limit · resets 3:45pm\); it resets at 20\d\d-/);
  assert.equal(r.json.handoff_written, false);
  assert.equal(fs.existsSync(path.join(s.project, 'hello.js')), false, 'the call was refused before any work');
  assert.ok(s.logLines().some((line) => /^USAGE LIMIT: the call was refused \(five_hour\), resets at 20\d\d-/.test(line)));
  assert.equal(s.logLines().pop(), 'round 1: builder ended: usage_limit, exit code 1, HANDOFF.md NOT written');

  // In the middle of a round: what was written before stays, and the status is the same.
  const dirty = sandbox(t);
  const middle = dirty.run(['--project', dirty.project, '--round', '1'], { mode: 'usage_limit_dirty', extraEnv: { FAKE_LIMIT_RESET_S: 'none' } });
  assert.equal(middle.status, 3, middle.stderr);
  assert.equal(middle.json.status, 'usage_limit');
  assert.equal(middle.json.resets_at, null, 'no reset time in the event or in the text');
  assert.equal(fs.existsSync(path.join(dirty.project, 'hello.js')), true);

  // A round that ran to its end is not one: its last rate_limit_event says "allowed".
  const fine = sandbox(t);
  const ok = fine.run(['--project', fine.project, '--round', '1']);
  assert.equal(ok.json.status, 'completed');
  assert.equal(ok.json.rate_limit.status, 'allowed');
  assert.equal(ok.json.rate_limit.five_hour.utilization, 0.21);
  assert.equal('usage_limit' in ok.json, false);
});

test('the summary names the claude process and when it started, for /abort', (t) => {
  const s = sandbox(t);
  const before = Date.now();
  const r = s.run(['--project', s.project, '--round', '1']);
  assert.ok(Number.isInteger(r.json.runner_pid) && Number.isInteger(r.json.claude_pid));
  assert.notEqual(r.json.claude_pid, r.json.runner_pid);
  assert.ok(Date.parse(r.json.claude_started_at) >= before - 1000 && Date.parse(r.json.claude_started_at) <= Date.parse(r.json.finished_at));
});

test('the values of the project\'s .env reach none of the builder\'s records and no output', (t) => {
  const s = sandbox(t);
  const key = 'sk-test-BUILDER-0123456789abcdef';
  fs.writeFileSync(path.join(s.project, '.env'), `API_KEY=${key}\n`);
  const r = s.run(['--project', s.project, '--round', '1'], { mode: 'leak', extraEnv: { FAKE_BUILDER_LEAK: key } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(s.read('round-01-builder.jsonl'), /I put the key <secret:API_KEY> into config\.js\./);
  assert.ok(s.logLines().includes('text: I put the key <secret:API_KEY> into config.js.'));
  const written = fs.readdirSync(s.audit).map((name) => s.read(name));
  assert.equal([r.stdout, r.stderr, ...written].some((text) => text.includes(key)), false, 'the key is in a record or an output');
  // What the builder itself wrote into the project is the builder's: the commit check finds it there.
  assert.ok(fs.readFileSync(path.join(s.project, 'config.js'), 'utf8').includes(key));
});
