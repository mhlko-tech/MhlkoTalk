export type DiagnosticLevel = 'error' | 'info';

export interface DiagnosticEntry {
  id: string;
  at: number;
  level: DiagnosticLevel;
  message: string;
}

const STORAGE_KEY = 'mhtalk.diagnostics.v1';
const EVENT_NAME = 'mhtalk:diagnostic';
const MAX_ENTRIES = 300;
let entries: DiagnosticEntry[] = readStoredEntries();
let persistTimer: number | undefined;

function readStoredEntries(): DiagnosticEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry.message === 'string')
      .map((entry) => ({
        id: String(entry.id || crypto.randomUUID()),
        at: Number(entry.at) || Date.now(),
        level: entry.level === 'error' ? 'error' as const : 'info' as const,
        message: String(entry.message).slice(0, 8_000)
      }))
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function persistEntries(immediate: boolean): void {
  if (typeof window === 'undefined') return;
  const write = () => {
    persistTimer = undefined;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // Diagnostics must never become a new failure mode.
    }
  };
  if (persistTimer) window.clearTimeout(persistTimer);
  if (immediate) write();
  else persistTimer = window.setTimeout(write, 400);
}

export function loadDiagnostics(): DiagnosticEntry[] {
  return [...entries];
}

export function appendDiagnostic(message: unknown, level: DiagnosticLevel = 'info'): DiagnosticEntry {
  const entry: DiagnosticEntry = {
    id: crypto.randomUUID(),
    at: Date.now(),
    level,
    message: String(message || (level === 'error' ? 'Unknown error' : 'Event')).slice(0, 8_000)
  };
  entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  persistEntries(level === 'error');
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: entry }));
  return entry;
}

export function clearDiagnostics(): void {
  entries = [];
  persistEntries(true);
}

export function subscribeDiagnostics(listener: (entry: DiagnosticEntry) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => listener((event as CustomEvent<DiagnosticEntry>).detail);
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}

export function installGlobalDiagnostics(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onError = (event: ErrorEvent) => {
    appendDiagnostic(event.error?.stack || event.message || 'Unknown window error', 'error');
  };
  const onUnhandled = (event: PromiseRejectionEvent) => {
    appendDiagnostic(event.reason?.stack || event.reason?.message || event.reason || 'Unhandled promise rejection', 'error');
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandled);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onUnhandled);
  };
}
