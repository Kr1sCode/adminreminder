FROM node:22-alpine

# docker-cli-compose: `docker compose` subcommand used to rebuild/restart the
# app service. tar: extracts the signed source archive. rsync: syncs it into
# /workspace without clobbering server-local files (.env, docker-compose.override.yml)
# that never ship in the release tarball.
RUN apk add --no-cache docker-cli docker-cli-compose tar rsync

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

# No EXPOSE on purpose: this only needs to be reachable from the app service
# over the compose-internal network, never published to the host.
ENTRYPOINT ["node", "server.js"]
