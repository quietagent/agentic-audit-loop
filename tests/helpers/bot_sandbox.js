'use strict';

// A sandbox for the bot and the loop: its own secrets folder (a fake token), runtime
// folder, projects root, n8n env file and config, a fake Telegram server, and a fake
// claude first on PATH (tests/helpers/fake_claude_loop.js).
// Nothing in it touches the real n8n-loop\secrets, n8n-loop\.env, runtime\ or C:\Projects.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { startFakeTelegram } = require('./fake_telegram');

const ROOT = path.resolve(__dirname, '..', '..');
const BOT = path.join(ROOT, 'scripts', 'bot.js');
const FAKE_CLAUDE = path.join(__dirname, 'fake_claude_loop.js');
const DEFAULT_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit_loop.config.json'), 'utf8'));
const TMP = path.join(ROOT, 'tests', 'tmp', 'bot');
const OWNER = 5551234567;
// What the sandbox's n8n env file names, as the real one does. LOOP_TEST_NAMED_IN_ENV_FILE
// has none of the prefixes that clean_env.js knows: only the file can get it removed.
const N8N_ENV_NAMES = ['N8N_PORT', 'N8N_USER_FOLDER', 'TZ', 'NODE_OPTIONS', 'LOOP_TEST_NAMED_IN_ENV_FILE'];

// A token of the right shape that exists nowhere else: the tests search for it.
function canaryToken() {
  return `7000000001:CANARYtoken_${crypto.randomBytes(18).toString('base64url').slice(0, 23)}`;
}

// fakeClaude false leaves PATH alone: the real claude is used (tests/run_real_loop.js).
async function botSandbox(t, { withToken = true, withOwner = true, fakeClaude = true, tmp = TMP, config: configOverrides = {} } = {}) {
  const dir = path.join(tmp, crypto.randomBytes(5).toString('hex'));
  const secretsDir = path.join(dir, 'secrets');
  const runtimeDir = path.join(dir, 'runtime');
  const projectsRoot = path.join(dir, 'projects');
  const bin = path.join(dir, 'bin');
  for (const folder of [secretsDir, projectsRoot, bin]) fs.mkdirSync(folder, { recursive: true });

  const token = canaryToken();
  const fake = await startFakeTelegram({ token });
  if (withToken) fs.writeFileSync(path.join(secretsDir, 'bot-token.txt'), `${token}\r\n`);
  if (withOwner) fs.writeFileSync(path.join(secretsDir, 'owner-chat-id.txt'), `${OWNER}\r\n`);
  if (fakeClaude) fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "${FAKE_CLAUDE}" %*\r\n`);
  const n8nEnvFile = path.join(dir, 'n8n.env');
  fs.writeFileSync(n8nEnvFile, `# like n8n-loop\\.env\r\n${N8N_ENV_NAMES.map((name) => `${name}=value-of-${name}`).join('\r\n')}\r\n`);

  let configs = 0;
  const writeConfig = (overrides = {}) => {
    const file = path.join(dir, `config-${configs += 1}.json`);
    fs.writeFileSync(file, JSON.stringify({
      ...DEFAULT_CONFIG, projectsRoot, secretsDir, runtimeDir, n8nEnvFile, telegramBaseUrl: fake.baseUrl, ...configOverrides, ...overrides,
    }));
    return file;
  };
  const config = writeConfig();
  const recordFile = path.join(dir, 'claude-calls.jsonl');
  const scriptFile = path.join(dir, 'claude-script.json');

  // The environment of a tick: the fake claude first on PATH.
  const env = (extra = {}) => {
    const merged = { ...process.env, FAKE_CLAUDE_RECORD: recordFile, FAKE_LOOP_SCRIPT: scriptFile, ...extra };
    if (fakeClaude) {
      const pathKey = Object.keys(merged).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
      merged[pathKey] = `${bin}${path.delimiter}${merged[pathKey]}`;
    }
    return merged;
  };

  const outputs = [];
  // Runs `node scripts/bot.js <command>` and resolves when it has ended. It must not
  // block this process: the fake Telegram server lives here.
  function bot(command, { configFile = config, extraEnv = {} } = {}) {
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [BOT, command, '--config', configFile], { env: env(extraEnv), windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill(), 60000);
      child.on('close', (status) => {
        clearTimeout(timer);
        outputs.push(stdout, stderr);
        resolve({ status, stdout, stderr, ms: Date.now() - started });
      });
    });
  }

  // A tick with the bot's clock moved by offsetMs, as if the bot had run all the
  // time until then: the note of the last tick is set to 5 seconds before it.
  // gap: true leaves that note alone, as after a time in which no tick ran.
  const lastTickFile = path.join(runtimeDir, 'last-tick.txt');
  const clockConfigs = new Map();
  function tickAt(offsetMs, { gap = false, config: overrides = {}, extraEnv = {} } = {}) {
    const key = JSON.stringify([offsetMs, overrides]);
    if (!clockConfigs.has(key)) clockConfigs.set(key, writeConfig({ ...overrides, testClockOffsetMs: offsetMs }));
    if (!gap) fs.writeFileSync(lastTickFile, `${new Date(Date.now() + offsetMs - 5000).toISOString()}\n`);
    return bot('tick', { configFile: clockConfigs.get(key), extraEnv });
  }

  const logFile = path.join(runtimeDir, 'logs', 'bot.log');
  const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : []);
  const stateFile = path.join(runtimeDir, 'state.json');
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));

  if (t) {
    t.after(async () => {
      await fake.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    });
  }

  return {
    dir, secretsDir, runtimeDir, projectsRoot, bin, token, fake, config, writeConfig, env, outputs, recordFile, scriptFile, stateFile, n8nEnvFile,
    owner: OWNER,
    tick: (options) => bot('tick', options),
    tickAt,
    lastTickFile,
    bot,
    readLog,
    // The log without the time at the start of each line.
    logTexts: () => readLog().map((line) => line.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d /, '')),
    state,
    // Makes the bot's first tick, which only skips what was waiting.
    firstTick: () => bot('tick'),
    // What the fake claude does, call by call: { auditor: [...], builder: [...] }. See fake_claude_loop.js.
    script: (plan) => {
      fs.writeFileSync(scriptFile, JSON.stringify(plan));
      for (const kind of ['auditor', 'builder']) fs.rmSync(`${scriptFile}.${kind}.count`, { force: true });
    },
    // Every call of the fake claude so far.
    calls: () => (fs.existsSync(recordFile)
      ? fs.readFileSync(recordFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : []),
  };
}

// Every file under a folder, as { file, text }.
function filesUnder(folder) {
  const found = [];
  if (!fs.existsSync(folder)) return found;
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full));
    else found.push({ file: full, text: fs.readFileSync(full, 'latin1') });
  }
  return found;
}

module.exports = { botSandbox, filesUnder, OWNER, ROOT, BOT, DEFAULT_CONFIG, N8N_ENV_NAMES };
