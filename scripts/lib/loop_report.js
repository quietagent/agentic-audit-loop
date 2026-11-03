'use strict';

// LOOP_REPORT.md: what a loop did, on one page. It is written into the project's
// .audit\ folder when a loop ends, for any reason, and sent to the owner as a file.
// A loop that is resumed and ends again writes it again.
// Everything in it comes from the loop's own state (loop.json) and from git.

const path = require('node:path');
const { localStamp } = require('./runtime');
const M = require('./loop_messages');
const O = require('./overnight');
const { describeModel } = require('./claude_process');

// A bare "unknown" in the report would not say what is unknown.
const money = (n) => (Number.isFinite(n) ? `$${n.toFixed(4)}` : 'cost not known');
const stamp = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? localStamp(new Date(iso)) : 'unknown');
// A cell of a Markdown table: one line, and no bar that would end the cell.
const cell = (text) => M.oneLine(text).replace(/\|/g, '\\|') || '-';
const roundNumbers = (loop) => Object.keys(loop.rounds || {}).map(Number).filter(Number.isInteger).sort((a, b) => a - b);

// Every cost the loop knows, added up: { total, builder, auditor, goalChecks, unknown }.
// unknown counts the calls whose cost is not known (a builder that was cut off).
function costs(loop) {
  const sum = { builder: 0, auditor: 0, goalChecks: 0, unknown: 0 };
  for (const round of roundNumbers(loop)) {
    const data = loop.rounds[round];
    for (const run of [...(data.attempts || []), ...(data.builder ? [data.builder] : [])]) {
      if (Number.isFinite(run.cost_usd)) sum.builder += run.cost_usd;
      else sum.unknown += 1;
    }
    if (Number.isFinite(data.auditCost)) sum.auditor += data.auditCost;
  }
  for (const check of loop.goalCheckRuns || []) {
    if (Number.isFinite(check.cost_usd)) sum.goalChecks += check.cost_usd;
    else sum.unknown += 1;
  }
  return { ...sum, total: sum.builder + sum.auditor + sum.goalChecks };
}

function roundRows(loop) {
  const rows = [];
  for (const round of roundNumbers(loop)) {
    const data = loop.rounds[round];
    const builder = data.builder || null;
    const verdict = data.verdict || null;
    const peak = !builder ? '-' : (builder.peak_percent !== null && builder.peak_percent !== undefined
      ? `${builder.peak_percent}%`
      : `${Number(builder.peak_tokens || 0).toLocaleString('en-US')} tokens`);
    rows.push([
      String(round),
      builder ? `${M.STATUS_WORDS[builder.status] || builder.status}${data.cutOff ? ', kept and audited' : ''}` : 'did not run',
      builder && builder.turns !== null ? String(builder.turns) : '-',
      builder ? money(builder.cost_usd) : '-',
      peak,
      builder ? (builder.compactions ? `yes, ${M.plural(builder.compactions, 'time')}` : 'no') : '-',
      builder ? String(builder.denials) : '-',
      data.commit || 'none',
      verdict ? verdict.verdict : 'no verdict',
      verdict ? verdict.reason : '-',
      Number.isFinite(data.auditCost) ? money(data.auditCost) : (verdict ? money(null) : '-'),
    ].map(cell));
  }
  return rows;
}

// The text of the report. history is { log, stat } from git (lib/loop_git.js).
// goal is the text of GOAL.md: the report of an overnight run (Phase 7) lists its
// "## Overnight" items and what is left for the owner's review. model and effort
// (Phase 7c) are the config's, as the builder and the auditor are started with them;
// null is Claude Code's default.
function buildReport(loop, history, { goal = '', model = null, effort = null } = {}) {
  const end = loop.end || {};
  const cost = costs(loop);
  const rounds = roundNumbers(loop);
  const overnight = O.reportLines(loop, goal);
  const lines = [
    `# Loop report: ${loop.name}`,
    '',
    ...overnight.top,
    `- Project: ${loop.project}`,
    `- Loop: ${loop.id}`,
    `- Started: ${stamp(loop.startedAt)}`,
    `- Ended: ${stamp(end.at)}`,
    `- How it ended: ${M.oneLine(end.why)}`,
    `- Rounds: ${rounds.length ? rounds[rounds.length - 1] : 0} of ${loop.cap}`,
    `- Total cost: ${money(cost.total)} (builder ${money(cost.builder)}, auditor ${money(cost.auditor)}, goal checks ${money(cost.goalChecks)})`
      + `${cost.unknown ? `. Not in it: ${M.plural(cost.unknown, 'call')} whose cost is not known, because it was cut off or failed.` : ''}`,
    `- Model: ${describeModel({ model, effort })}`,
  ];
  const earlier = loop.ends || [];
  if (earlier.length) {
    lines.push(`- It ended and was resumed ${M.plural(earlier.length, 'time')} before:`);
    for (const one of earlier) lines.push(`  - ${stamp(one.at)}: ${M.oneLine(one.why)} Resumed ${stamp(one.resumedAt)}.`);
  }
  // The test settings of /testmode: a loop that ran with short timers says so.
  const tested = Array.isArray(loop.testSettings) ? loop.testSettings : [];
  if (tested.length) {
    lines.push('- TEST SETTINGS WERE ON during this loop (/testmode). Its timers were not the normal ones:');
    for (const one of tested) lines.push(`  - from ${stamp(one.at)}: ${one.settings || 'none (switched off)'}`);
  } else {
    lines.push('- Test settings (/testmode): none was on during this loop.');
  }
  // The morning report of an overnight run: the three sections come first.
  lines.push(...overnight.sections);

  lines.push('', '## Rounds', '');
  const rows = roundRows(loop);
  if (rows.length) {
    lines.push(
      '| Round | Builder | Turns | Cost | Context peak | Compacted | Denied calls | Commit | Verdict | Reason | Auditor cost |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows.map((row) => `| ${row.join(' | ')} |`),
    );
    for (const round of rounds) {
      const data = loop.rounds[round];
      for (const [i, run] of (data.attempts || []).entries()) {
        lines.push('', `Round ${round}, attempt ${i + 1}, which was cut off and done again: ${M.STATUS_WORDS[run.status] || run.status}, ${money(run.cost_usd)}. `
          + `Its records: round-${M.pad(round)}-builder-attempt-${run.attempt}.*${run.stash ? `. Its work was put aside: git stash list shows "${run.stash}".` : '.'}`);
      }
      if (data.warning) lines.push('', `Round ${round}: ${data.warning}`);
    }
  } else {
    lines.push('No round ran.');
  }
  const checks = loop.goalCheckRuns || [];
  lines.push('', checks.length
    ? `Goal checks: ${checks.map((check) => `${check.n} ${check.verdict} (${money(check.cost_usd)})`).join(', ')}.`
    : 'Goal checks: none ended with a verdict.');

  lines.push('', '## Questions and answers', '');
  const decisions = loop.decisions || [];
  if (decisions.length) {
    for (const group of decisions) {
      lines.push(`${group.title}, ${stamp(group.at)}:`, '');
      for (const item of group.items) {
        let how;
        if (item.how === 'assumed') how = 'assumed: nobody answered in time, so the recommended option was used';
        else if (item.how === 'open') how = 'open: not answered yet, left for later by the overnight run';
        else how = `answered${item.how === 'typed' ? ', typed' : ', by button'}`;
        lines.push(`- Q${item.n} [${item.tag}] ${M.oneLine(item.question)}`, `  A: ${item.how === 'open' ? 'not answered yet' : M.oneLine(item.answer)} (${how})`);
      }
      lines.push('');
    }
    lines.pop();
  } else {
    lines.push('The auditor asked nothing.');
  }

  lines.push('', '## The owner\'s notes and edits', '');
  const edited = [];
  for (const round of rounds) {
    const prompt = loop.rounds[round].prompt;
    if (!prompt) continue;
    if (prompt.source === 'owner') edited.push(`- Round ${round}: the prompt was the owner's own, sent after /resume${prompt.ownerFile ? ' as a file' : ''}.`);
    if (prompt.fromFile) edited.push(`- Round ${round}: the owner replaced the prompt with a file.`);
    for (const note of prompt.noteTexts || []) edited.push(`- Round ${round}, note: ${M.oneLine(note)}`);
    if (prompt.edits && !prompt.fromFile && !(prompt.noteTexts || []).length) edited.push(`- Round ${round}: ${M.plural(prompt.edits, 'edit')}.`);
  }
  lines.push(...(edited.length ? edited : ['None. Every prompt was approved as it was proposed.']));

  lines.push('', '## The last verdict', '');
  const verdict = loop.lastVerdict;
  if (verdict) {
    lines.push(`${verdict.kind === 'goal-check' ? 'Goal check' : `Round ${verdict.round}`}: ${verdict.verdict}. ${M.oneLine(verdict.reason)}`, '');
    const findings = Array.isArray(verdict.findings) ? verdict.findings : [];
    lines.push(findings.length ? 'Open findings:' : 'Open findings: none.', ...findings.map((finding) => `- ${M.oneLine(finding)}`), '');
    const title = { DONE: 'Summary', CONTINUE: 'The next prompt (not run)', STOP_FOR_HUMAN: 'What the owner needs to do', ASK_HUMAN: 'After the answers' }[verdict.verdict] || 'Note';
    lines.push(`${title}:`, '', String(verdict.next_prompt || '').trim() || '(none)');
  } else {
    lines.push('There is none: no audit ended with a verdict.');
  }

  lines.push('', '## Commits', '');
  lines.push(`The loop's commits (git log --oneline${loop.baseCommit ? `, after ${String(loop.baseCommit).slice(0, 7)}` : ''}):`, '', '```', history.log || '(none)', '```');
  if (history.stat) lines.push('', 'What changed from the first to the last (git diff --stat, without HANDOFF.md):', '', '```', history.stat, '```');

  lines.push('', '---', '', 'Bring this file to Claude in chat for the final check.', '');
  return lines.join('\n');
}

const reportFile = (project) => path.join(project, '.audit', 'LOOP_REPORT.md');

module.exports = { buildReport, costs, reportFile };
