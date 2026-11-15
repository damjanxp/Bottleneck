# Caddy + the built frontend. Build context = repository root:
#   docker build -f deploy/caddy.Dockerfile -t bottleneck-web .
# The web build happens here so a VPS needs no Node toolchain.
FROM node:24-alpine AS web
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json vercel.json ./
COPY packages ./packages
COPY apps/web ./apps/web
COPY apps/sidecar/package.json ./apps/sidecar/package.json
COPY schema ./schema
RUN npm ci --ignore-scripts --workspace @bottleneck/web --include-workspace-root
RUN npm run build -w @bottleneck/web
COPY deploy/gen-headers.mjs ./deploy/gen-headers.mjs
RUN node deploy/gen-headers.mjs > /security-headers.caddy

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /security-headers.caddy /etc/caddy/security-headers.caddy
COPY --from=web /repo/apps/web/dist /srv
# Unprivileged: the official image's caddy binary carries cap_net_bind_service for ports 80/443.
USER 1000:1000
EXPOSE 80 443
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8081/healthz"]
