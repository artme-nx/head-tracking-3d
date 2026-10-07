// Volumetrijski snop spot svjetla kroz lagani haze — raymarch u pola
// rezolucije, s pravom sjenom iz shadow mape svjetla (zrake svjetla kroz
// rešetku), 3D šumom gustoće i Henyey–Greenstein faznom funkcijom.
// Kompozitira se preko scene s depth-aware (bilateralnim) upsamplingom.

import * as THREE from 'three';
import { Pass } from 'postprocessing';

function makeNoise3D(size = 64) {
  // Tileable value-noise fBm, 3 oktave.
  const data = new Uint8Array(size * size * size);
  const lattice = (period, seed) => {
    const g = new Float32Array(period * period * period);
    let s = seed;
    for (let i = 0; i < g.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      g[i] = s / 4294967296;
    }
    return g;
  };
  const octaves = [
    { period: 8, amp: 0.55, g: lattice(8, 17) },
    { period: 16, amp: 0.3, g: lattice(16, 91) },
    { period: 32, amp: 0.15, g: lattice(32, 7) },
  ];
  const smooth = (t) => t * t * (3 - 2 * t);
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let v = 0;
        for (const o of octaves) {
          const P = o.period;
          const fx = (x / size) * P, fy = (y / size) * P, fz = (z / size) * P;
          const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
          const tx = smooth(fx - x0), ty = smooth(fy - y0), tz = smooth(fz - z0);
          const at = (i, j, k) => o.g[((i % P) + ((j % P) * P) + ((k % P) * P * P))];
          const x1 = x0 + 1, y1 = y0 + 1, z1 = z0 + 1;
          const c00 = at(x0, y0, z0) * (1 - tx) + at(x1, y0, z0) * tx;
          const c10 = at(x0, y1, z0) * (1 - tx) + at(x1, y1, z0) * tx;
          const c01 = at(x0, y0, z1) * (1 - tx) + at(x1, y0, z1) * tx;
          const c11 = at(x0, y1, z1) * (1 - tx) + at(x1, y1, z1) * tx;
          const c0 = c00 * (1 - ty) + c10 * ty;
          const c1 = c01 * (1 - ty) + c11 * ty;
          v += (c0 * (1 - tz) + c1 * tz) * o.amp;
        }
        data[x + y * size + z * size * size] = Math.min(255, Math.max(0, Math.round(v * 255)));
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

const fullscreenVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`;

const marchFragment = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  uniform sampler2D tDepth;
  uniform sampler2D tShadow;
  uniform sampler3D tNoise;
  uniform mat4 projInv;
  uniform mat4 camWorld;
  uniform vec3 camPos;
  uniform vec3 lightPos;
  uniform vec3 lightDir;
  uniform vec3 lightColor;
  uniform float cosOuter;
  uniform float cosInner;
  uniform float range;
  uniform mat4 shadowMatrix;
  uniform float useShadow;
  uniform float density;
  uniform float ambientDensity;
  uniform float noiseScale;
  uniform float noiseAmount;
  uniform vec3 wind;
  uniform float time;
  uniform float g;
  uniform int steps;
  uniform vec2 resolution;
  varying vec2 vUv;

  float ign( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }

  float hg( float c ) {
    float g2 = g * g;
    return ( 1.0 - g2 ) / ( 12.5663706 * pow( max( 1.0 + g2 - 2.0 * g * c, 1e-4 ), 1.5 ) );
  }

  // Presjek zrake i beskonačnog konusa (vrh A, os D, cos² kuta) → [t0, t1].
  bool coneHit( vec3 o, vec3 d, out float t0, out float t1 ) {
    vec3 co = o - lightPos;
    float cos2 = cosOuter * cosOuter;
    float dD = dot( d, lightDir );
    float coD = dot( co, lightDir );
    float a = dD * dD - cos2;
    float b = 2.0 * ( dD * coD - dot( d, co ) * cos2 );
    float c = coD * coD - dot( co, co ) * cos2;
    float disc = b * b - 4.0 * a * c;
    bool inside = c > 0.0 && coD > 0.0;
    if ( disc < 0.0 ) {
      if ( inside ) { t0 = 0.0; t1 = 1e6; return true; }
      return false;
    }
    float sq = sqrt( disc );
    float r0 = ( -b - sq ) / ( 2.0 * a );
    float r1 = ( -b + sq ) / ( 2.0 * a );
    if ( r0 > r1 ) { float tmp = r0; r0 = r1; r1 = tmp; }
    // Odbaci "zrcalni" konus iza vrha.
    bool h0 = dot( o + d * r0 - lightPos, lightDir ) > 0.0;
    bool h1 = dot( o + d * r1 - lightPos, lightDir ) > 0.0;
    if ( inside ) {
      t0 = 0.0;
      t1 = h1 && r1 > 0.0 ? r1 : ( h0 && r0 > 0.0 ? r0 : 1e6 );
      return true;
    }
    if ( h0 && h1 ) { t0 = r0; t1 = r1; return t1 > 0.0; }
    if ( h0 ) { t0 = r0; t1 = 1e6; return true; }
    if ( h1 ) { t0 = r1; t1 = 1e6; return true; }
    return false;
  }

  void main() {
    vec2 ndc = vUv * 2.0 - 1.0;
    float depth = texture2D( tDepth, vUv ).r;
    vec4 vp = projInv * vec4( ndc, depth * 2.0 - 1.0, 1.0 );
    vp.xyz /= vp.w;
    vec4 farP = projInv * vec4( ndc, 1.0, 1.0 );
    farP.xyz /= farP.w;
    vec3 dirView = normalize( farP.xyz );
    vec3 rd = normalize( mat3( camWorld ) * dirView );
    vec3 ro = camPos;
    float tScene = depth >= 0.99999 ? 1e6 : length( vp.xyz );

    vec3 sum = vec3( 0.0 );
    float t0, t1;
    if ( coneHit( ro, rd, t0, t1 ) ) {
      t0 = max( t0, 0.0 );
      // Ograniči na domet svjetla (sfera oko vrha).
      vec3 co = ro - lightPos;
      float bq = dot( co, rd );
      float cq = dot( co, co ) - range * range;
      float dq = bq * bq - cq;
      if ( dq > 0.0 ) {
        float tr = -bq + sqrt( dq );
        t1 = min( t1, tr );
      }
      t1 = min( t1, tScene );
      if ( t1 > t0 ) {
        float stepLen = ( t1 - t0 ) / float( steps );
        float jitter = ign( gl_FragCoord.xy );
        float trans = 1.0;
        for ( int i = 0; i < 96; i ++ ) {
          if ( i >= steps ) break;
          float t = t0 + ( float( i ) + jitter ) * stepLen;
          vec3 p = ro + rd * t;
          vec3 L = p - lightPos;
          float dist = length( L );
          vec3 ldir = L / dist;
          float cosA = dot( ldir, lightDir );
          float cone = smoothstep( cosOuter, cosInner, cosA );
          if ( cone <= 0.0 ) continue;
          float vis = 1.0;
          if ( useShadow > 0.5 ) {
            vec4 sc = shadowMatrix * vec4( p, 1.0 );
            sc.xyz /= sc.w;
            if ( sc.x > 0.0 && sc.x < 1.0 && sc.y > 0.0 && sc.y < 1.0 && sc.z < 1.0 ) {
              vis = step( sc.z - 0.0004, texture2D( tShadow, sc.xy ).r );
            }
          }
          vec3 np = p * noiseScale + wind * time;
          float n = texture( tNoise, np ).r * 0.65 + texture( tNoise, np * 2.7 + 3.1 ).r * 0.35;
          float dens = density * mix( 1.0, smoothstep( 0.25, 0.85, n ) * 1.8, noiseAmount );
          float atten = 1.0 / max( dist * dist, 1.0 );
          vec3 inScatter = lightColor * atten * cone * vis * hg( dot( ldir, -rd ) );
          sum += trans * dens * inScatter * stepLen;
          trans *= exp( -dens * stepLen * 0.02 );
        }
      }
    }
    // Vrlo slabi ambijentalni haze (zrak u prostoriji).
    float tAmb = min( tScene, 600.0 );
    sum += vec3( 0.55, 0.6, 0.7 ) * ambientDensity * ( 1.0 - exp( -tAmb * 0.004 ) );
    gl_FragColor = vec4( sum, tScene );
  }
`;

const compositeFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D tInput;
  uniform sampler2D tVolume;
  uniform sampler2D tDepth;
  uniform mat4 projInv;
  uniform vec2 lowSize;
  uniform float intensity;
  varying vec2 vUv;

  float sceneDist( vec2 uv ) {
    float d = texture2D( tDepth, uv ).r;
    if ( d >= 0.99999 ) return 1e6;
    vec4 vp = projInv * vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
    return length( vp.xyz / vp.w );
  }

  void main() {
    vec4 base = texture2D( tInput, vUv );
    float dFull = sceneDist( vUv );
    // Bilateralni upsample: 4 susjedna teksela niske rezolucije, težine po dubini.
    vec2 pos = vUv * lowSize - 0.5;
    vec2 f = fract( pos );
    vec2 i0 = ( floor( pos ) + 0.5 ) / lowSize;
    vec2 px = 1.0 / lowSize;
    vec4 s00 = texture2D( tVolume, i0 );
    vec4 s10 = texture2D( tVolume, i0 + vec2( px.x, 0.0 ) );
    vec4 s01 = texture2D( tVolume, i0 + vec2( 0.0, px.y ) );
    vec4 s11 = texture2D( tVolume, i0 + px );
    float k = 0.06 * min( dFull, 1e4 ) + 0.5;
    float w00 = ( 1.0 - f.x ) * ( 1.0 - f.y ) * exp( -abs( min( s00.a, 1e4 ) - min( dFull, 1e4 ) ) / k );
    float w10 = f.x * ( 1.0 - f.y ) * exp( -abs( min( s10.a, 1e4 ) - min( dFull, 1e4 ) ) / k );
    float w01 = ( 1.0 - f.x ) * f.y * exp( -abs( min( s01.a, 1e4 ) - min( dFull, 1e4 ) ) / k );
    float w11 = f.x * f.y * exp( -abs( min( s11.a, 1e4 ) - min( dFull, 1e4 ) ) / k );
    float wsum = w00 + w10 + w01 + w11;
    vec3 vol = wsum > 1e-4
      ? ( s00.rgb * w00 + s10.rgb * w10 + s01.rgb * w01 + s11.rgb * w11 ) / wsum
      : texture2D( tVolume, vUv ).rgb;
    gl_FragColor = vec4( base.rgb + vol * intensity, base.a );
  }
`;

export class VolumetricSpotPass extends Pass {
  constructor() {
    super('VolumetricSpotPass');
    this.needsDepthTexture = true;
    this.needsSwap = true;
    this.light = null;
    this.resolutionScale = 0.5;
    this.camera = null;
    this.intensity = 1;

    this.noise = makeNoise3D(64);
    this.lowRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });

    this.marchMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: null },
        tShadow: { value: null },
        tNoise: { value: this.noise },
        projInv: { value: new THREE.Matrix4() },
        camWorld: { value: new THREE.Matrix4() },
        camPos: { value: new THREE.Vector3() },
        lightPos: { value: new THREE.Vector3() },
        lightDir: { value: new THREE.Vector3(0, -1, 0) },
        lightColor: { value: new THREE.Color() },
        cosOuter: { value: 0.9 },
        cosInner: { value: 0.95 },
        range: { value: 400 },
        shadowMatrix: { value: new THREE.Matrix4() },
        useShadow: { value: 0 },
        density: { value: 0.02 },
        ambientDensity: { value: 0.0 },
        noiseScale: { value: 0.012 },
        noiseAmount: { value: 0.7 },
        wind: { value: new THREE.Vector3(0.004, 0.0015, -0.002) },
        time: { value: 0 },
        g: { value: 0.35 },
        steps: { value: 48 },
        resolution: { value: new THREE.Vector2() },
      },
      vertexShader: fullscreenVertex,
      fragmentShader: marchFragment,
      depthTest: false,
      depthWrite: false,
    });

    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        tVolume: { value: this.lowRT.texture },
        tDepth: { value: null },
        projInv: { value: new THREE.Matrix4() },
        lowSize: { value: new THREE.Vector2(1, 1) },
        intensity: { value: 1 },
      },
      vertexShader: fullscreenVertex,
      fragmentShader: compositeFragment,
      depthTest: false,
      depthWrite: false,
    });

    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(tri, this.marchMaterial);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.fullSize = new THREE.Vector2(1, 1);
  }

  set mainCamera(cam) {
    this.camera = cam;
  }

  setDepthTexture(depthTexture) {
    this.marchMaterial.uniforms.tDepth.value = depthTexture;
    this.compositeMaterial.uniforms.tDepth.value = depthTexture;
  }

  setSize(width, height) {
    this.fullSize.set(width, height);
    const w = Math.max(1, Math.round(width * this.resolutionScale));
    const h = Math.max(1, Math.round(height * this.resolutionScale));
    this.lowRT.setSize(w, h);
    this.marchMaterial.uniforms.resolution.value.set(w, h);
    this.compositeMaterial.uniforms.lowSize.value.set(w, h);
  }

  setResolutionScale(scale) {
    this.resolutionScale = scale;
    this.setSize(this.fullSize.x, this.fullSize.y);
  }

  /**
   * @param {THREE.SpotLight} light
   * @param {object} o parametri haze-a
   */
  setLight(light, o = {}) {
    this.light = light;
    const u = this.marchMaterial.uniforms;
    if (o.density !== undefined) u.density.value = o.density;
    if (o.ambientDensity !== undefined) u.ambientDensity.value = o.ambientDensity;
    if (o.noiseScale !== undefined) u.noiseScale.value = o.noiseScale;
    if (o.noiseAmount !== undefined) u.noiseAmount.value = o.noiseAmount;
    if (o.g !== undefined) u.g.value = o.g;
    if (o.range !== undefined) u.range.value = o.range;
    if (o.intensity !== undefined) this.intensity = o.intensity;
    if (o.wind) u.wind.value.set(...o.wind);
    this.lightScale = o.lightScale ?? 1;
  }

  setSteps(steps) {
    this.marchMaterial.uniforms.steps.value = steps;
  }

  render(renderer, inputBuffer, outputBuffer, deltaTime) {
    const cam = this.camera;
    const light = this.light;
    const u = this.marchMaterial.uniforms;

    if (cam && light) {
      u.time.value += deltaTime ?? 0.016;
      u.projInv.value.copy(cam.projectionMatrixInverse);
      u.camWorld.value.copy(cam.matrixWorld);
      u.camPos.value.setFromMatrixPosition(cam.matrixWorld);
      light.updateMatrixWorld();
      u.lightPos.value.setFromMatrixPosition(light.matrixWorld);
      const target = new THREE.Vector3().setFromMatrixPosition(light.target.matrixWorld);
      u.lightDir.value.subVectors(target, u.lightPos.value).normalize();
      u.lightColor.value.copy(light.color).multiplyScalar(light.intensity * this.lightScale);
      u.cosOuter.value = Math.cos(light.angle);
      u.cosInner.value = Math.cos(light.angle * (1 - light.penumbra));
      const depthTex = light.castShadow ? light.shadow.map?.depthTexture : null;
      if (depthTex && depthTex.compareFunction == null) {
        u.tShadow.value = depthTex;
        u.shadowMatrix.value.copy(light.shadow.matrix);
        u.useShadow.value = 1;
      } else {
        u.useShadow.value = 0;
      }

      this.quad.material = this.marchMaterial;
      renderer.setRenderTarget(this.lowRT);
      renderer.render(this.quadScene, this.quadCamera);
    }

    const c = this.compositeMaterial.uniforms;
    c.tInput.value = inputBuffer.texture;
    if (cam) c.projInv.value.copy(cam.projectionMatrixInverse);
    c.intensity.value = cam && light ? this.intensity : 0;
    this.quad.material = this.compositeMaterial;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.quadScene, this.quadCamera);
  }

  dispose() {
    this.lowRT.dispose();
    this.noise.dispose();
    this.marchMaterial.dispose();
    this.compositeMaterial.dispose();
    this.quad.geometry.dispose();
  }
}
