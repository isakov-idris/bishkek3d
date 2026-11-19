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
import { Atmosphere, sunEvents } from './atmosphere.js';
import { Traffic, buildClouds, lifeShared } from './life.js';

const $ = (s) => document.querySelector(s);
const isMobile = matchMedia('(pointer: coarse)').matches;
const toast = (t, ms = 2200) => { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast.h); toast.h = setTimeout(() => el.classList.remove('show'), ms); };

// ========== 1. Сцена, камера, свет ==========
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.75 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping; // сохраняет насыщенность цветов renderer.toneMappingExposure = 1.05;
$('#stage').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 1, 90000);
camera.position.set(-2600, 2400, -4200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 200);
controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.47; controls.minDistance = 40; controls.maxDistance = 11000;
controls.screenSpacePanning = false; controls.zoomToCursor = true;

// Небо, солнце по реальному времени Бишкека, дымка, отражения (atmosphere.js)
const atmo = new Atmosphere(scene, renderer);
const sun = atmo.sun;
sun.shadow.mapSize.set(isMobile ? 2048 : 4096, isMobile ? 2048 : 4096);
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6;

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
const traffic = new Traffic(router, isMobile ? 380 : 900); scene.add(traffic.group);   // машины
const clouds = buildClouds(); scene.add(clouds.group);                                // облака
walker.bindStick($('#stick'), $('#knob'));
const LM = LANDMARKS.map(l => ({ ...l, ...toXZ(l.lat, l.lon) }));
const index = new SearchIndex(S.items, LM);
console.log(`[app] город построен за ${Math.round(performance.now() - t0)} мс, записей поиска: ${index.items.length}`);
$('#stats').textContent = `${world.stats.houses.toLocaleString('ru')} зданий, ${index.items.filter(i => i.k === 1).length.toLocaleString('ru')} мест, ${world.stats.trees.toLocaleString('ru')} деревьев`;
voice.init();

function updateSun() { atmo.follow(controls.target, camera.position.distanceTo(controls.target)); }

// ========== 3. Время суток (реальное солнце) ==========
const lf = THREE.MathUtils.lerp;
let night = 0, lastAtmo = 0, lastSt = { golden: 0 };
function applyTime(force = false) {
  const st = atmo.update(force); night = st.night; lastSt = st;
  shared.uNight.value = night; world.lampsPts.material.opacity = night * 0.75;
  document.body.classList.toggle('is-night', night > 0.5);
  updateClock(st);
}
// Живая строка: время в Бишкеке и что с солнцем
function updateClock(st) {
  const el = document.getElementById('clock'); if (!el) return;
  const now = atmo.now(), fmt = (d) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bishkek' });
  const ev = sunEvents(now), mins = (d) => Math.round((d - now) / 60000);
  const rel = (m) => m < 60 ? `${m} мин` : (m % 60 && m < 180 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${Math.round(m / 60)} ч`);
  let txt;
  if (ev.set && now < ev.set && st.el > -0.8) txt = `закат через ${rel(mins(ev.set))}`;
  else if (ev.rise && now < ev.rise) txt = `рассвет через ${rel(mins(ev.rise))}`;
  else txt = st.el > 0 ? 'день' : 'ночь';
  const stt = document.getElementById('st-time'); if (stt) stt.textContent = fmt(now);
  el.innerHTML = `<b${atmo.mode === 'live' ? '' : ' style="color:var(--sun)"'}>${fmt(now)}</b><span>${txt}</span>`;
}

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
  requestShot(); remember(place); syncFavBtn();
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
$('#btn-walk').onclick = () => { closeCard(); const t = controls.target; startWalk({ x: t.x + 1, z: t.z + 1 }); };
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
  $('#rtime').textContent = fmtTime(r.time); $('#rdist').textContent = fmtDist(r.length) + ({ car: ', на машине', bike: ', на велосипеде', walk: ', пешком' })[r.mode];
  $('#rnote').textContent = { car: 'Время примерное, без учёта пробок и светофоров.', bike: 'По улицам и дорожкам, около 14 км/ч.', walk: 'Пешком по улицам, тротуарам и дорожкам.' }[r.mode];
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
    setTimeout(() => { $('#vk').textContent = videoKind + (player.track.kind === 'tour' ? `, ${i + 1} из ${player.track.chapters.length}` : ''); $('#vh').textContent = c.title; $('#vp').textContent = c.sub || ''; vt.style.opacity = 1; }, 250);
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
  if (document.body.classList.contains('video') || walker.active || camAnim || document.body.classList.contains('measuring')) return;
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
const layers = { base: 'sat', time: 'live', trees: 'on', shadows: isMobile ? 'on' : 'on' };
function applyLayers() {
  terrain.setMode(layers.base);
  // на спутнике оставляем асфальт, площади и воду; газоны и тропинки видны на снимке
  for (const m of world.flatGroup.children) { const k = m.userData.kind || ''; m.visible = layers.base === 'schema' || /^road[1-6]$|^area1$|^area6$/.test(k); }
  if (layers.time === 'live') atmo.mode = 'live';
  else { atmo.mode = 'manual'; const ev = sunEvents(new Date()); const setH = ev.set ? (ev.set.getUTCHours() + 6 + ev.set.getUTCMinutes() / 60) % 24 : 18; atmo.hours = { day: 13, sunset: setH - 0.35, night: 23 }[layers.time]; }
  applyTime(true);
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

// ========== 13. Интерфейс по макету: режимы, меню, слои, статус ==========
const store = { get(k, d) { try { return JSON.parse(localStorage.getItem('b3d.' + k)) ?? d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem('b3d.' + k, JSON.stringify(v)); } catch (e) { } } };
const desktop = () => innerWidth >= 900;
// --- меню ---
$('#btn-menu').onclick = () => { if (desktop()) document.body.classList.toggle('menu-closed'); else document.body.classList.toggle('menu-open'); };
const navOn = (k) => document.querySelectorAll('.nav').forEach(n => n.classList.toggle('on', n.dataset.nav === k));
const closeMenuMobile = () => { if (!desktop()) document.body.classList.remove('menu-open'); };
document.querySelectorAll('.nav').forEach(n => n.onclick = () => {
  const k = n.dataset.nav; navOn(k); closeMenuMobile();
  if (k === 'home') { closeCard(); HOME(); }
  else if (k === 'tour') { startVideo(tour(), 'Тур по Бишкеку'); navOn('home'); }
  else if (k === 'places') { closeCard(); $('#places-sheet').classList.add('open'); }
  else if (k === 'cats') { setSearching(true); }
  else if (k === 'fav') showList('fav');
  else if (k === 'hist') showList('hist');
  else if (k === 'route') { route.active ? null : openRoute(); }
  else if (k === 'layers') { closeCard(); $('#layers-sheet').classList.add('open'); }
  else if (k === 'offline') toast('Офлайн-карты включатся на сайте GitHub Pages: там можно сохранять районы в телефон', 4200);
  else if (k === 'measure') startMeasure();
});
// --- режимы (верхняя полоса) ---
function setBase(b) { layers.base = b; applyLayers(); syncModes(); }
function syncModes() {
  document.querySelectorAll('#modebar button').forEach(b => b.classList.toggle('on', (b.dataset.mode === 'map' && layers.base === 'schema') || (b.dataset.mode === 'sat' && layers.base === 'sat') || (b.dataset.mode === '3d' && world.housesMesh.visible)));
  document.querySelectorAll('.vm').forEach(v => v.classList.toggle('on', v.dataset.vm === vmode));
}
let vmode = 'sat';
document.querySelectorAll('#modebar button').forEach(b => b.onclick = () => {
  const m = b.dataset.mode;
  if (m === 'map') setBase('schema');
  else if (m === 'sat') setBase('sat');
  else if (m === '3d') { world.housesMesh.visible = !world.housesMesh.visible; $('[data-lb=buildings]').checked = world.housesMesh.visible; syncModes(); }
  else if (m === 'walk') { const t = controls.target; startWalk({ x: t.x + 1, z: t.z + 1 }); }
  else if (m === 'pano') toast('Панорамы 360° подключим через Mapillary: нужен бесплатный ключ и сайт на GitHub Pages', 4200);
});
// --- режимы просмотра (плитки) ---
const VM_ART = {
  sat: 'radial-gradient(circle at 30% 40%, #6d7f55, #3e4a36 60%, #2a3326)',
  city: 'linear-gradient(160deg, #f1e6cf 0 30%, #b9c3cc 30% 55%, #a4553b 55% 70%, #e8e3d9 70%)',
  walk: 'linear-gradient(180deg, #8fbff0 0 45%, #d9d2c4 45% 60%, #4f535b 60%)',
  pano: 'conic-gradient(from 0deg, #6aa7e8, #f2b53a, #7fb069, #6aa7e8)',
  relief: 'linear-gradient(170deg, #fbfbff 0 18%, #9a8f80 18% 45%, #9fb27c 45% 75%, #c9cfa8 75%)',
  hybrid: 'linear-gradient(135deg, #3e4a36 0 45%, #f2b53a 45% 49%, #3e4a36 49% 70%, #f3efe6 70% 73%, #3e4a36 73%)',
};
document.querySelectorAll('.vm').forEach(v => { v.querySelector('i').style.background = VM_ART[v.dataset.vm]; v.onclick = () => setViewMode(v.dataset.vm); });
function setViewMode(m) {
  if (m === 'pano') return toast('Панорамы 360° появятся после подключения Mapillary', 3500);
  if (m === 'walk') { const t = controls.target; return startWalk({ x: t.x + 1, z: t.z + 1 }); }
  vmode = m; closeMenuMobile();
  world.housesMesh.visible = m !== 'relief'; world.treesMesh.visible = m !== 'relief' && layers.trees === 'on';
  layers.base = m === 'city' ? 'schema' : 'sat'; applyLayers();
  if (m === 'hybrid') for (const x of world.flatGroup.children) x.visible = /^road[1-4]$|^area1$/.test(x.userData.kind || '');
  if (m === 'relief') flyTo(new THREE.Vector3(0, 0, 3000), 16000, 1.2, 2200);
  document.querySelectorAll('[data-lb]').forEach(c => { if (c.dataset.lb === 'buildings') c.checked = world.housesMesh.visible; });
  syncModes();
}
// --- слои внизу ---
document.querySelectorAll('[data-lb]').forEach(c => c.onchange = () => {
  const k = c.dataset.lb, on = c.checked;
  if (k === 'buildings') { world.housesMesh.visible = on; syncModes(); }
  if (k === 'trees') { layers.trees = on ? 'on' : 'off'; world.treesMesh.visible = on; }
  if (k === 'roads') for (const x of world.flatGroup.children) if (/^road/.test(x.userData.kind || '')) x.visible = on;
  if (k === 'parks') for (const x of world.flatGroup.children) if (/^area[2347]$/.test(x.userData.kind || '')) x.visible = on && layers.base === 'schema';
});
// --- зум, 2D/3D, полный экран, моё место ---
const dolly = (k) => { const off = new THREE.Vector3().subVectors(camera.position, controls.target); const d = THREE.MathUtils.clamp(off.length() * k, controls.minDistance, controls.maxDistance); const s = new THREE.Spherical().setFromVector3(off); flyTo(controls.target.clone(), d, s.phi, 450); };
$('#z-in').onclick = () => dolly(0.6); $('#z-out').onclick = () => dolly(1.6);
document.querySelectorAll('.d23 button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.d23 button').forEach(x => x.classList.toggle('on', x === b));
  const d = camera.position.distanceTo(controls.target);
  if (b.dataset.d === '2') { controls.maxPolarAngle = 0.02; flyTo(controls.target.clone(), Math.max(d, 600), 0.01, 900, 0); }
  else { controls.maxPolarAngle = Math.PI * 0.47; flyTo(controls.target.clone(), d, 1.0, 900); }
});
$('#btn-full').onclick = () => { try { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => toast('Полноэкранный режим недоступен на этой странице')); } catch (e) { toast('Полноэкранный режим недоступен на этой странице'); } };
let mePin = null;
$('#btn-locate').onclick = () => {
  if (!navigator.geolocation) return toast('Определение местоположения не поддерживается');
  toast('Определяем местоположение…');
  navigator.geolocation.getCurrentPosition((pos) => {
    const { latitude: la, longitude: lo } = pos.coords, p = toXZ(la, lo);
    if (Math.abs(p.x) > 30000 || Math.abs(p.z) > 30000) return toast('Вы далеко от Бишкека — карта покрывает только город');
    if (!mePin) { mePin = new THREE.Mesh(new THREE.SphereGeometry(4, 20, 14), new THREE.MeshBasicMaterial({ color: 0x3d8ef0 })); scene.add(mePin); }
    mePin.position.set(p.x, elev(p.x, p.z) + 4, p.z); flyTo(new THREE.Vector3(p.x, 0, p.z), 350, 0.95);
    setRoutePoint('from', { title: 'Моё местоположение', x: p.x, z: p.z });
  }, () => toast('Нет доступа к местоположению. На этой странице оно отключено — заработает на сайте GitHub Pages', 4500), { enableHighAccuracy: true, timeout: 8000 });
};
// --- «Оживить город» ---
let cycleOn = false;
document.querySelectorAll('[data-alive]').forEach(b => b.onclick = () => {
  b.classList.toggle('on'); const on = b.classList.contains('on'), k = b.dataset.alive;
  if (k === 'traffic') traffic.group.visible = on;
  if (k === 'weather') { clouds.group.visible = on; lifeShared.uWind.value = on ? 1 : 0; }
  if (k === 'cycle') { cycleOn = on; if (!on) { layers.time = 'live'; applyLayers(); } else toast('Сутки проходят за минуту'); }
});
// --- онлайн / офлайн ---
const net = () => { $('#net').textContent = navigator.onLine ? 'Онлайн' : 'Офлайн'; $('#net').classList.toggle('off', !navigator.onLine); };
addEventListener('online', net); addEventListener('offline', net); net();
// --- строка состояния: координаты под курсором, высота, дата данных, погода, время ---
$('#st-upd').textContent = (D.osmTime || '').slice(0, 10).split('-').reverse().join('.');
let lastMove = 0;
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!desktop() || performance.now() - lastMove < 90) return; lastMove = performance.now();
  mouse.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(mouse, camera);
  const h = ray.intersectObjects([terrain.city, terrain.region], false)[0]; if (!h) return;
  const { lat, lon } = toLatLon(h.point.x, h.point.z);
  $('#st-coord').textContent = `${lat.toFixed(4)}° N, ${lon.toFixed(4)}° E`;
  $('#st-alt').textContent = `${Math.round(elev(h.point.x, h.point.z) + TR.base)} м`;
});
(async () => { // погода: Open-Meteo (бесплатно, без ключа). На claude.ai внешние запросы закрыты — тогда просто не показываем
  try {
    const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=42.8746&longitude=74.5698&current=temperature_2m,wind_speed_10m&wind_speed_unit=ms&timezone=Asia%2FBishkek');
    const j = await r.json(), c = j.current;
    $('#st-weather').innerHTML = `☀️ <b>${c.temperature_2m > 0 ? '+' : ''}${Math.round(c.temperature_2m)}°C</b> &nbsp; 💨 <b>${c.wind_speed_10m.toFixed(0)} м/с</b>`;
    lifeShared.uWind.value = THREE.MathUtils.clamp(c.wind_speed_10m / 3, 0.3, 3); // деревья качаются по реальному ветру
  } catch (e) { /* нет сети — без погоды */ }
})();
// --- избранное и история ---
const keyOf = (p) => `${p.title}|${Math.round(p.x)}|${Math.round(p.z)}`;
const favs = () => store.get('fav', []), hist = () => store.get('hist', []);
function remember(p) { const h = hist().filter(x => keyOf(x) !== keyOf(p)); h.unshift({ title: p.title, tag: p.tag, x: p.x, z: p.z, landmark: p.landmark || null }); store.set('hist', h.slice(0, 30)); }
function syncFavBtn() { const on = current && favs().some(f => keyOf(f) === keyOf(current)); $('#act-fav').classList.toggle('on', !!on); $('#act-fav').textContent = on ? '♥ В избранном' : '♡ В избранное'; }
$('#act-fav').onclick = () => {
  if (!current) return; let f = favs(); const k = keyOf(current);
  if (f.some(x => keyOf(x) === k)) f = f.filter(x => keyOf(x) !== k); else f.unshift({ title: current.title, tag: current.tag, x: current.x, z: current.z, landmark: current.landmark || null });
  store.set('fav', f); syncFavBtn(); toast(f.some(x => keyOf(x) === k) ? 'Добавлено в избранное' : 'Убрано из избранного');
};
function showList(kind) {
  closeCard(); const list = kind === 'fav' ? favs() : hist();
  $('#fav-title').textContent = kind === 'fav' ? 'Избранное' : 'История';
  $('#fav-list').innerHTML = list.length ? list.map((p, i) => `<button class="res" data-i="${i}"><span class="ic">${p.landmark ? '⭐' : '📍'}</span><div><b>${esc(p.title)}</b><span>${esc(p.tag || '')}</span></div></button>`).join('')
    : `<div class="empty">${kind === 'fav' ? 'Пока пусто. Откройте место и нажмите «В избранное».' : 'Здесь появятся места, которые вы открывали.'}</div>`;
  $('#fav-list').querySelectorAll('.res').forEach(b => b.onclick = () => { const p = list[+b.dataset.i]; $('#fav-sheet').classList.remove('open'); p.landmark ? openLandmark(p.landmark) : openPlace({ ...p, text: '' }, true, 240); });
  $('#fav-sheet').classList.add('open');
}
$('#fav-close').onclick = () => $('#fav-sheet').classList.remove('open');
// --- снимок 3D-модели для карточки (вместо фото, пока нет ваших фотографий) ---
let wantShot = false;
function requestShot() { wantShot = true; $('#card').classList.remove('has-img'); }
function takeShot() {
  if (!wantShot || fly || camAnim) return; wantShot = false;
  try { $('#card-img').src = renderer.domElement.toDataURL('image/jpeg', 0.8); $('#card').classList.add('has-img'); } catch (e) { }
}
// --- линейка ---
let mPts = [], mLine = null;
function startMeasure() { closeCard(); mPts = []; drawMeasure(); document.body.classList.add('measuring'); }
function drawMeasure() {
  if (mLine) { scene.remove(mLine); mLine.geometry.dispose(); mLine = null; }
  let d = 0; for (let i = 1; i < mPts.length; i++) d += mPts[i].distanceTo(mPts[i - 1]);
  $('#m-dist').textContent = fmtDist(d); $('#m-hint').textContent = mPts.length ? '' : 'нажимайте на карту';
  if (mPts.length > 1) { const g = new THREE.BufferGeometry().setFromPoints(mPts.map(p => p.clone().setY(p.y + 2))); mLine = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xf2b53a, depthTest: false })); mLine.renderOrder = 9; scene.add(mLine); }
}
$('#m-clear').onclick = () => { mPts = []; drawMeasure(); };
$('#m-done').onclick = () => { document.body.classList.remove('measuring'); mPts = []; drawMeasure(); navOn('home'); };
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!document.body.classList.contains('measuring')) return;
  mouse.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(mouse, camera);
  const h = ray.intersectObjects([terrain.city, terrain.region, world.housesMesh], false)[0]; if (!h) return;
  mPts.push(h.point.clone()); drawMeasure();
});
syncModes();

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
  if (now - lastAtmo > 1000) { lastAtmo = now; applyTime(); } // солнце движется в реальном времени
  lifeShared.uTime.value = now / 1000;
  if (cycleOn) { atmo.mode = 'manual'; atmo.hours = (atmo.hours + dt * 0.4) % 24; if (now - lastAtmo > 120) { lastAtmo = now; applyTime(); } }
  traffic.update(dt, night); clouds.update(dt, night, lastSt.golden || 0);
  if (flagObj) { const p = flagObj.geometry.attributes.position; for (let i = 0; i < p.count; i++) { const x = flagBase[i * 3] + 7.5; p.array[i * 3 + 2] = Math.sin(x * 0.55 - now * 0.004) * 0.12 * x; } p.needsUpdate = true; }
  if (wheel) wheel.rotation.z = now * 0.00012;
  if (flame) flame.scale.set(1, 1 + Math.sin(now * 0.02) * 0.15, 1);
  const bob = Math.sin(now * 0.004) * 1.5; pin.children[0].position.y = 22 + bob; pinA.rotation.y = pinB.rotation.y = now * 0.001;
  $('#compass-needle').style.transform = `rotate(${Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z)}rad)`;
  updateSun(); renderer.render(scene, camera); takeShot(); updateLabels();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
setTimeout(() => { $('#loader').classList.add('hide'); flyTo(new THREE.Vector3(0, 0, 700), 2900, 1.27, 3400); }, 250);
window.__bishkek = { camera, controls, walker, startWalk, enterBuilding, exitWalk, world, openLandmark, flyTo, router, index, route, setRoutePoint, startVideo, tour, player, atmo, setTime: (h) => { atmo.mode = 'manual'; atmo.hours = h; applyTime(true); } };
