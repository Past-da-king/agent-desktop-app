/**
 * The human-verification regression probe.
 *
 * Opened with `AGENT_TURNSTILE_PROBE=<url>`, the app loads that page in its real agent browser, waits, reads what
 * the page and its Worker see, and writes one JSON file (`AGENT_TURNSTILE_PROBE_OUT`), then quits. It exists so a
 * Cloudflare Turnstile widget (or a managed challenge) can be checked the way a person meets it, in the real
 * browser of a real build, at desktop size and again at phone size.
 *
 * What "passing" looks like: `tokens` holds a `cf-turnstile-response` value with no interaction, the Worker's user
 * agent is the same clean Chrome as the top frame, `Function.prototype.toString` is native, and the window geometry
 * is possible (outer no bigger than the screen).
 */
import { writeFileSync } from 'node:fs'

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface TurnstileProbeHost {
  probeOpen(url: string): Promise<string>
  evaluate(code: string, seconds: number): Promise<string>
  view(request: { mode: 'desktop' | 'tablet' | 'phone'; remember?: boolean }): Promise<unknown>
}

/** What the page reports about itself, as JSON text. */
export const TURNSTILE_PAGE_SCRIPT = `(() => {
  const tokens = Array.from(document.querySelectorAll('input[name="cf-turnstile-response"]')).map((i) => i.value || '');
  const frames = Array.from(document.querySelectorAll('iframe')).map((f) => f.src).filter((s) => s.indexOf('challenges.cloudflare.com') !== -1);
  const widgets = Array.from(document.querySelectorAll('[id*=turnstile], [class*=turnstile]')).map((e) => (e.innerText || '').trim().slice(0, 120)).filter((t) => t !== '');
  return JSON.stringify({
    href: location.href,
    title: document.title,
    tokens: tokens,
    challengeFrames: frames.length,
    widgetText: widgets.slice(0, 4),
    pageText: (document.body ? document.body.innerText : '').slice(0, 300),
    ua: navigator.userAgent,
    uaData: navigator.userAgentData && navigator.userAgentData.toJSON ? navigator.userAgentData.toJSON() : null,
    webdriver: navigator.webdriver,
    toStringNative: Function.prototype.toString.toString(),
    chromeKeys: window.chrome ? Object.keys(window.chrome) : null,
    chromeRuntime: !!(window.chrome && window.chrome.runtime),
    notif: typeof Notification === 'undefined' ? null : Notification.permission,
    plugins: navigator.plugins.length,
    screen: [screen.width, screen.height, screen.availWidth, screen.availHeight],
    win: [innerWidth, innerHeight, outerWidth, outerHeight],
    dpr: devicePixelRatio,
    touch: navigator.maxTouchPoints,
    lang: navigator.language,
    langs: navigator.languages,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
  });
})()`

/**
 * Renders the site's own Turnstile widget straight onto the page we are already on, so the widget is tested on the
 * origin its sitekey belongs to without walking a seven step form. A function of the sitekey; the token is polled.
 */
const RENDER_WIDGET = `(function (sitekey) {
  if (document.getElementById('turnstile-probe-host')) return 'already';
  const host = document.createElement('div');
  host.id = 'turnstile-probe-host';
  host.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;background:#fff;padding:8px';
  const mount = document.createElement('div');
  host.appendChild(mount);
  document.body.appendChild(host);
  const draw = () => {
    try {
      window.turnstile.render(mount, { sitekey: sitekey, callback: function (token) { window.__probeToken = token; }, 'error-callback': function (code) { window.__probeError = String(code); } });
      return 'rendered';
    } catch (e) {
      return 'render error ' + String(e);
    }
  };
  if (window.turnstile && window.turnstile.render) return draw();
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.onload = function () { window.__probeRender = draw(); };
  script.onerror = function () { window.__probeRender = 'script blocked'; };
  document.head.appendChild(script);
  return 'loading';
})`

/** One step of a multi-step form: answer what is obvious, then press the button that goes on. */
const WALK_STEP = `(() => {
  const seen = (el) => !!(el && el.offsetParent !== null && !el.disabled);
  const radios = Array.from(document.querySelectorAll('input[type=radio]')).filter(seen);
  if (radios.length > 0 && !radios.some((r) => r.checked)) radios[0].click();
  const boxes = Array.from(document.querySelectorAll('input[type=checkbox]')).filter(seen);
  if (boxes.length > 0 && !boxes.some((r) => r.checked)) boxes[0].click();
  for (const field of Array.from(document.querySelectorAll('input[type=text], input[type=email], input[type=tel], input[type=number], textarea')).filter(seen)) {
    if (field.value) continue;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value');
    const value = field.type === 'email' ? 'ayanda.test@example.com' : field.type === 'number' ? '12' : 'Test trading ltd';
    if (setter && setter.set) setter.set.call(field, value); else field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }
  for (const pick of Array.from(document.querySelectorAll('select')).filter(seen)) {
    if (pick.selectedIndex > 0) continue;
    pick.selectedIndex = 1;
    pick.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const wanted = /^(continue|next|press the button again|submit|get my quotes|see my options)/i;
  const button = Array.from(document.querySelectorAll('button')).filter(seen).find((b) => wanted.test((b.textContent || '').trim()));
  const where = () => {
    const body = (document.body ? document.body.innerText : '') || '';
    const widgets = document.querySelectorAll('.cf-turnstile, [data-sitekey]').length;
    const security = body.toLowerCase().indexOf('security check') !== -1 ? ' | says:security-check' : '';
    return ' | widgetHosts:' + widgets + ' | iframes:' + document.querySelectorAll('iframe').length + ' | len:' + body.length + security;
  };
  if (!button) return 'no button' + where();
  button.disabled = false;
  button.click();
  return 'clicked ' + (button.textContent || '').trim().slice(0, 24) + where();
})()`

const WORKER_START = `(() => {
  if (window.__workerProbe !== undefined) return 'already';
  try {
    const src = 'self.onmessage=()=>self.postMessage(JSON.stringify({ua:navigator.userAgent,uaData:navigator.userAgentData&&navigator.userAgentData.toJSON?navigator.userAgentData.toJSON():null}))';
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = (e) => { window.__workerProbe = String(e.data); };
    w.postMessage(1);
    return 'started';
  } catch (e) {
    window.__workerProbe = 'ERR ' + String(e);
    return 'error';
  }
})()`

/** Reads one snapshot of the page, at the current view, as a JSON string. */
async function snapshot(host: TurnstileProbeHost): Promise<string> {
  await host.evaluate(WORKER_START, 10).catch(() => undefined)
  await sleep(1200)
  const worker = await host.evaluate('String(window.__workerProbe || "none")', 10).catch(() => 'none')
  const page = await host.evaluate(TURNSTILE_PAGE_SCRIPT, 15).catch((error: unknown) => JSON.stringify({ error: String(error) }))
  let parsed: unknown = page
  try {
    parsed = JSON.parse(page)
  } catch {
    // keep the raw text: a page that would not answer still tells us something
  }
  return JSON.stringify({ page: parsed, worker })
}

/**
 * Loads `url`, waits the given time for the widget to make up its mind, then records desktop and phone snapshots.
 * Never throws: the file it writes is the result, and it quits the app when it is done.
 */
export async function runTurnstileProbe(host: TurnstileProbeHost, url: string, out: string, waitMs: number, quit: () => void): Promise<void> {
  const report: Record<string, unknown> = { url, at: new Date().toISOString(), waitMs }
  try {
    report['opened'] = await host.probeOpen(url)
    await host.evaluate(WORKER_START, 10).catch(() => undefined)
    // A quote form puts its widget on the last step: answer each step and press on, up to eight times.
    const walk: string[] = []
    for (let step = 0; step < 8; step += 1) {
      const answer = await host.evaluate(WALK_STEP, 15).catch((error: unknown) => `error ${String(error)}`)
      walk.push(`${step + 1}: ${answer}`)
      if (answer.includes('no button')) break
      await sleep(1500)
    }
    report['walk'] = walk
    // The widget itself, on this page's own origin with the site its sitekey belongs to.
    const rawKey = await host
      .evaluate(`String((Array.from(document.querySelectorAll('[data-sitekey]')).map((e) => e.getAttribute('data-sitekey'))[0]) || '')`, 10)
      .catch(() => '')
    // The page's own sitekey when it has one on screen, else the one the caller names (the widget may sit on a later step).
    const key = String(rawKey).replace(/^Result: "?/, '').replace(/"$/, '').trim() || (process.env['AGENT_TURNSTILE_SITEKEY'] ?? '').trim()
    report['sitekey'] = key
    if (key !== '') {
      report['render'] = await host.evaluate(`${RENDER_WIDGET}(${JSON.stringify(key)})`, 15).catch((error: unknown) => `error ${String(error)}`)
      await sleep(3000)
      report['renderState'] = await host
        .evaluate('String(window.__probeRender || "") + " | token:" + String(window.__probeToken || "") + " | error:" + String(window.__probeError || "")', 10)
        .catch(() => 'none')
    }
    const steps = Math.max(1, Math.round(waitMs / 5000))
    const seen: Array<{ seconds: number; tokens: string[]; frames: number; widgetText: string[] }> = []
    for (let step = 1; step <= steps; step += 1) {
      await sleep(5000)
      const probe = await host
        .evaluate(
          `JSON.stringify({ tokens: Array.from(document.querySelectorAll('input[name="cf-turnstile-response"]')).map((i) => i.value || ''), frames: Array.from(document.querySelectorAll('iframe')).map((f) => f.src).filter((s) => s.indexOf('challenges.cloudflare.com') !== -1).length, widgetText: Array.from(document.querySelectorAll('[id*=turnstile], [class*=turnstile]')).map((e) => (e.innerText || '').trim().slice(0, 80)).filter((t) => t !== '').slice(0, 3), probe: String(window.__probeRender || '') + '/' + String(window.__probeToken || '').slice(0, 24) + '/' + String(window.__probeError || '') })`,
          10,
        )
        .catch(() => '{}')
      try {
        seen.push({ seconds: step * 5, ...(JSON.parse(probe) as { tokens: string[]; frames: number; widgetText: string[] }) })
      } catch {
        seen.push({ seconds: step * 5, tokens: [], frames: 0, widgetText: [] })
      }
    }
    report['timeline'] = seen
    report['desktop'] = JSON.parse(await snapshot(host))
    await host.view({ mode: 'phone', remember: false }).catch(() => undefined)
    await sleep(2500)
    report['phone'] = JSON.parse(await snapshot(host))
  } catch (error) {
    report['error'] = String(error)
  } finally {
    try {
      if (out !== '') writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    } catch {
      // Nothing else to do: the console line below still carries the report.
    }
    console.log(`TURNSTILE PROBE\n${JSON.stringify(report)}`)
    quit()
  }
}
