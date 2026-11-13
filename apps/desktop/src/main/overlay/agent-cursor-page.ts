/**
 * The page inside the agent cursor window (11 Nov 2026): the cursor and its label, drawn from the app's own brand
 * tokens (shared/brand.ts BrandLook: the accent, the surface, the font and the radius; no colour of its own), at the
 * place the main process gives. Plain strings, no preload, no Node, no network; the main process pushes each state
 * with executeJavaScript.
 *
 * It must never look like the system arrow: it is a rounded pointer in the accent with a light edge and a soft glow, and
 * its label is a small accent pill. It glides (CSS transform transition), pulses on a click, and is `pointer-events:none`
 * everywhere: the window lets every click through as well.
 */
import type { BrandLook } from '../../shared/brand'
import type { CursorPageState } from './agent-cursor'

function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (m === null) return hex
  const n = parseInt(m[1] ?? '000000', 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

/** The cursor's CSS, made of the look only. */
export function cursorStyle(look: BrandLook): string {
  const font = look.font.replace(/'/g, '"')
  const glow = withAlpha(look.primary, look.dark ? 0.55 : 0.4)
  const shade = look.dark ? 'rgba(0,0,0,.6)' : 'rgba(20,16,60,.28)'
  return (
    'html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none;user-select:none}' +
    '[hidden]{display:none !important}' +
    '.c{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;will-change:transform;transition:transform .42s cubic-bezier(.22,.8,.24,1),opacity .2s}' +
    '.c.jump{transition:none}' +
    '.c.gone{opacity:0}' +
    // The pointer: tip at the c origin, leaning a little, filled in the accent with the edge colour around it.
    `.p{position:absolute;left:-3px;top:-3px;width:26px;height:30px;filter:drop-shadow(0 0 7px ${glow}) drop-shadow(0 2px 3px ${shade})}` +
    `.p path{fill:${look.primary};stroke:${look.edge};stroke-width:2.2;stroke-linejoin:round}` +
    `.p circle{fill:${look.onPrimary}}` +
    `.t{position:absolute;left:20px;top:26px;max-width:300px;box-sizing:border-box;padding:4px 11px;border-radius:${look.radius}px;background:${look.primary};color:${look.onPrimary};` +
    `font:600 12.5px/1.35 ${font};letter-spacing:.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1.5px solid ${look.edge};box-shadow:0 4px 14px ${shade};-webkit-font-smoothing:antialiased}` +
    '.t:empty{display:none}' +
    '.t.flip{left:auto;right:6px}' +
    '.t.up{top:auto;bottom:26px}' +
    `.r{position:absolute;left:-18px;top:-18px;width:36px;height:36px;box-sizing:border-box;border-radius:50%;border:3px solid ${look.primary};box-shadow:0 0 0 1.5px ${look.edge};opacity:0;pointer-events:none}` +
    '.r.go{animation:cr .55s ease-out}' +
    '@keyframes cr{0%{opacity:.95;transform:scale(.3)}100%{opacity:0;transform:scale(1.7)}}' +
    '@media (prefers-reduced-motion:reduce){.c{transition:none}.r.go{animation:none}}'
  )
}

export function cursorHtml(look: BrandLook): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style id="look">${cursorStyle(look)}</style></head><body><div id="stage"></div><script>${SCRIPT}</script></body></html>`
}

export function cursorSetScript(state: CursorPageState | null): string {
  return `globalThis.__cursor && globalThis.__cursor.set(${JSON.stringify(state)})`
}

export function cursorStyleScript(look: BrandLook): string {
  return `globalThis.__cursor && globalThis.__cursor.style(${JSON.stringify(cursorStyle(look))})`
}

export const CURSOR_EVENT = '__agent_cursor:'

export function parseCursorEvent(line: string): { type: 'ready' } | null {
  if (!line.startsWith(CURSOR_EVENT)) return null
  try {
    const parsed = JSON.parse(line.slice(CURSOR_EVENT.length)) as { type?: unknown }
    return parsed.type === 'ready' ? { type: 'ready' } : null
  } catch {
    return null
  }
}

const SCRIPT = `
(() => {
  const stage = document.getElementById('stage');
  const nodes = new Map();
  const SVG = '<svg class="p" viewBox="0 0 26 30" aria-hidden="true"><path d="M4.2 3.2 L22.2 13.4 Q23.6 14.3 22.1 15.1 L14.6 18.2 L11.4 25.9 Q10.7 27.5 9.7 26.1 L3.4 5.3 Q3 3.2 4.2 3.2 Z"/><circle cx="7" cy="7" r="1.6"/></svg>';
  const make = (id) => {
    const c = document.createElement('div'); c.className = 'c jump';
    c.innerHTML = '<div class="r"></div>' + SVG + '<div class="t"></div>';
    stage.appendChild(c);
    const n = { c, r: c.querySelector('.r'), t: c.querySelector('.t'), pulse: 0, born: true };
    nodes.set(id, n);
    return n;
  };
  const set = (state) => {
    const seen = new Set();
    if (state) for (const s of state.cursors) {
      seen.add(s.id);
      const n = nodes.get(s.id) || make(s.id);
      const text = (s.who ? s.who + ': ' : '') + (s.label || '');
      if (n.t.textContent !== text) n.t.textContent = text;
      const W = state.clip.width, H = state.clip.height;
      const w = n.t.offsetWidth || 0;
      n.t.classList.toggle('flip', s.x + 20 + w > W - 6);
      n.t.classList.toggle('up', s.y + 60 > H);
      n.c.classList.remove('gone');
      n.c.style.transform = 'translate(' + Math.round(s.x * 10) / 10 + 'px,' + Math.round(s.y * 10) / 10 + 'px)';
      if (n.born) { n.born = false; requestAnimationFrame(() => requestAnimationFrame(() => n.c.classList.remove('jump'))); }
      if (s.pulse !== n.pulse) { n.pulse = s.pulse; n.r.classList.remove('go'); void n.r.offsetWidth; n.r.classList.add('go'); }
    }
    for (const [id, n] of nodes) if (!seen.has(id)) { n.c.remove(); nodes.delete(id); }
  };
  const box = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; };
  globalThis.__cursor = {
    set,
    style: (css) => { const st = document.getElementById('look'); if (st) st.textContent = css; },
    read: () => [...nodes].map(([id, n]) => ({ id, pointer: box(n.c.querySelector('.p')), label: n.t.textContent, tag: box(n.t), pulse: n.pulse })),
  };
  try { console.debug(${JSON.stringify(CURSOR_EVENT)} + JSON.stringify({ type: 'ready' })); } catch (e) { /* closing */ }
})();
`
