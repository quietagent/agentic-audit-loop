'use strict';

// A project's .env file: the keys the owner saves with /secret, for the builder to
// work with. The bot writes it and lists its names; the loop and the runners read
// its values only to keep them out of everything they write (lib/redact.js) and out
// of the commits (lib/loop_git.js). No value leaves this file in a message or a log.

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('./runtime');
const { createRedactor, SECRET_MIN_LENGTH } = require('./redact');

const NAME_SHAPE = /^[A-Z_][A-Z0-9_]*$/;
// What a line of the file looks like to the programs that read .env files.
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

const envFile = (project) => path.join(project, '.env');

function readText(project) {
  try {
    return fs.readFileSync(envFile(project), 'utf8').replace(/^﻿/, '');
  } catch {
    return null;
  }
}

// The entries of the file, in order: [{ name, value }]. value is what follows the
// "=", without the spaces around it.
function readEntries(project) {
  const text = readText(project);
  if (text === null) return [];
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const match = LINE.exec(line);
    if (match) entries.push({ name: match[1], value: match[2].trim() });
  }
  return entries;
}

// The names in the file, each once, in order. Never a value.
function envNames(project) {
  return [...new Set(readEntries(project).map((entry) => entry.name))];
}

// The values to keep out of every output: [{ name, value }], 8 characters or more.
// A value can be written in quotes, or with a comment after it; programs read those
// in different ways, so every reading of it counts as the secret.
function secretValues(project) {
  const found = [];
  const seen = new Set();
  const add = (name, value) => {
    if (value.length < SECRET_MIN_LENGTH || seen.has(value)) return;
    seen.add(value);
    found.push({ name, value });
  };
  for (const { name, value } of readEntries(project)) {
    add(name, value);
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) add(name, quoted[2]);
    const commented = /^(.*?)\s+#/.exec(value);
    if (commented && !quoted) add(name, commented[1]);
  }
  return found;
}

// The filter for what a runner writes about a project: its .env values.
function projectRedactor(project) {
  return createRedactor([], secretValues(project));
}

// Sets NAME=value in the project's .env and returns { replaced }. Other lines stay
// as they are. A name that is there already is replaced, on its first line; later
// lines with the same name go.
function setEnvValue(project, name, value) {
  if (!NAME_SHAPE.test(name)) throw new Error('the name is not allowed');
  if (typeof value !== 'string' || !value || /[\r\n\u0000]/.test(value)) throw new Error('the value must be one line of text');
  const text = readText(project);
  const lines = text === null ? [] : text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  let replaced = false;
  const kept = [];
  for (const line of lines) {
    const match = /^\s*#/.test(line) ? null : LINE.exec(line);
    if (match && match[1] === name) {
      if (!replaced) kept.push(`${name}=${value}`);
      replaced = true;
    } else {
      kept.push(line);
    }
  }
  if (!replaced) kept.push(`${name}=${value}`);
  writeFileAtomic(envFile(project), `${kept.join('\n')}\n`);
  return { replaced };
}

module.exports = { readEntries, envNames, secretValues, projectRedactor, setEnvValue, envFile, NAME_SHAPE };
