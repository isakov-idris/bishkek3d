// ============================================================
//  life.js — «ЖИЗНЬ»
//  • Деревья двух пород: тополь-свечка и раскидистый карагач,
//    кроны качаются на ветру.
//  • Машины ездят по настоящему дорожному графу (тот же, что
//    у маршрутов): поворачивают на перекрёстках, держатся правой
//    полосы, соблюдают односторонки; ночью горят фары.
//  • Облака над городом и горами.
//  Расположение деревьев — автоматическое (вдоль улиц и в парках),
//  машины — анимация, не реальный трафик.
// ============================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { elev } from './terrain.js';

export const lifeShared = { uTime: { value: 0 }, uWind: { value: 1 } };

// раскраска вершин геометрии одним цветом (с затемнением снизу — объём кроны)
function paint(geo, color, aoBottom = 0) {
  const p = geo.attributes.position, c = new Float32Array(p.count * 3), col = new THREE.Color(color);
  geo.computeBoundingBox(); const y0 = geo.boundingBox.min.y, y1 = geo.boundingBox.max.y;
  for (let i = 0; i < p.count; i++) { const k = 1 - aoBottom * (1 - (p.getY(i) - y0) / Math.max(1e-6, y1 - y0)); c[i * 3] = col.r * k; c[i * 3 + 1] = col.g * k; c[i * 3 + 2] = col.b * k; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3)); return geo;
}
const toNonIndexed = (g) => g.index ? g.toNonIndexed() : g;

// ---------- Деревья ----------
function elmGeometry() { // карагач: ствол + 4 «облака» листвы
  const parts = [paint(toNonIndexed(new THREE.CylinderGeometry(0.16, 0.28, 3.2, 6).translate(0, 1.6, 0)), 0x5b4636)];
  for (const [x, y, z, r] of [[0, 4.6, 0, 2.5], [1.4, 4.0, 0.6, 1.7], [-1.2, 4.2, -0.7, 1.8], [0.3, 5.6, -0.4, 1.6]]) {
    parts.push(paint(toNonIndexed(new THREE.IcosahedronGeometry(r, 1).translate(x, y, z)), 0xffffff, 0.45));
  }
  return mergeGeometries(parts.map(g => { g.deleteAttribute('uv'); return g; }));
}
function poplarGeometry() { // тополь: высокая узкая крона
  const parts = [paint(toNonIndexed(new THREE.CylinderGeometry(0.14, 0.24, 3.0, 6).translate(0, 1.5, 0)), 0x6b5a48)];
  const crown = new THREE.IcosahedronGeometry(1, 2); crown.scale(1.25, 5.2, 1.25); crown.translate(0, 7.2, 0);
  parts.push(paint(toNonIndexed(crown), 0xffffff, 0.5));
  const top = new THREE.IcosahedronGeometry(0.9, 1); top.scale(0.9, 1.8, 0.9); top.translate(0, 11.6, 0);
  parts.push(paint(toNonIndexed(top), 0xffffff, 0.2));
  return mergeGeometries(parts.map(g => { g.deleteAttribute('uv'); return g; }));
}
function windMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, flatShading: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = lifeShared.uTime; sh.uniforms.uWind = lifeShared.uWind;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 ip = instanceMatrix[3].xyz;
          float k = max(0.0, position.y - 2.5) * 0.035 * uWind;
          transformed.x += sin(uTime * 1.3 + ip.x * 0.05 + ip.z * 0.03) * k;
          transformed.z += cos(uTime * 1.1 + ip.z * 0.05) * k * 0.6;
        #endif`);
  };
  m.customProgramCacheKey = () => 'wind-tree';
  return m;
}
export function buildTrees(D, isMobile) {
  const s = 0.1, T = D.trees, TS = D.treeScale, n = T.length / 2;
  const max = isMobile ? 14000 : n, step = Math.max(1, n / max);
  const elm = [], pop = [];
  for (let f = 0; f < n; f += step) {
    const i = Math.floor(f), x = T[2 * i] * s, z = T[2 * i + 1] * s, sc = (TS[i] || 100) / 100;
    const h = Math.sin(i * 12.9898) * 43758.5453, r = h - Math.floor(h);
    (r < 0.34 ? pop : elm).push([x, z, sc, r]);
  }
  const greens = [0x6f9a4f, 0x5f8b45, 0x7fa85a, 0x56813f, 0x8aae62, 0x6c8f4a].map(c => new THREE.Color(c));
  const mk = (geo, list, scaleK) => {
    const mesh = new THREE.InstancedMesh(geo, windMaterial(), list.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    list.forEach(([x, z, sc, r], i) => {
      const k = sc * scaleK * (0.85 + r * 0.3);
      m4.compose(new THREE.Vector3(x, elev(x, z) - 0.1, z), q.setFromEuler(e.set(0, r * 40, 0)), new THREE.Vector3(k, k * (0.9 + r * 0.25), k));
      mesh.setMatrixAt(i, m4); mesh.setColorAt(i, greens[Math.floor(r * 997) % greens.length]);
    });
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.computeBoundingSphere();
    return mesh;
  };
  const g = new THREE.Group();
  g.add(mk(elmGeometry(), elm, 0.95), mk(poplarGeometry(), pop, 1.05));
  return { group: g, count: elm.length + pop.length };
}

// ---------- Машины ----------
const CAR_COLORS = [0xf2f2f0, 0xf2f2f0, 0xc8cbce, 0xc8cbce, 0x2a2c30, 0x6c7076, 0x1f3550, 0x8f1d1d, 0xcfc3a8, 0x3c4a3a, 0xf2f2f0];
function carGeometry() {
  const body = paint(toNonIndexed(new THREE.BoxGeometry(1.8, 0.75, 4.4).translate(0, 0.62, 0)), 0xffffff);
  const cabin = paint(toNonIndexed(new THREE.BoxGeometry(1.6, 0.62, 2.3).translate(0, 1.3, -0.2)), 0x1d2228);
  const wheels = [];
  for (const [x, z] of [[-0.85, 1.35], [0.85, 1.35], [-0.85, -1.35], [0.85, -1.35]]) wheels.push(paint(toNonIndexed(new THREE.CylinderGeometry(0.33, 0.33, 0.25, 8).rotateZ(Math.PI / 2).translate(x, 0.33, z)), 0x111111));
  return mergeGeometries([body, cabin, ...wheels].map(g => { g.deleteAttribute('uv'); return g; }));
}
function lightsGeometry() { // фары спереди (белые), стопы сзади (красные)
  const parts = [];
  for (const x of [-0.6, 0.6]) {
    parts.push(paint(toNonIndexed(new THREE.BoxGeometry(0.35, 0.18, 0.06).translate(x, 0.75, 2.22)), 0xfff2d0));
    parts.push(paint(toNonIndexed(new THREE.BoxGeometry(0.35, 0.16, 0.06).translate(x, 0.8, -2.22)), 0xff2a1a));
  }
  return mergeGeometries(parts.map(g => { g.deleteAttribute('uv'); return g; }));
}
export class Traffic {
  constructor(router, count) {
    this.r = router; this.cars = [];
    const R = router, starts = [];
    for (let e = 0; e < R.eTo.length; e++) if (R.eCar[e] && R.eCls[e] <= 4 && R.eLen[e] > 8) starts.push(e);
    const SPEED = { 1: 13, 2: 12, 3: 10.5, 4: 7.5, 5: 5 };
    for (let i = 0; i < count && starts.length; i++) {
      const e = starts[Math.floor(Math.random() * starts.length)];
      this.cars.push({ e, t: Math.random() * R.eLen[e], v: SPEED[R.eCls[e]] * (0.75 + Math.random() * 0.45), base: 0 });
    }
    this.SPEED = SPEED;
    this.body = new THREE.InstancedMesh(carGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.45 }), this.cars.length);
    this.lights = new THREE.InstancedMesh(lightsGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, fog: true }), this.cars.length);
    this.cars.forEach((c, i) => this.body.setColorAt(i, new THREE.Color(CAR_COLORS[i % CAR_COLORS.length])));
    this.body.castShadow = true; this.body.frustumCulled = false; this.lights.frustumCulled = false;
    this.group = new THREE.Group(); this.group.add(this.body, this.lights);
    this.m4 = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.up = new THREE.Vector3(0, 1, 0); this.p = new THREE.Vector3(); this.s = new THREE.Vector3(1, 1, 1);
  }
  next(c) { // выбираем следующую улицу на перекрёстке (без разворота, если можно)
    const R = this.r, at = R.eTo[c.e], from = R.eFrom[c.e];
    const opts = (R.adj[at] || []).filter(e => R.eCar[e] && R.eCls[e] <= 5);
    const fwd = opts.filter(e => R.eTo[e] !== from);
    const list = fwd.length ? fwd : opts;
    if (!list.length) { c.e = R.eTo.length ? c.e : 0; c.t = 0; return; }
    // предпочитаем ехать прямо
    const dx0 = R.X[at] - R.X[from], dz0 = R.Z[at] - R.Z[from], L0 = Math.hypot(dx0, dz0) || 1;
    list.sort((a, b) => {
      const da = ((R.X[R.eTo[a]] - R.X[at]) * dx0 + (R.Z[R.eTo[a]] - R.Z[at]) * dz0) / (R.eLen[a] * L0);
      const db = ((R.X[R.eTo[b]] - R.X[at]) * dx0 + (R.Z[R.eTo[b]] - R.Z[at]) * dz0) / (R.eLen[b] * L0);
      return db - da;
    });
    c.e = Math.random() < 0.65 ? list[0] : list[Math.floor(Math.random() * list.length)];
    c.v = this.SPEED[R.eCls[c.e]] * (0.75 + Math.random() * 0.45);
  }
  update(dt, night) {
    const R = this.r;
    this.cars.forEach((c, i) => {
      c.t += c.v * dt;
      let guard = 0; while (c.t > R.eLen[c.e] && guard++ < 6) { c.t -= R.eLen[c.e]; this.next(c); }
      const a = R.eFrom[c.e], b = R.eTo[c.e], L = R.eLen[c.e] || 1, k = Math.min(1, c.t / L);
      const dx = (R.X[b] - R.X[a]) / L, dz = (R.Z[b] - R.Z[a]) / L;
      const lane = R.eCls[c.e] <= 2 ? 3.6 : 2.0; // правая полоса
      const x = R.X[a] + (R.X[b] - R.X[a]) * k - dz * lane, z = R.Z[a] + (R.Z[b] - R.Z[a]) * k + dx * lane;
      this.p.set(x, elev(x, z) + 0.45, z);
      this.q.setFromAxisAngle(this.up, Math.atan2(dx, dz));
      this.m4.compose(this.p, this.q, this.s);
      this.body.setMatrixAt(i, this.m4); this.lights.setMatrixAt(i, this.m4);
    });
    this.body.instanceMatrix.needsUpdate = true; this.lights.instanceMatrix.needsUpdate = true;
    this.lights.material.opacity = Math.max(0.15, night);
  }
}

// ---------- Облака ----------
function cloudTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128; const g = c.getContext('2d');
  for (let i = 0; i < 22; i++) {
    const x = 40 + Math.random() * 176, y = 50 + Math.random() * 40, r = 18 + Math.random() * 30;
    const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
export function buildClouds() {
  const g = new THREE.Group(), tex = cloudTexture(), list = [];
  for (let i = 0; i < 16; i++) {
    const m = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.75, depthWrite: false, fog: false });
    const sp = new THREE.Sprite(m); const w = 2500 + Math.random() * 3500;
    sp.scale.set(w, w * 0.42, 1);
    sp.position.set(-22000 + Math.random() * 44000, 2600 + Math.random() * 1600, -14000 + Math.random() * 34000);
    g.add(sp); list.push(sp);
  }
  return {
    group: g,
    update(dt, night, golden) {
      for (const sp of list) {
        sp.position.x += dt * 9; if (sp.position.x > 24000) sp.position.x = -24000;
        sp.material.opacity = 0.7 * (1 - night * 0.85);
        sp.material.color.setRGB(1, 1 - golden * 0.18, 1 - golden * 0.32);
      }
    },
  };
}
