import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { moderateMainMessage } from "../../src/core/moderation";

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
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
}

type AuthUser = { id: string; accessToken: string; email?: string };
type Profile = { id: string; username: string; display_name: string; avatar_url: string | null; bio?: string | null };
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
const configured = (env: Env) => Boolean(env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY);
const supabaseUrl = (env: Env, path: string) => `${env.SUPABASE_URL!.replace(/\/$/, "")}${path}`;

async function authenticate(request: Request, env: Env): Promise<AuthUser | Response> {
  if (!configured(env)) return json({ error: "Accounts are not configured yet" }, 503);
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return json({ error: "Sign in is required" }, 401);
  const response = await fetch(supabaseUrl(env, "/auth/v1/user"), {
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY!, authorization },
  });
  if (!response.ok) return json({ error: "Session is invalid or expired" }, 401);
  const user = (await response.json()) as { id?: string; email?: string };
  return user.id ? { id: user.id, email: user.email, accessToken: authorization.slice(7) } : json({ error: "Invalid account" }, 401);
}
async function optionalAuth(request: Request, env: Env): Promise<AuthUser | Response | null> {
  return configured(env) ? authenticate(request, env) : null;
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
  const response = await userApi(env, user, `/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,username,display_name,avatar_url,bio&limit=1`);
  return response.ok ? ((await response.json()) as Profile[])[0] || null : null;
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
    if (request.method === "OPTIONS") return new Response(null, { headers });
    const url = new URL(request.url);
    const path = url.pathname;
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
      return auth instanceof Response ? auth : handleSocial(request, env, path, auth);
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
      return auth instanceof Response ? auth : json(await createPrivateRoom(env));
    }
    if (path !== "/livekit/token") return json({ error: "Not found" }, 404);
    const auth = await optionalAuth(request, env);
    if (auth instanceof Response) return auth;
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
