import type { SpindleFrontendContext, SpindleSandboxFrameHandle } from 'lumiverse-spindle-types';
import { fetchFontViaBackend } from '../core/asset-injector';
import { selectFontEntries } from './font-fontface';

// Font files for every widget on the page, fetched once per URL through the
// backend (host font proxy) and kept as page-level blob: URLs. Widget frames
// share the page origin, so they can use them directly.

const cache = new Map<string, Promise<string>>();

export function fontBlobUrl(
  url: string,
  ctx: SpindleFrontendContext,
  fetchFont = fetchFontViaBackend,
): Promise<string> {
  const hit = cache.get(url);
  if (hit) return hit;
  const pending = fetchFont(url, ctx).then(({ body, contentType }) => {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: contentType }));
  });
  cache.set(url, pending);
  pending.catch(() => {
    if (cache.get(url) === pending) cache.delete(url);
  });
  return pending;
}

export function isFontRequest(p: unknown): p is { kind: 'font-request'; requestId: string; url: string } {
  const r = p as { kind?: unknown; requestId?: unknown; url?: unknown } | null;
  return !!r && r.kind === 'font-request' && typeof r.requestId === 'string' && typeof r.url === 'string' && /^https?:\/\//i.test(r.url);
}

export function answerFontRequest(
  frame: SpindleSandboxFrameHandle,
  req: { requestId: string; url: string },
  ctx: SpindleFrontendContext,
): void {
  fontBlobUrl(req.url, ctx).then(
    (url) => frame.postMessage({ kind: 'font-response', requestId: req.requestId, url }),
    (err) => frame.postMessage({ kind: 'font-response', requestId: req.requestId, error: err instanceof Error ? err.message : String(err) }),
  );
}

// Frame side: reads the font config, collects which families draw which
// characters, and loads the chosen files as they become needed.
export function fontLoaderShim(): string {
  return `<script>(function(){
var sb=window.spindleSandbox;
if(!sb||typeof FontFace==='undefined'||!document.fonts)return;
var select=(${selectFontEntries.toString()});
var entries=[],seenCfg=new Set(),done={},waiting={},seq=0,timer=0,lastKey='';
sb.onMessage(function(m){
  if(!m||m.kind!=='font-response'||!waiting[m.requestId])return;
  var cb=waiting[m.requestId];delete waiting[m.requestId];cb(m);
});
function blobFor(url){
  return new Promise(function(res,rej){
    var id='vf'+(++seq);
    waiting[id]=function(m){m.url?res(m.url):rej(new Error(m.error||'font'));};
    sb.postMessage({kind:'font-request',requestId:id,url:url});
  });
}
function load(e){
  if(done[e.url])return;done[e.url]=1;
  blobFor(e.url).then(function(u){
    var d={weight:e.weight||'400',style:e.style||'normal',display:e.display||'swap'};
    if(e.range)d.unicodeRange=e.range;
    var f=new FontFace(e.family,'url('+u+')',d);
    document.fonts.add(f);
    return f.load();
  }).catch(function(err){console.warn('[vishrun] font failed',e.url,err&&err.message||err);});
}
function readConfig(){
  var list=document.querySelectorAll('script[data-vishrun-fonts]');
  for(var i=0;i<list.length;i++){
    if(seenCfg.has(list[i]))continue;seenCfg.add(list[i]);
    try{entries=entries.concat(JSON.parse(list[i].textContent||'[]'));}catch(e){}
  }
}
function usages(){
  var byEl=new Map(),w=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT),n;
  while((n=w.nextNode())){
    var el=n.parentElement,t=n.nodeValue;
    if(!el||!t||!t.trim()||/^(SCRIPT|STYLE)$/.test(el.tagName))continue;
    byEl.set(el,(byEl.get(el)||'')+t);
  }
  var out=[];
  byEl.forEach(function(text,el){
    var cs=getComputedStyle(el);
    out.push({families:cs.fontFamily.split(','),weight:parseFloat(cs.fontWeight)||400,style:cs.fontStyle,text:text});
  });
  return out;
}
function scan(){
  timer=0;readConfig();
  if(!entries.length)return;
  var u=usages(),key=entries.length+JSON.stringify(u);
  if(key===lastKey)return;
  lastKey=key;
  select(entries,u).forEach(load);
}
function later(){if(!timer)timer=setTimeout(scan,150);}
function init(){
  scan();
  try{new MutationObserver(later).observe(document.documentElement,{childList:true,subtree:true,characterData:true});}catch(e){}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();</script>`;
}
