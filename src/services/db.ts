import Database from '@tauri-apps/plugin-sql';
import type { AppLanguage, AppSettings, ChatMessage, ChatMessageKind, HotkeyAction, NativeVoiceSolution, ScreenFps, ScreenQuality, UserProfile, ChatOverlaySettings, CameraOverlaySettings, ScreenRecorderSettings } from '../types/models';

let dbPromise: Promise<Database> | null = null;

const DEFAULT_SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || 'ws://127.0.0.1:8787';

function detectInitialLanguage(): AppLanguage {
  try {
    const code = navigator.language.toLowerCase().split('-')[0] as AppLanguage;
    const supported: AppLanguage[] = ['ar', 'en', 'tr'];
    return supported.includes(code) ? code : (navigator.language.toLowerCase().startsWith('ar') ? 'ar' : 'en');
  } catch { return 'ar'; }
}

export const DEFAULT_CHAT_OVERLAY: ChatOverlaySettings = {
  xPercent: 3,
  yPercent: 72,
  widthPercent: 32,
  heightPercent: 22,
  opacity: 0.72,
  borderRadius: 18,
  showText: true,
  showImages: true,
  showAudio: true,
  interactive: false,
  monitorName: ''
};

export const DEFAULT_CAMERA_OVERLAY: CameraOverlaySettings = {
  xPercent: 70,
  yPercent: 8,
  widthPercent: 24,
  heightPercent: 22,
  borderRadius: 18,
  mirror: true,
  fitMode: 'cover',
  cropXPercent: 50,
  cropYPercent: 50,
  opacity: 1
};

export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  muteMic: 'Ctrl+Shift+KeyM',
  toggleScreen: 'Ctrl+Shift+KeyS',
  endCall: 'Ctrl+Shift+KeyE',
  toggleFullscreen: 'Ctrl+Shift+KeyF',
  toggleSettings: 'Ctrl+Comma',
  toggleOverlayMode: 'Ctrl+Shift+KeyO'
};

export const DEFAULT_PROFILE: UserProfile = {
  id: 1,
  display_name: 'MHTalk User',
  account_email: '',
  avatar_data_url: null,
  banner_data_url: null,
  bio: '',
  status: 'Online',
  updated_at: Date.now()
};

export const DEFAULT_SCREEN_RECORDER: ScreenRecorderSettings = {
  quality: 'adaptive',
  fps: 'match',
  codec: 'auto',
  includeAudio: true,
  includeMic: true,
  includeMembers: true,
  includeSystem: true,
  micVolume: 1,
  membersVolume: 1,
  systemVolume: 0.68,
  autoDuckSystem: true,
  micDeviceId: '',
  outputDeviceId: '',
  autoStart: false
};

export const DEFAULT_SETTINGS: AppSettings = {
  saveChat: true,
  lowInternetMode: false,
  lowPcMode: false,
  signalingUrl: DEFAULT_SIGNALING_URL,
  audioInputId: '',
  audioOutputId: '',
  cameraInputId: '',
  screenQuality: 'auto-max',
  screenFps: 60,
  remoteVolume: 1,
  language: detectInitialLanguage(),
  notificationsEnabled: true,
  nativeVoiceSolution: 1,
  voiceEnhanceEnabled: false,
  hotkeys: DEFAULT_HOTKEYS,
  chatOverlay: DEFAULT_CHAT_OVERLAY,
  cameraOverlay: DEFAULT_CAMERA_OVERLAY,
  showHistoryForNewMembers: false,
  screenRecorder: DEFAULT_SCREEN_RECORDER
};

async function getDb(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load('sqlite:mhlkotalk.db');
  return dbPromise;
}

async function tryExecute(db: Database, sql: string): Promise<void> {
  try { await db.execute(sql); } catch { /* already exists / older db */ }
}

export async function initDb(): Promise<void> {
  const db = await getDb();
  await db.execute(`CREATE TABLE IF NOT EXISTS profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    display_name TEXT NOT NULL,
    account_email TEXT NOT NULL DEFAULT '',
    avatar_data_url TEXT,
    banner_data_url TEXT,
    bio TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Online',
    updated_at INTEGER NOT NULL
  )`);
  await tryExecute(db, `ALTER TABLE profile ADD COLUMN account_email TEXT NOT NULL DEFAULT ''`);

  await db.execute(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    file_name TEXT,
    mime_type TEXT,
    data_url TEXT,
    reply_to_id TEXT,
    reply_to_body TEXT,
    reply_to_sender TEXT,
    waveform TEXT,
    edited_at INTEGER,
    deleted_at INTEGER
  )`);
  await tryExecute(db, `ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'`);
  await tryExecute(db, `ALTER TABLE messages ADD COLUMN file_name TEXT`);
  await tryExecute(db, `ALTER TABLE messages ADD COLUMN mime_type TEXT`);
  await tryExecute(db, `ALTER TABLE messages ADD COLUMN data_url TEXT`);
  await tryExecute(db, `ALTER TABLE messages ADD COLUMN reply_to_id TEXT`);
  await tryExecute(db, `ALTER TABLE messages ADD COLUMN reply_to_body TEXT`);
  await tryExecute(db, `ALTER TABLE messages ADD COLUMN reply_to_sender TEXT`);
  await tryExecute(db, `ALTER TABLE messages ADD COLUMN waveform TEXT`);
  await tryExecute(db, `ALTER TABLE messages ADD COLUMN edited_at INTEGER`);
  await tryExecute(db, `ALTER TABLE messages ADD COLUMN deleted_at INTEGER`);
  await tryExecute(db, `ALTER TABLE messages ADD COLUMN target_count INTEGER`);
  await tryExecute(db, `ALTER TABLE messages ADD COLUMN seen_by TEXT`);
  await tryExecute(db, `ALTER TABLE messages ADD COLUMN delivered_to TEXT`);
  await tryExecute(db, `ALTER TABLE messages ADD COLUMN delivery_status TEXT`);
  await tryExecute(db, `ALTER TABLE messages ADD COLUMN transferred_bytes INTEGER`);
  await tryExecute(db, `ALTER TABLE messages ADD COLUMN file_status TEXT`);
  await tryExecute(db, `ALTER TABLE messages ADD COLUMN local_path TEXT`);
  await tryExecute(db, `ALTER TABLE messages ADD COLUMN file_size INTEGER`);
  await tryExecute(db, `ALTER TABLE messages ADD COLUMN transfer_id TEXT`);

  await db.execute(
    `INSERT OR IGNORE INTO profile (id, display_name, account_email, avatar_data_url, banner_data_url, bio, status, updated_at)
     VALUES (1, $1, '', NULL, NULL, '', 'Online', $2)`,
    [DEFAULT_PROFILE.display_name, Date.now()]
  );

  for (const [key, value] of Object.entries(settingsToMap(DEFAULT_SETTINGS))) {
    await db.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ($1, $2)`, [key, value]);
  }
}

function settingsToMap(settings: AppSettings): Record<string, string> {
  return {
    saveChat: String(settings.saveChat),
    lowInternetMode: String(settings.lowInternetMode),
    lowPcMode: String(settings.lowPcMode),
    signalingUrl: settings.signalingUrl,
    audioInputId: settings.audioInputId,
    audioOutputId: settings.audioOutputId,
    cameraInputId: settings.cameraInputId || '',
    screenQuality: settings.screenQuality,
    screenFps: String(settings.screenFps),
    remoteVolume: String(settings.remoteVolume),
    language: settings.language,
    notificationsEnabled: String(settings.notificationsEnabled),
    nativeVoiceSolution: String(settings.nativeVoiceSolution || 1),
    voiceEnhanceEnabled: String(settings.voiceEnhanceEnabled || false),
    hotkeys: JSON.stringify(settings.hotkeys || DEFAULT_HOTKEYS),
    chatOverlay: JSON.stringify({ ...DEFAULT_CHAT_OVERLAY, ...(settings.chatOverlay || {}) }),
    cameraOverlay: JSON.stringify({ ...DEFAULT_CAMERA_OVERLAY, ...(settings.cameraOverlay || {}) }),
    showHistoryForNewMembers: String(Boolean(settings.showHistoryForNewMembers)),
    screenRecorder: JSON.stringify({ ...DEFAULT_SCREEN_RECORDER, ...(settings.screenRecorder || {}) })
  };
}

function mapToSettings(rows: Array<{ key: string; value: string }>): AppSettings {
  const map = new Map(rows.map((row) => [row.key, row.value]));
  const fps = Number(map.get('screenFps') || DEFAULT_SETTINGS.screenFps) as ScreenFps;
  const quality = (map.get('screenQuality') || DEFAULT_SETTINGS.screenQuality) as ScreenQuality;
  const volume = Number(map.get('remoteVolume') || DEFAULT_SETTINGS.remoteVolume);
  const language = (map.get('language') || DEFAULT_SETTINGS.language) as AppLanguage;
  const allowedLanguages: AppLanguage[] = ['ar', 'en', 'tr'];
  const nativeVoiceSolution = Number(map.get('nativeVoiceSolution') || DEFAULT_SETTINGS.nativeVoiceSolution) as NativeVoiceSolution;
  const allowedNativeVoiceSolutions: NativeVoiceSolution[] = [1, 2, 3, 4];
  const allowedQuality: ScreenQuality[] = ['auto-max', '4k', '1440p', '1080p', '720p', '480p', '360p', 'audio-only'];
  const allowedFps: ScreenFps[] = [144, 120, 60, 30, 15, 8];
  let hotkeys = DEFAULT_HOTKEYS;
  let chatOverlay = DEFAULT_CHAT_OVERLAY;
  let cameraOverlay = DEFAULT_CAMERA_OVERLAY;
  let screenRecorder = DEFAULT_SCREEN_RECORDER;
  try {
    const parsed = JSON.parse(map.get('hotkeys') || '{}') as Partial<Record<HotkeyAction, string>>;
    hotkeys = { ...DEFAULT_HOTKEYS, ...parsed };
  } catch {
    hotkeys = DEFAULT_HOTKEYS;
  }
  try {
    const parsed = JSON.parse(map.get('chatOverlay') || '{}') as Partial<ChatOverlaySettings>;
    chatOverlay = {
      ...DEFAULT_CHAT_OVERLAY,
      ...parsed,
      xPercent: Math.min(95, Math.max(0, Number(parsed.xPercent ?? DEFAULT_CHAT_OVERLAY.xPercent))),
      yPercent: Math.min(95, Math.max(0, Number(parsed.yPercent ?? DEFAULT_CHAT_OVERLAY.yPercent))),
      widthPercent: Math.min(90, Math.max(12, Number(parsed.widthPercent ?? DEFAULT_CHAT_OVERLAY.widthPercent))),
      heightPercent: Math.min(60, Math.max(8, Number(parsed.heightPercent ?? DEFAULT_CHAT_OVERLAY.heightPercent))),
      opacity: Math.min(1, Math.max(0.15, Number(parsed.opacity ?? DEFAULT_CHAT_OVERLAY.opacity))),
      borderRadius: Math.min(40, Math.max(0, Number(parsed.borderRadius ?? DEFAULT_CHAT_OVERLAY.borderRadius))),
      interactive: Boolean(parsed.interactive ?? DEFAULT_CHAT_OVERLAY.interactive),
      monitorName: String(parsed.monitorName ?? DEFAULT_CHAT_OVERLAY.monitorName)
    };
  } catch {
    chatOverlay = DEFAULT_CHAT_OVERLAY;
  }
  try {
    const parsed = JSON.parse(map.get('cameraOverlay') || '{}') as Partial<CameraOverlaySettings>;
    cameraOverlay = {
      ...DEFAULT_CAMERA_OVERLAY,
      ...parsed,
      xPercent: Math.min(90, Math.max(0, Number(parsed.xPercent ?? DEFAULT_CAMERA_OVERLAY.xPercent))),
      yPercent: Math.min(90, Math.max(0, Number(parsed.yPercent ?? DEFAULT_CAMERA_OVERLAY.yPercent))),
      widthPercent: Math.min(70, Math.max(10, Number(parsed.widthPercent ?? DEFAULT_CAMERA_OVERLAY.widthPercent))),
      heightPercent: Math.min(70, Math.max(8, Number(parsed.heightPercent ?? DEFAULT_CAMERA_OVERLAY.heightPercent))),
      borderRadius: Math.min(50, Math.max(0, Number(parsed.borderRadius ?? DEFAULT_CAMERA_OVERLAY.borderRadius))),
      mirror: Boolean(parsed.mirror ?? DEFAULT_CAMERA_OVERLAY.mirror),
      fitMode: parsed.fitMode === 'contain' ? 'contain' : 'cover',
      cropXPercent: Math.min(100, Math.max(0, Number(parsed.cropXPercent ?? DEFAULT_CAMERA_OVERLAY.cropXPercent))),
      cropYPercent: Math.min(100, Math.max(0, Number(parsed.cropYPercent ?? DEFAULT_CAMERA_OVERLAY.cropYPercent))),
      opacity: Math.min(1, Math.max(0.1, Number(parsed.opacity ?? DEFAULT_CAMERA_OVERLAY.opacity)))
    };
  } catch {
    cameraOverlay = DEFAULT_CAMERA_OVERLAY;
  }
  try {
    const parsed = JSON.parse(map.get('screenRecorder') || '{}') as Partial<ScreenRecorderSettings>;
    const allowedQuality: ScreenRecorderSettings['quality'][] = ['adaptive', 'high', 'balanced', 'performance'];
    const allowedFps: ScreenRecorderSettings['fps'][] = ['match', 60, 30, 15];
    const allowedCodec: ScreenRecorderSettings['codec'][] = ['auto', 'h264', 'vp8', 'vp9'];
    screenRecorder = {
      quality: allowedQuality.includes(parsed.quality as ScreenRecorderSettings['quality']) ? parsed.quality as ScreenRecorderSettings['quality'] : DEFAULT_SCREEN_RECORDER.quality,
      fps: allowedFps.includes(parsed.fps as ScreenRecorderSettings['fps']) ? parsed.fps as ScreenRecorderSettings['fps'] : DEFAULT_SCREEN_RECORDER.fps,
      codec: allowedCodec.includes(parsed.codec as ScreenRecorderSettings['codec']) ? parsed.codec as ScreenRecorderSettings['codec'] : DEFAULT_SCREEN_RECORDER.codec,
      includeAudio: parsed.includeAudio !== false,
      includeMic: Boolean(parsed.includeMic ?? parsed.includeAudio ?? DEFAULT_SCREEN_RECORDER.includeMic),
      includeMembers: Boolean(parsed.includeMembers ?? parsed.includeAudio ?? DEFAULT_SCREEN_RECORDER.includeMembers),
      includeSystem: Boolean(parsed.includeSystem ?? parsed.includeAudio ?? DEFAULT_SCREEN_RECORDER.includeSystem),
      micVolume: Math.min(2, Math.max(0, Number(parsed.micVolume ?? DEFAULT_SCREEN_RECORDER.micVolume))),
      membersVolume: Math.min(2, Math.max(0, Number(parsed.membersVolume ?? DEFAULT_SCREEN_RECORDER.membersVolume))),
      systemVolume: Math.min(2, Math.max(0, Number(parsed.systemVolume ?? DEFAULT_SCREEN_RECORDER.systemVolume))),
      autoDuckSystem: Boolean(parsed.autoDuckSystem ?? DEFAULT_SCREEN_RECORDER.autoDuckSystem),
      micDeviceId: String(parsed.micDeviceId ?? DEFAULT_SCREEN_RECORDER.micDeviceId),
      outputDeviceId: String(parsed.outputDeviceId ?? DEFAULT_SCREEN_RECORDER.outputDeviceId),
      autoStart: Boolean(parsed.autoStart)
    };
  } catch {
    screenRecorder = DEFAULT_SCREEN_RECORDER;
  }
  return {
    saveChat: (map.get('saveChat') || 'true') === 'true',
    lowInternetMode: (map.get('lowInternetMode') || 'false') === 'true',
    lowPcMode: (map.get('lowPcMode') || 'false') === 'true',
    signalingUrl: map.get('signalingUrl') || DEFAULT_SIGNALING_URL,
    audioInputId: map.get('audioInputId') || '',
    audioOutputId: map.get('audioOutputId') || '',
    cameraInputId: map.get('cameraInputId') || '',
    screenQuality: allowedQuality.includes(quality) ? quality : 'auto-max',
    screenFps: allowedFps.includes(fps) ? fps : 60,
    remoteVolume: Number.isFinite(volume) ? Math.min(2, Math.max(0, volume)) : 1,
    language: allowedLanguages.includes(language) ? language : 'ar',
    notificationsEnabled: (map.get('notificationsEnabled') || 'true') === 'true',
    nativeVoiceSolution: allowedNativeVoiceSolutions.includes(nativeVoiceSolution) ? nativeVoiceSolution : 1,
    voiceEnhanceEnabled: (map.get('voiceEnhanceEnabled') || 'false') === 'true',
    hotkeys,
    chatOverlay,
    cameraOverlay,
    showHistoryForNewMembers: (map.get('showHistoryForNewMembers') || 'false') === 'true',
    screenRecorder
  };
}

export async function loadProfile(): Promise<UserProfile> {
  const db = await getDb();
  const rows = await db.select<UserProfile[]>(`SELECT * FROM profile WHERE id = 1`);
  return rows[0] ? { ...DEFAULT_PROFILE, ...rows[0] } : DEFAULT_PROFILE;
}

export async function saveProfile(profile: UserProfile): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO profile (id, display_name, account_email, avatar_data_url, banner_data_url, bio, status, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(id) DO UPDATE SET
       display_name=excluded.display_name,
       account_email=excluded.account_email,
       avatar_data_url=excluded.avatar_data_url,
       banner_data_url=excluded.banner_data_url,
       bio=excluded.bio,
       status=excluded.status,
       updated_at=excluded.updated_at`,
    [profile.display_name, profile.account_email, profile.avatar_data_url, profile.banner_data_url, profile.bio, profile.status, Date.now()]
  );
}

export async function loadSettings(): Promise<AppSettings> {
  const db = await getDb();
  const rows = await db.select<Array<{ key: string; value: string }>>(`SELECT key, value FROM settings`);
  return mapToSettings(rows);
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const db = await getDb();
  const mapped = settingsToMap(settings);
  for (const [key, value] of Object.entries(mapped)) {
    await db.execute(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      [key, value]
    );
  }
}

export async function saveMessage(message: ChatMessage): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT OR REPLACE INTO messages (id, room_id, sender, sender_name, body, created_at, kind, file_name, mime_type, data_url, reply_to_id, reply_to_body, reply_to_sender, waveform, edited_at, deleted_at, delivery_status, delivered_to, seen_by, target_count, transfer_id, file_size, local_path, file_status, transferred_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)`,
    [
      message.id,
      message.roomId,
      message.sender,
      message.senderName,
      message.body,
      message.createdAt,
      message.kind || 'text',
      message.fileName || null,
      message.mimeType || null,
      message.dataUrl || null,
      message.replyToId || null,
      message.replyToBody || null,
      message.replyToSender || null,
      message.waveform ? JSON.stringify(message.waveform) : null,
      message.editedAt || null,
      message.deletedAt || null,
      message.deliveryStatus || null,
      message.deliveredTo ? JSON.stringify(message.deliveredTo) : null,
      message.seenBy ? JSON.stringify(message.seenBy) : null,
      Number.isFinite(message.targetCount || NaN) ? message.targetCount || 0 : null,
      message.transferId || null,
      Number.isFinite(message.fileSize || NaN) ? message.fileSize || 0 : null,
      message.localPath || null,
      message.fileStatus || null,
      Number.isFinite(message.transferredBytes || NaN) ? message.transferredBytes || 0 : null
    ]
  );
}

export async function loadMessages(roomId: string): Promise<ChatMessage[]> {
  const db = await getDb();
  const rows = await db.select<Array<{
    id: string;
    room_id: string;
    sender: 'me' | 'peer' | 'system';
    sender_name: string;
    body: string;
    created_at: number;
    kind?: ChatMessageKind;
    file_name?: string | null;
    mime_type?: string | null;
    data_url?: string | null;
    reply_to_id?: string | null;
    reply_to_body?: string | null;
    reply_to_sender?: string | null;
    waveform?: string | null;
    edited_at?: number | null;
    deleted_at?: number | null;
    delivery_status?: string | null;
    delivered_to?: string | null;
    seen_by?: string | null;
    target_count?: number | null;
    transfer_id?: string | null;
    file_size?: number | null;
    local_path?: string | null;
    file_status?: string | null;
    transferred_bytes?: number | null;
  }>>(`SELECT * FROM messages WHERE room_id = $1 ORDER BY created_at ASC LIMIT 500`, [roomId]);

  return rows.map((row) => ({
    id: row.id,
    roomId: row.room_id,
    sender: row.sender,
    senderName: row.sender_name,
    body: row.body,
    createdAt: row.created_at,
    kind: row.kind || 'text',
    fileName: row.file_name || undefined,
    mimeType: row.mime_type || undefined,
    dataUrl: row.data_url || undefined,
    replyToId: row.reply_to_id || undefined,
    replyToBody: row.reply_to_body || undefined,
    replyToSender: row.reply_to_sender || undefined,
    waveform: row.waveform ? safeJsonNumberArray(row.waveform) : undefined,
    editedAt: row.edited_at || undefined,
    deletedAt: row.deleted_at || undefined,
    deliveryStatus: (row.delivery_status as ChatMessage['deliveryStatus']) || undefined,
    deliveredTo: row.delivered_to ? safeJsonStringArray(row.delivered_to) : undefined,
    seenBy: row.seen_by ? safeJsonStringArray(row.seen_by) : undefined,
    targetCount: typeof row.target_count === 'number' ? row.target_count : undefined,
    transferId: row.transfer_id || undefined,
    fileSize: typeof row.file_size === 'number' ? row.file_size : undefined,
    localPath: row.local_path || undefined,
    fileStatus: (row.file_status as ChatMessage['fileStatus']) || undefined,
    transferredBytes: typeof row.transferred_bytes === 'number' ? row.transferred_bytes : undefined
  }));
}

function safeJsonStringArray(value: string): string[] | undefined {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)).filter(Boolean).slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

function safeJsonNumberArray(value: string): number[] | undefined {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((n) => Number(n)).filter((n) => Number.isFinite(n)).slice(0, 80) : undefined;
  } catch {
    return undefined;
  }
}

export async function markMessageDeleted(messageId: string, deletedAt: number): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE messages SET deleted_at = $1, body = '', data_url = NULL WHERE id = $2`, [deletedAt, messageId]);
}

export async function clearRoomMessages(roomId: string): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM messages WHERE room_id = $1`, [roomId]);
}

export async function clearAllLocalData(): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM messages`);
  await db.execute(`DELETE FROM settings`);
  await db.execute(`DELETE FROM profile`);
  dbPromise = null;
  await initDb();
}
