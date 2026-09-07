
import AgoraRTC from 'agora-rtc-sdk-ng';
import { AgoraRtcSession } from '/src/services/agoraRtcSession.ts';
AgoraRTC.setLogLevel(4);
document.querySelector('#run').onclick = async () => {
  const output = document.querySelector('#result');
  output.textContent = 'Running';
  const context = new AudioContext({ sampleRate: 48000 });
  await context.resume();
  const source = context.createBufferSource();
  const buffer = context.createBuffer(2, 48000, 48000);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) data[i] = 0.2 * Math.sin(2 * Math.PI * (channel ? 1200 : 440) * i / 48000);
  }
  source.buffer = buffer;
  source.loop = true;
  const destination = context.createMediaStreamDestination();
  source.connect(destination);
  source.start();
  const original = AgoraRTC.createCustomAudioTrack({ mediaStreamTrack: destination.stream.getAudioTracks()[0] });
  let published;
  const screenClient = { on() {}, async join() {}, async leave() {}, async unpublish() {}, async publish(tracks) { published = tracks[1]; } };
  const video = { on() {}, close() {} };
  const sdk = { createClient: () => screenClient, createScreenVideoTrack: async () => [video, original], createCustomAudioTrack: config => AgoraRTC.createCustomAudioTrack(config) };
  const session = new AgoraRtcSession({onParticipants(){}, onAudio(){}, onCustomEvent(){}, onConnectionState(){}}, async () => sdk);
  session.credentials = { routing: { rtc: { clientKey: 'local-test' } }, roomName:'local-test',screenIdentity:'local:screen',screenToken:'local-only' };
  try {
    const enabled = await session.setScreenShareEnabled(true,'high');
    const track = published.getMediaStreamTrack();
    const measured = context.createMediaStreamSource(new MediaStream([track]));
    const splitter = context.createChannelSplitter(2);
    measured.connect(splitter);
    const analysers = [0,1].map(channel => { const a=context.createAnalyser();a.fftSize=8192;splitter.connect(a,channel);return a; });
    const mute = context.createGain(); mute.gain.value=0;
    analysers.forEach(a=>a.connect(mute)); mute.connect(context.destination);
    await new Promise(resolve=>setTimeout(resolve,700));
    const levels=analysers.map(a=>{
      const pcm=new Float32Array(a.fftSize);a.getFloatTimeDomainData(pcm);
      const fft=new Float32Array(a.frequencyBinCount);a.getFloatFrequencyData(fft);
      let peak=0;for(let i=1;i<fft.length;i++)if(fft[i]>fft[peak])peak=i;
      return {rms:Math.sqrt(pcm.reduce((s,v)=>s+v*v,0)/pcm.length), frequency:peak*context.sampleRate/a.fftSize};
    });
    if (!enabled || track.readyState!=='live' || levels.some(l=>l.rms<0.05) || Math.abs(levels[0].frequency-440)>15 || Math.abs(levels[1].frequency-1200)>15) throw new Error(JSON.stringify({enabled,state:track.readyState,levels}));
    await session.setScreenShareEnabled(false,'high');
    output.textContent=JSON.stringify({pass:true,enabled,channels:levels,stopped:track.readyState==='ended'},null,2);
  } catch(error) {output.textContent='FAIL '+JSON.stringify({error:String(error),constraint:error.constraint,settings:destination.stream.getAudioTracks()[0].getSettings()});}
  finally {await session.disconnect();source.stop();await context.close();}
};
