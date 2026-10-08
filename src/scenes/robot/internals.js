// Unutarnja mehanika robota — vidi se tek kad se paneli rastave (exploded view):
//   glava: "mozak" (procesor s hladnjakom i svjetlećim nizom), nosači očiju s
//          servo motorima, optički kabeli, servo čeljusti, govorni modul, nosač vrata;
//   poprsje: reaktor u prsima (koncentrični svjetleći prstenovi), kralježnica,
//          servo motori ramena i rashladne cijevi.
// Sve stoji unutar kaveza (provjereno SDF-om), pa se u sklopljenom stanju ne vidi
// i ne prolazi kroz ljusku. Dijelovi koji se pri rastavljanju dodatno pomiču
// (hladnjak, poklopac reaktora…) vraćaju se kao zasebne grupe.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EYE_X, CORE_CENTER } from '../../geometry/robotModels.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Valjak između dvije točke. */
function rod(a, b, r, seg = 16) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q);
  const m = a.clone().add(b).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z);
  return g;
}

/** Kabel kroz kontrolne točke. */
function cable(points, r, seg = 48) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  return new THREE.TubeGeometry(curve, seg, r, 10, false);
}

/** Valjak duž osi (x/y/z) sa središtem c. */
function cyl(c, r, len, axis = 'y', seg = 28) {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(c.x, c.y, c.z);
  return g;
}

/** Zupčanik: disk s nazubljenim rubom (os y). */
function gear(r, thick, teeth = 18) {
  const s = new THREE.Shape();
  for (let i = 0; i < teeth * 2; i++) {
    const a = (i / (teeth * 2)) * Math.PI * 2;
    const rr = i % 2 ? r : r * 0.86;
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, r * 0.28, 0, Math.PI * 2, true);
  s.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: true, bevelThickness: thick * 0.15, bevelSize: thick * 0.15, bevelSegments: 1, curveSegments: 4 });
  g.translate(0, 0, -thick / 2);
  g.rotateX(Math.PI / 2);
  return g;
}

function mesh(geos, mat, { cast = true, receive = true } = {}) {
  const g = geos.length === 1 ? geos[0] : mergeGeometries(geos.map((x) => (x.index ? x : x)), false);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

/** Svi geometry objekti moraju imati iste atribute za spajanje (bez uv2 itd.). */
function clean(g) {
  const n = g.index ? g : g;
  for (const k of Object.keys(n.attributes)) if (!['position', 'normal', 'uv'].includes(k)) n.deleteAttribute(k);
  if (!n.attributes.uv) n.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n.attributes.position.count * 2), 2));
  return n.index ? n.toNonIndexed() : n;
}

function merged(geos, mat, opts) {
  return mesh([mergeGeometries(geos.map(clean), false)], mat, opts);
}

/**
 * @param {object} M zajednički materijali robota (graphite, anodized, chrome, braided, rubber, titanium…)
 * @param {THREE.Color} glowColor boja svjetlećih dijelova (prati boju očiju)
 */
export function buildInternals(M) {
  const mats = {
    brain: new THREE.MeshPhysicalMaterial({ color: '#1b1e23', metalness: 0.85, roughness: 0.32, clearcoat: 0.3, clearcoatRoughness: 0.25 }),
    fins: new THREE.MeshPhysicalMaterial({ color: '#a7aeb6', metalness: 1, roughness: 0.3, anisotropy: 0.6 }),
    copper: new THREE.MeshPhysicalMaterial({ color: '#b87547', metalness: 1, roughness: 0.28 }),
    pcb: new THREE.MeshStandardMaterial({ color: '#0d2a22', metalness: 0.3, roughness: 0.55 }),
    glow: new THREE.MeshBasicMaterial({ color: '#79e6ff', toneMapped: false }),
    glowSoft: new THREE.MeshBasicMaterial({ color: '#79e6ff', toneMapped: false }),
    led: new THREE.MeshBasicMaterial({ color: '#79e6ff', toneMapped: false }),
  };
  const glowObjects = [];

  // ---------------- Glava (prostor glave, cm) ----------------
  const head = new THREE.Group();
  head.name = 'headInternals';

  // Mozak: procesorski blok iza očiju, gore-straga.
  const brain = new THREE.Group();
  brain.name = 'brain';
  const B = { c: V(0, 2.9, -9.9), size: V(7.0, 3.4, 5.8) };
  const block = new THREE.Mesh(new RoundedBoxGeometry(B.size.x, B.size.y, B.size.z, 4, 0.55), mats.brain);
  block.position.copy(B.c);
  block.castShadow = block.receiveShadow = true;
  brain.add(block);
  // Prednja ploča s nizom svjetlećih "neuronskih" segmenata.
  const strip = [];
  for (let i = 0; i < 9; i++) {
    const g = new RoundedBoxGeometry(0.46, 0.22, 0.08, 2, 0.04);
    g.translate(B.c.x - 2.4 + i * 0.6, B.c.y - 0.55, B.c.z + B.size.z / 2 + 0.02);
    strip.push(g);
  }
  const stripMesh = merged(strip, mats.glow, { cast: false });
  brain.add(stripMesh);
  glowObjects.push(stripMesh);
  // Mala tiskana pločica s bakrenim kontaktima na boku.
  for (const sx of [-1, 1]) {
    const pcb = new THREE.Mesh(new RoundedBoxGeometry(0.12, 2.2, 3.8, 2, 0.04), mats.pcb);
    pcb.position.set(sx * (B.size.x / 2 + 0.07), B.c.y - 0.2, B.c.z + 0.3);
    brain.add(pcb);
    const pins = [];
    for (let i = 0; i < 6; i++) pins.push(cyl(V(sx * (B.size.x / 2 + 0.16), B.c.y - 0.9 + i * 0.32, B.c.z + 1.6), 0.06, 0.12, 'x', 8));
    brain.add(merged(pins, mats.copper, { cast: false }));
  }
  head.add(brain);

  // Hladnjak na vrhu mozga (pri rastavljanju se podigne).
  const sink = new THREE.Group();
  sink.name = 'heatsink';
  const fins = [];
  for (let i = 0; i < 11; i++) {
    const g = new THREE.BoxGeometry(0.13, 1.05, 4.6);
    g.translate(-3.0 + i * 0.6, B.c.y + B.size.y / 2 + 0.6, B.c.z - 0.2);
    fins.push(g);
  }
  fins.push(new RoundedBoxGeometry(6.6, 0.18, 4.8, 2, 0.06).translate(0, B.c.y + B.size.y / 2 + 0.09, B.c.z - 0.2));
  sink.add(merged(fins, mats.fins));
  // Dvije bakrene toplinske cijevi.
  const pipes = [];
  for (const sx of [-1.6, 1.6]) pipes.push(cable([V(sx, B.c.y + B.size.y / 2 + 0.15, B.c.z + 2.2), V(sx, B.c.y + B.size.y / 2 + 0.9, B.c.z + 1.0), V(sx * 1.05, B.c.y + B.size.y / 2 + 1.0, B.c.z - 1.6), V(sx, B.c.y + B.size.y / 2 + 0.4, B.c.z - 2.6)], 0.16, 32));
  sink.add(merged(pipes, mats.copper));
  head.add(sink);

  // Nosači očiju: prsten iza duplje, servo za zakretanje (okomit) i za nagib (vodoravan).
  const mounts = [];
  const servos = [];
  const gears = [];
  const optic = [];
  for (const sx of [-1, 1]) {
    const ex = sx * EYE_X;
    const ring = new THREE.TorusGeometry(1.32, 0.17, 12, 48);
    ring.translate(ex, 0.05, -5.2);
    mounts.push(ring);
    // Krakovi nosača do središnjeg stupa.
    mounts.push(rod(V(ex - sx * 1.25, 0.05, -5.2), V(sx * 0.5, 0.6, -6.6), 0.16, 10));
    mounts.push(rod(V(ex, -1.27, -5.2), V(ex * 0.75, -2.6, -6.4), 0.14, 10));
    // Servo za zakretanje (ispod oka), servo za nagib (uz oko prema van).
    servos.push(new RoundedBoxGeometry(1.3, 1.05, 1.5, 3, 0.18).translate(ex, -2.35, -5.9));
    servos.push(new RoundedBoxGeometry(0.8, 1.15, 1.15, 3, 0.14).translate(ex + sx * 1.2, 0.0, -6.95));
    gears.push(gear(0.55, 0.16, 16).translate(ex, -1.72, -5.9));
    const gx = gear(0.46, 0.14, 14);
    gx.rotateZ(Math.PI / 2);
    gx.translate(ex + sx * 0.74, 0.0, -6.95);
    gears.push(gx);
    // Optički kabeli od stražnjeg dijela oka do mozga.
    optic.push(cable([V(ex, 0.25, -5.4), V(ex * 0.9, 0.6, -6.3), V(sx * 2.4, 1.6, -6.8), V(sx * 1.7, 2.2, B.c.z + B.size.z / 2 - 0.1)], 0.22, 40));
    optic.push(cable([V(ex - sx * 0.4, -0.35, -5.4), V(ex * 0.8, -0.2, -6.4), V(sx * 1.9, 1.2, -7.0), V(sx * 0.9, 1.9, B.c.z + B.size.z / 2 - 0.1)], 0.14, 40));
    // Kabeli servo motora prema mozgu.
    optic.push(cable([V(ex, -2.35, -6.65), V(ex * 0.7, -1.8, -8.2), V(sx * 1.6, 0.4, -9.4), V(sx * 1.4, 1.4, -9.5)], 0.1, 32));
  }
  head.add(merged(mounts, M.anodized));
  head.add(merged(servos, mats.brain));
  head.add(merged(gears, M.chrome));
  head.add(merged(optic, M.braided));

  // Nosač vrata (titanski stup) i servo motori čeljusti.
  const strut = [rod(V(0, -6.9, -6.6), V(0, B.c.y - B.size.y / 2 + 0.1, B.c.z + 0.6), 0.42, 20)];
  strut.push(new RoundedBoxGeometry(2.0, 0.4, 2.0, 2, 0.1).translate(0, -6.9, -6.6));
  head.add(merged(strut, M.titanium));
  const jaw = [];
  for (const sx of [-1, 1]) {
    jaw.push(cyl(V(sx * 3.3, -5.4, -5.5), 0.55, 1.0, 'x', 28));
    jaw.push(rod(V(sx * 2.8, -5.4, -5.5), V(sx * 1.9, -6.4, -3.9), 0.12, 10));
  }
  head.add(merged(jaw, mats.brain));
  const jawGears = [];
  for (const sx of [-1, 1]) {
    const g = gear(0.62, 0.16, 16);
    g.rotateZ(Math.PI / 2);
    g.translate(sx * 2.72, -5.4, -5.5);
    jawGears.push(g);
  }
  head.add(merged(jawGears, M.chrome));
  // Govorni modul iza proreza usta: membrana s koncentričnim žljebovima.
  const prof = [V(0, 0), V(0.9, 0), V(0.92, 0.08), V(0.7, 0.14), V(0.5, 0.06), V(0.3, 0.12), V(0, 0.16)].map((p) => new THREE.Vector2(p.x, p.y));
  const voice = new THREE.LatheGeometry(prof, 40).rotateX(Math.PI / 2).translate(0, -6.1, -2.2);
  const voiceRim = new THREE.TorusGeometry(0.95, 0.09, 10, 40).translate(0, -6.1, -2.2);
  head.add(merged([voice], M.graphite));
  head.add(merged([voiceRim], M.chrome));
  // Ribbon kabeli od mozga do servo čeljusti.
  const ribbons = [];
  for (const sx of [-1, 1]) ribbons.push(cable([V(sx * 2.8, B.c.y - 1.2, B.c.z + 2.4), V(sx * 3.4, -1.6, -8.4), V(sx * 3.4, -4.3, -6.8), V(sx * 3.3, -4.85, -5.8)], 0.11, 36));
  head.add(merged(ribbons, M.braided));

  // ---------------- Poprsje (prostor poprsja, cm) ----------------
  const torso = new THREE.Group();
  torso.name = 'torsoInternals';
  const C = V(...CORE_CENTER);

  // Reaktor: kućište (čaša), radijalni nosači, koncentrični svjetleći prstenovi, jezgra.
  const core = new THREE.Group();
  core.name = 'reactor';
  const cup = [
    [3.5, -1.6], [3.75, -1.2], [3.75, 0.9], [3.46, 1.25], [3.2, 1.25], [3.2, -0.9], [1.1, -1.45], [0, -1.5],
  ].map(([r, z]) => new THREE.Vector2(r, z));
  const housing = new THREE.Mesh(new THREE.LatheGeometry(cup, 72).rotateX(Math.PI / 2).translate(C.x, C.y, C.z), mats.brain);
  housing.castShadow = housing.receiveShadow = true;
  core.add(housing);
  const spokes = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    spokes.push(rod(V(C.x + Math.cos(a) * 1.15, C.y + Math.sin(a) * 1.15, C.z - 0.4), V(C.x + Math.cos(a) * 3.15, C.y + Math.sin(a) * 3.15, C.z - 0.4), 0.1, 8));
  }
  core.add(merged(spokes, M.chrome));
  // Pomični dio (pri rastavljanju se prstenovi razmaknu naprijed).
  const reactorRings = [];
  const ringSpec = [
    [2.75, 0.11, 0.55, 0.5],
    [2.12, 0.095, 0.25, 0.8],
    [1.5, 0.085, -0.05, 1.2],
  ];
  for (const [r, t, z, k] of ringSpec) {
    const m = new THREE.Mesh(new THREE.TorusGeometry(r, t, 12, 72), mats.glow.clone());
    m.position.set(C.x, C.y, C.z + z);
    m.userData.baseZ = C.z + z;
    m.userData.k = k;
    core.add(m);
    reactorRings.push(m);
    glowObjects.push(m);
  }
  const coreSphere = new THREE.Mesh(new THREE.IcosahedronGeometry(0.88, 3), mats.glow.clone());
  coreSphere.position.copy(C).add(V(0, 0, -0.3));
  core.add(coreSphere);
  glowObjects.push(coreSphere);
  // Svjetlo reaktora: scena ga dodaje izvan skrivene grupe (vidi robotScene).
  const coreLight = new THREE.PointLight('#79e6ff', 0, 26, 2);
  coreLight.position.copy(C).add(V(0, 0, 1.2));
  torso.add(core);

  // Kralježnica (straga) i servo motori ramena.
  const spine = [];
  const SPINE = (i) => [-27.7 - i * 2.65, -10.4 + i * 0.1];
  for (let i = 0; i < 6; i++) {
    const [y, z] = SPINE(i);
    spine.push(new THREE.CylinderGeometry(1.25, 1.32, 1.5, 32).translate(0, y, z));
  }
  torso.add(merged(spine, M.graphite));
  const spineRings = [];
  for (let i = 0; i < 6; i++) {
    const [y, z] = SPINE(i);
    spineRings.push(new THREE.TorusGeometry(1.2, 0.07, 8, 40).rotateX(Math.PI / 2).translate(0, y + 0.88, z));
  }
  torso.add(merged(spineRings, M.chrome, { cast: false }));
  const shoulders = [];
  const shoulderGears = [];
  for (const sx of [-1, 1]) {
    shoulders.push(cyl(V(sx * 12.6, -28.2, -7.6), 2.1, 2.4, 'x', 40));
    shoulders.push(cyl(V(sx * 14.0, -28.2, -7.6), 1.2, 0.8, 'x', 32));
    const g = gear(1.95, 0.3, 26);
    g.rotateZ(Math.PI / 2);
    g.translate(sx * 11.25, -28.2, -7.6);
    shoulderGears.push(g);
  }
  torso.add(merged(shoulders, mats.brain));
  torso.add(merged(shoulderGears, M.chrome));

  // Rashladne cijevi: od reaktora prema ramenima i gore prema vratu.
  const tubes = [];
  for (const sx of [-1, 1]) {
    tubes.push(cable([V(C.x + sx * 3.55, C.y + 0.3, C.z - 0.6), V(sx * 6.4, C.y + 0.4, C.z - 1.6), V(sx * 9.4, -28.6, -7.4), V(sx * 11.3, -28.2, -7.6)], 0.34, 40));
    tubes.push(cable([V(C.x + sx * 2.6, C.y - 2.2, C.z - 1.0), V(sx * 3.4, -33.4, -8.0), V(sx * 2.4, -35.6, -9.2), V(sx * 1.0, -36.4, -10.2)], 0.26, 36));
  }
  torso.add(merged(tubes, M.rubber));

  return {
    head,
    torso,
    brain,
    sink,
    reactor: core,
    reactorRings,
    coreSphere,
    coreLight,
    glowObjects,
    glowMaterials: [mats.glow, ...reactorRings.map((r) => r.material), coreSphere.material],
    stripMaterial: mats.glow,
    mats,
  };
}
