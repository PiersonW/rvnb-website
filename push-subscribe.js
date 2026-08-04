// RVnB Push Notifications — shared by host-dashboard.html, admin.html,
// traveler-dashboard.html, index.html, and profile.html (Settings).
//
// Usage: after you know who's logged in, call:
//   RVnBPush.init(supabaseClient, currentUser.id);
//
// This registers the service worker, and — if the user hasn't already
// subscribed and hasn't previously said no — shows a small bottom banner
// offering to enable notifications. Safe to call every page load; it's a
// no-op if already subscribed or if the browser doesn't support push
// (e.g. Safari in a regular browser tab on iOS — only works once the site
// is added to the home screen there).
//
// Also exposes RVnBPush.getStatus(), RVnBPush.subscribe(), and
// RVnBPush.unsubscribe() for the Settings page toggle — these are the same
// subscribe/unsubscribe code paths the banner uses, just callable directly
// so the toggle and the banner never drift out of sync with each other.

const RVNB_VAPID_PUBLIC_KEY = 'BIjQNRT4JyvklP6rmiUlPNbb6uQux3K02ugGEgkBlB0z0P3jGa-tWdfaSvhFpr-KfGJ7WZKOWHzdUWBXzel8KQM';

function rvnbUrlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function rvnbSaveSubscription(supabaseClient, userId, sub) {
  const json = sub.toJSON();
  await supabaseClient.from('push_subscriptions').upsert({
    user_id: userId,
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth
  }, { onConflict: 'endpoint' });
}

function rvnbShowEnableBanner(onEnable) {
  if (document.getElementById('rvnb-push-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'rvnb-push-banner';
  // pointer-events:none on the container (with pointer-events:auto on just
  // the two buttons) so this banner can never silently swallow taps on
  // whatever page content happens to sit underneath it — it's fixed-position
  // and full-width, so on some pages/scroll positions it can overlap real
  // action buttons (e.g. a booking card's "Messages" button).
  banner.style.cssText = 'position:fixed; bottom:16px; left:16px; right:16px; max-width:380px; margin:0 auto; background:#0B1220; color:#FAF7F0; padding:14px 16px; border-radius:12px; box-shadow:0 4px 20px rgba(0,0,0,0.3); display:flex; align-items:center; justify-content:space-between; gap:12px; z-index:9999; font-family:Inter,sans-serif; font-size:13px; pointer-events:none;';
  banner.innerHTML =
    '<span>Turn on notifications to hear about new activity right away?</span>' +
    '<div style="display:flex; gap:8px; flex-shrink:0;">' +
      '<button id="rvnb-push-enable" style="background:#FFB547; color:#0B1220; border:none; padding:8px 12px; border-radius:8px; font-weight:700; font-size:12px; cursor:pointer; pointer-events:auto;">Enable</button>' +
      '<button id="rvnb-push-dismiss" style="background:transparent; color:#FAF7F0; opacity:0.6; border:none; padding:8px; font-size:12px; cursor:pointer; pointer-events:auto;">Not now</button>' +
    '</div>';
  document.body.appendChild(banner);

  document.getElementById('rvnb-push-enable').addEventListener('click', onEnable);
  document.getElementById('rvnb-push-dismiss').addEventListener('click', rvnbHideEnableBanner);
}

function rvnbHideEnableBanner() {
  const banner = document.getElementById('rvnb-push-banner');
  if (banner) banner.remove();
}

window.RVnBPush = {
  // 'unsupported' | 'denied' | 'subscribed' | 'not-subscribed'
  async getStatus() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    try {
      const reg = await navigator.serviceWorker.getRegistration('/service-worker.js');
      if (!reg) return 'not-subscribed';
      const existing = await reg.pushManager.getSubscription();
      return existing ? 'subscribed' : 'not-subscribed';
    } catch (err) {
      console.error('Push getStatus failed:', err);
      return 'not-subscribed';
    }
  },

  // Requests permission (if needed) and subscribes this device. Throws on
  // failure — the browser's own permission prompt is what most commonly
  // causes that (user declines, or 'denied' from an earlier visit).
  async subscribe(supabaseClient, userId) {
    const reg = await navigator.serviceWorker.register('/service-worker.js');
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: rvnbUrlBase64ToUint8Array(RVNB_VAPID_PUBLIC_KEY)
    });
    await rvnbSaveSubscription(supabaseClient, userId, sub);
    return sub;
  },

  // Unsubscribes this device locally and removes its row from
  // push_subscriptions so the send-push function stops targeting it. Only
  // affects the current device/browser — push subscriptions are inherently
  // per-device, so a user with the site open on two phones needs to turn
  // this off on each one.
  async unsubscribe(supabaseClient, userId) {
    const reg = await navigator.serviceWorker.getRegistration('/service-worker.js');
    if (!reg) return;
    const existing = await reg.pushManager.getSubscription();
    if (!existing) return;
    const endpoint = existing.endpoint;
    await existing.unsubscribe();
    await supabaseClient.from('push_subscriptions').delete().eq('user_id', userId).eq('endpoint', endpoint);
  },

  async init(supabaseClient, userId) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return; // unsupported browser/context
    if (!userId) return;

    try {
      const reg = await navigator.serviceWorker.register('/service-worker.js');
      const existing = await reg.pushManager.getSubscription();

      if (existing) {
        // Already subscribed on this device — make sure Supabase still has
        // this exact subscription on file (harmless if it already does).
        await rvnbSaveSubscription(supabaseClient, userId, existing);
        return;
      }

      if (Notification.permission === 'denied') return; // they said no before, don't nag

      rvnbShowEnableBanner(async () => {
        try {
          await window.RVnBPush.subscribe(supabaseClient, userId);
        } catch (err) {
          console.error('Push subscribe failed:', err);
        }
        rvnbHideEnableBanner();
      });
    } catch (err) {
      console.error('Push init failed:', err);
    }
  }
};
