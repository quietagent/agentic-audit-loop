'use strict';

// Tests the Telegram client (scripts/lib/telegram.js) against a fake Bot API server
// on 127.0.0.1, and the token filter (scripts/lib/redact.js). No real Telegram call.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createTelegram, TelegramError, splitText, inlineKeyboard, MESSAGE_LIMIT } = require('../scripts/lib/telegram');
const { createRedactor, PLACEHOLDER } = require('../scripts/lib/redact');
const { startFakeTelegram } = require('./helpers/fake_telegram');

const TOKEN = '7000000001:CANARYtoken_abcdefghijklmnopqrstuvw';
const KEY = TOKEN.slice(TOKEN.indexOf(':') + 1);

async function setup(t) {
  const fake = await startFakeTelegram({ token: TOKEN });
  t.after(() => fake.close());
  return { fake, telegram: createTelegram({ token: TOKEN, baseUrl: fake.baseUrl, timeoutMs: 3000 }) };
}

async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise((resolve) => { server.close(resolve); });
  return port;
}

test('getUpdates asks for messages and button presses only, with timeout 0 and the offset', async (t) => {
  const { fake, telegram } = await setup(t);
  fake.message(1, 'one');
  fake.message(1, 'two');
  const all = await telegram.getUpdates();
  assert.deepEqual(all.map((u) => u.message.text), ['one', 'two']);
  const later = await telegram.getUpdates({ offset: all[0].update_id + 1 });
  assert.deepEqual(later.map((u) => u.message.text), ['two']);
  assert.deepEqual(fake.callsOf('getUpdates').map((c) => c.params), [
    { timeout: 0, limit: 100, allowed_updates: ['message', 'callback_query'] },
    { timeout: 0, limit: 100, allowed_updates: ['message', 'callback_query'], offset: all[0].update_id + 1 },
  ]);
});

test('sendMessage sends plain text with no parse mode', async (t) => {
  const { fake, telegram } = await setup(t);
  const text = 'a *star*, an _underscore_, a <tag> and a [link](x)';
  await telegram.sendMessage(42, text);
  assert.deepEqual(fake.callsOf('sendMessage')[0].params, { chat_id: 42, text });
  assert.equal(fake.sent[0].parseMode, null);
});

test('a text above 4096 characters is split, and the keyboard hangs on the last part', async (t) => {
  const { fake, telegram } = await setup(t);
  const lines = Array.from({ length: 300 }, (_, i) => `line ${String(i).padStart(3, '0')} ${'x'.repeat(30)}`);
  const text = lines.join('\n');
  assert.ok(text.length > 2 * MESSAGE_LIMIT);
  const keyboard = inlineKeyboard([[{ text: 'Save', data: 'new:save:1' }]]);
  const sent = await telegram.sendMessage(42, text, { replyMarkup: keyboard });
  assert.equal(sent.length, 3);
  const parts = fake.sent.map((s) => s.text);
  assert.ok(parts.every((part) => part.length <= MESSAGE_LIMIT));
  assert.equal(parts.join('\n'), text, 'the parts were cut at line breaks and nothing is lost');
  assert.deepEqual(fake.sent.map((s) => s.replyMarkup), [null, null, keyboard]);
});

test('splitText cuts at a line break, else at a space, else at the limit, and never inside a character', () => {
  assert.deepEqual(splitText('short'), ['short']);
  assert.deepEqual(splitText('aaaa bbbb\ncccc dddd', 12), ['aaaa bbbb', 'cccc dddd']);
  assert.deepEqual(splitText('aaaa bbbb cccc dddd', 12), ['aaaa bbbb', 'cccc dddd']);
  assert.deepEqual(splitText('abcdefghijklmnopqrst', 8), ['abcdefgh', 'ijklmnop', 'qrst']);
  // An emoji is two UTF-16 units: the cut moves in front of it.
  const emoji = '\u{1F600}';
  assert.deepEqual(splitText(`abcdefg${emoji}xyz`, 8), ['abcdefg', `${emoji}xyz`]);
  assert.ok(splitText('y'.repeat(10000)).every((part) => part.length <= MESSAGE_LIMIT));
});

test('sendDocument uploads the file as multipart/form-data', async (t) => {
  const { fake, telegram } = await setup(t);
  await telegram.sendDocument(42, { filename: 'round-01-builder.log', content: 'line one\nline two\n', caption: 'the log' });
  assert.equal(fake.callsOf('sendDocument')[0].contentType, 'multipart/form-data');
  // silent (Phase 7): whether the bot asked for disable_notification. Not here.
  assert.deepEqual(fake.sent[0], { method: 'sendDocument', chatId: 42, caption: 'the log', filename: 'round-01-builder.log', content: 'line one\nline two\n', silent: false });
  await telegram.sendDocument(42, { filename: 'bytes.txt', content: Buffer.from('from a buffer') });
  assert.equal(fake.sent[1].content, 'from a buffer');
  assert.equal(fake.sent[1].caption, null);
});

test('inline keyboards carry callback data, and answerCallbackQuery answers a press', async (t) => {
  const { fake, telegram } = await setup(t);
  const keyboard = inlineKeyboard([[{ text: 'Save', data: 'new:save:abc' }, { text: 'Cancel', data: 'new:cancel:abc' }]]);
  assert.deepEqual(keyboard, { inline_keyboard: [[{ text: 'Save', callback_data: 'new:save:abc' }, { text: 'Cancel', callback_data: 'new:cancel:abc' }]] });
  assert.throws(() => inlineKeyboard([[{ text: 'x', data: 'd'.repeat(65) }]]), /1 to 64 bytes/);
  await telegram.sendMessage(42, 'Save?', { replyMarkup: keyboard });
  assert.deepEqual(fake.sent[0].replyMarkup, keyboard);
  await telegram.answerCallbackQuery('cb-1', { text: 'Saved' });
  await telegram.answerCallbackQuery('cb-2');
  assert.deepEqual(fake.callsOf('answerCallbackQuery').map((c) => c.params), [{ callback_query_id: 'cb-1', text: 'Saved' }, { callback_query_id: 'cb-2' }]);
});

test('getFile and downloadFile fetch a file, and a file above the limit is refused', async (t) => {
  const { fake, telegram } = await setup(t);
  const update = fake.document(42, 'GOAL.md', '# GOAL\nÄÖÜ and العربية\n');
  const info = await telegram.getFile(update.message.document.file_id);
  const bytes = await telegram.downloadFile(info.file_path, { maxBytes: 1000 });
  assert.equal(bytes.toString('utf8'), '# GOAL\nÄÖÜ and العربية\n');
  await assert.rejects(telegram.downloadFile(info.file_path, { maxBytes: 10 }), /larger than 10 bytes/);
});

test('an error names the method, never the URL or the token, and says whether a retry can help', async (t) => {
  const { fake, telegram } = await setup(t);
  const failure = async (promise) => {
    const err = await promise.then(() => null, (e) => e);
    assert.ok(err instanceof TelegramError, 'a TelegramError is thrown');
    assert.equal(err.message.includes(TOKEN) || err.message.includes(KEY) || err.message.includes('http'), false, err.message);
    return err;
  };

  fake.mode = 'unauthorized';
  const unauthorized = await failure(telegram.getUpdates());
  assert.equal(unauthorized.message, 'Telegram getUpdates: 401 Unauthorized');
  assert.deepEqual([unauthorized.status, unauthorized.transient, unauthorized.network], [401, false, false]);

  fake.mode = 'error500';
  const server = await failure(telegram.sendMessage(1, 'x'));
  assert.equal(server.message, 'Telegram sendMessage: 500 Internal Server Error');
  assert.equal(server.transient, true);

  fake.mode = 'hangup';
  const hangup = await failure(telegram.getUpdates());
  assert.match(hangup.message, /^Telegram getUpdates: no answer \(\w+\)$/);
  assert.deepEqual([hangup.transient, hangup.network], [true, true]);

  const refused = await failure(createTelegram({ token: TOKEN, baseUrl: `http://127.0.0.1:${await closedPort()}` }).getUpdates());
  assert.equal(refused.message, 'Telegram getUpdates: no answer (ECONNREFUSED)');
  assert.deepEqual([refused.transient, refused.network], [true, true]);

  fake.mode = 'ok';
  const wrongToken = await failure(createTelegram({ token: '1:wrong', baseUrl: fake.baseUrl }).getFile('x'));
  assert.equal(wrongToken.message, 'Telegram getFile: 401 Unauthorized');
});

test('a server that repeats the token in its error is caught by the filter, not by luck', async (t) => {
  const { fake, telegram } = await setup(t);
  fake.mode = 'echo';
  const err = await telegram.getUpdates().then(() => null, (e) => e);
  assert.ok(err.message.includes(TOKEN), 'this error message does carry the token: the filter has to remove it');
  const redact = createRedactor([TOKEN]);
  assert.equal(redact(err.message), `Telegram getUpdates: 404 Not Found: no method at /bot${PLACEHOLDER}/getUpdates`);
});

test('the filter replaces the token, its key alone and its URL-encoded form', () => {
  const redact = createRedactor([TOKEN]);
  assert.equal(redact(`a ${TOKEN} b`), `a ${PLACEHOLDER} b`);
  assert.equal(redact(`key only: ${KEY}`), `key only: ${PLACEHOLDER}`);
  assert.equal(redact(`encoded: ${encodeURIComponent(TOKEN)}`), `encoded: ${PLACEHOLDER}`);
  assert.equal(redact(`twice ${TOKEN} and ${TOKEN}`), `twice ${PLACEHOLDER} and ${PLACEHOLDER}`);
  assert.equal(redact('nothing secret here'), 'nothing secret here');
  assert.equal(redact(new Error(`boom ${TOKEN}`)), `Error: boom ${PLACEHOLDER}`);
});

test('reach() makes one request without the token and does not follow the redirect', async (t) => {
  const { fake, telegram } = await setup(t);
  assert.equal(await telegram.reach(), 302);
  assert.deepEqual(fake.requests, ['GET /']);
});
