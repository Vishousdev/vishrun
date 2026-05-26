// src/lumiverse/fetch-character.ts
async function fetchCharacter(characterId) {
  const url = `/api/v1/characters/${encodeURIComponent(characterId)}`;
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) {
    throw new Error(`fetchCharacter ${characterId}: HTTP ${r.status} ${r.statusText}`);
  }
  return await r.json();
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
  const n1 = textualMarkerName(src, "START OF");
  const n2 = textualMarkerName(src, "END OF");
  if (n1 && n1 === n2)
    return true;
  return LITERAL_JSON_DELIM_RE.test(src);
}
function classifyTrigger(re) {
  if (isPairedTag(re))
    return "pairedTag";
  if (isPlaceholder(re))
    return "placeholder";
  if (isDelimitedCapture(re))
    return isMultiLineRegex(re) ? "delimitedCaptureMultiLine" : "delimitedCapture";
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
    if (next === "$") {
      out += "$";
      i += 2;
      continue;
    }
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

// src/core/diagnostics.ts
var VSH_VISHRUN_DIAG = false;

// src/core/asset-injector.ts
function isFetchExternalResponse(p, requestId) {
  return !!p && typeof p === "object" && p.type === "fetch_external_response" && p.requestId === requestId;
}
var requestCounter = 0;
function nextRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `vishrun-fx-${Date.now()}-${++requestCounter}`;
}
function fetchViaBackend(url, ctx, timeoutMs = 30000) {
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

// src/core/dispatch-slash.ts
function isDispatchSlashResponse(p, requestId) {
  if (!p || typeof p !== "object")
    return false;
  const r = p;
  return r.type === "dispatch_slash_text_response" && r.requestId === requestId && typeof r.handled === "boolean" && typeof r.kind === "string";
}
var requestCounter2 = 0;
function nextRequestId2() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `vishrun-ds-${Date.now()}-${++requestCounter2}`;
}
var DISPATCH_TIMEOUT_MS = 5000;
function dispatchSlashViaBackend(ctx, chatId, text, timeoutMs = DISPATCH_TIMEOUT_MS) {
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
  /\bgetChatId\s*\(/
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
    messagesSnapshot: consts.messagesSnapshot
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
})();</script>`;
}

// src/backend/mvu-parser.ts
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
        if (bottom > maxBottom) maxBottom = bottom;
      }
      if (document.body.scrollHeight > maxBottom) maxBottom = document.body.scrollHeight;
      var h = Math.ceil(maxBottom) + 4;

      history.push(h);
      if (history.length > 4) history.shift();
      if (history.length === 4) {
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
      if (target && target.contains(iframe))
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
  const stripped = rewriteCssExternalUrls(stripExternalImageSrc(withoutCdnJQuery));
  const head = buildHeadInjection(iframeCtx);
  const withHead = injectIntoHead(stripped, head);
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
    messagesSnapshot: iframeCtx.messagesSnapshot
  }) : "";
  const mvu = shouldInjectMvuShim(iframeCtx.env) ? mvuShim({ variablesSnapshot: iframeCtx.variablesSnapshot }) : "";
  return buildViewportHeightShim() + setChatMessagesShim() + clipboardAlertShim() + externalImageProxyHelper() + fontFaceHelper() + jquery + lodash + thHelpers + mvu;
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
          return origSetAttr.call(this, KEY, value);
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
    window.spindleSandbox.corsProxy(url, { responseType: 'arraybuffer' }).then(
      function(res) {
        try {
          // loader.ts:196-202 already converted base64 → Uint8Array on
          // the host side. Treat the body as bytes; constructing a
          // Blob from a Uint8Array preserves binary fidelity.
          if (!res || !res.body) {
            console.warn('[vishrun] corsProxy returned no body for', url);
            return;
          }
          var ct = '';
          if (res.headers) {
            ct = res.headers['content-type'] || res.headers['Content-Type'] || '';
          }
          ct = String(ct).split(';')[0].trim() || 'application/octet-stream';
          var blob = new Blob([res.body], { type: ct });
          var blobUrl = URL.createObjectURL(blob);
          setBlobSrc(img, blobUrl);
        } catch (e) {
          console.warn('[vishrun] corsProxy decode failed for', url, e);
        } finally {
          img.removeAttribute('data-vishrun-extimg-loading');
        }
      },
      function(err) {
        img.removeAttribute('data-vishrun-extimg-loading');
        console.warn('[vishrun] corsProxy fetch failed for', url, err);
      }
    );
  }

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
  } else if (p.kind === "alert") {
    handleHostAlert(p.payload);
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
  const messageEl = iframe.closest("[data-message-id]");
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
    const url = `/api/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`;
    try {
      const r = await fetch(url, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: targetContent })
      });
      if (VSH_VISHRUN_DIAG) {
        console.log("[vishrun:bridge] set-chat-messages PUT", JSON.stringify({
          url,
          contentLen: targetContent.length,
          status: r.status,
          ok: r.ok
        }));
      }
      if (!r.ok) {
        console.warn(`[vishrun] setChatMessages: PUT failed (HTTP ${r.status}) for swipe_id=${swipeId}`);
        continue;
      }
    } catch (err) {
      if (VSH_VISHRUN_DIAG) {
        console.log("[vishrun:bridge] set-chat-messages error", JSON.stringify({
          error: err instanceof Error ? err.message : String(err)
        }));
      }
      console.warn("[vishrun] setChatMessages: PUT threw", err);
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
function syncTagInterceptors(ctx, compiled) {
  const desired = new Map;
  for (const s of compiled) {
    if (s.kind !== "pairedTag")
      continue;
    const tagName = extractTagName(s.findRe.source);
    if (!tagName) {
      console.debug(`[vishrun] paired-tag script "${s.scriptName}" classified as pairedTag but ` + `extractTagName failed — skipping. findRegex source: ${s.findRe.source}`);
      continue;
    }
    desired.set(tagName.toLowerCase(), s);
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
  for (const [tagName, script] of desired) {
    const unsub = ctx.messages.registerTagInterceptor({ tagName, removeFromMessage: true }, (payload) => onCapture(payload, script));
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
function rebuildCapturesFromContent(messageId, content, compiled, _eventName) {
  const newList = [];
  let working = content;
  for (const script of compiled) {
    if (script.kind !== "pairedTag")
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
function onCapture(payload, script) {
  if (!payload.messageId)
    return;
  const existing = capturesByMessage.get(payload.messageId) || [];
  const list = existing.filter((c) => c.scriptId !== script.id);
  list.push({
    scriptId: script.id,
    scriptName: script.scriptName,
    replaceString: script.replaceString,
    findRe: script.findRe,
    fullMatch: payload.fullMatch,
    attrs: payload.attrs
  });
  capturesByMessage.set(payload.messageId, list);
}
function extractTagName(reSource) {
  const m = reSource.match(/^<(?:\\s\*|\s)*([a-zA-Z_][a-zA-Z0-9_-]*)/);
  return m ? m[1] : null;
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
    for (const child of Array.from(el.childNodes))
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
  const tc = root.textContent ?? "";
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
async function processNode(root, scripts, ctx) {
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
  const resolvedMap = await resolveMacrosForMessage(root, scripts, messageId, ctx);
  let total = 0;
  try {
    for (const script of scripts) {
      if (!isPlaceholderLikeKind(script.kind))
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
    if (!isPlaceholderLikeKind(script.kind))
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
    matches.push({ start: m.index, end: m.index + m[0].length, match: m });
    if (m[0].length === 0)
      script.findRe.lastIndex++;
  }
  if (matches.length === 0)
    return 0;
  if (hasRegisteredWidgetsFor(messageId, script.id)) {
    destroyRegisteredWidgetsFor(messageId, script.id);
  }
  let count = 0;
  for (let i = matches.length - 1;i >= 0; i--) {
    const { start, end, match } = matches[i];
    const groups = match.slice(1).map((g) => g ?? "");
    const html = substitute(script.replaceString, match[0], groups);
    const expanded = applyNestedPipeline(html, allScripts, new Set([script.id]), 0);
    const fromMap = resolvedMap.get(expanded);
    const fromCache = fromMap ?? resolutionCache.get(expanded);
    const finalHtml = fromCache ?? expanded;
    const widget = await buildWidget(finalHtml, script.scriptName, script.id, messageId, ctx);
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
    }
  }
  invalidateLinearizedBubble(bubble);
  return count;
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
  if (!bubble.contains(startEntry.node) || !bubble.contains(endEntry.node))
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
function cleanupEmptyAroundWidget(widget, stopAt) {
  let current2 = widget;
  for (;; ) {
    const parent = current2.parentElement;
    if (!parent)
      break;
    let prev = current2.previousSibling;
    while (prev) {
      const next = prev.previousSibling;
      if (isEmptyResidue(prev))
        prev.parentNode?.removeChild(prev);
      else
        break;
      prev = next;
    }
    let nxt = current2.nextSibling;
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
    const onlyChild = parent.childNodes.length === 1 && parent.childNodes[0] === current2;
    if (onlyChild && MULTILINE_BLOCK_TAGS.has(parent.tagName)) {
      const gparent = parent.parentNode;
      if (!gparent)
        break;
      gparent.replaceChild(current2, parent);
      continue;
    }
    break;
  }
}
function isEmptyResidue(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.nodeValue ?? "").length === 0;
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node;
    if (el.tagName === "BR")
      return true;
    if (!MULTILINE_BLOCK_TAGS.has(el.tagName))
      return false;
    return (el.textContent ?? "").length === 0;
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
async function renderPairedTagCaptures(root, allScripts, messageId, ctx, resolvedMap) {
  const captures = getCapturesForMessage(messageId);
  const target = findContentRoot(root);
  let added = 0;
  let removed = 0;
  const existingPaired = target.querySelectorAll("[data-vishrun-widget][data-vishrun-paired-fullmatch]");
  existingPaired.forEach((el) => {
    const sid = el.getAttribute("data-vishrun-script-id");
    const fmHash = el.getAttribute("data-vishrun-paired-fullmatch");
    const stillValid = captures.some((c) => c.scriptId === sid && hashKey(c.fullMatch) === fmHash);
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
    const sel = `[data-vishrun-widget][data-vishrun-script-id="${cssEscape(cap.scriptId)}"][data-vishrun-paired-fullmatch="${cssEscape(hashKey(cap.fullMatch))}"]`;
    if (target.querySelector(sel))
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
    const iframe = await buildWidgetIframe(finalHtml, cap.scriptName, cap.scriptId, messageId, ctx);
    iframe.setAttribute("data-vishrun-paired-fullmatch", hashKey(cap.fullMatch));
    if (!target.isConnected || target.querySelector(sel)) {
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
    target.appendChild(iframe);
    added++;
  }
  return added;
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
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentElement;
      while (p && p !== root) {
        if (p.hasAttribute("data-vishrun-widget"))
          return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let n;
  while ((n = walker.nextNode()) !== null) {
    out.push(n);
  }
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
    try {
      const nodes = document.querySelectorAll("[data-message-id]");
      const tasks = [];
      nodes.forEach((n) => {
        tasks.push(processNode(n, compiled, ctx).catch(() => {}));
      });
      await Promise.all(tasks);
    } finally {
      if (wasObserving && observedTarget && document.contains(observedTarget)) {
        observer.observe(observedTarget, OBSERVE_OPTS);
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
      syncTagInterceptors(ctx, compiledNow);
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
  const unsubGenEnded = ctx.events.on("GENERATION_ENDED", (payload) => {
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
      detachObserver();
      teardownTagInterceptors();
      clearEditingMessageIds();
      unsubGenEnded();
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
function parseMessagesResponse(json) {
  if (Array.isArray(json))
    return json;
  if (json && typeof json === "object" && Array.isArray(json.data)) {
    return json.data;
  }
  return [];
}
function defaultIO() {
  return {
    fetchContent: async (chatId, messageId) => {
      const r = await fetch(`/api/v1/chats/${encodeURIComponent(chatId)}/messages`, { credentials: "same-origin" });
      if (!r.ok)
        throw new Error(`messages fetch failed: HTTP ${r.status}`);
      const json = await r.json();
      const list = parseMessagesResponse(json);
      const m = list.find((mm) => mm.id === messageId);
      if (!m)
        return null;
      return { id: m.id, content: m.content, isUser: m.is_user, role: m.role };
    },
    updateContent: async (chatId, messageId, newContent) => {
      const r = await fetch(`/api/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: newContent })
      });
      if (!r.ok)
        throw new Error(`update failed: HTTP ${r.status}`);
    }
  };
}
function installStatusBarInjectHook(ctx, io = defaultIO()) {
  return ctx.events.on("GENERATION_ENDED", (payload) => {
    const p = payload || {};
    if (p.error)
      return;
    if (!p.messageId || !p.chatId)
      return;
    maybeInjectStatusPlaceholder(p.chatId, p.messageId, io);
  });
}

// src/frontend.ts
function setup(ctx) {
  const hooks = installMessageHooks(ctx);
  const unsubMvuDisplayStrip = registerMvuDisplayStrip(ctx);
  const unsubStatusBarInject = installStatusBarInjectHook(ctx);
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
      setActiveCard({ characterId, characterName: name, scripts, firstMes, alternateGreetings });
      lastLoadedCharacterId = characterId;
      hooks.rescanAll();
    } catch (err) {
      console.debug("[vishrun] fetchCharacter failed:", err);
    } finally {
      if (inflightCharacterId === characterId)
        inflightCharacterId = null;
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
    const active2 = ctx.getActiveChat();
    if (active2.chatId && p.chatId && active2.chatId !== p.chatId)
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
    const p = payload || {};
    if (p.key !== "activeChatId" && p.key !== "activeCharacterId")
      return;
    loadFor(ctx.getActiveChat().characterId ?? null);
  });
  const active = ctx.getActiveChat();
  if (active.characterId) {
    loadFor(active.characterId);
  }
  return () => {
    unsubChatChanged();
    unsubSettingsUpdated();
    unsubMessageSwiped();
    unsubMessageEdited();
    unsubMvuDisplayStrip();
    unsubStatusBarInject();
    hooks.dispose();
    ctx.dom.cleanup();
    clearActiveCard();
  };
}
export {
  setup
};
