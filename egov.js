/* ========================================
   ЕЦП БАС — Вход через eGov mobile (QR) v3.6
   ========================================
   • Боевая интеграция через шлюз eGov Mobile QR (SIGEX)
     Генерирует реальный QR-код, совместимый со сканером официального приложения eGov mobile.
   • Автоматическое ожидание подписи со смартфона
   • Прямой переход по ссылке (Deep Link для смартфонов)
   • Локальное подписание от своего собственного имени (ФИО и ИИН)
   ======================================== */

const EGovQR = (() => {
    'use strict';

    const TTL = 180; // сек
    let state = null;
    let el = {};
    let onSuccess = null;
    let currentSigex = null;

    const STORAGE_KEY_SIGNER = 'ecpbas_my_signer_profile';

    function toBase64Utf8(str) {
        try {
            const bytes = new TextEncoder().encode(str);
            let bin = '';
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            return btoa(bin);
        } catch {
            return btoa(unescape(encodeURIComponent(str)));
        }
    }

    function getSigner() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY_SIGNER);
            if (saved) return JSON.parse(saved);
        } catch {}
        return {
            fullName: 'Нұржігіт Сейітқалиұлы',
            iin: '010515501234',
            role: 'admin',
            phone: '+7 (701) 234-56-78'
        };
    }

    function saveSigner(signer) {
        localStorage.setItem(STORAGE_KEY_SIGNER, JSON.stringify(signer));
        updateSignerUI();
    }

    function updateSignerUI() {
        const signer = getSigner();
        const nameEl = document.getElementById('egov-signer-name');
        const iinEl = document.getElementById('egov-signer-iin');
        if (nameEl) nameEl.textContent = signer.fullName;
        if (iinEl) iinEl.textContent = signer.iin;
    }

    function sid() {
        const a = new Uint8Array(12);
        crypto.getRandomValues(a);
        return Array.from(a, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    }

    function renderFallbackQR(text) {
        if (!el.qr) return;
        if (typeof qrcode !== 'function') {
            el.qr.innerHTML = '<div class="qr-err">Библиотека QR недоступна</div>';
            return;
        }
        const qr = qrcode(0, 'H');
        qr.addData(text);
        qr.make();
        const n = qr.getModuleCount();
        const cell = 6, pad = 4 * cell, size = n * cell + pad * 2;
        const isFinder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
        let mods = '';
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
            if (!qr.isDark(r, c) || isFinder(r, c)) continue;
            mods += `<rect x="${pad + c * cell + 0.5}" y="${pad + r * cell + 0.5}" width="${cell - 1}" height="${cell - 1}" rx="1"/>`;
        }
        const finder = (x, y) => `<g transform="translate(${pad + x * cell},${pad + y * cell})">
            <rect x="${cell / 2}" y="${cell / 2}" width="${6 * cell}" height="${6 * cell}" rx="${cell * 1.2}" fill="none" stroke="#000" stroke-width="${cell}"/>
            <rect x="${2 * cell}" y="${2 * cell}" width="${3 * cell}" height="${3 * cell}" rx="${cell * 0.5}" fill="#000"/></g>`;
        const logo = size * 0.18;
        el.qr.innerHTML = `<svg viewBox="0 0 ${size} ${size}" width="100%" height="100%" class="qr-svg">
            <rect width="${size}" height="${size}" fill="#fff"/>
            <g fill="#000">${mods}</g>
            ${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}
            <g transform="translate(${(size - logo) / 2},${(size - logo) / 2})">
                <rect width="${logo}" height="${logo}" rx="${logo * 0.2}" fill="#fff"/>
                <rect x="${logo * 0.1}" y="${logo * 0.1}" width="${logo * 0.8}" height="${logo * 0.8}" rx="${logo * 0.18}" fill="#0b6fd6"/>
                <text x="${logo / 2}" y="${logo * 0.62}" text-anchor="middle" font-family="Inter,sans-serif" font-weight="700" font-size="${logo * 0.3}" fill="#fff">eGov</text>
            </g></svg>`;
    }

    function setStatus(st, text) {
        if (!state) return;
        state.status = st;
        if (el.box) el.box.dataset.status = st;
        if (el.status) el.status.textContent = text;
        if (el.steps) {
            const order = ['pending', 'scanned', 'signing', 'success'];
            const cur = order.indexOf(st);
            el.steps.forEach(s => {
                const i = order.indexOf(s.dataset.step);
                s.classList.toggle('done', cur > i || st === 'success');
                s.classList.toggle('current', cur === i && st !== 'success');
            });
        }
    }

    async function newSession() {
        stop();
        const id = sid();
        state = { sid: id, expires: Date.now() + TTL * 1000, status: 'pending', timers: [] };
        if (el.sid) el.sid.textContent = id.replace(/(.{4})/g, '$1 ').trim();
        setStatus('pending', 'Инициализация официального QR eGov mobile…');
        state.tick = setInterval(tick, 250);
        tick();

        const deepLinkBox = document.getElementById('egov-deeplink-box');
        if (deepLinkBox) deepLinkBox.innerHTML = '';

        // Попытка зарегистрировать боевой QR eGov mobile через шлюз SIGEX
        try {
            if (typeof QRSigningClientCMS === 'function') {
                const signer = getSigner();
                currentSigex = new QRSigningClientCMS('Вход в ЕЦП БАС — Единая Цифровая Платформа БАС');
                
                // Передаем токен авторизации для подписи
                const authPayload = toBase64Utf8(JSON.stringify({
                    service: 'ECPBAS',
                    action: 'AUTH',
                    sid: id,
                    target: signer.fullName,
                    iin: signer.iin,
                    timestamp: new Date().toISOString()
                }));

                await currentSigex.addDataToSign(['Авторизация в системе ЕЦП БАС'], authPayload, [], false);
                const qrGifB64 = await currentSigex.registerQRSinging();

                // Отображаем настоящий QR-код для приложения eGov mobile
                if (el.qr) {
                    el.qr.innerHTML = `<img src="data:image/png;base64,${qrGifB64}" alt="eGov Mobile QR" class="egov-real-qr"/>`;
                }

                // Ссылка для запуска на смартфоне (deep link)
                const launchLink = currentSigex.getEGovMobileLaunchLink();
                if (deepLinkBox && launchLink) {
                    deepLinkBox.innerHTML = `
                        <a href="${launchLink}" target="_blank" class="secondary-btn btn-xs" style="display:inline-flex; align-items:center; gap:6px; margin-top:8px; text-decoration:none;">
                            📱 Открыть в приложении eGov mobile
                        </a>`;
                }

                setStatus('pending', 'Сканируйте официальным приложением eGov mobile…');

                // Слушаем подписание в реальном времени с телефона
                currentSigex.getSignatures(
                    () => {
                        // Вызывается когда мобильное приложение запросило документ
                        setStatus('signing', '✓ Открыто в eGov mobile! Подтвердите FaceID/PIN в телефоне…');
                    },
                    (dbg) => {
                        // Фоновые попытки опроса
                    }
                ).then(signatures => {
                    if (signatures && signatures.length) {
                        setStatus('success', '✓ Подпись получена из eGov mobile · Вход в систему…');
                        const s = getSigner();
                        setTimeout(() => {
                            stop();
                            if (onSuccess) onSuccess({
                                sid: state.sid,
                                method: 'egov',
                                fullName: s.fullName,
                                iin: s.iin,
                                role: s.role || 'admin',
                                signature: signatures[0]
                            });
                        }, 800);
                    }
                }).catch(err => {
                    if (err.canceledByUser) {
                        setStatus('expired', 'Подписание отменено пользователем в eGov mobile');
                    } else {
                        console.warn('[eGov QR Sign]', err);
                    }
                });

                return;
            }
        } catch (err) {
            console.warn('[eGov QR Gateway]', err);
        }

        // Локальный запасной вариант, если нет подключения к внешнему шлюзу
        renderFallbackQR(`https://m.egov.kz/mobileSign/?session=${id}`);
        setStatus('pending', 'Ожидание сканирования (автономный режим)…');
    }

    function tick() {
        if (!state) return;
        const left = Math.max(0, state.expires - Date.now());
        const s = Math.ceil(left / 1000);
        if (el.timer) el.timer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
        if (el.ring) el.ring.style.strokeDashoffset = String(113.1 * (1 - left / (TTL * 1000)));
        if (left === 0 && state.status === 'pending') { 
            setStatus('expired', 'Срок действия QR истёк'); 
            clearInterval(state.tick); 
        }
    }

    function stop() {
        if (!state) return;
        clearInterval(state.tick);
        state.timers.forEach(clearTimeout);
        currentSigex = null;
    }

    function demoScan() {
        if (!state || state.status === 'expired') newSession();
        if (state.status !== 'pending') return;
        const signer = getSigner();
        const t = (ms, fn) => state.timers.push(setTimeout(fn, ms));
        
        setStatus('scanned', `QR подтверждён для ${signer.fullName}`);
        t(1100, () => setStatus('signing', `Подписание ЭЦП НУЦ РК (ИИН ${signer.iin})…`));
        t(2600, () => {
            setStatus('success', 'Подпись получена! Переход в панель управления…');
            t(800, () => {
                stop();
                if (onSuccess) onSuccess({
                    sid: state.sid,
                    method: 'egov',
                    fullName: signer.fullName,
                    iin: signer.iin,
                    role: signer.role || 'admin',
                    phone: signer.phone
                });
            });
        });
    }

    function init(arg1, arg2) {
        if (typeof arg1 === 'function') {
            onSuccess = arg1;
        } else if (typeof arg2 === 'function') {
            onSuccess = arg2;
        } else if (arg1 && typeof arg1.onSuccess === 'function') {
            onSuccess = arg1.onSuccess;
        }

        const root = document.getElementById('form-login-egov');
        if (!root) return;

        el = {
            box: root.querySelector('#egov-box'),
            qr: root.querySelector('#egov-qr-code'),
            timer: root.querySelector('#egov-timer'),
            ring: root.querySelector('#egov-ring'),
            sid: root.querySelector('#egov-sid'),
            status: root.querySelector('#egov-status'),
            steps: root.querySelectorAll('.egov-step'),
            btnRefresh: root.querySelector('#btn-egov-refresh'),
            btnSim: root.querySelector('#btn-egov-simulate')
        };

        el.btnRefresh?.addEventListener('click', newSession);
        el.btnSim?.addEventListener('click', demoScan);

        // Управление профилем пользователя для локального подписания
        const btnEditSigner = document.getElementById('btn-edit-signer');
        const formSigner = document.getElementById('egov-signer-form');
        const btnSaveSigner = document.getElementById('btn-save-signer');
        const btnCancelSigner = document.getElementById('btn-cancel-signer');

        btnEditSigner?.addEventListener('click', () => {
            const signer = getSigner();
            document.getElementById('input-signer-name').value = signer.fullName;
            document.getElementById('input-signer-iin').value = signer.iin;
            document.getElementById('input-signer-role').value = signer.role || 'admin';
            formSigner?.classList.remove('hidden');
        });

        btnSaveSigner?.addEventListener('click', () => {
            const name = document.getElementById('input-signer-name').value.trim();
            const iin = document.getElementById('input-signer-iin').value.trim();
            const role = document.getElementById('input-signer-role').value;
            if (!name || iin.length !== 12) {
                alert('Пожалуйста, введите корректное ФИО и 12-значный ИИН');
                return;
            }
            saveSigner({ fullName: name, iin, role });
            formSigner?.classList.add('hidden');
            newSession(); // Пересоздаем QR с новыми данными
        });

        btnCancelSigner?.addEventListener('click', () => {
            formSigner?.classList.add('hidden');
        });

        updateSignerUI();
        newSession();
    }

    return Object.freeze({
        init,
        start: newSession,
        newSession,
        stop,
        demoScan,
        getSigner,
        saveSigner
    });
})();
