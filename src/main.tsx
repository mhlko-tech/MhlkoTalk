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
        <section className="startup-update-card">
          <header><img src="/mhtalk-icon.png" alt="MHTalk" /><div><h1>MHTalk</h1><small>Secure desktop</small></div></header>
          <div className="startup-update-copy"><strong>Starting MHTalk</strong><span>Loading the secure application…</span></div>
          <div className="startup-progress indeterminate"><i /></div>
        </section>
      </div>
    }>
      <RootView />
    </Suspense>
  </StrictMode>,
);
