# ============================================================
#  terrain.py — «ГЕОДЕЗИСТ»
#  1) Рельеф: Copernicus DEM GLO-30 → сетки высот для города (25 м)
#     и окрестностей с горами (200 м).
#  2) Спутник: плитки Sentinel-2 cloudless 2016 (EOX, CC BY 4.0) →
#     две текстуры (город ~7 м/пикс, окрестности ~56 м/пикс).
#  Результат: data/terrain.json, data/sat_city.jpg, data/sat_region.jpg
# ============================================================
import json, math, os, io, subprocess, sys
import numpy as np, rasterio
from PIL import Image

ROOT = '/home/claude/bishkek3d'
DEM = '/home/claude/geo/dem_N42_E074.tif'
TILE_DIR = '/home/claude/geo/tiles'
LAT0, LON0 = 42.8762, 74.6038
MLAT = 111130.0
MLON = 111320.0 * math.cos(math.radians(LAT0))
R_EARTH = 6371000.0

def latlon(x, z): return LAT0 - z / MLAT, LON0 + x / MLON

src = rasterio.open(DEM); dem = src.read(1).astype(np.float64); T = src.transform
def sample(lat, lon):
    """билинейная интерполяция высоты (м над уровнем моря)"""
    c = (lon - T.c) / T.a - 0.5; r = (lat - T.f) / T.e - 0.5
    c0 = np.clip(np.floor(c).astype(int), 0, dem.shape[1] - 2); r0 = np.clip(np.floor(r).astype(int), 0, dem.shape[0] - 2)
    fc = np.clip(c - c0, 0, 1); fr = np.clip(r - r0, 0, 1)
    a = dem[r0, c0] * (1 - fc) + dem[r0, c0 + 1] * fc
    b = dem[r0 + 1, c0] * (1 - fc) + dem[r0 + 1, c0 + 1] * fc
    return a * (1 - fr) + b * fr
BASE = float(sample(np.array([LAT0]), np.array([LON0]))[0])
print('высота площади Ала-Тоо:', round(BASE, 1), 'м')

def grid(x0, x1, z0, z1, step, curvature=False):
    xs = np.arange(x0, x1 + step, step); zs = np.arange(z0, z1 + step, step)
    X, Z = np.meshgrid(xs, zs)
    lat, lon = latlon(X, Z)
    H = sample(lat, lon) - BASE
    if curvature: H -= (X ** 2 + Z ** 2) / (2 * R_EARTH)  # кривизна Земли для дальних гор
    return {'x0': float(x0), 'z0': float(z0), 'step': step, 'nx': len(xs), 'nz': len(zs), 'h': [int(round(v * 10)) for v in H.ravel()]}

city = json.load(open(f'{ROOT}/data/city.json'))
cx = [r[5 + 2 * i] / 10 for r in city['buildings'] for i in range(0, r[4], max(1, r[4]))]
cz = [r[6 + 2 * i] / 10 for r in city['buildings'] for i in range(0, r[4], max(1, r[4]))]
X0, X1, Z0, Z1 = min(cx) - 600, max(cx) + 600, min(cz) - 600, max(cz) + 600
fine = grid(X0, X1, Z0, Z1, 25)
# окрестности: от Чуйской долины на севере до хребта Кыргызского Ала-Тоо на юге
rx0, rz0 = (74.25 - LON0) * MLON, -(42.985 - LAT0) * MLAT
rx1, rz1 = (74.95 - LON0) * MLON, -(42.47 - LAT0) * MLAT
region = grid(rx0, rx1, rz0, rz1, 200, curvature=True)
print('город:', fine['nx'], '×', fine['nz'], '| окрестности:', region['nx'], '×', region['nz'])

# ---------- спутник: плитки Web Mercator ----------
def merc(lat, lon, z):
    n = 2 ** z; x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y
def stitch(x0, x1, z0, z1, z, name):
    la_n, lo_w = latlon(x0, z0); la_s, lo_e = latlon(x1, z1)
    tx0, ty0 = merc(la_n, lo_w, z); tx1, ty1 = merc(la_s, lo_e, z)
    c0, c1, r0, r1 = int(tx0), int(tx1), int(ty0), int(ty1)
    img = Image.new('RGB', ((c1 - c0 + 1) * 256, (r1 - r0 + 1) * 256))
    os.makedirs(TILE_DIR, exist_ok=True)
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            fn = f'{TILE_DIR}/{z}_{r}_{c}.jpg'
            if not os.path.exists(fn):
                url = f'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{r}/{c}.jpg'
                for _ in range(3):
                    if subprocess.run(['curl', '-s', '-m', '30', '-o', fn, '-w', '%{http_code}', url], capture_output=True, text=True).stdout == '200': break
            try: img.paste(Image.open(fn).convert('RGB'), ((c - c0) * 256, (r - r0) * 256))
            except Exception as e: print('нет плитки', z, r, c, e)
    # обрезаем ровно по границам сетки
    px0, py0 = (tx0 - c0) * 256, (ty0 - r0) * 256; px1, py1 = (tx1 - c0) * 256, (ty1 - r0) * 256
    img = img.crop((int(px0), int(py0), int(math.ceil(px1)), int(math.ceil(py1))))
    W = min(img.width, 4096); img = img.resize((W, round(img.height * W / img.width)), Image.LANCZOS) if img.width > 4096 else img
    img.save(f'{ROOT}/data/{name}', quality=82, optimize=True, progressive=True)
    # возвращаем меркаторские границы картинки (в долях плитки z) для расчёта UV
    return {'file': name, 'z': z, 'mx0': c0 + int(px0) / 256, 'my0': r0 + int(py0) / 256, 'mx1': c0 + int(math.ceil(px1)) / 256, 'my1': r0 + int(math.ceil(py1)) / 256, 'w': img.width, 'h': img.height}

sat_city = stitch(X0, X1, Z0, Z1, 14, 'sat_city.jpg')
sat_region = stitch(rx0, rx1, rz0, rz1, 11, 'sat_region.jpg')
print('спутник: город', sat_city['w'], '×', sat_city['h'], '| окрестности', sat_region['w'], '×', sat_region['h'])

out = {
    'base': round(BASE, 1), 'origin': [LAT0, LON0], 'fine': fine, 'region': region, 'satCity': sat_city, 'satRegion': sat_region,
    'sources': {
        'dem': 'Copernicus DEM GLO-30 © DLR e.V. 2010–2014 и © Airbus Defence and Space GmbH 2014–2018, предоставлено в рамках программы Copernicus (ЕС и ЕКА)',
        'sat': 'Sentinel-2 cloudless — https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 & 2017), CC BY 4.0',
    },
}
json.dump(out, open(f'{ROOT}/data/terrain.json', 'w'), separators=(',', ':'))
print('terrain.json:', round(os.path.getsize(f'{ROOT}/data/terrain.json') / 1e6, 2), 'МБ')
for f in ('sat_city.jpg', 'sat_region.jpg'): print(f, round(os.path.getsize(f'{ROOT}/data/{f}') / 1e6, 2), 'МБ')
