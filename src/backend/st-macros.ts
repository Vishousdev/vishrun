import { api } from './common';

// SillyTavern macros on Lumiverse, without touching the card.
// ST's {{getvar}} family reads the chat variables scripts write; Lumiverse's
// equivalent is {{getchatvar}}. ST's {{getglobalvar}} reads the user-wide store
// scripts write; Lumiverse's reads a per-chat copy, so fill it here.

const LOCAL_RE = /\{\{(get|set|add|inc|dec)var::/gi;
const GLOBAL_RE = /\{\{(?:getglobalvar|getgvar)::([^}]+)\}\}/gi;

export function toChatVarMacros(template: string): string {
  return template.replace(LOCAL_RE, (_m, op: string) => `{{${op.toLowerCase()}chatvar::`);
}

export async function stMacros(
  template: string,
  userId?: string,
  listGlobals: (userId?: string) => Promise<Record<string, string>> = (u) => api.variables.global.list(u),
): Promise<string> {
  const text = toChatVarMacros(template);
  if (!/\{\{(?:getglobalvar|getgvar)::/i.test(text)) return text;
  const globals = await listGlobals(userId).catch(() => ({} as Record<string, string>));
  return text.replace(GLOBAL_RE, (m, k: string) => globals[k.trim()] ?? m);
}
