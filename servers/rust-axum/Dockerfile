# Build context is the repo root: the image needs data/products.json too.
# Cargo.lock pins the crates, but nothing pinned the compiler that generates the
# code. rustc is the headline number here, so pin it too.
FROM rust:1.99.0-bookworm AS builder
WORKDIR /build
COPY servers/rust-axum/Cargo.toml servers/rust-axum/Cargo.lock ./
COPY servers/rust-axum/src ./src
# Default release profile. No LTO tweaks, no custom allocator, no unsafe tricks.
RUN cargo build --release --locked \
 && rustc --version > /rustc-version.txt

FROM debian:bookworm-20260918-slim
WORKDIR /app
COPY --from=builder /build/target/release/server /usr/local/bin/server
# Recorded at build time so results.json reports the compiler that actually built
# this binary, not whatever a floating tag resolves to at benchmark time.
COPY --from=builder /rustc-version.txt /app/rustc-version.txt
COPY data/products.json /app/data/products.json
EXPOSE 8080
CMD ["server"]
