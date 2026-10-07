// ORBIT način upravljanja kamerom: perspektivna kamera uvijek gleda u točku
// interesa, a položaj glave (relativno na kalibrirani neutralni položaj) upravlja
// orbitom:
//   vodoravni pomak glave → azimut (pomakneš glavu udesno = kamera ide udesno oko objekta)
//   okomiti pomak glave   → elevacija
//   promjena udaljenosti  → dolly (nagneš se naprijed = kamera bliže, objekt raste)
// Krivulja odziva: mrtva zona → mekano koljeno → gotovo linearno → tanh meki limit.
// Kretanje ide kroz kritično prigušenu oprugu (težina i inercija bez podrhtavanja).

import * as THREE from 'three';

const STORAGE_KEY = 'head-tracking-3d:orbit:v1';

export const ORBIT_DEFAULTS = Object.freeze({
  azGain: 75, // ° orbite za 20 cm vodoravnog pomaka glave
  maxAz: 90, // ° (meki limit)
  elGain: 20, // ° elevacije za 15 cm okomitog pomaka
  maxEl: 30, // °
  zoomRange: 1.6, // dolly između 1/range i range neutralne udaljenosti
  zoomGain: 1.6, // osjetljivost na relativnu promjenu udaljenosti glave
  deadZone: 0.9, // cm
  stiffness: 3.4, // Hz — vlastita frekvencija opruge
});

export const ORBIT_FIELDS = [
  { key: 'azGain', label: 'Pojačanje azimuta (° na 20 cm)', min: 20, max: 150, step: 1, unit: '°' },
  { key: 'maxAz', label: 'Maksimalni kut orbite', min: 20, max: 90, step: 1, unit: '°' },
  { key: 'elGain', label: 'Pojačanje elevacije (° na 15 cm)', min: 0, max: 60, step: 1, unit: '°' },
  { key: 'maxEl', label: 'Maksimalna elevacija', min: 0, max: 45, step: 1, unit: '°' },
  { key: 'zoomRange', label: 'Raspon zooma (×)', min: 1.0, max: 2.5, step: 0.05, unit: '×' },
  { key: 'zoomGain', label: 'Osjetljivost zooma', min: 0.3, max: 3, step: 0.05, unit: '' },
  { key: 'deadZone', label: 'Mrtva zona', min: 0, max: 4, step: 0.1, unit: 'cm' },
  { key: 'stiffness', label: 'Krutost opruge', min: 0.8, max: 9, step: 0.1, unit: 'Hz' },
];

export function loadOrbitSettings() {
  const out = { ...ORBIT_DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      for (const k of Object.keys(ORBIT_DEFAULTS)) if (typeof parsed[k] === 'number') out[k] = parsed[k];
    }
  } catch {
    /* pohrana nedostupna */
  }
  return out;
}

export function saveOrbitSettings(s) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* pohrana nedostupna */
  }
}

const DEG = Math.PI / 180;
const KNEE = 1.6; // cm — širina mekog prijelaza iz mrtve zone

/** Pomak nakon mrtve zone s C1-glatkim koljenom. */
function afterDeadZone(a, dz, knee) {
  const t = Math.max(0, a - dz);
  return t < knee ? (t * t) / (2 * knee) : t - knee / 2;
}

/**
 * Krivulja odziva: u (cm) → kut (°). `ref` cm pomaka daje `atRef` stupnjeva,
 * a izlaz se mekano približava `limit` (tanh) umjesto naglog zaustavljanja.
 */
function responseCurve(u, dz, ref, atRef, limit) {
  if (limit <= 0) return 0;
  const target = Math.min(Math.abs(atRef) / limit, 0.985);
  const tRef = Math.max(afterDeadZone(ref, dz, KNEE), 1e-3);
  const gain = (limit * Math.atanh(target)) / tRef; // °/cm u linearnom dijelu
  const t = afterDeadZone(Math.abs(u), dz, KNEE);
  return Math.sign(u) * limit * Math.tanh((gain * t) / limit);
}

/** Kritično prigušena opruga — točno rješenje za konstantni cilj (stabilno pri svakom dt). */
class CriticalSpring {
  constructor(x = 0) {
    this.x = x;
    this.v = 0;
  }
  update(target, dt, freq) {
    const w = 2 * Math.PI * freq;
    const e = this.x - target;
    const k = Math.exp(-w * dt);
    const tmp = (this.v + w * e) * dt;
    this.x = target + (e + tmp) * k;
    this.v = (this.v - w * tmp) * k;
    return this.x;
  }
  snap(x) {
    this.x = x;
    this.v = 0;
  }
}

const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class OrbitController {
  constructor(settings) {
    this.s = settings;
    this.neutral = null; // THREE.Vector3 (cm, prostor ekrana)
    this.calib = null; // { until, sum, n }
    this.azS = new CriticalSpring();
    this.elS = new CriticalSpring();
    this.zoomS = new CriticalSpring(); // u log prostoru
    this.az = 0;
    this.el = 0;
    this.zoom = 1;
    this.override = null; // { az, el, zoom } — za testove
    this.target = { az: 0, el: 0, lz: 0 };
  }

  get calibrating() {
    return !!this.calib;
  }

  /** Započni kalibraciju neutralnog položaja (prosjek glave kroz `seconds`). */
  recalibrate(now, seconds = 1.4) {
    this.calib = { until: now + seconds * 1000, sum: new THREE.Vector3(), n: 0 };
  }

  setNeutral(v) {
    this.neutral = v.clone();
    this.calib = null;
  }

  /**
   * @param {number} now ms
   * @param {number} dt s
   * @param {THREE.Vector3|null} head zadnji praćeni položaj glave (cm)
   * @param {number} weight 0..1 koliko je praćenje "živo" (0 = lice izgubljeno)
   */
  update(now, dt, head, weight) {
    if (this.calib && head && weight > 0.5) {
      this.calib.sum.add(head);
      this.calib.n++;
      if (now >= this.calib.until && this.calib.n > 5) {
        this.neutral = this.calib.sum.divideScalar(this.calib.n);
        this.calib = null;
      }
    }

    let az = 0, el = 0, lz = 0;
    if (this.override) {
      az = this.override.az;
      el = this.override.el;
      lz = Math.log(this.override.zoom);
    } else if (head && this.neutral && !this.calib) {
      const s = this.s;
      const dx = (head.x - this.neutral.x) * weight;
      const dy = (head.y - this.neutral.y) * weight;
      const rz = 1 + (head.z / this.neutral.z - 1) * weight;
      az = responseCurve(dx, s.deadZone, 20, s.azGain, s.maxAz);
      el = responseCurve(dy, s.deadZone, 15, s.elGain, s.maxEl);
      // Dolly: relativna promjena udaljenosti, u log prostoru (simetrično za bliže/dalje).
      const L = Math.log(Math.max(1.0001, s.zoomRange));
      const lr = Math.log(Math.max(0.2, rz));
      const dzLog = 0.03;
      const tz = Math.max(0, Math.abs(lr) - dzLog);
      lz = Math.sign(lr) * L * Math.tanh((s.zoomGain * tz) / L);
    }
    this.target.az = az;
    this.target.el = el;
    this.target.lz = lz;

    const f = this.override?.snap ? 1000 : this.s.stiffness;
    this.az = this.azS.update(az, dt, f);
    this.el = this.elS.update(el, dt, f);
    this.zoom = Math.exp(this.zoomS.update(lz, dt, f));
    return this;
  }

  /**
   * Postavi kameru: orbita oko `target` na udaljenosti `baseDistance × zoom`.
   * @param {THREE.PerspectiveCamera} camera
   */
  apply(camera, target, baseDistance, vfovDeg, aspect, limits = {}, near = 1, far = 4000) {
    let el = this.el * DEG;
    const az = this.az * DEG;
    let dist = baseDistance * this.zoom;
    // Ograničenja prostora: kamera ne smije u pod/strop niti kroz zidove.
    if (limits.maxRadius) dist = Math.min(dist, limits.maxRadius / Math.max(0.2, Math.cos(el)));
    if (limits.minY !== undefined) {
      const minSin = (limits.minY - target.y) / dist;
      if (Math.sin(el) < minSin) el = Math.asin(Math.max(-1, Math.min(1, minSin)));
    }
    if (limits.maxY !== undefined) {
      const maxSin = (limits.maxY - target.y) / dist;
      if (Math.sin(el) > maxSin) el = Math.asin(Math.max(-1, Math.min(1, maxSin)));
    }
    this.effectiveEl = el / DEG;
    this.distance = dist;
    _dir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    camera.position.copy(target).addScaledVector(_dir, dist);
    camera.up.copy(UP);
    camera.lookAt(target);
    camera.fov = vfovDeg;
    camera.aspect = aspect;
    camera.near = near;
    camera.far = far;
    camera.clearViewOffset();
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  /**
   * Stereo: paralelne kamere pomaknute za ±pola IPD-a, s asimetričnim frustumom
   * tako da je nulta paralaksa točno na objektu (ugodno za oči, bez "toe-in").
   */
  applyStereo(mono, camL, camR, eyeHalf) {
    const d = Math.max(1, this.distance ?? 100);
    _right.set(1, 0, 0).applyQuaternion(mono.quaternion);
    for (const [cam, sign] of [[camL, -1], [camR, 1]]) {
      cam.position.copy(mono.position).addScaledVector(_right, sign * eyeHalf);
      cam.quaternion.copy(mono.quaternion);
      cam.fov = mono.fov;
      cam.aspect = mono.aspect;
      cam.near = mono.near;
      cam.far = mono.far;
      const top = mono.near * Math.tan((mono.fov * DEG) / 2);
      const halfW = top * mono.aspect;
      const shift = (-sign * eyeHalf * mono.near) / d;
      cam.projectionMatrix.makePerspective(-halfW + shift, halfW + shift, top, -top, mono.near, mono.far);
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
      cam.updateMatrixWorld(true);
    }
  }
}
