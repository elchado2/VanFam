/*
 * VanFam shared helpers
 * Loaded by index.html, cookbook.html and pantry.html so all three pages
 * use the SAME storage keys and the SAME shopping list format.
 *
 * Family sync: when someone in FAMILY_EMAILS signs in with Google, the shopping
 * list, pantry and remembered products sync through Firebase Realtime Database.
 * Each item is saved on its own, so two people editing at once don't overwrite
 * each other. localStorage is kept as a copy for fast loading and offline use.
 *
 * Shopping list item format:
 *   { id, name, amount, unit, checked, source, sources, upc }
 *   amount can be null for items with no quantity ("Paper towels").
 */
(function () {
    const KEYS = {
        shopping: 'vanfam_shopping_list',
        pantry: 'vanfam_pantry_inventory',
        products: 'vanfam_product_memory',
        cookbook: 'vanfam_cb_v5'
    };

    // Firebase project settings (these are meant to be public; the database
    // rules in the Firebase console are what keep the data private)
    const FIREBASE_CONFIG = {
        apiKey: 'AIzaSyBBoe2MWkTYBXOh-cRqYSm4BguE5jrPEuk',
        authDomain: 'vanfam-909e9.firebaseapp.com',
        databaseURL: 'https://vanfam-909e9-default-rtdb.firebaseio.com',
        projectId: 'vanfam-909e9',
        storageBucket: 'vanfam-909e9.firebasestorage.app',
        messagingSenderId: '956839653051',
        appId: '1:956839653051:web:7cd9ad11e718883171039e'
    };

    // Who can sign in. To add someone, add them here AND in the database rules
    // (Firebase console > Realtime Database > Rules).
    const FAMILY_EMAILS = ['elchado@gmail.com', 'angelarhenning@gmail.com', 'vanfam1111@gmail.com'];

    // localStorage with an in-memory fallback (private browsing, sandboxed previews)
    const mem = {};
    const store = {
        get(k) {
            try { return window.localStorage.getItem(k); }
            catch (e) { return k in mem ? mem[k] : null; }
        },
        set(k, v) {
            try { window.localStorage.setItem(k, v); }
            catch (e) { mem[k] = String(v); }
        },
        remove(k) {
            try { window.localStorage.removeItem(k); }
            catch (e) { delete mem[k]; }
        },
        getJSON(k, fallback) {
            try { const v = this.get(k); return v ? JSON.parse(v) : fallback; }
            catch (e) { return fallback; }
        },
        setJSON(k, v) { this.set(k, JSON.stringify(v)); }
    };

    // Unique ids (Date.now() alone repeats when adding several items at once)
    function uid(prefix) {
        return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    }

    // 1.875 -> "1 7/8", 0.1875 -> "1/8", 2.333 -> "2 1/3"
    function formatQty(num) {
        if (num === null || num === undefined || num === '' || isNaN(num)) return '';
        num = Number(num);
        if (num <= 0) return '0';
        let whole = Math.floor(num);
        let frac = num - whole;

        if (Math.abs(frac - 1 / 3) < 0.03) return (whole ? whole + ' ' : '') + '1/3';
        if (Math.abs(frac - 2 / 3) < 0.03) return (whole ? whole + ' ' : '') + '2/3';

        let eighths = Math.round(frac * 8);
        if (eighths === 8) { whole += 1; eighths = 0; }
        if (whole === 0 && eighths === 0) eighths = 1; // never show "0" for a tiny amount

        const names = { 1: '1/8', 2: '1/4', 3: '3/8', 4: '1/2', 5: '5/8', 6: '3/4', 7: '7/8' };
        if (!eighths) return String(whole);
        return (whole ? whole + ' ' : '') + names[eighths];
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function normalize(i) {
        return {
            id: i.id ? String(i.id) : uid('s'),
            name: i.name || i.text || '',
            amount: typeof i.amount === 'number' ? i.amount : null,
            unit: i.unit || '',
            checked: !!i.checked,
            source: i.source || i.sourceRecipe || '',
            sources: Array.isArray(i.sources) ? i.sources : [],
            upc: i.upc || ''
        };
    }

    function loadList() {
        let list = store.getJSON(KEYS.shopping, null);
        if (!Array.isArray(list)) {
            // First run after the update: pull in items saved by every older version
            const legacy = [];
            const master = store.getJSON('vanfam_master_shopping_list', []);
            if (Array.isArray(master)) legacy.push(...master);
            [KEYS.cookbook, 'vanfam_cookbook_state_v4'].forEach(k => {
                const cb = store.getJSON(k, null);
                if (cb && Array.isArray(cb.shoppingList)) legacy.push(...cb.shoppingList);
            });
            const seen = new Set();
            list = legacy.map(normalize).filter(i => {
                const key = i.name.toLowerCase();
                if (!key || seen.has(key)) return false;
                seen.add(key); return true;
            });
            store.setJSON(KEYS.shopping, list);
            return list;
        }
        return list.map(normalize);
    }

    function saveList(list) { store.setJSON(KEYS.shopping, list); cloudSyncArray('shopping', list); }
    function savePantry(items) { store.setJSON(KEYS.pantry, items); cloudSyncArray('pantry', items); }
    function loadProducts() { return store.getJSON(KEYS.products, {}) || {}; }
    function saveProducts(map) { store.setJSON(KEYS.products, map); cloudSyncMap('products', map); }

    function itemLabel(i) {
        return [formatQty(i.amount), i.unit, i.name].filter(Boolean).join(' ');
    }

    /*
     * Adds an item, or merges it into a matching unchecked item.
     * entry: { name, amount, unit, source, sourceId, upc }
     * sourceId stops the same recipe/pantry item from being added twice.
     * Returns 'added', 'merged' or 'exists'.
     */
    function addToList(entry, list) {
        const ownList = !list;
        list = list || loadList();
        const key = (entry.name + '|' + (entry.unit || '')).toLowerCase();
        const existing = list.find(i => !i.checked && (i.name + '|' + i.unit).toLowerCase() === key);

        if (existing) {
            if (entry.sourceId && existing.sources.includes(entry.sourceId)) return 'exists';
            if (typeof existing.amount === 'number' && typeof entry.amount === 'number') {
                existing.amount = Math.round((existing.amount + entry.amount) * 1000) / 1000;
            }
            if (entry.sourceId) existing.sources.push(entry.sourceId);
            if (entry.source && !existing.source.split(', ').includes(entry.source)) {
                existing.source = existing.source ? existing.source + ', ' + entry.source : entry.source;
            }
            if (ownList) saveList(list);
            return 'merged';
        }

        list.push({
            id: uid('s'),
            name: entry.name,
            amount: typeof entry.amount === 'number' ? entry.amount : null,
            unit: entry.unit || '',
            checked: false,
            source: entry.source || '',
            sources: entry.sourceId ? [entry.sourceId] : [],
            upc: entry.upc || ''
        });
        if (ownList) saveList(list);
        return 'added';
    }

    function countOpen() { return loadList().filter(i => !i.checked).length; }

    // Refresh a page when another tab, page, or family member changes the list or pantry
    function onDataChange(callback) {
        window.addEventListener('storage', e => {
            if (e.key === KEYS.shopping || e.key === KEYS.pantry) callback(e.key);
        });
        window.addEventListener('vanfam:data', e => callback(e.detail && e.detail.key));
        // Coming back to a page (e.g. via the back button) also refreshes it
        window.addEventListener('pageshow', e => { if (e.persisted) callback(null); });
    }


    /* =====================================================================
     * FAMILY SYNC (Firebase)
     * ===================================================================== */
    const PATHS = { shopping: KEYS.shopping, pantry: KEYS.pantry, products: KEYS.products };
    const cloud = { state: 'off', user: null, db: null, last: { shopping: {}, pantry: {}, products: {} } };

    function emit(key) { window.dispatchEvent(new CustomEvent('vanfam:data', { detail: { key } })); }
    function emitAuth() { window.dispatchEvent(new CustomEvent('vanfam:auth', { detail: { state: cloud.state } })); }

    // Firebase keys can't contain . # $ [ ] /
    function safeKey(k) { return String(k).replace(/[.#$\[\]\/]/g, '_'); }

    // Firebase drops empty lists/objects and undefined, so strip them the same way
    function clean(v) {
        if (Array.isArray(v)) {
            const a = v.map(clean).filter(x => x !== undefined);
            return a.length ? a : undefined;
        }
        if (v && typeof v === 'object') {
            const o = {};
            Object.keys(v).forEach(k => { const c = clean(v[k]); if (c !== undefined) o[k] = c; });
            return Object.keys(o).length ? o : undefined;
        }
        return v === null ? undefined : v;
    }

    // JSON with sorted keys, so "did this item change?" compares reliably
    function stable(v) {
        if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
        if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
        return JSON.stringify(v);
    }

    function sendUpdates(updates) {
        if (!Object.keys(updates).length) return;
        cloud.db.ref().update(updates).catch(err => {
            console.warn('VanFam sync failed:', err);
            showSyncError(err);
        });
    }

    // Saves only the items that changed (plus removals) for a list stored as an array
    function cloudSyncArray(path, arr) {
        if (cloud.state !== 'ready') return;
        const last = cloud.last[path];
        const updates = {}, seen = new Set();
        arr.forEach((item, i) => {
            const k = safeKey(item.id);
            seen.add(k);
            const v = clean({ ...item, pos: i });
            const sig = stable(v);
            if (last[k] !== sig) { updates[`vanfam/${path}/${k}`] = v; last[k] = sig; }
        });
        Object.keys(last).forEach(k => {
            if (!seen.has(k)) { updates[`vanfam/${path}/${k}`] = null; delete last[k]; }
        });
        sendUpdates(updates);
    }

    // Same idea for data stored as { key: value } (remembered products by barcode)
    function cloudSyncMap(path, map) {
        if (cloud.state !== 'ready') return;
        const last = cloud.last[path];
        const updates = {};
        Object.keys(map).forEach(key => {
            const k = safeKey(key);
            const v = clean(map[key]);
            if (v === undefined) return;
            const sig = stable(v);
            if (last[k] !== sig) { updates[`vanfam/${path}/${k}`] = v; last[k] = sig; }
        });
        sendUpdates(updates);
    }

    function listen(path) {
        const flagKey = `vanfam_synced_${path}_${cloud.user.uid}`;
        cloud.db.ref(`vanfam/${path}`).on('value', snap => {
            const val = snap.val();
            const firstTime = !store.get(flagKey);
            store.set(flagKey, '1');

            // First sync on this phone and the family has nothing yet: upload what's here
            if (firstTime && !val) {
                cloud.last[path] = {};
                if (path === 'products') cloudSyncMap(path, loadProducts());
                else cloudSyncArray(path, store.getJSON(PATHS[path], []) || []);
                return;
            }

            const data = val || {};
            cloud.last[path] = {};
            Object.keys(data).forEach(k => { cloud.last[path][k] = stable(clean(data[k])); });

            if (path === 'products') {
                store.setJSON(PATHS[path], data);
            } else {
                const arr = Object.values(data).sort((a, b) => (a.pos || 0) - (b.pos || 0));
                arr.forEach(i => { delete i.pos; });
                store.setJSON(PATHS[path], arr);
            }
            emit(PATHS[path]);
        }, err => {
            console.warn('VanFam listen failed:', err);
            showSyncError(err);
        });
    }

    /* ---------- Sign-in screen ---------- */
    function injectStyles() {
        if (document.getElementById('vf-sync-styles')) return;
        const css = `
        #vf-auth { position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,0.88);
            display: flex; align-items: center; justify-content: center; padding: 20px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        #vf-auth .vf-card { background: #141414; border: 1px solid #2c2c2e; border-radius: 16px;
            padding: 24px 22px; max-width: 340px; width: 100%; text-align: center; color: #f2f2f7; }
        #vf-auth h2 { margin: 0 0 8px; font-size: 20px; font-weight: 800; color: #fff; }
        #vf-auth p { margin: 0 0 18px; font-size: 14px; line-height: 1.45; color: #8e8e93; }
        #vf-auth .vf-google { width: 100%; background: #fff; color: #1f1f1f; border: none; border-radius: 10px;
            padding: 12px 14px; font-size: 15px; font-weight: 700; cursor: pointer;
            display: flex; align-items: center; justify-content: center; gap: 10px; }
        #vf-auth .vf-skip { margin-top: 14px; background: none; border: none; color: #8e8e93;
            font-size: 13px; text-decoration: underline; cursor: pointer; }
        #vf-auth .vf-err { color: #ff453a; font-size: 13px; margin: 12px 0 0; }
        #vf-sync-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #8e8e93; }
        #vf-sync-pill .dot { width: 7px; height: 7px; border-radius: 50%; background: #30d158; }
        #vf-sync-pill .dot.off { background: #8e8e93; }
        #vf-sync-pill button { background: none; border: none; color: #ffb703; font-size: 12px;
            text-decoration: underline; cursor: pointer; padding: 0; }`;
        const tag = document.createElement('style');
        tag.id = 'vf-sync-styles';
        tag.textContent = css;
        document.head.appendChild(tag);
    }

    const G_LOGO = '<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.2l7.9 6.2C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 7-10.3 7-17.7z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C.9 16.5 0 20.1 0 24s.9 7.5 2.6 10.8l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.1 1.4-4.9 2.3-8.2 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.2C6.6 42.6 14.6 48 24 48z"/></svg>';

    function hideAuthScreen() { const el = document.getElementById('vf-auth'); if (el) el.remove(); }

    function showAuthScreen(mode, detail) {
        injectStyles();
        hideAuthScreen();
        const wrap = document.createElement('div');
        wrap.id = 'vf-auth';
        const notFamily = mode === 'not-family';
        wrap.innerHTML = `
            <div class="vf-card">
                <h2>${notFamily ? 'Not on the family list' : 'Sign in to sync'}</h2>
                <p>${notFamily
                    ? `${escapeHtml(detail || 'That account')} can't open the VanFam lists. Sign in with a family Google account.`
                    : 'Sign in with your Google account to share the shopping list and pantry with the family.'}</p>
                <button class="vf-google" type="button">${G_LOGO}<span>${notFamily ? 'Use a different account' : 'Sign in with Google'}</span></button>
                <button class="vf-skip" type="button">Not now (this phone only)</button>
                <div class="vf-err" id="vf-auth-err"></div>
            </div>`;
        document.body.appendChild(wrap);
        wrap.querySelector('.vf-google').onclick = () => signIn(notFamily);
        wrap.querySelector('.vf-skip').onclick = () => {
            try { sessionStorage.setItem('vanfam_skip_signin', '1'); } catch (e) {}
            hideAuthScreen();
        };
    }

    function showSyncError(err) {
        const box = document.getElementById('vf-auth-err');
        const msg = err && err.code === 'PERMISSION_DENIED'
            ? "The database didn't let this account in."
            : 'Sync problem: ' + ((err && err.message) || err);
        if (box) box.textContent = msg;
    }

    function signIn(switchAccount) {
        const auth = firebase.auth();
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        const go = () => auth.signInWithPopup(provider).catch(err => {
            // Some phones block popups; fall back to a full-page redirect
            if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/cancelled-popup-request'].includes(err.code)) {
                return auth.signInWithRedirect(provider);
            }
            if (err.code !== 'auth/popup-closed-by-user') showSyncError(err);
        });
        if (switchAccount) auth.signOut().then(go); else go();
    }

    function signOut() {
        if (typeof firebase === 'undefined' || !firebase.apps.length) return;
        if (cloud.db) ['shopping', 'pantry', 'products'].forEach(p => cloud.db.ref(`vanfam/${p}`).off());
        firebase.auth().signOut();
    }

    // A small "Synced · Name · Sign out" line; put <span id="vf-sync-pill"></span> on a page to show it
    function renderPill() {
        const el = document.getElementById('vf-sync-pill');
        if (!el) return;
        injectStyles();
        if (cloud.state === 'ready') {
            const name = (cloud.user.displayName || cloud.user.email || '').split(' ')[0];
            el.innerHTML = `<span class="dot"></span><span>Synced with family · ${escapeHtml(name)}</span> · <button type="button">Sign out</button>`;
            el.querySelector('button').onclick = signOut;
        } else if (cloud.state === 'signed-out' || cloud.state === 'not-family') {
            el.innerHTML = `<span class="dot off"></span><span>Not syncing</span> · <button type="button">Sign in</button>`;
            el.querySelector('button').onclick = () => showAuthScreen('signed-out');
        } else {
            el.innerHTML = '';
        }
    }

    function initCloud() {
        if (typeof firebase === 'undefined' || !firebase.auth || !firebase.database) return; // offline or scripts blocked: local only
        if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
        cloud.state = 'checking';
        const auth = firebase.auth();
        auth.getRedirectResult().catch(err => showSyncError(err));

        auth.onAuthStateChanged(user => {
            cloud.user = user;
            if (!user) {
                cloud.state = 'signed-out';
                let skipped = false;
                try { skipped = sessionStorage.getItem('vanfam_skip_signin') === '1'; } catch (e) {}
                if (!skipped) showAuthScreen('signed-out');
            } else if (!FAMILY_EMAILS.includes((user.email || '').toLowerCase())) {
                cloud.state = 'not-family';
                showAuthScreen('not-family', user.email);
            } else {
                hideAuthScreen();
                cloud.db = firebase.database();
                cloud.state = 'ready';
                ['shopping', 'pantry', 'products'].forEach(listen);
            }
            renderPill();
            emitAuth();
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCloud);
    else initCloud();

    window.VanFam = {
        KEYS, store, uid, formatQty, escapeHtml,
        loadList, saveList, itemLabel, addToList, countOpen, onDataChange,
        savePantry, loadProducts, saveProducts,
        cloud: { get state() { return cloud.state; }, signIn: () => showAuthScreen('signed-out'), signOut }
    };
})();
