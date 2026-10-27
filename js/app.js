import { CONFIG } from './config.js';
import { fetchBowls } from './espn.js';
import { createStore, nameKey } from './store.js';
import { headToHead, raceStatus } from './race.js';
import { bowlLogo, PLAYOFF_LOGO } from './bowl-logos.js';
import { pushConfigured, pushSupport, registerServiceWorker, currentSubscription, enablePush, disablePush, updatePrefs, loadPrefs, sendTest } from './push.js';

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
  tiebreakers: [], // { uid, points } guesses at the national championship's total points
  games: {},
  adminUid: null,
  dbReady: false,
  dbError: null,
  pending: new Map(), // eventId -> { teamId, token } while a save is in flight
  expanded: new Set(), // event ids with the "who picked what" list open
  filter: 'all',
  day: null, // day shown on the Bowls page (dayKey); null = today if games remain, else the next game day
  confirmRemove: null,
  raceTarget: null, // uid picked in the "Your race" panel
  raceShowOpen: false,
  push: { checked: false, checking: false, on: false, busy: false, error: null }, // this device's notifications
  tb: { draft: null, saving: false, error: null }, // the tiebreaker field on the Bowls page
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

// Tiebreaker: the closest guess at the national championship's combined final score breaks
// ties on points once that game is final.
const titleGame = () => state.events.find(ev => ev.championship);
const tbFor = uid => state.tiebreakers.find(t => t.uid === uid)?.points;

function titleTotal() {
  const ev = titleGame();
  return ev?.completed && ev.away.score != null && ev.home.score != null ? ev.away.score + ev.home.score : null;
}

// open | waiting (commissioner hasn't synced the title game) | locked | none (no title game yet)
function tbStatus(ev = titleGame()) {
  if (!ev || ev.canceled) return 'none';
  if (started(ev)) return 'locked';
  if (store.mode !== 'demo' && !state.games[ev.id]?.championship) return 'waiting';
  return 'open';
}

function standings() {
  const rows = state.players.map(p => ({ ...p, picks: picksFor(p.uid), correct: 0, wrong: 0, pending: 0, max: 0 }));
  const remaining = remainingGames();
  const total = titleTotal();
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
    r.tb = tbFor(r.uid);
    r.tbOff = total != null && r.tb != null ? Math.abs(r.tb - total) : null;
  }
  // Players without a guess lose the tiebreaker to anyone with one.
  const off = r => (total == null ? 0 : r.tbOff ?? Infinity);
  const tied = (a, b) => a.correct === b.correct && off(a) === off(b);
  rows.sort((a, b) => b.correct - a.correct || (off(a) - off(b) || 0) || a.wrong - b.wrong || b.max - a.max || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.rank = i > 0 && tied(rows[i - 1], r) ? rows[i - 1].rank : i + 1; });
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
  // Rebuilding the page while someone's typing in the tiebreaker would close their keyboard; the
  // next render after they leave the field catches up.
  if (document.activeElement?.id !== 'tb-input' && !$('#pager')?.dataset.moving) {
    $('#view').innerHTML = html;
    $('#pager')?.addEventListener('scroll', onPagerScroll, { passive: true });
    syncPager();
  }
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

  // Live games lead as the hero on the Live filter. On All they lead their day's page.
  const showHero = state.filter === 'live' && live.length;
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
    <div class="stack">
      <div class="bowls-top">
        <div class="chips" role="group" aria-label="Filter games">
          ${filters.map(([k, label]) => `<button class="chip ${state.filter === k ? 'is-active' : ''} ${k === 'todo' && counts.todo ? 'alert' : ''}" data-action="filter" data-filter="${k}"><span>${label}<em> ${counts[k]}</em></span></button>`).join('')}
        </div>
        ${state.filter === 'all' ? dayStrip(mine) : ''}
      </div>
      ${showHero ? `<section class="stack"><h2 class="label">Live now</h2><div class="heroes ${live.length > 1 ? 'two' : ''}">${live.map(ev => heroCard(ev, mine)).join('')}</div></section>` : ''}
      ${state.filter === 'all' ? dayPager(mine) : groups.length ? groups.map(g => `
        <section class="day">
          <h2 class="label">${esc(g.key)}${dayNote(g.events, mine)}</h2>
          <div class="tiles">${g.events.map(ev => gameTile(ev, mine)).join('')}</div>
        </section>`).join('')
      : showHero ? '' : `<div class="empty">${state.filter === 'todo' ? "You're all caught up. Every open game has a pick." : state.filter === 'live' ? 'No games are live right now.' : 'Nothing here.'}</div>`}
      ${(state.filter === 'upcoming' && titleGame()?.state === 'pre') || (state.filter === 'todo' && state.user && tbFor(state.user.uid) == null) ? tiebreakerCard() : ''}
    </div>`;
}

/* ---------- Bowls by day ---------- */

// Every game day, in order: { key, start, events }.
function gameDays() {
  const days = [];
  for (const ev of state.events) {
    const key = dayKey(ev);
    if (days.at(-1)?.key !== key) days.push({ key, start: ev.kickoff, events: [] });
    days.at(-1).events.push(ev);
  }
  return days;
}

// Today if it still has games to play, otherwise the next day with a game (the last day once
// the season's over).
function defaultDay(days) {
  return (days.find(d => d.events.some(ev => ev.state !== 'post' && !ev.canceled)) || days.at(-1))?.key;
}

function currentDay(days) {
  return days.some(d => d.key === state.day) ? state.day : defaultDay(days);
}

const todayKey = () => dayKey({ kickoff: Date.now() });

function dayStrip(mine) {
  const days = gameDays();
  const active = currentDay(days);
  const today = todayKey();
  const i = days.findIndex(d => d.key === active);
  const pill = d => {
    const date = d.events[0];
    const part = opts => new Intl.DateTimeFormat(undefined, { ...opts, timeZone: date.timeTbd ? 'America/New_York' : undefined }).format(date.kickoff);
    const live = d.events.some(ev => ev.state === 'in');
    const done = d.events.every(ev => ev.state === 'post' || ev.canceled);
    const need = state.user ? d.events.filter(ev => pickStatus(ev) === 'open' && !mine.has(ev.id)).length : 0;
    const mark = live ? '<i class="dmark live">Live</i>'
      : need ? `<i class="dmark need">${need} to pick</i>`
      : done ? '<i class="dmark done">Final</i>'
      : `<i class="dmark">${plural(d.events.length, 'game')}</i>`;
    return `<button class="dpill ${d.key === active ? 'is-active' : ''} ${d.key === today ? 'today' : ''} ${done ? 'past' : ''}" role="tab" aria-selected="${d.key === active}" data-action="day" data-day="${esc(d.key)}">
      <small>${d.key === today ? 'Today' : esc(part({ weekday: 'short' }))}</small><b>${esc(part({ day: 'numeric' }))}</b><span>${esc(part({ month: 'short' }))}</span>${mark}</button>`;
  };
  return `
    <div class="daynav">
      <button class="day-arrow" data-action="day-step" data-step="-1" aria-label="Previous day" ${i <= 0 ? 'disabled' : ''}>‹</button>
      <div class="daystrip" role="tablist" aria-label="Game days">${days.map(pill).join('')}</div>
      <button class="day-arrow" data-action="day-step" data-step="1" aria-label="Next day" ${i >= days.length - 1 ? 'disabled' : ''}>›</button>
    </div>`;
}

// One page per day, side by side; the pager scrolls (and snaps) sideways, so a swipe changes days.
function dayPager(mine) {
  const days = gameDays();
  const title = titleGame();
  return `
    <div class="pager" id="pager">
      ${days.map(d => {
        const live = d.events.filter(ev => ev.state === 'in');
        const rest = d.events.filter(ev => ev.state !== 'in');
        return `
        <section class="page" data-day="${esc(d.key)}" aria-label="${esc(d.key)}">
          <h2 class="label">${esc(d.key)}${dayNote(d.events, mine)}</h2>
          ${live.length ? `<div class="heroes ${live.length > 1 ? 'two' : ''}">${live.map(ev => heroCard(ev, mine)).join('')}</div>` : ''}
          ${rest.length ? `<div class="tiles">${rest.map(ev => gameTile(ev, mine)).join('')}</div>` : ''}
          ${title && d.events.includes(title) ? tiebreakerCard() : ''}
        </section>`;
      }).join('')}
    </div>`;
}

// Called after every render: show the chosen day without animating, size the pager to that page,
// and keep its pill in view.
function syncPager({ smooth = false } = {}) {
  const pager = $('#pager');
  if (!pager) return;
  const pages = [...pager.children];
  const i = Math.max(0, pages.findIndex(p => p.dataset.day === currentDay(gameDays())));
  pager.scrollTo({ left: i * pager.clientWidth, behavior: smooth ? 'smooth' : 'instant' });
  markDay(pages[i], smooth);
}

function markDay(page, smooth = true) {
  const pager = $('#pager');
  if (!page || !pager) return;
  pager.style.height = `${page.offsetHeight}px`;
  const key = page.dataset.day;
  document.querySelectorAll('.dpill').forEach(b => {
    const on = b.dataset.day === key;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', on);
    if (on) {
      const strip = b.parentElement;
      const left = b.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
      strip.scrollTo({ left: left - (strip.clientWidth - b.offsetWidth) / 2, behavior: smooth ? 'smooth' : 'instant' });
    }
  });
  const pills = [...document.querySelectorAll('.dpill')];
  const at = pills.findIndex(b => b.dataset.day === key);
  const [prev, next] = document.querySelectorAll('.day-arrow');
  if (prev) prev.disabled = at <= 0;
  if (next) next.disabled = at >= pills.length - 1;
}

// After a swipe settles, remember the day it landed on (no full re-render, so it stays smooth).
let pagerSettle;
function onPagerScroll(e) {
  const pager = e.target;
  pager.dataset.moving = '1';
  clearTimeout(pagerSettle);
  pagerSettle = setTimeout(() => {
    delete pager.dataset.moving;
    const page = pager.children[Math.round(pager.scrollLeft / pager.clientWidth)];
    if (!page || page.dataset.day === currentDay(gameDays())) return markDay(page);
    state.day = page.dataset.day;
    markDay(page, true);
    // A short day after a long one: bring the top of the new day back into view.
    const top = pager.getBoundingClientRect().top;
    if (top < 0) window.scrollBy({ top: top - $('.bowls-top').offsetHeight - 8, behavior: 'smooth' });
  }, 120);
}

function goToDay(key) {
  state.day = key;
  syncPager({ smooth: true });
}

function tiebreakerCard() {
  const ev = titleGame();
  const status = tbStatus(ev);
  if (status === 'none') return '';
  const mine = state.user ? tbFor(state.user.uid) : null;
  const total = titleTotal();
  const when = ev.state === 'in' ? 'Live' : ev.state === 'post' ? 'Final' : status === 'open' ? fmtLock(ev) : ev.timeTbd ? 'Time TBD' : fmtWhen(ev.kickoff);
  const sub = [hasTeams(ev) ? `${ev.away.abbr} vs ${ev.home.abbr}` : 'Matchup TBD', when].join(' · ');
  const how = 'If players finish tied on points, the closest guess at the combined final score of the national championship breaks the tie.';

  let side = '';
  let note = '';
  if (status === 'locked') {
    note = mine != null
      ? `Your guess: <strong>${mine}</strong> points${total != null ? `. Final total: <strong>${total}</strong>, off by ${Math.abs(mine - total)}.` : '.'}`
      : `You didn't enter a guess.${total != null ? ` Final total: <strong>${total}</strong>.` : ''}`;
  } else if (!state.user) {
    side = `<button class="btn primary" data-action="open-auth"><span>Join to enter</span></button>`;
  } else if (status === 'waiting') {
    note = 'Opens once the commissioner syncs the title game.';
  } else {
    const { draft, saving, error } = state.tb;
    const value = draft ?? mine ?? '';
    side = `
      <form class="tb-form" data-tb-form novalidate>
        <label class="field"><span>Total points</span>
          <input id="tb-input" type="number" inputmode="numeric" min="0" max="200" step="1" value="${esc(value)}" placeholder="52" aria-describedby="tb-note">
        </label>
        <button class="btn primary" type="submit" ${saving ? 'disabled' : ''}><span>${saving ? 'Saving...' : 'Save'}</span></button>
      </form>`;
    note = error ? `<span class="bad">${esc(error)}</span>` : mine != null ? `Saved: <strong>${mine}</strong> points. You can change it until kickoff.` : 'No guess saved yet.';
  }
  return `
    <section class="day" id="tiebreaker">
      <h2 class="label">Tiebreaker${status === 'locked' ? '<span>Locked</span>' : ''}</h2>
      <div class="tb-card">
        <div class="tb-text"><b>National Championship total points</b><small>${esc(sub)}</small><p>${how}</p></div>
        ${side}
        ${note ? `<p class="tb-note" id="tb-note">${note}</p>` : ''}
      </div>
    </section>`;
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
  const showTb = tbStatus() === 'locked';
  const tbTotal = titleTotal();
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
            <span class="nm"><span>${esc(r.name)}</span>${isMe ? '<i class="you">YOU</i>' : ''}${showTb && r.tb != null ? `<i class="tb" title="Tiebreaker: national championship total points">TB ${r.tb}</i>` : ''}${statusBadge(r, remaining)}</span>
            <span>${r.correct}-${r.wrong}</span><span class="dimc">${r.back || '-'}</span>
            <span class="dimc hide-sm">${pct}</span><span class="dimc hide-sm">${r.pending}</span><span class="hide-sm">${r.max}</span>
          </button>`;
        }).join('')}
      </div>
      ${teaser}
      <p class="fine">Tap a player to see their picks. Picks stay hidden until kickoff. <strong>Out</strong> means no remaining results can put that player in first.</p>
      ${titleGame() ? `<p class="fine">Ties on points are broken by the closest guess at the national championship's total points${showTb ? ' (<strong>TB</strong>)' : ''}${tbTotal != null ? `. Final total: <strong>${tbTotal}</strong>` : ''}.</p>` : ''}
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
      ${tbStatus() === 'open' && tbFor(state.user.uid) == null ? `<button class="teaser" data-action="go-tiebreaker"><div><b>Tiebreaker not entered</b><small>Guess the national championship's total points</small></div><span>›</span></button>` : ''}
      ${todo ? `<button class="teaser" data-action="filter" data-filter="todo"><div><b>${plural(todo, 'game')} need a pick</b><small>Tap to see them on the Bowls page</small></div><span>›</span></button>` : ''}
      ${renderNotifications()}
      <h2 class="label">Your picks<span>${picked} of ${pickable.length}</span></h2>
      ${state.espnLoaded ? `<ul class="pd-list">${pickItems(state.events, mine, true)}</ul>` : `<div class="empty"><div class="spinner"></div>Loading games...</div>`}
    </section>`;
}

const NOTIFICATION_TYPES = [
  ['reminders', 'Pick reminders', "About an hour before kickoff, if you haven't picked that game yet."],
  ['results', 'Game results', 'When each game goes final, with whether your pick was right.'],
  ['recap', 'Daily recap', "After each day's last game: your record that day, your place, and how far back of 1st you are."],
];

function renderNotifications() {
  if (!pushConfigured()) return '';
  const p = state.push;
  const support = pushSupport();
  if (store.mode !== 'firebase') {
    return `<section class="panel"><h2>Notifications</h2><p class="muted">Notifications work on the live league, not in demo mode.</p></section>`;
  }
  if (support === 'ok' && !p.checked) refreshPush();

  let body;
  if (support === 'ios-install') {
    body = `<p>On iPhone, notifications only work in the Home Screen app. Add this site to your Home Screen (Share, then Add to Home Screen), open it from there, and turn them on here.</p>`;
  } else if (support === 'unsupported') {
    body = `<p class="muted">This browser can't receive notifications from websites.</p>`;
  } else if (support === 'denied') {
    body = `<p>Notifications are blocked for this site. Allow them in your browser or phone settings, then reload the page.</p>`;
  } else if (!p.checked) {
    body = `<p class="muted">Checking this device...</p>`;
  } else if (!p.on) {
    body = `<p>Get a heads-up before games you haven't picked, results as games finish, and where you stand after each day.</p>
      <div><button class="btn primary" data-action="push-on" ${p.busy ? 'disabled' : ''}><span>${p.busy ? 'Turning on...' : 'Turn on notifications'}</span></button></div>`;
  } else {
    const prefs = loadPrefs();
    body = `<div class="toggles">${NOTIFICATION_TYPES.map(([key, title, desc]) => `
        <label class="toggle"><input type="checkbox" id="pref-${key}" data-pref="${key}" ${prefs[key] ? 'checked' : ''}>
          <span class="switch" aria-hidden="true"></span><span class="grow"><b>${title}</b><small>${desc}</small></span></label>`).join('')}
      </div>
      <div class="row">
        <button class="btn small" data-action="push-test" ${p.busy ? 'disabled' : ''}><span>Send a test</span></button>
        <button class="btn ghost small" data-action="push-off" ${p.busy ? 'disabled' : ''}><span>Turn off on this device</span></button>
      </div>`;
  }
  return `
    <section class="panel">
      <div class="panel-head"><h2>Notifications</h2>${p.on ? '<span class="status alive">On</span>' : ''}</div>
      ${body}
      ${p.error ? `<p class="form-error">${esc(p.error)}</p>` : ''}
    </section>`;
}

async function refreshPush() {
  if (state.push.checking) return;
  state.push.checking = true;
  try { state.push.on = !!(await currentSubscription()); } catch { state.push.on = false; }
  Object.assign(state.push, { checked: true, checking: false });
  render();
}

// Runs a notification action with the player's sign-in token, showing errors in the panel.
async function pushAction(fn, done) {
  Object.assign(state.push, { busy: true, error: null });
  render();
  try {
    const token = await store.idToken();
    if (!token) throw new Error('Sign in again to change notifications.');
    const result = await fn(token);
    done?.(result);
  } catch (err) {
    state.push.error = err.message;
  } finally {
    state.push.busy = false;
    render();
  }
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
      <div><h2>${esc(name)}</h2>${row ? `<p class="muted">${row.correct}-${row.wrong} · ${rankLabel(row, rows)} of ${state.players.length}</p>` : ''}${tbLine(uid, self)}</div>
      <div class="sheet-actions">
        ${self ? '<button class="btn ghost small" data-action="sign-out"><span>Sign out</span></button>' : ''}
        <button class="btn small" data-action="close-dialog"><span>Close</span></button>
      </div>
    </div>
    ${vs}
    <ul class="pd-list">${items}</ul>`;
}

function tbLine(uid, self) {
  if (tbStatus() === 'none') return '';
  const guess = tbFor(uid);
  const shown = guess == null ? 'no guess' : self || tbStatus() === 'locked' ? `${guess} total points` : 'hidden until kickoff';
  return `<p class="muted">Tiebreaker: ${shown}</p>`;
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

// The title game syncs even before its teams are set, so the tiebreaker can open (and lock).
function gamesNeedingSync() {
  return state.events
    .filter(ev => hasTeams(ev) || ev.championship)
    .filter(ev => {
      const g = state.games[ev.id];
      return !g || g.kickoff !== ev.kickoff || g.championship !== ev.championship
        || (hasTeams(ev) && (!g.teams.includes(ev.away.id) || !g.teams.includes(ev.home.id)));
    })
    .map(ev => ({ id: ev.id, name: ev.title, kickoff: ev.kickoff, teams: hasTeams(ev) ? [ev.away.id, ev.home.id] : [], championship: ev.championship }));
}

async function saveTiebreaker(e) {
  e.preventDefault();
  const ev = titleGame();
  if (!state.user) return openAuth('join');
  if (tbStatus(ev) !== 'open') return toast('The tiebreaker is locked.', 'bad');
  const raw = String($('#tb-input')?.value ?? state.tb.draft ?? '').trim();
  const points = raw === '' ? null : Number(raw);
  $('#tb-input')?.blur();
  if (points != null && !(Number.isInteger(points) && points >= 0 && points <= 200)) {
    state.tb.error = 'Enter a whole number from 0 to 200.';
    return render();
  }
  state.tb = { draft: raw, saving: true, error: null };
  render();
  try {
    await store.setTiebreaker(state.user.uid, SEASON, ev.id, points);
    state.tb.draft = null;
    toast(points == null ? 'Tiebreaker cleared' : `Tiebreaker saved: ${points}`);
  } catch (err) {
    state.tb.error = err.message;
  } finally {
    state.tb.saving = false;
    render();
  }
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
      // Returning players on a new device often type their name and password on the Join tab.
      // If the name is already in the pool, try signing them in with what they typed.
      const taken = nameTaken(data.get('name'));
      try {
        if (taken) throw Object.assign(new Error('taken'), { code: 'auth/email-already-in-use' });
        await store.join(data.get('name'), data.get('password'));
      } catch (joinErr) {
        if (joinErr.code !== 'auth/email-already-in-use' && !/taken/i.test(joinErr.message)) throw joinErr;
        try {
          await store.signIn(data.get('name'), data.get('password'));
        } catch {
          setAuthMode('signin');
          throw new Error('That name is already in the pool. If it\'s yours, enter the password or PIN you joined with.');
        }
      }
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
      else if (el.closest('#owe')) document.querySelector('.bowls-top')?.scrollIntoView({ block: 'start' });
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
    case 'day': return goToDay(el.dataset.day);
    case 'day-step': {
      const days = gameDays();
      const i = days.findIndex(d => d.key === currentDay(days)) + Number(el.dataset.step);
      return days[i] && goToDay(days[i].key);
    }
    case 'go-tiebreaker':
      state.filter = 'all';
      state.day = titleGame() ? dayKey(titleGame()) : state.day;
      location.hash = 'bowls';
      render();
      return requestAnimationFrame(() => $('#tiebreaker')?.scrollIntoView({ block: 'center' }));
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
    case 'push-on':
      return pushAction(enablePush, () => { state.push.on = true; toast('Notifications are on'); });
    case 'push-off':
      return pushAction(disablePush, () => { state.push.on = false; toast('Notifications are off on this device'); });
    case 'push-test':
      return pushAction(sendTest, r => toast(r.sent ? `Test sent to ${plural(r.sent, 'device')}` : 'No devices accepted the test'));
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

  registerServiceWorker();
  document.addEventListener('click', handleClick);
  // Notification type switches on the Me page.
  document.addEventListener('change', e => {
    const input = e.target.closest('input[data-pref]');
    if (!input) return;
    const prefs = { ...loadPrefs(), [input.dataset.pref]: input.checked };
    pushAction(token => updatePrefs(prefs, token));
  });
  document.addEventListener('keydown', e => {
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && $('#pager') && !e.target.closest('input, textarea, dialog')) {
      $(`.day-arrow[data-step="${e.key === 'ArrowLeft' ? -1 : 1}"]`)?.click();
    }
    if (e.key === 'Enter' && e.target.matches('tr[data-action]')) handleClick(e);
  });
  $('#auth-form').addEventListener('submit', submitAuth);
  document.addEventListener('submit', e => { if (e.target.matches('[data-tb-form]')) saveTiebreaker(e); });
  document.addEventListener('input', e => {
    if (e.target.id !== 'tb-input') return;
    state.tb.draft = e.target.value;
    state.tb.error = null;
  });
  $('#name-form').addEventListener('submit', submitName);
  // A standings name is required; Esc doesn't dismiss the prompt (Sign out does).
  $('#name-dialog').addEventListener('cancel', e => e.preventDefault());
  $('#auth-form').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (b) setAuthMode(b.dataset.mode);
  });
  window.addEventListener('hashchange', render);
  window.addEventListener('resize', () => syncPager());

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
