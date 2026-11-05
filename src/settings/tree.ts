// Read-only tree of a variables object. Branches start closed and stay as the
// user left them across re-renders, through `open` (keyed by path).

export function renderTree(value: unknown, path: string, open: Set<string>, depth = 0): HTMLElement {
  const box = document.createElement('div');
  box.className = depth === 0 ? 'vr-tree' : 'vr-tree-children';
  if (!value || typeof value !== 'object') {
    box.append(leaf('', value));
    return box;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (child && typeof child === 'object' && Object.keys(child).length > 0) {
      const details = document.createElement('details');
      details.open = open.has(childPath);
      const summary = document.createElement('summary');
      const k = document.createElement('span');
      k.className = 'vr-key';
      k.textContent = key;
      summary.append(k, document.createTextNode(Array.isArray(child) ? ` [${child.length}]` : ` {${Object.keys(child).length}}`));
      details.append(summary, renderTree(child, childPath, open, depth + 1));
      details.addEventListener('toggle', () => {
        if (details.open) open.add(childPath); else open.delete(childPath);
      });
      box.append(details);
    } else {
      box.append(leaf(key, child));
    }
  }
  return box;
}

function leaf(key: string, value: unknown): HTMLElement {
  const row = document.createElement('div');
  row.className = 'vr-leaf';
  if (key) {
    const k = document.createElement('span');
    k.className = 'vr-key';
    k.textContent = `${key}: `;
    row.append(k);
  }
  row.append(document.createTextNode(format(value)));
  return row;
}

function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return '[]';
  if (value && typeof value === 'object') return '{}';
  return String(value);
}
