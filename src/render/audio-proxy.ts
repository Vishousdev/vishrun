// External audio for widget sandboxes. The frame CSP only allows media from
// data: and blob:, so https sources are resolved through the host proxy
// (spindleSandbox.fetchAudio) and swapped for blob: URLs. Bytes stay in memory.

const ATTR = 'data-vishrun-extaudio';

// Static <audio src> / <source src>: move the https URL aside so the browser
// never attempts (and CSP-rejects) the direct load.
export function stripExternalAudioSrc(html: string): string {
  if (!/<(?:audio|source)\b/i.test(html)) return html;
  return html.replace(/<(?:audio|source)\b[^>]*>/gi, (tag) =>
    tag.replace(/(\s)src\s*=\s*(['"])(https?:\/\/[^'"]+)\2/i, `$1${ATTR}=$2$3$2`),
  );
}

export function audioProxyHelper(): string {
  return `<script>(function(){
var ATTR='${ATTR}';
var sb=window.spindleSandbox;
if(!sb||typeof sb.fetchAudio!=='function')return;
var EXT=/^https?:\\/\\//i;
var cache=Object.create(null);
var pending=new WeakMap();
var media=HTMLMediaElement.prototype;
var srcDesc=Object.getOwnPropertyDescriptor(media,'src');
var setAttr=Element.prototype.setAttribute;
var origPlay=media.play;
var origLoad=media.load;
function resolveUrl(url){
  if(!cache[url])cache[url]=sb.fetchAudio(url).then(function(r){return r.url;});
  return cache[url];
}
function isAudioTarget(el){
  return el instanceof HTMLAudioElement||(el instanceof HTMLSourceElement&&el.parentElement instanceof HTMLAudioElement);
}
function owner(el){return el instanceof HTMLSourceElement?el.parentElement:el;}
function divert(el,url){
  setAttr.call(el,ATTR,url);
  var media=owner(el);
  var p=resolveUrl(url).then(function(blob){
    if(el.getAttribute(ATTR)!==url)return;
    el.removeAttribute(ATTR);
    if(el instanceof HTMLSourceElement){setAttr.call(el,'src',blob);if(media)origLoad.call(media);}
    else srcDesc.set.call(el,blob);
  },function(e){console.warn('[vishrun] audio proxy failed',url,e&&e.message||e);});
  if(media)pending.set(media,p);
  return p;
}
Object.defineProperty(media,'src',{configurable:true,enumerable:srcDesc.enumerable,get:srcDesc.get,set:function(v){
  if(typeof v==='string'&&EXT.test(v)&&this instanceof HTMLAudioElement){divert(this,v);return;}
  srcDesc.set.call(this,v);
}});
Element.prototype.setAttribute=function(name,value){
  if(String(name).toLowerCase()==='src'&&typeof value==='string'&&EXT.test(value)&&isAudioTarget(this)){divert(this,value);return;}
  return setAttr.call(this,name,value);
};
media.play=function(){
  var self=this,p=pending.get(this);
  if(!p)return origPlay.call(this);
  return p.then(function(){pending.delete(self);return origPlay.call(self);});
};
media.load=function(){
  var self=this,p=pending.get(this);
  if(!p)return origLoad.call(this);
  p.then(function(){origLoad.call(self);});
};
var OrigAudio=window.Audio;
if(OrigAudio){
  var Wrapped=function Audio(url){var a=new OrigAudio();if(url!==undefined)a.src=url;return a;};
  Wrapped.prototype=OrigAudio.prototype;
  window.Audio=Wrapped;
}
function scan(root){
  if(!root||!root.querySelectorAll)return;
  var list=root.querySelectorAll('audio['+ATTR+'],source['+ATTR+'],audio[src^="http"],audio source[src^="http"]');
  for(var i=0;i<list.length;i++){
    var el=list[i];
    if(!isAudioTarget(el))continue;
    var url=el.getAttribute(ATTR)||el.getAttribute('src');
    if(!EXT.test(url||''))continue;
    if(el.hasAttribute('src'))el.removeAttribute('src');
    divert(el,url);
  }
}
document.addEventListener('DOMContentLoaded',function(){
  scan(document);
  new MutationObserver(function(muts){for(var i=0;i<muts.length;i++){var n=muts[i].addedNodes;for(var j=0;j<n.length;j++){var x=n[j];if(x.nodeType!==1)continue;if(x.matches&&x.matches('audio,source'))scan(x.parentNode||x);else scan(x);}}}).observe(document.documentElement,{childList:true,subtree:true});
});
})();</script>`;
}
