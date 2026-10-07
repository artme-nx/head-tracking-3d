// Postavke i kalibracija. Sve duljine su u centimetrima.

const STORAGE_KEY = 'head-tracking-3d:settings:v1';

// MacBook Air 13" (M2/M3, 13,6", 2560×1664): aktivna površina ≈ 28,9 × 18,8 cm,
// FaceTime kamera sjedi u "notchu" ≈ 0,6 cm iznad gornjeg ruba slike.
export const DEFAULTS = Object.freeze({
  screenWidth: 28.9,
  screenHeight: 18.8,
  cameraOffset: 0.6, // udaljenost kamere iznad gornjeg ruba ekrana
  cameraFov: 60, // horizontalni FOV web kamere u stupnjevima
  ipd: 6.3, // razmak zjenica (63 mm)
  stereoStrength: 1.0, // 0 = bez stereo razmaka, 1 = stvarni IPD
  eye: 'center', // 'center' | 'left' | 'right' — iz kojeg oka se gleda u mono načinu
  smoothing: 1.0, // minCutoff One Euro filtera (Hz) — manje = mirnije, više = brže
  responsiveness: 0.04, // beta One Euro filtera — veće = manje kašnjenja pri brzim pokretima
  compensateWindow: true, // uzmi u obzir položaj prozora kad nije fullscreen
});

export const FIELDS = [
  { key: 'screenWidth', label: 'Širina ekrana', unit: 'cm', min: 10, max: 200, step: 0.1 },
  { key: 'screenHeight', label: 'Visina ekrana', unit: 'cm', min: 5, max: 150, step: 0.1 },
  { key: 'cameraOffset', label: 'Kamera iznad ruba', unit: 'cm', min: -5, max: 20, step: 0.1 },
  { key: 'cameraFov', label: 'FOV kamere (horiz.)', unit: '°', min: 30, max: 120, step: 1 },
  { key: 'ipd', label: 'Razmak zjenica', unit: 'cm', min: 5, max: 7.5, step: 0.05 },
  { key: 'stereoStrength', label: 'Jačina stereo efekta', unit: '×', min: 0, max: 2, step: 0.05, range: true },
  { key: 'smoothing', label: 'Zaglađivanje (min cutoff)', unit: 'Hz', min: 0.1, max: 5, step: 0.05, range: true },
  { key: 'responsiveness', label: 'Brzina odziva (beta)', unit: '', min: 0, max: 0.3, step: 0.005, range: true },
];

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (typeof parsed[k] === typeof DEFAULTS[k]) out[k] = parsed[k];
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* privatni prozor ili blokirana pohrana — postavke vrijede samo za ovu sesiju */
  }
}

export function clearSettings() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
