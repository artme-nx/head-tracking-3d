// Rastavljanje (exploded view) kao premium tehnički prikaz proizvoda.
// Globalni napredak p (0..1) prati zadanu količinu kroz kritično prigušenu oprugu.
// Svaki dio ima svoj prozor [a, b] unutar p: vanjski dijelovi kreću prvi, unutarnji
// zadnji — a pri sklapanju obrnuto (unutarnji se vrate prvi), pa se dijelovi nikad
// ne prožimaju. Dio svoj cilj prati kroz blago podprigušenu oprugu (mali prebačaj
// prema van); pri povratku na mjesto ne smije proći kroz ležište: udari u njega,
// malo odskoči i "klikne" (događaj za bljesak spoja i servo trzaj).

import * as THREE from 'three';

const ease = (t) => t * t * (3 - 2 * t);
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class ExplodeController {
  constructor() {
    this.parts = [];
    this.target = 0;
    this.p = 0;
    this.pv = 0;
    this.seats = []; // dijelovi koji su u ovom frameu sjeli na mjesto [{ part, speed }]
  }

  /**
   * @param {object} o
   * @param {THREE.Object3D} [o.obj] objekt koji se pomiče (pozicija = osnovna + putanja)
   * @param {[number, number]} o.window prozor unutar globalnog napretka
   * @param {THREE.Vector3} [o.to] krajnji pomak (lokalne jedinice roditelja)
   * @param {THREE.Vector3} [o.via] kontrolna točka kvadratne Bézierove putanje (početni smjer izvlačenja)
   * @param {(s:number)=>void} [o.apply] vlastita primjena (oko, kabeli…) umjesto putanje
   * @param {{axis:THREE.Vector3, angle:number, pivot:THREE.Vector3, start?:number}} [o.spin]
   *        zakret oko šarke (npr. vizir), počinje kad dio prijeđe udio "start" putanje
   * @param {number} [o.freq] Hz opruge dijela
   */
  add({ obj = null, window, to = null, via = null, apply = null, spin = null, freq = 2.3, damping = 0.62, name = '' }) {
    const part = {
      name,
      obj,
      window,
      to,
      via: via ?? (to ? to.clone().multiplyScalar(0.5) : null),
      apply,
      spin,
      freq: freq * (0.94 + 0.12 * ((this.parts.length * 0.618) % 1)),
      damping,
      base: obj ? obj.position.clone() : null,
      s: 0,
      v: 0,
    };
    this.parts.push(part);
    return part;
  }

  /** Najveći trenutni pomak bilo kojeg dijela (0 = sve sjedi na mjestu). */
  get amount() {
    let m = 0;
    for (const p of this.parts) m = Math.max(m, p.s);
    return m;
  }

  /** Je li sve sklopljeno i mirno? */
  get settled() {
    return this.p < 1e-3 && Math.abs(this.pv) < 1e-3 && this.parts.every((p) => p.s <= 1e-4 && Math.abs(p.v) < 1e-3);
  }

  update(dt) {
    this.seats.length = 0;
    // Globalni napredak: kritično prigušena opruga (točno rješenje).
    const w = 2 * Math.PI * 1.0;
    const e = this.p - this.target;
    const k = Math.exp(-w * dt);
    const tmp = (this.pv + w * e) * dt;
    this.p = this.target + (e + tmp) * k;
    this.pv = (this.pv - w * tmp) * k;

    for (const part of this.parts) {
      const [a, b] = part.window;
      const goal = ease(THREE.MathUtils.clamp((this.p - a) / (b - a), 0, 1));
      // Opruga dijela (polu-implicitni Euler u malim koracima).
      const ww = 2 * Math.PI * part.freq;
      const steps = Math.max(1, Math.ceil(dt / 0.004));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        const acc = ww * ww * (goal - part.s) - 2 * part.damping * ww * part.v;
        part.v += acc * h;
        part.s += part.v * h;
        if (part.s < 0) {
          // Dio je udario u svoje ležište: zaustavi ga uz mali odskok ("klik").
          if (part.v < -0.35) this.seats.push({ part, speed: -part.v });
          part.s = 0;
          part.v = part.v < -0.35 ? -part.v * 0.18 : 0;
        }
      }
      this.#apply(part);
    }
  }

  #apply(part) {
    const s = part.s;
    if (part.apply) part.apply(s);
    if (!part.obj || !part.to) return;
    // Kvadratni Bézier 0 → via → to: početni smjer izvlačenja zadaje "via".
    const u = 1 - s;
    _v.copy(part.via).multiplyScalar(2 * u * s).addScaledVector(part.to, s * s);
    if (part.spin) {
      // Zakret oko šarke: pozicija = šarka + R·(osnova − šarka), uz pomak putanje.
      const { axis, angle, pivot, start = 0 } = part.spin;
      const k = s <= start ? 0 : ease(Math.min(1, (s - start) / (1 - start))) + Math.max(0, s - 1);
      _q.setFromAxisAngle(axis, angle * k);
      part.obj.quaternion.copy(_q);
      _p.copy(part.base).sub(pivot).applyQuaternion(_q).add(pivot);
      part.obj.position.copy(_p).add(_v);
    } else {
      part.obj.position.copy(part.base).add(_v);
    }
  }
}
