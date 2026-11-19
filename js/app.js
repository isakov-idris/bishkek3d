// ============================================================
//  app.js — «РЕЖИССЁР» (версия 3)
//  Связывает всё: сцену, поиск, маршруты, видео-режим,
//  день/ночь, подписи, карточки мест и нажатия.
// ============================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildCity, shared } from './city.js';
import { LANDMARKS, BUILDING_TYPES, toXZ } from './data.js';
import { Router, routeMesh, pinMesh, fmtDist, fmtTime } from './route.js';
import { Player, tourTrack, routeTrack, voice } from './player.js';
import { SearchIndex, QUICK, iconFor } from './search.js';
import { setTerrain, buildTerrain, elev, toLatLon } from './terrain.js';
import { Walker } from './walk.js';

const $ = (s) => document.querySelector(s);
const isMobile = matchMedia('(pointer: coarse)').matches;
const toast = (t, ms = 2200) => { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast.h); toast.h = setTimeout(() => el.classList.remove('show'), ms); };

// ========== 1. Сцена, камера, свет ==========
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.75 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
$('#stage').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 1, 90000);
camera.position.set(-2600, 2400, -4200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 200);
controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.47; controls.minDistance = 40; controls.maxDistance = 11000;
controls.screenSpacePanning = false; controls.zoomToCursor = true;

const skyU = { top: { value: new THREE.Color() }, bottom: { value: new THREE.Color() } };
scene.add(new THREE.Mesh(new THREE.SphereGeometry(80000, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false, uniforms: skyU,
  vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = clamp(normalize(vP).y * 2.5, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, pow(h, 0.7)), 1.0); }',
})));
scene.fog = new THREE.Fog(0xdfe8ef, 6000, 70000);
const hemi = new THREE.HemisphereLight(0xdfeaff, 0xcfc6b0, 1.1); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
sun.castShadow = true; sun.shadow.mapSize.set(isMobile ? 2048 : 4096, isMobile ? 2048 : 4096);
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6; scene.add(sun, sun.target);
const SUN_DIR = new THREE.Vector3(-0.55, 0.7, 0.45).normalize();

// ========== 2. Загрузка данных и постройка города ==========
$('#loader-text').textContent = 'Загружаем данные города…';
const [D, S, TR] = await Promise.all([fetch('./data/city.json').then(r => r.json()), fetch('./data/search.json').then(r => r.json()).catch(() => ({ items: [] })), fetch('./data/terrain.json').then(r => r.json())]);
setTerrain(TR);
$('#loader-text').textContent = 'Строим Бишкек…';
await new Promise(r => setTimeout(r, 30));
const t0 = performance.now();
const terrain = buildTerrain(scene);
const world = buildCity(scene, D);
const router = new Router(D);
const walker = new Walker(camera, renderer.domElement, world.buildings);
walker.bindStick($('#stick'), $('#knob'));
const LM = LANDMARKS.map(l => ({ ...l, ...toXZ(l.lat, l.lon) }));
const index = new SearchIndex(S.items, LM);
console.log(`[app] город построен за ${Math.round(performance.now() - t0)} мс, записей поиска: ${index.items.length}`);
$('#stats').textContent = `${world.stats.houses.toLocaleString('ru')} зданий, ${index.items.filter(i => i.k === 1).length.toLocaleString('ru')} мест, ${world.stats.trees.toLocaleString('ru')} деревьев`;
voice.init();

function updateSun() {
  const d = camera.position.distanceTo(controls.target), half = THREE.MathUtils.clamp(d * 0.75, 250, 3200), c = sun.shadow.camera;
  if (Math.abs(c.right - half) > half * 0.15) { c.left = -half; c.right = half; c.top = half; c.bottom = -half; c.near = 10; c.far = 9000; c.updateProjectionMatrix(); }
  sun.target.position.copy(controls.target); sun.position.copy(controls.target).addScaledVector(SUN_DIR, 4000);
}

// ========== 3. День и ночь ==========
const DAY = { skyTop: 0x7fb4e6, skyBot: 0xeaf1f5, fog: 0xe2eaf0, hemiS: 0xdfeaff, hemiG: 0xcfc6b0, hemiI: 1.1, sunC: 0xfff1dc, sunI: 2.4, exp: 1.05 };
const NIGHT = { skyTop: 0x050a1a, skyBot: 0x1c2846, fog: 0x141c30, hemiS: 0x3a4f80, hemiG: 0x1a1a22, hemiI: 0.35, sunC: 0x9fb4ff, sunI: 0.25, exp: 1.25 };
let night = 0, nightTarget = 0;
const lc = (a, b, t) => new THREE.Color(a).lerp(new THREE.Color(b), t), lf = THREE.MathUtils.lerp;
function applyTime(t) {
  skyU.top.value.copy(lc(DAY.skyTop, NIGHT.skyTop, t)); skyU.bottom.value.copy(lc(DAY.skyBot, NIGHT.skyBot, t));
  scene.fog.color.copy(lc(DAY.fog, NIGHT.fog, t));
  hemi.color.copy(lc(DAY.hemiS, NIGHT.hemiS, t)); hemi.groundColor.copy(lc(DAY.hemiG, NIGHT.hemiG, t)); hemi.intensity = lf(DAY.hemiI, NIGHT.hemiI, t);
  sun.color.copy(lc(DAY.sunC, NIGHT.sunC, t)); sun.intensity = lf(DAY.sunI, NIGHT.sunI, t);
  renderer.toneMappingExposure = lf(DAY.exp, NIGHT.exp, t);
  shared.uNight.value = t; world.lampsPts.material.opacity = t;
  document.body.classList.toggle('is-night', t > 0.5);
}
applyTime(0);

// ========== 4. Подписи над 3D ==========
const labels = [];
function addLabel(html, pos, cls, maxDist, onClick) {
  const el = document.createElement('div'); el.className = 'label ' + cls; el.innerHTML = html;
  if (onClick) el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  $('#labels').appendChild(el);
  const L = { el, pos, maxDist }; labels.push(L); return L;
}
function removeLabel(L) { const i = labels.indexOf(L); if (i >= 0) labels.splice(i, 1); L.el.remove(); }
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SMALL = { manas: 700, flag: 600, square: 2400, museum: 1800, wheel: 2400, tsum: 2600, meria: 2600 };
const lmLabel = {};
for (const l of LM) lmLabel[l.id] = addLabel(esc(l.name), world.landmarkTops[l.id], 'lm', SMALL[l.id] || 5200, () => openLandmark(l.id)).el;
for (const [ni, x, z] of D.labels) addLabel(esc(D.names[ni]), new THREE.Vector3(x * 0.1, 2 + elev(x * 0.1, z * 0.1), z * 0.1), 'st', 1300);
const v3 = new THREE.Vector3();
function updateLabels() {
  const W = innerWidth, H = innerHeight;
  for (const L of labels) {
    v3.copy(L.pos).project(camera);
    const d = camera.position.distanceTo(L.pos);
    const show = v3.z < 1 && Math.abs(v3.x) < 1.1 && Math.abs(v3.y) < 1.1 && d < L.maxDist;
    if (!show) { if (L.vis !== false) { L.el.style.display = 'none'; L.vis = false; } continue; }
    if (L.vis !== true) { L.el.style.display = ''; L.vis = true; }
    L.el.style.transform = `translate(${((v3.x + 1) / 2 * W).toFixed(1)}px, ${((1 - v3.y) / 2 * H).toFixed(1)}px) translate(-50%, -100%)`;
    L.el.style.opacity = d > L.maxDist * 0.75 ? ((L.maxDist - d) / (L.maxDist * 0.25)).toFixed(2) : '';
  }
}

// ========== 5. Плавный перелёт камеры ==========
let fly = null;
function flyTo(target, dist, polar = 1.0, duration = 1500, theta = null) {
  target = target.clone(); target.y = elev(target.x, target.z);
  const sph = new THREE.Spherical().setFromVector3(new THREE.Vector3().subVectors(camera.position, controls.target));
  fly = { t0: performance.now(), duration, fromT: controls.target.clone(), toT: target.clone(), fromS: sph, toS: new THREE.Spherical(dist, polar, theta ?? sph.theta) };
}
function stepFly(now) {
  if (!fly) return;
  const k = Math.min(1, (now - fly.t0) / fly.duration), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  controls.target.lerpVectors(fly.fromT, fly.toT, e);
  let dth = fly.toS.theta - fly.fromS.theta; dth = Math.atan2(Math.sin(dth), Math.cos(dth));
  const s = new THREE.Spherical(lf(fly.fromS.radius, fly.toS.radius, e), lf(fly.fromS.phi, fly.toS.phi, e), fly.fromS.theta + dth * e);
  camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(s));
  if (k >= 1) fly = null;
}

// ========== 6. Карточка места ==========
// place = { title, tag, text, x, z, landmark?, building? }
let current = null, activeLm = null;
const pin = pinMesh(0xe8112d); pin.visible = false; scene.add(pin);
function openPlace(place, doFly = true, dist = 260) {
  closeSheets();
  current = place;
  if (activeLm) { lmLabel[activeLm]?.classList.remove('active'); activeLm = null; }
  if (place.landmark) { activeLm = place.landmark; lmLabel[activeLm]?.classList.add('active'); }
  $('#card-tag').textContent = place.tag; $('#card-title').textContent = place.title; $('#card-text').textContent = place.text || '';
  $('#card-pass').innerHTML = place.building ? passport(place.building) : '';
  $('#act-enter').classList.toggle('hidden', !place.building || place.building.h < 5);
  $('#card').classList.add('open');
  world.highlight(place.building || null);
  pin.visible = !place.landmark; pin.position.set(place.x, (place.building ? place.building.base + place.building.h : elev(place.x, place.z)) + 1, place.z);
  if (doFly) flyTo(new THREE.Vector3(place.x, 0, place.z), dist, 0.95);
}
function closeCard() {
  $('#card').classList.remove('open'); world.highlight(null); pin.visible = false;
  if (activeLm) { lmLabel[activeLm]?.classList.remove('active'); activeLm = null; }
  current = null;
}
function openLandmark(id, doFly = true) {
  const l = LM.find(x => x.id === id); if (!l) return;
  openPlace({ title: l.name, tag: 'Достопримечательность', text: l.desc, x: l.x, z: l.z, landmark: id, building: world.landmarkBuilding[id] }, doFly, l.view || 300);
}
const plural = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11) ? a : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) ? b : c;
function buildingText(b) {
  const fl = b.meta && b.meta[4] ? +b.meta[4] : Math.max(1, Math.round((b.h - b.mh) / 3.1));
  return `${fl} ${plural(fl, 'этаж', 'этажа', 'этажей')} · ~${Math.round(b.h)} м`;
}
// ---------- Паспорт здания (по ТЗ: ID, координаты, высота и её статус, источник, дата) ----------
const ROOF = { flat: 'плоская', gabled: 'двускатная', hipped: 'вальмовая', pyramidal: 'пирамидальная', dome: 'купол', skillion: 'односкатная', round: 'сводчатая', onion: 'луковичная', mansard: 'мансардная', 'half-hipped': 'полувальмовая' };
const MAT = { brick: 'кирпич', concrete: 'бетон', panel: 'панели', plaster: 'штукатурка', glass: 'стекло', wood: 'дерево', stone: 'камень', metal: 'металл', block: 'блоки', marble: 'мрамор' };
const HSTAT = {
  1: ['Получена из источника', 'указана в OSM (тег height)', 'высокая'],
  2: ['Расчётная', 'этажность из OSM × 3,1 м', 'средняя'],
  0: ['Расчётная (оценка)', 'этажности в OSM нет — оценено по типу и площади', 'низкая'],
};
function passport(b) {
  const m = b.meta || ['', -1, -1, b.known ? 2 : 0, ''];
  const [st, how, conf] = HSTAT[m[3]] || HSTAT[0];
  const { lat, lon } = toLatLon(b.cx, b.cz);
  const addr = index.items.find(it => it.k === 2 && Math.hypot(it.x - b.cx, it.z - b.cz) < 3);
  const id = m[0], osmUrl = id ? `https://www.openstreetmap.org/${{ w: 'way', r: 'relation', n: 'node' }[id[0]]}/${id.slice(1)}` : '';
  const roof = m[1] >= 0 ? (ROOF[D.names[m[1]]] || D.names[m[1]]) : 'нет данных';
  const mat = m[2] >= 0 ? (MAT[D.names[m[2]]] || D.names[m[2]]) : 'нет данных';
  const fl = m[4] ? m[4] : 'неизвестна';
  const date = (D.osmTime || '').slice(0, 10).split('-').reverse().join('.');
  const row = (k, v) => `<div class="k">${k}</div><div class="v">${v}</div>`;
  return `<div class="pp">` +
    (addr ? row('Адрес', esc(addr.t)) : '') +
    row('Тип', esc(BUILDING_TYPES[b.code] || 'Здание')) +
    row('Этажность', esc(String(fl))) +
    row('Высота', `~${Math.round(b.h)} м · <b class="st st${m[3]}">${st}</b><br><small>${how}</small>`) +
    row('Достоверность', conf) +
    row('Крыша', esc(roof)) + row('Материал', esc(mat)) +
    row('Над уровнем моря', `${Math.round(b.base + TR.base)} м <small>(Copernicus DEM)</small>`) +
    row('Координаты', `${lat.toFixed(5)}, ${lon.toFixed(5)}`) +
    row('ID', id ? `<a href="${osmUrl}" target="_blank" rel="noopener">OSM ${id[0] === 'w' ? 'way' : 'relation'} ${id.slice(1)}</a>` : '—') +
    row('Источник', `OpenStreetMap, данные на ${date}`) +
    `</div>`;
}
function openBuilding(b, doFly = false) {
  if (b.landmark) return openLandmark(b.landmark, doFly);
  const near = index.items.find(it => it.k === 2 && Math.hypot(it.x - b.cx, it.z - b.cz) < 3);
  const type = BUILDING_TYPES[b.code] || 'Здание';
  openPlace({ title: b.nameText || (near ? near.t : type), tag: type, text: buildingText(b), x: b.cx, z: b.cz, building: b }, doFly, 220);
}
function openSearchItem(it) {
  if (it.k === 0) return openLandmark(it.id);
  const b = it.k === 3 ? null : world.buildingNear(it.x, it.z, it.k === 1 ? 18 : 6);
  const tag = { 1: (it.sub || '').split(' · ')[0] || 'Место', 2: 'Адрес', 3: 'Улица', 4: 'Здание' }[it.k];
  let text = it.k === 1 ? (it.sub || '').split(' · ').slice(1).join(' · ') : (it.sub || '');
  openPlace({ title: it.t, tag, text, x: it.x, z: it.z, building: b }, true, it.k === 3 ? 600 : 240);
}
$('#card-close').onclick = closeCard;
$('#act-say').onclick = () => current && voice.say(current.title + '. ' + (current.text || ''));
$('#act-walk').onclick = () => { const p = current; closeCard(); startWalk(p); };
$('#act-enter').onclick = () => { const p = current; if (p?.building) { closeCard(); enterBuilding(p.building); } };

// ========== Прогулка и «войти в здание» ==========
// Плавное движение камеры по точкам (для влёта в окно)
let camAnim = null;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
function lookQuat(from, to) { _m.lookAt(from, to, new THREE.Vector3(0, 1, 0)); return new THREE.Quaternion().setFromRotationMatrix(_m); }
function animateCamera(steps, onDone) { // steps: [{pos, look | quat, ms}]
  camAnim = { steps, i: 0, t0: performance.now(), fromPos: camera.position.clone(), fromQ: camera.quaternion.clone(), onDone };
}
function stepCamAnim(now) {
  const a = camAnim, s = a.steps[a.i];
  const toQ = s.quat || lookQuat(s.pos, s.look);
  const k = Math.min(1, (now - a.t0) / s.ms), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
  camera.position.lerpVectors(a.fromPos, s.pos, e);
  camera.quaternion.slerpQuaternions(a.fromQ, toQ, e);
  if (k >= 1) { a.i++; a.fromPos = s.pos.clone(); a.fromQ = toQ.clone(); a.t0 = now; if (a.i >= a.steps.length) { camAnim = null; a.onDone?.(); } }
}
const yawQuat = (yaw, pitch = 0) => new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
function walkUI(on, title = '', sub = '', interior = false) {
  document.body.classList.toggle('walking', on);
  document.body.classList.toggle('interior', interior);
  $('#walk-title').textContent = title; $('#walk-sub').textContent = sub;
  controls.enabled = !on;
  // угол обзора как у человека: шире на вертикальном экране телефона
  camera.fov = on ? (innerWidth < innerHeight ? 80 : 65) : 45; camera.updateProjectionMatrix();
}
function startWalk(p) {
  const n = router.nearest(p.x, p.z, 'walk'); const x = n >= 0 ? router.X[n] : p.x, z = n >= 0 ? router.Z[n] : p.z;
  const yaw = Math.atan2(-(p.x - x), -(p.z - z)) || 0;
  fly = null; closeSheets();
  animateCamera([{ pos: new THREE.Vector3(x, elev(x, z) + 60, z + 0.01), look: new THREE.Vector3(x, elev(x, z), z - 1), ms: 1300 }, { pos: new THREE.Vector3(x, elev(x, z) + 1.7, z), quat: yawQuat(yaw, 0.02), ms: 1300 }], () => {
    walker.startStreet(x, z, yaw);
    walkUI(true, '🚶 Прогулка', isMobile ? 'Джойстик — идти, палец справа — смотреть' : 'WASD — идти, мышь — смотреть, Shift — бегом');
  });
}
function enterBuilding(b) {
  fly = null; closeSheets();
  const pts = walker.enterBuilding(b, scene);
  const winQ = lookQuat(pts.outside, pts.atWindow);
  animateCamera([
    { pos: pts.outside, look: pts.atWindow, ms: 1800 },
    { pos: pts.atWindow, quat: winQ, ms: 1300 },
    { pos: pts.inside, quat: yawQuat(pts.lookIn, -0.05), ms: 1100 },
  ], () => {
    walker.startInterior(pts.inside, pts.lookIn);
    walkUI(true, `🏢 Этаж ${pts.floor} из ${pts.levels} · демо-интерьер`, 'Реальная планировка неизвестна. За окном — настоящий 3D-город. Можно загрузить свою модель (.glb)', true);
  });
}
function exitWalk() {
  const p = camera.position.clone(), f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion); f.y = 0; f.normalize();
  const inside = walker.mode === 'interior', b = walker.room?.building;
  walker.leave(scene); walkUI(false);
  const tgt = inside ? new THREE.Vector3(b.cx, 0, b.cz) : p.clone().addScaledVector(f, 40);
  tgt.y = elev(tgt.x, tgt.z); controls.target.copy(tgt);
  if (inside) camera.position.copy(p).addScaledVector(f, -2);
  flyTo(tgt, inside ? 260 : 220, 1.0, 1500);
}
$('#walk-exit').onclick = exitWalk;
$('#walk-window').onclick = () => { if (walker.mode === 'interior') { walker.yaw = Math.atan2(-walker.room.nx, -walker.room.nz); walker.pitch = -0.08; } };
$('#walk-glb').onclick = () => $('#glb-file').click();
$('#glb-file').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { const r = await walker.loadGLB(f); $('#walk-title').textContent = `🏢 Этаж ${walker.room.floor} · ваша модель`; $('#walk-sub').textContent = `${r.name} — подогнана под размер комнаты`; toast('Модель загружена'); }
  catch (err) { console.error(err); toast('Не удалось открыть файл. Нужен .glb (glTF binary)'); }
  e.target.value = '';
};

// ========== 7. Поиск ==========
let pickSlot = null;           // 'from' | 'to' — выбираем точку для маршрута
let mapPick = null;            // ждём нажатия на карту
let catPins = [];
const q = $('#q');
function setSearching(on, slot = null) {
  pickSlot = slot;
  document.body.classList.toggle('searching', on);
  $('#pickmap').classList.toggle('hidden', !slot);
  if (on) {
    if (slot) { $('#searchbar').style.display = 'flex'; document.body.classList.remove('routing'); q.placeholder = slot === 'from' ? 'Откуда? Место или адрес' : 'Куда? Место или адрес'; }
    else q.placeholder = 'Поиск мест и адресов';
    q.value = ''; renderResults(); setTimeout(() => q.focus(), 50);
  } else {
    q.blur(); $('#searchbar').style.display = '';
    if (route.active) document.body.classList.add('routing');
  }
}
q.addEventListener('focus', () => { if (!document.body.classList.contains('searching')) setSearching(true, pickSlot); });
q.addEventListener('input', () => { $('#clear').classList.toggle('hidden', !q.value); renderResults(); });
q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = $('#results .res'); first?.click(); } });
$('#clear').onclick = () => { q.value = ''; $('#clear').classList.add('hidden'); renderResults(); q.focus(); };
$('#back').onclick = () => setSearching(false);
$('#chips').innerHTML = QUICK.map(([ic, name]) => `<button class="chip" data-c="${name}">${ic} ${name}</button>`).join('');
$('#chips').onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; q.value = c.dataset.c; renderResults(c.dataset.c); };
function renderResults(cat) {
  const box = $('#results'), qq = q.value.trim();
  let list, head = '';
  if (cat) { list = index.category(cat); head = `${list.length ? 'Найдено: ' + list.length : ''}`; }
  else if (qq) list = index.find(qq, 14);
  else { list = LM.filter(l => l.id !== 'flag').map(l => index.items.find(i => i.k === 0 && i.id === l.id)); head = 'Популярное'; }
  if (!list.length) { box.innerHTML = `<div class="empty">Ничего не нашлось. Попробуй название, адрес («Чуй 166») или категорию.</div>`; return; }
  box.innerHTML = (head ? `<div class="hdr">${head}</div>` : '') + list.map((it, i) => `<button class="res" data-i="${i}"><span class="ic">${iconFor(it)}</span><div><b>${esc(it.t)}</b><span>${esc(it.sub || '')}</span></div></button>`).join('');
  box.querySelectorAll('.res').forEach(btn => btn.onclick = () => chooseResult(list[+btn.dataset.i], cat ? list : null));
}
function chooseResult(it, catList) {
  const slot = pickSlot;
  setSearching(false);
  if (slot) return setRoutePoint(slot, { title: it.t, x: it.x, z: it.z });
  clearCatPins();
  if (catList) showCatPins(catList);
  openSearchItem(it);
}
function clearCatPins() { catPins.forEach(removeLabel); catPins = []; }
function showCatPins(list) {
  for (const it of list) catPins.push(addLabel(`<i>${iconFor(it)}</i>`, new THREE.Vector3(it.x, 6 + elev(it.x, it.z), it.z), 'poi', 3500, () => openSearchItem(it)));
}
$('#pickmap').onclick = () => { mapPick = pickSlot; setSearching(false); document.body.classList.remove('routing'); toast('Нажми на карту, чтобы выбрать точку', 3500); };

// ========== 8. Маршруты ==========
const route = { active: false, from: null, to: null, mode: 'walk', result: null, mesh: null };
const pinA = pinMesh(0x18a957), pinB = pinMesh(0xe8112d); pinA.visible = pinB.visible = false; scene.add(pinA, pinB);
function openRoute() { route.active = true; closeSheets(); closeCard(); document.body.classList.add('routing'); refreshRouteUI(); }
function closeRoute() {
  route.active = false; document.body.classList.remove('routing'); $('#route-sheet').classList.remove('open');
  if (route.mesh) { scene.remove(route.mesh); route.mesh = null; } pinA.visible = pinB.visible = false; route.result = null; route.from = route.to = null;
}
function refreshRouteUI() {
  const f = $('#r-from'), t = $('#r-to');
  f.textContent = route.from ? route.from.title : 'Откуда?'; f.classList.toggle('ph', !route.from);
  t.textContent = route.to ? route.to.title : 'Куда?'; t.classList.toggle('ph', !route.to);
  document.querySelectorAll('.mode').forEach(m => m.classList.toggle('on', m.dataset.m === route.mode));
}
function setRoutePoint(slot, p) { route[slot] = p; if (!route.active) openRoute(); route.active = true; document.body.classList.add('routing'); refreshRouteUI(); computeRoute(); }
function computeRoute() {
  pinA.visible = !!route.from; if (route.from) pinA.position.set(route.from.x, 0.5 + elev(route.from.x, route.from.z), route.from.z);
  pinB.visible = !!route.to; if (route.to) pinB.position.set(route.to.x, 0.5 + elev(route.to.x, route.to.z), route.to.z);
  if (route.mesh) { scene.remove(route.mesh); route.mesh = null; }
  if (!route.from || !route.to) { $('#route-sheet').classList.remove('open'); if (route.from || route.to) { const p = route.from || route.to; flyTo(new THREE.Vector3(p.x, 0, p.z), 500, 0.9); } return; }
  const t = performance.now();
  const r = router.find(route.from, route.to, route.mode);
  console.log(`[route] ${route.mode}: ${r ? Math.round(r.length) + ' м' : 'нет пути'} за ${Math.round(performance.now() - t)} мс`);
  if (!r) { toast('Не удалось проложить маршрут'); return; }
  route.result = r;
  route.mesh = routeMesh(r.pts, r.mode); scene.add(route.mesh);
  $('#rtime').textContent = fmtTime(r.time); $('#rdist').textContent = fmtDist(r.length) + (r.mode === 'car' ? ' · на машине' : ' · пешком');
  $('#rnote').textContent = r.mode === 'car' ? 'Время примерное, без учёта пробок и светофоров.' : 'Пешком по улицам, тротуарам и дорожкам.';
  $('#steps').innerHTML = r.steps.map((s, i) => `<li data-i="${i}"><span class="n">${i + 1}</span><div>${esc(s.action)}${s.name ? ' — ' + esc(s.name) : ''}${s.len ? `<small>${fmtDist(s.len)}</small>` : ''}</div></li>`).join('');
  $('#steps').querySelectorAll('li').forEach(li => li.onclick = () => { const s = r.steps[+li.dataset.i]; const p = s.x !== null ? s : { x: route.to.x, z: route.to.z }; flyTo(new THREE.Vector3(p.x, 0, p.z), 220, 0.9); });
  $('#route-sheet').classList.add('open');
  // показываем весь маршрут
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (const [x, z] of r.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  flyTo(new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2 + 60), Math.max(400, Math.hypot(x1 - x0, z1 - z0) * 1.35), 0.85);
}
$('#r-from').onclick = () => setSearching(true, 'from');
$('#r-to').onclick = () => setSearching(true, 'to');
$('#r-close').onclick = closeRoute;
$('#r-swap').onclick = () => { [route.from, route.to] = [route.to, route.from]; refreshRouteUI(); computeRoute(); };
document.querySelectorAll('.mode').forEach(m => m.onclick = () => { route.mode = m.dataset.m; refreshRouteUI(); computeRoute(); });
$('#act-to').onclick = () => { const p = current; closeCard(); setRoutePoint('to', { title: p.title, x: p.x, z: p.z }); if (!route.from) setTimeout(() => toast('Теперь выбери, откуда идём'), 300); };
$('#act-from').onclick = () => { const p = current; closeCard(); setRoutePoint('from', { title: p.title, x: p.x, z: p.z }); };
$('#rs-close').onclick = () => $('#route-sheet').classList.remove('open');
$('#r-voice').onclick = () => { const r = route.result; if (r) voice.say(`${fmtTime(r.time)}, ${fmtDist(r.length)}. ` + r.steps.slice(0, 6).map(s => s.action + (s.name ? ', ' + s.name : '')).join('. ')); };
$('#r-video').onclick = () => { if (route.result) startVideo(routeTrack(route.result), 'Облёт маршрута'); };

// ========== 9. Видео-режим ==========
const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
let videoKind = '';
const player = new Player(camera, controls, {
  onLoad(track) {
    const sc = $('#scrub'); sc.querySelectorAll('.tick').forEach(t => t.remove());
    for (const c of track.chapters) { const t = document.createElement('div'); t.className = 'tick'; t.style.left = (c.t / track.duration * 100) + '%'; sc.appendChild(t); }
  },
  onState(p) { $('#pp').textContent = p ? '❚❚' : '▶'; },
  onTime(t, d) { $('#ptime').textContent = `${fmtT(t)} / ${fmtT(d)}`; const k = (t / d * 100) + '%'; $('#scrub .fill').style.width = k; $('#scrub .knob').style.left = k; },
  onChapter(c, i) {
    const vt = $('#vtitle'); vt.style.opacity = 0;
    setTimeout(() => { $('#vk').textContent = videoKind + (player.track.kind === 'tour' ? ` · ${i + 1} из ${player.track.chapters.length}` : ''); $('#vh').textContent = c.title; $('#vp').textContent = c.sub || ''; vt.style.opacity = 1; }, 250);
  },
  onEnd() { $('#vh').textContent = 'Конец'; $('#vp').textContent = 'Нажми ▶, чтобы посмотреть ещё раз, или ✕, чтобы вернуться к карте.'; },
});
function startVideo(track, kind) {
  videoKind = kind; closeSheets(); closeCard(); fly = null;
  document.body.classList.add('video');
  player.load(track); player.play();
}
function stopVideo() { player.pause(); document.body.classList.remove('video'); if (route.result) $('#route-sheet').classList.add('open'); }
function tour() {
  const order = ['osh', 'meria', 'phil', 'bpark', 'stadium', 'wheel', 'white', 'square', 'manas', 'museum', 'opera', 'tsum', 'victory'];
  const stops = order.map(id => LM.find(l => l.id === id)).filter(Boolean).map(l => ({
    target: new THREE.Vector3(l.x, elev(l.x, l.z) + (world.landmarkBuilding[l.id]?.h || 10) * 0.35, l.z), dist: (l.view || 300) * 1.05,
    title: l.name, sub: l.desc.split('. ')[0].replace(/\.$/, '') + '.', say: l.name + '. ' + l.desc,
  }));
  return tourTrack(stops);
}
$('#btn-video').onclick = () => startVideo(tour(), 'Тур по Бишкеку');
$('#pp').onclick = () => player.toggle();
$('#pclose').onclick = stopVideo;
$('#prate').onclick = () => { player.rate = player.rate === 1 ? 2 : player.rate === 2 ? 0.5 : 1; $('#prate').textContent = player.rate === 0.5 ? '½×' : player.rate + '×'; };
$('#pvoice').onclick = () => { voice.on = !voice.on; if (!voice.on) voice.stop(); $('#pvoice').textContent = voice.on ? '🔊' : '🔇'; };
// перемотка пальцем по полосе
const scrub = $('#scrub');
const seekFromEvent = (e) => { const r = scrub.getBoundingClientRect(); const k = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); player.seek(k * player.track.duration); };
scrub.addEventListener('pointerdown', (e) => { scrub.setPointerCapture(e.pointerId); scrub.dragging = player.playing; player.pause(); seekFromEvent(e); });
scrub.addEventListener('pointermove', (e) => { if (scrub.hasPointerCapture(e.pointerId)) seekFromEvent(e); });
scrub.addEventListener('pointerup', () => { if (scrub.dragging) player.play(); });

// ========== 10. Нажатия по карте ==========
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2(), ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, t: performance.now() }; fly = null;
  if (player.playing) { player.pause(); toast('Пауза — можно осмотреться. ▶ — продолжить', 2500); }
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || performance.now() - down.t > 500) return;
  if (document.body.classList.contains('video') || walker.active || camAnim) return;
  mouse.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  if (mapPick) { // выбор точки маршрута на карте
    const gh = ray.intersectObjects([terrain.city, terrain.region], false)[0]; if (!gh) return; const p = gh.point;
    const b = world.buildingNear(p.x, p.z, 25);
    const near = index.items.find(it => it.k === 2 && b && Math.hypot(it.x - b.cx, it.z - b.cz) < 3);
    setRoutePoint(mapPick, { title: near ? near.t : (b?.nameText || 'Точка на карте'), x: p.x, z: p.z });
    mapPick = null; return;
  }
  if (document.body.classList.contains('searching')) return setSearching(false);
  const hit = ray.intersectObjects([world.decor, world.housesMesh], true)[0];
  if (hit && hit.object.userData.landmark) return openLandmark(hit.object.userData.landmark, false);
  if (hit && hit.object === world.housesMesh) return openBuilding(world.buildingAtFace(hit.faceIndex));
  closeCard();
});

// ========== 11. Кнопки ==========
function closeSheets() { $('#places-sheet').classList.remove('open'); $('#layers-sheet')?.classList.remove('open'); }
const HOME = () => flyTo(new THREE.Vector3(0, 0, 700), 2900, 1.27, 1800);
$('#btn-home').onclick = () => { closeCard(); HOME(); };
// ---------- Слои ----------
const layers = { base: 'schema', time: 'day', trees: 'on', shadows: isMobile ? 'on' : 'on' };
function applyLayers() {
  terrain.setMode(layers.base); world.flatGroup.visible = layers.base === 'schema';
  nightTarget = layers.time === 'night' ? 1 : 0;
  world.treesMesh.visible = layers.trees === 'on';
  renderer.shadowMap.enabled = layers.shadows === 'on'; sun.castShadow = layers.shadows === 'on';
  scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
  $('#attr-sat').classList.toggle('hidden', layers.base !== 'sat');
  document.querySelectorAll('#layers-sheet .seg button').forEach(b => b.classList.toggle('on', layers[b.parentElement.dataset.k] === b.dataset.v));
}
$('#btn-time').onclick = () => { closeCard(); $('#layers-sheet').classList.toggle('open'); };
$('#layers-close').onclick = () => $('#layers-sheet').classList.remove('open');
document.querySelectorAll('#layers-sheet .seg button').forEach(b => b.onclick = () => { layers[b.parentElement.dataset.k] = b.dataset.v; applyLayers(); });
applyLayers();
$('#btn-places').onclick = () => { closeCard(); $('#places-sheet').classList.toggle('open'); };
$('#places-close').onclick = closeSheets;
$('#btn-route').onclick = () => route.active ? closeRoute() : (openRoute(), toast('Выбери «Откуда» и «Куда» — или нажми «Маршрут сюда» в карточке места', 3500));
$('#btn-about').onclick = () => $('#about').classList.add('open');
$('#about-close').onclick = () => $('#about').classList.remove('open');
$('#places').innerHTML = LM.filter(l => l.id !== 'flag').map(l => `<button class="place" data-id="${l.id}">${esc(l.name)}</button>`).join('');
$('#places').onclick = (e) => { const b = e.target.closest('.place'); if (b) openLandmark(b.dataset.id); };
$('#compass').onclick = () => { const s = new THREE.Spherical().setFromVector3(new THREE.Vector3().subVectors(camera.position, controls.target)); flyTo(controls.target.clone(), s.radius, s.phi, 900, 0); };
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ========== 12. Главный цикл ==========
const flagObj = world.decor.children.find(g => g.userData.flag)?.userData.flag;
const flagBase = flagObj ? flagObj.geometry.attributes.position.array.slice() : null;
const wheel = world.decor.children.find(g => g.userData.spin)?.userData.spin;
const flame = world.decor.children.find(g => g.userData.flame)?.userData.flame;
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (camAnim) stepCamAnim(now);
  else if (walker.active) walker.update(dt);
  else if (!player.update(dt)) { stepFly(now); if (!fly) controls.target.y += (elev(controls.target.x, controls.target.z) - controls.target.y) * 0.2; controls.update(); }
  if (Math.abs(night - nightTarget) > 0.001) { night += (nightTarget - night) * 0.05; applyTime(night); }
  if (flagObj) { const p = flagObj.geometry.attributes.position; for (let i = 0; i < p.count; i++) { const x = flagBase[i * 3] + 7.5; p.array[i * 3 + 2] = Math.sin(x * 0.55 - now * 0.004) * 0.12 * x; } p.needsUpdate = true; }
  if (wheel) wheel.rotation.z = now * 0.00012;
  if (flame) flame.scale.set(1, 1 + Math.sin(now * 0.02) * 0.15, 1);
  const bob = Math.sin(now * 0.004) * 1.5; pin.children[0].position.y = 22 + bob; pinA.rotation.y = pinB.rotation.y = now * 0.001;
  $('#compass-needle').style.transform = `rotate(${Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z)}rad)`;
  updateSun(); renderer.render(scene, camera); updateLabels();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
setTimeout(() => { $('#loader').classList.add('hide'); flyTo(new THREE.Vector3(0, 0, 700), 2900, 1.27, 3400); }, 250);
window.__bishkek = { camera, controls, walker, startWalk, enterBuilding, exitWalk, world, openLandmark, flyTo, router, index, route, setRoutePoint, startVideo, tour, player, setNight: (v) => { nightTarget = v; night = v; applyTime(v); } };
