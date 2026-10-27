// Browser side of push notifications: registers the service worker, asks permission, and signs
// this device up with the notification Worker. Which notifications a player wants is remembered on
// this device and sent along with the subscription.

import { CONFIG } from './config.js';

const PREFS_KEY = 'bowlpool-push-prefs';
export const DEFAULT_PREFS = { reminders: true, results: true, recap: true };

export const pushConfigured = () => !!(CONFIG.push?.workerUrl && CONFIG.push?.vapidPublicKey);

const swAllowed = () => 'serviceWorker' in navigator
  && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname));

export function registerServiceWorker() {
  if (!swAllowed()) return;
  const go = () => navigator.serviceWorker.register('sw.js').catch(() => {});
  if (document.readyState === 'complete') go(); else addEventListener('load', go);
}

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const installed = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

// ok | ios-install (iPhone: must open from the Home Screen first) | unsupported | denied
export function pushSupport() {
  if (!swAllowed() || !('PushManager' in window) || !('Notification' in window)) {
    return isIOS() && !installed() ? 'ios-install' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

export function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return { ...DEFAULT_PREFS }; }
}
function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage blocked */ }
}

export async function currentSubscription() {
  if (!swAllowed()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function api(path, token, body = {}) {
  const res = await fetch(CONFIG.push.workerUrl.replace(/\/$/, '') + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Notification server returned ${res.status}`);
  return data;
}

function keyBytes(b64url) {
  const s = atob(b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

export async function enablePush(token) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied'
    ? 'Notifications are blocked. Allow them for this site in your browser or phone settings.'
    : 'Notifications weren\'t turned on.');
  const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register('sw.js'));
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(CONFIG.push.vapidPublicKey) }));
  await api('/subscribe', token, { subscription: sub.toJSON(), prefs: loadPrefs() });
}

export async function updatePrefs(prefs, token) {
  savePrefs(prefs);
  const sub = await currentSubscription();
  if (sub) await api('/subscribe', token, { subscription: sub.toJSON(), prefs });
}

export async function disablePush(token) {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('/unsubscribe', token, { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

export const sendTest = token => api('/test', token);
