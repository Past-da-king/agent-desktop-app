/**
 * What every page in the agent's browser sees before its own scripts run, so it looks like the Chrome it says it
 * is. Measured on 0.2.22 (21 Oct 2026) on Google's sign-in page: `window.chrome` was an empty object (real Chrome
 * has app, csi and loadTimes) and outerWidth was smaller than innerWidth (the page is laid out at 1440 inside a
 * smaller window), two classic embedded-browser tells that a sign-in risk check can read. Nothing here claims a
 * different browser or version; it only fills in what a real Chrome window has.
 */
export const PRESENCE_SCRIPT = `(() => {
  try {
    const own = new WeakSet();
    const nativeToString = Function.prototype.toString;
    const toString = new Proxy(nativeToString, {
      apply(target, self, args) {
        return own.has(self) ? 'function ' + (self.name || '') + '() { [native code] }' : Reflect.apply(target, self, args);
      },
    });
    own.add(toString);
    Function.prototype.toString = toString;
    const fn = (name, body) => {
      const f = { [name]: function () { return body.apply(this, arguments); } }[name];
      own.add(f);
      return f;
    };

    const chrome = window.chrome || {};
    if (!('app' in chrome)) {
      chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: fn('getDetails', () => null),
        getIsInstalled: fn('getIsInstalled', () => false),
        runningState: fn('runningState', () => 'cannot_run'),
      };
    }
    if (!('csi' in chrome)) {
      chrome.csi = fn('csi', () => {
        const start = performance.timeOrigin;
        return { startE: Math.round(start), onloadT: Math.round(start + performance.now()), pageT: performance.now(), tran: 15 };
      });
    }
    if (!('loadTimes' in chrome)) {
      chrome.loadTimes = fn('loadTimes', () => {
        const start = performance.timeOrigin / 1000;
        const nav = performance.getEntriesByType('navigation')[0];
        const at = (ms) => start + (ms || 0) / 1000;
        return {
          requestTime: start,
          startLoadTime: start,
          commitLoadTime: at(nav && nav.responseStart),
          finishDocumentLoadTime: at(nav && nav.domContentLoadedEventEnd),
          finishLoadTime: at(nav && nav.loadEventEnd),
          firstPaintTime: at(nav && nav.responseEnd),
          firstPaintAfterLoadTime: 0,
          navigationType: 'Other',
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
          npnNegotiatedProtocol: 'h2',
          wasAlternateProtocolAvailable: false,
          connectionInfo: 'h2',
        };
      });
    }
    if (!window.chrome) Object.defineProperty(window, 'chrome', { value: chrome, writable: true, configurable: true, enumerable: true });

    // A window is never smaller than the page inside it.
    const outer = (name, inner, frame) => {
      const proto = Object.getOwnPropertyDescriptor(window, name);
      const read = proto && proto.get;
      if (!read) return;
      Object.defineProperty(window, name, {
        get: fn('get ' + name, function () { return Math.max(read.call(window), window[inner] + frame); }),
        set: proto.set,
        configurable: true,
        enumerable: true,
      });
    };
    outer('outerWidth', 'innerWidth', 0);
    outer('outerHeight', 'innerHeight', 85);
  } catch (e) {
    // A page that froze these properties keeps its own; browsing goes on.
  }
})();`
