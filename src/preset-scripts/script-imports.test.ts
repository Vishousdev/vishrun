import { describe, expect, test } from 'bun:test';
import { isMvuLoader, rewriteMvuZodImport } from './script-imports';

describe('isMvuLoader', () => {
  test('matches a bare MagVarUpdate bundle import', () => {
    expect(isMvuLoader("import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@master/artifact/bundle.js'")).toBe(true);
    expect(isMvuLoader("// mvu\nimport 'https://cdn.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js';\n")).toBe(true);
  });
  test('ignores other imports and scripts with more code', () => {
    expect(isMvuLoader("import 'https://example.com/other.js'")).toBe(false);
    expect(isMvuLoader("import 'https://x/MagVarUpdate/artifact/bundle.js';\nconsole.log(1);")).toBe(false);
  });
});

describe('rewriteMvuZodImport', () => {
  test('replaces the mvu_zod import with the local stand-in', () => {
    const src = "import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';\nexport const S = 1;";
    expect(rewriteMvuZodImport(src)).toBe('const { registerMvuSchema } = window.__vishrunMvuZod;\nexport const S = 1;');
  });
  test('keeps aliases', () => {
    expect(rewriteMvuZodImport("import { registerMvuSchema as reg } from './mvu_zod.js'"))
      .toBe('const { registerMvuSchema : reg } = window.__vishrunMvuZod;');
  });
});
