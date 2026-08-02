import type { UpdateInfo } from "./update-check";

export class UpdateInstallError extends Error {}

/**
 * Triggers the updater sidecar (update-tools/updater/) rather than doing the
 * rebuild itself: this process runs inside the same hardened container it
 * would need to rebuild (cap_drop: ALL, no docker.sock), so it physically
 * cannot do it in-process. The sidecar is a separate, minimal container that
 * DOES hold the docker.sock mount, and re-verifies the signed manifest and
 * the source tarball's hash on its own before touching anything — this
 * function's `info` is only used to decide whether to bother calling it.
 *
 * Synchronous on purpose: the sidecar downloads, verifies, extracts and runs
 * `docker compose up -d --build app`, which stops and recreates the very
 * container running this request — same "the connection dies mid-flight and
 * that's the success signal" contract as the Windows service-restart path
 * (app/dashboard/dashboard-client.tsx installUpdate()). A generous timeout
 * covers a slow `npm ci`/build on constrained hardware.
 */
export async function triggerLinuxUpdate(info: UpdateInfo): Promise<void> {
  if (process.platform !== "linux") {
    throw new UpdateInstallError("Ten mechanizm działa tylko na Linuksie.");
  }
  const updaterUrl = process.env.UPDATER_URL;
  const updateSecret = process.env.UPDATE_SECRET;
  if (!updaterUrl || !updateSecret) {
    throw new UpdateInstallError("Sidecar aktualizacji (UPDATER_URL/UPDATE_SECRET) nie jest skonfigurowany.");
  }
  if (!info.sourceUrl || !info.sourceSha256) {
    throw new UpdateInstallError("Ten manifest nie zawiera źródeł do automatycznej aktualizacji.");
  }

  let res: Response;
  try {
    res = await fetch(`${updaterUrl.replace(/\/$/, "")}/update`, {
      method: "POST",
      headers: { Authorization: `Bearer ${updateSecret}` },
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
  } catch (err: any) {
    throw new UpdateInstallError(`Nie udało się skontaktować z sidecarem aktualizacji: ${err.message || err}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new UpdateInstallError(`Sidecar aktualizacji odrzucił żądanie (HTTP ${res.status}): ${body}`);
  }
}
