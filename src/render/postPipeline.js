// Postprocessing za "AAA" scene (3 i 4), pmndrs postprocessing + N8AO:
//   RenderPass → N8AO (ambijentalna okluzija) → volumetrijski snop
//   → [selektivni bloom + tone mapping] → [SMAA + vinjeta + film grain] → izlaz.
// Bez dubinske oštrine — off-axis projekcija mora ostati oštra.
// Izlaz ide na ekran ili u render target (za anaglif: po jedan za svako oko).

import * as THREE from 'three';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  Pass,
  SelectiveBloomEffect,
  ToneMappingEffect,
  ToneMappingMode,
  SMAAEffect,
  SMAAPreset,
  EdgeDetectionMode,
  VignetteEffect,
  NoiseEffect,
  BlendFunction,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { VolumetricSpotPass } from './volumetric.js';
import { GlassRipplePass } from './ripple.js';

class OutputPass extends Pass {
  constructor() {
    super('OutputPass');
    this.needsSwap = false;
    this.target = null;
    this.fullscreenMaterial = new THREE.ShaderMaterial({
      uniforms: { tInput: { value: null } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tInput; varying vec2 vUv;
        void main(){
          gl_FragColor = vec4( texture2D( tInput, vUv ).rgb, 1.0 );
          #include <colorspace_fragment>
        }`,
      depthTest: false,
      depthWrite: false,
    });
  }

  render(renderer, inputBuffer) {
    this.fullscreenMaterial.uniforms.tInput.value = inputBuffer.texture;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
  }
}

// pixelRatio 1.75: na MacBooku sa zadanim skaliranjem Chrome crta 2940×1912,
// a panel ima 2560×1664 — 1.75 odgovara nativnim pikselima panela.
export const QUALITY = {
  high: {
    pixelRatio: 1.75,
    minPixelRatio: 1.25,
    aoHalfRes: true,
    aoSamples: 8,
    aoDenoise: 4,
    volScale: 0.35,
    volSteps: 26,
    smaa: SMAAPreset.HIGH,
    bloomLevels: 8,
    reflectionScale: 0.5,
    shadowMap: 2048,
  },
  low: {
    pixelRatio: 1,
    minPixelRatio: 0.85,
    aoHalfRes: true,
    aoSamples: 6,
    aoDenoise: 4,
    volScale: 0.28,
    volSteps: 18,
    smaa: SMAAPreset.MEDIUM,
    bloomLevels: 6,
    reflectionScale: 0.3,
    shadowMap: 1024,
  },
};

export class PostPipeline {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.quality = 'high';

    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
    });

    this.renderPass = new RenderPass(scene, camera);
    this.n8ao = new N8AOPostPass(scene, camera, 1, 1);
    Object.assign(this.n8ao.configuration, {
      gammaCorrection: false,
      aoRadius: 4,
      distanceFalloff: 1.2,
      intensity: 2.2,
      aoSamples: 16,
      denoiseSamples: 8,
      denoiseRadius: 10,
      halfRes: false,
      depthAwareUpsampling: true,
      color: new THREE.Color(0, 0, 0),
      // Bez ovoga N8AO sam uključi transparencyAware čim vidi staklo/prašinu i
      // svaki frame dodatno iscrta prozirne objekte u dvije pune mete.
      transparencyAware: false,
    });

    this.volumetric = new VolumetricSpotPass();
    // Titranje stakla (samo dok traje val nakon udarca; inače isključeno).
    this.ripple = new GlassRipplePass();

    this.bloom = new SelectiveBloomEffect(scene, camera, {
      mipmapBlur: true,
      intensity: 1.4,
      radius: 0.62,
      levels: 8,
      luminanceThreshold: 0.9,
      luminanceSmoothing: 0.3,
    });
    this.bloom.ignoreBackground = true;
    this.toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
    this.gradePass = new EffectPass(camera, this.bloom, this.toneMapping);

    this.smaa = new SMAAEffect({ preset: SMAAPreset.HIGH, edgeDetectionMode: EdgeDetectionMode.COLOR });
    this.vignette = new VignetteEffect({ offset: 0.32, darkness: 0.55 });
    this.grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
    this.grain.blendMode.opacity.value = 0.07;
    this.finishPass = new EffectPass(camera, this.smaa, this.vignette, this.grain);

    this.output = new OutputPass();

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.n8ao);
    this.composer.addPass(this.volumetric);
    this.composer.addPass(this.ripple);
    this.composer.addPass(this.gradePass);
    this.composer.addPass(this.finishPass);
    this.composer.addPass(this.output);
    this.finishPass.renderToScreen = false;
    this.output.renderToScreen = true;
  }

  /** Postavke po sceni: bloom, AO, tone mapping, volumetrija. */
  configure(o = {}) {
    if (o.toneMapping) this.toneMapping.mode = ToneMappingMode[o.toneMapping];
    if (o.bloom) {
      const b = o.bloom;
      if (b.intensity !== undefined) this.bloom.intensity = b.intensity;
      if (b.threshold !== undefined) this.bloom.luminanceMaterial.threshold = b.threshold;
      if (b.smoothing !== undefined) this.bloom.luminanceMaterial.smoothing = b.smoothing;
      if (b.radius !== undefined) this.bloom.mipmapBlurPass.radius = b.radius;
    }
    if (o.ao) Object.assign(this.n8ao.configuration, o.ao);
    if (o.vignette) {
      if (o.vignette.darkness !== undefined) this.vignette.darkness = o.vignette.darkness;
      if (o.vignette.offset !== undefined) this.vignette.offset = o.vignette.offset;
    }
    if (o.grain !== undefined) this.grain.blendMode.opacity.value = o.grain;
    if (o.exposure !== undefined) this.renderer.toneMappingExposure = o.exposure;
    if ('volumetric' in o) {
      if (o.volumetric) {
        this.volumetric.enabled = true;
        this.volumetric.setLight(o.volumetric.light, o.volumetric);
      } else {
        this.volumetric.enabled = false;
        this.volumetric.light = null;
      }
    }
    this.bloom.selection.clear();
    for (const obj of o.bloomSelection ?? []) this.bloom.selection.add(obj);
  }

  setQuality(name) {
    const q = QUALITY[name];
    this.quality = name;
    Object.assign(this.n8ao.configuration, {
      halfRes: q.aoHalfRes,
      aoSamples: q.aoSamples,
      denoiseSamples: q.aoDenoise,
    });
    this.volumetric.setResolutionScale(q.volScale);
    this.volumetric.setSteps(q.volSteps);
    this.smaa.applyPreset?.(q.smaa);
    return q;
  }

  setSize(width, height) {
    this.composer.setSize(width, height, false);
    this.n8ao.setSize(this.renderer.getDrawingBufferSize(new THREE.Vector2()).x, this.renderer.getDrawingBufferSize(new THREE.Vector2()).y);
  }

  /** @param {THREE.Camera} camera @param {THREE.WebGLRenderTarget|null} target */
  render(camera, dt, target = null) {
    this.composer.setMainCamera(camera);
    this.n8ao.camera = camera;
    this.volumetric.mainCamera = camera;
    this.ripple.mainCamera = camera;
    // Na ekran ide izravno zadnji efekt (sRGB); u render target (anaglif) preko OutputPassa.
    const toScreen = target === null;
    this.finishPass.renderToScreen = toScreen;
    this.output.enabled = !toScreen;
    this.output.target = target;
    this.composer.render(dt);
  }
}
