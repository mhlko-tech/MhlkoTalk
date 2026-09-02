import {
  jaasMonthlyActiveUserLimit,
  jaasMonthlyCredentialLimit,
} from "./providerSafety";
import { updateProviderHealth } from "./providerRouting";

export {
  jaasMonthlyActiveUserLimit,
  jaasMonthlyCredentialLimit,
} from "./providerSafety";

export type ManagedRtcProvider = "jaas" | "mirotalk";

export function isManagedRtcProvider(value: string): value is ManagedRtcProvider {
  return value === "jaas" || value === "mirotalk";
}

export interface ManagedRtcEnvironment {
  PRIVATE_ROOMS: KVNamespace;
  PRESENCE?: DurableObjectNamespace;
  JAAS_QUOTA?: DurableObjectNamespace;
  JAAS_APP_ID?: string;
  JAAS_KEY_ID?: string;
  JAAS_PRIVATE_KEY?: string;
  MIROTALK_BASE_URL?: string;
  MIROTALK_API_KEY_SECRET?: string;
  MIROTALK_HOST_USERNAME?: string;
  MIROTALK_HOST_PASSWORD?: string;
}

type ManagedUser = { id: string } | null;
type ManagedProfile = { display_name?: string; username?: string; avatar_url?: string | null } | null;
type ManagedCredentials = { token: string; identity: string; serverUrl: string };
type EmbedTicket =
  | { provider: "jaas"; appId: string; jwt: string; roomAlias: string; name: string }
  | { provider: "mirotalk"; joinUrl: string; name: string };

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

export async function issueManagedRtcCredentials(
  request: Request,
  env: ManagedRtcEnvironment,
  provider: ManagedRtcProvider,
  roomName: string,
  user: ManagedUser,
  profile: ManagedProfile,
): Promise<ManagedCredentials> {
  switch (provider) {
    case "jaas": return issueJaas(request, env, roomName, user, profile);
    case "mirotalk": return issueMiroTalk(request, env, roomName, user, profile);
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
      "content-security-policy": "default-src 'self' https: wss: blob: data:; script-src 'self' 'unsafe-inline' https://8x8.vc; style-src 'self' 'unsafe-inline' https:; connect-src 'self' https: wss:; img-src 'self' https: data: blob:; media-src 'self' https: blob:; frame-src https:; worker-src 'self' blob:",
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

export async function handleManagedRtcEmbed(request: Request, env: ManagedRtcEnvironment, provider: string) {
  if (!["jaas", "mirotalk"].includes(provider)) return null;
  const ticket = new URL(request.url).searchParams.get("ticket") || "";
  const key = `rtc:embed:ticket:${ticket}`;
  const value = await env.PRIVATE_ROOMS.get(key, "json") as EmbedTicket | null;
  if (!ticket || !value || value.provider !== provider) {
    return htmlResponse(shell("Expired call link", `<div id="status">This call link expired. Return to MHTalk and join the room again.</div>`));
  }
  await env.PRIVATE_ROOMS.delete(key);
  switch (value.provider) {
    case "jaas": return htmlResponse(jaasPage(value));
    case "mirotalk": return htmlResponse(simpleFramePage("MHTalk Calls", value.joinUrl));
  }
}
