# CFB Bowl Pickems

A college football bowl pick'em site. Bowl names, teams, logos, kickoff times, live scores and final results come from ESPN's public API. Players pick a winner for every bowl, picks lock at kickoff, and a leaderboard tracks who's ahead. Every correct pick is worth 1 point.

It's a static site (plain HTML, CSS and JS with no build step), so it can be hosted free on GitHub Pages. Firebase stores players and picks.

## Try it locally

```sh
cd bowl-pool
python -m http.server 8000
```

Open http://localhost:8000. With no Firebase config the site runs in **demo mode**, which saves picks only in your browser. To see a finished season with a filled-in leaderboard, open http://localhost:8000/?season=2025, join, then click **Commish → Add sample players**.

## Set up Firebase (about 10 minutes, free)

1. Go to https://console.firebase.google.com and click **Create a project**. You can skip Google Analytics.
2. **Build → Authentication → Get started → Sign-in method**, then turn on two providers:
   - **Email/Password → Enable → Save.** Players never see an email address. The site turns each name + password into an Email/Password login behind the scenes.
   - **Google → Enable**, pick a support email, **Save.** Players can then use "Continue with Google" and choose a display name the first time.

   Then open **Authentication → Settings → Authorized domains** and add your GitHub Pages domain (e.g. `jonsd321.github.io`). Google sign-in only works on domains in that list. `localhost` is there by default.
3. **Build → Firestore Database → Create database.** Pick a location and start in **production mode**.
4. In Firestore, open the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules), and click **Publish**.
5. **Project settings** (gear icon) **→ General → Your apps → Web (`</>`)**. Register an app (no hosting needed) and copy the `firebaseConfig` values into `js/config.js`:

   ```js
   firebase: {
     apiKey: 'AIza...',
     authDomain: 'your-project.firebaseapp.com',
     projectId: 'your-project',
     appId: '1:123:web:abc',
   },
   ```

   These values are meant to be public. The security rules are what protect the data.
6. Open the site, join (with Google or a name and password), go to the **Commish** tab and click **Claim commissioner**. Do this before you share the link, because the first person to claim it gets it.

## Publish on GitHub Pages

1. Create a GitHub repo and push the contents of this folder to it.
2. In the repo, go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, pick `main` and `/ (root)`, then save.
3. The site goes live at `https://<you>.github.io/<repo>/` within a minute or two.

## Push notifications (Cloudflare Worker, free)

Players can turn on notifications from the **Me** tab. They get:

- **Pick reminders** about an hour before kickoff, for games they haven't picked.
- **Results** when each game goes final, with whether their pick was right.
- **A daily recap** after each day's last game: their record that day, their place, and points back of 1st.

The site's service worker (`sw.js`) shows the notifications. A small Cloudflare Worker (`worker/`) stores each device's subscription and checks ESPN and the picks every 5 minutes. Deploy it **before the first bowl game**: the recap standings count games that finish after the Worker starts.

You need [Node.js](https://nodejs.org) (for `npx`) and a free Cloudflare account. In a terminal:

```
cd C:\Users\jdann\bowl-pool\worker
npx wrangler login
npx wrangler kv namespace create SUBS
```

1. `wrangler login` opens a browser to sign in to (or create) your Cloudflare account.
2. The `kv namespace create` command prints an `id`. Paste it into `worker/wrangler.toml` in place of `PASTE_KV_NAMESPACE_ID_HERE`.
3. Upload the private push key (it was generated into `worker/.vapid-private.json`, which git ignores):
   ```
   type .vapid-private.json | npx wrangler secret put VAPID_PRIVATE_JWK
   ```
4. Deploy:
   ```
   npx wrangler deploy
   ```
   It prints the Worker's address, like `https://cfb-bowl-pickems-push.<your-name>.workers.dev`.
5. Paste that address into `js/config.js` as `push.workerUrl`, then commit and push the site. The **Notifications** section appears on the Me tab.
6. On your phone, open the Me tab, tap **Turn on notifications**, then **Send a test**.

Notes:

- **iPhone:** web notifications only work in the Home Screen app (iOS 16.4 or later). The Me tab tells iPhone users to add the site to their Home Screen first.
- **Watching it run:** `npx wrangler tail` (in the `worker` folder) streams the Worker's logs.
- **Changing the Worker:** edit `worker/src/`, then `npx wrangler deploy` again. The site's push key must match `VAPID_PUBLIC_KEY` in `wrangler.toml`. If you ever regenerate the keys (`node worker/scripts/generate-vapid.mjs --force`), update both places, and every player has to turn notifications on again.
- **Free plan limits:** the Worker fetches only yesterday's and today's games, and writes to storage only when it sends something, to stay well within Cloudflare's free allowances.

## How it works

| Piece | Where |
| --- | --- |
| Bowl data | `js/espn.js` fetches `site.api.espn.com/.../college-football/scoreboard?seasontype=3&dates=<season>&groups=80` straight from the browser (ESPN allows cross-origin requests). It refreshes every 60 seconds while the page is open. |
| Bowl logos | ESPN's API doesn't include bowl logos, so they're saved in `img/bowls/` (taken from each bowl's Wikipedia article) and matched by name in `js/bowl-logos.js`. Sponsor names are ignored when matching, so "New Sponsor Citrus Bowl" still gets the Citrus Bowl logo. CFP games without a host bowl use the playoff logo. If a new bowl has no logo, drop an image in `img/bowls/` and add it to `bowlLogos` in `js/config.js`. Logos are trademarks of their bowls; fine for a private pool, but don't reuse them commercially. |
| Picks and players | Firestore collections `players`, `picks` (one doc per player per game) and `games`. |
| Lock at kickoff | When the commissioner has the site open, their browser copies each game's kickoff time and teams from ESPN into `games`. The Firestore rules reject any pick saved after that kickoff time, so nobody can get around the lock by editing the page. |
| Scoring | Worked out live from ESPN results: 1 point per correct pick. **Back** is points behind the leader, and **Max** is the most points a player can still reach. |
| Your race | `js/race.js`. Compares you head to head with any player: the gap, the remaining games that can change it, best and worst case, and whether you can still catch them. Games that haven't kicked off count as swing games for everyone, so the comparison never reveals hidden picks. Players are marked **Out** once no set of remaining results can put them in first, and **Clinched** once no one can pass them. |

### Commissioner duties

- **Visit the site after the bowl matchups are announced** (early December) and again **after each CFP round**. Each visit syncs new matchups automatically and opens them for picks. Until the commissioner visits, a game with set teams shows "picks open once the commissioner syncs it."
- **Forgotten password:** in the Firebase console, go to **Authentication → Users**, delete that player (their login looks like `name@players.example.com`), delete their entry in Firestore `players`, and they can join again with the same name. Their old picks don't carry over to the new account, so this is best done before the bowls start. Google users can't forget a password, which is one reason to steer people that way.
- **Removing someone** from the Commish tab hides them from the leaderboard.

### Each new season

Change `season` in `js/config.js` (2026 means the 2026-27 bowls). Players keep their accounts, and picks are stored per season.

## Known limits

- Other players' picks are hidden in the UI until kickoff, but Firestore lets anyone read them. A determined player with browser dev tools could peek early. Fine for friends; say so if your group is competitive about it.
- New name + password accounts need 8+ characters. Accounts created before passwords existed still sign in with their 4-8 digit PIN, which is easier to guess; Firebase rate-limits guessing.
- Names are unique across Google and password accounts, but that's checked in the browser rather than enforced by the database rules.
- ESPN's API is public but undocumented, so ESPN could change it without notice. The parsing is all in `js/espn.js`.