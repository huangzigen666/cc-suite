FROM docker.io/library/node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

COPY --chown=65532:65532 --chmod=0444 scripts/lib/agy-proxy-policy.mjs /app/lib/agy-proxy-policy.mjs
COPY --chown=65532:65532 --chmod=0444 scripts/lib/agy-egress-proxy.mjs /app/lib/agy-egress-proxy.mjs
COPY --chown=65532:65532 --chmod=0555 scripts/agy-egress-proxy.mjs /app/agy-egress-proxy.mjs
RUN chmod 0555 /app /app/lib

LABEL org.opencontainers.image.title="cc-suite AGY R14 egress sidecar probe" \
      org.opencontainers.image.description="Exact-client, exact-host, pinned-IP CONNECT broker; evidence gathering only"

ENV HOME=/tmp \
    NODE_ENV=production \
    PATH=/usr/local/bin:/usr/bin:/bin

USER 65532:65532
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/node", "/app/agy-egress-proxy.mjs"]
