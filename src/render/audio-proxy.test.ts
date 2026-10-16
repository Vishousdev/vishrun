import { test, expect } from 'bun:test';
import { audioProxyHelper, stripExternalAudioSrc } from './audio-proxy';

test('static https audio sources are moved aside, others untouched', () => {
  const html = '<audio src="https://a.test/x.mp3"></audio><audio><source src=\'https://a.test/y.ogg\'></audio><audio src="blob:z"></audio><img src="https://a.test/i.png">';
  expect(stripExternalAudioSrc(html)).toBe(
    '<audio data-vishrun-extaudio="https://a.test/x.mp3"></audio><audio><source data-vishrun-extaudio=\'https://a.test/y.ogg\'></audio><audio src="blob:z"></audio><img src="https://a.test/i.png">',
  );
});

test('new Audio(url) resolves through fetchAudio and play waits for it', async () => {
  const fetched: string[] = [];
  (window as any).spindleSandbox = { fetchAudio: async (u: string) => { fetched.push(u); return { url: 'blob:resolved' }; } };
  const played: string[] = [];
  const proto = HTMLMediaElement.prototype as any;
  const savedPlay = proto.play;
  proto.play = function () { played.push(this.getAttribute('src')); return Promise.resolve(); };
  const script = audioProxyHelper().replace(/^<script>/, '').replace(/<\/script>$/, '');
  new Function(script)();
  const a = new (window as any).Audio('https://a.test/click.mp3');
  const b = new (window as any).Audio('https://a.test/click.mp3');
  await a.play();
  await b.play();
  expect(fetched).toEqual(['https://a.test/click.mp3']);
  expect(played).toEqual(['blob:resolved', 'blob:resolved']);
  proto.play = savedPlay;
});
