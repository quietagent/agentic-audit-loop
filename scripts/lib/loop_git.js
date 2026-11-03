'use strict';

// What the loop does with git in a project: the checks before a loop may start,
// the commit after every builder round, and the stash that puts a round's partial
// work aside.
// git gets the clean environment of clean_env.js, and the options of safe_git.js:
// the project's own hooks never run, and git asks no fsmonitor program. Every call
// has a time limit: a tick must not hang.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanEnv } = require('./clean_env');
const { roundFile } = require('./projects');
const { safeGitArgs } = require('./safe_git');
const { secretValues } = require('./project_env');

const GIT_TIMEOUT_MS = 60 * 1000;
const ROUND_RECORD = /^round-\d+-(builder[.-].*|verdict\.json)$/;
// A staged file above this size is not searched for the values of .env.
const CONTENT_CHECK_MAX_BYTES = 64 * 1024 * 1024;

function git(project, args, { n8nEnvFile } = {}) {
  let safe;
  try {
    safe = safeGitArgs();
  } catch (err) {
    return { ok: false, stdout: '', stderr: err.message };
  }
  const r = spawnSync('git', [...safe, ...args], {
    cwd: project,
    encoding: 'utf8',
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: cleanEnv(process.env, { envFile: n8nEnvFile }),
  });
  if (r.error) return { ok: false, stdout: '', stderr: `could not run git ${args[0]}: ${r.error.message}` };
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: (r.stderr || '').trim() };
}

// The records of rounds that already ran: builder records and verdicts.
function roundRecords(project) {
  const dir = path.join(project, '.audit');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => ROUND_RECORD.test(name)).sort() : [];
}

// What "git status --porcelain" lists: the lines, or { error }.
function changedPaths(project, options = {}) {
  const status = git(project, ['status', '--porcelain'], options);
  if (!status.ok) return { error: `git status failed: ${status.stderr.slice(0, 300)}` };
  return { lines: status.stdout.split('\n').filter((line) => line.trim()) };
}

// null for a clean working tree, else what is wrong, as a sentence.
function treeProblem(project, options = {}) {
  const changed = changedPaths(project, options);
  if (changed.error) return changed.error;
  if (!changed.lines.length) return null;
  return `its working tree is not clean. Commit or remove these first (git status --porcelain):\n${changed.lines.slice(0, 10).join('\n')}`
    + `${changed.lines.length > 10 ? `\nand ${changed.lines.length - 10} more` : ''}`;
}

// null when the project is one the loop can work on, else what is wrong.
function repoProblem(project, options = {}) {
  // .git must be in the project folder itself: a parent repo does not count.
  if (!fs.existsSync(path.join(project, '.git')) || !git(project, ['rev-parse', '--git-dir'], options).ok) {
    return 'it is not a git repository.';
  }
  if (!fs.existsSync(path.join(project, 'GOAL.md'))) return 'it has no GOAL.md.';
  // The loop commits with "git add -A": its own records must never be part of that.
  if (!git(project, ['check-ignore', '-q', '.audit/loop.json'], options).ok) {
    return 'its .gitignore does not ignore .audit/, so the loop\'s commits would take the loop\'s own records along. Add the line ".audit/" to .gitignore and commit that.';
  }
  return null;
}

// null when a loop can start on this project, else what is wrong, as a sentence.
function projectProblem(project, options = {}) {
  if (!fs.existsSync(path.join(project, '.git')) || !git(project, ['rev-parse', '--git-dir'], options).ok) {
    return 'it is not a git repository.';
  }
  if (!fs.existsSync(path.join(project, 'GOAL.md'))) return 'it has no GOAL.md.';
  const prompt = roundFile(project, 1, 'prompt.md');
  if (!fs.existsSync(prompt) || !fs.readFileSync(prompt, 'utf8').trim()) {
    return 'it has no first prompt (.audit\\round-01-prompt.md). A project made with /new has one.';
  }
  const repo = repoProblem(project, options);
  if (repo) return repo;
  const tree = treeProblem(project, options);
  if (tree) return tree;
  const records = roundRecords(project);
  if (records.length) {
    return `rounds already ran there (.audit\\${records[0]}${records.length > 1 ? ` and ${records.length - 1} more` : ''}). `
      + `To continue that loop, send /resume ${path.basename(project)}.`;
  }
  return null;
}

// Does the project's .gitignore keep .env out of git?
function ignoresEnv(project, options = {}) {
  return git(project, ['check-ignore', '-q', '.env'], options).ok;
}

// The templates of a .env, with placeholders: a project keeps one in git (Phase 7e).
// commitRound still searches them for the values of the project's .env.
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template']);

// A path that must not be committed by a machine: the usual homes of keys and tokens.
// The path is as git prints it, with forward slashes. A folder named secrets counts
// before the name, so secrets/.env.example is one too.
function looksLikeSecret(file) {
  const parts = file.split('/');
  const name = parts.pop().toLowerCase();
  if (parts.some((part) => part.toLowerCase() === 'secrets')) return true;
  if (ENV_TEMPLATES.has(name)) return false;
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.pem') || name.endsWith('.key') || name.startsWith('id_rsa');
}

// The staged files that hold a value of the project's .env (8 characters or more).
// Right after "git add -A" the file in the folder is what is staged, so the folder's
// copy is read. Only the names come back: never a value.
function filesWithSecretValues(project, files) {
  const needles = secretValues(project).map(({ value }) => Buffer.from(value, 'utf8'));
  if (!needles.length) return [];
  const found = [];
  for (const file of files) {
    let bytes;
    try {
      const full = path.join(project, file);
      if (fs.statSync(full).size > CONTENT_CHECK_MAX_BYTES) continue;
      bytes = fs.readFileSync(full);
    } catch {
      continue; // a folder (a submodule), or gone again
    }
    if (needles.some((needle) => bytes.includes(needle))) found.push(file);
  }
  return found;
}

// Commits everything a round changed, as "Loop: round N" (or `message`). Returns one of:
//   { committed: true, commit }       the short hash
//   { committed: false, nothing }     nothing had changed
//   { committed: false, secrets, holders }
//                                     secrets: staged paths that look like secrets;
//                                     holders: staged files that hold a value of the
//                                     project's .env. Nothing was committed, and
//                                     everything was unstaged.
//   { committed: false, error }       git's own message
function commitRound(project, round, { message = `Loop: round ${round}`, ...options } = {}) {
  const add = git(project, ['add', '-A'], options);
  if (!add.ok) return { committed: false, error: `git add failed: ${add.stderr.slice(0, 600)}` };
  const list = (extra) => git(project, ['diff', '--cached', '--name-only', '-z', ...extra], options);
  const staged = list([]);
  if (!staged.ok) return { committed: false, error: `git diff --cached failed: ${staged.stderr.slice(0, 600)}` };
  if (!staged.stdout.split('\0').some(Boolean)) return { committed: false, nothing: true };
  // A staged deletion takes a file out of the repo: only what is added or changed is checked.
  const present = list(['--diff-filter=d']);
  const files = present.stdout.split('\0').filter(Boolean);
  const secrets = files.filter(looksLikeSecret);
  const holders = present.ok ? filesWithSecretValues(project, files.filter((file) => !secrets.includes(file))) : [];
  if (!present.ok || secrets.length || holders.length) {
    const reset = git(project, ['reset', '-q'], options);
    if (!present.ok) return { committed: false, error: `git diff --cached failed: ${present.stderr.slice(0, 600)}` };
    return { committed: false, secrets, holders, unstaged: reset.ok };
  }
  const commit = git(project, ['commit', '-q', '-m', message], options);
  if (!commit.ok) return { committed: false, error: `git commit failed: ${(commit.stderr || commit.stdout).trim().slice(0, 600)}` };
  return { committed: true, commit: git(project, ['rev-parse', '--short', 'HEAD'], options).stdout.trim() };
}

// The commit HEAD points at, in full, or null.
function headCommit(project, options = {}) {
  const r = git(project, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], options);
  return r.ok ? r.stdout.trim() : null;
}

// "git status --short", for a message: { lines, more } with at most `max` lines.
function statusShort(project, max = 20, options = {}) {
  const r = git(project, ['status', '--short'], options);
  if (!r.ok) return { lines: [`(git status failed: ${r.stderr.slice(0, 200)})`], more: 0 };
  const lines = r.stdout.split('\n').filter((line) => line.trim());
  return { lines: lines.slice(0, max), more: Math.max(0, lines.length - max) };
}

// Puts a round's uncommitted work aside: git stash push --include-untracked. Nothing
// is deleted: "git stash list" shows it, and "git stash pop" brings it back.
// Returns { stashed: true, ref } | { stashed: false, nothing: true } | { stashed: false, error }.
function stashRound(project, round, options = {}) {
  const changed = changedPaths(project, options);
  if (changed.error) return { stashed: false, error: changed.error };
  if (!changed.lines.length) return { stashed: false, nothing: true };
  const message = `Loop: round ${round}, cut off`;
  const stash = git(project, ['stash', 'push', '--include-untracked', '-m', message], options);
  if (!stash.ok) return { stashed: false, error: `git stash failed: ${(stash.stderr || stash.stdout).trim().slice(0, 600)}` };
  const left = changedPaths(project, options);
  if (left.error || left.lines.length) {
    return { stashed: false, error: `git stash ran, but the working tree is still not clean: ${left.error || left.lines.slice(0, 5).join(', ')}` };
  }
  return { stashed: true, ref: 'stash@{0}', message };
}

// For LOOP_REPORT.md: the commits from `base` (not included) to HEAD, and what changed.
function historySince(project, base, options = {}) {
  const range = base ? [`${base}..HEAD`] : [];
  const log = git(project, ['log', '--oneline', ...range], options);
  const stat = base ? git(project, ['diff', '--stat', base, 'HEAD', '--', '.', ':(exclude)HANDOFF.md'], options) : { ok: false, stdout: '' };
  return {
    log: log.ok ? log.stdout.trim() : `(git log failed: ${log.stderr.slice(0, 200)})`,
    stat: stat.ok ? stat.stdout.replace(/\s+$/, '') : '',
  };
}

module.exports = {
  git, projectProblem, repoProblem, treeProblem, roundRecords, looksLikeSecret, commitRound, ignoresEnv, headCommit, statusShort, stashRound,
  historySince, filesWithSecretValues,
};
