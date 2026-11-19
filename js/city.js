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

// ---------- Материал «дом с окнами» ----------
// Окна рисует видеокарта прямо по стенам: этаж = 3 м, окно = каждые 3.2 м.
// Ночью половина окон загорается тёплым светом.
export const shared = { uNight: { value: 0 } };

export function buildingMaterial(color = 0xffffff, windows = true, opts = {}) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.0, ...opts });
  if (!windows) return m;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = shared.uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 wp = vec4(transformed, 1.0);
        vec3 wn = objectNormal;
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp; wn = mat3(instanceMatrix) * wn;
        #endif
        wp = modelMatrix * wp;
        vWPos = wp.xyz; vWNrm = normalize(mat3(modelMatrix) * wn);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm; uniform float uNight; float gWin; float gRnd;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 an = abs(vWNrm);
          float wall = 1.0 - step(0.6, an.y);
          // координата «вдоль стены»: работает и для наклонных стен
          vec2 t2 = normalize(vec2(-vWNrm.z, vWNrm.x) + 1e-5);
          float along = dot(vWPos.xz, t2);
          float fy = fract(vWPos.y / 3.0);
          float fx = fract(along / 3.2);
          gWin = step(0.28, fx) * step(fx, 0.72) * step(0.30, fy) * step(fy, 0.78) * wall * step(2.8, vWPos.y);
          vec2 cell = vec2(floor(along / 3.2), floor(vWPos.y / 3.0)) + floor(dot(vWPos.xz, vec2(t2.y, -t2.x)) / 5.0) * 3.7;
          gRnd = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.62 + vec3(0.03, 0.05, 0.08), gWin);
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += gWin * uNight * step(0.5, gRnd) * mix(vec3(1.0, 0.72, 0.4), vec3(0.85, 0.9, 1.0), step(0.85, gRnd)) * 1.4;`);
  };
  return m;
}

// ---------- Помощник «плоские слои» (зелень, вода, дороги) ----------
class Flat {
  constructor(y) { this.y = y; this.p = []; }
  tri(ax, az, bx, bz, cx, cz) {
    // следим, чтобы треугольник смотрел вверх; высоту берём с рельефа
    if ((bz - az) * (cx - ax) - (bx - ax) * (cz - az) < 0) { const tx = bx, tz = bz; bx = cx; bz = cz; cx = tx; cz = tz; }
    const y = this.y; this.p.push(ax, y + elev(ax, az), az, bx, y + elev(bx, bz), bz, cx, y + elev(cx, cz), cz);
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
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, z1] = pts[i], [x2, z2] = pts[i + 1];
      const L = Math.hypot(x2 - x1, z2 - z1); if (L < 0.01) continue;
      const nx = -(z2 - z1) / L * h, nz = (x2 - x1) / L * h;
      this.tri(x1 + nx, z1 + nz, x2 + nx, z2 + nz, x2 - nx, z2 - nz);
      this.tri(x1 + nx, z1 + nz, x2 - nx, z2 - nz, x1 - nx, z1 - nz);
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
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.95, ...opts }));
    m.receiveShadow = true;
    return m;
  }
}

// Цвета зданий по типу (стиль белого архитектурного макета)
const TYPE_COLOR = {
  0: [0xffffff, 0xfbf8f3, 0xf6f3ec], 1: [0xf7eee0, 0xf3e7d4, 0xefe6d8], 2: [0xe4e1db, 0xdcd9d2], 3: [0xffffff, 0xfaf8f4, 0xf4f2ee],
  4: [0xfbf3e4, 0xf6efe3], 5: [0xe2e0dc, 0xd9d8d4], 6: [0xfff3dc, 0xfcefd8], 7: [0xfdf2d8], 8: [0xe8e2d4],
};

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
const signedArea = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length]; a += x1 * z2 - x2 * z1; } return a / 2; };

// Строим общую геометрию для набора зданий: стены + крыши
function buildingsGeometry(list, colorFn) {
  const P = [], N = [], C = [], triStart = [];
  const c = new THREE.Color();
  const push = (ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz, col) => {
    // проверяем, что треугольник «смотрит» наружу, иначе меняем порядок
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    if (fx * nx + fy * ny + fz * nz < 0) { let t = bx; bx = cx; cx = t; t = by; by = cy; cy = t; t = bz; bz = cz; cz = t; }
    P.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let i = 0; i < 3; i++) { N.push(nx, ny, nz); C.push(col.r, col.g, col.b); }
  };
  list.forEach((b, bi) => {
    triStart.push(P.length / 9);
    if (b.base === undefined) b.base = Math.min(...b.outer.map(p => elev(p[0], p[1])));
    const y0 = b.base + (b.mh > 0 ? b.mh : -2), y1 = b.base + b.h; // без «висящих» углов на склоне
    const base = colorFn(b, bi);
    const wallC = base.clone(), roofC = base.clone().multiplyScalar(0.9);
    const walls = (ring, isHole) => {
      const out = (signedArea(ring) > 0) !== isHole;
      for (let i = 0; i < ring.length; i++) {
        const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % ring.length];
        const dx = x2 - x1, dz = z2 - z1, L = Math.hypot(dx, dz); if (L < 0.05) continue;
        let nx = dz / L, nz = -dx / L; if (!out) { nx = -nx; nz = -nz; }
        push(x1, y0, z1, x2, y0, z2, x2, y1, z2, nx, 0, nz, wallC);
        push(x1, y0, z1, x2, y1, z2, x1, y1, z1, nx, 0, nz, wallC);
      }
    };
    walls(b.outer, false); b.holes.forEach(hl => walls(hl, true));
    const v2 = b.outer.map(p => new THREE.Vector2(p[0], p[1]));
    const hv = b.holes.map(hl => hl.map(p => new THREE.Vector2(p[0], p[1])));
    const all = b.outer.concat(...b.holes);
    for (const f of THREE.ShapeUtils.triangulateShape(v2, hv)) {
      const A = all[f[0]], B = all[f[1]], Cc = all[f[2]];
      if (!A || !B || !Cc) continue;
      push(A[0], y1, A[1], B[0], y1, B[1], Cc[0], y1, Cc[1], 0, 1, 0, roofC);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
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
  const AREA = { 1: [0x86bde0, 0.16, { roughness: 0.25, metalness: 0.1 }], 2: [0xb7cf98, 0.10], 3: [0xc8d9ab, 0.06], 4: [0x9dbd82, 0.08], 5: [0x9ccb88, 0.12], 6: [0xf3eee5, 0.20], 7: [0xc4cdb3, 0.07] };
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
  for (const [code, L] of Object.entries(areaLayers)) { const m = L.mesh(AREA[code][0], AREA[code][2] || {}); flatGroup.add(m); if (code === '1') mats.water = m.material; }

  // ---------- 3. Дороги ----------
  // класс: 1 магистраль … 4 жилая улица, 5 проезд, 6 пешеходная, 7 тротуар/дорожка
  const ROAD = { 1: [0x4f535b, 0.42], 2: [0x565a62, 0.40], 3: [0x5e626a, 0.38], 4: [0x6c7077, 0.36], 5: [0x8e9197, 0.32], 6: [0xebe5d8, 0.30], 7: [0xddd5c5, 0.26] };
  const roadLayers = {};
  for (const r of D.roads) {
    const cls = r[0], w = r[1] * s, n = r[2]; if (!ROAD[cls]) continue;
    const pts = []; for (let i = 0; i < n; i++) pts.push([r[3 + 2 * i] * s, r[4 + 2 * i] * s]);
    (roadLayers[cls] ||= new Flat(ROAD[cls][1])).ribbon(pts, w, cls <= 6);
  }
  for (const [cls, L] of Object.entries(roadLayers)) flatGroup.add(L.mesh(ROAD[cls][0]));

  // ---------- 4. Здания ----------
  mats.houses = buildingMaterial(0xffffff, true, { vertexColors: true });
  const colorFn = (b, i) => { const pal = TYPE_COLOR[b.code] || TYPE_COLOR[0]; return new THREE.Color(pal[Math.floor(rnd(i) * pal.length)]); };
  const { geometry, triStart } = buildingsGeometry(buildings, colorFn);
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
  const T = D.trees, TS = D.treeScale, nT = T.length / 2;
  const treeGeo = new THREE.IcosahedronGeometry(1, matchMedia('(pointer: coarse)').matches ? 0 : 1); // на телефоне кроны проще
  const treesMesh = new THREE.InstancedMesh(treeGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }), nT);
  const TREE_C = [0x7ea35a, 0x6d9550, 0x8fb366, 0x5f8a49, 0x86a85e].map(c => new THREE.Color(c));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  for (let i = 0; i < nT; i++) {
    const sc = (TS[i] || 100) / 100, r = 3.3 * sc;
    m4.compose(new THREE.Vector3(T[2 * i] * s, r * 1.3 + elev(T[2 * i] * s, T[2 * i + 1] * s), T[2 * i + 1] * s), q.setFromEuler(e.set(0, rnd(i) * 6, 0)), new THREE.Vector3(r, r * 1.1, r));
    treesMesh.setMatrixAt(i, m4); treesMesh.setColorAt(i, TREE_C[Math.floor(rnd(i + 7) * TREE_C.length)]);
  }
  treesMesh.castShadow = true; treesMesh.receiveShadow = true; treesMesh.computeBoundingSphere();
  city.add(treesMesh);

  // ---------- 6. Фонари (горят ночью) ----------
  const LP = D.lamps, lampPos = new Float32Array(LP.length / 2 * 3);
  for (let i = 0; i < LP.length / 2; i++) { lampPos[i * 3] = LP[2 * i] * s; lampPos[i * 3 + 1] = 8.5 + elev(LP[2 * i] * s, LP[2 * i + 1] * s); lampPos[i * 3 + 2] = LP[2 * i + 1] * s; }
  const lampGeo = new THREE.BufferGeometry(); lampGeo.setAttribute('position', new THREE.BufferAttribute(lampPos, 3));
  const glow = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,230,180,1)'); gr.addColorStop(0.25, 'rgba(255,190,110,0.55)'); gr.addColorStop(1, 'rgba(255,160,80,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
  const lampsPts = new THREE.Points(lampGeo, new THREE.PointsMaterial({ size: 20, map: glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
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
