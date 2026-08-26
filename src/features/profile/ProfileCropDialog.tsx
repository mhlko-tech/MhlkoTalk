type ImageSize = { width: number; height: number };

export function CropDialog({
  source,
  imageSize,
  zoom,
  moveX,
  moveY,
  onZoom,
  onMoveX,
  onMoveY,
  onCancel,
  onSave,
}: {
  source: string;
  imageSize: ImageSize;
  zoom: number;
  moveX: number;
  moveY: number;
  onZoom: (value: number) => void;
  onMoveX: (value: number) => void;
  onMoveY: (value: number) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const crop = cropLayout(imageSize, zoom, 210);
  return (
    <div className="modal-backdrop">
      <section className="private-modal crop-modal">
        <button className="modal-close" onClick={onCancel}>
          ×
        </button>
        <h2>Crop profile photo</h2>
        <p>
          Move and zoom the image. The circle is exactly how your avatar will
          look.
        </p>
        <div className="crop-preview">
          <img
            src={source}
            alt="Crop preview"
            style={{
              width: crop.width,
              height: crop.height,
              left: crop.left + moveX,
              top: crop.top + moveY,
            }}
          />
        </div>
        <label>
          Zoom
          <input
            type="range"
            min="1"
            max="3"
            step="0.01"
            value={zoom}
            onChange={(event) => onZoom(Number(event.target.value))}
          />
        </label>
        <label>
          Move left / right
          <input
            type="range"
            min={-crop.maxX}
            max={crop.maxX}
            value={moveX}
            onChange={(event) => onMoveX(Number(event.target.value))}
          />
        </label>
        <label>
          Move up / down
          <input
            type="range"
            min={-crop.maxY}
            max={crop.maxY}
            value={moveY}
            onChange={(event) => onMoveY(Number(event.target.value))}
          />
        </label>
        <button className="primary modal-create" onClick={onSave}>
          Use this photo
        </button>
      </section>
    </div>
  );
}

function cropLayout(
  size: ImageSize,
  zoom: number,
  frame: number,
) {
  const ratio = size.width / size.height;
  const width = (ratio >= 1 ? frame * ratio : frame) * zoom;
  const height = (ratio >= 1 ? frame : frame / ratio) * zoom;
  return {
    width,
    height,
    left: (frame - width) / 2,
    top: (frame - height) / 2,
    maxX: Math.max(0, (width - frame) / 2),
    maxY: Math.max(0, (height - frame) / 2),
  };
}

export async function cropAvatar(
  url: string,
  zoom: number,
  moveX: number,
  moveY: number,
  size: ImageSize,
) {
  const source = await createImageBitmap(
    await fetch(url).then((response) => response.blob()),
  );
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 96;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Avatar canvas unavailable");
  const crop = cropLayout(size, zoom, 96);
  context.drawImage(
    source,
    crop.left + moveX * (96 / 210),
    crop.top + moveY * (96 / 210),
    crop.width,
    crop.height,
  );
  source.close();
  return canvas.toDataURL("image/jpeg", 0.62);
}
