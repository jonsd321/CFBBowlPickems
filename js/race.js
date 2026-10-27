// Remaining-games math for the leaderboard: who can still catch whom, and who has clinched or is out.
//
// A game that hasn't kicked off yet counts as a swing game for everyone, whatever they've picked:
// picks can still change, and other players' picks are hidden until kickoff anyway. Once a game
// starts, the real picks decide whether it can move the gap between two players.
//
// Players are standings rows: { uid, correct, picks: Map(eventId -> teamId) }.
// `remaining` is [{ ev, open }] for every game without a result yet; open = can still be picked.

// Most points `a` can still gain on `b`.
export function maxGain(a, b, remaining) {
  let n = 0;
  for (const { ev, open } of remaining) {
    const pa = a.picks.get(ev.id);
    if (open || (pa && pa !== b.picks.get(ev.id))) n++;
  }
  return n;
}

// Everything the "you vs them" breakdown needs, from a's point of view.
export function headToHead(a, b, remaining) {
  const swing = [];
  let same = 0;
  for (const { ev, open } of remaining) {
    const pa = a.picks.get(ev.id);
    const pb = b.picks.get(ev.id);
    if (open) swing.push({ ev, open, a: pa, b: pb });
    else if (pa && pa === pb) same++;
    else if (pa || pb) swing.push({ ev, open, a: pa, b: pb });
  }
  const gap = a.correct - b.correct; // positive = a is ahead
  const gainA = maxGain(a, b, remaining);
  const gainB = maxGain(b, a, remaining);
  return { gap, swing, same, best: gap + gainA, worst: gap - gainB };
}

// uid -> { alive, clinched, outright }
//   alive:    some set of results still leaves them in first (ties count)
//   clinched: no set of results can put anyone ahead of them
//   outright: clinched, and no one can even tie them
export function raceStatus(rows, remaining) {
  const out = new Map();
  for (const a of rows) {
    const margins = rows.filter(b => b !== a).map(b => a.correct - b.correct - maxGain(b, a, remaining));
    out.set(a.uid, {
      alive: canFinishFirst(a, rows, remaining),
      clinched: margins.every(m => m >= 0),
      outright: margins.every(m => m > 0),
    });
  }
  return out;
}

// Clinching only needs pairwise checks, but staying alive needs one set of results that works
// against every opponent at once.
function canFinishFirst(a, rows, remaining) {
  const others = rows.filter(b => b !== a);
  if (!others.length) return true;
  if (others.some(b => a.correct + maxGain(a, b, remaining) < b.correct)) return false;

  // a's best case: its pick wins every started game it picked, it picks the winner of every open
  // game, and nobody else scores on open games. That leaves started games a didn't pick. Try
  // every way those can go, looking for one where nobody finishes above a.
  let best = a.correct;
  const base = others.map(b => b.correct);
  const free = [];
  for (const { ev, open } of remaining) {
    const pa = a.picks.get(ev.id);
    if (open) best++;
    else if (pa) {
      best++;
      others.forEach((b, i) => { if (b.picks.get(ev.id) === pa) base[i]++; });
    } else free.push(ev);
  }
  if (free.length > 12) return true; // too many to enumerate; the pairwise check above already passed

  for (let mask = 0; mask < 1 << free.length; mask++) {
    const scores = base.slice();
    free.forEach((ev, j) => {
      const winner = (mask >> j) & 1 ? ev.home.id : ev.away.id;
      others.forEach((b, i) => { if (b.picks.get(ev.id) === winner) scores[i]++; });
    });
    if (Math.max(...scores) <= best) return true;
  }
  return false;
}
