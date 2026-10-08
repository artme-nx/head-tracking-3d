// Praćenje glave web kamerom (MediaPipe FaceLandmarker) → položaj očiju u cm
// u koordinatnom sustavu ekrana: ishodište u centru ekrana, +x desno, +y gore,
// +z prema gledatelju. Kamera je iznad gornjeg ruba ekrana.
// Detekciju radi VisionSource (worker); ovdje je samo geometrija i filtriranje.
// Kad ruka zakloni oči, zadržava se zadnji položaj glave i praćenje se glatko
// nastavlja kad se lice opet vidi.

import { OneEuroFilter3, OneEuroFilter } from './oneEuro.js';

// Središta šarenica (refined landmarks): 468–472 i 473–477.
const IRIS_A = 468;
const IRIS_B = 473;
const LOST_AFTER_MS = 250;
const HOLD_MAX_MS = 6000; // najdulje zadržavanje dok ruka zaklanja lice
const REACQUIRE_S = 0.45; // glatki prijelaz sa zadržanog na novi položaj

export class HeadTracker {
  /** @param {import('./vision.js').VisionSource} vision */
  constructor(settings, vision) {
    this.settings = settings;
    this.vision = vision;
    this.error = null;

    this.lastSeq = 0;
    this.lastSeen = -Infinity;
    this.tracking = false;

    this.posFilter = new OneEuroFilter3({ minCutoff: 1, beta: 0.04, dCutoff: 1 }, [1, 1, 0.6]);
    this.rollFilter = new OneEuroFilter({ minCutoff: 1, beta: 0.02 });
    this.applySettings(settings);

    /** Filtrirani centar između očiju [x, y, z] u cm. */
    this.head = [0, 0, 60];
    /** Nagib glave (roll) u radijanima — smjer linije između očiju. */
    this.roll = 0;
    /** Sirovi podaci za debug overlay. */
    this.raw = null;
    /** Područje očiju u normaliziranim koordinatama slike (za provjeru zaklanjanja rukom). */
    this.eyeBox = null;
    /** true dok ruka zaklanja oči (položaj glave se drži). */
    this.held = false;
    this.holdSince = 0;
    this.heldHead = null;
    this.heldRoll = 0;
    this.freshAfterHold = false;
    this.reacquire = 1; // 0..1 napredak glatkog prijelaza nakon zaklanjanja (1 = nema prijelaza)
    this.filtered = [0, 0, 60];
    this.filteredRoll = 0;
  }

  get video() {
    return this.vision.video;
  }

  get ready() {
    return this.vision.ready;
  }

  get detectMs() {
    return this.vision.faceMs;
  }

  applySettings(settings) {
    this.settings = settings;
    this.posFilter.setParams({ minCutoff: settings.smoothing, beta: settings.responsiveness });
    this.rollFilter.minCutoff = settings.smoothing;
  }

  start() {
    return this.vision.start();
  }

  /**
   * Poziva se jednom po frameu. Vraća true ako je lice trenutno praćeno
   * (ili se položaj drži jer ga ruka zaklanja).
   * @param {Array<{x0:number,y0:number,x1:number,y1:number}>} handBoxes okviri ruku u slici (normalizirano)
   */
  update(nowMs, handBoxes = [], dt = 1 / 60) {
    if (!this.ready) return false;
    const r = this.vision.result;
    const occluded = this.#occluded(handBoxes);
    if (r.faceSeq !== this.lastSeq) {
      this.lastSeq = r.faceSeq;
      const face = r.face;
      if (face && !occluded) this.#process(face, r.width, r.height, nowMs);
    }

    // Ruka preko očiju: drži zadnji položaj (do HOLD_MAX_MS), praćenje ostaje "živo".
    if (occluded && this.tracking) {
      if (!this.held) {
        this.held = true;
        this.holdSince = nowMs;
        this.heldHead = [...this.head];
        this.heldRoll = this.roll;
      }
      if (nowMs - this.holdSince < HOLD_MAX_MS) this.lastSeen = nowMs;
    }

    const tracking = nowMs - this.lastSeen < LOST_AFTER_MS;
    if (!tracking && this.tracking) {
      // Lice izgubljeno: sljedeća detekcija kreće s čistim filterom (bez "repa").
      this.posFilter.reset();
      this.rollFilter.reset();
      this.held = false;
      this.reacquire = 1;
    }
    this.tracking = tracking;

    if (this.held) {
      if (occluded) {
        this.head = [...this.heldHead];
        this.roll = this.heldRoll;
      } else if (this.freshAfterHold) {
        // Lice se opet vidi: filter je krenuo od nove mjere, izlaz glatko prelazi sa zadržanog.
        this.held = false;
        this.reacquire = 0;
      } else {
        this.head = [...this.heldHead];
        this.roll = this.heldRoll;
      }
    }
    if (!this.held && this.reacquire < 1 && this.heldHead) {
      this.reacquire = Math.min(1, this.reacquire + dt / REACQUIRE_S);
      const e = this.reacquire * this.reacquire * (3 - 2 * this.reacquire);
      for (let i = 0; i < 3; i++) this.head[i] = this.heldHead[i] + (this.filtered[i] - this.heldHead[i]) * e;
      this.roll = this.heldRoll + (this.filteredRoll - this.heldRoll) * e;
    }
    this.freshAfterHold = false;
    return tracking;
  }

  /** Zaklanja li neka ruka područje očiju (zadnje poznato)? */
  #occluded(handBoxes) {
    const e = this.eyeBox;
    if (!e || !handBoxes.length) return false;
    const area = (e.x1 - e.x0) * (e.y1 - e.y0);
    for (const h of handBoxes) {
      const ix = Math.min(e.x1, h.x1) - Math.max(e.x0, h.x0);
      const iy = Math.min(e.y1, h.y1) - Math.max(e.y0, h.y0);
      if (ix > 0 && iy > 0 && (ix * iy) / area > 0.18) return true;
    }
    return false;
  }

  #process(lm, W, H, nowMs) {
    const s = this.settings;
    const L = lm.landmarks;
    const matrix = lm.matrix;

    const ax = L[IRIS_A * 3] * W, ay = L[IRIS_A * 3 + 1] * H;
    const bx = L[IRIS_B * 3] * W, by = L[IRIS_B * 3 + 1] * H;
    let dpx = Math.hypot(bx - ax, by - ay);
    if (dpx < 2) return;

    // Područje očiju (normalizirano): obje oči s marginom.
    const cx = (ax + bx) / 2 / W, cy = (ay + by) / 2 / H;
    const hw = (dpx / W) * 1.05, hh = (dpx / H) * 0.6;
    this.eyeBox = { x0: cx - hw, x1: cx + hw, y0: cy - hh, y1: cy + hh };

    // Okretanje glave lijevo/desno (yaw) skraćuje projicirani razmak zjenica.
    // Iz transformacijske matrice lica: X os lica u koordinatama kamere.
    if (matrix) {
      const rx = matrix[0], ry = matrix[1], rz = matrix[2];
      const len = Math.hypot(rx, ry, rz) || 1;
      const inPlane = Math.hypot(rx, ry) / len;
      dpx /= Math.min(Math.max(inPlane, 0.7), 1);
    }

    // Pinhole model: fokalna duljina u pikselima iz horizontalnog FOV-a.
    const f = W / 2 / Math.tan(((s.cameraFov * Math.PI) / 180) / 2);
    const z = (f * s.ipd) / dpx;

    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const xCam = ((mx - W / 2) * z) / f; // desno u slici kamere
    const yCam = ((my - H / 2) * z) / f; // dolje u slici kamere

    // Slika kamere nije zrcaljena: korisnikovo "desno" je lijevo u slici.
    const x = -xCam;
    const y = s.screenHeight / 2 + s.cameraOffset - yCam;

    const t = nowMs / 1000;
    if (this.held) {
      // Prvo mjerenje nakon zaklanjanja: filter kreće ispočetka od nove mjere.
      this.posFilter.reset();
      this.rollFilter.reset();
      this.freshAfterHold = true;
    }
    this.filtered = this.posFilter.filter([x, y, z], t);
    // Roll u koordinatama ekrana (x zrcaljen, y prema gore).
    let roll = Math.atan2(-(by - ay), -(bx - ax));
    if (roll > Math.PI / 2) roll -= Math.PI;
    if (roll < -Math.PI / 2) roll += Math.PI;
    this.filteredRoll = this.rollFilter.filter(roll, t);
    if (!this.held && this.reacquire >= 1) {
      this.head = this.filtered;
      this.roll = this.filteredRoll;
    }

    this.raw = { ax, ay, bx, by, W, H, z, x, y, landmarks: L };
    this.lastSeen = nowMs;
  }
}
