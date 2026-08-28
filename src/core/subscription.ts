import type { MediaQuality } from "./types";

export type SubscriptionTier = "free" | "plus";

export type SubscriptionEntitlements = {
  maxCameraQuality: MediaQuality;
  maxScreenShareQuality: MediaQuality;
  maxAttachmentBytes: number;
  attachmentRetentionHours: number;
  animatedProfile: boolean;
  profileBanner: boolean;
  customThemes: boolean;
  profileFrames: boolean;
  customAppIcons: boolean;
  customEmoji: boolean;
  soundboard: boolean;
  customInvites: boolean;
  savedRoomLimit: number;
};

export type SubscriptionPlan = {
  tier: SubscriptionTier;
  expiresAt?: string;
  entitlements: SubscriptionEntitlements;
};

const megabytes = (value: number) => value * 1024 * 1024;

export const subscriptionEntitlements: Record<
  SubscriptionTier,
  SubscriptionEntitlements
> = {
  free: {
    maxCameraQuality: "medium",
    maxScreenShareQuality: "medium",
    maxAttachmentBytes: megabytes(20),
    attachmentRetentionHours: 24,
    animatedProfile: false,
    profileBanner: false,
    customThemes: false,
    profileFrames: false,
    customAppIcons: false,
    customEmoji: false,
    soundboard: false,
    customInvites: false,
    savedRoomLimit: 3,
  },
  plus: {
    maxCameraQuality: "high",
    maxScreenShareQuality: "high",
    maxAttachmentBytes: megabytes(100),
    attachmentRetentionHours: 24 * 7,
    animatedProfile: true,
    profileBanner: true,
    customThemes: true,
    profileFrames: true,
    customAppIcons: true,
    customEmoji: true,
    soundboard: true,
    customInvites: true,
    savedRoomLimit: 20,
  },
};

export const freeSubscriptionPlan: SubscriptionPlan = {
  tier: "free",
  entitlements: subscriptionEntitlements.free,
};

export function resolveSubscriptionPlan(value: unknown): SubscriptionPlan {
  if (!value || typeof value !== "object") return freeSubscriptionPlan;
  const candidate = value as {
    tier?: unknown;
    expiresAt?: unknown;
    expires_at?: unknown;
  };
  const expiresAt =
    typeof candidate.expiresAt === "string"
      ? candidate.expiresAt
      : typeof candidate.expires_at === "string"
        ? candidate.expires_at
        : undefined;
  const plusIsCurrent =
    candidate.tier === "plus" &&
    (!expiresAt || new Date(expiresAt).getTime() > Date.now());
  const tier: SubscriptionTier = plusIsCurrent ? "plus" : "free";
  return { tier, expiresAt, entitlements: subscriptionEntitlements[tier] };
}

const mediaQualityRank: Record<MediaQuality, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function limitMediaQuality(
  requested: MediaQuality,
  maximum: MediaQuality,
): MediaQuality {
  return mediaQualityRank[requested] <= mediaQualityRank[maximum]
    ? requested
    : maximum;
}

export function formatAttachmentLimit(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

export function limitRecordingDimensions(
  width: number,
  height: number,
  plus: boolean,
): [number, number] {
  if (plus) return [evenDimension(width), evenDimension(height)];
  const landscape = width >= height;
  const maximumWidth = landscape ? 1280 : 720;
  const maximumHeight = landscape ? 720 : 1280;
  const scale = Math.min(1, maximumWidth / width, maximumHeight / height);
  return [evenDimension(width * scale), evenDimension(height * scale)];
}

function evenDimension(value: number) {
  const rounded = Math.max(2, Math.floor(value));
  return rounded - (rounded % 2);
}
