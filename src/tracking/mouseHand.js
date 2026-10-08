// Miš glumi ruku (za testiranje bez kamere):
//   Shift (drži) + miš   = vrh ispruženog kažiprsta
//   Shift + klik (drži)  = pinch
//   Shift + kotačić      = dubina prsta (prema ekranu / prema sebi)
//   O (drži)             = otvoren dlan; raširenost prstiju raste dok držiš
//   Z (drži)             = šaka
//   Razmak               = brzi tap prema ekranu
//   B (drži) + miš       = okvir od dvije ruke (vuci pravokutnik od točke pritiska)
// Izlaz ima isti oblik kao HandTracker trag, pa ostatak programa ne razlikuje izvore.

const NEUTRAL_LOG_R = Math.log(0.62);

export class MouseHand {
  constructor() {
    this.ndc = [0, 0];
    this.logR = NEUTRAL_LOG_R;
    this.keys = new Set();
    this.button = false;
    this.spread = 0;
    this.frameAnchor = null;
    this.events = [];
    this.lastActive = 0;
    this.track = {
      id: 'miš',
      label: 'M',
      gesture: 'none',
      spread: 0,
      pinch: 0,
      pts: { tip: [0, 0, NEUTRAL_LOG_R], pinch: [0, 0, NEUTRAL_LOG_R], palm: [0, -0.12, NEUTRAL_LOG_R] },
      distanceCm: 37,
      features: null,
      landmarks: null,
      simulated: true,
    };
    this.frame = { valid: false, rect: null, since: 0 };

    window.addEventListener('pointermove', (e) => {
      this.ndc[0] = (e.clientX / window.innerWidth) * 2 - 1;
      this.ndc[1] = 1 - (e.clientY / window.innerHeight) * 2;
    });
    window.addEventListener('pointerdown', (e) => {
      if (e.button === 0 && e.shiftKey) this.button = true;
    });
    window.addEventListener('pointerup', (e) => {
      if (e.button === 0) this.button = false;
    });
    window.addEventListener(
      'wheel',
      (e) => {
        if (!e.shiftKey) return;
        // Shift + kotačić na macOS-u često dolazi kao vodoravno pomicanje.
        const d = e.deltaY || e.deltaX;
        this.logR = Math.min(Math.log(1.0), Math.max(Math.log(0.18), this.logR + d * 0.0016));
      },
      { passive: true },
    );
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target?.closest?.('input, select, textarea, form')) return;
      const k = e.key.toLowerCase();
      if (k === 'shift' || k === 'o' || k === 'z' || k === 'b') {
        if (k === 'b' && !this.keys.has('b')) this.frameAnchor = [...this.ndc];
        this.keys.add(k);
      }
      if (e.code === 'Space' && !e.repeat) {
        this.events.push({ type: 'tap', hand: 'miš', ndc: [...this.ndc] });
        this.tapPulse = performance.now();
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      this.keys.delete(k);
      if (k === 'shift') this.button = false;
      if (k === 'b') this.frameAnchor = null;
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.button = false;
      this.frameAnchor = null;
    });
  }

  /** Je li miš-ruka trenutno aktivna (drži se neka tipka za simulaciju)? */
  get active() {
    return this.keys.size > 0 || performance.now() - (this.tapPulse ?? -1e9) < 350;
  }

  /** Shift drži miš za prst — kamera (miš-glava) se tada ne smije micati. */
  get capturesMouse() {
    return this.keys.size > 0;
  }

  update(nowMs, dt) {
    const k = this.keys;
    const tr = this.track;
    // Raširenost: raste dok se drži O (prsti se postupno šire), pada kad se pusti.
    this.spread = k.has('o') ? Math.min(1, this.spread + dt / 1.1) : Math.max(0, this.spread - dt / 0.35);
    let gesture = 'none';
    if (k.has('z')) gesture = 'fist';
    else if (k.has('o')) gesture = 'open';
    else if (k.has('shift') && this.button) gesture = 'pinch';
    else if (k.has('shift') || this.tapPulse) gesture = 'point';
    if (gesture !== tr.gesture) tr.gestureSince = nowMs;
    tr.gesture = gesture;
    tr.spread = this.spread;
    tr.pinch = gesture === 'pinch' ? 1 : 0;
    for (const p of [tr.pts.tip, tr.pts.pinch]) {
      p[0] = this.ndc[0];
      p[1] = this.ndc[1];
      p[2] = this.logR;
    }
    tr.pts.palm[0] = this.ndc[0];
    tr.pts.palm[1] = this.ndc[1] - 0.12;
    tr.pts.palm[2] = this.logR + 0.05;
    tr.lastSeen = nowMs;
    if (performance.now() - (this.tapPulse ?? -1e9) > 350) this.tapPulse = 0;

    // Okvir: pravokutnik od točke pritiska tipke B do miša.
    const fr = this.frame;
    const wasValid = fr.valid;
    if (k.has('b') && this.frameAnchor) {
      const a = this.frameAnchor, b = this.ndc;
      fr.rect = { x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) };
      fr.valid = fr.rect.x1 - fr.rect.x0 > 0.22 && fr.rect.y1 - fr.rect.y0 > 0.16;
    } else {
      fr.valid = false;
    }
    if (fr.valid && !wasValid) fr.since = nowMs;

    const events = this.events;
    this.events = [];
    return events;
  }
}
