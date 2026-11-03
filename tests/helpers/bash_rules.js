'use strict';

// How Claude Code matches a Bash permission rule against a command, as its
// documentation describes it (code.claude.com/docs/en/permissions, "Bash" and
// "Wildcard patterns"). The tests use this to check the shipped rule lists without a
// real claude. It is the documented behaviour written down, not Claude Code's code:
//   - a rule matches the whole command text, and "*" stands for any text, spaces included;
//   - a rule with no "*" matches one exact command;
//   - a "*" at the end with a space before it also matches the bare command, when it
//     is the rule's only wildcard: "Bash(ls *)" matches "ls";
//   - a command with &&, ||, ;, | or & is split into its parts. Every part needs an
//     allow rule, and one part that a deny rule matches denies the whole call;
//   - with --permission-mode dontAsk, what no rule allows is denied.
// It does not know quoting: a separator inside quotes is split too, which only ever
// makes this stricter than Claude Code.

// The text inside "Bash(...)", or null for a rule that is not a Bash command rule.
function bashPattern(rule) {
  const match = /^Bash\((.*)\)$/.exec(rule.trim());
  return match ? match[1] : null;
}

// Does one Bash rule match one command (a single part, without separators)?
function matches(rule, command) {
  const pattern = bashPattern(rule);
  if (pattern === null) return false;
  const text = command.trim();
  const toRegex = (p) => new RegExp(`^${p.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*')}$`);
  if (toRegex(pattern).test(text)) return true;
  const wildcards = pattern.split('*').length - 1;
  return wildcards === 1 && pattern.endsWith(' *') && text === pattern.slice(0, -2);
}

// The parts of a command that a rule is matched against.
function parts(command) {
  return command.split(/&&|\|\||\|&|[;|&\n]/).map((part) => part.trim()).filter(Boolean);
}

// "allowed" or "denied", for a session started with --allowedTools, --disallowedTools
// and --permission-mode dontAsk.
function decide(command, allow, deny) {
  const pieces = parts(command);
  if (!pieces.length) return 'denied';
  if (pieces.some((piece) => deny.some((rule) => matches(rule, piece)))) return 'denied';
  return pieces.every((piece) => allow.some((rule) => matches(rule, piece))) ? 'allowed' : 'denied';
}

module.exports = { matches, decide, parts };
