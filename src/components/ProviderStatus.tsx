import { useEffect, useState } from "react";
import type { SessionSnapshot } from "../core/types";
import { describeProviderStatus, providerNames, type ProviderStatusPayload } from "../core/providerStatus";
import { liveKitTokenEndpoint } from "../config/serviceConfig";

export function ProviderStatus({ session }: { session: Pick<SessionSnapshot, "state" | "rtcProvider"> }) {
  const [health, setHealth] = useState<{ payload: ProviderStatusPayload; fetchedAt: number } | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!session.rtcProvider || session.state === "idle") return;
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      setNow(Date.now());
      if (pending) return;
      pending = true;
      const request = new AbortController();
      const abort = () => request.abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      const timeout = window.setTimeout(abort, 8_000);
      try {
        const response = await fetch(new URL("/service/capabilities", liveKitTokenEndpoint), {
          signal: request.signal, cache: "no-store", headers: { accept: "application/json" },
        });
        if (!response.ok) throw new Error("Unavailable");
        const payload = await response.json() as ProviderStatusPayload;
        if (!Array.isArray(payload.rtc) || !payload.thresholds) throw new Error("Invalid status");
        if (!controller.signal.aborted) setHealth({ payload, fetchedAt: Date.now() });
      } catch { /* Retain the last measurement briefly, then show unknown. */ }
      finally {
        pending = false;
        window.clearTimeout(timeout);
        controller.signal.removeEventListener("abort", abort);
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [session.rtcProvider, session.state]);
  const status = describeProviderStatus(session.rtcProvider, session.state, health?.payload || null, Boolean(health && now - health.fetchedAt < 90_000));
  const provider = session.rtcProvider ? providerNames[session.rtcProvider] : "السيرفر";
  return <section className={`provider-status provider-status--${status.tone}`} aria-label="حالة السيرفر" dir="rtl">
    <div className="provider-status-heading"><span className="provider-status-dot" aria-hidden="true" /><strong dir="auto">{provider}</strong><span>السيرفر المستخدم</span></div>
    <div className="provider-status-label" role="status">{status.label}</div>
    {status.remaining !== null && <div className="provider-status-quota" title="النسبة المتبقية من الحصة المسموح للتطبيق استخدامها قبل حد الإيقاف الاحترازي، وليست جودة الشبكة.">
      <div className="provider-status-track" aria-hidden="true"><span style={{ width: `${status.remaining}%` }} /></div>
      <small>المتبقي حتى حد التبديل: {status.remaining}%</small>
    </div>}
  </section>;
}
