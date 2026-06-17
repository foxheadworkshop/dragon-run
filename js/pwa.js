// PWA client glue: registers the service worker, tracks online/offline + install
// availability + update-ready, and exposes actions. Degrades silently where SW is
// unavailable (e.g. file://).

export function initPwa({ onUpdateReady, onOnlineChange, onInstallAvailable }) {
  const api = { installable: false, updateReady: false };
  let deferredPrompt = null;
  let waiting = null;

  addEventListener('online', () => onOnlineChange?.(true));
  addEventListener('offline', () => onOnlineChange?.(false));

  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    api.installable = true;
    onInstallAvailable?.();
  });
  addEventListener('appinstalled', () => { deferredPrompt = null; api.installable = false; onInstallAvailable?.(); });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      const track = (worker) => {
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            waiting = worker; api.updateReady = true; onUpdateReady?.();
          }
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) { waiting = reg.waiting; api.updateReady = true; onUpdateReady?.(); }
      reg.addEventListener('updatefound', () => track(reg.installing));
    }).catch(() => { /* no SW — app still works online */ });

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return; reloading = true; location.reload();
    });
  }

  api.promptInstall = async () => {
    if (!deferredPrompt) return false;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice.catch(() => {});
    deferredPrompt = null; api.installable = false;
    return true;
  };
  api.applyUpdate = () => { (waiting || navigator.serviceWorker?.controller)?.postMessage('SKIP_WAITING'); };
  api.clearTiles = async () => { try { await caches.delete('dr-tiles-v1'); return true; } catch { return false; } };
  api.isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  return api;
}
