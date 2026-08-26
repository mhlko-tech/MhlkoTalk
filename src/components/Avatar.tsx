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
  const isImage =
    value.startsWith("data:image/") ||
    value.startsWith("https://") ||
    value.startsWith("http://");

  return (
    <div className={`avatar ${remote ? "remote" : ""}`}>
      {isImage ? <img src={value} alt="" /> : value.slice(0, 2)}
    </div>
  );
}
