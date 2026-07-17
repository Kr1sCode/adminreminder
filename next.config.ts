import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/**
 * A self-hosted admin tool has no reason to load anything cross-origin, so the
 * CSP is locked to 'self'. Next needs inline styles and (in dev) eval for
 * hydration and fast refresh; everything external is denied, which is what
 * actually blocks injected third-party resources.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // HSTS only in production; sending it over dev http would be counterproductive.
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Branded entry point: a link to /adminreminder (e.g. from the portfolio, via
  // a reverse proxy that keeps the path) lands on the app root, which then routes
  // to /login or /dashboard depending on the session.
  async redirects() {
    return [
      { source: "/adminreminder", destination: "/", permanent: false },
      { source: "/adminreminder/:path*", destination: "/", permanent: false },
      // Former name, kept so links published before the rename keep working.
      { source: "/adminredminer", destination: "/", permanent: false },
      { source: "/adminredminer/:path*", destination: "/", permanent: false },
    ];
  },
};

export default nextConfig;
