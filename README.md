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
2. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable → Save.**
   Players never see an email address. The site turns each name + PIN into an Email/Password login behind the scenes.
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
6. Open the site, join with your name and PIN, go to the **Commish** tab and click **Claim commissioner**. Do this before you share the link, because the first person to claim it gets it.

## Publish on GitHub Pages

1. Create a GitHub repo and push the contents of this folder to it.
2. In the repo, go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, pick `main` and `/ (root)`, then save.
3. The site goes live at `https://<you>.github.io/<repo>/` within a minute or two.

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
- **Forgotten PIN:** in the Firebase console, go to **Authentication → Users**, delete that player (their login looks like `name@players.example.com`), and they can join again with the same name. Their old picks reconnect only if they get the same account back, so this is best done before the bowls start.
- **Removing someone** from the Commish tab hides them from the leaderboard.

### Each new season

Change `season` in `js/config.js` (2026 means the 2026-27 bowls). Players keep their accounts, and picks are stored per season.

## Known limits

- Other players' picks are hidden in the UI until kickoff, but Firestore lets anyone read them. A determined player with browser dev tools could peek early. Fine for friends; say so if your group is competitive about it.
- Name + PIN logins are only as strong as a 4-8 digit PIN. Firebase rate-limits guessing, but don't reuse an important PIN.
- ESPN's API is public but undocumented, so ESPN could change it without notice. The parsing is all in `js/espn.js`.