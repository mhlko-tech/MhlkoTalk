const encoder = new TextEncoder();

export type PresenceTicketClaims = {
  userId: string;
  expiresAt: number;
};

export type SocialInviteClaims = {
  senderId: string;
  targetId: string;
  roomName: string;
  inviteCode: string | null;
  createdAt: string;
  expiresAt: number;
};

function b64(bytes: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function unb64(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(
    atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)),
    (character) => character.charCodeAt(0),
  );
}

async function signingKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signClaims(value: object, secret: string) {
  const payload = b64(encoder.encode(JSON.stringify(value)).buffer);
  const signature = b64(
    await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(payload)),
  );
  return `${payload}.${signature}`;
}

async function verifyClaims(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 1 || token.length > 4_096) return null;
  const payload = token.slice(0, dot);
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret),
      unb64(token.slice(dot + 1)),
      encoder.encode(payload),
    );
    if (!valid) return null;
    const parsed = JSON.parse(new TextDecoder().decode(unb64(payload))) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function signPresenceTicket(
  userId: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  return signClaims({ userId, expiresAt: nowSeconds + 60 } satisfies PresenceTicketClaims, secret);
}

export async function verifyPresenceTicket(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<PresenceTicketClaims | null> {
  const value = await verifyClaims(token, secret);
  if (
    !value ||
    typeof value.userId !== "string" ||
    value.userId.length < 1 ||
    value.userId.length > 200 ||
    !Number.isSafeInteger(value.expiresAt) ||
    Number(value.expiresAt) < nowSeconds
  ) return null;
  return value as PresenceTicketClaims;
}

export async function signSocialInvite(
  value: Omit<SocialInviteClaims, "expiresAt">,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  return signClaims({ ...value, expiresAt: nowSeconds + 10 * 60 } satisfies SocialInviteClaims, secret);
}

export async function verifySocialInvite(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<SocialInviteClaims | null> {
  const value = await verifyClaims(token, secret);
  if (
    !value ||
    typeof value.senderId !== "string" ||
    value.senderId.length < 1 ||
    value.senderId.length > 200 ||
    typeof value.targetId !== "string" ||
    value.targetId.length < 1 ||
    value.targetId.length > 200 ||
    typeof value.roomName !== "string" ||
    value.roomName.length < 1 ||
    value.roomName.length > 100 ||
    !(value.inviteCode === null || (typeof value.inviteCode === "string" && value.inviteCode.length <= 64)) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isSafeInteger(value.expiresAt) ||
    Number(value.expiresAt) < nowSeconds
  ) return null;
  return value as SocialInviteClaims;
}
