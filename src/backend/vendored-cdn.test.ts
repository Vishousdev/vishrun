import { test, expect } from 'bun:test';
import { vendoredIdFor } from './vendored-cdn';

test('card CDN URLs map to the bundled libraries', () => {
  expect(vendoredIdFor('https://cdn.tailwindcss.com')).toBe('tailwind');
  expect(vendoredIdFor('https://cdn.tailwindcss.com/3.4.17')).toBe('tailwind');
  expect(vendoredIdFor('https://unpkg.com/react@18/umd/react.production.min.js')).toBe('react');
  expect(vendoredIdFor('https://unpkg.com/react-dom@18/umd/react-dom.production.min.js')).toBe('react-dom');
  expect(vendoredIdFor('https://unpkg.com/@babel/standalone/babel.min.js')).toBe('babel');
  expect(vendoredIdFor('https://cdn.jsdelivr.net/npm/@babel/standalone@7.24.0/babel.min.js')).toBe('babel');
  expect(vendoredIdFor('https://unpkg.com/vue@3/dist/vue.global.js')).toBe('vue');
  expect(vendoredIdFor('https://cdnjs.cloudflare.com/ajax/libs/vue/3.4.21/vue.global.prod.min.js')).toBe('vue');
});

test('other versions and hosts are not served', () => {
  expect(vendoredIdFor('https://unpkg.com/react@17/umd/react.production.min.js')).toBeNull();
  expect(vendoredIdFor('https://unpkg.com/vue@2/dist/vue.js')).toBeNull();
  expect(vendoredIdFor('https://cdn.tailwindcss.com.evil.com/')).toBeNull();
  expect(vendoredIdFor('https://cdn.jsdelivr.net/npm/emoji-picker-element@^1/index.js')).toBeNull();
});
