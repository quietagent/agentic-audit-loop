'use strict';

// Projects of the loop: the rules for a project name, and creating a new project
// folder (git repo, .gitignore, GOAL.md, the first prompt) under the projects root.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeGitArgs } = require('./safe_git');
const { cleanEnv } = require('./clean_env');

const NAME_MAX = 40;
// Windows device names: a folder cannot be called this, with or without an extension.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

// Returns null for a good name, else the reason as a sentence.
function nameProblem(name) {
  if (typeof name !== 'string' || !name) return 'A project needs a name.';
  if (name.length > NAME_MAX) return `The name is ${name.length} characters long. The limit is ${NAME_MAX}.`;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return 'The name may only have letters (a-z, A-Z), digits, "-" and "_".';
  // A leading "-" would read as an option on a command line.
  if (!/^[A-Za-z0-9]/.test(name)) return 'The name must start with a letter or a digit.';
  if (RESERVED.test(name)) return `"${name}" is a name that Windows keeps for itself.`;
  return null;
}

// The entry of the projects root that has this name in any letter case, or null.
function existingEntry(root, name) {
  const wanted = name.toLowerCase();
  return fs.readdirSync(root).find((entry) => entry.toLowerCase() === wanted) || null;
}

// Like every git call of the loop's own: no hooks, no fsmonitor (lib/safe_git.js), and
// the clean environment of lib/clean_env.js, as in lib/loop_git.js. Without it git got
// the settings of the loop's n8n, among them TZ=Asia/Tokyo, a name Git for Windows
// cannot read: the first commit of a new project had the wrong UTC offset.
// n8nEnvFile names the env file of the loop's n8n (default: n8n-loop\.env).
function git(cwd, args, { n8nEnvFile } = {}) {
  const r = spawnSync('git', [...safeGitArgs(), ...args], { cwd, encoding: 'utf8', windowsHide: true, env: cleanEnv(process.env, { envFile: n8nEnvFile }) });
  if (r.error) throw new Error(`could not run git: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  return r.stdout.trim();
}

const withFinalNewline = (text) => (text.endsWith('\n') ? text : `${text}\n`);

// What a new project's .gitignore starts with: the loop's own records, and the usual
// file for secrets, so that the loop's commits pick up neither.
const GITIGNORE = '.audit/\n.env\n';

// Creates <root>/<name>: a git repo with .gitignore (.audit/ and .env) and GOAL.md committed
// as "Loop: GOAL.md", and the first prompt in .audit/round-01-prompt.md.
// Nothing exists before this call. If a step fails, the folder is removed again.
function createProject({ root, name, goal, prompt, n8nEnvFile }) {
  const problem = nameProblem(name);
  if (problem) throw new Error(problem);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`the projects root ${root} does not exist`);
  const taken = existingEntry(root, name);
  if (taken) throw new Error(`"${taken}" already exists in ${root}`);

  const dir = path.join(root, name);
  fs.mkdirSync(dir); // fails if it exists: from here on the folder is ours
  const options = { n8nEnvFile };
  try {
    git(dir, ['init', '-q'], options);
    fs.writeFileSync(path.join(dir, '.gitignore'), GITIGNORE);
    fs.writeFileSync(path.join(dir, 'GOAL.md'), withFinalNewline(goal));
    git(dir, ['add', '--', '.gitignore', 'GOAL.md'], options);
    git(dir, ['commit', '-q', '-m', 'Loop: GOAL.md'], options);
    const commit = git(dir, ['rev-parse', '--short', 'HEAD'], options);
    fs.mkdirSync(path.join(dir, '.audit'));
    fs.writeFileSync(path.join(dir, '.audit', 'round-01-prompt.md'), withFinalNewline(prompt));
    return { dir, commit };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw err;
  }
}

function roundFile(project, round, suffix) {
  return path.join(project, '.audit', `round-${String(round).padStart(2, '0')}-${suffix}`);
}

module.exports = { nameProblem, existingEntry, createProject, roundFile, NAME_MAX, GITIGNORE };
