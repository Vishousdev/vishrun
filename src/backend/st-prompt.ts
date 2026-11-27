import type { LlmMessageDTO } from 'lumiverse-spindle-types';
import { api } from './common';
import { stMacros } from './st-macros';
import { needsSt, stDecisions, type StEntry } from '../core/st-lorebook';

// SillyTavern prompt behaviour Lumiverse lacks: the card's Character's Note
// (extensions.depth_prompt) placed at its depth, and lorebook entries matched
// the ST way (see core/st-lorebook).

interface DepthPrompt { prompt: string; depth: number; role: 'system' | 'user' | 'assistant' }

interface CardLike {
  description?: string; personality?: string; scenario?: string; creator_notes?: string;
  extensions?: { depth_prompt?: unknown };
}

// Cards can be several MB; read once per 30s instead of every generation.
const cards = new Map<string, { at: number; card: CardLike | null }>();
async function cardOf(characterId: string, userId?: string): Promise<CardLike | null> {
  const hit = cards.get(characterId);
  if (hit && Date.now() - hit.at < 30_000) return hit.card;
  const card = (await api.characters.get(characterId, userId).catch(() => null)) as CardLike | null;
  cards.set(characterId, { at: Date.now(), card });
  return card;
}

export function depthPromptOf(card: CardLike | null): DepthPrompt | null {
  const d = card?.extensions?.depth_prompt as { prompt?: unknown; depth?: unknown; role?: unknown } | undefined;
  if (typeof d?.prompt !== 'string' || !d.prompt.trim()) return null;
  const depth = Number.isInteger(d.depth) && (d.depth as number) >= 0 ? d.depth as number : 4;
  const role = d.role === 'user' || d.role === 'assistant' ? d.role : 'system';
  return { prompt: d.prompt, depth, role };
}

// userId is required: Vishrun installs operator-scoped.
async function noteText(dp: DepthPrompt | null, chatId: string, characterId: string, userId?: string): Promise<string> {
  if (!dp) return '';
  const text = await stMacros(dp.prompt, userId);
  try { return (await api.macros.resolve(text, { chatId, characterId, userId, commit: false })).text.trim(); } catch { return text; }
}

// The prompt interceptor's context can lack characterId; the chat has it.
async function characterOf(chatId: string, characterId: string | null | undefined, userId?: string): Promise<string | null> {
  if (characterId) return characterId;
  const chat = await api.chats.get(chatId, userId).catch(() => null);
  return (chat as { character_id?: string } | null)?.character_id ?? null;
}

// ST's setExtensionPrompt values per chat. position: 1 in chat at depth;
// 0 and 2 (before the story) go above the chat history. role: 0 system,
// 1 user, 2 assistant.
interface ExtPrompt { value: string; position: number; depth: number; role: number }
const extPrompts = new Map<string, Map<string, ExtPrompt>>();

export function setExtensionPrompt(chatId: string, key: string, p: ExtPrompt): void {
  let chat = extPrompts.get(chatId);
  if (!chat) extPrompts.set(chatId, (chat = new Map()));
  if (p.value.trim() && p.position >= 0) chat.set(key, p); else chat.delete(key);
}

const EXT_ROLES = ['system', 'user', 'assistant'] as const;

// Insert so that `depth` chat-history turns follow it, as ST does.
export function insertAtDepth(messages: LlmMessageDTO[], note: LlmMessageDTO, depth: number): { messages: LlmMessageDTO[]; index: number } {
  const history = messages.map((m, i) => (m.__isChatHistory ? i : -1)).filter((i) => i >= 0);
  if (history.length === 0) return { messages, index: -1 };
  const index = depth === 0 ? history[history.length - 1] + 1 : history[Math.max(0, history.length - depth)];
  return { messages: [...messages.slice(0, index), note, ...messages.slice(index)], index };
}

// Needs the interceptor and generation permissions; without them the host
// refuses the registration and nothing changes.
export function installStPrompt(): void {
  try {
    api.registerInterceptor(async (messages, ctx) => {
      const inserts: { note: LlmMessageDTO; depth: number; name: string }[] = [];
      const characterId = await characterOf(ctx.chatId, ctx.characterId, ctx.userId);
      const dp = characterId ? depthPromptOf(await cardOf(characterId, ctx.userId)) : null;
      const text = characterId ? await noteText(dp, ctx.chatId, characterId, ctx.userId) : '';
      if (dp && text) inserts.push({ note: { role: dp.role, content: text }, depth: dp.depth, name: "Character's Note" });
      for (const [key, p] of extPrompts.get(ctx.chatId) ?? []) {
        inserts.push({ note: { role: EXT_ROLES[p.role] ?? 'system', content: p.value }, depth: p.position === 1 ? p.depth : Infinity, name: key });
      }
      let out = messages;
      const breakdown: { messageIndex: number; name: string }[] = [];
      for (const ins of inserts) {
        const r = insertAtDepth(out, ins.note, ins.depth);
        if (r.index < 0) continue;
        for (const b of breakdown) if (b.messageIndex >= r.index) b.messageIndex++;
        breakdown.push({ messageIndex: r.index, name: ins.name });
        out = r.messages;
      }
      return breakdown.length ? { messages: out, breakdown } : messages;
    });
  } catch (e) { console.warn('[vishrun] Character\'s Note needs the interceptor permission', e); }

  try {
    api.registerWorldInfoInterceptor(async (ctx) => {
      const touched = (ctx.entries as unknown as StEntry[]).filter(needsSt);
      if (touched.length === 0 || !ctx.characterId) return;
      const card = await cardOf(ctx.characterId, ctx.userId);
      const persona = touched.some((e) => e.extensions?.match_persona_description === true)
        ? (await api.personas.getActive(ctx.userId).catch(() => null))?.description ?? '' : '';
      const sources = {
        depthPrompt: await noteText(depthPromptOf(card), ctx.chatId, ctx.characterId, ctx.userId),
        description: card?.description, personality: card?.personality, scenario: card?.scenario,
        creatorNotes: card?.creator_notes, persona,
      };
      return stDecisions(touched, ctx.messages.map((m) => m.content), sources, ctx.activationSettings.globalScanDepth);
    });
  } catch (e) { console.warn('[vishrun] ST lorebook matching needs the generation permission', e); }
}
