// Web worker: SDF model → marching cubes → meshoptimizer simplifikacija →
// normale iz gradijenta SDF-a (savršeno glatke, bitno za krom i keramiku).

import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { polygonize } from './marchingCubes.js';
import { createModel } from './models.js';

function compact(indices, positions) {
  const remap = new Int32Array(positions.length / 3).fill(-1);
  let n = 0;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (remap[v] === -1) remap[v] = n++;
  }
  const outPos = new Float32Array(n * 3);
  for (let v = 0; v < remap.length; v++) {
    const r = remap[v];
    if (r < 0) continue;
    outPos[r * 3] = positions[v * 3];
    outPos[r * 3 + 1] = positions[v * 3 + 1];
    outPos[r * 3 + 2] = positions[v * 3 + 2];
  }
  const outIdx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) outIdx[i] = remap[indices[i]];
  return { positions: outPos, indices: outIdx };
}

function sdfNormals(model, piece, positions) {
  const K = model.pieces.length;
  const out = new Float64Array(K + 1);
  const n = positions.length / 3;
  const normals = new Float32Array(positions.length);
  const e = model.normalEpsilon ?? model.step * 0.35;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    model.eval(x + e, y, z, out); const px = out[piece];
    model.eval(x - e, y, z, out); const mx = out[piece];
    model.eval(x, y + e, z, out); const py = out[piece];
    model.eval(x, y - e, z, out); const my = out[piece];
    model.eval(x, y, z + e, out); const pz = out[piece];
    model.eval(x, y, z - e, out); const mz = out[piece];
    let gx = px - mx, gy = py - my, gz = pz - mz;
    const len = Math.hypot(gx, gy, gz) || 1;
    normals[i * 3] = gx / len;
    normals[i * 3 + 1] = gy / len;
    normals[i * 3 + 2] = gz / len;
  }
  return normals;
}

/** Dubina ispod vanjske površine (pomoćni kanal modela) za svaki vrh — za unutarnje plohe ljuski. */
function shellDepth(model, positions) {
  const K = model.pieces.length;
  const out = new Float64Array(K + 1);
  const n = positions.length / 3;
  const depth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    model.eval(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], out);
    depth[i] = out[K];
  }
  return depth;
}

function orient(indices, positions, normals) {
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const e1x = positions[b * 3] - ax, e1y = positions[b * 3 + 1] - ay, e1z = positions[b * 3 + 2] - az;
    const e2x = positions[c * 3] - ax, e2y = positions[c * 3 + 1] - ay, e2z = positions[c * 3 + 2] - az;
    const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    const nx = normals[a * 3] + normals[b * 3] + normals[c * 3];
    const ny = normals[a * 3 + 1] + normals[b * 3 + 1] + normals[c * 3 + 1];
    const nz = normals[a * 3 + 2] + normals[b * 3 + 2] + normals[c * 3 + 2];
    if (fx * nx + fy * ny + fz * nz < 0) {
      indices[t + 1] = c;
      indices[t + 2] = b;
    }
  }
}

self.onmessage = async (ev) => {
  const { id, name, params } = ev.data;
  try {
    const t0 = performance.now();
    const model = createModel(name, params);
    await MeshoptSimplifier.ready;
    const { meshes, evaluated } = polygonize(model);
    const t1 = performance.now();
    const result = [];
    const transfer = [];
    meshes.forEach((m, piece) => {
      if (m.indices.length === 0) return;
      let indices = m.indices;
      let positions = m.positions;
      const err = model.simplifyError?.[piece] ?? model.simplifyError ?? 0.003;
      if (err > 0) {
        const [simplified] = MeshoptSimplifier.simplify(indices, positions, 3, 0, err, ['ErrorAbsolute']);
        ({ indices, positions } = compact(simplified, positions));
      }
      const normals = sdfNormals(model, piece, positions);
      orient(indices, positions, normals);
      const mesh = { name: model.pieces[piece], positions, normals, indices };
      transfer.push(positions.buffer, normals.buffer, indices.buffer);
      if (model.shellDepth) {
        mesh.depth = shellDepth(model, positions);
        transfer.push(mesh.depth.buffer);
      }
      result.push(mesh);
    });
    const t2 = performance.now();
    self.postMessage(
      { id, meshes: result, stats: { evaluated, mcMs: t1 - t0, postMs: t2 - t1, tris: result.reduce((s, m) => s + m.indices.length / 3, 0) } },
      transfer,
    );
  } catch (err) {
    self.postMessage({ id, error: String(err?.stack ?? err) });
  }
};
