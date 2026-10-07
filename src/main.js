// Ekran kao prozor — head-coupled perspective s praćenjem glave web kamerom.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { loadSettings } from './config.js';
import { HeadTracker } from './tracking/headTracker.js';
import { MouseHead } from './tracking/mouseHead.js';
import { applyOffAxis } from './projection/offAxis.js';
import { getCanvasRect } from './projection/screenRect.js';
import { AnaglyphRenderer } from './render/anaglyph.js';
import { BoxScene } from './scenes/boxScene.js';
import { ModelScene } from './scenes/modelScene.js';
import { classifyFiles, loadDefaultHead, loadMeshFiles, loadSplatFile } from './scenes/loaders.js';
import { DebugOverlay } from './ui/debugOverlay.js';
import { CalibrationPanel } from './ui/calibrationPanel.js';
import { Hud } from './ui/hud.js';
import { setupDropzone } from './ui/dropzone.js';
import './style.css';

const REST_DISTANCE = 60; // cm — kamo se pogled vraća kad se lice izgubi
const NEAR = 0.5;
const FAR = 2000;

const settings = loadSettings();

// ---------- Renderer ----------
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();

// Sve scene su građene oko ishodišta; "world" se pomiče na centar prozora.
const world = new THREE.Group();
scene.add(world);

const camMono = new THREE.PerspectiveCamera();
const camLeft = new THREE.PerspectiveCamera();
const camRight = new THREE.PerspectiveCamera();
const anaglyph = new AnaglyphRenderer(renderer);

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  anaglyph.setSize(size.x, size.y);
}
resize();
window.addEventListener('resize', resize);

// ---------- Scene ----------
const presets = [new BoxScene(), new ModelScene()];
let active = null;
let laidOut = { w: 0, h: 0 };

function setPreset(index) {
  const next = presets[index];
  if (!next || next === active) return;
  if (active) world.remove(active.group);
  active = next;
  world.add(active.group);
  active.activate(scene);
  laidOut = { w: 0, h: 0 }; // forsiraj layout za novu scenu
  hud.toast(`Scena ${index + 1}: ${active.name}`, 1400);
}

loadDefaultHead()
  .then((head) => presets[1].content ?? presets[1].setContent(head, 'mesh'))
  .catch((err) => console.warn('Zadani model nije učitan', err));

// ---------- UI ----------
const hud = new Hud();
const debug = new DebugOverlay();
const tracker = new HeadTracker(settings);
const mouse = new MouseHead();
const panel = new CalibrationPanel(settings, (s) => {
  tracker.applySettings(s);
  laidOut = { w: 0, h: 0 };
});

let stereo = false;
let mouseMode = false;
let cameraFailed = false;

setPreset(0);

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
    const obj =
      picked.kind === 'mesh'
        ? await loadMeshFiles(picked.main, picked.all)
        : await loadSplatFile(picked.main, renderer, scene);
    presets[1].setContent(obj, picked.kind);
    setPreset(1);
    laidOut = { w: 0, h: 0 };
    hud.toast(`${picked.main.name} učitan · R okreni · [ ] veličina · T vrtnja`, 3500);
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
      break;
    case 's':
      stereo = !stereo;
      hud.toast(stereo ? 'Anaglif uključen — crveno lijevo, cijan desno' : 'Anaglif isključen', 1600);
      break;
    case 'm':
      mouseMode = !mouseMode;
      hud.toast(mouseMode ? 'Miš glumi glavu' : 'Praćenje kamerom', 1400);
      break;
    case 'h':
      hud.toggle();
      break;
    case 't':
      presets[1].turntable = !presets[1].turntable;
      break;
    case 'r':
      presets[1].flip();
      break;
    case '[':
      presets[1].scaleBy(1 / 1.15);
      break;
    case ']':
      presets[1].scaleBy(1.15);
      break;
    case '1':
    case '2':
      setPreset(Number(e.key) - 1);
      break;
    case 'escape':
      panel.toggle(false);
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

function updatePose(now, dt, rect) {
  const rest = [rect.cx, rect.cy, REST_DISTANCE];
  let source;

  if (mouseMode || cameraFailed || !tracker.ready) {
    // Miš glumi glavu: ručno (M), bez kamere, ili dok se kamera još pokreće.
    pose.tracked = [...mouse.update(rect, dt)];
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
    const tracking = tracker.update(now);
    if (tracking) {
      pose.tracked = [...tracker.head];
      pose.roll = tracker.roll;
      // Pri ponovnom pronalasku lica glatko se vraćamo iz centra.
      pose.weight = Math.min(1, pose.weight + dt * 4);
      hud.setStatus('tracking', 'Pratim glavu');
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

// ---------- Petlja ----------
const pa = new THREE.Vector3();
const pb = new THREE.Vector3();
const pc = new THREE.Vector3();
const eyeC = new THREE.Vector3();
const eyeL = new THREE.Vector3();
const eyeR = new THREE.Vector3();
const half = new THREE.Vector3();
let lastFrame = performance.now();
let t = 0;

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  t += dt;

  const rect = getCanvasRect(settings);
  if (Math.abs(rect.width - laidOut.w) > 0.05 || Math.abs(rect.height - laidOut.h) > 0.05) {
    for (const p of presets) p.layout(rect);
    laidOut = { w: rect.width, h: rect.height };
  }
  world.position.set(rect.cx, rect.cy, 0);
  active.update(t, dt);

  const source = updatePose(now, dt, rect);

  // Kutovi prozora na ravnini z = 0.
  pa.set(rect.x0, rect.y0, 0);
  pb.set(rect.x1, rect.y0, 0);
  pc.set(rect.x0, rect.y1, 0);

  // Oči: centar ± pola IPD-a duž linije očiju (uzima u obzir nagib glave).
  eyeC.fromArray(pose.eye);
  half.set(Math.cos(pose.roll), Math.sin(pose.roll), 0).multiplyScalar(settings.ipd / 2);

  if (stereo) {
    const k = settings.stereoStrength;
    eyeL.copy(eyeC).addScaledVector(half, -k);
    eyeR.copy(eyeC).addScaledVector(half, k);
    applyOffAxis(camLeft, pa, pb, pc, eyeL, NEAR, FAR);
    applyOffAxis(camRight, pa, pb, pc, eyeR, NEAR, FAR);
    anaglyph.render(scene, camLeft, camRight);
  } else {
    const mono = eyeL.copy(eyeC);
    if (settings.eye === 'left') mono.sub(half);
    if (settings.eye === 'right') mono.add(half);
    applyOffAxis(camMono, pa, pb, pc, mono, NEAR, FAR);
    renderer.render(scene, camMono);
  }

  debug.tick(now);
  debug.draw({ tracker, source, eye: pose.eye, rect, stereo, sceneName: active.name });
  panel.showMeasurement(pose.eye, source);
});
