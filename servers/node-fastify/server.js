// GET /products?category=&min_price=&max_price=&sort=&limit=
// Filter + sort + serialise an in-memory catalogue. No caching, no memoisation,
// no pre-sorted copies, no pre-serialised JSON: every request does the full work.
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';

const PRODUCTS_PATH = process.env.PRODUCTS_PATH ?? 'data/products.json';
const products = JSON.parse(readFileSync(PRODUCTS_PATH, 'utf8'));

// Per-category index, built once at startup, in id order. Startup is not measured.
const index = new Map();
for (const p of products) {
  let bucket = index.get(p.category);
  if (bucket === undefined) index.set(p.category, (bucket = []));
  bucket.push(p);
}
console.log(`fastify: categories=${index.size} products=${products.length}`);

const SORTS = ['price_asc', 'price_desc', 'rating_desc'];

const productSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    category: { type: 'string' },
    price: { type: 'number' },
    rating: { type: 'number' },
    stock: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' } },
    created_at: { type: 'string' },
  },
};

const app = Fastify({ logger: false });

app.get(
  '/products',
  {
    schema: {
      // Fastify validates and coerces the query string, and answers 400 itself.
      querystring: {
        type: 'object',
        required: ['category'],
        properties: {
          category: { type: 'string' },
          min_price: { type: 'number', default: 0 },
          max_price: { type: 'number' },
          sort: { type: 'string', enum: SORTS, default: 'price_asc' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
      // Declaring the 200 response schema is Fastify's documented fast path
      // (fast-json-stringify).
      response: {
        200: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            items: { type: 'array', items: productSchema },
          },
        },
      },
    },
  },
  (req, reply) => {
    const { category, min_price, sort, limit } = req.query;
    const max_price = req.query.max_price ?? Infinity;

    // AJV coerces "Infinity", "-Infinity" and overflow literals like 1e400 into a
    // non-finite number and hands it straight to the handler: with strictNumbers on,
    // every numeric keyword (minimum, maximum, ...) is itself guarded by isFinite, so
    // the schema cannot express this. The other three stacks check it explicitly, so
    // this one has to as well. The max_price guard is conditional because an absent
    // max_price is deliberately Infinity.
    if (!Number.isFinite(min_price) || (req.query.max_price !== undefined && !Number.isFinite(max_price))) {
      return reply.code(400).send({ error: 'min_price and max_price must be finite numbers' });
    }

    // 1. candidates for the category
    const candidates = index.get(category);
    if (candidates === undefined) return { total: 0, items: [] };

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
    return { total, items: kept.slice(0, limit) };
  },
);

app.get('/health', () => ({ ok: true }));

await app.listen({ host: '0.0.0.0', port: 8080 });
console.log('fastify: listening on 0.0.0.0:8080');
