import { DurableObject } from 'cloudflare:workers';

export interface Env {
  ROOMS: DurableObjectNamespace;
}

type RoomRole = 'owner' | 'moderator' | 'member';
type AttachmentKind = 'main' | 'voice';

type Attachment = {
  peerId: string;
  stableClientId: string;
  displayName: string;
  joinedAt: number;
  approved: boolean;
  kind: AttachmentKind;
  parentPeerId?: string;
  voiceToken?: string;
  profileToken?: string;
};

type OwnerIdentity = { peerId: string; stableClientId: string; displayName: string; createdAt: number; lastSeenAt: number; online: boolean };
type BannedMember = { peerId: string; stableClientId?: string; displayName: string; kickedAt: number };
type TemporaryApproval = { stableClientId: string; peerId: string; displayName: string; approvedAt: number; disconnectedAt?: number; expiresAt?: number };
type RateEntry = { key: string; at: number[] };
type ProfileAsset = { peerId: string; avatar: string | null; version: string; updatedAt: number };

const TEMP_APPROVAL_GRACE_MS = 60_000;
const MAX_WS_MESSAGE_BYTES = 64 * 1024;
const MAX_ROOM_CONNECTIONS = 256;
const MAX_SIGNAL_MESSAGES_PER_WINDOW = 180;
const MAX_PROFILE_REQUEST_BYTES = 384 * 1024;
const MAX_PROFILE_AVATAR_CHARS = 320 * 1024;
const MAX_PROFILE_BATCH_IDS = 100;
const RATE_LIMIT_WINDOW_MS = 10_000;
const MAX_JOIN_ATTEMPTS_PER_WINDOW = 8;
const MAX_SENSITIVE_MESSAGES_PER_WINDOW = 30;

const KNOWN_SIGNAL_TYPES = new Set([
  'hello', 'profile', 'description', 'candidate', 'media',
  'kick', 'unban', 'join-approve', 'join-reject', 'promote',
  'companion-register', 'companion-revoke', 'voice-hello', 'voice-media',
  'admin-mute-all', 'admin-unmute-all', 'admin-mute-peer', 'admin-unmute-peer', 'ping'
]);
const SENSITIVE_TYPES = new Set([
  'join-approve', 'join-reject', 'kick', 'ban', 'unban', 'promote',
  'companion-register', 'companion-revoke',
  'admin-mute-all', 'admin-unmute-all', 'admin-mute-peer', 'admin-unmute-peer'
]);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });
}

function isValidSignalMessage(parsed: Record<string, unknown>): boolean {
  if (typeof parsed.type !== 'string') return false;
  if (parsed.from !== undefined && typeof parsed.from !== 'string') return false;
  if (parsed.to !== undefined && typeof parsed.to !== 'string') return false;

  switch (parsed.type) {
    case 'hello':
    case 'profile':
      return parsed.profile !== undefined && typeof parsed.profile === 'object' && parsed.profile !== null;
    case 'description':
      return parsed.description !== undefined && typeof parsed.description === 'object' && parsed.description !== null;
    case 'candidate':
      return parsed.candidate === null || (typeof parsed.candidate === 'object' && parsed.candidate !== null);
    case 'media':
      return (parsed.screenSharing === undefined || typeof parsed.screenSharing === 'boolean')
        && (parsed.micEnabled === undefined || typeof parsed.micEnabled === 'boolean')
        && (parsed.cameraSharing === undefined || typeof parsed.cameraSharing === 'boolean')
        && (parsed.screenStreamId === undefined || typeof parsed.screenStreamId === 'string')
        && (parsed.cameraStreamId === undefined || typeof parsed.cameraStreamId === 'string');
    case 'companion-register':
      return typeof parsed.token === 'string';
    case 'voice-hello':
      return typeof parsed.parentPeerId === 'string' && typeof parsed.displayName === 'string';
    case 'voice-media':
      return typeof parsed.parentPeerId === 'string' && (parsed.micEnabled === undefined || typeof parsed.micEnabled === 'boolean');
    case 'admin-mute-all':
    case 'admin-unmute-all':
      return typeof parsed.at === 'number';
    case 'admin-mute-peer':
    case 'admin-unmute-peer':
      return typeof parsed.to === 'string' && typeof parsed.at === 'number';
    case 'admin-mute-state':
      return typeof parsed.targetPeerId === 'string' && typeof parsed.muted === 'boolean' && typeof parsed.at === 'number';
    case 'join-approve':
    case 'join-reject':
    case 'promote':
    case 'kick':
    case 'unban':
      return typeof parsed.to === 'string';
    case 'ping':
      return parsed.at === undefined || typeof parsed.at === 'number';
    default:
      return false;
  }
}

export class RoomObject extends DurableObject<Env> {
  private readonly messageRateLimits = new Map<string, number[]>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (origin && !isAllowedAppOrigin(origin)) {
      return json({ ok: false, error: 'Origin not allowed' }, 403);
    }

    if (url.pathname.endsWith('/profiles')) {
      return this.handleProfilesRequest(request, url);
    }

    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ ok: false, error: 'Expected WebSocket' }, 426);
    }

    if (this.ctx.getWebSockets().length >= MAX_ROOM_CONNECTIONS) {
      return json({ ok: false, error: 'Room connection limit reached' }, 503);
    }

    await this.cleanupExpiredTemporaryApprovals();
    await this.cleanupRateLimits();

    const peerId = sanitizeId(url.searchParams.get('peerId') || crypto.randomUUID());
    const stableClientId = sanitizeId(url.searchParams.get('stableClientId') || peerId);
    const displayName = sanitizeDisplayName(url.searchParams.get('name') || 'Friend');
    const kind: AttachmentKind = url.searchParams.get('kind') === 'voice' ? 'voice' : 'main';
    const parentPeerId = sanitizeOptionalId(url.searchParams.get('parentPeerId'));
    const voiceToken = (url.searchParams.get('voiceToken') || '').slice(0, 256);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const joinedAt = Date.now();
    const profileToken = kind === 'main' ? createSecretToken() : undefined;

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ peerId, stableClientId, displayName, joinedAt, approved: false, kind, parentPeerId, profileToken } satisfies Attachment);

    if (kind === 'voice') {
      const parentSocket = parentPeerId ? this.findMainSocket(parentPeerId) : undefined;
      const parent = parentSocket?.deserializeAttachment() as Attachment | undefined;
      if (!parent || !parent.approved || parent.kind !== 'main' || !parent.voiceToken || !constantTimeEqual(parent.voiceToken, voiceToken)) {
        safeSend(server, { type: 'server', event: 'voice-auth-failed', peerId, parentPeerId });
        try { server.close(4003, 'voice-auth-failed'); } catch { /* ignore */ }
        return new Response(null, { status: 101, webSocket: client });
      }
      server.serializeAttachment({ peerId, stableClientId, displayName: parent.displayName, joinedAt, approved: true, kind: 'voice', parentPeerId } satisfies Attachment);
      const voicePeers = this.getApprovedVoiceSockets()
        .filter((socket) => socket !== server)
        .map((socket) => socket.deserializeAttachment() as Attachment | undefined)
        .filter((item): item is Attachment => Boolean(item?.approved && item.kind === 'voice' && item.peerId && item.parentPeerId))
        .map((item) => ({ peerId: item.peerId, parentPeerId: item.parentPeerId!, displayName: item.displayName }));
      safeSend(server, { type: 'server', event: 'voice-joined', peerId, parentPeerId, voicePeers });
      await this.notifyVoicePeerJoined(server, { peerId, parentPeerId: parentPeerId!, displayName: parent.displayName });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (!(await this.checkRateLimit(`join:${stableClientId}`, MAX_JOIN_ATTEMPTS_PER_WINDOW))) {
      safeSend(server, { type: 'server', event: 'rate-limit-applied', detail: 'join', ownerId: await this.getOwnerId() });
      try { server.close(4008, 'rate-limit'); } catch { /* ignore */ }
      return new Response(null, { status: 101, webSocket: client });
    }

    const bans = await this.getBans();
    const banned = bans.find((item) => item.peerId === peerId || item.stableClientId === stableClientId || item.displayName.toLowerCase() === displayName.toLowerCase());
    if (banned) {
      await this.clearTemporaryApproval(stableClientId, peerId);
      safeSend(server, { type: 'server', event: 'banned-member-temporary-approval-cleared', peerId, ownerId: await this.getOwnerId() });
      safeSend(server, { type: 'server', event: 'banned', peerId, ownerId: await this.getOwnerId(), bans });
      try { server.close(4003, 'banned'); } catch { /* ignore */ }
      return new Response(null, { status: 101, webSocket: client });
    }

    const replacedSamePeerSocket = this.supersedeIdentitySocket(server, peerId, stableClientId);

    let owner = await this.getOwnerIdentity();
    const approvedSockets = this.getApprovedMainSockets();
    const firstRoomCreation = !owner && approvedSockets.length === 0;
    const isOwnerReconnect = Boolean(owner && owner.stableClientId === stableClientId);

    if (firstRoomCreation) {
      owner = await this.persistOwner({ peerId, stableClientId, displayName, createdAt: joinedAt, lastSeenAt: joinedAt, online: true });
      server.serializeAttachment({ peerId, stableClientId, displayName, joinedAt, approved: true, kind: 'main', profileToken } satisfies Attachment);
      await this.clearTemporaryApprovals();
      safeSend(server, { type: 'server', event: 'owner-persisted', peerId, ownerId: owner.peerId });
      safeSend(server, { type: 'server', event: 'joined', peerId, ownerId: owner.peerId, isOwner: true, peers: 1, roles: await this.getRoles(), profileToken });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (isOwnerReconnect && owner) {
      owner = await this.persistOwner({ ...owner, peerId, stableClientId, displayName, lastSeenAt: joinedAt, online: true });
      server.serializeAttachment({ peerId, stableClientId, displayName, joinedAt, approved: true, kind: 'main', profileToken } satisfies Attachment);
      safeSend(server, { type: 'server', event: 'owner-restored', peerId, ownerId: owner.peerId });
      safeSend(server, { type: 'server', event: 'owner-reconnected', peerId, ownerId: owner.peerId });
      safeSend(server, { type: 'server', event: 'joined', peerId, ownerId: owner.peerId, isOwner: true, peers: this.getApprovedMainSockets().length, roles: await this.getRoles(), profileToken });
      if (!replacedSamePeerSocket) await this.notifyPeerJoined(server, peerId, displayName);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (!owner && approvedSockets.length > 0) {
      const legacy = approvedSockets.map((socket) => socket.deserializeAttachment() as Attachment | undefined).filter((item): item is Attachment => Boolean(item?.approved && item.peerId)).sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (legacy) {
        owner = await this.persistOwner({ peerId: legacy.peerId, stableClientId: legacy.stableClientId, displayName: legacy.displayName, createdAt: legacy.joinedAt, lastSeenAt: Date.now(), online: true });
        for (const socket of approvedSockets) safeSend(socket, { type: 'server', event: 'legacy-owner-fallback-used', ownerId: owner.peerId });
      }
    }

    const temporaryApproval = await this.findTemporaryApproval(stableClientId);
    if (temporaryApproval) {
      await this.cacheTemporaryApproval({ stableClientId, peerId, displayName, approvedAt: temporaryApproval.approvedAt || Date.now() });
      server.serializeAttachment({ peerId, stableClientId, displayName, joinedAt, approved: true, kind: 'main', profileToken } satisfies Attachment);
      const ownerId = await this.getOwnerId();
      safeSend(server, { type: 'server', event: 'rejoin-approved', peerId, ownerId, isOwner: await this.isOwnerIdentity({ peerId, stableClientId }), roles: await this.getRoles(), profileToken });
      safeSend(server, { type: 'server', event: 'member-rejoined-within-grace-period', peerId, ownerId });
      if (!replacedSamePeerSocket) await this.notifyPeerJoined(server, peerId, displayName);
      await this.applyAdministrativeMuteToJoinedSocket(server, { peerId, stableClientId, displayName, joinedAt, approved: true, kind: 'main' });
      return new Response(null, { status: 101, webSocket: client });
    }

    const ownerId = await this.getOwnerId();
    if (owner && !this.findOwnerSocket(owner)) {
      for (const socket of this.getApprovedMainSockets()) safeSend(socket, { type: 'server', event: 'owner-offline-but-retained', ownerId });
    }
    safeSend(server, { type: 'server', event: 'pending-approval', peerId, ownerId });
    for (const socket of this.getApprovedMainSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | undefined;
      if (await this.canModerateAttachment(attachment)) {
        safeSend(socket, { type: 'server', event: 'join-request', peerId, displayName, requestedAt: joinedAt, ownerId });
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const byteLength = typeof message === 'string' ? new TextEncoder().encode(message).byteLength : message.byteLength;
    const source = ws.deserializeAttachment() as Attachment | undefined;
    const ownerId = await this.getOwnerId();
    if (byteLength > MAX_WS_MESSAGE_BYTES) {
      safeSend(ws, { type: 'server', event: 'oversized-message-rejected', maxBytes: MAX_WS_MESSAGE_BYTES, ownerId });
      return;
    }

    const payload = typeof message === 'string' ? message : new TextDecoder().decode(message);
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(payload) as Record<string, unknown>; }
    catch { return; }

    const msgType = typeof parsed.type === 'string' ? parsed.type : '';
    const rateKey = source?.stableClientId || source?.peerId || 'anonymous';
    if (!this.checkMessageRateLimit(rateKey)) {
      safeSend(ws, { type: 'server', event: 'rate-limit-applied', detail: 'signaling', ownerId });
      return;
    }
    if (msgType === 'ping') {
      safeSend(ws, { type: 'server', event: 'pong', at: Date.now(), ownerId });
      return;
    }
    if (!KNOWN_SIGNAL_TYPES.has(msgType) || !isValidSignalMessage(parsed)) {
      safeSend(ws, { type: 'server', event: 'unknown-message-type-ignored', messageType: msgType || 'missing', ownerId });
      return;
    }

    if (SENSITIVE_TYPES.has(msgType) && !(await this.checkRateLimit(`sensitive:${source?.stableClientId || source?.peerId || 'anon'}`, MAX_SENSITIVE_MESSAGES_PER_WINDOW))) {
      safeSend(ws, { type: 'server', event: 'rate-limit-applied', detail: msgType, ownerId });
      return;
    }

    const targetPeerId = typeof parsed.to === 'string' ? parsed.to : '';
    // Do not trust the client supplied `from`. Forward messages as coming from the real socket identity.
    if (source?.peerId) parsed.from = source.peerId;
    if (source?.peerId && (msgType === 'hello' || msgType === 'profile')) {
      parsed.profile = sanitizePublicProfile(parsed.profile, source.peerId, source.displayName);
    }

    if (source?.kind === 'voice') {
      if (!source.approved || !['voice-hello', 'description', 'candidate', 'voice-media'].includes(msgType)) return;
      const forwarded = JSON.stringify(parsed);
      for (const socket of this.getApprovedVoiceSockets()) {
        if (socket === ws) continue;
        const attachment = socket.deserializeAttachment() as Attachment | undefined;
        if (targetPeerId && attachment?.peerId !== targetPeerId) continue;
        safeRawSend(socket, forwarded);
      }
      return;
    }

    if (msgType === 'companion-register' || msgType === 'companion-revoke') {
      if (!source?.approved || source.kind !== 'main') return;
      if (msgType === 'companion-revoke') {
        source.voiceToken = undefined;
        ws.serializeAttachment(source);
        this.closeVoiceCompanions(source.peerId, 'voice-token-revoked');
        safeSend(ws, { type: 'server', event: 'companion-revoked', ownerId });
        return;
      }
      const token = typeof parsed.token === 'string' ? parsed.token.slice(0, 256) : '';
      if (token.length < 24) {
        safeSend(ws, { type: 'server', event: 'companion-register-failed', detail: 'invalid-token', ownerId });
        return;
      }
      source.voiceToken = token;
      ws.serializeAttachment(source);
      safeSend(ws, { type: 'server', event: 'companion-registered', ownerId });
      return;
    }

    if (msgType === 'admin-mute-all' || msgType === 'admin-unmute-all') {
      const isOwner = Boolean(source && source.approved && source.kind === 'main' && await this.isOwnerIdentity(source));
      if (!isOwner) {
        safeSend(ws, { type: 'server', event: 'moderation-denied', action: msgType, ownerId });
        return;
      }

      const muted = msgType === 'admin-mute-all';
      await this.ctx.storage.put('globalMuteActive', muted);
      if (!muted) await this.ctx.storage.put('adminMutedPeers', []);
      const command = JSON.stringify({
        type: msgType,
        from: source!.peerId,
        at: Date.now()
      });

      for (const socket of this.getApprovedMainSockets()) {
        if (socket === ws) continue;
        safeRawSend(socket, command);
      }

      safeSend(ws, { type: 'server', event: 'moderation-applied', action: msgType, ownerId, globalMuteActive: muted });
      return;
    }

    if (msgType === 'admin-mute-peer' || msgType === 'admin-unmute-peer') {
      const allowed = Boolean(source && source.approved && source.kind === 'main' && await this.canModerateAttachment(source));
      if (!allowed || !targetPeerId || targetPeerId === ownerId) {
        safeSend(ws, { type: 'server', event: 'moderation-denied', action: msgType, ownerId });
        return;
      }

      const targetSocket = this.findSocket(targetPeerId);
      const targetAttachment = targetSocket?.deserializeAttachment() as Attachment | undefined;
      if (!targetSocket || !targetAttachment?.approved || targetAttachment.kind !== 'main') return;

      const muted = msgType === 'admin-mute-peer';
      await this.setPeerAdminMuted(targetPeerId, muted);
      safeRawSend(targetSocket, JSON.stringify({
        type: msgType,
        from: source!.peerId,
        to: targetPeerId,
        at: Date.now()
      }));

      const state = JSON.stringify({
        type: 'admin-mute-state',
        from: source!.peerId,
        targetPeerId,
        muted,
        at: Date.now()
      });

      for (const socket of this.getApprovedMainSockets()) {
        if (socket === ws) continue;
        safeRawSend(socket, state);
      }

      safeSend(ws, { type: 'server', event: 'moderation-applied', action: msgType, targetPeerId, ownerId });
      return;
    }

    if (msgType === 'join-approve' || msgType === 'join-reject') {
      if (!source || !(await this.canModerateAttachment(source)) || !targetPeerId) {
        safeSend(ws, { type: 'server', event: 'kick-denied', ownerId });
        return;
      }
      const targetSocket = this.findSocket(targetPeerId);
      const targetAttachment = targetSocket?.deserializeAttachment() as Attachment | undefined;
      if (!targetSocket || !targetAttachment) return;

      if (msgType === 'join-reject') {
        safeSend(targetSocket, { type: 'server', event: 'join-rejected', by: source.peerId, ownerId });
        try { targetSocket.close(4004, 'join-rejected'); } catch { /* ignore */ }
        return;
      }

      targetSocket.serializeAttachment({ ...targetAttachment, approved: true } satisfies Attachment);
      await this.cacheTemporaryApproval({ stableClientId: targetAttachment.stableClientId, peerId: targetPeerId, displayName: targetAttachment.displayName, approvedAt: Date.now() });
      const roles = await this.getRoles();
      safeSend(targetSocket, { type: 'server', event: 'join-approved', peerId: targetPeerId, ownerId, isOwner: await this.isOwnerIdentity(targetAttachment), roles, profileToken: targetAttachment.profileToken });
      safeSend(ws, { type: 'server', event: 'temporary-approval-cached', peerId: targetPeerId, ownerId });
      await this.notifyPeerJoined(targetSocket, targetPeerId, targetAttachment.displayName, roles);
      await this.applyAdministrativeMuteToJoinedSocket(targetSocket, { ...targetAttachment, approved: true });
      return;
    }

    if (msgType === 'promote') {
      if (!source || !(await this.isOwnerIdentity(source)) || !targetPeerId || targetPeerId === ownerId) {
        safeSend(ws, { type: 'server', event: 'kick-denied', ownerId });
        return;
      }
      const target = this.findSocket(targetPeerId)?.deserializeAttachment() as Attachment | undefined;
      if (!target?.approved || !target.stableClientId) {
        safeSend(ws, { type: 'server', event: 'kick-denied', ownerId });
        return;
      }
      await this.addModerator(target.stableClientId);
      await this.broadcastRoles();
      return;
    }

    if (msgType === 'kick') {
      if (!source || !(await this.canModerateAttachment(source)) || !targetPeerId || targetPeerId === ownerId) {
        safeSend(ws, { type: 'server', event: 'kick-denied', ownerId });
        return;
      }

      const targetSocket = this.findSocket(targetPeerId);
      const targetAttachment = targetSocket?.deserializeAttachment() as Attachment | undefined;
      await this.clearTemporaryApproval(targetAttachment?.stableClientId, targetPeerId);
      await this.setPeerAdminMuted(targetPeerId, false);
      const bans = await this.addBan({ peerId: targetPeerId, stableClientId: targetAttachment?.stableClientId, displayName: targetAttachment?.displayName || targetPeerId, kickedAt: Date.now() });
      const roles = await this.getRoles();

      for (const socket of this.getApprovedMainSockets()) {
        const attachment = socket.deserializeAttachment() as Attachment | undefined;
        if (attachment?.peerId === targetPeerId) {
          safeSend(socket, parsed);
          try { socket.close(4001, 'kicked'); } catch { /* ignore */ }
        } else {
          safeSend(socket, { type: 'server', event: 'peer-kicked', peerId: targetPeerId, by: source.peerId, ownerId, bans, roles });
          safeSend(socket, { type: 'server', event: 'banned-member-temporary-approval-cleared', peerId: targetPeerId, ownerId });
        }
      }
      return;
    }

    if (msgType === 'unban') {
      if (!source || !(await this.canModerateAttachment(source))) {
        safeSend(ws, { type: 'server', event: 'kick-denied', ownerId });
        return;
      }
      const bans = targetPeerId === '__list__' ? await this.getBans() : await this.removeBan(targetPeerId);
      safeSend(ws, { type: 'server', event: 'bans-list', ownerId, bans });
      return;
    }

    if (!source?.approved || source.kind !== 'main') return;

    const forwarded = JSON.stringify(parsed);
    for (const socket of this.getApprovedMainSockets()) {
      if (socket === ws) continue;
      if (targetPeerId) {
        const attachment = socket.deserializeAttachment() as Attachment | undefined;
        if (attachment?.peerId !== targetPeerId) continue;
      }
      safeRawSend(socket, forwarded);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> { await this.handleDisconnect(ws, 'peer-left'); }
  async webSocketError(ws: WebSocket): Promise<void> { await this.handleDisconnect(ws, 'peer-error'); }

  private async getOwnerIdentity(): Promise<OwnerIdentity | undefined> {
    return (await this.ctx.storage.get<OwnerIdentity>('ownerIdentity')) || undefined;
  }

  private async persistOwner(owner: OwnerIdentity): Promise<OwnerIdentity> {
    await this.ctx.storage.put('ownerIdentity', owner);
    return owner;
  }

  private async getOwnerId(): Promise<string> {
    return (await this.getOwnerIdentity())?.peerId || '';
  }

  private async isOwnerIdentity(attachment?: Partial<Attachment>): Promise<boolean> {
    const owner = await this.getOwnerIdentity();
    if (!owner || !attachment || attachment.kind === 'voice') return false;
    return Boolean(attachment.stableClientId && attachment.stableClientId === owner.stableClientId);
  }

  private findOwnerSocket(owner: OwnerIdentity): WebSocket | undefined {
    return this.ctx.getWebSockets().find((socket) => {
      const attachment = socket.deserializeAttachment() as Attachment | undefined;
      return Boolean(attachment?.approved && attachment.kind === 'main' && attachment.stableClientId === owner.stableClientId);
    });
  }

  private async getBans(): Promise<BannedMember[]> {
    return (await this.ctx.storage.get<BannedMember[]>('bans')) || [];
  }

  private async addBan(member: BannedMember): Promise<BannedMember[]> {
    const current = await this.getBans();
    const next = [member, ...current.filter((item) => item.peerId !== member.peerId && item.stableClientId !== member.stableClientId && item.displayName.toLowerCase() !== member.displayName.toLowerCase())].slice(0, 100);
    await this.ctx.storage.put('bans', next);
    if (member.stableClientId) await this.clearTemporaryApproval(member.stableClientId, member.peerId);
    return next;
  }

  private async removeBan(peerId: string): Promise<BannedMember[]> {
    const next = (await this.getBans()).filter((item) => item.peerId !== peerId && item.stableClientId !== peerId);
    await this.ctx.storage.put('bans', next);
    return next;
  }

  private async getTemporaryApprovals(): Promise<TemporaryApproval[]> {
    return (await this.ctx.storage.get<TemporaryApproval[]>('temporaryApprovals')) || [];
  }

  private async putTemporaryApprovals(approvals: TemporaryApproval[]): Promise<void> {
    await this.ctx.storage.put('temporaryApprovals', approvals.slice(0, 200));
  }

  private async cacheTemporaryApproval(approval: TemporaryApproval): Promise<void> {
    const current = await this.getTemporaryApprovals();
    const next = [approval, ...current.filter((item) => item.stableClientId !== approval.stableClientId)].slice(0, 200);
    await this.putTemporaryApprovals(next);
  }

  private async findTemporaryApproval(stableClientId: string): Promise<TemporaryApproval | undefined> {
    if (!stableClientId) return undefined;
    await this.cleanupExpiredTemporaryApprovals();
    const bans = await this.getBans();
    if (bans.some((item) => item.stableClientId === stableClientId)) {
      await this.clearTemporaryApproval(stableClientId);
      return undefined;
    }
    const approval = (await this.getTemporaryApprovals()).find((item) => item.stableClientId === stableClientId);
    if (!approval) return undefined;
    if (approval.expiresAt && approval.expiresAt < Date.now()) return undefined;
    return approval;
  }

  private async markTemporaryApprovalDisconnected(attachment: Attachment): Promise<void> {
    if (!attachment.approved || !attachment.stableClientId) return;
    if (await this.isOwnerIdentity(attachment)) return;
    const current = await this.getTemporaryApprovals();
    const existing = current.find((item) => item.stableClientId === attachment.stableClientId);
    const nextItem: TemporaryApproval = {
      stableClientId: attachment.stableClientId,
      peerId: attachment.peerId,
      displayName: attachment.displayName,
      approvedAt: existing?.approvedAt || Date.now(),
      disconnectedAt: Date.now(),
      expiresAt: Date.now() + TEMP_APPROVAL_GRACE_MS
    };
    await this.putTemporaryApprovals([nextItem, ...current.filter((item) => item.stableClientId !== attachment.stableClientId)]);
  }

  private async cleanupExpiredTemporaryApprovals(): Promise<void> {
    const current = await this.getTemporaryApprovals();
    const now = Date.now();
    const next = current.filter((item) => !item.expiresAt || item.expiresAt > now);
    if (next.length !== current.length) {
      await this.putTemporaryApprovals(next);
      const ownerId = await this.getOwnerId();
      for (const socket of this.getApprovedMainSockets()) safeSend(socket, { type: 'server', event: 'stale-temporary-approval-cleanup-completed', ownerId });
      for (const socket of this.getApprovedMainSockets()) safeSend(socket, { type: 'server', event: 'temporary-approval-expired', ownerId });
    }
  }

  private async clearTemporaryApproval(stableClientId?: string, peerId?: string): Promise<void> {
    const current = await this.getTemporaryApprovals();
    const next = current.filter((item) => item.stableClientId !== stableClientId && item.peerId !== peerId);
    if (next.length !== current.length) await this.putTemporaryApprovals(next);
  }

  private async clearTemporaryApprovals(): Promise<void> {
    await this.ctx.storage.put('temporaryApprovals', []);
  }

  private getApprovedMainSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => {
      const attachment = socket.deserializeAttachment() as Attachment | undefined;
      return Boolean(attachment?.approved && attachment.kind === 'main');
    });
  }

  private getApprovedVoiceSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => {
      const attachment = socket.deserializeAttachment() as Attachment | undefined;
      return Boolean(attachment?.approved && attachment.kind === 'voice');
    });
  }

  private findMainSocket(peerId: string): WebSocket | undefined {
    return this.ctx.getWebSockets().find((socket) => {
      const attachment = socket.deserializeAttachment() as Attachment | undefined;
      return attachment?.kind === 'main' && attachment.peerId === peerId;
    });
  }

  private findSocket(peerId: string): WebSocket | undefined {
    return this.findMainSocket(peerId);
  }

  private closeVoiceCompanions(parentPeerId: string, reason: string): void {
    for (const socket of this.getApprovedVoiceSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | undefined;
      if (attachment?.parentPeerId !== parentPeerId) continue;
      safeSend(socket, { type: 'server', event: 'voice-parent-left', parentPeerId });
      try { socket.close(4000, reason); } catch { /* ignore */ }
    }
  }

  private async isGlobalMuteActive(): Promise<boolean> {
    return Boolean(await this.ctx.storage.get<boolean>('globalMuteActive'));
  }

  private async getAdminMutedPeers(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>('adminMutedPeers')) || [];
  }

  private async setPeerAdminMuted(peerId: string, muted: boolean): Promise<void> {
    const current = await this.getAdminMutedPeers();
    const next = muted
      ? Array.from(new Set([...current, peerId])).slice(0, 500)
      : current.filter((item) => item !== peerId);
    await this.ctx.storage.put('adminMutedPeers', next);
  }

  private async applyAdministrativeMuteToJoinedSocket(socket: WebSocket, attachment: Attachment): Promise<void> {
    if (!attachment.approved || attachment.kind !== 'main') return;
    if (await this.isOwnerIdentity(attachment)) return;

    const ownerId = await this.getOwnerId();
    if (await this.isGlobalMuteActive()) {
      safeRawSend(socket, JSON.stringify({
        type: 'admin-mute-all',
        from: ownerId,
        at: Date.now()
      }));
      return;
    }

    const mutedPeers = await this.getAdminMutedPeers();
    if (mutedPeers.includes(attachment.peerId)) {
      safeRawSend(socket, JSON.stringify({
        type: 'admin-mute-peer',
        from: ownerId,
        to: attachment.peerId,
        at: Date.now()
      }));
    }
  }

  private async getModerators(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>('moderators')) || [];
  }

  private async addModerator(peerId: string): Promise<void> {
    const current = await this.getModerators();
    if (!current.includes(peerId)) await this.ctx.storage.put('moderators', [...current, peerId].slice(0, 50));
  }

  private async canModerateAttachment(attachment?: Attachment): Promise<boolean> {
    if (!attachment?.peerId || attachment.kind !== 'main') return false;
    if (await this.isOwnerIdentity(attachment)) return true;
    return Boolean(attachment.stableClientId && (await this.getModerators()).includes(attachment.stableClientId));
  }

  private async getRoles(): Promise<Record<string, RoomRole>> {
    const owner = await this.getOwnerIdentity();
    const moderators = await this.getModerators();
    const roles: Record<string, RoomRole> = {};
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | undefined;
      if (!attachment?.peerId || !attachment.approved || attachment.kind !== 'main') continue;
      roles[attachment.peerId] = owner && attachment.stableClientId === owner.stableClientId
        ? 'owner'
        : moderators.includes(attachment.stableClientId) ? 'moderator' : 'member';
    }
    return roles;
  }

  private async broadcastRoles() {
    const roles = await this.getRoles();
    const ownerId = await this.getOwnerId();
    for (const socket of this.getApprovedMainSockets()) safeSend(socket, { type: 'server', event: 'roles', ownerId, roles });
  }

  private supersedeIdentitySocket(replacement: WebSocket, peerId: string, stableClientId: string): boolean {
    let replaced = false;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === replacement) continue;
      const attachment = socket.deserializeAttachment() as Attachment | undefined;
      if (!attachment?.approved || attachment.kind !== 'main' || (attachment.peerId !== peerId && attachment.stableClientId !== stableClientId)) continue;
      replaced = true;
      socket.serializeAttachment({ ...attachment, approved: false } satisfies Attachment);
      try { socket.close(4009, 'superseded-connection'); } catch { /* ignore */ }
    }
    return replaced;
  }

  private async notifyPeerJoined(joinedSocket: WebSocket, peerId: string, displayName: string, rolesArg?: Record<string, RoomRole>) {
    const ownerId = await this.getOwnerId();
    const roles = rolesArg || await this.getRoles();
    const peers = this.getApprovedMainSockets().length;
    for (const socket of this.getApprovedMainSockets()) {
      if (socket === joinedSocket) continue;
      safeSend(socket, { type: 'server', event: 'peer-joined', peerId, displayName, ownerId, peers, roles });
    }
  }

  private async notifyVoicePeerJoined(joinedSocket: WebSocket, info: { peerId: string; parentPeerId: string; displayName: string }) {
    for (const socket of this.getApprovedVoiceSockets()) {
      if (socket === joinedSocket) continue;
      safeSend(socket, { type: 'server', event: 'voice-peer-joined', ...info });
    }
  }

  private async handleDisconnect(source: WebSocket, event: string) {
    const attachment = source.deserializeAttachment() as Attachment | undefined;
    if (!attachment?.approved) return;
    source.serializeAttachment({ ...attachment, approved: false } satisfies Attachment);
    if (attachment.kind === 'voice') {
      for (const socket of this.getApprovedVoiceSockets()) {
        if (socket !== source) safeSend(socket, { type: 'server', event: 'voice-peer-left', peerId: attachment.peerId, parentPeerId: attachment.parentPeerId });
      }
      return;
    }
    const replacementStillOnline = this.getApprovedMainSockets().some((socket) => {
      if (socket === source) return false;
      const candidate = socket.deserializeAttachment() as Attachment | undefined;
      return Boolean(
        candidate?.approved
        && candidate.kind === 'main'
        && (candidate.peerId === attachment.peerId || candidate.stableClientId === attachment.stableClientId)
      );
    });
    if (replacementStillOnline) return;
    this.closeVoiceCompanions(attachment.peerId, 'voice-parent-disconnected');
    const owner = await this.getOwnerIdentity();
    if (owner && attachment.stableClientId === owner.stableClientId) {
      await this.persistOwner({ ...owner, online: false, lastSeenAt: Date.now() });
      for (const socket of this.getApprovedMainSockets()) if (socket !== source) safeSend(socket, { type: 'server', event: 'owner-offline-but-retained', ownerId: owner.peerId });
    } else {
      await this.markTemporaryApprovalDisconnected(attachment);
    }
    const peers = Math.max(0, this.getApprovedMainSockets().filter((socket) => socket !== source).length);
    const ownerId = await this.getOwnerId();
    const roles = await this.getRoles();
    for (const socket of this.getApprovedMainSockets()) {
      if (socket !== source) safeSend(socket, { type: 'server', event, peerId: attachment.peerId, peers, ownerId, roles });
    }
    await this.ctx.storage.delete(profileStorageKey(attachment.peerId));
  }

  private checkMessageRateLimit(key: string): boolean {
    const now = Date.now();
    const fresh = (this.messageRateLimits.get(key) || []).filter((at) => now - at < RATE_LIMIT_WINDOW_MS);
    if (fresh.length >= MAX_SIGNAL_MESSAGES_PER_WINDOW) return false;
    fresh.push(now);
    this.messageRateLimits.set(key, fresh);
    if (this.messageRateLimits.size > MAX_ROOM_CONNECTIONS * 2) {
      for (const [entryKey, entries] of this.messageRateLimits) {
        if (!entries.some((at) => now - at < RATE_LIMIT_WINDOW_MS)) this.messageRateLimits.delete(entryKey);
      }
    }
    return true;
  }

  private authorizedProfileAttachment(request: Request): Attachment | undefined {
    const authorization = request.headers.get('Authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!token) return undefined;
    for (const socket of this.getApprovedMainSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | undefined;
      if (attachment?.profileToken && constantTimeEqual(attachment.profileToken, token)) return attachment;
    }
    return undefined;
  }

  private async handleProfilesRequest(request: Request, url: URL): Promise<Response> {
    if (request.method === 'OPTIONS') return json({ ok: true });
    const source = this.authorizedProfileAttachment(request);
    if (!source) return json({ ok: false, error: 'Profile authorization required' }, 401);

    if (request.method === 'GET') {
      const ids = Array.from(new Set((url.searchParams.get('ids') || '').split(',').map(sanitizeOptionalId).filter((id): id is string => Boolean(id)))).slice(0, MAX_PROFILE_BATCH_IDS);
      if (ids.length === 0) return json({ ok: true, assets: {} });
      const keys = ids.map(profileStorageKey);
      const stored = await this.ctx.storage.get<ProfileAsset>(keys);
      const assets: Record<string, ProfileAsset> = {};
      for (const [key, asset] of stored) {
        if (asset?.peerId && keys.includes(key)) assets[asset.peerId] = asset;
      }
      return json({ ok: true, assets });
    }

    if (request.method === 'PUT') {
      const declaredLength = Number(request.headers.get('content-length') || 0);
      if (declaredLength > MAX_PROFILE_REQUEST_BYTES) return json({ ok: false, error: 'Profile payload too large' }, 413);
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_PROFILE_REQUEST_BYTES) return json({ ok: false, error: 'Profile payload too large' }, 413);
      let parsed: { avatar?: unknown; version?: unknown };
      try { parsed = JSON.parse(raw) as { avatar?: unknown; version?: unknown }; }
      catch { return json({ ok: false, error: 'Invalid profile payload' }, 400); }
      const avatar = parsed.avatar === null ? null : typeof parsed.avatar === 'string' ? parsed.avatar : undefined;
      const version = typeof parsed.version === 'string' ? parsed.version.slice(0, 80) : '';
      if (avatar === undefined || !version || !isSafeAvatarDataUrl(avatar)) return json({ ok: false, error: 'Invalid profile asset' }, 400);
      const asset: ProfileAsset = { peerId: source.peerId, avatar, version, updatedAt: Date.now() };
      await this.ctx.storage.put(profileStorageKey(source.peerId), asset);
      return json({ ok: true, asset });
    }

    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  private async getRateLimits(): Promise<RateEntry[]> {
    return (await this.ctx.storage.get<RateEntry[]>('rateLimits')) || [];
  }

  private async putRateLimits(entries: RateEntry[]): Promise<void> {
    await this.ctx.storage.put('rateLimits', entries.slice(0, 500));
  }

  private async cleanupRateLimits(): Promise<void> {
    const now = Date.now();
    const current = await this.getRateLimits();
    const next = current.map((entry) => ({ ...entry, at: entry.at.filter((value) => now - value < RATE_LIMIT_WINDOW_MS) })).filter((entry) => entry.at.length > 0);
    if (next.length !== current.length) await this.putRateLimits(next);
  }

  private async checkRateLimit(key: string, maxCount: number): Promise<boolean> {
    const now = Date.now();
    const current = await this.getRateLimits();
    const existing = current.find((entry) => entry.key === key);
    const fresh = (existing?.at || []).filter((value) => now - value < RATE_LIMIT_WINDOW_MS);
    if (fresh.length >= maxCount) return false;
    const nextEntry = { key, at: [...fresh, now] };
    await this.putRateLimits([nextEntry, ...current.filter((entry) => entry.key !== key)]);
    return true;
  }
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96) || crypto.randomUUID();
}

function sanitizeOptionalId(value: string | null): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96);
  return cleaned || undefined;
}

function sanitizeDisplayName(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return cleaned || 'Friend';
}

function sanitizePublicProfile(value: unknown, peerId: string, fallbackName: string): Record<string, unknown> {
  const profile = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const capabilities = profile.capabilities && typeof profile.capabilities === 'object'
    ? profile.capabilities as Record<string, unknown>
    : {};
  return {
    peerId,
    displayName: sanitizeDisplayName(typeof profile.displayName === 'string' ? profile.displayName : fallbackName),
    status: typeof profile.status === 'string' ? profile.status.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) : 'Online',
    avatarVersion: typeof profile.avatarVersion === 'string' ? profile.avatarVersion.slice(0, 80) : 'none',
    capabilities: {
      rtpVoice: capabilities.rtpVoice === true,
      voiceCompanion: capabilities.voiceCompanion === true,
      rtcDiagnosticsVersion: Number.isSafeInteger(capabilities.rtcDiagnosticsVersion) ? Math.max(0, Math.min(10, Number(capabilities.rtcDiagnosticsVersion))) : 0
    }
  };
}

function createSecretToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function profileStorageKey(peerId: string): string {
  return `profile:${sanitizeId(peerId)}`;
}

function isSafeAvatarDataUrl(value: string | null): boolean {
  if (value === null) return true;
  if (value.length > MAX_PROFILE_AVATAR_CHARS) return false;
  return /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(value);
}

function isAllowedAppOrigin(value: string): boolean {
  try {
    const origin = new URL(value);
    if (origin.protocol === 'tauri:' && origin.hostname === 'localhost') return true;
    if ((origin.protocol === 'http:' || origin.protocol === 'https:') && origin.hostname === 'tauri.localhost') return true;
    return (origin.protocol === 'http:' || origin.protocol === 'https:') && (origin.hostname === '127.0.0.1' || origin.hostname === 'localhost');
  } catch {
    return false;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  if (!left || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

function safeSend(socket: WebSocket, data: unknown) {
  safeRawSend(socket, JSON.stringify(data));
}

function safeRawSend(socket: WebSocket, data: string) {
  try { socket.send(data); } catch { /* disconnected */ }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return json({ ok: true });
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '');
    const match = pathname.match(/^\/room\/([a-zA-Z0-9_-]{1,128})\/(?:ws|profiles)$/);
    if (!match) return json({ ok: true, service: 'MHTalk signaling', version: '0.9.2' });
    const id = env.ROOMS.idFromName(match[1]);
    return env.ROOMS.get(id).fetch(request);
  }
};
