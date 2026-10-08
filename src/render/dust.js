// Lebdeće čestice prašine: svijetle samo kad su u snopu svjetla (provjera
// konusa u vertex shaderu), lagano kruže, neke su ispred ravnine ekrana.
// Udarac (swirl) ih uskovitla oko točke udarca pa se polako smire; točkasto
// svjetlo (svjetiljka na prstu) obasja one u svojoj blizini.

import * as THREE from 'three';

export class DustMotes {
  /**
   * @param {object} o
   * @param {THREE.Box3} o.box volumen u kojem čestice lebde (world, cm)
   * @param {THREE.Box3} [o.frontBox] dodatni volumen ispred ekrana
   */
  constructor({ count = 900, box, frontBox = null, frontCount = 40, size = 0.06, seed = 5 }) {
    let s = seed >>> 0;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const total = count + (frontBox ? frontCount : 0);
    const pos = new Float32Array(total * 3);
    const rnds = new Float32Array(total * 4);
    for (let i = 0; i < total; i++) {
      const b = i < count ? box : frontBox;
      pos[i * 3] = b.min.x + rnd() * (b.max.x - b.min.x);
      pos[i * 3 + 1] = b.min.y + rnd() * (b.max.y - b.min.y);
      pos[i * 3 + 2] = b.min.z + rnd() * (b.max.z - b.min.z);
      rnds[i * 4] = rnd();
      rnds[i * 4 + 1] = rnd();
      rnds[i * 4 + 2] = rnd();
      rnds[i * 4 + 3] = i < count ? 0 : 1; // 1 = čestica ispred ekrana
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('rnd', new THREE.BufferAttribute(rnds, 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    this.uniforms = {
      time: { value: 0 },
      lightPos: { value: new THREE.Vector3() },
      lightDir: { value: new THREE.Vector3(0, -1, 0) },
      lightColor: { value: new THREE.Color(1, 1, 1) },
      cosOuter: { value: 0.9 },
      cosInner: { value: 0.95 },
      pixelScale: { value: 500 },
      size: { value: size },
      ambient: { value: 0.015 },
      frontGlow: { value: 0.35 },
      swirlCenter: { value: new THREE.Vector3() },
      swirlTime: { value: -1 },
      swirlAmp: { value: 0 },
      pointPos: { value: new THREE.Vector3() },
      pointColor: { value: new THREE.Color(0, 0, 0) },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute vec4 rnd;
        uniform float time;
        uniform vec3 lightPos;
        uniform vec3 lightDir;
        uniform vec3 lightColor;
        uniform float cosOuter;
        uniform float cosInner;
        uniform float pixelScale;
        uniform float size;
        uniform float ambient;
        uniform float frontGlow;
        uniform vec3 swirlCenter;
        uniform float swirlTime;
        uniform float swirlAmp;
        uniform vec3 pointPos;
        uniform vec3 pointColor;
        varying vec3 vColor;
        varying float vSoft;
        void main() {
          vec3 p = position;
          float ph = rnd.x * 6.2831;
          float sp = 0.25 + rnd.y * 0.5;
          // Spora, vrtložna putanja (Brownovo lebdenje u toplom zraku).
          p += vec3(
            sin( time * 0.11 * sp + ph ) * 1.6 + sin( time * 0.29 * sp + ph * 2.0 ) * 0.5,
            sin( time * 0.07 * sp + ph * 1.3 ) * 1.2 + sin( time * 0.023 + ph ) * 3.0,
            cos( time * 0.09 * sp + ph * 0.7 ) * 1.4
          );
          // Vrtlog nakon udarca: zakret oko okomite osi kroz točku udarca, jači blizu
          // nje; naraste brzo, a smiruje se polako (čestice se vrate na svoje putanje).
          if ( swirlTime >= 0.0 ) {
            vec3 r = p - swirlCenter;
            float fall = exp( - dot( r, r ) / ( 40.0 * 40.0 ) );
            float a = swirlAmp * fall * ( 1.0 - exp( - swirlTime * 5.0 ) ) * exp( - swirlTime / 2.8 );
            float ang = a * ( 1.4 + rnd.z * 1.6 );
            float c = cos( ang ), s = sin( ang );
            r.xz = mat2( c, -s, s, c ) * r.xz;
            p = swirlCenter + r + vec3( 0.0, a * 5.0 * ( rnd.x - 0.35 ), 0.0 );
          }
          vec4 world = modelMatrix * vec4( p, 1.0 );
          vec3 L = world.xyz - lightPos;
          float dist = length( L );
          float cone = smoothstep( cosOuter, cosInner, dot( L / dist, lightDir ) );
          float twinkle = 0.6 + 0.4 * sin( time * ( 1.5 + rnd.z * 2.5 ) + ph * 3.0 );
          vec3 lit = lightColor * cone / max( dist * dist, 1.0 ) * twinkle;
          vec3 Lp = world.xyz - pointPos;
          lit += pointColor / max( dot( Lp, Lp ), 6.0 ) * twinkle;
          vColor = lit + vec3( ambient ) + vec3( 0.9, 0.85, 0.8 ) * frontGlow * rnd.w * twinkle * 0.08;
          vec4 mv = viewMatrix * world;
          gl_Position = projectionMatrix * mv;
          float s = size * ( 0.5 + rnd.y ) * ( rnd.w > 0.5 ? 1.8 : 1.0 );
          gl_PointSize = clamp( s * pixelScale / -mv.z, 1.0, 24.0 );
          vSoft = clamp( gl_PointSize / 6.0, 0.0, 1.0 );
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vSoft;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float r = length( c ) * 2.0;
          float a = smoothstep( 1.0, mix( 0.2, 0.0, vSoft ), r );
          gl_FragColor = vec4( vColor * a, 1.0 );
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(g, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    // Skala piksela ovisi o kameri (mono / lijevo / desno oko) i rezoluciji.
    this.points.onBeforeRender = (renderer, scene, camera) => {
      const size = renderer.getDrawingBufferSize(_v2);
      this.uniforms.pixelScale.value = camera.projectionMatrix.elements[5] * size.y * 0.5;
    };
  }

  /** Udarac: vrtlog oko točke (lokalni prostor prašine). */
  swirl(center, amp = 1) {
    this.uniforms.swirlCenter.value.copy(center);
    this.uniforms.swirlTime.value = 0;
    this.uniforms.swirlAmp.value = amp;
  }

  /** Točkasto svjetlo koje obasjava prašinu (svjetiljka na prstu); intenzitet 0 = ugašeno. */
  setPointLight(worldPos, color, intensity) {
    this.uniforms.pointPos.value.copy(worldPos);
    this.uniforms.pointColor.value.copy(color).multiplyScalar(intensity);
  }

  /** @param {THREE.SpotLight} light */
  update(time, light, scale = 1, dt = 0) {
    const sw = this.uniforms.swirlTime;
    if (sw.value >= 0) sw.value = sw.value > 12 ? -1 : sw.value + dt;
    const u = this.uniforms;
    u.time.value = time;
    light.updateMatrixWorld();
    u.lightPos.value.setFromMatrixPosition(light.matrixWorld);
    _v3.setFromMatrixPosition(light.target.matrixWorld);
    u.lightDir.value.subVectors(_v3, u.lightPos.value).normalize();
    u.lightColor.value.copy(light.color).multiplyScalar(light.intensity * scale);
    u.cosOuter.value = Math.cos(light.angle);
    u.cosInner.value = Math.cos(light.angle * (1 - light.penumbra));
  }
}

const _v2 = new THREE.Vector2();
const _v3 = new THREE.Vector3();
