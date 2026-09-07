/** Screen media is music/system audio; microphone voice processing must not touch it. */
export function screenAudioConstraints(): MediaTrackConstraints & { restrictOwnAudio: boolean } {
  return {
    // Exclude call playback from system capture so viewers don't hear themselves.
    // This selects the capture source; it is independent of voice noise filtering.
    restrictOwnAudio: true,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
    sampleRate: { ideal: 48_000 },
  };
}
