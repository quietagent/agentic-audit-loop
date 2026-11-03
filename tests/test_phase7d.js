'use strict';

// Phase 7d: the texts of this round. Rule 15 and the registry in README; the round size in
// templates/GOAL.template.md and AUDITOR.md; and overnight texts that say nothing about night
// or sleep: the owner starts /overnight at any time of day, and it only means "no Approve,
// nobody answers". The names /overnight, "overnight run" and "morning report" stay.
// The launcher's lock is tested in test_launcher.js, the material's OVERNIGHT RUN block and
// the (open) answer line in test_phase7.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const section = (text, heading) => text.split(`\n${heading}\n`)[1].split(/\n## /)[0];
// Wording that assumes the owner sleeps, or greets him with a time of day.
const NIGHT = /\b(is asleep|are asleep|sleeps|sleeping|at night|tonight|before he sleeps|in the morning|to the morning(?! report)|good (morning|evening|night)|goodnight)\b/i;

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(file);
    return entry.name.endsWith('.js') ? [file] : [];
  });
}

test('README: rule 15, the registry lines under "How this repo keeps them", and the pointer in "Home PC setup"', () => {
  const readme = read('README.md');
  const sharing = section(readme, '## Sharing this PC with the email-assistant n8n');
  assert.ok(sharing.includes('\n15. **`C:\\Projects\\SERVERS-STANDARD.md` is binding for every project on this PC.** A server\'s row is added to Part A as `planned` before its build prompt is written.'), 'rule 15');
  assert.ok(sharing.includes('copy the old text to `C:\\Projects\\SERVERS-STANDARD.history\\SERVERS-STANDARD.<yyyy-mm-dd_HHmm>.md` and bump "Last updated". Agreed 2026-10-16 (Discussion round 7, MSG 0020–0025).'));
  const rules = sharing.split('\nHow this repo keeps them:\n');
  assert.ok(rules[0].indexOf('\n14. ') < rules[0].indexOf('\n15. '), 'rule 15 comes after rule 14');
  assert.match(rules[1], /\n- The loop's n8n has its row in Part A of `C:\\Projects\\SERVERS-STANDARD\.md` and owns ports 5690–5699 \(rule 15\)\.\n/);
  assert.match(rules[1], /\n- The builder runs `--restricted` and cannot read the registry, so a project's GOAL\.md restates the PC rules a build must follow; `C:\\Projects\\check-servers\.cmd` lists what listens and flags ports not in Part A \(rule 15\)\.\n/);
  const home = readme.split('\n## Home PC setup (Phase 2)\n\n')[1];
  assert.ok(home.startsWith('The registry of every background server on this PC is `C:\\Projects\\SERVERS-STANDARD.md` (rule 15'), home.slice(0, 120));
  assert.match(readme, /is Phase 8's \(the owner may not build it; planning happens in chat\)\./);
});

test('the round size: the placeholder line in GOAL.md\'s Constraints, and AUDITOR.md follows it in "Writing NEXT_PROMPT" and in an overnight run', () => {
  const template = read('templates', 'GOAL.template.md');
  assert.deepEqual(section(template, '## Constraints').split('\n').filter(Boolean), [
    '<Stack, folders, things not to touch, rules to follow.>',
    '<Round size: "Each round builds two or three items. Never two heavy items in one round: a round is one fresh session, and its context must stay well under 80%.">',
  ]);
  assert.match(section(template, '## Overnight'), /that an overnight run \(\/overnight\) may build with no review \(the run can be started at any time of day; it only means no Approve\):/);

  const auditor = read('AUDITOR.md');
  assert.ok(section(auditor, '## Writing NEXT_PROMPT').includes('\n- One focused step — or two or three items when GOAL.md\'s Constraints set a round size; never two heavy items in one round (a round is one fresh session; its context must stay well under 80%). Fix this audit\'s findings first, then the next unfinished definition-of-done item.\n'));
  const overnight = section(auditor, '## Overnight runs');
  assert.ok(overnight.startsWith('When the material has an OVERNIGHT RUN block, the owner started this loop with /overnight. The owner does not review rounds during this run and answers no question while it runs; he may be awake or asleep. The loop approves every NEXT_PROMPT you write'), overnight.slice(0, 200));
  assert.match(overnight, /\n- NEXT_PROMPT builds one overnight item at a time, or a smaller step of one, or two or three items when GOAL\.md's Constraints set a round size \(never two heavy ones\), in the order they stand in the section/);
  // Every other rule of the section stays: the MUST, (open) and goal-check lines are still there.
  for (const rule of ['A DEFAULT question is answered with your recommended option at once', 'An answer marked "(open)" in DECISIONS.md is a MUST question nobody has answered yet. Never guess it.', 'In a goal check of an overnight run, also check', 'Every other rule stays as it is']) {
    assert.ok(overnight.includes(rule), rule);
  }
});

test('no overnight text assumes the owner sleeps or greets him with a time of day: AUDITOR.md, README, the template and every script', () => {
  const texts = [
    ['AUDITOR.md', read('AUDITOR.md')],
    ['README.md', read('README.md')],
    ['templates/GOAL.template.md', read('templates', 'GOAL.template.md')],
    ...jsFiles(path.join(ROOT, 'scripts')).map((file) => [path.relative(ROOT, file), fs.readFileSync(file, 'utf8')]),
  ];
  const found = texts.flatMap(([name, text]) => text.split('\n').map((line, i) => [name, i + 1, line]))
    // README keeps the old wordings where it says what they were until Phase 7c.
    .filter(([name, , line]) => NIGHT.test(line) && !(name === 'README.md' && /until (Phase 7c|then) it said/.test(line)));
  assert.deepEqual(found.map(([name, n, line]) => `${name}:${n}: ${NIGHT.exec(line)[0]}`), []);
  // The names stay.
  assert.match(read('README.md'), /### The morning report\n/);
  assert.match(read('scripts', 'lib', 'loop_messages.js'), /The overnight run starts round/);
});
