// Hidden stand-ins for SillyTavern form fields that preset scripts write to.
// `#start_reply_with` is SillyTavern's "Start Reply With"; Lumiverse keeps the
// same thing as the preset's assistant prefill, so writes are forwarded there.

export const STAND_IN_ATTR = 'data-vishrun-st-stand-in';

export function installStandIns(
  initialPrefill: string,
  onPrefill: (value: string) => void,
  doc: Document = document,
): () => void {
  if (doc.getElementById('start_reply_with')) return () => {};
  const box = doc.createElement('div');
  box.setAttribute(STAND_IN_ATTR, '');
  box.hidden = true;

  const prefill = doc.createElement('textarea');
  prefill.id = 'start_reply_with';
  const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
  let timer: ReturnType<typeof setTimeout> | null = null;
  Object.defineProperty(prefill, 'value', {
    configurable: true,
    get() { return proto.get!.call(this); },
    set(v: string) {
      const prev = proto.get!.call(this);
      proto.set!.call(this, v);
      if (String(v) === prev) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => onPrefill(String(v)), 200);
    },
  });
  proto.set!.call(prefill, initialPrefill);

  const show = doc.createElement('input');
  show.type = 'checkbox';
  show.id = 'chat-show-reply-prefix-checkbox';
  show.checked = true;

  box.append(prefill, show);
  doc.body.appendChild(box);
  return () => {
    if (timer) clearTimeout(timer);
    box.remove();
  };
}
