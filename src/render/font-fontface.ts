// Picks the font files a widget needs. Sliced fonts (unicode-range) only
// load the slices covering characters drawn with that family, at the nearest
// weight and style, the way a browser does; unsliced fonts always load.
// Self-contained: widget-iframe.ts injects its source into the frame.

export interface FontEntryLike {
  family: string;
  url: string;
  weight?: string;
  style?: string;
  range?: string;
  /** Parsed `range`, kept between calls. */
  _r?: number[][];
}

export interface FontUsage {
  families: string[];
  weight: number;
  style: string;
  text: string;
}

export function selectFontEntries<T extends FontEntryLike>(entries: T[], usages: FontUsage[]): T[] {
  const norm = (s: string) => s.trim().replace(/^['"]|['"]$/g, '').trim().toLowerCase();
  const ranges = (r: string) =>
    r.split(',').map((t) => {
      const m = /^\s*u\+([0-9a-f?]+)(?:-([0-9a-f]+))?\s*$/i.exec(t);
      if (!m) return [1, 0];
      if (m[2]) return [parseInt(m[1], 16), parseInt(m[2], 16)];
      return [parseInt(m[1].replace(/\?/g, '0'), 16), parseInt(m[1].replace(/\?/g, 'f'), 16)];
    });
  const weights = (w?: string) => {
    const n = (x: string) => (x === 'bold' ? 700 : x === 'normal' ? 400 : parseFloat(x));
    const p = (w || '400').trim().split(/\s+/).map(n).filter((x) => !isNaN(x));
    return p.length ? [p[0], p[p.length - 1]] : [400, 400];
  };
  const out = new Set<T>();
  const sliced = new Map<string, Array<{ e: T; r: number[][]; w: number[]; italic: boolean }>>();
  for (const e of entries) {
    if (!e.range) { out.add(e); continue; }
    const key = norm(e.family);
    const list = sliced.get(key) || [];
    if (!e._r) e._r = ranges(e.range);
    list.push({ e, r: e._r, w: weights(e.weight), italic: /italic|oblique/i.test(e.style || '') });
    sliced.set(key, list);
  }
  for (const u of usages) {
    const italic = /italic|oblique/i.test(u.style);
    const codes = new Set<number>();
    for (const ch of u.text) codes.add(ch.codePointAt(0) as number);
    for (const fam of u.families) {
      const list = sliced.get(norm(fam));
      if (!list) continue;
      for (const c of codes) {
        let best: (typeof list)[number] | null = null;
        let bestScore = Infinity;
        for (const s of list) {
          if (!s.r.some((r) => c >= r[0] && c <= r[1])) continue;
          const dist = u.weight < s.w[0] ? s.w[0] - u.weight : u.weight > s.w[1] ? u.weight - s.w[1] : 0;
          const score = dist + (s.italic === italic ? 0 : 10000);
          if (score < bestScore) { best = s; bestScore = score; }
        }
        if (best) out.add(best.e);
      }
    }
  }
  return entries.filter((e) => out.has(e));
}
