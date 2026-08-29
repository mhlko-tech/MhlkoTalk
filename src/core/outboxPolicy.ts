export const OUTBOX_RETRY_MAX_MS = 60_000;

export function outboxRetryDelayMs(attempt: number): number {
  const safeAttempt = Math.max(0, Math.min(16, Math.floor(attempt)));
  return Math.min(OUTBOX_RETRY_MAX_MS, 1_000 * (2 ** safeAttempt));
}

export function pendingOutboxRecipients(
  intendedPeerIds: readonly string[],
  acknowledgedPeerIds: readonly string[],
  connectedPeerIds: readonly string[]
): string[] {
  const acknowledged = new Set(acknowledgedPeerIds.filter(Boolean));
  const connected = new Set(connectedPeerIds.filter(Boolean));
  return [...new Set(intendedPeerIds.filter(Boolean))]
    .filter((peerId) => connected.has(peerId) && !acknowledged.has(peerId));
}

export class BoundedMessageIdCache {
  private readonly ids = new Set<string>();
  private readonly order: string[] = [];
  private readonly capacity: number;

  constructor(capacity = 2_000) {
    this.capacity = capacity;
  }

  /**
   * Returns true when the id was already observed. New ids are retained in a
   * bounded FIFO cache so reconnect retries remain idempotent without leaking memory.
   */
  remember(id: string): boolean {
    if (!id) return false;
    if (this.ids.has(id)) return true;
    this.ids.add(id);
    this.order.push(id);
    while (this.order.length > Math.max(1, this.capacity)) {
      const oldest = this.order.shift();
      if (oldest) this.ids.delete(oldest);
    }
    return false;
  }

  clear(): void {
    this.ids.clear();
    this.order.length = 0;
  }
}
