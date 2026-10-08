import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  EVIL_COUNT,
  QUEST_SIZES,
  act,
  assassinId,
  buildRoleList,
  createGame,
  failsNeeded,
  forceAdvance,
  knowledge,
  merlinId,
  pending,
  questSize,
  teamOf,
  tick,
} from '../shared/game.js';
import { viewFor } from '../shared/view.js';

// Small deterministic PRNG so failures are reproducible.
function mulberry(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ids = (n) => Array.from({ length: n }, (_, i) => `p${i}`);
const present = (rng = mulberry(1)) => ({ awayMs: {}, rng });
let clock = 1_000_000;
const T = () => (clock += 1000);

function setup(n, cfg = {}, seed = 7) {
  const rng = mulberry(seed);
  const { game, error } = createGame(ids(n), { ...DEFAULT_CONFIG, ...cfg }, rng, T());
  assert.equal(error, undefined);
  return { g: game, ctx: present(rng) };
}

function startPlay(g, ctx) {
  for (const id of g.order) act(g, id, { type: 'ack' }, ctx, T());
  assert.equal(g.phase, 'propose');
}

// Leader proposes `team`, everybody votes `approve`.
function propose(g, ctx, team, approve = true) {
  for (const id of team) assert.ok(act(g, g.leader, { type: 'select', id }, ctx, T()).ok);
  assert.ok(act(g, g.leader, { type: 'propose' }, ctx, T()).ok);
  assert.equal(g.phase, 'vote');
  for (const id of g.order) act(g, id, { type: 'vote', v: approve }, ctx, T());
}

function ackAll(g, ctx) {
  for (const id of g.order) act(g, id, { type: 'ack' }, ctx, T());
}

function playQuest(g, ctx, failers = []) {
  assert.equal(g.phase, 'quest');
  for (const id of g.team) act(g, id, { type: 'card', v: failers.includes(id) ? 'fail' : 'success' }, ctx, T());
}

const goodIds = (g) => g.order.filter((id) => teamOf(g.roles[id]) === 'good');
const evilIds = (g) => g.order.filter((id) => teamOf(g.roles[id]) === 'evil');

test('role lists have the right split for every player count', () => {
  for (let n = 5; n <= 10; n++) {
    const { roles } = buildRoleList(n, DEFAULT_CONFIG);
    assert.equal(roles.length, n);
    assert.equal(roles.filter((r) => teamOf(r) === 'evil').length, EVIL_COUNT[n]);
    assert.ok(roles.includes('merlin') && roles.includes('assassin'));
  }
});

test('invalid role combinations are rejected', () => {
  const cfg = { ...DEFAULT_CONFIG, mordred: true, oberon: true }; // assassin+morgana+mordred+oberon = 4 evil
  assert.equal(buildRoleList(5, cfg).error, 'too_many_evil_roles');
  assert.equal(buildRoleList(4, DEFAULT_CONFIG).error, 'player_count');
  assert.ok(buildRoleList(10, cfg).roles);
});

test('night knowledge follows the official rules', () => {
  const roles = {
    a: 'merlin', b: 'percival', c: 'servant', d: 'assassin', e: 'morgana', f: 'mordred', g: 'oberon',
  };
  const marks = (id) => Object.fromEntries(knowledge(roles, id).map((k) => [k.id, k.mark]));
  assert.deepEqual(marks('a'), { d: 'evil', e: 'evil', g: 'evil' }); // not Mordred
  assert.deepEqual(marks('b'), { a: 'wizard', e: 'wizard' });
  assert.deepEqual(marks('c'), {});
  assert.deepEqual(marks('d'), { e: 'evil', f: 'evil' }); // not Oberon
  assert.deepEqual(marks('g'), {});
  // Percival without Morgana sees Merlin outright.
  assert.deepEqual(
    Object.fromEntries(knowledge({ a: 'merlin', b: 'percival', c: 'assassin' }, 'b').map((k) => [k.id, k.mark])),
    { a: 'merlin' },
  );
});

test('quest sizes and the 7+ player double-fail rule', () => {
  assert.deepEqual(QUEST_SIZES[5], [2, 3, 2, 3, 3]);
  assert.equal(failsNeeded(7, 3), 2);
  assert.equal(failsNeeded(6, 3), 1);
  assert.equal(failsNeeded(10, 2), 1);
});

test('good wins three quests, then the assassin misses Merlin', () => {
  const { g, ctx } = setup(5);
  startPlay(g, ctx);
  for (let q = 0; q < 3; q++) {
    propose(g, ctx, goodIds(g).slice(0, questSize(g)));
    assert.equal(g.phase, 'voteResult');
    ackAll(g, ctx);
    playQuest(g, ctx);
    assert.equal(g.phase, 'questResult');
    ackAll(g, ctx);
  }
  assert.equal(g.phase, 'assassin');
  const wrong = goodIds(g).find((id) => id !== merlinId(g));
  assert.ok(act(g, assassinId(g), { type: 'assassinate', id: wrong }, ctx, T()).ok);
  assert.equal(g.winner, 'good');
  assert.equal(g.reason, 'merlin_survived');
});

test('assassin hitting Merlin flips the win to evil', () => {
  const { g, ctx } = setup(6);
  startPlay(g, ctx);
  for (let q = 0; q < 3; q++) {
    propose(g, ctx, goodIds(g).slice(0, questSize(g)));
    ackAll(g, ctx);
    playQuest(g, ctx);
    ackAll(g, ctx);
  }
  assert.equal(g.phase, 'assassin');
  // Only the assassin may act while present.
  const other = evilIds(g).find((id) => id !== assassinId(g));
  assert.equal(act(g, other, { type: 'assassinate', id: merlinId(g) }, ctx, T()).error, 'not_assassin');
  act(g, assassinId(g), { type: 'assassinate', id: merlinId(g) }, ctx, T());
  assert.equal(g.winner, 'evil');
  assert.equal(g.reason, 'merlin_killed');
});

test('three failed quests end the game for evil', () => {
  const { g, ctx } = setup(5);
  startPlay(g, ctx);
  for (let q = 0; q < 3; q++) {
    const evil = evilIds(g)[0];
    const team = [evil, ...goodIds(g)].slice(0, questSize(g));
    propose(g, ctx, team);
    ackAll(g, ctx);
    playQuest(g, ctx, [evil]);
    ackAll(g, ctx);
  }
  assert.equal(g.phase, 'over');
  assert.equal(g.winner, 'evil');
  assert.equal(g.reason, 'three_fails');
});

test('five rejected teams in a row ends the game, and rejects reset after a quest', () => {
  const { g, ctx } = setup(5);
  startPlay(g, ctx);
  for (let i = 0; i < 4; i++) {
    propose(g, ctx, g.order.slice(0, questSize(g)), false);
    assert.equal(g.history.at(-1).approved, false);
    ackAll(g, ctx);
    assert.equal(g.phase, 'propose');
    assert.equal(g.rejects, i + 1);
  }
  // Approve on the 5th: rejects reset once the quest is carried out.
  propose(g, ctx, goodIds(g).slice(0, 2));
  ackAll(g, ctx);
  playQuest(g, ctx);
  assert.equal(g.rejects, 0);
  ackAll(g, ctx);
  for (let i = 0; i < 5; i++) {
    propose(g, ctx, g.order.slice(0, questSize(g)), false);
    ackAll(g, ctx);
  }
  assert.equal(g.winner, 'evil');
  assert.equal(g.reason, 'five_rejects');
});

test('a tied vote rejects the team', () => {
  const { g, ctx } = setup(6);
  startPlay(g, ctx);
  for (const id of g.order.slice(0, questSize(g))) act(g, g.leader, { type: 'select', id }, ctx, T());
  act(g, g.leader, { type: 'propose' }, ctx, T());
  g.order.forEach((id, i) => act(g, id, { type: 'vote', v: i < 3 }, ctx, T()));
  assert.equal(g.history.at(-1).approved, false);
});

test('4th quest needs two fails with 7+ players', () => {
  const { g, ctx } = setup(7, { mordred: false });
  startPlay(g, ctx);
  g.quest = 3; // jump to quest 4 for the test
  g.results = ['success', 'fail', 'success', null, null];
  const [e1, e2] = evilIds(g);
  propose(g, ctx, [e1, e2, ...goodIds(g)].slice(0, questSize(g)));
  ackAll(g, ctx);
  playQuest(g, ctx, [e1]);
  assert.equal(g.outcome.success, true, 'one fail is not enough');
  assert.equal(g.outcome.fails, 1);
});

test('rule enforcement: good must succeed, only leader selects, stale actions bounce', () => {
  const { g, ctx } = setup(5);
  startPlay(g, ctx);
  const notLeader = g.order.find((id) => id !== g.leader);
  assert.equal(act(g, notLeader, { type: 'select', id: g.order[0] }, ctx, T()).error, 'not_leader');
  const team = goodIds(g).slice(0, questSize(g));
  propose(g, ctx, team);
  ackAll(g, ctx);
  assert.equal(act(g, team[0], { type: 'card', v: 'fail' }, ctx, T()).error, 'good_must_succeed');
  const outsider = g.order.find((id) => !g.team.includes(id));
  assert.equal(act(g, outsider, { type: 'card', v: 'success' }, ctx, T()).error, 'not_on_team');
  assert.equal(act(g, team[0], { type: 'card', v: 'success', seq: g.seq - 1 }, ctx, T()).error, 'stale');
});

test('a player can change their vote until the last vote lands', () => {
  const { g, ctx } = setup(5);
  startPlay(g, ctx);
  for (const id of g.order.slice(0, 2)) act(g, g.leader, { type: 'select', id }, ctx, T());
  act(g, g.leader, { type: 'propose' }, ctx, T());
  act(g, 'p0', { type: 'vote', v: false }, ctx, T());
  act(g, 'p0', { type: 'vote', v: true }, ctx, T());
  assert.equal(g.votes.p0, true);
});

test('offline players never stall the table: autoplay fills in after the delay', () => {
  const { g, ctx } = setup(5, { autoDelay: 20 });
  startPlay(g, ctx);
  const t0 = g.phaseAt;
  const gone = g.order.find((id) => id !== g.leader);
  // Leader picks a team, everyone but `gone` votes.
  for (const id of g.order.slice(0, 2)) act(g, g.leader, { type: 'select', id }, ctx, t0 + 1);
  act(g, g.leader, { type: 'propose' }, ctx, t0 + 2);
  for (const id of g.order) if (id !== gone) act(g, id, { type: 'vote', v: true }, ctx, t0 + 3);
  assert.equal(g.phase, 'vote');
  // Away, but not for long enough yet.
  tick(g, { ...ctx, awayMs: { [gone]: 5000 } }, g.phaseAt + 6000);
  assert.equal(g.phase, 'vote');
  // Away for the whole delay -> default vote, game moves on.
  tick(g, { ...ctx, awayMs: { [gone]: 25000 } }, g.phaseAt + 25000);
  assert.equal(g.phase, 'voteResult');
  assert.ok(g.feed.some((f) => f.k === 'auto' && f.id === gone && f.what === 'vote'));
});

test('autoplay can be switched off', () => {
  const { g, ctx } = setup(5, { autoplay: false, autoDelay: 15 });
  startPlay(g, ctx);
  tick(g, { ...ctx, awayMs: { [g.leader]: 600000 } }, g.phaseAt + 600000);
  assert.equal(g.phase, 'propose');
});

test('an offline leader gets a default team after the delay', () => {
  const { g, ctx } = setup(5, { autoDelay: 15 });
  startPlay(g, ctx);
  tick(g, { ...ctx, awayMs: { [g.leader]: 20000 } }, g.phaseAt + 20000);
  assert.equal(g.phase, 'vote');
  assert.equal(g.team.length, 2);
  assert.ok(g.team.includes(g.history.at(-1)?.leader ?? g.leader));
});

test('result screens do not wait for offline players, but do wait for present ones', () => {
  const { g, ctx } = setup(5);
  startPlay(g, ctx);
  propose(g, ctx, goodIds(g).slice(0, 2));
  assert.equal(g.phase, 'voteResult');
  const away = 'p4';
  for (const id of g.order.filter((x) => x !== away && x !== 'p3')) act(g, id, { type: 'ack' }, ctx, T());
  assert.equal(g.phase, 'voteResult', 'p3 is present and has not acked');
  act(g, 'p3', { type: 'ack' }, ctx, T());
  assert.equal(g.phase, 'voteResult', 'p4 is present and has not acked yet');
  tick(g, { ...ctx, awayMs: { [away]: 5000 } }, T());
  assert.equal(g.phase, 'quest');
});

test('result screens time out on their own', () => {
  const { g, ctx } = setup(5);
  startPlay(g, ctx);
  propose(g, ctx, goodIds(g).slice(0, 2));
  tick(g, ctx, g.deadline + 1);
  assert.equal(g.phase, 'quest');
});

test('host can force past a result screen', () => {
  const { g, ctx } = setup(5);
  startPlay(g, ctx);
  propose(g, ctx, goodIds(g).slice(0, 2));
  assert.ok(forceAdvance(g, ctx, T()).ok);
  assert.equal(g.phase, 'quest');
});

test('another evil player can finish for an absent assassin', () => {
  const { g, ctx } = setup(5);
  startPlay(g, ctx);
  g.phase = 'assassin';
  const killer = assassinId(g);
  const mate = evilIds(g).find((id) => id !== killer);
  const awayCtx = { ...ctx, awayMs: { [killer]: 60000 } };
  assert.ok(act(g, mate, { type: 'assassinate', id: merlinId(g) }, awayCtx, T()).ok);
  assert.equal(g.winner, 'evil');
});

test('Lady of the Lake: used after quests 2-4, no repeats, result is private', () => {
  const { g, ctx } = setup(7, { lady: true });
  startPlay(g, ctx);
  const startHolder = g.lady.holder;
  // Quests 1 and 2 (index 0, 1)
  for (let q = 0; q < 2; q++) {
    propose(g, ctx, goodIds(g).slice(0, questSize(g)));
    ackAll(g, ctx);
    playQuest(g, ctx);
    ackAll(g, ctx);
    if (q === 0) assert.equal(g.phase, 'propose', 'no lady after quest 1');
  }
  assert.equal(g.phase, 'lady');
  assert.equal(g.lady.holder, startHolder);
  assert.equal(act(g, startHolder, { type: 'lady', id: startHolder }, ctx, T()).error, 'bad_target');
  const target = evilIds(g)[0];
  assert.ok(act(g, startHolder, { type: 'lady', id: target }, ctx, T()).ok);
  assert.equal(g.phase, 'ladyResult');
  assert.equal(g.lady.holder, target);
  assert.equal(g.lady.peek.result, 'evil');

  const s = { game: g, players: g.order.map((id, i) => ({ id, name: id, avatar: i })), config: g.cfg, ver: 1, code: 'ABCD' };
  assert.equal(viewFor(s, startHolder, T()).game.ladyPeek.result, 'evil');
  const bystander = g.order.find((id) => id !== startHolder);
  assert.equal(viewFor(s, bystander, T()).game.ladyPeek, undefined);
  ackAll(g, ctx);
  assert.equal(g.phase, 'propose');
  assert.equal(g.quest, 2);
});

test('views never leak other players\' roles, hidden votes or quest cards', () => {
  const { g, ctx } = setup(7, { oberon: true, mordred: true, morgana: false });
  const s = { game: g, players: g.order.map((id, i) => ({ id, name: id, avatar: i })), config: g.cfg, ver: 1, code: 'ABCD' };
  startPlay(g, ctx);
  const servant = g.order.find((id) => g.roles[id] === 'servant');
  const v0 = viewFor(s, servant, T());
  assert.equal(v0.game.me.role, 'servant');
  assert.deepEqual(v0.game.me.knows, []);
  assert.equal(v0.game.roles, undefined);
  assert.ok(!JSON.stringify(v0).includes('"merlin"') || v0.game.me.role === 'merlin');

  // Mid-vote: only who has voted is visible, plus one's own vote.
  const team = goodIds(g).slice(0, questSize(g));
  for (const id of team) act(g, g.leader, { type: 'select', id }, ctx, T());
  act(g, g.leader, { type: 'propose' }, ctx, T());
  act(g, 'p0', { type: 'vote', v: false }, ctx, T());
  act(g, 'p1', { type: 'vote', v: true }, ctx, T());
  const v1 = viewFor(s, 'p1', T());
  assert.equal(v1.game.votes, undefined);
  assert.deepEqual(v1.game.voted.sort(), ['p0', 'p1']);
  assert.equal(v1.game.myVote, true);

  // Quest: nobody sees who played what.
  for (const id of g.order) act(g, id, { type: 'vote', v: true }, ctx, T());
  ackAll(g, ctx);
  act(g, team[0], { type: 'card', v: 'success' }, ctx, T());
  const v2 = viewFor(s, team[1], T());
  assert.deepEqual(v2.game.submitted, [team[0]]);
  assert.equal(v2.game.cards, undefined);
  assert.equal(v2.game.myCard, undefined);
});

test('roles are revealed to everyone only when the game is over', () => {
  const { g, ctx } = setup(5);
  startPlay(g, ctx);
  for (let q = 0; q < 3; q++) {
    propose(g, ctx, goodIds(g).slice(0, questSize(g)));
    ackAll(g, ctx);
    playQuest(g, ctx);
    ackAll(g, ctx);
  }
  act(g, assassinId(g), { type: 'assassinate', id: goodIds(g).find((i) => g.roles[i] !== 'merlin') }, ctx, T());
  const s = { game: g, players: g.order.map((id, i) => ({ id, name: id, avatar: i })), config: g.cfg, ver: 1, code: 'ABCD' };
  assert.deepEqual(viewFor(s, 'p0', T()).game.roles, g.roles);
});

test('pending() reports who the table is waiting on', () => {
  const { g, ctx } = setup(5);
  assert.equal(pending(g).length, 5);
  startPlay(g, ctx);
  assert.deepEqual(pending(g), [g.leader]);
});
