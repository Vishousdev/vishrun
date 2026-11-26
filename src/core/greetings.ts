// Lumiverse shows a greeting by rewriting message 0, so its swipe id stays 0.
// The greeting shown is found by matching the text against the card's
// greetings (first_mes, then alternate_greetings).

const norm = (s: unknown) => String(s ?? '').replace(/\r\n?/g, '\n').trim();

export function cardGreetings(card: { firstMes: string | null; alternateGreetings: string[] } | null): string[] {
  return card ? [card.firstMes ?? '', ...card.alternateGreetings] : [];
}

// Index of the greeting shown, or -1 when the text matches none (edited).
export function greetingIndex(content: unknown, greetings: string[]): number {
  const shown = norm(content);
  return greetings.findIndex((g) => norm(g) === shown);
}

// SillyTavern swipes of a message: message 0 holds the card greetings, with
// the one shown as swipe_id. Other messages have their own text only.
export function greetingSwipes(index: number, isUser: boolean, content: string, greetings: string[]): { swipe_id: number; swipes: string[] } {
  return index === 0 && !isUser && greetings.length > 1
    ? { swipe_id: greetingIndex(content, greetings), swipes: [...greetings] }
    : { swipe_id: 0, swipes: [content] };
}
