// Prepoznavanje gesti ruke iz MediaPipe landmarka.
// Značajke se računaju iz metričkih 3D "world" landmarka (neovisne o okretu
// ruke), a geste prolaze kroz stroj stanja s histerezom (strožim uvjetom za
// ulazak nego za izlazak), vremenom potvrde i cooldownom — bez treperenja.
//
// Indeksi: 0 zapešće · palac 1–4 · kažiprst 5–8 · srednji 9–12 · prstenjak 13–16 · mali 17–20

export const GESTURE_LABEL = {
  none: '—',
  point: 'kažiprst',
  pinch: 'pinch',
  open: 'otvoren dlan',
  fist: 'šaka',
};

const FINGERS = [
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
];
const DEG = 180 / Math.PI;

function sub(a, i, j, out) {
  out[0] = a[i * 3] - a[j * 3];
  out[1] = a[i * 3 + 1] - a[j * 3 + 1];
  out[2] = a[i * 3 + 2] - a[j * 3 + 2];
  return out;
}

function len(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

function dist(a, i, j) {
  return Math.hypot(a[i * 3] - a[j * 3], a[i * 3 + 1] - a[j * 3 + 1], a[i * 3 + 2] - a[j * 3 + 2]);
}

function angle(u, v) {
  const d = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / ((len(u) * len(v)) || 1);
  return Math.acos(Math.min(1, Math.max(-1, d))) * DEG;
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const _u = [0, 0, 0];
const _v = [0, 0, 0];
const _w = [0, 0, 0];

/**
 * Značajke ruke iz world landmarka (metri, ishodište u središtu ruke).
 * @param {Float32Array} w 21×3
 */
export function handFeatures(w) {
  // Veličina dlana: prosjek krutih bridova dlana (ne ovisi o savijanju prstiju).
  const S = (dist(w, 0, 5) + dist(w, 0, 17) + dist(w, 5, 17) + dist(w, 0, 9)) / 4 || 1e-3;

  // Normala dlana (za savijanje u MCP zglobu bez bočnog raširenja prstiju).
  sub(w, 5, 0, _u);
  sub(w, 17, 0, _v);
  const nx = _u[1] * _v[2] - _u[2] * _v[1];
  const ny = _u[2] * _v[0] - _u[0] * _v[2];
  const nz = _u[0] * _v[1] - _u[1] * _v[0];
  const nl = Math.hypot(nx, ny, nz) || 1;

  // Ispruženost prstiju: zbroj kutova savijanja u MCP, PIP i DIP zglobu.
  // MCP: kut izlaska članka iz ravnine dlana (raširenost u ravnini se ne broji).
  // Ravan prst ≈ 10–45°, opušteno savijen ≈ 70–110°, u šaci ≈ 200–260°.
  const ext = [0, 0, 0, 0, 0];
  const bends = [0, 0, 0, 0, 0];
  for (let f = 0; f < 4; f++) {
    const [m, p, d, t] = FINGERS[f];
    sub(w, p, m, _v);
    const out = Math.abs(_v[0] * nx + _v[1] * ny + _v[2] * nz) / (nl * (len(_v) || 1));
    let bend = Math.asin(Math.min(1, out)) * DEG;
    sub(w, d, p, _w);
    bend += angle(_v, _w);
    sub(w, t, d, _u);
    bend += angle(_w, _u);
    bends[f + 1] = bend;
    ext[f + 1] = 1 - smooth(65, 150, bend);
  }
  // Palac: koliko je vrh daleko od korijena kažiprsta (ispružen palac tvori "L").
  sub(w, 3, 2, _u);
  sub(w, 4, 3, _v);
  const thumbBend = angle(_u, _v);
  bends[0] = thumbBend;
  const thumbReach = dist(w, 4, 5) / S;
  ext[0] = smooth(0.42, 0.8, thumbReach) * (1 - smooth(45, 85, thumbBend));

  // Pinch: udaljenost vrhova palca i kažiprsta (normalizirano veličinom dlana).
  const pinchDist = dist(w, 4, 8) / S;
  const indexFar = dist(w, 8, 0) / S;

  // Raširenost: kutovi između susjednih prstiju (smjer MCP → vrh).
  const dir = (f, out) => sub(w, FINGERS[f][3], FINGERS[f][0], out);
  dir(0, _u);
  dir(1, _v);
  let spreadDeg = angle(_u, _v);
  dir(2, _w);
  spreadDeg += angle(_v, _w);
  dir(3, _u);
  spreadDeg += angle(_w, _u);
  // Palac od kažiprsta doprinosi pola (palac je i inače malo odmaknut).
  sub(w, 4, 2, _v);
  dir(0, _w);
  const thumbAngle = angle(_v, _w);
  spreadDeg += Math.max(0, thumbAngle - 25) * 0.35;
  const spread = smooth(20, 56, spreadDeg);

  return { S, ext, bends, pinchDist, indexFar, spreadDeg, spread, thumbAngle };
}

// Uvjeti ulaska (strogi) i ostanka (blaži) za svaku gestu.
const ENTER = {
  pinch: (f) => f.pinchDist < 0.27 && f.indexFar > 1.02 && f.ext[1] > 0.08,
  // Šaka: svi prsti savijeni i palac uvučen (podignut palac nije šaka).
  fist: (f) => Math.max(f.ext[1], f.ext[2], f.ext[3], f.ext[4]) < 0.28 && f.indexFar < 1.25 && f.ext[0] < 0.62,
  point: (f) => f.ext[1] > 0.72 && Math.max(f.ext[2], f.ext[3], f.ext[4]) < 0.4 && f.pinchDist > 0.38,
  open: (f) => Math.min(f.ext[1], f.ext[2], f.ext[3], f.ext[4]) > 0.72 && f.ext[0] > 0.4,
};
const STAY = {
  pinch: (f) => f.pinchDist < 0.42 && f.indexFar > 0.9,
  fist: (f) => Math.max(f.ext[1], f.ext[2], f.ext[3], f.ext[4]) < 0.5,
  point: (f) => f.ext[1] > 0.48 && Math.max(f.ext[2], f.ext[3], f.ext[4]) < 0.62 && f.pinchDist > 0.28,
  open: (f) => Math.min(f.ext[1], f.ext[2], f.ext[3], f.ext[4]) > 0.5 && f.ext[0] > 0.2,
};
// Prioritet kad vrijedi više uvjeta, i vrijeme potvrde (ms) prije aktivacije.
const PRIORITY = { pinch: 4, fist: 3, point: 2, open: 1, none: 0 };
const CONFIRM = { pinch: 55, fist: 140, point: 85, open: 110 };
const COOLDOWN = 160; // ms: ista gesta ne može odmah ponovno ući nakon izlaska

export class GestureMachine {
  constructor() {
    this.current = 'none';
    this.since = 0;
    this.candidate = null;
    this.candidateSince = 0;
    this.ended = {}; // gesta → vrijeme izlaska
  }

  /** @returns {string} trenutna gesta */
  update(f, now) {
    if (this.current !== 'none' && !STAY[this.current](f)) {
      this.ended[this.current] = now;
      this.current = 'none';
      this.since = now;
    }
    let best = null;
    for (const g of ['pinch', 'fist', 'point', 'open']) {
      if (ENTER[g](f)) {
        best = g;
        break;
      }
    }
    if (best && best !== this.current && PRIORITY[best] > PRIORITY[this.current]) {
      if (this.candidate !== best) {
        this.candidate = best;
        this.candidateSince = now;
      }
      const cooled = now - (this.ended[best] ?? -1e9) > COOLDOWN;
      if (cooled && now - this.candidateSince >= CONFIRM[best]) {
        if (this.current !== 'none') this.ended[this.current] = now;
        this.current = best;
        this.since = now;
        this.candidate = null;
      }
    } else {
      this.candidate = null;
    }
    return this.current;
  }

  reset(now) {
    if (this.current !== 'none') this.ended[this.current] = now;
    this.current = 'none';
    this.since = now;
    this.candidate = null;
  }
}

/**
 * Brzi "tap" prema kameri: kratak nalet približavanja (brzina dubine) koji se
 * zaustavi ili okrene. Radi na sirovoj dubini vrha prsta (cm), neovisno o gesti.
 */
export class TapDetector {
  constructor() {
    this.samples = []; // [t (s), z (cm), x, y (ndc)]
    this.phase = 'idle';
    this.startZ = 0;
    this.startXY = [0, 0];
    this.startT = 0;
    this.peakV = 0;
    this.cooldownUntil = 0;
  }

  reset() {
    this.samples.length = 0;
    this.phase = 'idle';
  }

  /** @returns {boolean} true u trenutku "udarca" */
  update(t, z, x, y) {
    const s = this.samples;
    s.push([t, z, x, y]);
    while (s.length > 6 || (s.length > 2 && t - s[0][0] > 0.2)) s.shift();
    if (s.length < 3) return false;
    // Brzina dubine: linearna regresija kroz zadnjih nekoliko uzoraka (cm/s).
    let mt = 0, mz = 0;
    for (const p of s) {
      mt += p[0];
      mz += p[1];
    }
    mt /= s.length;
    mz /= s.length;
    let num = 0, den = 0;
    for (const p of s) {
      num += (p[0] - mt) * (p[1] - mz);
      den += (p[0] - mt) ** 2;
    }
    const v = den > 1e-6 ? num / den : 0; // negativno = prema ekranu

    if (this.phase === 'idle') {
      if (t > this.cooldownUntil && v < -42) {
        this.phase = 'moving';
        const first = s[0];
        this.startZ = first[1];
        this.startXY = [first[2], first[3]];
        this.startT = first[0];
        this.peakV = v;
      }
      return false;
    }
    // Faza naleta: čekaj zaustavljanje/okret.
    this.peakV = Math.min(this.peakV, v);
    const travel = this.startZ - z;
    const lateral = Math.hypot(x - this.startXY[0], y - this.startXY[1]);
    if (t - this.startT > 0.45) {
      this.phase = 'idle';
      return false;
    }
    if (v > this.peakV * 0.25 || v > -10) {
      this.phase = 'idle';
      // Dovoljno dug i dovoljno "ravan" pokret prema ekranu (ne zamah u stranu).
      if (travel > 3.2 && lateral < 0.35 + travel * 0.02) {
        this.cooldownUntil = t + 0.45;
        return true;
      }
    }
    return false;
  }
}
