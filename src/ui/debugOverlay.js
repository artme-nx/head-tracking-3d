// D: mala slika kamere s točkama očiju, procijenjeni x/y/z u cm, FPS.

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

  draw({ tracker, source, eye, rect, stereo, sceneName, quality, orbitInfo }) {
    if (!this.visible) return;
    const { ctx, canvas } = this;
    const cw = canvas.width, ch = canvas.height;
    ctx.fillStyle = '#0c0e12';
    ctx.fillRect(0, 0, cw, ch);

    const video = tracker?.video;
    if (video && video.readyState >= 2) {
      const vw = video.videoWidth, vh = video.videoHeight;
      // "cover" crop + zrcaljenje (kao ogledalo, prirodnije za korisnika)
      const s = Math.max(cw / vw, ch / vh);
      const dw = vw * s, dh = vh * s;
      const ox = (cw - dw) / 2, oy = (ch - dh) / 2;
      ctx.save();
      ctx.translate(cw, 0);
      ctx.scale(-1, 1);
      ctx.globalAlpha = 0.85;
      ctx.drawImage(video, ox, oy, dw, dh);
      ctx.globalAlpha = 1;
      const raw = tracker.raw;
      if (raw && tracker.tracking) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        for (let i = 0; i < raw.landmarks.length; i += 6) {
          const p = raw.landmarks[i];
          ctx.fillRect(ox + p.x * dw - 0.5, oy + p.y * dh - 0.5, 1, 1);
        }
        ctx.fillStyle = '#ff5a5a';
        dot(ctx, ox + (raw.ax / raw.W) * dw, oy + (raw.ay / raw.H) * dh);
        ctx.fillStyle = '#4fd8ff';
        dot(ctx, ox + (raw.bx / raw.W) * dw, oy + (raw.by / raw.H) * dh);
      }
      ctx.restore();
    } else {
      ctx.fillStyle = '#6b7380';
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillText('nema kamere', 12, 22);
    }

    const f = (n) => (n >= 0 ? ' ' : '') + n.toFixed(1);
    this.text.textContent = [
      `izvor   ${source}`,
      `oko  x ${f(eye[0])} cm`,
      `     y ${f(eye[1])} cm`,
      `     z ${f(eye[2])} cm`,
      `prozor ${rect.width.toFixed(1)}×${rect.height.toFixed(1)} cm`,
      `kamera ${orbitInfo ?? 'WINDOW'}`,
      `scena  ${sceneName}${stereo ? ' · anaglif' : ''}${quality ? ` · ${quality}` : ''}`,
      `FPS    ${this.fps.toFixed(0)}` + (tracker?.ready ? `  · detekcija ${tracker.detectMs.toFixed(1)} ms` : ''),
    ].join('\n');
  }
}

function dot(ctx, x, y) {
  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.fill();
}
