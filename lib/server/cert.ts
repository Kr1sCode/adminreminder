import tls from "tls";
import { X509Certificate } from "node:crypto";
import { CertInfo, CertCheckError } from "../cert-checker";

/** OID for TLS Web Server Authentication — the EKU a server cert must carry. */
export const EKU_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

/**
 * Fetches HTTPS certificate expiry information for a given host.
 * This file MUST only be imported from server-side code (API routes, server actions).
 */
export async function getCertificateExpiry(
  host: string,
  port: number = 443,
  timeoutMs: number = 8000
): Promise<CertInfo> {
  return new Promise((resolve, reject) => {
    const options: tls.ConnectionOptions = {
      host,
      port,
      servername: host,
      rejectUnauthorized: false,
    };

    const socket = tls.connect(options, () => {
      try {
        const peerCert = socket.getPeerCertificate(true);
        socket.end();

        if (!peerCert || !peerCert.valid_to) {
          reject(new CertCheckError("Nie udało się odczytać certyfikatu", "NO_CERT"));
          return;
        }

        const expiryDate = new Date(peerCert.valid_to);
        const validFrom = peerCert.valid_from ? new Date(peerCert.valid_from) : undefined;

        resolve({
          expiryDate,
          validFrom,
          subject: (peerCert.subject?.CN as string) || (peerCert.subject?.O as string) || undefined,
          issuer: (peerCert.issuer?.CN as string) || (peerCert.issuer?.O as string) || undefined,
        });
      } catch (err) {
        socket.end();
        reject(new CertCheckError("Błąd podczas parsowania certyfikatu", "PARSE_ERROR"));
      }
    });

    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new CertCheckError("Przekroczono czas oczekiwania na połączenie", "TIMEOUT"));
    });

    socket.on("error", (err) => {
      reject(new CertCheckError(`Błąd połączenia: ${err.message}`, "CONNECTION_ERROR"));
    });
  });
}

export interface TlsEndpointProbe {
  expiryDate: Date;
  validFrom?: Date;
  subject?: string;
  issuer?: string;
  /** SHA-256 as "AA:BB:…", the form the UI shows and pins against. */
  fingerprint256: string;
  /** DNS/IP names the certificate is valid for. */
  sanNames: string[];
  /** Extended Key Usage OIDs; a server cert must include EKU_SERVER_AUTH. */
  eku: string[];
  /** Subject equals issuer — a self-signed leaf, never right for a real service. */
  selfSigned: boolean;
  /** Whether the chain validated against the system trust store. */
  authorized: boolean;
  /** Why the chain did not validate (e.g. "SELF_SIGNED_CERT_IN_CHAIN"). */
  authorizationError?: string;
  /** True when the requested name is covered by SAN/CN. */
  nameMatches: boolean;
}

/**
 * Probes a live TLS service and reports what it is actually serving — the same
 * tls.connect used for https_cert, but reading the whole leaf rather than only
 * its expiry. One probe covers every port that speaks TLS on connect: LDAPS
 * (636), HTTPS (443), Exchange, RD Gateway, reverse proxies, VPN heads. The
 * role is a label the operator gives it; the mechanics do not change with it.
 *
 * `rejectUnauthorized: false` so an expired or untrusted cert is *read and
 * reported* rather than throwing — a monitor must see the broken cert, not
 * refuse to look at it. The chain verdict is captured separately in `authorized`.
 *
 * StartTLS-only ports (25/587/143) are out of scope here: they need a protocol
 * handshake before the certificate appears. Server-side only.
 */
export async function probeTlsEndpoint(
  host: string,
  port: number,
  opts: { sni?: string; timeoutMs?: number } = {}
): Promise<TlsEndpointProbe> {
  const servername = (opts.sni?.trim() || host).replace(/\.$/, "");
  const timeoutMs = opts.timeoutMs ?? 8000;

  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername, rejectUnauthorized: false }, () => {
      try {
        const peer = socket.getPeerCertificate(true);
        const authorized = socket.authorized;
        const authorizationError = socket.authorizationError?.message || undefined;
        socket.end();

        if (!peer || !peer.raw || !peer.valid_to) {
          reject(new CertCheckError("Nie udało się odczytać certyfikatu", "NO_CERT"));
          return;
        }

        const x = new X509Certificate(peer.raw);
        const sanNames = (x.subjectAltName || "")
          .split(",")
          .map((s) => s.trim().replace(/^(DNS|IP Address):/i, ""))
          .filter(Boolean);

        resolve({
          expiryDate: new Date(peer.valid_to),
          validFrom: peer.valid_from ? new Date(peer.valid_from) : undefined,
          subject: (peer.subject?.CN as string) || (peer.subject?.O as string) || undefined,
          issuer: (peer.issuer?.CN as string) || (peer.issuer?.O as string) || undefined,
          fingerprint256: x.fingerprint256,
          sanNames,
          eku: x.keyUsage ?? [],
          selfSigned: x.subject === x.issuer,
          authorized,
          authorizationError,
          // checkHost honours SAN, wildcards and the CN fallback per RFC 6125.
          nameMatches: x.checkHost(servername) !== undefined,
        });
      } catch (err) {
        socket.end();
        reject(new CertCheckError("Błąd podczas parsowania certyfikatu", "PARSE_ERROR"));
      }
    });

    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new CertCheckError("Przekroczono czas oczekiwania na połączenie", "TIMEOUT"));
    });

    socket.on("error", (err) => {
      reject(new CertCheckError(`Błąd połączenia: ${err.message}`, "CONNECTION_ERROR"));
    });
  });
}

/** A pinned fingerprint may be pasted with colons, spaces or lowercase. */
export function normalizeFingerprint(value: string): string {
  return value.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}
