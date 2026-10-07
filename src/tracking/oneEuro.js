// One Euro filter (Casiez, Roussel, Vogel 2012): adaptivni niskopropusni filtar.
// Pri mirovanju jako zaglađuje (nema podrhtavanja), pri brzom pokretu
// podiže cutoff pa kašnjenje ostaje malo.

function alpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  constructor({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }

  /** @param {number} value  @param {number} t vrijeme u sekundama */
  filter(value, t) {
    if (this.x === null) {
      this.x = value;
      this.dx = 0;
      this.t = t;
      return value;
    }
    const dt = Math.max(t - this.t, 1e-4);
    this.t = t;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/** Vektorska varijanta: isti parametri za sve komponente, osim ako se zada skala po osi. */
export class OneEuroFilter3 {
  constructor(params, axisScale = [1, 1, 1]) {
    this.axisScale = axisScale;
    this.filters = axisScale.map(() => new OneEuroFilter(params));
  }

  setParams({ minCutoff, beta }) {
    this.filters.forEach((f, i) => {
      // Z (iz razmaka zjenica) je bitno šumovitiji pa dobiva niži cutoff.
      f.minCutoff = minCutoff * this.axisScale[i];
      f.beta = beta;
    });
  }

  reset() {
    this.filters.forEach((f) => f.reset());
  }

  filter(v, t) {
    return [this.filters[0].filter(v[0], t), this.filters[1].filter(v[1], t), this.filters[2].filter(v[2], t)];
  }
}
