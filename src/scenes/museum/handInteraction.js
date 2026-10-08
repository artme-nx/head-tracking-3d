// Ruke u muzejskoj vitrini:
//   · kažiprst = svjetiljka: topli točkasti izvor na vrhu prsta (spot uperen u
//     skulpturu, s mekim sjenama), glavni reflektor se lagano priguši; odsjaji klize
//     po kromu, sjene po postolju, kaustike kristala idu na suprotnu stranu;
//   · pinch blizu skulpture = uhvati kristalnu jezgru: rešetka se razdvoji na dvije
//     polovice (skulptura se okrene da procjep gleda prema gledatelju), jezgra izlazi
//     kroz procjep i prati ruku — može i ispred stakla; pusti → elastično natrag;
//   · brzi tap prema ekranu = kucanje po staklu: val se širi od točke udarca,
//     prašina u snopu se uskovitla, skulptura se minimalno zanjiše.
// Sve koordinate su u prostoru `display` grupe scene (cm, prije skaliranja).

import * as THREE from 'three';

const ease = (t) => t * t * (3 - 2 * t);
const WARM = new THREE.Color('#ffcd98'); // ~3000 K
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** Kritično/podprigušena opruga za Vector3 (polu-implicitno, s podkoracima). */
function spring3(x, v, target, dt, freq, damping) {
  const w = 2 * Math.PI * freq;
  const n = Math.max(1, Math.ceil(dt / 0.004));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    _a.subVectors(target, x).multiplyScalar(w * w).addScaledVector(v, -2 * damping * w);
    v.addScaledVector(_a, h);
    x.addScaledVector(v, h);
  }
}

function bulbGlowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color() } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
        mv.xy += position.xy * vec2( length( modelMatrix[ 0 ].xyz ), length( modelMatrix[ 1 ].xyz ) );
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      varying vec2 vUv;
      void main() {
        float r = length( vUv - 0.5 ) * 2.0;
        float g = exp( -r * r * 22.0 ) * 1.2 + exp( -r * r * 5.0 ) * 0.25;
        gl_FragColor = vec4( color * g, 1.0 );
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}

export class MuseumHands {
  /**
   * @param {import('./museumScene.js').MuseumScene} scene
   * @param {object} o
   */
  constructor(scene, { L, CANDELA }) {
    this.s = scene;
    this.L = L;
    this.CANDELA = CANDELA;
    const d = scene.display;
    const c = scene.sphereCenter;
    this.center = c.clone();

    // --- Svjetiljka na prstu ---
    this.light = new THREE.SpotLight(WARM, 0, 0, 0.62, 0.85, 2);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(1024, 1024);
    this.light.shadow.camera.near = 1.2;
    this.light.shadow.camera.far = 320;
    this.light.shadow.camera.updateProjectionMatrix();
    this.light.shadow.radius = -2.6; // fiksni meki PCF (vidi pcss.js)
    this.light.shadow.bias = -0.0006;
    this.light.shadow.normalBias = 0.03;
    this.light.shadow.intensity = 0;
    this.light.shadow.autoUpdate = false;
    this.light.target.position.copy(c);
    d.add(this.light, this.light.target);
    // Vidljivi izvor: sitna užarena jezgra i mekani sjaj.
    this.bulbMat = new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
    this.bulb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 12), this.bulbMat);
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bulbGlowMaterial());
    this.glow.scale.setScalar(2.2);
    this.glow.renderOrder = 6;
    for (const m of [this.bulb, this.glow]) {
      m.visible = false;
      m.frustumCulled = false;
      d.add(m);
    }
    this.lightAmt = 0;
    this.lightPos = c.clone().add(new THREE.Vector3(0, 6, 30));

    // --- Jezgra ---
    this.crystalLight = new THREE.PointLight('#fff1dc', 0, 70, 2);
    scene.coreGroup.add(this.crystalLight);
    this.core = new THREE.Vector3(); // pomak jezgre (prostor display, od središta)
    this.coreV = new THREE.Vector3();
    this.coreTarget = new THREE.Vector3();
    this.held = false;
    this.heldAmt = 0;
    this.open = 0; // razmak polovica rešetke (cm, svaka polovica)
    this.openV = 0;
    this.grabFrom = new THREE.Vector3();
    this.prevGesture = 'none';
    this.alignAngle = null;
    this.prevCoreWorld = null;

    this._ax = new THREE.Vector3();
    this._cam = new THREE.Vector3();
    this._toCam = new THREE.Vector3();

    // --- Kucanje ---
    this.waveSlot = 0;
    this.wobble = new THREE.Vector2();
    this.wobbleV = new THREE.Vector2();
  }

  get bloomObjects() {
    return [this.bulb, this.glow];
  }

  /**
   * @param {object} hand kontekst ruku (HandInput)
   * @param {THREE.Vector3|null} camPos položaj kamere (world)
   */
  update(dt, T, hand, camPos) {
    const S = this.s;
    const d = S.display;
    d.updateMatrixWorld();
    const alive = hand?.hands?.filter((v) => v.alive) ?? [];
    const pointer = alive.find((v) => v.gesture === 'point');
    const pincher = alive.find((v) => v.gesture === 'pinch');
    const scale = S.displayScale ?? 1;

    this.#flashlight(dt, pointer, scale);
    this.#grab(dt, T, pincher, camPos);
    for (const e of hand?.events ?? []) if (e.type === 'tap') this.#tap(e);
    this.#waves(dt);

    // Njihanje skulpture nakon udarca (prigušena opruga, ~2 Hz).
    const w = 2 * Math.PI * 2.1;
    for (const k of ['x', 'y']) {
      this.wobbleV[k] += (-w * w * this.wobble[k] - 2 * 0.22 * w * this.wobbleV[k]) * Math.min(dt, 0.02);
      this.wobble[k] += this.wobbleV[k] * Math.min(dt, 0.02);
    }
  }

  // ------------------------------------------------------------------ svjetiljka
  #flashlight(dt, pointer, scale) {
    const S = this.s;
    const goal = pointer ? 1 : 0;
    this.lightAmt += (goal - this.lightAmt) * (1 - Math.exp(-dt * (goal ? 9 : 2.4)));
    if (pointer) S.display.worldToLocal(this.lightPos.copy(pointer.tip));
    const a = ease(Math.min(1, this.lightAmt));
    const on = a > 0.003;
    const L = this.light;
    L.position.copy(this.lightPos);
    L.intensity = 1.5 * this.CANDELA * scale * scale * a;
    L.shadow.intensity = a;
    L.shadow.autoUpdate = on;
    for (const m of [this.bulb, this.glow]) {
      m.visible = on;
      m.position.copy(this.lightPos);
    }
    this.bulbMat.color.copy(WARM).multiplyScalar(3.2 * a);
    this.glow.material.uniforms.color.value.copy(WARM).multiplyScalar(0.55 * a);
    // Prašina u blizini svjetiljke zatreperi.
    S.dust.setPointLight(S.display.localToWorld(_v.copy(this.lightPos)), WARM, 260 * scale * scale * a);
    this.amount = a;
  }

  /** Smjer i jačina kaustika: svjetlo koje kroz kristal pada na postolje. */
  causticAim(defaultTarget, outTarget) {
    const a = this.amount ?? 0;
    const crystal = _w.copy(this.center).add(this.core);
    outTarget.copy(defaultTarget);
    let boost = 0;
    if (a > 0.003) {
      // Zraka svjetiljka → kristal, nastavljena do dna vitrine (ili stražnjeg stakla).
      const dir = _a.subVectors(crystal, this.lightPos).normalize();
      const deckY = this.s.deckY + 0.3;
      let p;
      if (dir.y < -0.12) {
        const t = (deckY - crystal.y) / dir.y;
        p = _b.copy(crystal).addScaledVector(dir, t);
      } else {
        p = _b.copy(crystal).addScaledVector(dir, 10);
        p.y = deckY;
      }
      const g = this.L.glass;
      p.x = THREE.MathUtils.clamp(p.x, -g.w / 2 + 1.2, g.w / 2 - 1.2);
      p.z = THREE.MathUtils.clamp(p.z, this.L.centerZ - g.d / 2 + 1.2, this.L.centerZ + g.d / 2 - 1.2);
      outTarget.lerp(p, a);
      const dist = Math.max(6, this.lightPos.distanceTo(crystal));
      boost = a * Math.min(2.2, 900 / (dist * dist));
    }
    // Izvađena jezgra više nije u snopu reflektora: kaustike blijede.
    const out = 1 - THREE.MathUtils.smoothstep(this.core.length(), 4, 16);
    return { position: crystal, factor: (1 - 0.45 * a) * out + boost };
  }

  // ------------------------------------------------------------------ jezgra
  #grab(dt, T, pincher, camPos) {
    const S = this.s;
    const gesture = pincher ? 'pinch' : 'none';
    const pinchLocal = pincher ? S.display.worldToLocal(_v.copy(pincher.pinchPoint)) : null;
    // Hvat: tek u trenutku pincha, i samo blizu skulpture (ne može se "doći" zatvorene ruke).
    if (pincher && this.prevGesture !== 'pinch' && !this.held) {
      if (pinchLocal.distanceTo(this.center) < 21) {
        this.held = true;
        this.grabFrom.copy(pinchLocal).sub(this.core);
        // Procjep (ravnina x = 0 skulpture) okreće se prema kameri.
        const cam = camPos ? S.display.worldToLocal(_w.copy(camPos)) : _w.set(0, 0, 100);
        const toCam = _a.subVectors(cam, this.center);
        const base = Math.atan2(toCam.x, toCam.z);
        let best = base;
        for (const k of [-2, -1, 0, 1, 2]) {
          const cand = base + k * Math.PI;
          if (Math.abs(cand - S.spin) < Math.abs(best - S.spin)) best = cand;
        }
        this.alignAngle = best;
      }
    }
    if (!pincher && this.held) this.held = false;
    this.prevGesture = gesture;

    // Polovice rešetke: otvorene dok je jezgra vani ili u ruci, zatvore se tek kad se smiri.
    const needOpen = this.held || this.core.length() > 0.35 || this.coreV.length() > 2;
    const openGoal = needOpen ? 3.4 : 0;
    const ow = 2 * Math.PI * 2.4;
    const n = Math.max(1, Math.ceil(dt / 0.004));
    for (let i = 0; i < n; i++) {
      const h = dt / n;
      this.openV += (ow * ow * (openGoal - this.open) - 2 * 0.75 * ow * this.openV) * h;
      this.open += this.openV * h;
      if (this.open < 0) {
        // Polovice se spoje: tihi "klik" (bez odskoka ispod nule).
        if (this.openV < -2) S.onLatticeClose?.();
        this.open = 0;
        this.openV = 0;
      }
    }

    // Cilj jezgre: dok je u ruci prati pomak prsta (povlačenje prema sebi je izvlači).
    if (this.held && pinchLocal) {
      this.coreTarget.subVectors(pinchLocal, this.grabFrom).multiplyScalar(1.25);
    } else {
      this.coreTarget.set(0, 0, 0);
    }
    this.#constrain(this.coreTarget, camPos);
    // U ruci: mekano praćenje. Povratak: izdaleka kritično prigušeno (bez prebačaja
    // kroz rešetku), a pri nasjedanju blago podprigušeno — mali elastični prebačaj.
    const dist = this.core.length();
    const damping = this.held ? 0.72 : THREE.MathUtils.lerp(0.42, 1.0, THREE.MathUtils.smoothstep(dist, 1.2, 5));
    spring3(this.core, this.coreV, this.coreTarget, dt, this.held ? 2.2 : 1.5, damping);
    this.#constrain(this.core, camPos, this.coreV);

    // Poravnanje skulpture (procjep prema gledatelju) dok traje izvlačenje.
    const busy = this.held || this.core.length() > 0.2 || this.open > 0.05;
    if (busy && this.alignAngle !== null) {
      S.spin += (this.alignAngle - S.spin) * (1 - Math.exp(-dt * 5));
    } else {
      this.alignAngle = null;
    }
    this.heldAmt += ((busy ? 1 : 0) - this.heldAmt) * (1 - Math.exp(-dt * (busy ? 6 : 1.8)));

    // Prolazak kroz staklo: val na mjestu prolaska.
    const coreWorld = S.display.localToWorld(_w.copy(this.center).add(this.core));
    if (this.prevCoreWorld) this.#glassCrossing(this.prevCoreWorld, coreWorld);
    this.prevCoreWorld = (this.prevCoreWorld ?? new THREE.Vector3()).copy(coreWorld);
  }

  /** Jezgra ne smije kroz šipke: unutar rešetke samo kroz procjep, iznad dna vitrine. */
  #constrain(p, camPos, vel = null) {
    const S = this.s;
    const r = this.L.sphere.r;
    const crystalR = 2.65;
    // Smjer lokalne osi x skulpture (okomito na procjep) u prostoru display.
    const ax = this._ax.set(Math.cos(S.spin), 0, -Math.sin(S.spin));
    const along = p.dot(ax);
    const dist = p.length();
    const inside = dist < r + crystalR + 0.4;
    if (inside) {
      const room = Math.max(0, this.open - crystalR - 0.15);
      if (Math.abs(along) > room) {
        p.addScaledVector(ax, Math.sign(along) * room - along);
        if (vel) vel.addScaledVector(ax, -vel.dot(ax));
      }
      // Dok se polovice još ne razmaknu, jezgra ostaje u šupljini.
      const cavity = 4.9 - 3.1;
      if (this.open < crystalR + 0.3 && p.length() > cavity) p.setLength(cavity);
    }
    // Dno vitrine i udaljenost od kamere.
    const floorY = S.deckY + 0.3 + 3.2 - this.center.y;
    if (p.y < floorY) {
      p.y = floorY;
      if (vel && vel.y < 0) vel.y = 0;
    }
    if (!camPos) return;
    const cam = S.display.worldToLocal(this._cam.copy(camPos));
    const toCam = this._toCam.copy(this.center).add(p).sub(cam);
    const minD = 16;
    if (toCam.length() < minD) {
      toCam.setLength(minD);
      p.copy(cam).add(toCam).sub(this.center);
    }
  }

  /** Okviri stakala (prostor display) za udarce i prolaske. */
  #panes() {
    const g = this.L.glass;
    const y0 = this.L.monolith.top + this.L.base.h;
    const cz = this.L.centerZ;
    return { x0: -g.w / 2, x1: g.w / 2, y0, y1: y0 + g.h + g.t, z0: cz - g.d / 2, z1: cz + g.d / 2 };
  }

  #glassCrossing(aWorld, bWorld) {
    const S = this.s;
    const A = S.display.worldToLocal(_a.copy(aWorld));
    const B = S.display.worldToLocal(_b.copy(bWorld));
    const P = this.#panes();
    const planes = [
      ['z', P.z1], ['z', P.z0], ['x', P.x0], ['x', P.x1], ['y', P.y1],
    ];
    for (const [axis, v] of planes) {
      const da = A[axis] - v, db = B[axis] - v;
      if (da * db >= 0) continue;
      const t = da / (da - db);
      const hit = new THREE.Vector3().lerpVectors(A, B, t);
      const ok = (k, lo, hi) => axis === k || (hit[k] >= lo - 0.5 && hit[k] <= hi + 0.5);
      if (ok('x', P.x0, P.x1) && ok('y', P.y0, P.y1) && ok('z', P.z0, P.z1)) this.#wave(hit, 0.65);
    }
  }

  // ------------------------------------------------------------------ kucanje
  #tap(e) {
    const S = this.s;
    const o = S.display.worldToLocal(_a.copy(e.origin));
    const far = S.display.worldToLocal(_b.copy(e.origin).addScaledVector(e.dir, 400));
    const dir = far.sub(o).normalize();
    const P = this.#panes();
    // Ulazak zrake u kutiju vitrine (slab metoda); promašaj → najbliža točka prednjeg stakla.
    let t0 = -Infinity, t1 = Infinity;
    for (const [k, lo, hi] of [['x', P.x0, P.x1], ['y', P.y0, P.y1], ['z', P.z0, P.z1]]) {
      if (Math.abs(dir[k]) < 1e-6) {
        if (o[k] < lo || o[k] > hi) t0 = Infinity;
        continue;
      }
      let a = (lo - o[k]) / dir[k], b = (hi - o[k]) / dir[k];
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
    }
    let hit;
    if (t0 <= t1 && t1 > 0 && Number.isFinite(t0)) {
      hit = o.clone().addScaledVector(dir, Math.max(0, t0));
    } else {
      const t = Math.abs(dir.z) > 1e-6 ? (P.z1 - o.z) / dir.z : 0;
      hit = o.clone().addScaledVector(dir, Math.max(0, t));
      hit.x = THREE.MathUtils.clamp(hit.x, P.x0 + 1, P.x1 - 1);
      hit.y = THREE.MathUtils.clamp(hit.y, P.y0 + 1, P.y1 - 1);
      hit.z = P.z1;
    }
    this.#wave(hit, 1);
    S.dust.swirl(hit, 1);
    // Skulptura se minimalno zanjiše (od točke udarca).
    const away = _v.subVectors(this.center, hit).setY(0).normalize();
    this.wobbleV.x += away.z * 0.07;
    this.wobbleV.y += -away.x * 0.07;
    this.lastTap = hit;
  }

  #wave(localPoint, amp) {
    const S = this.s;
    const u = S.glassWaves;
    const i = this.waveSlot;
    this.waveSlot = (i + 1) % 3;
    const w = S.display.localToWorld(localPoint.clone());
    u.glassWaves.value[i].set(w.x, w.y, w.z, 0);
    u.glassWaveAmp.value[i] = amp;
    // Normala pogođenog stakla: najbliža stranica kutije vitrine.
    const P = this.#panes();
    const faces = [
      [Math.abs(localPoint.z - P.z1), 0, 0, 1],
      [Math.abs(localPoint.z - P.z0), 0, 0, -1],
      [Math.abs(localPoint.x - P.x0), -1, 0, 0],
      [Math.abs(localPoint.x - P.x1), 1, 0, 0],
      [Math.abs(localPoint.y - P.y1), 0, 1, 0],
    ].sort((a, b) => a[0] - b[0]);
    (this.waveNormals ??= [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()])[i].set(faces[0][1], faces[0][2], faces[0][3]);
  }

  #waves(dt) {
    const S = this.s;
    const u = S.glassWaves;
    let active = false;
    for (let i = 0; i < 3; i++) {
      const v = u.glassWaves.value[i];
      if (v.w >= 0) v.w = v.w > 2.0 ? -1 : v.w + dt;
      if (v.w >= 0) active = true;
    }
    // Zaslonsko titranje stakla (post prolaz) samo dok neki val traje.
    const pass = S.post?.ripple;
    if (!pass) return;
    pass.enabled = active;
    if (!active) return;
    const r = pass.material.uniforms;
    const P = this.#panes();
    S.display.localToWorld(r.boxMin.value.set(P.x0, P.y0, P.z0));
    S.display.localToWorld(r.boxMax.value.set(P.x1, P.y1, P.z1));
    for (let i = 0; i < 3; i++) {
      r.waves.value[i].copy(u.glassWaves.value[i]);
      r.amps.value[i] = u.glassWaveAmp.value[i];
      if (this.waveNormals) r.normals.value[i].copy(this.waveNormals[i]);
    }
  }
}
