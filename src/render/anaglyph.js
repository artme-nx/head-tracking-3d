// Crveno-cijan anaglif: scena se iscrtava dvaput (lijevo / desno oko) u
// render targete, a zatim spaja: crveni kanal iz lijevog oka (luminancija,
// "half-color" smanjuje retinalno suparništvo), zeleni i plavi iz desnog.

import * as THREE from 'three';

export class AnaglyphRenderer {
  constructor(renderer) {
    this.renderer = renderer;
    const opts = { type: THREE.HalfFloatType, samples: 4 };
    this.left = new THREE.WebGLRenderTarget(1, 1, opts);
    this.right = new THREE.WebGLRenderTarget(1, 1, opts);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tLeft: { value: this.left.texture },
        tRight: { value: this.right.texture },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tLeft;
        uniform sampler2D tRight;
        varying vec2 vUv;
        void main() {
          vec3 l = texture2D(tLeft, vUv).rgb;
          vec3 r = texture2D(tRight, vUv).rgb;
          float lumL = dot(l, vec3(0.299, 0.587, 0.114));
          gl_FragColor = vec4(lumL, r.g, r.b, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCamera = new THREE.Camera();
  }

  setSize(width, height) {
    this.left.setSize(width, height);
    this.right.setSize(width, height);
  }

  render(scene, camLeft, camRight) {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.left);
    r.clear();
    r.render(scene, camLeft);
    r.setRenderTarget(this.right);
    r.clear();
    r.render(scene, camRight);
    r.setRenderTarget(prev);
    r.render(this.quadScene, this.quadCamera);
  }

  /** Spoji već iscrtane slike (npr. iz postprocessing pipelinea) na ekran. */
  combine() {
    const r = this.renderer;
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCamera);
  }

  dispose() {
    this.left.dispose();
    this.right.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
