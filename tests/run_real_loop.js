'use strict';

// One real loop, end to end, with the controls of Phase 4. This makes REAL Claude
// calls: the real builder and the real auditor, started by real ticks. Telegram is
// the fake server on 127.0.0.1, and the owner is scripted. Everything lives under
// tests/tmp/real-loop/: the project, the bot's runtime folder and a fake token.
// Nothing is sent to Telegram, the real n8n-loop\secrets is not read, and nothing is
// created in C:\Projects.
//
// The project is the pair in tests/smoke/phase4/: its GOAL.md leaves one choice to
// the owner, and its first prompt asks for a round that takes a minute or two.
// The scripted owner:
//   - sends /new, the two files and Save, then /loop;
//   - answers every question with the option the auditor recommends;
//   - once round 1's builder has run for a while: /status, then /log, then /abort and Confirm;
//   - then /resume, and presses "Redo the round";
//   - at the first proposal presses Edit and sends one note, then Approve;
//   - approves every later proposal;
//   - sends /stop once --max-calls Claude calls were started (default 12).
// What the real auditor decides is not scripted. The run prints what happened.
// Usage: node tests/run_real_loop.js --real [--max-calls <n>] [--abort-after <seconds>] [--pair <folder>] [--one-round]
//        node tests/run_real_loop.js --real --overnight [--rounds <n>] [--pair <folder>]
//        node tests/run_real_loop.js --fake [the same options]
//   --real       make the real Claude calls. Without it nothing is started: a run costs money.
//   --fake       a dry run of this script with the fake claude of the unit tests: no real call
//   --pair       the folder under tests/smoke/ with GOAL.md and first-prompt.md (default: phase4;
//                phase7 with --overnight)
//   --one-round  no controls: the goal check, one builder round and one audit, and the
//                owner presses Stop at the first proposal. It shows how long a round of the pair takes.
//   --overnight  Phase 7: /overnight <name> <rounds> instead of /loop, with --rounds as the cap
//                (default 2). No controls, no button to press: the owner presses nothing, and the run
//                ends by itself (DONE, STOP_FOR_HUMAN, the cap or the 7-day window). The script
//                then checks that no step waited for a button, that the records say
//                approvedBy "overnight", that every message of the run was silent, and that
//                the report has its three sections.
// Exit code: 0 when the loop ended, whatever its end; 1 when it did not end in time; 2 for bad arguments.

const fs = require('node:fs');
const path = require('node:path');
const { botSandbox, filesUnder, ROOT } = require('./helpers/bot_sandbox');
const D = require('./helpers/loop_driver');
const { localStamp } = require('../scripts/lib/runtime');

// The project's name for each pair: the real auditor and builder see it as their folder.
const NAMES = { phase4: 'Stats_Real', phase5: 'Todo_Real', 'phase5-break': 'Numkit_Real', phase7: 'Overnight_Test' };
const NOTE = 'In HANDOFF.md, also show the output of: node cli.js sample.txt';
const TICK_MS = 2000;
const LIMIT_MS = 60 * 60 * 1000;

const clock = () => localStamp().slice(11, 19);
const indent = (text) => String(text).split('\n').map((line) => `    ${line}`).join('\n');
const section = (title, text) => console.log(`\n===== ${title}\n${text}`);
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

function numberAfter(argv, flag, fallback) {
  const at = argv.indexOf(flag);
  const value = at === -1 ? fallback : Number(argv[at + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} needs a whole number above 0`);
  return value;
}

// The jobs so far, from their records, oldest first.
function jobsOf(s) {
  const dir = path.join(s.runtimeDir, 'jobs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => /^job-\d+\.json$/.test(name)).map((name) => readJson(path.join(dir, name))).filter(Boolean)
    .sort((a, b) => a.id - b.id);
}

const jobLog = (s, id) => {
  const file = path.join(s.runtimeDir, 'logs', `job-${id}.log`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
};

// One row per real Claude call: a builder round is one call, an audit is one call, or
// two when its first reply broke the format and it was asked again. A round that was
// cut off and done again has one row per attempt.
function claudeCalls(s, project) {
  const rows = [];
  const attempts = new Map();
  for (const job of jobsOf(s)) {
    const round = Number((/--round,(\d+)/.exec(job.command.join(',')) || [0, 0])[1]);
    const time = job.finished_at ? `${((Date.parse(job.finished_at) - Date.parse(job.started_at)) / 1000).toFixed(1)} s` : 'still running';
    if (job.kind === 'builder') {
      // The records of an attempt that was done again are round-NN-builder-attempt-K.json.
      const k = (attempts.get(round) || 0) + 1;
      attempts.set(round, k);
      const summary = readJson(D.audit(project, `round-0${round}-builder-attempt-${k}.json`)) || readJson(D.audit(project, `round-0${round}-builder.json`)) || {};
      rows.push({
        step: `builder, round ${round}${job.status === 'aborted' ? ' (cut off by /abort)' : ''}`, session: summary.session_id || 'unknown', turns: summary.turns ?? '?',
        cost: summary.cost_usd ?? null, time, result: summary.status || job.status,
      });
      continue;
    }
    const log = jobLog(s, job.id);
    const step = { 'goal-check': 'goal check', auditor: `auditor, round ${round}`, followup: `auditor, follow-up of round ${round}` }[job.kind] || job.kind;
    const verdict = (/: (CONTINUE|DONE|ASK_HUMAN|STOP_FOR_HUMAN) in [\d.]+s/.exec(log) || [null, null])[1];
    const finished = [...log.matchAll(/claude finished: session=(\S+), turns=(\S+), cost_usd=(\S+),/g)];
    if (!finished.length) rows.push({ step, session: 'unknown', turns: '?', cost: null, time, result: job.status === 'running' ? 'running' : `no result (exit code ${job.exit_code})` });
    finished.forEach((match, i) => rows.push({
      step: finished.length > 1 ? `${step} (reply ${i + 1} of ${finished.length})` : step,
      session: match[1],
      turns: match[2],
      cost: Number(match[3]),
      time: i === finished.length - 1 ? time : 'see the last reply',
      result: i === finished.length - 1 ? (verdict || 'no verdict') : 'reply rejected',
    }));
  }
  return rows;
}

async function main() {
  const argv = process.argv.slice(2);
  const fake = argv.includes('--fake');
  // Real calls only when they are asked for by name: an argument that is missing or
  // misspelled must never start a run that costs money.
  const overnight = argv.includes('--overnight');
  const pairAt = argv.indexOf('--pair');
  const pair = pairAt === -1 ? (overnight ? 'phase7' : 'phase4') : argv[pairAt + 1];
  const oneRound = argv.includes('--one-round');
  const SMOKE = path.join(ROOT, 'tests', 'smoke', String(pair));
  const NAME = NAMES[pair];
  const known = ['--fake', '--real', '--max-calls', '--abort-after', '--pair', '--one-round', '--overnight', '--rounds'];
  if (fake === argv.includes('--real') || argv.some((arg) => arg.startsWith('--') && !known.includes(arg)) || !NAME || !fs.existsSync(path.join(SMOKE, 'GOAL.md')) || (overnight && oneRound)) {
    console.error('Usage: node tests/run_real_loop.js --real [--max-calls <n>] [--abort-after <seconds>] [--pair <folder>] [--one-round]   (real Claude calls)\n'
      + '       node tests/run_real_loop.js --real --overnight [--rounds <n>] [--pair <folder>]                                  (Phase 7: an overnight run)\n'
      + '       node tests/run_real_loop.js --fake [the same options]                                                     (a dry run, no real call)\n'
      + `Pairs: ${Object.keys(NAMES).join(', ')} (folders under tests/smoke/).`);
    process.exitCode = 2;
    return;
  }
  const rounds = numberAfter(argv, '--rounds', 2);
  const limit = numberAfter(argv, '--max-calls', overnight ? 2 * rounds + 1 : 12);
  // How long round 1's builder runs before the owner looks at it and cuts it off.
  const abortAfterMs = numberAfter(argv, '--abort-after', fake ? 4 : 30) * 1000;
  const s = await botSandbox(null, { fakeClaude: fake, tmp: path.join(ROOT, 'tests', 'tmp', 'real-loop') });
  if (fake) {
    let plan = { auditor: ['ask', 'continue', 'continue', 'done'], builder: [{ mode: 'ok', delayMs: 60000 }, { mode: 'ok', delayMs: 3000 }, 'ok'] };
    if (oneRound) plan = { auditor: ['continue', 'continue'], builder: [{ mode: 'ok', delayMs: 3000 }] };
    if (overnight) plan = { auditor: ['continue', ...Array.from({ length: rounds }, () => 'continue')], builder: Array.from({ length: rounds }, () => ({ mode: 'ok', delayMs: 3000 })) };
    s.script(plan);
  }
  const project = path.join(s.projectsRoot, NAME);
  console.log(`${fake ? 'DRY RUN with the fake claude, no real call: loop' : 'Real loop'} on ${project}, with the pair tests/smoke/${pair}/${oneRound ? ', one round' : ''}${overnight ? `, as an overnight run of at most ${rounds} rounds` : ''}`);
  console.log(`Fake Telegram at ${s.fake.baseUrl}; the owner sends /stop once ${limit} Claude calls were started.`);

  let shown = 0;
  const show = () => {
    for (; shown < s.fake.sent.length; shown += 1) {
      const m = s.fake.sent[shown];
      // Phase 7: whether the message came with disable_notification (an overnight run's own messages).
      const sound = overnight && m.method !== 'answerCallbackQuery' ? (m.silent ? ' [silent]' : ' [with sound]') : '';
      if (m.method === 'sendMessage') {
        const buttons = m.replyMarkup ? `\n    [buttons: ${m.replyMarkup.inline_keyboard.map((row) => row.map((b) => b.text).join(' | ')).join(' / ')}]` : '';
        console.log(`\n[${clock()}] BOT${sound}\n${indent(m.text)}${buttons}`);
      } else if (m.method === 'sendDocument') {
        // The report is printed once more at the end, in full.
        const body = /LOOP_REPORT/.test(m.filename) ? `(${m.content.split('\n').length} lines, shown at the end)` : m.content.trimEnd();
        console.log(`\n[${clock()}] BOT sends the file ${m.filename} (${m.caption})${sound}\n${indent(body)}`);
      } else {
        console.log(`\n[${clock()}] BOT answers the button press: ${m.text}`);
      }
    }
  };
  const owner = (what) => console.log(`\n[${clock()}] OWNER ${what}`);
  const send = (text) => {
    owner(`sends ${text}`);
    s.fake.message(s.owner, text);
  };

  // The owner's side: what he does when a message with buttons arrives.
  const acted = new Set();
  let edited = false;
  // In an overnight run the owner presses nothing after Save, and every message
  // with buttons is written down as a wait that should not have happened.
  const waited = [];
  const react = () => {
    s.fake.sent.forEach((m, i) => {
      if (acted.has(i) || !m.replyMarkup) return;
      acted.add(i);
      const all = m.replyMarkup.inline_keyboard.flat();
      let pick;
      if (overnight && !all.some((b) => b.text === 'Save')) {
        waited.push(m.text.split('\n')[0]);
        owner(`presses nothing: a message with buttons came (${all.map((b) => b.text).join(' | ')}), and nobody presses one`);
        return;
      }
      if (/: Question \d+ of \d+ \[/.test(m.text)) pick = all.find((b) => b.text.endsWith('(recommended)')) || all[0];
      else if (oneRound && /: start the builder with this prompt\?$/.test(m.text)) pick = all.find((b) => b.text === 'Stop');
      else if (/: start the builder with this prompt\?$/.test(m.text)) pick = all.find((b) => b.text === (edited ? 'Approve' : 'Edit'));
      else if (all.some((b) => b.text === 'Confirm')) pick = all.find((b) => b.text === 'Confirm');
      else if (all.some((b) => b.text === 'Redo the round')) pick = all.find((b) => b.text === 'Redo the round');
      else pick = all.find((b) => b.text === 'Save');
      if (!pick) return;
      owner(`presses "${pick.text}"`);
      s.fake.press(s.owner, pick.callback_data);
      if (pick.text === 'Edit') {
        edited = true;
        owner(`sends the note: ${NOTE}`);
        s.fake.message(s.owner, NOTE);
      }
    });
  };

  await s.firstTick();
  owner(`sends /new ${NAME}, then tests/smoke/${pair}/GOAL.md and first-prompt.md as files`);
  s.fake.message(s.owner, `/new ${NAME}`);
  s.fake.document(s.owner, 'GOAL.md', fs.readFileSync(path.join(SMOKE, 'GOAL.md')));
  s.fake.document(s.owner, 'first-prompt.md', fs.readFileSync(path.join(SMOKE, 'first-prompt.md')));

  const started = Date.now();
  let loopSent = false;
  let stopSent = false;
  let ended = false;
  // The controls, in order: /status, /log, /abort (its Confirm is pressed by react()),
  // /resume (its "Redo the round" too). Each waits for the one before it.
  // With --one-round there are none: the round runs to its end.
  let control = oneRound || overnight ? 'done' : 'wait';
  let builderSince = null;
  while (Date.now() - started < LIMIT_MS) {
    const tick = await s.tick();
    if (tick.status !== 0 || tick.stderr) console.log(`\n[${clock()}] TICK exit ${tick.status}: ${tick.stdout.trim()} ${tick.stderr.trim()}`);
    show();
    react();
    if (!loopSent && D.said(s, /^Created /)) {
      loopSent = true;
      send(overnight ? `/overnight ${NAME} ${rounds}` : `/loop ${NAME}`);
    }
    const loop = loopSent && fs.existsSync(D.audit(project, 'loop.json')) ? D.loopState(project) : null;
    const building = loop && loop.step === 'builder' && loop.round === 1 && loop.job;
    if (overnight) {
      // nothing: the owner presses no button in an overnight run
    } else if (control === 'wait' && building) {
      if (builderSince === null) builderSince = Date.now();
      if (Date.now() - builderSince >= abortAfterMs && loop.job.sessionReported) {
        send('/status');
        control = 'status';
      }
    } else if (control === 'status') {
      send('/log');
      control = 'log';
    } else if (control === 'log') {
      send('/abort');
      control = 'abort';
    } else if (control === 'abort' && D.said(s, /: the loop ended\. Aborted by you/)) {
      section('right after /abort: git status --short, git log --oneline, git stash list',
        [D.git(project, 'status', '--short') || '(clean)', '---', D.git(project, 'log', '--oneline'), '---', D.git(project, 'stash', 'list') || '(no stash)'].join('\n'));
      send(`/resume ${NAME}`);
      control = 'resume';
    } else if (control === 'resume' && D.said(s, /: the round runs again with the same prompt/)) {
      section('right after "Redo the round": git stash list, and what the stash holds',
        [D.git(project, 'stash', 'list') || '(no stash)', '--- the untracked files in it (git show --stat stash@{0}^3):', D.git(project, 'show', '--stat', '--format=', 'stash@{0}^3') || '(none)',
          '--- the changes to tracked files in it (git stash show --stat):', D.git(project, 'stash', 'show', '--stat') || '(none)'].join('\n'));
      control = 'done';
    }
    // The abort ends the loop too: that end is not the end of the run. An end while the
    // controls never started ("wait") means the builder was done before the owner looked.
    if (loopSent && ['wait', 'done'].includes(control) && s.state().loop === null && D.endMessage(s) && !/Aborted by you/.test(D.endMessage(s))) {
      ended = true;
      break;
    }
    if (loopSent && !stopSent && jobsOf(s).length >= limit) {
      stopSent = true;
      owner(`sends /stop: ${limit} Claude calls were started`);
      s.fake.message(s.owner, '/stop');
    }
    await D.sleep(TICK_MS);
  }
  // What was still waiting to be sent (the report, the file after a round cap).
  for (let i = 0; i < 3; i += 1) {
    await s.tick();
    show();
  }
  if (!ended) console.log(`\nThe loop did not end within ${LIMIT_MS / 60000} minutes.`);

  const auditFile = (name) => (fs.existsSync(D.audit(project, name)) ? D.readAudit(project, name).trimEnd() : '(not there)');
  section('.audit\\loop.log', auditFile('loop.log'));
  section('.audit\\LOOP_REPORT.md', auditFile('LOOP_REPORT.md'));
  section('.audit\\DECISIONS.md', auditFile('DECISIONS.md'));
  const names = fs.existsSync(path.join(project, '.audit')) ? fs.readdirSync(path.join(project, '.audit')).sort() : [];
  for (const name of names.filter((n) => /verdict\.json$/.test(n))) {
    const v = readJson(D.audit(project, name)) || {};
    section(`.audit\\${name}`, [
      `VERDICT: ${v.verdict}   (round ${v.round}, kind ${v.kind}, ${v.duration_s}s, ${v.usage ? `${v.usage.turns} turns, $${v.usage.cost_usd}` : 'no usage'})`,
      `REASON: ${v.reason}`,
      'FINDINGS:',
      ...((v.findings || []).length ? v.findings.map((f) => `- ${f}`) : ['- none']),
      ...((v.questions || []).flatMap((q) => [`QUESTION ${q.n}. [${q.tag}] ${q.question}`, `   options: ${q.options.join(' | ')}`, `   recommended: ${q.recommended}`])),
      'NEXT_PROMPT:',
      indent(v.next_prompt || ''),
    ].join('\n'));
  }
  section('git log --oneline', D.git(project, 'log', '--oneline') || '(no commits)');
  section('git stash list', D.git(project, 'stash', 'list') || '(no stash)');
  section('git status --porcelain', D.git(project, 'status', '--porcelain') || '(clean)');
  section('files in .audit\\', names.join('\n'));
  for (const name of names.filter((n) => /builder(-attempt-\d+)?\.json$/.test(n))) {
    const b = readJson(D.audit(project, name)) || {};
    section(`.audit\\${name}`, [
      `status ${b.status}, exit code ${b.exit_code}, ${b.turns} turns, cost $${b.cost_usd}, ${b.duration_s} s`,
      `session ${b.session_id}, model ${b.model}, context peak ${b.context && b.context.peak_tokens} tokens (${b.context && b.context.peak_percent}%), compacted: ${b.compacted}`,
      `handoff_written: ${b.handoff_written}, tools: ${(b.tools || []).join(' ')}, MCP servers: ${(b.mcp_servers || []).length}`,
      `denied tool calls: ${(b.permission_denials || []).length}`,
      ...(b.permission_denials || []).map((d) => `  ${d.tool} ${d.input}`),
    ].join('\n'));
  }
  // What the auditor ran itself: its Bash commands are in the job's log.
  for (const job of jobsOf(s).filter((j) => j.kind !== 'builder')) {
    const ran = jobLog(s, job.id).split('\n').filter((line) => /^\[run_auditor\] (bash|denied): /.test(line));
    if (ran.length) section(`job ${job.id} (${job.kind}): the commands the auditor ran`, ran.join('\n'));
  }

  const calls = claudeCalls(s, project);
  section(fake ? 'every call of the fake claude' : 'every real Claude call', [
    '# | step | session | turns | cost | time | result',
    ...calls.map((c, i) => `${i + 1} | ${c.step} | ${c.session} | ${c.turns} | ${c.cost === null ? '?' : `$${c.cost.toFixed(4)}`} | ${c.time} | ${c.result}`),
    `${calls.length} calls, $${calls.reduce((sum, c) => sum + (c.cost || 0), 0).toFixed(4)} in all (a call that was cut off has no cost on record)`,
  ].join('\n'));

  // Phase 7: what an overnight run must show.
  if (overnight) {
    const loop = fs.existsSync(D.audit(project, 'loop.json')) ? D.loopState(project) : {};
    const roundsRun = Object.keys(loop.rounds || {}).map(Number).sort((a, b) => a - b);
    const approved = roundsRun.filter((n) => n > 1).map((n) => `round ${n}: approvedBy ${(loop.rounds[n].prompt || {}).approvedBy || 'none'}, edits ${(loop.rounds[n].prompt || {}).edits}`);
    const startIndex = s.fake.sent.findIndex((m) => m.method === 'sendMessage' && /: the overnight run started/.test(m.text));
    const run = s.fake.sent.slice(startIndex + 1).filter((m) => m.method !== 'answerCallbackQuery');
    const loud = run.filter((m) => !m.silent);
    const report = fs.existsSync(D.audit(project, 'LOOP_REPORT.md')) ? D.readAudit(project, 'LOOP_REPORT.md') : '';
    const sections = ['## Overnight items', '## Open questions', '## Left for your review'].map((title) => `${title}: ${report.includes(`\n${title}\n`) ? 'yes' : 'NO'}`);
    const materialOf = (n) => {
      const job = jobsOf(s).find((j) => j.kind === 'auditor' && /--round,(\d+)/.exec(j.command.join(','))?.[1] === String(n));
      return job ? jobLog(s, job.id) : '';
    };
    section('the overnight run: what it must show', [
      `Steps that waited for a button: ${waited.length ? waited.join('; ') : 'none'}`,
      `Mode in loop.json: ${loop.mode}; cap ${loop.cap}; overnight record: ${JSON.stringify(loop.overnight)}`,
      `Prompt records: ${approved.join('; ') || '(no round after 1)'}`,
      `Messages and files of the run (after the start message): ${run.length}, silent: ${run.length - loud.length}, with sound: ${loud.length}${loud.length ? ` (${loud.map((m) => (m.text || m.filename).split('\n')[0]).join(' | ')})` : ''}`,
      `Report sections: ${sections.join(', ')}`,
      `Open questions in loop.json: ${(loop.openQuestions || []).filter((q) => !q.answer).length}`,
      `The audit of round 2 (job log, first lines): ${materialOf(2).split('\n').slice(0, 2).join(' | ') || '(none)'}`,
    ].join('\n'));
  }

  // The same search as in the unit tests: the fake token must be nowhere.
  const key = s.token.slice(s.token.indexOf(':') + 1);
  const needles = [s.token, key, encodeURIComponent(s.token)];
  const searched = [...filesUnder(s.runtimeDir), ...filesUnder(project).filter(({ file }) => !file.includes(`${path.sep}.git${path.sep}`))];
  const hits = [
    ...s.outputs.filter((text) => needles.some((needle) => text.includes(needle))).map((_, i) => `output ${i}`),
    ...searched.filter(({ text }) => needles.some((needle) => text.includes(needle))).map(({ file }) => file),
  ];
  section('summary', [
    `The loop ${ended ? 'ended' : 'did NOT end'} after ${Math.round((Date.now() - started) / 1000)} s.`,
    `The controls got as far as: ${control}.`,
    `The bot sent ${s.fake.sent.filter((m) => m.method === 'sendMessage').length} messages, ${s.fake.sent.filter((m) => m.method === 'sendDocument').length} files `
      + `and ${s.fake.sent.filter((m) => m.method === 'answerCallbackQuery').length} button answers, all to the fake server.`,
    `Token search: ${s.outputs.length} outputs and ${searched.length} files searched for 3 forms of the fake token, ${hits.length} hits.`,
    `Everything is kept in ${s.dir}`,
  ].join('\n'));

  await s.fake.close();
  process.exitCode = ended ? 0 : 1;
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
