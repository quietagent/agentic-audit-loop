'use strict';

// Tests the loop end to end: /loop and its pre-flight check, the goal check, builder
// rounds, the commit, the auditor's four verdicts, the owner's Approve / Edit / Stop,
// questions and DECISIONS.md, /stop, the round cap, and damaged state files.
// Each test runs real ticks (`node scripts/bot.js tick`) against a fake Telegram
// server, with one fake claude for the builder and the auditor
// (tests/helpers/fake_claude_loop.js). The auditor's replies go through the real
// run_auditor.js. No real Claude call, no real Telegram call; every project is
// created under tests/tmp/.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { botSandbox, filesUnder, DEFAULT_CONFIG, ROOT } = require('./helpers/bot_sandbox');
const D = require('./helpers/loop_driver');
const { renderPreface, decisionsPart } = require('../scripts/lib/builder_input');
const { localStamp } = require('../scripts/lib/runtime');
const { looksLikeSecret, commitRound } = require('../scripts/lib/loop_git');
const { createProject } = require('../scripts/lib/projects');
const { setEnvValue } = require('../scripts/lib/project_env');

const PREFACE = renderPreface(DEFAULT_CONFIG.builderAllowedTools);
// The preface of a round whose input also holds the owner's decisions.
const PREFACE_WITH_DECISIONS = renderPreface(DEFAULT_CONFIG.builderAllowedTools, undefined, { withDecisions: true });
const DECISIONS_HEAD = fs.readFileSync(path.join(ROOT, 'templates', 'DECISIONS.template.md'), 'utf8').split(/^## /m)[0].replace(/\s+$/, '');
const NOTE_HEADING = '## Note from the owner (it takes priority over the rest of this prompt)';
const PROMPT_HEADING = '## The prompt for this round';
const records = (project) => `Records: ${path.join(project, '.audit')} (loop.log, loop.json and the round-NN-* files)`;
const proposed = (project, round = 2) => D.readAudit(project, `round-0${round}-prompt-proposed.md`);
const callsOf = (s) => s.calls().map((call) => (call.kind === 'builder' ? `builder:${call.mode}` : `auditor:${call.audit}:${call.round}:${call.reply}`));

// The tests are independent (each has its own sandbox), so a few run side by side.
describe('the loop', { concurrency: 4 }, () => {
  test('the full flow: the goal check asks, answers by button, DECISIONS.md, round 1, Approve, round 2, DONE', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Full');
    s.script({ auditor: ['ask', 'continue', 'continue', 'done'], builder: ['ok', 'ok'] });

    const started = await D.startLoop(s, 'full');
    assert.equal(started.status, 0, started.stderr);
    assert.ok(started.ms < 10000, `the tick that started the loop took ${started.ms} ms`);
    assert.equal(D.texts(s).pop(), 'Full: the loop started, with at most 3 rounds. First the auditor checks GOAL.md (goal check 1).\n/stop ends the loop.');
    assert.equal(s.state().loop.name, 'Full');
    assert.equal(s.state().loop.project, project);

    // The goal check asks two questions: one message each, with one button per option.
    await D.tickUntil(s, () => D.questionMessage(s, 2), 'the questions');
    assert.ok(D.said(s, /^Full, goal check: the auditor has 2 questions before the builder can start\.\nReason: GOAL\.md leaves the greeting to the owner\.$/));
    const q1 = D.questionMessage(s, 1);
    assert.equal(q1.text, [
      'Full, goal check: Question 1 of 2 [MUST]',
      'Which greeting should hello.js print?',
      '',
      '1. hello (recommended)',
      '2. hello, world',
      '3. A greeting that is long enough to be cut off on a button, so that the list in the message matters',
    ].join('\n'));
    assert.deepEqual(q1.replyMarkup.inline_keyboard.map((row) => row.map((b) => b.text)), [
      ['1. hello (recommended)'],
      ['2. hello, world'],
      ['3. A greeting that is long enough to be cut off on a butt...'],
      ['Other (type it)'],
    ]);
    const q2 = D.questionMessage(s, 2);
    assert.equal(q2.text, 'Full, goal check: Question 2 of 2 [DEFAULT]\nShould the output end with a line break?\n\n1. Yes (recommended)\n2. No');
    for (const b of [...q1.replyMarkup.inline_keyboard, ...q2.replyMarkup.inline_keyboard].flat()) {
      assert.ok(Buffer.byteLength(b.callback_data) <= 64, `${b.callback_data} is too long for Telegram`);
      assert.match(b.callback_data, /^lq:[0-9a-f]{8}:[0-9a-f]{6}:[0-3o]$/);
    }
    assert.equal(fs.existsSync(D.audit(project, 'DECISIONS.md')), false, 'nothing is written before every question is answered');
    assert.equal(D.loopState(project).step, 'questions');

    D.press(s, q1, '2. hello, world');
    await s.tick();
    assert.equal(D.texts(s).pop(), 'Full, goal check: answer 1 of 2 saved: hello, world\n1 question still open.');
    assert.equal(D.buttonAnswers(s).pop(), 'Saved');
    D.press(s, q2, '1. Yes');
    await s.tick();
    // Every answer is confirmed; then one line: saved, asking the auditor again.
    assert.deepEqual(D.texts(s).slice(-2), [
      'Full, goal check: answer 2 of 2 saved: Yes',
      'Full, goal check: 2 answers saved in .audit\\DECISIONS.md. Asking the auditor again (goal check 2).',
    ]);
    const decisions = D.readAudit(project, 'DECISIONS.md');
    assert.equal(decisions, [
      DECISIONS_HEAD,
      '',
      `## Goal check, ${localStamp().slice(0, 10)}`,
      '- Q: Which greeting should hello.js print?',
      '  A: hello, world (answered)',
      '- Q: Should the output end with a line break?',
      '  A: Yes (answered)',
      '',
    ].join('\n'));

    // Goal check 2 says CONTINUE: round 1 starts without an Approve, with the decisions in its input.
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal for round 2');
    assert.ok(D.said(s, /^Full, round 1 of 3: GOAL\.md is clear\. The builder started with your first prompt \(\.audit\\round-01-prompt\.md\)\.$/));
    assert.match(s.calls()[1].stdin, /BEGIN DECISIONS\.md[\s\S]*A: hello, world \(answered\)/, 'the second goal check saw the answers');
    // The owner's answers are between the preface and the prompt, without the file's own head.
    const input1 = D.readAudit(project, 'round-01-builder-input.md');
    const answers = decisionsPart(decisions);
    assert.match(answers, /^## The owner's decisions \(from `\.audit\/DECISIONS\.md`, a file you cannot open\)\n\n[^\n]+\n\n### Goal check, \d{4}-\d\d-\d\d\n- Q: Which greeting should hello\.js print\?\n {2}A: hello, world \(answered\)\n- Q: Should the output end with a line break\?\n {2}A: Yes \(answered\)\n\n---\n\n$/);
    assert.equal(input1, `${PREFACE_WITH_DECISIONS}${answers}${D.PROMPT}`);
    assert.equal(s.calls().find((call) => call.kind === 'builder').stdin, input1);
    assert.equal(D.readAudit(project, 'round-01-prompt.md'), D.PROMPT, 'the round\'s prompt file stays as it is');

    // The loop committed the round before the auditor ran: one commit, without .audit/.
    assert.deepEqual(D.git(project, 'log', '--format=%s').split('\n'), ['Loop: round 1', 'Loop: GOAL.md']);
    assert.deepEqual(D.git(project, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['HANDOFF.md', 'hello.js', 'work.log']);
    const commit1 = D.git(project, 'rev-parse', '--short', 'HEAD');
    assert.ok(D.said(s, new RegExp(`^Full, round 1 of 3: the builder ended \\(completed, 3 turns, \\$0\\.0123, context peak 5%, not compacted, 0 denied calls\\)\\. Committed as ${commit1}\\. The auditor is checking the round\\.$`)));

    // The round message, then the proposal as a file, then the buttons.
    assert.equal(D.lastText(s, /^Full, round 1 of 3: audited\./), [
      'Full, round 1 of 3: audited.',
      'Verdict: CONTINUE',
      'Reason: Round 1 did part of the work.',
      'Findings:',
      '- hello.js: there is no test yet',
      '- HANDOFF.md: the output of node hello.js is not shown',
      'Builder: completed, 3 turns, $0.0123, context peak 5%, not compacted, 0 denied calls',
      `Session: ${D.SESSION}`,
      `To take it over on the PC, run this in ${project}:`,
      `claude --resume ${D.SESSION}`,
      `Commit: ${commit1} "Loop: round 1"`,
      'Next: the auditor\'s prompt for round 2 follows as a file. Approve starts round 2 with it, Edit changes it, Stop ends the loop.',
    ].join('\n'));
    const file = D.documents(s).pop();
    assert.equal(file.filename, 'Full-round-02-prompt.md');
    assert.equal(file.caption, 'Full: the proposed prompt for round 2');
    assert.equal(file.content, proposed(project));
    assert.match(file.content, /^AUDITOR_PROMPT_MARKER for round 2\n/);
    const proposal = D.proposalMessage(s);
    assert.equal(proposal.text, 'Full, round 2 of 3: start the builder with this prompt?');
    assert.deepEqual(proposal.replyMarkup.inline_keyboard.map((row) => row.map((b) => b.text)), [['Approve', 'Edit', 'Stop']]);
    for (const b of proposal.replyMarkup.inline_keyboard[0]) assert.match(b.callback_data, /^lp:[0-9a-f]{8}:[0-9a-f]{6}:[aes]$/);
    const order = s.fake.sent.slice(-3).map((m) => m.method);
    assert.deepEqual(order, ['sendMessage', 'sendDocument', 'sendMessage'], 'the message, then the file, then the buttons');

    // Every next prompt waits for Approve.
    await s.tick();
    await s.tick();
    assert.equal(fs.existsSync(D.audit(project, 'round-02-prompt.md')), false);
    assert.equal(s.calls().filter((call) => call.kind === 'builder').length, 1);
    assert.equal(D.loopState(project).step, 'proposal');

    D.press(s, proposal, 'Approve');
    await s.tick();
    assert.equal(D.texts(s).pop(), 'Full, round 2 of 3: approved. The builder started with .audit\\round-02-prompt.md.');
    assert.equal(D.buttonAnswers(s).pop(), 'Approved');
    assert.equal(D.readAudit(project, 'round-02-prompt.md'), file.content);

    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
    // Round 2's builder gets the owner's decisions too: every round does. The prompt
    // file, and the file the bot sent, are the auditor's own text, without them.
    const input2 = D.readAudit(project, 'round-02-builder-input.md');
    assert.equal(input2, `${PREFACE_WITH_DECISIONS}${answers}${file.content}`);
    assert.equal(file.content.includes('The owner\'s decisions'), false);
    const commit2 = D.git(project, 'rev-parse', '--short', 'HEAD');
    assert.equal(D.endMessage(s), [
      'Full: the loop ended. DONE after round 2 of 3.',
      'Verdict: DONE',
      'Reason: Every definition-of-done item has evidence.',
      'Findings: none',
      'Builder: completed, 3 turns, $0.0123, context peak 5%, not compacted, 0 denied calls',
      `Session: ${D.SESSION}`,
      `To take it over on the PC, run this in ${project}:`,
      `claude --resume ${D.SESSION}`,
      `Commit: ${commit2} "Loop: round 2"`,
      'Summary: DONE_SUMMARY_MARKER hello.js prints hello and has a test.',
      records(project),
    ].join('\n'));
    assert.deepEqual(D.git(project, 'log', '--format=%s').split('\n'), ['Loop: round 2', 'Loop: round 1', 'Loop: GOAL.md']);
    assert.equal(D.git(project, 'status', '--porcelain'), '');
    assert.equal(D.git(project, 'ls-files').split('\n').some((name) => name.startsWith('.audit')), false, '.audit/ is never committed');
    assert.deepEqual(callsOf(s), [
      'auditor:goal-check:0:ask', 'auditor:goal-check:0:continue', 'builder:ok', 'auditor:round:1:continue', 'builder:ok', 'auditor:round:2:done',
    ]);

    assert.equal(s.state().loop, null);
    const loop = D.loopState(project);
    assert.equal(loop.step, 'ended');
    assert.equal(loop.round, 2);
    assert.equal(loop.end.why, 'DONE after round 2 of 3.');
    assert.equal(loop.rounds[1].commit, commit1);
    assert.equal(loop.rounds[2].verdict.verdict, 'DONE');
    assert.equal(loop.decisions.length, 1);

    const log = D.loopLog(project);
    const expected = [
      /^---- \/loop Full: loop [0-9a-f]{8} started, at most 3 rounds, claude 9\.9\.9 \(Fake Claude\) ----$/,
      /^goal check started \(job \d+\)$/,
      /^goal check 1: ASK_HUMAN: GOAL\.md leaves the greeting to the owner\.$/,
      /^goal check: question 1 answered \(button\): hello, world$/,
      /^goal check: question 2 answered \(button\): Yes$/,
      /^2 answers saved in DECISIONS\.md under "Goal check": asking the auditor again$/,
      /^goal check started \(job \d+\)$/,
      /^goal check 2: CONTINUE: GOAL\.md is clear enough to start\.$/,
      /^round 1: builder started \(job \d+\)$/,
      /^round 1: builder ended: completed, 3 turns, \$0\.0123, HANDOFF\.md written$/,
      /^round 1: committed [0-9a-f]{7,} "Loop: round 1"$/,
      /^round 1: auditor started \(job \d+\)$/,
      /^round 1: verdict CONTINUE: Round 1 did part of the work\.$/,
      /^round 1: the prompt for round 2 is proposed \(round-02-prompt-proposed\.md\): waiting for Approve, Edit or Stop$/,
      /^round 2: prompt approved after 0 edits, \d+ bytes$/,
      /^round 2: builder started \(job \d+\)$/,
      /^round 2: builder ended: completed, 3 turns, \$0\.0123, HANDOFF\.md written$/,
      /^round 2: committed [0-9a-f]{7,} "Loop: round 2"$/,
      /^round 2: auditor started \(job \d+\)$/,
      /^round 2: verdict DONE: Every definition-of-done item has evidence\.$/,
      /^loop ended: DONE after round 2 of 3\.$/,
    ];
    assert.equal(log.length, expected.length, log.join('\n'));
    expected.forEach((pattern, i) => assert.match(log[i], pattern));
    assert.ok(D.readAudit(project, 'loop.log').split('\n').filter(Boolean).every((line) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d \S/.test(line)), 'every line has the time');

    // The loop is over: the next tick has nothing to do, and the old buttons have expired.
    assert.equal((await s.tick()).stdout, 'idle\n');
    D.press(s, proposal, 'Approve');
    D.press(s, q1, '1. hello');
    await s.tick();
    assert.deepEqual(D.buttonAnswers(s).slice(-2), ['This button has expired.', 'This button has expired.']);
    assert.equal(s.calls().length, 6);
  });

  test('Edit with notes, Edit with a file, /cancel during an Edit, then Approve: the builder gets exactly the approved text after the preface', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Edits');
    s.script({ auditor: ['continue', 'continue', 'done'], builder: ['ok', 'ok'] });
    await D.startLoop(s, 'Edits');
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal');
    const original = proposed(project);
    const first = D.proposalMessage(s);

    // Edit, then a text: a note at the top of the prompt.
    D.press(s, first, 'Edit');
    await s.tick();
    assert.equal(D.texts(s).pop(), 'Edits, round 2 of 3: edit the prompt. Send a note as a text message: it goes to the top of the prompt and takes priority. '
      + 'Or send a .md or .txt file (up to 100 KB): it replaces the whole prompt.\n/cancel keeps the prompt as it is.');
    s.fake.message(s.owner, 'NOTE_ONE keep it short');
    await s.tick();
    const withOne = `${NOTE_HEADING}\n\nNOTE_ONE keep it short\n\n${PROMPT_HEADING}\n\n${original}`;
    assert.equal(proposed(project), withOne);
    assert.equal(D.readAudit(project, 'round-02-prompt-edit-1.md'), withOne);
    assert.equal(D.readAudit(project, 'round-02-prompt-auditor.md'), original, 'the auditor\'s own prompt is kept');
    assert.ok(D.said(s, /^Edits, round 2 of 3: your note was added at the top of the prompt \(1 note now\)\.$/));
    assert.equal(D.documents(s).pop().content, withOne);
    assert.equal(D.documents(s).pop().caption, 'Edits: the proposed prompt for round 2, after 1 edit');
    const second = D.proposalMessage(s);
    assert.notEqual(D.button(second, 'Approve').callback_data, D.button(first, 'Approve').callback_data);
    assert.deepEqual(s.fake.sent.slice(-3).map((m) => m.method), ['sendMessage', 'sendDocument', 'sendMessage'], 'the new proposal comes with its buttons again');

    // The buttons of the proposal before the edit have expired.
    D.press(s, first, 'Approve');
    await s.tick();
    assert.equal(D.buttonAnswers(s).pop(), 'This button has expired.');
    assert.equal(fs.existsSync(D.audit(project, 'round-02-prompt.md')), false);

    // Notes stack up.
    D.press(s, second, 'Edit');
    s.fake.message(s.owner, 'NOTE_TWO\nwith a second line');
    await s.tick();
    assert.equal(proposed(project), `${NOTE_HEADING}\n\nNote 1:\nNOTE_ONE keep it short\n\nNote 2:\nNOTE_TWO\nwith a second line\n\n${PROMPT_HEADING}\n\n${original}`);
    assert.ok(D.said(s, /your note was added at the top of the prompt \(2 notes now\)\.$/));

    // A file replaces the whole prompt, the notes included. This one does not ask for the handoff.
    D.press(s, D.proposalMessage(s), 'Edit');
    s.fake.document(s.owner, 'my-prompt.md', 'REPLACEMENT_MARKER do only this.');
    await s.tick();
    assert.equal(proposed(project), 'REPLACEMENT_MARKER do only this.\n');
    assert.ok(D.said(s, /^Edits, round 2 of 3: the prompt was replaced by your file \(33 bytes\)\.\nNote: your file does not ask for HANDOFF\.md\. The fixed preface in front of every prompt still does\.$/));

    // A file of the wrong kind is refused and the bot goes on waiting; the note after it lands on the replacement.
    D.press(s, D.proposalMessage(s), 'Edit');
    s.fake.document(s.owner, 'prompt.pdf', 'x');
    await s.tick();
    assert.match(D.texts(s).pop(), /^Edits, round 2 of 3: That file is not a \.md or \.txt file\.\nSend a note as a text message/);
    s.fake.message(s.owner, 'NOTE_THREE');
    await s.tick();
    const final = `${NOTE_HEADING}\n\nNOTE_THREE\n\n${PROMPT_HEADING}\n\nREPLACEMENT_MARKER do only this.\n`;
    assert.equal(proposed(project), final);

    // /cancel during an Edit keeps the proposal as it was, and shows the buttons again.
    D.press(s, D.proposalMessage(s), 'Edit');
    s.fake.message(s.owner, '/cancel');
    await s.tick();
    assert.deepEqual(D.texts(s).slice(-2), ['Edits, round 2 of 3: the edit was cancelled. The prompt is as it was.', 'Edits, round 2 of 3: start the builder with this prompt?']);
    assert.ok(s.fake.sent[s.fake.sent.length - 1].replyMarkup, 'the buttons are shown again');
    assert.equal(proposed(project), final);
    // No Edit is pending now: a text is not taken as a note.
    s.fake.message(s.owner, 'not a note');
    await s.tick();
    assert.equal(D.texts(s).pop(), 'I did not understand that. Send /help for the list of commands.');
    assert.equal(proposed(project), final);

    D.press(s, D.proposalMessage(s), 'Approve');
    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
    assert.equal(D.readAudit(project, 'round-02-prompt.md'), final);
    assert.equal(D.readAudit(project, 'round-02-builder-input.md'), `${PREFACE}${final}`);
    assert.equal(s.calls().filter((call) => call.kind === 'builder')[1].stdin, `${PREFACE}${final}`);
    // Every original and every edit is kept.
    assert.deepEqual(fs.readdirSync(path.join(project, '.audit')).filter((name) => name.startsWith('round-02-prompt')).sort(), [
      'round-02-prompt-auditor.md', 'round-02-prompt-edit-1.md', 'round-02-prompt-edit-2.md', 'round-02-prompt-edit-3.md',
      'round-02-prompt-edit-4.md', 'round-02-prompt-proposed.md', 'round-02-prompt.md',
    ]);
    assert.ok(D.loopLog(project).some((line) => /^round 2: prompt approved after 4 edits, \d+ bytes$/.test(line)));
    assert.ok(D.loopLog(project).some((line) => line === 'round 2: prompt edit 3: replaced by a file (round-02-prompt-edit-3.md)'));
  });

  test('Stop at the buttons ends the loop and keeps the proposal', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'StopButton');
    s.script({ auditor: ['continue', 'continue'], builder: ['ok'] });
    await D.startLoop(s, 'StopButton');
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal');
    const proposal = D.proposalMessage(s);
    D.press(s, proposal, 'Stop');
    await s.tick();
    assert.equal(D.endMessage(s), [
      'StopButton: the loop ended. Stopped by you at the prompt for round 2.',
      'The proposed prompt stays in .audit\\round-02-prompt-proposed.md.',
      records(project),
    ].join('\n'));
    assert.equal(D.buttonAnswers(s).pop(), 'Stopped');
    assert.equal(s.state().loop, null);
    assert.equal(fs.existsSync(D.audit(project, 'round-02-prompt-proposed.md')), true);
    assert.equal(fs.existsSync(D.audit(project, 'round-02-prompt.md')), false);
    D.press(s, proposal, 'Approve');
    await s.tick();
    assert.equal(D.buttonAnswers(s).pop(), 'This button has expired.');
    assert.equal(s.calls().filter((call) => call.kind === 'builder').length, 1);
    s.fake.message(s.owner, '/stop');
    await s.tick();
    assert.equal(D.texts(s).pop(), 'No loop is running.');
  });

  test('/stop during a builder job: the round is committed, not audited', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'StopBuild');
    s.script({ auditor: ['continue'], builder: [{ mode: 'ok', delayMs: 3000 }] });
    await D.startLoop(s, 'StopBuild');
    await D.tickUntil(s, () => D.said(s, /The builder started with your first prompt/), 'the builder to start');
    s.fake.message(s.owner, '/stop');
    s.fake.message(s.owner, '/stop');
    await s.tick();
    assert.deepEqual(D.texts(s).slice(-2), [
      'StopBuild, round 1 of 3: stopping, not at once. The builder is at work and is not cut off. When it ends, its round is committed, not audited, and the loop ends.',
      'StopBuild, round 1 of 3: already stopping. The loop ends when the builder ends.',
    ]);
    assert.equal(D.loopState(project).stopping, true);
    assert.equal(D.endMessage(s), undefined, 'no mid-round cut-off');

    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
    const commit = D.git(project, 'rev-parse', '--short', 'HEAD');
    assert.equal(D.endMessage(s), [
      'StopBuild: the loop ended. Stopped by /stop after the builder of round 1: the round is committed, not audited.',
      'Builder: completed, 3 turns, $0.0123, context peak 5%, not compacted, 0 denied calls',
      `Session: ${D.SESSION}`,
      `To take it over on the PC, run this in ${project}:`,
      `claude --resume ${D.SESSION}`,
      `Commit: ${commit} "Loop: round 1"`,
      records(project),
    ].join('\n'));
    // The builder ran its full time, its work is committed, and no auditor ran on it.
    const summary = JSON.parse(D.readAudit(project, 'round-01-builder.json'));
    assert.ok(summary.duration_s >= 2.9, `the builder ran ${summary.duration_s} s`);
    assert.deepEqual(D.git(project, 'log', '--format=%s').split('\n'), ['Loop: round 1', 'Loop: GOAL.md']);
    assert.equal(D.git(project, 'status', '--porcelain'), '');
    assert.equal(fs.existsSync(D.audit(project, 'round-01-verdict.json')), false);
    assert.deepEqual(callsOf(s), ['auditor:goal-check:0:continue', 'builder:ok']);
    // The session was reported while the builder ran.
    assert.ok(D.said(s, new RegExp(`^StopBuild, round 1 of 3: builder session ${D.SESSION}\\nTo take it over on the PC, run this in .*StopBuild:\\nclaude --resume ${D.SESSION}$`)));
  });

  test('/stop during an auditor job and during the goal check: the loop ends when that step ends', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'StopAudit');
    s.script({ auditor: ['continue', { reply: 'continue', delayMs: 3000 }], builder: ['ok'] });
    await D.startLoop(s, 'StopAudit');
    await D.tickUntil(s, () => D.said(s, /The auditor is checking the round\.$/), 'the auditor to start');
    s.fake.message(s.owner, '/stop');
    await s.tick();
    assert.equal(D.texts(s).pop(), 'StopAudit, round 1 of 3: stopping, not at once. The auditor is at work and is not cut off. When it has its verdict, I report it and the loop ends.');
    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
    const end = D.endMessage(s).split('\n');
    assert.equal(end[0], 'StopAudit: the loop ended. Stopped by /stop after the audit of round 1.');
    assert.equal(end[1], 'Verdict: CONTINUE');
    assert.ok(end.includes('The auditor\'s prompt for a next round is saved as .audit\\round-02-prompt-proposed.md.'));
    assert.match(proposed(project), /^AUDITOR_PROMPT_MARKER for round 2/);
    assert.equal(D.proposalMessage(s), undefined, 'no Approve button after a /stop');
    assert.equal(JSON.parse(D.readAudit(project, 'round-01-verdict.json')).verdict, 'CONTINUE');

    // During the goal check: no builder starts.
    const second = D.newProject(s, 'StopGoal');
    s.script({ auditor: [{ reply: 'continue', delayMs: 2500 }] });
    s.fake.message(s.owner, '/loop StopGoal');
    s.fake.message(s.owner, '/stop');
    await s.tick();
    assert.equal(D.texts(s).pop(), 'StopGoal, goal check: stopping, not at once. The goal check is at work and is not cut off. When it ends, the loop ends: no builder starts.');
    await D.tickUntil(s, () => /^StopGoal: the loop ended/.test(D.endMessage(s)), 'the end of the second loop');
    assert.equal(D.endMessage(s), `StopGoal: the loop ended. Stopped by /stop after the goal check (its verdict: CONTINUE). No builder started.\n${records(second)}`);
    assert.equal(fs.existsSync(D.audit(second, 'round-01-builder.json')), false);
  });

  test('/stop while the loop waits for answers ends it at once', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'StopAsk');
    s.script({ auditor: ['ask'] });
    await D.startLoop(s, 'StopAsk');
    await D.tickUntil(s, () => D.questionMessage(s, 2), 'the questions');
    const q1 = D.questionMessage(s, 1);
    D.press(s, q1, 'Other');
    s.fake.message(s.owner, '/stop');
    s.fake.message(s.owner, 'a typed answer that comes too late');
    await s.tick();
    assert.ok(D.said(s, /^StopAsk: the loop ended\. Stopped at once by \/stop: no job was running, it waited for your answers to the auditor's questions\.\n/));
    assert.equal(D.texts(s).pop(), 'I did not understand that. Send /help for the list of commands.', 'the typed-answer wait went with the loop');
    assert.deepEqual(s.state().conversations, {});
    assert.equal(fs.existsSync(D.audit(project, 'DECISIONS.md')), false);
    D.press(s, q1, '1. hello');
    await s.tick();
    assert.equal(D.buttonAnswers(s).pop(), 'This button has expired.');
  });

  test('no new handoff, and a builder that crashes: the round is committed and the loop ends without an audit', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const quiet = D.newProject(s, 'NoHandoff');
    s.script({ auditor: ['continue'], builder: ['no_handoff'] });
    await D.startLoop(s, 'NoHandoff');
    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
    const commit = D.git(quiet, 'rev-parse', '--short', 'HEAD');
    assert.equal(D.endMessage(s), [
      'NoHandoff: the loop ended. Round 1: no new handoff, no audit.',
      'The builder ended without writing or changing HANDOFF.md.',
      'Builder: completed, 3 turns, $0.0123, context peak 5%, not compacted, 0 denied calls',
      `Session: ${D.SESSION}`,
      `To take it over on the PC, run this in ${quiet}:`,
      `claude --resume ${D.SESSION}`,
      `Commit: ${commit} "Loop: round 1"`,
      records(quiet),
    ].join('\n'));
    assert.deepEqual(D.git(quiet, 'log', '--format=%s').split('\n'), ['Loop: round 1', 'Loop: GOAL.md'], 'what changed is committed');
    assert.deepEqual(callsOf(s), ['auditor:goal-check:0:continue', 'builder:no_handoff'], 'no audit');

    const crashed = D.newProject(s, 'Crashes');
    s.script({ auditor: ['continue'], builder: ['crash'] });
    await D.startLoop(s, 'Crashes');
    await D.tickUntil(s, () => /^Crashes: the loop ended/.test(D.endMessage(s)), 'the end of the second loop');
    const end = D.endMessage(s).split('\n');
    assert.equal(end[0], 'Crashes: the loop ended. Round 1: the builder failed, so there is no audit.');
    assert.equal(end[1], 'Error: claude ended with exit code 3 and no result. fake claude: crashing as asked');
    assert.equal(end[2], 'Builder: claude ended without a result, turns unknown, cost unknown, context peak 5,010 tokens (window unknown), not compacted, 0 denied calls');
    assert.ok(end.includes(`Commit: ${D.git(crashed, 'rev-parse', '--short', 'HEAD')} "Loop: round 1"`));
    assert.ok(end.includes('What the builder had changed is committed, and not audited.'));
    assert.deepEqual(D.git(crashed, 'log', '--format=%s').split('\n'), ['Loop: round 1', 'Loop: GOAL.md']);
    assert.equal(fs.existsSync(D.audit(crashed, 'round-01-verdict.json')), false);
    assert.equal(s.state().loop, null);
  });

  test('the auditor says STOP_FOR_HUMAN, fails, times out or cannot be parsed: the loop ends with the reason', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();

    const stopped = D.newProject(s, 'AuditStop');
    s.script({ auditor: ['continue', 'stop'], builder: ['ok'] });
    await D.startLoop(s, 'AuditStop');
    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
    let end = D.endMessage(s).split('\n');
    assert.equal(end[0], 'AuditStop: the loop ended. The auditor says STOP_FOR_HUMAN after round 1 of 3.');
    assert.deepEqual(end.slice(1, 5), ['Verdict: STOP_FOR_HUMAN', 'Reason: The same problem failed twice in a row.', 'Findings:', '- hello.js: still prints nothing']);
    assert.ok(end.includes('What you need to do: STOP_NOTE_MARKER decide whether to fix hello.js by hand.'));
    assert.ok(end.includes(`Commit: ${D.git(stopped, 'rev-parse', '--short', 'HEAD')} "Loop: round 1"`));
    assert.equal(D.proposalMessage(s), undefined);

    const failed = D.newProject(s, 'AuditError');
    s.script({ auditor: ['continue', 'error'], builder: ['ok'] });
    await D.startLoop(s, 'AuditError');
    await D.tickUntil(s, () => /^AuditError: the loop ended/.test(D.endMessage(s)), 'the end of the second loop');
    end = D.endMessage(s).split('\n');
    assert.equal(end[0], 'AuditError: the loop ended. Round 1: the auditor failed, so the round has no verdict.');
    assert.equal(end[1], 'Error: claude reported an error (error_during_execution): API Error: overloaded');
    assert.match(end[2], /^Its log: .*runtime\\logs\\job-\d+\.log$/);
    assert.ok(end.includes(`The round is committed. To audit it by hand: node scripts\\run_auditor.js --project ${failed} --round 1`));
    assert.equal(fs.existsSync(D.audit(failed, 'round-01-verdict.json')), false);
    assert.deepEqual(D.git(failed, 'log', '--format=%s').split('\n'), ['Loop: round 1', 'Loop: GOAL.md']);

    // A reply that breaks the format twice: run_auditor.js makes it STOP_FOR_HUMAN.
    D.newProject(s, 'AuditGarbled');
    s.script({ auditor: ['continue', 'invalid', 'invalid'], builder: ['ok'] });
    await D.startLoop(s, 'AuditGarbled');
    await D.tickUntil(s, () => /^AuditGarbled: the loop ended/.test(D.endMessage(s)), 'the end of the third loop');
    end = D.endMessage(s).split('\n');
    assert.equal(end[0], 'AuditGarbled: the loop ended. The auditor says STOP_FOR_HUMAN after round 1 of 3.');
    assert.equal(end[2], 'Reason: auditor output could not be parsed');

    // An auditor that hangs is killed after auditorTimeoutMinutes.
    D.newProject(s, 'AuditHangs');
    s.script({ auditor: ['continue', 'hang'], builder: ['ok'] });
    const quick = s.writeConfig({ auditorTimeoutMinutes: 0.05 });
    await D.startLoop(s, 'AuditHangs', { configFile: quick });
    await D.tickUntil(s, () => /^AuditHangs: the loop ended/.test(D.endMessage(s)), 'the end of the fourth loop', { tickOptions: { configFile: quick } });
    end = D.endMessage(s).split('\n');
    assert.equal(end[0], 'AuditHangs: the loop ended. Round 1: the auditor failed, so the round has no verdict.');
    assert.equal(end[1], 'Error: auditor timed out after 0.05 minutes and was killed');
  });

  test('the goal check says STOP_FOR_HUMAN or fails: no builder starts', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'GoalStop');
    s.script({ auditor: ['stop'] });
    await D.startLoop(s, 'GoalStop');
    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
    assert.equal(D.endMessage(s), [
      'GoalStop: the loop ended. The goal check says STOP_FOR_HUMAN: no builder started.',
      'Verdict: STOP_FOR_HUMAN',
      'Reason: The same problem failed twice in a row.',
      'Findings:',
      '- hello.js: still prints nothing',
      'What you need to do: STOP_NOTE_MARKER decide whether to fix hello.js by hand.',
      records(project),
    ].join('\n'));
    assert.deepEqual(callsOf(s), ['auditor:goal-check:0:stop']);

    // No round ran, so the owner can try again on the same project.
    s.script({ auditor: ['error'] });
    await D.startLoop(s, 'GoalStop');
    await D.tickUntil(s, () => /The goal check failed/.test(D.endMessage(s)), 'the end of the second loop');
    const end = D.endMessage(s).split('\n');
    assert.equal(end[0], 'GoalStop: the loop ended. The goal check failed, so no builder started.');
    assert.equal(end[1], 'Error: claude reported an error (error_during_execution): API Error: overloaded');
    assert.equal(fs.existsSync(D.audit(project, 'round-01-builder.json')), false);
    assert.equal(fs.readdirSync(path.join(project, '.audit')).filter((name) => /^loop-before-/.test(name)).length, 1, 'the first loop\'s state was set aside');
    assert.equal(D.git(project, 'log', '--format=%s'), 'Loop: GOAL.md');
  });

  test('ASK_HUMAN after a round: an answer typed after "Other (type it)", then the follow-up\'s verdict', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'AskRound');
    s.script({ auditor: ['continue', 'ask', 'continue'], builder: ['ok'] });
    await D.startLoop(s, 'AskRound');
    await D.tickUntil(s, () => D.questionMessage(s, 2), 'the questions');
    const commit = D.git(project, 'rev-parse', '--short', 'HEAD');
    const intro = D.lastText(s, /^AskRound, round 1 of 3: audited\. The auditor has 2 questions/).split('\n');
    assert.equal(intro[0], 'AskRound, round 1 of 3: audited. The auditor has 2 questions before it can go on.');
    assert.equal(intro[1], 'Verdict: ASK_HUMAN');
    assert.ok(intro.includes(`Commit: ${commit} "Loop: round 1"`));
    assert.equal(intro[intro.length - 1], 'After your answers: ASK_NEXT_MARKER write hello.js once the greeting is chosen.');
    const q1 = D.questionMessage(s, 1);
    assert.match(q1.text, /^AskRound, round 1 of 3: Question 1 of 2 \[MUST\]\n/);

    // Other, then /cancel: back to the buttons.
    D.press(s, q1, 'Other');
    await s.tick();
    assert.equal(D.texts(s).pop(), 'AskRound, round 1 of 3: question 1: type your answer as the next message.\n/cancel goes back to the buttons.');
    assert.equal(D.buttonAnswers(s).pop(), 'Type your answer');
    s.fake.message(s.owner, '/cancel');
    await s.tick();
    assert.deepEqual(D.texts(s).slice(-2), ['AskRound, round 1 of 3: no answer was typed. Question 1 is still open:', q1.text]);

    // Other again, and the answer as the next text message. It is saved on one line.
    D.press(s, D.questionMessage(s, 1), 'Other');
    s.fake.message(s.owner, '  Salam,\n  world  ');
    await s.tick();
    assert.equal(D.texts(s).pop(), 'AskRound, round 1 of 3: answer 1 of 2 saved: Salam, world\n1 question still open.');
    // The first answer counts: the buttons of that question have expired.
    D.press(s, q1, '1. hello');
    await s.tick();
    assert.equal(D.buttonAnswers(s).pop(), 'This button has expired.');
    assert.equal(D.loopState(project).questions.items[0].answer.text, 'Salam, world');

    // What is not a text is not an answer.
    D.press(s, D.questionMessage(s, 2), 'Other');
    s.fake.document(s.owner, 'answer.md', 'an answer in a file');
    await s.tick();
    assert.equal(D.texts(s).pop(), 'AskRound, round 1 of 3, question 2: type the answer as a text message, or send /cancel to go back to the buttons.');
    D.press(s, D.questionMessage(s, 2), '2. No');
    await s.tick();
    assert.deepEqual(s.state().conversations, {}, 'the typed-answer wait went with the answer by button');
    assert.deepEqual(D.texts(s).slice(-2), [
      'AskRound, round 1 of 3: answer 2 of 2 saved: No',
      'AskRound, round 1 of 3: 2 answers saved in .audit\\DECISIONS.md. Asking the auditor again.',
    ]);
    assert.equal(D.readAudit(project, 'DECISIONS.md'), [
      DECISIONS_HEAD,
      '',
      `## Round 1, ${localStamp().slice(0, 10)}`,
      '- Q: Which greeting should hello.js print?',
      '  A: Salam, world (answered)',
      '- Q: Should the output end with a line break?',
      '  A: No (answered)',
      '',
    ].join('\n'));

    // The follow-up is the same round: its verdict is handled like a round's.
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal after the follow-up');
    assert.deepEqual(callsOf(s), ['auditor:goal-check:0:continue', 'builder:ok', 'auditor:round:1:ask', 'auditor:followup:1:continue']);
    const followup = s.calls()[3].stdin;
    assert.match(followup, /^AUDIT MATERIAL: FOLLOW-UP of round 1$/m);
    assert.match(followup, /A: Salam, world \(answered\)/);
    assert.equal(fs.existsSync(D.audit(project, 'round-01-ask-1-verdict.json')), true);
    const verdict = JSON.parse(D.readAudit(project, 'round-01-verdict.json'));
    assert.equal(verdict.kind, 'followup');
    assert.equal(verdict.verdict, 'CONTINUE');
    assert.deepEqual(D.git(project, 'log', '--format=%s').split('\n'), ['Loop: round 1', 'Loop: GOAL.md'], 'HEAD did not move between the question and the follow-up');
    const round = D.lastText(s, /^AskRound, round 1 of 3: audited\.\n/).split('\n');
    assert.equal(round[1], 'Verdict: CONTINUE');
    assert.equal(D.documents(s).pop().filename, 'AskRound-round-02-prompt.md');
    assert.ok(D.loopLog(project).includes('round 1: follow-up verdict CONTINUE: Round 1 did part of the work.'));
    assert.ok(D.loopLog(project).includes('round 1: question 1 answered (typed): Salam, world'));
    D.press(s, D.proposalMessage(s), 'Stop');
    await s.tick();
    assert.equal(s.state().loop, null);
  });

  test('the round cap: the last round ends with CONTINUE, the loop ends, and the prompt comes as a file without buttons', async (t) => {
    const s = await botSandbox(t, { config: { roundCap: 2 } });
    await s.firstTick();
    const project = D.newProject(s, 'Capped');
    s.script({ auditor: ['continue', 'many', 'continue'], builder: ['ok', 'ok'] });
    await D.startLoop(s, 'Capped');
    assert.match(D.texts(s).pop(), /^Capped: the loop started, with at most 2 rounds\./);
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal');
    // Thirteen findings: the first ten, then how many more.
    const round = D.lastText(s, /^Capped, round 1 of 2: audited\./).split('\n');
    assert.equal(round[4], '- finding number 1');
    assert.equal(round[13], '- finding number 10');
    assert.equal(round[14], 'and 3 more');
    const buttonsBefore = D.keyboards(s).length;
    D.press(s, D.proposalMessage(s), 'Approve');
    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
    const end = D.endMessage(s).split('\n');
    assert.equal(end[0], 'Capped: the loop ended. The round cap is reached: round 2 of 2 ended with CONTINUE, and the work is not done.');
    assert.equal(end[1], 'Verdict: CONTINUE');
    assert.ok(end.includes('The auditor\'s prompt for a round 3 follows as a file. It is saved as .audit\\round-03-prompt-proposed.md; no round starts.'));
    const last = s.fake.sent[s.fake.sent.length - 1];
    assert.equal(last.method, 'sendDocument', 'the prompt comes after the end message');
    assert.equal(last.filename, 'Capped-round-03-prompt.md');
    assert.equal(last.caption, 'Capped: the auditor\'s prompt for a round 3. The loop has ended: nothing starts.');
    assert.match(last.content, /^AUDITOR_PROMPT_MARKER for round 3\n/);
    assert.equal(D.keyboards(s).length, buttonsBefore, 'no buttons after the cap');
    assert.equal(fs.existsSync(D.audit(project, 'round-03-prompt.md')), false);
    assert.equal(s.state().loop, null);
    assert.deepEqual(D.git(project, 'log', '--format=%s').split('\n'), ['Loop: round 2', 'Loop: round 1', 'Loop: GOAL.md']);

    // With a cap of 1 there is never a proposal with buttons.
    const single = await botSandbox(t, { config: { roundCap: 1 } });
    await single.firstTick();
    D.newProject(single, 'One');
    single.script({ auditor: ['continue', 'continue'], builder: ['ok'] });
    await D.startLoop(single, 'One');
    assert.match(D.texts(single).pop(), /^One: the loop started, with at most 1 round\./);
    await D.tickUntil(single, () => D.endMessage(single), 'the end of the loop');
    assert.match(D.endMessage(single), /^One: the loop ended\. The round cap is reached: round 1 of 1 ended with CONTINUE/);
    assert.equal(D.keyboards(single).length, 0);
  });

  test('a staged .env or a file under secrets\\: nothing is committed and the loop stops', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Leaky');
    s.script({ auditor: ['continue'], builder: ['secret'] });
    await D.startLoop(s, 'Leaky');
    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
    const end = D.endMessage(s).split('\n');
    assert.deepEqual(end.slice(0, 5), [
      'Leaky: the loop ended. Round 1 was NOT committed: these paths look like secrets.',
      '- .env.local',
      '- config/secrets/api-token.txt',
      'Nothing was committed, and everything was unstaged. The round\'s files are still in the folder.',
      'Remove those files or add them to .gitignore. The round was not audited.',
    ]);
    assert.equal(D.git(project, 'log', '--format=%s'), 'Loop: GOAL.md', 'nothing was committed');
    assert.equal(D.git(project, 'diff', '--cached', '--name-only'), '', 'everything was unstaged');
    assert.equal(fs.existsSync(path.join(project, 'hello.js')), true, 'the round\'s files are still there');
    assert.equal(fs.existsSync(path.join(project, 'config', 'secrets', 'api-token.txt')), true);
    assert.deepEqual(callsOf(s), ['auditor:goal-check:0:continue', 'builder:secret'], 'no audit');
    assert.equal(s.state().loop, null);
    assert.ok(D.loopLog(project).includes('round 1: NOT committed, staged paths look like secrets: .env.local, config/secrets/api-token.txt'));

    // A project made with /new ignores .env, so a .env there is never staged at all.
    const ignoring = D.newProject(s, 'Ignoring');
    s.script({ auditor: ['continue', 'done'], builder: ['dotenv'] });
    await D.startLoop(s, 'Ignoring');
    await D.tickUntil(s, () => /^Ignoring: the loop ended/.test(D.endMessage(s)), 'the end of the second loop');
    assert.match(D.endMessage(s), /^Ignoring: the loop ended\. DONE after round 1 of 3\./);
    assert.equal(fs.existsSync(path.join(ignoring, '.env')), true);
    assert.equal(D.git(ignoring, 'ls-files').split('\n').includes('.env'), false);

    // Without that line in .gitignore the .env is staged, and the commit is refused.
    const open = D.newProject(s, 'OpenEnv');
    fs.writeFileSync(path.join(open, '.gitignore'), '.audit/\n');
    D.git(open, 'commit', '-q', '-am', 'no .env line');
    s.script({ auditor: ['continue'], builder: ['dotenv'] });
    await D.startLoop(s, 'OpenEnv');
    await D.tickUntil(s, () => /^OpenEnv: the loop ended/.test(D.endMessage(s)), 'the end of the third loop');
    assert.deepEqual(D.endMessage(s).split('\n').slice(0, 2), ['OpenEnv: the loop ended. Round 1 was NOT committed: these paths look like secrets.', '- .env']);
    assert.deepEqual(D.git(open, 'log', '--format=%s').split('\n'), ['no .env line', 'Loop: GOAL.md']);
  });

  test('paths that look like secrets', () => {
    for (const file of ['.env', '.ENV', '.env.local', 'app/.env.production', 'cert.pem', 'keys/server.KEY', 'id_rsa', 'home/id_rsa.pub',
      'secrets/readme.md', 'config/Secrets/a/b.txt', 'n8n-loop/secrets/bot-token.txt', 'secrets/.env.example',
      // Phase 7e: only the three template names are exempt, not names that merely start with them.
      '.env.example.local', '.env.examples', 'app/.env.sample.bak']) {
      assert.equal(looksLikeSecret(file), true, file);
    }
    for (const file of ['env', 'environment.js', 'src/env.js', 'dotenv.md', 'keyboard.js', 'monkey.txt', 'secrets', 'secrets.md', 'my-secrets/readme.md', 'pem.txt', 'HANDOFF.md',
      // Phase 7e: the templates of a .env, in any folder and any letter case (SERVERS-STANDARD.md Part B step 3).
      '.env.example', '.env.sample', 'config/.env.template', '.ENV.EXAMPLE', 'app/.env.example']) {
      assert.equal(looksLikeSecret(file), false, file);
    }
  });

  test('a staged .env.example is committed, unless it holds a value of the project\'s .env or lies under secrets (Phase 7e)', (t) => {
    const root = path.join(ROOT, 'tests', 'tmp', 'bot', `template-${process.pid}-${Date.now()}`);
    fs.mkdirSync(root, { recursive: true });
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    const { dir: project } = createProject({ root, name: 'CCallingLike', goal: D.GOAL, prompt: D.PROMPT });
    setEnvValue(project, 'TWILIO_SID', 'ACabcdefgh12345678');
    const template = path.join(project, '.env.example');
    const placeholder = 'TWILIO_SID=your_twilio_sid_here\n';
    const subjects = () => D.git(project, 'log', '--format=%s').split('\n');

    // (a) A template with placeholders: committed, and the real .env stays out of git.
    fs.writeFileSync(template, placeholder);
    const a = commitRound(project, 16);
    assert.equal(a.committed, true, JSON.stringify(a));
    assert.deepEqual(subjects(), ['Loop: round 16', 'Loop: GOAL.md']);
    assert.deepEqual(D.git(project, 'ls-files').split('\n').sort(), ['.env.example', '.gitignore', 'GOAL.md']);

    // (b) The same template with the real value: refused as a holder, by its content.
    fs.writeFileSync(template, 'TWILIO_SID=ACabcdefgh12345678\n');
    const b = commitRound(project, 17);
    assert.equal(b.committed, false);
    assert.deepEqual(b.holders, ['.env.example']);
    assert.deepEqual(b.secrets, [], 'not by its name');
    assert.equal(b.unstaged, true);
    assert.deepEqual(subjects(), ['Loop: round 16', 'Loop: GOAL.md'], 'nothing was committed');
    assert.equal(D.git(project, 'diff', '--cached', '--name-only'), '', 'everything was unstaged');
    assert.equal(fs.readFileSync(template, 'utf8'), 'TWILIO_SID=ACabcdefgh12345678\n', 'the file is still in the folder');

    // (c) A template under a folder named secrets: refused by its name, before its content.
    fs.writeFileSync(template, placeholder);
    fs.mkdirSync(path.join(project, 'secrets'));
    fs.writeFileSync(path.join(project, 'secrets', '.env.example'), placeholder);
    const c = commitRound(project, 18);
    assert.equal(c.committed, false);
    assert.deepEqual(c.secrets, ['secrets/.env.example']);
    assert.deepEqual(c.holders, []);
    assert.deepEqual(subjects(), ['Loop: round 16', 'Loop: GOAL.md'], 'nothing was committed');
    assert.equal(D.git(project, 'diff', '--cached', '--name-only'), '', 'everything was unstaged');
  });

  test('the pre-flight check refuses with one message that says what failed', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const root = s.projectsRoot;
    fs.mkdirSync(path.join(root, 'Plain'));
    fs.mkdirSync(path.join(root, 'NoGoal'));
    D.git(path.join(root, 'NoGoal'), 'init', '-q');
    const noPrompt = D.newProject(s, 'NoPrompt');
    fs.rmSync(D.audit(noPrompt, 'round-01-prompt.md'));
    const tracked = D.newProject(s, 'AuditTracked');
    fs.writeFileSync(path.join(tracked, '.gitignore'), '.env\n');
    D.git(tracked, 'commit', '-q', '-am', 'no .audit line');
    const dirty = D.newProject(s, 'Dirty');
    fs.writeFileSync(path.join(dirty, 'extra.txt'), 'x');
    fs.appendFileSync(path.join(dirty, 'GOAL.md'), 'changed\n');
    const built = D.newProject(s, 'Built');
    fs.writeFileSync(D.audit(built, 'round-01-builder.json'), '{}');
    fs.writeFileSync(D.audit(built, 'round-01-builder.log'), '');
    const audited = D.newProject(s, 'Audited');
    fs.writeFileSync(D.audit(audited, 'round-03-verdict.json'), '{}');
    D.newProject(s, 'Good');

    const cases = [
      ['/loop', 'A project needs a name.\nUse it like this: /loop My_Project'],
      ['/loop two words', 'The name may only have letters (a-z, A-Z), digits, "-" and "_".\nUse it like this: /loop My_Project'],
      ['/loop ..', 'The name may only have letters (a-z, A-Z), digits, "-" and "_".\nUse it like this: /loop My_Project'],
      ['/loop Nowhere', `/loop was refused: there is no project named Nowhere in ${root}.`],
      ['/loop Plain', '/loop was refused: Plain: it is not a git repository.'],
      ['/loop NoGoal', '/loop was refused: NoGoal: it has no GOAL.md.'],
      ['/loop NoPrompt', '/loop was refused: NoPrompt: it has no first prompt (.audit\\round-01-prompt.md). A project made with /new has one.'],
      ['/loop AuditTracked', '/loop was refused: AuditTracked: its .gitignore does not ignore .audit/, so the loop\'s commits would take the loop\'s own records along. '
        + 'Add the line ".audit/" to .gitignore and commit that.'],
      ['/loop dirty', '/loop was refused: Dirty: its working tree is not clean. Commit or remove these first (git status --porcelain):\n M GOAL.md\n?? extra.txt'],
      ['/loop Built', '/loop was refused: Built: rounds already ran there (.audit\\round-01-builder.json and 1 more). To continue that loop, send /resume Built.'],
      ['/loop Audited', '/loop was refused: Audited: rounds already ran there (.audit\\round-03-verdict.json). To continue that loop, send /resume Audited.'],
    ];
    for (const [text] of cases) s.fake.message(s.owner, text);
    await s.tick();
    assert.deepEqual(D.texts(s), cases.map(([, answer]) => answer));

    // claude itself: it must start, and it must be logged in. Neither check is a model call.
    s.fake.message(s.owner, '/loop Good');
    await s.tick({ extraEnv: { FAKE_CLAUDE_VERSION: 'fail' } });
    assert.equal(D.texts(s).pop(), '/loop was refused: "claude --version" failed (exit code 1: fake claude: cannot start). Nothing was started.');
    s.fake.message(s.owner, '/loop Good');
    await s.tick({ extraEnv: { FAKE_CLAUDE_AUTH: 'out' } });
    assert.equal(D.texts(s).pop(), '/loop was refused: claude is not logged in: run "claude" on the PC and log in. Nothing was started.');
    assert.deepEqual(s.calls(), [], 'nothing was started');
    assert.equal(s.state().loop, null);
    assert.equal(fs.existsSync(D.audit(path.join(root, 'Good'), 'loop.json')), false);

    // One loop at a time, across all projects.
    D.newProject(s, 'Second');
    s.script({ auditor: [{ reply: 'stop', delayMs: 2500 }] });
    s.fake.message(s.owner, '/loop Good');
    s.fake.message(s.owner, '/loop Second');
    s.fake.message(s.owner, '/loop good');
    await s.tick();
    const answers = D.texts(s).slice(-3);
    assert.match(answers[0], /^Good: the loop started/);
    assert.match(answers[1], /^\/loop was refused: a loop is already running: Good, goal check \(goal check running since \d\d:\d\d:\d\d\)\. One loop at a time; \/stop ends it\.$/);
    assert.equal(answers[2], answers[1]);
    assert.equal(fs.existsSync(D.audit(path.join(root, 'Second'), 'loop.json')), false);
    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
    assert.equal(s.calls().length, 1);
  });

  test('buttons from someone else get no answer, and buttons that are not the loop\'s own have expired', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Buttons');
    s.script({ auditor: ['ask'] });
    await D.startLoop(s, 'Buttons');
    await D.tickUntil(s, () => D.questionMessage(s, 2), 'the questions');
    const q1 = D.questionMessage(s, 1);
    const data = D.button(q1, '1. hello').callback_data;
    const stranger = 777000111;
    const sentBefore = s.fake.sent.length;

    // A stranger, and the owner outside the private chat, press a button that is live.
    s.fake.press(stranger, data, { username: 'stranger' });
    s.fake.press(s.owner, data, { from: stranger, username: 'pretender' });
    s.fake.press(-1001234, data, { from: s.owner, chatType: 'group' });
    await s.tick();
    assert.equal(s.fake.sent.length, sentBefore, 'no answer at all, not even to the button press');
    assert.equal(D.loopState(project).questions.items[0].answer, null);
    assert.deepEqual(s.logTexts().slice(-3), [
      `not the owner: chat ${stranger}, username @stranger`,
      `not the owner: chat ${s.owner}, username @pretender`,
      'not the owner: chat -1001234, username @owner_name',
    ]);

    // Buttons that do not belong to this loop, to this question, or to anything.
    const [, loopId, buttonId] = data.split(':');
    for (const bad of [`lq:deadbeef:${buttonId}:0`, `lq:${loopId}:ffffff:0`, `lq:${loopId}:${buttonId}:3`, `lp:${loopId}:${buttonId}:a`, 'lq:x', 'lp:', `lq:${loopId}:${buttonId}:9`]) {
      s.fake.press(s.owner, bad);
    }
    await s.tick();
    assert.deepEqual(D.buttonAnswers(s).slice(-7), Array(7).fill('This button has expired.'));
    assert.equal(D.loopState(project).questions.items[0].answer, null);
    s.fake.message(s.owner, '/stop');
    await s.tick();
  });

  test('text goes to what the bot asked for last: /new drops a pending Edit, and an Edit drops a pending /new', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Waits');
    s.script({ auditor: ['continue', 'continue'], builder: ['ok'] });
    await D.startLoop(s, 'Waits');
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal');
    const before = proposed(project);

    D.press(s, D.proposalMessage(s), 'Edit');
    s.fake.message(s.owner, '/new Other_Project');
    s.fake.message(s.owner, 'THIS_IS_GOAL_TEXT');
    await s.tick();
    const answers = D.texts(s).slice(-2);
    assert.equal(answers[0], 'Dropped: the edit of Waits\'s prompt for round 2 (the prompt is as it was, and its buttons still work).\n'
      + 'New project Other_Project, step 1 of 2: send GOAL.md, as a text message, or as a .md or .txt file (up to 100 KB).\n/cancel stops this.');
    assert.match(answers[1], /^GOAL\.md received/);
    assert.equal(proposed(project), before, 'the text went to /new, not into the prompt');

    // Now the other way round: Edit while /new waits for the first prompt.
    D.press(s, D.proposalMessage(s), 'Edit');
    s.fake.message(s.owner, 'A_NOTE_NOT_A_PROMPT');
    await s.tick();
    assert.ok(D.said(s, /^Dropped: the new project Other_Project \(nothing was created\)\.\nWaits, round 2 of 3: edit the prompt\./));
    assert.match(proposed(project), /A_NOTE_NOT_A_PROMPT/);
    assert.deepEqual(s.state().conversations, {});
    assert.equal(fs.existsSync(path.join(s.projectsRoot, 'Other_Project')), false);
    D.press(s, D.proposalMessage(s), 'Stop');
    await s.tick();
  });

  test('a builder that died is seen as lost: the loop says so and asks, with three buttons', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Lost');
    s.script({ auditor: ['continue'], builder: [{ mode: 'ok', delayMs: 20000 }] });
    await D.startLoop(s, 'Lost');
    await D.tickUntil(s, () => D.loopState(project).step === 'builder' && fs.existsSync(D.audit(project, 'round-01-builder.json'))
      && fs.existsSync(D.loopState(project).job.recordFile) && s.calls().some((call) => call.kind === 'builder'), 'the builder to run');
    // The runner is killed, as a power cut would: its record keeps saying "running".
    const job = D.loopState(project).job;
    const record = JSON.parse(fs.readFileSync(job.recordFile, 'utf8'));
    const claudePid = s.calls().find((call) => call.kind === 'builder').pid;
    const builderPid = JSON.parse(D.readAudit(project, 'round-01-builder.json')).runner_pid;
    for (const pid of [record.runner_pid, builderPid, claudePid]) {
      try {
        process.kill(pid);
      } catch {
        // gone already
      }
    }
    await s.tick();
    assert.equal(D.endMessage(s), undefined, 'a heartbeat that is still fresh is not a lost job');
    // Ten minutes later, as far as the record goes.
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    fs.writeFileSync(job.recordFile, JSON.stringify({ ...record, heartbeat_at: stale }));
    await s.tick();
    // Since Phase 4 the loop does not end here: a builder that was cut off gets the
    // three buttons, and nothing is committed until the owner chooses.
    const asked = D.lastKeyboard(s);
    assert.equal(asked.text, [
      'Lost, round 1 of 3: the builder ended without a result: its process is gone and its record has no end.',
      `Its log: ${job.logFile}`,
      'Lost, round 1 of 3: the builder was cut off (its process is gone and its record has no end, as after a restart of the PC). Nothing was committed.',
      'What the round left (git status --short):',
      '?? hello.js',
      '?? work.log',
      'Redo the round: the partial work is put aside with git stash (never deleted), and the builder runs again with the same prompt.',
      'Keep and audit: what is there is committed as "Loop: round 1 (cut off)" and audited.',
      'Stop: the loop ends, and nothing changes.',
    ].join('\n'));
    assert.deepEqual(asked.replyMarkup.inline_keyboard.map((row) => row.map((b) => b.text)), [['Redo the round', 'Keep and audit', 'Stop']]);
    for (const b of asked.replyMarkup.inline_keyboard[0]) assert.match(b.callback_data, /^lc:[0-9a-f]{8}:[0-9a-f]{6}:[rks]$/);
    assert.equal(D.endMessage(s), undefined);
    assert.equal(D.loopState(project).step, 'choice');
    assert.equal(D.git(project, 'log', '--format=%s'), 'Loop: GOAL.md');
    assert.equal((await s.tick()).stdout, 'idle\n', 'it is asked once');

    D.press(s, asked, 'Stop');
    await s.tick();
    assert.equal(D.endMessage(s), [
      'Lost: the loop ended. Stopped by you, after the builder of round 1 was cut off.',
      'Nothing was changed: what the round left is still in the folder, uncommitted.',
      records(project),
    ].join('\n'));
    assert.equal(D.git(project, 'status', '--porcelain'), '?? hello.js\n?? work.log');
    assert.equal(s.state().loop, null);
    assert.equal((await s.tick()).stdout, 'idle\n');
  });

  test('a tick that was cut off between its two writes: the next one shows where the loop stands', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'CutOff');
    s.script({ auditor: ['continue', 'continue'], builder: ['ok'] });
    await D.startLoop(s, 'CutOff');
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal');
    const sent = s.fake.sent.length;
    assert.equal((await s.tick()).stdout, 'idle\n');

    // As if the tick that saved the proposal in loop.json had died before it saved state.json.
    const state = s.state();
    state.loop.rev -= 1;
    fs.writeFileSync(s.stateFile, JSON.stringify(state));
    await s.tick();
    const again = s.fake.sent.slice(sent);
    assert.deepEqual(again.map((m) => m.method), ['sendMessage', 'sendDocument', 'sendMessage']);
    assert.match(again[0].text, /^CutOff, round 1 of 3: audited\.\nVerdict: CONTINUE/);
    assert.equal(again[2].text, 'CutOff, round 2 of 3: start the builder with this prompt?');
    assert.match(s.logTexts().pop(), /^loop CutOff: loop\.json is at write \d+ and state\.json saw write \d+: showing where the loop stands$/);
    assert.equal(s.state().loop.rev, D.loopState(project).rev);
    assert.equal((await s.tick()).stdout, 'idle\n', 'it is shown once');

    // The same for the end of a loop: loop.json says "ended", state.json still points to it.
    D.press(s, D.proposalMessage(s), 'Stop');
    await s.tick();
    const end = D.endMessage(s);
    const pointer = { id: D.loopState(project).id, name: 'CutOff', project, rev: 0 };
    fs.writeFileSync(s.stateFile, JSON.stringify({ ...s.state(), loop: pointer }));
    const before = s.fake.sent.length;
    await s.tick();
    assert.deepEqual(D.texts(s).slice(-1), [end], 'the end is said again');
    assert.equal(s.fake.sent.length, before + 1);
    assert.equal(s.state().loop, null);
  });

  test('a step that fails on something unexpected ends the loop: it does not fail every tick', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Surprise');
    s.script({ auditor: ['continue', 'continue'], builder: ['ok'] });
    // The file the loop will want to write the proposal to is a folder.
    fs.mkdirSync(D.audit(project, 'round-02-prompt-proposed.md'));
    await D.startLoop(s, 'Surprise');
    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
    const end = D.endMessage(s).split('\n');
    assert.equal(end[0], 'Surprise: the loop ended. It stopped on an unexpected error.');
    assert.match(end[1], /^Error: /);
    assert.equal(end[2], 'It was at: auditor, round 1.');
    assert.ok(s.logTexts().some((line) => /^loop Surprise: unexpected error at step auditor: /.test(line)));
    assert.equal(s.state().loop, null);
    const r = await s.tick();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'idle\n');
  });

  test('a builder that refuses to run (its round has records already) ends the loop, and nothing is committed', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    const project = D.newProject(s, 'Refused');
    s.script({ auditor: ['continue', 'continue'], builder: ['ok'] });
    await D.startLoop(s, 'Refused');
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal');
    // Records of round 2 that should not be there, and a change that nobody committed.
    fs.writeFileSync(D.audit(project, 'round-02-builder.jsonl'), '');
    fs.writeFileSync(path.join(project, 'stray.txt'), 'not the builder\'s work\n');
    D.press(s, D.proposalMessage(s), 'Approve');
    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
    const end = D.endMessage(s).split('\n');
    assert.equal(end[0], 'Refused: the loop ended. Round 2: the builder did not run.');
    assert.match(end[1], /^Error: round 2's builder already ran: .*round-02-builder\.jsonl exists$/);
    assert.equal(end[2], 'Nothing was committed.');
    assert.deepEqual(D.git(project, 'log', '--format=%s').split('\n'), ['Loop: round 1', 'Loop: GOAL.md']);
    assert.equal(D.git(project, 'status', '--porcelain'), '?? stray.txt');
    assert.equal(s.calls().filter((call) => call.kind === 'builder').length, 1, 'claude was not started for round 2');
  });

  // ---- state files that a power cut damaged (fix 4 of the Phase 3a audit) ----

  const DAMAGE = {
    '510 zero bytes': Buffer.alloc(510),
    'half a JSON': Buffer.from('{\n  "offset": 12,\n  "conversations": {},\n  "outbo'),
    'empty': Buffer.alloc(0),
  };

  for (const [what, bytes] of Object.entries(DAMAGE)) {
    test(`a state.json that is ${what}: the next tick recovers, with and without a good state.json.bak`, async (t) => {
      const s = await botSandbox(t);
      await s.firstTick();
      s.fake.message(s.owner, '/ping');
      await s.tick();
      const offset = s.state().offset;
      const backup = `${s.stateFile}.bak`;
      assert.equal(fs.existsSync(backup), true, 'every write keeps the file before it');
      const corrupt = () => fs.readdirSync(s.runtimeDir).filter((name) => name.startsWith('state.json.corrupt-'));

      // With a good backup: the bot goes on from it, and the offset is kept.
      fs.writeFileSync(backup, fs.readFileSync(s.stateFile));
      fs.writeFileSync(s.stateFile, bytes);
      s.fake.message(s.owner, '/ping');
      const first = await s.tick();
      assert.equal(first.status, 0, first.stderr);
      assert.equal(first.stdout, 'ok: 1 update, 1 sent\n');
      assert.equal(first.stderr, '');
      assert.equal(D.texts(s).length, 2, 'the /ping was answered, and the one before it was not answered again');
      assert.equal(s.state().offset, offset + 1);
      const recovered = s.logTexts().filter((line) => line.startsWith('state recovered: '));
      assert.equal(recovered.length, 1, 'one line in bot.log');
      assert.match(recovered[0], /^state recovered: state\.json was (510 zero bytes|not valid JSON \(\d+ bytes\)|empty), moved aside as state\.json\.corrupt-\d{8}-\d{6}; state\.json\.bak was used$/);
      assert.equal(corrupt().length, 1, 'the bad file was moved aside');
      assert.deepEqual(fs.readFileSync(path.join(s.runtimeDir, corrupt()[0])), bytes);
      assert.equal((await s.tick()).stdout, 'idle\n');
      assert.equal(s.logTexts().filter((line) => /^state (recovered|lost)/.test(line)).length, 1, 'the same broken file does not come back');

      // With a backup that is damaged too: the bot starts again as on a first tick.
      fs.writeFileSync(s.stateFile, bytes);
      fs.writeFileSync(backup, bytes);
      s.fake.message(s.owner, '/ping');
      const second = await s.tick();
      assert.equal(second.status, 0, second.stderr);
      assert.equal(second.stdout, 'idle\n');
      assert.equal(second.stderr, '');
      const lines = s.logTexts().slice(-2);
      assert.match(lines[0], /^state lost: state\.json was .*, moved aside as state\.json\.corrupt-[\d-]+; state\.json\.bak was .*, moved aside as state\.json\.bak\.corrupt-[\d-]+; starting again as a first tick$/);
      assert.equal(lines[1], 'first tick: skipped 1 updates that were already waiting');
      assert.equal(D.texts(s).length, 2, 'what was waiting is skipped, as on a first tick');
      s.fake.message(s.owner, '/ping');
      assert.equal((await s.tick()).stdout, 'ok: 1 update, 1 sent\n');

      // Without any backup.
      fs.writeFileSync(s.stateFile, bytes);
      fs.rmSync(backup, { force: true });
      const third = await s.tick();
      assert.equal(third.status, 0, third.stderr);
      assert.match(s.logTexts().slice(-2)[0], /^state lost: state\.json was .*; there is no state\.json\.bak; starting again as a first tick$/);
      assert.equal(s.state().offset, offset + 3);
    });

    test(`a loop.json that is ${what}: the loop goes on from loop.json.bak, and ends with a clear message when that is damaged too`, async (t) => {
      const s = await botSandbox(t);
      await s.firstTick();
      const project = D.newProject(s, 'Damaged');
      s.script({ auditor: ['continue', 'continue', 'done'], builder: ['ok', 'ok'] });
      await D.startLoop(s, 'Damaged');
      await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal');
      const file = D.audit(project, 'loop.json');
      const backup = `${file}.bak`;
      assert.equal(fs.existsSync(backup), true);

      // With a good backup: one message, one log line, and the loop goes on.
      fs.writeFileSync(backup, fs.readFileSync(file));
      fs.writeFileSync(file, bytes);
      const first = await s.tick();
      assert.equal(first.status, 0, first.stderr);
      assert.equal(first.stderr, '');
      assert.match(D.texts(s).pop(), /^Damaged: \.audit\\loop\.json could not be used \(loop\.json was .*, moved aside as loop\.json\.corrupt-[\d-]+; loop\.json\.bak was used\)\. The loop goes on from its last good copy, which can be one step behind\.$/);
      assert.equal(s.logTexts().filter((line) => line.startsWith('loop Damaged: state recovered: ')).length, 1);
      assert.equal(fs.readdirSync(path.join(project, '.audit')).filter((name) => name.startsWith('loop.json.corrupt-')).length, 1);
      assert.equal(s.state().loop.name, 'Damaged');
      D.press(s, D.proposalMessage(s), 'Approve');
      await s.tick();
      assert.equal(D.texts(s).pop(), 'Damaged, round 2 of 3: approved. The builder started with .audit\\round-02-prompt.md.');
      assert.equal(D.loopState(project).step, 'builder', 'loop.json is whole again');

      // With a backup that is damaged too: the loop ends, with a clear message.
      fs.writeFileSync(file, bytes);
      fs.writeFileSync(backup, bytes);
      const second = await s.tick();
      assert.equal(second.status, 0, second.stderr);
      assert.equal(second.stderr, '');
      const end = D.endMessage(s).split('\n');
      assert.match(end[0], /^Damaged: the loop ended\. Its state file \.audit\\loop\.json could not be used, and neither could its backup: loop\.json was .*; loop\.json\.bak was .*\.$/);
      assert.equal(end[1], 'Nothing was changed in the project. If a builder or an auditor was running, it runs on to its end, but nobody reports it.');
      assert.equal(end[2], `Records: ${path.join(project, '.audit')} (loop.log and the round-NN-* files say how far it got)`);
      assert.equal(s.state().loop, null);
      const third = await s.tick();
      assert.equal(third.status, 0, third.stderr);
      assert.equal(third.stdout, 'idle\n', 'the same broken file does not fail every tick');
      // The builder that was running is left alone and finishes its round.
      await D.tickUntil(s, () => JSON.parse(D.readAudit(project, 'round-02-builder.json')).status === 'completed', 'the builder to finish');
    });
  }

  test('a tick that fails on an unexpected error writes it to bot.log, not only to stderr', async (t) => {
    const s = await botSandbox(t);
    await s.firstTick();
    // A state file that cannot even be opened: a folder in its place.
    fs.rmSync(s.stateFile);
    fs.rmSync(`${s.stateFile}.bak`, { force: true });
    fs.mkdirSync(s.stateFile);
    const r = await s.tick();
    assert.equal(r.status, 1);
    const what = 'state.json could not be read (EISDIR); there is no state.json.bak: nothing was done, the next tick tries again';
    assert.equal(r.stderr, `[bot] error: ${what}\n`);
    assert.equal(s.logTexts().pop(), `tick failed: ${what}`);
    assert.equal(fs.statSync(s.stateFile).isDirectory(), true, 'what cannot be read is not thrown away');
    assert.equal(fs.existsSync(path.join(s.runtimeDir, 'tick.lock')), false, 'the lock was released');
  });

  test('the token shows up nowhere in the loop\'s flows: not in an output, a runtime file or a project file', async (t) => {
    const s = await botSandbox(t);
    const key = s.token.slice(s.token.indexOf(':') + 1);
    await s.firstTick();
    const project = D.newProject(s, 'Canary');
    s.script({ auditor: ['ask', 'continue', 'ask', 'continue', 'done'], builder: ['ok', 'ok'] });
    await D.startLoop(s, 'Canary');
    await D.tickUntil(s, () => D.questionMessage(s, 2), 'the questions');
    // The owner pastes the token into a typed answer, a note and a file.
    D.press(s, D.questionMessage(s, 1), 'Other');
    s.fake.message(s.owner, `the token is ${s.token}`);
    D.press(s, D.questionMessage(s, 2), '1. Yes');
    await D.tickUntil(s, () => D.keyboards(s).filter((m) => /round 1 of 3: Question 2/.test(m.text)).length, 'the questions of round 1');
    // A server that repeats the request path, token included, while messages, files and button answers go out.
    s.fake.modeFor = { sendMessage: 'echo', sendDocument: 'echo', answerCallbackQuery: 'echo' };
    D.press(s, D.questionMessage(s, 1), '1. hello');
    D.press(s, D.questionMessage(s, 2), '2. No');
    await s.tick();
    s.fake.modeFor = { sendDocument: 'error500' };
    await D.tickUntil(s, () => D.loopState(project).step === 'proposal', 'the proposal');
    await s.tick();
    s.fake.modeFor = { sendDocument: 'hangup' };
    await s.tick();
    s.fake.modeFor = {};
    await D.tickUntil(s, () => D.proposalMessage(s), 'the proposal\'s buttons');
    D.press(s, D.proposalMessage(s), 'Edit');
    s.fake.message(s.owner, `a note with ${s.token} and its key ${key}`);
    await s.tick();
    D.press(s, D.proposalMessage(s), 'Edit');
    s.fake.document(s.owner, 'prompt.md', `Do this with ${encodeURIComponent(s.token)}.\nThen write HANDOFF.md.\n`);
    await s.tick();
    D.press(s, D.proposalMessage(s), 'Edit');
    s.fake.message(s.owner, `one more: ${s.token}`);
    await s.tick();
    s.fake.mode = 'unauthorized';
    await s.tick();
    s.fake.mode = 'ok';
    D.press(s, D.proposalMessage(s), 'Approve');
    await D.tickUntil(s, () => D.endMessage(s), 'the end of the loop');
    assert.match(D.endMessage(s), /^Canary: the loop ended\. DONE after round 2 of 3\./);

    // The filter was at work, not idle.
    assert.match(D.readAudit(project, 'DECISIONS.md'), /A: the token is <bot-token> \(answered\)/);
    assert.match(D.readAudit(project, 'round-02-prompt.md'), /one more: <bot-token>/);
    assert.match(D.readAudit(project, 'round-02-prompt-edit-2.md'), /^Do this with <bot-token>\.$/m);
    assert.ok(s.readLog().join('\n').includes('/bot<bot-token>/sendMessage'), 'the echoed path is in the log, redacted');

    const needles = [s.token, key, encodeURIComponent(s.token)];
    const hits = [];
    s.outputs.forEach((text, i) => needles.forEach((needle) => { if (text.includes(needle)) hits.push(`output ${i}`); }));
    const runtimeFiles = filesUnder(s.runtimeDir);
    const projectFiles = filesUnder(project).filter(({ file }) => !file.includes(`${path.sep}.git${path.sep}`));
    for (const { file, text } of [...runtimeFiles, ...projectFiles]) needles.forEach((needle) => { if (text.includes(needle)) hits.push(file); });
    assert.ok(s.outputs.length >= 30, `${s.outputs.length} outputs were searched`);
    assert.ok(runtimeFiles.some(({ file }) => /jobs.job-\d+\.json$/.test(file)) && runtimeFiles.some(({ file }) => /logs.job-\d+\.log$/.test(file)));
    assert.ok(projectFiles.some(({ file }) => file.endsWith('loop.json')) && projectFiles.some(({ file }) => file.endsWith('round-02-builder-input.md')));
    assert.deepEqual(hits, [], 'the token was found');
    t.diagnostic(`canary search over the loop: ${s.outputs.length} outputs, ${runtimeFiles.length} runtime files and ${projectFiles.length} project files searched for 3 forms of the token, ${hits.length} hits`);
  });
});
