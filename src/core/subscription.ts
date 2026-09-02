import type { MediaQuality } from "./types";

export type SubscriptionTier =
  | "free"
  | "plus"
  | "pro"
  | "ultimate"
  | "max_supporter";

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

const freeEntitlements: SubscriptionEntitlements = {
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
};

const premiumEntitlements: SubscriptionEntitlements = {
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
};

export const subscriptionEntitlements: Record<SubscriptionTier, SubscriptionEntitlements> = {
  free: freeEntitlements,
  plus: premiumEntitlements,
  pro: premiumEntitlements,
  // Supporter tiers are recognition badges only inside MHTalk. They do not
  // grant any MHTalk product entitlement.
  ultimate: freeEntitlements,
  max_supporter: freeEntitlements,
};

export const subscriptionLabels: Record<SubscriptionTier, string> = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
  ultimate: "Ultimate",
  max_supporter: "Max Supporter",
};

export const hasMembershipBadge = (tier: SubscriptionTier) => tier !== "free";
export const isPaidSubscription = (tier: SubscriptionTier) => tier === "plus" || tier === "pro";
export const isPaidSubscriptionValue = (tier: unknown): tier is "plus" | "pro" =>
  tier === "plus" || tier === "pro";

const isKnownSubscriptionTierValue = (tier: unknown): tier is SubscriptionTier =>
  tier === "free" || tier === "plus" || tier === "pro" || tier === "ultimate" || tier === "max_supporter";

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
  const knownTier = isKnownSubscriptionTierValue(candidate.tier)
    ? candidate.tier as SubscriptionTier
    : "free";
  const membershipIsCurrent = knownTier !== "free" &&
    (!expiresAt || new Date(expiresAt).getTime() > Date.now());
  const tier: SubscriptionTier = membershipIsCurrent ? knownTier : "free";
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
