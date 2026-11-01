// src/lumiverse/host-api.ts
var ctxRef = null;
function setHostContext(ctx) {
  ctxRef = ctx;
}
function ctx() {
  if (!ctxRef)
    throw new Error("[vishrun] host context not initialised");
  return ctxRef;
}
async function getCharacter(characterId) {
  const c = ctx();
  if (!c.characters)
    throw new Error("[vishrun] ctx.characters unavailable on this host");
  return c.characters.get(characterId);
}
async function updateMessageContent(chatId, messageId, content) {
  const c = ctx();
  if (!c.chats)
    throw new Error("[vishrun] ctx.chats unavailable on this host");
  await c.chats.updateMessage(chatId, messageId, { content });
}
var TIMEOUT_MS = 8000;
var counter = 0;
function hostRead(op, chatId) {
  const c = ctx();
  const requestId = `vishrun-hr-${Date.now()}-${++counter}`;
  return new Promise((resolve, reject) => {
    let unsub = null;
    const timer = setTimeout(() => {
      unsub?.();
      reject(new Error(`[vishrun] host_read ${op} timed out`));
    }, TIMEOUT_MS);
    unsub = c.onBackendMessage((payload) => {
      const p = payload;
      if (!p || p.type !== "host_read_response" || p.requestId !== requestId)
        return;
      clearTimeout(timer);
      unsub?.();
      if (p.error)
        reject(new Error(p.error));
      else
        resolve(p.result);
    });
    c.sendToBackend({ type: "host_read", requestId, op, chatId });
  });
}
function getChatCharacterId(chatId) {
  return hostRead("chat_character", chatId);
}
function getChatMessages(chatId) {
  return hostRead("messages", chatId);
}

// src/lumiverse/fetch-character.ts
async function fetchCharacter(characterId) {
  const char = await getCharacter(characterId);
  if (!char || typeof char !== "object")
    throw new Error(`fetchCharacter ${characterId}: empty response`);
  return char;
}
function extractRegexScripts(char) {
  const scripts = char?.extensions?.regex_scripts;
  return Array.isArray(scripts) ? scripts : [];
}

// src/state/active-card.ts
var current = null;
function getActiveCard() {
  return current;
}
function setActiveCard(card) {
  current = card;
}
function clearActiveCard() {
  current = null;
}

// src/render/shadow-dom.ts
function parentAcrossShadow(node) {
  if (node.parentNode) {
    const p = node.parentNode;
    return p.nodeType === 11 && p.host ? p.host : p;
  }
  return null;
}
function deepContains(root, node) {
  let cur = node;
  while (cur) {
    if (cur === root)
      return true;
    cur = parentAcrossShadow(cur);
  }
  return false;
}
function deepClosest(el, selector) {
  let cur = el;
  while (cur) {
    if (cur.nodeType === 1 && cur.matches(selector))
      return cur;
    cur = parentAcrossShadow(cur);
  }
  return null;
}
function deepQuerySelectorAll(root, selector) {
  const out = [];
  const visit = (scope) => {
    scope.querySelectorAll(selector).forEach((el) => out.push(el));
    scope.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot)
        visit(el.shadowRoot);
    });
  };
  visit(root);
  return out;
}
function deepQuerySelector(root, selector) {
  return deepQuerySelectorAll(root, selector)[0] ?? null;
}
function hasShadowHost(root) {
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (el.shadowRoot)
      return true;
  }
  return false;
}
function renderedChildNodes(node) {
  const sr = node.nodeType === 1 ? node.shadowRoot : null;
  return Array.from((sr ?? node).childNodes);
}
var NON_TEXT_TAGS = new Set(["STYLE", "SCRIPT", "TEMPLATE", "NOSCRIPT"]);
function isNonTextElement(el) {
  return NON_TEXT_TAGS.has(el.tagName);
}
function deepTextContent(root) {
  let s = "";
  const walk = (n) => {
    if (n.nodeType === 3) {
      s += n.nodeValue ?? "";
      return;
    }
    if (n.nodeType !== 1 && n.nodeType !== 11)
      return;
    if (n.nodeType === 1 && isNonTextElement(n))
      return;
    for (const c of renderedChildNodes(n))
      walk(c);
  };
  walk(root);
  return s;
}

// src/render/pending-hide.ts
var PENDING_ATTR = "data-vishrun-pending";
var META = new Set(["\\", "^", "$", ".", "|", "?", "*", "+", "(", ")", "[", "]", "{", "}"]);
function decodeEscapes(source) {
  return source.replace(/\\u([0-9A-Fa-f]{4})|\\x([0-9A-Fa-f]{2})/g, (m, u, x) => {
    const ch = String.fromCharCode(parseInt(u ?? x, 16));
    return /[\\^$.*+?()[\]{}|\/-]/.test(ch) ? m : ch;
  });
}
function literalPrefix(sourceIn) {
  const source = decodeEscapes(sourceIn);
  let out = "";
  let i = 0;
  for (;i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      const next = source[i + 1];
      const hex = next === "u" ? /^[0-9A-Fa-f]{4}/.exec(source.slice(i + 2)) : next === "x" ? /^[0-9A-Fa-f]{2}/.exec(source.slice(i + 2)) : null;
      if (hex) {
        out += String.fromCharCode(parseInt(hex[0], 16));
        i += 1 + hex[0].length;
        continue;
      }
      if (next === undefined || /[A-Za-z0-9]/.test(next))
        break;
      out += next;
      i++;
      continue;
    }
    if (META.has(ch))
      break;
    out += ch;
  }
  const after = source.slice(i);
  return /^[?*{]/.test(after) ? out.slice(0, -1) : out;
}
function groupAlternatives(src, from) {
  let depth = 0;
  let start = from;
  const alts = [];
  for (let i = from;i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") {
      while (i < src.length && src[i] !== "]") {
        if (src[i] === "\\")
          i++;
        i++;
      }
      continue;
    }
    if (ch === "(")
      depth++;
    else if (ch === ")") {
      if (depth === 0) {
        alts.push(src.slice(start, i));
        return { alts, end: i };
      }
      depth--;
    } else if (ch === "|" && depth === 0) {
      alts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  return null;
}
function leadingLiterals(src) {
  if (!src.startsWith("(?:"))
    return [literalPrefix(src)];
  const g = groupAlternatives(src, 3);
  return g ? g.alts.map((a) => literalPrefix(a)) : [""];
}
function trailingLiterals(src) {
  if (!src.endsWith(")"))
    return [literalSuffix(src)];
  for (let i = src.lastIndexOf("(?:");i >= 0; i = src.lastIndexOf("(?:", i - 1)) {
    const g = groupAlternatives(src, i + 3);
    if (g && g.end === src.length - 1)
      return g.alts.map((a) => literalSuffix(a));
    if (i === 0)
      break;
  }
  return [literalSuffix(src)];
}
function literalSuffix(sourceIn) {
  const source = decodeEscapes(sourceIn);
  let out = "";
  let i = source.length - 1;
  while (i >= 0) {
    const ch = source[i];
    const escaped = i > 0 && source[i - 1] === "\\" && !(i > 1 && source[i - 2] === "\\");
    if (escaped) {
      if (/[A-Za-z0-9]/.test(ch))
        break;
      out = ch + out;
      i -= 2;
      continue;
    }
    if (META.has(ch))
      break;
    out = ch + out;
    i--;
  }
  return out;
}
function unterminatedRanges(text, open, close) {
  const out = [];
  if (open.length < 3 || close.length === 0)
    return out;
  let from = 0;
  for (;; ) {
    const o = text.indexOf(open, from);
    if (o < 0)
      break;
    const c = text.indexOf(close, o + open.length);
    if (c < 0) {
      out.push([o, text.length]);
      break;
    }
    from = c + close.length;
  }
  return out;
}
function hide(el) {
  if (el.hasAttribute(PENDING_ATTR))
    return;
  el.setAttribute(PENDING_ATTR, el.style.getPropertyValue("display") || "");
  el.style.setProperty("display", "none", "important");
}
function unhide(el) {
  const prev = el.getAttribute(PENDING_ATTR);
  el.removeAttribute(PENDING_ATTR);
  if (prev)
    el.style.setProperty("display", prev);
  else
    el.style.removeProperty("display");
}
function clearPending(root) {
  deepQuerySelectorAll(root, `[${PENDING_ATTR}]`).forEach(unhide);
}
function hideRange(bubble, offsetMap, start, end) {
  const byNode = new Map;
  for (const e of offsetMap)
    byNode.set(e.node, e);
  const span = (el) => {
    let lo = Infinity;
    let hi = -Infinity;
    const walk = (n) => {
      const e = byNode.get(n);
      if (e) {
        lo = Math.min(lo, e.sourceStart);
        hi = Math.max(hi, e.sourceEnd);
      }
      for (const c of renderedChildNodes(n))
        walk(c);
    };
    walk(el);
    return lo === Infinity ? null : [lo, hi];
  };
  const hidden = new Set;
  for (const e of offsetMap) {
    if (e.sourceEnd <= start || e.sourceStart >= end)
      continue;
    let el = e.node.parentElement;
    let best = null;
    while (el && el !== bubble) {
      const s = span(el);
      if (!s || s[0] < start || s[1] > end)
        break;
      best = el;
      const p = el.parentNode;
      el = p && p.nodeType === 11 ? null : p;
    }
    if (best && ![...hidden].some((h) => h.contains(best)))
      hidden.add(best);
  }
  hidden.forEach((el) => hide(el));
  return hidden.size;
}

// src/core/classify-trigger.ts
function isPlaceholderLikeKind(kind) {
  return kind === "placeholder" || kind === "delimitedCapture" || kind === "delimitedCaptureMultiLine";
}
function isMultiLineRegex(re) {
  const src = re.source;
  if (src.includes("[\\s\\S]"))
    return true;
  if (src.includes("\\n"))
    return true;
  if (re.flags.includes("m") && (src.includes("^") || src.includes("$")))
    return true;
  return false;
}
function isPlaceholder(re) {
  const src = re.source;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      i++;
      while (i < src.length && src[i] !== "]") {
        if (src[i] === "\\")
          i += 2;
        else
          i++;
      }
      i++;
      continue;
    }
    if (ch === "(") {
      if (src.slice(i, i + 3) === "(?:") {
        i += 3;
        continue;
      }
      return false;
    }
    i++;
  }
  return true;
}
function isPairedTag(re) {
  const src = re.source;
  const stripped = src.replace(/\\s\*/g, "").replace(/\\\//g, "/");
  const open = stripped.match(/^\s*<\s*([a-zA-Z_][a-zA-Z0-9_-]*)/);
  if (!open)
    return false;
  const tagName = open[1];
  const closeRe = new RegExp(`</\\s*${escapeRegex(tagName)}\\s*>`);
  return closeRe.test(stripped);
}
var DELIM_PAIRS = [
  ["【", "】"],
  ["「", "」"],
  ["《", "》"],
  ["『", "』"],
  ["↦", "↤"]
];
var LITERAL_JSON_DELIM_RE = /^([A-Za-z])(?:\\s[*+]?)*\(\\\{[\s\S]*\\\}\)(?:\\s[*+]?)*([A-Za-z])$/;
function hasRealCapture(src) {
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      i++;
      while (i < src.length && src[i] !== "]") {
        i += src[i] === "\\" ? 2 : 1;
      }
      i++;
      continue;
    }
    if (ch === "(") {
      const a = src.slice(i + 1, i + 3);
      const grouping = a === "?:" || a === "?=" || a === "?!" || a[0] === "?" && a[1] === "<";
      if (!grouping)
        return true;
    }
    i++;
  }
  return false;
}
function textualMarkerName(src, kw) {
  const i = src.indexOf(kw);
  if (i < 0)
    return null;
  const rest = src.slice(i + kw.length);
  const end = rest.search(/\\?\]/);
  if (end < 0)
    return null;
  const name = rest.slice(0, end).replace(/\\s[*+]?/g, "").replace(/\\/g, "").replace(/\s+/g, " ").trim();
  return name || null;
}
var BRACKET_MARKERS_RE = /^\\\[[\w ]+\\\][\s\S]*\\\[[\w ]+\\\]$/;
function isDelimitedCapture(re) {
  const src = re.source;
  if (!hasRealCapture(src))
    return false;
  const head = src.replace(/^(?:\\s[*+]?|\s)+/, "");
  if (/^<[a-zA-Z_]/.test(head))
    return false;
  for (const [open, close] of DELIM_PAIRS) {
    const oi = src.indexOf(open);
    if (oi >= 0 && src.indexOf(close, oi + open.length) >= 0)
      return true;
  }
  if (BRACKET_MARKERS_RE.test(src))
    return true;
  const n1 = textualMarkerName(src, "START OF");
  const n2 = textualMarkerName(src, "END OF");
  if (n1 && n1 === n2)
    return true;
  return LITERAL_JSON_DELIM_RE.test(src);
}
var ANGLE_PIPE_RE = /^\\?<[A-Za-z][\w ]*\\?\|[\s\S]*\\?>$/;
function isAnglePipeCapture(re) {
  const src = re.source.replace(/^(?:\\s[*+]?|\s)+/, "").replace(/(?:\\s[*+]?|\s)+$/, "");
  if (!hasRealCapture(src))
    return false;
  if (/<\\?\//.test(src))
    return false;
  return ANGLE_PIPE_RE.test(src);
}
function isLiteralAnchoredCapture(re) {
  const src = re.source;
  if (!hasRealCapture(src))
    return false;
  return leadingLiterals(src).some(isTextAnchor);
}
function isTextAnchor(prefix) {
  if (prefix.length < 3)
    return false;
  if (/^<[A-Za-z/!?]/.test(prefix))
    return false;
  return !/^[\p{L}\p{N}\s]/u.test(prefix);
}
var HTML_TAGS = new Set(("a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col " + "colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 " + "h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta " + "meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script " + "search section select slot small source span strong style sub summary sup table tbody td template textarea " + "tfoot th thead time title tr track u ul var video wbr font center svg math").split(" "));
var OPEN_TAG_RE = /^\s*<([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:"[\s\S]*?"|'[\s\S]*?'|[^\s"'=<>`]+))?)*)\s*\/?>\s*$/;
function isStrippedTag(re) {
  const src = re.source.replace(/\\s[*+?]/g, " ").replace(/\\([^A-Za-z0-9])/g, "$1");
  if (src.includes("</"))
    return false;
  const m = OPEN_TAG_RE.exec(src);
  return !!m && !HTML_TAGS.has(m[1].toLowerCase());
}
function classifyTrigger(re) {
  if (isPairedTag(re))
    return "pairedTag";
  if (isStrippedTag(re))
    return "strippedTag";
  if (isPlaceholder(re))
    return "placeholder";
  if (isDelimitedCapture(re))
    return isMultiLineRegex(re) ? "delimitedCaptureMultiLine" : "delimitedCapture";
  if (isAnglePipeCapture(re))
    return "delimitedCaptureMultiLine";
  if (isLiteralAnchoredCapture(re))
    return "delimitedCaptureMultiLine";
  return "unknown";
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// src/core/parse-regex-script.ts
var FENCE_RE = /^\s*```[A-Za-z]*[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```\s*$/;
function stripCodeFence(s) {
  if (!s)
    return s;
  const m = s.match(FENCE_RE);
  return m ? m[1] : s;
}
function parseRegexLiteral(s) {
  const m = s.match(/^\s*\/((?:\\.|[^/\\])*)\/([gimsuy]*)\s*$/);
  if (!m || !m[1])
    return { pattern: s, flags: "" };
  return { pattern: m[1], flags: m[2] };
}
function mergeFlags(userFlags) {
  const set = new Set(["g", "s"]);
  for (const f of userFlags)
    set.add(f);
  return Array.from(set).join("");
}
var SELF_CLOSING_RE = /^<([A-Z][a-zA-Z0-9_-]*)(\s[^>]*)?\s*\/>$/;
function rewriteSelfClosingToPaired(src) {
  const m = src.match(SELF_CLOSING_RE);
  if (!m)
    return null;
  const attrs = m[2] ? m[2].trimEnd() : "";
  return `<${m[1]}${attrs}></${m[1]}>`;
}
function compileScripts(rawScripts) {
  const out = [];
  for (let i = 0;i < rawScripts.length; i++) {
    const s = rawScripts[i];
    if (s.disabled)
      continue;
    if (s.promptOnly)
      continue;
    if (Array.isArray(s.placement) && !s.placement.includes(2))
      continue;
    const src = s.findRegex;
    if (!src || typeof src !== "string")
      continue;
    const replace = stripCodeFence(s.replaceString ?? "");
    const effectiveSrc = rewriteSelfClosingToPaired(src) ?? src;
    const { pattern, flags } = parseRegexLiteral(effectiveSrc);
    let re;
    try {
      re = new RegExp(pattern, mergeFlags(flags));
    } catch (err) {
      console.debug(`[vishrun] script "${s.scriptName ?? "(unnamed)"}" findRegex failed to compile:`, err);
      continue;
    }
    const kind = classifyTrigger(re);
    if (kind === "unknown") {
      console.debug(`[vishrun] script "${s.scriptName ?? "(unnamed)"}" has unrecognized trigger shape ` + `(not placeholder, paired-tag, nor delimited-capture) — will not render. findRegex: ${src}`);
    }
    out.push({
      id: s.id ?? `idx-${i}`,
      scriptName: s.scriptName ?? "(unnamed)",
      findRe: re,
      replaceString: replace,
      kind,
      sourceIndex: i
    });
  }
  return out;
}

// src/core/substitute.ts
function substitute(template, fullMatch, groups) {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === "{" && template.slice(i, i + 9).toLowerCase() === "{{match}}") {
      out += fullMatch;
      i += 9;
      continue;
    }
    if (ch !== "$") {
      out += ch;
      i++;
      continue;
    }
    const next = template[i + 1];
    if (next >= "0" && next <= "9") {
      let endNum = i + 2;
      while (endNum < template.length && template[endNum] >= "0" && template[endNum] <= "9")
        endNum++;
      const numStr = template.slice(i + 1, endNum);
      const idx = parseInt(numStr, 10);
      if (idx === 0) {
        out += fullMatch;
        i = endNum;
        continue;
      }
      if (idx <= groups.length) {
        out += groups[idx - 1] ?? "";
        i = endNum;
        continue;
      }
      let consumed = numStr.length;
      while (consumed > 1) {
        consumed--;
        const tryIdx = parseInt(numStr.slice(0, consumed), 10);
        if (tryIdx >= 1 && tryIdx <= groups.length) {
          out += groups[tryIdx - 1] ?? "";
          out += numStr.slice(consumed);
          i = endNum;
          break;
        }
      }
      if (consumed === 1) {
        out += "$" + numStr;
        i = endNum;
      }
      continue;
    }
    out += "$";
    i++;
  }
  return out;
}

// src/core/nested-pipeline.ts
var MAX_RECURSION = 5;
function applyNestedPipeline(html, allScripts, processing = new Set, depth = 0) {
  if (depth >= MAX_RECURSION) {
    console.warn(`[vishrun] nested pipeline hit MAX_RECURSION (${MAX_RECURSION}); deeper tags left unsubstituted`);
    return html;
  }
  let out = html;
  for (const script of allScripts) {
    if (script.kind === "unknown")
      continue;
    if (processing.has(script.id))
      continue;
    out = expand(out, script, allScripts, processing, depth);
  }
  return out;
}
function expand(html, script, allScripts, processing, depth) {
  script.findRe.lastIndex = 0;
  let m = script.findRe.exec(html);
  if (m === null)
    return html;
  const nextProcessing = new Set(processing).add(script.id);
  let out = "";
  let cursor = 0;
  while (m !== null) {
    out += html.slice(cursor, m.index);
    const groups = m.slice(1).map((g) => g ?? "");
    const substituted = substitute(script.replaceString, m[0], groups);
    out += applyNestedPipeline(substituted, allScripts, nextProcessing, depth + 1);
    cursor = m.index + m[0].length;
    if (m[0].length === 0)
      script.findRe.lastIndex++;
    m = script.findRe.exec(html);
  }
  out += html.slice(cursor);
  return out;
}

// src/core/dispatch-slash.ts
function isDispatchSlashResponse(p, requestId) {
  if (!p || typeof p !== "object")
    return false;
  const r = p;
  return r.type === "dispatch_slash_text_response" && r.requestId === requestId && typeof r.handled === "boolean" && typeof r.kind === "string";
}
var requestCounter = 0;
function nextRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `vishrun-ds-${Date.now()}-${++requestCounter}`;
}
var DISPATCH_TIMEOUT_MS = 5000;
function dispatchSlashViaBackend(ctx, chatId, text, timeoutMs = DISPATCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId();
    let settled = false;
    let unsub = null;
    let timer = null;
    const finish = (run) => {
      if (settled)
        return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsub) {
        try {
          unsub();
        } catch {}
        unsub = null;
      }
      run();
    };
    unsub = ctx.onBackendMessage((payload) => {
      if (!isDispatchSlashResponse(payload, requestId))
        return;
      finish(() => resolve({ handled: payload.handled, kind: payload.kind, error: payload.error }));
    });
    timer = setTimeout(() => {
      finish(() => reject(new Error("dispatch_slash_text timeout")));
    }, timeoutMs);
    try {
      ctx.sendToBackend({ type: "dispatch_slash_text", requestId, text, chatId });
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

// src/render/clipboard-shim.ts
var DISPATCH_PREFIX_RE = /^\s*\/(setvar|setchatvar|setgvar|setglobalvar|sys)\b/i;
var DISPATCH_CORRELATION_WINDOW_MS = 1000;
var DISPATCH_CLEANUP_INTERVAL_MS = 2000;
var recentlyDispatched = new Map;
var cleanupTimer = null;
function ensureCleanupTimer() {
  if (cleanupTimer !== null)
    return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [text, ts] of recentlyDispatched) {
      if (now - ts > DISPATCH_CLEANUP_INTERVAL_MS)
        recentlyDispatched.delete(text);
    }
  }, DISPATCH_CLEANUP_INTERVAL_MS);
}
async function handleClipboardWriteText(payload, ctx, deps = {}) {
  const text = payload && typeof payload === "object" ? payload.text : undefined;
  if (typeof text !== "string")
    return;
  const dispatched = deps.recentlyDispatched ?? recentlyDispatched;
  const now = deps.now ?? Date.now;
  if (DISPATCH_PREFIX_RE.test(text)) {
    const chatId = ctx.getActiveChat().chatId;
    if (!chatId) {
      console.warn("[vishrun] dispatch_slash_text: no active chatId, falling back to clipboard");
    } else {
      if (!deps.recentlyDispatched)
        ensureCleanupTimer();
      dispatched.set(text, now());
      try {
        const dispatch = deps.dispatch ?? dispatchSlashViaBackend;
        const result = await dispatch(ctx, chatId, text);
        if (result.handled) {
          dispatched.set(text, now());
          return;
        }
        dispatched.delete(text);
      } catch (e) {
        console.warn("[vishrun] dispatch_slash_text failed, falling back to clipboard:", e instanceof Error ? e.message : String(e));
        dispatched.delete(text);
      }
    }
  }
  const writeText = deps.clipboardWriteText ?? (typeof navigator !== "undefined" && navigator.clipboard ? navigator.clipboard.writeText.bind(navigator.clipboard) : null);
  if (!writeText)
    return;
  try {
    await writeText(text);
  } catch (e) {
    console.warn("[vishrun] clipboard writeText failed:", e);
  }
}
function handleHostAlert(payload, deps = {}) {
  const message = payload && typeof payload === "object" ? payload.message : undefined;
  if (typeof message !== "string")
    return;
  const dispatched = deps.recentlyDispatched ?? recentlyDispatched;
  const now = deps.now ?? Date.now;
  const tNow = now();
  for (const ts of dispatched.values()) {
    if (tNow - ts < DISPATCH_CORRELATION_WINDOW_MS)
      return;
  }
  const alertFn = deps.alert ?? (typeof window !== "undefined" && typeof window.alert === "function" ? window.alert.bind(window) : null);
  if (!alertFn)
    return;
  try {
    alertFn(message);
  } catch (e) {
    console.warn("[vishrun] alert failed:", e);
  }
}

// src/render/slash-runner.ts
var COMPOSER_SELECTOR = '[data-component="InputArea"] textarea';
function setComposerText(text, doc = document) {
  const ta = doc.querySelector(COMPOSER_SELECTOR);
  if (!ta)
    return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (setter)
    setter.call(ta, text);
  else
    ta.value = text;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
  return true;
}
var SEND_BUTTON_SELECTOR = '[data-component="InputArea"] button[class*="sendBtn"]:not([class*="sendBtnStop"])';
function clickSend(doc = document, delayMs = 60) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const btn = doc.querySelector(SEND_BUTTON_SELECTOR);
      if (!btn || btn.disabled)
        return resolve(false);
      btn.click();
      resolve(true);
    }, delayMs);
  });
}
function splitPipeline(command) {
  return command.split(/\|(?=\s*\/[A-Za-z])/).map((c) => c.trim()).filter(Boolean);
}
function parseSlash(command) {
  const m = /^\s*\/([A-Za-z][\w-]*)\b\s?([\s\S]*)$/.exec(command);
  return m ? { name: m[1].toLowerCase(), rest: m[2] } : null;
}
async function handleTriggerSlash(payload, ctx, deps = {}) {
  const command = payload && typeof payload === "object" ? payload.command : undefined;
  if (typeof command !== "string")
    return;
  const setComposer = deps.setComposer ?? setComposerText;
  const steps = splitPipeline(command).map(parseSlash);
  const [first, second] = steps;
  if (first?.name === "send" && steps.length <= 2 && (!second || second.name === "trigger")) {
    if (!setComposer(first.rest)) {
      console.warn("[vishrun] triggerSlash: composer not found");
      return;
    }
    if (second && !await (deps.send ?? clickSend)())
      console.warn("[vishrun] triggerSlash: send button unavailable");
    return;
  }
  const parsed = parseSlash(command);
  if (parsed && (parsed.name === "setinput" || parsed.name === "input")) {
    if (!setComposer(parsed.rest))
      console.warn("[vishrun] triggerSlash: composer not found");
    return;
  }
  if (parsed && parsed.name === "echo") {
    console.info("[vishrun] /echo", parsed.rest);
    return;
  }
  await (deps.fallback ?? handleClipboardWriteText)({ text: command }, ctx);
}
function triggerSlashShim() {
  return `<script>(function(){` + `if(typeof window.triggerSlash==='function')return;` + `window.triggerSlash=function(cmd){` + `try{window.spindleSandbox.postMessage({kind:'trigger-slash',payload:{command:String(cmd)}});}catch(e){}` + `return Promise.resolve('');` + `};` + `})();</script>`;
}

// src/render/audio-proxy.ts
var ATTR = "data-vishrun-extaudio";
function stripExternalAudioSrc(html) {
  if (!/<(?:audio|source)\b/i.test(html))
    return html;
  return html.replace(/<(?:audio|source)\b[^>]*>/gi, (tag) => tag.replace(/(\s)src\s*=\s*(['"])(https?:\/\/[^'"]+)\2/i, `$1${ATTR}=$2$3$2`));
}
function audioProxyHelper() {
  return `<script>(function(){
var ATTR='${ATTR}';
var sb=window.spindleSandbox;
if(!sb||typeof sb.fetchAudio!=='function')return;
var EXT=/^https?:\\/\\//i;
var cache=Object.create(null);
var pending=new WeakMap();
var media=HTMLMediaElement.prototype;
var srcDesc=Object.getOwnPropertyDescriptor(media,'src');
var setAttr=Element.prototype.setAttribute;
var origPlay=media.play;
var origLoad=media.load;
function resolveUrl(url){
  if(!cache[url])cache[url]=sb.fetchAudio(url).then(function(r){return r.url;});
  return cache[url];
}
function isAudioTarget(el){
  return el instanceof HTMLAudioElement||(el instanceof HTMLSourceElement&&el.parentElement instanceof HTMLAudioElement);
}
function owner(el){return el instanceof HTMLSourceElement?el.parentElement:el;}
function divert(el,url){
  setAttr.call(el,ATTR,url);
  var media=owner(el);
  var p=resolveUrl(url).then(function(blob){
    if(el.getAttribute(ATTR)!==url)return;
    el.removeAttribute(ATTR);
    if(el instanceof HTMLSourceElement){setAttr.call(el,'src',blob);if(media)origLoad.call(media);}
    else srcDesc.set.call(el,blob);
  },function(e){console.warn('[vishrun] audio proxy failed',url,e&&e.message||e);});
  if(media)pending.set(media,p);
  return p;
}
Object.defineProperty(media,'src',{configurable:true,enumerable:srcDesc.enumerable,get:srcDesc.get,set:function(v){
  if(typeof v==='string'&&EXT.test(v)&&this instanceof HTMLAudioElement){divert(this,v);return;}
  srcDesc.set.call(this,v);
}});
Element.prototype.setAttribute=function(name,value){
  if(String(name).toLowerCase()==='src'&&typeof value==='string'&&EXT.test(value)&&isAudioTarget(this)){divert(this,value);return;}
  return setAttr.call(this,name,value);
};
media.play=function(){
  var self=this,p=pending.get(this);
  if(!p)return origPlay.call(this);
  return p.then(function(){pending.delete(self);return origPlay.call(self);});
};
media.load=function(){
  var self=this,p=pending.get(this);
  if(!p)return origLoad.call(this);
  p.then(function(){origLoad.call(self);});
};
var OrigAudio=window.Audio;
if(OrigAudio){
  var Wrapped=function Audio(url){var a=new OrigAudio();if(url!==undefined)a.src=url;return a;};
  Wrapped.prototype=OrigAudio.prototype;
  window.Audio=Wrapped;
}
function scan(root){
  if(!root||!root.querySelectorAll)return;
  var list=root.querySelectorAll('audio['+ATTR+'],source['+ATTR+'],audio[src^="http"],audio source[src^="http"]');
  for(var i=0;i<list.length;i++){
    var el=list[i];
    if(!isAudioTarget(el))continue;
    var url=el.getAttribute(ATTR)||el.getAttribute('src');
    if(!EXT.test(url||''))continue;
    if(el.hasAttribute('src'))el.removeAttribute('src');
    divert(el,url);
  }
}
document.addEventListener('DOMContentLoaded',function(){
  scan(document);
  new MutationObserver(function(muts){for(var i=0;i<muts.length;i++){var n=muts[i].addedNodes;for(var j=0;j<n.length;j++){var x=n[j];if(x.nodeType!==1)continue;if(x.matches&&x.matches('audio,source'))scan(x.parentNode||x);else scan(x);}}}).observe(document.documentElement,{childList:true,subtree:true});
});
})();</script>`;
}

// src/render/fetch-bridge.ts
var TIMEOUT_MS2 = 20000;
var counter2 = 0;
function fetchBridgeShim() {
  return `<script>(function(){
var sb=window.spindleSandbox;
if(!sb||typeof sb.postMessage!=='function'||typeof sb.onMessage!=='function'||typeof window.fetch!=='function')return;
var nativeFetch=window.fetch.bind(window);
var EXT=/^https?:\\/\\//i;
var pending={};
var seq=0;
sb.onMessage(function(m){
  if(!m||m.kind!=='widget-fetch-response')return;
  var slot=pending[m.requestId];
  if(!slot)return;
  delete pending[m.requestId];
  if(!m.ok){slot.reject(new TypeError('Failed to fetch: '+(m.error||'error')));return;}
  var noBody=m.status===204||m.status===205||m.status===304;
  slot.resolve(new Response(noBody?null:(m.body||''),{status:m.status||200,statusText:m.statusText||'',headers:m.headers||{}}));
});
function plainHeaders(h){
  var out={};
  if(!h)return out;
  if(typeof Headers!=='undefined'&&h instanceof Headers){h.forEach(function(v,k){out[k]=v;});return out;}
  if(Array.isArray(h)){h.forEach(function(p){out[p[0]]=String(p[1]);});return out;}
  for(var k in h)out[k]=String(h[k]);
  return out;
}
window.fetch=function(input,init){
  var url=typeof input==='string'?input:(input&&input.url)||String(input);
  if(!EXT.test(url))return nativeFetch(input,init);
  init=init||{};
  var body=init.body;
  if(body!=null&&typeof body!=='string'){
    if(typeof URLSearchParams!=='undefined'&&body instanceof URLSearchParams)body=body.toString();
    else return Promise.reject(new TypeError('Failed to fetch: only string bodies are supported'));
  }
  return new Promise(function(resolve,reject){
    var id='wf-'+Date.now().toString(36)+'-'+(++seq);
    pending[id]={resolve:resolve,reject:reject};
    try{
      sb.postMessage({kind:'widget-fetch',requestId:id,url:url,method:(init.method||(input&&input.method)||'GET'),headers:plainHeaders(init.headers),body:body==null?undefined:body});
    }catch(e){delete pending[id];reject(new TypeError('Failed to fetch'));}
  });
};
})();</script>`;
}
function isWidgetFetch(p) {
  if (!p || typeof p !== "object")
    return false;
  const r = p;
  return r.kind === "widget-fetch" && typeof r.requestId === "string" && typeof r.url === "string";
}
function dispatchWidgetFetch(frame, msg, ctx) {
  const backendId = `vishrun-wf-${Date.now()}-${++counter2}`;
  let done = false;
  let unsub = null;
  const finish = (reply) => {
    if (done)
      return;
    done = true;
    clearTimeout(timer);
    unsub?.();
    try {
      frame.postMessage({ kind: "widget-fetch-response", requestId: msg.requestId, ...reply });
    } catch {}
  };
  const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), TIMEOUT_MS2);
  unsub = ctx.onBackendMessage((payload) => {
    const p = payload;
    if (!p || p.type !== "widget_fetch_response" || p.requestId !== backendId)
      return;
    const { type: _t, requestId: _r, ...rest } = p;
    finish(rest);
  });
  ctx.sendToBackend({
    type: "widget_fetch",
    requestId: backendId,
    url: msg.url,
    method: typeof msg.method === "string" ? msg.method : "GET",
    headers: msg.headers && typeof msg.headers === "object" ? msg.headers : {},
    body: typeof msg.body === "string" ? msg.body : undefined
  });
}

// src/render/css-url-proxy.ts
function cssUrlProxyShim() {
  return `<script>(function(){
var resolve=window.__vishrunProxiedImageUrl;
if(typeof resolve!=='function'||typeof MutationObserver==='undefined')return;
var URL_RE=/url\\(\\s*(['"]?)(https?:\\/\\/[^'")\\s]+)\\1\\s*\\)/gi;
function fix(el){
  var css=el.getAttribute&&el.getAttribute('style');
  if(!css||css.indexOf('http')===-1)return;
  URL_RE.lastIndex=0;
  if(!URL_RE.test(css))return;
  var urls=[];URL_RE.lastIndex=0;var m;
  while((m=URL_RE.exec(css))!==null)urls.push(m[2]);
  Promise.all(urls.map(function(u){return resolve(u).catch(function(){return null;});})).then(function(blobs){
    if(el.getAttribute('style')!==css)return;
    var i=0;URL_RE.lastIndex=0;
    el.setAttribute('style',css.replace(URL_RE,function(){var b=blobs[i++];return b?'url("'+b+'")':'none';}));
  });
}
function scan(root){
  if(root.nodeType===1&&root.hasAttribute('style'))fix(root);
  if(root.querySelectorAll){var l=root.querySelectorAll('[style*="url("]');for(var i=0;i<l.length;i++)fix(l[i]);}
}
new MutationObserver(function(recs){
  for(var i=0;i<recs.length;i++){
    var r=recs[i];
    if(r.type==='attributes')fix(r.target);
    else for(var j=0;j<r.addedNodes.length;j++){var n=r.addedNodes[j];if(n.nodeType===1)scan(n);}
  }
}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['style']});
if(document.body)scan(document.body);else document.addEventListener('DOMContentLoaded',function(){scan(document.body);});
})();</script>`;
}

// src/core/diagnostics.ts
var VSH_VISHRUN_DIAG = false;

// src/core/asset-injector.ts
function isFetchExternalResponse(p, requestId) {
  return !!p && typeof p === "object" && p.type === "fetch_external_response" && p.requestId === requestId;
}
var requestCounter2 = 0;
function nextRequestId2() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `vishrun-fx-${Date.now()}-${++requestCounter2}`;
}
function fetchViaBackend(url, ctx, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId2();
    let settled = false;
    let unsub = null;
    let timer = null;
    const finish = (run) => {
      if (settled)
        return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsub) {
        try {
          unsub();
        } catch {}
        unsub = null;
      }
      run();
    };
    unsub = ctx.onBackendMessage((payload) => {
      if (!isFetchExternalResponse(payload, requestId))
        return;
      if (payload.ok && typeof payload.body === "string") {
        const body = payload.body;
        finish(() => resolve(body));
      } else {
        finish(() => reject(new Error(payload.error || "fetch_external failed")));
      }
    });
    timer = setTimeout(() => {
      finish(() => reject(new Error("Backend fetch timeout")));
    }, timeoutMs);
    try {
      ctx.sendToBackend({ type: "fetch_external", requestId, url });
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}
var bundleCache = new Map;
function getCachedBundle(url, ctx) {
  const cached = bundleCache.get(url);
  if (cached)
    return cached;
  const pending = fetchViaBackend(url, ctx);
  bundleCache.set(url, pending);
  pending.catch(() => {
    if (bundleCache.get(url) === pending)
      bundleCache.delete(url);
  });
  return pending;
}
var TAILWIND_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*["'](https?:\/\/cdn\.tailwindcss\.com(?=[/?#"']|\s)[^"']*)["'][^>]*>\s*<\/script>/gi;
function extractTailwindUrls(html) {
  if (html.indexOf("cdn.tailwindcss.com") === -1)
    return [];
  const out = [];
  const seen = new Set;
  TAILWIND_SCRIPT_RE.lastIndex = 0;
  let m;
  while ((m = TAILWIND_SCRIPT_RE.exec(html)) !== null) {
    const url = m[1];
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}
function detectCardColorScheme(html) {
  const meta = html.match(/<meta\s+name=["']color-scheme["']\s+content=["']([^"']+)["']/i);
  if (meta)
    return meta[1].trim();
  const css = html.match(/:root\s*\{[^}]*color-scheme\s*:\s*([^;}]+)/i);
  if (css)
    return css[1].trim();
  return null;
}
async function transformHtmlForTailwind(html, ctx) {
  const urls = extractTailwindUrls(html);
  if (urls.length === 0)
    return html;
  const bundles = await Promise.all(urls.map((url) => getCachedBundle(url, ctx).catch((err) => {
    console.warn("[vishrun] Tailwind fetch failed:", url, err instanceof Error ? err.message : String(err));
    return "";
  })));
  if (bundles.every((b) => b === ""))
    return html;
  const stripped = html.replace(TAILWIND_SCRIPT_RE, "");
  const inline = bundles.filter((b) => b !== "").map((b) => `<script>${b}</script>`).join("");
  const textColorOverride = detectCardColorScheme(html) === null ? "<style>:root{color:#000 !important}</style>" : "";
  return textColorOverride + inline + stripped;
}
var CDN_SCRIPT_HOSTS = new Set([
  "unpkg.com",
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
  "esm.sh",
  "esm.run",
  "cdn.skypack.dev"
]);
var CDN_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>\s*<\/script>/gi;
function isCdnScriptUrl(url) {
  let host;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }
  return CDN_SCRIPT_HOSTS.has(host);
}
function escapeScriptBody(body) {
  return body.replace(/<\/script\b/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}
function inlineScriptTag(originalTag, body) {
  const type = originalTag.match(/\btype\s*=\s*["']([^"']+)["']/i);
  return `<script${type ? ` type="${type[1]}"` : ""}>${escapeScriptBody(body)}</script>`;
}
function extractCdnScriptUrls(html) {
  if (html.indexOf("<script") === -1)
    return [];
  const out = [];
  const seen = new Set;
  CDN_SCRIPT_RE.lastIndex = 0;
  let m;
  while ((m = CDN_SCRIPT_RE.exec(html)) !== null) {
    const url = m[1];
    if (isCdnScriptUrl(url) && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}
async function transformHtmlForCdnScripts(html, ctx) {
  const urls = extractCdnScriptUrls(html);
  if (urls.length === 0)
    return html;
  const bodyByUrl = new Map;
  await Promise.all(urls.map(async (url) => {
    try {
      bodyByUrl.set(url, await getCachedBundle(url, ctx));
    } catch (err) {
      console.warn("[vishrun] CDN script fetch failed:", url, err instanceof Error ? err.message : String(err));
    }
  }));
  if (bodyByUrl.size === 0)
    return html;
  CDN_SCRIPT_RE.lastIndex = 0;
  return html.replace(CDN_SCRIPT_RE, (full, url) => {
    const body = bodyByUrl.get(url);
    return body !== undefined ? inlineScriptTag(full, body) : full;
  });
}
async function transformHtmlForExternalScripts(html, ctx) {
  const withTailwind = await transformHtmlForTailwind(html, ctx);
  return transformHtmlForCdnScripts(withTailwind, ctx);
}

// src/core/font-proxy.ts
var FONT_LINK_RE = /<link\b[^>]*\bhref\s*=\s*["'](https?:\/\/fonts\.googleapis\.com\/[^"']+)["'][^>]*>/gi;
var FONT_STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
var FONT_IMPORT_RE = /@import\s+url\(\s*(['"]?)(https?:\/\/fonts\.googleapis\.com\/[^'")\s]+)\1\s*\)\s*;?/gi;
var FONT_FACE_BLOCK_RE = /@font-face\s*\{([^}]+)\}/gi;
var FONT_FACE_URL_RE = /src\s*:[^;]*url\(\s*['"]?(https?:\/\/[^'")\s]+)['"]?\s*\)/i;
var FONT_FACE_FAMILY_RE = /font-family\s*:\s*['"]?([^;'"]+?)['"]?\s*;/i;
var FONT_FACE_WEIGHT_RE = /font-weight\s*:\s*([^;]+?)\s*;/i;
var FONT_FACE_STYLE_RE = /font-style\s*:\s*([^;]+?)\s*;/i;
var FONT_FACE_DISPLAY_RE = /font-display\s*:\s*([^;]+?)\s*;/i;
var fontEntriesCache = new Map;
function parseFontFaceRules(css) {
  if (css.indexOf("@font-face") === -1)
    return [];
  const out = [];
  FONT_FACE_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = FONT_FACE_BLOCK_RE.exec(css)) !== null) {
    const body = m[1];
    const urlMatch = body.match(FONT_FACE_URL_RE);
    const familyMatch = body.match(FONT_FACE_FAMILY_RE);
    if (!urlMatch || !familyMatch)
      continue;
    const entry = {
      family: familyMatch[1].trim(),
      url: urlMatch[1]
    };
    const w = body.match(FONT_FACE_WEIGHT_RE);
    const s = body.match(FONT_FACE_STYLE_RE);
    const d = body.match(FONT_FACE_DISPLAY_RE);
    if (w)
      entry.weight = w[1].trim();
    if (s)
      entry.style = s[1].trim();
    if (d)
      entry.display = d[1].trim();
    out.push(entry);
  }
  return out;
}
function extractGoogleFontsLinks(html) {
  if (html.indexOf("fonts.googleapis.com") === -1)
    return [];
  const out = [];
  const seen = new Set;
  FONT_LINK_RE.lastIndex = 0;
  let m;
  while ((m = FONT_LINK_RE.exec(html)) !== null) {
    const fullTag = m[0];
    const url = decodeHtmlEntities(m[1]);
    if (!seen.has(fullTag)) {
      seen.add(fullTag);
      out.push({ fullTag, url });
    }
  }
  return out;
}
function extractGoogleFontsImports(html) {
  if (html.indexOf("fonts.googleapis.com") === -1)
    return [];
  if (html.indexOf("@import") === -1)
    return [];
  const out = [];
  const seenBlocks = new Set;
  FONT_STYLE_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = FONT_STYLE_BLOCK_RE.exec(html)) !== null) {
    const fullStyleBlock = m[0];
    const cssContent = m[1];
    if (cssContent.indexOf("@import") === -1)
      continue;
    if (cssContent.indexOf("fonts.googleapis.com") === -1)
      continue;
    if (seenBlocks.has(fullStyleBlock))
      continue;
    seenBlocks.add(fullStyleBlock);
    const imports = [];
    FONT_IMPORT_RE.lastIndex = 0;
    let im;
    while ((im = FONT_IMPORT_RE.exec(cssContent)) !== null) {
      imports.push({ raw: im[0], url: im[2] });
    }
    if (imports.length > 0)
      out.push({ fullStyleBlock, imports });
  }
  return out;
}
function decodeHtmlEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function getFontEntries(url, ctx) {
  const cached = fontEntriesCache.get(url);
  if (cached)
    return cached;
  const pending = (async () => {
    const raw = await fetchViaBackend(url, ctx);
    return parseFontFaceRules(raw);
  })();
  fontEntriesCache.set(url, pending);
  pending.catch(() => {
    if (fontEntriesCache.get(url) === pending)
      fontEntriesCache.delete(url);
  });
  return pending;
}
function htmlSafeJsonStringify(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
function buildFontConfigScript(entries) {
  return `<script type="application/vishrun-font-config" data-vishrun-fonts>${htmlSafeJsonStringify(entries)}</script>`;
}
async function transformHtmlForGoogleFonts(html, ctx) {
  const links = extractGoogleFontsLinks(html);
  const importBlocks = extractGoogleFontsImports(html);
  if (links.length === 0 && importBlocks.length === 0)
    return html;
  const allUrls = new Set;
  for (const l of links)
    allUrls.add(l.url);
  for (const ib of importBlocks)
    for (const im of ib.imports)
      allUrls.add(im.url);
  const entriesByUrl = new Map;
  const failed = new Set;
  await Promise.all(Array.from(allUrls).map(async (u) => {
    try {
      entriesByUrl.set(u, await getFontEntries(u, ctx));
    } catch (err) {
      failed.add(u);
      console.warn("[vishrun] Google Fonts fetch failed:", u, err instanceof Error ? err.message : String(err));
    }
  }));
  let out = html;
  for (const l of links) {
    if (failed.has(l.url))
      continue;
    const entries = entriesByUrl.get(l.url) ?? [];
    const replacement = entries.length === 0 ? "" : buildFontConfigScript(entries);
    out = out.split(l.fullTag).join(replacement);
  }
  for (const ib of importBlocks) {
    let stripped = ib.fullStyleBlock;
    const scripts = [];
    for (const imp of ib.imports) {
      if (failed.has(imp.url))
        continue;
      stripped = stripped.split(imp.raw).join("");
      const entries = entriesByUrl.get(imp.url) ?? [];
      if (entries.length > 0)
        scripts.push(buildFontConfigScript(entries));
    }
    if (stripped === ib.fullStyleBlock && scripts.length === 0)
      continue;
    out = out.split(ib.fullStyleBlock).join(scripts.join("") + stripped);
  }
  return out;
}

// src/core/widget-environment.ts
var SCRIPT_BODY_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
var MVU_TOKENS = [
  /\bMvu\b/,
  /\bstat_data\b/,
  /\ball_variables\b/,
  /\bwaitGlobalInitialized\s*\(/,
  /\bgetAllVariables\s*\(/,
  /\berrorCatched\s*\(/,
  /\beventOn(?:ce)?\s*\(/,
  /\beventEmit\s*\(/
];
var LODASH_TOKEN = /(?:^|[^a-zA-Z_$.\w])_\s*\.[a-zA-Z]/;
var JQUERY_TOKEN = /(?:^|[^a-zA-Z_$.\w])\$\s*\(/;
var JQUERY_NAMED_TOKEN = /\bjQuery\s*[(.]/;
var HELPERS_LIGHT_TOKENS = [
  /\bgetChatMessages\s*\(/,
  /\bsetChatMessage\s*\(/,
  /\bgetCurrentMessageId\s*\(/,
  /\bgetChatId\s*\(/,
  /\bSillyTavern\s*\.\s*(?:chat|getContext|saveChat|reloadCurrentChat)\b/,
  /\bwindow\.SillyTavern\b/
];
var SLASH_TOKEN = /\btriggerSlash\s*\(/;
function extractScriptBodies(html) {
  if (!html)
    return "";
  let combined = "";
  SCRIPT_BODY_RE.lastIndex = 0;
  let m;
  while ((m = SCRIPT_BODY_RE.exec(html)) !== null) {
    combined += m[1] + `
`;
  }
  return combined;
}
var cache = new WeakMap;
var stringCache = new Map;
var STRING_CACHE_MAX = 256;
function classifyWidgetEnvironment(html) {
  if (!html)
    return "static";
  const cached = stringCache.get(html);
  if (cached !== undefined)
    return cached;
  const result = classifyImpl(html);
  if (stringCache.size >= STRING_CACHE_MAX)
    stringCache.clear();
  stringCache.set(html, result);
  return result;
}
function classifyImpl(html) {
  const body = extractScriptBodies(html);
  if (!body)
    return "static";
  const hasMvu = MVU_TOKENS.some((re) => re.test(body));
  const hasLodash = LODASH_TOKEN.test(body);
  if (hasMvu || hasLodash)
    return "tavern-mvu";
  const hasJq = JQUERY_TOKEN.test(body) || JQUERY_NAMED_TOKEN.test(body);
  if (hasJq)
    return "tavern-jq";
  const hasHelpers = HELPERS_LIGHT_TOKENS.some((re) => re.test(body));
  if (hasHelpers)
    return "tavern-helpers-light";
  const hasSlash = SLASH_TOKEN.test(body);
  if (hasSlash)
    return "tavern-slash";
  return "static";
}
function shouldInjectThHelpersShim(env) {
  return env === "tavern-helpers-light" || env === "tavern-jq" || env === "tavern-mvu";
}
function shouldInjectJQuery(env) {
  return env === "tavern-jq" || env === "tavern-mvu";
}
function shouldInjectLodash(env) {
  return env === "tavern-mvu";
}
function shouldInjectMvuShim(env) {
  return env === "tavern-mvu";
}

// src/render/th-helpers-shim.ts
function thHelpersShim(consts) {
  const constsJson = JSON.stringify({
    currentMessageIndex: consts.currentMessageIndex,
    currentMessageId: consts.currentMessageId,
    chatId: consts.chatId,
    messagesSnapshot: consts.messagesSnapshot,
    greetings: consts.greetings ?? []
  });
  return `<script>(function(){
var THC = ${constsJson};
var pending = {};
var nextId = 0;
function makeRequestId(){ nextId = (nextId + 1) | 0; return 'th-' + Date.now().toString(36) + '-' + nextId.toString(36); }
function setup(){
  if (!window.spindleSandbox || typeof window.spindleSandbox.onMessage !== 'function') return;
  window.spindleSandbox.onMessage(function(payload){
    if (!payload || typeof payload !== 'object') return;
    if (payload.kind !== 'th-response') return;
    var rid = payload.requestId;
    var slot = pending[rid];
    if (!slot) return;
    delete pending[rid];
    if (payload.ok) slot.resolve(payload.result);
    else slot.reject(new Error(String(payload.error || 'th-helpers backend error')));
  });
}
setup();
function postRequest(kind, body){
  return new Promise(function(resolve, reject){
    if (!window.spindleSandbox || typeof window.spindleSandbox.postMessage !== 'function') {
      reject(new Error('spindleSandbox.postMessage unavailable'));
      return;
    }
    var rid = makeRequestId();
    pending[rid] = { resolve: resolve, reject: reject };
    try {
      window.spindleSandbox.postMessage({ kind: 'th-request', requestId: rid, op: kind, body: body });
    } catch (e) {
      delete pending[rid];
      reject(e);
    }
  });
}
function resolveIdx(range, total, cur){
  if (total === 0) return null;
  if (typeof range === 'number') return range >= 0 ? range : total + range;
  if (typeof range === 'string') {
    var t = range.trim();
    if (t === '' || t === 'latest') return total - 1;
    if (t === 'this') return cur;
    if (/^-?\\d+$/.test(t)) {
      var n = parseInt(t, 10);
      return n >= 0 ? n : total + n;
    }
  }
  return null;
}
function shape(m, withSwipes){
  if (withSwipes) {
    var sw = m.swipes;
    var blanks = [];
    for (var i = 0; i < sw.length; i++) blanks.push({});
    return {
      message_id: m.message_id, name: m.name, role: m.role, is_hidden: m.is_hidden,
      swipe_id: m.swipe_id, swipes: sw, swipes_data: blanks.slice(), swipes_info: blanks.slice()
    };
  }
  return {
    message_id: m.message_id, name: m.name, role: m.role, is_hidden: m.is_hidden,
    message: m.message, swipe_id: m.swipe_id, swipes: m.swipes, data: m.data, extra: m.extra
  };
}
window.getCurrentMessageId = function(){ return THC.currentMessageIndex; };
window.getChatId = function(){ return THC.chatId; };
window.getChatMessages = function(range, opts){
  var snap = THC.messagesSnapshot;
  var idx = resolveIdx(range, snap.length, THC.currentMessageIndex);
  if (idx === null || idx < 0 || idx >= snap.length) return [];
  var withSwipes = !!opts && (opts.include_swipe === true || opts.include_swipes === true);
  return [shape(snap[idx], withSwipes)];
};
window.setChatMessage = function(fieldValues, messageId, opts){
  var normalized = (typeof fieldValues === 'string') ? { message: fieldValues } : fieldValues;
  return postRequest('th-set-chat-message', { fieldValues: normalized, messageId: messageId, opts: opts || {} });
};
// SillyTavern global (ST.chat + saveChat). Cards mutate chat[] in place and
// save; saveChat diffs against the snapshot and routes the changes: a new
// swipe_id on the greeting goes to setChatMessages, an edited mes to
// setChatMessage. reloadCurrentChat is a no-op: the host re-renders on save.
if (!window.SillyTavern) {
  var stChat = THC.messagesSnapshot.map(function(m){
    return {
      name: m.name, is_user: m.role === 'user', is_system: false,
      mes: m.message, swipe_id: m.swipe_id, swipes: (m.swipes || []).slice(), extra: m.extra || {}
    };
  });
  // The greeting lives in slot 0 with its text swapped, so the snapshot cannot
  // tell which greeting is shown. Use the card greetings and match the text.
  var greetings = THC.greetings || [];
  if (stChat[0] && !stChat[0].is_user && greetings.length > 1) {
    var norm = function(s){ return String(s == null ? '' : s).replace(/\\r\\n?/g, '\\n').trim(); };
    var shown = norm(stChat[0].mes);
    stChat[0].swipes = greetings.slice();
    stChat[0].swipe_id = -1;
    for (var g = 0; g < greetings.length; g++) {
      if (norm(greetings[g]) === shown) { stChat[0].swipe_id = g; break; }
    }
  }
  var stBase = stChat.map(function(m){ return { swipe_id: m.swipe_id, mes: m.mes }; });
  var saveChat = function(){
    var jobs = [];
    for (var i = 0; i < stChat.length; i++) {
      var m = stChat[i], b = stBase[i];
      if (!m || !b) continue;
      if (i === 0 && m.swipe_id !== b.swipe_id && typeof window.setChatMessages === 'function') {
        window.setChatMessages([{ message_id: 0, swipe_id: m.swipe_id }]);
      } else if (m.mes !== b.mes) {
        jobs.push(window.setChatMessage({ message: m.mes }, i));
      }
      stBase[i] = { swipe_id: m.swipe_id, mes: m.mes };
    }
    return Promise.all(jobs).then(function(){});
  };
  var reloadCurrentChat = function(){ return Promise.resolve(); };
  var stContext = function(){
    return { chat: stChat, chatId: THC.chatId, getCurrentChatId: function(){ return THC.chatId; },
      saveChat: saveChat, reloadCurrentChat: reloadCurrentChat };
  };
  window.SillyTavern = { chat: stChat, saveChat: saveChat, reloadCurrentChat: reloadCurrentChat, getContext: stContext };
}
})();</script>`;
}

// src/core/mvu-data.ts
function emptyMvuData() {
  return { stat_data: {} };
}

// src/render/th-helpers-bridge.ts
var TH_TIMEOUT_MS = 5000;
function isThHelpersResponse(p, requestId) {
  if (!p || typeof p !== "object")
    return false;
  const r = p;
  return r.type === "th_helpers_response" && r.requestId === requestId && typeof r.ok === "boolean";
}
function isThRequest(p) {
  if (!p || typeof p !== "object")
    return false;
  const r = p;
  return r.kind === "th-request" && typeof r.requestId === "string" && typeof r.op === "string" && !!r.body && typeof r.body === "object";
}
var backendRequestCounter = 0;
function nextBackendRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `vishrun-th-${Date.now()}-${++backendRequestCounter}`;
}
function dispatchThRequest(frame, request, context, ctx) {
  const { requestId, op, body } = request;
  let settled = false;
  let unsub = null;
  let timer = null;
  const respond = (resp) => {
    if (settled)
      return;
    settled = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (unsub) {
      try {
        unsub();
      } catch {}
      unsub = null;
    }
    try {
      frame.postMessage({ kind: "th-response", requestId, ok: resp.ok, result: resp.result, error: resp.error });
    } catch {}
  };
  unsub = ctx.onBackendMessage((payload) => {
    if (!isThHelpersResponse(payload, requestId))
      return;
    respond({ ok: payload.ok, result: payload.result, error: payload.error });
  });
  timer = setTimeout(() => {
    respond({ ok: false, error: "th-helpers backend timeout" });
  }, TH_TIMEOUT_MS);
  try {
    ctx.sendToBackend({
      type: "th_helpers_request",
      requestId,
      op,
      chatId: context.chatId,
      currentMessageId: context.currentMessageId,
      currentMessageIndex: context.currentMessageIndex,
      body
    });
  } catch (err) {
    respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
function fetchMessagesSnapshot(context, ctx, timeoutMs = TH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const requestId = nextBackendRequestId();
    let settled = false;
    let unsub = null;
    let timer = null;
    const finish = (value) => {
      if (settled)
        return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsub) {
        try {
          unsub();
        } catch {}
        unsub = null;
      }
      resolve(value);
    };
    unsub = ctx.onBackendMessage((payload) => {
      if (!isThHelpersResponse(payload, requestId))
        return;
      if (payload.ok && Array.isArray(payload.result)) {
        finish(payload.result);
      } else {
        console.warn("[vishrun:th-helpers] messages snapshot fetch failed:", payload.ok ? "malformed result" : payload.error || "unknown error");
        finish([]);
      }
    });
    timer = setTimeout(() => {
      console.warn("[vishrun:th-helpers] messages snapshot fetch timed out");
      finish([]);
    }, timeoutMs);
    try {
      ctx.sendToBackend({
        type: "th_helpers_request",
        requestId,
        op: "th-get-messages-snapshot",
        chatId: context.chatId,
        currentMessageId: context.currentMessageId,
        currentMessageIndex: context.currentMessageIndex,
        body: {}
      });
    } catch (err) {
      console.warn("[vishrun:th-helpers] sendToBackend threw:", err instanceof Error ? err.message : String(err));
      finish([]);
    }
  });
}
function fetchVariablesSnapshot(context, ctx, timeoutMs = TH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const requestId = nextBackendRequestId();
    let settled = false;
    let unsub = null;
    let timer = null;
    const finish = (value) => {
      if (settled)
        return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsub) {
        try {
          unsub();
        } catch {}
        unsub = null;
      }
      resolve(value);
    };
    unsub = ctx.onBackendMessage((payload) => {
      if (!isThHelpersResponse(payload, requestId))
        return;
      if (payload.ok && payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)) {
        const r = payload.result;
        if (r.stat_data && typeof r.stat_data === "object") {
          finish(r);
          return;
        }
      }
      console.warn("[vishrun:th-helpers] variables snapshot fetch failed:", payload.ok ? "malformed result" : payload.error || "unknown error");
      finish(emptyMvuData());
    });
    timer = setTimeout(() => {
      console.warn("[vishrun:th-helpers] variables snapshot fetch timed out");
      finish(emptyMvuData());
    }, timeoutMs);
    try {
      ctx.sendToBackend({
        type: "th_helpers_request",
        requestId,
        op: "th-get-variables-snapshot",
        chatId: context.chatId,
        currentMessageId: context.currentMessageId,
        currentMessageIndex: context.currentMessageIndex,
        body: {}
      });
    } catch (err) {
      console.warn("[vishrun:th-helpers] sendToBackend threw:", err instanceof Error ? err.message : String(err));
      finish(emptyMvuData());
    }
  });
}
function computeMessageIndexInChat(messageId, doc = document) {
  const all = doc.querySelectorAll("[data-message-id]");
  for (let i = 0;i < all.length; i++) {
    if (all[i].getAttribute("data-message-id") === messageId)
      return i;
  }
  return -1;
}

// src/vendor/jquery-3.5.1.min.js
var jquery_3_5_1_min_default = `/*! jQuery v3.5.1 | (c) JS Foundation and other contributors | jquery.org/license */\r
!function(e,t){"use strict";"object"==typeof module&&"object"==typeof module.exports?module.exports=e.document?t(e,!0):function(e){if(!e.document)throw new Error("jQuery requires a window with a document");return t(e)}:t(e)}("undefined"!=typeof window?window:this,function(C,e){"use strict";var t=[],r=Object.getPrototypeOf,s=t.slice,g=t.flat?function(e){return t.flat.call(e)}:function(e){return t.concat.apply([],e)},u=t.push,i=t.indexOf,n={},o=n.toString,v=n.hasOwnProperty,a=v.toString,l=a.call(Object),y={},m=function(e){return"function"==typeof e&&"number"!=typeof e.nodeType},x=function(e){return null!=e&&e===e.window},E=C.document,c={type:!0,src:!0,nonce:!0,noModule:!0};function b(e,t,n){var r,i,o=(n=n||E).createElement("script");if(o.text=e,t)for(r in c)(i=t[r]||t.getAttribute&&t.getAttribute(r))&&o.setAttribute(r,i);n.head.appendChild(o).parentNode.removeChild(o)}function w(e){return null==e?e+"":"object"==typeof e||"function"==typeof e?n[o.call(e)]||"object":typeof e}var f="3.5.1",S=function(e,t){return new S.fn.init(e,t)};function p(e){var t=!!e&&"length"in e&&e.length,n=w(e);return!m(e)&&!x(e)&&("array"===n||0===t||"number"==typeof t&&0<t&&t-1 in e)}S.fn=S.prototype={jquery:f,constructor:S,length:0,toArray:function(){return s.call(this)},get:function(e){return null==e?s.call(this):e<0?this[e+this.length]:this[e]},pushStack:function(e){var t=S.merge(this.constructor(),e);return t.prevObject=this,t},each:function(e){return S.each(this,e)},map:function(n){return this.pushStack(S.map(this,function(e,t){return n.call(e,t,e)}))},slice:function(){return this.pushStack(s.apply(this,arguments))},first:function(){return this.eq(0)},last:function(){return this.eq(-1)},even:function(){return this.pushStack(S.grep(this,function(e,t){return(t+1)%2}))},odd:function(){return this.pushStack(S.grep(this,function(e,t){return t%2}))},eq:function(e){var t=this.length,n=+e+(e<0?t:0);return this.pushStack(0<=n&&n<t?[this[n]]:[])},end:function(){return this.prevObject||this.constructor()},push:u,sort:t.sort,splice:t.splice},S.extend=S.fn.extend=function(){var e,t,n,r,i,o,a=arguments[0]||{},s=1,u=arguments.length,l=!1;for("boolean"==typeof a&&(l=a,a=arguments[s]||{},s++),"object"==typeof a||m(a)||(a={}),s===u&&(a=this,s--);s<u;s++)if(null!=(e=arguments[s]))for(t in e)r=e[t],"__proto__"!==t&&a!==r&&(l&&r&&(S.isPlainObject(r)||(i=Array.isArray(r)))?(n=a[t],o=i&&!Array.isArray(n)?[]:i||S.isPlainObject(n)?n:{},i=!1,a[t]=S.extend(l,o,r)):void 0!==r&&(a[t]=r));return a},S.extend({expando:"jQuery"+(f+Math.random()).replace(/\\D/g,""),isReady:!0,error:function(e){throw new Error(e)},noop:function(){},isPlainObject:function(e){var t,n;return!(!e||"[object Object]"!==o.call(e))&&(!(t=r(e))||"function"==typeof(n=v.call(t,"constructor")&&t.constructor)&&a.call(n)===l)},isEmptyObject:function(e){var t;for(t in e)return!1;return!0},globalEval:function(e,t,n){b(e,{nonce:t&&t.nonce},n)},each:function(e,t){var n,r=0;if(p(e)){for(n=e.length;r<n;r++)if(!1===t.call(e[r],r,e[r]))break}else for(r in e)if(!1===t.call(e[r],r,e[r]))break;return e},makeArray:function(e,t){var n=t||[];return null!=e&&(p(Object(e))?S.merge(n,"string"==typeof e?[e]:e):u.call(n,e)),n},inArray:function(e,t,n){return null==t?-1:i.call(t,e,n)},merge:function(e,t){for(var n=+t.length,r=0,i=e.length;r<n;r++)e[i++]=t[r];return e.length=i,e},grep:function(e,t,n){for(var r=[],i=0,o=e.length,a=!n;i<o;i++)!t(e[i],i)!==a&&r.push(e[i]);return r},map:function(e,t,n){var r,i,o=0,a=[];if(p(e))for(r=e.length;o<r;o++)null!=(i=t(e[o],o,n))&&a.push(i);else for(o in e)null!=(i=t(e[o],o,n))&&a.push(i);return g(a)},guid:1,support:y}),"function"==typeof Symbol&&(S.fn[Symbol.iterator]=t[Symbol.iterator]),S.each("Boolean Number String Function Array Date RegExp Object Error Symbol".split(" "),function(e,t){n["[object "+t+"]"]=t.toLowerCase()});var d=function(n){var e,d,b,o,i,h,f,g,w,u,l,T,C,a,E,v,s,c,y,S="sizzle"+1*new Date,p=n.document,k=0,r=0,m=ue(),x=ue(),A=ue(),N=ue(),D=function(e,t){return e===t&&(l=!0),0},j={}.hasOwnProperty,t=[],q=t.pop,L=t.push,H=t.push,O=t.slice,P=function(e,t){for(var n=0,r=e.length;n<r;n++)if(e[n]===t)return n;return-1},R="checked|selected|async|autofocus|autoplay|controls|defer|disabled|hidden|ismap|loop|multiple|open|readonly|required|scoped",M="[\\\\x20\\\\t\\\\r\\\\n\\\\f]",I="(?:\\\\\\\\[\\\\da-fA-F]{1,6}"+M+"?|\\\\\\\\[^\\\\r\\\\n\\\\f]|[\\\\w-]|[^\\0-\\\\x7f])+",W="\\\\["+M+"*("+I+")(?:"+M+"*([*^$|!~]?=)"+M+"*(?:'((?:\\\\\\\\.|[^\\\\\\\\'])*)'|\\"((?:\\\\\\\\.|[^\\\\\\\\\\"])*)\\"|("+I+"))|)"+M+"*\\\\]",F=":("+I+")(?:\\\\((('((?:\\\\\\\\.|[^\\\\\\\\'])*)'|\\"((?:\\\\\\\\.|[^\\\\\\\\\\"])*)\\")|((?:\\\\\\\\.|[^\\\\\\\\()[\\\\]]|"+W+")*)|.*)\\\\)|)",B=new RegExp(M+"+","g"),$=new RegExp("^"+M+"+|((?:^|[^\\\\\\\\])(?:\\\\\\\\.)*)"+M+"+$","g"),_=new RegExp("^"+M+"*,"+M+"*"),z=new RegExp("^"+M+"*([>+~]|"+M+")"+M+"*"),U=new RegExp(M+"|>"),X=new RegExp(F),V=new RegExp("^"+I+"$"),G={ID:new RegExp("^#("+I+")"),CLASS:new RegExp("^\\\\.("+I+")"),TAG:new RegExp("^("+I+"|[*])"),ATTR:new RegExp("^"+W),PSEUDO:new RegExp("^"+F),CHILD:new RegExp("^:(only|first|last|nth|nth-last)-(child|of-type)(?:\\\\("+M+"*(even|odd|(([+-]|)(\\\\d*)n|)"+M+"*(?:([+-]|)"+M+"*(\\\\d+)|))"+M+"*\\\\)|)","i"),bool:new RegExp("^(?:"+R+")$","i"),needsContext:new RegExp("^"+M+"*[>+~]|:(even|odd|eq|gt|lt|nth|first|last)(?:\\\\("+M+"*((?:-\\\\d)?\\\\d*)"+M+"*\\\\)|)(?=[^-]|$)","i")},Y=/HTML$/i,Q=/^(?:input|select|textarea|button)$/i,J=/^h\\d$/i,K=/^[^{]+\\{\\s*\\[native \\w/,Z=/^(?:#([\\w-]+)|(\\w+)|\\.([\\w-]+))$/,ee=/[+~]/,te=new RegExp("\\\\\\\\[\\\\da-fA-F]{1,6}"+M+"?|\\\\\\\\([^\\\\r\\\\n\\\\f])","g"),ne=function(e,t){var n="0x"+e.slice(1)-65536;return t||(n<0?String.fromCharCode(n+65536):String.fromCharCode(n>>10|55296,1023&n|56320))},re=/([\\0-\\x1f\\x7f]|^-?\\d)|^-$|[^\\0-\\x1f\\x7f-\\uFFFF\\w-]/g,ie=function(e,t){return t?"\\0"===e?"\\ufffd":e.slice(0,-1)+"\\\\"+e.charCodeAt(e.length-1).toString(16)+" ":"\\\\"+e},oe=function(){T()},ae=be(function(e){return!0===e.disabled&&"fieldset"===e.nodeName.toLowerCase()},{dir:"parentNode",next:"legend"});try{H.apply(t=O.call(p.childNodes),p.childNodes),t[p.childNodes.length].nodeType}catch(e){H={apply:t.length?function(e,t){L.apply(e,O.call(t))}:function(e,t){var n=e.length,r=0;while(e[n++]=t[r++]);e.length=n-1}}}function se(t,e,n,r){var i,o,a,s,u,l,c,f=e&&e.ownerDocument,p=e?e.nodeType:9;if(n=n||[],"string"!=typeof t||!t||1!==p&&9!==p&&11!==p)return n;if(!r&&(T(e),e=e||C,E)){if(11!==p&&(u=Z.exec(t)))if(i=u[1]){if(9===p){if(!(a=e.getElementById(i)))return n;if(a.id===i)return n.push(a),n}else if(f&&(a=f.getElementById(i))&&y(e,a)&&a.id===i)return n.push(a),n}else{if(u[2])return H.apply(n,e.getElementsByTagName(t)),n;if((i=u[3])&&d.getElementsByClassName&&e.getElementsByClassName)return H.apply(n,e.getElementsByClassName(i)),n}if(d.qsa&&!N[t+" "]&&(!v||!v.test(t))&&(1!==p||"object"!==e.nodeName.toLowerCase())){if(c=t,f=e,1===p&&(U.test(t)||z.test(t))){(f=ee.test(t)&&ye(e.parentNode)||e)===e&&d.scope||((s=e.getAttribute("id"))?s=s.replace(re,ie):e.setAttribute("id",s=S)),o=(l=h(t)).length;while(o--)l[o]=(s?"#"+s:":scope")+" "+xe(l[o]);c=l.join(",")}try{return H.apply(n,f.querySelectorAll(c)),n}catch(e){N(t,!0)}finally{s===S&&e.removeAttribute("id")}}}return g(t.replace($,"$1"),e,n,r)}function ue(){var r=[];return function e(t,n){return r.push(t+" ")>b.cacheLength&&delete e[r.shift()],e[t+" "]=n}}function le(e){return e[S]=!0,e}function ce(e){var t=C.createElement("fieldset");try{return!!e(t)}catch(e){return!1}finally{t.parentNode&&t.parentNode.removeChild(t),t=null}}function fe(e,t){var n=e.split("|"),r=n.length;while(r--)b.attrHandle[n[r]]=t}function pe(e,t){var n=t&&e,r=n&&1===e.nodeType&&1===t.nodeType&&e.sourceIndex-t.sourceIndex;if(r)return r;if(n)while(n=n.nextSibling)if(n===t)return-1;return e?1:-1}function de(t){return function(e){return"input"===e.nodeName.toLowerCase()&&e.type===t}}function he(n){return function(e){var t=e.nodeName.toLowerCase();return("input"===t||"button"===t)&&e.type===n}}function ge(t){return function(e){return"form"in e?e.parentNode&&!1===e.disabled?"label"in e?"label"in e.parentNode?e.parentNode.disabled===t:e.disabled===t:e.isDisabled===t||e.isDisabled!==!t&&ae(e)===t:e.disabled===t:"label"in e&&e.disabled===t}}function ve(a){return le(function(o){return o=+o,le(function(e,t){var n,r=a([],e.length,o),i=r.length;while(i--)e[n=r[i]]&&(e[n]=!(t[n]=e[n]))})})}function ye(e){return e&&"undefined"!=typeof e.getElementsByTagName&&e}for(e in d=se.support={},i=se.isXML=function(e){var t=e.namespaceURI,n=(e.ownerDocument||e).documentElement;return!Y.test(t||n&&n.nodeName||"HTML")},T=se.setDocument=function(e){var t,n,r=e?e.ownerDocument||e:p;return r!=C&&9===r.nodeType&&r.documentElement&&(a=(C=r).documentElement,E=!i(C),p!=C&&(n=C.defaultView)&&n.top!==n&&(n.addEventListener?n.addEventListener("unload",oe,!1):n.attachEvent&&n.attachEvent("onunload",oe)),d.scope=ce(function(e){return a.appendChild(e).appendChild(C.createElement("div")),"undefined"!=typeof e.querySelectorAll&&!e.querySelectorAll(":scope fieldset div").length}),d.attributes=ce(function(e){return e.className="i",!e.getAttribute("className")}),d.getElementsByTagName=ce(function(e){return e.appendChild(C.createComment("")),!e.getElementsByTagName("*").length}),d.getElementsByClassName=K.test(C.getElementsByClassName),d.getById=ce(function(e){return a.appendChild(e).id=S,!C.getElementsByName||!C.getElementsByName(S).length}),d.getById?(b.filter.ID=function(e){var t=e.replace(te,ne);return function(e){return e.getAttribute("id")===t}},b.find.ID=function(e,t){if("undefined"!=typeof t.getElementById&&E){var n=t.getElementById(e);return n?[n]:[]}}):(b.filter.ID=function(e){var n=e.replace(te,ne);return function(e){var t="undefined"!=typeof e.getAttributeNode&&e.getAttributeNode("id");return t&&t.value===n}},b.find.ID=function(e,t){if("undefined"!=typeof t.getElementById&&E){var n,r,i,o=t.getElementById(e);if(o){if((n=o.getAttributeNode("id"))&&n.value===e)return[o];i=t.getElementsByName(e),r=0;while(o=i[r++])if((n=o.getAttributeNode("id"))&&n.value===e)return[o]}return[]}}),b.find.TAG=d.getElementsByTagName?function(e,t){return"undefined"!=typeof t.getElementsByTagName?t.getElementsByTagName(e):d.qsa?t.querySelectorAll(e):void 0}:function(e,t){var n,r=[],i=0,o=t.getElementsByTagName(e);if("*"===e){while(n=o[i++])1===n.nodeType&&r.push(n);return r}return o},b.find.CLASS=d.getElementsByClassName&&function(e,t){if("undefined"!=typeof t.getElementsByClassName&&E)return t.getElementsByClassName(e)},s=[],v=[],(d.qsa=K.test(C.querySelectorAll))&&(ce(function(e){var t;a.appendChild(e).innerHTML="<a id='"+S+"'></a><select id='"+S+"-\\r\\\\' msallowcapture=''><option selected=''></option></select>",e.querySelectorAll("[msallowcapture^='']").length&&v.push("[*^$]="+M+"*(?:''|\\"\\")"),e.querySelectorAll("[selected]").length||v.push("\\\\["+M+"*(?:value|"+R+")"),e.querySelectorAll("[id~="+S+"-]").length||v.push("~="),(t=C.createElement("input")).setAttribute("name",""),e.appendChild(t),e.querySelectorAll("[name='']").length||v.push("\\\\["+M+"*name"+M+"*="+M+"*(?:''|\\"\\")"),e.querySelectorAll(":checked").length||v.push(":checked"),e.querySelectorAll("a#"+S+"+*").length||v.push(".#.+[+~]"),e.querySelectorAll("\\\\\\f"),v.push("[\\\\r\\\\n\\\\f]")}),ce(function(e){e.innerHTML="<a href='' disabled='disabled'></a><select disabled='disabled'><option/></select>";var t=C.createElement("input");t.setAttribute("type","hidden"),e.appendChild(t).setAttribute("name","D"),e.querySelectorAll("[name=d]").length&&v.push("name"+M+"*[*^$|!~]?="),2!==e.querySelectorAll(":enabled").length&&v.push(":enabled",":disabled"),a.appendChild(e).disabled=!0,2!==e.querySelectorAll(":disabled").length&&v.push(":enabled",":disabled"),e.querySelectorAll("*,:x"),v.push(",.*:")})),(d.matchesSelector=K.test(c=a.matches||a.webkitMatchesSelector||a.mozMatchesSelector||a.oMatchesSelector||a.msMatchesSelector))&&ce(function(e){d.disconnectedMatch=c.call(e,"*"),c.call(e,"[s!='']:x"),s.push("!=",F)}),v=v.length&&new RegExp(v.join("|")),s=s.length&&new RegExp(s.join("|")),t=K.test(a.compareDocumentPosition),y=t||K.test(a.contains)?function(e,t){var n=9===e.nodeType?e.documentElement:e,r=t&&t.parentNode;return e===r||!(!r||1!==r.nodeType||!(n.contains?n.contains(r):e.compareDocumentPosition&&16&e.compareDocumentPosition(r)))}:function(e,t){if(t)while(t=t.parentNode)if(t===e)return!0;return!1},D=t?function(e,t){if(e===t)return l=!0,0;var n=!e.compareDocumentPosition-!t.compareDocumentPosition;return n||(1&(n=(e.ownerDocument||e)==(t.ownerDocument||t)?e.compareDocumentPosition(t):1)||!d.sortDetached&&t.compareDocumentPosition(e)===n?e==C||e.ownerDocument==p&&y(p,e)?-1:t==C||t.ownerDocument==p&&y(p,t)?1:u?P(u,e)-P(u,t):0:4&n?-1:1)}:function(e,t){if(e===t)return l=!0,0;var n,r=0,i=e.parentNode,o=t.parentNode,a=[e],s=[t];if(!i||!o)return e==C?-1:t==C?1:i?-1:o?1:u?P(u,e)-P(u,t):0;if(i===o)return pe(e,t);n=e;while(n=n.parentNode)a.unshift(n);n=t;while(n=n.parentNode)s.unshift(n);while(a[r]===s[r])r++;return r?pe(a[r],s[r]):a[r]==p?-1:s[r]==p?1:0}),C},se.matches=function(e,t){return se(e,null,null,t)},se.matchesSelector=function(e,t){if(T(e),d.matchesSelector&&E&&!N[t+" "]&&(!s||!s.test(t))&&(!v||!v.test(t)))try{var n=c.call(e,t);if(n||d.disconnectedMatch||e.document&&11!==e.document.nodeType)return n}catch(e){N(t,!0)}return 0<se(t,C,null,[e]).length},se.contains=function(e,t){return(e.ownerDocument||e)!=C&&T(e),y(e,t)},se.attr=function(e,t){(e.ownerDocument||e)!=C&&T(e);var n=b.attrHandle[t.toLowerCase()],r=n&&j.call(b.attrHandle,t.toLowerCase())?n(e,t,!E):void 0;return void 0!==r?r:d.attributes||!E?e.getAttribute(t):(r=e.getAttributeNode(t))&&r.specified?r.value:null},se.escape=function(e){return(e+"").replace(re,ie)},se.error=function(e){throw new Error("Syntax error, unrecognized expression: "+e)},se.uniqueSort=function(e){var t,n=[],r=0,i=0;if(l=!d.detectDuplicates,u=!d.sortStable&&e.slice(0),e.sort(D),l){while(t=e[i++])t===e[i]&&(r=n.push(i));while(r--)e.splice(n[r],1)}return u=null,e},o=se.getText=function(e){var t,n="",r=0,i=e.nodeType;if(i){if(1===i||9===i||11===i){if("string"==typeof e.textContent)return e.textContent;for(e=e.firstChild;e;e=e.nextSibling)n+=o(e)}else if(3===i||4===i)return e.nodeValue}else while(t=e[r++])n+=o(t);return n},(b=se.selectors={cacheLength:50,createPseudo:le,match:G,attrHandle:{},find:{},relative:{">":{dir:"parentNode",first:!0}," ":{dir:"parentNode"},"+":{dir:"previousSibling",first:!0},"~":{dir:"previousSibling"}},preFilter:{ATTR:function(e){return e[1]=e[1].replace(te,ne),e[3]=(e[3]||e[4]||e[5]||"").replace(te,ne),"~="===e[2]&&(e[3]=" "+e[3]+" "),e.slice(0,4)},CHILD:function(e){return e[1]=e[1].toLowerCase(),"nth"===e[1].slice(0,3)?(e[3]||se.error(e[0]),e[4]=+(e[4]?e[5]+(e[6]||1):2*("even"===e[3]||"odd"===e[3])),e[5]=+(e[7]+e[8]||"odd"===e[3])):e[3]&&se.error(e[0]),e},PSEUDO:function(e){var t,n=!e[6]&&e[2];return G.CHILD.test(e[0])?null:(e[3]?e[2]=e[4]||e[5]||"":n&&X.test(n)&&(t=h(n,!0))&&(t=n.indexOf(")",n.length-t)-n.length)&&(e[0]=e[0].slice(0,t),e[2]=n.slice(0,t)),e.slice(0,3))}},filter:{TAG:function(e){var t=e.replace(te,ne).toLowerCase();return"*"===e?function(){return!0}:function(e){return e.nodeName&&e.nodeName.toLowerCase()===t}},CLASS:function(e){var t=m[e+" "];return t||(t=new RegExp("(^|"+M+")"+e+"("+M+"|$)"))&&m(e,function(e){return t.test("string"==typeof e.className&&e.className||"undefined"!=typeof e.getAttribute&&e.getAttribute("class")||"")})},ATTR:function(n,r,i){return function(e){var t=se.attr(e,n);return null==t?"!="===r:!r||(t+="","="===r?t===i:"!="===r?t!==i:"^="===r?i&&0===t.indexOf(i):"*="===r?i&&-1<t.indexOf(i):"$="===r?i&&t.slice(-i.length)===i:"~="===r?-1<(" "+t.replace(B," ")+" ").indexOf(i):"|="===r&&(t===i||t.slice(0,i.length+1)===i+"-"))}},CHILD:function(h,e,t,g,v){var y="nth"!==h.slice(0,3),m="last"!==h.slice(-4),x="of-type"===e;return 1===g&&0===v?function(e){return!!e.parentNode}:function(e,t,n){var r,i,o,a,s,u,l=y!==m?"nextSibling":"previousSibling",c=e.parentNode,f=x&&e.nodeName.toLowerCase(),p=!n&&!x,d=!1;if(c){if(y){while(l){a=e;while(a=a[l])if(x?a.nodeName.toLowerCase()===f:1===a.nodeType)return!1;u=l="only"===h&&!u&&"nextSibling"}return!0}if(u=[m?c.firstChild:c.lastChild],m&&p){d=(s=(r=(i=(o=(a=c)[S]||(a[S]={}))[a.uniqueID]||(o[a.uniqueID]={}))[h]||[])[0]===k&&r[1])&&r[2],a=s&&c.childNodes[s];while(a=++s&&a&&a[l]||(d=s=0)||u.pop())if(1===a.nodeType&&++d&&a===e){i[h]=[k,s,d];break}}else if(p&&(d=s=(r=(i=(o=(a=e)[S]||(a[S]={}))[a.uniqueID]||(o[a.uniqueID]={}))[h]||[])[0]===k&&r[1]),!1===d)while(a=++s&&a&&a[l]||(d=s=0)||u.pop())if((x?a.nodeName.toLowerCase()===f:1===a.nodeType)&&++d&&(p&&((i=(o=a[S]||(a[S]={}))[a.uniqueID]||(o[a.uniqueID]={}))[h]=[k,d]),a===e))break;return(d-=v)===g||d%g==0&&0<=d/g}}},PSEUDO:function(e,o){var t,a=b.pseudos[e]||b.setFilters[e.toLowerCase()]||se.error("unsupported pseudo: "+e);return a[S]?a(o):1<a.length?(t=[e,e,"",o],b.setFilters.hasOwnProperty(e.toLowerCase())?le(function(e,t){var n,r=a(e,o),i=r.length;while(i--)e[n=P(e,r[i])]=!(t[n]=r[i])}):function(e){return a(e,0,t)}):a}},pseudos:{not:le(function(e){var r=[],i=[],s=f(e.replace($,"$1"));return s[S]?le(function(e,t,n,r){var i,o=s(e,null,r,[]),a=e.length;while(a--)(i=o[a])&&(e[a]=!(t[a]=i))}):function(e,t,n){return r[0]=e,s(r,null,n,i),r[0]=null,!i.pop()}}),has:le(function(t){return function(e){return 0<se(t,e).length}}),contains:le(function(t){return t=t.replace(te,ne),function(e){return-1<(e.textContent||o(e)).indexOf(t)}}),lang:le(function(n){return V.test(n||"")||se.error("unsupported lang: "+n),n=n.replace(te,ne).toLowerCase(),function(e){var t;do{if(t=E?e.lang:e.getAttribute("xml:lang")||e.getAttribute("lang"))return(t=t.toLowerCase())===n||0===t.indexOf(n+"-")}while((e=e.parentNode)&&1===e.nodeType);return!1}}),target:function(e){var t=n.location&&n.location.hash;return t&&t.slice(1)===e.id},root:function(e){return e===a},focus:function(e){return e===C.activeElement&&(!C.hasFocus||C.hasFocus())&&!!(e.type||e.href||~e.tabIndex)},enabled:ge(!1),disabled:ge(!0),checked:function(e){var t=e.nodeName.toLowerCase();return"input"===t&&!!e.checked||"option"===t&&!!e.selected},selected:function(e){return e.parentNode&&e.parentNode.selectedIndex,!0===e.selected},empty:function(e){for(e=e.firstChild;e;e=e.nextSibling)if(e.nodeType<6)return!1;return!0},parent:function(e){return!b.pseudos.empty(e)},header:function(e){return J.test(e.nodeName)},input:function(e){return Q.test(e.nodeName)},button:function(e){var t=e.nodeName.toLowerCase();return"input"===t&&"button"===e.type||"button"===t},text:function(e){var t;return"input"===e.nodeName.toLowerCase()&&"text"===e.type&&(null==(t=e.getAttribute("type"))||"text"===t.toLowerCase())},first:ve(function(){return[0]}),last:ve(function(e,t){return[t-1]}),eq:ve(function(e,t,n){return[n<0?n+t:n]}),even:ve(function(e,t){for(var n=0;n<t;n+=2)e.push(n);return e}),odd:ve(function(e,t){for(var n=1;n<t;n+=2)e.push(n);return e}),lt:ve(function(e,t,n){for(var r=n<0?n+t:t<n?t:n;0<=--r;)e.push(r);return e}),gt:ve(function(e,t,n){for(var r=n<0?n+t:n;++r<t;)e.push(r);return e})}}).pseudos.nth=b.pseudos.eq,{radio:!0,checkbox:!0,file:!0,password:!0,image:!0})b.pseudos[e]=de(e);for(e in{submit:!0,reset:!0})b.pseudos[e]=he(e);function me(){}function xe(e){for(var t=0,n=e.length,r="";t<n;t++)r+=e[t].value;return r}function be(s,e,t){var u=e.dir,l=e.next,c=l||u,f=t&&"parentNode"===c,p=r++;return e.first?function(e,t,n){while(e=e[u])if(1===e.nodeType||f)return s(e,t,n);return!1}:function(e,t,n){var r,i,o,a=[k,p];if(n){while(e=e[u])if((1===e.nodeType||f)&&s(e,t,n))return!0}else while(e=e[u])if(1===e.nodeType||f)if(i=(o=e[S]||(e[S]={}))[e.uniqueID]||(o[e.uniqueID]={}),l&&l===e.nodeName.toLowerCase())e=e[u]||e;else{if((r=i[c])&&r[0]===k&&r[1]===p)return a[2]=r[2];if((i[c]=a)[2]=s(e,t,n))return!0}return!1}}function we(i){return 1<i.length?function(e,t,n){var r=i.length;while(r--)if(!i[r](e,t,n))return!1;return!0}:i[0]}function Te(e,t,n,r,i){for(var o,a=[],s=0,u=e.length,l=null!=t;s<u;s++)(o=e[s])&&(n&&!n(o,r,i)||(a.push(o),l&&t.push(s)));return a}function Ce(d,h,g,v,y,e){return v&&!v[S]&&(v=Ce(v)),y&&!y[S]&&(y=Ce(y,e)),le(function(e,t,n,r){var i,o,a,s=[],u=[],l=t.length,c=e||function(e,t,n){for(var r=0,i=t.length;r<i;r++)se(e,t[r],n);return n}(h||"*",n.nodeType?[n]:n,[]),f=!d||!e&&h?c:Te(c,s,d,n,r),p=g?y||(e?d:l||v)?[]:t:f;if(g&&g(f,p,n,r),v){i=Te(p,u),v(i,[],n,r),o=i.length;while(o--)(a=i[o])&&(p[u[o]]=!(f[u[o]]=a))}if(e){if(y||d){if(y){i=[],o=p.length;while(o--)(a=p[o])&&i.push(f[o]=a);y(null,p=[],i,r)}o=p.length;while(o--)(a=p[o])&&-1<(i=y?P(e,a):s[o])&&(e[i]=!(t[i]=a))}}else p=Te(p===t?p.splice(l,p.length):p),y?y(null,t,p,r):H.apply(t,p)})}function Ee(e){for(var i,t,n,r=e.length,o=b.relative[e[0].type],a=o||b.relative[" "],s=o?1:0,u=be(function(e){return e===i},a,!0),l=be(function(e){return-1<P(i,e)},a,!0),c=[function(e,t,n){var r=!o&&(n||t!==w)||((i=t).nodeType?u(e,t,n):l(e,t,n));return i=null,r}];s<r;s++)if(t=b.relative[e[s].type])c=[be(we(c),t)];else{if((t=b.filter[e[s].type].apply(null,e[s].matches))[S]){for(n=++s;n<r;n++)if(b.relative[e[n].type])break;return Ce(1<s&&we(c),1<s&&xe(e.slice(0,s-1).concat({value:" "===e[s-2].type?"*":""})).replace($,"$1"),t,s<n&&Ee(e.slice(s,n)),n<r&&Ee(e=e.slice(n)),n<r&&xe(e))}c.push(t)}return we(c)}return me.prototype=b.filters=b.pseudos,b.setFilters=new me,h=se.tokenize=function(e,t){var n,r,i,o,a,s,u,l=x[e+" "];if(l)return t?0:l.slice(0);a=e,s=[],u=b.preFilter;while(a){for(o in n&&!(r=_.exec(a))||(r&&(a=a.slice(r[0].length)||a),s.push(i=[])),n=!1,(r=z.exec(a))&&(n=r.shift(),i.push({value:n,type:r[0].replace($," ")}),a=a.slice(n.length)),b.filter)!(r=G[o].exec(a))||u[o]&&!(r=u[o](r))||(n=r.shift(),i.push({value:n,type:o,matches:r}),a=a.slice(n.length));if(!n)break}return t?a.length:a?se.error(e):x(e,s).slice(0)},f=se.compile=function(e,t){var n,v,y,m,x,r,i=[],o=[],a=A[e+" "];if(!a){t||(t=h(e)),n=t.length;while(n--)(a=Ee(t[n]))[S]?i.push(a):o.push(a);(a=A(e,(v=o,m=0<(y=i).length,x=0<v.length,r=function(e,t,n,r,i){var o,a,s,u=0,l="0",c=e&&[],f=[],p=w,d=e||x&&b.find.TAG("*",i),h=k+=null==p?1:Math.random()||.1,g=d.length;for(i&&(w=t==C||t||i);l!==g&&null!=(o=d[l]);l++){if(x&&o){a=0,t||o.ownerDocument==C||(T(o),n=!E);while(s=v[a++])if(s(o,t||C,n)){r.push(o);break}i&&(k=h)}m&&((o=!s&&o)&&u--,e&&c.push(o))}if(u+=l,m&&l!==u){a=0;while(s=y[a++])s(c,f,t,n);if(e){if(0<u)while(l--)c[l]||f[l]||(f[l]=q.call(r));f=Te(f)}H.apply(r,f),i&&!e&&0<f.length&&1<u+y.length&&se.uniqueSort(r)}return i&&(k=h,w=p),c},m?le(r):r))).selector=e}return a},g=se.select=function(e,t,n,r){var i,o,a,s,u,l="function"==typeof e&&e,c=!r&&h(e=l.selector||e);if(n=n||[],1===c.length){if(2<(o=c[0]=c[0].slice(0)).length&&"ID"===(a=o[0]).type&&9===t.nodeType&&E&&b.relative[o[1].type]){if(!(t=(b.find.ID(a.matches[0].replace(te,ne),t)||[])[0]))return n;l&&(t=t.parentNode),e=e.slice(o.shift().value.length)}i=G.needsContext.test(e)?0:o.length;while(i--){if(a=o[i],b.relative[s=a.type])break;if((u=b.find[s])&&(r=u(a.matches[0].replace(te,ne),ee.test(o[0].type)&&ye(t.parentNode)||t))){if(o.splice(i,1),!(e=r.length&&xe(o)))return H.apply(n,r),n;break}}}return(l||f(e,c))(r,t,!E,n,!t||ee.test(e)&&ye(t.parentNode)||t),n},d.sortStable=S.split("").sort(D).join("")===S,d.detectDuplicates=!!l,T(),d.sortDetached=ce(function(e){return 1&e.compareDocumentPosition(C.createElement("fieldset"))}),ce(function(e){return e.innerHTML="<a href='#'></a>","#"===e.firstChild.getAttribute("href")})||fe("type|href|height|width",function(e,t,n){if(!n)return e.getAttribute(t,"type"===t.toLowerCase()?1:2)}),d.attributes&&ce(function(e){return e.innerHTML="<input/>",e.firstChild.setAttribute("value",""),""===e.firstChild.getAttribute("value")})||fe("value",function(e,t,n){if(!n&&"input"===e.nodeName.toLowerCase())return e.defaultValue}),ce(function(e){return null==e.getAttribute("disabled")})||fe(R,function(e,t,n){var r;if(!n)return!0===e[t]?t.toLowerCase():(r=e.getAttributeNode(t))&&r.specified?r.value:null}),se}(C);S.find=d,S.expr=d.selectors,S.expr[":"]=S.expr.pseudos,S.uniqueSort=S.unique=d.uniqueSort,S.text=d.getText,S.isXMLDoc=d.isXML,S.contains=d.contains,S.escapeSelector=d.escape;var h=function(e,t,n){var r=[],i=void 0!==n;while((e=e[t])&&9!==e.nodeType)if(1===e.nodeType){if(i&&S(e).is(n))break;r.push(e)}return r},T=function(e,t){for(var n=[];e;e=e.nextSibling)1===e.nodeType&&e!==t&&n.push(e);return n},k=S.expr.match.needsContext;function A(e,t){return e.nodeName&&e.nodeName.toLowerCase()===t.toLowerCase()}var N=/^<([a-z][^\\/\\0>:\\x20\\t\\r\\n\\f]*)[\\x20\\t\\r\\n\\f]*\\/?>(?:<\\/\\1>|)$/i;function D(e,n,r){return m(n)?S.grep(e,function(e,t){return!!n.call(e,t,e)!==r}):n.nodeType?S.grep(e,function(e){return e===n!==r}):"string"!=typeof n?S.grep(e,function(e){return-1<i.call(n,e)!==r}):S.filter(n,e,r)}S.filter=function(e,t,n){var r=t[0];return n&&(e=":not("+e+")"),1===t.length&&1===r.nodeType?S.find.matchesSelector(r,e)?[r]:[]:S.find.matches(e,S.grep(t,function(e){return 1===e.nodeType}))},S.fn.extend({find:function(e){var t,n,r=this.length,i=this;if("string"!=typeof e)return this.pushStack(S(e).filter(function(){for(t=0;t<r;t++)if(S.contains(i[t],this))return!0}));for(n=this.pushStack([]),t=0;t<r;t++)S.find(e,i[t],n);return 1<r?S.uniqueSort(n):n},filter:function(e){return this.pushStack(D(this,e||[],!1))},not:function(e){return this.pushStack(D(this,e||[],!0))},is:function(e){return!!D(this,"string"==typeof e&&k.test(e)?S(e):e||[],!1).length}});var j,q=/^(?:\\s*(<[\\w\\W]+>)[^>]*|#([\\w-]+))$/;(S.fn.init=function(e,t,n){var r,i;if(!e)return this;if(n=n||j,"string"==typeof e){if(!(r="<"===e[0]&&">"===e[e.length-1]&&3<=e.length?[null,e,null]:q.exec(e))||!r[1]&&t)return!t||t.jquery?(t||n).find(e):this.constructor(t).find(e);if(r[1]){if(t=t instanceof S?t[0]:t,S.merge(this,S.parseHTML(r[1],t&&t.nodeType?t.ownerDocument||t:E,!0)),N.test(r[1])&&S.isPlainObject(t))for(r in t)m(this[r])?this[r](t[r]):this.attr(r,t[r]);return this}return(i=E.getElementById(r[2]))&&(this[0]=i,this.length=1),this}return e.nodeType?(this[0]=e,this.length=1,this):m(e)?void 0!==n.ready?n.ready(e):e(S):S.makeArray(e,this)}).prototype=S.fn,j=S(E);var L=/^(?:parents|prev(?:Until|All))/,H={children:!0,contents:!0,next:!0,prev:!0};function O(e,t){while((e=e[t])&&1!==e.nodeType);return e}S.fn.extend({has:function(e){var t=S(e,this),n=t.length;return this.filter(function(){for(var e=0;e<n;e++)if(S.contains(this,t[e]))return!0})},closest:function(e,t){var n,r=0,i=this.length,o=[],a="string"!=typeof e&&S(e);if(!k.test(e))for(;r<i;r++)for(n=this[r];n&&n!==t;n=n.parentNode)if(n.nodeType<11&&(a?-1<a.index(n):1===n.nodeType&&S.find.matchesSelector(n,e))){o.push(n);break}return this.pushStack(1<o.length?S.uniqueSort(o):o)},index:function(e){return e?"string"==typeof e?i.call(S(e),this[0]):i.call(this,e.jquery?e[0]:e):this[0]&&this[0].parentNode?this.first().prevAll().length:-1},add:function(e,t){return this.pushStack(S.uniqueSort(S.merge(this.get(),S(e,t))))},addBack:function(e){return this.add(null==e?this.prevObject:this.prevObject.filter(e))}}),S.each({parent:function(e){var t=e.parentNode;return t&&11!==t.nodeType?t:null},parents:function(e){return h(e,"parentNode")},parentsUntil:function(e,t,n){return h(e,"parentNode",n)},next:function(e){return O(e,"nextSibling")},prev:function(e){return O(e,"previousSibling")},nextAll:function(e){return h(e,"nextSibling")},prevAll:function(e){return h(e,"previousSibling")},nextUntil:function(e,t,n){return h(e,"nextSibling",n)},prevUntil:function(e,t,n){return h(e,"previousSibling",n)},siblings:function(e){return T((e.parentNode||{}).firstChild,e)},children:function(e){return T(e.firstChild)},contents:function(e){return null!=e.contentDocument&&r(e.contentDocument)?e.contentDocument:(A(e,"template")&&(e=e.content||e),S.merge([],e.childNodes))}},function(r,i){S.fn[r]=function(e,t){var n=S.map(this,i,e);return"Until"!==r.slice(-5)&&(t=e),t&&"string"==typeof t&&(n=S.filter(t,n)),1<this.length&&(H[r]||S.uniqueSort(n),L.test(r)&&n.reverse()),this.pushStack(n)}});var P=/[^\\x20\\t\\r\\n\\f]+/g;function R(e){return e}function M(e){throw e}function I(e,t,n,r){var i;try{e&&m(i=e.promise)?i.call(e).done(t).fail(n):e&&m(i=e.then)?i.call(e,t,n):t.apply(void 0,[e].slice(r))}catch(e){n.apply(void 0,[e])}}S.Callbacks=function(r){var e,n;r="string"==typeof r?(e=r,n={},S.each(e.match(P)||[],function(e,t){n[t]=!0}),n):S.extend({},r);var i,t,o,a,s=[],u=[],l=-1,c=function(){for(a=a||r.once,o=i=!0;u.length;l=-1){t=u.shift();while(++l<s.length)!1===s[l].apply(t[0],t[1])&&r.stopOnFalse&&(l=s.length,t=!1)}r.memory||(t=!1),i=!1,a&&(s=t?[]:"")},f={add:function(){return s&&(t&&!i&&(l=s.length-1,u.push(t)),function n(e){S.each(e,function(e,t){m(t)?r.unique&&f.has(t)||s.push(t):t&&t.length&&"string"!==w(t)&&n(t)})}(arguments),t&&!i&&c()),this},remove:function(){return S.each(arguments,function(e,t){var n;while(-1<(n=S.inArray(t,s,n)))s.splice(n,1),n<=l&&l--}),this},has:function(e){return e?-1<S.inArray(e,s):0<s.length},empty:function(){return s&&(s=[]),this},disable:function(){return a=u=[],s=t="",this},disabled:function(){return!s},lock:function(){return a=u=[],t||i||(s=t=""),this},locked:function(){return!!a},fireWith:function(e,t){return a||(t=[e,(t=t||[]).slice?t.slice():t],u.push(t),i||c()),this},fire:function(){return f.fireWith(this,arguments),this},fired:function(){return!!o}};return f},S.extend({Deferred:function(e){var o=[["notify","progress",S.Callbacks("memory"),S.Callbacks("memory"),2],["resolve","done",S.Callbacks("once memory"),S.Callbacks("once memory"),0,"resolved"],["reject","fail",S.Callbacks("once memory"),S.Callbacks("once memory"),1,"rejected"]],i="pending",a={state:function(){return i},always:function(){return s.done(arguments).fail(arguments),this},"catch":function(e){return a.then(null,e)},pipe:function(){var i=arguments;return S.Deferred(function(r){S.each(o,function(e,t){var n=m(i[t[4]])&&i[t[4]];s[t[1]](function(){var e=n&&n.apply(this,arguments);e&&m(e.promise)?e.promise().progress(r.notify).done(r.resolve).fail(r.reject):r[t[0]+"With"](this,n?[e]:arguments)})}),i=null}).promise()},then:function(t,n,r){var u=0;function l(i,o,a,s){return function(){var n=this,r=arguments,e=function(){var e,t;if(!(i<u)){if((e=a.apply(n,r))===o.promise())throw new TypeError("Thenable self-resolution");t=e&&("object"==typeof e||"function"==typeof e)&&e.then,m(t)?s?t.call(e,l(u,o,R,s),l(u,o,M,s)):(u++,t.call(e,l(u,o,R,s),l(u,o,M,s),l(u,o,R,o.notifyWith))):(a!==R&&(n=void 0,r=[e]),(s||o.resolveWith)(n,r))}},t=s?e:function(){try{e()}catch(e){S.Deferred.exceptionHook&&S.Deferred.exceptionHook(e,t.stackTrace),u<=i+1&&(a!==M&&(n=void 0,r=[e]),o.rejectWith(n,r))}};i?t():(S.Deferred.getStackHook&&(t.stackTrace=S.Deferred.getStackHook()),C.setTimeout(t))}}return S.Deferred(function(e){o[0][3].add(l(0,e,m(r)?r:R,e.notifyWith)),o[1][3].add(l(0,e,m(t)?t:R)),o[2][3].add(l(0,e,m(n)?n:M))}).promise()},promise:function(e){return null!=e?S.extend(e,a):a}},s={};return S.each(o,function(e,t){var n=t[2],r=t[5];a[t[1]]=n.add,r&&n.add(function(){i=r},o[3-e][2].disable,o[3-e][3].disable,o[0][2].lock,o[0][3].lock),n.add(t[3].fire),s[t[0]]=function(){return s[t[0]+"With"](this===s?void 0:this,arguments),this},s[t[0]+"With"]=n.fireWith}),a.promise(s),e&&e.call(s,s),s},when:function(e){var n=arguments.length,t=n,r=Array(t),i=s.call(arguments),o=S.Deferred(),a=function(t){return function(e){r[t]=this,i[t]=1<arguments.length?s.call(arguments):e,--n||o.resolveWith(r,i)}};if(n<=1&&(I(e,o.done(a(t)).resolve,o.reject,!n),"pending"===o.state()||m(i[t]&&i[t].then)))return o.then();while(t--)I(i[t],a(t),o.reject);return o.promise()}});var W=/^(Eval|Internal|Range|Reference|Syntax|Type|URI)Error$/;S.Deferred.exceptionHook=function(e,t){C.console&&C.console.warn&&e&&W.test(e.name)&&C.console.warn("jQuery.Deferred exception: "+e.message,e.stack,t)},S.readyException=function(e){C.setTimeout(function(){throw e})};var F=S.Deferred();function B(){E.removeEventListener("DOMContentLoaded",B),C.removeEventListener("load",B),S.ready()}S.fn.ready=function(e){return F.then(e)["catch"](function(e){S.readyException(e)}),this},S.extend({isReady:!1,readyWait:1,ready:function(e){(!0===e?--S.readyWait:S.isReady)||(S.isReady=!0)!==e&&0<--S.readyWait||F.resolveWith(E,[S])}}),S.ready.then=F.then,"complete"===E.readyState||"loading"!==E.readyState&&!E.documentElement.doScroll?C.setTimeout(S.ready):(E.addEventListener("DOMContentLoaded",B),C.addEventListener("load",B));var $=function(e,t,n,r,i,o,a){var s=0,u=e.length,l=null==n;if("object"===w(n))for(s in i=!0,n)$(e,t,s,n[s],!0,o,a);else if(void 0!==r&&(i=!0,m(r)||(a=!0),l&&(a?(t.call(e,r),t=null):(l=t,t=function(e,t,n){return l.call(S(e),n)})),t))for(;s<u;s++)t(e[s],n,a?r:r.call(e[s],s,t(e[s],n)));return i?e:l?t.call(e):u?t(e[0],n):o},_=/^-ms-/,z=/-([a-z])/g;function U(e,t){return t.toUpperCase()}function X(e){return e.replace(_,"ms-").replace(z,U)}var V=function(e){return 1===e.nodeType||9===e.nodeType||!+e.nodeType};function G(){this.expando=S.expando+G.uid++}G.uid=1,G.prototype={cache:function(e){var t=e[this.expando];return t||(t={},V(e)&&(e.nodeType?e[this.expando]=t:Object.defineProperty(e,this.expando,{value:t,configurable:!0}))),t},set:function(e,t,n){var r,i=this.cache(e);if("string"==typeof t)i[X(t)]=n;else for(r in t)i[X(r)]=t[r];return i},get:function(e,t){return void 0===t?this.cache(e):e[this.expando]&&e[this.expando][X(t)]},access:function(e,t,n){return void 0===t||t&&"string"==typeof t&&void 0===n?this.get(e,t):(this.set(e,t,n),void 0!==n?n:t)},remove:function(e,t){var n,r=e[this.expando];if(void 0!==r){if(void 0!==t){n=(t=Array.isArray(t)?t.map(X):(t=X(t))in r?[t]:t.match(P)||[]).length;while(n--)delete r[t[n]]}(void 0===t||S.isEmptyObject(r))&&(e.nodeType?e[this.expando]=void 0:delete e[this.expando])}},hasData:function(e){var t=e[this.expando];return void 0!==t&&!S.isEmptyObject(t)}};var Y=new G,Q=new G,J=/^(?:\\{[\\w\\W]*\\}|\\[[\\w\\W]*\\])$/,K=/[A-Z]/g;function Z(e,t,n){var r,i;if(void 0===n&&1===e.nodeType)if(r="data-"+t.replace(K,"-$&").toLowerCase(),"string"==typeof(n=e.getAttribute(r))){try{n="true"===(i=n)||"false"!==i&&("null"===i?null:i===+i+""?+i:J.test(i)?JSON.parse(i):i)}catch(e){}Q.set(e,t,n)}else n=void 0;return n}S.extend({hasData:function(e){return Q.hasData(e)||Y.hasData(e)},data:function(e,t,n){return Q.access(e,t,n)},removeData:function(e,t){Q.remove(e,t)},_data:function(e,t,n){return Y.access(e,t,n)},_removeData:function(e,t){Y.remove(e,t)}}),S.fn.extend({data:function(n,e){var t,r,i,o=this[0],a=o&&o.attributes;if(void 0===n){if(this.length&&(i=Q.get(o),1===o.nodeType&&!Y.get(o,"hasDataAttrs"))){t=a.length;while(t--)a[t]&&0===(r=a[t].name).indexOf("data-")&&(r=X(r.slice(5)),Z(o,r,i[r]));Y.set(o,"hasDataAttrs",!0)}return i}return"object"==typeof n?this.each(function(){Q.set(this,n)}):$(this,function(e){var t;if(o&&void 0===e)return void 0!==(t=Q.get(o,n))?t:void 0!==(t=Z(o,n))?t:void 0;this.each(function(){Q.set(this,n,e)})},null,e,1<arguments.length,null,!0)},removeData:function(e){return this.each(function(){Q.remove(this,e)})}}),S.extend({queue:function(e,t,n){var r;if(e)return t=(t||"fx")+"queue",r=Y.get(e,t),n&&(!r||Array.isArray(n)?r=Y.access(e,t,S.makeArray(n)):r.push(n)),r||[]},dequeue:function(e,t){t=t||"fx";var n=S.queue(e,t),r=n.length,i=n.shift(),o=S._queueHooks(e,t);"inprogress"===i&&(i=n.shift(),r--),i&&("fx"===t&&n.unshift("inprogress"),delete o.stop,i.call(e,function(){S.dequeue(e,t)},o)),!r&&o&&o.empty.fire()},_queueHooks:function(e,t){var n=t+"queueHooks";return Y.get(e,n)||Y.access(e,n,{empty:S.Callbacks("once memory").add(function(){Y.remove(e,[t+"queue",n])})})}}),S.fn.extend({queue:function(t,n){var e=2;return"string"!=typeof t&&(n=t,t="fx",e--),arguments.length<e?S.queue(this[0],t):void 0===n?this:this.each(function(){var e=S.queue(this,t,n);S._queueHooks(this,t),"fx"===t&&"inprogress"!==e[0]&&S.dequeue(this,t)})},dequeue:function(e){return this.each(function(){S.dequeue(this,e)})},clearQueue:function(e){return this.queue(e||"fx",[])},promise:function(e,t){var n,r=1,i=S.Deferred(),o=this,a=this.length,s=function(){--r||i.resolveWith(o,[o])};"string"!=typeof e&&(t=e,e=void 0),e=e||"fx";while(a--)(n=Y.get(o[a],e+"queueHooks"))&&n.empty&&(r++,n.empty.add(s));return s(),i.promise(t)}});var ee=/[+-]?(?:\\d*\\.|)\\d+(?:[eE][+-]?\\d+|)/.source,te=new RegExp("^(?:([+-])=|)("+ee+")([a-z%]*)$","i"),ne=["Top","Right","Bottom","Left"],re=E.documentElement,ie=function(e){return S.contains(e.ownerDocument,e)},oe={composed:!0};re.getRootNode&&(ie=function(e){return S.contains(e.ownerDocument,e)||e.getRootNode(oe)===e.ownerDocument});var ae=function(e,t){return"none"===(e=t||e).style.display||""===e.style.display&&ie(e)&&"none"===S.css(e,"display")};function se(e,t,n,r){var i,o,a=20,s=r?function(){return r.cur()}:function(){return S.css(e,t,"")},u=s(),l=n&&n[3]||(S.cssNumber[t]?"":"px"),c=e.nodeType&&(S.cssNumber[t]||"px"!==l&&+u)&&te.exec(S.css(e,t));if(c&&c[3]!==l){u/=2,l=l||c[3],c=+u||1;while(a--)S.style(e,t,c+l),(1-o)*(1-(o=s()/u||.5))<=0&&(a=0),c/=o;c*=2,S.style(e,t,c+l),n=n||[]}return n&&(c=+c||+u||0,i=n[1]?c+(n[1]+1)*n[2]:+n[2],r&&(r.unit=l,r.start=c,r.end=i)),i}var ue={};function le(e,t){for(var n,r,i,o,a,s,u,l=[],c=0,f=e.length;c<f;c++)(r=e[c]).style&&(n=r.style.display,t?("none"===n&&(l[c]=Y.get(r,"display")||null,l[c]||(r.style.display="")),""===r.style.display&&ae(r)&&(l[c]=(u=a=o=void 0,a=(i=r).ownerDocument,s=i.nodeName,(u=ue[s])||(o=a.body.appendChild(a.createElement(s)),u=S.css(o,"display"),o.parentNode.removeChild(o),"none"===u&&(u="block"),ue[s]=u)))):"none"!==n&&(l[c]="none",Y.set(r,"display",n)));for(c=0;c<f;c++)null!=l[c]&&(e[c].style.display=l[c]);return e}S.fn.extend({show:function(){return le(this,!0)},hide:function(){return le(this)},toggle:function(e){return"boolean"==typeof e?e?this.show():this.hide():this.each(function(){ae(this)?S(this).show():S(this).hide()})}});var ce,fe,pe=/^(?:checkbox|radio)$/i,de=/<([a-z][^\\/\\0>\\x20\\t\\r\\n\\f]*)/i,he=/^$|^module$|\\/(?:java|ecma)script/i;ce=E.createDocumentFragment().appendChild(E.createElement("div")),(fe=E.createElement("input")).setAttribute("type","radio"),fe.setAttribute("checked","checked"),fe.setAttribute("name","t"),ce.appendChild(fe),y.checkClone=ce.cloneNode(!0).cloneNode(!0).lastChild.checked,ce.innerHTML="<textarea>x</textarea>",y.noCloneChecked=!!ce.cloneNode(!0).lastChild.defaultValue,ce.innerHTML="<option></option>",y.option=!!ce.lastChild;var ge={thead:[1,"<table>","</table>"],col:[2,"<table><colgroup>","</colgroup></table>"],tr:[2,"<table><tbody>","</tbody></table>"],td:[3,"<table><tbody><tr>","</tr></tbody></table>"],_default:[0,"",""]};function ve(e,t){var n;return n="undefined"!=typeof e.getElementsByTagName?e.getElementsByTagName(t||"*"):"undefined"!=typeof e.querySelectorAll?e.querySelectorAll(t||"*"):[],void 0===t||t&&A(e,t)?S.merge([e],n):n}function ye(e,t){for(var n=0,r=e.length;n<r;n++)Y.set(e[n],"globalEval",!t||Y.get(t[n],"globalEval"))}ge.tbody=ge.tfoot=ge.colgroup=ge.caption=ge.thead,ge.th=ge.td,y.option||(ge.optgroup=ge.option=[1,"<select multiple='multiple'>","</select>"]);var me=/<|&#?\\w+;/;function xe(e,t,n,r,i){for(var o,a,s,u,l,c,f=t.createDocumentFragment(),p=[],d=0,h=e.length;d<h;d++)if((o=e[d])||0===o)if("object"===w(o))S.merge(p,o.nodeType?[o]:o);else if(me.test(o)){a=a||f.appendChild(t.createElement("div")),s=(de.exec(o)||["",""])[1].toLowerCase(),u=ge[s]||ge._default,a.innerHTML=u[1]+S.htmlPrefilter(o)+u[2],c=u[0];while(c--)a=a.lastChild;S.merge(p,a.childNodes),(a=f.firstChild).textContent=""}else p.push(t.createTextNode(o));f.textContent="",d=0;while(o=p[d++])if(r&&-1<S.inArray(o,r))i&&i.push(o);else if(l=ie(o),a=ve(f.appendChild(o),"script"),l&&ye(a),n){c=0;while(o=a[c++])he.test(o.type||"")&&n.push(o)}return f}var be=/^key/,we=/^(?:mouse|pointer|contextmenu|drag|drop)|click/,Te=/^([^.]*)(?:\\.(.+)|)/;function Ce(){return!0}function Ee(){return!1}function Se(e,t){return e===function(){try{return E.activeElement}catch(e){}}()==("focus"===t)}function ke(e,t,n,r,i,o){var a,s;if("object"==typeof t){for(s in"string"!=typeof n&&(r=r||n,n=void 0),t)ke(e,s,n,r,t[s],o);return e}if(null==r&&null==i?(i=n,r=n=void 0):null==i&&("string"==typeof n?(i=r,r=void 0):(i=r,r=n,n=void 0)),!1===i)i=Ee;else if(!i)return e;return 1===o&&(a=i,(i=function(e){return S().off(e),a.apply(this,arguments)}).guid=a.guid||(a.guid=S.guid++)),e.each(function(){S.event.add(this,t,i,r,n)})}function Ae(e,i,o){o?(Y.set(e,i,!1),S.event.add(e,i,{namespace:!1,handler:function(e){var t,n,r=Y.get(this,i);if(1&e.isTrigger&&this[i]){if(r.length)(S.event.special[i]||{}).delegateType&&e.stopPropagation();else if(r=s.call(arguments),Y.set(this,i,r),t=o(this,i),this[i](),r!==(n=Y.get(this,i))||t?Y.set(this,i,!1):n={},r!==n)return e.stopImmediatePropagation(),e.preventDefault(),n.value}else r.length&&(Y.set(this,i,{value:S.event.trigger(S.extend(r[0],S.Event.prototype),r.slice(1),this)}),e.stopImmediatePropagation())}})):void 0===Y.get(e,i)&&S.event.add(e,i,Ce)}S.event={global:{},add:function(t,e,n,r,i){var o,a,s,u,l,c,f,p,d,h,g,v=Y.get(t);if(V(t)){n.handler&&(n=(o=n).handler,i=o.selector),i&&S.find.matchesSelector(re,i),n.guid||(n.guid=S.guid++),(u=v.events)||(u=v.events=Object.create(null)),(a=v.handle)||(a=v.handle=function(e){return"undefined"!=typeof S&&S.event.triggered!==e.type?S.event.dispatch.apply(t,arguments):void 0}),l=(e=(e||"").match(P)||[""]).length;while(l--)d=g=(s=Te.exec(e[l])||[])[1],h=(s[2]||"").split(".").sort(),d&&(f=S.event.special[d]||{},d=(i?f.delegateType:f.bindType)||d,f=S.event.special[d]||{},c=S.extend({type:d,origType:g,data:r,handler:n,guid:n.guid,selector:i,needsContext:i&&S.expr.match.needsContext.test(i),namespace:h.join(".")},o),(p=u[d])||((p=u[d]=[]).delegateCount=0,f.setup&&!1!==f.setup.call(t,r,h,a)||t.addEventListener&&t.addEventListener(d,a)),f.add&&(f.add.call(t,c),c.handler.guid||(c.handler.guid=n.guid)),i?p.splice(p.delegateCount++,0,c):p.push(c),S.event.global[d]=!0)}},remove:function(e,t,n,r,i){var o,a,s,u,l,c,f,p,d,h,g,v=Y.hasData(e)&&Y.get(e);if(v&&(u=v.events)){l=(t=(t||"").match(P)||[""]).length;while(l--)if(d=g=(s=Te.exec(t[l])||[])[1],h=(s[2]||"").split(".").sort(),d){f=S.event.special[d]||{},p=u[d=(r?f.delegateType:f.bindType)||d]||[],s=s[2]&&new RegExp("(^|\\\\.)"+h.join("\\\\.(?:.*\\\\.|)")+"(\\\\.|$)"),a=o=p.length;while(o--)c=p[o],!i&&g!==c.origType||n&&n.guid!==c.guid||s&&!s.test(c.namespace)||r&&r!==c.selector&&("**"!==r||!c.selector)||(p.splice(o,1),c.selector&&p.delegateCount--,f.remove&&f.remove.call(e,c));a&&!p.length&&(f.teardown&&!1!==f.teardown.call(e,h,v.handle)||S.removeEvent(e,d,v.handle),delete u[d])}else for(d in u)S.event.remove(e,d+t[l],n,r,!0);S.isEmptyObject(u)&&Y.remove(e,"handle events")}},dispatch:function(e){var t,n,r,i,o,a,s=new Array(arguments.length),u=S.event.fix(e),l=(Y.get(this,"events")||Object.create(null))[u.type]||[],c=S.event.special[u.type]||{};for(s[0]=u,t=1;t<arguments.length;t++)s[t]=arguments[t];if(u.delegateTarget=this,!c.preDispatch||!1!==c.preDispatch.call(this,u)){a=S.event.handlers.call(this,u,l),t=0;while((i=a[t++])&&!u.isPropagationStopped()){u.currentTarget=i.elem,n=0;while((o=i.handlers[n++])&&!u.isImmediatePropagationStopped())u.rnamespace&&!1!==o.namespace&&!u.rnamespace.test(o.namespace)||(u.handleObj=o,u.data=o.data,void 0!==(r=((S.event.special[o.origType]||{}).handle||o.handler).apply(i.elem,s))&&!1===(u.result=r)&&(u.preventDefault(),u.stopPropagation()))}return c.postDispatch&&c.postDispatch.call(this,u),u.result}},handlers:function(e,t){var n,r,i,o,a,s=[],u=t.delegateCount,l=e.target;if(u&&l.nodeType&&!("click"===e.type&&1<=e.button))for(;l!==this;l=l.parentNode||this)if(1===l.nodeType&&("click"!==e.type||!0!==l.disabled)){for(o=[],a={},n=0;n<u;n++)void 0===a[i=(r=t[n]).selector+" "]&&(a[i]=r.needsContext?-1<S(i,this).index(l):S.find(i,this,null,[l]).length),a[i]&&o.push(r);o.length&&s.push({elem:l,handlers:o})}return l=this,u<t.length&&s.push({elem:l,handlers:t.slice(u)}),s},addProp:function(t,e){Object.defineProperty(S.Event.prototype,t,{enumerable:!0,configurable:!0,get:m(e)?function(){if(this.originalEvent)return e(this.originalEvent)}:function(){if(this.originalEvent)return this.originalEvent[t]},set:function(e){Object.defineProperty(this,t,{enumerable:!0,configurable:!0,writable:!0,value:e})}})},fix:function(e){return e[S.expando]?e:new S.Event(e)},special:{load:{noBubble:!0},click:{setup:function(e){var t=this||e;return pe.test(t.type)&&t.click&&A(t,"input")&&Ae(t,"click",Ce),!1},trigger:function(e){var t=this||e;return pe.test(t.type)&&t.click&&A(t,"input")&&Ae(t,"click"),!0},_default:function(e){var t=e.target;return pe.test(t.type)&&t.click&&A(t,"input")&&Y.get(t,"click")||A(t,"a")}},beforeunload:{postDispatch:function(e){void 0!==e.result&&e.originalEvent&&(e.originalEvent.returnValue=e.result)}}}},S.removeEvent=function(e,t,n){e.removeEventListener&&e.removeEventListener(t,n)},S.Event=function(e,t){if(!(this instanceof S.Event))return new S.Event(e,t);e&&e.type?(this.originalEvent=e,this.type=e.type,this.isDefaultPrevented=e.defaultPrevented||void 0===e.defaultPrevented&&!1===e.returnValue?Ce:Ee,this.target=e.target&&3===e.target.nodeType?e.target.parentNode:e.target,this.currentTarget=e.currentTarget,this.relatedTarget=e.relatedTarget):this.type=e,t&&S.extend(this,t),this.timeStamp=e&&e.timeStamp||Date.now(),this[S.expando]=!0},S.Event.prototype={constructor:S.Event,isDefaultPrevented:Ee,isPropagationStopped:Ee,isImmediatePropagationStopped:Ee,isSimulated:!1,preventDefault:function(){var e=this.originalEvent;this.isDefaultPrevented=Ce,e&&!this.isSimulated&&e.preventDefault()},stopPropagation:function(){var e=this.originalEvent;this.isPropagationStopped=Ce,e&&!this.isSimulated&&e.stopPropagation()},stopImmediatePropagation:function(){var e=this.originalEvent;this.isImmediatePropagationStopped=Ce,e&&!this.isSimulated&&e.stopImmediatePropagation(),this.stopPropagation()}},S.each({altKey:!0,bubbles:!0,cancelable:!0,changedTouches:!0,ctrlKey:!0,detail:!0,eventPhase:!0,metaKey:!0,pageX:!0,pageY:!0,shiftKey:!0,view:!0,"char":!0,code:!0,charCode:!0,key:!0,keyCode:!0,button:!0,buttons:!0,clientX:!0,clientY:!0,offsetX:!0,offsetY:!0,pointerId:!0,pointerType:!0,screenX:!0,screenY:!0,targetTouches:!0,toElement:!0,touches:!0,which:function(e){var t=e.button;return null==e.which&&be.test(e.type)?null!=e.charCode?e.charCode:e.keyCode:!e.which&&void 0!==t&&we.test(e.type)?1&t?1:2&t?3:4&t?2:0:e.which}},S.event.addProp),S.each({focus:"focusin",blur:"focusout"},function(e,t){S.event.special[e]={setup:function(){return Ae(this,e,Se),!1},trigger:function(){return Ae(this,e),!0},delegateType:t}}),S.each({mouseenter:"mouseover",mouseleave:"mouseout",pointerenter:"pointerover",pointerleave:"pointerout"},function(e,i){S.event.special[e]={delegateType:i,bindType:i,handle:function(e){var t,n=e.relatedTarget,r=e.handleObj;return n&&(n===this||S.contains(this,n))||(e.type=r.origType,t=r.handler.apply(this,arguments),e.type=i),t}}}),S.fn.extend({on:function(e,t,n,r){return ke(this,e,t,n,r)},one:function(e,t,n,r){return ke(this,e,t,n,r,1)},off:function(e,t,n){var r,i;if(e&&e.preventDefault&&e.handleObj)return r=e.handleObj,S(e.delegateTarget).off(r.namespace?r.origType+"."+r.namespace:r.origType,r.selector,r.handler),this;if("object"==typeof e){for(i in e)this.off(i,t,e[i]);return this}return!1!==t&&"function"!=typeof t||(n=t,t=void 0),!1===n&&(n=Ee),this.each(function(){S.event.remove(this,e,n,t)})}});var Ne=/<script|<style|<link/i,De=/checked\\s*(?:[^=]|=\\s*.checked.)/i,je=/^\\s*<!(?:\\[CDATA\\[|--)|(?:\\]\\]|--)>\\s*$/g;function qe(e,t){return A(e,"table")&&A(11!==t.nodeType?t:t.firstChild,"tr")&&S(e).children("tbody")[0]||e}function Le(e){return e.type=(null!==e.getAttribute("type"))+"/"+e.type,e}function He(e){return"true/"===(e.type||"").slice(0,5)?e.type=e.type.slice(5):e.removeAttribute("type"),e}function Oe(e,t){var n,r,i,o,a,s;if(1===t.nodeType){if(Y.hasData(e)&&(s=Y.get(e).events))for(i in Y.remove(t,"handle events"),s)for(n=0,r=s[i].length;n<r;n++)S.event.add(t,i,s[i][n]);Q.hasData(e)&&(o=Q.access(e),a=S.extend({},o),Q.set(t,a))}}function Pe(n,r,i,o){r=g(r);var e,t,a,s,u,l,c=0,f=n.length,p=f-1,d=r[0],h=m(d);if(h||1<f&&"string"==typeof d&&!y.checkClone&&De.test(d))return n.each(function(e){var t=n.eq(e);h&&(r[0]=d.call(this,e,t.html())),Pe(t,r,i,o)});if(f&&(t=(e=xe(r,n[0].ownerDocument,!1,n,o)).firstChild,1===e.childNodes.length&&(e=t),t||o)){for(s=(a=S.map(ve(e,"script"),Le)).length;c<f;c++)u=e,c!==p&&(u=S.clone(u,!0,!0),s&&S.merge(a,ve(u,"script"))),i.call(n[c],u,c);if(s)for(l=a[a.length-1].ownerDocument,S.map(a,He),c=0;c<s;c++)u=a[c],he.test(u.type||"")&&!Y.access(u,"globalEval")&&S.contains(l,u)&&(u.src&&"module"!==(u.type||"").toLowerCase()?S._evalUrl&&!u.noModule&&S._evalUrl(u.src,{nonce:u.nonce||u.getAttribute("nonce")},l):b(u.textContent.replace(je,""),u,l))}return n}function Re(e,t,n){for(var r,i=t?S.filter(t,e):e,o=0;null!=(r=i[o]);o++)n||1!==r.nodeType||S.cleanData(ve(r)),r.parentNode&&(n&&ie(r)&&ye(ve(r,"script")),r.parentNode.removeChild(r));return e}S.extend({htmlPrefilter:function(e){return e},clone:function(e,t,n){var r,i,o,a,s,u,l,c=e.cloneNode(!0),f=ie(e);if(!(y.noCloneChecked||1!==e.nodeType&&11!==e.nodeType||S.isXMLDoc(e)))for(a=ve(c),r=0,i=(o=ve(e)).length;r<i;r++)s=o[r],u=a[r],void 0,"input"===(l=u.nodeName.toLowerCase())&&pe.test(s.type)?u.checked=s.checked:"input"!==l&&"textarea"!==l||(u.defaultValue=s.defaultValue);if(t)if(n)for(o=o||ve(e),a=a||ve(c),r=0,i=o.length;r<i;r++)Oe(o[r],a[r]);else Oe(e,c);return 0<(a=ve(c,"script")).length&&ye(a,!f&&ve(e,"script")),c},cleanData:function(e){for(var t,n,r,i=S.event.special,o=0;void 0!==(n=e[o]);o++)if(V(n)){if(t=n[Y.expando]){if(t.events)for(r in t.events)i[r]?S.event.remove(n,r):S.removeEvent(n,r,t.handle);n[Y.expando]=void 0}n[Q.expando]&&(n[Q.expando]=void 0)}}}),S.fn.extend({detach:function(e){return Re(this,e,!0)},remove:function(e){return Re(this,e)},text:function(e){return $(this,function(e){return void 0===e?S.text(this):this.empty().each(function(){1!==this.nodeType&&11!==this.nodeType&&9!==this.nodeType||(this.textContent=e)})},null,e,arguments.length)},append:function(){return Pe(this,arguments,function(e){1!==this.nodeType&&11!==this.nodeType&&9!==this.nodeType||qe(this,e).appendChild(e)})},prepend:function(){return Pe(this,arguments,function(e){if(1===this.nodeType||11===this.nodeType||9===this.nodeType){var t=qe(this,e);t.insertBefore(e,t.firstChild)}})},before:function(){return Pe(this,arguments,function(e){this.parentNode&&this.parentNode.insertBefore(e,this)})},after:function(){return Pe(this,arguments,function(e){this.parentNode&&this.parentNode.insertBefore(e,this.nextSibling)})},empty:function(){for(var e,t=0;null!=(e=this[t]);t++)1===e.nodeType&&(S.cleanData(ve(e,!1)),e.textContent="");return this},clone:function(e,t){return e=null!=e&&e,t=null==t?e:t,this.map(function(){return S.clone(this,e,t)})},html:function(e){return $(this,function(e){var t=this[0]||{},n=0,r=this.length;if(void 0===e&&1===t.nodeType)return t.innerHTML;if("string"==typeof e&&!Ne.test(e)&&!ge[(de.exec(e)||["",""])[1].toLowerCase()]){e=S.htmlPrefilter(e);try{for(;n<r;n++)1===(t=this[n]||{}).nodeType&&(S.cleanData(ve(t,!1)),t.innerHTML=e);t=0}catch(e){}}t&&this.empty().append(e)},null,e,arguments.length)},replaceWith:function(){var n=[];return Pe(this,arguments,function(e){var t=this.parentNode;S.inArray(this,n)<0&&(S.cleanData(ve(this)),t&&t.replaceChild(e,this))},n)}}),S.each({appendTo:"append",prependTo:"prepend",insertBefore:"before",insertAfter:"after",replaceAll:"replaceWith"},function(e,a){S.fn[e]=function(e){for(var t,n=[],r=S(e),i=r.length-1,o=0;o<=i;o++)t=o===i?this:this.clone(!0),S(r[o])[a](t),u.apply(n,t.get());return this.pushStack(n)}});var Me=new RegExp("^("+ee+")(?!px)[a-z%]+$","i"),Ie=function(e){var t=e.ownerDocument.defaultView;return t&&t.opener||(t=C),t.getComputedStyle(e)},We=function(e,t,n){var r,i,o={};for(i in t)o[i]=e.style[i],e.style[i]=t[i];for(i in r=n.call(e),t)e.style[i]=o[i];return r},Fe=new RegExp(ne.join("|"),"i");function Be(e,t,n){var r,i,o,a,s=e.style;return(n=n||Ie(e))&&(""!==(a=n.getPropertyValue(t)||n[t])||ie(e)||(a=S.style(e,t)),!y.pixelBoxStyles()&&Me.test(a)&&Fe.test(t)&&(r=s.width,i=s.minWidth,o=s.maxWidth,s.minWidth=s.maxWidth=s.width=a,a=n.width,s.width=r,s.minWidth=i,s.maxWidth=o)),void 0!==a?a+"":a}function $e(e,t){return{get:function(){if(!e())return(this.get=t).apply(this,arguments);delete this.get}}}!function(){function e(){if(l){u.style.cssText="position:absolute;left:-11111px;width:60px;margin-top:1px;padding:0;border:0",l.style.cssText="position:relative;display:block;box-sizing:border-box;overflow:scroll;margin:auto;border:1px;padding:1px;width:60%;top:1%",re.appendChild(u).appendChild(l);var e=C.getComputedStyle(l);n="1%"!==e.top,s=12===t(e.marginLeft),l.style.right="60%",o=36===t(e.right),r=36===t(e.width),l.style.position="absolute",i=12===t(l.offsetWidth/3),re.removeChild(u),l=null}}function t(e){return Math.round(parseFloat(e))}var n,r,i,o,a,s,u=E.createElement("div"),l=E.createElement("div");l.style&&(l.style.backgroundClip="content-box",l.cloneNode(!0).style.backgroundClip="",y.clearCloneStyle="content-box"===l.style.backgroundClip,S.extend(y,{boxSizingReliable:function(){return e(),r},pixelBoxStyles:function(){return e(),o},pixelPosition:function(){return e(),n},reliableMarginLeft:function(){return e(),s},scrollboxSize:function(){return e(),i},reliableTrDimensions:function(){var e,t,n,r;return null==a&&(e=E.createElement("table"),t=E.createElement("tr"),n=E.createElement("div"),e.style.cssText="position:absolute;left:-11111px",t.style.height="1px",n.style.height="9px",re.appendChild(e).appendChild(t).appendChild(n),r=C.getComputedStyle(t),a=3<parseInt(r.height),re.removeChild(e)),a}}))}();var _e=["Webkit","Moz","ms"],ze=E.createElement("div").style,Ue={};function Xe(e){var t=S.cssProps[e]||Ue[e];return t||(e in ze?e:Ue[e]=function(e){var t=e[0].toUpperCase()+e.slice(1),n=_e.length;while(n--)if((e=_e[n]+t)in ze)return e}(e)||e)}var Ve=/^(none|table(?!-c[ea]).+)/,Ge=/^--/,Ye={position:"absolute",visibility:"hidden",display:"block"},Qe={letterSpacing:"0",fontWeight:"400"};function Je(e,t,n){var r=te.exec(t);return r?Math.max(0,r[2]-(n||0))+(r[3]||"px"):t}function Ke(e,t,n,r,i,o){var a="width"===t?1:0,s=0,u=0;if(n===(r?"border":"content"))return 0;for(;a<4;a+=2)"margin"===n&&(u+=S.css(e,n+ne[a],!0,i)),r?("content"===n&&(u-=S.css(e,"padding"+ne[a],!0,i)),"margin"!==n&&(u-=S.css(e,"border"+ne[a]+"Width",!0,i))):(u+=S.css(e,"padding"+ne[a],!0,i),"padding"!==n?u+=S.css(e,"border"+ne[a]+"Width",!0,i):s+=S.css(e,"border"+ne[a]+"Width",!0,i));return!r&&0<=o&&(u+=Math.max(0,Math.ceil(e["offset"+t[0].toUpperCase()+t.slice(1)]-o-u-s-.5))||0),u}function Ze(e,t,n){var r=Ie(e),i=(!y.boxSizingReliable()||n)&&"border-box"===S.css(e,"boxSizing",!1,r),o=i,a=Be(e,t,r),s="offset"+t[0].toUpperCase()+t.slice(1);if(Me.test(a)){if(!n)return a;a="auto"}return(!y.boxSizingReliable()&&i||!y.reliableTrDimensions()&&A(e,"tr")||"auto"===a||!parseFloat(a)&&"inline"===S.css(e,"display",!1,r))&&e.getClientRects().length&&(i="border-box"===S.css(e,"boxSizing",!1,r),(o=s in e)&&(a=e[s])),(a=parseFloat(a)||0)+Ke(e,t,n||(i?"border":"content"),o,r,a)+"px"}function et(e,t,n,r,i){return new et.prototype.init(e,t,n,r,i)}S.extend({cssHooks:{opacity:{get:function(e,t){if(t){var n=Be(e,"opacity");return""===n?"1":n}}}},cssNumber:{animationIterationCount:!0,columnCount:!0,fillOpacity:!0,flexGrow:!0,flexShrink:!0,fontWeight:!0,gridArea:!0,gridColumn:!0,gridColumnEnd:!0,gridColumnStart:!0,gridRow:!0,gridRowEnd:!0,gridRowStart:!0,lineHeight:!0,opacity:!0,order:!0,orphans:!0,widows:!0,zIndex:!0,zoom:!0},cssProps:{},style:function(e,t,n,r){if(e&&3!==e.nodeType&&8!==e.nodeType&&e.style){var i,o,a,s=X(t),u=Ge.test(t),l=e.style;if(u||(t=Xe(s)),a=S.cssHooks[t]||S.cssHooks[s],void 0===n)return a&&"get"in a&&void 0!==(i=a.get(e,!1,r))?i:l[t];"string"===(o=typeof n)&&(i=te.exec(n))&&i[1]&&(n=se(e,t,i),o="number"),null!=n&&n==n&&("number"!==o||u||(n+=i&&i[3]||(S.cssNumber[s]?"":"px")),y.clearCloneStyle||""!==n||0!==t.indexOf("background")||(l[t]="inherit"),a&&"set"in a&&void 0===(n=a.set(e,n,r))||(u?l.setProperty(t,n):l[t]=n))}},css:function(e,t,n,r){var i,o,a,s=X(t);return Ge.test(t)||(t=Xe(s)),(a=S.cssHooks[t]||S.cssHooks[s])&&"get"in a&&(i=a.get(e,!0,n)),void 0===i&&(i=Be(e,t,r)),"normal"===i&&t in Qe&&(i=Qe[t]),""===n||n?(o=parseFloat(i),!0===n||isFinite(o)?o||0:i):i}}),S.each(["height","width"],function(e,u){S.cssHooks[u]={get:function(e,t,n){if(t)return!Ve.test(S.css(e,"display"))||e.getClientRects().length&&e.getBoundingClientRect().width?Ze(e,u,n):We(e,Ye,function(){return Ze(e,u,n)})},set:function(e,t,n){var r,i=Ie(e),o=!y.scrollboxSize()&&"absolute"===i.position,a=(o||n)&&"border-box"===S.css(e,"boxSizing",!1,i),s=n?Ke(e,u,n,a,i):0;return a&&o&&(s-=Math.ceil(e["offset"+u[0].toUpperCase()+u.slice(1)]-parseFloat(i[u])-Ke(e,u,"border",!1,i)-.5)),s&&(r=te.exec(t))&&"px"!==(r[3]||"px")&&(e.style[u]=t,t=S.css(e,u)),Je(0,t,s)}}}),S.cssHooks.marginLeft=$e(y.reliableMarginLeft,function(e,t){if(t)return(parseFloat(Be(e,"marginLeft"))||e.getBoundingClientRect().left-We(e,{marginLeft:0},function(){return e.getBoundingClientRect().left}))+"px"}),S.each({margin:"",padding:"",border:"Width"},function(i,o){S.cssHooks[i+o]={expand:function(e){for(var t=0,n={},r="string"==typeof e?e.split(" "):[e];t<4;t++)n[i+ne[t]+o]=r[t]||r[t-2]||r[0];return n}},"margin"!==i&&(S.cssHooks[i+o].set=Je)}),S.fn.extend({css:function(e,t){return $(this,function(e,t,n){var r,i,o={},a=0;if(Array.isArray(t)){for(r=Ie(e),i=t.length;a<i;a++)o[t[a]]=S.css(e,t[a],!1,r);return o}return void 0!==n?S.style(e,t,n):S.css(e,t)},e,t,1<arguments.length)}}),((S.Tween=et).prototype={constructor:et,init:function(e,t,n,r,i,o){this.elem=e,this.prop=n,this.easing=i||S.easing._default,this.options=t,this.start=this.now=this.cur(),this.end=r,this.unit=o||(S.cssNumber[n]?"":"px")},cur:function(){var e=et.propHooks[this.prop];return e&&e.get?e.get(this):et.propHooks._default.get(this)},run:function(e){var t,n=et.propHooks[this.prop];return this.options.duration?this.pos=t=S.easing[this.easing](e,this.options.duration*e,0,1,this.options.duration):this.pos=t=e,this.now=(this.end-this.start)*t+this.start,this.options.step&&this.options.step.call(this.elem,this.now,this),n&&n.set?n.set(this):et.propHooks._default.set(this),this}}).init.prototype=et.prototype,(et.propHooks={_default:{get:function(e){var t;return 1!==e.elem.nodeType||null!=e.elem[e.prop]&&null==e.elem.style[e.prop]?e.elem[e.prop]:(t=S.css(e.elem,e.prop,""))&&"auto"!==t?t:0},set:function(e){S.fx.step[e.prop]?S.fx.step[e.prop](e):1!==e.elem.nodeType||!S.cssHooks[e.prop]&&null==e.elem.style[Xe(e.prop)]?e.elem[e.prop]=e.now:S.style(e.elem,e.prop,e.now+e.unit)}}}).scrollTop=et.propHooks.scrollLeft={set:function(e){e.elem.nodeType&&e.elem.parentNode&&(e.elem[e.prop]=e.now)}},S.easing={linear:function(e){return e},swing:function(e){return.5-Math.cos(e*Math.PI)/2},_default:"swing"},S.fx=et.prototype.init,S.fx.step={};var tt,nt,rt,it,ot=/^(?:toggle|show|hide)$/,at=/queueHooks$/;function st(){nt&&(!1===E.hidden&&C.requestAnimationFrame?C.requestAnimationFrame(st):C.setTimeout(st,S.fx.interval),S.fx.tick())}function ut(){return C.setTimeout(function(){tt=void 0}),tt=Date.now()}function lt(e,t){var n,r=0,i={height:e};for(t=t?1:0;r<4;r+=2-t)i["margin"+(n=ne[r])]=i["padding"+n]=e;return t&&(i.opacity=i.width=e),i}function ct(e,t,n){for(var r,i=(ft.tweeners[t]||[]).concat(ft.tweeners["*"]),o=0,a=i.length;o<a;o++)if(r=i[o].call(n,t,e))return r}function ft(o,e,t){var n,a,r=0,i=ft.prefilters.length,s=S.Deferred().always(function(){delete u.elem}),u=function(){if(a)return!1;for(var e=tt||ut(),t=Math.max(0,l.startTime+l.duration-e),n=1-(t/l.duration||0),r=0,i=l.tweens.length;r<i;r++)l.tweens[r].run(n);return s.notifyWith(o,[l,n,t]),n<1&&i?t:(i||s.notifyWith(o,[l,1,0]),s.resolveWith(o,[l]),!1)},l=s.promise({elem:o,props:S.extend({},e),opts:S.extend(!0,{specialEasing:{},easing:S.easing._default},t),originalProperties:e,originalOptions:t,startTime:tt||ut(),duration:t.duration,tweens:[],createTween:function(e,t){var n=S.Tween(o,l.opts,e,t,l.opts.specialEasing[e]||l.opts.easing);return l.tweens.push(n),n},stop:function(e){var t=0,n=e?l.tweens.length:0;if(a)return this;for(a=!0;t<n;t++)l.tweens[t].run(1);return e?(s.notifyWith(o,[l,1,0]),s.resolveWith(o,[l,e])):s.rejectWith(o,[l,e]),this}}),c=l.props;for(!function(e,t){var n,r,i,o,a;for(n in e)if(i=t[r=X(n)],o=e[n],Array.isArray(o)&&(i=o[1],o=e[n]=o[0]),n!==r&&(e[r]=o,delete e[n]),(a=S.cssHooks[r])&&"expand"in a)for(n in o=a.expand(o),delete e[r],o)n in e||(e[n]=o[n],t[n]=i);else t[r]=i}(c,l.opts.specialEasing);r<i;r++)if(n=ft.prefilters[r].call(l,o,c,l.opts))return m(n.stop)&&(S._queueHooks(l.elem,l.opts.queue).stop=n.stop.bind(n)),n;return S.map(c,ct,l),m(l.opts.start)&&l.opts.start.call(o,l),l.progress(l.opts.progress).done(l.opts.done,l.opts.complete).fail(l.opts.fail).always(l.opts.always),S.fx.timer(S.extend(u,{elem:o,anim:l,queue:l.opts.queue})),l}S.Animation=S.extend(ft,{tweeners:{"*":[function(e,t){var n=this.createTween(e,t);return se(n.elem,e,te.exec(t),n),n}]},tweener:function(e,t){m(e)?(t=e,e=["*"]):e=e.match(P);for(var n,r=0,i=e.length;r<i;r++)n=e[r],ft.tweeners[n]=ft.tweeners[n]||[],ft.tweeners[n].unshift(t)},prefilters:[function(e,t,n){var r,i,o,a,s,u,l,c,f="width"in t||"height"in t,p=this,d={},h=e.style,g=e.nodeType&&ae(e),v=Y.get(e,"fxshow");for(r in n.queue||(null==(a=S._queueHooks(e,"fx")).unqueued&&(a.unqueued=0,s=a.empty.fire,a.empty.fire=function(){a.unqueued||s()}),a.unqueued++,p.always(function(){p.always(function(){a.unqueued--,S.queue(e,"fx").length||a.empty.fire()})})),t)if(i=t[r],ot.test(i)){if(delete t[r],o=o||"toggle"===i,i===(g?"hide":"show")){if("show"!==i||!v||void 0===v[r])continue;g=!0}d[r]=v&&v[r]||S.style(e,r)}if((u=!S.isEmptyObject(t))||!S.isEmptyObject(d))for(r in f&&1===e.nodeType&&(n.overflow=[h.overflow,h.overflowX,h.overflowY],null==(l=v&&v.display)&&(l=Y.get(e,"display")),"none"===(c=S.css(e,"display"))&&(l?c=l:(le([e],!0),l=e.style.display||l,c=S.css(e,"display"),le([e]))),("inline"===c||"inline-block"===c&&null!=l)&&"none"===S.css(e,"float")&&(u||(p.done(function(){h.display=l}),null==l&&(c=h.display,l="none"===c?"":c)),h.display="inline-block")),n.overflow&&(h.overflow="hidden",p.always(function(){h.overflow=n.overflow[0],h.overflowX=n.overflow[1],h.overflowY=n.overflow[2]})),u=!1,d)u||(v?"hidden"in v&&(g=v.hidden):v=Y.access(e,"fxshow",{display:l}),o&&(v.hidden=!g),g&&le([e],!0),p.done(function(){for(r in g||le([e]),Y.remove(e,"fxshow"),d)S.style(e,r,d[r])})),u=ct(g?v[r]:0,r,p),r in v||(v[r]=u.start,g&&(u.end=u.start,u.start=0))}],prefilter:function(e,t){t?ft.prefilters.unshift(e):ft.prefilters.push(e)}}),S.speed=function(e,t,n){var r=e&&"object"==typeof e?S.extend({},e):{complete:n||!n&&t||m(e)&&e,duration:e,easing:n&&t||t&&!m(t)&&t};return S.fx.off?r.duration=0:"number"!=typeof r.duration&&(r.duration in S.fx.speeds?r.duration=S.fx.speeds[r.duration]:r.duration=S.fx.speeds._default),null!=r.queue&&!0!==r.queue||(r.queue="fx"),r.old=r.complete,r.complete=function(){m(r.old)&&r.old.call(this),r.queue&&S.dequeue(this,r.queue)},r},S.fn.extend({fadeTo:function(e,t,n,r){return this.filter(ae).css("opacity",0).show().end().animate({opacity:t},e,n,r)},animate:function(t,e,n,r){var i=S.isEmptyObject(t),o=S.speed(e,n,r),a=function(){var e=ft(this,S.extend({},t),o);(i||Y.get(this,"finish"))&&e.stop(!0)};return a.finish=a,i||!1===o.queue?this.each(a):this.queue(o.queue,a)},stop:function(i,e,o){var a=function(e){var t=e.stop;delete e.stop,t(o)};return"string"!=typeof i&&(o=e,e=i,i=void 0),e&&this.queue(i||"fx",[]),this.each(function(){var e=!0,t=null!=i&&i+"queueHooks",n=S.timers,r=Y.get(this);if(t)r[t]&&r[t].stop&&a(r[t]);else for(t in r)r[t]&&r[t].stop&&at.test(t)&&a(r[t]);for(t=n.length;t--;)n[t].elem!==this||null!=i&&n[t].queue!==i||(n[t].anim.stop(o),e=!1,n.splice(t,1));!e&&o||S.dequeue(this,i)})},finish:function(a){return!1!==a&&(a=a||"fx"),this.each(function(){var e,t=Y.get(this),n=t[a+"queue"],r=t[a+"queueHooks"],i=S.timers,o=n?n.length:0;for(t.finish=!0,S.queue(this,a,[]),r&&r.stop&&r.stop.call(this,!0),e=i.length;e--;)i[e].elem===this&&i[e].queue===a&&(i[e].anim.stop(!0),i.splice(e,1));for(e=0;e<o;e++)n[e]&&n[e].finish&&n[e].finish.call(this);delete t.finish})}}),S.each(["toggle","show","hide"],function(e,r){var i=S.fn[r];S.fn[r]=function(e,t,n){return null==e||"boolean"==typeof e?i.apply(this,arguments):this.animate(lt(r,!0),e,t,n)}}),S.each({slideDown:lt("show"),slideUp:lt("hide"),slideToggle:lt("toggle"),fadeIn:{opacity:"show"},fadeOut:{opacity:"hide"},fadeToggle:{opacity:"toggle"}},function(e,r){S.fn[e]=function(e,t,n){return this.animate(r,e,t,n)}}),S.timers=[],S.fx.tick=function(){var e,t=0,n=S.timers;for(tt=Date.now();t<n.length;t++)(e=n[t])()||n[t]!==e||n.splice(t--,1);n.length||S.fx.stop(),tt=void 0},S.fx.timer=function(e){S.timers.push(e),S.fx.start()},S.fx.interval=13,S.fx.start=function(){nt||(nt=!0,st())},S.fx.stop=function(){nt=null},S.fx.speeds={slow:600,fast:200,_default:400},S.fn.delay=function(r,e){return r=S.fx&&S.fx.speeds[r]||r,e=e||"fx",this.queue(e,function(e,t){var n=C.setTimeout(e,r);t.stop=function(){C.clearTimeout(n)}})},rt=E.createElement("input"),it=E.createElement("select").appendChild(E.createElement("option")),rt.type="checkbox",y.checkOn=""!==rt.value,y.optSelected=it.selected,(rt=E.createElement("input")).value="t",rt.type="radio",y.radioValue="t"===rt.value;var pt,dt=S.expr.attrHandle;S.fn.extend({attr:function(e,t){return $(this,S.attr,e,t,1<arguments.length)},removeAttr:function(e){return this.each(function(){S.removeAttr(this,e)})}}),S.extend({attr:function(e,t,n){var r,i,o=e.nodeType;if(3!==o&&8!==o&&2!==o)return"undefined"==typeof e.getAttribute?S.prop(e,t,n):(1===o&&S.isXMLDoc(e)||(i=S.attrHooks[t.toLowerCase()]||(S.expr.match.bool.test(t)?pt:void 0)),void 0!==n?null===n?void S.removeAttr(e,t):i&&"set"in i&&void 0!==(r=i.set(e,n,t))?r:(e.setAttribute(t,n+""),n):i&&"get"in i&&null!==(r=i.get(e,t))?r:null==(r=S.find.attr(e,t))?void 0:r)},attrHooks:{type:{set:function(e,t){if(!y.radioValue&&"radio"===t&&A(e,"input")){var n=e.value;return e.setAttribute("type",t),n&&(e.value=n),t}}}},removeAttr:function(e,t){var n,r=0,i=t&&t.match(P);if(i&&1===e.nodeType)while(n=i[r++])e.removeAttribute(n)}}),pt={set:function(e,t,n){return!1===t?S.removeAttr(e,n):e.setAttribute(n,n),n}},S.each(S.expr.match.bool.source.match(/\\w+/g),function(e,t){var a=dt[t]||S.find.attr;dt[t]=function(e,t,n){var r,i,o=t.toLowerCase();return n||(i=dt[o],dt[o]=r,r=null!=a(e,t,n)?o:null,dt[o]=i),r}});var ht=/^(?:input|select|textarea|button)$/i,gt=/^(?:a|area)$/i;function vt(e){return(e.match(P)||[]).join(" ")}function yt(e){return e.getAttribute&&e.getAttribute("class")||""}function mt(e){return Array.isArray(e)?e:"string"==typeof e&&e.match(P)||[]}S.fn.extend({prop:function(e,t){return $(this,S.prop,e,t,1<arguments.length)},removeProp:function(e){return this.each(function(){delete this[S.propFix[e]||e]})}}),S.extend({prop:function(e,t,n){var r,i,o=e.nodeType;if(3!==o&&8!==o&&2!==o)return 1===o&&S.isXMLDoc(e)||(t=S.propFix[t]||t,i=S.propHooks[t]),void 0!==n?i&&"set"in i&&void 0!==(r=i.set(e,n,t))?r:e[t]=n:i&&"get"in i&&null!==(r=i.get(e,t))?r:e[t]},propHooks:{tabIndex:{get:function(e){var t=S.find.attr(e,"tabindex");return t?parseInt(t,10):ht.test(e.nodeName)||gt.test(e.nodeName)&&e.href?0:-1}}},propFix:{"for":"htmlFor","class":"className"}}),y.optSelected||(S.propHooks.selected={get:function(e){var t=e.parentNode;return t&&t.parentNode&&t.parentNode.selectedIndex,null},set:function(e){var t=e.parentNode;t&&(t.selectedIndex,t.parentNode&&t.parentNode.selectedIndex)}}),S.each(["tabIndex","readOnly","maxLength","cellSpacing","cellPadding","rowSpan","colSpan","useMap","frameBorder","contentEditable"],function(){S.propFix[this.toLowerCase()]=this}),S.fn.extend({addClass:function(t){var e,n,r,i,o,a,s,u=0;if(m(t))return this.each(function(e){S(this).addClass(t.call(this,e,yt(this)))});if((e=mt(t)).length)while(n=this[u++])if(i=yt(n),r=1===n.nodeType&&" "+vt(i)+" "){a=0;while(o=e[a++])r.indexOf(" "+o+" ")<0&&(r+=o+" ");i!==(s=vt(r))&&n.setAttribute("class",s)}return this},removeClass:function(t){var e,n,r,i,o,a,s,u=0;if(m(t))return this.each(function(e){S(this).removeClass(t.call(this,e,yt(this)))});if(!arguments.length)return this.attr("class","");if((e=mt(t)).length)while(n=this[u++])if(i=yt(n),r=1===n.nodeType&&" "+vt(i)+" "){a=0;while(o=e[a++])while(-1<r.indexOf(" "+o+" "))r=r.replace(" "+o+" "," ");i!==(s=vt(r))&&n.setAttribute("class",s)}return this},toggleClass:function(i,t){var o=typeof i,a="string"===o||Array.isArray(i);return"boolean"==typeof t&&a?t?this.addClass(i):this.removeClass(i):m(i)?this.each(function(e){S(this).toggleClass(i.call(this,e,yt(this),t),t)}):this.each(function(){var e,t,n,r;if(a){t=0,n=S(this),r=mt(i);while(e=r[t++])n.hasClass(e)?n.removeClass(e):n.addClass(e)}else void 0!==i&&"boolean"!==o||((e=yt(this))&&Y.set(this,"__className__",e),this.setAttribute&&this.setAttribute("class",e||!1===i?"":Y.get(this,"__className__")||""))})},hasClass:function(e){var t,n,r=0;t=" "+e+" ";while(n=this[r++])if(1===n.nodeType&&-1<(" "+vt(yt(n))+" ").indexOf(t))return!0;return!1}});var xt=/\\r/g;S.fn.extend({val:function(n){var r,e,i,t=this[0];return arguments.length?(i=m(n),this.each(function(e){var t;1===this.nodeType&&(null==(t=i?n.call(this,e,S(this).val()):n)?t="":"number"==typeof t?t+="":Array.isArray(t)&&(t=S.map(t,function(e){return null==e?"":e+""})),(r=S.valHooks[this.type]||S.valHooks[this.nodeName.toLowerCase()])&&"set"in r&&void 0!==r.set(this,t,"value")||(this.value=t))})):t?(r=S.valHooks[t.type]||S.valHooks[t.nodeName.toLowerCase()])&&"get"in r&&void 0!==(e=r.get(t,"value"))?e:"string"==typeof(e=t.value)?e.replace(xt,""):null==e?"":e:void 0}}),S.extend({valHooks:{option:{get:function(e){var t=S.find.attr(e,"value");return null!=t?t:vt(S.text(e))}},select:{get:function(e){var t,n,r,i=e.options,o=e.selectedIndex,a="select-one"===e.type,s=a?null:[],u=a?o+1:i.length;for(r=o<0?u:a?o:0;r<u;r++)if(((n=i[r]).selected||r===o)&&!n.disabled&&(!n.parentNode.disabled||!A(n.parentNode,"optgroup"))){if(t=S(n).val(),a)return t;s.push(t)}return s},set:function(e,t){var n,r,i=e.options,o=S.makeArray(t),a=i.length;while(a--)((r=i[a]).selected=-1<S.inArray(S.valHooks.option.get(r),o))&&(n=!0);return n||(e.selectedIndex=-1),o}}}}),S.each(["radio","checkbox"],function(){S.valHooks[this]={set:function(e,t){if(Array.isArray(t))return e.checked=-1<S.inArray(S(e).val(),t)}},y.checkOn||(S.valHooks[this].get=function(e){return null===e.getAttribute("value")?"on":e.value})}),y.focusin="onfocusin"in C;var bt=/^(?:focusinfocus|focusoutblur)$/,wt=function(e){e.stopPropagation()};S.extend(S.event,{trigger:function(e,t,n,r){var i,o,a,s,u,l,c,f,p=[n||E],d=v.call(e,"type")?e.type:e,h=v.call(e,"namespace")?e.namespace.split("."):[];if(o=f=a=n=n||E,3!==n.nodeType&&8!==n.nodeType&&!bt.test(d+S.event.triggered)&&(-1<d.indexOf(".")&&(d=(h=d.split(".")).shift(),h.sort()),u=d.indexOf(":")<0&&"on"+d,(e=e[S.expando]?e:new S.Event(d,"object"==typeof e&&e)).isTrigger=r?2:3,e.namespace=h.join("."),e.rnamespace=e.namespace?new RegExp("(^|\\\\.)"+h.join("\\\\.(?:.*\\\\.|)")+"(\\\\.|$)"):null,e.result=void 0,e.target||(e.target=n),t=null==t?[e]:S.makeArray(t,[e]),c=S.event.special[d]||{},r||!c.trigger||!1!==c.trigger.apply(n,t))){if(!r&&!c.noBubble&&!x(n)){for(s=c.delegateType||d,bt.test(s+d)||(o=o.parentNode);o;o=o.parentNode)p.push(o),a=o;a===(n.ownerDocument||E)&&p.push(a.defaultView||a.parentWindow||C)}i=0;while((o=p[i++])&&!e.isPropagationStopped())f=o,e.type=1<i?s:c.bindType||d,(l=(Y.get(o,"events")||Object.create(null))[e.type]&&Y.get(o,"handle"))&&l.apply(o,t),(l=u&&o[u])&&l.apply&&V(o)&&(e.result=l.apply(o,t),!1===e.result&&e.preventDefault());return e.type=d,r||e.isDefaultPrevented()||c._default&&!1!==c._default.apply(p.pop(),t)||!V(n)||u&&m(n[d])&&!x(n)&&((a=n[u])&&(n[u]=null),S.event.triggered=d,e.isPropagationStopped()&&f.addEventListener(d,wt),n[d](),e.isPropagationStopped()&&f.removeEventListener(d,wt),S.event.triggered=void 0,a&&(n[u]=a)),e.result}},simulate:function(e,t,n){var r=S.extend(new S.Event,n,{type:e,isSimulated:!0});S.event.trigger(r,null,t)}}),S.fn.extend({trigger:function(e,t){return this.each(function(){S.event.trigger(e,t,this)})},triggerHandler:function(e,t){var n=this[0];if(n)return S.event.trigger(e,t,n,!0)}}),y.focusin||S.each({focus:"focusin",blur:"focusout"},function(n,r){var i=function(e){S.event.simulate(r,e.target,S.event.fix(e))};S.event.special[r]={setup:function(){var e=this.ownerDocument||this.document||this,t=Y.access(e,r);t||e.addEventListener(n,i,!0),Y.access(e,r,(t||0)+1)},teardown:function(){var e=this.ownerDocument||this.document||this,t=Y.access(e,r)-1;t?Y.access(e,r,t):(e.removeEventListener(n,i,!0),Y.remove(e,r))}}});var Tt=C.location,Ct={guid:Date.now()},Et=/\\?/;S.parseXML=function(e){var t;if(!e||"string"!=typeof e)return null;try{t=(new C.DOMParser).parseFromString(e,"text/xml")}catch(e){t=void 0}return t&&!t.getElementsByTagName("parsererror").length||S.error("Invalid XML: "+e),t};var St=/\\[\\]$/,kt=/\\r?\\n/g,At=/^(?:submit|button|image|reset|file)$/i,Nt=/^(?:input|select|textarea|keygen)/i;function Dt(n,e,r,i){var t;if(Array.isArray(e))S.each(e,function(e,t){r||St.test(n)?i(n,t):Dt(n+"["+("object"==typeof t&&null!=t?e:"")+"]",t,r,i)});else if(r||"object"!==w(e))i(n,e);else for(t in e)Dt(n+"["+t+"]",e[t],r,i)}S.param=function(e,t){var n,r=[],i=function(e,t){var n=m(t)?t():t;r[r.length]=encodeURIComponent(e)+"="+encodeURIComponent(null==n?"":n)};if(null==e)return"";if(Array.isArray(e)||e.jquery&&!S.isPlainObject(e))S.each(e,function(){i(this.name,this.value)});else for(n in e)Dt(n,e[n],t,i);return r.join("&")},S.fn.extend({serialize:function(){return S.param(this.serializeArray())},serializeArray:function(){return this.map(function(){var e=S.prop(this,"elements");return e?S.makeArray(e):this}).filter(function(){var e=this.type;return this.name&&!S(this).is(":disabled")&&Nt.test(this.nodeName)&&!At.test(e)&&(this.checked||!pe.test(e))}).map(function(e,t){var n=S(this).val();return null==n?null:Array.isArray(n)?S.map(n,function(e){return{name:t.name,value:e.replace(kt,"\\r\\n")}}):{name:t.name,value:n.replace(kt,"\\r\\n")}}).get()}});var jt=/%20/g,qt=/#.*$/,Lt=/([?&])_=[^&]*/,Ht=/^(.*?):[ \\t]*([^\\r\\n]*)$/gm,Ot=/^(?:GET|HEAD)$/,Pt=/^\\/\\//,Rt={},Mt={},It="*/".concat("*"),Wt=E.createElement("a");function Ft(o){return function(e,t){"string"!=typeof e&&(t=e,e="*");var n,r=0,i=e.toLowerCase().match(P)||[];if(m(t))while(n=i[r++])"+"===n[0]?(n=n.slice(1)||"*",(o[n]=o[n]||[]).unshift(t)):(o[n]=o[n]||[]).push(t)}}function Bt(t,i,o,a){var s={},u=t===Mt;function l(e){var r;return s[e]=!0,S.each(t[e]||[],function(e,t){var n=t(i,o,a);return"string"!=typeof n||u||s[n]?u?!(r=n):void 0:(i.dataTypes.unshift(n),l(n),!1)}),r}return l(i.dataTypes[0])||!s["*"]&&l("*")}function $t(e,t){var n,r,i=S.ajaxSettings.flatOptions||{};for(n in t)void 0!==t[n]&&((i[n]?e:r||(r={}))[n]=t[n]);return r&&S.extend(!0,e,r),e}Wt.href=Tt.href,S.extend({active:0,lastModified:{},etag:{},ajaxSettings:{url:Tt.href,type:"GET",isLocal:/^(?:about|app|app-storage|.+-extension|file|res|widget):$/.test(Tt.protocol),global:!0,processData:!0,async:!0,contentType:"application/x-www-form-urlencoded; charset=UTF-8",accepts:{"*":It,text:"text/plain",html:"text/html",xml:"application/xml, text/xml",json:"application/json, text/javascript"},contents:{xml:/\\bxml\\b/,html:/\\bhtml/,json:/\\bjson\\b/},responseFields:{xml:"responseXML",text:"responseText",json:"responseJSON"},converters:{"* text":String,"text html":!0,"text json":JSON.parse,"text xml":S.parseXML},flatOptions:{url:!0,context:!0}},ajaxSetup:function(e,t){return t?$t($t(e,S.ajaxSettings),t):$t(S.ajaxSettings,e)},ajaxPrefilter:Ft(Rt),ajaxTransport:Ft(Mt),ajax:function(e,t){"object"==typeof e&&(t=e,e=void 0),t=t||{};var c,f,p,n,d,r,h,g,i,o,v=S.ajaxSetup({},t),y=v.context||v,m=v.context&&(y.nodeType||y.jquery)?S(y):S.event,x=S.Deferred(),b=S.Callbacks("once memory"),w=v.statusCode||{},a={},s={},u="canceled",T={readyState:0,getResponseHeader:function(e){var t;if(h){if(!n){n={};while(t=Ht.exec(p))n[t[1].toLowerCase()+" "]=(n[t[1].toLowerCase()+" "]||[]).concat(t[2])}t=n[e.toLowerCase()+" "]}return null==t?null:t.join(", ")},getAllResponseHeaders:function(){return h?p:null},setRequestHeader:function(e,t){return null==h&&(e=s[e.toLowerCase()]=s[e.toLowerCase()]||e,a[e]=t),this},overrideMimeType:function(e){return null==h&&(v.mimeType=e),this},statusCode:function(e){var t;if(e)if(h)T.always(e[T.status]);else for(t in e)w[t]=[w[t],e[t]];return this},abort:function(e){var t=e||u;return c&&c.abort(t),l(0,t),this}};if(x.promise(T),v.url=((e||v.url||Tt.href)+"").replace(Pt,Tt.protocol+"//"),v.type=t.method||t.type||v.method||v.type,v.dataTypes=(v.dataType||"*").toLowerCase().match(P)||[""],null==v.crossDomain){r=E.createElement("a");try{r.href=v.url,r.href=r.href,v.crossDomain=Wt.protocol+"//"+Wt.host!=r.protocol+"//"+r.host}catch(e){v.crossDomain=!0}}if(v.data&&v.processData&&"string"!=typeof v.data&&(v.data=S.param(v.data,v.traditional)),Bt(Rt,v,t,T),h)return T;for(i in(g=S.event&&v.global)&&0==S.active++&&S.event.trigger("ajaxStart"),v.type=v.type.toUpperCase(),v.hasContent=!Ot.test(v.type),f=v.url.replace(qt,""),v.hasContent?v.data&&v.processData&&0===(v.contentType||"").indexOf("application/x-www-form-urlencoded")&&(v.data=v.data.replace(jt,"+")):(o=v.url.slice(f.length),v.data&&(v.processData||"string"==typeof v.data)&&(f+=(Et.test(f)?"&":"?")+v.data,delete v.data),!1===v.cache&&(f=f.replace(Lt,"$1"),o=(Et.test(f)?"&":"?")+"_="+Ct.guid+++o),v.url=f+o),v.ifModified&&(S.lastModified[f]&&T.setRequestHeader("If-Modified-Since",S.lastModified[f]),S.etag[f]&&T.setRequestHeader("If-None-Match",S.etag[f])),(v.data&&v.hasContent&&!1!==v.contentType||t.contentType)&&T.setRequestHeader("Content-Type",v.contentType),T.setRequestHeader("Accept",v.dataTypes[0]&&v.accepts[v.dataTypes[0]]?v.accepts[v.dataTypes[0]]+("*"!==v.dataTypes[0]?", "+It+"; q=0.01":""):v.accepts["*"]),v.headers)T.setRequestHeader(i,v.headers[i]);if(v.beforeSend&&(!1===v.beforeSend.call(y,T,v)||h))return T.abort();if(u="abort",b.add(v.complete),T.done(v.success),T.fail(v.error),c=Bt(Mt,v,t,T)){if(T.readyState=1,g&&m.trigger("ajaxSend",[T,v]),h)return T;v.async&&0<v.timeout&&(d=C.setTimeout(function(){T.abort("timeout")},v.timeout));try{h=!1,c.send(a,l)}catch(e){if(h)throw e;l(-1,e)}}else l(-1,"No Transport");function l(e,t,n,r){var i,o,a,s,u,l=t;h||(h=!0,d&&C.clearTimeout(d),c=void 0,p=r||"",T.readyState=0<e?4:0,i=200<=e&&e<300||304===e,n&&(s=function(e,t,n){var r,i,o,a,s=e.contents,u=e.dataTypes;while("*"===u[0])u.shift(),void 0===r&&(r=e.mimeType||t.getResponseHeader("Content-Type"));if(r)for(i in s)if(s[i]&&s[i].test(r)){u.unshift(i);break}if(u[0]in n)o=u[0];else{for(i in n){if(!u[0]||e.converters[i+" "+u[0]]){o=i;break}a||(a=i)}o=o||a}if(o)return o!==u[0]&&u.unshift(o),n[o]}(v,T,n)),!i&&-1<S.inArray("script",v.dataTypes)&&(v.converters["text script"]=function(){}),s=function(e,t,n,r){var i,o,a,s,u,l={},c=e.dataTypes.slice();if(c[1])for(a in e.converters)l[a.toLowerCase()]=e.converters[a];o=c.shift();while(o)if(e.responseFields[o]&&(n[e.responseFields[o]]=t),!u&&r&&e.dataFilter&&(t=e.dataFilter(t,e.dataType)),u=o,o=c.shift())if("*"===o)o=u;else if("*"!==u&&u!==o){if(!(a=l[u+" "+o]||l["* "+o]))for(i in l)if((s=i.split(" "))[1]===o&&(a=l[u+" "+s[0]]||l["* "+s[0]])){!0===a?a=l[i]:!0!==l[i]&&(o=s[0],c.unshift(s[1]));break}if(!0!==a)if(a&&e["throws"])t=a(t);else try{t=a(t)}catch(e){return{state:"parsererror",error:a?e:"No conversion from "+u+" to "+o}}}return{state:"success",data:t}}(v,s,T,i),i?(v.ifModified&&((u=T.getResponseHeader("Last-Modified"))&&(S.lastModified[f]=u),(u=T.getResponseHeader("etag"))&&(S.etag[f]=u)),204===e||"HEAD"===v.type?l="nocontent":304===e?l="notmodified":(l=s.state,o=s.data,i=!(a=s.error))):(a=l,!e&&l||(l="error",e<0&&(e=0))),T.status=e,T.statusText=(t||l)+"",i?x.resolveWith(y,[o,l,T]):x.rejectWith(y,[T,l,a]),T.statusCode(w),w=void 0,g&&m.trigger(i?"ajaxSuccess":"ajaxError",[T,v,i?o:a]),b.fireWith(y,[T,l]),g&&(m.trigger("ajaxComplete",[T,v]),--S.active||S.event.trigger("ajaxStop")))}return T},getJSON:function(e,t,n){return S.get(e,t,n,"json")},getScript:function(e,t){return S.get(e,void 0,t,"script")}}),S.each(["get","post"],function(e,i){S[i]=function(e,t,n,r){return m(t)&&(r=r||n,n=t,t=void 0),S.ajax(S.extend({url:e,type:i,dataType:r,data:t,success:n},S.isPlainObject(e)&&e))}}),S.ajaxPrefilter(function(e){var t;for(t in e.headers)"content-type"===t.toLowerCase()&&(e.contentType=e.headers[t]||"")}),S._evalUrl=function(e,t,n){return S.ajax({url:e,type:"GET",dataType:"script",cache:!0,async:!1,global:!1,converters:{"text script":function(){}},dataFilter:function(e){S.globalEval(e,t,n)}})},S.fn.extend({wrapAll:function(e){var t;return this[0]&&(m(e)&&(e=e.call(this[0])),t=S(e,this[0].ownerDocument).eq(0).clone(!0),this[0].parentNode&&t.insertBefore(this[0]),t.map(function(){var e=this;while(e.firstElementChild)e=e.firstElementChild;return e}).append(this)),this},wrapInner:function(n){return m(n)?this.each(function(e){S(this).wrapInner(n.call(this,e))}):this.each(function(){var e=S(this),t=e.contents();t.length?t.wrapAll(n):e.append(n)})},wrap:function(t){var n=m(t);return this.each(function(e){S(this).wrapAll(n?t.call(this,e):t)})},unwrap:function(e){return this.parent(e).not("body").each(function(){S(this).replaceWith(this.childNodes)}),this}}),S.expr.pseudos.hidden=function(e){return!S.expr.pseudos.visible(e)},S.expr.pseudos.visible=function(e){return!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)},S.ajaxSettings.xhr=function(){try{return new C.XMLHttpRequest}catch(e){}};var _t={0:200,1223:204},zt=S.ajaxSettings.xhr();y.cors=!!zt&&"withCredentials"in zt,y.ajax=zt=!!zt,S.ajaxTransport(function(i){var o,a;if(y.cors||zt&&!i.crossDomain)return{send:function(e,t){var n,r=i.xhr();if(r.open(i.type,i.url,i.async,i.username,i.password),i.xhrFields)for(n in i.xhrFields)r[n]=i.xhrFields[n];for(n in i.mimeType&&r.overrideMimeType&&r.overrideMimeType(i.mimeType),i.crossDomain||e["X-Requested-With"]||(e["X-Requested-With"]="XMLHttpRequest"),e)r.setRequestHeader(n,e[n]);o=function(e){return function(){o&&(o=a=r.onload=r.onerror=r.onabort=r.ontimeout=r.onreadystatechange=null,"abort"===e?r.abort():"error"===e?"number"!=typeof r.status?t(0,"error"):t(r.status,r.statusText):t(_t[r.status]||r.status,r.statusText,"text"!==(r.responseType||"text")||"string"!=typeof r.responseText?{binary:r.response}:{text:r.responseText},r.getAllResponseHeaders()))}},r.onload=o(),a=r.onerror=r.ontimeout=o("error"),void 0!==r.onabort?r.onabort=a:r.onreadystatechange=function(){4===r.readyState&&C.setTimeout(function(){o&&a()})},o=o("abort");try{r.send(i.hasContent&&i.data||null)}catch(e){if(o)throw e}},abort:function(){o&&o()}}}),S.ajaxPrefilter(function(e){e.crossDomain&&(e.contents.script=!1)}),S.ajaxSetup({accepts:{script:"text/javascript, application/javascript, application/ecmascript, application/x-ecmascript"},contents:{script:/\\b(?:java|ecma)script\\b/},converters:{"text script":function(e){return S.globalEval(e),e}}}),S.ajaxPrefilter("script",function(e){void 0===e.cache&&(e.cache=!1),e.crossDomain&&(e.type="GET")}),S.ajaxTransport("script",function(n){var r,i;if(n.crossDomain||n.scriptAttrs)return{send:function(e,t){r=S("<script>").attr(n.scriptAttrs||{}).prop({charset:n.scriptCharset,src:n.url}).on("load error",i=function(e){r.remove(),i=null,e&&t("error"===e.type?404:200,e.type)}),E.head.appendChild(r[0])},abort:function(){i&&i()}}});var Ut,Xt=[],Vt=/(=)\\?(?=&|$)|\\?\\?/;S.ajaxSetup({jsonp:"callback",jsonpCallback:function(){var e=Xt.pop()||S.expando+"_"+Ct.guid++;return this[e]=!0,e}}),S.ajaxPrefilter("json jsonp",function(e,t,n){var r,i,o,a=!1!==e.jsonp&&(Vt.test(e.url)?"url":"string"==typeof e.data&&0===(e.contentType||"").indexOf("application/x-www-form-urlencoded")&&Vt.test(e.data)&&"data");if(a||"jsonp"===e.dataTypes[0])return r=e.jsonpCallback=m(e.jsonpCallback)?e.jsonpCallback():e.jsonpCallback,a?e[a]=e[a].replace(Vt,"$1"+r):!1!==e.jsonp&&(e.url+=(Et.test(e.url)?"&":"?")+e.jsonp+"="+r),e.converters["script json"]=function(){return o||S.error(r+" was not called"),o[0]},e.dataTypes[0]="json",i=C[r],C[r]=function(){o=arguments},n.always(function(){void 0===i?S(C).removeProp(r):C[r]=i,e[r]&&(e.jsonpCallback=t.jsonpCallback,Xt.push(r)),o&&m(i)&&i(o[0]),o=i=void 0}),"script"}),y.createHTMLDocument=((Ut=E.implementation.createHTMLDocument("").body).innerHTML="<form></form><form></form>",2===Ut.childNodes.length),S.parseHTML=function(e,t,n){return"string"!=typeof e?[]:("boolean"==typeof t&&(n=t,t=!1),t||(y.createHTMLDocument?((r=(t=E.implementation.createHTMLDocument("")).createElement("base")).href=E.location.href,t.head.appendChild(r)):t=E),o=!n&&[],(i=N.exec(e))?[t.createElement(i[1])]:(i=xe([e],t,o),o&&o.length&&S(o).remove(),S.merge([],i.childNodes)));var r,i,o},S.fn.load=function(e,t,n){var r,i,o,a=this,s=e.indexOf(" ");return-1<s&&(r=vt(e.slice(s)),e=e.slice(0,s)),m(t)?(n=t,t=void 0):t&&"object"==typeof t&&(i="POST"),0<a.length&&S.ajax({url:e,type:i||"GET",dataType:"html",data:t}).done(function(e){o=arguments,a.html(r?S("<div>").append(S.parseHTML(e)).find(r):e)}).always(n&&function(e,t){a.each(function(){n.apply(this,o||[e.responseText,t,e])})}),this},S.expr.pseudos.animated=function(t){return S.grep(S.timers,function(e){return t===e.elem}).length},S.offset={setOffset:function(e,t,n){var r,i,o,a,s,u,l=S.css(e,"position"),c=S(e),f={};"static"===l&&(e.style.position="relative"),s=c.offset(),o=S.css(e,"top"),u=S.css(e,"left"),("absolute"===l||"fixed"===l)&&-1<(o+u).indexOf("auto")?(a=(r=c.position()).top,i=r.left):(a=parseFloat(o)||0,i=parseFloat(u)||0),m(t)&&(t=t.call(e,n,S.extend({},s))),null!=t.top&&(f.top=t.top-s.top+a),null!=t.left&&(f.left=t.left-s.left+i),"using"in t?t.using.call(e,f):("number"==typeof f.top&&(f.top+="px"),"number"==typeof f.left&&(f.left+="px"),c.css(f))}},S.fn.extend({offset:function(t){if(arguments.length)return void 0===t?this:this.each(function(e){S.offset.setOffset(this,t,e)});var e,n,r=this[0];return r?r.getClientRects().length?(e=r.getBoundingClientRect(),n=r.ownerDocument.defaultView,{top:e.top+n.pageYOffset,left:e.left+n.pageXOffset}):{top:0,left:0}:void 0},position:function(){if(this[0]){var e,t,n,r=this[0],i={top:0,left:0};if("fixed"===S.css(r,"position"))t=r.getBoundingClientRect();else{t=this.offset(),n=r.ownerDocument,e=r.offsetParent||n.documentElement;while(e&&(e===n.body||e===n.documentElement)&&"static"===S.css(e,"position"))e=e.parentNode;e&&e!==r&&1===e.nodeType&&((i=S(e).offset()).top+=S.css(e,"borderTopWidth",!0),i.left+=S.css(e,"borderLeftWidth",!0))}return{top:t.top-i.top-S.css(r,"marginTop",!0),left:t.left-i.left-S.css(r,"marginLeft",!0)}}},offsetParent:function(){return this.map(function(){var e=this.offsetParent;while(e&&"static"===S.css(e,"position"))e=e.offsetParent;return e||re})}}),S.each({scrollLeft:"pageXOffset",scrollTop:"pageYOffset"},function(t,i){var o="pageYOffset"===i;S.fn[t]=function(e){return $(this,function(e,t,n){var r;if(x(e)?r=e:9===e.nodeType&&(r=e.defaultView),void 0===n)return r?r[i]:e[t];r?r.scrollTo(o?r.pageXOffset:n,o?n:r.pageYOffset):e[t]=n},t,e,arguments.length)}}),S.each(["top","left"],function(e,n){S.cssHooks[n]=$e(y.pixelPosition,function(e,t){if(t)return t=Be(e,n),Me.test(t)?S(e).position()[n]+"px":t})}),S.each({Height:"height",Width:"width"},function(a,s){S.each({padding:"inner"+a,content:s,"":"outer"+a},function(r,o){S.fn[o]=function(e,t){var n=arguments.length&&(r||"boolean"!=typeof e),i=r||(!0===e||!0===t?"margin":"border");return $(this,function(e,t,n){var r;return x(e)?0===o.indexOf("outer")?e["inner"+a]:e.document.documentElement["client"+a]:9===e.nodeType?(r=e.documentElement,Math.max(e.body["scroll"+a],r["scroll"+a],e.body["offset"+a],r["offset"+a],r["client"+a])):void 0===n?S.css(e,t,i):S.style(e,t,n,i)},s,n?e:void 0,n)}})}),S.each(["ajaxStart","ajaxStop","ajaxComplete","ajaxError","ajaxSuccess","ajaxSend"],function(e,t){S.fn[t]=function(e){return this.on(t,e)}}),S.fn.extend({bind:function(e,t,n){return this.on(e,null,t,n)},unbind:function(e,t){return this.off(e,null,t)},delegate:function(e,t,n,r){return this.on(t,e,n,r)},undelegate:function(e,t,n){return 1===arguments.length?this.off(e,"**"):this.off(t,e||"**",n)},hover:function(e,t){return this.mouseenter(e).mouseleave(t||e)}}),S.each("blur focus focusin focusout resize scroll click dblclick mousedown mouseup mousemove mouseover mouseout mouseenter mouseleave change select submit keydown keypress keyup contextmenu".split(" "),function(e,n){S.fn[n]=function(e,t){return 0<arguments.length?this.on(n,null,e,t):this.trigger(n)}});var Gt=/^[\\s\\uFEFF\\xA0]+|[\\s\\uFEFF\\xA0]+$/g;S.proxy=function(e,t){var n,r,i;if("string"==typeof t&&(n=e[t],t=e,e=n),m(e))return r=s.call(arguments,2),(i=function(){return e.apply(t||this,r.concat(s.call(arguments)))}).guid=e.guid=e.guid||S.guid++,i},S.holdReady=function(e){e?S.readyWait++:S.ready(!0)},S.isArray=Array.isArray,S.parseJSON=JSON.parse,S.nodeName=A,S.isFunction=m,S.isWindow=x,S.camelCase=X,S.type=w,S.now=Date.now,S.isNumeric=function(e){var t=S.type(e);return("number"===t||"string"===t)&&!isNaN(e-parseFloat(e))},S.trim=function(e){return null==e?"":(e+"").replace(Gt,"")},"function"==typeof define&&define.amd&&define("jquery",[],function(){return S});var Yt=C.jQuery,Qt=C.$;return S.noConflict=function(e){return C.$===S&&(C.$=Qt),e&&C.jQuery===S&&(C.jQuery=Yt),S},"undefined"==typeof e&&(C.jQuery=C.$=S),S});\r
`;

// src/render/jquery-shim.ts
function jqueryShim() {
  return "<script>" + jquery_3_5_1_min_default + "</script>";
}
var JQUERY_CDN_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*["'][^"']*\b(?:code\.jquery\.com|cdnjs\.cloudflare\.com|unpkg\.com|cdn\.jsdelivr\.net)\/[^"']*\bjquery[^"']*["'][^>]*>\s*<\/script>/gi;
function stripCdnJQuery(html) {
  if (html.indexOf("jquery") === -1)
    return html;
  return html.replace(JQUERY_CDN_SCRIPT_RE, "");
}

// src/vendor/lodash-4.18.1.min.js
var lodash_4_18_1_min_default = `/**
 * @license
 * Lodash lodash.com/license | Underscore.js 1.8.3 underscorejs.org/LICENSE
 */
;(function(){function n(n,t,r){switch(r.length){case 0:return n.call(t);case 1:return n.call(t,r[0]);case 2:return n.call(t,r[0],r[1]);case 3:return n.call(t,r[0],r[1],r[2])}return n.apply(t,r)}function t(n,t,r,e){for(var u=-1,i=null==n?0:n.length;++u<i;){var o=n[u];t(e,o,r(o),n)}return e}function r(n,t){for(var r=-1,e=null==n?0:n.length;++r<e&&t(n[r],r,n)!==false;);return n}function e(n,t){for(var r=null==n?0:n.length;r--&&t(n[r],r,n)!==false;);return n}function u(n,t){for(var r=-1,e=null==n?0:n.length;++r<e;)if(!t(n[r],r,n))return false;
return true}function i(n,t){for(var r=-1,e=null==n?0:n.length,u=0,i=[];++r<e;){var o=n[r];t(o,r,n)&&(i[u++]=o)}return i}function o(n,t){return!!(null==n?0:n.length)&&y(n,t,0)>-1}function f(n,t,r){for(var e=-1,u=null==n?0:n.length;++e<u;)if(r(t,n[e]))return true;return false}function c(n,t){for(var r=-1,e=null==n?0:n.length,u=Array(e);++r<e;)u[r]=t(n[r],r,n);return u}function a(n,t){for(var r=-1,e=t.length,u=n.length;++r<e;)n[u+r]=t[r];return n}function l(n,t,r,e){var u=-1,i=null==n?0:n.length;for(e&&i&&(r=n[++u]);++u<i;)r=t(r,n[u],u,n);
return r}function s(n,t,r,e){var u=null==n?0:n.length;for(e&&u&&(r=n[--u]);u--;)r=t(r,n[u],u,n);return r}function h(n,t){for(var r=-1,e=null==n?0:n.length;++r<e;)if(t(n[r],r,n))return true;return false}function p(n){return n.split("")}function _(n){return n.match(Dt)||[]}function v(n,t,r){var e;return r(n,function(n,r,u){if(t(n,r,u))return e=r,false}),e}function g(n,t,r,e){for(var u=n.length,i=r+(e?1:-1);e?i--:++i<u;)if(t(n[i],i,n))return i;return-1}function y(n,t,r){return t===t?Z(n,t,r):g(n,b,r)}function d(n,t,r,e){
for(var u=r-1,i=n.length;++u<i;)if(e(n[u],t))return u;return-1}function b(n){return n!==n}function w(n,t){var r=null==n?0:n.length;return r?k(n,t)/r:Un}function m(n){return function(t){return null==t?X:t[n]}}function x(n){return function(t){return null==n?X:n[t]}}function j(n,t,r,e,u){return u(n,function(n,u,i){r=e?(e=false,n):t(r,n,u,i)}),r}function A(n,t){var r=n.length;for(n.sort(t);r--;)n[r]=n[r].c;return n}function k(n,t){for(var r,e=-1,u=n.length;++e<u;){var i=t(n[e]);i!==X&&(r=r===X?i:r+i)}return r;
}function I(n,t){for(var r=-1,e=Array(n);++r<n;)e[r]=t(r);return e}function O(n,t){return c(t,function(t){return[t,n[t]]})}function R(n){return n?n.slice(0,H(n)+1).replace(Ct,""):n}function z(n){return function(t){return n(t)}}function E(n,t){return c(t,function(t){return n[t]})}function S(n,t){return n.has(t)}function W(n,t){for(var r=-1,e=n.length;++r<e&&y(t,n[r],0)>-1;);return r}function L(n,t){for(var r=n.length;r--&&y(t,n[r],0)>-1;);return r}function C(n,t){for(var r=n.length,e=0;r--;)n[r]===t&&++e;
return e}function U(n){return"\\\\"+Yr[n]}function B(n,t){return null==n?X:n[t]}function T(n){return Pr.test(n)}function $(n){return qr.test(n)}function D(n){for(var t,r=[];!(t=n.next()).done;)r.push(t.value);return r}function M(n){var t=-1,r=Array(n.size);return n.forEach(function(n,e){r[++t]=[e,n]}),r}function F(n,t){return function(r){return n(t(r))}}function N(n,t){for(var r=-1,e=n.length,u=0,i=[];++r<e;){var o=n[r];o!==t&&o!==an||(n[r]=an,i[u++]=r)}return i}function P(n){var t=-1,r=Array(n.size);
return n.forEach(function(n){r[++t]=n}),r}function q(n){var t=-1,r=Array(n.size);return n.forEach(function(n){r[++t]=[n,n]}),r}function Z(n,t,r){for(var e=r-1,u=n.length;++e<u;)if(n[e]===t)return e;return-1}function K(n,t,r){for(var e=r+1;e--;)if(n[e]===t)return e;return e}function V(n){return T(n)?J(n):_e(n)}function G(n){return T(n)?Y(n):p(n)}function H(n){for(var t=n.length;t--&&Ut.test(n.charAt(t)););return t}function J(n){for(var t=Fr.lastIndex=0;Fr.test(n);)++t;return t}function Y(n){return n.match(Fr)||[];
}function Q(n){return n.match(Nr)||[]}var X,nn="4.18.1",tn=200,rn="Unsupported core-js use. Try https://npms.io/search?q=ponyfill.",en="Expected a function",un="Invalid \`variable\` option passed into \`_.template\`",on="Invalid \`imports\` option passed into \`_.template\`",fn="__lodash_hash_undefined__",cn=500,an="__lodash_placeholder__",ln=1,sn=2,hn=4,pn=1,_n=2,vn=1,gn=2,yn=4,dn=8,bn=16,wn=32,mn=64,xn=128,jn=256,An=512,kn=30,In="...",On=800,Rn=16,zn=1,En=2,Sn=3,Wn=1/0,Ln=9007199254740991,Cn=1.7976931348623157e308,Un=NaN,Bn=4294967295,Tn=Bn-1,$n=Bn>>>1,Dn=[["ary",xn],["bind",vn],["bindKey",gn],["curry",dn],["curryRight",bn],["flip",An],["partial",wn],["partialRight",mn],["rearg",jn]],Mn="[object Arguments]",Fn="[object Array]",Nn="[object AsyncFunction]",Pn="[object Boolean]",qn="[object Date]",Zn="[object DOMException]",Kn="[object Error]",Vn="[object Function]",Gn="[object GeneratorFunction]",Hn="[object Map]",Jn="[object Number]",Yn="[object Null]",Qn="[object Object]",Xn="[object Promise]",nt="[object Proxy]",tt="[object RegExp]",rt="[object Set]",et="[object String]",ut="[object Symbol]",it="[object Undefined]",ot="[object WeakMap]",ft="[object WeakSet]",ct="[object ArrayBuffer]",at="[object DataView]",lt="[object Float32Array]",st="[object Float64Array]",ht="[object Int8Array]",pt="[object Int16Array]",_t="[object Int32Array]",vt="[object Uint8Array]",gt="[object Uint8ClampedArray]",yt="[object Uint16Array]",dt="[object Uint32Array]",bt=/\\b__p\\+='';/g,wt=/\\b(__p\\+=)''\\+/g,mt=/(__e\\(.*?\\)|\\b__t\\))\\+'';/g,xt=/&(?:amp|lt|gt|quot|#39);/g,jt=/[&<>"']/g,At=RegExp(xt.source),kt=RegExp(jt.source),It=/<%-([\\s\\S]+?)%>/g,Ot=/<%([\\s\\S]+?)%>/g,Rt=/<%=([\\s\\S]+?)%>/g,zt=/\\.|\\[(?:[^[\\]]*|(["'])(?:(?!\\1)[^\\\\]|\\\\.)*?\\1)\\]/,Et=/^\\w*$/,St=/[^.[\\]]+|\\[(?:(-?\\d+(?:\\.\\d+)?)|(["'])((?:(?!\\2)[^\\\\]|\\\\.)*?)\\2)\\]|(?=(?:\\.|\\[\\])(?:\\.|\\[\\]|$))/g,Wt=/[\\\\^$.*+?()[\\]{}|]/g,Lt=RegExp(Wt.source),Ct=/^\\s+/,Ut=/\\s/,Bt=/\\{(?:\\n\\/\\* \\[wrapped with .+\\] \\*\\/)?\\n?/,Tt=/\\{\\n\\/\\* \\[wrapped with (.+)\\] \\*/,$t=/,? & /,Dt=/[^\\x00-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7f]+/g,Mt=/[()=,{}\\[\\]\\/\\s]/,Ft=/\\\\(\\\\)?/g,Nt=/\\$\\{([^\\\\}]*(?:\\\\.[^\\\\}]*)*)\\}/g,Pt=/\\w*$/,qt=/^[-+]0x[0-9a-f]+$/i,Zt=/^0b[01]+$/i,Kt=/^\\[object .+?Constructor\\]$/,Vt=/^0o[0-7]+$/i,Gt=/^(?:0|[1-9]\\d*)$/,Ht=/[\\xc0-\\xd6\\xd8-\\xf6\\xf8-\\xff\\u0100-\\u017f]/g,Jt=/($^)/,Yt=/['\\n\\r\\u2028\\u2029\\\\]/g,Qt="\\\\ud800-\\\\udfff",Xt="\\\\u0300-\\\\u036f",nr="\\\\ufe20-\\\\ufe2f",tr="\\\\u20d0-\\\\u20ff",rr=Xt+nr+tr,er="\\\\u2700-\\\\u27bf",ur="a-z\\\\xdf-\\\\xf6\\\\xf8-\\\\xff",ir="\\\\xac\\\\xb1\\\\xd7\\\\xf7",or="\\\\x00-\\\\x2f\\\\x3a-\\\\x40\\\\x5b-\\\\x60\\\\x7b-\\\\xbf",fr="\\\\u2000-\\\\u206f",cr=" \\\\t\\\\x0b\\\\f\\\\xa0\\\\ufeff\\\\n\\\\r\\\\u2028\\\\u2029\\\\u1680\\\\u180e\\\\u2000\\\\u2001\\\\u2002\\\\u2003\\\\u2004\\\\u2005\\\\u2006\\\\u2007\\\\u2008\\\\u2009\\\\u200a\\\\u202f\\\\u205f\\\\u3000",ar="A-Z\\\\xc0-\\\\xd6\\\\xd8-\\\\xde",lr="\\\\ufe0e\\\\ufe0f",sr=ir+or+fr+cr,hr="['\\u2019]",pr="["+Qt+"]",_r="["+sr+"]",vr="["+rr+"]",gr="\\\\d+",yr="["+er+"]",dr="["+ur+"]",br="[^"+Qt+sr+gr+er+ur+ar+"]",wr="\\\\ud83c[\\\\udffb-\\\\udfff]",mr="(?:"+vr+"|"+wr+")",xr="[^"+Qt+"]",jr="(?:\\\\ud83c[\\\\udde6-\\\\uddff]){2}",Ar="[\\\\ud800-\\\\udbff][\\\\udc00-\\\\udfff]",kr="["+ar+"]",Ir="\\\\u200d",Or="(?:"+dr+"|"+br+")",Rr="(?:"+kr+"|"+br+")",zr="(?:"+hr+"(?:d|ll|m|re|s|t|ve))?",Er="(?:"+hr+"(?:D|LL|M|RE|S|T|VE))?",Sr=mr+"?",Wr="["+lr+"]?",Lr="(?:"+Ir+"(?:"+[xr,jr,Ar].join("|")+")"+Wr+Sr+")*",Cr="\\\\d*(?:1st|2nd|3rd|(?![123])\\\\dth)(?=\\\\b|[A-Z_])",Ur="\\\\d*(?:1ST|2ND|3RD|(?![123])\\\\dTH)(?=\\\\b|[a-z_])",Br=Wr+Sr+Lr,Tr="(?:"+[yr,jr,Ar].join("|")+")"+Br,$r="(?:"+[xr+vr+"?",vr,jr,Ar,pr].join("|")+")",Dr=RegExp(hr,"g"),Mr=RegExp(vr,"g"),Fr=RegExp(wr+"(?="+wr+")|"+$r+Br,"g"),Nr=RegExp([kr+"?"+dr+"+"+zr+"(?="+[_r,kr,"$"].join("|")+")",Rr+"+"+Er+"(?="+[_r,kr+Or,"$"].join("|")+")",kr+"?"+Or+"+"+zr,kr+"+"+Er,Ur,Cr,gr,Tr].join("|"),"g"),Pr=RegExp("["+Ir+Qt+rr+lr+"]"),qr=/[a-z][A-Z]|[A-Z]{2}[a-z]|[0-9][a-zA-Z]|[a-zA-Z][0-9]|[^a-zA-Z0-9 ]/,Zr=["Array","Buffer","DataView","Date","Error","Float32Array","Float64Array","Function","Int8Array","Int16Array","Int32Array","Map","Math","Object","Promise","RegExp","Set","String","Symbol","TypeError","Uint8Array","Uint8ClampedArray","Uint16Array","Uint32Array","WeakMap","_","clearTimeout","isFinite","parseInt","setTimeout"],Kr={};
Kr[lt]=Kr[st]=Kr[ht]=Kr[pt]=Kr[_t]=Kr[vt]=Kr[gt]=Kr[yt]=Kr[dt]=true,Kr[Mn]=Kr[Fn]=Kr[ct]=Kr[Pn]=Kr[at]=Kr[qn]=Kr[Kn]=Kr[Vn]=Kr[Hn]=Kr[Jn]=Kr[Qn]=Kr[tt]=Kr[rt]=Kr[et]=Kr[ot]=false;var Vr={};Vr[Mn]=Vr[Fn]=Vr[ct]=Vr[at]=Vr[Pn]=Vr[qn]=Vr[lt]=Vr[st]=Vr[ht]=Vr[pt]=Vr[_t]=Vr[Hn]=Vr[Jn]=Vr[Qn]=Vr[tt]=Vr[rt]=Vr[et]=Vr[ut]=Vr[vt]=Vr[gt]=Vr[yt]=Vr[dt]=true,Vr[Kn]=Vr[Vn]=Vr[ot]=false;var Gr={"\\xc0":"A","\\xc1":"A","\\xc2":"A","\\xc3":"A","\\xc4":"A","\\xc5":"A","\\xe0":"a","\\xe1":"a","\\xe2":"a","\\xe3":"a","\\xe4":"a","\\xe5":"a",
"\\xc7":"C","\\xe7":"c","\\xd0":"D","\\xf0":"d","\\xc8":"E","\\xc9":"E","\\xca":"E","\\xcb":"E","\\xe8":"e","\\xe9":"e","\\xea":"e","\\xeb":"e","\\xcc":"I","\\xcd":"I","\\xce":"I","\\xcf":"I","\\xec":"i","\\xed":"i","\\xee":"i","\\xef":"i","\\xd1":"N","\\xf1":"n","\\xd2":"O","\\xd3":"O","\\xd4":"O","\\xd5":"O","\\xd6":"O","\\xd8":"O","\\xf2":"o","\\xf3":"o","\\xf4":"o","\\xf5":"o","\\xf6":"o","\\xf8":"o","\\xd9":"U","\\xda":"U","\\xdb":"U","\\xdc":"U","\\xf9":"u","\\xfa":"u","\\xfb":"u","\\xfc":"u","\\xdd":"Y","\\xfd":"y","\\xff":"y","\\xc6":"Ae",
"\\xe6":"ae","\\xde":"Th","\\xfe":"th","\\xdf":"ss","\\u0100":"A","\\u0102":"A","\\u0104":"A","\\u0101":"a","\\u0103":"a","\\u0105":"a","\\u0106":"C","\\u0108":"C","\\u010a":"C","\\u010c":"C","\\u0107":"c","\\u0109":"c","\\u010b":"c","\\u010d":"c","\\u010e":"D","\\u0110":"D","\\u010f":"d","\\u0111":"d","\\u0112":"E","\\u0114":"E","\\u0116":"E","\\u0118":"E","\\u011a":"E","\\u0113":"e","\\u0115":"e","\\u0117":"e","\\u0119":"e","\\u011b":"e","\\u011c":"G","\\u011e":"G","\\u0120":"G","\\u0122":"G","\\u011d":"g","\\u011f":"g","\\u0121":"g",
"\\u0123":"g","\\u0124":"H","\\u0126":"H","\\u0125":"h","\\u0127":"h","\\u0128":"I","\\u012a":"I","\\u012c":"I","\\u012e":"I","\\u0130":"I","\\u0129":"i","\\u012b":"i","\\u012d":"i","\\u012f":"i","\\u0131":"i","\\u0134":"J","\\u0135":"j","\\u0136":"K","\\u0137":"k","\\u0138":"k","\\u0139":"L","\\u013b":"L","\\u013d":"L","\\u013f":"L","\\u0141":"L","\\u013a":"l","\\u013c":"l","\\u013e":"l","\\u0140":"l","\\u0142":"l","\\u0143":"N","\\u0145":"N","\\u0147":"N","\\u014a":"N","\\u0144":"n","\\u0146":"n","\\u0148":"n","\\u014b":"n","\\u014c":"O",
"\\u014e":"O","\\u0150":"O","\\u014d":"o","\\u014f":"o","\\u0151":"o","\\u0154":"R","\\u0156":"R","\\u0158":"R","\\u0155":"r","\\u0157":"r","\\u0159":"r","\\u015a":"S","\\u015c":"S","\\u015e":"S","\\u0160":"S","\\u015b":"s","\\u015d":"s","\\u015f":"s","\\u0161":"s","\\u0162":"T","\\u0164":"T","\\u0166":"T","\\u0163":"t","\\u0165":"t","\\u0167":"t","\\u0168":"U","\\u016a":"U","\\u016c":"U","\\u016e":"U","\\u0170":"U","\\u0172":"U","\\u0169":"u","\\u016b":"u","\\u016d":"u","\\u016f":"u","\\u0171":"u","\\u0173":"u","\\u0174":"W","\\u0175":"w",
"\\u0176":"Y","\\u0177":"y","\\u0178":"Y","\\u0179":"Z","\\u017b":"Z","\\u017d":"Z","\\u017a":"z","\\u017c":"z","\\u017e":"z","\\u0132":"IJ","\\u0133":"ij","\\u0152":"Oe","\\u0153":"oe","\\u0149":"'n","\\u017f":"s"},Hr={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"},Jr={"&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&#39;":"'"},Yr={"\\\\":"\\\\","'":"'","\\n":"n","\\r":"r","\\u2028":"u2028","\\u2029":"u2029"},Qr=parseFloat,Xr=parseInt,ne=typeof global=="object"&&global&&global.Object===Object&&global,te=typeof self=="object"&&self&&self.Object===Object&&self,re=ne||te||Function("return this")(),ee=typeof exports=="object"&&exports&&!exports.nodeType&&exports,ue=ee&&typeof module=="object"&&module&&!module.nodeType&&module,ie=ue&&ue.exports===ee,oe=ie&&ne.process,fe=function(){
try{var n=ue&&ue.require&&ue.require("util").types;return n?n:oe&&oe.binding&&oe.binding("util")}catch(n){}}(),ce=fe&&fe.isArrayBuffer,ae=fe&&fe.isDate,le=fe&&fe.isMap,se=fe&&fe.isRegExp,he=fe&&fe.isSet,pe=fe&&fe.isTypedArray,_e=m("length"),ve=x(Gr),ge=x(Hr),ye=x(Jr),de=function p(x){function Z(n){if(cc(n)&&!bh(n)&&!(n instanceof Ut)){if(n instanceof Y)return n;if(bl.call(n,"__wrapped__"))return eo(n)}return new Y(n)}function J(){}function Y(n,t){this.__wrapped__=n,this.__actions__=[],this.__chain__=!!t,
this.__index__=0,this.__values__=X}function Ut(n){this.__wrapped__=n,this.__actions__=[],this.__dir__=1,this.__filtered__=false,this.__iteratees__=[],this.__takeCount__=Bn,this.__views__=[]}function Dt(){var n=new Ut(this.__wrapped__);return n.__actions__=Tu(this.__actions__),n.__dir__=this.__dir__,n.__filtered__=this.__filtered__,n.__iteratees__=Tu(this.__iteratees__),n.__takeCount__=this.__takeCount__,n.__views__=Tu(this.__views__),n}function Qt(){if(this.__filtered__){var n=new Ut(this);n.__dir__=-1,
n.__filtered__=true}else n=this.clone(),n.__dir__*=-1;return n}function Xt(){var n=this.__wrapped__.value(),t=this.__dir__,r=bh(n),e=t<0,u=r?n.length:0,i=Ii(0,u,this.__views__),o=i.start,f=i.end,c=f-o,a=e?f:o-1,l=this.__iteratees__,s=l.length,h=0,p=Hl(c,this.__takeCount__);if(!r||!e&&u==c&&p==c)return wu(n,this.__actions__);var _=[];n:for(;c--&&h<p;){a+=t;for(var v=-1,g=n[a];++v<s;){var y=l[v],d=y.iteratee,b=y.type,w=d(g);if(b==En)g=w;else if(!w){if(b==zn)continue n;break n}}_[h++]=g}return _}function nr(n){
var t=-1,r=null==n?0:n.length;for(this.clear();++t<r;){var e=n[t];this.set(e[0],e[1])}}function tr(){this.__data__=is?is(null):{},this.size=0}function rr(n){var t=this.has(n)&&delete this.__data__[n];return this.size-=t?1:0,t}function er(n){var t=this.__data__;if(is){var r=t[n];return r===fn?X:r}return bl.call(t,n)?t[n]:X}function ur(n){var t=this.__data__;return is?t[n]!==X:bl.call(t,n)}function ir(n,t){var r=this.__data__;return this.size+=this.has(n)?0:1,r[n]=is&&t===X?fn:t,this}function or(n){
var t=-1,r=null==n?0:n.length;for(this.clear();++t<r;){var e=n[t];this.set(e[0],e[1])}}function fr(){this.__data__=[],this.size=0}function cr(n){var t=this.__data__,r=Lr(t,n);return!(r<0)&&(r==t.length-1?t.pop():Ll.call(t,r,1),--this.size,true)}function ar(n){var t=this.__data__,r=Lr(t,n);return r<0?X:t[r][1]}function lr(n){return Lr(this.__data__,n)>-1}function sr(n,t){var r=this.__data__,e=Lr(r,n);return e<0?(++this.size,r.push([n,t])):r[e][1]=t,this}function hr(n){var t=-1,r=null==n?0:n.length;for(this.clear();++t<r;){
var e=n[t];this.set(e[0],e[1])}}function pr(){this.size=0,this.__data__={hash:new nr,map:new(ts||or),string:new nr}}function _r(n){var t=xi(this,n).delete(n);return this.size-=t?1:0,t}function vr(n){return xi(this,n).get(n)}function gr(n){return xi(this,n).has(n)}function yr(n,t){var r=xi(this,n),e=r.size;return r.set(n,t),this.size+=r.size==e?0:1,this}function dr(n){var t=-1,r=null==n?0:n.length;for(this.__data__=new hr;++t<r;)this.add(n[t])}function br(n){return this.__data__.set(n,fn),this}function wr(n){
return this.__data__.has(n)}function mr(n){this.size=(this.__data__=new or(n)).size}function xr(){this.__data__=new or,this.size=0}function jr(n){var t=this.__data__,r=t.delete(n);return this.size=t.size,r}function Ar(n){return this.__data__.get(n)}function kr(n){return this.__data__.has(n)}function Ir(n,t){var r=this.__data__;if(r instanceof or){var e=r.__data__;if(!ts||e.length<tn-1)return e.push([n,t]),this.size=++r.size,this;r=this.__data__=new hr(e)}return r.set(n,t),this.size=r.size,this}function Or(n,t){
var r=bh(n),e=!r&&dh(n),u=!r&&!e&&mh(n),i=!r&&!e&&!u&&Ih(n),o=r||e||u||i,f=o?I(n.length,hl):[],c=f.length;for(var a in n)!t&&!bl.call(n,a)||o&&("length"==a||u&&("offset"==a||"parent"==a)||i&&("buffer"==a||"byteLength"==a||"byteOffset"==a)||Ci(a,c))||f.push(a);return f}function Rr(n){var t=n.length;return t?n[tu(0,t-1)]:X}function zr(n,t){return Xi(Tu(n),Fr(t,0,n.length))}function Er(n){return Xi(Tu(n))}function Sr(n,t,r){(r===X||Gf(n[t],r))&&(r!==X||t in n)||Tr(n,t,r)}function Wr(n,t,r){var e=n[t];
bl.call(n,t)&&Gf(e,r)&&(r!==X||t in n)||Tr(n,t,r)}function Lr(n,t){for(var r=n.length;r--;)if(Gf(n[r][0],t))return r;return-1}function Cr(n,t,r,e){return ys(n,function(n,u,i){t(e,n,r(n),i)}),e}function Ur(n,t){return n&&$u(t,Pc(t),n)}function Br(n,t){return n&&$u(t,qc(t),n)}function Tr(n,t,r){"__proto__"==t&&Tl?Tl(n,t,{configurable:true,enumerable:true,value:r,writable:true}):n[t]=r}function $r(n,t){for(var r=-1,e=t.length,u=il(e),i=null==n;++r<e;)u[r]=i?X:Mc(n,t[r]);return u}function Fr(n,t,r){return n===n&&(r!==X&&(n=n<=r?n:r),
t!==X&&(n=n>=t?n:t)),n}function Nr(n,t,e,u,i,o){var f,c=t&ln,a=t&sn,l=t&hn;if(e&&(f=i?e(n,u,i,o):e(n)),f!==X)return f;if(!fc(n))return n;var s=bh(n);if(s){if(f=zi(n),!c)return Tu(n,f)}else{var h=zs(n),p=h==Vn||h==Gn;if(mh(n))return Ou(n,c);if(h==Qn||h==Mn||p&&!i){if(f=a||p?{}:Ei(n),!c)return a?Mu(n,Br(f,n)):Du(n,Ur(f,n))}else{if(!Vr[h])return i?n:{};f=Si(n,h,c)}}o||(o=new mr);var _=o.get(n);if(_)return _;o.set(n,f),kh(n)?n.forEach(function(r){f.add(Nr(r,t,e,r,n,o))}):jh(n)&&n.forEach(function(r,u){
f.set(u,Nr(r,t,e,u,n,o))});var v=l?a?di:yi:a?qc:Pc,g=s?X:v(n);return r(g||n,function(r,u){g&&(u=r,r=n[u]),Wr(f,u,Nr(r,t,e,u,n,o))}),f}function Pr(n){var t=Pc(n);return function(r){return qr(r,n,t)}}function qr(n,t,r){var e=r.length;if(null==n)return!e;for(n=ll(n);e--;){var u=r[e],i=t[u],o=n[u];if(o===X&&!(u in n)||!i(o))return false}return true}function Gr(n,t,r){if(typeof n!="function")throw new pl(en);return Ws(function(){n.apply(X,r)},t)}function Hr(n,t,r,e){var u=-1,i=o,a=true,l=n.length,s=[],h=t.length;
if(!l)return s;r&&(t=c(t,z(r))),e?(i=f,a=false):t.length>=tn&&(i=S,a=false,t=new dr(t));n:for(;++u<l;){var p=n[u],_=null==r?p:r(p);if(p=e||0!==p?p:0,a&&_===_){for(var v=h;v--;)if(t[v]===_)continue n;s.push(p)}else i(t,_,e)||s.push(p)}return s}function Jr(n,t){var r=true;return ys(n,function(n,e,u){return r=!!t(n,e,u)}),r}function Yr(n,t,r){for(var e=-1,u=n.length;++e<u;){var i=n[e],o=t(i);if(null!=o&&(f===X?o===o&&!bc(o):r(o,f)))var f=o,c=i}return c}function ne(n,t,r,e){var u=n.length;for(r=kc(r),r<0&&(r=-r>u?0:u+r),
e=e===X||e>u?u:kc(e),e<0&&(e+=u),e=r>e?0:Ic(e);r<e;)n[r++]=t;return n}function te(n,t){var r=[];return ys(n,function(n,e,u){t(n,e,u)&&r.push(n)}),r}function ee(n,t,r,e,u){var i=-1,o=n.length;for(r||(r=Li),u||(u=[]);++i<o;){var f=n[i];t>0&&r(f)?t>1?ee(f,t-1,r,e,u):a(u,f):e||(u[u.length]=f)}return u}function ue(n,t){return n&&bs(n,t,Pc)}function oe(n,t){return n&&ws(n,t,Pc)}function fe(n,t){return i(t,function(t){return uc(n[t])})}function _e(n,t){t=ku(t,n);for(var r=0,e=t.length;null!=n&&r<e;)n=n[no(t[r++])];
return r&&r==e?n:X}function de(n,t,r){var e=t(n);return bh(n)?e:a(e,r(n))}function we(n){return null==n?n===X?it:Yn:Bl&&Bl in ll(n)?ki(n):Ki(n)}function me(n,t){return n>t}function xe(n,t){return null!=n&&bl.call(n,t)}function je(n,t){return null!=n&&t in ll(n)}function Ae(n,t,r){return n>=Hl(t,r)&&n<Gl(t,r)}function ke(n,t,r){for(var e=r?f:o,u=n[0].length,i=n.length,a=i,l=il(i),s=1/0,h=[];a--;){var p=n[a];a&&t&&(p=c(p,z(t))),s=Hl(p.length,s),l[a]=!r&&(t||u>=120&&p.length>=120)?new dr(a&&p):X}p=n[0];
var _=-1,v=l[0];n:for(;++_<u&&h.length<s;){var g=p[_],y=t?t(g):g;if(g=r||0!==g?g:0,!(v?S(v,y):e(h,y,r))){for(a=i;--a;){var d=l[a];if(!(d?S(d,y):e(n[a],y,r)))continue n}v&&v.push(y),h.push(g)}}return h}function Ie(n,t,r,e){return ue(n,function(n,u,i){t(e,r(n),u,i)}),e}function Oe(t,r,e){r=ku(r,t),t=Gi(t,r);var u=null==t?t:t[no(jo(r))];return null==u?X:n(u,t,e)}function Re(n){return cc(n)&&we(n)==Mn}function ze(n){return cc(n)&&we(n)==ct}function Ee(n){return cc(n)&&we(n)==qn}function Se(n,t,r,e,u){
return n===t||(null==n||null==t||!cc(n)&&!cc(t)?n!==n&&t!==t:We(n,t,r,e,Se,u))}function We(n,t,r,e,u,i){var o=bh(n),f=bh(t),c=o?Fn:zs(n),a=f?Fn:zs(t);c=c==Mn?Qn:c,a=a==Mn?Qn:a;var l=c==Qn,s=a==Qn,h=c==a;if(h&&mh(n)){if(!mh(t))return false;o=true,l=false}if(h&&!l)return i||(i=new mr),o||Ih(n)?pi(n,t,r,e,u,i):_i(n,t,c,r,e,u,i);if(!(r&pn)){var p=l&&bl.call(n,"__wrapped__"),_=s&&bl.call(t,"__wrapped__");if(p||_){var v=p?n.value():n,g=_?t.value():t;return i||(i=new mr),u(v,g,r,e,i)}}return!!h&&(i||(i=new mr),vi(n,t,r,e,u,i));
}function Le(n){return cc(n)&&zs(n)==Hn}function Ce(n,t,r,e){var u=r.length,i=u,o=!e;if(null==n)return!i;for(n=ll(n);u--;){var f=r[u];if(o&&f[2]?f[1]!==n[f[0]]:!(f[0]in n))return false}for(;++u<i;){f=r[u];var c=f[0],a=n[c],l=f[1];if(o&&f[2]){if(a===X&&!(c in n))return false}else{var s=new mr;if(e)var h=e(a,l,c,n,t,s);if(!(h===X?Se(l,a,pn|_n,e,s):h))return false}}return true}function Ue(n){return!(!fc(n)||Di(n))&&(uc(n)?kl:Kt).test(to(n))}function Be(n){return cc(n)&&we(n)==tt}function Te(n){return cc(n)&&zs(n)==rt;
}function $e(n){return cc(n)&&oc(n.length)&&!!Kr[we(n)]}function De(n){return typeof n=="function"?n:null==n?La:typeof n=="object"?bh(n)?Ze(n[0],n[1]):qe(n):Fa(n)}function Me(n){if(!Mi(n))return Vl(n);var t=[];for(var r in ll(n))bl.call(n,r)&&"constructor"!=r&&t.push(r);return t}function Fe(n){if(!fc(n))return Zi(n);var t=Mi(n),r=[];for(var e in n)("constructor"!=e||!t&&bl.call(n,e))&&r.push(e);return r}function Ne(n,t){return n<t}function Pe(n,t){var r=-1,e=Hf(n)?il(n.length):[];return ys(n,function(n,u,i){
e[++r]=t(n,u,i)}),e}function qe(n){var t=ji(n);return 1==t.length&&t[0][2]?Ni(t[0][0],t[0][1]):function(r){return r===n||Ce(r,n,t)}}function Ze(n,t){return Bi(n)&&Fi(t)?Ni(no(n),t):function(r){var e=Mc(r,n);return e===X&&e===t?Nc(r,n):Se(t,e,pn|_n)}}function Ke(n,t,r,e,u){n!==t&&bs(t,function(i,o){if(u||(u=new mr),fc(i))Ve(n,t,o,r,Ke,e,u);else{var f=e?e(Ji(n,o),i,o+"",n,t,u):X;f===X&&(f=i),Sr(n,o,f)}},qc)}function Ve(n,t,r,e,u,i,o){var f=Ji(n,r),c=Ji(t,r),a=o.get(c);if(a)return Sr(n,r,a),X;var l=i?i(f,c,r+"",n,t,o):X,s=l===X;
if(s){var h=bh(c),p=!h&&mh(c),_=!h&&!p&&Ih(c);l=c,h||p||_?bh(f)?l=f:Jf(f)?l=Tu(f):p?(s=false,l=Ou(c,true)):_?(s=false,l=Wu(c,true)):l=[]:gc(c)||dh(c)?(l=f,dh(f)?l=Rc(f):fc(f)&&!uc(f)||(l=Ei(c))):s=false}s&&(o.set(c,l),u(l,c,e,i,o),o.delete(c)),Sr(n,r,l)}function Ge(n,t){var r=n.length;if(r)return t+=t<0?r:0,Ci(t,r)?n[t]:X}function He(n,t,r){t=t.length?c(t,function(n){return bh(n)?function(t){return _e(t,1===n.length?n[0]:n)}:n}):[La];var e=-1;return t=c(t,z(mi())),A(Pe(n,function(n,r,u){return{a:c(t,function(t){
return t(n)}),b:++e,c:n}}),function(n,t){return Cu(n,t,r)})}function Je(n,t){return Ye(n,t,function(t,r){return Nc(n,r)})}function Ye(n,t,r){for(var e=-1,u=t.length,i={};++e<u;){var o=t[e],f=_e(n,o);r(f,o)&&fu(i,ku(o,n),f)}return i}function Qe(n){return function(t){return _e(t,n)}}function Xe(n,t,r,e){var u=e?d:y,i=-1,o=t.length,f=n;for(n===t&&(t=Tu(t)),r&&(f=c(n,z(r)));++i<o;)for(var a=0,l=t[i],s=r?r(l):l;(a=u(f,s,a,e))>-1;)f!==n&&Ll.call(f,a,1),Ll.call(n,a,1);return n}function nu(n,t){for(var r=n?t.length:0,e=r-1;r--;){
var u=t[r];if(r==e||u!==i){var i=u;Ci(u)?Ll.call(n,u,1):yu(n,u)}}return n}function tu(n,t){return n+Nl(Ql()*(t-n+1))}function ru(n,t,r,e){for(var u=-1,i=Gl(Fl((t-n)/(r||1)),0),o=il(i);i--;)o[e?i:++u]=n,n+=r;return o}function eu(n,t){var r="";if(!n||t<1||t>Ln)return r;do t%2&&(r+=n),t=Nl(t/2),t&&(n+=n);while(t);return r}function uu(n,t){return Ls(Vi(n,t,La),n+"")}function iu(n){return Rr(ra(n))}function ou(n,t){var r=ra(n);return Xi(r,Fr(t,0,r.length))}function fu(n,t,r,e){if(!fc(n))return n;t=ku(t,n);
for(var u=-1,i=t.length,o=i-1,f=n;null!=f&&++u<i;){var c=no(t[u]),a=r;if("__proto__"===c||"constructor"===c||"prototype"===c)return n;if(u!=o){var l=f[c];a=e?e(l,c,f):X,a===X&&(a=fc(l)?l:Ci(t[u+1])?[]:{})}Wr(f,c,a),f=f[c]}return n}function cu(n){return Xi(ra(n))}function au(n,t,r){var e=-1,u=n.length;t<0&&(t=-t>u?0:u+t),r=r>u?u:r,r<0&&(r+=u),u=t>r?0:r-t>>>0,t>>>=0;for(var i=il(u);++e<u;)i[e]=n[e+t];return i}function lu(n,t){var r;return ys(n,function(n,e,u){return r=t(n,e,u),!r}),!!r}function su(n,t,r){
var e=0,u=null==n?e:n.length;if(typeof t=="number"&&t===t&&u<=$n){for(;e<u;){var i=e+u>>>1,o=n[i];null!==o&&!bc(o)&&(r?o<=t:o<t)?e=i+1:u=i}return u}return hu(n,t,La,r)}function hu(n,t,r,e){var u=0,i=null==n?0:n.length;if(0===i)return 0;t=r(t);for(var o=t!==t,f=null===t,c=bc(t),a=t===X;u<i;){var l=Nl((u+i)/2),s=r(n[l]),h=s!==X,p=null===s,_=s===s,v=bc(s);if(o)var g=e||_;else g=a?_&&(e||h):f?_&&h&&(e||!p):c?_&&h&&!p&&(e||!v):!p&&!v&&(e?s<=t:s<t);g?u=l+1:i=l}return Hl(i,Tn)}function pu(n,t){for(var r=-1,e=n.length,u=0,i=[];++r<e;){
var o=n[r],f=t?t(o):o;if(!r||!Gf(f,c)){var c=f;i[u++]=0===o?0:o}}return i}function _u(n){return typeof n=="number"?n:bc(n)?Un:+n}function vu(n){if(typeof n=="string")return n;if(bh(n))return c(n,vu)+"";if(bc(n))return vs?vs.call(n):"";var t=n+"";return"0"==t&&1/n==-Wn?"-0":t}function gu(n,t,r){var e=-1,u=o,i=n.length,c=true,a=[],l=a;if(r)c=false,u=f;else if(i>=tn){var s=t?null:ks(n);if(s)return P(s);c=false,u=S,l=new dr}else l=t?[]:a;n:for(;++e<i;){var h=n[e],p=t?t(h):h;if(h=r||0!==h?h:0,c&&p===p){for(var _=l.length;_--;)if(l[_]===p)continue n;
t&&l.push(p),a.push(h)}else u(l,p,r)||(l!==a&&l.push(p),a.push(h))}return a}function yu(n,t){t=ku(t,n);var r=-1,e=t.length;if(!e)return true;for(;++r<e;){var u=no(t[r]);if("__proto__"===u&&!bl.call(n,"__proto__"))return false;if(("constructor"===u||"prototype"===u)&&r<e-1)return false}var i=Gi(n,t);return null==i||delete i[no(jo(t))]}function du(n,t,r,e){return fu(n,t,r(_e(n,t)),e)}function bu(n,t,r,e){for(var u=n.length,i=e?u:-1;(e?i--:++i<u)&&t(n[i],i,n););return r?au(n,e?0:i,e?i+1:u):au(n,e?i+1:0,e?u:i)}
function wu(n,t){var r=n;return r instanceof Ut&&(r=r.value()),l(t,function(n,t){return t.func.apply(t.thisArg,a([n],t.args))},r)}function mu(n,t,r){var e=n.length;if(e<2)return e?gu(n[0]):[];for(var u=-1,i=il(e);++u<e;)for(var o=n[u],f=-1;++f<e;)f!=u&&(i[u]=Hr(i[u]||o,n[f],t,r));return gu(ee(i,1),t,r)}function xu(n,t,r){for(var e=-1,u=n.length,i=t.length,o={};++e<u;){r(o,n[e],e<i?t[e]:X)}return o}function ju(n){return Jf(n)?n:[]}function Au(n){return typeof n=="function"?n:La}function ku(n,t){return bh(n)?n:Bi(n,t)?[n]:Cs(Ec(n));
}function Iu(n,t,r){var e=n.length;return r=r===X?e:r,!t&&r>=e?n:au(n,t,r)}function Ou(n,t){if(t)return n.slice();var r=n.length,e=zl?zl(r):new n.constructor(r);return n.copy(e),e}function Ru(n){var t=new n.constructor(n.byteLength);return new Rl(t).set(new Rl(n)),t}function zu(n,t){return new n.constructor(t?Ru(n.buffer):n.buffer,n.byteOffset,n.byteLength)}function Eu(n){var t=new n.constructor(n.source,Pt.exec(n));return t.lastIndex=n.lastIndex,t}function Su(n){return _s?ll(_s.call(n)):{}}function Wu(n,t){
return new n.constructor(t?Ru(n.buffer):n.buffer,n.byteOffset,n.length)}function Lu(n,t){if(n!==t){var r=n!==X,e=null===n,u=n===n,i=bc(n),o=t!==X,f=null===t,c=t===t,a=bc(t);if(!f&&!a&&!i&&n>t||i&&o&&c&&!f&&!a||e&&o&&c||!r&&c||!u)return 1;if(!e&&!i&&!a&&n<t||a&&r&&u&&!e&&!i||f&&r&&u||!o&&u||!c)return-1}return 0}function Cu(n,t,r){for(var e=-1,u=n.a,i=t.a,o=u.length,f=r.length;++e<o;){var c=Lu(u[e],i[e]);if(c){if(e>=f)return c;return c*("desc"==r[e]?-1:1)}}return n.b-t.b}function Uu(n,t,r,e){for(var u=-1,i=n.length,o=r.length,f=-1,c=t.length,a=Gl(i-o,0),l=il(c+a),s=!e;++f<c;)l[f]=t[f];
for(;++u<o;)(s||u<i)&&(l[r[u]]=n[u]);for(;a--;)l[f++]=n[u++];return l}function Bu(n,t,r,e){for(var u=-1,i=n.length,o=-1,f=r.length,c=-1,a=t.length,l=Gl(i-f,0),s=il(l+a),h=!e;++u<l;)s[u]=n[u];for(var p=u;++c<a;)s[p+c]=t[c];for(;++o<f;)(h||u<i)&&(s[p+r[o]]=n[u++]);return s}function Tu(n,t){var r=-1,e=n.length;for(t||(t=il(e));++r<e;)t[r]=n[r];return t}function $u(n,t,r,e){var u=!r;r||(r={});for(var i=-1,o=t.length;++i<o;){var f=t[i],c=e?e(r[f],n[f],f,r,n):X;c===X&&(c=n[f]),u?Tr(r,f,c):Wr(r,f,c)}return r;
}function Du(n,t){return $u(n,Os(n),t)}function Mu(n,t){return $u(n,Rs(n),t)}function Fu(n,r){return function(e,u){var i=bh(e)?t:Cr,o=r?r():{};return i(e,n,mi(u,2),o)}}function Nu(n){return uu(function(t,r){var e=-1,u=r.length,i=u>1?r[u-1]:X,o=u>2?r[2]:X;for(i=n.length>3&&typeof i=="function"?(u--,i):X,o&&Ui(r[0],r[1],o)&&(i=u<3?X:i,u=1),t=ll(t);++e<u;){var f=r[e];f&&n(t,f,e,i)}return t})}function Pu(n,t){return function(r,e){if(null==r)return r;if(!Hf(r))return n(r,e);for(var u=r.length,i=t?u:-1,o=ll(r);(t?i--:++i<u)&&e(o[i],i,o)!==false;);
return r}}function qu(n){return function(t,r,e){for(var u=-1,i=ll(t),o=e(t),f=o.length;f--;){var c=o[n?f:++u];if(r(i[c],c,i)===false)break}return t}}function Zu(n,t,r){function e(){return(this&&this!==re&&this instanceof e?i:n).apply(u?r:this,arguments)}var u=t&vn,i=Gu(n);return e}function Ku(n){return function(t){t=Ec(t);var r=T(t)?G(t):X,e=r?r[0]:t.charAt(0),u=r?Iu(r,1).join(""):t.slice(1);return e[n]()+u}}function Vu(n){return function(t){return l(Ra(ca(t).replace(Dr,"")),n,"")}}function Gu(n){return function(){
var t=arguments;switch(t.length){case 0:return new n;case 1:return new n(t[0]);case 2:return new n(t[0],t[1]);case 3:return new n(t[0],t[1],t[2]);case 4:return new n(t[0],t[1],t[2],t[3]);case 5:return new n(t[0],t[1],t[2],t[3],t[4]);case 6:return new n(t[0],t[1],t[2],t[3],t[4],t[5]);case 7:return new n(t[0],t[1],t[2],t[3],t[4],t[5],t[6])}var r=gs(n.prototype),e=n.apply(r,t);return fc(e)?e:r}}function Hu(t,r,e){function u(){for(var o=arguments.length,f=il(o),c=o,a=wi(u);c--;)f[c]=arguments[c];var l=o<3&&f[0]!==a&&f[o-1]!==a?[]:N(f,a);
return o-=l.length,o<e?oi(t,r,Qu,u.placeholder,X,f,l,X,X,e-o):n(this&&this!==re&&this instanceof u?i:t,this,f)}var i=Gu(t);return u}function Ju(n){return function(t,r,e){var u=ll(t);if(!Hf(t)){var i=mi(r,3);t=Pc(t),r=function(n){return i(u[n],n,u)}}var o=n(t,r,e);return o>-1?u[i?t[o]:o]:X}}function Yu(n){return gi(function(t){var r=t.length,e=r,u=Y.prototype.thru;for(n&&t.reverse();e--;){var i=t[e];if(typeof i!="function")throw new pl(en);if(u&&!o&&"wrapper"==bi(i))var o=new Y([],true)}for(e=o?e:r;++e<r;){
i=t[e];var f=bi(i),c="wrapper"==f?Is(i):X;o=c&&$i(c[0])&&c[1]==(xn|dn|wn|jn)&&!c[4].length&&1==c[9]?o[bi(c[0])].apply(o,c[3]):1==i.length&&$i(i)?o[f]():o.thru(i)}return function(){var n=arguments,e=n[0];if(o&&1==n.length&&bh(e))return o.plant(e).value();for(var u=0,i=r?t[u].apply(this,n):e;++u<r;)i=t[u].call(this,i);return i}})}function Qu(n,t,r,e,u,i,o,f,c,a){function l(){for(var y=arguments.length,d=il(y),b=y;b--;)d[b]=arguments[b];if(_)var w=wi(l),m=C(d,w);if(e&&(d=Uu(d,e,u,_)),i&&(d=Bu(d,i,o,_)),
y-=m,_&&y<a){return oi(n,t,Qu,l.placeholder,r,d,N(d,w),f,c,a-y)}var x=h?r:this,j=p?x[n]:n;return y=d.length,f?d=Hi(d,f):v&&y>1&&d.reverse(),s&&c<y&&(d.length=c),this&&this!==re&&this instanceof l&&(j=g||Gu(j)),j.apply(x,d)}var s=t&xn,h=t&vn,p=t&gn,_=t&(dn|bn),v=t&An,g=p?X:Gu(n);return l}function Xu(n,t){return function(r,e){return Ie(r,n,t(e),{})}}function ni(n,t){return function(r,e){var u;if(r===X&&e===X)return t;if(r!==X&&(u=r),e!==X){if(u===X)return e;typeof r=="string"||typeof e=="string"?(r=vu(r),
e=vu(e)):(r=_u(r),e=_u(e)),u=n(r,e)}return u}}function ti(t){return gi(function(r){return r=c(r,z(mi())),uu(function(e){var u=this;return t(r,function(t){return n(t,u,e)})})})}function ri(n,t){t=t===X?" ":vu(t);var r=t.length;if(r<2)return r?eu(t,n):t;var e=eu(t,Fl(n/V(t)));return T(t)?Iu(G(e),0,n).join(""):e.slice(0,n)}function ei(t,r,e,u){function i(){for(var r=-1,c=arguments.length,a=-1,l=u.length,s=il(l+c),h=this&&this!==re&&this instanceof i?f:t;++a<l;)s[a]=u[a];for(;c--;)s[a++]=arguments[++r];
return n(h,o?e:this,s)}var o=r&vn,f=Gu(t);return i}function ui(n){return function(t,r,e){return e&&typeof e!="number"&&Ui(t,r,e)&&(r=e=X),t=Ac(t),r===X?(r=t,t=0):r=Ac(r),e=e===X?t<r?1:-1:Ac(e),ru(t,r,e,n)}}function ii(n){return function(t,r){return typeof t=="string"&&typeof r=="string"||(t=Oc(t),r=Oc(r)),n(t,r)}}function oi(n,t,r,e,u,i,o,f,c,a){var l=t&dn,s=l?o:X,h=l?X:o,p=l?i:X,_=l?X:i;t|=l?wn:mn,t&=~(l?mn:wn),t&yn||(t&=~(vn|gn));var v=[n,t,u,p,s,_,h,f,c,a],g=r.apply(X,v);return $i(n)&&Ss(g,v),g.placeholder=e,
Yi(g,n,t)}function fi(n){var t=al[n];return function(n,r){if(n=Oc(n),r=null==r?0:Hl(kc(r),292),r&&Zl(n)){var e=(Ec(n)+"e").split("e");return e=(Ec(t(e[0]+"e"+(+e[1]+r)))+"e").split("e"),+(e[0]+"e"+(+e[1]-r))}return t(n)}}function ci(n){return function(t){var r=zs(t);return r==Hn?M(t):r==rt?q(t):O(t,n(t))}}function ai(n,t,r,e,u,i,o,f){var c=t&gn;if(!c&&typeof n!="function")throw new pl(en);var a=e?e.length:0;if(a||(t&=~(wn|mn),e=u=X),o=o===X?o:Gl(kc(o),0),f=f===X?f:kc(f),a-=u?u.length:0,t&mn){var l=e,s=u;
e=u=X}var h=c?X:Is(n),p=[n,t,r,e,u,l,s,i,o,f];if(h&&qi(p,h),n=p[0],t=p[1],r=p[2],e=p[3],u=p[4],f=p[9]=p[9]===X?c?0:n.length:Gl(p[9]-a,0),!f&&t&(dn|bn)&&(t&=~(dn|bn)),t&&t!=vn)_=t==dn||t==bn?Hu(n,t,f):t!=wn&&t!=(vn|wn)||u.length?Qu.apply(X,p):ei(n,t,r,e);else var _=Zu(n,t,r);return Yi((h?ms:Ss)(_,p),n,t)}function li(n,t,r,e){return n===X||Gf(n,gl[r])&&!bl.call(e,r)?t:n}function si(n,t,r,e,u,i){return fc(n)&&fc(t)&&(i.set(t,n),Ke(n,t,X,si,i),i.delete(t)),n}function hi(n){return gc(n)?X:n}function pi(n,t,r,e,u,i){
var o=r&pn,f=n.length,c=t.length;if(f!=c&&!(o&&c>f))return false;var a=i.get(n),l=i.get(t);if(a&&l)return a==t&&l==n;var s=-1,p=true,_=r&_n?new dr:X;for(i.set(n,t),i.set(t,n);++s<f;){var v=n[s],g=t[s];if(e)var y=o?e(g,v,s,t,n,i):e(v,g,s,n,t,i);if(y!==X){if(y)continue;p=false;break}if(_){if(!h(t,function(n,t){if(!S(_,t)&&(v===n||u(v,n,r,e,i)))return _.push(t)})){p=false;break}}else if(v!==g&&!u(v,g,r,e,i)){p=false;break}}return i.delete(n),i.delete(t),p}function _i(n,t,r,e,u,i,o){switch(r){case at:if(n.byteLength!=t.byteLength||n.byteOffset!=t.byteOffset)return false;
n=n.buffer,t=t.buffer;case ct:return!(n.byteLength!=t.byteLength||!i(new Rl(n),new Rl(t)));case Pn:case qn:case Jn:return Gf(+n,+t);case Kn:return n.name==t.name&&n.message==t.message;case tt:case et:return n==t+"";case Hn:var f=M;case rt:var c=e&pn;if(f||(f=P),n.size!=t.size&&!c)return false;var a=o.get(n);if(a)return a==t;e|=_n,o.set(n,t);var l=pi(f(n),f(t),e,u,i,o);return o.delete(n),l;case ut:if(_s)return _s.call(n)==_s.call(t)}return false}function vi(n,t,r,e,u,i){var o=r&pn,f=yi(n),c=f.length;if(c!=yi(t).length&&!o)return false;
for(var a=c;a--;){var l=f[a];if(!(o?l in t:bl.call(t,l)))return false}var s=i.get(n),h=i.get(t);if(s&&h)return s==t&&h==n;var p=true;i.set(n,t),i.set(t,n);for(var _=o;++a<c;){l=f[a];var v=n[l],g=t[l];if(e)var y=o?e(g,v,l,t,n,i):e(v,g,l,n,t,i);if(!(y===X?v===g||u(v,g,r,e,i):y)){p=false;break}_||(_="constructor"==l)}if(p&&!_){var d=n.constructor,b=t.constructor;d!=b&&"constructor"in n&&"constructor"in t&&!(typeof d=="function"&&d instanceof d&&typeof b=="function"&&b instanceof b)&&(p=false)}return i.delete(n),
i.delete(t),p}function gi(n){return Ls(Vi(n,X,_o),n+"")}function yi(n){return de(n,Pc,Os)}function di(n){return de(n,qc,Rs)}function bi(n){for(var t=n.name+"",r=fs[t],e=bl.call(fs,t)?r.length:0;e--;){var u=r[e],i=u.func;if(null==i||i==n)return u.name}return t}function wi(n){return(bl.call(Z,"placeholder")?Z:n).placeholder}function mi(){var n=Z.iteratee||Ca;return n=n===Ca?De:n,arguments.length?n(arguments[0],arguments[1]):n}function xi(n,t){var r=n.__data__;return Ti(t)?r[typeof t=="string"?"string":"hash"]:r.map;
}function ji(n){for(var t=Pc(n),r=t.length;r--;){var e=t[r],u=n[e];t[r]=[e,u,Fi(u)]}return t}function Ai(n,t){var r=B(n,t);return Ue(r)?r:X}function ki(n){var t=bl.call(n,Bl),r=n[Bl];try{n[Bl]=X;var e=true}catch(n){}var u=xl.call(n);return e&&(t?n[Bl]=r:delete n[Bl]),u}function Ii(n,t,r){for(var e=-1,u=r.length;++e<u;){var i=r[e],o=i.size;switch(i.type){case"drop":n+=o;break;case"dropRight":t-=o;break;case"take":t=Hl(t,n+o);break;case"takeRight":n=Gl(n,t-o)}}return{start:n,end:t}}function Oi(n){var t=n.match(Tt);
return t?t[1].split($t):[]}function Ri(n,t,r){t=ku(t,n);for(var e=-1,u=t.length,i=false;++e<u;){var o=no(t[e]);if(!(i=null!=n&&r(n,o)))break;n=n[o]}return i||++e!=u?i:(u=null==n?0:n.length,!!u&&oc(u)&&Ci(o,u)&&(bh(n)||dh(n)))}function zi(n){var t=n.length,r=new n.constructor(t);return t&&"string"==typeof n[0]&&bl.call(n,"index")&&(r.index=n.index,r.input=n.input),r}function Ei(n){return typeof n.constructor!="function"||Mi(n)?{}:gs(El(n))}function Si(n,t,r){var e=n.constructor;switch(t){case ct:return Ru(n);
case Pn:case qn:return new e(+n);case at:return zu(n,r);case lt:case st:case ht:case pt:case _t:case vt:case gt:case yt:case dt:return Wu(n,r);case Hn:return new e;case Jn:case et:return new e(n);case tt:return Eu(n);case rt:return new e;case ut:return Su(n)}}function Wi(n,t){var r=t.length;if(!r)return n;var e=r-1;return t[e]=(r>1?"& ":"")+t[e],t=t.join(r>2?", ":" "),n.replace(Bt,"{\\n/* [wrapped with "+t+"] */\\n")}function Li(n){return bh(n)||dh(n)||!!(Cl&&n&&n[Cl])}function Ci(n,t){var r=typeof n;
return t=null==t?Ln:t,!!t&&("number"==r||"symbol"!=r&&Gt.test(n))&&n>-1&&n%1==0&&n<t}function Ui(n,t,r){if(!fc(r))return false;var e=typeof t;return!!("number"==e?Hf(r)&&Ci(t,r.length):"string"==e&&t in r)&&Gf(r[t],n)}function Bi(n,t){if(bh(n))return false;var r=typeof n;return!("number"!=r&&"symbol"!=r&&"boolean"!=r&&null!=n&&!bc(n))||(Et.test(n)||!zt.test(n)||null!=t&&n in ll(t))}function Ti(n){var t=typeof n;return"string"==t||"number"==t||"symbol"==t||"boolean"==t?"__proto__"!==n:null===n}function $i(n){
var t=bi(n),r=Z[t];if(typeof r!="function"||!(t in Ut.prototype))return false;if(n===r)return true;var e=Is(r);return!!e&&n===e[0]}function Di(n){return!!ml&&ml in n}function Mi(n){var t=n&&n.constructor;return n===(typeof t=="function"&&t.prototype||gl)}function Fi(n){return n===n&&!fc(n)}function Ni(n,t){return function(r){return null!=r&&(r[n]===t&&(t!==X||n in ll(r)))}}function Pi(n){var t=Cf(n,function(n){return r.size===cn&&r.clear(),n}),r=t.cache;return t}function qi(n,t){var r=n[1],e=t[1],u=r|e,i=u<(vn|gn|xn),o=e==xn&&r==dn||e==xn&&r==jn&&n[7].length<=t[8]||e==(xn|jn)&&t[7].length<=t[8]&&r==dn;
if(!i&&!o)return n;e&vn&&(n[2]=t[2],u|=r&vn?0:yn);var f=t[3];if(f){var c=n[3];n[3]=c?Uu(c,f,t[4]):f,n[4]=c?N(n[3],an):t[4]}return f=t[5],f&&(c=n[5],n[5]=c?Bu(c,f,t[6]):f,n[6]=c?N(n[5],an):t[6]),f=t[7],f&&(n[7]=f),e&xn&&(n[8]=null==n[8]?t[8]:Hl(n[8],t[8])),null==n[9]&&(n[9]=t[9]),n[0]=t[0],n[1]=u,n}function Zi(n){var t=[];if(null!=n)for(var r in ll(n))t.push(r);return t}function Ki(n){return xl.call(n)}function Vi(t,r,e){return r=Gl(r===X?t.length-1:r,0),function(){for(var u=arguments,i=-1,o=Gl(u.length-r,0),f=il(o);++i<o;)f[i]=u[r+i];
i=-1;for(var c=il(r+1);++i<r;)c[i]=u[i];return c[r]=e(f),n(t,this,c)}}function Gi(n,t){return t.length<2?n:_e(n,au(t,0,-1))}function Hi(n,t){for(var r=n.length,e=Hl(t.length,r),u=Tu(n);e--;){var i=t[e];n[e]=Ci(i,r)?u[i]:X}return n}function Ji(n,t){if(("constructor"!==t||"function"!=typeof n[t])&&"__proto__"!=t)return n[t]}function Yi(n,t,r){var e=t+"";return Ls(n,Wi(e,ro(Oi(e),r)))}function Qi(n){var t=0,r=0;return function(){var e=Jl(),u=Rn-(e-r);if(r=e,u>0){if(++t>=On)return arguments[0]}else t=0;
return n.apply(X,arguments)}}function Xi(n,t){var r=-1,e=n.length,u=e-1;for(t=t===X?e:t;++r<t;){var i=tu(r,u),o=n[i];n[i]=n[r],n[r]=o}return n.length=t,n}function no(n){if(typeof n=="string"||bc(n))return n;var t=n+"";return"0"==t&&1/n==-Wn?"-0":t}function to(n){if(null!=n){try{return dl.call(n)}catch(n){}try{return n+""}catch(n){}}return""}function ro(n,t){return r(Dn,function(r){var e="_."+r[0];t&r[1]&&!o(n,e)&&n.push(e)}),n.sort()}function eo(n){if(n instanceof Ut)return n.clone();var t=new Y(n.__wrapped__,n.__chain__);
return t.__actions__=Tu(n.__actions__),t.__index__=n.__index__,t.__values__=n.__values__,t}function uo(n,t,r){t=(r?Ui(n,t,r):t===X)?1:Gl(kc(t),0);var e=null==n?0:n.length;if(!e||t<1)return[];for(var u=0,i=0,o=il(Fl(e/t));u<e;)o[i++]=au(n,u,u+=t);return o}function io(n){for(var t=-1,r=null==n?0:n.length,e=0,u=[];++t<r;){var i=n[t];i&&(u[e++]=i)}return u}function oo(){var n=arguments.length;if(!n)return[];for(var t=il(n-1),r=arguments[0],e=n;e--;)t[e-1]=arguments[e];return a(bh(r)?Tu(r):[r],ee(t,1));
}function fo(n,t,r){var e=null==n?0:n.length;return e?(t=r||t===X?1:kc(t),au(n,t<0?0:t,e)):[]}function co(n,t,r){var e=null==n?0:n.length;return e?(t=r||t===X?1:kc(t),t=e-t,au(n,0,t<0?0:t)):[]}function ao(n,t){return n&&n.length?bu(n,mi(t,3),true,true):[]}function lo(n,t){return n&&n.length?bu(n,mi(t,3),true):[]}function so(n,t,r,e){var u=null==n?0:n.length;return u?(r&&typeof r!="number"&&Ui(n,t,r)&&(r=0,e=u),ne(n,t,r,e)):[]}function ho(n,t,r){var e=null==n?0:n.length;if(!e)return-1;var u=null==r?0:kc(r);
return u<0&&(u=Gl(e+u,0)),g(n,mi(t,3),u)}function po(n,t,r){var e=null==n?0:n.length;if(!e)return-1;var u=e-1;return r!==X&&(u=kc(r),u=r<0?Gl(e+u,0):Hl(u,e-1)),g(n,mi(t,3),u,true)}function _o(n){return(null==n?0:n.length)?ee(n,1):[]}function vo(n){return(null==n?0:n.length)?ee(n,Wn):[]}function go(n,t){return(null==n?0:n.length)?(t=t===X?1:kc(t),ee(n,t)):[]}function yo(n){for(var t=-1,r=null==n?0:n.length,e={};++t<r;){var u=n[t];Tr(e,u[0],u[1])}return e}function bo(n){return n&&n.length?n[0]:X}function wo(n,t,r){
var e=null==n?0:n.length;if(!e)return-1;var u=null==r?0:kc(r);return u<0&&(u=Gl(e+u,0)),y(n,t,u)}function mo(n){return(null==n?0:n.length)?au(n,0,-1):[]}function xo(n,t){return null==n?"":Kl.call(n,t)}function jo(n){var t=null==n?0:n.length;return t?n[t-1]:X}function Ao(n,t,r){var e=null==n?0:n.length;if(!e)return-1;var u=e;return r!==X&&(u=kc(r),u=u<0?Gl(e+u,0):Hl(u,e-1)),t===t?K(n,t,u):g(n,b,u,true)}function ko(n,t){return n&&n.length?Ge(n,kc(t)):X}function Io(n,t){return n&&n.length&&t&&t.length?Xe(n,t):n;
}function Oo(n,t,r){return n&&n.length&&t&&t.length?Xe(n,t,mi(r,2)):n}function Ro(n,t,r){return n&&n.length&&t&&t.length?Xe(n,t,X,r):n}function zo(n,t){var r=[];if(!n||!n.length)return r;var e=-1,u=[],i=n.length;for(t=mi(t,3);++e<i;){var o=n[e];t(o,e,n)&&(r.push(o),u.push(e))}return nu(n,u),r}function Eo(n){return null==n?n:Xl.call(n)}function So(n,t,r){var e=null==n?0:n.length;return e?(r&&typeof r!="number"&&Ui(n,t,r)?(t=0,r=e):(t=null==t?0:kc(t),r=r===X?e:kc(r)),au(n,t,r)):[]}function Wo(n,t){
return su(n,t)}function Lo(n,t,r){return hu(n,t,mi(r,2))}function Co(n,t){var r=null==n?0:n.length;if(r){var e=su(n,t);if(e<r&&Gf(n[e],t))return e}return-1}function Uo(n,t){return su(n,t,true)}function Bo(n,t,r){return hu(n,t,mi(r,2),true)}function To(n,t){if(null==n?0:n.length){var r=su(n,t,true)-1;if(Gf(n[r],t))return r}return-1}function $o(n){return n&&n.length?pu(n):[]}function Do(n,t){return n&&n.length?pu(n,mi(t,2)):[]}function Mo(n){var t=null==n?0:n.length;return t?au(n,1,t):[]}function Fo(n,t,r){
return n&&n.length?(t=r||t===X?1:kc(t),au(n,0,t<0?0:t)):[]}function No(n,t,r){var e=null==n?0:n.length;return e?(t=r||t===X?1:kc(t),t=e-t,au(n,t<0?0:t,e)):[]}function Po(n,t){return n&&n.length?bu(n,mi(t,3),false,true):[]}function qo(n,t){return n&&n.length?bu(n,mi(t,3)):[]}function Zo(n){return n&&n.length?gu(n):[]}function Ko(n,t){return n&&n.length?gu(n,mi(t,2)):[]}function Vo(n,t){return t=typeof t=="function"?t:X,n&&n.length?gu(n,X,t):[]}function Go(n){if(!n||!n.length)return[];var t=0;return n=i(n,function(n){
if(Jf(n))return t=Gl(n.length,t),true}),I(t,function(t){return c(n,m(t))})}function Ho(t,r){if(!t||!t.length)return[];var e=Go(t);return null==r?e:c(e,function(t){return n(r,X,t)})}function Jo(n,t){return xu(n||[],t||[],Wr)}function Yo(n,t){return xu(n||[],t||[],fu)}function Qo(n){var t=Z(n);return t.__chain__=true,t}function Xo(n,t){return t(n),n}function nf(n,t){return t(n)}function tf(){return Qo(this)}function rf(){return new Y(this.value(),this.__chain__)}function ef(){this.__values__===X&&(this.__values__=jc(this.value()));
var n=this.__index__>=this.__values__.length;return{done:n,value:n?X:this.__values__[this.__index__++]}}function uf(){return this}function of(n){for(var t,r=this;r instanceof J;){var e=eo(r);e.__index__=0,e.__values__=X,t?u.__wrapped__=e:t=e;var u=e;r=r.__wrapped__}return u.__wrapped__=n,t}function ff(){var n=this.__wrapped__;if(n instanceof Ut){var t=n;return this.__actions__.length&&(t=new Ut(this)),t=t.reverse(),t.__actions__.push({func:nf,args:[Eo],thisArg:X}),new Y(t,this.__chain__)}return this.thru(Eo);
}function cf(){return wu(this.__wrapped__,this.__actions__)}function af(n,t,r){var e=bh(n)?u:Jr;return r&&Ui(n,t,r)&&(t=X),e(n,mi(t,3))}function lf(n,t){return(bh(n)?i:te)(n,mi(t,3))}function sf(n,t){return ee(yf(n,t),1)}function hf(n,t){return ee(yf(n,t),Wn)}function pf(n,t,r){return r=r===X?1:kc(r),ee(yf(n,t),r)}function _f(n,t){return(bh(n)?r:ys)(n,mi(t,3))}function vf(n,t){return(bh(n)?e:ds)(n,mi(t,3))}function gf(n,t,r,e){n=Hf(n)?n:ra(n),r=r&&!e?kc(r):0;var u=n.length;return r<0&&(r=Gl(u+r,0)),
dc(n)?r<=u&&n.indexOf(t,r)>-1:!!u&&y(n,t,r)>-1}function yf(n,t){return(bh(n)?c:Pe)(n,mi(t,3))}function df(n,t,r,e){return null==n?[]:(bh(t)||(t=null==t?[]:[t]),r=e?X:r,bh(r)||(r=null==r?[]:[r]),He(n,t,r))}function bf(n,t,r){var e=bh(n)?l:j,u=arguments.length<3;return e(n,mi(t,4),r,u,ys)}function wf(n,t,r){var e=bh(n)?s:j,u=arguments.length<3;return e(n,mi(t,4),r,u,ds)}function mf(n,t){return(bh(n)?i:te)(n,Uf(mi(t,3)))}function xf(n){return(bh(n)?Rr:iu)(n)}function jf(n,t,r){return t=(r?Ui(n,t,r):t===X)?1:kc(t),
(bh(n)?zr:ou)(n,t)}function Af(n){return(bh(n)?Er:cu)(n)}function kf(n){if(null==n)return 0;if(Hf(n))return dc(n)?V(n):n.length;var t=zs(n);return t==Hn||t==rt?n.size:Me(n).length}function If(n,t,r){var e=bh(n)?h:lu;return r&&Ui(n,t,r)&&(t=X),e(n,mi(t,3))}function Of(n,t){if(typeof t!="function")throw new pl(en);return n=kc(n),function(){if(--n<1)return t.apply(this,arguments)}}function Rf(n,t,r){return t=r?X:t,t=n&&null==t?n.length:t,ai(n,xn,X,X,X,X,t)}function zf(n,t){var r;if(typeof t!="function")throw new pl(en);
return n=kc(n),function(){return--n>0&&(r=t.apply(this,arguments)),n<=1&&(t=X),r}}function Ef(n,t,r){t=r?X:t;var e=ai(n,dn,X,X,X,X,X,t);return e.placeholder=Ef.placeholder,e}function Sf(n,t,r){t=r?X:t;var e=ai(n,bn,X,X,X,X,X,t);return e.placeholder=Sf.placeholder,e}function Wf(n,t,r){function e(t){var r=h,e=p;return h=p=X,d=t,v=n.apply(e,r)}function u(n){return d=n,g=Ws(f,t),b?e(n):v}function i(n){var r=n-y,e=n-d,u=t-r;return w?Hl(u,_-e):u}function o(n){var r=n-y,e=n-d;return y===X||r>=t||r<0||w&&e>=_;
}function f(){var n=fh();return o(n)?c(n):(g=Ws(f,i(n)),X)}function c(n){return g=X,m&&h?e(n):(h=p=X,v)}function a(){g!==X&&As(g),d=0,h=y=p=g=X}function l(){return g===X?v:c(fh())}function s(){var n=fh(),r=o(n);if(h=arguments,p=this,y=n,r){if(g===X)return u(y);if(w)return As(g),g=Ws(f,t),e(y)}return g===X&&(g=Ws(f,t)),v}var h,p,_,v,g,y,d=0,b=false,w=false,m=true;if(typeof n!="function")throw new pl(en);return t=Oc(t)||0,fc(r)&&(b=!!r.leading,w="maxWait"in r,_=w?Gl(Oc(r.maxWait)||0,t):_,m="trailing"in r?!!r.trailing:m),
s.cancel=a,s.flush=l,s}function Lf(n){return ai(n,An)}function Cf(n,t){if(typeof n!="function"||null!=t&&typeof t!="function")throw new pl(en);var r=function(){var e=arguments,u=t?t.apply(this,e):e[0],i=r.cache;if(i.has(u))return i.get(u);var o=n.apply(this,e);return r.cache=i.set(u,o)||i,o};return r.cache=new(Cf.Cache||hr),r}function Uf(n){if(typeof n!="function")throw new pl(en);return function(){var t=arguments;switch(t.length){case 0:return!n.call(this);case 1:return!n.call(this,t[0]);case 2:
return!n.call(this,t[0],t[1]);case 3:return!n.call(this,t[0],t[1],t[2])}return!n.apply(this,t)}}function Bf(n){return zf(2,n)}function Tf(n,t){if(typeof n!="function")throw new pl(en);return t=t===X?t:kc(t),uu(n,t)}function $f(t,r){if(typeof t!="function")throw new pl(en);return r=null==r?0:Gl(kc(r),0),uu(function(e){var u=e[r],i=Iu(e,0,r);return u&&a(i,u),n(t,this,i)})}function Df(n,t,r){var e=true,u=true;if(typeof n!="function")throw new pl(en);return fc(r)&&(e="leading"in r?!!r.leading:e,u="trailing"in r?!!r.trailing:u),
Wf(n,t,{leading:e,maxWait:t,trailing:u})}function Mf(n){return Rf(n,1)}function Ff(n,t){return ph(Au(t),n)}function Nf(){if(!arguments.length)return[];var n=arguments[0];return bh(n)?n:[n]}function Pf(n){return Nr(n,hn)}function qf(n,t){return t=typeof t=="function"?t:X,Nr(n,hn,t)}function Zf(n){return Nr(n,ln|hn)}function Kf(n,t){return t=typeof t=="function"?t:X,Nr(n,ln|hn,t)}function Vf(n,t){return null==t||qr(n,t,Pc(t))}function Gf(n,t){return n===t||n!==n&&t!==t}function Hf(n){return null!=n&&oc(n.length)&&!uc(n);
}function Jf(n){return cc(n)&&Hf(n)}function Yf(n){return n===true||n===false||cc(n)&&we(n)==Pn}function Qf(n){return cc(n)&&1===n.nodeType&&!gc(n)}function Xf(n){if(null==n)return true;if(Hf(n)&&(bh(n)||typeof n=="string"||typeof n.splice=="function"||mh(n)||Ih(n)||dh(n)))return!n.length;var t=zs(n);if(t==Hn||t==rt)return!n.size;if(Mi(n))return!Me(n).length;for(var r in n)if(bl.call(n,r))return false;return true}function nc(n,t){return Se(n,t)}function tc(n,t,r){r=typeof r=="function"?r:X;var e=r?r(n,t):X;return e===X?Se(n,t,X,r):!!e;
}function rc(n){if(!cc(n))return false;var t=we(n);return t==Kn||t==Zn||typeof n.message=="string"&&typeof n.name=="string"&&!gc(n)}function ec(n){return typeof n=="number"&&Zl(n)}function uc(n){if(!fc(n))return false;var t=we(n);return t==Vn||t==Gn||t==Nn||t==nt}function ic(n){return typeof n=="number"&&n==kc(n)}function oc(n){return typeof n=="number"&&n>-1&&n%1==0&&n<=Ln}function fc(n){var t=typeof n;return null!=n&&("object"==t||"function"==t)}function cc(n){return null!=n&&typeof n=="object"}function ac(n,t){
return n===t||Ce(n,t,ji(t))}function lc(n,t,r){return r=typeof r=="function"?r:X,Ce(n,t,ji(t),r)}function sc(n){return vc(n)&&n!=+n}function hc(n){if(Es(n))throw new fl(rn);return Ue(n)}function pc(n){return null===n}function _c(n){return null==n}function vc(n){return typeof n=="number"||cc(n)&&we(n)==Jn}function gc(n){if(!cc(n)||we(n)!=Qn)return false;var t=El(n);if(null===t)return true;var r=bl.call(t,"constructor")&&t.constructor;return typeof r=="function"&&r instanceof r&&dl.call(r)==jl}function yc(n){
return ic(n)&&n>=-Ln&&n<=Ln}function dc(n){return typeof n=="string"||!bh(n)&&cc(n)&&we(n)==et}function bc(n){return typeof n=="symbol"||cc(n)&&we(n)==ut}function wc(n){return n===X}function mc(n){return cc(n)&&zs(n)==ot}function xc(n){return cc(n)&&we(n)==ft}function jc(n){if(!n)return[];if(Hf(n))return dc(n)?G(n):Tu(n);if(Ul&&n[Ul])return D(n[Ul]());var t=zs(n);return(t==Hn?M:t==rt?P:ra)(n)}function Ac(n){if(!n)return 0===n?n:0;if(n=Oc(n),n===Wn||n===-Wn){return(n<0?-1:1)*Cn}return n===n?n:0}function kc(n){
var t=Ac(n),r=t%1;return t===t?r?t-r:t:0}function Ic(n){return n?Fr(kc(n),0,Bn):0}function Oc(n){if(typeof n=="number")return n;if(bc(n))return Un;if(fc(n)){var t=typeof n.valueOf=="function"?n.valueOf():n;n=fc(t)?t+"":t}if(typeof n!="string")return 0===n?n:+n;n=R(n);var r=Zt.test(n);return r||Vt.test(n)?Xr(n.slice(2),r?2:8):qt.test(n)?Un:+n}function Rc(n){return $u(n,qc(n))}function zc(n){return n?Fr(kc(n),-Ln,Ln):0===n?n:0}function Ec(n){return null==n?"":vu(n)}function Sc(n,t){var r=gs(n);return null==t?r:Ur(r,t);
}function Wc(n,t){return v(n,mi(t,3),ue)}function Lc(n,t){return v(n,mi(t,3),oe)}function Cc(n,t){return null==n?n:bs(n,mi(t,3),qc)}function Uc(n,t){return null==n?n:ws(n,mi(t,3),qc)}function Bc(n,t){return n&&ue(n,mi(t,3))}function Tc(n,t){return n&&oe(n,mi(t,3))}function $c(n){return null==n?[]:fe(n,Pc(n))}function Dc(n){return null==n?[]:fe(n,qc(n))}function Mc(n,t,r){var e=null==n?X:_e(n,t);return e===X?r:e}function Fc(n,t){return null!=n&&Ri(n,t,xe)}function Nc(n,t){return null!=n&&Ri(n,t,je);
}function Pc(n){return Hf(n)?Or(n):Me(n)}function qc(n){return Hf(n)?Or(n,true):Fe(n)}function Zc(n,t){var r={};return t=mi(t,3),ue(n,function(n,e,u){Tr(r,t(n,e,u),n)}),r}function Kc(n,t){var r={};return t=mi(t,3),ue(n,function(n,e,u){Tr(r,e,t(n,e,u))}),r}function Vc(n,t){return Gc(n,Uf(mi(t)))}function Gc(n,t){if(null==n)return{};var r=c(di(n),function(n){return[n]});return t=mi(t),Ye(n,r,function(n,r){return t(n,r[0])})}function Hc(n,t,r){t=ku(t,n);var e=-1,u=t.length;for(u||(u=1,n=X);++e<u;){var i=null==n?X:n[no(t[e])];
i===X&&(e=u,i=r),n=uc(i)?i.call(n):i}return n}function Jc(n,t,r){return null==n?n:fu(n,t,r)}function Yc(n,t,r,e){return e=typeof e=="function"?e:X,null==n?n:fu(n,t,r,e)}function Qc(n,t,e){var u=bh(n),i=u||mh(n)||Ih(n);if(t=mi(t,4),null==e){var o=n&&n.constructor;e=i?u?new o:[]:fc(n)&&uc(o)?gs(El(n)):{}}return(i?r:ue)(n,function(n,r,u){return t(e,n,r,u)}),e}function Xc(n,t){return null==n||yu(n,t)}function na(n,t,r){return null==n?n:du(n,t,Au(r))}function ta(n,t,r,e){return e=typeof e=="function"?e:X,
null==n?n:du(n,t,Au(r),e)}function ra(n){return null==n?[]:E(n,Pc(n))}function ea(n){return null==n?[]:E(n,qc(n))}function ua(n,t,r){return r===X&&(r=t,t=X),r!==X&&(r=Oc(r),r=r===r?r:0),t!==X&&(t=Oc(t),t=t===t?t:0),Fr(Oc(n),t,r)}function ia(n,t,r){return t=Ac(t),r===X?(r=t,t=0):r=Ac(r),n=Oc(n),Ae(n,t,r)}function oa(n,t,r){if(r&&typeof r!="boolean"&&Ui(n,t,r)&&(t=r=X),r===X&&(typeof t=="boolean"?(r=t,t=X):typeof n=="boolean"&&(r=n,n=X)),n===X&&t===X?(n=0,t=1):(n=Ac(n),t===X?(t=n,n=0):t=Ac(t)),n>t){
var e=n;n=t,t=e}if(r||n%1||t%1){var u=Ql();return Hl(n+u*(t-n+Qr("1e-"+((u+"").length-1))),t)}return tu(n,t)}function fa(n){return Qh(Ec(n).toLowerCase())}function ca(n){return n=Ec(n),n&&n.replace(Ht,ve).replace(Mr,"")}function aa(n,t,r){n=Ec(n),t=vu(t);var e=n.length;r=r===X?e:Fr(kc(r),0,e);var u=r;return r-=t.length,r>=0&&n.slice(r,u)==t}function la(n){return n=Ec(n),n&&kt.test(n)?n.replace(jt,ge):n}function sa(n){return n=Ec(n),n&&Lt.test(n)?n.replace(Wt,"\\\\$&"):n}function ha(n,t,r){n=Ec(n),t=kc(t);
var e=t?V(n):0;if(!t||e>=t)return n;var u=(t-e)/2;return ri(Nl(u),r)+n+ri(Fl(u),r)}function pa(n,t,r){n=Ec(n),t=kc(t);var e=t?V(n):0;return t&&e<t?n+ri(t-e,r):n}function _a(n,t,r){n=Ec(n),t=kc(t);var e=t?V(n):0;return t&&e<t?ri(t-e,r)+n:n}function va(n,t,r){return r||null==t?t=0:t&&(t=+t),Yl(Ec(n).replace(Ct,""),t||0)}function ga(n,t,r){return t=(r?Ui(n,t,r):t===X)?1:kc(t),eu(Ec(n),t)}function ya(){var n=arguments,t=Ec(n[0]);return n.length<3?t:t.replace(n[1],n[2])}function da(n,t,r){return r&&typeof r!="number"&&Ui(n,t,r)&&(t=r=X),
(r=r===X?Bn:r>>>0)?(n=Ec(n),n&&(typeof t=="string"||null!=t&&!Ah(t))&&(t=vu(t),!t&&T(n))?Iu(G(n),0,r):n.split(t,r)):[]}function ba(n,t,r){return n=Ec(n),r=null==r?0:Fr(kc(r),0,n.length),t=vu(t),n.slice(r,r+t.length)==t}function wa(n,t,e){var u=Z.templateSettings;e&&Ui(n,t,e)&&(t=X),n=Ec(n),t=Wh({},t,u,li);var i=Wh({},t.imports,u.imports,li),o=Pc(i),f=E(i,o);r(o,function(n){if(Mt.test(n))throw new fl(on)});var c,a,l=0,s=t.interpolate||Jt,h="__p+='",p=sl((t.escape||Jt).source+"|"+s.source+"|"+(s===Rt?Nt:Jt).source+"|"+(t.evaluate||Jt).source+"|$","g"),_=bl.call(t,"sourceURL")?"//# sourceURL="+(t.sourceURL+"").replace(/\\s/g," ")+"\\n":"";
n.replace(p,function(t,r,e,u,i,o){return e||(e=u),h+=n.slice(l,o).replace(Yt,U),r&&(c=true,h+="'+__e("+r+")+'"),i&&(a=true,h+="';"+i+";\\n__p+='"),e&&(h+="'+((__t=("+e+"))==null?'':__t)+'"),l=o+t.length,t}),h+="';";var v=bl.call(t,"variable")&&t.variable;if(v){if(Mt.test(v))throw new fl(un)}else h="with(obj){"+h+"}";h=(a?h.replace(bt,""):h).replace(wt,"$1").replace(mt,"$1;"),h="function("+(v||"obj")+"){"+(v?"":"obj||(obj={});")+"var __t,__p=''"+(c?",__e=_.escape":"")+(a?",__j=Array.prototype.join;function print(){__p+=__j.call(arguments,'')}":";")+h+"return __p}";
var g=Xh(function(){return cl(o,_+"return "+h).apply(X,f)});if(g.source=h,rc(g))throw g;return g}function ma(n){return Ec(n).toLowerCase()}function xa(n){return Ec(n).toUpperCase()}function ja(n,t,r){if(n=Ec(n),n&&(r||t===X))return R(n);if(!n||!(t=vu(t)))return n;var e=G(n),u=G(t);return Iu(e,W(e,u),L(e,u)+1).join("")}function Aa(n,t,r){if(n=Ec(n),n&&(r||t===X))return n.slice(0,H(n)+1);if(!n||!(t=vu(t)))return n;var e=G(n);return Iu(e,0,L(e,G(t))+1).join("")}function ka(n,t,r){if(n=Ec(n),n&&(r||t===X))return n.replace(Ct,"");
if(!n||!(t=vu(t)))return n;var e=G(n);return Iu(e,W(e,G(t))).join("")}function Ia(n,t){var r=kn,e=In;if(fc(t)){var u="separator"in t?t.separator:u;r="length"in t?kc(t.length):r,e="omission"in t?vu(t.omission):e}n=Ec(n);var i=n.length;if(T(n)){var o=G(n);i=o.length}if(r>=i)return n;var f=r-V(e);if(f<1)return e;var c=o?Iu(o,0,f).join(""):n.slice(0,f);if(u===X)return c+e;if(o&&(f+=c.length-f),Ah(u)){if(n.slice(f).search(u)){var a,l=c;for(u.global||(u=sl(u.source,Ec(Pt.exec(u))+"g")),u.lastIndex=0;a=u.exec(l);)var s=a.index;
c=c.slice(0,s===X?f:s)}}else if(n.indexOf(vu(u),f)!=f){var h=c.lastIndexOf(u);h>-1&&(c=c.slice(0,h))}return c+e}function Oa(n){return n=Ec(n),n&&At.test(n)?n.replace(xt,ye):n}function Ra(n,t,r){return n=Ec(n),t=r?X:t,t===X?$(n)?Q(n):_(n):n.match(t)||[]}function za(t){var r=null==t?0:t.length,e=mi();return t=r?c(t,function(n){if("function"!=typeof n[1])throw new pl(en);return[e(n[0]),n[1]]}):[],uu(function(e){for(var u=-1;++u<r;){var i=t[u];if(n(i[0],this,e))return n(i[1],this,e)}})}function Ea(n){
return Pr(Nr(n,ln))}function Sa(n){return function(){return n}}function Wa(n,t){return null==n||n!==n?t:n}function La(n){return n}function Ca(n){return De(typeof n=="function"?n:Nr(n,ln))}function Ua(n){return qe(Nr(n,ln))}function Ba(n,t){return Ze(n,Nr(t,ln))}function Ta(n,t,e){var u=Pc(t),i=fe(t,u);null!=e||fc(t)&&(i.length||!u.length)||(e=t,t=n,n=this,i=fe(t,Pc(t)));var o=!(fc(e)&&"chain"in e&&!e.chain),f=uc(n);return r(i,function(r){var e=t[r];n[r]=e,f&&(n.prototype[r]=function(){var t=this.__chain__;
if(o||t){var r=n(this.__wrapped__);return(r.__actions__=Tu(this.__actions__)).push({func:e,args:arguments,thisArg:n}),r.__chain__=t,r}return e.apply(n,a([this.value()],arguments))})}),n}function $a(){return re._===this&&(re._=Al),this}function Da(){}function Ma(n){return n=kc(n),uu(function(t){return Ge(t,n)})}function Fa(n){return Bi(n)?m(no(n)):Qe(n)}function Na(n){return function(t){return null==n?X:_e(n,t)}}function Pa(){return[]}function qa(){return false}function Za(){return{}}function Ka(){return"";
}function Va(){return true}function Ga(n,t){if(n=kc(n),n<1||n>Ln)return[];var r=Bn,e=Hl(n,Bn);t=mi(t),n-=Bn;for(var u=I(e,t);++r<n;)t(r);return u}function Ha(n){return bh(n)?c(n,no):bc(n)?[n]:Tu(Cs(Ec(n)))}function Ja(n){var t=++wl;return Ec(n)+t}function Ya(n){return n&&n.length?Yr(n,La,me):X}function Qa(n,t){return n&&n.length?Yr(n,mi(t,2),me):X}function Xa(n){return w(n,La)}function nl(n,t){return w(n,mi(t,2))}function tl(n){return n&&n.length?Yr(n,La,Ne):X}function rl(n,t){return n&&n.length?Yr(n,mi(t,2),Ne):X;
}function el(n){return n&&n.length?k(n,La):0}function ul(n,t){return n&&n.length?k(n,mi(t,2)):0}x=null==x?re:be.defaults(re.Object(),x,be.pick(re,Zr));var il=x.Array,ol=x.Date,fl=x.Error,cl=x.Function,al=x.Math,ll=x.Object,sl=x.RegExp,hl=x.String,pl=x.TypeError,_l=il.prototype,vl=cl.prototype,gl=ll.prototype,yl=x["__core-js_shared__"],dl=vl.toString,bl=gl.hasOwnProperty,wl=0,ml=function(){var n=/[^.]+$/.exec(yl&&yl.keys&&yl.keys.IE_PROTO||"");return n?"Symbol(src)_1."+n:""}(),xl=gl.toString,jl=dl.call(ll),Al=re._,kl=sl("^"+dl.call(bl).replace(Wt,"\\\\$&").replace(/hasOwnProperty|(function).*?(?=\\\\\\()| for .+?(?=\\\\\\])/g,"$1.*?")+"$"),Il=ie?x.Buffer:X,Ol=x.Symbol,Rl=x.Uint8Array,zl=Il?Il.allocUnsafe:X,El=F(ll.getPrototypeOf,ll),Sl=ll.create,Wl=gl.propertyIsEnumerable,Ll=_l.splice,Cl=Ol?Ol.isConcatSpreadable:X,Ul=Ol?Ol.iterator:X,Bl=Ol?Ol.toStringTag:X,Tl=function(){
try{var n=Ai(ll,"defineProperty");return n({},"",{}),n}catch(n){}}(),$l=x.clearTimeout!==re.clearTimeout&&x.clearTimeout,Dl=ol&&ol.now!==re.Date.now&&ol.now,Ml=x.setTimeout!==re.setTimeout&&x.setTimeout,Fl=al.ceil,Nl=al.floor,Pl=ll.getOwnPropertySymbols,ql=Il?Il.isBuffer:X,Zl=x.isFinite,Kl=_l.join,Vl=F(ll.keys,ll),Gl=al.max,Hl=al.min,Jl=ol.now,Yl=x.parseInt,Ql=al.random,Xl=_l.reverse,ns=Ai(x,"DataView"),ts=Ai(x,"Map"),rs=Ai(x,"Promise"),es=Ai(x,"Set"),us=Ai(x,"WeakMap"),is=Ai(ll,"create"),os=us&&new us,fs={},cs=to(ns),as=to(ts),ls=to(rs),ss=to(es),hs=to(us),ps=Ol?Ol.prototype:X,_s=ps?ps.valueOf:X,vs=ps?ps.toString:X,gs=function(){
function n(){}return function(t){if(!fc(t))return{};if(Sl)return Sl(t);n.prototype=t;var r=new n;return n.prototype=X,r}}();Z.templateSettings={escape:It,evaluate:Ot,interpolate:Rt,variable:"",imports:{_:Z}},Z.prototype=J.prototype,Z.prototype.constructor=Z,Y.prototype=gs(J.prototype),Y.prototype.constructor=Y,Ut.prototype=gs(J.prototype),Ut.prototype.constructor=Ut,nr.prototype.clear=tr,nr.prototype.delete=rr,nr.prototype.get=er,nr.prototype.has=ur,nr.prototype.set=ir,or.prototype.clear=fr,or.prototype.delete=cr,
or.prototype.get=ar,or.prototype.has=lr,or.prototype.set=sr,hr.prototype.clear=pr,hr.prototype.delete=_r,hr.prototype.get=vr,hr.prototype.has=gr,hr.prototype.set=yr,dr.prototype.add=dr.prototype.push=br,dr.prototype.has=wr,mr.prototype.clear=xr,mr.prototype.delete=jr,mr.prototype.get=Ar,mr.prototype.has=kr,mr.prototype.set=Ir;var ys=Pu(ue),ds=Pu(oe,true),bs=qu(),ws=qu(true),ms=os?function(n,t){return os.set(n,t),n}:La,xs=Tl?function(n,t){return Tl(n,"toString",{configurable:true,enumerable:false,value:Sa(t),
writable:true})}:La,js=uu,As=$l||function(n){return re.clearTimeout(n)},ks=es&&1/P(new es([,-0]))[1]==Wn?function(n){return new es(n)}:Da,Is=os?function(n){return os.get(n)}:Da,Os=Pl?function(n){return null==n?[]:(n=ll(n),i(Pl(n),function(t){return Wl.call(n,t)}))}:Pa,Rs=Pl?function(n){for(var t=[];n;)a(t,Os(n)),n=El(n);return t}:Pa,zs=we;(ns&&zs(new ns(new ArrayBuffer(1)))!=at||ts&&zs(new ts)!=Hn||rs&&zs(rs.resolve())!=Xn||es&&zs(new es)!=rt||us&&zs(new us)!=ot)&&(zs=function(n){var t=we(n),r=t==Qn?n.constructor:X,e=r?to(r):"";
if(e)switch(e){case cs:return at;case as:return Hn;case ls:return Xn;case ss:return rt;case hs:return ot}return t});var Es=yl?uc:qa,Ss=Qi(ms),Ws=Ml||function(n,t){return re.setTimeout(n,t)},Ls=Qi(xs),Cs=Pi(function(n){var t=[];return 46===n.charCodeAt(0)&&t.push(""),n.replace(St,function(n,r,e,u){t.push(e?u.replace(Ft,"$1"):r||n)}),t}),Us=uu(function(n,t){return Jf(n)?Hr(n,ee(t,1,Jf,true)):[]}),Bs=uu(function(n,t){var r=jo(t);return Jf(r)&&(r=X),Jf(n)?Hr(n,ee(t,1,Jf,true),mi(r,2)):[]}),Ts=uu(function(n,t){
var r=jo(t);return Jf(r)&&(r=X),Jf(n)?Hr(n,ee(t,1,Jf,true),X,r):[]}),$s=uu(function(n){var t=c(n,ju);return t.length&&t[0]===n[0]?ke(t):[]}),Ds=uu(function(n){var t=jo(n),r=c(n,ju);return t===jo(r)?t=X:r.pop(),r.length&&r[0]===n[0]?ke(r,mi(t,2)):[]}),Ms=uu(function(n){var t=jo(n),r=c(n,ju);return t=typeof t=="function"?t:X,t&&r.pop(),r.length&&r[0]===n[0]?ke(r,X,t):[]}),Fs=uu(Io),Ns=gi(function(n,t){var r=null==n?0:n.length,e=$r(n,t);return nu(n,c(t,function(n){return Ci(n,r)?+n:n}).sort(Lu)),e}),Ps=uu(function(n){
return gu(ee(n,1,Jf,true))}),qs=uu(function(n){var t=jo(n);return Jf(t)&&(t=X),gu(ee(n,1,Jf,true),mi(t,2))}),Zs=uu(function(n){var t=jo(n);return t=typeof t=="function"?t:X,gu(ee(n,1,Jf,true),X,t)}),Ks=uu(function(n,t){return Jf(n)?Hr(n,t):[]}),Vs=uu(function(n){return mu(i(n,Jf))}),Gs=uu(function(n){var t=jo(n);return Jf(t)&&(t=X),mu(i(n,Jf),mi(t,2))}),Hs=uu(function(n){var t=jo(n);return t=typeof t=="function"?t:X,mu(i(n,Jf),X,t)}),Js=uu(Go),Ys=uu(function(n){var t=n.length,r=t>1?n[t-1]:X;return r=typeof r=="function"?(n.pop(),
r):X,Ho(n,r)}),Qs=gi(function(n){var t=n.length,r=t?n[0]:0,e=this.__wrapped__,u=function(t){return $r(t,n)};return!(t>1||this.__actions__.length)&&e instanceof Ut&&Ci(r)?(e=e.slice(r,+r+(t?1:0)),e.__actions__.push({func:nf,args:[u],thisArg:X}),new Y(e,this.__chain__).thru(function(n){return t&&!n.length&&n.push(X),n})):this.thru(u)}),Xs=Fu(function(n,t,r){bl.call(n,r)?++n[r]:Tr(n,r,1)}),nh=Ju(ho),th=Ju(po),rh=Fu(function(n,t,r){bl.call(n,r)?n[r].push(t):Tr(n,r,[t])}),eh=uu(function(t,r,e){var u=-1,i=typeof r=="function",o=Hf(t)?il(t.length):[];
return ys(t,function(t){o[++u]=i?n(r,t,e):Oe(t,r,e)}),o}),uh=Fu(function(n,t,r){Tr(n,r,t)}),ih=Fu(function(n,t,r){n[r?0:1].push(t)},function(){return[[],[]]}),oh=uu(function(n,t){if(null==n)return[];var r=t.length;return r>1&&Ui(n,t[0],t[1])?t=[]:r>2&&Ui(t[0],t[1],t[2])&&(t=[t[0]]),He(n,ee(t,1),[])}),fh=Dl||function(){return re.Date.now()},ch=uu(function(n,t,r){var e=vn;if(r.length){var u=N(r,wi(ch));e|=wn}return ai(n,e,t,r,u)}),ah=uu(function(n,t,r){var e=vn|gn;if(r.length){var u=N(r,wi(ah));e|=wn;
}return ai(t,e,n,r,u)}),lh=uu(function(n,t){return Gr(n,1,t)}),sh=uu(function(n,t,r){return Gr(n,Oc(t)||0,r)});Cf.Cache=hr;var hh=js(function(t,r){r=1==r.length&&bh(r[0])?c(r[0],z(mi())):c(ee(r,1),z(mi()));var e=r.length;return uu(function(u){for(var i=-1,o=Hl(u.length,e);++i<o;)u[i]=r[i].call(this,u[i]);return n(t,this,u)})}),ph=uu(function(n,t){return ai(n,wn,X,t,N(t,wi(ph)))}),_h=uu(function(n,t){return ai(n,mn,X,t,N(t,wi(_h)))}),vh=gi(function(n,t){return ai(n,jn,X,X,X,t)}),gh=ii(me),yh=ii(function(n,t){
return n>=t}),dh=Re(function(){return arguments}())?Re:function(n){return cc(n)&&bl.call(n,"callee")&&!Wl.call(n,"callee")},bh=il.isArray,wh=ce?z(ce):ze,mh=ql||qa,xh=ae?z(ae):Ee,jh=le?z(le):Le,Ah=se?z(se):Be,kh=he?z(he):Te,Ih=pe?z(pe):$e,Oh=ii(Ne),Rh=ii(function(n,t){return n<=t}),zh=Nu(function(n,t){if(Mi(t)||Hf(t))return $u(t,Pc(t),n),X;for(var r in t)bl.call(t,r)&&Wr(n,r,t[r])}),Eh=Nu(function(n,t){$u(t,qc(t),n)}),Sh=Nu(function(n,t,r,e){$u(t,qc(t),n,e)}),Wh=Nu(function(n,t,r,e){$u(t,Pc(t),n,e);
}),Lh=gi($r),Ch=uu(function(n,t){n=ll(n);var r=-1,e=t.length,u=e>2?t[2]:X;for(u&&Ui(t[0],t[1],u)&&(e=1);++r<e;)for(var i=t[r],o=qc(i),f=-1,c=o.length;++f<c;){var a=o[f],l=n[a];(l===X||Gf(l,gl[a])&&!bl.call(n,a))&&(n[a]=i[a])}return n}),Uh=uu(function(t){return t.push(X,si),n(Mh,X,t)}),Bh=Xu(function(n,t,r){null!=t&&typeof t.toString!="function"&&(t=xl.call(t)),n[t]=r},Sa(La)),Th=Xu(function(n,t,r){null!=t&&typeof t.toString!="function"&&(t=xl.call(t)),bl.call(n,t)?n[t].push(r):n[t]=[r]},mi),$h=uu(Oe),Dh=Nu(function(n,t,r){
Ke(n,t,r)}),Mh=Nu(function(n,t,r,e){Ke(n,t,r,e)}),Fh=gi(function(n,t){var r={};if(null==n)return r;var e=false;t=c(t,function(t){return t=ku(t,n),e||(e=t.length>1),t}),$u(n,di(n),r),e&&(r=Nr(r,ln|sn|hn,hi));for(var u=t.length;u--;)yu(r,t[u]);return r}),Nh=gi(function(n,t){return null==n?{}:Je(n,t)}),Ph=ci(Pc),qh=ci(qc),Zh=Vu(function(n,t,r){return t=t.toLowerCase(),n+(r?fa(t):t)}),Kh=Vu(function(n,t,r){return n+(r?"-":"")+t.toLowerCase()}),Vh=Vu(function(n,t,r){return n+(r?" ":"")+t.toLowerCase()}),Gh=Ku("toLowerCase"),Hh=Vu(function(n,t,r){
return n+(r?"_":"")+t.toLowerCase()}),Jh=Vu(function(n,t,r){return n+(r?" ":"")+Qh(t)}),Yh=Vu(function(n,t,r){return n+(r?" ":"")+t.toUpperCase()}),Qh=Ku("toUpperCase"),Xh=uu(function(t,r){try{return n(t,X,r)}catch(n){return rc(n)?n:new fl(n)}}),np=gi(function(n,t){return r(t,function(t){t=no(t),Tr(n,t,ch(n[t],n))}),n}),tp=Yu(),rp=Yu(true),ep=uu(function(n,t){return function(r){return Oe(r,n,t)}}),up=uu(function(n,t){return function(r){return Oe(n,r,t)}}),ip=ti(c),op=ti(u),fp=ti(h),cp=ui(),ap=ui(true),lp=ni(function(n,t){
return n+t},0),sp=fi("ceil"),hp=ni(function(n,t){return n/t},1),pp=fi("floor"),_p=ni(function(n,t){return n*t},1),vp=fi("round"),gp=ni(function(n,t){return n-t},0);return Z.after=Of,Z.ary=Rf,Z.assign=zh,Z.assignIn=Eh,Z.assignInWith=Sh,Z.assignWith=Wh,Z.at=Lh,Z.before=zf,Z.bind=ch,Z.bindAll=np,Z.bindKey=ah,Z.castArray=Nf,Z.chain=Qo,Z.chunk=uo,Z.compact=io,Z.concat=oo,Z.cond=za,Z.conforms=Ea,Z.constant=Sa,Z.countBy=Xs,Z.create=Sc,Z.curry=Ef,Z.curryRight=Sf,Z.debounce=Wf,Z.defaults=Ch,Z.defaultsDeep=Uh,
Z.defer=lh,Z.delay=sh,Z.difference=Us,Z.differenceBy=Bs,Z.differenceWith=Ts,Z.drop=fo,Z.dropRight=co,Z.dropRightWhile=ao,Z.dropWhile=lo,Z.fill=so,Z.filter=lf,Z.flatMap=sf,Z.flatMapDeep=hf,Z.flatMapDepth=pf,Z.flatten=_o,Z.flattenDeep=vo,Z.flattenDepth=go,Z.flip=Lf,Z.flow=tp,Z.flowRight=rp,Z.fromPairs=yo,Z.functions=$c,Z.functionsIn=Dc,Z.groupBy=rh,Z.initial=mo,Z.intersection=$s,Z.intersectionBy=Ds,Z.intersectionWith=Ms,Z.invert=Bh,Z.invertBy=Th,Z.invokeMap=eh,Z.iteratee=Ca,Z.keyBy=uh,Z.keys=Pc,Z.keysIn=qc,
Z.map=yf,Z.mapKeys=Zc,Z.mapValues=Kc,Z.matches=Ua,Z.matchesProperty=Ba,Z.memoize=Cf,Z.merge=Dh,Z.mergeWith=Mh,Z.method=ep,Z.methodOf=up,Z.mixin=Ta,Z.negate=Uf,Z.nthArg=Ma,Z.omit=Fh,Z.omitBy=Vc,Z.once=Bf,Z.orderBy=df,Z.over=ip,Z.overArgs=hh,Z.overEvery=op,Z.overSome=fp,Z.partial=ph,Z.partialRight=_h,Z.partition=ih,Z.pick=Nh,Z.pickBy=Gc,Z.property=Fa,Z.propertyOf=Na,Z.pull=Fs,Z.pullAll=Io,Z.pullAllBy=Oo,Z.pullAllWith=Ro,Z.pullAt=Ns,Z.range=cp,Z.rangeRight=ap,Z.rearg=vh,Z.reject=mf,Z.remove=zo,Z.rest=Tf,
Z.reverse=Eo,Z.sampleSize=jf,Z.set=Jc,Z.setWith=Yc,Z.shuffle=Af,Z.slice=So,Z.sortBy=oh,Z.sortedUniq=$o,Z.sortedUniqBy=Do,Z.split=da,Z.spread=$f,Z.tail=Mo,Z.take=Fo,Z.takeRight=No,Z.takeRightWhile=Po,Z.takeWhile=qo,Z.tap=Xo,Z.throttle=Df,Z.thru=nf,Z.toArray=jc,Z.toPairs=Ph,Z.toPairsIn=qh,Z.toPath=Ha,Z.toPlainObject=Rc,Z.transform=Qc,Z.unary=Mf,Z.union=Ps,Z.unionBy=qs,Z.unionWith=Zs,Z.uniq=Zo,Z.uniqBy=Ko,Z.uniqWith=Vo,Z.unset=Xc,Z.unzip=Go,Z.unzipWith=Ho,Z.update=na,Z.updateWith=ta,Z.values=ra,Z.valuesIn=ea,
Z.without=Ks,Z.words=Ra,Z.wrap=Ff,Z.xor=Vs,Z.xorBy=Gs,Z.xorWith=Hs,Z.zip=Js,Z.zipObject=Jo,Z.zipObjectDeep=Yo,Z.zipWith=Ys,Z.entries=Ph,Z.entriesIn=qh,Z.extend=Eh,Z.extendWith=Sh,Ta(Z,Z),Z.add=lp,Z.attempt=Xh,Z.camelCase=Zh,Z.capitalize=fa,Z.ceil=sp,Z.clamp=ua,Z.clone=Pf,Z.cloneDeep=Zf,Z.cloneDeepWith=Kf,Z.cloneWith=qf,Z.conformsTo=Vf,Z.deburr=ca,Z.defaultTo=Wa,Z.divide=hp,Z.endsWith=aa,Z.eq=Gf,Z.escape=la,Z.escapeRegExp=sa,Z.every=af,Z.find=nh,Z.findIndex=ho,Z.findKey=Wc,Z.findLast=th,Z.findLastIndex=po,
Z.findLastKey=Lc,Z.floor=pp,Z.forEach=_f,Z.forEachRight=vf,Z.forIn=Cc,Z.forInRight=Uc,Z.forOwn=Bc,Z.forOwnRight=Tc,Z.get=Mc,Z.gt=gh,Z.gte=yh,Z.has=Fc,Z.hasIn=Nc,Z.head=bo,Z.identity=La,Z.includes=gf,Z.indexOf=wo,Z.inRange=ia,Z.invoke=$h,Z.isArguments=dh,Z.isArray=bh,Z.isArrayBuffer=wh,Z.isArrayLike=Hf,Z.isArrayLikeObject=Jf,Z.isBoolean=Yf,Z.isBuffer=mh,Z.isDate=xh,Z.isElement=Qf,Z.isEmpty=Xf,Z.isEqual=nc,Z.isEqualWith=tc,Z.isError=rc,Z.isFinite=ec,Z.isFunction=uc,Z.isInteger=ic,Z.isLength=oc,Z.isMap=jh,
Z.isMatch=ac,Z.isMatchWith=lc,Z.isNaN=sc,Z.isNative=hc,Z.isNil=_c,Z.isNull=pc,Z.isNumber=vc,Z.isObject=fc,Z.isObjectLike=cc,Z.isPlainObject=gc,Z.isRegExp=Ah,Z.isSafeInteger=yc,Z.isSet=kh,Z.isString=dc,Z.isSymbol=bc,Z.isTypedArray=Ih,Z.isUndefined=wc,Z.isWeakMap=mc,Z.isWeakSet=xc,Z.join=xo,Z.kebabCase=Kh,Z.last=jo,Z.lastIndexOf=Ao,Z.lowerCase=Vh,Z.lowerFirst=Gh,Z.lt=Oh,Z.lte=Rh,Z.max=Ya,Z.maxBy=Qa,Z.mean=Xa,Z.meanBy=nl,Z.min=tl,Z.minBy=rl,Z.stubArray=Pa,Z.stubFalse=qa,Z.stubObject=Za,Z.stubString=Ka,
Z.stubTrue=Va,Z.multiply=_p,Z.nth=ko,Z.noConflict=$a,Z.noop=Da,Z.now=fh,Z.pad=ha,Z.padEnd=pa,Z.padStart=_a,Z.parseInt=va,Z.random=oa,Z.reduce=bf,Z.reduceRight=wf,Z.repeat=ga,Z.replace=ya,Z.result=Hc,Z.round=vp,Z.runInContext=p,Z.sample=xf,Z.size=kf,Z.snakeCase=Hh,Z.some=If,Z.sortedIndex=Wo,Z.sortedIndexBy=Lo,Z.sortedIndexOf=Co,Z.sortedLastIndex=Uo,Z.sortedLastIndexBy=Bo,Z.sortedLastIndexOf=To,Z.startCase=Jh,Z.startsWith=ba,Z.subtract=gp,Z.sum=el,Z.sumBy=ul,Z.template=wa,Z.times=Ga,Z.toFinite=Ac,Z.toInteger=kc,
Z.toLength=Ic,Z.toLower=ma,Z.toNumber=Oc,Z.toSafeInteger=zc,Z.toString=Ec,Z.toUpper=xa,Z.trim=ja,Z.trimEnd=Aa,Z.trimStart=ka,Z.truncate=Ia,Z.unescape=Oa,Z.uniqueId=Ja,Z.upperCase=Yh,Z.upperFirst=Qh,Z.each=_f,Z.eachRight=vf,Z.first=bo,Ta(Z,function(){var n={};return ue(Z,function(t,r){bl.call(Z.prototype,r)||(n[r]=t)}),n}(),{chain:false}),Z.VERSION=nn,r(["bind","bindKey","curry","curryRight","partial","partialRight"],function(n){Z[n].placeholder=Z}),r(["drop","take"],function(n,t){Ut.prototype[n]=function(r){
r=r===X?1:Gl(kc(r),0);var e=this.__filtered__&&!t?new Ut(this):this.clone();return e.__filtered__?e.__takeCount__=Hl(r,e.__takeCount__):e.__views__.push({size:Hl(r,Bn),type:n+(e.__dir__<0?"Right":"")}),e},Ut.prototype[n+"Right"]=function(t){return this.reverse()[n](t).reverse()}}),r(["filter","map","takeWhile"],function(n,t){var r=t+1,e=r==zn||r==Sn;Ut.prototype[n]=function(n){var t=this.clone();return t.__iteratees__.push({iteratee:mi(n,3),type:r}),t.__filtered__=t.__filtered__||e,t}}),r(["head","last"],function(n,t){
var r="take"+(t?"Right":"");Ut.prototype[n]=function(){return this[r](1).value()[0]}}),r(["initial","tail"],function(n,t){var r="drop"+(t?"":"Right");Ut.prototype[n]=function(){return this.__filtered__?new Ut(this):this[r](1)}}),Ut.prototype.compact=function(){return this.filter(La)},Ut.prototype.find=function(n){return this.filter(n).head()},Ut.prototype.findLast=function(n){return this.reverse().find(n)},Ut.prototype.invokeMap=uu(function(n,t){return typeof n=="function"?new Ut(this):this.map(function(r){
return Oe(r,n,t)})}),Ut.prototype.reject=function(n){return this.filter(Uf(mi(n)))},Ut.prototype.slice=function(n,t){n=kc(n);var r=this;return r.__filtered__&&(n>0||t<0)?new Ut(r):(n<0?r=r.takeRight(-n):n&&(r=r.drop(n)),t!==X&&(t=kc(t),r=t<0?r.dropRight(-t):r.take(t-n)),r)},Ut.prototype.takeRightWhile=function(n){return this.reverse().takeWhile(n).reverse()},Ut.prototype.toArray=function(){return this.take(Bn)},ue(Ut.prototype,function(n,t){var r=/^(?:filter|find|map|reject)|While$/.test(t),e=/^(?:head|last)$/.test(t),u=Z[e?"take"+("last"==t?"Right":""):t],i=e||/^find/.test(t);
u&&(Z.prototype[t]=function(){var t=this.__wrapped__,o=e?[1]:arguments,f=t instanceof Ut,c=o[0],l=f||bh(t),s=function(n){var t=u.apply(Z,a([n],o));return e&&h?t[0]:t};l&&r&&typeof c=="function"&&1!=c.length&&(f=l=false);var h=this.__chain__,p=!!this.__actions__.length,_=i&&!h,v=f&&!p;if(!i&&l){t=v?t:new Ut(this);var g=n.apply(t,o);return g.__actions__.push({func:nf,args:[s],thisArg:X}),new Y(g,h)}return _&&v?n.apply(this,o):(g=this.thru(s),_?e?g.value()[0]:g.value():g)})}),r(["pop","push","shift","sort","splice","unshift"],function(n){
var t=_l[n],r=/^(?:push|sort|unshift)$/.test(n)?"tap":"thru",e=/^(?:pop|shift)$/.test(n);Z.prototype[n]=function(){var n=arguments;if(e&&!this.__chain__){var u=this.value();return t.apply(bh(u)?u:[],n)}return this[r](function(r){return t.apply(bh(r)?r:[],n)})}}),ue(Ut.prototype,function(n,t){var r=Z[t];if(r){var e=r.name+"";bl.call(fs,e)||(fs[e]=[]),fs[e].push({name:t,func:r})}}),fs[Qu(X,gn).name]=[{name:"wrapper",func:X}],Ut.prototype.clone=Dt,Ut.prototype.reverse=Qt,Ut.prototype.value=Xt,Z.prototype.at=Qs,
Z.prototype.chain=tf,Z.prototype.commit=rf,Z.prototype.next=ef,Z.prototype.plant=of,Z.prototype.reverse=ff,Z.prototype.toJSON=Z.prototype.valueOf=Z.prototype.value=cf,Z.prototype.first=Z.prototype.head,Ul&&(Z.prototype[Ul]=uf),Z},be=de();typeof define=="function"&&typeof define.amd=="object"&&define.amd?(re._=be, define(function(){return be})):ue?((ue.exports=be)._=be,ee._=be):re._=be}).call(this);`;

// src/render/lodash-shim.ts
function lodashShim() {
  return "<script>" + lodash_4_18_1_min_default + "</script>";
}

// src/render/mvu-shim.ts
var MVU_EVENTS = Object.freeze({
  VARIABLE_INITIALIZED: "mag_variable_initiailized",
  VARIABLE_UPDATE_STARTED: "mag_variable_update_started",
  COMMAND_PARSED: "mag_command_parsed",
  VARIABLE_UPDATE_ENDED: "mag_variable_update_ended",
  BEFORE_MESSAGE_UPDATE: "mag_before_message_update"
});
function mvuShim(consts) {
  const constsJson = JSON.stringify({ variablesSnapshot: consts.variablesSnapshot });
  const eventsJson = JSON.stringify(MVU_EVENTS);
  return `<script>(function(){
var MVUC = ${constsJson};
var EVENTS = ${eventsJson};
var listeners = {};
function reg(event, listener, once){
  if (!listeners[event]) listeners[event] = [];
  var arr = listeners[event];
  if (once) {
    var wrap = function(){
      var i = arr.indexOf(wrap);
      if (i >= 0) arr.splice(i, 1);
      return listener.apply(null, arguments);
    };
    arr.push(wrap);
  } else {
    arr.push(listener);
  }
}
window.Mvu = {
  events: EVENTS,
  getMvuData: function(){ return MVUC.variablesSnapshot; },
  replaceMvuData: function(){ return Promise.resolve(); },
  parseMessage: function(){ return Promise.resolve(undefined); },
  isDuringExtraAnalysis: function(){ return false; }
};
window.getAllVariables = function(){ return MVUC.variablesSnapshot; };
window.waitGlobalInitialized = function(name){
  if (name === 'Mvu') return Promise.resolve();
  return new Promise(function(){});
};
window.eventOn = function(event, listener){ reg(event, listener, false); };
window.eventOnce = function(event, listener){ reg(event, listener, true); };
window.eventEmit = function(event){
  var arr = listeners[event];
  if (!arr) return;
  var args = Array.prototype.slice.call(arguments, 1);
  var copy = arr.slice();
  for (var i = 0; i < copy.length; i++) {
    try { copy[i].apply(null, args); } catch (e) { try { console.warn('[vishrun:mvu] listener threw:', e); } catch (_e) {} }
  }
};
window.eventRemoveListener = function(event, listener){
  var arr = listeners[event];
  if (!arr) return;
  var i = arr.indexOf(listener);
  if (i >= 0) arr.splice(i, 1);
};
window.eventClearAll = function(){ listeners = {}; };
window.errorCatched = function(fn){
  return function(){
    try { return fn.apply(this, arguments); }
    catch (e) { try { console.error('[vishrun:mvu] errorCatched:', e); } catch (_e) {} throw e; }
  };
};
})();</script>`;
}

// src/render/size-reporter.ts
function buildSizeReporterShell() {
  return `
<script>
(function() {
  var history = [];
  var pinned = false;
  function postSize() {
    if (pinned) return;
    try {
      if (!document.body) return;
      var maxBottom = 0;
      var children = document.body.children;
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        var rect = child.getBoundingClientRect();
        var cs = getComputedStyle(child);
        var marginBottom = parseFloat(cs.marginBottom) || 0;
        var shadowDown = 0;
        var boxShadow = cs.boxShadow;
        if (boxShadow && boxShadow !== 'none') {
          var sm = boxShadow.match(/-?\\d+px\\s+(-?\\d+)px\\s+(-?\\d+)px(?:\\s+(-?\\d+)px)?/);
          if (sm) {
            var y = parseFloat(sm[1]) || 0;
            if (y > 0) {
              var blur = parseFloat(sm[2]) || 0;
              var spread = parseFloat(sm[3] || '0') || 0;
              shadowDown = y + blur + spread;
            }
          }
        }
        var bottom = rect.bottom + window.scrollY + marginBottom + shadowDown;
        // Fixed elements sit against the frame viewport and add no height of
        // their own: reserve their size plus offsets. Viewport-sized ones
        // (overlays) follow the frame and are skipped.
        if (cs.position === 'fixed' && rect.height > 0 && Math.abs(rect.height - window.innerHeight) > 1) {
          bottom = rect.height + Math.max(0, parseFloat(cs.top) || 0) + Math.max(0, parseFloat(cs.bottom) || 0);
        }
        if (bottom > maxBottom) maxBottom = bottom;
      }
      if (document.body.scrollHeight > maxBottom) maxBottom = document.body.scrollHeight;
      var h = Math.ceil(maxBottom) + 4;

      // CSS transitions grow in equal steps too; only a frame-driven loop
      // (content sized off the frame height) should pin.
      var animating = typeof document.getAnimations === 'function' && document.getAnimations().length > 0;
      if (animating) history = [];
      history.push(h);
      if (history.length > 4) history.shift();
      if (!animating && history.length === 4) {
        var dd1 = history[1] - history[0];
        var dd2 = history[2] - history[1];
        var dd3 = history[3] - history[2];
        if (dd1 !== 0 && dd1 === dd2 && dd2 === dd3) {
          pinned = true;
          return;
        }
      }

      if (window.spindleSandbox && typeof window.spindleSandbox.requestResize === 'function') {
        window.spindleSandbox.requestResize(h);
      }
    } catch (e) {}
  }
  function init() {
    postSize();
    if (typeof ResizeObserver !== 'undefined' && document.body) {
      try {
        var ro = new ResizeObserver(postSize);
        ro.observe(document.body);
      } catch (e) {}
    }
    window.addEventListener('load', postSize);
    // Proxied images arrive after window load; fixed elements do not resize body.
    document.addEventListener('load', function(e) { if (e.target && e.target.tagName === 'IMG') postSize(); }, true);
    document.addEventListener('transitionend', postSize, true);
    document.addEventListener('animationend', postSize, true);
    // A click can expand or collapse content: lift a pin and measure again.
    document.addEventListener('click', function() {
      pinned = false;
      history = [];
      setTimeout(postSize, 0);
    }, true);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>`;
}

// src/render/viewport-shim.ts
var VIEWPORT_HEIGHT_PROPS = new Set(["min-height", "height"]);
function buildViewportHeightShim() {
  return "<style>" + ".min-h-screen,.min-h-\\[100vh\\],.min-h-\\[100dvh\\]{min-height:0 !important}" + ".h-screen,.h-\\[100vh\\],.h-\\[100dvh\\]{height:auto !important}" + "</style>" + buildRawViewportNeutralizerScript();
}
function buildRawViewportNeutralizerScript() {
  return `<script>(function(){
  function isLoopVal(v) {
    if (typeof v !== 'string') return false;
    var m = v.match(/^\\s*(\\d+(?:\\.\\d+)?)\\s*(vh|dvh|svh|lvh)\\s*$/i);
    if (!m) return false;
    var n = parseFloat(m[1]);
    return isFinite(n) && n >= 100;
  }
  function neutralize(el, prop) {
    try { el.style.setProperty(prop, 'auto', 'important'); } catch (e) {}
  }
  function scanInline() {
    if (document.body) {
      if (isLoopVal(document.body.style.minHeight)) neutralize(document.body, 'min-height');
      if (isLoopVal(document.body.style.height)) neutralize(document.body, 'height');
    }
    var styled = document.querySelectorAll('[style]');
    for (var i = 0; i < styled.length; i++) {
      var el = styled[i];
      if (isLoopVal(el.style.minHeight)) neutralize(el, 'min-height');
      if (isLoopVal(el.style.height)) neutralize(el, 'height');
    }
  }
  function walkRules(rules) {
    if (!rules) return;
    for (var j = 0; j < rules.length; j++) {
      var rule = rules[j];
      if (!rule) continue;
      if (rule.cssRules && !rule.selectorText) {
        try { walkRules(rule.cssRules); } catch (e) {}
        continue;
      }
      if (!rule.style || !rule.selectorText) continue;
      var mh = rule.style.getPropertyValue('min-height');
      var h = rule.style.getPropertyValue('height');
      var hitsMin = isLoopVal(mh);
      var hitsH = isLoopVal(h);
      if (!hitsMin && !hitsH) continue;
      var matched;
      try { matched = document.querySelectorAll(rule.selectorText); } catch (e) { continue; }
      for (var k = 0; k < matched.length; k++) {
        if (hitsMin) neutralize(matched[k], 'min-height');
        if (hitsH) neutralize(matched[k], 'height');
      }
    }
  }
  function scanRules() {
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      var rules;
      try { rules = sheets[i].cssRules || sheets[i].rules; } catch (e) { continue; }
      walkRules(rules);
    }
  }
  function pass() {
    try { scanInline(); } catch (e) {}
    try { scanRules(); } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pass, { once: true });
  } else {
    pass();
  }
  window.addEventListener('load', pass);
})();</script>`;
}

// src/render/widget-iframe.ts
var widgetFrameDestroyers = new WeakMap;
var iframeRegistry = new Map;
var REGISTRY_SEP = "\x00";
function registryKey(messageId, scriptId) {
  return messageId + REGISTRY_SEP + scriptId;
}
function registerWidget(messageId, scriptId, iframe) {
  const k = registryKey(messageId, scriptId);
  let set = iframeRegistry.get(k);
  if (!set) {
    set = new Set;
    iframeRegistry.set(k, set);
  }
  set.add(iframe);
}
function unregisterWidget(iframe) {
  const messageId = iframe.getAttribute("data-vishrun-message-id");
  const scriptId = iframe.getAttribute("data-vishrun-script-id");
  if (!messageId || !scriptId)
    return;
  const k = registryKey(messageId, scriptId);
  const set = iframeRegistry.get(k);
  if (!set)
    return;
  set.delete(iframe);
  if (set.size === 0)
    iframeRegistry.delete(k);
}
function cleanupOrphansForMessage(messageId, target) {
  const prefix = messageId + REGISTRY_SEP;
  const matchingKeys = [];
  for (const k of iframeRegistry.keys()) {
    if (k.startsWith(prefix))
      matchingKeys.push(k);
  }
  for (const k of matchingKeys) {
    const set = iframeRegistry.get(k);
    if (!set)
      continue;
    for (const iframe of [...set]) {
      if (target && deepContains(target, iframe))
        continue;
      destroyWidgetIframe(iframe, "cleanup-orphans");
    }
  }
}
function hasRegisteredWidgetsFor(messageId, scriptId) {
  const set = iframeRegistry.get(registryKey(messageId, scriptId));
  return !!set && set.size > 0;
}
function destroyRegisteredWidgetsFor(messageId, scriptId, reason = "destroy-registered") {
  const set = iframeRegistry.get(registryKey(messageId, scriptId));
  if (!set)
    return;
  for (const iframe of [...set]) {
    destroyWidgetIframe(iframe, reason);
  }
}
var widgetSources = new WeakMap;
function setWidgetSource(widget, text) {
  widgetSources.set(widget, text);
}
function restoreWidgetSource(widget) {
  const text = widgetSources.get(widget);
  if (text === undefined || !widget.isConnected || !widget.parentNode)
    return;
  widget.parentNode.insertBefore(document.createTextNode(text), widget);
  widgetSources.delete(widget);
}
function destroyAllRegisteredWidgetsForMessage(messageId, reason = "destroy-all-for-message") {
  const prefix = messageId + REGISTRY_SEP;
  const matchingKeys = [];
  for (const k of iframeRegistry.keys()) {
    if (k.startsWith(prefix))
      matchingKeys.push(k);
  }
  let destroyed = 0;
  for (const k of matchingKeys) {
    const set = iframeRegistry.get(k);
    if (!set)
      continue;
    for (const iframe of [...set]) {
      restoreWidgetSource(iframe);
      destroyWidgetIframe(iframe, reason);
      destroyed++;
    }
  }
  return destroyed;
}
function resolveCurrentMessageIndex(messageId, snapshot, domIndex) {
  const snapPos = snapshot.findIndex((m) => m.id === messageId);
  if (snapPos >= 0)
    return { index: snapPos, source: "snapshot" };
  return { index: domIndex, source: "dom-fallback" };
}
async function buildWidgetIframe(html, scriptName, scriptId, messageId, ctx) {
  const env = classifyWidgetEnvironment(html);
  const active = ctx.getActiveChat();
  const chatId = active.chatId ?? "";
  const domIndex = computeMessageIndexInChat(messageId);
  const snapshotContext = { chatId, currentMessageId: messageId, currentMessageIndex: domIndex };
  const triggerKey = messageId + " " + scriptId;
  if (VSH_VISHRUN_DIAG) {
    console.log("[vishrun:iframe] rebuild-triggered", JSON.stringify({
      reason: "build-widget-iframe",
      messageId,
      triggerKey
    }));
  }
  const [messagesSnapshot, variablesSnapshot] = await Promise.all([
    shouldInjectThHelpersShim(env) ? fetchMessagesSnapshot(snapshotContext, ctx) : Promise.resolve([]),
    shouldInjectMvuShim(env) ? fetchVariablesSnapshot(snapshotContext, ctx) : Promise.resolve({ stat_data: {} })
  ]);
  const resolved = resolveCurrentMessageIndex(messageId, messagesSnapshot, domIndex);
  const currentMessageIndex = resolved.index;
  if (resolved.source === "dom-fallback" && VSH_VISHRUN_DIAG && shouldInjectThHelpersShim(env)) {
    console.log("[vishrun:bridge] currentMessageDbIndex-fallback", JSON.stringify({
      messageId,
      reason: "not-in-snapshot",
      domIndex
    }));
  }
  const srcdoc = await injectShimsAndSizeReporter(html, ctx, {
    env,
    chatId,
    messageId,
    currentMessageIndex,
    messagesSnapshot,
    variablesSnapshot
  });
  const frame = ctx.dom.createSandboxFrame({
    html: srcdoc,
    autoResize: false,
    minHeight: 1,
    maxHeight: 4000,
    initialHeight: 1,
    allowEval: true
  });
  frame.onMessage((payload) => {
    routeChildMessage(frame, payload, ctx, { chatId, messageId, currentMessageIndex });
  });
  const iframe = frame.element;
  iframe.setAttribute("data-vishrun-widget", scriptName);
  iframe.setAttribute("data-vishrun-script-id", scriptId);
  iframe.setAttribute("data-vishrun-message-id", messageId);
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-forms");
  iframe.style.margin = "12px 0";
  iframe.style.maxHeight = "none";
  iframe.style.maxWidth = "none";
  iframe.addEventListener("load", () => syncFrameColorScheme(iframe));
  widgetFrameDestroyers.set(iframe, () => frame.destroy());
  registerWidget(messageId, scriptId, iframe);
  if (VSH_VISHRUN_DIAG) {
    console.log("[vishrun:iframe] iframe-built", JSON.stringify({
      messageId,
      triggerKey,
      snapshotKeys: Object.keys(variablesSnapshot.stat_data ?? {})
    }));
  }
  return iframe;
}
function syncFrameColorScheme(iframe) {
  try {
    const doc = iframe.contentDocument;
    if (!doc)
      return;
    const scheme = doc.defaultView?.getComputedStyle(doc.documentElement).colorScheme;
    if (scheme)
      iframe.style.colorScheme = scheme;
  } catch {}
}
function destroyWidgetIframe(iframe, reason = "unspecified") {
  if (VSH_VISHRUN_DIAG) {
    const messageId = iframe.getAttribute("data-vishrun-message-id") || "";
    const scriptId = iframe.getAttribute("data-vishrun-script-id") || "";
    console.log("[vishrun:iframe] iframe-destroyed", JSON.stringify({
      messageId,
      triggerKey: messageId + " " + scriptId,
      reason
    }));
  }
  unregisterWidget(iframe);
  const destroy = widgetFrameDestroyers.get(iframe);
  if (destroy) {
    widgetFrameDestroyers.delete(iframe);
    try {
      destroy();
    } catch (e) {
      console.debug("[vishrun] sandbox frame destroy threw:", e);
    }
    return;
  }
  iframe.remove();
}
function containsScriptTag(html) {
  return /<script\b[^>]*>/i.test(html);
}
function containsInlineEventHandler(html) {
  return /\bon(?:click|load|mouseover|mouseout|mousedown|mouseup|mousemove|change|input|submit|focus|blur|keydown|keyup|keypress|error|abort|cancel|toggle|wheel|contextmenu)\s*=/i.test(html);
}
function widgetNeedsIsolation(html) {
  return containsScriptTag(html) || containsInlineEventHandler(html);
}
async function injectShimsAndSizeReporter(html, ctx, iframeCtx) {
  const withExternalScripts = await transformHtmlForExternalScripts(html, ctx);
  const withFonts = await transformHtmlForGoogleFonts(withExternalScripts, ctx);
  const withoutCdnJQuery = shouldInjectJQuery(iframeCtx.env) ? stripCdnJQuery(withFonts) : withFonts;
  const stripped = rewriteCssExternalUrls(stripExternalAudioSrc(stripExternalImageSrc(withoutCdnJQuery)));
  const head = buildHeadInjection(iframeCtx);
  const withHead = injectIntoHead(headIntoBody(stripped), head);
  const shell = buildSizeReporterShell();
  const closeBody = withHead.lastIndexOf("</body>");
  if (closeBody >= 0) {
    return withHead.slice(0, closeBody) + shell + withHead.slice(closeBody);
  }
  return withHead + shell;
}
function stripExternalImageSrc(html) {
  return html.replace(/<img\b[^>]*>/gi, (tag) => tag.replace(/(\s)src\s*=\s*(['"])(https?:\/\/[^'"]+)\2/i, "$1data-vishrun-extimg=$2$3$2"));
}
var VISHRUN_CSS_SENTINEL_PREFIX = "data:application/x-vishrun-cssproxy;base64,";
function rewriteCssExternalUrls(html) {
  if (html.indexOf("url(") === -1)
    return html;
  return html.replace(/url\(\s*(['"]?)(https?:\/\/[^'")\s]+)\1\s*\)/gi, (_match, _quote, url) => {
    const encoded = btoa(url);
    return `url("${VISHRUN_CSS_SENTINEL_PREFIX}${encoded}")`;
  });
}
function buildHeadInjection(iframeCtx) {
  const jquery = shouldInjectJQuery(iframeCtx.env) ? jqueryShim() : "";
  const lodash = shouldInjectLodash(iframeCtx.env) ? lodashShim() : "";
  const thHelpers = shouldInjectThHelpersShim(iframeCtx.env) ? thHelpersShim({
    currentMessageIndex: iframeCtx.currentMessageIndex,
    currentMessageId: iframeCtx.messageId,
    chatId: iframeCtx.chatId,
    messagesSnapshot: iframeCtx.messagesSnapshot,
    greetings: cardGreetings()
  }) : "";
  const mvu = shouldInjectMvuShim(iframeCtx.env) ? mvuShim({ variablesSnapshot: iframeCtx.variablesSnapshot }) : "";
  return buildViewportHeightShim() + setChatMessagesShim() + clipboardAlertShim() + triggerSlashShim() + externalImageProxyHelper() + cssUrlProxyShim() + audioProxyHelper() + fetchBridgeShim() + fontFaceHelper() + jquery + lodash + thHelpers + mvu;
}
function cardGreetings() {
  const card = getActiveCard();
  if (!card)
    return [];
  return [card.firstMes ?? "", ...card.alternateGreetings];
}
function setChatMessagesShim() {
  const diagJson = JSON.stringify(VSH_VISHRUN_DIAG);
  return `<script>(function(){` + `var VSH_DIAG = ${diagJson};` + `var _scmCallId = 0;` + `window.setChatMessages = function(chat_messages){` + `var callId = (_scmCallId = (_scmCallId + 1) | 0);` + `if (VSH_DIAG) {` + `try { console.log('[vishrun:bridge] shim-call', JSON.stringify({` + `kind: 'set-chat-messages', fromIframeMessageId: null, input: chat_messages, callId: callId` + `})); } catch(e){}` + `}` + `try{` + `if(window.spindleSandbox && typeof window.spindleSandbox.postMessage==='function'){` + `window.spindleSandbox.postMessage({kind:'set-chat-messages',payload:chat_messages});` + `if (VSH_DIAG) {` + `try { console.log('[vishrun:bridge] shim-result', JSON.stringify({` + `kind: 'set-chat-messages', fromIframeMessageId: null, callId: callId,` + `ok: true, responseShape: 'posted'` + `})); } catch(e){}` + `}` + `}` + `}catch(e){` + `if (VSH_DIAG) {` + `try { console.log('[vishrun:bridge] shim-result', JSON.stringify({` + `kind: 'set-chat-messages', fromIframeMessageId: null, callId: callId,` + `ok: false, responseShape: 'error', responseHead: String(e && e.message || e)` + `})); } catch(_e){}` + `}` + `}` + `};` + `})();</script>`;
}
function clipboardAlertShim() {
  return `<script>(function(){` + `try{` + `if(!navigator.clipboard){Object.defineProperty(navigator,'clipboard',{value:{},configurable:true});}` + `navigator.clipboard.writeText=function(text){` + `try{window.spindleSandbox.postMessage({kind:'clipboard-write-text',payload:{text:String(text)}});return Promise.resolve();}` + `catch(e){return Promise.reject(e);}` + `};` + `}catch(e){}` + `window.alert=function(msg){` + `try{window.spindleSandbox.postMessage({kind:'alert',payload:{message:String(msg)}});}catch(e){}` + `};` + `})();</script>`;
}
function externalImageProxyHelper() {
  return `<script>
(function(){
  var KEY = 'data-vishrun-extimg';

  // Mirror of widget-iframe.ts:stripExternalImageSrc, applied here to
  // any runtime-passed HTML so the parser never sees a raw https src.
  // Short-circuits when the input has no "<img" substring — non-image
  // innerHTML assignments pay only an indexOf, no regex.
  function rewriteImgs(html) {
    if (typeof html !== 'string' || html.indexOf('<img') === -1) return html;
    return html.replace(/<img\\b[^>]*>/gi, function(tag) {
      return tag.replace(
        /(\\s)src\\s*=\\s*(['"])(https?:\\/\\/[^'"]+)\\2/i,
        '$1data-vishrun-extimg=$2$3$2'
      );
    });
  }

  // Patch HTMLImageElement.prototype.src setter — runtime-set https URLs
  // (img.src = "https://…") get diverted into the data attribute BEFORE
  // the browser starts fetching. Static src="https://..." has already
  // been stripped at host injection time; this catches the dynamic case.
  try {
    var desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (desc && desc.set && desc.get) {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function(val) {
          if (typeof val === 'string' && /^https?:\\/\\//i.test(val)) {
            this.setAttribute(KEY, val);
            // Detached loaders (new Image()) never reach the DOM scan.
            processImg(this);
            return;
          }
          return desc.set.call(this, val);
        },
      });
    }
  } catch (e) { /* ignore — fallback path is the post-load scan */ }

  // Patch Element.prototype.innerHTML setter — \`el.innerHTML = html\`
  // routes through the HTML parser which fetches each <img src="…">
  // synchronously. Pre-rewriting before the setter delegates means the
  // parser never sees a raw https src.
  try {
    var innerDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    if (innerDesc && innerDesc.set && innerDesc.get) {
      Object.defineProperty(Element.prototype, 'innerHTML', {
        configurable: true,
        enumerable: innerDesc.enumerable,
        get: innerDesc.get,
        set: function(val) {
          return innerDesc.set.call(this, rewriteImgs(val));
        },
      });
    }
  } catch (e) {}

  // Patch Element.prototype.outerHTML setter — same reasoning as
  // innerHTML; less common but cards do use it.
  try {
    var outerDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');
    if (outerDesc && outerDesc.set && outerDesc.get) {
      Object.defineProperty(Element.prototype, 'outerHTML', {
        configurable: true,
        enumerable: outerDesc.enumerable,
        get: outerDesc.get,
        set: function(val) {
          return outerDesc.set.call(this, rewriteImgs(val));
        },
      });
    }
  } catch (e) {}

  // Patch Element.prototype.insertAdjacentHTML — same story; the parser
  // is invoked on the second argument.
  try {
    var origIAH = Element.prototype.insertAdjacentHTML;
    if (typeof origIAH === 'function') {
      Element.prototype.insertAdjacentHTML = function(position, html) {
        return origIAH.call(this, position, rewriteImgs(html));
      };
    }
  } catch (e) {}

  // Patch Element.prototype.setAttribute — \`img.setAttribute('src', url)\`
  // doesn't go through HTMLImageElement.prototype.src's IDL setter, so
  // the existing patch above misses it. Catch the IMG/src/https case and
  // redirect to the data attribute. All other setAttribute calls fall
  // through to the original — the wrapper short-circuits in one
  // string-compare for the overwhelming majority of calls.
  try {
    var origSetAttr = Element.prototype.setAttribute;
    if (typeof origSetAttr === 'function') {
      Element.prototype.setAttribute = function(name, value) {
        if (
          this.tagName === 'IMG' &&
          typeof name === 'string' &&
          name.toLowerCase() === 'src' &&
          typeof value === 'string' &&
          /^https?:\\/\\//i.test(value)
        ) {
          origSetAttr.call(this, KEY, value);
          processImg(this);
          return;
        }
        return origSetAttr.call(this, name, value);
      };
    }
  } catch (e) {}

  function setBlobSrc(img, blobUrl) {
    // Bypass the patched setter via the native descriptor — assigning
    // \`img.src = blobUrl\` would route through our wrapper again. Using
    // setAttribute avoids the IDL setter entirely.
    img.removeAttribute(KEY);
    img.setAttribute('src', blobUrl);
  }

  function processImg(img) {
    var url = img.getAttribute(KEY);
    if (!url) return;
    if (!window.spindleSandbox || typeof window.spindleSandbox.corsProxy !== 'function') {
      console.warn('[vishrun] corsProxy unavailable, leaving image unfetched:', url);
      return;
    }
    // Mark in-flight so a MutationObserver re-fire doesn't double-fetch.
    img.removeAttribute(KEY);
    img.setAttribute('data-vishrun-extimg-loading', '1');
    img.__vishrunWant = url;
    proxiedImageUrl(url).then(
      function(blobUrl) {
        img.removeAttribute('data-vishrun-extimg-loading');
        if (img.__vishrunWant !== url) return;
        setBlobSrc(img, blobUrl);
      },
      function(err) {
        img.removeAttribute('data-vishrun-extimg-loading');
        console.warn('[vishrun] corsProxy fetch failed for', url, err);
      }
    );
  }

  // One fetch per URL: preloaders and the visible <img> share the blob.
  var imageCache = {};
  function proxiedImageUrl(url) {
    if (imageCache[url]) return imageCache[url];
    var p = window.spindleSandbox.corsProxy(url, { responseType: 'arraybuffer' }).then(function(res) {
      if (!res || !res.body) throw new Error('no body');
      var ct = '';
      if (res.headers) ct = res.headers['content-type'] || res.headers['Content-Type'] || '';
      ct = String(ct).split(';')[0].trim() || 'application/octet-stream';
      return URL.createObjectURL(new Blob([res.body], { type: ct }));
    });
    imageCache[url] = p;
    p.catch(function() { delete imageCache[url]; });
    return p;
  }
  window.__vishrunProxiedImageUrl = proxiedImageUrl;

  function scan(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    var imgs = root.querySelectorAll('img[' + KEY + ']');
    for (var i = 0; i < imgs.length; i++) processImg(imgs[i]);
  }

  // ─── CSS url() sentinels ──────────────────────────────────────────────
  //
  // Host pre-rewrites \`url(['"]?https?://X['"]?)\` in <style> blocks and
  // inline style="..." attributes to a sentinel data URL of the form
  // \`data:application/x-vishrun-cssproxy;base64,<base64-of-X>\`. This
  // resolver decodes each unique sentinel, fetches the original URL via
  // corsProxy, builds a Blob, and replaces every occurrence of the
  // sentinel in <style> textContent and [style] attributes with the new
  // blob: URL. Cards see only the static replaceString — same as imgs.
  var CSS_SENTINEL_PREFIX = 'data:application/x-vishrun-cssproxy;base64,';
  var CSS_SENTINEL_RE = /data:application\\/x-vishrun-cssproxy;base64,([A-Za-z0-9+/=]+)/g;
  // sentinel string -> blob URL once resolved, '__pending' while in flight,
  // empty string for terminal failures (skip retry).
  var cssBlobCache = {};

  function decodeCssSentinel(sentinel) {
    var idx = sentinel.indexOf(',');
    if (idx === -1) return null;
    try {
      return atob(sentinel.slice(idx + 1));
    } catch (e) {
      return null;
    }
  }

  function findCssSentinels() {
    var found = {};
    var styles = document.querySelectorAll('style');
    for (var i = 0; i < styles.length; i++) {
      var t = styles[i].textContent || '';
      if (t.indexOf(CSS_SENTINEL_PREFIX) === -1) continue;
      var m;
      CSS_SENTINEL_RE.lastIndex = 0;
      while ((m = CSS_SENTINEL_RE.exec(t)) !== null) found[m[0]] = true;
    }
    var styled = document.querySelectorAll('[style]');
    for (var i = 0; i < styled.length; i++) {
      var s = styled[i].getAttribute('style') || '';
      if (s.indexOf(CSS_SENTINEL_PREFIX) === -1) continue;
      var m2;
      CSS_SENTINEL_RE.lastIndex = 0;
      while ((m2 = CSS_SENTINEL_RE.exec(s)) !== null) found[m2[0]] = true;
    }
    return Object.keys(found);
  }

  function replaceCssSentinel(sentinel, blobUrl) {
    var styles = document.querySelectorAll('style');
    for (var i = 0; i < styles.length; i++) {
      var t = styles[i].textContent || '';
      if (t.indexOf(sentinel) === -1) continue;
      // textContent reassign re-parses the stylesheet, picking up the
      // blob URL on the next style recompute. Cards in scope don't hold
      // CSSOM rule references, so this is safe.
      styles[i].textContent = t.split(sentinel).join(blobUrl);
    }
    var styled = document.querySelectorAll('[style]');
    for (var i = 0; i < styled.length; i++) {
      var s = styled[i].getAttribute('style') || '';
      if (s.indexOf(sentinel) === -1) continue;
      styled[i].setAttribute('style', s.split(sentinel).join(blobUrl));
    }
  }

  function processCssSentinels() {
    if (!window.spindleSandbox || typeof window.spindleSandbox.corsProxy !== 'function') return;
    var sentinels = findCssSentinels();
    for (var i = 0; i < sentinels.length; i++) {
      var sentinel = sentinels[i];
      var cached = cssBlobCache[sentinel];
      if (cached === '__pending' || (typeof cached === 'string' && cached.length > 0)) continue;
      if (cached === '') continue; // prior failure, don't retry
      var url = decodeCssSentinel(sentinel);
      if (!url) {
        cssBlobCache[sentinel] = '';
        continue;
      }
      cssBlobCache[sentinel] = '__pending';
      (function(snt, u) {
        window.spindleSandbox.corsProxy(u, { responseType: 'arraybuffer' }).then(
          function(res) {
            try {
              if (!res || !res.body) {
                console.warn('[vishrun] css corsProxy returned no body for', u);
                cssBlobCache[snt] = '';
                return;
              }
              var ct = '';
              if (res.headers) {
                ct = res.headers['content-type'] || res.headers['Content-Type'] || '';
              }
              ct = String(ct).split(';')[0].trim() || 'application/octet-stream';
              var blob = new Blob([res.body], { type: ct });
              var blobUrl = URL.createObjectURL(blob);
              cssBlobCache[snt] = blobUrl;
              replaceCssSentinel(snt, blobUrl);
            } catch (e) {
              console.warn('[vishrun] css decode failed for', u, e);
              cssBlobCache[snt] = '';
            }
          },
          function(err) {
            console.warn('[vishrun] css corsProxy fetch failed for', u, err);
            cssBlobCache[snt] = '';
          }
        );
      })(sentinel, url);
    }
  }

  function init() {
    scan(document);
    processCssSentinels();
    try {
      var mo = new MutationObserver(function(mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var mut = mutations[i];
          if (mut.type === 'attributes' && mut.attributeName === KEY) {
            if (mut.target && mut.target.nodeType === 1 && mut.target.tagName === 'IMG') {
              processImg(mut.target);
            }
            continue;
          }
          var added = mut.addedNodes;
          if (!added) continue;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'IMG' && n.hasAttribute(KEY)) processImg(n);
            else scan(n);
          }
        }
      });
      mo.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [KEY],
      });
    } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
</script>`;
}
function fontFaceHelper() {
  return `<script>
(function(){
  var loadedFontUrls = {};

  function loadOneVishrunFont(entry) {
    if (!window.spindleSandbox || typeof window.spindleSandbox.fetchFont !== 'function') return;
    if (!entry || !entry.url || !entry.family) return;
    if (typeof FontFace === 'undefined' || !document.fonts || typeof document.fonts.add !== 'function') return;
    var key = entry.url;
    if (loadedFontUrls[key]) return;
    loadedFontUrls[key] = true;
    window.spindleSandbox.fetchFont(entry.url).then(function(resource) {
      if (!resource || !resource.url) {
        loadedFontUrls[key] = false;
        return;
      }
      try {
        var face = new FontFace(entry.family, 'url(' + resource.url + ')', {
          weight: entry.weight || '400',
          style: entry.style || 'normal',
          display: entry.display || 'swap'
        });
        return face.load().then(function() { document.fonts.add(face); });
      } catch (e) {
        loadedFontUrls[key] = false;
        console.warn('[vishrun] FontFace construct failed for', entry.url, e);
      }
    }).catch(function(err) {
      loadedFontUrls[key] = false;
      console.warn('[vishrun] fetchFont failed for', entry.url, err);
    });
  }

  function processVishrunFonts() {
    var scripts = document.querySelectorAll('script[data-vishrun-fonts]');
    for (var s = 0; s < scripts.length; s++) {
      var entries;
      try { entries = JSON.parse(scripts[s].textContent || '[]'); }
      catch (e) { continue; }
      if (!entries || typeof entries.length !== 'number') continue;
      for (var i = 0; i < entries.length; i++) loadOneVishrunFont(entries[i]);
    }
  }

  function init() {
    processVishrunFonts();
    try {
      var mo = new MutationObserver(function() { processVishrunFonts(); });
      mo.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
</script>`;
}
function headIntoBody(html) {
  const open = /<head\b[^>]*>/i.exec(html);
  if (!open)
    return html;
  const bodyAt = html.search(/<body\b/i);
  if (bodyAt >= 0 && bodyAt < open.index)
    return html;
  const closeAt = html.toLowerCase().indexOf("</head>", open.index + open[0].length);
  if (closeAt < 0)
    return html;
  const inner = html.slice(open.index + open[0].length, closeAt);
  if (inner.trim() === "")
    return html;
  const without = html.slice(0, open.index + open[0].length) + html.slice(closeAt);
  const body = /<body\b[^>]*>/i.exec(without);
  if (!body)
    return without.slice(0, open.index + open[0].length) + "</head>" + inner + without.slice(open.index + open[0].length + "</head>".length);
  const at = body.index + body[0].length;
  return without.slice(0, at) + inner + without.slice(at);
}
function injectIntoHead(html, blob) {
  const openHead = html.match(/<head\b[^>]*>/i);
  if (openHead && openHead.index !== undefined) {
    const idx = openHead.index + openHead[0].length;
    return html.slice(0, idx) + blob + html.slice(idx);
  }
  return blob + html;
}
function routeChildMessage(frame, payload, ctx, iframeCtx) {
  if (!payload || typeof payload !== "object")
    return;
  const p = payload;
  if (p.kind === "set-chat-messages") {
    handleSetChatMessages(frame.element, p.payload, ctx);
  } else if (p.kind === "clipboard-write-text") {
    handleClipboardWriteText(p.payload, ctx);
  } else if (p.kind === "trigger-slash") {
    handleTriggerSlash(p.payload, ctx);
  } else if (p.kind === "alert") {
    handleHostAlert(p.payload);
  } else if (isWidgetFetch(payload)) {
    dispatchWidgetFetch(frame, payload, ctx);
  } else if (isThRequest(payload)) {
    dispatchThRequest(frame, payload, {
      chatId: iframeCtx.chatId,
      currentMessageId: iframeCtx.messageId,
      currentMessageIndex: iframeCtx.currentMessageIndex
    }, ctx);
  }
}
async function handleSetChatMessages(iframe, payload, ctx) {
  if (!Array.isArray(payload)) {
    console.warn("[vishrun] setChatMessages: payload is not an array, ignoring");
    return;
  }
  const messageEl = deepClosest(iframe, "[data-message-id]");
  const messageId = messageEl?.getAttribute("data-message-id");
  if (!messageId) {
    console.warn("[vishrun] setChatMessages: cannot resolve messageId from iframe ancestry, ignoring");
    return;
  }
  const active = ctx.getActiveChat();
  const chatId = active.chatId;
  if (!chatId) {
    console.warn("[vishrun] setChatMessages: no active chat, ignoring");
    return;
  }
  const card = getActiveCard();
  if (!card) {
    console.warn("[vishrun] setChatMessages: no active card cached, ignoring");
    return;
  }
  for (const entry of payload) {
    if (!entry || typeof entry !== "object")
      continue;
    const e = entry;
    if (typeof e.message_id !== "number" || e.message_id !== 0) {
      console.debug("[vishrun] setChatMessages: skipping entry with message_id !== 0", e);
      continue;
    }
    const swipeId = typeof e.swipe_id === "number" ? e.swipe_id : 0;
    if (VSH_VISHRUN_DIAG) {
      console.log("[vishrun:bridge] set-chat-messages received", JSON.stringify({
        messageId,
        swipeId,
        hasCard: !!card
      }));
    }
    let targetContent;
    let targetGreetingIndex = -1;
    if (swipeId === 0) {
      targetContent = card.firstMes ?? undefined;
      targetGreetingIndex = 0;
    } else if (swipeId >= 1) {
      targetContent = card.alternateGreetings[swipeId - 1];
      targetGreetingIndex = swipeId;
    }
    if (typeof targetContent !== "string" || !targetContent) {
      console.warn(`[vishrun] setChatMessages: out-of-range swipe_id=${swipeId} ` + `(have first_mes=${card.firstMes ? "yes" : "no"}, ` + `alternate_greetings.length=${card.alternateGreetings.length}), aborting entry`);
      continue;
    }
    if (VSH_VISHRUN_DIAG) {
      console.log("[vishrun:bridge] set-chat-messages target-resolved", JSON.stringify({
        targetGreetingIndex,
        targetContentLen: targetContent.length,
        targetContentHead: targetContent.slice(0, 200)
      }));
    }
    try {
      await updateMessageContent(chatId, messageId, targetContent);
      if (VSH_VISHRUN_DIAG) {
        console.log("[vishrun:bridge] set-chat-messages update", JSON.stringify({
          messageId,
          contentLen: targetContent.length
        }));
      }
    } catch (err) {
      if (VSH_VISHRUN_DIAG) {
        console.log("[vishrun:bridge] set-chat-messages error", JSON.stringify({
          error: err instanceof Error ? err.message : String(err)
        }));
      }
      console.warn("[vishrun] setChatMessages: update failed", err);
      continue;
    }
  }
}

// src/hooks/tag-interceptor.ts
var capturesByMessage = new Map;
function getCapturesForMessage(messageId) {
  return capturesByMessage.get(messageId) || [];
}
var activeUnsubs = [];
var activeTagNames = new Set;
function syncTagInterceptors(ctx, compiled, recovery) {
  const desired = new Map;
  for (const s of compiled) {
    if (s.kind !== "pairedTag" || s.native)
      continue;
    const tags = extractAllTagNames(s.findRe.source);
    if (tags.length === 0) {
      console.debug(`[vishrun] paired-tag script "${s.scriptName}" classified as pairedTag but ` + `no tag name extractable — skipping. findRegex source: ${s.findRe.source}`);
      continue;
    }
    const anchor = tags[0].toLowerCase();
    if (!desired.has(anchor))
      desired.set(anchor, { script: s, role: "capture" });
  }
  for (const s of compiled) {
    if (s.kind !== "pairedTag" || s.native)
      continue;
    const tags = extractAllTagNames(s.findRe.source);
    for (let i = 1;i < tags.length; i++) {
      const key = tags[i].toLowerCase();
      if (!desired.has(key))
        desired.set(key, { script: s, role: "strip" });
    }
  }
  if (desired.size === activeTagNames.size && [...desired.keys()].every((t) => activeTagNames.has(t))) {
    return;
  }
  activeUnsubs.forEach((u) => {
    try {
      u();
    } catch {}
  });
  activeUnsubs = [];
  activeTagNames = new Set(desired.keys());
  for (const [tagName, reg] of desired) {
    const handler = reg.role === "capture" ? (payload) => onCapture(payload, reg.script, recovery) : () => {};
    const unsub = ctx.messages.registerTagInterceptor({ tagName, removeFromMessage: true }, handler);
    activeUnsubs.push(unsub);
  }
}
function teardownTagInterceptors() {
  activeUnsubs.forEach((u) => {
    try {
      u();
    } catch {}
  });
  activeUnsubs = [];
  activeTagNames = new Set;
}
function syncStrippedTagCaptures(messageId, content, compiled) {
  const text = content.replace(/\r\n?/g, `
`);
  const isStripped = (id) => compiled.some((s) => s.id === id && s.kind === "strippedTag");
  const current = capturesByMessage.get(messageId) || [];
  const kept = current.filter((c) => !isStripped(c.scriptId));
  const fresh = [];
  for (const script of compiled) {
    if (script.kind !== "strippedTag" || script.native)
      continue;
    const re = new RegExp(script.findRe.source, script.findRe.flags);
    let last = null;
    let m;
    while ((m = re.exec(text)) !== null) {
      last = m;
      if (m[0].length === 0)
        re.lastIndex++;
    }
    if (last) {
      fresh.push({
        scriptId: script.id,
        scriptName: script.scriptName,
        replaceString: script.replaceString,
        findRe: script.findRe,
        fullMatch: last[0],
        attrs: {}
      });
    }
  }
  const key = (c) => c.scriptId + "\x01" + c.fullMatch;
  const before = current.filter((c) => isStripped(c.scriptId)).map(key);
  const after = fresh.map(key);
  const changed = before.length !== after.length || before.some((k, i) => k !== after[i]);
  const list = kept.concat(fresh);
  if (list.length === 0)
    capturesByMessage.delete(messageId);
  else
    capturesByMessage.set(messageId, list);
  return changed;
}
function rebuildCapturesFromContent(messageId, content, compiled, _eventName) {
  const newList = [];
  let working = content;
  for (const script of compiled) {
    if (script.kind !== "pairedTag" && script.kind !== "strippedTag" || script.native)
      continue;
    script.findRe.lastIndex = 0;
    let lastMatch = null;
    let m;
    while ((m = script.findRe.exec(working)) !== null) {
      lastMatch = m;
      if (m[0].length === 0)
        script.findRe.lastIndex++;
    }
    if (lastMatch) {
      newList.push({
        scriptId: script.id,
        scriptName: script.scriptName,
        replaceString: script.replaceString,
        findRe: script.findRe,
        fullMatch: lastMatch[0],
        attrs: {}
      });
    }
    script.findRe.lastIndex = 0;
    working = working.replace(script.findRe, "");
    script.findRe.lastIndex = 0;
  }
  const existing = capturesByMessage.get(messageId) || [];
  let changed = existing.length !== newList.length;
  if (!changed) {
    for (const next of newList) {
      const prev = existing.find((c) => c.scriptId === next.scriptId);
      if (!prev || prev.fullMatch !== next.fullMatch) {
        changed = true;
        break;
      }
    }
  }
  if (changed) {
    if (newList.length === 0) {
      capturesByMessage.delete(messageId);
    } else {
      capturesByMessage.set(messageId, newList);
    }
  }
  return changed;
}
var recoveryInFlight = new Set;
function onCapture(payload, script, recovery) {
  if (!payload.messageId)
    return;
  script.findRe.lastIndex = 0;
  const selfMatches = script.findRe.test(payload.fullMatch);
  script.findRe.lastIndex = 0;
  if (selfMatches) {
    storeCapture(payload.messageId, script, payload.fullMatch, payload.attrs);
    return;
  }
  if (!recovery || !payload.chatId) {
    storeCapture(payload.messageId, script, payload.fullMatch, payload.attrs);
    return;
  }
  recoverFullCapture(payload.messageId, payload.chatId, script, payload, recovery);
}
function storeCapture(messageId, script, fullMatch, attrs) {
  const existing = capturesByMessage.get(messageId) || [];
  const list = existing.filter((c) => c.scriptId !== script.id);
  list.push({
    scriptId: script.id,
    scriptName: script.scriptName,
    replaceString: script.replaceString,
    findRe: script.findRe,
    fullMatch,
    attrs
  });
  capturesByMessage.set(messageId, list);
}
async function recoverFullCapture(messageId, chatId, script, payload, recovery) {
  if (recoveryInFlight.has(messageId))
    return;
  recoveryInFlight.add(messageId);
  try {
    let content = null;
    try {
      content = await recovery.fetchContent(chatId, messageId);
    } catch {
      content = null;
    }
    if (content == null) {
      storeCapture(messageId, script, payload.fullMatch, payload.attrs);
      recovery.reprocess(messageId);
      return;
    }
    const changed = rebuildCapturesFromContent(messageId, content, recovery.compiled);
    if (changed)
      recovery.reprocess(messageId);
  } finally {
    recoveryInFlight.delete(messageId);
  }
}
var OPEN_TAG_RE2 = /<(?:\\s\*|\s)*([a-zA-Z_][a-zA-Z0-9_-]*)/g;
function extractAllTagNames(reSource) {
  OPEN_TAG_RE2.lastIndex = 0;
  const names = [];
  const seen = new Set;
  let m;
  while ((m = OPEN_TAG_RE2.exec(reSource)) !== null) {
    const lower = m[1].toLowerCase();
    if (seen.has(lower))
      continue;
    seen.add(lower);
    names.push(m[1]);
  }
  return names;
}

// src/core/macro-detection.ts
var MACRO_RE = /\{\{\s*[A-Za-z_@$][\w@$]*\s*(?:::|\}\})/;
function hasMacros(html) {
  return MACRO_RE.test(html);
}

// src/core/macro-resolver.ts
function isResolveMacrosResponse(p, requestId) {
  return !!p && typeof p === "object" && p.type === "resolve_macros_response" && p.requestId === requestId && Array.isArray(p.results);
}
var requestCounter3 = 0;
function nextRequestId3() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `vishrun-rm-${Date.now()}-${++requestCounter3}`;
}
var RESOLVE_TIMEOUT_MS = 5000;
function resolveMacrosBatch(ctx, chatId, characterId, templates, timeoutMs = RESOLVE_TIMEOUT_MS) {
  if (templates.length === 0)
    return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId3();
    let settled = false;
    let unsub = null;
    let timer = null;
    const finish = (run) => {
      if (settled)
        return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsub) {
        try {
          unsub();
        } catch {}
        unsub = null;
      }
      run();
    };
    unsub = ctx.onBackendMessage((payload) => {
      if (!isResolveMacrosResponse(payload, requestId))
        return;
      if (payload.results.length === templates.length && payload.results.every((r) => typeof r === "string")) {
        const results = payload.results;
        finish(() => resolve(results));
      } else {
        finish(() => reject(new Error("resolve_macros malformed response")));
      }
    });
    timer = setTimeout(() => {
      finish(() => reject(new Error("resolve_macros timeout")));
    }, timeoutMs);
    try {
      ctx.sendToBackend({
        type: "resolve_macros",
        requestId,
        chatId,
        characterId: characterId ?? undefined,
        templates
      });
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

// src/render/linearize-bubble.ts
var BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "BLOCKQUOTE",
  "PRE",
  "UL",
  "OL",
  "LI",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR"
]);
function linearizeBubble(root) {
  let text = "";
  const offsetMap = [];
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node;
      const value = t.nodeValue ?? "";
      if (value.length === 0)
        return;
      const sourceStart = text.length;
      text += value;
      offsetMap.push({
        node: t,
        nodeStart: 0,
        nodeEnd: value.length,
        sourceStart,
        sourceEnd: text.length
      });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE)
      return;
    const el = node;
    if (el.hasAttribute && el.hasAttribute("data-vishrun-widget"))
      return;
    if (isNonTextElement(el))
      return;
    if (el.tagName === "BR") {
      text += `
`;
      return;
    }
    const isBlock = BLOCK_TAGS.has(el.tagName);
    let prevText = "";
    if (isBlock && text.length > 0 && !text.endsWith(`

`)) {
      prevText = text.endsWith(`
`) ? `
` : `

`;
      text += prevText;
    }
    for (const child of renderedChildNodes(el))
      walk(child);
    if (isBlock && text.length > 0 && !text.endsWith(`

`)) {
      text += text.endsWith(`
`) ? `
` : `

`;
    }
  }
  for (const child of Array.from(root.childNodes))
    walk(child);
  while (text.endsWith(`
`))
    text = text.slice(0, -1);
  return { text, offsetMap };
}
var cache2 = new WeakMap;
function getLinearizedBubble(root) {
  const tc = deepTextContent(root);
  const hash = quickHash(tc);
  const cached = cache2.get(root);
  if (cached && cached.hash === hash)
    return cached.result;
  const result = linearizeBubble(root);
  cache2.set(root, { hash, result });
  return result;
}
function invalidateLinearizedBubble(root) {
  cache2.delete(root);
}
function quickHash(s) {
  let h = 2166136261;
  for (let i = 0;i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// src/render/paired-anchor.ts
var MARKER = "vishrun-anchor-marker";
function cssEsc(s) {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/[^\w-]/g, (c) => "\\" + c);
}
function signature(el) {
  const classes = Array.from(el.classList).filter(Boolean);
  if (classes.length === 0)
    return null;
  return el.tagName.toLowerCase() + classes.map((c) => "." + cssEsc(c)).join("");
}
function computePairedAnchor(rawContentIn, fullMatchIn) {
  const rawContent = rawContentIn.replace(/\r\n?/g, `
`);
  const fullMatch = fullMatchIn.replace(/\r\n?/g, `
`);
  const idx = rawContent.indexOf(fullMatch);
  if (idx < 0 || typeof DOMParser === "undefined")
    return null;
  const marked = rawContent.slice(0, idx) + `<${MARKER}></${MARKER}>` + rawContent.slice(idx + fullMatch.length);
  const doc = new DOMParser().parseFromString(marked, "text/html");
  const marker = doc.querySelector(MARKER);
  if (!marker)
    return null;
  let anchor = marker.parentElement;
  let sel = null;
  while (anchor && anchor !== doc.body) {
    sel = signature(anchor);
    if (sel)
      break;
    anchor = anchor.parentElement;
  }
  if (!anchor || !sel || anchor === doc.body)
    return null;
  const occurrence = Array.from(doc.querySelectorAll(sel)).indexOf(anchor);
  let beforeSelector = null;
  if (marker.parentElement === anchor) {
    for (let n = marker.nextElementSibling;n; n = n.nextElementSibling) {
      beforeSelector = signature(n);
      if (beforeSelector)
        break;
    }
  }
  return { selector: sel, occurrence, beforeSelector };
}
function placeAtAnchor(root, anchor, widget) {
  const candidates = deepQuerySelectorAll(root, anchor.selector).filter((el) => !el.closest("[data-vishrun-widget]"));
  const target = candidates[anchor.occurrence];
  if (!target)
    return false;
  if (anchor.beforeSelector) {
    const ref = Array.from(target.children).find((c) => c.matches(anchor.beforeSelector));
    if (ref) {
      target.insertBefore(widget, ref);
      return true;
    }
  }
  target.appendChild(widget);
  return true;
}

// src/lumiverse/fetch-message.ts
async function fetchMessageContentById(chatId, messageId) {
  const m = (await getChatMessages(chatId)).find((mm) => mm.id === messageId);
  return m ? m.content : null;
}
var fetchMessageContent = fetchMessageContentById;

// src/state/generation.ts
var generating = false;
function setGenerating(v) {
  generating = v;
}
function isGenerating() {
  return generating;
}
function isLatestMessage(messageId, doc = document) {
  const all = doc.querySelectorAll("[data-message-id]");
  const last = all[all.length - 1];
  return !!last && last.getAttribute("data-message-id") === messageId;
}

// src/render/inject-into-message.ts
var resolutionCache = new Map;
var editingMessageIds = new Set;
function computeEditModeTransition(root, messageId, editingSet) {
  const hasTextarea = !!root.querySelector("textarea");
  const hasMessageContent = !!root.querySelector('[data-component="MessageContent"]');
  const inEditMode = hasTextarea && !hasMessageContent;
  const wasEditing = editingSet.has(messageId);
  if (inEditMode && !wasEditing) {
    editingSet.add(messageId);
    return "enter";
  }
  if (inEditMode && wasEditing)
    return "still";
  if (!inEditMode && wasEditing) {
    editingSet.delete(messageId);
    return "exit";
  }
  return "idle";
}
function clearEditingMessageIds() {
  editingMessageIds.clear();
}
var messageQueue = new Map;
function processNode(root, scripts, ctx) {
  const id = root.getAttribute("data-message-id");
  if (!id)
    return Promise.resolve(0);
  const prev = messageQueue.get(id) ?? Promise.resolve(0);
  const next = prev.catch(() => 0).then(() => processNodeNow(root, scripts, ctx));
  messageQueue.set(id, next);
  next.finally(() => {
    if (messageQueue.get(id) === next)
      messageQueue.delete(id);
  });
  return next;
}
async function processNodeNow(root, scripts, ctx) {
  const messageId = root.getAttribute("data-message-id") || undefined;
  if (!messageId) {
    return 0;
  }
  const transition = computeEditModeTransition(root, messageId, editingMessageIds);
  if (VSH_VISHRUN_DIAG) {
    if (transition === "enter") {
      console.log("[vishrun:edit-mode] transition", {
        messageId,
        phase: "enter",
        signal: "textarea-without-MessageContent"
      });
    } else if (transition === "exit") {
      console.log("[vishrun:edit-mode] transition", { messageId, phase: "exit" });
    }
  }
  if (transition === "enter") {
    destroyAllRegisteredWidgetsForMessage(messageId, "edit-mode-enter");
    return 0;
  }
  if (transition === "still")
    return 0;
  const target = findContentRoot(root);
  cleanupOrphansForMessage(messageId, target);
  try {
    await refreshStrippedTagCaptures(target, scripts, messageId, ctx);
    await reconcileNestedTagCaptures(scripts, messageId, ctx);
  } catch (err) {
    console.debug("[vishrun] tag capture refresh failed:", err);
  }
  const resolvedMap = await resolveMacrosForMessage(root, scripts, messageId, ctx);
  let total = 0;
  clearPending(target);
  try {
    for (const script of scripts) {
      if (!isPlaceholderLikeKind(script.kind) || script.native)
        continue;
      if (script.kind === "delimitedCaptureMultiLine") {
        total += await replaceMultiLineMatches(root, script, scripts, messageId, ctx, resolvedMap);
      } else {
        total += await replacePlaceholderMatches(root, script, scripts, messageId, ctx, resolvedMap);
      }
    }
    total += await renderPairedTagCaptures(root, scripts, messageId, ctx, resolvedMap);
  } catch (err) {
    console.debug("[vishrun] processNode render error:", err);
  }
  return total;
}
async function resolveMacrosForMessage(root, scripts, messageId, ctx) {
  const map = new Map;
  if (!scripts.some((s) => s.replaceString.includes("{{")))
    return map;
  const templates = collectExpandedTemplates(root, scripts, messageId).filter(hasMacros);
  if (templates.length === 0)
    return map;
  const { chatId, characterId } = ctx.getActiveChat();
  if (!chatId) {
    console.warn("[vishrun:variables] no active chatId; widget macros left unresolved");
    return map;
  }
  try {
    const resolved = await resolveMacrosBatch(ctx, chatId, characterId, templates);
    templates.forEach((t, i) => {
      map.set(t, resolved[i]);
      resolutionCache.set(t, resolved[i]);
    });
  } catch (err) {
    console.warn("[vishrun:variables] macro resolve failed; widgets render unresolved:", err instanceof Error ? err.message : String(err));
  }
  return map;
}
function collectExpandedTemplates(root, scripts, messageId) {
  const out = new Set;
  const textNodes = collectTextNodes(root);
  for (const script of scripts) {
    if (!isPlaceholderLikeKind(script.kind) || script.native)
      continue;
    if (script.kind === "delimitedCaptureMultiLine") {
      const bubble = findContentRoot(root);
      const linear = getLinearizedBubble(bubble);
      script.findRe.lastIndex = 0;
      let m;
      while ((m = script.findRe.exec(linear.text)) !== null) {
        const groups = m.slice(1).map((g) => g ?? "");
        const html = substitute(script.replaceString, m[0], groups);
        out.add(applyNestedPipeline(html, scripts, new Set([script.id]), 0));
        if (m[0].length === 0)
          script.findRe.lastIndex++;
      }
      continue;
    }
    for (const tn of textNodes) {
      const text = tn.nodeValue ?? "";
      if (!text)
        continue;
      script.findRe.lastIndex = 0;
      let m;
      while ((m = script.findRe.exec(text)) !== null) {
        const groups = m.slice(1).map((g) => g ?? "");
        const html = substitute(script.replaceString, m[0], groups);
        out.add(applyNestedPipeline(html, scripts, new Set([script.id]), 0));
        if (m[0].length === 0)
          script.findRe.lastIndex++;
      }
    }
  }
  const target = findContentRoot(root);
  for (const cap of getCapturesForMessage(messageId)) {
    const sel = `[data-vishrun-widget][data-vishrun-script-id="${cssEscape(cap.scriptId)}"][data-vishrun-paired-fullmatch="${cssEscape(hashKey(cap.fullMatch))}"]`;
    if (target.querySelector(sel))
      continue;
    cap.findRe.lastIndex = 0;
    const m = cap.findRe.exec(cap.fullMatch);
    if (!m)
      continue;
    const groups = m.slice(1).map((g) => g ?? "");
    const html = substitute(cap.replaceString, m[0], groups);
    out.add(applyNestedPipeline(html, scripts, new Set([cap.scriptId]), 0));
  }
  return [...out];
}
async function replaceMultiLineMatches(root, script, allScripts, messageId, ctx, resolvedMap) {
  const bubble = findContentRoot(root);
  if (!bubble.isConnected)
    return 0;
  const linear = getLinearizedBubble(bubble);
  if (linear.text.length === 0)
    return 0;
  script.findRe.lastIndex = 0;
  const matches = [];
  let m;
  while ((m = script.findRe.exec(linear.text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length, match: m, occurrence: matches.length });
    if (m[0].length === 0)
      script.findRe.lastIndex++;
  }
  const outer = outerRangesFromLaterScripts(linear.text, script, allScripts);
  for (let i = matches.length - 1;i >= 0; i--) {
    const { start, end } = matches[i];
    if (outer.some(([s, e]) => s < start && end <= e))
      matches.splice(i, 1);
  }
  if (isGenerating() && isLatestMessage(messageId)) {
    const src = script.findRe.source;
    for (const open of leadingLiterals(src)) {
      for (const close of trailingLiterals(src)) {
        for (const [s, e] of unterminatedRanges(linear.text, open, close))
          hideRange(bubble, linear.offsetMap, s, e);
      }
    }
  }
  if (matches.length === 0)
    return 0;
  for (const { start, end } of matches)
    hideRange(bubble, linear.offsetMap, start, end);
  if (hasRegisteredWidgetsFor(messageId, script.id)) {
    destroyRegisteredWidgetsFor(messageId, script.id);
  }
  const rawMatches = await rawMatchesWithStrippedTags(script, messageId, ctx);
  let count = 0;
  for (let i = matches.length - 1;i >= 0; i--) {
    const { start, end, occurrence } = matches[i];
    let match = matches[i].match;
    const raw = rawMatches?.matches[occurrence];
    if (raw) {
      match = raw;
      for (const fm of rawMatches.pairedInside(raw[0]))
        consumedPairedMatches.add(messageId + "\x01" + fm);
    }
    const groups = match.slice(1).map((g) => g ?? "");
    const html = substitute(script.replaceString, match[0], groups);
    const expanded = applyNestedPipeline(html, allScripts, new Set([script.id]), 0);
    const fromMap = resolvedMap.get(expanded);
    const fromCache = fromMap ?? resolutionCache.get(expanded);
    const finalHtml = fromCache ?? expanded;
    const widget = await buildWidget(finalHtml, script.scriptName, script.id, messageId, ctx);
    setWidgetSource(widget, linear.text.slice(start, end));
    const placed = replaceLinearRange(bubble, linear.offsetMap, start, end, widget);
    if (placed) {
      count++;
    } else {
      if (VSH_VISHRUN_DIAG) {
        console.log("[vishrun:render] placeholder-skipped", JSON.stringify({
          messageId,
          scriptId: script.id,
          reason: "replaceLinearRange-failed"
        }));
      }
      if (widget.tagName === "IFRAME") {
        destroyWidgetIframe(widget);
      }
      clearPending(bubble);
    }
  }
  invalidateLinearizedBubble(bubble);
  return count;
}
var consumedPairedMatches = new Set;
function isConsumedPaired(messageId, fullMatch) {
  return consumedPairedMatches.has(messageId + "\x01" + fullMatch.replace(/\r\n?/g, `
`));
}
async function rawMatchesWithStrippedTags(script, messageId, ctx) {
  const caps = getCapturesForMessage(messageId);
  if (caps.length === 0)
    return null;
  const chatId = ctx.getActiveChat().chatId;
  if (!chatId)
    return null;
  let raw = null;
  try {
    raw = await fetchMessageContent(chatId, messageId);
  } catch {
    return null;
  }
  if (!raw)
    return null;
  const text = raw.replace(/\r\n?/g, `
`);
  const re = new RegExp(script.findRe.source, script.findRe.flags);
  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push(m);
    if (m[0].length === 0)
      re.lastIndex++;
  }
  const fulls = caps.map((c) => c.fullMatch.replace(/\r\n?/g, `
`));
  const pairedInside = (block) => fulls.filter((f) => block.includes(f));
  if (!matches.some((mm) => pairedInside(mm[0]).length > 0))
    return null;
  return { matches: matches.map((mm) => pairedInside(mm[0]).length > 0 ? mm : null), pairedInside };
}
function outerRangesFromLaterScripts(text, script, allScripts) {
  const out = [];
  for (const other of allScripts) {
    if (other.kind !== "delimitedCaptureMultiLine" || other.sourceIndex <= script.sourceIndex)
      continue;
    const re = new RegExp(other.findRe.source, other.findRe.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0)
        re.lastIndex++;
    }
  }
  return out;
}
function replaceLinearRange(bubble, offsetMap, start, end, widget) {
  let startEntry = null;
  let endEntry = null;
  for (const e of offsetMap) {
    if (!startEntry && e.sourceStart <= start && start < e.sourceEnd)
      startEntry = e;
    if (e.sourceStart < end && end <= e.sourceEnd)
      endEntry = e;
  }
  if (!startEntry || !endEntry)
    return false;
  if (!deepContains(bubble, startEntry.node) || !deepContains(bubble, endEntry.node))
    return false;
  const startNodeOffset = start - startEntry.sourceStart + startEntry.nodeStart;
  const endNodeOffset = end - endEntry.sourceStart + endEntry.nodeStart;
  let range;
  try {
    range = document.createRange();
    range.setStart(startEntry.node, startNodeOffset);
    range.setEnd(endEntry.node, endNodeOffset);
  } catch {
    return false;
  }
  range.deleteContents();
  range.insertNode(widget);
  cleanupEmptyAroundWidget(widget, bubble);
  return true;
}
var MULTILINE_BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "BLOCKQUOTE",
  "PRE",
  "UL",
  "OL",
  "LI",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6"
]);
var INLINE_RESIDUE_TAGS = new Set(["A", "SPAN", "EM", "STRONG", "B", "I", "U", "S", "CODE"]);
function cleanupEmptyAroundWidget(widget, stopAt) {
  let current = widget;
  for (;; ) {
    const parent = current.parentElement;
    if (!parent)
      break;
    let prev = current.previousSibling;
    while (prev) {
      const next = prev.previousSibling;
      if (isEmptyResidue(prev))
        prev.parentNode?.removeChild(prev);
      else
        break;
      prev = next;
    }
    let nxt = current.nextSibling;
    while (nxt) {
      const next = nxt.nextSibling;
      if (isEmptyResidue(nxt))
        nxt.parentNode?.removeChild(nxt);
      else
        break;
      nxt = next;
    }
    if (parent === stopAt)
      break;
    const onlyChild = parent.childNodes.length === 1 && parent.childNodes[0] === current;
    if (onlyChild && MULTILINE_BLOCK_TAGS.has(parent.tagName)) {
      const gparent = parent.parentNode;
      if (!gparent)
        break;
      gparent.replaceChild(current, parent);
      continue;
    }
    break;
  }
}
function isEmptyResidue(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const v = node.nodeValue ?? "";
    return v.length === 0 || v.includes(`
`) && v.trim() === "";
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node;
    if (el.tagName === "BR")
      return true;
    if (INLINE_RESIDUE_TAGS.has(el.tagName)) {
      return (el.textContent ?? "").length === 0 && !el.querySelector("img,svg,video,audio,iframe");
    }
    if (!MULTILINE_BLOCK_TAGS.has(el.tagName))
      return false;
    return (el.textContent ?? "").trim() === "" && !el.querySelector("img,svg,video,audio,iframe,canvas,[data-vishrun-widget]");
  }
  return false;
}
async function replacePlaceholderMatches(root, script, allScripts, messageId, ctx, resolvedMap) {
  const textNodes = collectTextNodes(root);
  let count = 0;
  let hasFreshMatch = false;
  for (const tn of textNodes) {
    const text = tn.nodeValue ?? "";
    if (!text)
      continue;
    script.findRe.lastIndex = 0;
    if (script.findRe.test(text)) {
      hasFreshMatch = true;
      break;
    }
  }
  if (hasFreshMatch && hasRegisteredWidgetsFor(messageId, script.id)) {
    destroyRegisteredWidgetsFor(messageId, script.id);
  }
  for (const tn of textNodes) {
    const text = tn.nodeValue ?? "";
    if (!text)
      continue;
    script.findRe.lastIndex = 0;
    const ranges = [];
    let m;
    while ((m = script.findRe.exec(text)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length, match: m });
      if (m[0].length === 0)
        script.findRe.lastIndex++;
    }
    if (ranges.length === 0)
      continue;
    const parent = tn.parentNode;
    if (!parent || !parent.isConnected) {
      if (VSH_VISHRUN_DIAG) {
        console.log("[vishrun:render] placeholder-skipped", JSON.stringify({
          messageId,
          scriptId: script.id,
          reason: "parent-disconnected-pre-build"
        }));
      }
      continue;
    }
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const { start, end, match } of ranges) {
      if (start > cursor) {
        frag.appendChild(document.createTextNode(text.slice(cursor, start)));
      }
      const groups = match.slice(1).map((g) => g ?? "");
      const html = substitute(script.replaceString, match[0], groups);
      const expanded = applyNestedPipeline(html, allScripts, new Set([script.id]), 0);
      const fromMap = resolvedMap.get(expanded);
      const fromCache = fromMap ?? resolutionCache.get(expanded);
      const finalHtml = fromCache ?? expanded;
      const widget = await buildWidget(finalHtml, script.scriptName, script.id, messageId, ctx);
      setWidgetSource(widget, text.slice(start, end));
      frag.appendChild(widget);
      cursor = end;
      count++;
    }
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    if (tn.parentNode === parent && parent.isConnected) {
      parent.replaceChild(frag, tn);
    } else {
      if (VSH_VISHRUN_DIAG) {
        console.log("[vishrun:render] placeholder-skipped", JSON.stringify({
          messageId,
          scriptId: script.id,
          reason: "parent-displaced-post-await"
        }));
      }
      frag.querySelectorAll("iframe[data-vishrun-widget]").forEach((el) => destroyWidgetIframe(el));
      count -= ranges.length;
    }
  }
  return count;
}
var strippedTagSeen = new Map;
async function refreshStrippedTagCaptures(target, scripts, messageId, ctx) {
  if (!scripts.some((s) => s.kind === "strippedTag" && !s.native))
    return;
  if (isGenerating() && isLatestMessage(messageId))
    return;
  const chatId = ctx.getActiveChat().chatId;
  if (!chatId)
    return;
  const sig = chatId + "\x01" + hashKey(target.textContent ?? "");
  if (strippedTagSeen.get(messageId) === sig)
    return;
  let raw = null;
  try {
    raw = await fetchMessageContent(chatId, messageId);
  } catch {
    return;
  }
  if (raw == null)
    return;
  strippedTagSeen.set(messageId, sig);
  syncStrippedTagCaptures(messageId, raw, scripts);
}
async function renderPairedTagCaptures(root, allScripts, messageId, ctx, resolvedMap) {
  const captures = firstScriptPerBlock(getCapturesForMessage(messageId).filter((c) => !allScripts.some((s) => s.id === c.scriptId && s.native)), allScripts);
  const target = findContentRoot(root);
  let added = 0;
  let removed = 0;
  const existingPaired = deepQuerySelectorAll(target, "[data-vishrun-widget][data-vishrun-paired-fullmatch]");
  existingPaired.forEach((el) => {
    const sid = el.getAttribute("data-vishrun-script-id");
    const fmHash = el.getAttribute("data-vishrun-paired-fullmatch");
    const stillValid = captures.some((c) => c.scriptId === sid && hashKey(c.fullMatch) === fmHash && !isConsumedPaired(messageId, c.fullMatch));
    if (!stillValid) {
      if (el.tagName === "IFRAME") {
        destroyWidgetIframe(el);
      } else {
        el.remove();
      }
      removed++;
    }
  });
  for (const cap of captures) {
    if (isConsumedPaired(messageId, cap.fullMatch))
      continue;
    const sel = `[data-vishrun-widget][data-vishrun-script-id="${cssEscape(cap.scriptId)}"][data-vishrun-paired-fullmatch="${cssEscape(hashKey(cap.fullMatch))}"]`;
    if (deepQuerySelector(target, sel))
      continue;
    cap.findRe.lastIndex = 0;
    const m = cap.findRe.exec(cap.fullMatch);
    if (!m) {
      if (VSH_VISHRUN_DIAG) {
        console.log("[vishrun:render] placeholder-skipped", JSON.stringify({
          messageId,
          scriptId: cap.scriptId,
          reason: "paired-findRe-failed-rematch"
        }));
      }
      console.debug(`[vishrun] paired-tag findRegex failed to re-match fullMatch for "${cap.scriptName}" — rendering raw text`);
      const failed = ctx.dom.createElement("span", {
        "data-vishrun-widget": cap.scriptName,
        "data-vishrun-widget-failed": cap.scriptName,
        "data-vishrun-script-id": cap.scriptId
      });
      failed.setAttribute("data-vishrun-paired-fullmatch", hashKey(cap.fullMatch));
      failed.textContent = cap.fullMatch;
      if (target.isConnected) {
        target.appendChild(failed);
        added++;
      }
      continue;
    }
    const groups = m.slice(1).map((g) => g ?? "");
    const html = substitute(cap.replaceString, m[0], groups);
    const expanded = applyNestedPipeline(html, allScripts, new Set([cap.scriptId]), 0);
    const fromMap = resolvedMap.get(expanded);
    const fromCache = fromMap ?? resolutionCache.get(expanded);
    const finalHtml = fromCache ?? expanded;
    if (finalHtml.trim() === "") {
      const marker = ctx.dom.createElement("span", {
        "data-vishrun-widget": cap.scriptName,
        "data-vishrun-script-id": cap.scriptId,
        "data-vishrun-paired-fullmatch": hashKey(cap.fullMatch),
        hidden: ""
      });
      if (target.isConnected && !deepQuerySelector(target, sel)) {
        target.appendChild(marker);
        added++;
      }
      continue;
    }
    const anchor = await resolvePairedAnchor(target, messageId, cap.fullMatch, ctx);
    const rawPos = anchor ? null : await rawPositionOf(messageId, cap.fullMatch, ctx);
    const iframe = await buildWidgetIframe(finalHtml, cap.scriptName, cap.scriptId, messageId, ctx);
    iframe.setAttribute("data-vishrun-paired-fullmatch", hashKey(cap.fullMatch));
    if (!target.isConnected || deepQuerySelector(target, sel)) {
      if (VSH_VISHRUN_DIAG) {
        console.log("[vishrun:render] placeholder-skipped", JSON.stringify({
          messageId,
          scriptId: cap.scriptId,
          reason: !target.isConnected ? "target-disconnected-post-await" : "sibling-mounted-during-await"
        }));
      }
      destroyWidgetIframe(iframe);
      continue;
    }
    if (!anchor || !placeAtAnchor(target, anchor, iframe))
      placeByRawOrder(target, iframe, rawPos, allScripts, captures);
    added++;
  }
  return added;
}
function firstScriptPerBlock(captures, scripts) {
  const order = (id) => scripts.find((s) => s.id === id)?.sourceIndex ?? Number.MAX_SAFE_INTEGER;
  const best = new Map;
  for (const c of captures) {
    const key = c.fullMatch.replace(/\r\n?/g, `
`);
    const prev = best.get(key);
    if (!prev || order(c.scriptId) < order(prev.scriptId))
      best.set(key, c);
  }
  return captures.filter((c) => best.get(c.fullMatch.replace(/\r\n?/g, `
`)) === c);
}
var nestedReconciled = new Map;
async function reconcileNestedTagCaptures(scripts, messageId, ctx) {
  const caps = getCapturesForMessage(messageId);
  if (caps.length < 2)
    return;
  const tagScripts = scripts.filter((s) => (s.kind === "pairedTag" || s.kind === "strippedTag") && !s.native);
  if (tagScripts.length < 2)
    return;
  const sig = caps.map((c) => c.scriptId + "\x01" + hashKey(c.fullMatch)).join("|");
  if (nestedReconciled.get(messageId) === sig)
    return;
  const chatId = ctx.getActiveChat().chatId;
  if (!chatId)
    return;
  const raw = await fetchMessageContent(chatId, messageId);
  if (!raw)
    return;
  const text = raw.replace(/\r\n?/g, `
`);
  for (const cap of caps) {
    const own = tagScripts.find((s) => s.id === cap.scriptId);
    if (!own)
      continue;
    const re = new RegExp(own.findRe.source, own.findRe.flags);
    let last = null;
    let m;
    while ((m = re.exec(text)) !== null) {
      last = m;
      if (m[0].length === 0)
        re.lastIndex++;
    }
    if (!last || last[0] === cap.fullMatch.replace(/\r\n?/g, `
`))
      continue;
    const block = last[0];
    const inner = caps.filter((o) => o !== cap && block.includes(o.fullMatch.replace(/\r\n?/g, `
`)));
    if (inner.length === 0)
      continue;
    cap.fullMatch = block;
    for (const o of inner)
      consumedPairedMatches.add(messageId + "\x01" + o.fullMatch.replace(/\r\n?/g, `
`));
  }
  nestedReconciled.set(messageId, caps.map((c) => c.scriptId + "\x01" + hashKey(c.fullMatch)).join("|"));
}
var rawPosCache = new Map;
async function rawPositionOf(messageId, fullMatch, ctx) {
  const key = messageId + "\x01" + hashKey(fullMatch);
  if (rawPosCache.has(key))
    return rawPosCache.get(key) ?? null;
  const chatId = ctx.getActiveChat().chatId;
  if (!chatId)
    return null;
  let pos = null;
  try {
    const raw = await fetchMessageContent(chatId, messageId);
    if (raw) {
      const text = raw.replace(/\r\n?/g, `
`);
      const start = text.indexOf(fullMatch.replace(/\r\n?/g, `
`));
      if (start >= 0)
        pos = { text, start, end: start + fullMatch.replace(/\r\n?/g, `
`).length };
    }
  } catch {
    pos = null;
  }
  if (rawPosCache.size > 256)
    rawPosCache.clear();
  rawPosCache.set(key, pos);
  return pos;
}
function placeByRawOrder(target, widget, pos, scripts, captures) {
  if (!pos) {
    target.appendChild(widget);
    return;
  }
  if (pos.text.slice(0, pos.start).trim() === "") {
    target.insertBefore(widget, target.firstChild);
    return;
  }
  let best = null;
  for (const el of Array.from(target.querySelectorAll("[data-vishrun-widget]"))) {
    if (el === widget || !el.parentNode || el.parentElement?.closest("[data-vishrun-widget]"))
      continue;
    const at = rawIndexOfWidget(el, pos.text, scripts, captures);
    if (at === null || at < pos.end)
      continue;
    if (!best || at < best.at)
      best = { el, at };
  }
  if (best)
    best.el.parentNode.insertBefore(widget, best.el);
  else
    target.appendChild(widget);
}
function rawIndexOfWidget(el, text, scripts, captures) {
  const sid = el.getAttribute("data-vishrun-script-id");
  if (!sid)
    return null;
  const fm = el.getAttribute("data-vishrun-paired-fullmatch");
  if (fm) {
    const cap = captures.find((c) => c.scriptId === sid && hashKey(c.fullMatch) === fm);
    if (!cap)
      return null;
    const i = text.indexOf(cap.fullMatch.replace(/\r\n?/g, `
`));
    return i >= 0 ? i : null;
  }
  const script = scripts.find((s) => s.id === sid);
  if (!script)
    return null;
  const re = new RegExp(script.findRe.source, script.findRe.flags.includes("g") ? script.findRe.flags : script.findRe.flags + "g");
  const first = re.exec(text);
  if (!first)
    return null;
  if (re.exec(text))
    return null;
  return first.index;
}
var anchorCache = new Map;
async function resolvePairedAnchor(target, messageId, fullMatch, ctx) {
  if (!hasShadowHost(target))
    return null;
  const key = messageId + "\x01" + hashKey(fullMatch);
  if (anchorCache.has(key))
    return anchorCache.get(key) ?? null;
  const chatId = ctx.getActiveChat().chatId;
  if (!chatId)
    return null;
  let anchor = null;
  try {
    const raw = await fetchMessageContent(chatId, messageId);
    anchor = raw ? computePairedAnchor(raw, fullMatch) : null;
  } catch {
    anchor = null;
  }
  if (anchorCache.size > 256)
    anchorCache.clear();
  anchorCache.set(key, anchor);
  return anchor;
}
function findContentRoot(messageNode) {
  const inner = messageNode.querySelector('[data-component="MessageContent"]');
  return inner ?? messageNode;
}
async function buildWidget(html, scriptName, scriptId, messageId, ctx) {
  if (widgetNeedsIsolation(html)) {
    return buildWidgetIframe(html, scriptName, scriptId, messageId, ctx);
  }
  const wrapper = ctx.dom.createElement("div", {
    "data-vishrun-widget": scriptName,
    "data-vishrun-script-id": scriptId
  });
  wrapper.style.margin = "12px 0";
  wrapper.innerHTML = html;
  return wrapper;
}
function collectTextNodes(root) {
  const out = [];
  const walk = (node) => {
    for (const child of renderedChildNodes(node)) {
      if (child.nodeType === 3) {
        out.push(child);
      } else if (child.nodeType === 1) {
        const el = child;
        if (el.hasAttribute("data-vishrun-widget") || isNonTextElement(el))
          continue;
        walk(el);
      }
    }
  };
  walk(root);
  return out;
}
function cssEscape(s) {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}
function hashKey(s) {
  let h = 5381;
  for (let i = 0;i < s.length; i++) {
    h = (h << 5) + h + s.charCodeAt(i) | 0;
  }
  return (h >>> 0).toString(36);
}

// src/core/takeover-policy.ts
var SCRIPT_RE = /<script\b/i;
var EVENT_HANDLER_RE = /\son[a-z]+\s*=/i;
var JS_URL_RE = /javascript\s*:/i;
var BLOCKED_TAG_RE = /<(?:iframe|frame|object|embed|meta|base|link|form|math)\b|\ssrcdoc\s*=/i;
var DOLLAR_ZERO_RE = /\$0(?!\d)/;
var HTML_FENCE_RE = /```(?:html)?[ \t]*\r?\n\s*</i;
function takeoverReasons(replaceString) {
  const r = [];
  if (SCRIPT_RE.test(replaceString))
    r.push("script");
  if (EVENT_HANDLER_RE.test(replaceString))
    r.push("event-handler");
  if (JS_URL_RE.test(replaceString))
    r.push("js-url");
  if (BLOCKED_TAG_RE.test(replaceString))
    r.push("blocked-tag");
  if (hasMacros(replaceString))
    r.push("macro");
  if (DOLLAR_ZERO_RE.test(replaceString))
    r.push("dollar-zero");
  if (HTML_FENCE_RE.test(replaceString))
    r.push("html-fence");
  return r;
}
function selectTakeoverCandidates(scripts) {
  const renderable = new Set(compileScripts(scripts).filter((c) => c.kind !== "unknown").map((c) => c.sourceIndex));
  const out = [];
  scripts.forEach((s, i) => {
    if (!renderable.has(i))
      return;
    if (typeof s.findRegex !== "string" || typeof s.replaceString !== "string")
      return;
    const reasons = takeoverReasons(s.replaceString);
    if (reasons.length === 0)
      return;
    out.push({ name: s.scriptName ?? "", findRegex: s.findRegex, replaceString: s.replaceString, reasons });
  });
  return out;
}
function hostPatternOf(findRegex) {
  const m = findRegex.match(/^\/(.+)\/([dgimsuvy]*)$/s);
  return m ? m[1] : findRegex;
}

// src/core/chat-changed-filter.ts
var VAR_PATH_RE = /^metadata\.(macro_variables|chat_variables)(\.|$)/;
function shouldRescanForChangedFields(changedFields) {
  if (changedFields === undefined)
    return true;
  if (changedFields.length === 0)
    return false;
  return changedFields.some((f) => !VAR_PATH_RE.test(f));
}

// src/render/self-mutation.ts
var WIDGET_ATTR = "data-vishrun-widget";
var WIDGET_SEL = "[data-vishrun-widget]";
function isOrContainsWidget(node) {
  if (node.nodeType !== 1)
    return false;
  const el = node;
  if (el.hasAttribute(WIDGET_ATTR))
    return true;
  return !!el.querySelector?.(WIDGET_SEL);
}
function isInsideWidget(node) {
  let cur = node.parentNode;
  while (cur) {
    if (cur.nodeType === 1 && cur.hasAttribute?.(WIDGET_ATTR))
      return true;
    cur = cur.parentNode;
  }
  return false;
}
function isSelfMutation(record) {
  if (record.type === "characterData")
    return isInsideWidget(record.target);
  if (record.addedNodes.length === 0)
    return false;
  for (let i = 0;i < record.addedNodes.length; i++) {
    if (isOrContainsWidget(record.addedNodes[i]))
      return true;
  }
  return false;
}
function allSelf(records) {
  for (let i = 0;i < records.length; i++) {
    if (!isSelfMutation(records[i]))
      return false;
  }
  return true;
}

// src/hooks/message-rendered.ts
var MAX_RAF_RETRIES = 3;
var MESSAGE_LIST_SELECTOR = '[data-component="MessageList"]';
function outermostMessageNodes(root) {
  const out = [];
  root.querySelectorAll("[data-message-id]").forEach((n) => {
    const id = n.getAttribute("data-message-id");
    const outer = n.parentElement?.closest(`[data-message-id="${CSS.escape(id ?? "")}"]`);
    if (!outer)
      out.push(n);
  });
  return out;
}
function installMessageHooks(ctx) {
  let observer = null;
  let observedTarget = null;
  let pendingFrame = 0;
  let pendingRecords = [];
  let bodyWatcher = null;
  const OBSERVE_OPTS = { childList: true, subtree: true, characterData: true };
  function compiledForActiveCard() {
    const card = getActiveCard();
    if (!card)
      return null;
    const compiled = compileScripts(card.scripts);
    if (card.nativeKeys && card.nativeKeys.size > 0) {
      for (const c of compiled) {
        const raw = card.scripts[c.sourceIndex];
        if (raw && card.nativeKeys.has(hostPatternOf(raw.findRegex) + "\x00" + (raw.replaceString ?? "")))
          c.native = true;
      }
    }
    return compiled.length === 0 ? null : compiled;
  }
  function isActiveChat(chatId) {
    if (!chatId)
      return true;
    const active = ctx.getActiveChat().chatId;
    if (!active)
      return true;
    return active === chatId;
  }
  function processMessageById(messageId, retriesLeft = MAX_RAF_RETRIES) {
    const compiled = compiledForActiveCard();
    if (!compiled)
      return;
    const sel = buildMessageSelector(messageId);
    const node = document.querySelector(sel);
    if (node) {
      processNode(node, compiled, ctx);
      return;
    }
    if (retriesLeft > 0) {
      requestAnimationFrame(() => processMessageById(messageId, retriesLeft - 1));
    }
  }
  async function scanAllNow(compiled) {
    const wasObserving = observer !== null && observedTarget !== null;
    if (wasObserving)
      observer.disconnect();
    const missed = [];
    const watchTarget = wasObserving ? observedTarget : null;
    const pausedWatcher = watchTarget ? new MutationObserver((records) => {
      missed.push(...records);
    }) : null;
    pausedWatcher?.observe(watchTarget, OBSERVE_OPTS);
    try {
      const tasks = [];
      for (const n of outermostMessageNodes(document))
        tasks.push(processNode(n, compiled, ctx).catch(() => {}));
      await Promise.all(tasks);
    } finally {
      if (pausedWatcher) {
        missed.push(...pausedWatcher.takeRecords());
        pausedWatcher.disconnect();
      }
      if (wasObserving && observedTarget && document.contains(observedTarget)) {
        observer.observe(observedTarget, OBSERVE_OPTS);
        if (missed.length > 0 && !allSelf(missed))
          handleMutations(missed);
      }
    }
  }
  function handleMutations(records) {
    if (records.length > 0)
      pendingRecords.push(...records);
    if (pendingFrame)
      return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = 0;
      const batch = pendingRecords;
      pendingRecords = [];
      const compiled = compiledForActiveCard();
      if (!compiled) {
        detachObserver();
        return;
      }
      if (allSelf(batch))
        return;
      scanAllNow(compiled);
    });
  }
  function attachObserver() {
    const target = document.querySelector(MESSAGE_LIST_SELECTOR);
    if (!target) {
      if (observer && observedTarget && !document.contains(observedTarget)) {
        detachObserver();
      }
      ensureBodyWatcher();
      return;
    }
    if (bodyWatcher) {
      bodyWatcher.disconnect();
      bodyWatcher = null;
    }
    if (observer && observedTarget === target)
      return;
    if (observer)
      observer.disconnect();
    observer = new MutationObserver(handleMutations);
    observer.observe(target, OBSERVE_OPTS);
    observedTarget = target;
  }
  function ensureBodyWatcher() {
    if (bodyWatcher)
      return;
    if (!document.body)
      return;
    bodyWatcher = new MutationObserver((records) => {
      let foundTarget = null;
      outer:
        for (const r of records) {
          for (const node of r.addedNodes) {
            if (!(node instanceof Element))
              continue;
            if (node.matches?.(MESSAGE_LIST_SELECTOR)) {
              foundTarget = node;
              break outer;
            }
            const nested = node.querySelector?.(MESSAGE_LIST_SELECTOR);
            if (nested) {
              foundTarget = nested;
              break outer;
            }
          }
        }
      if (!foundTarget)
        return;
      bodyWatcher.disconnect();
      bodyWatcher = null;
      const compiled = compiledForActiveCard();
      if (!compiled)
        return;
      attachObserver();
      scanAllNow(compiled);
    });
    bodyWatcher.observe(document.body, { childList: true, subtree: true });
  }
  function detachObserver() {
    if (pendingFrame) {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = 0;
    }
    pendingRecords = [];
    if (bodyWatcher) {
      bodyWatcher.disconnect();
      bodyWatcher = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
      observedTarget = null;
    }
  }
  function rescanAll() {
    const compiledNow = compiledForActiveCard();
    if (compiledNow) {
      syncTagInterceptors(ctx, compiledNow, {
        compiled: compiledNow,
        fetchContent: fetchMessageContentById,
        reprocess: (id) => processMessageById(id)
      });
    } else {
      teardownTagInterceptors();
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const compiled = compiledForActiveCard();
      if (!compiled) {
        detachObserver();
        return;
      }
      attachObserver();
      scanAllNow(compiled);
    }));
  }
  const listWatch = setInterval(() => {
    const compiled = compiledForActiveCard();
    if (!compiled)
      return;
    const live = document.querySelector(MESSAGE_LIST_SELECTOR);
    if (!live || live === observedTarget)
      return;
    if (observer)
      observer.disconnect();
    observer = null;
    observedTarget = null;
    attachObserver();
    scanAllNow(compiled);
  }, 1000);
  const unsubGenStarted = ctx.events.on("GENERATION_STARTED", () => {
    setGenerating(true);
  });
  const unsubGenStopped = ctx.events.on("GENERATION_STOPPED", () => {
    setGenerating(false);
    rescanAll();
  });
  const unsubGenEnded = ctx.events.on("GENERATION_ENDED", (payload) => {
    setGenerating(false);
    const p = payload || {};
    if (p.error)
      return;
    if (!isActiveChat(p.chatId))
      return;
    if (!p.messageId)
      return;
    processMessageById(p.messageId, MAX_RAF_RETRIES);
  });
  const unsubChatChanged = ctx.events.on("CHAT_CHANGED", (payload) => {
    const p = payload || {};
    if (!shouldRescanForChangedFields(p.changedFields))
      return;
    rescanAll();
  });
  return {
    rescanAll,
    processMessageById,
    compiledForActiveCard,
    dispose: () => {
      clearInterval(listWatch);
      detachObserver();
      teardownTagInterceptors();
      clearEditingMessageIds();
      unsubGenEnded();
      unsubGenStarted();
      unsubGenStopped();
      unsubChatChanged();
    }
  };
}
function buildMessageSelector(messageId) {
  const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(messageId) : messageId.replace(/["\\]/g, "\\$&");
  return `[data-message-id="${escaped}"]`;
}

// src/hooks/mvu-display-strip.ts
function registerMvuDisplayStrip(ctx) {
  return ctx.messages.registerTagInterceptor({ tagName: "updatevariable", removeFromMessage: true }, () => {});
}

// src/hooks/status-bar-inject.ts
var STATUS_PLACEHOLDER_PAIRED = "<StatusPlaceHolderImpl></StatusPlaceHolderImpl>";
var SELF_CLOSING_RE2 = /<StatusPlaceHolderImpl\s*\/>/g;
var TRAILING_TRIGGER = `

` + STATUS_PLACEHOLDER_PAIRED;
var LOG_PREFIX = "[vishrun:status-bar-inject]";
function logInjectError(messageId, err) {
  if (!VSH_VISHRUN_DIAG)
    return;
  try {
    console.log(`${LOG_PREFIX} inject-error`, JSON.stringify({
      messageId,
      error: err instanceof Error ? err.message : String(err)
    }));
  } catch {}
}
async function maybeInjectStatusPlaceholder(chatId, messageId, io) {
  let message;
  try {
    message = await io.fetchContent(chatId, messageId);
  } catch (err) {
    logInjectError(messageId, err);
    return "error";
  }
  if (!message)
    return "fetch-miss";
  const isUser = message.isUser === true || message.role === "user";
  SELF_CLOSING_RE2.lastIndex = 0;
  const selfClosingMatches = message.content.match(SELF_CLOSING_RE2);
  const hasSelfClosing = selfClosingMatches !== null && selfClosingMatches.length > 0;
  const hasPaired = message.content.includes(STATUS_PLACEHOLDER_PAIRED);
  if (isUser)
    return "not-assistant";
  if (hasPaired && !hasSelfClosing)
    return "already-has-trigger";
  let newContent;
  let outcome;
  if (hasSelfClosing) {
    newContent = message.content.replace(SELF_CLOSING_RE2, STATUS_PLACEHOLDER_PAIRED);
    outcome = "upgraded";
  } else {
    newContent = message.content + TRAILING_TRIGGER;
    outcome = "injected";
  }
  try {
    await io.updateContent(chatId, messageId, newContent);
    return outcome;
  } catch (err) {
    logInjectError(messageId, err);
    return "error";
  }
}
function defaultIO() {
  return {
    fetchContent: async (chatId, messageId) => {
      const m = (await getChatMessages(chatId)).find((mm) => mm.id === messageId);
      if (!m)
        return null;
      return { id: m.id, content: m.content, isUser: m.is_user, role: m.role };
    },
    updateContent: async (chatId, messageId, newContent) => {
      await updateMessageContent(chatId, messageId, newContent);
    }
  };
}
function cardUsesStatusPlaceholder(scripts) {
  return scripts.some((s) => !s.disabled && typeof s.findRegex === "string" && /StatusPlaceHolderImpl/.test(s.findRegex));
}
function installStatusBarInjectHook(ctx, io = defaultIO(), wanted = () => cardUsesStatusPlaceholder(getActiveCard()?.scripts ?? [])) {
  return ctx.events.on("GENERATION_ENDED", (payload) => {
    const p = payload || {};
    if (p.error)
      return;
    if (!p.messageId || !p.chatId)
      return;
    if (!wanted())
      return;
    maybeInjectStatusPlaceholder(p.chatId, p.messageId, io);
  });
}

// src/core/regex-takeover-client.ts
var TIMEOUT_MS3 = 8000;
var counter3 = 0;
var results = new Map;
var known = new Map;
function knownNativeKeys(characterId) {
  return known.get(characterId);
}
function requestRegexTakeover(ctx, characterId, scripts) {
  const hit = results.get(characterId);
  if (hit)
    return hit;
  const candidates = selectTakeoverCandidates(scripts);
  const requestId = `vishrun-rt-${Date.now()}-${++counter3}`;
  const pending = new Promise((resolve) => {
    let unsub = null;
    const timer = setTimeout(() => {
      unsub?.();
      results.delete(characterId);
      resolve({ disabled: 0, native: [] });
    }, TIMEOUT_MS3);
    unsub = ctx.onBackendMessage((payload) => {
      const p = payload;
      if (!p || p.type !== "regex_takeover_response" || p.requestId !== requestId)
        return;
      clearTimeout(timer);
      unsub?.();
      if (p.error)
        results.delete(characterId);
      const native = Array.isArray(p.native) ? p.native.filter((k) => typeof k === "string") : [];
      if (!p.error)
        known.set(characterId, native);
      resolve({ disabled: typeof p.disabled === "number" ? p.disabled : 0, native });
    });
    ctx.sendToBackend({
      type: "regex_takeover",
      requestId,
      characterId,
      scripts: candidates.map((c) => ({ findRegex: c.findRegex, replaceString: c.replaceString }))
    });
  });
  results.set(characterId, pending);
  return pending;
}

// src/vendor/cdn/zod-3.25.76-v4.min.js.txt
var zod_3_25_76_v4_min_js_default = "(()=>{var as=Object.defineProperty;var us=(e)=>e;function cs(e,r){this[e]=us.bind(null,r)}var X=(e,r)=>{for(var i in r)as(e,i,{get:r[i],enumerable:!0,configurable:!0,set:cs.bind(r,i)})};var $u={};X($u,{$brand:()=>yt,$input:()=>Vt,$output:()=>Ct,NEVER:()=>bt,TimePrecision:()=>sr,ZodAny:()=>Aa,ZodArray:()=>Va,ZodBase64:()=>Lr,ZodBase64URL:()=>Rr,ZodBigInt:()=>Ae,ZodBigIntFormat:()=>Fr,ZodBoolean:()=>Ee,ZodCIDRv4:()=>Er,ZodCIDRv6:()=>Ar,ZodCUID:()=>Or,ZodCUID2:()=>Pr,ZodCatch:()=>au,ZodCustom:()=>ht,ZodCustomStringFormat:()=>Pa,ZodDate:()=>ft,ZodDefault:()=>eu,ZodDiscriminatedUnion:()=>Fa,ZodE164:()=>Cr,ZodEmail:()=>Ir,ZodEmoji:()=>Sr,ZodEnum:()=>Ze,ZodError:()=>ec,ZodFile:()=>Ha,ZodGUID:()=>ct,ZodIPv4:()=>Dr,ZodIPv6:()=>Tr,ZodISODate:()=>it,ZodISODateTime:()=>nt,ZodISODuration:()=>at,ZodISOTime:()=>ot,ZodIntersection:()=>Ja,ZodIssueCode:()=>ns,ZodJWT:()=>Vr,ZodKSUID:()=>Zr,ZodLazy:()=>du,ZodLiteral:()=>qa,ZodMap:()=>Ba,ZodNaN:()=>cu,ZodNanoID:()=>jr,ZodNever:()=>Ra,ZodNonOptional:()=>Xr,ZodNull:()=>Ta,ZodNullable:()=>Qa,ZodNumber:()=>Te,ZodNumberFormat:()=>le,ZodObject:()=>vt,ZodOptional:()=>Kr,ZodPipe:()=>qr,ZodPrefault:()=>ru,ZodPromise:()=>fu,ZodReadonly:()=>su,ZodRealError:()=>se,ZodRecord:()=>Wr,ZodSet:()=>Ka,ZodString:()=>De,ZodStringFormat:()=>P,ZodSuccess:()=>ou,ZodSymbol:()=>Za,ZodTemplateLiteral:()=>mu,ZodTransform:()=>Gr,ZodTuple:()=>Wa,ZodType:()=>k,ZodULID:()=>Nr,ZodURL:()=>wr,ZodUUID:()=>W,ZodUndefined:()=>Da,ZodUnion:()=>Mr,ZodUnknown:()=>La,ZodVoid:()=>Ca,ZodXID:()=>Ur,_ZodString:()=>zr,_default:()=>tu,any:()=>Zc,array:()=>Jr,base64:()=>_c,base64url:()=>bc,bigint:()=>jc,boolean:()=>Ua,catch:()=>uu,check:()=>vu,cidrv4:()=>hc,cidrv6:()=>$c,clone:()=>E,coerce:()=>Yr,config:()=>Z,core:()=>M,cuid:()=>lc,cuid2:()=>mc,custom:()=>Hc,date:()=>Tc,default:()=>Kl,discriminatedUnion:()=>Cc,e164:()=>yc,email:()=>tc,emoji:()=>cc,endsWith:()=>Se,enum:()=>Xa,file:()=>Gc,flattenError:()=>ve,float32:()=>zc,float64:()=>Ic,formatError:()=>ge,function:()=>vr,getErrorMap:()=>os,globalRegistry:()=>C,gt:()=>F,gte:()=>T,guid:()=>rc,includes:()=>Ie,instanceof:()=>Qc,int:()=>kr,int32:()=>wc,int64:()=>Oc,intersection:()=>Ma,ipv4:()=>vc,ipv6:()=>gc,iso:()=>ut,json:()=>ts,jwt:()=>xc,keyof:()=>Ec,ksuid:()=>fc,lazy:()=>pu,length:()=>ce,literal:()=>Ya,locales:()=>_e,looseObject:()=>Rc,lowercase:()=>ke,lt:()=>V,lte:()=>R,map:()=>Jc,maxLength:()=>ue,maxSize:()=>ae,mime:()=>je,minLength:()=>K,minSize:()=>Q,multipleOf:()=>H,nan:()=>Xc,nanoid:()=>sc,nativeEnum:()=>Wc,negative:()=>mr,never:()=>pt,nonnegative:()=>pr,nonoptional:()=>iu,nonpositive:()=>dr,normalize:()=>Oe,null:()=>Ea,nullable:()=>mt,nullish:()=>Bc,number:()=>Na,object:()=>Ac,optional:()=>lt,overwrite:()=>J,parse:()=>$r,parseAsync:()=>_r,partialRecord:()=>Fc,pipe:()=>dt,positive:()=>lr,prefault:()=>nu,preprocess:()=>rs,prettifyError:()=>zt,promise:()=>Yc,property:()=>fr,readonly:()=>lu,record:()=>Ga,refine:()=>gu,regex:()=>xe,regexes:()=>Y,registry:()=>et,safeParse:()=>br,safeParseAsync:()=>yr,set:()=>Mc,setErrorMap:()=>is,size:()=>ye,startsWith:()=>we,strictObject:()=>Lc,string:()=>xr,stringFormat:()=>kc,stringbool:()=>es,success:()=>Kc,superRefine:()=>hu,symbol:()=>Nc,templateLiteral:()=>qc,toJSONSchema:()=>hr,toLowerCase:()=>Ne,toUpperCase:()=>Ue,transform:()=>Br,treeifyError:()=>kt,trim:()=>Pe,tuple:()=>Vc,uint32:()=>Sc,uint64:()=>Pc,ulid:()=>dc,undefined:()=>Uc,union:()=>gt,unknown:()=>st,uppercase:()=>ze,url:()=>uc,uuid:()=>nc,uuidv4:()=>ic,uuidv6:()=>oc,uuidv7:()=>ac,void:()=>Dc,xid:()=>pc,z:()=>$t});var $t={};X($t,{$brand:()=>yt,$input:()=>Vt,$output:()=>Ct,NEVER:()=>bt,TimePrecision:()=>sr,ZodAny:()=>Aa,ZodArray:()=>Va,ZodBase64:()=>Lr,ZodBase64URL:()=>Rr,ZodBigInt:()=>Ae,ZodBigIntFormat:()=>Fr,ZodBoolean:()=>Ee,ZodCIDRv4:()=>Er,ZodCIDRv6:()=>Ar,ZodCUID:()=>Or,ZodCUID2:()=>Pr,ZodCatch:()=>au,ZodCustom:()=>ht,ZodCustomStringFormat:()=>Pa,ZodDate:()=>ft,ZodDefault:()=>eu,ZodDiscriminatedUnion:()=>Fa,ZodE164:()=>Cr,ZodEmail:()=>Ir,ZodEmoji:()=>Sr,ZodEnum:()=>Ze,ZodError:()=>ec,ZodFile:()=>Ha,ZodGUID:()=>ct,ZodIPv4:()=>Dr,ZodIPv6:()=>Tr,ZodISODate:()=>it,ZodISODateTime:()=>nt,ZodISODuration:()=>at,ZodISOTime:()=>ot,ZodIntersection:()=>Ja,ZodIssueCode:()=>ns,ZodJWT:()=>Vr,ZodKSUID:()=>Zr,ZodLazy:()=>du,ZodLiteral:()=>qa,ZodMap:()=>Ba,ZodNaN:()=>cu,ZodNanoID:()=>jr,ZodNever:()=>Ra,ZodNonOptional:()=>Xr,ZodNull:()=>Ta,ZodNullable:()=>Qa,ZodNumber:()=>Te,ZodNumberFormat:()=>le,ZodObject:()=>vt,ZodOptional:()=>Kr,ZodPipe:()=>qr,ZodPrefault:()=>ru,ZodPromise:()=>fu,ZodReadonly:()=>su,ZodRealError:()=>se,ZodRecord:()=>Wr,ZodSet:()=>Ka,ZodString:()=>De,ZodStringFormat:()=>P,ZodSuccess:()=>ou,ZodSymbol:()=>Za,ZodTemplateLiteral:()=>mu,ZodTransform:()=>Gr,ZodTuple:()=>Wa,ZodType:()=>k,ZodULID:()=>Nr,ZodURL:()=>wr,ZodUUID:()=>W,ZodUndefined:()=>Da,ZodUnion:()=>Mr,ZodUnknown:()=>La,ZodVoid:()=>Ca,ZodXID:()=>Ur,_ZodString:()=>zr,_default:()=>tu,any:()=>Zc,array:()=>Jr,base64:()=>_c,base64url:()=>bc,bigint:()=>jc,boolean:()=>Ua,catch:()=>uu,check:()=>vu,cidrv4:()=>hc,cidrv6:()=>$c,clone:()=>E,coerce:()=>Yr,config:()=>Z,core:()=>M,cuid:()=>lc,cuid2:()=>mc,custom:()=>Hc,date:()=>Tc,discriminatedUnion:()=>Cc,e164:()=>yc,email:()=>tc,emoji:()=>cc,endsWith:()=>Se,enum:()=>Xa,file:()=>Gc,flattenError:()=>ve,float32:()=>zc,float64:()=>Ic,formatError:()=>ge,function:()=>vr,getErrorMap:()=>os,globalRegistry:()=>C,gt:()=>F,gte:()=>T,guid:()=>rc,includes:()=>Ie,instanceof:()=>Qc,int:()=>kr,int32:()=>wc,int64:()=>Oc,intersection:()=>Ma,ipv4:()=>vc,ipv6:()=>gc,iso:()=>ut,json:()=>ts,jwt:()=>xc,keyof:()=>Ec,ksuid:()=>fc,lazy:()=>pu,length:()=>ce,literal:()=>Ya,locales:()=>_e,looseObject:()=>Rc,lowercase:()=>ke,lt:()=>V,lte:()=>R,map:()=>Jc,maxLength:()=>ue,maxSize:()=>ae,mime:()=>je,minLength:()=>K,minSize:()=>Q,multipleOf:()=>H,nan:()=>Xc,nanoid:()=>sc,nativeEnum:()=>Wc,negative:()=>mr,never:()=>pt,nonnegative:()=>pr,nonoptional:()=>iu,nonpositive:()=>dr,normalize:()=>Oe,null:()=>Ea,nullable:()=>mt,nullish:()=>Bc,number:()=>Na,object:()=>Ac,optional:()=>lt,overwrite:()=>J,parse:()=>$r,parseAsync:()=>_r,partialRecord:()=>Fc,pipe:()=>dt,positive:()=>lr,prefault:()=>nu,preprocess:()=>rs,prettifyError:()=>zt,promise:()=>Yc,property:()=>fr,readonly:()=>lu,record:()=>Ga,refine:()=>gu,regex:()=>xe,regexes:()=>Y,registry:()=>et,safeParse:()=>br,safeParseAsync:()=>yr,set:()=>Mc,setErrorMap:()=>is,size:()=>ye,startsWith:()=>we,strictObject:()=>Lc,string:()=>xr,stringFormat:()=>kc,stringbool:()=>es,success:()=>Kc,superRefine:()=>hu,symbol:()=>Nc,templateLiteral:()=>qc,toJSONSchema:()=>hr,toLowerCase:()=>Ne,toUpperCase:()=>Ue,transform:()=>Br,treeifyError:()=>kt,trim:()=>Pe,tuple:()=>Vc,uint32:()=>Sc,uint64:()=>Pc,ulid:()=>dc,undefined:()=>Uc,union:()=>gt,unknown:()=>st,uppercase:()=>ze,url:()=>uc,uuid:()=>nc,uuidv4:()=>ic,uuidv6:()=>oc,uuidv7:()=>ac,void:()=>Dc,xid:()=>pc});var M={};X(M,{$ZodAny:()=>Di,$ZodArray:()=>Xe,$ZodAsyncError:()=>G,$ZodBase64:()=>zi,$ZodBase64URL:()=>Ii,$ZodBigInt:()=>Lt,$ZodBigIntFormat:()=>Pi,$ZodBoolean:()=>Ke,$ZodCIDRv4:()=>yi,$ZodCIDRv6:()=>xi,$ZodCUID:()=>li,$ZodCUID2:()=>mi,$ZodCatch:()=>Qi,$ZodCheck:()=>N,$ZodCheckBigIntFormat:()=>Cn,$ZodCheckEndsWith:()=>Hn,$ZodCheckGreaterThan:()=>Zt,$ZodCheckIncludes:()=>qn,$ZodCheckLengthEquals:()=>Gn,$ZodCheckLessThan:()=>Ut,$ZodCheckLowerCase:()=>Kn,$ZodCheckMaxLength:()=>Mn,$ZodCheckMaxSize:()=>Vn,$ZodCheckMimeType:()=>ei,$ZodCheckMinLength:()=>Wn,$ZodCheckMinSize:()=>Fn,$ZodCheckMultipleOf:()=>Ln,$ZodCheckNumberFormat:()=>Rn,$ZodCheckOverwrite:()=>ti,$ZodCheckProperty:()=>Qn,$ZodCheckRegex:()=>Bn,$ZodCheckSizeEquals:()=>Jn,$ZodCheckStartsWith:()=>Yn,$ZodCheckStringFormat:()=>he,$ZodCheckUpperCase:()=>Xn,$ZodCustom:()=>oo,$ZodCustomStringFormat:()=>ji,$ZodDate:()=>Ai,$ZodDefault:()=>Xi,$ZodDiscriminatedUnion:()=>Ri,$ZodE164:()=>wi,$ZodEmail:()=>ai,$ZodEmoji:()=>ci,$ZodEnum:()=>Mi,$ZodError:()=>Be,$ZodFile:()=>Gi,$ZodFunction:()=>Ia,$ZodGUID:()=>ii,$ZodIPv4:()=>_i,$ZodIPv6:()=>bi,$ZodISODate:()=>gi,$ZodISODateTime:()=>vi,$ZodISODuration:()=>$i,$ZodISOTime:()=>hi,$ZodIntersection:()=>Ci,$ZodJWT:()=>Si,$ZodKSUID:()=>fi,$ZodLazy:()=>io,$ZodLiteral:()=>Wi,$ZodMap:()=>Fi,$ZodNaN:()=>eo,$ZodNanoID:()=>si,$ZodNever:()=>Ti,$ZodNonOptional:()=>Yi,$ZodNull:()=>Zi,$ZodNullable:()=>Ki,$ZodNumber:()=>At,$ZodNumberFormat:()=>Oi,$ZodObject:()=>Li,$ZodOptional:()=>Bi,$ZodPipe:()=>Ye,$ZodPrefault:()=>qi,$ZodPromise:()=>no,$ZodReadonly:()=>to,$ZodRealError:()=>fe,$ZodRecord:()=>Vi,$ZodRegistry:()=>Qe,$ZodSet:()=>Ji,$ZodString:()=>ie,$ZodStringFormat:()=>O,$ZodSuccess:()=>Hi,$ZodSymbol:()=>Ni,$ZodTemplateLiteral:()=>ro,$ZodTransform:()=>qe,$ZodTuple:()=>oe,$ZodType:()=>x,$ZodULID:()=>di,$ZodURL:()=>ui,$ZodUUID:()=>oi,$ZodUndefined:()=>Ui,$ZodUnion:()=>Rt,$ZodUnknown:()=>$e,$ZodVoid:()=>Ei,$ZodXID:()=>pi,$brand:()=>yt,$constructor:()=>u,$input:()=>Vt,$output:()=>Ct,Doc:()=>Dt,JSONSchema:()=>Yu,JSONSchemaGenerator:()=>gr,NEVER:()=>bt,TimePrecision:()=>sr,_any:()=>pa,_array:()=>rt,_base64:()=>or,_base64url:()=>ar,_bigint:()=>aa,_boolean:()=>ia,_catch:()=>Tl,_cidrv4:()=>nr,_cidrv6:()=>ir,_coercedBigint:()=>ua,_coercedBoolean:()=>oa,_coercedDate:()=>ha,_coercedNumber:()=>Ho,_coercedString:()=>Go,_cuid:()=>qt,_cuid2:()=>Yt,_custom:()=>ya,_date:()=>ga,_default:()=>Ul,_discriminatedUnion:()=>yl,_e164:()=>ur,_email:()=>Ft,_emoji:()=>Kt,_endsWith:()=>Se,_enum:()=>wl,_file:()=>ba,_float32:()=>ea,_float64:()=>ta,_gt:()=>F,_gte:()=>T,_guid:()=>tt,_includes:()=>Ie,_int:()=>Qo,_int32:()=>ra,_int64:()=>ca,_intersection:()=>xl,_ipv4:()=>tr,_ipv6:()=>rr,_isoDate:()=>Ko,_isoDateTime:()=>Bo,_isoDuration:()=>qo,_isoTime:()=>Xo,_jwt:()=>cr,_ksuid:()=>er,_lazy:()=>Rl,_length:()=>ce,_literal:()=>jl,_lowercase:()=>ke,_lt:()=>V,_lte:()=>R,_map:()=>zl,_max:()=>R,_maxLength:()=>ue,_maxSize:()=>ae,_mime:()=>je,_min:()=>T,_minLength:()=>K,_minSize:()=>Q,_multipleOf:()=>H,_nan:()=>$a,_nanoid:()=>Xt,_nativeEnum:()=>Sl,_negative:()=>mr,_never:()=>fa,_nonnegative:()=>pr,_nonoptional:()=>Zl,_nonpositive:()=>dr,_normalize:()=>Oe,_null:()=>da,_nullable:()=>Nl,_number:()=>Yo,_optional:()=>Pl,_overwrite:()=>J,_parse:()=>It,_parseAsync:()=>St,_pipe:()=>El,_positive:()=>lr,_promise:()=>Cl,_property:()=>fr,_readonly:()=>Al,_record:()=>kl,_refine:()=>xa,_regex:()=>xe,_safeParse:()=>Ot,_safeParseAsync:()=>Pt,_set:()=>Il,_size:()=>ye,_startsWith:()=>we,_string:()=>Wo,_stringFormat:()=>za,_stringbool:()=>ka,_success:()=>Dl,_symbol:()=>la,_templateLiteral:()=>Ll,_toLowerCase:()=>Ne,_toUpperCase:()=>Ue,_transform:()=>Ol,_trim:()=>Pe,_tuple:()=>_a,_uint32:()=>na,_uint64:()=>sa,_ulid:()=>Ht,_undefined:()=>ma,_union:()=>bl,_unknown:()=>be,_uppercase:()=>ze,_url:()=>Bt,_uuid:()=>Jt,_uuidv4:()=>Mt,_uuidv6:()=>Wt,_uuidv7:()=>Gt,_void:()=>va,_xid:()=>Qt,clone:()=>E,config:()=>Z,flattenError:()=>ve,formatError:()=>ge,function:()=>vr,globalConfig:()=>Re,globalRegistry:()=>C,isValidBase64:()=>ki,isValidBase64URL:()=>Gu,isValidJWT:()=>Bu,locales:()=>_e,parse:()=>wt,parseAsync:()=>jt,prettifyError:()=>zt,regexes:()=>Y,registry:()=>et,safeParse:()=>un,safeParseAsync:()=>cn,toDotPath:()=>Ou,toJSONSchema:()=>hr,treeifyError:()=>kt,util:()=>y,version:()=>ri});var y={};X(y,{BIGINT_FORMAT_RANGES:()=>an,Class:()=>Su,NUMBER_FORMAT_RANGES:()=>on,aborted:()=>te,allowsEval:()=>tn,assert:()=>ps,assertEqual:()=>ss,assertIs:()=>ms,assertNever:()=>ds,assertNotEqual:()=>ls,assignProp:()=>de,cached:()=>Fe,captureStackTrace:()=>xt,cleanEnum:()=>bs,cleanRegex:()=>Je,clone:()=>E,createTransparentProxy:()=>_s,defineLazy:()=>w,esc:()=>ee,escapeRegex:()=>B,extend:()=>ku,finalizeIssue:()=>L,floatSafeRemainder:()=>en,getElementAtPath:()=>fs,getEnumValues:()=>Ve,getLengthableOrigin:()=>Ge,getParsedType:()=>$s,getSizableOrigin:()=>We,isObject:()=>me,isPlainObject:()=>pe,issue:()=>re,joinValues:()=>l,jsonStringifyReplacer:()=>Qr,merge:()=>zu,normalizeParams:()=>d,nullish:()=>q,numKeys:()=>hs,omit:()=>xu,optionalKeys:()=>nn,partial:()=>Iu,pick:()=>yu,prefixIssues:()=>A,primitiveTypes:()=>rn,promiseAllObject:()=>vs,propertyKeyTypes:()=>Me,randomString:()=>gs,required:()=>wu,stringifyPrimitive:()=>g,unwrapMessage:()=>Ce});var Y={};X(Y,{_emoji:()=>Ps,base64:()=>kn,base64url:()=>Nt,bigint:()=>Pn,boolean:()=>Zn,browserEmail:()=>Os,cidrv4:()=>yn,cidrv6:()=>xn,cuid:()=>sn,cuid2:()=>ln,date:()=>wn,datetime:()=>jn,domain:()=>Ns,duration:()=>vn,e164:()=>In,email:()=>hn,emoji:()=>$n,extendedDuration:()=>xs,guid:()=>gn,hostname:()=>zn,html5Email:()=>ws,integer:()=>Nn,ipv4:()=>_n,ipv6:()=>bn,ksuid:()=>pn,lowercase:()=>En,nanoid:()=>fn,null:()=>Dn,number:()=>Un,rfc5322Email:()=>Ss,string:()=>On,time:()=>Sn,ulid:()=>mn,undefined:()=>Tn,unicodeEmail:()=>js,uppercase:()=>An,uuid:()=>ne,uuid4:()=>ks,uuid6:()=>zs,uuid7:()=>Is,xid:()=>dn});var _e={};X(_e,{ar:()=>ao,az:()=>uo,be:()=>co,ca:()=>so,cs:()=>lo,de:()=>mo,en:()=>He,eo:()=>po,es:()=>fo,fa:()=>vo,fi:()=>go,fr:()=>ho,frCA:()=>$o,he:()=>_o,hu:()=>bo,id:()=>yo,it:()=>xo,ja:()=>ko,kh:()=>zo,ko:()=>Io,mk:()=>wo,ms:()=>So,nl:()=>jo,no:()=>Oo,ota:()=>Po,pl:()=>Uo,ps:()=>No,pt:()=>Zo,ru:()=>Do,sl:()=>To,sv:()=>Eo,ta:()=>Ao,th:()=>Lo,tr:()=>Ro,ua:()=>Co,ur:()=>Vo,vi:()=>Fo,zhCN:()=>Jo,zhTW:()=>Mo});var Yu={};var ut={};X(ut,{ZodISODate:()=>it,ZodISODateTime:()=>nt,ZodISODuration:()=>at,ZodISOTime:()=>ot,date:()=>Sa,datetime:()=>wa,duration:()=>Oa,time:()=>ja});var Yr={};X(Yr,{bigint:()=>Gl,boolean:()=>Wl,date:()=>Bl,number:()=>Ml,string:()=>Jl});var bt=Object.freeze({status:\"aborted\"});function u(e,r,i){function o(c,p){var m;Object.defineProperty(c,\"_zod\",{value:c._zod??{},enumerable:!1}),(m=c._zod).traits??(m.traits=new Set),c._zod.traits.add(e),r(c,p);for(let f in a.prototype)if(!(f in c))Object.defineProperty(c,f,{value:a.prototype[f].bind(c)});c._zod.constr=a,c._zod.def=p}let t=i?.Parent??Object;class n extends t{}Object.defineProperty(n,\"name\",{value:e});function a(c){var p;let m=i?.Parent?new n:this;o(m,c),(p=m._zod).deferred??(p.deferred=[]);for(let f of m._zod.deferred)f();return m}return Object.defineProperty(a,\"init\",{value:o}),Object.defineProperty(a,Symbol.hasInstance,{value:(c)=>{if(i?.Parent&&c instanceof i.Parent)return!0;return c?._zod?.traits?.has(e)}}),Object.defineProperty(a,\"name\",{value:e}),a}var yt=Symbol(\"zod_brand\");class G extends Error{constructor(){super(\"Encountered Promise during synchronous parse. Use .parseAsync() instead.\")}}var Re={};function Z(e){if(e)Object.assign(Re,e);return Re}function ss(e){return e}function ls(e){return e}function ms(e){}function ds(e){throw Error()}function ps(e){}function Ve(e){let r=Object.values(e).filter((o)=>typeof o===\"number\");return Object.entries(e).filter(([o,t])=>r.indexOf(+o)===-1).map(([o,t])=>t)}function l(e,r=\"|\"){return e.map((i)=>g(i)).join(r)}function Qr(e,r){if(typeof r===\"bigint\")return r.toString();return r}function Fe(e){return{get value(){{let i=e();return Object.defineProperty(this,\"value\",{value:i}),i}throw Error(\"cached value already set\")}}}function q(e){return e===null||e===void 0}function Je(e){let r=e.startsWith(\"^\")?1:0,i=e.endsWith(\"$\")?e.length-1:e.length;return e.slice(r,i)}function en(e,r){let i=(e.toString().split(\".\")[1]||\"\").length,o=(r.toString().split(\".\")[1]||\"\").length,t=i>o?i:o,n=Number.parseInt(e.toFixed(t).replace(\".\",\"\")),a=Number.parseInt(r.toFixed(t).replace(\".\",\"\"));return n%a/10**t}function w(e,r,i){Object.defineProperty(e,r,{get(){{let t=i();return e[r]=t,t}throw Error(\"cached value already set\")},set(t){Object.defineProperty(e,r,{value:t})},configurable:!0})}function de(e,r,i){Object.defineProperty(e,r,{value:i,writable:!0,enumerable:!0,configurable:!0})}function fs(e,r){if(!r)return e;return r.reduce((i,o)=>i?.[o],e)}function vs(e){let r=Object.keys(e),i=r.map((o)=>e[o]);return Promise.all(i).then((o)=>{let t={};for(let n=0;n<r.length;n++)t[r[n]]=o[n];return t})}function gs(e=10){let i=\"\";for(let o=0;o<e;o++)i+=\"abcdefghijklmnopqrstuvwxyz\"[Math.floor(Math.random()*26)];return i}function ee(e){return JSON.stringify(e)}var xt=Error.captureStackTrace?Error.captureStackTrace:(...e)=>{};function me(e){return typeof e===\"object\"&&e!==null&&!Array.isArray(e)}var tn=Fe(()=>{if(typeof navigator<\"u\"&&navigator?.userAgent?.includes(\"Cloudflare\"))return!1;try{return new Function(\"\"),!0}catch(e){return!1}});function pe(e){if(me(e)===!1)return!1;let r=e.constructor;if(r===void 0)return!0;let i=r.prototype;if(me(i)===!1)return!1;if(Object.prototype.hasOwnProperty.call(i,\"isPrototypeOf\")===!1)return!1;return!0}function hs(e){let r=0;for(let i in e)if(Object.prototype.hasOwnProperty.call(e,i))r++;return r}var $s=(e)=>{let r=typeof e;switch(r){case\"undefined\":return\"undefined\";case\"string\":return\"string\";case\"number\":return Number.isNaN(e)?\"nan\":\"number\";case\"boolean\":return\"boolean\";case\"function\":return\"function\";case\"bigint\":return\"bigint\";case\"symbol\":return\"symbol\";case\"object\":if(Array.isArray(e))return\"array\";if(e===null)return\"null\";if(e.then&&typeof e.then===\"function\"&&e.catch&&typeof e.catch===\"function\")return\"promise\";if(typeof Map<\"u\"&&e instanceof Map)return\"map\";if(typeof Set<\"u\"&&e instanceof Set)return\"set\";if(typeof Date<\"u\"&&e instanceof Date)return\"date\";if(typeof File<\"u\"&&e instanceof File)return\"file\";return\"object\";default:throw Error(`Unknown data type: ${r}`)}},Me=new Set([\"string\",\"number\",\"symbol\"]),rn=new Set([\"string\",\"number\",\"bigint\",\"boolean\",\"symbol\",\"undefined\"]);function B(e){return e.replace(/[.*+?^${}()|[\\]\\\\]/g,\"\\\\$&\")}function E(e,r,i){let o=new e._zod.constr(r??e._zod.def);if(!r||i?.parent)o._zod.parent=e;return o}function d(e){let r=e;if(!r)return{};if(typeof r===\"string\")return{error:()=>r};if(r?.message!==void 0){if(r?.error!==void 0)throw Error(\"Cannot specify both `message` and `error` params\");r.error=r.message}if(delete r.message,typeof r.error===\"string\")return{...r,error:()=>r.error};return r}function _s(e){let r;return new Proxy({},{get(i,o,t){return r??(r=e()),Reflect.get(r,o,t)},set(i,o,t,n){return r??(r=e()),Reflect.set(r,o,t,n)},has(i,o){return r??(r=e()),Reflect.has(r,o)},deleteProperty(i,o){return r??(r=e()),Reflect.deleteProperty(r,o)},ownKeys(i){return r??(r=e()),Reflect.ownKeys(r)},getOwnPropertyDescriptor(i,o){return r??(r=e()),Reflect.getOwnPropertyDescriptor(r,o)},defineProperty(i,o,t){return r??(r=e()),Reflect.defineProperty(r,o,t)}})}function g(e){if(typeof e===\"bigint\")return e.toString()+\"n\";if(typeof e===\"string\")return`\"${e}\"`;return`${e}`}function nn(e){return Object.keys(e).filter((r)=>e[r]._zod.optin===\"optional\"&&e[r]._zod.optout===\"optional\")}var on={safeint:[Number.MIN_SAFE_INTEGER,Number.MAX_SAFE_INTEGER],int32:[-2147483648,2147483647],uint32:[0,4294967295],float32:[-340282346638528860000000000000000000000,340282346638528860000000000000000000000],float64:[-Number.MAX_VALUE,Number.MAX_VALUE]},an={int64:[BigInt(\"-9223372036854775808\"),BigInt(\"9223372036854775807\")],uint64:[BigInt(0),BigInt(\"18446744073709551615\")]};function yu(e,r){let i={},o=e._zod.def;for(let t in r){if(!(t in o.shape))throw Error(`Unrecognized key: \"${t}\"`);if(!r[t])continue;i[t]=o.shape[t]}return E(e,{...e._zod.def,shape:i,checks:[]})}function xu(e,r){let i={...e._zod.def.shape},o=e._zod.def;for(let t in r){if(!(t in o.shape))throw Error(`Unrecognized key: \"${t}\"`);if(!r[t])continue;delete i[t]}return E(e,{...e._zod.def,shape:i,checks:[]})}function ku(e,r){if(!pe(r))throw Error(\"Invalid input to extend: expected a plain object\");let i={...e._zod.def,get shape(){let o={...e._zod.def.shape,...r};return de(this,\"shape\",o),o},checks:[]};return E(e,i)}function zu(e,r){return E(e,{...e._zod.def,get shape(){let i={...e._zod.def.shape,...r._zod.def.shape};return de(this,\"shape\",i),i},catchall:r._zod.def.catchall,checks:[]})}function Iu(e,r,i){let o=r._zod.def.shape,t={...o};if(i)for(let n in i){if(!(n in o))throw Error(`Unrecognized key: \"${n}\"`);if(!i[n])continue;t[n]=e?new e({type:\"optional\",innerType:o[n]}):o[n]}else for(let n in o)t[n]=e?new e({type:\"optional\",innerType:o[n]}):o[n];return E(r,{...r._zod.def,shape:t,checks:[]})}function wu(e,r,i){let o=r._zod.def.shape,t={...o};if(i)for(let n in i){if(!(n in t))throw Error(`Unrecognized key: \"${n}\"`);if(!i[n])continue;t[n]=new e({type:\"nonoptional\",innerType:o[n]})}else for(let n in o)t[n]=new e({type:\"nonoptional\",innerType:o[n]});return E(r,{...r._zod.def,shape:t,checks:[]})}function te(e,r=0){for(let i=r;i<e.issues.length;i++)if(e.issues[i]?.continue!==!0)return!0;return!1}function A(e,r){return r.map((i)=>{var o;return(o=i).path??(o.path=[]),i.path.unshift(e),i})}function Ce(e){return typeof e===\"string\"?e:e?.message}function L(e,r,i){let o={...e,path:e.path??[]};if(!e.message){let t=Ce(e.inst?._zod.def?.error?.(e))??Ce(r?.error?.(e))??Ce(i.customError?.(e))??Ce(i.localeError?.(e))??\"Invalid input\";o.message=t}if(delete o.inst,delete o.continue,!r?.reportInput)delete o.input;return o}function We(e){if(e instanceof Set)return\"set\";if(e instanceof Map)return\"map\";if(e instanceof File)return\"file\";return\"unknown\"}function Ge(e){if(Array.isArray(e))return\"array\";if(typeof e===\"string\")return\"string\";return\"unknown\"}function re(...e){let[r,i,o]=e;if(typeof r===\"string\")return{message:r,code:\"custom\",input:i,inst:o};return{...r}}function bs(e){return Object.entries(e).filter(([r,i])=>Number.isNaN(Number.parseInt(r,10))).map((r)=>r[1])}class Su{constructor(...e){}}var ju=(e,r)=>{e.name=\"$ZodError\",Object.defineProperty(e,\"_zod\",{value:e._zod,enumerable:!1}),Object.defineProperty(e,\"issues\",{value:r,enumerable:!1}),Object.defineProperty(e,\"message\",{get(){return JSON.stringify(r,Qr,2)},enumerable:!0}),Object.defineProperty(e,\"toString\",{value:()=>e.message,enumerable:!1})},Be=u(\"$ZodError\",ju),fe=u(\"$ZodError\",ju,{Parent:Error});function ve(e,r=(i)=>i.message){let i={},o=[];for(let t of e.issues)if(t.path.length>0)i[t.path[0]]=i[t.path[0]]||[],i[t.path[0]].push(r(t));else o.push(r(t));return{formErrors:o,fieldErrors:i}}function ge(e,r){let i=r||function(n){return n.message},o={_errors:[]},t=(n)=>{for(let a of n.issues)if(a.code===\"invalid_union\"&&a.errors.length)a.errors.map((c)=>t({issues:c}));else if(a.code===\"invalid_key\")t({issues:a.issues});else if(a.code===\"invalid_element\")t({issues:a.issues});else if(a.path.length===0)o._errors.push(i(a));else{let c=o,p=0;while(p<a.path.length){let m=a.path[p];if(p!==a.path.length-1)c[m]=c[m]||{_errors:[]};else c[m]=c[m]||{_errors:[]},c[m]._errors.push(i(a));c=c[m],p++}}};return t(e),o}function kt(e,r){let i=r||function(n){return n.message},o={errors:[]},t=(n,a=[])=>{var c,p;for(let m of n.issues)if(m.code===\"invalid_union\"&&m.errors.length)m.errors.map((f)=>t({issues:f},m.path));else if(m.code===\"invalid_key\")t({issues:m.issues},m.path);else if(m.code===\"invalid_element\")t({issues:m.issues},m.path);else{let f=[...a,...m.path];if(f.length===0){o.errors.push(i(m));continue}let _=o,h=0;while(h<f.length){let s=f[h],v=h===f.length-1;if(typeof s===\"string\")_.properties??(_.properties={}),(c=_.properties)[s]??(c[s]={errors:[]}),_=_.properties[s];else _.items??(_.items=[]),(p=_.items)[s]??(p[s]={errors:[]}),_=_.items[s];if(v)_.errors.push(i(m));h++}}};return t(e),o}function Ou(e){let r=[];for(let i of e)if(typeof i===\"number\")r.push(`[${i}]`);else if(typeof i===\"symbol\")r.push(`[${JSON.stringify(String(i))}]`);else if(/[^\\w$]/.test(i))r.push(`[${JSON.stringify(i)}]`);else{if(r.length)r.push(\".\");r.push(i)}return r.join(\"\")}function zt(e){let r=[],i=[...e.issues].sort((o,t)=>o.path.length-t.path.length);for(let o of i)if(r.push(`✖ ${o.message}`),o.path?.length)r.push(`  → at ${Ou(o.path)}`);return r.join(`\n`)}var It=(e)=>(r,i,o,t)=>{let n=o?Object.assign(o,{async:!1}):{async:!1},a=r._zod.run({value:i,issues:[]},n);if(a instanceof Promise)throw new G;if(a.issues.length){let c=new(t?.Err??e)(a.issues.map((p)=>L(p,n,Z())));throw xt(c,t?.callee),c}return a.value},wt=It(fe),St=(e)=>async(r,i,o,t)=>{let n=o?Object.assign(o,{async:!0}):{async:!0},a=r._zod.run({value:i,issues:[]},n);if(a instanceof Promise)a=await a;if(a.issues.length){let c=new(t?.Err??e)(a.issues.map((p)=>L(p,n,Z())));throw xt(c,t?.callee),c}return a.value},jt=St(fe),Ot=(e)=>(r,i,o)=>{let t=o?{...o,async:!1}:{async:!1},n=r._zod.run({value:i,issues:[]},t);if(n instanceof Promise)throw new G;return n.issues.length?{success:!1,error:new(e??Be)(n.issues.map((a)=>L(a,t,Z())))}:{success:!0,data:n.value}},un=Ot(fe),Pt=(e)=>async(r,i,o)=>{let t=o?Object.assign(o,{async:!0}):{async:!0},n=r._zod.run({value:i,issues:[]},t);if(n instanceof Promise)n=await n;return n.issues.length?{success:!1,error:new e(n.issues.map((a)=>L(a,t,Z())))}:{success:!0,data:n.value}},cn=Pt(fe);var sn=/^[cC][^\\s-]{8,}$/,ln=/^[0-9a-z]+$/,mn=/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/,dn=/^[0-9a-vA-V]{20}$/,pn=/^[A-Za-z0-9]{27}$/,fn=/^[a-zA-Z0-9_-]{21}$/,vn=/^P(?:(\\d+W)|(?!.*W)(?=\\d|T\\d)(\\d+Y)?(\\d+M)?(\\d+D)?(T(?=\\d)(\\d+H)?(\\d+M)?(\\d+([.,]\\d+)?S)?)?)$/,xs=/^[-+]?P(?!$)(?:(?:[-+]?\\d+Y)|(?:[-+]?\\d+[.,]\\d+Y$))?(?:(?:[-+]?\\d+M)|(?:[-+]?\\d+[.,]\\d+M$))?(?:(?:[-+]?\\d+W)|(?:[-+]?\\d+[.,]\\d+W$))?(?:(?:[-+]?\\d+D)|(?:[-+]?\\d+[.,]\\d+D$))?(?:T(?=[\\d+-])(?:(?:[-+]?\\d+H)|(?:[-+]?\\d+[.,]\\d+H$))?(?:(?:[-+]?\\d+M)|(?:[-+]?\\d+[.,]\\d+M$))?(?:[-+]?\\d+(?:[.,]\\d+)?S)?)??$/,gn=/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,ne=(e)=>{if(!e)return/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000)$/;return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${e}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`)},ks=ne(4),zs=ne(6),Is=ne(7),hn=/^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$/,ws=/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,Ss=/^(([^<>()\\[\\]\\\\.,;:\\s@\"]+(\\.[^<>()\\[\\]\\\\.,;:\\s@\"]+)*)|(\".+\"))@((\\[[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}])|(([a-zA-Z\\-0-9]+\\.)+[a-zA-Z]{2,}))$/,js=/^[^\\s@\"]{1,64}@[^\\s@]{1,255}$/u,Os=/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,Ps=\"^(\\\\p{Extended_Pictographic}|\\\\p{Emoji_Component})+$\";function $n(){return new RegExp(\"^(\\\\p{Extended_Pictographic}|\\\\p{Emoji_Component})+$\",\"u\")}var _n=/^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/,bn=/^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})$/,yn=/^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\/([0-9]|[1-2][0-9]|3[0-2])$/,xn=/^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/,kn=/^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/,Nt=/^[A-Za-z0-9_-]*$/,zn=/^([a-zA-Z0-9-]+\\.)*[a-zA-Z0-9-]+$/,Ns=/^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)+[a-zA-Z]{2,}$/,In=/^\\+(?:[0-9]){6,14}[0-9]$/,Pu=\"(?:(?:\\\\d\\\\d[2468][048]|\\\\d\\\\d[13579][26]|\\\\d\\\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\\\d|30)|(?:02)-(?:0[1-9]|1\\\\d|2[0-8])))\",wn=new RegExp(`^${Pu}$`);function Nu(e){return typeof e.precision===\"number\"?e.precision===-1?\"(?:[01]\\\\d|2[0-3]):[0-5]\\\\d\":e.precision===0?\"(?:[01]\\\\d|2[0-3]):[0-5]\\\\d:[0-5]\\\\d\":`(?:[01]\\\\d|2[0-3]):[0-5]\\\\d:[0-5]\\\\d\\\\.\\\\d{${e.precision}}`:\"(?:[01]\\\\d|2[0-3]):[0-5]\\\\d(?::[0-5]\\\\d(?:\\\\.\\\\d+)?)?\"}function Sn(e){return new RegExp(`^${Nu(e)}$`)}function jn(e){let r=Nu({precision:e.precision}),i=[\"Z\"];if(e.local)i.push(\"\");if(e.offset)i.push(\"([+-]\\\\d{2}:\\\\d{2})\");let o=`${r}(?:${i.join(\"|\")})`;return new RegExp(`^${Pu}T(?:${o})$`)}var On=(e)=>{let r=e?`[\\\\s\\\\S]{${e?.minimum??0},${e?.maximum??\"\"}}`:\"[\\\\s\\\\S]*\";return new RegExp(`^${r}$`)},Pn=/^\\d+n?$/,Nn=/^\\d+$/,Un=/^-?\\d+(?:\\.\\d+)?/i,Zn=/true|false/i,Dn=/null/i;var Tn=/undefined/i;var En=/^[^A-Z]*$/,An=/^[^a-z]*$/;var N=u(\"$ZodCheck\",(e,r)=>{var i;e._zod??(e._zod={}),e._zod.def=r,(i=e._zod).onattach??(i.onattach=[])}),Zu={number:\"number\",bigint:\"bigint\",object:\"date\"},Ut=u(\"$ZodCheckLessThan\",(e,r)=>{N.init(e,r);let i=Zu[typeof r.value];e._zod.onattach.push((o)=>{let t=o._zod.bag,n=(r.inclusive?t.maximum:t.exclusiveMaximum)??Number.POSITIVE_INFINITY;if(r.value<n)if(r.inclusive)t.maximum=r.value;else t.exclusiveMaximum=r.value}),e._zod.check=(o)=>{if(r.inclusive?o.value<=r.value:o.value<r.value)return;o.issues.push({origin:i,code:\"too_big\",maximum:r.value,input:o.value,inclusive:r.inclusive,inst:e,continue:!r.abort})}}),Zt=u(\"$ZodCheckGreaterThan\",(e,r)=>{N.init(e,r);let i=Zu[typeof r.value];e._zod.onattach.push((o)=>{let t=o._zod.bag,n=(r.inclusive?t.minimum:t.exclusiveMinimum)??Number.NEGATIVE_INFINITY;if(r.value>n)if(r.inclusive)t.minimum=r.value;else t.exclusiveMinimum=r.value}),e._zod.check=(o)=>{if(r.inclusive?o.value>=r.value:o.value>r.value)return;o.issues.push({origin:i,code:\"too_small\",minimum:r.value,input:o.value,inclusive:r.inclusive,inst:e,continue:!r.abort})}}),Ln=u(\"$ZodCheckMultipleOf\",(e,r)=>{N.init(e,r),e._zod.onattach.push((i)=>{var o;(o=i._zod.bag).multipleOf??(o.multipleOf=r.value)}),e._zod.check=(i)=>{if(typeof i.value!==typeof r.value)throw Error(\"Cannot mix number and bigint in multiple_of check.\");if(typeof i.value===\"bigint\"?i.value%r.value===BigInt(0):en(i.value,r.value)===0)return;i.issues.push({origin:typeof i.value,code:\"not_multiple_of\",divisor:r.value,input:i.value,inst:e,continue:!r.abort})}}),Rn=u(\"$ZodCheckNumberFormat\",(e,r)=>{N.init(e,r),r.format=r.format||\"float64\";let i=r.format?.includes(\"int\"),o=i?\"int\":\"number\",[t,n]=on[r.format];e._zod.onattach.push((a)=>{let c=a._zod.bag;if(c.format=r.format,c.minimum=t,c.maximum=n,i)c.pattern=Nn}),e._zod.check=(a)=>{let c=a.value;if(i){if(!Number.isInteger(c)){a.issues.push({expected:o,format:r.format,code:\"invalid_type\",input:c,inst:e});return}if(!Number.isSafeInteger(c)){if(c>0)a.issues.push({input:c,code:\"too_big\",maximum:Number.MAX_SAFE_INTEGER,note:\"Integers must be within the safe integer range.\",inst:e,origin:o,continue:!r.abort});else a.issues.push({input:c,code:\"too_small\",minimum:Number.MIN_SAFE_INTEGER,note:\"Integers must be within the safe integer range.\",inst:e,origin:o,continue:!r.abort});return}}if(c<t)a.issues.push({origin:\"number\",input:c,code:\"too_small\",minimum:t,inclusive:!0,inst:e,continue:!r.abort});if(c>n)a.issues.push({origin:\"number\",input:c,code:\"too_big\",maximum:n,inst:e})}}),Cn=u(\"$ZodCheckBigIntFormat\",(e,r)=>{N.init(e,r);let[i,o]=an[r.format];e._zod.onattach.push((t)=>{let n=t._zod.bag;n.format=r.format,n.minimum=i,n.maximum=o}),e._zod.check=(t)=>{let n=t.value;if(n<i)t.issues.push({origin:\"bigint\",input:n,code:\"too_small\",minimum:i,inclusive:!0,inst:e,continue:!r.abort});if(n>o)t.issues.push({origin:\"bigint\",input:n,code:\"too_big\",maximum:o,inst:e})}}),Vn=u(\"$ZodCheckMaxSize\",(e,r)=>{var i;N.init(e,r),(i=e._zod.def).when??(i.when=(o)=>{let t=o.value;return!q(t)&&t.size!==void 0}),e._zod.onattach.push((o)=>{let t=o._zod.bag.maximum??Number.POSITIVE_INFINITY;if(r.maximum<t)o._zod.bag.maximum=r.maximum}),e._zod.check=(o)=>{let t=o.value;if(t.size<=r.maximum)return;o.issues.push({origin:We(t),code:\"too_big\",maximum:r.maximum,input:t,inst:e,continue:!r.abort})}}),Fn=u(\"$ZodCheckMinSize\",(e,r)=>{var i;N.init(e,r),(i=e._zod.def).when??(i.when=(o)=>{let t=o.value;return!q(t)&&t.size!==void 0}),e._zod.onattach.push((o)=>{let t=o._zod.bag.minimum??Number.NEGATIVE_INFINITY;if(r.minimum>t)o._zod.bag.minimum=r.minimum}),e._zod.check=(o)=>{let t=o.value;if(t.size>=r.minimum)return;o.issues.push({origin:We(t),code:\"too_small\",minimum:r.minimum,input:t,inst:e,continue:!r.abort})}}),Jn=u(\"$ZodCheckSizeEquals\",(e,r)=>{var i;N.init(e,r),(i=e._zod.def).when??(i.when=(o)=>{let t=o.value;return!q(t)&&t.size!==void 0}),e._zod.onattach.push((o)=>{let t=o._zod.bag;t.minimum=r.size,t.maximum=r.size,t.size=r.size}),e._zod.check=(o)=>{let t=o.value,n=t.size;if(n===r.size)return;let a=n>r.size;o.issues.push({origin:We(t),...a?{code:\"too_big\",maximum:r.size}:{code:\"too_small\",minimum:r.size},inclusive:!0,exact:!0,input:o.value,inst:e,continue:!r.abort})}}),Mn=u(\"$ZodCheckMaxLength\",(e,r)=>{var i;N.init(e,r),(i=e._zod.def).when??(i.when=(o)=>{let t=o.value;return!q(t)&&t.length!==void 0}),e._zod.onattach.push((o)=>{let t=o._zod.bag.maximum??Number.POSITIVE_INFINITY;if(r.maximum<t)o._zod.bag.maximum=r.maximum}),e._zod.check=(o)=>{let t=o.value;if(t.length<=r.maximum)return;let a=Ge(t);o.issues.push({origin:a,code:\"too_big\",maximum:r.maximum,inclusive:!0,input:t,inst:e,continue:!r.abort})}}),Wn=u(\"$ZodCheckMinLength\",(e,r)=>{var i;N.init(e,r),(i=e._zod.def).when??(i.when=(o)=>{let t=o.value;return!q(t)&&t.length!==void 0}),e._zod.onattach.push((o)=>{let t=o._zod.bag.minimum??Number.NEGATIVE_INFINITY;if(r.minimum>t)o._zod.bag.minimum=r.minimum}),e._zod.check=(o)=>{let t=o.value;if(t.length>=r.minimum)return;let a=Ge(t);o.issues.push({origin:a,code:\"too_small\",minimum:r.minimum,inclusive:!0,input:t,inst:e,continue:!r.abort})}}),Gn=u(\"$ZodCheckLengthEquals\",(e,r)=>{var i;N.init(e,r),(i=e._zod.def).when??(i.when=(o)=>{let t=o.value;return!q(t)&&t.length!==void 0}),e._zod.onattach.push((o)=>{let t=o._zod.bag;t.minimum=r.length,t.maximum=r.length,t.length=r.length}),e._zod.check=(o)=>{let t=o.value,n=t.length;if(n===r.length)return;let a=Ge(t),c=n>r.length;o.issues.push({origin:a,...c?{code:\"too_big\",maximum:r.length}:{code:\"too_small\",minimum:r.length},inclusive:!0,exact:!0,input:o.value,inst:e,continue:!r.abort})}}),he=u(\"$ZodCheckStringFormat\",(e,r)=>{var i,o;if(N.init(e,r),e._zod.onattach.push((t)=>{let n=t._zod.bag;if(n.format=r.format,r.pattern)n.patterns??(n.patterns=new Set),n.patterns.add(r.pattern)}),r.pattern)(i=e._zod).check??(i.check=(t)=>{if(r.pattern.lastIndex=0,r.pattern.test(t.value))return;t.issues.push({origin:\"string\",code:\"invalid_format\",format:r.format,input:t.value,...r.pattern?{pattern:r.pattern.toString()}:{},inst:e,continue:!r.abort})});else(o=e._zod).check??(o.check=()=>{})}),Bn=u(\"$ZodCheckRegex\",(e,r)=>{he.init(e,r),e._zod.check=(i)=>{if(r.pattern.lastIndex=0,r.pattern.test(i.value))return;i.issues.push({origin:\"string\",code:\"invalid_format\",format:\"regex\",input:i.value,pattern:r.pattern.toString(),inst:e,continue:!r.abort})}}),Kn=u(\"$ZodCheckLowerCase\",(e,r)=>{r.pattern??(r.pattern=En),he.init(e,r)}),Xn=u(\"$ZodCheckUpperCase\",(e,r)=>{r.pattern??(r.pattern=An),he.init(e,r)}),qn=u(\"$ZodCheckIncludes\",(e,r)=>{N.init(e,r);let i=B(r.includes),o=new RegExp(typeof r.position===\"number\"?`^.{${r.position}}${i}`:i);r.pattern=o,e._zod.onattach.push((t)=>{let n=t._zod.bag;n.patterns??(n.patterns=new Set),n.patterns.add(o)}),e._zod.check=(t)=>{if(t.value.includes(r.includes,r.position))return;t.issues.push({origin:\"string\",code:\"invalid_format\",format:\"includes\",includes:r.includes,input:t.value,inst:e,continue:!r.abort})}}),Yn=u(\"$ZodCheckStartsWith\",(e,r)=>{N.init(e,r);let i=new RegExp(`^${B(r.prefix)}.*`);r.pattern??(r.pattern=i),e._zod.onattach.push((o)=>{let t=o._zod.bag;t.patterns??(t.patterns=new Set),t.patterns.add(i)}),e._zod.check=(o)=>{if(o.value.startsWith(r.prefix))return;o.issues.push({origin:\"string\",code:\"invalid_format\",format:\"starts_with\",prefix:r.prefix,input:o.value,inst:e,continue:!r.abort})}}),Hn=u(\"$ZodCheckEndsWith\",(e,r)=>{N.init(e,r);let i=new RegExp(`.*${B(r.suffix)}$`);r.pattern??(r.pattern=i),e._zod.onattach.push((o)=>{let t=o._zod.bag;t.patterns??(t.patterns=new Set),t.patterns.add(i)}),e._zod.check=(o)=>{if(o.value.endsWith(r.suffix))return;o.issues.push({origin:\"string\",code:\"invalid_format\",format:\"ends_with\",suffix:r.suffix,input:o.value,inst:e,continue:!r.abort})}});function Uu(e,r,i){if(e.issues.length)r.issues.push(...A(i,e.issues))}var Qn=u(\"$ZodCheckProperty\",(e,r)=>{N.init(e,r),e._zod.check=(i)=>{let o=r.schema._zod.run({value:i.value[r.property],issues:[]},{});if(o instanceof Promise)return o.then((t)=>Uu(t,i,r.property));Uu(o,i,r.property);return}}),ei=u(\"$ZodCheckMimeType\",(e,r)=>{N.init(e,r);let i=new Set(r.mime);e._zod.onattach.push((o)=>{o._zod.bag.mime=r.mime}),e._zod.check=(o)=>{if(i.has(o.value.type))return;o.issues.push({code:\"invalid_value\",values:r.mime,input:o.value.type,inst:e})}}),ti=u(\"$ZodCheckOverwrite\",(e,r)=>{N.init(e,r),e._zod.check=(i)=>{i.value=r.tx(i.value)}});class Dt{constructor(e=[]){if(this.content=[],this.indent=0,this)this.args=e}indented(e){this.indent+=1,e(this),this.indent-=1}write(e){if(typeof e===\"function\"){e(this,{execution:\"sync\"}),e(this,{execution:\"async\"});return}let i=e.split(`\n`).filter((n)=>n),o=Math.min(...i.map((n)=>n.length-n.trimStart().length)),t=i.map((n)=>n.slice(o)).map((n)=>\" \".repeat(this.indent*2)+n);for(let n of t)this.content.push(n)}compile(){let e=Function,r=this?.args,o=[...(this?.content??[\"\"]).map((t)=>`  ${t}`)];return new e(...r,o.join(`\n`))}}var ri={major:4,minor:0,patch:0};var x=u(\"$ZodType\",(e,r)=>{var i;e??(e={}),e._zod.def=r,e._zod.bag=e._zod.bag||{},e._zod.version=ri;let o=[...e._zod.def.checks??[]];if(e._zod.traits.has(\"$ZodCheck\"))o.unshift(e);for(let t of o)for(let n of t._zod.onattach)n(e);if(o.length===0)(i=e._zod).deferred??(i.deferred=[]),e._zod.deferred?.push(()=>{e._zod.run=e._zod.parse});else{let t=(n,a,c)=>{let p=te(n),m;for(let f of a){if(f._zod.def.when){if(!f._zod.def.when(n))continue}else if(p)continue;let _=n.issues.length,h=f._zod.check(n);if(h instanceof Promise&&c?.async===!1)throw new G;if(m||h instanceof Promise)m=(m??Promise.resolve()).then(async()=>{if(await h,n.issues.length===_)return;if(!p)p=te(n,_)});else{if(n.issues.length===_)continue;if(!p)p=te(n,_)}}if(m)return m.then(()=>n);return n};e._zod.run=(n,a)=>{let c=e._zod.parse(n,a);if(c instanceof Promise){if(a.async===!1)throw new G;return c.then((p)=>t(p,o,a))}return t(c,o,a)}}e[\"~standard\"]={validate:(t)=>{try{let n=un(e,t);return n.success?{value:n.data}:{issues:n.error?.issues}}catch(n){return cn(e,t).then((a)=>a.success?{value:a.data}:{issues:a.error?.issues})}},vendor:\"zod\",version:1}}),ie=u(\"$ZodString\",(e,r)=>{x.init(e,r),e._zod.pattern=[...e?._zod.bag?.patterns??[]].pop()??On(e._zod.bag),e._zod.parse=(i,o)=>{if(r.coerce)try{i.value=String(i.value)}catch(t){}if(typeof i.value===\"string\")return i;return i.issues.push({expected:\"string\",code:\"invalid_type\",input:i.value,inst:e}),i}}),O=u(\"$ZodStringFormat\",(e,r)=>{he.init(e,r),ie.init(e,r)}),ii=u(\"$ZodGUID\",(e,r)=>{r.pattern??(r.pattern=gn),O.init(e,r)}),oi=u(\"$ZodUUID\",(e,r)=>{if(r.version){let o={v1:1,v2:2,v3:3,v4:4,v5:5,v6:6,v7:7,v8:8}[r.version];if(o===void 0)throw Error(`Invalid UUID version: \"${r.version}\"`);r.pattern??(r.pattern=ne(o))}else r.pattern??(r.pattern=ne());O.init(e,r)}),ai=u(\"$ZodEmail\",(e,r)=>{r.pattern??(r.pattern=hn),O.init(e,r)}),ui=u(\"$ZodURL\",(e,r)=>{O.init(e,r),e._zod.check=(i)=>{try{let o=i.value,t=new URL(o),n=t.href;if(r.hostname){if(r.hostname.lastIndex=0,!r.hostname.test(t.hostname))i.issues.push({code:\"invalid_format\",format:\"url\",note:\"Invalid hostname\",pattern:zn.source,input:i.value,inst:e,continue:!r.abort})}if(r.protocol){if(r.protocol.lastIndex=0,!r.protocol.test(t.protocol.endsWith(\":\")?t.protocol.slice(0,-1):t.protocol))i.issues.push({code:\"invalid_format\",format:\"url\",note:\"Invalid protocol\",pattern:r.protocol.source,input:i.value,inst:e,continue:!r.abort})}if(!o.endsWith(\"/\")&&n.endsWith(\"/\"))i.value=n.slice(0,-1);else i.value=n;return}catch(o){i.issues.push({code:\"invalid_format\",format:\"url\",input:i.value,inst:e,continue:!r.abort})}}}),ci=u(\"$ZodEmoji\",(e,r)=>{r.pattern??(r.pattern=$n()),O.init(e,r)}),si=u(\"$ZodNanoID\",(e,r)=>{r.pattern??(r.pattern=fn),O.init(e,r)}),li=u(\"$ZodCUID\",(e,r)=>{r.pattern??(r.pattern=sn),O.init(e,r)}),mi=u(\"$ZodCUID2\",(e,r)=>{r.pattern??(r.pattern=ln),O.init(e,r)}),di=u(\"$ZodULID\",(e,r)=>{r.pattern??(r.pattern=mn),O.init(e,r)}),pi=u(\"$ZodXID\",(e,r)=>{r.pattern??(r.pattern=dn),O.init(e,r)}),fi=u(\"$ZodKSUID\",(e,r)=>{r.pattern??(r.pattern=pn),O.init(e,r)}),vi=u(\"$ZodISODateTime\",(e,r)=>{r.pattern??(r.pattern=jn(r)),O.init(e,r)}),gi=u(\"$ZodISODate\",(e,r)=>{r.pattern??(r.pattern=wn),O.init(e,r)}),hi=u(\"$ZodISOTime\",(e,r)=>{r.pattern??(r.pattern=Sn(r)),O.init(e,r)}),$i=u(\"$ZodISODuration\",(e,r)=>{r.pattern??(r.pattern=vn),O.init(e,r)}),_i=u(\"$ZodIPv4\",(e,r)=>{r.pattern??(r.pattern=_n),O.init(e,r),e._zod.onattach.push((i)=>{let o=i._zod.bag;o.format=\"ipv4\"})}),bi=u(\"$ZodIPv6\",(e,r)=>{r.pattern??(r.pattern=bn),O.init(e,r),e._zod.onattach.push((i)=>{let o=i._zod.bag;o.format=\"ipv6\"}),e._zod.check=(i)=>{try{new URL(`http://[${i.value}]`)}catch{i.issues.push({code:\"invalid_format\",format:\"ipv6\",input:i.value,inst:e,continue:!r.abort})}}}),yi=u(\"$ZodCIDRv4\",(e,r)=>{r.pattern??(r.pattern=yn),O.init(e,r)}),xi=u(\"$ZodCIDRv6\",(e,r)=>{r.pattern??(r.pattern=xn),O.init(e,r),e._zod.check=(i)=>{let[o,t]=i.value.split(\"/\");try{if(!t)throw Error();let n=Number(t);if(`${n}`!==t)throw Error();if(n<0||n>128)throw Error();new URL(`http://[${o}]`)}catch{i.issues.push({code:\"invalid_format\",format:\"cidrv6\",input:i.value,inst:e,continue:!r.abort})}}});function ki(e){if(e===\"\")return!0;if(e.length%4!==0)return!1;try{return atob(e),!0}catch{return!1}}var zi=u(\"$ZodBase64\",(e,r)=>{r.pattern??(r.pattern=kn),O.init(e,r),e._zod.onattach.push((i)=>{i._zod.bag.contentEncoding=\"base64\"}),e._zod.check=(i)=>{if(ki(i.value))return;i.issues.push({code:\"invalid_format\",format:\"base64\",input:i.value,inst:e,continue:!r.abort})}});function Gu(e){if(!Nt.test(e))return!1;let r=e.replace(/[-_]/g,(o)=>o===\"-\"?\"+\":\"/\"),i=r.padEnd(Math.ceil(r.length/4)*4,\"=\");return ki(i)}var Ii=u(\"$ZodBase64URL\",(e,r)=>{r.pattern??(r.pattern=Nt),O.init(e,r),e._zod.onattach.push((i)=>{i._zod.bag.contentEncoding=\"base64url\"}),e._zod.check=(i)=>{if(Gu(i.value))return;i.issues.push({code:\"invalid_format\",format:\"base64url\",input:i.value,inst:e,continue:!r.abort})}}),wi=u(\"$ZodE164\",(e,r)=>{r.pattern??(r.pattern=In),O.init(e,r)});function Bu(e,r=null){try{let i=e.split(\".\");if(i.length!==3)return!1;let[o]=i;if(!o)return!1;let t=JSON.parse(atob(o));if(\"typ\"in t&&t?.typ!==\"JWT\")return!1;if(!t.alg)return!1;if(r&&(!(\"alg\"in t)||t.alg!==r))return!1;return!0}catch{return!1}}var Si=u(\"$ZodJWT\",(e,r)=>{O.init(e,r),e._zod.check=(i)=>{if(Bu(i.value,r.alg))return;i.issues.push({code:\"invalid_format\",format:\"jwt\",input:i.value,inst:e,continue:!r.abort})}}),ji=u(\"$ZodCustomStringFormat\",(e,r)=>{O.init(e,r),e._zod.check=(i)=>{if(r.fn(i.value))return;i.issues.push({code:\"invalid_format\",format:r.format,input:i.value,inst:e,continue:!r.abort})}}),At=u(\"$ZodNumber\",(e,r)=>{x.init(e,r),e._zod.pattern=e._zod.bag.pattern??Un,e._zod.parse=(i,o)=>{if(r.coerce)try{i.value=Number(i.value)}catch(a){}let t=i.value;if(typeof t===\"number\"&&!Number.isNaN(t)&&Number.isFinite(t))return i;let n=typeof t===\"number\"?Number.isNaN(t)?\"NaN\":!Number.isFinite(t)?\"Infinity\":void 0:void 0;return i.issues.push({expected:\"number\",code:\"invalid_type\",input:t,inst:e,...n?{received:n}:{}}),i}}),Oi=u(\"$ZodNumber\",(e,r)=>{Rn.init(e,r),At.init(e,r)}),Ke=u(\"$ZodBoolean\",(e,r)=>{x.init(e,r),e._zod.pattern=Zn,e._zod.parse=(i,o)=>{if(r.coerce)try{i.value=Boolean(i.value)}catch(n){}let t=i.value;if(typeof t===\"boolean\")return i;return i.issues.push({expected:\"boolean\",code:\"invalid_type\",input:t,inst:e}),i}}),Lt=u(\"$ZodBigInt\",(e,r)=>{x.init(e,r),e._zod.pattern=Pn,e._zod.parse=(i,o)=>{if(r.coerce)try{i.value=BigInt(i.value)}catch(t){}if(typeof i.value===\"bigint\")return i;return i.issues.push({expected:\"bigint\",code:\"invalid_type\",input:i.value,inst:e}),i}}),Pi=u(\"$ZodBigInt\",(e,r)=>{Cn.init(e,r),Lt.init(e,r)}),Ni=u(\"$ZodSymbol\",(e,r)=>{x.init(e,r),e._zod.parse=(i,o)=>{let t=i.value;if(typeof t===\"symbol\")return i;return i.issues.push({expected:\"symbol\",code:\"invalid_type\",input:t,inst:e}),i}}),Ui=u(\"$ZodUndefined\",(e,r)=>{x.init(e,r),e._zod.pattern=Tn,e._zod.values=new Set([void 0]),e._zod.optin=\"optional\",e._zod.optout=\"optional\",e._zod.parse=(i,o)=>{let t=i.value;if(typeof t>\"u\")return i;return i.issues.push({expected:\"undefined\",code:\"invalid_type\",input:t,inst:e}),i}}),Zi=u(\"$ZodNull\",(e,r)=>{x.init(e,r),e._zod.pattern=Dn,e._zod.values=new Set([null]),e._zod.parse=(i,o)=>{let t=i.value;if(t===null)return i;return i.issues.push({expected:\"null\",code:\"invalid_type\",input:t,inst:e}),i}}),Di=u(\"$ZodAny\",(e,r)=>{x.init(e,r),e._zod.parse=(i)=>i}),$e=u(\"$ZodUnknown\",(e,r)=>{x.init(e,r),e._zod.parse=(i)=>i}),Ti=u(\"$ZodNever\",(e,r)=>{x.init(e,r),e._zod.parse=(i,o)=>(i.issues.push({expected:\"never\",code:\"invalid_type\",input:i.value,inst:e}),i)}),Ei=u(\"$ZodVoid\",(e,r)=>{x.init(e,r),e._zod.parse=(i,o)=>{let t=i.value;if(typeof t>\"u\")return i;return i.issues.push({expected:\"void\",code:\"invalid_type\",input:t,inst:e}),i}}),Ai=u(\"$ZodDate\",(e,r)=>{x.init(e,r),e._zod.parse=(i,o)=>{if(r.coerce)try{i.value=new Date(i.value)}catch(c){}let t=i.value,n=t instanceof Date;if(n&&!Number.isNaN(t.getTime()))return i;return i.issues.push({expected:\"date\",code:\"invalid_type\",input:t,...n?{received:\"Invalid Date\"}:{},inst:e}),i}});function Tu(e,r,i){if(e.issues.length)r.issues.push(...A(i,e.issues));r.value[i]=e.value}var Xe=u(\"$ZodArray\",(e,r)=>{x.init(e,r),e._zod.parse=(i,o)=>{let t=i.value;if(!Array.isArray(t))return i.issues.push({expected:\"array\",code:\"invalid_type\",input:t,inst:e}),i;i.value=Array(t.length);let n=[];for(let a=0;a<t.length;a++){let c=t[a],p=r.element._zod.run({value:c,issues:[]},o);if(p instanceof Promise)n.push(p.then((m)=>Tu(m,i,a)));else Tu(p,i,a)}if(n.length)return Promise.all(n).then(()=>i);return i}});function Tt(e,r,i){if(e.issues.length)r.issues.push(...A(i,e.issues));r.value[i]=e.value}function Eu(e,r,i,o){if(e.issues.length)if(o[i]===void 0)if(i in o)r.value[i]=void 0;else r.value[i]=e.value;else r.issues.push(...A(i,e.issues));else if(e.value===void 0){if(i in o)r.value[i]=void 0}else r.value[i]=e.value}var Li=u(\"$ZodObject\",(e,r)=>{x.init(e,r);let i=Fe(()=>{let _=Object.keys(r.shape);for(let s of _)if(!(r.shape[s]instanceof x))throw Error(`Invalid element at key \"${s}\": expected a Zod schema`);let h=nn(r.shape);return{shape:r.shape,keys:_,keySet:new Set(_),numKeys:_.length,optionalKeys:new Set(h)}});w(e._zod,\"propValues\",()=>{let _=r.shape,h={};for(let s in _){let v=_[s]._zod;if(v.values){h[s]??(h[s]=new Set);for(let b of v.values)h[s].add(b)}}return h});let o=(_)=>{let h=new Dt([\"shape\",\"payload\",\"ctx\"]),s=i.value,v=(z)=>{let I=ee(z);return`shape[${I}]._zod.run({ value: input[${I}], issues: [] }, ctx)`};h.write(\"const input = payload.value;\");let b=Object.create(null),S=0;for(let z of s.keys)b[z]=`key_${S++}`;h.write(\"const newResult = {}\");for(let z of s.keys)if(s.optionalKeys.has(z)){let I=b[z];h.write(`const ${I} = ${v(z)};`);let U=ee(z);h.write(`\n        if (${I}.issues.length) {\n          if (input[${U}] === undefined) {\n            if (${U} in input) {\n              newResult[${U}] = undefined;\n            }\n          } else {\n            payload.issues = payload.issues.concat(\n              ${I}.issues.map((iss) => ({\n                ...iss,\n                path: iss.path ? [${U}, ...iss.path] : [${U}],\n              }))\n            );\n          }\n        } else if (${I}.value === undefined) {\n          if (${U} in input) newResult[${U}] = undefined;\n        } else {\n          newResult[${U}] = ${I}.value;\n        }\n        `)}else{let I=b[z];h.write(`const ${I} = ${v(z)};`),h.write(`\n          if (${I}.issues.length) payload.issues = payload.issues.concat(${I}.issues.map(iss => ({\n            ...iss,\n            path: iss.path ? [${ee(z)}, ...iss.path] : [${ee(z)}]\n          })));`),h.write(`newResult[${ee(z)}] = ${I}.value`)}h.write(\"payload.value = newResult;\"),h.write(\"return payload;\");let j=h.compile();return(z,I)=>j(_,z,I)},t,n=me,a=!Re.jitless,p=a&&tn.value,m=r.catchall,f;e._zod.parse=(_,h)=>{f??(f=i.value);let s=_.value;if(!n(s))return _.issues.push({expected:\"object\",code:\"invalid_type\",input:s,inst:e}),_;let v=[];if(a&&p&&h?.async===!1&&h.jitless!==!0){if(!t)t=o(r.shape);_=t(_,h)}else{_.value={};let I=f.shape;for(let U of f.keys){let Le=I[U],_t=Le._zod.run({value:s[U],issues:[]},h),_u=Le._zod.optin===\"optional\"&&Le._zod.optout===\"optional\";if(_t instanceof Promise)v.push(_t.then((bu)=>_u?Eu(bu,_,U,s):Tt(bu,_,U)));else if(_u)Eu(_t,_,U,s);else Tt(_t,_,U)}}if(!m)return v.length?Promise.all(v).then(()=>_):_;let b=[],S=f.keySet,j=m._zod,z=j.def.type;for(let I of Object.keys(s)){if(S.has(I))continue;if(z===\"never\"){b.push(I);continue}let U=j.run({value:s[I],issues:[]},h);if(U instanceof Promise)v.push(U.then((Le)=>Tt(Le,_,I)));else Tt(U,_,I)}if(b.length)_.issues.push({code:\"unrecognized_keys\",keys:b,input:s,inst:e});if(!v.length)return _;return Promise.all(v).then(()=>_)}});function Au(e,r,i,o){for(let t of e)if(t.issues.length===0)return r.value=t.value,r;return r.issues.push({code:\"invalid_union\",input:r.value,inst:i,errors:e.map((t)=>t.issues.map((n)=>L(n,o,Z())))}),r}var Rt=u(\"$ZodUnion\",(e,r)=>{x.init(e,r),w(e._zod,\"optin\",()=>r.options.some((i)=>i._zod.optin===\"optional\")?\"optional\":void 0),w(e._zod,\"optout\",()=>r.options.some((i)=>i._zod.optout===\"optional\")?\"optional\":void 0),w(e._zod,\"values\",()=>{if(r.options.every((i)=>i._zod.values))return new Set(r.options.flatMap((i)=>Array.from(i._zod.values)));return}),w(e._zod,\"pattern\",()=>{if(r.options.every((i)=>i._zod.pattern)){let i=r.options.map((o)=>o._zod.pattern);return new RegExp(`^(${i.map((o)=>Je(o.source)).join(\"|\")})$`)}return}),e._zod.parse=(i,o)=>{let t=!1,n=[];for(let a of r.options){let c=a._zod.run({value:i.value,issues:[]},o);if(c instanceof Promise)n.push(c),t=!0;else{if(c.issues.length===0)return c;n.push(c)}}if(!t)return Au(n,i,e,o);return Promise.all(n).then((a)=>Au(a,i,e,o))}}),Ri=u(\"$ZodDiscriminatedUnion\",(e,r)=>{Rt.init(e,r);let i=e._zod.parse;w(e._zod,\"propValues\",()=>{let t={};for(let n of r.options){let a=n._zod.propValues;if(!a||Object.keys(a).length===0)throw Error(`Invalid discriminated union option at index \"${r.options.indexOf(n)}\"`);for(let[c,p]of Object.entries(a)){if(!t[c])t[c]=new Set;for(let m of p)t[c].add(m)}}return t});let o=Fe(()=>{let t=r.options,n=new Map;for(let a of t){let c=a._zod.propValues[r.discriminator];if(!c||c.size===0)throw Error(`Invalid discriminated union option at index \"${r.options.indexOf(a)}\"`);for(let p of c){if(n.has(p))throw Error(`Duplicate discriminator value \"${String(p)}\"`);n.set(p,a)}}return n});e._zod.parse=(t,n)=>{let a=t.value;if(!me(a))return t.issues.push({code:\"invalid_type\",expected:\"object\",input:a,inst:e}),t;let c=o.value.get(a?.[r.discriminator]);if(c)return c._zod.run(t,n);if(r.unionFallback)return i(t,n);return t.issues.push({code:\"invalid_union\",errors:[],note:\"No matching discriminator\",input:a,path:[r.discriminator],inst:e}),t}}),Ci=u(\"$ZodIntersection\",(e,r)=>{x.init(e,r),e._zod.parse=(i,o)=>{let t=i.value,n=r.left._zod.run({value:t,issues:[]},o),a=r.right._zod.run({value:t,issues:[]},o);if(n instanceof Promise||a instanceof Promise)return Promise.all([n,a]).then(([p,m])=>Lu(i,p,m));return Lu(i,n,a)}});function ni(e,r){if(e===r)return{valid:!0,data:e};if(e instanceof Date&&r instanceof Date&&+e===+r)return{valid:!0,data:e};if(pe(e)&&pe(r)){let i=Object.keys(r),o=Object.keys(e).filter((n)=>i.indexOf(n)!==-1),t={...e,...r};for(let n of o){let a=ni(e[n],r[n]);if(!a.valid)return{valid:!1,mergeErrorPath:[n,...a.mergeErrorPath]};t[n]=a.data}return{valid:!0,data:t}}if(Array.isArray(e)&&Array.isArray(r)){if(e.length!==r.length)return{valid:!1,mergeErrorPath:[]};let i=[];for(let o=0;o<e.length;o++){let t=e[o],n=r[o],a=ni(t,n);if(!a.valid)return{valid:!1,mergeErrorPath:[o,...a.mergeErrorPath]};i.push(a.data)}return{valid:!0,data:i}}return{valid:!1,mergeErrorPath:[]}}function Lu(e,r,i){if(r.issues.length)e.issues.push(...r.issues);if(i.issues.length)e.issues.push(...i.issues);if(te(e))return e;let o=ni(r.value,i.value);if(!o.valid)throw Error(`Unmergable intersection. Error path: ${JSON.stringify(o.mergeErrorPath)}`);return e.value=o.data,e}var oe=u(\"$ZodTuple\",(e,r)=>{x.init(e,r);let i=r.items,o=i.length-[...i].reverse().findIndex((t)=>t._zod.optin!==\"optional\");e._zod.parse=(t,n)=>{let a=t.value;if(!Array.isArray(a))return t.issues.push({input:a,inst:e,expected:\"tuple\",code:\"invalid_type\"}),t;t.value=[];let c=[];if(!r.rest){let m=a.length>i.length,f=a.length<o-1;if(m||f)return t.issues.push({input:a,inst:e,origin:\"array\",...m?{code:\"too_big\",maximum:i.length}:{code:\"too_small\",minimum:i.length}}),t}let p=-1;for(let m of i){if(p++,p>=a.length){if(p>=o)continue}let f=m._zod.run({value:a[p],issues:[]},n);if(f instanceof Promise)c.push(f.then((_)=>Et(_,t,p)));else Et(f,t,p)}if(r.rest){let m=a.slice(i.length);for(let f of m){p++;let _=r.rest._zod.run({value:f,issues:[]},n);if(_ instanceof Promise)c.push(_.then((h)=>Et(h,t,p)));else Et(_,t,p)}}if(c.length)return Promise.all(c).then(()=>t);return t}});function Et(e,r,i){if(e.issues.length)r.issues.push(...A(i,e.issues));r.value[i]=e.value}var Vi=u(\"$ZodRecord\",(e,r)=>{x.init(e,r),e._zod.parse=(i,o)=>{let t=i.value;if(!pe(t))return i.issues.push({expected:\"record\",code:\"invalid_type\",input:t,inst:e}),i;let n=[];if(r.keyType._zod.values){let a=r.keyType._zod.values;i.value={};for(let p of a)if(typeof p===\"string\"||typeof p===\"number\"||typeof p===\"symbol\"){let m=r.valueType._zod.run({value:t[p],issues:[]},o);if(m instanceof Promise)n.push(m.then((f)=>{if(f.issues.length)i.issues.push(...A(p,f.issues));i.value[p]=f.value}));else{if(m.issues.length)i.issues.push(...A(p,m.issues));i.value[p]=m.value}}let c;for(let p in t)if(!a.has(p))c=c??[],c.push(p);if(c&&c.length>0)i.issues.push({code:\"unrecognized_keys\",input:t,inst:e,keys:c})}else{i.value={};for(let a of Reflect.ownKeys(t)){if(a===\"__proto__\")continue;let c=r.keyType._zod.run({value:a,issues:[]},o);if(c instanceof Promise)throw Error(\"Async schemas not supported in object keys currently\");if(c.issues.length){i.issues.push({origin:\"record\",code:\"invalid_key\",issues:c.issues.map((m)=>L(m,o,Z())),input:a,path:[a],inst:e}),i.value[c.value]=c.value;continue}let p=r.valueType._zod.run({value:t[a],issues:[]},o);if(p instanceof Promise)n.push(p.then((m)=>{if(m.issues.length)i.issues.push(...A(a,m.issues));i.value[c.value]=m.value}));else{if(p.issues.length)i.issues.push(...A(a,p.issues));i.value[c.value]=p.value}}}if(n.length)return Promise.all(n).then(()=>i);return i}}),Fi=u(\"$ZodMap\",(e,r)=>{x.init(e,r),e._zod.parse=(i,o)=>{let t=i.value;if(!(t instanceof Map))return i.issues.push({expected:\"map\",code:\"invalid_type\",input:t,inst:e}),i;let n=[];i.value=new Map;for(let[a,c]of t){let p=r.keyType._zod.run({value:a,issues:[]},o),m=r.valueType._zod.run({value:c,issues:[]},o);if(p instanceof Promise||m instanceof Promise)n.push(Promise.all([p,m]).then(([f,_])=>{Ru(f,_,i,a,t,e,o)}));else Ru(p,m,i,a,t,e,o)}if(n.length)return Promise.all(n).then(()=>i);return i}});function Ru(e,r,i,o,t,n,a){if(e.issues.length)if(Me.has(typeof o))i.issues.push(...A(o,e.issues));else i.issues.push({origin:\"map\",code:\"invalid_key\",input:t,inst:n,issues:e.issues.map((c)=>L(c,a,Z()))});if(r.issues.length)if(Me.has(typeof o))i.issues.push(...A(o,r.issues));else i.issues.push({origin:\"map\",code:\"invalid_element\",input:t,inst:n,key:o,issues:r.issues.map((c)=>L(c,a,Z()))});i.value.set(e.value,r.value)}var Ji=u(\"$ZodSet\",(e,r)=>{x.init(e,r),e._zod.parse=(i,o)=>{let t=i.value;if(!(t instanceof Set))return i.issues.push({input:t,inst:e,expected:\"set\",code:\"invalid_type\"}),i;let n=[];i.value=new Set;for(let a of t){let c=r.valueType._zod.run({value:a,issues:[]},o);if(c instanceof Promise)n.push(c.then((p)=>Cu(p,i)));else Cu(c,i)}if(n.length)return Promise.all(n).then(()=>i);return i}});function Cu(e,r){if(e.issues.length)r.issues.push(...e.issues);r.value.add(e.value)}var Mi=u(\"$ZodEnum\",(e,r)=>{x.init(e,r);let i=Ve(r.entries);e._zod.values=new Set(i),e._zod.pattern=new RegExp(`^(${i.filter((o)=>Me.has(typeof o)).map((o)=>typeof o===\"string\"?B(o):o.toString()).join(\"|\")})$`),e._zod.parse=(o,t)=>{let n=o.value;if(e._zod.values.has(n))return o;return o.issues.push({code:\"invalid_value\",values:i,input:n,inst:e}),o}}),Wi=u(\"$ZodLiteral\",(e,r)=>{x.init(e,r),e._zod.values=new Set(r.values),e._zod.pattern=new RegExp(`^(${r.values.map((i)=>typeof i===\"string\"?B(i):i?i.toString():String(i)).join(\"|\")})$`),e._zod.parse=(i,o)=>{let t=i.value;if(e._zod.values.has(t))return i;return i.issues.push({code:\"invalid_value\",values:r.values,input:t,inst:e}),i}}),Gi=u(\"$ZodFile\",(e,r)=>{x.init(e,r),e._zod.parse=(i,o)=>{let t=i.value;if(t instanceof File)return i;return i.issues.push({expected:\"file\",code:\"invalid_type\",input:t,inst:e}),i}}),qe=u(\"$ZodTransform\",(e,r)=>{x.init(e,r),e._zod.parse=(i,o)=>{let t=r.transform(i.value,i);if(o.async)return(t instanceof Promise?t:Promise.resolve(t)).then((a)=>(i.value=a,i));if(t instanceof Promise)throw new G;return i.value=t,i}}),Bi=u(\"$ZodOptional\",(e,r)=>{x.init(e,r),e._zod.optin=\"optional\",e._zod.optout=\"optional\",w(e._zod,\"values\",()=>r.innerType._zod.values?new Set([...r.innerType._zod.values,void 0]):void 0),w(e._zod,\"pattern\",()=>{let i=r.innerType._zod.pattern;return i?new RegExp(`^(${Je(i.source)})?$`):void 0}),e._zod.parse=(i,o)=>{if(r.innerType._zod.optin===\"optional\")return r.innerType._zod.run(i,o);if(i.value===void 0)return i;return r.innerType._zod.run(i,o)}}),Ki=u(\"$ZodNullable\",(e,r)=>{x.init(e,r),w(e._zod,\"optin\",()=>r.innerType._zod.optin),w(e._zod,\"optout\",()=>r.innerType._zod.optout),w(e._zod,\"pattern\",()=>{let i=r.innerType._zod.pattern;return i?new RegExp(`^(${Je(i.source)}|null)$`):void 0}),w(e._zod,\"values\",()=>r.innerType._zod.values?new Set([...r.innerType._zod.values,null]):void 0),e._zod.parse=(i,o)=>{if(i.value===null)return i;return r.innerType._zod.run(i,o)}}),Xi=u(\"$ZodDefault\",(e,r)=>{x.init(e,r),e._zod.optin=\"optional\",w(e._zod,\"values\",()=>r.innerType._zod.values),e._zod.parse=(i,o)=>{if(i.value===void 0)return i.value=r.defaultValue,i;let t=r.innerType._zod.run(i,o);if(t instanceof Promise)return t.then((n)=>Vu(n,r));return Vu(t,r)}});function Vu(e,r){if(e.value===void 0)e.value=r.defaultValue;return e}var qi=u(\"$ZodPrefault\",(e,r)=>{x.init(e,r),e._zod.optin=\"optional\",w(e._zod,\"values\",()=>r.innerType._zod.values),e._zod.parse=(i,o)=>{if(i.value===void 0)i.value=r.defaultValue;return r.innerType._zod.run(i,o)}}),Yi=u(\"$ZodNonOptional\",(e,r)=>{x.init(e,r),w(e._zod,\"values\",()=>{let i=r.innerType._zod.values;return i?new Set([...i].filter((o)=>o!==void 0)):void 0}),e._zod.parse=(i,o)=>{let t=r.innerType._zod.run(i,o);if(t instanceof Promise)return t.then((n)=>Fu(n,e));return Fu(t,e)}});function Fu(e,r){if(!e.issues.length&&e.value===void 0)e.issues.push({code:\"invalid_type\",expected:\"nonoptional\",input:e.value,inst:r});return e}var Hi=u(\"$ZodSuccess\",(e,r)=>{x.init(e,r),e._zod.parse=(i,o)=>{let t=r.innerType._zod.run(i,o);if(t instanceof Promise)return t.then((n)=>(i.value=n.issues.length===0,i));return i.value=t.issues.length===0,i}}),Qi=u(\"$ZodCatch\",(e,r)=>{x.init(e,r),e._zod.optin=\"optional\",w(e._zod,\"optout\",()=>r.innerType._zod.optout),w(e._zod,\"values\",()=>r.innerType._zod.values),e._zod.parse=(i,o)=>{let t=r.innerType._zod.run(i,o);if(t instanceof Promise)return t.then((n)=>{if(i.value=n.value,n.issues.length)i.value=r.catchValue({...i,error:{issues:n.issues.map((a)=>L(a,o,Z()))},input:i.value}),i.issues=[];return i});if(i.value=t.value,t.issues.length)i.value=r.catchValue({...i,error:{issues:t.issues.map((n)=>L(n,o,Z()))},input:i.value}),i.issues=[];return i}}),eo=u(\"$ZodNaN\",(e,r)=>{x.init(e,r),e._zod.parse=(i,o)=>{if(typeof i.value!==\"number\"||!Number.isNaN(i.value))return i.issues.push({input:i.value,inst:e,expected:\"nan\",code:\"invalid_type\"}),i;return i}}),Ye=u(\"$ZodPipe\",(e,r)=>{x.init(e,r),w(e._zod,\"values\",()=>r.in._zod.values),w(e._zod,\"optin\",()=>r.in._zod.optin),w(e._zod,\"optout\",()=>r.out._zod.optout),e._zod.parse=(i,o)=>{let t=r.in._zod.run(i,o);if(t instanceof Promise)return t.then((n)=>Ju(n,r,o));return Ju(t,r,o)}});function Ju(e,r,i){if(te(e))return e;return r.out._zod.run({value:e.value,issues:e.issues},i)}var to=u(\"$ZodReadonly\",(e,r)=>{x.init(e,r),w(e._zod,\"propValues\",()=>r.innerType._zod.propValues),w(e._zod,\"values\",()=>r.innerType._zod.values),w(e._zod,\"optin\",()=>r.innerType._zod.optin),w(e._zod,\"optout\",()=>r.innerType._zod.optout),e._zod.parse=(i,o)=>{let t=r.innerType._zod.run(i,o);if(t instanceof Promise)return t.then(Mu);return Mu(t)}});function Mu(e){return e.value=Object.freeze(e.value),e}var ro=u(\"$ZodTemplateLiteral\",(e,r)=>{x.init(e,r);let i=[];for(let o of r.parts)if(o instanceof x){if(!o._zod.pattern)throw Error(`Invalid template literal part, no pattern found: ${[...o._zod.traits].shift()}`);let t=o._zod.pattern instanceof RegExp?o._zod.pattern.source:o._zod.pattern;if(!t)throw Error(`Invalid template literal part: ${o._zod.traits}`);let n=t.startsWith(\"^\")?1:0,a=t.endsWith(\"$\")?t.length-1:t.length;i.push(t.slice(n,a))}else if(o===null||rn.has(typeof o))i.push(B(`${o}`));else throw Error(`Invalid template literal part: ${o}`);e._zod.pattern=new RegExp(`^${i.join(\"\")}$`),e._zod.parse=(o,t)=>{if(typeof o.value!==\"string\")return o.issues.push({input:o.value,inst:e,expected:\"template_literal\",code:\"invalid_type\"}),o;if(e._zod.pattern.lastIndex=0,!e._zod.pattern.test(o.value))return o.issues.push({input:o.value,inst:e,code:\"invalid_format\",format:\"template_literal\",pattern:e._zod.pattern.source}),o;return o}}),no=u(\"$ZodPromise\",(e,r)=>{x.init(e,r),e._zod.parse=(i,o)=>Promise.resolve(i.value).then((t)=>r.innerType._zod.run({value:t,issues:[]},o))}),io=u(\"$ZodLazy\",(e,r)=>{x.init(e,r),w(e._zod,\"innerType\",()=>r.getter()),w(e._zod,\"pattern\",()=>e._zod.innerType._zod.pattern),w(e._zod,\"propValues\",()=>e._zod.innerType._zod.propValues),w(e._zod,\"optin\",()=>e._zod.innerType._zod.optin),w(e._zod,\"optout\",()=>e._zod.innerType._zod.optout),e._zod.parse=(i,o)=>e._zod.innerType._zod.run(i,o)}),oo=u(\"$ZodCustom\",(e,r)=>{N.init(e,r),x.init(e,r),e._zod.parse=(i,o)=>i,e._zod.check=(i)=>{let o=i.value,t=r.fn(o);if(t instanceof Promise)return t.then((n)=>Wu(n,i,o,e));Wu(t,i,o,e);return}});function Wu(e,r,i,o){if(!e){let t={code:\"custom\",input:i,inst:o,path:[...o._zod.def.path??[]],continue:!o._zod.def.abort};if(o._zod.def.params)t.params=o._zod.def.params;r.issues.push(re(t))}}var Us=()=>{let e={string:{unit:\"حرف\",verb:\"أن يحوي\"},file:{unit:\"بايت\",verb:\"أن يحوي\"},array:{unit:\"عنصر\",verb:\"أن يحوي\"},set:{unit:\"عنصر\",verb:\"أن يحوي\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"number\";case\"object\":{if(Array.isArray(t))return\"array\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"مدخل\",email:\"بريد إلكتروني\",url:\"رابط\",emoji:\"إيموجي\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"تاريخ ووقت بمعيار ISO\",date:\"تاريخ بمعيار ISO\",time:\"وقت بمعيار ISO\",duration:\"مدة بمعيار ISO\",ipv4:\"عنوان IPv4\",ipv6:\"عنوان IPv6\",cidrv4:\"مدى عناوين بصيغة IPv4\",cidrv6:\"مدى عناوين بصيغة IPv6\",base64:\"نَص بترميز base64-encoded\",base64url:\"نَص بترميز base64url-encoded\",json_string:\"نَص على هيئة JSON\",e164:\"رقم هاتف بمعيار E.164\",jwt:\"JWT\",template_literal:\"مدخل\"};return(t)=>{switch(t.code){case\"invalid_type\":return`مدخلات غير مقبولة: يفترض إدخال ${t.expected}، ولكن تم إدخال ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`مدخلات غير مقبولة: يفترض إدخال ${g(t.values[0])}`;return`اختيار غير مقبول: يتوقع انتقاء أحد هذه الخيارات: ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return` أكبر من اللازم: يفترض أن تكون ${t.origin??\"القيمة\"} ${n} ${t.maximum.toString()} ${a.unit??\"عنصر\"}`;return`أكبر من اللازم: يفترض أن تكون ${t.origin??\"القيمة\"} ${n} ${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`أصغر من اللازم: يفترض لـ ${t.origin} أن يكون ${n} ${t.minimum.toString()} ${a.unit}`;return`أصغر من اللازم: يفترض لـ ${t.origin} أن يكون ${n} ${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`نَص غير مقبول: يجب أن يبدأ بـ \"${t.prefix}\"`;if(n.format===\"ends_with\")return`نَص غير مقبول: يجب أن ينتهي بـ \"${n.suffix}\"`;if(n.format===\"includes\")return`نَص غير مقبول: يجب أن يتضمَّن \"${n.includes}\"`;if(n.format===\"regex\")return`نَص غير مقبول: يجب أن يطابق النمط ${n.pattern}`;return`${o[n.format]??t.format} غير مقبول`}case\"not_multiple_of\":return`رقم غير مقبول: يجب أن يكون من مضاعفات ${t.divisor}`;case\"unrecognized_keys\":return`معرف${t.keys.length>1?\"ات\":\"\"} غريب${t.keys.length>1?\"ة\":\"\"}: ${l(t.keys,\"، \")}`;case\"invalid_key\":return`معرف غير مقبول في ${t.origin}`;case\"invalid_union\":return\"مدخل غير مقبول\";case\"invalid_element\":return`مدخل غير مقبول في ${t.origin}`;default:return\"مدخل غير مقبول\"}}};function ao(){return{localeError:Us()}}var Zs=()=>{let e={string:{unit:\"simvol\",verb:\"olmalıdır\"},file:{unit:\"bayt\",verb:\"olmalıdır\"},array:{unit:\"element\",verb:\"olmalıdır\"},set:{unit:\"element\",verb:\"olmalıdır\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"number\";case\"object\":{if(Array.isArray(t))return\"array\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"input\",email:\"email address\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO datetime\",date:\"ISO date\",time:\"ISO time\",duration:\"ISO duration\",ipv4:\"IPv4 address\",ipv6:\"IPv6 address\",cidrv4:\"IPv4 range\",cidrv6:\"IPv6 range\",base64:\"base64-encoded string\",base64url:\"base64url-encoded string\",json_string:\"JSON string\",e164:\"E.164 number\",jwt:\"JWT\",template_literal:\"input\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Yanlış dəyər: gözlənilən ${t.expected}, daxil olan ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Yanlış dəyər: gözlənilən ${g(t.values[0])}`;return`Yanlış seçim: aşağıdakılardan biri olmalıdır: ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`Çox böyük: gözlənilən ${t.origin??\"dəyər\"} ${n}${t.maximum.toString()} ${a.unit??\"element\"}`;return`Çox böyük: gözlənilən ${t.origin??\"dəyər\"} ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`Çox kiçik: gözlənilən ${t.origin} ${n}${t.minimum.toString()} ${a.unit}`;return`Çox kiçik: gözlənilən ${t.origin} ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Yanlış mətn: \"${n.prefix}\" ilə başlamalıdır`;if(n.format===\"ends_with\")return`Yanlış mətn: \"${n.suffix}\" ilə bitməlidir`;if(n.format===\"includes\")return`Yanlış mətn: \"${n.includes}\" daxil olmalıdır`;if(n.format===\"regex\")return`Yanlış mətn: ${n.pattern} şablonuna uyğun olmalıdır`;return`Yanlış ${o[n.format]??t.format}`}case\"not_multiple_of\":return`Yanlış ədəd: ${t.divisor} ilə bölünə bilən olmalıdır`;case\"unrecognized_keys\":return`Tanınmayan açar${t.keys.length>1?\"lar\":\"\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`${t.origin} daxilində yanlış açar`;case\"invalid_union\":return\"Yanlış dəyər\";case\"invalid_element\":return`${t.origin} daxilində yanlış dəyər`;default:return\"Yanlış dəyər\"}}};function uo(){return{localeError:Zs()}}function Xu(e,r,i,o){let t=Math.abs(e),n=t%10,a=t%100;if(a>=11&&a<=19)return o;if(n===1)return r;if(n>=2&&n<=4)return i;return o}var Ds=()=>{let e={string:{unit:{one:\"сімвал\",few:\"сімвалы\",many:\"сімвалаў\"},verb:\"мець\"},array:{unit:{one:\"элемент\",few:\"элементы\",many:\"элементаў\"},verb:\"мець\"},set:{unit:{one:\"элемент\",few:\"элементы\",many:\"элементаў\"},verb:\"мець\"},file:{unit:{one:\"байт\",few:\"байты\",many:\"байтаў\"},verb:\"мець\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"лік\";case\"object\":{if(Array.isArray(t))return\"масіў\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"увод\",email:\"email адрас\",url:\"URL\",emoji:\"эмодзі\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO дата і час\",date:\"ISO дата\",time:\"ISO час\",duration:\"ISO працягласць\",ipv4:\"IPv4 адрас\",ipv6:\"IPv6 адрас\",cidrv4:\"IPv4 дыяпазон\",cidrv6:\"IPv6 дыяпазон\",base64:\"радок у фармаце base64\",base64url:\"радок у фармаце base64url\",json_string:\"JSON радок\",e164:\"нумар E.164\",jwt:\"JWT\",template_literal:\"увод\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Няправільны ўвод: чакаўся ${t.expected}, атрымана ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Няправільны ўвод: чакалася ${g(t.values[0])}`;return`Няправільны варыянт: чакаўся адзін з ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a){let c=Number(t.maximum),p=Xu(c,a.unit.one,a.unit.few,a.unit.many);return`Занадта вялікі: чакалася, што ${t.origin??\"значэнне\"} павінна ${a.verb} ${n}${t.maximum.toString()} ${p}`}return`Занадта вялікі: чакалася, што ${t.origin??\"значэнне\"} павінна быць ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a){let c=Number(t.minimum),p=Xu(c,a.unit.one,a.unit.few,a.unit.many);return`Занадта малы: чакалася, што ${t.origin} павінна ${a.verb} ${n}${t.minimum.toString()} ${p}`}return`Занадта малы: чакалася, што ${t.origin} павінна быць ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Няправільны радок: павінен пачынацца з \"${n.prefix}\"`;if(n.format===\"ends_with\")return`Няправільны радок: павінен заканчвацца на \"${n.suffix}\"`;if(n.format===\"includes\")return`Няправільны радок: павінен змяшчаць \"${n.includes}\"`;if(n.format===\"regex\")return`Няправільны радок: павінен адпавядаць шаблону ${n.pattern}`;return`Няправільны ${o[n.format]??t.format}`}case\"not_multiple_of\":return`Няправільны лік: павінен быць кратным ${t.divisor}`;case\"unrecognized_keys\":return`Нераспазнаны ${t.keys.length>1?\"ключы\":\"ключ\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`Няправільны ключ у ${t.origin}`;case\"invalid_union\":return\"Няправільны ўвод\";case\"invalid_element\":return`Няправільнае значэнне ў ${t.origin}`;default:return\"Няправільны ўвод\"}}};function co(){return{localeError:Ds()}}var Ts=()=>{let e={string:{unit:\"caràcters\",verb:\"contenir\"},file:{unit:\"bytes\",verb:\"contenir\"},array:{unit:\"elements\",verb:\"contenir\"},set:{unit:\"elements\",verb:\"contenir\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"number\";case\"object\":{if(Array.isArray(t))return\"array\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"entrada\",email:\"adreça electrònica\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"data i hora ISO\",date:\"data ISO\",time:\"hora ISO\",duration:\"durada ISO\",ipv4:\"adreça IPv4\",ipv6:\"adreça IPv6\",cidrv4:\"rang IPv4\",cidrv6:\"rang IPv6\",base64:\"cadena codificada en base64\",base64url:\"cadena codificada en base64url\",json_string:\"cadena JSON\",e164:\"número E.164\",jwt:\"JWT\",template_literal:\"entrada\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Tipus invàlid: s'esperava ${t.expected}, s'ha rebut ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Valor invàlid: s'esperava ${g(t.values[0])}`;return`Opció invàlida: s'esperava una de ${l(t.values,\" o \")}`;case\"too_big\":{let n=t.inclusive?\"com a màxim\":\"menys de\",a=r(t.origin);if(a)return`Massa gran: s'esperava que ${t.origin??\"el valor\"} contingués ${n} ${t.maximum.toString()} ${a.unit??\"elements\"}`;return`Massa gran: s'esperava que ${t.origin??\"el valor\"} fos ${n} ${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\"com a mínim\":\"més de\",a=r(t.origin);if(a)return`Massa petit: s'esperava que ${t.origin} contingués ${n} ${t.minimum.toString()} ${a.unit}`;return`Massa petit: s'esperava que ${t.origin} fos ${n} ${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Format invàlid: ha de començar amb \"${n.prefix}\"`;if(n.format===\"ends_with\")return`Format invàlid: ha d'acabar amb \"${n.suffix}\"`;if(n.format===\"includes\")return`Format invàlid: ha d'incloure \"${n.includes}\"`;if(n.format===\"regex\")return`Format invàlid: ha de coincidir amb el patró ${n.pattern}`;return`Format invàlid per a ${o[n.format]??t.format}`}case\"not_multiple_of\":return`Número invàlid: ha de ser múltiple de ${t.divisor}`;case\"unrecognized_keys\":return`Clau${t.keys.length>1?\"s\":\"\"} no reconeguda${t.keys.length>1?\"s\":\"\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`Clau invàlida a ${t.origin}`;case\"invalid_union\":return\"Entrada invàlida\";case\"invalid_element\":return`Element invàlid a ${t.origin}`;default:return\"Entrada invàlida\"}}};function so(){return{localeError:Ts()}}var Es=()=>{let e={string:{unit:\"znaků\",verb:\"mít\"},file:{unit:\"bajtů\",verb:\"mít\"},array:{unit:\"prvků\",verb:\"mít\"},set:{unit:\"prvků\",verb:\"mít\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"číslo\";case\"string\":return\"řetězec\";case\"boolean\":return\"boolean\";case\"bigint\":return\"bigint\";case\"function\":return\"funkce\";case\"symbol\":return\"symbol\";case\"undefined\":return\"undefined\";case\"object\":{if(Array.isArray(t))return\"pole\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"regulární výraz\",email:\"e-mailová adresa\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"datum a čas ve formátu ISO\",date:\"datum ve formátu ISO\",time:\"čas ve formátu ISO\",duration:\"doba trvání ISO\",ipv4:\"IPv4 adresa\",ipv6:\"IPv6 adresa\",cidrv4:\"rozsah IPv4\",cidrv6:\"rozsah IPv6\",base64:\"řetězec zakódovaný ve formátu base64\",base64url:\"řetězec zakódovaný ve formátu base64url\",json_string:\"řetězec ve formátu JSON\",e164:\"číslo E.164\",jwt:\"JWT\",template_literal:\"vstup\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Neplatný vstup: očekáváno ${t.expected}, obdrženo ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Neplatný vstup: očekáváno ${g(t.values[0])}`;return`Neplatná možnost: očekávána jedna z hodnot ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`Hodnota je příliš velká: ${t.origin??\"hodnota\"} musí mít ${n}${t.maximum.toString()} ${a.unit??\"prvků\"}`;return`Hodnota je příliš velká: ${t.origin??\"hodnota\"} musí být ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`Hodnota je příliš malá: ${t.origin??\"hodnota\"} musí mít ${n}${t.minimum.toString()} ${a.unit??\"prvků\"}`;return`Hodnota je příliš malá: ${t.origin??\"hodnota\"} musí být ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Neplatný řetězec: musí začínat na \"${n.prefix}\"`;if(n.format===\"ends_with\")return`Neplatný řetězec: musí končit na \"${n.suffix}\"`;if(n.format===\"includes\")return`Neplatný řetězec: musí obsahovat \"${n.includes}\"`;if(n.format===\"regex\")return`Neplatný řetězec: musí odpovídat vzoru ${n.pattern}`;return`Neplatný formát ${o[n.format]??t.format}`}case\"not_multiple_of\":return`Neplatné číslo: musí být násobkem ${t.divisor}`;case\"unrecognized_keys\":return`Neznámé klíče: ${l(t.keys,\", \")}`;case\"invalid_key\":return`Neplatný klíč v ${t.origin}`;case\"invalid_union\":return\"Neplatný vstup\";case\"invalid_element\":return`Neplatná hodnota v ${t.origin}`;default:return\"Neplatný vstup\"}}};function lo(){return{localeError:Es()}}var As=()=>{let e={string:{unit:\"Zeichen\",verb:\"zu haben\"},file:{unit:\"Bytes\",verb:\"zu haben\"},array:{unit:\"Elemente\",verb:\"zu haben\"},set:{unit:\"Elemente\",verb:\"zu haben\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"Zahl\";case\"object\":{if(Array.isArray(t))return\"Array\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"Eingabe\",email:\"E-Mail-Adresse\",url:\"URL\",emoji:\"Emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO-Datum und -Uhrzeit\",date:\"ISO-Datum\",time:\"ISO-Uhrzeit\",duration:\"ISO-Dauer\",ipv4:\"IPv4-Adresse\",ipv6:\"IPv6-Adresse\",cidrv4:\"IPv4-Bereich\",cidrv6:\"IPv6-Bereich\",base64:\"Base64-codierter String\",base64url:\"Base64-URL-codierter String\",json_string:\"JSON-String\",e164:\"E.164-Nummer\",jwt:\"JWT\",template_literal:\"Eingabe\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Ungültige Eingabe: erwartet ${t.expected}, erhalten ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Ungültige Eingabe: erwartet ${g(t.values[0])}`;return`Ungültige Option: erwartet eine von ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`Zu groß: erwartet, dass ${t.origin??\"Wert\"} ${n}${t.maximum.toString()} ${a.unit??\"Elemente\"} hat`;return`Zu groß: erwartet, dass ${t.origin??\"Wert\"} ${n}${t.maximum.toString()} ist`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`Zu klein: erwartet, dass ${t.origin} ${n}${t.minimum.toString()} ${a.unit} hat`;return`Zu klein: erwartet, dass ${t.origin} ${n}${t.minimum.toString()} ist`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Ungültiger String: muss mit \"${n.prefix}\" beginnen`;if(n.format===\"ends_with\")return`Ungültiger String: muss mit \"${n.suffix}\" enden`;if(n.format===\"includes\")return`Ungültiger String: muss \"${n.includes}\" enthalten`;if(n.format===\"regex\")return`Ungültiger String: muss dem Muster ${n.pattern} entsprechen`;return`Ungültig: ${o[n.format]??t.format}`}case\"not_multiple_of\":return`Ungültige Zahl: muss ein Vielfaches von ${t.divisor} sein`;case\"unrecognized_keys\":return`${t.keys.length>1?\"Unbekannte Schlüssel\":\"Unbekannter Schlüssel\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`Ungültiger Schlüssel in ${t.origin}`;case\"invalid_union\":return\"Ungültige Eingabe\";case\"invalid_element\":return`Ungültiger Wert in ${t.origin}`;default:return\"Ungültige Eingabe\"}}};function mo(){return{localeError:As()}}var Ls=(e)=>{let r=typeof e;switch(r){case\"number\":return Number.isNaN(e)?\"NaN\":\"number\";case\"object\":{if(Array.isArray(e))return\"array\";if(e===null)return\"null\";if(Object.getPrototypeOf(e)!==Object.prototype&&e.constructor)return e.constructor.name}}return r},Rs=()=>{let e={string:{unit:\"characters\",verb:\"to have\"},file:{unit:\"bytes\",verb:\"to have\"},array:{unit:\"items\",verb:\"to have\"},set:{unit:\"items\",verb:\"to have\"}};function r(o){return e[o]??null}let i={regex:\"input\",email:\"email address\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO datetime\",date:\"ISO date\",time:\"ISO time\",duration:\"ISO duration\",ipv4:\"IPv4 address\",ipv6:\"IPv6 address\",cidrv4:\"IPv4 range\",cidrv6:\"IPv6 range\",base64:\"base64-encoded string\",base64url:\"base64url-encoded string\",json_string:\"JSON string\",e164:\"E.164 number\",jwt:\"JWT\",template_literal:\"input\"};return(o)=>{switch(o.code){case\"invalid_type\":return`Invalid input: expected ${o.expected}, received ${Ls(o.input)}`;case\"invalid_value\":if(o.values.length===1)return`Invalid input: expected ${g(o.values[0])}`;return`Invalid option: expected one of ${l(o.values,\"|\")}`;case\"too_big\":{let t=o.inclusive?\"<=\":\"<\",n=r(o.origin);if(n)return`Too big: expected ${o.origin??\"value\"} to have ${t}${o.maximum.toString()} ${n.unit??\"elements\"}`;return`Too big: expected ${o.origin??\"value\"} to be ${t}${o.maximum.toString()}`}case\"too_small\":{let t=o.inclusive?\">=\":\">\",n=r(o.origin);if(n)return`Too small: expected ${o.origin} to have ${t}${o.minimum.toString()} ${n.unit}`;return`Too small: expected ${o.origin} to be ${t}${o.minimum.toString()}`}case\"invalid_format\":{let t=o;if(t.format===\"starts_with\")return`Invalid string: must start with \"${t.prefix}\"`;if(t.format===\"ends_with\")return`Invalid string: must end with \"${t.suffix}\"`;if(t.format===\"includes\")return`Invalid string: must include \"${t.includes}\"`;if(t.format===\"regex\")return`Invalid string: must match pattern ${t.pattern}`;return`Invalid ${i[t.format]??o.format}`}case\"not_multiple_of\":return`Invalid number: must be a multiple of ${o.divisor}`;case\"unrecognized_keys\":return`Unrecognized key${o.keys.length>1?\"s\":\"\"}: ${l(o.keys,\", \")}`;case\"invalid_key\":return`Invalid key in ${o.origin}`;case\"invalid_union\":return\"Invalid input\";case\"invalid_element\":return`Invalid value in ${o.origin}`;default:return\"Invalid input\"}}};function He(){return{localeError:Rs()}}var Cs=(e)=>{let r=typeof e;switch(r){case\"number\":return Number.isNaN(e)?\"NaN\":\"nombro\";case\"object\":{if(Array.isArray(e))return\"tabelo\";if(e===null)return\"senvalora\";if(Object.getPrototypeOf(e)!==Object.prototype&&e.constructor)return e.constructor.name}}return r},Vs=()=>{let e={string:{unit:\"karaktrojn\",verb:\"havi\"},file:{unit:\"bajtojn\",verb:\"havi\"},array:{unit:\"elementojn\",verb:\"havi\"},set:{unit:\"elementojn\",verb:\"havi\"}};function r(o){return e[o]??null}let i={regex:\"enigo\",email:\"retadreso\",url:\"URL\",emoji:\"emoĝio\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO-datotempo\",date:\"ISO-dato\",time:\"ISO-tempo\",duration:\"ISO-daŭro\",ipv4:\"IPv4-adreso\",ipv6:\"IPv6-adreso\",cidrv4:\"IPv4-rango\",cidrv6:\"IPv6-rango\",base64:\"64-ume kodita karaktraro\",base64url:\"URL-64-ume kodita karaktraro\",json_string:\"JSON-karaktraro\",e164:\"E.164-nombro\",jwt:\"JWT\",template_literal:\"enigo\"};return(o)=>{switch(o.code){case\"invalid_type\":return`Nevalida enigo: atendiĝis ${o.expected}, riceviĝis ${Cs(o.input)}`;case\"invalid_value\":if(o.values.length===1)return`Nevalida enigo: atendiĝis ${g(o.values[0])}`;return`Nevalida opcio: atendiĝis unu el ${l(o.values,\"|\")}`;case\"too_big\":{let t=o.inclusive?\"<=\":\"<\",n=r(o.origin);if(n)return`Tro granda: atendiĝis ke ${o.origin??\"valoro\"} havu ${t}${o.maximum.toString()} ${n.unit??\"elementojn\"}`;return`Tro granda: atendiĝis ke ${o.origin??\"valoro\"} havu ${t}${o.maximum.toString()}`}case\"too_small\":{let t=o.inclusive?\">=\":\">\",n=r(o.origin);if(n)return`Tro malgranda: atendiĝis ke ${o.origin} havu ${t}${o.minimum.toString()} ${n.unit}`;return`Tro malgranda: atendiĝis ke ${o.origin} estu ${t}${o.minimum.toString()}`}case\"invalid_format\":{let t=o;if(t.format===\"starts_with\")return`Nevalida karaktraro: devas komenciĝi per \"${t.prefix}\"`;if(t.format===\"ends_with\")return`Nevalida karaktraro: devas finiĝi per \"${t.suffix}\"`;if(t.format===\"includes\")return`Nevalida karaktraro: devas inkluzivi \"${t.includes}\"`;if(t.format===\"regex\")return`Nevalida karaktraro: devas kongrui kun la modelo ${t.pattern}`;return`Nevalida ${i[t.format]??o.format}`}case\"not_multiple_of\":return`Nevalida nombro: devas esti oblo de ${o.divisor}`;case\"unrecognized_keys\":return`Nekonata${o.keys.length>1?\"j\":\"\"} ŝlosilo${o.keys.length>1?\"j\":\"\"}: ${l(o.keys,\", \")}`;case\"invalid_key\":return`Nevalida ŝlosilo en ${o.origin}`;case\"invalid_union\":return\"Nevalida enigo\";case\"invalid_element\":return`Nevalida valoro en ${o.origin}`;default:return\"Nevalida enigo\"}}};function po(){return{localeError:Vs()}}var Fs=()=>{let e={string:{unit:\"caracteres\",verb:\"tener\"},file:{unit:\"bytes\",verb:\"tener\"},array:{unit:\"elementos\",verb:\"tener\"},set:{unit:\"elementos\",verb:\"tener\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"número\";case\"object\":{if(Array.isArray(t))return\"arreglo\";if(t===null)return\"nulo\";if(Object.getPrototypeOf(t)!==Object.prototype)return t.constructor.name}}return n},o={regex:\"entrada\",email:\"dirección de correo electrónico\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"fecha y hora ISO\",date:\"fecha ISO\",time:\"hora ISO\",duration:\"duración ISO\",ipv4:\"dirección IPv4\",ipv6:\"dirección IPv6\",cidrv4:\"rango IPv4\",cidrv6:\"rango IPv6\",base64:\"cadena codificada en base64\",base64url:\"URL codificada en base64\",json_string:\"cadena JSON\",e164:\"número E.164\",jwt:\"JWT\",template_literal:\"entrada\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Entrada inválida: se esperaba ${t.expected}, recibido ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Entrada inválida: se esperaba ${g(t.values[0])}`;return`Opción inválida: se esperaba una de ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`Demasiado grande: se esperaba que ${t.origin??\"valor\"} tuviera ${n}${t.maximum.toString()} ${a.unit??\"elementos\"}`;return`Demasiado grande: se esperaba que ${t.origin??\"valor\"} fuera ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`Demasiado pequeño: se esperaba que ${t.origin} tuviera ${n}${t.minimum.toString()} ${a.unit}`;return`Demasiado pequeño: se esperaba que ${t.origin} fuera ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Cadena inválida: debe comenzar con \"${n.prefix}\"`;if(n.format===\"ends_with\")return`Cadena inválida: debe terminar en \"${n.suffix}\"`;if(n.format===\"includes\")return`Cadena inválida: debe incluir \"${n.includes}\"`;if(n.format===\"regex\")return`Cadena inválida: debe coincidir con el patrón ${n.pattern}`;return`Inválido ${o[n.format]??t.format}`}case\"not_multiple_of\":return`Número inválido: debe ser múltiplo de ${t.divisor}`;case\"unrecognized_keys\":return`Llave${t.keys.length>1?\"s\":\"\"} desconocida${t.keys.length>1?\"s\":\"\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`Llave inválida en ${t.origin}`;case\"invalid_union\":return\"Entrada inválida\";case\"invalid_element\":return`Valor inválido en ${t.origin}`;default:return\"Entrada inválida\"}}};function fo(){return{localeError:Fs()}}var Js=()=>{let e={string:{unit:\"کاراکتر\",verb:\"داشته باشد\"},file:{unit:\"بایت\",verb:\"داشته باشد\"},array:{unit:\"آیتم\",verb:\"داشته باشد\"},set:{unit:\"آیتم\",verb:\"داشته باشد\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"عدد\";case\"object\":{if(Array.isArray(t))return\"آرایه\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"ورودی\",email:\"آدرس ایمیل\",url:\"URL\",emoji:\"ایموجی\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"تاریخ و زمان ایزو\",date:\"تاریخ ایزو\",time:\"زمان ایزو\",duration:\"مدت زمان ایزو\",ipv4:\"IPv4 آدرس\",ipv6:\"IPv6 آدرس\",cidrv4:\"IPv4 دامنه\",cidrv6:\"IPv6 دامنه\",base64:\"base64-encoded رشته\",base64url:\"base64url-encoded رشته\",json_string:\"JSON رشته\",e164:\"E.164 عدد\",jwt:\"JWT\",template_literal:\"ورودی\"};return(t)=>{switch(t.code){case\"invalid_type\":return`ورودی نامعتبر: می‌بایست ${t.expected} می‌بود، ${i(t.input)} دریافت شد`;case\"invalid_value\":if(t.values.length===1)return`ورودی نامعتبر: می‌بایست ${g(t.values[0])} می‌بود`;return`گزینه نامعتبر: می‌بایست یکی از ${l(t.values,\"|\")} می‌بود`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`خیلی بزرگ: ${t.origin??\"مقدار\"} باید ${n}${t.maximum.toString()} ${a.unit??\"عنصر\"} باشد`;return`خیلی بزرگ: ${t.origin??\"مقدار\"} باید ${n}${t.maximum.toString()} باشد`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`خیلی کوچک: ${t.origin} باید ${n}${t.minimum.toString()} ${a.unit} باشد`;return`خیلی کوچک: ${t.origin} باید ${n}${t.minimum.toString()} باشد`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`رشته نامعتبر: باید با \"${n.prefix}\" شروع شود`;if(n.format===\"ends_with\")return`رشته نامعتبر: باید با \"${n.suffix}\" تمام شود`;if(n.format===\"includes\")return`رشته نامعتبر: باید شامل \"${n.includes}\" باشد`;if(n.format===\"regex\")return`رشته نامعتبر: باید با الگوی ${n.pattern} مطابقت داشته باشد`;return`${o[n.format]??t.format} نامعتبر`}case\"not_multiple_of\":return`عدد نامعتبر: باید مضرب ${t.divisor} باشد`;case\"unrecognized_keys\":return`کلید${t.keys.length>1?\"های\":\"\"} ناشناس: ${l(t.keys,\", \")}`;case\"invalid_key\":return`کلید ناشناس در ${t.origin}`;case\"invalid_union\":return\"ورودی نامعتبر\";case\"invalid_element\":return`مقدار نامعتبر در ${t.origin}`;default:return\"ورودی نامعتبر\"}}};function vo(){return{localeError:Js()}}var Ms=()=>{let e={string:{unit:\"merkkiä\",subject:\"merkkijonon\"},file:{unit:\"tavua\",subject:\"tiedoston\"},array:{unit:\"alkiota\",subject:\"listan\"},set:{unit:\"alkiota\",subject:\"joukon\"},number:{unit:\"\",subject:\"luvun\"},bigint:{unit:\"\",subject:\"suuren kokonaisluvun\"},int:{unit:\"\",subject:\"kokonaisluvun\"},date:{unit:\"\",subject:\"päivämäärän\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"number\";case\"object\":{if(Array.isArray(t))return\"array\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"säännöllinen lauseke\",email:\"sähköpostiosoite\",url:\"URL-osoite\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO-aikaleima\",date:\"ISO-päivämäärä\",time:\"ISO-aika\",duration:\"ISO-kesto\",ipv4:\"IPv4-osoite\",ipv6:\"IPv6-osoite\",cidrv4:\"IPv4-alue\",cidrv6:\"IPv6-alue\",base64:\"base64-koodattu merkkijono\",base64url:\"base64url-koodattu merkkijono\",json_string:\"JSON-merkkijono\",e164:\"E.164-luku\",jwt:\"JWT\",template_literal:\"templaattimerkkijono\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Virheellinen tyyppi: odotettiin ${t.expected}, oli ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Virheellinen syöte: täytyy olla ${g(t.values[0])}`;return`Virheellinen valinta: täytyy olla yksi seuraavista: ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`Liian suuri: ${a.subject} täytyy olla ${n}${t.maximum.toString()} ${a.unit}`.trim();return`Liian suuri: arvon täytyy olla ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`Liian pieni: ${a.subject} täytyy olla ${n}${t.minimum.toString()} ${a.unit}`.trim();return`Liian pieni: arvon täytyy olla ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Virheellinen syöte: täytyy alkaa \"${n.prefix}\"`;if(n.format===\"ends_with\")return`Virheellinen syöte: täytyy loppua \"${n.suffix}\"`;if(n.format===\"includes\")return`Virheellinen syöte: täytyy sisältää \"${n.includes}\"`;if(n.format===\"regex\")return`Virheellinen syöte: täytyy vastata säännöllistä lauseketta ${n.pattern}`;return`Virheellinen ${o[n.format]??t.format}`}case\"not_multiple_of\":return`Virheellinen luku: täytyy olla luvun ${t.divisor} monikerta`;case\"unrecognized_keys\":return`${t.keys.length>1?\"Tuntemattomat avaimet\":\"Tuntematon avain\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return\"Virheellinen avain tietueessa\";case\"invalid_union\":return\"Virheellinen unioni\";case\"invalid_element\":return\"Virheellinen arvo joukossa\";default:return\"Virheellinen syöte\"}}};function go(){return{localeError:Ms()}}var Ws=()=>{let e={string:{unit:\"caractères\",verb:\"avoir\"},file:{unit:\"octets\",verb:\"avoir\"},array:{unit:\"éléments\",verb:\"avoir\"},set:{unit:\"éléments\",verb:\"avoir\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"nombre\";case\"object\":{if(Array.isArray(t))return\"tableau\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"entrée\",email:\"adresse e-mail\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"date et heure ISO\",date:\"date ISO\",time:\"heure ISO\",duration:\"durée ISO\",ipv4:\"adresse IPv4\",ipv6:\"adresse IPv6\",cidrv4:\"plage IPv4\",cidrv6:\"plage IPv6\",base64:\"chaîne encodée en base64\",base64url:\"chaîne encodée en base64url\",json_string:\"chaîne JSON\",e164:\"numéro E.164\",jwt:\"JWT\",template_literal:\"entrée\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Entrée invalide : ${t.expected} attendu, ${i(t.input)} reçu`;case\"invalid_value\":if(t.values.length===1)return`Entrée invalide : ${g(t.values[0])} attendu`;return`Option invalide : une valeur parmi ${l(t.values,\"|\")} attendue`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`Trop grand : ${t.origin??\"valeur\"} doit ${a.verb} ${n}${t.maximum.toString()} ${a.unit??\"élément(s)\"}`;return`Trop grand : ${t.origin??\"valeur\"} doit être ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`Trop petit : ${t.origin} doit ${a.verb} ${n}${t.minimum.toString()} ${a.unit}`;return`Trop petit : ${t.origin} doit être ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Chaîne invalide : doit commencer par \"${n.prefix}\"`;if(n.format===\"ends_with\")return`Chaîne invalide : doit se terminer par \"${n.suffix}\"`;if(n.format===\"includes\")return`Chaîne invalide : doit inclure \"${n.includes}\"`;if(n.format===\"regex\")return`Chaîne invalide : doit correspondre au modèle ${n.pattern}`;return`${o[n.format]??t.format} invalide`}case\"not_multiple_of\":return`Nombre invalide : doit être un multiple de ${t.divisor}`;case\"unrecognized_keys\":return`Clé${t.keys.length>1?\"s\":\"\"} non reconnue${t.keys.length>1?\"s\":\"\"} : ${l(t.keys,\", \")}`;case\"invalid_key\":return`Clé invalide dans ${t.origin}`;case\"invalid_union\":return\"Entrée invalide\";case\"invalid_element\":return`Valeur invalide dans ${t.origin}`;default:return\"Entrée invalide\"}}};function ho(){return{localeError:Ws()}}var Gs=()=>{let e={string:{unit:\"caractères\",verb:\"avoir\"},file:{unit:\"octets\",verb:\"avoir\"},array:{unit:\"éléments\",verb:\"avoir\"},set:{unit:\"éléments\",verb:\"avoir\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"number\";case\"object\":{if(Array.isArray(t))return\"array\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"entrée\",email:\"adresse courriel\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"date-heure ISO\",date:\"date ISO\",time:\"heure ISO\",duration:\"durée ISO\",ipv4:\"adresse IPv4\",ipv6:\"adresse IPv6\",cidrv4:\"plage IPv4\",cidrv6:\"plage IPv6\",base64:\"chaîne encodée en base64\",base64url:\"chaîne encodée en base64url\",json_string:\"chaîne JSON\",e164:\"numéro E.164\",jwt:\"JWT\",template_literal:\"entrée\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Entrée invalide : attendu ${t.expected}, reçu ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Entrée invalide : attendu ${g(t.values[0])}`;return`Option invalide : attendu l'une des valeurs suivantes ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"≤\":\"<\",a=r(t.origin);if(a)return`Trop grand : attendu que ${t.origin??\"la valeur\"} ait ${n}${t.maximum.toString()} ${a.unit}`;return`Trop grand : attendu que ${t.origin??\"la valeur\"} soit ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\"≥\":\">\",a=r(t.origin);if(a)return`Trop petit : attendu que ${t.origin} ait ${n}${t.minimum.toString()} ${a.unit}`;return`Trop petit : attendu que ${t.origin} soit ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Chaîne invalide : doit commencer par \"${n.prefix}\"`;if(n.format===\"ends_with\")return`Chaîne invalide : doit se terminer par \"${n.suffix}\"`;if(n.format===\"includes\")return`Chaîne invalide : doit inclure \"${n.includes}\"`;if(n.format===\"regex\")return`Chaîne invalide : doit correspondre au motif ${n.pattern}`;return`${o[n.format]??t.format} invalide`}case\"not_multiple_of\":return`Nombre invalide : doit être un multiple de ${t.divisor}`;case\"unrecognized_keys\":return`Clé${t.keys.length>1?\"s\":\"\"} non reconnue${t.keys.length>1?\"s\":\"\"} : ${l(t.keys,\", \")}`;case\"invalid_key\":return`Clé invalide dans ${t.origin}`;case\"invalid_union\":return\"Entrée invalide\";case\"invalid_element\":return`Valeur invalide dans ${t.origin}`;default:return\"Entrée invalide\"}}};function $o(){return{localeError:Gs()}}var Bs=()=>{let e={string:{unit:\"אותיות\",verb:\"לכלול\"},file:{unit:\"בייטים\",verb:\"לכלול\"},array:{unit:\"פריטים\",verb:\"לכלול\"},set:{unit:\"פריטים\",verb:\"לכלול\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"number\";case\"object\":{if(Array.isArray(t))return\"array\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"קלט\",email:\"כתובת אימייל\",url:\"כתובת רשת\",emoji:\"אימוג'י\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"תאריך וזמן ISO\",date:\"תאריך ISO\",time:\"זמן ISO\",duration:\"משך זמן ISO\",ipv4:\"כתובת IPv4\",ipv6:\"כתובת IPv6\",cidrv4:\"טווח IPv4\",cidrv6:\"טווח IPv6\",base64:\"מחרוזת בבסיס 64\",base64url:\"מחרוזת בבסיס 64 לכתובות רשת\",json_string:\"מחרוזת JSON\",e164:\"מספר E.164\",jwt:\"JWT\",template_literal:\"קלט\"};return(t)=>{switch(t.code){case\"invalid_type\":return`קלט לא תקין: צריך ${t.expected}, התקבל ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`קלט לא תקין: צריך ${g(t.values[0])}`;return`קלט לא תקין: צריך אחת מהאפשרויות  ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`גדול מדי: ${t.origin??\"value\"} צריך להיות ${n}${t.maximum.toString()} ${a.unit??\"elements\"}`;return`גדול מדי: ${t.origin??\"value\"} צריך להיות ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`קטן מדי: ${t.origin} צריך להיות ${n}${t.minimum.toString()} ${a.unit}`;return`קטן מדי: ${t.origin} צריך להיות ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`מחרוזת לא תקינה: חייבת להתחיל ב\"${n.prefix}\"`;if(n.format===\"ends_with\")return`מחרוזת לא תקינה: חייבת להסתיים ב \"${n.suffix}\"`;if(n.format===\"includes\")return`מחרוזת לא תקינה: חייבת לכלול \"${n.includes}\"`;if(n.format===\"regex\")return`מחרוזת לא תקינה: חייבת להתאים לתבנית ${n.pattern}`;return`${o[n.format]??t.format} לא תקין`}case\"not_multiple_of\":return`מספר לא תקין: חייב להיות מכפלה של ${t.divisor}`;case\"unrecognized_keys\":return`מפתח${t.keys.length>1?\"ות\":\"\"} לא מזוה${t.keys.length>1?\"ים\":\"ה\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`מפתח לא תקין ב${t.origin}`;case\"invalid_union\":return\"קלט לא תקין\";case\"invalid_element\":return`ערך לא תקין ב${t.origin}`;default:return\"קלט לא תקין\"}}};function _o(){return{localeError:Bs()}}var Ks=()=>{let e={string:{unit:\"karakter\",verb:\"legyen\"},file:{unit:\"byte\",verb:\"legyen\"},array:{unit:\"elem\",verb:\"legyen\"},set:{unit:\"elem\",verb:\"legyen\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"szám\";case\"object\":{if(Array.isArray(t))return\"tömb\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"bemenet\",email:\"email cím\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO időbélyeg\",date:\"ISO dátum\",time:\"ISO idő\",duration:\"ISO időintervallum\",ipv4:\"IPv4 cím\",ipv6:\"IPv6 cím\",cidrv4:\"IPv4 tartomány\",cidrv6:\"IPv6 tartomány\",base64:\"base64-kódolt string\",base64url:\"base64url-kódolt string\",json_string:\"JSON string\",e164:\"E.164 szám\",jwt:\"JWT\",template_literal:\"bemenet\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Érvénytelen bemenet: a várt érték ${t.expected}, a kapott érték ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Érvénytelen bemenet: a várt érték ${g(t.values[0])}`;return`Érvénytelen opció: valamelyik érték várt ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`Túl nagy: ${t.origin??\"érték\"} mérete túl nagy ${n}${t.maximum.toString()} ${a.unit??\"elem\"}`;return`Túl nagy: a bemeneti érték ${t.origin??\"érték\"} túl nagy: ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`Túl kicsi: a bemeneti érték ${t.origin} mérete túl kicsi ${n}${t.minimum.toString()} ${a.unit}`;return`Túl kicsi: a bemeneti érték ${t.origin} túl kicsi ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Érvénytelen string: \"${n.prefix}\" értékkel kell kezdődnie`;if(n.format===\"ends_with\")return`Érvénytelen string: \"${n.suffix}\" értékkel kell végződnie`;if(n.format===\"includes\")return`Érvénytelen string: \"${n.includes}\" értéket kell tartalmaznia`;if(n.format===\"regex\")return`Érvénytelen string: ${n.pattern} mintának kell megfelelnie`;return`Érvénytelen ${o[n.format]??t.format}`}case\"not_multiple_of\":return`Érvénytelen szám: ${t.divisor} többszörösének kell lennie`;case\"unrecognized_keys\":return`Ismeretlen kulcs${t.keys.length>1?\"s\":\"\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`Érvénytelen kulcs ${t.origin}`;case\"invalid_union\":return\"Érvénytelen bemenet\";case\"invalid_element\":return`Érvénytelen érték: ${t.origin}`;default:return\"Érvénytelen bemenet\"}}};function bo(){return{localeError:Ks()}}var Xs=()=>{let e={string:{unit:\"karakter\",verb:\"memiliki\"},file:{unit:\"byte\",verb:\"memiliki\"},array:{unit:\"item\",verb:\"memiliki\"},set:{unit:\"item\",verb:\"memiliki\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"number\";case\"object\":{if(Array.isArray(t))return\"array\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"input\",email:\"alamat email\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"tanggal dan waktu format ISO\",date:\"tanggal format ISO\",time:\"jam format ISO\",duration:\"durasi format ISO\",ipv4:\"alamat IPv4\",ipv6:\"alamat IPv6\",cidrv4:\"rentang alamat IPv4\",cidrv6:\"rentang alamat IPv6\",base64:\"string dengan enkode base64\",base64url:\"string dengan enkode base64url\",json_string:\"string JSON\",e164:\"angka E.164\",jwt:\"JWT\",template_literal:\"input\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Input tidak valid: diharapkan ${t.expected}, diterima ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Input tidak valid: diharapkan ${g(t.values[0])}`;return`Pilihan tidak valid: diharapkan salah satu dari ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`Terlalu besar: diharapkan ${t.origin??\"value\"} memiliki ${n}${t.maximum.toString()} ${a.unit??\"elemen\"}`;return`Terlalu besar: diharapkan ${t.origin??\"value\"} menjadi ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`Terlalu kecil: diharapkan ${t.origin} memiliki ${n}${t.minimum.toString()} ${a.unit}`;return`Terlalu kecil: diharapkan ${t.origin} menjadi ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`String tidak valid: harus dimulai dengan \"${n.prefix}\"`;if(n.format===\"ends_with\")return`String tidak valid: harus berakhir dengan \"${n.suffix}\"`;if(n.format===\"includes\")return`String tidak valid: harus menyertakan \"${n.includes}\"`;if(n.format===\"regex\")return`String tidak valid: harus sesuai pola ${n.pattern}`;return`${o[n.format]??t.format} tidak valid`}case\"not_multiple_of\":return`Angka tidak valid: harus kelipatan dari ${t.divisor}`;case\"unrecognized_keys\":return`Kunci tidak dikenali ${t.keys.length>1?\"s\":\"\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`Kunci tidak valid di ${t.origin}`;case\"invalid_union\":return\"Input tidak valid\";case\"invalid_element\":return`Nilai tidak valid di ${t.origin}`;default:return\"Input tidak valid\"}}};function yo(){return{localeError:Xs()}}var qs=()=>{let e={string:{unit:\"caratteri\",verb:\"avere\"},file:{unit:\"byte\",verb:\"avere\"},array:{unit:\"elementi\",verb:\"avere\"},set:{unit:\"elementi\",verb:\"avere\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"numero\";case\"object\":{if(Array.isArray(t))return\"vettore\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"input\",email:\"indirizzo email\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"data e ora ISO\",date:\"data ISO\",time:\"ora ISO\",duration:\"durata ISO\",ipv4:\"indirizzo IPv4\",ipv6:\"indirizzo IPv6\",cidrv4:\"intervallo IPv4\",cidrv6:\"intervallo IPv6\",base64:\"stringa codificata in base64\",base64url:\"URL codificata in base64\",json_string:\"stringa JSON\",e164:\"numero E.164\",jwt:\"JWT\",template_literal:\"input\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Input non valido: atteso ${t.expected}, ricevuto ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Input non valido: atteso ${g(t.values[0])}`;return`Opzione non valida: atteso uno tra ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`Troppo grande: ${t.origin??\"valore\"} deve avere ${n}${t.maximum.toString()} ${a.unit??\"elementi\"}`;return`Troppo grande: ${t.origin??\"valore\"} deve essere ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`Troppo piccolo: ${t.origin} deve avere ${n}${t.minimum.toString()} ${a.unit}`;return`Troppo piccolo: ${t.origin} deve essere ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Stringa non valida: deve iniziare con \"${n.prefix}\"`;if(n.format===\"ends_with\")return`Stringa non valida: deve terminare con \"${n.suffix}\"`;if(n.format===\"includes\")return`Stringa non valida: deve includere \"${n.includes}\"`;if(n.format===\"regex\")return`Stringa non valida: deve corrispondere al pattern ${n.pattern}`;return`Invalid ${o[n.format]??t.format}`}case\"not_multiple_of\":return`Numero non valido: deve essere un multiplo di ${t.divisor}`;case\"unrecognized_keys\":return`Chiav${t.keys.length>1?\"i\":\"e\"} non riconosciut${t.keys.length>1?\"e\":\"a\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`Chiave non valida in ${t.origin}`;case\"invalid_union\":return\"Input non valido\";case\"invalid_element\":return`Valore non valido in ${t.origin}`;default:return\"Input non valido\"}}};function xo(){return{localeError:qs()}}var Ys=()=>{let e={string:{unit:\"文字\",verb:\"である\"},file:{unit:\"バイト\",verb:\"である\"},array:{unit:\"要素\",verb:\"である\"},set:{unit:\"要素\",verb:\"である\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"数値\";case\"object\":{if(Array.isArray(t))return\"配列\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"入力値\",email:\"メールアドレス\",url:\"URL\",emoji:\"絵文字\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO日時\",date:\"ISO日付\",time:\"ISO時刻\",duration:\"ISO期間\",ipv4:\"IPv4アドレス\",ipv6:\"IPv6アドレス\",cidrv4:\"IPv4範囲\",cidrv6:\"IPv6範囲\",base64:\"base64エンコード文字列\",base64url:\"base64urlエンコード文字列\",json_string:\"JSON文字列\",e164:\"E.164番号\",jwt:\"JWT\",template_literal:\"入力値\"};return(t)=>{switch(t.code){case\"invalid_type\":return`無効な入力: ${t.expected}が期待されましたが、${i(t.input)}が入力されました`;case\"invalid_value\":if(t.values.length===1)return`無効な入力: ${g(t.values[0])}が期待されました`;return`無効な選択: ${l(t.values,\"、\")}のいずれかである必要があります`;case\"too_big\":{let n=t.inclusive?\"以下である\":\"より小さい\",a=r(t.origin);if(a)return`大きすぎる値: ${t.origin??\"値\"}は${t.maximum.toString()}${a.unit??\"要素\"}${n}必要があります`;return`大きすぎる値: ${t.origin??\"値\"}は${t.maximum.toString()}${n}必要があります`}case\"too_small\":{let n=t.inclusive?\"以上である\":\"より大きい\",a=r(t.origin);if(a)return`小さすぎる値: ${t.origin}は${t.minimum.toString()}${a.unit}${n}必要があります`;return`小さすぎる値: ${t.origin}は${t.minimum.toString()}${n}必要があります`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`無効な文字列: \"${n.prefix}\"で始まる必要があります`;if(n.format===\"ends_with\")return`無効な文字列: \"${n.suffix}\"で終わる必要があります`;if(n.format===\"includes\")return`無効な文字列: \"${n.includes}\"を含む必要があります`;if(n.format===\"regex\")return`無効な文字列: パターン${n.pattern}に一致する必要があります`;return`無効な${o[n.format]??t.format}`}case\"not_multiple_of\":return`無効な数値: ${t.divisor}の倍数である必要があります`;case\"unrecognized_keys\":return`認識されていないキー${t.keys.length>1?\"群\":\"\"}: ${l(t.keys,\"、\")}`;case\"invalid_key\":return`${t.origin}内の無効なキー`;case\"invalid_union\":return\"無効な入力\";case\"invalid_element\":return`${t.origin}内の無効な値`;default:return\"無効な入力\"}}};function ko(){return{localeError:Ys()}}var Hs=()=>{let e={string:{unit:\"តួអក្សរ\",verb:\"គួរមាន\"},file:{unit:\"បៃ\",verb:\"គួរមាន\"},array:{unit:\"ធាតុ\",verb:\"គួរមាន\"},set:{unit:\"ធាតុ\",verb:\"គួរមាន\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"មិនមែនជាលេខ (NaN)\":\"លេខ\";case\"object\":{if(Array.isArray(t))return\"អារេ (Array)\";if(t===null)return\"គ្មានតម្លៃ (null)\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"ទិន្នន័យបញ្ចូល\",email:\"អាសយដ្ឋានអ៊ីមែល\",url:\"URL\",emoji:\"សញ្ញាអារម្មណ៍\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"កាលបរិច្ឆេទ និងម៉ោង ISO\",date:\"កាលបរិច្ឆេទ ISO\",time:\"ម៉ោង ISO\",duration:\"រយៈពេល ISO\",ipv4:\"អាសយដ្ឋាន IPv4\",ipv6:\"អាសយដ្ឋាន IPv6\",cidrv4:\"ដែនអាសយដ្ឋាន IPv4\",cidrv6:\"ដែនអាសយដ្ឋាន IPv6\",base64:\"ខ្សែអក្សរអ៊ិកូដ base64\",base64url:\"ខ្សែអក្សរអ៊ិកូដ base64url\",json_string:\"ខ្សែអក្សរ JSON\",e164:\"លេខ E.164\",jwt:\"JWT\",template_literal:\"ទិន្នន័យបញ្ចូល\"};return(t)=>{switch(t.code){case\"invalid_type\":return`ទិន្នន័យបញ្ចូលមិនត្រឹមត្រូវ៖ ត្រូវការ ${t.expected} ប៉ុន្តែទទួលបាន ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`ទិន្នន័យបញ្ចូលមិនត្រឹមត្រូវ៖ ត្រូវការ ${g(t.values[0])}`;return`ជម្រើសមិនត្រឹមត្រូវ៖ ត្រូវជាមួយក្នុងចំណោម ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`ធំពេក៖ ត្រូវការ ${t.origin??\"តម្លៃ\"} ${n} ${t.maximum.toString()} ${a.unit??\"ធាតុ\"}`;return`ធំពេក៖ ត្រូវការ ${t.origin??\"តម្លៃ\"} ${n} ${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`តូចពេក៖ ត្រូវការ ${t.origin} ${n} ${t.minimum.toString()} ${a.unit}`;return`តូចពេក៖ ត្រូវការ ${t.origin} ${n} ${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវចាប់ផ្តើមដោយ \"${n.prefix}\"`;if(n.format===\"ends_with\")return`ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវបញ្ចប់ដោយ \"${n.suffix}\"`;if(n.format===\"includes\")return`ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវមាន \"${n.includes}\"`;if(n.format===\"regex\")return`ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវតែផ្គូផ្គងនឹងទម្រង់ដែលបានកំណត់ ${n.pattern}`;return`មិនត្រឹមត្រូវ៖ ${o[n.format]??t.format}`}case\"not_multiple_of\":return`លេខមិនត្រឹមត្រូវ៖ ត្រូវតែជាពហុគុណនៃ ${t.divisor}`;case\"unrecognized_keys\":return`រកឃើញសោមិនស្គាល់៖ ${l(t.keys,\", \")}`;case\"invalid_key\":return`សោមិនត្រឹមត្រូវនៅក្នុង ${t.origin}`;case\"invalid_union\":return\"ទិន្នន័យមិនត្រឹមត្រូវ\";case\"invalid_element\":return`ទិន្នន័យមិនត្រឹមត្រូវនៅក្នុង ${t.origin}`;default:return\"ទិន្នន័យមិនត្រឹមត្រូវ\"}}};function zo(){return{localeError:Hs()}}var Qs=()=>{let e={string:{unit:\"문자\",verb:\"to have\"},file:{unit:\"바이트\",verb:\"to have\"},array:{unit:\"개\",verb:\"to have\"},set:{unit:\"개\",verb:\"to have\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"number\";case\"object\":{if(Array.isArray(t))return\"array\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"입력\",email:\"이메일 주소\",url:\"URL\",emoji:\"이모지\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO 날짜시간\",date:\"ISO 날짜\",time:\"ISO 시간\",duration:\"ISO 기간\",ipv4:\"IPv4 주소\",ipv6:\"IPv6 주소\",cidrv4:\"IPv4 범위\",cidrv6:\"IPv6 범위\",base64:\"base64 인코딩 문자열\",base64url:\"base64url 인코딩 문자열\",json_string:\"JSON 문자열\",e164:\"E.164 번호\",jwt:\"JWT\",template_literal:\"입력\"};return(t)=>{switch(t.code){case\"invalid_type\":return`잘못된 입력: 예상 타입은 ${t.expected}, 받은 타입은 ${i(t.input)}입니다`;case\"invalid_value\":if(t.values.length===1)return`잘못된 입력: 값은 ${g(t.values[0])} 이어야 합니다`;return`잘못된 옵션: ${l(t.values,\"또는 \")} 중 하나여야 합니다`;case\"too_big\":{let n=t.inclusive?\"이하\":\"미만\",a=n===\"미만\"?\"이어야 합니다\":\"여야 합니다\",c=r(t.origin),p=c?.unit??\"요소\";if(c)return`${t.origin??\"값\"}이 너무 큽니다: ${t.maximum.toString()}${p} ${n}${a}`;return`${t.origin??\"값\"}이 너무 큽니다: ${t.maximum.toString()} ${n}${a}`}case\"too_small\":{let n=t.inclusive?\"이상\":\"초과\",a=n===\"이상\"?\"이어야 합니다\":\"여야 합니다\",c=r(t.origin),p=c?.unit??\"요소\";if(c)return`${t.origin??\"값\"}이 너무 작습니다: ${t.minimum.toString()}${p} ${n}${a}`;return`${t.origin??\"값\"}이 너무 작습니다: ${t.minimum.toString()} ${n}${a}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`잘못된 문자열: \"${n.prefix}\"(으)로 시작해야 합니다`;if(n.format===\"ends_with\")return`잘못된 문자열: \"${n.suffix}\"(으)로 끝나야 합니다`;if(n.format===\"includes\")return`잘못된 문자열: \"${n.includes}\"을(를) 포함해야 합니다`;if(n.format===\"regex\")return`잘못된 문자열: 정규식 ${n.pattern} 패턴과 일치해야 합니다`;return`잘못된 ${o[n.format]??t.format}`}case\"not_multiple_of\":return`잘못된 숫자: ${t.divisor}의 배수여야 합니다`;case\"unrecognized_keys\":return`인식할 수 없는 키: ${l(t.keys,\", \")}`;case\"invalid_key\":return`잘못된 키: ${t.origin}`;case\"invalid_union\":return\"잘못된 입력\";case\"invalid_element\":return`잘못된 값: ${t.origin}`;default:return\"잘못된 입력\"}}};function Io(){return{localeError:Qs()}}var el=()=>{let e={string:{unit:\"знаци\",verb:\"да имаат\"},file:{unit:\"бајти\",verb:\"да имаат\"},array:{unit:\"ставки\",verb:\"да имаат\"},set:{unit:\"ставки\",verb:\"да имаат\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"број\";case\"object\":{if(Array.isArray(t))return\"низа\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"внес\",email:\"адреса на е-пошта\",url:\"URL\",emoji:\"емоџи\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO датум и време\",date:\"ISO датум\",time:\"ISO време\",duration:\"ISO времетраење\",ipv4:\"IPv4 адреса\",ipv6:\"IPv6 адреса\",cidrv4:\"IPv4 опсег\",cidrv6:\"IPv6 опсег\",base64:\"base64-енкодирана низа\",base64url:\"base64url-енкодирана низа\",json_string:\"JSON низа\",e164:\"E.164 број\",jwt:\"JWT\",template_literal:\"внес\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Грешен внес: се очекува ${t.expected}, примено ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Invalid input: expected ${g(t.values[0])}`;return`Грешана опција: се очекува една ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`Премногу голем: се очекува ${t.origin??\"вредноста\"} да има ${n}${t.maximum.toString()} ${a.unit??\"елементи\"}`;return`Премногу голем: се очекува ${t.origin??\"вредноста\"} да биде ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`Премногу мал: се очекува ${t.origin} да има ${n}${t.minimum.toString()} ${a.unit}`;return`Премногу мал: се очекува ${t.origin} да биде ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Неважечка низа: мора да започнува со \"${n.prefix}\"`;if(n.format===\"ends_with\")return`Неважечка низа: мора да завршува со \"${n.suffix}\"`;if(n.format===\"includes\")return`Неважечка низа: мора да вклучува \"${n.includes}\"`;if(n.format===\"regex\")return`Неважечка низа: мора да одгоара на патернот ${n.pattern}`;return`Invalid ${o[n.format]??t.format}`}case\"not_multiple_of\":return`Грешен број: мора да биде делив со ${t.divisor}`;case\"unrecognized_keys\":return`${t.keys.length>1?\"Непрепознаени клучеви\":\"Непрепознаен клуч\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`Грешен клуч во ${t.origin}`;case\"invalid_union\":return\"Грешен внес\";case\"invalid_element\":return`Грешна вредност во ${t.origin}`;default:return\"Грешен внес\"}}};function wo(){return{localeError:el()}}var tl=()=>{let e={string:{unit:\"aksara\",verb:\"mempunyai\"},file:{unit:\"bait\",verb:\"mempunyai\"},array:{unit:\"elemen\",verb:\"mempunyai\"},set:{unit:\"elemen\",verb:\"mempunyai\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"nombor\";case\"object\":{if(Array.isArray(t))return\"array\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"input\",email:\"alamat e-mel\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"tarikh masa ISO\",date:\"tarikh ISO\",time:\"masa ISO\",duration:\"tempoh ISO\",ipv4:\"alamat IPv4\",ipv6:\"alamat IPv6\",cidrv4:\"julat IPv4\",cidrv6:\"julat IPv6\",base64:\"string dikodkan base64\",base64url:\"string dikodkan base64url\",json_string:\"string JSON\",e164:\"nombor E.164\",jwt:\"JWT\",template_literal:\"input\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Input tidak sah: dijangka ${t.expected}, diterima ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Input tidak sah: dijangka ${g(t.values[0])}`;return`Pilihan tidak sah: dijangka salah satu daripada ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`Terlalu besar: dijangka ${t.origin??\"nilai\"} ${a.verb} ${n}${t.maximum.toString()} ${a.unit??\"elemen\"}`;return`Terlalu besar: dijangka ${t.origin??\"nilai\"} adalah ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`Terlalu kecil: dijangka ${t.origin} ${a.verb} ${n}${t.minimum.toString()} ${a.unit}`;return`Terlalu kecil: dijangka ${t.origin} adalah ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`String tidak sah: mesti bermula dengan \"${n.prefix}\"`;if(n.format===\"ends_with\")return`String tidak sah: mesti berakhir dengan \"${n.suffix}\"`;if(n.format===\"includes\")return`String tidak sah: mesti mengandungi \"${n.includes}\"`;if(n.format===\"regex\")return`String tidak sah: mesti sepadan dengan corak ${n.pattern}`;return`${o[n.format]??t.format} tidak sah`}case\"not_multiple_of\":return`Nombor tidak sah: perlu gandaan ${t.divisor}`;case\"unrecognized_keys\":return`Kunci tidak dikenali: ${l(t.keys,\", \")}`;case\"invalid_key\":return`Kunci tidak sah dalam ${t.origin}`;case\"invalid_union\":return\"Input tidak sah\";case\"invalid_element\":return`Nilai tidak sah dalam ${t.origin}`;default:return\"Input tidak sah\"}}};function So(){return{localeError:tl()}}var rl=()=>{let e={string:{unit:\"tekens\"},file:{unit:\"bytes\"},array:{unit:\"elementen\"},set:{unit:\"elementen\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"getal\";case\"object\":{if(Array.isArray(t))return\"array\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"invoer\",email:\"emailadres\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO datum en tijd\",date:\"ISO datum\",time:\"ISO tijd\",duration:\"ISO duur\",ipv4:\"IPv4-adres\",ipv6:\"IPv6-adres\",cidrv4:\"IPv4-bereik\",cidrv6:\"IPv6-bereik\",base64:\"base64-gecodeerde tekst\",base64url:\"base64 URL-gecodeerde tekst\",json_string:\"JSON string\",e164:\"E.164-nummer\",jwt:\"JWT\",template_literal:\"invoer\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Ongeldige invoer: verwacht ${t.expected}, ontving ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Ongeldige invoer: verwacht ${g(t.values[0])}`;return`Ongeldige optie: verwacht één van ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`Te lang: verwacht dat ${t.origin??\"waarde\"} ${n}${t.maximum.toString()} ${a.unit??\"elementen\"} bevat`;return`Te lang: verwacht dat ${t.origin??\"waarde\"} ${n}${t.maximum.toString()} is`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`Te kort: verwacht dat ${t.origin} ${n}${t.minimum.toString()} ${a.unit} bevat`;return`Te kort: verwacht dat ${t.origin} ${n}${t.minimum.toString()} is`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Ongeldige tekst: moet met \"${n.prefix}\" beginnen`;if(n.format===\"ends_with\")return`Ongeldige tekst: moet op \"${n.suffix}\" eindigen`;if(n.format===\"includes\")return`Ongeldige tekst: moet \"${n.includes}\" bevatten`;if(n.format===\"regex\")return`Ongeldige tekst: moet overeenkomen met patroon ${n.pattern}`;return`Ongeldig: ${o[n.format]??t.format}`}case\"not_multiple_of\":return`Ongeldig getal: moet een veelvoud van ${t.divisor} zijn`;case\"unrecognized_keys\":return`Onbekende key${t.keys.length>1?\"s\":\"\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`Ongeldige key in ${t.origin}`;case\"invalid_union\":return\"Ongeldige invoer\";case\"invalid_element\":return`Ongeldige waarde in ${t.origin}`;default:return\"Ongeldige invoer\"}}};function jo(){return{localeError:rl()}}var nl=()=>{let e={string:{unit:\"tegn\",verb:\"å ha\"},file:{unit:\"bytes\",verb:\"å ha\"},array:{unit:\"elementer\",verb:\"å inneholde\"},set:{unit:\"elementer\",verb:\"å inneholde\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"tall\";case\"object\":{if(Array.isArray(t))return\"liste\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"input\",email:\"e-postadresse\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO dato- og klokkeslett\",date:\"ISO-dato\",time:\"ISO-klokkeslett\",duration:\"ISO-varighet\",ipv4:\"IPv4-område\",ipv6:\"IPv6-område\",cidrv4:\"IPv4-spekter\",cidrv6:\"IPv6-spekter\",base64:\"base64-enkodet streng\",base64url:\"base64url-enkodet streng\",json_string:\"JSON-streng\",e164:\"E.164-nummer\",jwt:\"JWT\",template_literal:\"input\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Ugyldig input: forventet ${t.expected}, fikk ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Ugyldig verdi: forventet ${g(t.values[0])}`;return`Ugyldig valg: forventet en av ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`For stor(t): forventet ${t.origin??\"value\"} til å ha ${n}${t.maximum.toString()} ${a.unit??\"elementer\"}`;return`For stor(t): forventet ${t.origin??\"value\"} til å ha ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`For lite(n): forventet ${t.origin} til å ha ${n}${t.minimum.toString()} ${a.unit}`;return`For lite(n): forventet ${t.origin} til å ha ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Ugyldig streng: må starte med \"${n.prefix}\"`;if(n.format===\"ends_with\")return`Ugyldig streng: må ende med \"${n.suffix}\"`;if(n.format===\"includes\")return`Ugyldig streng: må inneholde \"${n.includes}\"`;if(n.format===\"regex\")return`Ugyldig streng: må matche mønsteret ${n.pattern}`;return`Ugyldig ${o[n.format]??t.format}`}case\"not_multiple_of\":return`Ugyldig tall: må være et multiplum av ${t.divisor}`;case\"unrecognized_keys\":return`${t.keys.length>1?\"Ukjente nøkler\":\"Ukjent nøkkel\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`Ugyldig nøkkel i ${t.origin}`;case\"invalid_union\":return\"Ugyldig input\";case\"invalid_element\":return`Ugyldig verdi i ${t.origin}`;default:return\"Ugyldig input\"}}};function Oo(){return{localeError:nl()}}var il=()=>{let e={string:{unit:\"harf\",verb:\"olmalıdır\"},file:{unit:\"bayt\",verb:\"olmalıdır\"},array:{unit:\"unsur\",verb:\"olmalıdır\"},set:{unit:\"unsur\",verb:\"olmalıdır\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"numara\";case\"object\":{if(Array.isArray(t))return\"saf\";if(t===null)return\"gayb\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"giren\",email:\"epostagâh\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO hengâmı\",date:\"ISO tarihi\",time:\"ISO zamanı\",duration:\"ISO müddeti\",ipv4:\"IPv4 nişânı\",ipv6:\"IPv6 nişânı\",cidrv4:\"IPv4 menzili\",cidrv6:\"IPv6 menzili\",base64:\"base64-şifreli metin\",base64url:\"base64url-şifreli metin\",json_string:\"JSON metin\",e164:\"E.164 sayısı\",jwt:\"JWT\",template_literal:\"giren\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Fâsit giren: umulan ${t.expected}, alınan ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Fâsit giren: umulan ${g(t.values[0])}`;return`Fâsit tercih: mûteberler ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`Fazla büyük: ${t.origin??\"value\"}, ${n}${t.maximum.toString()} ${a.unit??\"elements\"} sahip olmalıydı.`;return`Fazla büyük: ${t.origin??\"value\"}, ${n}${t.maximum.toString()} olmalıydı.`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`Fazla küçük: ${t.origin}, ${n}${t.minimum.toString()} ${a.unit} sahip olmalıydı.`;return`Fazla küçük: ${t.origin}, ${n}${t.minimum.toString()} olmalıydı.`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Fâsit metin: \"${n.prefix}\" ile başlamalı.`;if(n.format===\"ends_with\")return`Fâsit metin: \"${n.suffix}\" ile bitmeli.`;if(n.format===\"includes\")return`Fâsit metin: \"${n.includes}\" ihtivâ etmeli.`;if(n.format===\"regex\")return`Fâsit metin: ${n.pattern} nakşına uymalı.`;return`Fâsit ${o[n.format]??t.format}`}case\"not_multiple_of\":return`Fâsit sayı: ${t.divisor} katı olmalıydı.`;case\"unrecognized_keys\":return`Tanınmayan anahtar ${t.keys.length>1?\"s\":\"\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`${t.origin} için tanınmayan anahtar var.`;case\"invalid_union\":return\"Giren tanınamadı.\";case\"invalid_element\":return`${t.origin} için tanınmayan kıymet var.`;default:return\"Kıymet tanınamadı.\"}}};function Po(){return{localeError:il()}}var ol=()=>{let e={string:{unit:\"توکي\",verb:\"ولري\"},file:{unit:\"بایټس\",verb:\"ولري\"},array:{unit:\"توکي\",verb:\"ولري\"},set:{unit:\"توکي\",verb:\"ولري\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"عدد\";case\"object\":{if(Array.isArray(t))return\"ارې\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"ورودي\",email:\"بریښنالیک\",url:\"یو آر ال\",emoji:\"ایموجي\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"نیټه او وخت\",date:\"نېټه\",time:\"وخت\",duration:\"موده\",ipv4:\"د IPv4 پته\",ipv6:\"د IPv6 پته\",cidrv4:\"د IPv4 ساحه\",cidrv6:\"د IPv6 ساحه\",base64:\"base64-encoded متن\",base64url:\"base64url-encoded متن\",json_string:\"JSON متن\",e164:\"د E.164 شمېره\",jwt:\"JWT\",template_literal:\"ورودي\"};return(t)=>{switch(t.code){case\"invalid_type\":return`ناسم ورودي: باید ${t.expected} وای, مګر ${i(t.input)} ترلاسه شو`;case\"invalid_value\":if(t.values.length===1)return`ناسم ورودي: باید ${g(t.values[0])} وای`;return`ناسم انتخاب: باید یو له ${l(t.values,\"|\")} څخه وای`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`ډیر لوی: ${t.origin??\"ارزښت\"} باید ${n}${t.maximum.toString()} ${a.unit??\"عنصرونه\"} ولري`;return`ډیر لوی: ${t.origin??\"ارزښت\"} باید ${n}${t.maximum.toString()} وي`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`ډیر کوچنی: ${t.origin} باید ${n}${t.minimum.toString()} ${a.unit} ولري`;return`ډیر کوچنی: ${t.origin} باید ${n}${t.minimum.toString()} وي`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`ناسم متن: باید د \"${n.prefix}\" سره پیل شي`;if(n.format===\"ends_with\")return`ناسم متن: باید د \"${n.suffix}\" سره پای ته ورسيږي`;if(n.format===\"includes\")return`ناسم متن: باید \"${n.includes}\" ولري`;if(n.format===\"regex\")return`ناسم متن: باید د ${n.pattern} سره مطابقت ولري`;return`${o[n.format]??t.format} ناسم دی`}case\"not_multiple_of\":return`ناسم عدد: باید د ${t.divisor} مضرب وي`;case\"unrecognized_keys\":return`ناسم ${t.keys.length>1?\"کلیډونه\":\"کلیډ\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`ناسم کلیډ په ${t.origin} کې`;case\"invalid_union\":return\"ناسمه ورودي\";case\"invalid_element\":return`ناسم عنصر په ${t.origin} کې`;default:return\"ناسمه ورودي\"}}};function No(){return{localeError:ol()}}var al=()=>{let e={string:{unit:\"znaków\",verb:\"mieć\"},file:{unit:\"bajtów\",verb:\"mieć\"},array:{unit:\"elementów\",verb:\"mieć\"},set:{unit:\"elementów\",verb:\"mieć\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"liczba\";case\"object\":{if(Array.isArray(t))return\"tablica\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"wyrażenie\",email:\"adres email\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"data i godzina w formacie ISO\",date:\"data w formacie ISO\",time:\"godzina w formacie ISO\",duration:\"czas trwania ISO\",ipv4:\"adres IPv4\",ipv6:\"adres IPv6\",cidrv4:\"zakres IPv4\",cidrv6:\"zakres IPv6\",base64:\"ciąg znaków zakodowany w formacie base64\",base64url:\"ciąg znaków zakodowany w formacie base64url\",json_string:\"ciąg znaków w formacie JSON\",e164:\"liczba E.164\",jwt:\"JWT\",template_literal:\"wejście\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Nieprawidłowe dane wejściowe: oczekiwano ${t.expected}, otrzymano ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Nieprawidłowe dane wejściowe: oczekiwano ${g(t.values[0])}`;return`Nieprawidłowa opcja: oczekiwano jednej z wartości ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`Za duża wartość: oczekiwano, że ${t.origin??\"wartość\"} będzie mieć ${n}${t.maximum.toString()} ${a.unit??\"elementów\"}`;return`Zbyt duż(y/a/e): oczekiwano, że ${t.origin??\"wartość\"} będzie wynosić ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`Za mała wartość: oczekiwano, że ${t.origin??\"wartość\"} będzie mieć ${n}${t.minimum.toString()} ${a.unit??\"elementów\"}`;return`Zbyt mał(y/a/e): oczekiwano, że ${t.origin??\"wartość\"} będzie wynosić ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Nieprawidłowy ciąg znaków: musi zaczynać się od \"${n.prefix}\"`;if(n.format===\"ends_with\")return`Nieprawidłowy ciąg znaków: musi kończyć się na \"${n.suffix}\"`;if(n.format===\"includes\")return`Nieprawidłowy ciąg znaków: musi zawierać \"${n.includes}\"`;if(n.format===\"regex\")return`Nieprawidłowy ciąg znaków: musi odpowiadać wzorcowi ${n.pattern}`;return`Nieprawidłow(y/a/e) ${o[n.format]??t.format}`}case\"not_multiple_of\":return`Nieprawidłowa liczba: musi być wielokrotnością ${t.divisor}`;case\"unrecognized_keys\":return`Nierozpoznane klucze${t.keys.length>1?\"s\":\"\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`Nieprawidłowy klucz w ${t.origin}`;case\"invalid_union\":return\"Nieprawidłowe dane wejściowe\";case\"invalid_element\":return`Nieprawidłowa wartość w ${t.origin}`;default:return\"Nieprawidłowe dane wejściowe\"}}};function Uo(){return{localeError:al()}}var ul=()=>{let e={string:{unit:\"caracteres\",verb:\"ter\"},file:{unit:\"bytes\",verb:\"ter\"},array:{unit:\"itens\",verb:\"ter\"},set:{unit:\"itens\",verb:\"ter\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"número\";case\"object\":{if(Array.isArray(t))return\"array\";if(t===null)return\"nulo\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"padrão\",email:\"endereço de e-mail\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"data e hora ISO\",date:\"data ISO\",time:\"hora ISO\",duration:\"duração ISO\",ipv4:\"endereço IPv4\",ipv6:\"endereço IPv6\",cidrv4:\"faixa de IPv4\",cidrv6:\"faixa de IPv6\",base64:\"texto codificado em base64\",base64url:\"URL codificada em base64\",json_string:\"texto JSON\",e164:\"número E.164\",jwt:\"JWT\",template_literal:\"entrada\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Tipo inválido: esperado ${t.expected}, recebido ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Entrada inválida: esperado ${g(t.values[0])}`;return`Opção inválida: esperada uma das ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`Muito grande: esperado que ${t.origin??\"valor\"} tivesse ${n}${t.maximum.toString()} ${a.unit??\"elementos\"}`;return`Muito grande: esperado que ${t.origin??\"valor\"} fosse ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`Muito pequeno: esperado que ${t.origin} tivesse ${n}${t.minimum.toString()} ${a.unit}`;return`Muito pequeno: esperado que ${t.origin} fosse ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Texto inválido: deve começar com \"${n.prefix}\"`;if(n.format===\"ends_with\")return`Texto inválido: deve terminar com \"${n.suffix}\"`;if(n.format===\"includes\")return`Texto inválido: deve incluir \"${n.includes}\"`;if(n.format===\"regex\")return`Texto inválido: deve corresponder ao padrão ${n.pattern}`;return`${o[n.format]??t.format} inválido`}case\"not_multiple_of\":return`Número inválido: deve ser múltiplo de ${t.divisor}`;case\"unrecognized_keys\":return`Chave${t.keys.length>1?\"s\":\"\"} desconhecida${t.keys.length>1?\"s\":\"\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`Chave inválida em ${t.origin}`;case\"invalid_union\":return\"Entrada inválida\";case\"invalid_element\":return`Valor inválido em ${t.origin}`;default:return\"Campo inválido\"}}};function Zo(){return{localeError:ul()}}function qu(e,r,i,o){let t=Math.abs(e),n=t%10,a=t%100;if(a>=11&&a<=19)return o;if(n===1)return r;if(n>=2&&n<=4)return i;return o}var cl=()=>{let e={string:{unit:{one:\"символ\",few:\"символа\",many:\"символов\"},verb:\"иметь\"},file:{unit:{one:\"байт\",few:\"байта\",many:\"байт\"},verb:\"иметь\"},array:{unit:{one:\"элемент\",few:\"элемента\",many:\"элементов\"},verb:\"иметь\"},set:{unit:{one:\"элемент\",few:\"элемента\",many:\"элементов\"},verb:\"иметь\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"число\";case\"object\":{if(Array.isArray(t))return\"массив\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"ввод\",email:\"email адрес\",url:\"URL\",emoji:\"эмодзи\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO дата и время\",date:\"ISO дата\",time:\"ISO время\",duration:\"ISO длительность\",ipv4:\"IPv4 адрес\",ipv6:\"IPv6 адрес\",cidrv4:\"IPv4 диапазон\",cidrv6:\"IPv6 диапазон\",base64:\"строка в формате base64\",base64url:\"строка в формате base64url\",json_string:\"JSON строка\",e164:\"номер E.164\",jwt:\"JWT\",template_literal:\"ввод\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Неверный ввод: ожидалось ${t.expected}, получено ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Неверный ввод: ожидалось ${g(t.values[0])}`;return`Неверный вариант: ожидалось одно из ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a){let c=Number(t.maximum),p=qu(c,a.unit.one,a.unit.few,a.unit.many);return`Слишком большое значение: ожидалось, что ${t.origin??\"значение\"} будет иметь ${n}${t.maximum.toString()} ${p}`}return`Слишком большое значение: ожидалось, что ${t.origin??\"значение\"} будет ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a){let c=Number(t.minimum),p=qu(c,a.unit.one,a.unit.few,a.unit.many);return`Слишком маленькое значение: ожидалось, что ${t.origin} будет иметь ${n}${t.minimum.toString()} ${p}`}return`Слишком маленькое значение: ожидалось, что ${t.origin} будет ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Неверная строка: должна начинаться с \"${n.prefix}\"`;if(n.format===\"ends_with\")return`Неверная строка: должна заканчиваться на \"${n.suffix}\"`;if(n.format===\"includes\")return`Неверная строка: должна содержать \"${n.includes}\"`;if(n.format===\"regex\")return`Неверная строка: должна соответствовать шаблону ${n.pattern}`;return`Неверный ${o[n.format]??t.format}`}case\"not_multiple_of\":return`Неверное число: должно быть кратным ${t.divisor}`;case\"unrecognized_keys\":return`Нераспознанн${t.keys.length>1?\"ые\":\"ый\"} ключ${t.keys.length>1?\"и\":\"\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`Неверный ключ в ${t.origin}`;case\"invalid_union\":return\"Неверные входные данные\";case\"invalid_element\":return`Неверное значение в ${t.origin}`;default:return\"Неверные входные данные\"}}};function Do(){return{localeError:cl()}}var sl=()=>{let e={string:{unit:\"znakov\",verb:\"imeti\"},file:{unit:\"bajtov\",verb:\"imeti\"},array:{unit:\"elementov\",verb:\"imeti\"},set:{unit:\"elementov\",verb:\"imeti\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"število\";case\"object\":{if(Array.isArray(t))return\"tabela\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"vnos\",email:\"e-poštni naslov\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO datum in čas\",date:\"ISO datum\",time:\"ISO čas\",duration:\"ISO trajanje\",ipv4:\"IPv4 naslov\",ipv6:\"IPv6 naslov\",cidrv4:\"obseg IPv4\",cidrv6:\"obseg IPv6\",base64:\"base64 kodiran niz\",base64url:\"base64url kodiran niz\",json_string:\"JSON niz\",e164:\"E.164 številka\",jwt:\"JWT\",template_literal:\"vnos\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Neveljaven vnos: pričakovano ${t.expected}, prejeto ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Neveljaven vnos: pričakovano ${g(t.values[0])}`;return`Neveljavna možnost: pričakovano eno izmed ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`Preveliko: pričakovano, da bo ${t.origin??\"vrednost\"} imelo ${n}${t.maximum.toString()} ${a.unit??\"elementov\"}`;return`Preveliko: pričakovano, da bo ${t.origin??\"vrednost\"} ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`Premajhno: pričakovano, da bo ${t.origin} imelo ${n}${t.minimum.toString()} ${a.unit}`;return`Premajhno: pričakovano, da bo ${t.origin} ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Neveljaven niz: mora se začeti z \"${n.prefix}\"`;if(n.format===\"ends_with\")return`Neveljaven niz: mora se končati z \"${n.suffix}\"`;if(n.format===\"includes\")return`Neveljaven niz: mora vsebovati \"${n.includes}\"`;if(n.format===\"regex\")return`Neveljaven niz: mora ustrezati vzorcu ${n.pattern}`;return`Neveljaven ${o[n.format]??t.format}`}case\"not_multiple_of\":return`Neveljavno število: mora biti večkratnik ${t.divisor}`;case\"unrecognized_keys\":return`Neprepoznan${t.keys.length>1?\"i ključi\":\" ključ\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`Neveljaven ključ v ${t.origin}`;case\"invalid_union\":return\"Neveljaven vnos\";case\"invalid_element\":return`Neveljavna vrednost v ${t.origin}`;default:return\"Neveljaven vnos\"}}};function To(){return{localeError:sl()}}var ll=()=>{let e={string:{unit:\"tecken\",verb:\"att ha\"},file:{unit:\"bytes\",verb:\"att ha\"},array:{unit:\"objekt\",verb:\"att innehålla\"},set:{unit:\"objekt\",verb:\"att innehålla\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"antal\";case\"object\":{if(Array.isArray(t))return\"lista\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"reguljärt uttryck\",email:\"e-postadress\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO-datum och tid\",date:\"ISO-datum\",time:\"ISO-tid\",duration:\"ISO-varaktighet\",ipv4:\"IPv4-intervall\",ipv6:\"IPv6-intervall\",cidrv4:\"IPv4-spektrum\",cidrv6:\"IPv6-spektrum\",base64:\"base64-kodad sträng\",base64url:\"base64url-kodad sträng\",json_string:\"JSON-sträng\",e164:\"E.164-nummer\",jwt:\"JWT\",template_literal:\"mall-literal\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Ogiltig inmatning: förväntat ${t.expected}, fick ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Ogiltig inmatning: förväntat ${g(t.values[0])}`;return`Ogiltigt val: förväntade en av ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`För stor(t): förväntade ${t.origin??\"värdet\"} att ha ${n}${t.maximum.toString()} ${a.unit??\"element\"}`;return`För stor(t): förväntat ${t.origin??\"värdet\"} att ha ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`För lite(t): förväntade ${t.origin??\"värdet\"} att ha ${n}${t.minimum.toString()} ${a.unit}`;return`För lite(t): förväntade ${t.origin??\"värdet\"} att ha ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Ogiltig sträng: måste börja med \"${n.prefix}\"`;if(n.format===\"ends_with\")return`Ogiltig sträng: måste sluta med \"${n.suffix}\"`;if(n.format===\"includes\")return`Ogiltig sträng: måste innehålla \"${n.includes}\"`;if(n.format===\"regex\")return`Ogiltig sträng: måste matcha mönstret \"${n.pattern}\"`;return`Ogiltig(t) ${o[n.format]??t.format}`}case\"not_multiple_of\":return`Ogiltigt tal: måste vara en multipel av ${t.divisor}`;case\"unrecognized_keys\":return`${t.keys.length>1?\"Okända nycklar\":\"Okänd nyckel\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`Ogiltig nyckel i ${t.origin??\"värdet\"}`;case\"invalid_union\":return\"Ogiltig input\";case\"invalid_element\":return`Ogiltigt värde i ${t.origin??\"värdet\"}`;default:return\"Ogiltig input\"}}};function Eo(){return{localeError:ll()}}var ml=()=>{let e={string:{unit:\"எழுத்துக்கள்\",verb:\"கொண்டிருக்க வேண்டும்\"},file:{unit:\"பைட்டுகள்\",verb:\"கொண்டிருக்க வேண்டும்\"},array:{unit:\"உறுப்புகள்\",verb:\"கொண்டிருக்க வேண்டும்\"},set:{unit:\"உறுப்புகள்\",verb:\"கொண்டிருக்க வேண்டும்\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"எண் அல்லாதது\":\"எண்\";case\"object\":{if(Array.isArray(t))return\"அணி\";if(t===null)return\"வெறுமை\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"உள்ளீடு\",email:\"மின்னஞ்சல் முகவரி\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO தேதி நேரம்\",date:\"ISO தேதி\",time:\"ISO நேரம்\",duration:\"ISO கால அளவு\",ipv4:\"IPv4 முகவரி\",ipv6:\"IPv6 முகவரி\",cidrv4:\"IPv4 வரம்பு\",cidrv6:\"IPv6 வரம்பு\",base64:\"base64-encoded சரம்\",base64url:\"base64url-encoded சரம்\",json_string:\"JSON சரம்\",e164:\"E.164 எண்\",jwt:\"JWT\",template_literal:\"input\"};return(t)=>{switch(t.code){case\"invalid_type\":return`தவறான உள்ளீடு: எதிர்பார்க்கப்பட்டது ${t.expected}, பெறப்பட்டது ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`தவறான உள்ளீடு: எதிர்பார்க்கப்பட்டது ${g(t.values[0])}`;return`தவறான விருப்பம்: எதிர்பார்க்கப்பட்டது ${l(t.values,\"|\")} இல் ஒன்று`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`மிக பெரியது: எதிர்பார்க்கப்பட்டது ${t.origin??\"மதிப்பு\"} ${n}${t.maximum.toString()} ${a.unit??\"உறுப்புகள்\"} ஆக இருக்க வேண்டும்`;return`மிக பெரியது: எதிர்பார்க்கப்பட்டது ${t.origin??\"மதிப்பு\"} ${n}${t.maximum.toString()} ஆக இருக்க வேண்டும்`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`மிகச் சிறியது: எதிர்பார்க்கப்பட்டது ${t.origin} ${n}${t.minimum.toString()} ${a.unit} ஆக இருக்க வேண்டும்`;return`மிகச் சிறியது: எதிர்பார்க்கப்பட்டது ${t.origin} ${n}${t.minimum.toString()} ஆக இருக்க வேண்டும்`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`தவறான சரம்: \"${n.prefix}\" இல் தொடங்க வேண்டும்`;if(n.format===\"ends_with\")return`தவறான சரம்: \"${n.suffix}\" இல் முடிவடைய வேண்டும்`;if(n.format===\"includes\")return`தவறான சரம்: \"${n.includes}\" ஐ உள்ளடக்க வேண்டும்`;if(n.format===\"regex\")return`தவறான சரம்: ${n.pattern} முறைபாட்டுடன் பொருந்த வேண்டும்`;return`தவறான ${o[n.format]??t.format}`}case\"not_multiple_of\":return`தவறான எண்: ${t.divisor} இன் பலமாக இருக்க வேண்டும்`;case\"unrecognized_keys\":return`அடையாளம் தெரியாத விசை${t.keys.length>1?\"கள்\":\"\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`${t.origin} இல் தவறான விசை`;case\"invalid_union\":return\"தவறான உள்ளீடு\";case\"invalid_element\":return`${t.origin} இல் தவறான மதிப்பு`;default:return\"தவறான உள்ளீடு\"}}};function Ao(){return{localeError:ml()}}var dl=()=>{let e={string:{unit:\"ตัวอักษร\",verb:\"ควรมี\"},file:{unit:\"ไบต์\",verb:\"ควรมี\"},array:{unit:\"รายการ\",verb:\"ควรมี\"},set:{unit:\"รายการ\",verb:\"ควรมี\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"ไม่ใช่ตัวเลข (NaN)\":\"ตัวเลข\";case\"object\":{if(Array.isArray(t))return\"อาร์เรย์ (Array)\";if(t===null)return\"ไม่มีค่า (null)\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"ข้อมูลที่ป้อน\",email:\"ที่อยู่อีเมล\",url:\"URL\",emoji:\"อิโมจิ\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"วันที่เวลาแบบ ISO\",date:\"วันที่แบบ ISO\",time:\"เวลาแบบ ISO\",duration:\"ช่วงเวลาแบบ ISO\",ipv4:\"ที่อยู่ IPv4\",ipv6:\"ที่อยู่ IPv6\",cidrv4:\"ช่วง IP แบบ IPv4\",cidrv6:\"ช่วง IP แบบ IPv6\",base64:\"ข้อความแบบ Base64\",base64url:\"ข้อความแบบ Base64 สำหรับ URL\",json_string:\"ข้อความแบบ JSON\",e164:\"เบอร์โทรศัพท์ระหว่างประเทศ (E.164)\",jwt:\"โทเคน JWT\",template_literal:\"ข้อมูลที่ป้อน\"};return(t)=>{switch(t.code){case\"invalid_type\":return`ประเภทข้อมูลไม่ถูกต้อง: ควรเป็น ${t.expected} แต่ได้รับ ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`ค่าไม่ถูกต้อง: ควรเป็น ${g(t.values[0])}`;return`ตัวเลือกไม่ถูกต้อง: ควรเป็นหนึ่งใน ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"ไม่เกิน\":\"น้อยกว่า\",a=r(t.origin);if(a)return`เกินกำหนด: ${t.origin??\"ค่า\"} ควรมี${n} ${t.maximum.toString()} ${a.unit??\"รายการ\"}`;return`เกินกำหนด: ${t.origin??\"ค่า\"} ควรมี${n} ${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\"อย่างน้อย\":\"มากกว่า\",a=r(t.origin);if(a)return`น้อยกว่ากำหนด: ${t.origin} ควรมี${n} ${t.minimum.toString()} ${a.unit}`;return`น้อยกว่ากำหนด: ${t.origin} ควรมี${n} ${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`รูปแบบไม่ถูกต้อง: ข้อความต้องขึ้นต้นด้วย \"${n.prefix}\"`;if(n.format===\"ends_with\")return`รูปแบบไม่ถูกต้อง: ข้อความต้องลงท้ายด้วย \"${n.suffix}\"`;if(n.format===\"includes\")return`รูปแบบไม่ถูกต้อง: ข้อความต้องมี \"${n.includes}\" อยู่ในข้อความ`;if(n.format===\"regex\")return`รูปแบบไม่ถูกต้อง: ต้องตรงกับรูปแบบที่กำหนด ${n.pattern}`;return`รูปแบบไม่ถูกต้อง: ${o[n.format]??t.format}`}case\"not_multiple_of\":return`ตัวเลขไม่ถูกต้อง: ต้องเป็นจำนวนที่หารด้วย ${t.divisor} ได้ลงตัว`;case\"unrecognized_keys\":return`พบคีย์ที่ไม่รู้จัก: ${l(t.keys,\", \")}`;case\"invalid_key\":return`คีย์ไม่ถูกต้องใน ${t.origin}`;case\"invalid_union\":return\"ข้อมูลไม่ถูกต้อง: ไม่ตรงกับรูปแบบยูเนียนที่กำหนดไว้\";case\"invalid_element\":return`ข้อมูลไม่ถูกต้องใน ${t.origin}`;default:return\"ข้อมูลไม่ถูกต้อง\"}}};function Lo(){return{localeError:dl()}}var pl=(e)=>{let r=typeof e;switch(r){case\"number\":return Number.isNaN(e)?\"NaN\":\"number\";case\"object\":{if(Array.isArray(e))return\"array\";if(e===null)return\"null\";if(Object.getPrototypeOf(e)!==Object.prototype&&e.constructor)return e.constructor.name}}return r},fl=()=>{let e={string:{unit:\"karakter\",verb:\"olmalı\"},file:{unit:\"bayt\",verb:\"olmalı\"},array:{unit:\"öğe\",verb:\"olmalı\"},set:{unit:\"öğe\",verb:\"olmalı\"}};function r(o){return e[o]??null}let i={regex:\"girdi\",email:\"e-posta adresi\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO tarih ve saat\",date:\"ISO tarih\",time:\"ISO saat\",duration:\"ISO süre\",ipv4:\"IPv4 adresi\",ipv6:\"IPv6 adresi\",cidrv4:\"IPv4 aralığı\",cidrv6:\"IPv6 aralığı\",base64:\"base64 ile şifrelenmiş metin\",base64url:\"base64url ile şifrelenmiş metin\",json_string:\"JSON dizesi\",e164:\"E.164 sayısı\",jwt:\"JWT\",template_literal:\"Şablon dizesi\"};return(o)=>{switch(o.code){case\"invalid_type\":return`Geçersiz değer: beklenen ${o.expected}, alınan ${pl(o.input)}`;case\"invalid_value\":if(o.values.length===1)return`Geçersiz değer: beklenen ${g(o.values[0])}`;return`Geçersiz seçenek: aşağıdakilerden biri olmalı: ${l(o.values,\"|\")}`;case\"too_big\":{let t=o.inclusive?\"<=\":\"<\",n=r(o.origin);if(n)return`Çok büyük: beklenen ${o.origin??\"değer\"} ${t}${o.maximum.toString()} ${n.unit??\"öğe\"}`;return`Çok büyük: beklenen ${o.origin??\"değer\"} ${t}${o.maximum.toString()}`}case\"too_small\":{let t=o.inclusive?\">=\":\">\",n=r(o.origin);if(n)return`Çok küçük: beklenen ${o.origin} ${t}${o.minimum.toString()} ${n.unit}`;return`Çok küçük: beklenen ${o.origin} ${t}${o.minimum.toString()}`}case\"invalid_format\":{let t=o;if(t.format===\"starts_with\")return`Geçersiz metin: \"${t.prefix}\" ile başlamalı`;if(t.format===\"ends_with\")return`Geçersiz metin: \"${t.suffix}\" ile bitmeli`;if(t.format===\"includes\")return`Geçersiz metin: \"${t.includes}\" içermeli`;if(t.format===\"regex\")return`Geçersiz metin: ${t.pattern} desenine uymalı`;return`Geçersiz ${i[t.format]??o.format}`}case\"not_multiple_of\":return`Geçersiz sayı: ${o.divisor} ile tam bölünebilmeli`;case\"unrecognized_keys\":return`Tanınmayan anahtar${o.keys.length>1?\"lar\":\"\"}: ${l(o.keys,\", \")}`;case\"invalid_key\":return`${o.origin} içinde geçersiz anahtar`;case\"invalid_union\":return\"Geçersiz değer\";case\"invalid_element\":return`${o.origin} içinde geçersiz değer`;default:return\"Geçersiz değer\"}}};function Ro(){return{localeError:fl()}}var vl=()=>{let e={string:{unit:\"символів\",verb:\"матиме\"},file:{unit:\"байтів\",verb:\"матиме\"},array:{unit:\"елементів\",verb:\"матиме\"},set:{unit:\"елементів\",verb:\"матиме\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"число\";case\"object\":{if(Array.isArray(t))return\"масив\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"вхідні дані\",email:\"адреса електронної пошти\",url:\"URL\",emoji:\"емодзі\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"дата та час ISO\",date:\"дата ISO\",time:\"час ISO\",duration:\"тривалість ISO\",ipv4:\"адреса IPv4\",ipv6:\"адреса IPv6\",cidrv4:\"діапазон IPv4\",cidrv6:\"діапазон IPv6\",base64:\"рядок у кодуванні base64\",base64url:\"рядок у кодуванні base64url\",json_string:\"рядок JSON\",e164:\"номер E.164\",jwt:\"JWT\",template_literal:\"вхідні дані\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Неправильні вхідні дані: очікується ${t.expected}, отримано ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Неправильні вхідні дані: очікується ${g(t.values[0])}`;return`Неправильна опція: очікується одне з ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`Занадто велике: очікується, що ${t.origin??\"значення\"} ${a.verb} ${n}${t.maximum.toString()} ${a.unit??\"елементів\"}`;return`Занадто велике: очікується, що ${t.origin??\"значення\"} буде ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`Занадто мале: очікується, що ${t.origin} ${a.verb} ${n}${t.minimum.toString()} ${a.unit}`;return`Занадто мале: очікується, що ${t.origin} буде ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Неправильний рядок: повинен починатися з \"${n.prefix}\"`;if(n.format===\"ends_with\")return`Неправильний рядок: повинен закінчуватися на \"${n.suffix}\"`;if(n.format===\"includes\")return`Неправильний рядок: повинен містити \"${n.includes}\"`;if(n.format===\"regex\")return`Неправильний рядок: повинен відповідати шаблону ${n.pattern}`;return`Неправильний ${o[n.format]??t.format}`}case\"not_multiple_of\":return`Неправильне число: повинно бути кратним ${t.divisor}`;case\"unrecognized_keys\":return`Нерозпізнаний ключ${t.keys.length>1?\"і\":\"\"}: ${l(t.keys,\", \")}`;case\"invalid_key\":return`Неправильний ключ у ${t.origin}`;case\"invalid_union\":return\"Неправильні вхідні дані\";case\"invalid_element\":return`Неправильне значення у ${t.origin}`;default:return\"Неправильні вхідні дані\"}}};function Co(){return{localeError:vl()}}var gl=()=>{let e={string:{unit:\"حروف\",verb:\"ہونا\"},file:{unit:\"بائٹس\",verb:\"ہونا\"},array:{unit:\"آئٹمز\",verb:\"ہونا\"},set:{unit:\"آئٹمز\",verb:\"ہونا\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"نمبر\";case\"object\":{if(Array.isArray(t))return\"آرے\";if(t===null)return\"نل\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"ان پٹ\",email:\"ای میل ایڈریس\",url:\"یو آر ایل\",emoji:\"ایموجی\",uuid:\"یو یو آئی ڈی\",uuidv4:\"یو یو آئی ڈی وی 4\",uuidv6:\"یو یو آئی ڈی وی 6\",nanoid:\"نینو آئی ڈی\",guid:\"جی یو آئی ڈی\",cuid:\"سی یو آئی ڈی\",cuid2:\"سی یو آئی ڈی 2\",ulid:\"یو ایل آئی ڈی\",xid:\"ایکس آئی ڈی\",ksuid:\"کے ایس یو آئی ڈی\",datetime:\"آئی ایس او ڈیٹ ٹائم\",date:\"آئی ایس او تاریخ\",time:\"آئی ایس او وقت\",duration:\"آئی ایس او مدت\",ipv4:\"آئی پی وی 4 ایڈریس\",ipv6:\"آئی پی وی 6 ایڈریس\",cidrv4:\"آئی پی وی 4 رینج\",cidrv6:\"آئی پی وی 6 رینج\",base64:\"بیس 64 ان کوڈڈ سٹرنگ\",base64url:\"بیس 64 یو آر ایل ان کوڈڈ سٹرنگ\",json_string:\"جے ایس او این سٹرنگ\",e164:\"ای 164 نمبر\",jwt:\"جے ڈبلیو ٹی\",template_literal:\"ان پٹ\"};return(t)=>{switch(t.code){case\"invalid_type\":return`غلط ان پٹ: ${t.expected} متوقع تھا، ${i(t.input)} موصول ہوا`;case\"invalid_value\":if(t.values.length===1)return`غلط ان پٹ: ${g(t.values[0])} متوقع تھا`;return`غلط آپشن: ${l(t.values,\"|\")} میں سے ایک متوقع تھا`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`بہت بڑا: ${t.origin??\"ویلیو\"} کے ${n}${t.maximum.toString()} ${a.unit??\"عناصر\"} ہونے متوقع تھے`;return`بہت بڑا: ${t.origin??\"ویلیو\"} کا ${n}${t.maximum.toString()} ہونا متوقع تھا`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`بہت چھوٹا: ${t.origin} کے ${n}${t.minimum.toString()} ${a.unit} ہونے متوقع تھے`;return`بہت چھوٹا: ${t.origin} کا ${n}${t.minimum.toString()} ہونا متوقع تھا`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`غلط سٹرنگ: \"${n.prefix}\" سے شروع ہونا چاہیے`;if(n.format===\"ends_with\")return`غلط سٹرنگ: \"${n.suffix}\" پر ختم ہونا چاہیے`;if(n.format===\"includes\")return`غلط سٹرنگ: \"${n.includes}\" شامل ہونا چاہیے`;if(n.format===\"regex\")return`غلط سٹرنگ: پیٹرن ${n.pattern} سے میچ ہونا چاہیے`;return`غلط ${o[n.format]??t.format}`}case\"not_multiple_of\":return`غلط نمبر: ${t.divisor} کا مضاعف ہونا چاہیے`;case\"unrecognized_keys\":return`غیر تسلیم شدہ کی${t.keys.length>1?\"ز\":\"\"}: ${l(t.keys,\"، \")}`;case\"invalid_key\":return`${t.origin} میں غلط کی`;case\"invalid_union\":return\"غلط ان پٹ\";case\"invalid_element\":return`${t.origin} میں غلط ویلیو`;default:return\"غلط ان پٹ\"}}};function Vo(){return{localeError:gl()}}var hl=()=>{let e={string:{unit:\"ký tự\",verb:\"có\"},file:{unit:\"byte\",verb:\"có\"},array:{unit:\"phần tử\",verb:\"có\"},set:{unit:\"phần tử\",verb:\"có\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"số\";case\"object\":{if(Array.isArray(t))return\"mảng\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"đầu vào\",email:\"địa chỉ email\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ngày giờ ISO\",date:\"ngày ISO\",time:\"giờ ISO\",duration:\"khoảng thời gian ISO\",ipv4:\"địa chỉ IPv4\",ipv6:\"địa chỉ IPv6\",cidrv4:\"dải IPv4\",cidrv6:\"dải IPv6\",base64:\"chuỗi mã hóa base64\",base64url:\"chuỗi mã hóa base64url\",json_string:\"chuỗi JSON\",e164:\"số E.164\",jwt:\"JWT\",template_literal:\"đầu vào\"};return(t)=>{switch(t.code){case\"invalid_type\":return`Đầu vào không hợp lệ: mong đợi ${t.expected}, nhận được ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`Đầu vào không hợp lệ: mong đợi ${g(t.values[0])}`;return`Tùy chọn không hợp lệ: mong đợi một trong các giá trị ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`Quá lớn: mong đợi ${t.origin??\"giá trị\"} ${a.verb} ${n}${t.maximum.toString()} ${a.unit??\"phần tử\"}`;return`Quá lớn: mong đợi ${t.origin??\"giá trị\"} ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`Quá nhỏ: mong đợi ${t.origin} ${a.verb} ${n}${t.minimum.toString()} ${a.unit}`;return`Quá nhỏ: mong đợi ${t.origin} ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`Chuỗi không hợp lệ: phải bắt đầu bằng \"${n.prefix}\"`;if(n.format===\"ends_with\")return`Chuỗi không hợp lệ: phải kết thúc bằng \"${n.suffix}\"`;if(n.format===\"includes\")return`Chuỗi không hợp lệ: phải bao gồm \"${n.includes}\"`;if(n.format===\"regex\")return`Chuỗi không hợp lệ: phải khớp với mẫu ${n.pattern}`;return`${o[n.format]??t.format} không hợp lệ`}case\"not_multiple_of\":return`Số không hợp lệ: phải là bội số của ${t.divisor}`;case\"unrecognized_keys\":return`Khóa không được nhận dạng: ${l(t.keys,\", \")}`;case\"invalid_key\":return`Khóa không hợp lệ trong ${t.origin}`;case\"invalid_union\":return\"Đầu vào không hợp lệ\";case\"invalid_element\":return`Giá trị không hợp lệ trong ${t.origin}`;default:return\"Đầu vào không hợp lệ\"}}};function Fo(){return{localeError:hl()}}var $l=()=>{let e={string:{unit:\"字符\",verb:\"包含\"},file:{unit:\"字节\",verb:\"包含\"},array:{unit:\"项\",verb:\"包含\"},set:{unit:\"项\",verb:\"包含\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"非数字(NaN)\":\"数字\";case\"object\":{if(Array.isArray(t))return\"数组\";if(t===null)return\"空值(null)\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"输入\",email:\"电子邮件\",url:\"URL\",emoji:\"表情符号\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO日期时间\",date:\"ISO日期\",time:\"ISO时间\",duration:\"ISO时长\",ipv4:\"IPv4地址\",ipv6:\"IPv6地址\",cidrv4:\"IPv4网段\",cidrv6:\"IPv6网段\",base64:\"base64编码字符串\",base64url:\"base64url编码字符串\",json_string:\"JSON字符串\",e164:\"E.164号码\",jwt:\"JWT\",template_literal:\"输入\"};return(t)=>{switch(t.code){case\"invalid_type\":return`无效输入：期望 ${t.expected}，实际接收 ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`无效输入：期望 ${g(t.values[0])}`;return`无效选项：期望以下之一 ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`数值过大：期望 ${t.origin??\"值\"} ${n}${t.maximum.toString()} ${a.unit??\"个元素\"}`;return`数值过大：期望 ${t.origin??\"值\"} ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`数值过小：期望 ${t.origin} ${n}${t.minimum.toString()} ${a.unit}`;return`数值过小：期望 ${t.origin} ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`无效字符串：必须以 \"${n.prefix}\" 开头`;if(n.format===\"ends_with\")return`无效字符串：必须以 \"${n.suffix}\" 结尾`;if(n.format===\"includes\")return`无效字符串：必须包含 \"${n.includes}\"`;if(n.format===\"regex\")return`无效字符串：必须满足正则表达式 ${n.pattern}`;return`无效${o[n.format]??t.format}`}case\"not_multiple_of\":return`无效数字：必须是 ${t.divisor} 的倍数`;case\"unrecognized_keys\":return`出现未知的键(key): ${l(t.keys,\", \")}`;case\"invalid_key\":return`${t.origin} 中的键(key)无效`;case\"invalid_union\":return\"无效输入\";case\"invalid_element\":return`${t.origin} 中包含无效值(value)`;default:return\"无效输入\"}}};function Jo(){return{localeError:$l()}}var _l=()=>{let e={string:{unit:\"字元\",verb:\"擁有\"},file:{unit:\"位元組\",verb:\"擁有\"},array:{unit:\"項目\",verb:\"擁有\"},set:{unit:\"項目\",verb:\"擁有\"}};function r(t){return e[t]??null}let i=(t)=>{let n=typeof t;switch(n){case\"number\":return Number.isNaN(t)?\"NaN\":\"number\";case\"object\":{if(Array.isArray(t))return\"array\";if(t===null)return\"null\";if(Object.getPrototypeOf(t)!==Object.prototype&&t.constructor)return t.constructor.name}}return n},o={regex:\"輸入\",email:\"郵件地址\",url:\"URL\",emoji:\"emoji\",uuid:\"UUID\",uuidv4:\"UUIDv4\",uuidv6:\"UUIDv6\",nanoid:\"nanoid\",guid:\"GUID\",cuid:\"cuid\",cuid2:\"cuid2\",ulid:\"ULID\",xid:\"XID\",ksuid:\"KSUID\",datetime:\"ISO 日期時間\",date:\"ISO 日期\",time:\"ISO 時間\",duration:\"ISO 期間\",ipv4:\"IPv4 位址\",ipv6:\"IPv6 位址\",cidrv4:\"IPv4 範圍\",cidrv6:\"IPv6 範圍\",base64:\"base64 編碼字串\",base64url:\"base64url 編碼字串\",json_string:\"JSON 字串\",e164:\"E.164 數值\",jwt:\"JWT\",template_literal:\"輸入\"};return(t)=>{switch(t.code){case\"invalid_type\":return`無效的輸入值：預期為 ${t.expected}，但收到 ${i(t.input)}`;case\"invalid_value\":if(t.values.length===1)return`無效的輸入值：預期為 ${g(t.values[0])}`;return`無效的選項：預期為以下其中之一 ${l(t.values,\"|\")}`;case\"too_big\":{let n=t.inclusive?\"<=\":\"<\",a=r(t.origin);if(a)return`數值過大：預期 ${t.origin??\"值\"} 應為 ${n}${t.maximum.toString()} ${a.unit??\"個元素\"}`;return`數值過大：預期 ${t.origin??\"值\"} 應為 ${n}${t.maximum.toString()}`}case\"too_small\":{let n=t.inclusive?\">=\":\">\",a=r(t.origin);if(a)return`數值過小：預期 ${t.origin} 應為 ${n}${t.minimum.toString()} ${a.unit}`;return`數值過小：預期 ${t.origin} 應為 ${n}${t.minimum.toString()}`}case\"invalid_format\":{let n=t;if(n.format===\"starts_with\")return`無效的字串：必須以 \"${n.prefix}\" 開頭`;if(n.format===\"ends_with\")return`無效的字串：必須以 \"${n.suffix}\" 結尾`;if(n.format===\"includes\")return`無效的字串：必須包含 \"${n.includes}\"`;if(n.format===\"regex\")return`無效的字串：必須符合格式 ${n.pattern}`;return`無效的 ${o[n.format]??t.format}`}case\"not_multiple_of\":return`無效的數字：必須為 ${t.divisor} 的倍數`;case\"unrecognized_keys\":return`無法識別的鍵值${t.keys.length>1?\"們\":\"\"}：${l(t.keys,\"、\")}`;case\"invalid_key\":return`${t.origin} 中有無效的鍵值`;case\"invalid_union\":return\"無效的輸入值\";case\"invalid_element\":return`${t.origin} 中有無效的值`;default:return\"無效的輸入值\"}}};function Mo(){return{localeError:_l()}}var Ct=Symbol(\"ZodOutput\"),Vt=Symbol(\"ZodInput\");class Qe{constructor(){this._map=new Map,this._idmap=new Map}add(e,...r){let i=r[0];if(this._map.set(e,i),i&&typeof i===\"object\"&&\"id\"in i){if(this._idmap.has(i.id))throw Error(`ID ${i.id} already exists in the registry`);this._idmap.set(i.id,e)}return this}clear(){return this._map=new Map,this._idmap=new Map,this}remove(e){let r=this._map.get(e);if(r&&typeof r===\"object\"&&\"id\"in r)this._idmap.delete(r.id);return this._map.delete(e),this}get(e){let r=e._zod.parent;if(r){let i={...this.get(r)??{}};return delete i.id,{...i,...this._map.get(e)}}return this._map.get(e)}has(e){return this._map.has(e)}}function et(){return new Qe}var C=et();function Wo(e,r){return new e({type:\"string\",...d(r)})}function Go(e,r){return new e({type:\"string\",coerce:!0,...d(r)})}function Ft(e,r){return new e({type:\"string\",format:\"email\",check:\"string_format\",abort:!1,...d(r)})}function tt(e,r){return new e({type:\"string\",format:\"guid\",check:\"string_format\",abort:!1,...d(r)})}function Jt(e,r){return new e({type:\"string\",format:\"uuid\",check:\"string_format\",abort:!1,...d(r)})}function Mt(e,r){return new e({type:\"string\",format:\"uuid\",check:\"string_format\",abort:!1,version:\"v4\",...d(r)})}function Wt(e,r){return new e({type:\"string\",format:\"uuid\",check:\"string_format\",abort:!1,version:\"v6\",...d(r)})}function Gt(e,r){return new e({type:\"string\",format:\"uuid\",check:\"string_format\",abort:!1,version:\"v7\",...d(r)})}function Bt(e,r){return new e({type:\"string\",format:\"url\",check:\"string_format\",abort:!1,...d(r)})}function Kt(e,r){return new e({type:\"string\",format:\"emoji\",check:\"string_format\",abort:!1,...d(r)})}function Xt(e,r){return new e({type:\"string\",format:\"nanoid\",check:\"string_format\",abort:!1,...d(r)})}function qt(e,r){return new e({type:\"string\",format:\"cuid\",check:\"string_format\",abort:!1,...d(r)})}function Yt(e,r){return new e({type:\"string\",format:\"cuid2\",check:\"string_format\",abort:!1,...d(r)})}function Ht(e,r){return new e({type:\"string\",format:\"ulid\",check:\"string_format\",abort:!1,...d(r)})}function Qt(e,r){return new e({type:\"string\",format:\"xid\",check:\"string_format\",abort:!1,...d(r)})}function er(e,r){return new e({type:\"string\",format:\"ksuid\",check:\"string_format\",abort:!1,...d(r)})}function tr(e,r){return new e({type:\"string\",format:\"ipv4\",check:\"string_format\",abort:!1,...d(r)})}function rr(e,r){return new e({type:\"string\",format:\"ipv6\",check:\"string_format\",abort:!1,...d(r)})}function nr(e,r){return new e({type:\"string\",format:\"cidrv4\",check:\"string_format\",abort:!1,...d(r)})}function ir(e,r){return new e({type:\"string\",format:\"cidrv6\",check:\"string_format\",abort:!1,...d(r)})}function or(e,r){return new e({type:\"string\",format:\"base64\",check:\"string_format\",abort:!1,...d(r)})}function ar(e,r){return new e({type:\"string\",format:\"base64url\",check:\"string_format\",abort:!1,...d(r)})}function ur(e,r){return new e({type:\"string\",format:\"e164\",check:\"string_format\",abort:!1,...d(r)})}function cr(e,r){return new e({type:\"string\",format:\"jwt\",check:\"string_format\",abort:!1,...d(r)})}var sr={Any:null,Minute:-1,Second:0,Millisecond:3,Microsecond:6};function Bo(e,r){return new e({type:\"string\",format:\"datetime\",check:\"string_format\",offset:!1,local:!1,precision:null,...d(r)})}function Ko(e,r){return new e({type:\"string\",format:\"date\",check:\"string_format\",...d(r)})}function Xo(e,r){return new e({type:\"string\",format:\"time\",check:\"string_format\",precision:null,...d(r)})}function qo(e,r){return new e({type:\"string\",format:\"duration\",check:\"string_format\",...d(r)})}function Yo(e,r){return new e({type:\"number\",checks:[],...d(r)})}function Ho(e,r){return new e({type:\"number\",coerce:!0,checks:[],...d(r)})}function Qo(e,r){return new e({type:\"number\",check:\"number_format\",abort:!1,format:\"safeint\",...d(r)})}function ea(e,r){return new e({type:\"number\",check:\"number_format\",abort:!1,format:\"float32\",...d(r)})}function ta(e,r){return new e({type:\"number\",check:\"number_format\",abort:!1,format:\"float64\",...d(r)})}function ra(e,r){return new e({type:\"number\",check:\"number_format\",abort:!1,format:\"int32\",...d(r)})}function na(e,r){return new e({type:\"number\",check:\"number_format\",abort:!1,format:\"uint32\",...d(r)})}function ia(e,r){return new e({type:\"boolean\",...d(r)})}function oa(e,r){return new e({type:\"boolean\",coerce:!0,...d(r)})}function aa(e,r){return new e({type:\"bigint\",...d(r)})}function ua(e,r){return new e({type:\"bigint\",coerce:!0,...d(r)})}function ca(e,r){return new e({type:\"bigint\",check:\"bigint_format\",abort:!1,format:\"int64\",...d(r)})}function sa(e,r){return new e({type:\"bigint\",check:\"bigint_format\",abort:!1,format:\"uint64\",...d(r)})}function la(e,r){return new e({type:\"symbol\",...d(r)})}function ma(e,r){return new e({type:\"undefined\",...d(r)})}function da(e,r){return new e({type:\"null\",...d(r)})}function pa(e){return new e({type:\"any\"})}function be(e){return new e({type:\"unknown\"})}function fa(e,r){return new e({type:\"never\",...d(r)})}function va(e,r){return new e({type:\"void\",...d(r)})}function ga(e,r){return new e({type:\"date\",...d(r)})}function ha(e,r){return new e({type:\"date\",coerce:!0,...d(r)})}function $a(e,r){return new e({type:\"nan\",...d(r)})}function V(e,r){return new Ut({check:\"less_than\",...d(r),value:e,inclusive:!1})}function R(e,r){return new Ut({check:\"less_than\",...d(r),value:e,inclusive:!0})}function F(e,r){return new Zt({check:\"greater_than\",...d(r),value:e,inclusive:!1})}function T(e,r){return new Zt({check:\"greater_than\",...d(r),value:e,inclusive:!0})}function lr(e){return F(0,e)}function mr(e){return V(0,e)}function dr(e){return R(0,e)}function pr(e){return T(0,e)}function H(e,r){return new Ln({check:\"multiple_of\",...d(r),value:e})}function ae(e,r){return new Vn({check:\"max_size\",...d(r),maximum:e})}function Q(e,r){return new Fn({check:\"min_size\",...d(r),minimum:e})}function ye(e,r){return new Jn({check:\"size_equals\",...d(r),size:e})}function ue(e,r){return new Mn({check:\"max_length\",...d(r),maximum:e})}function K(e,r){return new Wn({check:\"min_length\",...d(r),minimum:e})}function ce(e,r){return new Gn({check:\"length_equals\",...d(r),length:e})}function xe(e,r){return new Bn({check:\"string_format\",format:\"regex\",...d(r),pattern:e})}function ke(e){return new Kn({check:\"string_format\",format:\"lowercase\",...d(e)})}function ze(e){return new Xn({check:\"string_format\",format:\"uppercase\",...d(e)})}function Ie(e,r){return new qn({check:\"string_format\",format:\"includes\",...d(r),includes:e})}function we(e,r){return new Yn({check:\"string_format\",format:\"starts_with\",...d(r),prefix:e})}function Se(e,r){return new Hn({check:\"string_format\",format:\"ends_with\",...d(r),suffix:e})}function fr(e,r,i){return new Qn({check:\"property\",property:e,schema:r,...d(i)})}function je(e,r){return new ei({check:\"mime_type\",mime:e,...d(r)})}function J(e){return new ti({check:\"overwrite\",tx:e})}function Oe(e){return J((r)=>r.normalize(e))}function Pe(){return J((e)=>e.trim())}function Ne(){return J((e)=>e.toLowerCase())}function Ue(){return J((e)=>e.toUpperCase())}function rt(e,r,i){return new e({type:\"array\",element:r,...d(i)})}function bl(e,r,i){return new e({type:\"union\",options:r,...d(i)})}function yl(e,r,i,o){return new e({type:\"union\",options:i,discriminator:r,...d(o)})}function xl(e,r,i){return new e({type:\"intersection\",left:r,right:i})}function _a(e,r,i,o){let t=i instanceof x;return new e({type:\"tuple\",items:r,rest:t?i:null,...d(t?o:i)})}function kl(e,r,i,o){return new e({type:\"record\",keyType:r,valueType:i,...d(o)})}function zl(e,r,i,o){return new e({type:\"map\",keyType:r,valueType:i,...d(o)})}function Il(e,r,i){return new e({type:\"set\",valueType:r,...d(i)})}function wl(e,r,i){let o=Array.isArray(r)?Object.fromEntries(r.map((t)=>[t,t])):r;return new e({type:\"enum\",entries:o,...d(i)})}function Sl(e,r,i){return new e({type:\"enum\",entries:r,...d(i)})}function jl(e,r,i){return new e({type:\"literal\",values:Array.isArray(r)?r:[r],...d(i)})}function ba(e,r){return new e({type:\"file\",...d(r)})}function Ol(e,r){return new e({type:\"transform\",transform:r})}function Pl(e,r){return new e({type:\"optional\",innerType:r})}function Nl(e,r){return new e({type:\"nullable\",innerType:r})}function Ul(e,r,i){return new e({type:\"default\",innerType:r,get defaultValue(){return typeof i===\"function\"?i():i}})}function Zl(e,r,i){return new e({type:\"nonoptional\",innerType:r,...d(i)})}function Dl(e,r){return new e({type:\"success\",innerType:r})}function Tl(e,r,i){return new e({type:\"catch\",innerType:r,catchValue:typeof i===\"function\"?i:()=>i})}function El(e,r,i){return new e({type:\"pipe\",in:r,out:i})}function Al(e,r){return new e({type:\"readonly\",innerType:r})}function Ll(e,r,i){return new e({type:\"template_literal\",parts:r,...d(i)})}function Rl(e,r){return new e({type:\"lazy\",getter:r})}function Cl(e,r){return new e({type:\"promise\",innerType:r})}function ya(e,r,i){let o=d(i);return o.abort??(o.abort=!0),new e({type:\"custom\",check:\"custom\",fn:r,...o})}function xa(e,r,i){return new e({type:\"custom\",check:\"custom\",fn:r,...d(i)})}function ka(e,r){let i=d(r),o=i.truthy??[\"true\",\"1\",\"yes\",\"on\",\"y\",\"enabled\"],t=i.falsy??[\"false\",\"0\",\"no\",\"off\",\"n\",\"disabled\"];if(i.case!==\"sensitive\")o=o.map((v)=>typeof v===\"string\"?v.toLowerCase():v),t=t.map((v)=>typeof v===\"string\"?v.toLowerCase():v);let n=new Set(o),a=new Set(t),c=e.Pipe??Ye,p=e.Boolean??Ke,m=e.String??ie,_=new(e.Transform??qe)({type:\"transform\",transform:(v,b)=>{let S=v;if(i.case!==\"sensitive\")S=S.toLowerCase();if(n.has(S))return!0;else if(a.has(S))return!1;else return b.issues.push({code:\"invalid_value\",expected:\"stringbool\",values:[...n,...a],input:b.value,inst:_}),{}},error:i.error}),h=new c({type:\"pipe\",in:new m({type:\"string\",error:i.error}),out:_,error:i.error});return new c({type:\"pipe\",in:h,out:new p({type:\"boolean\",error:i.error}),error:i.error})}function za(e,r,i,o={}){let t=d(o),n={...d(o),check:\"string_format\",type:\"string\",format:r,fn:typeof i===\"function\"?i:(c)=>i.test(c),...t};if(i instanceof RegExp)n.pattern=i;return new e(n)}class Ia{constructor(e){this._def=e,this.def=e}implement(e){if(typeof e!==\"function\")throw Error(\"implement() must be called with a function\");let r=(...i)=>{let o=this._def.input?wt(this._def.input,i,void 0,{callee:r}):i;if(!Array.isArray(o))throw Error(\"Invalid arguments schema: not an array or tuple schema.\");let t=e(...o);return this._def.output?wt(this._def.output,t,void 0,{callee:r}):t};return r}implementAsync(e){if(typeof e!==\"function\")throw Error(\"implement() must be called with a function\");let r=async(...i)=>{let o=this._def.input?await jt(this._def.input,i,void 0,{callee:r}):i;if(!Array.isArray(o))throw Error(\"Invalid arguments schema: not an array or tuple schema.\");let t=await e(...o);return this._def.output?jt(this._def.output,t,void 0,{callee:r}):t};return r}input(...e){let r=this.constructor;if(Array.isArray(e[0]))return new r({type:\"function\",input:new oe({type:\"tuple\",items:e[0],rest:e[1]}),output:this._def.output});return new r({type:\"function\",input:e[0],output:this._def.output})}output(e){return new this.constructor({type:\"function\",input:this._def.input,output:e})}}function vr(e){return new Ia({type:\"function\",input:Array.isArray(e?.input)?_a(oe,e?.input):e?.input??rt(Xe,be($e)),output:e?.output??be($e)})}class gr{constructor(e){this.counter=0,this.metadataRegistry=e?.metadata??C,this.target=e?.target??\"draft-2020-12\",this.unrepresentable=e?.unrepresentable??\"throw\",this.override=e?.override??(()=>{}),this.io=e?.io??\"output\",this.seen=new Map}process(e,r={path:[],schemaPath:[]}){var i;let o=e._zod.def,t={guid:\"uuid\",url:\"uri\",datetime:\"date-time\",json_string:\"json-string\",regex:\"\"},n=this.seen.get(e);if(n){if(n.count++,r.schemaPath.includes(e))n.cycle=r.path;return n.schema}let a={schema:{},count:1,cycle:void 0,path:r.path};this.seen.set(e,a);let c=e._zod.toJSONSchema?.();if(c)a.schema=c;else{let f={...r,schemaPath:[...r.schemaPath,e],path:r.path},_=e._zod.parent;if(_)a.ref=_,this.process(_,f),this.seen.get(_).isParent=!0;else{let h=a.schema;switch(o.type){case\"string\":{let s=h;s.type=\"string\";let{minimum:v,maximum:b,format:S,patterns:j,contentEncoding:z}=e._zod.bag;if(typeof v===\"number\")s.minLength=v;if(typeof b===\"number\")s.maxLength=b;if(S){if(s.format=t[S]??S,s.format===\"\")delete s.format}if(z)s.contentEncoding=z;if(j&&j.size>0){let I=[...j];if(I.length===1)s.pattern=I[0].source;else if(I.length>1)a.schema.allOf=[...I.map((U)=>({...this.target===\"draft-7\"?{type:\"string\"}:{},pattern:U.source}))]}break}case\"number\":{let s=h,{minimum:v,maximum:b,format:S,multipleOf:j,exclusiveMaximum:z,exclusiveMinimum:I}=e._zod.bag;if(typeof S===\"string\"&&S.includes(\"int\"))s.type=\"integer\";else s.type=\"number\";if(typeof I===\"number\")s.exclusiveMinimum=I;if(typeof v===\"number\"){if(s.minimum=v,typeof I===\"number\")if(I>=v)delete s.minimum;else delete s.exclusiveMinimum}if(typeof z===\"number\")s.exclusiveMaximum=z;if(typeof b===\"number\"){if(s.maximum=b,typeof z===\"number\")if(z<=b)delete s.maximum;else delete s.exclusiveMaximum}if(typeof j===\"number\")s.multipleOf=j;break}case\"boolean\":{let s=h;s.type=\"boolean\";break}case\"bigint\":{if(this.unrepresentable===\"throw\")throw Error(\"BigInt cannot be represented in JSON Schema\");break}case\"symbol\":{if(this.unrepresentable===\"throw\")throw Error(\"Symbols cannot be represented in JSON Schema\");break}case\"null\":{h.type=\"null\";break}case\"any\":break;case\"unknown\":break;case\"undefined\":{if(this.unrepresentable===\"throw\")throw Error(\"Undefined cannot be represented in JSON Schema\");break}case\"void\":{if(this.unrepresentable===\"throw\")throw Error(\"Void cannot be represented in JSON Schema\");break}case\"never\":{h.not={};break}case\"date\":{if(this.unrepresentable===\"throw\")throw Error(\"Date cannot be represented in JSON Schema\");break}case\"array\":{let s=h,{minimum:v,maximum:b}=e._zod.bag;if(typeof v===\"number\")s.minItems=v;if(typeof b===\"number\")s.maxItems=b;s.type=\"array\",s.items=this.process(o.element,{...f,path:[...f.path,\"items\"]});break}case\"object\":{let s=h;s.type=\"object\",s.properties={};let v=o.shape;for(let j in v)s.properties[j]=this.process(v[j],{...f,path:[...f.path,\"properties\",j]});let b=new Set(Object.keys(v)),S=new Set([...b].filter((j)=>{let z=o.shape[j]._zod;if(this.io===\"input\")return z.optin===void 0;else return z.optout===void 0}));if(S.size>0)s.required=Array.from(S);if(o.catchall?._zod.def.type===\"never\")s.additionalProperties=!1;else if(!o.catchall){if(this.io===\"output\")s.additionalProperties=!1}else if(o.catchall)s.additionalProperties=this.process(o.catchall,{...f,path:[...f.path,\"additionalProperties\"]});break}case\"union\":{let s=h;s.anyOf=o.options.map((v,b)=>this.process(v,{...f,path:[...f.path,\"anyOf\",b]}));break}case\"intersection\":{let s=h,v=this.process(o.left,{...f,path:[...f.path,\"allOf\",0]}),b=this.process(o.right,{...f,path:[...f.path,\"allOf\",1]}),S=(z)=>(\"allOf\"in z)&&Object.keys(z).length===1,j=[...S(v)?v.allOf:[v],...S(b)?b.allOf:[b]];s.allOf=j;break}case\"tuple\":{let s=h;s.type=\"array\";let v=o.items.map((j,z)=>this.process(j,{...f,path:[...f.path,\"prefixItems\",z]}));if(this.target===\"draft-2020-12\")s.prefixItems=v;else s.items=v;if(o.rest){let j=this.process(o.rest,{...f,path:[...f.path,\"items\"]});if(this.target===\"draft-2020-12\")s.items=j;else s.additionalItems=j}if(o.rest)s.items=this.process(o.rest,{...f,path:[...f.path,\"items\"]});let{minimum:b,maximum:S}=e._zod.bag;if(typeof b===\"number\")s.minItems=b;if(typeof S===\"number\")s.maxItems=S;break}case\"record\":{let s=h;s.type=\"object\",s.propertyNames=this.process(o.keyType,{...f,path:[...f.path,\"propertyNames\"]}),s.additionalProperties=this.process(o.valueType,{...f,path:[...f.path,\"additionalProperties\"]});break}case\"map\":{if(this.unrepresentable===\"throw\")throw Error(\"Map cannot be represented in JSON Schema\");break}case\"set\":{if(this.unrepresentable===\"throw\")throw Error(\"Set cannot be represented in JSON Schema\");break}case\"enum\":{let s=h,v=Ve(o.entries);if(v.every((b)=>typeof b===\"number\"))s.type=\"number\";if(v.every((b)=>typeof b===\"string\"))s.type=\"string\";s.enum=v;break}case\"literal\":{let s=h,v=[];for(let b of o.values)if(b===void 0){if(this.unrepresentable===\"throw\")throw Error(\"Literal `undefined` cannot be represented in JSON Schema\")}else if(typeof b===\"bigint\")if(this.unrepresentable===\"throw\")throw Error(\"BigInt literals cannot be represented in JSON Schema\");else v.push(Number(b));else v.push(b);if(v.length===0);else if(v.length===1){let b=v[0];s.type=b===null?\"null\":typeof b,s.const=b}else{if(v.every((b)=>typeof b===\"number\"))s.type=\"number\";if(v.every((b)=>typeof b===\"string\"))s.type=\"string\";if(v.every((b)=>typeof b===\"boolean\"))s.type=\"string\";if(v.every((b)=>b===null))s.type=\"null\";s.enum=v}break}case\"file\":{let s=h,v={type:\"string\",format:\"binary\",contentEncoding:\"binary\"},{minimum:b,maximum:S,mime:j}=e._zod.bag;if(b!==void 0)v.minLength=b;if(S!==void 0)v.maxLength=S;if(j)if(j.length===1)v.contentMediaType=j[0],Object.assign(s,v);else s.anyOf=j.map((z)=>({...v,contentMediaType:z}));else Object.assign(s,v);break}case\"transform\":{if(this.unrepresentable===\"throw\")throw Error(\"Transforms cannot be represented in JSON Schema\");break}case\"nullable\":{let s=this.process(o.innerType,f);h.anyOf=[s,{type:\"null\"}];break}case\"nonoptional\":{this.process(o.innerType,f),a.ref=o.innerType;break}case\"success\":{let s=h;s.type=\"boolean\";break}case\"default\":{this.process(o.innerType,f),a.ref=o.innerType,h.default=JSON.parse(JSON.stringify(o.defaultValue));break}case\"prefault\":{if(this.process(o.innerType,f),a.ref=o.innerType,this.io===\"input\")h._prefault=JSON.parse(JSON.stringify(o.defaultValue));break}case\"catch\":{this.process(o.innerType,f),a.ref=o.innerType;let s;try{s=o.catchValue(void 0)}catch{throw Error(\"Dynamic catch values are not supported in JSON Schema\")}h.default=s;break}case\"nan\":{if(this.unrepresentable===\"throw\")throw Error(\"NaN cannot be represented in JSON Schema\");break}case\"template_literal\":{let s=h,v=e._zod.pattern;if(!v)throw Error(\"Pattern not found in template literal\");s.type=\"string\",s.pattern=v.source;break}case\"pipe\":{let s=this.io===\"input\"?o.in._zod.def.type===\"transform\"?o.out:o.in:o.out;this.process(s,f),a.ref=s;break}case\"readonly\":{this.process(o.innerType,f),a.ref=o.innerType,h.readOnly=!0;break}case\"promise\":{this.process(o.innerType,f),a.ref=o.innerType;break}case\"optional\":{this.process(o.innerType,f),a.ref=o.innerType;break}case\"lazy\":{let s=e._zod.innerType;this.process(s,f),a.ref=s;break}case\"custom\":{if(this.unrepresentable===\"throw\")throw Error(\"Custom types cannot be represented in JSON Schema\");break}default:}}}let p=this.metadataRegistry.get(e);if(p)Object.assign(a.schema,p);if(this.io===\"input\"&&D(e))delete a.schema.examples,delete a.schema.default;if(this.io===\"input\"&&a.schema._prefault)(i=a.schema).default??(i.default=a.schema._prefault);return delete a.schema._prefault,this.seen.get(e).schema}emit(e,r){let i={cycles:r?.cycles??\"ref\",reused:r?.reused??\"inline\",external:r?.external??void 0},o=this.seen.get(e);if(!o)throw Error(\"Unprocessed schema. This is a bug in Zod.\");let t=(m)=>{let f=this.target===\"draft-2020-12\"?\"$defs\":\"definitions\";if(i.external){let v=i.external.registry.get(m[0])?.id,b=i.external.uri??((j)=>j);if(v)return{ref:b(v)};let S=m[1].defId??m[1].schema.id??`schema${this.counter++}`;return m[1].defId=S,{defId:S,ref:`${b(\"__shared\")}#/${f}/${S}`}}if(m[1]===o)return{ref:\"#\"};let h=`${\"#\"}/${f}/`,s=m[1].schema.id??`__schema${this.counter++}`;return{defId:s,ref:h+s}},n=(m)=>{if(m[1].schema.$ref)return;let f=m[1],{ref:_,defId:h}=t(m);if(f.def={...f.schema},h)f.defId=h;let s=f.schema;for(let v in s)delete s[v];s.$ref=_};if(i.cycles===\"throw\")for(let m of this.seen.entries()){let f=m[1];if(f.cycle)throw Error(`Cycle detected: #/${f.cycle?.join(\"/\")}/<root>\n\nSet the \\`cycles\\` parameter to \\`\"ref\"\\` to resolve cyclical schemas with defs.`)}for(let m of this.seen.entries()){let f=m[1];if(e===m[0]){n(m);continue}if(i.external){let h=i.external.registry.get(m[0])?.id;if(e!==m[0]&&h){n(m);continue}}if(this.metadataRegistry.get(m[0])?.id){n(m);continue}if(f.cycle){n(m);continue}if(f.count>1){if(i.reused===\"ref\"){n(m);continue}}}let a=(m,f)=>{let _=this.seen.get(m),h=_.def??_.schema,s={...h};if(_.ref===null)return;let v=_.ref;if(_.ref=null,v){a(v,f);let b=this.seen.get(v).schema;if(b.$ref&&f.target===\"draft-7\")h.allOf=h.allOf??[],h.allOf.push(b);else Object.assign(h,b),Object.assign(h,s)}if(!_.isParent)this.override({zodSchema:m,jsonSchema:h,path:_.path??[]})};for(let m of[...this.seen.entries()].reverse())a(m[0],{target:this.target});let c={};if(this.target===\"draft-2020-12\")c.$schema=\"https://json-schema.org/draft/2020-12/schema\";else if(this.target===\"draft-7\")c.$schema=\"http://json-schema.org/draft-07/schema#\";else console.warn(`Invalid target: ${this.target}`);if(i.external?.uri){let m=i.external.registry.get(e)?.id;if(!m)throw Error(\"Schema is missing an `id` property\");c.$id=i.external.uri(m)}Object.assign(c,o.def);let p=i.external?.defs??{};for(let m of this.seen.entries()){let f=m[1];if(f.def&&f.defId)p[f.defId]=f.def}if(i.external);else if(Object.keys(p).length>0)if(this.target===\"draft-2020-12\")c.$defs=p;else c.definitions=p;try{return JSON.parse(JSON.stringify(c))}catch(m){throw Error(\"Error converting schema to JSON.\")}}}function hr(e,r){if(e instanceof Qe){let o=new gr(r),t={};for(let c of e._idmap.entries()){let[p,m]=c;o.process(m)}let n={},a={registry:e,uri:r?.uri,defs:t};for(let c of e._idmap.entries()){let[p,m]=c;n[p]=o.emit(m,{...r,external:a})}if(Object.keys(t).length>0){let c=o.target===\"draft-2020-12\"?\"$defs\":\"definitions\";n.__shared={[c]:t}}return{schemas:n}}let i=new gr(r);return i.process(e),i.emit(e,r)}function D(e,r){let i=r??{seen:new Set};if(i.seen.has(e))return!1;i.seen.add(e);let t=e._zod.def;switch(t.type){case\"string\":case\"number\":case\"bigint\":case\"boolean\":case\"date\":case\"symbol\":case\"undefined\":case\"null\":case\"any\":case\"unknown\":case\"never\":case\"void\":case\"literal\":case\"enum\":case\"nan\":case\"file\":case\"template_literal\":return!1;case\"array\":return D(t.element,i);case\"object\":{for(let n in t.shape)if(D(t.shape[n],i))return!0;return!1}case\"union\":{for(let n of t.options)if(D(n,i))return!0;return!1}case\"intersection\":return D(t.left,i)||D(t.right,i);case\"tuple\":{for(let n of t.items)if(D(n,i))return!0;if(t.rest&&D(t.rest,i))return!0;return!1}case\"record\":return D(t.keyType,i)||D(t.valueType,i);case\"map\":return D(t.keyType,i)||D(t.valueType,i);case\"set\":return D(t.valueType,i);case\"promise\":case\"optional\":case\"nonoptional\":case\"nullable\":case\"readonly\":return D(t.innerType,i);case\"lazy\":return D(t.getter(),i);case\"default\":return D(t.innerType,i);case\"prefault\":return D(t.innerType,i);case\"custom\":return!1;case\"transform\":return!0;case\"pipe\":return D(t.in,i)||D(t.out,i);case\"success\":return!1;case\"catch\":return!1;default:}throw Error(`Unknown schema type: ${t.type}`)}var nt=u(\"ZodISODateTime\",(e,r)=>{vi.init(e,r),P.init(e,r)});function wa(e){return Bo(nt,e)}var it=u(\"ZodISODate\",(e,r)=>{gi.init(e,r),P.init(e,r)});function Sa(e){return Ko(it,e)}var ot=u(\"ZodISOTime\",(e,r)=>{hi.init(e,r),P.init(e,r)});function ja(e){return Xo(ot,e)}var at=u(\"ZodISODuration\",(e,r)=>{$i.init(e,r),P.init(e,r)});function Oa(e){return qo(at,e)}var Qu=(e,r)=>{Be.init(e,r),e.name=\"ZodError\",Object.defineProperties(e,{format:{value:(i)=>ge(e,i)},flatten:{value:(i)=>ve(e,i)},addIssue:{value:(i)=>e.issues.push(i)},addIssues:{value:(i)=>e.issues.push(...i)},isEmpty:{get(){return e.issues.length===0}}})},ec=u(\"ZodError\",Qu),se=u(\"ZodError\",Qu,{Parent:Error});var $r=It(se),_r=St(se),br=Ot(se),yr=Pt(se);var k=u(\"ZodType\",(e,r)=>(x.init(e,r),e.def=r,Object.defineProperty(e,\"_def\",{value:r}),e.check=(...i)=>e.clone({...r,checks:[...r.checks??[],...i.map((o)=>typeof o===\"function\"?{_zod:{check:o,def:{check:\"custom\"},onattach:[]}}:o)]}),e.clone=(i,o)=>E(e,i,o),e.brand=()=>e,e.register=(i,o)=>(i.add(e,o),e),e.parse=(i,o)=>$r(e,i,o,{callee:e.parse}),e.safeParse=(i,o)=>br(e,i,o),e.parseAsync=async(i,o)=>_r(e,i,o,{callee:e.parseAsync}),e.safeParseAsync=async(i,o)=>yr(e,i,o),e.spa=e.safeParseAsync,e.refine=(i,o)=>e.check(gu(i,o)),e.superRefine=(i)=>e.check(hu(i)),e.overwrite=(i)=>e.check(J(i)),e.optional=()=>lt(e),e.nullable=()=>mt(e),e.nullish=()=>lt(mt(e)),e.nonoptional=(i)=>iu(e,i),e.array=()=>Jr(e),e.or=(i)=>gt([e,i]),e.and=(i)=>Ma(e,i),e.transform=(i)=>dt(e,Br(i)),e.default=(i)=>tu(e,i),e.prefault=(i)=>nu(e,i),e.catch=(i)=>uu(e,i),e.pipe=(i)=>dt(e,i),e.readonly=()=>lu(e),e.describe=(i)=>{let o=e.clone();return C.add(o,{description:i}),o},Object.defineProperty(e,\"description\",{get(){return C.get(e)?.description},configurable:!0}),e.meta=(...i)=>{if(i.length===0)return C.get(e);let o=e.clone();return C.add(o,i[0]),o},e.isOptional=()=>e.safeParse(void 0).success,e.isNullable=()=>e.safeParse(null).success,e)),zr=u(\"_ZodString\",(e,r)=>{ie.init(e,r),k.init(e,r);let i=e._zod.bag;e.format=i.format??null,e.minLength=i.minimum??null,e.maxLength=i.maximum??null,e.regex=(...o)=>e.check(xe(...o)),e.includes=(...o)=>e.check(Ie(...o)),e.startsWith=(...o)=>e.check(we(...o)),e.endsWith=(...o)=>e.check(Se(...o)),e.min=(...o)=>e.check(K(...o)),e.max=(...o)=>e.check(ue(...o)),e.length=(...o)=>e.check(ce(...o)),e.nonempty=(...o)=>e.check(K(1,...o)),e.lowercase=(o)=>e.check(ke(o)),e.uppercase=(o)=>e.check(ze(o)),e.trim=()=>e.check(Pe()),e.normalize=(...o)=>e.check(Oe(...o)),e.toLowerCase=()=>e.check(Ne()),e.toUpperCase=()=>e.check(Ue())}),De=u(\"ZodString\",(e,r)=>{ie.init(e,r),zr.init(e,r),e.email=(i)=>e.check(Ft(Ir,i)),e.url=(i)=>e.check(Bt(wr,i)),e.jwt=(i)=>e.check(cr(Vr,i)),e.emoji=(i)=>e.check(Kt(Sr,i)),e.guid=(i)=>e.check(tt(ct,i)),e.uuid=(i)=>e.check(Jt(W,i)),e.uuidv4=(i)=>e.check(Mt(W,i)),e.uuidv6=(i)=>e.check(Wt(W,i)),e.uuidv7=(i)=>e.check(Gt(W,i)),e.nanoid=(i)=>e.check(Xt(jr,i)),e.guid=(i)=>e.check(tt(ct,i)),e.cuid=(i)=>e.check(qt(Or,i)),e.cuid2=(i)=>e.check(Yt(Pr,i)),e.ulid=(i)=>e.check(Ht(Nr,i)),e.base64=(i)=>e.check(or(Lr,i)),e.base64url=(i)=>e.check(ar(Rr,i)),e.xid=(i)=>e.check(Qt(Ur,i)),e.ksuid=(i)=>e.check(er(Zr,i)),e.ipv4=(i)=>e.check(tr(Dr,i)),e.ipv6=(i)=>e.check(rr(Tr,i)),e.cidrv4=(i)=>e.check(nr(Er,i)),e.cidrv6=(i)=>e.check(ir(Ar,i)),e.e164=(i)=>e.check(ur(Cr,i)),e.datetime=(i)=>e.check(wa(i)),e.date=(i)=>e.check(Sa(i)),e.time=(i)=>e.check(ja(i)),e.duration=(i)=>e.check(Oa(i))});function xr(e){return Wo(De,e)}var P=u(\"ZodStringFormat\",(e,r)=>{O.init(e,r),zr.init(e,r)}),Ir=u(\"ZodEmail\",(e,r)=>{ai.init(e,r),P.init(e,r)});function tc(e){return Ft(Ir,e)}var ct=u(\"ZodGUID\",(e,r)=>{ii.init(e,r),P.init(e,r)});function rc(e){return tt(ct,e)}var W=u(\"ZodUUID\",(e,r)=>{oi.init(e,r),P.init(e,r)});function nc(e){return Jt(W,e)}function ic(e){return Mt(W,e)}function oc(e){return Wt(W,e)}function ac(e){return Gt(W,e)}var wr=u(\"ZodURL\",(e,r)=>{ui.init(e,r),P.init(e,r)});function uc(e){return Bt(wr,e)}var Sr=u(\"ZodEmoji\",(e,r)=>{ci.init(e,r),P.init(e,r)});function cc(e){return Kt(Sr,e)}var jr=u(\"ZodNanoID\",(e,r)=>{si.init(e,r),P.init(e,r)});function sc(e){return Xt(jr,e)}var Or=u(\"ZodCUID\",(e,r)=>{li.init(e,r),P.init(e,r)});function lc(e){return qt(Or,e)}var Pr=u(\"ZodCUID2\",(e,r)=>{mi.init(e,r),P.init(e,r)});function mc(e){return Yt(Pr,e)}var Nr=u(\"ZodULID\",(e,r)=>{di.init(e,r),P.init(e,r)});function dc(e){return Ht(Nr,e)}var Ur=u(\"ZodXID\",(e,r)=>{pi.init(e,r),P.init(e,r)});function pc(e){return Qt(Ur,e)}var Zr=u(\"ZodKSUID\",(e,r)=>{fi.init(e,r),P.init(e,r)});function fc(e){return er(Zr,e)}var Dr=u(\"ZodIPv4\",(e,r)=>{_i.init(e,r),P.init(e,r)});function vc(e){return tr(Dr,e)}var Tr=u(\"ZodIPv6\",(e,r)=>{bi.init(e,r),P.init(e,r)});function gc(e){return rr(Tr,e)}var Er=u(\"ZodCIDRv4\",(e,r)=>{yi.init(e,r),P.init(e,r)});function hc(e){return nr(Er,e)}var Ar=u(\"ZodCIDRv6\",(e,r)=>{xi.init(e,r),P.init(e,r)});function $c(e){return ir(Ar,e)}var Lr=u(\"ZodBase64\",(e,r)=>{zi.init(e,r),P.init(e,r)});function _c(e){return or(Lr,e)}var Rr=u(\"ZodBase64URL\",(e,r)=>{Ii.init(e,r),P.init(e,r)});function bc(e){return ar(Rr,e)}var Cr=u(\"ZodE164\",(e,r)=>{wi.init(e,r),P.init(e,r)});function yc(e){return ur(Cr,e)}var Vr=u(\"ZodJWT\",(e,r)=>{Si.init(e,r),P.init(e,r)});function xc(e){return cr(Vr,e)}var Pa=u(\"ZodCustomStringFormat\",(e,r)=>{ji.init(e,r),P.init(e,r)});function kc(e,r,i={}){return za(Pa,e,r,i)}var Te=u(\"ZodNumber\",(e,r)=>{At.init(e,r),k.init(e,r),e.gt=(o,t)=>e.check(F(o,t)),e.gte=(o,t)=>e.check(T(o,t)),e.min=(o,t)=>e.check(T(o,t)),e.lt=(o,t)=>e.check(V(o,t)),e.lte=(o,t)=>e.check(R(o,t)),e.max=(o,t)=>e.check(R(o,t)),e.int=(o)=>e.check(kr(o)),e.safe=(o)=>e.check(kr(o)),e.positive=(o)=>e.check(F(0,o)),e.nonnegative=(o)=>e.check(T(0,o)),e.negative=(o)=>e.check(V(0,o)),e.nonpositive=(o)=>e.check(R(0,o)),e.multipleOf=(o,t)=>e.check(H(o,t)),e.step=(o,t)=>e.check(H(o,t)),e.finite=()=>e;let i=e._zod.bag;e.minValue=Math.max(i.minimum??Number.NEGATIVE_INFINITY,i.exclusiveMinimum??Number.NEGATIVE_INFINITY)??null,e.maxValue=Math.min(i.maximum??Number.POSITIVE_INFINITY,i.exclusiveMaximum??Number.POSITIVE_INFINITY)??null,e.isInt=(i.format??\"\").includes(\"int\")||Number.isSafeInteger(i.multipleOf??0.5),e.isFinite=!0,e.format=i.format??null});function Na(e){return Yo(Te,e)}var le=u(\"ZodNumberFormat\",(e,r)=>{Oi.init(e,r),Te.init(e,r)});function kr(e){return Qo(le,e)}function zc(e){return ea(le,e)}function Ic(e){return ta(le,e)}function wc(e){return ra(le,e)}function Sc(e){return na(le,e)}var Ee=u(\"ZodBoolean\",(e,r)=>{Ke.init(e,r),k.init(e,r)});function Ua(e){return ia(Ee,e)}var Ae=u(\"ZodBigInt\",(e,r)=>{Lt.init(e,r),k.init(e,r),e.gte=(o,t)=>e.check(T(o,t)),e.min=(o,t)=>e.check(T(o,t)),e.gt=(o,t)=>e.check(F(o,t)),e.gte=(o,t)=>e.check(T(o,t)),e.min=(o,t)=>e.check(T(o,t)),e.lt=(o,t)=>e.check(V(o,t)),e.lte=(o,t)=>e.check(R(o,t)),e.max=(o,t)=>e.check(R(o,t)),e.positive=(o)=>e.check(F(BigInt(0),o)),e.negative=(o)=>e.check(V(BigInt(0),o)),e.nonpositive=(o)=>e.check(R(BigInt(0),o)),e.nonnegative=(o)=>e.check(T(BigInt(0),o)),e.multipleOf=(o,t)=>e.check(H(o,t));let i=e._zod.bag;e.minValue=i.minimum??null,e.maxValue=i.maximum??null,e.format=i.format??null});function jc(e){return aa(Ae,e)}var Fr=u(\"ZodBigIntFormat\",(e,r)=>{Pi.init(e,r),Ae.init(e,r)});function Oc(e){return ca(Fr,e)}function Pc(e){return sa(Fr,e)}var Za=u(\"ZodSymbol\",(e,r)=>{Ni.init(e,r),k.init(e,r)});function Nc(e){return la(Za,e)}var Da=u(\"ZodUndefined\",(e,r)=>{Ui.init(e,r),k.init(e,r)});function Uc(e){return ma(Da,e)}var Ta=u(\"ZodNull\",(e,r)=>{Zi.init(e,r),k.init(e,r)});function Ea(e){return da(Ta,e)}var Aa=u(\"ZodAny\",(e,r)=>{Di.init(e,r),k.init(e,r)});function Zc(){return pa(Aa)}var La=u(\"ZodUnknown\",(e,r)=>{$e.init(e,r),k.init(e,r)});function st(){return be(La)}var Ra=u(\"ZodNever\",(e,r)=>{Ti.init(e,r),k.init(e,r)});function pt(e){return fa(Ra,e)}var Ca=u(\"ZodVoid\",(e,r)=>{Ei.init(e,r),k.init(e,r)});function Dc(e){return va(Ca,e)}var ft=u(\"ZodDate\",(e,r)=>{Ai.init(e,r),k.init(e,r),e.min=(o,t)=>e.check(T(o,t)),e.max=(o,t)=>e.check(R(o,t));let i=e._zod.bag;e.minDate=i.minimum?new Date(i.minimum):null,e.maxDate=i.maximum?new Date(i.maximum):null});function Tc(e){return ga(ft,e)}var Va=u(\"ZodArray\",(e,r)=>{Xe.init(e,r),k.init(e,r),e.element=r.element,e.min=(i,o)=>e.check(K(i,o)),e.nonempty=(i)=>e.check(K(1,i)),e.max=(i,o)=>e.check(ue(i,o)),e.length=(i,o)=>e.check(ce(i,o)),e.unwrap=()=>e.element});function Jr(e,r){return rt(Va,e,r)}function Ec(e){let r=e._zod.def.shape;return Ya(Object.keys(r))}var vt=u(\"ZodObject\",(e,r)=>{Li.init(e,r),k.init(e,r),w(e,\"shape\",()=>r.shape),e.keyof=()=>Xa(Object.keys(e._zod.def.shape)),e.catchall=(i)=>e.clone({...e._zod.def,catchall:i}),e.passthrough=()=>e.clone({...e._zod.def,catchall:st()}),e.loose=()=>e.clone({...e._zod.def,catchall:st()}),e.strict=()=>e.clone({...e._zod.def,catchall:pt()}),e.strip=()=>e.clone({...e._zod.def,catchall:void 0}),e.extend=(i)=>ku(e,i),e.merge=(i)=>zu(e,i),e.pick=(i)=>yu(e,i),e.omit=(i)=>xu(e,i),e.partial=(...i)=>Iu(Kr,e,i[0]),e.required=(...i)=>wu(Xr,e,i[0])});function Ac(e,r){let i={type:\"object\",get shape(){return de(this,\"shape\",{...e}),this.shape},...d(r)};return new vt(i)}function Lc(e,r){return new vt({type:\"object\",get shape(){return de(this,\"shape\",{...e}),this.shape},catchall:pt(),...d(r)})}function Rc(e,r){return new vt({type:\"object\",get shape(){return de(this,\"shape\",{...e}),this.shape},catchall:st(),...d(r)})}var Mr=u(\"ZodUnion\",(e,r)=>{Rt.init(e,r),k.init(e,r),e.options=r.options});function gt(e,r){return new Mr({type:\"union\",options:e,...d(r)})}var Fa=u(\"ZodDiscriminatedUnion\",(e,r)=>{Mr.init(e,r),Ri.init(e,r)});function Cc(e,r,i){return new Fa({type:\"union\",options:r,discriminator:e,...d(i)})}var Ja=u(\"ZodIntersection\",(e,r)=>{Ci.init(e,r),k.init(e,r)});function Ma(e,r){return new Ja({type:\"intersection\",left:e,right:r})}var Wa=u(\"ZodTuple\",(e,r)=>{oe.init(e,r),k.init(e,r),e.rest=(i)=>e.clone({...e._zod.def,rest:i})});function Vc(e,r,i){let o=r instanceof x,t=o?i:r;return new Wa({type:\"tuple\",items:e,rest:o?r:null,...d(t)})}var Wr=u(\"ZodRecord\",(e,r)=>{Vi.init(e,r),k.init(e,r),e.keyType=r.keyType,e.valueType=r.valueType});function Ga(e,r,i){return new Wr({type:\"record\",keyType:e,valueType:r,...d(i)})}function Fc(e,r,i){return new Wr({type:\"record\",keyType:gt([e,pt()]),valueType:r,...d(i)})}var Ba=u(\"ZodMap\",(e,r)=>{Fi.init(e,r),k.init(e,r),e.keyType=r.keyType,e.valueType=r.valueType});function Jc(e,r,i){return new Ba({type:\"map\",keyType:e,valueType:r,...d(i)})}var Ka=u(\"ZodSet\",(e,r)=>{Ji.init(e,r),k.init(e,r),e.min=(...i)=>e.check(Q(...i)),e.nonempty=(i)=>e.check(Q(1,i)),e.max=(...i)=>e.check(ae(...i)),e.size=(...i)=>e.check(ye(...i))});function Mc(e,r){return new Ka({type:\"set\",valueType:e,...d(r)})}var Ze=u(\"ZodEnum\",(e,r)=>{Mi.init(e,r),k.init(e,r),e.enum=r.entries,e.options=Object.values(r.entries);let i=new Set(Object.keys(r.entries));e.extract=(o,t)=>{let n={};for(let a of o)if(i.has(a))n[a]=r.entries[a];else throw Error(`Key ${a} not found in enum`);return new Ze({...r,checks:[],...d(t),entries:n})},e.exclude=(o,t)=>{let n={...r.entries};for(let a of o)if(i.has(a))delete n[a];else throw Error(`Key ${a} not found in enum`);return new Ze({...r,checks:[],...d(t),entries:n})}});function Xa(e,r){let i=Array.isArray(e)?Object.fromEntries(e.map((o)=>[o,o])):e;return new Ze({type:\"enum\",entries:i,...d(r)})}function Wc(e,r){return new Ze({type:\"enum\",entries:e,...d(r)})}var qa=u(\"ZodLiteral\",(e,r)=>{Wi.init(e,r),k.init(e,r),e.values=new Set(r.values),Object.defineProperty(e,\"value\",{get(){if(r.values.length>1)throw Error(\"This schema contains multiple valid literal values. Use `.values` instead.\");return r.values[0]}})});function Ya(e,r){return new qa({type:\"literal\",values:Array.isArray(e)?e:[e],...d(r)})}var Ha=u(\"ZodFile\",(e,r)=>{Gi.init(e,r),k.init(e,r),e.min=(i,o)=>e.check(Q(i,o)),e.max=(i,o)=>e.check(ae(i,o)),e.mime=(i,o)=>e.check(je(Array.isArray(i)?i:[i],o))});function Gc(e){return ba(Ha,e)}var Gr=u(\"ZodTransform\",(e,r)=>{qe.init(e,r),k.init(e,r),e._zod.parse=(i,o)=>{i.addIssue=(n)=>{if(typeof n===\"string\")i.issues.push(re(n,i.value,r));else{let a=n;if(a.fatal)a.continue=!1;a.code??(a.code=\"custom\"),a.input??(a.input=i.value),a.inst??(a.inst=e),a.continue??(a.continue=!0),i.issues.push(re(a))}};let t=r.transform(i.value,i);if(t instanceof Promise)return t.then((n)=>(i.value=n,i));return i.value=t,i}});function Br(e){return new Gr({type:\"transform\",transform:e})}var Kr=u(\"ZodOptional\",(e,r)=>{Bi.init(e,r),k.init(e,r),e.unwrap=()=>e._zod.def.innerType});function lt(e){return new Kr({type:\"optional\",innerType:e})}var Qa=u(\"ZodNullable\",(e,r)=>{Ki.init(e,r),k.init(e,r),e.unwrap=()=>e._zod.def.innerType});function mt(e){return new Qa({type:\"nullable\",innerType:e})}function Bc(e){return lt(mt(e))}var eu=u(\"ZodDefault\",(e,r)=>{Xi.init(e,r),k.init(e,r),e.unwrap=()=>e._zod.def.innerType,e.removeDefault=e.unwrap});function tu(e,r){return new eu({type:\"default\",innerType:e,get defaultValue(){return typeof r===\"function\"?r():r}})}var ru=u(\"ZodPrefault\",(e,r)=>{qi.init(e,r),k.init(e,r),e.unwrap=()=>e._zod.def.innerType});function nu(e,r){return new ru({type:\"prefault\",innerType:e,get defaultValue(){return typeof r===\"function\"?r():r}})}var Xr=u(\"ZodNonOptional\",(e,r)=>{Yi.init(e,r),k.init(e,r),e.unwrap=()=>e._zod.def.innerType});function iu(e,r){return new Xr({type:\"nonoptional\",innerType:e,...d(r)})}var ou=u(\"ZodSuccess\",(e,r)=>{Hi.init(e,r),k.init(e,r),e.unwrap=()=>e._zod.def.innerType});function Kc(e){return new ou({type:\"success\",innerType:e})}var au=u(\"ZodCatch\",(e,r)=>{Qi.init(e,r),k.init(e,r),e.unwrap=()=>e._zod.def.innerType,e.removeCatch=e.unwrap});function uu(e,r){return new au({type:\"catch\",innerType:e,catchValue:typeof r===\"function\"?r:()=>r})}var cu=u(\"ZodNaN\",(e,r)=>{eo.init(e,r),k.init(e,r)});function Xc(e){return $a(cu,e)}var qr=u(\"ZodPipe\",(e,r)=>{Ye.init(e,r),k.init(e,r),e.in=r.in,e.out=r.out});function dt(e,r){return new qr({type:\"pipe\",in:e,out:r})}var su=u(\"ZodReadonly\",(e,r)=>{to.init(e,r),k.init(e,r)});function lu(e){return new su({type:\"readonly\",innerType:e})}var mu=u(\"ZodTemplateLiteral\",(e,r)=>{ro.init(e,r),k.init(e,r)});function qc(e,r){return new mu({type:\"template_literal\",parts:e,...d(r)})}var du=u(\"ZodLazy\",(e,r)=>{io.init(e,r),k.init(e,r),e.unwrap=()=>e._zod.def.getter()});function pu(e){return new du({type:\"lazy\",getter:e})}var fu=u(\"ZodPromise\",(e,r)=>{no.init(e,r),k.init(e,r),e.unwrap=()=>e._zod.def.innerType});function Yc(e){return new fu({type:\"promise\",innerType:e})}var ht=u(\"ZodCustom\",(e,r)=>{oo.init(e,r),k.init(e,r)});function vu(e){let r=new N({check:\"custom\"});return r._zod.check=e,r}function Hc(e,r){return ya(ht,e??(()=>!0),r)}function gu(e,r={}){return xa(ht,e,r)}function hu(e){let r=vu((i)=>(i.addIssue=(o)=>{if(typeof o===\"string\")i.issues.push(re(o,i.value,r._zod.def));else{let t=o;if(t.fatal)t.continue=!1;t.code??(t.code=\"custom\"),t.input??(t.input=i.value),t.inst??(t.inst=r),t.continue??(t.continue=!r._zod.def.abort),i.issues.push(re(t))}},e(i.value,i)));return r}function Qc(e,r={error:`Input not instance of ${e.name}`}){let i=new ht({type:\"custom\",check:\"custom\",fn:(o)=>o instanceof e,abort:!0,...d(r)});return i._zod.bag.Class=e,i}var es=(...e)=>ka({Pipe:qr,Boolean:Ee,String:De,Transform:Gr},...e);function ts(e){let r=pu(()=>gt([xr(e),Na(),Ua(),Ea(),Jr(r),Ga(xr(),r)]));return r}function rs(e,r){return dt(Br(e),r)}var ns={invalid_type:\"invalid_type\",too_big:\"too_big\",too_small:\"too_small\",invalid_format:\"invalid_format\",not_multiple_of:\"not_multiple_of\",unrecognized_keys:\"unrecognized_keys\",invalid_union:\"invalid_union\",invalid_key:\"invalid_key\",invalid_element:\"invalid_element\",invalid_value:\"invalid_value\",custom:\"custom\"};function is(e){Z({customError:e})}function os(){return Z().customError}function Jl(e){return Go(De,e)}function Ml(e){return Ho(Te,e)}function Wl(e){return oa(Ee,e)}function Gl(e){return ua(Ae,e)}function Bl(e){return ha(ft,e)}Z(He());var Kl=$t;globalThis.z=$u;})();\n";

// src/preset-scripts/rpc.ts
var TIMEOUT_MS4 = 1e4;
var counter4 = 0;
function presetRpc(ctx, op, args = {}) {
  const requestId = `vishrun-ps-${Date.now()}-${++counter4}`;
  return new Promise((resolve, reject) => {
    let unsub = null;
    const timer = setTimeout(() => {
      unsub?.();
      reject(new Error(`[vishrun] preset ${op} timed out`));
    }, TIMEOUT_MS4);
    unsub = ctx.onBackendMessage((payload) => {
      const p = payload;
      if (!p || p.type !== "vr_preset_response" || p.requestId !== requestId)
        return;
      clearTimeout(timer);
      unsub?.();
      if (p.error)
        reject(new Error(p.error));
      else
        resolve(p.result);
    });
    ctx.sendToBackend({ type: "vr_preset", requestId, op, args });
  });
}

// src/preset-scripts/st-dom-alias.ts
var ROW_SELECTOR = "[data-message-id][data-message-index]";
var TEXT_SELECTORS = ['[class*="_prose_"]', '[class*="_content_"]'];
var MARK = "data-vishrun-st-alias";
function isTopRow(el) {
  return !el.parentElement?.closest(ROW_SELECTOR);
}
function applyStAlias(doc = document) {
  const rows = [...doc.querySelectorAll(ROW_SELECTOR)].filter(isTopRow);
  if (rows.length === 0)
    return rows;
  const list = rows[0].parentElement;
  if (list && !list.id && !doc.getElementById("chat")) {
    list.id = "chat";
    list.setAttribute(MARK, "");
  }
  for (const row of rows) {
    if (!row.classList.contains("mes"))
      row.classList.add("mes");
    const idx = row.getAttribute("data-message-index") ?? "";
    if (row.getAttribute("mesid") !== idx)
      row.setAttribute("mesid", idx);
    if (!row.querySelector(".mes_text")) {
      for (const sel of TEXT_SELECTORS) {
        const text = row.querySelector(sel);
        if (text) {
          text.classList.add("mes_text");
          break;
        }
      }
    }
  }
  return rows;
}
function clearStAlias(doc = document) {
  const list = doc.querySelector(`#chat[${MARK}]`);
  if (list) {
    list.removeAttribute("id");
    list.removeAttribute(MARK);
  }
  for (const row of doc.querySelectorAll(`${ROW_SELECTOR}.mes`)) {
    row.classList.remove("mes");
    row.removeAttribute("mesid");
  }
  for (const el of doc.querySelectorAll(".mes_text"))
    el.classList.remove("mes_text");
}
function watchStAlias(doc = document, onRows) {
  let scheduled = false;
  const run = () => {
    scheduled = false;
    const rows = applyStAlias(doc);
    if (onRows && rows.length)
      onRows(rows);
  };
  const observer = new MutationObserver(() => {
    if (scheduled)
      return;
    scheduled = true;
    requestAnimationFrame(run);
  });
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-message-index"] });
  run();
  return () => {
    observer.disconnect();
    clearStAlias(doc);
  };
}

// src/preset-scripts/st-ids.ts
var ST_IDENTIFIER_TO_MARKER = {
  chatHistory: "chat_history",
  worldInfoBefore: "world_info_before",
  worldInfoAfter: "world_info_after",
  charDescription: "char_description",
  charPersonality: "char_personality",
  personaDescription: "persona_description",
  scenario: "scenario",
  dialogueExamples: "dialogue_examples",
  main: "main_prompt",
  enhanceDefinitions: "enhance_definitions",
  jailbreak: "jailbreak",
  nsfw: "nsfw_prompt"
};
function stPromptSequence(preset) {
  const data = preset ?? {};
  const prompts = Array.isArray(data.prompts) ? data.prompts : [];
  const byId = new Map;
  for (const p of prompts)
    if (typeof p?.identifier === "string")
      byId.set(p.identifier, p);
  const order = [];
  const po = data.prompt_order;
  if (po && typeof po === "object") {
    const keys = Object.keys(po).filter((k) => po[k]?.order?.length).sort((a, b) => Number(b) - Number(a));
    if (keys.length) {
      for (const e of po[keys[0]].order)
        if (typeof e?.identifier === "string")
          order.push(e.identifier);
    }
  }
  const out = [];
  const seen = new Set;
  for (const id of order) {
    const p = byId.get(id);
    if (!p || seen.has(id))
      continue;
    seen.add(id);
    out.push(p);
  }
  for (const p of prompts) {
    const id = typeof p?.identifier === "string" ? p.identifier : "";
    if (id && seen.has(id))
      continue;
    if (id)
      seen.add(id);
    out.push(p);
  }
  return out;
}
var str = (v) => typeof v === "string" ? v : "";
function matchStIds(preset, blocks) {
  const sequence = stPromptSequence(preset);
  const used = new Set;
  const map = {};
  const unmatched = [];
  const firstUnused = (pred, from = 0) => {
    for (let i = from;i < blocks.length; i++)
      if (!used.has(i) && pred(blocks[i]))
        return i;
    for (let i = 0;i < from && i < blocks.length; i++)
      if (!used.has(i) && pred(blocks[i]))
        return i;
    return -1;
  };
  let cursor = 0;
  for (const p of sequence) {
    const id = str(p.identifier);
    if (!id)
      continue;
    const name = str(p.name);
    const content = str(p.content);
    const marker = ST_IDENTIFIER_TO_MARKER[id];
    let idx = marker ? firstUnused((b) => b.marker === marker, cursor) : firstUnused((b) => !isSystemMarker(b) && (b.name ?? "") === name && (b.content ?? "") === content, cursor);
    if (idx < 0 && !marker)
      idx = firstUnused((b) => !isSystemMarker(b) && (b.name ?? "") === name, cursor);
    if (idx < 0 && !marker && content) {
      const hits = blocks.map((b, i) => i).filter((i) => !used.has(i) && blocks[i].content === content);
      if (hits.length === 1)
        idx = hits[0];
    }
    if (idx < 0) {
      unmatched.push(name || id);
      continue;
    }
    used.add(idx);
    map[blocks[idx].id] = id;
    cursor = idx + 1;
  }
  return { map, total: sequence.length, unmatched };
}
function isSystemMarker(b) {
  return !!b.marker && b.marker !== "category";
}
var MARKER_TO_ST_IDENTIFIER = Object.fromEntries(Object.entries(ST_IDENTIFIER_TO_MARKER).map(([id, marker]) => [marker, id]));
function stIdOf(block, links) {
  return links[block.id] ?? (block.marker ? MARKER_TO_ST_IDENTIFIER[block.marker] : undefined) ?? block.id;
}

// src/preset-scripts/dialogs.ts
function overlay(doc) {
  const root = doc.createElement("div");
  root.setAttribute("data-vishrun-dialog", "");
  root.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px";
  const box = doc.createElement("div");
  box.style.cssText = "background:var(--lumiverse-bg-elevated,#1e1b26);color:var(--lumiverse-text,#eee);border:1px solid rgba(255,255,255,.15);border-radius:12px;padding:16px;max-width:min(640px,100%);max-height:80vh;overflow:auto;width:100%;box-sizing:border-box;font:14px/1.5 system-ui,sans-serif";
  root.appendChild(box);
  doc.body.appendChild(root);
  return { root, box, close: () => root.remove() };
}
function button(doc, label, primary) {
  const b = doc.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.style.cssText = `padding:6px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.2);cursor:pointer;color:inherit;background:${primary ? "rgba(140,110,220,.6)" : "transparent"}`;
  return b;
}
function inputDialog(prompt, ok = "OK", cancel = "Cancel", doc = document) {
  return new Promise((resolve) => {
    const { box, close } = overlay(doc);
    const p = doc.createElement("div");
    p.style.whiteSpace = "pre-wrap";
    p.textContent = prompt;
    const ta = doc.createElement("textarea");
    ta.rows = 4;
    ta.style.cssText = "width:100%;box-sizing:border-box;margin:10px 0;background:rgba(0,0,0,.3);color:inherit;border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:8px";
    const row = doc.createElement("div");
    row.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
    const bOk = button(doc, ok, true);
    const bCancel = button(doc, cancel, false);
    row.append(bCancel, bOk);
    box.append(p, ta, row);
    const done = (v) => {
      close();
      resolve(v);
    };
    bOk.onclick = () => done(ta.value);
    bCancel.onclick = () => done("");
    ta.focus();
  });
}
function popupDialog(text, doc = document) {
  return new Promise((resolve) => {
    const { box, close } = overlay(doc);
    const p = doc.createElement("div");
    p.style.whiteSpace = "pre-wrap";
    p.textContent = text;
    const row = doc.createElement("div");
    row.style.cssText = "display:flex;justify-content:flex-end;margin-top:12px";
    const bOk = button(doc, "OK", true);
    row.append(bOk);
    box.append(p, row);
    bOk.onclick = () => {
      close();
      resolve("");
    };
  });
}
function splitNamedArgs(rest) {
  const named = {};
  let s = rest;
  for (;; ) {
    const m = /^\s*([A-Za-z_][\w]*)=(?:"((?:[^"\\]|\\.)*)"|(\S+))/.exec(s);
    if (!m)
      break;
    named[m[1]] = m[2] !== undefined ? m[2].replace(/\\"/g, '"') : m[3];
    s = s.slice(m[0].length);
  }
  return { named, text: s.trim() };
}

// src/preset-scripts/th-api.ts
var TAVERN_EVENTS = {
  APP_READY: "app_ready",
  CHAT_CHANGED: "chat_id_changed",
  SETTINGS_UPDATED: "settings_updated",
  EXTENSION_SETTINGS_LOADED: "extension_settings_loaded",
  CHATCOMPLETION_SOURCE_CHANGED: "chatcompletion_source_changed",
  CHATCOMPLETION_MODEL_CHANGED: "chatcompletion_model_changed",
  CONNECTION_PROFILE_LOADED: "connection_profile_loaded",
  CONNECTION_PROFILE_UPDATED: "connection_profile_updated",
  MAIN_API_CHANGED: "main_api_changed",
  OAI_PRESET_CHANGED_AFTER: "oai_preset_changed_after",
  PRESET_CHANGED: "preset_changed",
  MESSAGE_SENT: "message_sent",
  MESSAGE_RECEIVED: "message_received",
  MESSAGE_EDITED: "message_edited",
  MESSAGE_DELETED: "message_deleted",
  MESSAGE_SWIPED: "message_swiped",
  MESSAGE_UPDATED: "message_updated",
  CHARACTER_MESSAGE_RENDERED: "character_message_rendered",
  USER_MESSAGE_RENDERED: "user_message_rendered",
  GENERATION_STARTED: "generation_started",
  GENERATION_ENDED: "generation_ended",
  GENERATION_STOPPED: "generation_stopped",
  STREAM_TOKEN_RECEIVED: "stream_token_received"
};
function emit(state, event, ...args) {
  const set = state.listeners.get(event);
  if (!set)
    return;
  for (const fn of [...set]) {
    try {
      Promise.resolve(fn(...args)).catch((e) => console.warn("[vishrun] preset script listener", e));
    } catch (e) {
      console.warn("[vishrun] preset script listener", e);
    }
  }
}
async function refreshPreset(state) {
  const chatId = state.ctx.getActiveChat().chatId;
  state.preset = await presetRpc(state.ctx, "get_preset", { chatId, presetId: state.presetId });
}
async function refreshVars(state) {
  const chatId = state.ctx.getActiveChat().chatId;
  const [global, chat] = await Promise.all([
    presetRpc(state.ctx, "vars_get", { scope: "global" }),
    chatId ? presetRpc(state.ctx, "vars_get", { scope: "chat", chatId }) : Promise.resolve({})
  ]);
  state.vars = { global, chat };
}
async function refreshCharacter(state) {
  const id = state.ctx.getActiveChat().characterId;
  state.character = id ? await getCharacter(id).catch(() => null) : null;
}
async function refreshMessages(state) {
  const chatId = state.ctx.getActiveChat().chatId;
  state.messages = chatId ? await getChatMessages(chatId).catch(() => []) : [];
}
function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (isPlainObject(v) && isPlainObject(target[k]))
      deepMerge(target[k], v);
    else
      target[k] = v;
  }
  return target;
}
function toStPreset(p, stIds) {
  return {
    settings: { ...p.parameters },
    prompts: p.blocks.map((b) => ({
      ...b,
      id: stIdOf(b, stIds),
      name: b.name ?? "",
      enabled: b.enabled,
      role: b.role ?? "system",
      content: b.content ?? "",
      position: { type: "relative" }
    })),
    prompts_unused: [],
    extensions: { ...p.metadata }
  };
}
function buildThApi(state, script, win) {
  const ctx = state.ctx;
  const clone = (v) => v === undefined ? v : win.JSON.parse(JSON.stringify(v));
  const scriptVarsKey = `vishrun:preset-script-vars:${state.presetId}:${script.id}`;
  const readScriptVars = () => {
    try {
      const raw = localStorage.getItem(scriptVarsKey);
      if (raw)
        return JSON.parse(raw);
    } catch {}
    return { ...script.data };
  };
  const scopeOf = (opt) => isPlainObject(opt) && typeof opt.type === "string" ? opt.type : "chat";
  const getVars = (opt) => {
    const type = scopeOf(opt);
    if (type === "global")
      return state.vars.global;
    if (type === "script")
      return readScriptVars();
    if (type === "chat")
      return state.vars.chat;
    return {};
  };
  const setVars = (vars, opt) => {
    const type = scopeOf(opt);
    const copy = JSON.parse(JSON.stringify(vars ?? {}));
    if (type === "script") {
      try {
        localStorage.setItem(scriptVarsKey, JSON.stringify(copy));
      } catch {}
      return;
    }
    if (type !== "global" && type !== "chat")
      return;
    state.vars[type] = copy;
    const chatId = ctx.getActiveChat().chatId;
    presetRpc(ctx, "vars_replace", { scope: type, chatId, vars: copy }).catch((e) => console.warn("[vishrun] preset script vars write", e));
  };
  const loadedName = () => state.presetName;
  const isActiveName = (name) => name === undefined || name === "in_use" || name === state.presetName;
  const getPreset = (name) => isActiveName(name) && state.preset ? clone(toStPreset(state.preset, state.stIds)) : null;
  const applyPreset = async (next) => {
    if (!state.preset || !isPlainObject(next) || !Array.isArray(next.prompts))
      return;
    const current = new Map(state.preset.blocks.map((b) => [b.id, b.enabled]));
    const blockOf = new Map(state.preset.blocks.map((b) => [stIdOf(b, state.stIds), b.id]));
    const changes = {};
    for (const p of next.prompts) {
      const raw = String(p?.id ?? "");
      const id = blockOf.get(raw) ?? raw;
      if (!current.has(id))
        continue;
      const enabled = p.enabled !== false;
      if (current.get(id) !== enabled)
        changes[id] = enabled;
    }
    if (Object.keys(changes).length === 0)
      return;
    for (const b of state.preset.blocks)
      if (b.id in changes)
        b.enabled = changes[b.id];
    await presetRpc(ctx, "set_block_states", { presetId: state.presetId, states: changes });
    await refreshPreset(state).catch(() => {});
  };
  const updatePresetWith = async (name, fn) => {
    if (!isActiveName(name) || !state.preset)
      return null;
    const draft = clone(toStPreset(state.preset, state.stIds));
    const result = await fn(draft) ?? draft;
    await applyPreset(result);
    return getPreset();
  };
  const setPreset = async (name, preset) => {
    if (isActiveName(name))
      await applyPreset(preset);
  };
  const lastMessageId = () => state.messages.length - 1;
  const resolveRange = (range) => {
    const last = lastMessageId();
    const norm = (n) => n < 0 ? last + 1 + n : n;
    if (typeof range === "number")
      return [norm(range), norm(range)];
    const s = String(range ?? `0-${last}`).replace(/\{\{lastMessageId\}\}/g, String(last));
    const m = /^\s*(-?\d+)\s*(?:-\s*(-?\d+))?\s*$/.exec(s);
    if (!m)
      return [0, last];
    const a = norm(Number(m[1]));
    const b = m[2] !== undefined ? norm(Number(m[2])) : a;
    return [Math.min(a, b), Math.max(a, b)];
  };
  const getChatMessages = (range, opt) => {
    const [a, b] = resolveRange(range);
    const role = isPlainObject(opt) && typeof opt.role === "string" ? opt.role : "all";
    const out = [];
    for (let i = a;i <= b && i < state.messages.length; i++) {
      const m = state.messages[i];
      if (!m)
        continue;
      const r = m.is_user ? "user" : m.role === "system" ? "system" : "assistant";
      if (role !== "all" && role !== r)
        continue;
      out.push({ message_id: i, name: m.name ?? "", role: r, is_hidden: m.hidden === true, message: m.content, data: {}, extra: {} });
    }
    return clone(out);
  };
  const triggerSlash = async (command) => {
    let pipe = "";
    for (const step of splitPipeline(String(command ?? ""))) {
      const parsed = parseSlash(step);
      if (!parsed)
        continue;
      const rest = parsed.rest.replace(/\{\{pipe\}\}/g, pipe);
      switch (parsed.name) {
        case "send":
        case "setinput":
          setComposerText(rest);
          pipe = rest;
          break;
        case "trigger":
          await clickSend();
          break;
        case "input": {
          const { named, text } = splitNamedArgs(rest);
          pipe = await inputDialog(text, named.okButton, named.cancelButton);
          break;
        }
        case "popup": {
          const { text } = splitNamedArgs(rest);
          pipe = await popupDialog(text);
          break;
        }
        case "echo":
          presetRpc(ctx, "toast", { kind: "info", message: rest });
          pipe = rest;
          break;
        default:
          console.warn("[vishrun] preset script: unsupported slash command", parsed.name);
      }
    }
    return pipe;
  };
  const toast = (kind) => (message, title) => {
    presetRpc(ctx, "toast", { kind, message: String(message ?? ""), title: typeof title === "string" ? title : undefined }).catch(() => {});
  };
  const on = (event, fn, once = false) => {
    let set = state.listeners.get(event);
    if (!set)
      state.listeners.set(event, set = new Set);
    const wrapped = once ? (...a) => {
      set.delete(wrapped);
      return fn(...a);
    } : fn;
    set.add(wrapped);
    const stop = () => {
      set.delete(wrapped);
    };
    return Object.assign(stop, { stop });
  };
  const buttonEvent = (name) => `vishrun_button:${script.id}:${String(name)}`;
  const normButtons = (list) => Array.isArray(list) ? list.map((b) => typeof b === "string" ? { name: b, visible: true } : { name: String(b?.name ?? ""), visible: b?.visible !== false }).filter((b) => b.name) : [];
  const buttonsArg = (a, b) => normButtons(Array.isArray(a) ? a : b);
  const api = {
    getVariables: (opt) => clone(getVars(opt)),
    getAllVariables: () => clone({ ...state.vars.global, ...state.vars.chat }),
    replaceVariables: (vars, opt) => setVars(vars, opt),
    updateVariablesWith: (fn, opt) => {
      const draft = JSON.parse(JSON.stringify(getVars(opt)));
      const next = fn(draft) ?? draft;
      setVars(next, opt);
      return clone(next);
    },
    insertOrAssignVariables: (vars, opt) => {
      const next = deepMerge(JSON.parse(JSON.stringify(getVars(opt))), JSON.parse(JSON.stringify(vars ?? {})));
      setVars(next, opt);
      return clone(next);
    },
    insertVariables: (vars, opt) => {
      const next = deepMerge(JSON.parse(JSON.stringify(vars ?? {})), JSON.parse(JSON.stringify(getVars(opt))));
      setVars(next, opt);
      return clone(next);
    },
    deleteVariable: (path, opt) => {
      const next = JSON.parse(JSON.stringify(getVars(opt)));
      const had = path in next;
      delete next[path];
      setVars(next, opt);
      return { variables: clone(next), delete_occurred: had };
    },
    getPreset,
    getPresetNames: () => [state.presetName],
    getLoadedPresetName: loadedName,
    loadPreset: (name) => isActiveName(name),
    updatePresetWith,
    setPreset,
    replacePreset: setPreset,
    getChatMessages,
    setChatMessages: async (msgs) => {
      if (!Array.isArray(msgs))
        return;
      const chatId = ctx.getActiveChat().chatId;
      if (!chatId)
        return;
      const hide = [];
      const show = [];
      for (const m of msgs) {
        if (!isPlainObject(m))
          continue;
        const target = state.messages[Number(m.message_id)];
        if (!target)
          continue;
        if (typeof m.is_hidden === "boolean" && m.is_hidden !== (target.hidden === true))
          (m.is_hidden ? hide : show).push(target.id);
        if (typeof m.message === "string" && m.message !== target.content)
          await updateMessageContent(chatId, target.id, m.message);
      }
      if (hide.length)
        await presetRpc(ctx, "set_hidden", { chatId, messageIds: hide, hidden: true });
      if (show.length)
        await presetRpc(ctx, "set_hidden", { chatId, messageIds: show, hidden: false });
      await refreshMessages(state);
    },
    getLastMessageId: lastMessageId,
    retrieveDisplayedMessage: (id) => {
      const $ = win.$;
      return $(`#chat > .mes[mesid="${Number(id)}"] .mes_text`);
    },
    getCharData: (name) => {
      const c = state.character;
      if (!c || name !== undefined && name !== "current" && name !== c.name)
        return null;
      return clone({ ...c, avatar: c.avatar ?? c.image_id ?? c.id, data: c });
    },
    getCurrentMessageId: lastMessageId,
    getScriptId: () => script.id,
    getButtonEvent: buttonEvent,
    getScriptButtons: () => clone(state.getButtons(script.id)),
    replaceScriptButtons: (a, b) => state.setButtons(script.id, buttonsArg(a, b)),
    appendInexistentScriptButtons: (a, b) => {
      const cur = state.getButtons(script.id);
      const add = buttonsArg(a, b).filter((x) => !cur.some((c) => c.name === x.name));
      state.setButtons(script.id, [...cur, ...add]);
    },
    updateScriptButtonsWith: (a, b) => {
      const fn = typeof a === "function" ? a : b;
      const next = normButtons(fn(clone(state.getButtons(script.id))) ?? state.getButtons(script.id));
      state.setButtons(script.id, next);
      return clone(next);
    },
    triggerSlash,
    triggerSlashWithResult: triggerSlash,
    eventOn: (event, fn) => on(event, fn),
    eventOnce: (event, fn) => on(event, fn, true),
    eventMakeFirst: (event, fn) => on(event, fn),
    eventMakeLast: (event, fn) => on(event, fn),
    eventOnButton: (name, fn) => on(buttonEvent(name), fn),
    eventEmit: async (event, ...args) => emit(state, event, ...args),
    eventRemoveListener: (event, fn) => {
      state.listeners.get(event)?.delete(fn);
    },
    eventClearEvent: (event) => {
      state.listeners.delete(event);
    },
    tavern_events: { ...TAVERN_EVENTS },
    iframe_events: {},
    errorCatched: (fn) => fn,
    waitGlobalInitialized: async () => {
      return;
    },
    substitudeMacros: (text) => String(text ?? ""),
    getTavernHelperVersion: () => "4.0.0",
    toastr: {
      success: toast("success"),
      info: toast("info"),
      warning: toast("warning"),
      error: toast("error"),
      clear: () => {},
      remove: () => {}
    }
  };
  const stContext = () => ({
    chatId: ctx.getActiveChat().chatId,
    characterId: undefined,
    characters: [],
    chat: [],
    chatCompletionSettings: undefined,
    mainApi: undefined,
    getPresetManager: () => {
      return;
    },
    saveSettingsDebounced: () => {},
    eventSource: { on: (e, fn) => on(e, fn), emit: async () => {} },
    event_types: { ...TAVERN_EVENTS }
  });
  api.SillyTavern = {
    getContext: stContext,
    characters: [],
    characterId: undefined,
    chatCompletionSettings: undefined,
    mainApi: undefined,
    getPresetManager: () => {
      return;
    },
    getChatCompletionModel: () => "",
    saveSettingsDebounced: () => {}
  };
  api.TavernHelper = { ...api };
  return api;
}

// src/preset-scripts/runner.ts
var FRAME_ATTR = "data-vishrun-preset-script";
function jqueryForParent(source) {
  return `(function(){var p=window.parent;var had$=Object.prototype.hasOwnProperty.call(p,'$'),old$=p.$;` + `var hadJ=Object.prototype.hasOwnProperty.call(p,'jQuery'),oldJ=p.jQuery;` + `(function(window){${source}
}).call(p,p);` + `var jq=p.jQuery;` + `if(had$)p.$=old$;else delete p.$;if(hadJ)p.jQuery=oldJ;else delete p.jQuery;` + `window.$=window.jQuery=jq;})();`;
}
function addScript(doc, code, module = false) {
  const el = doc.createElement("script");
  if (module)
    el.type = "module";
  el.textContent = code;
  doc.head.appendChild(el);
}
var FA_URL = "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css";
function ensureFontAwesome() {
  if (document.querySelector('link[href*="fontawesome"], link[href*="font-awesome"]'))
    return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = FA_URL;
  document.head.appendChild(link);
}
function startFrame(state, script) {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute(FRAME_ATTR, script.name);
    frame.style.cssText = "display:none";
    frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
    frame.addEventListener("load", () => {
      const win = frame.contentWindow;
      const doc = frame.contentDocument;
      if (!win || !doc)
        return resolve(frame);
      addScript(doc, jqueryForParent(jquery_3_5_1_min_default));
      addScript(doc, lodash_4_18_1_min_default);
      if (/(?<![\w$.])z(?![\w$])/.test(script.content))
        addScript(doc, zod_3_25_76_v4_min_js_default);
      const api = buildThApi(state, script, win);
      for (const [k, v] of Object.entries(api))
        win[k] = v;
      const timer = setTimeout(() => resolve(frame), 5000);
      win.__vishrunScriptDone = () => {
        clearTimeout(timer);
        resolve(frame);
      };
      addScript(doc, `${script.content}
;window.__vishrunScriptDone?.();`, /\bimport\b|\bexport\b/.test(script.content));
    }, { once: true });
    document.body.appendChild(frame);
  });
}
function installPresetScripts(ctx) {
  let running = null;
  let syncing = null;
  let again = false;
  let lastChatId = ctx.getActiveChat().chatId;
  const declined = new Set;
  const stop = () => {
    if (!running)
      return;
    for (const f of running.frames)
      f.remove();
    for (const a of running.actions.values())
      a.destroy();
    running.stopAlias();
    running.state.listeners.clear();
    running = null;
  };
  const makeState = (info) => {
    const buttons = new Map;
    const actions = new Map;
    const state = {
      ctx,
      presetId: info.presetId,
      presetName: info.presetName,
      preset: null,
      stIds: info.stIds ?? {},
      vars: { global: {}, chat: {} },
      messages: [],
      character: null,
      listeners: new Map,
      getButtons: (id) => buttons.get(id) ?? [],
      setButtons: (scriptId, list) => {
        buttons.set(scriptId, list);
        const wanted = new Set(list.filter((b) => b.visible).map((b) => `${scriptId}:${b.name}`));
        for (const [key, handle] of actions) {
          if (key.startsWith(`${scriptId}:`) && !wanted.has(key)) {
            handle.destroy();
            actions.delete(key);
          }
        }
        for (const b of list) {
          const key = `${scriptId}:${b.name}`;
          if (!b.visible || actions.has(key))
            continue;
          const handle = ctx.ui.registerInputBarAction({ id: `ps-${actions.size}-${Date.now()}`, label: b.name });
          handle.onClick(() => emit(state, `vishrun_button:${scriptId}:${b.name}`));
          actions.set(key, handle);
        }
      }
    };
    for (const s of info.scripts)
      state.setButtons(s.id, s.buttons);
    return { state, actions };
  };
  const linkStIds = async (info, state) => {
    const res = await ctx.ui.showConfirm({
      title: "Link the original preset file?",
      message: `Some scripts in "${info.presetName}" refer to entries by their SillyTavern IDs, which Lumiverse does not keep on import. ` + "Pick the original SillyTavern preset file (.json) once so quick switches can find their entries.",
      confirmLabel: "Pick file",
      cancelLabel: "Skip"
    });
    if (!res.confirmed) {
      await presetRpc(ctx, "set_st_ids", { presetId: info.presetId, declined: true }).catch(() => {});
      return;
    }
    const toast = (kind, message) => void presetRpc(ctx, "toast", { kind, message }).catch(() => {});
    try {
      const [file] = await ctx.uploads.pickFile({ accept: [".json", "application/json"], multiple: false });
      if (!file || !state.preset)
        return;
      const json = JSON.parse(new TextDecoder().decode(file.bytes));
      const result = matchStIds(json, state.preset.blocks);
      const matched = Object.keys(result.map).length;
      if (matched < Math.ceil(state.preset.blocks.length / 2)) {
        toast("error", `This file does not look like the same preset (${matched} of ${state.preset.blocks.length} entries matched).`);
        return;
      }
      await presetRpc(ctx, "set_st_ids", { presetId: info.presetId, map: result.map });
      state.stIds = result.map;
      toast("success", `Linked ${matched} of ${state.preset.blocks.length} entries to the original file.`);
    } catch (e) {
      toast("error", `Could not read the preset file: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const syncOnce = async () => {
    const chatId = ctx.getActiveChat().chatId;
    const info = await presetRpc(ctx, "active_scripts", { chatId }).catch((e) => {
      console.warn("[vishrun] preset scripts:", e);
      return;
    });
    if (info === undefined)
      return;
    const chatChanged = chatId !== lastChatId;
    lastChatId = chatId;
    if (running && info && running.presetId === info.presetId) {
      if (chatChanged) {
        await Promise.all([refreshVars(running.state), refreshMessages(running.state), refreshPreset(running.state), refreshCharacter(running.state)]).catch(() => {});
        emit(running.state, TAVERN_EVENTS.CHAT_CHANGED, chatId);
      }
      return;
    }
    stop();
    if (!info || info.scripts.length === 0 || declined.has(info.presetId))
      return;
    let allowed = info.consent;
    if (allowed === null) {
      const names = info.scripts.map((s) => `• ${s.name}`).join(`
`);
      const res = await ctx.ui.showConfirm({
        title: "Run preset scripts?",
        message: `The preset "${info.presetName}" includes scripts:
${names}

They can change this preset and the page. Run them?`,
        confirmLabel: "Run",
        cancelLabel: "Not now"
      });
      allowed = res.confirmed;
      if (allowed)
        await presetRpc(ctx, "set_consent", { presetId: info.presetId, allowed: true }).catch(() => {});
    }
    if (!allowed) {
      declined.add(info.presetId);
      return;
    }
    const { state, actions } = makeState(info);
    await Promise.all([refreshPreset(state), refreshVars(state), refreshMessages(state), refreshCharacter(state)]).catch((e) => {
      console.warn("[vishrun] preset scripts: initial load", e);
    });
    if (info.stIdsNeeded)
      await linkStIds(info, state);
    ensureFontAwesome();
    const frames = [];
    const seen = new WeakMap;
    const onRows = (rows) => {
      const fresh = [];
      for (const row of rows) {
        const idx = Number(row.getAttribute("data-message-index"));
        const msg = state.messages[idx];
        const key = `${row.getAttribute("data-message-id")}:${msg?.content.length ?? -1}`;
        if (seen.get(row) === key)
          continue;
        seen.set(row, key);
        fresh.push(row);
      }
      if (fresh.length === 0)
        return;
      const needsRefresh = fresh.some((r) => !state.messages[Number(r.getAttribute("data-message-index"))]);
      (needsRefresh ? refreshMessages(state) : Promise.resolve()).then(() => {
        for (const row of fresh) {
          const idx = Number(row.getAttribute("data-message-index"));
          const msg = state.messages[idx];
          if (!msg)
            continue;
          seen.set(row, `${row.getAttribute("data-message-id")}:${msg.content.length}`);
          emit(state, msg.is_user ? TAVERN_EVENTS.USER_MESSAGE_RENDERED : TAVERN_EVENTS.CHARACTER_MESSAGE_RENDERED, idx);
        }
      });
    };
    running = { presetId: info.presetId, state, frames, actions, stopAlias: () => {} };
    for (const s of info.scripts)
      frames.push(await startFrame(state, s));
    running.stopAlias = watchStAlias(document, onRows);
    return;
  };
  const sync = () => {
    if (syncing) {
      again = true;
      return;
    }
    syncing = syncOnce().finally(() => {
      syncing = null;
      if (again) {
        again = false;
        sync();
      }
    });
  };
  const forward = (lumiEvent, stEvent, refresh) => ctx.events.on(lumiEvent, (payload) => {
    if (!running)
      return;
    const st = running.state;
    (refresh ? refreshMessages(st) : Promise.resolve()).then(() => {
      const id = payload?.message?.index_in_chat;
      emit(st, stEvent, typeof id === "number" ? id : st.messages.length - 1);
    });
  });
  const unsubs = [
    ctx.events.on("SETTINGS_UPDATED", (payload) => {
      const p = payload || {};
      const keys = Array.isArray(p.keys) ? p.keys : [p.key];
      if (keys.some((k) => k === "activeChatId" || k === "activeLoomPresetId" || k === "activeCharacterId"))
        sync();
      if (running)
        emit(running.state, TAVERN_EVENTS.SETTINGS_UPDATED);
    }),
    ctx.events.on("PRESET_CHANGED", () => {
      if (!running)
        return sync();
      const st = running.state;
      refreshPreset(st).then(() => emit(st, TAVERN_EVENTS.PRESET_CHANGED)).catch(() => {});
      sync();
    }),
    ctx.events.on("CHAT_SWITCHED", () => sync()),
    forward("MESSAGE_SENT", TAVERN_EVENTS.MESSAGE_SENT, true),
    forward("MESSAGE_EDITED", TAVERN_EVENTS.MESSAGE_EDITED, true),
    forward("MESSAGE_EDITED", TAVERN_EVENTS.MESSAGE_UPDATED, false),
    forward("MESSAGE_DELETED", TAVERN_EVENTS.MESSAGE_DELETED, true),
    forward("MESSAGE_SWIPED", TAVERN_EVENTS.MESSAGE_SWIPED, true),
    forward("GENERATION_ENDED", TAVERN_EVENTS.MESSAGE_RECEIVED, true),
    forward("GENERATION_STARTED", TAVERN_EVENTS.GENERATION_STARTED, false),
    forward("GENERATION_ENDED", TAVERN_EVENTS.GENERATION_ENDED, false),
    forward("GENERATION_STOPPED", TAVERN_EVENTS.GENERATION_STOPPED, true)
  ];
  sync();
  return () => {
    for (const u of unsubs)
      u();
    stop();
  };
}

// src/frontend.ts
function touchesActiveChat(payload) {
  const p = payload || {};
  const keys = Array.isArray(p.keys) ? p.keys : [p.key];
  return keys.some((k) => k === "activeChatId" || k === "activeCharacterId");
}
function setup(ctx) {
  setHostContext(ctx);
  const hooks = installMessageHooks(ctx);
  const unsubMvuDisplayStrip = registerMvuDisplayStrip(ctx);
  const unsubStatusBarInject = installStatusBarInjectHook(ctx);
  const disposePresetScripts = installPresetScripts(ctx);
  let inflightCharacterId = null;
  let lastLoadedCharacterId = null;
  async function loadFor(characterId) {
    if (!characterId) {
      clearActiveCard();
      lastLoadedCharacterId = null;
      hooks.rescanAll();
      return;
    }
    if (inflightCharacterId === characterId)
      return;
    if (lastLoadedCharacterId === characterId && getActiveCard()?.characterId === characterId) {
      hooks.rescanAll();
      return;
    }
    inflightCharacterId = characterId;
    try {
      const char = await fetchCharacter(characterId);
      const scripts = extractRegexScripts(char);
      const name = char.name ?? null;
      if (scripts.length === 0) {
        clearActiveCard();
        lastLoadedCharacterId = characterId;
        hooks.rescanAll();
        return;
      }
      const firstMes = typeof char.first_mes === "string" ? char.first_mes : null;
      const alternateGreetings = Array.isArray(char.alternate_greetings) ? char.alternate_greetings.filter((g) => typeof g === "string") : [];
      const nativeNow = knownNativeKeys(characterId);
      setActiveCard({
        characterId,
        characterName: name,
        scripts,
        firstMes,
        alternateGreetings,
        ...nativeNow ? { nativeKeys: new Set(nativeNow) } : {}
      });
      lastLoadedCharacterId = characterId;
      hooks.rescanAll();
      requestRegexTakeover(ctx, characterId, scripts).then(({ disabled, native }) => {
        const card = getActiveCard();
        if (!card || card.characterId !== characterId)
          return;
        const prev = card.nativeKeys ?? new Set;
        const next = new Set(native);
        const changed = prev.size !== next.size || [...next].some((k) => !prev.has(k));
        card.nativeKeys = next;
        if (disabled === 0 && !changed)
          return;
        ctx.display?.invalidate?.(["*"]);
        hooks.rescanAll();
      });
    } catch (err) {
      console.debug("[vishrun] fetchCharacter failed:", err);
    } finally {
      if (inflightCharacterId === characterId)
        inflightCharacterId = null;
    }
  }
  async function resolveActiveCharacterId() {
    const active = ctx.getActiveChat();
    if (active.characterId || !active.chatId)
      return active.characterId ?? null;
    try {
      const characterId = await getChatCharacterId(active.chatId);
      const now = ctx.getActiveChat();
      if (now.chatId !== active.chatId)
        return now.characterId ?? null;
      return now.characterId ?? characterId ?? null;
    } catch {
      return null;
    }
  }
  const unsubChatChanged = ctx.events.on("CHAT_CHANGED", (payload) => {
    const p = payload || {};
    if (!shouldRescanForChangedFields(p.changedFields))
      return;
    loadFor(p.characterId ?? ctx.getActiveChat().characterId ?? null);
  });
  function handleMessageMutation(eventName, payload) {
    const p = payload || {};
    const msg = p.message;
    if (!msg || typeof msg.id !== "string" || typeof msg.content !== "string")
      return;
    const active = ctx.getActiveChat();
    if (active.chatId && p.chatId && active.chatId !== p.chatId)
      return;
    const destroyReason = eventName === "MESSAGE_EDITED" ? "message-edited" : "message-swiped";
    destroyAllRegisteredWidgetsForMessage(msg.id, destroyReason);
    const compiled = hooks.compiledForActiveCard();
    if (!compiled)
      return;
    rebuildCapturesFromContent(msg.id, msg.content, compiled, eventName);
    hooks.processMessageById(msg.id);
  }
  const unsubMessageSwiped = ctx.events.on("MESSAGE_SWIPED", (p) => handleMessageMutation("MESSAGE_SWIPED", p));
  const unsubMessageEdited = ctx.events.on("MESSAGE_EDITED", (p) => handleMessageMutation("MESSAGE_EDITED", p));
  const unsubSettingsUpdated = ctx.events.on("SETTINGS_UPDATED", (payload) => {
    if (!touchesActiveChat(payload))
      return;
    resolveActiveCharacterId().then(loadFor);
  });
  let coldTries = 0;
  const coldTimer = setInterval(() => {
    if (++coldTries > 20 || lastLoadedCharacterId !== null) {
      clearInterval(coldTimer);
      return;
    }
    const now = ctx.getActiveChat();
    if (!now.characterId && !now.chatId)
      return;
    resolveActiveCharacterId().then((id) => {
      if (id && lastLoadedCharacterId === null)
        loadFor(id);
    });
  }, 1000);
  const active = ctx.getActiveChat();
  if (active.characterId || active.chatId) {
    resolveActiveCharacterId().then((id) => {
      if (id)
        loadFor(id);
    });
  }
  return () => {
    clearInterval(coldTimer);
    unsubChatChanged();
    unsubSettingsUpdated();
    unsubMessageSwiped();
    unsubMessageEdited();
    unsubMvuDisplayStrip();
    unsubStatusBarInject();
    disposePresetScripts();
    hooks.dispose();
    ctx.dom.cleanup();
    clearActiveCard();
    setHostContext(null);
  };
}
export {
  setup,
  touchesActiveChat
};
