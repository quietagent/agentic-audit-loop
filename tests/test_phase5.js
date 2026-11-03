'use strict';

// Tests what the preparation of Phase 5 added: /testmode and the test settings
// (runtime\test-settings.json), the tick after a gap that skips what the owner sent
// in between, the order of /loop's checks, and what LOOP_REPORT.md says about both.
// The owner's decisions in the builder's input are tested in tests/test_run_builder.js
// and in the full flow of tests/test_loop.js; AUDITOR.md's rule 6 in tests/test_run_auditor.js.
// Like tests/test_controls.js: real ticks against a fake Telegram server and a fake
// claude, with the tick's clock moved by s.tickAt(). No real Claude call, no real
// Telegram call, and nothing outside tests/tmp/: every sandbox has its own runtime folder.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { botSandbox, filesUnder, ROOT } = require('./helpers/bot_sandbox');
const D = require('./helpers/loop_driver');
const T = require('../scripts/lib/test_settings');
const { readConfig } = require('../scripts/lib/config');
const { decisionsPart } = require('../scripts/lib/builder_input');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const USAGE = 'Use it like this: /testmode (shows what is on), /testmode on, /testmode set <key> <value>, /testmode off.';
const KEYS_LINE = 'Keys: defaultAnswerMinutes, reminderHours, contextWarnPercent, stuckBuilderMinutes, stuckAuditorMinutes, stuckGoalCheckMinutes. Each value is a number above 0.';
const ON = 'TEST SETTINGS ON: defaultAnswerMinutes=2, reminderHours=0.0833';
const OFFLINE = (minutes) => new RegExp(`^The bot was offline from (\\d{4}-\\d\\d-\\d\\d )?\\d\\d:\\d\\d to (\\d{4}-\\d\\d-\\d\\d )?\\d\\d:\\d\\d \\(about ${minutes} min\\)\\.$`);
const settingsFile = (s) => path.join(s.runtimeDir, 'test-settings.json');
const savedSettings = (s) => JSON.parse(fs.readFileSync(settingsFile(s), 'utf8'));
const textsSince = (s, from) => s.fake.sent.slice(from).filter((m) => m.method === 'sendMessage').map((m) => m.text);
const callsOf = (s) => s.calls().map((call) => (call.kind === 'builder' ? `builder:${call.mode}` : `auditor:${call.audit}:${call.round}:${call.reply}`));

// Sends one message and runs the tick that handles it, with the bot's clock at `offset`.
// Returns every text the bot sent in that tick.
async function repliesAt(s, offset, text) {
  const before = s.fake.sent.length;
  s.fake.message(s.owner, text);
  const r = await s.tickAt(offset);
  assert.equal(r.status, 0, r.stderr);
  return textsSince(s, before);
}

// The same, for a tick that sends one answer: that answer.
const sayAt = async (s, offset, text) => (await repliesAt(s, offset, text)).pop();
// The answer to /status at `offset`, as lines. A tick can send more than that answer.
const statusAt = async (s, offset) => (await repliesAt(s, offset, '/status')).find((text) => /(^|\n)Bot last offline: /.test(text)).split('\n');

// Ticks with the clock at `offset` until check() is true.
async function tickAtUntil(s, offset, check, what) {
  for (let i = 0; i < 240; i += 1) {
    const r = await s.tickAt(offset);
    if (r.status !== 0) throw new Error(`a tick failed while waiting for ${what}: exit ${r.status}, ${r.stderr || r.stdout}`);
    if (await check()) return;
    await D.sleep(150);
  }
  throw new Error(`timed out waiting for ${what}. The bot sent:\n${D.texts(s).slice(-6).join('\n---\n')}`);
}

describe('Phase 5 prep', { concurrency: 4 }, () => {
  // ---- 1. /testmode ----

  test('/testmode shows, sets and removes the test settings: only its six keys, and only numbers above 0', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    assert.equal(await D.say(s, '/testmode'), [
      'No test setting is on: every timer has its normal value.',
      '/testmode on sets the main test run\'s timers: defaultAnswerMinutes=2, reminderHours=0.0833 (a default answer after 2 minutes, a reminder every 5 minutes).',
      '/testmode set <key> <value> sets one key.',
      KEYS_LINE,
    ].join('\n'));
    assert.equal(fs.existsSync(settingsFile(s)), false, 'showing writes nothing');
    assert.equal((await D.say(s, '/status')).split('\n')[0], 'No loop is running.');

    // on: the main test run's timers.
    const on = (await D.say(s, '/testmode on')).split('\n');
    assert.equal(on[0], ON);
    assert.equal(on[1], 'Normal values: defaultAnswerMinutes=60, reminderHours=3');
    assert.match(on[2], /^Last changed at \d\d:\d\d\. They switch off by themselves at \d{4}-\d\d-\d\d \d\d:\d\d, 24 hours after the last \/testmode change\.$/);
    assert.equal(on[3], '/testmode off removes them now.');
    assert.equal(on.length, 4);
    let saved = savedSettings(s);
    assert.deepEqual(Object.keys(saved).sort(), ['changedAt', 'expiresAt', 'values']);
    assert.deepEqual(saved.values, { defaultAnswerMinutes: 2, reminderHours: 5 / 60 });
    assert.equal(Date.parse(saved.expiresAt) - Date.parse(saved.changedAt), 24 * HOUR);
    assert.ok(Math.abs(Date.parse(saved.changedAt) - Date.now()) < 60000);
    // While any is on, /status starts with them. The rest of it is as before.
    assert.deepEqual((await D.say(s, '/status')).split('\n'), [ON, 'No loop is running.', 'Last loop: none on record.', 'Usage: not known yet: it comes with a Claude call.', 'Bot last offline: none on record.']);

    // set: one key, in any letter case. The others stay.
    const set = (await D.say(s, '/testmode set STUCKBUILDERMINUTES 0.5')).split('\n');
    assert.equal(set[0], `${ON}, stuckBuilderMinutes=0.5`);
    assert.equal(set[1], 'Normal values: defaultAnswerMinutes=60, reminderHours=3, stuckBuilderMinutes=60');
    assert.deepEqual(savedSettings(s).values, { defaultAnswerMinutes: 2, reminderHours: 5 / 60, stuckBuilderMinutes: 0.5 });
    const shown = (await D.say(s, '/testmode')).split('\n');
    assert.deepEqual([shown[0], shown[1], shown[3]], [set[0], set[1], set[3]], '/testmode alone shows the same');
    // A set replaces the value of its key.
    assert.equal((await D.say(s, '/testmode set defaultAnswerMinutes 3')).split('\n')[0], 'TEST SETTINGS ON: defaultAnswerMinutes=3, reminderHours=0.0833, stuckBuilderMinutes=0.5');
    assert.equal((await D.say(s, '/testmode on')).split('\n')[0], `${ON}, stuckBuilderMinutes=0.5`, 'on sets its two keys again');

    // Anything else is refused, and changes nothing: a key that is not one of the six,
    // a value that is not a number above 0, and so every path, URL, token and folder.
    const before = fs.readFileSync(settingsFile(s), 'utf8');
    const notANumber = (key) => `the value of ${key} must be a number above 0, like 2 or 0.5.`;
    const refusals = [
      ['/testmode set roundCap 5', '"roundCap" is not a test setting.'],
      ['/testmode set projectsRoot C:\\Temp', '"projectsRoot" is not a test setting.'],
      ['/testmode set model other-model', '"model" is not a test setting.'],
      ['/testmode set C:\\Windows\\Temp 5', 'that is not a test setting.'],
      ['/testmode set https://example.com/x 5', 'that is not a test setting.'],
      ['/testmode set stuckBuilderMinutes 0', notANumber('stuckBuilderMinutes')],
      ['/testmode set stuckBuilderMinutes -1', notANumber('stuckBuilderMinutes')],
      ['/testmode set stuckBuilderMinutes abc', notANumber('stuckBuilderMinutes')],
      ['/testmode set stuckBuilderMinutes 1e3', notANumber('stuckBuilderMinutes')],
      ['/testmode set stuckBuilderMinutes 0,5', notANumber('stuckBuilderMinutes')],
      ['/testmode set contextWarnPercent C:\\Projects\\Other', notANumber('contextWarnPercent')],
      ['/testmode set contextWarnPercent https://example.com/hook', notANumber('contextWarnPercent')],
      ['/testmode set contextWarnPercent 7000000001:AAEtokenlike_value_0123456789', notANumber('contextWarnPercent')],
      ['/testmode set stuckBuilderMinutes', '"set" needs a key and a value, like /testmode set stuckBuilderMinutes 0.5.'],
      ['/testmode set stuckBuilderMinutes 1 2', '"set" needs a key and a value, like /testmode set stuckBuilderMinutes 0.5.'],
      ['/testmode on please', 'I do not understand that.'],
      ['/testmode enable', 'I do not understand that.'],
    ];
    for (const [text] of refusals) s.fake.message(s.owner, text);
    const from = s.fake.sent.length;
    await s.tick();
    assert.deepEqual(textsSince(s, from), refusals.map(([, why]) => `/testmode was refused: ${why} Nothing was changed.\n${USAGE}\n${KEYS_LINE}`));
    assert.equal(fs.readFileSync(settingsFile(s), 'utf8'), before, 'the file is as it was');
    assert.equal(textsSince(s, from).some((text) => /example\.com|Temp|tokenlike/.test(text)), false, 'what was refused is not repeated');

    // off: every test setting goes.
    assert.equal(await D.say(s, '/testmode off'), 'Test settings are off. They were: defaultAnswerMinutes=2, reminderHours=0.0833, stuckBuilderMinutes=0.5. Every timer has its normal value again.');
    assert.equal(fs.existsSync(settingsFile(s)), false);
    assert.equal(await D.say(s, '/testmode off'), 'No test setting was on. Every timer has its normal value.');
    assert.equal((await D.say(s, '/status')).split('\n')[0], 'No loop is running.');
    const log = s.logTexts().filter((line) => line.startsWith('/testmode'));
    assert.deepEqual(log, [
      '/testmode on: defaultAnswerMinutes=2, reminderHours=0.0833',
      '/testmode set: defaultAnswerMinutes=2, reminderHours=0.0833, stuckBuilderMinutes=0.5',
      '/testmode set: defaultAnswerMinutes=3, reminderHours=0.0833, stuckBuilderMinutes=0.5',
      '/testmode on: defaultAnswerMinutes=2, reminderHours=0.0833, stuckBuilderMinutes=0.5',
      '/testmode off: removed defaultAnswerMinutes=2, reminderHours=0.0833, stuckBuilderMinutes=0.5',
      '/testmode off: none was on',
    ]);
    // /help lists it.
    assert.ok((await D.say(s, '/help')).split('\n').some((line) => line.startsWith('/testmode [on|off|set <key> <value>] - ')));
  });

  test('the test settings file: what counts, what is ignored, and readConfig() as the one place that applies it', (t) => {
    const base = path.join(ROOT, 'tests', 'tmp', 'phase5-unit');
    fs.mkdirSync(base, { recursive: true });
    const dir = fs.mkdtempSync(path.join(base, 'ts-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const runtimeDir = path.join(dir, 'runtime');
    fs.mkdirSync(runtimeDir);
    const now = Date.now();
    const none = { present: false, on: false, expired: false, values: {}, changedAt: null, expiresAt: null };
    assert.deepEqual(T.readTestSettings(runtimeDir, now), none);

    // Only the six keys, and only numbers above 0, are ever taken from the file.
    T.writeTestSettings(runtimeDir, { reminderHours: 0.25, stuckAuditorMinutes: 1, roundCap: 99, projectsRoot: 'C:\\x', contextWarnPercent: '5', stuckGoalCheckMinutes: -1, defaultAnswerMinutes: Infinity }, now);
    assert.deepEqual(T.readTestSettings(runtimeDir, now).values, { reminderHours: 0.25, stuckAuditorMinutes: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(T.testSettingsFile(runtimeDir), 'utf8')).values, { reminderHours: 0.25, stuckAuditorMinutes: 1 });
    fs.writeFileSync(T.testSettingsFile(runtimeDir), JSON.stringify({
      values: { stuckAuditorMinutes: 1, secretsDir: 'C:\\elsewhere', telegramBaseUrl: 'http://example.invalid', maxTurns: 1 }, changedAt: new Date(now).toISOString(),
    }));
    assert.deepEqual(T.readTestSettings(runtimeDir, now).values, { stuckAuditorMinutes: 1 });

    // On for 24 hours after the last change, whoever reads it; then they no longer count.
    assert.equal(T.readTestSettings(runtimeDir, now + 24 * HOUR - 1000).on, true);
    const late = T.readTestSettings(runtimeDir, now + 24 * HOUR);
    assert.deepEqual([late.present, late.on, late.expired], [true, false, true]);
    assert.deepEqual(late.values, { stuckAuditorMinutes: 1 }, 'what they were is still known, for the message');

    // readConfig() lays them over the config: every program reads its config there.
    const configFile = path.join(dir, 'config.json');
    const raw = { roundCap: 3, stuckAuditorMinutes: 20, contextWarnPercent: 80, maxTurns: 30, runtimeDir, secretsDir: path.join(dir, 'secrets') };
    fs.writeFileSync(configFile, JSON.stringify(raw));
    assert.deepEqual(readConfig(configFile), { ...raw, stuckAuditorMinutes: 1 });
    assert.deepEqual(readConfig(configFile, { testSettings: false }), raw, 'the normal values, for /testmode to show');
    // The tests' clock moves the 24 hours too.
    fs.writeFileSync(configFile, JSON.stringify({ ...raw, testClockOffsetMs: 25 * HOUR }));
    assert.equal(readConfig(configFile).stuckAuditorMinutes, 20);
    // Each of the three programs reads its config through readConfig().
    for (const name of ['bot.js', 'run_auditor.js', 'run_builder.js']) {
      assert.match(fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8'), /\breadConfig\(/, `${name} reads its config through readConfig()`);
    }

    // A file without the time of its last change, or one that is damaged, is not on.
    fs.writeFileSync(T.testSettingsFile(runtimeDir), JSON.stringify({ values: { stuckAuditorMinutes: 1 } }));
    assert.deepEqual(T.readTestSettings(runtimeDir, now), { ...none, present: true });
    fs.writeFileSync(T.testSettingsFile(runtimeDir), '{ "values": ');
    assert.deepEqual(T.readTestSettings(runtimeDir, now), { ...none, present: true });
    assert.equal(T.clearTestSettings(runtimeDir), true);
    assert.equal(fs.existsSync(T.testSettingsFile(runtimeDir)), false);
    // Writing no usable value removes the file.
    T.writeTestSettings(runtimeDir, { stuckAuditorMinutes: 1 }, now);
    T.writeTestSettings(runtimeDir, { nothing: 1 }, now);
    assert.equal(fs.existsSync(T.testSettingsFile(runtimeDir)), false);

    assert.equal(T.describeTestSettings({ stuckBuilderMinutes: 0.5, reminderHours: 5 / 60, defaultAnswerMinutes: 2 }), 'defaultAnswerMinutes=2, reminderHours=0.0833, stuckBuilderMinutes=0.5');
    assert.equal(T.canonicalKey('contextwarnpercent'), 'contextWarnPercent');
    assert.equal(T.canonicalKey('roundCap'), null);
    assert.deepEqual(['2', '0.5', '.5', '007', '0', '-1', '1e3', '1,5', '', ' 2', 'Infinity', 'NaN', '0x10'].map(T.parseValue), [2, 0.5, 0.5, 7, null, null, null, null, null, null, null, null, null]);
  });

  test('test settings reach the bot, the loop and the auditor: a default answer after 2 minutes, a reminder after 5, the stuck alert and the context warning; /status, the loop\'s messages and LOOP_REPORT.md say that they are on', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Timers');
    s.script({ auditor: ['ask', 'continue', 'continue'], builder: [{ mode: 'ok', delayMs: 14000 }] });
    let clock = 0;
    assert.equal((await sayAt(s, clock, '/testmode on')).split('\n')[0], ON);

    // The start message of the loop says so.
    assert.equal(await sayAt(s, clock, '/loop Timers'), `Timers: the loop started, with at most 3 rounds. First the auditor checks GOAL.md (goal check 1).\n/stop ends the loop.\n${ON}`);
    await tickAtUntil(s, clock, () => D.questionMessage(s, 2), 'the questions');
    const q1 = D.questionMessage(s, 1);
    // /status starts with the test settings, and goes on as always.
    const status = await statusAt(s, clock);
    assert.equal(status[0], ON);
    assert.equal(status[1], 'Timers: before round 1, at most 3 rounds');
    assert.equal(status[2], 'Step: waiting for you: 2 questions of the auditor (1 [MUST], 2 [DEFAULT])');

    // The DEFAULT question is assumed after 2 minutes, not after 60.
    let before = s.fake.sent.length;
    await s.tickAt(clock += 110 * 1000);
    assert.equal(s.fake.sent.length, before, 'nothing before the two minutes are over');
    await s.tickAt(clock += 15 * 1000);
    assert.deepEqual(textsSince(s, before), [[
      'Timers, goal check: no answer to question 2 [DEFAULT] within 2 minutes, so I used the recommended option: Yes',
      'It is marked (assumed) in .audit\\DECISIONS.md. You can change it later.',
      '1 question still open, tagged MUST: the loop waits for your answer.',
    ].join('\n')]);
    // The MUST question waits, with a reminder after 5 minutes, not after 3 hours.
    before = s.fake.sent.length;
    await s.tickAt(clock += 2 * MIN + 40 * 1000);
    assert.equal(s.fake.sent.length, before, 'no reminder before five minutes');
    await s.tickAt(clock += 30 * 1000);
    assert.deepEqual(textsSince(s, before), ['Timers, goal check: a reminder. 1 question of the auditor is still open, and the loop waits for your answer.', q1.text]);
    assert.equal(D.loopState(project).questions.items[0].answer, null, 'a MUST question is never assumed');

    // Two more keys, before the round: they apply at once.
    s.fake.message(s.owner, '/testmode set contextWarnPercent 1');
    s.fake.message(s.owner, '/testmode set stuckBuilderMinutes 0.5');
    await s.tickAt(clock);
    const ALL = `${ON}, contextWarnPercent=1, stuckBuilderMinutes=0.5`;
    assert.equal(D.texts(s).pop().split('\n')[0], ALL);
    D.press(s, q1, '2. hello, world');
    await tickAtUntil(s, clock, () => D.jobIsUp(s, project, 'builder'), 'the builder to run');

    // Round 1's builder got the answers, the assumed one marked, between the preface and its prompt.
    const decisions = D.readAudit(project, 'DECISIONS.md');
    assert.match(decisions, /\n- Q: Which greeting should hello\.js print\?\n {2}A: hello, world \(answered\)\n- Q: Should the output end with a line break\?\n {2}A: Yes \(assumed\)\n$/);
    const input = D.readAudit(project, 'round-01-builder-input.md');
    assert.ok(input.includes(decisionsPart(decisions)) && input.endsWith(`\n---\n\n${D.PROMPT}`));
    assert.ok(input.includes('  A: Yes (assumed)') && input.includes('  A: hello, world (answered)'));

    // The stuck alert: at 30 seconds and at one minute, not at 60 and 120 minutes.
    before = s.fake.sent.length;
    await s.tickAt(clock += 31 * 1000);
    let alert = textsSince(s, before).pop().split('\n');
    assert.match(alert[0], /^Timers, round 1 of 3: the builder has been running for \d\d s\. That is over the limit of 0\.5 min for an alert\.$/);
    assert.match(alert[1], /^The last line of its log: /);
    assert.match(alert[2], /^\/log shows more\. \/abort ends it at once, after a Confirm\. It is not cut off by itself\.$/);
    before = s.fake.sent.length;
    await s.tickAt(clock += 30 * 1000);
    alert = textsSince(s, before).pop().split('\n');
    assert.match(alert[0], /^Timers, round 1 of 3: the builder has been running for \d\d s\. That is twice the limit of 0\.5 min for an alert\.$/);
    assert.match(alert[2], /This is the last alert for this step\.$/);

    // The context warning: at 1%, in the round's message and in the auditor's material.
    await tickAtUntil(s, clock, () => D.proposalMessage(s), 'the proposal');
    assert.equal(D.lastText(s, /: audited\./).split('\n')[0], 'Timers, round 1 of 3: WARNING: the builder\'s round used 5% of its context window (a warning starts at 1%). '
      + 'The round was too big: the auditor was told, and is to make the next step smaller.');
    assert.deepEqual(callsOf(s), ['auditor:goal-check:0:ask', 'auditor:goal-check:0:continue', 'builder:ok', 'auditor:round:1:continue']);
    assert.match(s.calls()[3].stdin, /^CONTEXT WARNING: the builder's round used 5% of its context window\. That is 1% or more\.$/m, 'run_auditor.js saw the test value');

    // The end message says so, and so does the report.
    D.press(s, D.proposalMessage(s), 'Stop');
    await s.tickAt(clock);
    const end = D.endMessage(s).split('\n');
    assert.equal(end[0], 'Timers: the loop ended. Stopped by you at the prompt for round 2.');
    assert.equal(end[end.length - 1], `TEST SETTINGS ON: ${T.describeTestSettings({ defaultAnswerMinutes: 2, reminderHours: 5 / 60, contextWarnPercent: 1, stuckBuilderMinutes: 0.5 })}`);
    assert.equal(end[end.length - 1], ALL);
    const report = D.readAudit(project, 'LOOP_REPORT.md').split('\n');
    const at = report.indexOf('- TEST SETTINGS WERE ON during this loop (/testmode). Its timers were not the normal ones:');
    assert.ok(at > 0 && at < report.indexOf('## Rounds'), 'in the head of the report');
    assert.deepEqual(report.slice(at + 1, at + 3).map((line) => line.replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d/, 'TIME')), [
      '  - from TIME: defaultAnswerMinutes=2, reminderHours=0.0833',
      '  - from TIME: defaultAnswerMinutes=2, reminderHours=0.0833, contextWarnPercent=1, stuckBuilderMinutes=0.5',
    ]);
    assert.equal(report[at + 3], '', 'two lines: what was on, and what it became');
    assert.deepEqual(D.loopState(project).testSettings.map((one) => one.settings), [
      'defaultAnswerMinutes=2, reminderHours=0.0833',
      'defaultAnswerMinutes=2, reminderHours=0.0833, contextWarnPercent=1, stuckBuilderMinutes=0.5',
    ]);
    const log = D.loopLog(project);
    assert.ok(log.includes('test settings are on: defaultAnswerMinutes=2, reminderHours=0.0833'));
    assert.ok(log.includes('test settings changed: defaultAnswerMinutes=2, reminderHours=0.0833, contextWarnPercent=1, stuckBuilderMinutes=0.5'));
    assert.ok(log.includes('goal check: question 2 [DEFAULT] had no answer within 2 minutes: assumed the recommended option: Yes'));

    // /resume says so too. After /testmode off, nothing does any more.
    assert.equal((await repliesAt(s, clock, '/resume Timers'))[0], `Timers: resuming. It had ended: Stopped by you at the prompt for round 2.\n${ALL}`);
    await sayAt(s, clock, '/testmode off');
    D.press(s, D.proposalMessage(s), 'Stop');
    await s.tickAt(clock);
    assert.equal(D.endMessage(s).includes('TEST SETTINGS'), false);
    assert.equal(D.loopState(project).testSettings.pop().settings, '', 'the report says when they went off');
    assert.ok(D.readAudit(project, 'LOOP_REPORT.md').split('\n').some((line) => /^ {2}- from .*: none \(switched off\)$/.test(line)));
    assert.equal((await sayAt(s, clock, '/status')).split('\n')[0], 'No loop is running.');
  });

  test('test settings switch off by themselves 24 hours after the last /testmode change, and the bot says so', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Day');
    s.script({ auditor: [{ text: ['VERDICT: ASK_HUMAN', 'REASON: One choice is the owner\'s.', 'FINDINGS:', '- none', 'QUESTIONS:',
      '1. [MUST] Which greeting?', '   options: hello | hi', '   recommended: hello', 'NEXT_PROMPT:', 'Write hello.js once the greeting is chosen.'].join('\n') }] });
    assert.equal((await sayAt(s, 0, '/testmode on')).split('\n')[0], ON);
    await sayAt(s, 0, '/loop Day');
    await tickAtUntil(s, 0, () => D.questionMessage(s, 1), 'the question');

    // A change ten hours later: the 24 hours count from there. (The loop waits with
    // a reminder every five minutes, so each of these ticks sends a reminder too.)
    const changed = await repliesAt(s, 10 * HOUR, '/testmode set stuckAuditorMinutes 5');
    assert.equal(changed[0].split('\n')[0], `${ON}, stuckAuditorMinutes=5`);
    assert.equal((await statusAt(s, 24 * HOUR + MIN))[0], `${ON}, stuckAuditorMinutes=5`, '24 hours after the first change they are still on');
    assert.equal((await statusAt(s, 34 * HOUR - MIN))[0], `${ON}, stuckAuditorMinutes=5`);
    assert.equal(fs.existsSync(settingsFile(s)), true);

    // 24 hours after the last change: off, with one message, and the file is gone.
    const before = s.fake.sent.length;
    const r = await s.tickAt(34 * HOUR + MIN);
    assert.equal(r.status, 0, r.stderr);
    const said = textsSince(s, before);
    assert.match(said[0], /^Test settings switched off by themselves: 24 hours have passed since the last \/testmode change \(\d{4}-\d\d-\d\d \d\d:\d\d\)\. They were: defaultAnswerMinutes=2, reminderHours=0\.0833, stuckAuditorMinutes=5\. Every timer has its normal value again\.$/);
    assert.equal(fs.existsSync(settingsFile(s)), false);
    assert.ok(s.logTexts().includes('test settings switched off by themselves, 24 hours after the last /testmode change: defaultAnswerMinutes=2, reminderHours=0.0833, stuckAuditorMinutes=5'));
    const sent = s.fake.sent.length;
    await s.tickAt(34 * HOUR + MIN + 10 * 1000);
    assert.equal(textsSince(s, sent).some((text) => /Test settings/.test(text)), false, 'it is said once');
    assert.equal((await statusAt(s, 34 * HOUR + 2 * MIN))[0], 'Day: before round 1, at most 3 rounds');
    assert.equal(await sayAt(s, 34 * HOUR + 2 * MIN, '/testmode off'), 'No test setting was on. Every timer has its normal value.');

    // The loop that ran through it says so in its log, at its end and in its report.
    assert.ok(D.loopLog(project).includes('test settings changed: none is on any more'));
    await sayAt(s, 34 * HOUR + 3 * MIN, '/stop');
    assert.equal(D.endMessage(s).includes('TEST SETTINGS'), false, 'none is on at the end');
    const report = D.readAudit(project, 'LOOP_REPORT.md').split('\n').map((line) => line.replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d/, 'TIME'));
    const at = report.indexOf('- TEST SETTINGS WERE ON during this loop (/testmode). Its timers were not the normal ones:');
    assert.deepEqual(report.slice(at + 1, at + 4), [
      '  - from TIME: defaultAnswerMinutes=2, reminderHours=0.0833',
      '  - from TIME: defaultAnswerMinutes=2, reminderHours=0.0833, stuckAuditorMinutes=5',
      '  - from TIME: none (switched off)',
    ]);

    // A file that cannot be used is removed too, and the owner is told.
    fs.writeFileSync(settingsFile(s), '{ "values": { "stuckBuilderMinutes": ');
    const again = s.fake.sent.length;
    await s.tickAt(34 * HOUR + 4 * MIN);
    assert.equal(textsSince(s, again)[0], 'The file of the test settings (runtime\\test-settings.json) could not be used, so I removed it. No test setting is on: every timer has its normal value. Send /testmode on again if you need them.');
    assert.equal(fs.existsSync(settingsFile(s)), false);
  });

  // ---- 2. the tick after a gap ----

  test('what the owner sent while the bot was offline is not acted on: commands, a text, a file, a button and a /secret are skipped and named in one message, and the /secret message is deleted', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Gap');
    D.newProject(s, 'Other');
    s.script({ auditor: ['continue', 'continue', 'continue'], builder: ['ok', 'ok'] });
    await D.startLoop(s, 'Gap');
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal');
    const proposal = D.proposalMessage(s);
    const calls = s.calls().length;
    const canary = 'sk-gap-CANARY-0123456789abcdefXYZ';

    // The bot is off. The owner sends all of this in the meantime.
    D.press(s, proposal, 'Approve');
    s.fake.message(s.owner, '/loop Other');
    s.fake.message(s.owner, '/status');
    s.fake.message(s.owner, 'a note that the bot never asked for');
    s.fake.document(s.owner, 'prompt.md', 'a file that the bot never asked for');
    const secret = s.fake.message(s.owner, `/secret Gap API_KEY ${canary}`);
    s.fake.message(s.owner, `/SECRET@SomeLoopBot Gap OTHER_KEY ${canary}-second`);
    s.fake.message(s.owner, `/foo ${canary}`);
    s.fake.message(s.owner, '/log   builder   5');
    s.fake.message(999, '/loop Gap', { username: 'stranger' });
    s.fake.message(s.owner, '/testmode on');

    const before = s.fake.sent.length;
    const r = await s.tickAt(10 * MIN, { gap: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ok: 11 skipped after a gap, \d+ sent\n$/);
    const said = textsSince(s, before);
    assert.match(said[0], OFFLINE(10));
    // Where the loop stands, as after every gap: the round's message and the proposal again.
    assert.match(said[1], /^Gap, round 1 of 3: audited\./);
    assert.equal(said[2], 'Gap, round 2 of 3: start the builder with this prompt?');
    // Then the one message about what did not run.
    assert.equal(said[3], 'While I was offline you sent: a button press, /loop Other, /status, a text message, a file, /secret (deleted, not saved), /secret (deleted, not saved), '
      + '/foo, /log builder 5, /testmode on. None of them ran. Send them again if you still want them.');
    assert.equal(said.length, 4);
    assert.equal(D.buttonAnswers(s).pop(), 'pressed while I was offline: press it again');

    // None of it ran.
    assert.equal(s.calls().length, calls, 'no builder started: the Approve was not acted on');
    assert.equal(D.loopState(project).step, 'proposal');
    assert.equal(s.state().loop.name, 'Gap', 'no other loop was started');
    assert.equal(fs.existsSync(path.join(s.projectsRoot, 'Other', '.audit', 'loop.json')), false);
    assert.equal(fs.existsSync(path.join(project, '.env')), false, 'no key was saved');
    assert.equal(fs.existsSync(settingsFile(s)), false, 'no test setting was switched on');
    assert.deepEqual(s.state().conversations, {}, 'the text and the file were taken for nothing');
    assert.equal('skipWaiting' in s.state(), false);
    assert.equal(s.state().offset, s.fake.nextUpdateId);
    // The /secret messages are deleted all the same, both of them.
    assert.deepEqual(s.fake.deleted.map((d) => d.messageId), [secret.message.message_id, secret.message.message_id + 1]);
    assert.deepEqual(s.fake.deleted.map((d) => d.chatId), [s.owner, s.owner]);
    const log = s.logTexts();
    assert.ok(log.includes('after the gap: skipped 11 updates that were waiting, 10 of them from the owner. None was acted on.'));
    assert.ok(log.includes('not the owner: chat 999, username @stranger'));

    // The value of the /secret message is nowhere: not in an output, a runtime file, a
    // project file, or anything the bot sent.
    const hits = [];
    s.outputs.forEach((text, i) => { if (text.includes(canary)) hits.push(`output ${i}`); });
    const files = [...filesUnder(s.runtimeDir), ...filesUnder(project).filter(({ file }) => !file.includes(`${path.sep}.git${path.sep}`))];
    files.forEach(({ file, text }) => { if (text.includes(canary)) hits.push(file); });
    if (JSON.stringify(s.fake.sent).includes(canary)) hits.push('a message, a file or a button answer of the bot');
    if (JSON.stringify(s.fake.calls).includes(canary)) hits.push('a request to the Bot API');
    assert.ok(files.length >= 10, `${files.length} files were searched`);
    assert.deepEqual(hits, [], 'the /secret value was found');
    t.diagnostic(`canary search after a gap: ${s.outputs.length} outputs, ${files.length} runtime and project files, ${s.fake.sent.length} things the bot sent and `
      + `${s.fake.calls.length} requests searched for the /secret value, ${hits.length} hits`);

    // The first tick after the gap acts on new messages normally.
    assert.match(await sayAt(s, 10 * MIN + 10 * 1000, '/ping'), /^pong /);
    const again = D.proposalMessage(s);
    assert.deepEqual(again.replyMarkup, proposal.replyMarkup, 'the same buttons as before the gap');
    D.press(s, again, 'Approve');
    await s.tickAt(10 * MIN + 20 * 1000);
    assert.equal(D.texts(s).pop(), 'Gap, round 2 of 3: approved. The builder started with .audit\\round-02-prompt.md.');
    assert.equal(D.buttonAnswers(s).pop(), 'Approved');
    await tickAtUntil(s, 10 * MIN + 20 * 1000, () => D.loopState(project).step === 'proposal', 'the next proposal');
    D.press(s, D.proposalMessage(s), 'Stop');
    await s.tickAt(10 * MIN + 30 * 1000);
  });

  test('after a gap: one message that waited is named alone, a tick without network cannot let the waiting ones through, and more than a hundred are all skipped', async (t) => {
    // One command.
    const one = await botSandbox(t);
    await one.firstTick();
    one.fake.message(one.owner, '/ping');
    let before = one.fake.sent.length;
    await one.tickAt(5 * MIN, { gap: true });
    assert.equal(textsSince(one, before)[1], 'While I was offline you sent: /ping. It did not run. Send it again if you still want it.');
    assert.equal(textsSince(one, before).length, 2);
    // Nothing waiting: only the offline message.
    before = one.fake.sent.length;
    await one.tickAt(15 * MIN, { gap: true });
    assert.equal(textsSince(one, before).length, 1);
    assert.match(textsSince(one, before)[0], OFFLINE(10));

    // No network on the tick that finds the gap. The next tick is no gap any more, and
    // still skips what was waiting.
    const s = await botSandbox(t);
    await s.firstTick();
    s.fake.message(s.owner, '/ping');
    s.fake.message(s.owner, '/new Late_Project');
    s.fake.mode = 'hangup';
    const down = await s.tickAt(10 * MIN, { gap: true });
    assert.equal(down.stdout, 'no network\n');
    assert.equal(s.state().skipWaiting, true, 'it is remembered');
    s.fake.mode = 'ok';
    s.fake.message(s.owner, '/status');
    before = s.fake.sent.length;
    await s.tickAt(10 * MIN + 10 * 1000);
    let said = textsSince(s, before);
    assert.match(said[0], OFFLINE(10));
    assert.equal(said[1], 'While I was offline you sent: /ping, /new Late_Project, /status. None of them ran. Send them again if you still want them.');
    assert.equal(said.length, 2);
    assert.equal('skipWaiting' in s.state(), false);
    assert.deepEqual(s.state().conversations, {}, '/new did not start');
    assert.match(await sayAt(s, 10 * MIN + 20 * 1000, '/ping'), /^pong /, 'the tick after that is an ordinary one');

    // More than Telegram hands out in one answer.
    const many = await botSandbox(t);
    await many.firstTick();
    for (let i = 0; i < 120; i += 1) many.fake.message(many.owner, `/ping ${i + 1}`);
    before = many.fake.sent.length;
    const r = await many.tickAt(10 * MIN, { gap: true });
    assert.match(r.stdout, /^ok: 120 skipped after a gap, 2 sent\n$/);
    said = textsSince(many, before);
    assert.equal(said[1], `While I was offline you sent: ${Array.from({ length: 20 }, (_, i) => `/ping ${i + 1}`).join(', ')}, and 100 more. None of them ran. Send them again if you still want them.`);
    assert.equal(many.state().offset, many.fake.nextUpdateId);
    assert.equal(many.fake.callsOf('getUpdates').length >= 3, true, 'the first tick, and two pages on this one');
    assert.equal((await many.tickAt(10 * MIN + 10 * 1000)).stdout, 'idle\n');
  });

  // ---- 3. one loop at a time comes first ----

  test('/loop while a loop runs is refused as "one loop at a time", also for a project that could not be looped anyway', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const finished = D.newProject(s, 'Finished');
    fs.writeFileSync(D.audit(finished, 'round-01-builder.json'), '{}');
    fs.writeFileSync(D.audit(finished, 'round-01-verdict.json'), '{}');
    D.newProject(s, 'Running');
    // Without a loop, the project's own state is the reason.
    assert.equal(await D.say(s, '/loop Finished'), '/loop was refused: Finished: rounds already ran there (.audit\\round-01-builder.json and 1 more). To continue that loop, send /resume Finished.');
    s.script({ auditor: [{ reply: 'stop', delayMs: 2500 }] });
    await D.startLoop(s, 'Running');
    assert.match(await D.say(s, '/loop Finished'), /^\/loop was refused: a loop is already running: Running, goal check \(goal check running since \d\d:\d\d:\d\d\)\. One loop at a time; \/stop ends it\.$/);
    assert.match(await D.say(s, '/resume Finished'), /^\/resume was refused: another loop is running: Running, goal check \(goal check running since \d\d:\d\d:\d\d\)\. One loop at a time; \/stop ends it\.$/);
    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
    // A loop without test settings says so in its report, and nowhere else.
    const report = D.readAudit(path.join(s.projectsRoot, 'Running'), 'LOOP_REPORT.md');
    assert.match(report, /^- Test settings \(\/testmode\): none was on during this loop\.$/m);
    assert.equal(D.endMessage(s).includes('TEST SETTINGS'), false);
  });

  // ---- 4. the Phase 5 project files ----

  test('the Phase 5 pairs: GOAL.md and a first prompt for the main run and for the break-it tests', () => {
    const read = (...parts) => fs.readFileSync(path.join(ROOT, 'tests', 'smoke', ...parts), 'utf8');
    const main = read('phase5', 'GOAL.md');
    assert.match(main, /^# GOAL\n\n## What to build\nA small command-line to-do app in Node\.js\./);
    assert.equal((main.match(/^- \[ \] /gm) || []).length, 8);
    assert.match(main, /\n## Not decided yet\n- The order `list` shows tasks in: newest first or oldest first\. Easy to change later\.\n- Whether `delete` removes a task for good, or moves it to a trash list it can be restored from\. This is the owner's choice\.\n$/);
    assert.match(read('phase5', 'first-prompt.md'), /^# Round 1\n\nRead GOAL\.md first\./);
    // The break-it project: clear (nothing left open), built-ins only, npm test, and
    // more definition-of-done items than the break-it tests have rounds.
    const broken = read('phase5-break', 'GOAL.md');
    assert.doesNotMatch(broken, /Not decided yet|owner's choice/i);
    assert.ok((broken.match(/^- \[ \] /gm) || []).length >= 12);
    assert.match(broken, /"test": "node --test"/);
    assert.match(broken, /Node\.js built-ins only/);
    assert.match(broken, /A round builds exactly one command/);
    assert.match(read('phase5-break', 'first-prompt.md'), /^# Round 1\n/);
    for (const text of [main, broken]) assert.match(text, /## Definition of done/);
  });
});

// The rehearsal of the owner's whole Phase 5 script, with the fakes: see tests/run_phase5_rehearsal.js.
test('the rehearsal of the owner\'s Phase 5 script passes with the fakes', { timeout: 15 * 60 * 1000 }, () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'run_phase5_rehearsal.js'), '--fake', '--quiet'], { encoding: 'utf8', timeout: 14 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `${r.stdout.slice(-6000)}\n${r.stderr.slice(-2000)}`);
  assert.match(r.stdout, /\nREHEARSAL PASSED: \d+ steps, every reply as the script says\.\n/);
});
