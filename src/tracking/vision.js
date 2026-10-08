// Izvor slike za praćenje: web kamera + MediaPipe detekcija lica i ruku.
// Lice i ruke rade u dva web workera, paralelno (frame kamere se prenosi bez
// kopiranja), pa glavna nit samo crta i render drži 60 fps. Novi frame kamere
// šalje se tek kad je render predao svoj frame GPU-u, pa detekcija radi u rupi
// između naših frameova. Lice ide u punoj rezoluciji (preciznost dubine glave),
// ruke u smanjenoj. Ako workeri ne uspiju (stariji preglednik), detekcija ide
// na glavnoj niti, a lice i ruke se obrađuju naizmjenično po frameovima kamere.

import { FaceLandmarker, HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm';
const base = import.meta.env.BASE_URL;
const MODELS = {
  face: new URL(`${base}models/face_landmarker.task`, location.href).href,
  hands: new URL(`${base}models/hand_landmarker.task`, location.href).href,
};

/** Brojač ritma detekcije (Hz). */
class Rate {
  constructor() {
    this.hz = 0;
    this.n = 0;
    this.t = performance.now();
  }
  tick() {
    this.n++;
    const now = performance.now();
    if (now - this.t > 1000) {
      this.hz = (this.n * 1000) / (now - this.t);
      this.n = 0;
      this.t = now;
    }
  }
}

// Postavke (URL parametri samo za usporedbu na razvoju):
//   zadano: lice i ruke u dva zasebna workera (paralelno, svaki svojim ritmom)
//   ?vision=1w — oba zadatka u jednom workeru · ?vision=alt — jedan zadatak po frameu
//   ?vision=main — detekcija na glavnoj niti · ?handres=full — ruke u punoj rezoluciji
const params = new URLSearchParams(location.search);
const CONFIG = {
  mode: params.get('vision') ?? '2w',
  handWidth: params.get('handres') === 'full' ? 0 : Number(params.get('handres')) || 640,
  delegates: { face: params.get('fd') ?? undefined, hands: params.get('hd') ?? undefined },
};

/** Worker s jednim ili oba zadatka; novi frame dobiva tek kad završi prethodni. */
class TaskWorker {
  constructor(tasks, onResult) {
    this.tasks = tasks;
    this.onResult = onResult;
    this.busy = false;
    this.worker = null;
    this.delegates = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./visionWorker.js', import.meta.url), { type: 'module' });
      const name = this.tasks.join('+');
      const timer = setTimeout(() => reject(new Error(`Worker (${name}) se nije pokrenuo na vrijeme`)), 30000);
      worker.onerror = (e) => {
        clearTimeout(timer);
        reject(e.error ?? new Error(e.message || 'Greška u workeru'));
      };
      worker.onmessage = (ev) => {
        const msg = ev.data;
        if (msg.type === 'ready') {
          clearTimeout(timer);
          this.delegates = msg.delegates;
          worker.onmessage = (e) => {
            this.busy = false;
            if (e.data.error) console.warn(`[vision] ${name}:`, e.data.error);
            else this.onResult(e.data);
          };
          worker.onerror = (e) => console.error(`[vision] ${name}`, e.message);
          this.worker = worker;
          resolve();
        } else if (msg.type === 'error') {
          clearTimeout(timer);
          reject(new Error(msg.error));
        }
      };
      worker.postMessage({ type: 'init', tasks: this.tasks, wasmUrl: WASM_URL, models: MODELS, delegates: CONFIG.delegates });
    });
  }

  /**
   * @param {HTMLVideoElement} v
   * @param {string[]} which zadaci za ovaj frame (zadano: svi zadaci workera)
   */
  async send(v, t, which = this.tasks) {
    if (this.busy || !this.worker) return false;
    this.busy = true;
    const msg = { type: 'frame', t, width: v.videoWidth, height: v.videoHeight };
    const transfer = [];
    try {
      if (which.includes('face')) {
        // Lice u punoj rezoluciji (preciznost šarenica = preciznost dubine glave).
        msg.face = typeof VideoFrame !== 'undefined' ? new VideoFrame(v, { timestamp: t * 1000 }) : await createImageBitmap(v);
        transfer.push(msg.face);
      }
      if (which.includes('hands')) {
        // Ruke su velike u kadru: smanjena slika je dovoljna, a bitno brža.
        const w = CONFIG.handWidth;
        msg.hands =
          w && w < v.videoWidth
            ? await createImageBitmap(v, { resizeWidth: w, resizeHeight: Math.round((w * v.videoHeight) / v.videoWidth), resizeQuality: 'medium' })
            : typeof VideoFrame !== 'undefined'
              ? new VideoFrame(v, { timestamp: t * 1000 })
              : await createImageBitmap(v);
        transfer.push(msg.hands);
      }
      this.worker.postMessage(msg, transfer);
      return true;
    } catch (err) {
      this.busy = false;
      for (const f of transfer) f.close?.();
      console.warn('[vision] frame nije poslan', err);
      return false;
    }
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
  }
}

export class VisionSource {
  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.ready = false; // kamera radi i detektor lica je spreman
    this.handsReady = false;
    this.mode = null; // 'worker' | 'main'
    this.delegates = null;
    /** Zadnji rezultati: lice i ruke u normaliziranim koordinatama slike kamere. */
    this.result = { seq: 0, width: 0, height: 0, face: null, hands: [], faceSeq: 0, handSeq: 0 };
    this.faceMs = 0;
    this.handMs = 0;
    this.faceRate = new Rate();
    this.handRate = new Rate();
    this.cameraRate = new Rate(); // stvarni fps kamere (u slabom svjetlu macOS ga spušta)
    this.startPromise = null;
    this.mainToggle = false;
    this.frameSerial = 0; // broj frameova kamere (rVFC)
    this.lastSentSerial = -1;
    this.lastSentAt = 0;
    this.lastHandSeen = -1e9;
  }

  /** Ritam detekcije (Hz) — sporiji od dvaju zadataka. */
  get detectFps() {
    return Math.min(this.faceRate.hz, this.handRate.hz);
  }

  /**
   * Gladuje li detekcija? Worker dijeli GPU s renderom; kad render pojede sav GPU,
   * detekcija padne daleko ispod ritma kamere. Tada render treba spustiti rezoluciju.
   */
  get starved() {
    if (this.mode !== 'worker' || !this.ready) return false;
    const cam = this.cameraRate.hz;
    if (cam < 8) return false;
    if (this.faceRate.hz < cam * 0.72) return true;
    const handsActive = performance.now() - (this.lastHandSeen ?? -1e9) < 2000;
    return handsActive && this.handRate.hz < cam * 0.6;
  }

  /** Detekcija ima rezerve (smije se probati viša rezolucija rendera). */
  get healthy() {
    if (this.mode !== 'worker' || !this.ready) return true;
    const cam = this.cameraRate.hz;
    return cam < 8 || this.faceRate.hz > cam * 0.9;
  }

  start() {
    this.startPromise ??= this.#start();
    return this.startPromise;
  }

  async #start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Preglednik ne podržava kameru (potreban je https ili localhost).');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = stream;
    await this.video.play();
    // Novi frame kamere: requestVideoFrameCallback (currentTime živog streama raste
    // kontinuirano, pa ne kaže je li stigao novi frame).
    if (this.video.requestVideoFrameCallback) {
      const onFrame = () => {
        this.frameSerial++;
        this.cameraRate.tick();
        this.video.requestVideoFrameCallback(onFrame);
      };
      this.video.requestVideoFrameCallback(onFrame);
    }

    const workerOk = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && CONFIG.mode !== 'main';
    if (workerOk) {
      const onResult = (m) => {
        if (m.face !== undefined) this.#storeFace(m.face, m.width, m.height, m.faceMs);
        if (m.hands !== undefined) this.#storeHands(m.hands, m.width, m.height, m.handMs);
      };
      try {
        this.workers =
          CONFIG.mode === '2w'
            ? [new TaskWorker(['face'], onResult), new TaskWorker(['hands'], onResult)]
            : [new TaskWorker(CONFIG.mode === 'face' ? ['face'] : ['face', 'hands'], onResult)];
        this.lastHandSeen = -1e9;
        await Promise.all(this.workers.map((w) => w.start()));
        this.delegates = Object.assign({}, ...this.workers.map((w) => w.delegates));
        this.mode = 'worker';
      } catch (err) {
        console.warn('[vision] worker nije uspio, detekcija ide na glavnoj niti', err);
        for (const w of this.workers ?? []) w.terminate();
        this.workers = null;
      }
    }
    if (!this.mode) {
      await this.#startMain();
      this.mode = 'main';
    }
    this.ready = true;
    this.handsReady = true;
  }

  async #startMain() {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const make = async (Task, options) => {
      try {
        return await Task.createFromOptions(fileset, options('GPU'));
      } catch {
        return Task.createFromOptions(fileset, options('CPU'));
      }
    };
    [this.faceTask, this.handTask] = await Promise.all([
      make(FaceLandmarker, (delegate) => ({
        baseOptions: { modelAssetPath: MODELS.face, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: true,
      })),
      make(HandLandmarker, (delegate) => ({
        baseOptions: { modelAssetPath: MODELS.hands, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.5,
      })),
    ]);
    this.delegates = { face: 'glavna nit', hands: 'glavna nit' };
  }

  /**
   * Poziva se na kraju svakog framea, nakon što je render predan GPU-u: novi
   * frame kamere ide slobodnom workeru. Tako GPU posao detekcije pada u rupu
   * između naših frameova umjesto da gura render preko vsynca.
   */
  afterRender() {
    if (this.mode !== 'worker' || !this.ready) return;
    const v = this.video;
    if (v.readyState < 2 || !this.#freshFrame()) return;
    if (this.workers.every((w) => w.busy)) return;
    this.#markSent();
    const t = Math.round(performance.now());
    if (CONFIG.mode === 'alt') this.#sendAlternating(v, t);
    else for (const w of this.workers) w.send(v, t);
  }

  /** Je li od zadnjeg slanja stigao novi frame kamere? Bez rVFC-a: najviše 30 puta u sekundi. */
  #freshFrame() {
    if (this.frameSerial > 0) return this.frameSerial !== this.lastSentSerial;
    return performance.now() - this.lastSentAt >= 1000 / 30 - 2;
  }

  #markSent() {
    this.lastSentSerial = this.frameSerial;
    this.lastSentAt = performance.now();
  }

  /**
   * Jedan zadatak po frameu kamere: lice i ruke naizmjenično. Dok ruku nema,
   * traže se rjeđe (svaki treći frame), pa lice dobiva više ritma.
   */
  #sendAlternating(v, t) {
    const w = this.workers[0];
    if (w.busy) return;
    const handsActive = performance.now() - this.lastHandSeen < 1500;
    this.altTurn = (this.altTurn ?? 0) + 1;
    const hands = handsActive ? this.altTurn % 2 === 0 : this.altTurn % 3 === 0;
    w.send(v, t, [hands ? 'hands' : 'face']);
  }

  #storeFace(face, width, height, ms) {
    const r = this.result;
    r.seq++;
    r.width = width;
    r.height = height;
    r.face = face;
    r.faceSeq = r.seq;
    this.faceMs = ms;
    this.faceRate.tick();
  }

  #storeHands(hands, width, height, ms) {
    const r = this.result;
    r.seq++;
    r.width = width;
    r.height = height;
    r.hands = hands ?? [];
    r.handSeq = r.seq;
    if (r.hands.length) this.lastHandSeen = performance.now();
    this.handMs = ms;
    this.handRate.tick();
  }

  /**
   * Poziva se jednom po frameu rendera. U načinu glavne niti ovdje se radi
   * detekcija: lice i ruke naizmjenično, po jedan zadatak na novi frame kamere.
   */
  update(nowMs) {
    if (this.mode !== 'main' || !this.ready) return;
    const v = this.video;
    if (v.readyState < 2 || !this.#freshFrame()) return;
    this.#markSent();
    this.mainToggle = !this.mainToggle;
    const t = Math.round(nowMs);
    const t0 = performance.now();
    if (this.mainToggle) {
      const res = this.faceTask.detectForVideo(v, Math.max(t, (this._lastFaceTs ?? -1) + 1));
      this._lastFaceTs = t;
      const lm = res.faceLandmarks?.[0];
      const face = lm ? { landmarks: pack(lm), matrix: res.facialTransformationMatrixes?.[0]?.data ?? null } : null;
      this.#storeFace(face, v.videoWidth, v.videoHeight, performance.now() - t0);
    } else {
      const res = this.handTask.detectForVideo(v, Math.max(t, (this._lastHandTs ?? -1) + 1));
      this._lastHandTs = t;
      const hands = (res.landmarks ?? []).map((lm, i) => ({
        landmarks: pack(lm),
        world: pack(res.worldLandmarks?.[i] ?? lm),
        handedness: res.handedness?.[i]?.[0]?.categoryName ?? '',
        score: res.handedness?.[i]?.[0]?.score ?? 0,
      }));
      this.#storeHands(hands, v.videoWidth, v.videoHeight, performance.now() - t0);
    }
  }
}

function pack(list) {
  const out = new Float32Array(list.length * 3);
  for (let i = 0; i < list.length; i++) {
    out[i * 3] = list[i].x;
    out[i * 3 + 1] = list[i].y;
    out[i * 3 + 2] = list[i].z;
  }
  return out;
}
