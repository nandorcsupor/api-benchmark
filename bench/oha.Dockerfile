# Load generator image: Debian slim + the official oha release binary.
# curl is kept in the image so the runner can health-check the server from
# inside bench-net, without publishing a host port.
FROM debian:bookworm-20260918-slim
ARG OHA_ARCH=amd64
# Pinned to the version that produced the committed results. The measuring
# instrument has to be as reproducible as the things it measures, and
# releases/latest/download would silently hand a future reader a different one.
ARG OHA_VERSION=1.16.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /usr/local/bin/oha \
      "https://github.com/hatoo/oha/releases/download/v${OHA_VERSION}/oha-linux-${OHA_ARCH}" \
 && chmod +x /usr/local/bin/oha \
 # Fail the build rather than let a surprise version into results.json, which
 # copies `oha --version` verbatim.
 && oha --version | grep -qx "oha ${OHA_VERSION}"
ENTRYPOINT ["oha"]
