'use strict';

// Reads the bot's two secret files. The owner creates them by hand:
//   bot-token.txt       the Telegram bot token, on one line
//   owner-chat-id.txt   the owner's Telegram chat ID, a whole number
// An error names the file and says what is expected. It never shows what is in the file.

const fs = require('node:fs');
const path = require('node:path');

const TOKEN_FILE = 'bot-token.txt';
const OWNER_FILE = 'owner-chat-id.txt';
// <bot id>:<key>. Telegram's keys are 35 characters today; a little room either way.
const TOKEN_SHAPE = /^\d{5,15}:[A-Za-z0-9_-]{30,50}$/;

class SecretsError extends Error {
  constructor(message, { file, missing }) {
    super(message);
    this.file = file;
    this.missing = missing;
  }
}

// The text of a file as Notepad may have saved it: UTF-8 with or without a mark at
// the start, or UTF-16. Spaces and line breaks around it are dropped.
function readTrimmed(file) {
  const bytes = fs.readFileSync(file);
  const utf16 = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
  return bytes.toString(utf16 ? 'utf16le' : 'utf8').replace(/^﻿/, '').trim();
}

function read(dir, name, howTo) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) {
    throw new SecretsError(`${name} was not found in ${dir}. ${howTo}`, { file, missing: true });
  }
  return { file, text: readTrimmed(file) };
}

function loadToken(dir) {
  const { file, text } = read(dir, TOKEN_FILE, 'Create it with Notepad: the bot token on one line, nothing else.');
  if (!TOKEN_SHAPE.test(text)) {
    throw new SecretsError(`${TOKEN_FILE} in ${dir} does not look like a bot token. It must hold one line: digits, a colon, `
      + 'then about 35 letters, digits, "_" or "-". Its content is not shown here.', { file, missing: false });
  }
  return text;
}

function loadOwnerChatId(dir) {
  const { file, text } = read(dir, OWNER_FILE, 'Run "node scripts\\bot.js whoami" to see your chat ID, then create the file with that number.');
  if (!/^[1-9]\d{0,15}$/.test(text)) {
    throw new SecretsError(`${OWNER_FILE} in ${dir} must hold one whole number above 0, your Telegram chat ID. `
      + 'Its content is not shown here.', { file, missing: false });
  }
  return Number(text);
}

module.exports = { loadToken, loadOwnerChatId, SecretsError, TOKEN_FILE, OWNER_FILE, TOKEN_SHAPE };
