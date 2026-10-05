// Writes data/products.json. Deterministic: mulberry32 seeded with 42.
// Run once; the output is committed so every stack loads byte-identical data.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 42;
const COUNT = 10000;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const intIn = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1)); // inclusive

const CATEGORIES = ['electronics', 'books', 'home', 'toys', 'sports', 'beauty', 'garden', 'grocery', 'fashion', 'automotive'];
const TAGS = ['new', 'sale', 'bestseller', 'eco', 'limited', 'bundle', 'refurbished', 'gift'];
const ADJECTIVES = [
  'Lumen', 'Nordic', 'Vertex', 'Aurora', 'Quartz', 'Harbor', 'Summit', 'Cedar',
  'Onyx', 'Pacific', 'Meridian', 'Copper', 'Solstice', 'Granite', 'Ember', 'Atlas',
  'Juniper', 'Cobalt', 'Driftwood', 'Zenith', 'Marble', 'Falcon', 'Linen', 'Basalt',
];
const NOUNS = [
  'Desk Lamp', 'Travel Mug', 'Running Shoe', 'Field Notebook', 'Wall Clock', 'Chef Knife',
  'Yoga Mat', 'Tool Kit', 'Coffee Grinder', 'Bike Light', 'Rain Jacket', 'Plant Pot',
  'Hand Cream', 'Board Game', 'Head Torch', 'Water Bottle', 'Garden Shear', 'Wireless Mouse',
  'Duffel Bag', 'Table Fan', 'Pocket Radio', 'Storage Box', 'Picture Frame', 'Door Mat',
];

// Exactly 1000 products per category, shuffled so category does not track id.
const deck = CATEGORIES.flatMap(c => Array(COUNT / CATEGORIES.length).fill(c));
for (let i = deck.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [deck[i], deck[j]] = [deck[j], deck[i]];
}

const FROM = Date.UTC(2023, 0, 1, 0, 0, 0);
const TO = Date.UTC(2026, 5, 30, 23, 59, 59);

const products = [];
for (let id = 1; id <= COUNT; id++) {
  const name = `${pick(ADJECTIVES)} ${pick(NOUNS)} ${String(id).padStart(4, '0')}`;
  const category = deck[id - 1];
  const price = intIn(100, 99999) / 100;              // 1.00 .. 999.99
  const rating = intIn(10, 50) / 10;                  // 1.0 .. 5.0
  const stock = rnd() < 0.1 ? 0 : intIn(1, 500);      // ~10% out of stock
  const tagCount = intIn(0, 3);
  const pool = TAGS.slice();
  const tags = [];
  for (let t = 0; t < tagCount; t++) tags.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  // Plain ISO 8601 UTC string. Never parsed into a date type by any server: a date
  // type would reformat it on the way out and break JSON parity between stacks.
  const created_at = new Date(intIn(FROM, TO)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  products.push({ id, name, category, price, rating, stock, tags, created_at });
}

const out = join(here, 'products.json');
writeFileSync(out, JSON.stringify(products));

const counts = {};
for (const p of products) counts[p.category] = (counts[p.category] || 0) + 1;
console.log(`wrote ${out}`);
console.log(`  products:      ${products.length}`);
console.log(`  per category:  ${JSON.stringify(counts)}`);
console.log(`  out of stock:  ${products.filter(p => p.stock === 0).length}`);
console.log(`  price range:   ${Math.min(...products.map(p => p.price))} .. ${Math.max(...products.map(p => p.price))}`);
console.log(`  first:         ${JSON.stringify(products[0])}`);
