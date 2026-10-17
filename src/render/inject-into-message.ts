import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import type { CompiledScript } from '../core/parse-regex-script';
import { isPlaceholderLikeKind } from '../core/classify-trigger';
import { substitute } from '../core/substitute';
import { applyNestedPipeline } from '../core/nested-pipeline';
import {
  buildWidgetIframe,
  cleanupOrphansForMessage,
  destroyAllRegisteredWidgetsForMessage,
  destroyRegisteredWidgetsFor,
  destroyWidgetIframe,
  hasRegisteredWidgetsFor,
  setWidgetSource,
  widgetNeedsIsolation,
} from './widget-iframe';
import { getCapturesForMessage, syncStrippedTagCaptures } from '../hooks/tag-interceptor';
import { hasMacros } from '../core/macro-detection';
import { resolveMacrosBatch } from '../core/macro-resolver';
import { getLinearizedBubble, invalidateLinearizedBubble, type OffsetMapEntry } from './linearize-bubble';
import { VSH_VISHRUN_DIAG } from '../core/diagnostics';
import { deepContains, deepQuerySelector, deepQuerySelectorAll, hasShadowHost, isNonTextElement, renderedChildNodes } from './shadow-dom';
import { computePairedAnchor, placeAtAnchor, type PairedAnchor } from './paired-anchor';
import { fetchMessageContent } from '../lumiverse/fetch-message';
import { clearPending, hideRange, leadingLiterals, trailingLiterals, unterminatedRanges } from './pending-hide';
import { isGenerating, isLatestMessage } from '../state/generation';

// Expanded widget HTML → macro-resolved HTML, for one processNode pass.
type ResolvedMap = Map<string, string>;

// Global cache of macro resolutions. Key: expanded raw template (what was sent
// to the backend). Value: resolved HTML (what the backend returned). Lives
// across processNode passes so replacePlaceholderMatches can recover the
// resolution even when the current run's map is empty — which happens when
// processNode re-fires after the first render: collectExpandedTemplates returns
// 0 (the matched text now lives inside a [data-vishrun-widget], so it's excluded
// from the text-node scan) → no resolve → empty map → otherwise a MISS → raw
// `{{getvar::}}` re-rendered into the DOM.
//
// Limitation: not invalidated when variables change. If a /setvar mutates
// player_grade mid-session, widgets with a cached entry keep showing the old
// value. A browser refresh clears the cache. Acceptable for the current use
// case (variables are set up front, rarely mutate).
const resolutionCache = new Map<string, string>();

// Module-scoped tracker for which messageIds are currently observed in edit
// mode. Lumiverse emits no event for the edit enter/exit transition (pure
// React state, see BubbleMessageDefault.tsx:270-293), so we infer transitions
// by diffing the DOM signal against this Set on each processNode pass. The
// Set is load-bearing: enter → tear down widgets and short-circuit; still
// → short-circuit; exit → fall through to the rebuild pipeline.
const editingMessageIds = new Set<string>();

export type EditTransition = 'enter' | 'still' | 'exit' | 'idle';

/**
 * Diff the message's current DOM state against the editing Set to detect an
 * edit-mode transition edge. Mutates `editingSet` on 'enter' and 'exit' so
 * the next call sees the new steady state. DOM signal established by prior
 * investigation: textarea present AND no [data-component="MessageContent"].
 */
export function computeEditModeTransition(
  root: HTMLElement,
  messageId: string,
  editingSet: Set<string>,
): EditTransition {
  const hasTextarea = !!root.querySelector('textarea');
  const hasMessageContent = !!root.querySelector('[data-component="MessageContent"]');
  const inEditMode = hasTextarea && !hasMessageContent;
  const wasEditing = editingSet.has(messageId);
  if (inEditMode && !wasEditing) {
    editingSet.add(messageId);
    return 'enter';
  }
  if (inEditMode && wasEditing) return 'still';
  if (!inEditMode && wasEditing) {
    editingSet.delete(messageId);
    return 'exit';
  }
  return 'idle';
}

/** Reset the module's edit-mode tracker. Called from installMessageHooks
 *  dispose() so the Set doesn't outlive a spindle reload / chat teardown. */
export function clearEditingMessageIds(): void {
  editingMessageIds.clear();
}

/** Test-only inspection of the module's edit-mode Set. */
export function getEditingMessageIdsForTest(): ReadonlySet<string> {
  return editingMessageIds;
}

/**
 * Process a single message DOM. Two pipelines, kept separate per the
 * Step 3 design constraint:
 *
 *   1. Placeholder pipeline (Step 2 + iframe extension)
 *      For each compiled placeholder-like script (`placeholder` and
 *      `delimitedCapture` — Fix B), find every match in the message's text
 *      nodes and replace with a widget. The widget is a <div> with innerHTML
 *      if the replaceString has no <script>, or a sandboxed iframe if it does.
 *      `delimitedCapture` scripts (`【…(…)…】`, `↦…↤`, `[START OF X]…[END OF X]`,
 *      etc.) survive DOMPurify just like plain placeholders, so they share
 *      this path; `$N` substitution handles their capture groups.
 *
 *   2. Paired-tag pipeline (Step 3)
 *      Read the captures map populated by tag-interceptor.ts. For each
 *      capture not already rendered as a widget in this message, append
 *      one to the message's [data-component="MessageContent"] node.
 *      Widgets are always iframes here for safety — paired-tag widgets
 *      tend to carry behavior (Vavesta Court Ledger has <script>) and
 *      keeping them isolated from the host CSS is conservative.
 *
 * Idempotency: both pipelines skip work where a [data-vishrun-widget] is
 * already in place. Re-running on the same DOM is a no-op.
 */
// One render per message at a time. Virtualized lists nest two elements with
// the same data-message-id around one MessageContent; overlapping passes on
// them tear down each other's widgets.
const messageQueue = new Map<string, Promise<number>>();

export function processNode(
  root: HTMLElement,
  scripts: CompiledScript[],
  ctx: SpindleFrontendContext,
): Promise<number> {
  const id = root.getAttribute('data-message-id');
  if (!id) return Promise.resolve(0);
  const prev = messageQueue.get(id) ?? Promise.resolve(0);
  const next = prev.catch(() => 0).then(() => processNodeNow(root, scripts, ctx));
  messageQueue.set(id, next);
  void next.finally(() => { if (messageQueue.get(id) === next) messageQueue.delete(id); });
  return next;
}

async function processNodeNow(
  root: HTMLElement,
  scripts: CompiledScript[],
  ctx: SpindleFrontendContext,
): Promise<number> {
  const messageId = root.getAttribute('data-message-id') || undefined;
  if (!messageId) {
    // Without a stable messageId, the global widget registry can't track
    // ownership and the pre-pipeline orphan cleanup would have nothing
    // to scope against. Silently skip — scanAllNow only ever calls
    // processNode for `[data-message-id]` nodes anyway.
    return 0;
  }

  // Edit-mode gate. Lumiverse replaces MessageContent with MessageEditArea
  // (textarea) when editingMessageId === message.id; no event fires for the
  // transition, so we diff the DOM signal against the editing Set every pass.
  //   enter → destroy registered widgets (so the iframe doesn't sit next to
  //           the textarea via findContentRoot's fallback) and short-circuit.
  //   still → short-circuit every observer tick while the textarea is open.
  //   exit  → fall through; MessageContent is back, findContentRoot resolves,
  //           and the pipeline rebuilds from the (possibly edited) content.
  //   idle  → normal path, unchanged.
  const transition = computeEditModeTransition(root, messageId, editingMessageIds);
  if (VSH_VISHRUN_DIAG) {
    if (transition === 'enter') {
      console.log('[vishrun:edit-mode] transition', {
        messageId,
        phase: 'enter',
        signal: 'textarea-without-MessageContent',
      });
    } else if (transition === 'exit') {
      console.log('[vishrun:edit-mode] transition', { messageId, phase: 'exit' });
    }
  }
  if (transition === 'enter') {
    // Reuse the teardown path the MESSAGE_EDITED rebuild uses. Idempotent
    // when nothing's registered for this id.
    destroyAllRegisteredWidgetsForMessage(messageId, 'edit-mode-enter');
    return 0;
  }
  if (transition === 'still') return 0;

  // Global pre-pipeline cleanup: destroy any registered iframes for this
  // messageId that aren't currently inside the expected MessageContent.
  // Catches React subtree rebuilds (swipe / edit / regen) that detached
  // an iframe but didn't unmount the host's sandboxFrames record.
  const target = findContentRoot(root);
  cleanupOrphansForMessage(messageId, target);

  // Batch-resolve {{macros}} (e.g. {{getvar::player_grade}}) in this message's
  // widget HTML before any widget is built. Always returns a map; missing
  // entries → widget renders the raw template (no worse than pre-MVU-lite).
  // Tag captures first: macro collection below reads their final fullMatch.
  try {
    await refreshStrippedTagCaptures(target, scripts, messageId, ctx);
    await reconcileNestedTagCaptures(scripts, messageId, ctx);
  } catch (err) {
    console.debug('[vishrun] tag capture refresh failed:', err);
  }
  const resolvedMap = await resolveMacrosForMessage(root, scripts, messageId, ctx);

  let total = 0;
  // Widget building is async now (buildWidgetIframe → injectShimsAndSizeReporter
  // → transformHtmlForTailwind may fetch the Tailwind bundle on first use).
  // Swallow errors so a single bad render doesn't reject for fire-and-forget
  // callers (scanAllNow / processMessageById) and so a later scan can retry.
  clearPending(target);
  try {
    for (const script of scripts) {
      // placeholder + delimitedCapture run through the post-DOMPurify text scan.
      // delimitedCaptureMultiLine routes through the linearize-bubble path
      // (single regex across all text nodes in the bubble). pairedTag scripts
      // go through registerTagInterceptor (pre-sanitizer) and surface here as
      // captures via getCapturesForMessage. unknown is skipped.
      if (!isPlaceholderLikeKind(script.kind) || script.native) continue;
      if (script.kind === 'delimitedCaptureMultiLine') {
        total += await replaceMultiLineMatches(root, script, scripts, messageId, ctx, resolvedMap);
      } else {
        total += await replacePlaceholderMatches(root, script, scripts, messageId, ctx, resolvedMap);
      }
    }
    total += await renderPairedTagCaptures(root, scripts, messageId, ctx, resolvedMap);
  } catch (err) {
    console.debug('[vishrun] processNode render error:', err);
  }
  return total;
}

// ─── Macro resolution ──────────────────────────────────────────────────

// Resolve this message's widget macros in one backend round-trip. Returns a map
// keyed by the exact expanded HTML the render functions recompute, so their
// `get(expanded) ?? expanded` lookup picks up the resolved version. Best-effort:
// any failure (no macros, no chatId, timeout, error) → partial/empty map →
// widgets render raw (pre-MVU-lite behaviour). Never throws.
async function resolveMacrosForMessage(
  root: HTMLElement,
  scripts: CompiledScript[],
  messageId: string,
  ctx: SpindleFrontendContext,
): Promise<ResolvedMap> {
  const map: ResolvedMap = new Map();
  // Fast out: if no script's replaceString has `{{` at all, no expanded HTML
  // (even after nested expansion) can carry a macro — skip the whole pass.
  if (!scripts.some((s) => s.replaceString.includes('{{'))) return map;
  const templates = collectExpandedTemplates(root, scripts, messageId).filter(hasMacros);
  if (templates.length === 0) return map;

  const { chatId, characterId } = ctx.getActiveChat();
  if (!chatId) {
    console.warn('[vishrun:variables] no active chatId; widget macros left unresolved');
    return map;
  }

  try {
    const resolved = await resolveMacrosBatch(ctx, chatId, characterId, templates);
    templates.forEach((t, i) => {
      map.set(t, resolved[i]);
      resolutionCache.set(t, resolved[i]); // global cache, survives across processNode passes
    });
  } catch (err) {
    console.warn(
      '[vishrun:variables] macro resolve failed; widgets render unresolved:',
      err instanceof Error ? err.message : String(err),
    );
  }
  return map;
}

// Read-only pass mirroring what the render functions would compute as the
// per-widget expanded HTML, without touching the DOM. Recomputing the same
// (deterministic) substitute()+applyNestedPipeline() there makes the map lookup
// hit — unless the DOM changed under us, in which case that widget renders
// unresolved (acceptable). Skips already-rendered paired captures so re-scans
// don't re-resolve.
function collectExpandedTemplates(
  root: HTMLElement,
  scripts: CompiledScript[],
  messageId: string,
): string[] {
  const out = new Set<string>();

  // Placeholder-like scripts (placeholder + delimitedCapture): scan text nodes
  // outside existing widgets. After a render the matched text lives inside a
  // [data-vishrun-widget], so re-scans collect nothing here and skip the round-trip.
  const textNodes = collectTextNodes(root);
  for (const script of scripts) {
    if (!isPlaceholderLikeKind(script.kind) || script.native) continue;
    if (script.kind === 'delimitedCaptureMultiLine') {
      const bubble = findContentRoot(root);
      const linear = getLinearizedBubble(bubble);
      script.findRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = script.findRe.exec(linear.text)) !== null) {
        const groups = m.slice(1).map((g) => g ?? '');
        const html = substitute(script.replaceString, m[0], groups);
        out.add(applyNestedPipeline(html, scripts, new Set([script.id]), 0));
        if (m[0].length === 0) script.findRe.lastIndex++;
      }
      continue;
    }
    for (const tn of textNodes) {
      const text = tn.nodeValue ?? '';
      if (!text) continue;
      script.findRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = script.findRe.exec(text)) !== null) {
        const groups = m.slice(1).map((g) => g ?? '');
        const html = substitute(script.replaceString, m[0], groups);
        out.add(applyNestedPipeline(html, scripts, new Set([script.id]), 0));
        if (m[0].length === 0) script.findRe.lastIndex++;
      }
    }
  }

  // Paired-tag captures: skip ones already on screen (matches the idempotency
  // check in renderPairedTagCaptures) so re-scans don't re-resolve them.
  const target = findContentRoot(root);
  for (const cap of getCapturesForMessage(messageId)) {
    const sel = `[data-vishrun-widget][data-vishrun-script-id="${cssEscape(cap.scriptId)}"][data-vishrun-paired-fullmatch="${cssEscape(hashKey(cap.fullMatch))}"]`;
    if (target.querySelector(sel)) continue;
    cap.findRe.lastIndex = 0;
    const m = cap.findRe.exec(cap.fullMatch);
    if (!m) continue; // failed re-match renders raw text — no macros
    const groups = m.slice(1).map((g) => g ?? '');
    const html = substitute(cap.replaceString, m[0], groups);
    out.add(applyNestedPipeline(html, scripts, new Set([cap.scriptId]), 0));
  }

  return [...out];
}

// ─── Multi-line placeholder pipeline ───────────────────────────────────
//
// `delimitedCaptureMultiLine` scripts use a single regex executed against the
// linearized bubble (text + <br>→\n + <p>-gap→\n\n). When a match is found,
// the corresponding DOM range is removed via the Range API and the widget is
// inserted in its place. Matches are processed in reverse document order so
// earlier offsets in the precomputed offsetMap remain valid after each splice.
// Empty block ancestors that were drained by the deletion are pruned so we
// don't leave stray empty <p> elements polluting the bubble.

async function replaceMultiLineMatches(
  root: HTMLElement,
  script: CompiledScript,
  allScripts: CompiledScript[],
  messageId: string,
  ctx: SpindleFrontendContext,
  resolvedMap: ResolvedMap,
): Promise<number> {
  const bubble = findContentRoot(root);
  if (!bubble.isConnected) return 0;

  const linear = getLinearizedBubble(bubble);
  if (linear.text.length === 0) return 0;

  script.findRe.lastIndex = 0;
  const matches: Array<{ start: number; end: number; match: RegExpExecArray; occurrence: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = script.findRe.exec(linear.text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length, match: m, occurrence: matches.length });
    if (m[0].length === 0) script.findRe.lastIndex++;
  }

  // ST applies scripts in order on the text, so a lower-index script whose match
  // sits inside a later script's block is rendered by that block's nested
  // pipeline, not here (rendering it first would remove it from the block).
  const outer = outerRangesFromLaterScripts(linear.text, script, allScripts);
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, end } = matches[i];
    if (outer.some(([s, e]) => s < start && end <= e)) matches.splice(i, 1);
  }

  // A block still being streamed has its opener but not its closer yet.
  if (isGenerating() && isLatestMessage(messageId)) {
    const src = script.findRe.source;
    for (const open of leadingLiterals(src)) {
      for (const close of trailingLiterals(src)) {
        for (const [s, e] of unterminatedRanges(linear.text, open, close)) hideRange(bubble, linear.offsetMap, s, e);
      }
    }
  }
  if (matches.length === 0) return 0;
  for (const { start, end } of matches) hideRange(bubble, linear.offsetMap, start, end);

  if (hasRegisteredWidgetsFor(messageId, script.id)) {
    destroyRegisteredWidgetsFor(messageId, script.id);
  }

  const rawMatches = await rawMatchesWithStrippedTags(script, messageId, ctx);

  let count = 0;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, end, occurrence } = matches[i];
    let match = matches[i].match;
    // Paired tags inside the block were removed before render; the stored text
    // still has them, so use its captures and let the nested pipeline expand them.
    const raw = rawMatches?.matches[occurrence];
    if (raw) {
      match = raw;
      for (const fm of rawMatches!.pairedInside(raw[0])) consumedPairedMatches.add(messageId + '\u0001' + fm);
    }
    const groups = match.slice(1).map((g) => g ?? '');
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
        console.log('[vishrun:render] placeholder-skipped', JSON.stringify({
          messageId, scriptId: script.id, reason: 'replaceLinearRange-failed',
        }));
      }
      if (widget.tagName === 'IFRAME') {
        destroyWidgetIframe(widget as HTMLIFrameElement);
      }
      // Never leave raw content hidden when its widget could not be placed.
      clearPending(bubble);
    }
  }

  invalidateLinearizedBubble(bubble);
  return count;
}

// Paired-tag fullMatches already rendered inside another script's block.
const consumedPairedMatches = new Set<string>();

function isConsumedPaired(messageId: string, fullMatch: string): boolean {
  return consumedPairedMatches.has(messageId + '\u0001' + fullMatch.replace(/\r\n?/g, '\n'));
}

async function rawMatchesWithStrippedTags(
  script: CompiledScript,
  messageId: string,
  ctx: SpindleFrontendContext,
): Promise<{ matches: Array<RegExpExecArray | null>; pairedInside: (block: string) => string[] } | null> {
  const caps = getCapturesForMessage(messageId);
  if (caps.length === 0) return null;
  const chatId = ctx.getActiveChat().chatId;
  if (!chatId) return null;
  let raw: string | null = null;
  try {
    raw = await fetchMessageContent(chatId, messageId);
  } catch {
    return null;
  }
  if (!raw) return null;
  const text = raw.replace(/\r\n?/g, '\n');
  const re = new RegExp(script.findRe.source, script.findRe.flags);
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push(m);
    if (m[0].length === 0) re.lastIndex++;
  }
  const fulls = caps.map((c) => c.fullMatch.replace(/\r\n?/g, '\n'));
  const pairedInside = (block: string) => fulls.filter((f) => block.includes(f));
  if (!matches.some((mm) => pairedInside(mm[0]).length > 0)) return null;
  return { matches: matches.map((mm) => (pairedInside(mm[0]).length > 0 ? mm : null)), pairedInside };
}

function outerRangesFromLaterScripts(
  text: string,
  script: CompiledScript,
  allScripts: CompiledScript[],
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const other of allScripts) {
    if (other.kind !== 'delimitedCaptureMultiLine' || other.sourceIndex <= script.sourceIndex) continue;
    const re = new RegExp(other.findRe.source, other.findRe.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      out.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return out;
}

export function replaceLinearRange(
  bubble: HTMLElement,
  offsetMap: OffsetMapEntry[],
  start: number,
  end: number,
  widget: HTMLElement,
): boolean {
  let startEntry: OffsetMapEntry | null = null;
  let endEntry: OffsetMapEntry | null = null;
  for (const e of offsetMap) {
    if (!startEntry && e.sourceStart <= start && start < e.sourceEnd) startEntry = e;
    if (e.sourceStart < end && end <= e.sourceEnd) endEntry = e;
  }
  if (!startEntry || !endEntry) return false;
  if (!deepContains(bubble, startEntry.node) || !deepContains(bubble, endEntry.node)) return false;

  const startNodeOffset = start - startEntry.sourceStart + startEntry.nodeStart;
  const endNodeOffset = end - endEntry.sourceStart + endEntry.nodeStart;
  let range: Range;
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

const MULTILINE_BLOCK_TAGS = new Set([
  'P', 'DIV', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
]);

const INLINE_RESIDUE_TAGS = new Set(['A', 'SPAN', 'EM', 'STRONG', 'B', 'I', 'U', 'S', 'CODE']);

function cleanupEmptyAroundWidget(widget: HTMLElement, stopAt: HTMLElement): void {
  let current: Element = widget;
  for (;;) {
    const parent = current.parentElement;
    if (!parent) break;
    let prev = current.previousSibling;
    while (prev) {
      const next = prev.previousSibling;
      if (isEmptyResidue(prev)) prev.parentNode?.removeChild(prev);
      else break;
      prev = next;
    }
    let nxt = current.nextSibling;
    while (nxt) {
      const next = nxt.nextSibling;
      if (isEmptyResidue(nxt)) nxt.parentNode?.removeChild(nxt);
      else break;
      nxt = next;
    }
    if (parent === stopAt) break;
    const onlyChild = parent.childNodes.length === 1 && parent.childNodes[0] === current;
    if (onlyChild && MULTILINE_BLOCK_TAGS.has(parent.tagName)) {
      const gparent = parent.parentNode;
      if (!gparent) break;
      gparent.replaceChild(current, parent);
      continue;
    }
    break;
  }
}

function isEmptyResidue(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    // Markdown's newlines between blocks carry no content.
    const v = node.nodeValue ?? '';
    return v.length === 0 || (v.includes('\n') && v.trim() === '');
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement;
    if (el.tagName === 'BR') return true;
    // Range.deleteContents leaves empty shells of partially selected inline
    // ancestors (e.g. a markdown autolink around a URL capture).
    if (INLINE_RESIDUE_TAGS.has(el.tagName)) {
      return (el.textContent ?? '').length === 0 && !el.querySelector('img,svg,video,audio,iframe');
    }
    if (!MULTILINE_BLOCK_TAGS.has(el.tagName)) return false;
    // Lists keep their structure after the text is cut: an empty <ul><li> still draws a bullet.
    return (el.textContent ?? '').trim() === '' && !el.querySelector('img,svg,video,audio,iframe,canvas,[data-vishrun-widget]');
  }
  return false;
}

// ─── Placeholder pipeline ──────────────────────────────────────────────

async function replacePlaceholderMatches(
  root: HTMLElement,
  script: CompiledScript,
  allScripts: CompiledScript[],
  messageId: string,
  ctx: SpindleFrontendContext,
  resolvedMap: ResolvedMap,
): Promise<number> {
  const textNodes = collectTextNodes(root);
  let count = 0;

  // Phase 1 (placeholder): if there's at least one fresh placeholder
  // match in the current text AND we have iframes already registered
  // for (messageId, scriptId), the pair is a duplication smell. The
  // existing registered widgets came from a prior render, and the
  // fresh-text scan that follows would create new widgets next to them
  // — that's exactly the swipe-duplication bug.
  //
  // Two-stage check (not unconditional destroy) keeps streaming cheap:
  // every observer fire during streaming runs collectTextNodes excluding
  // text inside [data-vishrun-widget], so an already-mounted widget's
  // placeholder text isn't re-detected — no fresh match, no destroy,
  // no churn. The destroy path only triggers when React actually re-
  // emits the placeholder text, which is the swipe / edit case.
  let hasFreshMatch = false;
  for (const tn of textNodes) {
    const text = tn.nodeValue ?? '';
    if (!text) continue;
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
    const text = tn.nodeValue ?? '';
    if (!text) continue;

    script.findRe.lastIndex = 0;
    const ranges: { start: number; end: number; match: RegExpExecArray }[] = [];
    let m: RegExpExecArray | null;
    while ((m = script.findRe.exec(text)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length, match: m });
      if (m[0].length === 0) script.findRe.lastIndex++;
    }
    if (ranges.length === 0) continue;

    const parent = tn.parentNode;
    // Stale text node: a React subtree rebuild during an earlier iteration's
    // await detached `tn` (or its parent). Skip — a later scan re-collects.
    if (!parent || !parent.isConnected) {
      if (VSH_VISHRUN_DIAG) {
        console.log('[vishrun:render] placeholder-skipped', JSON.stringify({
          messageId, scriptId: script.id, reason: 'parent-disconnected-pre-build',
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
      // Placeholders typically have no captures, but a future card could
      // introduce them via (?:...) or (...). Pass match[1..] regardless;
      // substitute() handles the no-groups case fine.
      const groups = match.slice(1).map((g) => g ?? '');
      const html = substitute(script.replaceString, match[0], groups);
      // Recursively substitute any nested tags this card's other scripts
      // match before the HTML goes into a widget (one iframe, whole tree).
      const expanded = applyNestedPipeline(html, allScripts, new Set([script.id]), 0);
      // Macro-resolved HTML: the current run's map first, then the global
      // resolutionCache (survives across processNode passes — see its comment),
      // then the raw template as last resort.
      const fromMap = resolvedMap.get(expanded);
      const fromCache = fromMap ?? resolutionCache.get(expanded);
      const finalHtml = fromCache ?? expanded;
      // await: buildWidget → buildWidgetIframe → injectShimsAndSizeReporter
      // may fetch the Tailwind bundle (cached after the first use).
      const widget = await buildWidget(finalHtml, script.scriptName, script.id, messageId, ctx);
      setWidgetSource(widget, text.slice(start, end));
      frag.appendChild(widget);
      cursor = end;
      count++;
    }
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    // Re-validate: `replaceChild` requires `tn` to still be a child of
    // `parent`. If a React rebuild displaced it while we awaited a fetch,
    // drop the fragment and release any host sandbox-frame records its
    // iframes hold (else they leak until extension teardown). Next scan
    // re-renders into the fresh DOM.
    if (tn.parentNode === parent && parent.isConnected) {
      parent.replaceChild(frag, tn);
    } else {
      if (VSH_VISHRUN_DIAG) {
        console.log('[vishrun:render] placeholder-skipped', JSON.stringify({
          messageId, scriptId: script.id, reason: 'parent-displaced-post-await',
        }));
      }
      frag.querySelectorAll('iframe[data-vishrun-widget]').forEach((el) =>
        destroyWidgetIframe(el as HTMLIFrameElement),
      );
      count -= ranges.length;
    }
  }

  return count;
}

// ─── Paired-tag pipeline ───────────────────────────────────────────────

// Self-closing tags never reach the DOM, so their captures come from the
// stored message. Re-read only when the rendered text changes, and not while
// the message is still streaming.
const strippedTagSeen = new Map<string, string>();

async function refreshStrippedTagCaptures(
  target: HTMLElement,
  scripts: CompiledScript[],
  messageId: string,
  ctx: SpindleFrontendContext,
): Promise<void> {
  if (!scripts.some((s) => s.kind === 'strippedTag' && !s.native)) return;
  if (isGenerating() && isLatestMessage(messageId)) return;
  const chatId = ctx.getActiveChat().chatId;
  if (!chatId) return;
  const sig = chatId + '\u0001' + hashKey(target.textContent ?? '');
  if (strippedTagSeen.get(messageId) === sig) return;
  let raw: string | null = null;
  try {
    raw = await fetchMessageContent(chatId, messageId);
  } catch {
    return;
  }
  if (raw == null) return;
  strippedTagSeen.set(messageId, sig);
  syncStrippedTagCaptures(messageId, raw, scripts);
}

async function renderPairedTagCaptures(
  root: HTMLElement,
  allScripts: CompiledScript[],
  messageId: string,
  ctx: SpindleFrontendContext,
  resolvedMap: ResolvedMap,
): Promise<number> {
  // Widgets of host-rendered scripts count as stale and are removed in phase 1.
  const captures = getCapturesForMessage(messageId).filter((c) => !allScripts.some((s) => s.id === c.scriptId && s.native));
  const target = findContentRoot(root);
  let added = 0;
  let removed = 0;

  // Phase 1 (cleanup): drop paired-tag widgets in this message that no
  // longer match any current capture. Greeting switch / edit / regen
  // depend on this — `onCapture` evicts the prior capture for a
  // (messageId, scriptId) when a new fullMatch arrives, and this loop
  // removes the matching stale widget. Filter on data-vishrun-paired-
  // fullmatch presence so we don't touch placeholder widgets — those
  // live inside the React-owned markdown subtree and React handles
  // unmount on content change.
  const existingPaired = deepQuerySelectorAll<HTMLElement>(
    target,
    '[data-vishrun-widget][data-vishrun-paired-fullmatch]',
  );
  existingPaired.forEach((el) => {
    const sid = el.getAttribute('data-vishrun-script-id');
    const fmHash = el.getAttribute('data-vishrun-paired-fullmatch');
    const stillValid = captures.some(
      (c) => c.scriptId === sid && hashKey(c.fullMatch) === fmHash && !isConsumedPaired(messageId, c.fullMatch),
    );
    if (!stillValid) {
      // destroyWidgetIframe releases the host's sandboxFrames record AND
      // removes the element. Plain el.remove() would leak the record
      // until extension teardown.
      if (el.tagName === 'IFRAME') {
        destroyWidgetIframe(el as HTMLIFrameElement);
      } else {
        el.remove();
      }
      removed++;
    }
  });

  // Phase 2 (inject): for each capture without a matching widget in the
  // DOM, build and insert. The querySelector at the top of the loop is
  // the within-scan idempotency check (a capture iterated twice in one
  // scan doesn't double-insert).
  for (const cap of captures) {
    if (isConsumedPaired(messageId, cap.fullMatch)) continue;
    const sel = `[data-vishrun-widget][data-vishrun-script-id="${cssEscape(cap.scriptId)}"][data-vishrun-paired-fullmatch="${cssEscape(hashKey(cap.fullMatch))}"]`;
    if (deepQuerySelector(target, sel)) continue;

    // Re-run findRe on fullMatch to recover the real capture groups.
    // payload.content (which the interceptor delivers) is a single inner
    // string and would only populate $1 — leaving $2..$N literal for cards
    // whose findRegex defines multiple groups.
    cap.findRe.lastIndex = 0;
    const m = cap.findRe.exec(cap.fullMatch);
    if (!m) {
      if (VSH_VISHRUN_DIAG) {
        console.log('[vishrun:render] placeholder-skipped', JSON.stringify({
          messageId, scriptId: cap.scriptId, reason: 'paired-findRe-failed-rematch',
        }));
      }
      // Card's regex doesn't match its own fullMatch. Should be rare —
      // the tag interceptor already confirmed the tag is present — but a
      // mis-authored findRegex (extra anchors, lookarounds that miss) can
      // land here. Render the raw text inside a marked wrapper so:
      //  - ctx.dom.cleanup() removes it on teardown (vs orphan text node).
      //  - The idempotency selector at the top of this loop matches it
      //    next scan, so we don't re-append on every observer fire.
      //  - data-vishrun-widget-failed lets us spot mis-authored cards.
      console.debug(`[vishrun] paired-tag findRegex failed to re-match fullMatch for "${cap.scriptName}" — rendering raw text`);
      const failed = ctx.dom.createElement('span', {
        'data-vishrun-widget': cap.scriptName,
        'data-vishrun-widget-failed': cap.scriptName,
        'data-vishrun-script-id': cap.scriptId,
      }) as HTMLElement;
      failed.setAttribute('data-vishrun-paired-fullmatch', hashKey(cap.fullMatch));
      failed.textContent = cap.fullMatch;
      if (target.isConnected) {
        target.appendChild(failed);
        added++;
      }
      continue;
    }
    const groups = m.slice(1).map((g) => g ?? '');
    const html = substitute(cap.replaceString, m[0], groups);
    // Recursively substitute nested tags (Satoru Bottom2's <role_npc> blocks)
    // before the HTML goes into the iframe — one frame, whole nested tree.
    const expanded = applyNestedPipeline(html, allScripts, new Set([cap.scriptId]), 0);
    // Macro-resolved HTML: current run's map → global resolutionCache → raw.
    const fromMap = resolvedMap.get(expanded);
    const fromCache = fromMap ?? resolutionCache.get(expanded);
    const finalHtml = fromCache ?? expanded;
    // Paired-tag widgets always go through the iframe path (some cards
    // ship <script>). await: buildWidgetIframe may fetch the Tailwind
    // bundle on first use (cached thereafter).
    if (finalHtml.trim() === '') {
      // Strip-only scripts (e.g. hiding <UpdateVariable>): the host interceptor
      // already removed the tag; keep an inert marker for idempotency only.
      const marker = ctx.dom.createElement('span', {
        'data-vishrun-widget': cap.scriptName,
        'data-vishrun-script-id': cap.scriptId,
        'data-vishrun-paired-fullmatch': hashKey(cap.fullMatch),
        hidden: '',
      }) as HTMLElement;
      if (target.isConnected && !deepQuerySelector(target, sel)) {
        target.appendChild(marker);
        added++;
      }
      continue;
    }
    const anchor = await resolvePairedAnchor(target, messageId, cap.fullMatch, ctx);
    const rawPos = anchor ? null : await rawPositionOf(messageId, cap.fullMatch, ctx);
    const iframe = await buildWidgetIframe(finalHtml, cap.scriptName, cap.scriptId, messageId, ctx);
    iframe.setAttribute('data-vishrun-paired-fullmatch', hashKey(cap.fullMatch));
    // Re-validate after the await: another scan may have inserted this
    // capture's widget, or a React rebuild may have detached `target`. In
    // either case drop the just-built iframe (releasing its host record) and
    // skip — a later scan re-renders into the current DOM.
    if (!target.isConnected || deepQuerySelector(target, sel)) {
      if (VSH_VISHRUN_DIAG) {
        console.log('[vishrun:render] placeholder-skipped', JSON.stringify({
          messageId, scriptId: cap.scriptId,
          reason: !target.isConnected ? 'target-disconnected-post-await' : 'sibling-mounted-during-await',
        }));
      }
      destroyWidgetIframe(iframe);
      continue;
    }
    if (!anchor || !placeAtAnchor(target, anchor, iframe)) placeByRawOrder(target, iframe, rawPos, allScripts, captures);
    added++;
  }

  return added;
}

// The host strips every registered tag independently, so an outer tag's
// capture loses the inner tags. Scripts apply in index order on raw text in
// SillyTavern, so the outer block keeps them and the nested pipeline renders
// them in place. Swap such captures for the stored text's match and mark the
// inner captures as consumed.
const nestedReconciled = new Map<string, string>();

async function reconcileNestedTagCaptures(
  scripts: CompiledScript[],
  messageId: string,
  ctx: SpindleFrontendContext,
): Promise<void> {
  const caps = getCapturesForMessage(messageId);
  if (caps.length < 2) return;
  const tagScripts = scripts.filter((s) => (s.kind === 'pairedTag' || s.kind === 'strippedTag') && !s.native);
  if (tagScripts.length < 2) return;
  const sig = caps.map((c) => c.scriptId + '\u0001' + hashKey(c.fullMatch)).join('|');
  if (nestedReconciled.get(messageId) === sig) return;
  const chatId = ctx.getActiveChat().chatId;
  if (!chatId) return;
  const raw = await fetchMessageContent(chatId, messageId);
  if (!raw) return;
  const text = raw.replace(/\r\n?/g, '\n');
  for (const cap of caps) {
    const own = tagScripts.find((s) => s.id === cap.scriptId);
    if (!own) continue;
    const re = new RegExp(own.findRe.source, own.findRe.flags);
    let last: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      last = m;
      if (m[0].length === 0) re.lastIndex++;
    }
    if (!last || last[0] === cap.fullMatch.replace(/\r\n?/g, '\n')) continue;
    const block = last[0];
    const inner = caps.filter((o) => o !== cap && block.includes(o.fullMatch.replace(/\r\n?/g, '\n')));
    if (inner.length === 0) continue;
    cap.fullMatch = block;
    for (const o of inner) consumedPairedMatches.add(messageId + '\u0001' + o.fullMatch.replace(/\r\n?/g, '\n'));
  }
  nestedReconciled.set(messageId, caps.map((c) => c.scriptId + '\u0001' + hashKey(c.fullMatch)).join('|'));
}

// Where a stripped tag sat in the stored message, for ordering it among the
// other widgets when no authored-HTML anchor exists.
interface RawPosition { text: string; start: number; end: number }
const rawPosCache = new Map<string, RawPosition | null>();

async function rawPositionOf(messageId: string, fullMatch: string, ctx: SpindleFrontendContext): Promise<RawPosition | null> {
  const key = messageId + '\u0001' + hashKey(fullMatch);
  if (rawPosCache.has(key)) return rawPosCache.get(key) ?? null;
  const chatId = ctx.getActiveChat().chatId;
  if (!chatId) return null;
  let pos: RawPosition | null = null;
  try {
    const raw = await fetchMessageContent(chatId, messageId);
    if (raw) {
      const text = raw.replace(/\r\n?/g, '\n');
      const start = text.indexOf(fullMatch.replace(/\r\n?/g, '\n'));
      if (start >= 0) pos = { text, start, end: start + fullMatch.replace(/\r\n?/g, '\n').length };
    }
  } catch {
    pos = null;
  }
  if (rawPosCache.size > 256) rawPosCache.clear();
  rawPosCache.set(key, pos);
  return pos;
}

// At the top when only whitespace precedes the tag in the stored text; else
// before the first rendered widget whose source follows it; else at the end.
export function placeByRawOrder(
  target: HTMLElement,
  widget: Element,
  pos: RawPosition | null,
  scripts: CompiledScript[],
  captures: Array<{ scriptId: string; fullMatch: string }>,
): void {
  if (!pos) {
    target.appendChild(widget);
    return;
  }
  if (pos.text.slice(0, pos.start).trim() === '') {
    target.insertBefore(widget, target.firstChild);
    return;
  }
  let best: { el: Element; at: number } | null = null;
  for (const el of Array.from(target.querySelectorAll('[data-vishrun-widget]'))) {
    if (el === widget || !el.parentNode || el.parentElement?.closest('[data-vishrun-widget]')) continue;
    const at = rawIndexOfWidget(el, pos.text, scripts, captures);
    if (at === null || at < pos.end) continue;
    if (!best || at < best.at) best = { el, at };
  }
  if (best) best.el.parentNode!.insertBefore(widget, best.el);
  else target.appendChild(widget);
}

// Source offset of a rendered widget, or null when it cannot be told apart.
function rawIndexOfWidget(
  el: Element,
  text: string,
  scripts: CompiledScript[],
  captures: Array<{ scriptId: string; fullMatch: string }>,
): number | null {
  const sid = el.getAttribute('data-vishrun-script-id');
  if (!sid) return null;
  const fm = el.getAttribute('data-vishrun-paired-fullmatch');
  if (fm) {
    const cap = captures.find((c) => c.scriptId === sid && hashKey(c.fullMatch) === fm);
    if (!cap) return null;
    const i = text.indexOf(cap.fullMatch.replace(/\r\n?/g, '\n'));
    return i >= 0 ? i : null;
  }
  const script = scripts.find((s) => s.id === sid);
  if (!script) return null;
  const re = new RegExp(script.findRe.source, script.findRe.flags.includes('g') ? script.findRe.flags : script.findRe.flags + 'g');
  const first = re.exec(text);
  if (!first) return null;
  if (re.exec(text)) return null;
  return first.index;
}

// Anchors are only needed when the message renders authored HTML islands;
// plain markdown messages keep the append-at-end placement.
const anchorCache = new Map<string, PairedAnchor | null>();

async function resolvePairedAnchor(
  target: HTMLElement,
  messageId: string,
  fullMatch: string,
  ctx: SpindleFrontendContext,
): Promise<PairedAnchor | null> {
  if (!hasShadowHost(target)) return null;
  const key = messageId + '\u0001' + hashKey(fullMatch);
  if (anchorCache.has(key)) return anchorCache.get(key) ?? null;
  const chatId = ctx.getActiveChat().chatId;
  if (!chatId) return null;
  let anchor: PairedAnchor | null = null;
  try {
    const raw = await fetchMessageContent(chatId, messageId);
    anchor = raw ? computePairedAnchor(raw, fullMatch) : null;
  } catch {
    anchor = null;
  }
  if (anchorCache.size > 256) anchorCache.clear();
  anchorCache.set(key, anchor);
  return anchor;
}


function findContentRoot(messageNode: HTMLElement): HTMLElement {
  // Prefer MessageContent's own div — keeps widgets visually inside the
  // bubble, alongside the rendered markdown.
  const inner = messageNode.querySelector('[data-component="MessageContent"]') as HTMLElement | null;
  return inner ?? messageNode;
}

// ─── Shared helpers ────────────────────────────────────────────────────

async function buildWidget(
  html: string,
  scriptName: string,
  scriptId: string,
  messageId: string,
  ctx: SpindleFrontendContext,
): Promise<HTMLElement> {
  if (widgetNeedsIsolation(html)) {
    return buildWidgetIframe(html, scriptName, scriptId, messageId, ctx);
  }
  const wrapper = ctx.dom.createElement('div', {
    'data-vishrun-widget': scriptName,
    'data-vishrun-script-id': scriptId,
  }) as HTMLElement;
  // Match the iframe path's vertical breathing room (12px in widget-iframe.ts).
  // Without this, no-isolation widgets (innerHTML+div path) render flush
  // against adjacent message text and feel cramped — Step 6 user feedback.
  wrapper.style.margin = '12px 0';
  wrapper.innerHTML = html;
  return wrapper;
}

function collectTextNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walk = (node: Node): void => {
    for (const child of renderedChildNodes(node)) {
      if (child.nodeType === 3) {
        out.push(child as Text);
      } else if (child.nodeType === 1) {
        const el = child as Element;
        if (el.hasAttribute('data-vishrun-widget') || isNonTextElement(el)) continue;
        walk(el);
      }
    }
  };
  walk(root);
  return out;
}

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(s)
    : s.replace(/["\\]/g, '\\$&');
}

/**
 * Compress an arbitrary fullMatch string into a short stable token usable
 * inside an attribute selector. djb2 hash → base36; collisions don't
 * matter for the (scriptId, fullMatch) idempotency check because the
 * scriptId already disambiguates per-script, and within a single script
 * collisions on inner content of paired tags are vanishingly unlikely.
 */
function hashKey(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
