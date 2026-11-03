'use strict';

// Tests scripts/lib/clean_env.js: the environment that the loop's jobs, the builder
// and the auditor get. No test here reads the real n8n-loop\.env: each names an env
// file of its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { cleanEnv, isRemoved, envFileNames } = require('../scripts/lib/clean_env');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(__dirname, 'tmp', 'clean_env');
const NO_FILE = path.join(TMP, 'there-is-no-such-file.env');

function envFile(t, text) {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `${crypto.randomBytes(5).toString('hex')}.env`);
  fs.writeFileSync(file, text);
  t.after(() => fs.rmSync(file, { force: true }));
  return file;
}

test('NODE_OPTIONS and what a Claude Code session sets are removed, the rest is kept', () => {
  const env = cleanEnv({
    Path: 'C:/Windows',
    USERPROFILE: 'C:/Users/someone',
    NODE_OPTIONS: '--require=C:/somewhere/dns-fallback.cjs',
    CLAUDECODE: '1',
    CLAUDE_PID: '4776',
    CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
    CLAUDE_CODE_SESSION_ID: 'abc',
    CLAUDE_AGENT_SDK_VERSION: '0.3.295',
    AI_AGENT: 'claude-code',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    DISABLE_MICROCOMPACT: '1',
    GIT_EDITOR: 'true',
    NoDefaultCurrentDirectoryInExePath: '1',
    'SENTRY-TRACE': 'x',
    TZ: 'Asia/Tokyo',
    ANTHROPIC_API_KEY: 'kept: a user-level setting, not a session variable',
  }, { envFile: NO_FILE });
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'Path', 'TZ', 'USERPROFILE']);
});

test('the settings of the loop\'s n8n are removed: by prefix, by name, and by the names in its env file', (t) => {
  const file = envFile(t, [
    '\uFEFF# Settings of the loop\'s own n8n',
    'N8N_PORT=5690',
    'TZ=Asia/Tokyo',
    'my_own_setting=lower case in the file',
    'WITH_EQUALS=a=b=c',
    '',
    '# COMMENTED_OUT=1',
    'a line without an equals sign',
    'NODE_OPTIONS=--require=C:\\somewhere\\dns-fallback.cjs',
  ].join('\r\n'));
  const env = cleanEnv({
    // by prefix
    N8N_USER_FOLDER: 'C:/loop/data',
    n8n_port: '5690',
    N8N_ENCRYPTION_KEY: 'x',
    NODES_EXCLUDE: '[]',
    NODES_INCLUDE: '[]',
    EXECUTIONS_DATA_PRUNE: 'true',
    DB_TYPE: 'sqlite',
    DB_SQLITE_POOL_SIZE: '1',
    QUEUE_BULL_REDIS_HOST: 'localhost',
    // by name
    WEBHOOK_URL: 'http://localhost:5690/',
    GENERIC_TIMEZONE: 'Asia/Tokyo',
    DNS_FALLBACK_QUIET: '1',
    // only because the file names them
    TZ: 'Asia/Tokyo',
    MY_OWN_SETTING: '1',
    WITH_EQUALS: 'a=b=c',
    // kept
    COMMENTED_OUT: '1',
    DATABASE_URL: 'not an n8n name',
    NODE_ENV: 'test',
    QUEUED: '1',
    Path: 'C:/Windows',
  }, { envFile: file });
  assert.deepEqual(Object.keys(env).sort(), ['COMMENTED_OUT', 'DATABASE_URL', 'NODE_ENV', 'Path', 'QUEUED']);
});

test('only the names are read from the env file, never a value', (t) => {
  const file = envFile(t, 'FIRST=SECRET_VALUE_ONE\r\nSECOND=SECRET_VALUE_TWO=AND_MORE\nTHIRD=\n=NO_NAME\nspaced = SECRET_VALUE_THREE\n');
  const names = envFileNames(file);
  // cmd.exe would call the last one "spaced " with the space: both spellings are named.
  assert.deepEqual([...names].sort(), ['FIRST', 'SECOND', 'SPACED', 'SPACED ', 'THIRD']);
  assert.equal(/SECRET_VALUE|AND_MORE|NO_NAME/.test(JSON.stringify([...names])), false);
  // A file that is not there names nothing, and is not an error.
  assert.deepEqual([...envFileNames(NO_FILE)], []);
  assert.deepEqual(cleanEnv({ KEEP: '1', TZ: 'x' }, { envFile: NO_FILE }), { KEEP: '1', TZ: 'x' });
});

test('every setting of the shipped .env.example is removed, and so is the line the owner adds for Execute Command', () => {
  const example = path.join(ROOT, 'n8n-loop', '.env.example');
  const names = [...envFileNames(example)];
  assert.ok(names.includes('N8N_USER_FOLDER') && names.includes('TZ') && names.includes('NODE_OPTIONS') && names.includes('GENERIC_TIMEZONE'), names.join(' '));
  const like = Object.fromEntries([...names, 'NODES_EXCLUDE'].map((name) => [name, 'value']));
  assert.deepEqual(cleanEnv({ ...like, KEPT: '1' }, { envFile: example }), { KEPT: '1' });
});

test('PATH is never removed, even when the env file names it', (t) => {
  const file = envFile(t, 'PATH=C:\\other\r\nPath=again\r\nOTHER=1\r\n');
  assert.deepEqual(cleanEnv({ Path: 'C:/Windows', OTHER: '1', PATHEXT: '.EXE' }, { envFile: file }), { Path: 'C:/Windows', PATHEXT: '.EXE' });
});

test('names are matched without regard to case', () => {
  assert.equal(isRemoved('node_options'), true);
  assert.equal(isRemoved('ClaudeCode'), true);
  assert.equal(isRemoved('claude_code_anything'), true);
  assert.equal(isRemoved('n8n_port'), true);
  assert.equal(isRemoved('Webhook_Url'), true);
  assert.equal(isRemoved('CLAUDE_CONFIG_DIR'), false);
  assert.equal(isRemoved('PATH'), false);
  assert.equal(isRemoved('tz'), false);
  assert.equal(isRemoved('tz', new Set(['TZ'])), true);
});

test('the environment object that was passed in is left as it was', () => {
  const base = { NODE_OPTIONS: 'x', N8N_PORT: '5690', KEEP: '1' };
  const env = cleanEnv(base, { envFile: NO_FILE });
  assert.deepEqual(base, { NODE_OPTIONS: 'x', N8N_PORT: '5690', KEEP: '1' });
  assert.deepEqual(env, { KEEP: '1' });
});
