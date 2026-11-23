FROM node:22-bookworm-slim AS app
WORKDIR /app
COPY package.json package-lock.json ./
COPY src/shared/package.json src/shared/package.json
COPY src/signaling/package.json src/signaling/package.json
COPY src/relay/package.json src/relay/package.json
COPY src/web-peer/package.json src/web-peer/package.json
RUN npm ci
COPY . .
ENV DS01_RUNTIME_DIR=/app/.runtime DS01_DATA_DIR=/app/.data
RUN mkdir -p /app/.data /app/.runtime && chown -R node:node /app
USER node
CMD ["npm", "run", "start:signaling"]

FROM app AS web-build
ARG VITE_SIGNAL_URL=http://localhost:4001
ARG VITE_RELAY_URL=http://localhost:4002
ARG VITE_RELAY_URLS=http://localhost:4003
ARG VITE_ICE_SERVERS
ARG VITE_E2EE=1
ARG VITE_RELAY_SELECTION=latency-load
ENV VITE_SIGNAL_URL=$VITE_SIGNAL_URL VITE_RELAY_URL=$VITE_RELAY_URL VITE_RELAY_URLS=$VITE_RELAY_URLS
ENV VITE_ICE_SERVERS=$VITE_ICE_SERVERS
ENV VITE_E2EE=$VITE_E2EE VITE_RELAY_SELECTION=$VITE_RELAY_SELECTION
RUN npm run build:web

FROM caddy:2-alpine AS web
COPY --from=web-build /app/src/web-peer/dist /srv
COPY deploy/Caddyfile.local /etc/caddy/Caddyfile
