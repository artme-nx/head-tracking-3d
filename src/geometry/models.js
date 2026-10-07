// SDF modeli koji se pretvaraju u mreže u workeru.

import { gyroid, smax } from './sdf.js';
import { robotHeadModel, robotBodyModel } from './robotModels.js';

const { sqrt, abs, max, PI } = Math;

/**
 * Kromirana sfera od giroidne (TPMS) rešetke, šuplja iznutra.
 * mode: 'sheet' = membrana (|g| < t), 'network' = jedna mreža šipki (g > t),
 *       'double' = dvije isprepletene mreže šipki (|g| > t).
 */
function gyroidSphereModel({
  radius = 7,
  inner = 5.4,
  period = 3.4,
  thickness = 0.3,
  rim = 0.24,
  step = 0.065,
  mode = 'sheet',
  strut = 1.1,
} = {}) {
  const k = (2 * PI) / period;
  const gradNorm = k * 1.12;
  const pad = 0.4;
  return {
    pieces: ['lattice'],
    bounds: [-radius - pad, -radius - pad, -radius - pad, radius + pad, radius + pad, radius + pad],
    step,
    block: 8,
    cullMargin: 0.3,
    simplifyError: 0.0045,
    normalEpsilon: step * 0.3,
    eval(x, y, z, out) {
      const r = sqrt(x * x + y * y + z * z);
      const shell = max(r - radius, inner - r);
      const g = gyroid(x * k, y * k, z * k);
      let lattice;
      if (mode === 'network') lattice = (strut - g) / gradNorm;
      else if (mode === 'double') lattice = (strut - abs(g)) / gradNorm;
      else lattice = abs(g) / gradNorm - thickness * 0.5;
      out[0] = smax(lattice, shell, rim);
      out[1] = 0;
      return shell > 0 ? shell : 0;
    },
  };
}

export function createModel(name, params) {
  switch (name) {
    case 'gyroidSphere':
      return gyroidSphereModel(params);
    case 'robotHead':
      return robotHeadModel(params);
    case 'robotBody':
      return robotBodyModel(params);
    default:
      throw new Error(`Nepoznat SDF model: ${name}`);
  }
}
