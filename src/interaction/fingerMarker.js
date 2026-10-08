// H: diskretan sjajni marker na vrhu prsta u sceni — sitna užarena jezgra,
// meki halo i tanki prsten okrenut prema kameri, s tamnim obrubom da se vidi i
// na bijeloj keramici. Prsten se steže pri pinchu, a boja blago prati gestu.
// Marker poštuje dubinu (sakrije se iza objekata), pa se iz njega čita gdje je
// prst u prostoru.

import * as THREE from 'three';

const TINT = {
  none: new THREE.Color('#dfe9f5'),
  point: new THREE.Color('#f4f8ff'),
  pinch: new THREE.Color('#ffd9a0'),
  open: new THREE.Color('#a8e6ff'),
  fist: new THREE.Color('#ffb3a3'),
};

const haloMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color() }, strength: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        // Billboard: kvadrat uvijek okrenut kameri, veličina u world jedinicama.
        vec4 mv = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
        vec2 scale = vec2( length( modelMatrix[ 0 ].xyz ), length( modelMatrix[ 1 ].xyz ) );
        mv.xy += position.xy * scale;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      uniform float strength;
      varying vec2 vUv;
      void main() {
        float r = length( vUv - 0.5 ) * 2.0;
        float g = exp( -r * r * 18.0 ) * 1.4 + exp( -r * r * 4.0 ) * 0.22;
        gl_FragColor = vec4( color * g * strength, 1.0 );
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });

class Marker {
  constructor() {
    this.group = new THREE.Group();
    this.coreMat = new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false, transparent: true });
    this.core = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 14), this.coreMat);
    this.halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), haloMaterial());
    this.halo.scale.setScalar(2.6);
    this.halo.renderOrder = 7;
    // Tamni obrub ispod svijetlog prstena: kontrast na svijetlim površinama.
    this.shadeMat = new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.4, depthWrite: false });
    this.shade = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.14, 64), this.shadeMat);
    this.shade.renderOrder = 5;
    this.ringMat = new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false, transparent: true, opacity: 0.85, depthWrite: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64), this.ringMat);
    this.ring.renderOrder = 6;
    this.rings = new THREE.Group();
    this.rings.add(this.shade, this.ring);
    this.group.add(this.core, this.halo, this.rings);
    this.group.visible = false;
    for (const o of [this.core, this.halo, this.ring, this.shade]) {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;
    }
    this.color = new THREE.Color();
    this.ringScale = 0.55;
  }
}

export class FingerMarkers {
  constructor(scene) {
    this.enabled = false;
    this.markers = [new Marker(), new Marker()];
    for (const m of this.markers) scene.add(m.group);
  }

  toggle(force) {
    this.enabled = force ?? !this.enabled;
    return this.enabled;
  }

  /** @param {object} hand kontekst iz HandInput.update */
  update(hand, camera, dt, scale = 1) {
    const list = this.enabled ? hand.hands : [];
    this.markers.forEach((m, i) => {
      const v = list[i];
      if (!v || v.presence <= 0.01) {
        m.group.visible = false;
        return;
      }
      m.group.visible = true;
      m.group.position.copy(v.tip);
      m.group.quaternion.copy(camera.quaternion);
      // Veličina raste s udaljenošću od kamere tek blago (marker ostaje diskretan).
      const d = camera.position.distanceTo(v.tip);
      const s = scale * THREE.MathUtils.clamp(d / 90, 0.55, 1.6);
      m.group.scale.setScalar(s);
      m.color.lerp(TINT[v.gesture] ?? TINT.none, 1 - Math.exp(-dt * 10));
      const a = v.presence;
      m.coreMat.color.copy(m.color).multiplyScalar(3.2 * a);
      m.coreMat.opacity = a;
      m.halo.material.uniforms.color.value.copy(m.color);
      m.halo.material.uniforms.strength.value = 0.9 * a;
      // Prsten: stegnut pri pinchu, raširen kod otvorenog dlana, diše u mirovanju.
      const goal = v.gesture === 'pinch' ? 0.38 : v.gesture === 'open' ? 1.0 : v.gesture === 'fist' ? 0.45 : 0.68;
      m.ringScale += (goal - m.ringScale) * (1 - Math.exp(-dt * 12));
      m.rings.scale.setScalar(m.ringScale * (1 + 0.04 * Math.sin(performance.now() / 380)));
      m.ringMat.color.copy(m.color).multiplyScalar(2.2);
      m.ringMat.opacity = 0.85 * a;
      m.shadeMat.opacity = 0.4 * a;
    });
  }
}
