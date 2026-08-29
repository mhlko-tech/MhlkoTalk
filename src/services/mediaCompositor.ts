import type { CameraOverlaySettings, ScreenFps } from '../types/models';

export type CompositorDiagnostic = {
  stage: 'starting' | 'running' | 'camera-updated' | 'stopped' | 'error';
  message: string;
  at: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function snapped(value: number, edge: number, threshold = 2.2) {
  if (Math.abs(value) <= threshold) return 0;
  if (Math.abs(edge - value) <= threshold) return edge;
  return value;
}

export function normalizeCameraOverlay(settings: CameraOverlaySettings): CameraOverlaySettings {
  const width = clamp(Number(settings.widthPercent || 24), 10, 70);
  // Preserve a 16:9 overlay box by default. The video itself is cover-cropped.
  const height = clamp(Number(settings.heightPercent || width * 9 / 16), 8, 70);
  let x = clamp(Number(settings.xPercent || 0), 0, 100 - width);
  let y = clamp(Number(settings.yPercent || 0), 0, 100 - height);
  x = snapped(x, 100 - width);
  y = snapped(y, 100 - height);
  return {
    xPercent: x,
    yPercent: y,
    widthPercent: width,
    heightPercent: height,
    borderRadius: clamp(Number(settings.borderRadius || 0), 0, 50),
    mirror: Boolean(settings.mirror),
    fitMode: settings.fitMode === 'contain' ? 'contain' : 'cover',
    cropXPercent: clamp(Number(settings.cropXPercent ?? 50), 0, 100),
    cropYPercent: clamp(Number(settings.cropYPercent ?? 50), 0, 100),
    cropTopPercent: clamp(Number(settings.cropTopPercent ?? 0), 0, 40),
    cropRightPercent: clamp(Number(settings.cropRightPercent ?? 0), 0, 40),
    cropBottomPercent: clamp(Number(settings.cropBottomPercent ?? 0), 0, 40),
    cropLeftPercent: clamp(Number(settings.cropLeftPercent ?? 0), 0, 40),
    opacity: clamp(Number(settings.opacity ?? 1), 0.1, 1)
  };
}

function waitForVideo(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('media compositor source timed out')), 8_000);
    const ready = () => { window.clearTimeout(timer); cleanup(); resolve(); };
    const failed = () => { window.clearTimeout(timer); cleanup(); reject(new Error('media compositor source failed')); };
    const cleanup = () => {
      video.removeEventListener('loadeddata', ready);
      video.removeEventListener('canplay', ready);
      video.removeEventListener('error', failed);
    };
    video.addEventListener('loadeddata', ready, { once: true });
    video.addEventListener('canplay', ready, { once: true });
    video.addEventListener('error', failed, { once: true });
  });
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  x: number,
  y: number,
  width: number,
  height: number,
  mirror: boolean,
  cropXPercent: number,
  cropYPercent: number,
  cropTopPercent: number,
  cropRightPercent: number,
  cropBottomPercent: number,
  cropLeftPercent: number
) {
  const sourceWidth = Math.max(1, video.videoWidth || width);
  const sourceHeight = Math.max(1, video.videoHeight || height);
  const left = sourceWidth * clamp(cropLeftPercent / 100, 0, 0.4);
  const right = sourceWidth * clamp(cropRightPercent / 100, 0, 0.4);
  const top = sourceHeight * clamp(cropTopPercent / 100, 0, 0.4);
  const bottom = sourceHeight * clamp(cropBottomPercent / 100, 0, 0.4);
  const croppedWidth = Math.max(sourceWidth * 0.2, sourceWidth - left - right);
  const croppedHeight = Math.max(sourceHeight * 0.2, sourceHeight - top - bottom);
  const sourceRatio = croppedWidth / croppedHeight;
  const targetRatio = width / height;
  let sx = left;
  let sy = top;
  let sw = croppedWidth;
  let sh = croppedHeight;
  if (sourceRatio > targetRatio) {
    sw = croppedHeight * targetRatio;
    sx = left + (croppedWidth - sw) * clamp(cropXPercent / 100, 0, 1);
  } else {
    sh = croppedWidth / targetRatio;
    sy = top + (croppedHeight - sh) * clamp(cropYPercent / 100, 0, 1);
  }
  ctx.save();
  if (mirror) {
    ctx.translate(x + width, y);
    ctx.scale(-1, 1);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
  } else {
    ctx.drawImage(video, sx, sy, sw, sh, x, y, width, height);
  }
  ctx.restore();
}

function drawContain(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  x: number,
  y: number,
  width: number,
  height: number,
  mirror: boolean
) {
  const sourceWidth = Math.max(1, video.videoWidth || width);
  const sourceHeight = Math.max(1, video.videoHeight || height);
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const drawX = x + (width - drawWidth) / 2;
  const drawY = y + (height - drawHeight) / 2;
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(x, y, width, height);
  if (mirror) {
    ctx.translate(drawX + drawWidth, drawY);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, sourceWidth, sourceHeight, 0, 0, drawWidth, drawHeight);
  } else {
    ctx.drawImage(video, 0, 0, sourceWidth, sourceHeight, drawX, drawY, drawWidth, drawHeight);
  }
  ctx.restore();
}


export class ScreenCameraCompositor {
  private readonly displayStream: MediaStream;
  private cameraStream: MediaStream;
  private readonly displayVideo = document.createElement('video');
  private readonly cameraVideo = document.createElement('video');
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly output: MediaStream;
  private readonly fps: number;
  private settings: CameraOverlaySettings;
  private frameTimer = 0;
  private stopped = false;
  private onDiagnostic?: (entry: CompositorDiagnostic) => void;

  private constructor(displayStream: MediaStream, cameraStream: MediaStream, settings: CameraOverlaySettings, fps: number, onDiagnostic?: (entry: CompositorDiagnostic) => void) {
    this.displayStream = displayStream;
    this.cameraStream = cameraStream;
    this.settings = normalizeCameraOverlay(settings);
    this.fps = clamp(Math.round(fps || 30), 8, 60);
    this.onDiagnostic = onDiagnostic;
    const context = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!context) throw new Error('2D canvas compositor is unavailable');
    this.context = context;
    this.output = this.canvas.captureStream(this.fps);
    for (const track of displayStream.getAudioTracks()) this.output.addTrack(track);
  }

  static async create(displayStream: MediaStream, cameraStream: MediaStream, settings: CameraOverlaySettings, fps: ScreenFps | number, onDiagnostic?: (entry: CompositorDiagnostic) => void): Promise<ScreenCameraCompositor> {
    const compositor = new ScreenCameraCompositor(displayStream, cameraStream, settings, Number(fps), onDiagnostic);
    compositor.emit('starting', 'Creating the shared screen/camera composition');
    await compositor.bindSources();
    compositor.startRendering();
    compositor.emit('running', `Composition active at ${compositor.canvas.width}x${compositor.canvas.height}@${compositor.fps}`);
    return compositor;
  }

  get stream(): MediaStream { return this.output; }

  updateSettings(settings: CameraOverlaySettings) {
    this.settings = normalizeCameraOverlay(settings);
    this.emit('camera-updated', 'Camera overlay position/size updated');
  }

  async replaceCamera(cameraStream: MediaStream) {
    this.cameraStream = cameraStream;
    this.cameraVideo.srcObject = cameraStream;
    await this.cameraVideo.play();
    await waitForVideo(this.cameraVideo);
    this.emit('camera-updated', 'Camera source replaced');
  }

  stop(stopCamera = false) {
    if (this.stopped) return;
    this.stopped = true;
    window.cancelAnimationFrame(this.frameTimer);
    try { this.displayVideo.pause(); } catch { /* ignore */ }
    try { this.cameraVideo.pause(); } catch { /* ignore */ }
    this.displayVideo.srcObject = null;
    this.cameraVideo.srcObject = null;
    for (const track of this.output.getVideoTracks()) { try { track.stop(); } catch { /* ignore */ } }
    if (stopCamera) for (const track of this.cameraStream.getTracks()) { try { track.stop(); } catch { /* ignore */ } }
    this.emit('stopped', 'Screen/camera composition stopped');
  }

  private async bindSources() {
    this.displayVideo.muted = true;
    this.cameraVideo.muted = true;
    this.displayVideo.playsInline = true;
    this.cameraVideo.playsInline = true;
    this.displayVideo.srcObject = new MediaStream(this.displayStream.getVideoTracks());
    this.cameraVideo.srcObject = this.cameraStream;
    await Promise.all([this.displayVideo.play(), this.cameraVideo.play()]);
    await Promise.all([waitForVideo(this.displayVideo), waitForVideo(this.cameraVideo)]);
    const trackSettings = this.displayStream.getVideoTracks()[0]?.getSettings();
    this.canvas.width = Math.max(2, Math.round(Number(trackSettings?.width || this.displayVideo.videoWidth || 1920)));
    this.canvas.height = Math.max(2, Math.round(Number(trackSettings?.height || this.displayVideo.videoHeight || 1080)));
    this.output.getVideoTracks()[0]?.applyConstraints({ frameRate: { ideal: this.fps, max: this.fps } }).catch(() => undefined);
  }

  private startRendering() {
    const interval = 1000 / this.fps;
    let last = 0;
    const frame = (now: number) => {
      if (this.stopped) return;
      if (now - last >= interval - 1) {
        last = now;
        this.drawFrame();
      }
      this.frameTimer = window.requestAnimationFrame(frame);
    };
    this.frameTimer = window.requestAnimationFrame(frame);
  }

  private drawFrame() {
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (!width || !height) return;
    try {
      this.context.drawImage(this.displayVideo, 0, 0, width, height);
      const settings = this.settings;
      const x = Math.round(width * settings.xPercent / 100);
      const y = Math.round(height * settings.yPercent / 100);
      const boxWidth = Math.max(2, Math.round(width * settings.widthPercent / 100));
      const boxHeight = Math.max(2, Math.round(height * settings.heightPercent / 100));
      const radius = Math.min(boxWidth, boxHeight) * settings.borderRadius / 100;
      this.context.save();
      this.context.globalAlpha = settings.opacity;
      this.context.beginPath();
      this.context.roundRect(x, y, boxWidth, boxHeight, radius);
      this.context.clip();
      if (settings.fitMode === 'contain') {
        drawContain(this.context, this.cameraVideo, x, y, boxWidth, boxHeight, settings.mirror);
      } else {
        drawCover(
          this.context,
          this.cameraVideo,
          x,
          y,
          boxWidth,
          boxHeight,
          settings.mirror,
          settings.cropXPercent,
          settings.cropYPercent,
          settings.cropTopPercent,
          settings.cropRightPercent,
          settings.cropBottomPercent,
          settings.cropLeftPercent
        );
      }
      this.context.restore();
    } catch (error) {
      this.emit('error', `Compositor frame failed: ${String((error as Error)?.message || error)}`);
    }
  }

  private emit(stage: CompositorDiagnostic['stage'], message: string) {
    this.onDiagnostic?.({ stage, message, at: Date.now() });
  }
}
