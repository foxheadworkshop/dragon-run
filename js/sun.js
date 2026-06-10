// Sunrise/sunset via the NOAA/Wikipedia sunrise-equation algorithm (±1–2 min).
// The entire route (VA/NC/TN border country) is America/New_York, so results
// are returned as minutes-since-midnight in Eastern local time, DST-aware.

const RAD = Math.PI / 180;

function julianDayNumber(y, m, d) {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy +
    Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

function julianToEasternMin(jd) {
  const unixMs = (jd - 2440587.5) * 86400000;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(unixMs));
  const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const min = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + min;
}

// dateISO 'YYYY-MM-DD' (local Eastern date) -> { riseMin, setMin } or null.
export function sunTimes(lat, lon, dateISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO || '')) return null;
  const [y, m, d] = dateISO.split('-').map(Number);
  // JDN is noon UTC of the calendar date — morning Eastern, the right solar day.
  const n = julianDayNumber(y, m, d) - 2451545 + 0.0008;
  const Jstar = n - lon / 360;
  const M = ((357.5291 + 0.98560028 * Jstar) % 360 + 360) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const L = ((M + C + 180 + 102.9372) % 360 + 360) % 360;
  const Jtransit = 2451545 + Jstar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * L * RAD);
  const sinDelta = Math.sin(L * RAD) * Math.sin(23.4397 * RAD);
  const delta = Math.asin(sinDelta);
  const cosH =
    (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinDelta) /
    (Math.cos(lat * RAD) * Math.cos(delta));
  if (cosH < -1 || cosH > 1) return null; // polar day/night — not on this trip
  const H = Math.acos(cosH) / RAD;
  return {
    riseMin: julianToEasternMin(Jtransit - H / 360),
    setMin: julianToEasternMin(Jtransit + H / 360),
  };
}
