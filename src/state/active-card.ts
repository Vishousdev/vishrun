import type { RawRegexScript } from '../lumiverse/fetch-character';

export interface ActiveCard {
  characterId: string;
  characterName: string | null;
  scripts: RawRegexScript[];
  // Greeting data needed by the setChatMessages shim (Step 6). The widget
  // calls setChatMessages([{message_id:0, swipe_id:N}]) where N=0 means
  // first_mes and N>=1 means alternate_greetings[N-1]. Lumiverse does NOT
  // pre-populate message 0 with all alternate greetings as swipes (unlike
  // SillyTavern), so the bridge translates the call into a content rewrite
  // via PUT /chats/:id/messages/:id sourced from these fields.
  firstMes: string | null;
  alternateGreetings: string[];
  /** Rows (pattern + NUL + replacement) the host renders itself; Vishrun yields. */
  nativeKeys?: Set<string>;
}

let current: ActiveCard | null = null;

export function getActiveCard(): ActiveCard | null {
  return current;
}

export function setActiveCard(card: ActiveCard): void {
  current = card;
}

export function clearActiveCard(): void {
  current = null;
}
