// Animirane kaustike kristala: proceduralni uzorak (iterirana domenska
// distorzija, Dave Hoskins) s kromatskom disperzijom, renderiran u teksturu
// koja se projicira spot svjetlom (light cookie) na postolje vitrine.

import * as THREE from 'three';

const frag = /* glsl */ `
  uniform float time;
  uniform float rotation;
  uniform float breath;
  varying vec2 vUv;
  #define TAU 6.28318530718

  float caustic( vec2 uv, float t ) {
    vec2 p = mod( uv * TAU, TAU ) - 250.0;
    vec2 i = p;
    float c = 1.0;
    float inten = 0.0048;
    for ( int n = 0; n < 5; n ++ ) {
      float tt = t * ( 1.0 - ( 3.5 / float( n + 1 ) ) );
      i = p + vec2( cos( tt - i.x ) + sin( tt + i.y ), sin( tt - i.y ) + cos( tt + i.x ) );
      c += 1.0 / length( vec2( p.x / ( sin( i.x + tt ) / inten ), p.y / ( cos( i.y + tt ) / inten ) ) );
    }
    c /= 5.0;
    c = 1.17 - pow( c, 1.4 );
    return pow( abs( c ), 7.0 );
  }

  void main() {
    vec2 q = vUv - 0.5;
    float r = length( q );
    float cs = cos( rotation ), sn = sin( rotation );
    vec2 rq = mat2( cs, -sn, sn, cs ) * q * ( 1.0 + breath * 0.08 );
    float t = time * 0.35;
    // Disperzija: R, G, B uzorkovani s malo različitim mjerilom.
    vec2 uv = rq * 1.35 + 0.5;
    float cr = caustic( uv * 0.985, t );
    float cg = caustic( uv, t + 0.03 );
    float cb = caustic( uv * 1.017, t + 0.06 );
    vec3 col = vec3( cr, cg, cb );
    // Fasete kristala: nekoliko oštrijih "zraka" koje se okreću s kristalom.
    float ang = atan( rq.y, rq.x );
    float rays = pow( max( 0.0, cos( ang * 7.0 ) ), 24.0 ) * smoothstep( 0.45, 0.1, r ) * 0.6;
    col += vec3( 1.0, 0.95, 0.85 ) * rays;
    col *= smoothstep( 0.5, 0.18, r );
    col += vec3( 0.06 ) * smoothstep( 0.5, 0.0, r );
    gl_FragColor = vec4( col, 1.0 );
  }
`;

export class CausticsTexture {
  constructor(size = 512) {
    this.rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType });
    this.rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.material = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, rotation: { value: 0 }, breath: { value: 0 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: frag,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  get texture() {
    return this.rt.texture;
  }

  render(renderer, time, rotation, breath) {
    const u = this.material.uniforms;
    u.time.value = time;
    u.rotation.value = rotation;
    u.breath.value = breath;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prev);
  }

  dispose() {
    this.rt.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
