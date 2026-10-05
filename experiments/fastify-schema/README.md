# Why Fastify came out below Express

Two side experiments behind the README section of the same name. They are **not** part of the
benchmark: they are not in `results/results.json`, they do not run under `make all`, and they were
not held to the main run's standard (no warmup, no `docker stats` bottleneck check, no spread gate).

Measured 2026-10-03 on the machine recorded in `results/results.json`.

| File | What |
|---|---|
| `ser-bench.mjs` | serialises one of the pages the load pattern generates with `JSON.stringify` and with fast-json-stringify compiled from the server's own 200 schema |
| `derive-noschema.mjs` | writes `.build/server.js`: the current Fastify server minus the `response` block, so the variant cannot drift from the server that is measured |
| `raw/fastify-noschema-*.json` | the three 30 s oha runs of that variant |
| `raw/body-with-schema.json`, `raw/body-without-schema.json` | the two response bodies, byte-identical |
| `raw/serialiser.txt` | captured output of `ser-bench.mjs` |

## Re-running

The microbenchmark needs the Fastify dependencies. Either install them on the host:

```bash
npm ci --prefix servers/node-fastify
node experiments/fastify-schema/ser-bench.mjs
```

or run it inside the image `make build` already produced, which needs nothing installed:

```bash
docker run --rm \
  -v "$PWD/experiments/fastify-schema/ser-bench.mjs:/app/ser-bench.mjs:ro" \
  -e FASTIFY_DIR=/app -e PRODUCTS_PATH=/app/data/products.json \
  --entrypoint node api-benchmark/node-fastify:latest /app/ser-bench.mjs
```

For the throughput variant, run `derive-noschema.mjs`, build an image from
`servers/node-fastify/Dockerfile` with `.build/server.js` in place of `server.js`, put it through
`bench/parity.mjs`, and only then measure it. Do **not** run `make bench` for this: that re-measures
all four stacks and overwrites `results/results.json` and every file in `results/raw/`.

## Provenance

These three runs were measured against the Fastify server as it stood before the finite-price guard
in `servers/node-fastify/server.js` was added. The variant `derive-noschema.mjs` produces today
inherits that guard, so a fresh run of it is not bit-for-bit the same code as the one behind the
6,292 req/s figure.
