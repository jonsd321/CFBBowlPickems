import { CONFIG } from './config.js';
import { fetchBowls } from './espn.js';
import { createStore, nameKey } from './store.js';
import { headToHead, raceStatus } from './race.js';
import { bowlLogo, PLAYOFF_LOGO } from './bowl-logos.js';

const params = new URLSearchParams(location.search);
const SEASON = Number(params.get('season')) || CONFIG.season;
const VIEWS = ['bowls', 'leaderboard', 'race', 'commish', 'me'];

const state = {
  events: [],
  byId: new Map(),
  espnLoaded: false,
  espnError: null,
  user: null,
  players: [],
  picks: [],
  games: {},
  adminUid: null,
  dbReady: false,
  dbError: null,
  pending: new Map(), // eventId -> { teamId, token } while a save is in flight
  expanded: new Set(), // event ids with the "who picked what" list open
  filter: 'all',
  confirmRemove: null,
  raceTarget: null, // uid picked in the "Your race" panel
  raceShowOpen: false,
};

let store;
let pickToken = 0;
let syncing = false;
let syncBlockedUntil = 0;

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ---------- Derived state ---------- */

const currentView = () => {
  const v = location.hash.slice(1);
  return VIEWS.includes(v) ? v : 'bowls';
};
const playerName = uid => state.players.find(p => p.uid === uid)?.name;
const isAdmin = () => !!state.user && state.adminUid === state.user.uid;
const hasTeams = ev => !!(ev.away.id && ev.home.id);

// The server-side lock uses the synced kickoff; use whichever is earlier so the UI never
// offers a pick the server would refuse.
function lockTime(ev) {
  const g = state.games[ev.id];
  return g ? Math.min(g.kickoff, ev.kickoff) : ev.kickoff;
}
const started = ev => ev.state !== 'pre' || Date.now() >= lockTime(ev);

function synced(ev) {
  if (store.mode === 'demo') return true;
  const g = state.games[ev.id];
  return !!g && g.teams.includes(ev.away.id) && g.teams.includes(ev.home.id);
}

// open | tbd | waiting | locked | canceled
function pickStatus(ev) {
  if (ev.canceled) return 'canceled';
  if (started(ev)) return 'locked';
  if (!hasTeams(ev)) return 'tbd';
  if (!synced(ev)) return 'waiting';
  return 'open';
}

function picksFor(uid) {
  const m = new Map();
  for (const p of state.picks) if (p.uid === uid) m.set(p.eventId, p.teamId);
  return m;
}

function myPicks() {
  if (!state.user) return new Map();
  const m = picksFor(state.user.uid);
  for (const [eventId, { teamId }] of state.pending) teamId ? m.set(eventId, teamId) : m.delete(eventId);
  return m;
}

// Games still waiting on a result. open = can still be picked (hasn't kicked off).
function remainingGames() {
  return state.events
    .filter(ev => !ev.winnerId && !ev.canceled && !ev.completed)
    .map(ev => ({ ev, open: pickStatus(ev) !== 'locked' }));
}

function standings() {
  const rows = state.players.map(p => ({ ...p, picks: picksFor(p.uid), correct: 0, wrong: 0, pending: 0, max: 0 }));
  const remaining = remainingGames();
  for (const r of rows) {
    for (const ev of state.events) {
      const t = r.picks.get(ev.id);
      if (!ev.winnerId) continue;
      if (t === ev.winnerId) r.correct++;
      else if (t) r.wrong++;
    }
    for (const { ev, open } of remaining) {
      const t = r.picks.get(ev.id);
      if (t) r.pending++;
      if (t || open) r.max++;
    }
    r.max += r.correct;
  }
  rows.sort((a, b) => b.correct - a.correct || a.wrong - b.wrong || b.max - a.max || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.rank = i > 0 && rows[i - 1].correct === r.correct ? rows[i - 1].rank : i + 1; });
  const status = raceStatus(rows, remaining);
  for (const r of rows) Object.assign(r, status.get(r.uid), { back: rows[0].correct - r.correct });
  return { rows, remaining };
}

const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
const pts = n => plural(n, 'pt');

function pickSplit(ev) {
  const away = [];
  const home = [];
  for (const p of state.picks) {
    if (p.eventId !== ev.id) continue;
    const name = playerName(p.uid);
    if (!name) continue;
    if (p.teamId === ev.away.id) away.push(name);
    else if (p.teamId === ev.home.id) home.push(name);
  }
  return { away: away.sort(), home: home.sort(), total: away.length + home.length };
}

/* ---------- Formatting ---------- */

// ESPN parks "time TBD" games at midnight Eastern, so show their date in Eastern time.
const dayKey = ev => new Intl.DateTimeFormat(undefined, {
  weekday: 'long', month: 'long', day: 'numeric', timeZone: ev.timeTbd ? 'America/New_York' : undefined,
}).format(ev.kickoff);

const fmtTime = ms => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(ms);
const fmtWhen = ms => new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ms);

function fmtLock(ev) {
  if (ev.timeTbd) return 'locks at kickoff';
  const ms = lockTime(ev) - Date.now();
  if (ms < 60 * 60 * 1000) return `locks in ${Math.max(1, Math.round(ms / 60000))} min`;
  if (ms < 24 * 60 * 60 * 1000) return `locks in ${Math.round(ms / 3600000)} hr`;
  return `locks ${fmtWhen(lockTime(ev))}`;
}

/* ---------- Rendering ---------- */

const initials = name => name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
const signed = n => (n > 0 ? `+${n}` : n < 0 ? `&minus;${-n}` : '0');
const rankLabel = (r, rows) => (rows.filter(x => x.rank === r.rank).length > 1 ? `T${r.rank}` : String(r.rank));

// Team-color slabs need readable text and logos: dark text on light team colors, and ESPN's
// dark-background logo on dark ones (falling back to the regular logo if it's missing).
function isLight(color) {
  const n = parseInt(color.slice(1), 16);
  return 0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255) > 170;
}
function teamStyle(team) {
  if (!team.color || team.tbd) return '';
  return `--tc:${esc(team.color)};--tx:${isLight(team.color) ? '#0b0e1a' : '#fff'}`;
}
function teamLogo(team) {
  if (!team.logo) return `<span class="ph">${team.tbd ? '?' : esc((team.abbr || '?')[0])}</span>`;
  const useDark = team.logoDark && team.logoDark !== team.logo && !(team.color && isLight(team.color));
  if (!useDark) return `<img src="${esc(team.logo)}" alt="" loading="lazy">`;
  return `<img src="${esc(team.logoDark)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${esc(team.logo)}'">`;
}
const bowlChip = (ev, size = '') => (ev.logo
  ? `<span class="chiplogo ${size}"><img src="${esc(ev.logo)}" alt="" loading="lazy" onerror="this.parentNode.remove()"></span>` : '');
const teamById = (ev, id) => [ev.away, ev.home].find(t => t.id === id);

// Only touch the DOM when markup changes, so the ticker animation doesn't restart every render.
function setHTML(el, html) {
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
}

function render() {
  const view = currentView();
  renderHeader(view);
  document.querySelectorAll('.tab[data-view]').forEach(t => t.classList.toggle('is-active', t.dataset.view === view));
  const html = view === 'leaderboard' ? renderLeaderboard()
    : view === 'race' ? renderRaceView()
    : view === 'me' ? renderMe()
    : view === 'commish' && !$('#admin-tab').hidden ? renderCommish()
    : renderBowls();
  $('#view').innerHTML = html;
  const owe = view === 'bowls' ? renderOwe() : '';
  setHTML($('#owe'), owe);
  document.body.classList.toggle('has-owe', !!owe);
}

function renderHeader(view) {
  document.title = CONFIG.leagueName;
  $('#league-name').textContent = CONFIG.leagueName;
  const live = state.events.some(ev => ev.state === 'in');
  $('#season-label').textContent = live && view === 'bowls' ? 'Live' : `${SEASON}-${String(SEASON + 1).slice(2)} Bowls`;
  $('.bug').classList.toggle('live', live && view === 'bowls');

  const area = $('#user-area');
  if (state.user) {
    const name = playerName(state.user.uid) || '...';
    const { rows } = standings();
    const me = rows.find(r => r.uid === state.user.uid);
    const finals = state.events.some(ev => ev.winnerId);
    const rec = me && finals ? `<span>${me.correct}-${me.wrong} · <em>${rankLabel(me, rows)}</em></span>` : '';
    setHTML(area, `
      <button class="me" data-action="me" title="Your picks">${rec}<span class="me-name">${esc(name)}</span><span class="avatar">${esc(initials(name))}</span></button>
      <button class="btn ghost small" data-action="sign-out"><span>Sign out</span></button>`);
  } else {
    setHTML(area, `<button class="btn primary small" data-action="open-auth"><span>Join / Sign in</span></button>`);
  }

  $('#admin-tab').hidden = !(state.user && state.dbReady && (isAdmin() || !state.adminUid));
  setHTML($('#ticker'), renderTicker());

  const banners = [];
  if (store.mode === 'demo') banners.push(`<div class="banner">Demo mode: picks are saved only in this browser. Add your Firebase config in <code>js/config.js</code> to run a real league.</div>`);
  if (state.dbError) banners.push(`<div class="banner bad">${esc(state.dbError)}</div>`);
  if (state.espnError && state.events.length) banners.push(`<div class="banner bad">Couldn't refresh from ESPN (${esc(state.espnError)}). Showing the last scores loaded.</div>`);
  setHTML($('#banners'), banners.join(''));
}

// Live games, then today's finals, then what's next.
function renderTicker() {
  const now = Date.now();
  const live = state.events.filter(ev => ev.state === 'in');
  const finals = state.events.filter(ev => ev.state === 'post' && now - ev.kickoff < 30 * 3600 * 1000).reverse();
  const next = state.events.filter(ev => ev.state === 'pre' && ev.kickoff > now).slice(0, 6);
  const items = [
    ...live.map(ev => `<span><strong>${esc(ev.detail)}</strong>${esc(ev.away.abbr)} ${ev.away.score ?? 0} · ${esc(ev.home.abbr)} ${ev.home.score ?? 0}</span>`),
    ...finals.map(ev => `<span><em>Final</em>${esc(ev.away.abbr)} ${ev.away.score} · ${esc(ev.home.abbr)} ${ev.home.score}</span>`),
    ...next.map(ev => {
      const when = new Intl.DateTimeFormat(undefined, ev.timeTbd ? { month: 'short', day: 'numeric' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(ev.kickoff);
      return `<span><em>${esc(when)}</em>${hasTeams(ev) ? `${esc(ev.away.abbr)} vs ${esc(ev.home.abbr)}` : esc(ev.title)}</span>`;
    }),
  ];
  if (!items.length) return '';
  const run = items.join('');
  return `<div class="ticker" aria-label="Scores"><b>Scores</b><div class="ticker-track"><div class="ticker-run">${run}${run}</div></div></div>`;
}

// Mobile: a bar above the tabs. Desktop: a strip at the top of the Bowls page.
function renderOwe() {
  if (!state.user || !state.espnLoaded) return '';
  const mine = myPicks();
  const todo = state.events.filter(ev => pickStatus(ev) === 'open' && !mine.has(ev.id));
  if (!todo.length) return '';
  const first = todo.reduce((a, b) => (lockTime(b) < lockTime(a) ? b : a));
  const when = first.timeTbd ? 'at kickoff' : fmtWhen(lockTime(first));
  return `<div class="owe"><div><b>${plural(todo.length, 'pick')} left</b><small>${esc(first.title)} locks ${esc(when)}</small></div>
    <button class="btn small" data-action="filter" data-filter="todo"><span>Pick</span></button></div>`;
}

function renderBowls() {
  if (!state.espnLoaded) return `<div class="empty"><div class="spinner"></div>Loading bowl games from ESPN...</div>`;
  if (!state.events.length) {
    return state.espnError
      ? `<div class="empty">Couldn't load games from ESPN: ${esc(state.espnError)}<br><button class="btn" data-action="refresh"><span>Try again</span></button></div>`
      : `<div class="empty">ESPN hasn't posted the ${SEASON} bowl schedule yet. Check back after the regular season.</div>`;
  }

  const mine = myPicks();
  const todo = state.events.filter(ev => pickStatus(ev) === 'open' && !mine.has(ev.id));
  const live = state.events.filter(ev => ev.state === 'in');
  const counts = {
    all: state.events.length,
    todo: todo.length,
    upcoming: state.events.filter(ev => ev.state === 'pre').length,
    live: live.length,
    final: state.events.filter(ev => ev.state === 'post').length,
  };
  const filters = [
    ['all', 'All'],
    ...(state.user ? [['todo', 'Need a pick']] : []),
    ...(counts.live ? [['live', 'Live']] : []),
    ['upcoming', 'Upcoming'],
    ['final', 'Final'],
  ];
  if (!filters.some(([k]) => k === state.filter)) state.filter = 'all';

  // Live games lead as the hero on All and Live; they aren't repeated in the day lists.
  const showHero = (state.filter === 'all' || state.filter === 'live') && live.length;
  const shown = state.events.filter(ev => ({
    all: ev.state !== 'in',
    todo: pickStatus(ev) === 'open' && !mine.has(ev.id),
    upcoming: ev.state === 'pre',
    live: false,
    final: ev.state === 'post',
  })[state.filter]);

  const groups = [];
  for (const ev of shown) {
    const key = dayKey(ev);
    if (groups.at(-1)?.key !== key) groups.push({ key, events: [] });
    groups.at(-1).events.push(ev);
  }

  const join = !state.user ? `
    <div class="joinbar"><div><b>Pick the winner of every bowl</b><p>One point per correct pick. Picks lock at kickoff.</p></div>
      <button class="btn primary" data-action="open-auth"><span>Join the pool</span></button></div>` : '';

  return `
    ${join}
    ${showHero ? `<section class="stack"><h2 class="label">Live now</h2><div class="heroes ${live.length > 1 ? 'two' : ''}">${live.map(ev => heroCard(ev, mine)).join('')}</div></section>` : ''}
    <div class="stack">
      <div class="chips sticky" role="group" aria-label="Filter games">
        ${filters.map(([k, label]) => `<button class="chip ${state.filter === k ? 'is-active' : ''} ${k === 'todo' && counts.todo ? 'alert' : ''}" data-action="filter" data-filter="${k}"><span>${label}<em> ${counts[k]}</em></span></button>`).join('')}
      </div>
      ${groups.length ? groups.map(g => `
        <section class="day">
          <h2 class="label">${esc(g.key)}${dayNote(g.events, mine)}</h2>
          <div class="tiles">${g.events.map(ev => gameTile(ev, mine)).join('')}</div>
        </section>`).join('')
      : `<div class="empty">${state.filter === 'todo' ? "You're all caught up. Every open game has a pick." : state.filter === 'live' ? 'No games are live right now.' : 'Nothing here.'}</div>`}
    </div>`;
}

function dayNote(events, mine) {
  if (events.every(ev => ev.state === 'post')) return '<span>Final</span>';
  const open = events.filter(ev => pickStatus(ev) === 'open');
  if (!open.length) return '';
  const left = open.filter(ev => !mine.has(ev.id)).length;
  return `<span>${state.user && left ? `${left} to pick` : 'Picks open'}</span>`;
}

// One-line context for a live game: what it means against the player you're chasing.
function raceNote(ev, myTeam) {
  if (!state.user || !myTeam) return '';
  const { rows } = standings();
  const me = rows.find(r => r.uid === state.user.uid);
  if (!me || rows.length < 2) return '';
  const above = rows.filter(r => r.correct > me.correct);
  const rival = above.length ? above.reduce((a, b) => (b.correct < a.correct ? b : a)) : rows.find(r => r !== me);
  const theirs = rival.picks.get(ev.id);
  const mineTeam = teamById(ev, myTeam);
  if (!theirs) return `<p class="hero-note">${esc(rival.name)} didn't pick this one. <strong>A ${esc(mineTeam.name)} win is +1 on them.</strong></p>`;
  if (theirs === myTeam) return `<p class="hero-note">${esc(rival.name)} also picked ${esc(mineTeam.name)}, so this one can't change your race.</p>`;
  const gap = rival.correct - me.correct;
  const effect = gap > 0 ? (gap === 1 ? 'pulls you even' : `cuts the gap to ${gap - 1}`) : 'puts you 1 further ahead';
  return `<p class="hero-note">${esc(rival.name)} picked ${esc(teamById(ev, theirs).name)}. <strong>A ${esc(mineTeam.name)} win ${effect}.</strong></p>`;
}

function heroCard(ev, mine) {
  const myTeam = mine.get(ev.id);
  const split = pickSplit(ev);
  const other = t => (t === ev.away ? ev.home : ev.away);
  const half = (t, side) => `
    <div class="hero-half ${side} ${(t.score ?? 0) < (other(t).score ?? 0) ? 'trail' : ''}" style="${teamStyle(t)}">
      ${side === 'away' ? teamLogo(t) : ''}
      <div><small>${[t.rank && `#${t.rank}`, t.record].filter(Boolean).join(' · ')}</small><b>${esc(t.name)}</b>${myTeam && myTeam === t.id ? '<span class="ptag">YOUR PICK</span>' : ''}</div>
      <strong>${t.score ?? 0}</strong>
      ${side === 'home' ? teamLogo(t) : ''}
    </div>`;
  return `
    <article class="hero">
      <div class="hero-sides">
        ${half(ev.away, 'away')}
        <div class="clock"><b>${esc(ev.detail || 'Live')}</b><small>${esc(ev.tv || 'Live')}</small></div>
        ${half(ev.home, 'home')}
      </div>
      <div class="hero-info">
        <div class="hero-bowl">${bowlChip(ev)}<div>${ev.url ? `<a href="${esc(ev.url)}" target="_blank" rel="noopener">${esc(ev.title)}</a>` : esc(ev.title)}<small>${esc([ev.round, ev.venue].filter(Boolean).join(' · '))}</small></div></div>
        ${split.total ? splitBar(ev, split, myTeam) : ''}
        ${raceNote(ev, myTeam)}
      </div>
    </article>`;
}

function splitBar(ev, split, myTeam) {
  const pct = Math.round((split.away.length / split.total) * 100);
  const lbl = (t, p) => `<span class="split-lbl ${myTeam === t.id ? 'mine' : ''}">${esc(t.abbr)} ${p}%</span>`;
  return `
    <button class="split" data-action="toggle-split" data-event="${ev.id}" aria-expanded="${state.expanded.has(ev.id)}" title="See who picked what"
      style="--a:${esc(ev.away.color || '#8b92aa')};--b:${esc(ev.home.color || '#3a4150')}">
      ${lbl(ev.away, pct)}<span class="bar"><span style="width:${pct}%"></span></span>${lbl(ev.home, 100 - pct)}
    </button>`;
}

function statusTag(ev) {
  if (ev.canceled) return `<span class="st fin">Canceled</span>`;
  if (ev.state === 'in') return `<span class="st live"><i></i>${esc(ev.detail || 'Live')}</span>`;
  if (ev.state === 'post') return `<span class="st fin">${esc(ev.detail || 'Final')}</span>`;
  return `<span class="st">${ev.timeTbd ? 'Time TBD' : esc(fmtTime(ev.kickoff))}</span>`;
}

function gameTile(ev, mine) {
  const status = pickStatus(ev);
  const myTeam = mine.get(ev.id);
  const canPick = status === 'open' && !!state.user;
  const split = status === 'locked' && hasTeams(ev) ? pickSplit(ev) : null;
  const sub = [ev.round && `<span class="round">${esc(ev.round)}</span>`, esc([ev.city || ev.venue, ev.tv].filter(Boolean).join(' · '))].filter(Boolean).join(' · ');

  let foot = '';
  if (status === 'open') {
    foot = `<span>${esc(fmtLock(ev))}</span>${!state.user ? `<button class="link" data-action="open-auth">Sign in to pick</button>`
      : myTeam ? '<span>Pick saved</span>' : '<span class="need">Tap a team</span>'}`;
  } else if (status === 'tbd') {
    foot = '<span>Matchup not set yet</span>';
  } else if (status === 'waiting') {
    foot = '<span>Picks open once the commissioner syncs this game</span>';
  } else if (status === 'canceled') {
    foot = '<span>Canceled · no points</span>';
  } else if (split) {
    foot = split.total ? splitBar(ev, split, myTeam) : '<span>No picks were made</span>';
    if (state.user && !myTeam && !ev.winnerId) foot += '<span>You didn\'t pick this one</span>';
  }

  const who = split?.total && state.expanded.has(ev.id) ? `
    <div class="who">${[ev.away, ev.home].map(t => `<div><h4>${esc(t.name)}</h4><p>${(t === ev.away ? split.away : split.home).map(esc).join(', ') || '-'}</p></div>`).join('')}</div>` : '';

  return `
    <article class="tile" data-event="${ev.id}">
      <header class="tile-head">
        ${bowlChip(ev)}
        <div class="tile-title"><b>${ev.url ? `<a href="${esc(ev.url)}" target="_blank" rel="noopener">${esc(ev.title)}</a>` : esc(ev.title)}</b><small>${sub}</small></div>
        ${statusTag(ev)}
      </header>
      ${teamBand(ev, ev.away, myTeam, canPick)}
      ${teamBand(ev, ev.home, myTeam, canPick)}
      ${foot ? `<footer class="tile-foot">${foot}</footer>` : ''}
      ${who}
    </article>`;
}

function teamBand(ev, team, myTeam, canPick) {
  const picked = !!team.id && myTeam === team.id;
  const decided = !!ev.winnerId;
  const showScore = ev.state !== 'pre' && team.score != null && !team.tbd;
  const tag = canPick && team.id ? 'button' : 'div';
  const attrs = tag === 'button'
    ? `type="button" data-action="pick" data-event="${ev.id}" data-team="${esc(team.id)}" aria-pressed="${picked}" aria-label="Pick ${esc(team.fullName)}"`
    : '';
  let tagEl = '';
  if (picked) tagEl = !decided ? '<i class="tag">PICK</i>' : team.id === ev.winnerId ? '<i class="tag won">+1</i>' : '<i class="tag lost">MISS</i>';
  const classes = ['band', team.tbd && 'tbd', decided && team.id !== ev.winnerId && 'lose', tagEl && 'has-tag'].filter(Boolean).join(' ');
  return `
    <${tag} class="${classes}" style="${teamStyle(team)}" ${attrs}>
      ${teamLogo(team)}
      <span class="band-name"><b>${team.rank ? `<em>${team.rank}</em>` : ''}${esc(team.name)}</b>${team.record ? `<small>${esc(team.record)}</small>` : ''}</span>
      ${showScore ? `<strong>${team.score}</strong>` : ''}
      ${tagEl}
    </${tag}>`;
}

function statusBadge(r, remaining) {
  if (!remaining.length && r.rank === 1) return '<span class="status champ">Champion</span>';
  if (r.clinched && remaining.length) return `<span class="status champ">${r.outright ? 'Clinched' : 'Clinched tie'}</span>`;
  if (!r.alive) return '<span class="status out">Out</span>';
  return '';
}

function renderLeaderboard() {
  const { rows, remaining } = standings();
  const finals = state.events.filter(ev => ev.winnerId).length;
  const total = state.events.filter(ev => !ev.canceled).length;
  if (!rows.length) {
    return `<div class="empty">No one has joined yet.${state.user ? '' : `<br><button class="btn primary" data-action="open-auth"><span>Be the first</span></button>`}</div>`;
  }
  const me = state.user && rows.find(r => r.uid === state.user.uid);
  let teaser = '';
  if (me && rows.length > 1) {
    const target = raceTarget(me, rows);
    const h = headToHead(me, target, remaining);
    const gap = h.gap < 0 ? `${-h.gap} back` : h.gap > 0 ? `${h.gap} ahead` : 'tied';
    teaser = `<button class="teaser" data-action="go-race"><div><b>Your race vs ${esc(target.name)}</b><small>${gap} · ${remaining.length ? `${plural(h.swing.length, 'game')} can still change it` : 'final'}</small></div><span>›</span></button>`;
  }
  return `
    <section class="stack">
      <div class="board-head"><h2>Standings</h2><small>${finals} of ${total} final</small></div>
      <div class="scols"><span>#</span><span>Player</span><span>W-L</span><span>Back</span><span class="hide-sm">Pct</span><span class="hide-sm">Pending</span><span class="hide-sm" title="Most points still possible">Max</span></div>
      <div class="srows">
        ${rows.map(r => {
          const played = r.correct + r.wrong;
          const pct = played ? (r.correct / played).toFixed(3).replace(/^0/, '') : '-';
          const isMe = state.user?.uid === r.uid;
          return `<button class="srow ${isMe ? 'me' : ''} ${r.rank === 1 && finals ? 'lead' : ''} ${r.alive ? '' : 'out'}" data-action="player" data-uid="${esc(r.uid)}">
            <span class="rk">${rankLabel(r, rows)}</span>
            <span class="nm"><span>${esc(r.name)}</span>${isMe ? '<i class="you">YOU</i>' : ''}${statusBadge(r, remaining)}</span>
            <span>${r.correct}-${r.wrong}</span><span class="dimc">${r.back || '-'}</span>
            <span class="dimc hide-sm">${pct}</span><span class="dimc hide-sm">${r.pending}</span><span class="hide-sm">${r.max}</span>
          </button>`;
        }).join('')}
      </div>
      ${teaser}
      <p class="fine">Tap a player to see their picks. Picks stay hidden until kickoff. <strong>Out</strong> means no remaining results can put that player in first.</p>
    </section>`;
}

// Default comparison: the player just ahead of you, or the one just behind if you lead.
function raceTarget(me, rows) {
  const others = rows.filter(r => r !== me);
  const picked = others.find(r => r.uid === state.raceTarget);
  if (picked) return picked;
  const above = rows.filter(r => r.correct > me.correct);
  return above.length ? above.reduce((a, b) => (b.correct < a.correct ? b : a)) : others[0];
}

function renderRaceView() {
  if (!state.user) {
    return `<div class="empty">Sign in to see how you stack up against everyone else.<br><button class="btn primary" data-action="open-auth"><span>Join / Sign in</span></button></div>`;
  }
  const { rows, remaining } = standings();
  const me = rows.find(r => r.uid === state.user.uid);
  if (!me || rows.length < 2) return `<div class="empty">Your race starts once someone else joins the pool.</div>`;
  const others = rows.filter(r => r !== me);
  const target = raceTarget(me, rows);
  const h = headToHead(me, target, remaining);
  const them = esc(target.name);

  let verdict;
  if (!remaining.length) verdict = h.gap < 0 ? `Final: ${them} finished ${pts(-h.gap)} ahead of you.` : h.gap > 0 ? `Final: you finished ${pts(h.gap)} ahead of ${them}.` : `Final: you and ${them} finished tied.`;
  else if (h.best < 0) verdict = `You can't catch ${them} anymore. Even if every swing game goes your way, you finish ${pts(-h.best)} behind.`;
  else if (h.best === 0) verdict = `You can only tie ${them} now, and only if every swing game goes your way.`;
  else if (h.gap < 0) verdict = `You can still catch ${them}. Come out ${-h.gap} ahead on the swing games to tie, ${1 - h.gap} ahead to pass.`;
  else if (h.gap === 0) verdict = `Dead even. Whoever does better on the swing games finishes ahead.`;
  else if (h.worst > 0) verdict = `${them} can't catch you anymore.`;
  else if (h.worst === 0) verdict = `${them} can only tie you now, and only by winning every swing game.`;
  else verdict = `You lead by ${pts(h.gap)}. ${them} needs to come out ${h.gap} ahead on the swing games to tie.`;

  const status = !remaining.length ? ''
    : me.clinched ? `<span class="status champ">${me.outright ? 'Clinched 1st' : 'Clinched a tie for 1st'}</span>`
    : me.alive ? '<span class="status alive">Still alive for 1st</span>'
    : '<span class="status out">Out of 1st</span>';

  const pickCell = (ev, teamId, hidden) => {
    if (hidden) return '<span class="pk dimc">Hidden</span>';
    if (!teamId) return `<span class="pk dimc">${hasTeams(ev) ? 'No pick' : 'TBD'}</span>`;
    const team = teamById(ev, teamId);
    return `<span class="pk">${team?.logo ? `<img src="${esc(team.logo)}" alt="">` : ''}${esc(team?.abbr || '?')}</span>`;
  };
  const openSwing = h.swing.filter(s => s.open);
  const listed = state.raceShowOpen || openSwing.length <= 5 ? h.swing : h.swing.filter(s => !s.open);
  const when = ev => ev.state === 'in' ? `<span class="live-dot"></span>${esc(ev.detail)}`
    : ev.timeTbd ? 'Time TBD' : esc(fmtWhen(ev.kickoff));

  return `
    <section class="race">
      <div class="board-head"><h2>Your race</h2>${status}</div>
      <div class="opps" role="group" aria-label="Compare with">
        ${others.map(r => `<button class="chip ${r === target ? 'is-active' : ''}" data-action="race-target" data-uid="${esc(r.uid)}"><span>${esc(r.name)}<em> ${signed(r.correct - me.correct)}</em></span></button>`).join('')}
      </div>
      <div class="vs">
        <div class="vs-side"><small>${rankLabel(me, rows)} · You</small><b>${esc(me.name)}</b><strong>${me.correct}</strong></div>
        <div class="vs-side them"><small>${rankLabel(target, rows)}</small><b>${them}</b><strong>${target.correct}</strong></div>
        <div class="vs-gap"><span>${h.gap < 0 ? `${-h.gap} back` : h.gap > 0 ? `${h.gap} ahead` : 'Tied'}</span></div>
      </div>
      <div class="stats">
        <div><b>${h.swing.length}</b><small>Swing games</small></div>
        <div><b>${signed(h.best)}</b><small>Best case</small></div>
        <div><b>${signed(h.worst)}</b><small>Worst case</small></div>
      </div>
      <p class="verdict ${h.best < 0 && remaining.length ? 'bad' : ''}">${verdict}</p>
      ${h.swing.length ? `
        <div class="swing">
          <div class="swing-head"><span>Games that can change it</span><span>You</span><span>${them}</span></div>
          ${listed.map(s => `
            <div class="sw">
              <span class="game">${bowlChip(s.ev, 'sm')}<div><b>${esc(s.ev.title)}</b><small>${when(s.ev)}${s.open ? ' · open' : ''}</small></div></span>
              ${pickCell(s.ev, s.a, false)}
              ${pickCell(s.ev, s.b, s.open)}
            </div>`).join('')}
          ${listed.length < h.swing.length ? `<button class="link more" data-action="race-open">+ ${plural(openSwing.length, 'more game')} that haven't kicked off</button>` : ''}
        </div>` : ''}
      <p class="fine">Best and worst case are the final margin between you two${h.same ? `. ${plural(h.same, 'game')} in progress can't change it because you both picked the same team` : ''}. Their picks stay hidden until kickoff, so games that haven't started count as swing games.</p>
    </section>`;
}

function renderCommish() {
  if (store.mode === 'firebase' && !state.adminUid) {
    return `
      <section class="panel">
        <h2>Become the commissioner</h2>
        <p>The commissioner's visits copy kickoff times and matchups from ESPN into the database. The server uses those times to lock picks. Only one person can claim this, and it can't be undone from the site.</p>
        <div><button class="btn primary" data-action="claim-admin"><span>Claim commissioner</span></button></div>
      </section>`;
  }

  const withTeams = state.events.filter(hasTeams);
  const need = gamesNeedingSync();
  const tbd = state.events.length - withTeams.length;
  const counts = new Map();
  for (const p of state.picks) counts.set(p.uid, (counts.get(p.uid) || 0) + 1);

  return `
    <section class="panel">
      <h2>Sync with ESPN</h2>
      ${store.mode === 'demo'
        ? `<p>In demo mode games open straight from ESPN, so there's nothing to sync.</p>`
        : `<p>${plural(withTeams.length - need.length, 'game')} synced and open to picks. ${need.length ? `<strong>${plural(need.length, 'game')} need syncing.</strong>` : 'Everything is up to date.'} ${tbd ? `${plural(tbd, 'game')} still have TBD teams.` : ''}</p>
           <p class="fine">This syncs automatically whenever you have the site open. Visit after selection day and after each CFP round so new matchups open for picks.</p>
           <div><button class="btn primary" data-action="sync" ${need.length && !syncing ? '' : 'disabled'}><span>${syncing ? 'Syncing...' : 'Sync now'}</span></button></div>`}
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Players</h2><p>${plural(state.players.length, 'player')}</p></div>
      <ul class="plist">
        ${state.players.slice().sort((a, b) => a.name.localeCompare(b.name)).map(p => `
          <li><span class="avatar sm">${esc(initials(p.name))}</span><span class="grow">${esc(p.name)}</span>
            <span class="muted">${plural(counts.get(p.uid) || 0, 'pick')}</span>
            ${p.uid === state.user.uid ? '' : `<button class="btn ghost small ${state.confirmRemove === p.uid ? 'danger' : ''}" data-action="remove-player" data-uid="${esc(p.uid)}"><span>${state.confirmRemove === p.uid ? 'Confirm remove' : 'Remove'}</span></button>`}
          </li>`).join('')}
      </ul>
      <p class="fine">Removing a player hides them from the standings. To reset someone's PIN, delete their account under Authentication in the Firebase console, and they can join again with the same name.</p>
    </section>
    ${store.mode === 'demo' ? `
      <section class="panel">
        <h2>Demo tools</h2>
        <p>Add made-up players with random picks to see the standings in action. Try <a class="link" href="?season=${SEASON - 1}">last season</a> for a finished bracket.</p>
        <div class="row"><button class="btn primary" data-action="seed"><span>Add sample players</span></button><button class="btn ghost" data-action="reset-demo"><span>Reset demo data</span></button></div>
      </section>` : ''}`;
}

// One row per game with the player's pick. Other players' picks stay hidden until kickoff.
function pickItems(events, picks, self) {
  return events.map(ev => {
    const t = picks.get(ev.id);
    const visible = self || started(ev);
    let pick;
    if (!t) {
      const open = pickStatus(ev) === 'open';
      pick = self && open ? `<button class="link" data-action="filter" data-filter="todo">Pick now</button>`
        : `<span class="muted">${!hasTeams(ev) && !ev.winnerId ? 'Matchup TBD' : 'No pick'}</span>`;
    } else if (!visible) pick = `<span class="muted">Hidden until kickoff</span>`;
    else {
      const team = teamById(ev, t);
      const mark = ev.winnerId ? (t === ev.winnerId ? '<span class="mark win">W</span>' : '<span class="mark loss">L</span>') : '';
      pick = `${team?.logo ? `<img src="${esc(team.logo)}" alt="">` : ''}<span>${esc(team?.abbr || '?')}</span>${mark}`;
    }
    const when = ev.state === 'in' ? `<span class="live-dot"></span>${esc(ev.detail)}`
      : ev.state === 'post' ? 'Final' : ev.timeTbd ? 'Time TBD' : esc(fmtWhen(ev.kickoff));
    return `<li>${bowlChip(ev, 'sm')}<span class="grow game"><div><b>${esc(ev.title)}</b><small>${hasTeams(ev) ? `${esc(ev.away.abbr)} vs ${esc(ev.home.abbr)} · ` : ''}${when}</small></div></span><span class="pd-pick">${pick}</span></li>`;
  }).join('');
}

function renderMe() {
  if (!state.user) {
    return `<div class="empty">Join the pool to make picks and see your record here.<br><button class="btn primary" data-action="open-auth"><span>Join / Sign in</span></button></div>`;
  }
  const name = playerName(state.user.uid) || '...';
  const { rows } = standings();
  const me = rows.find(r => r.uid === state.user.uid);
  const mine = myPicks();
  const pickable = state.events.filter(ev => hasTeams(ev) && !ev.canceled);
  const picked = pickable.filter(ev => mine.has(ev.id)).length;
  const todo = state.events.filter(ev => pickStatus(ev) === 'open' && !mine.has(ev.id)).length;
  const played = me ? me.correct + me.wrong : 0;

  return `
    <section class="stack me-page">
      <div class="profile">
        <span class="avatar lg">${esc(initials(name))}</span>
        <div class="grow"><h2>${esc(name)}</h2>${me ? `<small>${rankLabel(me, rows)} of ${rows.length} · ${me.correct}-${me.wrong}</small>` : ''}</div>
        <button class="btn ghost small" data-action="sign-out"><span>Sign out</span></button>
      </div>
      ${me ? `
        <div class="stats four">
          <div><b>${me.correct}-${me.wrong}</b><small>Record</small></div>
          <div><b>${played ? `${Math.round((me.correct / played) * 100)}%` : '-'}</b><small>Correct</small></div>
          <div><b>${me.back ? `${me.back}` : '-'}</b><small>Back of 1st</small></div>
          <div><b>${me.max}</b><small>Max possible</small></div>
        </div>` : ''}
      ${todo ? `<button class="teaser" data-action="filter" data-filter="todo"><div><b>${plural(todo, 'game')} need a pick</b><small>Tap to see them on the Bowls page</small></div><span>›</span></button>` : ''}
      <h2 class="label">Your picks<span>${picked} of ${pickable.length}</span></h2>
      ${state.espnLoaded ? `<ul class="pd-list">${pickItems(state.events, mine, true)}</ul>` : `<div class="empty"><div class="spinner"></div>Loading games...</div>`}
    </section>`;
}

function renderPlayerDialog(uid) {
  const name = playerName(uid) || 'Player';
  const self = uid === state.user?.uid;
  const picks = self ? myPicks() : picksFor(uid);
  const { rows, remaining } = standings();
  const row = rows.find(r => r.uid === uid);
  const meRow = !self && state.user && rows.find(r => r.uid === state.user.uid);
  let vs = '';
  if (row && meRow) {
    const h = headToHead(meRow, row, remaining);
    const gap = h.gap < 0 ? `you're ${pts(-h.gap)} behind` : h.gap > 0 ? `you're ${pts(h.gap)} ahead` : `you're tied`;
    const outlook = !remaining.length ? 'final'
      : h.best < 0 ? "you can't catch them"
      : h.worst > 0 ? "they can't catch you"
      : `${plural(h.swing.length, 'swing game')} left`;
    vs = `<button class="vs-line" data-action="race-target" data-uid="${esc(uid)}">You vs ${esc(name)}: ${gap} · ${outlook}<span>Breakdown ›</span></button>`;
  }
  const items = pickItems(state.events, picks, self);
  $('#player-dialog').innerHTML = `
    <div class="sheet-head">
      <div><h2>${esc(name)}</h2>${row ? `<p class="muted">${row.correct}-${row.wrong} · ${rankLabel(row, rows)} of ${state.players.length}</p>` : ''}</div>
      <div class="sheet-actions">
        ${self ? '<button class="btn ghost small" data-action="sign-out"><span>Sign out</span></button>' : ''}
        <button class="btn small" data-action="close-dialog"><span>Close</span></button>
      </div>
    </div>
    ${vs}
    <ul class="pd-list">${items}</ul>`;
}

/* ---------- Actions ---------- */

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.className = 'toast'; }, 3500);
}

async function makePick(eventId, teamId) {
  const ev = state.byId.get(eventId);
  if (!state.user) return openAuth('join');
  if (!ev || pickStatus(ev) !== 'open') return toast('Picks for this game are locked.', 'bad');
  const next = myPicks().get(eventId) === teamId ? null : teamId;
  const token = ++pickToken;
  state.pending.set(eventId, { teamId: next, token });
  render();
  try {
    await store.setPick(state.user.uid, eventId, next, SEASON);
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    if (state.pending.get(eventId)?.token === token) state.pending.delete(eventId);
    render();
  }
}

function gamesNeedingSync() {
  return state.events
    .filter(hasTeams)
    .filter(ev => {
      const g = state.games[ev.id];
      return !g || g.kickoff !== ev.kickoff || !g.teams.includes(ev.away.id) || !g.teams.includes(ev.home.id);
    })
    .map(ev => ({ id: ev.id, name: ev.title, kickoff: ev.kickoff, teams: [ev.away.id, ev.home.id] }));
}

async function syncGames({ manual = false } = {}) {
  if (store.mode !== 'firebase' || !isAdmin() || !state.dbReady || !state.espnLoaded || syncing) return;
  if (!manual && Date.now() < syncBlockedUntil) return;
  const todo = gamesNeedingSync();
  if (!todo.length) return;
  syncing = true;
  render();
  try {
    await store.syncGames(SEASON, todo);
    toast(`Synced ${plural(todo.length, 'game')} from ESPN`);
  } catch (err) {
    syncBlockedUntil = Date.now() + 5 * 60 * 1000;
    toast(`Sync failed: ${err.message}`, 'bad');
  } finally {
    syncing = false;
    render();
  }
}

function openAuth(mode = 'join') {
  const dlg = $('#auth-dialog');
  setAuthMode(mode);
  $('#auth-error').hidden = true;
  $('#google-area').hidden = store.mode !== 'firebase'; // Google sign-in needs the real backend
  dlg.showModal();
}

function setAuthMode(mode) {
  const form = $('#auth-form');
  form.dataset.mode = mode;
  form.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('is-active', b.dataset.mode === mode));
  form.querySelector('[type=submit]').innerHTML = `<span>${mode === 'join' ? 'Join the pool' : 'Sign in'}</span>`;
  form.querySelector('input[name=password]').autocomplete = mode === 'join' ? 'new-password' : 'current-password';
  $('#auth-hint').textContent = mode === 'join'
    ? 'Choose the name everyone will see in the standings and a password of at least 8 characters. You\'ll need both to sign in on another device.'
    : 'Use the name and password you joined with. If you joined with a PIN, enter the PIN.';
}

// Names are unique across Google and password accounts (same rules as store's nameKey).
const nameTaken = (name, exceptUid) => state.players.some(p => p.uid !== exceptUid && nameKey(p.name) === nameKey(name));

async function submitAuth(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const data = new FormData(form);
  const btn = form.querySelector('[type=submit]');
  const err = $('#auth-error');
  btn.disabled = true;
  err.hidden = true;
  state.authBusy = true;
  try {
    if (form.dataset.mode === 'join') {
      if (nameTaken(data.get('name'))) throw new Error('That name is taken. Sign in instead, or choose a different name.');
      await store.join(data.get('name'), data.get('password'));
    } else {
      await store.signIn(data.get('name'), data.get('password'));
    }
    form.reset();
    $('#auth-dialog').close();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    state.authBusy = false;
    btn.disabled = false;
    checkNeedsName();
  }
}

async function googleSignIn() {
  const err = $('#auth-error');
  err.hidden = true;
  state.authBusy = true;
  try {
    const result = await store.signInWithGoogle();
    if (result.cancelled) return;
    $('#auth-dialog').close();
    if (result.needsName) openNameDialog(result.suggested);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    state.authBusy = false;
  }
}

// Shown after a first Google sign-in, or whenever a signed-in account has no standings entry.
function openNameDialog(suggested = '') {
  const dlg = $('#name-dialog');
  if (dlg.open) return;
  const input = $('#name-input');
  input.value = suggested.trim().slice(0, 20);
  $('#name-error').hidden = true;
  dlg.showModal();
  input.select();
}

function checkNeedsName() {
  if (!state.user || !state.dbReady || state.authBusy || store.mode !== 'firebase') return;
  if (!state.players.some(p => p.uid === state.user.uid)) openNameDialog();
}

async function submitName(e) {
  e.preventDefault();
  const name = $('#name-input').value;
  const err = $('#name-error');
  const btn = e.currentTarget.querySelector('[type=submit]');
  err.hidden = true;
  btn.disabled = true;
  try {
    if (nameTaken(name, state.user.uid)) throw new Error('That name is taken. Choose a different one.');
    await store.setName(state.user.uid, name);
    $('#name-dialog').close();
    toast(`Welcome, ${name.trim()}!`);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

async function handleClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action } = el.dataset;
  if (action !== 'remove-player' && state.confirmRemove) { state.confirmRemove = null; render(); }

  switch (action) {
    case 'pick': return makePick(el.dataset.event, el.dataset.team);
    case 'filter': {
      state.filter = el.dataset.filter;
      const leaving = currentView() !== 'bowls';
      if (leaving) location.hash = 'bowls';
      render();
      if (leaving) window.scrollTo({ top: 0 });
      else if (el.closest('#owe')) document.querySelector('.chips.sticky')?.scrollIntoView({ block: 'start' });
      return;
    }
    case 'open-auth': return openAuth('join');
    case 'google': return googleSignIn();
    case 'me':
      location.hash = 'me';
      return window.scrollTo({ top: 0 });
    case 'sign-out':
      el.closest('dialog')?.close();
      return store.signOut();
    case 'go-race':
      location.hash = 'race';
      return window.scrollTo({ top: 0 });
    case 'refresh': return loadEspn();
    case 'close-dialog': return el.closest('dialog').close();
    case 'toggle-split': {
      const id = el.dataset.event;
      state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
      return render();
    }
    case 'player': {
      if (el.dataset.uid === state.user?.uid) {
        location.hash = 'me';
        return window.scrollTo({ top: 0 });
      }
      renderPlayerDialog(el.dataset.uid);
      return $('#player-dialog').showModal();
    }
    case 'race-target': {
      state.raceTarget = el.dataset.uid;
      el.closest('dialog')?.close();
      if (currentView() !== 'race') {
        location.hash = 'race';
        window.scrollTo({ top: 0 });
      }
      return render();
    }
    case 'race-open': state.raceShowOpen = true; return render();
    case 'claim-admin':
      try {
        await store.claimAdmin(state.user.uid);
        toast('You are the commissioner.');
      } catch (err) {
        toast(err.message, 'bad');
      }
      return;
    case 'sync': return syncGames({ manual: true });
    case 'remove-player': {
      const uid = el.dataset.uid;
      if (state.confirmRemove !== uid) { state.confirmRemove = uid; return render(); }
      state.confirmRemove = null;
      try {
        await store.removePlayer(uid);
      } catch (err) {
        toast(err.message, 'bad');
      }
      return;
    }
    case 'seed':
      store.seed(state.events, SEASON);
      return toast('Added sample players.');
    case 'reset-demo':
      store.reset();
      return toast('Demo data cleared.');
  }
}

/* ---------- Data loading ---------- */

async function loadEspn() {
  try {
    const events = await fetchBowls(SEASON, CONFIG.espnGroup);
    for (const ev of events) ev.logo = bowlLogo(ev.title, CONFIG.bowlLogos) || (ev.cfp ? PLAYOFF_LOGO : '');
    state.events = events;
    state.byId = new Map(events.map(ev => [ev.id, ev]));
    state.espnError = null;
  } catch (err) {
    state.espnError = err.message || 'network error';
  }
  state.espnLoaded = true;
  state.lastFetch = Date.now();
  render();
  syncGames();
}

async function main() {
  try {
    store = await createStore(CONFIG, { forceDemo: params.has('demo') });
  } catch (err) {
    console.error(err);
    $('#banners').innerHTML = `<div class="banner bad">Couldn't start Firebase: ${esc(err.message)}. Check js/config.js.</div>`;
    return;
  }

  document.addEventListener('click', handleClick);
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('tr[data-action]')) handleClick(e);
  });
  $('#auth-form').addEventListener('submit', submitAuth);
  $('#name-form').addEventListener('submit', submitName);
  // A standings name is required; Esc doesn't dismiss the prompt (Sign out does).
  $('#name-dialog').addEventListener('cancel', e => e.preventDefault());
  $('#auth-form').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (b) setAuthMode(b.dataset.mode);
  });
  window.addEventListener('hashchange', render);

  store.onUser(user => {
    state.user = user;
    state.pending.clear();
    if (!user && $('#name-dialog').open) $('#name-dialog').close();
    render();
    syncGames();
    checkNeedsName();
  });
  store.subscribe(SEASON, data => {
    Object.assign(state, data, { dbReady: data.ready, dbError: null });
    render();
    syncGames();
    checkNeedsName();
  }, err => {
    state.dbError = err.code === 'permission-denied'
      ? 'The database refused access. Make sure the rules in firestore.rules are published (see README).'
      : err.message;
    render();
  });

  render();
  await loadEspn();

  const refreshMs = Math.max(15, CONFIG.refreshSeconds) * 1000;
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - state.lastFetch >= refreshMs - 1000) loadEspn();
    else render(); // keeps "locks in N min" and lock state current
  }, 30 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.lastFetch > refreshMs) loadEspn();
  });
}

main();
