'use strict';

// Tests what Phase 7b added: the tick moves the loop on while Telegram does not answer
// (what the loop sends waits in the outbox; one log line when an outage starts, one every
// 10 minutes, one when it ends; the owner's message after an outage of 5 minutes or more;
// /status), a getUpdates that Telegram refuses (as before), the offline logic (untouched,
// and an outage that a gap ends), and the line about the reply format in AUDITOR.md and
// the line of templates/GOAL.template.md. The parser's preamble rule is tested in
// test_parse_verdict.js and test_run_auditor.js.
// Like tests/test_phase7.js: real ticks against a fake Telegram server and a fake claude.
// No real Claude call, no real Telegram call, and nothing outside tests/tmp/.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { botSandbox, ROOT } = require('./helpers/bot_sandbox');
const D = require('./helpers/loop_driver');
const { noteUnreachable, endOutage, telegramLine } = require('../scripts/lib/telegram_outage');

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
// A GOAL.md with an "## Overnight" section, as in test_phase7.js.
const GOAL_NIGHT = [
  '# GOAL: say hello', '', 'A script that prints hello.', '',
  '## Definition of done', '- [ ] hello.js prints hello', '- [ ] hello.js has a test', '- [ ] README.md shows how to run it', '',
  '## Overnight', '- [ ] hello.js prints hello', '- [ ] hello.js has a test', '',
  '## Constraints', '- Node.js only.', '',
].join('\n');
const PROPOSAL = /: start the builder with this prompt\?$/;
const UNREACHABLE = /^Telegram unreachable: Telegram getUpdates: no answer \(\w+\); the loop goes on, and what it sends waits in the outbox$/;
const TIME = '(\\d{4}-\\d\\d-\\d\\d )?\\d\\d:\\d\\d';
const OUTAGE_TEXT = (minutes, rest = 'what it sent meanwhile follows') => new RegExp(`^Telegram was unreachable from ${TIME} to ${TIME} \\(about ${minutes} min\\)\\. The loop went on; ${rest}\\.$`);
const OFFLINE = (minutes) => new RegExp(`^The bot was offline from ${TIME} to ${TIME} \\(about ${minutes} min\\)\\.$`);
const STATUS_LINE = (minutes) => new RegExp(`^Telegram last unreachable: ${TIME} to ${TIME} \\(about ${minutes} min\\)\\.$`);

// A tick at a fixed time on the bot's clock: `ms` after `origin`, however long the ticks
// before it took. Without gap, the note of the last tick is set to 5 seconds before it.
const at = (s, origin, ms, options) => s.tickAt(origin + ms - Date.now(), options);
// The log lines about Telegram's outages, without their time.
const outageLines = (s) => s.logTexts().filter((line) => /^Telegram /.test(line));
// What waits in the outbox, and what the fake server got: a message's text, or "file <name>".
const outbox = (s) => s.state().outbox.map((item) => (item.method === 'sendDocument' ? `file ${item.filename}` : item.text));
const sentSince = (s, from) => s.fake.sent.slice(from).filter((m) => m.method !== 'answerCallbackQuery');
const shown = (m) => (m.method === 'sendDocument' ? `file ${m.filename}` : m.text);

// Ticks while getUpdates fails, 20 seconds apart on the bot's clock, at least `least`
// times and until done() is true. Every one must be a failing tick. Returns how many ran.
async function failingTicks(s, origin, { least = 20, done = () => true, what }) {
  let n = 0;
  while (n < least || !done()) {
    const r = await at(s, origin, n * 20 * SEC);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'no network\n', 'a failing tick prints the same short line as before');
    n += 1;
    assert.ok(n <= 150, `no ${what} after ${n} failing ticks. Waiting: ${outbox(s).join(' | ')}`);
    await D.sleep(300);
  }
  return n;
}

// The first good tick after an outage: Telegram answers again, a whole number of minutes
// plus 5 seconds after the outage began (state.telegramDown.since), at `notBefore` on the
// bot's clock or later. Returns the tick and those minutes.
async function goodTick(s, notBefore) {
  const since = Date.parse(s.state().telegramDown.since);
  const minutes = Math.ceil((notBefore - since) / MIN);
  s.fake.outage(null);
  const r = await s.tickAt(since + minutes * MIN + 5 * SEC - Date.now());
  assert.equal(r.status, 0, r.stderr);
  return { r, minutes };
}

describe('Phase 7b', { concurrency: 4 }, () => {
  // ---- lib/telegram_outage.js on its own ----

  test('lib/telegram_outage.js: the first line, one every 10 minutes, the end after 0 minutes, the owner\'s message from 5 minutes exactly, a gap, the /status line', () => {
    const t0 = Date.parse('2026-10-16T01:00:00.000Z');
    const state = { outbox: [] };
    assert.equal(noteUnreachable(state, t0, 'Telegram getUpdates: no answer (TimeoutError)'),
      'Telegram unreachable: Telegram getUpdates: no answer (TimeoutError); the loop goes on, and what it sends waits in the outbox');
    assert.deepEqual(state.telegramDown, { since: '2026-10-16T01:00:00.000Z', lastLogged: '2026-10-16T01:00:00.000Z' });
    assert.equal(noteUnreachable(state, t0 + 15 * SEC, 'x'), null, 'one line per outage, not per tick');
    assert.equal(noteUnreachable(state, t0 + 10 * MIN - 1, 'x'), null);
    state.outbox.push({}, {});
    assert.equal(noteUnreachable(state, t0 + 10 * MIN, 'Telegram getUpdates: no answer (ECONNRESET)'),
      'Telegram still unreachable, for 10 min now: Telegram getUpdates: no answer (ECONNRESET); 2 messages wait in the outbox');
    assert.equal(noteUnreachable(state, t0 + 19 * MIN, 'x'), null);
    assert.match(noteUnreachable(state, t0 + 20 * MIN, 'x'), /^Telegram still unreachable, for 20 min now: x; 2 messages wait in the outbox$/);
    // The end: 0 minutes after one failing tick, no message under 5 minutes.
    const one = { outbox: [], telegramDown: { since: new Date(t0).toISOString(), lastLogged: new Date(t0).toISOString() } };
    assert.deepEqual(endOutage(one, { endMs: t0 + 10 * SEC, nowMs: t0 + 10 * SEC }), { line: 'Telegram reachable again after 0 min; the loop went on meanwhile; 0 messages were waiting', text: null });
    assert.equal('telegramDown' in one, false, 'cleared');
    assert.equal('lastTelegramDown' in one, false);
    const short = { outbox: [{}], telegramDown: { since: new Date(t0).toISOString(), lastLogged: new Date(t0).toISOString() } };
    assert.deepEqual(endOutage(short, { endMs: t0 + 5 * MIN - 1, nowMs: t0 + 5 * MIN - 1 }), { line: 'Telegram reachable again after 5 min; the loop went on meanwhile; 1 message was waiting', text: null }, 'a millisecond under 5 minutes: no message');
    const five = { outbox: [{}, {}, {}], telegramDown: { since: new Date(t0).toISOString(), lastLogged: new Date(t0).toISOString() } };
    const ended = endOutage(five, { endMs: t0 + 5 * MIN, nowMs: t0 + 5 * MIN });
    assert.equal(ended.line, 'Telegram reachable again after 5 min; the loop went on meanwhile; 3 messages were waiting');
    assert.match(ended.text, OUTAGE_TEXT(5));
    assert.deepEqual(five.lastTelegramDown, { from: '2026-10-16T01:00:00.000Z', to: '2026-10-16T01:05:00.000Z' });
    assert.match(telegramLine(five, t0 + HOUR), STATUS_LINE(5));
    assert.equal(telegramLine({}, t0), null);
    // Nothing waited: the message says so instead of "follows".
    const empty = { outbox: [], telegramDown: { since: new Date(t0).toISOString(), lastLogged: new Date(t0).toISOString() } };
    assert.match(endOutage(empty, { endMs: t0 + 7 * MIN, nowMs: t0 + 7 * MIN }).text, OUTAGE_TEXT(7, 'it had nothing to send meanwhile'));
    // A gap: counted until the last tick before it, and never less than nothing.
    const gap = { outbox: [], telegramDown: { since: new Date(t0).toISOString(), lastLogged: new Date(t0).toISOString() } };
    assert.equal(endOutage(gap, { endMs: t0 + 6 * MIN, nowMs: t0 + HOUR, gap: true }).line,
      'Telegram was still unreachable when the bot went offline: counted until the last tick before the gap, 6 min; the loop went on meanwhile; 0 messages were waiting');
    const early = { outbox: [], telegramDown: { since: new Date(t0).toISOString(), lastLogged: new Date(t0).toISOString() } };
    assert.match(endOutage(early, { endMs: t0 - 40 * SEC, nowMs: t0 + HOUR, gap: true }).line, /before the gap, 0 min;/, 'last-tick.txt can be up to a minute older than the outage');
    assert.match(endOutage({ outbox: [], telegramDown: { since: new Date(t0).toISOString(), lastLogged: 'x' } }, { endMs: null, nowMs: t0, gap: true }).line, /before the gap, 0 min;/, 'an unknown last tick');
  });

  // ---- 1. the loop goes on ----

  test('a normal loop goes on while getUpdates fails: the builder that ended is committed and audited and the proposal comes, all of it waiting in the outbox; the first good tick sends it in order, the outage message first; a reminder that falls into an outage waits too', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Outage');
    s.script({ auditor: ['continue', 'continue'], builder: [{ mode: 'ok', delayMs: 10000 }] });
    await D.startLoop(s, 'Outage');
    await D.tickUntil(s, () => D.jobIsUp(s, project, 'builder'), 'the builder to run');
    assert.deepEqual(s.state().outbox, []);
    const sentBefore = s.fake.sent.length;
    const logBefore = s.readLog().length;
    const origin = Date.now();
    s.fake.outage({ methods: ['getUpdates'], how: 'drop' });
    // The owner sends /status during the outage: it waits at Telegram.
    s.fake.message(s.owner, '/status');
    const proposalWaits = () => s.state().outbox.some((item) => item.replyMarkup && PROPOSAL.test(item.text));
    const failing = await failingTicks(s, origin, { done: proposalWaits, what: 'proposal' });

    // Nothing went out, every getUpdates got no answer, and the loop moved on: commit, audit, proposal.
    assert.equal(s.fake.sent.length, sentBefore);
    assert.equal(s.fake.unanswered.length, failing);
    assert.ok(s.fake.unanswered.every((call) => call.method === 'getUpdates' && call.how === 'drop'));
    const loop = D.loopState(project);
    assert.equal(loop.step, 'proposal');
    assert.equal(loop.proposal.round, 2);
    assert.match(D.git(project, 'log', '--format=%s', '-1'), /^Loop: round 1$/);
    assert.equal(JSON.parse(D.readAudit(project, 'round-01-verdict.json')).verdict, 'CONTINUE');
    const waiting = outbox(s);
    assert.match(waiting[0], /^Outage, round 1 of 3: the builder ended \(completed, .*\)\. Committed as [0-9a-f]{7}\. The auditor is checking the round\.$/);
    assert.match(waiting.find((text) => /: audited\./.test(text)) || '', /^Outage, round 1 of 3: audited\./m);
    assert.ok(waiting.some((text) => /^file Outage-round-02-prompt/.test(text)), waiting.join(' | '));
    assert.match(waiting[waiting.length - 1], PROPOSAL);
    // One log line for the outage, not one per tick.
    const lines = s.logTexts().slice(logBefore).filter((line) => /^Telegram |^no network/.test(line));
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], UNREACHABLE);
    assert.equal(typeof s.state().telegramDown.since, 'string');

    // The first good tick: the outage message first, then what waited, in order, then the answer to /status.
    const { r, minutes } = await goodTick(s, origin + failing * 20 * SEC);
    assert.equal(r.stdout, `ok: 1 update, ${waiting.length + 2} sent\n`);
    const sent = sentSince(s, sentBefore);
    assert.match(sent[0].text, OUTAGE_TEXT(minutes));
    assert.ok(minutes >= 6, `${minutes} min`);
    assert.deepEqual(sent.slice(1, -1).map(shown), waiting);
    assert.ok(sent.every((m) => m.silent === false), 'a normal loop: every message with its sound');
    assert.ok(sent[waiting.length].replyMarkup, 'the proposal keeps its buttons');
    const status = sent[sent.length - 1].text.split('\n');
    assert.equal(status[0], 'Outage: Round 1 of 3');
    assert.match(status[status.length - 1], STATUS_LINE(minutes));
    assert.equal(status[status.length - 2], 'Bot last offline: none on record.', 'the Telegram line comes after the offline line');
    assert.deepEqual(outageLines(s).slice(-1), [`Telegram reachable again after ${minutes} min; the loop went on meanwhile; ${waiting.length} messages were waiting`]);
    assert.equal('telegramDown' in s.state(), false);
    assert.deepEqual(s.state().outbox, []);
    assert.equal(s.logTexts().some((line) => /^the bot was offline/.test(line)), false, 'no offline message: the ticks ran');

    // A reminder that falls into an outage: queued with its buttons, not lost.
    const shownAt = Date.parse(D.loopState(project).proposal.shownAt);
    const before = s.fake.sent.length;
    s.fake.outage({ how: 'drop' });
    await s.tickAt(shownAt + MIN - Date.now());
    await s.tickAt(shownAt + 3 * HOUR + MIN - Date.now());
    assert.equal(s.fake.sent.length, before);
    assert.deepEqual(outbox(s), ['Outage, round 2 of 3: a reminder. The prompt for round 2 still waits for you (.audit\\round-02-prompt-proposed.md).']);
    // The line comes before the tick looks at the loop: the reminder of that tick is not counted yet.
    assert.match(outageLines(s).slice(-1)[0], /^Telegram still unreachable, for 180 min now: Telegram getUpdates: no answer \(\w+\); 0 messages wait in the outbox$/);
    const back = await goodTick(s, shownAt + 3 * HOUR + 2 * MIN);
    const later = sentSince(s, before);
    assert.equal(later.length, 2);
    assert.match(later[0].text, OUTAGE_TEXT(back.minutes));
    assert.equal(later[1].text, 'Outage, round 2 of 3: a reminder. The prompt for round 2 still waits for you (.audit\\round-02-prompt-proposed.md).');
    assert.ok(later[1].replyMarkup, 'with its buttons');
    assert.equal(outageLines(s).slice(-1)[0], `Telegram reachable again after ${back.minutes} min; the loop went on meanwhile; 1 message was waiting`);
  });

  test('an overnight run goes on while getUpdates fails: round 1 is committed and audited, the loop approves round 2 and starts it, a stuck alert of round 2 waits; the first good tick sends it all in order, the outage message first, all without a sound', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'NightOut', { goal: GOAL_NIGHT });
    s.script({ auditor: ['continue', 'continue'], builder: [{ mode: 'ok', delayMs: 10000 }, 'hang'] });
    await D.say(s, '/overnight NightOut 3');
    await D.tickUntil(s, () => D.loopState(project).round === 1 && D.jobIsUp(s, project, 'builder'), 'round 1 to run');
    assert.deepEqual(s.state().outbox, []);
    const sentBefore = s.fake.sent.length;
    const origin = Date.now();
    s.fake.outage({ how: 'drop' });
    const round2Runs = () => D.loopState(project).round === 2 && D.jobIsUp(s, project, 'builder', 1);
    const failing = await failingTicks(s, origin, { done: round2Runs, what: 'round 2' });
    assert.equal(D.loopState(project).rounds[2].prompt.approvedBy, 'overnight');
    // Round 2's builder hangs: its stuck alert (60 minutes on the bot's clock) falls into the outage.
    const job = D.loopState(project).job;
    const startedAt = Date.parse(job.clockStartedAt || job.startedAt);
    const r = await s.tickAt(startedAt + 61 * MIN - Date.now());
    assert.equal(r.stdout, 'no network\n');
    assert.equal(s.fake.sent.length, sentBefore);
    const waiting = outbox(s);
    assert.ok(s.state().outbox.every((item) => item.silent === true), 'the run\'s own messages wait without a sound');
    assert.match(waiting[0], /^NightOut, round 1 of 3: the builder ended \(completed, .*\)\. Committed as [0-9a-f]{7}\. The auditor is checking the round\.$/);
    assert.ok(waiting.some((text) => text === 'file NightOut-round-02-prompt.md'), waiting.join(' | '));
    assert.ok(waiting.some((text) => /^NightOut, round 2 of 3: approved by the overnight run, without your Approve\. The builder started with \.audit\\round-02-prompt\.md\.$/.test(text)), waiting.join(' | '));
    assert.match(waiting[waiting.length - 1], /^NightOut, round 2 of 3: the builder has been running for 61 min\. That is over the limit of 60 min for an alert\.\n/);
    assert.ok(failing >= 20);

    const { minutes } = await goodTick(s, startedAt + 62 * MIN);
    const sent = sentSince(s, sentBefore);
    assert.match(sent[0].text, OUTAGE_TEXT(minutes));
    assert.deepEqual(sent.slice(1).map(shown), waiting);
    assert.ok(sent.every((m) => m.silent === true), 'the outage message has no sound in an overnight run, like the run\'s own messages');
    // The hung builder is ended.
    await D.say(s, '/abort');
    D.press(s, D.abortMessage(s), 'Confirm');
    assert.equal((await s.tick()).status, 0);
  });

  // ---- 2. the log ----

  test('the log: one failing tick (a timeout) gives the first line and "reachable again after 0 min"; telegramDown is set during the outage and cleared after it', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    s.fake.outage({ how: 'timeout', times: 1 });
    const r = await s.tick();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'no network\n');
    assert.ok(r.ms >= 9000, `the tick waited ${r.ms} ms for its timeout`);
    assert.deepEqual(s.fake.unanswered, [{ method: 'getUpdates', how: 'timeout' }]);
    assert.deepEqual(outageLines(s), ['Telegram unreachable: Telegram getUpdates: no answer (TimeoutError); the loop goes on, and what it sends waits in the outbox']);
    const down = s.state().telegramDown;
    assert.deepEqual(Object.keys(down), ['since', 'lastLogged']);
    assert.equal(down.since, down.lastLogged);
    const back = await s.tick();
    assert.equal(back.stdout, 'idle\n');
    assert.deepEqual(outageLines(s), [
      'Telegram unreachable: Telegram getUpdates: no answer (TimeoutError); the loop goes on, and what it sends waits in the outbox',
      'Telegram reachable again after 0 min; the loop went on meanwhile; 0 messages were waiting',
    ]);
    assert.equal('telegramDown' in s.state(), false);
    assert.equal('lastTelegramDown' in s.state(), false);
    assert.equal(s.fake.sentTexts().length, 0, 'nothing for the owner');
  });

  test('the log: 200 failing ticks over 16 minutes give the first line, one at 10 minutes and the end with the messages that waited; the ticks keep last-tick.txt fresh, so no offline message', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Long');
    s.script({ auditor: ['continue'], builder: ['hang'] });
    await D.startLoop(s, 'Long');
    await D.tickUntil(s, () => D.jobIsUp(s, project, 'builder'), 'the builder to run');
    assert.deepEqual(s.state().outbox, []);
    const sentBefore = s.fake.sent.length;
    const origin = Date.now();
    // A stuck alert after 5 minutes, so that messages wait. gap: true leaves last-tick.txt to the bot.
    const options = { gap: true, config: { stuckBuilderMinutes: 5 } };
    s.fake.outage({ how: 'drop' });
    for (let i = 0; i < 200; i += 1) {
      const r = await at(s, origin, i * 4800, options);
      assert.equal(r.stdout, 'no network\n', `tick ${i + 1}`);
      if (i === 100) assert.equal(typeof s.state().telegramDown.since, 'string', 'telegramDown is set during the outage');
    }
    assert.equal(s.fake.unanswered.length, 200);
    assert.equal(s.fake.sent.length, sentBefore);
    assert.equal(outbox(s).length, 2, outbox(s).join(' | '));
    s.fake.outage(null);
    const r = await at(s, origin, 16 * MIN, options);
    assert.equal(r.stdout, 'ok: 3 sent\n');
    const lines = outageLines(s);
    assert.equal(lines.length, 3, lines.join('\n'));
    assert.match(lines[0], UNREACHABLE);
    assert.match(lines[1], /^Telegram still unreachable, for 10 min now: Telegram getUpdates: no answer \(\w+\); [12] messages? waits? in the outbox$/);
    assert.equal(lines[2], 'Telegram reachable again after 16 min; the loop went on meanwhile; 2 messages were waiting');
    assert.equal('telegramDown' in s.state(), false, 'cleared after it');
    const sent = sentSince(s, sentBefore);
    assert.match(sent[0].text, OUTAGE_TEXT(16));
    assert.match(sent[1].text, /^Long, round 1 of 3: the builder has been running for \d+ min\. That is over the limit of 5 min for an alert\./);
    assert.match(sent[2].text, /^Long, round 1 of 3: the builder has been running for \d+ min\. That is twice the limit of 5 min for an alert\./);
    // 5. The ticks ran all the time: no offline message, no gap in the log.
    assert.equal(s.fake.sentTexts().some((text) => /^The bot was offline/.test(text)), false);
    assert.equal(s.logTexts().some((line) => /^the bot was offline/.test(line)), false);
    await D.say(s, '/abort');
    D.press(s, D.abortMessage(s), 'Confirm');
    assert.equal((await s.tick()).status, 0);
  });

  // ---- 3. the owner's message and /status ----

  test('the owner\'s message: an outage of 4 minutes sends nothing, one of 5 minutes sends one message; /status shows the last outage of 5 minutes or more, and a shorter one after it changes nothing', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const origin = Date.now();
    const status = async (ms) => {
      const before = s.fake.sent.length;
      s.fake.message(s.owner, '/status');
      await at(s, origin, ms);
      return sentSince(s, before).map(shown);
    };
    const idleStatus = ['No loop is running.', 'Last loop: none on record.', 'Usage: not known yet: it comes with a Claude call.', 'Bot last offline: none on record.'];

    // 4 minutes: no message.
    s.fake.outage({ how: 'drop' });
    await at(s, origin, MIN);
    await at(s, origin, 3 * MIN);
    s.fake.outage(null);
    let before = s.fake.sent.length;
    assert.equal((await at(s, origin, 5 * MIN)).stdout, 'idle\n');
    assert.equal(s.fake.sent.length, before);
    assert.equal(outageLines(s).pop(), 'Telegram reachable again after 4 min; the loop went on meanwhile; 0 messages were waiting');
    assert.deepEqual((await status(5 * MIN + 10 * SEC))[0].split('\n'), idleStatus);

    // 5 minutes (and 5 seconds): one message.
    s.fake.outage({ how: 'drop' });
    await at(s, origin, 10 * MIN);
    await at(s, origin, 13 * MIN);
    s.fake.outage(null);
    before = s.fake.sent.length;
    assert.equal((await at(s, origin, 15 * MIN + 5 * SEC)).stdout, 'ok: 1 sent\n');
    const said = sentSince(s, before);
    assert.equal(said.length, 1);
    assert.match(said[0].text, OUTAGE_TEXT(5, 'it had nothing to send meanwhile'));
    assert.equal(said[0].silent, false);
    assert.equal(outageLines(s).pop(), 'Telegram reachable again after 5 min; the loop went on meanwhile; 0 messages were waiting');
    const withLine = (await status(15 * MIN + 20 * SEC))[0].split('\n');
    assert.deepEqual(withLine.slice(0, 4), idleStatus);
    assert.match(withLine[4], STATUS_LINE(5));
    assert.equal(withLine.length, 5);
    const last = s.state().lastTelegramDown;

    // A shorter one after it: no message, and /status still shows the 5-minute one.
    s.fake.outage({ how: 'drop' });
    await at(s, origin, 20 * MIN);
    s.fake.outage(null);
    before = s.fake.sent.length;
    await at(s, origin, 23 * MIN);
    assert.equal(s.fake.sent.length, before);
    assert.deepEqual(s.state().lastTelegramDown, last);
    assert.deepEqual((await status(23 * MIN + 10 * SEC))[0].split('\n'), withLine);
  });

  // ---- 4. a refused getUpdates ----

  test('a getUpdates that Telegram refuses (401) ends the tick as before: one log line, and the loop does not move in that tick', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Refused');
    s.script({ auditor: ['continue', 'continue'], builder: [{ mode: 'ok', delayMs: 10000 }] });
    await D.startLoop(s, 'Refused');
    await D.tickUntil(s, () => D.jobIsUp(s, project, 'builder'), 'the builder to run');
    // No tick until the builder's job has ended.
    for (let i = 0; i < 300 && (D.jobRecord(project) || {}).status === 'running'; i += 1) await D.sleep(200);
    assert.notEqual(D.jobRecord(project).status, 'running');
    s.fake.mode = 'unauthorized';
    const logBefore = s.readLog().length;
    const r = await s.tick();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'Telegram refused getUpdates: see the log\n');
    assert.deepEqual(s.logTexts().slice(logBefore), ['no updates: Telegram getUpdates: 401 Unauthorized']);
    assert.equal(D.loopState(project).step, 'builder', 'the builder that ended is not committed in that tick');
    assert.match(D.git(project, 'log', '--format=%s', '-1'), /^Loop: GOAL\.md$/);
    assert.equal('telegramDown' in s.state(), false, 'a refusal is no outage');
    s.fake.mode = 'ok';
    await s.tick();
    assert.equal(D.loopState(project).step, 'auditor', 'the next tick moves it on');
    assert.match(D.git(project, 'log', '--format=%s', '-1'), /^Loop: round 1$/);
  });

  // ---- 5. the offline logic ----

  test('a gap during an outage: the outage ends at the last tick before the gap, with its message first, then the offline message as before', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const origin = Date.now();
    s.fake.outage({ how: 'drop' });
    await at(s, origin, MIN);
    await at(s, origin, 7 * MIN);
    s.fake.outage(null);
    const before = s.fake.sent.length;
    const logBefore = s.readLog().length;
    // No tick for 13 minutes: the bot was off.
    const r = await at(s, origin, 20 * MIN, { gap: true });
    assert.equal(r.stdout, 'ok: 2 sent\n');
    const said = sentSince(s, before).map(shown);
    assert.match(said[0], OUTAGE_TEXT(6, 'it had nothing to send meanwhile'));
    assert.match(said[1], OFFLINE(13));
    assert.equal(said.length, 2);
    const log = s.logTexts().slice(logBefore);
    assert.equal(log[0], 'Telegram was still unreachable when the bot went offline: counted until the last tick before the gap, 6 min; the loop went on meanwhile; 0 messages were waiting');
    assert.match(log[1], /^the bot was offline from \S+ to \S+$/);
    const state = s.state();
    assert.equal('telegramDown' in state, false);
    assert.equal(Date.parse(state.lastTelegramDown.to), Date.parse(state.lastOffline.from), 'the outage ends where the gap begins');
  });

  // ---- 7. AUDITOR.md and the GOAL template ----

  test('AUDITOR.md: the bold line about the reply format right under its first paragraph, and the same in the first sentence of "Output format"; the GOAL template\'s line under "Definition of done"', () => {
    const auditor = fs.readFileSync(path.join(ROOT, 'AUDITOR.md'), 'utf8').replace(/\r\n/g, '\n');
    const paragraphs = auditor.split('\n\n');
    assert.equal(paragraphs[0], '# Auditor');
    assert.match(paragraphs[1], /^You are the auditor in an automated build loop\..* A human only sees your verdict, so be strict, specific and honest\.$/);
    assert.equal(paragraphs[2], '**Your reply starts with `VERDICT:` on its very first line. Your reasoning goes into REASON and FINDINGS, never before VERDICT.**');
    assert.match(paragraphs[3], /^## What you receive\n/);
    const output = auditor.split('\n## Output format\n')[1];
    assert.ok(output.startsWith('Your reply starts with `VERDICT:` on its very first line, in exactly this format, and your reasoning goes into REASON and FINDINGS, never before VERDICT. Pick exactly one verdict.'), output.slice(0, 200));
    assert.doesNotMatch(auditor, /with nothing before VERDICT/);

    const template = fs.readFileSync(path.join(ROOT, 'templates', 'GOAL.template.md'), 'utf8').replace(/\r\n/g, '\n');
    const done = template.split('\n## Definition of done\n')[1].split('\n## ')[0].split('\n');
    assert.deepEqual(done.slice(0, 2), [
      '<Each item must be checkable with a file, a command or a test.>',
      '<An item that holds for every other item (an error rule, npm test passes) goes into "## Overnight" too when the overnight rounds are meant to build it; otherwise the morning report lists it under "Left for your review".>',
    ]);
  });
});
