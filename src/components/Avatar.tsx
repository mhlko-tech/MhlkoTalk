import { normalizeProfileAvatar, profileAvatarImageSource } from "../core/profileAvatar";

export interface AvatarProps {
  value: string;
  remote?: boolean;
}

/**
 * Renders either a profile image or a short text fallback.
 *
 * Keeping this primitive shared prevents account, room, and social screens from
 * drifting into slightly different avatar rules.
 */
export function Avatar({ value, remote = false }: AvatarProps) {
  const normalized = normalizeProfileAvatar(value);
  const imageSource = profileAvatarImageSource(normalized);

  return (
    <div className={`avatar ${remote ? "remote" : ""}`}>
      {imageSource ? <img src={imageSource} alt="" /> : (normalized || "M").slice(0, 2)}
    </div>
  );
}
