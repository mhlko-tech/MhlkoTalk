export type LiveKitTokenClaims = {
  room: string;
  identity: string;
  name: string;
  role: 'owner' | 'moderator' | 'member';
};

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export async function createLiveKitJoinToken(
  apiKey: string,
  apiSecret: string,
  claims: LiveKitTokenClaims,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<string> {
  if (apiKey.length < 3 || apiSecret.length < 16) throw new Error('LiveKit credentials are not configured safely');
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(claims.room)) throw new Error('Invalid LiveKit room');
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(claims.identity)) throw new Error('Invalid LiveKit identity');

  const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeJson({
    exp: nowSeconds + 5 * 60,
    iss: apiKey,
    nbf: nowSeconds - 5,
    sub: claims.identity,
    name: claims.name.slice(0, 80),
    jti: crypto.randomUUID(),
    metadata: JSON.stringify({ role: claims.role }),
    video: {
      room: claims.room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false
    }
  });
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(apiSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

export function normalizeLiveKitUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'https:') throw new Error('LiveKit URL must use TLS');
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}
