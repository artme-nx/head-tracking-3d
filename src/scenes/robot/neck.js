// Mehanika vrata: kralježnični stup od diskova, hidraulički cilindri (tijelo +
// kromirana klipnjača koja klizi), pleteni kabeli i rebrasto crijevo grla.
// Sve se svaki frame prilagođava trenutnom položaju glave (glava ima inerciju).

import * as THREE from 'three';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

class Piston {
  constructor(mats, { bodyR = 0.42, rodR = 0.2, bodyLen = 5.4, rodLen = 5.6 }) {
    this.bodyLen = bodyLen;
    this.rodLen = rodLen;
    this.group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(bodyR, bodyR, bodyLen, 28, 1), mats.anodized);
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(bodyR * 1.18, bodyR * 1.18, 0.35, 28), mats.chrome);
    collar.position.y = bodyLen / 2 - 0.1;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(bodyR * 1.1, bodyR * 1.1, 0.5, 28), mats.graphite);
    base.position.y = -bodyLen / 2 + 0.2;
    this.body = new THREE.Group();
    this.body.add(body, collar, base);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(rodR, rodR, rodLen, 24), mats.chrome);
    this.rod = new THREE.Group();
    this.rod.add(rod);
    // Zglobne glave (clevis) na krajevima.
    const eye = new THREE.TorusGeometry(0.32, 0.12, 12, 24);
    this.endA = new THREE.Mesh(eye, mats.graphite);
    this.endB = new THREE.Mesh(eye, mats.graphite);
    for (const m of [body, collar, base, rod, this.endA, this.endB]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    this.group.add(this.body, this.rod, this.endA, this.endB);
  }

  update(a, b) {
    _d.subVectors(b, a);
    const len = _d.length();
    _d.divideScalar(len);
    _q.setFromUnitVectors(UP, _d);
    this.body.quaternion.copy(_q);
    this.body.position.copy(a).addScaledVector(_d, this.bodyLen / 2);
    this.rod.quaternion.copy(_q);
    this.rod.position.copy(b).addScaledVector(_d, -this.rodLen / 2);
    this.endA.position.copy(a);
    this.endB.position.copy(b);
    this.endA.quaternion.copy(_q);
    this.endB.quaternion.copy(_q);
  }
}

/** Cijev duž krivulje s fiksnom topologijom — vrhovi se pomiču svaki frame. */
export class FlexTube {
  constructor(material, { segments = 48, radial = 12, radius = 0.3, ripple = 0 } = {}) {
    this.segments = segments;
    this.radial = radial;
    this.radius = radius;
    this.ripple = ripple;
    const count = (segments + 1) * (radial + 1);
    this.positions = new Float32Array(count * 3);
    this.normals = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const index = [];
    for (let i = 0; i <= segments; i++) {
      for (let j = 0; j <= radial; j++) {
        const k = i * (radial + 1) + j;
        uvs[k * 2] = i / segments;
        uvs[k * 2 + 1] = j / radial;
        if (i < segments && j < radial) {
          // Namotaj tako da normala lica gleda prema van (du × dv = -van).
          const a = k, b = k + radial + 1, c = k + radial + 2, d = k + 1;
          index.push(a, d, b, b, d, c);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(index);
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.curve = new THREE.CatmullRomCurve3([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], false, 'centripetal');
    this._t = new THREE.Vector3();
    this._n = new THREE.Vector3(1, 0, 0);
    this._bn = new THREE.Vector3();
    this._p = new THREE.Vector3();
  }

  /** @param {THREE.Vector3[]} points kontrolne točke krivulje */
  update(points) {
    const curve = this.curve;
    for (let i = 0; i < points.length; i++) {
      if (!curve.points[i]) curve.points[i] = new THREE.Vector3();
      curve.points[i].copy(points[i]);
    }
    curve.points.length = points.length;
    const S = this.segments, R = this.radial;
    const t = this._t, n = this._n, bn = this._bn, p = this._p;
    curve.getTangentAt(0, t);
    // Početna normala okomita na tangentu, dalje paralelni prijenos.
    n.set(0, 0, 1);
    if (Math.abs(t.dot(n)) > 0.9) n.set(1, 0, 0);
    n.sub(_a.copy(t).multiplyScalar(t.dot(n))).normalize();
    for (let i = 0; i <= S; i++) {
      const u = i / S;
      curve.getPointAt(u, p);
      const tPrev = _b.copy(t);
      curve.getTangentAt(u, t);
      // Paralelni prijenos normale.
      const axis = _d.crossVectors(tPrev, t);
      const s = axis.length();
      if (s > 1e-6) {
        axis.divideScalar(s);
        const ang = Math.acos(THREE.MathUtils.clamp(tPrev.dot(t), -1, 1));
        n.applyAxisAngle(axis, ang);
      }
      bn.crossVectors(t, n);
      let r = this.radius;
      if (this.ripple) r *= 1 + this.ripple * Math.pow(Math.abs(Math.sin(u * Math.PI * 28)), 3);
      for (let j = 0; j <= R; j++) {
        const v = (j / R) * Math.PI * 2;
        const cx = Math.cos(v), sy = Math.sin(v);
        const nx = n.x * cx + bn.x * sy, ny = n.y * cx + bn.y * sy, nz = n.z * cx + bn.z * sy;
        const k = (i * (R + 1) + j) * 3;
        this.positions[k] = p.x + nx * r;
        this.positions[k + 1] = p.y + ny * r;
        this.positions[k + 2] = p.z + nz * r;
        this.normals[k] = nx;
        this.normals[k + 1] = ny;
        this.normals[k + 2] = nz;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.normal.needsUpdate = true;
  }
}

/**
 * @param {object} o
 * @param {THREE.Object3D} o.root prostor poprsja (sve točke su u njemu)
 * @param {THREE.Object3D} o.head čvor glave (točke sidra glave su u njegovom lokalnom prostoru)
 */
export class NeckRig {
  constructor({ root, head, mats }) {
    this.root = root;
    this.head = head;
    this.group = new THREE.Group();
    root.add(this.group);

    // Kralježnični stup.
    this.vertebrae = [];
    const disc = new THREE.CylinderGeometry(1.75, 1.85, 0.9, 40, 1);
    const ring = new THREE.TorusGeometry(1.62, 0.09, 10, 48).rotateX(Math.PI / 2);
    for (let i = 0; i < 7; i++) {
      const v = new THREE.Group();
      const d = new THREE.Mesh(disc, mats.graphite);
      const r = new THREE.Mesh(ring, mats.chrome);
      r.position.y = 0.55;
      d.castShadow = r.castShadow = true;
      d.receiveShadow = true;
      v.add(d, r);
      this.group.add(v);
      this.vertebrae.push(v);
    }
    this.spineBase = new THREE.Vector3(0, -21.2, -6.7);
    this.spineTop = new THREE.Vector3(0, -10.6, -6.3); // u prostoru glave

    // Hidraulika: prednji par (ispod čeljusti) i bočni par.
    this.pistons = [
      { p: new Piston(mats, { bodyR: 0.46, rodR: 0.21, bodyLen: 5.6, rodLen: 6.0 }), a: new THREE.Vector3(-2.7, -20.4, -2.6), b: new THREE.Vector3(-2.1, -11.6, -3.0) },
      { p: new Piston(mats, { bodyR: 0.46, rodR: 0.21, bodyLen: 5.6, rodLen: 6.0 }), a: new THREE.Vector3(2.7, -20.4, -2.6), b: new THREE.Vector3(2.1, -11.6, -3.0) },
      { p: new Piston(mats, { bodyR: 0.38, rodR: 0.17, bodyLen: 5.0, rodLen: 5.6 }), a: new THREE.Vector3(-6.0, -21.0, -6.8), b: new THREE.Vector3(-4.3, -11.4, -7.6) },
      { p: new Piston(mats, { bodyR: 0.38, rodR: 0.17, bodyLen: 5.0, rodLen: 5.6 }), a: new THREE.Vector3(6.0, -21.0, -6.8), b: new THREE.Vector3(4.3, -11.4, -7.6) },
    ];
    for (const { p } of this.pistons) this.group.add(p.group);

    // Kabeli: iza ušiju prema trapezu, s progibom.
    this.cables = [];
    const cableSpec = [
      // [x glave, y glave, z glave, x tijela, y tijela, z tijela, radijus]
      [5.4, -7.6, -10.6, 8.2, -21.6, -10.4, 0.34],
      [5.9, -6.9, -9.4, 9.6, -21.9, -8.4, 0.27],
      [4.6, -8.4, -11.6, 6.4, -21.2, -12.0, 0.22],
    ];
    for (const sx of [-1, 1]) {
      for (const [hx, hy, hz, bx, by, bz, r] of cableSpec) {
        const tube = new FlexTube(mats.braided, { radius: r, segments: 40, radial: 10 });
        this.group.add(tube.mesh);
        this.cables.push({ tube, h: new THREE.Vector3(sx * hx, hy, hz), b: new THREE.Vector3(sx * bx, by, bz), sx });
      }
    }
    // Rebrasto crijevo grla.
    this.hose = new FlexTube(mats.rubber, { radius: 0.62, segments: 64, radial: 16, ripple: 0.16 });
    this.group.add(this.hose.mesh);
    this.hoseA = new THREE.Vector3(0, -21.0, -2.0);
    this.hoseB = new THREE.Vector3(0, -11.9, -3.6);

    this._m = new THREE.Matrix4();
    this._q0 = new THREE.Quaternion();
    this._qh = new THREE.Quaternion();
  }

  /** Točka iz prostora glave u prostor poprsja. */
  headToRoot(v, out) {
    return out.copy(v).applyMatrix4(this._m);
  }

  update() {
    // Matrica glava → poprsje.
    this.root.updateMatrixWorld();
    this._m.copy(this.root.matrixWorld).invert().multiply(this.head.matrixWorld);
    this._qh.setFromRotationMatrix(this._m);

    // Kralješci: Bezier od baze do vrha, orijentacija slerp od tijela do glave.
    const top = this.headToRoot(this.spineTop, new THREE.Vector3());
    const base = this.spineBase;
    const ctrl = new THREE.Vector3((base.x + top.x) / 2, (base.y + top.y) / 2, Math.min(base.z, top.z) - 0.4);
    const n = this.vertebrae.length;
    this.vertebrae.forEach((v, i) => {
      const t = (i + 0.5) / n;
      const it = 1 - t;
      v.position.set(
        it * it * base.x + 2 * it * t * ctrl.x + t * t * top.x,
        it * it * base.y + 2 * it * t * ctrl.y + t * t * top.y,
        it * it * base.z + 2 * it * t * ctrl.z + t * t * top.z,
      );
      v.quaternion.slerpQuaternions(this._q0, this._qh, t);
    });

    for (const { p, a, b } of this.pistons) p.update(a, this.headToRoot(b, _a.clone()));

    for (const { tube, h, b, sx } of this.cables) {
      const hp = this.headToRoot(h, new THREE.Vector3());
      const exit = this.headToRoot(_b.set(h.x + sx * 0.6, h.y - 1.6, h.z - 0.4), new THREE.Vector3());
      const mid = new THREE.Vector3().lerpVectors(hp, b, 0.55);
      mid.x += sx * 1.4;
      mid.z -= 0.9;
      mid.y -= 0.6;
      const enter = new THREE.Vector3(b.x - sx * 0.3, b.y + 1.4, b.z + 0.2);
      tube.update([hp, exit, mid, enter, b]);
    }

    const hb = this.headToRoot(this.hoseB, new THREE.Vector3());
    const hm = new THREE.Vector3().lerpVectors(this.hoseA, hb, 0.5);
    hm.z += 0.5;
    this.hose.update([this.hoseA, new THREE.Vector3(0, -19.5, -1.7), hm, this.headToRoot(_b.set(0, -13.2, -3.2), new THREE.Vector3()), hb]);
  }
}
