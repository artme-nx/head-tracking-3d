// Generalized perspective projection (Robert Kooima, 2008).
// Kamera stoji točno na položaju oka; frustum je asimetričan i prolazi
// kroz četiri ruba fizičkog ekrana (pa, pb, pc), pa slika na monitoru
// izgleda kao pogled kroz prozor.

import * as THREE from 'three';

const vr = new THREE.Vector3();
const vu = new THREE.Vector3();
const vn = new THREE.Vector3();
const va = new THREE.Vector3();
const vb = new THREE.Vector3();
const vc = new THREE.Vector3();
const basis = new THREE.Matrix4();

/**
 * @param {THREE.PerspectiveCamera} camera
 * @param {THREE.Vector3} pa donji lijevi kut ekrana
 * @param {THREE.Vector3} pb donji desni kut ekrana
 * @param {THREE.Vector3} pc gornji lijevi kut ekrana
 * @param {THREE.Vector3} pe položaj oka
 */
export function applyOffAxis(camera, pa, pb, pc, pe, near = 1, far = 1000) {
  // Ortonormirana baza ekrana.
  vr.subVectors(pb, pa).normalize();
  vu.subVectors(pc, pa).normalize();
  vn.crossVectors(vr, vu).normalize();

  // Vektori od oka do kutova ekrana.
  va.subVectors(pa, pe);
  vb.subVectors(pb, pe);
  vc.subVectors(pc, pe);

  // Udaljenost oka od ravnine ekrana (oko ne smije prijeći ravninu).
  const d = Math.max(-va.dot(vn), 1e-3);
  const k = near / d;

  const l = vr.dot(va) * k;
  const r = vr.dot(vb) * k;
  const b = vu.dot(va) * k;
  const t = vu.dot(vc) * k;

  camera.projectionMatrix.makePerspective(l, r, t, b, near, far);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

  // Pogled: rotacija u bazu ekrana + translacija na oko.
  basis.makeBasis(vr, vu, vn);
  camera.quaternion.setFromRotationMatrix(basis);
  camera.position.copy(pe);
  camera.updateMatrixWorld(true);

  // Okvirni FOV/aspect da pomoćni sustavi (npr. sortiranje splatova) imaju smislene vrijednosti.
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan((t - b) / 2 / near));
  camera.aspect = (r - l) / (t - b);
  camera.near = near;
  camera.far = far;
}
