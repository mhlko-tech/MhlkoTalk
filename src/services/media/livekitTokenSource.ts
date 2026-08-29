import type { ProfileAssetAccess } from '../profileAssets';

export type LiveKitConnectionDetails = {
  serverUrl: string;
  participantToken: string;
  expiresIn: number;
};

export function liveKitTokenEndpoint(access: ProfileAssetAccess): string {
  const url = new URL(access.endpointUrl);
  if (!url.pathname.endsWith('/profiles')) throw new Error('Unexpected room authorization endpoint');
  url.pathname = `${url.pathname.slice(0, -'/profiles'.length)}/media-token`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function fetchLiveKitConnectionDetails(
  access: ProfileAssetAccess,
  signal?: AbortSignal
): Promise<LiveKitConnectionDetails> {
  const response = await fetch(liveKitTokenEndpoint(access), {
    method: 'POST',
    headers: { Authorization: `Bearer ${access.token}` },
    signal
  });
  if (!response.ok) throw new Error(`SFU authorization failed (${response.status})`);
  const value = await response.json() as {
    server_url?: unknown;
    participant_token?: unknown;
    expires_in?: unknown;
  };
  const serverUrl = typeof value.server_url === 'string' ? value.server_url : '';
  const participantToken = typeof value.participant_token === 'string' ? value.participant_token : '';
  const expiresIn = Number(value.expires_in || 0);
  if (!/^wss:\/\//i.test(serverUrl) || participantToken.split('.').length !== 3) {
    throw new Error('SFU authorization returned invalid connection details');
  }
  return {
    serverUrl,
    participantToken,
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : 0
  };
}
