'use strict';

// Writes the owner's answers to the auditor's questions into
// <project>/.audit/DECISIONS.md, in the shape of templates/DECISIONS.template.md.
// The auditor gets the file in every audit; it counts as part of GOAL.md.
//
// Marks (the word in brackets after an answer):
//   answered   the owner chose it
//   assumed    nobody answered in time, so the recommended option was used (Phase 4)
//   open       a MUST question of an overnight run that nobody has answered yet (Phase 7):
//              the run does not wait for the owner. The answer line says to build another
//              overnight item that does not depend on it. The owner's answer later replaces
//              the line. Open entries are found by the mark, not by the answer's text, so
//              entries written with an earlier text (Phase 7 to 7c) count too.

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic, localStamp } = require('./runtime');

const TEMPLATE = path.resolve(__dirname, '..', '..', 'templates', 'DECISIONS.template.md');
// The answer line of an open question, before the mark.
const OPEN_ANSWER = 'not answered yet, the overnight run does not wait for the owner; build another overnight item that does not depend on it';

const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim();
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The head of a new file: the template up to its first "## " section.
function header() {
  return fs.readFileSync(TEMPLATE, 'utf8').split(/^## /m)[0];
}

const decisionsFile = (project) => path.join(project, '.audit', 'DECISIONS.md');

// The file's time is moved past `newerThan` when the clock's steps are too coarse:
// run_auditor.js runs a follow-up only when the file was modified after the ASK_HUMAN verdict.
function bumpAfter(file, newerThan) {
  const floor = newerThan ? Date.parse(newerThan) : NaN;
  if (!Number.isNaN(floor) && fs.statSync(file).mtimeMs <= floor) {
    const later = new Date(floor + 1000);
    fs.utimesSync(file, later, later);
  }
}

// Adds one section to DECISIONS.md and returns { file, section }.
//   title      "Goal check" or "Round 2"
//   answers    [{ question, answer, mark }]; mark is "answered" (the owner chose it),
//              "assumed" (nobody answered in time: Phase 4), or "open" (an overnight
//              run left it for later: Phase 7; the answer text is then OPEN_ANSWER)
//   newerThan  an ISO time; see bumpAfter().
function appendDecisions(project, { title, answers, date = localStamp().slice(0, 10), newerThan = null }) {
  const file = decisionsFile(project);
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : header();
  const section = [
    `## ${title}, ${date}`,
    ...answers.flatMap(({ question, answer, mark = 'answered' }) => [`- Q: ${oneLine(question)}`, `  A: ${mark === 'open' ? OPEN_ANSWER : oneLine(answer)} (${mark})`]),
  ].join('\n');
  writeFileAtomic(file, `${before.replace(/\s+$/, '')}\n\n${section}\n`);
  bumpAfter(file, newerThan);
  return { file, section };
}

// The owner answered a question that was left open: its "(open)" answer line becomes
// the answer, marked "(answered)". Returns { file, replaced }: replaced is false when
// no open entry with that question is in the file (then nothing is written, and the
// caller may add a section with appendDecisions instead).
function answerOpenQuestion(project, { question, answer, mark = 'answered', newerThan = null }) {
  const file = decisionsFile(project);
  if (!fs.existsSync(file)) return { file, replaced: false };
  const text = fs.readFileSync(file, 'utf8');
  const entry = new RegExp(`^(- Q: ${escape(oneLine(question))}\\r?\\n {2}A: )[^\\n]*\\(open\\)[ \\t]*$`, 'm');
  if (!entry.test(text)) return { file, replaced: false };
  writeFileAtomic(file, text.replace(entry, (whole, head) => `${head}${oneLine(answer)} (${mark})`));
  bumpAfter(file, newerThan);
  return { file, replaced: true };
}

// The questions of the file whose answer is still "(open)": [{ question }].
function openEntries(project) {
  const file = decisionsFile(project);
  if (!fs.existsSync(file)) return [];
  const found = [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const q = /^- Q: (.+)$/.exec(lines[i]);
    if (q && /^ {2}A: .*\(open\)\s*$/.test(lines[i + 1])) found.push({ question: q[1] });
  }
  return found;
}

module.exports = { appendDecisions, answerOpenQuestion, openEntries, header, oneLine, OPEN_ANSWER };
