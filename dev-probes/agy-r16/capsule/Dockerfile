# R16 capsule build source.
#
# Reuses the already-reviewed R13 PID 1 privilege-drop supervisor
# (dev-probes/agy-r13/agy-supervisor.c) and the R14 bootstrap-receiver
# (dev-probes/agy-r14/capsule/bootstrap-receiver.c). No change to that
# supervisor or to the privilege-drop / lifecycle-attribution design is
# claimed for R16; only the vendored AGY binary (1.1.14) and the
# workspace write-proof probe differ from R14.
#
# Build from the repository root:
#   container build --progress plain \
#     --tag cc-suite/agy-r16-probe:1.1.14 \
#     --file dev-probes/agy-r16/capsule/Dockerfile .
#
# The vendored binary at dev-probes/agy-r16/capsule/input/antigravity must
# be the independently verified Linux ARM64 AGY 1.1.14 binary. It is
# gitignored and NOT committed (R13/R14 precedent).

FROM docker.io/library/debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      gcc=4:12.2.0-3 \
      libc6-dev=2.36-9+deb12u14 \
    && rm -rf /var/lib/apt/lists/*

# Reused, unchanged supervisor sources (single source of truth in R13/R14).
COPY dev-probes/agy-r13/agy-supervisor.c /src/agy-supervisor.c
COPY dev-probes/agy-r14/capsule/bootstrap-receiver.c /src/bootstrap-receiver.c
RUN gcc -std=c17 -O2 -fstack-protector-strong -D_FORTIFY_SOURCE=2 \
      -Wall -Wextra -Werror -Wformat=2 -Wconversion -Wshadow \
      -o /out-agy-supervisor /src/agy-supervisor.c \
    && gcc -std=c17 -O2 -fstack-protector-strong -D_FORTIFY_SOURCE=2 \
      -Wall -Wextra -Werror -Wformat=2 -Wconversion -Wshadow \
      -o /out-bootstrap-receiver /src/bootstrap-receiver.c \
    && strip /out-agy-supervisor /out-bootstrap-receiver

FROM docker.io/library/debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241

ARG AGY_VERSION=1.1.14

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates=20250419~deb12u1 \
      curl=7.88.1-10+deb12u15 \
      libcap2-bin=1:2.66-4+deb12u3+b1 \
      nftables=1.0.6-2+deb12u2 \
      util-linux=2.38.1-5+deb12u3 \
    && mkdir -p /home/agy /run/agy-bootstrap /workspace \
    && chmod 0555 /home/agy /run/agy-bootstrap /workspace \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build --chmod=0555 /out-agy-supervisor /usr/local/bin/agy-supervisor
COPY --from=build --chmod=0555 /out-bootstrap-receiver /usr/local/bin/agy-bootstrap-receiver
COPY --chmod=0555 dev-probes/agy-r16/capsule/input/antigravity /usr/local/bin/agy
COPY --chmod=0555 dev-probes/agy-r16/capsule/entrypoint.sh /usr/local/bin/agy-r16-entrypoint
COPY --chmod=0555 dev-probes/agy-r16/capsule/probe.sh /usr/local/bin/agy-r16-probe

LABEL org.opencontainers.image.title="cc-suite AGY R16 workspace-write capsule probe" \
      org.opencontainers.image.version="${AGY_VERSION}" \
      org.opencontainers.image.description="Credential-free isolated-volume, sidecar-egress, workspace-write-bound probe; not a production image"

ENV HOME=/home/agy \
    PATH=/usr/local/bin:/usr/bin:/bin \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/agy-r16-entrypoint"]
CMD ["/usr/local/bin/agy", "--version"]
