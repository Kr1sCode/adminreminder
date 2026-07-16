/**
 * Whether auth cookies should carry the `Secure` flag.
 *
 * A `Secure` cookie is silently dropped by the browser over plain HTTP, which
 * breaks login on an instance reached at http://host:port with no TLS in front.
 * Drive the flag off APP_ORIGIN's scheme instead of NODE_ENV: behind an HTTPS
 * reverse proxy (APP_ORIGIN=https://…) cookies stay Secure, while a bare-HTTP
 * deployment still works. Falls back to the NODE_ENV heuristic when APP_ORIGIN
 * is unset.
 */
export function cookieSecure(): boolean {
  const origin = process.env.APP_ORIGIN;
  if (origin) return origin.startsWith("https://");
  return process.env.NODE_ENV === "production";
}
