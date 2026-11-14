import type { LayerSpec } from '../data/dataLayers';

export function Legend({ spec }: { spec: LayerSpec }) {
  if (spec.kind === 'continuous') {
    return (
      <div className="legend" data-testid="layer-legend">
        <span className="legend__ramp" style={{ background: `linear-gradient(90deg, ${spec.stops?.join(', ')})` }} />
        <span className="legend__ticks">
          {spec.ticks?.map((tick) => <span key={tick}>{tick}</span>)}
        </span>
      </div>
    );
  }
  return (
    <ul className="legend legend--classes" data-testid="layer-legend">
      {spec.classes?.map((item) => (
        <li key={item.label}>
          <span className="legend__swatch" style={{ background: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
