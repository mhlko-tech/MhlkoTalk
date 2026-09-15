import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Reserve before forwarding. Persisted reservations survive process/VM restarts.
export class DailyBudget {
  constructor(file, limit) {
    this.file = file; this.limit = limit; this.credit = 0;
    mkdirSync(dirname(file), { recursive: true });
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { day: '', used: 0 };
    if (typeof this.state.day !== 'string' || !Number.isSafeInteger(this.state.used) || this.state.used < 0)
      throw new Error('Invalid quota state; refusing to reset the budget');
  }
  take(bytes, now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.state.day !== day) { this.state = { day, used: 0 }; this.credit = 0; }
    if (this.credit < bytes) {
      const amount = Math.max(bytes, 256 * 1024);
      if (this.state.used + amount > this.limit) return false;
      const next = { day, used: this.state.used + amount };
      // Write failures close access instead of bypassing the cost cap.
      try {
        writeFileSync(this.file + '.tmp', JSON.stringify(next), { mode: 0o600 });
        renameSync(this.file + '.tmp', this.file);
      } catch { return false; }
      this.state = next; this.credit += amount;
    }
    this.credit -= bytes; return true;
  }
}
