'use strict';

// Secrets must never show up in a log, on stdout or stderr, in an error message or
// in a file the loop writes. There are two kinds:
//   - the bot token. Errors are the risk: the token is part of every Bot API URL.
//   - the values in a project's .env (the keys the owner saved with /secret). The
//     builder works with them, so they can turn up in anything it prints.
// So every line the bot and the runners write goes through a redactor that replaces them.

const PLACEHOLDER = '<bot-token>';
// A shorter value would be replaced inside ordinary words.
const SECRET_MIN_LENGTH = 8;

const secretPlaceholder = (name) => `<secret:${name}>`;

// The forms a secret can take in a text: as it is, URL-encoded, and the way JSON
// writes it (a quote or a backslash in it gets a backslash in front).
function formsOf(value) {
  const forms = new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
  forms.delete('');
  return [...forms];
}

// Returns a function that replaces every secret in a text. For a bot token
// ("<bot id>:<key>") the key alone and the URL-encoded token are replaced too.
// named: [{ name, value }], the values of a project's .env: each is replaced by
// <secret:NAME>. The function has .add(name, value) for a value that turns up
// later (a /secret message in this tick), and .count.
function createRedactor(secrets = [], named = []) {
  const needles = new Map();
  let ordered = [];
  const put = (needle, placeholder) => {
    if (typeof needle === 'string' && needle && !needles.has(needle)) needles.set(needle, placeholder);
  };
  const sort = () => {
    // The longest first: a secret that holds another one is replaced whole.
    ordered = [...needles].sort((a, b) => b[0].length - a[0].length);
  };
  for (const secret of secrets) {
    if (typeof secret !== 'string' || !secret) continue;
    for (const form of formsOf(secret)) put(form, PLACEHOLDER);
    const key = secret.slice(secret.indexOf(':') + 1);
    if (key.length >= 20) put(key, PLACEHOLDER);
  }
  const addNamed = (name, value) => {
    if (typeof value !== 'string' || value.length < SECRET_MIN_LENGTH) return false;
    for (const form of formsOf(value)) put(form, secretPlaceholder(name));
    return true;
  };
  for (const { name, value } of named) addNamed(name, value);
  sort();

  const redact = (value) => {
    let text = typeof value === 'string' ? value : String(value);
    for (const [needle, placeholder] of ordered) {
      if (text.includes(needle)) text = text.split(needle).join(placeholder);
    }
    return text;
  };
  redact.add = (name, value) => {
    const added = addNamed(name, value);
    if (added) sort();
    return added;
  };
  Object.defineProperty(redact, 'count', { get: () => needles.size });
  return redact;
}

// A second net under the first: whatever reaches stdout or stderr of this process
// by another way (a warning from Node, a forgotten console.log) is redacted as well.
function guardOutput(redact) {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => write(redact(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)), ...rest);
  }
}

module.exports = { createRedactor, guardOutput, secretPlaceholder, PLACEHOLDER, SECRET_MIN_LENGTH };
