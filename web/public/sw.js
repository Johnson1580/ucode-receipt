// 手機推播：收到雲端送來的通知就顯示；點通知開啟對應頁面（已開著系統就切過去）
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || "優碼數位AI辨識系統", {
    body: d.body || "", tag: d.tag, renotify: !!d.tag, data: { url: d.url || "/" },
    icon: "/icons/icon-192.png", badge: "/icons/icon-192.png",
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) { await w.navigate(url); return w.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
