// End-to-end check against a running Worker (npm run dev:worker).
//   node scripts/e2e-worker.mjs [http://127.0.0.1:8788]
// Plays a full 5-player game over real WebSockets, including a phone that goes
// to sleep mid-game (hard socket drop) and one that stays away long enough for autoplay.
import assert from 'node:assert/strict';

const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const WS = BASE.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(code, name) {
    Object.assign(this, { code, name, view: null, pid: null, token: null, errors: [] });
  }
  async connect() {
    this.ws = new WebSocket(`${WS}/ws/${this.code}`);
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'welcome') Object.assign(this, { pid: m.pid, token: m.token });
      if (m.t === 'state' && (!this.view || m.view.ver >= this.view.ver)) this.view = m.view;
      if (m.t === 'error') this.errors.push(m.e);
    };
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.send(JSON.stringify({ t: 'join', name: this.name, pid: this.pid, token: this.token }));
    await this.until(() => this.view && this.pid);
    return this;
  }
  send(a) {
    this.ws.send(JSON.stringify({ t: 'act', a }));
  }
  drop() {
    this.ws.close();
  }
  async until(fn, ms = 4000, label = 'condition') {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn(this.view)) return this.view;
      await sleep(15);
    }
    throw new Error(`timeout waiting for ${label}; phase=${this.view?.phase} errors=${this.errors}`);
  }
}

const post = async () => (await fetch(`${BASE}/api/rooms`, { method: 'POST' })).json();
const { code } = await post();
assert.match(code, /^[A-Z]{4}$/);
console.log('room', code);

const cs = [];
for (const n of ['Ali', 'Sara', 'Reza', 'Mina', 'Omid']) cs.push(await new Client(code, n).connect());
const [host, , , , sleeper] = cs;
await host.until((v) => v.players.length === 5, 3000, '5 players');
assert.equal(host.view.host, host.pid);
assert.deepEqual(host.view.players.map((p) => p.seat), [0, 1, 2, 3, 4]);

// Non-host cannot start; a 6th player cannot join a started game.
cs[1].send({ type: 'start' });
await cs[1].until(() => cs[1].errors.includes('not_allowed'), 2000, 'not_allowed');

host.send({ type: 'config', config: { autoDelay: 15 } });
host.send({ type: 'start' });
await Promise.all(cs.map((c) => c.until((v) => v.phase === 'reveal', 3000, 'reveal')));
const seats = host.view.players.map((p) => p.id);

// Roles are private.
const roles = cs.map((c) => c.view.game.me.role);
assert.equal(roles.filter((r) => r === 'merlin').length, 1);
assert.ok(cs.every((c) => c.view.game.roles === undefined));
console.log('roles', roles.join(','));

const byId = (id) => cs.find((c) => c.pid === id);
const ackAll = () => cs.forEach((c) => c.send({ type: 'ack' }));
ackAll();
await host.until((v) => v.phase === 'propose', 3000, 'propose');

// ---- The phone goes to sleep: the socket drops hard, in the middle of voting.
const leader = byId(host.view.game.leader);
const size = host.view.game.sizes[0];
for (const id of seats.slice(0, size)) leader.send({ type: 'select', id });
leader.send({ type: 'propose' });
await host.until((v) => v.phase === 'vote', 3000, 'vote');
const seatBefore = sleeper.view.players.find((p) => p.id === sleeper.pid).seat;
sleeper.drop();
await host.until((v) => v.players.find((p) => p.id === sleeper.pid).away, 3000, 'sleeper marked away');
for (const c of cs.filter((c) => c !== sleeper)) c.send({ type: 'vote', v: true });
await sleep(200);
assert.equal(host.view.phase, 'vote', 'table waits (briefly) for the sleeper');

// ---- Wakes up: same pid+token => same seat, full snapshot, no re-join dance.
const awake = new Client(code, 'ignored');
Object.assign(awake, { pid: sleeper.pid, token: sleeper.token });
await awake.connect();
assert.equal(awake.pid, sleeper.pid);
assert.equal(awake.view.players.find((p) => p.id === awake.pid).seat, seatBefore);
assert.equal(awake.view.phase, 'vote');
assert.equal(awake.view.game.me.role, sleeper.view.game.me.role, 'same role after reconnect');
cs[4] = awake;
awake.send({ type: 'vote', v: true, seq: awake.view.game.seq });
await host.until((v) => v.phase === 'voteResult', 3000, 'voteResult after reconnect');
assert.equal(host.view.game.history.at(-1).approved, true);
console.log('reconnect ok: game continued with the same seat/role');

// ---- Impostor: wrong token cannot take a seat.
const thief = new Client(code, 'x');
Object.assign(thief, { pid: awake.pid, token: 'nope' });
await assert.rejects(thief.connect());

// ---- A player vanishes for good: autoplay (alarm-driven) keeps the table moving.
ackAll();
await host.until((v) => v.phase === 'quest', 3000, 'quest');
for (const c of cs) if (host.view.game.team.includes(c.pid)) c.send({ type: 'card', v: 'success' });
await host.until((v) => v.phase === 'questResult', 3000, 'questResult');
ackAll();
await host.until((v) => v.phase === 'propose', 3000, 'propose #2');
const leader2 = byId(host.view.game.leader);
const absent = cs.find((c) => c !== leader2 && c !== host);
const size2 = host.view.game.sizes[1];
for (const id of seats.slice(0, size2)) leader2.send({ type: 'select', id });
leader2.send({ type: 'propose' });
await host.until((v) => v.phase === 'vote', 3000, 'vote #2');
absent.drop();
await host.until((v) => v.players.find((p) => p.id === absent.pid).away, 3000, 'away again');
for (const c of cs) if (c !== absent) c.send({ type: 'vote', v: true });
await sleep(300);
assert.equal(host.view.phase, 'vote', 'still waiting for the absent voter');
const t0 = Date.now();
await host.until((v) => v.phase === 'voteResult', 40000, 'autoplay vote for absent player');
console.log(`autoplay voted for the absent player after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
assert.ok(host.view.game.feed.some((f) => f.k === 'auto' && f.id === absent.pid && f.what === 'vote'));

// ---- Host proxy: skip the wait for a player who is known to be away.
ackAll();
await host.until((v) => v.phase === 'quest', 3000, 'quest #2');

for (const c of cs) try { c.drop(); } catch {}
console.log('E2E OK');
process.exit(0);
