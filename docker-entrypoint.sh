#!/bin/sh
# Ensures the database schema exists before the server starts, then hands off
# to the container's command (node server.js). Safe on every restart.
set -e

echo "[entrypoint] bootstrapping schema..."
node scripts/init-db.js

exec "$@"
