// Mehaničko oko robota — slojevi prave geometrije (od straga prema naprijed):
//   duplja (statična čaša s vijcima) → kućište očne jabučice → objektiv s oznakama
//   → unutarnji emisivni prstenovi na različitim dubinama → užarena jezgra
//   → iris-blenda od lamela (kao objektiv kamere) → staklena rožnica (odsjaji,
//   AR prevlaka) → mehanički kapci. Pravo točkasto svjetlo osvjetljava duplju i lice.
// Lokalni koordinatni sustav: ishodište u središtu očne jabučice, optička os +z.

import * as THREE from 'three';

const BLADES = 11;

function bladeShape(innerR, outerR) {
  // Zakrivljena lamela: unutarnji rub je luk velikog radijusa (tangentan na otvor),
  // vanjski rub prati kućište.
  const s = new THREE.Shape();
  const len = outerR * 1.35;
  s.moveTo(-len, 0);
  s.quadraticCurveTo(0, -0.06, len, 0);
  s.lineTo(len * 0.9, outerR * 0.9);
  s.quadraticCurveTo(0, outerR * 1.25, -len * 0.75, outerR * 0.75);
  s.lineTo(-len, 0);
  return s;
}

export class EyeUnit {
  /**
   * @param {object} o
   * @param {object} o.materials zajednički materijali (graphite, anodized, chrome, ceramic, lens, blade)
   * @param {THREE.Texture} o.ringText tekstura oznaka na prstenu objektiva
   */
  constructor({ materials, ringText, side = 1 }) {
    this.side = side;
    this.root = new THREE.Group(); // statični dio (u duplji glave)
    this.gimbal = new THREE.Group(); // rotira prema cilju pogleda
    this.root.add(this.gimbal);

    const M = materials;
    this.color = new THREE.Color('#7fe9ff');
    this.intensity = 1;

    // --- Duplja: čaša s koracima i vijcima (statična) ---
    const cupProfile = [
      new THREE.Vector2(1.5, -1.9),
      new THREE.Vector2(1.72, -1.6),
      new THREE.Vector2(1.72, -0.55),
      new THREE.Vector2(1.84, -0.4),
      new THREE.Vector2(1.84, 0.55),
      new THREE.Vector2(1.98, 0.8),
      new THREE.Vector2(2.05, 1.25),
    ];
    const cup = new THREE.Mesh(new THREE.LatheGeometry(cupProfile, 64).rotateX(Math.PI / 2), M.socket);
    cup.receiveShadow = true;
    this.root.add(cup);
    // Prsten vijaka na ulazu u duplju.
    const screwGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.06, 6).rotateX(Math.PI / 2);
    const screws = new THREE.InstancedMesh(screwGeo, M.chrome, 6);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.26;
      m4.makeTranslation(Math.cos(a) * 1.76, Math.sin(a) * 1.76, 0.5);
      screws.setMatrixAt(i, m4);
    }
    this.root.add(screws);

    // --- Kućište očne jabučice (rotira) ---
    // Kugla s prednjim otvorom oko optičke osi (inače bi zaklonila objektiv i jezgru).
    const holeAngle = Math.asin(0.99 / 1.3);
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(1.3, 64, 40, 0, Math.PI * 2, holeAngle, Math.PI - holeAngle).rotateX(Math.PI / 2),
      M.graphite,
    );
    ball.castShadow = true;
    ball.receiveShadow = true;
    this.gimbal.add(ball);
    // Slojevi za rastavljanje (exploded view): [objekt, pomak duž optičke osi pri punom rastavljanju].
    this.layers = [[ball, -0.35]];
    // Ekvatorski prsten (anodizirani) — mehanički detalj kad oko skrene.
    const band = new THREE.Mesh(new THREE.TorusGeometry(1.31, 0.05, 12, 96), M.anodized);
    this.gimbal.add(band);
    this.layers.push([band, -0.35]);

    // Objektiv: stepenasta cijev s nazubljenim prstenom.
    const barrelProfile = [
      new THREE.Vector2(0.98, 0.45),
      new THREE.Vector2(1.16, 0.55),
      new THREE.Vector2(1.16, 0.78),
      new THREE.Vector2(1.1, 0.82),
      new THREE.Vector2(1.1, 1.02),
      new THREE.Vector2(1.04, 1.08),
      new THREE.Vector2(0.98, 1.08),
      new THREE.Vector2(0.96, 0.9),
      new THREE.Vector2(0.96, 0.5),
    ];
    const barrel = new THREE.Mesh(new THREE.LatheGeometry(barrelProfile, 96).rotateX(Math.PI / 2), M.barrel);
    barrel.castShadow = true;
    this.gimbal.add(barrel);
    this.layers.push([barrel, 2.9]);

    // Prsten s gravurom oznaka (ispred cijevi).
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 1.05, 96, 1),
      new THREE.MeshPhysicalMaterial({
        color: '#0b0c0e',
        metalness: 0.6,
        roughness: 0.35,
        emissive: '#ffffff',
        emissiveMap: ringText,
        emissiveIntensity: 0.18,
        envMapIntensity: 0.8,
      }),
    );
    ring.position.z = 1.085;
    this.gimbal.add(ring);
    this.layers.push([ring, 3.4]);

    // --- Unutrašnjost: tamna leća, emisivni prstenovi na različitim dubinama, jezgra ---
    const interior = new THREE.Mesh(
      new THREE.CylinderGeometry(0.97, 0.97, 0.9, 64, 1, true).rotateX(Math.PI / 2),
      M.interior,
    );
    interior.position.z = 0.45;
    this.gimbal.add(interior);
    const back = new THREE.Mesh(new THREE.CircleGeometry(0.97, 64), M.interior);
    back.position.z = 0.02;
    this.gimbal.add(back);

    this.ringMats = [];
    this.emissiveObjects = [];
    const ringSpec = [
      // [unutarnji r, vanjski r, z, relativni sjaj] — prstenovi na različitim dubinama
      [0.62, 0.7, 0.66, 0.3],
      [0.45, 0.52, 0.48, 0.55],
      [0.3, 0.36, 0.31, 0.95],
      [0.2, 0.235, 0.18, 1.5],
    ];
    ringSpec.forEach(([r0, r1, z, k], i) => {
      const mat = new THREE.MeshBasicMaterial({ color: this.color.clone(), toneMapped: false, side: THREE.DoubleSide });
      const r = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 96), mat);
      r.position.z = z;
      this.gimbal.add(r);
      this.ringMats.push([mat, k]);
      this.emissiveObjects.push(r);
      // Rastavljeni prstenovi tvore stožac prema naprijed (manji ispred većih).
      this.layers.push([r, 0.4 + 0.35 * i]);
    });
    // Radijalne "lopatice" između prstenova — fina mehanika iza blende.
    const spokes = new THREE.InstancedMesh(new THREE.BoxGeometry(0.018, 0.26, 0.018), M.interiorLit, 12);
    for (let i = 0; i < 12; i++) {
      m4.makeRotationZ((i / 12) * Math.PI * 2).multiply(new THREE.Matrix4().makeTranslation(0, 0.4, 0.36));
      spokes.setMatrixAt(i, m4);
    }
    this.gimbal.add(spokes);
    this.layers.push([spokes, 0.5]);

    this.coreMat = new THREE.MeshBasicMaterial({ color: this.color.clone(), toneMapped: false });
    this.core = new THREE.Mesh(new THREE.SphereGeometry(0.15, 32, 16), this.coreMat);
    this.core.position.z = 0.1;
    this.gimbal.add(this.core);
    this.layers.push([this.core, 1.7]);
    // Mekani sjaj oko jezgre (disk s radijalnim gradijentom, aditivno).
    this.glowMat = new THREE.ShaderMaterial({
      uniforms: { color: { value: this.color.clone() }, strength: { value: 1 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 color; uniform float strength; varying vec2 vUv;
        void main(){ float r = length(vUv - 0.5) * 2.0; float g = ( exp(-r * r * 14.0) * 1.6 + exp(-r * r * 3.5) * 0.35 ) * strength; gl_FragColor = vec4(color * g, 1.0); }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), this.glowMat);
    glow.position.z = 0.2;
    this.gimbal.add(glow);
    this.layers.push([glow, 1.7]);
    this.emissiveObjects.push(this.core, glow);

    // --- Iris-blenda: lamele s blagim preklapanjem po dubini ---
    this.blades = [];
    const bladeGeo = new THREE.ShapeGeometry(bladeShape(0.0, 0.92), 24);
    // Lamele se odrežu na polumjeru kućišta (u prostoru oka) — otvorene se "skriju" u objektiv.
    this.bladeMat = M.blade.clone();
    this.gimbalInverse = { value: new THREE.Matrix4() };
    this.edgeGlow = { value: new THREE.Color() };
    this.bladeMat.onBeforeCompile = (shader) => {
      shader.uniforms.gimbalInverse = this.gimbalInverse;
      shader.uniforms.edgeGlow = this.edgeGlow;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform mat4 gimbalInverse;\nvarying vec3 vEyeLocal;\nvarying vec2 vBlade;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvEyeLocal = ( gimbalInverse * modelMatrix * vec4( transformed, 1.0 ) ).xyz;\nvBlade = position.xy;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 edgeGlow;\nvarying vec3 vEyeLocal;\nvarying vec2 vBlade;')
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif ( length( vEyeLocal.xy ) > 0.955 ) discard;')
        // Unutarnji rub lamele hvata sjaj jezgre (tanka svijetla linija), plus fine radijalne brazde.
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n{ float e = 1.0 - smoothstep( 0.0, 0.035, vBlade.y + 0.03 ); totalEmissiveRadiance += edgeGlow * e; diffuseColor.rgb *= 0.85 + 0.15 * sin( vBlade.x * 140.0 ); }',
        );
    };
    this.bladeMat.customProgramCacheKey = () => 'irisBlade';
    for (let i = 0; i < BLADES; i++) {
      const pivot = new THREE.Group();
      pivot.rotation.z = (i / BLADES) * Math.PI * 2;
      const blade = new THREE.Mesh(bladeGeo, this.bladeMat);
      blade.position.z = 0.82 + i * 0.0035;
      pivot.add(blade);
      this.gimbal.add(pivot);
      this.blades.push({ pivot, blade });
      this.layers.push([pivot, 2.3 + i * 0.02]);
    }

    // --- Rožnica: staklena kupola s AR prevlakom ---
    const capR = 1.42, capH = 0.34, baseR = 0.97;
    const theta = Math.asin(baseR / capR);
    const cornea = new THREE.Mesh(
      new THREE.SphereGeometry(capR, 64, 24, 0, Math.PI * 2, 0, theta).rotateX(Math.PI / 2),
      M.lens,
    );
    cornea.position.z = 1.08 + capH - capR;
    cornea.renderOrder = 3;
    this.gimbal.add(cornea);
    this.cornea = cornea;
    this.layers.push([cornea, 4.0]);

    // --- Kapci: dvije sferne ljuske koje se zatvaraju oko osi x ---
    this.lids = [];
    for (const dir of [1, -1]) {
      const lid = new THREE.Group();
      // Gornja prednja četvrtina sfere (kupola oko +y, samo prednja polovica);
      // donji kapak je ista ljuska zakrenuta oko optičke osi.
      const geo = new THREE.SphereGeometry(1.62, 64, 20, Math.PI * 0.18, Math.PI * 0.64, 0, Math.PI / 2);
      if (dir < 0) geo.rotateZ(Math.PI);
      const shell = new THREE.Mesh(geo, M.lid);
      shell.castShadow = true;
      lid.add(shell);
      // Rub kapka (cijev duž ruba).
      const edgeCurve = new THREE.EllipseCurve(0, 0, 1.62, 1.62, Math.PI * 0.18, Math.PI * 0.82);
      const pts = edgeCurve.getPoints(48).map((p) => new THREE.Vector3(dir < 0 ? -p.x : p.x, 0, p.y));
      const edge = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.045, 8), M.anodized);
      lid.add(edge);
      this.root.add(lid);
      this.lids.push({ lid, dir });
    }

    // --- Pravo svjetlo iz oka ---
    this.light = new THREE.PointLight(this.color, 1, 10, 2);
    this.light.position.set(0, 0, 1.9);
    this.gimbal.add(this.light);
    this.layers.push([this.light, 1.7]);
    for (const l of this.layers) l.push(l[0].position.z);
    this.exploded = 0;

    this.aperture = 0.55;
    this.blink = 0; // 0 otvoreno, 1 zatvoreno
    this.setAperture(0.55);
    this.setBlink(0);
  }

  /** Prije rendera: matrica za odsijecanje lamela. */
  updateMatrices() {
    this.gimbal.updateMatrixWorld();
    this.gimbalInverse.value.copy(this.gimbal.matrixWorld).invert();
  }

  setColor(color) {
    this.color.copy(color);
    this.coreMat.color.copy(color);
    this.glowMat.uniforms.color.value.copy(color);
    this.light.color.copy(color);
  }

  /** a = polumjer otvora blende u cm (0 = zatvoreno, ~0.62 = potpuno otvoreno). */
  setAperture(a) {
    this.aperture = a;
    for (const { pivot, blade } of this.blades) {
      // Lamela je pomaknuta radijalno tako da joj unutarnji rub dodiruje krug otvora,
      // uz blagi zakret (spiralni izgled kao u pravom objektivu).
      blade.position.y = Math.max(0.0, a);
      blade.rotation.z = 0.32 + (0.62 - a) * 0.55;
      void pivot;
    }
  }

  setBlink(b) {
    this.blink = b;
    // U mirovanju gornji kapak blago prekriva vrh leće (smiren pogled), donji je niže.
    // Rastavljeno oko: kapci se otvore do kraja i odmaknu (vidi se cijeli objektiv).
    const e = this.exploded;
    for (const { lid, dir } of this.lids) {
      const open = THREE.MathUtils.degToRad((dir > 0 ? 62 : 74) + 22 * e);
      lid.rotation.x = dir * -(1 - b * (1 - e)) * open;
      lid.position.y = dir * 0.55 * e;
    }
  }

  /**
   * Rastavljanje oka duž optičke osi: kućište malo natrag, prstenovi u stožac,
   * jezgra, iris-blenda, objektiv, prsten s gravurom i rožnica redom naprijed.
   * @param {number} s 0 = sklopljeno, 1 = potpuno rastavljeno
   */
  explode(s) {
    this.exploded = s;
    for (const [obj, k, base] of this.layers) obj.position.z = base + k * s;
  }

  /** Svjetlina jezgre i prstenova (HDR), uključujući pulsaciju. */
  setIntensity(k, pulse = 0) {
    this.intensity = k;
    const c = this.color;
    this.coreMat.color.copy(c).multiplyScalar(26 * k * (1 + 0.25 * pulse));
    for (const [mat, rk] of this.ringMats) mat.color.copy(c).multiplyScalar(5.5 * k * rk * (1 + 0.15 * pulse));
    this.glowMat.uniforms.strength.value = 2.2 * k * (1 + 0.2 * pulse);
    this.edgeGlow.value.copy(c).multiplyScalar(1.6 * k);
    this.light.intensity = 3.2 * k * (1 + 0.2 * pulse) * (1 - this.blink * 0.85);
  }
}
