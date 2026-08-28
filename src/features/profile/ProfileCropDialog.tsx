import { useRef, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";

type ImageSize = { width: number; height: number };
const FRAME_SIZE = 280;

export function CropDialog({
  source, imageSize, zoom, moveX, moveY, rotation,
  onZoom, onMove, onRotate, onCancel, onSave,
}: {
  source: string;
  imageSize: ImageSize;
  zoom: number;
  moveX: number;
  moveY: number;
  rotation: number;
  onZoom: (value: number) => void;
  onMove: (x: number, y: number) => void;
  onRotate: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const drag = useRef<{ x: number; y: number; moveX: number; moveY: number } | null>(null);
  const crop = cropLayout(imageSize, zoom, rotation, FRAME_SIZE);
  const x = clamp(moveX, -crop.maxX, crop.maxX);
  const y = clamp(moveY, -crop.maxY, crop.maxY);

  const moveFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onMove(
      clamp(drag.current.moveX + event.clientX - drag.current.x, -crop.maxX, crop.maxX),
      clamp(drag.current.moveY + event.clientY - drag.current.y, -crop.maxY, crop.maxY),
    );
  };

  const zoomFromWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    onZoom(clamp(zoom - event.deltaY * 0.0015, 1, 3));
  };

  return (
    <div className="modal-backdrop crop-backdrop">
      <section className="crop-workspace" aria-label="Crop and rotate profile photo">
        <header>
          <button className="crop-back" onClick={onCancel} aria-label="Back">←</button>
          <h2>Crop &amp; rotate</h2>
          <span aria-hidden="true">⋮</span>
        </header>
        <div
          className="crop-stage"
          onWheel={zoomFromWheel}
          onDragStart={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { x: event.clientX, y: event.clientY, moveX: x, moveY: y };
          }}
          onPointerMove={moveFromPointer}
          onPointerUp={(event) => {
            drag.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => { drag.current = null; }}
        >
          <img className="crop-stage-backdrop" src={source} alt="" draggable={false} />
          <div
            className="crop-frame"
          >
            <img
              src={source}
              alt="Crop preview"
              draggable={false}
              onDragStart={(event) => event.preventDefault()}
              style={{
                width: crop.width,
                height: crop.height,
                left: `calc(50% + ${x}px)`,
                top: `calc(50% + ${y}px)`,
                transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
              }}
            />
            <i className="corner top-left" /><i className="corner top-right" />
            <i className="corner bottom-left" /><i className="corner bottom-right" />
          </div>
        </div>
        <div className="crop-actions">
          <button className="crop-rotate" onClick={onRotate}><span>↻</span>Rotate</button>
          <label className="crop-zoom" aria-label="Zoom">
            <span>−</span>
            <input type="range" min="1" max="3" step="0.01" value={zoom} onChange={(event) => onZoom(Number(event.target.value))} />
            <span>＋</span>
          </label>
          <button className="crop-next" onClick={onSave}>Next</button>
        </div>
      </section>
    </div>
  );
}

export function cropLayout(size: ImageSize, zoom: number, rotation: number, frame: number) {
  const sideways = Math.abs(rotation % 180) === 90;
  const orientedWidth = sideways ? size.height : size.width;
  const orientedHeight = sideways ? size.width : size.height;
  const scale = Math.max(frame / orientedWidth, frame / orientedHeight) * zoom;
  const rotatedWidth = orientedWidth * scale;
  const rotatedHeight = orientedHeight * scale;
  return {
    scale,
    width: size.width * scale,
    height: size.height * scale,
    maxX: Math.max(0, (rotatedWidth - frame) / 2),
    maxY: Math.max(0, (rotatedHeight - frame) / 2),
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export async function cropAvatar(
  url: string,
  zoom: number,
  moveX: number,
  moveY: number,
  rotation: number,
  size: ImageSize,
) {
  const source = await createImageBitmap(await fetch(url).then((response) => response.blob()));
  const outputSize = 320;
  const outputScale = outputSize / FRAME_SIZE;
  const crop = cropLayout(size, zoom, rotation, FRAME_SIZE);
  const x = clamp(moveX, -crop.maxX, crop.maxX);
  const y = clamp(moveY, -crop.maxY, crop.maxY);
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Avatar canvas unavailable");

  context.translate(outputSize / 2 + x * outputScale, outputSize / 2 + y * outputScale);
  context.rotate((rotation * Math.PI) / 180);
  const width = source.width * crop.scale * outputScale;
  const height = source.height * crop.scale * outputScale;
  context.drawImage(source, -width / 2, -height / 2, width, height);
  source.close();
  return canvas.toDataURL("image/jpeg", 0.86);
}
