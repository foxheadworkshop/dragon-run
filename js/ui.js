// Panel UI: sliders, summary, warnings, itinerary, riders, dialogs, toasts.

import { minToTime } from './engine.js';
import { mileToBrpMp } from './route.js';
import { GLYPHS, DAY_COLORS } from './map.js';
import { CAT_LABEL, TIER_LABEL } from './poi.js';
import { wxIcon } from './weather.js';
import { DIFF_LABEL, DIFF_COLOR } from './rides.js';
import { SIGHT_LABEL } from './sights.js';
import { formatUsd, parseUsd, rosterFor, mySettlement } from './split.js';

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
    aheadPanel: $('#aheadPanel'),
    ridesPanel: $('#ridesPanel'),
    sightsPanel: $('#sightsPanel'),
    rosterPanel: $('#rosterPanel'),
    costsPanel: $('#costsPanel'),
    fuelOverride: $('#fuelOverride'),
    fuelNote: $('#fuelNote'),
    offlinePanel: $('#offlinePanel'),
    offlineDot: $('#offlineDot'),
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
  let costsMounted = false, rosterMounted = false, aheadMounted = false;
  let pwa = null;                 // set by app via setPwa() once the SW glue is ready

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

  els.aheadPanel.addEventListener('click', (e) => {
    if (e.target.closest('#ah-locate')) { cb.onAheadLocate(); return; }
    if (e.target.closest('#ah-refresh')) { cb.onAheadRefresh(); return; }
    const item = e.target.closest('.ah-item');
    if (item) cb.onFocusPoi(item.dataset.poi);
  });

  els.ridesPanel.addEventListener('click', (e) => {
    const card = e.target.closest('.ride-card');
    if (card) cb.onFocusRide(card.dataset.ride);
  });
  els.sightsPanel.addEventListener('click', (e) => {
    const card = e.target.closest('.sight-card');
    if (card) cb.onFocusSight(card.dataset.sight);
  });

  els.fuelOverride.addEventListener('change', () => cb.onFuelOverride(els.fuelOverride.checked));

  els.offlinePanel.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || !pwa) return;
    if (btn.dataset.act === 'install') pwa.install();
    else if (btn.dataset.act === 'update') pwa.update();
    else if (btn.dataset.act === 'clear-tiles') pwa.clearTiles();
  });

  // ---- roster panel (event delegation) ----
  els.rosterPanel.addEventListener('click', (e) => {
    const add = e.target.closest('#rd-add');
    if (add) { cb.onRiderAdd(); return; }
    const del = e.target.closest('.rd-del');
    if (del) { cb.onRiderRemove(del.dataset.uid); return; }
    const rsvp = e.target.closest('[data-rsvp]');
    if (rsvp) { cb.onRiderRsvp(rsvp.closest('[data-uid]').dataset.uid, rsvp.dataset.rsvp); return; }
    const pin = e.target.closest('#stg-pin');
    if (pin) { cb.onStagingPin(); return; }
  });
  els.rosterPanel.addEventListener('change', (e) => {
    const t = e.target;
    if (t.classList.contains('rd-name')) cb.onRiderEdit(t.dataset.uid, { name: t.value.slice(0, 40) });
    else if (t.classList.contains('rd-bike')) cb.onRiderEdit(t.dataset.uid, { bike: t.value.slice(0, 60) });
    else if (t.classList.contains('rd-tank-in')) cb.onRiderEdit(t.dataset.uid, { tankRangeMi: Math.max(60, Math.min(300, Number(t.value) || 130)) });
    else if (t.classList.contains('stg-label')) cb.onStagingSet({ label: t.value.slice(0, 80) });
    else if (t.classList.contains('stg-time')) cb.onStagingSet({ time: t.value });
  });

  // ---- costs panel (event delegation) ----
  els.costsPanel.addEventListener('click', (e) => {
    const addBtn = e.target.closest('#ce-add');
    if (addBtn) { submitExpense(); return; }
    const sh = e.target.closest('.sharer-chip');
    if (sh) { cb.onToggleSharer(sh.dataset.exp, sh.dataset.uid); return; }
    const del = e.target.closest('.ce-del');
    if (del) { cb.onDeleteExpense(del.dataset.exp); return; }
  });

  // Post an expense with just the payer opted in; everyone else opts in afterward.
  function submitExpense() {
    const form = els.costsPanel.querySelector('.ce-form');
    if (!form) return;
    const title = form.querySelector('.ce-title').value.trim().slice(0, 60);
    const cents = parseUsd(form.querySelector('.ce-amount').value);
    const payer = form.querySelector('.ce-payer').value;
    if (!cents) { showToast('Enter a dollar amount'); return; }
    cb.onAddExpense({ title: title || 'Expense', amountCents: cents, payer, sharers: [payer] });
  }

  els.btnShare.addEventListener('click', () => cb.onShare());
  els.btnGpx.addEventListener('click', () => cb.onGpx());
  els.btnRefresh.addEventListener('click', () => cb.onRefresh());
  els.btnName.addEventListener('click', () => cb.onName());

  els.sheetHandle.addEventListener('click', () => {
    els.panel.classList.toggle('expanded');
    els.sheetHandle.classList.toggle('up', els.panel.classList.contains('expanded'));
    cb.onSheetToggle();
  });

  // Persist collapse open/closed state for the static sections.
  for (const el of document.querySelectorAll('details.collapse[id]')) wireCollapse(el);

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

    // fuel-range source note + override checkbox
    if (document.activeElement !== els.fuelOverride) els.fuelOverride.checked = !!cfg.fuelOverride;
    if (cfg.fuelOverride) {
      els.fuelNote.innerHTML = `<span class="fn-amber">manual override</span> — planning at ${cfg.tankRangeMi} mi`;
    } else if (ctx.fuelSource === 'roster' && ctx.fuelBike) {
      const who = ctx.fuelBike.uid === state.rider.uid ? 'your bike' : esc(ctx.fuelBike.name || 'a rider') + (ctx.fuelBike.bike ? ' · ' + esc(ctx.fuelBike.bike) : '');
      els.fuelNote.innerHTML = `range set by <span class="fn-amber">${who}</span> (${ctx.effFuel} mi — thirstiest)`;
    } else {
      els.fuelNote.innerHTML = `set from the roster — add bikes below`;
    }

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
    const dest = state.dir === 'out' ? 'Deals Gap' : 'home';
    els.summary.innerHTML = [
      stat(Math.round(plan.totals.miles), 'mi this leg', `Total riding distance ${state.dir === 'out' ? 'out to Deals Gap' : 'home'} (one way)`),
      stat(plan.days.length, `day${plan.days.length > 1 ? 's' : ''} riding`, 'Riding days this leg — driven by saddle time × pace'),
      stat(plan.totals.fuelStops, 'fuel stops', 'Suggested fuel stops, spaced within your tank range'),
      stat(minToTime(lastDay.arriveMin).replace(' ', '&hairsp;'), state.dir === 'out' ? 'at the Dragon' : 'home', `Estimated arrival at ${dest} on the final day`),
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

    // roster + costs + offline
    renderRoster(ctx);
    renderCosts(ctx);
    renderOffline(ctx);

    // riders avatar strip — online only (within 5 min)
    const now = Date.now();
    els.riders.innerHTML = (state.riders || [])
      .filter((r) => !r.lastSeen || now - r.lastSeen < 5 * 60 * 1000)
      .slice(0, 8)
      .map((r) => `<span class="avatar" style="background:${r.color || '#9aa1ac'}" title="${esc(r.name || 'rider')}">${esc((r.name || '?')[0].toUpperCase())}</span>`)
      .join('');
    els.btnName.textContent = state.rider.name ? `🏍 ${state.rider.name}` : 'Set your name';
  }

  function stat(v, k, tip) {
    return `<div class="stat"${tip ? ` title="${esc(tip)}"` : ''}><div class="v">${v}</div><div class="k">${k}</div></div>`;
  }

  // Rides are static — mounted once, not re-rendered on slider changes. The list
  // lives in a collapsed <details> so it doesn't bloat the panel until wanted.
  function mountRides(rides) {
    if (!rides || !rides.length) { els.ridesPanel.innerHTML = ''; return; }
    const cards = rides.map((r) => {
      const closed = r.currentlyRideable === false;
      const dist = r.nearDealsGapMi != null
        ? (r.nearDealsGapMi < 1 ? 'at base camp' : `${Math.round(r.nearDealsGapMi)} mi from base`)
        : '';
      const curves = r.curves ? `<div class="curves">${r.curves} curves</div>` : '';
      const diff = `<span class="diff" style="background:${DIFF_COLOR[r.difficulty] || '#9aa1ac'}">${DIFF_LABEL[r.difficulty] || r.difficulty}</span>`;
      const shortStatus = String(r.status || '').split('. ')[0].replace(/\.$/, '');
      return `<article class="ride-card${closed ? ' closed' : ''}" data-ride="${esc(r.id)}" title="Tap to show this ride on the map">
        <div class="rname">${esc(r.name)}</div>
        <div class="rroad">${esc(r.road)}${r.region ? ' · ' + esc(r.region) : ''}</div>
        <div class="rmeta">${Math.round(r.lengthMi)} mi${curves}<div>${dist}</div></div>
        <div class="rblurb">${esc(r.blurb)}</div>
        <div class="rstat${closed ? ' warn' : ''}" title="${esc(r.status)}">${diff} ${closed ? '⚠ ' : ''}${esc(shortStatus)}</div>
      </article>`;
    }).join('');
    els.ridesPanel.innerHTML =
      `<details class="collapse rides-collapse" id="cd-rides">
        <summary><span class="ride-accent">▲</span> Legendary Rides <span class="count">${rides.length} famous roads near you</span></summary>
        <div class="rides-body">${cards}</div>
      </details>`;
    wireCollapse(document.getElementById('cd-rides'));
  }

  function setRidesVisible(on) { els.ridesPanel.hidden = !on; }

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
    return `<div class="day-extras">${sun}${wx}${elevSparkline(day.elev)}</div>`;
  }

  function elevSparkline(elev) {
    if (!elev || elev.points.length < 2) return '';
    const W = 240, H = 34, PAD = 2;
    const xs = elev.points.map((p) => p[0]);
    const minX = xs[0], maxX = xs[xs.length - 1], spanX = Math.max(1e-6, maxX - minX);
    const lo = elev.minFt, hi = elev.maxFt, spanY = Math.max(1, hi - lo);
    const px = (mi) => (PAD + ((mi - minX) / spanX) * (W - 2 * PAD)).toFixed(1);
    const py = (ft) => (PAD + (1 - (ft - lo) / spanY) * (H - 2 * PAD)).toFixed(1);
    const pts = elev.points.map((p) => `${px(p[0])},${py(p[1])}`);
    const line = `M${pts.join(' L')}`;
    const area = `M${px(minX)},${H} L${pts.join(' L')} L${px(maxX)},${H} Z`;
    const hot = elev.maxFt >= 4500;
    const stroke = hot ? 'var(--ember)' : 'var(--amber)';
    return `<span class="day-elev" title="Elevation ${elev.minFt.toLocaleString()}–${elev.maxFt.toLocaleString()} ft · +${elev.gainFt.toLocaleString()} ft climb this day">
      <svg class="elev-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <path d="${area}" fill="${stroke}" fill-opacity="0.13"></path>
        <path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"></path>
      </svg>
      <span class="elev-stat">⛰ ${elev.maxFt.toLocaleString()}<small> ft · +${elev.gainFt.toLocaleString()} climb</small>${hot ? ' <span class="elev-hi">layers up</span>' : ''}</span>
    </span>`;
  }

  // ---- sights panel (static, mounted once like rides) ----
  function mountSights(sights) {
    if (!sights || !sights.length) { els.sightsPanel.innerHTML = ''; return; }
    const near = sights.filter((s) => s.nearDealsGapMi != null && s.nearDealsGapMi <= 25);
    const along = sights.filter((s) => !(s.nearDealsGapMi != null && s.nearDealsGapMi <= 25));
    const card = (s) => {
      const t = s.tags || {};
      const where = s.nearDealsGapMi != null && s.nearDealsGapMi < 1 ? 'at Deals Gap'
        : s.nearDealsGapMi != null ? `${Math.round(s.nearDealsGapMi)} mi from base` : '';
      return `<article class="sight-card sc-${s.cat}" data-sight="${esc(s.id)}" title="Tap to show on the map">
        <div class="scname">${esc(s.name || SIGHT_LABEL[s.cat] || 'Sight')}</div>
        <div class="scsub">${SIGHT_LABEL[s.cat] || ''}${where ? ' · ' + where : ''}</div>
        ${t.description ? `<div class="scblurb">${esc(t.description)}</div>` : ''}
      </article>`;
    };
    const group = (title, list) => list.length ? `<div class="sight-group">${title}</div>${list.map(card).join('')}` : '';
    els.sightsPanel.innerHTML =
      `<details class="collapse sights-collapse" id="cd-sights">
        <summary><span class="sight-accent">◆</span> Sights <span class="count">${sights.length} stops worth a look</span></summary>
        <div class="sights-body">${group('Around Deals Gap', near)}${group('Along the route', along)}</div>
      </details>`;
    wireCollapse(document.getElementById('cd-sights'));
  }
  function setSightsVisible(on) { els.sightsPanel.hidden = !on; }

  // ---- "ride ahead" panel ----
  // info: null / { tracking } when idle, or { tracking, min, mp, targetMile,
  // etaText, offRoute, atEnd, results:[{poi,m,o,tier,dAhead}] } when located.
  function renderAhead(info) {
    if (!els.aheadPanel) return;
    let note, body;
    if (!info || !info.tracking) {
      note = 'find your spot';
      body = `<div class="ah-empty">Tap the <span class="ah-cross">⌖</span> locate button on the map — then I'll show gas, food &amp; hotels about an hour up the route from where you are, matching your Map layers. <button class="btn btn-small" id="ah-locate">Locate me</button></div>`;
    } else if (!info.results) {
      note = info.offRoute ? 'off route' : 'locating…';
      body = `<div class="ah-empty">${esc(info.note || 'Looking for your spot on the route…')}</div>`;
    } else {
      const where = info.mp != null ? `MP ${Math.round(info.mp)}` : `mile ${Math.round(info.targetMile)}`;
      note = `~${fmtDurMin(info.min)} ahead`;
      const callout = info.offRoute
        ? `<div class="ah-callout">⚠ You're ~${info.offMi} mi off the route line — this assumes you rejoin it. Check the right direction (Outbound / Return) is selected.</div>`
        : '';
      const flags = info.atEnd ? ' · end of route' : '';
      const head = `<div class="ah-head">In <b>~${fmtDurMin(info.min)}</b> you'll be near <b>${where}</b>${info.etaText ? ` · ~${esc(info.etaText)}` : ''}${flags}</div>`;
      const list = info.results.length
        ? `<div class="ah-list">${info.results.map(aheadItem).join('')}</div>`
        : `<div class="ah-empty">No matching stops within ~30 min of that spot — try <b>+</b> on the map, or pull fresh data.</div>`;
      body = `${callout}${head}${list}<button class="btn btn-small" id="ah-refresh">Pull fresh places here</button>`;
    }
    if (!aheadMounted) {
      els.aheadPanel.innerHTML = `<details class="collapse" id="cd-ahead" open><summary>📍 Ride ahead <span class="count">${note}</span></summary><div class="ahead-body">${body}</div></details>`;
      wireCollapse(document.getElementById('cd-ahead'));
      aheadMounted = true;
    } else {
      const cn = els.aheadPanel.querySelector('#cd-ahead > summary .count');
      if (cn) cn.textContent = note;
      const bodyEl = els.aheadPanel.querySelector('.ahead-body');
      if (bodyEl) bodyEl.innerHTML = body;
    }
  }

  function aheadItem(e) {
    const cat = e.poi.cat;
    const glyph = GLYPHS[cat] ? GLYPHS[cat].replace('#16130c', catColor(cat)) : '';
    const tier = e.tier ? `<span class="tier">${TIER_LABEL[e.tier]}</span> ` : '';
    const off = e.o > 0.15 ? ` · ${e.o.toFixed(1)} mi off` : '';
    const ahead = e.dAhead == null ? ''
      : Math.abs(e.dAhead) < 0.5 ? 'right there'
      : e.dAhead >= 0 ? `${Math.round(e.dAhead)} mi past` : `${Math.round(-e.dAhead)} mi before`;
    return `<button class="ah-item" data-poi="${esc(e.poi.id)}" title="Show on the map">
      <span class="ah-glyph">${glyph}</span>
      <span class="ah-name">${tier}${esc(e.poi.name || CAT_LABEL[cat])}</span>
      <span class="ah-meta">${esc(CAT_LABEL[cat])}${ahead ? ' · ' + ahead : ''}${off}</span>
    </button>`;
  }

  function setPwa(p) { pwa = p; }

  function renderOffline(ctx) {
    const { state } = ctx;
    els.offlineDot.classList.toggle('show', !!state.offline);
    const rows = [];
    rows.push(`<div class="off-row"><span class="off-status ${state.offline ? 'off-off' : 'off-ok'}">${state.offline ? '● Offline — using saved data' : '● Online'}</span></div>`);
    if (pwa?.updateReady || state.swUpdate) rows.push(`<div class="off-row"><button class="btn btn-small btn-primary" data-act="update">Update now</button> <span>A newer version is ready.</span></div>`);
    if (pwa?.installable && !pwa.isStandalone?.()) rows.push(`<div class="off-row"><button class="btn btn-small btn-primary" data-act="install">Install app</button> <span>Add to your home screen.</span></div>`);
    rows.push(`<div class="off-row">Route, places, rides &amp; sights are saved on this device, so the planner opens with no signal — perfect for Deals Gap. Map tiles cache as you pan around.</div>`);
    rows.push(`<div class="off-row"><button class="btn btn-small" data-act="clear-tiles">Clear cached tiles</button></div>`);
    els.offlinePanel.innerHTML = rows.join('');
  }

  // ---- riders & bikes ----
  const rsvpRank = (r) => ({ in: 0, maybe: 1, out: 2 }[r.rsvp] ?? 0);

  function renderRoster(ctx) {
    const { state, fuelBike } = ctx;
    // don't stomp an input the user is editing
    if (rosterMounted && els.rosterPanel.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    const roster = [...state.roster].sort((a, b) =>
      (a.uid === state.rider.uid ? -1 : b.uid === state.rider.uid ? 1 : 0) ||
      rsvpRank(a) - rsvpRank(b) || (Number(a.tankRangeMi) - Number(b.tankRangeMi)));
    const inCount = roster.filter((r) => r.rsvp === 'in').length;
    const setterUid = state.cfg.fuelOverride ? null : fuelBike?.uid;
    const stg = state.staging || {};
    const rows = roster.map((r) => {
      const isSelf = r.uid === state.rider.uid;
      const setsRange = r.uid === setterUid;
      const seg = ['in', 'maybe', 'out'].map((v) =>
        `<button data-rsvp="${v}" class="${r.rsvp === v ? 'on' : ''}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('');
      return `<div class="rider-row${setsRange ? ' sets-range' : ''}" data-uid="${esc(r.uid)}">
        <span class="avatar" style="background:${r.color || '#9aa1ac'}">${esc((r.name || '?')[0].toUpperCase())}</span>
        <input class="rd-name" data-uid="${esc(r.uid)}" value="${esc(r.name)}" placeholder="Name" maxlength="40">
        <input class="rd-bike" data-uid="${esc(r.uid)}" value="${esc(r.bike)}" placeholder="Bike (e.g. KTM 790)" maxlength="60">
        <label class="rd-tank"><input type="number" class="rd-tank-in" data-uid="${esc(r.uid)}" min="60" max="300" step="5" value="${Math.round(r.tankRangeMi)}"><small>mi</small></label>
        <div class="rsvp seg" data-uid="${esc(r.uid)}">${seg}</div>
        ${setsRange ? '<span class="range-badge" title="Thirstiest bike — sets the group fuel range">⛽ sets range</span>' : ''}
        ${isSelf ? '<span class="you-tag">you</span>' : `<button class="rd-del" data-uid="${esc(r.uid)}" title="Remove">×</button>`}
      </div>`;
    }).join('');
    const body = `<div class="roster-body">${rows}
      <button id="rd-add" class="btn btn-small">+ Add a bike</button>
      <div class="staging">
        <label>Meetup <input class="stg-label" value="${esc(stg.label || '')}" placeholder="QuikTrip on Plank Rd"></label>
        <label>Time <input type="time" class="stg-time" value="${esc(stg.time || '')}"></label>
        <button id="stg-pin" class="btn btn-small">${stg.lat != null ? 'Move pin 📍' : 'Drop pin on map'}</button>
      </div></div>`;
    const note = `${inCount} in · thirstiest sets fuel`;
    if (!rosterMounted) {
      els.rosterPanel.innerHTML = `<details class="collapse" id="cd-roster"><summary>Riders &amp; bikes <span class="sum-note">${note}</span></summary>${body}</details>`;
      wireCollapse(document.getElementById('cd-roster'));
      rosterMounted = true;
    } else {
      const sn = els.rosterPanel.querySelector('#cd-roster > summary .sum-note');
      if (sn) sn.textContent = note;
      const bodyEl = els.rosterPanel.querySelector('.roster-body');
      if (bodyEl) bodyEl.outerHTML = body;
    }
  }

  // ---- trip costs ----
  function renderCosts(ctx) {
    const { state, costs } = ctx;
    if (!costs) return;
    if (costsMounted && els.costsPanel.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return;
    const roster = costs.roster;
    const nameOf = (uid) => roster.find((r) => r.uid === uid)?.name || 'rider';
    const colorOf = (uid) => roster.find((r) => r.uid === uid)?.color || '#9aa1ac';
    const myBal = costs.myBalance;
    const mine = mySettlement(costs.transfers, state.rider.uid);
    // When a debtor's payment to me is less than their full debt, it's because the
    // rest goes to another person who's also owed — surface that so the number makes sense.
    const otherPays = (debtorUid) => {
      const others = costs.transfers.filter((t) => t.from === debtorUid && t.to !== state.rider.uid);
      return others.length ? ` <span class="settle-also">· also pays ${others.map((t) => esc(nameOf(t.to)) + ' ' + formatUsd(t.amountCents)).join(', ')}</span>` : '';
    };
    const settle = (mine.iOwe.length || mine.owedToMe.length)
      ? [...mine.iOwe.map((t) => `<div class="settle owe"><span class="sdot" style="background:${colorOf(t.uid)}"></span>You owe <b>${esc(nameOf(t.uid))}</b> <span class="amt">${formatUsd(t.amountCents)}</span></div>`),
         ...mine.owedToMe.map((t) => `<div class="settle owed"><span class="sdot" style="background:${colorOf(t.uid)}"></span><b>${esc(nameOf(t.uid))}</b> owes you <span class="amt">${formatUsd(t.amountCents)}</span>${otherPays(t.uid)}</div>`)].join('')
      : `<div class="settle ok">You're all settled up 🤝</div>`;
    const headline = `<div class="cost-net ${myBal >= 0 ? 'up' : 'down'}">${myBal === 0 ? 'Settled up' : myBal > 0 ? `You're owed ${formatUsd(myBal)}` : `You owe ${formatUsd(-myBal)}`}</div>`;

    // Everyone's net balance (the ground truth: what each rider paid − their share).
    const balRows = [...costs.balances.entries()].filter(([, c]) => c !== 0).sort((a, b) => b[1] - a[1])
      .map(([uid, c]) => `<div class="bal-row"><span class="sdot" style="background:${colorOf(uid)}"></span><span class="bal-name">${uid === state.rider.uid ? 'You' : esc(nameOf(uid))}</span><span class="bal-amt ${c >= 0 ? 'up' : 'down'}">${c >= 0 ? '+' : '−'}${formatUsd(Math.abs(c))}</span></div>`).join('');
    const balances = balRows
      ? `<div class="cost-section-l">Everyone's balance</div><div class="bal-list">${balRows}</div><div class="bal-note">balance = what they paid − their share of the expenses they joined. Positive = owed money.</div>`
      : '';

    const form = `<div class="ce-form">
      <input class="ce-title" maxlength="60" placeholder="What was it? (Hotel, dinner…)">
      <div class="ce-row">
        <input class="ce-amount" type="number" inputmode="decimal" step="0.01" min="0" placeholder="$ amount">
        <label class="ce-payer-l">Paid by <select class="ce-payer">${roster.map((r) => `<option value="${esc(r.uid)}"${r.uid === state.rider.uid ? ' selected' : ''}>${esc(r.name || 'me')}</option>`).join('')}</select></label>
      </div>
      <button id="ce-add" class="btn btn-primary btn-small">Post expense</button>
      <div class="ce-hint">Posts with just the payer in. Everyone who shared taps to opt in below — it splits evenly among them.</div>
    </div>`;

    const expenses = Object.values(state.expenses || {}).sort((a, b) => b.createdAt - a.createdAt);
    const list = expenses.length ? expenses.map((e) => {
      const n = e.sharers.length || 1;
      const per = Math.round(e.amountCents / n);
      const chips = roster.map((r) => `<button class="sharer-chip ${e.sharers.includes(r.uid) ? 'on' : ''}${r.uid === state.rider.uid ? ' me' : ''}" data-exp="${esc(e.id)}" data-uid="${esc(r.uid)}" title="${e.sharers.includes(r.uid) ? 'In — tap to drop' : 'Out — tap to join'}">${esc(r.name || 'rider')}</button>`).join('');
      const del = e.createdBy === state.rider.uid ? `<button class="ce-del" data-exp="${esc(e.id)}" title="Delete">🗑</button>` : '';
      return `<div class="cost-row">
        <div class="cr-head"><span class="cr-title">${esc(e.title)}</span><span class="cr-amt">${formatUsd(e.amountCents)}</span></div>
        <div class="cr-meta">paid by ${esc(e.payerName || nameOf(e.payer))} · split ${n} ${n === 1 ? 'way' : 'ways'} · ${formatUsd(per)} each ${del}</div>
        <div class="cr-split">${chips}</div>
      </div>`;
    }).join('') : `<div class="ce-empty">No expenses yet — add the first one above.</div>`;

    const note = myBal === 0 ? 'settled up' : myBal > 0 ? `you're owed ${formatUsd(myBal)}` : `you owe ${formatUsd(-myBal)}`;
    const body = `<div class="costs-body">${headline}` +
      `<div class="cost-section-l">Settle up <span class="cost-section-sub">simplest payments</span></div>` +
      `<div class="settle-list">${settle}</div>${balances}${form}<div class="cost-list">${list}</div></div>`;
    if (!costsMounted) {
      els.costsPanel.innerHTML = `<details class="collapse" id="cd-costs"><summary>💵 Trip costs <span class="count">${note}</span></summary>${body}</details>`;
      wireCollapse(document.getElementById('cd-costs'));
      costsMounted = true;
    } else {
      const cn = els.costsPanel.querySelector('#cd-costs > summary .count');
      if (cn) cn.textContent = note;
      const bodyEl = els.costsPanel.querySelector('.costs-body');
      if (bodyEl) bodyEl.outerHTML = body;
    }
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

  return { render, renderAhead, mountRides, setRidesVisible, mountSights, setSightsVisible, setPwa, askName, isDragging: () => dragging !== null };
}

// "45 min" / "1 h" / "1 h 30 min" from a minute count.
function fmtDurMin(min) {
  min = Math.round(min || 0);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// Remember whether a <details class="collapse"> is open across reloads.
function wireCollapse(el) {
  if (!el || !el.id) return;
  const key = 'drc:' + el.id;
  try {
    const s = localStorage.getItem(key);
    if (s === '1') el.open = true;
    else if (s === '0') el.open = false;
  } catch { /* private mode */ }
  el.addEventListener('toggle', () => {
    try { localStorage.setItem(key, el.open ? '1' : '0'); } catch { /* ignore */ }
  });
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
