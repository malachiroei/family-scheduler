const CACHE_NAME = 'family-scheduler-v19';
const API_BASE_URL = 'https://family-scheduler-topaz.vercel.app';
const apiUrl = (path) => `${API_BASE_URL}${path}`;
const APP_SHELL_FILES = ['/manifest.json?v=5', '/icon-512.png'];
const reminderLeadOptions = [5, 10, 15, 30];
const pushSoundOptions = ['/sounds/standard.mp3', '/sounds/bell.mp3', '/sounds/modern.mp3'];
const defaultPushPreferences = {
  reminderLeadMinutes: 10,
  sound: '/sounds/standard.mp3',
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

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
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
    actions: Array.isArray(payload.actions)
      ? payload.actions
      : (payload.confirmTask ? [{ action: 'confirm', title: 'אישרתי שראיתי' }] : []),
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
  const confirmTask = event.notification?.data?.confirmTask || null;
  const eventId = typeof confirmTask?.eventId === 'string' ? confirmTask.eventId.trim() : '';
  const childName = typeof confirmTask?.childName === 'string'
    ? confirmTask.childName.trim()
    : (typeof confirmTask?.confirmedBy === 'string' ? confirmTask.confirmedBy.trim() : '');

  const acknowledgeIfNeeded = async () => {
    if (!eventId) {
      return;
    }

    await fetch(apiUrl('/api/notifications/ack'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        eventId,
        childName,
        eventTitle: typeof confirmTask?.eventTitle === 'string' ? confirmTask.eventTitle : '',
      }),
    }).catch(() => undefined);

    const openClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    openClients.forEach((client) => {
      client.postMessage({
        type: 'TASK_CONFIRMED',
        payload: { eventId },
      });
    });
  };

  if (event.action === 'confirm') {
    event.waitUntil((async () => {
      await acknowledgeIfNeeded();
    })());
    return;
  }

  let targetWithConfirm = targetUrl;
  if (eventId) {
    const separator = targetUrl.includes('?') ? '&' : '?';
    const childParam = childName ? `&confirmChildName=${encodeURIComponent(childName)}` : '';
    const titleParam = typeof confirmTask?.eventTitle === 'string' && confirmTask.eventTitle.trim()
      ? `&confirmEventTitle=${encodeURIComponent(confirmTask.eventTitle.trim())}`
      : '';
    targetWithConfirm = `${targetUrl}${separator}confirmEventId=${encodeURIComponent(eventId)}${childParam}${titleParam}`;
  }

  event.waitUntil((async () => {
    const clientsArr = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (eventId) {
      clientsArr.forEach((client) => {
        client.postMessage({
          type: 'CONFIRM_REQUIRED',
          payload: {
            eventId,
            childName,
            eventTitle: typeof confirmTask?.eventTitle === 'string' ? confirmTask.eventTitle : '',
          },
        });
      });
    }

    for (const client of clientsArr) {
      if ('focus' in client) {
        client.navigate(targetWithConfirm);
        return client.focus();
      }
    }

    return self.clients.openWindow(targetWithConfirm);
  })());
});
