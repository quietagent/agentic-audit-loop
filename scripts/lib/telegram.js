'use strict';

// A small Telegram Bot API client on Node's own fetch: no npm packages.
// It only polls (getUpdates): nothing has to reach this PC from outside.
// The base URL can be changed so that the tests talk to a fake server on 127.0.0.1.
//
// Errors are TelegramError. Their message names the API method and never the URL,
// because the URL holds the bot token. "transient" says whether a retry can help.

const DEFAULT_BASE_URL = 'https://api.telegram.org';
const MESSAGE_LIMIT = 4096; // UTF-16 units, as Telegram counts a message
const CAPTION_LIMIT = 1024;
const ALLOWED_UPDATES = ['message', 'callback_query'];

class TelegramError extends Error {
  constructor(message, { method, status = null, transient, network = false, retryAfter = null }) {
    super(message);
    this.method = method;
    this.status = status;
    this.transient = transient;
    this.network = network;
    this.retryAfter = retryAfter;
  }
}

// Cuts a text into pieces of at most `limit` UTF-16 units: at a line break when one
// is in the second half of the piece, else at a space, else right at the limit.
function splitText(text, limit = MESSAGE_LIMIT) {
  const parts = [];
  let rest = String(text);
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    // Never between the two halves of one character.
    if (cut === limit && /[\uD800-\uDBFF]/.test(rest[cut - 1])) cut -= 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[ \n]/, '');
  }
  if (rest.length || !parts.length) parts.push(rest);
  return parts;
}

// rows: [[{ text, data }, ...], ...]. Telegram allows 1 to 64 bytes of callback data.
function inlineKeyboard(rows) {
  return {
    inline_keyboard: rows.map((row) => row.map(({ text, data }) => {
      const bytes = Buffer.byteLength(data, 'utf8');
      if (bytes < 1 || bytes > 64) throw new Error(`callback data must be 1 to 64 bytes, got ${bytes}`);
      return { text, callback_data: data };
    })),
  };
}

function createTelegram({ token, baseUrl = DEFAULT_BASE_URL, timeoutMs = 10000, fetchImpl = fetch }) {
  const root = String(baseUrl).replace(/\/+$/, '');

  // One HTTP request. Redirects are not followed: the Bot API has none, and a
  // redirect must never carry the token to another host.
  async function request(method, url, init = {}) {
    try {
      return await fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // fetch wraps the real reason in err.cause; a timeout has none and is named TimeoutError.
      const code = (err.cause && (err.cause.code || err.cause.name)) || err.name || 'error';
      throw new TelegramError(`Telegram ${method}: no answer (${code})`, { method, transient: true, network: true });
    }
  }

  async function call(method, body) {
    const init = body instanceof FormData
      ? { method: 'POST', body }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) };
    const response = await request(method, `${root}/bot${token}/${method}`, init);
    let answer = null;
    try {
      answer = await response.json();
    } catch {
      // handled below: not a Bot API answer
    }
    if (!answer || typeof answer !== 'object' || typeof answer.ok !== 'boolean') {
      throw new TelegramError(`Telegram ${method}: HTTP ${response.status}, not a Bot API answer`,
        { method, status: response.status, transient: response.status >= 500 });
    }
    if (!answer.ok) {
      const status = answer.error_code || response.status;
      const retryAfter = answer.parameters && Number.isFinite(answer.parameters.retry_after) ? answer.parameters.retry_after : null;
      throw new TelegramError(`Telegram ${method}: ${status} ${answer.description || 'error'}`,
        { method, status, transient: status === 429 || status >= 500, retryAfter });
    }
    return answer.result;
  }

  return {
    baseUrl: root,
    call,

    // New updates from `offset` on. timeout 0 = short polling: the call returns at once.
    getUpdates({ offset = null, limit = 100 } = {}) {
      const body = { timeout: 0, limit, allowed_updates: ALLOWED_UPDATES };
      if (offset !== null) body.offset = offset;
      return call('getUpdates', body);
    },

    // Plain text, no parse mode. A text above 4096 characters goes out as several
    // messages; the keyboard, if any, hangs on the last one. Returns the sent messages.
    // silent: Telegram's disable_notification, for the messages of an overnight run
    // (Phase 7): the message arrives without a sound.
    async sendMessage(chatId, text, { replyMarkup = null, silent = false } = {}) {
      const parts = splitText(text);
      const sent = [];
      for (let i = 0; i < parts.length; i += 1) {
        const body = { chat_id: chatId, text: parts[i] };
        if (replyMarkup && i === parts.length - 1) body.reply_markup = replyMarkup;
        if (silent) body.disable_notification = true;
        sent.push(await call('sendMessage', body));
      }
      return sent;
    },

    // content: a Buffer or a string. Sent as multipart/form-data.
    sendDocument(chatId, { filename, content, caption = null, silent = false }) {
      const form = new FormData();
      form.set('chat_id', String(chatId));
      if (caption) form.set('caption', String(caption).slice(0, CAPTION_LIMIT));
      if (silent) form.set('disable_notification', 'true');
      form.set('document', new Blob([content]), filename);
      return call('sendDocument', form);
    },

    answerCallbackQuery(callbackQueryId, { text = null } = {}) {
      const body = { callback_query_id: callbackQueryId };
      if (text) body.text = String(text).slice(0, 200);
      return call('answerCallbackQuery', body);
    },

    // Deletes one message of a chat. In a private chat a bot can delete its own
    // messages and the ones it received, for 48 hours (Bot API, deleteMessage).
    deleteMessage(chatId, messageId) {
      return call('deleteMessage', { chat_id: chatId, message_id: messageId });
    },

    getFile(fileId) {
      return call('getFile', { file_id: fileId });
    },

    // The bytes of a file, by the file_path that getFile returned.
    async downloadFile(filePath, { maxBytes }) {
      const method = 'file download';
      const response = await request(method, `${root}/file/bot${token}/${filePath}`);
      if (response.status !== 200) {
        throw new TelegramError(`Telegram ${method}: HTTP ${response.status}`, { method, status: response.status, transient: response.status >= 500 });
      }
      const declared = Number(response.headers.get('content-length'));
      if (declared > maxBytes) throw new TelegramError(`Telegram ${method}: the file is larger than ${maxBytes} bytes`, { method, transient: false });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxBytes) throw new TelegramError(`Telegram ${method}: the file is larger than ${maxBytes} bytes`, { method, transient: false });
      return bytes;
    },

    // One request to the server's root, without the token: is the server reachable
    // from this process? Returns the HTTP status.
    async reach() {
      const response = await request('reach', `${root}/`);
      return response.status;
    },
  };
}

module.exports = { createTelegram, TelegramError, splitText, inlineKeyboard, DEFAULT_BASE_URL, MESSAGE_LIMIT, ALLOWED_UPDATES };
