// JS-Slash-Runner rewrites `min-height` in vh to the chat window's height, so
// widgets sized with `min-height: 80vh` keep their size in an auto-height frame
// instead of collapsing to the frame's own height.

const VAR = 'var(--TH-viewport-height)';

function vhToVar(value: string): string {
  return value.replace(/(\d+(?:\.\d+)?)vh\b/gi, (match, n: string) => {
    const parsed = parseFloat(n);
    if (!isFinite(parsed)) return match;
    return parsed === 100 ? VAR : `calc(${VAR} * ${parsed / 100})`;
  });
}

export function replaceMinHeightVh(content: string): string {
  if (!/min-?height/i.test(content) || !/\dvh\b/i.test(content)) return content;
  // CSS declarations, in <style> blocks and inline style strings.
  let out = content.replace(
    /(min-height\s*:\s*)([^;{}]*?\d+(?:\.\d+)?vh)(?=\s*[;}])/gi,
    (_m, prefix: string, value: string) => prefix + vhToVar(value),
  );
  // Inline style attributes whose last declaration has no semicolon.
  out = out.replace(/(style\s*=\s*(["']))([^"']*?)(\2)/gi, (match, prefix: string, _q: string, style: string, suffix: string) => {
    if (!/min-height\s*:\s*[^;]*vh/i.test(style)) return match;
    return prefix + style.replace(/(min-height\s*:\s*)([^;]*?\d+(?:\.\d+)?vh)/gi, (_m, p: string, v: string) => p + vhToVar(v)) + suffix;
  });
  // Script: el.style.minHeight = '...vh'
  out = out.replace(/(\.style\.minHeight\s*=\s*(["']))([\s\S]*?)(\2)/gi, (match, prefix: string, _q: string, v: string, suffix: string) =>
    /\b\d+(?:\.\d+)?vh\b/i.test(v) ? prefix + vhToVar(v) + suffix : match);
  // Script: el.style.setProperty('min-height', '...vh')
  out = out.replace(/(setProperty\s*\(\s*(["'])min-height\2\s*,\s*(["']))([\s\S]*?)(\3\s*\))/gi, (match, prefix: string, _a: string, _b: string, v: string, suffix: string) =>
    /\b\d+(?:\.\d+)?vh\b/i.test(v) ? prefix + vhToVar(v) + suffix : match);
  return out;
}

// Sets --TH-viewport-height from the chat window and follows its resizes.
export function viewportVarShim(): string {
  return '<script>(function(){'
    + 'function set(){var h=0;try{h=window.parent.innerHeight;}catch(e){}'
    + 'if(!h)h=(window.screen&&window.screen.availHeight)||800;'
    + "document.documentElement.style.setProperty('--TH-viewport-height',h+'px');}"
    + 'set();'
    + "try{window.parent.addEventListener('resize',set);}catch(e){}"
    + '})();</script>';
}
