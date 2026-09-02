import {
  jaasMonthlyActiveUserLimit,
  jaasMonthlyCredentialLimit,
} from "./providerSafety";
import { updateProviderHealth } from "./providerRouting";

export {
  jaasMonthlyActiveUserLimit,
  jaasMonthlyCredentialLimit,
} from "./providerSafety";

export type ManagedRtcProvider = "100ms" | "cometchat" | "jaas" | "mirotalk" | "videosdk";

export function isManagedRtcProvider(value: string): value is ManagedRtcProvider {
  return value === "100ms" || value === "cometchat" || value === "jaas" || value === "mirotalk" || value === "videosdk";
}

export interface ManagedRtcEnvironment {
  PRIVATE_ROOMS: KVNamespace;
  PRESENCE?: DurableObjectNamespace;
  JAAS_QUOTA?: DurableObjectNamespace;
  HMS_ACCESS_KEY?: string;
  HMS_APP_SECRET?: string;
  HMS_TEMPLATE_ID?: string;
  HMS_TEMPLATE_SUBDOMAIN?: string;
  HMS_ROLE?: string;
  COMETCHAT_APP_ID?: string;
  COMETCHAT_REGION?: string;
  COMETCHAT_REST_API_KEY?: string;
  COMETCHAT_AUTH_KEY?: string;
  JAAS_APP_ID?: string;
  JAAS_KEY_ID?: string;
  JAAS_PRIVATE_KEY?: string;
  MIROTALK_BASE_URL?: string;
  MIROTALK_API_KEY_SECRET?: string;
  MIROTALK_HOST_USERNAME?: string;
  MIROTALK_HOST_PASSWORD?: string;
  VIDEOSDK_API_KEY?: string;
  VIDEOSDK_API_SECRET?: string;
}

type ManagedUser = { id: string } | null;
type ManagedProfile = { display_name?: string; username?: string; avatar_url?: string | null } | null;
type ManagedCredentials = { token: string; identity: string; serverUrl: string };
type EmbedTicket =
  | { provider: "100ms"; joinUrl: string; name: string }
  | { provider: "cometchat"; appId: string; region: string; authToken: string; sessionId: string; name: string }
  | { provider: "jaas"; appId: string; jwt: string; roomAlias: string; name: string }
  | { provider: "mirotalk"; joinUrl: string; name: string }
  | { provider: "videosdk"; joinUrl: string; name: string };

const encoder = new TextEncoder();
const ticketLifetimeSeconds = 90;
const apiTimeoutMs = 10_000;
export const jaasQuotaObjectName = "developer-plan";

type JaasQuotaState = {
  cycle: string;
  issued: number;
};

function jaasQuotaCycle(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function writeJaasHealth(env: Pick<ManagedRtcEnvironment, "PRESENCE">, state: JaasQuotaState) {
  const usedPercent = Math.min(100, state.issued / jaasMonthlyActiveUserLimit * 100);
  if (!env.PRESENCE) throw new Error("JaaS provider health store is unavailable");
  await updateProviderHealth({ PRESENCE: env.PRESENCE }, "jaas", {
    usedPercent,
    disabled: state.issued >= jaasMonthlyCredentialLimit,
  });
  return { ...state, usedPercent, limit: jaasMonthlyCredentialLimit };
}

// JaaS bills overages after its 25-MAU developer allowance. Count every
// credential issuance (not just unique MHTalk accounts) in a strongly
// consistent Durable Object. This deliberately conservative model means a
// credential can introduce at most one new JaaS endpoint, so stopping at 19
// keeps usage below 80% even across devices and reinstalls.
export class JaasQuotaGuard {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Pick<ManagedRtcEnvironment, "PRESENCE">,
  ) {}

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || !["/reserve", "/refresh"].includes(url.pathname)) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const cycle = jaasQuotaCycle();
    const stored = await this.state.storage.get<JaasQuotaState>("quota");
    const quota: JaasQuotaState = stored?.cycle === cycle
      ? { cycle, issued: Math.max(0, Number(stored.issued) || 0) }
      : { cycle, issued: 0 };
    if (url.pathname === "/reserve") {
      if (quota.issued >= jaasMonthlyCredentialLimit) {
        const status = await writeJaasHealth(this.env, quota);
        return Response.json({ allowed: false, ...status }, { status: 429 });
      }
      quota.issued += 1;
      await this.state.storage.put("quota", quota);
    } else if (stored?.cycle !== cycle) {
      await this.state.storage.put("quota", quota);
    }
    const status = await writeJaasHealth(this.env, quota);
    return Response.json({ allowed: true, ...status });
  }
}

function encodeBase64Url(value: ArrayBuffer | Uint8Array) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeJson(value: unknown) {
  return encodeBase64Url(encoder.encode(JSON.stringify(value)));
}

async function hmacJwt(secret: string, payload: Record<string, unknown>) {
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const body = encodeJson(payload);
  const unsigned = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(unsigned));
  return `${unsigned}.${encodeBase64Url(signature)}`;
}

async function rsaJwt(privateKeyValue: string, keyId: string, payload: Record<string, unknown>) {
  const header = encodeJson({ alg: "RS256", typ: "JWT", kid: keyId });
  const body = encodeJson(payload);
  const unsigned = `${header}.${body}`;
  const pem = privateKeyValue
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(pem), (character) => character.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, encoder.encode(unsigned));
  return `${unsigned}.${encodeBase64Url(signature)}`;
}

async function hash(value: string) {
  return encodeBase64Url(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function apiFetch(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), apiTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function requireValue(value: string | undefined, label: string) {
  if (!value) throw new Error(`${label} is not configured`);
  return value;
}

function displayName(user: ManagedUser, profile: ManagedProfile) {
  return (profile?.display_name || profile?.username || (user ? `MHTalk ${user.id.slice(0, 8)}` : "MHTalk guest")).slice(0, 80);
}

function identityFor(user: ManagedUser) {
  return user?.id || `guest-${crypto.randomUUID()}`;
}

async function issueEmbedTicket(
  request: Request,
  env: ManagedRtcEnvironment,
  payload: EmbedTicket,
  identity: string,
): Promise<ManagedCredentials> {
  const ticket = crypto.randomUUID().replace(/-/g, "");
  await env.PRIVATE_ROOMS.put(`rtc:embed:ticket:${ticket}`, JSON.stringify(payload), {
    expirationTtl: ticketLifetimeSeconds,
  });
  return {
    token: ticket,
    identity,
    serverUrl: `${new URL(request.url).origin}/rtc/embed/${payload.provider}?ticket=${ticket}`,
  };
}

async function issue100ms(
  request: Request,
  env: ManagedRtcEnvironment,
  roomName: string,
  user: ManagedUser,
  profile: ManagedProfile,
) {
  const accessKey = requireValue(env.HMS_ACCESS_KEY, "100ms access key");
  const appSecret = requireValue(env.HMS_APP_SECRET, "100ms app secret");
  const templateId = requireValue(env.HMS_TEMPLATE_ID, "100ms template ID");
  const subdomain = requireValue(env.HMS_TEMPLATE_SUBDOMAIN, "100ms template subdomain");
  const identity = identityFor(user);
  const roomHash = await hash(roomName);
  const cacheKey = `routing:100ms:room:${roomHash}`;
  let cached = await env.PRIVATE_ROOMS.get(cacheKey, "json") as { roomId?: string; roomCode?: string } | null;
  if (!cached?.roomId || !cached.roomCode) {
    const now = Math.floor(Date.now() / 1000);
    const managementToken = await hmacJwt(appSecret, {
      access_key: accessKey,
      type: "management",
      version: 2,
      jti: crypto.randomUUID(),
      iat: now,
      nbf: now - 10,
      exp: now + 3600,
    });
    const roomResponse = await apiFetch("https://api.100ms.live/v2/rooms", {
      method: "POST",
      headers: { authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: `mhtalk-${roomHash.slice(0, 32)}`,
        description: "MHTalk managed realtime room",
        template_id: templateId,
      }),
    });
    if (!roomResponse.ok) throw new Error(`100ms room creation failed (${roomResponse.status})`);
    const room = await roomResponse.json() as { id?: string };
    if (!room.id) throw new Error("100ms did not return a room ID");
    const role = encodeURIComponent(env.HMS_ROLE || "guest");
    const codeResponse = await apiFetch(`https://api.100ms.live/v2/room-codes/room/${encodeURIComponent(room.id)}/role/${role}`, {
      method: "POST",
      headers: { authorization: `Bearer ${managementToken}`, "content-type": "application/json" },
    });
    if (!codeResponse.ok) throw new Error(`100ms room-code creation failed (${codeResponse.status})`);
    const codePayload = await codeResponse.json() as { code?: string; data?: Array<{ code?: string }> };
    const roomCode = codePayload.code || codePayload.data?.find((item) => item.code)?.code;
    if (!roomCode) throw new Error("100ms did not return a room code");
    cached = { roomId: room.id, roomCode };
    await env.PRIVATE_ROOMS.put(cacheKey, JSON.stringify(cached));
  }
  const joinUrl = new URL(`https://${subdomain}.app.100ms.live/meeting/${cached.roomCode}`);
  joinUrl.searchParams.set("name", displayName(user, profile));
  joinUrl.searchParams.set("userId", identity);
  return issueEmbedTicket(request, env, {
    provider: "100ms",
    joinUrl: joinUrl.toString(),
    name: displayName(user, profile),
  }, identity);
}

async function cometChatAuthToken(env: ManagedRtcEnvironment, identity: string, name: string) {
  const cachedKey = `routing:cometchat:user:${identity}`;
  const cached = await env.PRIVATE_ROOMS.get(cachedKey);
  if (cached) return cached;
  const appId = requireValue(env.COMETCHAT_APP_ID, "CometChat app ID");
  const region = requireValue(env.COMETCHAT_REGION, "CometChat region");
  const apiKey = requireValue(env.COMETCHAT_REST_API_KEY || env.COMETCHAT_AUTH_KEY, "CometChat REST API key");
  const uid = `mhtalk-${identity.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`.slice(0, 100);
  const base = `https://${appId}.api-${region}.cometchat.io/v3`;
  const commonHeaders = { apikey: apiKey, "content-type": "application/json", accept: "application/json" };
  const existing = await apiFetch(`${base}/users/${encodeURIComponent(uid)}`, { headers: commonHeaders });
  if (existing.status === 404) {
    const created = await apiFetch(`${base}/users`, {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({ uid, name }),
    });
    if (!created.ok) throw new Error(`CometChat user creation failed (${created.status})`);
  } else if (!existing.ok) {
    throw new Error(`CometChat user lookup failed (${existing.status})`);
  }
  const tokenResponse = await apiFetch(`${base}/users/${encodeURIComponent(uid)}/auth_tokens`, {
    method: "POST",
    headers: commonHeaders,
    body: "{}",
  });
  if (!tokenResponse.ok) throw new Error(`CometChat auth token creation failed (${tokenResponse.status})`);
  const tokenPayload = await tokenResponse.json() as { data?: { authToken?: string } };
  const authToken = tokenPayload.data?.authToken;
  if (!authToken) throw new Error("CometChat did not return an auth token");
  await env.PRIVATE_ROOMS.put(cachedKey, authToken, { expirationTtl: 28 * 24 * 60 * 60 });
  return authToken;
}

async function issueCometChat(
  request: Request,
  env: ManagedRtcEnvironment,
  roomName: string,
  user: ManagedUser,
  profile: ManagedProfile,
) {
  if (!user) throw new Error("CometChat requires an authenticated MHTalk account");
  const appId = requireValue(env.COMETCHAT_APP_ID, "CometChat app ID");
  const region = requireValue(env.COMETCHAT_REGION, "CometChat region");
  const name = displayName(user, profile);
  const authToken = await cometChatAuthToken(env, user.id, name);
  const sessionId = `mhtalk-${(await hash(roomName)).slice(0, 40)}`;
  return issueEmbedTicket(request, env, {
    provider: "cometchat",
    appId,
    region,
    authToken,
    sessionId,
    name,
  }, user.id);
}

async function issueJaas(
  request: Request,
  env: ManagedRtcEnvironment,
  roomName: string,
  user: ManagedUser,
  profile: ManagedProfile,
) {
  if (!user) throw new Error("JaaS requires an authenticated MHTalk account");
  const appId = requireValue(env.JAAS_APP_ID, "JaaS app ID");
  const keyId = requireValue(env.JAAS_KEY_ID, "JaaS key ID");
  const privateKey = requireValue(env.JAAS_PRIVATE_KEY, "JaaS private key");
  if (!env.JAAS_QUOTA) throw new Error("JaaS quota guard is not configured");
  const quota = env.JAAS_QUOTA.get(env.JAAS_QUOTA.idFromName(jaasQuotaObjectName));
  const quotaResponse = await quota.fetch("https://internal/reserve", { method: "POST" });
  if (!quotaResponse.ok) throw new Error("JaaS free-tier safety limit reached");
  const identity = user.id;
  const alias = `mhtalk-${(await hash(roomName)).slice(0, 40)}`;
  const now = Math.floor(Date.now() / 1000);
  const jwt = await rsaJwt(privateKey, keyId, {
    aud: "jitsi",
    iss: "chat",
    sub: appId,
    room: alias,
    nbf: now - 10,
    exp: now + 2 * 60 * 60,
    context: {
      user: {
        id: identity,
        name: displayName(user, profile),
        avatar: profile?.avatar_url || "",
      },
      features: {
        livestreaming: false,
        recording: false,
        transcription: false,
        "outbound-call": false,
      },
    },
  });
  return issueEmbedTicket(request, env, {
    provider: "jaas",
    appId,
    jwt,
    roomAlias: alias,
    name: displayName(user, profile),
  }, identity);
}

async function issueMiroTalk(
  request: Request,
  env: ManagedRtcEnvironment,
  roomName: string,
  user: ManagedUser,
  profile: ManagedProfile,
) {
  const baseUrl = new URL(requireValue(env.MIROTALK_BASE_URL, "MiroTalk base URL"));
  if (baseUrl.protocol !== "https:") throw new Error("MiroTalk requires HTTPS");
  const apiSecret = requireValue(env.MIROTALK_API_KEY_SECRET, "MiroTalk API secret");
  const hostUsername = requireValue(env.MIROTALK_HOST_USERNAME, "MiroTalk host username");
  const hostPassword = requireValue(env.MIROTALK_HOST_PASSWORD, "MiroTalk host password");
  const identity = identityFor(user);
  const response = await apiFetch(new URL("/api/v1/join", baseUrl).toString(), {
    method: "POST",
    headers: {
      authorization: apiSecret,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      room: `mhtalk-${(await hash(roomName)).slice(0, 40)}`,
      roomPassword: false,
      name: displayName(user, profile),
      avatar: profile?.avatar_url || false,
      audio: true,
      video: false,
      screen: false,
      chat: true,
      hide: false,
      notify: false,
      duration: "02:00:00",
      token: {
        username: hostUsername,
        password: hostPassword,
        presenter: true,
        expire: "2h",
      },
    }),
  });
  if (!response.ok) throw new Error(`MiroTalk join creation failed (${response.status})`);
  const payload = await response.json() as { join?: unknown; error?: unknown };
  if (typeof payload.join !== "string" || !payload.join) {
    throw new Error(typeof payload.error === "string" ? payload.error : "MiroTalk did not return a join URL");
  }
  const joinUrl = new URL(payload.join, baseUrl);
  if (joinUrl.origin !== baseUrl.origin) throw new Error("MiroTalk returned an unexpected join origin");
  return issueEmbedTicket(request, env, {
    provider: "mirotalk",
    joinUrl: joinUrl.toString(),
    name: displayName(user, profile),
  }, identity);
}

async function issueVideoSdk(
  request: Request,
  env: ManagedRtcEnvironment,
  roomName: string,
  user: ManagedUser,
  profile: ManagedProfile,
) {
  const apiKey = requireValue(env.VIDEOSDK_API_KEY, "VideoSDK API key");
  const apiSecret = requireValue(env.VIDEOSDK_API_SECRET, "VideoSDK API secret");
  const identity = identityFor(user);
  const now = Math.floor(Date.now() / 1000);
  const roomHash = await hash(roomName);
  const cacheKey = `routing:videosdk:room:${roomHash}`;
  let meetingId = await env.PRIVATE_ROOMS.get(cacheKey);
  if (!meetingId) {
    const managementToken = await hmacJwt(apiSecret, {
      apikey: apiKey,
      permissions: ["allow_join", "allow_mod"],
      version: 2,
      roles: ["crawler", "rtc"],
      iat: now,
      exp: now + 60 * 60,
    });
    const response = await apiFetch("https://api.videosdk.live/v2/rooms", {
      method: "POST",
      headers: { authorization: managementToken, "content-type": "application/json" },
      body: JSON.stringify({ customRoomId: `mhtalk-${roomHash.slice(0, 28)}` }),
    });
    if (!response.ok) throw new Error(`VideoSDK room creation failed (${response.status})`);
    const room = await response.json() as { roomId?: string };
    if (!room.roomId) throw new Error("VideoSDK did not return a meeting ID");
    meetingId = room.roomId;
    await env.PRIVATE_ROOMS.put(cacheKey, meetingId, { expirationTtl: 24 * 60 * 60 });
  }
  const token = await hmacJwt(apiSecret, {
    apikey: apiKey,
    permissions: ["allow_join"],
    version: 2,
    roles: ["rtc"],
    roomId: meetingId,
    participantId: identity,
    iat: now,
    exp: now + 2 * 60 * 60,
  });
  const joinUrl = new URL("https://embed.videosdk.live/rtc-js-prebuilt/0.3.43");
  joinUrl.searchParams.set("name", displayName(user, profile));
  joinUrl.searchParams.set("micEnabled", "true");
  joinUrl.searchParams.set("webcamEnabled", "false");
  joinUrl.searchParams.set("meetingId", meetingId);
  joinUrl.searchParams.set("token", token);
  return issueEmbedTicket(request, env, {
    provider: "videosdk",
    joinUrl: joinUrl.toString(),
    name: displayName(user, profile),
  }, identity);
}

export async function issueManagedRtcCredentials(
  request: Request,
  env: ManagedRtcEnvironment,
  provider: ManagedRtcProvider,
  roomName: string,
  user: ManagedUser,
  profile: ManagedProfile,
): Promise<ManagedCredentials> {
  switch (provider) {
    case "100ms": return issue100ms(request, env, roomName, user, profile);
    case "cometchat": return issueCometChat(request, env, roomName, user, profile);
    case "jaas": return issueJaas(request, env, roomName, user, profile);
    case "mirotalk": return issueMiroTalk(request, env, roomName, user, profile);
    case "videosdk": return issueVideoSdk(request, env, roomName, user, profile);
  }
}

function scriptValue(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function shell(title: string, body: string, script = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · MHTalk</title><style>
  html,body,#call,.frame{width:100%;height:100%;margin:0;border:0;background:#090d17;color:#eef2ff;font-family:Inter,system-ui,sans-serif;overflow:hidden}#status{position:fixed;inset:0;display:grid;place-items:center;padding:24px;text-align:center;background:#090d17;z-index:5}.hidden{display:none!important}
  </style></head><body>${body}<script>${script}</script></body></html>`;
}

function htmlResponse(html: string) {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "permissions-policy": "camera=*, microphone=*, display-capture=*, fullscreen=*",
      "content-security-policy": "default-src 'self' https: wss: blob: data:; script-src 'self' 'unsafe-inline' https://8x8.vc https://unpkg.com; style-src 'self' 'unsafe-inline' https:; connect-src 'self' https: wss:; img-src 'self' https: data: blob:; media-src 'self' https: blob:; frame-src https:; worker-src 'self' blob:",
    },
  });
}

function simpleFramePage(title: string, joinUrl: string) {
  return shell(title, `<iframe class="frame" src=${scriptValue(joinUrl)} allow="camera; microphone; display-capture; autoplay; fullscreen" referrerpolicy="no-referrer"></iframe>`);
}

function jaasPage(ticket: Extract<EmbedTicket, { provider: "jaas" }>) {
  const config = scriptValue(ticket);
  return shell("JaaS", `<div id="call"></div><div id="status">Connecting through JaaS…</div><script src="https://8x8.vc/${encodeURIComponent(ticket.appId)}/external_api.js"></script>`, `
  const config=${config};
  try {
    const api=new JitsiMeetExternalAPI("8x8.vc",{roomName:config.appId+"/"+config.roomAlias,jwt:config.jwt,parentNode:document.getElementById("call"),userInfo:{displayName:config.name},configOverwrite:{prejoinConfig:{enabled:false},startWithVideoMuted:true,disableDeepLinking:true}});
    api.addListener("videoConferenceJoined",()=>document.getElementById("status").classList.add("hidden"));
  } catch(error) { document.getElementById("status").textContent="JaaS connection failed. Please leave and retry."; }
  `);
}

function cometChatPage(ticket: Extract<EmbedTicket, { provider: "cometchat" }>) {
  const config = scriptValue(ticket);
  return shell("CometChat", `<div id="call"></div><div id="status">Connecting through CometChat…</div><script src="https://unpkg.com/@cometchat/calls-sdk-javascript@5.0.0/dist/index.umd.js"></script>`, `
  const config=${config};
  (async()=>{try{
    const exported=window.CometChatCalls;const calls=exported&&exported.CometChatCalls?exported.CometChatCalls:exported;
    if(!calls)throw new Error("CometChat Calls SDK did not load");
    const initialized=await calls.init({appId:config.appId,region:config.region});
    if(initialized&&initialized.success===false)throw initialized.error||new Error("CometChat initialization failed");
    await calls.login(config.authToken);
    const generated=await calls.generateToken(config.sessionId);
    const settings={sessionType:"VIDEO",layout:"TILE",startAudioMuted:false,startVideoPaused:true,hideLeaveSessionButton:false,hideToggleAudioButton:false,hideToggleVideoButton:false,hideRecordingButton:true,hideScreenSharingButton:false,hideChangeLayoutButton:false,hideControlPanel:false,autoStartRecording:false};
    await calls.joinSession(generated,settings,document.getElementById("call"));
    document.getElementById("status").classList.add("hidden");
  }catch(error){console.error(error);document.getElementById("status").textContent="CometChat connection failed. Please leave and retry.";}})();
  `);
}

export async function handleManagedRtcEmbed(request: Request, env: ManagedRtcEnvironment, provider: string) {
  if (!["100ms", "cometchat", "jaas", "mirotalk", "videosdk"].includes(provider)) return null;
  const ticket = new URL(request.url).searchParams.get("ticket") || "";
  const key = `rtc:embed:ticket:${ticket}`;
  const value = await env.PRIVATE_ROOMS.get(key, "json") as EmbedTicket | null;
  if (!ticket || !value || value.provider !== provider) {
    return htmlResponse(shell("Expired call link", `<div id="status">This call link expired. Return to MHTalk and join the room again.</div>`));
  }
  await env.PRIVATE_ROOMS.delete(key);
  switch (value.provider) {
    case "100ms": return htmlResponse(simpleFramePage("100ms", value.joinUrl));
    case "cometchat": return htmlResponse(cometChatPage(value));
    case "jaas": return htmlResponse(jaasPage(value));
    case "mirotalk": return htmlResponse(simpleFramePage("MHTalk Calls", value.joinUrl));
    case "videosdk": return htmlResponse(simpleFramePage("VideoSDK", value.joinUrl));
  }
}
