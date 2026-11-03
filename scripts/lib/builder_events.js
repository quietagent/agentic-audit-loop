'use strict';

// Reads the events that `claude -p --output-format stream-json --verbose` prints
// (Claude Code 2.1.292), one JSON object per line, and keeps what the builder's
// records need: the session, the context use per turn, compactions, denials and
// the final result. It also turns each event into lines for the readable log.
//
// Where things are, in the events of 2.1.292:
//   system/init               session_id, model, tools, mcp_servers
//   assistant                 message.usage of that API call: input_tokens,
//                             cache_read_input_tokens, cache_creation_input_tokens
//   system/compact_boundary   compact_metadata: { trigger, pre_tokens }
//   system/permission_denied  tool_name, tool_use_id, decision_reason or message
//   result                    subtype, num_turns, total_cost_usd, permission_denials,
//                             modelUsage[<model>].contextWindow
//   rate_limit_event          rate_limit_info: how much of the plan's usage is spent,
//                             and whether the call was refused (lib/usage_limit.js)

const { createLimitWatch } = require('./usage_limit');

const TEXT_MAX = 200;

const oneLine = (value, max = TEXT_MAX) => {
  const text = (typeof value === 'string' ? value : JSON.stringify(value) ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
};

// The file or command a tool call is about.
function toolDetail(name, input = {}) {
  if (typeof input.file_path === 'string') return input.file_path;
  if (name === 'Bash' && typeof input.command === 'string') return oneLine(input.command);
  if (typeof input.pattern === 'string') return oneLine(input.path ? `${input.pattern} in ${input.path}` : input.pattern);
  return oneLine(input);
}

// The tokens the model was given on one API call: that is the context in use.
function contextTokens(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
}

function createTracker() {
  const seen = {
    sessionId: null,
    model: null,
    tools: null,
    mcpServers: null,
    peakTokens: 0,
    finalTokens: 0,
    compactions: [],
    deniedEvents: [],
    result: null,
  };
  const deniedIds = new Set();
  const limits = createLimitWatch();

  // Takes one parsed event and returns the lines it adds to the readable log.
  function onEvent(event) {
    if (!event || typeof event !== 'object') return [];
    if (event.session_id && !seen.sessionId) seen.sessionId = event.session_id;
    limits.onEvent(event);

    if (event.type === 'rate_limit_event') {
      const info = limits.latest();
      // Only a refusal is worth a line: every call prints one or more "allowed" events.
      return info && info.status === 'rejected'
        ? [`USAGE LIMIT: the call was refused (${info.type || 'limit unknown'}), resets at ${info.resets_at || 'an unknown time'}`]
        : [];
    }
    if (event.type === 'system' && event.subtype === 'init') {
      seen.model = event.model || null;
      seen.tools = Array.isArray(event.tools) ? event.tools : null;
      seen.mcpServers = Array.isArray(event.mcp_servers) ? event.mcp_servers.map((s) => (typeof s === 'string' ? s : s.name)) : null;
      return [`session ${event.session_id} started: model ${seen.model}, tools ${(seen.tools || []).join(' ')}, `
        + `${(seen.mcpServers || []).length} MCP servers`];
    }
    if (event.type === 'system' && event.subtype === 'compact_boundary') {
      const meta = event.compact_metadata || {};
      seen.compactions.push({ trigger: meta.trigger ?? null, pre_tokens: meta.pre_tokens ?? null });
      if (Number.isFinite(meta.pre_tokens)) seen.peakTokens = Math.max(seen.peakTokens, meta.pre_tokens);
      return [`COMPACTED: the conversation was summarised (${meta.trigger ?? 'unknown'}, ${meta.pre_tokens ?? '?'} tokens before)`];
    }
    if (event.type === 'system' && event.subtype === 'permission_denied') {
      if (event.tool_use_id) deniedIds.add(event.tool_use_id);
      seen.deniedEvents.push({ tool: event.tool_name, reason: event.decision_reason || event.message || null });
      return [`DENIED ${event.tool_name}: ${oneLine(event.decision_reason || event.message || '')}`];
    }
    if (event.type === 'assistant' && event.message) {
      // A subagent has a context of its own: only the main conversation counts.
      if (!event.parent_tool_use_id) {
        const tokens = contextTokens(event.message.usage);
        if (tokens) {
          seen.finalTokens = tokens;
          seen.peakTokens = Math.max(seen.peakTokens, tokens);
        }
      }
      const lines = [];
      for (const part of Array.isArray(event.message.content) ? event.message.content : []) {
        if (part.type === 'tool_use') lines.push(`${part.name} ${toolDetail(part.name, part.input)}`);
        else if (part.type === 'text' && part.text && part.text.trim()) lines.push(`text: ${oneLine(part.text)}`);
      }
      return lines;
    }
    if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
      return event.message.content
        .filter((part) => part.type === 'tool_result' && part.is_error && !deniedIds.has(part.tool_use_id))
        .map((part) => `tool error: ${oneLine(part.content)}`);
    }
    if (event.type === 'result') {
      seen.result = event;
      const cost = Number.isFinite(event.total_cost_usd) ? `$${event.total_cost_usd.toFixed(4)}` : 'unknown';
      return [`result: ${event.subtype}, ${event.num_turns} turns, cost ${cost}`];
    }
    return [];
  }

  // The model's context window, from the result event. Without a result it is unknown.
  function contextWindow() {
    const usage = seen.result && seen.result.modelUsage;
    if (!usage || typeof usage !== 'object') return null;
    const own = seen.model && usage[seen.model] && usage[seen.model].contextWindow;
    if (Number.isFinite(own)) return own;
    const all = Object.values(usage).map((entry) => entry && entry.contextWindow).filter(Number.isFinite);
    return all.length ? Math.max(...all) : null;
  }

  function context() {
    const window = contextWindow();
    const percent = (tokens) => (window ? Math.round((tokens / window) * 1000) / 10 : null);
    return {
      window,
      peak_tokens: seen.peakTokens,
      peak_percent: percent(seen.peakTokens),
      final_tokens: seen.finalTokens,
      final_percent: percent(seen.finalTokens),
    };
  }

  // The denied tool calls: the result event's list, or the denial events when claude
  // ended without a result.
  function denials() {
    if (seen.result && Array.isArray(seen.result.permission_denials)) {
      return seen.result.permission_denials.map((d) => ({ tool: d.tool_name, input: oneLine(toolDetail(d.tool_name, d.tool_input), 300) }));
    }
    return seen.deniedEvents.map((d) => ({ tool: d.tool, input: oneLine(d.reason || '', 300) }));
  }

  // The latest rate_limit_event, and whether the call ended at the plan's usage limit.
  const rateLimit = () => limits.latest();
  const usageLimit = () => limits.verdict(seen.result);

  return { onEvent, seen, context, denials, rateLimit, usageLimit };
}

module.exports = { createTracker, contextTokens, toolDetail, oneLine };
