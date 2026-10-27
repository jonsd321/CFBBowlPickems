// CFB Bowl Pickems notification Worker (Cloudflare).
//
// HTTP (called by the site, with the player's Firebase sign-in token):
//   POST /subscribe    { subscription, prefs }  save this device and the player's notification choices
//   POST /unsubscribe  { endpoint }             forget this device
//   POST /test                                  send a test notification to the player's devices
//
// Every 5 minutes (cron) it reads ESPN for yesterday and today (Eastern) and sends:
//   - pick reminders, about an hour before kickoff, to players with no pick for that game
//   - results when a game goes final, with whether the player's pick was right
//   - a recap after a day's last game: the player's record that day, place, and points back of 1st
//
// Storage (KV namespace SUBS):
//   u:{uid}  { subs: [PushSubscription JSON], prefs: { reminders, results, recap } }
//   state    what's been sent, plus a running tally of correct/wrong picks for the recap standings.
//            The tally counts games that finish after the Worker is deployed, so deploy before the
//            first bowl game.

import { parseScoreboard, scoreboardDayUrl } from '../../js/espn.js';
import { newSenderKeys, sendPush } from './webpush.js';
import { verifyIdToken } from './auth.js';

const REMIND_MS = 60 * 60 * 1000;
const DEFAULT_PREFS = { reminders: true, results: true, recap: true };

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const path = new URL(request.url).pathname;
    try {
      if (request.method !== 'POST') return json({ ok: true, service: 'cfb-bowl-pickems-push' }, 200, headers);
      const uid = await verifyIdToken((request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''), env.FIREBASE_PROJECT_ID);
      const body = await request.json().catch(() => ({}));
      if (path === '/subscribe') return json(await subscribe(env, uid, body), 200, headers);
      if (path === '/unsubscribe') return json(await unsubscribe(env, uid, body), 200, headers);
      if (path === '/test') return json(await sendTest(env, uid), 200, headers);
      return json({ error: 'Not found' }, 404, headers);
    } catch (err) {
      return json({ error: err.message || String(err) }, 400, headers);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
};

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/* ---------- Subscriptions ---------- */

const cleanPrefs = p => Object.fromEntries(Object.keys(DEFAULT_PREFS).map(k => [k, p?.[k] !== false]));

async function subscribe(env, uid, { subscription, prefs }) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) throw new Error('Missing push subscription');
  if (!/^https:\/\//.test(subscription.endpoint)) throw new Error('Invalid push endpoint');
  const rec = (await env.SUBS.get(`u:${uid}`, 'json')) || { subs: [], prefs: DEFAULT_PREFS };
  const sub = { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } };
  rec.subs = [...rec.subs.filter(s => s.endpoint !== sub.endpoint), sub].slice(-10);
  rec.prefs = cleanPrefs(prefs);
  await env.SUBS.put(`u:${uid}`, JSON.stringify(rec));
  return { ok: true, devices: rec.subs.length, prefs: rec.prefs };
}

async function unsubscribe(env, uid, { endpoint }) {
  const rec = await env.SUBS.get(`u:${uid}`, 'json');
  if (!rec) return { ok: true, devices: 0 };
  rec.subs = rec.subs.filter(s => s.endpoint !== endpoint);
  if (rec.subs.length) await env.SUBS.put(`u:${uid}`, JSON.stringify(rec));
  else await env.SUBS.delete(`u:${uid}`);
  return { ok: true, devices: rec.subs.length };
}

async function sendTest(env, uid) {
  const rec = await env.SUBS.get(`u:${uid}`, 'json');
  if (!rec?.subs?.length) throw new Error('No devices are signed up for notifications yet');
  const sent = await deliver(env, [{ uid, rec, message: { title: 'Notifications are on', body: "You'll get pick reminders, results and nightly recaps here.", url: '#me', tag: 'test' } }]);
  return { ok: true, sent };
}

function vapidFrom(env) {
  return { publicKey: env.VAPID_PUBLIC_KEY, privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK), subject: env.VAPID_SUBJECT || env.SITE_URL };
}

// Sends each message to every device of its player. Devices the push service says are gone
// (404/410) are removed. Returns the number of notifications accepted.
async function deliver(env, outbox) {
  if (!outbox.length) return 0;
  const opts = { vapid: vapidFrom(env), sender: await newSenderKeys(), vapidCache: new Map() };
  let sent = 0;
  const dead = new Map(); // uid -> Set(endpoint)
  await Promise.all(outbox.flatMap(({ uid, rec, message }) => rec.subs.map(async sub => {
    try {
      const status = await sendPush(sub, message, opts);
      if (status >= 200 && status < 300) sent++;
      else if (status === 404 || status === 410) (dead.get(uid) || dead.set(uid, new Set()).get(uid)).add(sub.endpoint);
    } catch { /* network hiccup; skip this device this time */ }
  })));
  for (const [uid, endpoints] of dead) {
    const rec = await env.SUBS.get(`u:${uid}`, 'json');
    if (!rec) continue;
    rec.subs = rec.subs.filter(s => !endpoints.has(s.endpoint));
    if (rec.subs.length) await env.SUBS.put(`u:${uid}`, JSON.stringify(rec));
    else await env.SUBS.delete(`u:${uid}`);
  }
  return sent;
}

async function loadSubscribers(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.SUBS.list({ prefix: 'u:', cursor });
    const recs = await Promise.all(page.keys.map(k => env.SUBS.get(k.name, 'json')));
    page.keys.forEach((k, i) => { if (recs[i]?.subs?.length) out.push({ uid: k.name.slice(2), rec: recs[i] }); });
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

/* ---------- Data: ESPN and Firestore ---------- */

const etDay = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const etHour = ms => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(ms));
const dayLabel = d => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${d}T12:00:00Z`));

async function fetchGames(env, now) {
  const days = [etDay(now - 864e5), etDay(now)];
  if (etHour(now) >= 22) days.push(etDay(now + 864e5)); // late-night kickoffs just after midnight
  const pages = await Promise.all(days.map(async d => {
    const res = await fetch(scoreboardDayUrl(d.replace(/-/g, ''), env.ESPN_GROUP || '80'), {
      headers: { 'User-Agent': 'CFBBowlPickems-notifications/1.0', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
    return parseScoreboard(await res.json());
  }));
  const byId = new Map();
  for (const ev of pages.flat()) if (ev.seasonType === 3) byId.set(ev.id, ev);
  return [...byId.values()].sort((a, b) => a.kickoff - b.kickoff);
}

// Players and picks are publicly readable under the site's Firestore rules, so plain REST works.
const firestore = env => `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;

async function fetchPlayers(env) {
  const players = {};
  let pageToken = '';
  do {
    const res = await fetch(`${firestore(env)}/players?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
    if (!res.ok) throw new Error(`Firestore players returned ${res.status}`);
    const data = await res.json();
    for (const d of data.documents || []) players[d.name.split('/').pop()] = d.fields?.name?.stringValue || 'Player';
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return players;
}

// eventId -> { uid: teamId }, for just the games being notified about.
async function fetchPicks(env, eventIds) {
  const picks = Object.fromEntries(eventIds.map(id => [id, {}]));
  for (let i = 0; i < eventIds.length; i += 30) {
    const values = eventIds.slice(i, i + 30).map(v => ({ stringValue: v }));
    const res = await fetch(`${firestore(env)}:runQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'picks' }], where: { fieldFilter: { field: { fieldPath: 'eventId' }, op: 'IN', value: { arrayValue: { values } } } } } }),
    });
    if (!res.ok) throw new Error(`Firestore picks returned ${res.status}`);
    for (const row of await res.json()) {
      const f = row.document?.fields;
      if (f?.eventId && f.uid && f.teamId) picks[f.eventId.stringValue][f.uid.stringValue] = f.teamId.stringValue;
    }
  }
  return picks;
}

/* ---------- The 5-minute run ---------- */

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

export async function run(env, now = Date.now()) {
  const state = (await env.SUBS.get('state', 'json')) || { init: false, reminded: {}, announced: {}, recapped: {}, tally: {}, days: {} };
  const games = await fetchGames(env, now);
  const dayOf = ev => etDay(ev.kickoff);
  const dayComplete = d => {
    const list = games.filter(ev => dayOf(ev) === d && !ev.canceled);
    return list.length > 0 && list.every(ev => ev.completed);
  };

  // First run: don't announce games that ended before the Worker existed.
  const firstRun = !state.init;
  if (firstRun) {
    for (const ev of games) if (ev.winnerId) state.announced[ev.id] = true;
    for (const d of new Set(games.map(dayOf))) if (dayComplete(d)) state.recapped[d] = true;
    state.init = true;
  }

  const reminders = games.filter(ev => ev.state === 'pre' && !ev.canceled && !ev.timeTbd && ev.away.id && ev.home.id
    && ev.kickoff > now && ev.kickoff - now <= REMIND_MS && !state.reminded[ev.id]);
  const results = games.filter(ev => ev.winnerId && !state.announced[ev.id]);
  const recapDays = [...new Set(games.map(dayOf))].filter(d => !state.recapped[d] && dayComplete(d));

  // Nothing to send: no KV write either (the free plan allows 1,000 writes a day).
  if (!reminders.length && !results.length && !recapDays.length) {
    if (firstRun) await env.SUBS.put('state', JSON.stringify(state));
    return { reminders: 0, results: 0, recaps: 0, sent: 0 };
  }

  const [players, picks, subscribers] = await Promise.all([
    fetchPlayers(env),
    fetchPicks(env, [...reminders, ...results].map(ev => ev.id)),
    loadSubscribers(env),
  ]);
  const outbox = [];
  const subsFor = pref => subscribers.filter(s => players[s.uid] && s.rec.prefs?.[pref] !== false);

  // Results first, so the recap below includes them.
  for (const ev of results) {
    const winner = ev.away.id === ev.winnerId ? ev.away : ev.home;
    const loser = winner === ev.away ? ev.home : ev.away;
    const score = `${winner.name} ${winner.score ?? ''}, ${loser.name} ${loser.score ?? ''}`.replace(/ ,/g, ',').trim();
    const d = dayOf(ev);
    state.days[d] ||= {};
    for (const [uid, teamId] of Object.entries(picks[ev.id] || {})) {
      const right = teamId === ev.winnerId;
      const t = (state.tally[uid] ||= { c: 0, w: 0 });
      const day = (state.days[d][uid] ||= { c: 0, w: 0 });
      if (right) { t.c++; day.c++; } else { t.w++; day.w++; }
    }
    for (const s of subsFor('results')) {
      const pick = picks[ev.id]?.[s.uid];
      const picked = pick && [ev.away, ev.home].find(t => t.id === pick);
      const message = !pick
        ? { title: `Final: ${ev.title}`, body: `${score}. You didn't have a pick in this one.` }
        : pick === ev.winnerId
          ? { title: `${ev.title}: you got it right`, body: `${score}. +1 for your ${winner.name} pick.` }
          : { title: `${ev.title}: missed it`, body: `${score}. You picked ${picked?.name || 'the other team'}.` };
      outbox.push({ uid: s.uid, rec: s.rec, message: { ...message, url: '#bowls', tag: `result-${ev.id}` } });
    }
    state.announced[ev.id] = true;
  }

  // Reminders: one notification per player listing every soon-to-lock game they haven't picked.
  if (reminders.length) {
    for (const s of subsFor('reminders')) {
      const missing = reminders.filter(ev => !picks[ev.id]?.[s.uid]);
      if (!missing.length) continue;
      const mins = ev => Math.max(1, Math.round((ev.kickoff - now) / 60000));
      const message = missing.length === 1
        ? { title: `Pick needed: ${missing[0].title}`, body: `${missing[0].away.name} vs ${missing[0].home.name} kicks off in ${mins(missing[0])} min. Picks lock at kickoff.` }
        : { title: `${missing.length} picks needed`, body: `${missing.map(ev => `${ev.title} (${mins(ev)} min)`).join(', ')}. Picks lock at kickoff.` };
      outbox.push({ uid: s.uid, rec: s.rec, message: { ...message, url: '#bowls', tag: `remind-${missing.map(ev => ev.id).join('-')}` } });
    }
    for (const ev of reminders) state.reminded[ev.id] = true;
  }

  // Recaps: standings from the running tally (players with no finished picks count as 0).
  for (const d of recapDays) {
    const rows = Object.entries(players).map(([uid, name]) => ({ uid, name, c: state.tally[uid]?.c || 0, w: state.tally[uid]?.w || 0 }))
      .sort((a, b) => b.c - a.c || a.w - b.w || a.name.localeCompare(b.name));
    rows.forEach((r, i) => { r.rank = i && rows[i - 1].c === r.c ? rows[i - 1].rank : i + 1; });
    const tied = r => rows.filter(x => x.rank === r.rank).length > 1;
    const when = d === etDay(now) ? 'today' : `on ${dayLabel(d)}`;
    for (const s of subsFor('recap')) {
      const me = rows.find(r => r.uid === s.uid);
      if (!me) continue;
      const day = state.days[d]?.[s.uid];
      const first = day && day.c + day.w ? `You went ${day.c}-${day.w} ${when}.` : `You didn't have a pick in ${when === 'today' ? "today's" : 'those'} games.`;
      let place;
      if (rows.length < 2) place = `You're ${me.c}-${me.w} overall.`;
      else if (me.rank === 1 && tied(me)) place = `You're tied for 1st at ${me.c}-${me.w}.`;
      else if (me.rank === 1) {
        const second = rows.find(r => r.rank > 1);
        place = `You're in 1st, ${plural(me.c - second.c, 'pt')} ahead of ${tied(second) ? '2nd place' : second.name}.`;
      }
      else place = `You're ${tied(me) ? 'T-' : ''}${ordinal(me.rank)} of ${rows.length}, ${plural(rows[0].c - me.c, 'pt')} back of ${rows[0].name}.`;
      outbox.push({ uid: s.uid, rec: s.rec, message: { title: `${dayLabel(d)} recap`, body: `${first} ${place}`, url: '#leaderboard', tag: `recap-${d}` } });
    }
    state.recapped[d] = true;
  }

  // Keep the per-day records only as long as a recap could still need them.
  for (const d of Object.keys(state.days)) if (now - Date.parse(`${d}T12:00:00Z`) > 4 * 864e5) delete state.days[d];

  // Save before sending, so a crash mid-send can't cause duplicate notifications next run.
  await env.SUBS.put('state', JSON.stringify(state));
  const sent = await deliver(env, outbox);
  return { reminders: reminders.length, results: results.length, recaps: recapDays.length, sent };
}
