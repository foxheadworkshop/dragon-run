// Live GPS location. Wraps navigator.geolocation.watchPosition into a small
// start/stop interface with callbacks. Geolocation needs a secure context
// (HTTPS or localhost) — GitHub Pages qualifies; file:// does not.

export function createLocator({ onUpdate, onError, onStatus } = {}) {
  let watchId = null;
  let last = null;

  const supported = () => typeof navigator !== 'undefined' && 'geolocation' in navigator;
  // isSecureContext covers https + localhost + 127.0.0.1; some old browsers lack it.
  const secure = () => (typeof isSecureContext !== 'undefined' ? isSecureContext : location.protocol === 'https:')
    || ['localhost', '127.0.0.1'].includes(location.hostname);

  function start() {
    if (!supported()) { onError?.({ code: 'unsupported', message: 'This device has no location sensor.' }); return false; }
    if (!secure()) { onError?.({ code: 'insecure', message: 'Location needs a secure (https) page.' }); return false; }
    if (watchId != null) return true;
    onStatus?.('locating');
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        last = {
          lat: c.latitude, lon: c.longitude,
          accuracy: Number.isFinite(c.accuracy) ? c.accuracy : null,
          heading: Number.isFinite(c.heading) ? c.heading : null,
          speed: Number.isFinite(c.speed) ? c.speed : null,
          at: pos.timestamp,
        };
        onUpdate?.(last);
      },
      (err) => {
        const code = err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable';
        onError?.({ code, message: err.message });
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 25000 }
    );
    return true;
  }

  function stop() {
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    onStatus?.('off');
  }

  return {
    start,
    stop,
    toggle() { if (watchId != null) { stop(); return false; } return start(); },
    get on() { return watchId != null; },
    get last() { return last; },
    supported,
    secure,
  };
}
