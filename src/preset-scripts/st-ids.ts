// Recovers SillyTavern prompt identifiers for an imported preset. Lumiverse's
// ST import gives every prompt a new block id, but scripts and BaiBai groups
// refer to the original identifiers. Given the original ST preset JSON, each
// ST prompt is matched to a block, following the importer's order
// (prompt_order first, then leftover prompts).

const ST_IDENTIFIER_TO_MARKER: Record<string, string> = {
  chatHistory: 'chat_history',
  worldInfoBefore: 'world_info_before',
  worldInfoAfter: 'world_info_after',
  charDescription: 'char_description',
  charPersonality: 'char_personality',
  personaDescription: 'persona_description',
  scenario: 'scenario',
  dialogueExamples: 'dialogue_examples',
  main: 'main_prompt',
  enhanceDefinitions: 'enhance_definitions',
  jailbreak: 'jailbreak',
  nsfw: 'nsfw_prompt',
};

interface StPrompt {
  identifier?: unknown;
  name?: unknown;
  content?: unknown;
}

export interface BlockLike {
  id: string;
  name?: string;
  content?: string;
  marker?: string | null;
}

export interface StIdMatch {
  /** Lumiverse block id → SillyTavern identifier. */
  map: Record<string, string>;
  total: number;
  unmatched: string[];
}

// Same sequence the Lumiverse ST importer builds blocks in.
export function stPromptSequence(preset: unknown): StPrompt[] {
  const data = (preset ?? {}) as { prompts?: unknown; prompt_order?: unknown };
  const prompts = Array.isArray(data.prompts) ? (data.prompts as StPrompt[]) : [];
  const byId = new Map<string, StPrompt>();
  for (const p of prompts) if (typeof p?.identifier === 'string') byId.set(p.identifier, p);

  const order: string[] = [];
  const po = data.prompt_order as Record<string, { order?: { identifier?: unknown }[] }> | undefined;
  if (po && typeof po === 'object') {
    const keys = Object.keys(po).filter((k) => po[k]?.order?.length).sort((a, b) => Number(b) - Number(a));
    if (keys.length) for (const e of po[keys[0]].order!) if (typeof e?.identifier === 'string') order.push(e.identifier);
  }

  const out: StPrompt[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const p = byId.get(id);
    if (!p || seen.has(id)) continue;
    seen.add(id);
    out.push(p);
  }
  for (const p of prompts) {
    const id = typeof p?.identifier === 'string' ? p.identifier : '';
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.push(p);
  }
  return out;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function matchStIds(preset: unknown, blocks: BlockLike[]): StIdMatch {
  const sequence = stPromptSequence(preset);
  const used = new Set<number>();
  const map: Record<string, string> = {};
  const unmatched: string[] = [];

  const firstUnused = (pred: (b: BlockLike) => boolean, from = 0): number => {
    for (let i = from; i < blocks.length; i++) if (!used.has(i) && pred(blocks[i])) return i;
    for (let i = 0; i < from && i < blocks.length; i++) if (!used.has(i) && pred(blocks[i])) return i;
    return -1;
  };

  let cursor = 0;
  for (const p of sequence) {
    const id = str(p.identifier);
    if (!id) continue;
    const name = str(p.name);
    const content = str(p.content);
    const marker = ST_IDENTIFIER_TO_MARKER[id];
    let idx = marker
      ? firstUnused((b) => b.marker === marker, cursor)
      : firstUnused((b) => !isSystemMarker(b) && (b.name ?? '') === name && (b.content ?? '') === content, cursor);
    // Edited after import: same name in order, then same content if unique.
    if (idx < 0 && !marker) idx = firstUnused((b) => !isSystemMarker(b) && (b.name ?? '') === name, cursor);
    if (idx < 0 && !marker && content) {
      const hits = blocks.map((b, i) => i).filter((i) => !used.has(i) && blocks[i].content === content);
      if (hits.length === 1) idx = hits[0];
    }
    if (idx < 0) { unmatched.push(name || id); continue; }
    used.add(idx);
    map[blocks[idx].id] = id;
    cursor = idx + 1;
  }
  return { map, total: sequence.length, unmatched };
}

function isSystemMarker(b: BlockLike): boolean {
  return !!b.marker && b.marker !== 'category';
}

const MARKER_TO_ST_IDENTIFIER: Record<string, string> = Object.fromEntries(
  Object.entries(ST_IDENTIFIER_TO_MARKER).map(([id, marker]) => [marker, id]),
);

// The SillyTavern identifier a block is known by: a linked id, the fixed id of
// a system marker, or the block id itself (presets imported with ST ids kept).
export function stIdOf(block: BlockLike, links: Record<string, string>): string {
  return links[block.id] ?? (block.marker ? MARKER_TO_ST_IDENTIFIER[block.marker] : undefined) ?? block.id;
}

// Ids the scripts' data refers to that no block answers to.
export function referencesUnknownIds(metadata: Record<string, unknown>, blocks: BlockLike[]): boolean {
  const groups = (metadata?.baibaiToolkit as { presetPromptGroups?: { prompts?: Record<string, unknown> } } | undefined)
    ?.presetPromptGroups?.prompts;
  if (!groups || typeof groups !== 'object') return false;
  const ids = new Set(blocks.map((b) => stIdOf(b, {})));
  return Object.keys(groups).some((k) => !ids.has(k));
}
