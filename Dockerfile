FROM node:22-alpine AS base
# Node 20 is EOL: better-sqlite3-multiple-ciphers stopped publishing prebuilds
# for it, which would force a node-gyp compile from source on every build.

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next.js collects completely anonymous telemetry data about general usage.
ENV NEXT_TELEMETRY_DISABLED 1

RUN npm run build

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV production
ENV NEXT_TELEMETRY_DISABLED 1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

# Set the correct permission for prerender cache
RUN mkdir .next
RUN chown nextjs:nodejs .next

# The database lives on a volume mounted here. Creating it in the image means a
# named volume inherits this ownership; an empty mountpoint would be created by
# the daemon as root, which the unprivileged nextjs user cannot write to.
RUN mkdir -p /app/data && chown nextjs:nodejs /app/data

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Schema bootstrap needs the migration scripts, lib/db-encryption.js (the
# same file server.js uses internally, but that copy is bundled into a chunk —
# init-db.js runs outside the bundle and needs a real file on disk) and the
# native better-sqlite3-multiple-ciphers module, none of which are traced into
# the standalone bundle because nothing in the server graph requires them at
# build time the way a plain top-level import would be.
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/lib/db-encryption.js ./lib/db-encryption.js
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/better-sqlite3-multiple-ciphers ./node_modules/better-sqlite3-multiple-ciphers
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER nextjs

EXPOSE 3000

ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
