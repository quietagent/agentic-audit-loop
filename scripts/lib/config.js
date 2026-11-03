'use strict';

// Settings of the bot, the loop and the builder runner, from audit_loop.config.json.
// run_auditor.js reads its own keys from the same file.

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_N8N_ENV_FILE } = require('./clean_env');
const { withTestSettings } = require('./test_settings');
const { EFFORT_LEVELS } = require('./claude_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CONFIG = path.join(ROOT, 'audit_loop.config.json');
const DEFAULT_SECRETS_DIR = path.join(ROOT, 'n8n-loop', 'secrets');
const DEFAULT_RUNTIME_DIR = path.join(ROOT, 'runtime');

class ConfigError extends Error {}

const isRule = (value) => typeof value === 'string' && value.trim() !== '';

// The config file, with the test settings of /testmode laid over it. This is the one
// place where runtime\test-settings.json is applied: the bot, the loop, run_auditor.js
// and run_builder.js all read their config here, so none of them can miss a test value.
// testSettings false gives the file as it is: the normal values, for /testmode to show.
function readConfig(file = DEFAULT_CONFIG, { testSettings = true } = {}) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`cannot read config ${file}: ${err.message}`);
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return config;
  // "effort" (Phase 7c) is checked here, where every reader of the file comes through,
  // so that the bot and both runners refuse a bad level alike. null is Claude Code's default.
  if (config.effort != null && !EFFORT_LEVELS.includes(config.effort)) {
    throw new ConfigError(`config ${file}: "effort" must be one of ${EFFORT_LEVELS.join(', ')}, or null for Claude Code's default; got ${JSON.stringify(config.effort)}`);
  }
  if (!testSettings) return config;
  const runtimeDir = path.resolve(typeof config.runtimeDir === 'string' && config.runtimeDir ? config.runtimeDir : DEFAULT_RUNTIME_DIR);
  // The bot's clock is the PC's; only the tests move it, and only with folders of their own.
  const offset = config.secretsDir && Number.isFinite(config.testClockOffsetMs) ? config.testClockOffsetMs : 0;
  return withTestSettings(config, runtimeDir, Date.now() + offset);
}

// The env file of the loop's n8n, whose variables never reach claude. The shipped
// config has no "n8nEnvFile": the tests set it.
function n8nEnvFileOf(config, file) {
  if (config.n8nEnvFile != null && typeof config.n8nEnvFile !== 'string') throw new ConfigError(`config ${file}: "n8nEnvFile" must be a string`);
  return config.n8nEnvFile ? path.resolve(config.n8nEnvFile) : DEFAULT_N8N_ENV_FILE;
}

// What the builder runner needs.
function builderSettings(config, file) {
  if (!Number.isInteger(config.builderMaxTurns) || config.builderMaxTurns <= 0) {
    throw new ConfigError(`config ${file}: "builderMaxTurns" must be a whole number above 0`);
  }
  if (!Array.isArray(config.builderAllowedTools) || !config.builderAllowedTools.length || !config.builderAllowedTools.every(isRule)) {
    throw new ConfigError(`config ${file}: "builderAllowedTools" must be a non-empty list of strings`);
  }
  // Required, so that a config without it cannot quietly drop the git commit, push and reset rules.
  if (!Array.isArray(config.builderDeniedTools) || !config.builderDeniedTools.every(isRule)) {
    throw new ConfigError(`config ${file}: "builderDeniedTools" must be a list of strings`);
  }
  if (config.model != null && typeof config.model !== 'string') {
    throw new ConfigError(`config ${file}: "model" must be a string or null`);
  }
  return {
    maxTurns: config.builderMaxTurns,
    allowedTools: config.builderAllowedTools,
    deniedTools: config.builderDeniedTools,
    model: config.model || null,
    effort: config.effort || null,
    n8nEnvFile: n8nEnvFileOf(config, file),
  };
}

// The timers of the loop's controls (Phase 4), with the value each has when the
// config does not name it.
const TIMERS = {
  stuckBuilderMinutes: 60,
  stuckAuditorMinutes: 20,
  stuckGoalCheckMinutes: 10,
  contextWarnPercent: 80,
  reminderHours: 3,
  defaultAnswerMinutes: 60,
  usageLimitFallbackMinutes: 30,
};

// The two limits of an overnight run (Phase 7). Not test settings of /testmode.
//   overnightSevenDayPercent  an overnight run does not start a round, and /overnight
//                             is refused, when the 7-day window is at this share or above
//   overnightLongPauseHours   a usage-limit pause that would last longer than this ends
//                             an overnight run instead (it stays resumable)
const OVERNIGHT = {
  overnightSevenDayPercent: 70,
  overnightLongPauseHours: 12,
};

// A timer's value from the config: a number above 0.
function timerOf(config, file, key) {
  const value = config[key] == null ? (TIMERS[key] ?? OVERNIGHT[key]) : config[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`config ${file}: "${key}" must be a number above 0`);
  }
  return value;
}

// What the bot and the loop need. secretsDir, runtimeDir, telegramBaseUrl, n8nEnvFile
// and testClockOffsetMs are not in the shipped config: the tests set them to point
// the bot at a fake Telegram server and at folders of their own, and to move its clock.
function botSettings(config, file) {
  if (typeof config.projectsRoot !== 'string' || !path.isAbsolute(config.projectsRoot)) {
    throw new ConfigError(`config ${file}: "projectsRoot" must be an absolute folder path`);
  }
  for (const key of ['secretsDir', 'runtimeDir', 'telegramBaseUrl']) {
    if (config[key] != null && typeof config[key] !== 'string') throw new ConfigError(`config ${file}: "${key}" must be a string`);
  }
  if (!Number.isInteger(config.roundCap) || config.roundCap <= 0) {
    throw new ConfigError(`config ${file}: "roundCap" must be a whole number above 0`);
  }
  if (config.testClockOffsetMs != null && !Number.isFinite(config.testClockOffsetMs)) {
    throw new ConfigError(`config ${file}: "testClockOffsetMs" must be a number`);
  }
  const settings = {
    projectsRoot: path.resolve(config.projectsRoot),
    secretsDir: path.resolve(config.secretsDir || DEFAULT_SECRETS_DIR),
    runtimeDir: path.resolve(config.runtimeDir || DEFAULT_RUNTIME_DIR),
    telegramBaseUrl: config.telegramBaseUrl || null,
    roundCap: config.roundCap,
    n8nEnvFile: n8nEnvFileOf(config, file),
    clockOffsetMs: config.testClockOffsetMs || 0,
    // For the Model line of LOOP_REPORT.md: what the builder and the auditor are started with.
    model: typeof config.model === 'string' && config.model ? config.model : null,
    effort: config.effort || null,
  };
  for (const key of [...Object.keys(TIMERS), ...Object.keys(OVERNIGHT)]) settings[key] = timerOf(config, file, key);
  if (settings.overnightSevenDayPercent > 100) throw new ConfigError(`config ${file}: "overnightSevenDayPercent" must be 100 or less`);
  // The real token only ever goes to Telegram itself, and the real bot's clock is the PC's.
  for (const key of ['telegramBaseUrl', 'testClockOffsetMs']) {
    if (config[key] && settings.secretsDir === DEFAULT_SECRETS_DIR) {
      throw new ConfigError(`config ${file}: "${key}" is for tests and needs a "secretsDir" of its own${key === 'telegramBaseUrl' ? '; the real token is never sent to another server' : ''}`);
    }
  }
  return settings;
}

module.exports = { readConfig, builderSettings, botSettings, timerOf, ConfigError, ROOT, DEFAULT_CONFIG, DEFAULT_SECRETS_DIR, DEFAULT_RUNTIME_DIR, TIMERS, OVERNIGHT };
