// JS-Slash-Runner widgets share one event bus with the card's scripts, so a
// widget's eventEmit reaches the scripts' eventOn. Widgets post the event to
// Vishrun, which emits it to the running scripts.

export function eventEmitShim(): string {
  return `<script>(function(){
if(typeof window.eventEmit==='function')return;
window.eventEmit=function(event){
  var args=Array.prototype.slice.call(arguments,1);
  try{window.spindleSandbox.postMessage({kind:'script-event',event:String(event),args:JSON.parse(JSON.stringify(args))});}catch(e){}
  return Promise.resolve();
};
})();</script>`;
}

export function isScriptEvent(p: unknown): p is { kind: 'script-event'; event: string; args: unknown[] } {
  const r = p as { kind?: unknown; event?: unknown; args?: unknown } | null;
  return !!r && r.kind === 'script-event' && typeof r.event === 'string' && r.event.length > 0 && r.event.length <= 200
    && Array.isArray(r.args);
}
