// Kontaktne sjene: ortografska kamera ispod plohe gleda prema gore i crta
// objekte (samo layer CONTACT_LAYER) kao tamnu masku po visini, zatim se maska
// zamuti i prikaže na prozirnoj plohi tik iznad podloge (kao drei ContactShadows).

import * as THREE from 'three';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';

export const CONTACT_LAYER = 3;

export class ContactShadows {
  constructor({ width = 30, depth = 30, far = 8, resolution = 512, blur = 2.2, opacity = 0.85, color = '#000000' } = {}) {
    this.group = new THREE.Group();
    this.width = width;
    this.depth = depth;
    this.blur = blur;
    this.frameSkip = 0;

    this.rt = new THREE.WebGLRenderTarget(resolution, resolution, { type: THREE.HalfFloatType });
    this.rtBlur = new THREE.WebGLRenderTarget(resolution, resolution, { type: THREE.HalfFloatType });
    this.rt.texture.generateMipmaps = false;
    this.rtBlur.texture.generateMipmaps = false;

    this.plane = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: this.rt.texture,
        transparent: true,
        opacity,
        depthWrite: false,
        color: new THREE.Color(color),
        toneMapped: false,
      }),
    );
    this.plane.renderOrder = 1;
    // Tekstura je snimljena odozdo — okreni po Y da se poklopi s pogledom odozgo.
    this.plane.scale.z = -1;
    this.plane.material.map = this.rt.texture;
    this.group.add(this.plane);

    this.camera = new THREE.OrthographicCamera(-width / 2, width / 2, depth / 2, -depth / 2, 0, far);
    this.camera.rotation.x = Math.PI / 2; // gleda prema +y
    this.camera.layers.set(CONTACT_LAYER);
    this.group.add(this.camera);

    this.depthMaterial = new THREE.MeshDepthMaterial();
    this.depthMaterial.userData.darkness = { value: 1.6 };
    this.depthMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.darkness = this.depthMaterial.userData.darkness;
      shader.fragmentShader = /* glsl */ `
        uniform float darkness;
        ${shader.fragmentShader.replace(
          'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
          'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );',
        )}
      `;
    };
    this.depthMaterial.depthTest = false;
    this.depthMaterial.depthWrite = false;

    this.hBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
    this.vBlur = new THREE.ShaderMaterial(VerticalBlurShader);
    this.hBlur.depthTest = this.vBlur.depthTest = false;
    this.blurPlane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.blurScene = new THREE.Scene();
    this.blurScene.add(this.blurPlane);
    this.blurCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.blurPlane.position.z = -0.5;
  }

  #blur(renderer, amount) {
    const res = this.rt.width;
    this.blurPlane.material = this.hBlur;
    this.hBlur.uniforms.tDiffuse.value = this.rt.texture;
    this.hBlur.uniforms.h.value = amount / res;
    renderer.setRenderTarget(this.rtBlur);
    renderer.render(this.blurScene, this.blurCam);
    this.blurPlane.material = this.vBlur;
    this.vBlur.uniforms.tDiffuse.value = this.rtBlur.texture;
    this.vBlur.uniforms.v.value = amount / res;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.blurScene, this.blurCam);
  }

  /** Pozvati jednom po frameu (ili rjeđe ako se objekti ne miču). */
  update(renderer, scene) {
    const prevTarget = renderer.getRenderTarget();
    const prevBg = scene.background;
    const prevOverride = scene.overrideMaterial;
    const prevClear = renderer.getClearAlpha();
    const prevAutoClear = renderer.autoClear;
    scene.background = null;
    scene.overrideMaterial = this.depthMaterial;
    renderer.setClearAlpha(0);
    renderer.autoClear = true;
    this.plane.visible = false;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, this.camera);
    scene.overrideMaterial = prevOverride;
    this.#blur(renderer, this.blur);
    this.#blur(renderer, this.blur * 0.4);
    this.plane.visible = true;
    scene.background = prevBg;
    renderer.setClearAlpha(prevClear);
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  dispose() {
    this.rt.dispose();
    this.rtBlur.dispose();
    this.plane.geometry.dispose();
    this.plane.material.dispose();
    this.depthMaterial.dispose();
    this.hBlur.dispose();
    this.vBlur.dispose();
  }
}
