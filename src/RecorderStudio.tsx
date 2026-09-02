import { useEffect, useRef, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  NativeScreenRecording,
  getNativeRecordingProcessingStatus,
  getRecorderCapabilities,
  openRecordingsFolder,
  type RecorderCapabilities,
  type NativeRecordingProcessingStatus,
  type RecordingSettings,
} from "./services/nativeRecording";
import { isPaidSubscriptionValue } from "./core/subscription";
import "./studio.css";

const defaults: RecordingSettings = {
  quality: "high",
  fps: 60,
  includeAudio: true,
  includeMic: true,
  systemVolume: 1,
  micVolume: 1,
  noiseCancellation: false,
};
const time = (seconds: number) =>
  `${Math.floor(seconds / 3600)
    .toString()
    .padStart(2, "0")}:${Math.floor((seconds % 3600) / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
const remainingTime = (milliseconds: number | null) => {
  if (milliseconds === null) return "Calculating…";
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

type StudioScene = {
  id: string;
  name: string;
  stream: MediaStream | null;
};

export function RecorderStudio() {
  const plusRecording = isPaidSubscriptionValue(localStorage.getItem("mhtalk.subscription-tier"));
  const recorder = useRef<NativeScreenRecording | null>(null);
  const preview = useRef<HTMLVideoElement | null>(null);
  const [display, setDisplay] = useState<MediaStream | null>(null);
  const [scenes, setScenes] = useState<StudioScene[]>([
    { id: crypto.randomUUID(), name: "Scene 1", stream: null },
  ]);
  const scenesRef = useRef(scenes);
  const [selectedScene, setSelectedScene] = useState(0);
  const [sceneSwitching, setSceneSwitching] = useState(false);
  const [settings, setSettings] = useState<RecordingSettings>(() => {
    try {
      return {
        ...defaults,
        ...(JSON.parse(
          localStorage.getItem("mhtalk.studio.settings") || "{}",
        ) as Partial<RecordingSettings>),
      };
    } catch {
      return defaults;
    }
  });
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [mixLevels, setMixLevels] = useState({ system: 0, microphone: 0 });
  const [status, setStatus] = useState("Ready");
  const [processing, setProcessing] =
    useState<NativeRecordingProcessingStatus | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showTimer, setShowTimer] = useState(
    () => localStorage.getItem("mhtalk.studio.timer") !== "false",
  );
  const recordingRef = useRef(false);
  const processingRef = useRef(false);
  const [capabilities, setCapabilities] = useState<RecorderCapabilities | null>(
    null,
  );

  useEffect(() => {
    if (plusRecording) return;
    setSettings((current) => ({
      ...current,
      fps: current.fps > 60 ? 60 : current.fps,
      quality: current.quality === "lossless" ? "high" : current.quality,
    }));
  }, [plusRecording]);

  useEffect(() => {
    void getRecorderCapabilities()
      .then((value) => {
        setCapabilities(value);
        setStatus(value.ready ? "Ready" : value.message);
      })
      .catch(() => setStatus("Recording engine is unavailable"));
  }, []);
  useEffect(() => {
    localStorage.setItem("mhtalk.studio.settings", JSON.stringify(settings));
  }, [settings]);
  useEffect(() => {
    localStorage.setItem("mhtalk.studio.timer", String(showTimer));
  }, [showTimer]);
  useEffect(() => {
    scenesRef.current = scenes;
  }, [scenes]);
  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);
  useEffect(() => {
    const studioWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void studioWindow
      .onCloseRequested((event) => {
        if (!recordingRef.current && !processingRef.current) return;
        event.preventDefault();
        setStatus(
          recordingRef.current
            ? "Stop recording before closing Studio"
            : "Wait for the final video to finish",
        );
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => {
      void recorder.current?.status().then((value) => {
        setElapsed(Math.round(value.elapsedMs / 1000));
        setBytes(value.bytes);
      });
    }, 500);
    return () => window.clearInterval(id);
  }, [recording]);
  useEffect(() => {
    if (!recording) {
      setMixLevels({ system: 0, microphone: 0 });
      return;
    }
    const id = window.setInterval(() => {
      setMixLevels(recorder.current?.getMixLevels() || { system: 0, microphone: 0 });
    }, 120);
    return () => window.clearInterval(id);
  }, [recording]);
  useEffect(() => {
    if (preview.current) {
      preview.current.srcObject = display;
      if (display) void preview.current.play();
    }
  }, [display]);
  useEffect(
    () => () => {
      scenesRef.current.forEach((scene) =>
        scene.stream?.getTracks().forEach((track) => track.stop()),
      );
    },
    [],
  );
  useEffect(() => {
    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", preventContextMenu);
    return () => document.removeEventListener("contextmenu", preventContextMenu);
  }, []);
  const changeSettings = (next: RecordingSettings) => {
    setSettings(next);
    recorder.current?.updateMix(next);
  };
  const openTimerOverlay = (force = false) => {
    if (!showTimer && !force) return;
    void WebviewWindow.getByLabel("recording-overlay").then((existing) => {
      if (existing) return;
      const overlay = new WebviewWindow("recording-overlay", {
        url: "/#recording-overlay",
        width: 190,
        height: 44,
        x: window.screen.availWidth - 215,
        y: 14,
        transparent: true,
        decorations: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        focus: false,
      });
      overlay.once("tauri://created", () => {
        void overlay.setContentProtected(true);
      });
    });
  };
  const closeTimerOverlay = () => {
    void WebviewWindow.getByLabel("recording-overlay").then((overlay) =>
      overlay?.close(),
    );
  };
  const exitStudio = () => {
    if (recordingRef.current || processingRef.current) {
      setStatus(
        recordingRef.current
          ? "Stop recording before closing Studio"
          : "Wait for the final video to finish",
      );
      return;
    }
    closeTimerOverlay();
    display?.getTracks().forEach((track) => track.stop());
    void getCurrentWindow().destroy();
  };
  const activateScene = async (
    index: number,
    stream: MediaStream,
    name: string,
  ) => {
    if (sceneSwitching || processing) return false;
    const previousIndex = selectedScene;
    const previousDisplay = display;
    scenes.forEach((scene, sceneIndex) =>
      scene.stream
        ?.getVideoTracks()
        .forEach((track) => (track.enabled = sceneIndex === index)),
    );
    stream.getVideoTracks().forEach((track) => (track.enabled = true));
    setSelectedScene(index);
    setDisplay(stream);
    if (!recording || !recorder.current) {
      setStatus(`${name} ready`);
      return true;
    }
    setSceneSwitching(true);
    setStatus(`Switching to ${name}…`);
    try {
      await recorder.current.switchSource(settings, stream);
      setStatus(`Recording · ${name}`);
      return true;
    } catch (error) {
      scenes.forEach((scene, sceneIndex) =>
        scene.stream
          ?.getVideoTracks()
          .forEach((track) => (track.enabled = sceneIndex === previousIndex)),
      );
      setSelectedScene(previousIndex);
      setDisplay(previousDisplay);
      setStatus(
        error instanceof Error ? error.message : "Could not switch scene",
      );
      return false;
    } finally {
      setSceneSwitching(false);
    }
  };
  const chooseDisplay = async (targetIndex = selectedScene) => {
    if (processing || sceneSwitching) return null;
    try {
      setStatus("Choose a screen or window…");
      const selected = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: settings.fps, max: settings.fps } },
        audio: false,
      });
      const sceneId = scenes[targetIndex]?.id || crypto.randomUUID();
      const video = selected.getVideoTracks()[0];
      const surface = video?.getSettings().displaySurface;
      const sourceLabel = video?.label.trim();
      const name =
        surface === "monitor"
          ? `Display ${targetIndex + 1}`
          : sourceLabel && !/^(window|screen):/i.test(sourceLabel)
            ? sourceLabel.slice(0, 34)
            : `Window ${targetIndex + 1}`;
      video?.addEventListener(
        "ended",
        () => {
          setScenes((current) =>
            current.map((scene) =>
              scene.id === sceneId ? { ...scene, stream: null } : scene,
            ),
          );
          setDisplay((current) => (current === selected ? null : current));
          setStatus("Display source stopped");
        },
        { once: true },
      );
      const previous = scenes[targetIndex]?.stream;
      setScenes((current) =>
        current.map((scene, index) =>
          index === targetIndex
            ? { id: sceneId, name, stream: selected }
            : scene,
        ),
      );
      const activated = await activateScene(targetIndex, selected, name);
      if (activated) previous?.getTracks().forEach((track) => track.stop());
      return activated ? selected : null;
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Display capture is unavailable",
      );
      return null;
    }
  };
  const addScene = async () => {
    if (processing || sceneSwitching) return;
    try {
      setStatus("Choose a screen or window for the new scene…");
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: settings.fps, max: settings.fps } },
        audio: false,
      });
      const index = scenes.length;
      const id = crypto.randomUUID();
      const video = stream.getVideoTracks()[0];
      const surface = video?.getSettings().displaySurface;
      const label = video?.label.trim();
      const name =
        surface === "monitor"
          ? `Display ${index + 1}`
          : label && !/^(window|screen):/i.test(label)
            ? label.slice(0, 34)
            : `Window ${index + 1}`;
      video?.addEventListener(
        "ended",
        () => {
          setScenes((current) =>
            current.map((scene) =>
              scene.id === id ? { ...scene, stream: null } : scene,
            ),
          );
          setDisplay((current) => (current === stream ? null : current));
        },
        { once: true },
      );
      setScenes((current) => [...current, { id, name, stream }]);
      await activateScene(index, stream, name);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not add scene");
    }
  };
  const selectScene = async (index: number) => {
    const scene = scenes[index];
    if (!scene || sceneSwitching || processing) return;
    if (!scene.stream) {
      await chooseDisplay(index);
      return;
    }
    await activateScene(index, scene.stream, scene.name);
  };
  const deleteScene = async () => {
    if (scenes.length === 1 || sceneSwitching || processing) return;
    const removed = scenes[selectedScene];
    const remaining = scenes.filter((_, index) => index !== selectedScene);
    const nextIndex = Math.min(selectedScene, remaining.length - 1);
    const next = remaining[nextIndex];
    if (recording && next.stream && recorder.current) {
      setSceneSwitching(true);
      try {
        await recorder.current.switchSource(settings, next.stream);
      } catch (error) {
        setStatus(
          error instanceof Error ? error.message : "Could not delete scene",
        );
        setSceneSwitching(false);
        return;
      }
      setSceneSwitching(false);
    }
    removed.stream?.getTracks().forEach((track) => track.stop());
    setScenes(remaining);
    setSelectedScene(nextIndex);
    setDisplay(next.stream);
    next.stream?.getVideoTracks().forEach((track) => (track.enabled = true));
    setStatus(recording ? `Recording · ${next.name}` : `${next.name} ready`);
  };
  const start = async () => {
    if (processing || sceneSwitching) return;
    try {
      let source = display;
      if (!source) {
        source = await chooseDisplay(selectedScene);
        if (!source) return;
      }
      const active = new NativeScreenRecording();
      recorder.current = active;
      const started = await active.start(settings, source);
      setElapsed(0);
      setBytes(0);
      recordingRef.current = true;
      setRecording(true);
      setStatus(`Recording · ${started.encoder || "H.264"}`);
      openTimerOverlay();
    } catch (error) {
      recordingRef.current = false;
      setStatus(
        error instanceof Error
          ? error.message
          : `Could not start recording: ${String(error)}`,
      );
      recorder.current = null;
    }
  };
  const stop = async () => {
    if (!recorder.current) return;
    recordingRef.current = false;
    processingRef.current = true;
    setRecording(false);
    closeTimerOverlay();
    setStatus("تجهيز الفيديو الكامل");
    setProcessing({
      active: true,
      progress: 1,
      estimatedRemainingMs: null,
    });
    const refreshProcessing = () => {
      void getNativeRecordingProcessingStatus()
        .then((value) => {
          if (value.active) setProcessing(value);
        })
        .catch(() => undefined);
    };
    refreshProcessing();
    const progressTimer = window.setInterval(refreshProcessing, 200);
    try {
      const result = await recorder.current.stop();
      processingRef.current = false;
      setStatus(result ? `MP4 saved · ${result.encoder}` : "Ready");
      setProcessing({
        active: false,
        progress: 100,
        estimatedRemainingMs: 0,
      });
      window.setTimeout(
        () =>
          setProcessing((current) =>
            current?.progress === 100 ? null : current,
          ),
        1400,
      );
    } catch (error) {
      processingRef.current = false;
      setProcessing(null);
      setStatus(
        error instanceof Error ? error.message : "Recording was preserved",
      );
    }
    window.clearInterval(progressTimer);
    recorder.current = null;
  };

  return (
    <main
      className="studio-shell"
      onContextMenu={(event) => event.preventDefault()}
    >
      <header
        className="studio-header"
        onPointerDown={(event) => {
          if (event.button === 0) void getCurrentWindow().startDragging();
        }}
      >
        <strong>MHTalk Studio</strong>
        <span>
          {recording ? (
            <b className="studio-rec">● REC {time(elapsed)}</b>
          ) : (
            status
          )}
        </span>
      </header>
      <section className="studio-preview">
        <div
          className={`preview-grid ${display ? "has-source" : ""}`}
          onDoubleClick={() => void chooseDisplay()}
        >
          {display ? (
            <video className="display-preview" ref={preview} autoPlay muted playsInline />
          ) : (
            <button
              className="preview-add"
              onClick={() => void chooseDisplay()}
            >
              <i>+</i>
              <span>Choose display or window</span>
            </button>
          )}
        </div>
      </section>
      <section className="studio-docks">
        <div className="studio-dock">
          <h3>Scenes</h3>
          {scenes.map((scene, index) => (
            <button
              key={scene.id}
              className={`studio-row ${selectedScene === index ? "active" : ""}`}
              disabled={sceneSwitching || processing !== null}
              onClick={() => void selectScene(index)}
              title={
                scene.stream ? scene.name : "Choose a source for this scene"
              }
            >
              <span>{scene.name}</span>
              <i>
                {sceneSwitching && selectedScene === index
                  ? "…"
                  : scene.stream
                    ? "●"
                    : "○"}
              </i>
            </button>
          ))}
          <footer>
            <button
              title="Add scene"
              disabled={sceneSwitching || processing !== null}
              onClick={() => void addScene()}
            >
              ＋
            </button>
            <button
              title="Delete scene"
              disabled={
                scenes.length === 1 || sceneSwitching || processing !== null
              }
              onClick={() => void deleteScene()}
            >
              −
            </button>
          </footer>
        </div>
        <div className="studio-dock mixer">
          <h3>Audio Mixer</h3>
          <label>
            <span>
              Desktop audio <b>{Math.round(settings.systemVolume * 100)}%</b>
            </span>
            <input
              type="range"
              min="0"
              max="200"
              value={settings.systemVolume * 100}
              disabled={!settings.includeAudio}
              onChange={(event) =>
                changeSettings({
                  ...settings,
                  systemVolume: Number(event.target.value) / 100,
                })
              }
            />
            <button
              onClick={() =>
                changeSettings({
                  ...settings,
                  includeAudio: !settings.includeAudio,
                })
              }
            >
              {settings.includeAudio ? "🔊" : "🔇"}
            </button>
            <div className="mixer-meter" aria-label={`Desktop audio level ${mixLevels.system}%`}>
              <i style={{ width: `${mixLevels.system}%` }} />
            </div>
          </label>
          <label>
            <span>
              Microphone <b>{Math.round(settings.micVolume * 100)}%</b>
            </span>
            <input
              type="range"
              min="0"
              max="200"
              value={settings.micVolume * 100}
              disabled={!settings.includeMic}
              onChange={(event) =>
                changeSettings({
                  ...settings,
                  micVolume: Number(event.target.value) / 100,
                })
              }
            />
            <button
              onClick={() =>
                changeSettings({
                  ...settings,
                  includeMic: !settings.includeMic,
                })
              }
            >
              {settings.includeMic ? "🎙" : "🔇"}
            </button>
            <div className="mixer-meter" aria-label={`Microphone level ${mixLevels.microphone}%`}>
              <i style={{ width: `${mixLevels.microphone}%` }} />
            </div>
          </label>
        </div>
        <div className="studio-dock controls-dock">
          <h3>Controls</h3>
          <button
            className="studio-control"
            onClick={() => setShowSettings(!showSettings)}
            disabled={processing !== null}
          >
            Settings
          </button>
          <button
            className={
              processing
                ? "studio-control processing"
                : recording
                  ? "studio-control stop"
                  : "studio-control record"
            }
            onClick={() => void (recording ? stop() : start())}
            disabled={
              processing !== null ||
              (!recording && capabilities?.ready === false)
            }
          >
            {processing
              ? "Preparing MP4"
              : recording
                ? "Stop Recording"
                : "Start Recording"}
          </button>
          <small>
            {recording
              ? `${time(elapsed)} · ${Math.round(bytes / 1024 / 1024)} MB`
              : processing
                ? "Creating final video"
                : `MP4 · H.264 · ${capabilities?.encoder || "detecting encoder"}`}
          </small>
          {processing && (
            <div className="studio-processing" aria-live="polite">
              <div>
                <span>Final video</span>
                <b>{Math.round(processing.progress)}%</b>
              </div>
              <div className="studio-processing-track">
                <i style={{ width: `${processing.progress}%` }} />
              </div>
              <small>
                Estimated remaining:{" "}
                {remainingTime(processing.estimatedRemainingMs)}
              </small>
            </div>
          )}
          <button className="studio-control exit" onClick={exitStudio}>
            Exit
          </button>
        </div>
      </section>
      {showSettings && (
        <div
          className="studio-settings-backdrop"
          onPointerDown={(event) => {
            if (event.currentTarget === event.target) setShowSettings(false);
          }}
        >
          <aside className="studio-settings">
            <button
              className="studio-settings-close"
              aria-label="Close recording settings"
              title="Close"
              onClick={() => setShowSettings(false)}
            >
              ×
            </button>
            <h2>Output settings</h2>
            <p className="studio-tier-note">
              {plusRecording ? "MHTalk Plus · source resolution and up to 120 FPS" : "Free · up to 720p and 60 FPS"}
            </p>
            <label>
              Quality
              <select
                value={settings.quality}
                disabled={recording || processing !== null}
                onChange={(event) =>
                  changeSettings({
                    ...settings,
                    quality: event.target.value as RecordingSettings["quality"],
                  })
                }
              >
                <option value="high">High quality</option>
                <option value="balanced">Balanced</option>
                <option value="performance">Performance</option>
                <option value="lossless" disabled={!plusRecording}>Near lossless{plusRecording ? "" : " · Plus"}</option>
              </select>
            </label>
            <label>
              Frame rate
              <select
                value={settings.fps}
                disabled={recording || processing !== null}
                onChange={(event) =>
                  changeSettings({
                    ...settings,
                    fps: Number(event.target.value) as 30 | 60 | 120,
                  })
                }
              >
                <option value={60}>60 FPS</option>
                <option value={30}>30 FPS</option>
                <option value={120} disabled={!plusRecording}>120 FPS{plusRecording ? "" : " · Plus"}</option>
              </select>
            </label>
            <button
              className="studio-source-button"
              disabled={recording || processing !== null}
              onClick={() => void chooseDisplay()}
            >
              Choose display source
            </button>
            <button
              className="studio-source-button"
              onClick={() => void openRecordingsFolder()}
            >
              Open recordings folder
            </button>
            <label className="studio-check">
              <input
                type="checkbox"
                checked={showTimer}
                onChange={(event) => {
                  setShowTimer(event.target.checked);
                  if (recording && event.target.checked) openTimerOverlay(true);
                  if (!event.target.checked) closeTimerOverlay();
                }}
              />
              Show transparent recording timer
            </label>
            <label className="studio-check">
              <input
                type="checkbox"
                checked={settings.noiseCancellation}
                onChange={(event) =>
                  changeSettings({
                    ...settings,
                    noiseCancellation: event.target.checked,
                  })
                }
              />
              Microphone noise cancellation (recording only)
            </label>
            <p>
              Final format: MP4 / H.264. Hardware encoding is preferred when
              available.
            </p>
          </aside>
        </div>
      )}
    </main>
  );
}
