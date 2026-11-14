import type { Map as MapLibreMap } from 'maplibre-gl';
import { HEIGHT_SCALES } from '../map/cameraDirector';

interface LocalControlsProps {
  map: MapLibreMap | null;
  interactive: boolean;
  reducedMotion: () => boolean;
  onReset: () => void;
  heightScale: number;
  onHeightScale: (scale: number) => void;
}

const ROTATE_STEP = 30;

export function LocalControls({
  map,
  interactive,
  reducedMotion,
  onReset,
  heightScale,
  onHeightScale,
}: LocalControlsProps) {
  const options = () => ({ duration: reducedMotion() ? 0 : 320 });
  const rotate = (delta: number) => {
    if (map) map.easeTo({ bearing: map.getBearing() + delta, ...options() });
  };

  return (
    <div className="local-controls" inert={!interactive}>
      <div className="height-scale" role="group" aria-label="Terrain height" data-testid="height-scale">
        <span>Height</span>
        {HEIGHT_SCALES.map((scale) => (
          <button
            key={scale}
            type="button"
            aria-pressed={heightScale === scale}
            data-testid={`height-${scale}`}
            onClick={() => onHeightScale(scale)}
          >
            {scale === 1 ? 'True scale' : `×${scale}`}
          </button>
        ))}
      </div>
      <div className="local-controls__strip">
        <button type="button" aria-label="Zoom in" data-testid="zoom-in" onClick={() => map?.zoomIn(options())}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
        </button>
        <button type="button" aria-label="Zoom out" data-testid="zoom-out" onClick={() => map?.zoomOut(options())}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 8h10" /></svg>
        </button>
        <button type="button" aria-label="Rotate left" data-testid="rotate-left" onClick={() => rotate(-ROTATE_STEP)}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 6.5A5 5 0 1 1 3 9M3.2 2.8v3.9h3.9" /></svg>
        </button>
        <button type="button" aria-label="Rotate right" data-testid="rotate-right" onClick={() => rotate(ROTATE_STEP)}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M12.5 6.5A5 5 0 1 0 13 9M12.8 2.8v3.9H8.9" /></svg>
        </button>
        <button type="button" className="local-controls__reset" data-testid="reset-view" onClick={onReset}>
          Reset view
        </button>
      </div>
      <p className="local-controls__hint">Drag to pan. Right-drag to rotate and tilt. Scroll to zoom.</p>
    </div>
  );
}
