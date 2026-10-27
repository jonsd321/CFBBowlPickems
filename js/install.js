// "Add to Home Screen" card for phones.
//
// iPhone/iPad: Safari and Chrome give websites no install button, so the card shows where to tap
// (Share > Add to Home Screen). Android Chrome can show its own install prompt, so the card gets
// an Install button; if Chrome doesn't offer the prompt, it shows the menu steps instead.
//
// Never shown on desktop, in in-app browsers (Instagram, Facebook...) that can't install, or once
// the site is opened from its Home Screen icon. At most once per visit, 2 seconds after load.
// The X hides it for 30 days. Add ?a2hs to any URL to force it for testing.

const HIDE_KEY = 'bowlpool-a2hs-hide-until';
const SEEN_KEY = 'bowlpool-a2hs-seen';
const ua = navigator.userAgent;
const force = /[?&]a2hs\b/.test(location.search);
const store = (kind, fn) => { try { return fn(kind === 'local' ? localStorage : sessionStorage); } catch { return null; } };

const installed = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const android = /Android/.test(ua);
const inApp = /Instagram|FBAN|FBAV|Line\/|GSA\/|Snapchat|Twitter/.test(ua);
const iosChrome = ios && /CriOS\//.test(ua);
const iosSafari = ios && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) && !inApp;

let deferredPrompt = null;
let card = null;

const eligible = force || (!installed && !inApp && (iosSafari || iosChrome || android)
  && !(Number(store('local', s => s.getItem(HIDE_KEY))) > Date.now())
  && !store('session', s => s.getItem(SEEN_KEY)));

// Chrome on Android fires this when the site can be installed; keep it for the Install button.
addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  if (card) render(); // swap manual steps for the Install button if the card is already up
});
addEventListener('appinstalled', () => card?.remove());

const ICONS = {
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="12" cy="19" r="2.2"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7.5 7.5 12 3l4.5 4.5"/><path d="M8 11H6.5A1.5 1.5 0 0 0 5 12.5v7A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H16"/></svg>',
  viewMore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5l6 6 6-6"/></svg>',
  add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M12 8v8M8 12h8"/></svg>',
};
const key = (icon, label, aria) => `<span class="a2hs-k"${aria ? ` role="img" aria-label="${aria}"` : ''}>${ICONS[icon]}${label}</span>`;

// Which taps to show. Safari 26 keeps Share behind the ... button at the bottom right, and its share
// sheet tucks Add to Home Screen under View More; older Safari has Share mid-toolbar.
function steps() {
  if (android) {
    return { arrow: 'none', lead: 'In the browser menu,', keys: [key('dots', '', 'Menu'), key('add', 'Add to Home screen')] };
  }
  if (iosChrome) return { arrow: 'none', lead: 'In the address bar,', keys: [key('share', 'Share'), key('viewMore', 'View More'), key('add', 'Add to Home Screen')] };
  const ver = Number((ua.match(/Version\/(\d+)/) || [])[1]) || 0;
  if (iosSafari && ver && ver < 26) return { arrow: 'center', keys: [key('share', 'Share'), key('add', 'Add to Home Screen')] };
  return { arrow: 'right', keys: [key('more', '', 'More'), key('share', 'Share'), key('viewMore', 'View More'), key('add', 'Add to Home Screen')] };
}

function render() {
  const s = steps();
  const canInstall = !!deferredPrompt;
  card.dataset.arrow = canInstall ? 'none' : s.arrow;
  card.innerHTML = `
    <div class="a2hs-row">
      <img class="a2hs-icon" src="icons/apple-touch-icon.png" alt="">
      <div class="a2hs-txt"><b>Add CFB Bowl Pickems to your Home Screen</b><small>Opens full screen, straight to your picks.</small></div>
      <button class="a2hs-x" type="button" aria-label="Don't show this for 30 days">✕</button>
    </div>
    ${canInstall
      ? '<button class="btn primary a2hs-install" type="button"><span>Install</span></button>'
      : `<div class="a2hs-steps">${s.lead ? `<span class="a2hs-then">${s.lead}</span>` : ''}${s.keys.map((k, i) => (i ? `<span class="a2hs-step"><span class="a2hs-then">then</span>${k}</span>` : k)).join('')}</div>`}`;
  card.querySelector('.a2hs-x').addEventListener('click', () => {
    store('local', st => st.setItem(HIDE_KEY, String(Date.now() + 30 * 864e5)));
    card.remove();
  });
  card.querySelector('.a2hs-install')?.addEventListener('click', async () => {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (outcome === 'accepted') card.remove();
    else render();
  });
}

function show() {
  store('session', s => s.setItem(SEEN_KEY, '1'));
  card = document.createElement('div');
  card.className = 'a2hs';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Add CFB Bowl Pickems to your Home Screen');
  render();
  document.body.appendChild(card);
}

if (eligible) {
  const later = () => setTimeout(show, 2000);
  if (document.readyState === 'complete') later(); else addEventListener('load', later);
}
