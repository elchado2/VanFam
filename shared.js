/*
 * VanFam shared helpers
 * Loaded by index.html, cookbook.html and pantry.html so all three pages
 * use the SAME storage keys and the SAME shopping list format.
 *
 * Shopping list item format:
 *   { id, name, amount, unit, checked, source, sources, upc }
 *   amount can be null for items with no quantity ("Paper towels").
 */
(function () {
    const KEYS = {
        shopping: 'vanfam_shopping_list',
        pantry: 'vanfam_pantry_inventory',
        cookbook: 'vanfam_cb_v5'
    };

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

    function saveList(list) { store.setJSON(KEYS.shopping, list); }

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

    // Refresh a page when another tab/page changes the shopping list or pantry
    function onDataChange(callback) {
        window.addEventListener('storage', e => {
            if (e.key === KEYS.shopping || e.key === KEYS.pantry) callback(e.key);
        });
        // Coming back to a page (e.g. via the back button) also refreshes it
        window.addEventListener('pageshow', e => { if (e.persisted) callback(null); });
    }

    window.VanFam = { KEYS, store, uid, formatQty, escapeHtml, loadList, saveList, itemLabel, addToList, countOpen, onDataChange };
})();
