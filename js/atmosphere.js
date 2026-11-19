// ============================================================
//  atmosphere.js — «НЕБО»
//  • Положение солнца над Бишкеком по астрономической формуле
//    для реального времени (или выбранного часа).
//  • Физическое небо (рассеяние света): голубое днём, золотое
//    на закате, тёмное ночью; звёзды.
//  • Карта отражений из этого неба — стёкла домов отражают его.
//  • Свет солнца/луны, дымка над долиной, «ночной» коэффициент.
// ============================================================
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

const LAT = 42.8762, LON = 74.6038, D2R = Math.PI / 180;

// Положение солнца: высота над горизонтом и азимут (от севера по часовой), в градусах
export function sunPosition(date) {
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;
  const g = (357.529 + 0.98560028 * d) * D2R, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R, e = (23.439 - 0.00000036 * d) * D2R;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const H = (gmst * 15 + LON) * D2R - ra, lat = LAT * D2R;
  const el = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(H));
  return { el: el / D2R, az: ((az / D2R) + 360) % 360 };
}
// Время восхода/заката сегодня (для строки «закат через …»)
export function sunEvents(date) {
  const base = new Date(date); const out = { rise: null, set: null };
  let prev = sunPosition(new Date(base.getTime() - 12 * 3600e3)).el;
  for (let m = -12 * 60 + 5; m <= 12 * 60; m += 5) {
    const t = new Date(base.getTime() + m * 60e3), el = sunPosition(t).el;
    if (prev < -0.833 && el >= -0.833 && !out.rise && m > -60) out.rise = t;
    if (prev >= -0.833 && el < -0.833 && !out.set && m > -60) out.set = t;
    prev = el;
  }
  return out;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Atmosphere {
  constructor(scene, renderer) {
    this.scene = scene; this.renderer = renderer;
    this.sky = new Sky(); this.sky.scale.setScalar(80000); this.sky.material.fog = false;
    const u = this.sky.material.uniforms;
    u.turbidity.value = 5.5; u.rayleigh.value = 1.6; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.82;
    scene.add(this.sky);
    // звёзды
    const N = 2200, P = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { const t = Math.random() * Math.PI * 2, p = Math.acos(Math.random() * 0.95); P[i * 3] = Math.sin(p) * Math.cos(t) * 70000; P[i * 3 + 1] = Math.cos(p) * 70000; P[i * 3 + 2] = Math.sin(p) * Math.sin(t) * 70000; }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(P, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    scene.add(this.stars);
    // свет
    this.sun = new THREE.DirectionalLight(0xffffff, 3); this.sun.castShadow = true;
    this.hemi = new THREE.HemisphereLight(0xdfe9ff, 0xb8a88a, 0.8);
    scene.add(this.sun, this.sun.target, this.hemi);
    scene.fog = new THREE.Fog(0xd6dfe8, 3500, 60000);
    // карта отражений
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene(); this.envSky = new Sky(); this.envSky.scale.setScalar(1000); this.envScene.add(this.envSky);
    this.envRT = null; this.lastEnvEl = 999; this.lastEnvAz = 999;
    this.dir = new THREE.Vector3(); this.night = 0; this.mode = 'live'; this.hours = 12;
  }
  // Какое сейчас время в Бишкеке (UTC+6), с учётом ручного режима
  now() {
    if (this.mode === 'live') return new Date();
    const d = new Date(); const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + (this.hours - 6) * 3600e3;
    return new Date(utc);
  }
  update(force = false) {
    const { el, az } = sunPosition(this.now());
    this.el = el; this.az = az;
    const e = el * D2R, a = az * D2R;
    this.dir.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
    const u = this.sky.material.uniforms; u.sunPosition.value.copy(this.dir);
    // ночь: солнце ниже −6° (гражданские сумерки)
    this.night = smooth(1.5, -7, el);
    const golden = smooth(14, 2, el) * (1 - this.night);
    // свет солнца: тёплый у горизонта; ночью — слабая голубая «луна» сверху
    const sunCol = new THREE.Color(0xffffff).lerp(new THREE.Color(0xffb46b), golden);
    this.sun.color.copy(sunCol).lerp(new THREE.Color(0x8fa6d8), this.night);
    this.sun.intensity = THREE.MathUtils.lerp(Math.max(0.2, 4.2 * smooth(-2, 12, el)), 0.35, this.night);
    this.lightDir = this.night > 0.5 ? new THREE.Vector3(0.3, 0.8, -0.4).normalize() : this.dir.clone().setY(Math.max(this.dir.y, 0.08)).normalize();
    this.hemi.intensity = THREE.MathUtils.lerp(0.8, 0.3, this.night);
    this.hemi.color.set(0xdfe9ff).lerp(new THREE.Color(0x3a4f88), this.night); this.hemi.groundColor.set(0xb8a88a).lerp(new THREE.Color(0x2a2620), this.night);
    // дымка: голубая днём, медовая на закате, тёмно-синяя ночью
    const fog = new THREE.Color(0xdfe7ef).lerp(new THREE.Color(0xf0c49a), golden * 0.85).lerp(new THREE.Color(0x111a33), this.night);
    this.scene.fog.color.copy(fog);
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(0.95, 1.15, this.night) + golden * 0.05;
    this.stars.material.opacity = this.night * 0.9;
    this.sky.visible = this.night < 0.98;
    this.scene.background = this.night > 0.6 ? new THREE.Color(0x070b18).lerp(new THREE.Color(0x0d1428), 1 - this.night) : null;
    // карту отражений пересчитываем, только когда солнце заметно сдвинулось
    if (force || Math.abs(el - this.lastEnvEl) > 0.7 || Math.abs(az - this.lastEnvAz) > 2) {
      const eu = this.envSky.material.uniforms; for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) eu[k].value = u[k].value;
      eu.sunPosition.value.copy(this.dir);
      this.envScene.background = this.night > 0.6 ? new THREE.Color(0x0b1226) : null;
      this.envRT?.dispose(); this.envRT = this.pmrem.fromScene(this.envScene, 0.04);
      this.scene.environment = this.envRT.texture;
      this.scene.environmentIntensity = THREE.MathUtils.lerp(0.55, 0.3, this.night);
      this.lastEnvEl = el; this.lastEnvAz = az;
    }
    return { el, az, night: this.night, golden };
  }
  // Свет и тени следуют за той частью города, которую мы смотрим
  follow(target, dist) {
    const half = THREE.MathUtils.clamp(dist * 0.75, 200, 3000), c = this.sun.shadow.camera;
    if (Math.abs(c.right - half) > half * 0.15) { c.left = -half; c.right = half; c.top = half; c.bottom = -half; c.near = 10; c.far = 12000; c.updateProjectionMatrix(); }
    this.sun.target.position.copy(target); this.sun.position.copy(target).addScaledVector(this.lightDir || this.dir, 5000);
  }
}
