'use strict';

// What the builder gets on stdin for one round:
//   1. the fixed preface (templates/BUILDER_PREFACE.md), with the allowed commands
//      filled in from builderAllowedTools;
//   2. for every round, and when there are any: the owner's answers from
//      .audit/DECISIONS.md, with their "(answered)" and "(assumed)" marks, under a
//      heading that says whose they are and that they come from a file the builder
//      cannot open (the builder is denied .audit/). Without this, the answers of the
//      goal check could only reach round 1 through its prompt, which is older than they are;
//   3. the round's prompt (.audit/round-NN-prompt.md), as it is.

const fs = require('node:fs');
const path = require('node:path');

const PREFACE_FILE = path.resolve(__dirname, '..', '..', 'templates', 'BUILDER_PREFACE.md');
const DECISIONS_HEADING = '## The owner\'s decisions (from `.audit/DECISIONS.md`, a file you cannot open)';
const DECISIONS_INTRO = 'The owner gave these answers to the auditor\'s questions. They count as part of GOAL.md. '
  + 'An answer marked "(assumed)" was not chosen by the owner: nobody answered in time, so the recommended option was used. Treat it as an answer too. '
  + 'An answer marked "(open)" is not answered yet: do not build what depends on it.';
const COMMANDS_MARK = '{{ALLOWED_COMMANDS}}';
const TOOLS_MARK = '{{OTHER_TOOLS}}';
const FOLLOWS_MARK = '{{WHAT_FOLLOWS}}';
const FOLLOWS_PROMPT = 'The prompt for this round follows.';
const FOLLOWS_DECISIONS = 'The owner\'s decisions follow, then the prompt for this round.';

const withFinalNewline = (text) => (text.endsWith('\n') ? text : `${text}\n`);

// The Bash commands that the permission rules allow, one line each.
// "Bash(git status)" allows exactly that; "Bash(git status *)" allows it with arguments.
function allowedCommands(rules) {
  const commands = new Map();
  for (const rule of rules) {
    const match = /^Bash\((.+)\)$/.exec(rule.trim());
    if (!match) continue;
    const withArguments = match[1].endsWith(' *');
    const command = withArguments ? match[1].slice(0, -2) : match[1];
    const entry = commands.get(command) || { alone: false, withArguments: false };
    if (withArguments) entry.withArguments = true;
    else entry.alone = true;
    commands.set(command, entry);
  }
  return [...commands].map(([command, { alone, withArguments }]) => {
    if (alone && withArguments) return `- \`${command}\`, alone or followed by arguments`;
    return withArguments ? `- \`${command}\` followed by arguments` : `- \`${command}\`, exactly like this`;
  });
}

// The tools besides Bash, as the rules name them.
function otherTools(rules) {
  return [...new Set(rules.map((rule) => rule.replace(/\(.*$/, '').trim()))].filter((name) => name && name !== 'Bash');
}

// withDecisions: the preface's last sentence then says that the decisions come first.
function renderPreface(allowedTools, template = fs.readFileSync(PREFACE_FILE, 'utf8'), { withDecisions = false } = {}) {
  // A template without the marks would quietly drop the list of commands.
  for (const mark of [COMMANDS_MARK, TOOLS_MARK, FOLLOWS_MARK]) {
    if (!template.includes(mark)) throw new Error(`${path.basename(PREFACE_FILE)} has no ${mark}`);
  }
  const commands = allowedCommands(allowedTools);
  const text = template
    .replace(COMMANDS_MARK, () => (commands.length ? commands.join('\n') : '- none: Bash is not available'))
    .replace(TOOLS_MARK, () => otherTools(allowedTools).join(', ') || 'none')
    .replace(FOLLOWS_MARK, () => (withDecisions ? FOLLOWS_DECISIONS : FOLLOWS_PROMPT));
  return `${text.replace(/\s+$/, '')}\n\n`;
}

// The answers in DECISIONS.md: its sections ("## Goal check, <date>", "## Round N,
// <date>"), each with its questions and answers. The file's own head, which speaks to
// the auditor, is left out. null when the file holds no answer.
// A file that someone wrote by hand without a section counts as a whole, without its title.
function answersOf(decisions) {
  if (typeof decisions !== 'string') return null;
  // A byte order mark at the start of the file is not part of the text.
  const text = (decisions.charCodeAt(0) === 0xFEFF ? decisions.slice(1) : decisions).replace(/\r\n/g, '\n');
  const first = text.search(/^## /m);
  if (first !== -1) return text.slice(first).trim() || null;
  // The head of templates/DECISIONS.template.md alone is not an answer.
  const body = text.split('\n').filter((line) => !/^# /.test(line) && !/^The loop writes this file /.test(line) && !/^"answered" means /.test(line)).join('\n').trim();
  return body || null;
}

// The decisions as a part of the builder's input, or '' when there are none. The
// sections go one level down, under the part's own heading.
function decisionsPart(decisions) {
  const answers = answersOf(decisions);
  if (!answers) return '';
  return `${DECISIONS_HEADING}\n\n${DECISIONS_INTRO}\n\n${answers.replace(/^## /gm, '### ')}\n\n---\n\n`;
}

// The builder's whole input. decisions is the text of DECISIONS.md, or null.
function buildInput({ allowedTools, prompt, decisions = null, template }) {
  const part = decisionsPart(decisions);
  return `${renderPreface(allowedTools, template, { withDecisions: part !== '' })}${part}${withFinalNewline(prompt)}`;
}

module.exports = { buildInput, renderPreface, allowedCommands, otherTools, answersOf, decisionsPart, DECISIONS_HEADING, DECISIONS_INTRO, PREFACE_FILE };
