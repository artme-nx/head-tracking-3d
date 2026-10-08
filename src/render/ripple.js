// Titranje stakla nakon udarca: zaslonski pomak slike iza stakla.
// Za svaki piksel nađe se gdje zraka iz kamere siječe ravninu pogođenog stakla;
// ako je staklo ispred onoga što se tu vidi (dubinski spremnik), slika iza stakla
// pomakne se po nagibu vala koji se širi od točke udarca. Objekti ispred stakla
// (npr. jezgra u ruci) ostaju oštri. Prolaz radi samo dok val traje.

import * as THREE from 'three';
import { Pass } from 'postprocessing';

const vertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`;

const fragment = /* glsl */ `
  uniform sampler2D tInput;
  uniform sampler2D tDepth;
  uniform mat4 projInv;
  uniform mat4 camWorld;
  uniform mat4 viewProj;
  uniform vec3 camPos;
  uniform vec4 waves[ 3 ];
  uniform float amps[ 3 ];
  uniform vec3 normals[ 3 ];
  uniform vec3 boxMin;
  uniform vec3 boxMax;
  uniform float strength;
  varying vec2 vUv;

  void main() {
    vec2 ndc = vUv * 2.0 - 1.0;
    vec4 farP = projInv * vec4( ndc, 1.0, 1.0 );
    farP.xyz /= farP.w;
    vec3 rd = normalize( mat3( camWorld ) * farP.xyz );
    float depth = texture2D( tDepth, vUv ).r;
    vec4 vp = projInv * vec4( ndc, depth * 2.0 - 1.0, 1.0 );
    vp.xyz /= vp.w;
    float sceneDist = depth >= 0.99999 ? 1e6 : length( vp.xyz );
    vec2 off = vec2( 0.0 );
    for ( int i = 0; i < 3; i ++ ) {
      float t = waves[ i ].w;
      if ( t < 0.0 || t > 2.0 ) continue;
      vec3 n = normals[ i ];
      float denom = dot( n, rd );
      if ( abs( denom ) < 1e-4 ) continue;
      float s = dot( waves[ i ].xyz - camPos, n ) / denom;
      if ( s <= 0.0 || s > sceneDist ) continue;
      vec3 p = camPos + rd * s;
      if ( any( lessThan( p, boxMin - 0.4 ) ) || any( greaterThan( p, boxMax + 0.4 ) ) ) continue;
      vec3 d = p - waves[ i ].xyz;
      float r = length( d );
      float x = r - 30.0 * t;
      float env = exp( - x * x / 6.0 ) * exp( - t * 2.4 ) * amps[ i ] / ( 1.0 + r * 0.05 );
      float slope = cos( x * 3.3 ) * env;
      float shudder = sin( t * 110.0 ) * exp( - t * 10.0 ) * 0.35 * amps[ i ] * exp( - r / 22.0 );
      // Radijalni smjer vala na ekranu.
      vec4 a = viewProj * vec4( p, 1.0 );
      vec4 b = viewProj * vec4( p + d / max( r, 1e-3 ) * 0.5, 1.0 );
      vec2 dir = b.xy / b.w - a.xy / a.w;
      dir /= max( length( dir ), 1e-6 );
      off += dir * ( slope + shudder );
    }
    gl_FragColor = texture2D( tInput, vUv + off * strength );
  }
`;

export class GlassRipplePass extends Pass {
  constructor() {
    super('GlassRipplePass');
    this.needsDepthTexture = true;
    this.needsSwap = true;
    this.enabled = false;
    this.camera = null;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        tDepth: { value: null },
        projInv: { value: new THREE.Matrix4() },
        camWorld: { value: new THREE.Matrix4() },
        viewProj: { value: new THREE.Matrix4() },
        camPos: { value: new THREE.Vector3() },
        waves: { value: [new THREE.Vector4(0, 0, 0, -1), new THREE.Vector4(0, 0, 0, -1), new THREE.Vector4(0, 0, 0, -1)] },
        amps: { value: [0, 0, 0] },
        normals: { value: [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1)] },
        boxMin: { value: new THREE.Vector3() },
        boxMax: { value: new THREE.Vector3() },
        strength: { value: 0.011 },
      },
      vertexShader: vertex,
      fragmentShader: fragment,
      depthTest: false,
      depthWrite: false,
    });
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(tri, this.material);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  set mainCamera(cam) {
    this.camera = cam;
  }

  setDepthTexture(depthTexture) {
    this.material.uniforms.tDepth.value = depthTexture;
  }

  render(renderer, inputBuffer, outputBuffer) {
    const u = this.material.uniforms;
    const cam = this.camera;
    if (cam) {
      u.projInv.value.copy(cam.projectionMatrixInverse);
      u.camWorld.value.copy(cam.matrixWorld);
      u.viewProj.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      u.camPos.value.setFromMatrixPosition(cam.matrixWorld);
    }
    u.tInput.value = inputBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.quadScene, this.quadCamera);
  }

  dispose() {
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
