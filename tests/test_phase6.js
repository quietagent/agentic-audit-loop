'use strict';

// Tests what Phase 6 added: the loop's record of who wrote a round's prompt, as the
// auditor gets it (PROMPT RECORD and ROUND PROMPT), the usage in /status when no loop
// runs, the refused /loop and /resume in bot.log, the clean environment of /new's git,
// and the rehearsal of the owner's re-test. The material of run_auditor.js on its own
// (no record, a secret in a note, a project file that pretends to be a record) and
// AUDITOR.md's new rules are tested in tests/test_run_auditor.js.
// Like tests/test_controls.js: real ticks against a fake Telegram server and a fake
// claude. No real Claude call, no real Telegram call, and nothing outside tests/tmp/.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { botSandbox, N8N_ENV_NAMES } = require('./helpers/bot_sandbox');
const D = require('./helpers/loop_driver');

const HOUR = 60 * 60 * 1000;
const BOT_LINE = 'The loop\'s Telegram bot answers only the owner\'s chat: nobody else can send it a prompt, a note or a file.';
const PREFACE_LINE = 'In front of the ROUND PROMPT the builder got the loop\'s fixed rules for every builder session (templates/BUILDER_PREFACE.md) '
  + 'and, when there are any, the owner\'s answers from DECISIONS.md.';
const WHERE = 'at the top of the ROUND PROMPT, under the heading "## Note from the owner (it takes priority over the rest of this prompt)"';
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The text of a block of the auditor's material, by the start of its name, or null.
// A block is closed by the same tag that opened it.
function blockOf(material, name) {
  const n = escape(name);
  const m = new RegExp(`^----- BEGIN ${n}[^\\n]* \\[([0-9a-f]{12})\\] -----\\n([\\s\\S]*?)\\n----- END ${n}[^\\n]* \\[\\1\\] -----$`, 'm').exec(material);
  return m ? m[2] : null;
}

// The material of an audit of the fake claude: audit is 'round' or 'followup'.
function materialOf(s, audit, round) {
  const call = s.calls().filter((c) => c.kind === 'auditor' && c.audit === audit && c.round === round).pop();
  assert.ok(call, `no ${audit} audit of round ${round} was made`);
  return call.stdin;
}

// The PROMPT RECORD and ROUND PROMPT of an audit, checked against what the loop wrote.
function checkRecord(s, project, audit, round, lines) {
  const material = materialOf(s, audit, round);
  assert.deepEqual(blockOf(material, 'PROMPT RECORD').split('\n'), [...lines, BOT_LINE], `the PROMPT RECORD of the ${audit} of round ${round}`);
  assert.equal(blockOf(material, 'ROUND PROMPT'), D.readAudit(project, `round-0${round}-prompt.md`).replace(/\s+$/, ''), 'the ROUND PROMPT is the round\'s prompt file');
  assert.ok(material.includes(`\n${PREFACE_LINE}\n----- BEGIN ROUND PROMPT (exactly what the builder got this round, from .audit/round-0${round}-prompt.md) [`));
  // In the material's order: the loop's records, then the builder's report.
  assert.ok(material.indexOf('BEGIN PROMPT RECORD') < material.indexOf('BEGIN ROUND PROMPT'));
  assert.ok(material.indexOf('BEGIN ROUND PROMPT') < material.indexOf('BEGIN HANDOFF.md'));
  assert.equal(material.split('BEGIN PROMPT RECORD').length, 2, 'one record, no more');
  return material;
}

// Sends a file, as the owner sends one from Telegram, and runs the tick that handles it.
async function sendFile(s, name, text) {
  s.fake.document(s.owner, name, text);
  const r = await s.tick();
  assert.equal(r.status, 0, r.stderr);
}

// "+0900" for 540 minutes east of UTC.
const offsetText = (minutes) => `${minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}${String(Math.abs(minutes) % 60).padStart(2, '0')}`;

describe('Phase 6', { concurrency: 4 }, () => {
  // ---- 1. the record of who wrote a round's prompt ----

  test('PROMPT RECORD and ROUND PROMPT: round 1\'s /new prompt, the auditor\'s prompt with two notes, its follow-up, and a prompt proposed again after /resume', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Records');
    s.script({ auditor: ['continue', 'continue', 'ask', 'continue', 'stop'], builder: ['ok', 'ok', 'ok'] });
    await D.startLoop(s, 'Records');
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal for round 2');

    // Round 1: the owner's prompt from /new, kept when the loop started round 1.
    checkRecord(s, project, 'round', 1, ['Written by: the owner, as the first prompt sent with /new', 'Owner edits: 0', 'Owner notes: none']);
    assert.equal(blockOf(materialOf(s, 'round', 1), 'ROUND PROMPT'), D.PROMPT.trim());
    const first = D.loopState(project).rounds[1].prompt;
    assert.deepEqual({ ...first, startedAt: 'x' }, {
      startedAt: 'x', edits: 0, notes: 0, bytes: Buffer.byteLength(D.PROMPT), noteTexts: [], fromFile: false, source: 'new',
    });

    // Round 2: the auditor's prompt, with two notes of the owner.
    D.press(s, D.proposalMessage(s), 'Edit');
    s.fake.message(s.owner, 'NOTE_ONE keep it short');
    await s.tick();
    D.press(s, D.proposalMessage(s), 'Edit');
    s.fake.message(s.owner, 'NOTE_TWO\nwith a second line');
    await s.tick();
    D.press(s, D.proposalMessage(s), 'Approve');
    await D.tickUntil(s, () => D.questionMessage(s, 2), 'the questions of round 2');
    const twoNotes = [
      'Written by: you, as NEXT_PROMPT in the audit of round 1', 'Owner edits: 2',
      `Owner notes: 2, in the order they were added. They stand ${WHERE}.`, 'Note 1:', 'NOTE_ONE keep it short', 'Note 2:', 'NOTE_TWO', 'with a second line',
    ];
    checkRecord(s, project, 'round', 2, twoNotes);
    assert.match(blockOf(materialOf(s, 'round', 2), 'ROUND PROMPT'), /^## Note from the owner \(it takes priority over the rest of this prompt\)\n\nNote 1:\nNOTE_ONE keep it short\n\nNote 2:\nNOTE_TWO\nwith a second line\n\n## The prompt for this round\n\nAUDITOR_PROMPT_MARKER for round 2/);

    // Its follow-up gets the same record.
    D.press(s, D.questionMessage(s, 1), '1. hello');
    D.press(s, D.questionMessage(s, 2), '1. Yes');
    await D.tickUntil(s, () => /round 3 of 3: start the builder/.test((D.proposalMessage(s) || {}).text || ''), 'the proposal for round 3');
    assert.match(materialOf(s, 'followup', 2), /^AUDIT MATERIAL: FOLLOW-UP of round 2$/m);
    checkRecord(s, project, 'followup', 2, twoNotes);

    // Round 3: stopped at the proposal, and proposed again by /resume.
    D.press(s, D.proposalMessage(s), 'Stop');
    await s.tick();
    await D.say(s, '/resume Records');
    D.press(s, D.proposalMessage(s), 'Approve');
    await D.tickUntil(s, () => /STOP_FOR_HUMAN after round 3 of 3/.test(D.endMessage(s) || ''), 'the end of round 3');
    checkRecord(s, project, 'round', 3, ['Written by: you, as NEXT_PROMPT in the audit of round 2 (proposed again after /resume)', 'Owner edits: 0', 'Owner notes: none']);
    assert.equal(D.loopState(project).rounds[3].prompt.proposedAgain, true);
    assert.equal(D.loopState(project).rounds[2].prompt.proposedAgain, false);
  });

  test('PROMPT RECORD: the owner\'s own prompt as a message and as a file, and a file that replaced the proposed prompt in an Edit', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Owners');
    s.script({ auditor: ['continue', 'stop', 'stop', 'continue', 'done'], builder: ['ok', 'ok', 'ok', 'ok'] });
    await D.startLoop(s, 'Owners');
    await D.tickUntil(s, () => /STOP_FOR_HUMAN after round 1/.test(D.endMessage(s) || ''), 'the end of round 1');

    // Round 2: the owner's prompt as a text message.
    await D.say(s, '/resume Owners');
    await D.say(s, 'OWNER_TEXT_MARKER make hello.js print hello. Then write HANDOFF.md.');
    D.press(s, D.proposalMessage(s), 'Approve');
    await D.tickUntil(s, () => /STOP_FOR_HUMAN after round 2/.test(D.endMessage(s) || ''), 'the end of round 2');
    checkRecord(s, project, 'round', 2, ['Written by: the owner, as a message to the loop\'s Telegram bot', 'Owner edits: 0', 'Owner notes: none']);
    assert.equal(blockOf(materialOf(s, 'round', 2), 'ROUND PROMPT'), 'OWNER_TEXT_MARKER make hello.js print hello. Then write HANDOFF.md.');

    // Round 3: the owner's prompt as a file, with a note on top.
    await D.say(s, '/resume Owners');
    await sendFile(s, 'my-prompt.md', 'OWNER_FILE_MARKER add a test for hello.js. Then write HANDOFF.md.\n');
    D.press(s, D.proposalMessage(s), 'Edit');
    s.fake.message(s.owner, 'NOTE_ON_FILE use node:test');
    await s.tick();
    D.press(s, D.proposalMessage(s), 'Approve');
    await D.tickUntil(s, () => /round cap is reached: round 3 of 3/.test(D.endMessage(s) || ''), 'the end of round 3');
    checkRecord(s, project, 'round', 3, [
      'Written by: the owner, as a file sent to the loop\'s Telegram bot', 'Owner edits: 1', `Owner notes: 1. It stands ${WHERE}.`, 'Note 1:', 'NOTE_ON_FILE use node:test',
    ]);
    assert.match(D.readAudit(project, 'LOOP_REPORT.md'), /^- Round 3: the prompt was the owner's own, sent after \/resume as a file\.$/m);
    assert.match(D.readAudit(project, 'LOOP_REPORT.md'), /^- Round 2: the prompt was the owner's own, sent after \/resume\.$/m);

    // Round 4: the auditor's prompt, replaced by a file in an Edit.
    await D.say(s, '/resume Owners');
    D.press(s, D.proposalMessage(s), 'Edit');
    await s.tick();
    await sendFile(s, 'replacement.md', 'REPLACEMENT_MARKER do only this. Then write HANDOFF.md.');
    D.press(s, D.proposalMessage(s), 'Approve');
    await D.tickUntil(s, () => /DONE after round 4 of 4/.test(D.endMessage(s) || ''), 'the end of round 4');
    checkRecord(s, project, 'round', 4, [
      'Written by: the owner, as a file sent to the loop\'s Telegram bot (in an Edit, it replaced the prompt that was proposed)', 'Owner edits: 1', 'Owner notes: none',
    ]);
    assert.equal(blockOf(materialOf(s, 'round', 4), 'ROUND PROMPT'), 'REPLACEMENT_MARKER do only this. Then write HANDOFF.md.');
  });

  // ---- 2. /status with no loop: the last usage that a job reported ----

  test('/status with no loop running shows the last usage, from a goal check, a builder or an audit, and says when a window has reset since', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const status = async (offset = 0) => {
      s.fake.message(s.owner, '/status');
      const r = await s.tickAt(offset);
      assert.equal(r.status, 0, r.stderr);
      return D.texts(s).pop().split('\n');
    };
    // Nothing seen yet.
    assert.deepEqual(await status(), ['No loop is running.', 'Last loop: none on record.', 'Usage: not known yet: it comes with a Claude call.', 'Bot last offline: none on record.']);

    const project = D.newProject(s, 'Meter');
    const five = () => {
      const usage = s.state().lastUsage;
      return usage && usage.five_hour ? usage.five_hour.utilization : null;
    };
    // Each job runs long enough to be looked at, also on a PC that is busy with other things.
    s.script({
      auditor: [{ reply: 'continue', fiveHour: 0.41, sevenDay: 0.15 }, { reply: 'continue', fiveHour: 0.55, sevenDay: 0.18, delayMs: 8000 }],
      builder: [{ mode: 'ok', delayMs: 10000 }],
    });
    await D.startLoop(s, 'Meter');
    await D.tickUntil(s, () => D.loopState(project).step === 'builder', 'the builder');
    assert.equal(five(), 0.41, 'kept from the goal check');
    await D.tickUntil(s, () => D.loopState(project).step === 'auditor', 'the audit');
    assert.equal(five(), 0.21, 'kept from the builder');
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal');
    assert.equal(five(), 0.55, 'kept from the audit');
    const kept = s.state().lastUsage;
    assert.equal(kept.seven_day.utilization, 0.18);
    assert.match(kept.seen_at, /^\d{4}-\d\d-\d\dT/);

    // During a loop /status is as it was. (A time shows its date when it is not today.)
    const when = '(?:\\d{4}-\\d\\d-\\d\\d )?\\d\\d:\\d\\d';
    const during = await status();
    assert.match(during.find((line) => line.startsWith('Usage:')), new RegExp(`^Usage: 5-hour window 55% used, resets ${when}; 7-day window 18% used, resets \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d \\(as of ${when}\\)$`));

    // The loop ends: /status shows the usage after the "Last loop" line, as of when it was seen.
    D.press(s, D.proposalMessage(s), 'Stop');
    await s.tick();
    const lines = await status();
    assert.equal(lines[0], 'No loop is running.');
    assert.match(lines[1], new RegExp(`^Last loop: Meter, ended ${when}: Stopped by you at the prompt for round 2\\. /resume Meter continues it\\.$`));
    assert.match(lines[2], new RegExp(`^Usage \\(as of ${when}\\): 5-hour window 55% used, resets ${when}; 7-day window 18% used, resets \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d$`));
    assert.equal(lines[3], 'Bot last offline: none on record.');

    // Two hours later the 5-hour window has reset: its old share is not shown.
    const later = await status(2 * HOUR);
    assert.match(later[2], new RegExp(`^Usage \\(as of ${when}\\): 5-hour window has reset since \\(at ${when}\\); 7-day window 18% used, resets \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d$`));
  });

  // ---- 3. refused commands in bot.log ----

  test('a refused /loop (git not clean, a loop already running) and a refused /resume each write one line to bot.log', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const dirty = D.newProject(s, 'Dirty');
    fs.writeFileSync(path.join(dirty, 'notes.txt'), 'x\n');
    const logged = (text) => s.logTexts().filter((line) => line === text).length;

    const notClean = '/loop was refused: Dirty: its working tree is not clean. Commit or remove these first (git status --porcelain):\n?? notes.txt';
    assert.equal(await D.say(s, '/loop Dirty'), notClean, 'the message to the owner is as it was');
    assert.equal(logged(notClean.replace('\n', ' | ')), 1);

    const noLoop = '/resume was refused: Dirty has no loop to continue (.audit\\loop.json is not there). Start one with /loop Dirty.';
    assert.equal(await D.say(s, '/resume Dirty'), noLoop);
    assert.equal(logged(noLoop), 1);

    D.newProject(s, 'Busy');
    s.script({ auditor: [{ reply: 'continue', delayMs: 15000 }], builder: [] });
    await D.startLoop(s, 'Busy');
    const busy = await D.say(s, '/loop Dirty');
    assert.match(busy, /^\/loop was refused: a loop is already running: Busy, goal check \(goal check running since \d\d:\d\d:\d\d\)\. One loop at a time; \/stop ends it\.$/);
    assert.equal(logged(busy), 1);
    const other = await D.say(s, '/resume Dirty');
    assert.match(other, /^\/resume was refused: another loop is running: Busy, goal check/);
    assert.equal(logged(other), 1);
    assert.equal(s.logTexts().filter((line) => / was refused: /.test(line)).length, 4, 'one line per refusal, no more');

    await D.say(s, '/stop');
    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
  });

  // ---- 4. /new's git gets the clean environment ----

  test('/new with TZ in the bot\'s environment: its git runs without TZ, so the first commit has the PC\'s own UTC offset', async (t) => {
    assert.ok(N8N_ENV_NAMES.includes('TZ'), 'the sandbox\'s n8n env file names TZ, as n8n-loop\\.env does');
    const local = offsetText(-new Date().getTimezoneOffset());
    const hours = local === '+0700' ? 5 : 7;
    const tz = `XYZ-${hours}`;
    const zoned = `+0${hours}00`;

    // The trap works: this git reads TZ when it gets it.
    const control = path.join(__dirname, 'tmp', 'unit', `tz-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(control, { recursive: true });
    t.after(() => fs.rmSync(control, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    const run = (args, env = process.env) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: control, env, encoding: 'utf8' });
    run(['init', '-q']);
    run(['commit', '-q', '--allow-empty', '-m', 'with TZ'], { ...process.env, TZ: tz });
    const seen = run(['log', '-1', '--format=%ai']).stdout.trim().slice(-5);
    if (seen !== zoned) {
      t.skip(`this git does not read TZ=${tz} (it wrote ${seen}), so there is nothing to prove here`);
      return;
    }

    const s = await botSandbox(t);
    await s.firstTick();
    const tick = () => s.tick({ extraEnv: { TZ: tz } });
    s.fake.message(s.owner, '/new Zoned');
    await tick();
    s.fake.message(s.owner, D.GOAL);
    await tick();
    s.fake.message(s.owner, D.PROMPT);
    await tick();
    D.press(s, D.lastKeyboard(s), 'Save');
    await tick();
    assert.match(D.texts(s).pop(), /^Created .*Zoned\nCommit [0-9a-f]+ "Loop: GOAL\.md"/);
    const folder = path.join(s.projectsRoot, 'Zoned');
    const date = spawnSync('git', ['log', '-1', '--format=%ai'], { cwd: folder, encoding: 'utf8' }).stdout.trim();
    assert.equal(date.slice(-5), local, `the first commit says ${date}: git got TZ=${tz}`);
  });

  // ---- 5. the rehearsal of the owner's re-test ----

  // The owner's whole re-test, with the fakes: see tests/run_phase6_rehearsal.js.
  test('the rehearsal of the owner\'s Phase 6 re-test passes with the fakes', { timeout: 10 * 60 * 1000 }, () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'run_phase6_rehearsal.js'), '--fake', '--quiet'], { encoding: 'utf8', timeout: 9 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, `${r.stdout.slice(-4000)}\n${r.stderr}`);
    assert.match(r.stdout, /^REHEARSAL PASSED: \d+ steps, every reply as the script says\.$/m);
  });
});
