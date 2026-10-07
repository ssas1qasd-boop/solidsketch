// SolidSketch Web — 2D drawing exchange: DWG/DXF entities → closed loops; DXF (R12) writer.
(function (root) {
  const TAU = Math.PI * 2;
  const rad = d => d * Math.PI / 180;

  // ------------------------------------------------------------ entity → polyline points
  function arcPoints(cx, cy, r, a0, a1, ccw = true) {
    let sweep = a1 - a0; if (ccw) { while (sweep <= 1e-12) sweep += TAU; } else { while (sweep >= -1e-12) sweep -= TAU; }
    const n = Math.max(2, Math.ceil(Math.abs(sweep) / (TAU / 96))); const pts = [];
    for (let i = 0; i <= n; i++) { const a = a0 + sweep * i / n; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    return pts;
  }
  /** DXF bulge arc between p and q (bulge = tan(included/4)). */
  function bulgePoints(p, q, bulge) {
    if (Math.abs(bulge) < 1e-12) return [p, q];
    const theta = 4 * Math.atan(bulge); const dx = q[0] - p[0], dy = q[1] - p[1]; const chord = Math.hypot(dx, dy); if (chord < 1e-12) return [p];
    const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2; const h = Math.sqrt(Math.max(0, r * r - chord * chord / 4));
    const nx = -dy / chord, ny = dx / chord; const s = bulge > 0 ? 1 : -1;
    const cx = mx - s * h * nx, cy = my - s * h * ny;
    const a0 = Math.atan2(p[1] - cy, p[0] - cx), a1 = Math.atan2(q[1] - cy, q[0] - cx);
    const n = Math.max(2, Math.ceil(Math.abs(theta) / (TAU / 96))); const pts = [];
    let sweep = a1 - a0; if (bulge > 0) { while (sweep <= 0) sweep += TAU; } else { while (sweep >= 0) sweep -= TAU; }
    for (let i = 0; i <= n; i++) { const a = a0 + sweep * i / n; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    return pts;
  }
  function polylineWithBulges(verts, closed) {
    const pts = []; const n = verts.length; if (n < 2) return { pts: verts.map(v => [v.x, v.y]), closed };
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = verts[i], b = verts[(i + 1) % n]; const seg = bulgePoints([a.x, a.y], [b.x, b.y], a.bulge || 0);
      for (let k = 0; k < seg.length - 1; k++) pts.push(seg[k]);
      if (i === segs - 1 && !closed) pts.push(seg[seg.length - 1]);
    }
    return { pts, closed };
  }
  function catmullRom(P, closed) {
    const out = []; const n = P.length; if (n < 2) return P;
    const get = i => P[closed ? (i + n) % n : Math.min(n - 1, Math.max(0, i))];
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) { const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
      for (let s = 0; s < 8; s++) { const t = s / 8, t2 = t * t, t3 = t2 * t;
        out.push([0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
                  0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)]); } }
    if (!closed) out.push(P[n - 1]);
    return out;
  }
  /** De Boor evaluation of a (possibly rational) B-spline. */
  function bspline(ctrl, degree, knots, weights) {
    const n = ctrl.length; if (n < 2) return ctrl.map(c => [c[0], c[1]]);
    if (!knots || knots.length < n + degree + 1) { knots = []; for (let i = 0; i < n + degree + 1; i++) knots.push(Math.min(Math.max(i - degree, 0), n - degree)); }
    const t0 = knots[degree], t1 = knots[n]; const samples = Math.max(16, 8 * (n - degree)); const out = [];
    for (let s = 0; s <= samples; s++) {
      const t = s === samples ? t1 - 1e-12 : t0 + (t1 - t0) * s / samples;
      let k = degree; while (k < n - 1 && t >= knots[k + 1]) k++;
      const d = []; for (let j = 0; j <= degree; j++) { const c = ctrl[k - degree + j]; const w = weights && weights.length === n ? weights[k - degree + j] : 1; d.push([c[0] * w, c[1] * w, w]); }
      for (let r = 1; r <= degree; r++) for (let j = degree; j >= r; j--) { const i = k - degree + j; const den = knots[i + degree - r + 1] - knots[i]; const a = den === 0 ? 0 : (t - knots[i]) / den;
        d[j] = [d[j - 1][0] * (1 - a) + d[j][0] * a, d[j - 1][1] * (1 - a) + d[j][1] * a, d[j - 1][2] * (1 - a) + d[j][2] * a]; }
      out.push([d[degree][0] / d[degree][2], d[degree][1] / d[degree][2]]);
    }
    return out;
  }

  /** Converts a list of entities (libredwg DwgDatabase shape, or our DXF parser's) into polylines in drawing units. */
  function curvesFromEntities(entities, blocks, opts = {}) {
    const out = []; let skipped = 0; const skippedTypes = {};
    const xform = opts.xform || (p => p);
    const push = (pts, closed) => { const q = pts.map(p => xform(p)); if (q.length >= 2) out.push({ pts: q, closed }); };
    for (const e of entities || []) {
      try {
        switch (e.type) {
          case 'LINE': push([[e.startPoint.x, e.startPoint.y], [e.endPoint.x, e.endPoint.y]], false); break;
          case 'LWPOLYLINE': case 'POLYLINE2D': { const closed = !!((e.flag || 0) & 1); const r = polylineWithBulges(e.vertices || [], closed); push(r.pts, closed); break; }
          case 'POLYLINE3D': push((e.vertices || []).map(v => [v.x, v.y]), !!((e.flag || 0) & 1)); break;
          case 'CIRCLE': { const p = arcPoints(e.center.x, e.center.y, e.radius, 0, TAU); p.pop(); push(p, true); break; }
          case 'ARC': push(arcPoints(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle), false); break;
          case 'ELLIPSE': {
            const c = e.center, m = e.majorAxisEndPoint, ratio = e.axisRatio; let a0 = e.startAngle || 0, a1 = e.endAngle == null ? TAU : e.endAngle; while (a1 <= a0 + 1e-12) a1 += TAU;
            const closed = Math.abs(a1 - a0 - TAU) < 1e-6; const n = Math.max(8, Math.ceil((a1 - a0) / (TAU / 96))); const pts = [];
            for (let i = 0; i <= (closed ? n - 1 : n); i++) { const t = a0 + (a1 - a0) * i / n; pts.push([c.x + m.x * Math.cos(t) - m.y * ratio * Math.sin(t), c.y + m.y * Math.cos(t) + m.x * ratio * Math.sin(t)]); }
            push(pts, closed); break;
          }
          case 'SPLINE': {
            const closed = !!((e.flag || 0) & 1);
            if (e.fitPoints && e.fitPoints.length >= 2) push(catmullRom(e.fitPoints.map(p => [p.x, p.y]), closed), closed);
            else if (e.controlPoints && e.controlPoints.length >= 2) push(bspline(e.controlPoints.map(p => [p.x, p.y]), e.degree || 3, e.knots, e.weights), closed);
            break;
          }
          case 'INSERT': {
            const depth = opts.depth || 0; const blk = blocks && blocks[e.name];
            if (!blk || depth > 4) { skipped++; skippedTypes.INSERT = (skippedTypes.INSERT || 0) + 1; break; }
            const sx = e.xScale ?? e.scaleFactors?.x ?? 1, sy = e.yScale ?? e.scaleFactors?.y ?? 1, rot = e.rotation || 0, ip = e.insertionPoint || { x: 0, y: 0 }, bp = blk.basePoint || { x: 0, y: 0 };
            const cr = Math.cos(rot), sr = Math.sin(rot);
            const local = p => { const x = (p[0] - bp.x) * sx, y = (p[1] - bp.y) * sy; return xform([ip.x + x * cr - y * sr, ip.y + x * sr + y * cr]); };
            const sub = curvesFromEntities(blk.entities, blocks, { xform: local, depth: depth + 1 });
            out.push(...sub.curves); skipped += sub.skipped; break;
          }
          default: skipped++; skippedTypes[e.type] = (skippedTypes[e.type] || 0) + 1;
        }
      } catch (err) { skipped++; }
    }
    return { curves: out, skipped, skippedTypes };
  }

  // ------------------------------------------------------------ chaining into loops
  function chainCurves(curves) {
    const closed = [], open = []; const pending = [];
    for (const c of curves) { const pts = dedupe(c.pts); if (pts.length < 2) continue; if (c.closed || (pts.length >= 3 && dist(pts[0], pts[pts.length - 1]) < 1e-9)) { if (dist(pts[0], pts[pts.length - 1]) < 1e-9) pts.pop(); if (pts.length >= 3) closed.push(pts); } else pending.push(pts); }
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const c of curves) for (const p of c.pts) { minx = Math.min(minx, p[0]); miny = Math.min(miny, p[1]); maxx = Math.max(maxx, p[0]); maxy = Math.max(maxy, p[1]); }
    const tol = Math.max(1e-6, Math.hypot(maxx - minx, maxy - miny) * 1e-4);
    const used = new Array(pending.length).fill(false);
    for (let i = 0; i < pending.length; i++) {
      if (used[i]) continue; used[i] = true; let chain = pending[i].slice(); let guard = 0; let closedChain = false;
      while (guard++ < pending.length + 2) {
        const head = chain[0], tail = chain[chain.length - 1];
        if (chain.length >= 3 && dist(head, tail) < tol) { chain.pop(); closedChain = true; break; }
        let found = false;
        for (let j = 0; j < pending.length; j++) {
          if (used[j]) continue; const q = pending[j];
          if (dist(tail, q[0]) < tol) { chain = chain.concat(q.slice(1)); used[j] = true; found = true; break; }
          if (dist(tail, q[q.length - 1]) < tol) { chain = chain.concat(q.slice(0, -1).reverse()); used[j] = true; found = true; break; }
          if (dist(head, q[q.length - 1]) < tol) { chain = q.slice(0, -1).concat(chain); used[j] = true; found = true; break; }
          if (dist(head, q[0]) < tol) { chain = q.slice(1).reverse().concat(chain); used[j] = true; found = true; break; }
        }
        if (!found) break;
      }
      if (!closedChain && chain.length >= 3 && dist(chain[0], chain[chain.length - 1]) < tol) { chain.pop(); closedChain = true; }
      if (closedChain) closed.push(chain); else open.push(chain);
    }
    return { closed: closed.filter(l => Math.abs(area(l)) > 1e-12), open };
  }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const dedupe = pts => { const out = []; for (const p of pts) if (!out.length || dist(out[out.length - 1], p) > 1e-9) out.push([p[0], p[1]]); return out; };
  function area(l) { let a = 0; for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
  function pointIn(p, l) { let inside = false; for (let i = 0, j = l.length - 1; i < l.length; j = i++) { const a = l[i], b = l[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; } return inside; }
  /** Groups loops into regions: outer loops (even nesting depth) with the holes directly inside them. */
  function loopsToRegions(loops) {
    const depth = loops.map((l, i) => loops.reduce((d, o, j) => d + (j !== i && pointIn(l[0], o) ? 1 : 0), 0));
    const regions = [];
    loops.forEach((l, i) => { if (depth[i] % 2 === 0) regions.push({ outer: area(l) < 0 ? l.slice().reverse() : l, holes: [], idx: i }); });
    loops.forEach((l, i) => { if (depth[i] % 2 === 1) { let best = null; regions.forEach(r => { if (pointIn(l[0], loops[r.idx]) && (best == null || Math.abs(area(loops[r.idx])) < Math.abs(area(loops[best.idx])))) best = r; }); if (best) best.holes.push(area(l) > 0 ? l.slice().reverse() : l); } });
    return regions;
  }
  function bounds(loops) { let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity; for (const l of loops) for (const p of l) { minx = Math.min(minx, p[0]); miny = Math.min(miny, p[1]); maxx = Math.max(maxx, p[0]); maxy = Math.max(maxy, p[1]); } return { minx, miny, maxx, maxy, w: maxx - minx, h: maxy - miny }; }

  // ------------------------------------------------------------ DXF text parser (no WebAssembly needed)
  function parseDxf(text) {
    const lines = text.split(/\r\n|\r|\n/); const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) { const code = parseInt(lines[i].trim(), 10); if (isNaN(code)) { i--; continue; } pairs.push([code, lines[i + 1].trim()]); }
    let i = 0; let section = null; let insunits = 0; const entities = []; const blocks = {}; let curBlock = null; let cur = null; let curPoly = null;
    const flush = () => { if (cur) { if (curPoly && cur.type === 'VERTEX') { curPoly.vertices.push({ x: cur.x || 0, y: cur.y || 0, bulge: cur.bulge || 0 }); cur = null; return; } if (cur.type === 'SEQEND') { cur = null; if (curPoly) { target().push(curPoly); curPoly = null; } return; } if (cur.type === 'POLYLINE') { curPoly = { type: 'POLYLINE2D', flag: cur.flag || 0, vertices: [] }; cur = null; return; } target().push(cur); cur = null; } };
    const target = () => curBlock ? curBlock.entities : entities;
    for (; i < pairs.length; i++) {
      const [code, val] = pairs[i];
      if (code === 0) {
        if (val === 'SECTION') { section = pairs[i + 1] && pairs[i + 1][0] === 2 ? pairs[i + 1][1] : null; i++; continue; }
        if (val === 'ENDSEC') { flush(); section = null; continue; }
        if (val === 'EOF') break;
        if (section === 'BLOCKS') { flush(); if (val === 'BLOCK') { curBlock = { name: '', basePoint: { x: 0, y: 0 }, entities: [] }; cur = { type: '_BLOCK' }; continue; } if (val === 'ENDBLK') { if (curBlock) blocks[curBlock.name] = curBlock; curBlock = null; cur = null; continue; } }
        if (section === 'ENTITIES' || section === 'BLOCKS') { flush(); cur = newEntity(val); continue; }
        continue;
      }
      if (section === 'HEADER') { if (code === 9 && val === '$INSUNITS' && pairs[i + 1] && pairs[i + 1][0] === 70) insunits = parseInt(pairs[i + 1][1], 10) || 0; continue; }
      if (!cur) continue;
      if (cur.type === '_BLOCK' && curBlock) { if (code === 2) curBlock.name = val; if (code === 10) curBlock.basePoint.x = +val; if (code === 20) curBlock.basePoint.y = +val; continue; }
      applyCode(cur, code, val);
    }
    flush();
    return { entities, blocks, insunits };
  }
  function newEntity(type) {
    const e = { type };
    if (type === 'LWPOLYLINE') { e.flag = 0; e.vertices = []; }
    if (type === 'SPLINE') { e.flag = 0; e.degree = 3; e.knots = []; e.controlPoints = []; e.fitPoints = []; e.weights = []; e._cp = null; e._fp = null; }
    if (type === 'LINE') { e.startPoint = { x: 0, y: 0 }; e.endPoint = { x: 0, y: 0 }; }
    if (type === 'CIRCLE' || type === 'ARC') { e.center = { x: 0, y: 0 }; e.radius = 0; e.startAngle = 0; e.endAngle = TAU; }
    if (type === 'ELLIPSE') { e.center = { x: 0, y: 0 }; e.majorAxisEndPoint = { x: 1, y: 0 }; e.axisRatio = 1; e.startAngle = 0; e.endAngle = TAU; }
    if (type === 'INSERT') { e.name = ''; e.insertionPoint = { x: 0, y: 0 }; e.xScale = 1; e.yScale = 1; e.rotation = 0; }
    return e;
  }
  function applyCode(e, code, val) {
    const f = parseFloat(val);
    switch (e.type) {
      case 'LINE': if (code === 10) e.startPoint.x = f; else if (code === 20) e.startPoint.y = f; else if (code === 11) e.endPoint.x = f; else if (code === 21) e.endPoint.y = f; break;
      case 'LWPOLYLINE': if (code === 70) e.flag = parseInt(val, 10); else if (code === 10) e.vertices.push({ x: f, y: 0, bulge: 0 }); else if (code === 20 && e.vertices.length) e.vertices[e.vertices.length - 1].y = f; else if (code === 42 && e.vertices.length) e.vertices[e.vertices.length - 1].bulge = f; break;
      case 'POLYLINE': if (code === 70) e.flag = parseInt(val, 10); break;
      case 'VERTEX': if (code === 10) e.x = f; else if (code === 20) e.y = f; else if (code === 42) e.bulge = f; break;
      case 'CIRCLE': case 'ARC': if (code === 10) e.center.x = f; else if (code === 20) e.center.y = f; else if (code === 40) e.radius = f; else if (code === 50) e.startAngle = rad(f); else if (code === 51) e.endAngle = rad(f); break;
      case 'ELLIPSE': if (code === 10) e.center.x = f; else if (code === 20) e.center.y = f; else if (code === 11) e.majorAxisEndPoint.x = f; else if (code === 21) e.majorAxisEndPoint.y = f; else if (code === 40) e.axisRatio = f; else if (code === 41) e.startAngle = f; else if (code === 42) e.endAngle = f; break;
      case 'SPLINE':
        if (code === 70) e.flag = parseInt(val, 10); else if (code === 71) e.degree = parseInt(val, 10); else if (code === 40) e.knots.push(f); else if (code === 41) e.weights.push(f);
        else if (code === 10) { e._cp = { x: f, y: 0 }; e.controlPoints.push(e._cp); } else if (code === 20 && e._cp) e._cp.y = f;
        else if (code === 11) { e._fp = { x: f, y: 0 }; e.fitPoints.push(e._fp); } else if (code === 21 && e._fp) e._fp.y = f; break;
      case 'INSERT': if (code === 2) e.name = val; else if (code === 10) e.insertionPoint.x = f; else if (code === 20) e.insertionPoint.y = f; else if (code === 41) e.xScale = f; else if (code === 42) e.yScale = f; else if (code === 50) e.rotation = rad(f); break;
    }
  }
  const UNIT_NAMES = { 0: 'unitless', 1: 'inches', 2: 'feet', 4: 'mm', 5: 'cm', 6: 'm', 14: 'dm' };

  // ------------------------------------------------------------ DXF writer (R12: readable by everything)
  /** items: [{layer, kind:'polyline'|'line', pts:[[x,y,z]...], closed}] */
  function writeDxf(items) {
    const fmt = v => (Math.round(v * 1e6) / 1e6).toString(); const L = []; const pair = (c, v) => { L.push(String(c)); L.push(String(v)); };
    const layers = [...new Set(items.map(it => it.layer || '0'))];
    pair(999, 'Created by SolidSketch (units: model grid units)');
    pair(0, 'SECTION'); pair(2, 'HEADER'); pair(9, '$ACADVER'); pair(1, 'AC1009'); pair(0, 'ENDSEC');
    pair(0, 'SECTION'); pair(2, 'TABLES'); pair(0, 'TABLE'); pair(2, 'LAYER'); pair(70, layers.length);
    for (const ly of layers) { pair(0, 'LAYER'); pair(2, ly); pair(70, 0); pair(62, 7); pair(6, 'CONTINUOUS'); }
    pair(0, 'ENDTAB'); pair(0, 'ENDSEC');
    pair(0, 'SECTION'); pair(2, 'BLOCKS'); pair(0, 'ENDSEC');
    pair(0, 'SECTION'); pair(2, 'ENTITIES');
    for (const it of items) {
      const layer = it.layer || '0';
      if (it.kind === 'line') { const [a, b] = it.pts; pair(0, 'LINE'); pair(8, layer); pair(10, fmt(a[0])); pair(20, fmt(a[1])); pair(30, fmt(a[2] || 0)); pair(11, fmt(b[0])); pair(21, fmt(b[1])); pair(31, fmt(b[2] || 0)); continue; }
      const planar = it.pts.every(p => Math.abs(p[2] || 0) < 1e-9);
      pair(0, 'POLYLINE'); pair(8, layer); pair(66, 1); pair(70, (it.closed ? 1 : 0) | (planar ? 0 : 8)); pair(10, 0); pair(20, 0); pair(30, 0);
      for (const p of it.pts) { pair(0, 'VERTEX'); pair(8, layer); pair(10, fmt(p[0])); pair(20, fmt(p[1])); pair(30, fmt(p[2] || 0)); if (!planar) pair(70, 32); }
      pair(0, 'SEQEND'); pair(8, layer);
    }
    pair(0, 'ENDSEC'); pair(0, 'EOF');
    return L.join('\r\n') + '\r\n';
  }

  root.CadIO = { curvesFromEntities, chainCurves, loopsToRegions, bounds, parseDxf, writeDxf, UNIT_NAMES, area };
})(typeof window !== 'undefined' ? window : globalThis);
