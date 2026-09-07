/** Screen media is music/system audio; microphone voice processing must not touch it. */
export function screenAudioConstraints(): MediaTrackConstraints {
  return {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
    sampleRate: { ideal: 48_000 },
  };
}
