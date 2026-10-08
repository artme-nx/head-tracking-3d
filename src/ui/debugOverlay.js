// D: mala slika kamere s točkama očiju i kosturima ruku, procijenjeni x/y/z u cm,
// prepoznata gesta, 3D položaj vrha prsta, FPS.

import { GESTURE_LABEL } from '../tracking/gestures.js';

const HAND_LINKS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];
const HAND_COLOR = { L: '#ffb86b', D: '#7fd8ff', '?': '#d6dbe3' };

export class DebugOverlay {
  constructor() {
    this.root = document.getElementById('debug');
    this.canvas = document.getElementById('debug-cam');
    this.ctx = this.canvas.getContext('2d');
    this.text = document.getElementById('debug-text');
    this.visible = false;
    this.frames = 0;
    this.fps = 0;
    this.fpsTime = performance.now();
  }

  toggle(force) {
    this.visible = force ?? !this.visible;
    this.root.hidden = !this.visible;
  }

  /** Brojanje FPS-a radi i kad je overlay skriven (koristi ga i HUD). */
  tick(now) {
    this.frames++;
    if (now - this.fpsTime >= 500) {
      this.fps = (this.frames * 1000) / (now - this.fpsTime);
      this.frames = 0;
      this.fpsTime = now;
    }
  }

  draw({ tracker, hands, hand, vision, source, eye, rect, stereo, sceneName, quality, orbitInfo }) {
    if (!this.visible) return;
    const { ctx, canvas } = this;
    const cw = canvas.width, ch = canvas.height;
    ctx.fillStyle = '#0c0e12';
    ctx.fillRect(0, 0, cw, ch);

    const video = tracker?.video;
    let map = null;
    if (video && video.readyState >= 2) {
      const vw = video.videoWidth, vh = video.videoHeight;
      // "cover" crop + zrcaljenje (kao ogledalo, prirodnije za korisnika)
      const s = Math.max(cw / vw, ch / vh);
      const dw = vw * s, dh = vh * s;
      const ox = (cw - dw) / 2, oy = (ch - dh) / 2;
      // Normalizirana točka slike → piksel u (zrcaljenom) prikazu.
      map = (x, y) => [cw - (ox + x * dw), oy + y * dh];
      ctx.save();
      ctx.translate(cw, 0);
      ctx.scale(-1, 1);
      ctx.globalAlpha = 0.85;
      ctx.drawImage(video, ox, oy, dw, dh);
      ctx.globalAlpha = 1;
      ctx.restore();

      const raw = tracker.raw;
      if (raw && tracker.tracking) {
        const L = raw.landmarks;
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        for (let i = 0; i < L.length / 3; i += 6) {
          const [x, y] = map(L[i * 3], L[i * 3 + 1]);
          ctx.fillRect(x - 0.5, y - 0.5, 1, 1);
        }
        ctx.fillStyle = '#ff5a5a';
        dot(ctx, ...map(raw.ax / raw.W, raw.ay / raw.H));
        ctx.fillStyle = '#4fd8ff';
        dot(ctx, ...map(raw.bx / raw.W, raw.by / raw.H));
      }
      // Područje očiju; žuto dok ga ruka zaklanja (položaj glave se drži).
      const e = tracker.eyeBox;
      if (e && tracker.tracking) {
        const [ax, ay] = map(e.x1, e.y0);
        const [bx, by] = map(e.x0, e.y1);
        ctx.strokeStyle = tracker.held ? '#ffd166' : 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 1;
        ctx.strokeRect(ax, ay, bx - ax, by - ay);
      }
      // Kosturi ruku s oznakom geste.
      for (const t of hands?.tracks ?? []) {
        if (!t.landmarks) continue;
        const L = t.landmarks;
        const col = HAND_COLOR[t.label] ?? HAND_COLOR['?'];
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (const [a, b] of HAND_LINKS) {
          ctx.moveTo(...map(L[a * 3], L[a * 3 + 1]));
          ctx.lineTo(...map(L[b * 3], L[b * 3 + 1]));
        }
        ctx.stroke();
        ctx.fillStyle = col;
        for (let i = 0; i < 21; i++) {
          const [x, y] = map(L[i * 3], L[i * 3 + 1]);
          ctx.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
        }
        ctx.fillStyle = '#ffffff';
        dot(ctx, ...map(L[24], L[25]), 2.6);
        const [wx, wy] = map(L[0], L[1]);
        ctx.font = '600 10px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(8,10,14,0.75)';
        const label = `${t.label} ${GESTURE_LABEL[t.gesture] ?? t.gesture}`;
        const w = ctx.measureText(label).width + 8;
        ctx.fillRect(wx - w / 2, wy + 4, w, 14);
        ctx.fillStyle = col;
        ctx.fillText(label, wx, wy + 14.5);
        ctx.textAlign = 'start';
      }
    } else {
      ctx.fillStyle = '#6b7380';
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillText('nema kamere', 12, 22);
    }

    const f = (n) => (n >= 0 ? ' ' : '') + n.toFixed(1);
    const lines = [
      `izvor   ${source}${tracker?.held ? ' · ruka zaklanja lice, držim položaj' : ''}`,
      `oko  x ${f(eye[0])} cm`,
      `     y ${f(eye[1])} cm`,
      `     z ${f(eye[2])} cm`,
      `prozor ${rect.width.toFixed(1)}×${rect.height.toFixed(1)} cm`,
      `kamera ${orbitInfo ?? 'WINDOW'}`,
      `scena  ${sceneName}${stereo ? ' · anaglif' : ''}${quality ? ` · ${quality}` : ''}`,
    ];
    // Ruke: gesta, raširenost, 3D položaj vrha kažiprsta (world cm) i doseg.
    if (hand?.hands.length) {
      const desc = hand.hands
        .filter((v) => v.alive)
        .map((v) => {
          let g = GESTURE_LABEL[v.gesture] ?? v.gesture;
          if (v.gesture === 'open') g += ` ${(v.spread * 100).toFixed(0)} %`;
          return `${v.label} ${g}`;
        })
        .join(' · ');
      lines.push(`ruke   ${hand.source} · ${desc || '—'}`);
      const p = hand.primary ?? hand.hands[0];
      lines.push(`prst   x ${f(p.tip.x)} y ${f(p.tip.y)} z ${f(p.tip.z)} cm`);
      const dist = p.distanceCm ? `${p.distanceCm.toFixed(0)} cm od kamere · ` : '';
      lines.push(`       ${dist}r ${Math.exp(p.logR).toFixed(2)} · doseg ${p.reach.toFixed(2)}`);
    } else {
      lines.push('ruke   —');
    }
    if (hand?.frame?.valid) lines.push('okvir  dvije ruke ▭');
    lines.push(`FPS    ${this.fps.toFixed(0)}`);
    if (vision?.ready) {
      const where = vision.mode === 'worker' ? `worker ${vision.delegates?.face ?? ''}` : 'glavna nit';
      lines.push(`detek. ${where} · kamera ${vision.cameraRate.hz.toFixed(0)} fps`);
      lines.push(`       lice ${vision.faceMs.toFixed(0)} ms ${vision.faceRate.hz.toFixed(0)} Hz · ruke ${vision.handMs.toFixed(0)} ms ${vision.handRate.hz.toFixed(0)} Hz`);
    }
    this.text.textContent = lines.join('\n');
  }
}

function dot(ctx, x, y, r = 3.5) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
