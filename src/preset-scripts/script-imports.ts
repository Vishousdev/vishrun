// Loader imports that Vishrun already covers. MagVarUpdate's bundle is
// replaced by Vishrun's own MVU, and mvu_zod's registerMvuSchema by a local
// stand-in (see mvu-schema.ts), so neither is fetched from a CDN.

const MVU_BUNDLE = /MagVarUpdate[^'"]*\/bundle\.js/;
const MVU_ZOD_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\/mvu_zod\.js['"]\s*;?/g;

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// True when the whole script is a bare import of the MagVarUpdate bundle.
export function isMvuLoader(content: string): boolean {
  const code = stripComments(content).trim();
  return /^import\s*['"][^'"]+['"]\s*;?$/.test(code) && MVU_BUNDLE.test(code);
}

export function rewriteMvuZodImport(content: string): string {
  return content.replace(MVU_ZOD_IMPORT, (_m, names: string) =>
    `const {${names.replace(/\bas\b/g, ':')}} = window.__vishrunMvuZod;`);
}
