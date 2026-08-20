import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RecorderStudio } from "./RecorderStudio";
import { RecordingOverlay } from "./RecordingOverlay";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {window.location.hash === "#recorder-studio" ? (
      <RecorderStudio />
    ) : window.location.hash === "#recording-overlay" ? (
      <RecordingOverlay />
    ) : (
      <App />
    )}
  </StrictMode>,
);
