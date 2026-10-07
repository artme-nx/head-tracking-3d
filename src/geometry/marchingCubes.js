// Marching cubes s blokovskim (narrow-band) uzorkovanjem i više polja odjednom.
// Model daje: bounds, step, eval(x,y,z,out) → upisuje vrijednosti polja po dijelu
// (out[0..K-1]) i pomoćni kanal out[K] (npr. udaljenost do vanjske ljuske), a vraća
// konzervativnu udaljenost do najbliže površine za preskakanje praznih blokova.

import { edgeTable, triTable } from './mcTables.js';

// Bourke: kutovi kocke i bridovi.
const CORNER = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const EDGE = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];
// Za globalni ključ brida: koji kut je "manji" i po kojoj osi brid ide.
const EDGE_AXIS = EDGE.map(([a, b]) => {
  const ca = CORNER[a], cb = CORNER[b];
  const axis = ca[0] !== cb[0] ? 0 : ca[1] !== cb[1] ? 1 : 2;
  const lo = ca[axis] < cb[axis] ? ca : cb;
  return { axis, lo };
});

class Growable {
  constructor(Type, cap = 1 << 16) {
    this.Type = Type;
    this.a = new Type(cap);
    this.n = 0;
  }
  push(v) {
    if (this.n >= this.a.length) {
      const b = new this.Type(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  view() {
    return this.a.subarray(0, this.n);
  }
}

/**
 * @returns {{positions: Float32Array, indices: Uint32Array}[]} jedna mreža po polju
 */
export function polygonize(model) {
  const K = model.pieces.length;
  const [x0, y0, z0, x1, y1, z1] = model.bounds;
  const h = model.step;
  const NX = Math.ceil((x1 - x0) / h);
  const NY = Math.ceil((y1 - y0) / h);
  const NZ = Math.ceil((z1 - z0) / h);
  const B = model.block ?? 8;
  const BX = Math.ceil(NX / B), BY = Math.ceil(NY / B), BZ = Math.ceil(NZ / B);
  const P = B + 1;
  const stride = K + 1;
  const values = new Float32Array(P * P * P * stride);
  const out = new Float64Array(stride);
  const blockRadius = (Math.sqrt(3) * B * h) / 2;
  const margin = model.cullMargin ?? 0;
  const minAux = model.minAux ?? null; // po dijelu: odbaci ćelije dublje od ovoga

  const pos = [], idx = [], maps = [];
  for (let k = 0; k < K; k++) {
    pos.push(new Growable(Float32Array));
    idx.push(new Growable(Uint32Array));
    maps.push(new Map());
  }

  const cornerVals = new Float64Array(8);
  const edgeVert = new Int32Array(12);
  let evaluated = 0;

  for (let bk = 0; bk < BZ; bk++) {
    for (let bj = 0; bj < BY; bj++) {
      for (let bi = 0; bi < BX; bi++) {
        const ci = bi * B, cj = bj * B, ck = bk * B;
        // Preskoči blokove daleko od svih površina.
        const cx = x0 + (ci + B / 2) * h, cy = y0 + (cj + B / 2) * h, cz = z0 + (ck + B / 2) * h;
        const dist = model.eval(cx, cy, cz, out);
        evaluated++;
        if (dist > blockRadius + margin) continue;

        // Uzorci bloka.
        for (let k = 0; k < P; k++) {
          for (let j = 0; j < P; j++) {
            for (let i = 0; i < P; i++) {
              model.eval(x0 + (ci + i) * h, y0 + (cj + j) * h, z0 + (ck + k) * h, out);
              const base = ((k * P + j) * P + i) * stride;
              for (let s = 0; s < stride; s++) values[base + s] = out[s];
            }
          }
        }
        evaluated += P * P * P;

        for (let k = 0; k < B; k++) {
          if (ck + k >= NZ) break;
          for (let j = 0; j < B; j++) {
            if (cj + j >= NY) break;
            for (let i = 0; i < B; i++) {
              if (ci + i >= NX) break;
              for (let f = 0; f < K; f++) {
                if (minAux) {
                  let auxMax = -Infinity;
                  for (let c = 0; c < 8; c++) {
                    const o = CORNER[c];
                    const a = values[(((k + o[2]) * P + (j + o[1])) * P + (i + o[0])) * stride + K];
                    if (a > auxMax) auxMax = a;
                  }
                  if (auxMax < minAux[f]) continue;
                }
                let cube = 0;
                for (let c = 0; c < 8; c++) {
                  const o = CORNER[c];
                  const v = values[(((k + o[2]) * P + (j + o[1])) * P + (i + o[0])) * stride + f];
                  cornerVals[c] = v;
                  if (v < 0) cube |= 1 << c;
                }
                const edges = edgeTable[cube];
                if (edges === 0) continue;
                const gi = ci + i, gj = cj + j, gk = ck + k;
                for (let e = 0; e < 12; e++) {
                  if (!(edges & (1 << e))) continue;
                  const { axis, lo } = EDGE_AXIS[e];
                  const key = (((gk + lo[2]) * (NY + 1) + (gj + lo[1])) * (NX + 1) + (gi + lo[0])) * 3 + axis;
                  let vi = maps[f].get(key);
                  if (vi === undefined) {
                    const [a, b] = EDGE[e];
                    const va = cornerVals[a], vb = cornerVals[b];
                    let t = va / (va - vb);
                    t = t < 0.001 ? 0.001 : t > 0.999 ? 0.999 : t;
                    const ca = CORNER[a], cb = CORNER[b];
                    const px = x0 + (gi + ca[0] + (cb[0] - ca[0]) * t) * h;
                    const py = y0 + (gj + ca[1] + (cb[1] - ca[1]) * t) * h;
                    const pz = z0 + (gk + ca[2] + (cb[2] - ca[2]) * t) * h;
                    vi = pos[f].n / 3;
                    pos[f].push(px);
                    pos[f].push(py);
                    pos[f].push(pz);
                    maps[f].set(key, vi);
                  }
                  edgeVert[e] = vi;
                }
                const row = cube * 16;
                for (let t = 0; triTable[row + t] !== -1; t += 3) {
                  const a = edgeVert[triTable[row + t]];
                  const b = edgeVert[triTable[row + t + 1]];
                  const c = edgeVert[triTable[row + t + 2]];
                  if (a === b || b === c || a === c) continue;
                  idx[f].push(a);
                  idx[f].push(b);
                  idx[f].push(c);
                }
              }
            }
          }
        }
      }
    }
  }

  return {
    evaluated,
    meshes: pos.map((p, f) => ({ positions: p.view().slice(), indices: idx[f].view().slice() })),
  };
}
