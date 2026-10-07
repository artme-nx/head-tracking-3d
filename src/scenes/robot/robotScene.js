// Scena 4 — "Robot": humanoidno poprsje u tamnom studiju iza ekrana.
// Hard-surface glava (SDF paneli s pravim procjepima), mehanički vrat,
// mehaničke oči koje gledaju točno u gledateljeve oči.

import * as THREE from 'three';
import { generateSDF } from '../../geometry/generate.js';
import { EYE_X, EYE_Z, SOCKET_R } from '../../geometry/robotModels.js';
import { loadStudioHDR, buildStudioEnvironment } from '../../render/environment.js';
import { configurePCSSSpot } from '../../render/pcss.js';
import { chromeMaterial } from '../../render/materials.js';
import { createRingTextTexture, loadFonts } from '../../render/proceduralTextures.js';
import { EyeUnit } from './eye.js';
import { GazeController } from './gaze.js';
import { NeckRig } from './neck.js';
import {
  ceramicMaterial,
  carbonMaterial,
  graphiteMaterial,
  anodizedMaterial,
  braidedMaterial,
  lensMaterial,
} from './robotMaterials.js';

const CANDELA = 1e4;
const BG = new THREE.Color('#050506');
const EYE_COLORS = {
  cijan: new THREE.Color('#79e6ff'),
  jantar: new THREE.Color('#ffae42'),
};

// Položaj robota: središte između očiju (cm, prostor prozora) i mjerilo.
const ROBOT = { y: 3.6, z: -64, scale: 0.86 };
const HEAD_PIVOT = new THREE.Vector3(0, -10.4, -6.3);
const NECK_BASE = new THREE.Vector3(0, -21.2, -6.7);

// Panel linije (GLSL, object prostor glave = prostor očiju, cm).
const FACE_PANELS = /* glsl */ `
  vec2 q = vec2( abs( p.x ), p.y );
  float d = 1e3;
  // Luk preko čela.
  d = min( d, abs( p.y - 4.7 + 0.035 * p.x * p.x ) );
  // Linija od vanjskog kuta duplje dijagonalno prema kutu čeljusti.
  vec2 a = vec2( 5.05, -0.6 ), b = vec2( 5.3, -5.4 );
  vec2 pa = q - a, ba = b - a;
  float h = clamp( dot( pa, ba ) / dot( ba, ba ), 0.0, 1.0 );
  d = min( d, length( pa - ba * h ) );
  // Kratka linija ispod duplje (rub "jagodične" ploče).
  a = vec2( 1.6, -2.35 ); b = vec2( 4.6, -2.05 );
  pa = q - a; ba = b - a;
  h = clamp( dot( pa, ba ) / dot( ba, ba ), 0.0, 1.0 );
  d = min( d, length( pa - ba * h ) );
  return d;
`;
const CRANIUM_PANELS = /* glsl */ `
  float d = 1e3;
  // Pojas preko sljepoočnice (iznad uha), lagano se spušta prema zatiljku.
  d = min( d, abs( p.y - 3.1 + 0.08 * ( p.z + 7.0 ) ) );
  // Okomita linija iza uha (samo ispod pojasa).
  d = min( d, abs( p.z + 10.6 + 0.1 * p.y ) + max( 0.0, p.y - 2.8 ) );
  return d;
`;
const CHEST_PANELS = /* glsl */ `
  vec2 q = vec2( abs( p.x ), p.y );
  // Prsna kost.
  float d = abs( p.x ) + max( 0.0, -p.y - 38.0 );
  // Donji rub prsnih ploča (luk prema rebrima).
  d = min( d, abs( p.y + 31.5 - 0.035 * p.x * p.x ) + max( 0.0, abs( p.x ) - 10.5 ) );
  // Dijagonala od ključne kosti prema pazuhu.
  vec2 a = vec2( 3.2, -24.4 ), b = vec2( 10.8, -28.6 );
  vec2 pa = q - a, ba = b - a;
  float h = clamp( dot( pa, ba ) / dot( ba, ba ), 0.0, 1.0 );
  d = min( d, length( pa - ba * h ) );
  // Ventilacijski utori ispod ključne kosti (kratke vodoravne crtice).
  float slot = 1e3;
  for ( int i = 0; i < 4; i ++ ) {
    float yy = -25.6 - float( i ) * 0.55;
    slot = min( slot, abs( p.y - yy ) + max( 0.0, abs( q.x - 6.2 ) - 1.1 ) );
  }
  d = min( d, slot );
  return d;
`;

export class RobotScene {
  constructor(renderer) {
    this.name = 'Robot';
    this.usesPost = true;
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.display = new THREE.Group();
    this.group.add(this.display);
    this.eyeColorName = 'cijan';
    this.eyeColor = EYE_COLORS.cijan.clone();
    this.targetEyeColor = EYE_COLORS.cijan.clone();
    this.gaze = new GazeController();
    this.time = 0;
    this.custom = null;
    this.customEyeOffset = 0;
  }

  init() {
    if (!this.ready) this.ready = this.#build();
    return this.ready;
  }

  /** Pokreni teške korake (HDR, generiranje geometrije) unaprijed u pozadini. */
  preload() {
    generateSDF('robotHead', {});
    generateSDF('robotBody', {});
    loadStudioHDR();
  }

  async #build() {
    const [hdr, head, body, ringText] = await Promise.all([
      loadStudioHDR(),
      generateSDF('robotHead', {}),
      generateSDF('robotBody', {}),
      createRingTextTexture('ARGUS · 7 · 1:1.2 · 35mm · ∞ · AURELIAN OPTICS · '),
      loadFonts(),
    ]);

    this.env = buildStudioEnvironment(this.renderer, hdr, {
      exposure: 0.16,
      floorLevel: 0.03,
      rotation: 2.4,
      strips: [
        // Softbox lijevo (key) → meki odsjaj na keramici.
        { dir: [-0.86, 0.42, 0.28], size: [30, 26], intensity: 4.5, softness: 0.6 },
        // Uske trake iza → rubno svjetlo na siluetama.
        { dir: [-0.72, 0.3, -0.62], size: [8, 70], intensity: 14, softness: 0.3 },
        { dir: [0.78, 0.18, -0.6], size: [7, 64], intensity: 11, softness: 0.3 },
        // Hladni fill zdesna (slab).
        { dir: [0.9, 0.05, 0.42], size: [20, 44], intensity: 0.6, color: '#cfe0ff', softness: 0.7 },
        // Topli kicker odozdo.
        { dir: [0.0, -0.7, 0.7], size: [50, 12], intensity: 0.4, color: '#ffd2a8', softness: 0.6 },
      ],
    });
    this.darkEnv = buildStudioEnvironment(this.renderer, hdr, { exposure: 0.03, floorLevel: 0.2, rotation: 2.4 });

    this.#buildMaterials(ringText);
    this.#buildRig(head, body);
    this.#buildStudio();
    this.#buildLights();
  }

  #buildMaterials(ringText) {
    this.ringText = ringText;
    const M = {};
    M.graphite = graphiteMaterial('#141518');
    M.socket = graphiteMaterial('#121316');
    M.socket.roughness = 0.5;
    M.anodized = anodizedMaterial('#3e4c5c');
    M.chrome = chromeMaterial();
    M.barrel = new THREE.MeshPhysicalMaterial({ color: '#141518', metalness: 0.9, roughness: 0.28, envMapIntensity: 1.2 });
    M.interior = new THREE.MeshStandardMaterial({ color: '#030304', roughness: 0.9, metalness: 0.2 });
    M.interiorLit = new THREE.MeshStandardMaterial({ color: '#2a2e33', roughness: 0.4, metalness: 0.8 });
    M.blade = new THREE.MeshPhysicalMaterial({
      color: '#15171b',
      metalness: 0.95,
      roughness: 0.32,
      iridescence: 0.45,
      iridescenceIOR: 1.6,
      iridescenceThicknessRange: [300, 600],
      side: THREE.DoubleSide,
      envMapIntensity: 1.3,
    });
    M.lens = lensMaterial();
    M.braided = braidedMaterial('#17181b');
    M.rubber = new THREE.MeshPhysicalMaterial({ color: '#101113', roughness: 0.7, metalness: 0, specularIntensity: 0.25 });
    M.carbon = carbonMaterial({ scale: 0.32 });
    // Kapci: ista glazirana keramika kao lice, s obje strane.
    M.lid = ceramicMaterial({ color: '#cfccc6', key: 'ceramicLid', panelGLSL: 'return 1e3;' });
    M.lid.side = THREE.DoubleSide;
    M.skull = graphiteMaterial('#0d0e10');
    M.skull.roughness = 0.6;
    this.M = M;
  }

  #buildRig(head, body) {
    const M = this.M;
    // Prostor poprsja (koordinate očiju, ljudsko mjerilo) → skaliran u prozor.
    this.root = new THREE.Group();
    this.root.scale.setScalar(ROBOT.scale);
    this.root.position.set(0, ROBOT.y, ROBOT.z);
    this.display.add(this.root);

    // Poprsje (diše).
    this.torso = new THREE.Group();
    this.root.add(this.torso);
    const atlas = this.decalAtlasSync();
    const rowRect = (i, w = 1) => [0, 1 - (64 * (i + 1)) / 512, w, 1 - (64 * i) / 512];
    M.ceramicBody = ceramicMaterial({
      panelGLSL: CHEST_PANELS,
      atlas,
      key: 'ceramicBody',
      decals: [
        { center: [-4.6, -27.3, 1.9], normal: [-0.1, 0.25, 1], up: [0, 1, 0], size: [4.4, 0.58], rect: rowRect(0, 0.55), color: '#25272b' },
        { center: [-4.7, -28.05, 1.8], normal: [-0.1, 0.25, 1], up: [0, 1, 0], size: [4.4, 0.4], rect: rowRect(1, 0.62), color: '#4a4d52' },
      ],
    });
    M.ceramicDark = ceramicMaterial({ color: '#1e2024', key: 'ceramicDark', panelGLSL: 'return 1e3;' });
    M.ceramicDark.clearcoat = 0.22;
    M.ceramicDark.clearcoatRoughness = 0.3;
    M.ceramicDark.roughness = 0.58;
    M.ceramicDark.color.set('#17181b');
    const bodyMats = { chest: M.ceramicBody, shoulders: M.ceramicDark, trapezius: M.carbon, core: M.skull };
    for (const [name, geo] of Object.entries(body)) {
      const mesh = new THREE.Mesh(geo, bodyMats[name] ?? M.graphite);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.torso.add(mesh);
    }
    // Ključne kosti: titanijske šipke od prsne kosti prema ramenima.
    for (const sx of [-1, 1]) {
      const a = new THREE.Vector3(sx * 1.6, -23.2, -1.2);
      const b = new THREE.Vector3(sx * 11.8, -23.6, -4.6);
      const len = a.distanceTo(b);
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, len, 24), M.anodized);
      bar.position.copy(a).add(b).multiplyScalar(0.5);
      bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      bar.castShadow = true;
      this.torso.add(bar);
    }
    // Statusni LED prsten na prsnoj kosti.
    this.leds = [];
    const ledRing = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.06, 12, 48), new THREE.MeshBasicMaterial({ toneMapped: false }));
    ledRing.position.set(0, -26.1, 1.2);
    ledRing.rotation.x = -0.25;
    this.torso.add(ledRing);
    this.leds.push([ledRing, 3]);

    // Zglobovi: vrat → glava.
    this.neckJoint = new THREE.Group();
    this.neckJoint.position.copy(NECK_BASE);
    this.root.add(this.neckJoint);
    this.headJoint = new THREE.Group();
    this.headJoint.position.copy(HEAD_PIVOT).sub(NECK_BASE);
    this.neckJoint.add(this.headJoint);
    this.headContent = new THREE.Group();
    this.headContent.position.copy(HEAD_PIVOT).multiplyScalar(-1);
    this.headJoint.add(this.headContent);

    // Proceduralna glava.
    this.procHead = new THREE.Group();
    this.headContent.add(this.procHead);
    M.ceramicFace = ceramicMaterial({
      panelGLSL: FACE_PANELS,
      atlas,
      key: 'ceramicFace',
      decals: [],
    });
    // Lubanja: tamna sjajna keramika (bijela maska lica ističe se na tamnoj glavi).
    M.ceramicCranium = ceramicMaterial({
      color: '#202226',
      panelGLSL: CRANIUM_PANELS,
      atlas,
      key: 'ceramicCranium',
      decals: [
        { center: [-6.9, 3.4, -6.2], normal: [-1, 0.15, 0.1], up: [0, 1, 0], size: [2.6, 0.9], rect: rowRect(3, 0.16), color: '#8d939b' },
        { center: [6.9, 3.4, -6.2], normal: [1, 0.15, 0.1], up: [0, 1, 0], size: [2.6, 0.9], rect: rowRect(4, 0.16), color: '#8d939b' },
        { center: [-6.0, -4.6, -9.6], normal: [-1, -0.2, -0.3], up: [0, 1, 0], size: [5.0, 0.55], rect: rowRect(2, 0.6), color: '#c4562f' },
      ],
    });
    M.ceramicCranium.clearcoat = 0.22;
    M.ceramicCranium.clearcoatRoughness = 0.3;
    M.ceramicCranium.roughness = 0.58;
    M.ceramicCranium.color.set('#17181b');
    M.titanium = new THREE.MeshPhysicalMaterial({ color: '#8c939c', metalness: 1, roughness: 0.26, envMapIntensity: 1.1 });
    const headMats = { face: M.ceramicFace, jaw: M.ceramicFace, cranium: M.ceramicCranium, crest: M.titanium, skull: M.skull };
    for (const [name, geo] of Object.entries(head)) {
      const mesh = new THREE.Mesh(geo, headMats[name] ?? M.graphite);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.procHead.add(mesh);
    }
    this.#buildEars(this.procHead);
    this.#buildTempleMechanics(this.procHead);

    // Oči.
    this.eyes = [];
    for (const sx of [-1, 1]) {
      const eye = new EyeUnit({ materials: M, ringText: this.ringText, side: sx });
      eye.root.position.set(sx * EYE_X, 0.05, EYE_Z);
      eye.root.scale.setScalar(0.82);
      eye.setColor(this.eyeColor);
      this.headContent.add(eye.root);
      this.eyes.push(eye);
    }

    this.neck = new NeckRig({ root: this.root, head: this.headContent, mats: M });
  }

  decalAtlasSync() {
    // Atlas se crta sinkrono (fontovi su već učitani u init()).
    if (!this.decalAtlas) {
      const c = document.createElement('canvas');
      c.width = 1024;
      c.height = 512;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.textBaseline = 'middle';
      const row = (i, text, font, spacing) => {
        g.font = font;
        if ('letterSpacing' in g) g.letterSpacing = spacing;
        g.fillText(text, 12, 64 * i + 32);
      };
      row(0, 'NX-07  AURELIAN', '600 46px "Barlow Condensed", sans-serif', '10px');
      row(1, 'SN 4471-0926-A  ·  CAL 08/26', '500 36px "Barlow Condensed", sans-serif', '4px');
      row(2, '▲ SERVO 3  ·  NE OTVARATI', '600 36px "Barlow Condensed", sans-serif', '5px');
      row(3, 'L-07', '600 52px "Barlow Condensed", sans-serif', '8px');
      row(4, 'R-07', '600 52px "Barlow Condensed", sans-serif', '8px');
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      this.decalAtlas = t;
    }
    return this.decalAtlas;
  }

  /** Kromirane "tetive" i mali aktuatori u procjepu na sljepoočnicama. */
  #buildTempleMechanics(parent) {
    const M = this.M;
    for (const sx of [-1, 1]) {
      const rods = [
        [[5.55, 2.6, -1.7], [6.2, -2.6, -3.2], 0.11],
        [[5.85, 2.2, -2.6], [6.45, -2.2, -4.2], 0.09],
        [[5.2, 3.0, -0.9], [5.7, -3.4, -2.0], 0.08],
      ];
      for (const [a, b, r] of rods) {
        const A = new THREE.Vector3(sx * a[0], a[1], a[2]);
        const B = new THREE.Vector3(sx * b[0], b[1], b[2]);
        const len = A.distanceTo(B);
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 16), M.chrome);
        rod.position.copy(A).add(B).multiplyScalar(0.5);
        rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
        rod.castShadow = true;
        parent.add(rod);
        for (const P of [A, B]) {
          const knuckle = new THREE.Mesh(new THREE.SphereGeometry(r * 2.1, 16, 10), M.graphite);
          knuckle.position.copy(P);
          parent.add(knuckle);
        }
      }
    }
  }

  #buildEars(parent) {
    const M = this.M;
    this.earRotors = [];
    for (const sx of [-1, 1]) {
      const ear = new THREE.Group();
      ear.position.set(sx * 7.05, -0.9, -6.9);
      ear.rotation.z = sx * -Math.PI / 2; // os cilindra duž x
      ear.scale.setScalar(0.72);
      const housing = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.7, 1.1, 64), M.anodized);
      const face = new THREE.Mesh(new THREE.CylinderGeometry(2.15, 2.15, 1.16, 64), M.graphite);
      const hub = new THREE.Mesh(new THREE.SphereGeometry(0.75, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), M.chrome);
      hub.position.y = 0.58;
      hub.scale.y = 0.45;
      const rotor = new THREE.Group();
      // Radijalni ventilacijski utori na rotoru.
      const vents = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 0.08, 1.05), M.skull, 16);
      const m4 = new THREE.Matrix4();
      for (let i = 0; i < 16; i++) {
        m4.makeRotationY((i / 16) * Math.PI * 2).multiply(new THREE.Matrix4().makeTranslation(0, 0.6, 1.45));
        vents.setMatrixAt(i, m4);
      }
      rotor.add(vents);
      const led = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.035, 8, 64).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ toneMapped: false }));
      led.position.y = 0.6;
      this.leds.push([led, 1.6]);
      const screws = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.11, 0.11, 0.08, 6), M.chrome, 6);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        m4.makeTranslation(Math.cos(a) * 2.35, 0.57, Math.sin(a) * 2.35);
        screws.setMatrixAt(i, m4);
      }
      for (const m of [housing, face, hub]) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
      ear.add(housing, face, hub, rotor, led, screws);
      parent.add(ear);
      this.earRotors.push(rotor);
    }
  }

  #buildStudio() {
    // Tamna pozadina studija (bešavni papir), daleko iza robota.
    const backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(600, 360),
      new THREE.MeshStandardMaterial({ color: '#16171a', roughness: 0.95, metalness: 0, envMapIntensity: 0.4 }),
    );
    backdrop.position.set(0, 0, -190);
    this.display.add(backdrop);
    this.backdrop = backdrop;
  }

  #buildLights() {
    const head = new THREE.Vector3(0, ROBOT.y, ROBOT.z);
    this.headWorld = head;
    // Key: lijevo-gore-sprijeda, meke PCSS sjene.
    this.key = new THREE.SpotLight('#fff3e6', 6.5 * CANDELA, 0, THREE.MathUtils.degToRad(24), 0.85, 2);
    this.key.position.set(-58, 34, -36);
    this.key.target.position.copy(head).add(new THREE.Vector3(0, -6, 0));
    configurePCSSSpot(this.key, 9, 2048);
    this.display.add(this.key, this.key.target);
    // Fill: hladni, desno, slab.
    this.fill = new THREE.SpotLight('#cfe0ff', 0.45 * CANDELA, 0, THREE.MathUtils.degToRad(40), 1, 2);
    this.fill.position.set(48, 4, -14);
    this.fill.target.position.copy(head).add(new THREE.Vector3(0, -6, 0));
    this.display.add(this.fill, this.fill.target);
    // Rim lijevo-iza (s haze snopom i sjenom) i desno-iza.
    this.rimL = new THREE.SpotLight('#dfe8ff', 15 * CANDELA, 0, THREE.MathUtils.degToRad(13), 0.5, 2);
    this.rimL.position.set(-30, 34, -132);
    this.rimL.target.position.copy(head).add(new THREE.Vector3(2, -6, 4));
    configurePCSSSpot(this.rimL, 6, 1024);
    this.rimL.shadow.radius = 0; // samo za volumetriju i grube obrise — bez PCSS cijene
    this.display.add(this.rimL, this.rimL.target);
    this.rimR = new THREE.SpotLight('#fff0e0', 10 * CANDELA, 0, THREE.MathUtils.degToRad(20), 0.6, 2);
    this.rimR.position.set(34, 16, -130);
    this.rimR.target.position.copy(head).add(new THREE.Vector3(-2, -6, 4));
    this.display.add(this.rimR, this.rimR.target);
    // Svjetlo na pozadini (meki krug iza glave — odvaja siluetu).
    this.bgLight = new THREE.SpotLight('#9fb4d6', 5 * CANDELA, 0, THREE.MathUtils.degToRad(30), 1, 2);
    this.bgLight.position.set(0, 40, -100);
    this.bgLight.target.position.set(0, -4, -190);
    this.display.add(this.bgLight, this.bgLight.target);

    this.hemi = new THREE.HemisphereLight('#20242b', '#08080a', 0.08);
    this.display.add(this.hemi);
    this.scaledLights = [this.key, this.fill, this.rimL, this.rimR, this.bgLight].map((l) => [l, l.intensity]);
  }

  activate(scene, ctx) {
    scene.background = BG;
    scene.environment = this.darkEnv;
    scene.environmentIntensity = 1;
    // Keramika, krom i karbon dobivaju studijske trake u refleksijama; tamni metali,
    // unutrašnjost oka i staklo rožnice tamnu okolinu (inače "posijede").
    const M = this.M;
    const dark = new Set([M.graphite, M.socket, M.barrel, M.interior, M.interiorLit, M.lens, M.skull, M.rubber, M.braided, M.anodized, M.ceramicCranium, M.ceramicDark]);
    this.root.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        if (!m.isMeshStandardMaterial) continue;
        const isDark = dark.has(m) || m.userData.darkEnv;
        m.envMap = isDark ? this.darkEnv : this.env;
        if (m === M.ceramicFace || m === M.ceramicBody || m === M.lid) m.envMapIntensity = 0.38;
        if (m === M.ceramicCranium || m === M.ceramicDark) m.envMapIntensity = 1.4;
      }
    });
    for (const eye of this.eyes) eye.bladeMat.envMap = this.env;
    ctx.post.configure({
      toneMapping: 'AGX',
      exposure: 1.0,
      bloom: { intensity: 1.35, threshold: 0.75, smoothing: 0.3, radius: 0.62 },
      ao: { aoRadius: 2.2, distanceFalloff: 1.0, intensity: 2.6 },
      vignette: { darkness: 0.62, offset: 0.26 },
      grain: 0.07,
      volumetric: {
        light: this.rimL,
        density: 0.0001,
        ambientDensity: 0.00004,
        noiseScale: 0.02,
        noiseAmount: 0.9,
        g: 0.55,
        // Snop završava na robotu (inače bi haze ispred poprsja stvorio sivi veo).
        range: 86,
        intensity: 1,
        lightScale: 1,
      },
      bloomSelection: this.#bloomObjects(),
    });
    this.post = ctx.post;
  }

  #bloomObjects() {
    const list = [];
    for (const eye of this.eyes) list.push(...eye.emissiveObjects);
    for (const [led] of this.leds) list.push(led);
    return list;
  }

  layout(rect) {
    const s = THREE.MathUtils.clamp(rect.height / 18.8, 0.75, 2.4);
    this.display.scale.setScalar(s);
    this.displayScale = s;
    for (const [light, base] of this.scaledLights ?? []) light.intensity = base * s * s;
  }

  setQuality(q) {
    this.key.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    this.key.shadow.map?.dispose();
    this.key.shadow.map = null;
  }

  setSize() {}

  toggleEyeColor() {
    this.eyeColorName = this.eyeColorName === 'cijan' ? 'jantar' : 'cijan';
    this.targetEyeColor.copy(EYE_COLORS[this.eyeColorName]);
    return this.eyeColorName === 'cijan' ? 'ledeno cijan' : 'jantarna';
  }

  update(t, dt, ctx) {
    if (!this.root) return;
    this.time += dt;
    const T = this.time;

    // Gledatelj u prostoru poprsja.
    this.root.updateMatrixWorld();
    const viewerWorld = new THREE.Vector3(...ctx.eye);
    this.group.parent?.updateMatrixWorld();
    const viewerLocal = this.root.worldToLocal(viewerWorld.clone());
    const yaw = Math.atan2(viewerLocal.x, viewerLocal.z);
    const pitch = Math.atan2(viewerLocal.y, Math.hypot(viewerLocal.x, viewerLocal.z));
    const g = this.gaze.update(dt, ctx.eye[2], new THREE.Vector2(yaw, pitch));

    // Disanje + glava/vrat s inercijom.
    const breath = Math.sin(T * (Math.PI * 2 / 4.6));
    this.torso.position.y = breath * 0.12;
    this.torso.scale.set(1 + breath * 0.004, 1 + breath * 0.006, 1 + breath * 0.008);
    this.neckJoint.position.y = NECK_BASE.y + breath * 0.1;
    this.neckJoint.rotation.set(-g.neck.y, g.neck.x, 0, 'YXZ');
    this.headJoint.rotation.set(-(g.head.y - g.neck.y) + breath * 0.004, g.head.x - g.neck.x, Math.sin(T * 0.21) * 0.01, 'YXZ');

    // Oči: točno prema gledatelju (+ sakade u ravnini njegova lica).
    const target = viewerWorld.clone().add(new THREE.Vector3(g.offset.x, g.offset.y, 0));
    this.root.updateMatrixWorld(true);
    this.eyeColor.lerp(this.targetEyeColor, 1 - Math.exp(-dt * 6));
    const pulse = 0.5 * Math.sin(T * 2.6) + 0.18 * Math.sin(T * 7.3 + 1.2);
    for (const eye of this.eyes) {
      const local = eye.root.worldToLocal(target.clone());
      const ey = Math.atan2(local.x, local.z);
      const ep = Math.atan2(local.y, Math.hypot(local.x, local.z));
      eye.gimbal.rotation.set(
        -THREE.MathUtils.clamp(ep, -0.5, 0.5),
        THREE.MathUtils.clamp(ey, -0.62, 0.62),
        0,
        'YXZ',
      );
      eye.setColor(this.eyeColor);
      eye.setAperture(g.aperture);
      eye.setBlink(g.blink);
      eye.setIntensity(g.brightness, pulse);
    }
    for (const [led, k] of this.leds) led.material.color.copy(this.eyeColor).multiplyScalar(k * (0.75 + 0.25 * Math.sin(T * 1.7)));
    for (const [i, r] of this.earRotors.entries()) r.rotation.y = T * (i ? -0.35 : 0.35);
    this.neck.update();
  }

  beforeRender() {
    for (const eye of this.eyes ?? []) eye.updateMatrices();
    if (this.socketUniforms) {
      this.headContent.updateMatrixWorld();
      this.socketUniforms.headInverse.value.copy(this.headContent.matrixWorld).invert();
    }
  }

  // --- Vlastiti .glb kao glava (dobiva iste oči) ---------------------------

  setCustomHead(wrapper) {
    if (this.custom) {
      this.headContent.remove(this.custom.group);
    }
    const inner = wrapper.userData?.inner ?? wrapper;
    const group = new THREE.Group();
    group.add(inner);
    inner.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(inner);
    const size = box.getSize(new THREE.Vector3());

    // Heuristika: vrh nosa = najisturenija točka (+z) u gornjih 60 % modela, blizu sredine.
    let nose = null;
    const v = new THREE.Vector3();
    inner.traverse((o) => {
      if (!o.isMesh) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i += 3) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        if (v.y < box.min.y + size.y * 0.35 || Math.abs(v.x - (box.min.x + box.max.x) / 2) > size.x * 0.12) continue;
        if (!nose || v.z > nose.z) nose = v.clone();
      }
    });
    if (!nose) nose = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y + size.y * 0.6, box.max.z);
    // Širina glave u visini nosa.
    let minX = Infinity, maxX = -Infinity;
    inner.traverse((o) => {
      if (!o.isMesh) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i += 2) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        if (Math.abs(v.y - nose.y) > size.y * 0.04) continue;
        minX = Math.min(minX, v.x);
        maxX = Math.max(maxX, v.x);
      }
    });
    const width = Number.isFinite(minX) ? maxX - minX : size.x;
    const scale = 14.6 / width;
    // Linija očiju: ~23 % puta od vrha nosa do tjemena (stabilnije od omjera širine,
    // koja u visini nosa često uključuje i uši).
    const crown = box.max.y;
    const eyeMid = new THREE.Vector3((minX + maxX) / 2, nose.y + (crown - nose.y) * 0.23, nose.z);
    // Površina lica ispred očiju (raycast odsprijeda).
    const ray = new THREE.Raycaster(new THREE.Vector3(eyeMid.x + width * 0.21, eyeMid.y, box.max.z + 10), new THREE.Vector3(0, 0, -1));
    const hit = ray.intersectObject(inner, true)[0];
    const surfaceZ = hit ? hit.point.z : nose.z - width * 0.18;

    inner.position.sub(new THREE.Vector3(eyeMid.x, eyeMid.y, surfaceZ));
    group.scale.setScalar(scale);
    group.position.set(0, 0, 0.35);
    this.custom = { group, inner, scale, baseY: 0 };
    this.customEyeOffset = 0;
    this.#applySocketCut(inner);
    this.procHead.visible = false;
    this.headContent.add(group);
    group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m.isMeshStandardMaterial) m.envMap = this.env;
      }
    });
  }

  #applySocketCut(root) {
    // Na mjestu očiju model dobiva rupe (duplje), oči sjede iza njih.
    this.socketUniforms ??= { headInverse: { value: new THREE.Matrix4() } };
    root.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        m.onBeforeCompile = (shader) => {
          shader.uniforms.headInverse = this.socketUniforms.headInverse;
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nuniform mat4 headInverse;\nvarying vec3 vHeadLocal;')
            .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvHeadLocal = ( headInverse * modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vHeadLocal;')
            .replace(
              '#include <clipping_planes_fragment>',
              `#include <clipping_planes_fragment>
              {
                vec2 dl = vHeadLocal.xy - vec2( -${EYE_X.toFixed(2)}, 0.05 );
                vec2 dr = vHeadLocal.xy - vec2( ${EYE_X.toFixed(2)}, 0.05 );
                if ( vHeadLocal.z > ${(EYE_Z - 0.5).toFixed(2)} && min( length( dl ), length( dr ) ) < ${(SOCKET_R * 0.86).toFixed(2)} ) discard;
              }`,
            );
        };
        m.customProgramCacheKey = () => 'socketCut';
        m.needsUpdate = true;
      }
    });
  }

  flipCustomHead() {
    if (!this.custom) return;
    this.custom.group.rotation.y += Math.PI;
  }

  scaleCustomHead(f) {
    if (!this.custom) return;
    this.custom.group.scale.multiplyScalar(f);
  }

  nudgeEyes(dy) {
    if (!this.custom) return;
    this.custom.group.position.y -= dy;
  }
}
