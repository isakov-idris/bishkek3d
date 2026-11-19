# ============================================================
#  process.py — «ПЕРЕВОДЧИК»
#  Берёт сырые данные OpenStreetMap (osm/t*.json) и упаковывает
#  в компактный data/city.json для сайта:
#  здания (контур в метрах + высота), дороги, вода, зелень,
#  площади, деревья, подписи улиц.
#  Данные © участники OpenStreetMap, лицензия ODbL.
# ============================================================
import json, glob, math, re, sys, collections

SRC = sys.argv[1] if len(sys.argv) > 1 else '/home/claude/osm'
OUT = sys.argv[2] if len(sys.argv) > 2 else '/home/claude/bishkek3d/data/city.json'
LAT0, LON0 = 42.8762, 74.6038
MLAT = 111130.0
MLON = 111320.0 * math.cos(math.radians(LAT0))

def xz(lat, lon):  # метры: x на восток, z на юг, округляем до 0.1 м (храним в дециметрах)
    return round((lon - LON0) * MLON * 10), round(-(lat - LAT0) * MLAT * 10)

# ---------- читаем и убираем дубли (объект мог попасть в 2 кусочка) ----------
els = {}
osm_time = ''
for f in sorted(glob.glob(SRC + '/t*.json')):
    _j = json.load(open(f)); osm_time = osm_time or _j.get('osm3s', {}).get('timestamp_osm_base', '')
    for e in _j['elements']:
        els[(e['type'], e['id'])] = e
print('объектов:', len(els))

def ring_of(geom):
    pts = [xz(p['lat'], p['lon']) for p in geom if p]
    if len(pts) > 1 and pts[0] == pts[-1]: pts = pts[:-1]
    # убираем повторяющиеся точки подряд
    out = []
    for p in pts:
        if not out or out[-1] != p: out.append(p)
    return out

def area(r):
    a = 0
    for i in range(len(r)):
        x1, z1 = r[i]; x2, z2 = r[(i + 1) % len(r)]
        a += x1 * z2 - x2 * z1
    return abs(a) / 2 / 100  # м²

def stitch(ways):
    """Склеивает куски внешней границы мультиполигона в замкнутые кольца"""
    ways = [w[:] for w in ways if len(w) > 1]
    rings = []
    while ways:
        cur = ways.pop(0)
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, w in enumerate(ways):
                if w[0] == cur[-1]: cur += w[1:]
                elif w[-1] == cur[-1]: cur += w[::-1][1:]
                elif w[-1] == cur[0]: cur = w + cur[1:]
                elif w[0] == cur[0]: cur = w[::-1] + cur[1:]
                else: continue
                ways.pop(i); changed = True; break
        if len(cur) >= 4 and cur[0] == cur[-1]: rings.append(cur[:-1])
    return rings

def polys(e):
    """[(outer, [holes])] для way или relation"""
    if e['type'] == 'way':
        g = e.get('geometry')
        if not g or len(g) < 4 or g[0] != g[-1]: return []
        r = ring_of(g)
        return [(r, [])] if len(r) >= 3 else []
    outs, ins = [], []
    for m in e.get('members', []):
        if m.get('type') != 'way' or 'geometry' not in m: continue
        pts = [xz(p['lat'], p['lon']) for p in m['geometry'] if p]
        (ins if m.get('role') == 'inner' else outs).append(pts)
    O, I = stitch(outs), stitch(ins)
    def inside(pt, r):
        x, z = pt; c = False
        for i in range(len(r)):
            x1, z1 = r[i]; x2, z2 = r[i - 1]
            if (z1 > z) != (z2 > z) and x < (x2 - x1) * (z - z1) / (z2 - z1 + 1e-9) + x1: c = not c
        return c
    return [(o, [h for h in I if inside(h[0], o)]) for o in O]

# ---------- высота здания ----------
TYPE_CODE = {'house': 1, 'detached': 1, 'semidetached_house': 1, 'bungalow': 1, 'garage': 2, 'garages': 2, 'shed': 2, 'hut': 2, 'kiosk': 2,
             'roof': 2, 'apartments': 3, 'residential': 3, 'dormitory': 3, 'commercial': 4, 'retail': 4, 'office': 4, 'hotel': 4, 'supermarket': 4,
             'industrial': 5, 'warehouse': 5, 'service': 5, 'school': 6, 'university': 6, 'college': 6, 'kindergarten': 6, 'hospital': 6,
             'public': 6, 'government': 6, 'civic': 6, 'mosque': 7, 'church': 7, 'cathedral': 7, 'religious': 7, 'construction': 8}
def num(v):
    m = re.match(r'\s*([0-9]+(?:[.,][0-9]+)?)', v or '')
    return float(m.group(1).replace(',', '.')) if m else None

def height(t, a):
    if num(t.get('height')): return num(t['height']), True
    lv = num(t.get('building:levels'))
    if lv: return lv * 3.1 + (0.6 if lv > 1 else 0.4), True
    b = t.get('building', 'yes'); c = TYPE_CODE.get(b, 0)
    if c == 1: return (3.6 if a < 140 else 6.6), False
    if c == 2: return 2.8, False
    if c == 3: return (15.9 if a < 1500 else 28.5), False
    if c == 4: return (7.0 if a < 400 else 10.5), False
    if c == 5: return 6.5, False
    if c == 6: return 10.0, False
    if c == 7: return 9.0, False
    if c == 8: return 4.0, False
    # building=yes: оцениваем по площади (в Бишкеке мелкое — частные дома)
    if a < 130: return 3.6, False
    if a < 260: return 6.6, False
    if a < 700: return 12.8, False
    if a < 1600: return 15.9, False
    return 15.9, False

def min_h(t):
    if num(t.get('min_height')): return num(t['min_height'])
    if num(t.get('building:min_level')): return num(t['building:min_level']) * 3.1
    return 0.0

# ---------- раскладываем по слоям ----------
names = []; name_idx = {}
def nid(n):
    if not n: return -1
    if n not in name_idx: name_idx[n] = len(names); names.append(n)
    return name_idx[n]

ROAD = {'motorway': (1, 24), 'trunk': (1, 22), 'primary': (1, 20), 'primary_link': (2, 9), 'secondary': (2, 15), 'secondary_link': (3, 7),
        'tertiary': (3, 11), 'tertiary_link': (3, 7), 'residential': (4, 7), 'unclassified': (4, 7), 'living_street': (4, 6), 'service': (5, 4),
        'pedestrian': (6, 6), 'footway': (7, 2.2), 'path': (7, 1.8), 'cycleway': (7, 2.0)}
AREA_CODE = {'water': 1, 'park': 2, 'grass': 3, 'forest': 4, 'pitch': 5, 'plaza': 6, 'cemetery': 7}

B, roads, areas, waterways, trees = [], [], [], [], []
bmeta = []  # паспорт здания: [osm id, крыша, материал, источник высоты 1=height 2=этажность 0=оценка, этажность]
road_meta = []
search = []  # [текст, вид, x, z, подпись]  вид: 1 место, 2 адрес, 3 улица, 4 здание
street_segs = collections.defaultdict(list)
stats = collections.Counter()

for (typ, _id), e in els.items():
    t = e.get('tags', {})
    if typ == 'node':
        if t.get('natural') == 'tree': trees += list(xz(e['lat'], e['lon']))
        continue
    if 'building' in t and t.get('building') not in ('no',):
        for outer, holes in polys(e):
            a = area(outer)
            if a < 8: continue
            h, known = height(t, a)
            mh = min_h(t)
            if h <= mh: h = mh + 3
            code = TYPE_CODE.get(t.get('building', 'yes'), 0)
            rec = [round(h * 10), round(mh * 10), code + (100 if known else 0), nid(t.get('name:ru') or t.get('name')), len(outer)] + [v for p in outer for v in p]
            for hl in holes: rec += [len(hl)] + [v for p in hl for v in p]
            B.append(rec); stats['known_h' if known else 'guess_h'] += 1
            hsrc = 1 if num(t.get('height')) else (2 if num(t.get('building:levels')) else 0)
            bmeta.append([typ[0] + str(_id), nid(t.get('roof:shape')), nid(t.get('building:material') or t.get('building:facade:material') or t.get('facade:material')), hsrc, t.get('building:levels') or ''])
            cx = sum(p[0] for p in outer) / len(outer); cz = sum(p[1] for p in outer) / len(outer)
            st, hn = t.get('addr:street'), t.get('addr:housenumber')
            nm = t.get('name:ru') or t.get('name')
            if st and hn: search.append([f"{st}, {hn}", 2, round(cx), round(cz), nm or ''])
            if nm: search.append([nm, 4, round(cx), round(cz), f"{st}, {hn}" if st and hn else 'Здание'])
        continue
    hw = t.get('highway')
    if hw:
        if t.get('area') == 'yes' or (hw == 'pedestrian' and e.get('geometry') and e['geometry'][0] == e['geometry'][-1] and t.get('area') != 'no'):
            for o, _ in polys(e): areas.append([AREA_CODE['plaza'], len(o)] + [v for p in o for v in p])
            continue
        if hw in ROAD and e.get('geometry') and t.get('tunnel') != 'yes':
            cls, w = ROAD[hw]
            lanes = num(t.get('lanes'))
            if lanes and cls <= 3: w = max(w, lanes * 3.4)
            pts = ring_of(e['geometry']) if e['geometry'][0] != e['geometry'][-1] else [xz(p['lat'], p['lon']) for p in e['geometry']]
            roads.append([cls, round(w * 10), len(pts)] + [v for p in pts for v in p])
            ow = t.get('oneway'); ow = 1 if ow in ('yes', '1', 'true') else (-1 if ow == '-1' else 0)
            if t.get('junction') == 'roundabout': ow = 1
            road_meta.append([nid(t.get('name:ru') or t.get('name')), ow])
            nm = t.get('name:ru') or t.get('name')
            if nm and cls <= 4: street_segs[nm].append(pts)
        continue
    ww = t.get('waterway')
    if ww in ('river', 'canal', 'stream', 'ditch', 'drain') and e.get('geometry'):
        w = {'river': 18, 'canal': 14, 'stream': 4, 'ditch': 2.5, 'drain': 2.5}[ww]
        pts = [xz(p['lat'], p['lon']) for p in e['geometry']]
        waterways.append([round(w * 10), len(pts)] + [v for p in pts for v in p]); continue
    code = None
    if t.get('natural') == 'water' or t.get('waterway') == 'riverbank': code = 'water'
    elif t.get('leisure') in ('park', 'garden'): code = 'park'
    elif t.get('leisure') in ('pitch', 'stadium'): code = 'pitch'
    elif t.get('landuse') in ('grass', 'recreation_ground'): code = 'grass'
    elif t.get('landuse') == 'forest' or t.get('natural') == 'wood': code = 'forest'
    elif t.get('landuse') == 'cemetery': code = 'cemetery'
    if code:
        for o, holes in polys(e):
            if area(o) < 20: continue
            areas.append([AREA_CODE[code], len(o)] + [v for p in o for v in p])

# ---------- подписи улиц: по 1–3 метки на самых длинных кусках ----------
labels = []
for nm, segs in street_segs.items():
    segs.sort(key=lambda s: -sum(math.dist(s[i], s[i + 1]) for i in range(len(s) - 1)))
    for s in segs[:3]:
        L = sum(math.dist(s[i], s[i + 1]) for i in range(len(s) - 1))
        if L < 1500: continue  # < 150 м
        half, acc = L / 2, 0
        for i in range(len(s) - 1):
            d = math.dist(s[i], s[i + 1])
            if acc + d >= half:
                k = (half - acc) / d
                labels.append([nid(nm), round(s[i][0] + (s[i + 1][0] - s[i][0]) * k), round(s[i][1] + (s[i + 1][1] - s[i][1]) * k)]); break
            acc += d

# ---------- деревья и фонари: вдоль дорог и в парках, но не внутри домов ----------
from shapely.geometry import Polygon, Point
from shapely.strtree import STRtree
import random
random.seed(1878)
bpolys = []
for r in B:
    n = r[4]; pts = [(r[5 + 2 * i] / 10, r[6 + 2 * i] / 10) for i in range(n)]
    try:
        P = Polygon(pts)
        if P.is_valid: bpolys.append(P.buffer(2.5))
    except Exception: pass
tree_idx = STRtree(bpolys)
def free(x, z):
    pt = Point(x, z)
    return not any(bpolys[i].contains(pt) for i in tree_idx.query(pt))
road_polys = []
gen_trees, lamps = [], []
for r in roads:
    cls, w, n = r[0], r[1] / 10, r[2]
    pts = [(r[3 + 2 * i] / 10, r[4 + 2 * i] / 10) for i in range(n)]
    if cls > 4: continue
    for i in range(n - 1):
        (x1, z1), (x2, z2) = pts[i], pts[i + 1]
        L = math.dist(pts[i], pts[i + 1])
        if L < 1: continue
        nx, nz = -(z2 - z1) / L, (x2 - x1) / L
        stepT = 11 if cls <= 3 else 14
        t = random.uniform(2, stepT)
        while t < L - 2:
            k = t / L; px, pz = x1 + (x2 - x1) * k, z1 + (z2 - z1) * k
            for sg in (-1, 1):
                off = w / 2 + 3.2
                tx, tz = px + nx * off * sg, pz + nz * off * sg
                if random.random() < 0.85 and free(tx, tz): gen_trees.append((tx, tz, random.uniform(0.85, 1.25)))
            t += stepT + random.uniform(-2, 2)
        if cls <= 3:
            t = 15
            while t < L:
                k = t / L; px, pz = x1 + (x2 - x1) * k, z1 + (z2 - z1) * k
                for sg in (-1, 1): lamps += [round(px + nx * (w / 2 + 1) * sg, 1), round(pz + nz * (w / 2 + 1) * sg, 1)]
                t += 34
for a in areas:
    code, n = a[0], a[1]
    if code not in (2, 3, 4, 7): continue
    pts = [(a[2 + 2 * i] / 10, a[3 + 2 * i] / 10) for i in range(n)]
    try: P = Polygon(pts)
    except Exception: continue
    if not P.is_valid: P = P.buffer(0)
    dens = {2: 1 / 140, 3: 1 / 320, 4: 1 / 60, 7: 1 / 200}[code]
    cnt = int(P.area * dens)
    x0, z0, x1, z1 = P.bounds
    tries = 0
    while cnt > 0 and tries < cnt * 6 + 50:
        tries += 1
        x, z = random.uniform(x0, x1), random.uniform(z0, z1)
        if P.contains(Point(x, z)) and free(x, z): gen_trees.append((x, z, random.uniform(1.0, 1.7))); cnt -= 1
for i in range(0, len(trees), 2): gen_trees.append((trees[i] / 10, trees[i + 1] / 10, 1.3))
random.shuffle(gen_trees)
gen_trees = gen_trees[:26000]
trees = [round(v * 10) for t3 in gen_trees for v in (t3[0], t3[1])] + []
tree_s = [round(t3[2] * 100) for t3 in gen_trees]

# ---------- улицы в поиск ----------
for nm, segs in street_segs.items():
    best = max(segs, key=lambda s_: len(s_)); mid = best[len(best) // 2]
    search.append([nm, 3, mid[0], mid[1], 'Улица'])

# ---------- места (кафе, аптеки, банки…) из osm_poi ----------
CAT = {
 'amenity': {'cafe': 'Кафе', 'restaurant': 'Ресторан', 'fast_food': 'Фастфуд', 'bar': 'Бар', 'pub': 'Паб', 'bank': 'Банк', 'atm': 'Банкомат',
   'pharmacy': 'Аптека', 'hospital': 'Больница', 'clinic': 'Клиника', 'doctors': 'Врач', 'dentist': 'Стоматология', 'school': 'Школа',
   'university': 'Университет', 'college': 'Колледж', 'kindergarten': 'Детский сад', 'place_of_worship': 'Храм / мечеть', 'fuel': 'АЗС',
   'parking': 'Парковка', 'theatre': 'Театр', 'cinema': 'Кинотеатр', 'library': 'Библиотека', 'post_office': 'Почта', 'police': 'Полиция',
   'marketplace': 'Рынок', 'bus_station': 'Автовокзал', 'townhall': 'Администрация', 'embassy': 'Посольство', 'courthouse': 'Суд',
   'nightclub': 'Ночной клуб', 'ice_cream': 'Мороженое', 'arts_centre': 'Арт-центр', 'community_centre': 'Дом культуры', 'veterinary': 'Ветклиника',
   'car_wash': 'Автомойка', 'money_transfer': 'Денежные переводы', 'bureau_de_change': 'Обмен валют', 'driving_school': 'Автошкола', 'language_school': 'Языковая школа'},
 'shop': {'supermarket': 'Супермаркет', 'convenience': 'Продукты', 'mall': 'Торговый центр', 'clothes': 'Одежда', 'bakery': 'Пекарня',
   'mobile_phone': 'Телефоны', 'electronics': 'Электроника', 'beauty': 'Салон красоты', 'hairdresser': 'Парикмахерская', 'books': 'Книги',
   'shoes': 'Обувь', 'jewelry': 'Ювелирный', 'cosmetics': 'Косметика', 'furniture': 'Мебель', 'car': 'Автосалон', 'car_repair': 'Автосервис',
   'florist': 'Цветы', 'optician': 'Оптика', 'gift': 'Подарки', 'toys': 'Игрушки', 'sports': 'Спорттовары', 'department_store': 'Универмаг'},
 'tourism': {'hotel': 'Гостиница', 'hostel': 'Хостел', 'guest_house': 'Гостевой дом', 'museum': 'Музей', 'attraction': 'Достопримечательность',
   'artwork': 'Арт-объект', 'gallery': 'Галерея', 'apartment': 'Апартаменты', 'viewpoint': 'Смотровая'},
 'leisure': {'park': 'Парк', 'fitness_centre': 'Фитнес', 'sports_centre': 'Спорткомплекс', 'stadium': 'Стадион', 'garden': 'Сад', 'water_park': 'Аквапарк'},
}
DEFAULT = {'shop': 'Магазин', 'office': 'Офис', 'healthcare': 'Медицина', 'craft': 'Мастерская', 'amenity': 'Место', 'tourism': 'Туризм', 'leisure': 'Отдых'}
pois = {}
for f in sorted(glob.glob('/home/claude/osm_poi/p*.json')):
    for e in json.load(open(f))['elements']:
        t = e.get('tags', {}); nm = t.get('name:ru') or t.get('name')
        if not nm: continue
        c = e.get('center') or e
        if 'lat' not in c: continue
        cat = None
        for k in ('amenity', 'shop', 'tourism', 'leisure', 'office', 'healthcare', 'craft'):
            if k in t:
                cat = CAT.get(k, {}).get(t[k]) or DEFAULT[k]; break
        if not cat: continue
        x, z = xz(c['lat'], c['lon'])
        sub = cat
        if t.get('addr:street') and t.get('addr:housenumber'): sub += ' · ' + t['addr:street'] + ', ' + t['addr:housenumber']
        if t.get('opening_hours'): sub += ' · ' + t['opening_hours']
        pois[(e['type'], e['id'])] = [nm, 1, x, z, sub]
search += list(pois.values())
print('мест (POI):', len(pois), '| записей поиска:', len(search))
json.dump({'items': search}, open(OUT.replace('city.json', 'search.json'), 'w'), ensure_ascii=False, separators=(',', ':'))

# сортируем площади: сначала большие (чтобы мелкие рисовались поверх)
areas.sort(key=lambda a: a[0])
out = {'v': 2, 'origin': [LAT0, LON0], 'scale': 0.1, 'names': names, 'buildings': B, 'bmeta': bmeta, 'osmTime': osm_time, 'roads': roads, 'roadMeta': road_meta,
       'areas': areas, 'waterways': waterways, 'trees': trees, 'treeScale': tree_s, 'lamps': [round(v * 10) for v in lamps], 'labels': labels,
       'attribution': '© участники OpenStreetMap (ODbL)'}
json.dump(out, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
import os
print(f"зданий: {len(B)} (высота известна: {stats['known_h']}, оценена: {stats['guess_h']}), дорог: {len(roads)}, площадей/зелени/воды: {len(areas)}, рек: {len(waterways)}, деревьев: {len(trees)//2}, подписей: {len(labels)}")
print('размер файла:', round(os.path.getsize(OUT) / 1e6, 2), 'МБ')
