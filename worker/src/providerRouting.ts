import {
  isRtcProvider,
  knownRtcProviders,
  targetRtcProviders,
  type RtcProviderId,
} from "./rtcProviderCatalog";

export type { RtcProviderId } from "./rtcProviderCatalog";

export interface RoutingEnvironment {
  PRIVATE_ROOMS: KVNamespace;
  RTC_PROVIDER_ORDER?: string;
  LIVEKIT_URL: string;
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;
  STREAM_API_KEY?: string;
  STREAM_API_SECRET?: string;
  AGORA_APP_ID?: string;
  AGORA_APP_CERTIFICATE?: string;
  TENCENT_SDK_APP_ID?: string;
  TENCENT_SECRET_KEY?: string;
  CLOUDFLARE_REALTIME_APP_ID?: string;
  CLOUDFLARE_REALTIME_API_TOKEN?: string;
  HMS_ACCESS_KEY?: string;
  HMS_APP_SECRET?: string;
  COMETCHAT_APP_ID?: string;
  COMETCHAT_REGION?: string;
  COMETCHAT_AUTH_KEY?: string;
  WHEREBY_API_KEY?: string;
  JAAS_APP_ID?: string;
  JAAS_PRIVATE_KEY?: string;
  VONAGE_API_KEY?: string;
  VONAGE_API_SECRET?: string;
  VIDEOSDK_API_KEY?: string;
  VIDEOSDK_API_SECRET?: string;
  DAILY_API_KEY?: string;
  ROUTING_ADMIN_KEY?: string;
}

export type ProviderHealth = {
  usedPercent: number;
  disabled: boolean;
  updatedAt: string;
};

export type ProviderCapability = {
  provider: RtcProviderId;
  ready: boolean;
  configured: boolean;
  adapterReady: boolean;
  state: "healthy" | "draining" | "exhausted" | "disabled" | "unavailable";
  usedPercent: number | null;
  reason?: string;
};

const defaultOrder: RtcProviderId[] = [...targetRtcProviders];
const drainAt = 85;
const migrateAt = 95;
const stickySeconds = 2 * 60 * 60;
const cloudflareWarnAt = 45;
const cloudflareLowerPriorityAt = 50;
const cloudflareStopNewRoomsAt = 55;
const cloudflareDisableAt = 60;
const cloudflareHealthMaxAgeMs = 20 * 60 * 1000;

function thresholds(provider: RtcProviderId) {
  return provider === "cloudflare-realtime"
    ? {
        warnAt: cloudflareWarnAt,
        drainAt: cloudflareLowerPriorityAt,
        stopNewRoomsAt: cloudflareStopNewRoomsAt,
        disableAt: cloudflareDisableAt,
      }
    : { warnAt: drainAt, drainAt, stopNewRoomsAt: migrateAt, disableAt: migrateAt };
}

function healthIsStale(provider: RtcProviderId, health: ProviderHealth) {
  if (provider !== "cloudflare-realtime") return false;
  const updatedAt = Date.parse(health.updatedAt);
  return !Number.isFinite(updatedAt) || Date.now() - updatedAt > cloudflareHealthMaxAgeMs;
}

function providerOrder(value?: string): RtcProviderId[] {
  const requested = (value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(isRtcProvider);
  return [...new Set([...requested, ...defaultOrder])];
}

function providerConfigured(provider: RtcProviderId, env: RoutingEnvironment) {
  switch (provider) {
    case "stream": return Boolean(env.STREAM_API_KEY && env.STREAM_API_SECRET);
    case "agora": return Boolean(env.AGORA_APP_ID && env.AGORA_APP_CERTIFICATE);
    case "tencent": return Boolean(env.TENCENT_SDK_APP_ID && env.TENCENT_SECRET_KEY);
    case "cloudflare-realtime": return Boolean(env.CLOUDFLARE_REALTIME_APP_ID && env.CLOUDFLARE_REALTIME_API_TOKEN);
    case "100ms": return Boolean(env.HMS_ACCESS_KEY && env.HMS_APP_SECRET);
    case "cometchat": return Boolean(env.COMETCHAT_APP_ID && env.COMETCHAT_REGION && env.COMETCHAT_AUTH_KEY);
    case "whereby": return Boolean(env.WHEREBY_API_KEY);
    case "jaas": return Boolean(env.JAAS_APP_ID && env.JAAS_PRIVATE_KEY);
    case "vonage": return Boolean(env.VONAGE_API_KEY && env.VONAGE_API_SECRET);
    case "videosdk": return Boolean(env.VIDEOSDK_API_KEY && env.VIDEOSDK_API_SECRET);
    case "daily": return Boolean(env.DAILY_API_KEY);
    case "livekit": return Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
  }
}

// The broker must never route traffic to a vendor until both token issuance and
// the matching Windows/Android transport adapter have shipped. LiveKit is the
// first complete adapter; the remaining providers become selectable one by one.
function adapterReady(provider: RtcProviderId) {
  return provider === "stream" ||
    provider === "agora" ||
    provider === "tencent" ||
    provider === "cloudflare-realtime" ||
    provider === "whereby" ||
    provider === "daily" ||
    provider === "livekit";
}

async function providerHealth(env: RoutingEnvironment, provider: RtcProviderId): Promise<ProviderHealth> {
  const stored = await env.PRIVATE_ROOMS.get(`routing:health:rtc:${provider}`, "json") as Partial<ProviderHealth> | null;
  return {
    usedPercent: Math.min(100, Math.max(0, Number(stored?.usedPercent) || 0)),
    disabled: stored?.disabled === true,
    updatedAt: typeof stored?.updatedAt === "string" ? stored.updatedAt : new Date(0).toISOString(),
  };
}

export async function rtcCapabilities(env: RoutingEnvironment): Promise<ProviderCapability[]> {
  return Promise.all(providerOrder(env.RTC_PROVIDER_ORDER).map(async (provider) => {
    const configured = providerConfigured(provider, env);
    const hasAdapter = adapterReady(provider);
    const health = await providerHealth(env, provider);
    const policy = thresholds(provider);
    const stale = healthIsStale(provider, health);
    const ready = configured && hasAdapter && !stale && !health.disabled && health.usedPercent < policy.disableAt;
    const state: ProviderCapability["state"] = !configured || !hasAdapter
      ? "unavailable"
      : stale
        ? "unavailable"
      : health.disabled
        ? "disabled"
        : health.usedPercent >= policy.disableAt
          ? "exhausted"
          : health.usedPercent >= policy.drainAt
            ? "draining"
            : "healthy";
    const reason = !configured
      ? "Provider credentials are not configured"
      : !hasAdapter
        ? "Client and token adapters are not deployed"
        : stale
          ? "Usage telemetry is missing or stale; Cloudflare routing fails closed"
        : health.disabled
          ? "Provider is administratively disabled"
          : health.usedPercent >= policy.disableAt
            ? "Usage reached the automatic disable threshold"
            : health.usedPercent >= policy.warnAt
              ? "Usage crossed the guarded allocation threshold"
            : undefined;
    return { provider, ready, configured, adapterReady: hasAdapter, state, usedPercent: health.usedPercent, reason };
  }));
}

export async function selectRtcProvider(
  env: RoutingEnvironment,
  roomName: string,
  supportedProviders: RtcProviderId[],
  excludedProviders: RtcProviderId[] = [],
): Promise<ProviderCapability | null> {
  const supported = new Set(supportedProviders.length ? supportedProviders : ["livekit"]);
  const excluded = new Set(excludedProviders);
  const capabilities = await rtcCapabilities(env);
  const candidates = capabilities.filter((item) => item.ready && supported.has(item.provider) && !excluded.has(item.provider));
  const stickyKey = `routing:room:rtc:${roomName}`;
  const sticky = await env.PRIVATE_ROOMS.get(stickyKey);
  const current = candidates.find((item) => item.provider === sticky);
  if (current) return current;

  const acceptingNewRooms = candidates.filter((item) => item.usedPercent === null || item.usedPercent < thresholds(item.provider).stopNewRoomsAt);
  const selected = acceptingNewRooms.find((item) => item.state === "healthy") || acceptingNewRooms[0] || null;
  if (selected) await env.PRIVATE_ROOMS.put(stickyKey, selected.provider, { expirationTtl: stickySeconds });
  return selected;
}

export function parseRtcProviders(value: unknown): RtcProviderId[] {
  if (!Array.isArray(value)) return ["livekit"];
  const parsed = value
    .map((item) => String(item).trim().toLowerCase())
    .filter(isRtcProvider);
  return [...new Set<RtcProviderId>(parsed.length ? parsed : ["livekit"])];
}

export async function updateProviderHealth(
  env: RoutingEnvironment,
  provider: RtcProviderId,
  update: { usedPercent?: number; disabled?: boolean },
) {
  const current = await providerHealth(env, provider);
  const next: ProviderHealth = {
    usedPercent: update.usedPercent === undefined
      ? current.usedPercent
      : Math.min(100, Math.max(0, update.usedPercent)),
    disabled: update.disabled ?? current.disabled,
    updatedAt: new Date().toISOString(),
  };
  await env.PRIVATE_ROOMS.put(`routing:health:rtc:${provider}`, JSON.stringify(next));
  return next;
}

export { isRtcProvider, knownRtcProviders };
