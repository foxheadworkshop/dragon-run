// NWS (api.weather.gov) point forecasts — free, no API key, CORS-open, US-only
// (the whole route qualifies). Two-step: points/{lat,lon} -> gridpoint forecast
// URL -> 7-day periods. Both steps cached in localStorage.

import { pointAtMile } from './geo.js';

const LS_KEY = 'dragon-run-wx-v1';
const FC_TTL_MS = 60 * 60 * 1000;       // forecasts: 1 h
const GRID_TTL_MS = 14 * 24 * 3600e3;   // point->gridpoint mapping: stable, 14 d

function loadCache() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null') || { grid: {}, fc: {} }; }
  catch { return { grid: {}, fc: {} }; }
}
function saveCache(c) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(c)); } catch { /* quota — skip */ }
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/geo+json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`NWS ${res.status}`);
  return res.json();
}

async function forecastUrlFor(lat, lon) {
  const cache = loadCache();
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = cache.grid[key];
  if (hit && Date.now() - hit.at < GRID_TTL_MS) return hit.url;
  const meta = await getJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
  const url = meta?.properties?.forecast;
  if (!url) throw new Error('NWS: no forecast url');
  cache.grid[key] = { url, at: Date.now() };
  saveCache(cache);
  return url;
}

async function periodsFor(lat, lon) {
  const url = await forecastUrlFor(lat, lon);
  const cache = loadCache();
  const hit = cache.fc[url];
  if (hit && Date.now() - hit.at < FC_TTL_MS) return hit.periods;
  const fc = await getJson(url);
  const periods = (fc?.properties?.periods || []).map((p) => ({
    start: p.startTime,
    day: p.isDaytime,
    t: p.temperature,
    pop: p.probabilityOfPrecipitation?.value ?? null,
    short: p.shortForecast,
    wind: p.windSpeed,
  }));
  cache.fc[url] = { periods, at: Date.now() };
  saveCache(cache);
  return periods;
}

// Daytime forecast for one location on one local date, or null if not yet published.
async function dayPeriod(lat, lon, dateISO) {
  const periods = await periodsFor(lat, lon);
  return periods.find((p) => p.day && p.start.startsWith(dateISO)) || null;
}

// Compact per-day samples along a day's segment: start / mid / end.
// Returns [{ at: 'start'|'mid'|'end', lat, lon, fc: period|null }] — fc null when
// the date is beyond the published window; entry skipped entirely on fetch error.
export async function dayWeather(route, day, dateISO) {
  const span = day.endMile - day.startMile;
  const miles = span > 120
    ? [day.startMile + 8, (day.startMile + day.endMile) / 2, day.endMile - 8]
    : [day.startMile + span * 0.1, day.endMile - span * 0.1];
  const labels = miles.length === 3 ? ['start', 'mid', 'end'] : ['start', 'end'];
  const out = [];
  await Promise.all(miles.map(async (mi, i) => {
    const [lat, lon] = pointAtMile(route, mi);
    try {
      out[i] = { at: labels[i], lat, lon, fc: await dayPeriod(lat, lon, dateISO) };
    } catch (e) {
      out[i] = null; // NWS hiccup — strip renders what it has
    }
  }));
  return out.filter(Boolean);
}

// Tiny emoji classifier for shortForecast text.
export function wxIcon(short = '') {
  const s = short.toLowerCase();
  if (/thunder|t-storm/.test(s)) return '⛈';
  if (/snow|sleet|ice/.test(s)) return '🌨';
  if (/rain|shower|drizzle/.test(s)) return '🌧';
  if (/fog|mist|haze/.test(s)) return '🌫';
  if (/mostly sunny|partly cloudy|partly sunny/.test(s)) return '⛅';
  if (/cloudy|overcast/.test(s)) return '☁️';
  if (/sunny|clear/.test(s)) return '☀️';
  if (/wind/.test(s)) return '🌬';
  return '🌡';
}
