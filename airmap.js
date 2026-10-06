/* ========================================
   ЕЦП БАС — Карта воздушного пространства
   ========================================
   • Геометрия зон: реальные контуры (OSM), буферы, окружности
   • Навигатор регионов, подписи, переключатель подложки
   • ДЕМО-режим: симуляция бортов с геозоной (не пишет в БД)
   ======================================== */

const AirMap = (() => {
    'use strict';

    // ───────────── Геометрия ─────────────
    const R_LAT = 110540, R_LNG = 111320;

    function toXY(p, o) { return [(p[1] - o[1]) * R_LNG * Math.cos(o[0] * Math.PI / 180), (p[0] - o[0]) * R_LAT]; }
    function toLL(xy, o) { return [o[0] + xy[1] / R_LAT, o[1] + xy[0] / (R_LNG * Math.cos(o[0] * Math.PI / 180))]; }

    function centroid(pts) {
        let la = 0, ln = 0;
        pts.forEach(p => { la += p[0]; ln += p[1]; });
        return [la / pts.length, ln / pts.length];
    }

    function hull(xy) {
        const p = xy.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const lo = [], up = [];
        for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
        for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
        up.pop(); lo.pop();
        return lo.concat(up); // CCW
    }

    /** Буфер (offset) выпуклой оболочки контура на m метров со скруглёнными углами */
    function buffer(pts, m) {
        const o = centroid(pts);
        const h = hull(pts.map(p => toXY(p, o)));
        const out = [];
        const n = h.length;
        for (let i = 0; i < n; i++) {
            const prev = h[(i - 1 + n) % n], cur = h[i], next = h[(i + 1) % n];
            const a1 = Math.atan2(cur[1] - prev[1], cur[0] - prev[0]) - Math.PI / 2;
            let a2 = Math.atan2(next[1] - cur[1], next[0] - cur[0]) - Math.PI / 2;
            while (a2 < a1) a2 += Math.PI * 2;
            const steps = Math.max(1, Math.ceil((a2 - a1) / (Math.PI / 18)));
            for (let s = 0; s <= steps; s++) {
                const a = a1 + (a2 - a1) * s / steps;
                out.push(toLL([cur[0] + Math.cos(a) * m, cur[1] + Math.sin(a) * m], o));
            }
        }
        return out;
    }

    function circle(c, m, seg = 72) {
        const pts = [];
        for (let i = 0; i < seg; i++) {
            const a = i / seg * Math.PI * 2;
            pts.push(toLL([Math.cos(a) * m, Math.sin(a) * m], c));
        }
        return pts;
    }

    function areaM2(pts) {
        const o = centroid(pts);
        const xy = pts.map(p => toXY(p, o));
        let s = 0;
        for (let i = 0; i < xy.length; i++) { const a = xy[i], b = xy[(i + 1) % xy.length]; s += a[0] * b[1] - b[0] * a[1]; }
        return Math.abs(s / 2);
    }

    function pointIn(pt, poly) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
            if (((yi > pt[0]) !== (yj > pt[0])) && (pt[1] < (xj - xi) * (pt[0] - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
    }

    const _geom = {};
    function geom(id) {
        if (_geom[id]) return _geom[id];
        const z = CONFIG.ZONES[id];
        if (!z) return null;
        let g = null;
        if (z.polygon) g = z.polygon;
        else if (z.buffer) g = buffer(geom(z.buffer.of), z.buffer.m);
        else if (z.circle) g = circle(z.circle.center, z.circle.m);
        _geom[id] = g;
        return g;
    }

    function randomPointIn(poly, avoid = []) {
        const lats = poly.map(p => p[0]), lngs = poly.map(p => p[1]);
        const [a, b, c, d] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
        for (let i = 0; i < 200; i++) {
            const p = [a + Math.random() * (b - a), c + Math.random() * (d - c)];
            if (pointIn(p, poly) && !avoid.some(av => pointIn(p, av))) return p;
        }
        return centroid(poly);
    }

    function zonesAt(pt) {
        return Object.keys(CONFIG.ZONES).filter(id => pointIn(pt, geom(id)));
    }

    // ───────────── Карта ─────────────
    let map = null, baseLayer = null;
    const layers = {};           // zoneId → L.Polygon
    const districtLayers = {};   // districtId → L.Polygon
    let onZoneClick = null;
    let activeDistrict = null;
    let activeRegion = null;

    function typeColor(t) { return (CONFIG.ZONE_TYPES[t] || CONFIG.ZONE_TYPES.free).color; }

    function init(containerId, opts = {}) {
        onZoneClick = opts.onZoneClick || null;
        map = L.map(containerId, { zoomControl: false, attributionControl: true, preferCanvas: false })
            .setView(CONFIG.MAP.CENTER, CONFIG.MAP.ZOOM);
        L.control.zoom({ position: 'bottomright' }).addTo(map);
        map.attributionControl.setPrefix('').addAttribution('© 2ГИС Схема / OpenStreetMap · ЕЦП БАС 2026');
        setBase('streets');

        // Отрисовка административных районов Астаны (контуры города как в 2ГИС)
        if (CONFIG.DISTRICTS) {
            for (const [distId, d] of Object.entries(CONFIG.DISTRICTS)) {
                const col = d.color || '#3b82f6';
                const distPoly = L.polygon(d.polygon, {
                    color: col,
                    weight: 2.5,
                    opacity: 0.95,
                    fillColor: col,
                    fillOpacity: 0.08,
                    className: `district-polygon district-${distId}`
                }).addTo(map);

                distPoly.bindTooltip(`<b>${d.name}</b><br><small style="opacity:0.8">${d.desc}</small>`, {
                    permanent: false,
                    direction: 'center',
                    className: 'district-tooltip'
                });

                distPoly.on('mouseover', () => {
                    distPoly.setStyle({ weight: 3.5, fillOpacity: 0.18 });
                });
                distPoly.on('mouseout', () => {
                    if (activeDistrict !== distId) {
                        distPoly.setStyle({
                            weight: activeDistrict ? 1.2 : 2.5,
                            fillOpacity: activeDistrict ? 0.03 : 0.08
                        });
                    }
                });

                distPoly.on('click', (e) => {
                    if (e && e.originalEvent && e.originalEvent.target && e.originalEvent.target.blur) {
                        e.originalEvent.target.blur();
                    }
                    if (document.activeElement && document.activeElement.blur) {
                        document.activeElement.blur();
                    }
                    focusDistrict(distId);
                });
                districtLayers[distId] = distPoly;
            }
        }

        // Отрисовка детальных зон воздушного пространства (парки, здания, объекты)
        const ids = Object.keys(CONFIG.ZONES).sort((a, b) => areaM2(geom(b)) - areaM2(geom(a)));
        for (const id of ids) {
            const z = CONFIG.ZONES[id];
            const r = CONFIG.REGIONS[z.region] || {};
            const col = typeColor(z.type);
            const isPark = r.category === 'park';
            const poly = L.polygon(geom(id), {
                color: isPark ? '#10b981' : (z.type === 'prohibited' ? '#ef4444' : col),
                weight: z.type === 'prohibited' ? 2.8 : (isPark ? 2.8 : 2.2),
                opacity: 0.95,
                fillColor: isPark ? '#10b981' : col,
                fillOpacity: z.type === 'prohibited' ? 0.35 : (isPark ? 0.28 : 0.22),
                dashArray: z.type === 'restricted' ? '6 5' : null,
                className: `zone-path zone-${z.type} ${isPark ? 'zone-park' : ''} ${r.category ? 'zone-' + r.category : ''}`
            }).addTo(map);

            const labelIcon = isPark ? '🌳 ' : (r.category === 'building' ? '🏢 ' : (r.category === 'station' ? '🚆 ' : (r.category === 'airport' ? '✈ ' : '')));
            poly.bindTooltip(`<b>${id}</b> ${labelIcon}${z.name}`, {
                permanent: true,
                direction: 'center',
                className: `zone-label zl-${z.type} ${isPark ? 'zl-park' : ''}`
            });
            poly.bindPopup(() => zonePopup(id), { className: 'zone-popup', maxWidth: 320 });
            poly.on('click', (e) => {
                if (e && e.originalEvent && e.originalEvent.target && e.originalEvent.target.blur) {
                    e.originalEvent.target.blur();
                }
                if (document.activeElement && document.activeElement.blur) {
                    document.activeElement.blur();
                }
                Object.values(layers).forEach(other => other.getElement()?.classList.remove('zone-focus'));
                poly.getElement()?.classList.add('zone-focus');
                poly.openPopup();
                if (z.region) renderRegionCard(z.region);
                if (onZoneClick) onZoneClick(id);
            });
            poly.on('mouseover', () => poly.setStyle({ weight: 4.2, fillOpacity: Math.min(0.65, poly.options.fillOpacity + 0.25) }));
            poly.on('mouseout', () => poly.setStyle({ weight: z.type === 'prohibited' ? 2.8 : (isPark ? 2.8 : 2.2), fillOpacity: poly._baseOpacity ?? (isPark ? 0.28 : 0.22) }));
            poly._baseOpacity = isPark ? 0.28 : (z.type === 'prohibited' ? 0.35 : 0.22);
            layers[id] = poly;
        }

        const updLabels = () => {
            const zm = map.getZoom();
            map.getContainer().classList.toggle('labels-hidden', zm < 13);
            map.getContainer().classList.toggle('labels-compact', zm >= 13 && zm < 15);
        };
        map.on('zoomend', updLabels); updLabels();

        buildRegionNav(opts.navEl);
        buildBaseSwitch(opts.baseEl);
        setTimeout(() => map.invalidateSize(), 200);
        return map;
    }

    function setBase(key) {
        const cfg = CONFIG.MAP.BASE_LAYERS[key] || CONFIG.MAP.BASE_LAYERS.streets;
        if (baseLayer) map.removeLayer(baseLayer);
        baseLayer = L.tileLayer(cfg.url, {
            maxZoom: CONFIG.MAP.MAX_ZOOM,
            subdomains: cfg.subdomains || 'abc',
            attribution: '© OpenStreetMap'
        }).addTo(map);
        baseLayer.bringToBack();
        map.getContainer().dataset.base = key;
        map.getContainer().classList.toggle('theme-dark-tiles', !!cfg.darkFilter);
    }

    function zonePopup(id) {
        const z = CONFIG.ZONES[id];
        const r = CONFIG.REGIONS[z.region] || {};
        const t = CONFIG.ZONE_TYPES[z.type];
        const ha = (areaM2(geom(id)) / 10000).toFixed(1);
        const catLabels = { park: '🌳 Городской парк', building: '🏢 Здание / Комплекс', station: '🚆 Ж/д вокзал', airport: '✈ Аэропорт' };
        return `<div class="zp">
            <div class="zp-head"><span class="zp-id">${id}</span><span class="zp-type" style="--c:${t.color}">${t.label}</span></div>
            <div class="zp-name">${z.name}</div>
            <div class="zp-grid">
                <span>Категория</span><b>${catLabels[r.category] || 'Объект ВП'}</b>
                <span>Район города</span><b>${r.district || '—'}</b>
                <span>Площадь</span><b>${ha} га</b>
                <span>Макс. высота</span><b>${z.maxAlt ? z.maxAlt + ' м AGL' : '—'}</b>
            </div>
            <div class="zp-src">${r.note || ''}</div>
        </div>`;
    }

    function regionBounds(rid) {
        const b = L.latLngBounds([]);
        Object.entries(CONFIG.ZONES).forEach(([id, z]) => { if (z.region === rid) b.extend(layers[id].getBounds()); });
        return b;
    }

    function focusDistrict(distId) {
        activeDistrict = distId;
        activeRegion = null;
        document.querySelectorAll('.rn-dist-btn').forEach(el => el.classList.toggle('active', el.dataset.district === (distId || '')));
        
        // Подсветка контуров
        Object.entries(districtLayers).forEach(([did, dl]) => {
            const d = CONFIG.DISTRICTS[did];
            const col = d?.color || '#3b82f6';
            if (distId) {
                dl.setStyle({
                    color: did === distId ? col : '#64748b',
                    opacity: did === distId ? 1.0 : 0.35,
                    fillColor: col,
                    fillOpacity: did === distId ? 0.18 : 0.02,
                    weight: did === distId ? 3.5 : 1.2
                });
            } else {
                dl.setStyle({
                    color: col,
                    opacity: 0.95,
                    fillColor: col,
                    fillOpacity: 0.08,
                    weight: 2.5
                });
            }
        });

        // Фильтрация зон объектов
        Object.entries(layers).forEach(([zid, l]) => {
            const z = CONFIG.ZONES[zid];
            const reg = CONFIG.REGIONS[z.region];
            const inDist = !distId || (reg && reg.districtId === distId);
            l.getElement()?.classList.toggle('zone-dim', !inDist);
        });

        if (!distId) {
            map.flyTo(CONFIG.MAP.CENTER, CONFIG.MAP.ZOOM, { duration: 1.2 });
            renderRegionCard(null);
            renderDistrictCard(null);
            return;
        }

        const dPoly = districtLayers[distId];
        if (dPoly) {
            map.flyToBounds(dPoly.getBounds(), { padding: [40, 40], duration: 1.2, maxZoom: 14 });
        }
        renderDistrictCard(distId);
    }

    function focusRegion(rid) {
        activeRegion = rid;
        document.querySelectorAll('.rn-item').forEach(el => el.classList.toggle('active', el.dataset.region === (rid || '')));
        Object.entries(layers).forEach(([id, l]) => {
            const on = !rid || CONFIG.ZONES[id].region === rid;
            l.getElement()?.classList.toggle('zone-dim', !on);
            l.getElement()?.classList.toggle('zone-focus', !!rid && on);
        });
        if (!rid) {
            if (activeDistrict) focusDistrict(activeDistrict);
            else map.flyTo(CONFIG.MAP.CENTER, CONFIG.MAP.ZOOM, { duration: 1.2 });
            renderRegionCard(null);
            return;
        }
        map.flyToBounds(regionBounds(rid), { padding: [60, 60], duration: 1.2, maxZoom: 16 });
        renderRegionCard(rid);
    }

    function focusZone(id) {
        const l = layers[id];
        if (!l) return;
        map.flyToBounds(l.getBounds(), { padding: [80, 80], duration: 1, maxZoom: 16 });
        Object.values(layers).forEach(other => other.getElement()?.classList.remove('zone-focus'));
        l.getElement()?.classList.add('zone-focus');
        l.openPopup();
        const z = CONFIG.ZONES[id];
        if (z && z.region) renderRegionCard(z.region);
    }

    function buildRegionNav(el) {
        if (!el) return;
        
        // Кнопки районов (как в 2ГИС)
        const distButtons = [`<button class="rn-dist-btn active" data-district="">Все районы</button>`];
        for (const [did, d] of Object.entries(CONFIG.DISTRICTS || {})) {
            const shortName = d.name.replace('Район ', 'р-н ');
            distButtons.push(`<button class="rn-dist-btn" data-district="${did}">${shortName}</button>`);
        }

        const items = [];
        for (const [rid, r] of Object.entries(CONFIG.REGIONS)) {
            const zs = Object.entries(CONFIG.ZONES).filter(([, z]) => z.region === rid);
            const types = [...new Set(zs.map(([, z]) => z.type))];
            const catBadge = { park: '🌳 Парк', building: '🏢 Здание', station: '🚆 Вокзал', airport: '✈ Аэропорт' }[r.category] || '';
            items.push(`<button class="rn-item" data-region="${rid}" data-district="${r.districtId || ''}">
                <span class="rn-shape">${shapeSvg(rid)}</span>
                <span class="rn-name">${r.name}<small>${catBadge} · ${r.district}</small></span>
                <span class="rn-types">${types.map(t => `<i style="background:${typeColor(t)}"></i>`).join('')}</span>
            </button>`);
        }

        el.innerHTML = `
            <div class="rn-head">
                <span>2ГИС · Районы и локации</span>
                <button class="rn-toggle" title="Свернуть">—</button>
            </div>
            <div class="rn-districts-bar">${distButtons.join('')}</div>
            <div class="rn-list">${items.join('')}</div>
            <div class="rn-card hidden" id="rn-card"></div>
        `;

        el.querySelectorAll('.rn-dist-btn').forEach(b => {
            b.addEventListener('click', () => {
                const did = b.dataset.district || null;
                focusDistrict(did);
                // фильтруем список локаций под выбранный район
                el.querySelectorAll('.rn-item').forEach(item => {
                    const match = !did || item.dataset.district === did;
                    item.style.display = match ? 'flex' : 'none';
                });
            });
        });

        el.querySelectorAll('.rn-item').forEach(b => b.addEventListener('click', () => focusRegion(b.dataset.region || null)));
        el.querySelector('.rn-toggle').addEventListener('click', () => el.classList.toggle('collapsed'));
    }

    /** Миниатюра формы региона (SVG по реальному контуру) */
    function shapeSvg(rid) {
        const polys = Object.entries(CONFIG.ZONES).filter(([, z]) => z.region === rid).map(([id, z]) => ({ id, z, g: geom(id) }));
        const all = polys.flatMap(p => p.g);
        const o = centroid(all);
        const xy = all.map(p => toXY(p, o));
        const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
        const s = 26 / Math.max(maxX - minX, maxY - minY);
        const path = g => g.map(p => toXY(p, o)).map(([x, y], i) => `${i ? 'L' : 'M'}${(2 + (x - minX) * s).toFixed(1)},${(2 + (maxY - y) * s).toFixed(1)}`).join('') + 'Z';
        return `<svg viewBox="0 0 30 30" width="30" height="30">${polys.sort((a, b) => areaM2(b.g) - areaM2(a.g))
            .map(p => `<path d="${path(p.g)}" fill="${typeColor(p.z.type)}" fill-opacity="0.35" stroke="${typeColor(p.z.type)}" stroke-width="0.8"/>`).join('')}</svg>`;
    }

    function renderDistrictCard(distId) {
        const card = document.getElementById('rn-card');
        if (!card) return;
        if (!distId) return;
        const d = CONFIG.DISTRICTS[distId];
        const locs = Object.entries(CONFIG.REGIONS).filter(([, r]) => r.districtId === distId);
        card.classList.remove('hidden');
        card.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <span class="rc-title" style="color:${d.color || 'var(--text-bright)'}">${d.name}</span>
                <span style="font-size:0.6rem; padding:2px 6px; border-radius:4px; background:${d.color || '#3b82f6'}; color:#fff; font-weight:700;">Официальный район</span>
            </div>
            <div class="rc-sub" style="line-height:1.4; color:var(--text); margin-bottom:6px;">${d.desc}</div>
            <div style="font-size:0.65rem; color:var(--text-dim); border-top:1px dashed var(--border-light); padding-top:6px;">
                Объектов в районе: <b style="color:var(--text-bright)">${locs.length}</b> (кликните ниже для полёта)
            </div>`;
    }

    function renderRegionCard(rid) {
        const card = document.getElementById('rn-card');
        if (!card) return;
        if (!rid) { card.classList.add('hidden'); return; }
        const r = CONFIG.REGIONS[rid];
        const zs = Object.entries(CONFIG.ZONES).filter(([, z]) => z.region === rid);
        const catLabels = { park: '🌳 Городской парк', building: '🏢 Здание / Комплекс', station: '🚆 Ж/д вокзал', airport: '✈ Аэропорт' };
        card.classList.remove('hidden');
        card.innerHTML = `<div class="rc-title">${r.name}</div>
            <div class="rc-sub"><span style="color:#63b3ed">${catLabels[r.category] || 'Объект'}</span> · ${r.district}</div>
            <div style="font-size:0.65rem; color:var(--text); margin-bottom:8px;">${r.note}</div>
            ${zs.map(([id, z]) => {
                const t = CONFIG.ZONE_TYPES[z.type];
                return `<div class="rc-zone" data-zone="${id}">
                    <span class="rc-id" style="--c:${t.color}">${id}</span>
                    <span class="rc-zn">${z.name.replace(/^.*? — /, '')}<small>${(areaM2(geom(id)) / 10000).toFixed(1)} га · ${z.maxAlt ? '≤' + z.maxAlt + ' м' : 'полёты запрещены'}</small></span>
                    ${z.type !== 'prohibited' ? `<button class="rc-book" data-book="${id}">Бронь</button>` : '<span class="rc-ban">⛔</span>'}
                </div>`;
            }).join('')}`;
        card.querySelectorAll('.rc-zone').forEach(el => el.addEventListener('click', e => {
            if (e.target.dataset.book) { if (onZoneClick) onZoneClick(e.target.dataset.book); return; }
            focusZone(el.dataset.zone); layers[el.dataset.zone].openPopup();
        }));
    }

    function buildBaseSwitch(el) {
        if (!el) return;
        el.innerHTML = Object.entries(CONFIG.MAP.BASE_LAYERS).map(([k, b]) =>
            `<button class="bs-btn${k === 'streets' ? ' active' : ''}" data-base="${k}">${b.label}</button>`).join('');
        el.querySelectorAll('.bs-btn').forEach(b => b.addEventListener('click', () => {
            el.querySelectorAll('.bs-btn').forEach(x => x.classList.remove('active'));
            b.classList.add('active'); setBase(b.dataset.base);
        }));
    }

    /** Окраска зоны по текущему статусу (вызывается из app.js) */
    function setZoneStatus(id, color, opacity) {
        const l = layers[id];
        if (!l) return;
        l.setStyle({ color, fillColor: color, fillOpacity: opacity });
        l._baseOpacity = opacity;
    }

    // ───────────── ДЕМО: симуляция бортов ─────────────
    const DEMO_FLEET = [
        { id: 'KZ-UAV-0142', model: 'DJI Mavic 3E',     op: 'OP-10021', zone: 'TRI-A', speed: 9,  alt: 55 },
        { id: 'KZ-UAV-0317', model: 'Autel EVO II Pro',  op: 'OP-10034', zone: 'TRI-B', speed: 11, alt: 48, rogue: true },
        { id: 'KZ-UAV-0588', model: 'DJI Matrice 350',   op: 'OP-10007', zone: 'NZH-R', speed: 8,  alt: 35, avoid: ['NZH-P'] },
        { id: 'KZ-UAV-0721', model: 'DJI Mavic 3T',      op: 'OP-10052', zone: 'BOT-G', speed: 10, alt: 70 },
        { id: 'KZ-UAV-0904', model: 'DJI Matrice 30T',   op: 'OP-10011', zone: 'EXPO-R', speed: 12, alt: 75 },
        { id: 'KZ-UAV-1036', model: 'DJI Air 3',         op: 'OP-10063', zone: 'ADP-R', speed: 7,  alt: 45, avoid: ['ADP-P'] }
    ];
    let demo = null;

    function droneIcon(d) {
        const st = d.state;
        return L.divIcon({
            className: `drone-mk dm-${st}`,
            iconSize: [34, 34], iconAnchor: [17, 17],
            html: `<div class="dm-ring"></div><svg class="dm-glyph" viewBox="0 0 24 24" style="transform:rotate(${d.heading}deg)">
                <path d="M12 2 L15 10 L22 13 L15 14 L12 22 L9 14 L2 13 L9 10 Z"/></svg>
                <span class="dm-tag">${d.id.slice(-4)}</span>`
        });
    }

    function startDemo(ui) {
        if (demo) return;
        demo = { drones: [], timer: null, t: 0, ui, events: [] };
        for (const f of DEMO_FLEET) {
            const g = geom(f.zone);
            const avoid = (f.avoid || []).map(geom);
            const pos = randomPointIn(g, avoid);
            const d = { ...f, pos, target: randomPointIn(g, avoid), heading: 0, state: 'ok', trail: [pos], avoidG: avoid, breachAt: null };
            d.marker = L.marker(pos, { icon: droneIcon(d), zIndexOffset: 1000 }).addTo(map)
                .bindTooltip(() => `<b>${d.id}</b> · ${d.model}<br>Оператор ${d.op} · зона <b>${d.zone}</b><br>H ${d.alt} м · ${d.speed} м/с`, { direction: 'top', offset: [0, -14], className: 'drone-tip' });
            d.line = L.polyline(d.trail, { color: '#63b3ed', weight: 1.5, opacity: 0.6, dashArray: '2 4', interactive: false }).addTo(map);
            demo.drones.push(d);
        }
        demoEvent('info', `Демо запущено: ${demo.drones.length} бортов в согласованных зонах`);
        demo.timer = setInterval(tickDemo, 200);
        renderDemo();
    }

    function stopDemo() {
        if (!demo) return;
        clearInterval(demo.timer);
        demo.drones.forEach(d => { map.removeLayer(d.marker); map.removeLayer(d.line); });
        Object.entries(layers).forEach(([, l]) => l.getElement()?.classList.remove('zone-alarm'));
        demo = null;
    }

    function demoEvent(level, text) {
        if (!demo) return;
        demo.events.unshift({ level, text, at: new Date() });
        demo.events = demo.events.slice(0, 8);
    }

    function tickDemo() {
        demo.t++;
        const dt = 0.2 * 6; // ускорение ×6
        for (const d of demo.drones) {
            const g = geom(d.zone);
            // Нарушитель: каждые ~25 с уходит за пределы сектора
            if (d.rogue && d.state === 'ok' && demo.t % 125 === 60) {
                const c = centroid(g);
                d.target = [c[0] - 0.0072, c[1] - 0.0030]; // курс к Ақорда
                d.rogueRun = true;
            }
            const o = d.pos;
            const [dx, dy] = toXY(d.target, o);
            const dist = Math.hypot(dx, dy);
            const step = d.speed * dt * (d.state === 'rth' ? 1.6 : 1);
            if (dist < step) {
                d.pos = d.target;
                if (d.state === 'rth') { d.state = 'ok'; d.rogueRun = false; demoEvent('ok', `${d.id}: возврат в зону ${d.zone} выполнен`); layers[d.zone].getElement()?.classList.remove('zone-alarm'); }
                d.target = randomPointIn(g, d.avoidG);
            } else {
                d.pos = toLL([dx / dist * step, dy / dist * step], o);
                d.heading = (90 - Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
            }
            // Контроль геозоны
            const inside = pointIn(d.pos, g);
            if (!inside && d.state === 'ok') {
                d.state = 'breach'; d.breachAt = demo.t;
                const other = zonesAt(d.pos).filter(z => z !== d.zone);
                demoEvent('alarm', `НАРУШЕНИЕ ГЕОЗОНЫ: ${d.id} покинул ${d.zone}${other.length ? ' → вход в ' + other.join(', ') : ''}`);
                layers[d.zone].getElement()?.classList.add('zone-alarm');
            }
            if (d.state === 'breach') {
                const hit = zonesAt(d.pos).find(z => CONFIG.ZONES[z].type === 'prohibited');
                if (hit && !d.hitLogged) { d.hitLogged = true; demoEvent('alarm', `${d.id}: вход в запретную зону ${hit}!`); }
                if (demo.t - d.breachAt > 40) {
                    d.state = 'rth'; d.hitLogged = false;
                    d.target = randomPointIn(g, d.avoidG);
                    demoEvent('warn', `${d.id}: команда принудительного возврата (RTH) → ${d.zone}`);
                }
            }
            d.trail.push(d.pos); if (d.trail.length > 60) d.trail.shift();
            d.marker.setLatLng(d.pos).setIcon(droneIcon(d));
            d.line.setLatLngs(d.trail).setStyle({ color: d.state === 'ok' ? '#63b3ed' : d.state === 'rth' ? '#f6ad55' : '#fc8181' });
        }
        if (demo.t % 5 === 0) renderDemo();
    }

    function renderDemo() {
        const ui = demo?.ui;
        if (!ui) return;
        const stLbl = { ok: 'В ЗОНЕ', breach: 'НАРУШЕНИЕ', rth: 'RTH' };
        ui.list.innerHTML = demo.drones.map(d => `<div class="dd-row dd-${d.state}" data-id="${d.id}">
            <span class="dd-id">${d.id}</span><span class="dd-zone">${d.zone}</span>
            <span class="dd-alt">${d.alt} м</span><span class="dd-st">${stLbl[d.state]}</span></div>`).join('');
        ui.list.querySelectorAll('.dd-row').forEach(r => r.addEventListener('click', () => {
            const d = demo.drones.find(x => x.id === r.dataset.id); map.flyTo(d.pos, 16, { duration: 0.8 });
        }));
        ui.feed.innerHTML = demo.events.map(e => `<div class="df-ev df-${e.level}"><time>${e.at.toLocaleTimeString('ru')}</time>${e.text}</div>`).join('');
    }

    return Object.freeze({
        init, setBase, focusRegion, focusZone, setZoneStatus, startDemo, stopDemo,
        isDemo: () => !!demo, geom, pointIn, zonesAt, areaM2,
        get map() { return map; }
    });
})();
