// Ekran kao prozor — head-coupled perspective s praćenjem glave web kamerom.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { loadSettings } from './config.js';
import { VisionSource } from './tracking/vision.js';
import { HeadTracker } from './tracking/headTracker.js';
import { HandTracker } from './tracking/handTracker.js';
import { MouseHead } from './tracking/mouseHead.js';
import { MouseHand } from './tracking/mouseHand.js';
import { HandInput } from './interaction/handInput.js';
import { FingerMarkers } from './interaction/fingerMarker.js';
import { DirectorFrame } from './interaction/directorFrame.js';
import { applyOffAxis } from './projection/offAxis.js';
import { getCanvasRect } from './projection/screenRect.js';
import { AnaglyphRenderer } from './render/anaglyph.js';
import { installPCSS } from './render/pcss.js';
import { PostPipeline, QUALITY } from './render/postPipeline.js';
import { GpuProfiler } from './render/gpuProfiler.js';
import { BoxScene } from './scenes/boxScene.js';
import { ModelScene } from './scenes/modelScene.js';
import { MuseumScene } from './scenes/museum/museumScene.js';
import { RobotScene } from './scenes/robot/robotScene.js';
import { classifyFiles, loadDefaultHead, loadMeshFiles, loadSplatFile } from './scenes/loaders.js';
import { DebugOverlay } from './ui/debugOverlay.js';
import { CalibrationPanel } from './ui/calibrationPanel.js';
import { OrbitPanel } from './ui/orbitPanel.js';
import { OrbitController, loadOrbitSettings } from './camera/orbitController.js';
import { Hud } from './ui/hud.js';
import { setupDropzone } from './ui/dropzone.js';
import './style.css';

const REST_DISTANCE = 60; // cm — kamo se pogled vraća kad se lice izgubi
const NEAR = 0.5;
const FAR = 2000;

const settings = loadSettings();
const orbitSettings = loadOrbitSettings();
installPCSS();

// Način kamere po sceni: 'window' (fizički točna off-axis projekcija) ili 'orbit'.
// ORBIT je zadan za Vitrinu i Robota; Kutija podržava samo window.
const CAMERA_MODES_KEY = 'head-tracking-3d:cameraModes:v1';
let cameraModes = { 0: 'window', 1: 'window', 2: 'orbit', 3: 'orbit' };
try {
  const saved = JSON.parse(localStorage.getItem(CAMERA_MODES_KEY) ?? 'null');
  if (saved) cameraModes = { ...cameraModes, ...saved, 0: 'window' };
} catch {
  /* bez pohrane */
}
// Ponašanje pogleda robota (G): 1 = prati do ±25°, 2 = oči uvijek prate, 3 = glava i oči prate.
const gazeModes = { orbit: 1, window: 3 };

const QUALITY_KEY = 'head-tracking-3d:quality';
let quality = 'high';
try {
  if (localStorage.getItem(QUALITY_KEY) === 'low') quality = 'low';
} catch {
  /* bez pohrane */
}

// ---------- Renderer ----------
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.info.autoReset = false;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
const defaultEnvironment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = defaultEnvironment;
pmrem.dispose();

// Sve scene su građene oko ishodišta; "world" se pomiče na centar prozora.
const world = new THREE.Group();
scene.add(world);

const camMono = new THREE.PerspectiveCamera();
const camLeft = new THREE.PerspectiveCamera();
const camRight = new THREE.PerspectiveCamera();
const anaglyph = new AnaglyphRenderer(renderer);
const profiler = new GpuProfiler(renderer.getContext());

// Postprocessing (N8AO, volumetrija, bloom, SMAA…) — samo za scene 3 i 4.
let post = null;
function getPost() {
  if (!post) {
    post = new PostPipeline(renderer, scene, camMono);
    post.setQuality(quality);
    for (const [name, pass] of Object.entries({
      render: post.renderPass,
      n8ao: post.n8ao,
      volumetric: post.volumetric,
      bloomTone: post.gradePass,
      smaaGrain: post.finishPass,
      output: post.output,
    })) profiler.wrap(pass, 'render', name);
    post.setSize(window.innerWidth, window.innerHeight);
  }
  return post;
}

// ?dpr=2 — samo za testiranje (emulacija retina zaslona u headless pregledniku).
const forcedDpr = Number(new URLSearchParams(location.search).get('dpr')) || 0;

// Dinamička rezolucija (kao u igrama): AAA scene drže 60 fps tako da pri
// preopterećenju malo spuste render scale, a kad ima rezerve vrate ga gore.
const adaptive = { ratio: null, frames: [], lastChange: 0, lastProbe: 0 };

function targetPixelRatio() {
  const device = forcedDpr || window.devicePixelRatio;
  if (!active?.usesPost) return Math.min(device, 2);
  const q = QUALITY[quality];
  const cap = Math.min(device, q.pixelRatio);
  if (adaptive.ratio === null) adaptive.ratio = cap;
  adaptive.ratio = Math.min(cap, Math.max(Math.min(minRatio(), cap), adaptive.ratio));
  return adaptive.ratio;
}

// U anaglifu se cijeli pipeline crta dvaput, pa smije niže.
function minRatio() {
  const q = QUALITY[quality];
  return stereo ? Math.min(q.minPixelRatio, 0.9) : q.minPixelRatio;
}

function applyPixelRatio() {
  renderer.setPixelRatio(targetPixelRatio());
}

function adaptResolution(now, frameMs) {
  if (!active?.usesPost || forcedDpr) return;
  const f = adaptive.frames;
  f.push(frameMs);
  if (f.length > 90) f.shift();
  if (now - adaptive.lastChange < 1500 || f.length < 60) return;
  const avg = f.reduce((a, b) => a + b, 0) / f.length;
  const q = QUALITY[quality];
  const cap = Math.min(window.devicePixelRatio, q.pixelRatio);
  let next = adaptive.ratio;
  // Detekcija (lice/ruke) u workeru dijeli GPU s renderom: ako gladuje, render
  // spušta rezoluciju iako sam stiže 60 fps. Proba naviše čeka sve dulje ako je
  // prethodna proba izgladnjela detekciju (bez titranja rezolucije).
  const starved = vision.starved;
  if (avg > 18.2 || starved) {
    next = adaptive.ratio - 0.125;
    if (starved && now - adaptive.lastProbe < 4000) adaptive.backoff = Math.min(60000, (adaptive.backoff ?? 8000) * 2);
  } else if (avg < 17.4 && adaptive.ratio < cap && vision.healthy && now - adaptive.lastProbe > (adaptive.backoff ?? 8000)) {
    next = adaptive.ratio + 0.125;
    adaptive.lastProbe = now;
  }
  next = Math.min(cap, Math.max(Math.min(minRatio(), cap), next));
  if (next !== adaptive.ratio) {
    adaptive.ratio = next;
    adaptive.lastChange = now;
    adaptive.frames.length = 0;
    resize();
  }
}

function resize() {
  applyPixelRatio();
  renderer.setSize(window.innerWidth, window.innerHeight);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  anaglyph.setSize(size.x, size.y);
  post?.setSize(window.innerWidth, window.innerHeight);
  for (const p of presets) p.setSize?.(size.x, size.y);
}
window.addEventListener('resize', resize);

// ---------- Scene ----------
const presets = [new BoxScene(), new ModelScene(), new MuseumScene(renderer), new RobotScene(renderer)];
let active = null;
let laidOut = { w: 0, h: 0 };
let pendingPreset = null;
let compiling = false; // dok se shaderi nove scene kompajliraju paralelno, ne crtamo

async function setPreset(index) {
  const next = presets[index];
  if (!next || next === active) return;
  if (next.init && !next.isReady) {
    pendingPreset = index;
    hud.toast(`Pripremam scenu ${index + 1}: ${next.name}…`, 60000);
    try {
      await next.init();
      next.isReady = true;
    } catch (err) {
      console.error(err);
      hud.toast(`Scena ${index + 1} se nije mogla pripremiti: ${err.message ?? err}`, 6000);
      pendingPreset = null;
      return;
    }
    if (pendingPreset !== index) return; // korisnik je u međuvremenu odabrao drugu scenu
  }
  pendingPreset = null;
  switchTo(next, index);
}

function switchTo(next, index) {
  if (active) {
    world.remove(active.group);
    active.deactivate?.();
  }
  director.reset(true); // izrez kadra pripada sceni
  active = next;
  world.add(active.group);

  // Globalno stanje vraća se na zadano; scena ga zatim prilagođava.
  scene.environment = defaultEnvironment;
  scene.environmentIntensity = 1;
  scene.environmentRotation.set(0, 0, 0);
  scene.fog = null;
  const usesPost = !!active.usesPost;
  renderer.toneMapping = usesPost ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  const shadowType = usesPost ? THREE.BasicShadowMap : THREE.PCFShadowMap;
  if (renderer.shadowMap.type !== shadowType) {
    renderer.shadowMap.type = shadowType;
    scene.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) m.needsUpdate = true;
    });
  }
  renderer.shadowMap.autoUpdate = !usesPost;
  resize();
  active.activate(scene, { post: usesPost ? getPost() : null, renderer });
  if (usesPost) active.setQuality?.(QUALITY[quality]);
  laidOut = { w: 0, h: 0 }; // forsiraj layout za novu scenu
  hud.toast(`Scena ${index + 1}: ${active.name}`, 1400);
  if (active.orbitTarget) hud.badge(cameraMode() === 'orbit' ? 'ORBIT' : 'WINDOW');
  // AAA scene imaju puno materijala: kompajliraj ih paralelno (KHR_parallel_shader_compile)
  // umjesto da prvi frame zamrzne praćenje glave.
  if (usesPost && !active.compiled) {
    compiling = true;
    const done = () => {
      compiling = false;
      active.compiled = true;
    };
    renderer.compileAsync(scene, camMono).then(done, done);
  }
}

function setQuality(name) {
  quality = name;
  adaptive.ratio = null;
  try {
    localStorage.setItem(QUALITY_KEY, name);
  } catch {
    /* bez pohrane */
  }
  post?.setQuality(name);
  for (const p of presets) if (p.isReady) p.setQuality?.(QUALITY[name]);
  resize();
  hud.toast(`Kvaliteta: ${name === 'high' ? 'visoka' : 'niska'}`, 1400);
}

loadDefaultHead()
  .then((head) => presets[1].content ?? presets[1].setContent(head, 'mesh'))
  .catch((err) => console.warn('Zadani model nije učitan', err));

// ---------- UI ----------
const hud = new Hud();
const debug = new DebugOverlay();
const vision = new VisionSource();
const tracker = new HeadTracker(settings, vision);
const hands = new HandTracker(settings, vision);
const mouse = new MouseHead();
const mouseHand = new MouseHand();
const handInput = new HandInput();
const markers = new FingerMarkers(scene);
const director = new DirectorFrame();
const panel = new CalibrationPanel(settings, (s) => {
  tracker.applySettings(s);
  laidOut = { w: 0, h: 0 };
});
const orbit = new OrbitController(orbitSettings);
const orbitPanel = new OrbitPanel(orbitSettings, () => {});

function activeIndex() {
  return presets.indexOf(active);
}

function cameraMode() {
  if (!active?.orbitTarget) return 'window';
  return cameraModes[activeIndex()] ?? 'window';
}

function setCameraMode(mode) {
  if (!active?.orbitTarget) {
    hud.badge('WINDOW');
    hud.toast('Ova scena podržava samo window način', 1600);
    return;
  }
  cameraModes[activeIndex()] = mode;
  try {
    localStorage.setItem(CAMERA_MODES_KEY, JSON.stringify(cameraModes));
  } catch {
    /* bez pohrane */
  }
  if (mode === 'orbit' && !orbit.neutral) orbit.recalibrate(performance.now(), 1.0);
  hud.badge(mode === 'orbit' ? 'ORBIT' : 'WINDOW');
}

let stereo = false;
let mouseMode = false;
let cameraFailed = false;
let headOverride = null; // za automatske testove (window.__ht.setHead)
let handOverride = null; // za automatske testove (window.__ht.setHand)

// Generiranje geometrije (workeri) i HDRI krenu odmah u pozadini.
setTimeout(() => {
  for (const p of presets) p.preload?.();
}, 400);

const startScene = Number(new URLSearchParams(location.search).get('scene'));
setPreset(0);
if (startScene >= 2 && startScene <= presets.length) setPreset(startScene - 1);
resize();

tracker
  .start()
  .then(() => hud.toast('Kamera spremna — pomakni glavu', 2000))
  .catch((err) => {
    cameraFailed = true;
    console.warn('Kamera nije dostupna', err);
    hud.toast('Kamera nije dostupna — miš glumi glavu (kotačić = udaljenost)', 4200);
  });

setupDropzone(async (files) => {
  const picked = classifyFiles(files);
  if (!picked) {
    hud.toast('Podržano: .glb, .gltf, .ply, .splat, .spz, .ksplat');
    return;
  }
  hud.toast(`Učitavam ${picked.main.name}…`, 60000);
  try {
    const robot = presets[3];
    if (active === robot && picked.kind === 'mesh') {
      // Na sceni robota vlastiti model postaje glava i dobiva iste oči.
      const obj = await loadMeshFiles(picked.main, picked.all);
      robot.setCustomHead(obj);
      hud.toast(`${picked.main.name} je nova glava robota · R okreni · [ ] veličina · ↑↓ oči`, 4000);
      return;
    }
    const obj =
      picked.kind === 'mesh'
        ? await loadMeshFiles(picked.main, picked.all)
        : await loadSplatFile(picked.main, renderer, scene);
    presets[1].setContent(obj, picked.kind);
    setPreset(1);
    laidOut = { w: 0, h: 0 };
    hud.toast(`${picked.main.name} učitan · R okreni · [ ] veličina · V vrtnja`, 3500);
  } catch (err) {
    console.error(err);
    hud.toast(`Ne mogu učitati ${picked.main.name}: ${err.message ?? err}`, 5000);
  }
});

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key.toLowerCase()) {
    case 'f':
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.().catch(() => {});
      break;
    case 'd':
      debug.toggle();
      break;
    case 'c':
      panel.toggle();
      if (panel.visible) orbitPanel.toggle(false);
      break;
    case 't':
      orbitPanel.toggle();
      if (orbitPanel.visible) panel.toggle(false);
      break;
    case 'n':
      orbit.recalibrate(performance.now(), 0.6);
      hud.toast('Centar: trenutni položaj glave', 1400);
      break;
    case 'g': {
      const mode = cameraMode();
      gazeModes[mode] = (gazeModes[mode] % 3) + 1;
      const labels = {
        1: 'Pogled: oči prate do ±25°, zatim gledaju naprijed',
        2: 'Pogled: oči uvijek prate',
        3: 'Pogled: glava i oči prate',
      };
      hud.toast(labels[gazeModes[mode]], 1800);
      break;
    }
    case 's':
      stereo = !stereo;
      hud.toast(stereo ? 'Anaglif uključen — crveno lijevo, cijan desno' : 'Anaglif isključen', 1600);
      break;
    case 'm':
      setCameraMode(cameraMode() === 'orbit' ? 'window' : 'orbit');
      break;
    case 'k':
      mouseMode = !mouseMode;
      hud.toast(mouseMode ? 'Miš glumi glavu' : 'Praćenje kamerom', 1400);
      break;
    case 'h': {
      const on = markers.toggle();
      hud.toast(on ? 'Marker na vrhu prsta uključen' : 'Marker na vrhu prsta isključen', 1400);
      break;
    }
    case 'u':
      hud.toggle();
      break;
    case 'v':
      presets[1].turntable = !presets[1].turntable;
      break;
    case 'r':
      if (active === presets[3]) presets[3].flipCustomHead();
      else presets[1].flip();
      break;
    case '[':
      if (active === presets[3]) presets[3].scaleCustomHead(1 / 1.08);
      else presets[1].scaleBy(1 / 1.15);
      break;
    case ']':
      if (active === presets[3]) presets[3].scaleCustomHead(1.08);
      else presets[1].scaleBy(1.15);
      break;
    case 'arrowup':
    case 'arrowdown':
      if (active === presets[3]) {
        presets[3].nudgeEyes(e.key === 'ArrowUp' ? 0.25 : -0.25);
        e.preventDefault();
      }
      break;
    case 'q':
      setQuality(quality === 'high' ? 'low' : 'high');
      break;
    case 'e':
      if (presets[3].isReady) {
        const name = presets[3].toggleEyeColor();
        hud.toast(`Boja očiju: ${name}`, 1200);
      }
      break;
    case '1':
    case '2':
    case '3':
    case '4':
      setPreset(Number(e.key) - 1);
      break;
    case 'escape':
      panel.toggle(false);
      orbitPanel.toggle(false);
      break;
  }
});

// ---------- Položaj glave ----------
const pose = {
  tracked: [0, 0, REST_DISTANCE], // zadnji poznati položaj s kamere
  roll: 0,
  weight: 0, // 0 = mirovanje u centru, 1 = prati glavu
  eye: [0, 0, REST_DISTANCE],
};

const smoothstep = (x) => x * x * (3 - 2 * x);

// Neutralni položaj za ORBIT: kalibrira se automatski kad se lice pronađe
// (i nakon duljeg gubitka), ručno tipkom N; za miš je centar prozora.
const orbitState = { source: null, lostSince: 0, wasTracking: false };

function updateOrbitCalibration(now, source, rect) {
  const rest = new THREE.Vector3(rect.cx, rect.cy, REST_DISTANCE);
  if (source !== orbitState.source) {
    if (source === 'miš' || source === 'test') orbit.setNeutral(rest);
    orbitState.source = source;
  }
  if (source === 'kamera' || source === 'centar') {
    const tracking = source === 'kamera';
    if (tracking && !orbitState.wasTracking) {
      // Lice pronađeno: kalibriraj ako je to prvi put ili nakon duljeg gubitka.
      if (!orbit.neutral || now - orbitState.lostSince > 2500) orbit.recalibrate(now, 1.4);
    }
    if (!tracking && orbitState.wasTracking) orbitState.lostSince = now;
    orbitState.wasTracking = tracking;
  }
}

function updatePose(now, dt, rect) {
  const rest = [rect.cx, rect.cy, REST_DISTANCE];
  let source;

  if (headOverride) {
    // Automatski test: glava na zadanom položaju (relativno na centar prozora).
    pose.eye[0] = rect.cx + headOverride[0];
    pose.eye[1] = rect.cy + headOverride[1];
    pose.eye[2] = headOverride[2];
    pose.tracked = [...pose.eye];
    pose.weight = 1;
    pose.roll = 0;
    hud.setStatus('mouse', 'Test položaj glave');
    return 'test';
  }

  if (mouseMode || cameraFailed || !tracker.ready) {
    // Miš glumi glavu: ručno (M), bez kamere, ili dok se kamera još pokreće.
    pose.tracked = [...mouse.update(rect, dt, mouseHand.capturesMouse)];
    pose.roll = 0;
    pose.weight = 1;
    source = 'miš';
    const label = cameraFailed
      ? 'Bez kamere · miš glumi glavu'
      : !tracker.ready
        ? 'Čekam kameru · dopusti pristup · miš glumi glavu'
        : 'Miš glumi glavu';
    hud.setStatus(cameraFailed || !tracker.ready ? 'idle' : 'mouse', label);
  } else {
    const tracking = tracker.update(now, hands.boxes, dt);
    if (tracking) {
      pose.tracked = [...tracker.head];
      pose.roll = tracker.roll;
      // Pri ponovnom pronalasku lica glatko se vraćamo iz centra.
      pose.weight = Math.min(1, pose.weight + dt * 4);
      hud.setStatus('tracking', tracker.held ? 'Ruka ispred lica — držim položaj' : 'Pratim glavu');
    } else {
      // Lice izgubljeno: pogled se glatko vraća u centar.
      pose.weight = Math.max(0, pose.weight - dt * 1.2);
      hud.setStatus('searching', 'Tražim lice…');
    }
    source = tracking ? 'kamera' : 'centar';
  }

  const w = smoothstep(pose.weight);
  for (let i = 0; i < 3; i++) pose.eye[i] = rest[i] + (pose.tracked[i] - rest[i]) * w;
  pose.eye[2] = Math.max(pose.eye[2], 5);
  return source;
}

// ---------- Doseg ruke ----------
// Scena zadaje točku interesa i koliko je ispred nje vrh prsta u neutralnom
// položaju ruke (near) i pri punom dosegu prema ekranu (far), u world cm.
const reachTarget = new THREE.Vector3();
function sceneReach(rect) {
  const r = active.handReach?.();
  if (r) return r;
  if (active.orbitTarget) active.orbitTarget(reachTarget);
  else reachTarget.set(rect.cx, rect.cy, -30);
  return { target: reachTarget, near: 30, far: 0, minCam: 12 };
}

// ---------- Petlja ----------
const pa = new THREE.Vector3();
const pb = new THREE.Vector3();
const pc = new THREE.Vector3();
const eyeC = new THREE.Vector3();
const eyeL = new THREE.Vector3();
const eyeR = new THREE.Vector3();
const half = new THREE.Vector3();
const orbitHead = new THREE.Vector3();
const orbitTarget = new THREE.Vector3();
const neutralEye = new THREE.Vector3();
let lastFrame = performance.now();
let t = 0;

function frame() {
  renderer.info.reset();
  const now = performance.now();
  const frameMs = now - lastFrame;
  const dt = Math.min(frameMs / 1000, 0.1);
  lastFrame = now;
  adaptResolution(now, frameMs);
  t += dt;

  const rect = getCanvasRect(settings);
  if (Math.abs(rect.width - laidOut.w) > 0.05 || Math.abs(rect.height - laidOut.h) > 0.05) {
    for (const p of presets) p.layout(rect);
    laidOut = { w: rect.width, h: rect.height };
  }
  world.position.set(rect.cx, rect.cy, 0);
  world.updateMatrixWorld(true);
  // Detekcija (u načinu glavne niti) i ruke prije glave: glava treba okvire ruku
  // da zna kad ruka zaklanja lice.
  vision.update(now);
  hands.update(now, pose.tracked[2]);
  const mouseEvents = mouseHand.update(now, dt);
  const source = updatePose(now, dt, rect);
  updateOrbitCalibration(now, source, rect);
  // ORBIT ulaz: zadnji praćeni položaj glave; težina pada na 0 kad se lice izgubi.
  orbitHead.fromArray(source === 'test' ? pose.eye : pose.tracked);
  const orbitWeight = source === 'kamera' || source === 'centar' ? smoothstep(pose.weight) : 1;
  orbit.update(now, dt, orbitHead, orbitWeight);
  if (compiling) {
    vision.afterRender();
    debug.tick(now);
    return;
  }

  const mode = cameraMode();
  // Oči: centar ± pola IPD-a duž linije očiju (uzima u obzir nagib glave).
  eyeC.fromArray(pose.eye);
  half.set(Math.cos(pose.roll), Math.sin(pose.roll), 0).multiplyScalar(settings.ipd / 2);
  const mono = eyeC.clone();

  if (mode === 'orbit') {
    // Kamera kruži oko točke interesa; pri neutralnom položaju vidi isto kao window.
    const target = active.orbitTarget(orbitTarget);
    neutralEye.set(rect.cx, rect.cy, REST_DISTANCE);
    const vfov = THREE.MathUtils.radToDeg(2 * Math.atan(rect.height / 2 / REST_DISTANCE));
    orbit.apply(camMono, target, neutralEye, vfov, rect.width / rect.height, active.orbitLimits?.() ?? {});
    if (stereo) orbit.applyStereo(camMono, camLeft, camRight, (settings.ipd / 2) * settings.stereoStrength);
    mono.copy(camMono.position);
  } else {
    // Kutovi prozora na ravnini z = 0.
    pa.set(rect.x0, rect.y0, 0);
    pb.set(rect.x1, rect.y0, 0);
    pc.set(rect.x0, rect.y1, 0);
    if (settings.eye === 'left') mono.sub(half);
    if (settings.eye === 'right') mono.add(half);
    applyOffAxis(camMono, pa, pb, pc, mono, NEAR, FAR);
    if (stereo) {
      const k = settings.stereoStrength;
      eyeL.copy(eyeC).addScaledVector(half, -k);
      eyeR.copy(eyeC).addScaledVector(half, k);
      applyOffAxis(camLeft, pa, pb, pc, eyeL, NEAR, FAR);
      applyOffAxis(camRight, pa, pb, pc, eyeR, NEAR, FAR);
    }
  }

  // Redateljski okvir: izrez kadra (zoom + reframe) preko projekcije kamere; sidro
  // se računa iz neizrezane kamere, a zrake ruku iz izrezane (pokazuje se ono što se vidi).
  const reach = sceneReach(rect);
  camMono.updateMatrixWorld();
  director.update(now, dt, handInput.ctx, camMono, camMono.position.distanceTo(reach.target));
  director.apply(camMono);
  if (stereo) {
    director.apply(camLeft);
    director.apply(camRight);
  }

  // Ruke u 3D: zrake iz trenutne kamere, dubina relativna na neutralnu.
  const hand = handInput.update(now, dt, {
    tracker: hands,
    mouse: mouseHand,
    mouseEvents,
    camera: camMono,
    reach,
    override: handOverride,
  });

  active.update(t, dt, {
    eye: mode === 'orbit' ? camMono.position.toArray() : pose.eye,
    rect,
    cameraMode: mode,
    gazeMode: gazeModes[mode],
    hand,
  });
  markers.update(hand, camMono, dt, active.displayScale ?? 1);

  if (active.usesPost) {
    // Sjene se računaju jednom po frameu (refleksija, oba oka i bloom ih dijele).
    renderer.shadowMap.needsUpdate = true;
    profiler.measure('beforeRender', () =>
      active.beforeRender?.(renderer, scene, mode === 'orbit' || !stereo ? mono : eyeC, rect, camMono, mode),
    );
    const p = getPost();
    if (stereo) {
      p.render(camLeft, dt, anaglyph.left);
      p.render(camRight, dt, anaglyph.right);
      anaglyph.combine();
    } else {
      p.render(camMono, dt, null);
    }
  } else if (stereo) {
    anaglyph.render(scene, camLeft, camRight);
  } else {
    renderer.render(scene, camMono);
  }

  // Novi frame kamere ide u worker tek sad, kad je ovaj frame predan GPU-u.
  vision.afterRender();
  profiler.poll();
  debug.tick(now);
  const orbitInfo =
    mode === 'orbit'
      ? `ORBIT az ${orbit.az.toFixed(1)}° el ${(orbit.effectiveEl ?? orbit.el).toFixed(1)}° zoom ${(1 / orbit.zoom).toFixed(2)}×${orbit.calibrating ? ' · kalibriram' : ''}`
      : 'WINDOW';
  debug.draw({ tracker, hands, hand, vision, source, eye: pose.eye, rect, stereo, sceneName: active.name, quality: active.usesPost ? `${quality} ${renderer.getPixelRatio().toFixed(2)}×` : null, orbitInfo });
  panel.showMeasurement(pose.eye, source);
  orbitPanel.showState(mode === 'orbit' ? orbitInfo : 'Trenutna scena je u WINDOW načinu (M za orbit).');
}
renderer.setAnimationLoop(frame);

/** Benchmark: n frameova bez vsynca, sa sinkronizacijom GPU-a na kraju (ms/frame). */
function benchmark(n = 30) {
  renderer.setAnimationLoop(null);
  const gl = renderer.getContext();
  const px = new Uint8Array(4);
  frame();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) frame();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const ms = (performance.now() - t0) / n;
  renderer.setAnimationLoop(frame);
  return +ms.toFixed(2);
}

function setHandOverride(o) {
  if (!o) {
    handOverride = null;
    return;
  }
  const prev = handOverride;
  const logR = Math.log(o.r ?? 0.62);
  const tip = o.tip ?? [0, 0];
  const pinch = o.pinchAt ?? tip;
  const track = prev?.track ?? { id: 'test', label: 'T', simulated: true, pts: { tip: [0, 0, 0], pinch: [0, 0, 0], palm: [0, 0, 0] } };
  if (track.gesture !== (o.gesture ?? 'point')) track.gestureSince = performance.now();
  track.gesture = o.gesture ?? 'point';
  track.spread = o.spread ?? 0;
  track.pinch = track.gesture === 'pinch' ? 1 : 0;
  track.pts.tip = [tip[0], tip[1], logR];
  track.pts.pinch = [pinch[0], pinch[1], logR];
  track.pts.palm = [tip[0], tip[1] - 0.12, logR + 0.05];
  track.distanceCm = 37;
  handOverride = {
    track,
    events: prev?.events ?? [],
    frame: o.frame ? { valid: true, rect: { x0: o.frame[0], y0: o.frame[1], x1: o.frame[2], y1: o.frame[3] }, since: prev?.frame?.valid ? prev.frame.since : performance.now() } : { valid: false },
  };
  if (o.gesture === null || o.gesture === 'away') handOverride.track = null;
}

// Mali API za automatske testove i snimanje (Playwright): window.__ht
window.__ht = {
  setHead: (v) => (headOverride = v ? [...v] : null),
  /**
   * Ruka bez kamere: { tip:[x,y] (NDC), r (udaljenost ruke / glave, 0.62 = neutralno),
   * gesture: 'point'|'pinch'|'open'|'fist'|'none', spread, two?: {rect} }; null vraća kameru/miš.
   */
  setHand: (o) => setHandOverride(o),
  tap: (ndc) => {
    if (!handOverride) setHandOverride({ tip: ndc, gesture: 'point' });
    handOverride.events.push({ type: 'tap', hand: 'test', ndc: [...(ndc ?? handOverride.track.pts.tip)] });
  },
  markers: (on) => markers.toggle(on),
  hand: () => handInput.ctx,
  vision,
  hands,
  tracker,
  setPreset: (i) => setPreset(i),
  setQuality: (q) => setQuality(q),
  setStereo: (b) => (stereo = !!b),
  setCameraMode: (m) => setCameraMode(m),
  setGazeMode: (n) => (gazeModes[cameraMode()] = n),
  /** Orbit bez glave: { az, el, zoom } (zoom = faktor udaljenosti), null vraća upravljanje glavi. */
  setOrbit: (o) => (orbit.override = o ? { snap: true, ...o } : null),
  orbit,
  state: () => ({
    fps: debug.fps,
    scene: active?.name,
    ready: presets.map((p) => !p.init || !!p.isReady),
    quality,
    pixelRatio: renderer.getPixelRatio(),
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
  }),
  presets,
  get post() {
    return post;
  },
  benchmark,
  profile: (on) => {
    if (on !== undefined) profiler.enabled = !!on;
    return profiler.report();
  },
  renderer,
  settings,
  scene,
};
