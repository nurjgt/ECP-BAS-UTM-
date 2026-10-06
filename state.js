/* ========================================
   ЕЦП БАС — State Manager v3.0
   ======================================== */

const AppState = (() => {
    'use strict';
    const _listeners = {};
    const _state = {
        currentPage: 'login',
        isAuthenticated: false,
        currentUser: null,
        session: null,
        selectedZone: null,
        selectedBooking: null,
        activeExam: null,
        loading: {},
        errors: {},
        filters: { bookings: {}, drones: {} }
    };

    function get(path) { return path.split('.').reduce((o, k) => o?.[k], _state); }
    function set(path, value) {
        const keys = path.split('.');
        const last = keys.pop();
        const target = keys.reduce((o, k) => o[k] = o[k] || {}, _state);
        target[last] = value;
        _emit(path, value);
    }
    function _emit(event, data) {
        (_listeners[event] || []).forEach(fn => fn(data));
        (_listeners['*'] || []).forEach(fn => fn(event, data));
    }
    function on(event, fn) {
        if (!_listeners[event]) _listeners[event] = [];
        _listeners[event].push(fn);
        return () => { _listeners[event] = _listeners[event].filter(f => f !== fn); };
    }

    return Object.freeze({ get, set, on });
})();
