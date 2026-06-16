// All Leaflet rendering. Leaflet + markercluster come in as globals (classic
// script tags) — do not import them.

import { sliceCoords, pointAtMile } from './geo.js';
import { mileToBrpMp } from './route.js';

export const DAY_COLORS = ['#ff5d3b', '#ffb02e', '#41c7a6', '#5fa8ff', '#c792ea', '#ff7ab2', '#9ccc65', '#ffd54f'];

export const GLYPHS = {
  fuel: '<svg viewBox="0 0 24 24" fill="#16130c"><path d="M19.77 7.23l.01-.01-3.72-3.72L15 4.56l2.11 2.11c-.94.36-1.61 1.26-1.61 2.33 0 1.38 1.12 2.5 2.5 2.5.36 0 .69-.08 1-.21v7.21c0 .55-.45 1-1 1s-1-.45-1-1V14c0-1.1-.9-2-2-2h-1V5c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v16h10v-7.5h1.5v5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V9c0-.69-.28-1.32-.73-1.77zM12 10H6V5h6v5z"/></svg>',
  food: '<svg viewBox="0 0 24 24" fill="#16130c"><path d="M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z"/></svg>',
  lodging: '<svg viewBox="0 0 24 24" fill="#16130c"><path d="M7 13c1.66 0 3-1.34 3-3S8.66 7 7 7s-3 1.34-3 3 1.34 3 3 3zm12-6h-8v7H3V5H1v15h2v-3h18v3h2v-9c0-2.21-1.79-4-4-4z"/></svg>',
  camping: '<svg viewBox="0 0 24 24" fill="#16130c"><path d="M12 3 1.7 21h7.1l3.2-5.9 3.2 5.9h7.1L12 3zm0 4.2L17.8 19h-2.3L12 12.6 8.5 19H6.2L12 7.2z"/></svg>',
};

export function createMap(el, handlers) {
  const map = L.map(el, { zoomControl: false, attributionControl: true });
  L.control.zoom({ position: 'topright' }).addTo(map);
  map.attributionControl.setPrefix(false);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const base = L.layerGroup().addTo(map);
  const rideLines = L.layerGroup().addTo(map);
  const bands = L.layerGroup().addTo(map);
  const daySegs = L.layerGroup().addTo(map);
  const closures = L.layerGroup().addTo(map);
  const flags = L.layerGroup().addTo(map);
  const rideMarkers = L.layerGroup().addTo(map);
  const chosenLayer = L.layerGroup().addTo(map);
  const highlight = L.layerGroup().addTo(map);
  const cluster = L.markerClusterGroup({
    maxClusterRadius: 44,
    disableClusteringAtZoom: 12,
    showCoverageOnHover: false,
    iconCreateFunction: (c) => L.divIcon({
      className: 'dr-cluster',
      html: String(c.getChildCount()),
      iconSize: [32, 32],
    }),
  }).addTo(map);

  let open = null; // { marker, entry } of the open popup
  let radarLayer = null, radarTimer = null;
  let ridesVisible = true;
  const rideRefs = new Map(); // id -> { line, casing, marker }

  const MOTO_GLYPH = '<svg viewBox="0 0 24 24" fill="#16130c"><path d="M19.44 9.03 15.41 5H11v2h3.59l2 2H5c-2.8 0-5 2.2-5 5s2.2 5 5 5c2.46 0 4.45-1.69 4.9-4h1.65l2.77-2.77c-.21.54-.32 1.14-.32 1.77 0 2.8 2.2 5 5 5s5-2.2 5-5c0-2.65-1.97-4.77-4.56-4.97zM7.82 15C7.4 16.15 6.28 17 5 17c-1.65 0-3-1.35-3-3s1.35-3 3-3c1.28 0 2.4.85 2.82 2H5v2h2.82zM19 17c-1.65 0-3-1.35-3-3s1.35-3 3-3 3 1.35 3 3-1.35 3-3 3z"/></svg>';

  function makeRadarLayer() {
    // NEXRAD base-reflectivity composite, server-refreshed ~5 min; the bucketed
    // query param busts the browser tile cache when we redraw.
    const bucket = Math.floor(Date.now() / 300_000);
    return L.tileLayer(
      `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png?_=${bucket}`,
      { opacity: 0.55, maxZoom: 19, attribution: 'Radar: Iowa Environmental Mesonet' }
    );
  }

  function poiIcon(cat, chosen = false) {
    return L.divIcon({
      className: chosen ? 'chosen-pin' : 'poi-pin',
      html: `<div class="pin pin-${cat}">${GLYPHS[cat] || ''}</div>`,
      iconSize: chosen ? [34, 34] : [26, 26],
      iconAnchor: chosen ? [17, 30] : [13, 23],
      popupAnchor: [0, -22],
    });
  }

  function bindPoiPopup(marker, entry) {
    marker.bindPopup(() => handlers.popupHtml(entry), { maxWidth: 290, className: 'dr-popup' });
    marker.on('popupopen', (e) => {
      open = { marker, entry };
      const node = e.popup.getElement();
      if (node && !node.dataset.wired) {
        node.dataset.wired = '1';
        node.addEventListener('click', (ev) => {
          const btn = ev.target.closest('[data-act]');
          if (btn) handlers.onPopupAction(btn.dataset.act, entry.poi.id);
        });
      }
    });
    marker.on('popupclose', () => { if (open?.marker === marker) open = null; });
  }

  function rideIcon(ride) {
    const dim = ride.currentlyRideable === false;
    return L.divIcon({
      className: 'ride-pin',
      html: `<div class="rp${dim ? ' rp-closed' : ''}">${MOTO_GLYPH}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -14],
    });
  }

  return {
    map,

    setBase(route) {
      base.clearLayers();
      closures.clearLayers();
      const latlngs = route.coords;
      L.polyline(latlngs, { color: '#0b0c10', weight: 9, opacity: 0.85 }).addTo(base);
      L.polyline(latlngs, { color: '#4a5263', weight: 4, opacity: 0.9 }).addTo(base);

      for (const adv of route.advisories || []) {
        const seg = sliceCoords(route, adv.startMile, adv.endMile);
        L.polyline(seg, { color: '#ffcf5c', weight: 5, opacity: 0.85, dashArray: '2 9' })
          .bindTooltip(`⚠ MP ${adv.fromMp}–${adv.toMp}: ${adv.note}`, { sticky: true })
          .addTo(closures);
      }
      for (const det of route.detours || []) {
        const seg = sliceCoords(route, det.startMile, det.endMile);
        L.polyline(seg, { color: '#ff5d3b', weight: 5, opacity: 0.9, dashArray: '7 9' })
          .bindTooltip(`🚧 Parkway closed MP ${det.fromMp}–${det.toMp} — riding the detour. ${det.note}`, { sticky: true })
          .addTo(closures);
        const mid = pointAtMile(route, (det.startMile + det.endMile) / 2);
        L.marker(mid, {
          icon: L.divIcon({
            className: 'closed-label',
            html: `<div class="lab">detour · MP ${Math.round(det.fromMp)}–${Math.round(det.toMp)} closed</div>`,
            iconSize: null,
          }),
          interactive: false,
        }).addTo(closures);
      }
    },

    // Frame the active trip route (not the scattered ride lines). Animated on a
    // route switch so the change is obvious even when two routes share endpoints.
    fitRoute(route, animate = true) {
      const b = L.latLngBounds(route.coords);
      if (animate && map._loaded) map.flyToBounds(b, { padding: [34, 34], duration: 0.7 });
      else map.fitBounds(b, { padding: [34, 34] });
    },

    renderPlan(route, plan) {
      daySegs.clearLayers();
      flags.clearLayers();
      bands.clearLayers();
      chosenLayer.clearLayers();

      plan.days.forEach((day, i) => {
        const seg = sliceCoords(route, day.startMile, day.endMile);
        L.polyline(seg, { color: DAY_COLORS[i % DAY_COLORS.length], weight: 5, opacity: 0.95 })
          .bindTooltip(`Day ${i + 1} — ${Math.round(day.miles)} mi`, { sticky: true })
          .addTo(daySegs);
      });

      for (const leg of plan.fuelLegs) {
        const seg = sliceCoords(route, leg.window[0], Math.min(leg.window[1], route.cum[route.cum.length - 1]));
        L.polyline(seg, { color: '#ffb02e', weight: 14, opacity: 0.22, lineCap: 'butt', interactive: false })
          .addTo(bands);
      }

      // start / day-end / finish flags
      const outbound = !route.reversedFrom && route.id === 'out';
      const start = pointAtMile(route, 0);
      L.marker(start, { icon: flagIcon(outbound ? 'START' : 'BASE CAMP'), zIndexOffset: 900 }).addTo(flags);
      plan.days.forEach((day, i) => {
        if (day.endMile >= route.cum[route.cum.length - 1] - 1e-6) return;
        const p = pointAtMile(route, day.endMile);
        const mp = mileToBrpMp(route, day.endMile);
        L.marker(p, { icon: flagIcon(`D${i + 1} NIGHT${mp != null ? ` · MP ${Math.round(mp)}` : ''}`), zIndexOffset: 900 }).addTo(flags);
      });
      const end = pointAtMile(route, route.cum[route.cum.length - 1]);
      L.marker(end, { icon: flagIcon(outbound ? 'BASE CAMP 🐉' : 'HOME'), zIndexOffset: 900 }).addTo(flags);

      // chosen stops as prominent pins
      for (const day of plan.days) {
        for (const s of day.stops) {
          if (!s.chosen) continue;
          const { poi } = s.chosen;
          const m = L.marker([poi.lat, poi.lon], {
            icon: poiIcon(poi.cat, true),
            zIndexOffset: 1000,
          });
          bindPoiPopup(m, s.chosen);
          m.addTo(chosenLayer);
        }
      }
    },

    setMarkers(entries) {
      cluster.clearLayers();
      const ms = entries.map((entry) => {
        const m = L.marker([entry.poi.lat, entry.poi.lon], { icon: poiIcon(entry.poi.cat) });
        bindPoiPopup(m, entry);
        return m;
      });
      cluster.addLayers(ms);
    },

    focusMile(route, mile, zoom = 11) {
      map.flyTo(pointAtMile(route, mile), zoom, { duration: 0.6 });
    },

    focusEntry(entry, zoom = 13) {
      map.flyTo([entry.poi.lat, entry.poi.lon], zoom, { duration: 0.6 });
    },

    pulse(entry) {
      highlight.clearLayers();
      const c = L.circleMarker([entry.poi.lat, entry.poi.lon], {
        radius: 18, color: '#ffb02e', weight: 3, fillOpacity: 0.08,
      }).addTo(highlight);
      setTimeout(() => highlight.removeLayer(c), 1800);
    },

    refreshOpenPopup() {
      if (open) open.marker.getPopup()?.setContent(handlers.popupHtml(open.entry));
    },

    setRadar(on) {
      clearInterval(radarTimer);
      radarTimer = null;
      if (!on) {
        if (radarLayer) map.removeLayer(radarLayer);
        radarLayer = null;
        return;
      }
      if (!radarLayer) radarLayer = makeRadarLayer().addTo(map);
      radarTimer = setInterval(() => {
        const old = radarLayer;
        radarLayer = makeRadarLayer().addTo(map);
        setTimeout(() => old && map.removeLayer(old), 1500); // overlap to avoid flicker
      }, 300_000);
    },

    setRides(rides) {
      rideLines.clearLayers();
      rideMarkers.clearLayers();
      rideRefs.clear();
      for (const ride of rides) {
        if (!ride.coords?.length) continue;
        const closed = ride.currentlyRideable === false;
        const casing = L.polyline(ride.coords, {
          color: '#1a0a1e', weight: 8, opacity: 0.55, lineCap: 'round', interactive: false,
        });
        const line = L.polyline(ride.coords, {
          color: closed ? '#9aa1ac' : '#ff3df0', weight: 4, opacity: 0.95,
          lineCap: 'round', dashArray: closed ? '3 8' : null,
        }).bindTooltip(`${ride.name} · ${ride.road}${closed ? ' (closed)' : ''}`, { sticky: true });
        casing.addTo(rideLines);
        line.addTo(rideLines);

        const marker = L.marker(ride.mid, { icon: rideIcon(ride), zIndexOffset: 650 });
        marker.bindPopup(() => handlers.ridePopupHtml(ride), { maxWidth: 280, className: 'dr-popup' });
        marker.on('popupopen', (e) => {
          const node = e.popup.getElement();
          if (node && !node.dataset.wired) {
            node.dataset.wired = '1';
            node.addEventListener('click', (ev) => {
              const btn = ev.target.closest('[data-act]');
              if (btn) handlers.onRideAction?.(btn.dataset.act, ride.id);
            });
          }
        });
        marker.addTo(rideMarkers);
        rideRefs.set(ride.id, { line, casing, marker });
      }
      applyRidesVisibility();
    },

    toggleRides(on) { ridesVisible = on; applyRidesVisibility(); },

    focusRide(ride) {
      if (!ride?.coords?.length) return;
      // fitBounds (not flyToBounds — it ignores maxZoom) so tiny rides don't slam to z19.
      map.fitBounds(L.latLngBounds(ride.coords), { padding: [70, 70], maxZoom: 13 });
      const ref = rideRefs.get(ride.id);
      if (ref) {
        const orig = ref.line.options.weight;
        ref.line.setStyle({ weight: orig + 4, opacity: 1 });
        setTimeout(() => ref.line.setStyle({ weight: orig, opacity: 0.95 }), 1400);
        ref.marker.openPopup();
      }
    },

    invalidate() { setTimeout(() => map.invalidateSize(), 260); },
  };

  function applyRidesVisibility() {
    if (ridesVisible) {
      if (!map.hasLayer(rideLines)) map.addLayer(rideLines);
      if (!map.hasLayer(rideMarkers)) map.addLayer(rideMarkers);
    } else {
      map.removeLayer(rideLines);
      map.removeLayer(rideMarkers);
    }
  }

  function flagIcon(text) {
    return L.divIcon({ className: 'day-flag', html: `<div class="flag">${text}</div>`, iconSize: null, iconAnchor: [6, 24] });
  }
}
