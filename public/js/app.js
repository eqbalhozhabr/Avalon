import { Table3D } from './table3d.js';
import { Conn, WakeKeeper, clearCreds, createRoom, loadCreds } from './net.js';
import { ERR, FATAL, MARK, ROLE, TEAM, WIN_REASON, fa, feedText } from './strings.js';

// ------------------------------------------------------------------ tiny DOM helpers
const $ = (s) => document.querySelector(s);
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

// ------------------------------------------------------------------ app state
const ui = {
  conn: null,
  view: null,
  code: null,
  peek: false, // role card revealed?
  target: null, // locally chosen target (lady / assassin)
  targetSeq: null,
  sheet: null,
  skew: 0,
  lastPending: false,
  feedSeen: 0,
  feedPrimed: false,
};
const table = new Table3D($('#table'));
const wake = new WakeKeeper((on) => {
  ui.wakeOn = on;
  if (!$('#sheet').classList.contains('hidden')) renderSheet();
});

const nameOf = (id) => ui.view?.players.find((p) => p.id === id)?.name ?? '؟';
const me = () => ui.view?.me;
const isHost = () => ui.view && ui.view.host === ui.view.me;
const playerOf = (id) => ui.view?.players.find((p) => p.id === id);

// ------------------------------------------------------------------ screens
function show(screen) {
  $('#home').classList.toggle('hidden', screen !== 'home');
  $('#room').classList.toggle('hidden', screen !== 'room');
  if (screen === 'room') {
    table.resize($('#table').parentElement.clientWidth);
    table.start();
  } else table.stop();
}

function goHome(msg = '') {
  ui.conn?.close();
  ui.conn = null;
  ui.view = null;
  history.replaceState(null, '', location.pathname);
  $('#fatal').classList.add('hidden');
  $('#offline').classList.add('hidden');
  $('#home-err').textContent = msg;
  closeSheet();
  renderResume();
  show('home');
  document.title = 'آوالون آنلاین';
}

function renderResume() {
  const old = $('#resume');
  if (old) old.remove();
  const last = store.get('avalon.lastRoom');
  if (!last || !loadCreds(last)) return;
  $('#home .card').prepend(
    h('button', { id: 'resume', class: 'btn gold big', onclick: () => enterRoom(last, store.get('avalon.name') || '') }, `ادامه‌ی بازی در اتاق ${last}`),
  );
}

async function enterRoom(code, name) {
  code = code.toUpperCase();
  ui.code = code;
  store.set('avalon.lastRoom', code);
  if (name) store.set('avalon.name', name);
  history.replaceState(null, '', `#${code}`);
  ui.conn?.close();
  ui.peek = false;
  ui.feedPrimed = false;
  ui.feedSeen = 0;
  ui.conn = new Conn(code, name, {
    onView: onView,
    onStatus: (s) => {
      $('#net').className = `net ${s}`;
      // Only show the blocking overlay if we have been offline for a moment; short blips stay invisible.
      clearTimeout(ui.offTimer);
      if (s === 'online') $('#offline').classList.add('hidden');
      else ui.offTimer = setTimeout(() => ui.view && $('#offline').classList.remove('hidden'), 1200);
    },
    onFatal: onFatal,
    onError: (e) => {
      if (ERR[e]) toast(ERR[e]);
      else if (e !== 'stale') toast(`خطا: ${e}`);
    },
  });
  show('room');
  ui.conn.open();
  wake.acquire();
}

function onFatal(code) {
  const [title, text] = FATAL[code] || ['خطا', code];
  $('#fatal-title').textContent = title;
  $('#fatal-text').textContent = text;
  $('#fatal-retry').classList.toggle('hidden', code !== 'replaced');
  $('#fatal-btn').onclick = () => {
    if (['no_room', 'bad_token', 'kicked', 'left'].includes(code)) {
      clearCreds(ui.code);
      store.set('avalon.lastRoom', '');
    }
    goHome();
  };
  $('#fatal-retry').onclick = () => {
    $('#fatal').classList.add('hidden');
    ui.conn.reconnectNow();
  };
  $('#offline').classList.add('hidden');
  $('#fatal').classList.remove('hidden');
}

// ------------------------------------------------------------------ home handlers
const nameInput = $('#name');
nameInput.value = store.get('avalon.name') || '';
$('#code').addEventListener('input', (e) => (e.target.value = e.target.value.replace(/[^a-zA-Z]/g, '').toUpperCase()));

function needName() {
  const n = nameInput.value.trim();
  if (!n) {
    $('#home-err').textContent = 'اول یک نام وارد کن';
    nameInput.focus();
    return null;
  }
  return n;
}

$('#btn-create').onclick = async () => {
  const name = needName();
  if (!name) return;
  $('#home-err').textContent = '';
  try {
    const code = await createRoom();
    enterRoom(code, name);
  } catch {
    $('#home-err').textContent = 'ساخت اتاق ممکن نشد. اینترنت را بررسی کن.';
  }
};
$('#btn-join').onclick = () => {
  const name = needName();
  const code = $('#code').value.trim();
  if (!name) return;
  if (code.length !== 4) {
    $('#home-err').textContent = 'کد اتاق ۴ حرف است';
    return;
  }
  enterRoom(code, name);
};

// ------------------------------------------------------------------ view handling
function onView(view) {
  const prev = ui.view;
  ui.view = view;
  ui.skew = Date.now() - view.now;
  const g = view.game;

  if (g && ui.targetSeq !== g.seq) {
    ui.target = null;
    ui.targetSeq = g.seq;
  }
  if (!g) ui.peek = false;
  if (prev?.game && g && prev.game.seq !== g.seq && g.phase === 'reveal') ui.peek = false;

  // feed -> toasts (skip history we already had when joining)
  if (g) {
    if (!ui.feedPrimed) {
      ui.feedPrimed = true;
      ui.feedSeen = g.feed.length;
    }
    for (let i = ui.feedSeen; i < g.feed.length; i++) {
      const t = feedText(g.feed[i], nameOf);
      if (t) toast(t);
    }
    ui.feedSeen = g.feed.length;
  } else ui.feedSeen = 0;

  // "your turn" nudge
  const turn = !!g && g.pending.includes(view.me) && !['reveal', 'voteResult', 'questResult', 'ladyResult'].includes(g.phase);
  if (turn && !ui.lastPending) {
    try {
      navigator.vibrate?.([70, 50, 70]);
    } catch {
      /* ignore */
    }
  }
  ui.lastPending = turn;
  document.title = `${turn ? '🔔 ' : ''}آوالون · ${view.code}`;

  render();
}

function toast(text) {
  const el = h('div', { class: 'toast' }, text);
  $('#toasts').append(el);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
  setTimeout(() => el.remove(), 5000);
}

// ------------------------------------------------------------------ rendering
function render() {
  const v = ui.view;
  if (!v) return;
  const mySeat = v.players.find((p) => p.id === v.me)?.seat ?? 0;
  table.setPlayers(v.players, mySeat);
  table.setDynamic(dynamicFor(v));
  renderSeats(v);
  renderHud(v);
  renderBanner(v);
  renderPanel(v);
  if (!$('#sheet').classList.contains('hidden')) renderSheet();
}

function allowedTargets(v) {
  const g = v.game;
  if (!g) return new Set();
  const set = new Set();
  if (g.phase === 'propose' && canLead(v)) v.players.forEach((p) => set.add(p.id));
  if (g.phase === 'lady' && g.lady.holder === v.me) v.players.filter((p) => !g.lady.used.includes(p.id)).forEach((p) => set.add(p.id));
  if (g.phase === 'assassin' && canAssassinate(v)) v.players.filter((p) => p.id !== v.me).forEach((p) => set.add(p.id));
  return set;
}

// The leader acts for themselves; the host may act for an offline leader.
function canLead(v) {
  const g = v.game;
  return g.leader === v.me || (v.host === v.me && playerOf(g.leader)?.away);
}
function leadProxy(v) {
  return v.game.leader !== v.me ? { for: v.game.leader } : {};
}
function canAssassinate(v) {
  const g = v.game;
  if (g.assassin === v.me) return true;
  const killer = playerOf(g.assassin);
  return g.me?.team === 'evil' && killer?.away && killer.awayMs >= 15000;
}

function dynamicFor(v) {
  const g = v.game;
  const dyn = { away: new Set(v.players.filter((p) => p.away).map((p) => p.id)) };
  if (!g) return dyn;
  dyn.leader = g.leader;
  const showTeam = ['propose', 'vote', 'voteResult', 'quest'].includes(g.phase);
  dyn.team = new Set(showTeam ? g.team : []);
  if (g.phase === 'lady' && ui.target) dyn.team = new Set([ui.target]);
  if (g.phase === 'assassin' && ui.target) dyn.team = new Set([ui.target]);
  if (g.phase === 'ladyResult' && g.ladyPeekTarget) dyn.team = new Set([g.ladyPeekTarget]);
  const pend = ['propose', 'vote', 'quest', 'lady', 'assassin'].includes(g.phase) ? g.pending : [];
  dyn.pending = new Set(pend.length <= 3 ? pend : []);
  dyn.selectable = allowedTargets(v);
  dyn.cards = {};
  if (g.phase === 'vote') (g.voted || []).forEach((id) => (dyn.cards[id] = 'down'));
  if (g.phase === 'voteResult') for (const [id, yes] of Object.entries(g.votes || {})) dyn.cards[id] = yes ? 'approve' : 'reject';
  if (g.phase === 'quest') (g.submitted || []).forEach((id) => (dyn.cards[id] = 'down'));
  if (g.phase === 'questResult' && g.outcome) {
    const o = g.outcome;
    const arr = [...Array(o.size - o.fails).fill('success'), ...Array(o.fails).fill('fail')];
    // Deterministic shuffle so nobody can read who played what from the order.
    let s = g.seq * 9301 + 49297;
    for (let i = arr.length - 1; i > 0; i--) {
      s = (s * 9301 + 49297) % 233280;
      const j = Math.floor((s / 233280) * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    dyn.center = arr;
  }
  return dyn;
}

function seatTag(v, p) {
  const g = v.game;
  if (!g) return p.id === v.host ? { t: 'میزبان', c: 'info' } : null;
  if (g.phase === 'over' && g.roles) {
    const r = ROLE[g.roles[p.id]];
    return { t: r.name, c: r.team };
  }
  if (g.phase === 'voteResult' && g.votes && p.id in g.votes) return g.votes[p.id] ? { t: 'قبول', c: 'vote-yes' } : { t: 'رد', c: 'vote-no' };
  if (ui.peek && g.me) {
    if (p.id === v.me) return { t: ROLE[g.me.role].name, c: g.me.team };
    const k = g.me.knows.find((x) => x.id === p.id);
    if (k) return { t: MARK[k.mark].text, c: MARK[k.mark].cls };
  }
  if (p.away) return { t: 'آفلاین', c: 'info' };
  return null;
}

function renderSeats(v) {
  const wrap = $('#seats');
  const boxes = table.seatBoxes();
  const tappable = allowedTargets(v);
  const g = v.game;
  const selected = new Set(g ? (['lady', 'assassin'].includes(g.phase) && ui.target ? [ui.target] : g.team) : []);
  const have = new Map([...wrap.children].map((el) => [el.dataset.id, el]));
  for (const b of boxes) {
    const p = playerOf(b.id);
    let el = have.get(b.id);
    if (!el) {
      el = h('button', { class: 'seat', 'data-id': b.id }, h('span', { class: 'nm' }), h('span', { class: 'rl hidden' }));
      el.addEventListener('click', () => onSeatTap(b.id));
      wrap.append(el);
    }
    have.delete(b.id);
    el.style.left = `${b.left}%`;
    el.style.top = `${b.top}%`;
    el.classList.toggle('above', b.above);
    el.classList.toggle('me', b.id === v.me);
    el.classList.toggle('away', !!p.away);
    el.classList.toggle('tap', tappable.has(b.id));
    el.classList.toggle('sel', selected.has(b.id));
    el.querySelector('.nm').textContent = p.name;
    const tag = seatTag(v, p);
    const rl = el.querySelector('.rl');
    rl.classList.toggle('hidden', !tag);
    if (tag) {
      rl.textContent = tag.t;
      rl.className = `rl ${tag.c}`;
    }
  }
  for (const el of have.values()) el.remove();
}

function onSeatTap(id) {
  const v = ui.view;
  const g = v?.game;
  if (!g || !allowedTargets(v).has(id)) return;
  if (g.phase === 'propose') ui.conn.act({ type: 'select', id, ...leadProxy(v) });
  else if (g.phase === 'lady' || g.phase === 'assassin') {
    ui.target = ui.target === id ? null : id;
    render();
  }
}

function renderHud(v) {
  const g = v.game;
  const q = $('#quests');
  q.replaceChildren();
  const rj = $('#rejects');
  rj.replaceChildren();
  if (!g) {
    q.append(h('span', { class: 'sub' }, `اتاق ${v.code}`));
    return;
  }
  g.sizes.forEach((size, i) => {
    const cls = g.results[i] || (g.phase !== 'over' && i === g.quest ? 'cur' : '');
    q.append(h('div', { class: `q ${cls}`, title: `ماموریت ${fa(i + 1)}` }, fa(size), g.failsNeeded[i] === 2 ? h('small', {}, '۲✕') : null));
  });
  for (let i = 0; i < 5; i++) rj.append(h('i', { class: i < g.rejects ? 'on' : '' }));
}

function renderBanner(v) {
  const b = $('#banner');
  const g = v.game;
  let text = '';
  let cls = '';
  if (g?.phase === 'over') {
    text = g.winner === 'good' ? 'خوبان پیروز شدند!' : 'اشرار پیروز شدند!';
    cls = g.winner;
  } else if (g?.phase === 'voteResult') {
    const approved = g.history.at(-1)?.approved;
    text = approved ? 'تیم تأیید شد' : 'تیم رد شد';
    cls = approved ? 'good' : 'evil';
  } else if (g?.phase === 'questResult' && g.outcome) {
    text = g.outcome.success ? 'ماموریت موفق!' : 'ماموریت شکست خورد!';
    cls = g.outcome.success ? 'good' : 'evil';
  }
  b.textContent = text;
  b.className = `banner ${cls} ${text ? '' : 'hidden'}`;
}

// ------------------------------------------------------------------ panel
function renderPanel(v) {
  const panel = $('#panel');
  const g = v.game;
  let kids;
  if (!g) kids = lobbyPanel(v);
  else
    kids = {
      reveal: revealPanel,
      propose: proposePanel,
      vote: votePanel,
      voteResult: voteResultPanel,
      quest: questPanel,
      questResult: questResultPanel,
      lady: ladyPanel,
      ladyResult: ladyResultPanel,
      assassin: assassinPanel,
      over: overPanel,
    }[g.phase](v, g);
  panel.replaceChildren(...kids.flat().filter(Boolean));
  tickCountdowns();
}

const act = (a) => ui.conn.act(a);

function roundInfo(v, g) {
  const need = g.sizes[g.quest];
  const f2 = g.failsNeeded[g.quest] === 2 ? ' · برای شکست ۲ کارت لازم است' : '';
  return h('p', { class: 'sub' }, `ماموریت ${fa(g.quest + 1)} از ۵ · تیم ${fa(need)} نفره · تلاش ${fa(g.rejects + 1)} از ۵${f2}`);
}

const waiting = (text) => h('div', { class: 'waiting' }, h('span', { class: 'spinner', style: 'width:16px;height:16px;margin:0' }), h('span', {}, text, h('span', { class: 'dots' })));

function countdown(g) {
  return g.deadline ? h('span', { class: 'cd', 'data-deadline': g.deadline }, '') : null;
}
function tickCountdowns() {
  for (const el of document.querySelectorAll('[data-deadline]')) {
    const left = Math.max(0, Math.ceil((Number(el.dataset.deadline) + ui.skew - Date.now()) / 1000));
    el.textContent = fa(left);
  }
}
setInterval(tickCountdowns, 500);

// ---- lobby
function lobbyPanel(v) {
  const host = isHost();
  const n = v.players.length;
  const link = `${location.origin}${location.pathname}#${v.code}`;
  const out = [];
  out.push(h('h2', {}, 'اتاق انتظار'));
  out.push(h('div', { class: 'code-big' }, v.code));
  out.push(
    h(
      'div',
      { class: 'btn-row' },
      h('button', { class: 'btn small', onclick: () => copy(link) }, 'کپی لینک دعوت'),
      navigator.share ? h('button', { class: 'btn small', onclick: () => navigator.share({ title: 'آوالون', text: `به بازی آوالون بپیوند! کد اتاق: ${v.code}`, url: link }).catch(() => {}) }, 'اشتراک‌گذاری') : null,
    ),
  );
  out.push(h('p', { class: 'sub' }, `${fa(n)} از ${fa(v.limits.max)} بازیکن · حداقل ${fa(v.limits.min)} نفر لازم است. ترتیب نشستن همان ترتیب ورود است و بعد از شروع تغییر نمی‌کند.`));
  out.push(
    h(
      'div',
      { class: 'chips' },
      v.players.map((p) =>
        h(
          'span',
          { class: `chip ${p.away ? 'away' : ''}` },
          p.name,
          p.id === v.host ? ' 👑' : '',
          host && p.id !== v.me ? h('button', { title: 'اخراج', onclick: () => confirm(`${p.name} اخراج شود؟`) && act({ type: 'kick', id: p.id }) }, '✕') : null,
        ),
      ),
    ),
  );

  const c = v.config;
  const toggle = (key, label, tip) =>
    h(
      'label',
      { class: `toggle ${host ? '' : 'disabled'}`, title: tip },
      h('input', { type: 'checkbox', checked: c[key], disabled: !host, onchange: (e) => act({ type: 'config', config: { [key]: e.target.checked } }) }),
      label,
    );
  out.push(h('h2', {}, 'نقش‌ها'));
  out.push(
    h(
      'div',
      { class: 'toggles' },
      toggle('percival', 'پرسیوال'),
      toggle('morgana', 'مورگانا'),
      toggle('mordred', 'موردرد'),
      toggle('oberon', 'ابرون'),
      toggle('lady', 'بانوی دریاچه', 'بعد از ماموریت ۲، ۳ و ۴ هویت یک نفر را می‌بینید'),
      toggle('autoplay', 'جایگزین خودکار برای آفلاین‌ها', 'اگر بازیکنی آفلاین باشد، بعد از چند ثانیه حرکت پیش‌فرض برایش انجام می‌شود تا بازی نایستد'),
    ),
  );
  if (n >= v.limits.min) {
    const evil = v.evilCount;
    out.push(h('p', { class: 'sub' }, `ترکیب: ${fa(n - evil)} خوب، ${fa(evil)} شرور (مرلین و آساسین همیشه هستند)`));
  }
  if (host && c.autoplay) {
    out.push(
      h(
        'label',
        { class: 'field' },
        'آفلاین بعد از چند ثانیه جایگزین شود؟',
        h(
          'select',
          { onchange: (e) => act({ type: 'config', config: { autoDelay: Number(e.target.value) } }) },
          [15, 30, 40, 60, 90, 120].map((s) => h('option', { value: s, selected: s === c.autoDelay }, `${fa(s)} ثانیه`)),
        ),
      ),
    );
  }

  if (host) {
    const ok = v.check.ok;
    out.push(h('button', { class: 'btn primary big', disabled: !ok, onclick: () => act({ type: 'start' }) }, 'شروع بازی'));
    if (!ok) out.push(h('p', { class: 'err' }, ERR[v.check.error] || v.check.error));
    out.push(h('button', { class: 'btn small', disabled: n < 2, onclick: () => act({ type: 'shuffle' }) }, 'بُر زدن ترتیب نشستن'));
  } else {
    out.push(waiting(`منتظر ${nameOf(v.host)} (میزبان) برای شروع`));
    if (playerOf(v.host)?.awayMs > 60000) out.push(h('button', { class: 'btn small', onclick: () => act({ type: 'claimHost' }) }, 'میزبان نیست؛ من میزبان شوم'));
  }
  return out;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('لینک کپی شد');
  } catch {
    prompt('لینک را کپی کن:', text);
  }
}

// ---- role card (reveal phase + sheet)
function roleCard(v, g) {
  const r = g.me && ROLE[g.me.role];
  if (!r) return h('div', { class: 'hidden-role' }, 'نقشی برای شما ثبت نشده (تماشاچی).');
  if (!ui.peek) {
    return h('button', { class: 'hidden-role btn', onclick: () => { ui.peek = true; render(); } }, 'برای دیدن نقش خود لمس کن (مطمئن شو کسی صفحه را نمی‌بیند)');
  }
  const knows = g.me.knows.map((k) => h('span', { class: `rl ${MARK[k.mark].cls}`, style: 'padding:2px 8px;font-size:13px' }, `${nameOf(k.id)} · ${MARK[k.mark].text}`));
  return h(
    'div',
    { class: `rolecard ${g.me.team}` },
    h('span', { class: 'team' }, TEAM[g.me.team]),
    h('div', { class: 'rname' }, r.name),
    h('div', { class: 'sub' }, r.desc),
    knows.length ? h('div', { class: 'chips' }, h('span', { class: 'sub' }, 'می‌دانی:'), knows) : null,
    h('button', { class: 'btn small', onclick: () => { ui.peek = false; render(); } }, 'پنهان کن'),
  );
}

function revealPanel(v, g) {
  const ready = g.acks.length;
  const iAcked = g.acks.includes(v.me);
  return [
    h('h2', {}, 'شب است؛ نقش‌ها پخش شد'),
    roleCard(v, g),
    h('button', { class: 'btn ok big', disabled: iAcked, onclick: () => { ui.peek = false; act({ type: 'ack' }); } }, iAcked ? 'آماده‌ای ✓' : 'نقشم را دیدم، آماده‌ام'),
    h('div', { class: 'progress' }, h('i', { style: `width:${(ready / v.players.length) * 100}%` })),
    h('p', { class: 'sub' }, `${fa(ready)} از ${fa(v.players.length)} نفر آماده‌اند. بازی خودکار شروع می‌شود؛ بازیکنان آفلاین منتظر نمی‌مانند.`),
    isHost() ? h('button', { class: 'btn small', onclick: () => act({ type: 'force' }) }, 'همین حالا شروع کن') : null,
  ];
}

// ---- propose
function proposePanel(v, g) {
  const need = g.sizes[g.quest];
  const leader = nameOf(g.leader);
  if (canLead(v)) {
    const proxy = leadProxy(v);
    const asProxy = Object.keys(proxy).length ? ` (به‌جای ${leader}، آفلاین است)` : '';
    return [
      h('h2', {}, g.leader === v.me ? 'تو رهبری!' : `رهبر: ${leader}`),
      roundInfo(v, g),
      h('p', {}, `${fa(need)} نفر را برای ماموریت انتخاب کن (روی بازیکن‌ها بزن)${asProxy}`),
      h('div', { class: 'chips' }, g.team.map((id) => h('span', { class: 'chip' }, nameOf(id))), g.team.length === 0 ? h('span', { class: 'sub' }, 'هنوز کسی انتخاب نشده') : null),
      h('div', { class: 'progress' }, h('i', { style: `width:${(g.team.length / need) * 100}%` })),
      h('button', { class: 'btn primary big', disabled: g.team.length !== need, onclick: () => act({ type: 'propose', ...proxy }) }, `پیشنهاد تیم (${fa(g.team.length)}/${fa(need)})`),
    ];
  }
  return [h('h2', {}, `رهبر: ${leader}`), roundInfo(v, g), waiting(`${leader} در حال انتخاب تیم است`), g.team.length ? h('div', { class: 'chips' }, g.team.map((id) => h('span', { class: 'chip' }, nameOf(id)))) : null, awayHelp(v, g)];
}

// If whoever the table is waiting on is offline, tell everyone what happens next.
function awayHelp(v, g) {
  const gone = g.pending.map(playerOf).filter((p) => p?.away);
  if (!gone.length || !v.config.autoplay) return null;
  return h('p', { class: 'sub' }, `${gone.map((p) => p.name).join('، ')} آفلاین است؛ اگر برنگردد، بعد از ${fa(v.config.autoDelay)} ثانیه حرکت پیش‌فرض انجام می‌شود.`);
}

// ---- vote
function votePanel(v, g) {
  const total = v.players.length;
  const waitingFor = g.pending.map(playerOf);
  const proxies = isHost() ? waitingFor.filter((p) => p?.away) : [];
  return [
    h('h2', {}, `رأی‌گیری: تیم ${nameOf(g.leader)}`),
    roundInfo(v, g),
    h('div', { class: 'chips' }, g.team.map((id) => h('span', { class: 'chip' }, nameOf(id)))),
    h(
      'div',
      { class: 'vote-btns' },
      h('button', { class: `btn ok ${g.myVote === true ? 'chosen' : ''}`, onclick: () => act({ type: 'vote', v: true }) }, '✔ قبول'),
      h('button', { class: `btn evil ${g.myVote === false ? 'chosen' : ''}`, onclick: () => act({ type: 'vote', v: false }) }, '✘ رد'),
    ),
    h('p', { class: 'sub' }, g.myVote === undefined ? 'رأی شما هنوز ثبت نشده' : 'رأی ثبت شد؛ تا لحظه‌ی آخر می‌توانی تغییرش بدهی.'),
    h('div', { class: 'progress' }, h('i', { style: `width:${((total - waitingFor.length) / total) * 100}%` })),
    waitingFor.length ? h('p', { class: 'sub' }, `منتظر: ${waitingFor.map((p) => p.name + (p.away ? ' (آفلاین)' : '')).join('، ')}`) : null,
    awayHelp(v, g),
    proxies.length
      ? h('div', { class: 'proxy' }, 'میزبان:', proxies.map((p) => h('button', { class: 'btn small', onclick: () => act({ type: 'vote', v: true, for: p.id }) }, `رأی «قبول» به‌جای ${p.name}`)))
      : null,
  ];
}

function continueRow(v, g) {
  const iAcked = g.acks.includes(v.me);
  return [
    h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', disabled: iAcked, onclick: () => act({ type: 'ack' }) }, iAcked ? 'منتظر بقیه…' : 'ادامه'), isHost() ? h('button', { class: 'btn small', style: 'flex:0 0 auto', onclick: () => act({ type: 'force' }) }, 'ادامه برای همه') : null),
    h('p', { class: 'sub' }, 'ادامه‌ی خودکار تا ', countdown(g), ' ثانیه‌ی دیگر. بازیکنان آفلاین منتظر نمی‌مانند.'),
  ];
}

function voteResultPanel(v, g) {
  const last = g.history.at(-1);
  const yes = v.players.filter((p) => g.votes?.[p.id]);
  const no = v.players.filter((p) => g.votes && g.votes[p.id] === false);
  return [
    h('h2', {}, last.approved ? 'تیم تأیید شد' : 'تیم رد شد'),
    h('p', {}, `${fa(yes.length)} قبول · ${fa(no.length)} رد`),
    h('div', { class: 'chips' }, yes.map((p) => h('span', { class: 'chip yes' }, p.name)), no.map((p) => h('span', { class: 'chip no' }, p.name))),
    last.approved ? null : h('p', { class: 'sub' }, g.rejects + 1 >= 5 ? 'این پنجمین رد پشت‌سرهم است!' : `نوبت رهبری به نفر بعدی می‌رسد (${fa(g.rejects + 1)} از ۵ رد)`),
    continueRow(v, g),
  ];
}

// ---- quest
function questPanel(v, g) {
  const onTeam = g.team.includes(v.me);
  const evil = g.me?.team === 'evil';
  const submitted = g.submitted || [];
  const missing = g.team.filter((id) => !submitted.includes(id)).map(playerOf);
  const proxies = isHost() ? missing.filter((p) => p?.away) : [];
  const head = [h('h2', {}, 'ماموریت در جریان است'), roundInfo(v, g), h('div', { class: 'chips' }, g.team.map((id) => h('span', { class: `chip ${submitted.includes(id) ? 'yes' : ''}` }, nameOf(id), submitted.includes(id) ? ' ✓' : '')))];
  const tail = [awayHelp(v, g), proxies.length ? h('div', { class: 'proxy' }, 'میزبان:', proxies.map((p) => h('button', { class: 'btn small', onclick: () => act({ type: 'card', v: 'success', for: p.id }) }, `کارت «موفقیت» به‌جای ${p.name}`))) : null];
  if (!onTeam) return [...head, waiting('منتظر نتیجه‌ی ماموریت'), ...tail];
  return [
    ...head,
    h('p', {}, evil ? 'یک کارت مخفی بازی کن:' : 'تو خوبی؛ فقط می‌توانی «موفقیت» بدهی.'),
    h(
      'div',
      { class: 'vote-btns' },
      h('button', { class: `btn good ${g.myCard === 'success' ? 'chosen' : ''}`, onclick: () => act({ type: 'card', v: 'success' }) }, 'موفقیت'),
      h('button', { class: `btn evil ${g.myCard === 'fail' ? 'chosen' : ''}`, disabled: !evil, onclick: () => act({ type: 'card', v: 'fail' }) }, 'شکست'),
    ),
    h('p', { class: 'sub' }, g.myCard ? 'کارت ثبت شد؛ تا لحظه‌ی آخر قابل تغییر است.' : 'هنوز کارتی نداده‌ای'),
    ...tail,
  ];
}

function questResultPanel(v, g) {
  const o = g.outcome;
  return [
    h('h2', {}, o.success ? 'ماموریت موفق شد' : 'ماموریت شکست خورد'),
    h('p', {}, `از ${fa(o.size)} کارت، ${fa(o.size - o.fails)} موفقیت و ${fa(o.fails)} شکست بود.`),
    g.failsNeeded[o.quest] === 2 ? h('p', { class: 'sub' }, 'در این ماموریت برای شکست ۲ کارت لازم بود.') : null,
    continueRow(v, g),
  ];
}

// ---- lady of the lake
function ladyPanel(v, g) {
  const holder = g.lady.holder;
  if (holder === v.me) {
    return [
      h('h2', {}, 'بانوی دریاچه با توست'),
      h('p', {}, 'یک بازیکن را انتخاب کن تا بفهمی خوب است یا شرور (روی میز بزن).'),
      h('button', { class: 'btn gold big', disabled: !ui.target, onclick: () => act({ type: 'lady', id: ui.target }) }, ui.target ? `نگاه به ${nameOf(ui.target)}` : 'یک نفر را انتخاب کن'),
    ];
  }
  return [h('h2', {}, 'بانوی دریاچه'), waiting(`${nameOf(holder)} در حال انتخاب است`), awayHelp(v, g)];
}

function ladyResultPanel(v, g) {
  if (g.ladyPeek) {
    const good = g.ladyPeek.result === 'good';
    return [
      h('h2', {}, `${nameOf(g.ladyPeek.target)} ${good ? 'خوب است' : 'شرور است'}`),
      h('p', { class: 'sub' }, 'فقط تو این را می‌بینی. حالا بانوی دریاچه نزد او می‌رود.'),
      h('button', { class: 'btn primary', onclick: () => act({ type: 'ack' }) }, 'فهمیدم'),
    ];
  }
  return [h('h2', {}, 'بانوی دریاچه'), h('p', {}, `${nameOf(g.lady.used.at(-2))} هویت ${nameOf(g.ladyPeekTarget)} را دید.`), waiting('ادامه')];
}

// ---- assassin
function assassinPanel(v, g) {
  const killer = nameOf(g.assassin);
  if (canAssassinate(v)) {
    return [
      h('h2', {}, 'خوبان ۳ ماموریت بردند!'),
      h('p', {}, g.assassin === v.me ? 'آساسین! مرلین را پیدا کن (روی میز بزن). اگر درست حدس بزنی، اشرار برنده می‌شوند.' : `آساسین (${killer}) آفلاین است؛ تو به‌جای او انتخاب می‌کنی.`),
      h('button', { class: 'btn evil big', disabled: !ui.target, onclick: () => confirm(`ترور ${nameOf(ui.target)}؟`) && act({ type: 'assassinate', id: ui.target }) }, ui.target ? `ترور ${nameOf(ui.target)}` : 'یک نفر را انتخاب کن'),
    ];
  }
  return [h('h2', {}, 'خوبان ۳ ماموریت بردند!'), h('p', {}, 'ولی هنوز تمام نشده: آساسین فرصت دارد مرلین را حدس بزند.'), waiting(`${killer} در حال انتخاب است`)];
}

// ---- game over
function overPanel(v, g) {
  const rows = v.players.map((p) => {
    const r = ROLE[g.roles[p.id]];
    return h('span', { class: `chip ${r.team === 'good' ? '' : 'no'}` }, `${p.name}: ${r.name}`);
  });
  return [
    h('h2', {}, g.winner === 'good' ? 'خوبان پیروز شدند' : 'اشرار پیروز شدند'),
    h('p', {}, WIN_REASON[g.reason] || ''),
    g.assassinated ? h('p', { class: 'sub' }, `آساسین ${nameOf(g.assassinated)} را انتخاب کرد.`) : null,
    h('div', { class: 'chips' }, rows),
    isHost() ? h('button', { class: 'btn primary big', onclick: () => act({ type: 'restart' }) }, 'بازی جدید (همین بازیکنان، همین چیدمان)') : waiting(`منتظر ${nameOf(v.host)} برای بازی جدید`),
  ];
}

// ------------------------------------------------------------------ bottom sheet
function openSheet(tab) {
  ui.sheet = tab;
  $('#sheet').classList.remove('hidden');
  $('#sheet-bg').classList.remove('hidden');
  renderSheet();
}
function closeSheet() {
  $('#sheet').classList.add('hidden');
  $('#sheet-bg').classList.add('hidden');
}
$('#btn-menu').onclick = () => openSheet(ui.view?.game ? 'role' : 'help');
$('#sheet-close').onclick = closeSheet;
$('#sheet-bg').onclick = closeSheet;
for (const t of document.querySelectorAll('#sheet .tab[data-tab]')) t.onclick = () => ((ui.sheet = t.dataset.tab), renderSheet());

function renderSheet() {
  const v = ui.view;
  if (!v) return;
  for (const t of document.querySelectorAll('#sheet .tab[data-tab]')) t.classList.toggle('on', t.dataset.tab === ui.sheet);
  const body = $('#sheet-body');
  const g = v.game;
  let kids = [];
  if (ui.sheet === 'role') {
    kids = g ? [roleCard(v, g)] : [h('p', {}, 'نقش‌ها بعد از شروع بازی پخش می‌شوند.')];
  } else if (ui.sheet === 'history') {
    kids = historyTab(v, g);
  } else if (ui.sheet === 'help') {
    kids = helpTab();
  } else {
    kids = settingsTab(v, g);
  }
  body.replaceChildren(...kids.flat().filter(Boolean));
}

function historyTab(v, g) {
  if (!g || (!g.history.length && !g.feed.length)) return [h('p', {}, 'هنوز چیزی اتفاق نیفتاده.')];
  const rows = [...g.history].reverse().map((e) => {
    const yes = v.players.filter((p) => e.votes[p.id]).map((p) => p.name);
    const no = v.players.filter((p) => !e.votes[p.id]).map((p) => p.name);
    return h(
      'div',
      { class: 'row-item' },
      h('b', {}, `ماموریت ${fa(e.quest + 1)} · تلاش ${fa(e.attempt)}`),
      ` — رهبر: ${nameOf(e.leader)} — تیم: ${e.team.map(nameOf).join('، ')}`,
      h('br'),
      `${e.approved ? '✔ تأیید' : '✘ رد'} · قبول: ${yes.join('، ') || '—'} · رد: ${no.join('، ') || '—'}`,
      e.outcome ? h('div', {}, e.outcome.success ? '🔵 ماموریت موفق' : `🔴 ماموریت شکست (${fa(e.outcome.fails)} کارت شکست)`) : null,
    );
  });
  return [h('h3', {}, 'پیشنهادها و رأی‌ها'), ...rows];
}

function helpTab() {
  return [
    h('h3', {}, 'هدف بازی'),
    h('ul', {}, h('li', {}, 'خوبان باید ۳ ماموریت را موفق کنند.'), h('li', {}, 'اشرار باید ۳ ماموریت را خراب کنند، یا ۵ پیشنهاد تیم پشت‌سرهم رد شود، یا آساسین مرلین را حدس بزند.')),
    h('h3', {}, 'هر دور'),
    h('ul', {}, h('li', {}, 'رهبر تیم پیشنهاد می‌دهد.'), h('li', {}, 'همه هم‌زمان قبول/رد می‌کنند. اگر مساوی شد یا اکثریت رد کرد، تیم رد می‌شود.'), h('li', {}, 'اعضای تیم کارت مخفی بازی می‌کنند. خوبان فقط «موفقیت»، اشرار هر دو. یک کارت شکست برای شکست ماموریت کافی است (ماموریت ۴ با ۷ نفر و بیشتر: دو کارت).')),
    h('h3', {}, 'درباره‌ی این پروژه'),
    h('p', { dir: 'ltr', style: 'text-align:left' }, 'You can view the original game at ', h('a', { href: 'https://boardgamegeek.com/boardgame/128882/the-resistance-avalon', target: '_blank', rel: 'noopener noreferrer', style: 'color:var(--gold2)' }, 'BoardGameGeek'), '. Disclaimer: This is a non-profit project made by two friends out of pure love for the original game. The project is not affiliated with any of the official publishers of the original game in any way.'),
    h('h3', {}, 'اگر گوشی خاموش شد'),
    h('ul', {}, h('li', {}, 'صفحه را دوباره باز کن؛ خودکار به همان صندلی و نقش برمی‌گردی.'), h('li', {}, 'میز منتظر نمی‌ماند: بازیکن آفلاین بعد از چند ثانیه حرکت پیش‌فرض (رأی قبول / کارت موفقیت) می‌گیرد و میزبان هم می‌تواند به‌جایش بازی کند.'), h('li', {}, 'گزینه‌ی «روشن نگه داشتن صفحه» از خاموش‌شدن صفحه جلوگیری می‌کند.')),
  ];
}

function settingsTab(v, g) {
  return [
    h('h3', {}, 'روشن نگه داشتن صفحه'),
    h('p', {}, wake.supported ? (ui.wakeOn ? 'فعال است: صفحه‌ی گوشی در حین بازی خاموش نمی‌شود.' : 'فعال نیست. با زدن دکمه، جلوی خاموش‌شدن خودکار صفحه گرفته می‌شود.') : 'مرورگر این قابلیت را ندارد؛ زمان خاموشی صفحه را در تنظیمات گوشی بیشتر کن.'),
    wake.supported ? h('button', { class: 'btn', onclick: () => (ui.wakeOn ? wake.release() : wake.acquire()) }, ui.wakeOn ? 'غیرفعال کن' : 'فعال کن') : null,
    h('h3', {}, 'اتاق'),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn small', onclick: () => copy(`${location.origin}${location.pathname}#${v.code}`) }, 'کپی لینک اتاق'), h('button', { class: 'btn small', onclick: () => goHome() }, 'بازگشت به صفحه‌ی اصلی')),
    g && isHost() ? h('button', { class: 'btn evil small', onclick: () => confirm('بازی تمام شود و همه به اتاق انتظار برگردند؟') && (closeSheet(), act({ type: 'abort' })) }, 'پایان بازی و برگشت به اتاق انتظار') : null,
    !g ? h('button', { class: 'btn evil small', onclick: () => confirm('از اتاق خارج می‌شوی؟') && (act({ type: 'leave' }), clearCreds(v.code), store.set('avalon.lastRoom', ''), setTimeout(() => goHome(), 150)) }, 'ترک اتاق') : null,
  ];
}

// ------------------------------------------------------------------ canvas taps + resize
$('#table').addEventListener('click', (e) => {
  const r = e.target.getBoundingClientRect();
  const id = table.hitTest((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  if (id) onSeatTap(id);
});
let rz;
window.addEventListener('resize', () => {
  clearTimeout(rz);
  rz = setTimeout(() => {
    if (ui.view) {
      table.resize($('#table').parentElement.clientWidth);
      render();
    }
  }, 150);
});
table.onLayout = () => ui.view && renderSeats(ui.view);

// ------------------------------------------------------------------ boot
(function boot() {
  const hash = location.hash.replace(/^#\/?/, '').toUpperCase();
  const saved = store.get('avalon.lastRoom');
  const target = /^[A-Z]{4}$/.test(hash) ? hash : saved;
  if (target && loadCreds(target)) {
    // Page was reloaded/discarded by the OS: slide straight back into the seat.
    enterRoom(target, store.get('avalon.name') || '');
    return;
  }
  if (/^[A-Z]{4}$/.test(hash)) $('#code').value = hash;
  renderResume();
  show('home');
})();

// Wake lock needs a user gesture on some browsers; retry on the first tap.
document.addEventListener('pointerdown', () => ui.conn && !ui.wakeOn && wake.acquire(), { once: true });

// Handy from the browser console while developing.
window.__avalon = { ui, table };
