// Lumiverse renders authored HTML with <style> blocks inside open shadow roots
// ("islands"). These helpers extend light-DOM traversal across those roots.

export function parentAcrossShadow(node: Node): Node | null {
  if (node.parentNode) {
    const p = node.parentNode;
    return p.nodeType === 11 && (p as ShadowRoot).host ? (p as ShadowRoot).host : p;
  }
  return null;
}

export function deepContains(root: Node, node: Node): boolean {
  let cur: Node | null = node;
  while (cur) {
    if (cur === root) return true;
    cur = parentAcrossShadow(cur);
  }
  return false;
}

export function deepClosest(el: Element, selector: string): Element | null {
  let cur: Node | null = el;
  while (cur) {
    if (cur.nodeType === 1 && (cur as Element).matches(selector)) return cur as Element;
    cur = parentAcrossShadow(cur);
  }
  return null;
}

export function deepQuerySelectorAll<T extends Element = Element>(root: ParentNode, selector: string): T[] {
  const out: T[] = [];
  const visit = (scope: ParentNode): void => {
    scope.querySelectorAll<T>(selector).forEach((el) => out.push(el));
    scope.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) visit(el.shadowRoot);
    });
  };
  visit(root);
  return out;
}

export function deepQuerySelector<T extends Element = Element>(root: ParentNode, selector: string): T | null {
  return deepQuerySelectorAll<T>(root, selector)[0] ?? null;
}

export function hasShadowHost(root: ParentNode): boolean {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (el.shadowRoot) return true;
  }
  return false;
}

// Children as rendered: a shadow host shows its shadow tree, not its light children.
export function renderedChildNodes(node: Node): Node[] {
  const sr = node.nodeType === 1 ? (node as Element).shadowRoot : null;
  return Array.from((sr ?? node).childNodes);
}

const NON_TEXT_TAGS = new Set(['STYLE', 'SCRIPT', 'TEMPLATE', 'NOSCRIPT']);

export function isNonTextElement(el: Element): boolean {
  return NON_TEXT_TAGS.has(el.tagName);
}

export function deepTextContent(root: Node): string {
  let s = '';
  const walk = (n: Node): void => {
    if (n.nodeType === 3) { s += n.nodeValue ?? ''; return; }
    if (n.nodeType !== 1 && n.nodeType !== 11) return;
    if (n.nodeType === 1 && isNonTextElement(n as Element)) return;
    for (const c of renderedChildNodes(n)) walk(c);
  };
  walk(root);
  return s;
}
