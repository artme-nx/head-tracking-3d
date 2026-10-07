// Učitavanje modela: zadana glava, ispušteni .glb/.gltf i Gaussian splatovi.
// Spark (splat renderer) se učitava lijeno, tek kad zatreba.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { wrapContent } from './modelScene.js';

const SPLAT_EXT = ['ply', 'splat', 'spz', 'ksplat'];
const MESH_EXT = ['glb', 'gltf'];

const ext = (name) => name.split('.').pop().toLowerCase();

export function classifyFiles(files) {
  const list = [...files];
  const main =
    list.find((f) => MESH_EXT.includes(ext(f.name))) ?? list.find((f) => SPLAT_EXT.includes(ext(f.name)));
  if (!main) return null;
  return { main, kind: MESH_EXT.includes(ext(main.name)) ? 'mesh' : 'splat', all: list };
}

/** Zadani preset: glava Lee Perry-Smith (CC BY 3.0, Infinite Realities) u "glina" materijalu. */
export async function loadDefaultHead() {
  const gltf = await new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/LeePerrySmith.glb`);
  const clay = new THREE.MeshPhysicalMaterial({
    color: '#a89f95',
    roughness: 0.55,
    metalness: 0,
    clearcoat: 0.15,
    clearcoatRoughness: 0.6,
    sheen: 0.3,
    sheenColor: new THREE.Color('#ffe8d6'),
  });
  gltf.scene.traverse((o) => {
    if (o.isMesh) o.material = clay;
  });
  return wrapContent(gltf.scene);
}

/** .glb ili .gltf (uz pripadne .bin/teksture ako su ispuštene zajedno). */
export async function loadMeshFiles(main, all) {
  const urls = new Map(all.map((f) => [f.name, URL.createObjectURL(f)]));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    const name = decodeURIComponent(url.split('/').pop().split('?')[0]);
    return urls.get(name) ?? url;
  });
  try {
    const gltf = await new GLTFLoader(manager).loadAsync(urls.get(main.name));
    return wrapContent(gltf.scene);
  } finally {
    // Teksture su već dekodirane; blob URL-ovi više nisu potrebni.
    setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 5000);
  }
}

let spark = null;

/** Gaussian splat preko Spark-a (@sparkjsdev/spark). */
export async function loadSplatFile(file, renderer, scene) {
  if (!spark) {
    spark = await import('@sparkjsdev/spark');
  }
  if (!scene.userData.sparkRenderer) {
    const sr = new spark.SparkRenderer({ renderer });
    scene.add(sr);
    scene.userData.sparkRenderer = sr;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mesh = new spark.SplatMesh({ fileBytes: bytes, fileName: file.name });
  await mesh.initialized;
  // Većina snimki (3DGS/COLMAP) ima Y prema dolje — okreni za 180° oko X.
  mesh.quaternion.set(1, 0, 0, 0);
  mesh.updateMatrix();
  const bounds = mesh.getBoundingBox(true).applyMatrix4(mesh.matrix);
  return wrapContent(mesh, bounds);
}
