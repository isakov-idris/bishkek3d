// ============================================================
//  player.js — «КИНООПЕРАТОР»
//  Превращает 3D-город в «видео»: камера летит по заранее
//  рассчитанной траектории. Есть пауза, перемотка, главы,
//  скорость и голосовой рассказчик (встроенный голос браузера).
//  Дорожка (track) = { duration, sample(t) → {pos, target}, chapters }
// ============================================================
import * as THREE from 'three';
import { elev } from './terrain.js';

const ease = (k) => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;

// ---------- Голос ----------
export const voice = {
  on: true,
  ru: null,
  init() {
    try {
      const pick = () => { const v = speechSynthesis.getVoices(); this.ru = v.find(x => /^ru/i.test(x.lang)) || null; };
      pick(); speechSynthesis.onvoiceschanged = pick;
    } catch (e) { this.on = false; }
  },
  say(text) {
    if (!this.on || !text) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text); u.lang = 'ru-RU'; if (this.ru) u.voice = this.ru; u.rate = 1.0;
      speechSynthesis.speak(u);
    } catch (e) { /* голос недоступен — просто молчим */ }
  },
  stop() { try { speechSynthesis.cancel(); } catch (e) { } },
};

// ---------- Дорожка «тур по городу» ----------
// Для каждого места: перелёт (4 с) + медленный облёт вокруг (7 с)
export function tourTrack(stops) {
  const FLY = 4, ORBIT = 7, SEG = FLY + ORBIT;
  const sph = (target, dist, phi, theta) => target.clone().add(new THREE.Vector3().setFromSpherical(new THREE.Spherical(dist, phi, theta)));
  const st = stops.map((s, i) => ({ ...s, theta0: Math.PI + i * 0.9, phi: 1.0 }));
  const start = { target: new THREE.Vector3(0, elev(0, 500), 500), pos: new THREE.Vector3(-1800, 2600, -2600) };
  const orbitAt = (s, k) => ({ target: s.target, pos: sph(s.target, s.dist, s.phi, s.theta0 + k * 0.9) });
  const duration = st.length * SEG + 3;
  const chapters = st.map((s, i) => ({ t: i * SEG, title: s.title, sub: s.sub, say: s.say }));
  function sample(t) {
    t = Math.max(0, Math.min(duration, t));
    const i = Math.min(st.length - 1, Math.floor(t / SEG)), lt = t - i * SEG;
    const s = st[i];
    if (lt < FLY) {
      const from = i === 0 ? start : orbitAt(st[i - 1], 1);
      const to = orbitAt(s, 0), k = ease(lt / FLY);
      const target = from.target.clone().lerp(to.target, k);
      const pos = from.pos.clone().lerp(to.pos, k);
      const hop = Math.min(500, from.target.distanceTo(to.target) * 0.35); // «подпрыгиваем» на длинных перелётах
      pos.y += Math.sin(k * Math.PI) * hop;
      return { pos, target };
    }
    return orbitAt(s, Math.min(1, (lt - FLY) / ORBIT));
  }
  return { duration, sample, chapters, kind: 'tour' };
}

// ---------- Дорожка «облёт маршрута» (как с дрона) ----------
export function routeTrack(route) {
  // равномерные точки по пути каждые 4 м
  const P = route.pts, pts = [], cum = [0];
  for (let i = 0; i < P.length - 1; i++) {
    const [x1, z1] = P[i], [x2, z2] = P[i + 1], L = Math.hypot(x2 - x1, z2 - z1);
    const n = Math.max(1, Math.ceil(L / 4));
    for (let k = 0; k < n; k++) pts.push([x1 + (x2 - x1) * k / n, z1 + (z2 - z1) * k / n]);
  }
  pts.push(P[P.length - 1]);
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum[cum.length - 1];
  const at = (d) => {
    d = Math.max(0, Math.min(L, d));
    let lo = 0, hi = cum.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cum[m] <= d) lo = m; else hi = m - 1; }
    const i = Math.min(lo, pts.length - 2), k = (d - cum[i]) / Math.max(1e-6, cum[i + 1] - cum[i]);
    const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, z = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k;
    return new THREE.Vector3(x, elev(x, z), z);
  };
  const speed = route.mode === 'car' ? 38 : 22; // «видео»-скорость, м/с
  const duration = Math.max(10, Math.min(90, L / speed)) + 4;
  const chapters = route.steps.map(s => ({ t: 2 + Math.min(1, s.at / L) * (duration - 4), title: s.action, sub: s.name, say: s.action + (s.name ? ', ' + s.name : '') }));
  function sample(t) {
    const k = Math.max(0, Math.min(1, (t - 2) / (duration - 4)));
    const d = ease(k) * 0.15 + k * 0.85; // плавный старт
    const d0 = d * L;
    // направление сглаживаем по окну ±60 м, чтобы камера не дёргалась
    const ahead = at(d0 + 60), behind = at(d0 - 60);
    const dir = ahead.clone().sub(behind); dir.y = 0; if (dir.lengthSq() < 1) dir.set(0, 0, -1); dir.normalize();
    const target = at(d0).add(dir.clone().multiplyScalar(35));
    const pos = at(d0).sub(dir.clone().multiplyScalar(110)); pos.y = elev(pos.x, pos.z) + (route.mode === 'car' ? 60 : 45);
    if (t < 2) { pos.y += (2 - t) * 120; }
    if (t > duration - 2) { const e = (t - (duration - 2)) / 2; pos.y += e * 140; pos.sub(dir.clone().multiplyScalar(e * 80)); }
    return { pos, target };
  }
  return { duration, sample, chapters, kind: 'route' };
}

// ---------- Сам плеер ----------
export class Player {
  constructor(camera, controls, ui) {
    Object.assign(this, { camera, controls, ui });
    this.track = null; this.t = 0; this.playing = false; this.rate = 1; this.lastChapter = -1;
    this.blend = null;
  }
  load(track) {
    this.track = track; this.t = 0; this.lastChapter = -1; this.ui.onLoad(track);
  }
  play() {
    if (!this.track) return;
    if (this.t >= this.track.duration - 0.05) { this.t = 0; this.lastChapter = -1; }
    // плавно «въезжаем» в траекторию из текущего положения камеры
    this.blend = { start: performance.now(), pos: this.camera.position.clone(), target: this.controls.target.clone() };
    this.playing = true; this.ui.onState(true);
  }
  pause() { this.playing = false; voice.stop(); this.ui.onState(false); }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(t) {
    if (!this.track) return;
    this.t = Math.max(0, Math.min(this.track.duration, t)); this.lastChapter = -1;
    this.apply(1); this.ui.onTime(this.t, this.track.duration, this.chapterAt(this.t, true));
  }
  chapterAt(t, silent) {
    const ch = this.track.chapters; let idx = -1;
    for (let i = 0; i < ch.length; i++) if (ch[i].t <= t + 0.01) idx = i;
    if (!silent && idx !== this.lastChapter && idx >= 0) { this.lastChapter = idx; voice.say(ch[idx].say || ch[idx].title); this.ui.onChapter(ch[idx], idx); }
    return idx >= 0 ? ch[idx] : null;
  }
  apply(blendK) {
    const s = this.track.sample(this.t);
    if (blendK < 1 && this.blend) {
      s.pos.lerp(this.blend.pos, 1 - blendK); s.target.lerp(this.blend.target, 1 - blendK);
    }
    this.camera.position.copy(s.pos); this.controls.target.copy(s.target); this.camera.lookAt(s.target);
  }
  update(dt) {
    if (!this.playing || !this.track) return false;
    this.t += dt * this.rate;
    if (this.t >= this.track.duration) { this.t = this.track.duration; this.playing = false; this.ui.onState(false); this.ui.onEnd?.(); }
    const bk = this.blend ? Math.min(1, (performance.now() - this.blend.start) / 1200) : 1;
    this.apply(ease(bk)); if (bk >= 1) this.blend = null;
    this.chapterAt(this.t, false);
    this.ui.onTime(this.t, this.track.duration, null);
    return true;
  }
}
