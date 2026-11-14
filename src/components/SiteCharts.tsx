import { useState } from 'react';
import type { ReactNode } from 'react';
import type { LandCoverShare, MonthlyClimate } from '../data/dataLayers';

/** Colours validated for colour vision and contrast on the panel surface. */
const SITE_COLOR = '#c98500';
const REFERENCE_COLOR = '#3987e5';
const OTHER_COLOR = '#7f93a6';

const WIDTH = 300;
const LEFT = 34;
const RIGHT = 8;
const TOP = 10;

interface Tip {
  x: number;
  y: number;
  lines: { value: string; label: string; color?: string }[];
}

function niceStep(range: number, targetTicks: number) {
  const rough = range / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const leading = rough / magnitude;
  return (leading <= 1 ? 1 : leading <= 2 ? 2 : leading <= 5 ? 5 : 10) * magnitude;
}

function ticksBetween(low: number, high: number, targetTicks = 3) {
  const step = niceStep(high - low, targetTicks);
  const first = Math.floor(low / step) * step;
  const ticks: number[] = [];
  for (let value = first; value < high + step; value += step) ticks.push(Math.round(value * 100) / 100);
  return ticks;
}

function ChartFrame({
  title,
  tip,
  headers,
  rows,
  legend,
  children,
}: {
  title: string;
  tip: Tip | null;
  headers: string[];
  rows: (string | number)[][];
  legend?: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      {legend}
      <div className="chart__plot">
        {children}
        {tip && (
          <div
            className="chart__tip"
            data-flip={tip.x > WIDTH * 0.6}
            style={{ left: `${(tip.x / WIDTH) * 100}%`, top: tip.y }}
          >
            {tip.lines.map((line) => (
              <span key={line.label}>
                {line.color && <i style={{ background: line.color }} />}
                <strong>{line.value}</strong> {line.label}
              </span>
            ))}
          </div>
        )}
      </div>
      <details className="chart__table">
        <summary>Show table</summary>
        <table>
          <thead>
            <tr>{headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={String(row[0])}>
                {row.map((cell, index) => (index === 0 ? <th key={index} scope="row">{cell}</th> : <td key={index}>{cell}</td>))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function LegendKey({ items }: { items: { label: string; color: string; line?: boolean; wash?: boolean }[] }) {
  return (
    <ul className="chart__legend">
      {items.map((item) => (
        <li key={item.label}>
          <i
            data-line={item.line}
            style={{ background: item.color, opacity: item.wash ? 0.35 : 1 }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** A column with a rounded top and a square foot on the baseline. */
const columnPath = (x: number, top: number, width: number, base: number) => {
  const r = Math.min(4, width / 2, Math.max(0, base - top));
  return `M${x} ${base}V${top + r}Q${x} ${top} ${x + r} ${top}H${x + width - r}Q${x + width} ${top} ${x + width} ${top + r}V${base}Z`;
};

export function ClimateCharts({ months }: { months: MonthlyClimate[] }) {
  return (
    <>
      <TemperatureChart months={months} />
      <PrecipitationChart months={months} />
    </>
  );
}

function TemperatureChart({ months }: { months: MonthlyClimate[] }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const height = 132;
  const bottom = height - 18;
  const ticks = ticksBetween(Math.min(...months.map((m) => m.low)), Math.max(...months.map((m) => m.high)));
  const low = ticks[0];
  const high = ticks[ticks.length - 1];
  const band = (WIDTH - LEFT - RIGHT) / 12;
  const x = (index: number) => LEFT + band * (index + 0.5);
  const y = (value: number) => bottom - ((value - low) / (high - low)) * (bottom - TOP);
  const line = months.map((m, i) => `${i === 0 ? 'M' : 'L'}${x(i)} ${y(m.mean)}`).join('');
  const area =
    months.map((m, i) => `${i === 0 ? 'M' : 'L'}${x(i)} ${y(m.high)}`).join('') +
    [...months].reverse().map((m, i) => `L${x(11 - i)} ${y(m.low)}`).join('') + 'Z';
  const hottest = months.reduce((a, b) => (b.high > a.high ? b : a));
  const coldest = months.reduce((a, b) => (b.low < a.low ? b : a));

  return (
    <ChartFrame
      title="Air temperature by month"
      tip={tip}
      headers={['Month', 'Low °C', 'Mean °C', 'High °C']}
      rows={months.map((m) => [m.month, m.low.toFixed(1), m.mean.toFixed(1), m.high.toFixed(1)])}
      legend={<LegendKey items={[{ label: 'Mean', color: SITE_COLOR, line: true }, { label: 'Daily low to high', color: SITE_COLOR, wash: true }]} />}
    >
      <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label="Monthly air temperature. The table below has the values.">
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={LEFT} x2={WIDTH - RIGHT} y1={y(tick)} y2={y(tick)} className={tick === 0 ? 'chart__zero' : 'chart__grid'} />
            <text x={LEFT - 6} y={y(tick) + 4} textAnchor="end">{tick}°</text>
          </g>
        ))}
        <path d={area} fill={SITE_COLOR} opacity={0.22} />
        <path d={line} fill="none" stroke={SITE_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <text x={x(months.indexOf(hottest))} y={y(hottest.high) - 3} textAnchor="middle" className="chart__value">{Math.round(hottest.high)}°</text>
        <text x={x(months.indexOf(coldest))} y={y(coldest.low) + 12} textAnchor="middle" className="chart__value">{Math.round(coldest.low)}°</text>
        {months.map((m, i) => (
          <text key={m.month} x={x(i)} y={height - 4} textAnchor="middle">{m.month[0]}</text>
        ))}
        {cursor !== null && (
          <>
            <line x1={x(cursor)} x2={x(cursor)} y1={TOP} y2={bottom} className="chart__cursor" />
            <circle cx={x(cursor)} cy={y(months[cursor].mean)} r={4} fill={SITE_COLOR} stroke="var(--ink)" strokeWidth={2} />
          </>
        )}
        {months.map((m, i) => (
          <rect
            key={m.month}
            x={LEFT + band * i}
            y={0}
            width={band}
            height={height}
            fill="transparent"
            onPointerMove={() => {
              setCursor(i);
              setTip({
                x: x(i), y: 8,
                lines: [
                  { value: `${m.mean.toFixed(1)} °C`, label: `${m.month} mean` },
                  { value: `${m.low.toFixed(0)} to ${m.high.toFixed(0)} °C`, label: 'low to high' },
                ],
              });
            }}
            onPointerLeave={() => {
              setCursor(null);
              setTip(null);
            }}
          />
        ))}
      </svg>
    </ChartFrame>
  );
}

function PrecipitationChart({ months }: { months: MonthlyClimate[] }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const height = 96;
  const bottom = height - 18;
  const ticks = ticksBetween(0, Math.max(1, ...months.map((m) => m.precipitation)), 2);
  const high = ticks[ticks.length - 1];
  const band = (WIDTH - LEFT - RIGHT) / 12;
  const barWidth = Math.min(16, band - 4);
  const y = (value: number) => bottom - (value / high) * (bottom - TOP);

  return (
    <ChartFrame
      title="Rain and snow by month"
      tip={tip}
      headers={['Month', 'Millimetres']}
      rows={months.map((m) => [m.month, m.precipitation])}
    >
      <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label="Monthly precipitation. The table below has the values.">
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={LEFT} x2={WIDTH - RIGHT} y1={y(tick)} y2={y(tick)} className="chart__grid" />
            <text x={LEFT - 6} y={y(tick) + 4} textAnchor="end">{tick}</text>
          </g>
        ))}
        {months.map((m, i) => {
          const left = LEFT + band * i + (band - barWidth) / 2;
          return (
            <g key={m.month}>
              <path d={columnPath(left, y(m.precipitation), barWidth, bottom)} fill={REFERENCE_COLOR} />
              <text x={left + barWidth / 2} y={height - 4} textAnchor="middle">{m.month[0]}</text>
              <rect
                x={LEFT + band * i}
                y={0}
                width={band}
                height={height}
                fill="transparent"
                onPointerMove={() => setTip({ x: left + barWidth / 2, y: 6, lines: [{ value: `${m.precipitation} mm`, label: m.month }] })}
                onPointerLeave={() => setTip(null)}
              />
            </g>
          );
        })}
      </svg>
    </ChartFrame>
  );
}

const inkOn = (color: string) => (color === '#e8eef2' ? '#0b0b0b' : '#ffffff');

export function LandCoverBar({ shares }: { shares: LandCoverShare[] }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const parts = shares.filter((part) => part.share > 0);
  const total = parts.reduce((sum, part) => sum + part.share, 0);

  return (
    <ChartFrame
      title="Land cover across this area"
      tip={tip}
      headers={['Cover', 'Share']}
      rows={shares.map((part) => [part.label, `${part.share}%`])}
      legend={<LegendKey items={parts.map((part) => ({ label: part.label, color: part.color }))} />}
    >
      <div className="segments" role="img" aria-label={shares.map((p) => `${p.label} ${p.share}%`).join(', ')}>
        {parts.map((part, index) => {
          const width = (part.share / total) * 100;
          return (
            <div
              key={part.label}
              className="segments__part"
              style={{ width: `${width}%`, background: part.color, color: inkOn(part.color) }}
              onPointerMove={() => {
                const before = parts.slice(0, index).reduce((sum, p) => sum + p.share, 0);
                setTip({
                  x: ((before + part.share / 2) / total) * WIDTH,
                  y: 32,
                  lines: [{ value: `${part.share}%`, label: part.label, color: part.color }],
                });
              }}
              onPointerLeave={() => setTip(null)}
            >
              {width >= 14 ? `${Math.round(part.share)}%` : ''}
            </div>
          );
        })}
      </div>
    </ChartFrame>
  );
}

export function SlopeDistribution({
  labels,
  site,
  reference,
  siteName,
  referenceName,
}: {
  labels: string[];
  site: number[];
  reference: number[];
  siteName: string;
  referenceName: string;
}) {
  const [tip, setTip] = useState<Tip | null>(null);
  const height = 132;
  const bottom = height - 18;
  const ticks = ticksBetween(0, Math.max(...site, ...reference), 2);
  const high = ticks[ticks.length - 1];
  const band = (WIDTH - LEFT - RIGHT) / labels.length;
  const barWidth = Math.min(20, band / 2 - 3);
  const y = (value: number) => bottom - (value / high) * (bottom - TOP);

  return (
    <ChartFrame
      title="Share of ground by slope"
      tip={tip}
      headers={['Slope', siteName, referenceName]}
      rows={labels.map((label, i) => [label, `${site[i]}%`, `${reference[i]}%`])}
      legend={<LegendKey items={[{ label: siteName, color: SITE_COLOR }, { label: referenceName, color: REFERENCE_COLOR }]} />}
    >
      <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label="Slope distribution of both places. The table below has the values.">
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={LEFT} x2={WIDTH - RIGHT} y1={y(tick)} y2={y(tick)} className="chart__grid" />
            <text x={LEFT - 6} y={y(tick) + 4} textAnchor="end">{tick}%</text>
          </g>
        ))}
        {labels.map((label, i) => {
          const center = LEFT + band * (i + 0.5);
          return (
            <g key={label}>
              <path d={columnPath(center - barWidth - 1, y(site[i]), barWidth, bottom)} fill={SITE_COLOR} />
              <path d={columnPath(center + 1, y(reference[i]), barWidth, bottom)} fill={REFERENCE_COLOR} />
              <text x={center} y={height - 4} textAnchor="middle">{label}</text>
              <rect
                x={LEFT + band * i}
                y={0}
                width={band}
                height={height}
                fill="transparent"
                onPointerMove={() =>
                  setTip({
                    x: center, y: 6,
                    lines: [
                      { value: `${site[i]}%`, label: siteName, color: SITE_COLOR },
                      { value: `${reference[i]}%`, label: referenceName, color: REFERENCE_COLOR },
                    ],
                  })
                }
                onPointerLeave={() => setTip(null)}
              />
            </g>
          );
        })}
      </svg>
    </ChartFrame>
  );
}

export function RoughnessByScale({
  site,
  reference,
  siteName,
  referenceName,
}: {
  site: { lag: number; rms: number }[];
  reference: { lag: number; rms: number }[];
  siteName: string;
  referenceName: string;
}) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const height = 150;
  const bottom = height - 32;
  const all = [...site, ...reference].map((point) => point.rms);
  const lowDecade = Math.floor(Math.log10(Math.max(0.1, Math.min(...all))));
  const highDecade = Math.ceil(Math.log10(Math.max(...all)));
  const yTicks = Array.from({ length: highDecade - lowDecade + 1 }, (_, i) => 10 ** (lowDecade + i));
  const logMin = Math.log10(site[0].lag);
  const logMax = Math.log10(site[site.length - 1].lag);
  const x = (lag: number) => LEFT + ((Math.log10(lag) - logMin) / (logMax - logMin)) * (WIDTH - LEFT - RIGHT);
  const y = (rms: number) => bottom - ((Math.log10(rms) - lowDecade) / (highDecade - lowDecade)) * (bottom - TOP);
  const path = (series: { lag: number; rms: number }[]) =>
    series.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.lag)} ${y(point.rms)}`).join('');
  const band = (WIDTH - LEFT - RIGHT) / (site.length - 1);
  const distance = (lag: number) => (lag >= 1000 ? `${(lag / 1000).toFixed(1)} km` : `${lag} m`);

  return (
    <ChartFrame
      title="Roughness across distances"
      tip={tip}
      headers={['Distance', siteName, referenceName]}
      rows={site.map((point, index) => [distance(point.lag), `${point.rms} m`, `${reference[index].rms} m`])}
      legend={<LegendKey items={[{ label: siteName, color: SITE_COLOR, line: true }, { label: referenceName, color: REFERENCE_COLOR, line: true }]} />}
    >
      <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label="Height difference at increasing distances for both places. The table below has the values.">
        {yTicks.map((tick) => (
          <g key={tick}>
            <line x1={LEFT} x2={WIDTH - RIGHT} y1={y(tick)} y2={y(tick)} className="chart__grid" />
            <text x={LEFT - 6} y={y(tick) + 4} textAnchor="end">{tick < 1 ? tick : tick.toLocaleString('en-US')}</text>
          </g>
        ))}
        {site.map((point, index) => (
          <text key={point.lag} x={x(point.lag)} y={bottom + 14} textAnchor={index === 0 ? 'start' : index === site.length - 1 ? 'end' : 'middle'}>
            {distance(point.lag)}
          </text>
        ))}
        <text x={(LEFT + WIDTH - RIGHT) / 2} y={height - 4} textAnchor="middle">Distance, with height difference in metres (log scales)</text>
        <path d={path(reference)} fill="none" stroke={REFERENCE_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <path d={path(site)} fill="none" stroke={SITE_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {cursor !== null && (
          <>
            <line x1={x(site[cursor].lag)} x2={x(site[cursor].lag)} y1={TOP} y2={bottom} className="chart__cursor" />
            <circle cx={x(site[cursor].lag)} cy={y(site[cursor].rms)} r={4} fill={SITE_COLOR} stroke="var(--ink)" strokeWidth={2} />
            <circle cx={x(reference[cursor].lag)} cy={y(reference[cursor].rms)} r={4} fill={REFERENCE_COLOR} stroke="var(--ink)" strokeWidth={2} />
          </>
        )}
        {site.map((point, index) => (
          <rect
            key={point.lag}
            x={x(point.lag) - band / 2}
            y={0}
            width={band}
            height={height}
            fill="transparent"
            onPointerMove={() => {
              setCursor(index);
              setTip({
                x: x(point.lag), y: 6,
                lines: [
                  { value: `${point.rms} m`, label: siteName, color: SITE_COLOR },
                  { value: `${reference[index].rms} m`, label: referenceName, color: REFERENCE_COLOR },
                ],
              });
            }}
            onPointerLeave={() => {
              setCursor(null);
              setTip(null);
            }}
          />
        ))}
      </svg>
    </ChartFrame>
  );
}

export interface ScatterPoint {
  id: string;
  name: string;
  relief: number;
  slope: number;
  role: 'site' | 'reference' | 'other';
}

const ROLE_COLOR = { site: SITE_COLOR, reference: REFERENCE_COLOR, other: OTHER_COLOR };

export function ReliefScatter({ points, grid }: { points: ScatterPoint[]; grid: number }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const height = 170;
  const bottom = height - 32;
  const xTicks = [100, 1000, 10000];
  const yTicks = ticksBetween(0, Math.max(...points.map((p) => p.slope)), 3);
  const yHigh = yTicks[yTicks.length - 1];
  const x = (relief: number) =>
    LEFT + ((Math.log10(Math.max(relief, 100)) - 2) / 2) * (WIDTH - LEFT - RIGHT);
  const y = (slope: number) => bottom - (slope / yHigh) * (bottom - TOP);
  const drawn = [...points].sort((a, b) => (a.role === 'other' ? -1 : 1) - (b.role === 'other' ? -1 : 1));
  const named = drawn.filter((p) => p.role !== 'other');
  const labelsCollide = named.length === 2 && Math.abs(y(named[0].slope) - y(named[1].slope)) < 14;

  return (
    <ChartFrame
      title="Relief against slope"
      tip={tip}
      headers={['Place', 'Relief', 'Mean slope']}
      rows={points.map((p) => [p.name, `${p.relief.toLocaleString('en-US')} m`, `${p.slope}°`])}
      legend={
        <LegendKey
          items={[
            { label: 'This site', color: SITE_COLOR },
            { label: 'Compared place', color: REFERENCE_COLOR },
            { label: `Others on a ${grid} m grid`, color: OTHER_COLOR },
          ]}
        />
      }
    >
      <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label="Relief against mean slope for each place. The table below has the values.">
        {yTicks.map((tick) => (
          <g key={tick}>
            <line x1={LEFT} x2={WIDTH - RIGHT} y1={y(tick)} y2={y(tick)} className="chart__grid" />
            <text x={LEFT - 6} y={y(tick) + 4} textAnchor="end">{tick}°</text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <text key={tick} x={x(tick)} y={bottom + 14} textAnchor={tick === 10000 ? 'end' : tick === 100 ? 'start' : 'middle'}>
            {tick.toLocaleString('en-US')} m
          </text>
        ))}
        <text x={(LEFT + WIDTH - RIGHT) / 2} y={height - 4} textAnchor="middle">Relief, log scale</text>
        {drawn.map((point) => (
          <circle key={point.id} cx={x(point.relief)} cy={y(point.slope)} r={point.role === 'other' ? 4 : 5} fill={ROLE_COLOR[point.role]} stroke="var(--ink)" strokeWidth={2} />
        ))}
        {named.map((point, index) => {
          const px = x(point.relief);
          const above = !labelsCollide || index === 0;
          return (
            <text
              key={point.id}
              x={px > WIDTH * 0.62 ? px - 9 : px + 9}
              y={y(point.slope) + (labelsCollide ? (above ? -6 : 13) : 4)}
              textAnchor={px > WIDTH * 0.62 ? 'end' : 'start'}
              className="chart__value"
            >
              {point.name}
            </text>
          );
        })}
        {drawn.map((point) => (
          <circle
            key={`${point.id}-hit`}
            cx={x(point.relief)}
            cy={y(point.slope)}
            r={13}
            fill="transparent"
            onPointerMove={() =>
              setTip({
                x: x(point.relief), y: Math.max(4, y(point.slope) - 44),
                lines: [
                  { value: `${point.relief.toLocaleString('en-US')} m`, label: `${point.name} relief` },
                  { value: `${point.slope}°`, label: 'mean slope' },
                ],
              })
            }
            onPointerLeave={() => setTip(null)}
          />
        ))}
      </svg>
    </ChartFrame>
  );
}
