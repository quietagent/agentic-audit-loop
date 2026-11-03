'use strict';

// Tests what Phase 7c added: the model and the effort of the builder and the auditor.
// "effort" in audit_loop.config.json is checked by readConfig(); both runners pass
// --model and --effort through lib/claude_process.js when they are set, and nothing when
// they are null; the builder's summary and the auditor's usage record what was asked for
// next to the model claude named; an effort level never comes in from the environment;
// LOOP_REPORT.md has the Model line after the cost line.
// Against the fake claudes of the runners' own tests. No real Claude call, no Telegram
// call, nothing outside tests/tmp/.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { readConfig, builderSettings, botSettings, ConfigError } = require('../scripts/lib/config');
const { modelArgs, describeModel, EFFORT_LEVELS } = require('../scripts/lib/claude_process');
const { buildReport } = require('../scripts/lib/loop_report');

const ROOT = path.resolve(__dirname, '..');
const SHIPPED = path.join(ROOT, 'audit_loop.config.json');
const DEFAULT_CONFIG = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
const RUN_BUILDER = path.join(ROOT, 'scripts', 'run_builder.js');
const RUN_AUDITOR = path.join(ROOT, 'scripts', 'run_auditor.js');
const BOT = path.join(ROOT, 'scripts', 'bot.js');
const FAKES = { builder: path.join(__dirname, 'helpers', 'fake_claude_builder.js'), auditor: path.join(__dirname, 'helpers', 'fake_claude.js') };
const TMP = path.join(__dirname, 'tmp', 'phase7c');
const LEVELS_TEXT = 'low, medium, high, xhigh, max';
const DEFAULT_WORDS = 'Claude Code\'s default';

function gitIn(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid',
    '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

// The values that follow a flag on the fake claude's command line, or null without the flag.
function valuesOf(argv, flag) {
  const start = argv.indexOf(flag) + 1;
  if (!start) return null;
  const end = argv.findIndex((arg, i) => i >= start && arg.startsWith('--'));
  return argv.slice(start, end === -1 ? argv.length : end);
}

// A folder of its own with a project (GOAL.md committed, round 1's prompt waiting), a
// fake claude for each runner, and a writer for configs based on the shipped file.
function sandbox(t) {
  const dir = path.join(TMP, crypto.randomBytes(5).toString('hex'));
  const project = path.join(dir, 'project');
  fs.mkdirSync(path.join(project, '.audit'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  for (const [kind, fake] of Object.entries(FAKES)) {
    const bin = path.join(dir, `bin-${kind}`);
    fs.mkdirSync(bin);
    if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "${fake}" %*\r\n`);
    else fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  }
  gitIn(project, 'init', '-q');
  fs.writeFileSync(path.join(project, '.gitignore'), '.audit/\n');
  fs.writeFileSync(path.join(project, 'GOAL.md'), '# GOAL\nA script that prints hello.\n\n## Definition of done\n- [ ] hello.js prints hello\n');
  gitIn(project, 'add', '-A');
  gitIn(project, 'commit', '-q', '-m', 'Loop: GOAL.md');
  fs.writeFileSync(path.join(project, '.audit', 'round-01-prompt.md'), 'Create hello.js that prints hello, and write HANDOFF.md.\n');

  let configs = 0;
  // Every config names a runtime folder of the sandbox's own: never the live bot's runtime\.
  const writeConfig = (overrides = {}) => {
    const file = path.join(dir, `config-${configs += 1}.json`);
    const config = { ...DEFAULT_CONFIG, runtimeDir: path.join(dir, 'runtime'), ...overrides };
    for (const key of Object.keys(config)) if (config[key] === undefined) delete config[key];
    fs.writeFileSync(file, JSON.stringify(config));
    return file;
  };
  const recordFile = path.join(dir, 'calls.jsonl');
  const calls = () => (fs.existsSync(recordFile) ? fs.readFileSync(recordFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);

  // kind 'builder' runs round 1 (again: the records of the last run are removed first),
  // kind 'auditor' a goal check. The fake claude records every call.
  function run(kind, config, { extraEnv = {} } = {}) {
    for (const name of fs.readdirSync(path.join(project, '.audit'))) {
      if (name !== 'round-01-prompt.md') fs.rmSync(path.join(project, '.audit', name), { force: true });
    }
    const env = { ...process.env, FAKE_CLAUDE_RECORD: recordFile, FAKE_BUILDER_MODE: 'ok', FAKE_CLAUDE_MODE: 'stream', ...extraEnv };
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
    env[pathKey] = `${path.join(dir, `bin-${kind}`)}${path.delimiter}${env[pathKey]}`;
    const args = kind === 'builder'
      ? [RUN_BUILDER, '--project', project, '--round', '1', '--config', config]
      : [RUN_AUDITOR, '--project', project, '--goal-check', '--config', config];
    const before = calls().length;
    const r = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 60000 });
    let json = null;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      // left as null: the test asserts on it
    }
    return { status: r.status, stderr: r.stderr, json, call: calls()[before] || null, calls: calls().length - before };
  }
  return { dir, project, writeConfig, run };
}

describe('Phase 7c', () => {
  test('the shipped config: claude-opus-5-5 at effort xhigh, one setting for the builder and the auditor', () => {
    assert.equal(DEFAULT_CONFIG.model, 'claude-opus-5-5');
    assert.equal(DEFAULT_CONFIG.effort, 'xhigh');
    assert.deepEqual(Object.keys(DEFAULT_CONFIG).filter((key) => /model|effort/i.test(key)), ['model', 'effort']);
    const config = readConfig(SHIPPED, { testSettings: false });
    assert.deepEqual([config.model, config.effort], ['claude-opus-5-5', 'xhigh']);
    const builder = builderSettings(config, SHIPPED);
    assert.deepEqual([builder.model, builder.effort], ['claude-opus-5-5', 'xhigh']);
    const bot = botSettings(config, SHIPPED);
    assert.deepEqual([bot.model, bot.effort], ['claude-opus-5-5', 'xhigh']);
    assert.deepEqual(EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);
  });

  test('readConfig() refuses an effort that is not one of the five levels, with a clear message; every level, null and no key at all are fine', (t) => {
    const dir = path.join(TMP, crypto.randomBytes(5).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'config.json');
    const write = (config) => fs.writeFileSync(file, JSON.stringify({ ...DEFAULT_CONFIG, runtimeDir: path.join(dir, 'runtime'), ...config }));

    for (const bad of ['XHIGH', 'extra-high', 'high ', 'minimal', '', 5, true, ['xhigh'], { level: 'xhigh' }]) {
      write({ effort: bad });
      for (const options of [{}, { testSettings: false }]) {
        assert.throws(() => readConfig(file, options), (err) => {
          assert.ok(err instanceof ConfigError, `${JSON.stringify(bad)}: ${err}`);
          assert.equal(err.message, `config ${file}: "effort" must be one of ${LEVELS_TEXT}, or null for ${DEFAULT_WORDS}; got ${JSON.stringify(bad)}`);
          return true;
        });
      }
    }
    for (const good of [...EFFORT_LEVELS, null]) {
      write({ effort: good });
      assert.equal(readConfig(file).effort, good);
      assert.equal(builderSettings(readConfig(file), file).effort, good);
    }
    const { effort, ...without } = DEFAULT_CONFIG;
    assert.equal(effort, 'xhigh');
    fs.writeFileSync(file, JSON.stringify({ ...without, runtimeDir: path.join(dir, 'runtime') }));
    assert.equal(builderSettings(readConfig(file), file).effort, null, 'no key is Claude Code\'s default');
  });

  test('a bad effort stops both runners and the bot before anything starts: exit code 2 and the message', (t) => {
    const s = sandbox(t);
    const config = s.writeConfig({ effort: 'extreme' });
    const message = `config ${config}: "effort" must be one of ${LEVELS_TEXT}, or null for ${DEFAULT_WORDS}; got "extreme"`;
    for (const kind of ['builder', 'auditor']) {
      const r = s.run(kind, config);
      assert.equal(r.status, 2, `${kind}: ${r.stderr}`);
      assert.deepEqual(r.json, { error: message });
      assert.match(r.stderr, new RegExp(`\\[run_${kind}\\] error: ${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.equal(r.calls, 0, `${kind}: claude must not be started`);
    }
    assert.deepEqual(fs.readdirSync(path.join(s.project, '.audit')), ['round-01-prompt.md'], 'nothing was written');

    // The bot reads the same function first. Its folders are the sandbox's own, so even a
    // tick that went further could not read the real token or reach Telegram.
    const botConfig = s.writeConfig({
      effort: 'extreme', projectsRoot: path.join(s.dir, 'projects'), secretsDir: path.join(s.dir, 'secrets'), telegramBaseUrl: 'http://127.0.0.1:9',
    });
    const bot = spawnSync(process.execPath, [BOT, 'tick', '--config', botConfig], { encoding: 'utf8', timeout: 60000 });
    assert.equal(bot.status, 2, bot.stderr);
    assert.equal(bot.stderr.trim(), `[bot] config ${botConfig}: "effort" must be one of ${LEVELS_TEXT}, or null for ${DEFAULT_WORDS}; got "extreme"`);
    assert.equal(fs.existsSync(path.join(s.dir, 'runtime')), false, 'the tick did not start: no runtime folder');
  });

  test('both runners pass --model claude-opus-5-5 --effort xhigh with the shipped settings, through lib/claude_process.js, and record them next to what claude named', (t) => {
    const s = sandbox(t);
    const config = s.writeConfig();

    const builder = s.run('builder', config);
    assert.equal(builder.status, 0, builder.stderr);
    assert.deepEqual(valuesOf(builder.call.argv, '--model'), ['claude-opus-5-5']);
    assert.deepEqual(valuesOf(builder.call.argv, '--effort'), ['xhigh']);
    assert.deepEqual(builder.call.argv.slice(-4), ['--model', 'claude-opus-5-5', '--effort', 'xhigh'], 'after the lock-down flags');
    const summary = JSON.parse(fs.readFileSync(path.join(s.project, '.audit', 'round-01-builder.json'), 'utf8'));
    assert.deepEqual(summary, builder.json);
    assert.deepEqual([summary.model, summary.model_requested, summary.effort_requested], ['fake-model-1', 'claude-opus-5-5', 'xhigh']);
    const keys = Object.keys(summary);
    assert.deepEqual(keys.slice(keys.indexOf('model'), keys.indexOf('model') + 3), ['model', 'model_requested', 'effort_requested'], 'next to what claude named');
    assert.match(builder.stderr, /\[run_builder\] round 1: starting .* in .*project; model claude-opus-5-5, effort xhigh, maxTurns 300, no time limit\n/);

    const auditor = s.run('auditor', config);
    assert.equal(auditor.status, 0, auditor.stderr);
    assert.deepEqual(valuesOf(auditor.call.argv, '--model'), ['claude-opus-5-5']);
    assert.deepEqual(valuesOf(auditor.call.argv, '--effort'), ['xhigh']);
    assert.deepEqual(auditor.call.argv.slice(-4), ['--model', 'claude-opus-5-5', '--effort', 'xhigh']);
    const verdict = JSON.parse(fs.readFileSync(path.join(s.project, '.audit', 'goal-check-01-verdict.json'), 'utf8'));
    assert.deepEqual(verdict, auditor.json);
    const { rate_limit: rateLimit, ...usage } = verdict.usage;
    assert.equal(rateLimit.status, 'allowed');
    assert.deepEqual(usage, { calls: 1, turns: 4, cost_usd: 0.05, denied_tool_calls: 0, model_requested: 'claude-opus-5-5', effort_requested: 'xhigh', model: 'fake-model-1' });
    assert.match(auditor.stderr, /\[run_auditor\] starting .*; model claude-opus-5-5, effort xhigh, maxTurns 30, timeout 15 min\n/);
    assert.match(auditor.stderr, /\[run_auditor\] claude named model fake-model-1 in its init event, its result names fake-model-1; effort keys in the init event: none\n/);

    // The flags come from one place, for both.
    assert.deepEqual(modelArgs({ model: 'claude-opus-5-5', effort: 'xhigh' }), ['--model', 'claude-opus-5-5', '--effort', 'xhigh']);
    assert.deepEqual(modelArgs({ model: null, effort: null }), []);
    assert.throws(() => modelArgs({ effort: 'XHIGH' }), /effort must be one of low, medium, high, xhigh, max, got "XHIGH"/);
    for (const file of [RUN_BUILDER, RUN_AUDITOR]) {
      const text = fs.readFileSync(file, 'utf8');
      assert.match(text, /\.\.\.modelArgs\((settings|config)\)/);
      assert.doesNotMatch(text, /'--model'|'--effort'/, `${path.basename(file)} writes no flag of its own`);
    }
  });

  test('null passes neither flag (Claude Code\'s default); a model alone or an effort alone passes only that one', (t) => {
    const s = sandbox(t);
    const cases = [
      [{ model: null, effort: null }, null, null, 'model Claude Code\'s default, effort: Claude Code\'s default'],
      [{ model: 'claude-opus-5-5', effort: null }, ['claude-opus-5-5'], null, 'model claude-opus-5-5, effort: Claude Code\'s default'],
      [{ model: null, effort: 'low' }, null, ['low'], 'model Claude Code\'s default, effort low'],
      [{ model: undefined, effort: undefined }, null, null, 'model Claude Code\'s default, effort: Claude Code\'s default'],
    ];
    for (const [overrides, model, effort, words] of cases) {
      const config = s.writeConfig(overrides);
      const label = JSON.stringify(overrides);
      const builder = s.run('builder', config);
      assert.equal(builder.status, 0, `${label}: ${builder.stderr}`);
      assert.deepEqual(valuesOf(builder.call.argv, '--model'), model, label);
      assert.deepEqual(valuesOf(builder.call.argv, '--effort'), effort, label);
      assert.equal(builder.json.model_requested, model ? model[0] : null, label);
      assert.equal(builder.json.effort_requested, effort ? effort[0] : null, label);
      assert.equal(builder.json.model, 'fake-model-1');
      assert.ok(builder.stderr.includes(`; ${words}, maxTurns 300`), `${label}: ${builder.stderr}`);

      const auditor = s.run('auditor', config);
      assert.equal(auditor.status, 0, `${label}: ${auditor.stderr}`);
      assert.deepEqual(valuesOf(auditor.call.argv, '--model'), model, label);
      assert.deepEqual(valuesOf(auditor.call.argv, '--effort'), effort, label);
      assert.equal(auditor.json.usage.model_requested, model ? model[0] : null, label);
      assert.equal(auditor.json.usage.effort_requested, effort ? effort[0] : null, label);
      assert.equal(auditor.json.usage.model, 'fake-model-1');
      assert.ok(auditor.stderr.includes(`; ${words}, maxTurns 30`), `${label}: ${auditor.stderr}`);
    }
    assert.equal(describeModel({}), `${DEFAULT_WORDS}, effort: ${DEFAULT_WORDS}`);
  });

  test('an effort level never comes in from the environment: CLAUDE_CODE_EFFORT_LEVEL and CLAUDE_EFFORT are dropped, and only the config\'s level is passed', (t) => {
    const s = sandbox(t);
    const outside = { CLAUDE_CODE_EFFORT_LEVEL: 'max', CLAUDE_EFFORT: 'low' };
    for (const [effort, expected] of [[null, null], ['xhigh', ['xhigh']]]) {
      const config = s.writeConfig({ effort });
      for (const kind of ['builder', 'auditor']) {
        const r = s.run(kind, config, { extraEnv: outside });
        assert.equal(r.status, 0, `${kind}: ${r.stderr}`);
        assert.deepEqual(valuesOf(r.call.argv, '--effort'), expected, `${kind}, effort ${effort}`);
        assert.deepEqual(r.call.envNames.filter((name) => /effort/i.test(name)), [], `${kind}: no effort variable reaches claude`);
      }
    }
  });

  test('LOOP_REPORT.md: the Model line right after the cost line', () => {
    const loop = {
      name: 'Report', project: 'C:\\somewhere\\Report', id: 'abc', cap: 3, rounds: {},
      startedAt: '2026-10-16T01:00:00.000Z', end: { at: '2026-10-16T02:00:00.000Z', why: 'DONE after round 1 of 3.' },
    };
    const lineAfterCost = (options) => {
      const lines = buildReport(loop, { log: '', stat: '' }, options).split('\n');
      const at = lines.findIndex((line) => line.startsWith('- Total cost: '));
      assert.ok(at > 0);
      return lines[at + 1];
    };
    assert.equal(lineAfterCost({ model: 'claude-opus-5-5', effort: 'xhigh' }), '- Model: claude-opus-5-5, effort xhigh');
    assert.equal(lineAfterCost({ model: 'claude-opus-5-5', effort: null }), '- Model: claude-opus-5-5, effort: Claude Code\'s default');
    assert.equal(lineAfterCost({ model: null, effort: 'max' }), '- Model: Claude Code\'s default, effort max');
    assert.equal(lineAfterCost({}), '- Model: Claude Code\'s default, effort: Claude Code\'s default');
    // The line comes before an earlier end and the test settings line.
    const resumed = buildReport({ ...loop, ends: [{ at: loop.startedAt, why: 'Stopped.', resumedAt: loop.startedAt }] }, { log: '', stat: '' }, { model: 'claude-opus-5-5', effort: 'xhigh' }).split('\n');
    const at = resumed.indexOf('- Model: claude-opus-5-5, effort xhigh');
    assert.match(resumed[at - 1], /^- Total cost: /);
    assert.equal(resumed[at + 1], '- It ended and was resumed 1 time before:');
  });
});
