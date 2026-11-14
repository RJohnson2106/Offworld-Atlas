import { useEffect, useRef, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { basemap } from './basemap';
import { fetchDetailCredit } from '../drone/imageryService';
import { liveImageryOn } from './liveDetail';

const MAX_BAR_PX = 112;
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

function niceDistance(meters: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(meters));
  const leading = meters / magnitude;
  const nice = leading >= 5 ? 5 : leading >= 2 ? 2 : 1;
  return nice * magnitude;
}

interface MapInstrumentsProps {
  map: MapLibreMap | null;
  reducedMotion: () => boolean;
}

export function MapInstruments({ map, reducedMotion }: MapInstrumentsProps) {
  const barRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const needleRef = useRef<SVGGElement>(null);
  const [esriCredit, setEsriCredit] = useState('');

  useEffect(() => {
    if (liveImageryOn) void fetchDetailCredit().then(setEsriCredit);
  }, []);

  useEffect(() => {
    if (!map) return;
    const update = () => {
      const metersPerPixel =
        (EARTH_CIRCUMFERENCE_M * Math.cos((map.getCenter().lat * Math.PI) / 180)) /
        (512 * 2 ** map.getZoom());
      const distance = niceDistance(metersPerPixel * MAX_BAR_PX);
      if (barRef.current) barRef.current.style.width = `${distance / metersPerPixel}px`;
      if (labelRef.current) {
        labelRef.current.textContent =
          distance < 1000 ? `${Math.round(distance)} m` : `${Math.round(distance / 1000).toLocaleString('en-US')} km`;
      }
      needleRef.current?.setAttribute('transform', `rotate(${-map.getBearing()})`);
    };
    update();
    map.on('move', update);
    return () => {
      map.off('move', update);
    };
  }, [map]);

  return (
    <div className="instruments">
      <div className="instruments__row">
        <div className="scale-bar">
          <span ref={labelRef} className="scale-bar__label" data-testid="scale-label" />
          <span ref={barRef} className="scale-bar__rule" />
        </div>
        <button
          type="button"
          className="compass"
          aria-label="Turn map to north"
          disabled={!map}
          onClick={() => map?.easeTo({ bearing: 0, duration: reducedMotion() ? 0 : 500 })}
        >
          <svg viewBox="-20 -20 40 40" width="40" height="40" aria-hidden="true">
            <g ref={needleRef}>
              <path className="compass__north" d="M0 -13 5 0H-5Z" />
              <path className="compass__south" d="M0 13 5 0H-5Z" />
              <text className="compass__n" y="-15.5" textAnchor="middle">N</text>
            </g>
          </svg>
        </button>
      </div>
      <a className="credit" href={basemap.credit.url} target="_blank" rel="noreferrer">
        {basemap.credit.label}
      </a>
      {esriCredit && (
        <a
          className="credit credit--wrap"
          href="https://www.esri.com/"
          target="_blank"
          rel="noreferrer"
          title={`Powered by Esri. ${esriCredit}`}
        >
          Powered by Esri. {esriCredit}
        </a>
      )}
    </div>
  );
}
