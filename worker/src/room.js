// One Durable Object per game room. It is the single source of truth:
//  * game state lives in durable storage, so a room survives eviction/redeploys;
//  * sockets use the Hibernation API, so an idle room costs nothing;
//  * a player is identified by (id, token) kept in the browser, so a phone that
//    slept can reconnect to the exact same seat in one round trip;
//  * offline players never block the table (see shared/game.js autoplay).

import { DurableObject } from 'cloudflare:workers';
import {
  DEFAULT_CONFIG,
  MAX_PLAYERS,
  act,
  createGame,
  forceAdvance,
  sanitizeConfig,
  shuffle,
  tick,
} from '../../shared/game.js';
import { lobbyCheck, viewFor } from '../../shared/view.js';

const HEARTBEAT_STALE_MS = 30_000; // no heartbeat for this long => treat as away
const TICK_MS = 10_000;
const EXPIRE_MS = 24 * 3600_000; // abandoned rooms are wiped after a day
const HOST_CLAIM_MS = 60_000; // an away host can be replaced after this long
const MAX_MSG = 4096;

const LOBBY_ACTIONS = new Set(['config', 'shuffle', 'kick', 'rename', 'start', 'leave']);

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.s = null;
    this.lastSeen = new Map(); // pid -> ms. In memory only; reset (with grace) after hibernation.
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get('s')) ?? null;
      const now = Date.now();
      for (const ws of ctx.getWebSockets()) {
        const a = ws.deserializeAttachment();
        if (a?.pid) this.lastSeen.set(a.pid, now);
      }
    });
  }

  // ---------------------------------------------------------------- HTTP / WS entry
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/init' && request.method === 'POST') {
      if (this.s) return new Response('exists', { status: 409 });
      const now = Date.now();
      this.s = {
        code: url.searchParams.get('code') || '????',
        ver: 1,
        createdAt: now,
        activityAt: now,
        hostId: null,
        players: [],
        config: { ...DEFAULT_CONFIG },
        game: null,
      };
      await this.save();
      await this.ctx.storage.setAlarm(now + EXPIRE_MS);
      return new Response('ok');
    }

    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    if (!this.s) {
      server.send(JSON.stringify({ t: 'error', e: 'no_room' }));
      server.close(4404, 'no_room');
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------------------------------------------------------------- socket events
  async webSocketMessage(ws, raw) {
    if (!this.s || typeof raw !== 'string' || raw.length > MAX_MSG) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const now = Date.now();
    const a = ws.deserializeAttachment();

    if (msg.t === 'join') return this.onJoin(ws, msg, now);
    if (!a?.pid) return this.reply(ws, { t: 'error', e: 'not_joined' });
    const pid = a.pid;
    const player = this.player(pid);
    if (!player) return this.reply(ws, { t: 'error', e: 'kicked' });
    this.lastSeen.set(pid, now);

    switch (msg.t) {
      case 'hb': {
        // Heartbeats keep presence fresh; they only cost a write when presence flips.
        if (player.awaySince != null) {
          player.awaySince = null;
          await this.commit(now);
        }
        return this.reply(ws, { t: 'pong', now });
      }
      case 'away': {
        // Page hidden / screen locked: tell everyone right away instead of waiting for a timeout.
        if (player.awaySince == null) {
          player.awaySince = now;
          await this.commit(now);
        }
        return;
      }
      case 'sync': {
        // Coming back: always answer with a full snapshot, the client may have missed anything.
        if (player.awaySince != null) {
          player.awaySince = null;
          return this.commit(now);
        }
        return this.reply(ws, { t: 'state', view: viewFor(this.s, pid, now) });
      }
      case 'act':
        return this.onAct(ws, pid, msg, now);
      default:
    }
  }

  async webSocketClose(ws, code) {
    await this.onSocketGone(ws);
  }

  async webSocketError(ws) {
    await this.onSocketGone(ws);
  }

  async onSocketGone(ws) {
    if (!this.s) return;
    const a = ws.deserializeAttachment();
    try {
      ws.close();
    } catch {
      /* already closed */
    }
    if (!a?.pid) return;
    const still = this.ctx.getWebSockets().some((o) => o !== ws && o.readyState === 1 && o.deserializeAttachment()?.pid === a.pid);
    const p = this.player(a.pid);
    if (p && !still && p.awaySince == null) {
      p.awaySince = Date.now();
      await this.commit(Date.now());
    }
  }

  // ---------------------------------------------------------------- join
  async onJoin(ws, msg, now) {
    const s = this.s;
    let p = typeof msg.pid === 'string' ? this.player(msg.pid) : null;
    if (p) {
      if (p.token !== msg.token) return this.fail(ws, 'bad_token', true);
    } else {
      if (s.game) return this.fail(ws, 'game_started', true);
      if (s.players.length >= MAX_PLAYERS) return this.fail(ws, 'room_full', true);
      p = {
        id: crypto.randomUUID().slice(0, 8),
        token: crypto.randomUUID(),
        name: this.uniqueName(msg.name),
        avatar: this.freeAvatar(),
        awaySince: null,
      };
      s.players.push(p);
      if (!s.hostId) s.hostId = p.id;
    }
    // A newer socket for the same player replaces the old one (e.g. second tab).
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws && other.deserializeAttachment()?.pid === p.id) {
        try {
          other.send(JSON.stringify({ t: 'error', e: 'replaced' }));
          other.close(4001, 'replaced');
        } catch {
          /* ignore */
        }
      }
    }
    ws.serializeAttachment({ pid: p.id });
    this.lastSeen.set(p.id, now);
    p.awaySince = null;
    this.reply(ws, { t: 'welcome', pid: p.id, token: p.token, code: s.code });
    await this.commit(now);
  }

  uniqueName(raw) {
    let base = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 16);
    if (!base) base = `بازیکن ${this.s.players.length + 1}`;
    let name = base;
    for (let i = 2; this.s.players.some((p) => p.name === name); i++) name = `${base} ${i}`;
    return name;
  }

  freeAvatar() {
    const used = new Set(this.s.players.map((p) => p.avatar));
    for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
    return 0;
  }

  // ---------------------------------------------------------------- actions
  async onAct(ws, pid, msg, now) {
    const s = this.s;
    const type = msg.a?.type ?? msg.a;
    const body = typeof msg.a === 'object' ? msg.a : { type };

    // Lobby / room management ----------------------------------------------
    if (LOBBY_ACTIONS.has(type) || type === 'restart' || type === 'abort' || type === 'claimHost' || type === 'force') {
      return this.onRoomAction(ws, pid, type, body, now);
    }

    // Game actions (optionally on behalf of an absent player) ---------------
    if (!s.game) return this.fail(ws, 'no_game');
    let actor = pid;
    if (body.for && body.for !== pid) {
      const target = this.player(body.for);
      if (pid !== s.hostId) return this.fail(ws, 'not_host');
      if (!target || target.awaySince == null) return this.fail(ws, 'target_present');
      if (type === 'assassinate') return this.fail(ws, 'no_proxy_assassin');
      actor = target.id;
    }
    const res = act(s.game, actor, body, this.gameCtx(now), now);
    if (!res.ok) {
      this.fail(ws, res.error);
      // On a stale action, hand the client the truth right away.
      return this.reply(ws, { t: 'state', view: viewFor(s, pid, now) });
    }
    await this.commit(now);
  }

  async onRoomAction(ws, pid, type, body, now) {
    const s = this.s;
    const isHost = pid === s.hostId;
    switch (type) {
      case 'config': {
        if (!isHost || s.game) return this.fail(ws, 'not_allowed');
        s.config = sanitizeConfig(body.config, s.config);
        break;
      }
      case 'shuffle': {
        if (!isHost || s.game) return this.fail(ws, 'not_allowed');
        s.players = shuffle(s.players, Math.random);
        break;
      }
      case 'rename': {
        const p = this.player(pid);
        if (s.game) return this.fail(ws, 'not_allowed');
        const others = s.players.filter((o) => o !== p);
        let name = String(body.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 16) || p.name;
        for (let i = 2; others.some((o) => o.name === name); i++) name = `${name.replace(/ \d+$/, '')} ${i}`;
        p.name = name;
        break;
      }
      case 'kick': {
        if (!isHost || s.game) return this.fail(ws, 'not_allowed');
        if (body.id === pid) return this.fail(ws, 'not_allowed');
        this.removePlayer(body.id, 4003);
        break;
      }
      case 'leave': {
        if (s.game) return this.fail(ws, 'not_allowed');
        this.removePlayer(pid, 4002);
        break;
      }
      case 'start': {
        if (!isHost || s.game) return this.fail(ws, 'not_allowed');
        const check = lobbyCheck(s);
        if (!check.ok) return this.fail(ws, check.error);
        const { game, error } = createGame(
          s.players.map((p) => p.id),
          s.config,
          Math.random,
          now,
        );
        if (error) return this.fail(ws, error);
        s.game = game;
        break;
      }
      case 'restart': {
        if (!isHost || s.game?.phase !== 'over') return this.fail(ws, 'not_allowed');
        s.game = null;
        break;
      }
      case 'abort': {
        if (!isHost || !s.game) return this.fail(ws, 'not_allowed');
        s.game = null;
        break;
      }
      case 'claimHost': {
        const host = this.player(s.hostId);
        if (host && host.awaySince != null && now - host.awaySince >= HOST_CLAIM_MS) s.hostId = pid;
        else return this.fail(ws, 'not_allowed');
        break;
      }
      case 'force': {
        if (!isHost || !s.game) return this.fail(ws, 'not_allowed');
        const res = forceAdvance(s.game, this.gameCtx(now), now);
        if (!res.ok) return this.fail(ws, res.error);
        break;
      }
      default:
        return;
    }
    await this.commit(now);
  }

  removePlayer(id, closeCode) {
    const s = this.s;
    s.players = s.players.filter((p) => p.id !== id);
    this.lastSeen.delete(id);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.deserializeAttachment()?.pid === id) {
        try {
          ws.send(JSON.stringify({ t: 'error', e: closeCode === 4003 ? 'kicked' : 'left' }));
          ws.close(closeCode, 'removed');
        } catch {
          /* ignore */
        }
      }
    }
    if (s.hostId === id) s.hostId = s.players[0]?.id ?? null;
  }

  // ---------------------------------------------------------------- core plumbing
  player(id) {
    return this.s?.players.find((p) => p.id === id) ?? null;
  }

  // How long each offline player has been gone. If *nobody* is present we freeze
  // instead of letting autoplay run an empty table.
  gameCtx(now) {
    const awayMs = {};
    let anyPresent = false;
    for (const p of this.s.players) {
      if (p.awaySince == null) anyPresent = true;
      else awayMs[p.id] = Math.max(1, now - p.awaySince);
    }
    return { awayMs: anyPresent ? awayMs : {}, rng: Math.random };
  }

  async commit(now) {
    const s = this.s;
    if (s.game) tick(s.game, this.gameCtx(now), now);
    s.ver += 1;
    s.activityAt = now;
    await this.save();
    this.broadcast(now);
    await this.scheduleAlarm(now);
  }

  async save() {
    await this.ctx.storage.put('s', this.s);
  }

  broadcast(now) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a?.pid || !this.player(a.pid)) continue;
      this.reply(ws, { t: 'state', view: viewFor(this.s, a.pid, now) });
    }
  }

  reply(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* socket already gone */
    }
  }

  fail(ws, e, closeAfter = false) {
    this.reply(ws, { t: 'error', e });
    if (closeAfter) {
      try {
        ws.close(4000, e);
      } catch {
        /* ignore */
      }
    }
  }

  hasOpenSockets() {
    return this.ctx.getWebSockets().some((ws) => ws.readyState === 1);
  }

  async scheduleAlarm(now) {
    const next = this.hasOpenSockets() ? now + TICK_MS : this.s.activityAt + EXPIRE_MS;
    await this.ctx.storage.setAlarm(next);
  }

  // Alarm: detect dead phones (no heartbeat), run autoplay/timeouts, expire abandoned rooms.
  async alarm() {
    if (!this.s) return;
    const now = Date.now();
    if (!this.hasOpenSockets() && now - this.s.activityAt >= EXPIRE_MS) {
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1001, 'expired');
        } catch {
          /* ignore */
        }
      }
      await this.ctx.storage.deleteAll();
      this.s = null;
      return;
    }

    let changed = false;
    for (const p of this.s.players) {
      const seen = this.lastSeen.get(p.id) ?? 0;
      if (p.awaySince == null && now - seen > HEARTBEAT_STALE_MS) {
        p.awaySince = seen || now;
        changed = true;
      }
    }
    if (this.s.game && this.s.game.phase !== 'over' && this.tickGame(now)) changed = true;
    if (changed) await this.commit(now);
    else await this.scheduleAlarm(now);
  }

  tickGame(now) {
    return tick(this.s.game, this.gameCtx(now), now);
  }
}
