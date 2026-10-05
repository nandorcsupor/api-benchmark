# Rust vs Node.js vs Python API benchmark.
#   make all   -> data, build, parity, bench, render (render also rewrites README.md)
SHELL := /bin/bash
.ONESHELL:
.SHELLFLAGS := -e -o pipefail -c

NET        ?= bench-net
SERVER_CPU ?= 1
OHA_ARCH   := $(shell uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')

IMG_AXUM    := api-benchmark/rust-axum:latest
IMG_FASTIFY := api-benchmark/node-fastify:latest
IMG_EXPRESS := api-benchmark/node-express:latest
IMG_FASTAPI := api-benchmark/python-fastapi:latest
IMG_OHA     := api-benchmark/oha:latest

PARITY_CONTAINERS := parity-axum parity-fastify parity-express parity-fastapi
BENCH_CONTAINERS  := bench-axum bench-fastify bench-express bench-fastapi

.PHONY: all data build parity bench render clean

all: data build parity bench render

# ---- dataset: generated once, then committed ----
data: data/products.json
data/products.json: data/generate.mjs
	node data/generate.mjs

# ---- images ----
build: data
	docker build -f servers/rust-axum/Dockerfile      -t $(IMG_AXUM)    .
	docker build -f servers/node-fastify/Dockerfile   -t $(IMG_FASTIFY) .
	docker build -f servers/node-express/Dockerfile   -t $(IMG_EXPRESS) .
	docker build -f servers/python-fastapi/Dockerfile -t $(IMG_FASTAPI) .
	docker build -f bench/oha.Dockerfile --build-arg OHA_ARCH=$(OHA_ARCH) -t $(IMG_OHA) bench
	@echo "built: $(IMG_AXUM) $(IMG_FASTIFY) $(IMG_EXPRESS) $(IMG_FASTAPI) $(IMG_OHA)"

# ---- parity gate: all four stacks must return the same JSON value (parsed, not byte-compared) ----
# These containers publish host ports. That is fine here and only here: parity is
# not measured, so the port-forward proxy cannot distort anything. The measured
# runs in `make bench` never publish a port.
parity:
	docker network inspect $(NET) >/dev/null 2>&1 || docker network create $(NET)
	trap 'docker rm -f $(PARITY_CONTAINERS) >/dev/null 2>&1 || true' EXIT
	docker rm -f $(PARITY_CONTAINERS) >/dev/null 2>&1 || true
	docker run -d --name parity-axum    --network $(NET) -p 127.0.0.1:18081:8080 $(IMG_AXUM)    >/dev/null
	docker run -d --name parity-fastify --network $(NET) -p 127.0.0.1:18082:8080 $(IMG_FASTIFY) >/dev/null
	docker run -d --name parity-express --network $(NET) -p 127.0.0.1:18083:8080 $(IMG_EXPRESS) >/dev/null
	docker run -d --name parity-fastapi --network $(NET) -p 127.0.0.1:18084:8080 $(IMG_FASTAPI) >/dev/null
	node bench/parity.mjs

# ---- measurement: never without a passing parity gate ----
bench: parity
	node bench/run.mjs

# ---- carousel, PNGs, PDF, LinkedIn copy, README ----
# README.md is generated from the same two inputs as the carousel, so a re-run can
# never leave the README quoting different numbers from the slides.
render: render/node_modules
	node render/render.mjs results/results.json render/config.json out
	# out/ is gitignored LinkedIn collateral; docs/results.png is the one chart the
	# README embeds, so it is copied out and committed.
	mkdir -p docs && cp out/results.png docs/results.png
	node render/readme.mjs results/results.json render/config.json README.md bench/urls.txt bench/parity.mjs
render/node_modules: render/package.json
	npm ci --prefix render
	npx --prefix render playwright install chromium
	touch render/node_modules

clean:
	docker rm -f $(BENCH_CONTAINERS) $(PARITY_CONTAINERS) >/dev/null 2>&1 || true
	docker network rm $(NET) >/dev/null 2>&1 || true
	# docs/results.png is committed and the README embeds it, so clean leaves it alone.
	rm -rf out out-mock
	@echo "removed benchmark containers, the $(NET) network, out/ and out-mock/"
