import { test, expect } from 'bun:test';
import { installComposerAlias } from './st-composer-alias';

test('#send_textarea reads and writes the host composer', () => {
  document.body.innerHTML = '<div data-component="InputArea"><textarea></textarea></div>';
  const real = document.querySelector('textarea')!;
  let inputs = 0;
  real.addEventListener('input', () => inputs++);
  const dispose = installComposerAlias(document);
  const alias = document.getElementById('send_textarea') as HTMLTextAreaElement;
  alias.value = 'First choice';
  expect(real.value).toBe('First choice');
  expect(inputs).toBe(1);
  real.value = 'typed';
  expect(alias.value).toBe('typed');
  expect(alias.value.trim() === '' ? 'x' : alias.value + '\n' + 'y').toBe('typed\ny');
  dispose();
  expect(document.getElementById('send_textarea')).toBeNull();
});

test('an existing #send_textarea is left alone', () => {
  document.body.innerHTML = '<textarea id="send_textarea"></textarea>';
  installComposerAlias(document)();
  expect(document.querySelectorAll('#send_textarea').length).toBe(1);
});
