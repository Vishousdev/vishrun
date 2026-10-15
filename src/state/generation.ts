// Whether the host is currently streaming a reply in the active chat.
let generating = false;

export function setGenerating(v: boolean): void {
  generating = v;
}

export function isGenerating(): boolean {
  return generating;
}

export function isLatestMessage(messageId: string, doc: Document = document): boolean {
  const all = doc.querySelectorAll('[data-message-id]');
  const last = all[all.length - 1];
  return !!last && last.getAttribute('data-message-id') === messageId;
}
