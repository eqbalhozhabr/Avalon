// Pure Avalon rules engine. No I/O, no Date.now(), no Math.random(): time and
// randomness are injected so every transition is deterministic under test.
//
// The server (worker/src/room.js) owns one `game` object per room and calls
// act() for player input and tick() to move the game along without waiting on
// players who are offline.

export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 10;

export const QUEST_SIZES = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};
export const EVIL_COUNT = { 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4 };

// With 7+ players the 4th quest needs two fail cards.
export const failsNeeded = (n, questIdx) => (n >= 7 && questIdx === 3 ? 2 : 1);

export const GOOD_ROLES = new Set(['merlin', 'percival', 'servant']);
export const teamOf = (role) => (GOOD_ROLES.has(role) ? 'good' : 'evil');

export const RESULT_SCREEN_MS = 12000; // vote/quest results stay up at most this long
export const LADY_RESULT_MS = 10000;
export const ASSASSIN_TAKEOVER_MS = 15000; // another evil player may finish for an absent assassin

export const DEFAULT_CONFIG = {
  percival: true,
  morgana: true,
  mordred: false,
  oberon: false,
  lady: false,
  autoplay: true, // fill in default moves for players who are offline
  autoDelay: 40, // seconds a player must be offline before autoplay acts for them
};

export function sanitizeConfig(input = {}, prev = DEFAULT_CONFIG) {
  const out = { ...prev };
  for (const k of ['percival', 'morgana', 'mordred', 'oberon', 'lady', 'autoplay']) {
    if (typeof input[k] === 'boolean') out[k] = input[k];
  }
  if (Number.isFinite(input.autoDelay)) {
    out.autoDelay = Math.min(180, Math.max(15, Math.round(input.autoDelay)));
  }
  return out;
}

export function buildRoleList(n, cfg) {
  if (!(n >= MIN_PLAYERS && n <= MAX_PLAYERS)) return { error: 'player_count' };
  const evilN = EVIL_COUNT[n];
  const goodN = n - evilN;
  const evil = ['assassin'];
  if (cfg.morgana) evil.push('morgana');
  if (cfg.mordred) evil.push('mordred');
  if (cfg.oberon) evil.push('oberon');
  if (evil.length > evilN) return { error: 'too_many_evil_roles' };
  const good = ['merlin'];
  if (cfg.percival) good.push('percival');
  if (good.length > goodN) return { error: 'too_many_good_roles' };
  while (evil.length < evilN) evil.push('minion');
  while (good.length < goodN) good.push('servant');
  return { roles: [...good, ...evil] };
}

export function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// What a player learns during the night phase.
export function knowledge(roles, pid) {
  const mine = roles[pid];
  const ids = Object.keys(roles);
  const others = ids.filter((id) => id !== pid);
  const hasMorgana = ids.some((id) => roles[id] === 'morgana');
  const out = [];
  if (mine === 'merlin') {
    for (const id of others) {
      if (teamOf(roles[id]) === 'evil' && roles[id] !== 'mordred') out.push({ id, mark: 'evil' });
    }
  } else if (mine === 'percival') {
    for (const id of others) {
      if (roles[id] === 'merlin') out.push({ id, mark: hasMorgana ? 'wizard' : 'merlin' });
      else if (roles[id] === 'morgana') out.push({ id, mark: 'wizard' });
    }
  } else if (teamOf(mine) === 'evil' && mine !== 'oberon') {
    for (const id of others) {
      if (teamOf(roles[id]) === 'evil' && roles[id] !== 'oberon') out.push({ id, mark: 'evil' });
    }
  }
  return out;
}

export const assassinId = (g) => g.order.find((id) => g.roles[id] === 'assassin');
export const merlinId = (g) => g.order.find((id) => g.roles[id] === 'merlin');
export const questSize = (g) => QUEST_SIZES[g.order.length][g.quest];
const nextAfter = (g, id) => g.order[(g.order.indexOf(id) + 1) % g.order.length];

export function createGame(playerIds, cfg, rng, now) {
  const built = buildRoleList(playerIds.length, cfg);
  if (built.error) return { error: built.error };
  const dealt = shuffle(built.roles, rng);
  const roles = {};
  playerIds.forEach((id, i) => (roles[id] = dealt[i]));
  const n = playerIds.length;
  const leader = playerIds[Math.floor(rng() * n)];
  const g = {
    order: playerIds.slice(), // seating: fixed for the whole session
    roles,
    cfg: { ...cfg },
    phase: 'reveal',
    seq: 1,
    phaseAt: now,
    deadline: null,
    leader,
    startLeader: leader,
    rejects: 0,
    quest: 0,
    results: [null, null, null, null, null],
    team: [],
    votes: {},
    cards: {},
    acks: {},
    outcome: null,
    history: [],
    feed: [],
    lady: {
      enabled: !!cfg.lady,
      holder: playerIds[(playerIds.indexOf(leader) - 1 + n) % n],
      used: [],
      peek: null, // {by, target, result} — only ever sent to `by`
    },
    winner: null,
    reason: null,
  };
  g.lady.used.push(g.lady.holder);
  return { game: g };
}

function go(g, phase, now, deadlineMs = null) {
  g.phase = phase;
  g.seq += 1;
  g.phaseAt = now;
  g.deadline = deadlineMs ? now + deadlineMs : null;
  g.acks = {};
}

const feed = (g, entry) => {
  g.feed.push(entry);
  if (g.feed.length > 60) g.feed.shift();
};

export function pending(g) {
  switch (g.phase) {
    case 'reveal':
    case 'voteResult':
    case 'questResult':
      return g.order.filter((id) => !g.acks[id]);
    case 'propose':
      return [g.leader];
    case 'vote':
      return g.order.filter((id) => !(id in g.votes));
    case 'quest':
      return g.team.filter((id) => !(id in g.cards));
    case 'lady':
      return [g.lady.holder];
    case 'ladyResult':
      return [g.lady.peek.by].filter((id) => !g.acks[id]);
    case 'assassin':
      return [assassinId(g)];
    default:
      return [];
  }
}

function finish(g, winner, reason, now) {
  g.winner = winner;
  g.reason = reason;
  go(g, 'over', now);
  feed(g, { k: 'over', winner, reason });
}

function startPlay(g, now) {
  go(g, 'propose', now);
  g.team = [];
}

function resolveVote(g, now) {
  const yes = g.order.filter((id) => g.votes[id]).length;
  const approved = yes * 2 > g.order.length;
  const entry = {
    quest: g.quest,
    attempt: g.rejects + 1,
    leader: g.leader,
    team: g.team.slice(),
    votes: { ...g.votes },
    approved,
  };
  g.history.push(entry);
  feed(g, { k: 'vote', quest: g.quest, leader: g.leader, approved, yes, no: g.order.length - yes });
  go(g, 'voteResult', now, RESULT_SCREEN_MS);
}

function afterVoteResult(g, now) {
  const last = g.history[g.history.length - 1];
  if (last.approved) {
    go(g, 'quest', now);
    g.cards = {};
    return;
  }
  g.rejects += 1;
  if (g.rejects >= 5) return finish(g, 'evil', 'five_rejects', now);
  g.leader = nextAfter(g, g.leader);
  go(g, 'propose', now);
  g.team = [];
}

function resolveQuest(g, now) {
  const n = g.order.length;
  const fails = g.team.filter((id) => g.cards[id] === 'fail').length;
  const success = fails < failsNeeded(n, g.quest);
  g.results[g.quest] = success ? 'success' : 'fail';
  g.outcome = { quest: g.quest, size: g.team.length, fails, success };
  g.history[g.history.length - 1].outcome = { ...g.outcome };
  g.rejects = 0;
  feed(g, { k: 'quest', quest: g.quest, success, fails });
  go(g, 'questResult', now, RESULT_SCREEN_MS);
}

function nextRound(g, now) {
  g.quest += 1;
  g.leader = nextAfter(g, g.leader);
  g.outcome = null;
  go(g, 'propose', now);
  g.team = [];
}

function afterQuestResult(g, now) {
  const wins = g.results.filter((r) => r === 'success').length;
  const losses = g.results.filter((r) => r === 'fail').length;
  if (losses >= 3) return finish(g, 'evil', 'three_fails', now);
  if (wins >= 3) {
    go(g, 'assassin', now);
    return;
  }
  // Lady of the Lake is used after quests 2, 3 and 4.
  if (g.lady.enabled && g.quest >= 1 && g.quest <= 3) {
    go(g, 'lady', now);
    return;
  }
  nextRound(g, now);
}

function afterLady(g, now) {
  g.lady.peek = null;
  nextRound(g, now);
}

// Advance when everyone who is *present* has acknowledged, or the screen timed out.
function ackComplete(g, ctx, now) {
  const need = pending(g).filter((id) => !(ctx.awayMs[id] > 0));
  if (need.length === 0) return true;
  return g.deadline != null && now >= g.deadline;
}

// Move the game forward as far as possible. Safe to call any number of times.
export function tick(g, ctx, now) {
  if (!g || g.phase === 'over') return false;
  let changed = false;
  for (let guard = 0; guard < 40; guard++) {
    const before = g.seq;
    const beforeVotes = Object.keys(g.votes).length + Object.keys(g.cards).length + g.team.length;
    autoFill(g, ctx, now);
    switch (g.phase) {
      case 'reveal':
        if (g.order.every((id) => g.acks[id] || ctx.awayMs[id] > 0) && g.order.some((id) => g.acks[id])) {
          startPlay(g, now);
        }
        break;
      case 'vote':
        if (g.order.every((id) => id in g.votes)) resolveVote(g, now);
        break;
      case 'quest':
        if (g.team.every((id) => id in g.cards)) resolveQuest(g, now);
        break;
      case 'voteResult':
        if (ackComplete(g, ctx, now)) afterVoteResult(g, now);
        break;
      case 'questResult':
        if (ackComplete(g, ctx, now)) afterQuestResult(g, now);
        break;
      case 'ladyResult':
        if (ackComplete(g, ctx, now)) afterLady(g, now);
        break;
      default:
    }
    const afterVotes = Object.keys(g.votes).length + Object.keys(g.cards).length + g.team.length;
    if (g.seq === before && afterVotes === beforeVotes) break;
    changed = true;
  }
  return changed;
}

// Offline players never block the table: after `autoDelay` seconds the server
// plays the safest default for them and says so in the feed.
function autoFill(g, ctx, now) {
  if (!g.cfg.autoplay) return;
  const limit = g.cfg.autoDelay * 1000;
  const gone = (id) => (ctx.awayMs[id] || 0) >= limit && now - g.phaseAt >= limit / 2;
  switch (g.phase) {
    case 'propose': {
      if (!gone(g.leader)) return;
      const need = questSize(g);
      const team = g.team.filter((id) => g.order.includes(id)).slice(0, need);
      const pool = shuffle(g.order.filter((id) => !team.includes(id)), ctx.rng);
      if (!team.includes(g.leader) && team.length < need) team.push(g.leader);
      while (team.length < need) team.push(pool.pop());
      g.team = team;
      feed(g, { k: 'auto', id: g.leader, what: 'propose' });
      go(g, 'vote', now);
      g.votes = {};
      break;
    }
    case 'vote':
      for (const id of g.order) {
        if (!(id in g.votes) && gone(id)) {
          g.votes[id] = true;
          feed(g, { k: 'auto', id, what: 'vote' });
        }
      }
      break;
    case 'quest':
      for (const id of g.team) {
        if (!(id in g.cards) && gone(id)) {
          g.cards[id] = 'success';
          feed(g, { k: 'auto', id, what: 'card' });
        }
      }
      break;
    case 'lady': {
      const holder = g.lady.holder;
      if (!gone(holder)) return;
      const options = g.order.filter((id) => !g.lady.used.includes(id));
      if (options.length === 0) return afterLady(g, now);
      doLady(g, holder, options[Math.floor(ctx.rng() * options.length)], now);
      feed(g, { k: 'auto', id: holder, what: 'lady' });
      break;
    }
    default:
  }
}

function doLady(g, holder, target, now) {
  const result = teamOf(g.roles[target]);
  g.lady.peek = { by: holder, target, result };
  g.lady.holder = target;
  g.lady.used.push(target);
  feed(g, { k: 'lady', by: holder, target });
  go(g, 'ladyResult', now, LADY_RESULT_MS);
}

const ok = { ok: true };
const fail = (error) => ({ ok: false, error });

// msg.type: ack | select | propose | vote | card | lady | assassinate
export function act(g, pid, msg, ctx, now) {
  if (!g) return fail('no_game');
  if (!g.order.includes(pid)) return fail('not_player');
  if (g.phase === 'over') return fail('game_over');
  if (msg.seq !== undefined && msg.seq !== g.seq) return fail('stale');

  switch (msg.type) {
    case 'ack': {
      if (!['reveal', 'voteResult', 'questResult', 'ladyResult'].includes(g.phase)) return fail('bad_phase');
      g.acks[pid] = true;
      break;
    }
    case 'select': {
      if (g.phase !== 'propose') return fail('bad_phase');
      if (pid !== g.leader) return fail('not_leader');
      if (!g.order.includes(msg.id)) return fail('bad_target');
      const i = g.team.indexOf(msg.id);
      if (i >= 0) g.team.splice(i, 1);
      else if (g.team.length < questSize(g)) g.team.push(msg.id);
      else return fail('team_full');
      break;
    }
    case 'propose': {
      if (g.phase !== 'propose') return fail('bad_phase');
      if (pid !== g.leader) return fail('not_leader');
      if (g.team.length !== questSize(g)) return fail('team_size');
      go(g, 'vote', now);
      g.votes = {};
      break;
    }
    case 'vote': {
      if (g.phase !== 'vote') return fail('bad_phase');
      if (typeof msg.v !== 'boolean') return fail('bad_value');
      g.votes[pid] = msg.v;
      break;
    }
    case 'card': {
      if (g.phase !== 'quest') return fail('bad_phase');
      if (!g.team.includes(pid)) return fail('not_on_team');
      if (msg.v !== 'success' && msg.v !== 'fail') return fail('bad_value');
      if (msg.v === 'fail' && teamOf(g.roles[pid]) !== 'evil') return fail('good_must_succeed');
      g.cards[pid] = msg.v;
      break;
    }
    case 'lady': {
      if (g.phase !== 'lady') return fail('bad_phase');
      if (pid !== g.lady.holder) return fail('not_holder');
      if (!g.order.includes(msg.id) || g.lady.used.includes(msg.id)) return fail('bad_target');
      doLady(g, pid, msg.id, now);
      break;
    }
    case 'assassinate': {
      if (g.phase !== 'assassin') return fail('bad_phase');
      const killer = assassinId(g);
      const takeover =
        pid !== killer && teamOf(g.roles[pid]) === 'evil' && (ctx.awayMs[killer] || 0) >= ASSASSIN_TAKEOVER_MS;
      if (pid !== killer && !takeover) return fail('not_assassin');
      if (!g.order.includes(msg.id) || msg.id === pid) return fail('bad_target');
      const hit = msg.id === merlinId(g);
      g.assassinated = msg.id;
      feed(g, { k: 'assassinate', by: pid, target: msg.id, hit });
      finish(g, hit ? 'evil' : 'good', hit ? 'merlin_killed' : 'merlin_survived', now);
      return ok;
    }
    default:
      return fail('unknown_action');
  }
  tick(g, ctx, now);
  return ok;
}

// Host override: skip waiting for the result screen / role reveal right now.
export function forceAdvance(g, ctx, now) {
  if (!g) return fail('no_game');
  if (g.phase === 'reveal') {
    startPlay(g, now);
  } else if (['voteResult', 'questResult', 'ladyResult'].includes(g.phase)) {
    g.deadline = now;
    tick(g, ctx, now);
  } else return fail('bad_phase');
  return ok;
}
