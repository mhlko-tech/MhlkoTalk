import type { UpdateActivity } from "../../services/appUpdater";

export function StartupUpdateGate({
  activity,
  appVersion,
  onRetry,
}: {
  activity: UpdateActivity | null;
  appVersion: string;
  onRetry: () => void;
}) {
  const phase = activity?.phase || "checking";
  const label = phase === "downloading"
    ? "Downloading update"
    : phase === "installing"
      ? "Installing update"
      : phase === "error"
        ? "Update check failed"
        : "Checking for updates";
  const description = phase === "checking"
    ? "Making sure you have the newest secure version."
    : phase === "downloading"
      ? "Downloading the verified update from MHTalk."
      : phase === "installing"
        ? "Update verified. MHTalk will restart automatically."
        : "MHTalk could not reach the update service.";
  const progress = activity?.progress;
  const phaseIndex = phase === "installing" ? 2 : phase === "downloading" ? 1 : 0;

  return (
    <main className="startup-update-gate" aria-live="polite">
      <section className="startup-update-card">
        <header>
          <img src="/mhtalk-icon.png" alt="MHTalk" />
          <div><h1>MHTalk <span className="beta-badge">Beta</span></h1><small>Secure desktop · v{appVersion}</small></div>
        </header>
        <div className="startup-update-copy"><strong>{label}</strong><span>{description}</span></div>
        <div className="startup-stages" aria-hidden="true">
          {["Check", "Download", "Open"].map((step, index) => (
            <div className={index < phaseIndex ? "done" : index === phaseIndex && phase !== "error" ? "active" : ""} key={step}>
              <i>{index < phaseIndex ? "✓" : index + 1}</i><span>{step}</span>
            </div>
          ))}
        </div>
        <div
          className={`startup-progress ${progress === null || progress === undefined ? "indeterminate" : ""}`}
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress ?? undefined}
        >
          <i style={progress === null || progress === undefined ? undefined : { width: `${progress}%` }} />
        </div>
        <div className="startup-update-meta">
          <small>{phase === "downloading" && progress !== null ? `${progress}%` : phase === "installing" ? "Restarting MHTalk…" : phase === "error" ? "Connection required" : "Usually takes a few seconds"}</small>
          <small>Signed update</small>
        </div>
        {activity?.phase === "error" && (
          <div className="startup-update-error"><p>{activity.message}</p><button onClick={onRetry}>Try again</button></div>
        )}
      </section>
    </main>
  );
}
