const CACHE_NAME = 'family-scheduler-v8';
const APP_SHELL_FILES = ['/manifest.json?v=5', '/icon-512.png'];
const reminderLeadOptions = [5, 10, 15, 30];
const pushSoundOptions = ['/sounds/notify-1.mp3', '/sounds/notify-2.mp3', '/sounds/notify-3.mp3'];
const defaultPushPreferences = {
  reminderLeadMinutes: 10,
  sound: '/sounds/notify-1.mp3',
};

let pushPreferences = { ...defaultPushPreferences };

const sanitizeReminderLead = (value) => {
  const numeric = Number(value);
  return reminderLeadOptions.includes(numeric) ? numeric : defaultPushPreferences.reminderLeadMinutes;
};

const sanitizePushSound = (value) => {
  return pushSoundOptions.includes(value) ? value : defaultPushPreferences.sound;
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_FILES)).catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (event.data && event.data.type === 'PUSH_PREFERENCES') {
    const payload = event.data.payload || {};
    pushPreferences = {
      reminderLeadMinutes: sanitizeReminderLead(payload.reminderLeadMinutes),
      sound: sanitizePushSound(payload.sound),
    };
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname === '/sw.js' || url.pathname === '/manifest.json') {
    event.respondWith(fetch(event.request));
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => response)
        .catch(() => caches.match('/') || caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(event.request)
        .then((response) => {
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }

          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned)).catch(() => undefined);
          return response;
        })
        .catch(() => caches.match('/'));
    })
  );
});

self.addEventListener('push', (event) => {
  let payload = {
    title: 'עדכון חדש בלו״ז',
    body: 'נוספה משימה חדשה',
    url: '/',
  };

  if (event.data) {
    try {
      const incoming = event.data.json();
      payload = {
        ...payload,
        ...incoming,
      };
    } catch {
      payload.body = event.data.text() || payload.body;
    }
  }

  const leadMinutes = sanitizeReminderLead(pushPreferences.reminderLeadMinutes);
  const sound = sanitizePushSound(pushPreferences.sound);

  const options = {
    body: payload.confirmTask ? `${payload.body} (${leadMinutes} דק׳ לפני)` : payload.body,
    icon: '/icon-512.png',
    badge: '/icon-512.png',
    vibrate: [200, 100, 200],
    actions: payload.confirmTask
      ? [{ action: 'confirm-task', title: 'אישרתי' }]
      : [],
    data: {
      url: payload.url || '/',
      sound,
      reminderLeadMinutes: leadMinutes,
      confirmTask: payload.confirmTask || null,
    },
  };

  event.waitUntil((async () => {
    await self.registration.showNotification(payload.title, options);
    const openClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    openClients.forEach((client) => {
      client.postMessage({
        type: 'PLAY_PUSH_SOUND',
        payload: {
          sound,
          reminderLeadMinutes: leadMinutes,
        },
      });
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || '/';

  if (event.action === 'confirm-task') {
    const confirmTask = event.notification?.data?.confirmTask || null;
    const eventId = typeof confirmTask?.eventId === 'string' ? confirmTask.eventId.trim() : '';
    const confirmedBy = typeof confirmTask?.confirmedBy === 'string' ? confirmTask.confirmedBy.trim() : '';

    if (!eventId) {
      return;
    }

    event.waitUntil((async () => {
      await fetch('/api/schedule', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'confirm',
          eventId,
          confirmedBy,
        }),
      }).catch(() => undefined);

      const openClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      openClients.forEach((client) => {
        client.postMessage({
          type: 'TASK_CONFIRMED',
          payload: { eventId },
        });
      });
    })());
    return;
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }

      return self.clients.openWindow(targetUrl);
    })
  );
});
