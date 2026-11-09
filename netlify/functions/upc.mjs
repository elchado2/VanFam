/*
 * VanFam barcode lookup: /api/upc?code=040000524212
 *
 * Runs on Netlify (not in the browser) so it can ask two product databases
 * and combine the answers:
 *   - UPCitemdb (free, 100 lookups/day): retail product names with size, store photos
 *   - Open Food Facts (free, unlimited): brand, package size, categories, label photos
 *
 * Returns: { found, upc, name, brand, size, category, images: [urls] }
 */

const CATEGORY_RULES = [
    ['Beverages', ['beverage', 'drink', 'juice', 'soda', 'coffee', 'tea', 'water', 'wine', 'beer', 'spirit', 'whisky', 'whiskey', 'scotch', 'liquor']],
    ['Dairy & Eggs', ['dairy', 'dairies', 'milk', 'cheese', 'yogurt', 'yoghurt', 'butter', 'egg', 'cream']],
    ['Meat & Seafood', ['meat', 'beef', 'pork', 'chicken', 'poultry', 'bison', 'turkey', 'sausage', 'bacon', 'seafood', 'fish']],
    ['Produce', ['fruit', 'vegetable', 'produce']],
    ['Snacks', ['snack', 'candy', 'candies', 'chocolate', 'confectionery', 'confectioneries', 'sweet', 'chip', 'cracker', 'cookie', 'biscuit', 'popcorn', 'pretzel', 'nut']],
    ['Household', ['household', 'cleaning', 'paper', 'detergent', 'soap', 'trash', 'laundry', 'health & beauty', 'personal care']]
];

// Whole-word match, plural allowed ("tea" matches "teas" but not "steak")
function guessCategory(text) {
    const t = (text || '').toLowerCase();
    for (const [cat, words] of CATEGORY_RULES) {
        if (words.some(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(s|es)?\\b`).test(t))) return cat;
    }
    return 'Pantry & Cans';
}

// "milk chocolate m&m's" -> "Milk Chocolate M&M's"
function titleCase(s) {
    if (!s) return '';
    if (s !== s.toLowerCase()) return s.trim(); // already has capitals, leave it alone
    return s.replace(/\b([a-z])/g, (m, c) => c.toUpperCase()).replace(/'S\b/g, "'s").trim();
}

// "10.7 oz (303.3 g)" -> "10.7 oz", "400 g e" / "400 g ℮" -> "400 g"
function cleanSize(s) {
    if (!s) return '';
    return String(s).replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s*(℮|\be)\s*$/i, '').trim();
}

// Does the name already mention a size like "12 fl oz", "400 g", "6 Pack", "24 ct"?
const SIZE_IN_NAME = /\d+(\.\d+)?\s*(fl\.?\s*oz|oz|ounce|lb|lbs|pound|g|kg|ml|l|liter|litre|gal|gallon|ct|count|pk|pack)\b/i;

// Records what each database answered, for ?debug=1
const trace = {};

async function getJSON(label, url, ms = 6000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        const res = await fetch(url, {
            signal: ctrl.signal,
            headers: { 'User-Agent': 'VanFamPantry/1.0 (family pantry app)', 'Accept': 'application/json' }
        });
        trace[label] = `HTTP ${res.status}`;
        if (!res.ok) {
            trace[label] += ': ' + (await res.text()).slice(0, 200);
            return null;
        }
        return await res.json();
    } catch (e) {
        trace[label] = 'error: ' + (e.name === 'AbortError' ? 'timed out' : e.message);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export default async (req) => {
    const params = new URL(req.url).searchParams;
    const code = (params.get('code') || '').replace(/\D/g, '');
    const debug = params.get('debug') === '1';
    Object.keys(trace).forEach(k => delete trace[k]); // fresh trace for each request
    if (code.length < 8 || code.length > 14) {
        return Response.json({ found: false, error: 'Barcode should be 8 to 14 digits' }, { status: 400 });
    }

    const offFields = 'product_name,product_name_en,generic_name,brands,quantity,image_front_url,image_url,categories_tags';
    const [upcdb, off] = await Promise.all([
        getJSON('upcitemdb', `https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`),
        getJSON('openfoodfacts', `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${offFields}`)
    ]);

    const u = upcdb && Array.isArray(upcdb.items) && upcdb.items[0] ? upcdb.items[0] : null;
    const o = off && off.status === 1 && off.product ? off.product : null;

    if (debug) {
        trace.upcitemdb_items = upcdb && Array.isArray(upcdb.items) ? upcdb.items.length : null;
        trace.openfoodfacts_status = off ? off.status : null;
    }

    if (!u && !o) {
        return Response.json({ found: false, upc: code, ...(debug ? { debug: trace } : {}) },
            { headers: { 'Cache-Control': debug ? 'no-store' : 'public, max-age=3600' } });
    }

    const brand = (u && u.brand) || (o && o.brands ? o.brands.split(',')[0].trim() : '');
    const size = cleanSize((o && o.quantity) || (u && u.size) || '');

    // Store-style title from UPCitemdb usually already includes the size
    let name = u && u.title ? u.title.trim() : '';
    if (!name && o) {
        name = titleCase(o.product_name_en || o.product_name || o.generic_name || '');
        if (brand && name && !name.toLowerCase().includes(brand.toLowerCase())) name = `${brand} ${name}`;
    }
    if (name && size && !SIZE_IN_NAME.test(name)) {
        name = `${name}, ${size}`;
    }

    // Store photos first (clean white background), then the label photo as a backup
    const images = [];
    if (u && Array.isArray(u.images)) images.push(...u.images.filter(src => /^https:\/\//.test(src)));
    if (o && o.image_front_url) images.push(o.image_front_url);
    else if (o && o.image_url) images.push(o.image_url);

    // Only the most specific part of the store category ("... > Candy & Chocolate"),
    // since the top level ("Food, Beverages & Tobacco") would match everything
    const storeCat = u && u.category ? u.category.split('>').pop() : '';
    const offCats = ((o && o.categories_tags) || []).filter(t => t.startsWith('en:')).map(t => t.slice(3).replace(/-/g, ' '));
    const categoryText = [storeCat, ...offCats].join(' | ');

    return Response.json({
        found: true,
        upc: code,
        name: name || 'Scanned Item',
        brand,
        size,
        category: guessCategory(categoryText),
        images: [...new Set(images)].slice(0, 5),
        ...(debug ? { debug: trace } : {})
    }, { headers: { 'Cache-Control': debug ? 'no-store' : 'public, max-age=86400' } });
};

export const config = { path: '/api/upc' };
