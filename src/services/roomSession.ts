import { RealtimeRoom } from './realtime';

/**
 * Application-facing room boundary.
 *
 * The UI imports this module instead of constructing a WebRTC implementation.
 * A future SFU adapter can replace the implementation here without coupling React
 * components to signaling or peer-connection details.
 */
export type RoomSessionOptions = ConstructorParameters<typeof RealtimeRoom>[0];
export type RoomSession = InstanceType<typeof RealtimeRoom>;

export type MediaBackend = 'mesh' | 'livekit';

export function configuredMediaBackend(): MediaBackend {
  return import.meta.env.VITE_MEDIA_BACKEND === 'livekit' ? 'livekit' : 'mesh';
}

export async function createRoomSession(options: RoomSessionOptions): Promise<RoomSession> {
  if (configuredMediaBackend() === 'livekit') {
    const { LiveKitVoiceRoomSession } = await import('./media/livekitVoiceRoomSession');
    return new LiveKitVoiceRoomSession(options);
  }
  return new RealtimeRoom(options);
}
