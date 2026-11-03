'use strict';

// The overnight run (Phase 7): what lib/loop.js needs to run rounds back to back
// without the owner's Approve, on the items of GOAL.md's "## Overnight" section only.
// Nothing in here sends anything or changes the loop: these are the readers and the
// rules. The state machine stays in lib/loop.js.
//
//   GOAL.md       overnightSection(), definitionOfDone(), reviewItems()
//   /overnight    parseRounds(), ROUNDS_MAX
//   the 7-day     sevenDayShare(), sevenDayCheck()
//   long pauses   longPause()
//   the report    reportLines()

const M = require('./loop_messages');

const ROUNDS_MAX = 30;
const OVERNIGHT_HEADING = /^##\s+Overnight\s*$/i;
const DONE_HEADING = /^##\s+Definition of done\s*$/i;
// "- [ ] text", "- [x] text" or "- text": the text.
const ITEM = /^\s*[-*]\s+(?:\[[ xX]\]\s*)?(\S.*?)\s*$/;

const isOvernight = (loop) => Boolean(loop && loop.mode === 'overnight');

// The body of the first "## <heading>" section of a Markdown text: the lines after the
// heading up to the next "#"-heading of level 1 or 2. { present, body }.
function sectionOf(text, heading) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return { present: false, body: '' };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##? /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { present: true, body: lines.slice(start + 1, end).join('\n').replace(/\s+$/, '') };
}

// The list items of a section's body, without their checkbox: ["text", ...].
function itemsOf(body) {
  return String(body || '').split('\n').map((line) => ITEM.exec(line)).filter(Boolean).map((m) => m[1]);
}

// One item as it stands, for a word-for-word comparison: one space between words.
const sameWords = (text) => M.oneLine(text);

// GOAL.md's "## Overnight" section: { present, body, items, lines }. lines are the
// items as they stand in the file ("- [ ] ...").
function overnightSection(goal) {
  const section = sectionOf(goal, OVERNIGHT_HEADING);
  const lines = section.body.split('\n').filter((line) => ITEM.test(line)).map((line) => line.trim());
  return { present: section.present, body: section.body, items: itemsOf(section.body), lines };
}

// GOAL.md's "## Definition of done" section, the same way.
function definitionOfDone(goal) {
  const section = sectionOf(goal, DONE_HEADING);
  const lines = section.body.split('\n').filter((line) => ITEM.test(line)).map((line) => line.trim());
  return { present: section.present, body: section.body, items: itemsOf(section.body), lines };
}

// What is left for the owner's review: the definition-of-done items that are not in
// "## Overnight". An item that stands in both sections word for word counts as
// overnight. When the items cannot be told apart (no list in the definition of done),
// the whole section is left for review: { lines, whole, body, present }.
function reviewItems(goal) {
  const done = definitionOfDone(goal);
  const overnight = new Set(overnightSection(goal).items.map(sameWords));
  if (!done.present) return { present: false, whole: false, lines: [], body: '' };
  if (!done.items.length) return { present: true, whole: true, lines: [], body: done.body };
  const lines = done.lines.filter((line) => !overnight.has(sameWords(ITEM.exec(line)[1])));
  return { present: true, whole: false, lines, body: done.body };
}

// The <rounds> of "/overnight <name> <rounds>": a whole number from 1 to 30, or null.
function parseRounds(text) {
  if (!/^\d{1,2}$/.test(String(text || '').trim())) return null;
  const n = Number(text);
  return n >= 1 && n <= ROUNDS_MAX ? n : null;
}

// The share of the 7-day window that a rate_limit record says is used (0 to 1), or null.
function sevenDayShare(usage) {
  const window = usage && typeof usage === 'object' ? usage.seven_day : null;
  return window && Number.isFinite(window.utilization) ? window.utilization : null;
}

// null when an overnight round may start, else { share, percent, resetsAt, seenAt }:
// the 7-day window is at `limitPercent` or above. With no usage seen, the round runs.
function sevenDayCheck(usage, limitPercent) {
  const share = sevenDayShare(usage);
  if (share === null || share * 100 < limitPercent) return null;
  return { share, percent: Math.round(share * 100), resetsAt: usage.seven_day.resets_at || null, seenAt: usage.seen_at || null };
}

// A usage-limit pause that an overnight run does not wait out: the limit is the 7-day
// one, or its reset time is more than `hours` away. Returns null, 'seven_day' or 'far'.
function longPause({ type, resetMs, nowMs, hours }) {
  if (type === 'seven_day') return 'seven_day';
  if (Number.isFinite(resetMs) && resetMs - nowMs > hours * 3600000) return 'far';
  return null;
}

// What /resume does after an end, for the refusal of /overnight: the owner sends /resume first.
function resumeDoes(plan) {
  switch (plan && plan.how) {
    case 'new-prompt': return 'it asks you for the next round\'s prompt';
    case 'choice': return 'it asks what to do with the round that was cut off';
    case 'questions':
    case 'ask': return 'it asks the open questions again';
    case 'proposal': return 'it brings the proposed prompt back';
    default: return 'it runs the step that did not end again';
  }
}

// ---- the morning report ----

const stamp = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? require('./runtime').localStamp(new Date(iso)) : 'unknown');

// The lines of LOOP_REPORT.md that an overnight run adds: the line at the top, and the
// three sections. goal is the text of GOAL.md. { top: [...], sections: [...] }.
function reportLines(loop, goal) {
  const run = loop.overnight;
  if (!run) return { top: [], sections: [] };
  const end = loop.end || {};
  const lastRound = Number.isInteger(run.lastRound) ? run.lastRound : loop.round;
  const count = Math.max(0, lastRound - (run.fromRound || 0));
  const how = run.how || M.oneLine(end.why) || 'not ended yet';
  const top = [`- Overnight run: started ${stamp(run.startedAt)}, ended ${run.endedAt ? stamp(run.endedAt) : 'not yet'}, ${M.plural(count, 'round')} (cap ${run.cap}): ${how}`];
  for (const earlier of loop.overnightRuns || []) {
    top.push(`  - An earlier overnight run: started ${stamp(earlier.startedAt)}, ended ${stamp(earlier.endedAt)}, `
      + `${M.plural(Math.max(0, (earlier.lastRound || 0) - (earlier.fromRound || 0)), 'round')} (cap ${earlier.cap}): ${earlier.how || 'unknown'}`);
  }

  const sections = ['', '## Overnight items', ''];
  const overnight = overnightSection(goal);
  if (!overnight.present) sections.push('GOAL.md has no "## Overnight" section.');
  else if (!overnight.lines.length) sections.push('The "## Overnight" section of GOAL.md has no item.');
  else sections.push(...overnight.lines);
  const verdict = loop.lastVerdict;
  if (verdict && verdict.kind !== 'goal-check') {
    sections.push('', `The last verdict (round ${verdict.round}): ${verdict.verdict}. ${M.oneLine(verdict.reason)}`);
    if (verdict.verdict === 'DONE') sections.push(`Summary: ${M.oneLine(verdict.next_prompt)}`);
    else {
      const findings = Array.isArray(verdict.findings) ? verdict.findings : [];
      sections.push(findings.length ? 'Findings:' : 'Findings: none.', ...findings.map((finding) => `- ${M.oneLine(finding)}`));
    }
  } else {
    sections.push('', 'No round has a verdict yet.');
  }

  sections.push('', '## Open questions', '');
  const open = (loop.openQuestions || []).filter((q) => !q.answer);
  if (!open.length) sections.push('None.');
  for (const q of open) {
    sections.push(`- Round ${q.round}, question ${q.n} [${q.tag}]: ${M.oneLine(q.question)}`, `  options: ${q.options.join(' | ')}`, `  recommended: ${q.recommended}`);
  }
  if (open.length) sections.push('', `/resume ${loop.name} asks ${open.length === 1 ? 'it' : 'them'} again before it goes on.`);

  sections.push('', '## Left for your review', '');
  const review = reviewItems(goal);
  if (!review.present) sections.push('GOAL.md has no "## Definition of done" section.');
  else if (review.whole) sections.push('The definition of done has no list of items, so the whole section is for your review:', '', review.body || '(empty)');
  else if (!review.lines.length) sections.push('Nothing: every item of the definition of done is in "## Overnight".');
  else sections.push(...review.lines);
  return { top, sections };
}

module.exports = {
  isOvernight, sectionOf, itemsOf, overnightSection, definitionOfDone, reviewItems, parseRounds, sevenDayShare, sevenDayCheck, longPause,
  resumeDoes, reportLines, ROUNDS_MAX,
};
