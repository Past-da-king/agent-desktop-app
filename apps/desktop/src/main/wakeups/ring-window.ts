/**
 * The PC ring (wake-ups): a frameless, always-on-top, full-screen window on every display in the severity colour,
 * the title and the exact what-to-do, I'm on it / Snooze / Open, and a loud looping alarm on the main display (made
 * in the page with Web Audio, no file). It never closes by itself and cannot be closed by Alt+F4: only an answer
 * (here, on the phone or in Settings) ends it. It cannot wake a sleeping computer; the phone covers that.
 *
 * The page has no preload and no Node: a button sets the page title to a signed line (this window's own random
 * token), which the main process reads from 'page-title-updated' and swallows. (A data: page ignores URL hash
 * changes, so the hash cannot carry it: found in the 0.2.96 test copy, the buttons did nothing.)
 */
import { randomBytes } from 'node:crypto'

import { BrowserWindow, screen, type Rectangle } from 'electron'

import { HEADS_UP_CYCLE_MS, SEVERITY_LOOK } from '../../shared/wakeups'
import type { RingItem, WakeRinger } from './service'

export interface RingWindowDeps {
  onAck: (id: string) => void
  onSnooze: (id: string) => void
  onOpen: (id: string, link: string) => void
  /** Flash the app's taskbar button while ringing. */
  flash?: (on: boolean) => void
  volume: () => number
  snoozeMinutes: () => number
  log?: (line: string, detail?: Record<string, unknown>) => void
  /**
   * Proof mode for a test copy (AGENT_WAKEUP_PROOF=1): the same windows, but never shown on his screens and muted,
   * so a test does not blare at him. The page still runs its alarm (window.__ring says so) and can be captured.
   */
  proof?: boolean
}

export class RingWindow implements WakeRinger {
  private windows: BrowserWindow[] = []
  private items: RingItem[] = []
  private closing = false

  constructor(private readonly deps: RingWindowDeps) {}

  show(items: RingItem[]): void {
    this.items = items
    if (items.length === 0) {
      this.closeAll()
      return
    }
    const displays = screen.getAllDisplays()
    const primary = screen.getPrimaryDisplay()
    // One window per display; rebuilt when displays change.
    if (this.windows.length !== displays.length || this.windows.some((w) => w.isDestroyed())) {
      this.closeAll()
      this.windows = displays.map((display) => this.open(display.bounds, display.id === primary.id))
    } else {
      for (const win of this.windows) this.render(win)
    }
    this.deps.flash?.(true)
  }

  /** For tests and proof: what the windows are. */
  state(): Array<{ bounds: Rectangle; alwaysOnTop: boolean; visible: boolean; sound: boolean }> {
    return this.windows
      .filter((w) => !w.isDestroyed())
      .map((w, i) => ({ bounds: w.getBounds(), alwaysOnTop: w.isAlwaysOnTop(), visible: w.isVisible(), sound: i === 0 }))
  }

  private open(bounds: Rectangle, main: boolean): BrowserWindow {
    const proof = this.deps.proof === true
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: true,
      skipTaskbar: false,
      alwaysOnTop: true,
      show: false,
      paintWhenInitiallyHidden: true,
      backgroundColor: SEVERITY_LOOK[this.items[0]?.severity ?? 'urgent'].bg,
      title: 'Wake-up',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true)
    win.setBounds(bounds)
    if (proof) win.webContents.setAudioMuted(true)
    win.on('close', (event) => {
      // Only an answer closes it.
      if (!this.closing && this.items.length > 0) event.preventDefault()
    })
    const token = randomBytes(12).toString('hex')
    win.on('page-title-updated', (event, title) => {
      event.preventDefault()
      this.onSignal(title, token)
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(main, token))}`).then(() => {
      if (win.isDestroyed()) return
      this.render(win)
      if (!proof) {
        win.show()
        win.focus()
        win.moveTop()
      }
    })
    return win
  }

  private render(win: BrowserWindow): void {
    if (win.isDestroyed()) return
    const payload = {
      items: this.items.map((item) => ({ ...item, look: SEVERITY_LOOK[item.severity] })),
      volume: Math.min(1, Math.max(0.1, this.deps.volume())),
      snooze: this.deps.snoozeMinutes(),
      cycle: HEADS_UP_CYCLE_MS,
    }
    win.setBackgroundColor(SEVERITY_LOOK[this.items[0]?.severity ?? 'urgent'].bg)
    void win.webContents.executeJavaScript(`window.render && window.render(${JSON.stringify(payload)})`).catch(() => undefined)
  }

  /** A button pressed: the title is "wake|<token>|<what>|<id>|<n>"; anything else (the page's own title) is ignored. */
  private onSignal(title: string, token: string): void {
    const [tag, got, what, id] = title.split('|')
    if (tag !== 'wake' || got !== token || id === undefined || id === '') return
    const item = this.items.find((i) => i.id === id)
    this.deps.log?.('wakeups: pressed on the computer', { what, id })
    if (what === 'ack') this.deps.onAck(id)
    else if (what === 'snooze') this.deps.onSnooze(id)
    else if (what === 'open' && item !== undefined) this.deps.onOpen(id, item.link)
  }

  private closeAll(): void {
    this.closing = true
    for (const win of this.windows) if (!win.isDestroyed()) win.destroy()
    this.windows = []
    this.closing = false
    this.deps.flash?.(false)
  }
}

/** The ring page. `main`: this display plays the sound. */
function page(main: boolean, token: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Wake-up</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%;font-family:"Segoe UI Variable","Segoe UI",system-ui,sans-serif;-webkit-user-select:none;user-select:none;overflow:hidden}
body{display:flex;align-items:center;justify-content:center;transition:background .2s}
.card{max-width:min(920px,86vw);text-align:left}
.sev{font-size:15px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;opacity:.9;display:flex;gap:12px;align-items:center}
.dot{width:14px;height:14px;border-radius:50%;background:currentColor;animation:pulse 1s infinite}
@keyframes pulse{50%{opacity:.25}}
h1{font-size:clamp(34px,5vw,64px);line-height:1.08;margin:18px 0 18px;font-weight:700}
.what{font-size:clamp(20px,2.4vw,30px);line-height:1.35;margin:0 0 14px;opacity:.97;white-space:pre-wrap}
.meta{font-size:15px;opacity:.8;margin-bottom:40px}
.row{display:flex;gap:16px;flex-wrap:wrap}
button{font:inherit;font-size:20px;font-weight:600;border-radius:999px;padding:18px 34px;cursor:pointer;border:2px solid currentColor;background:transparent;color:inherit}
button.primary{background:#fff;border-color:#fff}
button:focus-visible{outline:4px solid #fff;outline-offset:3px}
.more{margin-top:34px;font-size:15px;opacity:.85}
.more div{margin-top:6px}
</style></head><body><div class="card" id="card"></div>
<script>
const MAIN=${main ? 'true' : 'false'};const TOKEN='${token}';let presses=0;
let ctx=null,timer=null,current=null;
window.__ring={playing:false,beeps:0,items:0};
function beep(at,f,len,vol){const o=ctx.createOscillator(),g=ctx.createGain();o.type='square';o.frequency.value=f;g.gain.setValueAtTime(0,at);g.gain.linearRampToValueAtTime(vol,at+0.01);g.gain.setValueAtTime(vol,at+len-0.02);g.gain.linearRampToValueAtTime(0,at+len);o.connect(g);g.connect(ctx.destination);o.start(at);o.stop(at+len+0.01);window.__ring.beeps++}
function burst(vol){if(!ctx)return;const t=ctx.currentTime+0.02;for(let i=0;i<4;i++){beep(t+i*0.5,880,0.18,vol*0.6);beep(t+i*0.5+0.22,1175,0.18,vol*0.6)}}
function startSound(it,vol,cycle){stopSound();if(!MAIN||!it.sound)return;try{ctx=ctx||new AudioContext();ctx.resume()}catch(e){return}
window.__ring.playing=true;const every=it.severity==='heads_up'?cycle:2200;const once=it.severity==='heads_up'?3:1;
const play=()=>{for(let i=0;i<once;i++)setTimeout(()=>burst(vol),i*2200)};play();timer=setInterval(play,every)}
function stopSound(){if(timer)clearInterval(timer);timer=null;window.__ring.playing=false}
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function go(what,id){presses++;window.__ring.pressed=what;document.title='wake|'+TOKEN+'|'+what+'|'+id+'|'+presses}
window.render=function(p){const items=p.items;window.__ring.items=items.length;if(!items.length){stopSound();return}
const it=items[0];document.body.style.background=it.look.bg;document.body.style.color=it.look.on;
const card=document.getElementById('card');card.textContent='';
const sev=el('div','sev');sev.appendChild(el('span','dot'));sev.appendChild(el('span','',it.look.label+(it.cancelled?' · cancelled':'')));card.appendChild(sev);
card.appendChild(el('h1','',it.title));card.appendChild(el('p','what',it.whatToDo));
const when=new Date(it.ringAt);card.appendChild(el('div','meta','Since '+when.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+(it.firedBy?' · from '+it.firedBy:'')+(it.sourceKind?' · '+it.sourceKind:'')));
const row=el('div','row');const ack=el('button','primary',"I'm on it");ack.style.color=it.look.bg;ack.onclick=()=>go('ack',it.id);row.appendChild(ack);
const sn=el('button','','Snooze '+p.snooze+' min');sn.onclick=()=>go('snooze',it.id);row.appendChild(sn);
if(it.link){const op=el('button','','Open');op.onclick=()=>go('open',it.id);row.appendChild(op)}
card.appendChild(row);
if(items.length>1){const more=el('div','more');more.appendChild(el('div','',(items.length-1)+' more ringing:'));for(const o of items.slice(1,5))more.appendChild(el('div','','• '+o.look.label+': '+o.title));card.appendChild(more)}
ack.focus();
const key=it.id+'|'+it.severity+'|'+it.sound;if(key!==current){current=key;startSound(it,p.volume,p.cycle)}}
</script></body></html>`
}
