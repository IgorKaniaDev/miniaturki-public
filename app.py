"""Local IdoSell thumbnail studio. Run: python app.py --open."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import hashlib
import ipaddress
import json
import math
from pathlib import Path
import re
import socket
from threading import Lock
from urllib.parse import urlparse, parse_qs
from urllib.request import Request, urlopen, HTTPRedirectHandler, build_opener
import uuid
import webbrowser
import xml.etree.ElementTree as ET
import zipfile

from PIL import Image, ImageOps, ImageFilter

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / '.cache'
OUTPUT = ROOT / 'output'
CATALOGS = {}
JOBS = {}
POOL = ThreadPoolExecutor(max_workers=2)
BG_SESSION = None
BG_SESSION_LOCK = Lock()
MAX_BYTES = 40 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 40_000_000


def local(tag):
    return tag.rsplit('}', 1)[-1]


def parse_catalog(data):
    text = data.decode('utf-8-sig')
    if '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():
        raise ValueError('XML z deklaracjami DTD nie jest obsługiwany.')
    root = ET.fromstring(text)
    products = {}
    for p in root.iter():
        if local(p.tag) != 'product':
            continue
        pid = p.get('id', '')
        if not re.fullmatch(r'[0-9]+', pid):
            continue
        name = next((e.text for d in p if local(d.tag) == 'description'
                     for e in d if local(e.tag) == 'name' and e.text), pid)
        brand = next((e.get('name', '') for e in p if local(e.tag) == 'producer'), '')
        images = next((e for e in p if local(e.tag) == 'images'), None)
        urls = []
        if images is not None:
            groups = {local(e.tag): e for e in images}
            group = groups.get('originals')
            if group is None or not len(group):
                group = groups.get('large')
            if group is not None:
                urls.extend(e.get('url', '') for e in group)
            for e in images.iter():
                if local(e.tag) == 'icon':
                    urls.append(next((v for k, v in e.attrib.items() if local(k) == 'url_originals'), e.get('url', '')))
        urls = list(dict.fromkeys(u for u in urls if urlparse(u).scheme in ('http', 'https')))
        products[pid] = {'id': pid, 'name': name, 'brand': brand, 'images': urls}
    if not products:
        raise ValueError('Nie znaleziono produktów w XML.')
    return products


def check_url(url):
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username:
        raise ValueError('Nieprawidłowy adres zdjęcia.')
    for info in socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80)):
        if not ipaddress.ip_address(info[4][0]).is_global:
            raise ValueError('Adres zdjęcia musi być publiczny.')


class PublicRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_image(url):
    CACHE.mkdir(exist_ok=True)
    path = CACHE / (hashlib.sha256(url.encode()).hexdigest() + '.img')
    if path.exists():
        return path.read_bytes()
    check_url(url)
    with build_opener(PublicRedirect()).open(Request(url, headers={'User-Agent': 'ThumbnailStudio/1.0'}), timeout=25) as response:
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('Zdjęcie przekracza 40 MB.')
    with Image.open(BytesIO(data)) as im:
        im.verify()
    temp = path.with_suffix('.' + uuid.uuid4().hex + '.tmp')
    temp.write_bytes(data)
    temp.replace(path)
    return data


def background_session():
    global BG_SESSION
    with BG_SESSION_LOCK:
        if BG_SESSION is None:
            from rembg import new_session
            BG_SESSION = new_session('u2net')
    return BG_SESSION


@lru_cache(maxsize=8)
def _prepare_image(data, remove_bg):
    im = ImageOps.exif_transpose(Image.open(BytesIO(data))).convert('RGBA')
    im.thumbnail((1800, 1800), Image.Resampling.LANCZOS)
    if remove_bg and im.getchannel('A').getextrema() == (255, 255):
        from rembg import remove
        cutout = remove(im, session=background_session(), post_process_mask=True,
                        decontaminate=True).convert('RGBA')
        # Trim antialiased source-background pixels left at the product boundary.
        alpha = cutout.getchannel('A').filter(ImageFilter.MinFilter(5))
        cutout.putalpha(alpha.filter(ImageFilter.GaussianBlur(.5)))
        im = cutout
    bounds = im.getbbox()
    if bounds is None:
        raise ValueError('Po usunięciu tła zdjęcie jest puste. Wyłącz usuwanie tła.')
    return im.crop(bounds)


def prepare_image(data, remove_bg):
    return _prepare_image(data, remove_bg).copy()


def compose(urls, remove_bg=True, size=2560, frames=None):
    if size != 2560:
        # Preview the decoded export, including its exact crop and WebP encoding.
        with Image.open(BytesIO(compose(urls, remove_bg, frames=frames))) as exported:
            exported.thumbnail((size, size), Image.Resampling.LANCZOS)
            result = BytesIO()
            exported.save(result, 'WEBP', lossless=True)
            return result.getvalue()
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    margin = round(size * .045)
    cell_w = (size - 2 * margin) // len(urls)
    cell_h = size - margin * 2
    for i, url in enumerate(urls):
        im = prepare_image(fetch_image(url), remove_bg)
        frame = (frames or [{} for _ in urls])[i]
        zoom, x, y = frame.get('zoom', 1), frame.get('x', .5), frame.get('y', .5)
        scale = min(cell_w / im.width, cell_h / im.height) * zoom
        width, height = max(1, round(im.width * scale)), max(1, round(im.height * scale))
        left = round((cell_w - width) * x) if width <= cell_w else -round((width - cell_w) * x)
        top = round((cell_h - height) * y) if height <= cell_h else -round((height - cell_h) * y)
        # Render directly into the fixed cell. This also bounds memory for large zooms.
        if zoom == 1:
            fitted = ImageOps.contain(im.convert('RGBa'), (cell_w, cell_h), Image.Resampling.LANCZOS).convert('RGBA')
            cell = Image.new('RGBA', (cell_w, cell_h), (0, 0, 0, 0))
            cell.paste(fitted, (round((cell_w - fitted.width) * x), round((cell_h - fitted.height) * y)))
        else:
            cell = im.convert('RGBa').transform((cell_w, cell_h), Image.Transform.AFFINE,
                                (1 / scale, 0, -left / scale, 0, 1 / scale, -top / scale),
                                Image.Resampling.BICUBIC, fillcolor=(0, 0, 0, 0)).convert('RGBA')
        canvas.alpha_composite(cell, (margin + i * cell_w, margin))
    result = BytesIO()
    canvas.save(result, 'WEBP', quality=94, method=4)
    return result.getvalue()


def resolve_items(body):
    catalog = CATALOGS[body['catalog']]
    items = body['items']
    if not isinstance(items, list) or not 1 <= len(items) <= 5000:
        raise ValueError('Wybierz od 1 do 5000 produktów.')
    resolved = []
    seen = set()
    for item in items:
        pid, indexes = item['id'], item['images']
        mode = item.get('mode', 'double')
        if mode not in ('single', 'double'):
            raise ValueError('Nieprawidłowy tryb miniaturki.')
        count = 1 if mode == 'single' else 2
        if pid in seen or not isinstance(indexes, list) or len(indexes) != count or len(set(indexes)) != count:
            raise ValueError('Wybierz właściwą liczbę różnych zdjęć dla każdego produktu.')
        seen.add(pid)
        urls = catalog[pid]['images']
        if any(type(i) is not int or i < 0 or i >= len(urls) for i in indexes):
            raise ValueError('Nieprawidłowy wybór zdjęć.')
        remove_bg = item.get('removeBg', body.get('removeBg', True))
        if type(remove_bg) is not bool:
            raise ValueError('Ustawienie usuwania tła musi być wartością logiczną.')
        frames = item.get('frames', [{} for _ in indexes])
        if not isinstance(frames, list) or len(frames) != count:
            raise ValueError('Nieprawidłowe ustawienia kadru.')
        for frame in frames:
            if not isinstance(frame, dict):
                raise ValueError('Nieprawidłowe ustawienia kadru.')
            for key, default, low, high in (('x', .5, 0, 1), ('y', .5, 0, 1), ('zoom', 1, 1, 20)):
                value = frame.get(key, default)
                if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
                    raise ValueError('Nieprawidłowe ustawienia kadru.')
        resolved.append((pid, [urls[i] for i in indexes], remove_bg, frames))
    return resolved


def run_job(jid, items):
    job = JOBS[jid]
    directory = OUTPUT / jid
    try:
        directory.mkdir(parents=True)
        for pid, urls, remove_bg, frames in items:
            job['products'][pid] = {'status': 'processing'}
            try:
                (directory / (pid + '.webp')).write_bytes(compose(urls, remove_bg, frames=frames))
                job['products'][pid] = {'status': 'done'}
            except Exception as exc:
                job['products'][pid] = {'status': 'error', 'message': str(exc)}
            job['finished'] += 1
        with zipfile.ZipFile(directory / 'miniaturki.zip', 'w', zipfile.ZIP_STORED) as archive:
            for path in directory.glob('*.webp'):
                archive.write(path, path.name)
        job['status'] = 'done'
    except Exception as exc:
        job.update(status='error', message=str(exc))


class Handler(BaseHTTPRequestHandler):
    def send(self, data, mime='application/json', code=200):
        if not isinstance(data, bytes):
            data = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            q = parse_qs(parsed.query)
            if parsed.path in ('/', '/app.js', '/style.css'):
                name = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css'}[parsed.path]
                mime = {'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8'}[name]
                return self.send((ROOT / 'static' / name).read_bytes(), mime)
            if parsed.path == '/api/sample':
                files = sorted((ROOT / 'input files').glob('*.xml'))
                if not files:
                    raise ValueError('Brak przykładowego XML. Wczytaj własny plik.')
                return self.import_xml(files[0].read_bytes())
            if parsed.path == '/api/image':
                url = CATALOGS[q['catalog'][0]][q['id'][0]]['images'][int(q['index'][0])]
                im = ImageOps.exif_transpose(Image.open(BytesIO(fetch_image(url))))
                im.thumbnail((640, 640))
                buf = BytesIO()
                im.convert('RGBA').save(buf, 'WEBP', quality=85)
                return self.send(buf.getvalue(), 'image/webp')
            if parsed.path == '/api/prepared-image':
                url = CATALOGS[q['catalog'][0]][q['id'][0]]['images'][int(q['index'][0])]
                im = prepare_image(fetch_image(url), q.get('removeBg', ['true'])[0] == 'true')
                buf = BytesIO()
                im.save(buf, 'WEBP', quality=94)
                return self.send(buf.getvalue(), 'image/webp')
            if parsed.path.startswith('/api/jobs/'):
                return self.send(JOBS[parsed.path.rsplit('/', 1)[-1]])
            if re.fullmatch(r'/download/[a-f0-9]{32}', parsed.path):
                return self.send((OUTPUT / parsed.path.rsplit('/', 1)[-1] / 'miniaturki.zip').read_bytes(), 'application/zip')
            self.send({'error': 'Nie znaleziono.'}, code=404)
        except Exception as exc:
            self.send({'error': str(exc)}, code=400)

    def import_xml(self, data):
        catalog = parse_catalog(data)
        cid = uuid.uuid4().hex
        CATALOGS[cid] = catalog
        self.send({'catalog': cid, 'products': [{'id': p['id'], 'name': p['name'], 'brand': p['brand'], 'count': len(p['images'])} for p in catalog.values()]})

    def do_POST(self):
        try:
            origin = self.headers.get('Origin')
            if origin and origin != 'http://' + self.headers.get('Host', ''):
                raise ValueError('Niedozwolone źródło żądania.')
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length <= MAX_BYTES:
                raise ValueError('Plik musi mieć od 1 bajtu do 40 MB.')
            data = self.rfile.read(length)
            if self.path == '/api/import':
                return self.import_xml(data)
            body = json.loads(data)
            items = resolve_items(body)
            if self.path == '/api/preview':
                return self.send(compose(items[0][1], items[0][2], 768, items[0][3]), 'image/webp')
            if self.path == '/api/generate':
                if any(j['status'] == 'running' for j in JOBS.values()):
                    raise ValueError('Poczekaj na zakończenie bieżącej partii.')
                jid = uuid.uuid4().hex
                JOBS[jid] = {'id': jid, 'status': 'running', 'total': len(items), 'finished': 0,
                             'products': {pid: {'status': 'queued'} for pid, _, _, _ in items}}
                POOL.submit(run_job, jid, items)
                return self.send({'id': jid})
            self.send({'error': 'Nie znaleziono.'}, code=404)
        except Exception as exc:
            self.send({'error': str(exc)}, code=400)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--open', action='store_true')
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'Miniaturki Studio: http://127.0.0.1:{args.port}', flush=True)
    if args.open:
        webbrowser.open(f'http://127.0.0.1:{args.port}')
    server.serve_forever()
