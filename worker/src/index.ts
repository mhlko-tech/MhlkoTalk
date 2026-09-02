import { AccessToken } from "livekit-server-sdk";
import { StreamClient } from "@stream-io/node-sdk";
import { RtcRole, RtcTokenBuilder } from "agora-token";
import { moderateMainMessage } from "../../src/core/moderation";
import { emailError, passwordError, usernameError } from "../../src/core/authRules";
import {
  knownFileProviders,
  knownMessagingProviders,
  routingForRtcProvider,
  routingIsSupported,
  type FileProviderId,
  type MessagingProviderId,
} from "../../src/core/serviceRouting";
import {
  isRtcProvider,
  parseRtcProviders,
  rtcCapabilities,
  selectRtcProvider,
  updateProviderHealth,
  updateProviderHealthBatch,
  type RtcProviderId,
} from "./providerRouting";
import { generateTencentUserSig } from "./tencentUserSig";
import { CloudflareRtcRoom, CloudflareRtcUsage, proxyCloudflareRtc } from "./cloudflareRtc";
import { monthlyUsageCycle, usageAmount } from "./rtcUsage";
import {
  handleManagedRtcEmbed,
  isManagedRtcProvider,
  issueManagedRtcCredentials,
  JaasQuotaGuard,
  jaasQuotaObjectName,
} from "./managedRtcProviders";
import {
  cloudflareProviderThresholds,
  databaseProviderSafetyPolicies,
  defaultProviderThresholds,
  jaasMonthlyActiveUserLimit,
  jaasMonthlyCredentialLimit,
  jaasProviderThresholds,
  validateProviderSafetyPolicies,
} from "./providerSafety";
import {
  signPresenceTicket,
  signSocialInvite,
  verifyPresenceTicket,
  verifySocialInvite,
} from "./socialTokens";

export { CloudflareRtcRoom, CloudflareRtcUsage, JaasQuotaGuard };

export interface Env {
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;
  LIVEKIT_URL: string;
  INVITE_SIGNING_KEY: string;
  PRIVATE_ROOMS: KVNamespace;
  PRESENCE: DurableObjectNamespace;
  CLOUDFLARE_RTC_ROOMS: DurableObjectNamespace;
  CLOUDFLARE_RTC_USAGE: DurableObjectNamespace;
  JAAS_QUOTA: DurableObjectNamespace;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  AUTH_REQUIRED?: string;
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
  RTC_PROVIDER_ORDER?: string;
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
  LAVA_MEMBERSHIP_BACKEND_URL?: string;
}

type AuthUser = { id: string; accessToken: string; email?: string; userMetadata?: Record<string, unknown>; appMetadata?: Record<string, unknown> };
type Profile = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  bio?: string | null;
  username_visible: boolean;
  username_changed_at?: string | null;
  subscription_tier?: "free" | "plus";
  subscription_expires_at?: string | null;
};
type AccountLogin = {
  user_id: string; username: string; email: string;
  google_linked_at?: string | null; password_enabled_at?: string | null;
  creation_verified_at?: string | null; onboarding_completed_at?: string | null;
};
const encoder = new TextEncoder();
const allowedRoom = /^[a-zA-Z0-9 _-]{1,100}$/;
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
const headers = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers });
const routingAdminAuthorized = (request: Request, env: Env) => Boolean(
  env.ROUTING_ADMIN_KEY &&
  request.headers.get("authorization") === `Bearer ${env.ROUTING_ADMIN_KEY}`
);
const subscriptionEntitlements = {
  free: {
    maxCameraQuality: "medium",
    maxScreenShareQuality: "medium",
    maxAttachmentBytes: 20 * 1024 * 1024,
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
    maxAttachmentBytes: 100 * 1024 * 1024,
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
} as const;
function subscriptionFor(profile: Profile | null) {
  const expiresAt = profile?.subscription_expires_at || undefined;
  const plusIsCurrent = profile?.subscription_tier === "plus" &&
    (!expiresAt || new Date(expiresAt).getTime() > Date.now());
  const tier = plusIsCurrent ? "plus" : "free";
  return { tier, expiresAt, entitlements: subscriptionEntitlements[tier] };
}
function serviceRouting(env: Env, profile: Profile | null, provider: RtcProviderId, providerUrl?: string) {
  const daily = provider === "daily";
  const whereby = provider === "whereby";
  const embedded = daily || whereby || isManagedRtcProvider(provider);
  const stream = provider === "stream";
  const agora = provider === "agora";
  const tencent = provider === "tencent";
  const cloudflare = provider === "cloudflare-realtime";
  const companionRouting = routingForRtcProvider(provider);
  return {
    rtc: {
      provider,
      serverUrl: embedded || cloudflare ? providerUrl || "" : stream || agora || tencent ? "" : env.LIVEKIT_URL.replace(/^http/, "ws"),
      ...(stream ? { clientKey: env.STREAM_API_KEY || "" } : {}),
      ...(agora ? { clientKey: env.AGORA_APP_ID || "" } : {}),
      ...(tencent ? { clientKey: env.TENCENT_SDK_APP_ID || "" } : {}),
    },
    messaging: { provider: companionRouting.messaging },
    files: { provider: companionRouting.files },
    subscription: subscriptionFor(profile),
  } as const;
}
async function serviceCapabilities(env: Env) {
  const rtc = await rtcCapabilities(env);
  const activeRtc = rtc.find((item) => item.ready)?.provider || null;
  const activeRouting = activeRtc ? routingForRtcProvider(activeRtc) : null;
  const alerts = rtc
    .filter((item) => item.configured && item.state !== "healthy")
    .map((item) => ({ provider: item.provider, state: item.state, reason: item.reason || "Provider requires attention" }));
  return {
    active: {
      rtc: activeRtc,
      messaging: activeRouting?.messaging ?? null,
      files: activeRouting?.files ?? null,
    },
    thresholds: {
      default: {
        warningPercent: defaultProviderThresholds.warnAt,
        lowerPriorityPercent: defaultProviderThresholds.drainAt,
        stopNewRoomsPercent: defaultProviderThresholds.stopNewRoomsAt,
        disablePercent: defaultProviderThresholds.disableAt,
        telemetryMaxAgeMinutes: 25,
      },
      "cloudflare-realtime": {
        warningPercent: cloudflareProviderThresholds.warnAt,
        lowerPriorityPercent: cloudflareProviderThresholds.drainAt,
        stopNewRoomsPercent: cloudflareProviderThresholds.stopNewRoomsAt,
        disablePercent: cloudflareProviderThresholds.disableAt,
        telemetryMaxAgeMinutes: 20,
        accountingSafetyMarginPercent: 25,
      },
      jaas: {
        warningPercent: jaasProviderThresholds.warnAt,
        lowerPriorityPercent: jaasProviderThresholds.drainAt,
        stopNewRoomsPercent: jaasProviderThresholds.stopNewRoomsAt,
        disablePercent: jaasProviderThresholds.disableAt,
        freeMonthlyActiveUsers: jaasMonthlyActiveUserLimit,
        maxMonthlyCredentialIssuances: jaasMonthlyCredentialLimit,
        authenticatedAccountsOnly: true,
      },
    },
    monitoring: {
      refreshMinutes: 15,
      failClosedAfterMinutes: 25,
      targetMaximumPercent: 79,
      readyProviders: rtc.filter((item) => item.ready).length,
      configuredProviders: rtc.filter((item) => item.configured).length,
      alerts,
    },
    rtc,
    messaging: ["daily-chat", "whereby-chat", "livekit-data", "stream-events", "agora-data", "tencent-data", "cloudflare-realtime", "supabase-realtime", "firebase"],
    files: ["daily-prebuilt", "whereby-prebuilt", "livekit-stream", "cloudflare-r2", "supabase-storage", "backblaze-b2"],
  };
}

function parseProviderCapabilities<T extends string>(
  value: unknown,
  known: readonly T[],
) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim().toLowerCase()).filter((item): item is T => known.includes(item as T)))];
}
const publicPage = (title: string, body: string) => new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · MHTalk</title><style>body{margin:0;background:#0c111b;color:#e8edf7;font:16px/1.65 system-ui,sans-serif}main{max-width:780px;margin:auto;padding:56px 24px}h1,h2{color:#fff}a{color:#73b7ff}.card{background:#151d2b;border:1px solid #263348;border-radius:18px;padding:28px}small{color:#9aa8bc}</style></head>
<body><main><div class="card"><h1>${title}</h1>${body}<p><a href="/">MHTalk home</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p><small>Contact: 3084346hlko@gmail.com</small></div></main></body></html>`, {
  headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" },
});
const homePage = () => publicPage("MHTalk", `<p>MHTalk is a voice, video, screen-sharing and social rooms app for Android and Windows.</p><p>Sign in securely with your username or email and password, or continue with Google, to keep your profile and friends available across your devices.</p>`);
const privacyPage = () => publicPage("Privacy Policy", `<p>Last updated: August 30, 2026.</p><h2>Data we use</h2><p>When you create or use an account, MHTalk stores your account identifier, username, email address, profile name and picture, friend relationships, blocks, and notification device tokens. Supabase hosts this account data and Cloudflare routes authenticated requests. Passwords are processed and hashed by Supabase Auth and are never stored by MHTalk.</p><h2>Calls and files</h2><p>The selected compatible realtime provider carries live voice, camera, screen sharing, chat and short room events. The routing response tells the app which service is active before a room opens. Live media is not recorded by MHTalk. Authenticated attachments on guarded routes are kept in a private Supabase bucket for 24 hours on Free accounts or seven days on Plus accounts, then removed automatically. Room invitations and presence data are temporary.</p><h2>Purpose and sharing</h2><p>We use this data only to provide authentication, account recovery, profiles, friends, presence, room invitations and notifications. Google supplies basic account information only when you choose Google sign-in. We do not sell personal data.</p><h2>Your choices</h2><p>You may sign out, disable notifications, edit your profile, or contact us to request deletion of your account data.</p>`);
const termsPage = () => publicPage("Terms of Service", `<p>Last updated: August 25, 2026.</p><p>Use MHTalk lawfully and respectfully. Do not abuse rooms, harass others, distribute illegal material, evade moderation, or attempt to compromise the service or other users.</p><p>You are responsible for content you transmit. Network, device and third-party service conditions can affect call quality and availability. The service is provided as available, without removing rights that cannot legally be waived.</p><p>Accounts or access may be limited when necessary to protect users or the service.</p>`);
const oauthCompletePage = (request: Request) => {
  const incoming = new URL(request.url);
  const callback = new URL("mhtalk://auth/callback");
  for (const key of ["code", "error", "error_code", "error_description"]) {
    const value = incoming.searchParams.get(key);
    if (value) callback.searchParams.set(key, value);
  }
  const deepLink = JSON.stringify(callback.toString()).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign-in complete · MHTalk</title>
  <style>body{margin:0;background:#0c111b;color:#e8edf7;font:16px/1.6 system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}.card{max-width:520px;margin:24px;padding:36px;text-align:center;background:#151d2b;border:1px solid #34435d;border-radius:22px}.logo{width:64px;height:64px;margin:auto;display:grid;place-items:center;border-radius:18px;background:#715ce8;color:#fff;font-size:38px;font-weight:900}h1{color:#fff}p{color:#aab6c8}a{display:inline-block;border-radius:12px;padding:12px 18px;background:#715ce8;color:#fff;text-decoration:none;font-weight:700}.done{color:#65d99a}</style></head>
  <body><main class="card"><div class="logo">M</div><h1>Sign-in complete</h1><p id="status">Securely returning you to MHTalk…</p><a id="open" href=${deepLink}>Open MHTalk</a><p><small>You can safely close this browser tab after MHTalk opens.</small></p></main>
  <script>(()=>{const base=${deepLink};const allowed=['access_token','refresh_token','expires_in','token_type','type','error','error_code','error_description'];const incoming=new URLSearchParams(location.hash.replace(/^#/,''));const outgoing=new URLSearchParams();for(const key of allowed){const value=incoming.get(key);if(value)outgoing.set(key,value)}const target=outgoing.size?base+'#'+outgoing.toString():base;const open=document.getElementById('open');const status=document.getElementById('status');open.href=target;let launched=false;const launch=()=>{if(launched)return;launched=true;location.assign(target);setTimeout(()=>{status.textContent='MHTalk is open. You can close this tab.';status.className='done'},900)};open.addEventListener('click',()=>{launched=true});setTimeout(launch,120);})();</script></body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
};
const configured = (env: Env) => Boolean(env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY);
const supabaseUrl = (env: Env, path: string) => `${env.SUPABASE_URL!.replace(/\/$/, "")}${path}`;

async function digest(value: string) {
  return b64(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
async function rateLimited(request: Request, env: Env, action: string, identifier: string, maximum: number, seconds: number) {
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const key = await digest(`${action}:${ip}:${identifier.toLowerCase()}`);
  const hub = env.PRESENCE.get(env.PRESENCE.idFromName("global"));
  const response = await hub.fetch("https://internal/rate-limit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, maximum, seconds }),
  });
  if (!response.ok) return true;
  const payload = await response.json() as { limited?: unknown };
  return payload.limited === true;
}
async function publicAuthApi(env: Env, path: string, body: unknown) {
  return fetch(supabaseUrl(env, path), {
    method: "POST",
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY!, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function resolveLoginEmail(env: Env, identifier: string) {
  const normalized = identifier.trim().toLowerCase();
  if (normalized.includes("@")) return normalized;
  const response = await serviceApi(env, `/rest/v1/account_logins?username=eq.${encodeURIComponent(normalized)}&select=email&limit=1`);
  if (!response?.ok) return null;
  const values = (await response.json()) as { email?: string }[];
  return values[0]?.email || null;
}
async function usernameAvailable(env: Env, username: string) {
  if (usernameError(username)) return false;
  const response = await serviceApi(env, `/rest/v1/account_logins?username=eq.${encodeURIComponent(username.trim())}&select=user_id&limit=1`);
  if (!response?.ok) return false;
  return ((await response.json()) as unknown[]).length === 0;
}
async function accountLoginByEmail(env: Env, email: string) {
  const response = await serviceApi(env, `/rest/v1/account_logins?email=eq.${encodeURIComponent(email.trim().toLowerCase())}&select=*&limit=1`);
  if (!response?.ok) return null;
  return ((await response.json()) as AccountLogin[])[0] || null;
}
async function accountLoginByUser(env: Env, userId: string) {
  const response = await serviceApi(env, `/rest/v1/account_logins?user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`);
  if (!response?.ok) return null;
  return ((await response.json()) as AccountLogin[])[0] || null;
}
async function requireCompletedOnboarding(env: Env, user: AuthUser) {
  const login = await accountLoginByUser(env, user.id);
  if (!login) return json({ error: "Account profile is unavailable" }, 403);
  if (login.google_linked_at && (!login.creation_verified_at || !login.onboarding_completed_at))
    return json({ error: "Complete MHTalk account creation before continuing", code: "ONBOARDING_REQUIRED" }, 403);
  return null;
}
function jwtClaims(token: string) {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(new TextDecoder().decode(unb64(payload))) as { amr?: { method?: string; timestamp?: number }[] };
  } catch { return null; }
}
function hasRecentEmailOtp(token: string) {
  const cutoff = Math.floor(Date.now() / 1000) - 15 * 60;
  return jwtClaims(token)?.amr?.some((entry) =>
    (entry.method === "otp" || entry.method === "magiclink") && Number(entry.timestamp || 0) >= cutoff,
  ) === true;
}
async function handleAuth(request: Request, env: Env, path: string) {
  if (!configured(env) || !env.SUPABASE_SERVICE_ROLE_KEY)
    return json({ error: "Account service is unavailable" }, 503);

  if (path === "/auth/username-available" && request.method === "GET") {
    const username = new URL(request.url).searchParams.get("username")?.trim() || "";
    const validation = usernameError(username);
    if (validation) return json({ available: false, error: validation }, 400);
    if (await rateLimited(request, env, "username", username, 30, 300))
      return json({ error: "Too many requests. Try again shortly." }, 429);
    return json({ available: await usernameAvailable(env, username) });
  }

  if (path === "/auth/onboarding" && request.method === "GET") {
    const auth = await authenticate(request, env);
    if (auth instanceof Response) return auth;
    const [login, profile] = await Promise.all([accountLoginByUser(env, auth.id), profileFor(env, auth)]);
    if (!login || !profile) return json({ error: "Account profile is unavailable" }, 404);
    const required = Boolean(login.google_linked_at && (!login.creation_verified_at || !login.onboarding_completed_at));
    return json({
      required, email: auth.email || login.email, googleLinked: Boolean(login.google_linked_at),
      passwordEnabled: Boolean(login.password_enabled_at), creationVerified: Boolean(login.creation_verified_at),
      profile,
    });
  }

  if (request.method !== "POST") return json({ error: "Not found" }, 404);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: "Invalid request" }, 400);

  if (path === "/auth/onboarding/start") {
    const auth = await authenticate(request, env);
    if (auth instanceof Response) return auth;
    const login = await accountLoginByUser(env, auth.id);
    if (!login?.google_linked_at || !auth.email) return json({ error: "Google onboarding is not required" }, 409);
    if (login.creation_verified_at && login.onboarding_completed_at) return json({ complete: true });
    if (await rateLimited(request, env, "onboarding", auth.email, 5, 3600))
      return json({ error: "Too many codes requested. Try again later." }, 429);
    const response = await publicAuthApi(
      env,
      `/auth/v1/otp?redirect_to=${encodeURIComponent("mhtalk://auth/callback")}`,
      { email: auth.email, create_user: false },
    );
    if (!response.ok) return json({ error: "Could not send the account creation code" }, 502);
    return json({ sent: true });
  }

  if (path === "/auth/onboarding/complete") {
    const auth = await authenticate(request, env);
    if (auth instanceof Response) return auth;
    if (!hasRecentEmailOtp(auth.accessToken)) return json({ error: "Verify the account creation code before continuing" }, 403);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const avatarUrl = typeof body.avatarUrl === "string" ? body.avatarUrl.trim().slice(0, 1000) : null;
    const validation = usernameError(username) || (!displayName || displayName.length > 60 ? "Display name must be 1-60 characters" : null);
    if (validation) return json({ error: validation }, 400);
    const current = await accountLoginByUser(env, auth.id);
    if (!current?.google_linked_at) return json({ error: "Google account is not linked" }, 409);
    if (username.toLowerCase() !== current.username.toLowerCase() && !(await usernameAvailable(env, username)))
      return json({ error: "Username is unavailable" }, 409);
    const profileUpdate = await serviceApi(env, `/rest/v1/profiles?id=eq.${encodeURIComponent(auth.id)}`, {
      method: "PATCH", headers: { prefer: "return=minimal" },
      body: JSON.stringify({ username, display_name: displayName, avatar_url: avatarUrl, updated_at: new Date().toISOString() }),
    });
    if (!profileUpdate?.ok) return json({ error: "Could not save the account profile" }, 409);
    const loginUpdate = await serviceApi(env, `/rest/v1/account_logins?user_id=eq.${encodeURIComponent(auth.id)}`, {
      method: "PATCH", headers: { prefer: "return=minimal" },
      body: JSON.stringify({ username, creation_verified_at: new Date().toISOString(), onboarding_completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    });
    return loginUpdate?.ok ? json({ complete: true }) : json({ error: "Could not complete account creation" }, 500);
  }

  if (path === "/auth/password-enabled") {
    const auth = await authenticate(request, env);
    if (auth instanceof Response) return auth;
    const response = await serviceApi(env, `/rest/v1/account_logins?user_id=eq.${encodeURIComponent(auth.id)}`, {
      method: "PATCH", headers: { prefer: "return=minimal" },
      body: JSON.stringify({ password_enabled_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    });
    return response?.ok ? json({ enabled: true }) : json({ error: "Could not enable password sign-in" }, 500);
  }

  if (path === "/auth/login") {
    const identifier = typeof body.identifier === "string" ? body.identifier.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!identifier || !password) return json({ error: "Enter your username/email and password" }, 400);
    if (await rateLimited(request, env, "login", identifier, 12, 600))
      return json({ error: "Too many sign-in attempts. Try again in a few minutes." }, 429);
    const resolved = await resolveLoginEmail(env, identifier);
    const email = resolved || `missing-${await digest(identifier)}@invalid.mhtalk.local`;
    const response = await publicAuthApi(env, "/auth/v1/token?grant_type=password", { email, password });
    if (!response.ok) return json({ error: "Username/email or password is incorrect" }, 400);
    return new Response(await response.text(), { status: 200, headers });
  }

  if (path === "/auth/register") {
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const validation = usernameError(username) || emailError(email) || passwordError(password) ||
      (!displayName || displayName.length > 60 ? "Display name must be 1-60 characters" : null);
    if (validation) return json({ error: validation }, 400);
    if (await rateLimited(request, env, "register", email, 5, 3600))
      return json({ error: "Too many registration attempts. Try again later." }, 429);
    const existing = await accountLoginByEmail(env, email);
    if (existing) {
      if (!existing.google_linked_at && !existing.creation_verified_at) {
        await publicAuthApi(env, `/auth/v1/resend?redirect_to=${encodeURIComponent("mhtalk://auth/callback")}`, { type: "signup", email });
        return json({ verificationRequired: true, resumed: true });
      }
      return json({
        error: existing.google_linked_at && !existing.password_enabled_at
          ? "This email already belongs to an MHTalk account created with Google. Set a password to enable email login."
          : "This email is already used by an MHTalk account. Sign in or reset your password.",
        code: "ACCOUNT_EXISTS", googleLinked: Boolean(existing.google_linked_at),
        passwordEnabled: Boolean(existing.password_enabled_at), email,
      }, 409);
    }
    if (!(await usernameAvailable(env, username))) return json({ error: "Username is unavailable" }, 409);
    const signup: Record<string, unknown> = {
      email, password,
      data: { preferred_username: username, full_name: displayName, mhtalk_registration: true },
    };
    if (typeof body.codeChallenge === "string" && body.codeChallenge.length <= 128) {
      signup.code_challenge = body.codeChallenge;
      signup.code_challenge_method = "s256";
    }
    const response = await publicAuthApi(
      env,
      `/auth/v1/signup?redirect_to=${encodeURIComponent("mhtalk://auth/callback")}`,
      signup,
    );
    if (!response.ok) {
      const value = (await response.json().catch(() => null)) as { msg?: string; error_description?: string } | null;
      const detail = `${value?.msg || value?.error_description || ""}`.toLowerCase();
      if (detail.includes("username")) return json({ error: "Username is unavailable" }, 409);
      return json({ error: "An account may already exist. Try signing in or resetting your password." }, 400);
    }
    const value = (await response.json()) as { session?: unknown; access_token?: string };
    return json({ verificationRequired: !value.session && !value.access_token });
  }

  if (path === "/auth/forgot-password") {
    const identifier = typeof body.identifier === "string" ? body.identifier.trim() : "";
    if (!identifier) return json({ error: "Enter your username or email" }, 400);
    if (await rateLimited(request, env, "recover", identifier, 3, 3600))
      return json({ accepted: true });
    const resolved = await resolveLoginEmail(env, identifier);
    const email = resolved || `missing-${await digest(identifier)}@invalid.mhtalk.local`;
    const query = new URLSearchParams({ redirect_to: "mhtalk://auth/reset" });
    if (typeof body.codeChallenge === "string" && body.codeChallenge.length <= 128) {
      query.set("code_challenge", body.codeChallenge);
      query.set("code_challenge_method", "s256");
    }
    await publicAuthApi(env, `/auth/v1/recover?${query}`, { email });
    return json({ accepted: true });
  }

  if (path === "/auth/verify-recovery" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { identifier?: string; code?: string } | null;
    const identifier = body?.identifier?.trim() || "";
    const code = body?.code?.trim() || "";
    if (!identifier || !/^\d{6,8}$/.test(code)) return json({ error: "The recovery code is invalid or expired" }, 400);
    if (await rateLimited(request, env, "verify-recovery", identifier, 8, 900))
      return json({ error: "Too many attempts. Try again shortly." }, 429);
    const resolved = await resolveLoginEmail(env, identifier);
    const email = resolved || `missing-${await digest(identifier)}@invalid.mhtalk.local`;
    const response = await publicAuthApi(env, "/auth/v1/verify", { email, token: code, type: "recovery" });
    const value = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || typeof value.access_token !== "string" || typeof value.refresh_token !== "string")
      return json({ error: "The recovery code is invalid or expired" }, 400);
    return json(value);
  }

  return json({ error: "Not found" }, 404);
}

async function authenticate(request: Request, env: Env): Promise<AuthUser | Response> {
  if (!configured(env)) return json({ error: "Accounts are not configured yet" }, 503);
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return json({ error: "Sign in is required" }, 401);
  let response: Response;
  try {
    response = await fetch(supabaseUrl(env, "/auth/v1/user"), {
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY!, authorization },
    });
  } catch {
    return json({ error: "Account service is temporarily unavailable" }, 503);
  }
  if (response.status === 401 || response.status === 403)
    return json({ error: "Session is invalid or expired" }, 401);
  if (!response.ok) return json({ error: "Account service is temporarily unavailable" }, 503);
  const user = await response.json().catch(() => null) as {
    id?: string; email?: string; user_metadata?: Record<string, unknown>; app_metadata?: Record<string, unknown>;
  } | null;
  if (!user) return json({ error: "Account service returned an invalid response" }, 502);
  return user.id ? {
    id: user.id, email: user.email, userMetadata: user.user_metadata, appMetadata: user.app_metadata,
    accessToken: authorization.slice(7),
  } : json({ error: "Invalid account" }, 401);
}
async function optionalAuth(request: Request, env: Env): Promise<AuthUser | Response | null> {
  if (!configured(env)) return null;
  if (!request.headers.get("authorization") && env.AUTH_REQUIRED !== "true") return null;
  return authenticate(request, env);
}
async function userApi(env: Env, user: AuthUser, path: string, init: RequestInit = {}) {
  return fetch(supabaseUrl(env, path), {
    ...init,
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY!, authorization: `Bearer ${user.accessToken}`,
      "content-type": "application/json", ...(init.headers || {}),
    },
  });
}
async function serviceApi(env: Env, path: string, init: RequestInit = {}) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return fetch(supabaseUrl(env, path), {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json", ...(init.headers || {}),
    },
  });
}

async function membershipBackendRequest(url: string, init: RequestInit = {}) {
  let lastStatus = 503;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      lastStatus = response.status;
      const raw = await response.text();
      let payload: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        payload = null;
      }
      const retryable = response.status === 429 || response.status >= 500 || (response.ok && !payload);
      if (retryable && attempt === 0) continue;
      return { response, payload };
    } catch {
      if (attempt === 0) continue;
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    response: new Response(null, { status: lastStatus }),
    payload: null as Record<string, unknown> | null,
  };
}
async function proxyUserResponse(response: Response) {
  const body = await response.text();
  return new Response(body || (response.ok ? "{}" : '{"error":"Request failed"}'), { status: response.status, headers });
}
const rpc = (env: Env, user: AuthUser, name: string, body: unknown) => userApi(env, user, `/rest/v1/rpc/${name}`, {
  method: "POST", body: JSON.stringify(body),
});
async function profileFor(env: Env, user: AuthUser): Promise<Profile | null> {
  const path = `/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,username,display_name,avatar_url,bio,username_visible,username_changed_at,subscription_tier,subscription_expires_at&limit=1`;
  let response = await userApi(env, user, path);
  if (!response.ok) {
    // Keep older deployments operational while the subscription migration is
    // rolling out. Missing plan fields safely resolve to the Free tier.
    response = await userApi(
      env,
      user,
      `/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,username,display_name,avatar_url,bio,username_visible,username_changed_at&limit=1`,
    );
  }
  let profile = response.ok ? ((await response.json()) as Profile[])[0] || null : null;
  if (profile) return profile;

  // Repair accounts created while the social schema was unavailable, then retry.
  const repaired = await userApi(env, user, "/rest/v1/rpc/ensure_my_profile", {
    method: "POST", body: "{}",
  });
  if (!repaired.ok) return null;
  response = await userApi(env, user, path);
  if (!response.ok) {
    response = await userApi(
      env,
      user,
      `/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,username,display_name,avatar_url,bio,username_visible,username_changed_at&limit=1`,
    );
  }
  profile = response.ok ? ((await response.json()) as Profile[])[0] || null : null;
  return profile;
}

async function syncLavaSubscription(request: Request, env: Env, user: AuthUser) {
  const body = (await request.json().catch(() => null)) as { membershipToken?: unknown } | null;
  const membershipToken = typeof body?.membershipToken === "string" ? body.membershipToken.trim() : "";
  if (membershipToken.length < 24 || membershipToken.length > 512) return json({ error: "Invalid membership token" }, 400);
  const tokenFingerprint = await digest(`lava:${membershipToken}`);
  const bindingKey = `membership:lava:owner:${tokenFingerprint}`;
  const owner = await env.PRIVATE_ROOMS.get(bindingKey);
  if (owner && owner !== user.id) return json({ error: "This membership is already linked to another MHTalk account" }, 409);

  const backend = (env.LAVA_MEMBERSHIP_BACKEND_URL || "https://mvdownloader-lava-staging.mhlkotalk.workers.dev").replace(/\/$/, "");
  const { response: verification, payload: membershipPayload } = await membershipBackendRequest(`${backend}/v1/subscription-sessions/status`, {
    headers: { authorization: `Bearer ${membershipToken}`, accept: "application/json" },
  });
  const membership = (membershipPayload || {}) as {
    entitlementTier?: unknown;
    status?: unknown;
    expiry?: unknown;
    error?: unknown;
  };
  if (verification.status === 401) return json({ error: "Membership verification was rejected" }, 401);
  if (!verification.ok && verification.status !== 410) {
    return json({ error: "Membership verification is temporarily unavailable" }, 503);
  }

  await env.PRIVATE_ROOMS.put(bindingKey, user.id);
  const status = typeof membership.status === "string" ? membership.status.toLowerCase() : "pending";
  const active = status === "active" && typeof membership.entitlementTier === "string" && membership.entitlementTier !== "guest";
  const terminal = ["expired", "failed", "inactive", "disconnected", "revoked"].includes(status) || verification.status === 410;
  if (!active && !terminal) return json({ status, tier: "free", pending: true });

  const expiry = active && typeof membership.expiry === "string" && membership.expiry
    ? membership.expiry
    : null;
  const update = await serviceApi(env, `/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, {
    method: "PATCH",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({
      subscription_tier: active ? "plus" : "free",
      subscription_expires_at: expiry,
    }),
  });
  if (!update?.ok) return json({ error: "Could not update the MHTalk membership" }, 503);
  const profile = ((await update.json()) as Profile[])[0] || await profileFor(env, user);
  return json({ status, tier: active ? "plus" : "free", expiresAt: expiry, subscription: subscriptionFor(profile) });
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function b64(bytes: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function unb64(value: string) {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4)), (c) => c.charCodeAt(0));
}
async function signedInvite(roomName: string, secret: string) {
  const expiry = Math.floor(Date.now() / 1000) + 604800;
  const payload = `${roomName}.${expiry}`;
  return `${payload}.${b64(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload)))}`;
}
async function validInvite(roomName: string, invite: string, secret: string) {
  const dot = invite.lastIndexOf(".");
  const expiryDot = invite.lastIndexOf(".", dot - 1);
  if (dot < 1 || expiryDot < 1) return false;
  const payload = invite.slice(0, dot);
  const expiry = Number(invite.slice(expiryDot + 1, dot));
  return invite.slice(0, expiryDot) === roomName && Number.isSafeInteger(expiry) && expiry >= Date.now() / 1000 &&
    crypto.subtle.verify("HMAC", await hmacKey(secret), unb64(invite.slice(dot + 1)), encoder.encode(payload));
}

type RoomAccess = { roomName: string; userId: string; expiresAt: number };
type RtcUsageAccess = {
  roomName: string;
  provider: RtcProviderId;
  subject: string;
  expiresAt: number;
};

async function signedRoomAccess(roomName: string, userId: string, secret: string) {
  const access: RoomAccess = {
    roomName,
    userId,
    expiresAt: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
  };
  const payload = b64(encoder.encode(JSON.stringify(access)).buffer);
  const signature = b64(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload)));
  return `${payload}.${signature}`;
}

async function verifyRoomAccess(token: string, userId: string, secret: string): Promise<RoomAccess | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), (() => {
    try { return unb64(signature); } catch { return new Uint8Array(); }
  })(), encoder.encode(payload));
  if (!valid) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(unb64(payload))) as Partial<RoomAccess>;
    if (
      value.userId !== userId ||
      typeof value.roomName !== "string" ||
      !allowedRoom.test(value.roomName) ||
      !Number.isSafeInteger(value.expiresAt) ||
      Number(value.expiresAt) < Date.now() / 1000
    ) return null;
    return value as RoomAccess;
  } catch {
    return null;
  }
}

async function signedRtcUsageAccess(
  roomName: string,
  provider: RtcProviderId,
  subject: string,
  secret: string,
) {
  const access: RtcUsageAccess = {
    roomName,
    provider,
    subject,
    expiresAt: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
  };
  const payload = b64(encoder.encode(JSON.stringify(access)).buffer);
  const signature = b64(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload)));
  return `${payload}.${signature}`;
}

async function verifyRtcUsageAccess(token: string, secret: string): Promise<RtcUsageAccess | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), (() => {
    try { return unb64(signature); } catch { return new Uint8Array(); }
  })(), encoder.encode(payload));
  if (!valid) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(unb64(payload))) as Partial<RtcUsageAccess>;
    if (
      typeof value.roomName !== "string" ||
      !allowedRoom.test(value.roomName) ||
      !isRtcProvider(value.provider) ||
      typeof value.subject !== "string" ||
      value.subject.length < 8 ||
      !Number.isSafeInteger(value.expiresAt) ||
      Number(value.expiresAt) < Date.now() / 1000
    ) return null;
    return value as RtcUsageAccess;
  } catch {
    return null;
  }
}

async function roomPresenceCount(env: Env, roomName: string) {
  const hub = env.PRESENCE.get(env.PRESENCE.idFromName("global"));
  const response = await hub.fetch(`https://internal/room-count?room=${await digest(roomName)}`);
  if (!response.ok) throw new Error("Room presence service is unavailable");
  const payload = await response.json() as { count?: unknown };
  return Math.max(0, Number(payload.count) || 0);
}

async function handleRtcUsage(request: Request, env: Env) {
  const body = (await request.json().catch(() => null)) as {
    usageAccessToken?: unknown;
    reportId?: unknown;
    measuredFrom?: unknown;
    measuredTo?: unknown;
    leaving?: unknown;
  } | null;
  const token = typeof body?.usageAccessToken === "string" ? body.usageAccessToken : "";
  const access = await verifyRtcUsageAccess(token, env.INVITE_SIGNING_KEY);
  if (!access) return json({ error: "RTC usage token is invalid or expired" }, 401);
  const reportId = typeof body?.reportId === "string" ? body.reportId : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reportId)) {
    return json({ error: "Invalid RTC usage report" }, 400);
  }
  const measuredFrom = new Date(typeof body?.measuredFrom === "string" ? body.measuredFrom : "");
  const measuredTo = new Date(typeof body?.measuredTo === "string" ? body.measuredTo : "");
  const seconds = (measuredTo.getTime() - measuredFrom.getTime()) / 1000;
  const now = Date.now();
  if (
    !Number.isFinite(seconds) ||
    seconds < 10 ||
    seconds > 90 ||
    measuredTo.getTime() > now + 60_000 ||
    measuredTo.getTime() < now - 10 * 60_000
  ) return json({ error: "Invalid RTC usage window" }, 400);
  const usageWindow = Math.floor(measuredTo.getTime() / 60_000);
  const amount = usageAmount(access.provider, seconds);
  const cycle = monthlyUsageCycle(measuredTo);
  const ledger = env.PRESENCE.get(env.PRESENCE.idFromName("global"));
  return ledger.fetch("https://internal/rtc-usage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reportId,
      provider: access.provider,
      room: await digest(access.roomName),
      subject: await digest(access.subject),
      billingRoom: await digest(`${access.roomName}:${access.subject}`),
      usageWindow,
      leaving: body?.leaving === true,
      cycleStart: cycle.start,
      cycleEnd: cycle.end,
      measuredFrom: measuredFrom.toISOString(),
      measuredTo: measuredTo.toISOString(),
      amount,
    }),
  });
}

type ProviderHealthSnapshot = {
  provider: string;
  enabled: boolean;
  used_percent: number | string;
  state: string;
};

async function syncProviderHealth(
  env: Env,
  overrides: Partial<Record<RtcProviderId, { usedPercent?: number; disabled?: boolean }>> = {},
) {
  const response = await serviceApi(env, "/rest/v1/rpc/rtc_provider_health_snapshot", {
    method: "POST",
    body: "{}",
  });
  if (!response?.ok) return;
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) return;
  const snapshots = payload as ProviderHealthSnapshot[];
  const sharedUpdates: Partial<Record<RtcProviderId, { usedPercent?: number; disabled?: boolean }>> = {};
  await Promise.all(snapshots.filter((item) => isRtcProvider(item.provider)).map(async (item) => {
    const provider = item.provider as RtcProviderId;
    const override = overrides[provider];
    // Cloudflare has a dedicated Durable Object egress guard. Supabase remains
    // the administrative enable switch, but must not overwrite its fresher,
    // fail-closed usage telemetry with a stale provider snapshot.
    if (provider === "cloudflare-realtime" || provider === "jaas") {
      const key = `routing:health:rtc:${provider}`;
      const current = await env.PRIVATE_ROOMS.get(key, "json") as {
        usedPercent?: number;
        disabled?: boolean;
        updatedAt?: string;
      } | null;
      const disabled = override?.disabled ?? !item.enabled;
      if (!current || current.disabled !== disabled) {
        await updateProviderHealth(env, provider, {
          usedPercent: current ? Number(current.usedPercent) || 0 : provider === "cloudflare-realtime" ? 60 : 76,
          disabled,
        });
      }
      return;
    }
    sharedUpdates[provider] = {
      usedPercent: override?.usedPercent ?? (Number(item.used_percent) || 0),
      disabled: override?.disabled ?? (!item.enabled || ["disabled", "stale", "exhausted"].includes(item.state)),
    };
  }));
  await updateProviderHealthBatch(env, { ...sharedUpdates, ...overrides });
}

async function applyProviderSafetyPolicies(env: Env) {
  validateProviderSafetyPolicies();
  const updatedAt = new Date().toISOString();
  const updatedProviders: string[] = [];
  for (const [provider, policy] of Object.entries(databaseProviderSafetyPolicies)) {
    const response = await serviceApi(
      env,
      `/rest/v1/rtc_provider_policies?provider=eq.${encodeURIComponent(provider)}`,
      {
        method: "PATCH",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({ ...policy, updated_at: updatedAt }),
      },
    );
    if (!response?.ok) {
      const detail = response ? (await response.text().catch(() => "")).slice(0, 500) : "service unavailable";
      throw new Error(`Could not harden ${provider} provider policy (${response?.status || 503}): ${detail}`);
    }
    updatedProviders.push(provider);
  }
  return updatedProviders;
}

async function setWherebyProviderEnabled(env: Env, enabled: boolean) {
  if (enabled) {
    await applyProviderSafetyPolicies(env);
    await smokeWhereby(env);
  }
  const response = await serviceApi(env, "/rest/v1/rtc_provider_policies?provider=eq.whereby", {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ enabled, updated_at: new Date().toISOString() }),
  });
  if (!response?.ok) throw new Error("Whereby provider state could not be changed");
  await syncProviderHealth(env);
  return (await rtcCapabilities(env)).find((item) => item.provider === "whereby");
}

async function probeMiroTalkHealth(env: Env) {
  if (!env.MIROTALK_BASE_URL) return 75;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const healthUrl = new URL("/api/v1/health", env.MIROTALK_BASE_URL);
    if (healthUrl.protocol !== "https:") throw new Error("MiroTalk health URL must use HTTPS");
    const response = await fetch(healthUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    return response.ok ? 0 : 75;
  } catch {
    return 75;
  } finally {
    clearTimeout(timeout);
  }
}

const attachmentBucket = "mhtalk-room-attachments";
type AttachmentRecord = {
  id: string;
  room_name: string;
  owner_user_id: string;
  object_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  status: "pending" | "ready";
  created_at: string;
  expires_at: string;
};

function safeAttachmentName(value: string) {
  const normalized = value.normalize("NFKC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 120);
  return normalized || "Attachment";
}

function safeAttachmentMime(value: string) {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)
    ? normalized.slice(0, 120)
    : "application/octet-stream";
}

function storageObjectPath(value: string) {
  return value.split("/").map(encodeURIComponent).join("/");
}

async function storageApi(env: Env, path: string, init: RequestInit = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/storage/v1${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
}

async function attachmentRecord(env: Env, id: string) {
  const response = await serviceApi(
    env,
    `/rest/v1/room_attachments?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
  );
  if (!response?.ok) return null;
  return ((await response.json()) as AttachmentRecord[])[0] || null;
}

async function deleteStoredAttachment(env: Env, record: Pick<AttachmentRecord, "id" | "object_path">) {
  await storageApi(env, `/object/${attachmentBucket}`, {
    method: "DELETE",
    body: JSON.stringify({ prefixes: [record.object_path] }),
  });
  await serviceApi(env, `/rest/v1/room_attachments?id=eq.${encodeURIComponent(record.id)}`, { method: "DELETE" });
}

async function handleAttachments(request: Request, env: Env, path: string, user: AuthUser) {
  const body = (await request.json().catch(() => null)) as {
    roomAccessToken?: unknown;
    attachmentId?: unknown;
    fileName?: unknown;
    mimeType?: unknown;
    size?: unknown;
  } | null;
  const roomAccessToken = typeof body?.roomAccessToken === "string" ? body.roomAccessToken : "";
  const access = await verifyRoomAccess(roomAccessToken, user.id, env.INVITE_SIGNING_KEY);
  if (!access) return json({ error: "Room access expired. Rejoin the room and try again." }, 401);

  if (path === "/attachments/upload-ticket" && request.method === "POST") {
    if (await rateLimited(request, env, "attachment-upload", user.id, 30, 60 * 60)) {
      return json({ error: "Too many attachment uploads. Try again later." }, 429);
    }
    const fileName = safeAttachmentName(typeof body?.fileName === "string" ? body.fileName : "Attachment");
    const mimeType = safeAttachmentMime(typeof body?.mimeType === "string" ? body.mimeType : "");
    const size = Number(body?.size);
    const profile = await profileFor(env, user);
    const subscription = subscriptionFor(profile);
    if (!Number.isSafeInteger(size) || size < 1) return json({ error: "Attachment size is invalid" }, 400);
    if (size > subscription.entitlements.maxAttachmentBytes) {
      return json({ error: `This plan allows attachments up to ${subscription.entitlements.maxAttachmentBytes} bytes` }, 413);
    }
    if (/\.(exe|msi|msix|bat|cmd|com|scr|ps1|apk|aab|jar|sh|vbs|reg|dll|dmg|deb|rpm|appimage|ipa)$/i.test(fileName)) {
      return json({ error: "Executable attachments are not allowed" }, 415);
    }
    if (["text/html", "image/svg+xml", "application/xhtml+xml", "text/javascript", "application/javascript"].includes(mimeType)) {
      return json({ error: "Active web content is not allowed as an attachment" }, 415);
    }
    const id = crypto.randomUUID();
    const objectPath = `${user.id}/${id}/${fileName}`;
    const expiresAt = new Date(Date.now() + subscription.entitlements.attachmentRetentionHours * 60 * 60 * 1000).toISOString();
    const inserted = await serviceApi(env, "/rest/v1/room_attachments", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        id,
        room_name: access.roomName,
        owner_user_id: user.id,
        object_path: objectPath,
        file_name: fileName,
        mime_type: mimeType,
        size_bytes: size,
        expires_at: expiresAt,
      }),
    });
    if (!inserted?.ok) return json({ error: "Attachment service is temporarily unavailable" }, 503);
    const signed = await storageApi(env, `/object/upload/sign/${attachmentBucket}/${storageObjectPath(objectPath)}`, {
      method: "POST",
      body: "{}",
    });
    if (!signed?.ok) {
      await serviceApi(env, `/rest/v1/room_attachments?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      return json({ error: "Could not prepare the attachment upload" }, 503);
    }
    const upload = await signed.json() as { url?: string };
    if (!upload.url) {
      await serviceApi(env, `/rest/v1/room_attachments?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      return json({ error: "Attachment storage returned an invalid upload URL" }, 502);
    }
    return json({
      attachmentId: id,
      uploadUrl: `${env.SUPABASE_URL!.replace(/\/$/, "")}/storage/v1${upload.url}`,
      fileName,
      mimeType,
      size,
      expiresAt,
    });
  }

  const attachmentId = typeof body?.attachmentId === "string" ? body.attachmentId : "";
  const record = await attachmentRecord(env, attachmentId);
  if (!record || record.room_name !== access.roomName) return json({ error: "Attachment is unavailable" }, 404);

  if (path === "/attachments/complete" && request.method === "POST") {
    if (record.owner_user_id !== user.id) return json({ error: "Forbidden" }, 403);
    const infoResponse = await storageApi(env, `/object/info/${attachmentBucket}/${storageObjectPath(record.object_path)}`);
    if (!infoResponse?.ok) return json({ error: "The attachment upload did not complete" }, 409);
    const info = await infoResponse.json() as { size?: unknown; metadata?: { size?: unknown } };
    const actualSize = Number(info.size ?? info.metadata?.size);
    if (!Number.isSafeInteger(actualSize) || actualSize !== Number(record.size_bytes)) {
      await deleteStoredAttachment(env, record);
      return json({ error: "Uploaded attachment size does not match the declared size" }, 409);
    }
    const updated = await serviceApi(env, `/rest/v1/room_attachments?id=eq.${encodeURIComponent(record.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "ready" }),
    });
    if (!updated?.ok) return json({ error: "Could not finalize the attachment" }, 503);
    return json({
      attachmentId: record.id,
      fileName: record.file_name,
      mimeType: record.mime_type,
      size: Number(record.size_bytes),
      expiresAt: record.expires_at,
    });
  }

  if (path === "/attachments/download-ticket" && request.method === "POST") {
    if (record.status !== "ready" || Date.parse(record.expires_at) <= Date.now()) {
      return json({ error: "Attachment expired" }, 410);
    }
    const signed = await storageApi(env, `/object/sign/${attachmentBucket}/${storageObjectPath(record.object_path)}`, {
      method: "POST",
      body: JSON.stringify({ expiresIn: 2 * 60 * 60 }),
    });
    if (!signed?.ok) return json({ error: "Could not prepare the attachment download" }, 503);
    const value = await signed.json() as { signedURL?: string };
    if (!value.signedURL) return json({ error: "Attachment storage returned an invalid download URL" }, 502);
    return json({
      attachmentId: record.id,
      downloadUrl: `${env.SUPABASE_URL!.replace(/\/$/, "")}/storage/v1${value.signedURL}`,
      fileName: record.file_name,
      mimeType: record.mime_type,
      size: Number(record.size_bytes),
      expiresAt: record.expires_at,
    });
  }

  if (path === "/attachments/delete" && request.method === "POST") {
    if (record.owner_user_id !== user.id) return json({ error: "Forbidden" }, 403);
    await deleteStoredAttachment(env, record);
    return json({ deleted: true });
  }

  return json({ error: "Not found" }, 404);
}

async function cleanupExpiredAttachments(env: Env) {
  const response = await serviceApi(
    env,
    `/rest/v1/room_attachments?expires_at=lt.${encodeURIComponent(new Date().toISOString())}&select=id,object_path&limit=100`,
  );
  if (!response?.ok) return;
  const records = await response.json() as Pick<AttachmentRecord, "id" | "object_path">[];
  for (const record of records) await deleteStoredAttachment(env, record);
}
function shortCode() {
  return `MHTALK-${[...crypto.getRandomValues(new Uint8Array(5))].map((n) => alphabet[n % alphabet.length]).join("")}`;
}
async function createPrivateRoom(env: Env) {
  const roomName = `Private-${crypto.randomUUID().replaceAll("-", "")}`;
  const invite = await signedInvite(roomName, env.INVITE_SIGNING_KEY);
  const registry = env.PRESENCE.get(env.PRESENCE.idFromName("global"));
  const response = await registry.fetch("https://presence.internal/private-room/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomName, invite }),
  });
  if (!response.ok) throw new Error("Private room registry is unavailable");
  const { code } = await response.json() as { code?: string };
  if (!code) throw new Error("Private room registry returned an invalid code");
  return { roomName, code };
}

async function resolvePrivateRoom(env: Env, code: string) {
  const registry = env.PRESENCE.get(env.PRESENCE.idFromName("global"));
  const response = await registry.fetch(
    `https://presence.internal/private-room/resolve?code=${encodeURIComponent(code)}`,
  );
  if (response.ok) return response.json() as Promise<{ roomName: string; invite: string }>;
  // Preserve codes created by the previous KV implementation until their
  // seven-day TTL expires. New codes never write to KV.
  const legacy = await env.PRIVATE_ROOMS.get(code);
  return legacy ? JSON.parse(legacy) as { roomName: string; invite: string } : null;
}
async function issueToken(roomName: string, env: Env, user: AuthUser | null, profile: Profile | null) {
  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: user?.id || crypto.randomUUID(), name: profile?.display_name || profile?.username,
    metadata: profile ? JSON.stringify({
      avatar: profile.avatar_url,
      ...(profile.username_visible ? { username: profile.username } : {}),
      usernameVisible: profile.username_visible,
    }) : undefined, ttl: "10m",
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canUpdateOwnMetadata: true,
  });
  return token.toJwt();
}

async function issueStreamToken(env: Env, user: AuthUser | null) {
  if (!env.STREAM_API_KEY || !env.STREAM_API_SECRET) {
    throw new Error("Stream is not configured");
  }
  const identity = user?.id || `guest-${crypto.randomUUID()}`;
  const serverClient = new StreamClient(env.STREAM_API_KEY, env.STREAM_API_SECRET);
  return serverClient.generateUserToken({
    user_id: identity,
    validity_in_seconds: 6 * 60 * 60,
  });
}

type AgoraCredentials = {
  token: string;
  identity: string;
  screenToken: string;
  screenIdentity: string;
};

function issueAgoraCredentials(
  roomName: string,
  env: Env,
  user: AuthUser | null,
): AgoraCredentials {
  if (!env.AGORA_APP_ID || !env.AGORA_APP_CERTIFICATE) {
    throw new Error("Agora is not configured");
  }
  const identity = user?.id || `guest-${crypto.randomUUID()}`;
  const screenIdentity = `${identity}:screen`;
  const tokenLifetimeSeconds = 60 * 60;
  const create = (account: string) => RtcTokenBuilder.buildTokenWithUserAccount(
    env.AGORA_APP_ID!,
    env.AGORA_APP_CERTIFICATE!,
    roomName,
    account,
    RtcRole.PUBLISHER,
    tokenLifetimeSeconds,
    tokenLifetimeSeconds,
  );
  return {
    token: create(identity),
    identity,
    screenToken: create(screenIdentity),
    screenIdentity,
  };
}

type TencentCredentials = {
  token: string;
  identity: string;
};

function tencentIdentity(user: AuthUser | null) {
  const normalized = (user?.id || crypto.randomUUID())
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .replaceAll("-", "")
    .slice(0, 32);
  return normalized || crypto.randomUUID().replaceAll("-", "");
}

async function issueTencentCredentials(env: Env, user: AuthUser | null): Promise<TencentCredentials> {
  const sdkAppId = Number(env.TENCENT_SDK_APP_ID);
  if (!Number.isSafeInteger(sdkAppId) || sdkAppId <= 0 || !env.TENCENT_SECRET_KEY) {
    throw new Error("Tencent RTC is not configured");
  }
  const identity = tencentIdentity(user);
  return {
    token: await generateTencentUserSig(sdkAppId, identity, env.TENCENT_SECRET_KEY),
    identity,
  };
}

async function issueCloudflareCredentials(
  request: Request,
  env: Env,
  roomName: string,
  user: AuthUser | null,
) {
  if (!env.CLOUDFLARE_REALTIME_APP_ID || !env.CLOUDFLARE_REALTIME_API_TOKEN) {
    throw new Error("Cloudflare Realtime is not configured");
  }
  const identity = user?.id || `guest-${crypto.randomUUID()}`;
  const ticket = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const roomKey = await digest(`cloudflare-rtc-room:${roomName}`);
  await env.PRIVATE_ROOMS.put(
    `rtc:cloudflare:ticket:${ticket}`,
    JSON.stringify({ identity, roomKey }),
    { expirationTtl: 90 },
  );
  return {
    token: ticket,
    identity,
    serverUrl: `${new URL(request.url).origin}/rtc/cloudflare`,
  };
}

type WherebyRoom = {
  meetingId?: string;
  roomUrl?: string;
  endDate?: string;
};

async function wherebyRequest(env: Env, path: string, init: RequestInit = {}) {
  if (!env.WHEREBY_API_KEY) throw new Error("Whereby is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    return await fetch(`https://api.whereby.dev/v1${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${env.WHEREBY_API_KEY}`,
        "content-type": "application/json",
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function createWherebyRoom(env: Env, endDate: string) {
  const response = await wherebyRequest(env, "/meetings", {
    method: "POST",
    body: JSON.stringify({
      endDate,
      isLocked: false,
      roomMode: "group",
      roomNamePrefix: "mhtalk-",
      roomNamePattern: "uuid",
    }),
  });
  if (!response.ok) throw new Error(`Whereby room service returned ${response.status}`);
  const room = await response.json() as WherebyRoom;
  if (!room.meetingId || !room.roomUrl) throw new Error("Whereby returned an invalid room");
  const roomUrl = new URL(room.roomUrl);
  if (roomUrl.protocol !== "https:") throw new Error("Whereby returned an insecure room URL");
  return { ...room, endDate: room.endDate || endDate } as Required<WherebyRoom>;
}

async function ensureWherebyRoom(env: Env, roomName: string) {
  const cacheKey = `routing:whereby:room:${await digest(roomName)}`;
  const cached = await env.PRIVATE_ROOMS.get(cacheKey, "json") as WherebyRoom | null;
  if (cached?.meetingId && cached.roomUrl && cached.endDate && new Date(cached.endDate).getTime() > Date.now() + 60_000) {
    return cached as Required<WherebyRoom>;
  }

  const endDate = new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString();
  const room = await createWherebyRoom(env, endDate);
  await env.PRIVATE_ROOMS.put(cacheKey, JSON.stringify(room), { expirationTtl: 2 * 60 * 60 });
  return room;
}

async function issueWherebyCredentials(env: Env, roomName: string) {
  const room = await ensureWherebyRoom(env, roomName);
  return { token: room.meetingId, roomUrl: room.roomUrl };
}

async function smokeWhereby(env: Env) {
  const endDate = new Date(Date.now() + 15 * 60 * 1_000).toISOString();
  let meetingId = "";
  try {
    const room = await createWherebyRoom(env, endDate);
    meetingId = room.meetingId;
    const read = await wherebyRequest(env, `/meetings/${encodeURIComponent(meetingId)}`);
    if (!read.ok) throw new Error(`Whereby meeting verification returned ${read.status}`);
    const verified = await read.json() as WherebyRoom;
    if (verified.meetingId !== meetingId || !verified.roomUrl) {
      throw new Error("Whereby meeting verification returned invalid data");
    }
    return { created: true, verified: true };
  } finally {
    if (meetingId) {
      const removed = await wherebyRequest(env, `/meetings/${encodeURIComponent(meetingId)}`, { method: "DELETE" });
      if (!removed.ok) throw new Error(`Whereby meeting cleanup returned ${removed.status}`);
    }
  }
}

type DailyRoom = { name?: string; url?: string };

async function dailyRequest(env: Env, path: string, init: RequestInit = {}) {
  if (!env.DAILY_API_KEY) throw new Error("Daily is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    return await fetch(`https://api.daily.co/v1${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${env.DAILY_API_KEY}`,
        "content-type": "application/json",
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function dailyRoomName(roomName: string) {
  return `mhtalk-${(await digest(`daily-room:${roomName}`)).slice(0, 40)}`;
}

async function ensureDailyRoom(env: Env, roomName: string) {
  const cacheKey = `routing:daily:room:${await digest(roomName)}`;
  const cached = await env.PRIVATE_ROOMS.get(cacheKey, "json") as DailyRoom | null;
  if (cached?.name && cached.url) return cached as Required<DailyRoom>;

  const name = await dailyRoomName(roomName);
  let response = await dailyRequest(env, `/rooms/${encodeURIComponent(name)}`);
  if (response.status === 404) {
    response = await dailyRequest(env, "/rooms", {
      method: "POST",
      body: JSON.stringify({
        name,
        privacy: "private",
        properties: {
          enable_chat: true,
          enable_screenshare: true,
          start_video_off: true,
          start_audio_off: false,
          enable_people_ui: true,
          enable_network_ui: true,
          enable_prejoin_ui: false,
          enable_noise_cancellation_ui: true,
        },
      }),
    });
    if (response.status === 400 || response.status === 409)
      response = await dailyRequest(env, `/rooms/${encodeURIComponent(name)}`);
  }
  if (!response.ok) throw new Error(`Daily room service returned ${response.status}`);
  const room = await response.json() as DailyRoom;
  if (!room.name || !room.url) throw new Error("Daily returned an invalid room");
  await env.PRIVATE_ROOMS.put(cacheKey, JSON.stringify(room), { expirationTtl: 86_400 });
  return room as Required<DailyRoom>;
}

async function issueDailyCredentials(
  roomName: string,
  env: Env,
  user: AuthUser | null,
  profile: Profile | null,
) {
  const room = await ensureDailyRoom(env, roomName);
  const expires = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
  const response = await dailyRequest(env, "/meeting-tokens", {
    method: "POST",
    body: JSON.stringify({
      properties: {
        room_name: room.name,
        user_id: (user?.id || crypto.randomUUID()).slice(0, 36),
        user_name: (profile?.display_name || profile?.username || "MHTalk member").slice(0, 60),
        exp: expires,
        eject_at_token_exp: true,
        start_video_off: true,
        start_audio_off: false,
        enable_screenshare: true,
      },
    }),
  });
  if (!response.ok) throw new Error(`Daily token service returned ${response.status}`);
  const payload = await response.json() as { token?: string };
  if (!payload.token) throw new Error("Daily returned an invalid meeting token");
  return { token: payload.token, roomUrl: room.url };
}

let googleAccessToken: { token: string; expiresAt: number } | null = null;
async function firebaseAccessToken(env: Env) {
  if (googleAccessToken && googleAccessToken.expiresAt > Date.now() + 60_000) return googleAccessToken.token;
  if (!env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) return null;
  const now = Math.floor(Date.now() / 1000);
  const jwtHeader = b64(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })).buffer);
  const jwtBody = b64(encoder.encode(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })).buffer);
  const pem = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n").replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const privateKey = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const unsigned = `${jwtHeader}.${jwtBody}`;
  const assertion = `${unsigned}.${b64(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, encoder.encode(unsigned)))}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!response.ok) return null;
  const value = (await response.json()) as { access_token: string; expires_in: number };
  googleAccessToken = { token: value.access_token, expiresAt: Date.now() + value.expires_in * 1000 };
  return value.access_token;
}
async function notifyOffline(env: Env, targetId: string, inviteId: string, sender: Profile | null) {
  if (!env.FIREBASE_PROJECT_ID || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  const devices = await serviceApi(env, `/rest/v1/device_tokens?user_id=eq.${encodeURIComponent(targetId)}&select=token`);
  if (!devices?.ok) return;
  const accessToken = await firebaseAccessToken(env);
  if (!accessToken) return;
  const tokens = (await devices.json()) as { token: string }[];
  await Promise.allSettled(tokens.map(({ token }) => fetch(`https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`, {
    method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ message: {
      token, notification: { title: "MHTalk invitation", body: `${sender?.display_name || sender?.username || "A friend"} invited you to a room` },
      data: { type: "room_invite", inviteId, deepLink: `mhtalk://invite/${inviteId}` },
      android: { priority: "high", notification: { channel_id: "mhtalk_invites" } },
    } }),
  })));
}

async function handleSocial(request: Request, env: Env, path: string, user: AuthUser) {
  if (path === "/social/me" && request.method === "GET") {
    const profile = await profileFor(env, user);
    return profile ? json(profile) : json({ error: "Profile is unavailable" }, 404);
  }
  if (path === "/social/profile" && request.method === "PATCH") {
    const body = (await request.json().catch(() => null)) as Partial<Profile> | null;
    const current = await profileFor(env, user);
    if (!current) return json({ error: "Profile is unavailable" }, 404);
    const requestedUsername = typeof body?.username === "string" ? body.username.trim() : undefined;
    if (requestedUsername !== undefined) {
      const validation = usernameError(requestedUsername);
      if (validation) return json({ error: validation }, 400);
      if (requestedUsername.toLowerCase() !== current.username.toLowerCase() && !(await usernameAvailable(env, requestedUsername)))
        return json({ error: "Username is unavailable" }, 409);
    }
    const update = {
      username: requestedUsername,
      display_name: typeof body?.display_name === "string" ? body.display_name.trim().slice(0, 60) : undefined,
      avatar_url: typeof body?.avatar_url === "string" ? body.avatar_url.slice(0, 1000) : undefined,
      bio: typeof body?.bio === "string" ? body.bio.slice(0, 160) : undefined,
      username_visible: typeof body?.username_visible === "boolean" ? body.username_visible : undefined,
      updated_at: new Date().toISOString(),
    };
    return proxyUserResponse(await userApi(env, user, `/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, {
      method: "PATCH", headers: { prefer: "return=representation" }, body: JSON.stringify(update),
    }));
  }
  if (path === "/social/friends" && request.method === "GET") return proxyUserResponse(await rpc(env, user, "social_friends", {}));
  if (path === "/social/requests" && request.method === "GET") return proxyUserResponse(await rpc(env, user, "social_friend_requests", {}));
  if (path === "/social/search" && request.method === "GET") {
    const query = new URL(request.url).searchParams.get("q")?.trim().slice(0, 60) || "";
    return proxyUserResponse(await rpc(env, user, "search_profiles", { search_text: query }));
  }
  if (path === "/social/friend-request" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { targetId?: string } | null;
    const response = await rpc(env, user, "send_friend_request", { target_profile: body?.targetId });
    if (response.ok && body?.targetId) {
      try {
        const hub = env.PRESENCE.get(env.PRESENCE.idFromName("global"));
        await hub.fetch("https://presence.internal/deliver", {
          method: "POST",
          body: JSON.stringify({
            targetId: body.targetId,
            event: { type: "friend_request", senderId: user.id },
          }),
        });
      } catch {
        // The request is already stored; focus/startup refresh remains the fallback.
      }
    }
    return proxyUserResponse(response);
  }
  if (path === "/social/friend-response" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { requestId?: string; accept?: boolean } | null;
    return proxyUserResponse(await rpc(env, user, "respond_friend_request", { request_id: body?.requestId, accept_request: body?.accept === true }));
  }
  if (path === "/social/friend-remove" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { friendId?: string } | null;
    return proxyUserResponse(await rpc(env, user, "remove_friend", { friend_profile: body?.friendId }));
  }
  if (path === "/social/block" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { targetId?: string } | null;
    return proxyUserResponse(await rpc(env, user, "block_profile", { target_profile: body?.targetId }));
  }
  if (path === "/social/device-token" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { token?: string; platform?: string } | null;
    if (!body?.token || body.token.length > 4096) return json({ error: "Invalid device token" }, 400);
    return proxyUserResponse(await userApi(env, user, "/rest/v1/device_tokens?on_conflict=token", {
      method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ user_id: user.id, token: body.token, platform: body.platform || "unknown" }),
    }));
  }
  if (path === "/presence/ticket" && request.method === "POST") {
    const ticket = await signPresenceTicket(user.id, env.INVITE_SIGNING_KEY);
    return json({ ticket });
  }
  if (path === "/social/invite" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { targetId?: string; roomName?: string; inviteCode?: string; private?: boolean } | null;
    if (!body?.targetId || body.targetId === user.id) return json({ error: "Invalid friend" }, 400);
    const friendship = await rpc(env, user, "are_friends", { other_profile: body.targetId });
    if (!friendship.ok || (await friendship.json()) !== true) return json({ error: "Only friends can receive invitations" }, 403);
    const privateRoom = body.private ? await createPrivateRoom(env) : null;
    const inviteClaims = {
      senderId: user.id,
      targetId: body.targetId,
      roomName: privateRoom?.roomName || body.roomName || "Main",
      inviteCode: privateRoom?.code || body.inviteCode || null,
      createdAt: new Date().toISOString(),
    };
    const inviteId = await signSocialInvite(inviteClaims, env.INVITE_SIGNING_KEY);
    const payload = { id: inviteId, ...inviteClaims };
    const hub = env.PRESENCE.get(env.PRESENCE.idFromName("global"));
    const delivered = await hub.fetch("https://presence.internal/deliver", { method: "POST", body: JSON.stringify({
      targetId: body.targetId, event: { type: "invite", invite: payload },
    }) });
    const sender = await profileFor(env, user);
    if (!(await delivered.json() as { delivered: boolean }).delivered) await notifyOffline(env, body.targetId, inviteId, sender);
    return json(payload);
  }
  if (path.startsWith("/social/invite/") && request.method === "GET") {
    const inviteId = path.slice("/social/invite/".length);
    const invite = await verifySocialInvite(inviteId, env.INVITE_SIGNING_KEY);
    if (!invite) {
      // Invitations issued by the immediately previous Worker build remain
      // usable for their original ten-minute lifetime.
      const legacy = await env.PRIVATE_ROOMS.get(`social-invite:${inviteId}`);
      if (!legacy) return json({ error: "Invitation expired" }, 404);
      const payload = JSON.parse(legacy) as { targetId?: string };
      return payload.targetId === user.id ? json(payload) : json({ error: "Forbidden" }, 403);
    }
    return invite.targetId === user.id
      ? json({ id: inviteId, senderId: invite.senderId, targetId: invite.targetId,
          roomName: invite.roomName, inviteCode: invite.inviteCode, createdAt: invite.createdAt })
      : json({ error: "Forbidden" }, 403);
  }
  return json({ error: "Not found" }, 404);
}

type RtcLedgerState = {
  windows: Record<string, number>;
  presence: Record<string, { room: string; expiresAt: number }>;
};

type PrivateRoomRecord = {
  roomName: string;
  invite: string;
  expiresAt: number;
};

export class PresenceHub implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/room-presence" && request.method === "POST") {
      const body = await request.json() as { room: string; subject: string };
      const ledger = await this.rtcLedger();
      ledger.presence[body.subject] = { room: body.room, expiresAt: Date.now() + 2 * 60_000 };
      await this.state.storage.put("rtc-ledger", ledger);
      return json({ accepted: true });
    }
    if (path === "/private-room/create" && request.method === "POST") {
      const body = await request.json() as { roomName?: string; invite?: string };
      if (!body.roomName || !body.invite) return json({ error: "Invalid private room" }, 400);
      let code = shortCode();
      while (await this.state.storage.get(`private-room:${code}`)) code = shortCode();
      const record: PrivateRoomRecord = {
        roomName: body.roomName,
        invite: body.invite,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1_000,
      };
      await this.state.storage.put(`private-room:${code}`, record);
      await this.schedulePrivateRoomCleanup(record.expiresAt);
      return json({ code });
    }
    if (path === "/private-room/resolve" && request.method === "GET") {
      const code = url.searchParams.get("code")?.toUpperCase() || "";
      if (!/^MHTALK-[A-Z0-9]{5}$/.test(code)) return json({ error: "Invalid private code" }, 400);
      const key = `private-room:${code}`;
      const record = await this.state.storage.get<PrivateRoomRecord>(key);
      if (!record) return json({ error: "Private code not found" }, 404);
      if (record.expiresAt <= Date.now()) {
        await this.state.storage.delete(key);
        return json({ error: "Private code expired" }, 404);
      }
      return json({ roomName: record.roomName, invite: record.invite });
    }
    if (path === "/rate-limit" && request.method === "POST") {
      const body = await request.json() as { key: string; maximum: number; seconds: number };
      const now = Date.now();
      const rates = await this.state.storage.get<Record<string, { count: number; expiresAt: number }>>("rate-limits") || {};
      for (const [key, entry] of Object.entries(rates)) {
        if (entry.expiresAt <= now) delete rates[key];
      }
      const current = rates[body.key];
      const limited = Boolean(current && current.count >= body.maximum);
      if (!limited) {
        rates[body.key] = {
          count: (current?.count || 0) + 1,
          expiresAt: current?.expiresAt || now + body.seconds * 1_000,
        };
      }
      await this.state.storage.put("rate-limits", rates);
      return json({ limited });
    }
    if (path === "/room-count" && request.method === "GET") {
      const ledger = await this.rtcLedger();
      const room = url.searchParams.get("room") || "";
      const count = Object.values(ledger.presence).filter((entry) => entry.room === room).length;
      await this.state.storage.put("rtc-ledger", ledger);
      return json({ count });
    }
    if (path === "/rtc-usage" && request.method === "POST") {
      const body = await request.json() as {
        reportId: string;
        provider: RtcProviderId;
        room: string;
        subject: string;
        billingRoom: string;
        usageWindow: number;
        leaving: boolean;
        cycleStart: string;
        cycleEnd: string;
        measuredFrom: string;
        measuredTo: string;
        amount: number | null;
      };
      const ledger = await this.rtcLedger();
      if (body.leaving) delete ledger.presence[body.subject];
      else ledger.presence[body.subject] = { room: body.room, expiresAt: Date.now() + 2 * 60_000 };
      if (body.amount === null) {
        await this.state.storage.put("rtc-ledger", ledger);
        return json({ accepted: true, metering: "provider" });
      }
      const windowKey = `${body.provider}:${body.subject}:${body.usageWindow}`;
      if (ledger.windows[windowKey]) {
        await this.state.storage.put("rtc-ledger", ledger);
        return json({ accepted: true, recorded: false, duplicateWindow: true });
      }
      ledger.windows[windowKey] = Date.now() + 10 * 60_000;
      await this.state.storage.put("rtc-ledger", ledger);
      const response = await serviceApi(this.env, "/rest/v1/rpc/record_rtc_provider_usage", {
        method: "POST",
        body: JSON.stringify({
          p_report_id: body.reportId,
          p_provider: body.provider,
          p_cycle_start: body.cycleStart,
          p_cycle_end: body.cycleEnd,
          p_room_hash: body.billingRoom,
          p_source: "worker",
          p_measured_from: body.measuredFrom,
          p_measured_to: body.measuredTo,
          p_amount: body.amount,
        }),
      });
      if (!response?.ok) {
        delete ledger.windows[windowKey];
        await this.state.storage.put("rtc-ledger", ledger);
        return json({ error: "RTC usage service is unavailable" }, 503);
      }
      const recorded = await response.json().catch(() => false);
      return json({ accepted: true, recorded: recorded === true });
    }
    if (path === "/deliver" && request.method === "POST") {
      const body = (await request.json()) as { targetId: string; event: unknown };
      let delivered = false;
      for (const socket of this.state.getWebSockets()) {
        if ((socket.deserializeAttachment() as { userId?: string } | null)?.userId === body.targetId) {
          socket.send(JSON.stringify(body.event)); delivered = true;
        }
      }
      return json({ delivered });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
    const userId = request.headers.get("x-mhtalk-user-id");
    if (!userId) return new Response("Unauthorized", { status: 401 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ userId, friendIds: [] });
    this.broadcastPresence(userId, true);
    return new Response(null, { status: 101, webSocket: client });
  }
  async alarm() {
    const now = Date.now();
    const rooms = await this.state.storage.list<PrivateRoomRecord>({ prefix: "private-room:" });
    const expired: string[] = [];
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const [key, room] of rooms) {
      if (room.expiresAt <= now) expired.push(key);
      else nextExpiry = Math.min(nextExpiry, room.expiresAt);
    }
    if (expired.length) await this.state.storage.delete(expired);
    if (Number.isFinite(nextExpiry)) await this.state.storage.setAlarm(nextExpiry);
  }
  private async schedulePrivateRoomCleanup(expiresAt: number) {
    const scheduled = await this.state.storage.getAlarm();
    if (scheduled === null || expiresAt < scheduled) await this.state.storage.setAlarm(expiresAt);
  }
  private async rtcLedger(): Promise<RtcLedgerState> {
    const now = Date.now();
    const stored = await this.state.storage.get<RtcLedgerState>("rtc-ledger");
    const ledger: RtcLedgerState = stored || { windows: {}, presence: {} };
    for (const [key, expiresAt] of Object.entries(ledger.windows)) {
      if (expiresAt <= now) delete ledger.windows[key];
    }
    for (const [key, entry] of Object.entries(ledger.presence)) {
      if (entry.expiresAt <= now) delete ledger.presence[key];
    }
    return ledger;
  }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    try {
      const value = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)) as { type?: string; friendIds?: string[] };
      if (value.type !== "watch" || !Array.isArray(value.friendIds)) return;
      const attachment = socket.deserializeAttachment() as { userId: string; friendIds: string[] };
      const friendIds = [...new Set(value.friendIds.filter((id) => typeof id === "string").slice(0, 500))];
      socket.serializeAttachment({ ...attachment, friendIds });
      const onlineUsers = new Set(this.state.getWebSockets().map((item) => (item.deserializeAttachment() as { userId?: string } | null)?.userId));
      socket.send(JSON.stringify({ type: "presence_snapshot", online: friendIds.filter((id) => onlineUsers.has(id)) }));
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "Invalid presence message" }));
    }
  }
  webSocketClose(socket: WebSocket, code: number, reason: string) {
    const userId = (socket.deserializeAttachment() as { userId?: string } | null)?.userId;
    socket.close(code, reason);
    if (userId && !this.state.getWebSockets().some((item) => item !== socket && (item.deserializeAttachment() as { userId?: string } | null)?.userId === userId))
      this.broadcastPresence(userId, false);
  }
  webSocketError(socket: WebSocket) { this.webSocketClose(socket, 1011, "Presence connection error"); }
  private broadcastPresence(userId: string, online: boolean) {
    const payload = JSON.stringify({ type: "presence", userId, online });
    for (const socket of this.state.getWebSockets()) {
      if ((socket.deserializeAttachment() as { friendIds?: string[] } | null)?.friendIds?.includes(userId)) socket.send(payload);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET" && path === "/") return homePage();
    if (request.method === "GET" && path === "/privacy") return privacyPage();
    if (request.method === "GET" && path === "/terms") return termsPage();
    if (request.method === "GET" && path === "/auth/complete") return oauthCompletePage(request);
    if (request.method === "GET" && path === "/service/capabilities") return json(await serviceCapabilities(env));
    if (request.method === "GET" && path.startsWith("/rtc/embed/")) {
      const response = await handleManagedRtcEmbed(request, env, path.slice("/rtc/embed/".length));
      return response || json({ error: "Not found" }, 404);
    }
    if (path === "/service/provider-policies/harden" && request.method === "POST") {
      if (!routingAdminAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
      try {
        const providers = await applyProviderSafetyPolicies(env);
        return json({ hardened: true, providers });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unknown provider policy error";
        return json({ error: "Provider safety policies could not be applied", detail }, 503);
      }
    }
    if (path === "/service/providers/whereby/smoke" && request.method === "POST") {
      if (!routingAdminAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
      try {
        return json({ provider: "whereby", ...(await smokeWhereby(env)), cleanedUp: true });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unknown Whereby error";
        return json({ error: "Whereby smoke test failed", detail }, 503);
      }
    }
    if ((path === "/service/providers/whereby/enable" || path === "/service/providers/whereby/disable") && request.method === "POST") {
      if (!routingAdminAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
      const enabled = path.endsWith("/enable");
      try {
        const capability = await setWherebyProviderEnabled(env, enabled);
        return json({ provider: "whereby", enabled, capability });
      } catch {
        return json({ error: `Whereby could not be ${enabled ? "enabled" : "disabled"}` }, 503);
      }
    }
    if (path === "/service/provider-health" && request.method === "POST") {
      if (!routingAdminAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
      const body = (await request.json().catch(() => null)) as { provider?: unknown; usedPercent?: unknown; disabled?: unknown } | null;
      if (!isRtcProvider(body?.provider)) return json({ error: "Invalid provider" }, 400);
      if (body?.usedPercent !== undefined && (typeof body.usedPercent !== "number" || !Number.isFinite(body.usedPercent))) {
        return json({ error: "Invalid usage percentage" }, 400);
      }
      const health = await updateProviderHealth(env, body.provider, {
        usedPercent: typeof body.usedPercent === "number" ? body.usedPercent : undefined,
        disabled: typeof body.disabled === "boolean" ? body.disabled : undefined,
      });
      return json({ provider: body.provider, ...health });
    }
    if (request.method === "OPTIONS") return new Response(null, { headers });
    if (path === "/rtc/cloudflare/room" && request.method === "GET") {
      const ticket = url.searchParams.get("ticket") || "";
      const key = `rtc:cloudflare:ticket:${ticket}`;
      const value = await env.PRIVATE_ROOMS.get(key, "json") as { identity?: string; roomKey?: string } | null;
      if (!value?.identity || !value.roomKey) return json({ error: "RTC ticket is invalid or expired" }, 401);
      await env.PRIVATE_ROOMS.delete(key);
      const room = env.CLOUDFLARE_RTC_ROOMS.get(env.CLOUDFLARE_RTC_ROOMS.idFromName(value.roomKey));
      const forwarded = new Request(request, { headers: new Headers(request.headers) });
      forwarded.headers.set("x-mhtalk-user-id", value.identity);
      return room.fetch(forwarded);
    }
    if (path.startsWith("/rtc/cloudflare/partytracks")) {
      const auth = await authenticate(request, env);
      if (auth instanceof Response) return auth;
      const onboarding = await requireCompletedOnboarding(env, auth);
      if (onboarding) return onboarding;
      if (await rateLimited(request, env, "cloudflare-rtc-api", auth.id, 600, 60)) {
        return json({ error: "Too many RTC negotiation requests" }, 429);
      }
      return proxyCloudflareRtc(request, env);
    }
    if (path.startsWith("/auth/")) return handleAuth(request, env, path);
    if (path === "/presence" && request.method === "GET") {
      const ticket = url.searchParams.get("ticket") || "";
      const presenceTicket = await verifyPresenceTicket(ticket, env.INVITE_SIGNING_KEY);
      if (!presenceTicket) return json({ error: "Presence ticket is invalid or expired" }, 401);
      const hub = env.PRESENCE.get(env.PRESENCE.idFromName("global"));
      const forwarded = new Request(request, { headers: new Headers(request.headers) });
      forwarded.headers.set("x-mhtalk-user-id", presenceTicket.userId);
      return hub.fetch(forwarded);
    }
    if (path.startsWith("/social/") || path === "/presence/ticket") {
      const auth = await authenticate(request, env);
      if (auth instanceof Response) return auth;
      const onboarding = await requireCompletedOnboarding(env, auth);
      return onboarding || handleSocial(request, env, path, auth);
    }
    if (path.startsWith("/attachments/")) {
      const auth = await authenticate(request, env);
      if (auth instanceof Response) return auth;
      const onboarding = await requireCompletedOnboarding(env, auth);
      return onboarding || handleAttachments(request, env, path, auth);
    }
    if (path === "/subscription/lava/sync" && request.method === "POST") {
      const auth = await authenticate(request, env);
      if (auth instanceof Response) return auth;
      const onboarding = await requireCompletedOnboarding(env, auth);
      return onboarding || syncLavaSubscription(request, env, auth);
    }
    if (path === "/subscription/lava/start" && request.method === "POST") {
      const auth = await authenticate(request, env);
      if (auth instanceof Response) return auth;
      const onboarding = await requireCompletedOnboarding(env, auth);
      if (onboarding) return onboarding;
      const body = (await request.json().catch(() => null)) as { planId?: unknown } | null;
      const planId = typeof body?.planId === "string" ? body.planId : "";
      if (!["plus", "pro", "ultimate", "max_supporter"].includes(planId)) return json({ error: "Invalid membership plan" }, 400);
      const backend = (env.LAVA_MEMBERSHIP_BACKEND_URL || "https://mvdownloader-lava-staging.mhlkotalk.workers.dev").replace(/\/$/, "");
      const { response, payload } = await membershipBackendRequest(`${backend}/v1/subscription-sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      if (!payload) return json({ error: "Membership service is temporarily unavailable. Please try again." }, 503);
      if (response.ok && typeof payload.subscriptionUrl === "string") {
        try {
          const subscriptionUrl = new URL(payload.subscriptionUrl);
          subscriptionUrl.searchParams.set("app", "mhtalk");
          payload.subscriptionUrl = subscriptionUrl.toString();
        } catch {
          return json({ error: "Membership service returned an invalid checkout link." }, 503);
        }
      }
      if (response.ok && typeof payload.desktopToken === "string") {
        const fingerprint = await digest(`lava:${payload.desktopToken}`);
        await env.PRIVATE_ROOMS.put(`membership:lava:owner:${fingerprint}`, auth.id);
      }
      return json(payload, response.status);
    }
    if (request.method !== "POST") return json({ error: "Not found" }, 404);
    if (path === "/rtc/usage") return handleRtcUsage(request, env);
    if (path === "/moderate") {
      const body = (await request.json().catch(() => null)) as { text?: unknown; roomName?: unknown } | null;
      if (body?.roomName !== "Main" || typeof body.text !== "string") return json({ error: "Invalid moderation request" }, 400);
      if (body.text.length > 8000) return json({ error: "Message is too long" }, 413);
      return json(moderateMainMessage(body.text));
    }
    if (path === "/moderation/report") {
      const body = (await request.json().catch(() => null)) as { roomName?: unknown; reporterIdentity?: unknown; targetIdentity?: unknown; messageId?: unknown; content?: unknown } | null;
      if (typeof body?.roomName !== "string" || typeof body.targetIdentity !== "string") return json({ error: "Invalid report" }, 400);
      const auth = await optionalAuth(request, env);
      if (auth instanceof Response) return auth;
      await env.PRIVATE_ROOMS.put(`report:${Date.now()}:${crypto.randomUUID()}`, JSON.stringify({
        createdAt: new Date().toISOString(), roomName: body.roomName.slice(0, 100), reporterIdentity: auth?.id || body.reporterIdentity || "anonymous",
        targetIdentity: body.targetIdentity.slice(0, 100), messageId: typeof body.messageId === "string" ? body.messageId.slice(0, 100) : null,
        content: typeof body.content === "string" ? body.content.slice(0, 2000) : null,
      }), { expirationTtl: 2592000 });
      return json({ accepted: true });
    }
    if (path === "/room-count") {
      const body = (await request.json().catch(() => null)) as { roomName?: unknown } | null;
      if (body?.roomName !== "Main") return json({ error: "Only the Main room count is public" }, 400);
      try { return json({ count: await roomPresenceCount(env, "Main") }); }
      catch { return json({ error: "Room count unavailable" }, 503); }
    }
    if (path === "/private-room") {
      const auth = await optionalAuth(request, env);
      if (auth instanceof Response) return auth;
      if (auth) {
        const onboarding = await requireCompletedOnboarding(env, auth);
        if (onboarding) return onboarding;
      }
      return json(await createPrivateRoom(env));
    }
    if (path !== "/livekit/token") return json({ error: "Not found" }, 404);
    const auth = await optionalAuth(request, env);
    if (auth instanceof Response) return auth;
    if (auth) {
      const onboarding = await requireCompletedOnboarding(env, auth);
      if (onboarding) return onboarding;
    }
    const body = (await request.json().catch(() => null)) as {
      roomName?: unknown;
      inviteCode?: unknown;
      capabilitiesVersion?: unknown;
      supportedRtcProviders?: unknown;
      supportedMessagingProviders?: unknown;
      supportedFileProviders?: unknown;
      excludedRtcProviders?: unknown;
    } | null;
    let roomName = typeof body?.roomName === "string" ? body.roomName.trim() : "";
    roomName = roomName === "Main room" || roomName === "Main channel" ? "Main" : roomName;
    if (typeof body?.inviteCode === "string") {
      const privateRoom = await resolvePrivateRoom(env, body.inviteCode.toUpperCase());
      if (!privateRoom) return json({ error: "Private code is invalid or expired" }, 403);
      if (!(await validInvite(privateRoom.roomName, privateRoom.invite, env.INVITE_SIGNING_KEY))) return json({ error: "Private code is invalid" }, 403);
      roomName = privateRoom.roomName;
    }
    if (!allowedRoom.test(roomName)) return json({ error: "Invalid room name" }, 400);
    if (roomName !== "Main" && typeof body?.inviteCode !== "string") return json({ error: "Private code required" }, 403);
    if (await rateLimited(request, env, "room-token", auth?.id || "guest", 30, 60)) {
      return json({ error: "Too many room connection attempts. Try again shortly." }, 429);
    }
    const profile = auth ? await profileFor(env, auth) : null;
    const declaredCapabilities = body?.capabilitiesVersion === 2;
    const supportedMessagingProviders = parseProviderCapabilities<MessagingProviderId>(
      body?.supportedMessagingProviders,
      knownMessagingProviders,
    );
    const supportedFileProviders = parseProviderCapabilities<FileProviderId>(
      body?.supportedFileProviders,
      knownFileProviders,
    );
    const supportedProviders = parseRtcProviders(body?.supportedRtcProviders).filter((provider) =>
      !declaredCapabilities || routingIsSupported(provider, supportedMessagingProviders, supportedFileProviders)
    );
    if (declaredCapabilities && supportedProviders.length === 0) {
      return json({
        error: "This app build does not support a complete realtime, messaging and file route",
        code: "CLIENT_CAPABILITY_MISMATCH",
      }, 409);
    }
    const excludedProviders = Array.isArray(body?.excludedRtcProviders)
      ? [...new Set(body.excludedRtcProviders.map((value) => String(value).toLowerCase()).filter(isRtcProvider))]
      : [];
    let selected = await selectRtcProvider(env, roomName, supportedProviders, excludedProviders);
    let providerToken = "";
    let providerUrl: string | undefined;
    let providerIdentity: string | undefined;
    let screenToken: string | undefined;
    let screenIdentity: string | undefined;
    while (selected) {
      try {
        if (selected.provider === "daily") {
          const daily = await issueDailyCredentials(roomName, env, auth, profile);
          providerToken = daily.token;
          providerUrl = daily.roomUrl;
        } else if (selected.provider === "stream") {
          providerToken = await issueStreamToken(env, auth);
          providerIdentity = auth?.id;
        } else if (selected.provider === "agora") {
          const agora = issueAgoraCredentials(roomName, env, auth);
          providerToken = agora.token;
          providerIdentity = agora.identity;
          screenToken = agora.screenToken;
          screenIdentity = agora.screenIdentity;
        } else if (selected.provider === "tencent") {
          const tencent = await issueTencentCredentials(env, auth);
          providerToken = tencent.token;
          providerIdentity = tencent.identity;
        } else if (selected.provider === "cloudflare-realtime") {
          const cloudflare = await issueCloudflareCredentials(request, env, roomName, auth);
          providerToken = cloudflare.token;
          providerIdentity = cloudflare.identity;
          providerUrl = cloudflare.serverUrl;
        } else if (selected.provider === "whereby") {
          const whereby = await issueWherebyCredentials(env, roomName);
          providerToken = whereby.token;
          providerUrl = whereby.roomUrl;
        } else if (isManagedRtcProvider(selected.provider)) {
          const managed = await issueManagedRtcCredentials(request, env, selected.provider, roomName, auth, profile);
          providerToken = managed.token;
          providerIdentity = managed.identity;
          providerUrl = managed.serverUrl;
        } else {
          providerToken = await issueToken(roomName, env, auth, profile);
          providerIdentity = auth?.id;
        }
        break;
      } catch {
        excludedProviders.push(selected.provider);
        selected = await selectRtcProvider(env, roomName, supportedProviders, excludedProviders);
      }
    }
    if (!selected || !providerToken) {
      return json({
        error: "All compatible realtime providers are temporarily unavailable",
        code: "RTC_CAPACITY_UNAVAILABLE",
        retryAfterSeconds: 20,
      }, 503);
    }
    const routing = serviceRouting(env, profile, selected.provider, providerUrl);
    const attachmentAccessToken = auth
      ? await signedRoomAccess(roomName, auth.id, env.INVITE_SIGNING_KEY)
      : undefined;
    const usageSubject = auth?.id || await digest(`${request.headers.get("cf-connecting-ip") || "local"}:${request.headers.get("user-agent") || "unknown"}`);
    const usageAccessToken = await signedRtcUsageAccess(
      roomName,
      selected.provider,
      usageSubject,
      env.INVITE_SIGNING_KEY,
    );
    const presence = env.PRESENCE.get(env.PRESENCE.idFromName("global"));
    await presence.fetch("https://internal/room-presence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room: await digest(roomName), subject: await digest(usageSubject) }),
    });
    return json({
      capabilitiesVersion: 2,
      token: providerToken,
      ...(providerIdentity ? { identity: providerIdentity } : {}),
      ...(screenToken ? { screenToken } : {}),
      ...(screenIdentity ? { screenIdentity } : {}),
      roomName,
      ...(attachmentAccessToken ? { attachmentAccessToken } : {}),
      usageAccessToken,
      provider: routing.rtc.provider,
      serverUrl: routing.rtc.serverUrl,
      routing,
      subscription: routing.subscription,
    });
    } catch (error) {
      const path = new URL(request.url).pathname;
      console.error("Unhandled MHTalk service error", {
        path,
        method: request.method,
        message: error instanceof Error ? error.message : "unknown",
      });
      return json({
        error: "MHTalk service is temporarily unavailable. Please try again.",
        code: "SERVICE_TEMPORARILY_UNAVAILABLE",
      }, 503);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env) {
    const usage = env.CLOUDFLARE_RTC_USAGE.get(
      env.CLOUDFLARE_RTC_USAGE.idFromName("account-egress"),
    );
    const jaasQuota = env.JAAS_QUOTA.get(env.JAAS_QUOTA.idFromName(jaasQuotaObjectName));
    // Refresh dedicated quota state before applying shared administrative
    // switches so stale provider snapshots cannot replace authoritative usage.
    const [, , mirotalkUsedPercent] = await Promise.all([
      usage.fetch("https://internal/usage/refresh", { method: "POST" }),
      jaasQuota.fetch("https://internal/refresh", { method: "POST" }),
      probeMiroTalkHealth(env),
    ]);
    await syncProviderHealth(env, { mirotalk: { usedPercent: mirotalkUsedPercent } });
    await cleanupExpiredAttachments(env);
  },
};
