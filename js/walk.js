// ============================================================
//  walk.js — «ПЕШЕХОД»
//  Режим от первого лица: глаза на высоте 1,7 м.
//  • Улица: ходим по реальному рельефу, сквозь дома пройти нельзя.
//  • Внутри здания: комната на выбранном этаже, за окном — настоящий
//    3D-город с этой высоты. Интерьер — ДЕМО (реальных планировок нет)
//    или своя модель .glb (например, из Higgsfield 3D или Blender).
//  Управление: телефон — джойстик слева + взгляд пальцем справа;
//  компьютер — WASD/стрелки + мышь (Shift — бегом).
// ============================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { elev } from './terrain.js';

const EYE = 1.7;

// ---------- Сетка зданий для столкновений ----------
function buildGrid(buildings) {
  const cell = 40, grid = new Map();
  for (const b of buildings) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of b.outer) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    b.bb = [x0, z0, x1, z1];
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) for (let j = Math.floor(z0 / cell); j <= Math.floor(z1 / cell); j++) {
      const k = i * 100003 + j; (grid.get(k) || grid.set(k, []).get(k)).push(b);
    }
  }
  const inPoly = (x, z, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, zi] = r[i], [xj, zj] = r[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; };
  return (x, z, pad = 0.35) => {
    const list = grid.get(Math.floor(x / cell) * 100003 + Math.floor(z / cell)); if (!list) return false;
    for (const b of list) {
      const [x0, z0, x1, z1] = b.bb; if (x < x0 - pad || x > x1 + pad || z < z0 - pad || z > z1 + pad) continue;
      if (inPoly(x, z, b.outer) || inPoly(x + pad, z, b.outer) || inPoly(x - pad, z, b.outer) || inPoly(x, z + pad, b.outer) || inPoly(x, z - pad, b.outer)) return true;
    }
    return false;
  };
}

// ---------- Демо-комната ----------
const M = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, ...o });
function boxAt(g, w, h, d, x, y, z, mat, solid, list) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y + h / 2, z); g.add(m);
  if (solid) list.push([x - w / 2, z - d / 2, x + w / 2, z + d / 2]);
  return m;
}
// Комната в локальных координатах: окно на стене z = +D/2 (смотрит наружу), пол y = 0
function buildRoom(W, D, H) {
  const g = new THREE.Group(), shell = new THREE.Group(), furn = new THREE.Group(), solids = [];
  g.add(shell, furn);
  const wall = M(0xf4f1ec, { side: THREE.DoubleSide }), floor = M(0xb98a5e, { roughness: 0.55 }), ceil = M(0xfbfaf7, { side: THREE.DoubleSide });
  boxAt(shell, W, 0.05, D, 0, -0.05, 0, floor);
  boxAt(shell, W, 0.05, D, 0, H, 0, ceil);
  boxAt(shell, W, H, 0.12, 0, 0, -D / 2, wall);                    // задняя стена
  boxAt(shell, 0.12, H, D, -W / 2, 0, 0, wall); boxAt(shell, 0.12, H, D, W / 2, 0, 0, wall); // боковые
  // стена с панорамным окном: подоконник + узкие простенки + рама
  const ww = Math.min(W - 1.0, 5.5), sill = 0.5, top = H - 0.25;
  boxAt(shell, W, sill, 0.12, 0, 0, D / 2, wall);
  boxAt(shell, W, H - top, 0.12, 0, top, D / 2, wall);
  boxAt(shell, (W - ww) / 2, top - sill, 0.12, -(W + ww) / 4, sill, D / 2, wall);
  boxAt(shell, (W - ww) / 2, top - sill, 0.12, (W + ww) / 4, sill, D / 2, wall);
  const frame = M(0x2b2f36, { metalness: 0.4, roughness: 0.4 });
  for (const fx of [-ww / 2, -ww / 6, ww / 6, ww / 2]) boxAt(shell, 0.06, top - sill, 0.14, fx, sill, D / 2, frame);
  boxAt(shell, ww, 0.06, 0.14, 0, sill, D / 2, frame); boxAt(shell, ww, 0.06, 0.14, 0, top - 0.06, D / 2, frame);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(ww, top - sill), new THREE.MeshPhysicalMaterial({ color: 0xcfe6f5, transparent: true, opacity: 0.12, roughness: 0.05, metalness: 0, depthWrite: false }));
  glass.position.set(0, sill + (top - sill) / 2, D / 2 + 0.02); shell.add(glass);
  solids.push([-W / 2, D / 2 - 0.3, W / 2, D / 2 + 1]); // нельзя выйти в окно
  // мебель (демо)
  const red = M(0xd8452e, { roughness: 0.6 }), cream = M(0xece3d3), wood = M(0x8a5a36, { roughness: 0.5 }), dark = M(0x2a2a2e), green = M(0x4f8a3c, { flatShading: true });
  // диван у боковой стены + столик + ковёр
  const sx = -W / 2 + 0.55;
  boxAt(furn, 0.9, 0.42, 2.4, sx, 0, -0.6, cream, true, solids); boxAt(furn, 0.25, 0.8, 2.4, sx - 0.33, 0, -0.6, cream);
  const rug = new THREE.Mesh(new THREE.CircleGeometry(1.3, 40), M(0xe9d9c4)); rug.rotation.x = -Math.PI / 2; rug.position.set(sx + 1.6, 0.01, -0.6); furn.add(rug);
  const tbl = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.06, 32), wood); tbl.position.set(sx + 1.6, 0.42, -0.6); furn.add(tbl);
  boxAt(furn, 0.08, 0.4, 0.08, sx + 1.6, 0, -0.6, dark); solids.push([sx + 1.15, -1.05, sx + 2.05, -0.15]);
  // обеденный стол с красными стульями (как в ролике)
  const tx = W / 2 - 1.6, tz = -D / 2 + 1.6;
  boxAt(furn, 1.6, 0.05, 0.9, tx, 0.74, tz, wood, true, solids);
  for (const [lx, lz] of [[-0.7, -0.35], [0.7, -0.35], [-0.7, 0.35], [0.7, 0.35]]) boxAt(furn, 0.05, 0.74, 0.05, tx + lx, 0, tz + lz, dark);
  for (const [cx, cz] of [[-0.45, -0.75], [0.45, -0.75], [-0.45, 0.75], [0.45, 0.75]]) { boxAt(furn, 0.45, 0.45, 0.45, tx + cx, 0, tz + cz, red); boxAt(furn, 0.45, 0.45, 0.06, tx + cx, 0.45, tz + cz + (cz > 0 ? 0.2 : -0.2), red); }
  // подвесная лампа, стеллаж, растение, ТВ
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.22, 20, 14), new THREE.MeshStandardMaterial({ color: 0xfff3dd, emissive: 0xffe2b0, emissiveIntensity: 1.2 })); lamp.position.set(tx, 2.1, tz); furn.add(lamp);
  boxAt(furn, 0.01, H - 2.1, 0.01, tx, 2.1, tz, dark);
  boxAt(furn, 1.8, 2.0, 0.35, -W / 2 + 1.6, 0, -D / 2 + 0.25, wood, true, solids);
  for (let i = 0; i < 4; i++) boxAt(furn, 1.7, 0.03, 0.33, -W / 2 + 1.6, 0.45 + i * 0.45, -D / 2 + 0.27, cream);
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.17, 0.4, 16), M(0xe2e0db)); pot.position.set(W / 2 - 0.5, 0.2, D / 2 - 0.7); furn.add(pot);
  const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45, 0), green); leaves.position.set(W / 2 - 0.5, 0.9, D / 2 - 0.7); furn.add(leaves); solids.push([W / 2 - 0.8, D / 2 - 1, W / 2, D / 2 - 0.4]);
  boxAt(furn, 0.05, 0.7, 1.3, W / 2 - 0.1, 1.0, 0.2, dark);
  // свет в комнате
  const l1 = new THREE.PointLight(0xffe6c4, 6, 9, 1.6); l1.position.set(0, H - 0.3, -0.5); g.add(l1);
  const l2 = new THREE.PointLight(0xffe6c4, 3, 6, 1.6); l2.position.set(tx, 1.9, tz); g.add(l2);
  g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return { g, furn, solids, W, D, H };
}

// ============================================================
export class Walker {
  constructor(camera, dom, buildings, ui) {
    Object.assign(this, { camera, dom, ui });
    this.blocked = buildGrid(buildings);
    this.active = false; this.mode = null; this.pos = new THREE.Vector3(); this.yaw = 0; this.pitch = 0; this.vy = 0;
    this.keys = {}; this.stick = { x: 0, y: 0 }; this.bob = 0; this.room = null;
    addEventListener('keydown', (e) => { if (this.active && !/INPUT/.test(document.activeElement?.tagName)) this.keys[e.code] = true; });
    addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    // взгляд: перетаскивание мышью или пальцем (правая часть экрана на телефоне)
    let look = null;
    dom.addEventListener('pointerdown', (e) => { if (this.active) { look = { id: e.pointerId, x: e.clientX, y: e.clientY }; } });
    addEventListener('pointermove', (e) => {
      if (!look || e.pointerId !== look.id) return;
      this.yaw -= (e.clientX - look.x) * 0.004; this.pitch = THREE.MathUtils.clamp(this.pitch - (e.clientY - look.y) * 0.004, -1.3, 1.3);
      look.x = e.clientX; look.y = e.clientY;
    });
    addEventListener('pointerup', (e) => { if (look && e.pointerId === look.id) look = null; });
  }
  // Джойстик (DOM): база + ручка
  bindStick(base, knob) {
    let id = null, cx = 0, cy = 0; const R = 46;
    base.addEventListener('pointerdown', (e) => { e.stopPropagation(); id = e.pointerId; base.setPointerCapture(id); const r = base.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; move(e); });
    const move = (e) => { if (e.pointerId !== id) return; let dx = e.clientX - cx, dy = e.clientY - cy; const L = Math.hypot(dx, dy); if (L > R) { dx *= R / L; dy *= R / L; } knob.style.transform = `translate(${dx}px, ${dy}px)`; this.stick.x = dx / R; this.stick.y = dy / R; };
    base.addEventListener('pointermove', move);
    const end = (e) => { if (e.pointerId !== id) return; id = null; knob.style.transform = ''; this.stick.x = this.stick.y = 0; };
    base.addEventListener('pointerup', end); base.addEventListener('pointercancel', end);
  }

  // ---- Улица ----
  startStreet(x, z, yaw) {
    this.mode = 'street'; this.pos.set(x, elev(x, z) + EYE, z); this.yaw = yaw; this.pitch = 0.02; this.active = true;
  }
  // ---- Внутри здания ----
  // b — здание, floor — этаж; возвращает точки для «влёта» камеры
  enterBuilding(b, scene, floor) {
    // самая длинная стена — там ставим панорамное окно
    const ring = b.outer; let best = null;
    const sa = (() => { let a = 0; for (let i = 0; i < ring.length; i++) { const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % ring.length]; a += x1 * z2 - x2 * z1; } return a; })();
    for (let i = 0; i < ring.length; i++) { const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % ring.length]; const L = Math.hypot(x2 - x1, z2 - z1); if (!best || L > best.L) best = { L, x1, z1, x2, z2 }; }
    const { x1, z1, x2, z2, L } = best;
    let nx = (z2 - z1) / L, nz = -(x2 - x1) / L; if (sa < 0) { nx = -nx; nz = -nz; } // наружу
    const levels = Math.max(1, Math.round((b.h - b.mh) / 3.1)), fl = THREE.MathUtils.clamp(floor ?? Math.ceil(levels * 0.6), 1, levels);
    const floorH = (b.h - b.mh) / levels, fy = b.base + b.mh + (fl - 1) * floorH + 0.05;
    const W = THREE.MathUtils.clamp(L - 1.2, 3.5, 8), D = 6.5, H = Math.min(2.9, floorH - 0.15);
    const room = buildRoom(W, D, H);
    const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2;
    // центр комнаты — внутрь от стены на D/2
    const cx = mx - nx * (D / 2 + 0.15), cz = mz - nz * (D / 2 + 0.15), ry = Math.atan2(nx, nz);
    room.g.position.set(cx, fy, cz); room.g.rotation.y = ry; scene.add(room.g);
    this.room = { ...room, cx, cz, fy, ry, nx, nz, floor: fl, levels, building: b };
    // точки для «влёта»: снаружи напротив окна → внутрь комнаты
    const outside = new THREE.Vector3(mx + nx * 28, fy + 1.6 + 6, mz + nz * 28);
    const atWindow = new THREE.Vector3(mx + nx * 1.2, fy + 1.6, mz + nz * 1.2);
    const inside = new THREE.Vector3(cx - nx * 0.4, fy + EYE, cz - nz * 0.4);
    return { outside, atWindow, inside, lookIn: Math.atan2(-nx, -nz) + Math.PI, floor: fl, levels };
  }
  startInterior(insidePos, yaw) { this.mode = 'interior'; this.pos.copy(insidePos); this.yaw = yaw; this.pitch = -0.05; this.active = true; }
  leave(scene) { this.active = false; this.mode = null; if (this.room) { scene.remove(this.room.g); this.room = null; } }

  // Своя 3D-модель вместо демо-мебели
  async loadGLB(file) {
    const buf = await file.arrayBuffer();
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf, '', res, rej));
    const model = gltf.scene, r = this.room;
    const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
    const k = Math.min((r.W - 0.4) / Math.max(size.x, 0.01), (r.D - 0.4) / Math.max(size.z, 0.01), (r.H - 0.1) / Math.max(size.y, 0.01));
    model.scale.setScalar(k);
    const b2 = new THREE.Box3().setFromObject(model), c = b2.getCenter(new THREE.Vector3());
    model.position.set(-c.x, -b2.min.y, -c.z);
    r.furn.clear(); r.furn.add(model); r.solids.length = 1; // оставляем только «окно»
    return { name: file.name, scale: k };
  }

  update(dt) {
    if (!this.active) return;
    const k = this.keys;
    let f = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0) - this.stick.y;
    let s = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0) + this.stick.x;
    if (k.KeyQ) this.yaw += dt * 1.8; if (k.KeyE) this.yaw -= dt * 1.8;
    const mag = Math.min(1, Math.hypot(f, s));
    const speed = (this.mode === 'interior' ? 1.4 : (k.ShiftLeft || k.ShiftRight ? 7 : 2.4)) * mag;
    if (mag > 0.01) {
      const L = Math.hypot(f, s); f /= L; s /= L;
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw), rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
      const dx = (fx * f + rx * s) * speed * dt, dz = (fz * f + rz * s) * speed * dt;
      const tryMove = (nx, nz) => this.mode === 'interior' ? !this.roomBlocked(nx, nz) : !this.blocked(nx, nz);
      if (tryMove(this.pos.x + dx, this.pos.z + dz)) { this.pos.x += dx; this.pos.z += dz; }
      else if (tryMove(this.pos.x + dx, this.pos.z)) this.pos.x += dx;    // скользим вдоль стены
      else if (tryMove(this.pos.x, this.pos.z + dz)) this.pos.z += dz;
      this.bob += dt * speed * 3.2;
    }
    const groundY = this.mode === 'interior' ? this.room.fy + EYE : elev(this.pos.x, this.pos.z) + EYE;
    this.pos.y += (groundY - this.pos.y) * Math.min(1, dt * 12);
    this.camera.position.set(this.pos.x, this.pos.y + Math.sin(this.bob) * 0.03, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
  roomBlocked(x, z) {
    const r = this.room, dx = x - r.cx, dz = z - r.cz, c = Math.cos(-r.ry), s = Math.sin(-r.ry);
    const lx = dx * c + dz * s, lz = -dx * s + dz * c, pad = 0.3;
    if (Math.abs(lx) > r.W / 2 - pad || Math.abs(lz) > r.D / 2 - pad) return true;
    return r.solids.some(([x0, z0, x1, z1]) => lx > x0 - pad && lx < x1 + pad && lz > z0 - pad && lz < z1 + pad);
  }
}
