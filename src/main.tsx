import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const MainApp = lazy(async () => ({ default: (await import("./App")).App }));
const RecorderStudio = lazy(async () => ({
  default: (await import("./RecorderStudio")).RecorderStudio,
}));
const RecordingOverlay = lazy(async () => ({
  default: (await import("./RecordingOverlay")).RecordingOverlay,
}));

const RootView =
  window.location.hash === "#recorder-studio"
    ? RecorderStudio
    : window.location.hash === "#recording-overlay"
      ? RecordingOverlay
      : MainApp;
const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("MHTalk root element was not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <Suspense fallback={
      <div className="startup-update-gate">
        <img src="/mhtalk-icon.png" alt="MHTalk" />
        <strong>MHTalk</strong>
        <span>Starting…</span>
      </div>
    }>
      <RootView />
    </Suspense>
  </StrictMode>,
);
