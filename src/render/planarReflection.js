// Planarna refleksija poda za off-axis pogled: virtualna kamera stoji u zrcalnoj
// slici oka ispod poda i gleda kroz zrcalnu sliku prozora (Kooima), pa je
// refleksija geometrijski točna za svaki položaj glave. Refleksija se crta u
// smanjenoj rezoluciji, zamuti (mekani odsjaj poliranog kamena) i ubacuje u
// PBR shader poda kao "radiance" — Fresnel i hrapavost rješava three.js BRDF.

import * as THREE from 'three';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';
import { applyOffAxis } from '../projection/offAxis.js';

const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

export class PlanarReflection {
  constructor({ planeY = 0, resolutionScale = 0.5, blur = 3 } = {}) {
    this.planeY = planeY; // u world koordinatama (cm)
    this.resolutionScale = resolutionScale;
    this.blurAmount = blur;
    this.enabled = true;
    this.camera = new THREE.PerspectiveCamera();
    this.camera.layers.enableAll();
    const opts = { type: THREE.HalfFloatType, depthBuffer: true };
    this.rt = new THREE.WebGLRenderTarget(1, 1, opts);
    this.rtBlurA = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.rtBlurB = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.uniforms = {
      tReflect: { value: this.rt.texture },
      tReflectBlur: { value: this.rtBlurB.texture },
      reflectMatrix: { value: new THREE.Matrix4() },
      reflectStrength: { value: 1 },
    };
    this.hide = []; // objekti koji se ne crtaju u refleksiji (pod, skupi efekti)
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this.hBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
    this.vBlur = new THREE.ShaderMaterial(VerticalBlurShader);
    this.blurQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.blurScene = new THREE.Scene();
    this.blurScene.add(this.blurQuad);
    this.blurCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.blurQuad.position.z = -0.5;
    this.size = new THREE.Vector2(1, 1);
    this._pa = new THREE.Vector3();
    this._pb = new THREE.Vector3();
    this._pc = new THREE.Vector3();
    this._pe = new THREE.Vector3();
  }

  setSize(width, height) {
    const w = Math.max(2, Math.round(width * this.resolutionScale));
    const h = Math.max(2, Math.round(height * this.resolutionScale));
    this.size.set(w, h);
    this.rt.setSize(w, h);
    this.rtBlurA.setSize(w >> 1, h >> 1);
    this.rtBlurB.setSize(w >> 1, h >> 1);
  }

  /** Ubaci refleksiju u MeshStandard/Physical materijal poda. */
  patch(material) {
    const uniforms = this.uniforms;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      prev?.call(material, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vReflWorld;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvReflWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform sampler2D tReflect;
          uniform sampler2D tReflectBlur;
          uniform mat4 reflectMatrix;
          uniform float reflectStrength;
          varying vec3 vReflWorld;`,
        )
        .replace(
          '#include <lights_fragment_maps>',
          `#include <lights_fragment_maps>
          {
            vec3 wn = inverseTransformDirection( normal, viewMatrix );
            vec4 rc = reflectMatrix * vec4( vReflWorld + vec3( wn.x, 0.0, wn.z ) * 0.6, 1.0 );
            vec2 ruv = rc.xy / rc.w;
            if ( rc.w > 0.0 && ruv.x > 0.0 && ruv.x < 1.0 && ruv.y > 0.0 && ruv.y < 1.0 ) {
              vec4 sharp = texture2D( tReflect, ruv );
              vec4 soft = texture2D( tReflectBlur, ruv );
              vec4 refl = mix( sharp, soft, smoothstep( 0.04, 0.3, roughnessFactor ) );
              radiance = mix( radiance, refl.rgb, refl.a * reflectStrength );
            }
          }`,
        );
    };
    const prevKey = material.customProgramCacheKey?.bind(material);
    material.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|planarReflection';
    material.needsUpdate = true;
  }

  #blur(renderer) {
    const q = this.blurQuad;
    const w = this.rtBlurA.width, h = this.rtBlurA.height;
    // Prvi prolaz čita punu refleksiju, drugi i treći ping-pong.
    const passes = [
      [this.hBlur, this.rt.texture, this.rtBlurA, 'h', this.blurAmount / w],
      [this.vBlur, this.rtBlurA.texture, this.rtBlurB, 'v', this.blurAmount / h],
      [this.hBlur, this.rtBlurB.texture, this.rtBlurA, 'h', (this.blurAmount * 0.5) / w],
      [this.vBlur, this.rtBlurA.texture, this.rtBlurB, 'v', (this.blurAmount * 0.5) / h],
    ];
    for (const [mat, src, dst, key, amount] of passes) {
      q.material = mat;
      mat.uniforms.tDiffuse.value = src;
      mat.uniforms[key].value = amount;
      renderer.setRenderTarget(dst);
      renderer.render(this.blurScene, this.blurCam);
    }
  }

  /**
   * @param {THREE.Vector3} eye položaj oka (world)
   * @param rect fizički pravokutnik prozora (world, z = 0)
   */
  update(renderer, scene, eye, rect, near = 0.5, far = 2000) {
    if (!this.enabled) return;
    const y = this.planeY;
    this._pe.set(eye.x, 2 * y - eye.y, eye.z);
    this._pa.set(rect.x0, 2 * y - rect.y1, 0);
    this._pb.set(rect.x1, 2 * y - rect.y1, 0);
    this._pc.set(rect.x0, 2 * y - rect.y0, 0);
    applyOffAxis(this.camera, this._pa, this._pb, this._pc, this._pe, near, far);

    this.uniforms.reflectMatrix.value
      .copy(bias)
      .multiply(this.camera.projectionMatrix)
      .multiply(this.camera.matrixWorldInverse);

    const prevTarget = renderer.getRenderTarget();
    const prevBg = scene.background;
    const prevClipping = renderer.clippingPlanes;
    const prevAutoClear = renderer.autoClear;
    const prevClearAlpha = renderer.getClearAlpha();
    const hidden = this.hide.map((o) => [o, o.visible]);
    for (const [o] of hidden) o.visible = false;
    scene.background = null;
    this.clipPlane.constant = -y;
    renderer.clippingPlanes = [this.clipPlane];
    renderer.autoClear = true;
    renderer.setClearAlpha(0);
    renderer.setRenderTarget(this.rt);
    renderer.render(scene, this.camera);
    renderer.clippingPlanes = prevClipping;
    for (const [o, v] of hidden) o.visible = v;
    scene.background = prevBg;
    this.#blur(renderer);
    renderer.autoClear = prevAutoClear;
    renderer.setClearAlpha(prevClearAlpha);
    renderer.setRenderTarget(prevTarget);
  }

  dispose() {
    this.rt.dispose();
    this.rtBlurA.dispose();
    this.rtBlurB.dispose();
    this.hBlur.dispose();
    this.vBlur.dispose();
  }
}
