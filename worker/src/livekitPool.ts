import type { ProviderHealth } from "./providerRouting";

export type LiveKitAccount = { id: string; url: string; apiKey: string; apiSecret: string; initialUsedMinutes?: number; initialCycle?: string };
export type LiveKitPoolEnvironment = {
  LIVEKIT_URL: string; LIVEKIT_API_KEY: string; LIVEKIT_API_SECRET: string;
  LIVEKIT_ACCOUNTS_JSON?: string;
};
export type LiveKitPoolUsage = { cycle: string; minutes: Record<string, number> };
export type LiveKitAccountHealth = { id: string; serverId: number; usedPercent: number; ready: boolean };
export const primaryLiveKitAccount = "mhtalk-01";

export function livekitAccounts(env: LiveKitPoolEnvironment): LiveKitAccount[] {
  const primary = { id: primaryLiveKitAccount, url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET };
  if (!env.LIVEKIT_ACCOUNTS_JSON) return [primary];
  const extra: unknown = JSON.parse(env.LIVEKIT_ACCOUNTS_JSON);
  if (!Array.isArray(extra) || extra.length > 20) throw new Error("Invalid LiveKit account configuration");
  const ids = new Set([primary.id]);
  const urls = new Set([new URL(primary.url).hostname]);
  for (const item of extra) {
    if (!item || typeof item !== "object" || !/^[a-z0-9-]{1,40}$/.test(item.id) ||
        typeof item.apiKey !== "string" || !item.apiKey || typeof item.apiSecret !== "string" || !item.apiSecret ||
        typeof item.url !== "string") throw new Error("Invalid LiveKit account configuration");
    const url = new URL(item.url);
    if (!["https:", "wss:"].includes(url.protocol) || !url.hostname.endsWith(".livekit.cloud") ||
        url.username || url.password || url.search || url.hash || ids.has(item.id) || urls.has(url.hostname)) {
      throw new Error("Duplicate or invalid LiveKit account");
    }
    ids.add(item.id); urls.add(url.hostname);
  }
  return [primary, ...extra as LiveKitAccount[]];
}

export function poolUsage(stored: LiveKitPoolUsage | undefined, now = Date.now()): LiveKitPoolUsage {
  const cycle = new Date(now).toISOString().slice(0, 7);
  return stored?.cycle === cycle ? { cycle, minutes: { ...stored.minutes } } : { cycle, minutes: {} };
}

export function livekitAccountHealth(accounts: LiveKitAccount[], usage: LiveKitPoolUsage,
  primaryHealth: ProviderHealth | undefined, now = Date.now()): LiveKitAccountHealth[] {
  const fresh = primaryHealth && !primaryHealth.disabled &&
    Number.isFinite(Date.parse(primaryHealth.updatedAt)) && now - Date.parse(primaryHealth.updatedAt) < 25 * 60_000;
  return accounts.map((account) => {
    // Supabase remains authoritative for the original account. Additional
    // accounts are metered atomically with the room lease in the Durable Object.
    const minutes = account.id === primaryLiveKitAccount
      ? Math.max(Number(primaryHealth?.usedPercent || 0) * 50, usage.minutes[account.id] || 0)
      : Math.max(usage.minutes[account.id] || 0, account.initialCycle === usage.cycle ? Number(account.initialUsedMinutes || 0) : 0);
    const usedPercent = minutes / 50;
    return { id: account.id, serverId: Number(account.id.replace("mhtalk-", "")), usedPercent, ready: Boolean(fresh && Number.isFinite(usedPercent) && usedPercent < 90) };
  });
}

export function chooseLivekitAccount(health: LiveKitAccountHealth[], pinned: string | undefined, othersPresent: boolean) {
  if (pinned && health.some((entry) => entry.id === pinned && entry.ready)) return pinned;
  if (pinned && othersPresent) return null;
  return [...health].filter((entry) => entry.ready).sort((a, b) => a.usedPercent - b.usedPercent || a.id.localeCompare(b.id))[0]?.id || null;
}
