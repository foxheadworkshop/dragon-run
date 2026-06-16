// Panel UI: sliders, summary, warnings, itinerary, riders, dialogs, toasts.

import { minToTime } from './engine.js';
import { mileToBrpMp } from './route.js';
import { GLYPHS, DAY_COLORS } from './map.js';
import { CAT_LABEL, TIER_LABEL } from './poi.js';
import { wxIcon } from './weather.js';
import { DIFF_LABEL, DIFF_COLOR } from './rides.js';

const $ = (sel) => document.querySelector(sel);

export function showToast(msg, ms = 2600) {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export function createUI(cb) {
  const els = {
    panel: $('#panel'),
    sheetHandle: $('#sheetHandle'),
    tabs: $('#dirTabs'),
    retPreset: $('#retPreset'),
    sliders: {
      tankRangeMi: { input: $('#sl-tank'), out: $('#out-tank'), unit: ' mi/tank', fmt: (v) => String(Math.round(v)) },
      hoursPerDay: { input: $('#sl-hours'), out: $('#out-hours'), unit: ' h/day', fmt: (v) => String(v) },
      avgMph: { input: $('#sl-mph'), out: $('#out-mph'), unit: ' mph', fmt: (v) => String(Math.round(v)) },
    },
    computed: $('#computedLine'),
    inDepart: $('#inDepart'),
    inDate: $('#inDate'),
    inStay: $('#inStay'),
    inReserve: $('#inReserve'),
    summary: $('#summary'),
    warnings: $('#warnings'),
    toggles: $('#toggles'),
    itinerary: $('#itinerary'),
    ridesPanel: $('#ridesPanel'),
    riders: $('#riders'),
    btnShare: $('#btnShare'),
    btnGpx: $('#btnGpx'),
    btnRefresh: $('#btnRefresh'),
    btnName: $('#btnName'),
    nameModal: $('#nameModal'),
    inName: $('#inName'),
  };

  let dragging = null;            // slider key being dragged
  const expanded = new Set();     // alternates lists left open across re-renders

  // ---- events ----

  for (const [key, s] of Object.entries(els.sliders)) {
    s.input.addEventListener('pointerdown', () => { dragging = key; });
    window.addEventListener('pointerup', () => { dragging = null; });
    s.input.addEventListener('input', () => {
      paintSlider(s);
      cb.onCfg({ [key]: Number(s.input.value) });
    });
  }
  els.inDepart.addEventListener('change', () => cb.onCfg({ departTime: els.inDepart.value || '08:00' }));
  els.inDate.addEventListener('change', () => cb.onCfg({ startDate: els.inDate.value }));
  els.inStay.addEventListener('change', () => cb.onCfg({ stayDays: Math.max(0, Number(els.inStay.value) || 0) }));
  els.inReserve.addEventListener('change', () => cb.onCfg({ reservePct: Number(els.inReserve.value) }));

  els.tabs.addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b) cb.onDir(b.dataset.dir);
  });
  els.retPreset.addEventListener('change', (e) => {
    if (e.target.name === 'retPreset') cb.onCfg({ returnPreset: e.target.value });
  });
  els.toggles.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip.dataset.tier != null) cb.onCfg({ maxTier: Number(chip.dataset.tier) });
    else cb.onToggle(chip.dataset.cat);
  });

  els.itinerary.addEventListener('click', (e) => {
    const altBtn = e.target.closest('.alt-btn');
    if (altBtn) {
      const k = altBtn.dataset.key;
      expanded.has(k) ? expanded.delete(k) : expanded.add(k);
      cb.onRerender();
      return;
    }
    const mini = e.target.closest('.mini');
    if (mini) {
      e.stopPropagation();
      if (mini.dataset.vote != null) cb.onVote(mini.dataset.vote);
      else if (mini.dataset.pick != null) {
        cb.onPick(mini.dataset.kind, mini.dataset.daykey, mini.dataset.pick, mini.classList.contains('active'));
      }
      return;
    }
    const alt = e.target.closest('.alt');
    if (alt) { cb.onFocusPoi(alt.dataset.poi); return; }
    const stop = e.target.closest('.stop');
    if (stop) cb.onFocusStop(Number(stop.dataset.mile), stop.dataset.poi || null);
  });

  els.ridesPanel.addEventListener('click', (e) => {
    const card = e.target.closest('.ride-card');
    if (card) cb.onFocusRide(card.dataset.ride);
  });

  els.btnShare.addEventListener('click', () => cb.onShare());
  els.btnGpx.addEventListener('click', () => cb.onGpx());
  els.btnRefresh.addEventListener('click', () => cb.onRefresh());
  els.btnName.addEventListener('click', () => cb.onName());

  els.sheetHandle.addEventListener('click', () => {
    els.panel.classList.toggle('expanded');
    els.sheetHandle.classList.toggle('up', els.panel.classList.contains('expanded'));
    cb.onSheetToggle();
  });

  function paintSlider(s) {
    const v = Number(s.input.value), min = Number(s.input.min), max = Number(s.input.max);
    s.input.style.setProperty('--pct', `${((v - min) / (max - min)) * 100}%`);
    s.out.innerHTML = `${s.fmt(v)}<small>${s.unit}</small>`;
  }

  // ---- render ----

  function render(ctx) {
    const { state, route, plan, plans, dateOffsets } = ctx;
    const cfg = state.cfg;

    for (const [key, s] of Object.entries(els.sliders)) {
      if (dragging === key) continue;
      if (Number(s.input.value) !== cfg[key]) s.input.value = cfg[key];
      paintSlider(s);
    }
    if (document.activeElement !== els.inDepart) els.inDepart.value = cfg.departTime;
    if (document.activeElement !== els.inDate) els.inDate.value = cfg.startDate;
    if (document.activeElement !== els.inStay) els.inStay.value = cfg.stayDays;
    els.inReserve.value = String(cfg.reservePct);

    els.computed.innerHTML =
      `≈ <b>${Math.round(plan.totals.milesPerDay)} mi/day</b> · effective range ` +
      `<b>${Math.round(plan.totals.effRange)} mi</b> (${cfg.reservePct}% reserve) · ` +
      `<b>${plan.totals.fuelStops}</b> fuel stops this leg`;

    // tabs + preset
    for (const t of els.tabs.querySelectorAll('.tab')) {
      t.classList.toggle('active', t.dataset.dir === state.dir);
    }
    els.retPreset.hidden = state.dir !== 'ret';
    for (const r of els.retPreset.querySelectorAll('input')) {
      r.checked = r.value === cfg.returnPreset;
    }

    // summary
    const lastDay = plan.days[plan.days.length - 1];
    els.summary.innerHTML = [
      stat(Math.round(plan.totals.miles), 'mi this leg'),
      stat(plan.days.length, `day${plan.days.length > 1 ? 's' : ''} riding`),
      stat(plan.totals.fuelStops, 'fuel stops'),
      stat(minToTime(lastDay.arriveMin).replace(' ', '&hairsp;'), state.dir === 'out' ? 'at the Dragon' : 'home'),
    ].join('');

    // warnings + closure notices
    const rows = [];
    for (const det of route.detours || []) {
      const extra = Math.round((det.endMile - det.startMile) - (det.toMp - det.fromMp));
      rows.push(`<div class="notice">Parkway closed MP ${det.fromMp}–${det.toMp} — route detours (${extra >= 0 ? '+' : ''}${extra} mi). ${esc(det.note)}</div>`);
    }
    for (const adv of route.advisories || []) {
      rows.push(`<div class="notice">MP ${adv.fromMp}–${adv.toMp}: ${esc(adv.note)}</div>`);
    }
    for (const w of plan.warnings.slice(0, 5)) {
      rows.push(`<div class="warning">${esc(w.msg)}</div>`);
    }
    els.warnings.innerHTML = rows.join('');

    // toggle chips + budget selector
    for (const chip of els.toggles.querySelectorAll('.chip[data-cat]')) {
      chip.classList.toggle('on', !!state.toggles[chip.dataset.cat]);
    }
    for (const chip of els.toggles.querySelectorAll('.chip[data-tier]')) {
      chip.classList.toggle('on', Number(chip.dataset.tier) === (cfg.maxTier || 0));
    }

    // itinerary
    els.itinerary.innerHTML = plan.days.map((day, i) => dayCard(ctx, day, i, dateOffsets)).join('');

    // famous rides
    renderRides(ctx);

    // riders + name chip
    els.riders.innerHTML = (state.riders || [])
      .slice(0, 8)
      .map((r) => `<span class="avatar" style="background:${r.color || '#9aa1ac'}" title="${esc(r.name || 'rider')}">${esc((r.name || '?')[0].toUpperCase())}</span>`)
      .join('');
    els.btnName.textContent = state.rider.name ? `🏍 ${state.rider.name}` : 'Set your name';
  }

  function stat(v, k) {
    return `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`;
  }

  function renderRides(ctx) {
    const rides = ctx.rides || [];
    if (!rides.length || !ctx.state.toggles.rides) { els.ridesPanel.innerHTML = ''; return; }
    const cards = rides.map((r) => {
      const closed = r.currentlyRideable === false;
      const dist = r.nearDealsGapMi != null
        ? (r.nearDealsGapMi < 1 ? 'at base camp' : `${Math.round(r.nearDealsGapMi)} mi from base`)
        : '';
      const curves = r.curves ? `<div class="curves">${r.curves} curves</div>` : '';
      const diff = `<span class="diff" style="background:${DIFF_COLOR[r.difficulty] || '#9aa1ac'}">${DIFF_LABEL[r.difficulty] || r.difficulty}</span>`;
      return `<article class="ride-card${closed ? ' closed' : ''}" data-ride="${esc(r.id)}">
        <div class="rname">${esc(r.name)}</div>
        <div class="rroad">${esc(r.road)}${r.region ? ' · ' + esc(r.region) : ''}</div>
        <div class="rmeta">${Math.round(r.lengthMi)} mi${curves}<div>${dist}</div></div>
        <div class="rblurb">${esc(r.blurb)}</div>
        <div class="rstat${closed ? ' warn' : ''}">${diff} ${closed ? '⚠ ' : ''}${esc(r.status)}</div>
      </article>`;
    }).join('');
    els.ridesPanel.innerHTML =
      `<div class="rides-head"><h2><span class="ride-accent">▲</span> Legendary Rides</h2>` +
      `<span class="count">${rides.length} near your route</span></div>${cards}`;
  }

  function dayCard(ctx, day, i, dateOffsets) {
    const { state, route } = ctx;
    const dateStr = fmtDate(state.cfg.startDate, dateOffsets + i);
    const color = DAY_COLORS[i % DAY_COLORS.length];
    const head = `
      <div class="day-head">
        <div class="day-title"><span class="day-color" style="background:${color}"></span>Day ${i + 1} <span style="color:var(--ink-faint)">· ${dateStr}</span></div>
        <div class="day-meta">${Math.round(day.miles)} mi · ${day.ridingHrs.toFixed(1)} h saddle<br>
        ${minToTime(day.departMin)} → ~${minToTime(day.arriveMin)}</div>
      </div>`;
    const stops = day.stops.map((s, si) => stopRow(ctx, day, s, `${state.dir}:${i}:${s.type}:${si}`)).join('');
    return `<article class="day-card">${head}${dayExtras(day)}<ul class="stops">${stops}</ul></article>`;
  }

  function dayExtras(day) {
    const sun = day.sun
      ? `<span class="sun" title="Sunrise / sunset along this day's stretch">☀️ ${minToTime(day.sun.riseMin)} &nbsp;🌙 ${minToTime(day.sun.setMin)}</span>`
      : '';
    let wx;
    if (day.wx == null) {
      wx = `<span class="wx-pending">fetching forecast…</span>`;
    } else if (!day.wx.length || day.wx.every((s) => !s.fc)) {
      wx = `<span class="wx-na">forecast opens closer to ${esc(day.dateISO || 'the date')}</span>`;
    } else {
      const LBL = { start: 'dep', mid: 'mid', end: 'arr' };
      wx = `<span class="wx-strip">` + day.wx.filter((s) => s.fc).map((s) =>
        `<span class="wx-chip" title="${esc(s.fc.short)} · wind ${esc(s.fc.wind || '–')}">` +
        `<span class="lbl">${LBL[s.at]}</span>${wxIcon(s.fc.short)} ${s.fc.t}°` +
        `${s.fc.pop ? `<em>${s.fc.pop}%</em>` : ''}</span>`
      ).join('') + `</span>`;
    }
    return `<div class="day-extras">${sun}${wx}</div>`;
  }

  function stopRow(ctx, day, s, key) {
    const { route, state } = ctx;
    const e = s.chosen;
    const cat = e ? e.poi.cat : (s.type === 'lodging' ? 'lodging' : s.type === 'lunch' ? 'food' : 'fuel');
    const label = s.type === 'fuel' ? 'Fuel' : s.type === 'lunch' ? 'Lunch' : (s.baseCamp ? 'Base camp' : 'Night');
    const name = e ? (e.poi.name || CAT_LABEL[e.poi.cat]) : `No ${label.toLowerCase()} option found`;
    const mp = mileToBrpMp(route, s.mile);
    const where = mp != null ? `MP ${Math.round(mp)}` : `mi ${Math.round(s.mile)}`;
    const off = e && e.o > 0.15 ? ` · ${e.o.toFixed(1)} mi off` : '';
    const votes = e ? voteBadge(ctx, e.poi.id) : '';
    const nAlts = s.candidates.length;
    const altBtn = nAlts > (e ? 1 : 0)
      ? `<button class="alt-btn" data-key="${key}">${nAlts} option${nAlts > 1 ? 's' : ''}</button>` : '';
    const altsOpen = expanded.has(key);
    const alts = altsOpen ? `<div class="alts">${s.candidates.map((c) => altRow(ctx, day, s, c)).join('')}</div>` : '';
    return `
      <li class="stop" data-mile="${s.mile}" ${e ? `data-poi="${e.poi.id}"` : ''}>
        <span class="eta">${minToTime(s.etaMin)}</span>
        <span class="glyph">${GLYPHS[cat] ? GLYPHS[cat].replace('#16130c', catColor(cat)) : ''}</span>
        <span class="what">
          <span class="nm ${e ? '' : 'missing'}">${esc(name)}</span>
          <span class="sub">${label} · ${where}${off}${s.isPick ? ' · <span class="pickmark">★ group pick</span>' : ''}</span>
        </span>
        <span class="acts">${votes}${altBtn}</span>
        ${alts}
      </li>`;
  }

  function altRow(ctx, day, s, c) {
    const id = c.poi.id;
    const picked = s.chosen && s.chosen.poi.id === id && s.isPick;
    const kind = s.type === 'fuel' ? 'fuel' : s.type === 'lunch' ? 'lunch' : 'lodging';
    const v = ctx.state.votes[id];
    const tier = c.tier ? `<span class="tier">${TIER_LABEL[c.tier]}</span> ` : '';
    return `
      <div class="alt" data-poi="${id}">
        <span class="nm">${tier}${esc(c.poi.name || CAT_LABEL[c.poi.cat])}</span>
        <span class="meta">${c.o.toFixed(1)} mi off</span>
        <button class="mini ${v?.mine ? 'active' : ''}" data-vote="${id}" title="${esc((v?.names || []).join(', '))}">👍${v?.count ? ' ' + v.count : ''}</button>
        <button class="mini ${picked ? 'active' : ''}" data-pick="${id}" data-kind="${kind}" data-daykey="${day.idx}">${picked ? 'Picked' : 'Pick'}</button>
      </div>`;
  }

  function voteBadge(ctx, id) {
    const v = ctx.state.votes[id];
    if (!v?.count) return '';
    return `<span class="votebadge has" title="${esc((v.names || []).join(', '))}">👍 ${v.count}</span>`;
  }

  async function askName(current) {
    els.inName.value = current || '';
    els.nameModal.showModal();
    return new Promise((resolve) => {
      els.nameModal.addEventListener('close', () => resolve(els.inName.value.trim() || null), { once: true });
    });
  }

  return { render, askName, isDragging: () => dragging !== null };
}

function catColor(cat) {
  return { fuel: '#ffb02e', food: '#ff6a59', lodging: '#5fa8ff', camping: '#58c98a' }[cat] || '#a7adb8';
}

function fmtDate(iso, offsetDays) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? new Date(iso + 'T12:00:00') : new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
