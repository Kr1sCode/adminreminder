/**
 * Runs once when the server starts (not during build). Refuses to boot a
 * production instance with insecure defaults, and warns about weaker-but-
 * tolerable configuration.
 */

const DEV_JWT_DEFAULT = "ar-adminreminder-dev-secret-change-in-production-please";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const isProd = process.env.NODE_ENV === "production";
  const jwt = process.env.JWT_SECRET;

  if (isProd) {
    if (!jwt || jwt === DEV_JWT_DEFAULT) {
      throw new Error(
        "[AR] JWT_SECRET nie jest ustawiony (lub ma wartość domyślną). " +
          "Ustaw długi, losowy JWT_SECRET przed uruchomieniem w produkcji: openssl rand -base64 48"
      );
    }
    if (jwt.length < 32) {
      throw new Error("[AR] JWT_SECRET jest zbyt krótki — użyj co najmniej 32 znaków losowych.");
    }
    if (!process.env.CRON_SECRET) {
      console.warn("[AR] Uwaga: CRON_SECRET nie jest ustawiony — endpoint cron będzie odrzucał wszystkie żądania.");
    }
    if (!process.env.SETTINGS_KEY) {
      console.warn(
        "[AR] Uwaga: SETTINGS_KEY nie jest ustawiony — sekrety w ustawieniach są szyfrowane kluczem " +
          "wyprowadzonym z JWT_SECRET. Zmiana JWT_SECRET uniemożliwi ich odszyfrowanie."
      );
    }
  }

  // Built-in scheduler: runs checks + notifications on the cron stored in
  // settings, so no external cron is required. Disable with AR_SCHEDULER=off
  // (e.g. on a read-only demo instance).
  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();

  // Courtesy check for a newer signed release (lib/update-check.ts), cached
  // in settings so this only actually reaches GitHub once a day no matter
  // how often the process restarts. Fire and forget: never delays startup,
  // never throws.
  import("./lib/update-check")
    .then(({ checkForUpdate }) => checkForUpdate())
    .catch(() => {});
}
