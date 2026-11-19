// ============================================================
//  search.js — «СПРАВОЧНАЯ»
//  Ищет места, адреса, улицы и здания. Понимает сокращения
//  («пр. Чуй 166», «ул киевская»), не путается в «ё/е»
//  и ищет по категориям («кафе», «аптека», «банкомат»).
// ============================================================

// слова, которые не важны при поиске
const STOP = new Set(['улица', 'ул', 'проспект', 'пр', 'просп', 'пр-т', 'бульвар', 'б-р', 'бул', 'переулок', 'пер', 'проезд', 'площадь', 'пл', 'микрорайон', 'мкр', 'дом', 'д', 'көчөсү', 'проспектиси']);
export const norm = (s) => (s || '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"'.,()№#\/\\-]/g, ' ').replace(/\s+/g, ' ').trim();
const toks = (s) => norm(s).split(' ').filter(w => w && !STOP.has(w));

// значок по виду и категории
const ICON = { 'Кафе': '☕', 'Ресторан': '🍽️', 'Фастфуд': '🍔', 'Бар': '🍸', 'Паб': '🍺', 'Банк': '🏦', 'Банкомат': '💳', 'Аптека': '💊', 'Больница': '🏥',
  'Клиника': '🏥', 'Стоматология': '🦷', 'Школа': '🏫', 'Университет': '🎓', 'Колледж': '🎓', 'Детский сад': '🧸', 'Храм / мечеть': '🕌', 'АЗС': '⛽',
  'Парковка': '🅿️', 'Театр': '🎭', 'Кинотеатр': '🎬', 'Библиотека': '📚', 'Почта': '✉️', 'Полиция': '🚓', 'Рынок': '🧺', 'Гостиница': '🏨', 'Хостел': '🛏️',
  'Музей': '🏛️', 'Парк': '🌳', 'Супермаркет': '🛒', 'Продукты': '🛒', 'Торговый центр': '🛍️', 'Одежда': '👕', 'Пекарня': '🥐', 'Салон красоты': '💅',
  'Парикмахерская': '💇', 'Фитнес': '🏋️', 'Обмен валют': '💱', 'Посольство': '🏳️', 'Цветы': '💐', 'Офис': '🏢', 'Аптеки': '💊' };
export function iconFor(item) {
  if (item.k === 0) return '⭐'; if (item.k === 2) return '🏠'; if (item.k === 3) return '🛣️'; if (item.k === 4) return '🏢';
  const cat = (item.sub || '').split(' · ')[0]; return ICON[cat] || '📍';
}

// Быстрые категории — как в приложениях карт
export const QUICK = [['☕', 'Кафе'], ['🍽️', 'Ресторан'], ['💊', 'Аптека'], ['💳', 'Банкомат'], ['🏦', 'Банк'], ['🛒', 'Супермаркет'], ['🏨', 'Гостиница'], ['🏛️', 'Музей'], ['⛽', 'АЗС'], ['🌳', 'Парк']];

export class SearchIndex {
  constructor(items, landmarks) {
    // k: 0 достопримечательность, 1 место, 2 адрес, 3 улица, 4 здание
    this.items = landmarks.map(l => ({ t: l.name, k: 0, x: l.x, z: l.z, sub: 'Достопримечательность', id: l.id }))
      .concat(items.map(([t, k, x, z, sub]) => ({ t, k, x: x * 0.1, z: z * 0.1, sub })));
    for (const it of this.items) { it.n = norm(it.t); it.tk = toks(it.t); it.cat = norm((it.sub || '').split(' · ')[0]); }
  }
  // Поиск: каждое слово запроса должно совпасть с началом какого-то слова в названии (или с категорией)
  find(q, limit = 12) {
    const qt = toks(q); if (!qt.length) return [];
    const qn = norm(q), out = [];
    for (const it of this.items) {
      let score = 0, ok = true;
      for (const w of qt) {
        if (it.tk.some(t => t === w)) score += 3;
        else if (it.tk.some(t => t.startsWith(w))) score += 2;
        else if (it.k === 1 && it.cat.startsWith(w)) score += 1.5;
        else if (w.length > 2 && it.n.includes(w)) score += 1;
        else { ok = false; break; }
      }
      if (!ok) continue;
      if (it.n.startsWith(qn)) score += 2;
      score += [3, 1.2, 0.8, 1, 0.6][it.k];
      score -= it.t.length / 200;
      out.push([score, it]);
    }
    out.sort((a, b) => b[0] - a[0]);
    // убираем дубли (одно и то же место под разными видами)
    const seen = new Set(), res = [];
    for (const [, it] of out) { const key = it.n + '|' + Math.round(it.x / 30) + '|' + Math.round(it.z / 30); if (seen.has(key)) continue; seen.add(key); res.push(it); if (res.length >= limit) break; }
    return res;
  }
  // Все места одной категории (для кнопок «Кафе», «Аптека»…)
  category(cat, limit = 60) {
    const c = norm(cat);
    return this.items.filter(it => it.k === 1 && it.cat === c).slice(0, limit);
  }
}
