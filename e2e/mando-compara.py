#!/usr/bin/env python3
"""Compara dos carpetas de e2e/mando-capturas.js: píxel a píxel cada escena y el registro de órdenes.

Uso: python3 e2e/mando-compara.py ANTES DESPUES [--diff CARPETA]
  --diff  guarda, por cada escena distinta, una imagen con los píxeles cambiados en rojo sobre la de DESPUES.
Sale con 1 si hay alguna diferencia (escena distinta, que falta o sobra, u órdenes distintas). Necesita Pillow.
"""
import argparse
import difflib
import pathlib
import sys

from PIL import Image, ImageChops


def changed_mask(a, b):
    """Máscara (L) con 255 donde algún canal difiere."""
    d = ImageChops.difference(a, b)
    m = None
    for ch in d.split():
        ch = ch.point(lambda v: 255 if v else 0)
        m = ch if m is None else ImageChops.lighter(m, ch)
    return m


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('antes')
    ap.add_argument('despues')
    ap.add_argument('--diff', help='carpeta para las imágenes de diferencias')
    o = ap.parse_args()
    A, B = pathlib.Path(o.antes), pathlib.Path(o.despues)
    D = pathlib.Path(o.diff) if o.diff else None
    if D:
        D.mkdir(parents=True, exist_ok=True)
    bad = 0
    names = sorted({p.name for p in A.glob('*.png')} | {p.name for p in B.glob('*.png')})
    w = max([len(n) for n in names] + [10])
    print(f"{'escena':<{w}}  píxeles distintos")
    for n in names:
        pa, pb = A / n, B / n
        if not pa.exists() or not pb.exists():
            print(f"{n[:-4]:<{w}}  {'solo en ' + (str(A) if pa.exists() else str(B))}")
            bad += 1
            continue
        ia, ib = Image.open(pa).convert('RGBA'), Image.open(pb).convert('RGBA')
        if ia.size != ib.size:
            print(f"{n[:-4]:<{w}}  100 % (tamaño {ia.size} frente a {ib.size})")
            bad += 1
            continue
        m = changed_mask(ia, ib)
        total = ia.size[0] * ia.size[1]
        k = total - m.histogram()[0]
        pct = 100 * k / total
        print(f"{n[:-4]:<{w}}  {pct:.4f} % ({k} px)" + (f"  zona {m.getbbox()}" if k else ''))
        if k:
            bad += 1
            if D:
                red = Image.new('RGBA', ib.size, (255, 0, 0, 255))
                Image.composite(red, ib, m).save(D / n)
    print(f"\n{len(names) - bad} de {len(names)} escenas iguales")

    la, lb = A / 'ordenes.txt', B / 'ordenes.txt'
    ta = la.read_text().splitlines() if la.exists() else []
    tb = lb.read_text().splitlines() if lb.exists() else []
    diff = list(difflib.unified_diff(ta, tb, str(la), str(lb), lineterm='', n=2))
    if diff:
        bad += 1
        print('\nÓrdenes distintas:')
        print('\n'.join(diff))
    else:
        print(f'Órdenes iguales ({len(ta)} líneas)')
    for f in ('errores.txt',):
        for c in (A, B):
            t = (c / f).read_text().strip() if (c / f).exists() else ''
            if t:
                bad += 1
                print(f'\nErrores en {c}:\n{t}')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
