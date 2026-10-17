// Recognizer pipeline for <UpdateVariable> blocks emitted by MVU-aware
// cards. V1 ships InitvarYamlRecognizer only; Phase 2+ appends
// LodashCommandRecognizer, JsonPatchRecognizer, DeltaTokenRecognizer.
//
// The state is a pure function of message content: handleGetVariablesSnapshot
// fetches all chat messages and pipes them through computeVariablesSnapshot
// on every read. No persistence layer.

import { parseYaml } from './mvu-yaml';
import { parseLodashSetCalls, type LiteralValue } from './mvu-lodash';
import { VSH_VISHRUN_DIAG } from '../core/diagnostics';

export type { LiteralValue } from './mvu-lodash';

export interface MvuData {
  stat_data: Record<string, unknown>;
  [key: string]: unknown;
}

export function emptyMvuData(): MvuData {
  return { stat_data: {} };
}

// ---- Pipeline types ----

// Permissive shape — accepts ChatMessageDTO (which always carries swipes /
// swipe_id / index_in_chat / extra) as well as bare {content: string} test
// fixtures. Resolution prefers swipes[swipe_id] so the replay tracks the
// user's current swipe.
export interface ChatMessageContent {
  content?: string;
  swipes?: string[];
  swipe_id?: number;
  id?: string;
  index_in_chat?: number;
  extra?: Record<string, unknown>;
}

// Lazy fetcher of the card's greetings ([first_mes, ...alternate_greetings]).
// Invoked at most once per snapshot replay, only when recovery is needed.
export type CardGreetingFetcher = () => Promise<string[]>;

// Returns the content the replay should scan. ChatMessageDTO.content is
// documented as a mirror of swipes[swipe_id], but reading swipes directly
// removes the dependency on that mirror staying coherent under all swipe
// flows (alt-greeting swipes in particular).
export function resolveActiveContent(msg: ChatMessageContent): string {
  const swipes = msg.swipes;
  const swipeId = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
  if (Array.isArray(swipes) && swipes.length > 0) {
    const c = swipes[swipeId];
    if (typeof c === 'string' && c.length > 0) return c;
  }
  if (typeof msg.content === 'string') return msg.content;
  return '';
}

export interface Operation {
  kind: string;
  index: number;
  [k: string]: unknown;
}

export interface ReplaceStatDataOp extends Operation {
  kind: 'replace_stat_data';
  payload: Record<string, unknown>;
}

export interface SetPathOp extends Operation {
  kind: 'set_path';
  path: string;
  value: LiteralValue;
}

// Optional context threaded into each recognizer per-block invocation.
// Recognizers can ignore it (InitvarYamlRecognizer does); the lodash-set
// recognizer uses onDiagnostic to surface unknown commands per message.
export interface RecognizerContext {
  messageId: string | null;
  onDiagnostic?: (event: string, payload: Record<string, unknown>) => void;
}

export interface Recognizer {
  name: string;
  extract(block: string, ctx?: RecognizerContext): Operation[];
}

// ---- Block extraction ----

const BLOCK_RE = /<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/gim;
const INITVAR_RE = /<initvar>(?:\s*```.*)?([\s\S]*?)(?:```\s*)?<\/initvar>/gim;

export function extractUpdateVariableBlocks(content: string): string[] {
  if (typeof content !== 'string' || !/<updatevariable>/i.test(content)) return [];
  const out: string[] = [];
  for (const m of content.matchAll(BLOCK_RE)) out.push(m[1]);
  return out;
}

// ---- V1 recognizer: <initvar>YAML</initvar> ----

export const InitvarYamlRecognizer: Recognizer = {
  name: 'initvar-yaml',
  extract(block: string): Operation[] {
    const ops: Operation[] = [];
    for (const m of block.matchAll(INITVAR_RE)) {
      try {
        const payload = parseYaml(m[1]);
        ops.push({ kind: 'replace_stat_data', index: m.index ?? 0, payload });
      } catch (err) {
        console.warn(
          '[vishrun:mvu-parser] initvar yaml parse failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return ops;
  },
};

// ---- Phase 2a recognizer: _.set(...) lodash calls ----
//
// Cumulative LLM-emitted variable updates. Block-additive: a block
// containing both <initvar> and _.set calls runs both recognizers; ops
// are sorted by source position before apply, so the initvar seed lands
// first and _.sets land after. The InitvarYamlRecognizer is unchanged.

export const LodashSetRecognizer: Recognizer = {
  name: 'lodash-set',
  extract(block: string, ctx?: RecognizerContext): Operation[] {
    const calls = parseLodashSetCalls(block, (snippet, reason) => {
      ctx?.onDiagnostic?.('unknown-command', { snippet, reason });
    });
    return calls.map((c) => ({
      kind: 'set_path',
      index: c.index,
      path: c.path,
      value: c.newValue,
    }));
  },
};

// Phase 2a appends LodashSetRecognizer. Phase 2b+ adds JsonPatchRecognizer,
// DeltaTokenRecognizer.
export const recognizers: Recognizer[] = [InitvarYamlRecognizer, LodashSetRecognizer];

// ---- Apply ----

// Immutable set-at-path. Clones along the modified branch only; other
// branches of the tree share references with the input. Cheaper than
// structuredClone for narrow updates, and preserves the applyOperation
// contract (the caller's state object is not mutated).
//
// `parseDottedPath` returns null for paths we don't support this
// iteration (bracket notation, backslash escapes). The caller logs and
// skips on null — the input state is returned unchanged.
function parseDottedPath(path: string): string[] | null {
  if (path.length === 0) return null;
  if (path.indexOf('[') !== -1 || path.indexOf(']') !== -1) return null;
  if (path.indexOf('\\') !== -1) return null;
  return path.split('.');
}

function setDeepImmutable(
  root: Record<string, unknown>,
  segments: string[],
  value: unknown,
): Record<string, unknown> {
  if (segments.length === 0) return root;
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    return { ...root, [head]: value };
  }
  const child = root[head];
  const childObj =
    child !== null && typeof child === 'object' && !Array.isArray(child)
      ? (child as Record<string, unknown>)
      : {};
  return { ...root, [head]: setDeepImmutable(childObj, rest, value) };
}

/**
 * Apply a single Operation to the state.
 *
 * MVU convention: `_.set` paths are RELATIVE to `state.stat_data`,
 * NOT absolute from the state root. The LLM emits bare paths like
 * `'世界.当前地点'`; the widget reads with the full
 * `'stat_data.世界.当前地点'` prefix via `getAllVariables()`.
 * Cards in scope (Queen Bee, Dreams) follow this convention. A card
 * that emits paths with an explicit `'stat_data.'` prefix is non-
 * canonical and currently NOT supported (the prefix would be treated
 * as a literal segment, landing at `state.stat_data.stat_data.X` —
 * surfaced via the `set-path-applied` diagnostic log).
 */
export function applyOperation(state: MvuData, op: Operation): MvuData {
  if (op.kind === 'replace_stat_data') {
    const payload = (op as ReplaceStatDataOp).payload;
    return { ...state, stat_data: { ...payload } };
  }
  if (op.kind === 'set_path') {
    const sop = op as SetPathOp;
    const segments = parseDottedPath(sop.path);
    if (segments === null) {
      // Path shape unsupported (bracket notation, escapes). Caller's
      // recognizer already logged via onDiagnostic; here we just no-op.
      return state;
    }
    // Bare path applied inside state.stat_data. Defensive: if
    // stat_data isn't present (no preceding initvar, orphan chat),
    // create it so the LLM's update lands somewhere readable rather
    // than silently dropping.
    const currentStatData =
      state.stat_data && typeof state.stat_data === 'object' && !Array.isArray(state.stat_data)
        ? (state.stat_data as Record<string, unknown>)
        : {};
    const nextStatData = setDeepImmutable(currentStatData, segments, sop.value);
    return { ...state, stat_data: nextStatData };
  }
  return state;
}

// ---- Replay ----

// FNV-1a hash. Matches the host's precedent (see Lumiverse message-content
// processor docs §"render origin fires twice per visible message") so any
// future cross-subsystem cache keying can share the same scheme.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function stripUpdateVariableBlocks(s: string): string {
  return s.replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '');
}

function hashStripped(s: string): number {
  return fnv1a(stripUpdateVariableBlocks(s));
}

// Replay snapshot. Async because the recovery path may fetch the card.
//
// recoveryFetcher: optional. When the active content of message 0 has no
// <UpdateVariable> block (existing chat written under buggy code, imported
// chat, etc.), the fetcher is invoked at most once to retrieve the card's
// greetings; the matching candidate's block seeds the snapshot.
export async function computeVariablesSnapshot(
  messages: ChatMessageContent[],
  recoveryFetcher?: CardGreetingFetcher,
  seed?: Record<string, unknown>,
): Promise<MvuData> {
  // Lorebook [initvar] seed; a greeting <initvar> replaces it, as in MVU.
  let state: MvuData = { stat_data: { ...(seed ?? {}) } };
  let cachedCandidates: string[] | null = null;
  let candidatesTried = false;

  for (const msg of messages) {
    if (!msg) continue;
    const activeContent = resolveActiveContent(msg);
    if (activeContent.length === 0) continue;
    let blocks = extractUpdateVariableBlocks(activeContent);

    // Recovery: only for message 0 (greeting) with no <UpdateVariable>
    // in the active content. Match against card greetings by hashing the
    // stripped form of each candidate against the stripped active content.
    if (
      blocks.length === 0 &&
      msg.index_in_chat === 0 &&
      recoveryFetcher !== undefined
    ) {
      if (!candidatesTried) {
        candidatesTried = true;
        try {
          cachedCandidates = await recoveryFetcher();
        } catch (err) {
          console.warn(
            '[vishrun:mvu-parser] recovery fetcher threw:',
            err instanceof Error ? err.message : String(err),
          );
          cachedCandidates = [];
        }
      }
      const candidates = cachedCandidates ?? [];
      const targetHash = hashStripped(activeContent);
      let matchIdx = -1;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (typeof c !== 'string') continue;
        if (hashStripped(c) === targetHash) {
          matchIdx = i;
          break;
        }
      }
      if (matchIdx >= 0) {
        blocks = extractUpdateVariableBlocks(candidates[matchIdx]);
      }
    }

    const messageIdForCtx = typeof msg.id === 'string' ? msg.id : null;
    const recognizerCtx: RecognizerContext = {
      messageId: messageIdForCtx,
      onDiagnostic: (event, payload) => {
        if (!VSH_VISHRUN_DIAG) return;
        console.log(`[vishrun:mvu-parser] ${event}`, JSON.stringify({
          messageId: messageIdForCtx,
          ...payload,
        }));
      },
    };
    for (const block of blocks) {
      const ops: Operation[] = [];
      for (const r of recognizers) ops.push(...r.extract(block, recognizerCtx));
      ops.sort((a, b) => a.index - b.index);
      for (const op of ops) {
        state = applyOperation(state, op);
      }
    }
  }
  return state;
}

// ---- Legacy `_.set` parser kept for Phase 2a ----
// Not wired into the V1 recognizer pipeline. Phase 2a wraps these into a
// LodashCommandRecognizer.

const SET_CALL_RE =
  /_\.set\s*\(\s*(['"])([^'"]+)\1\s*,\s*(?:(['"])([\s\S]*?)\3|(-?\d+(?:\.\d+)?)|(true|false|null))\s*\)/g;

export function lodashSet(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = cur[key];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

export interface MvuCommand {
  path: string;
  value: unknown;
}

export interface ParseResult {
  commands: MvuCommand[];
  strippedContent: string;
}

export function parseMvuBlocks(content: string): ParseResult {
  if (!content.includes('<UpdateVariable>')) {
    return { commands: [], strippedContent: content };
  }
  const commands: MvuCommand[] = [];
  for (const blockMatch of content.matchAll(BLOCK_RE)) {
    const body = blockMatch[1];
    SET_CALL_RE.lastIndex = 0;
    let setMatch: RegExpExecArray | null;
    while ((setMatch = SET_CALL_RE.exec(body)) !== null) {
      const path = setMatch[2];
      let value: unknown;
      if (setMatch[4] !== undefined) {
        value = setMatch[4];
      } else if (setMatch[5] !== undefined) {
        value = Number(setMatch[5]);
      } else if (setMatch[6] !== undefined) {
        const lit = setMatch[6];
        value = lit === 'null' ? null : lit === 'true';
      }
      commands.push({ path, value });
    }
  }
  const strippedContent = content.replace(BLOCK_RE, '');
  return { commands, strippedContent };
}

export function applyMvuCommands(blob: MvuData, commands: MvuCommand[]): MvuData {
  for (const cmd of commands) {
    lodashSet(blob as Record<string, unknown>, cmd.path, cmd.value);
  }
  return blob;
}
