/**
 * Prevents the same user command from running more than once concurrently.
 *
 * React state is intentionally not used as the lock: state updates are asynchronous,
 * so two rapid clicks can both enter an event handler before a disabled button renders.
 */
export class AsyncCommandGate {
  private readonly active = new Set<string>();

  tryEnter(command: string): boolean {
    if (this.active.has(command)) return false;
    this.active.add(command);
    return true;
  }

  leave(command: string): void {
    this.active.delete(command);
  }

  isActive(command: string): boolean {
    return this.active.has(command);
  }

  clear(): void {
    this.active.clear();
  }
}
