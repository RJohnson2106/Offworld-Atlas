import { useEffect, useRef } from 'react';

interface LandingProps {
  /** How many new candidate places the atlas holds, and in how many countries. */
  candidates: number;
  countries: number;
  /** True while the page fades out. */
  leaving: boolean;
  reducedMotion: boolean;
  onEnter: () => void;
  onTour: () => void;
}

const base = import.meta.env.BASE_URL;

/**
 * The first thing a visitor sees: a welcome over a looping film of the Mount Suswa relief model,
 * with the way into the atlas. The film is a Blender render of real elevation data
 * (brand/source/render_flyover.py), tinted grey for the Moon and rust for Mars.
 */
export function Landing({ candidates, countries, leaving, reducedMotion, onEnter, onTour }: LandingProps) {
  const enterRef = useRef<HTMLButtonElement>(null);
  const filmRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    enterRef.current?.focus({ preventScroll: true });
  }, []);

  // People who ask for less motion get the still first frame.
  useEffect(() => {
    const film = filmRef.current;
    if (!film || reducedMotion) return;
    film.play().catch(() => {
      // Autoplay can be refused. The poster frame stays in place.
    });
  }, [reducedMotion]);

  return (
    <section
      className="landing"
      role="dialog"
      aria-modal="true"
      aria-labelledby="landing-title"
      data-leaving={leaving}
      data-testid="landing"
    >
      <video
        ref={filmRef}
        className="landing__film"
        src={`${base}brand/landing-loop.mp4`}
        poster={`${base}brand/landing-poster.jpg`}
        muted
        loop
        playsInline
        preload="auto"
        aria-hidden="true"
        tabIndex={-1}
      />
      <div className="landing__shade" />

      <div className="landing__content">
        <img className="landing__emblem" src={`${base}brand/emblem.webp`} alt="" width="72" height="72" />
        <h1 id="landing-title">Welcome to Offworld Atlas</h1>
        <p className="landing__lead">
          Before anyone builds a base on the Moon or lands on Mars, crews and machines rehearse on Earth, in places that
          resemble where they are going. These places are called analogs. This atlas presents {candidates} new candidate
          analog sites in {countries} countries, found by screening the whole Earth and measured with open NASA and ESA
          data. Each one is compared, trait by trait, with real Moon and Mars sites. You can fly over any of them, rank
          them against a base, and see what a mission team could test there.
        </p>
        <button ref={enterRef} type="button" className="landing__enter" data-testid="landing-enter" onClick={onEnter}>
          Enter
        </button>
        <button type="button" className="landing__tour" data-testid="landing-tour" onClick={onTour}>
          or take the guided tour
        </button>
      </div>

      <p className="landing__credit">
        Background: Mount Suswa, Kenya, modelled from the Copernicus DEM. Grey reads as the Moon, rust as Mars.
      </p>
    </section>
  );
}
