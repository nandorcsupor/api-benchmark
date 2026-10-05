// Why is Fastify slower than Express here? Isolate the one thing that differs:
// the response serialiser. Express uses res.json() -> native JSON.stringify.
// Fastify uses fast-json-stringify compiled from the declared 200 schema.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve from this file, like bench/run.mjs and bench/parity.mjs do, so the script
// runs from any cwd. The env overrides let it run inside the built image too.
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const FASTIFY_DIR = process.env.FASTIFY_DIR ?? join(ROOT, 'servers', 'node-fastify');
const PRODUCTS_PATH = process.env.PRODUCTS_PATH ?? join(ROOT, 'data', 'products.json');

const require = createRequire(join(FASTIFY_DIR, 'server.js'));
const fjs = require('fast-json-stringify');

const products = JSON.parse(readFileSync(PRODUCTS_PATH, 'utf8'));

// Reproduce exactly what the benchmark asks for: one category, price window, in
// stock, sorted, first 50.
const candidates = products.filter(p => p.category === 'books');
const kept = candidates.filter(p => p.stock > 0 && p.price >= 100 && p.price <= 800);
kept.sort((a, b) => a.price - b.price || a.id - b.id);
const payload = { total: kept.length, items: kept.slice(0, 50) };

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
const schema = {
  type: 'object',
  properties: { total: { type: 'integer' }, items: { type: 'array', items: productSchema } },
};

const stringifySchema = fjs(schema);

// sanity: identical output
const a = JSON.stringify(payload);
const b = stringifySchema(payload);
console.log(`payload: ${payload.items.length} items, ${(a.length / 1024).toFixed(1)} KB`);
console.log(`identical output: ${a === b}`);
console.log(`fast-json-stringify version: ${require('fast-json-stringify/package.json').version}`);

function bench(label, fn, iterations = 20000) {
  for (let i = 0; i < 2000; i++) fn(); // warm the JIT
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const t1 = process.hrtime.bigint();
  const perOp = Number(t1 - t0) / iterations / 1000; // microseconds
  console.log(`  ${label.padEnd(34)} ${perOp.toFixed(1)} us/op  ->  ${Math.round(1e6 / perOp).toLocaleString('en-US')} ops/s`);
  return perOp;
}

console.log('\nserialising the same 50-product page:');
const native = bench('JSON.stringify (Express path)', () => JSON.stringify(payload));
const fast = bench('fast-json-stringify (Fastify path)', () => stringifySchema(payload));
console.log(`\nfast-json-stringify is ${(native / fast).toFixed(2)}x native (below 1.00 means it is SLOWER)`);
