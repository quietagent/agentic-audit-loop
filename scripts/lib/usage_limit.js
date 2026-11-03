'use strict';

// Did a claude call end because the plan's usage limit was reached, and when does
// the limit reset? For the builder and the auditor alike: both read claude's
// stream-json events (--output-format stream-json --verbose).
//
// What is known, and from where (Claude Code 2.1.292):
//   seen      Every call prints "rate_limit_event" lines. A real one, from a call
//             that was allowed:
//               { "type": "rate_limit_event", "rate_limit_info": { "status": "allowed",
//                 "resetsAt": 1791778200, "rateLimitType": "five_hour",
//                 "unifiedWindows": { "five_hour": { "utilization": 0.21, "resetsAt": ... },
//                                     "seven_day": { "utilization": 0.09, "resetsAt": ... } } } }
//             resetsAt is in seconds since 1970.
//   documented  status is "allowed", "allowed_warning" or "rejected" (Agent SDK
//             reference, SDKRateLimitEvent). An assistant message can carry
//             error: "rate_limit" (SDKAssistantMessageError). The text Claude Code
//             shows is "You've hit your session limit · resets 3:45pm", or "weekly
//             limit", "Opus limit", "Sonnet limit" (the errors page).
//   a guess   What a refused call prints in print mode was never seen here: the limit
//             cannot be hit on purpose. So three signs count, and each is enough:
//               1. a rate_limit_event with status "rejected", and no good result;
//               2. a result whose text starts like the limit message, when the result
//                  is an error or an assistant message said "rate_limit";
//               3. an assistant message with error "rate_limit", and an error result.
//             The exit code is not used.
// The reset time comes from the rejected event, else from the latest event of any
// status, else from the text ("resets 3:45pm"), else it is unknown.

// How the limit message starts, in Claude Code's own list of such texts.
const LIMIT_TEXT = /^\s*(You've hit your\b|You've reached your\b|You're out of (extra )?usage\b|Claude (AI )?usage limit reached\b)/i;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Seconds or milliseconds since 1970, as an ISO time. null for anything else.
function toIso(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const ms = value < 1e12 ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// What the loop keeps of one rate_limit_event.
function limitInfo(event, seenAt = new Date()) {
  const info = event && event.rate_limit_info;
  if (!info || typeof info !== 'object') return null;
  const window = (name) => {
    const w = info.unifiedWindows && info.unifiedWindows[name];
    return w && typeof w === 'object' ? { utilization: Number.isFinite(w.utilization) ? w.utilization : null, resets_at: toIso(w.resetsAt) } : null;
  };
  return {
    status: typeof info.status === 'string' ? info.status : null,
    type: typeof info.rateLimitType === 'string' ? info.rateLimitType : null,
    resets_at: toIso(info.resetsAt),
    utilization: Number.isFinite(info.utilization) ? info.utilization : null,
    five_hour: window('five_hour'),
    seven_day: window('seven_day'),
    seen_at: seenAt.toISOString(),
  };
}

// "resets 3:45pm" or "resets Mon 12:00am" in a limit message: the next time the
// local clock shows that. null when the text has no such time.
function resetFromText(text, now = new Date()) {
  const match = /\bresets\s+(?:at\s+)?(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+)?(\d{1,2})(?::(\d\d))?\s*(am|pm)\b/i.exec(String(text || ''));
  if (!match) return null;
  let hour = Number(match[2]) % 12;
  if (match[4].toLowerCase() === 'pm') hour += 12;
  const minute = Number(match[3] || 0);
  if (hour > 23 || minute > 59) return null;
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (match[1]) {
    const days = (DAYS.indexOf(match[1].toLowerCase()) - at.getDay() + 7) % 7;
    at.setDate(at.getDate() + days);
    if (at <= now) at.setDate(at.getDate() + 7);
  } else if (at <= now) {
    at.setDate(at.getDate() + 1);
  }
  return at.toISOString();
}

// Reads the events of one claude call as they come.
//   onEvent(event)   feed every parsed event
//   latest()         what the latest rate_limit_event said, or null
//   verdict(result)  null, or { resets_at, limit, message, sign } when the call ended
//                    because the usage limit was reached. result is the result event,
//                    or null when claude ended without one.
function createLimitWatch({ now = () => new Date() } = {}) {
  let latest = null;
  let rejected = null;
  let flagged = false;

  function onEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'rate_limit_event') {
      const info = limitInfo(event, now());
      if (!info) return;
      latest = info;
      // The latest event counts: a call that was allowed again after a refusal went on.
      rejected = info.status === 'rejected' ? info : null;
    } else if (event.type === 'assistant' && event.error === 'rate_limit') {
      flagged = true;
    }
  }

  function verdict(result) {
    const text = result
      ? (typeof result.result === 'string' && result.result) || (Array.isArray(result.errors) ? result.errors.join('; ') : '')
      : '';
    const failed = !result || result.is_error === true || (typeof result.subtype === 'string' && result.subtype !== 'success');
    const textHit = LIMIT_TEXT.test(text);
    let sign = null;
    if (rejected && (failed || textHit)) sign = 'a rate_limit_event with status "rejected"';
    else if (textHit && (failed || flagged)) sign = 'the text of the result';
    else if (flagged && failed) sign = 'an assistant message with error "rate_limit"';
    if (!sign) return null;
    const source = rejected || latest;
    return {
      resets_at: (rejected && rejected.resets_at) || (latest && latest.resets_at) || resetFromText(text, now()),
      limit: source ? source.type : null,
      message: String(text || 'the plan\'s usage limit was reached').replace(/\s+/g, ' ').trim().slice(0, 300),
      sign,
    };
  }

  return { onEvent, latest: () => latest, verdict };
}

module.exports = { createLimitWatch, limitInfo, resetFromText, toIso, LIMIT_TEXT };
