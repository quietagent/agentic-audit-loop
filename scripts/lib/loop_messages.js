'use strict';

// The texts and buttons of the loop's messages. Every message names the project
// and the round. Nothing in here sends anything or changes the loop.

const path = require('node:path');
const { inlineKeyboard } = require('./telegram');
const { localStamp } = require('./runtime');

const FINDINGS_SHOWN = 10;
const BUTTON_TEXT_MAX = 60;

const pad = (n) => String(n).padStart(2, '0');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

// "Demo, round 2 of 3" or "Demo, goal check": the start of a message.
function label(loop, round = loop.round) {
  return round > 0 ? `${loop.name}, round ${round} of ${loop.cap}` : `${loop.name}, goal check`;
}

// What the job of a step is, in words.
function jobWords(kind) {
  return { 'goal-check': 'goal check', builder: 'builder', auditor: 'auditor', followup: 'auditor (follow-up)' }[kind] || kind;
}

// ---- times ----

// A time for a message, on the PC's clock: "15:47", or with the date when it is not today.
function when(time, now = Date.now()) {
  const at = typeof time === 'number' ? time : Date.parse(time);
  if (Number.isNaN(at)) return 'an unknown time';
  const stamp = localStamp(new Date(at));
  return stamp.slice(0, 10) === localStamp(new Date(now)).slice(0, 10) ? stamp.slice(11, 16) : stamp.slice(0, 16);
}

// "45 s", "12 min", "3 h 5 min"
function span(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// ---- the builder's numbers ----

// What the loop keeps of a builder round, from the summary that run_builder.js wrote.
// record is the job's record: it explains a round that left no summary.
function builderInfo(summary, record) {
  if (!summary || summary.status === 'running') {
    let printed = null;
    try {
      printed = JSON.parse(record.stdout);
    } catch {
      // nothing usable was printed
    }
    return {
      status: summary ? 'crashed' : 'error',
      error: (printed && printed.error) || record.error
        || `the builder's runner ended with exit code ${record.exit_code} and left no result`,
      handoff_written: false,
      session_id: summary ? summary.session_id || null : null,
      turns: null,
      cost_usd: null,
      peak_percent: null,
      peak_tokens: null,
      compactions: 0,
      denials: 0,
      duration_s: null,
    };
  }
  const context = summary.context || {};
  return {
    status: summary.status,
    error: summary.error || null,
    handoff_written: summary.handoff_written === true,
    session_id: summary.session_id || null,
    turns: summary.turns ?? null,
    cost_usd: Number.isFinite(summary.cost_usd) ? summary.cost_usd : null,
    peak_percent: context.peak_percent ?? null,
    peak_tokens: context.peak_tokens ?? null,
    compactions: Array.isArray(summary.compactions) ? summary.compactions.length : 0,
    denials: Array.isArray(summary.permission_denials) ? summary.permission_denials.length : 0,
    duration_s: summary.duration_s ?? null,
  };
}

const STATUS_WORDS = {
  completed: 'completed',
  max_turns: 'stopped at the turn limit',
  error: 'claude reported an error',
  crashed: 'claude ended without a result',
  usage_limit: 'stopped by the usage limit',
  aborted: 'cut off by /abort',
  cut_off: 'cut off',
  running: 'cut off',
};

// "Builder: completed, 9 turns, $0.0690, context peak 1.1%, not compacted, 1 denied call"
function builderLine(info) {
  const peak = info.peak_percent !== null
    ? `${info.peak_percent}%`
    : `${Number(info.peak_tokens || 0).toLocaleString('en-US')} tokens (window unknown)`;
  return [
    `Builder: ${STATUS_WORDS[info.status] || info.status}`,
    info.turns === null ? 'turns unknown' : plural(info.turns, 'turn'),
    info.cost_usd === null ? 'cost unknown' : `$${info.cost_usd.toFixed(4)}`,
    `context peak ${peak}`,
    info.compactions ? `compacted ${plural(info.compactions, 'time')}` : 'not compacted',
    plural(info.denials, 'denied call'),
  ].join(', ');
}

// One line when a round filled its context: at warnPercent or more, or compacted.
// null for a round that did neither.
function contextWarning(info, warnPercent) {
  const high = info.peak_percent !== null && info.peak_percent >= warnPercent;
  if (!high && !info.compactions) return null;
  const what = [
    ...(high ? [`used ${info.peak_percent}% of its context window (a warning starts at ${warnPercent}%)`] : []),
    ...(info.compactions ? [`was compacted ${plural(info.compactions, 'time')}${high ? '' : `, at a context peak of ${info.peak_percent ?? '?'}%`}`] : []),
  ].join(' and ');
  return `WARNING: the builder's round ${what}. The round was too big: the auditor was told, and is to make the next step smaller.`;
}

function sessionLines(loop, info) {
  if (!info || !info.session_id) return ['Session: unknown'];
  return [`Session: ${info.session_id}`, `To take it over on the PC, run this in ${loop.project}:`, `claude --resume ${info.session_id}`];
}

function commitLine(roundData, round) {
  if (!roundData || !roundData.commit) return 'Commit: none, the round changed no file that git tracks';
  return `Commit: ${roundData.commit} "Loop: round ${round}${roundData.cutOff ? ' (cut off)' : ''}"`;
}

function findingLines(findings) {
  if (!Array.isArray(findings) || !findings.length) return ['Findings: none'];
  const lines = ['Findings:', ...findings.slice(0, FINDINGS_SHOWN).map((finding) => `- ${oneLine(finding)}`)];
  if (findings.length > FINDINGS_SHOWN) lines.push(`and ${findings.length - FINDINGS_SHOWN} more`);
  return lines;
}

function verdictLines(verdict) {
  return [`Verdict: ${verdict.verdict}`, `Reason: ${oneLine(verdict.reason)}`, ...findingLines(verdict.findings)];
}

// Everything about one round: the verdict, the builder's numbers, the session, the commit.
function roundLines(loop, round) {
  const data = loop.rounds[round] || {};
  return [
    ...(data.verdict ? verdictLines(data.verdict) : []),
    ...(data.builder ? [builderLine(data.builder), ...sessionLines(loop, data.builder)] : []),
    commitLine(data, round),
  ];
}

// The warning line of a round, with the project and the round in front, or nothing.
function warningLines(loop, round) {
  const data = loop.rounds[round] || {};
  return data.warning ? [`${label(loop, round)}: ${data.warning}`] : [];
}

// The message of a round that ends with CONTINUE below the cap. The proposal follows as a file.
// overnight (Phase 7): the loop approves the prompt itself, so no button is offered.
function roundMessage(loop, round, { overnight = false } = {}) {
  return [
    ...warningLines(loop, round),
    `${label(loop, round)}: audited.`,
    ...roundLines(loop, round),
    overnight
      ? `Next: the auditor's prompt for round ${round + 1} follows as a file. The overnight run starts round ${round + 1} with it now, without your Approve.`
      : `Next: the auditor's prompt for round ${round + 1} follows as a file. Approve starts round ${round + 1} with it, Edit changes it, Stop ends the loop.`,
  ].join('\n');
}

// ---- questions ----

function questionText(loop, questions, item) {
  return [
    `${label(loop, questions.round)}: Question ${item.n} of ${questions.items.length} [${item.tag}]`,
    oneLine(item.question),
    '',
    ...item.options.map((option, i) => `${i + 1}. ${option}${option === item.recommended ? ' (recommended)' : ''}`),
  ].join('\n');
}

// One button per option, the recommended one marked, then "Other (type it)".
// The button's data holds the option's number, not its text: Telegram allows 64 bytes.
function questionKeyboard(loop, item) {
  const rows = item.options.map((option, i) => {
    const mark = option === item.recommended ? ' (recommended)' : '';
    const room = BUTTON_TEXT_MAX - mark.length - 3;
    const shown = option.length > room ? `${option.slice(0, room - 3)}...` : option;
    return [{ text: `${i + 1}. ${shown}${mark}`, data: `lq:${loop.id}:${item.buttonId}:${i}` }];
  });
  rows.push([{ text: 'Other (type it)', data: `lq:${loop.id}:${item.buttonId}:o` }]);
  return inlineKeyboard(rows);
}

function proposalKeyboard(loop) {
  const data = (action) => `lp:${loop.id}:${loop.proposal.buttonId}:${action}`;
  return inlineKeyboard([[{ text: 'Approve', data: data('a') }, { text: 'Edit', data: data('e') }, { text: 'Stop', data: data('s') }]]);
}

// ---- a builder that was cut off ----

const CUT_OFF_WORDS = {
  aborted: 'you ended it with /abort',
  lost: 'its process is gone and its record has no end, as after a restart of the PC',
  'usage-limit': 'the plan\'s usage limit stopped it in the middle of its round',
  refused: 'the builder\'s runner refused to start',
  'not-committed': 'the round ran, and the loop did not commit it',
};

function choiceKeyboard(loop) {
  const data = (action) => `lc:${loop.id}:${loop.choice.buttonId}:${action}`;
  return inlineKeyboard([[{ text: 'Redo the round', data: data('r') }, { text: 'Keep and audit', data: data('k') }, { text: 'Stop', data: data('s') }]]);
}

// The question after a builder was cut off: what the round left, and the three ways on.
// status is { lines, more } of "git status --short".
function cutOffText(loop, choice, status, intro = []) {
  const round = choice.round;
  return [
    ...intro,
    `${label(loop, round)}: the builder was cut off (${CUT_OFF_WORDS[choice.reason] || choice.reason}). Nothing was committed.`,
    ...(status.lines.length
      ? ['What the round left (git status --short):', ...status.lines, ...(status.more ? [`and ${status.more} more`] : [])]
      : ['What the round left: nothing. The working tree is clean.']),
    'Redo the round: the partial work is put aside with git stash (never deleted), and the builder runs again with the same prompt.',
    `Keep and audit: what is there is committed as "Loop: round ${round} (cut off)" and audited.`,
    'Stop: the loop ends, and nothing changes.',
  ].join('\n');
}

function abortKeyboard(loop) {
  const data = (action) => `la:${loop.id}:${loop.abort.buttonId}:${action}`;
  return inlineKeyboard([[{ text: 'Confirm', data: data('y') }, { text: 'Cancel', data: data('n') }]]);
}

// ---- the proposed prompt ----

const NOTE_HEADING = '## Note from the owner (it takes priority over the rest of this prompt)';
const PROMPT_HEADING = '## The prompt for this round';

// The proposal as the builder will get it: the owner's notes on top, then the prompt.
function withNotes(notes, base) {
  if (!notes.length) return base;
  const body = notes.length === 1 ? notes[0] : notes.map((note, i) => `Note ${i + 1}:\n${note}`).join('\n\n');
  return `${NOTE_HEADING}\n\n${body}\n\n${PROMPT_HEADING}\n\n${base}`;
}

function proposalFiles(loop, round) {
  const file = (suffix) => path.join(loop.project, '.audit', `round-${pad(round)}-prompt-${suffix}.md`);
  return {
    auditor: file('auditor'),
    owner: file('owner'),
    proposed: file('proposed'),
    edit: (k) => file(`edit-${k}`),
    sentAs: `${loop.name}-round-${pad(round)}-prompt.md`,
  };
}

// ---- the end of a loop ----

function recordsLine(loop) {
  return `Records: ${path.join(loop.project, '.audit')} (loop.log, loop.json and the round-NN-* files)`;
}

// tail: lines after the records, for example the one that says test settings are on.
function endText(loop, why, lines = [], tail = []) {
  return [`${loop.name}: the loop ended. ${why}`, ...lines, recordsLine(loop), ...tail].join('\n');
}

module.exports = {
  label, jobWords, builderInfo, builderLine, sessionLines, commitLine, findingLines, verdictLines, roundLines, roundMessage,
  questionText, questionKeyboard, proposalKeyboard, withNotes, proposalFiles, endText, recordsLine, plural, oneLine, pad,
  when, span, contextWarning, warningLines, choiceKeyboard, cutOffText, abortKeyboard, CUT_OFF_WORDS, STATUS_WORDS,
  NOTE_HEADING, PROMPT_HEADING,
};
