import type { RtcProviderId } from "./rtcProviderCatalog";

export type RoutingThresholds = {
  warnAt: number;
  drainAt: number;
  stopNewRoomsAt: number;
  disableAt: number;
};

export const defaultProviderThresholds: RoutingThresholds = {
  warnAt: 60,
  drainAt: 65,
  stopNewRoomsAt: 70,
  disableAt: 75,
};

export const cloudflareProviderThresholds: RoutingThresholds = {
  warnAt: 45,
  drainAt: 50,
  stopNewRoomsAt: 55,
  disableAt: 60,
};

export const jaasProviderThresholds: RoutingThresholds = {
  warnAt: 60,
  drainAt: 68,
  stopNewRoomsAt: 72,
  disableAt: 76,
};

export const jaasMonthlyActiveUserLimit = 25;
export const jaasMonthlyCredentialLimit = 19;

export function routingThresholds(provider: RtcProviderId): RoutingThresholds {
  if (provider === "cloudflare-realtime") return cloudflareProviderThresholds;
  if (provider === "jaas") return jaasProviderThresholds;
  return defaultProviderThresholds;
}

type DatabaseSafetyPolicy = {
  warning_percent: number;
  deprioritize_percent: number;
  drain_percent: number;
  stop_percent: number;
  fail_closed_on_stale: boolean;
  stale_after_seconds: number;
  notes: string;
};

const genericPolicy = (notes: string): DatabaseSafetyPolicy => ({
  warning_percent: 60,
  deprioritize_percent: 65,
  drain_percent: 70,
  stop_percent: 75,
  fail_closed_on_stale: false,
  stale_after_seconds: 1500,
  notes,
});

export const databaseProviderSafetyPolicies: Partial<Record<RtcProviderId, DatabaseSafetyPolicy>> = {
  stream: genericPolicy("USD 100 monthly credit. Warn at USD 60, stop new rooms at USD 70, and disable by USD 75 using conservative internal metering."),
  agora: genericPolicy("10,000 monthly participant minutes. Warn at 6,000, stop new rooms at 7,000, and disable by 7,500."),
  tencent: genericPolicy("10,000 monthly participant minutes during the verified annual offer. PAYG must remain disabled; route disables by 7,500."),
  "cloudflare-realtime": {
    warning_percent: 45,
    deprioritize_percent: 50,
    drain_percent: 55,
    stop_percent: 60,
    fail_closed_on_stale: true,
    stale_after_seconds: 1200,
    notes: "Serverless SFU with dedicated egress telemetry. Warn at 450 GB, stop new rooms at 550 GB, and disable at 600 GB of the 1,000 GB free allocation.",
  },
  livekit: genericPolicy("5,000 monthly participant minutes. Keep disabled while exhausted; after a verified reset the route disables by 3,750."),
  whereby: genericPolicy("2,000 monthly participant minutes with no overage allocation. Route disables by 1,500 minutes."),
  jaas: {
    warning_percent: 60,
    deprioritize_percent: 68,
    drain_percent: 72,
    stop_percent: 76,
    fail_closed_on_stale: false,
    stale_after_seconds: 1500,
    notes: "JaaS Developer allows 25 MAU. Authenticated issuance stops at 19 credentials (76%), keeping the account below 80%.",
  },
};

export function validateProviderSafetyPolicies() {
  for (const [provider, policy] of Object.entries(databaseProviderSafetyPolicies)) {
    const ordered = [
      policy.warning_percent,
      policy.deprioritize_percent,
      policy.drain_percent,
      policy.stop_percent,
    ];
    if (ordered.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new Error(`${provider} has an invalid provider safety threshold`);
    }
    if (ordered.some((value, index) => index > 0 && value < ordered[index - 1])) {
      throw new Error(`${provider} provider safety thresholds are out of order`);
    }
    if (policy.stop_percent >= 80) {
      throw new Error(`${provider} does not stop below 80%`);
    }
  }
  return true;
}
