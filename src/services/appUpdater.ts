import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

export type UpdateActivity =
  | { phase: "checking"; progress: null }
  | { phase: "downloading"; progress: number | null }
  | { phase: "installing"; progress: 100 }
  | { phase: "error"; progress: null; message: string };

type ActivityListener = (activity: UpdateActivity | null) => void;

const activityListeners = new Set<ActivityListener>();
const readyListeners = new Set<() => void>();
let activity: UpdateActivity | null = { phase: "checking", progress: null };
let ready = false;
let running = false;

function emit(next: UpdateActivity | null) {
  activity = next;
  activityListeners.forEach((listener) => listener(next));
}

function finish() {
  ready = true;
  emit(null);
  readyListeners.forEach((listener) => listener());
}

async function run() {
  if (running || ready) return;
  running = true;
  emit({ phase: "checking", progress: null });
  try {
    // Browser development and the hosted web build do not have the native
    // updater. Only the installed desktop application is gated by it.
    if (!("__TAURI_INTERNALS__" in window)) {
      finish();
      return;
    }
    const update = await check({ timeout: 15_000 });
    if (!update) {
      finish();
      return;
    }
    let downloaded = 0;
    let total: number | undefined;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") total = event.data.contentLength;
      if (event.event === "Progress") downloaded += event.data.chunkLength;
      if (event.event === "Finished") {
        emit({ phase: "installing", progress: 100 });
        return;
      }
      emit({
        phase: "downloading",
        progress: total
          ? Math.min(99, Math.round((downloaded / total) * 100))
          : null,
      });
    });
    await relaunch();
  } catch {
    emit({
      phase: "error",
      progress: null,
      message: "Could not check for updates. Check your internet connection and retry.",
    });
  } finally {
    running = false;
  }
}

export function subscribeStartupUpdater(
  onActivity: ActivityListener,
  onReady: () => void,
) {
  activityListeners.add(onActivity);
  readyListeners.add(onReady);
  onActivity(activity);
  if (ready) onReady();
  else void run();
  return () => {
    activityListeners.delete(onActivity);
    readyListeners.delete(onReady);
  };
}

export function retryStartupUpdater() {
  if (running || ready) return;
  void run();
}
