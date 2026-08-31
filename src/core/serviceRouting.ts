import {
  freeSubscriptionPlan,
  resolveSubscriptionPlan,
  type SubscriptionPlan,
} from "./subscription";
import { isRtcProvider, type RtcProviderId } from "./rtcProviders";

export type MessagingProviderId =
  | "daily-chat"
  | "livekit-data"
  | "stream-events"
  | "agora-data"
  | "tencent-data"
  | "whereby-chat"
  | "supabase-realtime"
  | "cloudflare-realtime"
  | "firebase";
export type FileProviderId =
  | "daily-prebuilt"
  | "whereby-prebuilt"
  | "livekit-stream"
  | "cloudflare-r2"
  | "supabase-storage"
  | "backblaze-b2";

export type ClientServiceCapabilities = {
  version: 2;
  rtcProviders: RtcProviderId[];
  messagingProviders: MessagingProviderId[];
  fileProviders: FileProviderId[];
};

export const knownMessagingProviders: readonly MessagingProviderId[] = [
  "daily-chat",
  "livekit-data",
  "stream-events",
  "agora-data",
  "tencent-data",
  "whereby-chat",
  "supabase-realtime",
  "cloudflare-realtime",
  "firebase",
];

export const knownFileProviders: readonly FileProviderId[] = [
  "daily-prebuilt",
  "whereby-prebuilt",
  "livekit-stream",
  "cloudflare-r2",
  "supabase-storage",
  "backblaze-b2",
];

export const routingForRtcProvider = (provider: RtcProviderId) => ({
  messaging: provider === "daily"
    ? "daily-chat"
    : provider === "whereby"
      ? "whereby-chat"
      : provider === "cloudflare-realtime"
        ? "cloudflare-realtime"
        : provider === "stream"
          ? "stream-events"
          : provider === "agora"
            ? "agora-data"
            : provider === "tencent"
              ? "tencent-data"
              : "livekit-data",
  files: provider === "daily"
    ? "daily-prebuilt"
    : provider === "whereby"
      ? "whereby-prebuilt"
      : provider === "stream" || provider === "agora" || provider === "tencent" || provider === "cloudflare-realtime"
        ? "supabase-storage"
        : "livekit-stream",
}) satisfies { messaging: MessagingProviderId; files: FileProviderId };

export function routingIsSupported(
  provider: RtcProviderId,
  messagingProviders: readonly MessagingProviderId[],
  fileProviders: readonly FileProviderId[],
) {
  const required = routingForRtcProvider(provider);
  return messagingProviders.includes(required.messaging) && fileProviders.includes(required.files);
}

export type RoomServiceRouting = {
  rtc: { provider: RtcProviderId; serverUrl: string; clientKey?: string };
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
      rtc?: { provider?: unknown; serverUrl?: unknown; clientKey?: unknown };
      messaging?: { provider?: unknown };
      files?: { provider?: unknown };
    };
    subscription?: unknown;
  };
  const provider = payload.routing?.rtc?.provider ?? payload.provider;
  const serverUrl = payload.routing?.rtc?.serverUrl ?? payload.serverUrl;
  const clientKey = payload.routing?.rtc?.clientKey;
  const rtcProvider = isRtcProvider(provider) ? provider : "livekit";
  const parsed: RoomServiceRouting = {
    rtc: {
      provider: rtcProvider,
      serverUrl: typeof serverUrl === "string" && serverUrl
        ? serverUrl
        : fallbackServerUrl,
      ...(typeof clientKey === "string" && clientKey ? { clientKey } : {}),
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
  const required = routingForRtcProvider(rtcProvider);
  if (
    parsed.messaging.provider !== required.messaging ||
    parsed.files.provider !== required.files
  ) {
    throw new Error("The server selected an incompatible room service route");
  }
  return parsed;
}

function isMessagingProvider(value: unknown): value is MessagingProviderId {
  return knownMessagingProviders.includes(String(value) as MessagingProviderId);
}

function isFileProvider(value: unknown): value is FileProviderId {
  return knownFileProviders.includes(String(value) as FileProviderId);
}
