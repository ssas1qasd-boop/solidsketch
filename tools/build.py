#!/usr/bin/env python3
"""Assemble src/ into one self-contained HTML file: python3 tools/build.py out.html

The editable sources are src/page.html, src/core.js, src/dxf.js, src/app.js and src/tail.html. The large vendor blobs
(three.js, the Manifold / OpenCascade / libredwg WebAssembly) are not kept as separate files in git: when src/vendor/ is
missing they are taken from solidsketch_v23.html, which carries them unchanged."""
import sys, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
s = root / 'src'
V = {'three.html': (190, 4172), 'wasm-b64.html': (4173, 4173), 'occ.html': (4174, 4307),
     'dwg-wasm-b64.html': (4308, 4308), 'manifold.html': (4309, 4313), 'dwg.html': (7368, 7410)}
if not all((s / 'vendor' / k).exists() for k in V):
    lines = (root / 'solidsketch_v23.html').read_text(encoding='utf-8').split('\n')
    (s / 'vendor').mkdir(exist_ok=True)
    for k, (a, b) in V.items():
        (s / 'vendor' / k).write_text('\n'.join(lines[a - 1:b]), encoding='utf-8')
r = lambda p: (s / p).read_text(encoding='utf-8')
js = lambda p: '<script>\n' + r(p) + '\n</script>'
html = '\n'.join([
    r('page.html'), r('vendor/three.html'), r('vendor/wasm-b64.html'), r('vendor/occ.html'),
    r('vendor/dwg-wasm-b64.html'), r('vendor/manifold.html'), js('core.js'), js('dxf.js'),
    r('vendor/dwg.html'), js('app.js'), r('tail.html'),
])
pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'solidsketch.html').write_text(html, encoding='utf-8')
