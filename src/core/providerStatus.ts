import type { SessionState } from "./types";
import type { RtcProviderId } from "./rtcProviders";

export type ProviderCapabilityStatus = {
  provider: RtcProviderId;
  ready: boolean;
  state: string;
  usedPercent: number | null;
};
export type ProviderQuotaThresholds = { warningPercent: number; stopNewRoomsPercent: number; disablePercent: number };
export type ProviderStatusPayload = {
  rtc: ProviderCapabilityStatus[];
  thresholds: Record<string, ProviderQuotaThresholds>;
  livekitPool?: Array<{ serverId: number; ready: boolean; usedPercent: number }>;
};

export function serverDisplayName(serverId?: number | null) {
  return serverId && Number.isSafeInteger(serverId) && serverId > 0 && serverId <= 10000 ? `Server ${serverId}` : "Server";
}

export function publicConnectionMessage(message: string) {
  return /\b(?:agora|livekit|tencent|cloudflare|stream|whereby|jaas|mirotalk|daily)\b|(?:https?|wss?):\/\//i.test(message)
    ? "Could not connect to the server. Please try joining again."
    : message;
}

export function describeProviderStatus(
  provider: RtcProviderId | null,
  connection: SessionState,
  payload: ProviderStatusPayload | null,
  fresh: boolean,
  serverId?: number | null,
) {
  if (!provider || connection === "idle") return { tone: "unknown", label: "Not connected", remaining: null } as const;
  if (connection === "failed") return { tone: "critical", label: "Connection unavailable", remaining: null } as const;
  if (connection === "connecting" || connection === "recovering") return { tone: "warning", label: "Connecting or switching server", remaining: null } as const;
  const account = provider === "livekit" && serverId ? payload?.livekitPool?.find((item) => item.serverId === serverId) : undefined;
  const capability = account ? { ...account, state: account.ready ? "healthy" : "exhausted" } : payload?.rtc.find((item) => item.provider === provider);
  const limits = payload?.thresholds[provider] || payload?.thresholds.default;
  if (!fresh || !capability || !limits || !Number.isFinite(capability.usedPercent)) {
    return { tone: "unknown", label: "Quota data unavailable", remaining: null } as const;
  }
  if (!capability.ready) {
    return { tone: capability.state === "unavailable" ? "unknown" : "critical", label: "Server unavailable for new connections", remaining: null } as const;
  }
  if (provider === "mirotalk") return { tone: "good", label: "Connected · Self-hosted", remaining: null } as const;
  const used = Math.max(0, capability.usedPercent!);
  const remaining = Math.max(0, Math.min(100, Math.floor((limits.disablePercent - used) / limits.disablePercent * 100)));
  if (used >= limits.stopNewRoomsPercent) return { tone: "critical", label: "Low quota · Switching soon", remaining } as const;
  if (used >= limits.warningPercent) return { tone: "warning", label: "Quota nearing switch limit", remaining } as const;
  return { tone: "good", label: "Connected · Quota available", remaining } as const;
}
