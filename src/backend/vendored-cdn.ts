import tailwind from '../vendor/cdn/tailwind-browser-4.1.18.js.txt';
import react from '../vendor/cdn/react-18.3.1.min.js.txt';
import reactDom from '../vendor/cdn/react-dom-18.3.1.min.js.txt';
import babel from '../vendor/cdn/babel-standalone-7.26.10.min.js.txt';
import vue from '../vendor/cdn/vue-3.5.13.global.prod.js.txt';

// Cards load these from public CDNs; the host proxy no longer serves JavaScript,
// so Vishrun ships pinned builds and answers those URLs locally.

interface VendoredLib {
  id: string;
  hosts: ReadonlySet<string>;
  path: RegExp;
  body: string;
}

const PACKAGE_CDNS = new Set(['unpkg.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com']);

const LIBS: VendoredLib[] = [
  { id: 'tailwind', hosts: new Set(['cdn.tailwindcss.com']), path: /^\/(?:[\d.]+\/?)?$/, body: tailwind },
  { id: 'react', hosts: PACKAGE_CDNS, path: /\/react(?:@18(?:\.[\d.]+)?)?\/umd\/react\.(?:production\.min|development)\.js$|\/ajax\/libs\/react\/18[\d.]*\/umd\/react\.(?:production\.min|development)\.js$/, body: react },
  { id: 'react-dom', hosts: PACKAGE_CDNS, path: /\/react-dom(?:@18(?:\.[\d.]+)?)?\/umd\/react-dom\.(?:production\.min|development)\.js$|\/ajax\/libs\/react-dom\/18[\d.]*\/umd\/react-dom\.(?:production\.min|development)\.js$/, body: reactDom },
  { id: 'babel', hosts: PACKAGE_CDNS, path: /\/(?:npm\/)?@babel\/standalone(?:@7[\d.]*)?\/babel(?:\.min)?\.js$|\/ajax\/libs\/babel-standalone\/7[\d.]*\/babel(?:\.min)?\.js$/, body: babel },
  { id: 'vue', hosts: PACKAGE_CDNS, path: /\/(?:npm\/)?vue(?:@3(?:\.[\d.]+)?)?\/dist\/vue\.global(?:\.prod)?\.js$|\/ajax\/libs\/vue\/3[\d.]*\/vue\.global(?:\.prod)?(?:\.min)?\.js$/, body: vue },
];

// The bundled body for a CDN URL, or null when the URL is not one we ship.
export function vendoredBodyFor(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.host.toLowerCase();
  for (const lib of LIBS) {
    if (lib.hosts.has(host) && lib.path.test(parsed.pathname)) return lib.body;
  }
  return null;
}

export function vendoredIdFor(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.host.toLowerCase();
    return LIBS.find((l) => l.hosts.has(host) && l.path.test(parsed.pathname))?.id ?? null;
  } catch {
    return null;
  }
}
