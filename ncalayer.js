/* ========================================
   ЕЦП БАС — Клиент NCALayer (ЭЦП НУЦ РК) v3.7
   ========================================
   Поддерживает:
   • WebSocket подключение к локальному сервису NCALayer (порт 13579)
   • Нативный вызов getKeyInfo('PKCS12') — стандартный диалог НУЦ РК
     (выбор файла .p12 + нативный ввод пароля в окне NCALayer)
   • Чтение Subject DN (ФИО, ИИН, Организация, БИН)
   • Подписание CMS/XML
   • Локальный разбор файла .p12 по стандарту ASN.1 DER (X.509)
   ======================================== */

const NCALayer = (() => {
    'use strict';

    const URL_WSS = 'wss://127.0.0.1:13579/';
    const URL_WS  = 'ws://127.0.0.1:13579/';
    let ws = null;
    let isConnected = false;
    let ncaVersion = null;
    let callbackQueue = [];

    /** Парсинг строки DN сертификата НУЦ РК */
    function parseSubjectDN(dn) {
        if (!dn) return {};
        if (typeof dn === 'object') {
            const rawDn = dn.subjectDn || dn.subjectDN || dn.SubjectDN || dn.subject || dn.dn;
            if (rawDn && typeof rawDn === 'string') {
                const parsed = parseSubjectDN(rawDn);
                return {
                    ...parsed,
                    validity: dn.certNotAfter || dn.notAfter || parsed.validity,
                    algorithm: dn.algorithm || dn.keyType || ''
                };
            }
        }

        const res = {};
        const dnStr = String(dn || '');
        const parts = dnStr.split(/[,;\/]\s*(?=[A-Za-z0-9\._]+[\s=])/);
        parts.forEach(part => {
            const eqIdx = part.indexOf('=');
            if (eqIdx === -1) return;
            const k = part.slice(0, eqIdx).trim().toUpperCase();
            const v = part.slice(eqIdx + 1).trim().replace(/^"(.*)"$/, '$1');
            res[k] = v;
        });

        const iinRaw = res['SERIALNUMBER'] || res['SERIAL_NUMBER'] || res['IIN'] || '';
        const iinMatch = iinRaw.match(/(\d{12})/);
        const iin = iinMatch ? iinMatch[1] : '';

        const binRaw = res['OU'] || res['O'] || res['BIN'] || '';
        const binMatch = binRaw.match(/BIN(\d{12})/i);

        let fullName = res['CN'] || '';
        if (!fullName && (res['SURNAME'] || res['GIVENNAME'])) {
            fullName = [res['SURNAME'], res['GIVENNAME']].filter(Boolean).join(' ');
        }

        return {
            raw: dnStr,
            cn: res['CN'] || '',
            fullName: fullName || 'Владелец ЭЦП',
            iin: iin || '',
            bin: binMatch ? binMatch[1] : '',
            organization: res['O'] || (binMatch ? 'Юридическое лицо (РК)' : 'Физическое лицо (РК)'),
            department: res['OU'] || '',
            country: res['C'] || 'KZ',
            email: res['EMAILADDRESS'] || res['E'] || ''
        };
    }

    /** Проверка и подключение к NCALayer */
    function connect() {
        return new Promise((resolve) => {
            if (ws && isConnected && ws.readyState === WebSocket.OPEN) {
                return resolve({ connected: true, version: ncaVersion });
            }

            let resolved = false;
            let currentWs = null;

            const tryConnect = (url, isFallback) => {
                try {
                    currentWs = new WebSocket(url);
                } catch (e) {
                    if (!isFallback) {
                        return tryConnect(URL_WS, true);
                    }
                    if (!resolved) {
                        resolved = true;
                        resolve({ connected: false, error: e.message });
                    }
                    return;
                }

                const timeout = setTimeout(() => {
                    if (!resolved) {
                        if (!isFallback) {
                            try { currentWs.close(); } catch {}
                            tryConnect(URL_WS, true);
                        } else {
                            resolved = true;
                            resolve({ connected: false, error: 'Таймаут подключения (NCALayer не запущен на порту 13579)' });
                        }
                    }
                }, 1800);

                currentWs.onopen = () => {
                    // Ждем greeting от NCALayer
                };

                currentWs.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        
                        // Первичное приветствие NCALayer: {"result":{"version":"1.4"}}
                        if (data.result && data.result.version) {
                            ws = currentWs;
                            isConnected = true;
                            ncaVersion = data.result.version;
                            if (!resolved) {
                                resolved = true;
                                clearTimeout(timeout);
                                resolve({ connected: true, version: ncaVersion });
                            }
                            return;
                        }

                        // Ответ на RPC вызов: извлекаем зарегистрированный callback
                        const cb = callbackQueue.shift();
                        if (cb) {
                            cb(data);
                        }
                    } catch (e) {
                        console.error('[NCALayer] Parse error:', e);
                    }
                };

                currentWs.onerror = () => {
                    if (!isFallback && !resolved) {
                        clearTimeout(timeout);
                        tryConnect(URL_WS, true);
                    } else if (!resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        isConnected = false;
                        resolve({ connected: false, error: 'Ошибка соединения с NCALayer на порту 13579' });
                    }
                };

                currentWs.onclose = () => {
                    if (ws === currentWs) {
                        isConnected = false;
                        ws = null;
                    }
                };
            };

            // Начинаем попытку с WSS (настоящий NCALayer v1.4 слушает по TLS)
            tryConnect(URL_WSS, false);
        });
    }

    /** Отправка RPC команды в NCALayer */
    function callMethod(method, args = []) {
        return new Promise((resolve, reject) => {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                return reject(new Error('NCALayer не подключен (порт 13579)'));
            }

            callbackQueue.push((response) => {
                const codeStr = String(response.code || '');
                if (codeStr === '200' || response.status === true || (response.result && !response.code)) {
                    let obj = response.responseObject !== undefined ? response.responseObject : response.result;
                    if (typeof obj === 'string' && (obj.trim().startsWith('{') || obj.trim().startsWith('['))) {
                        try { obj = JSON.parse(obj); } catch {}
                    }
                    resolve(obj);
                } else if (codeStr === 'USER_CANCELLED' || codeStr === 'Cancelled' || response.message === 'action.canceled' || codeStr === 'action.canceled') {
                    reject(new Error('Выбор ключа отменен пользователем в NCALayer'));
                } else {
                    reject(new Error(response.message || response.responseObject || `Ошибка NCALayer (код ${response.code})`));
                }
            });

            const payload = {
                module: 'kz.gov.pki.knca.commonUtils',
                method: method,
                args: args
            };

            ws.send(JSON.stringify(payload));
        });
    }

    /**
     * Основной стандартный метод NCALayer для выбора ключа и получения информации о сертификате:
     * NCALayer САМ открывает системный диалог выбора файла .p12,
     * САМ запрашивает пароль в нативном окне ОС,
     * и возвращает данные сертификата (subjectDn, issuerCn, validity).
     */
    async function getKeyInfo(storageType = 'PKCS12') {
        const conn = await connect();
        if (!conn.connected) {
            throw new Error('NCALayer не запущен на локальном компьютере (порт 13579). Пожалуйста, запустите приложение NCALayer.');
        }
        return await callMethod('getKeyInfo', [storageType]);
    }

    /** Открытие диалога выбора файла ЭЦП (.p12) */
    async function browseKeyStore(storageType = 'PKCS12') {
        const conn = await connect();
        if (!conn.connected) {
            throw new Error('NCALayer не запущен на локальном компьютере (порт 13579).');
        }
        return await callMethod('browseKeyStore', [storageType, 'P12', '']);
    }

    /** Подписание произвольных данных (CMS / CAdES) */
    async function createCMSSignature(storageType, password, path, alias, dataBase64) {
        return await callMethod('createCMSSignatureFromData', [storageType, path, alias, password, dataBase64, true]);
    }

    /**
     * Извлечение ASN.1 DER атрибутов (CN, IIN, O, OU) напрямую из бинарного файла .p12
     */
    function extractASN1Attributes(buf) {
        const results = {};
        for (let i = 0; i < buf.length - 8; i++) {
            // Ищем последовательность OID 2.5.4.x: [06 03 55 04 XX]
            if (buf[i] === 0x06 && buf[i+1] === 0x03 && buf[i+2] === 0x55 && buf[i+3] === 0x04) {
                const typeByte = buf[i+4];
                let type = null;
                if (typeByte === 0x03) type = 'CN';
                else if (typeByte === 0x04) type = 'SURNAME';
                else if (typeByte === 0x05) type = 'SERIALNUMBER';
                else if (typeByte === 0x0A) type = 'O';
                else if (typeByte === 0x0B) type = 'OU';
                else if (typeByte === 0x2A) type = 'GIVENNAME';

                if (type && !results[type]) {
                    let idx = i + 5;
                    const tag = buf[idx++];
                    // Поддерживаемые строковые теги: UTF8String (0x0C), Printable (0x13), T61 (0x14), IA5 (0x16), BMP (0x1E)
                    if ([0x0C, 0x13, 0x14, 0x16, 0x1E].includes(tag)) {
                        let len = buf[idx++];
                        if (len & 0x80) {
                            const nBytes = len & 0x7F;
                            len = 0;
                            for (let k = 0; k < nBytes; k++) len = (len << 8) | buf[idx++];
                        }
                        if (idx + len <= buf.length) {
                            const slice = buf.slice(idx, idx + len);
                            let val = '';
                            try {
                                if (tag === 0x1E) {
                                    val = new TextDecoder('utf-16be').decode(slice);
                                } else {
                                    val = new TextDecoder('utf-8').decode(slice);
                                }
                                results[type] = val.trim();
                            } catch {}
                        }
                    }
                }
            }
        }
        return results;
    }

    /** Локальный разбор файла .p12 напрямую в браузере */
    function parseP12File(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const buf = new Uint8Array(reader.result);
                    const attrs = extractASN1Attributes(buf);

                    let iin = '';
                    if (attrs.SERIALNUMBER) {
                        const match = attrs.SERIALNUMBER.match(/(\d{12})/);
                        if (match) iin = match[1];
                    }
                    if (!iin) {
                        const fnMatch = file.name.match(/(\d{12})/);
                        if (fnMatch) iin = fnMatch[1];
                    }

                    let fullName = attrs.CN || '';
                    if (!fullName && (attrs.SURNAME || attrs.GIVENNAME)) {
                        fullName = [attrs.SURNAME, attrs.GIVENNAME].filter(Boolean).join(' ');
                    }
                    if (!fullName) {
                        fullName = file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
                    }

                    resolve({
                        fileName: file.name,
                        fileSize: file.size,
                        iin: iin || '',
                        fullName: fullName,
                        organization: attrs.O || (attrs.OU ? attrs.OU : 'Физическое лицо (РК)'),
                        department: attrs.OU || '',
                        isP12: true
                    });
                } catch (e) {
                    reject(e);
                }
            };
            reader.onerror = () => reject(new Error('Не удалось прочитать файл ключа'));
            reader.readAsArrayBuffer(file);
        });
    }

    return Object.freeze({
        connect,
        getKeyInfo,
        browseKeyStore,
        createCMSSignature,
        parseSubjectDN,
        parseP12File,
        isConnected: () => isConnected,
        getVersion: () => ncaVersion
    });
})();
