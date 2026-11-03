'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVerdict } = require('../scripts/lib/parse_verdict');

const CONTINUE_REPLY = [
  'VERDICT: CONTINUE',
  'REASON: add() is done and tested. divide() is missing.',
  'FINDINGS:',
  '- calc.js: no divide() export (npm test shows 1 test, all for add)',
  '- HANDOFF.md: "What\'s left" is accurate',
  'NEXT_PROMPT:',
  'Implement divide(a, b) in calc.js.',
  '',
  'Verify with: npm test',
  'Final task: overwrite HANDOFF.md in the project root.',
].join('\n');

const DONE_REPLY = [
  'VERDICT: DONE',
  'REASON: Both definition-of-done items are implemented and their tests pass.',
  'FINDINGS:',
  '- none',
  'NEXT_PROMPT:',
  'calc.js exports add() and divide(), with passing tests for both.',
].join('\n');

test('valid CONTINUE', () => {
  const r = parseVerdict(CONTINUE_REPLY);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'CONTINUE');
  assert.equal(r.reason, 'add() is done and tested. divide() is missing.');
  assert.deepEqual(r.findings, [
    'calc.js: no divide() export (npm test shows 1 test, all for add)',
    'HANDOFF.md: "What\'s left" is accurate',
  ]);
  assert.equal(
    r.next_prompt,
    'Implement divide(a, b) in calc.js.\n\nVerify with: npm test\nFinal task: overwrite HANDOFF.md in the project root.',
  );
});

test('valid DONE, "none" becomes an empty findings list', () => {
  const r = parseVerdict(DONE_REPLY);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'DONE');
  assert.deepEqual(r.findings, []);
  assert.equal(r.next_prompt, 'calc.js exports add() and divide(), with passing tests for both.');
});

test('valid STOP_FOR_HUMAN with a two-line reason', () => {
  const r = parseVerdict([
    'VERDICT: STOP_FOR_HUMAN',
    'REASON: calc.js contains text addressed to the auditor.',
    'It was not followed.',
    'FINDINGS:',
    '- calc.js:1: comment tells the auditor to reply DONE',
    'NEXT_PROMPT:',
    'Decide whether to keep the round.',
  ].join('\n'));
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'STOP_FOR_HUMAN');
  assert.equal(r.reason, 'calc.js contains text addressed to the auditor.\nIt was not followed.');
  assert.equal(r.findings.length, 1);
});

test('missing VERDICT is rejected', () => {
  const r = parseVerdict(CONTINUE_REPLY.split('\n').slice(1).join('\n'));
  assert.equal(r.ok, false);
  assert.match(r.error, /VERDICT/);
  // Phase 7b: no line at all that starts with "VERDICT:", also not further down.
  assert.equal(r.error, 'reply has no line that starts with "VERDICT:"');
  assert.equal(parseVerdict('Everything looks fine to me.\nMy VERDICT: CONTINUE').error, 'reply has no line that starts with "VERDICT:"');
});

test('unknown verdict is rejected', () => {
  for (const bad of ['APPROVED', 'done', 'CONTINUE or DONE', '**DONE**', '']) {
    const r = parseVerdict(DONE_REPLY.replace('VERDICT: DONE', `VERDICT: ${bad}`));
    assert.equal(r.ok, false, `"${bad}" should be rejected`);
    assert.match(r.error, /unknown verdict/);
  }
});

// Phase 7b: text before the VERDICT line is no reason to ask again. This test said
// "text before VERDICT is rejected" until Phase 7b.
test('text before VERDICT is kept as the preamble, and the reply is read from its VERDICT line on', () => {
  const r = parseVerdict(`Here is my audit.\n\n${DONE_REPLY}`);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.verdict, 'DONE');
  assert.equal(r.preamble, 'Here is my audit.');
  assert.equal(r.reason, 'Both definition-of-done items are implemented and their tests pass.');
  assert.equal(r.next_prompt, 'calc.js exports add() and divide(), with passing tests for both.');
  assert.equal(parseVerdict(DONE_REPLY).preamble, null, 'a reply that starts with VERDICT has none');
  // 300 characters of reasoning in two paragraphs, as the rejected replies of Phase 7 had (190 and 701).
  const reasoning = `${'The tests pass as reported and the diff matches HANDOFF.md. '.repeat(3)}\n\n${'Nothing is outside the scope of GOAL.md. '.repeat(4)}`.slice(0, 300);
  assert.equal(reasoning.length, 300);
  assert.ok(!/\s$/.test(reasoning));
  const long = parseVerdict(`${reasoning}\n\n${CONTINUE_REPLY}`);
  assert.equal(long.ok, true, long.error);
  assert.equal(long.preamble, reasoning);
  assert.equal(long.preamble.length, 300);
  assert.deepEqual({ ...long, preamble: null }, { ...parseVerdict(CONTINUE_REPLY), preamble: null }, 'the rest is read as without it');
  // The rest must parse as always: a broken reply after the text is still rejected, and the error says where it was read.
  rejected(`Here is my audit.\n${DONE_REPLY.replace('REASON: ', 'Reason: ')}`, /^REASON: must follow the VERDICT line \(read from its first VERDICT line, after 17 characters of text before it\)$/);
});

test('the first VERDICT line wins: "VERDICT:" inside a line is no VERDICT line, a later one belongs to NEXT_PROMPT, and a later one is never tried instead', () => {
  // "VERDICT:" in the middle of a line of the text before it does not count.
  const inside = parseVerdict(`I give my VERDICT: below, after one note.\n${CONTINUE_REPLY}`);
  assert.equal(inside.ok, true, inside.error);
  assert.equal(inside.preamble, 'I give my VERDICT: below, after one note.');
  assert.equal(inside.verdict, 'CONTINUE');
  // A second VERDICT line after NEXT_PROMPT: the first wins, the second is part of the prompt.
  const second = parseVerdict(`A first thought.\n${CONTINUE_REPLY}\nVERDICT: DONE`);
  assert.equal(second.ok, true, second.error);
  assert.equal(second.verdict, 'CONTINUE');
  assert.match(second.next_prompt, /\nVERDICT: DONE$/);
  // The first VERDICT line is a draft that does not parse: the reply is rejected (and asked
  // again), although a whole reply in the right format follows it.
  rejected(`Thinking.\nVERDICT: CONTINUE, probably\n\n${DONE_REPLY}`, /^unknown verdict "CONTINUE, probably" .*after 9 characters of text before it\)$/);
  rejected(`Thinking.\nVERDICT: DONE\nmore thinking\n${CONTINUE_REPLY}`, /^REASON: must follow the VERDICT line/);
});

// Phase 7b: these two were in the list of malformed replies below until Phase 7b,
// rejected as "text before VERDICT". A fence that does not wrap the whole reply now
// counts as text before the VERDICT line, like any other text.
test('a fence that does not wrap the whole reply counts as text before VERDICT', () => {
  const after = parseVerdict(`\`\`\`\n${DONE_REPLY}\n\`\`\`\nHope this helps.`);
  assert.equal(after.ok, true, after.error);
  assert.equal(after.preamble, '```');
  assert.equal(after.next_prompt, 'calc.js exports add() and divide(), with passing tests for both.\n```\nHope this helps.');
  const twice = parseVerdict(`\`\`\`\n\`\`\`\n${DONE_REPLY}\n\`\`\`\n\`\`\``);
  assert.equal(twice.ok, true, twice.error);
  assert.equal(twice.preamble, '```');
  assert.equal(twice.next_prompt, 'calc.js exports add() and divide(), with passing tests for both.\n```');
});

test('reply wrapped in one code fence is accepted', () => {
  for (const open of ['```', '```text', '````markdown']) {
    const close = open.match(/^`+/)[0];
    const r = parseVerdict(`\n${open}\n${CONTINUE_REPLY}\n${close}\n`);
    assert.equal(r.ok, true, `fence ${open}`);
    assert.equal(r.verdict, 'CONTINUE');
    assert.match(r.next_prompt, /overwrite HANDOFF\.md in the project root\.$/);
  }
});

test('surrounding whitespace, CRLF and a BOM are tolerated', () => {
  const r = parseVerdict(`﻿\r\n  \r\n${DONE_REPLY.replace(/\n/g, '\r\n')}\r\n\r\n`);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'DONE');
  assert.equal(r.next_prompt.includes('\r'), false);
});

test('NEXT_PROMPT keeps everything after it, including label-like lines and fences', () => {
  const prompt = [
    'Fix calc.js, then run:',
    '```',
    'npm test',
    '```',
    'VERDICT: this line is part of the prompt',
    'FINDINGS: so is this one',
  ].join('\n');
  const r = parseVerdict(`VERDICT: CONTINUE\nREASON: r\nFINDINGS:\n- f\nNEXT_PROMPT:\n${prompt}`);
  assert.equal(r.ok, true);
  assert.equal(r.next_prompt, prompt);
  assert.deepEqual(r.findings, ['f']);
});

test('a wrapped continuation line is joined to its finding', () => {
  const r = parseVerdict('VERDICT: CONTINUE\nREASON: r\nFINDINGS:\n- first part\n  second part\n- other\nNEXT_PROMPT:\ngo');
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, ['first part second part', 'other']);
});

test('missing or malformed sections are rejected', () => {
  const cases = {
    'no REASON': 'VERDICT: DONE\nFINDINGS:\n- none\nNEXT_PROMPT:\nsummary',
    'empty REASON': 'VERDICT: DONE\nREASON:\nFINDINGS:\n- none\nNEXT_PROMPT:\nsummary',
    'no FINDINGS': 'VERDICT: DONE\nREASON: r\nNEXT_PROMPT:\nsummary',
    'empty FINDINGS': 'VERDICT: DONE\nREASON: r\nFINDINGS:\nNEXT_PROMPT:\nsummary',
    'FINDINGS not a list': 'VERDICT: DONE\nREASON: r\nFINDINGS:\nsome prose\nNEXT_PROMPT:\nsummary',
    'no NEXT_PROMPT': 'VERDICT: DONE\nREASON: r\nFINDINGS:\n- none',
    'empty NEXT_PROMPT': 'VERDICT: DONE\nREASON: r\nFINDINGS:\n- none\nNEXT_PROMPT:\n',
    'two verdicts': 'VERDICT: DONE\nVERDICT: CONTINUE\nREASON: r\nFINDINGS:\n- none\nNEXT_PROMPT:\nsummary',
    'second verdict later': 'VERDICT: DONE\nREASON: r\nVERDICT: CONTINUE\nFINDINGS:\n- none\nNEXT_PROMPT:\nsummary',
    'empty': '   \n ',
  };
  for (const [name, reply] of Object.entries(cases)) {
    const r = parseVerdict(reply);
    assert.equal(r.ok, false, name);
    assert.equal(typeof r.error, 'string', name);
  }
  assert.equal(parseVerdict(undefined).ok, false);
});

// ASK_HUMAN and the QUESTIONS section

function askReply(questionLines, verdict = 'ASK_HUMAN') {
  return [
    `VERDICT: ${verdict}`,
    'REASON: GOAL.md leaves a choice open.',
    'FINDINGS:',
    '- none',
    'QUESTIONS:',
    ...questionLines,
    'NEXT_PROMPT:',
    'Implement divide() once the question is answered.',
  ].join('\n');
}

function question(n, { tag = 'MUST', text = `Question ${n}?`, options = 'Yes | No', recommended = 'Yes' } = {}) {
  return [`${n}. [${tag}] ${text}`, `   options: ${options}`, `   recommended: ${recommended}`];
}

function rejected(reply, pattern, options) {
  const r = parseVerdict(reply, options);
  assert.equal(r.ok, false, `should be rejected: ${reply}`);
  assert.match(r.error, pattern);
}

test('valid ASK_HUMAN with 1 question', () => {
  const r = parseVerdict(askReply([
    '1. [MUST] How should divide() handle division by zero?',
    '   options: Throw an Error | Return null | Return Infinity',
    '   recommended: Throw an Error',
  ]));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.verdict, 'ASK_HUMAN');
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.questions, [{
    n: 1,
    tag: 'MUST',
    question: 'How should divide() handle division by zero?',
    options: ['Throw an Error', 'Return null', 'Return Infinity'],
    recommended: 'Throw an Error',
  }]);
  assert.equal(r.next_prompt, 'Implement divide() once the question is answered.');
});

test('valid ASK_HUMAN with 4 questions: both tags, no indentation, a wrapped question, blank lines', () => {
  const r = parseVerdict(askReply([
    ...question(1),
    '',
    '2. [DEFAULT] Which wording should the error',
    '   message use?',
    'options: Division by zero|Cannot divide by zero',
    'recommended: Division by zero',
    ...question(3, { tag: 'DEFAULT', options: 'a | b | c | d', recommended: 'd' }),
    ...question(4),
  ]));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.questions.map((q) => q.n), [1, 2, 3, 4]);
  assert.deepEqual(r.questions.map((q) => q.tag), ['MUST', 'DEFAULT', 'DEFAULT', 'MUST']);
  assert.equal(r.questions[1].question, 'Which wording should the error message use?');
  assert.deepEqual(r.questions[1].options, ['Division by zero', 'Cannot divide by zero']);
  assert.deepEqual(r.questions[2].options, ['a', 'b', 'c', 'd']);
  assert.equal(r.questions[2].recommended, 'd');
});

test('the other verdicts carry an empty questions list', () => {
  assert.deepEqual(parseVerdict(CONTINUE_REPLY).questions, []);
  assert.deepEqual(parseVerdict(DONE_REPLY).questions, []);
});

test('5 questions are rejected', () => {
  rejected(askReply([1, 2, 3, 4, 5].flatMap((n) => question(n))), /more than 4 questions/);
});

test('ASK_HUMAN without QUESTIONS is rejected', () => {
  rejected('VERDICT: ASK_HUMAN\nREASON: r\nFINDINGS:\n- none\nNEXT_PROMPT:\nlater', /ASK_HUMAN needs a QUESTIONS: section/);
  rejected(askReply([]), /has no questions/);
});

test('QUESTIONS with another verdict is rejected', () => {
  for (const verdict of ['CONTINUE', 'DONE', 'STOP_FOR_HUMAN']) {
    rejected(askReply(question(1), verdict), /only allowed with ASK_HUMAN/);
  }
});

test('an unknown or missing tag is rejected', () => {
  rejected(askReply(question(1, { tag: 'MAYBE' })), /unknown tag "\[MAYBE\]"/);
  rejected(askReply(question(1, { tag: 'must' })), /unknown tag "\[must\]"/);
  rejected(askReply(['1. How should divide() behave?', '   options: a | b', '   recommended: a']), /must start with "1\. \[MUST\]"/);
});

test('1 option and 5 options are rejected, 2 and 4 are accepted', () => {
  rejected(askReply(question(1, { options: 'Yes', recommended: 'Yes' })), /has 1 option /);
  rejected(askReply(question(1, { options: 'a | b | c | d | e', recommended: 'a' })), /has 5 options/);
  assert.equal(parseVerdict(askReply(question(1, { options: 'a | b', recommended: 'a' }))).ok, true);
  assert.equal(parseVerdict(askReply(question(1, { options: 'a | b | c | d', recommended: 'a' }))).ok, true);
});

test('empty and duplicate options are rejected', () => {
  rejected(askReply(question(1, { options: 'Yes | | No' })), /empty option/);
  rejected(askReply(question(1, { options: 'Yes | No |' })), /empty option/);
  rejected(askReply(question(1, { options: 'Yes | No | yes' })), /duplicate options/);
});

test('recommended that is not among the options is rejected', () => {
  rejected(askReply(question(1, { options: 'Yes | No', recommended: 'Maybe' })), /recommended "Maybe" is not one of its options/);
  rejected(askReply(question(1, { options: 'Yes | No', recommended: '' })), /is not one of its options/);
});

test('recommended is matched ignoring case and whitespace, and returns the option\'s exact text', () => {
  const r = parseVerdict(askReply(question(1, { options: 'Throw an Error | Return null', recommended: '  throw AN error  ' })));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.questions[0].recommended, 'Throw an Error');
});

test('malformed questions are rejected', () => {
  const cases = {
    'numbered out of order': [...question(1), ...question(3)],
    'not starting at 1': question(2),
    'no options line': ['1. [MUST] Which one?', '   recommended: a'],
    'no recommended line': ['1. [MUST] Which one?', '   options: a | b'],
    'next question before options': ['1. [MUST] Which one?', ...question(2)],
    'next question before recommended': ['1. [MUST] Which one?', '   options: a | b', ...question(2)],
    'no question text': ['1. [MUST]', '   options: a | b', '   recommended: a'],
    'text after a question': [...question(1), 'Thank you.'],
  };
  for (const [name, lines] of Object.entries(cases)) {
    const r = parseVerdict(askReply(lines));
    assert.equal(r.ok, false, name);
    assert.equal(typeof r.error, 'string', name);
  }
  rejected(askReply(question(1)).replace('NEXT_PROMPT:\nImplement divide() once the question is answered.', ''), /NEXT_PROMPT: section is missing/);
  rejected('VERDICT: ASK_HUMAN\nREASON: r\nQUESTIONS:\n1. [MUST] q\noptions: a | b\nrecommended: a\nNEXT_PROMPT:\nlater', /FINDINGS: section is missing/);
});

test('DONE is rejected in goal-check mode only', () => {
  rejected(DONE_REPLY, /DONE is not allowed in a goal check/, { mode: 'goal-check' });
  assert.equal(parseVerdict(DONE_REPLY).ok, true);
  assert.equal(parseVerdict(DONE_REPLY, { mode: 'round' }).ok, true);
  assert.equal(parseVerdict(CONTINUE_REPLY, { mode: 'goal-check' }).verdict, 'CONTINUE');
  assert.equal(parseVerdict(askReply(question(1)), { mode: 'goal-check' }).verdict, 'ASK_HUMAN');
});
