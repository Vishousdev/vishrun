// Tracks elements preset scripts add to the page body, so stopping the
// scripts removes their panels and buttons too. A stopped script cannot
// handle clicks, and a restarted one would reuse its dead elements by id.
// Lumiverse's own portals (React-managed nodes) are never touched.

function isHostNode(node: Node): boolean {
  if (!(node instanceof Element)) return true;
  if (node.hasAttribute('data-vishrun-preset-script') || node.hasAttribute('data-vishrun-dialog')) return true;
  return Object.keys(node).some((k) => k.startsWith('__react'));
}

export function trackPageNodes(doc: Document = document): () => void {
  const added = new Set<Element>();
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) if (n instanceof Element && !isHostNode(n)) added.add(n);
    }
  });
  observer.observe(doc.body, { childList: true });
  return () => {
    for (const r of observer.takeRecords()) {
      for (const n of r.addedNodes) if (n instanceof Element && !isHostNode(n)) added.add(n);
    }
    observer.disconnect();
    for (const el of added) {
      if (el.parentNode === doc.body && !isHostNode(el)) el.remove();
    }
    added.clear();
  };
}
