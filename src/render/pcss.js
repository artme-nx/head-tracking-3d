// PCSS (percentage-closer soft shadows) za spot svjetla.
// Ubacuje se u BasicShadowMap granu three.js shadera: Basic shadow mapa je
// obična depth tekstura (bez hardverske usporedbe), pa iz nje možemo čitati
// dubinu blokera. Rezultat su meke sjene koje su oštre uz dodir s podlogom i
// sve mekše što je bloker dalje od plohe (contact hardening).
//
// Scene 1 i 2 koriste PCFShadowMap i ova zakrpa ih ne dira.
// Konvencija za PCSS spotove: shadow.camera.near = PCSS_NEAR, far = PCSS_FAR,
// shadow.radius = veličina izvora svjetla izražena u UV jedinicama na near ravnini
// (vidi pcssLightSize()).

import * as THREE from 'three';

export const PCSS_NEAR = 10;
export const PCSS_FAR = 700;

const PCSS_GLSL = /* glsl */ `
#ifdef USE_SHADOWMAP
#if NUM_SPOT_LIGHT_SHADOWS > 0
#if defined( SHADOWMAP_TYPE_BASIC )

	#define PCSS_NEAR ${PCSS_NEAR.toFixed(1)}
	#define PCSS_FAR ${PCSS_FAR.toFixed(1)}
	#define PCSS_BLOCKER_SAMPLES 12
	#define PCSS_FILTER_SAMPLES 18

	float pcssLinearDepth( float d ) {
		return ( PCSS_NEAR * PCSS_FAR ) / ( PCSS_FAR - d * ( PCSS_FAR - PCSS_NEAR ) );
	}

	float pcssNoise( vec2 p ) {
		return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
	}

	vec2 pcssVogel( int i, int n, float phi ) {
		float r = sqrt( ( float( i ) + 0.5 ) / float( n ) );
		float theta = float( i ) * 2.399963229728653 + phi;
		return vec2( cos( theta ), sin( theta ) ) * r;
	}

	float getSpotShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {

		// Isključena sjena (npr. svjetiljka na prstu dok ne gori): bez ikakvog uzorkovanja.
		if ( shadowIntensity <= 0.0 ) return 1.0;
		shadowCoord.xyz /= shadowCoord.w;
		shadowCoord.z += shadowBias;

		bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
		if ( ! inFrustum || shadowCoord.z > 1.0 ) return 1.0;

		float zR = shadowCoord.z;
		// radius = 0 → tvrda sjena s jednim uzorkom (npr. rim svjetla čija je sjena
		// potrebna samo volumetriji, a na površinama se jedva vidi).
		if ( shadowRadius == 0.0 ) return mix( 1.0, step( zR, texture2D( shadowMap, shadowCoord.xy ).r ), shadowIntensity );
		// radius < 0 → meka sjena fiksne širine (|radius| teksela) za svjetla s vlastitim
		// near/far (svjetiljka na prstu je preblizu za zajednički PCSS near).
		if ( shadowRadius < 0.0 ) {
			float r = -shadowRadius / shadowMapSize.x;
			float ph = pcssNoise( gl_FragCoord.xy ) * 6.28318530718;
			float lit = 0.0;
			for ( int i = 0; i < PCSS_FILTER_SAMPLES; i ++ ) {
				lit += step( zR, texture2D( shadowMap, shadowCoord.xy + pcssVogel( i, PCSS_FILTER_SAMPLES, ph ) * r ).r );
			}
			return mix( 1.0, lit / float( PCSS_FILTER_SAMPLES ), shadowIntensity );
		}
		float zRLin = pcssLinearDepth( zR );
		float lightUV = shadowRadius;
		float phi = pcssNoise( gl_FragCoord.xy ) * 6.28318530718;
		float texel = 1.0 / shadowMapSize.x;

		// 1) Potraga za blokerima unutar konusa prema površini izvora svjetla.
		float searchR = clamp( lightUV * ( zRLin - PCSS_NEAR ) / zRLin, 2.0 * texel, 0.06 );
		float blockerSum = 0.0;
		float blockers = 0.0;
		for ( int i = 0; i < PCSS_BLOCKER_SAMPLES; i ++ ) {
			float d = texture2D( shadowMap, shadowCoord.xy + pcssVogel( i, PCSS_BLOCKER_SAMPLES, phi ) * searchR ).r;
			if ( d < zR ) {
				blockerSum += pcssLinearDepth( d );
				blockers += 1.0;
			}
		}
		if ( blockers < 0.5 ) return 1.0;

		// 2) Širina polusjene iz sličnih trokuta (izvor — bloker — prijemnik).
		float zB = blockerSum / blockers;
		float penumbra = lightUV * PCSS_NEAR * ( zRLin - zB ) / ( zB * zRLin );
		float filterR = clamp( penumbra, 1.25 * texel, 0.05 );

		// 3) PCF s promjenjivim radijusom.
		float lit = 0.0;
		for ( int i = 0; i < PCSS_FILTER_SAMPLES; i ++ ) {
			vec2 o = pcssVogel( i, PCSS_FILTER_SAMPLES, phi + 1.618 ) * filterR;
			lit += step( zR, texture2D( shadowMap, shadowCoord.xy + o ).r );
		}
		lit /= float( PCSS_FILTER_SAMPLES );

		return mix( 1.0, lit, shadowIntensity );

	}

#else

	#define getSpotShadow getShadow

#endif
#endif
#endif
`;

let installed = false;

export function installPCSS() {
  if (installed) return;
  installed = true;

  const chunks = THREE.ShaderChunk;
  chunks.shadowmap_pars_fragment += PCSS_GLSL;

  const swap = (name) => {
    const before = chunks[name];
    chunks[name] = before.replaceAll('getShadow( spotShadowMap[ i ]', 'getSpotShadow( spotShadowMap[ i ]');
    if (chunks[name] === before) console.warn(`PCSS: chunk ${name} nije zakrpan`);
  };
  swap('lights_fragment_begin');
  swap('shadowmask_pars_fragment');
}

/**
 * Postavi spot svjetlo za PCSS.
 * @param {THREE.SpotLight} light
 * @param {number} sourceSize fizička veličina izvora svjetla u cm (veće = mekše sjene)
 */
export function configurePCSSSpot(light, sourceSize, mapSize = 2048) {
  light.castShadow = true;
  light.distance = 0;
  const shadow = light.shadow;
  shadow.mapSize.set(mapSize, mapSize);
  shadow.camera.near = PCSS_NEAR;
  shadow.camera.far = PCSS_FAR;
  shadow.focus = 1;
  shadow.bias = -0.00008;
  shadow.normalBias = 0.02;
  shadow.radius = pcssLightSize(light, sourceSize);
  shadow.camera.updateProjectionMatrix();
}

export function pcssLightSize(light, sourceSize) {
  // Veličina izvora u odnosu na širinu frustuma sjene na near ravnini.
  const halfWidth = PCSS_NEAR * Math.tan(light.angle * light.shadow.focus);
  return sourceSize / (2 * halfWidth);
}
