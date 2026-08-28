import {
  freeSubscriptionPlan,
  resolveSubscriptionPlan,
  type SubscriptionPlan,
} from "./subscription";

export type RtcProviderId = "livekit" | "agora" | "daily";
export type MessagingProviderId =
  | "livekit-data"
  | "supabase-realtime"
  | "cloudflare-realtime"
  | "firebase";
export type FileProviderId =
  | "livekit-stream"
  | "cloudflare-r2"
  | "supabase-storage"
  | "backblaze-b2";

export type RoomServiceRouting = {
  rtc: { provider: RtcProviderId; serverUrl: string };
  messaging: { provider: MessagingProviderId };
  files: { provider: FileProviderId };
  subscription: SubscriptionPlan;
};

export const legacyRoomServiceRouting = (
  serverUrl: string,
): RoomServiceRouting => ({
  rtc: { provider: "livekit", serverUrl },
  messaging: { provider: "livekit-data" },
  files: { provider: "livekit-stream" },
  subscription: freeSubscriptionPlan,
});

export function parseRoomServiceRouting(
  value: unknown,
  fallbackServerUrl: string,
): RoomServiceRouting {
  const fallback = legacyRoomServiceRouting(fallbackServerUrl);
  if (!value || typeof value !== "object") return fallback;
  const payload = value as {
    provider?: unknown;
    serverUrl?: unknown;
    routing?: {
      rtc?: { provider?: unknown; serverUrl?: unknown };
      messaging?: { provider?: unknown };
      files?: { provider?: unknown };
    };
    subscription?: unknown;
  };
  const provider = payload.routing?.rtc?.provider ?? payload.provider;
  const serverUrl = payload.routing?.rtc?.serverUrl ?? payload.serverUrl;
  return {
    rtc: {
      provider:
        provider === "agora" || provider === "daily" ? provider : "livekit",
      serverUrl: typeof serverUrl === "string" && serverUrl
        ? serverUrl
        : fallbackServerUrl,
    },
    messaging: {
      provider: isMessagingProvider(payload.routing?.messaging?.provider)
        ? payload.routing!.messaging!.provider
        : fallback.messaging.provider,
    },
    files: {
      provider: isFileProvider(payload.routing?.files?.provider)
        ? payload.routing!.files!.provider
        : fallback.files.provider,
    },
    subscription: resolveSubscriptionPlan(payload.subscription),
  };
}

function isMessagingProvider(value: unknown): value is MessagingProviderId {
  return [
    "livekit-data",
    "supabase-realtime",
    "cloudflare-realtime",
    "firebase",
  ].includes(String(value));
}

function isFileProvider(value: unknown): value is FileProviderId {
  return [
    "livekit-stream",
    "cloudflare-r2",
    "supabase-storage",
    "backblaze-b2",
  ].includes(String(value));
}
