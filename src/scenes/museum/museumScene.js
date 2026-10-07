// Scena 3 — "Muzejska vitrina": tamna galerija iza ekrana, stakleni kubus na
// kamenom monolitu, unutra kromirana giroidna sfera s kristalnom jezgrom.
// Muzejski spot kroz haze (volumetrija sa sjenom rešetke), kaustike, prašina.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { generateSDF } from '../../geometry/generate.js';
import { loadStudioHDR, buildStudioEnvironment } from '../../render/environment.js';
import { configurePCSSSpot } from '../../render/pcss.js';
import { ContactShadows, CONTACT_LAYER } from '../../render/contactShadows.js';
import { PlanarReflection } from '../../render/planarReflection.js';
import { CausticsTexture } from '../../render/caustics.js';
import { DustMotes } from '../../render/dust.js';
import {
  chromeMaterial,
  crystalMaterial,
  glassPaneMaterial,
  glassEdgeMaterial,
  brushedMetalMaterial,
  stoneMaterial,
  microcementMaterial,
} from '../../render/materials.js';
import { createGlassSmudgeTexture, createBrushedTexture, createPlaqueTextures } from '../../render/proceduralTextures.js';

const BG = new THREE.Color('#030304');

// Parametri rešetke (URL ?lattice=… samo za razvoj/usporedbu varijanti).
function latticeParams() {
  const v = new URLSearchParams(location.search).get('lattice');
  if (v === 'sheet') return { mode: 'sheet' };
  if (v === 'double') return { mode: 'double', period: 3.6, strut: 1.12, inner: 5.0 };
  if (v === 'double2') return { mode: 'double', period: 4.2, strut: 1.05, inner: 4.9 };
  return { mode: 'network', period: 3.45, strut: 0.82, inner: 4.9, rim: 0.42 };
}
const CANDELA = 1e4; // jedinice scene su cm → intenzitet × 100² za fizički pad 1/d²

// Raspored (cm, ishodište = centar prozora na ravnini ekrana).
const L = {
  floorY: -34,
  centerZ: -58,
  monolith: { w: 30, d: 30, top: -15.5 },
  base: { w: 26.4, d: 26.4, h: 3.0 },
  glass: { w: 25, d: 25, h: 21, t: 0.55 },
  sphere: { r: 7, gap: 2.0 },
  puck: { r: 2.6, h: 1.4 },
  backWallZ: -230,
};

export class MuseumScene {
  constructor(renderer) {
    this.name = 'Muzejska vitrina';
    this.usesPost = true;
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.display = new THREE.Group(); // skalira se prema veličini prozora
    this.group.add(this.display);
    this.ready = null;
    this.time = 0;
    this.frame = 0;
    this.env = null;
  }

  /** Teški koraci unaprijed u pozadini (da je scena spremna kad je korisnik odabere). */
  preload() {
    generateSDF('gyroidSphere', latticeParams());
    loadStudioHDR();
  }

  /** Učitaj/generiraj sve (HDRI, teksture, giroid u workeru). */
  init() {
    if (this.ready) return this.ready;
    this.ready = this.#build();
    return this.ready;
  }

  async #build() {
    const texLoader = new THREE.TextureLoader();
    const base = import.meta.env.BASE_URL;
    const [hdr, geo, plaque, diff, rough, nor] = await Promise.all([
      loadStudioHDR(),
      generateSDF('gyroidSphere', latticeParams()),
      createPlaqueTextures({ title: 'ANIMA LUCIS', subtitle: 'kromirani giroid · optički kristal', year: 'MMXXVI' }),
      texLoader.loadAsync(`${base}textures/grey_plaster_diff_1k.jpg`),
      texLoader.loadAsync(`${base}textures/grey_plaster_rough_1k.jpg`),
      texLoader.loadAsync(`${base}textures/grey_plaster_nor_gl_1k.jpg`),
    ]);

    this.env = buildStudioEnvironment(this.renderer, hdr, {
      exposure: 0.42,
      floorLevel: 0.02,
      rotation: 1.9,
      strips: [
        // Visoke uske trake iza-lijevo i iza-desno → rubni odsjaji ("rim") na kromu.
        { dir: [-0.82, 0.18, -0.55], size: [9, 80], intensity: 16, softness: 0.35 },
        { dir: [0.86, 0.12, -0.5], size: [7, 70], intensity: 12, softness: 0.35 },
        // Muzejski spot iznad — jaka okrugla točka i široki softbox.
        { dir: [-0.3, 0.9, -0.3], size: [14, 14], intensity: 40, softness: 0.6 },
        { dir: [0.0, 0.8, 0.6], size: [70, 26], intensity: 4.5, softness: 0.55 },
        // Bočne trake sprijeda — duge vertikalne linije na kromu kao u studiju.
        { dir: [-0.75, 0.05, 0.66], size: [6, 70], intensity: 6, softness: 0.3 },
        { dir: [0.7, 0.0, 0.7], size: [5, 60], intensity: 4, softness: 0.3 },
        // Topla traka odozdo (svjetlo odbijeno od dna vitrine).
        { dir: [0.2, -0.65, 0.6], size: [50, 12], intensity: 0.6, color: '#ffcf9e', softness: 0.6 },
      ],
    });

    // Staklo reflektira tamnu galeriju s nekoliko stropnih reflektora (ne studijske softboxe).
    this.glassEnv = buildStudioEnvironment(this.renderer, hdr, {
      exposure: 0.025,
      floorLevel: 0.02,
      horizon: [0.02, 0.35],
      rotation: 0.6,
      tint: '#c9d3e0',
      strips: [
        { dir: [-0.35, 0.85, -0.4], size: [3, 3], intensity: 45, softness: 0.7 },
        { dir: [0.45, 0.82, 0.35], size: [2.5, 2.5], intensity: 30, softness: 0.7 },
        // Slabo osvijetljen suprotni zid galerije → diskretan odsjaj na bočnim staklima.
        { dir: [-0.92, 0.18, 0.35], size: [30, 40], intensity: 0.35, color: '#c8d2e0', softness: 0.85 },
        { dir: [0.9, 0.22, 0.38], size: [24, 36], intensity: 0.22, color: '#c8d2e0', softness: 0.85 },
      ],
    });
    const smudge = createGlassSmudgeTexture(7);
    const brush = createBrushedTexture(3);

    this.#buildRoom({ diff, rough, nor });
    this.#buildPedestal(brush, plaque);
    this.#buildVitrine(smudge, brush);
    this.#buildSculpture(geo, brush);
    this.#buildLights();
    this.#buildEffects();
    if (this.size) this.reflection.setSize(...this.size);
  }

  #buildRoom(wallTex) {
    const floorMat = stoneMaterial({ polished: true, tiles: 80, color: '#0c0c0e' });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(500, 400).rotateX(-Math.PI / 2), floorMat);
    this.floor.position.set(0, L.floorY, -100);
    this.floor.receiveShadow = true;
    this.display.add(this.floor);

    const wallMat = microcementMaterial(wallTex, 4);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(400, 160), wallMat);
    back.position.set(0, L.floorY + 80, L.backWallZ);
    back.receiveShadow = true;
    this.display.add(back);
    const sideMat = microcementMaterial({ diff: wallTex.diff.clone(), rough: wallTex.rough.clone(), nor: wallTex.nor.clone() }, 3);
    for (const sx of [-1, 1]) {
      const side = new THREE.Mesh(new THREE.PlaneGeometry(260, 160), sideMat);
      side.rotation.y = -sx * Math.PI / 2;
      side.position.set(sx * 130, L.floorY + 80, L.backWallZ + 130);
      this.display.add(side);
    }
    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 300).rotateX(Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: '#050506' }),
    );
    ceiling.position.set(0, 95, -100);
    this.display.add(ceiling);
    // Tanka sjena-fuga na dnu zida (sokl) — arhitektonski detalj za mjerilo.
    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(400, 1.2, 1.2),
      new THREE.MeshStandardMaterial({ color: '#020203', roughness: 0.6 }),
    );
    plinth.position.set(0, L.floorY + 0.6, L.backWallZ + 0.6);
    this.display.add(plinth);
  }

  #buildPedestal(brush, plaque) {
    const m = L.monolith;
    const monoH = m.top - L.floorY;
    const stone = stoneMaterial({ polished: false, color: '#0b0b0c' });
    this.monolith = new THREE.Mesh(new RoundedBoxGeometry(m.w, monoH, m.d, 3, 0.25), stone);
    this.monolith.position.set(0, L.floorY + monoH / 2, L.centerZ);
    this.monolith.castShadow = true;
    this.monolith.receiveShadow = true;
    this.monolith.layers.enable(CONTACT_LAYER);
    this.display.add(this.monolith);

    // Brončana baza vitrine.
    const b = L.base;
    const bronze = brushedMetalMaterial(brush, { color: '#0f0e0c', roughness: 0.42, repeat: [3, 1] });
    bronze.envMap = this.env;
    bronze.envMapIntensity = 0.8;
    this.bronze = bronze;
    this.base = new THREE.Mesh(new RoundedBoxGeometry(b.w, b.h, b.d, 2, 0.12), bronze);
    this.base.position.set(0, m.top + b.h / 2, L.centerZ);
    this.base.castShadow = true;
    this.base.receiveShadow = true;
    this.display.add(this.base);

    // Kamena ploča (dno vitrine) — svjetlija da se vide kaustike i sjena rešetke.
    const deckMat = stoneMaterial({ polished: false, color: '#3a3936' });
    deckMat.roughness = 0.7;
    this.deck = new THREE.Mesh(new RoundedBoxGeometry(L.glass.w - 2 * L.glass.t, 0.3, L.glass.d - 2 * L.glass.t, 2, 0.05), deckMat);
    this.deckY = m.top + b.h;
    this.deck.position.set(0, this.deckY + 0.15, L.centerZ);
    this.deck.receiveShadow = true;
    this.display.add(this.deck);

    // Mesingana pločica s nazivom djela.
    const brass = new THREE.MeshPhysicalMaterial({
      color: '#ffffff',
      map: plaque.map,
      metalness: 1,
      roughness: 1,
      roughnessMap: plaque.roughnessMap,
      bumpMap: plaque.bumpMap,
      bumpScale: 1.2,
      anisotropy: 0.4,
      envMap: this.env,
      envMapIntensity: 1.2,
    });
    const plaqueW = 8.6, plaqueH = 2.3;
    const plate = new THREE.Mesh(new RoundedBoxGeometry(plaqueW, plaqueH, 0.12, 2, 0.04), [
      bronze, bronze, bronze, bronze, brass, bronze,
    ]);
    plate.position.set(0, m.top + b.h / 2, L.centerZ + b.d / 2 + 0.07);
    plate.castShadow = true;
    this.display.add(plate);
    // Dva sitna vijka na pločici.
    this.screwSpots = [
      [-plaqueW / 2 + 0.35, m.top + b.h / 2, L.centerZ + b.d / 2 + 0.14, 'z'],
      [plaqueW / 2 - 0.35, m.top + b.h / 2, L.centerZ + b.d / 2 + 0.14, 'z'],
    ];
  }

  #buildVitrine(smudge, brush) {
    const g = L.glass;
    const y0 = L.monolith.top + L.base.h;
    const cy = y0 + g.h / 2;
    const cz = L.centerZ;
    this.glassTop = y0 + g.h;

    const glass = glassPaneMaterial(smudge, 1);
    const glass2 = glassPaneMaterial(smudge, 1.3);
    const edge = glassEdgeMaterial();
    for (const m of [glass, glass2, edge]) m.envMapIntensity = m === edge ? 1.5 : 1.6;
    this.glassPanes = [];
    const pane = (w, h, d, mats, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats);
      m.position.set(x, y, z);
      m.renderOrder = 2;
      this.display.add(m);
      this.glassPanes.push(m);
      return m;
    };
    const t = g.t;
    // Prednje / stražnje staklo (tanko po z), bočna (tanko po x), gornje (tanko po y).
    pane(g.w, g.h, t, [edge, edge, edge, edge, glass, glass], 0, cy, cz + g.d / 2 - t / 2);
    pane(g.w, g.h, t, [edge, edge, edge, edge, glass2, glass2], 0, cy, cz - g.d / 2 + t / 2);
    pane(t, g.h, g.d - 2 * t, [glass2, glass2, edge, edge, edge, edge], -g.w / 2 + t / 2, cy, cz);
    pane(t, g.h, g.d - 2 * t, [glass, glass, edge, edge, edge, edge], g.w / 2 - t / 2, cy, cz);
    const glassTop = glassPaneMaterial(smudge, 0.6, 0.03);
    glassTop.envMapIntensity = 0.5;
    pane(g.w, t, g.d, [edge, edge, glassTop, glassTop, edge, edge], 0, y0 + g.h + t / 2, cz);

    // Brončani okvir: gornji obruč, vertikalni kutni profili, kutni spojevi.
    const bronze = this.bronze;
    const bar = 0.85;
    const topY = y0 + g.h + t + bar / 2 - 0.2;
    const lenX = g.w + 0.4, lenZ = g.d + 0.4;
    const mkBar = (sx, sy, sz, x, y, z, rotY = 0) => {
      const m = new THREE.Mesh(new RoundedBoxGeometry(sx, sy, sz, 2, 0.08), bronze);
      m.position.set(x, y, z);
      m.rotation.y = rotY;
      m.castShadow = true;
      m.receiveShadow = true;
      this.display.add(m);
      return m;
    };
    mkBar(lenX, bar, bar, 0, topY, cz + g.d / 2);
    mkBar(lenX, bar, bar, 0, topY, cz - g.d / 2);
    mkBar(bar, bar, lenZ, -g.w / 2, topY, cz);
    mkBar(bar, bar, lenZ, g.w / 2, topY, cz);
    const vh = g.h + 0.1;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        // L-profil od dvije letvice koje obuhvaćaju spoj stakala.
        mkBar(0.55, vh, 0.12, sx * (g.w / 2 - 0.12), y0 + vh / 2, cz + sz * (g.d / 2 + 0.06));
        mkBar(0.12, vh, 0.55, sx * (g.w / 2 + 0.06), y0 + vh / 2, cz + sz * (g.d / 2 - 0.12));
        // Kutni blok na vrhu.
        mkBar(1.3, 1.3, 1.3, sx * g.w / 2, topY, cz + sz * g.d / 2);
        this.screwSpots.push([sx * g.w / 2, topY, cz + sz * g.d / 2 + sz * 0.66, 'z', sz]);
        this.screwSpots.push([sx * g.w / 2 + sx * 0.66, topY, cz + sz * g.d / 2, 'x', sx]);
      }
    }
    // Vijci na bazi (prednja i bočne strane).
    const by = L.monolith.top + 0.75;
    for (let i = 0; i < 4; i++) {
      const x = -L.base.w / 2 + 2.2 + i * ((L.base.w - 4.4) / 3);
      if (Math.abs(x) < 5.2) continue; // ne preko pločice
      this.screwSpots.push([x, by + 1.5, cz + L.base.d / 2 + 0.02, 'z', 1]);
    }
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const z = cz - L.base.d / 2 + 4 + i * ((L.base.d - 8) / 2);
        this.screwSpots.push([sx * (L.base.w / 2 + 0.02), by + 1.5, z, 'x', sx]);
      }
    }
    this.#buildScrews();
  }

  #buildScrews() {
    // Glava vijka: plitka kupola; utor: tamni šesterokut.
    const head = new THREE.SphereGeometry(0.2, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.42).translate(0, -0.13, 0);
    const hex = new THREE.CylinderGeometry(0.085, 0.085, 0.06, 6).translate(0, 0.045, 0);
    const steel = new THREE.MeshPhysicalMaterial({ color: '#8b8579', metalness: 1, roughness: 0.28, envMap: this.env });
    const dark = new THREE.MeshStandardMaterial({ color: '#050505', roughness: 0.8 });
    const n = this.screwSpots.length;
    const heads = new THREE.InstancedMesh(head, steel, n);
    const hexes = new THREE.InstancedMesh(hex, dark, n);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    this.screwSpots.forEach(([x, y, z, axis, sign = 1], i) => {
      const dir = axis === 'z' ? new THREE.Vector3(0, 0, sign) : new THREE.Vector3(sign, 0, 0);
      q.setFromUnitVectors(up, dir);
      const spin = new THREE.Quaternion().setFromAxisAngle(dir, i * 1.3);
      m.compose(new THREE.Vector3(x, y, z), spin.multiply(q), new THREE.Vector3(1, 1, 1));
      heads.setMatrixAt(i, m);
      hexes.setMatrixAt(i, m);
    });
    heads.castShadow = true;
    this.display.add(heads, hexes);
  }

  #buildSculpture(geo, brush) {
    const s = L.sphere;
    const deckTop = this.deckY + 0.3;
    // Brončani "pak" na kojem sfera lebdi.
    const p = L.puck;
    const profile = [
      new THREE.Vector2(0, 0),
      new THREE.Vector2(p.r + 0.4, 0),
      new THREE.Vector2(p.r + 0.4, 0.25),
      new THREE.Vector2(p.r, 0.45),
      new THREE.Vector2(p.r, p.h - 0.2),
      new THREE.Vector2(p.r - 0.2, p.h),
      new THREE.Vector2(0.9, p.h),
      new THREE.Vector2(0.8, p.h - 0.15),
      new THREE.Vector2(0, p.h - 0.15),
    ];
    this.puck = new THREE.Mesh(new THREE.LatheGeometry(profile, 96), this.bronze);
    this.puck.position.set(0, deckTop, L.centerZ);
    this.puck.castShadow = true;
    this.puck.receiveShadow = true;
    this.puck.layers.enable(CONTACT_LAYER);
    this.display.add(this.puck);

    this.sphereCenter = new THREE.Vector3(0, deckTop + p.h + s.gap + s.r, L.centerZ);
    this.sculpture = new THREE.Group();
    this.sculpture.position.copy(this.sphereCenter);
    this.display.add(this.sculpture);

    const chrome = chromeMaterial();
    chrome.envMap = this.env;
    this.lattice = new THREE.Mesh(geo.lattice, chrome);
    this.lattice.castShadow = true;
    // Krom nema difuznu komponentu — samosjenčanje bi koštalo PCSS po pikselu
    // rešetke, a vizualno se vidi tek u odsjajima.
    this.lattice.receiveShadow = false;
    this.lattice.layers.enable(CONTACT_LAYER);
    this.sculpture.add(this.lattice);

    // Kristalna jezgra: nepravilni fasetirani dragulj.
    const gem = new THREE.IcosahedronGeometry(2.35, 1);
    const pos = gem.attributes.position;
    let seed = 99;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const vmap = new Map();
    for (let i = 0; i < pos.count; i++) {
      const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
      if (!vmap.has(key)) vmap.set(key, 0.86 + rnd() * 0.26);
      const k = vmap.get(key);
      pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k * 1.18, pos.getZ(i) * k);
    }
    gem.computeVertexNormals();
    const crystalMat = crystalMaterial();
    crystalMat.envMap = this.env;
    this.crystal = new THREE.Mesh(gem, crystalMat);
    this.crystal.castShadow = false;
    this.coreGroup = new THREE.Group();
    this.coreGroup.add(this.crystal);
    this.sculpture.add(this.coreGroup);
  }

  #buildLights() {
    // Glavni muzejski spot: odozgo-straga-lijevo, uski snop, PCSS sjene, volumetrija.
    this.key = new THREE.SpotLight('#fff1e0', 30 * CANDELA, 0, THREE.MathUtils.degToRad(7.5), 0.38, 2);
    this.key.position.set(-30, 66, L.centerZ - 42);
    this.key.target.position.set(1, -7, L.centerZ + 2);
    configurePCSSSpot(this.key, 3.2, 2048);
    this.display.add(this.key, this.key.target);

    // Kaustike: projektor iz kristala prema dnu vitrine (cookie = animirana tekstura).
    this.caustics = new CausticsTexture(512);
    this.causticLight = new THREE.SpotLight('#ffffff', 25 * CANDELA * 0.01, 0, THREE.MathUtils.degToRad(42), 0.35, 2);
    this.causticLight.map = this.caustics.texture;
    this.causticLight.position.copy(this.sphereCenter);
    this.causticLight.target.position.set(2.5, this.deckY, L.centerZ + 4);
    this.display.add(this.causticLight, this.causticLight.target);

    // Meko prednje svjetlo (pločica, prednji rub baze). Rim na kromu dolazi iz
    // traka u env mapi — jeftinije od area svjetala, a jednako uvjerljivo.
    this.fill = new THREE.SpotLight('#ffe7d1', 2.6 * CANDELA, 0, THREE.MathUtils.degToRad(30), 1, 2);
    this.fill.position.set(8, 52, 20);
    this.fill.target.position.set(0, -8, L.centerZ + 6);
    this.display.add(this.fill, this.fill.target);

    // Svjetlo na stražnjem zidu (mekani "pool" iza vitrine).
    this.wallWash = new THREE.SpotLight('#dfe7ff', 9 * CANDELA, 0, THREE.MathUtils.degToRad(22), 1, 2);
    this.wallWash.position.set(10, 90, -130);
    this.wallWash.target.position.set(-4, 0, L.backWallZ);
    this.display.add(this.wallWash, this.wallWash.target);

    // Slabo svjetlo iznutra — unutarnje stijenke rešetke hvataju sjaj kristala.
    this.inner = new THREE.PointLight('#fff2df', 0.35 * CANDELA * 0.01, 14, 2);
    this.sculpture.add(this.inner);

    this.hemi = new THREE.HemisphereLight('#1a1d22', '#060606', 0.12);
    this.display.add(this.hemi);

    // Intenziteti točkastih/spot svjetala skaliraju se s s² kad se kompozicija skalira.
    this.scaledLights = [this.key, this.causticLight, this.wallWash, this.inner, this.fill].map((l) => [l, l.intensity]);
  }

  #buildEffects() {
    this.deckShadow = new ContactShadows({ width: 20, depth: 20, far: 9, resolution: 512, blur: 2.6, opacity: 0.9 });
    this.deckShadow.group.position.set(0, this.deckY + 0.31, L.centerZ);
    this.display.add(this.deckShadow.group);

    this.floorShadow = new ContactShadows({ width: 60, depth: 60, far: 14, resolution: 256, blur: 3.5, opacity: 0.95 });
    this.floorShadow.group.position.set(0, L.floorY + 0.02, L.centerZ);
    this.display.add(this.floorShadow.group);
    this.floorShadowDirty = true;

    this.reflection = new PlanarReflection({ planeY: L.floorY, resolutionScale: 0.5, blur: 2.5 });
    this.reflection.patch(this.floor.material);
    this.reflection.hide = [this.floor, ...this.glassPanes];

    this.dust = new DustMotes({
      count: 520,
      box: new THREE.Box3(new THREE.Vector3(-34, -12, L.centerZ - 50), new THREE.Vector3(20, 40, L.centerZ + 18)),
      frontBox: new THREE.Box3(new THREE.Vector3(-8, -5, 2), new THREE.Vector3(8, 6, 14)),
      frontCount: 14,
      size: 0.05,
    });
    this.display.add(this.dust.points);
    this.reflection.hide.push(this.dust.points);
  }

  activate(scene, ctx) {
    scene.background = BG;
    scene.fog = null;
    // Scena (zidovi, kamen, staklo) živi u tamnoj galeriji; krom, kristal i
    // metali dobivaju studijske trake (kao kartice i zastavice u produktnoj fotografiji).
    scene.environment = this.glassEnv;
    scene.environmentIntensity = 1;
    scene.environmentRotation.set(0, 0, 0);
    ctx.post.configure({
      toneMapping: 'AGX',
      exposure: 1.0,
      bloom: { intensity: 1.6, threshold: 0.85, smoothing: 0.25, radius: 0.7 },
      ao: { aoRadius: 2.5, distanceFalloff: 1.0, intensity: 2.4 },
      vignette: { darkness: 0.6, offset: 0.28 },
      grain: 0.075,
      volumetric: {
        light: this.key,
        density: 0.0011,
        ambientDensity: 0.0004,
        noiseScale: 0.028,
        noiseAmount: 0.85,
        g: 0.5,
        range: 260,
        intensity: 1,
        lightScale: 1,
      },
      bloomSelection: [this.crystal],
    });
  }

  layout(rect) {
    // Kompozicija je projektirana za ~19 cm visok prozor; veći ekrani je skaliraju.
    const s = THREE.MathUtils.clamp(rect.height / 18.8, 0.75, 2.4);
    this.display.scale.setScalar(s);
    this.display.position.set(0, 0, 0);
    this.displayScale = s;
    for (const [light, base] of this.scaledLights ?? []) light.intensity = base * s * s;
    this.floorShadowDirty = true;
  }

  setQuality(q) {
    this.key.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    this.key.shadow.map?.dispose();
    this.key.shadow.map = null;
    this.reflection.resolutionScale = q.reflectionScale;
    this.reflection.enabled = q.reflectionScale > 0;
  }

  setSize(width, height) {
    this.size = [width, height];
    this.reflection?.setSize(width, height);
  }

  update(t, dt) {
    this.time += dt;
    this.frame++;
    const T = this.time;
    // Sfera se polako vrti, jezgra suprotno i "diše".
    this.sculpture.rotation.y = T * 0.075;
    this.sculpture.rotation.x = Math.sin(T * 0.05) * 0.08;
    this.sculpture.position.y = this.sphereCenter.y + Math.sin(T * 0.6) * 0.12;
    const breath = Math.sin(T * (Math.PI * 2 / 6.5));
    this.coreGroup.rotation.y = -T * 0.32;
    this.coreGroup.rotation.z = Math.sin(T * 0.21) * 0.25;
    this.coreGroup.scale.setScalar(1 + breath * 0.045);
    const cu = this.crystal.material.userData.crystal;
    cu.coreColor.value.set('#fff2dc').multiplyScalar(6 + breath * 2.5);
    this.crystal.getWorldPosition(cu.coreCenter.value);
    cu.coreRadius.value = 0.42 * (this.displayScale ?? 1) * (1 + breath * 0.15);
    const s2 = (this.displayScale ?? 1) ** 2;
    this.inner.intensity = (0.3 + 0.12 * breath) * CANDELA * 0.01 * s2;
    this.causticLight.intensity = (55 + 15 * breath) * CANDELA * 0.01 * s2;
    this.causticAngle = -T * 0.32 + this.sculpture.rotation.y;
    this.breath = breath;
  }

  /** Pripreme prije glavnog rendera (jednom po frameu). */
  beforeRender(renderer, scene, eyeWorld, rectWorld) {
    this.caustics.render(renderer, this.time, this.causticAngle ?? 0, this.breath ?? 0);
    if (this.frame % 3 === 0) this.deckShadow.update(renderer, scene);
    if (this.floorShadowDirty) {
      this.floorShadow.update(renderer, scene);
      this.floorShadowDirty = false;
    }
    this.dust.update(this.time, this.key, 0.05);
    if (this.reflection.enabled) {
      this.reflection.planeY = this.floor.getWorldPosition(_v).y;
      this.reflection.update(renderer, scene, eyeWorld, rectWorld);
    }
  }
}

const _v = new THREE.Vector3();
