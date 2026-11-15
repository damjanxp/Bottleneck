# Build context = repository root:
#   docker build -f apps/sidecar/Dockerfile -t bottleneck-sidecar .
FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/sidecar ./apps/sidecar
COPY schema ./schema
RUN npm ci --ignore-scripts --workspace @bottleneck/sidecar
RUN npm run build -w @bottleneck/sidecar

FROM node:24-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /repo/apps/sidecar/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.mjs"]
