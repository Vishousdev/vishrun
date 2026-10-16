import { test, expect } from 'bun:test';
import { isPublicHttpUrl } from './widget-fetch';

test('only public http(s) hosts are allowed', () => {
  expect(isPublicHttpUrl('https://music-api.gdstudio.xyz/api.php?x=1')).toBe(true);
  for (const u of ['http://localhost:7860/api', 'http://127.0.0.1/', 'http://192.168.1.4/', 'http://10.0.0.2/',
    'http://172.20.0.1/', 'http://169.254.169.254/', 'http://[::1]/', 'http://router/', 'file:///etc/passwd', 'http://nas.local/']) {
    expect(isPublicHttpUrl(u)).toBe(false);
  }
});
