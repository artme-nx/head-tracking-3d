// Proceduralne teksture iz canvasa: mrlje i prašina na staklu, brušeni metal,
// gravirana mesingana pločica. Sve deterministički (seedani random).

import * as THREE from 'three';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Staklo: R = prašina (difuzno), G = hrapavost (mrlje, otisci), B = alfa (apsorpcija + prašina).
 */
export function createGlassSmudgeTexture(seed = 7, size = 1024) {
  const r = rng(seed);
  const c = canvas(size, size);
  const g = c.getContext('2d');

  // Bazne vrijednosti: R=0 (bez prašine), G=0.05 (glatko staklo), B=0.03 (blaga apsorpcija).
  g.fillStyle = 'rgb(0, 13, 8)';
  g.fillRect(0, 0, size, size);

  g.globalCompositeOperation = 'lighter';
  // Mekane mrlje (masnoća, tragovi brisanja) — samo G (hrapavost) i malo B.
  for (let i = 0; i < 9; i++) {
    const x = r() * size, y = r() * size;
    const rad = size * (0.06 + r() * 0.12);
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    const a = 0.05 + r() * 0.1;
    grad.addColorStop(0, `rgba(0, ${Math.round(70 * a)}, 0, 1)`);
    grad.addColorStop(1, 'rgba(0, 0, 0, 1)');
    g.fillStyle = grad;
    g.save();
    g.translate(x, y);
    g.rotate(r() * Math.PI);
    g.scale(1, 0.35 + r() * 0.6);
    g.translate(-x, -y);
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  // Tragovi brisanja (luk krpe) — vrlo slabi, isprekidani.
  for (let i = 0; i < 3; i++) {
    const x = r() * size, y = r() * size;
    const rad = size * (0.12 + r() * 0.18);
    const a0 = r() * 6;
    for (let k = 0; k < 9; k++) {
      g.strokeStyle = `rgba(0, ${4 + Math.round(r() * 6)}, 0, 1)`;
      g.lineWidth = 4 + r() * 10;
      g.beginPath();
      g.arc(x + r() * 6, y + r() * 6, rad + k * 3, a0 + r() * 0.2, a0 + 0.3 + r() * 0.5);
      g.stroke();
    }
  }
  // Prašina: sitne točkice (R i B).
  for (let i = 0; i < 260; i++) {
    const x = r() * size, y = r() * size;
    const s = r() < 0.94 ? 0.5 + r() * 0.6 : 1.1 + r() * 1.0;
    const v = 30 + Math.round(r() * 90);
    g.fillStyle = `rgb(${v}, ${Math.round(v * 0.25)}, ${Math.round(v * 0.12)})`;
    g.beginPath();
    g.arc(x, y, s, 0, Math.PI * 2);
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** Brušeni metal: fine pruge duž U — za roughnessMap (G) i bumpMap. */
export function createBrushedTexture(seed = 3, w = 1024, h = 256) {
  const r = rng(seed);
  const c = canvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = 'rgb(128,128,128)';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 2600; i++) {
    const y = r() * h;
    const x = r() * w;
    const len = 80 + r() * 600;
    const v = Math.round(90 + r() * 80);
    g.strokeStyle = `rgba(${v},${v},${v},${0.18 + r() * 0.3})`;
    g.lineWidth = 0.6 + r() * 1.2;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + len, y + (r() - 0.5) * 1.5);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

let fontsReady = null;
export function loadFonts() {
  if (!fontsReady) {
    const base = `${import.meta.env.BASE_URL}fonts/`;
    const faces = [
      new FontFace('Cormorant Garamond', `url(${base}CormorantGaramond.woff2)`, { weight: '300 700' }),
      new FontFace('Cormorant Garamond', `url(${base}CormorantGaramond-Italic.woff2)`, { style: 'italic', weight: '500' }),
      new FontFace('Barlow Condensed', `url(${base}BarlowCondensed-500.woff2)`, { weight: '500' }),
      new FontFace('Barlow Condensed', `url(${base}BarlowCondensed-600.woff2)`, { weight: '600' }),
    ];
    fontsReady = Promise.all(
      faces.map((f) =>
        f.load().then(
          (loaded) => document.fonts.add(loaded),
          () => null,
        ),
      ),
    );
  }
  return fontsReady;
}

/**
 * Gravirana mesingana pločica. Vraća { map, roughnessMap, bumpMap }.
 * map: boja mesinga s tamnom patinom u slovima; rough: slova grublja; bump: gravura.
 */
export async function createPlaqueTextures({ title, subtitle, year, w = 1400, h = 480 }) {
  await loadFonts();
  const make = () => {
    const c = canvas(w, h);
    return [c, c.getContext('2d')];
  };
  const drawText = (g, color) => {
    g.fillStyle = color;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    if ('letterSpacing' in g) g.letterSpacing = '18px';
    g.font = '600 118px "Cormorant Garamond", Georgia, serif';
    g.fillText(title, w / 2, h * 0.44);
    if ('letterSpacing' in g) g.letterSpacing = '2px';
    g.font = 'italic 500 58px "Cormorant Garamond", Georgia, serif';
    g.fillText(subtitle, w / 2, h * 0.67);
    if ('letterSpacing' in g) g.letterSpacing = '10px';
    g.font = '500 44px "Cormorant Garamond", Georgia, serif';
    g.fillText(year, w / 2, h * 0.86);
    // Tanka gravirana linija
    g.fillRect(w * 0.38, h * 0.535, w * 0.24, 3);
  };

  // Albedo (sRGB): mesing s blagim varijacijama + tamna patina u gravuri.
  const [ca, ga] = make();
  const r = rng(11);
  ga.fillStyle = '#b8955c';
  ga.fillRect(0, 0, w, h);
  for (let i = 0; i < 900; i++) {
    const y = r() * h;
    ga.strokeStyle = `rgba(${r() < 0.5 ? '255,236,200' : '90,60,20'},${0.04 + r() * 0.05})`;
    ga.lineWidth = 0.6 + r();
    ga.beginPath();
    ga.moveTo(0, y);
    ga.lineTo(w, y + (r() - 0.5) * 2);
    ga.stroke();
  }
  drawText(ga, '#2a1d10');

  // Hrapavost (G): polirano 0.25, slova 0.7.
  const [cr, gr] = make();
  gr.fillStyle = 'rgb(0, 64, 0)';
  gr.fillRect(0, 0, w, h);
  drawText(gr, 'rgb(0, 180, 0)');

  // Bump: ravno bijelo, gravura tamna (udubljenje), malo zamućeno.
  const [cb, gb] = make();
  gb.fillStyle = '#ffffff';
  gb.fillRect(0, 0, w, h);
  gb.filter = 'blur(1.2px)';
  drawText(gb, '#000000');
  gb.filter = 'none';

  const toTex = (c, srgb) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    return t;
  };
  return { map: toTex(ca, true), roughnessMap: toTex(cr, false), bumpMap: toTex(cb, false) };
}

/** Tekst u prstenu (oznake na objektivu oka): bijeli tekst na prozirnom. */
export async function createRingTextTexture(text, { size = 1024, inner = 0.66, outer = 0.94, font = '600 58px "Barlow Condensed", sans-serif' } = {}) {
  await loadFonts();
  const c = canvas(size, size);
  const g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  g.fillStyle = '#ffffff';
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const radius = (size / 2) * ((inner + outer) / 2);
  const chars = [...text];
  const total = chars.reduce((s, ch) => s + g.measureText(ch).width + 6, 0);
  let angle = -Math.PI / 2 - total / radius / 2;
  for (const ch of chars) {
    const wch = g.measureText(ch).width + 6;
    angle += wch / radius / 2;
    g.save();
    g.translate(size / 2 + Math.cos(angle) * radius, size / 2 + Math.sin(angle) * radius);
    g.rotate(angle + Math.PI / 2);
    g.fillText(ch, 0, 0);
    g.restore();
    angle += wch / radius / 2;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Tekstura s tekstom (natpisi, serijski brojevi) — bijelo na prozirnom. */
export async function createLabelTexture(lines, { w = 1024, h = 256, font = '600 120px "Barlow Condensed", sans-serif', align = 'left', color = '#ffffff', spacing = '4px' } = {}) {
  await loadFonts();
  const c = canvas(w, h);
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.fillStyle = color;
  g.textBaseline = 'middle';
  g.textAlign = align;
  if ('letterSpacing' in g) g.letterSpacing = spacing;
  const lh = h / lines.length;
  lines.forEach((line, i) => {
    g.font = line.font ?? font;
    const x = align === 'left' ? 8 : align === 'center' ? w / 2 : w - 8;
    g.fillText(line.text ?? line, x, lh * (i + 0.5));
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
