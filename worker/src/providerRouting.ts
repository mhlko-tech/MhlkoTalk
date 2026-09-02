import {
  isRtcProvider,
  knownRtcProviders,
  targetRtcProviders,
  type RtcProviderId,
} from "./rtcProviderCatalog";
import { routingThresholds } from "./providerSafety";

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
  HMS_TEMPLATE_ID?: string;
  HMS_TEMPLATE_SUBDOMAIN?: string;
  HMS_ROLE?: string;
  COMETCHAT_APP_ID?: string;
  COMETCHAT_REGION?: string;
  COMETCHAT_REST_API_KEY?: string;
  COMETCHAT_AUTH_KEY?: string;
  WHEREBY_API_KEY?: string;
  JAAS_APP_ID?: string;
  JAAS_KEY_ID?: string;
  JAAS_PRIVATE_KEY?: string;
  MIROTALK_BASE_URL?: string;
  MIROTALK_API_KEY_SECRET?: string;
  MIROTALK_HOST_USERNAME?: string;
  MIROTALK_HOST_PASSWORD?: string;
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
const stickySeconds = 2 * 60 * 60;
const cloudflareHealthMaxAgeMs = 20 * 60 * 1000;
const providerHealthMaxAgeMs = 25 * 60 * 1000;
const sharedHealthKey = "routing:health:rtc:shared";

type SharedProviderHealth = Partial<Record<RtcProviderId, ProviderHealth>>;

function healthIsStale(provider: RtcProviderId, health: ProviderHealth) {
  const updatedAt = Date.parse(health.updatedAt);
  const maxAge = provider === "cloudflare-realtime"
    ? cloudflareHealthMaxAgeMs
    : providerHealthMaxAgeMs;
  return !Number.isFinite(updatedAt) || Date.now() - updatedAt > maxAge;
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
    case "100ms": return Boolean(env.HMS_ACCESS_KEY && env.HMS_APP_SECRET && env.HMS_TEMPLATE_ID && env.HMS_TEMPLATE_SUBDOMAIN);
    case "cometchat": return Boolean(env.COMETCHAT_APP_ID && env.COMETCHAT_REGION && (env.COMETCHAT_REST_API_KEY || env.COMETCHAT_AUTH_KEY));
    case "whereby": return Boolean(env.WHEREBY_API_KEY);
    case "jaas": return Boolean(env.JAAS_APP_ID && env.JAAS_KEY_ID && env.JAAS_PRIVATE_KEY);
    case "mirotalk": return Boolean(env.MIROTALK_BASE_URL && env.MIROTALK_API_KEY_SECRET && env.MIROTALK_HOST_USERNAME && env.MIROTALK_HOST_PASSWORD);
    case "videosdk": return Boolean(env.VIDEOSDK_API_KEY && env.VIDEOSDK_API_SECRET);
    case "daily": return Boolean(env.DAILY_API_KEY);
    case "livekit": return Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
  }
}

// The broker must never route traffic to a vendor until both token issuance and
// the matching Windows/Android transport adapter have shipped.
function adapterReady(provider: RtcProviderId) {
  return knownRtcProviders.includes(provider);
}

async function providerHealth(env: RoutingEnvironment, provider: RtcProviderId): Promise<ProviderHealth> {
  const dedicated = provider === "cloudflare-realtime" || provider === "jaas";
  const shared = dedicated
    ? null
    : await env.PRIVATE_ROOMS.get(sharedHealthKey, "json") as SharedProviderHealth | null;
  const stored = shared?.[provider] ||
    await env.PRIVATE_ROOMS.get(`routing:health:rtc:${provider}`, "json") as Partial<ProviderHealth> | null;
  return {
    usedPercent: Math.min(100, Math.max(0, Number(stored?.usedPercent) || 0)),
    disabled: stored?.disabled === true,
    updatedAt: typeof stored?.updatedAt === "string" ? stored.updatedAt : new Date(0).toISOString(),
  };
}

export async function rtcCapabilities(env: RoutingEnvironment): Promise<ProviderCapability[]> {
  // Read the shared snapshot once per request. The previous implementation
  // fetched the same KV key once for every provider, which multiplied account
  // KV usage whenever a client requested capabilities or joined a room.
  const [shared, cloudflare, jaas] = await Promise.all([
    env.PRIVATE_ROOMS.get(sharedHealthKey, "json") as Promise<SharedProviderHealth | null>,
    env.PRIVATE_ROOMS.get("routing:health:rtc:cloudflare-realtime", "json") as Promise<Partial<ProviderHealth> | null>,
    env.PRIVATE_ROOMS.get("routing:health:rtc:jaas", "json") as Promise<Partial<ProviderHealth> | null>,
  ]);
  const healthFor = (provider: RtcProviderId): ProviderHealth => {
    const stored = provider === "cloudflare-realtime"
      ? cloudflare
      : provider === "jaas"
        ? jaas
        : shared?.[provider];
    return {
      usedPercent: Math.min(100, Math.max(0, Number(stored?.usedPercent) || 0)),
      disabled: stored?.disabled === true,
      updatedAt: typeof stored?.updatedAt === "string" ? stored.updatedAt : new Date(0).toISOString(),
    };
  };
  return providerOrder(env.RTC_PROVIDER_ORDER).map((provider) => {
    const configured = providerConfigured(provider, env);
    const hasAdapter = adapterReady(provider);
    const health = healthFor(provider);
    const policy = routingThresholds(provider);
    const stale = !health.disabled && healthIsStale(provider, health);
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
          ? "Provider health or usage telemetry is missing or stale; routing fails closed"
        : health.disabled
          ? "Provider is administratively disabled"
          : health.usedPercent >= policy.disableAt
            ? "Usage reached the automatic disable threshold"
            : health.usedPercent >= policy.warnAt
              ? "Usage crossed the guarded allocation threshold"
            : undefined;
    return { provider, ready, configured, adapterReady: hasAdapter, state, usedPercent: health.usedPercent, reason };
  });
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
  // Versioned so the LiveKit-parity rollout cannot leave updated Android and
  // Windows clients split across a previous Stream-sticky room.
  const stickyKey = `routing:v2:room:rtc:${roomName}`;
  const sticky = await env.PRIVATE_ROOMS.get(stickyKey);
  const current = candidates.find((item) => item.provider === sticky);
  if (current) return current;

  const acceptingNewRooms = candidates.filter((item) => item.usedPercent === null || item.usedPercent < routingThresholds(item.provider).stopNewRoomsAt);
  const selected = acceptingNewRooms.find((item) => item.state === "healthy") || acceptingNewRooms[0] || null;
  // Sticky routing is an optimization, not a prerequisite for joining. If the
  // account's daily KV write allowance is temporarily exhausted, keep the
  // selected healthy provider and allow the room to open.
  if (selected) {
    try {
      await env.PRIVATE_ROOMS.put(stickyKey, selected.provider, { expirationTtl: stickySeconds });
    } catch {
      // The next request will select from the same ordered healthy candidates.
    }
  }
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
  if (provider === "cloudflare-realtime" || provider === "jaas") {
    await env.PRIVATE_ROOMS.put(`routing:health:rtc:${provider}`, JSON.stringify(next));
  } else {
    const shared = await env.PRIVATE_ROOMS.get(sharedHealthKey, "json") as SharedProviderHealth | null;
    await env.PRIVATE_ROOMS.put(sharedHealthKey, JSON.stringify({ ...(shared || {}), [provider]: next }));
  }
  return next;
}

export async function updateProviderHealthBatch(
  env: RoutingEnvironment,
  updates: Partial<Record<RtcProviderId, { usedPercent?: number; disabled?: boolean }>>,
) {
  const shared = await env.PRIVATE_ROOMS.get(sharedHealthKey, "json") as SharedProviderHealth | null || {};
  const updatedAt = new Date().toISOString();
  for (const [providerValue, update] of Object.entries(updates)) {
    if (!isRtcProvider(providerValue) || providerValue === "cloudflare-realtime" || providerValue === "jaas" || !update) continue;
    const provider = providerValue as RtcProviderId;
    const legacy = shared[provider] ||
      await env.PRIVATE_ROOMS.get(`routing:health:rtc:${provider}`, "json") as Partial<ProviderHealth> | null;
    shared[provider] = {
      usedPercent: update.usedPercent === undefined
        ? Math.min(100, Math.max(0, Number(legacy?.usedPercent) || 0))
        : Math.min(100, Math.max(0, update.usedPercent)),
      disabled: update.disabled ?? legacy?.disabled === true,
      updatedAt,
    };
  }
  await env.PRIVATE_ROOMS.put(sharedHealthKey, JSON.stringify(shared));
  return shared;
}

export { isRtcProvider, knownRtcProviders };
