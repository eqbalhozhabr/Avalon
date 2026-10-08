// Builds the per-player snapshot sent over the WebSocket. This is the single
// place that decides what a given player is allowed to know: roles, tokens,
// hidden votes and quest cards never leave the server unless the rules reveal them.

import {
  EVIL_COUNT,
  MAX_PLAYERS,
  MIN_PLAYERS,
  QUEST_SIZES,
  assassinId,
  buildRoleList,
  failsNeeded,
  knowledge,
  pending,
  teamOf,
} from './game.js';

export function lobbyCheck(s) {
  const built = buildRoleList(s.players.length, s.config);
  return built.error ? { ok: false, error: built.error } : { ok: true };
}

export function viewFor(s, pid, now) {
  const g = s.game;
  const players = s.players.map((p, seat) => ({
    id: p.id,
    name: p.name,
    seat,
    avatar: p.avatar,
    away: p.awaySince != null,
    awayMs: p.awaySince != null ? Math.max(0, now - p.awaySince) : 0,
  }));
  const view = {
    ver: s.ver,
    code: s.code,
    me: pid,
    host: s.hostId,
    phase: g ? g.phase : 'lobby',
    players,
    config: s.config,
    limits: { min: MIN_PLAYERS, max: MAX_PLAYERS },
    now,
  };
  if (!g) {
    view.check = lobbyCheck(s);
    view.evilCount = EVIL_COUNT[s.players.length] ?? null;
    return view;
  }

  const n = g.order.length;
  const gv = {
    phase: g.phase,
    seq: g.seq,
    leader: g.leader,
    rejects: g.rejects,
    quest: g.quest,
    results: g.results,
    sizes: QUEST_SIZES[n],
    failsNeeded: [0, 1, 2, 3, 4].map((q) => failsNeeded(n, q)),
    evilCount: EVIL_COUNT[n],
    team: g.team,
    deadline: g.deadline,
    pending: pending(g),
    acks: Object.keys(g.acks),
    history: g.history,
    feed: g.feed,
    lady: { enabled: g.lady.enabled, holder: g.lady.holder, used: g.lady.used },
    winner: g.winner,
    reason: g.reason,
  };

  // Hidden-until-reveal information.
  if (g.phase === 'vote') {
    gv.voted = Object.keys(g.votes);
    if (pid in g.votes) gv.myVote = g.votes[pid];
  } else if (g.phase === 'voteResult') {
    gv.votes = g.votes;
  }
  if (g.phase === 'quest') {
    gv.submitted = Object.keys(g.cards);
    if (pid in g.cards) gv.myCard = g.cards[pid];
  }
  if (g.phase === 'questResult' || g.outcome) gv.outcome = g.outcome;
  if (g.lady.peek && g.lady.peek.by === pid) gv.ladyPeek = g.lady.peek;
  if (g.lady.peek) gv.ladyPeekTarget = g.lady.peek.target; // public: who was inspected

  if (g.roles[pid]) {
    gv.me = {
      role: g.roles[pid],
      team: teamOf(g.roles[pid]),
      knows: knowledge(g.roles, pid),
    };
  }
  gv.assassin = g.phase === 'assassin' ? assassinId(g) : undefined;
  if (g.phase === 'over') {
    gv.roles = g.roles;
    gv.assassinated = g.assassinated ?? null;
  }
  view.game = gv;
  return view;
}
