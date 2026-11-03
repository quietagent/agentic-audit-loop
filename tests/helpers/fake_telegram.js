'use strict';

// A fake Telegram Bot API server on 127.0.0.1 for the bot's tests. It knows one
// token and answers 401 for any other. Tests queue updates with message(),
// document() and press(), and read back what the bot sent in `sent`.
//
// mode changes how it answers:
//   ok            as Telegram would
//   unauthorized  401 for every call, as with a wrong token
//   echo          a 404 whose description repeats the request path, token included
//   error500      500 with a Bot API error body
//   hangup        the connection is closed without an answer
//
// outage() (Phase 7b) makes Telegram unreachable for some methods, for the next N calls
// or until outage(null):
//   fake.outage({ methods: ['getUpdates'], how: 'drop', times: 20 })
//   how      'drop' closes the connection at once, without an answer: the bot gets a
//            network error at once, as with a refused or reset connection;
//            'timeout' never answers: the bot's own 10-second timeout ends the call.
//   methods  the API methods that get no answer; null for every call.
//   times    how many calls get no answer; leave it out for "until outage(null)".
// fake.unanswered lists those calls: { method, how }.

const http = require('node:http');

function parseMultipart(buffer, boundary) {
  const fields = {};
  const text = buffer.toString('latin1');
  for (const part of text.split(`--${boundary}`)) {
    const split = part.indexOf('\r\n\r\n');
    if (split === -1) continue;
    const head = part.slice(0, split);
    const body = part.slice(split + 4).replace(/\r\n$/, '');
    const name = /name="([^"]*)"/.exec(head);
    if (!name) continue;
    const filename = /filename="([^"]*)"/.exec(head);
    fields[name[1]] = filename
      ? { filename: filename[1], content: Buffer.from(body, 'latin1').toString('utf8') }
      : Buffer.from(body, 'latin1').toString('utf8');
  }
  return fields;
}

async function startFakeTelegram({ token }) {
  const fake = {
    mode: 'ok',
    modeFor: {},
    requests: [],
    updates: [],
    files: new Map(),
    calls: [],
    sent: [],
    // deleteMessage: what the bot deleted; undeletable makes Telegram refuse it.
    deleted: [],
    undeletable: false,
    nextUpdateId: 1000,
    nextMessageId: 1,
    nextFileId: 1,
    // Phase 7b: the calls that got no answer during an outage.
    cut: null,
    unanswered: [],
  };
  fake.outage = (spec) => {
    fake.cut = spec ? { methods: spec.methods === undefined ? ['getUpdates'] : spec.methods, how: spec.how || 'drop', times: spec.times ?? Infinity } : null;
  };

  const queue = (update) => {
    const full = { update_id: fake.nextUpdateId, ...update };
    fake.nextUpdateId += 1;
    fake.updates.push(full);
    return full;
  };
  const chatOf = (id, type = 'private') => ({ id, type });
  const userOf = (id, username) => ({ id, is_bot: false, first_name: 'Test', last_name: 'User', ...(username ? { username } : {}) });

  // A text message. `from` is the sender's user ID (default: the same as the chat).
  // entities: the formatting Telegram found in it, as [{ type, offset, length }].
  fake.message = (chatId, text, { from = chatId, username = 'owner_name', chatType = 'private', entities = null } = {}) => queue({
    message: {
      message_id: fake.nextMessageId++, date: 0, chat: chatOf(chatId, chatType), from: userOf(from, username), text, ...(entities ? { entities } : {}),
    },
  });
  // A file sent as a document. `declaredSize` lets a test lie about the size.
  fake.document = (chatId, fileName, content, { declaredSize = null } = {}) => {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const fileId = `file-${fake.nextFileId++}`;
    fake.files.set(fileId, { path: `documents/${fileId}`, bytes });
    return queue({
      message: {
        message_id: fake.nextMessageId++, date: 0, chat: chatOf(chatId), from: userOf(chatId, 'owner_name'),
        document: { file_id: fileId, file_name: fileName, file_size: declaredSize ?? bytes.length },
      },
    });
  };
  // A press on an inline button.
  fake.press = (chatId, data, { from = chatId, username = 'owner_name', chatType = 'private' } = {}) => queue({
    callback_query: {
      id: `cb-${fake.nextUpdateId}`, from: userOf(from, username), data,
      message: { message_id: 1, date: 0, chat: chatOf(chatId, chatType) },
    },
  });
  fake.sentTexts = () => fake.sent.filter((s) => s.method === 'sendMessage').map((s) => s.text);
  fake.callsOf = (method) => fake.calls.filter((c) => c.method === method);

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const reply = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (fake.mode === 'hangup') {
        req.socket.destroy();
        return;
      }
      // An outage (Phase 7b): no answer for the methods it names.
      const cut = fake.cut;
      const called = (/^\/bot[^/]+\/(\w+)$/.exec(req.url) || [])[1] || req.url;
      if (cut && cut.times > 0 && (!cut.methods || cut.methods.includes(called))) {
        cut.times -= 1;
        if (cut.times <= 0) fake.cut = null;
        fake.unanswered.push({ method: called, how: cut.how });
        // 'timeout': the request stays open until the bot gives up; closing the server ends it.
        if (cut.how !== 'timeout') req.socket.destroy();
        return;
      }
      fake.requests.push(`${req.method} ${req.url}`);
      if (req.url === '/') {
        res.writeHead(302, { location: 'https://core.telegram.org/bots' });
        res.end();
        return;
      }
      const file = /^\/file\/bot([^/]+)\/(.+)$/.exec(req.url);
      const api = /^\/bot([^/]+)\/(\w+)$/.exec(req.url);
      const given = (file || api || [])[1];
      // modeFor lets a test break one method only, for example { sendMessage: 'error500' }.
      const mode = (api && fake.modeFor[api[2]]) || fake.mode;
      if (mode === 'echo') return reply(404, { ok: false, error_code: 404, description: `Not Found: no method at ${req.url}` });
      if (mode === 'error500') return reply(500, { ok: false, error_code: 500, description: 'Internal Server Error' });
      if (mode === 'unauthorized' || given !== token) return reply(401, { ok: false, error_code: 401, description: 'Unauthorized' });

      if (file) {
        const found = [...fake.files.values()].find((f) => f.path === file[2]);
        if (!found) return reply(404, { ok: false, error_code: 404, description: 'Not Found' });
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': found.bytes.length });
        res.end(found.bytes);
        return;
      }
      if (!api) return reply(404, { ok: false, error_code: 404, description: 'Not Found' });

      const method = api[2];
      const type = req.headers['content-type'] || '';
      const multipart = /^multipart\/form-data; boundary=(.+)$/.exec(type);
      const params = multipart ? parseMultipart(body, multipart[1]) : JSON.parse(body.toString('utf8') || '{}');
      fake.calls.push({ method, params, contentType: type.split(';')[0] });

      if (method === 'getUpdates') {
        const offset = params.offset ?? 0;
        // As Telegram does: an offset confirms and drops everything before it.
        fake.updates = fake.updates.filter((u) => u.update_id >= offset);
        return reply(200, { ok: true, result: fake.updates.slice(0, params.limit || 100) });
      }
      // disable_notification (Phase 7: the silent messages of an overnight run) is kept
      // as `silent` on what was sent: true only when the bot asked for it.
      const silent = params.disable_notification === true || params.disable_notification === 'true';
      if (method === 'sendMessage') {
        if (typeof params.text !== 'string' || !params.text.length || params.text.length > 4096) {
          return reply(400, { ok: false, error_code: 400, description: 'Bad Request: message text is empty or too long' });
        }
        fake.sent.push({ method, chatId: params.chat_id, text: params.text, replyMarkup: params.reply_markup || null, parseMode: params.parse_mode ?? null, silent });
        return reply(200, { ok: true, result: { message_id: fake.nextMessageId++, chat: chatOf(params.chat_id), text: params.text } });
      }
      if (method === 'sendDocument') {
        fake.sent.push({ method, chatId: Number(params.chat_id), caption: params.caption ?? null, filename: params.document.filename, content: params.document.content, silent });
        return reply(200, { ok: true, result: { message_id: fake.nextMessageId++ } });
      }
      if (method === 'answerCallbackQuery') {
        fake.sent.push({ method, id: params.callback_query_id, text: params.text ?? null });
        return reply(200, { ok: true, result: true });
      }
      if (method === 'deleteMessage') {
        // As Telegram: a bot can delete a message it received in a private chat.
        if (fake.undeletable) return reply(400, { ok: false, error_code: 400, description: 'Bad Request: message can\'t be deleted' });
        fake.deleted.push({ chatId: params.chat_id, messageId: params.message_id });
        return reply(200, { ok: true, result: true });
      }
      if (method === 'getFile') {
        const found = fake.files.get(params.file_id);
        if (!found) return reply(400, { ok: false, error_code: 400, description: 'Bad Request: file not found' });
        return reply(200, { ok: true, result: { file_id: params.file_id, file_size: found.bytes.length, file_path: found.path } });
      }
      return reply(404, { ok: false, error_code: 404, description: 'Not Found: method not found' });
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  fake.port = server.address().port;
  fake.baseUrl = `http://127.0.0.1:${fake.port}`;
  fake.close = () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
  return fake;
}

module.exports = { startFakeTelegram };
