'use strict';

// Small helper for start-n8n-loop.cmd and stop-n8n-loop.cmd: a .cmd file has no
// reliable clock of its own (%date% and %time% follow the regional settings).
//
//   node launcher-util.js log <file> <text>   append "<local time> <text>" to logs\<file>
//   node launcher-util.js epoch               print the time in whole seconds
//
// The logs folder is the one next to this file.

const fs = require('node:fs');
const path = require('node:path');

function localStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} `
    + `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())} ${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'epoch') {
  process.stdout.write(`${Math.floor(Date.now() / 1000)}\n`);
} else if (command === 'log' && rest.length >= 2 && /^[\w.-]+$/.test(rest[0])) {
  const logs = path.join(__dirname, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.appendFileSync(path.join(logs, rest[0]), `${localStamp()} ${rest.slice(1).join(' ')}\r\n`);
} else {
  process.stderr.write('usage: node launcher-util.js log <file> <text> | epoch\n');
  process.exitCode = 2;
}
