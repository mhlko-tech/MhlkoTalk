import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { moderateMainMessage } from "../../src/core/moderation";
import { emailError, passwordError, usernameError } from "../../src/core/authRules";

export interface Env {
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;
  LIVEKIT_URL: string;
  INVITE_SIGNING_KEY: string;
  PRIVATE_ROOMS: KVNamespace;
  PRESENCE: DurableObjectNamespace;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  AUTH_REQUIRED?: string;
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
}

type AuthUser = { id: string; accessToken: string; email?: string; userMetadata?: Record<string, unknown>; appMetadata?: Record<string, unknown> };
type Profile = { id: string; username: string; display_name: string; avatar_url: string | null; bio?: string | null };
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
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers });
const publicPage = (title: string, body: string) => new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · MHTalk</title><style>body{margin:0;background:#0c111b;color:#e8edf7;font:16px/1.65 system-ui,sans-serif}main{max-width:780px;margin:auto;padding:56px 24px}h1,h2{color:#fff}a{color:#73b7ff}.card{background:#151d2b;border:1px solid #263348;border-radius:18px;padding:28px}small{color:#9aa8bc}</style></head>
<body><main><div class="card"><h1>${title}</h1>${body}<p><a href="/">MHTalk home</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p><small>Contact: 3084346hlko@gmail.com</small></div></main></body></html>`, {
  headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" },
});
const homePage = () => publicPage("MHTalk", `<p>MHTalk is a voice, video, screen-sharing and social rooms app for Android and Windows.</p><p>Sign in securely with your username or email and password, or continue with Google, to keep your profile and friends available across your devices.</p>`);
const privacyPage = () => publicPage("Privacy Policy", `<p>Last updated: August 26, 2026.</p><h2>Data we use</h2><p>When you create or use an account, MHTalk stores your account identifier, username, email address, profile name and picture, friend relationships, blocks, and notification device tokens. Supabase hosts this account data and Cloudflare routes authenticated requests. Passwords are processed and hashed by Supabase Auth and are never stored by MHTalk.</p><h2>Calls and files</h2><p>LiveKit carries live voice, camera and screen sharing. Chat attachments and live media are not stored by the MHTalk account backend. Room invitations and presence data are temporary.</p><h2>Purpose and sharing</h2><p>We use this data only to provide authentication, account recovery, profiles, friends, presence, room invitations and notifications. Google supplies basic account information only when you choose Google sign-in. We do not sell personal data.</p><h2>Your choices</h2><p>You may sign out, disable notifications, edit your profile, or contact us to request deletion of your account data.</p>`);
const termsPage = () => publicPage("Terms of Service", `<p>Last updated: August 25, 2026.</p><p>Use MHTalk lawfully and respectfully. Do not abuse rooms, harass others, distribute illegal material, evade moderation, or attempt to compromise the service or other users.</p><p>You are responsible for content you transmit. Network, device and third-party service conditions can affect call quality and availability. The service is provided as available, without removing rights that cannot legally be waived.</p><p>Accounts or access may be limited when necessary to protect users or the service.</p>`);
const configured = (env: Env) => Boolean(env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY);
const supabaseUrl = (env: Env, path: string) => `${env.SUPABASE_URL!.replace(/\/$/, "")}${path}`;

async function digest(value: string) {
  return b64(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
async function rateLimited(request: Request, env: Env, action: string, identifier: string, maximum: number, seconds: number) {
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const key = `rate:${action}:${await digest(`${ip}:${identifier.toLowerCase()}`)}`;
  const current = Number(await env.PRIVATE_ROOMS.get(key) || "0");
  if (current >= maximum) return true;
  await env.PRIVATE_ROOMS.put(key, String(current + 1), { expirationTtl: seconds });
  return false;
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

  return json({ error: "Not found" }, 404);
}

async function authenticate(request: Request, env: Env): Promise<AuthUser | Response> {
  if (!configured(env)) return json({ error: "Accounts are not configured yet" }, 503);
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return json({ error: "Sign in is required" }, 401);
  const response = await fetch(supabaseUrl(env, "/auth/v1/user"), {
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY!, authorization },
  });
  if (!response.ok) return json({ error: "Session is invalid or expired" }, 401);
  const user = (await response.json()) as { id?: string; email?: string; user_metadata?: Record<string, unknown>; app_metadata?: Record<string, unknown> };
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
async function proxyUserResponse(response: Response) {
  const body = await response.text();
  return new Response(body || (response.ok ? "{}" : '{"error":"Request failed"}'), { status: response.status, headers });
}
const rpc = (env: Env, user: AuthUser, name: string, body: unknown) => userApi(env, user, `/rest/v1/rpc/${name}`, {
  method: "POST", body: JSON.stringify(body),
});
async function profileFor(env: Env, user: AuthUser): Promise<Profile | null> {
  const path = `/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,username,display_name,avatar_url,bio&limit=1`;
  let response = await userApi(env, user, path);
  let profile = response.ok ? ((await response.json()) as Profile[])[0] || null : null;
  if (profile) return profile;

  // Repair accounts created while the social schema was unavailable, then retry.
  const repaired = await userApi(env, user, "/rest/v1/rpc/ensure_my_profile", {
    method: "POST", body: "{}",
  });
  if (!repaired.ok) return null;
  response = await userApi(env, user, path);
  profile = response.ok ? ((await response.json()) as Profile[])[0] || null : null;
  return profile;
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
function shortCode() {
  return `MHTALK-${[...crypto.getRandomValues(new Uint8Array(5))].map((n) => alphabet[n % alphabet.length]).join("")}`;
}
async function createPrivateRoom(env: Env) {
  const roomName = `Private-${crypto.randomUUID().replaceAll("-", "")}`;
  const invite = await signedInvite(roomName, env.INVITE_SIGNING_KEY);
  let code = shortCode();
  while (await env.PRIVATE_ROOMS.get(code)) code = shortCode();
  await env.PRIVATE_ROOMS.put(code, JSON.stringify({ roomName, invite }), { expirationTtl: 604800 });
  return { roomName, code };
}
async function issueToken(roomName: string, env: Env, user: AuthUser | null) {
  const profile = user ? await profileFor(env, user) : null;
  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: user?.id || crypto.randomUUID(), name: profile?.display_name || profile?.username,
    metadata: profile ? JSON.stringify({ avatar: profile.avatar_url, username: profile.username }) : undefined, ttl: "10m",
  });
  token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  return token.toJwt();
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
    const update = {
      username: typeof body?.username === "string" ? body.username.trim().slice(0, 32) : undefined,
      display_name: typeof body?.display_name === "string" ? body.display_name.trim().slice(0, 60) : undefined,
      avatar_url: typeof body?.avatar_url === "string" ? body.avatar_url.slice(0, 1000) : undefined,
      bio: typeof body?.bio === "string" ? body.bio.slice(0, 160) : undefined, updated_at: new Date().toISOString(),
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
    return proxyUserResponse(await rpc(env, user, "send_friend_request", { target_profile: body?.targetId }));
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
    const ticket = crypto.randomUUID();
    await env.PRIVATE_ROOMS.put(`presence-ticket:${ticket}`, user.id, { expirationTtl: 60 });
    return json({ ticket });
  }
  if (path === "/social/invite" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { targetId?: string; roomName?: string; inviteCode?: string; private?: boolean } | null;
    if (!body?.targetId || body.targetId === user.id) return json({ error: "Invalid friend" }, 400);
    const friendship = await rpc(env, user, "are_friends", { other_profile: body.targetId });
    if (!friendship.ok || (await friendship.json()) !== true) return json({ error: "Only friends can receive invitations" }, 403);
    const privateRoom = body.private ? await createPrivateRoom(env) : null;
    const inviteId = crypto.randomUUID();
    const payload = { id: inviteId, senderId: user.id, targetId: body.targetId,
      roomName: privateRoom?.roomName || body.roomName || "Main", inviteCode: privateRoom?.code || body.inviteCode || null,
      createdAt: new Date().toISOString() };
    await env.PRIVATE_ROOMS.put(`social-invite:${inviteId}`, JSON.stringify(payload), { expirationTtl: 600 });
    const hub = env.PRESENCE.get(env.PRESENCE.idFromName("global"));
    const delivered = await hub.fetch("https://presence.internal/deliver", { method: "POST", body: JSON.stringify({
      targetId: body.targetId, event: { type: "invite", invite: payload },
    }) });
    const sender = await profileFor(env, user);
    if (!(await delivered.json() as { delivered: boolean }).delivered) await notifyOffline(env, body.targetId, inviteId, sender);
    return json(payload);
  }
  if (path.startsWith("/social/invite/") && request.method === "GET") {
    const stored = await env.PRIVATE_ROOMS.get(`social-invite:${path.slice("/social/invite/".length)}`);
    if (!stored) return json({ error: "Invitation expired" }, 404);
    const invite = JSON.parse(stored) as { targetId: string };
    return invite.targetId === user.id ? json(invite) : json({ error: "Forbidden" }, 403);
  }
  return json({ error: "Not found" }, 404);
}

export class PresenceHub implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
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
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET" && path === "/") return homePage();
    if (request.method === "GET" && path === "/privacy") return privacyPage();
    if (request.method === "GET" && path === "/terms") return termsPage();
    if (request.method === "OPTIONS") return new Response(null, { headers });
    if (path.startsWith("/auth/")) return handleAuth(request, env, path);
    if (path === "/presence" && request.method === "GET") {
      const ticket = url.searchParams.get("ticket") || "";
      const userId = await env.PRIVATE_ROOMS.get(`presence-ticket:${ticket}`);
      if (!userId) return json({ error: "Presence ticket is invalid or expired" }, 401);
      await env.PRIVATE_ROOMS.delete(`presence-ticket:${ticket}`);
      const hub = env.PRESENCE.get(env.PRESENCE.idFromName("global"));
      const forwarded = new Request(request, { headers: new Headers(request.headers) });
      forwarded.headers.set("x-mhtalk-user-id", userId);
      return hub.fetch(forwarded);
    }
    if (path.startsWith("/social/") || path === "/presence/ticket") {
      const auth = await authenticate(request, env);
      if (auth instanceof Response) return auth;
      const onboarding = await requireCompletedOnboarding(env, auth);
      return onboarding || handleSocial(request, env, path, auth);
    }
    if (request.method !== "POST") return json({ error: "Not found" }, 404);
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
      try {
        const rooms = new RoomServiceClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
        return json({ count: (await rooms.listParticipants("Main")).length });
      } catch { return json({ error: "Room count unavailable" }, 503); }
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
    const body = (await request.json().catch(() => null)) as { roomName?: unknown; inviteCode?: unknown } | null;
    let roomName = typeof body?.roomName === "string" ? body.roomName.trim() : "";
    roomName = roomName === "Main room" || roomName === "Main channel" ? "Main" : roomName;
    if (typeof body?.inviteCode === "string") {
      const stored = await env.PRIVATE_ROOMS.get(body.inviteCode.toUpperCase());
      if (!stored) return json({ error: "Private code is invalid or expired" }, 403);
      const privateRoom = JSON.parse(stored) as { roomName: string; invite: string };
      if (!(await validInvite(privateRoom.roomName, privateRoom.invite, env.INVITE_SIGNING_KEY))) return json({ error: "Private code is invalid" }, 403);
      roomName = privateRoom.roomName;
    }
    if (!allowedRoom.test(roomName)) return json({ error: "Invalid room name" }, 400);
    if (roomName !== "Main" && typeof body?.inviteCode !== "string") return json({ error: "Private code required" }, 403);
    return json({ token: await issueToken(roomName, env, auth), roomName });
  },
};
