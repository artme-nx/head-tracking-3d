// Preset 1: klasična "kutija" iza ekrana (Johnny Lee). Pet zidova s mrežom
// koja ide u dubinu, mete na različitim dubinama, jedna izlazi ispred ekrana.
// Sve se gradi prema stvarnoj veličini prozora u cm.

import * as THREE from 'three';

const DEPTH = 50;
const BG = new THREE.Color('#07090c');

const TARGETS = [
  // [x (udio širine), y (udio visine), z cm, radijus cm, boja]
  [-0.3, 0.16, -40, 2.2, '#e8a25c'],
  [0.28, -0.18, -28, 1.8, '#5cb8e8'],
  [-0.17, -0.25, -16, 1.4, '#d9dde3'],
  [0.22, 0.24, -8, 1.1, '#9be0a8'],
  [0.02, 0.0, 6, 1.0, '#f0f2f5'], // ispred ekrana
];

export class BoxScene {
  constructor() {
    this.name = 'Kutija';
    this.group = new THREE.Group();
    this.dynamic = new THREE.Group(); // geometrija ovisna o veličini prozora
    this.group.add(this.dynamic);

    this.wallMat = new THREE.MeshStandardMaterial({ color: '#14171c', roughness: 0.92, metalness: 0 });
    this.gridMat = new THREE.LineBasicMaterial({ color: '#6f8fae', transparent: true, opacity: 0.55 });
    this.frameMat = new THREE.LineBasicMaterial({ color: '#b9c7d6', transparent: true, opacity: 0.9 });
    this.stalkMat = new THREE.MeshStandardMaterial({ color: '#3b4450', roughness: 0.6 });

    this.ambient = new THREE.HemisphereLight('#c9d6e6', '#0b0d10', 0.55);
    this.key = new THREE.DirectionalLight('#fff3e6', 2.2);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    this.group.add(this.ambient, this.key, this.key.target);

    this.targets = TARGETS.map(([, , , radius, color]) => {
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.05 });
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), mat);
      sphere.castShadow = true;
      sphere.receiveShadow = true;
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius * 1.45, radius * 0.045, 12, 64),
        new THREE.MeshStandardMaterial({ color, roughness: 0.5, emissive: color, emissiveIntensity: 0.15 }),
      );
      ring.castShadow = true;
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1, 10), this.stalkMat);
      stalk.rotation.x = Math.PI / 2;
      stalk.castShadow = true;
      const g = new THREE.Group();
      g.add(sphere, ring, stalk);
      this.group.add(g);
      return { g, sphere, ring, stalk };
    });
  }

  activate(scene) {
    scene.background = BG;
    scene.fog = new THREE.Fog(BG, 70, 190);
    scene.environmentIntensity = 0.35;
  }

  layout(rect) {
    const w = rect.width;
    const h = rect.height;
    const D = DEPTH;

    this.dynamic.traverse((o) => o.geometry?.dispose());
    this.dynamic.clear();

    // Zidovi (otvorena strana prema gledatelju).
    const walls = [
      { size: [w, h], pos: [0, 0, -D], rot: [0, 0, 0] },
      { size: [D, h], pos: [-w / 2, 0, -D / 2], rot: [0, Math.PI / 2, 0] },
      { size: [D, h], pos: [w / 2, 0, -D / 2], rot: [0, -Math.PI / 2, 0] },
      { size: [w, D], pos: [0, h / 2, -D / 2], rot: [Math.PI / 2, 0, 0] },
      { size: [w, D], pos: [0, -h / 2, -D / 2], rot: [-Math.PI / 2, 0, 0] },
    ];
    for (const wl of walls) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(...wl.size), this.wallMat);
      m.position.set(...wl.pos);
      m.rotation.set(...wl.rot);
      m.receiveShadow = true;
      this.dynamic.add(m);
    }

    // Mreža: prstenovi u dubinu svakih 5 cm + uzdužne linije po zidovima.
    const eps = 0.03;
    const x0 = -w / 2 + eps, x1 = w / 2 - eps, y0 = -h / 2 + eps, y1 = h / 2 - eps;
    const pts = [];
    const seg = (a, b) => pts.push(...a, ...b);
    const step = 5;
    for (let z = -step; z > -D - 0.01; z -= step) {
      seg([x0, y0, z], [x1, y0, z]);
      seg([x1, y0, z], [x1, y1, z]);
      seg([x1, y1, z], [x0, y1, z]);
      seg([x0, y1, z], [x0, y0, z]);
    }
    const zb = -D + eps;
    const nx = Math.max(4, Math.round(w / step));
    const ny = Math.max(3, Math.round(h / step));
    for (let i = 1; i < nx; i++) {
      const x = -w / 2 + (w * i) / nx;
      seg([x, y0, 0], [x, y0, zb]);
      seg([x, y1, 0], [x, y1, zb]);
      seg([x, y0, zb], [x, y1, zb]);
    }
    for (let j = 1; j < ny; j++) {
      const y = -h / 2 + (h * j) / ny;
      seg([x0, y, 0], [x0, y, zb]);
      seg([x1, y, 0], [x1, y, zb]);
      seg([x0, y, zb], [x1, y, zb]);
    }
    const grid = new THREE.BufferGeometry();
    grid.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.dynamic.add(new THREE.LineSegments(grid, this.gridMat));

    // Rub "prozora" na ravnini ekrana.
    const frame = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(x0, y0, 0), new THREE.Vector3(x1, y0, 0),
      new THREE.Vector3(x1, y1, 0), new THREE.Vector3(x0, y1, 0),
    ]);
    this.dynamic.add(new THREE.LineLoop(frame, this.frameMat));

    // Mete.
    TARGETS.forEach(([fx, fy, z], i) => {
      const t = this.targets[i];
      t.g.position.set(fx * w, fy * h, z);
      const len = z + D; // štap do stražnjeg zida
      t.stalk.scale.y = len;
      t.stalk.position.z = -len / 2;
    });

    // Svjetlo odozgo-sprijeda, sjene padaju na pod i stražnji zid.
    this.key.position.set(-w * 0.25, h * 1.2, 45);
    this.key.target.position.set(0, -h / 2, -D * 0.6);
    const cam = this.key.shadow.camera;
    const s = Math.max(w, h, D) * 0.9;
    cam.left = -s; cam.right = s; cam.top = s; cam.bottom = -s;
    cam.near = 1; cam.far = 300;
    cam.updateProjectionMatrix();
  }

  update(t) {
    // Lagano lebdenje meta — dovoljno da oko primijeti volumen, ne previše.
    this.targets.forEach((tg, i) => {
      tg.ring.rotation.z = t * 0.15 * (i % 2 ? 1 : -1);
    });
  }
}
