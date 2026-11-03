'use strict';

// Parses the auditor's reply (format defined in AUDITOR.md, "Output format").
// Returns { ok: true, verdict, reason, findings, questions, next_prompt, preamble } or { ok: false, error }.
// preamble (Phase 7b) is the text before the VERDICT line, or null when the reply starts with it.
// parseVerdict(raw, { mode: 'goal-check' }) also rejects DONE (AUDITOR.md, "Goal check").

const VERDICTS = ['CONTINUE', 'DONE', 'ASK_HUMAN', 'STOP_FOR_HUMAN'];
const QUESTION_TAGS = ['MUST', 'DEFAULT'];
const MAX_QUESTIONS = 4;

function fail(error) {
  return { ok: false, error };
}

// A reply wrapped in exactly one code fence is unwrapped. Anything else that
// starts with a fence is left alone: the fence then counts as text before VERDICT.
function stripSingleFence(text) {
  const lines = text.split('\n');
  const open = /^(`{3,})[^`]*$/.exec(lines[0]);
  if (!open || lines.length < 3) return text;
  if (lines[lines.length - 1].trim() !== open[1]) return text;
  return lines.slice(1, -1).join('\n').trim();
}

function label(line, name) {
  const m = new RegExp(`^${name}:[ \\t]*(.*)$`).exec(line);
  return m ? m[1] : null;
}

function parseFindings(lines) {
  const items = [];
  let sawNone = false;
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    const bullet = /^[-*][ \t]+(.*)$/.exec(text);
    if (bullet) {
      items.push(bullet[1].trim());
    } else if (items.length) {
      items[items.length - 1] += ` ${text}`;
    } else if (isNone(text)) {
      sawNone = true;
    } else {
      return null;
    }
  }
  if (items.length === 1 && isNone(items[0])) return [];
  if (!items.length && !sawNone) return null;
  return items;
}

function isNone(text) {
  return /^"?none"?\.?$/i.test(text);
}

function parseOptions(n, value) {
  const options = value.split('|').map((option) => option.trim());
  if (options.some((option) => !option)) return { error: `question ${n} has an empty option` };
  if (options.length < 2 || options.length > 4) {
    return { error: `question ${n} has ${options.length} option${options.length === 1 ? '' : 's'} (2 to 4 are allowed)` };
  }
  const seen = new Set(options.map((option) => option.toLowerCase()));
  if (seen.size !== options.length) return { error: `question ${n} has duplicate options` };
  return { options };
}

// Each question is "N. [MUST] text" or "N. [DEFAULT] text" (the text may run over
// several lines), then an "options:" line and a "recommended:" line.
// Returns { questions } or { error }.
function parseQuestions(lines) {
  const questions = [];
  let current = null;
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    const field = /^(options|recommended):[ \t]*(.*)$/i.exec(text);
    const name = field ? field[1].toLowerCase() : null;
    const start = /^(\d+)\.[ \t]*\[([^\]]*)\][ \t]*(.*)$/.exec(text);

    if (!current) {
      const n = questions.length + 1;
      const numbered = /^\d+\./.test(text);
      if (!numbered && questions.length) {
        return { error: `unexpected text after question ${questions.length}: "${text.slice(0, 60)}"` };
      }
      if (numbered && n > MAX_QUESTIONS) return { error: `more than ${MAX_QUESTIONS} questions` };
      if (!start) return { error: `question ${n} must start with "${n}. [MUST]" or "${n}. [DEFAULT]"` };
      if (Number(start[1]) !== n) return { error: `questions must be numbered 1, 2, 3, 4 in order (found ${start[1]} where ${n} was expected)` };
      if (!QUESTION_TAGS.includes(start[2])) {
        return { error: `unknown tag "[${start[2]}]" on question ${n} (expected [MUST] or [DEFAULT])` };
      }
      current = { n, tag: start[2], question: start[3] };
    } else if (!current.options) {
      if (name === 'recommended') return { error: `question ${current.n}: "options:" must come before "recommended:"` };
      if (name === 'options') {
        if (!current.question.trim()) return { error: `question ${current.n} has no text` };
        const parsed = parseOptions(current.n, field[2]);
        if (parsed.error) return parsed;
        current.options = parsed.options;
      } else if (start && QUESTION_TAGS.includes(start[2])) {
        return { error: `question ${current.n} has no "options:" line` };
      } else {
        current.question += ` ${text}`;
      }
    } else {
      if (name !== 'recommended') return { error: `question ${current.n}: a "recommended:" line must follow "options:"` };
      const wanted = field[2].trim().toLowerCase();
      const recommended = current.options.find((option) => option.toLowerCase() === wanted);
      if (recommended === undefined) {
        return { error: `question ${current.n}: recommended "${field[2].trim()}" is not one of its options` };
      }
      questions.push({ n: current.n, tag: current.tag, question: current.question.trim(), options: current.options, recommended });
      current = null;
    }
  }
  if (current) return { error: `question ${current.n} has no "${current.options ? 'recommended' : 'options'}:" line` };
  if (!questions.length) return { error: 'QUESTIONS: has no questions' };
  return { questions };
}

function parseVerdict(raw, options = {}) {
  if (typeof raw !== 'string') return fail('reply is not text');
  let text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!text) return fail('reply is empty');
  text = stripSingleFence(text);
  const all = text.split('\n');

  // Text before the VERDICT line (Phase 7b): in 2 of 7 real calls of Phase 7 the auditor
  // wrote its reasoning first, and the reply after it was right. Such a reply is read from
  // its first line that starts with "VERDICT:", and the text before it is handed back as
  // `preamble`. The first such line wins: a later one is never tried instead.
  const start = all.findIndex((line) => label(line, 'VERDICT') !== null);
  if (start === -1) return fail('reply has no line that starts with "VERDICT:"');
  const preamble = start > 0 ? all.slice(0, start).join('\n').trim() : null;
  const parsed = parseFrom(all.slice(start), options);
  if (!parsed.ok) return start > 0 ? fail(`${parsed.error} (read from its first VERDICT line, after ${preamble.length} characters of text before it)`) : parsed;
  return { ...parsed, preamble };
}

// The reply from its VERDICT line on.
function parseFrom(lines, options) {
  const verdict = label(lines[0], 'VERDICT').trim();
  if (!VERDICTS.includes(verdict)) {
    return fail(`unknown verdict "${verdict}" (expected one of ${VERDICTS.join(', ')})`);
  }
  if (options.mode === 'goal-check' && verdict === 'DONE') return fail('DONE is not allowed in a goal check');

  let i = 1;
  while (i < lines.length && !lines[i].trim()) i += 1;
  const reasonFirst = i < lines.length ? label(lines[i], 'REASON') : null;
  if (reasonFirst === null) return fail('REASON: must follow the VERDICT line');
  const reasonLines = [reasonFirst];
  i += 1;
  while (i < lines.length && label(lines[i], 'FINDINGS') === null) {
    if (label(lines[i], 'VERDICT') !== null) return fail('more than one VERDICT line');
    if (label(lines[i], 'NEXT_PROMPT') !== null || label(lines[i], 'QUESTIONS') !== null) {
      return fail('FINDINGS: section is missing');
    }
    reasonLines.push(lines[i]);
    i += 1;
  }
  if (i >= lines.length) return fail('FINDINGS: section is missing');
  const reason = reasonLines.join('\n').trim();
  if (!reason) return fail('REASON is empty');

  const findingLines = [label(lines[i], 'FINDINGS')];
  i += 1;
  while (i < lines.length && label(lines[i], 'NEXT_PROMPT') === null && label(lines[i], 'QUESTIONS') === null) {
    if (label(lines[i], 'VERDICT') !== null) return fail('more than one VERDICT line');
    findingLines.push(lines[i]);
    i += 1;
  }
  if (i >= lines.length) return fail('NEXT_PROMPT: section is missing');
  const findings = parseFindings(findingLines);
  if (findings === null) return fail('FINDINGS must be a list of "- " lines, or "- none"');

  let questions = [];
  if (label(lines[i], 'QUESTIONS') !== null) {
    if (verdict !== 'ASK_HUMAN') return fail(`a QUESTIONS: section is only allowed with ASK_HUMAN, not with ${verdict}`);
    const questionLines = [label(lines[i], 'QUESTIONS')];
    i += 1;
    while (i < lines.length && label(lines[i], 'NEXT_PROMPT') === null) {
      if (label(lines[i], 'VERDICT') !== null) return fail('more than one VERDICT line');
      questionLines.push(lines[i]);
      i += 1;
    }
    if (i >= lines.length) return fail('NEXT_PROMPT: section is missing');
    const parsed = parseQuestions(questionLines);
    if (parsed.error) return fail(parsed.error);
    questions = parsed.questions;
  } else if (verdict === 'ASK_HUMAN') {
    return fail('ASK_HUMAN needs a QUESTIONS: section between FINDINGS and NEXT_PROMPT');
  }

  // Everything after the label belongs to the prompt, including lines that look like labels.
  const next_prompt = [label(lines[i], 'NEXT_PROMPT'), ...lines.slice(i + 1)].join('\n').trim();
  if (!next_prompt) return fail('NEXT_PROMPT is empty');

  return { ok: true, verdict, reason, findings, questions, next_prompt };
}

module.exports = { parseVerdict, VERDICTS };
