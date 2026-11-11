self.addEventListener('push', (event) => {
  const notice = event.data?.json() ?? { title: '集中タイマー', body: 'タイマーが切り替わりました。' };
  event.waitUntil(self.registration.showNotification(notice.title, {
    body: notice.body,
    tag: notice.tag,
    icon: new URL('icon-192.png', self.registration.scope).href,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const timer = windows.find((window) => window.url.startsWith(self.registration.scope));
    if (timer) return timer.focus();
    return self.clients.openWindow(self.registration.scope);
  })());
});
