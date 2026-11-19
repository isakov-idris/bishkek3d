// ============================================================
//  city.js — «СТРОИТЕЛЬ ГОРОДА» (версия 2: реальные данные)
//  Берёт data/city.json (OpenStreetMap) и строит 3D:
//  земля → зелень/вода/площади → дороги → здания (выдавливаем
//  реальные контуры на их высоту) → деревья → фонари → горы →
//  скульптурные модели (Манас, флаг, колесо, арки Победы).
// ============================================================
import * as THREE from 'three';
import { toXZ, LANDMARKS } from './data.js';
import { elev } from './terrain.js';
import { buildTrees } from './life.js';

// ---------- Материал «живой фасад» ----------
// Видеокарта рисует на стене фасад нужного стиля (стили — см. styleOf ниже):
// окна со стеклом, отражающим небо, рамы, швы панелей, балконы, кирпичную кладку,
// витражи, карнизы. Ночью часть окон загорается. Это СТИЛИЗАЦИЯ по типу здания.
export const shared = { uNight: { value: 0 }, uTime: { value: 0 } };

export function buildingMaterial(color = 0xffffff, windows = true, opts = {}) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.0, ...opts });
  if (!windows) return m;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = shared.uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aStyle; attribute float aSeed; attribute float aBase; attribute float aTop;
        varying vec3 vWPos; varying vec3 vWNrm; varying float vStyle; varying float vSeed; varying float vBase; varying float vTop;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 wp = vec4(transformed, 1.0); vec3 wn = objectNormal;
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp; wn = mat3(instanceMatrix) * wn;
        #endif
        wp = modelMatrix * wp; vWPos = wp.xyz; vWNrm = normalize(mat3(modelMatrix) * wn);
        vStyle = aStyle; vSeed = aSeed; vBase = aBase; vTop = aTop;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos; varying vec3 vWNrm; varying float vStyle; varying float vSeed; varying float vBase; varying float vTop;
        uniform float uNight; float gWin; float gRnd; float gGlassMetal; float gMetalRoof;
        float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          gWin = 0.0; gMetalRoof = 0.0; gGlassMetal = 0.55; gRnd = 0.0;
          float st = vStyle; vec3 col = diffuseColor.rgb;
          float hgt = vWPos.y - vBase;
          float far = smoothstep(0.03, 0.18, fwidth(hgt)); // далеко — мелкие детали гасим (без ряби)
          if (st > 9.5) {
            // крыши: 10 — плоская (рубероид/гравий), 11 — скатная металлическая
            if (st < 10.5) { col *= 0.93 + 0.07 * h21(floor(vWPos.xz * 1.5)); }
            else { vec2 t = normalize(vec2(-vWNrm.z, vWNrm.x) + 1e-5); float s = fract(dot(vWPos.xz, t) / 0.45); col *= mix(1.0, 0.82, step(0.86, s) * (1.0 - far)); gMetalRoof = 1.0; }
          } else {
            vec2 t2 = normalize(vec2(-vWNrm.z, vWNrm.x) + 1e-5);
            float along = dot(vWPos.xz, t2) + vSeed * 7.0;
            float fh = 3.0, sp = 3.2, ww = 0.45, wh = 0.5, sill = 0.32;
            if (st < 0.5) { sp = 3.0; ww = 0.44; wh = 0.47; }
            else if (st < 1.5) { sp = 2.7; ww = 0.40; wh = 0.46; }
            else if (st < 2.5) { sp = 1.6; ww = 0.90; wh = 0.80; sill = 0.10; gGlassMetal = 0.9; }
            else if (st < 3.5) { fh = 3.7; sp = 3.4; ww = 0.40; wh = 0.56; sill = 0.24; }
            else if (st < 4.5) { sp = 3.6; ww = 0.34; wh = 0.42; sill = 0.34; }
            else { fh = 4.8; sp = 6.0; ww = 0.62; wh = 0.20; sill = 0.62; }
            float fy = fract(hgt / fh), fx = fract(along / sp), hw = ww * 0.5;
            float cellX = floor(along / sp), cellY = floor(hgt / fh);
            float topZone = step(vTop - vBase - 0.6, hgt); // парапет/карниз — без окон
            float inW = step(0.5 - hw, fx) * step(fx, 0.5 + hw) * step(sill, fy) * step(fy, sill + wh) * step(1.0, hgt) * (1.0 - topZone);
            float ins = 0.05 / sp, insY = 0.05 / fh;
            float glass = inW * step(0.5 - hw + ins, fx) * step(fx, 0.5 + hw - ins) * step(sill + insY, fy) * step(fy, sill + wh - insY);
            float frame = inW - glass;
            // швы панелей
            if (st < 0.5) {
              float dx = min(fx, 1.0 - fx) * sp, dy = min(fy, 1.0 - fy) * fh;
              float seam = (1.0 - smoothstep(0.02, 0.07, dx)) + (1.0 - smoothstep(0.02, 0.07, dy));
              col *= 1.0 - 0.10 * clamp(seam, 0.0, 1.0) * (1.0 - far);
              // балконы: в части колонок под окном — плита и ограждение
              float bal = step(0.55, h21(vec2(cellX, vSeed * 13.0))) * step(1.5, cellY);
              float slab = bal * step(0.5 - hw - 0.12, fx) * step(fx, 0.5 + hw + 0.12) * step(0.02, fy) * step(fy, sill - 0.02);
              vec3 balC = mix(vec3(0.62, 0.60, 0.57), vec3(0.75, 0.80, 0.84), step(0.5, h21(vec2(cellX, cellY))));
              col = mix(col, balC, slab * 0.85);
            }
            // кирпичная кладка
            if (st > 0.5 && st < 1.5) {
              float by = hgt / 0.077; float row = floor(by);
              float bx = along / 0.25 + 0.5 * mod(row, 2.0);
              float mortar = max(step(0.82, fract(by)), step(0.93, fract(bx)));
              col *= mix(1.0, (0.9 + 0.2 * h21(vec2(floor(bx), row))) * mix(1.0, 1.25, mortar), 1.0 - far);
            }
            // витраж: межэтажные полосы и стойки
            if (st > 1.5 && st < 2.5) { col = mix(col, col * 0.85, step(fy, 0.08)); }
            // классика: карниз и цоколь
            if (st > 2.5 && st < 3.5) { col *= mix(1.0, 1.08, topZone); col *= mix(0.86, 1.0, step(1.0, hgt)); }
            // мягкая тень у земли (как в реальности)
            col *= mix(0.68, 1.0, smoothstep(0.0, 5.0, hgt));
            // рамы и стекло
            vec3 frameC = (st > 1.5 && st < 2.5) ? vec3(0.22, 0.25, 0.28) : (st > 5.5 ? col * 0.7 : vec3(0.93, 0.93, 0.91));
            col = mix(col, frameC, frame);
            vec3 glassC = (st > 1.5 && st < 2.5) ? vec3(0.10, 0.17, 0.21) : vec3(0.07, 0.09, 0.11);
            col = mix(col, glassC, glass);
            gWin = glass;
            gRnd = h21(vec2(cellX, cellY) + vSeed * 31.0);
          }
          diffuseColor.rgb = col;
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.06, gWin); roughnessFactor = mix(roughnessFactor, 0.42, gMetalRoof);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, gGlassMetal, gWin); metalnessFactor = max(metalnessFactor, gMetalRoof * 0.35);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += gWin * uNight * step(0.45, gRnd) * mix(vec3(1.0, 0.68, 0.36), vec3(0.80, 0.88, 1.0), step(0.82, gRnd)) * 1.6;`);
  };
  m.customProgramCacheKey = () => 'facade-v2';
  return m;
}

// ---------- Помощник «плоские слои» (зелень, вода, дороги) ----------
class Flat {
  constructor(y) { this.y = y; this.p = []; this.r = []; }
  // ra/rb/rc — [поперёк (м), вдоль (м), полуширина] для разметки дорог
  tri(ax, az, bx, bz, cx, cz, ra = Flat.NO, rb = Flat.NO, rc = Flat.NO) {
    // следим, чтобы треугольник смотрел вверх; высоту берём с рельефа
    if ((bz - az) * (cx - ax) - (bx - ax) * (cz - az) < 0) { const tx = bx, tz = bz; bx = cx; bz = cz; cx = tx; cz = tz; const tr = rb; rb = rc; rc = tr; }
    const y = this.y; this.p.push(ax, y + elev(ax, az), az, bx, y + elev(bx, bz), bz, cx, y + elev(cx, cz), cz);
    this.r.push(...ra, ...rb, ...rc);
  }
  // большой треугольник дробим, чтобы он лёг на склон, а не «висел»
  triFine(ax, az, bx, bz, cx, cz, depth = 0) {
    const ab = Math.hypot(bx - ax, bz - az), bc = Math.hypot(cx - bx, cz - bz), ca = Math.hypot(ax - cx, az - cz), m = Math.max(ab, bc, ca);
    if (m < 22 || depth > 7) return this.tri(ax, az, bx, bz, cx, cz);
    if (m === ab) { const mx = (ax + bx) / 2, mz = (az + bz) / 2; this.triFine(ax, az, mx, mz, cx, cz, depth + 1); this.triFine(mx, mz, bx, bz, cx, cz, depth + 1); }
    else if (m === bc) { const mx = (bx + cx) / 2, mz = (bz + cz) / 2; this.triFine(ax, az, bx, bz, mx, mz, depth + 1); this.triFine(ax, az, mx, mz, cx, cz, depth + 1); }
    else { const mx = (cx + ax) / 2, mz = (cz + az) / 2; this.triFine(ax, az, bx, bz, mx, mz, depth + 1); this.triFine(mx, mz, bx, bz, cx, cz, depth + 1); }
  }
  polygon(pts) { // pts: [[x,z],...]
    if (pts.length < 3) return;
    const v = pts.map(p => new THREE.Vector2(p[0], p[1]));
    for (const f of THREE.ShapeUtils.triangulateShape(v, [])) this.triFine(pts[f[0]][0], pts[f[0]][1], pts[f[1]][0], pts[f[1]][1], pts[f[2]][0], pts[f[2]][1]);
  }
  ribbon(pts0, w, joints = true) { // линия заданной ширины (длинные куски дробим по 20 м)
    const h = w / 2, pts = [];
    for (let i = 0; i < pts0.length; i++) {
      if (i > 0) { const [x1, z1] = pts0[i - 1], [x2, z2] = pts0[i]; const n = Math.floor(Math.hypot(x2 - x1, z2 - z1) / 20); for (let k = 1; k <= n; k++) pts.push([x1 + (x2 - x1) * k / (n + 1), z1 + (z2 - z1) * k / (n + 1)]); }
      pts.push(pts0[i]);
    }
    let along = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, z1] = pts[i], [x2, z2] = pts[i + 1];
      const L = Math.hypot(x2 - x1, z2 - z1); if (L < 0.01) continue;
      const nx = -(z2 - z1) / L * h, nz = (x2 - x1) / L * h, a2 = along + L;
      this.tri(x1 + nx, z1 + nz, x2 + nx, z2 + nz, x2 - nx, z2 - nz, [h, along, h], [h, a2, h], [-h, a2, h]);
      this.tri(x1 + nx, z1 + nz, x2 - nx, z2 - nz, x1 - nx, z1 - nz, [h, along, h], [-h, a2, h], [-h, along, h]);
      along = a2;
    }
    if (joints && w > 3) for (let i = 1; i < pts0.length - 1; i++) this.disc(pts0[i][0], pts0[i][1], h);
  }
  disc(x, z, r, seg = 8) {
    for (let k = 0; k < seg; k++) {
      const a1 = k / seg * Math.PI * 2, a2 = (k + 1) / seg * Math.PI * 2;
      this.tri(x, z, x + Math.cos(a1) * r, z + Math.sin(a1) * r, x + Math.cos(a2) * r, z + Math.sin(a2) * r);
    }
  }
  mesh(color, opts = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('aRoad', new THREE.Float32BufferAttribute(this.r, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.95, ...opts }));
    m.receiveShadow = true;
    return m;
  }
}
Flat.NO = [99, 0, 0];

// Материал асфальта: фактура + разметка (центр — прерывистая, края — сплошные)
function roadMaterial(color, cls) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aRoad; varying vec3 vRoad; varying vec3 vWP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRoad = aRoad; vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vRoad; varying vec3 vWP;\nfloat h21r(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float lat = vRoad.x, hw = vRoad.z, al = vRoad.y;
          float far = smoothstep(0.05, 0.3, fwidth(al));
          diffuseColor.rgb *= 0.92 + 0.08 * h21r(floor(vWP.xz * 2.5));
          if (lat < 50.0 && ${cls <= 3 ? 'true' : 'false'}) {
            float paint = 0.0;
            paint += (1.0 - step(0.09, abs(lat))) * step(fract(al / 9.0), 0.55);           // ось
            paint += step(hw - 0.55, abs(lat)) * (1.0 - step(hw - 0.38, abs(lat)));       // края
            ${cls <= 1 ? 'paint += (1.0 - step(0.07, abs(abs(lat) - hw * 0.5))) * step(fract(al / 7.0), 0.4);' : ''} // полосы
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.86, 0.82), clamp(paint, 0.0, 1.0) * (1.0 - far) * 0.9);
          }
        }`);
  };
  m.customProgramCacheKey = () => 'road-' + cls;
  return m;
}

// ---------- Разбор записи здания из city.json ----------
function parseBuilding(r) {
  const s = 0.1;
  const h = r[0] * s, mh = r[1] * s, code = r[2] % 100, known = r[2] >= 100, name = r[3];
  let k = 4; const rings = [];
  while (k < r.length) {
    const n = r[k++]; const ring = [];
    for (let i = 0; i < n; i++) { ring.push([r[k] * s, r[k + 1] * s]); k += 2; }
    rings.push(ring);
  }
  return { h, mh, code, known, name, outer: rings[0], holes: rings.slice(1) };
}

// ---------- Стиль фасада по данным OSM ----------
// 0 панелька · 1 кирпич · 2 стекло · 3 классика/общественное · 4 частный дом · 6 промзона
const PAL = {
  0: [0xe8e3d9, 0xdcd7ce, 0xe9dccb, 0xd8d3cb, 0xefe8dd, 0xe3d6c4],
  1: [0xa4553b, 0xb66a4b, 0xc6a26e, 0x8f4b36, 0xb98b5c],
  2: [0xc9d1d8, 0xb8c2cb, 0xe2e5e8],
  3: [0xf0e3c8, 0xeedcbe, 0xf2ebdf, 0xe8d8c2, 0xefd5bd],
  4: [0xf3eee4, 0xeee0c4, 0xf0dacb, 0xe6e1d0, 0xf4e6c3, 0xdfe7e6],
  6: [0xc8c8c2, 0xb6b9b8, 0xd2cec4],
};
const ROOF_PITCH = [0x9a3b2e, 0x4e6d48, 0x3e5c78, 0x868b90, 0x6a4938, 0xa8483a];
const signedArea = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length]; a += x1 * z2 - x2 * z1; } return a / 2; };
function styleOf(b, seed) {
  const area = Math.abs(signedArea(b.outer)), H = b.h - b.mh;
  if (b.code === 5) return 6;
  if (b.code === 1 || b.code === 2 || ((b.code === 0) && area < 230 && H <= 7.5)) return 4;
  if (b.code === 6 || b.code === 7 || b.landmarkStyle) return 3;
  if (H >= 42 || (b.code === 4 && H >= 18 && seed < 0.7)) return 2;
  if (b.code === 4) return seed < 0.5 ? 3 : 2;
  if (H >= 11) return seed < 0.22 ? 1 : 0;
  return seed < 0.45 ? 1 : 3;
}
// Минимальный описанный прямоугольник — для скатной крыши
function obb(pts) {
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length]; const a = Math.atan2(z2 - z1, x2 - x1);
    const c = Math.cos(a), s = Math.sin(a); let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of pts) { const u = x * c + z * s, v = -x * s + z * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const A = (u1 - u0) * (v1 - v0); if (!best || A < best.A) best = { A, a, c, s, u0, u1, v0, v1 };
  }
  return best;
}

// Строим общую геометрию: стены + крыши (+ скатные крыши частных домов)
function buildingsGeometry(list, colorFn) {
  const P = [], N = [], C = [], S = [], SD = [], BS = [], TP = [], triStart = [];
  const push = (ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz, col, st, seed, base, top) => {
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    if (fx * nx + fy * ny + fz * nz < 0) { let t = bx; bx = cx; cx = t; t = by; by = cy; cy = t; t = bz; bz = cz; cz = t; }
    P.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let i = 0; i < 3; i++) { N.push(nx, ny, nz); C.push(col.r, col.g, col.b); S.push(st); SD.push(seed); BS.push(base); TP.push(top); }
  };
  const pushFace = (A, B, Cc, col, st, seed, base, top) => { // нормаль считаем сами, «вверх»
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = Cc[0] - A[0], vy = Cc[1] - A[1], vz = Cc[2] - A[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    push(A[0], A[1], A[2], B[0], B[1], B[2], Cc[0], Cc[1], Cc[2], nx, ny, nz, col, st, seed, base, top);
  };
  const rnd = (i) => { const x = Math.sin(i * 91.3 + 17.1) * 43758.5453; return x - Math.floor(x); };
  list.forEach((b, bi) => {
    triStart.push(P.length / 9);
    if (b.base === undefined) b.base = Math.min(...b.outer.map(p => elev(p[0], p[1])));
    const seed = rnd(bi + 1), st = b.style ?? (b.style = styleOf(b, seed));
    const y0 = b.base + (b.mh > 0 ? b.mh : -2), y1 = b.base + b.h;
    const pal = PAL[st] || PAL[0];
    const wallC = colorFn ? colorFn(b, bi) : new THREE.Color(pal[Math.floor(rnd(bi + 7) * pal.length)]);
    const roofC = new THREE.Color(0x8f8c86).multiplyScalar(0.92 + rnd(bi + 3) * 0.16);
    const walls = (ring, isHole) => {
      const out = (signedArea(ring) > 0) !== isHole;
      for (let i = 0; i < ring.length; i++) {
        const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % ring.length];
        const dx = x2 - x1, dz = z2 - z1, L = Math.hypot(dx, dz); if (L < 0.05) continue;
        let nx = dz / L, nz = -dx / L; if (!out) { nx = -nx; nz = -nz; }
        push(x1, y0, z1, x2, y0, z2, x2, y1, z2, nx, 0, nz, wallC, st, seed, b.base, y1);
        push(x1, y0, z1, x2, y1, z2, x1, y1, z1, nx, 0, nz, wallC, st, seed, b.base, y1);
      }
    };
    walls(b.outer, false); b.holes.forEach(hl => walls(hl, true));
    const v2 = b.outer.map(p => new THREE.Vector2(p[0], p[1]));
    const hv = b.holes.map(hl => hl.map(p => new THREE.Vector2(p[0], p[1])));
    const all = b.outer.concat(...b.holes);
    for (const f of THREE.ShapeUtils.triangulateShape(v2, hv)) {
      const A = all[f[0]], B = all[f[1]], Cc = all[f[2]]; if (!A || !B || !Cc) continue;
      push(A[0], y1, A[1], B[0], y1, B[1], Cc[0], y1, Cc[1], 0, 1, 0, roofC, 10, seed, b.base, y1);
    }
    // скатная (вальмовая) крыша у частных домов
    if (st === 4 && b.outer.length <= 12 && !b.holes.length && !colorFn) {
      const o = obb(b.outer); let L = (o.u1 - o.u0) / 2 + 0.45, W = (o.v1 - o.v0) / 2 + 0.45;
      const cu = (o.u0 + o.u1) / 2, cv = (o.v0 + o.v1) / 2;
      const cx = cu * o.c - cv * o.s, cz = cu * o.s + cv * o.c;   // центр прямоугольника в метрах
      let ax = [o.c, o.s], av = [-o.s, o.c];
      if (W > L) { [L, W] = [W, L]; [ax, av] = [av, [-ax[0], -ax[1]]]; } // конёк — вдоль длинной стороны
      if (L > 1.5 && W > 1.5 && L < 25 && W < 25) {
        const P2 = (u, v, y) => [cx + u * ax[0] + v * av[0], y, cz + u * ax[1] + v * av[1]];
        const cu0 = 0, cv0 = 0;
        const ey = y1 - 0.1, ry = y1 + Math.min(W * 0.62, 3.2);
        const rc = new THREE.Color(ROOF_PITCH[Math.floor(rnd(bi + 11) * ROOF_PITCH.length)]);
        const c1 = P2(-L, -W, ey), c2 = P2(L, -W, ey), c3 = P2(L, W, ey), c4 = P2(-L, W, ey);
        const r1 = P2(-L + W, 0, ry), r2 = P2(L - W, 0, ry);
        pushFace(c1, c2, r2, rc, 11, seed, b.base, ry); pushFace(c1, r2, r1, rc, 11, seed, b.base, ry);
        pushFace(c3, c4, r1, rc, 11, seed, b.base, ry); pushFace(c3, r1, r2, rc, 11, seed, b.base, ry);
        pushFace(c2, c3, r2, rc, 11, seed, b.base, ry); pushFace(c4, c1, r1, rc, 11, seed, b.base, ry);
      }
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setAttribute('aStyle', new THREE.Float32BufferAttribute(S, 1));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(SD, 1));
  g.setAttribute('aBase', new THREE.Float32BufferAttribute(BS, 1));
  g.setAttribute('aTop', new THREE.Float32BufferAttribute(TP, 1));
  g.computeBoundingSphere();
  return { geometry: g, triStart };
}


// ============================================================
export function buildCity(scene, D) {
  const city = new THREE.Group();
  scene.add(city);
  const s = 0.1;
  const rnd = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

  // ---------- Здания: разбор ----------
  const buildings = [];
  for (let ri = 0; ri < D.buildings.length; ri++) {
    const r = D.buildings[ri];
    const b = parseBuilding(r); b.meta = D.bmeta ? D.bmeta[ri] : null;
    if (b.outer.length < 3) continue;
    const nm = b.name >= 0 ? D.names[b.name] : '';
    if (/Мемориал победы/i.test(nm)) continue; // на его месте стоит наша модель арок
    let cx = 0, cz = 0; for (const p of b.outer) { cx += p[0]; cz += p[1]; }
    b.cx = cx / b.outer.length; b.cz = cz / b.outer.length; b.nameText = nm;
    buildings.push(b);
  }
  // границы города по данным
  let X0 = Infinity, X1 = -Infinity, Z0 = Infinity, Z1 = -Infinity;
  for (const b of buildings) { X0 = Math.min(X0, b.cx); X1 = Math.max(X1, b.cx); Z0 = Math.min(Z0, b.cz); Z1 = Math.max(Z1, b.cz); }

  // ---------- 1. Земля ----------
  // (поверхность земли строит terrain.js по реальному рельефу)
  const land = new THREE.Mesh(new THREE.PlaneGeometry(200000, 200000), new THREE.MeshStandardMaterial({ color: 0xc9cfa8, roughness: 1 }));
  land.rotation.x = -Math.PI / 2; land.position.y = -160; city.add(land);

  // ---------- 2. Зелень, вода, площади ----------
  const AREA = { 1: [0x4f7f99, 0.16, { roughness: 0.08, metalness: 0.35 }], 2: [0xb7cf98, 0.10], 3: [0xc8d9ab, 0.06], 4: [0x9dbd82, 0.08], 5: [0x9ccb88, 0.12], 6: [0xf3eee5, 0.20], 7: [0xc4cdb3, 0.07] };
  const areaLayers = {};
  for (const a of D.areas) {
    const code = a[0], n = a[1]; if (!AREA[code]) continue;
    const pts = []; for (let i = 0; i < n; i++) pts.push([a[2 + 2 * i] * s, a[3 + 2 * i] * s]);
    (areaLayers[code] ||= new Flat(AREA[code][1])).polygon(pts);
  }
  // реки и каналы — лентами
  const water = areaLayers[1] || (areaLayers[1] = new Flat(AREA[1][1]));
  for (const w of D.waterways) {
    const width = w[0] * s, n = w[1]; const pts = []; for (let i = 0; i < n; i++) pts.push([w[2 + 2 * i] * s, w[3 + 2 * i] * s]);
    water.ribbon(pts, width);
  }
  const mats = {};
  const flatGroup = new THREE.Group(); city.add(flatGroup);
  for (const [code, L] of Object.entries(areaLayers)) { const m = L.mesh(AREA[code][0], AREA[code][2] || {}); m.userData.kind = 'area' + code; flatGroup.add(m); if (code === '1') mats.water = m.material; }

  // ---------- 3. Дороги ----------
  // класс: 1 магистраль … 4 жилая улица, 5 проезд, 6 пешеходная, 7 тротуар/дорожка
  const ROAD = { 1: [0x4f535b, 0.42], 2: [0x565a62, 0.40], 3: [0x5e626a, 0.38], 4: [0x6c7077, 0.36], 5: [0x8e9197, 0.32], 6: [0xebe5d8, 0.30], 7: [0xddd5c5, 0.26] };
  const roadLayers = {};
  for (const r of D.roads) {
    const cls = r[0], w = r[1] * s, n = r[2]; if (!ROAD[cls]) continue;
    const pts = []; for (let i = 0; i < n; i++) pts.push([r[3 + 2 * i] * s, r[4 + 2 * i] * s]);
    (roadLayers[cls] ||= new Flat(ROAD[cls][1])).ribbon(pts, w, cls <= 6);
  }
  for (const [cls, L] of Object.entries(roadLayers)) { const m = L.mesh(ROAD[cls][0]); if (+cls <= 5) m.material = roadMaterial(ROAD[cls][0], +cls); m.userData.kind = 'road' + cls; flatGroup.add(m); }

  // ---------- 4. Здания ----------
  // знаковые здания: классика (Белый дом, музей, опера, филармония…), ТРЦ — стекло
  for (const l of LANDMARKS) {
    if (l.model || l.open) continue;
    const c = toXZ(l.lat, l.lon), b = buildingNear(c.x, c.z, 70);
    if (b) b.style = (l.id === 'bpark' || l.id === 'tsum') ? 2 : 3;
  }
  mats.houses = buildingMaterial(0xffffff, true, { vertexColors: true });
  const { geometry, triStart } = buildingsGeometry(buildings, null);
  const housesMesh = new THREE.Mesh(geometry, mats.houses);
  housesMesh.castShadow = true; housesMesh.receiveShadow = true;
  city.add(housesMesh);

  // Найти здание по номеру треугольника (для нажатий)
  function buildingAtFace(face) {
    let lo = 0, hi = triStart.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (triStart[mid] <= face) lo = mid; else hi = mid - 1; }
    return buildings[lo];
  }
  // Подсветка выбранного здания: перекрашиваем его треугольники в красный
  buildings.forEach((b, i) => { b.idx = i; });
  const colAttr = geometry.attributes.color, colOrig = colAttr.array.slice();
  let hlB = null;
  function highlight(b) {
    const paint = (bb, on) => {
      const from = triStart[bb.idx] * 9, to = (bb.idx + 1 < triStart.length ? triStart[bb.idx + 1] : colAttr.count / 3) * 9;
      for (let k = from; k < to; k += 3) {
        if (on) { colAttr.array[k] = 0.95; colAttr.array[k + 1] = colOrig[k + 1] * 0.35; colAttr.array[k + 2] = colOrig[k + 2] * 0.38; }
        else { colAttr.array[k] = colOrig[k]; colAttr.array[k + 1] = colOrig[k + 1]; colAttr.array[k + 2] = colOrig[k + 2]; }
      }
      colAttr.addUpdateRange(from, to - from);
    };
    colAttr.clearUpdateRanges();
    if (hlB) paint(hlB, false);
    hlB = b || null;
    if (hlB) paint(hlB, true);
    colAttr.needsUpdate = true;
  }
  // Самое высокое здание рядом с точкой (для подписи и для карточки)
  function buildingNear(x, z, radius = 45) {
    let best = null, bd = Infinity;
    for (const b of buildings) { const d = Math.hypot(b.cx - x, b.cz - z); if (d < radius && d < bd) { bd = d; best = b; } }
    return best;
  }

  // ---------- 5. Деревья ----------
  // тополя и карагачи с ветром — см. life.js
  const trees = buildTrees(D, matchMedia('(pointer: coarse)').matches);
  const treesMesh = trees.group, nT = trees.count;
  city.add(treesMesh);

  // ---------- 6. Фонари (горят ночью) ----------
  const LP = D.lamps, lampPos = new Float32Array(LP.length / 2 * 3);
  for (let i = 0; i < LP.length / 2; i++) { lampPos[i * 3] = LP[2 * i] * s; lampPos[i * 3 + 1] = 8.5 + elev(LP[2 * i] * s, LP[2 * i + 1] * s); lampPos[i * 3 + 2] = LP[2 * i + 1] * s; }
  const lampGeo = new THREE.BufferGeometry(); lampGeo.setAttribute('position', new THREE.BufferAttribute(lampPos, 3));
  const glow = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,230,180,1)'); gr.addColorStop(0.25, 'rgba(255,190,110,0.55)'); gr.addColorStop(1, 'rgba(255,160,80,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
  const lampsPts = new THREE.Points(lampGeo, new THREE.PointsMaterial({ size: 9, map: glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  city.add(lampsPts);

  // ---------- 7. Горы Ала-Тоо — теперь настоящие, из DEM (terrain.js) ----------

  // ---------- 8. Скульптурные модели + точки подписей ----------
  const decor = new THREE.Group(); city.add(decor);
  const landmarkTops = {}, landmarkBuilding = {};
  for (const l of LANDMARKS) {
    const c = toXZ(l.lat, l.lon);
    let top = 8;
    if (l.model) {
      const g = buildModel(l.model); g.position.set(c.x, elev(c.x, c.z), c.z);
      g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData.landmark = l.id; } });
      decor.add(g); top = new THREE.Box3().setFromObject(g).max.y;
    } else if (!l.open) {
      const b = buildingNear(c.x, c.z, 70);
      if (b) { top = b.base + b.h; landmarkBuilding[l.id] = b; b.landmark = l.id; }
      else top = elev(c.x, c.z) + 8;
    } else top = elev(c.x, c.z) + 8;
    landmarkTops[l.id] = new THREE.Vector3(c.x, top + 6, c.z);
  }

  console.log(`[city] зданий: ${buildings.length}, деревьев: ${nT}, фонарей: ${LP.length / 2}, дорог: ${D.roads.length}`);
  return {
    city, housesMesh, decor, landmarkTops, landmarkBuilding, lampsPts, mats, flatGroup, treesMesh, buildings,
    buildingAtFace, highlight, buildingNear,
    stats: { houses: buildings.length, trees: nT }, bounds: { X0, X1, Z0, Z1 },
  };
}

// ============================================================
//  Горы: поверхность с «шумом», снизу зелень, выше камень, сверху снег
// ============================================================
function buildMountains(cityZ1) {
  const W = 70000, D = 16000, SX = 280, SZ = 70, Z0 = Math.max(4600, cityZ1 + 2500);
  const geo = new THREE.PlaneGeometry(W, D, SX, SZ);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position, col = [];
  const n = (x, z) => Math.sin(x * 0.00042 + Math.sin(z * 0.0003) * 2) * 0.5 + Math.sin(x * 0.0011 + z * 0.0007) * 0.3 + Math.sin(x * 0.0031 - z * 0.0021) * 0.15 + Math.sin(x * 0.007 + z * 0.005) * 0.06;
  const cA = new THREE.Color(0x9fb27c), cB = new THREE.Color(0x9a8f80), cC = new THREE.Color(0x7d7a78), cS = new THREE.Color(0xfbfbff), tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), zl = pos.getZ(i) + D / 2, z = zl + Z0;
    const rise = Math.min(1, Math.max(0, zl / (D * 0.38)));
    const ridge = Math.pow(rise, 1.6) * (1 - Math.max(0, (zl - D * 0.8) / (D * 0.2)) * 0.3);
    let h = ridge * (3300 + n(x, z) * 1500) + Math.max(0, n(x * 2.3, z * 2.1)) * 260 * rise;
    h = Math.max(0, h); pos.setY(i, h);
    const t = h / 3400;
    if (t < 0.12) tmp.copy(cA).lerp(cB, t / 0.12);
    else if (t < 0.55) tmp.copy(cB).lerp(cC, (t - 0.12) / 0.43);
    else tmp.copy(cC).lerp(cS, Math.min(1, (t - 0.55) / 0.06));
    col.push(tmp.r, tmp.g, tmp.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }));
  m.position.set(0, -1, Z0 + D / 2);
  return m;
}

// ============================================================
//  Скульптурные модели (упрощённые)
// ============================================================
const GOLD = 0xc9a24a, BRONZE = 0x8a6a3e, STONE = 0xeee8dc;
const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...o });
function box(g, w, h, d, x, y, z, mat) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y + h / 2, z); g.add(m); return m; }
function cyl(g, r1, r2, h, x, y, z, mat, seg = 16) { const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, seg), mat); m.position.set(x, y + h / 2, z); g.add(m); return m; }

function flagTexture() {
  const c = document.createElement('canvas'); c.width = 300; c.height = 180; const g = c.getContext('2d');
  g.fillStyle = '#e8112d'; g.fillRect(0, 0, 300, 180);
  g.translate(150, 90); g.fillStyle = '#ffef00';
  for (let i = 0; i < 40; i++) { g.rotate(Math.PI * 2 / 40); g.beginPath(); g.moveTo(-5, 30); g.lineTo(0, 58); g.lineTo(5, 30); g.fill(); }
  g.beginPath(); g.arc(0, 0, 34, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#e8112d'; g.lineWidth = 4; g.beginPath(); g.arc(0, 0, 21, 0, Math.PI * 2); g.stroke();
  for (const k of [-1, 1]) for (const off of [0, 8]) { const cx = k * (20 + off); g.beginPath(); if (k > 0) g.arc(cx, 0, 20 + off, Math.PI - 0.9, Math.PI + 0.9); else g.arc(cx, 0, 20 + off, -0.9, 0.9); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function buildModel(type) {
  const g = new THREE.Group();
  const stone = std(STONE);
  if (type === 'statue') {
    cyl(g, 6, 7, 2, 0, 0, 0, stone, 8);
    box(g, 5, 9, 9, 0, 2, 0, std(0x7c6a58));
    const b = std(BRONZE, { metalness: 0.5, roughness: 0.4 });
    box(g, 2.6, 2.8, 6, 0, 11, 0, b);
    box(g, 1.4, 3.2, 1.4, 0, 11, 3.2, b); box(g, 1.2, 2.6, 1.2, 0, 11, -2.4, b);
    box(g, 1.4, 2.6, 1.6, 0, 15.4, 2.6, b);
    cyl(g, 0.7, 0.9, 3.4, 0, 13.8, -0.3, b, 8);
    box(g, 0.25, 4.5, 0.25, 0.9, 14.7, 0.8, std(GOLD, { metalness: 0.8, roughness: 0.3 }));
  } else if (type === 'flag') {
    cyl(g, 1.2, 1.6, 1.2, 0, 0, 0, stone);
    cyl(g, 0.35, 0.6, 46, 0, 1.2, 0, std(0xdcdcdc, { metalness: 0.8, roughness: 0.3 }));
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(15, 9, 12, 4), new THREE.MeshStandardMaterial({ map: flagTexture(), side: THREE.DoubleSide, roughness: 0.8 }));
    flag.position.set(7.6, 42, 0); g.add(flag); g.userData.flag = flag;
  } else if (type === 'wheel') {
    const steel = std(0xe8112d, { metalness: 0.4, roughness: 0.4 });
    const hub = new THREE.Group(); hub.position.set(0, 24, 0); g.add(hub);
    hub.add(new THREE.Mesh(new THREE.TorusGeometry(20, 0.6, 8, 48), steel));
    const cols = [0xffd200, 0x2aa1d8, 0xe8112d, 0x4cb050];
    for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; const sp = new THREE.Mesh(new THREE.BoxGeometry(0.3, 20, 0.3), std(0xffffff)); sp.position.set(Math.cos(a) * 10, Math.sin(a) * 10, 0); sp.rotation.z = a - Math.PI / 2; hub.add(sp); const cab = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.6, 2.4), std(cols[i % 4])); cab.position.set(Math.cos(a) * 20, Math.sin(a) * 20 - 1.6, 0); hub.add(cab); }
    g.userData.spin = hub;
    for (const sx of [-1, 1]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.8, 26, 0.8), std(0xffffff)); leg.position.set(sx * 6, 12, 0); leg.rotation.z = sx * 0.25; g.add(leg); }
  } else if (type === 'victory') {
    box(g, 60, 1, 60, 0, 0, 0, std(0xd7cfbf));
    const arch = std(0xb5654a, { roughness: 0.5 });
    for (let i = 0; i < 3; i++) { const t = new THREE.Mesh(new THREE.TorusGeometry(18, 1.2, 10, 40, Math.PI), arch); t.rotation.y = i * Math.PI / 3; t.position.y = 1; g.add(t); }
    const ringTop = new THREE.Mesh(new THREE.TorusGeometry(4, 0.9, 8, 24), arch); ringTop.rotation.x = Math.PI / 2; ringTop.position.y = 18.6; g.add(ringTop);
    cyl(g, 2.2, 2.6, 1.2, 0, 1, 0, std(0x5c5c5c));
    const fl = new THREE.Mesh(new THREE.ConeGeometry(1.2, 4, 10), new THREE.MeshBasicMaterial({ color: 0xffa531 })); fl.position.set(0, 4.2, 0); g.add(fl); g.userData.flame = fl;
  }
  return g;
}
