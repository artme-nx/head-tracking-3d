// Ruka u 3D prostoru scene.
// Položaj ruke u kadru kamere (već pretvoren u NDC ekrana) postaje zraka iz
// trenutne render kamere — pa točka radi jednako u WINDOW i ORBIT načinu, i u
// izrezanom (redateljskom) kadru. Dubina duž zrake dolazi iz relativne dubine
// ruke (udaljenost ruke / udaljenost glave, iz veličine dlana) u odnosu na
// neutralnu: ruka u neutralnom položaju drži točku ispred objekta, primicanje
// ekranu gura je prema objektu (meka zasićenja na oba kraja).
// Podaci s kamere stižu ~30 puta u sekundi; ovdje se glatko interpoliraju
// (kritično prigušena opruga) da se točka miče tečno na 60 fps.

import * as THREE from 'three';

export const NEUTRAL_LOG_R = Math.log(0.62); // ruka na ~62 % udaljenosti glave
const U_REACH = 0.7; // ln(0.62 / 0.31): ruka na ~31 % udaljenosti glave = puni doseg
const PRIORITY = { pinch: 4, point: 3, open: 2, fist: 1, none: 0 };
// Imena svjetskih točaka (v.pinch je jačina pincha 0..1, a točka je v.pinchPoint).
const WORLD = { tip: 'tip', pinch: 'pinchPoint', palm: 'palm' };

/** Kritično prigušena opruga za skalare (točno rješenje, stabilno pri svakom dt). */
function springTo(state, key, target, dt, freq) {
  const w = 2 * Math.PI * freq;
  const x = state[key];
  const v = state[key + 'V'] ?? 0;
  const e = x - target;
  const k = Math.exp(-w * dt);
  const tmp = (v + w * e) * dt;
  state[key] = target + (e + tmp) * k;
  state[key + 'V'] = (v - w * tmp) * k;
}

const _p = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _target = new THREE.Vector3();

export class HandInput {
  constructor() {
    this.views = new Map();
    this.primaryId = null;
    this.ctx = {
      active: false,
      source: null,
      primary: null,
      hands: [],
      events: [],
      frame: { valid: false, rect: null, since: 0 },
    };
  }

  /** Udaljenost duž zrake za relativnu dubinu ln(r). */
  static depthAlongRay(logR, D, reach) {
    const u = NEUTRAL_LOG_R - logR; // > 0: ruka bliže ekranu od neutralne
    const near = Math.min(reach.near, D - reach.minCam);
    let dist;
    let g;
    if (u >= 0) {
      const x = u / U_REACH;
      g = x < 0.85 ? x : 0.85 + 0.15 * Math.tanh((x - 0.85) / 0.15);
      dist = near + (reach.far - near) * g;
    } else {
      g = -Math.tanh(-u / 0.35);
      dist = near + (D - near - reach.minCam) * -g;
    }
    return { t: Math.max(reach.minCam, D - dist), reach: g };
  }

  /**
   * @param {object} o
   * @param {import('../tracking/handTracker.js').HandTracker} o.tracker
   * @param {import('../tracking/mouseHand.js').MouseHand} o.mouse
   * @param {THREE.Camera} o.camera trenutna (mono) render kamera
   * @param {{target:THREE.Vector3, near:number, far:number, minCam:number}} o.reach doseg scene (world, cm)
   * @param {object|null} o.override test: { tip:[x,y], logR, gesture, spread, pinch }
   */
  update(now, dt, { tracker, mouse, camera, reach, override = null, mouseEvents = [] }) {
    const ctx = this.ctx;
    ctx.events = [];
    let tracks;
    let frame;
    if (override) {
      tracks = override.track ? [override.track] : [];
      frame = override.frame ?? { valid: false };
      ctx.source = 'test';
      ctx.events.push(...(override.events ?? []));
      override.events = [];
    } else if (mouse.active || mouse.frame.valid || mouseEvents.length) {
      tracks = mouse.active ? [mouse.track] : [];
      frame = mouse.frame;
      ctx.source = 'miš';
      ctx.events.push(...mouseEvents);
    } else {
      tracks = tracker.tracks.filter((t) => t.features);
      frame = tracker.frame;
      ctx.source = tracks.length ? 'kamera' : null;
      ctx.events.push(...tracker.events);
    }

    camera.updateMatrixWorld();
    _cam.setFromMatrixPosition(camera.matrixWorld);
    _target.copy(reach.target);
    const D = Math.max(reach.minCam + 1, _cam.distanceTo(_target));

    // Pogledi (glatko interpolirani) za svaku vidljivu ruku.
    const seen = new Set();
    for (const tr of tracks) {
      seen.add(tr.id);
      let v = this.views.get(tr.id);
      if (!v) {
        v = this.#createView(tr);
        this.views.set(tr.id, v);
      }
      v.alive = true;
      v.gesture = tr.gesture;
      v.gestureSince = tr.gestureSince ?? tr.gestures?.since ?? now;
      v.spread = tr.spread;
      v.pinch = tr.pinch;
      v.label = tr.label;
      v.simulated = !!tr.simulated;
      v.distanceCm = tr.distanceCm;
      v.track = tr;
      const freq = tr.simulated ? 22 : 13;
      for (const name of ['tip', 'pinch', 'palm']) {
        const s = v.s[name];
        const p = tr.pts[name];
        if (v.fresh) {
          s.x = p[0];
          s.y = p[1];
          s.d = p[2];
        } else {
          springTo(s, 'x', p[0], dt, freq);
          springTo(s, 'y', p[1], dt, freq);
          springTo(s, 'd', p[2], dt, freq * 0.8);
        }
      }
      v.fresh = false;
      v.presence = Math.min(1, v.presence + dt / 0.12);
    }
    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      // Ruka nestala: gesta prestaje odmah, marker se gasi postupno.
      v.alive = false;
      v.gesture = 'none';
      v.presence = Math.max(0, v.presence - dt / 0.2);
      if (v.presence <= 0) this.views.delete(id);
    }

    // Svjetske točke duž zraka iz kamere.
    const hands = [];
    for (const v of this.views.values()) {
      for (const name of ['tip', 'pinch', 'palm']) {
        const s = v.s[name];
        _p.set(THREE.MathUtils.clamp(s.x, -1.6, 1.6), THREE.MathUtils.clamp(s.y, -1.6, 1.6), 0.5).unproject(camera);
        const dir = v.dirs[name].subVectors(_p, _cam).normalize();
        const { t, reach: g } = HandInput.depthAlongRay(s.d, D, reach);
        v[WORLD[name]].copy(_cam).addScaledVector(dir, t);
        if (name === 'tip') {
          v.reach = g;
          v.depth = t;
          v.ndc.set(s.x, s.y);
          v.logR = s.d;
        }
      }
      v.camPos.copy(_cam);
      v.gestureAge = (now - v.gestureSince) / 1000;
      hands.push(v);
    }

    // Dok dvije ruke tvore redateljski okvir, pojedinačne geste (kažiprst…) se ne tumače.
    if (frame?.valid) for (const v of hands) if (v.alive) v.gesture = 'frame';

    // Primarna ruka: najvažnija gesta; pri jednakoj prednost ima dosadašnja.
    let primary = null;
    for (const v of hands) {
      if (!v.alive) continue;
      const p = PRIORITY[v.gesture] ?? 0;
      const cur = primary ? PRIORITY[primary.gesture] ?? 0 : -1;
      if (p > cur || (p === cur && v.id === this.primaryId)) primary = v;
    }
    this.primaryId = primary?.id ?? null;

    for (const e of ctx.events) {
      if (e.type !== 'tap') continue;
      _p.set(e.ndc[0], e.ndc[1], 0.5).unproject(camera);
      e.origin = _cam.clone();
      e.dir = _p.clone().sub(_cam).normalize();
    }

    ctx.active = hands.some((h) => h.alive);
    ctx.hands = hands;
    ctx.primary = primary;
    ctx.frame = frame;
    ctx.camPos = _cam;
    return ctx;
  }

  #createView(tr) {
    const mk = () => ({ x: 0, y: 0, d: 0 });
    return {
      id: tr.id,
      label: tr.label,
      fresh: true,
      alive: true,
      presence: 0,
      gesture: 'none',
      gestureSince: 0,
      gestureAge: 0,
      spread: 0,
      pinch: 0,
      reach: 0,
      depth: 0,
      logR: NEUTRAL_LOG_R,
      ndc: new THREE.Vector2(),
      s: { tip: mk(), pinch: mk(), palm: mk() },
      dirs: { tip: new THREE.Vector3(), pinch: new THREE.Vector3(), palm: new THREE.Vector3() },
      tip: new THREE.Vector3(),
      pinchPoint: new THREE.Vector3(),
      palm: new THREE.Vector3(),
      camPos: new THREE.Vector3(),
    };
  }
}
