export type SessionFailure = {
  status?: number;
  name?: string;
  message?: string;
};

const terminalRefreshMessages = [
  "invalid refresh token",
  "refresh token not found",
  "refresh token already used",
  "session not found",
  "session has expired",
  "session revoked",
];

/**
 * Authentication failures are terminal only when the identity provider has
 * positively rejected the stored session. Network, timeout, throttling, and
 * upstream failures must keep the local session available for recovery.
 */
export function isTerminalSessionFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as SessionFailure;
  const status = Number(failure.status || 0);
  const message = `${failure.name || ""} ${failure.message || ""}`.toLowerCase();

  if (terminalRefreshMessages.some((value) => message.includes(value))) return true;
  if ([408, 425, 429].includes(status) || status >= 500) return false;
  return [400, 401, 403].includes(status);
}

export function sessionRetryDelay(attempt: number): number {
  return [2_000, 5_000, 15_000, 30_000, 60_000][Math.min(Math.max(attempt, 0), 4)];
}
