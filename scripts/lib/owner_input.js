'use strict';

// A text or a file that the owner sends: GOAL.md and the first prompt for /new,
// a note or a new prompt for an Edit. The one network call is the download of a file.

const FILE_MAX_BYTES = 100 * 1024;
// Telegram cuts a longer message into pieces, and the next piece would be taken as the next answer.
const TEXT_MAX = 4000;
const HOW_TO_SEND = 'as a text message, or as a .md or .txt file (up to 100 KB)';

// Returns { text, fromFile } or { problem }. A problem is a sentence for the owner.
// The text goes through the token filter: what the owner sends is saved in files.
async function readInput(msg, ctx) {
  if (msg.document) {
    const { file_name: fileName = '', file_size: size = 0, file_id: fileId } = msg.document;
    if (!/\.(md|txt)$/i.test(fileName)) return { problem: 'That file is not a .md or .txt file.' };
    if (size > FILE_MAX_BYTES) return { problem: `That file has ${size} bytes. The limit is 100 KB.` };
    const info = await ctx.telegram.getFile(fileId);
    const bytes = await ctx.telegram.downloadFile(info.file_path, { maxBytes: FILE_MAX_BYTES });
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { problem: 'That file is not UTF-8 text. Save it as UTF-8 and send it again.' };
    }
    if (text.includes('\u0000')) return { problem: 'That file is not plain text.' };
    return text.trim() ? { text: ctx.redact(text.replace(/^﻿/, '')), fromFile: true } : { problem: 'That file is empty.' };
  }
  if (typeof msg.text === 'string') {
    if (msg.text.length >= TEXT_MAX) {
      return { problem: 'That text is long enough for Telegram to have cut it into several messages. Send it as a .md or .txt file instead.' };
    }
    return msg.text.trim() ? { text: ctx.redact(msg.text), fromFile: false } : { problem: 'That message is empty.' };
  }
  return { problem: `I can only take it ${HOW_TO_SEND}.` };
}

module.exports = { readInput, FILE_MAX_BYTES, TEXT_MAX, HOW_TO_SEND };
