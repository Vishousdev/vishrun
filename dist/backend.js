// @bun
// src/backend/common.ts
var api = spindle;
var VARS_PREFIX = "[vishrun:variables]";
var varsLog = {
  warn: (...args) => console.warn(VARS_PREFIX, ...args),
  debug: (...args) => console.debug(VARS_PREFIX, ...args)
};

// src/backend/fetch-external.ts
function isFetchExternalRequest(p) {
  return !!p && typeof p === "object" && p.type === "fetch_external" && typeof p.requestId === "string" && typeof p.url === "string";
}
function extractBody(result) {
  if (result && typeof result === "object" && typeof result.body === "string") {
    return result.body;
  }
  return "";
}
function installFetchExternalHandler() {
  api.onFrontendMessage((payload, userId) => {
    if (!isFetchExternalRequest(payload))
      return;
    const { requestId, url } = payload;
    const options = { responseType: "text" };
    api.cors(url, options).then((result) => {
      api.sendToFrontend({ type: "fetch_external_response", requestId, ok: true, body: extractBody(result) }, userId);
    }, (err) => {
      api.sendToFrontend({
        type: "fetch_external_response",
        requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      }, userId);
    });
  });
}

// src/backend/setvar-ops.ts
async function applySetvarOp(op, chatId, userId, vars = api.variables) {
  if (op.kind === "setvar") {
    await vars.local.set(chatId, op.name, op.value);
    return true;
  }
  if (op.kind === "setchatvar") {
    await vars.chat.set(chatId, op.name, op.value);
    return true;
  }
  varsLog.debug(`skipping ${op.kind} (upstream get/set path split):`, { name: op.name, userId });
  return false;
}

// src/backend/macro-resolve.ts
function isResolveMacrosRequest(p) {
  if (!p || typeof p !== "object")
    return false;
  const r = p;
  return r.type === "resolve_macros" && typeof r.requestId === "string" && typeof r.chatId === "string" && Array.isArray(r.templates) && r.templates.every((t) => typeof t === "string");
}
var VALID_MACRO_NAMES = [
  "getvar",
  "setvar",
  "addvar",
  "incvar",
  "decvar",
  "getchatvar",
  "setchatvar",
  "getgvar",
  "setgvar",
  "getglobalvar",
  "setglobalvar",
  "user",
  "char",
  "group",
  "newline",
  "input",
  "random",
  "roll",
  "pick"
];
var VALID_MACRO_RE = new RegExp(`^\\{\\{(?:${VALID_MACRO_NAMES.join("|")})(?:::|\\}\\})`);
var NUL = String.fromCharCode(0);
var SENTINEL_RE = new RegExp(`${NUL}VSHMSK(\\d+)${NUL}`, "g");
function maskInvalidMacros(template) {
  const masks = [];
  const masked = template.split(NUL).join("").replace(/\{\{[^{}]+\}\}/g, (match) => {
    if (VALID_MACRO_RE.test(match))
      return match;
    const idx = masks.length;
    masks.push(match);
    return `${NUL}VSHMSK${idx}${NUL}`;
  });
  return { masked, masks };
}
function unmaskInvalidMacros(text, masks) {
  if (masks.length === 0)
    return text;
  return text.replace(SENTINEL_RE, (_m, idx) => masks[Number(idx)] ?? "");
}
var SETVAR_RE = /\{\{(setvar|setchatvar|setgvar|setglobalvar)::([^:}]+)::([^}]*?)\}\}/g;
var NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
var chatSetvarMutex = new Map;
async function applyAndStripSetvars(template, chatId, userId, vars = api.variables) {
  const matches = [];
  for (const m of template.matchAll(SETVAR_RE)) {
    const [match, kind, name, value] = m;
    matches.push({ start: m.index, end: m.index + match.length, kind, name, value });
  }
  if (matches.length === 0)
    return template;
  const prev = chatSetvarMutex.get(chatId) ?? Promise.resolve();
  const work = prev.then(() => runApplyAndStripSetvars(template, chatId, userId, vars, matches));
  chatSetvarMutex.set(chatId, work.catch(() => {
    return;
  }));
  return work;
}
async function runApplyAndStripSetvars(template, chatId, userId, vars, matches) {
  let localBag = null;
  let chatBag = null;
  const needLocal = matches.some((m) => m.kind === "setvar" && NAME_RE.test(m.name));
  const needChat = matches.some((m) => m.kind === "setchatvar" && NAME_RE.test(m.name));
  if (needLocal) {
    try {
      localBag = await vars.local.list(chatId);
    } catch {
      localBag = null;
    }
  }
  if (needChat) {
    try {
      chatBag = await vars.chat.list(chatId);
    } catch {
      chatBag = null;
    }
  }
  const stripFlags = new Array(matches.length).fill(false);
  for (let i = 0;i < matches.length; i++) {
    const { kind, name, value } = matches[i];
    if (!NAME_RE.test(name))
      continue;
    const currentBag = kind === "setvar" ? localBag : kind === "setchatvar" ? chatBag : null;
    if (currentBag && currentBag[name] === value) {
      stripFlags[i] = true;
      continue;
    }
    try {
      stripFlags[i] = await applySetvarOp({ kind, name, value }, chatId, userId, vars);
      if (stripFlags[i] && currentBag)
        currentBag[name] = value;
    } catch (err) {
      varsLog.warn("setvar persist failed:", { kind, name, err: err instanceof Error ? err.message : String(err) });
    }
  }
  let out = "";
  let cursor = 0;
  for (let i = 0;i < matches.length; i++) {
    const { start, end } = matches[i];
    out += template.slice(cursor, start);
    if (!stripFlags[i])
      out += template.slice(start, end);
    cursor = end;
  }
  out += template.slice(cursor);
  return out;
}
function installMacroResolveHandler() {
  api.onFrontendMessage((payload, userId) => {
    if (!isResolveMacrosRequest(payload))
      return;
    const { requestId, chatId, characterId, templates } = payload;
    (async () => {
      const results = new Array(templates.length);
      for (let i = 0;i < templates.length; i++) {
        const original = templates[i];
        try {
          const stripped = await applyAndStripSetvars(original, chatId, userId);
          const { masked, masks } = maskInvalidMacros(stripped);
          const { text, diagnostics } = await api.macros.resolve(masked, {
            chatId,
            characterId,
            userId,
            commit: false
          });
          if (diagnostics.length > 0) {
            varsLog.debug(`resolve produced ${diagnostics.length} diagnostic(s):`, diagnostics[0]?.message);
          }
          results[i] = unmaskInvalidMacros(text, masks);
        } catch (err) {
          varsLog.warn("resolve failed:", err instanceof Error ? err.message : String(err));
          results[i] = original;
        }
      }
      api.sendToFrontend({ type: "resolve_macros_response", requestId, results }, userId);
    })();
  });
}

// src/backend/parsers/setvar.ts
var SETVAR_HEAD = /^\/(setvar|setchatvar|setgvar|setglobalvar)\s+key\s*=\s*([^\s"'=|]+)\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))\s*/i;
var SETVAR_HINT = /\/(setvar|setchatvar|setgvar|setglobalvar)\b/i;
function unescapeQuoted(s, quote) {
  return s.replace(/\\(.)/g, (_m, c) => c === quote || c === "\\" ? c : "\\" + c);
}
function splitChain(s) {
  const out = [];
  let buf = "";
  let quote = null;
  for (let i = 0;i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      buf += ch;
      if (ch === "\\" && i + 1 < s.length) {
        buf += s[++i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === "|" || ch === `
`) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  out.push(buf);
  return out;
}
function parseSegment(seg) {
  const trimmed = seg.trim();
  const m = SETVAR_HEAD.exec(trimmed);
  if (!m)
    return { pair: null, rest: trimmed };
  const kind = m[1].toLowerCase();
  const key = m[2];
  let value;
  if (m[3] !== undefined)
    value = unescapeQuoted(m[3], '"');
  else if (m[4] !== undefined)
    value = unescapeQuoted(m[4], "'");
  else
    value = m[5];
  return { pair: { kind, key, value }, rest: trimmed.slice(m[0].length).trim() };
}
function parseSetvarChain(content) {
  if (!SETVAR_HINT.test(content))
    return null;
  const pairs = [];
  const kept = [];
  for (const seg of splitChain(content)) {
    const { pair, rest } = parseSegment(seg);
    if (pair)
      pairs.push(pair);
    if (rest)
      kept.push(rest);
  }
  if (pairs.length === 0)
    return null;
  return { pairs, strippedContent: kept.join(" | ").trim() };
}

// src/backend/message-content-processor.ts
var EMPTY_REPLACEMENT = "_(variables updated)_";
var SETVAR_RE2 = /\/(setvar|setchatvar|setgvar|setglobalvar)\b/i;
var SELF_CLOSING_CUSTOM_RE = /<([A-Z][a-zA-Z0-9_-]*)(\s[^>]*)?\s*\/>/g;
function expandSelfClosingTags(content) {
  return content.replace(SELF_CLOSING_CUSTOM_RE, (_m, tag, attrs) => {
    const a = attrs ? attrs.trimEnd() : "";
    return `<${tag}${a}></${tag}>`;
  });
}
async function processMessageContent(ctx, deps = {}) {
  const applySetvar = deps.applySetvarOp ?? applySetvarOp;
  const workingContent = expandSelfClosingTags(ctx.content);
  const selfCloseChanged = workingContent !== ctx.content;
  if (ctx.origin === "render") {
    return selfCloseChanged ? { content: workingContent } : undefined;
  }
  if (!SETVAR_RE2.test(workingContent)) {
    return selfCloseChanged ? { content: workingContent } : undefined;
  }
  let content = workingContent;
  const parsed = parseSetvarChain(content);
  if (parsed) {
    for (const { kind, key, value } of parsed.pairs) {
      try {
        await applySetvar({ kind, name: key, value }, ctx.chatId, ctx.userId);
      } catch (err) {
        varsLog.warn(`setvar failed for "${kind}::${key}":`, err instanceof Error ? err.message : String(err));
      }
    }
    content = parsed.strippedContent;
  }
  if (content === ctx.content)
    return;
  const stripped = content.trim();
  return { content: stripped.length > 0 ? stripped : EMPTY_REPLACEMENT };
}
function installMessageContentProcessor() {
  api.registerMessageContentProcessor((ctx) => processMessageContent(ctx), 50);
}

// src/backend/dispatch-slash.ts
function isDispatchSlashRequest(p) {
  if (!p || typeof p !== "object")
    return false;
  const r = p;
  return r.type === "dispatch_slash_text" && typeof r.requestId === "string" && typeof r.text === "string" && typeof r.chatId === "string";
}
var SETVAR_PREFIX_RE = /^\s*\/(setvar|setchatvar|setgvar|setglobalvar)\b/i;
var SYS_PREFIX_RE = /^\s*\/sys\b/i;
async function dispatchSlashText(text, chatId, userId, deps = {}) {
  if (SETVAR_PREFIX_RE.test(text)) {
    const parsed = parseSetvarChain(text);
    if (!parsed || parsed.pairs.length === 0) {
      varsLog.warn("dispatch_slash_text: setvar prefix matched but parse failed; treating as handled");
      return { handled: true, kind: "setvar_chain" };
    }
    for (const { kind, key, value } of parsed.pairs) {
      try {
        await applySetvarOp({ kind, name: key, value }, chatId, userId, deps.vars);
      } catch (err) {
        varsLog.warn(`dispatch_slash_text: applySetvarOp failed for ${kind}::${key}:`, err instanceof Error ? err.message : String(err));
      }
    }
    return { handled: true, kind: "setvar_chain" };
  }
  if (SYS_PREFIX_RE.test(text)) {
    const content = text.replace(/^\s*\/sys\s*/i, "");
    const append = deps.appendMessage ?? api.chat.appendMessage.bind(api.chat);
    await append(chatId, { role: "system", content });
    return { handled: true, kind: "sys_message" };
  }
  return { handled: false, kind: "none" };
}
function installDispatchSlashHandler() {
  api.onFrontendMessage((payload, userId) => {
    if (!isDispatchSlashRequest(payload))
      return;
    const { requestId, text, chatId } = payload;
    (async () => {
      let response;
      try {
        const result = await dispatchSlashText(text, chatId, userId);
        response = { type: "dispatch_slash_text_response", requestId, handled: result.handled, kind: result.kind };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        varsLog.warn("dispatch_slash_text handler threw:", msg);
        response = { type: "dispatch_slash_text_response", requestId, handled: false, kind: "none", error: msg };
      }
      api.sendToFrontend(response, userId);
    })();
  });
}

// src/backend/mvu-yaml.ts
var INT_RE = /^-?\d+$/;
var FLOAT_RE = /^-?\d+\.\d+$/;
function parseScalar(raw) {
  const v = raw.trim();
  if (INT_RE.test(v))
    return parseInt(v, 10);
  if (FLOAT_RE.test(v))
    return parseFloat(v);
  return v;
}
function tokenizeLines(source) {
  const out = [];
  const lines = source.split(/\r?\n/).map((l) => l.replace(/\r+$/, ""));
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#"))
      continue;
    const m = /^( *)(.*)$/.exec(line);
    if (!m)
      continue;
    const indent = m[1].length;
    const rest = m[2];
    if (rest === "")
      continue;
    const sepIdx = rest.indexOf(": ");
    let key;
    let value;
    if (sepIdx >= 0) {
      key = rest.slice(0, sepIdx).trim();
      value = rest.slice(sepIdx + 2);
    } else if (rest.endsWith(":")) {
      key = rest.slice(0, -1).trim();
      value = null;
    } else {
      console.warn("[vishrun:mvu-yaml] skipped malformed line", { lineNo: i + 1, line });
      continue;
    }
    if (key === "") {
      console.warn("[vishrun:mvu-yaml] skipped empty-key line", { lineNo: i + 1, line });
      continue;
    }
    out.push({ lineNo: i + 1, indent, key, value });
  }
  return out;
}
function parseYaml(source) {
  const tokens = tokenizeLines(source);
  const root = {};
  const stack = [
    { indent: -1, container: root }
  ];
  for (const t of tokens) {
    while (stack.length > 1 && stack[stack.length - 1].indent >= t.indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].container;
    if (t.value === null) {
      const child = {};
      parent[t.key] = child;
      stack.push({ indent: t.indent, container: child });
    } else {
      parent[t.key] = parseScalar(t.value);
    }
  }
  return root;
}

// src/backend/mvu-lodash.ts
var CMD_RE = /_\.([a-zA-Z][a-zA-Z0-9_]*)\s*\(/g;
var SNIPPET_LEN = 80;
function parseLodashSetCalls(blockContent, onUnsupported) {
  const out = [];
  CMD_RE.lastIndex = 0;
  let m;
  while ((m = CMD_RE.exec(blockContent)) !== null) {
    const cmd = m[1];
    const callStart = m.index;
    const argsStart = m.index + m[0].length;
    const argsParse = scanArgList(blockContent, argsStart);
    if (argsParse === null) {
      onUnsupported?.(snippet(blockContent, callStart), "malformed-call");
      continue;
    }
    const { args, endIndex } = argsParse;
    if (cmd !== "set") {
      onUnsupported?.(snippet(blockContent, callStart), "not-dot-set");
      CMD_RE.lastIndex = endIndex;
      continue;
    }
    if (args.length !== 2 && args.length !== 3) {
      onUnsupported?.(snippet(blockContent, callStart), "malformed-call");
      CMD_RE.lastIndex = endIndex;
      continue;
    }
    const pathArg = args[0].trim();
    const valueArg = args[args.length - 1].trim();
    const path = parseStringLiteral(pathArg);
    if (path === null || path.length === 0) {
      onUnsupported?.(snippet(blockContent, callStart), "path-not-string-literal");
      CMD_RE.lastIndex = endIndex;
      continue;
    }
    const newValue = parseLiteralValue(valueArg);
    if (newValue === undefined) {
      onUnsupported?.(snippet(blockContent, callStart), "value-not-literal");
      CMD_RE.lastIndex = endIndex;
      continue;
    }
    out.push({ path, newValue, index: callStart });
    CMD_RE.lastIndex = endIndex;
  }
  return out;
}
function snippet(src, start) {
  return src.slice(start, start + SNIPPET_LEN);
}
function scanArgList(src, start) {
  const args = [];
  let cur = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let inString = null;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (inString !== null) {
      cur += c;
      if (c === "\\" && i + 1 < src.length) {
        cur += src[i + 1];
        i += 2;
        continue;
      }
      if (c === inString)
        inString = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      cur += c;
      i++;
      continue;
    }
    if (c === "(") {
      parenDepth++;
      cur += c;
      i++;
      continue;
    }
    if (c === "[") {
      bracketDepth++;
      cur += c;
      i++;
      continue;
    }
    if (c === "{") {
      braceDepth++;
      cur += c;
      i++;
      continue;
    }
    if (c === ")") {
      if (parenDepth === 0) {
        if (cur.length > 0 || args.length > 0)
          args.push(cur);
        return { args, endIndex: i + 1 };
      }
      parenDepth--;
      cur += c;
      i++;
      continue;
    }
    if (c === "]") {
      if (bracketDepth > 0)
        bracketDepth--;
      cur += c;
      i++;
      continue;
    }
    if (c === "}") {
      if (braceDepth > 0)
        braceDepth--;
      cur += c;
      i++;
      continue;
    }
    if (c === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      args.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  return null;
}
function parseStringLiteral(raw) {
  if (raw.length < 2)
    return null;
  const open = raw[0];
  if (open !== '"' && open !== "'")
    return null;
  if (raw[raw.length - 1] !== open)
    return null;
  const inner = raw.slice(1, -1);
  if (inner.indexOf("\\") !== -1)
    return null;
  if (inner.indexOf("[") !== -1 || inner.indexOf("]") !== -1)
    return null;
  if (inner.indexOf(open) !== -1)
    return null;
  return inner;
}
function parseLiteralValue(raw) {
  const t = raw.trim();
  if (t === "true")
    return true;
  if (t === "false")
    return false;
  if (t === "null")
    return null;
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    const inner = parseStringLiteral(t);
    if (inner === null)
      return;
    if (/^[+-]\d/.test(inner))
      return;
    return inner;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(t))
    return parseFloat(t);
  return;
}

// src/core/diagnostics.ts
var VSH_VISHRUN_DIAG = false;

// src/backend/mvu-parser.ts
function emptyMvuData() {
  return { stat_data: {} };
}
function resolveActiveContent(msg) {
  const swipes = msg.swipes;
  const swipeId = typeof msg.swipe_id === "number" ? msg.swipe_id : 0;
  if (Array.isArray(swipes) && swipes.length > 0) {
    const c = swipes[swipeId];
    if (typeof c === "string" && c.length > 0)
      return c;
  }
  if (typeof msg.content === "string")
    return msg.content;
  return "";
}
var BLOCK_RE = /<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/gim;
var INITVAR_RE = /<initvar>(?:\s*```.*)?([\s\S]*?)(?:```\s*)?<\/initvar>/gim;
function extractUpdateVariableBlocks(content) {
  if (typeof content !== "string" || !/<updatevariable>/i.test(content))
    return [];
  const out = [];
  for (const m of content.matchAll(BLOCK_RE))
    out.push(m[1]);
  return out;
}
var InitvarYamlRecognizer = {
  name: "initvar-yaml",
  extract(block) {
    const ops = [];
    for (const m of block.matchAll(INITVAR_RE)) {
      try {
        const payload = parseYaml(m[1]);
        ops.push({ kind: "replace_stat_data", index: m.index ?? 0, payload });
      } catch (err) {
        console.warn("[vishrun:mvu-parser] initvar yaml parse failed:", err instanceof Error ? err.message : String(err));
      }
    }
    return ops;
  }
};
var LodashSetRecognizer = {
  name: "lodash-set",
  extract(block, ctx) {
    const calls = parseLodashSetCalls(block, (snippet2, reason) => {
      ctx?.onDiagnostic?.("unknown-command", { snippet: snippet2, reason });
    });
    return calls.map((c) => ({
      kind: "set_path",
      index: c.index,
      path: c.path,
      value: c.newValue
    }));
  }
};
var recognizers = [InitvarYamlRecognizer, LodashSetRecognizer];
function parseDottedPath(path) {
  if (path.length === 0)
    return null;
  if (path.indexOf("[") !== -1 || path.indexOf("]") !== -1)
    return null;
  if (path.indexOf("\\") !== -1)
    return null;
  return path.split(".");
}
function setDeepImmutable(root, segments, value) {
  if (segments.length === 0)
    return root;
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    return { ...root, [head]: value };
  }
  const child = root[head];
  const childObj = child !== null && typeof child === "object" && !Array.isArray(child) ? child : {};
  return { ...root, [head]: setDeepImmutable(childObj, rest, value) };
}
function applyOperation(state, op) {
  if (op.kind === "replace_stat_data") {
    const payload = op.payload;
    return { ...state, stat_data: { ...payload } };
  }
  if (op.kind === "set_path") {
    const sop = op;
    const segments = parseDottedPath(sop.path);
    if (segments === null) {
      return state;
    }
    const currentStatData = state.stat_data && typeof state.stat_data === "object" && !Array.isArray(state.stat_data) ? state.stat_data : {};
    const nextStatData = setDeepImmutable(currentStatData, segments, sop.value);
    return { ...state, stat_data: nextStatData };
  }
  return state;
}
function fnv1a(s) {
  let h = 2166136261;
  for (let i = 0;i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = h * 16777619 >>> 0;
  }
  return h >>> 0;
}
function stripUpdateVariableBlocks(s) {
  return s.replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, "");
}
function hashStripped(s) {
  return fnv1a(stripUpdateVariableBlocks(s));
}
async function computeVariablesSnapshot(messages, recoveryFetcher) {
  let state = emptyMvuData();
  let cachedCandidates = null;
  let candidatesTried = false;
  for (const msg of messages) {
    if (!msg)
      continue;
    const activeContent = resolveActiveContent(msg);
    if (activeContent.length === 0)
      continue;
    let blocks = extractUpdateVariableBlocks(activeContent);
    if (blocks.length === 0 && msg.index_in_chat === 0 && recoveryFetcher !== undefined) {
      if (!candidatesTried) {
        candidatesTried = true;
        try {
          cachedCandidates = await recoveryFetcher();
        } catch (err) {
          console.warn("[vishrun:mvu-parser] recovery fetcher threw:", err instanceof Error ? err.message : String(err));
          cachedCandidates = [];
        }
      }
      const candidates = cachedCandidates ?? [];
      const targetHash = hashStripped(activeContent);
      let matchIdx = -1;
      for (let i = 0;i < candidates.length; i++) {
        const c = candidates[i];
        if (typeof c !== "string")
          continue;
        if (hashStripped(c) === targetHash) {
          matchIdx = i;
          break;
        }
      }
      if (matchIdx >= 0) {
        blocks = extractUpdateVariableBlocks(candidates[matchIdx]);
      }
    }
    const messageIdForCtx = typeof msg.id === "string" ? msg.id : null;
    const recognizerCtx = {
      messageId: messageIdForCtx,
      onDiagnostic: (event, payload) => {
        if (!VSH_VISHRUN_DIAG)
          return;
        console.log(`[vishrun:mvu-parser] ${event}`, JSON.stringify({
          messageId: messageIdForCtx,
          ...payload
        }));
      }
    };
    for (const block of blocks) {
      const ops = [];
      for (const r of recognizers)
        ops.push(...r.extract(block, recognizerCtx));
      ops.sort((a, b) => a.index - b.index);
      for (const op of ops) {
        state = applyOperation(state, op);
      }
    }
  }
  return state;
}

// src/backend/th-helpers.ts
var LOG_PREFIX = "[vishrun:th-helpers]";
var log = {
  warn: (...args) => console.warn(LOG_PREFIX, ...args),
  debug: (...args) => console.debug(LOG_PREFIX, ...args)
};
function isThHelpersRequest(p) {
  if (!p || typeof p !== "object")
    return false;
  const r = p;
  return r.type === "th_helpers_request" && typeof r.requestId === "string" && typeof r.op === "string" && typeof r.chatId === "string" && typeof r.currentMessageId === "string" && typeof r.currentMessageIndex === "number" && !!r.body && typeof r.body === "object";
}
function resolveRangeToIndex(range, total, currentMessageIndex) {
  if (total === 0)
    return null;
  if (typeof range === "number") {
    return range >= 0 ? range : total + range;
  }
  if (typeof range === "string") {
    const trimmed = range.trim();
    if (trimmed === "" || trimmed === "latest")
      return total - 1;
    if (trimmed === "this")
      return currentMessageIndex;
    if (/^-?\d+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      return n >= 0 ? n : total + n;
    }
  }
  return null;
}
function shapeSnapshotMessage(msg) {
  const role = msg.role === "system" || msg.role === "user" || msg.role === "assistant" ? msg.role : msg.is_user ? "user" : "assistant";
  const swipes = Array.isArray(msg.swipes) && msg.swipes.length > 0 ? msg.swipes : [msg.content];
  return {
    id: msg.id,
    message_id: msg.index_in_chat,
    name: msg.name,
    role,
    is_hidden: false,
    message: msg.content,
    swipe_id: msg.swipe_id ?? 0,
    swipes,
    data: {},
    extra: msg.extra ?? {}
  };
}
async function handleGetMessagesSnapshot(chatId, chat = api.chat) {
  const messages = await chat.getMessages(chatId);
  return messages.map((m) => shapeSnapshotMessage(m));
}
async function handleGetVariablesSnapshot(chatId, chat = api.chat, chats = api.chats, characters = api.characters) {
  try {
    const messages = await chat.getMessages(chatId);
    return await computeVariablesSnapshot(messages, async () => {
      const msg0 = messages[0];
      let charId = null;
      const fromExtra = msg0?.extra?.character_id;
      if (typeof fromExtra === "string" && fromExtra.length > 0) {
        charId = fromExtra;
      } else {
        const chatDto = await chats.get(chatId);
        if (chatDto && typeof chatDto.character_id === "string") {
          charId = chatDto.character_id;
        }
      }
      if (!charId)
        return [];
      const card = await characters.get(charId);
      if (!card)
        return [];
      const first = typeof card.first_mes === "string" ? card.first_mes : "";
      const alt = Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [];
      return [first, ...alt];
    });
  } catch (err) {
    log.warn("getVariablesSnapshot failed:", err instanceof Error ? err.message : String(err));
    return emptyMvuData();
  }
}
async function handleSetChatMessage(body, chatId, currentMessageIndex, chat = api.chat) {
  const fieldValues = body.fieldValues ?? {};
  const opts = body.opts ?? {};
  const messageRange = body.messageId;
  const messages = await chat.getMessages(chatId);
  if (messages.length === 0) {
    log.warn("setChatMessage: empty chat, ignoring");
    return;
  }
  const idx = resolveRangeToIndex(messageRange, messages.length, currentMessageIndex);
  if (idx === null || idx < 0 || idx >= messages.length) {
    log.warn("setChatMessage: unresolved message index", messageRange);
    return;
  }
  const target = messages[idx];
  const content = typeof fieldValues.message === "string" ? fieldValues.message : undefined;
  if (typeof content !== "string") {
    log.warn("setChatMessage: no message string in fieldValues, ignoring");
    return;
  }
  const patch = { content };
  const optsSwipeId = opts.swipe_id;
  if (typeof optsSwipeId === "number") {
    patch.swipe_id = optsSwipeId;
  }
  await chat.updateMessage(chatId, target.id, patch);
}
function installThHelpersHandler() {
  api.onFrontendMessage((payload, userId) => {
    if (!isThHelpersRequest(payload))
      return;
    const { requestId, op, chatId, currentMessageIndex, body } = payload;
    (async () => {
      let response;
      try {
        if (op === "th-get-messages-snapshot") {
          const result = await handleGetMessagesSnapshot(chatId);
          response = { type: "th_helpers_response", requestId, ok: true, result };
        } else if (op === "th-get-variables-snapshot") {
          const result = await handleGetVariablesSnapshot(chatId);
          response = { type: "th_helpers_response", requestId, ok: true, result };
        } else if (op === "th-set-chat-message") {
          await handleSetChatMessage(body, chatId, currentMessageIndex);
          response = { type: "th_helpers_response", requestId, ok: true, result: undefined };
        } else {
          response = {
            type: "th_helpers_response",
            requestId,
            ok: false,
            error: "unknown op: " + String(op)
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn("handler threw for op", op, msg);
        response = { type: "th_helpers_response", requestId, ok: false, error: msg };
      }
      api.sendToFrontend(response, userId);
    })();
  });
}

// src/backend/index.ts
installFetchExternalHandler();
installMacroResolveHandler();
installMessageContentProcessor();
installDispatchSlashHandler();
installThHelpersHandler();
function setup() {}
export {
  setup
};
