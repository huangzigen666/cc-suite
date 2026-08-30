FROM docker.io/library/debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      gcc=4:12.2.0-3 \
      libc6-dev=2.36-9+deb12u14 \
    && rm -rf /var/lib/apt/lists/*

COPY dev-probes/agy-r13/agy-supervisor.c /src/agy-supervisor.c
RUN gcc -std=c17 -O2 -fstack-protector-strong -D_FORTIFY_SOURCE=2 \
      -Wall -Wextra -Werror -Wformat=2 -Wconversion -Wshadow \
      -o /out-agy-supervisor /src/agy-supervisor.c \
    && strip /out-agy-supervisor

FROM docker.io/library/debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241

ARG AGY_VERSION=1.1.11

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates=20250419~deb12u1 \
      curl=7.88.1-10+deb12u15 \
      libcap2-bin=1:2.66-4+deb12u3+b1 \
      netcat-openbsd=1.219-1 \
      nftables=1.0.6-2+deb12u2 \
      util-linux=2.38.1-5+deb12u3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build --chmod=0555 /out-agy-supervisor /usr/local/bin/agy-supervisor
COPY --chmod=0555 dev-probes/agy-r13/input/antigravity /usr/local/bin/agy
COPY --chmod=0555 dev-probes/agy-r13/entrypoint.sh /usr/local/bin/agy-r13-entrypoint

LABEL org.opencontainers.image.title="cc-suite AGY R13 lifecycle probe" \
      org.opencontainers.image.version="${AGY_VERSION}" \
      org.opencontainers.image.description="Credential-free VM lifecycle-attribution probe; not a production image"

ENV HOME=/tmp/agy \
    PATH=/usr/local/bin:/usr/bin:/bin \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/agy-r13-entrypoint"]
CMD ["/usr/local/bin/agy", "--version"]
