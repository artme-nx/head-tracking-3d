// Praćenje ruku (MediaPipe HandLandmarker, do 2 ruke) → za svaku ruku:
//   · položaj vrha kažiprsta, točke pincha i dlana u koordinatama ekrana
//     (NDC, -1..1) i relativna dubina (udaljenost ruke / udaljenost glave),
//   · gesta (kažiprst, pinch, otvoren dlan, šaka) s histerezom i cooldownom,
//   · raširenost prstiju, "tap" prema kameri,
// te okvir od dvije ruke (palci + kažiprsti tvore pravokutnik).
//
// Dubina ruke: pinhole model iz veličine dlana. Metrički "world" landmarki daju
// stvarnu (skraćenu) duljinu bridova dlana u ravnini slike, pa je procjena
// neovisna o okretu ruke: z = f · L_world / L_piksela. Mjerilo ruke je zadano
// širinom dlana (~8,5 cm).

import { OneEuroFilter } from './oneEuro.js';
import { GestureMachine, TapDetector, handFeatures } from './gestures.js';

export const HAND_BREADTH = 8.5; // cm — širina dlana (preko zglobova prstiju)
const KNUCKLE_SPAN = HAND_BREADTH * 0.8; // razmak središta zglobova kažiprsta i malog prsta (5–17)
const Z_REF = 40; // cm — referentna udaljenost ruke za mapiranje kadra na ekran
const GAIN = 1.3; // središnjih ~77 % kadra pokriva cijeli ekran
const Y_OFFSET = 0.12; // ruke su prirodno malo niže od osi kamere
const LOST_MS = 220; // ruka "živi" još malo nakon zadnje detekcije (bez treperenja)
const PALM_SEGMENTS = [
  [0, 5],
  [0, 9],
  [0, 13],
  [0, 17],
  [5, 17],
];

function oneEuro2(minCutoff, beta) {
  return [new OneEuroFilter({ minCutoff, beta }), new OneEuroFilter({ minCutoff, beta })];
}

class HandTrack {
  constructor(id) {
    this.id = id;
    this.label = '';
    this.firstSeen = 0;
    this.lastSeen = 0;
    this.gestures = new GestureMachine();
    this.gesture = 'none';
    this.tap = new TapDetector();
    this.features = null;
    this.landmarks = null;
    this.world = null;
    this.box = null;
    this.wrist = [0.5, 0.5];
    // Filtrirane točke: [ndcX, ndcY, ln(r)] gdje je r = udaljenost točke / udaljenost glave.
    this.filters = {
      tip: { xy: oneEuro2(1.0, 0.9), d: new OneEuroFilter({ minCutoff: 0.7, beta: 0.35 }) },
      pinch: { xy: oneEuro2(1.0, 0.9), d: new OneEuroFilter({ minCutoff: 0.7, beta: 0.35 }) },
      palm: { xy: oneEuro2(1.0, 0.9), d: new OneEuroFilter({ minCutoff: 0.7, beta: 0.35 }) },
    };
    this.pts = { tip: [0, 0, 0], pinch: [0, 0, 0], palm: [0, 0, 0] };
    this.spreadFilter = new OneEuroFilter({ minCutoff: 1.4, beta: 0.4 });
    this.spread = 0;
    this.pinch = 0;
    this.distanceCm = 0; // udaljenost dlana od kamere
    this.lVertex = [0, 0]; // vrh "L" (palac + kažiprst) u NDC — za redateljski okvir
    this.lIndex = [0, 1];
    this.lThumb = [1, 0];
  }
}

export class HandTracker {
  /** @param {import('./vision.js').VisionSource} vision */
  constructor(settings, vision) {
    this.settings = settings;
    this.vision = vision;
    this.tracks = [];
    this.nextId = 1;
    this.lastSeq = 0;
    this.events = []; // jednokratni događaji iz zadnjeg update()a (tap)
    this.frame = { valid: false, rect: null, since: 0 };
    this.handMs = 0;
  }

  get ready() {
    return this.vision.handsReady;
  }

  /** Okviri ruku u normaliziranim koordinatama slike (za provjeru zaklanja li ruka lice). */
  get boxes() {
    return this.tracks.filter((t) => t.box && this.now - t.lastSeen < 120).map((t) => t.box);
  }

  /**
   * @param {number} nowMs
   * @param {number} headZ udaljenost glave od ekrana (cm) — referenca za relativnu dubinu
   */
  update(nowMs, headZ = 60) {
    this.now = nowMs;
    this.events.length = 0;
    if (!this.ready) return;
    const r = this.vision.result;
    if (r.handSeq !== this.lastSeq) {
      this.lastSeq = r.handSeq;
      this.#ingest(r.hands ?? [], r.width, r.height, nowMs, headZ);
    }
    this.tracks = this.tracks.filter((t) => nowMs - t.lastSeen < LOST_MS);
    this.#updateFrame(nowMs);
  }

  #ingest(hands, W, H, nowMs, headZ) {
    if (!W || !H) return;
    // Povezivanje s postojećim tragovima po položaju zapešća (najbliži par).
    const used = new Set();
    const assigned = hands.map((h) => {
      const wx = h.landmarks[0], wy = h.landmarks[1];
      let best = null, bestD = 0.25;
      for (const t of this.tracks) {
        if (used.has(t)) continue;
        const d = Math.hypot(t.wrist[0] - wx, t.wrist[1] - wy);
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
      if (!best) {
        best = new HandTrack(this.nextId++);
        best.firstSeen = nowMs;
        this.tracks.push(best);
      }
      used.add(best);
      return best;
    });
    hands.forEach((h, i) => this.#processHand(assigned[i], h, W, H, nowMs, headZ));
  }

  #processHand(track, h, W, H, nowMs, headZ) {
    const s = this.settings;
    const L = h.landmarks;
    const w = h.world;
    track.landmarks = L;
    track.world = w;
    track.lastSeen = nowMs;
    track.wrist = [L[0], L[1]];
    // Slika nije zrcaljena, a MediaPipe pretpostavlja zrcaljenu: "Left" je korisnikova desna ruka.
    track.label = h.handedness === 'Left' ? 'D' : h.handedness === 'Right' ? 'L' : '?';

    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (let i = 0; i < 21; i++) {
      x0 = Math.min(x0, L[i * 3]);
      x1 = Math.max(x1, L[i * 3]);
      y0 = Math.min(y0, L[i * 3 + 1]);
      y1 = Math.max(y1, L[i * 3 + 1]);
    }
    const mx = (x1 - x0) * 0.08, my = (y1 - y0) * 0.08;
    track.box = { x0: x0 - mx, y0: y0 - my, x1: x1 + mx, y1: y1 + my };

    // --- Dubina dlana iz veličine (pinhole) ---
    const f = W / 2 / Math.tan(((s.cameraFov * Math.PI) / 180) / 2);
    const k = (KNUCKLE_SPAN / 100) / (Math.hypot(w[15] - w[51], w[16] - w[52], w[17] - w[53]) || 0.07); // world (m) → cm stvarne ruke
    let lw = 0, lp = 0;
    for (const [a, b] of PALM_SEGMENTS) {
      lw += Math.hypot(w[a * 3] - w[b * 3], w[a * 3 + 1] - w[b * 3 + 1]) * 100 * k;
      lp += Math.hypot((L[a * 3] - L[b * 3]) * W, (L[a * 3 + 1] - L[b * 3 + 1]) * H);
    }
    if (lp < 4) return;
    const zPalm = (f * lw) / lp;
    track.distanceCm = zPalm;
    // Dubina pojedine točke: dubina dlana + relativna dubina iz world landmarka.
    const pc = [0, 5, 9, 13, 17];
    let wcz = 0;
    for (const i of pc) wcz += w[i * 3 + 2];
    wcz /= pc.length;
    const depthOf = (i) => zPalm + (w[i * 3 + 2] - wcz) * 100 * k;

    // Položaj u kadru → NDC ekrana (kao da je ruka na referentnoj udaljenosti, bez perspektivnog klizanja).
    const tanH = Math.tan(((s.cameraFov * Math.PI) / 180) / 2);
    const tanV = (tanH * H) / W;
    const toNdc = (u, v, z, out) => {
      const xCam = ((u * W - W / 2) * z) / f;
      const yCam = ((v * H - H / 2) * z) / f;
      out[0] = (-xCam / (Z_REF * tanH)) * GAIN;
      out[1] = (-yCam / (Z_REF * tanV) + Y_OFFSET) * GAIN;
      return out;
    };
    const t = nowMs / 1000;
    const ref = Math.max(20, headZ);
    const point = (name, u, v, z) => {
      const p = toNdc(u, v, z, [0, 0]);
      const F = track.filters[name];
      track.pts[name][0] = F.xy[0].filter(p[0], t);
      track.pts[name][1] = F.xy[1].filter(p[1], t);
      track.pts[name][2] = F.d.filter(Math.log(Math.max(0.05, z / ref)), t);
      return p;
    };
    const zTip = depthOf(8);
    const tipRaw = point('tip', L[24], L[25], zTip);
    point('pinch', (L[12] + L[24]) / 2, (L[13] + L[25]) / 2, (depthOf(4) + zTip) / 2);
    let pu = 0, pv = 0;
    for (const i of pc) {
      pu += L[i * 3];
      pv += L[i * 3 + 1];
    }
    point('palm', pu / pc.length, pv / pc.length, zPalm);

    // --- Geste ---
    const feat = handFeatures(w);
    track.features = feat;
    track.gesture = track.gestures.update(feat, nowMs);
    track.spread = track.spreadFilter.filter(feat.spread, t);
    track.pinch = 1 - Math.min(1, Math.max(0, (feat.pinchDist - 0.2) / 0.32));

    // Tap: brzi nalet vrha prsta prema ekranu.
    if (track.tap.update(t, zTip, tipRaw[0], tipRaw[1])) {
      this.events.push({ type: 'tap', hand: track.id, ndc: [track.pts.tip[0], track.pts.tip[1]] });
    }

    // "L" za redateljski okvir: vrh između korijena palca i kažiprsta, smjerovi u ravnini ekrana.
    const a = toNdc(L[6], L[7], depthOf(2), [0, 0]);
    const b = toNdc(L[15], L[16], depthOf(5), [0, 0]);
    track.lVertex = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const it = toNdc(L[24], L[25], zTip, [0, 0]);
    const tt = toNdc(L[12], L[13], depthOf(4), [0, 0]);
    track.lIndex = norm2([it[0] - b[0], it[1] - b[1]]);
    track.lThumb = norm2([tt[0] - a[0], tt[1] - a[1]]);
  }

  /** Okvir od dvije ruke: dva "L" na suprotnim kutovima pravokutnika. */
  #updateFrame(nowMs) {
    const fr = this.frame;
    const live = this.tracks.filter((t) => nowMs - t.lastSeen < 160 && t.features);
    let valid = false;
    if (live.length === 2) {
      const [A, B] = live;
      valid = frameScore(A, B, fr.valid ? 0.28 : 0.5);
      if (valid) {
        const r = {
          x0: Math.min(A.lVertex[0], B.lVertex[0]),
          x1: Math.max(A.lVertex[0], B.lVertex[0]),
          y0: Math.min(A.lVertex[1], B.lVertex[1]),
          y1: Math.max(A.lVertex[1], B.lVertex[1]),
        };
        // Glađenje pravokutnika (vrhovi "L"-ova malo podrhtavaju).
        if (fr.rect && fr.valid) {
          const k = 0.35;
          for (const key of ['x0', 'x1', 'y0', 'y1']) fr.rect[key] += (r[key] - fr.rect[key]) * k;
        } else {
          fr.rect = r;
        }
      }
    }
    if (valid && !fr.valid) fr.since = nowMs;
    if (valid) fr.lastValid = nowMs;
    // Kratki ispad jednog framea ne prekida okvir.
    fr.valid = valid || (fr.valid && nowMs - (fr.lastValid ?? 0) < 140);
  }
}

function norm2(v) {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

/** Jesu li ruke A i B u položaju redateljskog okvira? */
function frameScore(A, B, threshold) {
  for (const T of [A, B]) {
    const f = T.features;
    if (f.ext[1] < 0.5 || f.ext[0] < 0.3) return false;
    // Palac i kažiprst tvore "L" (kut u ravnini ekrana 50°–130°).
    const c = T.lIndex[0] * T.lThumb[0] + T.lIndex[1] * T.lThumb[1];
    if (Math.abs(c) > 0.64) return false;
  }
  const dx = B.lVertex[0] - A.lVertex[0];
  const dy = B.lVertex[1] - A.lVertex[1];
  if (Math.abs(dx) < 0.22 || Math.abs(dy) < 0.16) return false;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  // Prsti svake ruke idu duž bridova pravokutnika, prema drugoj ruci.
  const fits = (T, ex, ey) => {
    const i = T.lIndex, t = T.lThumb;
    const a = Math.min(i[1] * ey, t[0] * ex); // kažiprst okomito, palac vodoravno
    const b = Math.min(i[0] * ex, t[1] * ey); // ili obrnuto
    return Math.max(a, b);
  };
  return fits(A, sx, sy) > threshold && fits(B, -sx, -sy) > threshold;
}
