import { routePartyTracksRequest } from "partytracks/server";
import { getProviderHealth, updateProviderHealth } from "./providerRouting";

export type CloudflareRtcTrack = {
  location?: "local" | "remote";
  trackName?: string;
  sessionId?: string;
  mid?: string | null;
};

type CloudflareRtcMember = {
  identity: string;
  profile?: {
    name?: string;
    bio?: string;
    avatar?: string;
    username?: string;
    usernameVisible?: boolean;
  };
  media?: {
    microphoneEnabled?: boolean;
    cameraEnabled?: boolean;
    screenShareEnabled?: boolean;
  };
  tracks: Partial<Record<"audio" | "camera" | "screen" | "screenAudio", CloudflareRtcTrack>>;
};

type SocketAttachment = CloudflareRtcMember;

export interface CloudflareRtcEnvironment {
  CLOUDFLARE_REALTIME_APP_ID?: string;
  CLOUDFLARE_REALTIME_API_TOKEN?: string;
  CLOUDFLARE_RTC_USAGE: DurableObjectNamespace;
  PRIVATE_ROOMS: KVNamespace;
  PRESENCE: DurableObjectNamespace;
}

const rtcApiPrefix = "/rtc/cloudflare/partytracks";
export const cloudflareRtcDisableAtPercent = 60;
export const cloudflareRtcTelemetryMaxAgeMs = 20 * 60 * 1_000;
const usageGuardCacheMs = 15_000;

type UsageHealth = {
  usedPercent?: unknown;
  disabled?: unknown;
  updatedAt?: unknown;
};

export type CloudflareRtcUsageGuard = {
  allowed: boolean;
  usedPercent: number | null;
  reason?: string;
};

let cachedUsageGuard: { expiresAt: number; value: CloudflareRtcUsageGuard } | null = null;

export function evaluateCloudflareRtcUsageHealth(
  health: UsageHealth | null,
  now = Date.now(),
): CloudflareRtcUsageGuard {
  if (!health) return { allowed: false, usedPercent: null, reason: "Usage telemetry is missing" };
  const updatedAt = typeof health.updatedAt === "string" ? Date.parse(health.updatedAt) : Number.NaN;
  if (!Number.isFinite(updatedAt) || now - updatedAt > cloudflareRtcTelemetryMaxAgeMs) {
    return { allowed: false, usedPercent: null, reason: "Usage telemetry is stale" };
  }
  const usedPercent = Number(health.usedPercent);
  if (!Number.isFinite(usedPercent) || usedPercent < 0) {
    return { allowed: false, usedPercent: null, reason: "Usage telemetry is invalid" };
  }
  if (health.disabled === true) {
    return { allowed: false, usedPercent, reason: "Cloudflare Realtime is administratively disabled" };
  }
  if (usedPercent >= cloudflareRtcDisableAtPercent) {
    return { allowed: false, usedPercent, reason: "Cloudflare Realtime safety limit reached" };
  }
  return { allowed: true, usedPercent };
}

async function cloudflareRtcUsageGuard(env: CloudflareRtcEnvironment) {
  const now = Date.now();
  if (cachedUsageGuard && cachedUsageGuard.expiresAt > now) return cachedUsageGuard.value;
  const health = await getProviderHealth(env, "cloudflare-realtime") as UsageHealth;
  const value = evaluateCloudflareRtcUsageHealth(health, now);
  cachedUsageGuard = { expiresAt: now + usageGuardCacheMs, value };
  return value;
}

function blockedUsageResponse(guard: CloudflareRtcUsageGuard) {
  return Response.json({
    error: guard.reason || "Cloudflare Realtime is unavailable",
    code: "CLOUDFLARE_REALTIME_USAGE_GUARD",
    usedPercent: guard.usedPercent,
    disableAtPercent: cloudflareRtcDisableAtPercent,
  }, { status: 503, headers: { "cache-control": "no-store" } });
}

export async function proxyCloudflareRtc(
  request: Request,
  env: CloudflareRtcEnvironment,
) {
  if (!env.CLOUDFLARE_REALTIME_APP_ID || !env.CLOUDFLARE_REALTIME_API_TOKEN) {
    return Response.json({ error: "Cloudflare Realtime is not configured" }, { status: 503 });
  }
  const guard = await cloudflareRtcUsageGuard(env);
  if (!guard.allowed) return blockedUsageResponse(guard);
  const response = await routePartyTracksRequest({
    appId: env.CLOUDFLARE_REALTIME_APP_ID,
    token: env.CLOUDFLARE_REALTIME_API_TOKEN,
    prefix: rtcApiPrefix,
    request,
    // Every proxy request is authenticated by MHTalk. Avoid third-party cookie
    // dependence inside Tauri while still keeping the SFU secret server-side.
    lockSessionToInitiator: false,
  });
  const wrapped = new Response(response.body, response);
  wrapped.headers.set("access-control-allow-origin", "*");
  wrapped.headers.set("access-control-allow-headers", "authorization, content-type");
  wrapped.headers.set("cache-control", "no-store");
  return wrapped;
}

export class CloudflareRtcRoom implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: CloudflareRtcEnvironment,
  ) {}

  async fetch(request: Request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    const identity = request.headers.get("x-mhtalk-user-id")?.trim();
    if (!identity) return new Response("Unauthorized", { status: 401 });
    const guard = await cloudflareRtcUsageGuard(this.env);
    if (!guard.allowed) return blockedUsageResponse(guard);

    for (const existing of this.state.getWebSockets()) {
      const attachment = existing.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.identity === identity) existing.close(4001, "Replaced by a newer connection");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ identity, tracks: {} } satisfies SocketAttachment);
    await this.ensureUsageAlarm();
    server.send(JSON.stringify(this.snapshot()));
    this.broadcastSnapshot(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer) {
    try {
      const message = JSON.parse(
        typeof raw === "string" ? raw : new TextDecoder().decode(raw),
      ) as { type?: unknown; tracks?: unknown; media?: unknown; profile?: unknown; event?: unknown };
      const current = socket.deserializeAttachment() as SocketAttachment | null;
      if (!current) return;
      if (message.type === "ping") {
        socket.send(JSON.stringify({ type: "pong", at: Date.now() }));
        return;
      }
      if (message.type === "publish") {
        const usedPercent = await this.accountUsage();
        if (usedPercent !== null && usedPercent >= cloudflareRtcDisableAtPercent) {
          this.closeForUsageGuard();
          return;
        }
        socket.serializeAttachment({
          ...current,
          tracks: sanitizeTracks(message.tracks),
          media: sanitizeMedia(message.media),
          profile: sanitizeProfile(message.profile),
        } satisfies SocketAttachment);
        this.broadcastSnapshot();
        return;
      }
      if (message.type === "event" && isSafeEvent(message.event)) {
        const payload = JSON.stringify({
          type: "event",
          identity: current.identity,
          event: message.event,
        });
        for (const peer of this.state.getWebSockets()) {
          if (peer !== socket) peer.send(payload);
        }
      }
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "Invalid RTC room message" }));
    }
  }

  webSocketClose(socket: WebSocket, code: number, reason: string) {
    socket.close(code, reason);
    this.broadcastSnapshot(socket);
  }

  webSocketError(socket: WebSocket) {
    this.webSocketClose(socket, 1011, "RTC room connection error");
  }

  async alarm() {
    const usedPercent = await this.accountUsage();
    if (usedPercent !== null && usedPercent >= cloudflareRtcDisableAtPercent) {
      this.closeForUsageGuard();
      return;
    }
    await this.ensureUsageAlarm();
  }

  private snapshot() {
    const members = this.state.getWebSockets().flatMap((socket) => {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      return attachment ? [attachment] : [];
    });
    return { type: "snapshot", members };
  }

  private broadcastSnapshot(excluded?: WebSocket) {
    const payload = JSON.stringify(this.snapshot());
    for (const socket of this.state.getWebSockets()) {
      if (socket !== excluded) socket.send(payload);
    }
  }

  private async accountUsage(): Promise<number | null> {
    try {
      const now = Date.now();
      const previous = Number(await this.state.storage.get<number>("usage-accounted-at")) || now;
      await this.state.storage.put("usage-accounted-at", now);
      const elapsedSeconds = Math.min(10 * 60, Math.max(0, (now - previous) / 1_000));
      if (elapsedSeconds <= 0) return null;
      const members = this.snapshot().members;
      if (members.length < 2) return null;
      const publishedMegabitsPerSecond = members.reduce((total, member) => total +
        (member.media?.microphoneEnabled ? 0.08 : 0) +
        (member.media?.cameraEnabled ? 1.5 : 0) +
        (member.media?.screenShareEnabled ? 2.628 : 0), 0);
      // Every published track can be forwarded to every other participant. The
      // 25% multiplier intentionally over-reserves for protocol overhead and
      // bitrate spikes so routing stops before billable egress is approached.
      const estimatedBytes = Math.ceil(
        publishedMegabitsPerSecond * (members.length - 1) * 1_000_000 / 8 * elapsedSeconds * 1.25,
      );
      if (estimatedBytes <= 0) return null;
      const usage = this.env.CLOUDFLARE_RTC_USAGE.get(
        this.env.CLOUDFLARE_RTC_USAGE.idFromName("account-egress"),
      );
      const response = await usage.fetch("https://internal/usage/add", {
        method: "POST",
        body: JSON.stringify({ bytes: estimatedBytes }),
      });
      if (!response.ok) return cloudflareRtcDisableAtPercent;
      const state = await response.json().catch(() => null) as UsageState | null;
      if (!state || !Number.isFinite(state.estimatedEgressBytes)) return cloudflareRtcDisableAtPercent;
      return Math.max(0, state.estimatedEgressBytes / freeEgressBytes * 100);
    } catch {
      // Financial safety is fail-closed: if accounting fails, stop the session.
      return cloudflareRtcDisableAtPercent;
    }
  }

  private async ensureUsageAlarm() {
    if (this.state.getWebSockets().length === 0) return;
    await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1_000);
  }

  private closeForUsageGuard() {
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(JSON.stringify({
          type: "error",
          code: "CLOUDFLARE_REALTIME_USAGE_GUARD",
          message: "Cloudflare Realtime safety limit reached",
        }));
        socket.close(4008, "Cloudflare Realtime usage guard");
      } catch {
        // The socket may already be closing.
      }
    }
  }
}

type UsageState = { month: string; estimatedEgressBytes: number; updatedAt: string };
const freeEgressBytes = 1_000 * 1_000_000_000;

export class CloudflareRtcUsage implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: CloudflareRtcEnvironment,
  ) {}

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/usage/add") {
      const body = await request.json().catch(() => null) as { bytes?: unknown } | null;
      const bytes = Math.min(10_000_000_000, Math.max(0, Number(body?.bytes) || 0));
      return Response.json(await this.state.blockConcurrencyWhile(async () => {
        const usage = await this.currentUsage();
        usage.estimatedEgressBytes += bytes;
        usage.updatedAt = new Date().toISOString();
        await this.state.storage.put("usage", usage);
        return usage;
      }));
    }
    if (request.method === "POST" && url.pathname === "/usage/refresh") {
      const usage = await this.currentUsage();
      usage.updatedAt = new Date().toISOString();
      await this.state.storage.put("usage", usage);
      await this.writeHealth(usage);
      return Response.json(usage);
    }
    if (request.method === "GET" && url.pathname === "/usage") {
      return Response.json(await this.currentUsage());
    }
    return new Response("Not found", { status: 404 });
  }

  private async currentUsage(): Promise<UsageState> {
    const month = new Date().toISOString().slice(0, 7);
    const stored = await this.state.storage.get<UsageState>("usage");
    if (stored?.month === month) return stored;
    return { month, estimatedEgressBytes: 0, updatedAt: new Date().toISOString() };
  }

  private async writeHealth(usage: UsageState) {
    const previous = await getProviderHealth(this.env, "cloudflare-realtime");
    await updateProviderHealth(this.env, "cloudflare-realtime", {
      usedPercent: Math.min(100, usage.estimatedEgressBytes / freeEgressBytes * 100),
      disabled: previous.disabled,
    });
    cachedUsageGuard = null;
  }
}

function sanitizeMedia(value: unknown): CloudflareRtcMember["media"] {
  if (!value || typeof value !== "object") return {};
  const media = value as Record<string, unknown>;
  return {
    microphoneEnabled: media.microphoneEnabled === true,
    cameraEnabled: media.cameraEnabled === true,
    screenShareEnabled: media.screenShareEnabled === true,
  };
}

function sanitizeTracks(value: unknown): CloudflareRtcMember["tracks"] {
  if (!value || typeof value !== "object") return {};
  const incoming = value as Record<string, unknown>;
  const output: CloudflareRtcMember["tracks"] = {};
  for (const key of ["audio", "camera", "screen", "screenAudio"] as const) {
    const track = incoming[key];
    if (!track || typeof track !== "object") continue;
    const candidate = track as Record<string, unknown>;
    if (typeof candidate.trackName !== "string" || typeof candidate.sessionId !== "string") continue;
    if (candidate.trackName.length > 200 || candidate.sessionId.length > 200) continue;
    output[key] = {
      location: "remote",
      trackName: candidate.trackName,
      sessionId: candidate.sessionId,
      ...(typeof candidate.mid === "string" || candidate.mid === null ? { mid: candidate.mid } : {}),
    };
  }
  return output;
}

function sanitizeProfile(value: unknown): CloudflareRtcMember["profile"] {
  if (!value || typeof value !== "object") return undefined;
  const profile = value as Record<string, unknown>;
  const text = (key: string, maximum: number) =>
    typeof profile[key] === "string" ? profile[key].slice(0, maximum) : undefined;
  return {
    name: text("name", 80),
    bio: text("bio", 280),
    avatar: text("avatar", 600),
    username: text("username", 32),
    usernameVisible: profile.usernameVisible !== false,
  };
}

function isSafeEvent(value: unknown) {
  if (!value || typeof value !== "object") return false;
  try {
    return JSON.stringify(value).length <= 16_384;
  } catch {
    return false;
  }
}
