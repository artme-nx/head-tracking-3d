// Web worker: MediaPipe FaceLandmarker i/ili HandLandmarker izvan glavne niti.
// Glavna nit šalje frameove kamere (VideoFrame za lice u punoj rezoluciji,
// smanjeni ImageBitmap za ruke), worker vraća landmarke. Render tako nikad
// ne čeka detekciju.

import { FaceLandmarker, HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const tasks = {};
const lastTs = { face: -1, hands: -1 };

let factory = null;

async function create(Task, fileset, options, preferred) {
  if (preferred !== 'CPU') {
    try {
      self.ModuleFactory = factory;
      return { task: await Task.createFromOptions(fileset, options('GPU')), delegate: 'GPU' };
    } catch (err) {
      console.warn('[vision] GPU delegat nije dostupan, prelazim na CPU', err);
    }
  }
  self.ModuleFactory = factory;
  return { task: await Task.createFromOptions(fileset, options('CPU')), delegate: 'CPU' };
}

async function init({ tasks: names, wasmUrl, models, delegates = {} }) {
  // useModule = true: u module workeru nema importScripts, wasm loader se učitava kao ES modul.
  const fileset = await FilesetResolver.forVisionTasks(wasmUrl, true);
  // MediaPipe nakon stvaranja zadatka briše self.ModuleFactory, a ES modul loadera
  // se kešira i drugi put se ne izvrši — zato factory pamtimo i vraćamo prije svakog zadatka.
  const loader = await import(/* @vite-ignore */ fileset.wasmLoaderPath);
  factory = loader.default ?? self.ModuleFactory;
  const out = {};
  for (const name of names) {
    const made =
      name === 'face'
        ? await create(
            FaceLandmarker,
            fileset,
            (delegate) => ({
              baseOptions: { modelAssetPath: models.face, delegate },
              runningMode: 'VIDEO',
              numFaces: 1,
              outputFaceBlendshapes: false,
              outputFacialTransformationMatrixes: true,
            }),
            delegates.face,
          )
        : await create(
            HandLandmarker,
            fileset,
            (delegate) => ({
              baseOptions: { modelAssetPath: models.hands, delegate },
              runningMode: 'VIDEO',
              numHands: 2,
              minHandDetectionConfidence: 0.6,
              minHandPresenceConfidence: 0.55,
              minTrackingConfidence: 0.5,
            }),
            delegates.hands,
          );
    tasks[name] = made.task;
    out[name] = made.delegate;
  }
  return out;
}

function packLandmarks(list) {
  const out = new Float32Array(list.length * 3);
  for (let i = 0; i < list.length; i++) {
    out[i * 3] = list[i].x;
    out[i * 3 + 1] = list[i].y;
    out[i * 3 + 2] = list[i].z;
  }
  return out;
}

function run(name, frame, t) {
  const ts = Math.max(t, lastTs[name] + 1);
  lastTs[name] = ts;
  const t0 = performance.now();
  const r = tasks[name].detectForVideo(frame, ts);
  return { r, ms: performance.now() - t0 };
}

function detect(msg) {
  const out = { type: 'result', t: msg.t, width: msg.width, height: msg.height };
  const transfer = [];
  try {
    if (msg.face && tasks.face) {
      const { r, ms } = run('face', msg.face, msg.t);
      out.faceMs = ms;
      out.face = null;
      const lm = r.faceLandmarks?.[0];
      if (lm) {
        const landmarks = packLandmarks(lm);
        const m = r.facialTransformationMatrixes?.[0]?.data;
        const matrix = m ? Float32Array.from(m) : null;
        out.face = { landmarks, matrix };
        transfer.push(landmarks.buffer);
        if (matrix) transfer.push(matrix.buffer);
      }
    }
    if (msg.hands && tasks.hands) {
      const { r, ms } = run('hands', msg.hands, msg.t);
      out.handMs = ms;
      out.hands = (r.landmarks ?? []).map((lm, i) => {
        const landmarks = packLandmarks(lm);
        const world = packLandmarks(r.worldLandmarks?.[i] ?? lm);
        transfer.push(landmarks.buffer, world.buffer);
        const cat = r.handedness?.[i]?.[0];
        return { landmarks, world, handedness: cat?.categoryName ?? '', score: cat?.score ?? 0 };
      });
    }
  } finally {
    msg.face?.close?.();
    msg.hands?.close?.();
  }
  self.postMessage(out, transfer);
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    try {
      const delegates = await init(msg);
      self.postMessage({ type: 'ready', delegates });
    } catch (err) {
      self.postMessage({ type: 'error', error: String(err?.message ?? err) });
    }
  } else if (msg.type === 'frame') {
    try {
      detect(msg);
    } catch (err) {
      msg.face?.close?.();
      msg.hands?.close?.();
      self.postMessage({ type: 'result', t: msg.t, error: String(err?.message ?? err) });
    }
  }
};
