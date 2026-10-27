// Player accounts and picks. Two interchangeable backends with the same interface:
//   FirebaseStore - shared league data in Firestore (the real thing)
//   DemoStore     - everything in this browser's localStorage (when Firebase isn't configured)
//
// Interface:
//   onUser(cb)                         cb({ uid } | null) whenever sign-in state changes
//   join(name, password) / signIn(name, password) / signOut()
//   signInWithGoogle()                 Firebase only; { needsName, suggested } | { cancelled }
//   setName(uid, name)                 creates or renames the player's standings entry
//   subscribe(season, cb, onError)     cb({ players, picks, tiebreakers, games, adminUid, ready }) on every change
//   setPick(uid, eventId, teamId|null, season)
//   setTiebreaker(uid, season, eventId, points|null)   national championship total-points guess
//   claimAdmin(uid), syncGames(season, games), removePlayer(uid)

const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

export async function createStore(config, { forceDemo = false } = {}) {
  if (!forceDemo && config.firebase?.apiKey) return new FirebaseStore(config.firebase).init();
  return new DemoStore();
}

export function cleanName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

export function validateName(name) {
  const n = cleanName(name);
  if (n.length < 2 || n.length > 20) throw new Error('Name must be 2-20 characters.');
  if (!/^[\p{L}\p{N} .'-]+$/u.test(n)) throw new Error('Name can use letters, numbers, spaces, periods, apostrophes and hyphens.');
  return n;
}

// New accounts need an 8+ character password. Signing in also accepts the 4-8 digit PINs
// that earlier accounts were created with.
function validate(name, password, { joining }) {
  const n = validateName(name);
  const p = String(password || '');
  if (joining && p.length < 8) throw new Error('Password must be at least 8 characters.');
  if (!joining && p.length < 4) throw new Error('Enter your password (or the PIN you joined with).');
  if (p.length > 64) throw new Error('Password must be 64 characters or fewer.');
  return n;
}

// Case- and punctuation-insensitive, so "Jon D." and "jon d" are the same player.
export function nameKey(name) {
  const n = cleanName(name).toLowerCase();
  const ascii = n.normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii || [...n].map(ch => ch.codePointAt(0).toString(16)).join('-');
}

function friendly(err) {
  const code = err?.code || '';
  const messages = {
    'auth/email-already-in-use': 'That name is taken. Sign in instead, or choose a different name.',
    'auth/invalid-credential': 'Name or password is wrong.',
    'auth/invalid-login-credentials': 'Name or password is wrong.',
    'auth/wrong-password': 'Name or password is wrong.',
    'auth/user-not-found': 'Name or password is wrong.',
    'auth/too-many-requests': 'Too many tries. Wait a few minutes and try again.',
    'auth/operation-not-allowed': 'That sign-in method isn\'t turned on in Firebase yet (see README).',
    'auth/configuration-not-found': 'That sign-in method isn\'t turned on in Firebase yet (see README).',
    'auth/unauthorized-domain': 'Google sign-in isn\'t allowed on this web address yet. Add it under Authentication > Settings > Authorized domains in Firebase (see README).',
    'auth/popup-blocked': 'Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.',
    'auth/account-exists-with-different-credential': 'That Google account is already linked to a different sign-in.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'permission-denied': 'The server refused that change. Picks lock at kickoff.',
    'unavailable': 'Can\'t reach the database right now. Retrying...',
  };
  const e = new Error(messages[code] || err?.message || String(err));
  e.code = code;
  return e;
}

class FirebaseStore {
  mode = 'firebase';

  constructor(firebaseConfig) {
    this.firebaseConfig = firebaseConfig;
  }

  async init() {
    const [app, auth, fs] = await Promise.all([
      import(`${FIREBASE_SDK}/firebase-app.js`),
      import(`${FIREBASE_SDK}/firebase-auth.js`),
      import(`${FIREBASE_SDK}/firebase-firestore.js`),
    ]);
    this.a = auth;
    this.f = fs;
    const instance = app.initializeApp(this.firebaseConfig);
    this.auth = auth.getAuth(instance);
    this.db = fs.getFirestore(instance);
    return this;
  }

  // Name + password ride on Firebase Email/Password auth: the name becomes a placeholder
  // address on a reserved domain (nothing is ever emailed). The wrapper around the password is
  // how the original PIN accounts were created, so those PINs keep working unchanged.
  email(name) { return `${nameKey(name)}@players.example.com`; }
  password(pw) { return `bp-${pw}-pin`; }

  onUser(cb) {
    return this.a.onAuthStateChanged(this.auth, u => cb(u ? { uid: u.uid } : null));
  }

  async join(name, password) {
    const n = validate(name, password, { joining: true });
    try {
      const cred = await this.a.createUserWithEmailAndPassword(this.auth, this.email(n), this.password(password));
      await this.ensurePlayer(cred.user.uid, n);
    } catch (err) {
      throw friendly(err);
    }
  }

  async signIn(name, password) {
    const n = validate(name, password, { joining: false });
    try {
      const cred = await this.a.signInWithEmailAndPassword(this.auth, this.email(n), this.password(password));
      await this.ensurePlayer(cred.user.uid, n);
    } catch (err) {
      throw friendly(err);
    }
  }

  // Pop-up rather than redirect: redirects break when the site (GitHub Pages) and Firebase's
  // sign-in page are on different domains, which browsers now treat as third-party storage.
  async signInWithGoogle() {
    const { GoogleAuthProvider, signInWithPopup } = this.a;
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      const cred = await signInWithPopup(this.auth, provider);
      const { doc, getDoc } = this.f;
      const exists = (await getDoc(doc(this.db, 'players', cred.user.uid))).exists();
      return { needsName: !exists, suggested: cred.user.displayName || '' };
    } catch (err) {
      if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') return { cancelled: true };
      throw friendly(err);
    }
  }

  async setName(uid, name) {
    const n = validateName(name);
    const { doc, setDoc, serverTimestamp } = this.f;
    try {
      await setDoc(doc(this.db, 'players', uid), { name: n, joined: serverTimestamp() });
    } catch (err) {
      throw friendly(err);
    }
  }

  async ensurePlayer(uid, name) {
    const { doc, getDoc, setDoc, serverTimestamp } = this.f;
    const ref = doc(this.db, 'players', uid);
    if (!(await getDoc(ref)).exists()) await setDoc(ref, { name, joined: serverTimestamp() });
  }

  signOut() {
    return this.a.signOut(this.auth);
  }

  // Proves to the notification Worker which player is asking.
  idToken() {
    return this.auth.currentUser ? this.auth.currentUser.getIdToken() : Promise.resolve(null);
  }

  subscribe(season, cb, onError) {
    const { collection, query, where, onSnapshot, doc } = this.f;
    const s = { players: [], picks: [], tiebreakers: [], games: {}, adminUid: null };
    const loaded = new Set();
    const listen = (key, ref, apply) => onSnapshot(ref, snap => {
      apply(snap);
      loaded.add(key);
      cb({ ...s, ready: loaded.size === 5 });
    }, err => onError?.(friendly(err)));

    const unsubs = [
      listen('players', collection(this.db, 'players'), snap => {
        s.players = snap.docs.map(d => ({ uid: d.id, name: d.data().name }));
      }),
      listen('picks', query(collection(this.db, 'picks'), where('season', '==', season)), snap => {
        s.picks = snap.docs.map(d => d.data());
      }),
      listen('tiebreakers', query(collection(this.db, 'tiebreakers'), where('season', '==', season)), snap => {
        s.tiebreakers = snap.docs.map(d => d.data());
      }),
      listen('games', query(collection(this.db, 'games'), where('season', '==', season)), snap => {
        s.games = Object.fromEntries(snap.docs.map(d => [d.id, {
          kickoff: d.data().kickoff.toMillis(), teams: d.data().teams, championship: d.data().championship === true,
        }]));
      }),
      listen('meta', doc(this.db, 'meta', 'league'), snap => {
        s.adminUid = snap.exists() ? snap.data().adminUid : null;
      }),
    ];
    return () => unsubs.forEach(u => u());
  }

  async setPick(uid, eventId, teamId, season) {
    const { doc, setDoc, deleteDoc, serverTimestamp } = this.f;
    const ref = doc(this.db, 'picks', `${uid}_${eventId}`);
    try {
      if (teamId) await setDoc(ref, { uid, eventId, teamId, season, updated: serverTimestamp() });
      else await deleteDoc(ref);
    } catch (err) {
      throw friendly(err);
    }
  }

  // One doc per player per season: "{uid}_{season}". The rules lock it at the title game's kickoff.
  async setTiebreaker(uid, season, eventId, points) {
    const { doc, setDoc, deleteDoc, serverTimestamp } = this.f;
    const ref = doc(this.db, 'tiebreakers', `${uid}_${season}`);
    try {
      if (points != null) await setDoc(ref, { uid, season, eventId, points, updated: serverTimestamp() });
      else await deleteDoc(ref);
    } catch (err) {
      throw friendly(err);
    }
  }

  async claimAdmin(uid) {
    const { doc, setDoc } = this.f;
    try {
      await setDoc(doc(this.db, 'meta', 'league'), { adminUid: uid });
    } catch (err) {
      if (err?.code === 'permission-denied') {
        throw new Error('Someone else is already the commissioner. To change it, delete the meta/league document in the Firebase console and claim again.');
      }
      throw friendly(err);
    }
  }

  // Writes the trusted kickoff time + teams for each game. Firestore rules check
  // every pick against these, so a pick can't be saved after kickoff.
  async syncGames(season, games) {
    const { doc, writeBatch, Timestamp } = this.f;
    for (let i = 0; i < games.length; i += 400) {
      const batch = writeBatch(this.db);
      for (const g of games.slice(i, i + 400)) {
        batch.set(doc(this.db, 'games', g.id), {
          season, name: g.name, teams: g.teams, kickoff: Timestamp.fromMillis(g.kickoff), championship: !!g.championship,
        });
      }
      try {
        await batch.commit();
      } catch (err) {
        throw friendly(err);
      }
    }
  }

  async removePlayer(uid) {
    const { doc, deleteDoc } = this.f;
    try {
      await deleteDoc(doc(this.db, 'players', uid));
    } catch (err) {
      throw friendly(err);
    }
  }
}

class DemoStore {
  mode = 'demo';
  key = 'bowlpool-demo-v1';
  userCbs = new Set();
  subs = new Set();

  constructor() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(this.key)) || {}; } catch { /* storage blocked */ }
    this.data = { players: {}, picks: {}, tiebreakers: {}, session: null, ...saved };
  }

  save() {
    try { localStorage.setItem(this.key, JSON.stringify(this.data)); } catch { /* storage blocked */ }
    this.subs.forEach(fn => fn());
  }

  setSession(uid) {
    this.data.session = uid;
    this.save();
    this.userCbs.forEach(cb => cb(uid ? { uid } : null));
  }

  onUser(cb) {
    this.userCbs.add(cb);
    cb(this.data.session && this.data.players[this.data.session] ? { uid: this.data.session } : null);
    return () => this.userCbs.delete(cb);
  }

  findByName(name) {
    const key = nameKey(name);
    return Object.entries(this.data.players).find(([, p]) => p.key === key);
  }

  async join(name, password) {
    const n = validate(name, password, { joining: true });
    if (this.findByName(n)) throw new Error('That name is taken. Sign in instead, or choose a different name.');
    const uid = 'demo_' + Math.random().toString(36).slice(2, 10);
    this.data.players[uid] = { name: n, key: nameKey(n), pin: String(password) };
    this.setSession(uid);
  }

  async signIn(name, password) {
    validate(name, password, { joining: false });
    const found = this.findByName(name);
    if (!found || found[1].pin !== String(password)) throw new Error('Name or password is wrong.');
    this.setSession(found[0]);
  }

  async setName(uid, name) {
    const n = validateName(name);
    if (!this.data.players[uid]) return;
    Object.assign(this.data.players[uid], { name: n, key: nameKey(n) });
    this.save();
  }

  async signOut() {
    this.setSession(null);
  }

  subscribe(season, cb) {
    const emit = () => cb({
      players: Object.entries(this.data.players).map(([uid, p]) => ({ uid, name: p.name })),
      picks: Object.values(this.data.picks).filter(p => p.season === season),
      tiebreakers: Object.values(this.data.tiebreakers).filter(t => t.season === season),
      games: {},
      adminUid: this.data.session, // in demo mode whoever is signed in can use the Commish tools
      ready: true,
    });
    this.subs.add(emit);
    queueMicrotask(emit);
    return () => this.subs.delete(emit);
  }

  async setPick(uid, eventId, teamId, season) {
    const id = `${uid}_${eventId}`;
    if (teamId) this.data.picks[id] = { uid, eventId, teamId, season };
    else delete this.data.picks[id];
    this.save();
  }

  async setTiebreaker(uid, season, eventId, points) {
    const id = `${uid}_${season}`;
    if (points != null) this.data.tiebreakers[id] = { uid, season, eventId, points };
    else delete this.data.tiebreakers[id];
    this.save();
  }

  async claimAdmin() {}
  async syncGames() {}

  async removePlayer(uid) {
    delete this.data.players[uid];
    for (const [id, p] of Object.entries(this.data.picks)) if (p.uid === uid) delete this.data.picks[id];
    for (const [id, t] of Object.entries(this.data.tiebreakers)) if (t.uid === uid) delete this.data.tiebreakers[id];
    this.save();
  }

  // Demo only: fill the league with made-up players who pick every game that has teams.
  seed(events, season) {
    const names = ['Tailgate Tom', 'Two-Point Tina', 'Option Oscar', 'Fight Song Fran', 'Blitz Bev', 'Hail Mary Hank', 'Redshirt Rae'];
    for (const name of names) {
      if (this.findByName(name)) continue;
      const uid = 'demo_' + Math.random().toString(36).slice(2, 10);
      this.data.players[uid] = { name, key: nameKey(name), pin: '0000' };
      const skill = 0.45 + Math.random() * 0.25;
      for (const ev of events) {
        if (!ev.away.id || !ev.home.id || Math.random() < 0.08) continue;
        let pick = Math.random() < 0.5 ? ev.away.id : ev.home.id;
        if (ev.winnerId) pick = Math.random() < skill ? ev.winnerId : [ev.away.id, ev.home.id].find(id => id !== ev.winnerId);
        this.data.picks[`${uid}_${ev.id}`] = { uid, eventId: ev.id, teamId: pick, season };
      }
      const title = events.find(ev => ev.championship);
      if (title) this.data.tiebreakers[`${uid}_${season}`] = { uid, season, eventId: title.id, points: 38 + Math.floor(Math.random() * 30) };
    }
    this.save();
  }

  reset() {
    this.data = { players: {}, picks: {}, tiebreakers: {}, session: null };
    this.setSession(null);
  }
}
