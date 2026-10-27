// Pulls the bowl schedule, matchups and results from ESPN's public scoreboard API.
// The endpoint sends Access-Control-Allow-Origin: *, so no proxy is needed.

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';

export async function fetchBowls(season, group) {
  const params = new URLSearchParams({ seasontype: '3', dates: String(season), limit: '300' });
  if (group) params.set('groups', String(group));
  const res = await fetch(`${SCOREBOARD}?${params}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
  const data = await res.json();
  return (data.events || [])
    .map(parseEvent)
    .sort((a, b) => a.kickoff - b.kickoff || a.title.localeCompare(b.title));
}

// "College Football Playoff Quarterfinal at the Goodyear Cotton Bowl Classic"
//   -> { title: 'Goodyear Cotton Bowl Classic', round: 'CFP Quarterfinal' }
// "College Football Playoff First Round Game"
//   -> { title: 'First Round', round: 'College Football Playoff' }
function splitName(headline) {
  const clean = headline.replace(/\s+presented by .*$/i, '').trim();
  const m = clean.match(/^College Football Playoff (.+?)(?: at the (.+))?$/i);
  if (!m) return { title: clean, round: null };
  const stage = m[1].replace(/\s+Game$/i, '');
  return m[2] ? { title: m[2], round: `CFP ${stage}` } : { title: stage, round: 'College Football Playoff' };
}

function parseTeam(c = {}) {
  const t = c.team || {};
  const tbd = !t.id || Number(t.id) < 0;
  const rank = c.curatedRank?.current;
  return {
    id: tbd ? null : String(t.id),
    tbd,
    name: tbd ? 'TBD' : (t.shortDisplayName || t.displayName || t.abbreviation),
    fullName: tbd ? 'TBD' : (t.displayName || t.shortDisplayName),
    abbr: tbd ? 'TBD' : t.abbreviation,
    logo: t.logo || '',
    // ESPN's version drawn for dark backgrounds; used on team-color slabs.
    logoDark: (t.logo || '').replace('/teamlogos/ncaa/500/', '/teamlogos/ncaa/500-dark/'),
    color: t.color ? `#${t.color}` : null,
    record: c.records?.find(r => r.type === 'total')?.summary || '',
    rank: rank && rank <= 25 ? rank : null,
    score: c.score != null && c.score !== '' ? Number(c.score) : null,
    winner: c.winner === true,
  };
}

function parseEvent(e) {
  const comp = e.competitions?.[0] || {};
  const status = e.status?.type || {};
  const comps = comp.competitors || [];
  const away = parseTeam(comps.find(c => c.homeAway === 'away') || comps[0]);
  const home = parseTeam(comps.find(c => c.homeAway === 'home') || comps[1]);
  const { title, round } = splitName(comp.notes?.[0]?.headline || e.name || 'Bowl Game');
  const addr = comp.venue?.address || {};
  const completed = !!status.completed;
  return {
    id: String(e.id),
    title,
    round,
    cfp: !!round,
    kickoff: Date.parse(e.date),
    timeTbd: e.timeValid === false || /\bTBD\b/i.test(status.detail || ''),
    state: status.state || 'pre', // pre | in | post
    completed,
    canceled: /CANCELED|POSTPONED/i.test(status.name || ''),
    detail: status.shortDetail || status.detail || '',
    venue: comp.venue?.fullName || '',
    city: [addr.city, addr.state].filter(Boolean).join(', '),
    tv: [...new Set((comp.broadcasts || []).flatMap(b => b.names || []))].join(' / '),
    odds: comp.odds?.[0]?.details || '',
    away,
    home,
    winnerId: completed ? ([away, home].find(t => t.winner)?.id || null) : null,
    url: e.links?.find(l => l.rel?.includes('summary'))?.href || '',
  };
}
