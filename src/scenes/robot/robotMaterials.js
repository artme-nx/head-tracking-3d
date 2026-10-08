// Materijali robota: mat-bijela keramika s glazurom i proceduralnim panel
// linijama + natpisima, tamni karbon (twill tkanje pod lakom), grafitni metal,
// anodizirani titan, krom, pletena kabelska košuljica, staklo objektiva.

import * as THREE from 'three';
import { extendMaterial } from '../../render/materials.js';

/**
 * Keramika s panel linijama i natpisima. Panel linije su zadane GLSL funkcijom
 * udaljenosti (u object prostoru), natpisi su projicirani decali iz atlasa.
 * @param {string} panelGLSL tijelo funkcije `float panelDist(vec3 p)` (vraća udaljenost u cm)
 * @param {object[]} decals [{ center:[x,y,z], normal:[x,y,z], up:[x,y,z], size:[w,h], rect:[u0,v0,u1,v1], color }]
 */
export function ceramicMaterial({ color = '#d4d1cb', panelGLSL = 'return 1e3;', decals = [], atlas = null, key = 'ceramic' } = {}) {
  const m = new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.34,
    metalness: 0,
    clearcoat: 0.55,
    clearcoatRoughness: 0.16,
    envMapIntensity: 1.0,
    specularIntensity: 0.8,
  });
  const N = Math.max(1, decals.length);
  const uniforms = {
    decalAtlas: { value: atlas },
    decalCenter: { value: decals.map((d) => new THREE.Vector3(...d.center)).concat([]) },
    decalU: { value: [] },
    decalV: { value: [] },
    decalN: { value: [] },
    decalRect: { value: decals.map((d) => new THREE.Vector4(...d.rect)) },
    decalColor: { value: decals.map((d) => new THREE.Color(d.color ?? '#2a2c30')) },
  };
  for (const d of decals) {
    const n = new THREE.Vector3(...d.normal).normalize();
    const up = new THREE.Vector3(...d.up);
    const u = new THREE.Vector3().crossVectors(up, n).normalize();
    const v = new THREE.Vector3().crossVectors(n, u).normalize();
    uniforms.decalU.value.push(u.divideScalar(d.size[0]));
    uniforms.decalV.value.push(v.divideScalar(d.size[1]));
    uniforms.decalN.value.push(n);
  }
  if (!decals.length) {
    uniforms.decalCenter.value = [new THREE.Vector3(1e4, 0, 0)];
    uniforms.decalU.value = [new THREE.Vector3()];
    uniforms.decalV.value = [new THREE.Vector3()];
    uniforms.decalN.value = [new THREE.Vector3(0, 0, 1)];
    uniforms.decalRect.value = [new THREE.Vector4()];
    uniforms.decalColor.value = [new THREE.Color()];
  }
  return extendMaterial(m, {
    key: `${key}${N}`,
    uniforms,
    // Dubina vrha ispod vanjske površine (iz SDF-a): 0 vani, ~-0,4 na unutarnjoj plohi panela.
    vertexPars: 'attribute float shellDepth; varying float vShellDepth;',
    vertexMain: 'vShellDepth = shellDepth;',
    fragmentPars: /* glsl */ `
      varying float vShellDepth;
      #define DECALS ${N}
      uniform sampler2D decalAtlas;
      uniform vec3 decalCenter[DECALS];
      uniform vec3 decalU[DECALS];
      uniform vec3 decalV[DECALS];
      uniform vec3 decalN[DECALS];
      uniform vec4 decalRect[DECALS];
      uniform vec3 decalColor[DECALS];
      float innerSide;
      float panelDist( vec3 p ) { ${panelGLSL} }
      float panelLine;
      float panelEdge;
      vec3 decalTint;
      float decalMask;
    `,
    hooks: {
      color_fragment: /* glsl */ `
        {
          // Panel linije: tanki utori s mekim rubom (+ blago potamnjenje kao AO u utoru).
          float pd = panelDist( vObjPos );
          float w = 0.028;
          panelLine = 1.0 - smoothstep( w * 0.6, w, pd );
          panelEdge = 1.0 - smoothstep( w, w * 2.6, pd );
          diffuseColor.rgb *= 1.0 - panelLine * 0.72 - ( panelEdge - panelLine ) * 0.08;
          // Fina varijacija glazure.
          diffuseColor.rgb *= 0.97 + 0.03 * vnoise( vObjPos * 3.0 );
          decalMask = 0.0;
          decalTint = vec3( 0.0 );
          #if DECALS > 0
          for ( int i = 0; i < DECALS; i ++ ) {
            vec3 d = vObjPos - decalCenter[ i ];
            float depth = dot( d, decalN[ i ] );
            vec2 uv = vec2( dot( d, decalU[ i ] ), dot( d, decalV[ i ] ) ) + 0.5;
            if ( abs( depth ) < 1.4 && uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0 && dot( normalize( vObjNormal ), decalN[ i ] ) > 0.2 ) {
              vec2 auv = mix( decalRect[ i ].xy, decalRect[ i ].zw, uv );
              float a = texture2D( decalAtlas, auv ).a;
              decalMask = max( decalMask, a );
              decalTint = mix( decalTint, decalColor[ i ], a );
            }
          }
          diffuseColor.rgb = mix( diffuseColor.rgb, decalTint, decalMask * 0.92 );
          #endif
          // Unutarnja ploha ljuske (vidi se tek kad je robot rastavljen): tamni, mat kompozit.
          innerSide = smoothstep( 0.14, 0.32, -vShellDepth );
          diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.05, 0.052, 0.056 ) * ( 0.85 + 0.3 * vnoise( vObjPos * 6.0 ) ), innerSide * 0.94 );
        }
      `,
      roughnessmap_fragment: /* glsl */ `
        roughnessFactor = clamp( roughnessFactor + panelLine * 0.4 + decalMask * 0.12 + ( vnoise( vObjPos * 1.7 + 4.0 ) - 0.5 ) * 0.06, 0.04, 1.0 );
        roughnessFactor = mix( roughnessFactor, 0.8, innerSide );
      `,
      lights_physical_fragment: /* glsl */ `
        #ifdef USE_CLEARCOAT
          material.clearcoat *= 1.0 - innerSide;
        #endif
      `,
      normal_fragment_maps: /* glsl */ `
        {
          // Rubovi utora lome odsjaj (zakošeni rub panela).
          float h = -panelEdge * 0.6 - panelLine * 0.4;
          normal = bumpFromHeight( -vViewPosition, normal, h, 0.02 );
        }
      `,
      clearcoat_normal_fragment_maps: /* glsl */ `
        #ifdef USE_CLEARCOAT
          clearcoatNormal = normal;
        #endif
      `,
    },
  });
}

/** Karbon: twill 2×2 tkanje pod debelim lakom (anizotropni sjaj vlakana). */
export function carbonMaterial({ scale = 0.35 } = {}) {
  const m = new THREE.MeshPhysicalMaterial({
    color: '#16181b',
    metalness: 0.25,
    roughness: 0.38,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    envMapIntensity: 1.1,
  });
  return extendMaterial(m, {
    key: 'carbon',
    uniforms: { weaveScale: { value: 1 / scale } },
    fragmentPars: /* glsl */ `
      uniform float weaveScale;
      float weave;
      vec2 weaveDir;
    `,
    hooks: {
      color_fragment: /* glsl */ `
        {
          vec3 an = abs( vObjNormal );
          vec2 p = ( an.x > an.y && an.x > an.z ? vObjPos.zy : ( an.y > an.z ? vObjPos.xz : vObjPos.xy ) ) * weaveScale;
          vec2 cell = floor( p );
          vec2 f = fract( p );
          // Twill: smjer vlakna mijenja se dijagonalno po ćelijama.
          float twill = mod( cell.x + cell.y * 1.0, 4.0 ) < 2.0 ? 1.0 : 0.0;
          float along = twill > 0.5 ? f.x : f.y;
          float across = twill > 0.5 ? f.y : f.x;
          float tow = sin( across * 3.14159 );
          weave = twill;
          weaveDir = twill > 0.5 ? vec2( 1.0, 0.0 ) : vec2( 0.0, 1.0 );
          diffuseColor.rgb *= 0.65 + 0.55 * tow * ( 0.7 + 0.3 * sin( along * 40.0 ) );
        }
      `,
      roughnessmap_fragment: /* glsl */ `
        roughnessFactor = mix( 0.22, 0.48, weave );
      `,
      normal_fragment_maps: /* glsl */ `
        {
          vec3 an = abs( vObjNormal );
          vec2 p = ( an.x > an.y && an.x > an.z ? vObjPos.zy : ( an.y > an.z ? vObjPos.xz : vObjPos.xy ) ) * weaveScale;
          vec2 f = fract( p );
          float across = weave > 0.5 ? f.y : f.x;
          normal = bumpFromHeight( -vViewPosition, normal, sin( across * 3.14159 ), 0.01 );
        }
      `,
    },
  });
}

export function graphiteMaterial(color = '#1d1f23') {
  return new THREE.MeshPhysicalMaterial({ color, metalness: 0.8, roughness: 0.48, envMapIntensity: 0.9 });
}

export function anodizedMaterial(color = '#4a5868') {
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness: 1,
    roughness: 0.3,
    iridescence: 0.12,
    iridescenceIOR: 1.4,
    envMapIntensity: 1.1,
  });
}

/** Pletena kabelska košuljica: dijagonalni uzorak preko UV-a TubeGeometry. */
export function braidedMaterial(color = '#16171a') {
  // Tekstilna košuljica: mala refleksivnost (F0), inače rim svjetla straga
  // na kliznim kutovima "izbijele" cijeli tanki kabel.
  const m = new THREE.MeshPhysicalMaterial({ color, metalness: 0, roughness: 0.78, specularIntensity: 0.18 });
  return extendMaterial(m, {
    key: 'braided',
    vertexPars: 'varying vec2 vBraidUv;',
    vertexMain: 'vBraidUv = uv;',
    fragmentPars: 'varying vec2 vBraidUv; float braid;',
    hooks: {
      color_fragment: /* glsl */ `
        {
          vec2 p = vec2( vBraidUv.x * 220.0, vBraidUv.y * 12.0 );
          float a = sin( ( p.x + p.y ) * 3.14159 );
          float b = sin( ( p.x - p.y ) * 3.14159 );
          braid = max( a, b );
          diffuseColor.rgb *= 0.7 + 0.45 * braid;
        }
      `,
      normal_fragment_maps: /* glsl */ `
        normal = bumpFromHeight( -vViewPosition, normal, braid, 0.006 );
      `,
    },
  });
}

/** Staklo objektiva/rožnice: samo refleksije (Fresnel) + iridescentna AR prevlaka. */
export function lensMaterial() {
  const m = new THREE.MeshPhysicalMaterial({
    color: '#000000',
    metalness: 0,
    roughness: 0.02,
    iridescence: 0.85,
    iridescenceIOR: 1.32,
    iridescenceThicknessRange: [320, 520],
    specularIntensity: 1,
    envMapIntensity: 1.0,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  return extendMaterial(m, {
    key: 'lensGlass',
    hooks: {
      opaque_fragment: `gl_FragColor = vec4( outgoingLight, 0.06 );`,
    },
  });
}
