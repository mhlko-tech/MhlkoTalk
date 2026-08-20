import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

export type UpdateActivity =
  | { phase: "downloading"; progress: number | null }
  | { phase: "installing"; progress: 100 };

let started = false;

export function startAutomaticUpdater(
  onActivity: (activity: UpdateActivity | null) => void,
) {
  if (started) return () => undefined;
  started = true;
  let cancelled = false;
  const timer = window.setTimeout(async () => {
    try {
      const update = await check({ timeout: 8_000 });
      if (!update || cancelled) return;
      let downloaded = 0;
      let total: number | undefined;
      await update.downloadAndInstall((event) => {
        if (cancelled) return;
        if (event.event === "Started") total = event.data.contentLength;
        if (event.event === "Progress") downloaded += event.data.chunkLength;
        if (event.event === "Finished") {
          onActivity({ phase: "installing", progress: 100 });
          return;
        }
        onActivity({
          phase: "downloading",
          progress: total ? Math.min(99, Math.round((downloaded / total) * 100)) : null,
        });
      });
      if (!cancelled) await relaunch();
    } catch {
      // Startup and normal app use must never be blocked by update/network errors.
      if (!cancelled) onActivity(null);
    }
  }, 850);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}
