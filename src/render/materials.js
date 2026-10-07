// Materijali za AAA scene: proširenja MeshPhysicalMaterial-a s proceduralnim
// detaljima u object/world prostoru (MC mreže nemaju UV), plus tvorničke funkcije.

import * as THREE from 'three';

export const NOISE_GLSL = /* glsl */ `
  float hash13( vec3 p3 ) {
    p3 = fract( p3 * 0.1031 );
    p3 += dot( p3, p3.zyx + 31.32 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }
  float vnoise( vec3 p ) {
    vec3 i = floor( p );
    vec3 f = fract( p );
    f = f * f * ( 3.0 - 2.0 * f );
    float n000 = hash13( i );
    float n100 = hash13( i + vec3( 1, 0, 0 ) );
    float n010 = hash13( i + vec3( 0, 1, 0 ) );
    float n110 = hash13( i + vec3( 1, 1, 0 ) );
    float n001 = hash13( i + vec3( 0, 0, 1 ) );
    float n101 = hash13( i + vec3( 1, 0, 1 ) );
    float n011 = hash13( i + vec3( 0, 1, 1 ) );
    float n111 = hash13( i + vec3( 1, 1, 1 ) );
    return mix( mix( mix( n000, n100, f.x ), mix( n010, n110, f.x ), f.y ),
                mix( mix( n001, n101, f.x ), mix( n011, n111, f.x ), f.y ), f.z );
  }
  float fbm3( vec3 p ) {
    float a = 0.5, s = 0.0;
    for ( int i = 0; i < 4; i ++ ) { s += a * vnoise( p ); p = p * 2.03 + 17.1; a *= 0.5; }
    return s;
  }
  // Bump iz skalarne visine preko derivacija ekrana (Mikkelsen).
  vec3 bumpFromHeight( vec3 surfPos, vec3 surfNorm, float height, float scale ) {
    vec3 sx = dFdx( surfPos );
    vec3 sy = dFdy( surfPos );
    vec3 r1 = cross( sy, surfNorm );
    vec3 r2 = cross( surfNorm, sx );
    float det = dot( sx, r1 );
    float dhx = dFdx( height ) * scale;
    float dhy = dFdy( height ) * scale;
    vec3 grad = sign( det ) * ( dhx * r1 + dhy * r2 );
    return normalize( abs( det ) * surfNorm - grad );
  }
`;

/**
 * Proširi materijal kodom koji se umeće iza zadanih #include linija.
 * @param {THREE.Material} material
 * @param {{key:string, uniforms?:object, vertexPars?:string, vertexMain?:string,
 *          fragmentPars?:string, hooks?:Record<string,string>}} ext
 */
export function extendMaterial(material, ext) {
  const uniforms = ext.uniforms ?? {};
  material.userData.uniforms = uniforms;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vObjPos;
        varying vec3 vObjNormal;
        varying vec3 vWorldPos;
        ${ext.vertexPars ?? ''}`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vObjPos = position;
        vObjNormal = normal;
        vWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
        ${ext.vertexMain ?? ''}`,
      );
    let fs = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
      varying vec3 vObjPos;
      varying vec3 vObjNormal;
      varying vec3 vWorldPos;
      ${NOISE_GLSL}
      ${ext.fragmentPars ?? ''}`,
    );
    for (const [chunk, code] of Object.entries(ext.hooks ?? {})) {
      const tag = `#include <${chunk}>`;
      if (!fs.includes(tag)) console.warn(`extendMaterial: nema ${tag}`);
      fs = fs.replace(tag, `${tag}\n${code}`);
    }
    shader.fragmentShader = fs;
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|${ext.key}`;
  material.needsUpdate = true;
  return material;
}

/** Polirani krom. */
export function chromeMaterial() {
  return new THREE.MeshPhysicalMaterial({
    color: '#cfd1d4',
    metalness: 1,
    roughness: 0.035,
    envMapIntensity: 1,
  });
}

/**
 * Optički kristal bez three.js transmisijskog prolaza (koji bi ponovno iscrtao
 * cijelu scenu): lom svjetla se računa iz env mape s kromatskom disperzijom
 * (zasebni IOR za R, G, B), dodaje se lomljena slika užarene jezgre i
 * aproksimacija unutarnje refleksije. Površina ostaje fizikalna (iridiscencija,
 * Fresnel, odsjaji svih svjetala).
 */
export function crystalMaterial({ ior = 2.1, dispersion = 0.045, coreColor = '#fff1dc' } = {}) {
  const m = new THREE.MeshPhysicalMaterial({
    color: '#000000',
    metalness: 0,
    roughness: 0.0,
    ior,
    specularIntensity: 1,
    iridescence: 0.55,
    iridescenceIOR: 1.45,
    iridescenceThicknessRange: [260, 620],
    envMapIntensity: 1.6,
    flatShading: true,
  });
  const uniforms = {
    crystalIor: { value: ior },
    crystalDispersion: { value: dispersion },
    coreColor: { value: new THREE.Color(coreColor).multiplyScalar(12) },
    coreCenter: { value: new THREE.Vector3() },
    coreRadius: { value: 0.45 },
    tint: { value: new THREE.Color('#eaf6ff') },
  };
  m.userData.crystal = uniforms;
  return extendMaterial(m, {
    key: 'crystalRefraction',
    uniforms,
    fragmentPars: /* glsl */ `
      uniform float crystalIor;
      uniform float crystalDispersion;
      uniform vec3 coreColor;
      uniform vec3 coreCenter;
      uniform float coreRadius;
      uniform vec3 tint;
    `,
    hooks: {
      envmap_physical_pars_fragment: /* glsl */ `
      vec3 crystalEnv( vec3 dir, float rough ) {
        #if defined( ENVMAP_TYPE_CUBE_UV )
          return textureCubeUV( envMap, envMapRotation * dir, rough ).rgb * envMapIntensity;
        #else
          return vec3( 0.0 );
        #endif
      }
      // Sjaj jezgre duž lomljene zrake: udaljenost zrake od središta.
      float coreGlow( vec3 ro, vec3 rd ) {
        vec3 oc = coreCenter - ro;
        float t = max( dot( oc, rd ), 0.0 );
        float d = length( oc - rd * t );
        return exp( - ( d * d ) / ( coreRadius * coreRadius ) );
      }
      `,
      opaque_fragment: /* glsl */ `
        {
          vec3 wN = normalize( inverseTransformDirection( normal, viewMatrix ) );
          vec3 V = normalize( cameraPosition - vWorldPos );
          float NdV = clamp( dot( wN, V ), 0.0, 1.0 );
          float F = 0.04 + 0.96 * pow( 1.0 - NdV, 5.0 );
          float etaG = 1.0 / crystalIor;
          vec3 rR = refract( -V, wN, etaG * ( 1.0 - crystalDispersion ) );
          vec3 rG = refract( -V, wN, etaG );
          vec3 rB = refract( -V, wN, etaG * ( 1.0 + crystalDispersion ) );
          // Druga "faseta": unutarnja refleksija rotira smjer — iskričavost dragulja.
          vec3 inner = reflect( rG, normalize( wN + vec3( 0.37, -0.61, 0.29 ) ) );
          vec3 refr = vec3(
            crystalEnv( rR, 0.0 ).r,
            crystalEnv( rG, 0.0 ).g,
            crystalEnv( rB, 0.0 ).b
          );
          refr += crystalEnv( inner, 0.05 ) * 0.45;
          vec3 glow = coreColor * vec3( coreGlow( vWorldPos, rR ), coreGlow( vWorldPos, rG ), coreGlow( vWorldPos, rB ) );
          vec3 body = ( refr * tint + glow ) * ( 1.0 - F );
          gl_FragColor = vec4( outgoingLight + body, 1.0 );
        }
      `,
    },
  });
}

/**
 * Tanko staklo vitrine: reflektira okolinu (Fresnel), propušta pozadinu, ima
 * mrlje (veća hrapavost) i prašinu (difuzno). Premultiplied blending:
 * boja = refleksija + prašina, alfa = apsorpcija.
 */
export function glassPaneMaterial(smudgeTex, repeat = 1, dustAmount = 0.3) {
  const tex = smudgeTex.clone();
  tex.repeat.set(repeat, repeat);
  tex.needsUpdate = true;
  const m = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    metalness: 0,
    roughness: 1,
    roughnessMap: tex,
    map: tex,
    envMapIntensity: 1.25,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  return extendMaterial(m, {
    key: 'glassPane',
    uniforms: { dustAmount: { value: dustAmount } },
    fragmentPars: 'uniform float dustAmount;',
    hooks: {
      // map: R kanal = prašina → difuzna boja; G = hrapavost; B = alfa.
      map_fragment: `
        float dust = sampledDiffuseColor.r;
        float glassAlpha = sampledDiffuseColor.b;
        diffuseColor.rgb = vec3( 0.75, 0.73, 0.7 ) * dust * dustAmount;
      `,
      roughnessmap_fragment: `
        roughnessFactor = clamp( texelRoughness.g * 2.2, 0.025, 0.6 );
      `,
      opaque_fragment: `
        gl_FragColor = vec4( outgoingLight, clamp( glassAlpha * 1.4 + dust * dustAmount * 0.25, 0.015, 0.4 ) );
      `,
    },
  });
}

/** Rub stakla — zelenkast kao pravo float staklo (željezo u staklu). */
export function glassEdgeMaterial() {
  return new THREE.MeshStandardMaterial({
    color: '#1e4a3c',
    emissive: '#0a2119',
    emissiveIntensity: 1,
    metalness: 0,
    roughness: 0.1,
    transparent: true,
    opacity: 0.85,
    envMapIntensity: 1.2,
  });
}

/** Brušeni metal (tamna bronca / crni mesing) s anizotropijom. */
export function brushedMetalMaterial(brushTex, { color = '#3a2c1f', roughness = 0.34, anisotropy = 0.8, repeat = [2, 1] } = {}) {
  const t = brushTex.clone();
  t.repeat.set(repeat[0], repeat[1]);
  t.needsUpdate = true;
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness: 1,
    roughness,
    roughnessMap: t,
    bumpMap: t,
    bumpScale: 0.0006,
    anisotropy,
    anisotropyRotation: 0,
    envMapIntensity: 1.1,
  });
}

let stoneNoiseTex = null;
/** Tileable šum za kamen (pečen jednom): R = mrlje, G = zrno, B = svjetlija zrnca, A = žilice. */
export function stoneNoiseTexture(size = 512) {
  if (stoneNoiseTex) return stoneNoiseTex;
  const data = new Uint8Array(size * size * 4);
  const hash = (x, y, s) => {
    let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const vnoise = (x, y, period, seed) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const w = (i, j) => hash(((i % period) + period) % period, ((j % period) + period) % period, seed);
    const a = w(x0, y0), b = w(x0 + 1, y0), c = w(x0, y0 + 1), d = w(x0 + 1, y0 + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  const fbm = (u, v, base, seed, oct = 5) => {
    let s = 0, amp = 0.5, p = base;
    for (let o = 0; o < oct; o++) {
      s += amp * vnoise(u * p, v * p, p, seed + o * 7);
      p *= 2;
      amp *= 0.5;
    }
    return s;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const mottle = fbm(u, v, 4, 1);
      const grain = vnoise(u * 256, v * 256, 256, 9);
      const speck = vnoise(u * 128, v * 128, 128, 21);
      const veinN = fbm(u, v, 2, 33, 6);
      const vein = 1 - Math.min(1, Math.abs(veinN - 0.5) / 0.018);
      const i = (y * size + x) * 4;
      data[i] = Math.round(mottle * 255);
      data[i + 1] = Math.round(grain * 255);
      data[i + 2] = Math.round(Math.max(0, (speck - 0.78) / 0.22) * 255);
      data[i + 3] = Math.round(Math.max(0, vein) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  stoneNoiseTex = tex;
  return tex;
}

/**
 * Kamen: tamni granit/bazalt. polished = pod (sjajan), inače brušeni monolit.
 * Varijacije boje/hrapavosti iz pečene teksture šuma, projicirane po dominantnoj osi.
 */
export function stoneMaterial({ polished = false, tiles = 0, color = '#0f0f11', scale = 60 } = {}) {
  const m = new THREE.MeshStandardMaterial({
    color,
    metalness: 0,
    roughness: polished ? 0.16 : 0.62,
    envMapIntensity: polished ? 1 : 0.6,
  });
  return extendMaterial(m, {
    key: `stone${polished ? 'P' : 'H'}${tiles}`,
    uniforms: { tileSize: { value: tiles }, stoneNoise: { value: stoneNoiseTexture() }, stoneScale: { value: 1 / scale } },
    fragmentPars: /* glsl */ `
      uniform float tileSize;
      uniform sampler2D stoneNoise;
      uniform float stoneScale;
      vec4 stoneSample;
      float stoneGrout;
    `,
    hooks: {
      color_fragment: /* glsl */ `
        {
          vec3 an = abs( vObjNormal );
          vec2 sp = an.y > max( an.x, an.z ) ? vWorldPos.xz : ( an.x > an.z ? vWorldPos.zy : vWorldPos.xy );
          stoneSample = texture2D( stoneNoise, sp * stoneScale );
          vec4 fine = texture2D( stoneNoise, sp * stoneScale * 7.3 + 0.37 );
          vec3 c = diffuseColor.rgb * ( 0.72 + 0.6 * stoneSample.r ) * ( 0.85 + 0.3 * fine.g );
          c += vec3( 0.03, 0.029, 0.027 ) * fine.b;
          c = mix( c, c * 2.2 + 0.012, stoneSample.a * 0.35 );
          stoneGrout = 0.0;
          if ( tileSize > 0.0 ) {
            vec2 tp = abs( fract( vWorldPos.xz / tileSize ) - 0.5 );
            float edge = 0.5 - max( tp.x, tp.y );
            stoneGrout = 1.0 - smoothstep( 0.0012, 0.003, edge );
            c *= 1.0 - stoneGrout * 0.6;
          }
          diffuseColor.rgb = c;
        }
      `,
      roughnessmap_fragment: /* glsl */ `
        roughnessFactor = clamp( roughnessFactor * ( 0.7 + 0.6 * stoneSample.g ) + stoneGrout * 0.4 + ( stoneSample.r - 0.5 ) * ${polished ? '0.16' : '0.2'}, 0.04, 1.0 );
      `,
      normal_fragment_maps: /* glsl */ `
        normal = bumpFromHeight( -vViewPosition, normal, stoneSample.g - stoneGrout * 3.0, ${polished ? '0.004' : '0.01'} );
      `,
    },
  });
}

/** Zid od tamnog mikrocementa (Poly Haven grey_plaster, zatamnjen i blago hladan). */
export function microcementMaterial(textures, repeat = 3) {
  const { diff, rough, nor } = textures;
  for (const t of [diff, rough, nor]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = 8;
  }
  diff.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.MeshStandardMaterial({
    color: '#1a1c20',
    map: diff,
    roughnessMap: rough,
    normalMap: nor,
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 0.95,
    metalness: 0,
    envMapIntensity: 0.3,
  });
  // Mikrocement je neutralno siv: odbaci smeđkasti ton originalne žbuke.
  return extendMaterial(m, {
    key: 'microcement',
    hooks: {
      map_fragment: `
        diffuseColor.rgb = vec3( dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) ) * vec3( 0.96, 0.99, 1.04 );
      `,
    },
  });
}
