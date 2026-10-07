// Preset 2: centrirani model na postolju, meko studijsko svjetlo i sjena.
// Isti preset prima i korisnički model (.glb/.gltf) ili Gaussian splat.

import * as THREE from 'three';

const BG = new THREE.Color('#0a0b0e');
const MODEL_Z = -14; // centar postolja iza ravnine ekrana

export class ModelScene {
  constructor() {
    this.name = 'Model';
    this.group = new THREE.Group();
    this.content = null; // trenutni model (Object3D)
    this.contentKind = 'mesh'; // 'mesh' | 'splat'
    this.turntable = false;
    this.spin = 0;
    this.userScale = 1;

    this.floor = new THREE.Mesh(
      new THREE.CircleGeometry(160, 96),
      new THREE.MeshStandardMaterial({ color: '#0f1013', roughness: 0.9 }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;

    this.pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1.04, 1, 96),
      new THREE.MeshStandardMaterial({ color: '#2a2d33', roughness: 0.7, metalness: 0.0 }),
    );
    this.pedestal.castShadow = true;
    this.pedestal.receiveShadow = true;

    this.pivot = new THREE.Group(); // točka na vrhu postolja, model sjedi na njoj
    this.set = new THREE.Group();
    this.set.add(this.floor, this.pedestal);
    this.group.add(this.set, this.pivot);

    // Studijsko svjetlo: meki key, hladni rim straga, slabi fill.
    this.hemi = new THREE.HemisphereLight('#dfe6ee', '#0c0d10', 0.2);
    this.key = new THREE.DirectionalLight('#fff1e2', 2.0);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.radius = 6;
    this.key.shadow.bias = -0.0003;
    this.key.shadow.normalBias = 0.03;
    this.rim = new THREE.DirectionalLight('#a9c8ff', 1.6);
    this.fill = new THREE.DirectionalLight('#ffffff', 0.35);
    this.group.add(this.hemi, this.key, this.key.target, this.rim, this.rim.target, this.fill, this.fill.target);

    this.fit = { width: 10, height: 10, depth: 10 };
  }

  activate(scene) {
    scene.background = BG;
    scene.fog = new THREE.Fog(BG, 55, 150);
    scene.environmentIntensity = 0.45;
  }

  layout(rect) {
    const w = rect.width;
    const h = rect.height;
    const floorY = -h / 2 - 2;
    const pedH = h * 0.3;
    const pedR = Math.min(w, h) * 0.2;

    this.floor.position.set(0, floorY, MODEL_Z);
    this.pedestal.scale.set(pedR, pedH, pedR);
    this.pedestal.position.set(0, floorY + pedH / 2, MODEL_Z);
    this.pivot.position.set(0, floorY + pedH, MODEL_Z);

    // Prostor za model iznad postolja.
    this.fit = { width: w * 0.55, height: h / 2 - (floorY + pedH) - h * 0.04, depth: 26 };
    this.splatFit = { width: w * 0.95, height: h * 0.95, depth: 50 };

    this.key.position.set(-w * 0.8, h * 1.6, 50);
    this.key.target.position.set(0, floorY + pedH, MODEL_Z);
    const sc = this.key.shadow.camera;
    const s = Math.max(w, h) * 0.8;
    sc.left = -s; sc.right = s; sc.top = s; sc.bottom = -s;
    sc.near = 1; sc.far = 400;
    sc.updateProjectionMatrix();

    this.rim.position.set(w * 0.9, h * 0.8, MODEL_Z - 60);
    this.rim.target.position.copy(this.pivot.position);
    this.fill.position.set(w, 0, 40);
    this.fill.target.position.copy(this.pivot.position);

    if (this.content) this.#place();
  }

  /** Zamijeni sadržaj; prima mesh scenu ili SplatMesh. */
  setContent(object, kind = 'mesh') {
    if (this.content) {
      this.pivot.remove(this.content);
      disposeObject(this.content);
    }
    this.content = object;
    this.contentKind = kind;
    this.set.visible = kind !== 'splat';
    this.spin = 0;
    this.userScale = 1;
    this.pivot.add(object);
    if (kind === 'mesh') {
      object.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
    }
    this.#place();
  }

  /** Automatsko centriranje i skaliranje u raspoloživi prostor. */
  #place() {
    const obj = this.content;
    const bounds = this.boundsOf(obj);
    if (bounds.isEmpty()) return;
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());

    const fit = this.contentKind === 'splat' ? this.splatFit : this.fit;
    const scale = Math.min(fit.width / size.x, fit.height / size.y, fit.depth / size.z) * this.userScale;

    // Model je dijete "wrappera" pa se može skalirati bez diranja njegovih transformacija.
    const wrapper = obj.userData.wrapper;
    wrapper.scale.setScalar(scale);
    if (this.contentKind === 'splat') {
      // Splat se centrira u kutiju iza ekrana, bez postolja.
      wrapper.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
      obj.position.set(0, -this.pivot.position.y, -fit.depth / 2 - MODEL_Z);
    } else {
      // Mesh sjedi na vrhu postolja: dno bounding boxa na y = 0.
      wrapper.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
      obj.position.set(0, 0, 0);
    }
  }

  /** Okreni sadržaj naopako (česta potreba kod splatova). */
  flip() {
    if (!this.content) return;
    const flipper = this.content.userData.flipper;
    flipper.rotation.x = flipper.rotation.x ? 0 : Math.PI;
    flipper.updateMatrix();
    this.#place();
  }

  /** Ručna korekcija veličine ([ i ]). */
  scaleBy(factor) {
    if (!this.content) return;
    this.userScale = Math.min(8, Math.max(0.125, this.userScale * factor));
    this.#place();
  }

  /** Granice sadržaja u prostoru wrappera (uključuje flip i transformacije modela). */
  boundsOf(obj) {
    const { inner, flipper, wrapper, bounds } = obj.userData;
    flipper.updateMatrix();
    if (bounds) return bounds.clone().applyMatrix4(flipper.matrix);
    wrapper.updateMatrixWorld(true);
    const parentInv = new THREE.Matrix4().copy(wrapper.matrixWorld).invert();
    const box = new THREE.Box3();
    inner.traverse((o) => {
      if (o.isMesh && o.geometry) {
        o.geometry.computeBoundingBox();
        const b = o.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(parentInv, o.matrixWorld));
        box.union(b);
      }
    });
    return box;
  }

  /** ORBIT: točka interesa = središte modela (world). */
  orbitTarget(out) {
    if (this.content) {
      _box.setFromObject(this.content);
      if (!_box.isEmpty()) return _box.getCenter(out);
    }
    return this.pivot.getWorldPosition(out).add(_up.set(0, this.fit.height * 0.5, 0));
  }

  /** ORBIT: kamera ostaje iznad poda. */
  orbitLimits() {
    return { minY: this.floor.getWorldPosition(_v).y + 4 };
  }

  update(t, dt) {
    if (!this.content) return;
    if (this.turntable) this.spin += dt * 0.35;
    this.content.rotation.y = this.spin;
  }
}

const _box = new THREE.Box3();
const _v = new THREE.Vector3();
const _up = new THREE.Vector3();

/**
 * Omotaj objekt: outer (vrtnja) → wrapper (skala/centriranje) → flipper (naopako) → inner (original).
 * `bounds` (opcionalno) su granice u prostoru flippera, za objekte bez obične geometrije (splat).
 */
export function wrapContent(inner, bounds = null) {
  const outer = new THREE.Group();
  const wrapper = new THREE.Group();
  const flipper = new THREE.Group();
  flipper.add(inner);
  wrapper.add(flipper);
  outer.add(wrapper);
  outer.userData = { wrapper, flipper, inner, bounds };
  return outer;
}

function disposeObject(root) {
  root.traverse((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose();
    }
    if (o.dispose && !o.isScene) o.dispose();
  });
}
