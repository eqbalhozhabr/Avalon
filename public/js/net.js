// Connection manager. The whole point of this file is that a phone which went
// to sleep gets back to its own seat *immediately* and without any user action:
//  * identity is (pid, token) saved in localStorage -> reconnect = same seat/role;
//  * every reconnect is answered with a full server snapshot (no replay needed);
//  * we reconnect on wake-up events instead of waiting for backoff timers;
//  * we tell the server the moment the page is hidden so others see "away" at once;
//  * a heartbeat watchdog detects half-open sockets that phones leave behind.

const HB_MS = 8000;
const DEAD_MS = 22000;

export const credsKey = (code) => `avalon.creds.${code}`;
export function loadCreds(code) {
  try {
    return JSON.parse(localStorage.getItem(credsKey(code)) || 'null');
  } catch {
    return null;
  }
}
export function saveCreds(code, c) {
  try {
    localStorage.setItem(credsKey(code), JSON.stringify(c));
  } catch {
    /* private mode */
  }
}
export function clearCreds(code) {
  try {
    localStorage.removeItem(credsKey(code));
  } catch {
    /* ignore */
  }
}

// The game may live under a sub-path (e.g. https://luckylion.games/avalon/), so by default the API
// is resolved relative to the page's own directory instead of the site root.
export function apiBase() {
  const configured = window.AVALON && window.AVALON.apiBase;
  if (configured) return configured.replace(/\/$/, '');
  return new URL('.', location.href).href.replace(/\/$/, '');
}

export async function createRoom() {
  const res = await fetch(`${apiBase()}/api/rooms`, { method: 'POST' });
  if (!res.ok) throw new Error('create_failed');
  return (await res.json()).code;
}

export class Conn {
  // handlers: onView(view), onStatus(status), onFatal(code)
  constructor(code, name, handlers) {
    this.code = code;
    this.name = name;
    this.h = handlers;
    this.creds = loadCreds(code) || {};
    this.ws = null;
    this.retry = 0;
    this.fatal = false;
    this.stopped = false;
    this.lastMsg = 0;
    this.view = null;
    this.outbox = [];
    this.ready = false;

    this.onVis = () => (document.hidden ? this.goAway() : this.resume());
    this.onWake = () => this.resume();
    document.addEventListener('visibilitychange', this.onVis);
    window.addEventListener('pageshow', this.onWake);
    window.addEventListener('online', this.onWake);
    window.addEventListener('focus', this.onWake);
    this.hbTimer = setInterval(() => this.heartbeat(), HB_MS);
  }

  url() {
    return `${apiBase().replace(/^http/, 'ws')}/ws/${this.code}`;
  }

  open() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.ready = false;
    this.h.onStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url());
    } catch {
      return this.scheduleRetry();
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.lastMsg = Date.now();
      ws.send(JSON.stringify({ t: 'join', name: this.name, pid: this.creds.pid, token: this.creds.token }));
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.lastMsg = Date.now();
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === 'welcome') {
        this.creds = { pid: m.pid, token: m.token };
        saveCreds(this.code, this.creds);
        this.retry = 0;
        this.ready = true;
        this.h.onStatus('online');
        this.flush();
      } else if (m.t === 'state') {
        if (!this.view || m.view.ver >= this.view.ver || m.view.me !== this.view.me) {
          this.view = m.view;
          this.h.onView(m.view);
        }
      } else if (m.t === 'error') {
        this.onError(m.e);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ready = false;
      if (this.stopped || this.fatal) return;
      this.h.onStatus('offline');
      this.scheduleRetry();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  onError(e) {
    const fatal = ['no_room', 'bad_token', 'game_started', 'room_full', 'kicked', 'left', 'replaced'];
    if (fatal.includes(e)) {
      this.fatal = true;
      this.h.onFatal(e);
    } else {
      this.h.onError?.(e);
    }
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    const delay = Math.min(4000, 250 * 2 ** this.retry++) * (0.7 + Math.random() * 0.6);
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  reconnectNow() {
    this.fatal = false;
    this.retry = 0;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.open();
  }

  sendRaw(obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  goAway() {
    this.sendRaw({ t: 'away' });
  }

  // Page visible again / network back / bfcache restore.
  resume() {
    if (this.stopped || this.fatal || document.hidden) return;
    if (this.ws && this.ws.readyState === 1) {
      // Looks open, but phones leave half-dead sockets behind. Ask for a snapshot and
      // give the server a moment to answer; if it does not, rebuild the connection.
      const asked = Date.now();
      this.sendRaw({ t: 'sync' });
      clearTimeout(this.probeTimer);
      this.probeTimer = setTimeout(() => {
        if (this.lastMsg < asked && !this.stopped) this.reconnectNow();
      }, 2500);
    } else if (!this.ws || this.ws.readyState > 1) {
      this.reconnectNow();
    }
  }

  heartbeat() {
    if (this.stopped || this.fatal || document.hidden) return;
    if (this.ws && this.ws.readyState === 1) {
      if (Date.now() - this.lastMsg > DEAD_MS) return this.reconnectNow();
      this.sendRaw({ t: 'hb' });
    } else if (!this.ws || this.ws.readyState > 1) {
      this.open();
    }
  }

  // Actions carry the phase counter they were issued in; the server drops stale ones.
  act(a) {
    const g = this.view?.game;
    if (g && a.seq === undefined && !['config', 'shuffle', 'kick', 'rename', 'start', 'leave', 'restart', 'abort', 'claimHost', 'force'].includes(a.type)) {
      a = { ...a, seq: g.seq };
    }
    if (this.ready && this.sendRaw({ t: 'act', a })) return true;
    this.outbox = this.outbox.filter((o) => o.type !== a.type || o.id !== a.id).slice(-6);
    this.outbox.push(a);
    return false;
  }

  flush() {
    const q = this.outbox;
    this.outbox = [];
    for (const a of q) this.sendRaw({ t: 'act', a });
  }

  close() {
    this.stopped = true;
    clearInterval(this.hbTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.probeTimer);
    document.removeEventListener('visibilitychange', this.onVis);
    window.removeEventListener('pageshow', this.onWake);
    window.removeEventListener('online', this.onWake);
    window.removeEventListener('focus', this.onWake);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

// Keep the screen on while playing: the root cause of most "phone fell asleep" drop-outs.
export class WakeKeeper {
  constructor(onChange) {
    this.lock = null;
    this.on = false;
    this.onChange = onChange || (() => {});
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.on) this.acquire();
    });
  }

  get supported() {
    return 'wakeLock' in navigator;
  }

  async acquire() {
    this.on = true;
    if (!this.supported) return this.onChange(false);
    try {
      this.lock = await navigator.wakeLock.request('screen');
      this.lock.addEventListener('release', () => this.onChange(false));
      this.onChange(true);
    } catch {
      this.onChange(false);
    }
  }

  async release() {
    this.on = false;
    try {
      await this.lock?.release();
    } catch {
      /* ignore */
    }
    this.onChange(false);
  }
}
