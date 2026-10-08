// SDF modeli robota (glava i poprsje). Koordinate "oka": ishodište je točka
// između očiju, +x desno (robotovo lijevo), +y gore, +z naprijed prema gledatelju.
// Jedinice: cm, ljudsko mjerilo (skalira se u sceni).
//
// Lice je "maska" zadana visinskim poljem z = F(x, y) (profil, nos, obrve,
// jagodice, usne, brada) koje reže volumen glave; očne duplje su duboke rupe za
// mehaničke oči. Paneli (maska, čeljust, lubanja, karbonski greben) su zasebne
// ljuske s pravim procjepima kroz koje se vidi tamna unutarnja lubanja.

import {
  sdEllipsoid,
  sdSphere,
  sdCapsule,
  sdCylinderZ,
  sdCylinderX,
  sdCylinderY,
  sdRoundBox,
  smin,
  smax,
} from './sdf.js';

const { abs, exp, sqrt, max, min } = Math;

export const EYE_X = 3.15;
export const EYE_Z = -1.3; // središte očne jabučice iza ravnine lica
export const SOCKET_R = 1.62;

// --- Profil lica ---------------------------------------------------------
// Središnja linija lica (x = 0) bez nosa: [y, z] točke, glatka interpolacija.
const PROFILE = [
  [-13.4, -6.0],
  [-11.5, -2.0],
  [-10.6, -0.1],
  [-9.4, 0.95], // brada
  [-8.3, 0.75], // udubina ispod usne
  [-6.8, 1.15], // donja usna
  [-6.1, 1.0], // linija usta
  [-5.3, 1.3], // gornja usna
  [-4.3, 1.25], // ispod nosa
  [-2.0, 0.95],
  [0.0, 0.75], // korijen nosa (između očiju)
  [1.8, 1.2], // obrve
  [3.5, 0.95],
  [6.0, -0.15], // čelo
  [8.5, -2.3],
  [10.5, -6.0],
];

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

// Unaprijed tabelirani profil (brzo uzorkovanje) — vrijednost i derivacija po y.
const PY0 = -14, PY1 = 10.5, PN = 512;
const profZ = new Float32Array(PN + 1);
const profD = new Float32Array(PN + 1);
(() => {
  const ys = PROFILE.map((p) => p[0]);
  const zs = PROFILE.map((p) => p[1]);
  for (let i = 0; i <= PN; i++) {
    const y = PY0 + ((PY1 - PY0) * i) / PN;
    let k = 0;
    while (k < ys.length - 2 && y > ys[k + 1]) k++;
    const t = Math.min(1, Math.max(0, (y - ys[k]) / (ys[k + 1] - ys[k])));
    const z = catmull(zs[Math.max(0, k - 1)], zs[k], zs[k + 1], zs[Math.min(zs.length - 1, k + 2)], t);
    profZ[i] = z;
  }
  for (let i = 0; i <= PN; i++) {
    const a = profZ[Math.max(0, i - 1)], b = profZ[Math.min(PN, i + 1)];
    profD[i] = (b - a) / (((i === 0 || i === PN ? 1 : 2) * (PY1 - PY0)) / PN);
  }
})();

function profile(y, out) {
  const f = ((Math.min(PY1, Math.max(PY0, y)) - PY0) / (PY1 - PY0)) * PN;
  const i = Math.min(PN - 1, Math.floor(f));
  const t = f - i;
  out[0] = profZ[i] + (profZ[i + 1] - profZ[i]) * t;
  out[1] = profD[i] + (profD[i + 1] - profD[i]) * t;
}

const _p = new Float64Array(2);

/** Visinsko polje lica F(x,y) i njegov gradijent → aproksimirana udaljenost do površine maske. */
function faceField(x, y, z) {
  profile(y, _p);
  let F = _p[0];
  let Fy = _p[1];
  let Fx = 0;
  const ax = abs(x);
  const sx = x < 0 ? -1 : 1;

  // Bočna zakrivljenost lica (ravnije sprijeda, naglo unatrag prema sljepoočnicama).
  const c2 = 0.06 + 0.012 * Math.max(0, -y - 4) * 0.25;
  F -= c2 * x * x + 0.0032 * x * x * x * x;
  Fx -= sx * (2 * c2 * ax + 4 * 0.0032 * ax * ax * ax);

  // Nos: uski, oštri greben ("šator" profil) od korijena do vrha — android, ne karikatura.
  {
    const t = Math.min(1, Math.max(0, (0.4 - y) / 3.75)); // 0 korijen, 1 vrh
    const tipFade = y < -3.35 ? exp(-((y + 3.35) * (y + 3.35)) / 0.06) : 1;
    const topFade = y > 0.4 ? exp(-((y - 0.4) * (y - 0.4)) / 0.4) : 1;
    const h = (0.32 + 0.95 * t * t) * tipFade * topFade;
    const w = 0.55 + 0.6 * t;
    // Zaglađena apsolutna vrijednost da greben ima mekani hrbat.
    const sa = sqrt(x * x + 0.02);
    const tent = max(0, 1 - sa / w);
    F += h * tent * tent;
    Fx += sa < w ? -h * 2 * tent * (x / sa) / w : 0;
  }
  // Obrve: greben preko čela (baca sjenu u duplje).
  {
    const wy = exp(-((y - 1.9) * (y - 1.9)) / 0.5);
    const wx = exp(-((ax - 2.8) * (ax - 2.8)) / 8.0);
    const h = 0.62 * wy * wx;
    F += h;
    Fy += h * (-2 * (y - 1.9) / 0.5);
    Fx += h * (-2 * (ax - 2.8) / 8.0) * sx;
  }
  // Jagodice.
  {
    const dx = ax - 4.55, dy = y + 2.05;
    const h = 0.78 * exp(-(dx * dx) / 2.2 - (dy * dy) / 1.3);
    F += h;
    Fx += h * (-2 * dx / 2.2) * sx;
    Fy += h * (-2 * dy / 1.6);
  }
  // Orbite (plitko udubljenje oko očiju, izduženo vodoravno).
  {
    const dx = ax - EYE_X, dy = y - 0.05;
    const h = -1.05 * exp(-(dx * dx) / 3.0 - (dy * dy) / 1.5);
    F += h;
    Fx += h * (-2 * dx / 2.6) * sx;
    Fy += h * (-2 * dy / 2.1);
  }
  // Brada (blago istaknuta, šira).
  {
    const dy = y + 9.9;
    const h = 0.35 * exp(-(x * x) / 3.2 - (dy * dy) / 1.4);
    F += h;
    Fx += h * (-2 * x / 3.2);
    Fy += h * (-2 * dy / 1.4);
  }
  const n = sqrt(1 + Fx * Fx + Fy * Fy);
  return (z - F) / n;
}

/** Puni volumen glave s izrezanim dupljama, ustima, ušima i otvorom za vrat. */
export function headSolid(x, y, z) {
  const ax = abs(x);
  // Lubanja (jaje) + volumen lica.
  let d = sdEllipsoid(x, y - 2.7, z + 7.5, 7.45, 9.05, 9.3);
  const face = sdEllipsoid(x, y + 4.0, z + 3.2, 6.2, 7.2, 7.4);
  d = smin(d, face, 3.2);
  // Čeljust se sužava prema bradi (tvrdi "hard surface" brid čeljusti).
  const jawPlane = ax * 0.905 + (-y - 3.0) * 0.425 - 6.25;
  d = smax(d, jawPlane, 0.9);
  // Ravno dno brade.
  d = smax(d, -y - 11.0, 0.7);
  // Daleko od površine nema smisla računati detalje (brzina u workeru).
  if (d > 2.5) return d;
  // Lice = visinsko polje, primijenjeno samo u prednjem području.
  if (z > -9 && ax < 9.5) {
    const region = sdRoundBox(x, y + 2.0, 0, 6.2, 10.2, 50, 2.5);
    const cut = smin(faceField(x, y, z), -region * 1.5 + 0.8, 1.2);
    d = smax(d, cut, 0.55);
  }
  // Duboke očne duplje (cilindar + zaobljeni ulaz).
  if (abs(y) < 4.5 && z > -6.5 && ax > 0.2 && ax < 6.8) {
    const ex = ax - EYE_X;
    const hole = sdCylinderZ(ex, y - 0.05, z - 1.2, SOCKET_R, 4.5, 0.0);
    const flare = sdEllipsoid(ex, y - 0.05, z - 1.15, SOCKET_R + 0.55, SOCKET_R + 0.3, 1.2);
    d = smax(d, -smin(hole, flare, 0.45), 0.3);
  }
  // Usta: tanki mehanički prorez (zvučnik), bez "osmijeha".
  if (abs(y + 6.1) < 1.2 && ax < 3.0 && z > -1.5) {
    const slot = sdRoundBox(x, y + 6.1, z - 1.4, 1.45, 0.06, 1.2, 0.04);
    d = smax(d, -slot, 0.1);
  }
  // Ležišta za "uši" (servo moduli, uvučeni u lubanju).
  if (ax > 4.5 && abs(y + 0.9) < 4 && abs(z + 6.9) < 4) {
    const ear = sdCylinderX(ax - 7.6, y + 0.9, z + 6.9, 2.25, 1.6, 0.25);
    d = smax(d, -ear, 0.3);
  }
  // Otvor za vrat odozdo.
  if (y < -6 && ax < 6.5 && abs(z + 6.4) < 6.5) {
    const neck = sdCylinderY(x, y + 13.5, z + 6.4, 4.1, 4.8, 0.6);
    d = smax(d, -neck, 0.6);
  }
  return d;
}

// --- Regije panela ---------------------------------------------------------
const GAP = 0.11; // pola širine procjepa
const TEMPLE_GAP = 0.42; // širi procjep na sljepoočnicama (vidi se mehanika)
const SHELL = 0.42; // debljina panela

function regionFace(x, y, z) {
  // Prednji elipsoid: maska do linije kose i ispred ušiju.
  return sdEllipsoid(x, y + 1.6, z - 0.7, 6.55, 10.4, 6.9);
}

function regionJaw(x, y, z) {
  // Spoj čeljusti: ispod donje usne, blagi luk prema kutovima čeljusti.
  return y + 7.75 - 0.014 * x * x + 0.0 * z;
}

function regionCrest(x, y) {
  return max(abs(x) - 1.2, -(y - 3.5));
}

// --- Unutarnji kavez glave ------------------------------------------------------
// Ljuska ispod panela s velikim prozorima: ostaju trake (sagitalna, ekvator na
// razini očiju, gornji prsten, koronalni luk), prsteni oko duplji, nosači ušiju i
// puni donji dio uz vrat. Kad se paneli rastave, kroz prozore se vidi mehanika.
const CAGE_HEAD = [0.55, 1.15]; // dubina vanjske i unutarnje plohe kaveza ispod površine

function headCage(x, y, z, h) {
  const shell = max(h + CAGE_HEAD[0], -(h + CAGE_HEAD[1]));
  if (shell > 0.8) return shell;
  const ax = abs(x);
  let F = ax - 0.8;
  F = min(F, abs(y - 0.25) - 0.95);
  F = min(F, abs(y - 6.0) - 0.65);
  F = min(F, abs(z + 7.6) - 0.8);
  F = min(F, y + 6.4);
  if (z > -6.5) F = min(F, sqrt((ax - EYE_X) * (ax - EYE_X) + (y - 0.05) * (y - 0.05)) - (SOCKET_R + 1.25));
  if (ax > 3.8) F = min(F, sqrt((y + 0.9) * (y + 0.9) + (z + 6.9) * (z + 6.9)) - 3.2);
  return smax(shell, F, 0.25);
}

export function robotHeadModel({ step = 0.095 } = {}) {
  // Kranij je podijeljen na lijevu i desnu polovicu (rastavljanje ide u stranu).
  const pieces = ['face', 'jaw', 'craniumL', 'craniumR', 'crest', 'cage'];
  return {
    pieces,
    bounds: [-8.6, -13.6, -18.2, 8.6, 12.6, 4.4],
    step,
    block: 8,
    cullMargin: 0.3,
    minAux: [-0.62, -0.62, -0.62, -0.62, -0.62, -1e9],
    shellDepth: true, // dubina vrhova (unutarnja ploha panela je sirovi, mat kompozit)
    simplifyError: 0.006,
    normalEpsilon: 0.03,
    eval(x, y, z, out) {
      const h = headSolid(x, y, z);
      // Ljuska panela: od površine do dubine SHELL.
      const shell = max(h, -(h + SHELL));
      const rf = regionFace(x, y, z);
      const rj = regionJaw(x, y, z);
      const rc = regionCrest(x, y);
      const bevel = 0.09;
      // Procjep je širi na sljepoočnicama (između obrve i čeljusti, sa strane).
      const ss = (a, b, v) => {
        const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
        return t * t * (3 - 2 * t);
      };
      const tm = ss(3.8, 5.0, abs(x)) * ss(-6.5, -4.6, y) * (1 - ss(2.8, 4.3, y));
      const tw = GAP + (TEMPLE_GAP - GAP) * tm;
      // Maska: prednja regija, iznad čeljusti.
      out[0] = smax(smax(shell, rf + GAP, bevel), -rj + GAP, bevel);
      // Čeljust: prednja regija ispod linije usta.
      out[1] = smax(smax(shell, rf + GAP, bevel), rj + GAP, bevel);
      // Lubanja: izvan prednje regije, bez grebena; lijeva i desna polovica.
      const cranium = smax(smax(shell, -rf + tw * 2 - GAP, bevel), -rc + GAP, bevel);
      out[2] = smax(cranium, x + GAP, bevel);
      out[3] = smax(cranium, -x + GAP, bevel);
      // Karbonski greben: malo uvučen.
      const crestShell = max(h + 0.12, -(h + SHELL));
      out[4] = smax(smax(crestShell, rc + GAP * 0.5, bevel), -rf + GAP, bevel);
      // Unutarnji kavez (vidi se kroz procjepe, a rastavljen otkriva mehaniku).
      out[5] = headCage(x, y, z, h);
      out[6] = h; // pomoćni kanal: odbaci duboke unutarnje stijenke ljuski
      // Sve površine su unutar pojasa h ∈ [-1.25, 0] → udaljenost do pojasa.
      return h > 0 ? h : h < -1.25 ? -(h + 1.25) : 0;
    },
  };
}

// --- Poprsje -----------------------------------------------------------------
export function torsoSolid(x, y, z) {
  const ax = abs(x);
  // Prsni koš.
  let d = sdEllipsoid(x, y + 33.5, z + 7.2, 15.0, 12.5, 9.4);
  // Trapez / ramena.
  d = smin(d, sdCapsule(ax, y, z, 3.5, -22.4, -8.6, 14.5, -26.0, -8.2, 3.4), 3.6);
  // Ramena (deltoid: izduženi elipsoid, ne kugla).
  d = smin(d, sdEllipsoid(ax - 16.4, y + 28.4, z + 7.6, 4.6, 5.6, 4.9), 2.4);
  // Ključne kosti (blagi greben sprijeda).
  d = smin(d, sdCapsule(ax, y, z, 1.5, -24.6, -2.2, 12.5, -24.2, -4.6, 1.3), 1.6);
  // Otvor za vrat.
  d = smax(d, -sdCylinderY(x, y + 21.5, z + 6.4, 4.7, 3.0, 0.8), 0.7);
  // Rez dolje (dovoljno nisko da se ni u ORBIT načinu ne vidi).
  d = smax(d, -y - 57, 0.5);
  return d;
}

function regionChest(x, y, z) {
  // Prsna ploča: sprijeda, između ramena.
  return max(sdRoundBox(x, y + 33.5, 0, 10.5, 9.0, 40, 3.0), -(z + 6.0));
}

function regionShoulder(x, y, z) {
  return sdEllipsoid(abs(x) - 16.6, y + 28.6, z + 7.6, 5.3, 6.4, 5.6);
}

// --- Unutarnji kavez poprsja: rebra, prsna kost / kralježnica, ležišta ramena,
// pun gornji prsten oko vrata i okrugli otvor sprijeda za reaktor u prsima.
const CAGE_BODY = [0.75, 1.4];
export const CORE_CENTER = [0, -29.8, -6.6]; // središte reaktora (prostor poprsja)

function bodyCage(x, y, z, h) {
  const shell = max(h + CAGE_BODY[0], -(h + CAGE_BODY[1]));
  if (shell > 0.9) return shell;
  const ax = abs(x);
  const u = (y + 26.6) / 3.3;
  let F = abs(u - Math.round(u)) * 3.3 - 0.55; // rebra
  F = min(F, ax - 1.3); // prsna kost sprijeda, kralježnica straga
  F = min(F, -y - 25.0); // gornji prsten oko vrata
  F = min(F, y + 50.0); // donji rub
  F = min(F, sqrt((ax - 16.2) * (ax - 16.2) + (y + 28.4) * (y + 28.4) + (z + 7.6) * (z + 7.6)) - 6.2);
  let d = smax(shell, F, 0.3);
  // Okrugli otvor sprijeda (kroz njega se vidi reaktor).
  const port = max(sqrt(x * x + (y - CORE_CENTER[1]) * (y - CORE_CENTER[1])) - 4.0, -(z + 7.5));
  d = smax(d, -port, 0.25);
  return d;
}

export function robotBodyModel({ step = 0.14 } = {}) {
  return {
    // Ramena su podijeljena na lijevo/desno (rastavljanje ide u stranu). Karbonski plašt
    // ostaje cijeli: kroz njega prolaze kabeli i klipovi vrata.
    pieces: ['chest', 'shoulderL', 'shoulderR', 'trapezius', 'cage'],
    bounds: [-24, -58.5, -20, 24, -17, 4],
    step,
    block: 8,
    cullMargin: 0.4,
    minAux: [-0.75, -0.75, -0.75, -0.75, -1e9],
    shellDepth: true,
    simplifyError: 0.008,
    normalEpsilon: 0.04,
    eval(x, y, z, out) {
      const h = torsoSolid(x, y, z);
      const shell = max(h, -(h + 0.55));
      const rc = regionChest(x, y, z);
      const rs = regionShoulder(x, y, z);
      const bevel = 0.12;
      const g = 0.13;
      out[0] = smax(smax(shell, rc + g, bevel), -rs + g, bevel);
      const shoulders = smax(shell, rs + g, bevel);
      out[1] = max(shoulders, x);
      out[2] = max(shoulders, -x);
      const carbon = max(h + 0.1, -(h + 0.55));
      out[3] = smax(smax(carbon, -rc + g, bevel), -rs + g, bevel);
      out[4] = bodyCage(x, y, z, h);
      out[5] = h;
      return h > 0 ? h : h < -1.5 ? -(h + 1.5) : 0;
    },
  };
}
