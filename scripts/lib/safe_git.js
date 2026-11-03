'use strict';

// The options in front of every git call that the loop makes itself in a project:
// the checks before a loop, the commit, the stash, and the auditor's status and diff.
//
// A project's .git folder is the project's own. Through .git\hooks, or through
// .git\config (core.hooksPath, core.fsmonitor), it could make the loop's git run a
// program: on every commit, and with fsmonitor on every "git status". So:
//   core.hooksPath=<an empty folder>   no hook of the project is ever found
//   core.fsmonitor=false               git asks no outside program what changed
// An option given with -c wins over the project's own config.
//
// The empty folder is .no-hooks\ in this repo (not in git). It is made when it is
// missing, and it must stay empty: a file in it could be a hook, so git is then not
// run at all.

const fs = require('node:fs');
const path = require('node:path');

const NO_HOOKS_DIR = path.resolve(__dirname, '..', '..', '.no-hooks');

function noHooksDir() {
  fs.mkdirSync(NO_HOOKS_DIR, { recursive: true });
  const found = fs.readdirSync(NO_HOOKS_DIR);
  if (found.length) {
    throw new Error(`${NO_HOOKS_DIR} must be an empty folder, and it holds ${found.length === 1 ? `"${found[0]}"` : `${found.length} entries`}. `
      + 'Empty it: git is told to look for hooks there, so that a project\'s own hooks never run.');
  }
  return NO_HOOKS_DIR;
}

// The arguments that go between "git" and the command.
function safeGitArgs() {
  return [
    '-c', `core.hooksPath=${noHooksDir().replace(/\\/g, '/')}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.quotepath=false',
    '-c', 'color.ui=false',
  ];
}

module.exports = { safeGitArgs, noHooksDir, NO_HOOKS_DIR };
