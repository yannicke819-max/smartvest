// LISA refonte B.4.c — Push subscription hook.

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';

export type PushStatus =
  | 'unsupported'   // Browser n'a pas Push API ou Service Worker
  | 'permission-denied'
  | 'not-subscribed'
  | 'subscribed'
  | 'loading';

const SW_PATH = '/sw-lisa-push.js';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function usePushSubscription() {
  const [status, setStatus] = useState<PushStatus>('loading');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setStatus('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setStatus('permission-denied');
      return;
    }
    try {
      const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
      if (!reg) {
        setStatus('not-subscribed');
        return;
      }
      const sub = await reg.pushManager.getSubscription();
      setStatus(sub ? 'subscribed' : 'not-subscribed');
    } catch (e) {
      setError(String(e).slice(0, 200));
      setStatus('not-subscribed');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const subscribe = useCallback(async () => {
    setError(null);
    try {
      // 1. Permission notification
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setStatus('permission-denied');
        return;
      }
      // 2. Register service worker
      const reg = await navigator.serviceWorker.register(SW_PATH, { scope: '/' });
      await navigator.serviceWorker.ready;
      // 3. Fetch VAPID public key
      const { publicKey } = await apiFetch<{ publicKey: string | null }>(
        '/lisa/push/vapid-public-key',
      );
      if (!publicKey) {
        setError('VAPID public key non configurée côté serveur');
        return;
      }
      // 4. Subscribe to push manager
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
      });
      // 5. Persist côté API
      const subJson = sub.toJSON();
      await apiFetch<{ ok: boolean }>('/lisa/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          keys: subJson.keys,
          userAgent: navigator.userAgent,
        }),
      });
      setStatus('subscribed');
    } catch (e) {
      setError(String(e).slice(0, 200));
    }
  }, []);

  const unsubscribe = useCallback(async () => {
    setError(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
      if (!reg) {
        setStatus('not-subscribed');
        return;
      }
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await apiFetch<{ ok: boolean }>('/lisa/push/unsubscribe', {
          method: 'POST',
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setStatus('not-subscribed');
    } catch (e) {
      setError(String(e).slice(0, 200));
    }
  }, []);

  return { status, error, subscribe, unsubscribe, refresh };
}
