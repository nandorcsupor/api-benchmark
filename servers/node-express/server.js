// GET /products?category=&min_price=&max_price=&sort=&limit=
// Filter + sort + serialise an in-memory catalogue. No caching, no memoisation,
// no pre-sorted copies, no pre-serialised JSON: every request does the full work.
import { readFileSync } from 'node:fs';
import express from 'express';

const PRODUCTS_PATH = process.env.PRODUCTS_PATH ?? 'data/products.json';
const products = JSON.parse(readFileSync(PRODUCTS_PATH, 'utf8'));

// Per-category index, built once at startup, in id order. Startup is not measured.
const index = new Map();
for (const p of products) {
  let bucket = index.get(p.category);
  if (bucket === undefined) index.set(p.category, (bucket = []));
  bucket.push(p);
}
console.log(`express: categories=${index.size} products=${products.length}`);

const SORTS = new Set(['price_asc', 'price_desc', 'rating_desc']);

// Number('') and Number(' ') are both 0, which would let `min_price=` through as a
// silent 0 and `max_price=` through as a silent 0. A present-but-empty value is not
// a number, so it has to fail the finite check below like it does in the other three
// stacks. Non-strings (a repeated query key arrives as an array) fail here too.
const num = v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

const app = express();
// No other stack sends ETags or a server banner, so this keeps it fair to Express.
app.set('etag', false);
app.disable('x-powered-by');

app.get('/products', (req, res) => {
  const q = req.query;

  const category = q.category;
  // An empty category is a category that matches nothing, not a bad request: the
  // other three stacks answer 200 {"total":0,"items":[]} for it.
  if (typeof category !== 'string') {
    return res.status(400).json({ error: 'category is required' });
  }
  const min_price = q.min_price === undefined ? 0 : num(q.min_price);
  const max_price = q.max_price === undefined ? Infinity : num(q.max_price);
  if (!Number.isFinite(min_price) || (q.max_price !== undefined && !Number.isFinite(max_price))) {
    return res.status(400).json({ error: 'min_price and max_price must be finite numbers' });
  }
  const sort = q.sort === undefined ? 'price_asc' : q.sort;
  if (!SORTS.has(sort)) {
    return res.status(400).json({ error: 'sort must be price_asc, price_desc or rating_desc' });
  }
  const limit = q.limit === undefined ? 20 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({ error: 'limit must be an integer between 1 and 100' });
  }

  // 1. candidates for the category
  const candidates = index.get(category);
  if (candidates === undefined) return res.json({ total: 0, items: [] });

  // 2. price window + in stock
  const kept = [];
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    if (p.stock > 0 && p.price >= min_price && p.price <= max_price) kept.push(p);
  }
  // 3. total before the limit
  const total = kept.length;
  // 4. sort, ties always broken by id ascending
  if (sort === 'price_asc') kept.sort((a, b) => a.price - b.price || a.id - b.id);
  else if (sort === 'price_desc') kept.sort((a, b) => b.price - a.price || a.id - b.id);
  else kept.sort((a, b) => b.rating - a.rating || a.id - b.id);
  // 5. first `limit`, 6. respond 200 application/json
  return res.json({ total, items: kept.slice(0, limit) });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(8080, '0.0.0.0', () => console.log('express: listening on 0.0.0.0:8080'));
