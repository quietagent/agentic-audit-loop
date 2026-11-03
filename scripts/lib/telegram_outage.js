'use strict';

// When Telegram does not answer (Phase 7b). A tick whose getUpdates gets no answer (a
// network error: a timeout, a dropped or refused connection, no DNS) still moves the
// loop on: it handles no update, looks at the loop, and leaves what the loop sends in
// the outbox, which goes out on the first tick that reaches Telegram again.
//
// The outage is kept in runtime\state.json as telegramDown: { since, lastLogged }, so
// that bot.log gets one line when it starts, one every 10 minutes while it lasts, and
// one when it ends, not one per tick. The owner is told once, after an outage of 5
// minutes or more, and /status shows the last such one (lastTelegramDown: { from, to }).

const { when } = require('./loop_messages');

const LOG_EVERY_MS = 10 * 60 * 1000;
const TELL_OWNER_MS = 5 * 60 * 1000;

const iso = (ms) => new Date(ms).toISOString();
const minutes = (ms) => Math.max(0, Math.round(ms / 60000));
const wereWaiting = (n) => `${n} message${n === 1 ? ' was' : 's were'} waiting`;
const waitInOutbox = (n) => `${n} message${n === 1 ? ' waits' : 's wait'} in the outbox`;

// A tick whose getUpdates got no answer. reason is the error's message. Returns the
// line for bot.log, or null when this tick needs none.
function noteUnreachable(state, nowMs, reason) {
  const down = state.telegramDown;
  if (!down) {
    state.telegramDown = { since: iso(nowMs), lastLogged: iso(nowMs) };
    return `Telegram unreachable: ${reason}; the loop goes on, and what it sends waits in the outbox`;
  }
  if (nowMs - Date.parse(down.lastLogged) < LOG_EVERY_MS) return null;
  down.lastLogged = iso(nowMs);
  return `Telegram still unreachable, for ${minutes(nowMs - Date.parse(down.since))} min now: ${reason}; ${waitInOutbox(state.outbox.length)}`;
}

// The end of the outage in state.telegramDown, which it clears. Two ways:
//   - the first tick that reached Telegram again: endMs is now;
//   - the first tick after a gap in which the bot was off (gap: true): endMs is the last
//     tick before the gap. Whether Telegram answered after that is not known, and the
//     gap has its own message.
// Returns { line, text }: the line for bot.log, and the owner's message, which is null
// for an outage under 5 minutes. The message goes out before what waited in the outbox.
function endOutage(state, { endMs, nowMs, gap = false }) {
  const down = state.telegramDown;
  delete state.telegramDown;
  const sinceMs = Date.parse(down.since);
  const toMs = Number.isFinite(endMs) ? Math.max(sinceMs, endMs) : sinceMs;
  const n = minutes(toMs - sinceMs);
  const waiting = state.outbox.length;
  const line = gap
    ? `Telegram was still unreachable when the bot went offline: counted until the last tick before the gap, ${n} min; the loop went on meanwhile; ${wereWaiting(waiting)}`
    : `Telegram reachable again after ${n} min; the loop went on meanwhile; ${wereWaiting(waiting)}`;
  if (toMs - sinceMs < TELL_OWNER_MS) return { line, text: null };
  state.lastTelegramDown = { from: down.since, to: iso(toMs) };
  const text = `Telegram was unreachable from ${when(sinceMs, nowMs)} to ${when(toMs, nowMs)} (about ${n} min). `
    + (waiting ? 'The loop went on; what it sent meanwhile follows.' : 'The loop went on; it had nothing to send meanwhile.');
  return { line, text };
}

// The /status line of the last outage of 5 minutes or more, or null when there was none.
function telegramLine(state, nowMs) {
  const last = state.lastTelegramDown;
  if (!last || Number.isNaN(Date.parse(last.from)) || Number.isNaN(Date.parse(last.to))) return null;
  return `Telegram last unreachable: ${when(last.from, nowMs)} to ${when(last.to, nowMs)} (about ${minutes(Date.parse(last.to) - Date.parse(last.from))} min).`;
}

module.exports = { noteUnreachable, endOutage, telegramLine, LOG_EVERY_MS, TELL_OWNER_MS };
