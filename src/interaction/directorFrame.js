// Redateljski okvir (sve scene): dvije ruke tvore pravokutnik (palci + kažiprsti)
// → na ekranu se pokaže tanko tražilo s kutnim oznakama, trećinama i omjerom
// slike. Kad se drži ~0,7 s, kadar se glatko "izreže" na taj dio scene (zoom i
// reframe kroz projekciju kamere) uz letterbox trake prema omjeru — lagani filmski
// osjećaj. Izrez je usidren na 3D točku u sredini okvira, pa glava i dalje
// upravlja kamerom, a uokvireni dio ostaje u kadru. Šaka ili ponovljeni široki
// okvir vraćaju normalni kadar. Novi okvir unutar izreza izrezuje dalje.

import * as THREE from 'three';

const HOLD_S = 0.7;
const RATIOS = [
  [1, '1 : 1'],
  [4 / 3, '4 : 3'],
  [3 / 2, '3 : 2'],
  [16 / 9, '16 : 9'],
  [1.85, '1.85 : 1'],
  [2, '2 : 1'],
  [2.39, '2.39 : 1'],
];
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}

/** Najbliži standardni omjer (u logaritamskom smislu). */
function snapRatio(r) {
  let best = RATIOS[0];
  for (const q of RATIOS) if (Math.abs(Math.log(q[0] / r)) < Math.abs(Math.log(best[0] / r))) best = q;
  return best;
}

export class DirectorFrame {
  constructor() {
    // --- Tražilo ---
    this.root = el('div', 'viewfinder');
    this.root.hidden = true;
    document.body.appendChild(this.root);
    this.box = el('div', 'viewfinder__box', this.root);
    for (const k of ['tl', 'tr', 'bl', 'br']) el('i', `viewfinder__corner viewfinder__corner--${k}`, this.box);
    for (const k of ['v1', 'v2', 'h1', 'h2']) el('i', `viewfinder__third viewfinder__third--${k}`, this.box);
    el('i', 'viewfinder__cross', this.box);
    this.label = el('span', 'viewfinder__label', this.box);
    this.hold = el('i', 'viewfinder__hold', this.box);
    // --- Letterbox ---
    // Letterbox odmah iza canvasa: preko slike, ali ispod HUD-a i panela.
    this.bars = [el('div', 'letterbox letterbox--a'), el('div', 'letterbox letterbox--b')];
    const canvas = document.getElementById('view');
    for (const b of this.bars.slice().reverse()) canvas.after(b);

    this.holdT = 0;
    this.latched = false; // nakon izreza okvir se mora pustiti prije sljedećeg
    this.lostAt = 0;
    // Trenutni izrez (cilj) i animirani izrez: središte u NDC osnovnog kadra, zoom.
    this.target = { cx: 0, cy: 0, z: 1, ax: 1, ay: 1, anchor: null, label: '' };
    this.cur = { cx: 0, cy: 0, lz: 0, ax: 1, ay: 1 };
    this.vel = { cx: 0, cy: 0, lz: 0, ax: 0, ay: 0 };
    this.anchorWorld = null;
    this.active = false;
  }

  /** Je li kadar izrezan (ili se animira)? */
  get cropped() {
    return this.active || Math.abs(this.cur.lz) > 1e-3;
  }

  reset(instant = false) {
    this.target = { cx: 0, cy: 0, z: 1, ax: 1, ay: 1, anchor: null, label: '' };
    this.anchorWorld = null;
    this.active = false;
    if (instant) {
      this.cur = { cx: 0, cy: 0, lz: 0, ax: 1, ay: 1 };
      this.vel = { cx: 0, cy: 0, lz: 0, ax: 0, ay: 0 };
    }
  }

  /**
   * @param {object} hand kontekst ruku (HandInput): frame { valid, rect (NDC zaslona) }, hands[]
   * @param {THREE.Camera} baseCamera kamera prije izreza (za sidro)
   * @param {number} focusDist udaljenost točke interesa od kamere (za sidro izreza)
   */
  update(now, dt, hand, baseCamera, focusDist) {
    const W = window.innerWidth, H = window.innerHeight;
    const screenAspect = W / H;
    const fr = hand?.frame;
    const valid = !!(fr && fr.valid && fr.rect);
    // Šaka vraća normalni kadar.
    if (this.active && hand?.hands?.some((v) => v.alive && v.gesture === 'fist')) this.reset();

    if (valid) {
      this.lostAt = now;
      const r = fr.rect;
      const wPx = ((r.x1 - r.x0) / 2) * W;
      const hPx = ((r.y1 - r.y0) / 2) * H;
      const [ratio, label] = snapRatio(wPx / Math.max(1, hPx));
      this.#drawFrame(r, W, H, label);
      if (!this.latched) {
        this.holdT += dt;
        if (this.holdT >= HOLD_S) {
          this.#commit(r, ratio, label, screenAspect, baseCamera, focusDist);
          this.latched = true;
          this.root.classList.add('is-commit');
        }
      }
      this.hold.style.transform = `scaleX(${Math.min(1, this.holdT / HOLD_S)})`;
    } else if (now - this.lostAt > 150) {
      this.holdT = 0;
      this.latched = false;
      this.root.hidden = true;
      this.root.classList.remove('is-commit');
    }

    this.#animate(dt, baseCamera);
    this.#drawBars(W, H, screenAspect);
  }

  #drawFrame(r, W, H, label) {
    const left = ((r.x0 + 1) / 2) * W;
    const right = ((r.x1 + 1) / 2) * W;
    const top = ((1 - r.y1) / 2) * H;
    const bottom = ((1 - r.y0) / 2) * H;
    this.root.hidden = false;
    const s = this.box.style;
    s.left = `${left}px`;
    s.top = `${top}px`;
    s.width = `${right - left}px`;
    s.height = `${bottom - top}px`;
    if (this.label.textContent !== label) this.label.textContent = label;
  }

  /** Okvir (NDC zaslona, možda unutar postojećeg izreza) → izrez osnovnog kadra. */
  #commit(r, ratio, label, screenAspect, baseCamera, focusDist) {
    // Širok okvir (preko ~3/4 ekrana) = povratak na normalni kadar.
    if (r.x1 - r.x0 > 1.5 && r.y1 - r.y0 > 1.15) {
      this.reset();
      return;
    }
    // Pretvori u NDC osnovnog kadra (ako je već izrezano: x_osn = c + x / z).
    const z0 = Math.exp(this.cur.lz);
    const toBase = (x, c) => c + x / z0;
    let x0 = toBase(r.x0, this.cur.cx), x1 = toBase(r.x1, this.cur.cx);
    let y0 = toBase(r.y0, this.cur.cy), y1 = toBase(r.y1, this.cur.cy);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    // Prilagodi pravokutnik standardnom omjeru (oko središta, zadrži površinu).
    let hw = (x1 - x0) / 2, hh = (y1 - y0) / 2;
    const area = hw * hh;
    hh = Math.sqrt(area / (ratio / screenAspect));
    hw = (hh * ratio) / screenAspect;
    // Letterbox: vidljivi dio zaslona ima omjer okvira.
    const ax = ratio >= screenAspect ? 1 : ratio / screenAspect;
    const ay = ratio >= screenAspect ? screenAspect / ratio : 1;
    const z = Math.min(8, ax / hw);
    this.target = { cx, cy, z, ax, ay, label };
    // Sidro: točka scene u sredini okvira (na dubini točke interesa).
    _v.set(cx, cy, 0.5).unproject(baseCamera);
    const camPos = new THREE.Vector3().setFromMatrixPosition(baseCamera.matrixWorld);
    this.anchorWorld = camPos.clone().add(_v.sub(camPos).normalize().multiplyScalar(focusDist));
    this.active = true;
  }

  #animate(dt, baseCamera) {
    const T = this.target;
    // Sidro prati osnovnu kameru (glava se miče): središte izreza = projekcija sidra.
    if (this.active && this.anchorWorld) {
      _v.copy(this.anchorWorld).project(baseCamera);
      T.cx = THREE.MathUtils.clamp(_v.x, -1, 1);
      T.cy = THREE.MathUtils.clamp(_v.y, -1, 1);
    }
    const goal = this.active ? { cx: T.cx, cy: T.cy, lz: Math.log(T.z), ax: T.ax, ay: T.ay } : { cx: 0, cy: 0, lz: 0, ax: 1, ay: 1 };
    // Filmski pokret: podprigušena opruga (blagi prebačaj zooma), ~1 s do kadra.
    const w = 2 * Math.PI * 0.95;
    const n = Math.max(1, Math.ceil(dt / 0.004));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      for (const k of ['cx', 'cy', 'lz', 'ax', 'ay']) {
        const acc = w * w * (goal[k] - this.cur[k]) - 2 * 0.82 * w * this.vel[k];
        this.vel[k] += acc * h;
        this.cur[k] += this.vel[k] * h;
      }
    }
  }

  #drawBars(W, H, screenAspect) {
    const { ax, ay } = this.cur;
    const [a, b] = this.bars;
    const vertical = ay < 0.999;
    const horizontal = ax < 0.999;
    const barH = Math.max(0, ((1 - Math.min(1, ay)) / 2) * H);
    const barW = Math.max(0, ((1 - Math.min(1, ax)) / 2) * W);
    a.style.cssText = vertical ? `display:block;top:0;left:0;right:0;height:${barH}px` : horizontal ? `display:block;top:0;bottom:0;left:0;width:${barW}px` : 'display:none';
    b.style.cssText = vertical ? `display:block;bottom:0;left:0;right:0;height:${barH}px` : horizontal ? `display:block;top:0;bottom:0;right:0;width:${barW}px` : 'display:none';
  }

  /** Izrez u projekciju kamere: NDC x' = (x − cx)·z (isto za y), uz letterbox. */
  apply(camera) {
    const c = this.cur;
    if (Math.abs(c.lz) < 1e-4 && Math.abs(c.cx) < 1e-4 && Math.abs(c.cy) < 1e-4) return;
    const z = Math.exp(c.lz);
    _m.set(z, 0, 0, -c.cx * z, 0, z, 0, -c.cy * z, 0, 0, 1, 0, 0, 0, 0, 1);
    camera.projectionMatrix.premultiply(_m);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }

  /** NDC zaslona → NDC osnovnog kadra (za zrake ruku iz izrezanog pogleda). */
  get zoom() {
    return Math.exp(this.cur.lz);
  }
}
