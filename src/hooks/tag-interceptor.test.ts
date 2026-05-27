import { test, expect } from 'bun:test';
import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import {
  syncTagInterceptors,
  teardownTagInterceptors,
  getCapturesForMessage,
  extractAllTagNames,
} from './tag-interceptor';
import { compileScripts } from '../core/parse-regex-script';
import type { RawRegexScript } from '../lumiverse/fetch-character';

// Multi-tag status-bar pattern: anchor <ID> followed by six more paired tags
// separated by lazy gaps. The host interceptor (single-tag) delivers a
// fullMatch scoped to <ID> only.
const MULTI_TAG_REGEX =
  '/<ID>(.*?)<\\/ID>.*?<Time>(.*?)<\\/Time>.*?<Location>(.*?)<\\/Location>.*?<InnerVoice>([\\s\\S]*?)<\\/InnerVoice>.*?<DesireLevel>(.*?)<\\/DesireLevel>.*?<Craving>([\\s\\S]*?)<\\/Craving>.*?<ToDo>([\\s\\S]*?)<\\/ToDo>/gs';

// Stored content as the REST fetch would return it: narration around a full
// multi-tag block, with newlines inside the [\s\S]*? groups.
const SPAN = [
  '<ID>042</ID>',
  '<Time>14:30</Time>',
  '<Location>Office</Location>',
  '<InnerVoice>line one',
  'line two</InnerVoice>',
  '<DesireLevel>7</DesireLevel>',
  '<Craving>craving one',
  'craving two</Craving>',
  '<ToDo>finish the report</ToDo>',
].join('\n');
const FULL_CONTENT = 'Preamble narration.\n' + SPAN + '\nTrailing narration.';

const EXPECTED_GROUPS = [
  '042',
  '14:30',
  'Office',
  'line one\nline two',
  '7',
  'craving one\ncraving two',
  'finish the report',
];

interface Registered {
  tagName: string;
  options: { tagName: string; removeFromMessage?: boolean };
  handler: (payload: any) => void;
}

function makeFakeCtx(): { ctx: SpindleFrontendContext; registered: Registered[] } {
  const registered: Registered[] = [];
  const ctx = {
    messages: {
      registerTagInterceptor: (options: any, handler: any) => {
        registered.push({ tagName: options.tagName, options, handler });
        return () => {};
      },
    },
  } as unknown as SpindleFrontendContext;
  return { ctx, registered };
}

function script(findRegex: string, id: string): RawRegexScript {
  return { id, scriptName: id, findRegex, replaceString: '<div>$1</div>' };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('extractAllTagNames: multi-tag pattern yields every tag in order, deduped', () => {
  const compiled = compileScripts([script(MULTI_TAG_REGEX, 'status-bar')]);
  const names = extractAllTagNames(compiled[0].findRe.source);
  expect(names).toEqual(['ID', 'Time', 'Location', 'InnerVoice', 'DesireLevel', 'Craving', 'ToDo']);
});

// Issue B: every tag the multi-tag pattern spans gets a removeFromMessage
// interceptor, so the host strips ALL of them from display, not just <ID>.
test('Issue B: syncTagInterceptors registers strip interceptors for all multi-tag tags', () => {
  teardownTagInterceptors();
  const compiled = compileScripts([script(MULTI_TAG_REGEX, 'status-bar')]);
  const { ctx, registered } = makeFakeCtx();
  syncTagInterceptors(ctx, compiled, {
    compiled,
    fetchContent: async () => FULL_CONTENT,
    reprocess: () => {},
  });
  const tagNames = registered.map((r) => r.tagName).sort();
  expect(tagNames).toEqual(
    ['craving', 'desirelevel', 'id', 'innervoice', 'location', 'time', 'todo'],
  );
  expect(registered.every((r) => r.options.removeFromMessage === true)).toBe(true);
});

// Issue A: the anchor handler receiving a truncated <ID>...</ID> fullMatch
// recovers the full multi-tag span (all seven groups) via content rebuild.
test('Issue A: truncated anchor fullMatch recovers full span and all capture groups', async () => {
  teardownTagInterceptors();
  const compiled = compileScripts([script(MULTI_TAG_REGEX, 'status-bar')]);
  const { ctx, registered } = makeFakeCtx();
  const reprocessed: string[] = [];
  syncTagInterceptors(ctx, compiled, {
    compiled,
    fetchContent: async () => FULL_CONTENT,
    reprocess: (id) => reprocessed.push(id),
  });

  const anchor = registered.find((r) => r.tagName === 'id')!;
  expect(anchor).toBeDefined();
  // Host delivers only the <ID> tag span.
  anchor.handler({
    tagName: 'ID',
    attrs: {},
    content: '042',
    fullMatch: '<ID>042</ID>',
    messageId: 'msg-A',
    chatId: 'chat-A',
  });

  await flush();

  const caps = getCapturesForMessage('msg-A');
  expect(caps).toHaveLength(1);
  expect(caps[0].fullMatch).toBe(SPAN);
  expect(reprocessed).toEqual(['msg-A']);

  // Stage 3 re-match now succeeds against the recovered full span.
  caps[0].findRe.lastIndex = 0;
  const m = caps[0].findRe.exec(caps[0].fullMatch);
  expect(m).not.toBeNull();
  expect(m!.slice(1)).toEqual(EXPECTED_GROUPS);
});

// Fetch failure falls back to the truncated capture so $1 still renders.
test('Issue A: fetch failure falls back to truncated capture (no worse than before)', async () => {
  teardownTagInterceptors();
  const compiled = compileScripts([script(MULTI_TAG_REGEX, 'status-bar')]);
  const { ctx, registered } = makeFakeCtx();
  syncTagInterceptors(ctx, compiled, {
    compiled,
    fetchContent: async () => { throw new Error('network down'); },
    reprocess: () => {},
  });
  const anchor = registered.find((r) => r.tagName === 'id')!;
  anchor.handler({
    tagName: 'ID',
    attrs: {},
    content: '042',
    fullMatch: '<ID>042</ID>',
    messageId: 'msg-fail',
    chatId: 'chat-fail',
  });
  await flush();
  const caps = getCapturesForMessage('msg-fail');
  expect(caps).toHaveLength(1);
  expect(caps[0].fullMatch).toBe('<ID>042</ID>');
});

// Single-tag scripts are unchanged: one interceptor, synchronous store, no fetch.
test('single-tag script stores synchronously with no content fetch', () => {
  teardownTagInterceptors();
  const compiled = compileScripts([script('/<ToDo>([\\s\\S]*?)<\\/ToDo>/gs', 'todo-only')]);
  const { ctx, registered } = makeFakeCtx();
  let fetches = 0;
  syncTagInterceptors(ctx, compiled, {
    compiled,
    fetchContent: async () => { fetches++; return FULL_CONTENT; },
    reprocess: () => {},
  });
  expect(registered.map((r) => r.tagName)).toEqual(['todo']);
  registered[0].handler({
    tagName: 'ToDo',
    attrs: {},
    content: 'do it',
    fullMatch: '<ToDo>do it</ToDo>',
    messageId: 'msg-single',
    chatId: 'chat-single',
  });
  // Stored immediately, no async recovery.
  expect(fetches).toBe(0);
  const caps = getCapturesForMessage('msg-single');
  expect(caps).toHaveLength(1);
  expect(caps[0].fullMatch).toBe('<ToDo>do it</ToDo>');
});
