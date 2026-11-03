'use strict';

// Test settings: short timers for a test run, switched on and off from Telegram with
// /testmode. The bot keeps them in runtime\test-settings.json:
//   { "values": { "defaultAnswerMinutes": 2, ... }, "changedAt": "<ISO time>", "expiresAt": "<ISO time>" }
// Only the bot writes that file, when the owner sends /testmode.
//
// They are applied in one place: readConfig() in lib/config.js lays the values over
// the config it has just read. The bot, the loop, run_auditor.js and run_builder.js
// all read their config through it, so none of them can miss a test value, and none
// of them knows about the file.
//
// They cannot be forgotten: 24 hours after the last /testmode change they no longer
// count, whoever reads the file. The bot's next tick then removes the file and says so.

const fs = require('node:fs');
const path = require('node:path');
const { readJsonSafe, writeFileAtomic, isPlainObject } = require('./runtime');

// The only keys /testmode knows, and so the only ones ever read from the file.
// Each is a number above 0: no path, URL, token or folder can come in this way.
const KEYS = ['defaultAnswerMinutes', 'reminderHours', 'contextWarnPercent', 'stuckBuilderMinutes', 'stuckAuditorMinutes', 'stuckGoalCheckMinutes'];
// /testmode on: the timers of the main test run. A default answer after 2 minutes,
// and a reminder every 5.
const PRESET = { defaultAnswerMinutes: 2, reminderHours: 5 / 60 };
const LIFETIME_MS = 24 * 60 * 60 * 1000;
const VALUE_SHAPE = /^(\d+(\.\d+)?|\.\d+)$/;

const testSettingsFile = (runtimeDir) => path.join(runtimeDir, 'test-settings.json');
const usable = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

// The allowed keys of an object that hold a usable value, in the order of KEYS.
function pick(values) {
  const picked = {};
  if (!isPlainObject(values)) return picked;
  for (const key of KEYS) if (usable(values[key])) picked[key] = values[key];
  return picked;
}

// What the file says, without ever throwing:
//   present    the file is there
//   on         it holds at least one value, and is younger than 24 hours
//   expired    it holds values, and its last change is 24 hours ago or more
//   values     { key: number }, only the allowed keys
//   changedAt, expiresAt   in ms since 1970, or null
// A file that cannot be read, or that has no time of its last change, is present and
// not on: its age cannot be told, so its values do not count.
function readTestSettings(runtimeDir, nowMs = Date.now()) {
  const file = testSettingsFile(runtimeDir);
  const off = { present: fs.existsSync(file), on: false, expired: false, values: {}, changedAt: null, expiresAt: null };
  if (!off.present) return off;
  const read = readJsonSafe(file);
  const changedAt = read.value ? Date.parse(read.value.changedAt) : NaN;
  if (!read.value || Number.isNaN(changedAt)) return off;
  const values = pick(read.value.values);
  const any = Object.keys(values).length > 0;
  const expiresAt = changedAt + LIFETIME_MS;
  const expired = any && nowMs >= expiresAt;
  return { present: true, on: any && !expired, expired, values, changedAt, expiresAt };
}

// Saves the values, with now as the time of the last change. Without a usable value
// the file is removed.
function writeTestSettings(runtimeDir, values, nowMs = Date.now()) {
  const picked = pick(values);
  if (!Object.keys(picked).length) return clearTestSettings(runtimeDir);
  writeFileAtomic(testSettingsFile(runtimeDir), `${JSON.stringify({
    values: picked,
    changedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + LIFETIME_MS).toISOString(),
  }, null, 2)}\n`);
  return true;
}

// Returns true when no file is left.
function clearTestSettings(runtimeDir) {
  const file = testSettingsFile(runtimeDir);
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // still there: the caller sees it
  }
  return !fs.existsSync(file);
}

// A config with the test values laid over it. Values that are 24 hours old do not count.
function withTestSettings(config, runtimeDir, nowMs = Date.now()) {
  const test = readTestSettings(runtimeDir, nowMs);
  return test.on ? { ...config, ...test.values } : config;
}

// 0.08333... is shown as 0.0833.
const showValue = (value) => String(Number(Number(value).toFixed(4)));

// "defaultAnswerMinutes=2, reminderHours=0.0833", in the order of KEYS. '' for none.
function describeTestSettings(values) {
  return Object.entries(pick(values)).map(([key, value]) => `${key}=${showValue(value)}`).join(', ');
}

// The line that /status starts with, and that the loop's start and end messages carry.
const testSettingsLine = (values) => `TEST SETTINGS ON: ${describeTestSettings(values)}`;

// The key as /testmode set names it, in any letter case, or null.
function canonicalKey(text) {
  const wanted = String(text).toLowerCase();
  return KEYS.find((key) => key.toLowerCase() === wanted) || null;
}

// A number above 0, written with digits and at most one point, or null.
function parseValue(text) {
  if (!VALUE_SHAPE.test(String(text))) return null;
  const value = Number(text);
  return usable(value) ? value : null;
}

module.exports = {
  KEYS, PRESET, LIFETIME_MS, testSettingsFile, readTestSettings, writeTestSettings, clearTestSettings, withTestSettings,
  describeTestSettings, testSettingsLine, showValue, canonicalKey, parseValue,
};
