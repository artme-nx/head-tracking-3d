// Okolina za refleksije: HDRI s Poly Havena (ferndale_studio_11, CC0) koji se
// prije PMREM-a "režira": pod se zatamni (tamna galerija / studio), a dodaju se
// mekane trake svjetla (softboxi) na zadanim smjerovima — kao u produktnoj
// vizualizaciji, da krom i staklo dobiju čiste, duge odsjaje.

import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

const HDR_URL = `${import.meta.env.BASE_URL}env/ferndale_studio_11_2k.hdr`;

let hdrPromise = null;

export function loadStudioHDR() {
  if (!hdrPromise) {
    hdrPromise = new HDRLoader().setDataType(THREE.HalfFloatType).loadAsync(HDR_URL).then((tex) => {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.LinearSRGBColorSpace;
      return tex;
    });
  }
  return hdrPromise;
}

const envVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize( position );
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

const envFragment = /* glsl */ `
  uniform sampler2D hdr;
  uniform float exposure;
  uniform float floorLevel;
  uniform float rotation;
  uniform vec3 tint;
  uniform vec2 horizon;
  varying vec3 vDir;
  #define PI 3.141592653589793
  void main() {
    vec3 d = normalize( vDir );
    float c = cos( rotation ), s = sin( rotation );
    d.xz = mat2( c, -s, s, c ) * d.xz;
    vec2 uv = vec2( atan( d.z, d.x ) / ( 2.0 * PI ) + 0.5, asin( clamp( d.y, -1.0, 1.0 ) ) / PI + 0.5 );
    vec3 col = texture2D( hdr, uv ).rgb * exposure * tint;
    // Zatamni donju hemisferu (svijetli pod studija ne pripada tamnoj galeriji).
    float h = smoothstep( horizon.x, horizon.y, d.y );
    col *= mix( floorLevel, 1.0, h );
    gl_FragColor = vec4( col, 1.0 );
  }
`;

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Texture} hdr equirect HDR
 * @param {object} o
 * @param {Array<{dir:number[], size:number[], intensity:number, color?:string, softness?:number}>} o.strips
 */
export function buildStudioEnvironment(renderer, hdr, o = {}) {
  const {
    exposure = 1,
    floorLevel = 0.06,
    rotation = 0,
    tint = '#ffffff',
    strips = [],
    resolution = 512,
    horizon = [-0.32, 0.12],
  } = o;

  const envScene = new THREE.Scene();
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(100, 64, 32),
    new THREE.ShaderMaterial({
      uniforms: {
        hdr: { value: hdr },
        exposure: { value: exposure },
        floorLevel: { value: floorLevel },
        rotation: { value: rotation },
        tint: { value: new THREE.Color(tint) },
        horizon: { value: new THREE.Vector2(...horizon) },
      },
      vertexShader: envVertex,
      fragmentShader: envFragment,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  envScene.add(sphere);

  // Softboxi: emisivne pločice s mekim rubom (gradijent prema rubu).
  const stripMat = (color, intensity, softness) =>
    new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(color).multiplyScalar(intensity) }, softness: { value: softness } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 color; uniform float softness; varying vec2 vUv;
        void main(){
          vec2 q = abs( vUv - 0.5 ) * 2.0;
          float m = ( 1.0 - smoothstep( 1.0 - softness, 1.0, q.x ) ) * ( 1.0 - smoothstep( 1.0 - softness, 1.0, q.y ) );
          gl_FragColor = vec4( color * m, 1.0 );
        }`,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

  for (const s of strips) {
    const dir = new THREE.Vector3(...s.dir).normalize();
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(s.size[0], s.size[1]),
      stripMat(s.color ?? '#ffffff', s.intensity, s.softness ?? 0.35),
    );
    plane.position.copy(dir).multiplyScalar(60);
    plane.lookAt(0, 0, 0);
    if (s.roll) plane.rotateZ(s.roll);
    envScene.add(plane);
  }

  const cubeRT = new THREE.WebGLCubeRenderTarget(resolution, { type: THREE.HalfFloatType, generateMipmaps: false });
  const cubeCam = new THREE.CubeCamera(0.1, 500, cubeRT);
  const prevTarget = renderer.getRenderTarget();
  const prevToneMapping = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  cubeCam.update(renderer, envScene);
  renderer.toneMapping = prevToneMapping;
  renderer.setRenderTarget(prevTarget);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromCubemap(cubeRT.texture).texture;
  pmrem.dispose();
  cubeRT.dispose();
  envScene.traverse((ob) => {
    ob.geometry?.dispose();
    ob.material?.dispose();
  });
  return env;
}
