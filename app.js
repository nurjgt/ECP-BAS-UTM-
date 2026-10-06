/* ========================================
   ЕЦП БАС — Application Controller v3.0
   ========================================
   Модули: Auth, Dashboard/Booking, Profile,
   Registry, Exam/Proctoring, Admin
   ======================================== */

document.addEventListener('DOMContentLoaded', () => {
    initClock();
    checkAuth();
});

// ========================================
// CLOCK
// ========================================
function initClock() {
    function tick() {
        const now = new Date();
        const s = now.toLocaleString('ru-KZ', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' });
        const el = document.getElementById('header-datetime');
        const el2 = document.getElementById('server-time');
        if (el) el.textContent = s;
        if (el2) el2.textContent = s;
    }
    tick(); setInterval(tick, 1000);
}

// ========================================
// AUTH MODULE
// ========================================
function checkAuth() {
    const session = API.auth.getSession();
    if (session) {
        API.auth.getCurrentUser().then(user => {
            if (user) { enterApp(user, session); }
            else { showLogin(); }
        });
    } else {
        showLogin();
    }
}

function showLogin() {
    document.getElementById('page-login').style.display = 'flex';
    document.getElementById('app-shell').classList.add('hidden');
    initAuthForms();
}

function enterApp(user, session) {
    AppState.set('isAuthenticated', true);
    AppState.set('currentUser', user);
    AppState.set('session', session);
    if (typeof EGovQR !== 'undefined') EGovQR.stop();

    document.getElementById('page-login').style.display = 'none';
    document.getElementById('app-shell').classList.remove('hidden');

    document.getElementById('sys-classification').textContent = CONFIG.SYSTEM.CLASSIFICATION;
    document.getElementById('sb-version').textContent = CONFIG.SYSTEM.VERSION;
    document.getElementById('user-display-name').textContent = user.fullName;
    document.getElementById('user-display-id').textContent = user.id;

    // Show admin tab only for admin role
    document.querySelectorAll('.admin-only').forEach(el => {
        el.style.display = user.role === 'admin' ? '' : 'none';
    });

    initNavigation();
    initDashboard();
    initProfile();
    initRegistry();
    initBookingsList();
    initExam();
    if (user.role === 'admin') initAdmin();

    document.getElementById('btn-logout').addEventListener('click', () => {
        API.auth.logout().then(() => { location.reload(); });
    });
}

function loginUserWithEDS(payload) {
    if (typeof API !== 'undefined' && API.auth && typeof API.auth.loginWithEDS === 'function') {
        return API.auth.loginWithEDS(payload);
    }
    return new Promise((resolve) => {
        const key = (typeof CONFIG !== 'undefined' && CONFIG.STORAGE_KEYS) ? CONFIG.STORAGE_KEYS.OPERATORS : 'ecpbas_operators';
        const sessionKey = (typeof CONFIG !== 'undefined' && CONFIG.STORAGE_KEYS) ? CONFIG.STORAGE_KEYS.SESSION : 'ecpbas_session';
        let ops = [];
        try { ops = JSON.parse(localStorage.getItem(key)) || []; } catch {}
        const iin = payload.iin || '000000000000';
        let user = ops.find(o => (o.iin && o.iin === iin) || (payload.email && o.email === payload.email));
        if (!user) {
            user = {
                id: 'OP-' + String(10000 + ops.length).slice(-5),
                fullName: payload.fullName || 'Оператор ЭЦП',
                email: payload.email || `${iin}@ecpbas.kz`,
                phone: payload.phone || '+77001234567',
                iin: iin,
                citizenship: 'KZ',
                organization: payload.organization || 'Физическое лицо (РК)',
                role: payload.role || 'admin',
                edsCert: payload.certInfo || null,
                photo: '',
                createdAt: new Date().toISOString()
            };
            ops.push(user);
        } else {
            if (payload.fullName) user.fullName = payload.fullName;
            if (payload.organization) user.organization = payload.organization;
            if (payload.role) user.role = payload.role;
        }
        try { localStorage.setItem(key, JSON.stringify(ops)); } catch {}
        const session = {
            userId: user.id,
            role: user.role,
            loginAt: new Date().toISOString(),
            method: payload.method || 'eds',
            cert: payload.certInfo || null,
            signedData: payload.signature || null
        };
        try { localStorage.setItem(sessionKey, JSON.stringify(session)); } catch {}
        resolve({ user, session });
    });
}

function initAuthForms() {
    // Tab switching
    const tabs = document.querySelectorAll('.auth-tab');
    const forms = {
        email: document.getElementById('form-login-email'),
        phone: document.getElementById('form-login-phone'),
        egov: document.getElementById('form-login-egov'),
        eds: document.getElementById('form-login-eds')
    };
    const regForm = document.getElementById('form-register');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            Object.values(forms).forEach(f => { if (f) f.classList.remove('active'); });
            regForm.classList.remove('active');
            const target = forms[tab.dataset.method];
            if (target) target.classList.add('active');
            if (tab.dataset.method === 'egov') EGovQR.start(); else EGovQR.stop();
            if (tab.dataset.method === 'eds') updateNCALayerUI();
            hideAuthError();
        });
    });

    // Email login
    document.getElementById('form-login-email')?.addEventListener('submit', e => {
        e.preventDefault();
        API.auth.login('email', {
            email: document.getElementById('login-email').value,
            password: document.getElementById('login-password').value
        }).then(({ user, session }) => enterApp(user, session))
          .catch(err => showAuthError(err.message));
    });

    // Phone login
    document.getElementById('btn-send-otp')?.addEventListener('click', () => {
        document.getElementById('otp-section')?.classList.remove('hidden');
    });
    document.getElementById('form-login-phone')?.addEventListener('submit', e => {
        e.preventDefault();
        API.auth.verifyOTP(
            document.getElementById('login-phone').value,
            document.getElementById('login-otp').value
        ).then(({ user, session }) => enterApp(user, session))
          .catch(err => showAuthError(err.message));
    });

    // eGov QR (подписание под своим именем)
    EGovQR.init((signer) => {
        const s = signer || EGovQR.getSigner();
        loginUserWithEDS({
            fullName: s.fullName,
            iin: s.iin,
            organization: s.organization || 'Физическое лицо (РК)',
            role: s.role || 'admin',
            phone: s.phone || '',
            method: 'egov'
        }).then(({ user, session }) => {
            enterApp(user, session);
            showNotification(`Вход выполнен через eGov mobile: ${user.fullName}`, 'success');
        }).catch(err => showAuthError(err.message));
    });

    // ========================================
    // EDS / NCALAYER MODULE
    // ========================================
    let currentCertData = null;

    async function updateNCALayerUI() {
        const dot = document.getElementById('nca-status-dot');
        const title = document.getElementById('nca-status-title');
        const sub = document.getElementById('nca-status-sub');
        if (!title) return;

        title.textContent = 'Подключение к NCALayer…';
        const res = await NCALayer.connect();
        if (res.connected) {
            if (dot) { dot.className = 'nca-status-icon online'; dot.textContent = '●'; }
            title.textContent = `NCALayer подключен (v${res.version || '1.4'})`;
            if (sub) sub.textContent = 'Локальный порт 13579 активен · готов к чтению ключей НУЦ РК';
        } else {
            if (dot) { dot.className = 'nca-status-icon offline'; dot.textContent = '○'; }
            title.textContent = 'NCALayer не обнаружен';
            if (sub) sub.textContent = 'Запустите NCALayer или выберите .p12 файл вручную ниже';
        }
    }

    document.getElementById('btn-nca-retry')?.addEventListener('click', updateNCALayerUI);

    function displayCertCard(data) {
        currentCertData = data;
        const card = document.getElementById('eds-cert-card');
        const customForm = document.getElementById('eds-custom-form');
        if (!card) return;

        document.getElementById('eds-cert-cn').textContent = data.fullName;
        document.getElementById('eds-cert-iin').textContent = data.iin || 'Не указан';
        document.getElementById('eds-cert-org').textContent = data.organization || 'Физическое лицо (РК)';
        document.getElementById('eds-cert-valid').textContent = data.validity || '2026-2027 (активен)';

        card.classList.remove('hidden');
        if (customForm) customForm.classList.add('hidden');
    }

    // Кнопка «Выбрать ключ ЭЦП (.p12) через NCALayer»
    document.getElementById('btn-nca-browse')?.addEventListener('click', async () => {
        const btn = document.getElementById('btn-nca-browse');
        const origHtml = btn ? btn.innerHTML : '';
        try {
            hideAuthError();
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<span class="btn-icon">⏳</span> Открытие диалога NCALayer…';
            }

            const res = await NCALayer.getKeyInfo('PKCS12');
            console.log('[NCALayer] getKeyInfo result:', res);

            let certInfo = {};
            if (typeof res === 'string') {
                certInfo = NCALayer.parseSubjectDN(res);
            } else if (res && typeof res === 'object') {
                const dn = res.subjectDn || res.subjectDN || res.SubjectDN || res.subject || res.dn || '';
                certInfo = dn ? NCALayer.parseSubjectDN(dn) : NCALayer.parseSubjectDN(res);
            }

            const s = EGovQR.getSigner() || {};
            const fullName = certInfo.fullName || certInfo.cn || s.fullName || 'Нұржігіт Сейітқалиұлы';
            const iin = certInfo.iin || s.iin || '010515501234';
            const org = certInfo.organization || s.org || 'Физическое лицо (РК)';
            const rawValid = res && (res.notAfter || res.certNotAfter);
            const validity = rawValid 
                ? (typeof rawValid === 'string' && rawValid.length > 5 ? rawValid : new Date(rawValid).toLocaleDateString('ru-RU'))
                : 'Действителен (НУЦ РК)';

            displayCertCard({
                fullName,
                iin,
                organization: org,
                validity: validity.startsWith('до') ? validity : ('до ' + validity),
                method: 'ncalayer'
            });

            // Автоматический вход под выбранным ключом
            loginUserWithEDS({
                fullName,
                iin,
                organization: org,
                role: 'admin',
                method: 'eds'
            }).then(({ user, session }) => {
                enterApp(user, session);
                showNotification(`Вход выполнен по ЭЦП: ${user.fullName}`, 'success');
            }).catch(err => {
                showAuthError(err.message);
            });

        } catch (err) {
            console.warn('[NCALayer] Error:', err);
            if (err.message && (err.message.includes('отменен') || err.message.includes('canceled') || err.message.includes('USER_CANCELLED'))) {
                showAuthError('Выбор ключа отменен пользователем.');
            } else {
                showAuthError(err.message || 'Ошибка NCALayer. Вы можете выбрать файл .p12 вручную или войти от своего имени ниже.');
            }
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origHtml;
            }
        }
    });

    // Прямой выбор файла .p12
    document.getElementById('eds-file-input')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            hideAuthError();
            const parsed = await NCALayer.parseP12File(file);
            const s = EGovQR.getSigner();
            const fullName = (parsed.fullName && parsed.fullName.length > 3) ? parsed.fullName : s.fullName;
            const iin = parsed.iin || s.iin;
            const org = parsed.organization || 'Файл сертификата РК';
            displayCertCard({
                fullName,
                iin,
                organization: org,
                validity: 'Файл ' + file.name,
                method: 'p12_file'
            });

            // Автоматический вход
            loginUserWithEDS({
                fullName,
                iin,
                organization: org,
                role: 'admin',
                method: 'eds'
            }).then(({ user, session }) => {
                enterApp(user, session);
                showNotification(`Вход выполнен по файлу ключа: ${user.fullName}`, 'success');
            }).catch(err => showAuthError(err.message));
        } catch (err) {
            showAuthError('Ошибка чтения файла ключа: ' + err.message);
        }
    });

    // Вход по считанному сертификату
    document.getElementById('btn-login-with-cert')?.addEventListener('click', () => {
        if (!currentCertData) return;
        loginUserWithEDS({
            fullName: currentCertData.fullName,
            iin: currentCertData.iin,
            organization: currentCertData.organization,
            role: 'admin',
            method: 'eds'
        }).then(({ user, session }) => enterApp(user, session))
          .catch(err => showAuthError(err.message));
    });

    // Переключатель формы ручного ввода
    document.getElementById('btn-eds-custom-toggle')?.addEventListener('click', () => {
        const f = document.getElementById('eds-custom-form');
        const s = EGovQR.getSigner();
        if (f) {
            f.classList.toggle('hidden');
            const inName = document.getElementById('eds-custom-name');
            const inIin = document.getElementById('eds-custom-iin');
            if (inName && !inName.value) inName.value = s.fullName;
            if (inIin && !inIin.value) inIin.value = s.iin;
        }
    });

    // Вход с указанием своего имени
    document.getElementById('btn-eds-custom-login')?.addEventListener('click', () => {
        const name = document.getElementById('eds-custom-name')?.value?.trim();
        const iin = document.getElementById('eds-custom-iin')?.value?.trim();
        const org = document.getElementById('eds-custom-org')?.value?.trim();
        const role = document.getElementById('eds-custom-role')?.value || 'admin';

        if (!name || !iin) {
            showAuthError('Пожалуйста, укажите ФИО и ИИН для создания цифровой подписи');
            return;
        }

        EGovQR.saveSigner({ fullName: name, iin: iin, role: role });

        loginUserWithEDS({
            fullName: name,
            iin: iin,
            organization: org,
            role: role,
            method: 'eds'
        }).then(({ user, session }) => enterApp(user, session))
          .catch(err => showAuthError(err.message));
    });

    // Register
    document.getElementById('btn-show-register').addEventListener('click', () => {
        Object.values(forms).forEach(f => f.classList.remove('active'));
        tabs.forEach(t => t.classList.remove('active'));
        regForm.classList.add('active');
    });
    document.getElementById('btn-back-login').addEventListener('click', () => {
        regForm.classList.remove('active');
        tabs[0].classList.add('active');
        forms.email.classList.add('active');
    });

    regForm.addEventListener('submit', e => {
        e.preventDefault();
        API.auth.register({
            fullName: document.getElementById('reg-fullname').value,
            email: document.getElementById('reg-email').value,
            phone: document.getElementById('reg-phone').value,
            iin: document.getElementById('reg-iin').value,
            citizenship: document.getElementById('reg-citizenship').value,
            password: document.getElementById('reg-password').value
        }).then(({ user, session }) => enterApp(user, session))
          .catch(err => showAuthError(err.message));
    });
}

function showAuthError(msg) {
    const el = document.getElementById('auth-error');
    el.textContent = msg;
    el.classList.remove('hidden');
}
function hideAuthError() {
    document.getElementById('auth-error').classList.add('hidden');
}

function showNotification(msg, type = 'info') {
    let container = document.getElementById('global-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'global-toast-container';
        container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:999999;display:flex;flex-direction:column;gap:10px;pointer-events:none;';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    const bg = type === 'success' ? '#166534' : (type === 'error' ? '#991b1b' : '#1e3a8a');
    const border = type === 'success' ? '#22c55e' : (type === 'error' ? '#ef4444' : '#3b82f6');
    toast.style.cssText = `background:${bg};border:1px solid ${border};color:#fff;padding:12px 18px;border-radius:6px;font-size:13px;box-shadow:0 10px 25px rgba(0,0,0,0.5);pointer-events:auto;animation:fadeUp 0.25s ease;display:flex;align-items:center;gap:10px;max-width:380px;`;
    toast.innerHTML = `<span>${type === 'success' ? '✓' : (type === 'error' ? '⚠' : 'ℹ')}</span><span>${msg}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.4s';
        setTimeout(() => toast.remove(), 400);
    }, 4000);
}

// ========================================
// NAVIGATION
// ========================================
function initNavigation() {
    const tabs = document.querySelectorAll('.nav-tab');
    const pages = document.querySelectorAll('.page');
    tabs.forEach(tab => {
        tab.addEventListener('click', e => {
            e.preventDefault();
            tabs.forEach(t => t.classList.remove('active'));
            pages.forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            const page = tab.dataset.page;
            document.getElementById('page-' + page).classList.add('active');
            AppState.set('currentPage', page);
            if (page === 'dashboard') setTimeout(() => { if (_dashMap) _dashMap.invalidateSize(); }, 100);
            if (page === 'profile') refreshProfile();
            if (page === 'bookings-list') refreshBookingsList();
            if (page === 'admin') refreshAdmin();
        });
    });
}

// ========================================
// DASHBOARD — MAP + BOOKING
// ========================================
let _dashMap = null;

function fillZoneSelect(sel, filter) {
    for (const [rid, r] of Object.entries(CONFIG.REGIONS)) {
        const zs = Object.entries(CONFIG.ZONES).filter(([, z]) => z.region === rid && filter(z));
        if (!zs.length) continue;
        const og = document.createElement('optgroup');
        og.label = r.name;
        zs.forEach(([id, z]) => og.appendChild(new Option(`${id} — ${z.name}`, id)));
        sel.appendChild(og);
    }
}

function initDashboard() {
    // Init map — реальные контуры зон и регионов (airmap.js)
    _dashMap = AirMap.init('dash-map', {
        navEl: document.getElementById('region-nav'),
        baseEl: document.getElementById('base-switch'),
        onZoneClick: id => {
            const sel = document.getElementById('bk-zone');
            const resEl = document.getElementById('bk-conflict-result');
            const bookBtn = document.getElementById('btn-book');
            const z = CONFIG.ZONES[id];
            if (!z) return;
            if (z.type === 'prohibited') {
                if (sel) sel.value = '';
                if (resEl) {
                    resEl.className = 'conflict-result conflict-fail';
                    resEl.textContent = `⛔ ЗОНА ЗАПРЕЩЕНА ДЛЯ ПОЛЁТОВ:\n${id} (${z.name}) — бесполётная зона (госохрана / ВПП / препятствие)`;
                    resEl.style.whiteSpace = 'pre-line';
                }
                if (bookBtn) bookBtn.disabled = true;
            } else {
                if (sel) {
                    sel.value = id;
                    sel.classList.add('flash');
                    setTimeout(() => sel.classList.remove('flash'), 800);
                }
                if (resEl) {
                    resEl.className = 'conflict-result conflict-warn';
                    resEl.textContent = `📍 Выбрана зона: ${id} (${z.name}). Макс. высота: ${z.maxAlt || 120} м. Заполните время для проверки.`;
                }
            }
        }
    });

    // Demo toggle
    const demoBtn = document.getElementById('btn-demo');
    const demoPanel = document.getElementById('demo-panel');
    demoBtn.addEventListener('click', () => {
        if (AirMap.isDemo()) {
            AirMap.stopDemo();
            demoBtn.classList.remove('on');
            demoPanel.classList.add('hidden');
            updateZoneColors();
        } else {
            AirMap.startDemo({ list: document.getElementById('demo-list'), feed: document.getElementById('demo-feed') });
            demoBtn.classList.add('on');
            demoPanel.classList.remove('hidden');
        }
    });

    // Populate selects
    const zoneSelect = document.getElementById('bk-zone');
    fillZoneSelect(zoneSelect, z => z.type !== 'prohibited');
    zoneSelect?.addEventListener('change', () => {
        const id = zoneSelect.value;
        if (id && typeof AirMap.focusZone === 'function') {
            AirMap.focusZone(id);
        }
    });
    const purposeSelect = document.getElementById('bk-purpose');
    for (const [val, label] of Object.entries(CONFIG.FLIGHT_PURPOSES)) {
        purposeSelect.add(new Option(label, val));
    }

    // Load user drones into drone select
    loadUserDrones();

    // Check conflict button
    document.getElementById('btn-check-conflict').addEventListener('click', checkBookingConflict);

    // Booking form submit
    document.getElementById('booking-form').addEventListener('submit', e => {
        e.preventDefault();
        const user = AppState.get('currentUser');
        API.bookings.create({
            operatorId: user.id,
            droneId: document.getElementById('bk-drone').value,
            zoneId: document.getElementById('bk-zone').value,
            startTime: document.getElementById('bk-start').value,
            endTime: document.getElementById('bk-end').value,
            altitude: document.getElementById('bk-altitude').value,
            purpose: document.getElementById('bk-purpose').value
        }).then(() => {
            e.target.reset();
            document.getElementById('bk-conflict-result').className = 'conflict-result';
            document.getElementById('bk-conflict-result').textContent = '';
            document.getElementById('btn-book').disabled = true;
            updateHUD();
            updateZoneColors();
        });
    });

    updateHUD();
    updateZoneColors();
    setTimeout(() => _dashMap.invalidateSize(), 200);
}

function loadUserDrones() {
    const user = AppState.get('currentUser') || {};
    API.drones.list({ operatorId: user.id }).then(({ data }) => {
        let dronesList = data || [];
        if (dronesList.length === 0) {
            const defaultFleet = [
                {
                    operatorId: user.id || 'OP-10001',
                    model: 'Mavic 3 Enterprise',
                    manufacturer: 'DJI',
                    serial: '1581F4Z7C239801A',
                    category: 'A1',
                    weight: 0.92,
                    zone: 'PRP-G',
                    status: 'approved'
                },
                {
                    operatorId: user.id || 'OP-10001',
                    model: 'Matrice 350 RTK',
                    manufacturer: 'DJI',
                    serial: '1581F5X9D849102B',
                    category: 'A2',
                    weight: 6.47,
                    zone: 'TRI-A',
                    status: 'approved'
                },
                {
                    operatorId: user.id || 'OP-10001',
                    model: 'EVO II Dual 640T',
                    manufacturer: 'Autel Robotics',
                    serial: 'AUT-640T-992144',
                    category: 'A1',
                    weight: 1.15,
                    zone: 'BOT-G',
                    status: 'approved'
                }
            ];

            Promise.all(defaultFleet.map(d => API.drones.create(d))).then(created => {
                const sel = document.getElementById('bk-drone');
                sel.innerHTML = '<option value="">— выберите борт —</option>';
                created.forEach(d => sel.add(new Option(`${d.id} — ${d.manufacturer} ${d.model} (${d.category}, ${d.weight} кг)`, d.id)));
                if (created.length > 0) sel.selectedIndex = 1;
            });
            return;
        }

        const sel = document.getElementById('bk-drone');
        sel.innerHTML = '<option value="">— выберите борт —</option>';
        dronesList.forEach(d => sel.add(new Option(`${d.id} — ${d.manufacturer} ${d.model} (${d.category || 'A1'})`, d.id)));
        if (dronesList.length > 0) sel.selectedIndex = 1;
    });
}

function checkBookingConflict() {
    const zone = document.getElementById('bk-zone').value;
    const start = document.getElementById('bk-start').value;
    const end = document.getElementById('bk-end').value;
    const resEl = document.getElementById('bk-conflict-result');
    const bookBtn = document.getElementById('btn-book');

    if (!zone || !start || !end) {
        resEl.className = 'conflict-result conflict-warn';
        resEl.textContent = '⚠ Заполните зону, дату начала и окончания';
        bookBtn.disabled = true;
        return;
    }

    API.bookings.checkConflict(zone, start, end).then(result => {
        if (result.available && !result.needsApproval) {
            resEl.className = 'conflict-result conflict-ok';
            resEl.textContent = '✔ Зона свободна в указанный период. Можно бронировать.';
            bookBtn.disabled = false;
        } else if (result.needsApproval) {
            resEl.className = 'conflict-result conflict-warn';
            resEl.textContent = '⚠ ' + result.reason;
            bookBtn.disabled = false;
        } else {
            resEl.className = 'conflict-result conflict-fail';
            const reasons = result.conflicts.map(c => {
                if (c.type === 'government') return `🔴 Гос.бронь: ${c.agency} — ${c.reason}`;
                if (c.type === 'operator') return `🟡 Занято оператором ${c.operatorId}`;
                if (c.type === 'prohibited') return `⛔ ${c.reason}`;
                return c.reason;
            }).join('\n');
            resEl.textContent = '✘ НЕДОСТУПНО:\n' + reasons;
            resEl.style.whiteSpace = 'pre-line';
            bookBtn.disabled = true;
        }
    });
}

function updateHUD() {
    API.stats.summary().then(s => {
        document.getElementById('hud-active').textContent = s.activeBookings;
        document.getElementById('hud-booked').textContent = s.totalBookings;
        document.getElementById('hud-zones').textContent = Object.keys(CONFIG.ZONES).length;
    });
}

function updateZoneColors() {
    const user = AppState.get('currentUser');
    const now = new Date().toISOString();
    for (const id of Object.keys(CONFIG.ZONES)) {
        API.zones.getStatus(id, now).then(status => {
            const z = CONFIG.ZONES[id];
            let color = CONFIG.ZONE_TYPES[z.type].color;
            let opacity = z.type === 'prohibited' ? 0.28 : 0.14;
            if (status.status === 'gov_reserved') { color = '#e53e3e'; opacity = 0.3; }
            else if (status.status === 'occupied') {
                color = status.operatorId === user?.id ? '#4299e1' : '#d69e2e';
                opacity = 0.25;
            }
            AirMap.setZoneStatus(id, color, opacity);
        });
    }
}

// ========================================
// PROFILE
// ========================================
function initProfile() { refreshProfile(); }

function refreshProfile() {
    const user = AppState.get('currentUser');
    if (!user) return;
    document.getElementById('profile-avatar').textContent = user.fullName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    document.getElementById('profile-name').textContent = user.fullName;
    document.getElementById('profile-id').textContent = user.id;
    document.getElementById('profile-email').textContent = user.email;
    document.getElementById('profile-phone').textContent = user.phone || '—';
    document.getElementById('profile-citizenship').textContent = user.citizenship === 'KZ' ? 'Республика Казахстан' : 'Иностранный гражданин';
    document.getElementById('profile-iin').textContent = user.iin || '—';
    document.getElementById('profile-created').textContent = user.createdAt ? new Date(user.createdAt).toLocaleDateString('ru') : '—';

    // Certs
    API.certificates.list(user.id).then(({ data }) => {
        const tbody = document.getElementById('certs-tbody');
        const empty = document.getElementById('certs-empty');
        if (data.length === 0) { tbody.innerHTML = ''; empty.style.display = ''; return; }
        empty.style.display = 'none';
        tbody.innerHTML = data.map(c => {
            const expired = new Date(c.expiresAt) < new Date();
            const stCss = expired ? 'status-rejected' : 'status-confirmed';
            const stLabel = expired ? 'ПРОСРОЧЕН' : 'АКТИВЕН';
            return `<tr><td class="mono">${c.id}</td><td>${c.categoryName}</td><td class="mono">${c.score}%</td><td>${new Date(c.issuedAt).toLocaleDateString('ru')}</td><td>${new Date(c.expiresAt).toLocaleDateString('ru')}</td><td><span class="status-badge ${stCss}">${stLabel}</span></td></tr>`;
        }).join('');
    });

    // My drones
    API.drones.list({ operatorId: user.id }).then(({ data }) => {
        const tbody = document.getElementById('my-drones-tbody');
        const empty = document.getElementById('my-drones-empty');
        if (data.length === 0) { tbody.innerHTML = ''; empty.style.display = ''; return; }
        empty.style.display = 'none';
        tbody.innerHTML = data.map(d => `<tr><td class="mono"><strong>${d.id}</strong></td><td>${d.model}</td><td>${d.manufacturer}</td><td><span class="status-badge status-open">${d.zone}</span></td><td><span class="status-badge badge-${d.status === 'active' ? 'active' : 'pending'}">${d.status === 'active' ? 'ДЕЙСТВ.' : 'РАССМ.'}</span></td></tr>`).join('');
    });

    // History
    API.bookings.list({ operatorId: user.id }).then(({ data }) => {
        const tbody = document.getElementById('history-tbody');
        const empty = document.getElementById('history-empty');
        if (data.length === 0) { tbody.innerHTML = ''; empty.style.display = ''; return; }
        empty.style.display = 'none';
        tbody.innerHTML = data.map(b => {
            const stCfg = CONFIG.BOOKING_STATUSES[b.status] || { label: b.status, css: '' };
            return `<tr><td class="mono">${b.id}</td><td>${b.zoneId}</td><td>${new Date(b.startTime).toLocaleDateString('ru')}</td><td><span class="status-badge ${stCfg.css}">${stCfg.label}</span></td></tr>`;
        }).join('');
    });
}

// ========================================
// REGISTRY (MY DRONES)
// ========================================
function initRegistry() {
    refreshRegistry();
    // Populate form selects
    const catSel = document.getElementById('dr-category');
    for (const [v, l] of Object.entries(CONFIG.DRONE_CATEGORIES)) catSel.add(new Option(l, v));
    const zoneSel = document.getElementById('dr-zone');
    fillZoneSelect(zoneSel, z => z.type === 'free' || z.type === 'restricted');

    document.getElementById('btn-register-drone').addEventListener('click', () => {
        document.getElementById('modal-drone').classList.remove('hidden');
    });
    document.querySelectorAll('[data-close="modal-drone"]').forEach(b => {
        b.addEventListener('click', () => document.getElementById('modal-drone').classList.add('hidden'));
    });
    document.getElementById('modal-drone').addEventListener('click', e => {
        if (e.target.classList.contains('modal-overlay')) e.target.classList.add('hidden');
    });

    document.getElementById('drone-form').addEventListener('submit', e => {
        e.preventDefault();
        const user = AppState.get('currentUser');
        API.drones.create({
            operatorId: user.id,
            manufacturer: document.getElementById('dr-manufacturer').value,
            model: document.getElementById('dr-model').value,
            serial: document.getElementById('dr-serial').value,
            weight: document.getElementById('dr-weight').value,
            category: document.getElementById('dr-category').value,
            zone: document.getElementById('dr-zone').value
        }).then(() => {
            document.getElementById('modal-drone').classList.add('hidden');
            e.target.reset();
            refreshRegistry();
            loadUserDrones();
        });
    });
}

function refreshRegistry() {
    const user = AppState.get('currentUser');
    API.drones.list({ operatorId: user.id }).then(({ data }) => {
        const tbody = document.getElementById('registry-tbody');
        const empty = document.getElementById('registry-empty');
        if (data.length === 0) { tbody.innerHTML = ''; empty.classList.remove('hidden'); return; }
        empty.classList.add('hidden');
        tbody.innerHTML = data.map(d => {
            const catLabel = CONFIG.DRONE_CATEGORIES[d.category] || d.category;
            const stCss = d.status === 'active' ? 'badge-active' : 'badge-pending';
            const stLabel = d.status === 'active' ? 'ДЕЙСТВ.' : 'РАССМ.';
            return `<tr><td class="mono"><strong>${d.id}</strong></td><td>${d.model}</td><td>${d.manufacturer}</td><td class="mono">${d.serial}</td><td>${catLabel}</td><td class="mono">${d.weight}</td><td><span class="status-badge status-open">${d.zone}</span></td><td><span class="status-badge ${stCss}">${stLabel}</span></td></tr>`;
        }).join('');
    });
}

// ========================================
// BOOKINGS LIST
// ========================================
function initBookingsList() { refreshBookingsList(); }

function refreshBookingsList() {
    const user = AppState.get('currentUser');
    API.bookings.list({ operatorId: user.id }).then(({ data }) => {
        const tbody = document.getElementById('bookings-tbody');
        const empty = document.getElementById('bookings-empty');
        if (data.length === 0) { tbody.innerHTML = ''; empty.classList.remove('hidden'); return; }
        empty.classList.add('hidden');
        tbody.innerHTML = data.map(b => {
            const stCfg = CONFIG.BOOKING_STATUSES[b.status] || { label: b.status, css: '' };
            const purposeLabel = CONFIG.FLIGHT_PURPOSES[b.purpose] || b.purpose || '—';
            const cancelBtn = (b.status === 'pending' || b.status === 'confirmed') ? `<button class="cancel-btn" style="padding:2px 8px;font-size:0.62rem" data-cancel-booking="${b.id}">Отменить</button>` : '';
            return `<tr><td class="mono">${b.id}</td><td>${b.zoneId}</td><td class="mono">${b.droneId}</td><td>${new Date(b.startTime).toLocaleString('ru', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</td><td>${new Date(b.endTime).toLocaleString('ru', {hour:'2-digit',minute:'2-digit'})}</td><td>${purposeLabel}</td><td><span class="status-badge ${stCfg.css}">${stCfg.label}</span></td><td>${cancelBtn}</td></tr>`;
        }).join('');

        document.querySelectorAll('[data-cancel-booking]').forEach(btn => {
            btn.addEventListener('click', () => {
                API.bookings.cancel(btn.dataset.cancelBooking).then(() => {
                    refreshBookingsList();
                    updateHUD();
                    updateZoneColors();
                });
            });
        });
    });
}

// ========================================
// EXAM & PROCTORING
// ========================================
let _examState = { questions: [], currentQ: 0, answers: [], timer: null, tabSwitches: 0, focusLosses: 0, examId: null };

function initExam() {
    renderExamCards();
}

function renderExamCards() {
    const container = document.getElementById('exam-select');
    container.innerHTML = '';
    for (const [cat, cfg] of Object.entries(CONFIG.CERT_CATEGORIES)) {
        const card = document.createElement('div');
        card.className = 'exam-card';
        card.innerHTML = `<h3>${cfg.name}</h3><p>${cfg.description}</p><div class="exam-meta"><span>${cfg.questions} вопросов</span><span>${cfg.timeMinutes} мин</span><span>Проходной: ${cfg.minScore}%</span></div>`;
        card.addEventListener('click', () => startExam(parseInt(cat)));
        container.appendChild(card);
    }
}

function generateQuestions(category) {
    const cfg = CONFIG.CERT_CATEGORIES[category];
    const count = cfg?.questions || 30;
    const topics = [
        { q: 'Максимальная высота полёта БАС в открытой категории?', opts: ['120 м AGL', '150 м AGL', '200 м AGL', '500 м AGL'], correct: 0 },
        { q: 'Что означает аббревиатура VLOS?', opts: ['Visual Line of Sight', 'Variable Landing Operation System', 'Vertical Lift Overflight Standard', 'Vector Line of Signal'], correct: 0 },
        { q: 'Какой документ необходим для полёта в зоне ограничений (R)?', opts: ['Разрешение ГК ОрВД', 'Уведомление местного акимата', 'Сертификат кат. 3', 'Не требуется документов'], correct: 0 },
        { q: 'Допустимая дальность полёта от оператора в категории Open?', opts: ['В пределах прямой видимости', '5 км', '10 км', 'Без ограничений'], correct: 0 },
        { q: 'Что делать при потере связи с БАС?', opts: ['Активировать процедуру Return-to-Home', 'Продолжить полёт по маршруту', 'Позвонить в авиадиспетчерскую', 'Ожидать восстановления связи 30 мин'], correct: 0 },
        { q: 'Минимальное расстояние от людей при полёте в Open категории?', opts: ['30 м', '50 м', '100 м', '150 м'], correct: 0 },
        { q: 'Кто выдаёт сертификат эксплуатанта БАС в РК?', opts: ['Комитет гражданской авиации', 'МВД РК', 'Акимат области', 'Оператор ЕЦП БАС'], correct: 0 },
        { q: 'Что такое геозона (geofence)?', opts: ['Виртуальная граница воздушного пространства', 'Физическое ограждение зоны полётов', 'Радиус действия пульта управления', 'Зона покрытия GPS'], correct: 0 },
        { q: 'При каких метеоусловиях запрещены полёты Open категории?', opts: ['Видимость менее 5 км, ветер > 10 м/с', 'Облачность ниже 500 м', 'Температура ниже -10°C', 'Все вышеперечисленные'], correct: 3 },
        { q: 'Максимальная масса БАС в категории Open?', opts: ['25 кг', '50 кг', '150 кг', '10 кг'], correct: 0 },
        { q: 'Что означает зона P на карте воздушного пространства?', opts: ['Prohibited — запретная', 'Permitted — разрешённая', 'Private — частная', 'Protected — охраняемая'], correct: 0 },
        { q: 'Обязательна ли страховка гражданской ответственности для оператора БАС?', opts: ['Да, для всех категорий', 'Только для Certified', 'Только при массе > 25 кг', 'Нет, не обязательна'], correct: 0 },
        { q: 'Какой частотный диапазон используется для управления БАС?', opts: ['2.4 ГГц / 5.8 ГГц', '900 МГц', '433 МГц', 'Все вышеперечисленные'], correct: 3 },
        { q: 'Что такое NOTAM?', opts: ['Notice to Air Missions', 'National Operator Training Manual', 'Network of Terrestrial Aviation Monitoring', 'Nominal Operational Terrain Assessment Map'], correct: 0 },
        { q: 'Срок действия сертификата оператора категории 1?', opts: ['2 года', '1 год', '5 лет', 'Бессрочно'], correct: 0 },
    ];
    const questions = [];
    for (let i = 0; i < count; i++) {
        const t = topics[i % topics.length];
        questions.push({
            id: i,
            text: `Вопрос ${i + 1}: ${t.q}`,
            options: [...t.opts],
            correct: t.correct
        });
    }
    return questions;
}

function startExam(category) {
    const user = AppState.get('currentUser');
    API.exams.create(user.id, category).then(exam => {
        _examState.questions = generateQuestions(category);
        _examState.currentQ = 0;
        _examState.answers = new Array(_examState.questions.length).fill(-1);
        _examState.tabSwitches = 0;
        _examState.focusLosses = 0;
        _examState.examId = exam.id;
        _examState.timeLeft = exam.timeMinutes * 60;

        document.getElementById('exam-select').classList.add('hidden');
        document.getElementById('exam-result').classList.add('hidden');
        document.getElementById('exam-session').classList.remove('hidden');
        document.getElementById('exam-id-display').textContent = exam.id;
        document.getElementById('exam-cat-display').textContent = CONFIG.CERT_CATEGORIES[category]?.name || '';

        renderQuestion();
        startTimer();
        startProctoring();
    });
}

function renderQuestion() {
    const q = _examState.questions[_examState.currentQ];
    const total = _examState.questions.length;
    const area = document.getElementById('exam-question-area');

    area.innerHTML = `<div class="exam-question"><h3>${q.text}</h3>${q.options.map((opt, i) =>
        `<div class="exam-option ${_examState.answers[_examState.currentQ] === i ? 'selected' : ''}" data-opt="${i}">${String.fromCharCode(65 + i)}) ${opt}</div>`
    ).join('')}</div>`;

    area.querySelectorAll('.exam-option').forEach(el => {
        el.addEventListener('click', () => {
            _examState.answers[_examState.currentQ] = parseInt(el.dataset.opt);
            area.querySelectorAll('.exam-option').forEach(o => o.classList.remove('selected'));
            el.classList.add('selected');
        });
    });

    document.getElementById('exam-q-counter').textContent = `${_examState.currentQ + 1} / ${total}`;
    document.getElementById('exam-progress-fill').style.width = `${((_examState.currentQ + 1) / total) * 100}%`;
    document.getElementById('btn-prev-q').disabled = _examState.currentQ === 0;
    document.getElementById('btn-next-q').classList.toggle('hidden', _examState.currentQ === total - 1);
    document.getElementById('btn-finish-exam').classList.toggle('hidden', _examState.currentQ !== total - 1);
}

function startTimer() {
    clearInterval(_examState.timer);
    _examState.timer = setInterval(() => {
        _examState.timeLeft--;
        const m = Math.floor(_examState.timeLeft / 60);
        const s = _examState.timeLeft % 60;
        document.getElementById('exam-timer-display').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        if (_examState.timeLeft <= 0) {
            clearInterval(_examState.timer);
            finishExam();
        }
    }, 1000);

    document.getElementById('btn-next-q').onclick = () => { _examState.currentQ++; renderQuestion(); };
    document.getElementById('btn-prev-q').onclick = () => { _examState.currentQ--; renderQuestion(); };
    document.getElementById('btn-finish-exam').onclick = () => finishExam();
}

function finishExam() {
    clearInterval(_examState.timer);
    stopProctoring();

    const correct = _examState.answers.filter((a, i) => a === _examState.questions[i].correct).length;
    const score = Math.round((correct / _examState.questions.length) * 100);
    const exam = { id: _examState.examId };

    API.exams.finish(_examState.examId, _examState.answers, score).then(result => {
        const user = AppState.get('currentUser');
        if (result.status === 'passed') {
            API.certificates.create(user.id, result.category, score);
        }

        document.getElementById('exam-session').classList.add('hidden');
        document.getElementById('exam-result').classList.remove('hidden');
        const card = document.getElementById('exam-result-card');
        const passed = result.status === 'passed';
        card.innerHTML = `
            <h2>${passed ? '✔ ЭКЗАМЕН СДАН' : '✘ ЭКЗАМЕН НЕ СДАН'}</h2>
            <div class="result-score ${passed ? 'result-passed' : 'result-failed'}">${score}%</div>
            <p>Правильных ответов: ${correct} из ${_examState.questions.length}</p>
            <p>Проходной балл: ${result.minScore}%</p>
            ${passed ? '<p style="margin-top:16px;color:var(--ok)">Сертификат выдан. Проверьте вкладку «Профиль».</p>' : '<p style="margin-top:16px;color:var(--text-dim)">Вы можете пересдать экзамен.</p>'}
            <button class="secondary-btn" style="margin-top:20px" onclick="document.getElementById('exam-result').classList.add('hidden');document.getElementById('exam-select').classList.remove('hidden');renderExamCards();">Вернуться к выбору</button>
        `;
    });
}

// ========================================
// PROCTORING
// ========================================
let _proctorHandlers = {};

function startProctoring() {
    const warnContainer = document.getElementById('proctor-warnings');
    warnContainer.innerHTML = '';

    function addWarning(msg, severity) {
        const div = document.createElement('div');
        div.className = 'proctor-warning';
        div.textContent = `[${new Date().toLocaleTimeString()}] ${severity}: ${msg}`;
        warnContainer.prepend(div);
        API.proctoringLogs.add(_examState.examId, msg, severity, msg);

        if (severity === 'CRITICAL') {
            document.getElementById('proctor-dot').className = 'sb-dot';
            document.getElementById('proctor-dot').style.background = '#e53e3e';
            document.getElementById('proctor-status-text').textContent = 'НАРУШЕНИЕ';
            document.getElementById('proctor-status-text').style.color = '#e53e3e';
        }
    }

    // Tab switch detection
    _proctorHandlers.visibility = () => {
        if (document.hidden) {
            _examState.tabSwitches++;
            addWarning(`Переключение вкладки (${_examState.tabSwitches}/${CONFIG.PROCTORING.TAB_SWITCH_LIMIT})`, _examState.tabSwitches >= CONFIG.PROCTORING.TAB_SWITCH_LIMIT ? 'CRITICAL' : 'WARNING');
            if (_examState.tabSwitches >= CONFIG.PROCTORING.TAB_SWITCH_LIMIT) {
                addWarning('Превышен лимит переключений вкладок. Экзамен прерван.', 'CRITICAL');
                API.exams.terminate(_examState.examId, 'tab_switches_exceeded');
                clearInterval(_examState.timer);
                stopProctoring();
                terminateExamUI('Превышен лимит переключений вкладок');
            }
        }
    };
    document.addEventListener('visibilitychange', _proctorHandlers.visibility);

    // Focus loss detection
    _proctorHandlers.blur = () => {
        _examState.focusLosses++;
        addWarning(`Потеря фокуса окна (${_examState.focusLosses}/${CONFIG.PROCTORING.FOCUS_LOSS_LIMIT})`, _examState.focusLosses >= CONFIG.PROCTORING.FOCUS_LOSS_LIMIT ? 'CRITICAL' : 'INFO');
        if (_examState.focusLosses >= CONFIG.PROCTORING.FOCUS_LOSS_LIMIT) {
            addWarning('Превышен лимит потерь фокуса. Экзамен прерван.', 'CRITICAL');
            API.exams.terminate(_examState.examId, 'focus_losses_exceeded');
            clearInterval(_examState.timer);
            stopProctoring();
            terminateExamUI('Превышен лимит потерь фокуса');
        }
    };
    window.addEventListener('blur', _proctorHandlers.blur);

    // Window resize anomaly (possible remote desktop)
    _proctorHandlers.resize = () => {
        if (window.outerWidth - window.innerWidth > 200 || window.outerHeight - window.innerHeight > 200) {
            addWarning('Аномалия размера окна: возможен удалённый доступ', 'WARNING');
        }
    };
    window.addEventListener('resize', _proctorHandlers.resize);

    // DevTools detection
    _proctorHandlers.devtools = (e) => {
        if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C'))) {
            e.preventDefault();
            addWarning('Попытка открыть DevTools', 'WARNING');
        }
    };
    document.addEventListener('keydown', _proctorHandlers.devtools);

    // Screen share API detection
    if (navigator.mediaDevices) {
        const origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia;
        navigator.mediaDevices.getDisplayMedia = function() {
            addWarning('Обнаружена попытка захвата экрана (getDisplayMedia)', 'CRITICAL');
            API.exams.terminate(_examState.examId, 'screen_share_detected');
            clearInterval(_examState.timer);
            stopProctoring();
            terminateExamUI('Обнаружен захват экрана');
            return Promise.reject(new Error('Screen capture blocked by proctoring'));
        };
        _proctorHandlers.restoreGetDisplayMedia = origGetDisplayMedia;
    }

    addWarning('Система прокторинга запущена', 'INFO');
}

function stopProctoring() {
    document.removeEventListener('visibilitychange', _proctorHandlers.visibility);
    window.removeEventListener('blur', _proctorHandlers.blur);
    window.removeEventListener('resize', _proctorHandlers.resize);
    document.removeEventListener('keydown', _proctorHandlers.devtools);
    if (_proctorHandlers.restoreGetDisplayMedia && navigator.mediaDevices) {
        navigator.mediaDevices.getDisplayMedia = _proctorHandlers.restoreGetDisplayMedia;
    }
    _proctorHandlers = {};
}

function terminateExamUI(reason) {
    document.getElementById('exam-session').classList.add('hidden');
    document.getElementById('exam-result').classList.remove('hidden');
    document.getElementById('exam-result-card').innerHTML = `
        <h2 style="color:var(--danger)">⛔ ЭКЗАМЕН ПРЕРВАН</h2>
        <div class="result-score result-failed">0%</div>
        <p>Причина: ${reason}</p>
        <p style="margin-top:12px;color:var(--text-dim)">Результат аннулирован. Попытка зафиксирована в журнале прокторинга.</p>
        <button class="secondary-btn" style="margin-top:20px" onclick="document.getElementById('exam-result').classList.add('hidden');document.getElementById('exam-select').classList.remove('hidden');renderExamCards();">Вернуться</button>
    `;
}

// ========================================
// ADMIN
// ========================================
function initAdmin() {
    // Gov reservation modal
    document.getElementById('btn-add-gov-res').addEventListener('click', () => {
        document.getElementById('modal-gov').classList.remove('hidden');
    });
    document.querySelectorAll('[data-close="modal-gov"]').forEach(b => {
        b.addEventListener('click', () => document.getElementById('modal-gov').classList.add('hidden'));
    });
    document.getElementById('modal-gov').addEventListener('click', e => {
        if (e.target.classList.contains('modal-overlay')) e.target.classList.add('hidden');
    });

    const govZoneSel = document.getElementById('gov-zone');
    for (const [id, z] of Object.entries(CONFIG.ZONES)) {
        govZoneSel.add(new Option(`${id} — ${z.name}`, id));
    }

    document.getElementById('gov-form').addEventListener('submit', e => {
        e.preventDefault();
        API.govReservations.create({
            zoneId: document.getElementById('gov-zone').value,
            agency: document.getElementById('gov-agency').value,
            startTime: document.getElementById('gov-start').value,
            endTime: document.getElementById('gov-end').value,
            reason: document.getElementById('gov-reason').value
        }).then(() => {
            document.getElementById('modal-gov').classList.add('hidden');
            e.target.reset();
            refreshAdmin();
            updateZoneColors();
        });
    });

    refreshAdmin();
}

function refreshAdmin() {
    // Gov reservations
    API.govReservations.list().then(({ data }) => {
        const tbody = document.getElementById('gov-tbody');
        const empty = document.getElementById('gov-empty');
        if (data.length === 0) { tbody.innerHTML = ''; empty.style.display = ''; return; }
        empty.style.display = 'none';
        tbody.innerHTML = data.map(g => `
            <tr><td class="mono">${g.id}</td><td><span class="status-badge status-rejected">${g.zoneId}</span></td><td>${g.agency}</td><td>${new Date(g.startTime).toLocaleString('ru', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</td><td>${new Date(g.endTime).toLocaleString('ru', {hour:'2-digit',minute:'2-digit'})}</td><td>${g.reason || '—'}</td><td><button class="cancel-btn" style="padding:2px 6px;font-size:0.6rem" data-delete-gov="${g.id}">Удалить</button></td></tr>
        `).join('');
        document.querySelectorAll('[data-delete-gov]').forEach(btn => {
            btn.addEventListener('click', () => {
                API.govReservations.delete(btn.dataset.deleteGov).then(() => { refreshAdmin(); updateZoneColors(); });
            });
        });
    });

    // All operators
    API.operators.list().then(({ data }) => {
        document.getElementById('all-operators-tbody').innerHTML = data.map(o =>
            `<tr><td class="mono">${o.id}</td><td>${o.fullName}</td><td>${o.email}</td><td>${o.citizenship}</td><td>${new Date(o.createdAt).toLocaleDateString('ru')}</td></tr>`
        ).join('');
    });

    // Events
    API.events.list(30).then(({ data }) => {
        document.getElementById('events-tbody').innerHTML = data.map(e => {
            const t = new Date(e.timestamp);
            return `<tr><td class="mono" style="font-size:0.6rem">${t.toLocaleString('ru', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'})}</td><td><span class="status-badge">${e.type}</span></td><td>${e.message}</td></tr>`;
        }).join('');
    });
}
