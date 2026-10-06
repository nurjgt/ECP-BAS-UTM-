/* ========================================
   ЕЦП БАС — Data Access Layer v3.0
   ========================================
   localStorage → при подключении БД: fetch()
   Все методы возвращают Promise
   ======================================== */

const API = (() => {
    'use strict';

    function _s(key) { try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; } }
    function _w(key, data) { try { localStorage.setItem(key, JSON.stringify(data)); } catch(e) { console.error('[API]', e); } }
    function _id(p) { return p + '-' + Date.now().toString(36).toUpperCase().slice(-6); }
    function _ts() { return new Date().toISOString(); }
    function _log(m, e, d) { /* silenced for production */ }

    // Seed or Update Superadmin account
    let _ops = _s(CONFIG.STORAGE_KEYS.OPERATORS);
    let _certs = _s(CONFIG.STORAGE_KEYS.CERTIFICATES);
    
    function ensureUserAndCert(id, name, email, role, cat, score) {
        let idx = _ops.findIndex(o => o.email === email);
        if (idx === -1) {
            _ops.push({
                id: id, fullName: name, email: email, phone: '+77000000000',
                iin: '000000000000', citizenship: 'KZ', password: 'Password!123',
                role: role, photo: '', createdAt: _ts()
            });
        } else {
            _ops[idx].password = 'Password!123';
            _ops[idx].role = role;
            _ops[idx].fullName = name;
        }

        if (cat && !_certs.find(c => c.operatorId === id && c.category === cat)) {
            const now = new Date();
            const exp = new Date(now);
            exp.setFullYear(exp.getFullYear() + 2);
            _certs.push({
                id: 'CERT-' + id + '-' + cat, operatorId: id, category: cat,
                categoryName: 'Категория ' + cat, score: score,
                issuedAt: now.toISOString(), expiresAt: exp.toISOString(), status: 'active'
            });
        }
    }

    ensureUserAndCert('OP-ADMIN', 'Системный Администратор', 'admin@ecpbas.kz', 'superadmin', null, 0);
    // Seed new users requested
    ensureUserAndCert('OP-ALIKHAN', 'Маратов Әлихан', 'alikhan@ecpbas.kz', 'operator', 'A1', 95);
    ensureUserAndCert('OP-DASTAN', 'Дастан Мухаммедрахим', 'dastan@ecpbas.kz', 'operator', 'A2', 98);
    
    _w(CONFIG.STORAGE_KEYS.OPERATORS, _ops);
    _w(CONFIG.STORAGE_KEYS.CERTIFICATES, _certs);


    // ============ Auth ============
    const auth = {
        login(method, credentials) {
            _log('POST', 'auth/login', { method });
            const ops = _s(CONFIG.STORAGE_KEYS.OPERATORS);
            let user = null;
            if (method === 'email') {
                user = ops.find(o => o.email === credentials.email && o.password === credentials.password);
            } else if (method === 'phone') {
                user = ops.find(o => o.phone === credentials.phone);
            } else if (method === 'egov') {
                user = ops.find(o => o.iin === credentials.iin);
            }
            if (!user) return Promise.reject({ code: 401, message: 'Неверные учётные данные' });
            const session = { userId: user.id, role: user.role, loginAt: _ts(), method };
            localStorage.setItem(CONFIG.STORAGE_KEYS.SESSION, JSON.stringify(session));
            return Promise.resolve({ user, session });
        },

        loginWithEDS(payload) {
            _log('POST', 'auth/eds', payload);
            const ops = _s(CONFIG.STORAGE_KEYS.OPERATORS);
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
                    organization: payload.organization || '',
                    role: payload.role || 'admin',
                    edsCert: payload.certInfo || null,
                    photo: '',
                    createdAt: _ts()
                };
                ops.push(user);
            } else {
                if (payload.fullName) user.fullName = payload.fullName;
                if (payload.organization) user.organization = payload.organization;
                if (payload.role) user.role = payload.role;
                if (payload.certInfo) user.edsCert = payload.certInfo;
            }
            _w(CONFIG.STORAGE_KEYS.OPERATORS, ops);
            const session = { 
                userId: user.id, 
                role: user.role, 
                loginAt: _ts(), 
                method: payload.method || 'eds',
                cert: payload.certInfo || null,
                signedData: payload.signature || null
            };
            localStorage.setItem(CONFIG.STORAGE_KEYS.SESSION, JSON.stringify(session));
            events.add('AUTH_EDS', `Вход по ${payload.method === 'egov' ? 'eGov QR' : 'ЭЦП НУЦ РК'}: ${user.fullName} (ИИН ${user.iin})`);
            return Promise.resolve({ user, session });
        },

        register(payload) {
            _log('POST', 'auth/register', payload);
            const ops = _s(CONFIG.STORAGE_KEYS.OPERATORS);
            if (ops.find(o => o.email === payload.email)) return Promise.reject({ code: 409, message: 'Email уже зарегистрирован' });
            const user = {
                id: 'OP-' + String(10000 + ops.length).slice(-5),
                fullName: payload.fullName,
                email: payload.email,
                phone: payload.phone || '',
                iin: payload.iin || '',
                citizenship: payload.citizenship || 'KZ',
                password: payload.password,
                role: payload.role || 'operator',
                photo: '',
                createdAt: _ts()
            };
            ops.push(user);
            _w(CONFIG.STORAGE_KEYS.OPERATORS, ops);
            const session = { userId: user.id, role: user.role, loginAt: _ts(), method: 'email' };
            localStorage.setItem(CONFIG.STORAGE_KEYS.SESSION, JSON.stringify(session));
            events.add('REGISTRATION', `Новый оператор: ${user.fullName} (${user.id})`);
            return Promise.resolve({ user, session });
        },

        getSession() {
            const s = localStorage.getItem(CONFIG.STORAGE_KEYS.SESSION);
            return s ? JSON.parse(s) : null;
        },

        getCurrentUser() {
            const s = this.getSession();
            if (!s) return Promise.resolve(null);
            const ops = _s(CONFIG.STORAGE_KEYS.OPERATORS);
            return Promise.resolve(ops.find(o => o.id === s.userId) || null);
        },

        logout() {
            localStorage.removeItem(CONFIG.STORAGE_KEYS.SESSION);
            return Promise.resolve({ success: true });
        },

        verifyOTP(phone, code) {
            _log('POST', 'auth/verify-otp', { phone });
            if (code === '0000' || code.length === 4) {
                const ops = _s(CONFIG.STORAGE_KEYS.OPERATORS);
                const user = ops.find(o => o.phone === phone);
                if (user) {
                    const session = { userId: user.id, role: user.role, loginAt: _ts(), method: 'phone' };
                    localStorage.setItem(CONFIG.STORAGE_KEYS.SESSION, JSON.stringify(session));
                    return Promise.resolve({ user, session });
                }
            }
            return Promise.reject({ code: 401, message: 'Неверный код' });
        }
    };

    // ============ Operators ============
    const operators = {
        list(f = {}) {
            let data = _s(CONFIG.STORAGE_KEYS.OPERATORS);
            if (f.search) { const q = f.search.toLowerCase(); data = data.filter(o => (o.fullName + o.id + o.email).toLowerCase().includes(q)); }
            return Promise.resolve({ data, total: data.length });
        },
        get(id) {
            const all = _s(CONFIG.STORAGE_KEYS.OPERATORS);
            const item = all.find(o => o.id === id);
            return item ? Promise.resolve(item) : Promise.reject({ code: 404 });
        },
        update(id, payload) {
            const all = _s(CONFIG.STORAGE_KEYS.OPERATORS);
            const idx = all.findIndex(o => o.id === id);
            if (idx === -1) return Promise.reject({ code: 404 });
            Object.assign(all[idx], payload);
            _w(CONFIG.STORAGE_KEYS.OPERATORS, all);
            return Promise.resolve(all[idx]);
        }
    };

    // ============ Drones ============
    const drones = {
        list(f = {}) {
            let data = _s(CONFIG.STORAGE_KEYS.DRONES);
            if (f.operatorId) data = data.filter(d => d.operatorId === f.operatorId);
            if (f.status) data = data.filter(d => d.status === f.status);
            if (f.search) { const q = f.search.toLowerCase(); data = data.filter(d => (d.id + d.model + d.manufacturer).toLowerCase().includes(q)); }
            return Promise.resolve({ data, total: data.length });
        },
        get(id) {
            const all = _s(CONFIG.STORAGE_KEYS.DRONES);
            const item = all.find(d => d.id === id);
            return item ? Promise.resolve(item) : Promise.reject({ code: 404 });
        },
        create(payload) {
            _log('POST', 'drones', payload);
            const all = _s(CONFIG.STORAGE_KEYS.DRONES);
            const record = {
                id: 'KZ-' + String(10000 + all.length).padStart(5, '0'),
                operatorId: payload.operatorId,
                model: payload.model,
                manufacturer: payload.manufacturer,
                serial: payload.serial,
                category: payload.category,
                weight: parseFloat(payload.weight),
                zone: payload.zone,
                status: 'pending',
                createdAt: _ts()
            };
            all.push(record);
            _w(CONFIG.STORAGE_KEYS.DRONES, all);
            events.add('DRONE_REG', `БАС: ${record.manufacturer} ${record.model} → ${record.id}`);
            return Promise.resolve(record);
        },
        update(id, payload) {
            const all = _s(CONFIG.STORAGE_KEYS.DRONES);
            const idx = all.findIndex(d => d.id === id);
            if (idx === -1) return Promise.reject({ code: 404 });
            Object.assign(all[idx], payload);
            _w(CONFIG.STORAGE_KEYS.DRONES, all);
            return Promise.resolve(all[idx]);
        }
    };

    // ============ Bookings ============
    const bookings = {
        list(f = {}) {
            let data = _s(CONFIG.STORAGE_KEYS.BOOKINGS);
            if (f.operatorId) data = data.filter(b => b.operatorId === f.operatorId);
            if (f.status) data = data.filter(b => b.status === f.status);
            if (f.zoneId) data = data.filter(b => b.zoneId === f.zoneId);
            return Promise.resolve({ data, total: data.length });
        },

        create(payload) {
            _log('POST', 'bookings', payload);
            const all = _s(CONFIG.STORAGE_KEYS.BOOKINGS);
            const record = {
                id: 'BK-' + String(100000 + all.length + 1),
                operatorId: payload.operatorId,
                droneId: payload.droneId,
                zoneId: payload.zoneId,
                zoneName: CONFIG.ZONES[payload.zoneId]?.name || payload.zoneId,
                startTime: payload.startTime,
                endTime: payload.endTime,
                purpose: payload.purpose,
                altitude: parseInt(payload.altitude) || 120,
                status: 'pending',
                createdAt: _ts()
            };
            all.push(record);
            _w(CONFIG.STORAGE_KEYS.BOOKINGS, all);
            events.add('BOOKING', `Бронь ${record.id}: зона ${record.zoneId}, ${new Date(record.startTime).toLocaleDateString('ru')}`);
            return Promise.resolve(record);
        },

        checkConflict(zoneId, startTime, endTime) {
            _log('POST', 'bookings/check-conflict', { zoneId, startTime, endTime });
            const zone = CONFIG.ZONES[zoneId];
            if (!zone) return Promise.resolve({ available: false, conflicts: [{ type: 'system', reason: 'Зона не найдена' }] });

            // Prohibited zones — always blocked
            if (zone.type === 'prohibited') {
                return Promise.resolve({ available: false, conflicts: [{ type: 'prohibited', reason: `Зона ${zoneId} (${zone.name}) — постоянный запрет` }] });
            }

            const conflicts = [];
            const s = new Date(startTime).getTime();
            const e = new Date(endTime).getTime();

            // Check gov reservations
            const govRes = _s(CONFIG.STORAGE_KEYS.GOV_RESERVATIONS);
            for (const g of govRes) {
                if (g.zoneId !== zoneId) continue;
                const gs = new Date(g.startTime).getTime();
                const ge = new Date(g.endTime).getTime();
                if (s < ge && e > gs) {
                    conflicts.push({ type: 'government', agency: g.agency, reason: g.reason, time: `${g.startTime} — ${g.endTime}` });
                }
            }

            // Check other bookings
            const allBookings = _s(CONFIG.STORAGE_KEYS.BOOKINGS);
            for (const b of allBookings) {
                if (b.zoneId !== zoneId || b.status === 'cancelled' || b.status === 'rejected') continue;
                const bs = new Date(b.startTime).getTime();
                const be = new Date(b.endTime).getTime();
                if (s < be && e > bs) {
                    conflicts.push({ type: 'operator', operatorId: b.operatorId, bookingId: b.id, time: `${b.startTime} — ${b.endTime}` });
                }
            }

            // Restricted zones need approval
            if (zone.type === 'restricted' && conflicts.length === 0) {
                return Promise.resolve({ available: true, needsApproval: true, reason: `Зона ${zoneId} — ограниченная. Требуется согласование.` });
            }

            return Promise.resolve({ available: conflicts.length === 0, conflicts });
        },

        approve(id) {
            const all = _s(CONFIG.STORAGE_KEYS.BOOKINGS);
            const idx = all.findIndex(b => b.id === id);
            if (idx === -1) return Promise.reject({ code: 404 });
            all[idx].status = 'confirmed';
            _w(CONFIG.STORAGE_KEYS.BOOKINGS, all);
            events.add('BOOKING_OK', `Бронь ${id} подтверждена`);
            return Promise.resolve(all[idx]);
        },

        reject(id, reason) {
            const all = _s(CONFIG.STORAGE_KEYS.BOOKINGS);
            const idx = all.findIndex(b => b.id === id);
            if (idx === -1) return Promise.reject({ code: 404 });
            all[idx].status = 'rejected';
            all[idx].rejectReason = reason;
            _w(CONFIG.STORAGE_KEYS.BOOKINGS, all);
            return Promise.resolve(all[idx]);
        },

        cancel(id) {
            const all = _s(CONFIG.STORAGE_KEYS.BOOKINGS);
            const idx = all.findIndex(b => b.id === id);
            if (idx === -1) return Promise.reject({ code: 404 });
            all[idx].status = 'cancelled';
            _w(CONFIG.STORAGE_KEYS.BOOKINGS, all);
            return Promise.resolve(all[idx]);
        }
    };

    // ============ Gov Reservations ============
    const govReservations = {
        list() {
            return Promise.resolve({ data: _s(CONFIG.STORAGE_KEYS.GOV_RESERVATIONS) });
        },
        create(payload) {
            _log('POST', 'gov-reservations', payload);
            const all = _s(CONFIG.STORAGE_KEYS.GOV_RESERVATIONS);
            const record = {
                id: 'GOV-' + String(1000 + all.length + 1),
                zoneId: payload.zoneId,
                startTime: payload.startTime,
                endTime: payload.endTime,
                agency: payload.agency,
                reason: payload.reason,
                priority: payload.priority || 'high',
                createdAt: _ts()
            };
            all.push(record);
            _w(CONFIG.STORAGE_KEYS.GOV_RESERVATIONS, all);
            events.add('GOV_RESERVE', `Гос.бронь: ${record.agency} → ${record.zoneId}`);
            return Promise.resolve(record);
        },
        delete(id) {
            let all = _s(CONFIG.STORAGE_KEYS.GOV_RESERVATIONS);
            all = all.filter(g => g.id !== id);
            _w(CONFIG.STORAGE_KEYS.GOV_RESERVATIONS, all);
            return Promise.resolve({ success: true });
        }
    };

    // ============ Certificates ============
    const certificates = {
        list(operatorId) {
            let data = _s(CONFIG.STORAGE_KEYS.CERTIFICATES);
            if (operatorId) data = data.filter(c => c.operatorId === operatorId);
            return Promise.resolve({ data });
        },
        create(operatorId, category, score) {
            _log('POST', 'certificates', { operatorId, category });
            const all = _s(CONFIG.STORAGE_KEYS.CERTIFICATES);
            const now = new Date();
            const expires = new Date(now);
            expires.setFullYear(expires.getFullYear() + 2);
            const record = {
                id: 'CERT-' + _id('C'),
                operatorId,
                category,
                categoryName: CONFIG.CERT_CATEGORIES[category]?.name || `Категория ${category}`,
                score,
                issuedAt: now.toISOString(),
                expiresAt: expires.toISOString(),
                status: 'active'
            };
            all.push(record);
            _w(CONFIG.STORAGE_KEYS.CERTIFICATES, all);
            events.add('CERT_ISSUED', `Сертификат ${record.id}: категория ${category} → ${operatorId}`);
            return Promise.resolve(record);
        }
    };

    // ============ Exams ============
    const exams = {
        list(operatorId) {
            let data = _s(CONFIG.STORAGE_KEYS.EXAMS);
            if (operatorId) data = data.filter(e => e.operatorId === operatorId);
            return Promise.resolve({ data });
        },
        create(operatorId, category) {
            _log('POST', 'exams/start', { operatorId, category });
            const all = _s(CONFIG.STORAGE_KEYS.EXAMS);
            const cfg = CONFIG.CERT_CATEGORIES[category];
            const record = {
                id: 'EXAM-' + _id('E'),
                operatorId,
                category,
                startedAt: _ts(),
                finishedAt: null,
                score: null,
                totalQuestions: cfg?.questions || 30,
                minScore: cfg?.minScore || 70,
                timeMinutes: cfg?.timeMinutes || 45,
                status: 'in_progress',
                isForeign: false,
                answers: []
            };
            all.push(record);
            _w(CONFIG.STORAGE_KEYS.EXAMS, all);
            return Promise.resolve(record);
        },
        finish(examId, answers, score) {
            const all = _s(CONFIG.STORAGE_KEYS.EXAMS);
            const idx = all.findIndex(e => e.id === examId);
            if (idx === -1) return Promise.reject({ code: 404 });
            all[idx].finishedAt = _ts();
            all[idx].score = score;
            all[idx].answers = answers;
            all[idx].status = score >= all[idx].minScore ? 'passed' : 'failed';
            _w(CONFIG.STORAGE_KEYS.EXAMS, all);
            events.add('EXAM_DONE', `Экзамен ${examId}: ${all[idx].status} (${score}%)`);
            return Promise.resolve(all[idx]);
        },
        terminate(examId, reason) {
            const all = _s(CONFIG.STORAGE_KEYS.EXAMS);
            const idx = all.findIndex(e => e.id === examId);
            if (idx === -1) return Promise.reject({ code: 404 });
            all[idx].finishedAt = _ts();
            all[idx].status = 'terminated';
            all[idx].terminateReason = reason;
            _w(CONFIG.STORAGE_KEYS.EXAMS, all);
            events.add('EXAM_TERMINATED', `Экзамен ${examId} прерван: ${reason}`);
            return Promise.resolve(all[idx]);
        }
    };

    // ============ Proctoring Logs ============
    const proctoringLogs = {
        list(examId) {
            let data = _s(CONFIG.STORAGE_KEYS.PROCTORING_LOGS);
            if (examId) data = data.filter(l => l.examSessionId === examId);
            return Promise.resolve({ data });
        },
        add(examSessionId, eventType, severity, details) {
            const all = _s(CONFIG.STORAGE_KEYS.PROCTORING_LOGS);
            const record = { id: _id('PL'), examSessionId, timestamp: _ts(), eventType, severity, details };
            all.push(record);
            if (all.length > 500) all.splice(0, all.length - 500);
            _w(CONFIG.STORAGE_KEYS.PROCTORING_LOGS, all);
            return Promise.resolve(record);
        }
    };

    // ============ Events ============
    const events = {
        list(limit = 20) {
            const data = _s(CONFIG.STORAGE_KEYS.EVENTS);
            return Promise.resolve({ data: data.slice(-limit).reverse() });
        },
        add(type, message) {
            const all = _s(CONFIG.STORAGE_KEYS.EVENTS);
            all.push({ id: _id('EVT'), type, message, timestamp: _ts() });
            if (all.length > 300) all.splice(0, all.length - 300);
            _w(CONFIG.STORAGE_KEYS.EVENTS, all);
        }
    };

    // ============ Stats ============
    const stats = {
        summary() {
            const d = _s(CONFIG.STORAGE_KEYS.DRONES);
            const b = _s(CONFIG.STORAGE_KEYS.BOOKINGS);
            const o = _s(CONFIG.STORAGE_KEYS.OPERATORS);
            const c = _s(CONFIG.STORAGE_KEYS.CERTIFICATES);
            return Promise.resolve({
                totalDrones: d.length,
                totalOperators: o.length,
                totalBookings: b.length,
                activeBookings: b.filter(x => x.status === 'confirmed').length,
                totalCerts: c.length,
                rejected: b.filter(x => x.status === 'rejected').length
            });
        }
    };

    // ============ Zones ============
    const zones = {
        list() {
            const data = Object.entries(CONFIG.ZONES).map(([id, z]) => ({ id, ...z }));
            return Promise.resolve({ data });
        },
        getStatus(zoneId, datetime) {
            const govRes = _s(CONFIG.STORAGE_KEYS.GOV_RESERVATIONS);
            const books = _s(CONFIG.STORAGE_KEYS.BOOKINGS);
            const t = new Date(datetime || Date.now()).getTime();
            const zone = CONFIG.ZONES[zoneId];
            if (!zone) return Promise.resolve({ status: 'unknown' });
            if (zone.type === 'prohibited') return Promise.resolve({ status: 'blocked', reason: 'Запретная зона' });
            for (const g of govRes) {
                if (g.zoneId === zoneId && t >= new Date(g.startTime).getTime() && t <= new Date(g.endTime).getTime()) {
                    return Promise.resolve({ status: 'gov_reserved', agency: g.agency, reason: g.reason });
                }
            }
            for (const b of books) {
                if (b.zoneId === zoneId && b.status !== 'cancelled' && b.status !== 'rejected' && t >= new Date(b.startTime).getTime() && t <= new Date(b.endTime).getTime()) {
                    return Promise.resolve({ status: 'occupied', operatorId: b.operatorId });
                }
            }
            if (zone.type === 'restricted') return Promise.resolve({ status: 'restricted' });
            return Promise.resolve({ status: 'free' });
        }
    };

    const API_EXPORT = Object.freeze({ auth, operators, drones, bookings, govReservations, certificates, exams, proctoringLogs, events, stats, zones });
    if (typeof window !== 'undefined') window.API = API_EXPORT;
    return API_EXPORT;
})();
