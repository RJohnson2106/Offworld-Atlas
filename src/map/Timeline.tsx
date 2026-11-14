import { useEffect, useRef, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { NIGHT_LAYER, skyClock } from './sunlight';

const LIVE_TICK_MS = 30_000;
const MINUTES_IN_DAY = 1440;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const LONGEST_FRAME_S = 0.25; // a hidden tab shouldn't leap ahead when it comes back
const READOUT_INTERVAL_MS = 150;
const FIRST_MOMENT = Date.UTC(1900, 0, 1);
const LAST_MOMENT = Date.UTC(2100, 11, 31, 23, 59);
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const AXIS_HOURS = [0, 3, 6, 9, 12, 15, 18, 21];

/** Simulated milliseconds per real second. */
const SPEEDS = [
  { rate: HOUR_MS, label: '1 hour/s' },
  { rate: 6 * HOUR_MS, label: '6 hours/s' },
  { rate: 12 * HOUR_MS, label: '12 hours/s' },
];
const DEFAULT_RATE = 6 * HOUR_MS;

const pad = (value: number) => String(value).padStart(2, '0');
const minuteOfDay = (date: Date) => date.getUTCHours() * 60 + date.getUTCMinutes();

type DatePart = 'year' | 'month' | 'day';

/** Moves a date by one year, month or day, keeping the time of day. */
function stepDate(date: Date, part: DatePart, by: number): Date {
  const next = new Date(date);
  if (part === 'year') next.setUTCFullYear(next.getUTCFullYear() + by);
  if (part === 'month') next.setUTCMonth(next.getUTCMonth() + by);
  if (part === 'day') next.setUTCDate(next.getUTCDate() + by);
  return new Date(Math.min(LAST_MOMENT, Math.max(FIRST_MOMENT, next.getTime())));
}

/** The date and time bar: sets the UTC moment the Sun, Moon and night shading show, or plays it. */
export function Timeline({ map, visible }: { map: MapLibreMap; visible: boolean }) {
  const [chosen, setChosen] = useState<Date | null>(null); // null follows the real time
  const [now, setNow] = useState(() => new Date());
  const [shaded, setShaded] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(DEFAULT_RATE);

  useEffect(() => {
    if (chosen) return;
    const timer = window.setInterval(() => setNow(new Date()), LIVE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [chosen]);

  const shown = chosen ?? now;
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // A running time-lapse drives the clock itself, so stopping lands back on a true moment.
  useEffect(() => {
    if (!playing) skyClock.set(shown);
  }, [shown, playing]);

  useEffect(() => {
    if (!visible) setPlaying(false);
  }, [visible]);

  useEffect(() => {
    if (!playing) return;
    const start = shownRef.current.getTime();
    let elapsed = 0;
    let previous = performance.now();
    let displayed = start;
    let latest = start;
    let readoutTime = 0;
    let frame = 0;

    const tick = (time: number) => {
      elapsed += Math.min((time - previous) / 1000, LONGEST_FRAME_S) * rate;
      previous = time;
      const moment = start + elapsed;
      if (moment > LAST_MOMENT) {
        setPlaying(false);
        return;
      }
      skyClock.set(new Date(moment));
      latest = Math.floor(moment / MINUTE_MS) * MINUTE_MS;
      // The readout is slow to redraw, so it refreshes less often than the sky.
      if (latest !== displayed && time - readoutTime >= READOUT_INTERVAL_MS) {
        displayed = latest;
        readoutTime = time;
        setChosen(new Date(latest));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      if (latest !== displayed) setChosen(new Date(latest));
    };
  }, [playing, rate]);

  useEffect(() => {
    if (map.getLayer(NIGHT_LAYER)) map.setLayoutProperty(NIGHT_LAYER, 'visibility', shaded ? 'visible' : 'none');
    skyClock.set(skyClock.now()); // redraws the pole caps, which share this switch
  }, [map, shaded]);

  const minute = minuteOfDay(shown);
  const choose = (date: Date) => {
    setPlaying(false);
    setChosen(date);
  };
  const parts: { part: DatePart; text: string; name: string }[] = [
    { part: 'year', text: String(shown.getUTCFullYear()), name: 'year' },
    { part: 'month', text: MONTHS[shown.getUTCMonth()], name: 'month' },
    { part: 'day', text: pad(shown.getUTCDate()), name: 'day' },
  ];

  return (
    <section className="timeline" data-visible={visible} inert={!visible} aria-label="Date and time, UTC" data-testid="daylight">
      <div className="timeline__date" data-testid="daylight-date">
        {parts.map(({ part, text, name }) => (
          <div key={part} className="timeline__part">
            <button type="button" aria-label={`Next ${name}`} data-testid={`date-${part}-up`} onClick={() => choose(stepDate(shown, part, 1))}>
              <svg viewBox="0 0 10 6" aria-hidden="true"><path d="M0 6 5 0l5 6Z" /></svg>
            </button>
            <output>{text}</output>
            <button type="button" aria-label={`Previous ${name}`} data-testid={`date-${part}-down`} onClick={() => choose(stepDate(shown, part, -1))}>
              <svg viewBox="0 0 10 6" aria-hidden="true"><path d="M0 0h10L5 6Z" /></svg>
            </button>
          </div>
        ))}
      </div>

      <div className="timeline__clock">
        <output data-testid="daylight-clock">
          {pad(Math.floor(minute / 60))}:{pad(minute % 60)}
        </output>
        <span>UTC</span>
      </div>

      <div className="timeline__play">
        <button
          type="button"
          className="tool-button"
          aria-label={playing ? 'Pause the time-lapse' : 'Play a time-lapse'}
          data-testid="daylight-play"
          onClick={() => setPlaying((current) => !current)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {playing ? <path d="M4 3h3v10H4zM9 3h3v10H9z" /> : <path d="M4 2.5 13 8l-9 5.5Z" />}
          </svg>
        </button>
        <select value={rate} aria-label="Time-lapse speed" data-testid="daylight-speed" onChange={(event) => setRate(Number(event.target.value))}>
          {SPEEDS.map((option) => (
            <option key={option.rate} value={option.rate}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="timeline__axis">
        <input
          type="range"
          min={0}
          max={MINUTES_IN_DAY - 1}
          step={1}
          value={minute}
          aria-label="Time of day, UTC"
          data-testid="daylight-time"
          onChange={(event) => {
            const next = new Date(shown);
            next.setUTCHours(0, Number(event.target.value), 0, 0);
            choose(next);
          }}
        />
        <div className="timeline__hours" aria-hidden="true">
          {AXIS_HOURS.map((hour) => (
            <span key={hour} style={{ left: `${(hour / 24) * 100}%` }}>
              {pad(hour)}:00
            </span>
          ))}
        </div>
      </div>

      <div className="timeline__options">
        <button
          type="button"
          className="plain-button"
          disabled={chosen === null}
          data-testid="daylight-now"
          onClick={() => {
            setPlaying(false);
            setNow(new Date());
            setChosen(null);
          }}
        >
          Now
        </button>
        <label>
          <input type="checkbox" checked={shaded} onChange={(event) => setShaded(event.target.checked)} />
          Night side
        </label>
      </div>
    </section>
  );
}
