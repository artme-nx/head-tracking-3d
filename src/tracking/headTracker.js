// Praćenje glave web kamerom (MediaPipe FaceLandmarker) → položaj očiju u cm
// u koordinatnom sustavu ekrana: ishodište u centru ekrana, +x desno, +y gore,
// +z prema gledatelju. Kamera je iznad gornjeg ruba ekrana.

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { OneEuroFilter3, OneEuroFilter } from './oneEuro.js';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm';
const MODEL_URL = `${import.meta.env.BASE_URL}models/face_landmarker.task`;

// Središta šarenica (refined landmarks): 468–472 i 473–477.
const IRIS_A = 468;
const IRIS_B = 473;
const LOST_AFTER_MS = 250;

export class HeadTracker {
  constructor(settings) {
    this.settings = settings;
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.landmarker = null;
    this.ready = false;
    this.error = null;

    this.lastVideoTime = -1;
    this.lastSeen = -Infinity;
    this.tracking = false;

    this.posFilter = new OneEuroFilter3({ minCutoff: 1, beta: 0.04, dCutoff: 1 }, [1, 1, 0.6]);
    this.rollFilter = new OneEuroFilter({ minCutoff: 1, beta: 0.02 });
    this.applySettings(settings);

    /** Filtrirani centar između očiju [x, y, z] u cm. */
    this.head = [0, 0, 60];
    /** Nagib glave (roll) u radijanima — smjer linije između očiju. */
    this.roll = 0;
    /** Sirovi podaci za debug overlay. */
    this.raw = null;
    this.detectMs = 0;
  }

  applySettings(settings) {
    this.settings = settings;
    this.posFilter.setParams({ minCutoff: settings.smoothing, beta: settings.responsiveness });
    this.rollFilter.minCutoff = settings.smoothing;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Preglednik ne podržava kameru (potreban je https ili localhost).');

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = stream;
    await this.video.play();

    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true,
    });
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options('GPU'));
    } catch {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options('CPU'));
    }
    this.ready = true;
  }

  /** Poziva se jednom po frameu. Vraća true ako je lice trenutno praćeno. */
  update(nowMs) {
    if (!this.ready) return false;
    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime;
      const t0 = performance.now();
      const result = this.landmarker.detectForVideo(v, nowMs);
      this.detectMs = performance.now() - t0;
      const face = result.faceLandmarks?.[0];
      if (face) this.#process(face, result.facialTransformationMatrixes?.[0]?.data, nowMs);
    }
    const tracking = nowMs - this.lastSeen < LOST_AFTER_MS;
    if (!tracking && this.tracking) {
      // Lice izgubljeno: sljedeća detekcija kreće s čistim filterom (bez "repa").
      this.posFilter.reset();
      this.rollFilter.reset();
    }
    this.tracking = tracking;
    return tracking;
  }

  #process(lm, matrix, nowMs) {
    const s = this.settings;
    const W = this.video.videoWidth;
    const H = this.video.videoHeight;

    const ax = lm[IRIS_A].x * W, ay = lm[IRIS_A].y * H;
    const bx = lm[IRIS_B].x * W, by = lm[IRIS_B].y * H;
    let dpx = Math.hypot(bx - ax, by - ay);
    if (dpx < 2) return;

    // Okretanje glave lijevo/desno (yaw) skraćuje projicirani razmak zjenica.
    // Iz transformacijske matrice lica: X os lica u koordinatama kamere.
    if (matrix) {
      const rx = matrix[0], ry = matrix[1], rz = matrix[2];
      const len = Math.hypot(rx, ry, rz) || 1;
      const inPlane = Math.hypot(rx, ry) / len;
      dpx /= Math.min(Math.max(inPlane, 0.7), 1);
    }

    // Pinhole model: fokalna duljina u pikselima iz horizontalnog FOV-a.
    const f = W / 2 / Math.tan(((s.cameraFov * Math.PI) / 180) / 2);
    const z = (f * s.ipd) / dpx;

    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const xCam = ((mx - W / 2) * z) / f; // desno u slici kamere
    const yCam = ((my - H / 2) * z) / f; // dolje u slici kamere

    // Slika kamere nije zrcaljena: korisnikovo "desno" je lijevo u slici.
    const x = -xCam;
    const y = s.screenHeight / 2 + s.cameraOffset - yCam;

    const t = nowMs / 1000;
    this.head = this.posFilter.filter([x, y, z], t);
    // Roll u koordinatama ekrana (x zrcaljen, y prema gore).
    let roll = Math.atan2(-(by - ay), -(bx - ax));
    if (roll > Math.PI / 2) roll -= Math.PI;
    if (roll < -Math.PI / 2) roll += Math.PI;
    this.roll = this.rollFilter.filter(roll, t);

    this.raw = { ax, ay, bx, by, W, H, z, x, y, landmarks: lm };
    this.lastSeen = nowMs;
  }
}
