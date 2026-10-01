"""Descarga modelos CC0 de Poly Haven (formato .blend 1k con sus texturas) a art/models/<id>/."""
import json, os, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

opener = urllib.request.build_opener()
opener.addheaders = [('User-Agent', 'epocas-art-fetch/1.0')]
urllib.request.install_opener(opener)

MODELS = sys.argv[1:]
BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models')

def get(url, path):
    if os.path.exists(path):
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    urllib.request.urlretrieve(url, path)

def fetch(mid):
    info = json.load(urllib.request.urlopen(f'https://api.polyhaven.com/files/{mid}'))
    res = info['blend'].get('1k') or next(iter(info['blend'].values()))
    b = res['blend']
    jobs = [(b['url'], os.path.join(BASE, mid, f'{mid}.blend'))]
    jobs += [(v['url'], os.path.join(BASE, mid, k)) for k, v in b.get('include', {}).items()]
    for u, p in jobs:
        get(u, p)
    return mid

with ThreadPoolExecutor(8) as ex:
    for m in ex.map(fetch, MODELS):
        print('ok', m)
