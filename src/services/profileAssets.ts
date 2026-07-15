import type { PeerProfile } from '../types/models';

export type ProfileAssetAccess = {
  endpointUrl: string;
  token: string;
  generation: number;
};

export type ProfileAsset = {
  peerId: string;
  avatar: string | null;
  version: string;
  updatedAt: number;
};

const PROFILE_BATCH_SIZE = 100;
export const MAX_PROFILE_SOURCE_IMAGE_BYTES = 32 * 1024 * 1024;
const TARGET_AVATAR_BYTES = 220 * 1024;
const MAX_AVATAR_EDGE = 512;

export function profileAvatarVersion(avatar: string | null | undefined): string {
  if (!avatar) return 'none';
  let hash = 0x811c9dc5;
  for (let index = 0; index < avatar.length; index += 1) {
    hash ^= avatar.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${avatar.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

export function profileEndpointFromSignaling(signalingUrl: string, roomId: string): string {
  const url = new URL(signalingUrl);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  else throw new Error('Unsupported signaling protocol');
  url.pathname = `/room/${encodeURIComponent(roomId)}/profiles`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function fetchProfileAssets(
  access: ProfileAssetAccess,
  peers: Array<Pick<PeerProfile, 'peerId' | 'avatarVersion'>>,
  signal?: AbortSignal
): Promise<Record<string, ProfileAsset>> {
  const uniquePeers = Array.from(new Map(peers.filter((peer) => peer.peerId).map((peer) => [peer.peerId, peer])).values());
  const batches: Array<typeof uniquePeers> = [];
  for (let index = 0; index < uniquePeers.length; index += PROFILE_BATCH_SIZE) batches.push(uniquePeers.slice(index, index + PROFILE_BATCH_SIZE));

  const responses = await Promise.all(batches.map(async (batch) => {
    const url = new URL(access.endpointUrl);
    url.searchParams.set('ids', batch.map((peer) => peer.peerId).join(','));
    url.searchParams.set('v', batch.map((peer) => `${peer.peerId}:${peer.avatarVersion || 'none'}`).join('|'));
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${access.token}` },
      cache: 'no-store',
      signal
    });
    if (!response.ok) throw new Error(`Profile asset fetch failed (${response.status})`);
    const payload = await response.json() as { assets?: Record<string, ProfileAsset> };
    return payload.assets || {};
  }));

  return Object.assign({}, ...responses) as Record<string, ProfileAsset>;
}

export async function publishProfileAvatar(
  access: ProfileAssetAccess,
  avatar: string | null,
  version: string
): Promise<ProfileAsset> {
  const optimized = avatar ? await optimizeAvatarDataUrl(avatar) : null;
  const response = await fetch(access.endpointUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${access.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ avatar: optimized, version }),
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`Profile asset publish failed (${response.status})`);
  const payload = await response.json() as { asset?: ProfileAsset };
  if (!payload.asset) throw new Error('Profile asset publish returned no asset');
  return payload.asset;
}

async function optimizeAvatarDataUrl(dataUrl: string): Promise<string> {
  const blob = dataUrlToBlob(dataUrl);
  if (!blob.type.startsWith('image/') || blob.size > MAX_PROFILE_SOURCE_IMAGE_BYTES) throw new Error('Profile image is invalid or too large');
  if (blob.size <= TARGET_AVATAR_BYTES && /image\/(?:png|jpeg|webp|gif)/i.test(blob.type)) return dataUrl;

  const bitmap = await createImageBitmap(blob);
  try {
    let scale = Math.min(1, MAX_AVATAR_EDGE / Math.max(bitmap.width, bitmap.height));
    let quality = 0.86;
    let result: Blob | null = null;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Profile image processor is unavailable');
      context.drawImage(bitmap, 0, 0, width, height);
      result = await canvasToBlob(canvas, 'image/webp', quality);
      if (result.size <= TARGET_AVATAR_BYTES) break;
      scale *= 0.82;
      quality = Math.max(0.62, quality - 0.06);
    }
    if (!result || result.size > TARGET_AVATAR_BYTES) throw new Error('Profile image could not be optimized safely');
    return blobToDataUrl(result);
  } finally {
    bitmap.close();
  }
}

function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]+);base64,([a-zA-Z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error('Profile image data is invalid');
  const binary = atob(match[2]);
  if (binary.length > MAX_PROFILE_SOURCE_IMAGE_BYTES) throw new Error('Profile image is too large');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: match[1] });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Profile image encoding failed')), type, quality));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Profile image read failed'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(blob);
  });
}
