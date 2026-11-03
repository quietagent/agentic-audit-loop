'use strict';

// Tests what Phase 7 added: the overnight run. /overnight's pre-flight, a fresh run
// of three rounds with no Approve, a continued run from a loop that ended at the round
// cap, the questions of an overnight run (DEFAULT assumed at once, MUST left open, the follow-up
// at once, open buttons that stay live, the answer later, a follow-up that asks again,
// /resume asking open questions first), the 7-day stop, the 5-hour pause and the long
// pause, the silent messages, /status, /stop, the auditor's material (OVERNIGHT RUN),
// AUDITOR.md's new section, the morning report, and the rehearsal of the owner's test.
// Like tests/test_phase6.js: real ticks against a fake Telegram server and a fake
// claude. No real Claude call, no real Telegram call, and nothing outside tests/tmp/.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { botSandbox, ROOT } = require('./helpers/bot_sandbox');
const D = require('./helpers/loop_driver');
const O = require('../scripts/lib/overnight');
const { appendDecisions, answerOpenQuestion, openEntries, OPEN_ANSWER } = require('../scripts/lib/decisions');
const { buildReport } = require('../scripts/lib/loop_report');

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const USAGE = 'Use it like this: /overnight My_Project 5 (the number is how many more rounds the run may do, from 1 to 30).';
const STOPS = 'It stops at DONE (every overnight item done), STOP_FOR_HUMAN, the round cap or 70% of the 7-day window. Its messages come without sound. /stop ends it.';
// A GOAL.md with an "## Overnight" section: two of its three definition-of-done items.
const GOAL_NIGHT = [
  '# GOAL: say hello', '', 'A script that prints hello.', '',
  '## Definition of done', '- [ ] hello.js prints hello', '- [ ] hello.js has a test', '- [ ] README.md shows how to run it', '',
  '## Overnight', '- [ ] hello.js prints hello', '- [ ] hello.js has a test', '',
  '## Constraints', '- Node.js only.', '',
].join('\n');
const GOAL_EMPTY_NIGHT = GOAL_NIGHT.replace('- [ ] hello.js prints hello\n- [ ] hello.js has a test\n\n## Constraints', '\n## Constraints');
const MUST_QUESTION = 'Where should hello.js keep its data file?';
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The text of a block of the auditor's material, by the start of its name, or null.
function blockOf(material, name) {
  const n = escape(name);
  const m = new RegExp(`^----- BEGIN ${n}[^\\n]* \\[([0-9a-f]{12})\\] -----\\n([\\s\\S]*?)\\n----- END ${n}[^\\n]* \\[\\1\\] -----$`, 'm').exec(material);
  return m ? m[2] : null;
}

// The material of an audit of the fake claude: audit is 'round', 'followup' or 'goal-check'.
function materialOf(s, audit, round, which = 'last') {
  const calls = s.calls().filter((c) => c.kind === 'auditor' && c.audit === audit && c.round === round);
  assert.ok(calls.length, `no ${audit} audit of round ${round} was made`);
  return (which === 'first' ? calls[0] : calls[calls.length - 1]).stdin;
}

// Everything the fake server got after position `from`.
const sentSince = (s, from) => s.fake.sent.slice(from);
const messagesSince = (s, from) => sentSince(s, from).filter((m) => m.method !== 'answerCallbackQuery');
const night = (s, name) => D.newProject(s, name, { goal: GOAL_NIGHT });

// The last usage the bot keeps (runtime\state.json, lastUsage), for the pre-flight check.
function setUsage(s, share) {
  const state = s.state();
  const at = (ms) => new Date(Date.now() + ms).toISOString();
  state.lastUsage = share === null ? null : {
    status: 'allowed', type: 'five_hour', resets_at: at(HOUR), utilization: null,
    five_hour: { utilization: 0.2, resets_at: at(HOUR) }, seven_day: { utilization: share, resets_at: at(2 * 24 * HOUR) }, seen_at: at(-5 * MIN),
  };
  fs.writeFileSync(s.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

// Ticks with the bot's clock moved by offsetMs until check() is true.
async function tickUntilAt(s, offsetMs, check, what, tries = 240) {
  for (let i = 0; i < tries; i += 1) {
    const r = await s.tickAt(offsetMs);
    if (r.status !== 0) throw new Error(`a tick failed while waiting for ${what}: exit ${r.status}, ${r.stderr || r.stdout}`);
    if (await check()) return;
    await D.sleep(150);
  }
  throw new Error(`timed out waiting for ${what}. The bot sent:\n${s.fake.sentTexts().slice(-6).join('\n---\n')}`);
}

const prompt = (project, round) => D.loopState(project).rounds[round].prompt;
const decisions = (project) => D.readAudit(project, 'DECISIONS.md');
const approvedMessage = (s, round) => D.lastText(s, new RegExp(`, round ${round} of \\d+: approved by the overnight run, without your Approve\\. The builder started with \\.audit\\\\round-0${round}-prompt\\.md\\.$`));

describe('Phase 7', { concurrency: 4 }, () => {
  // ---- the readers of lib/overnight.js, and the "(open)" mark of decisions.js ----

  test('lib/overnight.js: the "## Overnight" section, the items left for review, the rounds argument, the 7-day check and the long pause', () => {
    assert.deepEqual(O.overnightSection(GOAL_NIGHT), {
      present: true, body: '- [ ] hello.js prints hello\n- [ ] hello.js has a test', items: ['hello.js prints hello', 'hello.js has a test'], lines: ['- [ ] hello.js prints hello', '- [ ] hello.js has a test'],
    });
    assert.deepEqual(O.overnightSection(D.GOAL), { present: false, body: '', items: [], lines: [] });
    assert.deepEqual(O.overnightSection(GOAL_EMPTY_NIGHT).items, []);
    assert.equal(O.overnightSection(GOAL_EMPTY_NIGHT).present, true);
    // The heading in any letter case, items with or without a checkbox, and a "# " heading ends the section.
    assert.deepEqual(O.overnightSection('## overnight\n- one\n* [x] two\n# Other\n- three').items, ['one', 'two']);
    assert.deepEqual(O.reviewItems(GOAL_NIGHT), { present: true, whole: false, lines: ['- [ ] README.md shows how to run it'], body: '- [ ] hello.js prints hello\n- [ ] hello.js has a test\n- [ ] README.md shows how to run it' });
    // Word for word: one more space does not matter, other words do.
    assert.deepEqual(O.reviewItems(GOAL_NIGHT.replace('## Overnight\n- [ ] hello.js prints hello', '## Overnight\n- [ ]  hello.js  prints hello')).lines, ['- [ ] README.md shows how to run it']);
    assert.deepEqual(O.reviewItems(GOAL_NIGHT.replace('## Overnight\n- [ ] hello.js prints hello', '## Overnight\n- [ ] hello.js prints Hello')).lines,
      ['- [ ] hello.js prints hello', '- [ ] README.md shows how to run it']);
    // A definition of done without a list: the whole section is for review.
    const prose = '# G\n\n## Definition of done\nIt prints hello and has a test.\n\n## Overnight\n- [ ] a\n';
    assert.deepEqual(O.reviewItems(prose), { present: true, whole: true, lines: [], body: 'It prints hello and has a test.' });
    assert.equal(O.reviewItems('# G\n## Overnight\n- a\n').present, false);
    assert.deepEqual(['1', '5', '30', '0', '31', '-1', 'x', '', '3.5', ' 7 '].map(O.parseRounds), [1, 5, 30, null, null, null, null, null, null, 7]);
    const usage = (share) => ({ seven_day: { utilization: share, resets_at: '2026-10-17T19:00:00.000Z' }, seen_at: '2026-10-16T01:00:00.000Z' });
    assert.equal(O.sevenDayCheck(usage(0.69), 70), null);
    assert.deepEqual(O.sevenDayCheck(usage(0.7), 70), { share: 0.7, percent: 70, resetsAt: '2026-10-17T19:00:00.000Z', seenAt: '2026-10-16T01:00:00.000Z' });
    assert.equal(O.sevenDayCheck(usage(0.71), 70).percent, 71);
    assert.equal(O.sevenDayCheck(null, 70), null, 'no usage seen: the round runs');
    assert.equal(O.sevenDayCheck({ five_hour: { utilization: 0.9 } }, 70), null, 'only the 7-day window counts');
    const now = Date.now();
    assert.equal(O.longPause({ type: 'five_hour', resetMs: now + 11 * HOUR, nowMs: now, hours: 12 }), null);
    assert.equal(O.longPause({ type: 'five_hour', resetMs: now + 13 * HOUR, nowMs: now, hours: 12 }), 'far');
    assert.equal(O.longPause({ type: 'seven_day', resetMs: now + 10 * MIN, nowMs: now, hours: 12 }), 'seven_day');
    assert.equal(O.longPause({ type: null, resetMs: NaN, nowMs: now, hours: 12 }), null, 'an unknown reset time is the usual fallback wait');
  });

  test('decisions.js: an "(open)" answer, its replacement by the owner\'s answer, and the open entries of a file', (t) => {
    const project = path.join(ROOT, 'tests', 'tmp', 'unit', `open-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
    fs.mkdirSync(path.join(project, '.audit'), { recursive: true });
    t.after(() => fs.rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    appendDecisions(project, { title: 'Round 1', date: '2026-10-16', answers: [{ question: 'Line break?', answer: 'Yes', mark: 'assumed' }, { question: MUST_QUESTION, answer: '', mark: 'open' }] });
    const text = fs.readFileSync(path.join(project, '.audit', 'DECISIONS.md'), 'utf8');
    assert.ok(text.endsWith(`## Round 1, 2026-10-16\n- Q: Line break?\n  A: Yes (assumed)\n- Q: ${MUST_QUESTION}\n  A: ${OPEN_ANSWER} (open)\n`), text);
    assert.equal(OPEN_ANSWER, 'not answered yet, the overnight run does not wait for the owner; build another overnight item that does not depend on it');
    assert.deepEqual(openEntries(project), [{ question: MUST_QUESTION }]);
    assert.deepEqual(answerOpenQuestion(project, { question: 'Line break?', answer: 'No' }), { file: path.join(project, '.audit', 'DECISIONS.md'), replaced: false }, 'only an open entry is replaced');
    assert.deepEqual(answerOpenQuestion(project, { question: MUST_QUESTION, answer: 'In the project folder' }).replaced, true);
    const after = fs.readFileSync(path.join(project, '.audit', 'DECISIONS.md'), 'utf8');
    assert.ok(after.endsWith(`- Q: ${MUST_QUESTION}\n  A: In the project folder (answered)\n`), after);
    assert.ok(after.includes('A: Yes (assumed)'), 'the other answer stays');
    assert.deepEqual(openEntries(project), []);
    assert.equal(answerOpenQuestion(project, { question: MUST_QUESTION, answer: 'again' }).replaced, false, 'an answered entry is not replaced again');
    // The template names the mark, and the builder's intro explains it.
    assert.match(fs.readFileSync(path.join(ROOT, 'templates', 'DECISIONS.template.md'), 'utf8'), /"open" means an overnight run left a MUST question/);
    assert.match(require('../scripts/lib/builder_input').DECISIONS_INTRO, /An answer marked "\(open\)" is not answered yet: do not build what depends on it\.$/);
  });

  // ---- 1. /overnight's pre-flight ----

  test('/overnight pre-flight: the rounds argument, no "## Overnight", an empty section, a running loop, a loop that ended DONE or STOP_FOR_HUMAN, a paused loop, the 7-day share; each refusal is one line in bot.log', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = night(s, 'Night');
    D.newProject(s, 'Plain');
    D.newProject(s, 'Empty', { goal: GOAL_EMPTY_NIGHT });
    const refusals = () => s.logTexts().filter((line) => line.startsWith('/overnight was refused: '));

    // The usage line, for a missing or a bad number of rounds. Not a refusal.
    for (const text of ['/overnight', '/overnight Night', '/overnight Night five', '/overnight Night 0', '/overnight Night 31', '/overnight Night 3 4']) {
      assert.equal(await D.say(s, text), USAGE, text);
    }
    assert.equal(await D.say(s, '/overnight No/Name 3'), `The name may only have letters (a-z, A-Z), digits, "-" and "_".\n${USAGE}`);
    assert.equal(refusals().length, 0);
    assert.equal(await D.say(s, '/overnight Nowhere 3'), `/overnight was refused: there is no project named Nowhere in ${s.projectsRoot}.`);

    // GOAL.md without the section, and with an empty one.
    assert.equal(await D.say(s, '/overnight Plain 3'), '/overnight was refused: Plain: GOAL.md has no "## Overnight" section. An overnight run builds only the items of that section: '
      + 'add it (see templates/GOAL.template.md), commit it, and send /overnight again. /loop Plain runs the normal loop.');
    assert.equal(await D.say(s, '/overnight Empty 3'), '/overnight was refused: Empty: the "## Overnight" section of GOAL.md has no item. Add the items an overnight run may build with no review, commit, and send /overnight again.');
    assert.equal(fs.existsSync(path.join(s.projectsRoot, 'Plain', '.audit', 'loop.json')), false, 'nothing started');

    // The 7-day share: at and above the limit refused, with the percent; below it, and with no usage seen, allowed.
    assert.equal(s.state().lastUsage, undefined, 'no usage seen yet');
    setUsage(s, 0.71);
    assert.match(await D.say(s, '/overnight Night 3'), /^\/overnight was refused: Night: the 7-day window is at 71% \(seen \d\d:\d\d\), and an overnight run stops at 70%\. It resets \d{4}-\d\d-\d\d \d\d:\d\d\. Try again after that; \/loop Night runs the normal loop meanwhile\.$/);
    setUsage(s, 0.7);
    assert.match(await D.say(s, '/overnight Night 3'), /^\/overnight was refused: Night: the 7-day window is at 70% /);
    setUsage(s, 0.69);
    s.script({ auditor: [{ reply: 'continue', delayMs: 20000 }], builder: [] });
    const started = await D.say(s, '/overnight Night 3');
    assert.equal(started, [
      'Night: the overnight run started, with at most 3 rounds (the round cap is 3). The rounds run back to back without your Approve, on the items of GOAL.md\'s "## Overnight" section only.',
      STOPS,
      'First the auditor checks GOAL.md (goal check 1).',
    ].join('\n'));
    const loop = D.loopState(project);
    assert.equal(loop.mode, 'overnight');
    assert.equal(loop.cap, 3);
    assert.deepEqual({ ...loop.overnight, startedAt: 'x' }, { startedAt: 'x', rounds: 3, cap: 3, fromRound: 0, continued: false });
    assert.match(D.loopLog(project)[0], /^---- \/overnight Night 3: loop [0-9a-f]{8} started in overnight mode, at most 3 rounds, stops at 70% of the 7-day window, claude /);

    // A running loop: refused as /loop refuses it.
    assert.match(await D.say(s, '/overnight Plain 3'), /^\/overnight was refused: a loop is already running: Night, goal check \(goal check running since \d\d:\d\d:\d\d\)\. One loop at a time; \/stop ends it\.$/);
    assert.match(await D.say(s, '/overnight Night 3'), /^\/overnight was refused: a loop is already running: Night, goal check/);
    await D.say(s, '/stop');
    await D.tickUntil(s, () => D.endMessage(s), 'the end of Night');
    setUsage(s, null);

    // A paused loop counts as running.
    const paused = night(s, 'Paused');
    s.script({ auditor: [{ reply: 'limit', resetInS: 3600 }], builder: [] });
    await D.say(s, '/overnight Paused 2');
    await D.tickUntil(s, () => D.loopState(paused).step === 'paused', 'the pause');
    assert.match(await D.say(s, '/overnight Paused 2'), /^\/overnight was refused: a loop is already running: Paused, goal check \(paused until \d\d:\d\d: the plan's usage limit was reached\)\. One loop at a time; \/stop ends it\.$/);
    await D.say(s, '/stop');
    await D.tickUntil(s, () => /Paused: the loop ended/.test(D.endMessage(s) || ''), 'the end of Paused');

    // A loop that ended DONE, and one that ended STOP_FOR_HUMAN.
    const done = night(s, 'Done');
    s.script({ auditor: ['continue', 'done'], builder: ['ok'] });
    await D.startLoop(s, 'Done');
    await D.tickUntil(s, () => /DONE after round 1/.test(D.endMessage(s) || ''), 'DONE');
    assert.equal(await D.say(s, '/overnight Done 2'), '/overnight was refused: Done\'s loop is finished: DONE after round 1 of 3. There is nothing to continue, so there is nothing for an overnight run.');
    assert.equal(D.loopState(done).step, 'ended');
    night(s, 'Stopped');
    s.script({ auditor: ['continue', 'stop'], builder: ['ok'] });
    await D.startLoop(s, 'Stopped');
    await D.tickUntil(s, () => /STOP_FOR_HUMAN after round 1/.test(D.endMessage(s) || ''), 'STOP_FOR_HUMAN');
    assert.equal(await D.say(s, '/overnight Stopped 2'), '/overnight was refused: Stopped\'s loop ended with: The auditor says STOP_FOR_HUMAN after round 1 of 3. '
      + 'An overnight run continues only from a proposed prompt that waits (after the round cap, Stop or /stop at a proposal, or an earlier overnight run). '
      + 'Send /resume Stopped first: it asks you for the next round\'s prompt.');
    // A proposal that waits in a normal loop: Stop, then /overnight.
    night(s, 'Waiting');
    s.script({ auditor: ['continue', 'continue'], builder: ['ok'] });
    await D.startLoop(s, 'Waiting');
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal');
    assert.match(await D.say(s, '/overnight Waiting 2'), /^\/overnight was refused: a loop is already running: Waiting, round 1 of 3 \(waiting for Approve, Edit or Stop on the prompt for round 2\)\. One loop at a time; \/stop ends it\. To turn that loop into an overnight run: press Stop on its prompt, then send \/overnight again\.$/);

    const logged = refusals();
    assert.equal(logged.length, 11, logged.join('\n'));
    assert.ok(logged.every((line) => !line.includes(' | ')), 'each refusal is one line');
  });

  // ---- 2. a fresh run of three rounds, with no Approve ----

  test('a fresh overnight run of three rounds: the goal check, round 1 with the /new prompt, two prompts approved by the loop, DONE with its end text and resume, the morning report, every message silent', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = night(s, 'Night3');
    s.script({ auditor: ['continue', 'continue', 'continue', 'done'], builder: ['ok', 'ok', 'ok'] });
    const before = s.fake.sent.length;
    s.fake.message(s.owner, '/overnight Night3 3');
    await s.tick();
    assert.equal(s.fake.sent[before].silent, false, 'the answer to /overnight itself has a sound');
    await D.tickUntil(s, () => /every item of ## Overnight is done/.test(D.endMessage(s) || ''), 'the end of the run');

    // No button was ever offered, and every proposal was approved by the loop.
    assert.equal(D.proposalMessage(s), undefined, 'no Approve / Edit / Stop');
    assert.deepEqual(D.keyboards(s), [], 'no buttons at all');
    assert.deepEqual(s.calls().map((c) => `${c.kind}:${c.audit || c.mode}:${c.round ?? ''}`), ['auditor:goal-check:0', 'builder:ok:', 'auditor:round:1', 'builder:ok:', 'auditor:round:2', 'builder:ok:', 'auditor:round:3']);
    const loop = D.loopState(project);
    assert.equal(loop.rounds[1].prompt.source, 'new');
    assert.equal(loop.rounds[1].prompt.approvedBy, undefined);
    for (const round of [2, 3]) {
      const record = loop.rounds[round].prompt;
      assert.equal(record.approvedBy, 'overnight', `round ${round}`);
      assert.equal(record.edits, 0);
      assert.equal(record.notes, 0);
      assert.equal(record.source, 'auditor');
      assert.equal(record.proposedAgain, false);
      const text = D.readAudit(project, `round-0${round}-prompt.md`);
      assert.equal(text, D.readAudit(project, `round-0${round}-prompt-proposed.md`));
      assert.equal(text, D.readAudit(project, `round-0${round}-prompt-auditor.md`));
      assert.match(text, new RegExp(`^AUDITOR_PROMPT_MARKER for round ${round}\\n`));
      assert.ok(approvedMessage(s, round), `the approval message of round ${round}`);
      assert.ok(D.documents(s).some((m) => m.filename === `Night3-round-0${round}-prompt.md` && m.caption === `Night3: the prompt for round ${round}, approved by the overnight run`), `the prompt file of round ${round}`);
      assert.ok(D.said(s, new RegExp(`^Night3, round ${round - 1} of 3: audited\\.\\n[\\s\\S]*\\nNext: the auditor's prompt for round ${round} follows as a file\\. The overnight run starts round ${round} with it now, without your Approve\\.$`)), `the round message of round ${round - 1}`);
      assert.ok(D.loopLog(project).includes(`round ${round}: prompt approved by the overnight run, without the owner's Approve, ${Buffer.byteLength(text)} bytes`));
    }
    // The end: DONE, with the resume that asks for the next round's prompt.
    const end = D.endMessage(s).split('\n');
    assert.equal(end[0], 'Night3: the loop ended. Overnight: every item of ## Overnight is done after round 3 of 3.');
    assert.ok(end.includes('Summary: DONE_SUMMARY_MARKER hello.js prints hello and has a test.'));
    assert.ok(end.includes('The rest of GOAL.md waits for your review: /resume Night3 asks you for the next round\'s prompt.'));
    assert.deepEqual(loop.end.resume, { how: 'new-prompt', round: 4 });
    assert.equal(loop.overnight.lastRound, 3);
    assert.equal(loop.overnight.how, 'Overnight: every item of ## Overnight is done after round 3 of 3.');
    assert.equal(s.state().lastLoop.resumable, true);

    // The morning report: the line at the top and the three sections.
    const report = D.readAudit(project, 'LOOP_REPORT.md');
    assert.match(report, /^# Loop report: Night3\n\n- Overnight run: started \d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d, ended \d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d, 3 rounds \(cap 3\): Overnight: every item of ## Overnight is done after round 3 of 3\.\n- Project: /);
    assert.ok(report.includes('\n## Overnight items\n\n- [ ] hello.js prints hello\n- [ ] hello.js has a test\n\nThe last verdict (round 3): DONE. Every definition-of-done item has evidence.\nSummary: DONE_SUMMARY_MARKER hello.js prints hello and has a test.\n'), report);
    assert.ok(report.includes('\n## Open questions\n\nNone.\n'), report);
    assert.ok(report.includes('\n## Left for your review\n\n- [ ] README.md shows how to run it\n\n## Rounds\n'), report);
    assert.ok(D.reports(s).length === 1 && D.reports(s)[0].content === report);

    // Silence: everything the loop sent on its own, files included, has disable_notification; only the answer to /overnight has not.
    const loud = messagesSince(s, before).filter((m) => !m.silent);
    assert.deepEqual(loud.map((m) => m.text || m.filename), [s.fake.sent[before].text]);
    assert.ok(messagesSince(s, before).length > 12, 'the round messages, the files, the approvals, the end and the report');

    // /resume after DONE: normal mode, and it asks for the next round's prompt.
    const resumed = await D.say(s, '/resume Night3');
    assert.ok(D.said(s, /^Night3: resuming\. It had ended: Overnight: every item of ## Overnight is done after round 3 of 3\.\nThe overnight run is over: from here every prompt waits for your Approve\.$/), D.texts(s).slice(-3).join('\n---\n'));
    assert.match(resumed, /^Night3, round 4 of 3: send the prompt for round 4, as a text message, or as a \.md or \.txt file \(up to 100 KB\)\.\nI show it to you with Approve, Edit and Stop before anything starts\. \/cancel ends the loop again; nothing changes\.$/);
    assert.equal(D.loopState(project).mode, 'normal');
    assert.equal(D.loopState(project).step, 'prompt-wait');
    assert.equal(s.fake.sent[s.fake.sent.length - 1].silent, false, 'the answer to /resume has a sound');
    assert.equal(await D.say(s, '/cancel'), `Night3: the loop ended. No prompt for round 4 was sent (/cancel), so the loop ended again. Nothing changed.\nRecords: ${path.join(project, '.audit')} (loop.log, loop.json and the round-NN-* files)`);
    // The report after the normal end still carries the overnight run's line.
    assert.match(D.readAudit(project, 'LOOP_REPORT.md'), /^# Loop report: Night3\n\n- Overnight run: started .*, 3 rounds \(cap 3\): Overnight: every item of ## Overnight is done after round 3 of 3\.\n/);
  });

  // ---- 3. a continued run ----

  test('a continued run: a loop that ended at the cap in normal mode, then /overnight: the proposal approved by the loop, the cap raised, no goal check, and the material\'s Written by line and OVERNIGHT RUN block', async (t) => {
    const s = await botSandbox(t, { config: { roundCap: 1 } });
    await s.firstTick();
    const project = night(s, 'Cont');
    s.script({ auditor: ['continue', 'continue', 'continue', 'done'], builder: ['ok', 'ok', 'ok'] });
    await D.startLoop(s, 'Cont');
    await D.tickUntil(s, () => /round cap is reached: round 1 of 1/.test(D.endMessage(s) || ''), 'the cap');
    assert.ok(s.fake.sent.every((m) => !m.silent), 'a normal loop sends nothing silent');
    assert.equal(blockOf(materialOf(s, 'goal-check', 0), 'OVERNIGHT RUN'), null, 'no OVERNIGHT RUN block in a normal loop\'s goal check');
    assert.equal(blockOf(materialOf(s, 'round', 1), 'OVERNIGHT RUN'), null, 'nor in its round');
    assert.equal(D.loopState(project).mode, 'normal');

    const before = s.fake.sent.length;
    const started = await D.say(s, '/overnight Cont 2');
    const mark = s.fake.sent.slice(before);
    assert.equal(mark[0].text, [
      'Cont: the overnight run started from the prompt that waited for round 2, with at most 2 more rounds (the round cap is now 3). The rounds run back to back without your Approve, on the items of GOAL.md\'s "## Overnight" section only.',
      STOPS,
      'No goal check: it had ended with "The round cap is reached: round 1 of 1 ended with CONTINUE, and the work is not done."',
    ].join('\n'));
    assert.equal(mark[1].method, 'sendDocument');
    assert.equal(mark[1].filename, 'Cont-round-02-prompt.md');
    assert.equal(mark[1].caption, 'Cont: the prompt for round 2, approved by the overnight run');
    assert.equal(mark[2].text, started);
    assert.equal(started, 'Cont, round 2 of 3: approved by the overnight run, without your Approve. The builder started with .audit\\round-02-prompt.md.');
    assert.ok(mark.every((m) => !m.silent), 'the answers to /overnight itself have a sound');
    let loop = D.loopState(project);
    assert.equal(loop.mode, 'overnight');
    assert.equal(loop.cap, 3, '1 round done plus 2');
    assert.deepEqual({ ...loop.overnight, startedAt: 'x' }, { startedAt: 'x', rounds: 2, cap: 3, fromRound: 1, continued: true, round: 2 });
    assert.equal(loop.rounds[2].prompt.approvedBy, 'overnight');
    assert.equal(loop.rounds[2].prompt.proposedAgain, true);
    assert.equal(loop.rounds[2].prompt.edits, 0);
    assert.equal(loop.ends.length, 1, 'the end at the cap is on record');

    await D.tickUntil(s, () => /every item of ## Overnight is done after round 3 of 3/.test(D.endMessage(s) || ''), 'DONE');
    assert.equal(s.calls().filter((c) => c.audit === 'goal-check').length, 1, 'no second goal check');
    const material = materialOf(s, 'round', 2);
    assert.deepEqual(blockOf(material, 'PROMPT RECORD').split('\n').slice(0, 3), [
      'Written by: you, as NEXT_PROMPT in the audit of round 1 (started by the overnight run, without the owner\'s Approve)', 'Owner edits: 0', 'Owner notes: none',
    ]);
    const block = blockOf(material, 'OVERNIGHT RUN');
    assert.match(block, /^This loop is an overnight run, started by the owner on \d{4}-\d\d-\d\d at \d\d:\d\d \(this PC's time\)\.\nIts rounds run without the owner's Approve until every item of GOAL\.md's "## Overnight" section is done\. The owner does not review rounds during this run and answers no question while it runs; he may be awake or asleep\.\nBuild only those items: NEXT_PROMPT names one overnight item, or a smaller step of one, or two or three items when GOAL\.md's Constraints set a round size \(never two heavy ones\)\. The owner reviews the rest of GOAL\.md later, in a normal loop\.$/);
    assert.ok(material.includes('----- BEGIN OVERNIGHT RUN (the loop\'s own record of this run) ['));
    assert.ok(material.indexOf('BEGIN OVERNIGHT RUN') > material.indexOf('DECISIONS.md: none yet') && material.indexOf('BEGIN OVERNIGHT RUN') < material.indexOf('BEGIN BUILDER ROUND'), 'after DECISIONS.md, before BUILDER ROUND');
    assert.equal(blockOf(materialOf(s, 'round', 3), 'OVERNIGHT RUN'), block, 'the same block in the next round');
    loop = D.loopState(project);
    assert.equal(loop.rounds[3].prompt.approvedBy, 'overnight');
    assert.equal(loop.rounds[3].prompt.proposedAgain, false);
    assert.match(D.readAudit(project, 'LOOP_REPORT.md'), /^# Loop report: Cont\n\n- Overnight run: started .*, 2 rounds \(cap 3\): Overnight: every item of ## Overnight is done after round 3 of 3\.\n- Project: /);

    // --print-material: the material of a round that has a verdict, without a Claude call and without writing anything.
    const calls = s.calls().length;
    const files = fs.readdirSync(path.join(project, '.audit')).sort();
    const printed = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run_auditor.js'), '--project', project, '--round', '2', '--print-material', '--config', s.config], { encoding: 'utf8', env: s.env() });
    assert.equal(printed.status, 0, printed.stderr);
    assert.match(printed.stderr, /round 2: --print-material, \d+ characters; no Claude call/);
    assert.equal(blockOf(printed.stdout, 'OVERNIGHT RUN'), block);
    assert.equal(blockOf(printed.stdout, 'PROMPT RECORD'), blockOf(material, 'PROMPT RECORD'), 'the same material as the audit got');
    assert.equal(blockOf(printed.stdout, 'git diff (base to HEAD, without .audit/ and HANDOFF.md)'), blockOf(material, 'git diff (base to HEAD, without .audit/ and HANDOFF.md)'), 'with the base of that audit');
    assert.equal(s.calls().length, calls, 'no call of the fake claude');
    assert.deepEqual(fs.readdirSync(path.join(project, '.audit')).sort(), files, 'nothing written');
  });

  // ---- 4. questions in an overnight run ----

  test('questions in an overnight run: a DEFAULT question is assumed at once at the goal check and after a round; a MUST question after a round is left open, the follow-up runs at once, its buttons stay live two rounds later, and the answer replaces the (open) entry and reaches the next builder', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = night(s, 'Open');
    // Goal check: DEFAULT, assumed at once, the goal check runs again. Round 1: DEFAULT after a round, the same.
    // Round 2: MUST, left open; its follow-up CONTINUEs. Rounds 3 and 4 run; the owner answers during round 4.
    s.script({
      auditor: ['ask_default', 'continue', 'ask_default', 'continue', 'ask_must', 'continue', 'continue', { reply: 'continue', delayMs: 6000 }, 'done'],
      builder: ['ok', 'ok', 'ok', { mode: 'ok', delayMs: 12000 }, 'ok'],
    });
    const config = s.writeConfig({ roundCap: 5 });
    const tick = () => s.tick({ configFile: config });
    s.fake.message(s.owner, '/overnight Open 5');
    await tick();
    const until = (check, what) => D.tickUntil(s, check, what, { tickOptions: { configFile: config } });

    // The goal check's DEFAULT question: asked with its buttons, answered at once, the goal check runs again.
    await until(() => D.loopState(project).step === 'builder' && D.loopState(project).round === 1, 'round 1');
    assert.ok(D.questionMessage(s, 1), 'the question was sent, with its buttons');
    assert.ok(D.said(s, /^Open, goal check: question 1 \[DEFAULT\] gets the recommended option at once \(an overnight run does not wait for a DEFAULT answer\): Yes\nIt is marked \(assumed\) in \.audit\\DECISIONS\.md\. You can change it later\.$/), D.texts(s).join('\n---\n'));
    assert.ok(D.said(s, /^Open, goal check: 1 answer saved in \.audit\\DECISIONS\.md\. Asking the auditor again \(goal check 2\)\.$/));
    assert.match(decisions(project), /## Goal check, \d{4}-\d\d-\d\d\n- Q: Should the output end with a line break\?\n {2}A: Yes \(assumed\)\n/);
    assert.equal(s.calls().filter((c) => c.audit === 'goal-check').length, 2);
    assert.ok(D.loopLog(project).includes('goal check: question 1 [DEFAULT] is answered at once (overnight run): assumed the recommended option: Yes'));

    // Round 1's DEFAULT question: assumed at once, the follow-up runs, round 2 starts.
    await until(() => D.loopState(project).round === 2 && D.loopState(project).step === 'builder', 'round 2');
    assert.ok(D.said(s, /^Open, round 1 of 5: question 1 \[DEFAULT\] gets the recommended option at once/));
    assert.ok(D.said(s, /^Open, round 1 of 5: 1 answer saved in \.audit\\DECISIONS\.md\. Asking the auditor again\.$/));
    assert.equal(s.calls().filter((c) => c.audit === 'followup' && c.round === 1).length, 1);
    assert.equal(prompt(project, 2).approvedBy, 'overnight');

    // Round 2's MUST question: left open, written (open), the follow-up at once, and its CONTINUE starts round 3.
    await until(() => D.loopState(project).round === 3 && D.loopState(project).step === 'builder', 'round 3');
    const openMessage = D.questionMessage(s, 1);
    assert.match(openMessage.text, /^Open, round 2 of 5: Question 1 of 1 \[MUST\]\nWhere should hello\.js keep its data file\?\n\n1\. In the project folder \(recommended\)\n2\. In the home folder$/);
    assert.ok(D.said(s, /^Open, round 2 of 5: 1 question tagged MUST is left open: the overnight run does not wait for your answer\. It is written as \(open\) in \.audit\\DECISIONS\.md, its buttons stay live, and the auditor's follow-up runs now to go on with an overnight item that does not depend on it\.$/), D.texts(s).slice(-8).join('\n---\n'));
    assert.match(decisions(project), new RegExp(`## Round 2, \\d{4}-\\d\\d-\\d\\d\\n- Q: ${escape(MUST_QUESTION)}\\n {2}A: ${escape(OPEN_ANSWER)} \\(open\\)\\n`));
    let loop = D.loopState(project);
    assert.equal(loop.openQuestions.length, 1);
    assert.equal(loop.openQuestions[0].answer, null);
    assert.equal(loop.openQuestions[0].round, 2);
    assert.deepEqual(loop.decisions[2].items.map((d) => d.how), ['open']);
    const followup = materialOf(s, 'followup', 2);
    assert.match(blockOf(followup, 'DECISIONS.md'), /\(open\)/, 'the follow-up got the (open) entry');
    assert.ok(blockOf(followup, 'OVERNIGHT RUN'), 'and the OVERNIGHT RUN block');
    assert.equal(s.calls().filter((c) => c.audit === 'followup' && c.round === 2).length, 1);
    assert.equal(prompt(project, 3).approvedBy, 'overnight');

    // Two rounds later the open question's buttons still work. The answer replaces the (open) entry and reaches the next builder.
    await until(() => D.loopState(project).round === 4 && D.loopState(project).step === 'builder' && D.jobIsUp(s, project, 'builder', 3), 'round 4');
    assert.match(D.readAudit(project, 'round-03-builder-input.md'), /\(open\)/, 'round 3\'s builder was told the question is open');
    const before = s.fake.sent.length;
    D.press(s, openMessage, '1. In the project folder');
    await tick();
    const after = sentSince(s, before);
    assert.deepEqual(after.map((m) => m.method), ['answerCallbackQuery', 'sendMessage']);
    assert.equal(after[0].text, 'Saved');
    assert.equal(after[1].text, 'Open, round 2 of 5: your answer to open question 1 is saved: In the project folder. It replaces the (open) entry in .audit\\DECISIONS.md, and reaches the builder with the next round and the auditor with the next audit.');
    assert.equal(after[1].silent, false, 'the answer to a button press has a sound');
    assert.match(decisions(project), new RegExp(`- Q: ${escape(MUST_QUESTION)}\\n {2}A: In the project folder \\(answered\\)\\n`));
    assert.doesNotMatch(decisions(project), /\(open\)/);
    loop = D.loopState(project);
    assert.deepEqual({ ...loop.openQuestions[0].answer, at: 'x' }, { text: 'In the project folder', how: 'button', at: 'x' });
    assert.equal(loop.step, 'builder', 'the loop goes on: no follow-up for the answer');
    assert.equal(loop.round, 4);
    assert.ok(D.loopLog(project).includes('round 2: open question 1 answered (button): In the project folder'));
    // The same button once more: it has expired.
    D.press(s, openMessage, '1. In the project folder');
    await tick();
    assert.equal(s.fake.sent[s.fake.sent.length - 1].text, 'This button has expired.');

    await until(() => /every item of ## Overnight is done after round 5 of 5/.test(D.endMessage(s) || ''), 'DONE');
    assert.equal(s.calls().filter((c) => c.audit === 'followup').length, 2, 'no follow-up ran for the answer');
    assert.match(D.readAudit(project, 'round-05-builder-input.md'), /A: In the project folder \(answered\)/, 'the next builder got the answer');
    assert.match(blockOf(materialOf(s, 'round', 4), 'DECISIONS.md'), /A: In the project folder \(answered\)/, 'and the next audit too');
    const report = D.readAudit(project, 'LOOP_REPORT.md');
    assert.ok(report.includes('\n## Open questions\n\nNone.\n'));
    assert.match(report, /- Q1 \[MUST\] Where should hello\.js keep its data file\?\n {2}A: In the project folder \(answered, by button\)/);
    assert.doesNotMatch(D.endMessage(s), /still open/);
  });

  test('questions in an overnight run: a follow-up that asks again makes the loop wait with silent reminders; the answer runs the follow-up and the run goes on; a run that ends with an open question has /resume ask it again first', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    // Again: round 1's MUST is left open, the follow-up asks it again, the loop waits.
    const again = night(s, 'Again');
    s.script({ auditor: ['continue', 'ask_must', 'ask_must', 'continue', 'continue', 'done'], builder: ['ok', 'ok', 'ok'] });
    let clock = 0;
    s.fake.message(s.owner, '/overnight Again 3');
    await s.tickAt(clock);
    await tickUntilAt(s, clock, () => D.loopState(again).step === 'questions' && s.calls().filter((c) => c.audit === 'followup').length === 1, 'the follow-up that asks again');
    assert.ok(D.said(s, /^Again, round 1 of 3: the follow-up asks again: 1 question tagged MUST\. Every overnight item that is left depends on an open question, or a new one came up, so the loop waits for your answer to it\. Nothing more runs on its own in this round\.$/), D.texts(s).slice(-4).join('\n---\n'));
    let loop = D.loopState(again);
    assert.equal(loop.openQuestions.length, 1, 'the first one is still open');
    assert.equal(loop.questions.items.length, 1, 'and the follow-up\'s is pending');
    assert.equal(D.keyboards(s).filter((m) => /Question 1 of 1 \[MUST\]/.test(m.text)).length, 2, 'both were sent with buttons');
    const status = (await D.say(s, '/status', { configFile: s.writeConfig({ testClockOffsetMs: clock }) })).split('\n');
    assert.equal(status[1], 'Overnight run: round 1 of 3. It stops at 70% of the 7-day window (now 12%). 1 open question.');
    assert.match(status[2], /^Step: waiting for you: 1 question of the auditor \(1 \[MUST\]\)$/);
    // Three hours later: a reminder, silent, with the pending question again. No reminder for the open one.
    clock += 3 * HOUR + MIN;
    const before = s.fake.sent.length;
    await s.tickAt(clock);
    const reminder = sentSince(s, before);
    assert.equal(reminder[0].text, 'Again, round 1 of 3: a reminder. 1 question of the auditor is still open, and the loop waits for your answer.');
    assert.ok(reminder.every((m) => m.silent), 'the reminder and the question come without a sound');
    assert.equal(reminder.length, 2);
    // The owner answers the pending question: the open twin is answered too, the follow-up runs, and the run goes on.
    D.press(s, D.lastKeyboard(s), '1. In the project folder');
    await s.tickAt(clock);
    await tickUntilAt(s, clock, () => /every item of ## Overnight is done after round 3 of 3/.test(D.endMessage(s) || ''), 'the end');
    loop = D.loopState(again);
    assert.equal(loop.openQuestions[0].answer.text, 'In the project folder');
    assert.equal(s.calls().filter((c) => c.audit === 'followup').length, 2);
    const written = decisions(again);
    assert.equal((written.match(/\(answered\)/g) || []).length, 2, 'the open entry is replaced, and the follow-up\'s answer is written');
    assert.doesNotMatch(written, /\(open\)/);
    assert.equal(loop.rounds[2].prompt.approvedBy, 'overnight');

    // EndOpen: the run ends at the cap with an open question. /resume asks it again first.
    const endOpen = night(s, 'EndOpen');
    s.script({ auditor: ['continue', 'ask_must', 'continue', 'continue'], builder: ['ok', 'ok'] });
    await D.say(s, '/overnight EndOpen 2');
    await D.tickUntil(s, () => /round cap is reached: round 2 of 2/.test(D.endMessage(s) || ''), 'the cap');
    const end = D.endMessage(s).split('\n');
    assert.ok(end.includes('/overnight EndOpen <rounds> continues in overnight mode instead, for that many more rounds.'), end.join('\n'));
    assert.ok(end.includes('1 question of the auditor is still open (left for later during the overnight run): /resume EndOpen asks it again before it goes on.'), end.join('\n'));
    const report = D.readAudit(endOpen, 'LOOP_REPORT.md');
    assert.ok(report.includes(`\n## Open questions\n\n- Round 1, question 1 [MUST]: ${MUST_QUESTION}\n  options: In the project folder | In the home folder\n  recommended: In the project folder\n\n/resume EndOpen asks it again before it goes on.\n`), report);
    assert.match(report, /A: not answered yet \(open: not answered yet, left for later by the overnight run\)/);
    assert.ok(report.includes('\n## Overnight items\n\n- [ ] hello.js prints hello\n- [ ] hello.js has a test\n\nThe last verdict (round 2): CONTINUE. Round 2 did part of the work.\nFindings:\n- hello.js: there is no test yet\n'), report);
    // The buttons of the open question expired with the loop.
    const openMessage = D.keyboards(s).filter((m) => /EndOpen, round 1 of 2: Question 1 of 1 \[MUST\]/.test(m.text)).pop();
    D.press(s, openMessage, '1. In the project folder');
    await s.tick();
    assert.equal(s.fake.sent[s.fake.sent.length - 1].text, 'This button has expired.');

    const mark = s.fake.sent.length;
    await D.say(s, '/resume EndOpen');
    const asked = sentSince(s, mark);
    assert.equal(asked[0].text, 'EndOpen: resuming. It had ended: The round cap is reached: round 2 of 2 ended with CONTINUE, and the work is not done.\nThe overnight run is over: from here every prompt waits for your Approve.');
    assert.equal(asked[1].text, 'EndOpen, round 1 of 2: 1 question of the auditor was left open during the overnight run. Answer it first; then the loop goes on.');
    assert.match(asked[2].text, /^EndOpen, round 1 of 2: Question 1 of 1 \[MUST\]\nWhere should hello\.js keep its data file\?/);
    assert.ok(asked[2].replyMarkup, 'with buttons');
    assert.ok(asked.every((m) => !m.silent), 'answers to /resume have a sound');
    assert.equal(D.loopState(endOpen).step, 'questions');
    assert.equal(D.loopState(endOpen).mode, 'normal');
    D.press(s, asked[2], '2. In the home folder');
    await s.tick();
    assert.ok(D.said(s, /^EndOpen, round 1 of 2: 1 answer saved in \.audit\\DECISIONS\.md, in place of the \(open\) entry\. The loop goes on\.$/), D.texts(s).slice(-4).join('\n---\n'));
    assert.match(decisions(endOpen), new RegExp(`- Q: ${escape(MUST_QUESTION)}\\n {2}A: In the home folder \\(answered\\)\\n`));
    // Then the proposal comes back with buttons: normal mode.
    assert.ok(D.said(s, /^EndOpen, round 3 of 2: the proposed prompt is back\. The round cap is 2: Approve raises it to 3\.$/));
    assert.match(D.proposalMessage(s).text, /^EndOpen, round 3 of 2: start the builder with this prompt\?$/);
    assert.equal(s.calls().filter((c) => c.audit === 'followup').length, 3, 'no follow-up for the answer after /resume');
    assert.equal(D.loopState(endOpen).openQuestions[0].answer.how, 'button');
  });

  // ---- 5. the 7-day window ----

  test('the 7-day window: at 71% in an audit the run ends before the next round with the proposal as a file; /resume brings it back with buttons; /overnight is refused at 71% and allowed at 69%', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = night(s, 'Seven');
    s.script({ auditor: ['continue', { reply: 'continue', sevenDay: 0.71 }, 'continue', 'done'], builder: ['ok', 'ok', 'ok'] });
    await D.say(s, '/overnight Seven 3');
    await D.tickUntil(s, () => D.endMessage(s), 'the 7-day stop');
    const end = D.endMessage(s).split('\n');
    assert.match(end[0], /^Seven: the loop ended\. Overnight: stopped before round 2: the 7-day window is at 71% \(an overnight run stops at 70%\); it resets \d{4}-\d\d-\d\d \d\d:\d\d\.$/);
    assert.ok(end.includes('The auditor\'s prompt for round 2 follows as a file. It is saved as .audit\\round-02-prompt-proposed.md; no round starts.'), end.join('\n'));
    assert.ok(end.includes('/resume Seven brings it back with Approve, Edit and Stop. /overnight Seven <rounds> continues in overnight mode once the window is below 70%.'));
    const last = s.fake.sent[s.fake.sent.length - 1];
    assert.equal(last.method, 'sendDocument');
    assert.equal(last.filename, 'Seven-round-02-prompt.md');
    assert.equal(last.caption, 'Seven: the auditor\'s prompt for a round 2. The loop has ended: nothing starts.');
    assert.ok(last.silent);
    assert.ok(D.said(s, /^Seven, round 1 of 3: audited\.\n/), 'the round message came first');
    assert.equal(s.calls().filter((c) => c.kind === 'builder').length, 1, 'round 2 did not start');
    let loop = D.loopState(project);
    assert.deepEqual(loop.end.resume, { how: 'proposal', round: 2 });
    assert.equal(loop.rounds[2], undefined, 'no record for a round that did not start');
    assert.ok(D.loopLog(project).includes('overnight: the 7-day window is at 71% (the limit is 70%): round 2 does not start'));
    assert.equal(s.state().lastUsage.seven_day.utilization, 0.71);
    assert.match(D.readAudit(project, 'LOOP_REPORT.md'), /- Overnight run: started .*, 1 round \(cap 3\): Overnight: stopped before round 2: the 7-day window is at 71%/);

    // /overnight again: refused while 71% stands.
    assert.match(await D.say(s, '/overnight Seven 2'), /^\/overnight was refused: Seven: the 7-day window is at 71% \(seen \d\d:\d\d\), and an overnight run stops at 70%\. It resets /);
    // /resume: the proposal comes back with buttons, in normal mode.
    await D.say(s, '/resume Seven');
    assert.ok(D.said(s, /^Seven, round 2 of 3: the proposed prompt is back\.$/));
    assert.match(D.proposalMessage(s).text, /^Seven, round 2 of 3: start the builder with this prompt\?$/);
    assert.equal(D.loopState(project).mode, 'normal');
    D.press(s, D.proposalMessage(s), 'Stop');
    await s.tick();
    assert.ok(D.said(s, /^Seven: the loop ended\. Stopped by you at the prompt for round 2\./));

    // At 69% it is allowed, and continues in overnight mode from the same proposal.
    setUsage(s, 0.69);
    const started = await D.say(s, '/overnight Seven 2');
    assert.equal(started, 'Seven, round 2 of 3: approved by the overnight run, without your Approve. The builder started with .audit\\round-02-prompt.md.');
    assert.ok(D.said(s, /^Seven: the overnight run started from the prompt that waited for round 2, with at most 2 more rounds \(the round cap is now 3\)\./));
    loop = D.loopState(project);
    assert.equal(loop.mode, 'overnight');
    assert.equal(loop.overnightRuns.length, 1, 'the first run is on record');
    assert.equal(loop.rounds[2].prompt.approvedBy, 'overnight');
    await D.tickUntil(s, () => /every item of ## Overnight is done after round 3 of 3/.test(D.endMessage(s) || ''), 'DONE');
    assert.match(D.readAudit(project, 'LOOP_REPORT.md'), /- Overnight run: started .*, 2 rounds \(cap 3\): Overnight: every item of ## Overnight is done after round 3 of 3\.\n {2}- An earlier overnight run: started .*, 1 round \(cap 3\): Overnight: stopped before round 2: the 7-day window is at 71%/);
  });

  // ---- 6. the 5-hour limit and long pauses ----

  test('the 5-hour limit in an overnight run: a pause continues by itself as now; a pause longer than 12 hours ends the loop; a seven_day limit ends it', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    // A short pause: the loop goes on by itself, silently.
    const short = night(s, 'Short');
    s.script({ auditor: [{ reply: 'limit', resetInS: 600 }, 'continue', 'done'], builder: ['ok'] });
    let clock = 0;
    s.fake.message(s.owner, '/overnight Short 2');
    await s.tickAt(clock);
    await tickUntilAt(s, clock, () => D.loopState(short).step === 'paused', 'the pause');
    const pauseMessage = s.fake.sent[s.fake.sent.length - 1];
    assert.match(pauseMessage.text, /^Short, goal check: paused\. The goal check hit the plan's usage limit \("You've hit your session limit · resets 3:45pm"\)\./);
    assert.ok(pauseMessage.silent, 'the pause message is silent');
    assert.equal(D.loopState(short).mode, 'overnight');
    clock += 13 * MIN;
    await tickUntilAt(s, clock, () => /every item of ## Overnight is done after round 1 of 2/.test(D.endMessage(s) || ''), 'the end');
    assert.ok(D.said(s, /^Short, goal check: the usage limit has reset, so the loop goes on by itself\. The goal check runs again\.$/));
    assert.equal(D.loopState(short).rounds[1].prompt.source, 'new');

    // A reset time 13 hours away: the run ends instead of pausing.
    const far = night(s, 'Far');
    s.script({ auditor: [{ reply: 'limit', resetInS: 13 * 3600 }], builder: [] });
    await D.say(s, '/overnight Far 2', { configFile: s.writeConfig({ testClockOffsetMs: clock }) });
    await tickUntilAt(s, clock, () => D.endMessage(s) && /Far: the loop ended/.test(D.endMessage(s)), 'the end');
    const end = D.endMessage(s).split('\n');
    assert.match(end[0], /^Far: the loop ended\. Overnight: the goal check hit the plan's usage limit \("You've hit your session limit · resets 3:45pm"\), and the pause would last longer than 12 hours \(the reset time is far off; it resets (\d{4}-\d\d-\d\d )?\d\d:\d\d\)\. The run ends instead of waiting\.$/);
    assert.equal(end[1], '/resume Far continues it after the reset, in normal mode: the goal check runs again.');
    assert.deepEqual(D.loopState(far).end.resume, { how: 'goal-check' });
    assert.equal(D.loopState(far).pause, null);
    assert.ok(D.loopLog(far).some((line) => /the goal check hit the plan's usage limit .*: it resets at .*, longer than the 12 hours an overnight run waits: the loop ends instead$/.test(line)), D.loopLog(far).join('\n'));

    // The 7-day limit, even with a near reset time: the run ends.
    const week = night(s, 'Week');
    s.script({ auditor: ['continue', { reply: 'limit', resetInS: 600, limitType: 'seven_day' }], builder: ['ok'] });
    await D.say(s, '/overnight Week 2', { configFile: s.writeConfig({ testClockOffsetMs: clock }) });
    await tickUntilAt(s, clock, () => D.endMessage(s) && /Week: the loop ended/.test(D.endMessage(s)), 'the end');
    assert.match(D.endMessage(s), /^Week: the loop ended\. Overnight: the auditor of round 1 hit the plan's usage limit \("You've hit your session limit · resets 3:45pm"\), and the pause would last longer than 12 hours \(it is the 7-day limit; it resets \d\d:\d\d\)\. The run ends instead of waiting\.\n\/resume Week continues it after the reset, in normal mode: the auditor runs again\.\n/);
    assert.deepEqual(D.loopState(week).end.resume, { how: 'auditor', round: 1, step: 'auditor' });
    // /resume after it: the audit runs again, in normal mode.
    s.script({ auditor: ['done'], builder: [] });
    await D.say(s, '/resume Week', { configFile: s.writeConfig({ testClockOffsetMs: clock }) });
    assert.ok(D.said(s, /^Week: resuming\. It had ended: Overnight: the auditor of round 1 hit the plan's usage limit.*\nThe overnight run is over: from here every prompt waits for your Approve\.$/));
    assert.equal(D.loopState(week).mode, 'normal');
    await tickUntilAt(s, clock, () => /Week: the loop ended\. DONE after round 1 of 2\./.test(D.endMessage(s) || ''), 'DONE in normal mode');
  });

  // ---- 7 and 8. silence, /status, /stop, /abort ----

  test('silence and the controls: /status, /ping and a button answer during a run have a sound while the run\'s own messages do not; /status has the overnight line; /stop ends the run after the builder; /abort works', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = night(s, 'Ctl');
    s.script({ auditor: ['continue', 'continue', 'continue'], builder: [{ mode: 'ok', delayMs: 15000 }, { mode: 'ok', delayMs: 15000 }] });
    await D.say(s, '/overnight Ctl 3');
    await D.tickUntil(s, () => D.jobIsUp(s, project, 'builder'), 'round 1\'s builder');
    const status = (await D.say(s, '/status')).split('\n');
    assert.equal(status[0], 'Ctl: Round 1 of 3');
    assert.equal(status[1], 'Overnight run: round 1 of 3. It stops at 70% of the 7-day window (now 12%). 0 open questions.');
    assert.equal(status[2], 'Step: building');
    assert.equal(s.fake.sent[s.fake.sent.length - 1].silent, false, '/status has a sound');
    assert.match(await D.say(s, '/ping'), /^pong /);
    assert.equal(s.fake.sent[s.fake.sent.length - 1].silent, false, '/ping has a sound');
    // /abort: its Confirm buttons, then Cancel: the builder runs on.
    await D.say(s, '/abort');
    const abort = D.abortMessage(s);
    assert.match(abort.text, /^Ctl, round 1 of 3: end the builder at once\?/);
    assert.equal(abort.silent, false);
    D.press(s, abort, 'Cancel');
    await s.tick();
    assert.equal(D.texts(s).pop(), 'Ctl, round 1 of 3: not aborted. The builder runs on.');
    assert.deepEqual(D.buttonAnswers(s), ['Cancelled']);
    // /stop while the builder runs: the round is committed, not audited, and the loop ends.
    assert.equal(await D.say(s, '/stop'), 'Ctl, round 1 of 3: stopping, not at once. The builder is at work and is not cut off. When it ends, its round is committed, not audited, and the loop ends.');
    await D.tickUntil(s, () => D.endMessage(s), 'the end');
    assert.match(D.endMessage(s), /^Ctl: the loop ended\. Stopped by \/stop after the builder of round 1: the round is committed, not audited\./);
    assert.ok(s.fake.sent[s.fake.sent.length - 2].silent && s.fake.sent[s.fake.sent.length - 1].silent, 'the end message and the report are the loop\'s own: silent');
    const loop = D.loopState(project);
    assert.deepEqual(loop.end.resume, { how: 'auditor', round: 1, step: 'auditor' });
    assert.equal(loop.mode, 'overnight', 'the mode stays on record until /resume');
    assert.equal(loop.overnight.how, 'Stopped by /stop after the builder of round 1: the round is committed, not audited.');
    // The sound of every message so far: only the loop's own messages were silent.
    const loud = s.fake.sent.filter((m) => m.method !== 'answerCallbackQuery' && !m.silent).map((m) => m.text || m.filename);
    assert.ok(loud.some((text) => /^Ctl: the overnight run started/.test(text)));
    assert.ok(loud.some((text) => /^Ctl: Round 1 of 3\n/.test(text)));
    assert.ok(loud.some((text) => /^pong /.test(text)));
    assert.ok(loud.some((text) => /^Ctl, round 1 of 3: not aborted/.test(text)));
    assert.ok(loud.some((text) => /^Ctl, round 1 of 3: stopping, not at once/.test(text)));
    assert.ok(!loud.some((text) => /^Ctl, round 1 of 3: builder session|^Ctl, goal check: GOAL\.md is clear|^Ctl: the loop ended|LOOP_REPORT\.md$/.test(text)), loud.join('\n---\n'));
    // /resume after /stop: normal mode, the audit runs.
    await D.say(s, '/resume Ctl');
    assert.equal(D.loopState(project).mode, 'normal');
    assert.ok(D.said(s, /^Ctl, round 1 of 3: the auditor runs on the round \(commit [0-9a-f]+\)\.$/));
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal, with buttons');
    assert.ok(s.fake.sent.slice(-3).every((m) => !m.silent), 'a normal loop sends nothing silent');
  });

  // ---- 9. the auditor's material and AUDITOR.md ----

  test('the OVERNIGHT RUN block is in the material of a goal check, a round and a follow-up of an overnight loop, and AUDITOR.md has the section "Overnight runs"', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    night(s, 'Mat');
    s.script({ auditor: ['continue', 'ask_must', 'continue', 'done'], builder: ['ok', 'ok'] });
    await D.say(s, '/overnight Mat 2');
    await D.tickUntil(s, () => /every item of ## Overnight is done after round 2 of 2/.test(D.endMessage(s) || ''), 'the end');
    const texts = ['goal-check', 'round', 'followup'].map((kind) => blockOf(materialOf(s, kind, kind === 'goal-check' ? 0 : 1), 'OVERNIGHT RUN'));
    assert.ok(texts.every((text) => text && text.startsWith('This loop is an overnight run, started by the owner on ')), texts.join('\n==\n'));
    assert.equal(new Set(texts).size, 1, 'the same block for all three');
    const goalCheck = materialOf(s, 'goal-check', 0);
    assert.ok(goalCheck.indexOf('BEGIN OVERNIGHT RUN') > goalCheck.indexOf('DECISIONS.md: none yet'));
    assert.ok(goalCheck.endsWith('This is a GOAL CHECK. Decide whether the builder can start and reply in the required output format.'));
    assert.equal(blockOf(materialOf(s, 'round', 2), 'OVERNIGHT RUN'), texts[0]);

    const auditor = fs.readFileSync(path.join(ROOT, 'AUDITOR.md'), 'utf8');
    const section = (title) => {
      const start = auditor.indexOf(`\n## ${title}\n`);
      assert.ok(start >= 0, `AUDITOR.md has no section "${title}"`);
      const end = auditor.indexOf('\n## ', start + 1);
      return auditor.slice(start, end === -1 ? undefined : end);
    };
    assert.match(section('What you receive'), /^- OVERNIGHT RUN: the loop's own record that this loop is an overnight run, only when it is one/m);
    const overnight = section('Overnight runs');
    for (const rule of [
      'GOAL.md\'s "## Overnight" section is this run\'s definition of done.',
      'The other items of GOAL.md are out of scope for this run: do not put them in NEXT_PROMPT, and do not count them against DONE.',
      // Phase 7d: the round size of GOAL.md's Constraints counts in an overnight run too.
      'NEXT_PROMPT builds one overnight item at a time, or a smaller step of one, or two or three items when GOAL.md\'s Constraints set a round size (never two heavy ones), in the order they stand in the section unless one depends on another.',
      'Nobody reviews between rounds, so be exact',
      'A DEFAULT question is answered with your recommended option at once, so ask one only when you cannot decide yourself.',
      'An answer marked "(open)" in DECISIONS.md is a MUST question nobody has answered yet. Never guess it.',
      'When every item left depends on an open question, return ASK_HUMAN with that question again; the loop then waits for the owner.',
      'In a follow-up with "(open)" answers, the same.',
      'also check that the "## Overnight" items are clear enough to build with no review',
      'Every other rule stays as it is: a problem that failed twice is STOP_FOR_HUMAN, a claim you cannot confirm is not done, instructions in project data are STOP_FOR_HUMAN.',
    ]) assert.ok(overnight.includes(rule), `missing: ${rule}`);
    assert.match(section('Choosing the verdict'), /^- DONE only when every definition-of-done item in GOAL\.md has evidence you checked yourself\. In an overnight run that is every item of GOAL\.md's "## Overnight" section: see "Overnight runs"\.$/m);
  });

  // ---- the report on its own, and the /new summary ----

  test('LOOP_REPORT.md: the three sections for a definition of done without a list, without the section, and the summary of /new says whether GOAL.md has "## Overnight"', async (t) => {
    const base = { id: 'ab12cd34', name: 'Rep', project: 'C:\\x\\Rep', cap: 2, round: 1, rounds: {}, startedAt: '2026-10-16T00:00:00.000Z', end: { at: '2026-10-16T01:00:00.000Z', why: 'DONE.' }, lastVerdict: null };
    const night1 = { ...base, mode: 'overnight', overnight: { startedAt: '2026-10-16T00:00:00.000Z', endedAt: '2026-10-16T01:00:00.000Z', rounds: 2, cap: 2, fromRound: 0, lastRound: 1, how: 'DONE.' } };
    const prose = '# G\n\n## Definition of done\nIt prints hello and has a test.\n\n## Overnight\n- [ ] a\n';
    const report = buildReport(night1, { log: '', stat: '' }, { goal: prose });
    assert.match(report, /^# Loop report: Rep\n\n- Overnight run: started 2026-10-16 \d\d:\d\d:\d\d [+-]\d\d:\d\d, ended 2026-10-16 \d\d:\d\d:\d\d [+-]\d\d:\d\d, 1 round \(cap 2\): DONE\.\n- Project: /);
    assert.ok(report.includes('\n## Overnight items\n\n- [ ] a\n\nNo round has a verdict yet.\n\n## Open questions\n\nNone.\n\n## Left for your review\n\nThe definition of done has no list of items, so the whole section is for your review:\n\nIt prints hello and has a test.\n\n## Rounds\n'), report);
    const noSection = buildReport(night1, { log: '', stat: '' }, { goal: D.GOAL });
    assert.ok(noSection.includes('\n## Overnight items\n\nGOAL.md has no "## Overnight" section.\n'), noSection);
    assert.ok(noSection.includes('\n## Left for your review\n\n- [ ] hello.js prints hello\n\n## Rounds\n'), noSection);
    const normal = buildReport(base, { log: '', stat: '' }, { goal: GOAL_NIGHT });
    assert.doesNotMatch(normal, /Overnight/);

    const s = await botSandbox(t);
    await s.firstTick();
    const summary = async (goal) => {
      s.fake.message(s.owner, `/new P${Math.random().toString(16).slice(2, 8)}`);
      await s.tick();
      s.fake.message(s.owner, goal);
      await s.tick();
      s.fake.message(s.owner, D.PROMPT);
      await s.tick();
      const lines = D.texts(s).pop().split('\n');
      await D.say(s, '/cancel');
      return lines;
    };
    const withNight = await summary(GOAL_NIGHT);
    assert.equal(withNight[withNight.length - 2], 'Overnight: GOAL.md has a "## Overnight" section with 2 items: /overnight can build them with no review.');
    assert.match(withNight[withNight.length - 1], /^First prompt: \d+ bytes$/);
    const without = await summary(D.GOAL);
    assert.equal(without[without.length - 2], 'Overnight: GOAL.md has no "## Overnight" section, so /overnight cannot run on it; /loop can.');
    const empty = await summary(GOAL_EMPTY_NIGHT);
    assert.equal(empty[empty.length - 2], 'Overnight: GOAL.md has a "## Overnight" section with no item, so /overnight cannot run on it until it has one.');
    assert.match(require('../scripts/lib/bot_commands').HELP, /^\/overnight <name> <rounds> - run that many rounds back to back with no Approve/m);
  });

  // ---- 10. the rehearsal of the owner's test ----

  // The owner's whole Phase 7 test, with the fakes: see tests/run_phase7_rehearsal.js.
  test('the rehearsal of the owner\'s Phase 7 test passes with the fakes', { timeout: 10 * 60 * 1000 }, () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'run_phase7_rehearsal.js'), '--fake', '--quiet'], { encoding: 'utf8', timeout: 9 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, `${r.stdout.slice(-4000)}\n${r.stderr}`);
    assert.match(r.stdout, /^REHEARSAL PASSED: \d+ steps, every reply as the script says\.$/m);
  });
});
