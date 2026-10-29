/**
 * What every mini-app is served besides its own files (main/miniapps/protocol.ts, and the phone's WebView): the app's
 * design tokens (miniapp-tokens.ts, generated from renderer/styles/tokens.css), a small kit of parts drawn only with
 * those tokens (ui.css), and the bridge (agent.js), the one door out of the sandbox.
 *
 * The kit's parts are the app's own (base.css .btn, .chip, .pill, .card...) so an app looks exactly like the app in
 * light and dark and every accent. The bridge speaks one message format over three transports: a MessagePort from the
 * window around it (desktop), a preload (the offscreen check) and a JavaScript interface (the phone).
 */
import { ACCENTS, IRIS } from './brand'
import { TOKENS_CSS } from './miniapp-tokens'

export { TOKENS_CSS }

/** The frame's rules: its own files and nothing else. No network, no frames, no forms, no navigation away. */
export const MINIAPP_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "media-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/** The kit: the app's own parts, written only with its tokens. Class names match the skill brief (main/tools/miniapps.ts). */
export const UI_CSS = `
*{box-sizing:border-box}
html{height:100%;background:var(--s-lowest)}
body{margin:0;min-height:100%;background:var(--s-lowest);color:var(--on-bg);font:400 14px/1.45 var(--font);-webkit-font-smoothing:antialiased;padding:28px 32px 40px}
@media (max-width:600px){body{padding:16px 14px 28px}}
button,input,textarea,select{font:inherit;color:inherit}
button{cursor:pointer;border:0;background:none;padding:0}
h1,h2,h3,p{margin:0}
ul,ol{margin:0;padding:0;list-style:none}
:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
::-webkit-scrollbar{width:12px;height:12px;background:transparent}
::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}
::-webkit-scrollbar-button{display:none;width:0;height:0}
::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--on-sv) 28%,transparent);border-radius:999px;border:4px solid transparent;background-clip:padding-box;min-height:40px}
::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--on-sv) 45%,transparent);border-width:3px;background-clip:padding-box}
::selection{background:var(--pc);color:var(--on-pc)}
:root{--chart-1:var(--primary);--chart-2:var(--tert);--chart-3:var(--ok);--chart-4:var(--err);--chart-5:var(--on-sv);--chart-6:var(--outline);--gap:16px}
.h1{font:500 clamp(24px,3vw,34px)/1.15 var(--font);letter-spacing:-.4px;text-wrap:balance}
.h2{font:500 20px/1.25 var(--font)}
.h3{font:600 15px/1.3 var(--font)}
.eyebrow{font:700 11px/16px var(--font);letter-spacing:.12em;text-transform:uppercase;color:var(--primary)}
.eyebrow.mute{color:var(--on-sv)}
.muted{color:var(--on-sv)}
.small{font-size:12px}
.num{font-variant-numeric:tabular-nums}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.stack{display:flex;flex-direction:column;gap:var(--gap)}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.row.between{justify-content:space-between}
.grid{display:grid;gap:var(--gap);grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
.grid.two{grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
.card{background:var(--s-low);border-radius:var(--r-lg);padding:20px 22px;min-width:0}
.card.mid{background:var(--s-mid)}
.card.tonal{background:var(--pc);color:var(--on-pc)}
.card.line{background:transparent;border:1px solid var(--outline-v)}
@media (max-width:600px){.card{padding:16px;border-radius:var(--r-md)}}
.stat{font:500 34px/1.1 var(--font);letter-spacing:-.5px;font-variant-numeric:tabular-nums}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:40px;padding:0 20px;border-radius:999px;font:500 14px/1 var(--font);background:var(--sc);color:var(--on-sc);transition:background .2s var(--effects),transform .45s var(--spatial)}
.btn:hover{background:color-mix(in srgb,var(--sc) 85%,var(--on-sc))}
.btn:active{transform:scale(.97)}
.btn.fill{background:var(--primary);color:var(--on-primary)}
.btn.fill:hover{background:color-mix(in srgb,var(--primary) 88%,var(--on-primary))}
.btn.line{border:1.5px solid var(--outline);color:var(--on-bg);background:transparent}
.btn.line:hover{background:var(--s-high)}
.btn.text{padding:0 12px;color:var(--primary);background:transparent}
.btn.text:hover{background:var(--pc)}
.btn.sm{height:32px;padding:0 14px;font-size:13px}
.btn[disabled]{background:var(--s-high);color:var(--on-sv);cursor:not-allowed;opacity:.8}
.chip{display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 14px;border-radius:999px;border:1px solid var(--outline-v);font:500 13px/1 var(--font);color:var(--on-sv);background:transparent;max-width:100%}
.chip:hover{background:var(--s-high)}
.chip.on{background:var(--sc);color:var(--on-sc);border-color:transparent}
.pill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 10px;border-radius:999px;font:700 11px/1 var(--font);letter-spacing:.06em;text-transform:uppercase;background:var(--s-high);color:var(--on-sv)}
.pill.ok{background:var(--okc);color:var(--ok)}
.pill.warn{background:var(--tc);color:var(--on-tc)}
.pill.pri{background:var(--pc);color:var(--on-pc)}
.pill.err{background:var(--ec);color:var(--on-ec)}
.tabs{display:flex;gap:4px;padding:4px;border-radius:999px;background:var(--s-high);width:max-content;max-width:100%;overflow:auto}
.tabs button{height:32px;padding:0 14px;border-radius:999px;font:500 13px/1 var(--font);color:var(--on-sv);white-space:nowrap}
.tabs button.on{background:var(--s-lowest);color:var(--on-bg)}
.list{display:flex;flex-direction:column}
.list>li,.list>.item{display:flex;align-items:center;gap:12px;padding:12px 4px;border-bottom:1px solid var(--outline-v);min-width:0}
.list>li:last-child,.list>.item:last-child{border-bottom:0}
.list .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.table th{font:600 12px/1.2 var(--font);color:var(--on-sv);text-align:left;padding:8px 10px;border-bottom:1px solid var(--outline-v)}
.table td{padding:10px;border-bottom:1px solid var(--outline-v)}
.table tr:last-child td{border-bottom:0}
.scroll-x{overflow-x:auto;max-width:100%}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:40px 16px;text-align:center;color:var(--on-sv)}
.progress{height:8px;border-radius:999px;background:var(--s-high);overflow:hidden}
.progress>span{display:block;height:100%;border-radius:999px;background:var(--primary)}
.check{appearance:none;width:20px;height:20px;border-radius:6px;border:2px solid var(--outline);display:inline-grid;place-items:center;flex:none;cursor:pointer;margin:0}
.check:checked{background:var(--primary);border-color:var(--primary)}
.check:checked::after{content:"";width:9px;height:5px;border:2px solid var(--on-primary);border-top:0;border-right:0;transform:translateY(-1px) rotate(-45deg)}
.input,.select,.textarea{height:40px;padding:0 14px;border-radius:var(--r-sm);border:1px solid var(--outline-v);background:var(--s-lowest);color:var(--on-bg);min-width:0}
.textarea{height:auto;padding:10px 14px;resize:vertical}
.input:focus,.select:focus,.textarea:focus{outline:2px solid var(--primary);outline-offset:-1px;border-color:transparent}
.divider{height:1px;background:var(--outline-v);border:0;margin:8px 0}
.dot{width:8px;height:8px;border-radius:50%;background:var(--primary);flex:none;display:inline-block}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--tert)}.dot.err{background:var(--err)}.dot.mute{background:var(--outline)}
.bar-chart{display:flex;align-items:flex-end;gap:6px;height:120px}
.bar-chart>span{flex:1;min-width:4px;border-radius:6px 6px 0 0;background:var(--chart-1)}
.hide-narrow{}
@media (max-width:600px){.hide-narrow{display:none}}
`

/** Accent tones by id, light and dark, for the bridge to paint the four accent tokens (shared/brand.ts). */
function accentTable(): Record<string, { light: string[]; dark: string[] }> {
  const table: Record<string, { light: string[]; dark: string[] }> = {}
  for (const accent of ACCENTS) {
    table[accent.id] = accent.id === 'iris' ? { light: [...IRIS.light], dark: [...IRIS.dark] } : { light: [...(accent.light ?? IRIS.light)], dark: [...(accent.dark ?? IRIS.dark)] }
  }
  return table
}

/**
 * The bridge, as the app's first script. `window.agent`: call(tool, args), subscribe(topic, fn), onRefresh(fn),
 * store.get/set/remove/keys, theme.get/onChange, ask(text), ready() (its first data is drawn: the look check shoots).
 * Results that are JSON come back parsed.
 */
export function agentJs(): string {
  return `(function(){
"use strict";
var ACC=${JSON.stringify(accentTable())};
var KEYS=["--primary","--on-primary","--pc","--on-pc"];
var q=new URLSearchParams(location.search);
var state={dark:q.get("theme")==="dark",accent:q.get("accent")||"iris"};
function paint(){var r=document.documentElement;r.setAttribute("data-theme",state.dark?"dark":"light");var t=ACC[state.accent]||ACC.iris;var v=state.dark?t.dark:t.light;for(var i=0;i<KEYS.length;i++)r.style.setProperty(KEYS[i],v[i]);}
paint();
var transport=null,queue=[],seq=0,pending={},subs={},themeFns=[],readySent=false;
function send(m){if(transport)transport(m);else queue.push(m);}
function flush(){var w=queue;queue=[];for(var i=0;i<w.length;i++)send(w[i]);}
function parse(v){if(typeof v!=="string")return v;var s=v.trim();if(s[0]==="{"||s[0]==="["){try{return JSON.parse(s)}catch(e){}}return v;}
function receive(m){if(!m||typeof m!=="object")return;
if(m.op==="reply"){var p=pending[m.id];if(!p)return;delete pending[m.id];if(m.ok)p.resolve(m.result);else p.reject(new Error(m.error||"Not done"));return;}
if(m.op==="event"){var list=(subs[m.topic]||[]).slice();for(var i=0;i<list.length;i++){try{list[i](m.data)}catch(e){console.error(e)}}return;}
if(m.op==="theme"){state.dark=!!m.dark;state.accent=m.accent||"iris";paint();for(var j=0;j<themeFns.length;j++){try{themeFns[j]({dark:state.dark,accent:state.accent})}catch(e){console.error(e)}}}}
window.addEventListener("message",function(e){if(e.source!==window.parent||e.source===window||!e.data||e.data.type!=="agent:port"||!e.ports||!e.ports[0])return;var port=e.ports[0];port.onmessage=function(ev){receive(ev.data)};transport=function(m){port.postMessage(m)};flush();});
if(window.__miniappHost){var h=window.__miniappHost;transport=function(m){h.post(JSON.stringify(m))};h.onMessage(function(s){receive(JSON.parse(s))});}
if(window.AgentBridge&&typeof window.AgentBridge.post==="function"){var b=window.AgentBridge;transport=function(m){b.post(JSON.stringify(m))};window.__agentReceive=function(s){receive(typeof s==="string"?JSON.parse(s):s)};}
function request(op,extra){return new Promise(function(res,rej){var id=++seq;pending[id]={resolve:res,reject:rej};var m={op:op,id:id};for(var k in extra)m[k]=extra[k];send(m);});}
var agent={
call:function(tool,args){return request("call",{tool:String(tool),args:args||{}}).then(parse);},
subscribe:function(topic,fn){topic=String(topic);var l=subs[topic]=subs[topic]||[];l.push(fn);if(l.length===1)send({op:"subscribe",topic:topic});return function(){var i=l.indexOf(fn);if(i>=0)l.splice(i,1);if(l.length===0)send({op:"unsubscribe",topic:topic});};},
onRefresh:function(fn){return agent.subscribe("refresh",fn);},
store:Object.freeze({get:function(k){return request("store.get",{key:String(k)}).then(function(v){return v==null?null:parse(v)})},set:function(k,v){return request("store.set",{key:String(k),value:typeof v==="string"?v:JSON.stringify(v)})},remove:function(k){return request("store.remove",{key:String(k)})},keys:function(){return request("store.keys",{})}}),
theme:Object.freeze({get:function(){return{dark:state.dark,accent:state.accent}},onChange:function(fn){themeFns.push(fn);return function(){var i=themeFns.indexOf(fn);if(i>=0)themeFns.splice(i,1)}}}),
ask:function(text){return request("ask",{text:String(text)});},
ready:function(){if(!readySent){readySent=true;send({op:"ready"});}}
};
Object.freeze(agent);
Object.defineProperty(window,"agent",{value:agent,writable:false,configurable:false});
window.addEventListener("error",function(e){send({op:"error",text:String(e.message||e)})});
window.addEventListener("unhandledrejection",function(e){send({op:"error",text:String(e.reason&&e.reason.message||e.reason)})});
send({op:"hello"});
})();`
}

/**
 * The app's index.html as served: the tokens, the kit and the bridge go first in <head>, before anything of its own,
 * so its first paint is already in the right theme.
 */
export function frameHtml(index: string): string {
  const head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/_agent/tokens.css"><link rel="stylesheet" href="/_agent/ui.css"><script src="/_agent/agent.js"></script>'
  const headTag = /<head\b[^>]*>/i.exec(index)
  if (headTag !== null) return index.slice(0, headTag.index + headTag[0].length) + head + index.slice(headTag.index + headTag[0].length)
  const htmlTag = /<html\b[^>]*>/i.exec(index)
  if (htmlTag !== null) return index.slice(0, htmlTag.index + htmlTag[0].length) + `<head>${head}</head>` + index.slice(htmlTag.index + htmlTag[0].length)
  return `<!doctype html><html><head>${head}</head><body>${index}</body></html>`
}

/** The content type of one of its files. */
export function mimeOf(name: string): string {
  if (name.endsWith('.html')) return 'text/html; charset=utf-8'
  if (name.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (name.endsWith('.css')) return 'text/css; charset=utf-8'
  if (name.endsWith('.svg')) return 'image/svg+xml'
  if (name.endsWith('.json')) return 'application/json; charset=utf-8'
  if (name.endsWith('.woff2')) return 'font/woff2'
  return 'application/octet-stream'
}

/**
 * One request to a mini-app's files, answered the same on every platform: path is what follows miniapp://<id>/.
 * `font` is the app font's bytes when the platform has them (the desktop's renderer assets).
 */
export function serveMiniApp(files: Record<string, string> | null, path: string, font?: (name: string) => Uint8Array | null): { status: number; type: string; body: string | Uint8Array } {
  const clean = decodeURIComponent(path.split('?')[0] ?? '').replace(/^\/+/, '') || 'index.html'
  if (clean === '_agent/tokens.css') return { status: 200, type: mimeOf('x.css'), body: TOKENS_CSS + FONT_FACE }
  if (clean === '_agent/ui.css') return { status: 200, type: mimeOf('x.css'), body: UI_CSS }
  if (clean === '_agent/agent.js') return { status: 200, type: mimeOf('x.js'), body: agentJs() }
  if (clean.startsWith('_agent/fonts/')) {
    const bytes = font?.(clean.slice('_agent/fonts/'.length)) ?? null
    return bytes === null ? { status: 404, type: 'text/plain', body: 'Not found' } : { status: 200, type: mimeOf('x.woff2'), body: bytes }
  }
  if (files === null) return { status: 404, type: 'text/plain', body: 'No such app' }
  const text = files[clean]
  if (text === undefined) return { status: 404, type: 'text/plain', body: 'Not found' }
  return { status: 200, type: mimeOf(clean), body: clean === 'index.html' ? frameHtml(text) : text }
}

/** The app font, from the frame's own origin (so font-src 'self' holds). */
export const MINIAPP_FONTS = ['roboto-flex-latin-wght-normal.woff2', 'roboto-flex-latin-ext-wght-normal.woff2'] as const
const FONT_FACE = `
@font-face{font-family:'Roboto Flex Variable';font-style:normal;font-display:swap;font-weight:100 1000;src:url(/_agent/fonts/${MINIAPP_FONTS[0]}) format('woff2-variations');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:'Roboto Flex Variable';font-style:normal;font-display:swap;font-weight:100 1000;src:url(/_agent/fonts/${MINIAPP_FONTS[1]}) format('woff2-variations');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
`
