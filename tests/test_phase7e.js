'use strict';

// Phase 7e: the texts of this round. AUDITOR.md's "Overnight runs" tells the auditor not to
// assume or name a time of day; README says that .env template files may be committed (and
// are still searched for the values of .env), and that the stop script waits for the
// launcher's lock. looksLikeSecret and commitRound are tested in test_loop.js, the stop
// script in test_launcher.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const section = (text, heading) => text.split(`\n${heading}\n`)[1].split(/\n#{2,3} /)[0];

test('AUDITOR.md, "Overnight runs": no time of day in anything the auditor writes', () => {
  const overnight = section(read('AUDITOR.md'), '## Overnight runs');
  assert.ok(overnight.includes('\n- Do not assume or name a time of day in anything you write (REASON, questions, NEXT_PROMPT): the run may be going on at any hour.\n'), overnight);
});

test('README: the .env template files may be committed and are still searched; the stop script waits for the launcher\'s lock', () => {
  const readme = read('README.md');
  const commit = section(readme, '### The commit');
  assert.match(commit, /A file named exactly `\.env\.example`, `\.env\.sample` or `\.env\.template`, in any folder, is a template with placeholders, not a secret by its name/);
  assert.match(commit, /Under a folder named `secrets` it is still refused\. A template is still searched for the values of `\.env`/);
  assert.doesNotMatch(commit, /so `\.env\.example` too/);

  const stop = section(readme, '### The loop\'s n8n: start and stop');
  assert.match(stop, /Now the stop script waits for it: after the port is free, and after it cancelled a waiting restart, it opens `logs\\n8n-loop\.lock` the way the launcher does/);
  assert.match(stop, /ends with `lock free after N s`, or `lock still held after 10 s: the launcher has not exited yet`/);
  assert.doesNotMatch(stop, /A start in that moment exits quietly with the lock line; start it again\./);
});
