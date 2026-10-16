import type { SpindleFrontendContext, SpindleSandboxFrameHandle } from 'lumiverse-spindle-types';

// External fetch() for widget sandboxes. The frame CSP has connect-src 'none'
// and the frame's own proxy serves media only, so cards that call web APIs
// (song lookups, JSON feeds) are answered by Vishrun's backend over the frame
// message channel. Text bodies only; the backend refuses private hosts.

const TIMEOUT_MS = 20000;
let counter = 0;

export function fetchBridgeShim(): string {
  return `<script>(function(){
var sb=window.spindleSandbox;
if(!sb||typeof sb.postMessage!=='function'||typeof sb.onMessage!=='function'||typeof window.fetch!=='function')return;
var nativeFetch=window.fetch.bind(window);
var EXT=/^https?:\\/\\//i;
var pending={};
var seq=0;
sb.onMessage(function(m){
  if(!m||m.kind!=='widget-fetch-response')return;
  var slot=pending[m.requestId];
  if(!slot)return;
  delete pending[m.requestId];
  if(!m.ok){slot.reject(new TypeError('Failed to fetch: '+(m.error||'error')));return;}
  var noBody=m.status===204||m.status===205||m.status===304;
  slot.resolve(new Response(noBody?null:(m.body||''),{status:m.status||200,statusText:m.statusText||'',headers:m.headers||{}}));
});
function plainHeaders(h){
  var out={};
  if(!h)return out;
  if(typeof Headers!=='undefined'&&h instanceof Headers){h.forEach(function(v,k){out[k]=v;});return out;}
  if(Array.isArray(h)){h.forEach(function(p){out[p[0]]=String(p[1]);});return out;}
  for(var k in h)out[k]=String(h[k]);
  return out;
}
window.fetch=function(input,init){
  var url=typeof input==='string'?input:(input&&input.url)||String(input);
  if(!EXT.test(url))return nativeFetch(input,init);
  init=init||{};
  var body=init.body;
  if(body!=null&&typeof body!=='string'){
    if(typeof URLSearchParams!=='undefined'&&body instanceof URLSearchParams)body=body.toString();
    else return Promise.reject(new TypeError('Failed to fetch: only string bodies are supported'));
  }
  return new Promise(function(resolve,reject){
    var id='wf-'+Date.now().toString(36)+'-'+(++seq);
    pending[id]={resolve:resolve,reject:reject};
    try{
      sb.postMessage({kind:'widget-fetch',requestId:id,url:url,method:(init.method||(input&&input.method)||'GET'),headers:plainHeaders(init.headers),body:body==null?undefined:body});
    }catch(e){delete pending[id];reject(new TypeError('Failed to fetch'));}
  });
};
})();</script>`;
}

interface WidgetFetchMessage {
  kind: 'widget-fetch';
  requestId: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export function isWidgetFetch(p: unknown): p is WidgetFetchMessage {
  if (!p || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  return r.kind === 'widget-fetch' && typeof r.requestId === 'string' && typeof r.url === 'string';
}

export function dispatchWidgetFetch(frame: SpindleSandboxFrameHandle, msg: WidgetFetchMessage, ctx: SpindleFrontendContext): void {
  const backendId = `vishrun-wf-${Date.now()}-${++counter}`;
  let done = false;
  let unsub: (() => void) | null = null;
  const finish = (reply: Record<string, unknown>) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    unsub?.();
    try {
      frame.postMessage({ kind: 'widget-fetch-response', requestId: msg.requestId, ...reply });
    } catch { /* frame gone */ }
  };
  const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), TIMEOUT_MS);
  unsub = ctx.onBackendMessage((payload) => {
    const p = payload as { type?: string; requestId?: string } | null;
    if (!p || p.type !== 'widget_fetch_response' || p.requestId !== backendId) return;
    const { type: _t, requestId: _r, ...rest } = p as Record<string, unknown>;
    finish(rest);
  });
  ctx.sendToBackend({
    type: 'widget_fetch',
    requestId: backendId,
    url: msg.url,
    method: typeof msg.method === 'string' ? msg.method : 'GET',
    headers: msg.headers && typeof msg.headers === 'object' ? msg.headers : {},
    body: typeof msg.body === 'string' ? msg.body : undefined,
  });
}
