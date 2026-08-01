import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UpdateInfo } from "./update-check";

export class UpdateInstallError extends Error {}

/**
 * Downloads the installer named in an already-signature-verified UpdateInfo,
 * checks it against the hash baked into that SAME signed manifest, and — only
 * if it matches exactly — runs it silently. A GitHub release asset can be
 * swapped by anyone with push access to Releases without touching the
 * signing key; the hash check is what stops that from turning into arbitrary
 * code execution on every install that auto-updates.
 *
 * The spawned installer is detached on purpose: its own upgrade flow stops
 * the "AdminReminder" Windows service moments after starting — i.e. it kills
 * the very Node process running this function — so it cannot be a normal
 * child that dies with its parent.
 */
export async function downloadAndInstall(info: UpdateInfo): Promise<void> {
  if (process.platform !== "win32") {
    throw new UpdateInstallError("Automatyczna aktualizacja działa tylko na Windows.");
  }
  if (!info.installerUrl || !info.installerSha256) {
    throw new UpdateInstallError("Ten manifest nie zawiera instalatora do automatycznej aktualizacji.");
  }

  let res: Response;
  try {
    res = await fetch(info.installerUrl, { signal: AbortSignal.timeout(120000) });
  } catch (err: any) {
    throw new UpdateInstallError(`Nie udało się pobrać instalatora: ${err.message || err}`);
  }
  if (!res.ok) {
    throw new UpdateInstallError(`Nie udało się pobrać instalatora (HTTP ${res.status}).`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  const actualHash = createHash("sha256").update(buf).digest("hex");
  if (actualHash !== info.installerSha256.toLowerCase()) {
    throw new UpdateInstallError(
      `Pobrany plik nie zgadza się z podpisanym hashem (oczekiwano ${info.installerSha256}, ` +
        `otrzymano ${actualHash}) — odrzucono, nic nie zostało uruchomione.`
    );
  }

  const dir = await mkdtemp(path.join(tmpdir(), "ar-update-"));
  const exePath = path.join(dir, `AdminReminder-Setup-${info.latestVersion}.exe`);
  await writeFile(exePath, buf);

  const child = spawn(exePath, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}
