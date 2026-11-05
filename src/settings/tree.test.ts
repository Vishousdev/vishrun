import { test, expect } from 'bun:test';
import { renderTree } from './tree';

test('variables tree: nested values, all closed, open state kept by path', () => {
  const open = new Set<string>();
  const value = { hp: 5, name: 'Ann', bag: { coins: 3, items: ['a'] } };
  const tree = renderTree(value, 'mvu', open);
  expect(tree.textContent).toContain('hp: 5');
  expect(tree.textContent).toContain('name: "Ann"');
  const bag = tree.querySelector('details')!;
  expect(bag.open).toBe(false);
  open.add('mvu.bag');
  const again = renderTree(value, 'mvu', open);
  expect(again.querySelector('details')!.open).toBe(true);
  expect(again.querySelectorAll('details')[1].open).toBe(false);
});
