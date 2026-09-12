import { errorMessage } from "../core/async";
import type { RtcProviderId } from "../core/rtcProviders";
import type { RoomConnectionCredentials } from "./rtcAdapterRegistry";

export class RtcConnectionError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
    this.name = "RtcConnectionError";
  }
}

/** Administrative removal, duplicate login, and credentials are not outages. */
export function terminalRtcDisconnection(provider: "agora" | "tencent" | "livekit", reason?: string): RtcConnectionError | null {
  if (!reason) return null;
  if (provider === "agora" && ["NETWORK_ERROR", "FALLBACK", "LICENSE_MINUTES_EXCEEDED"].includes(reason)) return null;
  if (provider === "livekit" && ["UNKNOWN_REASON", "SERVER_SHUTDOWN", "STATE_MISMATCH", "JOIN_FAILURE", "MIGRATION", "SIGNAL_CLOSE", "CONNECTION_TIMEOUT", "MEDIA_FAILURE"].includes(reason)) return null;
  const expired = reason === "TOKEN_EXPIRE";
  const duplicate = reason === "UID_CONFLICT" || reason === "kick" || reason === "DUPLICATE_IDENTITY";
  const message = expired
    ? "The call access token expired. Please rejoin the room."
    : duplicate
      ? "This account joined the call on another device."
      : `The ${provider} call ended (${reason}).`;
  return new RtcConnectionError(message, "RTC_TERMINAL_DISCONNECTION", expired ? 401 : 403);
}

export function throwIfRtcJoinAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Room join cancelled", "AbortError");
}

/** Stops waiting immediately; the adapter must also dispose any late SDK result. */
export function awaitRtcOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(signal.reason ?? new DOMException("Room join cancelled", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Room join cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function isRetryableRtcConnectionFailure(error: unknown): boolean {
  const detail = error && typeof error === "object"
    ? error as { name?: string; code?: string | number; status?: number }
    : {};
  const message = `${detail.name || ""} ${detail.code || ""} ${errorMessage(error, "")}`;
  if (detail.status === 401 || detail.status === 403 || detail.status === 400) return false;
  if (/AbortError|NotAllowedError|NotFoundError|NotReadableError|OverconstrainedError|PERMISSION|DENIED|DEVICE_NOT_FOUND|NOT_AUTHORIZED|INVALID_TOKEN|TOKEN_EXPIRED|INVALID_VENDOR_KEY|invalid.*(?:token|credential|app.?id)|sign.?in|unauthori[sz]ed|microphone.*(?:missing|busy)|cannot.*(?:media experience|selected room connection)/i.test(message)) return false;
  if (detail.status && [408, 429, 500, 502, 503, 504].includes(detail.status)) return true;
  return /CAN_NOT_GET_GATEWAY_SERVER|NETWORK|GATEWAY|CONNECTION|CONNECT_FAILED|SOCKET|SIGNALING|SIGNALLING|TIMEOUT|TIMED.?OUT|TOOK TOO LONG|UNAVAILABLE|FAILED TO FETCH|DISCONNECT|ICE_FAILED/i.test(message);
}

type FailoverOptions = {
  supportedProviders: readonly RtcProviderId[];
  signal: AbortSignal;
  fetchCredentials(excludedProviders: RtcProviderId[], signal: AbortSignal): Promise<RoomConnectionCredentials>;
  connect(credentials: RoomConnectionCredentials, signal: AbortSignal): Promise<void>;
  cleanup(credentials: RoomConnectionCredentials): Promise<void>;
  onAttempt?(provider: RtcProviderId, attempt: number): void;
  timeoutMs?: number;
  excludedProviders?: readonly RtcProviderId[];
};

/** Each shipped, parity-safe provider gets at most one bounded connection attempt. */
export async function connectWithRtcFailover(options: FailoverOptions): Promise<RoomConnectionCredentials> {
  const excluded = [...new Set(options.excludedProviders ?? [])];
  const supported = [...new Set(options.supportedProviders)];
  const attempts = Math.min(3, supported.filter((provider) => !excluded.includes(provider)).length);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfRtcJoinAborted(options.signal);
    // Account, room-access, and broker errors are final; only failed RTC joins
    // cause provider exclusion. The broker owns the room's shared provider pin.
    const credentials = await awaitRtcOperation(options.fetchCredentials([...excluded], options.signal), options.signal);
    throwIfRtcJoinAborted(options.signal);
    const provider = credentials.routing.rtc.provider;
    if (!supported.includes(provider) || excluded.includes(provider)) {
      await options.cleanup(credentials);
      throw new RtcConnectionError("The connection service did not provide an available compatible alternative", "RTC_INVALID_FALLBACK");
    }
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal.reason);
    options.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new RtcConnectionError(
      `The ${provider} connection took too long to respond`, "RTC_CONNECTION_TIMEOUT",
    )), options.timeoutMs ?? 20_000);
    try {
      throwIfRtcJoinAborted(options.signal);
      options.onAttempt?.(provider, attempt + 1);
      await awaitRtcOperation(options.connect(credentials, controller.signal), controller.signal);
      throwIfRtcJoinAborted(options.signal);
      return credentials;
    } catch (error) {
      controller.abort(error);
      await options.cleanup(credentials);
      throwIfRtcJoinAborted(options.signal);
      if (!isRetryableRtcConnectionFailure(error) || attempt + 1 >= attempts) throw error;
      excluded.push(provider);
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
    }
  }
  throw new RtcConnectionError("No compatible voice provider is available", "RTC_NO_PROVIDER");
}

/** Wait for other room members to release the same failed route before moving it. */
export async function waitForRtcRoomRecovery<T>(
  request: () => Promise<T>,
  signal: AbortSignal,
  onWaiting: () => void,
  { retryMs = 5_000, timeoutMs = 90_000 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    throwIfRtcJoinAborted(signal);
    try {
      return await awaitRtcOperation(request(), signal);
    } catch (error) {
      throwIfRtcJoinAborted(signal);
      if (!(error instanceof RtcConnectionError) || error.code !== "RTC_ROOM_PROVIDER_LOCKED" || Date.now() >= deadline) throw error;
      onWaiting();
      await awaitRtcOperation(new Promise<void>((resolve) => setTimeout(resolve, Math.min(retryMs, deadline - Date.now()))), signal);
    }
  }
}
