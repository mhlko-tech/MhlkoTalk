import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { moderateMainMessage } from "../../src/core/moderation";

export interface Env {
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;
  LIVEKIT_URL: string;
  INVITE_SIGNING_KEY: string;
  PRIVATE_ROOMS: KVNamespace;
}
const encoder = new TextEncoder();
const allowedRoom = /^[a-zA-Z0-9 _-]{1,100}$/;
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
const headers = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers });

async function key(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
function b64(bytes: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function unb64(value: string) {
  return Uint8Array.from(
    atob(
      value.replaceAll("-", "+").replaceAll("_", "/") +
        "=".repeat((4 - (value.length % 4)) % 4),
    ),
    (c) => c.charCodeAt(0),
  );
}
async function signedInvite(roomName: string, secret: string) {
  const expiry = Math.floor(Date.now() / 1000) + 604800;
  const payload = `${roomName}.${expiry}`;
  return `${payload}.${b64(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(payload)))}`;
}
async function validInvite(roomName: string, invite: string, secret: string) {
  const dot = invite.lastIndexOf(".");
  const expiryDot = invite.lastIndexOf(".", dot - 1);
  if (dot < 1 || expiryDot < 1) return false;
  const payload = invite.slice(0, dot);
  const expiry = Number(invite.slice(expiryDot + 1, dot));
  return (
    invite.slice(0, expiryDot) === roomName &&
    Number.isSafeInteger(expiry) &&
    expiry >= Date.now() / 1000 &&
    crypto.subtle.verify(
      "HMAC",
      await key(secret),
      unb64(invite.slice(dot + 1)),
      encoder.encode(payload),
    )
  );
}
function shortCode() {
  return `MHTALK-${[...crypto.getRandomValues(new Uint8Array(5))].map((n) => alphabet[n % alphabet.length]).join("")}`;
}
async function issueToken(roomName: string, env: Env) {
  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: crypto.randomUUID(),
    ttl: "10m",
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  });
  return token.toJwt();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers });
    if (request.method !== "POST") return json({ error: "Not found" }, 404);
    const path = new URL(request.url).pathname;
    if (path === "/moderate") {
      const body = (await request.json().catch(() => null)) as {
        text?: unknown;
        roomName?: unknown;
      } | null;
      if (body?.roomName !== "Main" || typeof body.text !== "string")
        return json({ error: "Invalid moderation request" }, 400);
      if (body.text.length > 8000)
        return json({ error: "Message is too long" }, 413);
      return json(moderateMainMessage(body.text));
    }
    if (path === "/moderation/report") {
      const body = (await request.json().catch(() => null)) as {
        roomName?: unknown;
        reporterIdentity?: unknown;
        targetIdentity?: unknown;
        messageId?: unknown;
        content?: unknown;
      } | null;
      if (
        typeof body?.roomName !== "string" ||
        typeof body.reporterIdentity !== "string" ||
        typeof body.targetIdentity !== "string" ||
        body.roomName.length > 100 ||
        body.reporterIdentity.length > 100 ||
        body.targetIdentity.length > 100
      ) return json({ error: "Invalid report" }, 400);
      const id = `report:${Date.now()}:${crypto.randomUUID()}`;
      await env.PRIVATE_ROOMS.put(id, JSON.stringify({
        createdAt: new Date().toISOString(),
        roomName: body.roomName,
        reporterIdentity: body.reporterIdentity,
        targetIdentity: body.targetIdentity,
        messageId: typeof body.messageId === "string" ? body.messageId.slice(0, 100) : null,
        content: typeof body.content === "string" ? body.content.slice(0, 2000) : null,
      }), { expirationTtl: 2592000 });
      return json({ accepted: true });
    }
    if (path === "/room-count") {
      const body = (await request.json().catch(() => null)) as {
        roomName?: unknown;
      } | null;
      if (body?.roomName !== "Main")
        return json({ error: "Only the Main room count is public" }, 400);
      try {
        const rooms = new RoomServiceClient(
          env.LIVEKIT_URL,
          env.LIVEKIT_API_KEY,
          env.LIVEKIT_API_SECRET,
        );
        const participants = await rooms.listParticipants("Main");
        return json({ count: participants.length });
      } catch {
        return json({ error: "Room count unavailable" }, 503);
      }
    }
    if (path === "/private-room") {
      const roomName = `Private-${crypto.randomUUID().replaceAll("-", "")}`;
      const invite = await signedInvite(roomName, env.INVITE_SIGNING_KEY);
      let code = shortCode();
      while (await env.PRIVATE_ROOMS.get(code)) code = shortCode();
      await env.PRIVATE_ROOMS.put(code, JSON.stringify({ roomName, invite }), {
        expirationTtl: 604800,
      });
      return json({ roomName, code });
    }
    if (path !== "/livekit/token") return json({ error: "Not found" }, 404);
    const body = (await request.json().catch(() => null)) as {
      roomName?: unknown;
      inviteCode?: unknown;
    } | null;
    let roomName =
      typeof body?.roomName === "string" ? body.roomName.trim() : "";
    roomName =
      roomName === "Main room" || roomName === "Main channel"
        ? "Main"
        : roomName;
    if (typeof body?.inviteCode === "string") {
      const stored = await env.PRIVATE_ROOMS.get(body.inviteCode.toUpperCase());
      if (!stored)
        return json({ error: "Private code is invalid or expired" }, 403);
      const privateRoom = JSON.parse(stored) as {
        roomName: string;
        invite: string;
      };
      if (
        !(await validInvite(
          privateRoom.roomName,
          privateRoom.invite,
          env.INVITE_SIGNING_KEY,
        ))
      )
        return json({ error: "Private code is invalid" }, 403);
      roomName = privateRoom.roomName;
    }
    if (!allowedRoom.test(roomName))
      return json({ error: "Invalid room name" }, 400);
    if (roomName !== "Main" && typeof body?.inviteCode !== "string")
      return json({ error: "Private code required" }, 403);
    return json({ token: await issueToken(roomName, env), roomName });
  },
};
