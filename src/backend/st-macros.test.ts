import { expect, test } from 'bun:test';
import { stMacros, toChatVarMacros } from './st-macros';

test('ST variable macros map to the chat variable family', () => {
  expect(toChatVarMacros('{{getvar::a}}{{setvar::a::1}}{{addvar::a::2}}{{incvar::a}}{{decvar::a}}'))
    .toBe('{{getchatvar::a}}{{setchatvar::a::1}}{{addchatvar::a::2}}{{incchatvar::a}}{{decchatvar::a}}');
});

test('other macros are left alone', () => {
  const t = '{{getchatvar::a}}{{getglobalvar::b}}{{getgvar::c}}{{user}}';
  expect(toChatVarMacros(t)).toBe(t);
});

test('global macros read the store scripts write; unknown keys are left to Lumiverse', async () => {
  const list = async () => ({ mode: 'night' });
  expect(await stMacros('[{{getglobalvar::mode}}][{{getgvar:: mode }}][{{getglobalvar::x}}]{{getvar::a}}', 'u', list))
    .toBe('[night][night][{{getglobalvar::x}}]{{getchatvar::a}}');
});

test('globals are not read when no global macro is present', async () => {
  let reads = 0;
  await stMacros('{{getvar::a}}', 'u', async () => { reads++; return {}; });
  expect(reads).toBe(0);
});
