// GPX export: one <trk> per direction plus a <wpt> per chosen stop, so the plan
// drops straight into Garmin/REVER/OsmAnd for offline navigation at the Gap.

import { simplifyIndices } from './geo.js';
import { minToTime } from './engine.js';

const SYM = { fuel: 'Gas Station', food: 'Restaurant', lodging: 'Hotel', camping: 'Campground' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
}

export function buildGpx(tripName, legs) {
  // legs: [{ label, route, plan }]
  const wpts = [];
  const trks = [];
  for (const { label, route, plan } of legs) {
    for (const [di, day] of plan.days.entries()) {
      for (const s of day.stops) {
        if (!s.chosen) continue;
        const { poi } = s.chosen;
        const what = s.type === 'fuel' ? 'Fuel' : s.type === 'lunch' ? 'Lunch' : (s.baseCamp ? 'Base camp' : 'Night');
        wpts.push(
          `<wpt lat="${poi.lat}" lon="${poi.lon}">` +
          `<name>${esc(`${label} D${di + 1} ${what} — ${poi.name || SYM[poi.cat]}`)}</name>` +
          `<desc>${esc(`ETA ${minToTime(s.etaMin)} · route mile ${Math.round(s.mile)} · ${s.chosen.o.toFixed(1)} mi off route`)}</desc>` +
          `<sym>${SYM[poi.cat] || 'Flag'}</sym></wpt>`
        );
      }
    }
    const keep = simplifyIndices(route.coords, 30, 1500);
    const pts = keep.map((i) => `<trkpt lat="${route.coords[i][0]}" lon="${route.coords[i][1]}"/>`).join('');
    trks.push(`<trk><name>${esc(`${tripName} — ${label}`)}</name><trkseg>${pts}</trkseg></trk>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Dragon Run" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${esc(tripName)}</name></metadata>
${wpts.join('\n')}
${trks.join('\n')}
</gpx>`;
}

export function downloadGpx(filename, xml) {
  const blob = new Blob([xml], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
