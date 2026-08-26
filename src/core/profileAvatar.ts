const MAX_ROOM_DATA_AVATAR_BYTES = 11_000;
const MAX_REMOTE_AVATAR_URL_LENGTH = 1_000;

const textEncoder = new TextEncoder();

/**
 * Normalizes the avatar value exchanged over a room data channel.
 *
 * Account photos are public HTTPS URLs. A small data URL is also accepted for
 * legacy/local profiles, while plain initials remain a compact fallback.
 */
export function normalizeProfileAvatar(value: unknown): string {
  if (typeof value !== "string") return "";
  const avatar = value.trim();
  if (!avatar) return "";

  if (/^https:\/\//i.test(avatar) && avatar.length <= MAX_REMOTE_AVATAR_URL_LENGTH) {
    try {
      const url = new URL(avatar);
      if (!url.username && !url.password) return url.href;
    } catch {
      return "";
    }
  }

  if (
    /^data:image\//i.test(avatar) &&
    textEncoder.encode(avatar).byteLength <= MAX_ROOM_DATA_AVATAR_BYTES
  ) {
    return avatar;
  }

  return /^[\p{L}\p{N}]{1,3}$/u.test(avatar) ? avatar : "";
}

export function profileAvatarImageSource(value: unknown): string | null {
  const avatar = normalizeProfileAvatar(value);
  return /^(?:data:image\/|https:\/\/)/i.test(avatar) ? avatar : null;
}

