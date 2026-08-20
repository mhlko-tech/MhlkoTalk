import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { NativeRecordingStatus } from "./services/nativeRecording";

const format = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 3600)
    .toString()
    .padStart(2, "0")}:${Math.floor((seconds % 3600) / 60)
    .toString()
    .padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

export function RecordingOverlay() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    let seenActive = false;
    const refresh = async () => {
      const status = await invoke<NativeRecordingStatus>(
        "native_recording_status",
      ).catch(() => null);
      if (!status) return;
      if (status.active) {
        seenActive = true;
        setElapsed(status.elapsedMs);
      } else if (seenActive) {
        void getCurrentWindow().close();
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 350);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="native-recording-overlay" aria-label="Recording active">
      <b>●</b> REC {format(elapsed)}
    </div>
  );
}
