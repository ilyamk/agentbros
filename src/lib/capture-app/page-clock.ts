/**
 * Installed before any page script runs. Replaces every clock the page can read with one the capturer steps:
 * performance.now, Date, requestAnimationFrame, setTimeout/setInterval, Math.random (seeded) and all
 * CSS/Web Animations (paused and seeked). The caret blinks on the wall clock, so it is hidden by default. Chromium's own virtual time is not used: on macOS its screenshots hang
 * intermittently and BeginFrame control is unsupported, and its animation clock still follows the wall.
 *
 * window.__captureSeek() births new animations at the current time; window.__captureAdvance(ms) moves time on,
 * firing due timers in order, then one round of animation-frame callbacks.
 */
export const pageClockSource = (seed: number, epochMs: number, hideCaret: boolean) => `(() => {
  if (window.__captureAdvance) return;
  if (${hideCaret}) {
    const style = document.createElement("style");
    style.textContent = "*, *::before, *::after { caret-color: transparent !important; }";
    const attach = () => (document.head || document.documentElement).appendChild(style);
    document.documentElement ? attach() : document.addEventListener("DOMContentLoaded", attach, { once: true });
  }
  let now = 0;
  const epoch = ${epochMs};
  let s = ${seed >>> 0} || 1;
  Math.random = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };

  const RealDate = Date;
  function FakeDate(...args) {
    if (!new.target) return new RealDate(epoch + now).toString();
    return args.length === 0 ? new RealDate(epoch + now) : new RealDate(...args);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => epoch + Math.floor(now);
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  window.Date = FakeDate;
  performance.now = () => now;

  let nextId = 1;
  const timers = new Map();
  const schedule = (fn, delay, args, repeat) => {
    const id = nextId++;
    const ms = Math.max(0, Number(delay) || 0);
    timers.set(id, { fn, args, due: now + ms, every: repeat ? Math.max(1, ms) : 0, order: id });
    return id;
  };
  window.setTimeout = (fn, delay, ...args) => schedule(fn, delay, args, false);
  window.setInterval = (fn, delay, ...args) => schedule(fn, delay, args, true);
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };

  let frameCallbacks = new Map();
  window.requestAnimationFrame = (fn) => { const id = nextId++; frameCallbacks.set(id, fn); return id; };
  window.cancelAnimationFrame = (id) => { frameCallbacks.delete(id); };

  const call = (fn, args) => { try { typeof fn === "function" ? fn(...args) : (0, eval)(String(fn)); } catch (error) { console.error(error); } };

  window.__captureSeek = () => {
    for (const a of document.getAnimations()) {
      if (a.__captureBorn === undefined) { a.__captureBorn = now; a.pause(); }
      a.currentTime = now - a.__captureBorn;
    }
    return now;
  };
  window.__captureAdvance = (ms) => {
    const target = now + ms;
    for (let guard = 0; guard < 100000; guard++) {
      let next;
      for (const [id, t] of timers) if (t.due <= target && (!next || t.due < next[1].due || (t.due === next[1].due && t.order < next[1].order))) next = [id, t];
      if (!next) break;
      const [id, t] = next;
      now = Math.max(now, t.due);
      if (t.every) { t.due += t.every; t.order = nextId++; } else timers.delete(id);
      call(t.fn, t.args || []);
    }
    now = target;
    const callbacks = frameCallbacks;
    frameCallbacks = new Map();
    for (const fn of callbacks.values()) call(fn, [now]);
    return window.__captureSeek();
  };
})();`;
