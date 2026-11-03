'use strict';

// The rehearsal of the owner's Phase 7 test: his script, step by step and in the order
// he will run it, played against the fake Telegram server and the fake claude. From
// /new Overnight_Test with the pair in tests/smoke/phase7/ to the morning: the overnight
// run of three rounds with no Approve, the report, /status, /resume and /cancel.
// Nothing here makes a real Claude call or a real Telegram call.
//
// Each step is what the owner does, followed by everything the bot must answer before
// the owner's next step. The bot's answers are compared with the script one by one, in
// order: a text, a file or a button answer that differs, is missing, comes on top, or
// has a sound where the script says silent (or the other way round) fails it.
//   - The fake auditor says what the real one should say: CONTINUE with the next
//     overnight item twice, then DONE after round 3. The checks prove the records: the
//     prompts approved by the loop, the material's OVERNIGHT RUN block and Written by
//     line, and the report's three sections.
//   - The fake builder writes the same small files whatever the prompt says.
//
// Usage: node tests/run_phase7_rehearsal.js --fake [--quiet] [--keep]
//   --fake   required: there is no other mode. The real run is the owner's, from Telegram.
//   --quiet  one line per step instead of the bot's full answers
//   --keep   keep the sandbox folder (it is removed after a rehearsal that passed)
// Exit code: 0 when every step passed, 1 when one failed, 2 for bad arguments.

const fs = require('node:fs');
const path = require('node:path');
const { botSandbox, ROOT } = require('./helpers/bot_sandbox');
const D = require('./helpers/loop_driver');

const MIN = 60 * 1000;
const NAME = 'Overnight_Test';
const PAIR = path.join(ROOT, 'tests', 'smoke', 'phase7');
const HOW = 'as a text message, or as a .md or .txt file (up to 100 KB)';
const FINAL_TASK = 'Final task: overwrite HANDOFF.md in the project root with these sections: What was done, Files changed, '
  + 'How it was verified (exact commands and their real output), Problems and open questions, What\'s left. Report only what you actually did and saw.';
const GOAL = fs.readFileSync(path.join(PAIR, 'GOAL.md'), 'utf8');
const FIRST_PROMPT = fs.readFileSync(path.join(PAIR, 'first-prompt.md'), 'utf8');

// ---- what the fake auditor answers, call by call ----

const A = {
  round1: 'The count command is built as GOAL.md says and I checked it myself: npm test passes 6 of 6, and node wordtool.js count on a file of mine gives the right three numbers. Next overnight item: upper.',
  round2: 'The upper command is built and tested: npm test passes 9 of 9. The error check is kept. Next overnight item: reverse.',
  done: 'Every item of the Overnight section has evidence I checked myself: count, upper and reverse are built, each with its test file, and npm test passes 12 of 12. The top command is not in the Overnight section and waits for the owner.',
  summary: 'Built overnight: wordtool.js with the commands count, upper and reverse, each with a test file in test/, the error check (Error: and exit code 1), and package.json with npm test (12 tests pass). Not built, for the owner\'s review: the top command.',
};
const prompt = (command, file, extra) => [
  `Read GOAL.md and HANDOFF.md. Build the next item of the Overnight section of GOAL.md: the ${command} command, and only that.`,
  '',
  `1. In wordtool.js, add the ${command} command: ${extra}. Keep the error check as it is: a missing command, an unknown command or a missing file prints one line that starts with Error: and exits with code 1.`,
  `2. Add test/${file} with node:test: at least three tests for ${command}, each writing its own input file into a temporary folder from os.tmpdir() and removing it afterwards.`,
  '3. Run npm test and show its output in HANDOFF.md.',
  '',
  'Do not build the other commands in this round.',
  '',
  FINAL_TASK,
].join('\n');
const reply = (verdict, reason, findings, rest) => ({ text: [`VERDICT: ${verdict}`, `REASON: ${reason}`, 'FINDINGS:', ...findings.map((f) => `- ${f}`), ...rest].join('\n') });
const AUDITOR = [
  'continue',
  reply('CONTINUE', A.round1, ['none'], ['NEXT_PROMPT:', prompt('upper', 'upper.test.js', 'it prints the text of the file with every letter in capitals, otherwise unchanged')]),
  reply('CONTINUE', A.round2, ['none'], ['NEXT_PROMPT:', prompt('reverse', 'reverse.test.js', 'it prints the lines of the file in reverse order, the last line first')]),
  reply('DONE', A.done, ['none'], ['NEXT_PROMPT:', A.summary]),
];
const BUILDER = [{ mode: 'ok', delayMs: 4000 }, { mode: 'ok', delayMs: 4000 }, { mode: 'ok', delayMs: 4000 }];

// ---- matching what the bot sent (as in tests/run_phase6_rehearsal.js) ----

const TOKENS = {
  '<TIME>': '\\d\\d:\\d\\d',
  '<WHEN>': '(?:\\d{4}-\\d\\d-\\d\\d )?\\d\\d:\\d\\d',
  '<DATETIME>': '\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d',
  '<N>': '\\d[\\d,.]*',
  '<HASH>': '[0-9a-f]{7,40}',
  '<SESSION>': '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
  '<LINE>': '[^\\n]*',
  '<LINES>': '[\\s\\S]*?',
};

function pattern(text, projectsRoot) {
  const escape = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const source = text.split(/(<[A-Z]+>)/).map((piece) => {
    if (piece === '<PROJECTS>') return escape(projectsRoot);
    return TOKENS[piece] || escape(piece);
  }).join('');
  return new RegExp(`^${source}$`);
}

// silent: the script says the message must come with disable_notification (an overnight run's own messages).
const msg = (text, buttons = null, { silent = false } = {}) => ({ kind: 'message', text: Array.isArray(text) ? text.join('\n') : text, buttons, silent });
const file = (name, caption, { silent = false } = {}) => ({ kind: 'file', name, caption, silent });
const pressed = (text) => ({ kind: 'button', text });
const quiet = (item) => ({ ...item, silent: true });

function describeSent(sent) {
  if (sent.method === 'sendMessage') {
    const buttons = sent.replyMarkup ? sent.replyMarkup.inline_keyboard.map((row) => row.map((b) => b.text).join(' | ')).join(' / ') : null;
    return { kind: 'message', text: sent.text, buttons, silent: sent.silent === true };
  }
  if (sent.method === 'sendDocument') return { kind: 'file', name: sent.filename, caption: sent.caption, silent: sent.silent === true };
  return { kind: 'button', text: sent.text };
}

function show(item) {
  const sound = item.kind === 'button' ? '' : (item.silent ? ' [silent]' : ' [with sound]');
  if (item.kind === 'file') return `[file] ${item.name}${item.caption ? `  (${item.caption})` : ''}${sound}`;
  if (item.kind === 'button') return `[the button answers] ${item.text}`;
  return `${item.text}${item.buttons ? `\n[buttons: ${item.buttons}]` : ''}${sound}`;
}

function difference(expected, got, projectsRoot) {
  if (expected.kind !== got.kind) return `a ${got.kind} came where the script has a ${expected.kind}`;
  if (expected.kind !== 'button' && Boolean(expected.silent) !== Boolean(got.silent)) return expected.silent ? 'it came with a sound where the script says silent' : 'it came silent where the script says with a sound';
  if (expected.kind === 'file') {
    if (!pattern(expected.name, projectsRoot).test(got.name)) return 'the file has another name';
    return expected.caption && !pattern(expected.caption, projectsRoot).test(got.caption || '') ? 'the file has another caption' : null;
  }
  if (!pattern(expected.text, projectsRoot).test(got.text || '')) return 'the text differs';
  if (expected.kind === 'message' && (expected.buttons || null) !== (got.buttons || null)) return 'the buttons differ';
  return null;
}

function blockOf(material, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^----- BEGIN ${n}[^\\n]* \\[([0-9a-f]{12})\\] -----\\n([\\s\\S]*?)\\n----- END ${n}[^\\n]* \\[\\1\\] -----$`, 'm').exec(material);
  return m ? m[2] : null;
}

// ---- the script ----

function script(h) {
  const P = `<PROJECTS>\\${NAME}`;
  const records = `Records: ${P}\\.audit (loop.log, loop.json and the round-NN-* files)`;
  const builderLine = 'Builder: completed, 3 turns, $0.0123, context peak 5%, not compacted, 0 denied calls';
  const sessionLines = ['Session: <SESSION>', `To take it over on the PC, run this in ${P}:`, 'claude --resume <SESSION>'];
  const sessionMessage = (round) => quiet(msg([`${NAME}, round ${round} of 3: builder session <SESSION>`, `To take it over on the PC, run this in ${P}:`, 'claude --resume <SESSION>']));
  const builderEnded = (round) => quiet(msg(`${NAME}, round ${round} of 3: the builder ended (completed, 3 turns, $0.0123, context peak 5%, not compacted, 0 denied calls). `
    + 'Committed as <HASH>. The auditor is checking the round.'));
  const roundMessage = (round, reason) => quiet(msg([
    `${NAME}, round ${round} of 3: audited.`, 'Verdict: CONTINUE', `Reason: ${reason}`, 'Findings: none', builderLine, ...sessionLines, `Commit: <HASH> "Loop: round ${round}"`,
    `Next: the auditor's prompt for round ${round + 1} follows as a file. The overnight run starts round ${round + 1} with it now, without your Approve.`,
  ]));
  const promptFile = (round) => quiet(file(`${NAME}-round-0${round}-prompt.md`, `${NAME}: the prompt for round ${round}, approved by the overnight run`));
  const approved = (round) => quiet(msg(`${NAME}, round ${round} of 3: approved by the overnight run, without your Approve. The builder started with .audit\\round-0${round}-prompt.md.`));
  const reportFile = (silent) => file(`${NAME}-LOOP_REPORT.md`, `${NAME}: the loop's report. Bring this file to Claude in chat for the final check.`, { silent });
  const material = (round) => h.auditOf(round).stdin;
  const record = (round) => (blockOf(material(round), 'PROMPT RECORD') || '').split('\n');

  return [
    {
      group: 'Before you start', tests: [], owner: 'Nothing to do: the bot was off while Claude worked, and says so when it is back.',
      act: () => h.gap(5 * MIN),
      expect: [msg('The bot was offline from <WHEN> to <WHEN> (about <N> min).')],
    },

    // ---------------- 1. /new ----------------
    {
      group: 'A new project', tests: [], owner: `Send: /new ${NAME}`, act: () => h.send(`/new ${NAME}`),
      expect: [msg([`New project ${NAME}, step 1 of 2: send GOAL.md, ${HOW}.`, '/cancel stops this.'])],
    },
    {
      tests: [], owner: 'Send GOAL.md (tests/smoke/phase7/GOAL.md) as one text message', act: () => h.send(GOAL),
      expect: [msg([`GOAL.md received: ${Buffer.byteLength(GOAL)} bytes.`, `Step 2 of 2: send the first prompt for the builder, ${HOW}.`])],
    },
    {
      tests: [], owner: 'Send the first prompt (tests/smoke/phase7/first-prompt.md) as one text message', act: () => h.send(FIRST_PROMPT),
      expect: [msg([
        'Ready to create the project. Nothing exists yet.', `Name: ${NAME}`, `Folder: ${P}`, 'GOAL.md: <N> bytes, <N> lines. It starts:', '<LINES>',
        'Overnight: GOAL.md has a "## Overnight" section with 3 items: /overnight can build them with no review.', 'First prompt: <N> bytes',
      ], 'Save | Cancel')],
    },
    {
      tests: [], owner: 'Press Save', act: () => h.press('Save'),
      expect: [pressed('Saved'), msg([`Created ${P}`, 'Commit <HASH> "Loop: GOAL.md" (.gitignore and GOAL.md)', 'The first prompt is saved as .audit\\round-01-prompt.md', `Next: /loop ${NAME}`])],
    },

    // ---------------- 2. the overnight run ----------------
    {
      group: 'The overnight run', tests: [], owner: `Send: /overnight ${NAME} 3, and go to sleep. Nothing rings.`, act: () => h.send(`/overnight ${NAME} 3`),
      expect: [
        msg([
          `${NAME}: the overnight run started, with at most 3 rounds (the round cap is 3). The rounds run back to back without your Approve, on the items of GOAL.md's "## Overnight" section only.`,
          'It stops at DONE (every overnight item done), STOP_FOR_HUMAN, the round cap or 70% of the 7-day window. Its messages come without sound. /stop ends it.',
          'First the auditor checks GOAL.md (goal check 1).',
        ]),
        quiet(msg(`${NAME}, round 1 of 3: GOAL.md is clear. The builder started with your first prompt (.audit\\round-01-prompt.md).`)),
        sessionMessage(1),
        builderEnded(1),
        roundMessage(1, A.round1),
        promptFile(2),
        approved(2),
        sessionMessage(2),
        builderEnded(2),
        roundMessage(2, A.round2),
        promptFile(3),
        approved(3),
        sessionMessage(3),
        builderEnded(3),
        quiet(msg([
          `${NAME}: the loop ended. Overnight: every item of ## Overnight is done after round 3 of 3.`, 'Verdict: DONE', `Reason: ${A.done}`, 'Findings: none',
          builderLine, ...sessionLines, 'Commit: <HASH> "Loop: round 3"', `Summary: ${A.summary}`,
          `The rest of GOAL.md waits for your review: /resume ${NAME} asks you for the next round's prompt.`, records,
        ])),
        reportFile(true),
      ],
      check: () => {
        const loop = h.loop();
        h.assert(loop.mode === 'overnight' && loop.cap === 3, 'loop.json keeps the mode and the cap');
        h.assert(loop.rounds[1].prompt.source === 'new' && !loop.rounds[1].prompt.approvedBy, 'round 1 ran with the /new prompt');
        h.assert([2, 3].every((round) => loop.rounds[round].prompt.approvedBy === 'overnight' && loop.rounds[round].prompt.edits === 0), 'rounds 2 and 3 were approved by the loop, with 0 edits');
        h.assert(h.readAudit('round-02-prompt.md') === h.readAudit('round-02-prompt-proposed.md') && h.readAudit('round-02-prompt.md').includes('the upper command'), 'round 2 got the auditor\'s prompt for upper, as proposed');
        h.assert(JSON.stringify(record(2).slice(0, 3)) === JSON.stringify(['Written by: you, as NEXT_PROMPT in the audit of round 1 (started by the overnight run, without the owner\'s Approve)', 'Owner edits: 0', 'Owner notes: none']),
          'the PROMPT RECORD of round 2 says the overnight run started it');
        h.assert((blockOf(material(2), 'OVERNIGHT RUN') || '').startsWith('This loop is an overnight run, started by the owner on '), 'the material of round 2 has the OVERNIGHT RUN block');
        h.assert(blockOf(h.auditOf(0).stdin, 'OVERNIGHT RUN') !== null, 'and so has the goal check');
        const report = h.lastFile().content;
        h.assert(/^- Overnight run: started .*, 3 rounds \(cap 3\): Overnight: every item of ## Overnight is done after round 3 of 3\./m.test(report), 'the report starts with the overnight run\'s line');
        h.assert(report.includes('\n## Overnight items\n\n- [ ] node wordtool.js count FILE') && report.includes(`Summary: ${A.summary}`), 'the report lists the overnight items with the last verdict\'s summary');
        h.assert(report.includes('\n## Open questions\n\nNone.\n'), 'the report lists the open questions (none)');
        h.assert(report.includes('\n## Left for your review\n\n- [ ] node wordtool.js top FILE') && !report.includes('\n## Left for your review\n\n- [ ] node wordtool.js count'), 'the report leaves top and the two general items for review');
        h.assert(JSON.stringify(loop.end.resume) === JSON.stringify({ how: 'new-prompt', round: 4 }), '/resume will ask for the next round\'s prompt');
      },
    },

    // ---------------- 3. the morning ----------------
    {
      group: 'The morning', tests: [], owner: 'Send: /status', act: () => h.send('/status'),
      expect: [msg([
        'No loop is running.',
        `Last loop: ${NAME}, ended <WHEN>: Overnight: every item of ## Overnight is done after round 3 of 3. /resume ${NAME} continues it.`,
        'Usage (as of <WHEN>): 5-hour window 34% used, resets <WHEN>; 7-day window 12% used, resets <DATETIME>',
        'Bot last offline: <WHEN> to <WHEN> (about <N> min).',
      ])],
    },
    {
      tests: [], owner: `Send: /resume ${NAME}`, act: () => h.send(`/resume ${NAME}`),
      expect: [
        msg([`${NAME}: resuming. It had ended: Overnight: every item of ## Overnight is done after round 3 of 3.`, 'The overnight run is over: from here every prompt waits for your Approve.']),
        msg([`${NAME}, round 4 of 3: send the prompt for round 4, ${HOW}.`, 'I show it to you with Approve, Edit and Stop before anything starts. /cancel ends the loop again; nothing changes.']),
      ],
      check: () => h.assert(h.loop().mode === 'normal' && h.loop().step === 'prompt-wait', 'the loop is in normal mode and waits for the owner\'s prompt'),
    },
    {
      tests: [], owner: 'Send: /cancel', act: () => h.send('/cancel'),
      expect: [
        msg([`${NAME}: the loop ended. No prompt for round 4 was sent (/cancel), so the loop ended again. Nothing changed.`, records]),
        reportFile(false),
      ],
      check: () => h.assert(h.state().loop === null && h.state().lastLoop.resumable === true, 'no loop runs, and it can be resumed again'),
    },
  ];
}

// ---- running it ----

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--fake') || argv.some((arg) => !['--fake', '--quiet', '--keep'].includes(arg))) {
    console.error('Usage: node tests/run_phase7_rehearsal.js --fake [--quiet] [--keep]\n'
      + 'It plays the owner\'s Phase 7 test against the fake Telegram and the fake claude. There is no real mode.');
    process.exitCode = 2;
    return;
  }
  const quietRun = argv.includes('--quiet');
  const s = await botSandbox(null, { tmp: path.join(ROOT, 'tests', 'tmp', 'phase7-rehearsal') });
  s.script({ auditor: AUDITOR, builder: BUILDER });
  const project = path.join(s.projectsRoot, NAME);
  const failures = [];
  const notes = [];
  let clock = 0;
  let gapNext = false;
  let cursor = 0;
  const indent = (text) => String(text).split('\n').map((line) => `      ${line}`).join('\n');

  const h = {
    state: () => s.state(),
    loop: () => D.loopState(project),
    readAudit: (name) => D.readAudit(project, name),
    send: (text) => s.fake.message(s.owner, text),
    press: (label) => D.press(s, D.lastKeyboard(s), label),
    gap: (ms) => {
      clock += ms;
      gapNext = true;
    },
    auditOf: (round) => s.calls().filter((call) => call.kind === 'auditor' && call.round === round).pop() || { stdin: '' },
    lastFile: () => D.documents(s).pop() || { content: '' },
    assert: (ok, what) => {
      notes.push(`${ok ? 'ok' : 'FAIL'}: ${what}`);
      if (!ok) failures.push(what);
    },
  };

  async function tick() {
    const r = await s.tickAt(clock, { gap: gapNext });
    gapNext = false;
    if (r.status !== 0 || r.stderr) throw new Error(`a tick failed: exit ${r.status}, ${r.stderr || r.stdout}`);
  }

  await s.firstTick();
  await tick();

  const steps = script(h);
  console.log(`Rehearsal of the owner's Phase 7 test: ${steps.length} steps, against the fake Telegram at ${s.fake.baseUrl} and the fake claude.`);
  console.log(`Sandbox: ${s.dir}`);
  let passed = 0;
  let stop = false;
  for (const [i, step] of steps.entries()) {
    if (step.group) console.log(`\n=============== ${step.group} ===============`);
    const tests = step.tests.length ? ` [checklist ${step.tests.join(', ')}]` : '';
    console.log(`\nSTEP ${i}${tests}\n  OWNER: ${step.owner}`);
    notes.length = 0;
    const failedBefore = failures.length;
    try {
      await step.act();
      const wanted = cursor + step.expect.length;
      for (let tries = 0; s.fake.sent.length < wanted || tries === 0; tries += 1) {
        if (tries >= 600) break;
        await tick();
        if (s.fake.sent.length < wanted) await D.sleep(120);
      }
      for (const [k, expected] of step.expect.entries()) {
        const sent = s.fake.sent[cursor + k];
        if (!sent) {
          failures.push(`step ${i}: answer ${k + 1} of ${step.expect.length} never came`);
          console.log(`  BOT: (nothing)\n  EXPECTED:\n${indent(show(expected))}`);
          stop = true;
          break;
        }
        const got = describeSent(sent);
        const differs = difference(expected, got, s.projectsRoot);
        if (!quietRun || differs) console.log(`  BOT:\n${indent(show(got))}`);
        if (differs) {
          failures.push(`step ${i}: answer ${k + 1} of ${step.expect.length}: ${differs}`);
          console.log(`  DIFFERS (${differs}). THE SCRIPT EXPECTS:\n${indent(show(expected))}`);
          stop = true;
        }
      }
      cursor += step.expect.length;
      if (!stop && step.check) await step.check();
    } catch (err) {
      failures.push(`step ${i}: ${err.message}`);
      console.log(`  ERROR: ${err.message}`);
      stop = true;
    }
    for (const note of notes) console.log(`  CHECK ${note}`);
    if (failures.length === failedBefore) passed += 1;
    console.log(`  ${failures.length === failedBefore ? 'PASS' : 'FAIL'}`);
    if (stop) break;
  }

  if (!stop) {
    for (let i = 0; i < 3; i += 1) await tick();
    if (s.fake.sent.length !== cursor) {
      failures.push(`the bot sent ${s.fake.sent.length - cursor} more than the script has`);
      for (const sent of s.fake.sent.slice(cursor)) console.log(`\nNOT IN THE SCRIPT:\n${indent(show(describeSent(sent)))}`);
    }
  }

  const calls = s.calls();
  const sent = s.fake.sent;
  console.log(`\nThe fake claude was called ${calls.length} times: ${calls.filter((call) => call.kind === 'auditor').length} audits, ${calls.filter((call) => call.kind === 'builder').length} builder rounds.`);
  console.log(`The bot sent ${sent.filter((m) => m.method === 'sendMessage').length} messages, ${sent.filter((m) => m.method === 'sendDocument').length} files and `
    + `${sent.filter((m) => m.method === 'answerCallbackQuery').length} button answers, all to the fake server; ${sent.filter((m) => m.silent).length} of them without a sound.`);
  await s.fake.close();
  if (failures.length) {
    console.log(`\nREHEARSAL FAILED: ${passed} of ${steps.length} steps passed.\n${failures.map((failure) => `- ${failure}`).join('\n')}\nThe sandbox is kept: ${s.dir}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nREHEARSAL PASSED: ${steps.length} steps, every reply as the script says.`);
  if (!argv.includes('--keep')) fs.rmSync(s.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
