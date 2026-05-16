'use strict';

// ─── NEXUS Service Worker — handles web push notifications ────────────────────

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  if (!e.data) return;
  let payload;
  try { payload = e.data.json(); } catch { payload = { title: 'NEXUS', body: e.data.text() }; }

  const options = {
    body:              payload.body  || '',
    icon:              payload.icon  || '/icon.png',
    badge:             '/icon.png',
    tag:               payload.tag   || 'nexus',
    data:              payload.data  || {},
    requireInteraction: false,
    vibrate:           [200, 100, 200],
  };

  e.waitUntil(self.registration.showNotification(payload.title || 'NEXUS', options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url && c.focus);
      if (existing) return existing.focus();
      return self.clients.openWindow('/');
    })
  );
});
