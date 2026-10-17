// Runtime CSS image URLs for widget sandboxes. Cards that set
// `el.style.backgroundImage = 'url(https://…)'` from script bypass the static
// srcdoc rewrite; the frame CSP only allows data:/blob: images. Inline style
// properties are not hookable accessors in Chromium, so style attribute
// changes are watched and their https URLs swapped for proxied blob: URLs.
// Needs externalImageProxyHelper (window.__vishrunProxiedImageUrl).

export function cssUrlProxyShim(): string {
  return `<script>(function(){
var resolve=window.__vishrunProxiedImageUrl;
if(typeof resolve!=='function'||typeof MutationObserver==='undefined')return;
var URL_RE=/url\\(\\s*(['"]?)(https?:\\/\\/[^'")\\s]+)\\1\\s*\\)/gi;
function fix(el){
  var css=el.getAttribute&&el.getAttribute('style');
  if(!css||css.indexOf('http')===-1)return;
  URL_RE.lastIndex=0;
  if(!URL_RE.test(css))return;
  var urls=[];URL_RE.lastIndex=0;var m;
  while((m=URL_RE.exec(css))!==null)urls.push(m[2]);
  Promise.all(urls.map(function(u){return resolve(u).catch(function(){return null;});})).then(function(blobs){
    if(el.getAttribute('style')!==css)return;
    var i=0;URL_RE.lastIndex=0;
    el.setAttribute('style',css.replace(URL_RE,function(){var b=blobs[i++];return b?'url("'+b+'")':'none';}));
  });
}
function scan(root){
  if(root.nodeType===1&&root.hasAttribute('style'))fix(root);
  if(root.querySelectorAll){var l=root.querySelectorAll('[style*="url("]');for(var i=0;i<l.length;i++)fix(l[i]);}
}
new MutationObserver(function(recs){
  for(var i=0;i<recs.length;i++){
    var r=recs[i];
    if(r.type==='attributes')fix(r.target);
    else for(var j=0;j<r.addedNodes.length;j++){var n=r.addedNodes[j];if(n.nodeType===1)scan(n);}
  }
}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['style']});
if(document.body)scan(document.body);else document.addEventListener('DOMContentLoaded',function(){scan(document.body);});
})();</script>`;
}
