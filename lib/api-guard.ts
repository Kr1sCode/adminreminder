import { NextRequest, NextResponse } from "next/server";
import { verifyApiKey, bearerToken, type VerifiedKey } from "./api-keys";
import { rateLimit, clientIp } from "./rate-limit";
import type { ApiScope } from "@/db/schema";

// Generous ceiling for machine callers; still bounds abuse of a leaked key.
const RL_LIMIT = 120;
const RL_WINDOW_MS = 60_000;

type Handler = (req: NextRequest, key: VerifiedKey) => Promise<NextResponse> | NextResponse;

/**
 * Wraps a v1 route: requires a valid API key bearing `scope`, and rate-limits
 * per key. Returns 401/403/429 with a JSON body on failure.
 */
export function withApiKey(scope: ApiScope, handler: Handler) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const key = await verifyApiKey(bearerToken(req.headers));
    if (!key) {
      return NextResponse.json(
        { error: "Nieprawidłowy lub brakujący klucz API" },
        { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
      );
    }
    if (!key.scopes.includes(scope)) {
      return NextResponse.json({ error: `Klucz nie ma uprawnienia „${scope}”` }, { status: 403 });
    }

    const rl = rateLimit(`api:${key.id}:${clientIp(req.headers)}`, RL_LIMIT, RL_WINDOW_MS);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Przekroczono limit zapytań" },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } }
      );
    }

    return handler(req, key);
  };
}
