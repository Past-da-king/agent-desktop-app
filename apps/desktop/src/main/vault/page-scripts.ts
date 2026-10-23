/**
 * What the Vault puts into every page of the in-app browser (vault/browser-vault.ts), through the tab's own debugger.
 *
 * VAULT_WORLD_SCRIPT runs in an isolated world named `agent-vault` in every frame: the page cannot see it, cannot call
 * its binding and cannot read what it holds. It finds login fields, shows the suggestion list under a field (logins
 * for this site, a strong password on a new-password field, a passkey), fills a field only after a real click
 * (`isTrusted`), notices a submitted password, and shows the small Save / Update and passkey prompts.
 *
 * PASSKEY_HOOK runs in the page's own world, because that is where the page calls navigator.credentials. It only
 * asks: before a passkey is made or used it tells the vault world (a DOM event carrying a string) and waits for
 * vault, native or deny. It holds no secret; the vault side decides and loads keys only after a yes.
 */

export const VAULT_WORLD = 'agent-vault'
export const VAULT_BINDING = '__agentVault'

export const VAULT_WORLD_SCRIPT = String.raw`(() => {
  if (globalThis.__agentVaultReady) return;
  globalThis.__agentVaultReady = true;
  const binding = globalThis.__agentVault;
  if (typeof binding !== 'function') return;
  const top = window === window.top;
  let seq = 0;
  const waits = new Map();
  globalThis.__agentVaultReply = (id, data) => { const w = waits.get(id); if (w) { waits.delete(id); w(data); } };
  const request = (op, data) => new Promise((resolve) => {
    const id = ++seq;
    waits.set(id, resolve);
    setTimeout(() => { if (waits.has(id)) { waits.delete(id); resolve(null); } }, 120000);
    try { binding(JSON.stringify({ id, op, href: location.href, top, ...(data || {}) })); } catch (e) { waits.delete(id); resolve(null); }
  });

  // ---- fields ----
  const visible = (el) => { if (!el || !el.isConnected) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const hint = (el) => [el.name, el.id, el.autocomplete, el.placeholder, el.getAttribute('aria-label')].join(' ').toLowerCase();
  const isUserField = (el) => {
    if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return false;
    if (!/^(text|email|tel|)$/.test(el.type)) return false;
    const h = hint(el);
    if (/search|captcha|code|otp|amount|zip|postal|city|address/.test(h)) return false;
    if (/username|email|webauthn/.test(el.autocomplete)) return true;
    if (/user|e-?mail|login|account|identifier|phone|mobile/.test(h)) return true;
    const form = el.form || document;
    return !!form.querySelector && !!form.querySelector('input[type=password]');
  };
  const isNewPassword = (el) => {
    if (el.autocomplete === 'new-password') return true;
    if (el.autocomplete === 'current-password') return false;
    const h = hint(el);
    if (/new|confirm|repeat|again|create|choose/.test(h)) return true;
    const form = el.form;
    if (form) { const pws = [...form.querySelectorAll('input[type=password]')].filter(visible); if (pws.length >= 2 && !/current|old/.test(hint(pws[0]))) return true; }
    return false;
  };
  const kindOf = (el) => {
    if (!(el instanceof HTMLInputElement)) return null;
    if (el.type === 'password') return isNewPassword(el) ? 'new-password' : 'password';
    return isUserField(el) ? 'username' : null;
  };
  const setValue = (el, value) => {
    el.focus();
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    desc.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const scope = (el) => el.form || el.closest('form') || document;
  const userFieldIn = (root) => [...root.querySelectorAll('input')].filter((x) => visible(x) && isUserField(x))[0] || null;
  const passwordsIn = (root) => [...root.querySelectorAll('input[type=password]')].filter(visible);

  // ---- the little UI (a closed shadow root: the page cannot reach into it) ----
  let host = null, shadow = null;
  const ui = () => {
    if (host && host.isConnected) return shadow;
    host = document.createElement('agent-vault-ui');
    host.style.cssText = 'all: initial; position: fixed; inset: 0 auto auto 0; z-index: 2147483647; width: 0; height: 0;';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = [
      '.box{position:fixed;min-width:240px;max-width:360px;background:#fdfbff;color:#1b1b21;border:1px solid #c7c5d0;border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.22);font:14px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;padding:6px;overflow:hidden}',
      '.row{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;text-align:left;border:0;background:transparent;padding:9px 12px;border-radius:10px;cursor:pointer;color:inherit;font:inherit}',
      '.row:hover,.row:focus{background:#e7e0f8;outline:none}',
      '.row b{font-weight:600}.row span{font-size:12px;color:#47464f}',
      '.head{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#5d4dc9;padding:8px 12px 4px;font-weight:600}',
      '.bubble{position:fixed;top:14px;right:14px;width:320px;background:#fdfbff;color:#1b1b21;border:1px solid #c7c5d0;border-radius:18px;box-shadow:0 16px 40px rgba(0,0,0,.25);font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}',
      '.bubble h3{margin:0 0 4px;font-size:16px;font-weight:600}.bubble p{margin:0 0 12px;color:#47464f;font-size:13px;overflow-wrap:anywhere}',
      '.acts{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}',
      '.acts button{border:0;border-radius:999px;padding:8px 14px;font:600 13px system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;background:transparent;color:#4f3fbf}',
      '.acts button.main{background:#5d4dc9;color:#fff}',
      '@media (prefers-color-scheme: dark){.box,.bubble{background:#1f1f26;color:#e5e1ec;border-color:#47464f}.row:hover,.row:focus{background:#2f2a4a}.row span,.bubble p{color:#c8c5d0}.head{color:#c6bfff}.acts button{color:#c6bfff}.acts button.main{background:#c6bfff;color:#2b1d8a}}',
    ].join('');
    shadow.appendChild(style);
    (document.body || document.documentElement).appendChild(host);
    return shadow;
  };
  let list = null, listFor = null;
  const hideList = () => { if (list) { list.remove(); list = null; listFor = null; } };
  const showList = (field, rows, head) => {
    hideList();
    if (rows.length === 0) return;
    const root = ui();
    const box = document.createElement('div');
    box.className = 'box';
    box.setAttribute('role', 'listbox');
    if (head) { const h = document.createElement('div'); h.className = 'head'; h.textContent = head; box.appendChild(h); }
    for (const row of rows) {
      const b = document.createElement('button');
      b.className = 'row';
      b.type = 'button';
      b.setAttribute('role', 'option');
      const t = document.createElement('b'); t.textContent = row.label; b.appendChild(t);
      if (row.sub) { const s = document.createElement('span'); s.textContent = row.sub; b.appendChild(s); }
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => { if (!e.isTrusted) return; e.preventDefault(); e.stopPropagation(); void pick(field, row); });
      box.appendChild(b);
    }
    const r = field.getBoundingClientRect();
    box.style.left = Math.max(4, Math.min(r.left, innerWidth - 250)) + 'px';
    const below = r.bottom + 4;
    box.style.top = (below + 220 > innerHeight && r.top > 230 ? Math.max(4, r.top - 4 - Math.min(220, 52 * rows.length + 30)) : below) + 'px';
    box.style.minWidth = Math.max(240, Math.min(360, r.width)) + 'px';
    root.appendChild(box);
    list = box;
    listFor = field;
  };

  const fillLogin = (field, data) => {
    const root = scope(field);
    const user = field.type === 'password' ? userFieldIn(root) : field;
    if (user && data.username && user.type !== 'password') setValue(user, data.username);
    const pws = passwordsIn(root).filter((p) => !isNewPassword(p) || passwordsIn(root).length === 1);
    if (data.password) for (const p of (pws.length ? pws : passwordsIn(root)).slice(0, 1)) setValue(p, data.password);
    (field.type === 'password' ? field : user || field).focus();
  };

  const pick = async (field, row) => {
    hideList();
    if (row.kind === 'login') {
      const data = await request('fill', { key: row.key, field: kindOf(field) });
      if (data && data.ok) fillLogin(field, data);
    } else if (row.kind === 'generate') {
      const data = await request('generate', {});
      if (data && data.password) {
        const root = scope(field);
        const targets = passwordsIn(root).filter((p) => isNewPassword(p));
        for (const p of (targets.length ? targets : [field])) setValue(p, data.password);
        field.focus();
      }
    } else if (row.kind === 'passkey') {
      await request('passkeyPick', { key: row.key });
    }
  };

  document.addEventListener('focusin', async (e) => {
    const field = e.target;
    const kind = kindOf(field);
    if (!kind) return;
    const before = field.value;
    const answer = await request('suggest', { field: kind });
    // Not when the person moved on or started typing while it was on its way.
    if (!answer || document.activeElement !== field || field.value !== before) return;
    showList(field, answer.rows || [], answer.head || '');
  }, true);
  document.addEventListener('focusout', () => setTimeout(() => { if (list && listFor !== document.activeElement) hideList(); }, 150), true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideList(); }, true);
  // Typing means the person is not picking from the list: it goes, as in a browser.
  document.addEventListener('input', (e) => { if (list && e.isTrusted && e.target === listFor) hideList(); }, true);
  addEventListener('scroll', () => hideList(), true);
  addEventListener('resize', () => hideList());

  // ---- a submitted password: offer to save or update ----
  let lastSent = '';
  const collect = (root) => {
    const pws = passwordsIn(root).filter((p) => p.value !== '');
    const userEl = userFieldIn(root);
    const username = userEl ? userEl.value.trim() : '';
    if (pws.length === 0) {
      if (username !== '') void request('username', { username });
      return;
    }
    const fresh = pws.filter((p) => isNewPassword(p));
    const password = (fresh[0] || pws[pws.length - 1]).value;
    const key = username + '\u0000' + password;
    if (key === lastSent) return;
    lastSent = key;
    setTimeout(() => { if (lastSent === key) lastSent = ''; }, 3000);
    void request('submitted', { username, password, isNew: fresh.length > 0 }).then((answer) => { if (answer && answer.offer) showOffer(answer.offer); });
  };
  document.addEventListener('submit', (e) => { if (e.target instanceof HTMLFormElement) collect(e.target); }, true);
  document.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('button,input[type=submit],[role=button]') : null;
    if (!b) return;
    const root = b.closest('form') || document;
    if (passwordsIn(root).some((p) => p.value !== '') || (userFieldIn(root) && /next|continue|sign|log/i.test(b.textContent || b.value || ''))) collect(root);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
    if (kindOf(e.target)) collect(scope(e.target));
  }, true);

  // ---- prompts the vault side asks for ----
  let bubble = null;
  const closeBubble = () => { if (bubble) { bubble.remove(); bubble = null; } };
  const showBubble = (title, text, buttons) => {
    closeBubble();
    const root = ui();
    const box = document.createElement('div');
    box.className = 'bubble';
    box.setAttribute('role', 'dialog');
    const h = document.createElement('h3'); h.textContent = title; box.appendChild(h);
    const p = document.createElement('p'); p.textContent = text; box.appendChild(p);
    const acts = document.createElement('div'); acts.className = 'acts';
    for (const btn of buttons) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = btn.label;
      if (btn.main) b.className = 'main';
      b.addEventListener('click', (e) => { if (!e.isTrusted) return; closeBubble(); btn.run(); });
      acts.appendChild(b);
    }
    box.appendChild(acts);
    root.appendChild(box);
    bubble = box;
  };
  const showOffer = (offer) => {
    if (!top) return;
    const update = offer.mode === 'update';
    showBubble(update ? 'Update password?' : 'Save password?', (offer.username ? offer.username + ' on ' : '') + offer.site + (update ? '. The Vault has an older one.' : '. Your agent can then sign you in here.'), [
      { label: 'Never for this site', run: () => void request('offer', { token: offer.token, choice: 'never' }) },
      { label: 'Not now', run: () => void request('offer', { token: offer.token, choice: 'dismiss' }) },
      { label: update ? 'Update' : 'Save', main: true, run: () => void request('offer', { token: offer.token, choice: 'save' }) },
    ]);
    setTimeout(() => closeBubble(), 45000);
  };
  globalThis.__agentVaultPush = (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'offer') showOffer(msg.offer);
    if (msg.type === 'passkey') {
      const make = msg.op === 'create';
      showBubble(make ? 'Save a passkey in your Vault?' : 'Use your passkey?', (make ? 'For ' : 'Sign in to ') + msg.site + (msg.user ? ' as ' + msg.user : '') + (make ? '. It goes to your other devices with the Vault.' : '.'), [
        { label: 'Not now', run: () => void request('passkeyAnswer', { token: msg.token, yes: false }) },
        { label: make ? 'Save in Vault' : 'Use passkey', main: true, run: () => void request('passkeyAnswer', { token: msg.token, yes: true }) },
      ]);
    }
    if (msg.type === 'passkeyAnswer') document.dispatchEvent(new CustomEvent('__agentvault_pk_res', { detail: JSON.stringify({ id: msg.id, answer: msg.answer, allow: msg.allow || [] }) }));
  };

  // ---- the page's passkey requests (from PASSKEY_HOOK in the page's own world) ----
  document.addEventListener('__agentvault_pk_req', (e) => {
    let msg = null;
    try { msg = JSON.parse(String(e.detail)); } catch (err) { return; }
    if (!msg || typeof msg.id !== 'number') return;
    if (msg.op === 'done' || msg.op === 'abort') { void request('passkeyDone', { pid: msg.id, aborted: msg.op === 'abort' }); return; }
    void request('passkey', { pid: msg.id, kind: msg.op, rpId: String(msg.rpId || ''), rpName: String(msg.rpName || ''), user: String(msg.user || ''), conditional: !!msg.conditional }).then((answer) => {
      const value = answer && answer.answer ? answer.answer : 'native';
      if (value === 'wait') return;
      document.dispatchEvent(new CustomEvent('__agentvault_pk_res', { detail: JSON.stringify({ id: msg.id, answer: value, allow: (answer && answer.allow) || [] }) }));
    });
  });

  const hello = () => void request('hello', {}).then((answer) => { if (answer && answer.offer) showOffer(answer.offer); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hello, { once: true }); else hello();
})()`

export const PASSKEY_HOOK = String.raw`(() => {
  if (!globalThis.CredentialsContainer || globalThis.__agentVaultHook) return;
  Object.defineProperty(globalThis, '__agentVaultHook', { value: true });
  const P = CredentialsContainer.prototype;
  const ogGet = P.get, ogCreate = P.create;
  let seq = Math.floor(Math.random() * 1e6);
  const ask = (msg, signal) => new Promise((resolve, reject) => {
    const id = ++seq;
    const onRes = (e) => {
      let m = null;
      try { m = JSON.parse(String(e.detail)); } catch (err) { return; }
      if (!m || m.id !== id) return;
      document.removeEventListener('__agentvault_pk_res', onRes);
      resolve(m);
    };
    document.addEventListener('__agentvault_pk_res', onRes);
    if (signal) signal.addEventListener('abort', () => {
      document.removeEventListener('__agentvault_pk_res', onRes);
      document.dispatchEvent(new CustomEvent('__agentvault_pk_req', { detail: JSON.stringify({ id, op: 'abort' }) }));
      reject(signal.reason || new DOMException('The operation was aborted.', 'AbortError'));
    }, { once: true });
    document.dispatchEvent(new CustomEvent('__agentvault_pk_req', { detail: JSON.stringify({ ...msg, id }) }));
    msg.__id = id;
  });
  const wrap = async (op, og, self, options) => {
    const pk = options && options.publicKey;
    if (!pk) return og.call(self, options);
    const conditional = op === 'get' && options.mediation === 'conditional';
    const info = op === 'create'
      ? { op, rpId: (pk.rp && pk.rp.id) || location.hostname, rpName: (pk.rp && pk.rp.name) || '', user: (pk.user && (pk.user.name || pk.user.displayName)) || '' }
      : { op, rpId: pk.rpId || location.hostname, conditional };
    const reply = await ask(info, options.signal);
    const answer = reply.answer;
    if (answer === 'deny') throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError');
    if (answer !== 'vault') return og.call(self, options);
    let opts = conditional ? Object.assign({}, options, { mediation: 'optional' }) : options;
    // No credential named by the page (sign-in without a username): the vault names its own for this site,
    // since this browser has no account picker for that case.
    const allow = Array.isArray(reply.allow) ? reply.allow : [];
    if (op === 'get' && allow.length > 0 && !(pk.allowCredentials && pk.allowCredentials.length)) {
      const bytes = (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
      opts = Object.assign({}, opts, { publicKey: Object.assign({}, pk, { allowCredentials: allow.map((id) => ({ type: 'public-key', id: bytes(id) })) }) });
    }
    try {
      return await og.call(self, opts);
    } finally {
      document.dispatchEvent(new CustomEvent('__agentvault_pk_req', { detail: JSON.stringify({ id: info.__id, op: 'done' }) }));
    }
  };
  P.get = function get(options) { return wrap('get', ogGet, this, options); };
  P.create = function create(options) { return wrap('create', ogCreate, this, options); };
})()`
