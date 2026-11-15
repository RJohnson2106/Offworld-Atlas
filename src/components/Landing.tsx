import { useEffect, useRef } from 'react';

interface LandingProps {
  /** How many new candidate places the atlas holds, and in how many countries. */
  candidates: number;
  countries: number;
  /** True while the page fades out. */
  leaving: boolean;
  onEnter: () => void;
  onTour: () => void;
}

const base = import.meta.env.BASE_URL;

/** The first thing a visitor sees: the project's name and artwork, with the way into the atlas. */
export function Landing({ candidates, countries, leaving, onEnter, onTour }: LandingProps) {
  const enterRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    enterRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <section
      className="landing"
      role="dialog"
      aria-modal="true"
      aria-labelledby="landing-title"
      data-leaving={leaving}
      data-testid="landing"
    >
      <div className="landing__text">
        <img className="landing__emblem" src={`${base}brand/emblem.webp`} alt="" width="88" height="88" />
        <p className="landing__event">NASA Space Apps Challenge 2026</p>
        <h1 id="landing-title">Offworld Atlas</h1>
        <p className="landing__tagline">New Earth stand-ins for the Moon and Mars</p>
        <p className="landing__lead">
          An atlas of {candidates} new candidate analog sites in {countries} countries. Each one is measured with open
          NASA and ESA data and compared, trait by trait, with real Moon and Mars sites.
        </p>
        <div className="landing__actions">
          <button ref={enterRef} type="button" className="landing__enter" data-testid="landing-enter" onClick={onEnter}>
            Enter the atlas
          </button>
          <button type="button" className="landing__tour" data-testid="landing-tour" onClick={onTour}>
            Take the guided tour
          </button>
        </div>
      </div>
      <figure className="landing__plate">
        <img
          src={`${base}brand/relief-block.webp`}
          alt="A relief model of Mount Suswa in Kenya, tinted grey for the Moon on one half and rust for Mars on the other"
          width="1600"
          height="824"
        />
        <figcaption>
          <em>Plate:</em> Mount Suswa, Kenya, 1.15° S 36.35° E. Real elevation from the Copernicus DEM, heights drawn three
          times taller.
        </figcaption>
      </figure>
    </section>
  );
}
