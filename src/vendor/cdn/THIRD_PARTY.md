# Bundled CDN libraries

Lumiverse's `spindle.cors()` refuses JavaScript downloads (2026-10-15), so the
libraries cards load from public CDNs are shipped with Vishrun instead and
served to widget sandboxes by the backend. Files are unmodified upstream builds
stored with a `.txt` extension so they bundle as text.

| File | Package | Version | License |
|---|---|---|---|
| tailwind-browser-4.1.18.js.txt | @tailwindcss/browser (dist/index.global.js) | 4.1.18 | MIT |
| react-18.3.1.min.js.txt | react (umd/react.production.min.js) | 18.3.1 | MIT |
| react-dom-18.3.1.min.js.txt | react-dom (umd/react-dom.production.min.js) | 18.3.1 | MIT |
| babel-standalone-7.26.10.min.js.txt | @babel/standalone (babel.min.js) | 7.26.10 | MIT |
| vue-3.5.13.global.prod.js.txt | vue (dist/vue.global.prod.js) | 3.5.13 | MIT |
| emoji-picker-element-1.26.3.bundle.js.txt | emoji-picker-element + emoji-picker-element-data (en/emojibase) | 1.26.3 / 1.7.0 | Apache-2.0 |

Tailwind: cdn.tailwindcss.com serves the v3 Play CDN, which is not published to
npm; the official v4 browser build is used instead.

emoji-picker-element: index.js and its imports are bundled into one ES module with
esbuild, together with the English emoji data. The bundle wraps `fetch` so the
picker's request for that data is answered in-frame (sandbox connect-src is none).
