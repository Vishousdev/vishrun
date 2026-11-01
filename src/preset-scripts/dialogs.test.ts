import { test, expect } from 'bun:test';
import { splitNamedArgs } from './dialogs';

test('slash named args: quoted and bare values before the text', () => {
  expect(splitNamedArgs('okButton="确定" cancelButton=取消 输入范围（例如：0-10）')).toEqual({
    named: { okButton: '确定', cancelButton: '取消' },
    text: '输入范围（例如：0-10）',
  });
  expect(splitNamedArgs('large=on wider=on Stats: 5')).toEqual({ named: { large: 'on', wider: 'on' }, text: 'Stats: 5' });
  expect(splitNamedArgs('plain text')).toEqual({ named: {}, text: 'plain text' });
});
