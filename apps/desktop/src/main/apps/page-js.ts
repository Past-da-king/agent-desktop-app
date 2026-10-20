/**
 * The JavaScript the app puts into pages for learned apps: running a saved tool, and watching what a
 * site sends while the agent maps it. Ported from reference phone connections/PageJs.kt.
 *
 * The phone polls a window slot because its WebView cannot await a promise; Electron's
 * executeJavaScript awaits one, so a run is a single call here.
 */
import { Script } from 'node:vm'

import type { JsonObject } from '@agent/core'

/**
 * A saved tool's body (the text of an async function that sees `args`) wrapped so the page resolves
 * with {ok:true,v} or {ok:false,e}. The text is injected by the app itself, so a site's policy does not
 * block it; a body that does not parse makes executeJavaScript reject instead.
 */
export function runScript(body: string, args: JsonObject): string {
  return (
    '(async function(args){\n' +
    body +
    '\n})(' +
    JSON.stringify(args) +
    ').then(function(v){return {ok:true,v:v===undefined?null:v}},function(e){return {ok:false,e:String(e&&e.message||e)}})'
  )
}

/** '' when the body parses as an async function body, else the syntax error. Compiles only; nothing runs. */
export function syntaxError(body: string): string {
  try {
    new Script(`(async function(args){\n${body}\n})`)
    return ''
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
}

/**
 * Records the page's fetch / XMLHttpRequest calls (method, url, status, a slice of the request and
 * the reply) and WebSocket opens into window.__aosNet, newest last, at most 300, while
 * sessionStorage.__aosNet is "1".
 */
export const NET_SHIM = `
(function(){
  if (window.__aosNetHooked) return; window.__aosNetHooked = true;
  var log = window.__aosNet = [];
  function on(){ try { return sessionStorage.getItem('__aosNet') === '1'; } catch(e){ return false; } }
  function add(e){ e.t = Date.now(); log.push(e); if (log.length > 300) log.shift(); }
  function slice(x, n){ try { if (x == null) return ''; if (typeof x !== 'string') x = (x instanceof FormData ? '[form data]' : (x instanceof Blob || x instanceof ArrayBuffer ? '[binary]' : String(x))); return x.slice(0, n); } catch(e){ return ''; } }
  var of = window.fetch;
  if (of) window.fetch = function(input, init){
    var rec = null;
    if (on()) { try { rec = { k: 'fetch', m: ((init && init.method) || (input && input.method) || 'GET').toUpperCase(), u: String((input && input.url) || input).slice(0, 400), rq: slice(init && init.body, 500) }; } catch(e){} }
    var p = of.apply(this, arguments);
    if (rec) p.then(function(res){ rec.s = res.status; var ct = (res.headers.get('content-type') || '');
      if (/json|text|xml|javascript/.test(ct)) res.clone().text().then(function(t){ rec.rs = slice(t, 700); add(rec); }, function(){ add(rec); }); else { rec.rs = '[' + ct + ']'; add(rec); } }, function(err){ rec.s = 0; rec.rs = String(err); add(rec); });
    return p;
  };
  var X = window.XMLHttpRequest;
  if (X) { var oo = X.prototype.open, os = X.prototype.send;
    X.prototype.open = function(m, u){ this.__aos = { k: 'xhr', m: String(m).toUpperCase(), u: String(u).slice(0, 400) }; return oo.apply(this, arguments); };
    X.prototype.send = function(b){ var r = this.__aos; if (r && on()) { r.rq = slice(b, 500); var x = this;
      x.addEventListener('loadend', function(){ r.s = x.status; try { var ct = x.getResponseHeader('content-type') || ''; r.rs = /json|text|xml|javascript/.test(ct) && (x.responseType === '' || x.responseType === 'text') ? slice(x.responseText, 700) : '[' + ct + ']'; } catch(e){} add(r); }); }
      return os.apply(this, arguments); }; }
  var W = window.WebSocket;
  if (W) { window.WebSocket = function(u, p){ var ws = p === undefined ? new W(u) : new W(u, p); if (on()) add({ k: 'ws', m: 'OPEN', u: String(u).slice(0, 300) }); return ws; }; window.WebSocket.prototype = W.prototype; ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(c){ window.WebSocket[c] = W[c]; }); }
})();
`

export function netStart(): string {
  return `${NET_SHIM};(function(){try{sessionStorage.setItem('__aosNet','1')}catch(e){}return 1})()`
}

export function netStop(): string {
  return "(function(){try{sessionStorage.removeItem('__aosNet')}catch(e){}return 1})()"
}

export function netClear(): string {
  return '(function(){if(window.__aosNet)window.__aosNet.length=0;return 1})()'
}

/** The recorded calls whose method and url contain `filter`, newest last. */
export function netLog(filter: string, limit: number): string {
  const n = Math.max(1, Math.min(100, Math.floor(limit)))
  return `(function(){var f=${JSON.stringify(filter.toLowerCase())};var hooked=!!window.__aosNetHooked;var l=(window.__aosNet||[]).filter(function(e){return !f||((e.m+' '+e.u).toLowerCase().indexOf(f)>=0)});return {hooked:hooked,calls:l.slice(-${n})}})()`
}
