// ============================================================
//  terrain.js — «ЗЕМЛЯ»
//  Реальный рельеф Copernicus DEM: город (сетка 25 м) и окрестности
//  с горами (200 м). Даёт всем модулям функцию elev(x, z) —
//  «на какой высоте здесь земля» (в метрах относительно пл. Ала-Тоо).
//  Две подложки: «Схема» (макет) и «Спутник» (Sentinel-2 2016).
// ============================================================
import * as THREE from 'three';

let T = null;          // данные terrain.json
export function setTerrain(t) { T = t; }

// Высота в узле сетки
const hAt = (g, i, j) => g.h[Math.min(g.nz - 1, Math.max(0, j)) * g.nx + Math.min(g.nx - 1, Math.max(0, i))] * 0.1;
// Высота внутри сетки — по тем же треугольникам, что и у 3D-поверхности
function gridElev(g, x, z) {
  const fx = (x - g.x0) / g.step, fz = (z - g.z0) / g.step;
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const a = hAt(g, i, j), b = hAt(g, i + 1, j), c = hAt(g, i, j + 1), d = hAt(g, i + 1, j + 1);
  return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
}
const inside = (g, x, z) => x >= g.x0 && z >= g.z0 && x <= g.x0 + (g.nx - 1) * g.step && z <= g.z0 + (g.nz - 1) * g.step;
export function elev(x, z) {
  if (!T) return 0;
  if (inside(T.fine, x, z)) return gridElev(T.fine, x, z);
  if (inside(T.region, x, z)) return gridElev(T.region, x, z);
  return gridElev(T.region, Math.max(T.region.x0, Math.min(x, T.region.x0 + (T.region.nx - 1) * T.region.step)), Math.max(T.region.z0, Math.min(z, T.region.z0 + (T.region.nz - 1) * T.region.step)));
}

// перевод локальных метров → координаты картинки спутника (Web Mercator)
const LAT0 = 42.8762, LON0 = 74.6038, MLAT = 111130, MLON = 111320 * Math.cos(LAT0 * Math.PI / 180);
export const toLatLon = (x, z) => ({ lat: LAT0 - z / MLAT, lon: LON0 + x / MLON });
function uvOf(sat, x, z) {
  const { lat, lon } = toLatLon(x, z), n = 2 ** sat.z, r = lat * Math.PI / 180;
  const mx = (lon + 180) / 360 * n, my = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
  return [(mx - sat.mx0) / (sat.mx1 - sat.mx0), 1 - (my - sat.my0) / (sat.my1 - sat.my0)];
}

// Сетка → 3D-поверхность
function gridMesh(g, sat, yOff, colorFn) {
  const N = g.nx * g.nz, P = new Float32Array(N * 3), UV = new Float32Array(N * 2), C = new Float32Array(N * 3), col = new THREE.Color();
  for (let j = 0; j < g.nz; j++) for (let i = 0; i < g.nx; i++) {
    const k = j * g.nx + i, x = g.x0 + i * g.step, z = g.z0 + j * g.step, h = g.h[k] * 0.1;
    P[k * 3] = x; P[k * 3 + 1] = h + yOff; P[k * 3 + 2] = z;
    const [u, v] = uvOf(sat, x, z); UV[k * 2] = u; UV[k * 2 + 1] = v;
    colorFn(h, col); C[k * 3] = col.r; C[k * 3 + 1] = col.g; C[k * 3 + 2] = col.b;
  }
  const idx = [];
  for (let j = 0; j < g.nz - 1; j++) for (let i = 0; i < g.nx - 1; i++) {
    const a = j * g.nx + i, b = a + 1, c = a + g.nx, d = c + 1;
    idx.push(a, c, b, b, c, d); // та же диагональ, что и в gridElev
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
  geo.setIndex(idx); geo.computeVertexNormals();
  return geo;
}

export function buildTerrain(scene) {
  const loader = new THREE.TextureLoader();
  const tex = (f) => { const t = loader.load('./data/' + f); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; };
  // цвета схемы по высоте: долина → предгорья → скалы → снег
  const cA = new THREE.Color(0xc9cfa8), cB = new THREE.Color(0x9fb27c), cC = new THREE.Color(0x9a8f80), cD = new THREE.Color(0x7d7a78), cS = new THREE.Color(0xfbfbff);
  const regionColor = (h, c) => {
    const a = h + T.base; // абсолютная высота, м
    if (a < 1100) c.copy(cA).lerp(cB, Math.max(0, (a - 800) / 300));
    else if (a < 2400) c.copy(cB).lerp(cC, (a - 1100) / 1300);
    else if (a < 3500) c.copy(cC).lerp(cD, (a - 2400) / 1100);
    else c.copy(cD).lerp(cS, Math.min(1, (a - 3500) / 250));
  };
  const cityGeo = gridMesh(T.fine, T.satCity, 0, (h, c) => c.set(0xe6dfcf));
  const regionGeo = gridMesh(T.region, T.satRegion, -1.2, regionColor);
  const mats = {
    citySchema: new THREE.MeshStandardMaterial({ color: 0xe6dfcf, roughness: 1 }),
    regionSchema: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }),
    citySat: new THREE.MeshStandardMaterial({ map: tex(T.satCity.file), roughness: 1 }),
    regionSat: new THREE.MeshStandardMaterial({ map: tex(T.satRegion.file), roughness: 1 }),
  };
  const city = new THREE.Mesh(cityGeo, mats.citySchema); city.receiveShadow = true; city.name = 'ground';
  const region = new THREE.Mesh(regionGeo, mats.regionSchema); region.receiveShadow = true; region.name = 'ground';
  scene.add(city, region);
  return {
    city, region,
    setMode(m) { city.material = m === 'sat' ? mats.citySat : mats.citySchema; region.material = m === 'sat' ? mats.regionSat : mats.regionSchema; },
  };
}
