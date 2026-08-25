const usernamePattern = /^[A-Za-z0-9_]{3,32}$/;
const reservedUsernames = new Set([
  "admin", "administrator", "api", "bot", "everyone", "help", "here",
  "mhlko", "mhtalk", "moderator", "official", "root", "security",
  "staff", "support", "system", "verified",
]);

export function usernameError(value: unknown) {
  if (typeof value !== "string" || !usernamePattern.test(value.trim()))
    return "Username must be 3-32 letters, numbers, or underscores";
  if (reservedUsernames.has(value.trim().toLowerCase())) return "Username is unavailable";
  return null;
}

export function emailError(value: unknown) {
  if (typeof value !== "string" || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()))
    return "Enter a valid email address";
  return null;
}

export function passwordError(value: unknown) {
  if (typeof value !== "string" || value.length < 10) return "Password must be at least 10 characters";
  if (value.length > 128) return "Password must be 128 characters or fewer";
  return null;
}
