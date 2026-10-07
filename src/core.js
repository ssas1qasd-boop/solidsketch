// SolidSketch Web — geometry core. Two interchangeable engines behind one API:
//   CadCore.ManifoldCore(wasm)  exact mesh booleans via Manifold (WebAssembly)
//   CadCore.JsCore(csg|null)    pure JavaScript; booleans via three-bvh-csg when available
// Coordinates: Z up, sketch plane is Z = 0. Testable in Node.
(function (root) {
  // ======================================================= shared helpers
  const SEG = 128;
  let common_extra = {};
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  /** Column-major 4x4 that scales by s = [sx, sy, sz] about the point p (p itself stays put). */
  function scaleAbout(p, s) {
    return [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, p[0] * (1 - s[0]), p[1] * (1 - s[1]), p[2] * (1 - s[2]), 1];
  }
  /** Points a scale pivot snaps to: the body's corners, its edge midpoints, its face centres and its centre. */
  function scaleSnapPoints(md) {
    const P = md.positions; const pts = []; const seen = new Set(); const add = q => { const k = fkey(q[0], q[1], q[2]); if (!seen.has(k)) { seen.add(k); pts.push(q); } };
    let chains = []; try { chains = edgeChains(md); } catch (e) { chains = []; }
    for (const ch of chains) { const pp = ch.closed ? [...ch.pts, ch.pts[0]] : ch.pts; for (let i = 0; i < pp.length; i++) { if (!ch.closed || i < pp.length - 1) add(pp[i]); if (i + 1 < pp.length) add([(pp[i][0] + pp[i + 1][0]) / 2, (pp[i][1] + pp[i + 1][1]) / 2, (pp[i][2] + pp[i + 1][2]) / 2]); } }
    for (const s of md.surfs || []) if (s.planar) add(s.c.slice());
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < P.length; i += 3) { x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]); y0 = Math.min(y0, P[i + 1]); y1 = Math.max(y1, P[i + 1]); z0 = Math.min(z0, P[i + 2]); z1 = Math.max(z1, P[i + 2]); }
    if (isFinite(x0)) add([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]);
    return pts;
  }
  /** Diagonal of the axis-aligned box around a flat xyz array (0 when empty). */
  function bboxDiag(P, np = 3) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i + 2 < P.length; i += np) { const x = P[i], y = P[i + 1], z = P[i + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    return x1 >= x0 ? Math.hypot(x1 - x0, y1 - y0, z1 - z0) : 0;
  }
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const keyOf = (P, i) => `${Math.round(P[i * 3] * 1e5)},${Math.round(P[i * 3 + 1] * 1e5)},${Math.round(P[i * 3 + 2] * 1e5)}`;

  function triNormal(P, a, b, c, out) {
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
    const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; out[0] = nx / l; out[1] = ny / l; out[2] = nz / l; return out;
  }
  function signedVolume(P, I) {
    let v = 0;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
    }
    return v / 6;
  }
  function cleanProfile(profile) {
    const out = [];
    for (const p of profile) { const q = [p[0], p[1]]; if (!out.length || Math.hypot(out[out.length - 1][0] - q[0], out[out.length - 1][1] - q[1]) > 1e-6) out.push(q); }
    if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-6) out.pop();
    return out;
  }
  function signedArea(pts) { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
  /** Ear clipping of a simple polygon (CCW). Returns flat index triples. */
  function earClip(pts) {
    const n = pts.length; if (n < 3) return [];
    const idx = pts.map((_, i) => i); if (signedArea(pts) < 0) idx.reverse();
    const out = []; const cr = (a, b, c) => (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const inside = (p, a, b, c) => cr(a, b, p) >= 0 && cr(b, c, p) >= 0 && cr(c, a, p) >= 0;
    let guard = 0;
    while (idx.length > 3 && guard++ < 20000) {
      let clipped = false;
      for (let i = 0; i < idx.length; i++) {
        const m = idx.length, i0 = idx[(i + m - 1) % m], i1 = idx[i], i2 = idx[(i + 1) % m];
        const a = pts[i0], b = pts[i1], c = pts[i2];
        if (cr(a, b, c) <= 1e-9) continue;
        let blocked = false;
        for (const j of idx) { if (j === i0 || j === i1 || j === i2) continue; if (inside(pts[j], a, b, c)) { blocked = true; break; } }
        if (blocked) continue;
        out.push(i0, i1, i2); idx.splice(i, 1); clipped = true; break;
      }
      if (!clipped) { for (let k = 1; k < idx.length - 1; k++) out.push(idx[0], idx[k], idx[k + 1]); return out; }
    }
    out.push(...idx); return out;
  }
  /** Feature-edge angle: dihedral angles below this are one smooth surface. Curved faces are tessellated at 2.8–5.6° per
   *  facet, so 12° keeps them smooth while a drafted wall meeting a straight one (10–20°) stays a real crease. */
  const EDGE_ANGLE = 12;
  /**
   * Triangle normals/areas plus edge adjacency keyed by welded (position-identical) vertices. Sliver triangles — the
   * needle-thin scraps CSG leaves along seams, whose normals are numerical noise — are flagged degenerate so nothing
   * downstream trusts them.
   */
  function meshTopology(P, I) {
    const nt = I.length / 3;
    const vkey = new Map(); const canon = new Int32Array(P.length / 3);
    for (let i = 0; i < canon.length; i++) { const k = keyOf(P, i); let c = vkey.get(k); if (c === undefined) { c = i; vkey.set(k, i); } canon[i] = c; }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { if (P[i + k] < min[k]) min[k] = P[i + k]; if (P[i + k] > max[k]) max[k] = P[i + k]; }
    const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
    const normals = new Float32Array(nt * 3), area = new Float32Array(nt), degenerate = new Uint8Array(nt);
    const minAlt = 2e-6 * diag, minArea = 1e-12 * diag * diag;
    for (let t = 0; t < nt; t++) {
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz);
      const e0 = Math.hypot(ux, uy, uz), e1 = Math.hypot(vx, vy, vz), e2 = Math.hypot(P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]);
      const longest = Math.max(e0, e1, e2) || 1; area[t] = l / 2;
      if (l < 1e-30 || l / 2 < minArea || l / longest < minAlt) degenerate[t] = 1;
      else { normals[t * 3] = nx / l; normals[t * 3 + 1] = ny / l; normals[t * 3 + 2] = nz / l; }
    }
    const edges = new Map();
    for (let t = 0; t < nt; t++) for (let e = 0; e < 3; e++) {
      const a = canon[I[t * 3 + e]], b = canon[I[t * 3 + (e + 1) % 3]]; if (a === b) continue;
      const k = a < b ? a + '_' + b : b + '_' + a;
      let rec = edges.get(k); if (!rec) { rec = { a, b, tris: [] }; edges.set(k, rec); } rec.tris.push(t);
    }
    return { nt, canon, normals, area, degenerate, edges, diag };
  }
  const triDot = (N, s, t) => N[s * 3] * N[t * 3] + N[s * 3 + 1] * N[t * 3 + 1] + N[s * 3 + 2] * N[t * 3 + 2];
  /** Edges where two real (non-sliver) triangles meet at more than angleDeg: the lines a CAD drawing shows. */
  function featureEdges(topo, P, angleDeg = EDGE_ANGLE, surfID = null) {
    const cosLimit = Math.cos(angleDeg * Math.PI / 180); const out = []; const N = topo.normals, D = topo.degenerate;
    for (const { a, b, tris } of topo.edges.values()) {
      // a crease inside one smooth surface (a loft's side where a square corner fades into a circle) is not a CAD edge
      if (surfID && tris.length === 2 && surfID[tris[0]] === surfID[tris[1]]) continue;
      let sharp = false;
      for (let i = 0; i < tris.length && !sharp; i++) { if (D[tris[i]]) continue; for (let j = i + 1; j < tris.length; j++) { if (D[tris[j]]) continue; if (triDot(N, tris[i], tris[j]) < cosLimit) { sharp = true; break; } } }
      if (sharp) out.push(P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2]);
    }
    return new Float32Array(out);
  }
  /** Groups triangles into smooth surfaces (a cylinder wall is one surface, a box has six). Slivers join a neighbour. */
  function smoothSurfaces(topo, angleDeg = EDGE_ANGLE, P = null, I = null, origin = null) {
    const { nt, normals: N, degenerate: D } = topo; const cosLimit = Math.cos(angleDeg * Math.PI / 180);
    const parent = new Int32Array(nt); for (let i = 0; i < nt; i++) parent[i] = i;
    const real = new Uint8Array(nt); for (let i = 0; i < nt; i++) real[i] = D[i] ? 0 : 1;   // does the group hold a real (non-sliver) triangle?
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) { parent[a] = b; real[b] |= real[a]; } };
    // Flat patches (exactly coplanar neighbours). Across a smooth edge two patches only join when they are strips of similar
    // width — the facets of one cylinder, cone, fillet or bent wall — so a large flat face never swallows a thin strip that
    // is merely tangent to it (a fillet stays its own face, and so do the faces beside it).
    let patchOf = null, patchVerts = null;
    if (P && I) {
      const pp = new Int32Array(nt); for (let i = 0; i < nt; i++) pp[i] = i; const pf = i => { while (pp[i] !== i) { pp[i] = pp[pp[i]]; i = pp[i]; } return i; };
      const tol = 1e-6 * topo.diag;
      // coplanar = the smaller triangle's corners lie on the larger one's plane (thin triangles have noisy normals, so the
      // plane of the better-shaped one decides)
      for (const { tris } of topo.edges.values()) {
        if (tris.length !== 2 || D[tris[0]] || D[tris[1]] || triDot(N, tris[0], tris[1]) < 0.999) continue;
        const big = topo.area[tris[0]] >= topo.area[tris[1]] ? tris[0] : tris[1], small = big === tris[0] ? tris[1] : tris[0];
        const o = topo.canon[I[big * 3]] * 3; let ok = true;
        for (let e = 0; e < 3; e++) { const c = topo.canon[I[small * 3 + e]] * 3; if (Math.abs(N[big * 3] * (P[c] - P[o]) + N[big * 3 + 1] * (P[c + 1] - P[o + 1]) + N[big * 3 + 2] * (P[c + 2] - P[o + 2])) > tol) ok = false; }
        if (ok) { const a = pf(tris[0]), b = pf(tris[1]); if (a !== b) pp[a] = b; }
      }
      patchOf = new Int32Array(nt); patchVerts = new Map();
      for (let t = 0; t < nt; t++) { const r = pf(t); patchOf[t] = r; let s = patchVerts.get(r); if (!s) { s = new Set(); patchVerts.set(r, s); } for (let e = 0; e < 3; e++) s.add(topo.canon[I[t * 3 + e]]); }
    }
    const widthCache = new Map();
    const widthAcross = (patch, a, b) => {
      const key = patch + ':' + a + '_' + b; let w = widthCache.get(key); if (w !== undefined) return w;
      const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2]; let dx = P[b * 3] - ax, dy = P[b * 3 + 1] - ay, dz = P[b * 3 + 2] - az; const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
      w = 0; for (const c of patchVerts.get(patch)) { const x = P[c * 3] - ax, y = P[c * 3 + 1] - ay, z = P[c * 3 + 2] - az; const f = x * dx + y * dy + z * dz; const d2 = x * x + y * y + z * z - f * f; if (d2 > w) w = d2; }
      w = Math.sqrt(w); widthCache.set(key, w); return w;
    };
    // Two different flat patches meeting at a smooth (tangent) edge: triangles made by different operations (a fillet and
    // the face it runs into) stay separate faces; otherwise a large flat face never swallows a thin strip beside it.
    // how far a patch spreads along the shared edge's own direction
    const alongCache = new Map();
    const extentAlong = (patch, a, b) => {
      const key = patch + ':' + a + '_' + b; let w = alongCache.get(key); if (w !== undefined) return w;
      const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2]; let dx = P[b * 3] - ax, dy = P[b * 3 + 1] - ay, dz = P[b * 3 + 2] - az; const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
      let lo = Infinity, hi = -Infinity; for (const c of patchVerts.get(patch)) { const f = (P[c * 3] - ax) * dx + (P[c * 3 + 1] - ay) * dy + (P[c * 3 + 2] - az) * dz; if (f < lo) lo = f; if (f > hi) hi = f; }
      w = hi - lo; alongCache.set(key, w); return w;
    };
    const canJoin = (t, u, a, b) => {
      if (origin && origin[t] !== origin[u]) return false;
      const wa = widthAcross(patchOf[t], a, b), wb = widthAcross(patchOf[u], a, b);
      if (!(Math.max(wa, wb) > 0.15 * topo.diag && Math.min(wa, wb) < 0.3 * Math.max(wa, wb))) return true;
      // the wide one is only a sliver along the edge — a long facet running away from it (a straight stretch of a swept tube,
      // meeting the facets of the bend): part of one curved surface, not a big flat face beside a thin strip
      const big = wa >= wb ? patchOf[t] : patchOf[u];
      return extentAlong(big, a, b) < 0.2 * Math.max(wa, wb);
    };
    // A ruled crease: two flat strips that each run a long way straight away from their shared edge, meeting at a real
    // angle (a cone sitting on a cylinder, a lathe profile's corner, a draft on a wall). However gentle, that is a CAD edge,
    // not two facets of one curved surface — those meet along their long sides, or in short rows of a swept surface.
    const creaseCos = Math.cos(1.5 * Math.PI / 180), bendCos = Math.cos(3 * Math.PI / 180);   // bendCos: more of a bend than the step between neighbouring strips
    const longStrips = (t, u, a, b) => [patchOf[t], patchOf[u]].every(pt => widthAcross(pt, a, b) > 0.02 * topo.diag);
    // the bend across a triangle's other edges (to real neighbours): along a cone or cylinder it is the small step between
    // strips; a seam bends far more than that
    const dirOf = (p, q) => { const d = [P[q * 3] - P[p * 3], P[q * 3 + 1] - P[p * 3 + 1], P[q * 3 + 2] - P[p * 3 + 2]]; const l = Math.hypot(d[0], d[1], d[2]) || 1; return [d[0] / l, d[1] / l, d[2] / l]; };
    const otherBend = (t, a, b) => { let m = 0; const ab = dirOf(a, b); for (let e = 0; e < 3; e++) { const p = topo.canon[I[t * 3 + e]], q = topo.canon[I[t * 3 + (e + 1) % 3]]; if ((p === a && q === b) || (p === b && q === a) || p === q) continue;
        const pq = dirOf(p, q); if (Math.abs(pq[0] * ab[0] + pq[1] * ab[1] + pq[2] * ab[2]) > 0.7) continue;   // edges running along the same line (the rest of a zig-zag seam) are not the step between strips
        const rec = topo.edges.get(p < q ? p + '_' + q : q + '_' + p); if (!rec) continue; for (const w of rec.tris) if (w !== t && !D[w]) { const d = triDot(N, t, w); if (d > -0.5) m = Math.max(m, Math.acos(Math.min(1, d))); } } return m; };
    const bendSeam = (t, u, a, b) => { if (!I) return false; const ang = Math.acos(Math.min(1, triDot(N, t, u))); if (ang < 1.5 * Math.PI / 180) return false; const o = Math.max(otherBend(t, a, b), otherBend(u, a, b)); return ang > 1.8 * Math.max(o, 0.2 * Math.PI / 180); };   // 1.8: an oval wall bends more round its tight side, a smooth surface bends about evenly (ratio ≈ 1)
    const ruledCrease = (t, u, a, b) => { if (patchOf && bendSeam(t, u, a, b) && longStrips(t, u, a, b)) return true; if (!patchOf || triDot(N, t, u) >= creaseCos) return false;
      for (const pt of [patchOf[t], patchOf[u]]) { const w = widthAcross(pt, a, b); if (!(w > 0.02 * topo.diag) || extentAlong(pt, a, b) > 0.25 * w) return false; }   // 0.25: a rebuilt seam zig-zags a little, so its edges lean
      return true; };
    for (const { a, b, tris } of topo.edges.values()) {
      const good = []; for (const t of tris) if (!D[t]) good.push(t);
      // an edge four triangles share (two strips of a rebuilt wall touching at an X, after coincident points were merged):
      // join each pair that runs on smoothly into the other, under the same rules as an ordinary edge
      if (good.length > 2) { for (let i = 0; i < good.length; i++) for (let j = i + 1; j < good.length; j++) { const t = good[i], u = good[j];
          if (triDot(N, t, u) < cosLimit) continue; if (patchOf && patchOf[t] !== patchOf[u] && (!canJoin(t, u, a, b) || ruledCrease(t, u, a, b) || (triDot(N, t, u) < bendCos && Math.min(widthAcross(patchOf[t], a, b), widthAcross(patchOf[u], a, b)) < 1e-3 * topo.diag))) continue; union(t, u); } continue; }
      if (good.length !== 2 || triDot(N, good[0], good[1]) < cosLimit) continue;
      if (patchOf && patchOf[good[0]] !== patchOf[good[1]] && !canJoin(good[0], good[1], a, b)) continue;
      if (patchOf && patchOf[good[0]] !== patchOf[good[1]] && ruledCrease(good[0], good[1], a, b)) continue;
      // a patch with no width across this edge is a sliver lying along it (left on a rebuilt seam): it bridges nothing
      if (patchOf && patchOf[good[0]] !== patchOf[good[1]] && triDot(N, good[0], good[1]) < bendCos && Math.min(widthAcross(patchOf[good[0]], a, b), widthAcross(patchOf[good[1]], a, b)) < 1e-3 * topo.diag) continue;
      union(good[0], good[1]);
    }
    // Slivers: the real triangles around a sliver are joined to each other when their normals agree (a thin scrap at a
    // seam must not cut a cylinder wall in two), and the sliver itself joins one of them.
    const around = new Map();
    for (const { tris } of topo.edges.values()) { let deg = false; for (const t of tris) if (D[t]) { deg = true; break; } if (!deg) continue; for (const t of tris) if (D[t]) { let a = around.get(t); if (!a) { a = new Set(); around.set(t, a); } for (const u of tris) if (u !== t) a.add(u); } }
    // the sliver's longest edge stands in for the shared edge when two real neighbours are compared by width
    const sliverLine = t => { let best = -1, ab = null; for (let e = 0; e < 3; e++) { const a = topo.canon[I[t * 3 + e]], b = topo.canon[I[t * 3 + (e + 1) % 3]]; const l = Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]); if (l > best) { best = l; ab = [a, b]; } } return ab; };
    const similar = (t, u, line) => { if (!patchOf || patchOf[t] === patchOf[u] || !line || line[0] === line[1]) return true; return canJoin(t, u, line[0], line[1]) && !ruledCrease(t, u, line[0], line[1]); };   // a sliver on a seam never bridges the seam
    for (let pass = 0; pass < 3; pass++) for (const [t, nb] of around) {
      const good = []; for (const u of nb) { if (!D[u]) good.push(u); else if (find(u) !== u) good.push(u); }
      const line = P && I ? sliverLine(t) : null;
      for (let i = 0; i < good.length; i++) for (let j = i + 1; j < good.length; j++) { if (!D[good[i]] && !D[good[j]] && triDot(N, good[i], good[j]) >= cosLimit && similar(good[i], good[j], line)) union(good[i], good[j]); }
      // a sliver attaches to one surface only: once it belongs to a group with real triangles it never bridges to another
      if (good.length && !real[find(t)]) { const target = good.find(u => !D[u]) ?? good[0]; union(t, target); }
    }
    // Crumbs: a group too small to see or tap (a few microscopic triangles left where a rebuilt wall meets a hole rim) joins
    // the biggest group it touches, so it is never a face of its own
    if (topo.area) { const crumb = 1e-5 * topo.diag * topo.diag;
      for (let pass = 0; pass < 3; pass++) { const ga = new Map(); for (let t = 0; t < nt; t++) { const r = find(t); ga.set(r, (ga.get(r) || 0) + topo.area[t]); }
        const best = new Map(); let any = false;
        for (const { tris } of topo.edges.values()) for (const t of tris) { const rt = find(t); if (ga.get(rt) >= crumb) continue; for (const u of tris) { const ru = find(u); if (ru === rt) continue; const cur = best.get(rt); if (cur === undefined || ga.get(ru) > ga.get(cur)) best.set(rt, ru); } }
        for (const [rt, ru] of best) if (find(rt) !== find(ru)) { union(rt, ru); any = true; }
        if (!any) break; } }
    // Scraps: a small face (under 1% of the body's area, a few dozen triangles) that meets a big one at a gentle angle is
    // part of it — what is left of a wall where a cut runs along a knife-thin edge. It joins the neighbour it shares the
    // most edge with, so the boundary reads as one smooth line instead of a chain of tiny ones.
    if (topo.area && I) { let total = 0; for (let t = 0; t < nt; t++) total += topo.area[t];
      const scrapCos = Math.cos(20 * Math.PI / 180);
      for (let pass = 0; pass < 4; pass++) { const ga = new Map(), gn = new Map(); for (let t = 0; t < nt; t++) { const r = find(t); ga.set(r, (ga.get(r) || 0) + topo.area[t]); gn.set(r, (gn.get(r) || 0) + 1); }
        const shared = new Map();   // scrap root → Map(neighbour root → shared edge length)
        for (const { a, b, tris } of topo.edges.values()) { if (tris.length !== 2) continue; const [t, u] = tris; if (D[t] || D[u]) continue; const rt = find(t), ru = find(u); if (rt === ru) continue; if (triDot(N, t, u) < scrapCos) continue;
          const len = Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
          for (const [x, y] of [[rt, ru], [ru, rt]]) { if (!(ga.get(x) < 0.01 * total && gn.get(x) <= 40 && ga.get(y) > ga.get(x))) continue; let m = shared.get(x); if (!m) { m = new Map(); shared.set(x, m); } m.set(y, (m.get(y) || 0) + len); } }
        let any = false; for (const [x, m] of shared) { let best = null, bl = 0; for (const [y, l] of m) if (l > bl) { bl = l; best = y; } if (best !== null && find(x) !== find(best)) { union(x, best); any = true; } }
        if (!any) break; } }
    const ids = new Map(); const surfID = new Uint32Array(nt);
    for (let t = 0; t < nt; t++) { const r = find(t); let id = ids.get(r); if (id === undefined) { id = ids.size; ids.set(r, id); } surfID[t] = id; }
    return { surfID, count: ids.size };
  }
  /** Per-surface summary: area, area-weighted centre and normal, planar flag, and the planar face ids it contains. */
  function surfaceInfo(P, I, topo, surfID, count, faceID) {
    const S = Array.from({ length: count }, () => ({ area: 0, c: [0, 0, 0], n: [0, 0, 0], planar: true, faces: new Set(), tri: -1 }));
    for (let t = 0; t < topo.nt; t++) {
      const s = S[surfID[t]]; if (faceID) s.faces.add(faceID[t]); if (s.tri < 0) s.tri = t; if (topo.degenerate[t]) continue;
      const a = topo.area[t]; s.area += a;
      for (let k = 0; k < 3; k++) { s.n[k] += topo.normals[t * 3 + k] * a; s.c[k] += a * (P[I[t * 3] * 3 + k] + P[I[t * 3 + 1] * 3 + k] + P[I[t * 3 + 2] * 3 + k]) / 3; }
    }
    for (const s of S) { if (s.area > 0) for (let k = 0; k < 3; k++) s.c[k] /= s.area; const l = Math.hypot(s.n[0], s.n[1], s.n[2]); s.flat = s.area > 0 ? l / s.area : 0; if (l > 1e-12) for (let k = 0; k < 3; k++) s.n[k] /= l; }
    const cos2 = Math.cos(2 * Math.PI / 180);
    for (let t = 0; t < topo.nt; t++) { if (topo.degenerate[t]) continue; const s = S[surfID[t]]; if (s.planar && topo.normals[t * 3] * s.n[0] + topo.normals[t * 3 + 1] * s.n[1] + topo.normals[t * 3 + 2] * s.n[2] < cos2) s.planar = false; }
    return S;
  }
  /**
   * Display shading from the smooth surfaces: every vertex is split per surface (so a crease shades hard) and its normal
   * is the corner-angle-weighted mean of the real triangles of that surface around it — slivers left by booleans have no
   * say, so a cylinder or cone wall shades evenly no matter how it was triangulated.
   */
  function rebuildShading(md, P, I, topo) {
    const { nt, canon, normals: N, degenerate: D } = topo; const surfID = md.surfID, surfs = md.surfs;
    const idx = new Map(); const pos = []; const acc = []; const vsurf = []; const indices = new Uint32Array(nt * 3);
    const angleAt = (o, p, q) => { const ux = P[p] - P[o], uy = P[p + 1] - P[o + 1], uz = P[p + 2] - P[o + 2], vx = P[q] - P[o], vy = P[q + 1] - P[o + 1], vz = P[q + 2] - P[o + 2]; const l = (Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz)) || 1; return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy + uz * vz) / l))); };
    for (let t = 0; t < nt; t++) {
      const sid = surfID[t];
      for (let e = 0; e < 3; e++) {
        const c = canon[I[t * 3 + e]]; const key = c + '_' + sid; let i = idx.get(key);
        if (i === undefined) { i = pos.length / 3; idx.set(key, i); pos.push(P[c * 3], P[c * 3 + 1], P[c * 3 + 2]); acc.push(0, 0, 0); vsurf.push(sid); }
        indices[t * 3 + e] = i;
      }
      if (D[t]) continue;
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3; const w = [angleAt(a, b, c), angleAt(b, c, a), angleAt(c, a, b)];
      for (let e = 0; e < 3; e++) { const i = indices[t * 3 + e] * 3; acc[i] += w[e] * N[t * 3]; acc[i + 1] += w[e] * N[t * 3 + 1]; acc[i + 2] += w[e] * N[t * 3 + 2]; }
    }
    const normals = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) {
      const l = Math.hypot(acc[i], acc[i + 1], acc[i + 2]);
      if (l > 1e-12) { normals[i] = acc[i] / l; normals[i + 1] = acc[i + 1] / l; normals[i + 2] = acc[i + 2] / l; }
      else { const sn = surfs[vsurf[i / 3]].n; const sl = Math.hypot(sn[0], sn[1], sn[2]); if (sl > 1e-9) { normals[i] = sn[0] / sl; normals[i + 1] = sn[1] / sl; normals[i + 2] = sn[2] / sl; } else normals[i + 2] = 1; }
    }
    md.positions = new Float32Array(pos); md.normals = normals; md.indices = indices;
  }
  /** Adds feature edges, smooth-surface data and clean shading to display mesh data. topoP/topoI: the welded mesh to analyse (defaults to the display arrays). */
  function finishMesh(md, topoP, topoI) {
    const P = topoP || md.positions, I = topoI || md.indices;
    const topo = meshTopology(P, I);
    const { surfID, count } = smoothSurfaces(topo, EDGE_ANGLE, P, I, md.origin || null);
    md.edges = featureEdges(topo, P, EDGE_ANGLE, surfID);
    // tangent boundaries between surfaces (a fillet's edges) are drawn too, like the feature edges; edges beside a sliver are
    // left out (drawing them makes a boundary jog sideways at every sliver along it)
    { const N = topo.normals, D = topo.degenerate, cosLimit = Math.cos(EDGE_ANGLE * Math.PI / 180); const extra = []; const tiny = 1e-9 * topo.diag;
      for (const { a, b, tris } of topo.edges.values()) {
        if (tris.length !== 2 || surfID[tris[0]] === surfID[tris[1]] || D[tris[0]] || D[tris[1]]) continue;
        if (triDot(N, tris[0], tris[1]) < cosLimit) continue;   // already drawn as a sharp edge
        if (Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]) <= tiny) continue;
        extra.push(P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2]);
      }
      if (extra.length) { const e = new Float32Array(md.edges.length + extra.length); e.set(md.edges); e.set(extra, md.edges.length); md.edges = e; } }
    md.surfID = surfID; md.surfs = surfaceInfo(P, I, topo, surfID, count, md.faceID);
    rebuildShading(md, P, I, topo);
    return md;
  }
  /** Legacy name kept for callers/tests: feature edges of a mesh. */
  function sharpEdges(P, I, angleDeg = EDGE_ANGLE) { return featureEdges(meshTopology(P, I), P, angleDeg); }
  /** Exact key of a float32 vertex; a double from the engine hashes to the same key as its float32 display copy. */
  const fkey = (x, y, z) => Math.fround(x) + ',' + Math.fround(y) + ',' + Math.fround(z);
  /** Set of vertex keys of one smooth surface of a display mesh. */
  function surfaceVertexKeys(md, surf) {
    const keys = new Set(); const { positions: P, indices: I, surfID } = md;
    for (let t = 0; t < surfID.length; t++) if (surfID[t] === surf) for (let e = 0; e < 3; e++) { const v = I[t * 3 + e] * 3; keys.add(fkey(P[v], P[v + 1], P[v + 2])); }
    return keys;
  }
  /** Set of vertex keys of one planar face (by face id) of a display mesh. */
  function faceVertexKeys(md, faceId) {
    const keys = new Set(); const { positions: P, indices: I } = md; const faceID = planarFaceMask(md, faceId);
    for (let t = 0; t < faceID.length; t++) if (faceID[t] === faceId) for (let e = 0; e < 3; e++) { const v = I[t * 3 + e] * 3; keys.add(fkey(P[v], P[v + 1], P[v + 2])); }
    return keys;
  }
  /**
   * Returns a function that snaps a point onto the nearest of `verts` (flat xyz doubles) when within tol; a tool body
   * built from a face's float32 outline is snapped onto the body's exact vertices so booleans meet it seamlessly.
   */
  function vertexSnapper(verts, tol) {
    const cell = Math.max(tol, 1e-12); const grid = new Map(); const key = (i, j, k) => i + ',' + j + ',' + k;
    for (let v = 0; v < verts.length; v += 3) { const k = key(Math.floor(verts[v] / cell), Math.floor(verts[v + 1] / cell), Math.floor(verts[v + 2] / cell)); const a = grid.get(k); if (a) a.push(v); else grid.set(k, [v]); }
    return (x, y, z) => {
      const i = Math.floor(x / cell), j = Math.floor(y / cell), k = Math.floor(z / cell); let best = -1, bd = tol;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) { const a = grid.get(key(i + di, j + dj, k + dk)); if (!a) continue; for (const v of a) { const d = Math.hypot(verts[v] - x, verts[v + 1] - y, verts[v + 2] - z); if (d < bd) { bd = d; best = v; } } }
      return best < 0 ? null : [verts[best], verts[best + 1], verts[best + 2]];
    };
  }
  /** Translation matrix (column-major 4x4) along a unit normal. */
  const offsetMatrix = (n, d) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, n[0] * d, n[1] * d, n[2] * d, 1];
  /** Applies a column-major 4x4 matrix to a point. */
  const applyMat = (M, x, y, z) => [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]];
  /** Möller's triangle–triangle intersection test (coplanar pairs count as non-intersecting). */
  function trianglesIntersect(P, a0, a1, a2, b0, b1, b2, eps) {
    const sub = (i, j) => [P[i] - P[j], P[i + 1] - P[j + 1], P[i + 2] - P[j + 2]];
    const cr = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const at = i => [P[i], P[i + 1], P[i + 2]];
    const N2 = cr(sub(b1, b0), sub(b2, b0)); const d2 = -dot(N2, at(b0));
    { const N1p = cr(sub(a1, a0), sub(a2, a0)); const c = cr(N1p, N2); const l1 = Math.hypot(N1p[0], N1p[1], N1p[2]), l2 = Math.hypot(N2[0], N2[1], N2[2]); if (Math.hypot(c[0], c[1], c[2]) < 1e-6 * l1 * l2) return false; } // (nearly) parallel planes: coplanar, handled by the fold check
    let dv0 = dot(N2, at(a0)) + d2, dv1 = dot(N2, at(a1)) + d2, dv2 = dot(N2, at(a2)) + d2;
    const e2 = eps * Math.hypot(N2[0], N2[1], N2[2]);
    const N1 = cr(sub(a1, a0), sub(a2, a0)); const d1 = -dot(N1, at(a0));
    let du0 = dot(N1, at(b0)) + d1, du1 = dot(N1, at(b1)) + d1, du2 = dot(N1, at(b2)) + d1;
    const e1 = eps * Math.hypot(N1[0], N1[1], N1[2]);
    // nearly coplanar pair (both within a few eps of each other's plane): the line-of-intersection construction is meaningless
    // there; such pairs are either disjoint in the plane or a fold, which the fold check reports
    if (Math.max(Math.abs(dv0), Math.abs(dv1), Math.abs(dv2)) < 20 * e2 && Math.max(Math.abs(du0), Math.abs(du1), Math.abs(du2)) < 20 * e1) return false;
    if (Math.abs(dv0) < e2) dv0 = 0; if (Math.abs(dv1) < e2) dv1 = 0; if (Math.abs(dv2) < e2) dv2 = 0;
    if ((dv0 > 0 && dv1 > 0 && dv2 > 0) || (dv0 < 0 && dv1 < 0 && dv2 < 0)) return false;
    if (Math.abs(du0) < e1) du0 = 0; if (Math.abs(du1) < e1) du1 = 0; if (Math.abs(du2) < e1) du2 = 0;
    if ((du0 > 0 && du1 > 0 && du2 > 0) || (du0 < 0 && du1 < 0 && du2 < 0)) return false;
    const D = cr(N1, N2); let idx = 0; if (Math.abs(D[1]) > Math.abs(D[idx])) idx = 1; if (Math.abs(D[2]) > Math.abs(D[idx])) idx = 2;
    const iv = (v0, v1, v2, D0, D1, D2) => {
      if (D0 * D1 > 0) return [v2 + (v0 - v2) * D2 / (D2 - D0), v2 + (v1 - v2) * D2 / (D2 - D1)];
      if (D0 * D2 > 0) return [v1 + (v0 - v1) * D1 / (D1 - D0), v1 + (v2 - v1) * D1 / (D1 - D2)];
      if (D1 * D2 > 0 || D0 !== 0) return [v0 + (v1 - v0) * D0 / (D0 - D1), v0 + (v2 - v0) * D0 / (D0 - D2)];
      if (D1 !== 0) return [v1 + (v0 - v1) * D1 / (D1 - D0), v1 + (v2 - v1) * D1 / (D1 - D2)];
      if (D2 !== 0) return [v2 + (v0 - v2) * D2 / (D2 - D0), v2 + (v1 - v2) * D2 / (D2 - D1)];
      return null; // coplanar
    };
    const A = iv(P[a0 + idx], P[a1 + idx], P[a2 + idx], dv0, dv1, dv2); if (!A) return false;
    const B = iv(P[b0 + idx], P[b1 + idx], P[b2 + idx], du0, du1, du2); if (!B) return false;
    const a_lo = Math.min(A[0], A[1]), a_hi = Math.max(A[0], A[1]), b_lo = Math.min(B[0], B[1]), b_hi = Math.max(B[0], B[1]);
    const tol = eps * 10;
    return !(a_hi < b_lo + tol || b_hi < a_lo + tol);
  }
  /**
   * Checks a vertex-warp result the way a B-rep kernel refuses an invalid body: a triangle touching a moved vertex
   * that collapsed or turned inside out, a wall folded back onto itself, a triangle now piercing another part of
   * the body, or a vanished volume all mean the warp is rejected.
   */
  function warpIsValid(P0, P1, I, np) {
    let vol = 0;
    for (let t = 0; t < I.length; t += 3) { const a = I[t] * np, b = I[t + 1] * np, c = I[t + 2] * np; vol += P1[a] * (P1[b + 1] * P1[c + 2] - P1[b + 2] * P1[c + 1]) - P1[a + 1] * (P1[b] * P1[c + 2] - P1[b + 2] * P1[c]) + P1[a + 2] * (P1[b] * P1[c + 1] - P1[b + 1] * P1[c]); }
    if (!(vol / 6 > 1e-12)) return false;
    const nv = P0.length / np; const moved = new Uint8Array(nv);
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < nv; v++) { const o = v * np; for (let k = 0; k < 3; k++) { if (P1[o + k] < mn[k]) mn[k] = P1[o + k]; if (P1[o + k] > mx[k]) mx[k] = P1[o + k]; } if (Math.abs(P0[o] - P1[o]) > 1e-12 || Math.abs(P0[o + 1] - P1[o + 1]) > 1e-12 || Math.abs(P0[o + 2] - P1[o + 2]) > 1e-12) moved[v] = 1; }
    const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1; const eps = 2e-6 * diag;   // display meshes are float32: noise of ~1e-7 must not read as a touch
    const nrm = (P, a, b, c) => { const ax = P[a], ay = P[a + 1], az = P[a + 2]; const ux = P[b] - ax, uy = P[b + 1] - ay, uz = P[b + 2] - az, vx = P[c] - ax, vy = P[c + 1] - ay, vz = P[c + 2] - az; return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]; };
    const nt = I.length / 3; const touched = []; const N1 = new Float64Array(nt * 3);
    for (let t = 0; t < nt; t++) {
      const i = I[t * 3], j = I[t * 3 + 1], k = I[t * 3 + 2];
      const n1 = nrm(P1, i * np, j * np, k * np); const l1 = Math.hypot(n1[0], n1[1], n1[2]); if (l1 > 0) { N1[t * 3] = n1[0] / l1; N1[t * 3 + 1] = n1[1] / l1; N1[t * 3 + 2] = n1[2] / l1; }
      if (!(moved[i] || moved[j] || moved[k])) continue; touched.push(t);
      const n0 = nrm(P0, i * np, j * np, k * np); const l0 = Math.hypot(n0[0], n0[1], n0[2]); if (l0 < 1e-30) continue;
      if (l1 < 1e-9 * l0 || (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) / (l0 * l1) < 0.02) return false;
    }
    // folds: adjacent triangles (sharing an edge) that have folded almost flat onto each other
    const foldedBefore = (r, t) => { const nr = nrm(P0, I[r * 3] * np, I[r * 3 + 1] * np, I[r * 3 + 2] * np), ntt = nrm(P0, I[t * 3] * np, I[t * 3 + 1] * np, I[t * 3 + 2] * np); const lr = Math.hypot(nr[0], nr[1], nr[2]), lt = Math.hypot(ntt[0], ntt[1], ntt[2]); if (lr < 1e-30 || lt < 1e-30) return true; return (nr[0] * ntt[0] + nr[1] * ntt[1] + nr[2] * ntt[2]) / (lr * lt) < -0.9; };
    const isTouched = new Uint8Array(nt); for (const t of touched) isTouched[t] = 1;
    const edgeTri = new Map();
    for (let t = 0; t < nt; t++) for (let e = 0; e < 3; e++) { const a = I[t * 3 + e], b = I[t * 3 + (e + 1) % 3]; const k = a < b ? a + '_' + b : b + '_' + a; const r = edgeTri.get(k); if (r === undefined) edgeTri.set(k, t); else if (r !== t) { if (N1[r * 3] * N1[t * 3] + N1[r * 3 + 1] * N1[t * 3 + 1] + N1[r * 3 + 2] * N1[t * 3 + 2] < -0.94 && (moved[a] || moved[b] || isTouched[t] || isTouched[r]) && !foldedBefore(r, t)) return false; } }   // a knife edge the body already had is not a new fold
    // piercing: a touched triangle intersecting any triangle it does not share a vertex with
    const shares = (t, u) => { for (let e = 0; e < 3; e++) { const v = I[t * 3 + e]; if (v === I[u * 3] || v === I[u * 3 + 1] || v === I[u * 3 + 2]) return true; } return false; };
    const bb = new Float64Array(nt * 6);
    for (let t = 0; t < nt; t++) { for (let k = 0; k < 3; k++) { const a = P1[I[t * 3] * np + k], b = P1[I[t * 3 + 1] * np + k], c = P1[I[t * 3 + 2] * np + k]; bb[t * 6 + k] = Math.min(a, b, c) - eps; bb[t * 6 + 3 + k] = Math.max(a, b, c) + eps; } }
    const overlap = (t, u) => bb[t * 6] <= bb[u * 6 + 3] && bb[u * 6] <= bb[t * 6 + 3] && bb[t * 6 + 1] <= bb[u * 6 + 4] && bb[u * 6 + 1] <= bb[t * 6 + 4] && bb[t * 6 + 2] <= bb[u * 6 + 5] && bb[u * 6 + 2] <= bb[t * 6 + 5];
    // candidate pairs come from a uniform grid over the moved body, so this stays near-linear on dense meshes
    const G = Math.max(4, Math.min(64, Math.round(Math.cbrt(nt) * 1.5))); const cell = [(mx[0] - mn[0]) / G || 1, (mx[1] - mn[1]) / G || 1, (mx[2] - mn[2]) / G || 1];
    const ci = (v, k) => Math.max(0, Math.min(G - 1, Math.floor((v - mn[k]) / cell[k])));
    const grid = new Map();
    for (let u = 0; u < nt; u++) { const x0 = ci(bb[u * 6], 0), x1 = ci(bb[u * 6 + 3], 0), y0 = ci(bb[u * 6 + 1], 1), y1 = ci(bb[u * 6 + 4], 1), z0 = ci(bb[u * 6 + 2], 2), z1 = ci(bb[u * 6 + 5], 2);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) { const k = (x * G + y) * G + z; const a = grid.get(k); if (a) a.push(u); else grid.set(k, [u]); } }
    const stamp = new Int32Array(nt).fill(-1);
    for (const t of touched) {
      const x0 = ci(bb[t * 6], 0), x1 = ci(bb[t * 6 + 3], 0), y0 = ci(bb[t * 6 + 1], 1), y1 = ci(bb[t * 6 + 4], 1), z0 = ci(bb[t * 6 + 2], 2), z1 = ci(bb[t * 6 + 5], 2);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) { const a = grid.get((x * G + y) * G + z); if (!a) continue;
        for (const u of a) {
          if (stamp[u] === t) continue; stamp[u] = t;
          if (u === t || (isTouched[u] && u < t) || !overlap(t, u) || shares(t, u)) continue;
          if (trianglesIntersect(P1, I[t * 3] * np, I[t * 3 + 1] * np, I[t * 3 + 2] * np, I[u * 3] * np, I[u * 3 + 1] * np, I[u * 3 + 2] * np, eps) && !trianglesIntersect(P0, I[t * 3] * np, I[t * 3 + 1] * np, I[t * 3 + 2] * np, I[u * 3] * np, I[u * 3 + 1] * np, I[u * 3 + 2] * np, eps)) return false;   // only a touch the move makes (a knife edge the body had stays allowed)
        } }
    }
    return true;
  }
  /**
   * Smooth face moves. Moving or turning one face bends the faces around it; left alone, their triangles fold along the
   * diagonals into flat facets with stray lines, which a CAD kernel never shows. This rebuilds every bent face as one
   * smooth surface through its moved outline:
   *  - a convex four-sided face becomes a bilinear (ruled) patch, gridded so each cell turns only a few degrees;
   *  - any other planar face (polygon end caps, faces with holes, faces split by earlier booleans) is resampled and every
   *    point is placed by mean-value interpolation of the moved outline: smooth inside, straight along each edge;
   *  - a curved surface that already carries interior points (bent by an earlier move) blends each interior point
   *    between its fixed and its moved rim by distance, so a second move keeps bending it smoothly;
   *  - faces that only share a subdivided edge (the moved face itself, the fixed ones) are fanned, staying flat.
   * Edges stay straight segments between the moved corners, so neighbouring faces always meet exactly.
   * opts: stepDeg (bend per cell), maxTris (budget). Returns {P0, P1, indices, ok} — the resampled mesh before and
   * after the move (same topology) and whether no triangle turned inside out — or null when no face needs to bend.
   */
  function deformMesh(md, M, test, opts = {}) {
    const { positions: P, indices: I, surfID, surfs } = md; const nv = P.length / 3, nt = I.length / 3;
    if (!surfID || !surfs) return null;
    const T = opts.debug ? [['start', performance.now()]] : null; const mark = n => { if (T) T.push([n, performance.now()]); };
    // while dragging: coarser and quicker; on release (default): the full-quality surface
    const maxTris = opts.maxTris || (opts.live ? 3500 : 9000); let step = (opts.stepDeg || (opts.live ? 4.5 : 3)) * Math.PI / 180;
    // ---- weld, moved flags, adjacency
    const canon = new Int32Array(nv); { const seen = new Map(); for (let v = 0; v < nv; v++) { const k = fkey(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); let c = seen.get(k); if (c === undefined) { c = v; seen.set(k, v); } canon[v] = c; } }
    const moved = new Uint8Array(nv); let anyMoved = false, anyFixed = false;
    for (let v = 0; v < nv; v++) if (canon[v] === v) { if (test(P[v * 3], P[v * 3 + 1], P[v * 3 + 2])) { moved[v] = 1; anyMoved = true; } else anyFixed = true; }
    if (!anyMoved || !anyFixed) return null;
    const tv = new Int32Array(nt * 3), live = new Uint8Array(nt);
    for (let t = 0; t < nt; t++) { const a = canon[I[t * 3]], b = canon[I[t * 3 + 1]], c = canon[I[t * 3 + 2]]; tv[t * 3] = a; tv[t * 3 + 1] = b; tv[t * 3 + 2] = c; live[t] = a !== b && b !== c && a !== c ? 1 : 0; }
    const ek = (a, b) => a < b ? a + '_' + b : b + '_' + a;
    const edgeTris = new Map();
    for (let t = 0; t < nt; t++) if (live[t]) for (let e = 0; e < 3; e++) { const k = ek(tv[t * 3 + e], tv[t * 3 + (e + 1) % 3]); const r = edgeTris.get(k); if (r) r.push(t); else edgeTris.set(k, [t]); }
    for (const ts of edgeTris.values()) if (ts.length !== 2) return null; // not a closed manifold: leave it to the plain move
    const diag = bboxDiag(P) || 1;
    const V = c => [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]];
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], mul = (a, f) => [a[0] * f, a[1] * f, a[2] * f];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], len = a => Math.hypot(a[0], a[1], a[2]);
    const lerp3 = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    const angle = (a, b) => { const la = len(a), lb = len(b); if (la < 1e-30 || lb < 1e-30) return 0; return Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (la * lb)))); };
    // triangle normals; slivers (numerical noise) are flagged
    const TN = new Float64Array(nt * 3), sliver = new Uint8Array(nt);
    for (let t = 0; t < nt; t++) {
      if (!live[t]) continue; const a = V(tv[t * 3]), b = V(tv[t * 3 + 1]), c = V(tv[t * 3 + 2]); const n = cross(sub(b, a), sub(c, a)); const l = len(n);
      const longest = Math.max(len(sub(b, a)), len(sub(c, b)), len(sub(a, c))) || 1;
      if (l < 1e-30 || l / longest < 2e-6 * diag) sliver[t] = 1; else { TN[t * 3] = n[0] / l; TN[t * 3 + 1] = n[1] / l; TN[t * 3 + 2] = n[2] / l; }
    }
    // ---- curved surfaces bent before (they carry interior points): blended by distance, not resampled
    const ns = surfs.length; const sMoved = new Uint8Array(ns), sFixed = new Uint8Array(ns), sInterior = new Uint8Array(ns);
    const vA = new Int32Array(nv).fill(-1), vB = new Int32Array(nv).fill(-1), vN = new Uint8Array(nv);
    for (let t = 0; t < nt; t++) { if (!live[t]) continue; const sid = surfID[t]; for (let e = 0; e < 3; e++) { const c = tv[t * 3 + e]; if (moved[c]) sMoved[sid] = 1; else sFixed[sid] = 1; if (vA[c] < 0) { vA[c] = sid; vN[c] = 1; } else if (vA[c] !== sid) { if (vB[c] < 0) { vB[c] = sid; vN[c] = 2; } else if (vB[c] !== sid) vN[c] = 3; } } }
    for (let c = 0; c < nv; c++) if (canon[c] === c && vN[c] === 1 && !moved[c]) sInterior[vA[c]] = 1;
    const isD = new Uint8Array(ns); let anyD = false;
    for (let sid = 0; sid < ns; sid++) if (!surfs[sid].planar && sMoved[sid] && sFixed[sid] && sInterior[sid]) { isD[sid] = 1; anyD = true; }
    const Dtri = new Uint8Array(nt); const nonD = new Uint8Array(nv);
    for (let t = 0; t < nt; t++) { if (!live[t]) continue; if (isD[surfID[t]]) Dtri[t] = 1; else for (let e = 0; e < 3; e++) nonD[tv[t * 3 + e]] = 1; }
    const freeD = new Uint8Array(nv);
    if (anyD) for (let t = 0; t < nt; t++) if (Dtri[t]) for (let e = 0; e < 3; e++) { const c = tv[t * 3 + e]; if (!moved[c] && !nonD[c] && vN[c] <= 2) freeD[c] = 1; }
    // ---- planar faces: adjacent coplanar triangles (outside curved surfaces bent before)
    const par = new Int32Array(nt); for (let t = 0; t < nt; t++) par[t] = t;
    const find = t => { while (par[t] !== t) { par[t] = par[par[t]]; t = par[t]; } return t; };
    const tol = 4e-6 * diag;
    const offPlane = (t, c) => { const o = tv[t * 3] * 3; return Math.abs(TN[t * 3] * (P[c * 3] - P[o]) + TN[t * 3 + 1] * (P[c * 3 + 1] - P[o + 1]) + TN[t * 3 + 2] * (P[c * 3 + 2] - P[o + 2])); };
    for (const ts of edgeTris.values()) {
      const [s0, u0] = ts; if (Dtri[s0] || Dtri[u0]) continue;
      if (!sliver[s0] && !sliver[u0]) { const d = TN[s0 * 3] * TN[u0 * 3] + TN[s0 * 3 + 1] * TN[u0 * 3 + 1] + TN[s0 * 3 + 2] * TN[u0 * 3 + 2]; if (d < 0.9999) continue; let ok = true; for (let e = 0; e < 3; e++) if (offPlane(s0, tv[u0 * 3 + e]) > tol) ok = false; if (!ok) continue; }
      else if (sliver[s0] !== sliver[u0]) { const g = sliver[s0] ? u0 : s0, b = sliver[s0] ? s0 : u0; let ok = true; for (let e = 0; e < 3; e++) if (offPlane(g, tv[b * 3 + e]) > tol) ok = false; if (!ok) continue; }
      else continue;
      const a = find(s0), b = find(u0); if (a !== b) par[a] = b;
    }
    const groups = new Map(); for (let t = 0; t < nt; t++) if (live[t] && !Dtri[t]) { const r = find(t); const g = groups.get(r); if (g) g.push(t); else groups.set(r, [t]); }
    mark('topology+faces');
    // ---- mixed faces (some corners moved, some fixed) and their outlines
    const quads = [], polys = [], faceOf = new Int32Array(nt).fill(-1);
    for (const [root, ts] of groups) {
      let hm = false, hf = false; for (const t of ts) for (let e = 0; e < 3; e++) { if (moved[tv[t * 3 + e]]) hm = true; else hf = true; }
      if (!(hm && hf) || ts.length < 2) continue; // rigid faces, and single triangles (they stay flat), are only fanned
      const next = new Map(); let bad = false; const bset = new Set();
      for (const t of ts) for (let e = 0; e < 3; e++) { const a = tv[t * 3 + e], b = tv[t * 3 + (e + 1) % 3]; const other = edgeTris.get(ek(a, b)).find(u => u !== t); if (find(other) === root) continue; if (next.has(a)) bad = true; next.set(a, b); bset.add(ek(a, b)); }
      if (bad || !next.size) continue;
      const loops = []; const used = new Set();
      for (const s0 of next.keys()) { if (used.has(s0)) continue; const loop = []; let c = s0, guard = 0; while (!used.has(c) && guard++ < 1e6) { used.add(c); loop.push(c); c = next.get(c); if (c === undefined) { bad = true; break; } } if (bad || c !== s0) { bad = true; break; } loops.push(loop); }
      if (bad) continue;
      // face frame (original plane): Newell normal of the largest loop
      let n = [0, 0, 0]; for (const t of ts) if (!sliver[t]) { n[0] += TN[t * 3]; n[1] += TN[t * 3 + 1]; n[2] += TN[t * 3 + 2]; } const nl = len(n); if (nl < 1e-12) continue; n = mul(n, 1 / nl);
      const e1 = len(cross(n, [1, 0, 0])) > 0.3 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]); const u = mul(e1, 1 / len(e1)), w = cross(n, u);
      const o = V(loops[0][0]); const to2 = p => { const d = sub(p, o); return [dot(d, u), dot(d, w)]; };
      const face = { id: quads.length + polys.length, root, ts, loops, bset, n, to2 };
      const convexQuad = () => { if (ts.length !== 2 || loops.length !== 1 || loops[0].length !== 4) return false; const q = loops[0].map(c => to2(V(c))); for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4]; if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 1e-12 * diag * diag) return false; } return true; };
      if (convexQuad()) quads.push(face); else polys.push(face);
      for (const t of ts) faceOf[t] = face.id;
    }
    if (!quads.length && !polys.length && !anyD) return null;
    // ---- where each moved corner goes
    const over = new Map(); const mv = new Map();
    const at = c => { const q = over.get(c); if (q) return q; if (!moved[c]) return V(c); let r = mv.get(c); if (!r) { r = applyMat(M, P[c * 3], P[c * 3 + 1], P[c * 3 + 2]); mv.set(c, r); } return r; };
    // ---- points along an edge between two surfaces (left there by an earlier resampling) are not corners: when an end of
    //      that edge moves, they slide along the straight line between the edge's two ends
    const fadj = new Map();
    for (const [k, ts] of edgeTris) { if (surfID[ts[0]] === surfID[ts[1]]) continue; const [a, b] = k.split('_').map(Number); (fadj.get(a) || fadj.set(a, []).get(a)).push(b); (fadj.get(b) || fadj.set(b, []).get(b)).push(a); }
    const pinned = new Uint8Array(nv); const isInner = c => !moved[c] && vN[c] === 2 && (fadj.get(c) || []).length === 2;
    { const visited = new Uint8Array(nv);
      for (const [c, nbs] of fadj) {
        if (!isInner(c) || visited[c]) continue;
        const side = dir => { const seq = []; let prev = c, cur = dir; while (isInner(cur) && cur !== c && !visited[cur]) { visited[cur] = 1; seq.push(cur); const nb = fadj.get(cur); const nx = nb[0] === prev ? nb[1] : nb[0]; prev = cur; cur = nx; } return { seq, end: cur }; };
        visited[c] = 1; const A = side(nbs[0]), B = side(nbs[1]);
        if (A.end === c || B.end === c || isInner(A.end) || isInner(B.end)) continue; // a closed ring, or ends inside another chain
        const e0 = A.end, e1 = B.end; if (!moved[e0] && !moved[e1]) continue;
        const pts = [e0, ...A.seq.reverse(), c, ...B.seq, e1]; const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + len(sub(V(pts[i]), V(pts[i - 1])))); const tot = L[L.length - 1] || 1;
        const q0 = at(e0), q1 = at(e1);
        for (let i = 1; i < pts.length - 1; i++) { over.set(pts[i], lerp3(q0, q1, L[i] / tot)); pinned[pts[i]] = 1; }
      } }
    // ---- curved surfaces bent before: blend free points between the fixed rim (weight 0) and the moved rim (weight 1)
    if (anyD) {
      // rims per surface: a point only follows the rims of its own surface (a neighbour's rim can be nearer in plan)
      const rims = new Map(); const rim = sid => { let r = rims.get(sid); if (!r) { r = { ms: [], as: [], mp: [], ap: [], e: new Set(), v: new Set() }; rims.set(sid, r); } return r; };
      for (let t = 0; t < nt; t++) if (Dtri[t]) { const r = rim(surfID[t]); for (let e = 0; e < 3; e++) {
        const a = tv[t * 3 + e], b = tv[t * 3 + (e + 1) % 3]; const k = ek(a, b);
        if (!r.e.has(k)) { r.e.add(k); if (moved[a] && moved[b]) r.ms.push(a, b); else if (!moved[a] && !moved[b] && !freeD[a] && !freeD[b]) r.as.push(a, b); }
        if (!r.v.has(a)) { r.v.add(a); if (moved[a]) r.mp.push(a); else if (!freeD[a]) r.ap.push(a); }
      } }
      const nearest = (p, segs, pts) => { let bd = Infinity, bq = null;
        for (let i = 0; i < segs.length; i += 2) { const a = V(segs[i]), b = V(segs[i + 1]); const ab = sub(b, a); const l2 = dot(ab, ab); const f = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0; const q = lerp3(a, b, f); const d = len(sub(p, q)); if (d < bd) { bd = d; bq = q; } }
        for (const c of pts) { const q = V(c); const d = len(sub(p, q)); if (d < bd) { bd = d; bq = q; } }
        return [bd, bq]; };
      for (let c = 0; c < nv; c++) if (freeD[c] && !pinned[c]) {
        const own = [vA[c], vB[c]].filter(x => x >= 0 && rims.has(x)).map(x => rims.get(x));
        const ms = [].concat(...own.map(r => r.ms)), mp = [].concat(...own.map(r => r.mp)), as = [].concat(...own.map(r => r.as)), ap = [].concat(...own.map(r => r.ap));
        const p = V(c); const [d1, q1] = nearest(p, ms, mp); if (!q1) continue; const [d0] = nearest(p, as, ap);
        const wgt = isFinite(d0) ? d0 / (d0 + d1 || 1) : 1; const q2 = applyMat(M, q1[0], q1[1], q1[2]);
        over.set(c, add(p, mul(sub(q2, q1), wgt)));
      }
    }
    // extra bend the curved surfaces take on (fold growth between neighbouring triangles, beyond the fold they had)
    let dBend = 0;
    if (anyD) {
      const nrm = (t, f) => { const a = f(tv[t * 3]), b = f(tv[t * 3 + 1]), c = f(tv[t * 3 + 2]); return cross(sub(b, a), sub(c, a)); };
      const small = 1e-7 * diag * diag; // slivers and collapsed triangles carry no usable normal
      const growth = [];
      for (const ts of edgeTris.values()) {
        const [s0, u0] = ts; if (!Dtri[s0] || !Dtri[u0] || sliver[s0] || sliver[u0]) continue;
        const a0 = nrm(s0, V), b0 = nrm(u0, V), a1 = nrm(s0, at), b1 = nrm(u0, at); if (len(a1) < small || len(b1) < small) continue;
        growth.push(angle(a1, b1) - angle(a0, b0));
      }
      // the guess is only a first estimate (it is relaxed later), so a robust high percentile stands for the bend, not the worst outlier
      growth.sort((a, b) => a - b); if (growth.length) dBend = Math.max(0, Math.min(Math.PI / 3, growth[Math.floor(growth.length * 0.9)]));
    }
    mark('outlines+guess');
    // ---- how finely each face must be cut: edge classes (opposite sides of a quad, every edge of a polygon face) share a count
    const cls = new Map(), cpar = []; const cid = k => { let i = cls.get(k); if (i === undefined) { i = cpar.length; cls.set(k, i); cpar.push(i); } return i; };
    const cfind = i => { while (cpar[i] !== i) { cpar[i] = cpar[cpar[i]]; i = cpar[i]; } return i; };
    const cunion = (a, b) => { a = cfind(cid(a)); b = cfind(cid(b)); if (a !== b) cpar[a] = b; };
    const needs = []; // [edgeKey, bend angle]
    for (const f of quads) {
      const [A, B, Cc, D] = f.loops[0]; const a = at(A), b = at(B), c = at(Cc), d = at(D); f.corners = [A, B, Cc, D];
      const N00 = cross(sub(b, a), sub(d, a)), N10 = cross(sub(b, a), sub(c, b)), N01 = cross(sub(c, d), sub(d, a)), N11 = cross(sub(c, d), sub(c, b));
      const fu = Math.max(angle(N00, N10), angle(N01, N11)), fv = Math.max(angle(N00, N01), angle(N10, N11));
      cunion(ek(A, B), ek(D, Cc)); cunion(ek(A, D), ek(B, Cc)); needs.push([ek(A, B), fu], [ek(A, D), fv]); f.bend = Math.max(fu, fv);
    }
    for (const f of polys) {
      // bend estimate: spread of the moved outline's corner normals
      let nb = [0, 0, 0]; const cn = [];
      for (const loop of f.loops) for (let i = 0; i < loop.length; i++) {
        const p = loop[(i + loop.length - 1) % loop.length], c = loop[i], q = loop[(i + 1) % loop.length];
        const ep = sub(V(c), V(p)), eq = sub(V(q), V(c)); const o0 = cross(ep, eq); const s0 = dot(o0, f.n);
        if (Math.abs(s0) < 1e-3 * len(ep) * len(eq)) continue; // not a real corner (points along a straight edge)
        const n1 = mul(cross(sub(at(c), at(p)), sub(at(q), at(c))), Math.sign(s0)); const l = len(n1); if (l < 1e-30) continue; cn.push(mul(n1, 1 / l)); nb = add(nb, mul(n1, 1 / l));
      }
      let bend = 0; for (let i = 0; i < cn.length; i++) for (let j = i + 1; j < cn.length; j++) bend = Math.max(bend, angle(cn[i], cn[j])); f.bend = bend;
      const keys = []; for (const t of f.ts) for (let e = 0; e < 3; e++) keys.push(ek(tv[t * 3 + e], tv[t * 3 + (e + 1) % 3]));
      for (const k of keys) cunion(keys[0], k); needs.push([keys[0], bend]);
    }
    let dEdge = null;
    if (anyD) { for (let t = 0; t < nt; t++) if (Dtri[t]) for (let e = 0; e < 3; e++) { const k = ek(tv[t * 3 + e], tv[t * 3 + (e + 1) % 3]); if (dEdge === null) dEdge = k; cunion(dEdge, k); } if (dEdge !== null) needs.push([dEdge, dBend]); }
    let nD = 0; for (let t = 0; t < nt; t++) if (Dtri[t]) nD++;
    const counts = new Map();
    // a face that bends at all is cut into at least two cells (a later move must find a real surface to continue, not a fold)
    const MIN_BEND = 0.6 * Math.PI / 180;
    const computeCounts = () => { const floor = step > 15 * Math.PI / 180 ? 1 : 2; counts.clear(); for (const [k, ang] of needs) { const r = cfind(cid(k)); counts.set(r, Math.max(counts.get(r) || 1, ang < MIN_BEND ? 1 : Math.min(40, Math.max(floor, Math.ceil(ang / step - 1e-9))))); } };
    const cnt = k => { const i = cls.get(k); return i === undefined ? 1 : (counts.get(cfind(i)) || 1); };
    const estimate = () => { let n = nt; for (const f of quads) { const [A, B, , D] = f.corners; n += 2 * cnt(ek(A, B)) * cnt(ek(A, D)); } for (const f of polys) { const k = cnt(ek(tv[f.ts[0] * 3], tv[f.ts[0] * 3 + 1])); n += f.ts.length * k * k; } if (dEdge !== null) { const k = cnt(dEdge); n += nD * k * k; } return n; };
    const allowed = Math.max(maxTris, Math.round(nt * 1.3)); // a body that is already dense may grow a little, not double
    computeCounts(); while (estimate() > allowed && step < Math.PI / 2) { step *= 1.35; computeCounts(); }
    let bends = anyD; for (const v of counts.values()) if (v > 1) bends = true;
    if (!bends) return null; // every face stays flat: a plain move is exact
    // ---- mean-value interpolation of a polygon face's moved outline (Hormann & Floater; works with holes and concave outlines)
    for (const f of polys) {
      const L2 = f.loops.map(l => l.map(c => f.to2(V(c)))), L3 = f.loops.map(l => l.map(c => at(c)));
      f.mvc = p3 => {
        const x = f.to2(p3); let sw = 0; const acc = [0, 0, 0];
        for (let li = 0; li < L2.length; li++) {
          const L = L2[li], T3 = L3[li], m = L.length; const sx = new Float64Array(m), sy = new Float64Array(m), r = new Float64Array(m), tn = new Float64Array(m);
          for (let i = 0; i < m; i++) { sx[i] = L[i][0] - x[0]; sy[i] = L[i][1] - x[1]; r[i] = Math.hypot(sx[i], sy[i]); if (r[i] < 1e-12 * diag) return T3[i].slice(); }
          for (let i = 0; i < m; i++) { const j = (i + 1) % m; const A = sx[i] * sy[j] - sy[i] * sx[j], D = sx[i] * sx[j] + sy[i] * sy[j]; const den = r[i] * r[j] + D; if (Math.abs(den) < 1e-14 * r[i] * r[j]) { const f2 = r[i] / (r[i] + r[j]); return lerp3(T3[i], T3[j], f2); } tn[i] = A / den; }
          for (let i = 0; i < m; i++) { const wi = (tn[(i + m - 1) % m] + tn[i]) / r[i]; sw += wi; acc[0] += wi * T3[i][0]; acc[1] += wi * T3[i][1]; acc[2] += wi * T3[i][2]; }
        }
        return Math.abs(sw) < 1e-300 ? p3.slice() : [acc[0] / sw, acc[1] / sw, acc[2] / sw];
      };
      // points inside the face (not on its outline) follow the interpolation too
      const onLoop = new Set(); for (const l of f.loops) for (const c of l) onLoop.add(c);
      for (const t of f.ts) for (let e = 0; e < 3; e++) { const c = tv[t * 3 + e]; if (!onLoop.has(c) && !over.has(c)) over.set(c, f.mvc(V(c))); }
    }
    mark('counts+mvc-setup');
    // ---- emit the resampled mesh (P0 = before, P1 = after, shared indices)
    const P0 = [], P1 = [], out = []; const vmap = new Map(); const free = [];
    const addV = (key, p0, p1, relax) => { let i = vmap.get(key); if (i === undefined) { i = P0.length / 3; vmap.set(key, i); P0.push(p0[0], p0[1], p0[2]); P1.push(p1[0], p1[1], p1[2]); if (relax) free.push(i); } return i; };
    const inner = new Uint8Array(nv); for (const f of polys) { const onLoop = new Set(); for (const l of f.loops) for (const c of l) onLoop.add(c); for (const t of f.ts) for (let e = 0; e < 3; e++) { const c = tv[t * 3 + e]; if (!onLoop.has(c)) inner[c] = 1; } }
    const base = c => addV('v' + c, V(c), at(c), (freeD[c] && !pinned[c]) || inner[c]);
    /** Point j of n on the edge a–b (keyed from the lower id so both faces agree); inner(p0) places points of edges inside a polygon face. */
    const edgePt = (a, b, j, n, inner, relax) => {
      if (j === 0) return base(a); if (j === n) return base(b); if (a > b) return edgePt(b, a, n - j, n, inner, relax);
      const key = 'e' + a + '_' + b + '_' + j + '/' + n; const i = vmap.get(key); if (i !== undefined) return i;
      const p0 = lerp3(V(a), V(b), j / n); return addV(key, p0, inner ? inner(p0) : lerp3(at(a), at(b), j / n), !!inner || !!relax);
    };
    const tri = (a, b, c) => out.push(a, b, c);
    for (const f of quads) {
      const [A, B, Cc, D] = f.corners; const nu = cnt(ek(A, B)), nw = cnt(ek(A, D));
      const o = [V(A), V(B), V(Cc), V(D)], d = [at(A), at(B), at(Cc), at(D)];
      const bil = (q, s, r) => lerp3(lerp3(q[0], q[1], s), lerp3(q[3], q[2], s), r);
      const g = (i, j) => j === 0 ? edgePt(A, B, i, nu) : j === nw ? edgePt(D, Cc, i, nu) : i === 0 ? edgePt(A, D, j, nw) : i === nu ? edgePt(B, Cc, j, nw) : addV('q' + f.id + '_' + i + '_' + j, bil(o, i / nu, j / nw), bil(d, i / nu, j / nw));
      for (let j = 0; j < nw; j++) for (let i = 0; i < nu; i++) {
        const a = g(i, j), b = g(i + 1, j), c = g(i + 1, j + 1), e = g(i, j + 1);
        const dd = (x, y) => Math.hypot(P1[x * 3] - P1[y * 3], P1[x * 3 + 1] - P1[y * 3 + 1], P1[x * 3 + 2] - P1[y * 3 + 2]);
        if (dd(a, c) <= dd(b, e)) { tri(a, b, c); tri(a, c, e); } else { tri(a, b, e); tri(b, c, e); }
      }
    }
    for (const f of polys) {
      const k = cnt(ek(tv[f.ts[0] * 3], tv[f.ts[0] * 3 + 1]));
      for (const t of f.ts) {
        const v0 = tv[t * 3], v1 = tv[t * 3 + 1], v2 = tv[t * 3 + 2]; const p0 = V(v0), p1 = V(v1), p2 = V(v2);
        const innerFn = (a, b) => f.bset.has(ek(a, b)) ? null : f.mvc;
        const pt = (i, j) => {
          if (j === 0) return edgePt(v0, v1, i, k, innerFn(v0, v1)); if (i === 0) return edgePt(v0, v2, j, k, innerFn(v0, v2)); if (i + j === k) return edgePt(v1, v2, j, k, innerFn(v1, v2));
          const q = add(p0, add(mul(sub(p1, p0), i / k), mul(sub(p2, p0), j / k))); return addV('p' + t + '_' + i + '_' + j, q, f.mvc(q), true);
        };
        for (let j = 0; j < k; j++) for (let i = 0; i < k - j; i++) { tri(pt(i, j), pt(i + 1, j), pt(i, j + 1)); if (i + j < k - 1) tri(pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1)); }
      }
    }
    // curved surfaces bent before: every triangle cut k×k; points inside the surface are free to relax
    if (dEdge !== null) {
      const k = cnt(dEdge);
      for (let t = 0; t < nt; t++) {
        if (!Dtri[t]) continue; const v0 = tv[t * 3], v1 = tv[t * 3 + 1], v2 = tv[t * 3 + 2];
        if (k === 1) { tri(base(v0), base(v1), base(v2)); continue; }
        const inside = (a, b) => { const ts = edgeTris.get(ek(a, b)); return ts.every(u => Dtri[u]) && surfID[ts[0]] === surfID[ts[1]]; };
        const pt = (i, j) => {
          if (j === 0) return edgePt(v0, v1, i, k, null, inside(v0, v1)); if (i === 0) return edgePt(v0, v2, j, k, null, inside(v0, v2)); if (i + j === k) return edgePt(v1, v2, j, k, null, inside(v1, v2));
          const fa = 1 - (i + j) / k, fb = i / k, fc = j / k; const bary = (A, B, Cq) => [A[0] * fa + B[0] * fb + Cq[0] * fc, A[1] * fa + B[1] * fb + Cq[1] * fc, A[2] * fa + B[2] * fb + Cq[2] * fc];
          return addV('d' + t + '_' + i + '_' + j, bary(V(v0), V(v1), V(v2)), bary(at(v0), at(v1), at(v2)), true);
        };
        for (let j = 0; j < k; j++) for (let i = 0; i < k - j; i++) { tri(pt(i, j), pt(i + 1, j), pt(i, j + 1)); if (i + j < k - 1) tri(pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1)); }
      }
    }
    // every other triangle keeps its shape; edges it shares with a resampled face are fanned so no crack is left
    for (let t = 0; t < nt; t++) {
      if (!live[t] || faceOf[t] >= 0 || Dtri[t]) continue; const v = [tv[t * 3], tv[t * 3 + 1], tv[t * 3 + 2]]; const ns3 = [0, 1, 2].map(e => cnt(ek(v[e], v[(e + 1) % 3])));
      const nsub = ns3.filter(x => x > 1).length;
      if (!nsub) { tri(base(v[0]), base(v[1]), base(v[2])); continue; }
      const chain = e => { const a = v[e], b = v[(e + 1) % 3], n = ns3[e]; const r = []; for (let j = 0; j < n; j++) r.push(edgePt(a, b, j, n)); return r; };
      if (nsub === 1) { const e = ns3.findIndex(x => x > 1); const ch = [...chain(e), base(v[(e + 1) % 3])]; const apex = base(v[(e + 2) % 3]); for (let j = 0; j + 1 < ch.length; j++) tri(ch[j], ch[j + 1], apex); continue; }
      const ring = [...chain(0), ...chain(1), ...chain(2)];
      const cen = addV('f' + t, mul(add(add(V(v[0]), V(v[1])), V(v[2])), 1 / 3), mul(add(add(at(v[0]), at(v[1])), at(v[2])), 1 / 3));
      for (let i = 0; i < ring.length; i++) tri(ring[i], ring[(i + 1) % ring.length], cen);
    }
    mark('emit');
    // relax how far each free point moves toward a harmonic (smoothest) field between the fixed outline values: cotangent
    // weights from the shape before the move, Gauss–Seidel from the interpolated guess. The shape a surface already had is
    // kept; the new bend spreads evenly. This removes the creases mean-value interpolation leaves at polygon corners and
    // lets repeated bends continue smoothly across the edges between surfaces.
    if (free.length) {
      const nvo = P0.length / 3; const isFree = new Uint8Array(nvo); for (const i of free) isFree[i] = 1;
      const W = new Map(); const addW = (i, j, w) => { if (!isFree[i] && !isFree[j]) return; const k = i < j ? i * nvo + j : j * nvo + i; W.set(k, (W.get(k) || 0) + w); };
      const cot = (o, a, b) => { const u = [P0[a * 3] - P0[o * 3], P0[a * 3 + 1] - P0[o * 3 + 1], P0[a * 3 + 2] - P0[o * 3 + 2]], v = [P0[b * 3] - P0[o * 3], P0[b * 3 + 1] - P0[o * 3 + 1], P0[b * 3 + 2] - P0[o * 3 + 2]]; const c = len(cross(u, v)); return c > 1e-30 ? dot(u, v) / c : 0; };
      for (let i = 0; i < out.length; i += 3) { const a = out[i], b = out[i + 1], c = out[i + 2]; addW(b, c, 0.5 * cot(a, b, c)); addW(c, a, 0.5 * cot(b, c, a)); addW(a, b, 0.5 * cot(c, a, b)); }
      // the cotangent weights stay as they are (negative ones included): that is the exact linear finite-element Laplacian,
      // which is what keeps thin, irregular triangles from distorting the field; the system is positive definite so the sweeps converge
      // compressed neighbour lists of the free points
      const deg = new Int32Array(nvo + 1); for (const k of W.keys()) { const i = Math.floor(k / nvo), j = k % nvo; if (isFree[i]) deg[i + 1]++; if (isFree[j]) deg[j + 1]++; }
      for (let i = 0; i < nvo; i++) deg[i + 1] += deg[i];
      const nbr = new Int32Array(deg[nvo]), wt = new Float64Array(deg[nvo]), fill = deg.slice(0, nvo);
      for (const [k, w] of W) { const i = Math.floor(k / nvo), j = k % nvo; if (isFree[i]) { nbr[fill[i]] = j; wt[fill[i]++] = w; } if (isFree[j]) { nbr[fill[j]] = i; wt[fill[j]++] = w; } }
      const D3 = new Float64Array(nvo * 3); for (let i = 0; i < nvo * 3; i++) D3[i] = P1[i] - P0[i];
      const sweeps = opts.sweeps || (opts.live ? 40 : 150), stop = 1e-7 * diag;
      for (let it = 0; it < sweeps; it++) {
        let change = 0;
        for (const i of free) { let x = 0, y = 0, z = 0, ws = 0; for (let q = deg[i]; q < deg[i + 1]; q++) { const j = nbr[q], w = wt[q]; x += w * D3[j * 3]; y += w * D3[j * 3 + 1]; z += w * D3[j * 3 + 2]; ws += w; }
          if (!(ws > 1e-12)) continue; x /= ws; y /= ws; z /= ws; change = Math.max(change, Math.abs(x - D3[i * 3]), Math.abs(y - D3[i * 3 + 1]), Math.abs(z - D3[i * 3 + 2])); D3[i * 3] = x; D3[i * 3 + 1] = y; D3[i * 3 + 2] = z; }
        if (change < stop) break;
      }
      for (const i of free) for (let k = 0; k < 3; k++) P1[i * 3 + k] = P0[i * 3 + k] + D3[i * 3 + k];
    }
    mark('relax');
    // no resampled triangle may collapse or turn inside out (the same rule a plain move follows)
    let ok = true;
    for (let i = 0; i < out.length && ok; i += 3) {
      const a = out[i] * 3, b = out[i + 1] * 3, c = out[i + 2] * 3;
      const n0 = cross([P0[b] - P0[a], P0[b + 1] - P0[a + 1], P0[b + 2] - P0[a + 2]], [P0[c] - P0[a], P0[c + 1] - P0[a + 1], P0[c + 2] - P0[a + 2]]);
      const n1 = cross([P1[b] - P1[a], P1[b + 1] - P1[a + 1], P1[b + 2] - P1[a + 2]], [P1[c] - P1[a], P1[c + 1] - P1[a + 1], P1[c + 2] - P1[a + 2]]);
      const l0 = len(n0), l1 = len(n1); if (l0 < 1e-30) continue;
      if (l1 < 1e-9 * l0 || dot(n0, n1) / (l0 * l1) < 0.02) ok = false;
    }
    const res = { P0: new Float64Array(P0), P1: new Float64Array(P1), indices: new Uint32Array(out), ok };
    if (T) { mark('check'); res.timing = T.slice(1).map((m, i) => m[0] + ' ' + (m[1] - T[i][1]).toFixed(0) + 'ms').join(' | '); }
    if (opts.debug) res.stats = { inputTris: nt, stepDeg: +(step * 180 / Math.PI).toFixed(2), estimate: estimate(), quads: quads.length, polys: polys.map(f => ({ tris: f.ts.length, bend: +(f.bend * 180 / Math.PI).toFixed(1), k: cnt(ek(tv[f.ts[0] * 3], tv[f.ts[0] * 3 + 1])) })), nD, dK: dEdge !== null ? cnt(dEdge) : 0, dBend: +(dBend * 180 / Math.PI).toFixed(1), free: free.length };
    return res;
  }
  /** Coplanar triangle groups → face id per triangle. Grouped by plane (normal + offset) so CSG output with
   *  T-junctions still forms one face; connectivity is not required. */
  function planarFaceIds(P, I) {
    const nt = I.length / 3; const faceID = new Uint32Array(nt); const planes = new Map(); const n = [0, 0, 0]; let next = 0;
    for (let t = 0; t < nt; t++) {
      const a = I[t * 3] * 3; triNormal(P, I[t * 3], I[t * 3 + 1], I[t * 3 + 2], n);
      const off = n[0] * P[a] + n[1] * P[a + 1] + n[2] * P[a + 2];
      const k = `${Math.round(n[0] * 500)},${Math.round(n[1] * 500)},${Math.round(n[2] * 500)}|${Math.round(off * 2000)}`;
      let id = planes.get(k); if (id === undefined) { id = next++; planes.set(k, id); } faceID[t] = id;
    }
    return faceID;
  }
  /** Smooth normals across soft edges (< angleDeg), crisp elsewhere; returns per-corner arrays (unindexed). */
  function shadedMesh(P, I, angleDeg = 40) {
    const nt = I.length / 3; const cosLimit = Math.cos(angleDeg * Math.PI / 180);
    const tn = new Float32Array(nt * 3); const n = [0, 0, 0];
    const byVert = new Map(); const cid = i => keyOf(P, i);
    for (let t = 0; t < nt; t++) { triNormal(P, I[t * 3], I[t * 3 + 1], I[t * 3 + 2], n); tn.set(n, t * 3); for (let e = 0; e < 3; e++) { const k = cid(I[t * 3 + e]); (byVert.get(k) || byVert.set(k, []).get(k)).push(t); } }
    const positions = new Float32Array(nt * 9), normals = new Float32Array(nt * 9), indices = new Uint32Array(nt * 3);
    for (let t = 0; t < nt; t++) for (let e = 0; e < 3; e++) {
      const vi = I[t * 3 + e]; const o = (t * 3 + e) * 3;
      positions[o] = P[vi * 3]; positions[o + 1] = P[vi * 3 + 1]; positions[o + 2] = P[vi * 3 + 2];
      let nx = 0, ny = 0, nz = 0;
      for (const u of byVert.get(cid(vi))) { const d = tn[t * 3] * tn[u * 3] + tn[t * 3 + 1] * tn[u * 3 + 1] + tn[t * 3 + 2] * tn[u * 3 + 2]; if (d > cosLimit) { nx += tn[u * 3]; ny += tn[u * 3 + 1]; nz += tn[u * 3 + 2]; } }
      const l = Math.hypot(nx, ny, nz) || 1; normals[o] = nx / l; normals[o + 1] = ny / l; normals[o + 2] = nz / l;
      indices[t * 3 + e] = t * 3 + e;
    }
    return { positions, normals, indices };
  }
  /** Closest ray hit on display mesh data (Möller–Trumbore): {distance, triangle, faceId, point} or null. */
  function rayMesh(md, o, d) {
    const P = md.positions, I = md.indices; let best = null;
    for (let t = 0; t < I.length / 3; t++) {
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz; if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det; const sx = o[0] - P[a], sy = o[1] - P[a + 1], sz = o[2] - P[a + 2];
      const u = (sx * px + sy * py + sz * pz) * inv; if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv; if (v < 0 || u + v > 1) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * inv; if (tt <= 1e-6) continue;
      if (!best || tt < best.distance) best = { distance: tt, triangle: t, faceId: md.faceID[t], point: [o[0] + d[0] * tt, o[1] + d[1] * tt, o[2] + d[2] * tt] };
    }
    return best;
  }
  /** Smooth-surface id of a planar face id (or -1 when the mesh has no surface data). */
  function surfOfFace(md, faceId) { if (!md.surfID) return -1; for (let t = 0; t < md.faceID.length; t++) if (md.faceID[t] === faceId) return md.surfID[t]; return -1; }
  /** True when the tapped face lies on a flat smooth surface (a box side), false on a curved one (a cylinder wall). */
  function isPlanarFace(md, faceId) { const s = surfOfFace(md, faceId); return s < 0 ? true : !!(md.surfs && md.surfs[s] && md.surfs[s].planar); }
  /** Face-id array where every triangle of the face's planar surface carries faceId, so coplanar fragments act as one face. */
  function planarFaceMask(md, faceId) {
    const s = surfOfFace(md, faceId); if (s < 0 || !md.surfs || !md.surfs[s] || !md.surfs[s].planar || md.surfs[s].faces.size < 2) return md.faceID;
    const out = Uint32Array.from(md.faceID); for (let t = 0; t < out.length; t++) if (md.surfID[t] === s) out[t] = faceId;
    return out;
  }
  /** Boundary loops of one planar face as 2D polygons in the face's own (u,v) frame.
   *  Tolerates T-junctions (a vertex lying on another triangle's edge) by splitting edges at such vertices
   *  before cancelling interior edges, so CSG output works as well as clean B-rep tessellations. */
  function faceFrame(md, faceId) {
    const { positions: P, indices: I, faceID: rawFaceID } = md;
    // Coplanar face ids that the engine left separate but that form one smooth planar surface count as one face.
    const faceID = planarFaceMask(md, faceId);
    const n = [0, 0, 0]; let first = -1;
    for (let t = 0; t < faceID.length; t++) if (faceID[t] === faceId) { first = t; triNormal(P, I[t * 3], I[t * 3 + 1], I[t * 3 + 2], n); break; }
    if (first < 0) throw new Error('Face not found');
    const o = [P[I[first * 3] * 3], P[I[first * 3] * 3 + 1], P[I[first * 3] * 3 + 2]];
    const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const u = norm(cross(ref, n)); const v = cross(n, u);
    // 2D canonical vertices
    const pts = []; const ids = new Map();
    const vid = i => { const dx = P[i * 3] - o[0], dy = P[i * 3 + 1] - o[1], dz = P[i * 3 + 2] - o[2]; const x = dx * u[0] + dy * u[1] + dz * u[2], y = dx * v[0] + dy * v[1] + dz * v[2];
      const k = `${Math.round(x * 1e5)},${Math.round(y * 1e5)}`; let id = ids.get(k); if (id === undefined) { id = pts.length; pts.push([x, y]); ids.set(k, id); } return id; };
    const raw = [];
    for (let t = 0; t < faceID.length; t++) {
      if (faceID[t] !== faceId) continue;
      const a = vid(I[t * 3]), b = vid(I[t * 3 + 1]), c = vid(I[t * 3 + 2]); if (a === b || b === c || a === c) continue;
      raw.push([a, b], [b, c], [c, a]);
    }
    // split edges at vertices lying on them (T-junctions)
    const directed = new Map();
    const addEdge = (a, b) => { if (a === b) return; const kr = b + '_' + a; if (directed.has(kr)) directed.delete(kr); else directed.set(a + '_' + b, [a, b]); };
    for (const [a, b] of raw) {
      const A = pts[a], B = pts[b]; const ex = B[0] - A[0], ey = B[1] - A[1]; const len2 = ex * ex + ey * ey; if (len2 < 1e-16) continue;
      const on = [];
      for (let k = 0; k < pts.length; k++) { if (k === a || k === b) continue; const Q = pts[k]; const qx = Q[0] - A[0], qy = Q[1] - A[1]; const d = qx * ey - qy * ex; if (d * d > 1e-12 * len2) continue; const s = (qx * ex + qy * ey) / len2; if (s > 1e-9 && s < 1 - 1e-9) on.push([s, k]); }
      on.sort((p, q) => p[0] - q[0]); let prev = a; for (const [, k] of on) { addEdge(prev, k); prev = k; } addEdge(prev, b);
    }
    const next = new Map(); for (const [a, b] of directed.values()) next.set(a, b);
    const loops = [];
    while (next.size) {
      const start = next.keys().next().value; const loop = []; let cur = start; let guard = 0;
      do { loop.push(pts[cur]); const nx = next.get(cur); next.delete(cur); cur = nx; } while (cur !== undefined && cur !== start && ++guard < 100000);
      if (loop.length >= 3 && Math.abs(signedArea(loop)) > 1e-9) loops.push(loop);
    }
    if (!loops.length) throw new Error('Could not trace the face outline');
    return { loops, origin: o, u, v, n: [n[0], n[1], n[2]] };
  }
  const frameToWorld = (f, x, y, z) => [f.origin[0] + f.u[0] * x + f.v[0] * y + f.n[0] * z, f.origin[1] + f.u[1] * x + f.v[1] * y + f.n[1] * z, f.origin[2] + f.u[2] * x + f.v[2] * y + f.n[2] * z];

  // ----- exchange -----
  function stlBinary(meshes) {
    let tris = 0; for (const md of meshes) tris += md.indices.length / 3;
    const buf = new ArrayBuffer(84 + tris * 50); const dv = new DataView(buf);
    new Uint8Array(buf, 0, 80).set(new TextEncoder().encode('SolidSketch Web binary STL'));
    dv.setUint32(80, tris, true); let off = 84; const n = [0, 0, 0];
    for (const md of meshes) {
      const P = md.positions, I = md.indices;
      for (let t = 0; t < I.length / 3; t++) {
        const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2]; triNormal(P, a, b, c, n);
        for (let k = 0; k < 3; k++) dv.setFloat32(off + k * 4, n[k], true); off += 12;
        for (const i of [a, b, c]) { for (let k = 0; k < 3; k++) dv.setFloat32(off + k * 4, P[i * 3 + k], true); off += 12; }
        dv.setUint16(off, 0, true); off += 2;
      }
    }
    return buf;
  }
  function objText(meshes) {
    let s = '# SolidSketch Web\n', base = 1;
    meshes.forEach((md, bi) => {
      s += `o body_${bi + 1}\n`; const P = md.positions, I = md.indices;
      for (let i = 0; i < P.length; i += 3) s += `v ${P[i]} ${P[i + 1]} ${P[i + 2]}\n`;
      for (let i = 0; i < I.length; i += 3) s += `f ${I[i] + base} ${I[i + 1] + base} ${I[i + 2] + base}\n`;
      base += P.length / 3;
    });
    return s;
  }
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zipStore(files) {
    const enc = new TextEncoder(); const parts = []; const central = []; let offset = 0;
    for (const { name, data } of files) {
      const nameB = enc.encode(name); const body = data instanceof Uint8Array ? data : new Uint8Array(data);
      const crc = crc32(body); const local = new ArrayBuffer(30); const dv = new DataView(local);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0, true); dv.setUint16(8, 0, true);
      dv.setUint16(10, 0, true); dv.setUint16(12, 0x21, true); dv.setUint32(14, crc, true); dv.setUint32(18, body.length, true); dv.setUint32(22, body.length, true);
      dv.setUint16(26, nameB.length, true); dv.setUint16(28, 0, true);
      parts.push(new Uint8Array(local), nameB, body);
      const cd = new ArrayBuffer(46); const c = new DataView(cd);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0, true); c.setUint16(10, 0, true);
      c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true); c.setUint32(20, body.length, true); c.setUint32(24, body.length, true);
      c.setUint16(28, nameB.length, true); c.setUint16(30, 0, true); c.setUint16(32, 0, true); c.setUint16(34, 0, true); c.setUint16(36, 0, true); c.setUint32(38, 0, true); c.setUint32(42, offset, true);
      central.push(new Uint8Array(cd), nameB);
      offset += 30 + nameB.length + body.length;
    }
    let cdSize = 0; for (const p of central) cdSize += p.length;
    const end = new ArrayBuffer(22); const e = new DataView(end);
    e.setUint32(0, 0x06054b50, true); e.setUint16(4, 0, true); e.setUint16(6, 0, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, offset, true); e.setUint16(20, 0, true);
    const all = [...parts, ...central, new Uint8Array(end)]; let total = 0; for (const p of all) total += p.length;
    const out = new Uint8Array(total); let o = 0; for (const p of all) { out.set(p, o); o += p.length; }
    return out;
  }
  /** Moves a solid built in a sketch frame's local coordinates (x=u, y=v, z=n) into world space. */
  function placeInFrame(solid, f) {
    if (typeof solid.warp === 'function') return solid.warp(p => { const w = frameToWorld(f, p[0], p[1], p[2]); p[0] = w[0]; p[1] = w[1]; p[2] = w[2]; });
    return solid.map((x, y, z) => frameToWorld(f, x, y, z));
  }
  /** Ray hit with an infinite plane: 2D (u,v) coordinates in the frame, or null. */
  function planeHit2D(f, o, d) {
    const denom = d[0] * f.n[0] + d[1] * f.n[1] + d[2] * f.n[2]; if (Math.abs(denom) < 1e-9) return null;
    const t = ((f.origin[0] - o[0]) * f.n[0] + (f.origin[1] - o[1]) * f.n[1] + (f.origin[2] - o[2]) * f.n[2]) / denom; if (t <= 0) return null;
    const px = o[0] + d[0] * t - f.origin[0], py = o[1] + d[1] * t - f.origin[1], pz = o[2] + d[2] * t - f.origin[2];
    return [px * f.u[0] + py * f.u[1] + pz * f.u[2], px * f.v[0] + py * f.v[1] + pz * f.v[2]];
  }
  const GROUND = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
  /** Area-weighted centroid and inradius estimate (2·area/perimeter) of a region's outer loop. */
  function regionShape(outer) {
    let a = 0, cx = 0, cy = 0, per = 0;
    for (let i = 0; i < outer.length; i++) { const p = outer[i], q = outer[(i + 1) % outer.length]; const c = p[0] * q[1] - q[0] * p[1]; a += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c; per += Math.hypot(q[0] - p[0], q[1] - p[1]); }
    a /= 2; const A = Math.abs(a) || 1e-9;
    return { c: a ? [cx / (6 * a), cy / (6 * a)] : [outer[0][0], outer[0][1]], area: A, inradius: Math.max(1e-6, 2 * A / Math.max(per, 1e-9)) };
  }
  /** Top-scale factor that tilts the side walls by draftDeg over height h (exact for circles and regular shapes). */
  function draftScale(outer, h, draftDeg) { if (!draftDeg) return 1; const { inradius } = regionShape(outer); return Math.max(0.02, 1 - h * Math.tan(draftDeg * Math.PI / 180) / inradius); }
  /**
   * Stretch with a tilted wall: moves a flat face out by distance along its normal and scales its outline about its centre
   * so the side walls lean by draftDeg from their base (the rim where those walls start), turning a box into a frustum
   * instead of stacking a tapered block on top of it. Returns the column-major matrix for the face's vertices.
   */
  function draftMatrix(md, faceId, distance, draftDeg) {
    const f = faceFrame(md, faceId); const n = f.n; const { positions: P, indices: I, surfID } = md;
    const keys = faceVertexKeys(md, faceId); const onFace = i => keys.has(fkey(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]));
    const depth = i => (f.origin[0] - P[i * 3]) * n[0] + (f.origin[1] - P[i * 3 + 1]) * n[1] + (f.origin[2] - P[i * 3 + 2]) * n[2];
    // the wall surfaces around the face, and how far back along the normal each one reaches: the nearest of those is the base
    const walls = new Set(); const nt = I.length / 3;
    for (let t = 0; t < nt; t++) { const a = onFace(I[t * 3]), b = onFace(I[t * 3 + 1]), c = onFace(I[t * 3 + 2]); if ((a || b || c) && !(a && b && c)) walls.add(surfID ? surfID[t] : -1); }
    const reach = new Map();
    for (let t = 0; t < nt; t++) { const sid = surfID ? surfID[t] : -1; if (!walls.has(sid)) continue; for (let e = 0; e < 3; e++) { const d = depth(I[t * 3 + e]); if (d > (reach.get(sid) || 0)) reach.set(sid, d); } }
    let H = Infinity; for (const d of reach.values()) if (d > 1e-9 && d < H) H = d; if (!isFinite(H)) H = 0;
    const outer = f.loops.reduce((a, b) => Math.abs(signedArea(b)) > Math.abs(signedArea(a)) ? b : a);
    const { c, inradius } = regionShape(outer);
    const sc = Math.max(0.02, 1 - Math.max(0, H + distance) * Math.tan(draftDeg * Math.PI / 180) / inradius);
    const C0 = frameToWorld(f, c[0], c[1], 0);
    // A = s·I + (1 − s)·n nᵀ (scale inside the face plane only); t = C − A·C + distance·n
    const A = [0, 1, 2].map(r => [0, 1, 2].map(q => (r === q ? sc : 0) + (1 - sc) * n[r] * n[q]));
    const t = [0, 1, 2].map(r => C0[r] - (A[r][0] * C0[0] + A[r][1] * C0[1] + A[r][2] * C0[2]) + distance * n[r]);
    return [A[0][0], A[1][0], A[2][0], 0, A[0][1], A[1][1], A[2][1], 0, A[0][2], A[1][2], A[2][2], 0, t[0], t[1], t[2], 1];
  }

  // ---------- 2D sketch graph: notable points and closed regions from loose line segments ----------
  function segIntersect(a, b, c, d) {
    const r = [b[0] - a[0], b[1] - a[1]], s2 = [d[0] - c[0], d[1] - c[1]];
    const den = r[0] * s2[1] - r[1] * s2[0]; if (Math.abs(den) < 1e-12) return null;
    const t = ((c[0] - a[0]) * s2[1] - (c[1] - a[1]) * s2[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
    return { t, u, p: [a[0] + r[0] * t, a[1] + r[1] * t] };
  }
  /** Endpoints, midpoints and intersections of a set of 2D segments [[x0,y0],[x1,y1]], with a kind label. */
  function notablePoints(segs) {
    const out = [];
    for (const [a, b] of segs) { out.push({ p: a, kind: 'endpoint' }, { p: b, kind: 'endpoint' }, { p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], kind: 'midpoint' }); }
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
      const x = segIntersect(segs[i][0], segs[i][1], segs[j][0], segs[j][1]);
      if (x && x.t > 1e-6 && x.t < 1 - 1e-6 && x.u > 1e-6 && x.u < 1 - 1e-6) out.push({ p: x.p, kind: 'intersection' });
    }
    return out;
  }
  /** Bounded faces of the planar graph formed by segments (split at crossings). Returns CCW loops. */
  function planarRegions(segs, tol = 1e-6) {
    // 1. split every segment at intersections and at endpoints of other segments lying on it
    const cuts = segs.map(() => [0, 1]);
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
      const x = segIntersect(segs[i][0], segs[i][1], segs[j][0], segs[j][1]);
      if (x) { cuts[i].push(Math.min(1, Math.max(0, x.t))); cuts[j].push(Math.min(1, Math.max(0, x.u))); }
    }
    const key = p => `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)}`;
    const verts = []; const vid = new Map(); const id = p => { const k = key(p); let i = vid.get(k); if (i === undefined) { i = verts.length; verts.push([p[0], p[1]]); vid.set(k, i); } return i; };
    const adj = new Map(); const addEdge = (a, b) => { if (a === b) return; (adj.get(a) || adj.set(a, new Set()).get(a)).add(b); (adj.get(b) || adj.set(b, new Set()).get(b)).add(a); };
    segs.forEach(([a, b], i) => { const ts = [...new Set(cuts[i].map(t => Math.round(t * 1e9) / 1e9))].sort((x, y) => x - y); for (let k = 0; k + 1 < ts.length; k++) { const p = [a[0] + (b[0] - a[0]) * ts[k], a[1] + (b[1] - a[1]) * ts[k]], q = [a[0] + (b[0] - a[0]) * ts[k + 1], a[1] + (b[1] - a[1]) * ts[k + 1]]; addEdge(id(p), id(q)); } });
    // 2. sort neighbours by angle around each vertex
    const sorted = new Map();
    for (const [v, ns] of adj) { const arr = [...ns].map(n => ({ n, a: Math.atan2(verts[n][1] - verts[v][1], verts[n][0] - verts[v][0]) })).sort((p, q) => p.a - q.a); sorted.set(v, arr.map(x => x.n)); }
    // 3. trace faces: arriving at v from u, continue to the neighbour just clockwise of u (tightest right turn)
    const visited = new Set(); const loops = [];
    for (const [u, ns] of adj) for (const v0 of ns) {
      if (visited.has(u + '>' + v0)) continue;
      const loop = []; let a = u, b = v0; let guard = 0;
      while (!visited.has(a + '>' + b) && guard++ < 100000) {
        visited.add(a + '>' + b); loop.push(a);
        const ring = sorted.get(b); const i = ring.indexOf(a); const c = ring[(i - 1 + ring.length) % ring.length];
        a = b; b = c;
      }
      const pts = loop.map(i => verts[i]);
      if (pts.length >= 3 && signedArea(pts) > tol) loops.push(pts);
    }
    return loops;
  }
  common_extra = { notablePoints, planarRegions, segIntersect };
  // ---------------------------------------------------------------------------------------------------------------------
  // Chamfer / Fillet. Edges are chains of the drawn boundary between two smooth surfaces. At samples along a chain the two
  // surfaces are sliced with the plane across the edge; in each slice a circle (or a chamfer line, or a conic) is rolled
  // between the two real profile curves; the regions between corner and profile are lofted into a thin solid along the
  // edge that is cut from the body (convex edge) or added to it (concave edge) with an exact boolean.
  // ---------------------------------------------------------------------------------------------------------------------
  function weldMesh(md) {
    const { positions: P, indices: I } = md; const nv = P.length / 3, nt = I.length / 3;
    const canon = new Int32Array(nv); const seen = new Map();
    for (let v = 0; v < nv; v++) { const k = fkey(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); let c = seen.get(k); if (c === undefined) { c = v; seen.set(k, v); } canon[v] = c; }
    const tv = new Int32Array(nt * 3); for (let i = 0; i < nt * 3; i++) tv[i] = canon[I[i]];
    const edgeTris = new Map(); const ek = (a, b) => a < b ? a + '_' + b : b + '_' + a;
    for (let t = 0; t < nt; t++) { const a = tv[t * 3], b = tv[t * 3 + 1], c = tv[t * 3 + 2]; if (a === b || b === c || a === c) continue; for (const [x, y] of [[a, b], [b, c], [c, a]]) { const k = ek(x, y); const r = edgeTris.get(k); if (r) r.push(t); else edgeTris.set(k, [t]); } }
    return { P, nt, tv, edgeTris, ek, V: c => [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]] };
  }
  const triN = (W, t) => { const a = W.V(W.tv[t * 3]), b = W.V(W.tv[t * 3 + 1]), c = W.V(W.tv[t * 3 + 2]); return norm(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]])); };
  /**
   * Edge chains of a body: the drawn boundary between two smooth surfaces, as ordered polylines (split where they turn
   * sharply or branch). Each chain: {sA, sB, pts, ids, closed, length, convex}.
   */
  function edgeChains(md) {
    if (md._chains) return md._chains;
    const W = weldMesh(md); const surfID = md.surfID; const groups = new Map();
    for (const [k, ts] of W.edgeTris) {
      if (ts.length !== 2) continue; const sa = surfID[ts[0]], sb = surfID[ts[1]]; if (sa === sb) continue;
      const [a, b] = k.split('_').map(Number); const gk = Math.min(sa, sb) + '|' + Math.max(sa, sb);
      let g = groups.get(gk); if (!g) { g = { sA: Math.min(sa, sb), sB: Math.max(sa, sb), adj: new Map(), tris: new Map() }; groups.set(gk, g); }
      (g.adj.get(a) || g.adj.set(a, []).get(a)).push(b); (g.adj.get(b) || g.adj.set(b, []).get(b)).push(a); g.tris.set(k, ts);
    }
    const chains = [];
    const dir = (a, b) => norm([W.P[b * 3] - W.P[a * 3], W.P[b * 3 + 1] - W.P[a * 3 + 1], W.P[b * 3 + 2] - W.P[a * 3 + 2]]);
    for (const g of groups.values()) {
      const used = new Set(); const ekey = (a, b) => W.ek(a, b);
      // a vertex breaks a chain when it branches or the chain turns more than 45° there
      const isBreak = v => { const n = g.adj.get(v); if (n.length !== 2) return true; const d0 = dir(n[0], v), d1 = dir(v, n[1]); return d0[0] * d1[0] + d0[1] * d1[1] + d0[2] * d1[2] < Math.cos(Math.PI / 4); };
      const walk = (start, next) => { const ids = [start]; let prev = start, cur = next; used.add(ekey(start, next));
        while (true) { ids.push(cur); if (cur === start) break; if (isBreak(cur)) break; const nb = g.adj.get(cur); const nx = nb[0] === prev ? nb[1] : nb[0]; if (used.has(ekey(cur, nx))) break; used.add(ekey(cur, nx)); prev = cur; cur = nx; }
        return ids; };
      const starts = [...g.adj.keys()].filter(isBreak);
      for (const s of starts) for (const n of g.adj.get(s)) if (!used.has(ekey(s, n))) chains.push({ g, ids: walk(s, n) });
      for (const s of g.adj.keys()) for (const n of g.adj.get(s)) if (!used.has(ekey(s, n))) chains.push({ g, ids: walk(s, n) });
    }
    const out = chains.map(({ g, ids }, idx) => {
      const closed = ids.length > 2 && ids[0] === ids[ids.length - 1]; const vid = closed ? ids.slice(0, -1) : ids;
      const pts = vid.map(W.V); let length = 0; for (let i = 1; i < ids.length; i++) { const a = W.V(ids[i - 1]), b = W.V(ids[i]); length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); }
      // convex when the second surface falls away below the first one's tangent plane
      const mid = Math.floor((ids.length - 1) / 2); const ts = g.tris.get(W.ek(ids[mid], ids[mid + 1]));
      const tA = surfID[ts[0]] === g.sA ? ts[0] : ts[1], tB = ts[0] === tA ? ts[1] : ts[0];
      const nA = triN(W, tA); const e0 = W.V(ids[mid]); const far = [0, 1, 2].map(e => W.tv[tB * 3 + e]).find(c => c !== ids[mid] && c !== ids[mid + 1]);
      const q = W.V(far); const convex = nA[0] * (q[0] - e0[0]) + nA[1] * (q[1] - e0[1]) + nA[2] * (q[2] - e0[2]) < 0;
      return { id: idx, sA: g.sA, sB: g.sB, ids: vid, pts, closed, length, convex, key: g.sA + '|' + g.sB + '|' + vid[0] + '|' + vid[vid.length - 1] + '|' + vid.length };
    });
    md._chains = out; md._weld = W; return out;
  }
  /**
   * Where the handles of a chamfer/fillet sit: the point at fraction f (0..1, by length) along the chain, the chain
   * direction t there, both faces' outward normals, the directions dA / dB running along each face away from the edge,
   * the opening angle between them, and dir — the bisector out of the corner (outside the body on a convex edge, into
   * the open corner on a concave one), along which the size handle is dragged.
   */
  function chainFrame(md, ch, f = 0.5) {
    const W = md._weld || (edgeChains(md), md._weld); const ids = ch.closed ? [...ch.ids, ch.ids[0]] : ch.ids;
    const L = []; let tot = 0; for (let i = 1; i < ids.length; i++) { const a = W.V(ids[i - 1]), b = W.V(ids[i]); tot += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); L.push(tot); }
    const want = Math.max(0, Math.min(1, f)) * tot; let i = 0; while (i < L.length - 1 && L[i] < want) i++;
    const a = W.V(ids[i]), b = W.V(ids[i + 1]); const l0 = i ? L[i - 1] : 0, seg = (L[i] - l0) || 1; const u = (want - l0) / seg;
    const p = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]; const t = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const ts = W.edgeTris.get(W.ek(ids[i], ids[i + 1])) || []; const tA = ts.find(x => md.surfID[x] === ch.sA), tB = ts.find(x => md.surfID[x] === ch.sB);
    if (tA == null || tB == null) return null;
    const nA = triN(W, tA), nB = triN(W, tB);
    // along each face: perpendicular to the edge, within the face, pointing to its far corner
    const along = (n, tr) => { let d = norm(cross(n, t)); const far = [0, 1, 2].map(e => W.tv[tr * 3 + e]).find(c => c !== ids[i] && c !== ids[i + 1]); const q = W.V(far); if ((q[0] - p[0]) * d[0] + (q[1] - p[1]) * d[1] + (q[2] - p[2]) * d[2] < 0) d = [-d[0], -d[1], -d[2]]; return d; };
    const dA = along(nA, tA), dB = along(nB, tB);
    const opening = Math.acos(Math.max(-1, Math.min(1, dA[0] * dB[0] + dA[1] * dB[1] + dA[2] * dB[2])));
    const dir = norm([nA[0] + nB[0], nA[1] + nB[1], nA[2] + nB[2]]);
    return { p, t, nA, nB, dA, dB, opening, dir, length: tot };
  }
  /** Slices surface `sid` with the plane (p, t) and walks the cut from p away from the edge: a polyline in 3D. */
  function sliceSurface(md, W, sid, p, t, reach, diag) {
    const tol = 1e-9 * diag; const pts = new Map(); const adj = new Map();
    const add = (ka, pa, kb, pb) => { pts.set(ka, pa); pts.set(kb, pb); (adj.get(ka) || adj.set(ka, []).get(ka)).push(kb); (adj.get(kb) || adj.set(kb, []).get(kb)).push(ka); };
    const d = c => (W.P[c * 3] - p[0]) * t[0] + (W.P[c * 3 + 1] - p[1]) * t[1] + (W.P[c * 3 + 2] - p[2]) * t[2];
    const R2 = reach * reach * 4;
    for (let tr = 0; tr < W.nt; tr++) {
      if (md.surfID[tr] !== sid) continue; const v = [W.tv[tr * 3], W.tv[tr * 3 + 1], W.tv[tr * 3 + 2]]; if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
      let close = false; for (const c of v) { const x = W.P[c * 3] - p[0], y = W.P[c * 3 + 1] - p[1], z = W.P[c * 3 + 2] - p[2]; if (x * x + y * y + z * z < R2) { close = true; break; } } if (!close) continue;
      const dv = v.map(c => { const x = d(c); return Math.abs(x) < tol ? 0 : x; });
      const hit = [];
      for (let e = 0; e < 3; e++) { if (dv[e] === 0) hit.push(['v' + v[e], W.V(v[e])]); }
      for (let e = 0; e < 3; e++) { const a = v[e], b = v[(e + 1) % 3], da = dv[e], db = dv[(e + 1) % 3]; if (da * db < 0) { const f = da / (da - db); const A = W.V(a), B = W.V(b); hit.push([W.ek(a, b), [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, A[2] + (B[2] - A[2]) * f]]); } }
      if (hit.length === 2) add(hit[0][0], hit[0][1], hit[1][0], hit[1][1]);
    }
    // start where the cut meets the edge point
    let start = null, best = Infinity; for (const [k, q] of pts) { const dd = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]); if (dd < best) { best = dd; start = k; } }
    if (start === null || best > 1e-6 * diag) return null;
    const out = [p.slice()]; const seen = new Set([start]); let cur = start, prevDir = null, total = 0;
    while (total < reach && out.length < 600) {
      const cand = (adj.get(cur) || []).filter(k => !seen.has(k)); if (!cand.length) break;
      const c0 = pts.get(cur); let pick = cand[0];
      if (cand.length > 1 && prevDir) { let bd = -Infinity; for (const k of cand) { const q = pts.get(k); const dd = norm([q[0] - c0[0], q[1] - c0[1], q[2] - c0[2]]); const s = dd[0] * prevDir[0] + dd[1] * prevDir[1] + dd[2] * prevDir[2]; if (s > bd) { bd = s; pick = k; } } }
      const q = pts.get(pick); const seg = Math.hypot(q[0] - c0[0], q[1] - c0[1], q[2] - c0[2]); seen.add(pick); cur = pick;
      if (seg < 1e-12 * diag) continue; prevDir = norm([q[0] - c0[0], q[1] - c0[1], q[2] - c0[2]]); total += seg; out.push(q);
    }
    return out.length >= 2 ? out : null;
  }
  // ---- 2D helpers for a section (coordinates in the plane across the edge; the edge point is the origin)
  const v2 = { sub: (a, b) => [a[0] - b[0], a[1] - b[1]], add: (a, b) => [a[0] + b[0], a[1] + b[1]], mul: (a, f) => [a[0] * f, a[1] * f], dot: (a, b) => a[0] * b[0] + a[1] * b[1], crs: (a, b) => a[0] * b[1] - a[1] * b[0], len: a => Math.hypot(a[0], a[1]), nrm: a => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; } };
  /** Point at arc length s along a polyline (extended straight past its end); returns [point, tangent, extended]. */
  function along(C, s) {
    let acc = 0;
    for (let i = 1; i < C.length; i++) { const d = v2.sub(C[i], C[i - 1]); const l = v2.len(d); if (acc + l >= s || i === C.length - 1) { const tn = v2.nrm(d); const f = s - acc; return [v2.add(C[i - 1], v2.mul(tn, f)), tn, f > l + 1e-12]; } acc += l; }
    return [C[0].slice(), [1, 0], true];
  }
  const polyLen = C => { let l = 0; for (let i = 1; i < C.length; i++) l += v2.len(v2.sub(C[i], C[i - 1])); return l; };
  /** Nearest point on a polyline: [point, arc length]. */
  function footOn(C, q) { let best = Infinity, bp = C[0], bs = 0, acc = 0; for (let i = 1; i < C.length; i++) { const a = C[i - 1], d = v2.sub(C[i], a); const l2 = v2.dot(d, d); const f = l2 > 0 ? Math.max(0, Math.min(1, v2.dot(v2.sub(q, a), d) / l2)) : 0; const pt = v2.add(a, v2.mul(d, f)); const dd = v2.len(v2.sub(q, pt)); if (dd < best) { best = dd; bp = pt; bs = acc + f * Math.sqrt(l2); } acc += Math.sqrt(l2); } return [bp, bs, best]; }
  /**
   * Solves one section. CA, CB: 2D polylines from the origin (the two surfaces' cuts). Returns the profile from the tangent
   * point on A to the one on B and the arc lengths where it meets each curve, or null when it cannot be built.
   */
  function solveSection(CA0, CB0, o) {
    const dA = v2.nrm(v2.sub(CA0[1], CA0[0])), dB = v2.nrm(v2.sub(CB0[1], CB0[0]));
    const side = Math.sign(v2.crs(dA, dB)) || 1;              // the wedge (fillet side) is to this side of A, the other of B
    const opening = Math.acos(Math.max(-1, Math.min(1, v2.dot(dA, dB)))); if (opening < 1e-3 || opening > Math.PI - 1e-3) return null;
    const lenA = polyLen(CA0), lenB = polyLen(CB0);
    // both curves continue straight past their ends (a profile that needs that is "not blended" with the next face)
    const ext = (C, far) => { const n = C.length; const tn = v2.nrm(v2.sub(C[n - 1], C[n - 2])); return [...C, v2.add(C[n - 1], v2.mul(tn, far))]; };
    const far = 50 * (o.r + (o.r2 || 0)) + 1; const CA = ext(CA0, far), CB = ext(CB0, far);
    let tA, tB, sA, sB, profile, center = null;
    if (o.type === 'chamfer') {
      sA = o.r; [tA] = along(CA, sA);
      if (o.angle) {
        // a line from tA leaning o.angle away from face A toward B, cut against curve B
        const [, tanA] = along(CA, sA); const a = o.angle * Math.PI / 180; const back = v2.mul(tanA, -1); const nIn = side > 0 ? [-tanA[1], tanA[0]] : [tanA[1], -tanA[0]];
        const dir = v2.add(v2.mul(back, Math.cos(a)), v2.mul(nIn, Math.sin(a)));
        let hit = null; for (let i = 1; i < CB.length && !hit; i++) { const p0 = CB[i - 1], d = v2.sub(CB[i], p0); const den = v2.crs(dir, d); if (Math.abs(den) < 1e-15) continue; const w = v2.sub(p0, tA); const u = v2.crs(w, d) / den, s = v2.crs(w, dir) / den; if (u > 0 && s >= 0 && s <= 1) hit = v2.add(tA, v2.mul(dir, u)); }
        if (!hit) return null; tB = hit; sB = footOn(CB, tB)[1];
      } else { sB = o.r2 || o.r; [tB] = along(CB, sB); }
      const n = o.segs || 2; profile = []; for (let i = 0; i <= n; i++) profile.push(v2.add(tA, v2.mul(v2.sub(tB, tA), i / n)));
    } else {
      // rolling ball: both curves offset by r toward the wedge; their first crossing is the ball centre
      const off = (C, s) => { const segs = []; for (let i = 1; i < C.length; i++) { const d = v2.nrm(v2.sub(C[i], C[i - 1])); const nn = s > 0 ? [-d[1], d[0]] : [d[1], -d[0]]; segs.push([v2.add(C[i - 1], v2.mul(nn, o.r)), v2.add(C[i], v2.mul(nn, o.r))]); } return segs; };
      const OA = off(CA, side), OB = off(CB, -side); let best = Infinity;
      for (let i = 0; i < OA.length; i++) for (let j = 0; j < OB.length; j++) {
        const [a0, a1] = OA[i], [b0, b1] = OB[j]; const da = v2.sub(a1, a0), db = v2.sub(b1, b0); const den = v2.crs(da, db); if (Math.abs(den) < 1e-15) continue;
        const w = v2.sub(b0, a0); const u = v2.crs(w, db) / den, s = v2.crs(w, da) / den; const pad = 1e-9;
        if (u < -pad || u > 1 + pad || s < -pad || s > 1 + pad) continue; const c = v2.add(a0, v2.mul(da, u)); const score = v2.len(c); if (score < best) { best = score; center = c; }
      }
      if (!center) return null;
      [tA, sA] = footOn(CA, center); [tB, sB] = footOn(CB, center);
      if (o.fixedS) { sA = o.fixedS[0]; sB = o.fixedS[1]; [tA] = along(CA, sA); [tB] = along(CB, sB); }
      const n = o.segs || 16; profile = [];
      if (o.rho) {
        // conic: rational quadratic from tA to tB with its shoulder where the two tangents meet
        const [, ta] = along(CA, sA), [, tb] = along(CB, sB); const den = v2.crs(ta, tb); let P1 = [0, 0];
        if (Math.abs(den) > 1e-12) { const w0 = v2.sub(tB, tA); const u = v2.crs(w0, tb) / den; P1 = v2.add(tA, v2.mul(ta, u)); }
        const w = o.rho / (1 - o.rho);
        for (let i = 0; i <= n; i++) { const u = i / n, b0 = (1 - u) * (1 - u), b1 = 2 * u * (1 - u) * w, b2 = u * u, s = b0 + b1 + b2; profile.push([(b0 * tA[0] + b1 * P1[0] + b2 * tB[0]) / s, (b0 * tA[1] + b1 * P1[1] + b2 * tB[1]) / s]); }
      } else if (o.fixedS) {
        // tangent points given (smoothed along the edge): the circle-like rational quadratic tangent to both faces there
        const [, ta] = along(CA, sA), [, tb] = along(CB, sB); const den = v2.crs(ta, tb); let P1 = v2.mul(v2.add(tA, tB), 0.5);
        if (Math.abs(den) > 1e-12) { const w0 = v2.sub(tB, tA); const u = v2.crs(w0, tb) / den; P1 = v2.add(tA, v2.mul(ta, u)); }
        const d0 = v2.nrm(v2.sub(tA, P1)), d1 = v2.nrm(v2.sub(tB, P1)); const sweep = Math.PI - Math.acos(Math.max(-1, Math.min(1, v2.dot(d0, d1)))); const w = Math.max(0.05, Math.cos(sweep / 2));
        for (let i = 0; i <= n; i++) { const u = i / n, b0 = (1 - u) * (1 - u), b1 = 2 * u * (1 - u) * w, b2 = u * u, sm = b0 + b1 + b2; profile.push([(b0 * tA[0] + b1 * P1[0] + b2 * tB[0]) / sm, (b0 * tA[1] + b1 * P1[1] + b2 * tB[1]) / sm]); }
      } else {
        const a0 = Math.atan2(tA[1] - center[1], tA[0] - center[0]); let a1 = Math.atan2(tB[1] - center[1], tB[0] - center[0]); let da = a1 - a0; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
        for (let i = 0; i <= n; i++) { const a = a0 + da * i / n; profile.push([center[0] + o.r * Math.cos(a), center[1] + o.r * Math.sin(a)]); }
      }
    }
    return { profile, sA, sB, tA, tB, lenA, lenB, side, opening, center, blended: sA <= lenA + 1e-9 && sB <= lenB + 1e-9 };
  }
  /** Points of polyline C from arc length 0 to s, resampled to m+1 points (m ≥ 1). */
  function resample(C, s, m) { const out = []; for (let i = 0; i <= m; i++) out.push(along(C, s * i / m)[0]); return out; }
  /**
   * A curved face's cut through its facets, smoothed: a few neighbour-averaging passes (the edge point stays put). The facets
   * of a bent wall fold a few degrees at their creases, and a rolling ball's tangent point jumps across each crease; on the
   * smooth surface the facets stand for, it moves continuously, so the fillet's boundary runs smoothly.
   */
  function smoothCurve(C, passes = 4) {
    let A = C.map(q => q.slice());
    for (let k = 0; k < passes; k++) { const B = A.map(q => q.slice()); for (let i = 1; i < A.length - 1; i++) { B[i][0] = (A[i - 1][0] + 2 * A[i][0] + A[i + 1][0]) / 4; B[i][1] = (A[i - 1][1] + 2 * A[i][1] + A[i + 1][1]) / 4; } A = B; }
    return A;
  }
  /** Simple ear clipping for a 2D polygon (counter-clockwise); returns triangles as index triples. */
  function earClip(poly) {
    const n = poly.length; const idx = [...Array(n).keys()]; const tris = [];
    const area = () => { let a = 0; for (let i = 0; i < n; i++) { const p = poly[i], q = poly[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return a; };
    if (area() < 0) idx.reverse();
    const inside = (p, a, b, c) => { const s1 = v2.crs(v2.sub(b, a), v2.sub(p, a)), s2 = v2.crs(v2.sub(c, b), v2.sub(p, b)), s3 = v2.crs(v2.sub(a, c), v2.sub(p, c)); return s1 > 1e-14 && s2 > 1e-14 && s3 > 1e-14; };
    let guard = 0;
    while (idx.length > 3 && guard++ < 10000) {
      let clipped = false;
      for (let i = 0; i < idx.length; i++) {
        const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length]; const a = poly[ia], b = poly[ib], c = poly[ic];
        if (v2.crs(v2.sub(b, a), v2.sub(c, b)) <= 1e-14) continue;
        let ok = true; for (const j of idx) if (j !== ia && j !== ib && j !== ic && inside(poly[j], a, b, c)) { ok = false; break; }
        if (!ok) continue; tris.push([ia, ib, ic]); idx.splice(i, 1); clipped = true; break;
      }
      if (!clipped) { const ia = idx[0]; for (let i = 1; i + 1 < idx.length; i++) tris.push([ia, idx[i], idx[i + 1]]); idx.length = 0; break; }
    }
    if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
    return tris;
  }
  /** Is a point inside the closed mesh? (ray parity along a slightly skewed direction) */
  function pointInside(W, q) {
    const dir = norm([0.5773, 0.5774, 0.5775]); let hits = 0;
    for (let t = 0; t < W.nt; t++) {
      const a = W.V(W.tv[t * 3]), b = W.V(W.tv[t * 3 + 1]), c = W.V(W.tv[t * 3 + 2]);
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]; const h = cross(dir, e2); const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2]; if (Math.abs(det) < 1e-14) continue;
      const s = [q[0] - a[0], q[1] - a[1], q[2] - a[2]]; const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det; if (u < 0 || u > 1) continue;
      const qq = cross(s, e1); const v = (dir[0] * qq[0] + dir[1] * qq[1] + dir[2] * qq[2]) / det; if (v < 0 || u + v > 1) continue;
      if ((e2[0] * qq[0] + e2[1] * qq[1] + e2[2] * qq[2]) / det > 1e-12) hits++;
    }
    return hits % 2 === 1;
  }
  /** Closest point on triangle abc to q (Ericson), for distances from a point to a surface. */
  function closestOnTri(q, a, b, c) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], ap = [q[0] - a[0], q[1] - a[1], q[2] - a[2]];
    const d = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]; const at = (s, t) => [a[0] + ab[0] * s + ac[0] * t, a[1] + ab[1] * s + ac[1] * t, a[2] + ab[2] * s + ac[2] * t];
    const d1 = d(ab, ap), d2 = d(ac, ap); if (d1 <= 0 && d2 <= 0) return a;
    const bp = [q[0] - b[0], q[1] - b[1], q[2] - b[2]]; const d3 = d(ab, bp), d4 = d(ac, bp); if (d3 >= 0 && d4 <= d3) return b;
    const vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
    const cp = [q[0] - c[0], q[1] - c[1], q[2] - c[2]]; const d5 = d(ab, cp), d6 = d(ac, cp); if (d6 >= 0 && d5 <= d6) return c;
    const vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
    const va = d3 * d6 - d5 * d4; if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]; }
    const den = 1 / (va + vb + vc); return at(vb * den, vc * den);
  }
  /** Distance from q to surface sid of the welded mesh (only triangles within `near` of q are tried). */
  function distToSurface(md, W, sid, q, near) {
    let best = Infinity; const n2 = near * near;
    for (let t = 0; t < W.nt; t++) {
      if (md.surfID[t] !== sid) continue; const a = W.V(W.tv[t * 3]), b = W.V(W.tv[t * 3 + 1]), c = W.V(W.tv[t * 3 + 2]);
      const mx = (a[0] + b[0] + c[0]) / 3 - q[0], my = (a[1] + b[1] + c[1]) / 3 - q[1], mz = (a[2] + b[2] + c[2]) / 3 - q[2]; if (mx * mx + my * my + mz * mz > n2) continue;
      const p = closestOnTri(q, a, b, c); const dd = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); if (dd < best) best = dd;
    }
    return best;
  }
  /**
   * Builds the fillet / chamfer tool solids for the chains (as plain meshes). opts: {type: 'fillet'|'chamfer', r, r2, angle,
   * rho, live}. Returns {tools: [{positions, indices, convex}], warn} or throws when a size cannot be built.
   */
  function filletTools(md, chains, opts) {
    const W = md._weld || (edgeChains(md), md._weld); const diag = bboxDiag(md.positions) || 1; const eps = 2e-4 * diag;
    const o = { type: opts.type || 'fillet', r: Math.max(1e-6, +opts.r || 0), r2: opts.r2 ? +opts.r2 : 0, angle: opts.angle ? +opts.angle : 0, rho: opts.rho ? Math.max(0.02, Math.min(0.98, +opts.rho)) : 0 };
    const stepDeg = opts.live ? 8 : 4; let warn = false; const tools = [];
    for (const ch of chains) {
      const surfA = md.surfs[ch.sA], surfB = md.surfs[ch.sB]; const flat = surfA && surfB && surfA.planar && surfB.planar;
      // sample points: the chain's own vertices, plus extra ones on long segments when a face curves along the edge
      const base = ch.pts; const samples = [];
      const n0 = base.length; const segCount = ch.closed ? n0 : n0 - 1;
      const maxStep = flat ? Infinity : Math.max(ch.length / 64, o.r * 0.75) / (opts.density || (opts.live ? 1 : 2));
      // On a flat pair of faces the sections sit on the chain's vertices. On curved faces they sit a hair past them: a
      // section plane through a chain vertex contains the face's own edge there (a cylinder's vertical facet edge), which
      // then runs exactly along the tool's outline, and the boolean computes that crossing twice as two nearly identical
      // points. 2 % along the segment the plane crosses that edge cleanly while the tool still follows the facets.
      const mid = flat ? 0 : 0.02;
      if (!ch.closed && mid) samples.push([...base[0], 0, true]);
      for (let i = 0; i < segCount; i++) { const a = base[i], b = base[(i + 1) % n0]; const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); const k = Math.max(1, Math.min(32, Math.ceil(l / maxStep))); for (let j = 0; j < k; j++) { const f = (j + mid) / k; samples.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, i, j === 0 && !mid, !ch.closed && mid && i === 0 && j === 0]); } }
      // an open curved chain also gets a section just before its last vertex, mirroring the one just past its first, so the
      // end section never has to borrow from a section far away
      if (!ch.closed && mid) { const a = base[n0 - 2], b = base[n0 - 1]; const f = 1 - mid; samples.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, n0 - 2, false, true]); }
      if (!ch.closed) samples.push([...base[n0 - 1], n0 - 1, true]);
      const tanAt = k => { const m = samples.length; const p = samples[k]; const prev = ch.closed ? samples[(k + m - 1) % m] : samples[Math.max(0, k - 1)], next = ch.closed ? samples[(k + 1) % m] : samples[Math.min(m - 1, k + 1)];
        const d1 = norm([p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]]), d2 = norm([next[0] - p[0], next[1] - p[1], next[2] - p[2]]);
        if (prev === p) return d2; if (next === p) return d1; return norm([d1[0] + d2[0], d1[1] + d2[1], d1[2] + d2[2]]); };
      // one section per sample
      const reach = 6 * (o.r + o.r2) + (o.angle ? 6 * o.r * Math.tan(Math.min(80, o.angle) * Math.PI / 180) : 0);
      // where each sample sits along the chain, and whether it is near an open end
      const at = [0]; for (let k = 1; k < samples.length; k++) { const a = samples[k - 1], b = samples[k]; at.push(at[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])); }
      const zone = 2.5 * (o.r + o.r2) + (o.angle ? 2 * o.r * Math.tan(Math.min(80, o.angle) * Math.PI / 180) : 0);
      const nearEnd = k => !ch.closed && Math.min(at[k], ch.length - at[k]) < zone;
      const smooth = (C2, sid) => (md.surfs[sid] && !md.surfs[sid].planar && opts.smoothCurves) ? smoothCurve(C2) : C2;
      const secs = []; const weak = [];
      for (let k = 0; k < samples.length; k++) {
        const p = samples[k].slice(0, 3); const t = tanAt(k);
        const A3 = sliceSurface(md, W, ch.sA, p, t, reach, diag), B3 = sliceSurface(md, W, ch.sB, p, t, reach, diag);
        let sec = null, lim = Infinity, blended = false;
        if (A3 && B3) {
          const e1 = norm([A3[1][0] - p[0], A3[1][1] - p[1], A3[1][2] - p[2]]); const e2 = cross(t, e1);
          const to2 = q => { const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]]; return [d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2], d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2]]; };
          const CA = smooth(A3.map(to2), ch.sA), CB = smooth(B3.map(to2), ch.sB); const sol = solveSection(CA, CB, { ...o, segs: 1 });
          if (sol) { sec = { p, t, e1, e2, CA, CB, sol }; lim = Math.max(sol.sA / (sol.lenA || 1e-12), sol.sB / (sol.lenB || 1e-12)); blended = sol.blended; }
        }
        // along a leaning end the cross plane leaves the faces early (it dips under the end face): such a section is not a
        // neighbouring edge in the way, so it borrows the nearest good section below instead of warning or refusing
        // a face that stops short because the cut ran out through the end face (its exit point lies at an end of the chain)
        // is not a neighbouring edge in the way: the solve already runs that face on straight past there, outside the body,
        // so the section is right as it is
        if (sec && !blended && !ch.closed) {
          const e0 = base[0], e1 = base[n0 - 1]; const reachEnd = Math.min(2.5 * (o.r + o.r2), 0.25 * ch.length);
          const exitNearEnd = C3 => { const q = C3[C3.length - 1]; return Math.min(Math.hypot(q[0] - e0[0], q[1] - e0[1], q[2] - e0[2]), Math.hypot(q[0] - e1[0], q[1] - e1[1], q[2] - e1[2])) < reachEnd; };
          const shortA = sec.sol.sA > sec.sol.lenA + 1e-9, shortB = sec.sol.sB > sec.sol.lenB + 1e-9;
          if ((!shortA || exitNearEnd(A3)) && (!shortB || exitNearEnd(B3))) { secs.push(sec); continue; }
        }
        if (nearEnd(k) && (!sec || !blended)) { secs.push(sec); weak.push(k); continue; }
        if (!sec) throw new Error(A3 && B3 ? "Operation failed because the resulting body wouldn't be valid" : 'Could not follow the faces along this edge');
        if (lim > 1.5) throw new Error('That size is too big for the faces next to this edge');
        if (!blended) warn = true;
        secs.push(sec);
      }
      if (weak.length) {
        const good = secs.map((x, k) => x ? k : -1).filter(k => k >= 0 && !weak.includes(k));
        if (!good.length) throw new Error('That size is too big for the faces next to this edge');
        for (const k of weak) { let j = good[0]; for (const g of good) if (Math.abs(at[g] - at[k]) < Math.abs(at[j] - at[k])) j = g; const s0 = secs[j]; secs[k] = { ...s0, p: samples[k].slice(0, 3) }; }
      }
      // the sections just inside each end only lend themselves to the end: their own rings, tilted with a leaning edge, would
      // dip under the end face and make the tool cross it twice
      { const keep = samples.map((smp, k) => !smp[5] || secs.length <= 3); if (keep.some(x => !x)) {
        const remap = []; let j = 0; for (let k = 0; k < secs.length; k++) { remap.push(keep[k] ? j : -1); if (keep[k]) j++; }
        const nw = weak.map(k => remap[k]).filter(k => k >= 0); secs.splice(0, secs.length, ...secs.filter((x, k) => keep[k])); weak.splice(0, weak.length, ...nw);
        const at2 = at.filter((x, k) => keep[k]); at.splice(0, at.length, ...at2); samples.splice(0, samples.length, ...samples.filter((x, k) => keep[k])); } }
      // one point count for every section: the profile turns about stepDeg per step
      let turn = 0; for (const s of secs) turn = Math.max(turn, Math.PI - s.sol.opening);
      const nProf = o.type === 'chamfer' ? 2 : Math.max(4, Math.min(48, Math.ceil(turn * 180 / Math.PI / stepDeg)));
      const mSide = flat ? 1 : 8;
      // On a curved face the straight tool between two sections and the face's own folded cells differ a little; at a
      // tangent contact that gap would come out as a strip of slivers. Measure it along both contact lines (the midpoints
      // between neighbouring sections' tangent points against the real surface) and keep the profile that much clear, so it
      // crosses the face at a small definite angle instead. Flat faces keep the exact tangent result.
      // (per section: a gap is measured on each pair of neighbouring sections; borrowed near-end sections are not on the face
      // by design, so they take their neighbour's value instead of being measured)
      const clearAt = new Float64Array(secs.length);
      if (!flat && o.type !== 'chamfer') {
        const t3 = (s, q) => [s.p[0] + q[0] * s.e1[0] + q[1] * s.e2[0], s.p[1] + q[0] * s.e1[1] + q[1] * s.e2[1], s.p[2] + q[0] * s.e1[2] + q[1] * s.e2[2]];
        const pairs = ch.closed ? secs.length : secs.length - 1; const near = 4 * (o.r + o.r2) + ch.length / Math.max(1, pairs); const isWeak = new Uint8Array(secs.length); for (const k of weak) isWeak[k] = 1;
        const gap = new Float64Array(pairs).fill(-1);
        for (let k = 0; k < pairs; k++) { const k1 = (k + 1) % secs.length; if (isWeak[k] || isWeak[k1]) continue; const s0 = secs[k], s1 = secs[k1]; let g = 0;
          for (const [key, sid] of [['tA', ch.sA], ['tB', ch.sB]]) { const a = t3(s0, s0.sol[key]), b = t3(s1, s1.sol[key]);
            // between two sections the face bends at the chain vertex just before the second one, so look there too
            for (const f of [0.25, 0.5, 0.75, 0.97]) { const m = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
              const d = distToSurface(md, W, sid, m, near); if (isFinite(d)) g = Math.max(g, d); } }
          gap[k] = g; }
        const cap = 0.05 * o.r, floor = 3e-6 * diag;
        for (let k = 0; k < secs.length; k++) { const prev = ch.closed ? (k + pairs - 1) % pairs : k - 1; let g = Math.max(prev >= 0 ? gap[prev] : -1, k < pairs ? gap[k] : -1); clearAt[k] = g; }
        // borrowed sections (and any without a measured pair) take the nearest measured value
        for (let k = 0; k < secs.length; k++) if (clearAt[k] < 0) { let best = -1, bd = Infinity; for (let j = 0; j < secs.length; j++) if (clearAt[j] >= 0 && !isWeak[j] && Math.abs(j - k) < bd) { bd = Math.abs(j - k); best = j; } clearAt[k] = best >= 0 ? clearAt[best] : 0; }
        // one clearance for the whole edge (the gap between samples is only an estimate of the gap over the tangent strip), three
        // times the largest measured: clean at every radius tried, crossing the face at 10° or less
        const factor = opts.clearFactor || 3; if (opts.clearGlobal !== false) { const g = Math.max(...clearAt); clearAt.fill(g); }
        for (let k = 0; k < secs.length; k++) clearAt[k] = Math.min(factor * clearAt[k] + floor, cap);
      }
      // On curved faces the tool runs straight between two sections while the face may fold in between (a twisted wall's
      // cells are two triangles folded along a diagonal); where the gap to the face is largest, add a section, until the tool
      // follows the face closely. The crossing then stays put instead of stepping out and in once per row.
      // (the clearance above is measured on the sections before this refinement: that value crosses the face cleanly)
      let clearAll = clearAt.length ? Math.max(...clearAt) : 0;
      if (!flat && o.type !== 'chamfer' && opts.refine) {
        const weakSet = new Set(weak.map(k => secs[k]));
        const t3 = (s0, q) => [s0.p[0] + q[0] * s0.e1[0] + q[1] * s0.e2[0], s0.p[1] + q[0] * s0.e1[1] + q[1] * s0.e2[1], s0.p[2] + q[0] * s0.e1[2] + q[1] * s0.e2[2]];
        const pts = ch.closed ? [...ch.pts, ch.pts[0]] : ch.pts;
        const onChain = q => { let best = null, bd = Infinity; for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i]; const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1;
            const f0 = Math.max(0, Math.min(1, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1] + (q[2] - a[2]) * ab[2]) / l2)); const c0 = [a[0] + ab[0] * f0, a[1] + ab[1] * f0, a[2] + ab[2] * f0]; const d = Math.hypot(c0[0] - q[0], c0[1] - q[1], c0[2] - q[2]);
            // never on (or right next to) a chain vertex: a section plane there holds the face's own edge (see the sampling above)
            if (d < bd) { bd = d; const f = Math.max(mid, Math.min(1 - mid, f0)); best = [a[0] + ab[0] * f, a[1] + ab[1] * f, a[2] + ab[2] * f]; } } return best; };
        const sectionAt = (p, t) => {
          const A3 = sliceSurface(md, W, ch.sA, p, t, reach, diag), B3 = sliceSurface(md, W, ch.sB, p, t, reach, diag); if (!A3 || !B3) return null;
          const e1 = norm([A3[1][0] - p[0], A3[1][1] - p[1], A3[1][2] - p[2]]); const e2 = cross(t, e1);
          const to2 = q => { const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]]; return [d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2], d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2]]; };
          const CA = smooth(A3.map(to2), ch.sA), CB = smooth(B3.map(to2), ch.sB); const sol = solveSection(CA, CB, { ...o, segs: 1 }); return sol && sol.blended ? { p, t, e1, e2, CA, CB, sol } : null; };
        const nearR = 4 * (o.r + o.r2) + ch.length / Math.max(1, secs.length);
        const gapOf = (s0, s1) => { let g = 0, gf = 0.5; for (const [key, sid] of [['tA', ch.sA], ['tB', ch.sB]]) { const a = t3(s0, s0.sol[key]), b = t3(s1, s1.sol[key]);
            for (const f of [0.2, 0.35, 0.5, 0.65, 0.8]) { const m = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; const d = distToSurface(md, W, sid, m, nearR); if (isFinite(d) && d > g) { g = d; gf = f; } } }
          return [g, gf]; };
        const gapTol = (opts.live ? 8e-5 : 2e-5) * diag; const maxSecs = Math.max(64, (opts.live ? 2 : 4) * secs.length);
        for (let pass = 0; pass < (opts.live ? 2 : 4) && secs.length < maxSecs; pass++) {
          const out = [secs[0]]; let added = 0; const pairs = ch.closed ? secs.length : secs.length - 1;
          for (let k = 0; k < pairs; k++) {
            const s0 = secs[k], s1 = secs[(k + 1) % secs.length];
            if (!weakSet.has(s0) && !weakSet.has(s1) && secs.length + added < maxSecs) {
              const [g, f] = gapOf(s0, s1);
              if (g > gapTol) { const p = onChain([s0.p[0] + (s1.p[0] - s0.p[0]) * f, s0.p[1] + (s1.p[1] - s0.p[1]) * f, s0.p[2] + (s1.p[2] - s0.p[2]) * f]);
                const t = norm([s0.t[0] + (s1.t[0] - s0.t[0]) * f, s0.t[1] + (s1.t[1] - s0.t[1]) * f, s0.t[2] + (s1.t[2] - s0.t[2]) * f]); const ns = p && sectionAt(p, t); if (ns) { out.push(ns); added++; } }
            }
            if (k + 1 < secs.length) out.push(s1);
          }
          if (!added) break; secs.splice(0, secs.length, ...out);
        }
        weak.splice(0, weak.length, ...secs.map((x, k) => weakSet.has(x) ? k : -1).filter(k => k >= 0));
      }
      const clearFor = si => clearAt.length === secs.length ? clearAt[si] : clearAll;
      // Where the faces are curved (faceted), the tangent points jump a little at every crease between facets; smooth their
      // positions along the edge so the fillet's boundary runs smoothly (the profile is rebuilt tangent to the faces there)
      if (!flat && o.type !== 'chamfer' && opts.smoothTangents !== false && secs.length > 4) {
        // Gaussian along the edge's length, as wide as the fillet (the jumps grow with the radius); the ends keep their own values
        const isWeak = new Set(weak); const n2 = secs.length; const pos = [0]; for (let k = 1; k < n2; k++) pos.push(pos[k - 1] + Math.hypot(secs[k].p[0] - secs[k - 1].p[0], secs[k].p[1] - secs[k - 1].p[1], secs[k].p[2] - secs[k - 1].p[2]));
        const total = ch.closed ? pos[n2 - 1] + Math.hypot(secs[0].p[0] - secs[n2 - 1].p[0], secs[0].p[1] - secs[n2 - 1].p[1], secs[0].p[2] - secs[n2 - 1].p[2]) : pos[n2 - 1];
        const sig = 0.8 * (o.r + o.r2); const SA = [], SB = [];
        for (let k = 0; k < n2; k++) {
          if (isWeak.has(k)) { SA.push(secs[k].sol.sA); SB.push(secs[k].sol.sB); continue; }
          let wa = 0, sa = 0, sb = 0; const reachK = ch.closed ? Infinity : Math.min(pos[k], total - pos[k]); const sg = Math.max(1e-9, Math.min(sig, reachK / 2)); // narrower near an open end
          for (let j = 0; j < n2; j++) { if (isWeak.has(j)) continue; let d = Math.abs(pos[j] - pos[k]); if (ch.closed) d = Math.min(d, total - d); if (d > 3 * sg) continue; const w = Math.exp(-0.5 * (d / sg) * (d / sg)); wa += w; sa += w * secs[j].sol.sA; sb += w * secs[j].sol.sB; }
          SA.push(wa ? sa / wa : secs[k].sol.sA); SB.push(wa ? sb / wa : secs[k].sol.sB);
        }
        secs.forEach((x, k) => { x.fixS = [SA[k], SB[k]]; });
      }
      const rings = secs.map((s, si) => { const clear = clearFor(si);
        const sol = solveSection(s.CA, s.CB, { ...o, segs: nProf, fixedS: s.fixS || null });
        const A = resample(s.CA, sol.sA, mSide), B = resample(s.CB, sol.sB, mSide);
        // push everything but the profile slightly out of the wedge, so the boolean has clean overlap
        const pushOut = (pt, C, sgn, sArc, e = eps) => { const [, tn] = along(C, Math.max(0, Math.min(sArc, polyLen(C)))); const nn = sgn > 0 ? [tn[1], -tn[0]] : [-tn[1], tn[0]]; return v2.add(pt, v2.mul(nn, e)); };
        const tip = o.type === 'chamfer' ? 0 : 3e-6 * diag;   // clears float rounding, far below anything visible
        const skin = Math.max(eps, 0.08 * (o.r + o.r2));          // the tool's outer skin stays well clear of a face that curves between sections
        const ring = [];
        const bis = v2.nrm(v2.add(v2.nrm(v2.sub(s.CA[1], s.CA[0])), v2.nrm(v2.sub(s.CB[1], s.CB[0]))));
        ring.push(v2.mul(bis, -skin * 1.5));
        for (let i = 1; i < mSide; i++) ring.push(pushOut(A[i], s.CA, sol.side, sol.sA * i / mSide, skin));
        // the profile starts and ends a hair outside the faces: an exactly tangent start would make the boolean shred the
        // face along the tangent line into slivers; this way it crosses the face cleanly, just inside the tangent point
        ring.push(pushOut(A[mSide], s.CA, sol.side, sol.sA, skin));
        // on curved faces the whole profile moves toward the corner until its ends sit `clear` outside both faces
        let shift = [0, 0]; if (clear > 0 && sol.center) { const cl = v2.len(sol.center) || 1; shift = v2.mul(v2.nrm(v2.mul(sol.center, -1)), clear * cl / o.r); }
        for (let i = 0; i <= nProf; i++) { const q = v2.add(sol.profile[i], shift); ring.push(!clear && tip && i === 0 ? pushOut(q, s.CA, sol.side, sol.sA, tip) : !clear && tip && i === nProf ? pushOut(q, s.CB, -sol.side, sol.sB, tip) : q); }
        ring.push(pushOut(B[mSide], s.CB, -sol.side, sol.sB, skin));
        for (let i = mSide - 1; i >= 1; i--) ring.push(pushOut(B[i], s.CB, -sol.side, sol.sB * i / mSide, skin));
        let ar = 0; for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; ar += a[0] * b[1] - b[0] * a[1]; } if (ar < 0) ring.reverse(); // every section counter-clockwise (normal along the edge)
        return ring.map(q => [s.p[0] + q[0] * s.e1[0] + q[1] * s.e2[0], s.p[1] + q[0] * s.e1[1] + q[1] * s.e2[1], s.p[2] + q[0] * s.e1[2] + q[1] * s.e2[2]]);
      });
      const N = rings[0].length;
      // open ends: the end ring is slid along the edge into the end face's own plane (on a leaning edge a ring square to the
      // edge is tilted against that face and it and its extension would cut the face twice, a hair apart, leaving a crescent)
      if (!ch.closed) {
        const endPlane = (v, t) => { // the face at this end of the chain that is neither of the two filleted faces, most facing along the edge
          let best = null; for (let tr = 0; tr < W.nt; tr++) { const sid = md.surfID[tr]; if (sid === ch.sA || sid === ch.sB) continue; const vs = [W.tv[tr * 3], W.tv[tr * 3 + 1], W.tv[tr * 3 + 2]]; if (!vs.includes(v)) continue;
            const n = triN(W, tr); const al = Math.abs(n[0] * t[0] + n[1] * t[1] + n[2] * t[2]); if (!best || al > best.al) best = { n, al, sid }; }
          return best && best.al > 0.3 && md.surfs[best.sid] && md.surfs[best.sid].planar ? best : null; };
        const flush = (k, v) => { const e = endPlane(v, secs[k].t); if (!e) return; const t = secs[k].t, q0 = W.V(v); const nt2 = e.n[0] * t[0] + e.n[1] * t[1] + e.n[2] * t[2];
          rings[k] = rings[k].map(q => { const lam = (e.n[0] * (q0[0] - q[0]) + e.n[1] * (q0[1] - q[1]) + e.n[2] * (q0[2] - q[2])) / nt2; return [q[0] + t[0] * lam, q[1] + t[1] * lam, q[2] + t[2] * lam]; }); };
        flush(0, ch.ids[0]); flush(rings.length - 1, ch.ids[ch.ids.length - 1]);
      }
      // open ends: run the tool on past the end when that is outside the body, else just a hair
      if (!ch.closed) {
        const extend = (ring, t, sgn) => { const c = ring.reduce((a, q) => [a[0] + q[0] / N, a[1] + q[1] / N, a[2] + q[2] / N], [0, 0, 0]); const far = 2 * (o.r + o.r2) + reach * 0.2;
          const probe = [c[0] + t[0] * sgn * far * 0.5, c[1] + t[1] * sgn * far * 0.5, c[2] + t[2] * sgn * far * 0.5]; const out = ch.convex ? !pointInside(W, probe) : pointInside(W, probe); const d = out ? far : eps * 2;
          return ring.map(q => [q[0] + t[0] * sgn * d, q[1] + t[1] * sgn * d, q[2] + t[2] * sgn * d]); };
        rings.unshift(extend(rings[0], secs[0].t, -1)); rings.push(extend(rings[rings.length - 1], secs[secs.length - 1].t, 1));
      }
      // loft
      const nr = rings.length; const pos = new Float32Array(nr * N * 3); rings.forEach((ring, k) => ring.forEach((q, i) => pos.set(q, (k * N + i) * 3)));
      const tri = []; const segs = ch.closed ? nr : nr - 1;
      for (let k = 0; k < segs; k++) { const k2 = (k + 1) % nr; for (let i = 0; i < N; i++) { const i2 = (i + 1) % N; const a = k * N + i, b = k * N + i2, c = k2 * N + i2, d = k2 * N + i; tri.push(a, b, c, a, c, d); } }
      if (!ch.closed) {
        const s0 = secs[0]; const cap2 = rings[0].map(q => { const d = [q[0] - s0.p[0], q[1] - s0.p[1], q[2] - s0.p[2]]; return [d[0] * s0.e1[0] + d[1] * s0.e1[1] + d[2] * s0.e1[2], d[0] * s0.e2[0] + d[1] * s0.e2[1] + d[2] * s0.e2[2]]; });
        const ears = earClip(cap2); const last = (nr - 1) * N;
        for (const [a, b, c] of ears) { tri.push(a, c, b); tri.push(last + a, last + b, last + c); }
      }
      // orient outward
      let vol = 0; for (let i = 0; i < tri.length; i += 3) { const a = tri[i] * 3, b = tri[i + 1] * 3, c = tri[i + 2] * 3; vol += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]); }
      if (vol < 0) for (let i = 0; i < tri.length; i += 3) { const x = tri[i + 1]; tri[i + 1] = tri[i + 2]; tri[i + 2] = x; }
      tools.push({ positions: pos, indices: new Uint32Array(tri), convex: ch.convex });
    }
    return { tools, warn };
  }
  /**
   * The cylinder a smooth curved surface lies on, or null when it is not one (a cone, a sphere, a freeform wall).
   * { a: unit axis, c: axis point at the middle of the wall, r, h0, h1: the wall's extent along a about c,
   *   hole: true when the wall faces its axis (a bore), full: the wall goes all the way round, n / phase: its facets }.
   */
  function surfCylinder(md, surf) {
    const P = md.positions, I = md.indices, sid = md.surfID; if (!sid || !P || !I) return null;
    const S = md.surfs && md.surfs[surf]; if (S && S.planar) return null;
    const tris = [], nrm = []; let big = -1, bigA = 0;
    for (let t = 0; t < sid.length; t++) {
      if (sid[t] !== surf) continue; const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      const n = cross([P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]);
      const l = Math.hypot(n[0], n[1], n[2]); if (l < 1e-14) continue;
      tris.push(t); nrm.push([n[0] / l, n[1] / l, n[2] / l, l / 2, t]); if (l > bigA) { bigA = l; big = nrm.length - 1; }
    }
    if (nrm.length < 4) return null;
    { let tot = 0; for (const n of nrm) tot += n[3]; const keep = nrm.filter(n => n[3] > 1e-5 * tot / nrm.length); if (keep.length < 4) return null; const bi = nrm[big]; nrm.length = 0; nrm.push(...keep); big = Math.max(0, nrm.indexOf(bi)); }
    const n0 = nrm[big]; let best = 0, ax = null;
    for (const n of nrm) { const x = cross(n0, n); const l = Math.hypot(x[0], x[1], x[2]); if (l > best) { best = l; ax = x; } }
    if (!ax || best < 0.05) return null;
    let a = norm(ax);
    // refine the axis: the direction most nearly perpendicular to every facet normal (smallest eigenvector of Σ w·n nᵀ)
    { const Cm = [0, 0, 0, 0, 0, 0, 0, 0, 0]; for (const n of nrm) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Cm[i * 3 + j] += n[3] * n[i] * n[j];
      const tr = Cm[0] + Cm[4] + Cm[8]; const B = Cm.map((v, k) => (k % 4 === 0 ? tr : 0) - v);   // largest eigenvector of tr·I − C
      for (let it = 0; it < 30; it++) { const q = [B[0] * a[0] + B[1] * a[1] + B[2] * a[2], B[3] * a[0] + B[4] * a[1] + B[5] * a[2], B[6] * a[0] + B[7] * a[1] + B[8] * a[2]]; const l = Math.hypot(q[0], q[1], q[2]); if (l < 1e-14) break; a = [q[0] / l, q[1] / l, q[2] / l]; } }
    { let tot = 0, off = 0; for (const n of nrm) { tot += n[3]; if (Math.abs(n[0] * a[0] + n[1] * a[1] + n[2] * a[2]) > 0.02) off += n[3]; } if (off > 1e-3 * tot) return null; }   // boolean slivers have no say
    const ref = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]; const u = norm(cross(ref, a)), v = cross(a, u);
    const seen = new Set(); const pts = [];
    for (const t of tris) for (let e = 0; e < 3; e++) { const k = I[t * 3 + e] * 3; const key = fkey(P[k], P[k + 1], P[k + 2]); if (seen.has(key)) continue; seen.add(key); pts.push([P[k] * u[0] + P[k + 1] * u[1] + P[k + 2] * u[2], P[k] * v[0] + P[k + 1] * v[1] + P[k + 2] * v[2], P[k] * a[0] + P[k + 1] * a[1] + P[k + 2] * a[2]]); }
    if (pts.length < 6) return null;
    // algebraic circle fit in the (u, v) plane, centred on the mean for conditioning
    let mx = 0, my = 0; for (const p of pts) { mx += p[0]; my += p[1]; } mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0; const m = pts.length;
    for (const p of pts) { const x = p[0] - mx, y = p[1] - my, z = x * x + y * y; sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sxz += x * z; syz += y * z; sz += z; }
    const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, m]], rhs = [-sxz, -syz, -sz];
    const det3 = M3 => M3[0][0] * (M3[1][1] * M3[2][2] - M3[1][2] * M3[2][1]) - M3[0][1] * (M3[1][0] * M3[2][2] - M3[1][2] * M3[2][0]) + M3[0][2] * (M3[1][0] * M3[2][1] - M3[1][1] * M3[2][0]);
    const D = det3(A); if (Math.abs(D) < 1e-30) return null;
    const sol = [0, 1, 2].map(k => det3(A.map((row, i) => row.map((x, j) => j === k ? rhs[i] : x))) / D);
    const cx = -sol[0] / 2, cy = -sol[1] / 2, r2 = cx * cx + cy * cy - sol[2]; if (!(r2 > 0)) return null; const r = Math.sqrt(r2);
    let h0 = Infinity, h1 = -Infinity, dev = 0; for (const p of pts) { dev = Math.max(dev, Math.abs(Math.hypot(p[0] - mx - cx, p[1] - my - cy) - r)); h0 = Math.min(h0, p[2]); h1 = Math.max(h1, p[2]); }
    if (dev > 2e-3 * r + 1e-6) return null;
    const ox = mx + cx, oy = my + cy, hm = (h0 + h1) / 2;
    const c = [ox * u[0] + oy * v[0] + hm * a[0], ox * u[1] + oy * v[1] + hm * a[1], ox * u[2] + oy * v[2] + hm * a[2]];
    // a bore's facets face the axis
    let side = 0; for (let i = 0; i < nrm.length; i++) { const t = nrm[i][4], k = I[t * 3] * 3; const w = [P[k] - c[0], P[k + 1] - c[1], P[k + 2] - c[2]]; const ax2 = w[0] * a[0] + w[1] * a[1] + w[2] * a[2]; const rad = [w[0] - a[0] * ax2, w[1] - a[1] * ax2, w[2] - a[2] * ax2]; side += nrm[i][3] * (rad[0] * nrm[i][0] + rad[1] * nrm[i][1] + rad[2] * nrm[i][2]); }
    // facets round the circle: the distinct angles of the wall's vertices (the end rings of a straight bore)
    const ang = []; const tol = 1e-4 * r; for (const p of pts) if (Math.abs(p[2] - h0) < tol + 1e-4 * (h1 - h0)) ang.push(Math.atan2(p[1] - oy, p[0] - ox));
    ang.sort((x, y) => x - y); let gap = 0; for (let i = 0; i < ang.length; i++) gap = Math.max(gap, ((ang[(i + 1) % ang.length] - ang[i]) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI);
    const nf = ang.length; const even = nf >= 8 && gap < 1.5 * (2 * Math.PI / nf);
    const ringFull = even && nf >= 8;
    // the whole wall goes round: no angular gap anywhere in its vertices
    const all = pts.map(p => Math.atan2(p[1] - oy, p[0] - ox)).sort((x, y) => x - y); let gapAll = 0; for (let i = 0; i < all.length; i++) gapAll = Math.max(gapAll, ((all[(i + 1) % all.length] - all[i]) + 2 * Math.PI) % (2 * Math.PI));
    const full = gapAll < Math.PI / 6;
    return { a, u, v, c, r, h0: h0 - hm, h1: h1 - hm, hole: side < 0, full, n: ringFull ? nf : 0, phase: ringFull ? ang[0] : 0 };
  }
  /**
   * A straight bore of any convex cross-section (an oval left by a non-uniform scale): facets all parallel to one axis and
   * facing it. Same frame as surfCylinder, plus section: the outline in (u, v) about c (convex hull of the wall). Or null.
   */
  function surfPrism(md, surf) {
    const P = md.positions, I = md.indices, sid = md.surfID; if (!sid || !P || !I) return null; const S = md.surfs && md.surfs[surf]; if (S && S.planar) return null;
    const nrm = []; let tot = 0;
    for (let t = 0; t < sid.length; t++) { if (sid[t] !== surf) continue; const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      const n = cross([P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]); const l = Math.hypot(n[0], n[1], n[2]); if (l < 1e-14) continue; nrm.push([n[0] / l, n[1] / l, n[2] / l, l / 2, t]); tot += l / 2; }
    const keep = nrm.filter(n => n[3] > 1e-5 * tot / Math.max(1, nrm.length)); if (keep.length < 6) return null;
    const Cm = [0, 0, 0, 0, 0, 0, 0, 0, 0]; for (const n of keep) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Cm[i * 3 + j] += n[3] * n[i] * n[j];
    const tr = Cm[0] + Cm[4] + Cm[8]; const B = Cm.map((v, k) => (k % 4 === 0 ? tr : 0) - v); let a = [0.31, 0.47, 0.83];
    for (let it = 0; it < 60; it++) { const q = [B[0] * a[0] + B[1] * a[1] + B[2] * a[2], B[3] * a[0] + B[4] * a[1] + B[5] * a[2], B[6] * a[0] + B[7] * a[1] + B[8] * a[2]]; const l = Math.hypot(...q); if (l < 1e-14) return null; a = [q[0] / l, q[1] / l, q[2] / l]; }
    { let off = 0; for (const n of keep) if (Math.abs(n[0] * a[0] + n[1] * a[1] + n[2] * a[2]) > 0.02) off += n[3]; if (off > 1e-3 * tot) return null; }
    const ref = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]; const u = norm(cross(ref, a)), v = cross(a, u);
    const pts = [], seen = new Set(); let h0 = Infinity, h1 = -Infinity;
    for (let t = 0; t < sid.length; t++) { if (sid[t] !== surf) continue; for (let e = 0; e < 3; e++) { const k = I[t * 3 + e] * 3; const key = fkey(P[k], P[k + 1], P[k + 2]); if (seen.has(key)) continue; seen.add(key);
      const x = P[k] * u[0] + P[k + 1] * u[1] + P[k + 2] * u[2], y = P[k] * v[0] + P[k + 1] * v[1] + P[k + 2] * v[2], h = P[k] * a[0] + P[k + 1] * a[1] + P[k + 2] * a[2]; pts.push([x, y]); h0 = Math.min(h0, h); h1 = Math.max(h1, h); } }
    if (pts.length < 6) return null;
    // convex hull of the section (monotone chain)
    const sp = pts.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]); const cr = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    const lo = [], hi = []; for (const p of sp) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); } for (let i = sp.length - 1; i >= 0; i--) { const p = sp[i]; while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
    const hull = lo.slice(0, -1).concat(hi.slice(0, -1)); if (hull.length < 3) return null;
    // the wall must lie on its hull (a convex bore), within a hair
    let A = 0, gx = 0, gy = 0; for (let i = 0; i < hull.length; i++) { const p = hull[i], q = hull[(i + 1) % hull.length]; const w = p[0] * q[1] - q[0] * p[1]; A += w; gx += (p[0] + q[0]) * w; gy += (p[1] + q[1]) * w; } if (Math.abs(A) < 1e-12) return null; gx /= 3 * A; gy /= 3 * A;
    let rmax = 0; for (const p of hull) rmax = Math.max(rmax, Math.hypot(p[0] - gx, p[1] - gy));
    const segD = (p, q, x) => { const dx = q[0] - p[0], dy = q[1] - p[1]; const L = dx * dx + dy * dy || 1; const t2 = Math.max(0, Math.min(1, ((x[0] - p[0]) * dx + (x[1] - p[1]) * dy) / L)); return Math.hypot(p[0] + dx * t2 - x[0], p[1] + dy * t2 - x[1]); };
    for (const x of pts) { let d = Infinity; for (let i = 0; i < hull.length; i++) d = Math.min(d, segD(hull[i], hull[(i + 1) % hull.length], x)); if (d > 2e-3 * rmax + 1e-6) return null; }
    const hm = (h0 + h1) / 2; const c = [gx * u[0] + gy * v[0] + hm * a[0], gx * u[1] + gy * v[1] + hm * a[1], gx * u[2] + gy * v[2] + hm * a[2]];
    let side = 0; for (const n of keep) { const t = n[4], k = I[t * 3] * 3; const w = [P[k] - c[0], P[k + 1] - c[1], P[k + 2] - c[2]]; const ax2 = w[0] * a[0] + w[1] * a[1] + w[2] * a[2]; side += n[3] * ((w[0] - a[0] * ax2) * n[0] + (w[1] - a[1] * ax2) * n[1] + (w[2] - a[2] * ax2) * n[2]); }
    if (!(side < 0)) return null;
    return { a, u, v, c, r: rmax, h0: h0 - hm, h1: h1 - hm, hole: true, full: true, n: 0, phase: 0, section: hull.map(p => [p[0] - gx, p[1] - gy]) };
  }
  /** The curved surface of md that is the bore (or boss) cyl describes after an edit, or null. */
  function findCylSurf(md, cyl) {
    if (!md.surfs || !cyl) return null; let best = null, bs = Infinity;
    md.surfs.forEach((s, i) => {
      if (s.planar) return; const q = surfCylinder(md, i); if (!q || q.hole !== cyl.hole) return;
      const d = Math.abs(q.a[0] * cyl.a[0] + q.a[1] * cyl.a[1] + q.a[2] * cyl.a[2]); if (d < 0.999) return;
      const w = [q.c[0] - cyl.c[0], q.c[1] - cyl.c[1], q.c[2] - cyl.c[2]]; const al = w[0] * cyl.a[0] + w[1] * cyl.a[1] + w[2] * cyl.a[2];
      const off = Math.hypot(w[0] - al * cyl.a[0], w[1] - al * cyl.a[1], w[2] - al * cyl.a[2]); const dr = Math.abs(q.r - cyl.r);
      if (off > 0.05 * cyl.r + 1e-6 || dr > 0.02 * cyl.r + 1e-6) return; const score = off + dr + 1e-3 * Math.abs(al); if (score < bs) { bs = score; best = i; }
    });
    return best;
  }
  /**
   * Centres of a body's round edges (a cylinder's rim, a hole's mouth, the ellipse a tilted hole cuts): every closed,
   * flat, curved edge chain gives its area centre and plane. [{ p, n, r }] (r: mean distance of the rim from the centre).
   */
  function circleCentres(md) {
    if (md._centres) return md._centres; const out = [];
    let chains = []; try { chains = edgeChains(md); } catch (e) { chains = []; }
    const diag = bboxDiag(md.positions) || 1;
    for (const ch of chains) {
      if (!ch.closed || ch.pts.length < 8) continue; const L = ch.pts; let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < L.length; i++) { const p = L[i], q = L[(i + 1) % L.length]; nx += (p[1] - q[1]) * (p[2] + q[2]); ny += (p[2] - q[2]) * (p[0] + q[0]); nz += (p[0] - q[0]) * (p[1] + q[1]); cx += p[0]; cy += p[1]; cz += p[2]; }
      const nl = Math.hypot(nx, ny, nz); if (nl < 1e-12) continue; nx /= nl; ny /= nl; nz /= nl; cx /= L.length; cy /= L.length; cz /= L.length;
      if (L.some(p => Math.abs((p[0] - cx) * nx + (p[1] - cy) * ny + (p[2] - cz) * nz) > 1e-5 * diag)) continue;   // not flat
      // area centre in the rim's own plane (exact for an ellipse however its points are spaced)
      const ref = Math.abs(nz) < 0.9 ? [0, 0, 1] : [1, 0, 0]; const u = norm(cross(ref, [nx, ny, nz])), v = cross([nx, ny, nz], u);
      const P2 = L.map(p => [(p[0] - cx) * u[0] + (p[1] - cy) * u[1] + (p[2] - cz) * u[2], (p[0] - cx) * v[0] + (p[1] - cy) * v[1] + (p[2] - cz) * v[2]]);
      let A = 0, gx = 0, gy = 0; for (let i = 0; i < P2.length; i++) { const p = P2[i], q = P2[(i + 1) % P2.length]; const w = p[0] * q[1] - q[0] * p[1]; A += w; gx += (p[0] + q[0]) * w; gy += (p[1] + q[1]) * w; }
      if (Math.abs(A) < 1e-12) continue; gx /= 3 * A; gy /= 3 * A;
      // a curve, not a polygon: no sharp corners round the rim
      let sharp = false; for (let i = 0; i < P2.length && !sharp; i++) { const a = P2[(i + P2.length - 1) % P2.length], b = P2[i], c = P2[(i + 1) % P2.length]; const d1 = [b[0] - a[0], b[1] - a[1]], d2 = [c[0] - b[0], c[1] - b[1]]; const l1 = Math.hypot(...d1), l2 = Math.hypot(...d2); if (l1 > 0 && l2 > 0 && (d1[0] * d2[0] + d1[1] * d2[1]) / (l1 * l2) < Math.cos(25 * Math.PI / 180)) sharp = true; }
      if (sharp) continue;
      const p = [cx + gx * u[0] + gy * v[0], cy + gx * u[1] + gy * v[1], cz + gx * u[2] + gy * v[2]];
      let r = 0; for (const q of L) r += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]); r /= L.length;
      // which side of the rim's plane is open air (a dot drawn there is not hidden in the face it sits on)
      const n3 = [nx, ny, nz]; const e = 1e-3 * diag; const inside = q => { const d = norm([n3[0] + 0.013, n3[1] + 0.007, n3[2] + 0.011]); const P = md.positions, I = md.indices; let hits = 0;
        for (let t = 0; t < I.length / 3; t++) { const ia = I[t * 3] * 3, ib = I[t * 3 + 1] * 3, ic = I[t * 3 + 2] * 3; const e1 = [P[ib] - P[ia], P[ib + 1] - P[ia + 1], P[ib + 2] - P[ia + 2]], e2 = [P[ic] - P[ia], P[ic + 1] - P[ia + 1], P[ic + 2] - P[ia + 2]];
          const pv = cross(d, e2); const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2]; if (Math.abs(det) < 1e-15) continue; const s0 = [q[0] - P[ia], q[1] - P[ia + 1], q[2] - P[ia + 2]];
          const uu = (s0[0] * pv[0] + s0[1] * pv[1] + s0[2] * pv[2]) / det; if (uu < 0 || uu > 1) continue; const qv = cross(s0, e1); const vv = (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]) / det; if (vv < 0 || uu + vv > 1) continue; if ((e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) / det > 1e-9) hits++; }
        return hits % 2 === 1; };
      const o = inside([p[0] + n3[0] * e, p[1] + n3[1] * e, p[2] + n3[2] * e]) ? [-nx, -ny, -nz] : n3;
      out.push({ p, n: n3, o, r });
    }
    md._centres = out; return out;
  }
  const common = Object.assign({ surfCylinder, surfPrism, findCylSurf, circleCentres, bboxDiag, scaleAbout, scaleSnapPoints, edgeChains, chainFrame, filletTools, _sliceSurface: sliceSurface, warpIsValid, trianglesIntersect, draftMatrix, rayMesh, faceFrame, placeInFrame, planeHit2D, frameToWorld, GROUND, stlBinary, objText, zipStore, signedArea, regionShape, surfaceVertexKeys, faceVertexKeys, surfOfFace, isPlanarFace, fkey, applyMat, EDGE_ANGLE }, common_extra);

  // ======================================================= Manifold engine (WebAssembly)
  function ManifoldCore(wasm) {
    const { Manifold, Mesh } = wasm;
    const box = (w, d, h, x = 0, y = 0) => Manifold.cube([w, d, h], false).translate([x - w / 2, y - d / 2, 0]);
    const cylinder = (r, h, x = 0, y = 0) => Manifold.cylinder(h, r, r, SEG, false).translate([x, y, 0]);
    const sphere = (r, x = 0, y = 0) => Manifold.sphere(r, SEG / 2).translate([x, y, r]);
    function extrude(profile, height) {
      const pts = cleanProfile(profile); if (pts.length < 3) throw new Error('Profile needs at least 3 points');
      if (signedArea(pts) < 0) pts.reverse(); return Manifold.extrude([pts], Math.abs(height));
    }
    function revolve(profile, degrees = 360, inPlace = false) {
      const pts = cleanProfile(profile).map(p => [Math.max(0, p[0]), p[1]]); if (pts.length < 3) throw new Error('Profile needs at least 3 points');
      if (signedArea(pts) < 0) pts.reverse(); const m = Manifold.revolve([pts], SEG, degrees); return inPlace ? m : m.translate([0, 0, -m.boundingBox().min[2]]);
    }
    /**
     * Helical revolve (Shapr3D's revolve with a height): the profile [radius, along-axis] turns `degrees` about the z axis
     * while it rises `height` along it — a thread when the profile is a V and height/turns is the pitch. Both may be
     * negative; their signs together set the hand (same sign: right-hand). Local coords, axis = z, start at angle 0 (+x).
     */
    function helix(profile, degrees, height) {
      let pts = cleanProfile(profile).map(p => [Math.max(0, p[0]), p[1]]); if (pts.length < 3) throw new Error('Profile needs at least 3 points');
      if (signedArea(pts) < 0) pts = pts.slice().reverse();
      const turns = Math.abs(degrees) / 360; const m0 = pts.length;
      if (!(Math.abs(height) > 0) && turns > 1 + 1e-9) throw new Error('Over 360° needs a height (a helix)');
      // consecutive turns sit one pitch apart along the axis: a profile longer than the pitch would overlap the next turn
      // (a mesh check cannot see that). Touching is fine (an M12 V is exactly one pitch wide); a 0.1 % tolerance allows it.
      if (turns > 1 + 1e-9) { const zs = pts.map(p => p[1]); const ext = Math.max(...zs) - Math.min(...zs); const pitch = Math.abs(height) / turns;
        if (pitch < ext * (1 - 1e-3)) throw new Error(`That helix crosses itself: the profile is ${+ext.toFixed(3)} long along the axis but each turn rises only ${+pitch.toFixed(3)} — make the height larger or the angle smaller`); }
      // memory: at most about 120k vertices (a 34-turn M12 thread uses about 18k)
      const perTurn = Math.max(12, Math.min(SEG, Math.floor(120000 / Math.max(1, m0 * turns)))); if (turns * perTurn * m0 > 240000) throw new Error('Too many turns for one helix · use fewer turns or a simpler profile');
      const n = Math.max(8, Math.ceil(turns * perTurn));
      const pos = [], tri = [];
      for (let i = 0; i <= n; i++) { const f = i / n, t = degrees * f * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), dz = height * f;
        for (const p of pts) pos.push(p[0] * c, p[0] * s, p[1] + dz); }
      for (let i = 0; i < n; i++) for (let j = 0; j < m0; j++) { const a = i * m0 + j, b = i * m0 + (j + 1) % m0, cc = (i + 1) * m0 + (j + 1) % m0, d = (i + 1) * m0 + j; tri.push(a, b, cc, a, cc, d); }
      const caps = wasm.triangulate([pts], 1e-12); const last = n * m0;
      for (const t of caps) { tri.push(t[0], t[2], t[1]); tri.push(last + t[0], last + t[1], last + t[2]); }
      const make = T => Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: Float32Array.from(pos), triVerts: Uint32Array.from(T) }));
      let m = make(tri); if (m.volume() < 0) { const r = []; for (let k = 0; k < tri.length; k += 3) r.push(tri[k], tri[k + 2], tri[k + 1]); m = make(r); }
      if (typeof m.status === 'function' && m.status() !== 'NoError') throw new Error('The helix could not be built as a closed solid (' + m.status() + ')');
      return m;
    }
    /** regions: [{outer (CCW), holes (CW)}] → one solid per region, local coords, z in [0, h]. */
    function extrudeRegions(regions, height, draftDeg = 0) {
      const h = Math.abs(height);
      return regions.map(r => {
        const polys = [signedArea(r.outer) < 0 ? r.outer.slice().reverse() : r.outer, ...r.holes.map(hh => signedArea(hh) > 0 ? hh.slice().reverse() : hh)];
        if (!draftDeg) return Manifold.extrude(polys, h);
        const { c } = regionShape(r.outer); const sc = draftScale(r.outer, h, draftDeg);
        const local = polys.map(poly => poly.map(q => [q[0] - c[0], q[1] - c[1]]));
        return Manifold.extrude(local, h, 0, 0, [sc, sc]).translate([c[0], c[1], 0]);
      });
    }
    function meshData(manifold) {
      const m = manifold.getMesh();
      const np = m.numProp, nv = m.numVert;
      const positions = new Float32Array(nv * 3), normals = new Float32Array(nv * 3);   // normals are rebuilt per smooth surface in finishMesh
      for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) positions[i * 3 + k] = m.vertProperties[i * np + k];
      const indices = new Uint32Array(m.triVerts);
      // Manifold's faceID is only unique within one run (one original input body), so after a boolean a box top and a
      // cylinder facet can share an id. Re-key by (run, faceID) so every face of the result has its own id.
      const nTri = indices.length / 3; const faceID = new Uint32Array(nTri), origin = new Uint32Array(nTri); const ids = new Map(); const runIndex = m.runIndex; let run = 0;
      for (let t = 0; t < nTri; t++) {
        if (runIndex) while (run + 2 < runIndex.length && t * 3 >= runIndex[run + 1]) run++;
        const key = run + ':' + (m.faceID ? Number(m.faceID[t]) : t); let id = ids.get(key); if (id === undefined) { id = ids.size; ids.set(key, id); } faceID[t] = id;
        origin[t] = m.runOriginalID ? Number(m.runOriginalID[run]) : 0;
      }
      return finishMesh({ positions, normals, indices, faceID, origin });
    }
    /** Removes the needle-thin scraps a boolean leaves where faces nearly coincide (a size-relative tolerance). */
    function clean(manifold) {
      if (!manifold || typeof manifold.simplify !== 'function') return manifold;
      try { const bb = manifold.boundingBox(); const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]); const r = manifold.simplify(Math.max(1e-9, 2e-6 * diag)); return r.volume() > 1e-12 ? r : manifold; } catch (e) { return manifold; }
    }
    /** Push/pull a planar face: moves the face (neighbours stretch, exact, no seams); if that would make an invalid body, adds or cuts a prism instead. */
    function pushPull(manifold, md, faceId, distance, opts = {}) {
      if (opts.draft) { // tilted walls: the face moves and shrinks/grows, the walls lean from their base (no step)
        const keys = faceVertexKeys(md, faceId); const test = (x, y, z) => keys.has(fkey(x, y, z)); const M = draftMatrix(md, faceId, distance, opts.draft);
        const w = deformWarp(manifold, md, M, test, opts); if (w.ok) return w.solid;
        throw new Error("Operation failed because the resulting body wouldn't be valid");
      }
      if (Math.abs(distance) < 1e-6) return manifold;
      const f = faceFrame(md, faceId); const eps = 1e-4, d = Math.abs(distance);
      const keys = faceVertexKeys(md, faceId); const test = (x, y, z) => keys.has(fkey(x, y, z)); const M = offsetMatrix(f.n, distance);
      const w = deformWarp(manifold, md, M, test, opts) || warpChecked(manifold, M, test);
      if (w.ok) return w.solid;
      // Prism tool: its rims are rebuilt from the face's exact vertices so its walls continue the neighbouring walls exactly.
      const exact = new Map(); const flat = [];
      manifold.warp(p => { if (keys.has(fkey(p[0], p[1], p[2]))) { const dx = p[0] - f.origin[0], dy = p[1] - f.origin[1], dz = p[2] - f.origin[2]; const u = dx * f.u[0] + dy * f.u[1] + dz * f.u[2], v = dx * f.v[0] + dy * f.v[1] + dz * f.v[2]; exact.set(u + ',' + v, [p[0], p[1], p[2]]); flat.push(u, v, 0); } });
      const bb = manifold.boundingBox(); const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1; const snap = vertexSnapper(flat, 1e-5 * diag);
      const prism = Manifold.extrude(f.loops, d).translate([0, 0, distance > 0 ? 0 : -d]);
      const placed = prism.warp(p => {
        const q = snap(p[0], p[1], 0); const e = q && exact.get(q[0] + ',' + q[1]);
        const w = e ? [e[0] + f.n[0] * p[2], e[1] + f.n[1] * p[2], e[2] + f.n[2] * p[2]] : frameToWorld(f, p[0], p[1], p[2]);
        p[0] = w[0]; p[1] = w[1]; p[2] = w[2];
      });
      return clean(distance > 0 ? manifold.add(placed) : manifold.subtract(placed));
    }
    /** The exact (double precision) vertices of a solid, flat xyz. */
    function exactVertices(manifold) { const out = []; manifold.warp(p => { out.push(p[0], p[1], p[2]); }); return out; }
    /** Snaps a tool body's vertices onto a target body's exact vertices wherever they nearly coincide. */
    function snapToBody(tool, target) {
      const bb = target.boundingBox(); const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1;
      const snap = vertexSnapper(exactVertices(target), 1e-5 * diag);
      return tool.warp(p => { const q = snap(p[0], p[1], p[2]); if (q) { p[0] = q[0]; p[1] = q[1]; p[2] = q[2]; } });
    }
    /** Joins (op 'join'), cuts ('cut') or intersects a tool body with a host: the tool's vertices are first snapped onto the
     *  host's exact vertices where they nearly coincide, so shared rims and walls continue exactly and no seam slivers appear. */
    function fuse(host, tool, op) {
      const t = snapToBody(tool, host);
      return clean(op === 'cut' ? host.subtract(t) : op === 'intersect' ? host.intersect(t) : host.add(t));
    }
    /** Rigid transform of a whole solid by a column-major 4x4 matrix. */
    function transformSolid(manifold, M) {
      if (typeof manifold.transform === 'function') { try { return manifold.transform(Array.from(M)); } catch (e) { /* fall through */ } }
      return manifold.warp(p => { const q = applyMat(M, p[0], p[1], p[2]); p[0] = q[0]; p[1] = q[1]; p[2] = q[2]; });
    }
    /**
     * Moves only the vertices that pass `test` (a Move/Rotate of one face): neighbouring faces stretch to follow.
     * Returns {solid, ok}; ok is false when the result would be an invalid body (folded or collapsed triangles).
     */
    function warpChecked(manifold, M, test) {
      // validate on a JS copy first (Manifold re-sorts vertices on output, so before/after cannot be matched by index)
      const g0 = manifold.getMesh(); const np = g0.numProp; const P0 = g0.vertProperties, I = g0.triVerts;
      const P1 = Float64Array.from(P0);
      for (let v = 0; v < P0.length; v += np) if (test(P0[v], P0[v + 1], P0[v + 2])) { const q = applyMat(M, P0[v], P0[v + 1], P0[v + 2]); P1[v] = q[0]; P1[v + 1] = q[1]; P1[v + 2] = q[2]; }
      if (!warpIsValid(P0, P1, I, np)) return { solid: manifold, ok: false };
      const out = manifold.warp(p => { if (test(p[0], p[1], p[2])) { const q = applyMat(M, p[0], p[1], p[2]); p[0] = q[0]; p[1] = q[1]; p[2] = q[2]; } });
      return { solid: out, ok: out.volume() > 1e-12 };
    }
    /**
     * Face move with smoothly bending neighbours (see deformMesh). Returns {solid, ok}, or null when no face bends (then a
     * plain warp is exact). The same body-level checks as a plain move apply first: nothing may turn inside out or pierce.
     */
    function deformWarp(manifold, md, M, test, opts = {}) {
      const dm = deformMesh(md, M, test, opts);
      if (!dm) return warpChecked(manifold, M, test);   // nothing bends: the plain move is exact
      // the smooth result must pass the same body checks as a plain move: nothing collapsed, turned inside out or piercing
      if (!dm.ok || !warpIsValid(dm.P0, dm.P1, dm.indices, 3)) return { solid: manifold, ok: false };
      let out; try { out = Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: Float32Array.from(dm.P1), triVerts: dm.indices })); } catch (e) { return warpChecked(manifold, M, test); }
      if ((typeof out.status === 'function' && out.status() !== 'NoError') || !(out.volume() > 1e-12)) return warpChecked(manifold, M, test);
      return { solid: out, ok: true };
    }
    /** Chamfer / fillet the chains of a body: convex edges are cut, concave ones filled. Returns {solid, warn} or throws. */
    /**
     * Shapr3D-style move of a planar face: the face is a plane, and moving or turning it moves that plane while the walls
     * around it keep their own shape: they run on straight past the face (or are cut back) to meet the new plane, as a
     * slanted cut does. Works when every wall at the face runs straight along its normal (cylinders, boxes, extrusions).
     * The cut stays inside the face's own column, so neighbouring parts of the body are left alone.
     * Returns null when the case is not one for this method (walls not straight along the normal, or a move that keeps
     * the plane: a twist or a slide), { ok: false } when the plane would cut through the far end of the walls (or turn
     * too steeply), else { ok: true, solid }.
     */
    /**
     * Loft plan: matched points on every profile and the guide curves through them.
     * sections: [{ frame: { origin, u, v, n }, outer: [[x, y]…], holes: [[[x, y]…]…] }] in loft order.
     * opts.smooth (default true): guide curves pass smoothly through every profile (centripetal Catmull-Rom); false: straight
     * between profiles. opts.steps: samples per span. Returns { rings: [[loop points…] per loop] per ring, holes: count,
     * guides: [polyline] (one per profile corner, for the preview), dots: [corner points on the profiles] }.
     */
    function loftPlan(sections, opts = {}) {
      if (!sections || sections.length < 2) throw new Error('Pick at least two profiles to loft');
      const nh = (sections[0].holes || []).length;
      if (sections.some(q => (q.holes || []).length !== nh)) throw new Error('All profiles need the same number of holes to loft');
      const V = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const nrm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }, crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const area2 = L => { let s2 = 0; for (let i = 0; i < L.length; i++) { const a = L[i], b = L[(i + 1) % L.length]; s2 += a[0] * b[1] - b[0] * a[1]; } return s2 / 2; };
      const tidy = L => { const out = []; for (const p of L) if (!out.length || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > 1e-9) out.push(p);
        if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-9) out.pop();
        for (let changed = true; changed && out.length > 3;) { changed = false; for (let i = 0; i < out.length; i++) { const a = out[(i + out.length - 1) % out.length], b = out[i], c = out[(i + 1) % out.length]; const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]); const sc = Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1]); if (Math.abs(cr) <= 1e-9 * (sc || 1)) { out.splice(i, 1); changed = true; break; } } }
        if (out.length < 3) throw new Error('A profile is too small or flat to loft'); return out; };
      const K = sections.length; const toW = (f, p) => frameToWorld(f, p[0], p[1], 0);
      const secs = sections.map(q => ({ f: q.frame, outer: tidy(q.outer), holes: (q.holes || []).map(tidy) }));
      const cen = secs.map(q => { const pts = q.outer.map(p => toW(q.f, p)); return pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length, a[2] + p[2] / pts.length], [0, 0, 0]); });
      const dirAt = k => nrm(k < K - 1 ? V(cen[k + 1], cen[k]) : V(cen[k], cen[k - 1]));
      // each loop as world points, turning counter-clockwise about the loft direction
      // (the turning direction is measured from the loop's own 3D points, so a frame of either handedness works)
      const newell = pts => { const n = [0, 0, 0]; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]); } return n; };
      const loopW = (k, L) => { let pts = L.map(p => toW(secs[k].f, p)); if (dot(newell(pts), dirAt(k)) < 0) pts = pts.slice().reverse(); return pts; };
      const loops = [secs.map((q, k) => loopW(k, q.outer))]; for (let h = 0; h < nh; h++) loops.push(secs.map((q, k) => loopW(k, q.holes[h])));
      if (nh > 1) { // holes are matched to the holes of the first profile nearest to them (relative to the outline centre)
        for (let k = 1; k < K; k++) { const rel = L => { const c = L.reduce((a, p) => [a[0] + p[0] / L.length, a[1] + p[1] / L.length, a[2] + p[2] / L.length], [0, 0, 0]); return V(c, cen[k]); };
          const want = loops.slice(1).map(hl => V(hl[0].reduce((a, p) => [a[0] + p[0] / hl[0].length, a[1] + p[1] / hl[0].length, a[2] + p[2] / hl[0].length], [0, 0, 0]), cen[0]));
          const have = loops.slice(1).map(hl => hl[k]); const used = new Set(); const order = want.map(w => { let bi = -1, bd = Infinity; have.forEach((L, i) => { if (used.has(i)) return; const r = rel(L); const d = Math.hypot(r[0] - w[0], r[1] - w[1], r[2] - w[2]); if (d < bd) { bd = d; bi = i; } }); used.add(bi); return have[bi]; });
          order.forEach((L, i) => { loops[i + 1][k] = L; }); } }
      // matched points: equal corner counts pair corner to corner (crisp edges); otherwise points spread along each loop by edge
      // length, keeping every corner. Then each profile's start is turned to line up with the one before (no twist).
      const sampleLoop = (L, per) => { const out = []; for (let i = 0; i < L.length; i++) { const a = L[i], b = L[(i + 1) % L.length]; for (let j = 0; j < per[i]; j++) { const t = j / per[i]; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); } } return out; };
      const rotBetween = (a, b) => { const c = crs(a, b), s2 = Math.hypot(...c), co = dot(a, b); if (s2 < 1e-12) return co > 0 ? (p => p) : (p => { const axis = Math.abs(a[0]) < 0.9 ? nrm(crs(a, [1, 0, 0])) : nrm(crs(a, [0, 1, 0])); const d = dot(axis, p); return [2 * axis[0] * d - p[0], 2 * axis[1] * d - p[1], 2 * axis[2] * d - p[2]]; });
        const k = [c[0] / s2, c[1] / s2, c[2] / s2]; const ang = Math.atan2(s2, co), cs = Math.cos(ang), sn = Math.sin(ang); return p => { const kd = dot(k, p), kx = crs(k, p); return [p[0] * cs + kx[0] * sn + k[0] * kd * (1 - cs), p[1] * cs + kx[1] * sn + k[1] * kd * (1 - cs), p[2] * cs + kx[2] * sn + k[2] * kd * (1 - cs)]; }; };
      const loopNormal = L => { let n = [0, 0, 0]; for (let i = 0; i < L.length; i++) { const a = L[i], b = L[(i + 1) % L.length]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]); } return nrm(n); };
      const corners = []; // per loop: which matched indices are corners of the first profile
      const matched = loops.map((perK, li) => {
        const counts = perK.map(L => L.length); const same = counts.every(c => c === counts[0]) && counts[0] <= 32;
        let pts; let cornerIdx;
        if (same) { const m = Math.max(2, Math.ceil(64 / counts[0])); pts = perK.map(L => sampleLoop(L, L.map(() => m))); cornerIdx = counts[0] <= 24 ? Array.from({ length: counts[0] }, (_, i) => i * m) : Array.from({ length: 8 }, (_, i) => Math.round(i * pts[0].length / 8)); }
        else { const N = Math.max(96, ...counts.map(c => 2 * c));
          pts = perK.map(L => { const len = L.map((a, i) => { const b = L[(i + 1) % L.length]; return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); }); const tot = len.reduce((x, y) => x + y, 0);
            const per = len.map(l => Math.max(1, Math.round(N * l / tot))); let d = N - per.reduce((x, y) => x + y, 0);
            while (d !== 0) { let bi = 0; for (let i = 1; i < per.length; i++) if (d > 0 ? len[i] / per[i] > len[bi] / per[bi] : (per[i] > 1 && len[i] / per[i] < len[bi] / per[bi]) || per[bi] <= 1) bi = i; per[bi] += d > 0 ? 1 : -1; d += d > 0 ? -1 : 1; }
            return sampleLoop(L, per); });
          const small = counts.indexOf(Math.min(...counts)); cornerIdx = counts[small] <= 24 ? (() => { const L = perK[small]; const idx = []; const P = pts[small]; for (const c of L) { let bi = 0, bd = Infinity; P.forEach((q, i) => { const dd = Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]); if (dd < bd) { bd = dd; bi = i; } }); idx.push(bi); } return idx; })() : Array.from({ length: 8 }, (_, i) => Math.round(i * N / 8)); }
        for (let k = 1; k < K; k++) { const A = pts[k - 1], B = pts[k]; const n = A.length; const ca = A.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n, a[2] + p[2] / n], [0, 0, 0]), cb = B.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n, a[2] + p[2] / n], [0, 0, 0]);
          const R = rotBetween(loopNormal(B), loopNormal(A)); const rb = B.map(p => R(V(p, cb))), ra = A.map(p => V(p, ca));
          const step = same ? Math.max(1, n / counts[0]) : 1; let best = 0, bd = Infinity;
          for (let s2 = 0; s2 < n; s2 += step) { let d = 0; for (let i = 0; i < n; i++) { const q = rb[(i + s2) % n], p2 = ra[i]; d += (q[0] - p2[0]) ** 2 + (q[1] - p2[1]) ** 2 + (q[2] - p2[2]) ** 2; if (d >= bd) break; } if (d < bd) { bd = d; best = s2; } }
          if (best) pts[k] = B.slice(best).concat(B.slice(0, best)); }
        corners.push(cornerIdx); return pts;
      });
      // guide curves through the matched points
      const smooth = opts.smooth !== false && K > 2; const steps = Math.max(2, opts.steps || (smooth ? 16 : 24));
      const along = (P, t) => { // point on the guide through P[0..K-1] at t in [0, K-1]
        const k = Math.min(K - 2, Math.floor(t)), u = t - k; const a = P[k], b = P[k + 1];
        if (!smooth) return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
        const p0 = k > 0 ? P[k - 1] : [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]], p3 = k + 2 < K ? P[k + 2] : [2 * b[0] - a[0], 2 * b[1] - a[1], 2 * b[2] - a[2]];
        const tj = (x, y) => Math.max(1e-9, Math.sqrt(Math.hypot(y[0] - x[0], y[1] - x[1], y[2] - x[2])));   // centripetal
        const t0 = 0, t1 = t0 + tj(p0, a), t2 = t1 + tj(a, b), t3 = t2 + tj(b, p3); const T = t1 + (t2 - t1) * u;
        const L = (x, y, ta, tb) => { const w = (T - ta) / (tb - ta); return [x[0] + (y[0] - x[0]) * w, x[1] + (y[1] - x[1]) * w, x[2] + (y[2] - x[2]) * w]; };
        const A1 = L(p0, a, t0, t1), A2 = L(a, b, t1, t2), A3 = L(b, p3, t2, t3), B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3); return L(B1, B2, t1, t2); };
      const Rn = (K - 1) * steps + 1; const rings = [];
      for (let r = 0; r < Rn; r++) { const t = r / steps; rings.push(matched.map(pts => pts[0].map((_, j) => { const P = pts.map(L => L[j]); return r === Rn - 1 ? P[K - 1].slice() : (r % steps === 0 ? P[r / steps].slice() : along(P, t)); }))); }
      const guides = [], dots = [];
      matched.forEach((pts, li) => { for (const j of corners[li]) { guides.push(rings.map(ring => ring[li][j])); for (const L of pts) dots.push(L[j].slice()); } });
      return { rings, holes: nh, guides, dots, smooth };
    }
    /** The preview's guide lines and corner dots for a loft (see loftPlan). */
    function loftGuides(sections, opts = {}) { const pl = loftPlan(sections, { ...opts, steps: opts.steps || 12 }); return { corners: pl.guides, dots: pl.dots }; }
    /** A solid lofted through the profiles in order (see loftPlan): sides from the guide curves, the end profiles as caps. */
    function loft(sections, opts = {}) {
      const pl = loftPlan(sections, opts); const R = pl.rings; const Rn = R.length; const nl = R[0].length;
      const pos = [], tri = []; const base = []; let nv = 0;
      for (let r = 0; r < Rn; r++) { base.push([]); for (let l = 0; l < nl; l++) { base[r].push(nv); for (const p of R[r][l]) { pos.push(p[0], p[1], p[2]); nv++; } } }
      for (let l = 0; l < nl; l++) { const n = R[0][l].length; const hole = l > 0;
        for (let r = 0; r + 1 < Rn; r++) for (let j = 0; j < n; j++) { const a = base[r][l] + j, b = base[r][l] + (j + 1) % n, c = base[r + 1][l] + (j + 1) % n, d = base[r + 1][l] + j;
          if (hole) tri.push(a, c, b, a, d, c); else tri.push(a, b, c, a, c, d); } }
      // caps: the first and last rings, triangulated with their holes, facing out of the ends
      const cap = (r, outward) => { const ring = R[r]; const nn = outward; const e1 = (() => { const t = Math.abs(nn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; const c = [nn[1] * t[2] - nn[2] * t[1], nn[2] * t[0] - nn[0] * t[2], nn[0] * t[1] - nn[1] * t[0]]; const l = Math.hypot(...c); return c.map(v => v / l); })();
        const e2 = [nn[1] * e1[2] - nn[2] * e1[1], nn[2] * e1[0] - nn[0] * e1[2], nn[0] * e1[1] - nn[1] * e1[0]]; const to2 = p => [p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2], p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2]];
        const polys = [], map = []; ring.forEach((L, l) => { let P2 = L.map(to2); let idx = L.map((_, j) => base[r][l] + j); const a2 = (() => { let s2 = 0; for (let i = 0; i < P2.length; i++) { const a = P2[i], b = P2[(i + 1) % P2.length]; s2 += a[0] * b[1] - b[0] * a[1]; } return s2; })();
          if ((l === 0) !== (a2 > 0)) { P2 = P2.slice().reverse(); idx = idx.slice().reverse(); } polys.push(P2); map.push(...idx); });
        const tris = wasm.triangulate(polys, 1e-12); for (const t of tris) tri.push(map[t[0]], map[t[1]], map[t[2]]); };
      const d0 = (() => { const a = R[0][0], b = R[1][0]; const ca = a.reduce((s2, p) => [s2[0] + p[0], s2[1] + p[1], s2[2] + p[2]], [0, 0, 0]), cb = b.reduce((s2, p) => [s2[0] + p[0], s2[1] + p[1], s2[2] + p[2]], [0, 0, 0]); const d = [cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2]]; const l = Math.hypot(...d) || 1; return d.map(v => v / l); })();
      const d1 = (() => { const a = R[Rn - 2][0], b = R[Rn - 1][0]; const ca = a.reduce((s2, p) => [s2[0] + p[0], s2[1] + p[1], s2[2] + p[2]], [0, 0, 0]), cb = b.reduce((s2, p) => [s2[0] + p[0], s2[1] + p[1], s2[2] + p[2]], [0, 0, 0]); const d = [cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2]]; const l = Math.hypot(...d) || 1; return d.map(v => v / l); })();
      // a cap faces along the loop's own turning axis (the loops turn counter-clockwise about the loft direction)
      const loopN = L => { let n = [0, 0, 0]; for (let i = 0; i < L.length; i++) { const a = L[i], b = L[(i + 1) % L.length]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]); } const l = Math.hypot(...n) || 1; return n.map(v => v / l); };
      const n0 = loopN(R[0][0]), n1 = loopN(R[Rn - 1][0]);
      cap(0, n0[0] * d0[0] + n0[1] * d0[1] + n0[2] * d0[2] > 0 ? n0.map(v => -v) : n0);
      cap(Rn - 1, n1[0] * d1[0] + n1[1] * d1[1] + n1[2] * d1[2] > 0 ? n1 : n1.map(v => -v));
      let m; try { m = Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: Float32Array.from(pos), triVerts: Uint32Array.from(tri) })); } catch (e) { throw new Error('These profiles cannot be lofted into a valid body (try reordering them)'); }
      if (typeof m.status === 'function' && m.status() !== 'NoError') throw new Error('These profiles cannot be lofted into a valid body (try reordering them)');
      if (m.volume() < 0) throw new Error('These profiles cannot be lofted into a valid body (try reordering them)');
      return clean(m);
    }
    /**
     * Sweep: a profile carried along a path. profile: { frame, outer, holes } (a flat shape standing across the path);
     * path: { pts: [[x, y, z]…], closed }. opts.round: corner radius (0 = sharp corners with clean mitred joints).
     * The profile keeps its place relative to the path start (a closed path starts where it passes nearest the profile) and
     * turns with the path without twisting (rotation-minimising frames).
     */
    function sweep(profile, path, opts = {}) {
      const V = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], A = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], Sc = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const len = a => Math.hypot(a[0], a[1], a[2]), nrm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
      let P = []; for (const q of (path && path.pts) || []) if (!P.length || len(V(q, P[P.length - 1])) > 1e-9) P.push(q.slice());
      const closed = !!(path && path.closed); if (closed && P.length > 2 && len(V(P[0], P[P.length - 1])) < 1e-9) P.pop();
      if (P.length < 2 || (closed && P.length < 3)) throw new Error('The path needs at least one edge to sweep along');
      const toW = (f, p) => frameToWorld(f, p[0], p[1], 0);
      let outerW = profile.outer.map(p => toW(profile.frame, p)); let holesW = (profile.holes || []).map(h => h.map(p => toW(profile.frame, p)));
      let pc = outerW.reduce((a, p) => A(a, Sc(p, 1 / outerW.length)), [0, 0, 0]);
      // an open path is swept from the end nearer the profile
      if (!closed && len(V(pc, P[P.length - 1])) < len(V(pc, P[0]))) P = P.slice().reverse();
      // a closed path starts where it passes nearest the profile (the profile then stands across that edge)
      if (closed) { let best = null; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length], ab = V(b, a); const t = Math.max(0, Math.min(1, dot(V(pc, a), ab) / (dot(ab, ab) || 1))); const q = A(a, Sc(ab, t)); const d = len(V(pc, q)); if (!best || d < best.d) best = { d, i, q }; }
        const q = best.q; const rot = [...P.slice(best.i + 1), ...P.slice(0, best.i + 1)]; P = [q, ...rot.filter(p => len(V(p, q)) > 1e-9)]; }
      // round corners: each corner becomes an arc (its radius held so neighbouring corners never overlap)
      const R0 = Math.max(0, opts.round || 0);
      if (R0 > 0) { const out = []; const n = P.length;
        for (let i = 0; i < n; i++) {
          const has = closed || (i > 0 && i < n - 1); if (!has) { out.push(P[i]); continue; }
          const pa = P[(i - 1 + n) % n], pb = P[(i + 1) % n], a = nrm(V(P[i], pa)), b = nrm(V(pb, P[i])); const co = Math.max(-1, Math.min(1, dot(a, b))); const th = Math.acos(co);
          if (th < 1e-6) { out.push(P[i]); continue; }
          const li = len(V(P[i], pa)) / 2, lo = len(V(pb, P[i])) / 2; let t = R0 * Math.tan(th / 2); t = Math.min(t, li, lo); const R = t / Math.tan(th / 2);
          const nIn = nrm(V(b, Sc(a, co))); const Aa = V(P[i], Sc(a, t)); const Cc = A(Aa, Sc(nIn, R)); const steps = Math.max(3, Math.ceil(th / (5 * Math.PI / 180)));
          for (let k = 0; k <= steps; k++) { const f = th * k / steps; out.push(A(Cc, A(Sc(nIn, -R * Math.cos(f)), Sc(a, R * Math.sin(f))))); }
        }
        P = out.filter((p, i, arr) => i === 0 || len(V(p, arr[i - 1])) > 1e-9); if (closed && len(V(P[0], P[P.length - 1])) < 1e-9) P.pop(); }
      // The profile is used as it stands when the path passes through it (a deliberate off-centre tube); otherwise it is carried
      // onto the path's start and turned to face along the path, so the body follows the path that was drawn.
      { const t0 = nrm(V(P[1], P[0])); const f = profile.frame; const nP0 = (() => { const q = [0, 0, 0]; for (let i = 0; i < outerW.length; i++) { const a = outerW[i], b = outerW[(i + 1) % outerW.length]; q[0] += (a[1] - b[1]) * (a[2] + b[2]); q[1] += (a[2] - b[2]) * (a[0] + b[0]); q[2] += (a[0] - b[0]) * (a[1] + b[1]); } return nrm(q); })();
        const rel = V(P[0], f.origin); const loc = [dot(rel, f.u) / (dot(f.u, f.u) || 1), dot(rel, f.v) / (dot(f.v, f.v) || 1)]; const L = profile.outer; let inside = false;
        for (let i = 0, j = L.length - 1; i < L.length; j = i++) { const a = L[i], b = L[j]; if ((a[1] > loc[1]) !== (b[1] > loc[1]) && loc[0] < (b[0] - a[0]) * (loc[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; }
        const onPlane = Math.abs(dot(rel, nP0)) <= 1e-6 * Math.max(1, len(rel)) + 1e-9; const across = Math.abs(dot(nP0, t0)) >= 0.2;
        if (!(inside && onPlane && across)) {
          const to = dot(nP0, t0) >= 0 ? t0 : Sc(t0, -1); const c2 = crs(nP0, to), s2 = len(c2), co = dot(nP0, to);
          const R = s2 < 1e-12 ? (co > 0 ? null : (() => { const ax = nrm(Math.abs(nP0[0]) < 0.9 ? crs(nP0, [1, 0, 0]) : crs(nP0, [0, 1, 0])); return { k: ax, c: -1, s: 0 }; })()) : { k: Sc(c2, 1 / s2), c: co, s: s2 };
          const turn = v => { if (!R) return v; const { k, c, s: sn } = R; const kd = dot(k, v), kx = crs(k, v); return [v[0] * c + kx[0] * sn + k[0] * kd * (1 - c), v[1] * c + kx[1] * sn + k[1] * kd * (1 - c), v[2] * c + kx[2] * sn + k[2] * kd * (1 - c)]; };
          const carry = q => A(P[0], turn(V(q, pc))); outerW = outerW.map(carry); holesW = holesW.map(h => h.map(carry)); pc = P[0].slice();
        } }
      const n = P.length;
      // tangents: along the edge at the ends of an open path, the bisector at each corner (a mitre: the section is stretched by
      // 1 / cos(half the turn) across the bend so the tube keeps its thickness)
      const segDir = i => nrm(V(P[(i + 1) % n], P[i]));
      const T = [], mit = [];
      for (let i = 0; i < n; i++) {
        const inD = (closed || i > 0) ? segDir((i - 1 + n) % n) : null, outD = (closed || i < n - 1) ? segDir(i) : null;
        if (!inD) { T.push(outD); mit.push(null); continue; } if (!outD) { T.push(inD); mit.push(null); continue; }
        const bis = nrm(A(inD, outD)); const co = Math.max(-1, Math.min(1, dot(inD, outD))); const half = Math.acos(co) / 2;
        if (half < 1e-9) { T.push(bis); mit.push(null); continue; } if (half > Math.PI / 2 - 1e-3) throw new Error('The path turns back on itself here: round the corner or change the path');
        const dir = nrm(V(outD, inD)); mit.push({ dir, k: 1 / Math.cos(half) }); T.push(bis);
      }
      const T0 = closed ? segDir(0) : T[0];
      // the profile must stand across the path (its plane crossing the start), not lie along it
      const newell = pts => { const q = [0, 0, 0]; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; q[0] += (a[1] - b[1]) * (a[2] + b[2]); q[1] += (a[2] - b[2]) * (a[0] + b[0]); q[2] += (a[0] - b[0]) * (a[1] + b[1]); } return q; };
      const pn = newell(outerW); if (Math.abs(dot(nrm(pn), T0)) < 0.2) throw new Error('The profile must stand across the path (turn it to face along the path first)');
      // loops turning counter-clockwise about the path's direction, holes the other way
      const orient = (L, ccw) => (dot(newell(L), T0) > 0) === ccw ? L : L.slice().reverse();
      const loops = [orient(outerW, true), ...holesW.map(h => orient(h, true))];   // (hole walls are turned inward when the sides are built)
      // rotation-minimising frames: each ring is the profile turned by the rotation carrying the start tangent to its tangent
      const rotBetween = (a, b) => { const c = crs(a, b), s2 = len(c), co = dot(a, b); if (s2 < 1e-12) return co > 0 ? null : 'flip'; const k = Sc(c, 1 / s2), ang = Math.atan2(s2, co); return { k, c: Math.cos(ang), s: Math.sin(ang) }; };
      const applyR = (R, v) => { if (!R) return v; const { k, c, s: sn } = R; const kd = dot(k, v), kx = crs(k, v); return [v[0] * c + kx[0] * sn + k[0] * kd * (1 - c), v[1] * c + kx[1] * sn + k[1] * kd * (1 - c), v[2] * c + kx[2] * sn + k[2] * kd * (1 - c)]; };
      const rings = []; let Rs = []; let prevT = T0; const base = P[0];
      for (let i = 0; i < n; i++) {
        const Ti = T[i]; const r = rotBetween(prevT, Ti); if (r === 'flip') throw new Error('The path turns back on itself here: round the corner or change the path'); if (r) Rs = [r, ...Rs]; prevT = Ti;   // (applied newest last)
        const place = q => { let v = V(q, base); for (let j = Rs.length - 1; j >= 0; j--) v = applyR(Rs[j], v); const m = mit[i]; if (m) { const d = dot(v, m.dir); v = A(v, Sc(m.dir, d * (m.k - 1))); } return A(P[i], v); };
        rings.push(loops.map(L => L.map(place)));
      }
      // A tube that folds over itself (a profile bigger than a bend is tight) is refused, not built: between neighbouring rings
      // every point must move forward along the path.
      { const spansF = closed ? n : n - 1;
        for (let r = 0; r < spansF; r++) { const r2 = (r + 1) % n; const d = nrm(V(P[r2], P[r])); const step = len(V(P[r2], P[r]));
          for (let l = 0; l < loops.length; l++) for (let j = 0; j < loops[l].length; j++) if (dot(V(rings[r2][l][j], rings[r][l][j]), d) <= 1e-9 * Math.max(1, step)) throw new Error('The sweep crosses itself: use a smaller profile or rounder corners'); } }
      // mesh: sides between neighbouring rings (a closed path joins the last back to the first), caps at the ends of an open one
      const pos = [], tri = []; const baseIdx = []; let nv = 0;
      for (const ring of rings) { const bi = []; for (const L of ring) { bi.push(nv); for (const p of L) { pos.push(p[0], p[1], p[2]); nv++; } } baseIdx.push(bi); }
      const spans = closed ? n : n - 1;
      for (let l = 0; l < loops.length; l++) { const m = loops[l].length; const hole = l > 0;
        for (let r = 0; r < spans; r++) { const r2 = (r + 1) % n; for (let j = 0; j < m; j++) { const a = baseIdx[r][l] + j, b = baseIdx[r][l] + (j + 1) % m, c = baseIdx[r2][l] + (j + 1) % m, d = baseIdx[r2][l] + j; if (hole) tri.push(a, c, b, a, d, c); else tri.push(a, b, c, a, c, d); } } }
      if (!closed) {
        const cap = (r, outward) => { const nn = outward; const t0 = Math.abs(nn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; const e1 = nrm(crs(nn, t0)), e2 = crs(nn, e1); const to2 = p => [dot(p, e1), dot(p, e2)];
          const polys = [], map = []; rings[r].forEach((L, l) => { let P2 = L.map(to2); let idx = L.map((_, j) => baseIdx[r][l] + j); let s2 = 0; for (let i = 0; i < P2.length; i++) { const a = P2[i], b = P2[(i + 1) % P2.length]; s2 += a[0] * b[1] - b[0] * a[1]; }
            if ((l === 0) !== (s2 > 0)) { P2 = P2.slice().reverse(); idx = idx.slice().reverse(); } polys.push(P2); map.push(...idx); });
          for (const t of wasm.triangulate(polys, 1e-12)) tri.push(map[t[0]], map[t[1]], map[t[2]]); };
        cap(0, Sc(T[0], -1)); cap(n - 1, T[n - 1]);
      }
      let m; try { m = Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: Float32Array.from(pos), triVerts: Uint32Array.from(tri) })); } catch (e) { throw new Error('The sweep crosses itself: use a smaller profile or rounder corners'); }
      if ((typeof m.status === 'function' && m.status() !== 'NoError') || !(m.volume() > 0)) throw new Error('The sweep crosses itself: use a smaller profile or rounder corners');
      return clean(m);
    }
    function movePlanarFace(manifold, md, surf, M, opts = {}) {
      const S = md.surfs && md.surfs[surf]; if (!S || !S.planar) return null;
      const P = md.positions, I = md.indices, nt = I.length / 3; const n = S.n; const diag = bboxDiag(P) || 1;
      // the plane after the move
      const c = S.c; const c2 = applyMat(M, c[0], c[1], c[2]); const q = applyMat(M, c[0] + n[0], c[1] + n[1], c[2] + n[2]);
      let n2 = [q[0] - c2[0], q[1] - c2[1], q[2] - c2[2]]; const l = Math.hypot(...n2); n2 = n2.map(v => v / l);
      const cosT = n[0] * n2[0] + n[1] * n2[1] + n[2] * n2[2]; const shift = (c2[0] - c[0]) * n[0] + (c2[1] - c[1]) * n[1] + (c2[2] - c[2]) * n[2];
      const offOld = n[0] * c[0] + n[1] * c[1] + n[2] * c[2], offNew = n2[0] * c2[0] + n2[1] * c2[1] + n2[2] * c2[2];
      if (cosT > 1 - 1e-12 && Math.abs(offNew - offOld) < 1e-9 * diag) return null;   // same plane: a twist or a slide
      // every wall meeting the face must run straight along its normal
      const keys = surfaceVertexKeys(md, surf); const touching = new Set();
      for (let t = 0; t < nt; t++) { const sid = md.surfID[t]; if (sid === surf) continue; for (let e = 0; e < 3; e++) { const k = I[t * 3 + e] * 3; if (keys.has(fkey(P[k], P[k + 1], P[k + 2]))) { touching.add(sid); break; } } }
      if (!touching.size) return null;
      for (let t = 0; t < nt; t++) {
        if (!touching.has(md.surfID[t])) continue; const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, cc = I[t * 3 + 2] * 3;
        const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[cc] - P[a], P[cc + 1] - P[a + 1], P[cc + 2] - P[a + 2]];
        const m = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const ml = Math.hypot(...m); if (ml < 1e-12 * diag * diag) continue;
        if (Math.abs((m[0] * n[0] + m[1] * n[1] + m[2] * n[2]) / ml) > 2e-3) return null;
      }
      if (cosT < 0.15) return { ok: false };   // turned almost edge-on (over ~80°)
      // the face's outline in its own frame, and how far along the normal each outline point must go to reach the new plane
      let faceId = -1; for (let t = 0; t < nt; t++) if (md.surfID[t] === surf) { faceId = md.faceID[t]; break; }
      const F = faceFrame(md, faceId); if (!F || !F.loops || !F.loops.length) return null;
      const area = L => { let s2 = 0; for (let i = 0; i < L.length; i++) { const p0 = L[i], p1 = L[(i + 1) % L.length]; s2 += p0[0] * p1[1] - p1[0] * p0[1]; } return s2 / 2; };
      const loops = F.loops.slice().sort((x, y) => Math.abs(area(y)) - Math.abs(area(x)));
      const outer = area(loops[0]) < 0 ? loops[0].slice().reverse() : loops[0].slice(); const holes = loops.slice(1).map(h => area(h) > 0 ? h.slice().reverse() : h.slice());
      const toW = p => [F.origin[0] + p[0] * F.u[0] + p[1] * F.v[0], F.origin[1] + p[0] * F.u[1] + p[1] * F.v[1], F.origin[2] + p[0] * F.u[2] + p[1] * F.v[2]];
      const Fn = F.n; const sgn = Fn[0] * n[0] + Fn[1] * n[1] + Fn[2] * n[2] > 0 ? 1 : -1;   // the frame's normal points out of the body like n
      const eps = 1e-5 * diag; let tMin = Infinity, tMax = -Infinity;
      const cen2 = outer.reduce((a, p) => [a[0] + p[0] / outer.length, a[1] + p[1] / outer.length], [0, 0]);
      for (const L of [outer, ...holes]) for (const p2 of L) {
        const p = toW(p2); const tt = ((c2[0] - p[0]) * n2[0] + (c2[1] - p[1]) * n2[1] + (c2[2] - p[2]) * n2[2]) / cosT;
        tMin = Math.min(tMin, tt); tMax = Math.max(tMax, tt);
        if (tt < 0) { // the plane dips below the face here: it must stay short of the walls' far end
          const pin = toW([p2[0] + (cen2[0] - p2[0]) * 0.01, p2[1] + (cen2[1] - p2[1]) * 0.01]); const o = [pin[0] - n[0] * eps, pin[1] - n[1] * eps, pin[2] - n[2] * eps];
          const h = rayMesh(md, o, [-n[0], -n[1], -n[2]]); if (!h || h.distance + eps <= -tt + 10 * eps) return { ok: false };
        }
      }
      // Every face vertex slides along the normal onto the new plane; so does every wall vertex the plane now passes above
      // (it is dropped onto the plane). The walls run along the normal, so each wall facet stays in its own plane: the result
      // is exactly the walls cut (or run on) by the new plane, with no boolean and nothing else of the body touched.
      const wallKeys = new Set(); for (let t = 0; t < nt; t++) if (touching.has(md.surfID[t])) for (let e = 0; e < 3; e++) { const k = I[t * 3 + e] * 3; wallKeys.add(fkey(P[k], P[k + 1], P[k + 2])); }
      const tAt = p => ((c2[0] - p[0]) * n2[0] + (c2[1] - p[1]) * n2[1] + (c2[2] - p[2]) * n2[2]) / cosT;
      const mapPoint = p => {
        const k = fkey(p[0], p[1], p[2]);
        if (keys.has(k)) { const tt = tAt(p); return [p[0] + n[0] * tt, p[1] + n[1] * tt, p[2] + n[2] * tt]; }
        if (wallKeys.has(k)) { const h = (p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1] + (p[2] - c[2]) * n[2]; if (h < -eps) { const tt = tAt(p); if (tt < 0) return [p[0] + n[0] * tt, p[1] + n[1] * tt, p[2] + n[2] * tt]; } }
        return null;
      };
      let out = manifold.warp(v => { const q2 = mapPoint(v); if (q2) { v[0] = q2[0]; v[1] = q2[1]; v[2] = q2[2]; } });
      // no triangle may turn over (a wall vertex dropped past its neighbour, say)
      for (let t = 0; t < nt; t++) {
        const idx = [I[t * 3] * 3, I[t * 3 + 1] * 3, I[t * 3 + 2] * 3]; const pts = idx.map(k => [P[k], P[k + 1], P[k + 2]]); const after = pts.map(p => mapPoint(p) || p);
        if (!after.some((p, i) => p !== pts[i])) continue;
        const nrm = T => { const u = [T[1][0] - T[0][0], T[1][1] - T[0][1], T[1][2] - T[0][2]], v = [T[2][0] - T[0][0], T[2][1] - T[0][1], T[2][2] - T[0][2]]; return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; };
        const n0 = nrm(pts), n1 = nrm(after); const l0 = Math.hypot(...n0), l1 = Math.hypot(...n1); if (l0 < 1e-14 || l1 < 1e-14 * diag * diag) continue;
        if ((n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) / (l0 * l1) < -1e-6) return { ok: false };
      }
      out = clean(out);
      if (!(out.volume() > 1e-9 * diag * diag * diag)) return { ok: false };
      return { ok: true, solid: out };
    }
    /**
     * Moves or turns a cylindrical bore as a feature (Plasticity / Shapr3D style): the old hole is filled, and the same
     * hole is cut again along its new axis. A through hole stays a through hole, trimmed by whatever faces it now runs
     * through (tilted, its ends become ellipses); moved past the outer wall it opens into a slot. A blind hole keeps its
     * depth. The rest of the body is untouched. Returns null when the surface is not a bore (the caller falls back).
     */
    const boreCache = new WeakMap();
    function boreTool(cyl, r, N, phase, lo, hi, A = null) {
      // an N-sided prism round the axis from lo to hi, its corners at angle phase + 2πk/N (in the cyl's u, v frame) — or, with
      // A, at the points of the circle that A carries onto those angles (so the corners keep the angles after the warp)
      let pts = []; if (cyl.section) { const f = r / (cyl.r || r || 1); pts = cyl.section.map(p => [p[0] * f, p[1] * f]); if (signedArea(pts) < 0) pts.reverse(); }
      else if (A) { const det = A[0] * A[3] - A[1] * A[2];
        for (let k = 0; k < N; k++) { const t = phase + 2 * Math.PI * k / N; const x = Math.cos(t), y = Math.sin(t); const dx = (A[3] * x - A[1] * y) / det, dy = (-A[2] * x + A[0] * y) / det; const l = Math.hypot(dx, dy) || 1; pts.push([r * dx / l, r * dy / l]); }
        if (signedArea(pts) < 0) pts.reverse(); }
      else for (let k = 0; k < N; k++) { const t = phase + 2 * Math.PI * k / N; pts.push([r * Math.cos(t), r * Math.sin(t)]); }
      const pr = Manifold.extrude([pts], hi - lo).translate([0, 0, lo]); const { u, v, a, c } = cyl;
      return pr.warp(p => { const x = p[0], y = p[1], z = p[2]; p[0] = c[0] + u[0] * x + v[0] * y + a[0] * z; p[1] = c[1] + u[1] * x + v[1] * y + a[1] * z; p[2] = c[2] + u[2] * x + v[2] * y + a[2] * z; });
    }
    /**
     * The body with the bore filled, rebuilt as a mesh (no boolean, so nothing near-coincident is left behind): the wall
     * triangles go, a blind bore's floor goes, and each open rim gets a flat cap made from the rim's own vertices — so the
     * cap is exactly coplanar with the face round it and the two read as one face. null when a rim is not flat.
     */
    function fillBore(manifold, md, surf) {
      const g = manifold.getMesh(); const np = g.numProp, VP = g.vertProperties, TV = g.triVerts; const nv = g.numVert, nt = TV.length / 3;
      const P = md.positions, I = md.indices, sid = md.surfID; const diag = bboxDiag(P) || 1;
      // weld the solid's vertices by position, and key every md triangle to its surface
      const vk = new Array(nv); const weld = new Map(); const wid = new Int32Array(nv);
      for (let i = 0; i < nv; i++) { const k = fkey(VP[i * np], VP[i * np + 1], VP[i * np + 2]); vk[i] = k; let w = weld.get(k); if (w === undefined) { w = weld.size; weld.set(k, w); } wid[i] = w; }
      const tkey = (a, b, c) => [a, b, c].sort().join('|');
      const surfOfTri = new Map(); for (let t = 0; t < sid.length; t++) { const k = [0, 1, 2].map(e => { const q = I[t * 3 + e] * 3; return fkey(P[q], P[q + 1], P[q + 2]); }); surfOfTri.set(tkey(...k), sid[t]); }
      const tsurf = new Int32Array(nt); for (let t = 0; t < nt; t++) { const s2 = surfOfTri.get(tkey(vk[TV[t * 3]], vk[TV[t * 3 + 1]], vk[TV[t * 3 + 2]])); tsurf[t] = s2 === undefined ? -1 : s2; }
      // the bore's wall, found by its geometry (every corner on the cylinder, facing across the axis) rather than by surface
      // id alone — the display mesh's ids and the solid's triangles do not always line up near the rims
      const cyl = surfCylinder(md, surf) || surfPrism(md, surf); if (!cyl) return null;
      const onCyl = cyl.section ? (() => false) : i => { const x = VP[i * np] - cyl.c[0], y = VP[i * np + 1] - cyl.c[1], z = VP[i * np + 2] - cyl.c[2]; const h = x * cyl.a[0] + y * cyl.a[1] + z * cyl.a[2]; return Math.abs(Math.hypot(x - h * cyl.a[0], y - h * cyl.a[1], z - h * cyl.a[2]) - cyl.r) <= 2e-3 * cyl.r + 1e-6 * diag; };
      const vOn = new Uint8Array(nv); for (let i = 0; i < nv; i++) vOn[i] = onCyl(i) ? 1 : 0;
      const across = t => { const a = TV[t * 3] * np, b = TV[t * 3 + 1] * np, c = TV[t * 3 + 2] * np; const n = cross([VP[b] - VP[a], VP[b + 1] - VP[a + 1], VP[b + 2] - VP[a + 2]], [VP[c] - VP[a], VP[c + 1] - VP[a + 1], VP[c + 2] - VP[a + 2]]); const l = Math.hypot(n[0], n[1], n[2]); return l < 1e-7 * diag * diag || Math.abs(n[0] * cyl.a[0] + n[1] * cyl.a[1] + n[2] * cyl.a[2]) / l < 0.5; };   // slivers' normals are noise: a corner set on the cylinder is enough
      let keep = new Uint8Array(nt); let any = false;
      for (let t = 0; t < nt; t++) { const wall = tsurf[t] === surf || (vOn[TV[t * 3]] && vOn[TV[t * 3 + 1]] && vOn[TV[t * 3 + 2]] && across(t)); keep[t] = wall ? 0 : 1; if (!keep[t]) any = true; }
      if (!any) return null;
      const openLoops = () => {
        const dir = new Map(); for (let t = 0; t < nt; t++) if (keep[t]) for (let e = 0; e < 3; e++) dir.set(wid[TV[t * 3 + e]] + '>' + wid[TV[t * 3 + (e + 1) % 3]], t);
        const next = new Map(), across = new Map();
        for (const [k, t] of dir) { const [p, q] = k.split('>').map(Number); if (dir.has(q + '>' + p)) continue; if (next.has(p)) return null; next.set(p, q); across.set(p, t); }
        const loops = []; const used = new Set();
        for (const st of next.keys()) { if (used.has(st)) continue; const L = [], T = []; let v = st; while (!used.has(v)) { used.add(v); L.push(v); T.push(across.get(v)); v = next.get(v); if (v === undefined) return null; } if (v !== st) return null; loops.push({ L, T }); }
        return loops;
      };
      let loops = openLoops(); if (!loops || !loops.length) return null;
      // a blind bore: a flat face whose whole outline is one rim is its floor — it goes with the wall
      for (const { L, T } of loops) {
        const sids = new Set(T.map(t => tsurf[t])); if (sids.size !== 1) continue; const fs = [...sids][0]; if (fs < 0 || !(md.surfs[fs] && md.surfs[fs].planar)) continue;
        const ring = new Set(L); let inner = true;
        for (let t = 0; t < nt && inner; t++) if (keep[t] && tsurf[t] === fs) { /* every edge of the face on its outline must be a rim edge */ }
        // the floor's own outline: its boundary edges must all lie on this rim
        const dir = new Set(); for (let t = 0; t < nt; t++) if (keep[t] && tsurf[t] === fs) for (let e = 0; e < 3; e++) dir.add(wid[TV[t * 3 + e]] + '>' + wid[TV[t * 3 + (e + 1) % 3]]);
        for (const k of dir) { const [p, q] = k.split('>').map(Number); if (!dir.has(q + '>' + p) && !(ring.has(p) && ring.has(q))) { inner = false; break; } }
        if (inner) for (let t = 0; t < nt; t++) if (tsurf[t] === fs) keep[t] = 0;
      }
      loops = openLoops(); if (!loops) return null;
      let pos = new Float32Array(weld.size * 3); const centres = []; for (let i = 0; i < nv; i++) { const w = wid[i]; pos[w * 3] = VP[i * np]; pos[w * 3 + 1] = VP[i * np + 1]; pos[w * 3 + 2] = VP[i * np + 2]; }
      const tri = []; for (let t = 0; t < nt; t++) if (keep[t]) tri.push(wid[TV[t * 3]], wid[TV[t * 3 + 1]], wid[TV[t * 3 + 2]]);
      for (const { L } of loops) {
        if (L.length < 3) return null; let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
        for (let i = 0; i < L.length; i++) { const p = L[i] * 3, q = L[(i + 1) % L.length] * 3; nx += (pos[p + 1] - pos[q + 1]) * (pos[p + 2] + pos[q + 2]); ny += (pos[p + 2] - pos[q + 2]) * (pos[p] + pos[q]); nz += (pos[p] - pos[q]) * (pos[p + 1] + pos[q + 1]); cx += pos[p]; cy += pos[p + 1]; cz += pos[p + 2]; }
        const nl = Math.hypot(nx, ny, nz); if (nl < 1e-12) return null; nx /= nl; ny /= nl; nz /= nl; cx /= L.length; cy /= L.length; cz /= L.length;
        for (const v of L) if (Math.abs((pos[v * 3] - cx) * nx + (pos[v * 3 + 1] - cy) * ny + (pos[v * 3 + 2] - cz) * nz) > 1e-5 * diag) return null;   // the rim is not flat (the bore breaks out through a wall)
        // the cap runs each rim edge the other way round, fanned from the rim's centre (a bore's rim is a circle or an
        // ellipse, so every fan triangle must turn the same way — otherwise give up)
        const ref = Math.abs(nz) < 0.9 ? [0, 0, 1] : [1, 0, 0]; const u = norm(cross(ref, [nx, ny, nz])), v = cross([nx, ny, nz], u);
        const R = L.slice().reverse(); const to2 = i => [pos[i * 3] * u[0] + pos[i * 3 + 1] * u[1] + pos[i * 3 + 2] * u[2], pos[i * 3] * v[0] + pos[i * 3 + 1] * v[1] + pos[i * 3 + 2] * v[2]];
        const c2 = [cx * u[0] + cy * u[1] + cz * u[2], cx * v[0] + cy * v[1] + cz * v[2]]; let sgn = 0;
        for (let k = 0; k < R.length; k++) { const p = to2(R[k]), q = to2(R[(k + 1) % R.length]); const ar = (p[0] - c2[0]) * (q[1] - c2[1]) - (p[1] - c2[1]) * (q[0] - c2[0]); const sg = ar > 0 ? 1 : ar < 0 ? -1 : 0; if (!sg) continue; if (!sgn) sgn = sg; else if (sg !== sgn) return null; }
        const ci = centres.length; centres.push(cx, cy, cz);
        for (let k = 0; k < R.length; k++) tri.push(-1 - ci, R[k], R[(k + 1) % R.length]);
      }
      // the cap centres go after the welded vertices
      { const base = pos.length / 3; const all = new Float32Array(pos.length + centres.length); all.set(pos); all.set(centres, pos.length); for (let i = 0; i < tri.length; i++) if (tri[i] < 0) tri[i] = base + (-1 - tri[i]) / 3; pos = all; }
      let m; try { m = Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: pos, triVerts: new Uint32Array(tri) })); } catch (e) { return null; }
      if ((typeof m.status === 'function' && m.status() !== 'NoError') || !(m.volume() > manifold.volume())) return null;
      return m;
    }
    // ---- Lifting a hole along its axis (Plasticity): the flat rings round its rims become surfaces that follow it ----
    // Each ring (top and bottom) is rebuilt as a cubic Bézier sweep from its fixed outer rim (row 0) to the moved hole rim
    // (row 3). The first time a flat ring is deformed its two inner control rows are spaced evenly (a straight cone); after
    // that they stay where they were, so moving the hole back after a scale leaves a curved shoulder, not the old flat ring.
    const shoulderOrigin = new WeakMap();
    function shoulderSetup(manifold, md, surf) {
      const cyl = surfCylinder(md, surf) || surfPrism(md, surf); if (!cyl || !cyl.hole) return null;
      const g = manifold.getMesh(); const np = g.numProp, VP = g.vertProperties, TV = g.triVerts; const nv = g.numVert, nt = TV.length / 3;
      const P = md.positions, I = md.indices, sid = md.surfID; const diag = bboxDiag(P) || 1;
      const weld = new Map(); const wid = new Int32Array(nv); const pos = [];
      for (let i = 0; i < nv; i++) { const k = fkey(VP[i * np], VP[i * np + 1], VP[i * np + 2]); let w = weld.get(k); if (w === undefined) { w = weld.size; weld.set(k, w); pos.push(VP[i * np], VP[i * np + 1], VP[i * np + 2]); } wid[i] = w; }
      const tkey = (a, b, c) => [a, b, c].sort().join('|');
      const sOf = new Map(); for (let t = 0; t < sid.length; t++) { const k = [0, 1, 2].map(e => { const q = I[t * 3 + e] * 3; return fkey(P[q], P[q + 1], P[q + 2]); }); sOf.set(tkey(...k), sid[t]); }
      const key3 = i => fkey(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      const tri = []; const ts = []; for (let t = 0; t < nt; t++) { const a = wid[TV[t * 3]], b = wid[TV[t * 3 + 1]], c = wid[TV[t * 3 + 2]]; if (a === b || b === c || a === c) continue; tri.push([a, b, c]); const s2 = sOf.get(tkey(key3(a), key3(b), key3(c))); ts.push(s2 === undefined ? -1 : s2); }
      const loopsOf = keep => { const dir = new Map(); tri.forEach((T, i) => { if (!keep[i]) return; for (let e = 0; e < 3; e++) dir.set(T[e] + '>' + T[(e + 1) % 3], i); });
        const next = new Map(), across = new Map(); for (const [k, i] of dir) { const [p, q] = k.split('>').map(Number); if (dir.has(q + '>' + p)) continue; if (next.has(p)) return null; next.set(p, q); across.set(p, i); }
        const out = [], used = new Set(); for (const st of next.keys()) { if (used.has(st)) continue; const L = [], A = []; let v = st; while (!used.has(v)) { used.add(v); L.push(v); A.push(across.get(v)); v = next.get(v); if (v === undefined) return null; } if (v !== st) return null; out.push({ L, A }); } return out; };
      const isWall = tri.map((T, i) => ts[i] === surf);
      const keep1 = isWall.map(w => !w); const rims = loopsOf(keep1); if (!rims || rims.length !== 2) return null;
      // the flat ring beside each rim: one planar surface whose whole boundary is this rim plus one outer loop
      const rings = []; const removed = isWall.slice();
      for (const rim of rims) { const fs = new Set(rim.A.map(i => ts[i])); if (fs.size !== 1) return null; const f = [...fs][0]; if (f < 0 || !(md.surfs[f] && md.surfs[f].planar)) return null;
        if (rings.some(r => r.f === f)) return null;
        // a flat face whose only edge is this rim is the floor of a blind hole: it travels with the hole (a cap), it does not stretch
        const own = loopsOf(tri.map((T, i) => ts[i] === f)); const cap = !!(own && own.length === 1);
        rings.push({ f, rim: rim.L, cap }); tri.forEach((T, i) => { if (ts[i] === f) removed[i] = true; }); }
      const nRing = rings.filter(r => !r.cap).length; if (!nRing) return null;
      const rest = removed.map(r => !r); const outers = loopsOf(rest); if (!outers || outers.length !== nRing) return null;
      const { u, v, a, c } = cyl; const ang = i => { const x = pos[i * 3] - c[0], y = pos[i * 3 + 1] - c[1], z = pos[i * 3 + 2] - c[2]; return Math.atan2(x * v[0] + y * v[1] + z * v[2], x * u[0] + y * u[1] + z * u[2]); };
      const hOf = L => L.reduce((s3, i) => s3 + ((pos[i * 3] - c[0]) * a[0] + (pos[i * 3 + 1] - c[1]) * a[1] + (pos[i * 3 + 2] - c[2]) * a[2]), 0) / L.length;
      // pair each ring with the outer loop on its plane
      for (const r of rings) { r.h = hOf(r.rim); if (r.cap) continue; const n = md.surfs[r.f].n, pc = md.surfs[r.f].c; let best = null, bd = Infinity; for (const o of outers) { let d = 0; for (const i of o.L) d = Math.max(d, Math.abs((pos[i * 3] - pc[0]) * n[0] + (pos[i * 3 + 1] - pc[1]) * n[1] + (pos[i * 3 + 2] - pc[2]) * n[2])); if (d < bd) { bd = d; best = o; } } if (bd > 1e-4 * diag) return null; r.outer = best.L; }
      if (nRing === 2 && rings[0].outer === rings[1].outer) return null; rings.sort((p, q) => q.h - p.h);   // top first
      // a point on a closed loop at angle θ about the axis (linear between the loop's own vertices)
      const atAngle = (L, th) => { const A = L.map(ang); let best = null; for (let k = 0; k < L.length; k++) { const a0 = A[k], a1 = A[(k + 1) % L.length]; let d = a1 - a0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; if (Math.abs(d) < 1e-12) continue; let t = th - a0; while (t > Math.PI) t -= 2 * Math.PI; while (t < -Math.PI) t += 2 * Math.PI; const f = t / d; if (f >= -1e-9 && f <= 1 + 1e-9) { const p = L[k] * 3, q = L[(k + 1) % L.length] * 3; best = [pos[p] + (pos[q] - pos[p]) * f, pos[p + 1] + (pos[q + 1] - pos[p + 1]) * f, pos[p + 2] + (pos[q + 2] - pos[p + 2]) * f]; break; } } return best; };
      // one angle set for both hole rims (so the hole wall is a clean strip): 512 even steps on the hole's own vertex grid (its
      // 128 corners are among them), so the swept cone and the lifted hole read as smooth when zoomed in, and a later cut
      // through the cone (a scale) can put its corners on the same angles
      const NT = 512; const ph = ang(rings[0].rim[0]);
      let TH = Array.from({ length: NT }, (_, k) => { let t = ph + 2 * Math.PI * k / NT; while (t > Math.PI) t -= 2 * Math.PI; while (t <= -Math.PI) t += 2 * Math.PI; return t; });
      TH = TH.slice().sort((p, q) => p - q);
      // a round loop sampled between its corners lies on the chords: put the samples on the true circle round the axis
      const roundLoop = L => { if (L.length < 24) return 0;   // a square's 4 corners are all the same distance out too: a circle has many points
        const rs = L.map(i => { const x = pos[i * 3] - c[0], y = pos[i * 3 + 1] - c[1], z = pos[i * 3 + 2] - c[2]; const h = x * a[0] + y * a[1] + z * a[2]; return Math.hypot(x - a[0] * h, y - a[1] * h, z - a[2] * h); });
        const lo = Math.min(...rs), hi = Math.max(...rs); return hi - lo < 2e-3 * hi ? Math.max(...rs) : 0; };
      const toCircle = (p, R) => { if (!R || !p) return p; const x = p[0] - c[0], y = p[1] - c[1], z = p[2] - c[2]; const h = x * a[0] + y * a[1] + z * a[2]; const w = [x - a[0] * h, y - a[1] * h, z - a[2] * h]; const l = Math.hypot(w[0], w[1], w[2]) || 1; return [c[0] + a[0] * h + w[0] * R / l, c[1] + a[1] * h + w[1] * R / l, c[2] + a[2] * h + w[2] * R / l]; };
      const inner = rings.map(r => { const R = cyl.section ? 0 : roundLoop(r.rim); return TH.map(th => toCircle(atAngle(r.rim, th), R)); }); if (inner.some(L => L.some(p => !p))) return null;
      const outerRow = rings.map(r => r.cap ? null : TH.map(th => atAngle(r.outer, th))); if (outerRow.some(L => L && L.some(p => !p))) return null;   // on the body's own facets: it joins them
      // the part of the body that stays: everything but the hole wall and the two rings
      const keepTri = []; tri.forEach((T, i) => { if (rest[i]) keepTri.push(T); });
      return { cyl, pos, keepTri, rings: rings.map((r, k) => ({ cap: r.cap, round: !r.cap && roundLoop(r.outer) > 0, outer: r.outer || null, outerAng: r.outer ? r.outer.map(ang) : null, inner0: inner[k], row0: outerRow[k], rows: null })), TH, diag, M: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
    }
    /**
     * Does the hole wall or a swept ring pass through another part of the body? (A hole pushed sideways out through the
     * cone's wall, or scaled wider than it.) Edges of the mesh are tested against its triangles that share no corner with
     * them, using a coarse grid so a few thousand edges stay quick. Plasticity refuses such a result ("wouldn't be valid").
     */
    function meshCrossesItself(pos, tris, edges) {
      let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pos.length; i += 3) for (let j = 0; j < 3; j++) { mn[j] = Math.min(mn[j], pos[i + j]); mx[j] = Math.max(mx[j], pos[i + j]); }
      const G = 24, sz = [0, 1, 2].map(j => Math.max(1e-9, (mx[j] - mn[j]) / G)); const cell = (v, j) => Math.max(0, Math.min(G - 1, Math.floor((v - mn[j]) / sz[j])));
      const grid = new Map(); const P = i => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
      tris.forEach((T, ti) => { const a = P(T[0]), b = P(T[1]), c = P(T[2]); const lo = [0, 1, 2].map(j => cell(Math.min(a[j], b[j], c[j]), j)), hi = [0, 1, 2].map(j => cell(Math.max(a[j], b[j], c[j]), j));
        for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) { const k = (x * G + y) * G + z; let L = grid.get(k); if (!L) { L = []; grid.set(k, L); } L.push(ti); } });
      const eps = 1e-7;
      for (const [i0, i1] of edges) { const o = P(i0), e = P(i1); const d = [e[0] - o[0], e[1] - o[1], e[2] - o[2]];
        const lo = [0, 1, 2].map(j => cell(Math.min(o[j], e[j]), j)), hi = [0, 1, 2].map(j => cell(Math.max(o[j], e[j]), j)); const seen = new Set();
        for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) { const L = grid.get((x * G + y) * G + z); if (!L) continue;
          for (const ti of L) { if (seen.has(ti)) continue; seen.add(ti); const T = tris[ti]; if (T[0] === i0 || T[1] === i0 || T[2] === i0 || T[0] === i1 || T[1] === i1 || T[2] === i1) continue;
            const a = P(T[0]), b = P(T[1]), c = P(T[2]); const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            const pv = cross(d, e2); const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2]; if (Math.abs(det) < 1e-18) continue; const s0 = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
            const u = (s0[0] * pv[0] + s0[1] * pv[1] + s0[2] * pv[2]) / det; if (u <= eps || u >= 1 - eps) continue; const qv = cross(s0, e1); const v = (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]) / det; if (v <= eps || u + v >= 1 - eps) continue;
            const t = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) / det; if (t > eps && t < 1 - eps) return true; } } }
      return false;
    }
    function shoulderBuild(st, Mt, check) {
      const pos = st.pos.slice(); const tris = st.keepTri.map(T => T.slice()); const add = p => { pos.push(p[0], p[1], p[2]); return pos.length / 3 - 1; };
      const n = st.TH.length; const S = 18; const testEdges = []; let outside = false;
      const { a: AX, u: UX, v: VX, c: CX } = st.cyl;
      const polar = p => { const w = [p[0] - CX[0], p[1] - CX[1], p[2] - CX[2]]; const x = w[0] * UX[0] + w[1] * UX[1] + w[2] * UX[2], y = w[0] * VX[0] + w[1] * VX[1] + w[2] * VX[2]; return { th: Math.atan2(y, x), r: Math.hypot(x, y) }; };
      // the outer rim's distance from the axis at any angle (its row0 samples sit at the angles st.TH, in order)
      const outerRadiusAt = (rg, th) => { const TH = st.TH, R0 = rg.row0; let k = 0; while (k < TH.length && TH[k] < th) k++; const k1 = k % TH.length, k0 = (k - 1 + TH.length) % TH.length; let d = TH[k1] - TH[k0]; while (d <= 0) d += 2 * Math.PI; let t = th - TH[k0]; while (t < 0) t += 2 * Math.PI; while (t > 2 * Math.PI) t -= 2 * Math.PI; t = Math.max(0, Math.min(1, t / d)); return polar(R0[k0]).r * (1 - t) + polar(R0[k1]).r * t; };   // rows of the swept ring (fine enough to read as one smooth surface)
      const B = t => [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
      const innerIdx = []; const newRows = [];
      const nk0 = tris.length; const ringStart = [];
      const capAt = [];
      st.rings.forEach((rg, ri) => { ringStart.push(tris.length);
        if (rg.cap) { const R3 = rg.inner0.map(p => applyMat(Mt, p[0], p[1], p[2])); const idx = R3.map(p => add(p)); innerIdx.push(idx); newRows.push(null); capAt.push(ri); return; }   // a blind hole's floor travels with the hole (Plasticity, SCALE-MOVE video 2-10 s): lifted, the hole keeps its own length and only the open rim's ring becomes a cone
        const R0 = rg.row0, R3 = rg.inner0.map(p => applyMat(Mt, p[0], p[1], p[2]));
        // the hole's rim must stay inside the outer rim it is swept from (Plasticity: a hole scaled or slid out past the body's
        // wall is refused, the ring never flares outward past the body)
        if (check) { // how far (if at all) the rim pokes out past the outer rim, measured at each rim point's own angle;
          // refused only when that gets worse than it already was when this drag began (so a body that is already at the edge can still be edited)
          const over = R => { let worst = 0; for (const p of R) { const { th, r } = polar(p); const ro = outerRadiusAt(rg, th); worst = Math.max(worst, r - ro * 0.999); } return worst; };
          const startR3 = rg.inner0.map(p => applyMat(st.M, p[0], p[1], p[2]));
          if (over(R3) > Math.max(0, over(startR3)) + 1e-9 * st.diag) outside = true; }
        const R1 = rg.rows ? rg.rows[0] : R0.map((p, k) => [p[0] + (R3[k][0] - p[0]) / 3, p[1] + (R3[k][1] - p[1]) / 3, p[2] + (R3[k][2] - p[2]) / 3]);
        const R2 = rg.rows ? rg.rows[1] : R0.map((p, k) => [p[0] + 2 * (R3[k][0] - p[0]) / 3, p[1] + 2 * (R3[k][1] - p[1]) / 3, p[2] + 2 * (R3[k][2] - p[2]) / 3]);
        newRows.push([R1, R2]);
        const Sr = rg.rows || !rg.round ? S : 1;   // one row only from a round body edge (a square one needs the rows to loft into the circle)
        const rowIdx = []; for (let sI = 1; sI <= Sr; sI++) { const b = B(sI / Sr); rowIdx.push(R0.map((p, k) => add([0, 1, 2].map(j => b[0] * p[j] + b[1] * R1[k][j] + b[2] * R2[k][j] + b[3] * R3[k][j])))); }
        innerIdx.push(rowIdx[Sr - 1]);
        // zipper the fixed outer loop to the first swept row (both ordered by angle)
        const O = rg.outer.map((i, k) => ({ i, a: rg.outerAng[k] })).sort((p, q) => p.a - q.a); const A = rowIdx[0].map((i, k) => ({ i, a: st.TH[k] }));
        let io = 0, ia = 0; const no = O.length, na = A.length; const ring = [];
        while (io < no || ia < na) { const ao = io < no ? O[io].a : Infinity, aa = ia < na ? A[ia].a : Infinity; if (ao <= aa) { ring.push(['o', io]); io++; } else { ring.push(['a', ia]); ia++; } }
        // walk both loops round once, making a triangle at each step
        let po = no - 1, pa = na - 1; for (const [kind, k] of ring) { if (kind === 'o') { tris.push([O[po].i, O[k].i, A[pa].i]); po = k; } else { tris.push([O[po].i, A[k].i, A[pa].i]); pa = k; } }
        for (let sI = 0; sI + 1 < Sr; sI++) { const r0 = rowIdx[sI], r1 = rowIdx[sI + 1]; for (let k = 0; k < n; k++) { const k2 = (k + 1) % n; tris.push([r0[k], r0[k2], r1[k2]], [r0[k], r1[k2], r1[k]]); if (k % 3 === 0) testEdges.push([r0[k], r1[k]]); } }
        rg._strip = { first: O.map(o => o.i) };
      });
      // both rings were swept with the same handedness: the bottom one faces the other way round the hole wall
      if (!st.rings[1].cap) for (let t = ringStart[1]; t < tris.length; t++) { const T = tris[t]; const x = T[1]; T[1] = T[2]; T[2] = x; }
      // the hole wall between the two moved rims
      const tubeStart = tris.length;   // from here on: the hole wall (and a blind hole's floor), kept as its own run so it never blends into the rings
      const [ti, bi] = innerIdx; for (let k = 0; k < n; k++) { const k2 = (k + 1) % n; tris.push([ti[k], ti[k2], bi[k2]], [ti[k], bi[k2], bi[k]]); testEdges.push([ti[k], bi[k]]); }
      // a blind hole's floor: a flat fan across its moved rim, wound to match the hole wall
      for (const ri of capAt) { const L = innerIdx[ri]; const cx = [0, 1, 2].map(j => L.reduce((a, i) => a + pos[i * 3 + j], 0) / L.length); const ci = add(cx);
        for (let k = 0; k < n; k++) { const k2 = (k + 1) % n; tris.push(ri === 1 ? [ci, L[k], L[k2]] : [ci, L[k2], L[k]]); } }
      // orient: the kept part fixes the winding; flip the new triangles if they disagree along a kept boundary edge
      const nk = st.keepTri.length; const dir = new Set(); for (let t = 0; t < nk; t++) for (let e = 0; e < 3; e++) dir.add(tris[t][e] + '>' + tris[t][(e + 1) % 3]);
      // the new part is one connected sheet: test one of its triangles that touches an outer loop
      let flip = false; for (let t = nk; t < tris.length && !flip; t++) { const T = tris[t]; for (let e = 0; e < 3; e++) if (dir.has(T[e] + '>' + T[(e + 1) % 3])) { flip = true; break; } }
      if (flip) for (let t = nk; t < tris.length; t++) { const T = tris[t]; const x = T[1]; T[1] = T[2]; T[2] = x; }
      // the two rings were built with the same handedness; one of them may still disagree with its own outer loop
      let m; try {
        const mesh = new Mesh({ numProp: 3, vertProperties: new Float32Array(pos), triVerts: new Uint32Array(tris.flat()) });
        try { if (typeof Manifold.reserveIDs === 'function') { const id0 = Manifold.reserveIDs(2); mesh.runIndex = new Uint32Array([0, tubeStart * 3, tris.length * 3]); mesh.runOriginalID = new Uint32Array([id0, id0 + 1]); } } catch (e) { /* one run then */ }
        m = Manifold.ofMesh(mesh); } catch (e) { m = null; }
      if (!m || (typeof m.status === 'function' && m.status() !== 'NoError')) {
        // fix the second ring alone (flip the triangles that hold its outer loop's edges the wrong way)
        return null; }
      if (m.volume() < 0) return null;
      if (check && (outside || meshCrossesItself(pos, tris, testEdges))) return { solid: m, rows: newRows, crosses: true };
      return { solid: m, rows: newRows };
    }
    function liftBore(manifold, md, surf, M, opts = {}) {
      let st = shoulderOrigin.get(manifold); let Mt;
      if (st) Mt = mul4(M, st.M); else { st = shoulderSetup(manifold, md, surf); if (!st) return null; Mt = Array.from(M); }
      const r = shoulderBuild(st, Mt, true); if (!r) return { ok: false };
      if (r.crosses) return { ok: false, solid: r.solid };   // the hole now runs out through the body's own wall: refused, as in Plasticity
      const diag = st.diag; if (!(r.solid.volume() > 1e-9 * diag * diag * diag)) return { ok: false };
      // the result remembers the swept rings as they are now: the next move or scale keeps their inner rows
      // a cone stays a cone while the hole is only moved or turned; a scale turns the rings into free-form surfaces whose inner
      // rows then stay put (moving the scaled hole back leaves a shoulder, as in Plasticity)
      const lin = [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]]; const colLen = k => Math.hypot(lin[k * 3], lin[k * 3 + 1], lin[k * 3 + 2]);
      const dotc = (i, j) => lin[i * 3] * lin[j * 3] + lin[i * 3 + 1] * lin[j * 3 + 1] + lin[i * 3 + 2] * lin[j * 3 + 2];
      const rigid = [0, 1, 2].every(k => Math.abs(colLen(k) - 1) < 1e-6) && Math.abs(dotc(0, 1)) < 1e-6 && Math.abs(dotc(0, 2)) < 1e-6 && Math.abs(dotc(1, 2)) < 1e-6;
      const next = { ...st, M: Mt, rings: st.rings.map((rg, k) => ({ ...rg, rows: rg.cap ? null : (rg.rows || (rigid ? null : r.rows[k])) })) }; shoulderOrigin.set(r.solid, next);
      const cyl = st.cyl; const c2 = applyMat(Mt, cyl.c[0], cyl.c[1], cyl.c[2]); const q = applyMat(Mt, cyl.c[0] + cyl.a[0], cyl.c[1] + cyl.a[1], cyl.c[2] + cyl.a[2]);
      return { ok: true, solid: r.solid, cyl: { a: norm([q[0] - c2[0], q[1] - c2[1], q[2] - c2[2]]), c: c2, r: cyl.r, hole: true }, lifted: true };
    }
    // a body made by moveCylinderFace remembers the filled body and the hole it started from, so the next move of the same
    // hole is made from that again: a hole slid out through a wall and back leaves the wall whole, and nothing degrades
    const boreOrigin = new WeakMap();
    const mul4 = (A, B) => { const R = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let v = 0; for (let k = 0; k < 4; k++) v += A[k * 4 + r] * B[c * 4 + k]; R[c * 4 + r] = v; } return R; };
    /** True when the surface's facets face its axis through c along a (a bore wall, not an outer wall around the same axis). */
    /**
     * Is this surface (still) the hole a scale or move made, even when it broke out through the body and only part of its
     * wall is left (its centre then sits well off the axis)? Every corner of the wall, carried back through the hole's
     * transform, has to lie on the original bore's cylinder.
     */
    function onPrevBore(md, surf, prev) {
      const sf = md.surfs && md.surfs[surf]; if (!sf || sf.planar || !prev || !prev.cyl) return false;
      const M = prev.M; const det = M[0] * (M[5] * M[10] - M[9] * M[6]) - M[4] * (M[1] * M[10] - M[9] * M[2]) + M[8] * (M[1] * M[6] - M[5] * M[2]); if (Math.abs(det) < 1e-12) return false;
      // inverse of the linear part (column-major 3×3), then of the translation
      const a = M[0], b = M[4], c = M[8], d = M[1], e = M[5], f = M[9], g = M[2], h = M[6], k = M[10];
      const iv = [(e * k - f * h) / det, -(b * k - c * h) / det, (b * f - c * e) / det, -(d * k - f * g) / det, (a * k - c * g) / det, -(a * f - c * d) / det, (d * h - e * g) / det, -(a * h - b * g) / det, (a * e - b * d) / det];
      const back = p => { const x = p[0] - M[12], y = p[1] - M[13], z = p[2] - M[14]; return [iv[0] * x + iv[1] * y + iv[2] * z, iv[3] * x + iv[4] * y + iv[5] * z, iv[6] * x + iv[7] * y + iv[8] * z]; };
      const { c: C0, a: A0, r } = prev.cyl; const P = md.positions, I = md.indices, sid = md.surfID; let n = 0, on = 0;
      for (let t = 0; t < sid.length; t++) { if (sid[t] !== surf) continue; for (let j = 0; j < 3; j++) { const q = I[t * 3 + j] * 3; const p = back([P[q], P[q + 1], P[q + 2]]);
        const w = [p[0] - C0[0], p[1] - C0[1], p[2] - C0[2]]; const hh = w[0] * A0[0] + w[1] * A0[1] + w[2] * A0[2]; const rad = Math.hypot(w[0] - A0[0] * hh, w[1] - A0[1] * hh, w[2] - A0[2] * hh);
        n++; if (Math.abs(rad - r) < 0.01 * r + 1e-6) on++; } }
      return n >= 12 && on >= 0.98 * n && facesAxis(md, surf, prev.now.c, prev.now.a);
    }
    function facesAxis(md, surf, c, a) { const P = md.positions, I = md.indices, sid = md.surfID; let side = 0;
      for (let t = 0; t < sid.length; t++) { if (sid[t] !== surf) continue; const ia = I[t * 3] * 3, ib = I[t * 3 + 1] * 3, ic = I[t * 3 + 2] * 3;
        const n = cross([P[ib] - P[ia], P[ib + 1] - P[ia + 1], P[ib + 2] - P[ia + 2]], [P[ic] - P[ia], P[ic + 1] - P[ia + 1], P[ic + 2] - P[ia + 2]]);
        const w = [P[ia] - c[0], P[ia + 1] - c[1], P[ia + 2] - c[2]]; const h = w[0] * a[0] + w[1] * a[1] + w[2] * a[2]; side += n[0] * (w[0] - a[0] * h) + n[1] * (w[1] - a[1] * h) + n[2] * (w[2] - a[2] * h); }
      return side < 0; }
    function liftedFrame(st) { const M = st.M, cyl = st.cyl; const lin = d => norm([M[0] * d[0] + M[4] * d[1] + M[8] * d[2], M[1] * d[0] + M[5] * d[1] + M[9] * d[2], M[2] * d[0] + M[6] * d[1] + M[10] * d[2]]);
      const a = lin(cyl.a); let u = lin(cyl.u); const ua = u[0] * a[0] + u[1] * a[1] + u[2] * a[2]; u = norm([u[0] - a[0] * ua, u[1] - a[1] * ua, u[2] - a[2] * ua]);
      return { c: applyMat(M, cyl.c[0], cyl.c[1], cyl.c[2]), u, v: cross(a, u), a, r: cyl.r, hole: true, h0: cyl.h0, h1: cyl.h1 }; }
    /** Is surf the lifted hole's wall (not one of the swept rings round it)? */
    function isLiftedWall(st, md, surf) { const sf = md.surfs && md.surfs[surf]; if (!sf || sf.planar) return false; const f = liftedFrame(st);
      if (!facesAxis(md, surf, f.c, f.a)) return false; const q = surfCylinder(md, surf) || surfPrism(md, surf); if (!q) return false; return Math.abs(q.a[0] * f.a[0] + q.a[1] * f.a[1] + q.a[2] * f.a[2]) > 0.98; }
    function moveCylinderFace(manifold, md, surf, M, opts = {}) {
      { const ls = shoulderOrigin.get(manifold); if (ls) { if (!isLiftedWall(ls, md, surf)) return null;
          // a lifted hole (Plasticity): along its axis the swept rings follow it; slid sideways, turned or scaled, the cone
          // stays and the hole is cut again through it (it may break out through the cone's sides)
          const lin = [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]]; const cl = k => Math.hypot(lin[k * 3], lin[k * 3 + 1], lin[k * 3 + 2]); const dt = (i, j) => lin[i * 3] * lin[j * 3] + lin[i * 3 + 1] * lin[j * 3 + 1] + lin[i * 3 + 2] * lin[j * 3 + 2];
          const rigid = [0, 1, 2].every(k => Math.abs(cl(k) - 1) < 1e-6) && Math.abs(dt(0, 1)) < 1e-6 && Math.abs(dt(0, 2)) < 1e-6 && Math.abs(dt(1, 2)) < 1e-6;
          if (rigid) { const f = liftedFrame(ls); const c1 = applyMat(M, f.c[0], f.c[1], f.c[2]); const d = [c1[0] - f.c[0], c1[1] - f.c[1], c1[2] - f.c[2]]; const dz = d[0] * f.a[0] + d[1] * f.a[1] + d[2] * f.a[2];
            const lateral = Math.hypot(d[0] - f.a[0] * dz, d[1] - f.a[1] * dz, d[2] - f.a[2] * dz); const a1 = norm([M[0] * f.a[0] + M[4] * f.a[1] + M[8] * f.a[2], M[1] * f.a[0] + M[5] * f.a[1] + M[9] * f.a[2], M[2] * f.a[0] + M[6] * f.a[1] + M[10] * f.a[2]]);
            const turned = Math.abs(a1[0] * f.a[0] + a1[1] * f.a[1] + a1[2] * f.a[2]) < 1 - 1e-9 || Math.abs(M[0] - 1) + Math.abs(M[5] - 1) + Math.abs(M[10] - 1) > 1e-9;
            if (lateral > 1e-6 * f.r || turned) { /* fall through to the recut below: the cone keeps its shape */ }
            else return liftBore(manifold, md, surf, M, opts); }
          /* a scale (4-10-2026 video, 17-55 s): the cone keeps its shape too — the scaled hole is cut through it, growing out
             through the cone's sides where it is wider than the cone, leaving a flat ring where it is narrower */ } }
      { const q0 = surfCylinder(md, surf) || surfPrism(md, surf); if (q0 && q0.hole && !boreOrigin.get(manifold)) { const c1 = applyMat(M, q0.c[0], q0.c[1], q0.c[2]); const dz = (c1[0] - q0.c[0]) * q0.a[0] + (c1[1] - q0.c[1]) * q0.a[1] + (c1[2] - q0.c[2]) * q0.a[2];
        if (Math.abs(dz) > 1e-3 * q0.r) { const lr = liftBore(manifold, md, surf, M, opts); if (lr) return lr; } } }   // moved along its axis: the rings round it follow (a through hole slid up or down)
      const prev = boreOrigin.get(manifold);
      const nearPrev = () => { const sf = md.surfs && md.surfs[surf]; if (!sf || sf.planar) return false; const d = Math.hypot(sf.c[0] - prev.now.c[0], sf.c[1] - prev.now.c[1], sf.c[2] - prev.now.c[2]); return d < 0.35 * prev.cyl.r && facesAxis(md, surf, prev.now.c, prev.now.a); };   // an oval hole made by a scale is no cylinder, but it is the same hole
      if (prev && (findCylSurf(md, prev.now) === surf || nearPrev() || onPrevBore(md, surf, prev))) return cutBore(prev.base, prev.cyl, prev.N, prev.phase, mul4(M, prev.M), prev.diag);   // a wall broken out through the body is the same hole too
      const cyl = surfCylinder(md, surf) || surfPrism(md, surf); if (!cyl || !cyl.hole) return null;   // a round bore, or an oval one (after a reload a scaled hole is only known by its shape)
      const diag = bboxDiag(md.positions) || 1; const N = cyl.n || SEG; const phase = cyl.phase || 0;
      let per = boreCache.get(manifold); if (!per) { per = new Map(); boreCache.set(manifold, per); }
      let base = per.get(surf);
      if (!base) {
        // the plug: just outside the faceted bore (so no sliver of the old wall survives), exactly its length
        let filled = fillBore(manifold, md, surf);
        if (!filled) { // a bore already broken out through a wall: a prism just outside it, kept inside the body's hull
          const rf = cyl.r / Math.cos(Math.PI / N) * (1 + 1e-4); let plug = boreTool(cyl, rf, N, phase, cyl.h0, cyl.h1);
          try { plug = plug.intersect(Manifold.hull([manifold])); } catch (e) { /* keep the plug as is */ }
          filled = clean(manifold.add(plug));
        }
        // which ends open into air: those run on through the body after the move
        const insideAt = h => {
          const p = [cyl.c[0] + cyl.a[0] * h, cyl.c[1] + cyl.a[1] * h, cyl.c[2] + cyl.a[2] * h];
          const sg = h < 0 ? -1 : 1; const d = norm([sg * cyl.a[0] + cyl.u[0] * 0.013 + cyl.v[0] * 0.007, sg * cyl.a[1] + cyl.u[1] * 0.013 + cyl.v[1] * 0.007, sg * cyl.a[2] + cyl.u[2] * 0.013 + cyl.v[2] * 0.007]);   // outward along the axis, a hair off it
          const P = md.positions, I = md.indices; let hits = 0;
          for (let t = 0; t < I.length / 3; t++) {
            const ia = I[t * 3] * 3, ib = I[t * 3 + 1] * 3, ic = I[t * 3 + 2] * 3;
            const e1 = [P[ib] - P[ia], P[ib + 1] - P[ia + 1], P[ib + 2] - P[ia + 2]], e2 = [P[ic] - P[ia], P[ic + 1] - P[ia + 1], P[ic + 2] - P[ia + 2]];
            const pv = cross(d, e2); const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2]; if (Math.abs(det) < 1e-15) continue;
            const s = [p[0] - P[ia], p[1] - P[ia + 1], p[2] - P[ia + 2]]; const uu = (s[0] * pv[0] + s[1] * pv[1] + s[2] * pv[2]) / det; if (uu < 0 || uu > 1) continue;
            const qv = cross(s, e1); const vv = (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]) / det; if (vv < 0 || uu + vv > 1) continue;
            if ((e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) / det > 1e-9) hits++;
          }
          return hits % 2 === 1;
        };
        const eps = 1e-3 * diag;
        const open0 = !insideAt(cyl.h0 - eps), open1 = !insideAt(cyl.h1 + eps);
        base = { solid: filled, open0, open1 };
        per.set(surf, base);
      }
      return cutBore(base, cyl, N, phase, Array.from(M), diag);
    }
    /**
     * M's action across the hole (a 2×2 in the hole's u, v frame) when it is worth placing the tool's corners for it: M keeps
     * the axis direction, keeps the cross-section in its plane, and stretches it unevenly (a non-uniform scale). null else.
     */
    function angleKeeping(cyl, M) {
      if (cyl.section) return null;
      const lin = w => [M[0] * w[0] + M[4] * w[1] + M[8] * w[2], M[1] * w[0] + M[5] * w[1] + M[9] * w[2], M[2] * w[0] + M[6] * w[1] + M[10] * w[2]];
      const { u, v, a } = cyl; const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
      const Lu = lin(u), Lv = lin(v), La = lin(a); const la = Math.hypot(La[0], La[1], La[2]) || 1;
      if (Math.abs(Math.abs(dot(La, a)) / la - 1) > 1e-9) return null;   // tilted: the corners cannot keep their angles
      const s = Math.max(Math.hypot(Lu[0], Lu[1], Lu[2]), Math.hypot(Lv[0], Lv[1], Lv[2]), 1e-12);
      if (Math.abs(dot(Lu, a)) > 1e-9 * s || Math.abs(dot(Lv, a)) > 1e-9 * s) return null;
      const A = [dot(u, Lu), dot(u, Lv), dot(v, Lu), dot(v, Lv)];   // [a b; c d]: column j is the image of u (j=0) or v (j=1)
      const det = A[0] * A[3] - A[1] * A[2]; if (Math.abs(det) < 1e-12 * s * s) return null;
      const c0 = A[0] * A[0] + A[2] * A[2], c1 = A[1] * A[1] + A[3] * A[3], c01 = A[0] * A[1] + A[2] * A[3];   // conformal (rotation + even scale) keeps angles already
      if (Math.abs(c0 - c1) < 1e-9 * (c0 + c1) && Math.abs(c01) < 1e-9 * (c0 + c1)) return null;
      return [A[0], A[1], A[2], A[3]];
    }
    function cutBore(base, cyl, N, phase, M, diag) {
      const L = 3 * diag + (cyl.h1 - cyl.h0);
      const tool = boreTool(cyl, cyl.r, N, phase, cyl.h0 - (base.open0 ? L : 0), cyl.h1 + (base.open1 ? L : 0), angleKeeping(cyl, M));
      const moved = tool.warp(p => { const q = applyMat(M, p[0], p[1], p[2]); p[0] = q[0]; p[1] = q[1]; p[2] = q[2]; });
      let out = base.solid.subtract(moved); try { tool.delete(); moved.delete(); } catch (e) { /* freed already */ }   // temporaries back to the engine
      out = clean(out);
      // one operation: a fresh mesh, so the coplanar pieces of a cap left by the plug and the cut read as one face again
      { const gm = out.getMesh(); const n0 = gm.numProp; const vp = new Float32Array(gm.numVert * 3);
        for (let i = 0; i < gm.numVert; i++) { vp[i * 3] = gm.vertProperties[i * n0]; vp[i * 3 + 1] = gm.vertProperties[i * n0 + 1]; vp[i * 3 + 2] = gm.vertProperties[i * n0 + 2]; }
        try { out = Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: vp, triVerts: new Uint32Array(gm.triVerts) })); } catch (e) { /* keep the boolean's mesh */ } }
      if (!(out.volume() > 1e-9 * diag * diag * diag)) return { ok: false };
      if (out.volume() >= base.solid.volume() * (1 - 1e-9)) return { ok: false };   // the hole left the body altogether: refused rather than quietly filled in
      try { const parts = out.decompose(); const n = parts.length; for (const p of parts) if (p !== out) p.delete(); if (n > 1) return { ok: false }; } catch (e) { /* no decompose: keep going */ }   // cut the body in two: not a valid result (Plasticity refuses it too)
      const c2 = applyMat(M, cyl.c[0], cyl.c[1], cyl.c[2]); const q = applyMat(M, cyl.c[0] + cyl.a[0], cyl.c[1] + cyl.a[1], cyl.c[2] + cyl.a[2]);
      const now = { a: norm([q[0] - c2[0], q[1] - c2[1], q[2] - c2[2]]), c: c2, r: cyl.r, hole: true };
      boreOrigin.set(out, { base, cyl, N, phase, M, diag, now });
      return { ok: true, solid: out, cyl: now };
    }
    /** A hole's frame now, even after a non-uniform scale made it oval (from the hole's own history when there is one). */
    function boreFrame(manifold, md, surf) {
      { const ls = shoulderOrigin.get(manifold); if (ls) return isLiftedWall(ls, md, surf) ? liftedFrame(ls) : null; }
      const prev = boreOrigin.get(manifold);
      if (prev) { const sf = md.surfs && md.surfs[surf]; const near = sf && !sf.planar && Math.hypot(sf.c[0] - prev.now.c[0], sf.c[1] - prev.now.c[1], sf.c[2] - prev.now.c[2]) < 0.35 * prev.cyl.r && facesAxis(md, surf, prev.now.c, prev.now.a);
        if (near || findCylSurf(md, prev.now) === surf || onPrevBore(md, surf, prev)) { const M = prev.M; const lin = d => norm([M[0] * d[0] + M[4] * d[1] + M[8] * d[2], M[1] * d[0] + M[5] * d[1] + M[9] * d[2], M[2] * d[0] + M[6] * d[1] + M[10] * d[2]]);
          const a = lin(prev.cyl.a); let u = lin(prev.cyl.u); const ua = u[0] * a[0] + u[1] * a[1] + u[2] * a[2]; u = norm([u[0] - a[0] * ua, u[1] - a[1] * ua, u[2] - a[2] * ua]); const v = cross(a, u);
          return { c: prev.now.c.slice(), u, v, a, r: prev.cyl.r, hole: true, h0: prev.cyl.h0, h1: prev.cyl.h1 }; } }
      const q = surfCylinder(md, surf) || surfPrism(md, surf); return q && q.hole ? q : null;
    }
    function filletEdges(manifold, md, chains, opts = {}) {
      const { tools, warn } = filletTools(md, chains, opts); let cut = null, fill = null;
      for (const t of tools) {
        let m; try { m = Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: t.positions, triVerts: t.indices })); } catch (e) { throw new Error("Operation failed because the resulting body wouldn't be valid"); }
        if ((typeof m.status === 'function' && m.status() !== 'NoError') || !(m.volume() > 0)) throw new Error("Operation failed because the resulting body wouldn't be valid");
        if (t.convex) cut = cut ? cut.add(m) : m; else fill = fill ? fill.add(m) : m;
      }
      let out = manifold; if (cut) out = out.subtract(cut); if (fill) out = out.add(fill); out = clean(out);
      if (!(out.volume() > 1e-9)) throw new Error("Operation failed because the resulting body wouldn't be valid");
      return { solid: out, warn };
    }
    /**
     * Shell (Shapr3D-style): hollows a solid to walls of thickness t and leaves one flat outer face open.
     * The cavity is the solid's convex hull pulled in by t on every side, trimmed plane by plane; the open face's plane is
     * skipped so the cavity breaks through it. Exact for convex solids (a turned blank, a box, a cylinder); on a body with
     * grooves the walls are measured from the outer envelope. open: { n, p } — normal and a point of the face to open.
     */
    function shell(manifold, t, open) {
      if (!(t > 0)) throw new Error('Set a wall thickness first');
      const hull = Manifold.hull([manifold]);
      if (hull.volume() - manifold.volume() > 1e-4 * Math.max(1, manifold.volume())) return shellAny(manifold, t, open);   // not convex: follow every face
      const g = hull.getMesh(); const P = g.vertProperties, T = g.triVerts, np = g.numProp;
      const bb = manifold.boundingBox(); const size = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1;
      const tol = 1e-5 * size; const planes = [];
      for (let i = 0; i < T.length; i += 3) {
        const a = T[i] * np, b = T[i + 1] * np, c = T[i + 2] * np;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz); if (l < 1e-12 * size * size) continue;
        nx /= l; ny /= l; nz /= l; const d = nx * P[a] + ny * P[a + 1] + nz * P[a + 2];
        if (!planes.some(q => q.n[0] * nx + q.n[1] * ny + q.n[2] * nz > 1 - 1e-5 && Math.abs(q.d - d) < 50 * tol)) planes.push({ n: [nx, ny, nz], d });
      }
      const c = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
      let cav = Manifold.cube([size * 3, size * 3, size * 3], true).translate(c); let opened = 0;
      for (const q of planes) {
        if (open && Math.abs(q.n[0] * open.n[0] + q.n[1] * open.n[1] + q.n[2] * open.n[2]) > 0.999 && Math.abs(q.n[0] * open.p[0] + q.n[1] * open.p[1] + q.n[2] * open.p[2] - q.d) < 1e-3 * size) { opened++; continue; }
        cav = cav.trimByPlane([-q.n[0], -q.n[1], -q.n[2]], -(q.d - t));
        if (!(cav.volume() > 0)) throw new Error('The wall is too thick for this body');
      }
      if (open && !opened) throw new Error('Pick a flat outer face to open');
      // one operation: rebuild the cavity as a fresh mesh so its facets count as one smooth inner surface (each trim would
      // otherwise stamp its own origin and every facet would be drawn as a separate face)
      { const gm = cav.getMesh(); const n0 = gm.numProp; const vp = new Float32Array(gm.numVert * 3);
        for (let i = 0; i < gm.numVert; i++) { vp[i * 3] = gm.vertProperties[i * n0]; vp[i * 3 + 1] = gm.vertProperties[i * n0 + 1]; vp[i * 3 + 2] = gm.vertProperties[i * n0 + 2]; }
        cav = Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: vp, triVerts: new Uint32Array(gm.triVerts) })); }
      const out = clean(manifold.subtract(cav));
      if (!(out.volume() > 1e-9) || out.volume() > manifold.volume() * (1 - 1e-6)) throw new Error('The wall is too thick for this body');
      return out;
    }
    /**
     * Shell for any body (non-convex too: a kettle with its spout). The cavity is the set of points deeper than t below the surface,
     * built as a level set of a signed distance: a voxel grid gives inside/outside and a coarse distance (exact Euclidean transform),
     * and near the wall depth the exact distance to the nearest triangle is used, so the inner wall follows every face. The open face's
     * triangles are ignored and the cavity is carried through its plane, so it breaks out there.
     */
    function shellAny(manifold, t, open) {
      const g = manifold.getMesh(); const P = g.vertProperties, T = g.triVerts, np = g.numProp; const nt = T.length / 3;
      const bb = manifold.boundingBox(); const size = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1;
      const e = Math.max(size / 110, Math.min(t / 2.2, size / 45)); const pad = 3;
      const o = [bb.min[0] - pad * e, bb.min[1] - pad * e, bb.min[2] - pad * e]; const N = [0, 1, 2].map(i => Math.ceil((bb.max[i] - bb.min[i]) / e) + 2 * pad + 1);
      const nx = N[0], ny = N[1], nz = N[2]; const idx = (i, j, k) => (k * ny + j) * nx + i;
      const V = i => [P[T[i] * np], P[T[i] * np + 1], P[T[i] * np + 2]]; const tri = new Array(nt); for (let f = 0; f < nt; f++) tri[f] = [V(3 * f), V(3 * f + 1), V(3 * f + 2)];
      // open-face triangles: coplanar with the open face
      const skip = new Uint8Array(nt);
      if (open) { const on = open.n, d0 = on[0] * open.p[0] + on[1] * open.p[1] + on[2] * open.p[2];
        for (let f = 0; f < nt; f++) { const [a, b, c] = tri[f]; const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
          let qx = uy * vz - uz * vy, qy = uz * vx - ux * vz, qz = ux * vy - uy * vx; const l = Math.hypot(qx, qy, qz) || 1; qx /= l; qy /= l; qz /= l;
          if (qx * on[0] + qy * on[1] + qz * on[2] > 0.999 && Math.abs(on[0] * a[0] + on[1] * a[1] + on[2] * a[2] - d0) < 1e-4 * size) skip[f] = 1; } }
      // inside voxels: parity of z-ray crossings per (x, y) column
      const inside = new Uint8Array(nx * ny * nz); const cols = new Map();
      for (let f = 0; f < nt; f++) { const [a, b, c] = tri[f]; const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - o[0]) / e)), i1 = Math.min(nx - 1, Math.ceil((Math.max(a[0], b[0], c[0]) - o[0]) / e));
        const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - o[1]) / e)), j1 = Math.min(ny - 1, Math.ceil((Math.max(a[1], b[1], c[1]) - o[1]) / e));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = j * nx + i; let L = cols.get(k); if (!L) cols.set(k, L = []); L.push(f); } }
      for (const [k, L] of cols) { const i = k % nx, j = (k / nx) | 0; const x = o[0] + i * e + 1e-7 * e, y = o[1] + j * e + 1.3e-7 * e; const zs = [];
        for (const f of L) { const [a, b, c] = tri[f]; const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]); if (Math.abs(d) < 1e-18) continue;
          const w1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d, w2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d, w3 = 1 - w1 - w2;
          if (w1 >= 0 && w2 >= 0 && w3 >= 0) zs.push(w1 * a[2] + w2 * b[2] + w3 * c[2]); }
        zs.sort((p, q) => p - q); for (let m = 0; m + 1 < zs.length; m += 2) { const k0 = Math.max(0, Math.ceil((zs[m] - o[2]) / e)), k1 = Math.min(nz - 1, Math.floor((zs[m + 1] - o[2]) / e)); for (let kk = k0; kk <= k1; kk++) inside[idx(i, j, kk)] = 1; } }
      // coarse distance of inside voxels to the outside (exact Euclidean distance transform, separable, in voxel units)
      const INF = 1e20; const D = new Float64Array(nx * ny * nz); for (let q = 0; q < D.length; q++) D[q] = inside[q] ? INF : 0;
      const edt1 = (f, n) => { const d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1); let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
        for (let q = 1; q < n; q++) { let s; do { const r = v[k]; s = ((f[q] + q * q) - (f[r] + r * r)) / (2 * q - 2 * r); if (s <= z[k]) k--; else break; } while (k >= 0); k++; v[k] = q; z[k] = s; z[k + 1] = INF; }
        k = 0; for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const r = v[k]; d[q] = (q - r) * (q - r) + f[r]; } return d; };
      const pass = (n, get, set, count) => { const f = new Float64Array(n); for (let c = 0; c < count; c++) { for (let q = 0; q < n; q++) f[q] = get(c, q); const d = edt1(f, n); for (let q = 0; q < n; q++) set(c, q, d[q]); } };
      pass(nx, (c, q) => D[c * nx + q], (c, q, v) => { D[c * nx + q] = v; }, ny * nz);
      pass(ny, (c, q) => D[((c / nx | 0) * ny + q) * nx + c % nx], (c, q, v) => { D[((c / nx | 0) * ny + q) * nx + c % nx] = v; }, nx * nz);
      pass(nz, (c, q) => D[q * nx * ny + c], (c, q, v) => { D[q * nx * ny + c] = v; }, nx * ny);
      // triangle bins for exact distances near the wall depth
      const B = t + 3 * e; const bin = new Map(); const bk = (a, b, c) => a + ',' + b + ',' + c;
      for (let f = 0; f < nt; f++) { if (skip[f]) continue; const [a, b, c] = tri[f]; const lo = [0, 1, 2].map(i => Math.floor(Math.min(a[i], b[i], c[i]) / B)), hi = [0, 1, 2].map(i => Math.floor(Math.max(a[i], b[i], c[i]) / B));
        for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) { const key = bk(x, y, z); let L = bin.get(key); if (!L) bin.set(key, L = []); L.push(f); } }
      const ptTri = (p, a, b, c) => {   // distance from point p to triangle abc (Ericson)
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
        const dot = (u, w) => u[0] * w[0] + u[1] * w[1] + u[2] * w[2]; const d1 = dot(ab, ap), d2 = dot(ac, ap); if (d1 <= 0 && d2 <= 0) return Math.hypot(...ap);
        const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]]; const d3 = dot(ab, bp), d4 = dot(ac, bp); if (d3 >= 0 && d4 <= d3) return Math.hypot(...bp);
        const vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return Math.hypot(ap[0] - v * ab[0], ap[1] - v * ab[1], ap[2] - v * ab[2]); }
        const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]]; const d5 = dot(ab, cp), d6 = dot(ac, cp); if (d6 >= 0 && d5 <= d6) return Math.hypot(...cp);
        const vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return Math.hypot(ap[0] - w * ac[0], ap[1] - w * ac[1], ap[2] - w * ac[2]); }
        const va = d3 * d6 - d5 * d4; if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); const q = [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])]; return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); }
        const den = 1 / (va + vb + vc), v = vb * den, w = vc * den; return Math.hypot(ap[0] - ab[0] * v - ac[0] * w, ap[1] - ab[1] * v - ac[1] * w, ap[2] - ab[2] * v - ac[2] * w); };
      const exact = p => { const cx = Math.floor(p[0] / B), cy = Math.floor(p[1] / B), cz = Math.floor(p[2] / B); let best = B; const seen = new Set();
        for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) for (let z = cz - 1; z <= cz + 1; z++) { const L = bin.get(bk(x, y, z)); if (!L) continue;
          for (const f of L) { if (seen.has(f)) continue; seen.add(f); const d = ptTri(p, ...tri[f]); if (d < best) best = d; } } return best; };
      const voxIn = p => { const i = Math.round((p[0] - o[0]) / e), j = Math.round((p[1] - o[1]) / e), k = Math.round((p[2] - o[2]) / e); return i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz ? inside[idx(i, j, k)] : 0; };
      const coarse = p => { const i = Math.min(nx - 1, Math.max(0, Math.round((p[0] - o[0]) / e))), j = Math.min(ny - 1, Math.max(0, Math.round((p[1] - o[1]) / e))), k = Math.min(nz - 1, Math.max(0, Math.round((p[2] - o[2]) / e))); return Math.sqrt(D[idx(i, j, k)]) * e; };
      const on = open && open.n, d0 = open ? on[0] * open.p[0] + on[1] * open.p[1] + on[2] * open.p[2] : 0;
      const sdf = p => {   // positive inside, the distance to the nearest wall (the open face does not count)
        let q = p, above = false; if (open) { const sd = on[0] * p[0] + on[1] * p[1] + on[2] * p[2] - d0; if (sd > -2 * e) { above = true; const back = sd + 2 * e; q = [p[0] - on[0] * back, p[1] - on[1] * back, p[2] - on[2] * back]; } }
        if (!voxIn(q)) return -e; const c = above ? t + 2 * e : coarse(p); if (!above && c > t + 3 * e) return c; return exact(p); };
      const lo = [bb.min[0] - e, bb.min[1] - e, bb.min[2] - e], hi = [bb.max[0] + e, bb.max[1] + e, bb.max[2] + e];
      if (open) for (let i = 0; i < 3; i++) { if (on[i] > 0.5) hi[i] += 3 * e + t; if (on[i] < -0.5) lo[i] -= 3 * e + t; }
      const cav = Manifold.levelSet(sdf, { min: lo, max: hi }, e, t);
      if (!(cav.volume() > 1e-9)) throw new Error('The wall is too thick for this body');
      const out = clean(manifold.subtract(cav)); if (!(out.volume() > 1e-9)) throw new Error('The wall is too thick for this body');
      return out;
    }
    /** Fits a cylinder to one surface of the mesh: axis point a, direction d, radius r, axial span [t0, t1], and whether its normals point
     *  towards the axis (a hole) or away (a boss). Returns null when the surface is not cylindrical. */
    function fitCylinder(md, surf) {
      const P = md.positions, I = md.indices, nt = I.length / 3; const tris = []; for (let t = 0; t < nt; t++) if (md.surfID[t] === surf) tris.push(t); if (tris.length < 6) return null;
      const N = []; const C0 = [];
      for (const t of tris) { const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3; const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const l = Math.hypot(...n); if (l < 1e-14) continue; n = n.map(x => x / l); N.push(n); C0.push([(P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3]); }
      // the axis is perpendicular to every normal: the smallest-variance direction of the normals (power iteration on the scatter matrix)
      const S3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; for (const n of N) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S3[i][j] += n[i] * n[j];
      const tr = S3[0][0] + S3[1][1] + S3[2][2]; const A = [[tr - S3[0][0], -S3[0][1], -S3[0][2]], [-S3[1][0], tr - S3[1][1], -S3[1][2]], [-S3[2][0], -S3[2][1], tr - S3[2][2]]];
      let d = [0.3, 0.5, 0.8]; for (let k = 0; k < 60; k++) { const y = [0, 1, 2].map(i => A[i][0] * d[0] + A[i][1] * d[1] + A[i][2] * d[2]); const l = Math.hypot(...y) || 1; d = y.map(x => x / l); }
      for (const n of N) if (Math.abs(n[0] * d[0] + n[1] * d[1] + n[2] * d[2]) > 0.02) return null;
      // radius and axis point: the centres shifted along their normals by r should all meet on one line; solve r from pairs
      const c = C0.reduce((a, p) => [a[0] + p[0] / C0.length, a[1] + p[1] / C0.length, a[2] + p[2] / C0.length], [0, 0, 0]);
      const proj = p => { const t = (p[0] - c[0]) * d[0] + (p[1] - c[1]) * d[1] + (p[2] - c[2]) * d[2]; return [p[0] - c[0] - t * d[0], p[1] - c[1] - t * d[1], p[2] - c[2] - t * d[2]]; };
      // least squares: q_i - r * n_i = a for all i (in the plane ⟂ d): a = mean(q) - r mean(n); minimise Σ|q_i - r n_i - a|²
      const Q = C0.map(proj); const nm = N.reduce((a, n) => [a[0] + n[0] / N.length, a[1] + n[1] / N.length, a[2] + n[2] / N.length], [0, 0, 0]); const qm = Q.reduce((a, q) => [a[0] + q[0] / Q.length, a[1] + q[1] / Q.length, a[2] + q[2] / Q.length], [0, 0, 0]);
      let num = 0, den = 0; for (let i = 0; i < Q.length; i++) { const dq = [Q[i][0] - qm[0], Q[i][1] - qm[1], Q[i][2] - qm[2]], dn = [N[i][0] - nm[0], N[i][1] - nm[1], N[i][2] - nm[2]]; num += dq[0] * dn[0] + dq[1] * dn[1] + dq[2] * dn[2]; den += dn[0] * dn[0] + dn[1] * dn[1] + dn[2] * dn[2]; }
      if (den < 1e-12) return null; const rs = num / den; const r = Math.abs(rs); if (r < 1e-9) return null; const inward = rs < 0;   // normals point to the axis: a hole
      const a0 = [qm[0] - rs * nm[0] + c[0], qm[1] - rs * nm[1] + c[1], qm[2] - rs * nm[2] + c[2]];
      let bad = 0;
      const keys = surfaceVertexKeys(md, surf); let t0 = Infinity, t1 = -Infinity; const nv = P.length / 3;
      for (let i = 0; i < nv; i++) { const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]; if (!keys.has(fkey(x, y, z))) continue; const t = (x - a0[0]) * d[0] + (y - a0[1]) * d[1] + (z - a0[2]) * d[2]; t0 = Math.min(t0, t); t1 = Math.max(t1, t);
        const rr = Math.hypot(x - a0[0] - t * d[0], y - a0[1] - t * d[1], z - a0[2] - t * d[2]); if (Math.abs(rr - r) > 0.03 * r + 1e-6) bad++; }
      if (bad > 0.05 * keys.size + 2) return null;
      return { a: a0, d, r, t0, t1, inward, arc: N.length };
    }
    function cylSolid(cyl, r, t0, t1) { const h = t1 - t0; const m = Manifold.cylinder(h, r, r, 96).translate([0, 0, t0]); const z = [0, 0, 1], d = cyl.d; const c = z[0] * d[0] + z[1] * d[1] + z[2] * d[2]; let out = m;
      if (c < 1 - 1e-9) { const ax = c < -1 + 1e-9 ? [1, 0, 0] : [z[1] * d[2] - z[2] * d[1], z[2] * d[0] - z[0] * d[2], z[0] * d[1] - z[1] * d[0]]; const l = Math.hypot(...ax); const k = ax.map(v => v / l); const ang = Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
        out = m.rotate ? rotateAbout(m, k, ang) : m; }
      return out.translate(cyl.a); }
    function rotateAbout(m, k, deg) { // rotation about unit axis k through the origin, via a matrix
      const th = deg * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th), t = 1 - cs; const [x, y, z] = k;
      const R = [t * x * x + cs, t * x * y - sn * z, t * x * z + sn * y, 0, t * x * y + sn * z, t * y * y + cs, t * y * z - sn * x, 0, t * x * z - sn * y, t * y * z + sn * x, t * z * z + cs, 0];
      return transformSolid(m, [R[0], R[4], R[8], 0, R[1], R[5], R[9], 0, R[2], R[6], R[10], 0, 0, 0, 0, 1]); }
    /** A hole's cylindrical wall moved rigidly by M (slide, turn, or both): the old hole is filled and the moved one cut through, like Shapr3D. */
    function moveHole(manifold, cyl, M) {
      const ext = (cyl.t1 - cyl.t0) * 2 + cyl.r * 4; const fill = cylSolid(cyl, cyl.r * (1 + 1e-6), cyl.t0 - 1e-5 * cyl.r, cyl.t1 + 1e-5 * cyl.r);
      const filled = manifold.add(fill); const cutter = transformSolid(cylSolid(cyl, cyl.r, cyl.t0 - ext, cyl.t1 + ext), M);
      return clean(filled.subtract(cutter));
    }
    /**
     * Moves, turns or scales an outer cylindrical face as one surface (Shapr3D): the cylinder is rebuilt through M and re-cut by the
     * body's other flat faces (its caps and sides), so a turned side gives an oblique cylinder; holes and pockets stay where they were.
     */
    function moveOuterCylinder(manifold, cyl, M) {
      const hull = Manifold.hull([manifold]); const D = hull.subtract(manifold);   // D = the body's holes and pockets
      const ext = (cyl.t1 - cyl.t0) * 2 + cyl.r * 4; let out = transformSolid(cylSolid(cyl, cyl.r, cyl.t0 - ext, cyl.t1 + ext), M);
      const g = hull.getMesh(); const P = g.vertProperties, T = g.triVerts, np = g.numProp; const bb = manifold.boundingBox();
      const size = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1; const planes = [];
      for (let i = 0; i < T.length; i += 3) { const a = T[i] * np, b = T[i + 1] * np, c = T[i + 2] * np;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz); if (l < 1e-12 * size * size) continue; nx /= l; ny /= l; nz /= l;
        const d = nx * P[a] + ny * P[a + 1] + nz * P[a + 2];
        // a facet of the cylinder wall itself: normal ⟂ axis and tangent at distance r from the axis
        const along = nx * cyl.d[0] + ny * cyl.d[1] + nz * cyl.d[2]; const distAxis = Math.abs(nx * cyl.a[0] + ny * cyl.a[1] + nz * cyl.a[2] - d);
        if (Math.abs(along) < 0.05 && Math.abs(distAxis - cyl.r) < 0.06 * cyl.r + 1e-6) continue;
        if (!planes.some(q => q.n[0] * nx + q.n[1] * ny + q.n[2] * nz > 1 - 1e-5 && Math.abs(q.d - d) < 1e-4 * size)) planes.push({ n: [nx, ny, nz], d }); }
      for (const q of planes) { out = out.trimByPlane([-q.n[0], -q.n[1], -q.n[2]], -q.d); if (!(out.volume() > 1e-12)) throw new Error('That move leaves nothing of the body'); }
      if (D.volume() > 1e-9) out = out.subtract(D);
      return clean(asOneRun(out));
    }
    /** The same solid as one run (one origin), so a curved wall built from many trims shades and draws as one smooth surface. */
    function asOneRun(m) { const gm = m.getMesh(); const n0 = gm.numProp; const vp = new Float32Array(gm.numVert * 3); for (let i = 0; i < gm.numVert; i++) { vp[i * 3] = gm.vertProperties[i * n0]; vp[i * 3 + 1] = gm.vertProperties[i * n0 + 1]; vp[i * 3 + 2] = gm.vertProperties[i * n0 + 2]; } return Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: vp, triVerts: new Uint32Array(gm.triVerts) })); }
    /**
     * Moves, turns or scales any outer surface (cylinder, cone, drafted wall, sphere…) as one surface, like Shapr3D: the body is rebuilt from
     * its bounding planes with the surface's facet planes carried through M, then re-cut by the other faces; holes and pockets are put back.
     * Returns null when the surface is not part of the body's outer hull (a concave wall), so the caller can fall back.
     */
    function transformSurface(manifold, md, surf, M) {
      const P = md.positions, I = md.indices, nt = I.length / 3; const bb = manifold.boundingBox();
      const size = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1;
      const planeOf = (ax, ay, az, bx, by, bz, cx, cy, cz) => { const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz); if (l < 1e-12 * size * size) return null; nx /= l; ny /= l; nz /= l; return { n: [nx, ny, nz], d: nx * ax + ny * ay + nz * az, p: [ax, ay, az], t1: [ux, uy, uz], t2: [vx, vy, vz] }; };
      const same = (q, r) => q.n[0] * r.n[0] + q.n[1] * r.n[1] + q.n[2] * r.n[2] > 1 - 1e-4 && Math.abs(q.d - r.d) < 2e-4 * size;
      const facets = [];
      for (let t = 0; t < nt; t++) { if (md.surfID[t] !== surf) continue; const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3; const q = planeOf(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]); if (q && !facets.some(r => same(q, r))) facets.push(q); }
      if (!facets.length) return null;
      const hull = Manifold.hull([manifold]); const D = hull.subtract(manifold);
      const g = hull.getMesh(); const HP = g.vertProperties, HT = g.triVerts, np = g.numProp; const planes = [];
      // the wall's corners: a hull triangle on three of them is the same wall triangulated another way, so it moves with it
      // (left behind, such a plane would carve a bevel into the next face once the wall has moved)
      const wk = (x, y, z) => x.toFixed(4) + ',' + y.toFixed(4) + ',' + z.toFixed(4); const wallPts = new Set();
      for (let t = 0; t < nt; t++) if (md.surfID[t] === surf) for (let e = 0; e < 3; e++) { const v = I[t * 3 + e] * 3; wallPts.add(wk(P[v], P[v + 1], P[v + 2])); }
      // which other faces each wall corner also touches: a hull triangle lying all along one such edge (the crease where the
      // wall meets the next face) belongs to that crease, not to the wall
      const touches = new Map(); for (let t = 0; t < nt; t++) { const sf = md.surfID[t]; if (sf === surf) continue; for (let e = 0; e < 3; e++) { const v = I[t * 3 + e] * 3; const k = wk(P[v], P[v + 1], P[v + 2]); if (!wallPts.has(k)) continue; let S = touches.get(k); if (!S) { S = new Set(); touches.set(k, S); } S.add(sf); } }
      const alongOneEdge = keys => { const S0 = touches.get(keys[0]); if (!S0) return false; for (const sf of S0) if (keys.every(k => { const S = touches.get(k); return S && S.has(sf); })) return true; return false; };
      for (let i = 0; i < HT.length; i += 3) { const a = HT[i] * np, b = HT[i + 1] * np, c = HT[i + 2] * np; const q = planeOf(HP[a], HP[a + 1], HP[a + 2], HP[b], HP[b + 1], HP[b + 2], HP[c], HP[c + 1], HP[c + 2]); if (!q) continue;
        { const ks = [a, b, c].map(k => wk(HP[k], HP[k + 1], HP[k + 2])); q.onWall = ks.every(k => wallPts.has(k)) && !alongOneEdge(ks); }
        const prev = planes.find(r => same(q, r)); if (!prev) planes.push(q); else if (q.onWall) prev.onWall = true; }
      let matched = 0;
      const moved = planes.map(q => { const f = facets.find(r => same(q, r)) || (q.onWall ? q : null); if (!f) return q; matched++;
        const p = applyMat(M, f.p[0], f.p[1], f.p[2]), p1 = applyMat(M, f.p[0] + f.t1[0], f.p[1] + f.t1[1], f.p[2] + f.t1[2]), p2 = applyMat(M, f.p[0] + f.t2[0], f.p[1] + f.t2[1], f.p[2] + f.t2[2]);
        const r = planeOf(p[0], p[1], p[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]); return r || q; });
      if (matched < Math.max(1, facets.length * 0.5)) return null;   // the wall is not on the outside of the body
      const ext = 4 * size + 4 * Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]); const cc = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
      let out = Manifold.cube([ext, ext, ext], true).translate(cc);
      for (const q of moved) { out = out.trimByPlane([-q.n[0], -q.n[1], -q.n[2]], -q.d); if (!(out.volume() > 1e-12)) throw new Error('That move leaves nothing of the body'); }
      // only the body's real hollows (holes, pockets) are cut back in. The hull triangulates a wall its own way, so hull − body
      // also holds paper-thin wedges along the old wall (one per strip of a swept cone): cut into the moved wall they leave
      // a slit per strip, and the one wall falls apart into hundreds of faces
      if (D.volume() > 1e-9 * Math.max(1, hull.volume())) { let hollow = null;
        try { for (const part of D.decompose()) { const v = part.volume(), a = part.surfaceArea(); if (2 * v / (a || 1) > 1e-4 * size) hollow = hollow ? hollow.add(part) : part; } } catch (e) { hollow = D; }
        if (hollow) out = out.subtract(hollow); }
      return clean(asOneRun(out));
    }
    /**
     * Scale an outer wall that runs round an axis (cylinder, cone, oval) across that axis, by M (a scale in the planes across
     * the axis: those planes stay where they are). Unlike transformSurface this rebuilds nothing: the wall's own points move,
     * so the body keeps the same make-up however often it is scaled. Holes are filled first and cut again after (their rim
     * is not dragged along). Where the wall meets a face running straight along the axis (the cylinder under a cone) the
     * shared points slide along that face to meet the scaled wall, so that face stays exactly what it was, only longer or
     * shorter; where it meets a flat end across the axis, they stay in that plane. Any other neighbour → null (the caller
     * falls back). { solid } or { ok: false } when the result would fold over.
     */
    /** A solid from the exact engine's fine mesh (positions, triangles); coincident points along shared edges are merged. */
    function fromTriangles(vp, tv, fid = null) { const mesh = new Mesh(fid ? { numProp: 3, vertProperties: vp, triVerts: tv, faceID: fid } : { numProp: 3, vertProperties: vp, triVerts: tv }); try { mesh.merge(); } catch (e) { /* already closed */ }
      const m = Manifold.ofMesh(mesh); if (typeof m.status === 'function' && m.status() !== 'NoError') throw new Error('The exact engine returned an open shape'); return m; }
    /** Faces as the solid's own face ids say (the exact engine's true faces), not grouped by angle: one CAD face, one face. */
    function facesByID(man, md) { const gm = man.getMesh(); const np = gm.numProp; const P0 = new Float32Array(gm.numVert * 3); for (let i = 0; i < gm.numVert; i++) { P0[i * 3] = gm.vertProperties[i * np]; P0[i * 3 + 1] = gm.vertProperties[i * np + 1]; P0[i * 3 + 2] = gm.vertProperties[i * np + 2]; } const I0 = new Uint32Array(gm.triVerts);
      const map = new Map(); const sid = new Uint32Array(md.faceID.length); for (let t = 0; t < sid.length; t++) { const f = md.faceID[t]; let k = map.get(f); if (k === undefined) { k = map.size; map.set(f, k); } sid[t] = k; }
      const topo = meshTopology(P0, I0); md.surfID = sid; md.surfs = surfaceInfo(P0, I0, topo, sid, map.size, md.faceID); rebuildShading(md, P0, I0, topo); return md; }
    function scaleWall(manifold, md, surf, M, frame) {
      const a = norm(frame.a), c = frame.c; const bb = manifold.boundingBox(); const size = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1;
      // the body's real hollows (not the hair-thin wedges between a wall and its hull)
      // a hole with history: its plugged body and its exact cutter are known — no hull (whose wedges along a thin wall would
      // be cut back in as stray old faces). Else: the body's real hollows from its hull.
      const pr = boreOrigin.get(manifold); let hollow = null, fromHistory = false;
      if (pr && pr.base && pr.base.solid) { try { const Lb = 3 * pr.diag + (pr.cyl.h1 - pr.cyl.h0);
          const tool = boreTool(pr.cyl, pr.cyl.r, pr.N, pr.phase, pr.cyl.h0 - (pr.base.open0 ? Lb : 0), pr.cyl.h1 + (pr.base.open1 ? Lb : 0), angleKeeping(pr.cyl, pr.M));
          hollow = tool.warp(q => { const m = applyMat(pr.M, q[0], q[1], q[2]); q[0] = m[0]; q[1] = m[1]; q[2] = m[2]; }); fromHistory = true; } catch (e) { hollow = null; } }
      if (!fromHistory) try { const hull = Manifold.hull([manifold]); const D = hull.subtract(manifold); if (D.volume() > 1e-9 * Math.max(1, hull.volume())) for (const part of D.decompose()) { const v = part.volume(), ar = part.surfaceArea(); if (2 * v / (ar || 1) > 1e-4 * size) hollow = hollow ? hollow.add(part) : part; } } catch (e) { hollow = null; }
      const filled = fromHistory ? pr.base.solid : hollow ? manifold.add(hollow) : manifold;
      const g0 = filled.getMesh(); const np = g0.numProp, P0 = g0.vertProperties, TV = g0.triVerts, nv = g0.numVert, ntr = TV.length / 3;
      const key = (x, y, z) => fkey(x, y, z);
      const wallKeys = new Set(); { const P = md.positions, I = md.indices; for (let t = 0; t < md.surfID.length; t++) if (md.surfID[t] === surf) for (let e = 0; e < 3; e++) { const v = I[t * 3 + e] * 3; wallKeys.add(key(P[v], P[v + 1], P[v + 2])); } }
      // with history the wall is scaled on the plugged body, where a hole that broke through it has not cut it yet: the wall
      // there is that body's own face holding the wall's points (all of it, not only the parts the cut body still has)
      if (fromHistory) { try { const bmd = meshData(filled); const P = bmd.positions, I = bmd.indices; const hits = new Map();
          for (let t = 0; t < bmd.surfID.length; t++) for (let e = 0; e < 3; e++) { const v = I[t * 3 + e] * 3; if (wallKeys.has(key(P[v], P[v + 1], P[v + 2]))) hits.set(bmd.surfID[t], (hits.get(bmd.surfID[t]) || 0) + 1); }
          let bs = -1, bh = 0; for (const [sf, h] of hits) if (h > bh && !(bmd.surfs[sf] && bmd.surfs[sf].planar)) { bh = h; bs = sf; }
          if (bs >= 0) { wallKeys.clear(); for (let t = 0; t < bmd.surfID.length; t++) if (bmd.surfID[t] === bs) for (let e = 0; e < 3; e++) { const v = I[t * 3 + e] * 3; wallKeys.add(key(P[v], P[v + 1], P[v + 2])); } } } catch (e) { /* keep the cut body's points */ } }
      const pos = v => [P0[v * np], P0[v * np + 1], P0[v * np + 2]];
      const isW = new Uint8Array(nv); for (let v = 0; v < nv; v++) { const p = pos(v); if (wallKeys.has(key(p[0], p[1], p[2]))) isW[v] = 1; }
      const triN = t => { const A = pos(TV[t * 3]), B = pos(TV[t * 3 + 1]), Cc = pos(TV[t * 3 + 2]); const n = cross([B[0] - A[0], B[1] - A[1], B[2] - A[2]], [Cc[0] - A[0], Cc[1] - A[1], Cc[2] - A[2]]); const l = Math.hypot(n[0], n[1], n[2]); return l < 1e-20 ? null : [n[0] / l, n[1] / l, n[2] / l]; };
      // a triangle of the wall: its corners are wall points and it is not an end face across the axis
      const nT = new Array(ntr); const wallTri = new Uint8Array(ntr);
      for (let t = 0; t < ntr; t++) { const n = triN(t); nT[t] = n; if (n && isW[TV[t * 3]] && isW[TV[t * 3 + 1]] && isW[TV[t * 3 + 2]] && Math.abs(n[0] * a[0] + n[1] * a[1] + n[2] * a[2]) < 0.999) wallTri[t] = 1; }
      // what each wall point also touches: a straight side (normal across the axis), a flat end (normal along it), or other
      const side = new Uint8Array(nv), end = new Uint8Array(nv), other = new Uint8Array(nv);
      for (let t = 0; t < ntr; t++) { if (wallTri[t]) continue; const n = nT[t]; if (!n) continue; const na = Math.abs(n[0] * a[0] + n[1] * a[1] + n[2] * a[2]);
        for (let e = 0; e < 3; e++) { const v = TV[t * 3 + e]; if (!isW[v]) continue; if (na < 0.02) side[v] = 1; else if (na > 0.9999) end[v] = 1; else other[v] = 1; } }
      // a sloped neighbour (the cone over a cylinder being scaled): only for a straight wall; the shared points then slide
      // along the neighbour's own lines to meet the scaled wall, so the neighbour keeps its shape
      let wallAxial = true; for (let t = 0; t < ntr; t++) if (wallTri[t] && nT[t] && Math.abs(nT[t][0] * a[0] + nT[t][1] * a[1] + nT[t][2] * a[2]) > 0.05) { wallAxial = false; break; }
      for (let v = 0; v < nv; v++) if (isW[v] && other[v] && (!wallAxial || side[v])) return null;   // a neighbour this method cannot keep
      const nGen = new Map(); for (let t = 0; t < ntr; t++) { if (wallTri[t]) continue; const n = nT[t]; if (!n) continue; const na = Math.abs(n[0] * a[0] + n[1] * a[1] + n[2] * a[2]); if (na < 0.02 || na > 0.9999) continue;
        for (let e = 0; e < 3; e++) { const v = TV[t * 3 + e]; if (!isW[v] || !other[v]) continue; for (let f = 0; f < 3; f++) { const w = TV[t * 3 + f]; if (isW[w]) continue; let L = nGen.get(v); if (!L) { L = new Set(); nGen.set(v, L); } L.add(w); } } }
      // the same, read from the original body (not the filled one): over a notch the filled body has filler faces, and a
      // seam point sliding along one of those would leave the neighbour's real surface
      const origGen = new Map(); { const P = md.positions, I = md.indices; const kk = i => key(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
        for (let t = 0; t < md.surfID.length; t++) { if (md.surfID[t] === surf) continue; const A = [0, 1, 2].map(e => I[t * 3 + e]); const p0 = [P[A[0] * 3], P[A[0] * 3 + 1], P[A[0] * 3 + 2]], p1 = [P[A[1] * 3], P[A[1] * 3 + 1], P[A[1] * 3 + 2]], p2 = [P[A[2] * 3], P[A[2] * 3 + 1], P[A[2] * 3 + 2]];
          const n = cross([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]]); const l = Math.hypot(n[0], n[1], n[2]); if (l < 1e-20) continue; const na = Math.abs(n[0] * a[0] + n[1] * a[1] + n[2] * a[2]) / l; if (na < 0.02 || na > 0.9999) continue;
          for (let e = 0; e < 3; e++) { const k = kk(A[e]); if (!wallKeys.has(k)) continue; for (let f = 0; f < 3; f++) { if (f === e || wallKeys.has(kk(A[f]))) continue; let L = origGen.get(k); if (!L) { L = []; origGen.set(k, L); } L.push([P[A[f] * 3], P[A[f] * 3 + 1], P[A[f] * 3 + 2]]); } } } }
      // M's inverse (a point on the scaled wall carried back onto the original one)
      const Ld = [[M[0], M[4], M[8]], [M[1], M[5], M[9]], [M[2], M[6], M[10]]]; const det = Ld[0][0] * (Ld[1][1] * Ld[2][2] - Ld[1][2] * Ld[2][1]) - Ld[0][1] * (Ld[1][0] * Ld[2][2] - Ld[1][2] * Ld[2][0]) + Ld[0][2] * (Ld[1][0] * Ld[2][1] - Ld[1][1] * Ld[2][0]); if (Math.abs(det) < 1e-12) return null;
      const Li = [[(Ld[1][1] * Ld[2][2] - Ld[1][2] * Ld[2][1]) / det, (Ld[0][2] * Ld[2][1] - Ld[0][1] * Ld[2][2]) / det, (Ld[0][1] * Ld[1][2] - Ld[0][2] * Ld[1][1]) / det], [(Ld[1][2] * Ld[2][0] - Ld[1][0] * Ld[2][2]) / det, (Ld[0][0] * Ld[2][2] - Ld[0][2] * Ld[2][0]) / det, (Ld[0][2] * Ld[1][0] - Ld[0][0] * Ld[1][2]) / det], [(Ld[1][0] * Ld[2][1] - Ld[1][1] * Ld[2][0]) / det, (Ld[0][1] * Ld[2][0] - Ld[0][0] * Ld[2][1]) / det, (Ld[0][0] * Ld[1][1] - Ld[0][1] * Ld[1][0]) / det]];
      const linv = v3 => [Li[0][0] * v3[0] + Li[0][1] * v3[1] + Li[0][2] * v3[2], Li[1][0] * v3[0] + Li[1][1] * v3[1] + Li[1][2] * v3[2], Li[2][0] * v3[0] + Li[2][1] * v3[1] + Li[2][2] * v3[2]];
      const back = x => linv([x[0] - M[12], x[1] - M[13], x[2] - M[14]]);
      // a flat end across the axis whose whole outline is this wall (a top filled over a hole) moves its inner points too: the
      // plane maps onto itself, so it stays flat and inside its new outline (left behind, thin fans in it would fold)
      const innerMove = new Uint8Array(nv);
      { const endTri = new Uint8Array(ntr); for (let t = 0; t < ntr; t++) { const n = nT[t]; if (!wallTri[t] && n && Math.abs(n[0] * a[0] + n[1] * a[1] + n[2] * a[2]) > 0.9999) endTri[t] = 1; }
        const par = new Int32Array(nv); for (let v = 0; v < nv; v++) par[v] = v; const fd = v => { while (par[v] !== v) { par[v] = par[par[v]]; v = par[v]; } return v; };
        for (let t = 0; t < ntr; t++) if (endTri[t]) { const x = fd(TV[t * 3]), y = fd(TV[t * 3 + 1]), z = fd(TV[t * 3 + 2]); par[y] = x; par[fd(z)] = x; }
        const onlyEnd = new Uint8Array(nv).fill(1), touchesEnd = new Uint8Array(nv); for (let t = 0; t < ntr; t++) for (let e = 0; e < 3; e++) { const v = TV[t * 3 + e]; if (endTri[t]) touchesEnd[v] = 1; else onlyEnd[v] = 0; }
        const okComp = new Map(); for (let v = 0; v < nv; v++) { if (!touchesEnd[v]) continue; const r = fd(v); if (!okComp.has(r)) okComp.set(r, true); if (!onlyEnd[v] && !isW[v]) okComp.set(r, false); }   // an outline point that is not the wall: leave that end alone
        for (let v = 0; v < nv; v++) if (touchesEnd[v] && onlyEnd[v] && !isW[v] && okComp.get(fd(v))) innerMove[v] = 1; }
      // each sliding point's generator: the wall point it is joined to (not sliding itself) nearest round the axis
      const rad = p => { const w = [p[0] - c[0], p[1] - c[1], p[2] - c[2]]; const h = w[0] * a[0] + w[1] * a[1] + w[2] * a[2]; return [w[0] - a[0] * h, w[1] - a[1] * h, w[2] - a[2] * h]; };
      const nbr = new Map(); for (let t = 0; t < ntr; t++) if (wallTri[t]) for (let e = 0; e < 3; e++) { const v = TV[t * 3 + e]; if (!side[v]) continue; for (let f = 0; f < 3; f++) { const w = TV[t * 3 + f]; if (w === v || side[w]) continue; let L = nbr.get(v); if (!L) { L = new Set(); nbr.set(v, L); } L.add(w); } }
      const P1 = Float64Array.from(P0);
      for (let v = 0; v < nv; v++) if (innerMove[v]) { const p = pos(v); const q = applyMat(M, p[0], p[1], p[2]); P1[v * np] = q[0]; P1[v * np + 1] = q[1]; P1[v * np + 2] = q[2]; }
      const doneAt = new Map();   // copies of one point (the mesh can hold several at one place) all get the same target
      for (let v = 0; v < nv; v++) { if (!isW[v]) continue; const p = pos(v); { const k0 = key(p[0], p[1], p[2]); const d0 = doneAt.get(k0); if (d0 !== undefined) { P1[v * np] = P1[d0 * np]; P1[v * np + 1] = P1[d0 * np + 1]; P1[v * np + 2] = P1[d0 * np + 2]; continue; } doneAt.set(k0, v); }
        if (other[v]) {   // slide along the sloped neighbour's line until it meets the scaled (straight) wall
          const rp = rad(p); const R = Math.hypot(rp[0], rp[1], rp[2]); if (!(R > 1e-9)) return null;
          const cand = (!fromHistory && origGen.get(key(p[0], p[1], p[2]))) || [...(nGen.get(v) || [])].map(pos); if (!cand.length) return null;
          let r = null, bd = -2; for (const q of cand) { const rw = rad(q); const lw = Math.hypot(rw[0], rw[1], rw[2]) || 1; const d = (rp[0] * rw[0] + rp[1] * rw[1] + rp[2] * rw[2]) / (R * lw); if (d > bd) { bd = d; r = q; } }
          const g = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
          const radDir = d3 => { const h = d3[0] * a[0] + d3[1] * a[1] + d3[2] * a[2]; return [d3[0] - a[0] * h, d3[1] - a[1] * h, d3[2] - a[2] * h]; };
          const A0 = rad(back(p)), B = radDir(linv(g));   // the point carried back must lie on the original wall: at radius R there
          const qa = B[0] * B[0] + B[1] * B[1] + B[2] * B[2], qb = 2 * (A0[0] * B[0] + A0[1] * B[1] + A0[2] * B[2]), qc = A0[0] * A0[0] + A0[1] * A0[1] + A0[2] * A0[2] - R * R;
          let tv; if (qa < 1e-18) { if (Math.abs(qc) > 1e-9 * R * R) return null; tv = 0; } else { const disc = qb * qb - 4 * qa * qc; if (disc < 0) return null; const t1 = (-qb + Math.sqrt(disc)) / (2 * qa), t2 = (-qb - Math.sqrt(disc)) / (2 * qa); tv = Math.abs(t1) < Math.abs(t2) ? t1 : t2; }
          if (tv >= 1) return { ok: false };   // the neighbour would vanish
          P1[v * np] = p[0] + tv * g[0]; P1[v * np + 1] = p[1] + tv * g[1]; P1[v * np + 2] = p[2] + tv * g[2]; continue; }
        if (!side[v]) { const q = applyMat(M, p[0], p[1], p[2]); P1[v * np] = q[0]; P1[v * np + 1] = q[1]; P1[v * np + 2] = q[2]; continue; }
        const L = nbr.get(v); if (!L || !L.size) return null; const rp = rad(p); const R = Math.hypot(rp[0], rp[1], rp[2]); if (!(R > 1e-9)) return null;
        let best = null, bd = -2; for (const w of L) { const rw = rad(pos(w)); const lw = Math.hypot(rw[0], rw[1], rw[2]) || 1; const d = (rp[0] * rw[0] + rp[1] * rw[1] + rp[2] * rw[2]) / (R * lw); if (d > bd) { bd = d; best = w; } }
        const Mp = applyMat(M, p[0], p[1], p[2]), r = pos(best), Mr = applyMat(M, r[0], r[1], r[2]);
        const A0 = rad(Mp), B = rad([c[0] + (Mr[0] - Mp[0]), c[1] + (Mr[1] - Mp[1]), c[2] + (Mr[2] - Mp[2])]);
        const qa = B[0] * B[0] + B[1] * B[1] + B[2] * B[2], qb = 2 * (A0[0] * B[0] + A0[1] * B[1] + A0[2] * B[2]), qc = A0[0] * A0[0] + A0[1] * A0[1] + A0[2] * A0[2] - R * R;
        let sv; if (qa < 1e-18) { if (Math.abs(qc) > 1e-9 * R * R) return null; sv = 0; } else { const disc = qb * qb - 4 * qa * qc; if (disc < 0) return null; const r1 = (-qb + Math.sqrt(disc)) / (2 * qa), r2 = (-qb - Math.sqrt(disc)) / (2 * qa); sv = Math.abs(r1) < Math.abs(r2) ? r1 : r2; }
        const q = [Mp[0] + sv * (Mr[0] - Mp[0]), Mp[1] + sv * (Mr[1] - Mp[1]), Mp[2] + sv * (Mr[2] - Mp[2])]; const dh = (q[0] - p[0]) * a[0] + (q[1] - p[1]) * a[1] + (q[2] - p[2]) * a[2];
        P1[v * np] = p[0] + a[0] * dh; P1[v * np + 1] = p[1] + a[1] * dh; P1[v * np + 2] = p[2] + a[2] * dh; }   // straight along the side: it stays the same face
      if (!warpIsValid(P0, P1, TV, np)) return { ok: false };
      // Manifold re-sorts vertices on output, so the new positions go in by the old position's key
      const moveTo = new Map(); for (let v = 0; v < nv; v++) if (isW[v] || innerMove[v]) moveTo.set(key(P0[v * np], P0[v * np + 1], P0[v * np + 2]), [P1[v * np], P1[v * np + 1], P1[v * np + 2]]);
      let out = filled.warp(p => { const q = moveTo.get(key(p[0], p[1], p[2])); if (q) { p[0] = q[0]; p[1] = q[1]; p[2] = q[2]; } });
      if (!(out.volume() > 1e-12)) return { ok: false };
      const filledMoved = out;
      if (hollow) out = out.subtract(hollow);
      const res = clean(asOneRun(out));   // one run: which input a triangle came from must not split a face
      // a hole scaled or moved before keeps its history: it is cut again from this wall-scaled body with its hole filled,
      // so a later scale of the hole is still exact (and not taken for some unknown curved wall)
      if (pr && hollow) boreOrigin.set(res, { ...pr, base: { ...pr.base, man: filledMoved, solid: filledMoved } });
      return { ok: true, solid: res };
    }
    /** A hole's wall pushed along its normal by d (positive = into the material = a smaller hole); the hole keeps its axis. */
    function offsetHole(manifold, cyl, d) { const r2 = cyl.r - d; if (!(r2 > 1e-6)) throw new Error('That closes the hole'); const ext = (cyl.t1 - cyl.t0) * 2 + cyl.r * 4;
      const fill = cylSolid(cyl, cyl.r * (1 + 1e-6), cyl.t0 - 1e-5 * cyl.r, cyl.t1 + 1e-5 * cyl.r); return clean(manifold.add(fill).subtract(cylSolid(cyl, r2, cyl.t0 - ext, cyl.t1 + ext))); }
    /** Scale a flat face of a convex body about its centre (sx along the face's u, sy along v): the walls re-run to the new outline (a box top scaled → a truncated pyramid). */
    function scaleFaceConvex(manifold, md, faceId, sx, sy) {
      const hull = Manifold.hull([manifold]); if (Math.abs(hull.volume() - manifold.volume()) > 1e-4 * Math.max(1, manifold.volume())) return null;
      const F = faceFrame(md, faceId); if (!F || !F.loops || !F.loops.length) return null; const L = F.loops[0]; let cx = 0, cy = 0; for (const p of L) { cx += p[0] / L.length; cy += p[1] / L.length; }
      const keys = new Set(); for (const Lp of F.loops) for (const p of Lp) { const w = [F.origin[0] + p[0] * F.u[0] + p[1] * F.v[0], F.origin[1] + p[0] * F.u[1] + p[1] * F.v[1], F.origin[2] + p[0] * F.u[2] + p[1] * F.v[2]]; keys.add(fkey(w[0], w[1], w[2])); }
      const P = md.positions; const pts = []; for (let i = 0; i < P.length; i += 3) if (!keys.has(fkey(P[i], P[i + 1], P[i + 2]))) pts.push([P[i], P[i + 1], P[i + 2]]);
      for (const p of L) { const x = cx + (p[0] - cx) * sx, y = cy + (p[1] - cy) * sy; pts.push([F.origin[0] + x * F.u[0] + y * F.v[0], F.origin[1] + x * F.u[1] + y * F.v[1], F.origin[2] + x * F.u[2] + y * F.v[2]]); }
      const out = Manifold.hull(pts);
      if (!(out.volume() > 1e-9)) throw new Error('That scale flattens the body'); return clean(out);
    }
    /**
     * Offset Face on a convex body, exact at the corners: the body is rebuilt as the intersection of its (hull) face planes with the
     * chosen planes moved by d, so neighbouring faces stretch to meet (a box's 4 sides by 1 → 2 larger each way). Returns null when the
     * body is not convex (the caller then falls back to per-face prisms).
     */
    function offsetConvexFaces(manifold, moves) {
      const hull = Manifold.hull([manifold]); if (Math.abs(hull.volume() - manifold.volume()) > 1e-6 * Math.max(1, manifold.volume())) return null;
      const g = hull.getMesh(); const P = g.vertProperties, T = g.triVerts, np = g.numProp; const bb = manifold.boundingBox();
      const size = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1; const tol = 1e-5 * size; const planes = [];
      for (let i = 0; i < T.length; i += 3) { const a = T[i] * np, b = T[i + 1] * np, c = T[i + 2] * np;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz); if (l < 1e-12 * size * size) continue; nx /= l; ny /= l; nz /= l;
        const d = nx * P[a] + ny * P[a + 1] + nz * P[a + 2]; if (!planes.some(q => q.n[0] * nx + q.n[1] * ny + q.n[2] * nz > 1 - 1e-5 && Math.abs(q.d - d) < 50 * tol)) planes.push({ n: [nx, ny, nz], d }); }
      let hit = 0;
      for (const q of planes) for (const mv of moves) { if (q.n[0] * mv.n[0] + q.n[1] * mv.n[1] + q.n[2] * mv.n[2] > 1 - 1e-4 && Math.abs(q.n[0] * mv.p[0] + q.n[1] * mv.p[1] + q.n[2] * mv.p[2] - q.d) < 1e-3 * size) { q.d += mv.d; hit++; break; } }
      if (!hit) return null;
      const ext = size + moves.reduce((t, m) => t + Math.abs(m.d), 0); const c = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
      let out = Manifold.cube([ext * 4, ext * 4, ext * 4], true).translate(c);
      for (const q of planes) { out = out.trimByPlane([-q.n[0], -q.n[1], -q.n[2]], -q.d); if (!(out.volume() > 1e-12)) throw new Error('That offset collapses the body — use a smaller distance'); }
      const gm = out.getMesh(); const n0 = gm.numProp; const vp = new Float32Array(gm.numVert * 3);
      for (let i = 0; i < gm.numVert; i++) { vp[i * 3] = gm.vertProperties[i * n0]; vp[i * 3 + 1] = gm.vertProperties[i * n0 + 1]; vp[i * 3 + 2] = gm.vertProperties[i * n0 + 2]; }
      return clean(Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: vp, triVerts: new Uint32Array(gm.triVerts) })));
    }
    /** Offset Edge: the closed outlines grown (delta > 0) or shrunk (delta < 0) by |delta|, sharp corners kept (miter). */
    function offsetLoops(loops, delta) {
      const cs = new wasm.CrossSection(loops.map(l => l.map(p => [p[0], p[1]])), 'Positive');
      const out = cs.offset(delta, 'Miter', 4).toPolygons(); cs.delete && cs.delete();
      return out.map(poly => Array.from(poly, p => Array.isArray(p) ? [p[0], p[1]] : [p.x !== undefined ? p.x : p[0], p.y !== undefined ? p.y : p[1]]));
    }
    const serialize = m => { const g = m.getMesh(); return { vp: Array.from(g.vertProperties), tv: Array.from(g.triVerts) }; };
    const deserialize = s => clean(Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: new Float32Array(s.vp), triVerts: new Uint32Array(s.tv) })));   // saved bodies get their seam scraps removed on load
    /** Top-view outline of a solid as 2D polygons (exact projection). */
    function outline(manifold) { const cs = manifold.project(); const polys = cs.toPolygons(); cs.delete && cs.delete(); return polys; }
    return Object.assign({ name: 'Manifold engine', booleans: true, exactBooleans: true, batchUnion: list => (Manifold.union ? Manifold.union(list) : null), scaleWall, helix, fromTriangles, facesByID, sweep, loft, loftGuides, loftPlan, movePlanarFace, moveCylinderFace, boreFrame, filletEdges, shell, shellAny, offsetLoops, offsetConvexFaces, moveOuterCylinder, transformSurface, fitCylinder, moveHole, offsetHole, scaleFaceConvex, box, cylinder, sphere, extrude, revolve, extrudeRegions, outline, meshData, pushPull, clean, fuse, transformSolid, warpChecked, deformWarp, deformMesh, snapToBody, serialize, deserialize }, common);
  }

  // ======================================================= JavaScript engine (+ optional CSG)
  /** Indexed triangle mesh in world coordinates with a Manifold-like method set. */
  class MeshSolid {
    constructor(positions, indices) { this.positions = positions instanceof Float32Array ? positions : new Float32Array(positions); this.indices = indices instanceof Uint32Array ? indices : new Uint32Array(indices); if (signedVolume(this.positions, this.indices) < 0) this.flip(); }
    flip() { const I = this.indices; for (let t = 0; t < I.length; t += 3) { const tmp = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = tmp; } return this; }
    map(fn) { const P = new Float32Array(this.positions.length); for (let i = 0; i < P.length; i += 3) { const q = fn(this.positions[i], this.positions[i + 1], this.positions[i + 2]); P[i] = q[0]; P[i + 1] = q[1]; P[i + 2] = q[2]; } return new MeshSolid(P, this.indices.slice()); }
    translate(v) { return this.map((x, y, z) => [x + v[0], y + v[1], z + v[2]]); }
    scale(s) { return this.map((x, y, z) => [x * s, y * s, z * s]); }
    mirror(nrm) { const n = norm(nrm); return this.map((x, y, z) => { const d = 2 * (x * n[0] + y * n[1] + z * n[2]); return [x - d * n[0], y - d * n[1], z - d * n[2]]; }); }
    boundingBox() { const P = this.positions; const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { if (P[i + k] < min[k]) min[k] = P[i + k]; if (P[i + k] > max[k]) max[k] = P[i + k]; } return { min, max }; }
    volume() { return Math.abs(signedVolume(this.positions, this.indices)); }
    add(o) { return MeshSolid.boolean(this, o, 'union'); }
    subtract(o) { return MeshSolid.boolean(this, o, 'subtract'); }
    intersect(o) { return MeshSolid.boolean(this, o, 'intersect'); }
    static boolean(a, b, op) {
      const csg = MeshSolid.csg; if (!csg) throw new Error('Booleans need the geometry engine, which this browser blocked');
      const { THREE, Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } = csg;
      const geo = s => { const sh = shadedMesh(s.positions, s.indices, 40); const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(sh.positions, 3)); g.setAttribute('normal', new THREE.BufferAttribute(sh.normals, 3)); return g; };
      const ba = new Brush(geo(a)), bb = new Brush(geo(b)); ba.updateMatrixWorld(); bb.updateMatrixWorld();
      const ev = new Evaluator(); ev.attributes = ['position', 'normal'];
      const r = ev.evaluate(ba, bb, op === 'union' ? ADDITION : op === 'subtract' ? SUBTRACTION : INTERSECTION);
      const pos = r.geometry.getAttribute('position'); const arr = pos ? pos.array : new Float32Array(0);
      return MeshSolid.weld(arr);
    }
    /** Builds an indexed solid from unindexed triangle soup, merging coincident vertices. */
    static weld(P) {
      const map = new Map(); const out = []; const idx = new Uint32Array(P.length / 3);
      for (let i = 0; i < P.length / 3; i++) { const k = keyOf(P, i); let j = map.get(k); if (j === undefined) { j = out.length / 3; map.set(k, j); out.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); } idx[i] = j; }
      const I = []; for (let t = 0; t < idx.length; t += 3) if (idx[t] !== idx[t + 1] && idx[t + 1] !== idx[t + 2] && idx[t] !== idx[t + 2]) I.push(idx[t], idx[t + 1], idx[t + 2]);
      return new MeshSolid(new Float32Array(out), new Uint32Array(I));
    }
  }
  MeshSolid.csg = null;

  function JsCore(csg) {
    MeshSolid.csg = csg || null;
    function box(w, d, h, x = 0, y = 0) {
      const hx = w / 2, hy = d / 2; const P = [x - hx, y - hy, 0, x + hx, y - hy, 0, x + hx, y + hy, 0, x - hx, y + hy, 0, x - hx, y - hy, h, x + hx, y - hy, h, x + hx, y + hy, h, x - hx, y + hy, h];
      const I = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
      return new MeshSolid(P, I);
    }
    function cylinder(r, h, x = 0, y = 0) {
      const P = [], I = []; for (let i = 0; i < SEG; i++) { const t = 2 * Math.PI * i / SEG; P.push(x + r * Math.cos(t), y + r * Math.sin(t), 0, x + r * Math.cos(t), y + r * Math.sin(t), h); }
      const cb = P.length / 3; P.push(x, y, 0); const ct = cb + 1; P.push(x, y, h);
      for (let i = 0; i < SEG; i++) { const j = (i + 1) % SEG; I.push(2 * i, 2 * j, 2 * j + 1, 2 * i, 2 * j + 1, 2 * i + 1, cb, 2 * j, 2 * i, ct, 2 * i + 1, 2 * j + 1); }
      return new MeshSolid(P, I);
    }
    function sphere(r, x = 0, y = 0) {
      const st = SEG / 4, sl = SEG / 2; const P = [], I = []; const at = (j, i) => j * (sl + 1) + i;
      for (let j = 0; j <= st; j++) { const th = Math.PI * j / st; for (let i = 0; i <= sl; i++) { const ph = 2 * Math.PI * i / sl; P.push(x + r * Math.sin(th) * Math.cos(ph), y + r * Math.sin(th) * Math.sin(ph), r + r * Math.cos(th)); } }
      for (let j = 0; j < st; j++) for (let i = 0; i < sl; i++) { const a = at(j, i), b = at(j, i + 1), c = at(j + 1, i), d = at(j + 1, i + 1); if (j > 0) I.push(a, d, b); if (j < st - 1) I.push(a, c, d); }
      return MeshSolid.weld(unindex(P, I));
    }
    const unindex = (P, I) => { const out = new Float32Array(I.length * 3); for (let i = 0; i < I.length; i++) { out[i * 3] = P[I[i] * 3]; out[i * 3 + 1] = P[I[i] * 3 + 1]; out[i * 3 + 2] = P[I[i] * 3 + 2]; } return out; };
    /** Prism from a 2D CCW polygon at z in [0, h] (local frame). */
    function prismMesh(pts, h, topScale = 1, about = null) {
      const n = pts.length; const P = []; for (const p of pts) P.push(p[0], p[1], 0);
      const c = about || [0, 0]; for (const p of pts) P.push(c[0] + (p[0] - c[0]) * topScale, c[1] + (p[1] - c[1]) * topScale, h);
      const I = []; const caps = earClip(pts);
      for (let t = 0; t < caps.length; t += 3) { I.push(caps[t], caps[t + 2], caps[t + 1]); I.push(n + caps[t], n + caps[t + 1], n + caps[t + 2]); }
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; I.push(i, j, n + j, i, n + j, n + i); }
      return new MeshSolid(P, I);
    }
    function extrude(profile, height) {
      const pts = cleanProfile(profile); if (pts.length < 3) throw new Error('Profile needs at least 3 points');
      if (signedArea(pts) < 0) pts.reverse(); return prismMesh(pts, Math.abs(height));
    }
    function revolve(profile, degrees = 360) {
      const pts = cleanProfile(profile).map(p => [Math.max(0, p[0]), p[1]]); if (pts.length < 3) throw new Error('Profile needs at least 3 points');
      if (signedArea(pts) < 0) pts.reverse();
      const steps = SEG, full = Math.abs(degrees - 360) < 1e-9; const P = [];
      for (let i = 0; i < steps; i++) { const t = (degrees * Math.PI / 180) * i / steps; const c = Math.cos(t), s = Math.sin(t);
        for (let k = 0; k < pts.length; k++) { const p = pts[k], q = pts[(k + 1) % pts.length]; const j = (i + 1) % steps; const t2 = (degrees * Math.PI / 180) * (full ? j : i + 1) / steps; const c2 = Math.cos(t2), s2 = Math.sin(t2);
          const A = [p[0] * c, p[0] * s, p[1]], B = [q[0] * c, q[0] * s, q[1]], C2 = [q[0] * c2, q[0] * s2, q[1]], D = [p[0] * c2, p[0] * s2, p[1]];
          if (p[0] > 1e-9 || q[0] > 1e-9) { if (q[0] > 1e-9) P.push(...A, ...B, ...C2); if (p[0] > 1e-9) P.push(...A, ...C2, ...D); } } }
      let m = MeshSolid.weld(new Float32Array(P)); const b = m.boundingBox(); return m.translate([0, 0, -b.min[2]]);
    }
    function extrudeRegions(regions, height, draftDeg = 0) {
      const h = Math.abs(height), eps = 1e-4;
      return regions.map(r => {
        const outer = signedArea(r.outer) < 0 ? r.outer.slice().reverse() : r.outer; const { c } = regionShape(outer); const sc = draftScale(outer, h, draftDeg);
        let m = prismMesh(outer, h, sc, c);
        if (r.holes.length && MeshSolid.csg) for (const hole of r.holes) m = m.subtract(prismMesh(signedArea(hole) < 0 ? hole.slice().reverse() : hole, h + 2 * eps, sc, c).translate([0, 0, -eps]));
        return m;
      });
    }
    function meshData(solid) {
      const sh = shadedMesh(solid.positions, solid.indices, 40);
      const faceIdx = planarFaceIds(solid.positions, solid.indices);
      return finishMesh({ positions: sh.positions, normals: sh.normals, indices: sh.indices, faceID: faceIdx }, solid.positions, solid.indices);
    }
    const clean = s => s;
    const fuse = (host, tool, op) => op === 'cut' ? host.subtract(tool) : op === 'intersect' ? host.intersect(tool) : host.add(tool);
    function snapToBody(tool, target) { const bb = target.boundingBox(); const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1; const snap = vertexSnapper(target.positions, 1e-5 * diag); return tool.map((x, y, z) => snap(x, y, z) || [x, y, z]); }
    function transformSolid(solid, M) { return solid.map((x, y, z) => applyMat(M, x, y, z)); }
    function warpChecked(solid, M, test) {
      const out = solid.map((x, y, z) => test(x, y, z) ? applyMat(M, x, y, z) : [x, y, z]);
      return { solid: out, ok: warpIsValid(solid.positions, out.positions, out.indices, 3) };
    }
    function deformWarp(solid, md, M, test, opts = {}) {
      const dm = deformMesh(md, M, test, opts); if (!dm) return warpChecked(solid, M, test);
      if (!dm.ok || !warpIsValid(dm.P0, dm.P1, dm.indices, 3)) return { solid, ok: false };
      const out = new MeshSolid(Float32Array.from(dm.P1), dm.indices); return out.volume() > 1e-12 ? { solid: out, ok: true } : warpChecked(solid, M, test);
    }
    function pushPull(solid, md, faceId, distance, opts = {}) {
      if (opts.draft) {
        const keys = faceVertexKeys(md, faceId); const test = (x, y, z) => keys.has(fkey(x, y, z)); const M = draftMatrix(md, faceId, distance, opts.draft);
        const w = deformWarp(solid, md, M, test, opts); if (w.ok) return w.solid;
        throw new Error("Operation failed because the resulting body wouldn't be valid");
      }
      if (Math.abs(distance) < 1e-6) return solid;
      const f0 = faceFrame(md, faceId); const keys = faceVertexKeys(md, faceId); const test = (x, y, z) => keys.has(fkey(x, y, z)); const M = offsetMatrix(f0.n, distance);
      const w = deformWarp(solid, md, M, test, opts) || warpChecked(solid, M, test); if (w.ok) return w.solid;
      if (!MeshSolid.csg) throw new Error('Push/pull needs the boolean engine, which this browser blocked');
      const f = f0; const eps = 1e-4, d = Math.abs(distance);
      const loops = f.loops.map(l => signedArea(l) < 0 ? l.slice().reverse() : l).map(l => ({ l, area: Math.abs(signedArea(l)) }));
      loops.sort((a, b) => b.area - a.area);
      let prism = prismMesh(loops[0].l, d + eps).translate([0, 0, distance > 0 ? -eps : -d]);
      for (let i = 1; i < loops.length; i++) prism = prism.subtract(prismMesh(loops[i].l, d + 4 * eps).translate([0, 0, distance > 0 ? -2 * eps : -d - 2 * eps]));
      const placed = prism.map((x, y, z) => frameToWorld(f, x, y, z));
      return distance > 0 ? solid.add(placed) : solid.subtract(placed);
    }
    const serialize = s => ({ vp: Array.from(s.positions), tv: Array.from(s.indices) });
    const deserialize = s => new MeshSolid(new Float32Array(s.vp), new Uint32Array(s.tv));
    const outline = () => null; // exact 2D projection needs the Manifold engine
    return Object.assign({ name: csg ? 'JavaScript engine + CSG booleans' : 'JavaScript engine (no booleans)', booleans: !!csg, exactBooleans: false, box, cylinder, sphere, extrude, revolve, extrudeRegions, outline, meshData, pushPull, clean, fuse, transformSolid, warpChecked, deformWarp, deformMesh, snapToBody, serialize, deserialize, MeshSolid }, common);
  }

  root.CadCore = { ManifoldCore, JsCore, MeshSolid };
})(typeof window !== 'undefined' ? window : globalThis);