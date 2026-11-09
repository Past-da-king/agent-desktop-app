/**
 * What every page in the agent's browser sees before its own scripts run.
 *
 * Kept deliberately small and inert: a real Chrome window has `window.chrome.app`, `csi` and `loadTimes`, so a
 * page that reads them does not get `undefined`. Nothing here rewrites `Function.prototype.toString`, and nothing
 * here touches the window geometry: both were measured lies (a native-code proxy is a textbook automation tell,
 * and forcing outerWidth above the screen made the window impossible). Plain closures only, added if missing.
 */
export const PRESENCE_SCRIPT = `(() => {
  try {
    const chrome = window.chrome || {};
    if (!('app' in chrome)) {
      chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: function getDetails() { return null; },
        getIsInstalled: function getIsInstalled() { return false; },
        runningState: function runningState() { return 'cannot_run'; },
      };
    }
    if (!('csi' in chrome)) {
      chrome.csi = function csi() {
        const start = performance.timeOrigin;
        return { startE: Math.round(start), onloadT: Math.round(start + performance.now()), pageT: performance.now(), tran: 15 };
      };
    }
    if (!('loadTimes' in chrome)) {
      chrome.loadTimes = function loadTimes() {
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
      };
    }
    if (!window.chrome) Object.defineProperty(window, 'chrome', { value: chrome, writable: true, configurable: true, enumerable: true });

    // An embedded page has no window of its own, so the engine reports outerWidth 0 and outerHeight 0: impossible.
    // Define the two getters on Window.prototype, where Chrome defines them, so the window is no smaller than the
    // page inside it and nothing shows up as an own property of the window.
    const bigger = (name, inner, extra) => {
      const descriptor =
        Object.getOwnPropertyDescriptor(Window.prototype, name) || Object.getOwnPropertyDescriptor(window, name);
      const read = descriptor && descriptor.get;
      if (!read) return;
      const target = Object.getOwnPropertyDescriptor(Window.prototype, name) ? Window.prototype : window;
      Object.defineProperty(target, name, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: function () { return Math.max(read.call(this) || 0, (this[inner] || 0) + extra); },
        set: descriptor.set,
      });
    };
    bigger('outerWidth', 'innerWidth', 0);
    bigger('outerHeight', 'innerHeight', 85);
  } catch (e) {
    // A page that froze these properties keeps its own; browsing goes on.
  }
})();`
