import { test, expect } from 'bun:test';
import { callGenericPopup, splitNamedArgs } from './dialogs';

test('slash named args: quoted and bare values before the text', () => {
  expect(splitNamedArgs('okButton="确定" cancelButton=取消 输入范围（例如：0-10）')).toEqual({
    named: { okButton: '确定', cancelButton: '取消' },
    text: '输入范围（例如：0-10）',
  });
  expect(splitNamedArgs('large=on wider=on Stats: 5')).toEqual({ named: { large: 'on', wider: 'on' }, text: 'Stats: 5' });
  expect(splitNamedArgs('plain text')).toEqual({ named: {}, text: 'plain text' });
});

const clickPopup = (label: string) => {
  const b = [...document.querySelectorAll('[data-vishrun-dialog] button')].find((x) => x.textContent === label) as HTMLButtonElement;
  b.click();
};

test('callGenericPopup: HTML content, custom buttons return their result', async () => {
  const p = callGenericPopup('<b id="pp">Hi</b>', 1, '', { okButton: 'Close', customButtons: [{ text: 'Next', result: 10 }] });
  expect(document.getElementById('pp')?.textContent).toBe('Hi');
  clickPopup('Next');
  expect(await p).toBe(10);
  expect(document.querySelector('[data-vishrun-dialog]')).toBeNull();
});

test('callGenericPopup: INPUT returns the text on OK, false on Cancel', async () => {
  const p = callGenericPopup('Name?', 3, 'abc');
  clickPopup('OK');
  expect(await p).toBe('abc');
  const q = callGenericPopup('Name?', 3, 'abc');
  clickPopup('Cancel');
  expect(await q).toBe(false);
});
