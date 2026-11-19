// ============================================================
//  route.js — «ШТУРМАН»
//  Превращает дороги в граф (перекрёстки = точки, улицы = связи)
//  и ищет кратчайший путь алгоритмом A* — как навигатор.
//  Пешком: все дороги, тротуары и дорожки.
//  На машине: только проезжие дороги, с учётом односторонок.
// ============================================================
import * as THREE from 'three';
import { elev } from './terrain.js';

const CAR_SPEED = { 1: 45, 2: 40, 3: 35, 4: 25, 5: 15 }; // км/ч по классу дороги
const WALK_SPEED = 4.8;

// Небольшая «куча» (приоритетная очередь) для A*
class Heap {
  constructor() { this.k = []; this.v = []; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n) {
      let i = 0;
      while (true) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
  get size() { return this.k.length; }
}

export class Router {
  constructor(D) {
    const s = 0.1, ids = new Map();
    this.X = []; this.Z = [];
    const node = (x, z) => { const key = x * 100003 + z; let id = ids.get(key); if (id === undefined) { id = this.X.length; ids.set(key, id); this.X.push(x * s); this.Z.push(z * s); } return id; };
    // рёбра: from, to, длина, класс, название, можно ли машине
    const eFrom = [], eTo = [], eLen = [], eCls = [], eName = [], eCar = [], adj = [];
    const add = (a, b, L, cls, nm, car) => { (adj[a] ||= []).push(eTo.length); eFrom.push(a); eTo.push(b); eLen.push(L); eCls.push(cls); eName.push(nm); eCar.push(car ? 1 : 0); };
    D.roads.forEach((r, ri) => {
      const cls = r[0], n = r[2]; const [nm, ow] = (D.roadMeta && D.roadMeta[ri]) || [-1, 0];
      let prev = node(r[3], r[4]);
      for (let i = 1; i < n; i++) {
        const cur = node(r[3 + 2 * i], r[4 + 2 * i]);
        const L = Math.hypot(this.X[cur] - this.X[prev], this.Z[cur] - this.Z[prev]);
        if (L > 0.01) {
          const carOK = cls <= 5;
          add(prev, cur, L, cls, nm, carOK && ow !== -1);
          add(cur, prev, L, cls, nm, carOK && ow !== 1);
        }
        prev = cur;
      }
    });
    Object.assign(this, { eFrom, eTo, eLen, eCls, eName, eCar, adj, names: D.names });
    // сетка для поиска ближайшей точки графа
    this.cell = 60; this.grid = new Map();
    for (let i = 0; i < this.X.length; i++) {
      const k = Math.floor(this.X[i] / this.cell) * 10007 + Math.floor(this.Z[i] / this.cell);
      (this.grid.get(k) || this.grid.set(k, []).get(k)).push(i);
    }
    console.log(`[route] узлов: ${this.X.length}, рёбер: ${eTo.length}`);
  }

  // ближайшая точка дорожной сети (для машины — только где можно ехать)
  nearest(x, z, mode) {
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    let best = -1, bd = Infinity;
    for (let r = 0; r < 12 && (best < 0 || r < 2); r++) {
      for (let i = cx - r; i <= cx + r; i++) for (let j = cz - r; j <= cz + r; j++) {
        if (Math.max(Math.abs(i - cx), Math.abs(j - cz)) !== r) continue;
        const list = this.grid.get(i * 10007 + j); if (!list) continue;
        for (const id of list) {
          if (mode === 'car' && !(this.adj[id] || []).some(e => this.eCar[e])) continue;
          if (mode === 'walk' && !(this.adj[id] || []).length) continue;
          const d = Math.hypot(this.X[id] - x, this.Z[id] - z); if (d < bd) { bd = d; best = id; }
        }
      }
    }
    return best;
  }

  // A*: ищем путь с минимальным временем
  find(from, to, mode) {
    const a = this.nearest(from.x, from.z, mode), b = this.nearest(to.x, to.z, mode);
    if (a < 0 || b < 0) return null;
    const N = this.X.length, g = new Float64Array(N).fill(Infinity), via = new Int32Array(N).fill(-1), done = new Uint8Array(N);
    const vmax = mode === 'car' ? 45 / 3.6 : WALK_SPEED / 3.6;
    const h = (i) => Math.hypot(this.X[i] - this.X[b], this.Z[i] - this.Z[b]) / vmax;
    const heap = new Heap(); g[a] = 0; heap.push(h(a), a);
    while (heap.size) {
      const u = heap.pop(); if (done[u]) continue; done[u] = 1;
      if (u === b) break;
      for (const e of this.adj[u] || []) {
        if (mode === 'car' && !this.eCar[e]) continue;
        const v = this.eTo[e]; if (done[v]) continue;
        const sp = mode === 'car' ? CAR_SPEED[this.eCls[e]] / 3.6 : (WALK_SPEED * (this.eCls[e] <= 2 ? 0.97 : 1)) / 3.6;
        const cost = g[u] + this.eLen[e] / sp;
        if (cost < g[v]) { g[v] = cost; via[v] = e; heap.push(cost + h(v), v); }
      }
    }
    if (!isFinite(g[b])) return null;
    // собираем путь в обратном порядке
    const edges = []; let cur = b;
    while (cur !== a) { const e = via[cur]; edges.push(e); cur = this.eFrom[e]; }
    edges.reverse();
    const pts = [[this.X[a], this.Z[a]]];
    let len = 0;
    for (const e of edges) { const v = this.eTo[e]; pts.push([this.X[v], this.Z[v]]); len += this.eLen[e]; }
    // добавляем «хвостики» от точек старта/финиша до дороги
    pts.unshift([from.x, from.z]); pts.push([to.x, to.z]);
    return { pts, edges, length: len + Math.hypot(this.X[a] - from.x, this.Z[a] - from.z) + Math.hypot(this.X[b] - to.x, this.Z[b] - to.z), time: g[b], mode, steps: this.steps(edges, mode) };
  }

  // Подсказки: «Поверните направо на ул. …»
  steps(edges, mode) {
    const name = (e) => this.eName[e] >= 0 ? this.names[this.eName[e]] : (this.eCls[e] >= 6 ? 'пешеходная дорожка' : 'проезд');
    const groups = [];
    for (const e of edges) {
      const nm = name(e), last = groups[groups.length - 1];
      if (last && last.name === nm) { last.len += this.eLen[e]; last.edges.push(e); }
      else groups.push({ name: nm, len: this.eLen[e], edges: [e] });
    }
    // короткие куски склеиваем с соседями
    for (let i = groups.length - 2; i >= 1; i--) if (groups[i].len < 25) { groups[i - 1].len += groups[i].len; groups[i - 1].edges.push(...groups[i].edges); groups.splice(i, 1); }
    const dir = (e) => { const v = this.eTo[e], u = this.eFrom[e]; return [this.X[v] - this.X[u], -(this.Z[v] - this.Z[u])]; };
    const out = []; let dist = 0;
    groups.forEach((gr, i) => {
      let action = 'Начните движение';
      if (i > 0) {
        const p = dir(groups[i - 1].edges[groups[i - 1].edges.length - 1]), c = dir(gr.edges[0]);
        const ang = Math.atan2(p[0] * c[1] - p[1] * c[0], p[0] * c[0] + p[1] * c[1]) * 180 / Math.PI;
        action = ang > 30 ? (ang > 120 ? 'Развернитесь' : 'Поверните налево') : ang < -30 ? (ang < -120 ? 'Развернитесь' : 'Поверните направо') : 'Продолжайте прямо';
      }
      const u = this.eFrom[gr.edges[0]];
      out.push({ action, name: gr.name, len: gr.len, at: dist, x: this.X[u], z: this.Z[u] });
      dist += gr.len;
    });
    out.push({ action: 'Вы на месте', name: '', len: 0, at: dist, x: null, z: null });
    return out;
  }
}

// Рисуем линию маршрута на карте
export function routeMesh(pts0, mode) {
  const P = [], w = mode === 'car' ? 7 : 4.5, y = 0.9;
  const tri = (ax, az, bx, bz, cx, cz) => { if ((bz - az) * (cx - ax) - (bx - ax) * (cz - az) < 0) { [bx, cx] = [cx, bx]; [bz, cz] = [cz, bz]; } P.push(ax, y + elev(ax, az), az, bx, y + elev(bx, bz), bz, cx, y + elev(cx, cz), cz); };
  const pts = []; // дробим по 15 м, чтобы линия шла по рельефу
  for (let i = 0; i < pts0.length; i++) {
    if (i > 0) { const [x1, z1] = pts0[i - 1], [x2, z2] = pts0[i]; const n = Math.floor(Math.hypot(x2 - x1, z2 - z1) / 15); for (let k = 1; k <= n; k++) pts.push([x1 + (x2 - x1) * k / (n + 1), z1 + (z2 - z1) * k / (n + 1)]); }
    pts.push(pts0[i]);
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, z1] = pts[i], [x2, z2] = pts[i + 1], L = Math.hypot(x2 - x1, z2 - z1); if (L < 0.01) continue;
    const nx = -(z2 - z1) / L * w / 2, nz = (x2 - x1) / L * w / 2;
    tri(x1 + nx, z1 + nz, x2 + nx, z2 + nz, x2 - nx, z2 - nz); tri(x1 + nx, z1 + nz, x2 - nx, z2 - nz, x1 - nx, z1 - nz);
    for (let k = 0; k < 8; k++) { const a1 = k / 8 * Math.PI * 2, a2 = (k + 1) / 8 * Math.PI * 2; tri(x2, z2, x2 + Math.cos(a1) * w / 2, z2 + Math.sin(a1) * w / 2, x2 + Math.cos(a2) * w / 2, z2 + Math.sin(a2) * w / 2); }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: mode === 'car' ? 0x1f7ae0 : 0x18a957, fog: false }));
  m.renderOrder = 3;
  return m;
}

// Булавка (маркер) на карте
export function pinMesh(color = 0xe8112d) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.35, emissive: color, emissiveIntensity: 0.25 });
  const head = new THREE.Mesh(new THREE.SphereGeometry(5, 20, 14), mat); head.position.y = 22; g.add(head);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(4.3, 15, 20), mat); tip.rotation.x = Math.PI; tip.position.y = 13; g.add(tip);
  const dot = new THREE.Mesh(new THREE.SphereGeometry(2, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff })); dot.position.y = 22; dot.position.z = 3.6; g.add(dot);
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(4, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 })); shadow.rotation.x = -Math.PI / 2; shadow.position.y = 1; g.add(shadow);
  return g;
}

export function fmtDist(m) { return m < 1000 ? `${Math.round(m / 10) * 10} м` : `${(m / 1000).toFixed(1).replace('.', ',')} км`; }
export function fmtTime(sec) { const m = Math.max(1, Math.round(sec / 60)); return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`; }
