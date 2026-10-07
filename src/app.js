// SolidSketch Web — touch-first CAD app. Runs after core.js and the Manifold module have loaded.
(async function () {
  const $ = id => document.getElementById(id);
  addEventListener('error', e => { const l = $('loading'); const msg = (e && e.message) || 'Unknown error'; if (l) l.textContent = 'Something went wrong while starting: ' + msg; else if (typeof toast === 'function') toast('Error: ' + msg, 4000); });
  addEventListener('unhandledrejection', e => { const l = $('loading'); const r = e && e.reason; const msg = (r && r.message) || String(r); if (l) l.textContent = 'Something went wrong while starting: ' + msg; });
  const toastEl = $('toast'); let toastTimer;
  const toast = (msg, ms = 2600) => { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms); };

  // ---------- geometry engine (three tiers, so the app always opens) ----------
  const stage = t => { const l = $('loading'); if (l) l.textContent = t; };
  const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' did not start within ' + ms / 1000 + ' s')), ms))]);
  let C = null; const diag = [];
  try {
    stage('Starting geometry engine…');
    if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly is not available in this browser');
    if (typeof window.__ManifoldModule !== 'function') throw new Error('Engine script did not load');
    const wEl = $('wasm-b64'); const b64 = wEl.textContent.trim();
    let bin = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
    if (wEl.dataset.gz) {   // stored gzipped to keep the page small
      if (window.__DWG && window.__DWG.pako) bin = window.__DWG.pako.ungzip(bin);
      else bin = new Uint8Array(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    }
    const wasm = await withTimeout(window.__ManifoldModule({ wasmBinary: bin }), 20000, 'Manifold');
    wasm.setup();
    C = window.CadCore.ManifoldCore(wasm);
  } catch (e) { diag.push('Manifold: ' + ((e && e.message) || e)); }
  if (!C) {
    stage('Starting fallback engine…');
    const csg = (window.__CSG && typeof window.__CSG.Brush === 'function') ? window.__CSG : null;
    if (!csg) diag.push('CSG library missing');
    C = window.CadCore.JsCore(csg);
  }
  if (typeof THREE === 'undefined') { stage('The 3D renderer failed to initialise in this browser.'); return; }
  const loadingEl = $('loading'); if (loadingEl) loadingEl.remove();
  $('engine').textContent = C.name;
  $('diag').textContent = (diag.length ? 'Engine notes: ' + diag.join(' · ') : 'Engine: ' + C.name) + ' · DWG reader: ' + (window.__DWG && typeof WebAssembly !== 'undefined' ? 'available (loads on first import)' : 'unavailable in this browser; DXF still works');
  if (!C.booleans) setTimeout(() => toast('Booleans and push/pull are off: this browser blocked the geometry engine. Everything else works.', 5000), 600);
  else if (diag.length) setTimeout(() => toast('Running on the ' + C.name), 600);

  // ---------- theme ----------
  const dark = () => !(document.documentElement.dataset.theme === 'light') && (document.documentElement.dataset.theme === 'dark' || matchMedia('(prefers-color-scheme: dark)').matches);

  // ---------- three.js scene ----------
  const canvas = $('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, logarithmicDepthBuffer: true });   // precise depth at any zoom
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20000);
  camera.up.set(0, 0, 1);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4250, 2.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(6, -9, 14); scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.8); fill.position.set(-8, 6, 4); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.55); rim.position.set(-3, 9, 7); scene.add(rim);   // back light: separates a body from the grid
  /** Body shading: soft plastic-like highlight; polygon offset keeps the feature edges from z-fighting with the faces. */
  // ---------- Materials (Shapr3D Visualization, kettle video 10:10 and 19:20) ----------
  const MATS = {
    chrome: { name: 'Chrome', color: 0xe8ebef, metalness: 1, roughness: 0.06 },
    steel: { name: 'Brushed steel', color: 0xc9ced4, metalness: 1, roughness: 0.32 },
    gold: { name: 'Gold', color: 0xe0b54a, metalness: 1, roughness: 0.18 },
    black: { name: 'Matte black', color: 0x1f2328, metalness: 0, roughness: 0.85 },
    red: { name: 'Red plastic', color: 0xc8202a, metalness: 0, roughness: 0.28 },
    white: { name: 'White plastic', color: 0xf2f2f0, metalness: 0, roughness: 0.35 },
  };
  let envTexCache = null;
  /** A soft studio for reflections: bright ceiling and side panels over a grey floor, pre-filtered for metals. */
  function envTex() {
    if (envTexCache) return envTexCache;
    const es = new THREE.Scene(); const sky = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true }));
    const pos = sky.geometry.attributes.position, cols = []; for (let i = 0; i < pos.count; i++) { const y = pos.getY(i) / 50; const c = y > 0 ? 0.55 + 0.45 * y : 0.18 + 0.37 * (1 + y); cols.push(c, c, c * 1.02); }
    sky.geometry.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3)); es.add(sky);
    const panel = (w, h, x, y, z, ry, rx) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })); m.position.set(x, y, z); m.rotation.set(rx || 0, ry || 0, 0); es.add(m); };
    panel(30, 8, 0, 40, 0, 0, Math.PI / 2); panel(8, 30, -40, 10, 0, Math.PI / 2); panel(6, 26, 38, 8, -10, -Math.PI / 2); panel(20, 6, 0, 12, 42, Math.PI);
    const pm = new THREE.PMREMGenerator(renderer); envTexCache = pm.fromScene(es, 0.02).texture; pm.dispose(); return envTexCache;
  }
  const bodyMaterial = (color, mt) => { const M = mt && MATS[mt];
    const m = M ? new THREE.MeshStandardMaterial({ color, metalness: M.metalness, roughness: M.roughness, envMap: envTex(), envMapIntensity: 1.15, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
      : new THREE.MeshPhongMaterial({ color, shininess: 48, specular: 0x3c3c3c, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    m.userData.mt = M ? mt : ''; return m; };
  // Edge lines are drawn a hair in front of the faces they lie on (in depth only, so they never shift on screen): at the
  // faces' exact depth a curved wall hides parts of them and a smooth edge reads as a broken, dashed one
  /** Draws a highlight a hair in front of the face it covers (depth only): an exact body is shown from a finer mesh than
   *  the one the highlight is cut from, and without this the two would fight and the highlight would look speckled. */
  function frontBias(m, k) { m.onBeforeCompile = sh => { sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  gl_Position.z -= ' + k.toExponential() + ' * gl_Position.w;'); }; m.customProgramCacheKey = () => 'front-' + k; return m; }
  const edgeMaterial = () => { const m = new THREE.LineBasicMaterial({ color: dark() ? 0x0d0f13 : 0x262b34 });
    m.onBeforeCompile = sh => { sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  gl_Position.z -= 6e-5 * gl_Position.w;'); }; m.customProgramCacheKey = () => 'edge-front'; return m; };
  /**
   * The edges as drawn: each run of segments that meet end to end (an outline, a seam) is one chain, and a chain is rounded
   * by corner cutting (Chaikin, 3 rounds) wherever it turns gently — so a curved edge reads as one smooth line, not a row
   * of short straight pieces. Real corners (a turn of more than 35°) and the ends of a chain stay exactly where they are.
   * Drawing only: the body itself is not changed.
   */
  function smoothEdgeLines(E) {
    const n = E.length / 6; if (n < 3) return E; const key = i => E[i].toFixed(4) + ',' + E[i + 1].toFixed(4) + ',' + E[i + 2].toFixed(4);
    const pts = new Map(), adj = new Map(); const add = (k, i) => { if (!pts.has(k)) { pts.set(k, [E[i], E[i + 1], E[i + 2]]); adj.set(k, []); } };
    for (let s = 0; s < n; s++) { const a = key(s * 6), b = key(s * 6 + 3); if (a === b) continue; add(a, s * 6); add(b, s * 6 + 3); adj.get(a).push(b); adj.get(b).push(a); }
    const used = new Set(); const ek = (a, b) => a < b ? a + '|' + b : b + '|' + a; const chains = [];
    const walk = (start, next) => { const c = [start]; let prev = start, cur = next; used.add(ek(start, next));
      while (true) { c.push(cur); const nb = adj.get(cur); if (nb.length !== 2 || cur === start) break; const nx = nb[0] === prev ? nb[1] : nb[0]; if (used.has(ek(cur, nx))) break; used.add(ek(cur, nx)); prev = cur; cur = nx; } return c; };
    for (const [k, nb] of adj) if (nb.length !== 2) for (const m of nb) if (!used.has(ek(k, m))) chains.push(walk(k, m));   // open chains from their ends
    for (const [k, nb] of adj) for (const m of nb) if (!used.has(ek(k, m))) chains.push(walk(k, m));   // closed loops
    const cosCorner = Math.cos(35 * Math.PI / 180); const out = [];
    for (const c of chains) { let P = c.map(k => pts.get(k)); const closed = c.length > 3 && c[0] === c[c.length - 1];
      for (let r = 0; r < 3 && P.length >= 3; r++) { const Q = []; const m = P.length; const last = closed ? m - 1 : m;
        const corner = i => { if (!closed && (i === 0 || i === m - 1)) return true; const a = P[(i - 1 + last) % last], b = P[i % last], d = P[(i + 1) % last]; const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - b[0], d[1] - b[1], d[2] - b[2]]; const lu = Math.hypot(u[0], u[1], u[2]), lv = Math.hypot(v[0], v[1], v[2]); if (!lu || !lv) return true; return (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv) < cosCorner; };
        const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        if (!closed) Q.push(P[0]);
        for (let i = 0; i < last - (closed ? 0 : 1); i++) { const a = P[i], b = P[(i + 1) % last]; const ca = corner(i), cb = corner((i + 1) % last);
          if (closed || i > 0 || true) { if (ca) { if (!(i === 0 && !closed)) Q.push(a); } else Q.push(lerp(a, b, 0.25)); }
          if (cb) { /* the corner itself is pushed when it starts the next segment */ } else Q.push(lerp(a, b, 0.75)); }
        if (!closed) Q.push(P[m - 1]); else Q.push(Q[0]);
        P = Q; }
      for (let i = 0; i + 1 < P.length; i++) out.push(P[i][0], P[i][1], P[i][2], P[i + 1][0], P[i + 1][1], P[i + 1][2]); }
    return new Float32Array(out);
  }
  const CIRCLE_SEG = 96; // sketch circles: 3.75° per facet, drawn smooth
  const BOOL_EPS = C.exactBooleans ? 0 : 1e-4; // overlap given to tool bodies before a boolean: none for the exact engine (coplanar faces fuse cleanly), a hair for the mesh fallback
  /**
   * How far a cut tool must reach back past its sketch plane so that no skin of the body is left over the pocket (the
   * circle's face that "never disappears"). A face's frame is read from single-precision mesh data while the body itself is
   * double precision, so a plane drawn on a face can land a few millionths of a unit *inside* it (a height such as 42.3 is
   * stored as 42.29999924). A cut that starts exactly on that plane then leaves a paper-thin lid over the pocket. Only when the
   * body really has such a thin skin behind the plane (material within a hair of it, none just beyond) is the tool lengthened
   * backwards by a hair; a plane on, above or deep inside the body is left exactly as it was.
   * mk(len) → the profile's local solids spanning z ∈ [0, len]; backSign +1 = back along the plane normal, -1 = against it.
   */
  function skinReach(hostMan, mk, frame, backSign) {
    if (!hostMan || !C.booleans) return 0;
    const made = [];
    try {
      const bb = hostMan.boundingBox(); const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1;
      const tol = Math.max(1e-6, 2e-4 * diag);
      const probe = from => { let ov = 0, tv = 0;
        for (const l of mk(tol)) { const p = C.placeInFrame(backSign > 0 ? l.translate([0, 0, from]) : l.mirror([0, 0, 1]).translate([0, 0, -from]), frame); made.push(p); tv += p.volume(); const ix = hostMan.intersect(p); ov += ix.volume(); freeMan(ix); }
        return { ov, tv }; };
      const near = probe(0), beyond = probe(tol);
      return (near.ov > 1e-9 * near.tv && beyond.ov <= 1e-6 * beyond.tv) ? tol * 1.5 : 0;
    } catch (e) { return 0; }
    finally { for (const m of made) freeMan(m); }
  }

  const gridGroup = new THREE.Group(); scene.add(gridGroup);   // the drawing grid: follows the active sketch plane
  const axesGroup = new THREE.Group(); scene.add(axesGroup);   // world axes: fixed
  // Infinite grid: one huge plane shaded procedurally in the sketch plane's own coordinates, with
  // three line weights (1, 10 and 100 units plus a faint 0.5 snap grid) that fade out as they get denser or farther away.
  const gridMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uMinor: { value: new THREE.Color(0xcfd4dc) }, uMajor: { value: new THREE.Color(0xa9b1bd) }, uCamPos: { value: new THREE.Vector3() }, uFade: { value: 300 }, uStep: { value: 1.0 }, uOrigin: { value: new THREE.Vector3() }, uU: { value: new THREE.Vector3(1, 0, 0) }, uV: { value: new THREE.Vector3(0, 1, 0) } },
    vertexShader: `#include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vLocal; varying vec3 vWorld; uniform vec3 uOrigin; uniform vec3 uU; uniform vec3 uV;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; vec3 r = w.xyz - uOrigin; vLocal = vec2(dot(r, uU), dot(r, uV)); gl_Position = projectionMatrix * viewMatrix * w;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `#include <logdepthbuf_pars_fragment>
      varying vec2 vLocal; varying vec3 vWorld; uniform vec3 uMinor; uniform vec3 uMajor; uniform vec3 uCamPos; uniform float uFade; uniform float uStep;
      float gridLine(vec2 p, float stepSize) {
        vec2 q = p / stepSize; vec2 dq = fwidth(q);
        float lod = clamp(1.0 - max(dq.x, dq.y) * 2.5, 0.0, 1.0);
        vec2 g = abs(fract(q - 0.5) - 0.5) / dq; float l = min(g.x, g.y);
        return (1.0 - min(l, 1.0)) * lod;
      }
      void main() {
        #include <logdepthbuf_fragment>
        float fine = gridLine(vLocal, uStep * 0.5) * 0.28; float unit = gridLine(vLocal, uStep) * 0.6; float ten = gridLine(vLocal, uStep * 10.0) * 0.9; float hundred = gridLine(vLocal, uStep * 100.0) * 1.0;
        float d = distance(vWorld, uCamPos); float fade = 1.0 - smoothstep(uFade * 0.2, uFade, d);
        float a = max(max(fine, unit), max(ten, hundred)) * fade;
        vec3 col = (ten > unit || hundred > unit) ? uMajor : uMinor;
        if (a < 0.004) discard;
        gl_FragColor = vec4(col, a);
      }`
  });
  const gridMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), gridMat); gridMesh.renderOrder = -1; gridMesh.frustumCulled = false; gridGroup.add(gridMesh);
  function buildGrid() {
    axesGroup.clear();
    const d = dark();
    gridMat.uniforms.uMinor.value.setHex(d ? 0x2e333c : 0xcfd4dc); gridMat.uniforms.uMajor.value.setHex(d ? 0x434a56 : 0xa3abb8);
    const ax = (from, to, color) => { const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...from), new THREE.Vector3(...to)]); axesGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color }))); };
    const L = 1;
    ax([-L, 0, 0], [L, 0, 0], 0xd9605f); ax([0, -L, 0], [0, L, 0], 0x67bd6b); ax([0, 0, 0], [0, 0, L], 0x5c9eed);
    renderer.setClearColor(d ? 0x1c1e23 : 0xeef1f5);
  }
  const basisQuat = f => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.u), new THREE.Vector3(...f.v), new THREE.Vector3(...f.n)));
  /** Moves the drawing grid onto the active sketch plane (world XY when none is chosen). */
  // the grid lies on the sketch plane only while a sketch tool is active; in Select and Move/Rotate it is the fixed ground grid, so
  // moving or turning a sketch never drags the grid along with it
  function syncGrid() { const f = isSketchTool(S.tool) ? plane() : { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] }; gridGroup.position.set(f.origin[0], f.origin[1], f.origin[2]); gridGroup.quaternion.copy(basisQuat(f)); gridMat.uniforms.uOrigin.value.set(f.origin[0], f.origin[1], f.origin[2]); gridMat.uniforms.uU.value.set(f.u[0], f.u[1], f.u[2]); gridMat.uniforms.uV.value.set(f.v[0], f.v[1], f.v[2]); }

  // ---------- sketch-plane picker: the three principal planes at the origin ----------
  const PRINCIPAL = {
    top: { key: 'top', name: 'Top (horizontal)', origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
    front: { key: 'front', name: 'Front (elevation)', origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] },
    side: { key: 'side', name: 'Side (elevation)', origin: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0] },
  };
  const pickerGroup = new THREE.Group(); scene.add(pickerGroup);
  const pickerCards = [];
  for (const f of Object.values(PRINCIPAL)) {
    const sz = 6;
    const card = new THREE.Mesh(new THREE.PlaneGeometry(sz, sz), new THREE.MeshBasicMaterial({ color: 0x7f92b3, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
    card.quaternion.copy(basisQuat(f)); card.position.set((f.u[0] + f.v[0]) * sz / 2, (f.u[1] + f.v[1]) * sz / 2, (f.u[2] + f.v[2]) * sz / 2);
    card.userData.key = f.key; card.renderOrder = 5;
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(card.geometry), new THREE.LineBasicMaterial({ color: 0x7f92b3, transparent: true, opacity: 0.8 }));
    edge.quaternion.copy(card.quaternion); edge.position.copy(card.position);
    pickerGroup.add(card, edge); pickerCards.push(card);
  }
  function syncPicker() { pickerGroup.visible = isSketchTool(S.tool) && !S.plane && !S.imported; }
  buildGrid();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { buildGrid(); requestRender(); });

  // Orbit camera, Z up
  const cam = { target: new THREE.Vector3(0, 0, 1.5), dist: 28, yaw: -0.9, pitch: 0.5 };
  let sceneBoundsKey = null, sceneBoundsVal = null;
  /** Centre and radius of everything in the scene (bodies and profiles), cached per change; null when empty. */
  let bodyBoxKey = null, bodyBoxVal = [];
  /** Each body's (and profile's) bounding box, cached per bodies list. */
  function bodyBoxes() {
    if (bodyBoxKey === S.bodies && bodyBoxVal.p === S.profiles) return bodyBoxVal;
    const out = S.bodies.map(b => { const bb = b.man.boundingBox(); return { min: bb.min, max: bb.max }; });
    for (const q of S.profiles || []) { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (const p of q.outer) { const w = C.frameToWorld(q.frame, p[0], p[1], 0); for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], w[k]); mx[k] = Math.max(mx[k], w[k]); } } out.push({ min: mn, max: mx }); }
    bodyBoxKey = S.bodies; out.p = S.profiles; bodyBoxVal = out; return out;
  }
  function sceneBounds() {
    if (sceneBoundsKey === S.bodies && sceneBoundsVal && sceneBoundsVal.p === S.profiles && sceneBoundsVal.pa === S.paths && sceneBoundsVal.sl === S.sketchLines && sceneBoundsVal.sk === S.sketch && sceneBoundsVal.pl === S.plane) return sceneBoundsVal.b;
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; const add = q => { for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], q[k]); mx[k] = Math.max(mx[k], q[k]); } };
    for (const b of S.bodies) { const bb = b.man.boundingBox(); add(bb.min); add(bb.max); }
    for (const q of S.profiles || []) for (const p of q.outer) add(C.frameToWorld(q.frame, p[0], p[1], 0));
    for (const q of S.paths || []) for (const p of q.pts) add(C.frameToWorld(q.frame, p[0], p[1], 0));
    for (const [a2, b2] of (typeof sketchSegments === 'function' ? sketchSegments() : [])) { add(C.frameToWorld(S.plane || C.GROUND, a2[0], a2[1], 0)); add(C.frameToWorld(S.plane || C.GROUND, b2[0], b2[1], 0)); }
    const b = isFinite(mn[0]) ? { c: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2], r: Math.max(1e-9, Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2), min: mn, max: mx } : null;
    sceneBoundsKey = S.bodies; sceneBoundsVal = { b, p: S.profiles, pa: S.paths, sl: S.sketchLines, sk: S.sketch, pl: S.plane }; return b;
  }
  function updateCamera() {
    // near follows the zoom; far always reaches past the farthest body (zoomed right in, nothing else may be cut away)
    const cp0 = Math.cos(cam.pitch); const cx = cam.target.x + cam.dist * cp0 * Math.cos(cam.yaw), cy = cam.target.y + cam.dist * cp0 * Math.sin(cam.yaw), cz = cam.target.z + cam.dist * Math.sin(cam.pitch);
    const sb = sceneBounds(); const toScene = sb ? Math.hypot(sb.c[0] - cx, sb.c[1] - cy, sb.c[2] - cz) + sb.r : 0;
    // near: at most half the way to the nearest body or profile (box), so nothing in front of the camera is ever sliced away
    // (the orbit centre, and so cam.dist, can lie far behind what is right in front of the camera); the log depth buffer keeps
    // a small near plane precise
    let dBox = Infinity, inside = false;
    const boxDist = (mn, mx) => { const dx = Math.max(mn[0] - cx, 0, cx - mx[0]), dy = Math.max(mn[1] - cy, 0, cy - mx[1]), dz = Math.max(mn[2] - cz, 0, cz - mx[2]); const d = Math.hypot(dx, dy, dz); if (d === 0) inside = true; return d; };
    for (const bx of bodyBoxes()) dBox = Math.min(dBox, boxDist(bx.min, bx.max));
    let near = Math.max(1e-12, cam.dist * 0.002);
    if (sb) { const floor = sb.r * 1e-7; if (inside) near = Math.max(floor, Math.min(near, sb.r * 1e-4, cam.dist * 1e-3)); else if (isFinite(dBox)) near = Math.max(floor, Math.min(near, dBox * 0.5)); }
    const far = Math.max(cam.dist * 3000, toScene * 1.5, cam.dist * 14 * 1.2, 1e-6);
    if (Math.abs(camera.near - near) / near > 0.2 || Math.abs(camera.far - far) / far > 0.2) { camera.near = near; camera.far = far; camera.updateProjectionMatrix(); }
    const cp = Math.cos(cam.pitch);
    camera.position.set(cam.target.x + cam.dist * cp * Math.cos(cam.yaw), cam.target.y + cam.dist * cp * Math.sin(cam.yaw), cam.target.z + cam.dist * Math.sin(cam.pitch));
    camera.lookAt(cam.target);
  }
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
  }
  let renderQueued = false;
  function requestRender() { try { if (X.on) xScheduleRefine(); } catch (e) { /* not set up yet */ } if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; resize(); try { syncSection(); } catch (e) { /* drawing goes on without it */ } updateCamera(); camera.updateMatrixWorld(); camera.matrixWorldInverse.copy(camera.matrixWorld).invert(); gridMat.uniforms.uCamPos.value.copy(camera.position); gridMat.uniforms.uFade.value = Math.max(0.01, cam.dist * 14); gridMat.uniforms.uStep.value = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, cam.dist / 20)))); const gs = Math.max(1, cam.dist * 400); gridMesh.scale.set(gs, gs, 1); axesGroup.scale.set(gs, gs, gs); syncGizmo(); renderer.render(scene, camera); updateOverlays(); }); } }
  addEventListener('resize', requestRender);

  // ---------- document ----------
  const PALETTE = [0x5c9eed, 0xf28c4c, 0x73cc8c, 0xcc80d9, 0xe6bf59, 0x66c7cc];
  const S = { paths: [], selPath: null, nextPathId: 1, profiles: [], selProfiles: [], nextProfileId: 1, tool: 'select', bodies: [], selectedId: null, selectedFace: null, sketch: [], sketchClosed: false, pendingBool: null, faceTool: false, faceOp: 'stretch', scaleTool: false, value: 1, plane: null, imported: null, sketchLines: [], lineStart: null, lastSnap: null, flip: false, drawing: null, lastLine: -1, circle: null, selRegion: -1, selVertex: null, fingerDraws: true, unit: 'mm', snapTip: null, snap: true, nextId: 1, colorIdx: 0, height: 4, moveSurf: null, moveCopy: false, moveAxis: 2, moveTyped: 1 };
  const objects = new Map(); // body id -> {mesh, lines, faceMesh}
  const selected = () => S.bodies.find(b => b.id === S.selectedId) || null;

  function makeBodyRecord(name, man) {
    const md = C.meshData(man);
    return { id: S.nextId++, name: `${name} ${S.nextId - 1}`, color: PALETTE[S.colorIdx++ % PALETTE.length], man, md };
  }
  function geometryOf(md) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(md.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(md.normals, 3));
    g.setIndex(new THREE.BufferAttribute(md.indices, 1));
    return g;
  }
  function syncScene() {
    if (typeof syncProfCentres === 'function') try { syncProfCentres(); } catch (e) { /* keep drawing the rest */ }
    if (typeof syncCircleCentres === 'function') try { syncCircleCentres(); } catch (e) { /* keep drawing the rest */ }
    if (typeof syncProfiles === 'function') try { syncProfiles(); } catch (e) { /* keep drawing the rest */ }
    if (typeof syncPaths === 'function') try { syncPaths(); } catch (e) { /* keep drawing the rest */ }
    const live = new Set();
    for (const b of S.bodies) {
      live.add(b.id);
      let o = objects.get(b.id);
      if (!o || o.md !== b.md || o.mesh.material.userData.mt !== (b.material || '')) {
        if (o) disposeObj(o);
        const mesh = new THREE.Mesh(geometryOf(b.md), bodyMaterial(b.color, b.material));
        const lg = new THREE.BufferGeometry(); let ePos = b.md.edges; try { ePos = smoothEdgeLines(b.md.edges); } catch (e) { ePos = b.md.edges; } lg.setAttribute('position', new THREE.BufferAttribute(ePos, 3));
        const lines = new THREE.LineSegments(lg, edgeMaterial());
        scene.add(mesh); scene.add(lines);
        o = { md: b.md, mesh, lines, faceMesh: null, faceId: null }; objects.set(b.id, o);
      }
      const sel = b.id === S.selectedId;
      // a selected body shows as a whole in cyan (its own colour comes back when deselected); a face pick keeps the body colour
      { const faceSel = S.selectedFace != null || S.faceTool || (S.tool === 'move' && S.moveSurf != null);   // a face is the selection: the body keeps its own colour, only the face is blue
      o.mesh.material.color.setHex(sel && !faceSel ? 0x38bdf0 : b.color); o.mesh.material.emissive.setHex(sel && !faceSel ? 0x143a4a : 0x000000); }
      syncFaceHighlight(b, o, sel);
    }
    for (const [id, o] of objects) if (!live.has(id)) { disposeObj(o); objects.delete(id); }
    syncGrid(); syncPicker(); syncSketch(); syncRegions();
    placeSelSegBand();
    try { xtSync(); } catch (e) { /* v22 overlays */ }
    selVertexPt.geometry.dispose(); selVertexPt.geometry = new THREE.BufferGeometry().setFromPoints(S.selVertex && S.tool === 'edit' ? [new THREE.Vector3(...to3(S.selVertex, 0.04))] : []); selVertexPt.visible = !!S.selVertex && S.tool === 'edit';
    renderUI();
    requestRender();
  }
  /**
   * Section view (Shapr3D's): every body is cut by a plane through the origin and the cut shows in orange — the inside of the
   * walls seen through the cut (back faces) is drawn flat orange, which reads as the section face. It is a view only.
   */
  const SECTION_PLANES = [{ name: 'Top', n: [0, 0, -1] }, { name: 'Front', n: [0, 1, 0] }, { name: 'Side', n: [-1, 0, 0] }];
  const secMeshes = new Map(); let secPlane = null;
  function toggleSection() { S.section = S.section == null ? 0 : S.section + 1 < SECTION_PLANES.length ? S.section + 1 : null; const m = $('m-section'); if (m) m.textContent = 'Section view: ' + (S.section == null ? 'off' : SECTION_PLANES[S.section].name); toast(S.section == null ? 'Section view off' : 'Section view · cut by the ' + SECTION_PLANES[S.section].name + ' plane (⋮ again for the next plane)'); requestRender(); }
  function syncSection() {
    const on = S.section != null; if (on) { const n = SECTION_PLANES[S.section].n; if (!secPlane) secPlane = new THREE.Plane(); secPlane.set(new THREE.Vector3(n[0], n[1], n[2]), 0); }
    renderer.localClippingEnabled = on; const clip = on ? [secPlane] : null;
    for (const [id, o] of objects) { if (o.mesh.material.clippingPlanes !== clip) { o.mesh.material.clippingPlanes = clip; o.mesh.material.needsUpdate = true; o.lines.material.clippingPlanes = clip; o.lines.material.needsUpdate = true; if (o.faceMesh) { o.faceMesh.material.clippingPlanes = clip; o.faceMesh.material.needsUpdate = true; } }
      let sm = secMeshes.get(id); if (on) { if (!sm) { sm = new THREE.Mesh(o.mesh.geometry, new THREE.MeshBasicMaterial({ color: 0xe8954a, side: THREE.BackSide, clippingPlanes: [secPlane] })); secMeshes.set(id, sm); scene.add(sm); } if (sm.geometry !== o.mesh.geometry) sm.geometry = o.mesh.geometry; sm.material.clippingPlanes = [secPlane]; sm.visible = o.mesh.visible; }
      else if (sm) { scene.remove(sm); sm.material.dispose(); secMeshes.delete(id); } }
    for (const [id, sm] of secMeshes) if (!objects.has(id)) { scene.remove(sm); sm.material.dispose(); secMeshes.delete(id); }
  }
  /** Face highlight: the whole smooth surface the tapped face belongs to (a cylinder wall lights up as one face). */
  function syncFaceHighlight(b, o, sel) {
    let wantSurf = null;
    if (sel && S.tool === 'move' && S.moveSurf != null) wantSurf = S.moveSurf;
    else if (sel && S.tool === 'select' && S.selectedFace != null) wantSurf = C.surfOfFace(b.md, S.selectedFace);
    if (o.faceId === wantSurf && o.faceMd === b.md) return;
    if (o.faceMesh) { scene.remove(o.faceMesh); o.faceMesh.geometry.dispose(); o.faceMesh = null; }
    if (wantSurf != null && b.md.surfID) {
      const sub = []; const { indices, surfID } = b.md;
      for (let t = 0; t < surfID.length; t++) if (surfID[t] === wantSurf) sub.push(indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]);
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(b.md.positions, 3)); g.setIndex(new THREE.BufferAttribute(new Uint32Array(sub), 1));
      if (b.md.normals) g.setAttribute('normal', new THREE.BufferAttribute(b.md.normals, 3));
      // Plasticity: the selected face turns blue, and the parts of it hidden behind the body show through (x-ray)
      o.faceMesh = new THREE.Mesh(g, frontBias(new THREE.MeshStandardMaterial({ color: 0x1ea7d8, roughness: 0.45, metalness: 0.05, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), 2.5e-4));
      const xray = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x5cc8ee, transparent: true, opacity: 0.38, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
      xray.renderOrder = 15; o.faceMesh.add(xray);
      scene.add(o.faceMesh);
    }
    o.faceId = wantSurf; o.faceMd = b.md;
  }
  function disposeObj(o) { scene.remove(o.mesh, o.lines); o.mesh.geometry.dispose(); o.lines.geometry.dispose(); if (o.faceMesh) { scene.remove(o.faceMesh); o.faceMesh.geometry.dispose(); } }

  // Sketch overlay
  const sketchLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x3d7bff, depthTest: false })); sketchLine.renderOrder = 10; scene.add(sketchLine);
  const sketchPts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0x2f6fed, size: 9, sizeAttenuation: false, depthTest: false })); sketchPts.renderOrder = 11; scene.add(sketchPts);
  const importLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x8fd3ff, depthTest: false })); importLines.renderOrder = 9; scene.add(importLines);
  const importOpen = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x9aa3b2, depthTest: false })); importOpen.renderOrder = 9; scene.add(importOpen);
  function importedLoops() {
    const im = S.imported; if (!im) return { closed: [], open: [] };
    const b = im.bounds; const cx = im.center ? (b.minx + b.maxx) / 2 : 0, cy = im.center ? (b.miny + b.maxy) / 2 : 0;
    const tf = l => l.map(q => [(q[0] - cx) * im.scale, (q[1] - cy) * im.scale]);
    return { closed: im.closed.map(tf), open: im.open.map(tf) };
  }
  function syncImport() {
    const { closed, open } = importedLoops();
    const seg = (loops, wrap) => { const arr = []; for (const l of loops) for (let i = 0; i < l.length - (wrap ? 0 : 1); i++) { const a = to3(l[i], 0.03), b2 = to3(l[(i + 1) % l.length], 0.03); arr.push(...a, ...b2); } return new Float32Array(arr); };
    importLines.geometry.dispose(); importLines.geometry = new THREE.BufferGeometry(); importLines.geometry.setAttribute('position', new THREE.BufferAttribute(seg(closed, true), 3)); importLines.visible = closed.length > 0;
    importOpen.geometry.dispose(); importOpen.geometry = new THREE.BufferGeometry(); importOpen.geometry.setAttribute('position', new THREE.BufferAttribute(seg(open, false), 3)); importOpen.visible = open.length > 0;
  }
  const SK = { line: 0x3d7bff, pt: 0x2f6fed, mid: 0x9ec1ff, live: 0xff9a2e, dim: 0x3a3f4a };
  const looseLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: SK.line, depthTest: false })); looseLines.renderOrder = 10; scene.add(looseLines);
  const loosePts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: SK.pt, size: 8, sizeAttenuation: false, depthTest: false })); loosePts.renderOrder = 11; scene.add(loosePts);
  const midPts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: SK.mid, size: 5, sizeAttenuation: false, depthTest: false })); midPts.renderOrder = 11; scene.add(midPts);
  const startPt = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: SK.live, size: 14, sizeAttenuation: false, depthTest: false })); startPt.renderOrder = 12; scene.add(startPt);
  const liveLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: SK.live, depthTest: false })); liveLine.renderOrder = 12; liveLine.visible = false; scene.add(liveLine);
  const startRing = new THREE.Mesh(new THREE.RingGeometry(0.72, 1, 32), new THREE.MeshBasicMaterial({ color: SK.live, side: THREE.DoubleSide, depthTest: false })); startRing.renderOrder = 12; startRing.visible = false; scene.add(startRing);
  const dimLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: SK.dim, depthTest: false })); dimLines.renderOrder = 12; dimLines.visible = false; scene.add(dimLines);
  function syncLines() {
    syncKept();
    const arr = []; const pts = []; const mids = [];
    // points where exactly two pieces meet in a smooth, nearly straight join (the inside of an arc) get no handle,
    // so an arc reads as one curve with a handle at each end, like Shapr3D
    const jk = p => Math.round(p[0] * 1e6) + ',' + Math.round(p[1] * 1e6); const joins = new Map();
    for (const [a, b] of S.sketchLines) { for (const [p, q] of [[a, b], [b, a]]) { const k = jk(p); const L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1; (joins.get(k) || joins.set(k, []).get(k)).push([(q[0] - p[0]) / L, (q[1] - p[1]) / L]); } }
    const smooth = p => { const d = joins.get(jk(p)); return d && d.length === 2 && d[0][0] * d[1][0] + d[0][1] * d[1][1] < -0.94; };
    for (const [a, b] of S.sketchLines) { arr.push(...to3(a, 0.02), ...to3(b, 0.02)); const sa = smooth(a), sb = smooth(b);
      if (!sa) pts.push(new THREE.Vector3(...to3(a, 0.02))); if (!sb) pts.push(new THREE.Vector3(...to3(b, 0.02)));
      if (!sa && !sb) mids.push(new THREE.Vector3(...to3([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 0.02))); }
    for (let i = 0; i + 1 < S.sketch.length + (S.sketchClosed ? 1 : 0); i++) { const a = S.sketch[i], b = S.sketch[(i + 1) % S.sketch.length]; if (S.sketch.length < 20) mids.push(new THREE.Vector3(...to3([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 0.02))); }
    looseLines.geometry.dispose(); looseLines.geometry = new THREE.BufferGeometry(); looseLines.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3)); looseLines.visible = arr.length > 0;
    loosePts.geometry.dispose(); loosePts.geometry = new THREE.BufferGeometry().setFromPoints(pts); loosePts.visible = pts.length > 0;
    midPts.geometry.dispose(); midPts.geometry = new THREE.BufferGeometry().setFromPoints(mids); midPts.visible = mids.length > 0;
    startPt.geometry.dispose(); startPt.geometry = new THREE.BufferGeometry().setFromPoints(S.lineStart && !S.drawing ? [new THREE.Vector3(...to3(S.lineStart, 0.03))] : []); startPt.visible = !!S.lineStart && !S.drawing;
    syncDrawing();
  }
  /** The segment whose dimension is shown: the line being dragged, else the last placed line. */
  function dimSegment() {
    if (S.drawing && S.tool === 'circle') return { kind: 'radius', a: S.drawing.start, b: S.drawing.end, live: true };
    if (S.drawing && S.tool === 'polygon') { const [a, b] = polyFlats(polySnapRot(polyFrom(S.drawing.start, S.drawing.end))); return { kind: 'length', a, b, live: true }; }
    if (S.drawing && S.tool === 'rect') return { kind: 'length', a: S.drawing.start, b: [S.drawing.end[0], S.drawing.start[1]], live: true };
    if (S.drawing) return { kind: 'length', a: S.drawing.start, b: S.drawing.end, live: true };
    if (S.tool === 'line' && S.lastLine >= 0 && S.lastLine < S.sketchLines.length) { const l = S.sketchLines[S.lastLine]; return { kind: 'length', a: l[0], b: l[1], live: false, edit: setLastLineLength }; }
    if (S.tool === 'polyline' && S.sketch.length >= 2) {
      const n = S.sketch.length;
      if (S.sketchClosed) return { kind: 'length', a: S.sketch[n - 1], b: S.sketch[0], live: false, edit: null };
      return { kind: 'length', a: S.sketch[n - 2], b: S.sketch[n - 1], live: false, edit: setLastPolyLength };
    }
    if (S.tool === 'polygon' && S.polygon && S.sketchClosed) { const [a, b] = polyFlats(S.polygon); return { kind: 'length', a, b, live: false, edit: setPolygonAF }; }
    if (S.tool === 'circle' && S.circle && S.sketchClosed) { const c = S.circle.c, r = S.circle.r; return { kind: 'radius', a: c, b: [c[0] + r * Math.SQRT1_2, c[1] + r * Math.SQRT1_2], live: false, edit: setCircleRadius }; }
    return null;
  }
  const fmtDim = v => `${Math.round(v * 100) / 100} ${S.unit}`;
  /** Live rubber-band line, start ring and the dimension annotation (extension lines, dimension line, arrows). */
  function syncDrawing() {
    const d = S.drawing; const wpp = worldPerPx();
    if (d && S.tool === 'rect') { const a = d.start, b = d.end; const pts = [a, [b[0], a[1]], b, [a[0], b[1]], a].map(q => new THREE.Vector3(...to3(q, 0.03))); liveLine.geometry.dispose(); liveLine.geometry = new THREE.BufferGeometry().setFromPoints(pts); liveLine.visible = true; }
    else if (d && S.tool === 'polygon') { const pts = polyPts(polySnapRot(polyFrom(d.start, d.end))); pts.push(pts[0]); liveLine.geometry.dispose(); liveLine.geometry = new THREE.BufferGeometry().setFromPoints(pts.map(q => new THREE.Vector3(...to3(q, 0.03)))); liveLine.visible = true; }
    else if (d && S.tool !== 'circle') { liveLine.geometry.dispose(); liveLine.geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...to3(d.start, 0.03)), new THREE.Vector3(...to3(d.end, 0.03))]); liveLine.visible = true; }
    else if (d && S.tool === 'circle') { const r = Math.hypot(d.end[0] - d.start[0], d.end[1] - d.start[1]); const pts = []; for (let i = 0; i <= 64; i++) { const t = 2 * Math.PI * i / 64; pts.push(new THREE.Vector3(...to3([d.start[0] + r * Math.cos(t), d.start[1] + r * Math.sin(t)], 0.03))); } liveLine.geometry.dispose(); liveLine.geometry = new THREE.BufferGeometry().setFromPoints(pts); liveLine.visible = r > 0; }
    else liveLine.visible = false;
    if (d) { const c = to3(d.start, 0.04); startRing.position.set(c[0], c[1], c[2]); startRing.quaternion.copy(basisQuat(plane())); const sc = 7 * wpp; startRing.scale.set(sc, sc, sc); startRing.visible = true; } else startRing.visible = false;
    if (typeof syncGizmo === 'function') syncGizmo();
    const seg = dimSegment();
    if (seg && seg.kind === 'radius' && Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]) > 1e-9) {
      const c = seg.a, e = seg.b; const r = Math.hypot(e[0] - c[0], e[1] - c[1]); const dir = [(e[0] - c[0]) / r, (e[1] - c[1]) / r]; const nrm = [-dir[1], dir[0]]; const m = 5 * wpp, ah = 7 * wpp;
      const segs = [c, e, [c[0] - m, c[1]], [c[0] + m, c[1]], [c[0], c[1] - m], [c[0], c[1] + m],
        e, [e[0] - dir[0] * ah + nrm[0] * ah * 0.4, e[1] - dir[1] * ah + nrm[1] * ah * 0.4], e, [e[0] - dir[0] * ah - nrm[0] * ah * 0.4, e[1] - dir[1] * ah - nrm[1] * ah * 0.4]];
      dimLines.geometry.dispose(); dimLines.geometry = new THREE.BufferGeometry().setFromPoints(segs.map(q => new THREE.Vector3(...to3(q, 0.035)))); dimLines.visible = true;
      const mid = [(c[0] + e[0]) / 2 + nrm[0] * 12 * wpp, (c[1] + e[1]) / 2 + nrm[1] * 12 * wpp];
      dimAnchor = { p: to3(mid, 0.04), a: to3(c, 0), b: to3(e, 0), text: 'R ' + fmtDim(r), live: seg.live, edit: seg.edit || null, value: r };
    } else if (seg && Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]) > 1e-9) {
      const a = seg.a, b = seg.b; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); const dir = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; let nrm = [-dir[1], dir[0]];
      const off = 26 * wpp, ext = 6 * wpp, ah = 7 * wpp;
      const A = [a[0] + nrm[0] * off, a[1] + nrm[1] * off], B = [b[0] + nrm[0] * off, b[1] + nrm[1] * off];
      const segs = [a, [a[0] + nrm[0] * (off + ext), a[1] + nrm[1] * (off + ext)], b, [b[0] + nrm[0] * (off + ext), b[1] + nrm[1] * (off + ext)], A, B,
        A, [A[0] + dir[0] * ah + nrm[0] * ah * 0.4, A[1] + dir[1] * ah + nrm[1] * ah * 0.4], A, [A[0] + dir[0] * ah - nrm[0] * ah * 0.4, A[1] + dir[1] * ah - nrm[1] * ah * 0.4],
        B, [B[0] - dir[0] * ah + nrm[0] * ah * 0.4, B[1] - dir[1] * ah + nrm[1] * ah * 0.4], B, [B[0] - dir[0] * ah - nrm[0] * ah * 0.4, B[1] - dir[1] * ah - nrm[1] * ah * 0.4]];
      dimLines.geometry.dispose(); dimLines.geometry = new THREE.BufferGeometry().setFromPoints(segs.map(q => new THREE.Vector3(...to3(q, 0.035)))); dimLines.visible = true;
      dimAnchor = { p: to3([(A[0] + B[0]) / 2 + nrm[0] * 11 * wpp, (A[1] + B[1]) / 2 + nrm[1] * 11 * wpp], 0.04), a: to3(A, 0), b: to3(B, 0), text: fmtDim(L), live: seg.live, edit: seg.edit || null, value: L };
    } else { dimLines.visible = false; dimAnchor = null; }
  }
  let dimAnchor = null;
  const dimEl = $('dim'), snapEl = $('snaptip');
  /** Like project(), but ok whenever the point is in front of the camera (on screen or not). */
  function projectFront(w) { const v = new THREE.Vector3(w[0], w[1], w[2]).project(camera); const r = canvas.getBoundingClientRect(); return { x: (v.x + 1) / 2 * r.width + r.left, y: (1 - v.y) / 2 * r.height + r.top, ok: v.z > -1 && v.z < 1 }; }
  function project(w) { const v = new THREE.Vector3(w[0], w[1], w[2]).project(camera); const r = canvas.getBoundingClientRect(); return { x: (v.x + 1) / 2 * r.width + r.left, y: (1 - v.y) / 2 * r.height + r.top, ok: v.z < 1 && Math.abs(v.x) < 1.3 && Math.abs(v.y) < 1.3 }; }
  /** Screen-space overlays that must follow the camera: the dimension label and the snap tooltip. */
  // Fit all: with unlimited zoom the model can end up a speck or out of view; this button (shown only then) frames it all
  const fitBtn = document.createElement('button'); fitBtn.id = 'fit-all'; fitBtn.className = 'fil-pill'; fitBtn.textContent = '⤢ Fit all'; fitBtn.hidden = true; document.body.appendChild(fitBtn);
  { const st = document.createElement('style'); st.textContent = '#fit-all { position: fixed; left: 50%; top: 84px; transform: translateX(-50%); z-index: 30; font: inherit; font-size: 14px; font-weight: 600; padding: 7px 14px; cursor: pointer; color: var(--accent); }'; document.head.appendChild(st); }
  function fitAll() {
    const sb = sceneBounds(); if (!sb) return; cam.target.set(sb.c[0], sb.c[1], sb.c[2]);
    const r = canvas.getBoundingClientRect(); const fovMin = 2 * Math.atan(Math.tan(camera.fov * Math.PI / 360) * Math.min(1, r.width / Math.max(1, r.height)));
    cam.dist = Math.max(1e-6, sb.r / Math.sin(fovMin / 2) * 1.1); fitBtn.hidden = true; requestRender();
  }
  fitBtn.onclick = fitAll;
  /** The model is lost when no body or profile is on screen at all, or the whole scene is a speck (under 2 % of the screen). */
  function modelLost() {
    const sb = sceneBounds(); if (!sb) return false;
    // inside a body the view shows nothing
    { const cp = camera.position; if (bodyContaining([cp.x, cp.y, cp.z])) return true; }
    const r = canvas.getBoundingClientRect();
    const onScreen = q => q.ok && q.x > r.left && q.x < r.right && q.y > r.top && q.y < r.bottom;
    let any = false;
    for (const b of S.bodies) { const bb = b.man.boundingBox(); if (onScreen(project([(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2]))) { any = true; break; } }
    if (!any) for (const q of S.profiles || []) if (onScreen(project(profCentre(q)))) { any = true; break; }
    if (!any) for (const q of S.paths || []) { if (q.pts.some(p => onScreen(project(C.frameToWorld(q.frame, p[0], p[1], 0))))) { any = true; break; } }
    if (!any) for (const [a2] of sketchSegments()) if (onScreen(project(to3(a2)))) { any = true; break; }
    if (!any) return true;
    // a speck: the whole scene seen from outside it, smaller than 2 % of the screen
    const cp = camera.position; const inside = cp.x >= sb.min[0] && cp.x <= sb.max[0] && cp.y >= sb.min[1] && cp.y <= sb.max[1] && cp.z >= sb.min[2] && cp.z <= sb.max[2]; if (inside) return false;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, behind = false;
    for (const x of [sb.min[0], sb.max[0]]) for (const y of [sb.min[1], sb.max[1]]) for (const z of [sb.min[2], sb.max[2]]) { const q = project([x, y, z]); if (!q.ok) { behind = true; continue; } x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    return !behind && Math.max(x1 - x0, y1 - y0) < 0.02 * Math.min(r.width, r.height);
  }
  function updateOverlays() {
    fitBtn.hidden = !modelLost();
    if (typeof placeSkLengths === 'function') placeSkLengths();
    if (typeof placeProfileBadges === 'function') placeProfileBadges();
    if (dimAnchor && !dimEditing) {
      const c = project(dimAnchor.p), pa = project(dimAnchor.a), pb = project(dimAnchor.b);
      let ang = Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI; if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
      dimEl.hidden = !c.ok; dimEl.textContent = dimAnchor.text; dimEl.className = dimAnchor.live ? 'live' : (dimAnchor.edit ? 'editable' : 'fixed'); dimEl.style.left = c.x + 'px'; dimEl.style.top = c.y + 'px'; dimEl.style.transform = `translate(-50%, -50%) rotate(${ang.toFixed(1)}deg)`;
    } else if (!dimEditing) dimEl.hidden = true;
    const tip = S.snapTip;
    if (tip && tip.kind && tip.kind !== 'grid' && (tip.until == null || performance.now() < tip.until)) {
      const c = project(to3(tip.p, 0.04)); snapEl.hidden = !c.ok; snapEl.textContent = tip.label || tip.kind; snapEl.style.left = c.x + 'px'; snapEl.style.top = c.y + 'px';
      if (tip.until != null) setTimeout(requestRender, Math.max(16, tip.until - performance.now() + 5));
    } else snapEl.hidden = true;
  }
  let dimEditing = false;
  const SNAP_LABEL = { centre: 'Centre', 'profile centre': 'Profile centre', endpoint: 'Endpoint', midpoint: 'Midpoint', intersection: 'Intersection', edge: 'On edge', 'edge intersection': 'Edge', 'start point': 'Start point', horizontal: 'Horizontal', vertical: 'Vertical' };
  function showSnapTip(p, kind, ms) { S.snapTip = kind && kind !== 'grid' ? { p: [p[0], p[1]], kind, label: SNAP_LABEL[kind] || kind, until: ms ? performance.now() + ms : null } : null; }
  /** Tap the dimension label of the last line to type its exact length (the line keeps its start and direction). */
  dimEl.onclick = () => {
    if (!dimAnchor || dimAnchor.live || !dimAnchor.edit) return;
    const L0 = dimAnchor.value, apply0 = dimAnchor.edit;
    dimEditing = true; dimEl.className = 'live'; dimEl.style.pointerEvents = 'auto'; dimEl.hidden = false; dimEl.style.transform = 'translate(-50%, -50%)';
    const inp = document.createElement('input'); inp.type = 'number'; inp.step = 'any'; inp.inputMode = 'decimal'; inp.value = Math.round(L0 * 100) / 100; dimEl.replaceChildren(inp);
    const done = (apply) => { dimEditing = false; dimEl.style.pointerEvents = ''; const v = parseFloat(inp.value); if (apply && v > 0 && Math.abs(v - L0) > 1e-9) apply0(v); else syncScene(); requestRender(); };
    inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') { done(false); } };
    inp.onblur = () => { if (dimEditing) done(true); };
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
  };
  function setLastPolyLength(L) { return named('Polyline length', () => {
    step(() => {
      const n = S.sketch.length; const a = S.sketch[n - 2], b = S.sketch[n - 1]; const dx = b[0] - a[0], dy = b[1] - a[1]; const L0 = Math.hypot(dx, dy) || 1;
      S.sketch[n - 1] = [a[0] + dx / L0 * L, a[1] + dy / L0 * L]; syncScene(); toast(`Length set to ${fmtDim(L)}`);
    });
  }); }
  /** Polygon tool (Shapr3D's Polygon): n sides about a centre; sized by the distance across flats, turned by rot (a vertex's angle). */
  const polyPts = P => { const R = P.af / (2 * Math.cos(Math.PI / P.n)); return Array.from({ length: P.n }, (_, i) => { const t = P.rot + 2 * Math.PI * i / P.n; return [P.c[0] + R * Math.cos(t), P.c[1] + R * Math.sin(t)]; }); };
  const polyFrom = (c, e) => { const n = S.polySides || 6; const R = Math.hypot(e[0] - c[0], e[1] - c[1]); return { c: [c[0], c[1]], n, af: 2 * R * Math.cos(Math.PI / n), rot: Math.atan2(e[1] - c[1], e[0] - c[0]) }; };
  /** Snaps the polygon's turn so a vertex sits on a 15° step (pointy-top hexagon at 90°, like the drawing). */
  const polySnapRot = P => ({ ...P, rot: Math.round(P.rot / (Math.PI / 12)) * (Math.PI / 12) });
  function setPolygon(P, label = 'Polygon') { return named(label, () => step(() => { S.polygon = { ...P }; S.sketch = polyPts(S.polygon); S.sketchClosed = true; syncScene(); })); }
  function setPolygonAF(af) { if (!S.polygon || !(af > 0)) return; setPolygon({ ...S.polygon, af }, 'Polygon size'); toast(`Across flats set to ${fmtDim(af)}`); renderUI(); }
  function polyFlats(P) { const pts = polyPts(P); const m = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; const k = Math.floor(P.n / 2); return P.n % 2 === 0 ? [m(pts[0], pts[1]), m(pts[k], pts[(k + 1) % P.n])] : [m(pts[0], pts[1]), pts[(k + 1) % P.n]]; }
  function setCircleRadius(r) { return named('Circle radius', () => {
    step(() => {
      const c = S.circle ? S.circle.c : S.sketch[0]; S.circle = { c: [c[0], c[1]], r };
      S.sketch = Array.from({ length: CIRCLE_SEG }, (_, i) => { const t = 2 * Math.PI * i / CIRCLE_SEG; return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]; }); S.sketchClosed = true;
      syncScene(); toast(`Radius set to ${fmtDim(r)}`);
    });
  }); }
  function setLastLineLength(L) { return named('Line length', () => {
    step(() => {
      const seg = S.sketchLines[S.lastLine]; const dx = seg[1][0] - seg[0][0], dy = seg[1][1] - seg[0][1]; const L0 = Math.hypot(dx, dy) || 1;
      const end = [seg[0][0] + dx / L0 * L, seg[0][1] + dy / L0 * L];
      const chained = S.lineStart && Math.hypot(S.lineStart[0] - seg[1][0], S.lineStart[1] - seg[1][1]) < 1e-9;
      S.sketchLines[S.lastLine] = [seg[0], end]; if (chained) S.lineStart = end;
      syncScene(); toast(`Length set to ${fmtDim(L)}`);
    });
  }); }
  function syncSketch() {
    syncImport(); syncLines();
    const pts = S.sketch.map(p => new THREE.Vector3(...to3(p, 0.02)));
    const linePts = pts.length >= 2 ? (S.sketchClosed ? [...pts, pts[0]] : pts) : [];
    sketchLine.geometry.dispose(); sketchLine.geometry = new THREE.BufferGeometry().setFromPoints(linePts); sketchLine.visible = linePts.length > 0;
    sketchPts.geometry.dispose(); sketchPts.geometry = new THREE.BufferGeometry().setFromPoints(pts); sketchPts.visible = pts.length > 0;
  }

  // ---------- persistence ----------
  function save() {
    try {
      const doc = { v: 1, nextId: S.nextId, colorIdx: S.colorIdx, sketchLines: sketchSegments().map(([a, b]) => [[a[0], a[1]], [b[0], b[1]]]),   // (the shape being drawn too)
        sketchPlane: S.plane && !S.plane.bodyId ? { origin: S.plane.origin, u: S.plane.u, v: S.plane.v, n: S.plane.n, name: S.plane.name } : null, paths: S.paths, nextPathId: S.nextPathId, profiles: S.profiles, nextProfileId: S.nextProfileId, bodies: S.bodies.map(b => ({ id: b.id, name: b.name, color: b.color, hidden: !!b.hidden, shape: C.serialize(b.man) })) };
      const s = JSON.stringify(doc); if (s.length < 4_000_000) localStorage.setItem('solidsketch.doc', s); else localStorage.removeItem('solidsketch.doc');
    } catch (e) { /* storage may be unavailable */ }
  }
  function load() {
    try {
      const s = localStorage.getItem('solidsketch.doc'); if (!s) return;
      const doc = JSON.parse(s);
      S.nextId = doc.nextId || 1; S.colorIdx = doc.colorIdx || 0; if (Array.isArray(doc.sketchLines) && doc.sketchLines.length && doc.sketchPlane) { S.sketchLines = doc.sketchLines; S.plane = doc.sketchPlane; } S.profiles = Array.isArray(doc.profiles) ? doc.profiles : []; S.paths = Array.isArray(doc.paths) ? doc.paths : []; S.nextPathId = doc.nextPathId || (S.paths.reduce((m, q) => Math.max(m, q.id), 0) + 1); S.nextProfileId = doc.nextProfileId || (S.profiles.reduce((m, q) => Math.max(m, q.id), 0) + 1);
      S.bodies = [];
      for (const b of doc.bodies) { try { const man = C.deserialize(b.shape); S.bodies.push({ id: b.id, name: b.name, color: b.color, hidden: !!b.hidden, man, md: C.meshData(man) }); } catch (e) { /* skip a body this engine cannot rebuild */ } }
      if (S.bodies.length || S.profiles.length) toast(`Restored ${S.bodies.length} bod${S.bodies.length === 1 ? 'y' : 'ies'}${S.profiles.length ? ` and ${S.profiles.length} profile${S.profiles.length === 1 ? '' : 's'}` : ''} from your last session`);
    } catch (e) { /* corrupt or empty */ }
  }
  const onFace = () => !!(S.plane && S.plane.bodyId != null);
  function commit() { if (onFace() && !S.bodies.some(b => b.id === S.plane.bodyId)) { S.plane = null; S.selectedFace = null; } save(); syncScene(); }
  // ---------- unified history: every drawing and modelling step is one undo/redo entry ----------
  const H = { past: [], future: [], depth: 0 };
  const HISTORY_MAX = 2000;
  const cp2 = a => a.map(q => [q[0], q[1]]);
  function snapshot() {
    return { bodies: S.bodies, sketch: cp2(S.sketch), sketchClosed: S.sketchClosed, sketchLines: S.sketchLines.map(l => [[l[0][0], l[0][1]], [l[1][0], l[1][1]]]), lineStart: S.lineStart ? [S.lineStart[0], S.lineStart[1]] : null,
      paths: S.paths, profiles: S.profiles, selProfiles: S.selProfiles.slice(), plane: S.plane, feats: S.feats || [], kept: (S.kept || []).map(k => ({ plane: k.plane, hidden: !!k.hidden, lines: k.lines.map(l => [l[0].slice(), l[1].slice()]) })), imported: S.imported, tool: S.tool, selectedId: S.selectedId, selectedFace: S.selectedFace, height: S.height, flip: S.flip, circle: S.circle ? { c: [S.circle.c[0], S.circle.c[1]], r: S.circle.r } : null };
  }
  // History (Shapr3D-style): every command is a named step. H.past[i] is the state before step i and carries its name;
  // H.future holds undone steps (the state after each, with its name). A step without a name gets one from what changed.
  let actionName = null;
  /** Runs fn with every step it records named `name` (unless the step names itself). */
  function named(name, fn) { const prev = actionName; actionName = name; try { return fn(); } finally { actionName = prev; } }
  /** Records the current state as an undo point. Nested calls inside one step() record once. */
  function record(label) { if (H.depth > 0) return; settleHistory(); const snap = snapshot(); snap.label = label || actionName || null; H.past.push(snap); if (H.past.length > HISTORY_MAX) H.past.shift(); H.pendingFuture = H.future.length ? H.future : null; H.future = []; renderHistory(); }
  /** Same model and sketch (selection, tool and camera do not count). */
  function sameState(a, b) {
    const J = JSON.stringify;
    return a.bodies === b.bodies && (a.profiles || null) === (b.profiles || null) && (a.paths || null) === (b.paths || null) && a.plane === b.plane && a.imported === b.imported && a.sketchClosed === b.sketchClosed && a.height === b.height && !!a.flip === !!b.flip &&
      J(a.sketch) === J(b.sketch) && J(a.sketchLines) === J(b.sketchLines) && J(a.lineStart) === J(b.lineStart) && J(a.circle) === J(b.circle);
  }
  /**
   * A step is recorded when a command starts (tapping a face opens push/pull at once, say). If it then changed nothing,
   * it is dropped here and the redo steps it had put aside come back, so looking around never costs a step that could be
   * redone. Runs only when no command is under way: at the next step, at Undo / Redo, and when the history is opened.
   */
  function settleHistory() {
    if (H.past.length && sameState(H.past[H.past.length - 1], snapshot())) { H.past.pop(); if (H.pendingFuture) H.future = H.pendingFuture; }
    H.pendingFuture = null;
  }
  const redoable = () => H.future.length > 0 || (!!H.pendingFuture && H.past.length > 0 && sameState(H.past[H.past.length - 1], snapshot()));
  /** Runs fn as one undoable step (inner record() calls are folded into it). */
  function step(fn, label) { record(label); H.depth++; try { return fn(); } finally { H.depth--; } }
  const pushUndo = record;
  /** Renames the step just recorded (a fillet's final type and size is only known when it is applied). */
  function relabelLast(label) { const top = H.past[H.past.length - 1]; if (top) { top.label = label; renderHistory(); } }
  function restore(snap) {
    S.paths = snap.paths || []; S.selPath = null; if (typeof swDrop === 'function') swDrop();
    S.profiles = snap.profiles || []; S.selProfiles = (snap.selProfiles || []).filter(id => S.profiles.some(q => q.id === id)); if (typeof lfDrop === 'function') lfDrop();
    S.bodies = snap.bodies; S.sketch = cp2(snap.sketch); S.sketchClosed = snap.sketchClosed; S.sketchLines = snap.sketchLines.map(l => [[l[0][0], l[0][1]], [l[1][0], l[1][1]]]);
    S.lineStart = snap.lineStart ? [snap.lineStart[0], snap.lineStart[1]] : null; S.plane = snap.plane; S.kept = (snap.kept || []).map(k => ({ plane: k.plane, hidden: !!k.hidden, lines: k.lines.map(l => [l[0].slice(), l[1].slice()]) })); S.feats = snap.feats || []; S.imported = snap.imported; S.tool = snap.tool; S.height = snap.height; S.flip = snap.flip === 'both' ? 'both' : !!snap.flip; S.circle = snap.circle ? { c: [snap.circle.c[0], snap.circle.c[1]], r: snap.circle.r } : null;
    S.selectedId = snap.bodies.some(b => b.id === snap.selectedId) ? snap.selectedId : null; S.selectedFace = snap.selectedFace; S.lastSnap = null;
    S.pendingBool = null; S.faceTool = false; S.scaleTool = false; S.drawing = null; S.lastLine = -1; S.snapTip = null; SESSION = null; MV = null; VDRAG = null; S.selRegion = -1; S.selVertex = null; S.moveSurf = null;
    if (onFace() && !S.bodies.some(b => b.id === S.plane.bodyId)) { S.plane = null; S.selectedFace = null; }
    if (!H.batch) { save(); syncScene(); }
  }
  function filDrop() { if (typeof SC !== 'undefined' && SC) scDrop(); if (typeof FL !== 'undefined' && FL) { FL = null; filEditing = false; for (const e of [filLabel, filLabel2, filType, filRho, filGear]) e.hidden = true; } }
  { const st = document.createElement('style'); st.textContent = `@media (max-width: 420px) { .bar { gap: 0; padding: 6px 4px 6px 10px; } .title small { display: none; } .title b { font-size: 14px; }
      #count { margin-left: 6px; font-size: 11px; } #undo, #redo { padding: 8px 5px; font-size: 13px; } .bar .icon, #hist { width: 34px; padding: 0; } }`; document.head.appendChild(st); }
  const histBtn = document.createElement('button'); histBtn.className = 'btn'; histBtn.id = 'hist'; histBtn.title = 'History: every step, tap one to go back to it';
  histBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4h4"/><path d="M12 7v5l3 2"/></svg>';
  { const redoEl = document.getElementById('redo'); if (redoEl) redoEl.after(histBtn); }
  const histSheet = document.createElement('div'); histSheet.id = 'hist-sheet'; histSheet.hidden = true;
  histSheet.innerHTML = '<div class="hist-head"><b>History</b><span id="hist-count"></span><button class="btn" id="hist-close" title="Close">×</button></div><div class="hist-note">Tap a step to go back (or forward) to right after it. Greyed steps were undone: a new command replaces them.</div><div id="hist-list"></div>';
  document.body.appendChild(histSheet);
  { const st = document.createElement('style'); st.textContent = `#hist-sheet { position: fixed; left: 8px; right: 8px; top: 64px; bottom: 150px; z-index: 40; background: linear-gradient(var(--panel, #1c2029), var(--panel, #1c2029)), var(--sheet-solid, #22252c); color: var(--fg, #e8ebf0); border: 1px solid #2c3240; border-radius: 16px; display: flex; flex-direction: column; box-shadow: 0 8px 30px rgba(0,0,0,.45); }
    #hist-sheet[hidden] { display: none; } .hist-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px 4px; font-size: 17px; } .hist-head #hist-count { opacity: .6; font-size: 13px; flex: 1; }
    .hist-note { padding: 0 14px 8px; font-size: 12px; opacity: .6; } #hist-list { overflow-y: auto; padding: 0 8px 10px; flex: 1; }
    :root { --sheet-solid: #22252c; } @media (prefers-color-scheme: light) { :root { --sheet-solid: #ffffff; } } :root[data-theme='light'] { --sheet-solid: #ffffff; } :root[data-theme='dark'] { --sheet-solid: #22252c; }
    .hist-item { display: flex; gap: 10px; align-items: center; padding: 10px 10px; border-radius: 10px; cursor: pointer; font-size: 15px; } .hist-item .n { opacity: .5; min-width: 28px; text-align: right; font-variant-numeric: tabular-nums; }
    .hist-item.current { background: #2f6fed; color: #fff; } .hist-item.current .n { opacity: .85; } .hist-item.undone { opacity: .38; } .hist-item:not(.current):active { background: #2a3040; }`; document.head.appendChild(st); }
  function renderHistory() {
    if (typeof histSheet === 'undefined' || histSheet.hidden) return;
    renderFeats();
    const steps = historySteps(); const cur = H.past.length; const list = document.getElementById('hist-list'); list.replaceChildren();
    document.getElementById('hist-count').textContent = `${steps.length} step${steps.length === 1 ? '' : 's'}`;
    const row = (n, label, cls, k) => { const d = document.createElement('div'); d.className = 'hist-item ' + cls; d.innerHTML = `<span class="n">${n}</span><span></span>`; d.lastChild.textContent = label; d.onclick = () => gotoStep(k); list.appendChild(d); return d; };
    let curEl = row('·', 'Start', cur === 0 ? 'current' : '', 0);
    steps.forEach((st2, i) => { const el2 = row(i + 1, st2.label, i + 1 === cur ? 'current' : (st2.done ? '' : 'undone'), i + 1); if (i + 1 === cur) curEl = el2; try { xtHistBtn(el2, i); } catch (e) { /* the row still works */ } });
    curEl.scrollIntoView({ block: 'nearest' });
  }
  histBtn.onclick = () => { if (histSheet.hidden) { if (SESSION) endSession(); if (MV) endMove(); settleHistory(); } histSheet.hidden = !histSheet.hidden; renderHistory(); renderUI(); };
  document.getElementById('hist-close').onclick = () => { histSheet.hidden = true; };
  function undo() { if (SESSION) SESSION = null; if (MV) MV = null; filDrop(); settleHistory(); if (!H.past.length) return; const back = H.past.pop(); const now = snapshot(); now.label = back.label || describeStep(back, now); H.future.push(now); restore(back); renderHistory(); }
  function redo() { if (SESSION) SESSION = null; if (MV) MV = null; filDrop(); settleHistory(); if (!H.future.length) return; const fwd = H.future.pop(); const now = snapshot(); now.label = fwd.label; H.past.push(now); restore(fwd); renderHistory(); }
  /** Goes to right after step k (0 = the start): undoes or redoes as many steps as needed, drawing once at the end. */
  function gotoStep(k) {
    settleHistory(); if (k === H.past.length) return; H.batch = true;
    try { while (H.past.length > k) undo(); while (H.past.length < k && H.future.length) redo(); } finally { H.batch = false; }
    save(); syncScene(); renderHistory();
  }
  /** A name for a step from what it changed: bodies added, deleted or edited, or the sketch. */
  function describeStep(before, after) {
    const A = new Map(before.bodies.map(b => [b.id, b])), B = new Map(after.bodies.map(b => [b.id, b]));
    const added = after.bodies.filter(b => !A.has(b.id)), gone = before.bodies.filter(b => !B.has(b.id)), edited = after.bodies.filter(b => A.has(b.id) && A.get(b.id).man !== b.man);
    const list = bs => bs.map(b => b.name).join(', ');
    if (added.length && !gone.length && !edited.length) return 'Add ' + list(added);
    if (gone.length && !added.length && !edited.length) return 'Delete ' + list(gone);
    if (edited.length && !added.length && !gone.length) return 'Edit ' + list(edited);
    if (added.length || gone.length || edited.length) return 'Change ' + list([...edited, ...added, ...gone]);
    if (before.plane !== after.plane) return after.plane ? `Sketch plane: ${after.plane.name || 'face'}` : 'Leave sketch';
    return 'Sketch';
  }
  /** The steps in order: { label, done } for everything done and then everything undone (greyed in the list). */
  function historySteps() {
    const now = snapshot(); const out = [];
    H.past.forEach((p, i) => out.push({ label: p.label || describeStep(p, H.past[i + 1] || now), done: true }));
    const fut = H.future.slice().reverse(); let prev = now; for (const f of fut) { out.push({ label: f.label || describeStep(prev, f), done: false }); prev = f; }
    return out;
  }

  // ---------- picking helpers ----------
  const raycaster = new THREE.Raycaster();
  function rayAt(x, y) {
    const r = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), camera);
    const o = raycaster.ray.origin, d = raycaster.ray.direction;
    return { o: [o.x, o.y, o.z], d: [d.x, d.y, d.z] };
  }
  function planeHit(ray, z = 0) { if (Math.abs(ray.d[2]) < 1e-7) return null; const t = (z - ray.o[2]) / ray.d[2]; return t > 0 ? [ray.o[0] + ray.d[0] * t, ray.o[1] + ray.d[1] * t] : null; }
  const isSketchTool = t => ['line', 'polyline', 'rect', 'circle', 'polygon', 'edit'].includes(t);
  const plane = () => S.plane || C.GROUND;
  const to3 = (p, off = 0) => C.frameToWorld(plane(), p[0], p[1], off);
  const planeLabel = () => onFace() ? `face of ${(S.bodies.find(b => b.id === S.plane.bodyId) || { name: 'a body' }).name}` : S.plane ? S.plane.name : 'none — choose one';
  function setPrincipalPlane(key) {
    const f = PRINCIPAL[key]; if (!f) return;
    record('Sketch plane: ' + f.name);
    S.plane = { ...f, bodyId: null }; S.sketchLines = []; S.lineStart = null; S.lastLine = -1; S.selectedId = null; S.selectedFace = null; S.faceTool = false; S.scaleTool = false; S.pendingBool = null;
    toast(`Sketching on the ${f.name} plane — the grid now lies on it`);
    syncScene();   // sketch in 3D: the view stays where it is (View plane looks straight at the plane on request)
  }
  let camAnim = null;
  /** Smoothly moves the camera to a yaw/pitch (and optional target) over ms milliseconds. */
  function animateCamera(yaw, pitch, target, ms = 420, dist = null) {
    const from = { yaw: cam.yaw, pitch: cam.pitch, t: cam.target.clone(), d: cam.dist }; const to = { yaw, pitch, t: target ? new THREE.Vector3(target[0], target[1], target[2]) : cam.target.clone(), d: dist || cam.dist };
    let dy = to.yaw - from.yaw; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI; to.yaw = from.yaw + dy;
    const t0 = performance.now(); if (camAnim) cancelAnimationFrame(camAnim);
    const tick = () => { const k = Math.min(1, (performance.now() - t0) / ms); const e = 1 - Math.pow(1 - k, 3); cam.yaw = from.yaw + (to.yaw - from.yaw) * e; cam.pitch = from.pitch + (to.pitch - from.pitch) * e; cam.target.lerpVectors(from.t, to.t, e); cam.dist = from.d + (to.d - from.d) * e; requestRender(); if (k < 1) camAnim = requestAnimationFrame(tick); else camAnim = null; };
    tick();
  }
  /** Turns the camera to look straight at the active sketch plane (a 2D drawing view), like Shapr3D does when a plane is picked. */
  function lookAtPlane() {
    const f = plane(); const n = f.n;
    const pitch = Math.max(-1.5, Math.min(1.5, Math.asin(Math.max(-1, Math.min(1, n[2])))));
    const yaw = Math.abs(n[2]) < 0.999 ? Math.atan2(n[1], n[0]) : (n[2] > 0 ? -Math.PI / 2 : Math.PI / 2);
    // look at what is drawn on the plane (the sketch, else the face, else the plane origin) from a distance that fits it
    const pts = sketchSegments().flat(); if (!pts.length && onFace() && f.loops && f.loops.length) pts.push(...f.loops[0]);
    let target, dist;
    if (pts.length) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      target = C.frameToWorld(f, (x0 + x1) / 2, (y0 + y1) / 2, 0); const ext = Math.max(x1 - x0, y1 - y0, 1); const asp = Math.max(0.4, Math.min(1, (renderer.domElement.clientWidth || innerWidth) / Math.max(1, renderer.domElement.clientHeight || innerHeight))); dist = Math.max(8, ext * 1.9 / asp); }
    else { target = f.origin.slice(); dist = 20; }
    animateCamera(yaw, pitch, target, 420, dist);
  }
  // ---------- sketches stay: changing the plane keeps the old sketch on screen (Shapr3D keeps every sketch as an item) ----------
  if (!S.kept) S.kept = [];
  function archiveSketch() {
    if (!S.plane || !S.sketchLines.length) return;
    S.kept = [...(S.kept || []), { plane: { ...S.plane }, lines: S.sketchLines.map(l => [l[0].slice(), l[1].slice()]) }];
  }
  const keptLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x0f2f7a, depthTest: false })); keptLines.renderOrder = 10; scene.add(keptLines);
  const keptPts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0x2f6fed, size: 7, sizeAttenuation: false, depthTest: false })); keptPts.renderOrder = 11; scene.add(keptPts);
  function syncKept() {
    const arr = []; for (const k of S.kept || []) if (!k.hidden) for (const [a, b] of k.lines) { arr.push(...C.frameToWorld(k.plane, a[0], a[1], 0.02), ...C.frameToWorld(k.plane, b[0], b[1], 0.02)); }
    keptLines.geometry.dispose(); keptLines.geometry = new THREE.BufferGeometry(); keptLines.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3)); keptLines.visible = arr.length > 0;
    keptPts.geometry.dispose(); keptPts.geometry = new THREE.BufferGeometry(); keptPts.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3)); keptPts.visible = arr.length > 0;
  }
  /** Index of the kept sketch with a line under (x, y), or -1. */
  function keptAt(x, y) {
    let best = -1, bd = 14;
    (S.kept || []).forEach((k, i) => { if (k.hidden) return; for (const [a, b] of k.lines) { const A = project(C.frameToWorld(k.plane, a[0], a[1], 0)), B = project(C.frameToWorld(k.plane, b[0], b[1], 0)); if (!A.ok || !B.ok) continue;
      const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((x - A.x) * dx + (y - A.y) * dy) / L2)); const d = Math.hypot(A.x + dx * t - x, A.y + dy * t - y); if (d < bd) { bd = d; best = i; } } });
    return best;
  }
  const pip = (p, L) => { let inside = false; for (let i = 0, j = L.length - 1; i < L.length; j = i++) { const a = L[i], b = L[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / ((b[1] - a[1]) || 1e-12) + a[0]) inside = !inside; } return inside; };
  /** The kept sketch whose closed shape is under (x, y): { i, pt } in that sketch's plane coordinates, or null. */
  function keptRegionAt(x, y) {
    const ray = rayAt(x, y); let best = null;
    (S.kept || []).forEach((k, i) => { if (k.hidden) return; const q = C.planeHit2D(k.plane, ray.o, ray.d); if (!q) return; let loops = []; try { loops = k.lines.length >= 3 ? C.planarRegions(k.lines.map(l => [l[0], l[1]])) : []; } catch (e) { loops = []; }
      if (!loops.some(L => pip(q, L))) return; const w = C.frameToWorld(k.plane, q[0], q[1], 0); const dd = Math.hypot(w[0] - ray.o[0], w[1] - ray.o[1], w[2] - ray.o[2]); if (!best || dd < best.d) best = { i, pt: q, d: dd }; });
    return best;
  }
  /** Makes a kept sketch the active one again (the active one, if any, is kept in its place). */
  function activateKept(i) { const k = S.kept[i]; if (!k) return; step(() => { const rest = S.kept.filter((_, j) => j !== i); const cur = S.plane && S.sketchLines.length ? [{ plane: { ...S.plane }, lines: S.sketchLines.map(l => [l[0].slice(), l[1].slice()]) }] : [];
    S.kept = [...rest, ...cur]; S.plane = k.plane; S.sketchLines = k.lines.map(l => [l[0].slice(), l[1].slice()]); S.lineStart = null; S.lastLine = -1; S.selRegion = -1; RVLINE = null; rvLineSync(); syncScene(); }, 'Select sketch'); toast('Sketch selected · tap inside a shape, or Sketch to edit it'); }
  function setSketchPlane(hit) {
    let f; try { f = C.faceFrame(hit.body.md, hit.faceId); } catch (e) { toast('Could not read that face'); return; }
    record('Sketch on a face of ' + hit.body.name);
    archiveSketch();
    S.plane = { origin: f.origin, u: f.u, v: f.v, n: f.n, bodyId: hit.body.id, faceId: hit.faceId, loops: f.loops };
    S.sketchLines = []; S.lineStart = null; S.lastLine = -1;
    S.selectedId = hit.body.id; S.selectedFace = hit.faceId; S.faceTool = false; S.scaleTool = false; S.pendingBool = null;
    toast(`Sketching on a face of ${hit.body.name} — tap Change plane to go back`);
    syncScene();   // sketch in 3D: the view stays where it is (View plane looks straight at the plane on request)
  }
  function useGroundPlane() { if (!S.plane) return; if (SESSION) endSession(); step(() => { archiveSketch(); S.plane = null; S.selRegion = -1; S.selVertex = null; S.selectedFace = null; S.sketchLines = []; S.lineStart = null; syncScene(); }, 'Ground plane'); }
  const changePlane = useGroundPlane;
  /** The body the point is inside of (its box first, then the solid itself), or null. */
  function bodyContaining(q) { for (const b of S.bodies) { const bb = b.man.boundingBox(); if (q[0] < bb.min[0] || q[0] > bb.max[0] || q[1] < bb.min[1] || q[1] > bb.max[1] || q[2] < bb.min[2] || q[2] > bb.max[2]) continue; if (insideBody(b.md, q)) return b; } return null; }
  // a view from inside a body picks what is seen through it (not the inside of the body around the camera)
  function pick(ray, only) { const around = bodyContaining(ray.o); let best = null; for (const b of (only || S.bodies)) { if (b === around || b.hidden) continue; const h = C.rayMesh(b.md, ray.o, ray.d); if (h && (!best || h.distance < best.distance)) best = { body: b, ...h }; } return best; }
  const snap = p => S.snap ? [Math.round(p[0] * 2) / 2, Math.round(p[1] * 2) / 2] : p;

  // ---------- sketch snapping (endpoints, midpoints, intersections, face corners, grid) ----------
  function sketchSegments() {
    const segs = S.sketchLines.map(l => [l[0], l[1]]);
    for (let i = 0; i + 1 < S.sketch.length; i++) segs.push([S.sketch[i], S.sketch[i + 1]]);
    if (S.sketchClosed && S.sketch.length >= 3) segs.push([S.sketch[S.sketch.length - 1], S.sketch[0]]);
    return segs;
  }
  function snapCandidateSegments() {
    const segs = sketchSegments();
    if (S.plane && S.plane.loops) for (const l of S.plane.loops) for (let i = 0; i < l.length; i++) segs.push([l[i], l[(i + 1) % l.length]]);
    const im = importedLoops(); for (const l of im.closed) for (let i = 0; i < l.length; i++) segs.push([l[i], l[(i + 1) % l.length]]); for (const l of im.open) for (let i = 0; i + 1 < l.length; i++) segs.push([l[i], l[i + 1]]);
    return segs;
  }
  /**
   * World units per screen pixel, at the depth of point p (default: the orbit centre). Measured on the canvas as it is really
   * displayed (getBoundingClientRect, like project() and every tap): an app viewer may show the page scaled, and then the
   * canvas's layout height (clientHeight) is not what the eye sees; handles sized from it came out that much too big.
   */
  const worldPerPx = p => {
    let d = cam.dist; if (p) { const f = new THREE.Vector3(); camera.getWorldDirection(f); const dd = (p[0] - camera.position.x) * f.x + (p[1] - camera.position.y) * f.y + (p[2] - camera.position.z) * f.z; if (dd > 1e-6) d = dd; }
    const h = canvas.getBoundingClientRect().height || canvas.clientHeight; return 2 * d * Math.tan(camera.fov * Math.PI / 360) / Math.max(1, h);
  };
  /**
   * Size of a tool's handles, as world units per handle pixel: the usual screen-constant size while the object is large on
   * screen, shrunk so the handles reach at most 80 % of the object's size there (a handle bigger than the thing it edits makes
   * no sense), but never below 35 % of the usual size so a finger can still grab them. objSize: the object's size (world);
   * reachPx: how far the tool's handles reach at their usual size (px). Returns { wpp, f } (f = shrink factor, 1 = usual).
   */
  const HANDLE_FIT = 0.8;
  /** at: where the handles sit (their size on screen is measured there); minPx: the smallest a finger can still use. */
  function fitWpp(objSize, reachPx, at, minPx = 48) {
    const wpp = worldPerPx(at); const objPx = objSize / wpp; const fMin = Math.min(1, minPx / reachPx); const f = Math.max(fMin, Math.min(1, HANDLE_FIT * objPx / reachPx));
    return { wpp: wpp * f, f, fMin };
  }
  const closestOnSeg = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const L = dx * dx + dy * dy; const t = L > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0; return [a[0] + dx * t, a[1] + dy * t]; };
  /** The point the current stroke continues from (line chain start, or the open polyline's last point). */
  const strokeAnchor = () => S.lineStart || (S.tool === 'polyline' && S.sketch.length && !S.sketchClosed ? S.sketch[S.sketch.length - 1] : null);
  /**
   * Snap a plane point, in priority order: notable points (endpoints, midpoints, intersections, face corners) within
   * ~16 px → the point where the line being drawn meets a nearby edge → the nearest point on a nearby edge →
   * the grid (if Grid snap is on) → the raw point.
   */
  function snapPoint(p, anchorOverride) { return snapPointWith(p, snapCandidateSegments(), anchorOverride); }
  /** Profile centres and path points lying on the sketch plane, as sketch (2D) points to snap to. */
  function planeSnapExtras() {
    const f = plane(); const out = []; const on = w => Math.abs((w[0] - f.origin[0]) * f.n[0] + (w[1] - f.origin[1]) * f.n[1] + (w[2] - f.origin[2]) * f.n[2]) <= 1e-6 * Math.max(1, Math.hypot(...w));
    const to2d = w => { const d = [w[0] - f.origin[0], w[1] - f.origin[1], w[2] - f.origin[2]]; return [d[0] * f.u[0] + d[1] * f.u[1] + d[2] * f.u[2], d[0] * f.v[0] + d[1] * f.v[1] + d[2] * f.v[2]]; };
    for (const q of S.profiles || []) { const c = profCentre(q); if (on(c)) out.push({ p: to2d(c), kind: 'profile centre' }); }
    for (const q of S.paths || []) for (const p0 of q.pts) { const w = C.frameToWorld(q.frame, p0[0], p0[1], 0); if (on(w)) out.push({ p: to2d(w), kind: 'path point' }); }
    // the centre of every round edge on the plane (a cylinder's top, a hole's mouth): draw a circle from it, or drop a moved circle's centre on it
    if (C.circleCentres) for (const b of S.bodies) { let cs = []; try { cs = C.circleCentres(b.md); } catch (e) { cs = []; } for (const cc of cs) if (on(cc.p) && Math.abs(cc.n[0] * f.n[0] + cc.n[1] * f.n[1] + cc.n[2] * f.n[2]) > 0.999) out.push({ p: to2d(cc.p), kind: 'centre' }); }
    return out;
  }
  function snapPointWith(p, segs, anchorOverride) {
    const tol = 16 * worldPerPx();
    let best = null;
    for (const c of planeSnapExtras()) { const d = Math.hypot(c.p[0] - p[0], c.p[1] - p[1]); if (d < tol && (!best || d < best.d)) best = { d, p: [c.p[0], c.p[1]], kind: c.kind }; }
    for (const c of C.notablePoints(segs)) { const d = Math.hypot(c.p[0] - p[0], c.p[1] - p[1]); if (d < tol && (!best || d < best.d)) best = { d, p: [c.p[0], c.p[1]], kind: c.kind }; }
    if (S.lineStart && Math.hypot(S.lineStart[0] - p[0], S.lineStart[1] - p[1]) < tol && (!best || best.kind !== 'endpoint')) best = { d: 0, p: S.lineStart, kind: 'start point' };
    if (best) { S.lastSnap = best.kind; return best.p; }
    let seg = null;
    for (const [a, b] of segs) { const q = closestOnSeg(p, a, b); const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < tol && (!seg || d < seg.d)) seg = { d, q, a, b }; }
    const anchor0 = anchorOverride || strokeAnchor();
    if (seg) {
      const anchor = anchor0;
      if (anchor && Math.hypot(p[0] - anchor[0], p[1] - anchor[1]) > 1e-9) {
        const far = [anchor[0] + (p[0] - anchor[0]) * 1e4, anchor[1] + (p[1] - anchor[1]) * 1e4];
        const x = C.segIntersect(anchor, far, seg.a, seg.b);
        if (x && Math.hypot(x.p[0] - p[0], x.p[1] - p[1]) < 2 * tol) { S.lastSnap = 'edge intersection'; return x.p; }
      }
      S.lastSnap = 'edge'; return seg.q;
    }
    if (anchor0) { // nearly horizontal or vertical → make it exactly so (Shapr3D auto-constraint)
      const dx = p[0] - anchor0[0], dy = p[1] - anchor0[1]; const L = Math.hypot(dx, dy);
      if (L > tol && Math.abs(dy) < L * 0.06) { S.lastSnap = 'horizontal'; return [S.snap ? Math.round(p[0] * 2) / 2 : p[0], anchor0[1]]; }
      if (L > tol && Math.abs(dx) < L * 0.06) { S.lastSnap = 'vertical'; return [anchor0[0], S.snap ? Math.round(p[1] * 2) / 2 : p[1]]; }
    }
    S.lastSnap = S.snap ? 'grid' : null;
    return snap(p);
  }
  function lineTap(p) { return named('Line', () => {
    step(() => {
      if (!S.lineStart) { S.lineStart = p; syncScene(); return; }
      if (Math.hypot(p[0] - S.lineStart[0], p[1] - S.lineStart[1]) < 1e-9) { S.lineStart = null; S.lastSnap = null; syncScene(); return; } // tap start again = finish
      S.sketchLines.push([S.lineStart, p]); S.lastLine = S.sketchLines.length - 1; S.lineStart = p; syncScene();
    });
  }); }
  // ---------- drag-to-draw (Shapr3D style): press on the plane, drag, release ----------
  const DRAG_TOOLS = ['line', 'polyline', 'rect', 'circle', 'polygon'];
  function beginDraw(x, y) {
    if (SESSION) endSession();
    const ray = rayAt(x, y); const p = C.planeHit2D(plane(), ray.o, ray.d); if (!p) return false;
    const start = snapPoint(p); S.drawing = { start, end: start, startKind: S.lastSnap }; showSnapTip(start, S.lastSnap, null);
    syncLines(); requestRender(); return true;
  }
  function moveDraw(x, y) {
    const d = S.drawing; if (!d) return; const ray = rayAt(x, y); const p = C.planeHit2D(plane(), ray.o, ray.d); if (!p) return;
    d.end = snapPoint(p, d.start); showSnapTip(d.end, S.lastSnap, null);
    syncLines(); hintEl.textContent = hint(); requestRender();
  }
  function endDraw() {
    const d = S.drawing; if (!d) return; S.drawing = null;
    const a = d.start, b = d.end; const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-9) { syncScene(); return; }
    showSnapTip(b, S.lastSnap, 1400);
    if (S.tool === 'line') step(() => { S.sketchLines.push([a, b]); S.lastLine = S.sketchLines.length - 1; S.lineStart = null; syncScene(); }, 'Line');
    else if (S.tool === 'rect') step(() => { if (a[0] !== b[0] && a[1] !== b[1]) { S.sketch = [a, [b[0], a[1]], b, [a[0], b[1]]]; S.sketchClosed = true; } syncScene(); }, 'Rectangle');
    else if (S.tool === 'polygon') setPolygon(polySnapRot(polyFrom(a, b)));
    else if (S.tool === 'circle') step(() => { S.circle = { c: [a[0], a[1]], r: L }; S.sketch = Array.from({ length: CIRCLE_SEG }, (_, i) => { const t = 2 * Math.PI * i / CIRCLE_SEG; return [a[0] + L * Math.cos(t), a[1] + L * Math.sin(t)]; }); S.sketchClosed = true; syncScene(); }, 'Circle');
    else if (S.tool === 'polyline') named('Polyline point', () => step(() => {
      if (S.sketchClosed) return;
      const last = S.sketch[S.sketch.length - 1];
      if (!S.sketch.length || !last || Math.hypot(last[0] - a[0], last[1] - a[1]) > 1e-9) S.sketch.push(a);
      if (S.sketch.length >= 3 && Math.hypot(b[0] - S.sketch[0][0], b[1] - S.sketch[0][1]) < 1e-9) S.sketchClosed = true; else S.sketch.push(b);
      syncScene();
    }));
  }
  function cancelDraw() { S.drawing = null; S.snapTip = null; syncLines(); requestRender(); }
  function finishLine() { if (!S.lineStart) return; step(() => { S.lineStart = null; S.lastSnap = null; syncScene(); }, 'Finish line'); }
  function undoLine() { return named('Remove last line', () => {
    if (!S.lineStart && !S.sketchLines.length) return;
    step(() => {
      const last = S.sketchLines[S.sketchLines.length - 1];
      if (S.lineStart && last && Math.hypot(last[1][0] - S.lineStart[0], last[1][1] - S.lineStart[1]) < 1e-9) { S.sketchLines.pop(); S.lineStart = last[0]; }
      else if (S.lineStart) S.lineStart = null; else S.sketchLines.pop();
      syncScene();
    });
  }); }
  function clearLines() { if (!S.sketchLines.length && !S.lineStart) return; step(() => { S.sketchLines = []; S.lineStart = null; S.lastLine = -1; S.lastSnap = null; syncScene(); }, 'Clear lines'); }
  const polyArea = l => Math.abs(window.CadIO.area(l));
  const centroid = l => { let a = 0, x = 0, y = 0; for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; const c = p[0] * q[1] - q[0] * p[1]; a += c; x += (p[0] + q[0]) * c; y += (p[1] + q[1]) * c; } return a ? [x / (3 * a), y / (3 * a)] : [l[0][0], l[0][1]]; };
  const sameLoop = (a, b) => Math.abs(polyArea(a) - polyArea(b)) < 1e-6 * Math.max(1, polyArea(a)) && Math.hypot(centroid(a)[0] - centroid(b)[0], centroid(a)[1] - centroid(b)[1]) < 1e-4;
  const faceSegments = () => { const out = []; if (S.plane && S.plane.loops) for (const l of S.plane.loops) for (let i = 0; i < l.length; i++) out.push([l[i], l[(i + 1) % l.length]]); return out; };
  /**
   * Closed regions to extrude, as {outer, holes}:
   *  - lines that close on their own form regions (a rectangle drawn on a face → the rectangle);
   *  - otherwise, on a face, lines that run edge to edge split the face itself into regions.
   */
  function lineRegions() {
    const user = sketchSegments(); if (!user.length) return [];
    try {
      const own = user.length >= 3 ? C.planarRegions(user) : [];
      if (own.length) return window.CadIO.loopsToRegions(own);
      const face = faceSegments(); if (!face.length) return [];
      const faceOnly = C.planarRegions(face);
      const combined = C.planarRegions([...face, ...user]).filter(l => !faceOnly.some(f => sameLoop(f, l)));
      return window.CadIO.loopsToRegions(combined);
    } catch (e) { return []; }
  }
  function extrudeLineRegions(mode = 'new') { step(() => extrudeLineRegionsInner(mode)); }
  function extrudeRegionsAction(regions, mode) { step(() => extrudeLineRegionsInner(mode, regions)); }
  function extrudeLineRegionsInner(mode, only) {
    const regions = only || lineRegions(); if (!regions.length) { toast('Lines do not close any region yet'); return; }
    const h = Math.max(0.01, S.height), eps = BOOL_EPS;
    const host = onFace() ? S.bodies.find(b => b.id === S.plane.bodyId) : null;
    if ((mode === 'join' || mode === 'cut') && (!host || !C.booleans)) mode = 'new';
    const skin = mode === 'cut' ? skinReach(host.man, len => C.extrudeRegions(regions, len), plane(), 1) : 0;   // reach through a hair-thin lid over the pocket
    const locals = tryGeom(() => C.extrudeRegions(regions, mode === 'new' ? h : h + eps + skin)); if (!locals) return;
    const placed = tryGeom(() => locals.map(l => C.placeInFrame(mode === 'cut' ? l.translate([0, 0, -h]) : mode === 'join' ? l.translate([0, 0, -eps]) : (S.flip === 'both' && !onFace()) ? l.translate([0, 0, -h / 2]) : (S.flip && !onFace()) ? l.translate([0, 0, -h]) : l, plane()))); if (!placed) return;
    if (mode === 'new') { pushUndo(); for (const sld of placed) { const rec = makeBodyRecord('Extrusion', sld); S.bodies = [...S.bodies, rec]; S.selectedId = rec.id; } S.selectedFace = null; clearLines(); S.sketch = []; S.sketchClosed = false; commit(); toast(`Created ${placed.length} bod${placed.length === 1 ? 'y' : 'ies'} from ${regions.length} region${regions.length === 1 ? '' : 's'}`); return; }
    let man = host.man; for (const sld of placed) { const r = tryGeom(() => C.fuse(man, sld, mode)); if (!r) return; man = r; }
    if (man.volume() < 1e-9) { toast('Cut removed the whole body — try a smaller depth'); return; }
    if (replaceBody(host, man)) { clearLines(); S.sketch = []; S.sketchClosed = false; syncScene(); toast(mode === 'cut' ? 'Cut into ' + host.name : 'Added to ' + host.name); }
  }

  // ---------- filled regions (closed sketches), the extrude gizmo and live extrusion sessions ----------
  const regionGroup = new THREE.Group(); scene.add(regionGroup); let regionMeshes = [];
  let regionCache = [];
  function syncRegions() {
    for (const m of regionMeshes) { regionGroup.remove(m); m.geometry.dispose(); m.material.dispose(); } regionMeshes = [];
    // closed regions stay tappable after leaving the sketch (Select tool), like Shapr3D: tap inside one to extrude or revolve it
    regionCache = ((isSketchTool(S.tool) || S.tool === 'select' || S.tool === 'move') && S.plane && !S.drawing) ? lineRegions() : [];
    if (S.selRegion >= regionCache.length) S.selRegion = -1;
    if (regionCache.length === 1 && S.selRegion < 0 && isSketchTool(S.tool) && S.tool !== 'edit' && !S.selCentre) S.selRegion = 0;
    if (S.selCentre) S.selRegion = -1;
    const f = plane(); const q = basisQuat(f);
    regionCache.forEach((r, i) => {
      const shape = new THREE.Shape(r.outer.map(p => new THREE.Vector2(p[0], p[1])));
      for (const h of r.holes) shape.holes.push(new THREE.Path(h.map(p => new THREE.Vector2(p[0], p[1]))));
      let g; try { g = new THREE.ShapeGeometry(shape); } catch (e) { return; }
      const sel = i === S.selRegion;
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: sel ? 0xff9a2e : 0x3d7bff, transparent: true, opacity: sel ? 0.5 : 0.16, side: THREE.DoubleSide, depthWrite: false, depthTest: false }));   // on top: a sketch inside a body (a revolve's profile) stays visible
      mesh.quaternion.copy(q); mesh.position.set(f.origin[0] + f.n[0] * 0.012, f.origin[1] + f.n[1] * 0.012, f.origin[2] + f.n[2] * 0.012); mesh.renderOrder = 8; mesh.userData.index = i;
      regionGroup.add(mesh); regionMeshes.push(mesh);
    });
    syncRegionOutline(f);
  }
  // the selected shape's edges in the same orange as its fill (Shapr3D), also while it is being moved
  const regionOutline = new THREE.Group(); regionOutline.renderOrder = 9; scene.add(regionOutline);
  function syncRegionOutline(f) {
    for (const c of [...regionOutline.children]) { regionOutline.remove(c); c.geometry && c.geometry.dispose(); c.material && c.material.dispose(); }
    const r = regionCache[S.selRegion]; if (!r) { requestRender(); return; }
    const vh = Math.max(1, renderer.domElement.clientHeight || innerHeight); const fov = camera.fov * Math.PI / 180; const up = new THREE.Vector3(0, 1, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff8a1f, depthTest: false });
    for (const L of [r.outer, ...(r.holes || [])]) for (let i = 0; i < L.length; i++) {
      const A = new THREE.Vector3(...C.frameToWorld(f, L[i][0], L[i][1], 0.015)), B = new THREE.Vector3(...C.frameToWorld(f, L[(i + 1) % L.length][0], L[(i + 1) % L.length][1], 0.015)); const len = A.distanceTo(B); if (len < 1e-9) continue;
      const mid = A.clone().add(B).multiplyScalar(0.5); const wpp = 2 * camera.position.distanceTo(mid) * Math.tan(fov / 2) / vh;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(1.3 * wpp, 1.3 * wpp, len, 5, 1, true), mat); m.position.copy(mid); m.quaternion.setFromUnitVectors(up, B.clone().sub(A).normalize()); m.renderOrder = 9; regionOutline.add(m);
    }
    requestRender();
  }
  // Gizmo: blue double arrow along the normal (distance), white double arrow above it (draft angle)
  const GZ = { group: new THREE.Group(), L: 46, blue: 0x2f6fed, white: 0xe8ebf0 };
  scene.add(GZ.group); GZ.group.visible = false; GZ.group.renderOrder = 20;
  {
    const mat = c => new THREE.MeshBasicMaterial({ color: c, depthTest: false, transparent: true, opacity: 0.95 });
    GZ.shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 2 * GZ.L, 12), mat(GZ.blue)); GZ.shaft.rotation.x = Math.PI / 2; GZ.group.add(GZ.shaft);
    GZ.headP = new THREE.Mesh(new THREE.ConeGeometry(5, 12, 16), mat(GZ.blue)); GZ.headP.position.z = GZ.L + 6; GZ.headP.rotation.x = Math.PI / 2; GZ.group.add(GZ.headP);
    GZ.headN = new THREE.Mesh(new THREE.ConeGeometry(5, 12, 16), mat(GZ.blue)); GZ.headN.position.z = -GZ.L - 6; GZ.headN.rotation.x = -Math.PI / 2; GZ.group.add(GZ.headN);
    GZ.handle = new THREE.Mesh(new THREE.SphereGeometry(4.5, 16, 12), mat(0xffffff)); GZ.group.add(GZ.handle);
    GZ.draft = new THREE.Group();
    GZ.draft.add(new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 22, 10), mat(GZ.blue))); GZ.draft.children[0].rotation.z = Math.PI / 2;
    const c1 = new THREE.Mesh(new THREE.ConeGeometry(4.5, 10, 12), mat(GZ.blue)); c1.position.x = 15; c1.rotation.z = -Math.PI / 2; GZ.draft.add(c1);
    const c2 = new THREE.Mesh(new THREE.ConeGeometry(4.5, 10, 12), mat(GZ.blue)); c2.position.x = -15; c2.rotation.z = Math.PI / 2; GZ.draft.add(c2);
    GZ.draft.add(new THREE.Mesh(new THREE.SphereGeometry(3.2, 12, 10), mat(0xffffff)));
    GZ.group.add(GZ.draft);
    for (const m of [GZ.shaft, GZ.headP, GZ.headN, GZ.handle, ...GZ.draft.children]) m.renderOrder = 20;
    GZ.axis = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0x3a3f4a, dashSize: 0.35, gapSize: 0.25, depthTest: false })); GZ.axis.renderOrder = 19; GZ.axis.visible = false; scene.add(GZ.axis);
    GZ.arc = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0x2f6fed, dashSize: 0.3, gapSize: 0.2, depthTest: false })); GZ.arc.renderOrder = 19; GZ.arc.visible = false; scene.add(GZ.arc);
  }
  const gizmoEl = (() => { const d = document.createElement('div'); d.id = 'gizmo-label'; d.hidden = true; document.body.appendChild(d); return d; })();
  const draftEl = (() => { const d = document.createElement('div'); d.id = 'draft-label'; d.hidden = true; document.body.appendChild(d); return d; })();
  /** What the gizmo acts on: a selected sketch region (extrude) or a selected body face (push/pull). */
  const GZ_REACH = 2 * (46 + 12);   // the double arrow end to end (shaft 2·L plus both heads)
  const gzFit = t => fitWpp(Math.max(2 * (t.radius || 0), 1e-6), GZ_REACH, t.center, 64);
  // round Revolve symbol beside a region selected in Select: tap it, then tap the line to turn around
  const rvBtn = document.createElement('button'); rvBtn.className = 'rv-sym'; rvBtn.type = 'button'; rvBtn.title = 'Revolve'; rvBtn.setAttribute('aria-label', 'Revolve');
  rvBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>';
  rvBtn.hidden = true; document.body.appendChild(rvBtn);
  { const st = document.createElement('style'); st.textContent = '.rv-sym{position:fixed;z-index:30;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;border:2px solid #fff;background:#2f6fed;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(0,0,0,.3);padding:0;cursor:pointer}.rv-sym[hidden]{display:none}'; document.head.appendChild(st); }
  rvBtn.addEventListener('click', e => { e.stopPropagation();
    { const t = gizmoTarget(); if (t && t.kind === 'region' && t.profId != null) { revolveProfile(t.profId); return; } }
    const r = regionCache[S.selRegion]; if (!r) return; if (RVLINE) revolveAboutLine(RVLINE, [r]); else startRevolvePick([r]); });
  function rvBtnSync(t) {
    if (!t || t.kind !== 'region' || S.tool !== 'select' || SESSION || RV) { rvBtn.hidden = true; return; }
    const r = t.regions[0]; const f = t.frame; let best = null;   // beside the region: its right-most corner, nudged outward
    for (const p of r.outer) if (!best || p[0] > best[0]) best = p;
    const w = C.frameToWorld(f, best[0], best[1], 0); const sp = project(w); if (!sp.ok) { rvBtn.hidden = true; return; }
    const cp = project(t.center); const bx = cp.ok ? Math.max(sp.x + 30, cp.x + 84) : sp.x + 30;   // beside the shape, clear of its extrude arrows
    rvBtn.style.left = bx + 'px'; rvBtn.style.top = ((cp.ok ? cp.y : sp.y) - 18) + 'px'; rvBtn.hidden = false;
  }
  function gizmoTarget() {
    if (SESSION) return SESSION.target;
    // a closed region selected in Select (Shapr3D-style) shows the same extrude arrows as while sketching
    if ((isSketchTool(S.tool) || (S.tool === 'select' && !RV && S.selectedId == null)) && S.plane && !S.drawing && S.selRegion >= 0 && S.selRegion < regionCache.length) {
      const r = regionCache[S.selRegion]; const { c } = C.regionShape(r.outer); const f = plane();
      const radius = Math.max(0.05, ...r.outer.map(p => p[0] - c[0]));
      return { kind: 'region', frame: f, center: C.frameToWorld(f, c[0], c[1], 0), hostId: onFace() ? S.plane.bodyId : null, regions: [r], draftable: true, radius };
    }
    if (S.tool === 'select' && !RV && S.selectedId == null && S.selProfiles.length === 1 && !LF) { const q = profById(S.selProfiles[0]);
      if (q && q.outer && q.outer.length >= 3) { const { c } = C.regionShape(q.outer); const radius = Math.max(0.05, ...q.outer.map(p => Math.hypot(p[0] - c[0], p[1] - c[1])));
        return { kind: 'region', profId: q.id, frame: { origin: q.frame.origin.slice(), u: q.frame.u.slice(), v: q.frame.v.slice(), n: q.frame.n.slice() }, center: C.frameToWorld(q.frame, c[0], c[1], 0), hostId: null, regions: [{ outer: q.outer, holes: q.holes || [] }], draftable: true, radius }; } }
    if (S.tool === 'select' && S.faceTool && S.selectedFace != null) {
      const b = selected(); if (!b) return null; let f; try { f = C.faceFrame(b.md, S.selectedFace); } catch (e) { return null; }
      const big = f.loops.slice().sort((x, y) => Math.abs(C.signedArea(y)) - Math.abs(C.signedArea(x)))[0]; const { c } = C.regionShape(big);
      const radius = Math.max(0.05, ...big.map(p => p[0] - c[0]));
      return { kind: 'face', frame: f, center: C.frameToWorld(f, c[0], c[1], 0), hostId: b.id, faceId: S.selectedFace, draftable: true, radius, loops: f.loops };
    }
    return null;
  }
  let SESSION = null; // { target, before, value, draft, recorded }
  function gizmoValue() { return SESSION ? SESSION.value : 0; }
  /** Positions and scales the gizmo each frame (screen-constant size). */
  function syncGizmo() {
    if (typeof syncMoveGizmo === 'function') syncMoveGizmo();
    if (typeof syncFillet === 'function') syncFillet();
    if (typeof syncScale === 'function') syncScale();
    if (typeof syncHoleScaleGizmo === 'function') try { syncHoleScaleGizmo(); } catch (e) { /* drawing only */ }
    const t = gizmoTarget(); rvBtnSync(t);
    if (!t) { GZ.group.visible = false; GZ.axis.visible = false; GZ.arc.visible = false; gizmoEl.hidden = true; draftEl.hidden = true; return; }
    const wpp = gzFit(t).wpp; const n = t.frame.n; const v = gizmoValue();
    const pos = [t.center[0] + n[0] * v, t.center[1] + n[1] * v, t.center[2] + n[2] * v];
    GZ.group.position.set(pos[0], pos[1], pos[2]); GZ.group.quaternion.copy(basisQuat(t.frame)); GZ.group.scale.set(wpp, wpp, wpp); GZ.group.visible = true;
    const showDraft = !!t.draftable && SESSION && Math.abs(v) > 1e-9;
    GZ.draft.visible = showDraft; GZ.arc.visible = false; draftEl.hidden = true;
    if (showDraft) {
      const u = t.frame.u; const hw = draftHandleWorld(t, v, SESSION.draft || 0);
      // gizmo-group local coordinates (px): x along u, z along n, origin at the extruded top centre
      GZ.draft.position.set((hw[0] - pos[0]) * u[0] + (hw[1] - pos[1]) * u[1] + (hw[2] - pos[2]) * u[2], 0, (hw[0] - pos[0]) * n[0] + (hw[1] - pos[1]) * n[1] + (hw[2] - pos[2]) * n[2]).divideScalar(wpp);
      const dir = v < 0 ? -1 : 1, th = (SESSION.draft || 0) * Math.PI / 180; GZ.draft.rotation.set(0, -dir * th, 0);
      const c = project(hw); draftEl.hidden = !c.ok; draftEl.textContent = `${SESSION.draft || 0}°`; draftEl.style.left = (c.x + 22) + 'px'; draftEl.style.top = (c.y - 22) + 'px';
      // the rotation arc: centred on the base rim (the pivot), radius = height; the handle rides on it
      const h = Math.abs(v), R = t.radius; const pivot = [t.center[0] + u[0] * R, t.center[1] + u[1] * R, t.center[2] + u[2] * R]; const pts = [];
      for (let k = -60; k <= 60; k += 4) { const a = k * Math.PI / 180; const x = -Math.sin(a) * h, z = Math.cos(a) * h * dir; pts.push(new THREE.Vector3(pivot[0] + u[0] * x + n[0] * z, pivot[1] + u[1] * x + n[1] * z, pivot[2] + u[2] * x + n[2] * z)); }
      GZ.arc.geometry.dispose(); GZ.arc.geometry = new THREE.BufferGeometry().setFromPoints(pts); GZ.arc.computeLineDistances(); GZ.arc.visible = true;
      GZ.arc.material.opacity = SESSION.drag === 'draft' ? 1 : 0.7; GZ.arc.material.transparent = true;
    }
    if (SESSION && Math.abs(v) > 1e-9) {
      GZ.axis.geometry.dispose(); GZ.axis.geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...t.center), new THREE.Vector3(...pos)]); GZ.axis.computeLineDistances(); GZ.axis.visible = true;
      const mid = [(t.center[0] + pos[0]) / 2, (t.center[1] + pos[1]) / 2, (t.center[2] + pos[2]) / 2]; const c = project(mid);
      gizmoEl.hidden = !c.ok; gizmoEl.textContent = fmtDim(Math.abs(v)); gizmoEl.style.left = (c.x + 34) + 'px'; gizmoEl.style.top = c.y + 'px';
    } else { GZ.axis.visible = false; gizmoEl.hidden = true; }
  }
  /** World position of the rotation handle: on the arc of radius |v| around the base rim, at the current wall angle. */
  function draftHandleWorld(t, v, draftDeg) {
    const h = Math.abs(v), dir = v < 0 ? -1 : 1, th = draftDeg * Math.PI / 180, R = t.radius; const u = t.frame.u, n = t.frame.n;
    const x = R - Math.sin(th) * h, z = Math.cos(th) * h * dir;
    return [t.center[0] + u[0] * x + n[0] * z, t.center[1] + u[1] * x + n[1] * z, t.center[2] + u[2] * x + n[2] * z];
  }
  /** Which gizmo part is under a screen point: 'dist', 'draft' or null. */
  function hitGizmo(x, y) {
    const t = gizmoTarget(); if (!t || !GZ.group.visible) return null;
    const wpp = gzFit(t).wpp; const n = t.frame.n, u = t.frame.u; const v = gizmoValue(); const P = [t.center[0] + n[0] * v, t.center[1] + n[1] * v, t.center[2] + n[2] * v];
    const off = (d, k) => [P[0] + d[0] * k * wpp, P[1] + d[1] * k * wpp, P[2] + d[2] * k * wpp];
    const segDist = (a, b) => { const A = project(a), B = project(b); const dx = B.x - A.x, dy = B.y - A.y; const L2 = dx * dx + dy * dy || 1; const tt = Math.max(0, Math.min(1, ((x - A.x) * dx + (y - A.y) * dy) / L2)); return Math.hypot(A.x + dx * tt - x, A.y + dy * tt - y); };
    if (t.draftable && SESSION && Math.abs(v) > 1e-9) {
      const c = project(draftHandleWorld(t, v, SESSION.draft || 0)); if (Math.hypot(c.x - x, c.y - y) < 30) return 'draft';
    }
    if (segDist(off(n, GZ.L + 12), off(n, -GZ.L - 12)) < 22) return 'dist';
    return null;
  }
  /** Parameter along the gizmo axis of the point on the axis closest to the pointer ray. */
  function axisParam(ray, center, n) {
    const w0 = [ray.o[0] - center[0], ray.o[1] - center[1], ray.o[2] - center[2]];
    const b = ray.d[0] * n[0] + ray.d[1] * n[1] + ray.d[2] * n[2]; const d = w0[0] * ray.d[0] + w0[1] * ray.d[1] + w0[2] * ray.d[2]; const e = w0[0] * n[0] + w0[1] * n[1] + w0[2] * n[2];
    const den = 1 - b * b; if (Math.abs(den) < 1e-9) return e; // ray parallel to axis
    return (e - b * d) / den; // parameter on the axis line: closest approach
  }
  function beginGizmo(kind, x, y) {
    const t = gizmoTarget(); if (!t) return false;
    if (!SESSION) {
      record(t.kind === 'region' ? 'Extrude sketch' : (S.faceOp === 'extrude' ? 'Extrude face' : 'Push/Pull face') + ' of ' + (S.bodies.find(b => b.id === (t.hostId != null ? t.hostId : S.selectedId)) || { name: 'a body' }).name);
      SESSION = { target: t, before: S.bodies, value: 0, draft: 0, drag: kind, lastKey: '' };
    } else SESSION.drag = kind;
    const ray = rayAt(x, y);
    SESSION.t0 = axisParam(ray, t.center, t.frame.n) - SESSION.value; SESSION.x0 = x; SESSION.draft0 = SESSION.draft;
    return true;
  }
  function moveGizmo(x, y) {
    if (!SESSION) return; const t = SESSION.target;
    if (SESSION.drag === 'dist') { const ray = rayAt(x, y); const raw = axisParam(ray, t.center, t.frame.n) - SESSION.t0; SESSION.value = Math.round(raw * 10) / 10; }
    else if (SESSION.drag === 'draft') {
      const ray = rayAt(x, y); const F = { origin: t.center, u: t.frame.u, v: t.frame.n, n: t.frame.v }; const q = C.planeHit2D(F, ray.o, ray.d); if (!q) return;
      const dir = SESSION.value < 0 ? -1 : 1; const px = q[0], pz = q[1] * dir; // finger position in (radial, height) coordinates
      const theta = Math.atan2(t.radius - px, Math.max(pz, 0.02)) * 180 / Math.PI;
      SESSION.draft = Math.max(-60, Math.min(60, Math.round(theta)));
    }
    applySession();
  }
  /** Rebuilds the extrusion (or push/pull) from the pre-session bodies with the current value and draft. */
  function applySession(finalize = !(SESSION && SESSION.drag)) {
    if (!SESSION) return; if (typeof syncProfiles === 'function') try { syncProfiles(); } catch (e) { /* drawing only */ } const t = SESSION.target; const v = SESSION.value, dr = SESSION.draft; const key = v + '|' + dr + (finalize ? 'F' : ''); if (key === SESSION.lastKey) return; SESSION.lastKey = key;
    let bodies = SESSION.before;
    if (Math.abs(v) > 1e-9 || (dr && t.kind === 'face' && !extrudeMode())) {
      const eps = BOOL_EPS; const h = Math.abs(v);
      if (t.kind === 'region') {
        const host = t.hostId != null ? bodies.find(b => b.id === t.hostId) : null;
        // cut or add by where the drag goes, not by the sign alone: pushing into the body cuts it, pulling out of it adds
        // (a face whose sketch plane faces into the body would otherwise add a solid buried inside it: nothing happens)
        // Decided by solid geometry, not by a probe point: the region swept the way the drag goes either overlaps the host body
        // (then it cuts) or it does not (then it adds). A probe just under the plane missed whenever the sketch plane was not
        // exactly on the face any more (an older sketch, a face moved since, a lifted hole) — the cut then silently became an
        // add of a solid buried in the body and nothing happened (the bug seen twice).
        let into = v < 0;
        if (host && C.booleans) { try {
          const probe = C.extrudeRegions(t.regions, h, dr).map(l => C.placeInFrame(v < 0 ? l.mirror([0, 0, 1]) : l, t.frame));
          let ov = 0, tv = 0; for (const p of probe) { tv += p.volume(); for (const b of bodies) { const ix = b.man.intersect(p); ov += ix.volume(); freeMan(ix); } freeMan(p); }
          into = ov > 1e-6 * Math.max(1e-12, tv);
        } catch (e) { geomFailed(e); return; } }   // the engine could not answer: say so, never quietly make a new body instead
        const cut = into && host && C.booleans, join = !into && host && C.booleans; SESSION.didCut = !!cut;
        // a shape that starts a little inside a body (a profile moved just under a face) and is pushed further in still opens a
        // hole: the cut reaches back to the face it starts under, instead of leaving a buried pocket with a thin skin over it
        let back = 0;
        if (!cut && !join && v < 0 && !dr && C.booleans && typeof insideBody === 'function') { const n = t.frame.n; const c = t.center;
          for (const b of bodies) { let inside = false; try { inside = insideBody(b.md, c); } catch (e) { inside = false; } if (!inside) continue; const hit = C.rayMesh(b.md, c, n); if (hit && hit.distance < h) back = Math.max(back, hit.distance * 1.001 + 1e-6); } }
        const sgn = v < 0 ? 1 : -1; let skin = 0; if (cut) { SESSION.skinReach = SESSION.skinReach || {}; if (SESSION.skinReach[sgn] === undefined) SESSION.skinReach[sgn] = skinReach(host.man, len => C.extrudeRegions(t.regions, len), t.frame, sgn); skin = SESSION.skinReach[sgn]; }   // reach through a hair-thin lid over the pocket
        const locals = tryGeom(() => C.extrudeRegions(t.regions, cut ? h + eps + skin : join ? h + eps : h + back, dr)); if (!locals) return;
        const sym = S.flip === 'both' && !cut && !join;   // Direction: both — the new body straddles the plane, half each side
        const placed = tryGeom(() => locals.map(l => C.placeInFrame(sym ? (v < 0 ? l.mirror([0, 0, 1]).translate([0, 0, h / 2]) : l.translate([0, 0, -h / 2])) : v < 0 ? (cut ? l.mirror([0, 0, 1]).translate([0, 0, eps + skin]) : l.mirror([0, 0, 1]).translate([0, 0, back])) : (join ? l.translate([0, 0, -eps]) : cut ? l.translate([0, 0, -skin]) : l), t.frame))); if (!placed) return;
        if (cut) {
          // a cut goes through every body the swept shape overlaps, not only the face's own body: a copy lying exactly on
          // top of it (or a sketch whose face belongs to another body now) would otherwise keep the hole hidden
          let any = false;
          let failed = null;
          bodies = bodies.map(b => { let man = b.man, changed = false; for (const sld of placed) { let ix = null; try { ix = man.intersect(sld); } catch (e) { failed = e; return b; } const hit = ix && ix.volume() > 1e-6 * Math.max(1e-12, sld.volume()); freeMan(ix); if (!hit) continue; const r = tryGeom(() => C.fuse(man, sld, 'cut')); if (!r) { failed = new Error('cut failed'); return b; } man = r; changed = true; }
            if (!changed) return b; any = true; if (!(man.volume() > 1e-9)) return null; let md; try { md = C.meshData(man); } catch (e) { return b; } return { ...b, man, md }; }).filter(Boolean);
          if (failed) { geomFailed(failed); return; }
          if (!any) { let man = host.man; for (const sld of placed) { const r = tryGeom(() => C.fuse(man, sld, 'cut')); if (!r) return; man = r; } if (man.volume() < 1e-9) return; let md; try { md = C.meshData(man); } catch (e) { return; } bodies = bodies.map(b => b.id === host.id ? { ...b, man, md } : b); }
        }
        else if (join) { let man = host.man; for (const sld of placed) { const r = tryGeom(() => C.fuse(man, sld, 'join')); if (!r) return; man = r; } if (man.volume() < 1e-9) return; let md; try { md = C.meshData(man); } catch (e) { return; } bodies = bodies.map(b => b.id === host.id ? { ...b, man, md } : b); }
        else {
          // Shapr3D: a sketch pushed through an existing body cuts it (IMPORTANT-CORE video) — a new body is made only where nothing is hit
          let through = false;
          if (C.booleans) for (const b of bodies) { for (const sld of placed) { let inter = null; try { inter = b.man.intersect(sld); } catch (e) { geomFailed(e); return; } const hit = inter && inter.volume() > 1e-6 * Math.max(1e-12, sld.volume()); freeMan(inter); if (hit) { through = true; break; } } if (through) break; }
          if (through) {
            bodies = bodies.map(b => { let man = b.man, changed = false; for (const sld of placed) { let inter = null; try { inter = man.intersect(sld); } catch (e) { continue; } if (!(inter && inter.volume() > 1e-6 * sld.volume())) continue; const r = tryGeom(() => C.fuse(man, sld, 'cut')); if (!r) return b; man = r; changed = true; }
              if (!changed) return b; if (!(man.volume() > 1e-9)) return null; let md; try { md = C.meshData(man); } catch (e) { return b; } return { ...b, man, md }; }).filter(Boolean);
            SESSION.cutThrough = true;
          } else { SESSION.cutThrough = false;
        if (!SESSION.newIds) SESSION.newIds = placed.map(() => S.nextId++); bodies = [...bodies, ...placed.map((sld, i) => { let md; try { md = C.meshData(sld); } catch (e) { return null; } return { id: SESSION.newIds[i], name: `Extrusion ${SESSION.newIds[i]}`, color: PALETTE[(SESSION.color = SESSION.color ?? S.colorIdx++) % PALETTE.length], man: sld, md }; }).filter(Boolean)]; } }
      } else {
        const host = bodies.find(b => b.id === t.hostId); if (!host) return;
        // Stretch: the face moves and its walls bend with it; Extrude (or any drafted pull): a straight prism grows from or cuts into the face
        // Stretch: the face moves (and, with a tilt, shrinks or grows) and the walls lean from their base; Extrude: a straight or tapered block grows from / cuts into the face
        const m = !extrudeMode() ? tryGeom(() => C.pushPull(host.man, host.md, t.faceId, v, { live: !finalize, draft: dr })) : tryGeom(() => extrudeFaceBody(host.man, host.md, t.faceId, v, dr, t.loops, t.frame));
        if (!m || m.volume() < 1e-9) return; let md; try { md = C.meshData(m); } catch (e) { return; }
        bodies = bodies.map(b => b.id === host.id ? { ...b, man: m, md } : b);
      }
    }
    // free the previous live frame's solids (not the bodies we started from, not what is on screen now)
    { const beforeSet = new Set(SESSION.before.map(b => b.man)); const nowSet = new Set(bodies.map(b => b.man)); for (const m of SESSION.lastLive || []) if (!beforeSet.has(m) && !nowSet.has(m)) freeMan(m); SESSION.lastLive = bodies.map(b => b.man).filter(m => !beforeSet.has(m)); }
    S.bodies = bodies; if (t.kind === 'region' && t.hostId == null && SESSION.newIds) S.selectedId = SESSION.newIds[0];
    syncSceneLight();
  }
  /** Frees a temporary solid in the engine right away (its memory would otherwise wait for the garbage collector). */
  function freeMan(m) { try { if (m && typeof m.delete === 'function' && !S.bodies.some(b => b.man === m)) m.delete(); } catch (e) { /* already gone */ } }
  /** An engine call threw: tell the user plainly instead of quietly doing something else. */
  function geomFailed(e) { const msg = (e && e.message) || String(e); toast(/memory|enlarge|allocat/i.test(msg) ? 'The geometry engine ran out of memory — reload the page to free it (your work is saved)' : 'Geometry engine error: ' + msg); console.error(e); }
  function endGizmoDrag() { if (!SESSION) return; SESSION.drag = null; applySession(true); syncScene(); }   // release: rebuild at full quality
  /** Ends the live extrusion: keeps the result, consumes the sketch that produced it. */
  function endSession() { const xi = xCapture(); endSessionInner(); if (xi) xAfterExtrude(xi); }
  function endSessionInner() {
    if (!SESSION) return; const t = SESSION.target; const had = Math.abs(SESSION.value) > 1e-9; const cutWith = !!(SESSION.cutThrough || SESSION.didCut);
    if (had && t.kind === 'face') { const b = SESSION.before.find(x => x.id === t.hostId); if (b) relabelLast(faceOpName(b, SESSION.value) + (SESSION.draft ? `, walls ${Math.round(SESSION.draft)}°` : '')); }
    SESSION = null;
    if (had && t.kind === 'region' && t.profId != null) { S.selProfiles = []; if (cutWith) S.profiles = S.profiles.filter(q => q.id !== t.profId); }   // the profile stays (it can be extruded again); the sketch is untouched
    else if (had && t.kind === 'region') { S.sketchLines = []; S.lineStart = null; S.lastLine = -1; S.sketch = []; S.sketchClosed = false; S.circle = null; S.selRegion = -1; if (t.hostId != null) S.selectedFace = null; }
    if (had && t.kind === 'face') { S.faceTool = false; S.selectedFace = null; }
    save(); syncScene();
  }
  function syncSceneLight() { // during a drag: bodies + gizmo only, no panel rebuild
    const live = new Set();
    for (const b of S.bodies) { live.add(b.id); let o = objects.get(b.id); if (!o || o.md !== b.md || o.mesh.material.userData.mt !== (b.material || '')) { if (o) disposeObj(o); const mesh = new THREE.Mesh(geometryOf(b.md), bodyMaterial(b.color, b.material)); const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(b.md.edges, 3)); const lines = new THREE.LineSegments(lg, edgeMaterial()); scene.add(mesh); scene.add(lines); o = { md: b.md, mesh, lines, faceMesh: null, faceId: null }; objects.set(b.id, o); } o.mesh.material.emissive.setHex(b.id === S.selectedId && !(S.tool === 'move' && S.moveSurf != null) && S.selectedFace == null ? 0x6b4a10 : 0x000000); if (o.faceMesh) { scene.remove(o.faceMesh); o.faceMesh.geometry.dispose(); o.faceMesh = null; o.faceId = null; } }
    for (const [id, o] of objects) if (!live.has(id)) { disposeObj(o); objects.delete(id); }
    hintEl.textContent = hint(); requestRender();
  }

  // ---------- Move/Rotate tool: Shapr3D-style gizmo that moves or turns a whole body or one face ----------
  // Geometry lives in gizmo-local pixels (scaled by world-per-pixel each frame): local X, Y, Z = the target's axes.
  const v3cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const v3norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const MVX = { grp: new THREE.Group(), R: 38, L: 66, arc0: 0.24, arc1: 1.2, mats: [], arrows: [], rings: [] };
  scene.add(MVX.grp); MVX.grp.visible = false;
  {
    const mat = c => new THREE.MeshBasicMaterial({ color: c, depthTest: false, transparent: true, opacity: 0.96 });
    const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1); const E = [X, Y, Z];
    for (let k = 0; k < 3; k++) {
      const m = mat(0xffffff); MVX.mats.push(m);
      // translation arrow along axis k (cylinder/cone geometries point along +Y; orient the group so +Y → axis k)
      const g = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.1, MVX.L - 16, 10), m); shaft.position.y = 16 + (MVX.L - 16) / 2;
      const head = new THREE.Mesh(new THREE.ConeGeometry(6.2, 14, 16), m); head.position.y = MVX.L + 6;
      g.add(shaft, head); if (k === 0) g.rotation.z = -Math.PI / 2; else if (k === 2) g.rotation.x = Math.PI / 2;
      MVX.grp.add(g); MVX.arrows.push(g);
      // rotation handle: an arc around axis k, lying in the plane of the other two axes (e1 → e2)
      const rg = new THREE.Group(); rg.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(E[(k + 1) % 3], E[(k + 2) % 3], E[k]));
      const arc = new THREE.Mesh(new THREE.TorusGeometry(MVX.R, 2.6, 8, 28, MVX.arc1 - MVX.arc0), m); arc.rotation.z = MVX.arc0;
      const tip = (a, dir) => { const c = new THREE.Mesh(new THREE.ConeGeometry(5, 10, 12), m); c.position.set(Math.cos(a) * MVX.R, Math.sin(a) * MVX.R, 0); c.rotation.z = a + dir * Math.PI / 2; return c; };
      rg.add(arc, tip(MVX.arc1, -1), tip(MVX.arc0, 1));
      MVX.grp.add(rg); MVX.rings.push(rg);
    }
    MVX.center = new THREE.Mesh(new THREE.SphereGeometry(5.5, 16, 12), mat(0xffffff)); MVX.grp.add(MVX.center);
    // plane handles: a small square between each pair of arrows moves the target in that plane only
    MVX.planes = []; MVX.PQ = 24; MVX.pairs = [[0, 1], [1, 2], [0, 2]];
    for (const [i, j] of MVX.pairs) { const pm = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.85, side: THREE.DoubleSide }); MVX.mats.push(pm);
      const sq = new THREE.Mesh(new THREE.PlaneGeometry(11, 11), pm); const q = [0, 0, 0]; q[i] = MVX.PQ; q[j] = MVX.PQ; sq.position.set(...q);
      const nrm = [0, 0, 0]; nrm[3 - i - j] = 1; sq.lookAt(new THREE.Vector3(q[0] + nrm[0], q[1] + nrm[1], q[2] + nrm[2])); MVX.grp.add(sq); MVX.planes.push(sq); }
    MVX.grp.traverse(o => { o.renderOrder = 21; });
    MVX.axisLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0x3a3f4a, dashSize: 0.35, gapSize: 0.25, depthTest: false })); MVX.axisLine.renderOrder = 19; MVX.axisLine.visible = false; scene.add(MVX.axisLine);
    MVX.bigRing = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0x3a3f4a, dashSize: 0.35, gapSize: 0.25, depthTest: false })); MVX.bigRing.renderOrder = 19; MVX.bigRing.visible = false; scene.add(MVX.bigRing);
    MVX.band = new THREE.Mesh(new THREE.RingGeometry(1, 1.1, 8), new THREE.MeshBasicMaterial({ color: 0x2f6fed, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthTest: false })); MVX.band.renderOrder = 20; MVX.band.visible = false; scene.add(MVX.band);
  }
  const moveEl = (() => { const d = document.createElement('div'); d.id = 'move-label'; d.hidden = true; document.body.appendChild(d); return d; })();
  let MV = null;           // the move session: { target, before, mode: 'axis'|'plane'|'rot', k, value, du, dv, ... }
  let moveEditing = false; let lastInvalidToast = 0;
  const axisQuat = axes => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...axes[0]), new THREE.Vector3(...axes[1]), new THREE.Vector3(...axes[2])));
  /** Column-major 4x4 rotation of deg degrees about a unit axis through point c (Rodrigues). */
  function rotMat(axis, deg, c) {
    const a = deg * Math.PI / 180, co = Math.cos(a), si = Math.sin(a), t = 1 - co, x = axis[0], y = axis[1], z = axis[2];
    const R = [t * x * x + co, t * x * y + si * z, t * x * z - si * y, t * x * y - si * z, t * y * y + co, t * y * z + si * x, t * x * z + si * y, t * y * z - si * x, t * z * z + co];
    const tx = c[0] - (R[0] * c[0] + R[3] * c[1] + R[6] * c[2]), ty = c[1] - (R[1] * c[0] + R[4] * c[1] + R[7] * c[2]), tz = c[2] - (R[2] * c[0] + R[5] * c[1] + R[8] * c[2]);
    return [R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, tx, ty, tz, 1];
  }
  const transMat = t => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
  /** What the gizmo is attached to right now: the selected body, or one smooth surface of it. */
  const mvFit = t => fitWpp(t.kind === 'face' ? Math.max(2 * t.radius, 0.25 * t.diag) : t.diag, 2 * (MVX.L + 20), t.center, 56);   // the gizmo spreads both ways from its centre
  const moveProfile = () => (!selected() && S.selProfiles.length === 1) ? profById(S.selProfiles[0]) : null;
  /** The sketch circle picked in Move/Rotate (S.moveCircle is its centre in sketch coordinates), or null. */
  function moveCircleNow() { if (!S.moveCircle || !S.plane) return null; let cs = []; try { cs = circlesIn(allSketchSegs()); } catch (e) { return null; } return cs.find(cc => Math.hypot(cc.c[0] - S.moveCircle[0], cc.c[1] - S.moveCircle[1]) <= 1e-5 * Math.max(1, cc.r)) || null; }
  function moveTargetBase() {
    if (S.tool !== 'move') return null;
    { const cc = moveCircleNow(); if (cc) { const f = plane(); const c = to3(cc.c);
      return { kind: 'scircle', bodyId: 'scircle', cc, center: c, fc: c.slice(), axes: [f.u.slice(), f.v.slice(), f.n.slice()], radius: Math.max(0.05, cc.r), diag: Math.max(0.1, 2 * cc.r) }; } }
    { const q = moveProfile(); if (q) { const c = profCentre(q); let r = 0; for (const L of [q.outer]) for (const p of L) { const w = C.frameToWorld(q.frame, p[0], p[1], 0); r = Math.max(r, Math.hypot(w[0] - c[0], w[1] - c[1], w[2] - c[2])); }
      return withGizmo({ kind: 'profile', profId: q.id, bodyId: 'p' + q.id, center: c, fc: c.slice(), axes: [q.frame.u.slice(), q.frame.v.slice(), q.frame.n.slice()], radius: Math.max(0.05, r), diag: Math.max(0.1, 2 * r) }); } }
    // the active sketch (Shapr3D: select the shape, Move/Rotate): arrows along its plane, rings to tilt it
    if (S.selectedId == null && S.plane && !onFace() && sketchSegments().length) { const c = sketchCentreWorld(); if (c) { const f = plane(); let r = 0; for (const q of sketchSegments().flat()) { const w = C.frameToWorld(f, q[0], q[1], 0); r = Math.max(r, Math.hypot(w[0] - c[0], w[1] - c[1], w[2] - c[2])); }
      return withGizmo({ kind: 'sketch', bodyId: 'sketch', center: c, fc: c.slice(), axes: [f.u.slice(), f.v.slice(), f.n.slice()], radius: Math.max(0.05, r), diag: Math.max(0.1, 2 * r) }); } }
    const b = selected(); if (!b) return null;
    const bb = b.man.boundingBox(); const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1;
    const s = S.moveSurf != null && b.md.surfs ? b.md.surfs[S.moveSurf] : null;
    if (s) {
      let n = s.n, u, v;
      if (s.flat > 0.3) { const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]; u = v3norm(v3cross(ref, n)); v = v3cross(n, u); }
      else { u = [1, 0, 0]; v = [0, 1, 0]; n = [0, 0, 1]; }  // a closed wall has no single normal: use world axes
      let r = 0; const { positions: P, indices: I, surfID } = b.md;
      for (let t = 0; t < surfID.length; t++) if (surfID[t] === S.moveSurf) for (let e = 0; e < 3; e++) { const q = I[t * 3 + e] * 3; r = Math.max(r, Math.hypot(P[q] - s.c[0], P[q + 1] - s.c[1], P[q + 2] - s.c[2])); }
      if (!s.planar) { let cyl = tryGeom(() => C.fitCylinder(b.md, S.moveSurf)); if (!(cyl && cyl.inward) && C.surfCylinder) { const q = C.surfCylinder(b.md, S.moveSurf); if (q && q.hole) cyl = { a: q.c, d: q.a, r: q.r, t0: q.h0, t1: q.h1, inward: true }; } if (cyl && cyl.inward) {   // a round hole: arrows across and along its axis, rings tilt it
        const d = cyl.d; const p1 = v3norm(Math.abs(d[2]) < 0.9 ? [-d[1], d[0], 0] : [0, -d[2], d[1]]); const p2 = v3norm([d[1] * p1[2] - d[2] * p1[1], d[2] * p1[0] - d[0] * p1[2], d[0] * p1[1] - d[1] * p1[0]]);
        const tm = (cyl.t0 + cyl.t1) / 2; const c = [cyl.a[0] + d[0] * tm, cyl.a[1] + d[1] * tm, cyl.a[2] + d[2] * tm];
        return withGizmo({ kind: 'face', bodyId: b.id, surf: S.moveSurf, center: c, fc: c.slice(), n: p1.slice(), axes: [p1, p2, d.slice()], radius: Math.max(0.05, cyl.r * 1.2), planar: false, cyl, diag }); } }
      let gc = s.c.slice();
      if (s.planar && C.circleCentres) { let cl = []; try { cl = C.circleCentres(b.md); } catch (e) { cl = []; } let best = null;   // a round flat face (a cylinder's top): the gizmo sits on its circle's centre
        for (const cc of cl) { const on = Math.abs((cc.p[0] - s.c[0]) * s.n[0] + (cc.p[1] - s.c[1]) * s.n[1] + (cc.p[2] - s.c[2]) * s.n[2]) <= 1e-5 * diag && Math.abs(cc.n[0] * s.n[0] + cc.n[1] * s.n[1] + cc.n[2] * s.n[2]) > 0.999; if (on && cc.r >= 0.5 * r && (!best || cc.r > best.r)) best = cc; }
        if (best) gc = best.p.slice(); }
      return withGizmo({ kind: 'face', bodyId: b.id, surf: S.moveSurf, center: gc, fc: s.c.slice(), n: s.n.slice(), axes: [u, v, n], radius: Math.max(0.05, r), planar: s.planar, diag });
    }
    const bc = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
    return withGizmo({ kind: 'body', bodyId: b.id, center: bc, fc: bc.slice(), axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], radius: diag / 2, diag });
  }
  // A relocated gizmo (Shapr3D: hold Ctrl and drag it; here also the Move gizmo toggle): its centre is the pivot every rotation
  // turns about, and its axes are the directions every move and rotation follows. It belongs to one body or face (key).
  const gizmoKey = t => t.bodyId + ':' + (t.kind === 'face' ? t.surf : t.kind === 'profile' ? 'profile' : t.kind === 'sketch' ? 'sketch' : 'body');
  function withGizmo(t) {
    const g = S.moveGizmo; if (!g) return t;
    if (g.key !== gizmoKey(t)) { S.moveGizmo = null; return t; }
    return { ...t, center: g.center.slice(), axes: g.axes.map(a => a.slice()), relocated: true };
  }
  function moveIdentity(m) { return !m.mode || (m.mode === 'plane' ? Math.hypot(m.du, m.dv) < 1e-9 : Math.abs(m.value) < 1e-9); }
  /** The current transform of the session as a column-major 4x4 matrix. */
  function deltaMatrix(m) {
    const t = m.target;
    if (m.mode === 'rot') return rotMat(t.axes[m.k], m.value, t.center);
    if (m.mode === 'plane') { const pr = m.pair || [0, 1]; const u = t.axes[pr[0]], v = t.axes[pr[1]]; return transMat([u[0] * m.du + v[0] * m.dv, u[1] * m.du + v[1] * m.dv, u[2] * m.du + v[2] * m.dv]); }
    const a = t.axes[m.k]; return transMat([a[0] * m.value, a[1] * m.value, a[2] * m.value]);
  }
  /** The gizmo's frame right now: the session's start frame carried along by the current transform. */
  function liveTarget() {
    if (!MV) return moveTargetBase();
    if (MV.target.kind === 'scircle') { const cc = moveCircleNow(); const t = MV.target; return cc ? { ...t, cc, center: to3(cc.c), axes: t.axes } : t; }   // the gizmo rides on the circle's centre: it never leaves the circle
    const t = MV.target;
    const M = deltaMatrix(MV); const c = C.applyMat(M, t.center[0], t.center[1], t.center[2]);
    const axes = t.axes.map(a => { const q = C.applyMat(M, t.center[0] + a[0], t.center[1] + a[1], t.center[2] + a[2]); return v3norm([q[0] - c[0], q[1] - c[1], q[2] - c[2]]); });
    return { ...t, center: c, axes };
  }
  function setPreviewMatrix(o, M) { for (const obj of [o.mesh, o.lines, o.faceMesh]) if (obj) { obj.matrixAutoUpdate = false; obj.matrix.fromArray(M); obj.matrixWorldNeedsUpdate = true; } }
  function clearPreview(id) { const o = objects.get(id); if (!o) return; for (const obj of [o.mesh, o.lines, o.faceMesh]) if (obj) { obj.matrixAutoUpdate = true; obj.matrix.identity(); obj.position.set(0, 0, 0); obj.quaternion.identity(); obj.scale.set(1, 1, 1); obj.matrixWorldNeedsUpdate = true; } }
  /** After a face move the mesh is rebuilt and surfaces are renumbered: find the moved surface again by position and normal. */
  function resolveSurf(md, center, n) {
    if (!md.surfs) return null; let best = null, bs = Infinity; const diag = C.EDGE_ANGLE ? 1 : 1;
    md.surfs.forEach((s, i) => { const d = Math.hypot(s.c[0] - center[0], s.c[1] - center[1], s.c[2] - center[2]); const dot = s.n[0] * n[0] + s.n[1] * n[1] + s.n[2] * n[2]; const score = d - 0.25 * dot * diag; if (score < bs) { bs = score; best = i; } });
    return best;
  }
  function warnInvalid() { const now = performance.now(); if (now - lastInvalidToast > 1600) { lastInvalidToast = now; toast("Operation failed because the resulting body wouldn't be valid"); } }
  /** Rebuilds the moved body from the pre-session bodies with the current transform (or previews it during a body drag). */
  /** A profile moved (or copied) by the session's transform: its plane frame moves, its shape stays. */
  function applyProfileMove(finalize) {
    const t = MV.target; const src = MV.profBefore.find(q => q.id === t.profId); if (!src) return; const M = deltaMatrix(MV);
    const o = C.applyMat(M, src.frame.origin[0], src.frame.origin[1], src.frame.origin[2]); const dir = a => { const q2 = C.applyMat(M, src.frame.origin[0] + a[0], src.frame.origin[1] + a[1], src.frame.origin[2] + a[2]); return v3norm([q2[0] - o[0], q2[1] - o[1], q2[2] - o[2]]); };
    const frame = { origin: o, u: dir(src.frame.u), v: dir(src.frame.v), n: dir(src.frame.n) };
    if (S.moveCopy && !moveIdentity(MV)) { if (MV.copyId == null) MV.copyId = S.nextProfileId++; S.profiles = [...MV.profBefore, { ...src, id: MV.copyId, name: `Profile ${MV.copyId}`, frame }]; if (finalize) S.selProfiles = [MV.copyId]; }
    else S.profiles = MV.profBefore.map(q => q.id === src.id ? { ...q, frame } : q);
    syncScene(); requestRender();
  }
  /** The picked sketch circle follows the gizmo across its sketch plane (moves along the plane only; turning leaves it as it is). */
  function applyCircleMove(finalize) {
    const t = MV.target; const lines = MV.linesBefore; if (!lines) return; const f = plane(); const M = deltaMatrix(MV);
    const c3 = C.applyMat(M, t.center[0], t.center[1], t.center[2]); const d = [c3[0] - f.origin[0], c3[1] - f.origin[1], c3[2] - f.origin[2]];
    const nc = MV.mode === 'rot' ? t.cc.c.slice() : [d[0] * f.u[0] + d[1] * f.u[1] + d[2] * f.u[2], d[0] * f.v[0] + d[1] * f.v[1] + d[2] * f.v[2]];
    const circ = circlesIn(lines).find(q => Math.hypot(q.c[0] - t.cc.c[0], q.c[1] - t.cc.c[1]) <= 1e-5 * Math.max(1, q.r)); if (!circ) return;
    const segs = circleSegs(nc, circ.r, circ.n); const L = lines.slice(); circ.idx.forEach((i, k) => { L[i] = segs[k]; }); S.sketchLines = L; S.moveCircle = nc;
    syncScene(); requestRender();
  }
  function applySketchMove(finalize) {
    const src = MV.planeBefore; if (!src) return; const M = deltaMatrix(MV);
    const o = C.applyMat(M, src.origin[0], src.origin[1], src.origin[2]); const dir = a => { const q2 = C.applyMat(M, src.origin[0] + a[0], src.origin[1] + a[1], src.origin[2] + a[2]); return v3norm([q2[0] - o[0], q2[1] - o[1], q2[2] - o[2]]); };
    S.plane = moveIdentity(MV) ? src : { ...src, origin: o, u: dir(src.u), v: dir(src.v), n: dir(src.n), bodyId: null, faceId: undefined, loops: undefined, key: 'moved', name: 'Moved sketch plane' };
    syncScene(); requestRender();
  }
  function applyMove(finalize) {
    if (MV && MV.target.kind === 'sketch') { applySketchMove(finalize); return; }
    if (MV && MV.target.kind === 'scircle') { applyCircleMove(finalize); return; }
    if (MV && MV.target.kind === 'profile') { applyProfileMove(finalize); return; }
    if (!MV) return; const t = MV.target; const host = MV.before.find(b => b.id === t.bodyId); if (!host) return;
    const M = deltaMatrix(MV); const key = M.map(v => Math.round(v * 1e6)).join(',') + (finalize ? 'F' : '');
    if (key === MV.lastKey) return; MV.lastKey = key;
    const identity = moveIdentity(MV);
    if (t.kind === 'body' && S.moveCopy && !finalize) { S.bodies = MV.before; syncSceneLight(); xtGhost(host, M); requestRender(); return; }   // Copy: a copy turns with the finger, the original stays
    if (finalize) xtGhost(null);
    if (t.kind === 'body' && !S.moveCopy && !finalize) { // live preview: only the drawn meshes move
      S.bodies = MV.before; syncSceneLight(); const o = objects.get(host.id); if (o) setPreviewMatrix(o, M); MV.previewed = true; requestRender(); return;
    }
    let bodies = MV.before;
    if (!identity) {
      if (t.kind === 'body') {
        const man = tryGeom(() => C.transformSolid(host.man, M)); if (!man) return;
        let md; try { md = C.meshData(man); } catch (e) { return; }
        if (S.moveCopy) { if (MV.copyId == null) { MV.copyId = S.nextId++; MV.copyColor = S.colorIdx++; } bodies = [...bodies, { id: MV.copyId, name: `Copy ${MV.copyId}`, color: PALETTE[MV.copyColor % PALETTE.length], man, md }]; }
        else bodies = bodies.map(b => b.id === host.id ? { ...b, man, md } : b);
      } else {
        const keys = MV.keys; const test = (x, y, z) => keys.has(C.fkey(x, y, z));
        // faces around the moved one bend into smooth surfaces instead of folding (lighter while dragging, full quality on release)
        // a flat face whose walls run straight along its normal behaves as in Shapr3D: it is a plane, and moving or turning
        // it re-cuts the walls (they stay straight, a cylinder top becomes a slanted cut). Other cases bend the walls.
        let pf = t.planar && C.movePlanarFace ? tryGeom(() => C.movePlanarFace(host.man, host.md, t.surf, M, { live: !finalize })) : null;
        if (!pf && !t.planar && C.moveCylinderFace) { const rb = tryGeom(() => C.moveCylinderFace(host.man, host.md, t.surf, M, { live: !finalize })); if (rb) pf = rb; }   // a round hole (recognised even when booleans left slivers on its wall)
        if (!pf && !t.planar) { if (MV.cyl === undefined) MV.cyl = tryGeom(() => C.fitCylinder(host.md, t.surf)) || null; if (MV.cyl && MV.cyl.inward) { // a hole moves and turns as a feature: filled, then cut again along its new axis — a through hole stays through, its ends trimmed by the faces it meets
            const rb = C.moveCylinderFace ? tryGeom(() => C.moveCylinderFace(host.man, host.md, t.surf, M, { live: !finalize })) : null;
            if (rb) pf = rb; else { const solid = tryGeom(() => C.moveHole(host.man, MV.cyl, M)); if (!solid) return; pf = { ok: true, solid }; } }
          else { const solid = tryGeom(() => C.transformSurface(host.man, host.md, t.surf, M)); if (solid) pf = { ok: true, solid }; } }   // any outer wall (cylinder, cone, drafted…) moves and turns as one surface, re-cut by the other faces
        if (!pf && t.planar) { const solid = tryGeom(() => C.transformSurface(host.man, host.md, t.surf, M)); if (solid) pf = { ok: true, solid }; }   // a flat face whose walls are not straight: still one surface
        const r = pf || tryGeom(() => (C.deformWarp ? C.deformWarp(host.man, host.md, M, test, { live: !finalize }) : null) || C.warpChecked(host.man, M, test)); if (!r) return;
        if (!r.ok) { MV.invalid = true; warnInvalid(); return; }   // the last valid result stays on screen
        let md; try { md = C.meshData(r.solid); } catch (e) { return; }
        if (MV.lastLive && MV.lastLive !== r.solid && MV.lastLive !== host.man) freeMan(MV.lastLive); MV.lastLive = r.solid;   // the previous live frame's solid goes back to the engine now
        bodies = bodies.map(b => b.id === host.id ? { ...b, man: r.solid, md } : b);
        MV.valid = { mode: MV.mode, value: MV.value, du: MV.du, dv: MV.dv, raw: MV.raw };
        const c = C.applyMat(M, t.fc[0], t.fc[1], t.fc[2]); const q = C.applyMat(M, t.fc[0] + t.n[0], t.fc[1] + t.n[1], t.fc[2] + t.n[2]);
        const cs = r.cyl && C.findCylSurf ? C.findCylSurf(md, r.cyl) : null;   // the moved hole, found by its own axis and radius
        S.moveSurf = cs != null ? cs : resolveSurf(md, c, v3norm([q[0] - c[0], q[1] - c[1], q[2] - c[2]]));
      }
    }
    MV.invalid = false; if (MV.previewed) { clearPreview(host.id); MV.previewed = false; }
    if (finalize && !identity && t.relocated && !S.moveCopy) { // the relocated gizmo stays where it was put, carried by the move
      const c = C.applyMat(M, t.center[0], t.center[1], t.center[2]); const axes = t.axes.map(a => { const q = C.applyMat(M, t.center[0] + a[0], t.center[1] + a[1], t.center[2] + a[2]); return v3norm([q[0] - c[0], q[1] - c[1], q[2] - c[2]]); });
      S.moveGizmo = { key: t.bodyId + ':' + (t.kind === 'face' ? S.moveSurf : 'body'), center: c, axes };
    }
    if (finalize && !identity && t.relocated && S.moveCopy && t.kind === 'body' && MV.copyId != null) { // the newest copy takes the gizmo with it (its centre turned with it)
      const c = C.applyMat(M, t.center[0], t.center[1], t.center[2]); const axes = t.axes.map(a => { const q = C.applyMat(M, t.center[0] + a[0], t.center[1] + a[1], t.center[2] + a[2]); return v3norm([q[0] - c[0], q[1] - c[1], q[2] - c[2]]); });
      S.moveGizmo = { key: MV.copyId + ':body', center: c, axes };
    }
    S.bodies = bodies; if (S.moveCopy && MV.copyId != null && !identity && finalize) S.selectedId = MV.copyId;
    syncSceneLight(); if (t.kind === 'face') { const b = selected(); const o = b && objects.get(b.id); if (b && o) syncFaceHighlight(b, o, true); }
  }
  /** Screen distance from (x,y) to the projected segment a–b. */
  function segDistPx(a, b, x, y) { const A = project(a), B = project(b); const dx = B.x - A.x, dy = B.y - A.y; const L2 = dx * dx + dy * dy || 1; const tt = Math.max(0, Math.min(1, ((x - A.x) * dx + (y - A.y) * dy) / L2)); return Math.hypot(A.x + dx * tt - x, A.y + dy * tt - y); }
  /** Which move-gizmo handle is under a screen point: {mode:'plane'} | {mode:'rot',k} | {mode:'axis',k} | null. */
  function hitMoveGizmo(x, y) {
    if (!MVX.grp.visible) return null; const t = liveTarget(); if (!t) return null;
    const wpp = mvFit(t).wpp; const c = t.center; const ax = t.axes;
    const at = (d, k) => [c[0] + d[0] * k * wpp, c[1] + d[1] * k * wpp, c[2] + d[2] * k * wpp];
    // nearest handle wins (the centre included, so a foreshortened arc next to it can still be grabbed); arrows get a small bonus because their shafts are thin
    let best = null; const consider = (d, limit, h) => { if (d < limit && (!best || d < best.d)) best = { d, ...h }; };
    const P = project(c); consider(Math.hypot(P.x - x, P.y - y) - 3, 14, { mode: 'plane' });
    for (const [i, j] of MVX.pairs) { const q = project([c[0] + (ax[i][0] + ax[j][0]) * MVX.PQ * wpp, c[1] + (ax[i][1] + ax[j][1]) * MVX.PQ * wpp, c[2] + (ax[i][2] + ax[j][2]) * MVX.PQ * wpp]); if (q.ok) consider(Math.hypot(q.x - x, q.y - y) - 2, 12, { mode: 'plane', pair: [i, j] }); }
    for (let k = 0; k < 3; k++) consider(segDistPx(at(ax[k], 12), at(ax[k], MVX.L + 12), x, y) - 4, 16, { mode: 'axis', k });
    for (let k = 0; k < 3; k++) {
      const e1 = ax[(k + 1) % 3], e2 = ax[(k + 2) % 3]; let dm = Infinity;
      for (let i = 0; i <= 12; i++) { const a = MVX.arc0 + (MVX.arc1 - MVX.arc0) * i / 12; const q = project(at([Math.cos(a) * e1[0] + Math.sin(a) * e2[0], Math.cos(a) * e1[1] + Math.sin(a) * e2[1], Math.cos(a) * e1[2] + Math.sin(a) * e2[2]], MVX.R)); dm = Math.min(dm, Math.hypot(q.x - x, q.y - y)); }
      consider(dm, 17, { mode: 'rot', k });
    }
    return best;
  }
  const rotFrame = (t, k) => ({ origin: t.center, u: t.axes[(k + 1) % 3], v: t.axes[(k + 2) % 3], n: t.axes[k] });
  const viewDir = () => { const d = new THREE.Vector3().subVectors(cam.target, camera.position).normalize(); return [d.x, d.y, d.z]; };
  /** Finger angle (degrees) around the rotation axis: on the ring's plane when it faces the camera, else in screen space. */
  function rotAngleAt(t, k, x, y, ray) {
    const F = rotFrame(t, k); const d = viewDir(); const facing = Math.abs(d[0] * F.n[0] + d[1] * F.n[1] + d[2] * F.n[2]);
    if (facing > 0.3) { const q = C.planeHit2D(F, ray.o, ray.d); if (q) return Math.atan2(q[1], q[0]) * 180 / Math.PI; }
    const P = project(t.center); const toward = d[0] * F.n[0] + d[1] * F.n[1] + d[2] * F.n[2] < 0 ? 1 : -1;
    return toward * Math.atan2(-(y - P.y), x - P.x) * 180 / Math.PI;
  }
  /** Finger position in the gizmo's (u,v) plane; when that plane is edge-on, the finger moves in the screen plane instead. */
  function planePointAt(t, ray, pair) {
    const pr = pair || [0, 1]; const F = { origin: t.center, u: t.axes[pr[0]], v: t.axes[pr[1]], n: t.axes[3 - pr[0] - pr[1]] }; const d = viewDir();
    if (Math.abs(d[0] * F.n[0] + d[1] * F.n[1] + d[2] * F.n[2]) > 0.25) { const q = C.planeHit2D(F, ray.o, ray.d); if (q) return q; }
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(...d), new THREE.Vector3(0, 0, 1)).normalize(); const up = new THREE.Vector3().crossVectors(right, new THREE.Vector3(...d)).normalize();
    const q = C.planeHit2D({ origin: t.center, u: [right.x, right.y, right.z], v: [up.x, up.y, up.z], n: d }, ray.o, ray.d); if (!q) return null;
    const w = [right.x * q[0] + up.x * q[1], right.y * q[0] + up.y * q[1], right.z * q[0] + up.z * q[1]];
    return [w[0] * F.u[0] + w[1] * F.u[1] + w[2] * F.u[2], w[0] * F.v[0] + w[1] * F.v[1] + w[2] * F.v[2]];
  }
  const snapDist = v => Math.round(v * 10) / 10;
  const snapAngle = raw => { let r = Math.round(raw); const m = Math.round(raw / 15) * 15; if (Math.abs(raw - m) < 2.5) r = m; return r; };
  let GZR = null; // gizmo relocation drag
  function beginGizmoRelocate(h, x, y) {
    if (MV) endMove();   // an open session keeps its own frame: close it so the gizmo itself can move
    const t = liveTarget(); if (!t) return false; const b = selected(); const ray = rayAt(x, y);
    GZR = { h, key: gizmoKey(t), center: t.center.slice(), axes: t.axes.map(a => a.slice()), t, snaps: b ? C.scaleSnapPoints(b.md) : [], circ: b ? (() => { let o = []; try { o = C.circleCentres ? C.circleCentres(b.md).map(cc => cc.p) : []; } catch (e) { o = []; } try { o = o.concat(xtAxisCentres(b.md)); } catch (e) { /* none */ } return o; })() : [] };
    if (t.kind === 'face') GZR.snaps.push(t.fc.slice());
    if (h.mode === 'axis') GZR.p0 = axisParam(ray, t.center, t.axes[h.k]);
    else if (h.mode === 'plane') GZR.q0 = planePointAt(t, ray) || [0, 0];
    else { GZR.prev = rotAngleAt(t, h.k, x, y, ray); GZR.raw = 0; }
    return true;
  }
  function moveGizmoRelocate(x, y) {
    if (!GZR) return; const t = GZR.t, h = GZR.h; const ray = rayAt(x, y); let center = GZR.center.slice(), axes = GZR.axes.map(a => a.slice());
    if (h.mode === 'axis') { const d = snapDist(axisParam(ray, t.center, t.axes[h.k]) - GZR.p0); const a = t.axes[h.k]; center = [center[0] + a[0] * d, center[1] + a[1] * d, center[2] + a[2] * d]; }
    else if (h.mode === 'plane') {
      let best = null; for (const q of GZR.circ || []) { const c = project(q); if (!c.ok) continue; const dd = Math.hypot(c.x - x, c.y - y); if (dd < 26 && (!best || dd < best.d)) best = { q, d: dd }; }   // a circle's centre (a cylinder's axis) wins over corners and face centres
      if (!best) for (const q of GZR.snaps) { const c = project(q); if (!c.ok) continue; const dd = Math.hypot(c.x - x, c.y - y); if (dd < 20 && (!best || dd < best.d)) best = { q, d: dd }; }
      if (best) { center = best.q.slice(); mvSnapAt = best.q.slice(); showMvSnap(); } else if (mvSnapAt) { mvSnapAt = null; showMvSnap(); }
      else { const hit = C.rayMesh(selected().md, ray.o, ray.d); if (hit) center = hit.point.slice(); else { const q = planePointAt(t, ray); if (q) { const u = t.axes[0], v = t.axes[1], du = q[0] - GZR.q0[0], dv = q[1] - GZR.q0[1]; center = [center[0] + u[0] * du + v[0] * dv, center[1] + u[1] * du + v[1] * dv, center[2] + u[2] * du + v[2] * dv]; } } }
    } else {
      const a = rotAngleAt(t, h.k, x, y, ray); let d = a - GZR.prev; while (d > 180) d -= 360; while (d < -180) d += 360; GZR.prev = a; GZR.raw += d;
      const R = rotMat(t.axes[h.k], snapAngle(GZR.raw), [0, 0, 0]); axes = GZR.axes.map(v => v3norm(C.applyMat(R, v[0], v[1], v[2])));
    }
    S.moveGizmo = { key: GZR.key, center, axes }; requestRender();
  }
  function endGizmoRelocate() { if (!GZR) return; GZR = null; renderUI(); requestRender(); }
  /** Starts a session (one undo step) on the current selection. */
  function startMoveSession(mode, k) {
    if (MV) endMove();
    const t = moveTargetBase(); if (!t) return null;
    record(t.kind === 'scircle' ? 'Move circle' : t.kind === 'sketch' ? `${mode === 'rot' ? 'Rotate' : 'Move'} sketch` : t.kind === 'profile' ? `${mode === 'rot' ? 'Rotate' : 'Move'} ${(profById(t.profId) || { name: 'profile' }).name}${S.moveCopy ? ' (copy)' : ''}` : `${mode === 'rot' ? 'Rotate' : 'Move'} ${t.kind === 'face' ? 'face of ' : ''}${(S.bodies.find(b => b.id === t.bodyId) || { name: '' }).name}${S.moveCopy && t.kind === 'body' ? ' (copy)' : ''}`);
    if (t.kind === 'scircle' && typeof flattenSketch === 'function') flattenSketch();
    MV = { linesBefore: S.sketchLines ? S.sketchLines.slice() : null, planeBefore: S.plane ? { ...S.plane, origin: S.plane.origin.slice(), u: S.plane.u.slice(), v: S.plane.v.slice(), n: S.plane.n.slice() } : null, profBefore: S.profiles, target: t, before: S.bodies, mode, k, value: 0, du: 0, dv: 0, raw: 0, lastKey: '', drag: false, invalid: false, valid: null, keys: t.kind === 'face' ? C.surfaceVertexKeys(selected().md, t.surf) : null };
    return MV;
  }
  /** Turns a sketch circle into a profile on the same plane and selects it (one undo step), so it can be lifted or tilted. */
  function liftCircleToProfile(cc0) {
    if (typeof flattenSketch === 'function') flattenSketch();
    const circ = circlesIn(S.sketchLines || []).find(q => Math.hypot(q.c[0] - cc0.c[0], q.c[1] - cc0.c[1]) <= 1e-5 * Math.max(1, q.r)); if (!circ) return false;
    const pts = Array.from({ length: circ.n }, (_, i) => { const a = 2 * Math.PI * i / circ.n; return [circ.c[0] + circ.r * Math.cos(a), circ.c[1] + circ.r * Math.sin(a)]; });
    const q = newProfile(pts, [], plane()); const drop = new Set(circ.idx);
    record('Circle to profile'); S.sketchLines = S.sketchLines.filter((_, i) => !drop.has(i)); S.profiles = [...(S.profiles || []), q];
    S.moveCircle = null; S.selectedId = null; S.moveSurf = null; S.selectedFace = null; S.selProfiles = [q.id]; syncScene(); renderUI();
    return true;
  }
  function beginMoveDrag(h, x, y) {
    { const t0 = moveTargetBase(); if (t0 && t0.kind === 'scircle' && (h.mode === 'rot' || (h.mode === 'axis' && h.k === 2) || (h.mode === 'plane' && h.pair && h.pair.includes(2)))) {
      // lifting or turning takes the circle off its sketch plane: it becomes a profile (a shape with its own plane) and moves as one
      if (!liftCircleToProfile(t0.cc)) return false; } }
    const m = startMoveSession(h.mode, h.k); if (!m) return false; m.drag = true;
    const ray = rayAt(x, y); const t = m.target;
    if (h.mode === 'axis') m.p0 = axisParam(ray, t.center, t.axes[h.k]);
    else if (h.mode === 'plane') { m.pair = h.pair || null; m.q0 = planePointAt(t, ray, m.pair) || [0, 0]; }
    else { m.prev = rotAngleAt(t, h.k, x, y, ray); m.a0 = m.prev; }
    syncScene(); return true;
  }
  function moveMoveDrag(x, y) {
    if (!MV || !MV.drag) return; const t = MV.target; const ray = rayAt(x, y);
    if (t.kind === 'scircle' && (MV.mode === 'rot' || (MV.mode === 'axis' && MV.k === 2))) return;   // a sketch circle only slides across its plane
    if (MV.mode === 'axis') MV.value = snapDist(axisParam(ray, t.center, t.axes[MV.k]) - MV.p0);
    else if (MV.mode === 'plane') { const q = planePointAt(t, ray, MV.pair); if (!q) return; MV.du = snapDist(q[0] - MV.q0[0]); MV.dv = snapDist(q[1] - MV.q0[1]); }
    else { const a = rotAngleAt(t, MV.k, x, y, ray); let d = a - MV.prev; while (d > 180) d -= 360; while (d < -180) d += 360; MV.prev = a; MV.raw += d; MV.value = snapAngle(MV.raw); }
    if (MV.mode !== 'rot') snapMoveToCentre(MV);
    applyMove(false);
  }
  /** Centres a moved thing may land on: round edges of the bodies (a cylinder's top, a hole's mouth), sketch circles, profiles. */
  function centreTargets(t) {
    const out = []; const bodies = (MV && MV.before) || S.bodies;
    for (const b of bodies) { if (t.kind === 'body' && b.id === t.bodyId) continue; let cs = []; try { cs = C.circleCentres ? C.circleCentres(b.md) : []; } catch (e) { cs = []; } for (const cc of cs) out.push(cc.p); }
    if (t.kind === 'scircle' && MV && MV.linesBefore) { try { for (const cc of circlesIn(MV.linesBefore)) if (Math.hypot(cc.c[0] - t.cc.c[0], cc.c[1] - t.cc.c[1]) > 1e-5 * Math.max(1, cc.r)) out.push(to3(cc.c)); } catch (e) { /* no sketch */ } }   // the other circles, never the moving one
    else if (t.kind !== 'sketch' && S.plane) { try { for (const cc of circlesIn(allSketchSegs())) out.push(to3(cc.c)); } catch (e) { /* no sketch */ } }
    if (typeof profCentre === 'function') for (const q of S.profiles || []) if (!(t.kind === 'profile' && q.id === t.profId)) { try { out.push(profCentre(q)); } catch (e) { /* skip */ } }
    return out;
  }
  /** While dragging an arrow or the centre, the moved centre clicks onto a nearby centre (within ~18 px on screen). */
  let mvSnapAt = null;
  const mvSnapMark = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xff9a2e, size: 16, sizeAttenuation: false, depthTest: false })); mvSnapMark.renderOrder = 14;
  function snapMoveToCentre(m) {
    mvSnapAt = null; showMvSnap(); const t = m.target; const M = deltaMatrix(m); const c = C.applyMat(M, t.center[0], t.center[1], t.center[2]); const pc = project(c); if (!pc.ok) return;
    const dot0 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let best = null; for (const w of centreTargets(t)) { const dw = [w[0] - t.center[0], w[1] - t.center[1], w[2] - t.center[2]]; if (t.kind === 'face' && Math.hypot(dot0(dw, t.axes[0]), dot0(dw, t.axes[1])) < 1e-6 * Math.max(1, t.radius)) continue;   // the hole's own rims
      const P = project(w); if (!P.ok) continue; const d = Math.hypot(P.x - pc.x, P.y - pc.y); if (d < 18 && (!best || d < best.d)) best = { d, w }; }
    if (!best && m.mode === 'axis' && (t.kind === 'profile' || t.kind === 'scircle' || t.kind === 'sketch')) {   // lifting / lowering a shape: it clicks onto the plane of a flat face it crosses
      const ax = t.axes[m.k]; let bp = null;
      for (const b of (m.before || S.bodies)) for (const sf of (b.md && b.md.surfs) || []) { if (!sf.planar) continue; const dn = ax[0] * sf.n[0] + ax[1] * sf.n[1] + ax[2] * sf.n[2]; if (Math.abs(dn) < 0.99) continue;
        const vv = ((sf.c[0] - t.center[0]) * sf.n[0] + (sf.c[1] - t.center[1]) * sf.n[1] + (sf.c[2] - t.center[2]) * sf.n[2]) / dn; const w = [t.center[0] + ax[0] * vv, t.center[1] + ax[1] * vv, t.center[2] + ax[2] * vv]; const P = project(w); if (!P.ok) continue;
        const dd = Math.hypot(P.x - pc.x, P.y - pc.y); if (dd < 14 && (!bp || dd < bp.d)) bp = { d: dd, v: vv, w }; }
      if (bp) { m.value = bp.v; mvSnapAt = bp.w; showMvSnap(); }
      return; }
    if (!best) return; const d = [best.w[0] - t.center[0], best.w[1] - t.center[1], best.w[2] - t.center[2]]; const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    if (m.mode === 'plane') { const pr = m.pair || [0, 1]; m.du = dot(d, t.axes[pr[0]]); m.dv = dot(d, t.axes[pr[1]]); }
    else if (m.mode === 'axis') { const v = dot(d, t.axes[m.k]); const off = Math.hypot(d[0] - v * t.axes[m.k][0], d[1] - v * t.axes[m.k][1], d[2] - v * t.axes[m.k][2]); if (off > 1e-6 * Math.max(1, Math.hypot(...d)) && best.d > 10) return; m.value = v; }
    mvSnapAt = best.w.slice(); showMvSnap();
  }
  function showMvSnap() { mvSnapMark.geometry.dispose(); mvSnapMark.geometry = new THREE.BufferGeometry().setFromPoints(mvSnapAt ? [new THREE.Vector3(...mvSnapAt)] : []); mvSnapMark.visible = !!mvSnapAt; if (!mvSnapMark.parent) scene.add(mvSnapMark); requestRender(); }
  function endMoveDrag() {
    mvSnapAt = null; showMvSnap(); if (!MV) return; MV.drag = false;
    if (MV.invalid) { if (MV.valid) { MV.value = MV.valid.value; MV.du = MV.valid.du; MV.dv = MV.valid.dv; MV.raw = MV.valid.raw; } else { MV.value = 0; MV.du = 0; MV.dv = 0; MV.raw = 0; } }
    applyMove(true);
    if (MV && MV.invalid) { MV.value = 0; MV.du = 0; MV.dv = 0; MV.raw = 0; MV.invalid = false; S.bodies = MV.before; applyMove(true); }   // nothing valid to keep: the body stays as it was
    if (MV && moveIdentity(MV)) MV = null;
    save(); syncScene();
  }
  /** Commits the session (the result is already in S.bodies) and hides the value label. */
  function endMove() { mvSnapAt = null; showMvSnap(); try { xtGhost(null); } catch (e) { /* not set up */ } if (!MV) return; const xm = xMoveCapture(); if (MV.drag) { MV.drag = false; applyMove(true); } MV = null; moveEditing = false; moveEl.hidden = true; if (xm) xAfterMove(xm); save(); }
  /** Typed transform from the panel: move S.moveTyped units along, or rotate S.moveTyped degrees about, the chosen axis. */
  function typedMove(mode) {
    const v = S.moveTyped; if (!(Math.abs(v) > 0)) { toast('Enter a value first'); return; }
    const m = startMoveSession(mode, S.moveAxis); if (!m) return; m.value = v; m.raw = v;
    applyMove(true); if (m.invalid) { toast("Operation failed because the resulting body wouldn't be valid"); MV = null; S.bodies = m.before; H.past.pop(); }   // nothing changed: no undo step
    save(); syncScene();
  }
  /** Positions the gizmo, the drag guides (dashed axis or ring + swept arc) and the value label each frame. */
  function syncMoveGizmo() {
    const t = liveTarget();
    try { xtGizmoUi(t); } catch (e) { /* buttons only */ }
    const hide = () => { MVX.axisLine.visible = false; MVX.bigRing.visible = false; MVX.band.visible = false; if (!moveEditing) moveEl.hidden = true; };
    if (!t) { MVX.grp.visible = false; hide(); return; }
    const wpp = mvFit(t).wpp;
    MVX.grp.position.set(t.center[0], t.center[1], t.center[2]); MVX.grp.quaternion.copy(axisQuat(t.axes)); MVX.grp.scale.set(wpp, wpp, wpp); MVX.grp.visible = true;
    MVX.arrows.forEach(g => { g.visible = true; }); MVX.rings.forEach(g => { g.visible = true; });   // the full gizmo for every target (a sketch circle too)
    const cols = t.kind === 'body' || t.kind === 'sketch' || t.kind === 'scircle' || t.kind === 'profile' ? [0xd9605f, 0x67bd6b, 0x5c9eed] : [0xe8ebf0, 0xe8ebf0, 0x2f6fed];
    MVX.planes.forEach((sq, n) => { const [i, j] = MVX.pairs[n]; const mix = new THREE.Color(cols[i]).lerp(new THREE.Color(cols[j]), 0.5); sq.material.color.copy(mix); sq.material.opacity = MV && MV.drag && !(MV.mode === 'plane' && MV.pair && MV.pair[0] === i && MV.pair[1] === j) ? 0.2 : 0.85; sq.visible = true; });
    for (let k = 0; k < 3; k++) { MVX.mats[k].color.setHex(cols[k]); MVX.mats[k].opacity = MV && MV.drag && MV.mode !== 'plane' && MV.k !== k ? 0.22 : 0.96; }
    MVX.center.material.opacity = MV && MV.drag && MV.mode !== 'plane' ? 0.35 : 0.96; MVX.center.material.color.setHex(S.moveGizmoEdit || GZR ? 0xf29a2e : 0xffffff);
    if (!MV || (!MV.drag && moveIdentity(MV))) { hide(); return; }
    const t0 = MV.target; let anchor, text;
    if (MV.mode === 'rot') {
      const e1 = t0.axes[(MV.k + 1) % 3], e2 = t0.axes[(MV.k + 2) % 3], c = t0.center; const Rw = Math.max(t0.radius * 1.05, 46 * wpp);
      const on = a => new THREE.Vector3(c[0] + Rw * (Math.cos(a) * e1[0] + Math.sin(a) * e2[0]), c[1] + Rw * (Math.cos(a) * e1[1] + Math.sin(a) * e2[1]), c[2] + Rw * (Math.cos(a) * e1[2] + Math.sin(a) * e2[2]));
      const pts = []; for (let i = 0; i <= 96; i++) pts.push(on(2 * Math.PI * i / 96));
      MVX.bigRing.geometry.dispose(); MVX.bigRing.geometry = new THREE.BufferGeometry().setFromPoints(pts); MVX.bigRing.computeLineDistances(); MVX.bigRing.material.dashSize = 6 * wpp; MVX.bigRing.material.gapSize = 4 * wpp; MVX.bigRing.visible = true;
      const a0 = (MV.a0 || 0) * Math.PI / 180, sweep = MV.value * Math.PI / 180;
      if (Math.abs(sweep) > 1e-6) { MVX.band.geometry.dispose(); MVX.band.geometry = new THREE.RingGeometry(Rw - 2.2 * wpp, Rw + 2.2 * wpp, Math.max(8, Math.round(Math.abs(MV.value) / 3)), 1, sweep > 0 ? a0 : a0 + sweep, Math.abs(sweep)); MVX.band.position.set(c[0], c[1], c[2]); MVX.band.quaternion.copy(axisQuat([e1, e2, t0.axes[MV.k]])); MVX.band.visible = true; } else MVX.band.visible = false;
      MVX.axisLine.visible = false; anchor = on(a0 + sweep); anchor = [anchor.x, anchor.y, anchor.z]; text = `${MV.value}°`;
    } else {
      const c0 = t0.center, c1 = t.center;
      MVX.axisLine.geometry.dispose(); MVX.axisLine.geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...c0), new THREE.Vector3(...c1)]); MVX.axisLine.computeLineDistances(); MVX.axisLine.material.dashSize = 6 * wpp; MVX.axisLine.material.gapSize = 4 * wpp; MVX.axisLine.visible = true;
      MVX.bigRing.visible = false; MVX.band.visible = false;
      const d = MV.mode === 'plane' ? Math.hypot(MV.du, MV.dv) : Math.abs(MV.value);
      anchor = MV.mode === 'axis' ? [c1[0] + t.axes[MV.k][0] * (MVX.L + 18) * wpp, c1[1] + t.axes[MV.k][1] * (MVX.L + 18) * wpp, c1[2] + t.axes[MV.k][2] * (MVX.L + 18) * wpp] : c1; text = fmtDim(d);
    }
    if (S.moveCopy && t.kind === 'body') text += ' · Copy';
    if (MV.invalid) text += ' · invalid';
    if (!moveEditing) { const p = project(anchor); moveEl.hidden = !p.ok; moveEl.textContent = text; moveEl.className = MV.drag ? 'live' : (MV.mode === 'plane' ? 'fixed' : 'editable'); const w = moveEl.offsetWidth || 60, hh = moveEl.offsetHeight || 22; moveEl.style.left = Math.max(6, Math.min(innerWidth - w - 6, p.x + 26)) + 'px'; moveEl.style.top = Math.max(hh, Math.min(innerHeight - hh, p.y - 6)) + 'px'; }
  }
  /** Tap the value after a drag to type the exact distance or angle for that drag. */
  moveEl.onclick = () => {
    if (!MV || MV.drag || MV.mode === 'plane') return;
    const m = MV; const v0 = m.value; moveEditing = true; moveEl.className = 'live';
    const inp = document.createElement('input'); inp.type = 'number'; inp.step = 'any'; inp.inputMode = 'decimal'; inp.value = Math.round(Math.abs(v0) * 100) / 100; moveEl.replaceChildren(inp);
    const done = apply => { moveEditing = false; const v = parseFloat(inp.value); if (apply && !isNaN(v) && MV === m) { m.value = (v0 < 0 ? -1 : 1) * v; m.raw = m.value; applyMove(true); if (m.invalid) { toast("Operation failed because the resulting body wouldn't be valid"); m.value = v0; m.raw = v0; applyMove(true); } save(); } syncScene(); requestRender(); };
    inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') done(false); };
    inp.onblur = () => { if (moveEditing) done(true); };
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
  };
  // ---------- Scale (Shapr3D-style): uniform knob or six non-uniform handles, a pivot that snaps to the body ----------
  // SC: { bodyId, mode 'uniform'|'non', s [sx,sy,sz] (factors of the last/current drag), pivot, active handle, copy,
  //       drag, base (body record at drag start), d0 (handle distance at 1×), axis, snaps }
  let SC = null; let pendingSc = null; let scEditing = false;
  const PLATE_SIZE = 36;   // px: the plane plates are big and grabbed anywhere on their surface
  const scPrefs = { mode: 'uniform' };
  const SCX = { grp: new THREE.Group() };
  {
    const white = new THREE.MeshBasicMaterial({ color: 0xf2f4f8, depthTest: false, transparent: true, opacity: 0.97 });
    const blue = new THREE.MeshBasicMaterial({ color: 0x2f6fed, depthTest: false, transparent: true, opacity: 0.97 });
    const green = new THREE.MeshBasicMaterial({ color: 0x35c46a, depthTest: false, transparent: true, opacity: 0.97 });
    const knob = () => { const g = new THREE.Group(); const stem = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 18, 10), white); stem.position.y = -9; const cap = new THREE.Mesh(new THREE.BoxGeometry(16, 6, 6), white); g.add(stem, cap); g.userData.parts = [stem, cap]; return g; };
    const plateMat = () => new THREE.MeshBasicMaterial({ color: 0xf2f4f8, depthTest: false, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    const plate = dims => { const m = new THREE.Mesh(new THREE.BoxGeometry(...dims), plateMat()); m.userData.parts = [m]; m.userData.plate = true; return m; };
    SCX.u = knob(); SCX.x = knob(); SCX.y = knob(); SCX.z = knob(); SCX.xy = plate([PLATE_SIZE, PLATE_SIZE, 2.5]); SCX.yz = plate([2.5, PLATE_SIZE, PLATE_SIZE]); SCX.xz = plate([PLATE_SIZE, 2.5, PLATE_SIZE]);
    SCX.pivot = new THREE.Mesh(new THREE.SphereGeometry(6, 16, 12), green); SCX.ghost = new THREE.Mesh(new THREE.SphereGeometry(4, 12, 10), new THREE.MeshBasicMaterial({ color: 0x35c46a, depthTest: false, transparent: true, opacity: 0.45 }));
    SCX.stem = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x9aa3b2, depthTest: false, transparent: true, opacity: 0.9 })); SCX.stem.renderOrder = 21;
    for (const k of ['u', 'x', 'y', 'z', 'xy', 'yz', 'xz', 'pivot', 'ghost']) { SCX.grp.add(SCX[k]); SCX[k].traverse(o => { o.renderOrder = 22; }); }
    SCX.mats = { white, blue }; scene.add(SCX.grp, SCX.stem); SCX.grp.visible = false; SCX.stem.visible = false;
  }
  const scLabel = document.createElement('div'); scLabel.id = 'sc-label'; scLabel.className = 'fil-pill'; scLabel.hidden = true; document.body.appendChild(scLabel);
  const scCopy = document.createElement('button'); scCopy.id = 'sc-copy'; scCopy.className = 'fil-pill'; scCopy.hidden = true; scCopy.textContent = 'Copy'; document.body.appendChild(scCopy);
  { const st = document.createElement('style'); st.textContent = `#sc-label { cursor: pointer; text-decoration: underline dotted; } #sc-label.live { text-decoration: none; } #sc-label input { width: 64px; font: inherit; border: 0; background: transparent; color: var(--fg); outline: none; }
    #sc-copy { font-family: inherit; cursor: pointer; border-color: #8a93a3; } #sc-copy.on { border-color: #2f6fed; background: #2f6fed; color: #fff; }`; document.head.appendChild(st); }
  const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const scAlive = () => { if (SC && !S.bodies.some(b => b.id === SC.bodyId)) scDrop(); return !!SC; };
  const scActive = () => scAlive() && S.tool === 'select';
  const scBody = () => SC ? S.bodies.find(b => b.id === SC.bodyId) : null;
  const scFit = () => { const b = SC && (SC.base && SC.drag ? SC.base : scBody()); const bb = b ? b.man.boundingBox() : null; const d = bb ? Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) : 1; return fitWpp(d, 2 * (SC && SC.mode === 'non' ? PLATE_PX + PLATE_SIZE / 2 : KNOB_PX + 10), SC ? SC.pivot : null, 56); };
  function scDrop() { if (!SC) return; if (SC.drag) clearPreview(SC.bodyId); SC = null; pendingSc = null; scEditing = false; scLabel.hidden = true; scCopy.hidden = true; SCX.grp.visible = false; SCX.stem.visible = false; }
  /** Opens Scale on a body: pivot at its centre, factors 1×. */
  function startScale(body) {
    if (FL) commitFil(false); if (SESSION) endSession(); if (MV) endMove(); const bb = body.man.boundingBox();
    SC = { bodyId: body.id, mode: scPrefs.mode, s: [1, 1, 1], pivot: [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2], active: scPrefs.mode === 'uniform' ? 'u' : 'z', copy: false, drag: null, base: null, snaps: null };
    S.selectedId = body.id; S.selectedFace = null; S.faceTool = false; S.scaleTool = false; syncScene();
  }
  function scSetMode(m) { if (!SC) return; SC.mode = m; scPrefs.mode = m; SC.active = m === 'uniform' ? 'u' : 'z'; SC.s = [1, 1, 1]; syncScene(); }
  /** Screen-up in world: the uniform knob always stands above the pivot on screen. */
  const screenUp = () => { const v = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion); return [v.x, v.y, v.z]; };
  const scAxis = h => h === 'u' ? screenUp() : AXES[h] || v3norm([AXES[h[0]][0] + AXES[h[1]][0], AXES[h[0]][1] + AXES[h[1]][1], AXES[h[0]][2] + AXES[h[1]][2]]);
  const KNOB_PX = 60, PLATE_PX = 70;   // plates sit between two knobs, far enough out not to crowd them
  /** Where the handles sit right now (world). During a drag the dragged handle follows its factor. */
  function scHandles() {
    if (!scActive()) return null; const wpp = scFit().wpp; const p = SC.pivot; const at = (a, d) => [p[0] + a[0] * d, p[1] + a[1] * d, p[2] + a[2] * d];
    const dist = h => (h === 'u' ? KNOB_PX : h.length === 1 ? KNOB_PX : PLATE_PX) * wpp * (SC.drag === h ? scDragFactor() : 1);
    const out = { pivot: { pos: p } };
    if (SC.mode === 'uniform') out.u = { pos: at(scAxis('u'), dist('u')), axis: scAxis('u') };
    else for (const h of ['x', 'y', 'z', 'xy', 'yz', 'xz']) out[h] = { pos: at(scAxis(h), dist(h)), axis: scAxis(h) };
    return out;
  }
  function scHandleScreen(h) { const hs = scHandles(); return hs && hs[h] ? project(hs[h].pos) : null; }
  /** A plate's four corners on screen (it lies in the plane of its two axes). */
  function scPlateScreen(h) {
    const hs = scHandles(); if (!hs || !hs[h] || h.length !== 2) return null; const half = PLATE_SIZE / 2 * scFit().wpp; const a = AXES[h[0]], b = AXES[h[1]]; const c = hs[h].pos;
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => project([c[0] + (a[0] * i + b[0] * j) * half, c[1] + (a[1] * i + b[1] * j) * half, c[2] + (a[2] * i + b[2] * j) * half]));
  }
  const inQuad = (q, x, y) => { let inside = false; for (let i = 0, j = 3; i < 4; j = i++) { const a = q[i], b = q[j]; if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside; } return inside; };
  function hitSc(x, y) {
    const hs = scHandles(); if (!hs) return null; let best = null;   // the nearest handle wins; a plate counts anywhere on its surface
    for (const h of ['u', 'x', 'y', 'z', 'xy', 'yz', 'xz', 'pivot']) { if (!hs[h]) continue; const c = project(hs[h].pos); if (!c.ok) continue; let d = Math.hypot(c.x - x, c.y - y);
      if (h.length === 2) { const q = scPlateScreen(h); if (q && q.every(p => p.ok) && inQuad(q, x, y)) d = Math.min(d, 4); }
      if (d < (h === 'pivot' ? 20 : h.length === 2 ? 26 : 22) && (!best || d < best.d)) best = { h, d }; }
    return best ? best.h : null;
  }
  const scDragFactor = () => SC && SC.drag && SC.drag !== 'pivot' ? SC.s[SC.drag === 'u' ? 0 : ({ x: 0, y: 1, z: 2, xy: 0, yz: 1, xz: 0 })[SC.drag]] : 1;
  /** The factor vector for the current drag of handle h with factor f. */
  const scVector = (h, f) => h === 'u' ? [f, f, f] : h.length === 1 ? { x: [f, 1, 1], y: [1, f, 1], z: [1, 1, f] }[h] : { xy: [f, f, 1], yz: [1, f, f], xz: [f, 1, f] }[h];
  function beginScDrag(h, x, y) {
    if (!SC) return false; const body = scBody(); if (!body) return false; SC.drag = h; SC.base = body; SC.active = h === 'pivot' ? SC.active : h; SC.s = [1, 1, 1];
    if (h === 'pivot') { SC.snaps = SC.snaps || C.scaleSnapPoints(body.md); SC.pivot0 = SC.pivot.slice(); return true; }
    const axis = scAxis(h); SC.axis = axis; SC.d0 = (h === 'u' || h.length === 1 ? KNOB_PX : PLATE_PX) * scFit().wpp; return true;
  }
  function moveScDrag(x, y) {
    if (!SC || !SC.drag) return; const ray = rayAt(x, y);
    if (SC.drag === 'pivot') {
      let best = null; for (const q of SC.snaps) { const c = project(q); if (!c.ok) continue; const d = Math.hypot(c.x - x, c.y - y); if (d < 22 && (!best || d < best.d)) best = { q, d }; }
      if (best) SC.pivot = best.q.slice(); else { const h = C.rayMesh(SC.base.md, ray.o, ray.d); if (h) SC.pivot = h.point.slice(); }
      requestRender(); return;
    }
    const d = axisParam(ray, SC.pivot, SC.axis); let f = Math.max(0.05, Math.min(50, d / SC.d0)); f = Math.round(f * 100) / 100;
    SC.s = scVector(SC.drag, f); const M = C.scaleAbout(SC.pivot, SC.s); const o = objects.get(SC.bodyId); if (o) setPreviewMatrix(o, M); requestRender();
  }
  function endScDrag() {
    if (!SC || !SC.drag) return; const h = SC.drag; SC.drag = null;
    if (h === 'pivot') { syncScene(); return; }
    clearPreview(SC.bodyId); const body = scBody(); if (!body) { scDrop(); return; }
    if (SC.s.every(v => Math.abs(v - 1) < 1e-9)) { syncScene(); return; }
    scBodyApply(SC.s);
  }
  /** Scales the body by s about the pivot (exact affine transform); with Copy on, the result is a new body. */
  // body Scale: its own name — Scale face has a scApply() too, and the later one silently replaced this one, so letting go of a
  // handle (or typing a value) applied nothing and the body sprang back to its old shape
  function scBodyApply(sv) { const f = sv.every(v => Math.abs(v - sv[0]) < 1e-12) ? `×${+sv[0].toFixed(3)}` : `×${sv.map(v => +v.toFixed(3)).join(' / ')}`; return named(`${SC && SC.copy ? 'Scale copy' : 'Scale'} ${scBody() ? scBody().name : ''} ${f}`, () => scApplyInner(sv)); }
  function scApplyInner(sv) {
    const body = scBody(); if (!body) return; const M = C.scaleAbout(SC.pivot, sv);
    const man = tryGeom(() => C.transformSolid(body.man, M)); if (!man) { syncScene(); return; }
    if (SC.copy) { const keep = SC; addBody(body.name + ' copy', man); SC = keep; SC.bodyId = S.bodies[S.bodies.length - 1].id; SC.snaps = null; }
    else { if (!replaceBody(body, man)) return; SC.snaps = null; }
    SC.s = sv.slice(); syncScene();
  }
  const fmtFactor = f => (Math.round(f * 100) / 100).toFixed(2) + '×';
  /** Each frame: handles, stem, pivot, pills. */
  function syncScale() {
    const hs = scHandles(); if (!hs) { SCX.grp.visible = false; SCX.stem.visible = false; if (!scEditing) scLabel.hidden = true; scCopy.hidden = true; return; }
    const wpp = scFit().wpp; SCX.grp.visible = true;
    const place = (obj, pos, axis) => { obj.position.set(pos[0], pos[1], pos[2]); obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(axis[0], axis[1], axis[2])); obj.scale.set(wpp, wpp, wpp); };
    for (const h of ['u', 'x', 'y', 'z', 'xy', 'yz', 'xz']) { const obj = SCX[h]; if (!hs[h]) { obj.visible = false; continue; } obj.visible = true; const on = SC.active === h || SC.drag === h;
      if (obj.userData.plate) { obj.position.set(...hs[h].pos); obj.quaternion.identity(); obj.scale.set(wpp, wpp, wpp); obj.material.color.setHex(on ? 0x2f6fed : 0xf2f4f8); obj.material.opacity = on ? 0.95 : 0.85; }
      else { place(obj, hs[h].pos, hs[h].axis); for (const part of obj.userData.parts) part.material = on ? SCX.mats.blue : SCX.mats.white; } }
    SCX.pivot.position.set(...SC.pivot); SCX.pivot.scale.set(wpp, wpp, wpp); SCX.ghost.visible = false;
    const stemTo = hs[SC.active] || hs.u; if (stemTo) { SCX.stem.geometry.dispose(); SCX.stem.geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...SC.pivot), new THREE.Vector3(...stemTo.pos)]); SCX.stem.visible = true; } else SCX.stem.visible = false;
    const lab = hs[SC.active] || hs.u;
    if (lab) {
      const f = SC.drag && SC.drag !== 'pivot' ? scDragFactor() : SC.s[SC.active === 'u' ? 0 : ({ x: 0, y: 1, z: 2, xy: 0, yz: 1, xz: 0 })[SC.active]];
      // the pills go beyond the active handle, on out from the pivot, then aside if a handle is still under them, so they never
      // cover another handle (a pill on top of a plate would swallow the tap meant for it)
      const pc = project(SC.pivot), hc = project(lab.pos); let dx = hc.x - pc.x, dy = hc.y - pc.y; const dl = Math.hypot(dx, dy); if (dl < 1) { dx = 0; dy = -1; } else { dx /= dl; dy /= dl; }
      const others = Object.keys(hs).map(k => project(hs[k].pos)).filter(c => c.ok);
      const put = (elp, dist) => { if (elp.hidden && elp === scLabel && scEditing) return; elp.hidden = false; const w = elp.offsetWidth || 60, hgt = elp.offsetHeight || 24;
        for (const side of [0, 1, -1, 2, -2]) { const cx = hc.x + dx * dist - dy * side * 34, cy = hc.y + dy * dist + dx * side * 34; const L = cx - w / 2, T = cy - hgt / 2;
          const clear = others.every(c => !(c.x > L - 14 && c.x < L + w + 14 && c.y > T - 14 && c.y < T + hgt + 14));
          if (clear || side === -2) { elp.style.left = Math.max(6, Math.min(innerWidth - w - 6, L)) + 'px'; elp.style.top = Math.max(90, Math.min(innerHeight - 200, cy)) + 'px'; elp.style.transform = 'translate(0, -50%)'; return; } } };
      if (!scEditing) { scLabel.textContent = fmtFactor(f); scLabel.className = 'fil-pill' + (SC.drag ? ' live' : ''); put(scLabel, 46); }
      scCopy.className = 'fil-pill' + (SC.copy ? ' on' : ''); put(scCopy, 92);
    } else { scLabel.hidden = true; scCopy.hidden = true; }
  }
  scCopy.onclick = () => { if (!SC) return; SC.copy = !SC.copy; renderUI(); requestRender(); };
  /** Tap the factor to type it: applies as one scaling step. */
  scLabel.onclick = () => {
    if (!SC || SC.drag || scEditing) return; scEditing = true; scLabel.className = 'fil-pill live';
    const inp = document.createElement('input'); inp.type = 'number'; inp.step = 'any'; inp.inputMode = 'decimal'; inp.value = '1'; scLabel.replaceChildren(inp);
    const done = ok => { if (!scEditing) return; scEditing = false; const v = parseFloat(inp.value); scLabel.textContent = ''; if (ok && SC && !isNaN(v) && v > 0.001 && Math.abs(v - 1) > 1e-9) scBodyApply(scVector(SC.active, v)); else syncScene(); requestRender(); };
    inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') done(false); }; inp.onblur = () => done(true); setTimeout(() => { inp.focus(); inp.select(); }, 0);
  };
  // ---------- Chamfer / Fillet (Shapr3D-style): tap edges, drag the arrow, Auto reads the stroke ----------
  // FL: { bodyId, base (body record before), sel: [chain index], type 'auto'|'fillet'|'chamfer', autoType, value, value2,
  //       angle, cham 'equal'|'two'|'angle', shape 'circular'|'conic', rho, frame, drag, path, recorded, warn, invalid }
  let FL = null; let pendingFil = null; let filEditing = false; let filHover = null; let lastFilToast = 0;
  const filPrefs = { type: 'auto', cham: 'equal', shape: 'circular', value2: 1, angle: 45, rho: 0.45, showOpts: true };
  const FLX = { grp: new THREE.Group() };
  {
    const blue = new THREE.MeshBasicMaterial({ color: 0x2f6fed, depthTest: false, transparent: true, opacity: 0.97 });
    const white = new THREE.MeshBasicMaterial({ color: 0xf2f4f8, depthTest: false, transparent: true, opacity: 0.97 });
    const dbl = () => { const g = new THREE.Group(); const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 22, 10), blue); const a = new THREE.Mesh(new THREE.ConeGeometry(6.5, 12, 16), blue); a.position.y = 16; const b2 = new THREE.Mesh(new THREE.ConeGeometry(6.5, 12, 16), blue); b2.position.y = -16; b2.rotation.z = Math.PI; g.add(shaft, a, b2); return g; };
    FLX.size = dbl(); FLX.size2 = dbl(); FLX.dot = new THREE.Mesh(new THREE.SphereGeometry(4.2, 14, 10), white);
    FLX.rho = new THREE.Mesh(new THREE.CapsuleGeometry ? new THREE.CapsuleGeometry(3.2, 9, 4, 10) : new THREE.CylinderGeometry(3.4, 3.4, 13, 12), white);
    for (const m of [FLX.size, FLX.size2, FLX.dot, FLX.rho]) { FLX.grp.add(m); m.traverse(o => { o.renderOrder = 22; }); }
    const dash = () => { const l = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0x9aa3b2, dashSize: 0.3, gapSize: 0.2, depthTest: false, transparent: true, opacity: 0.9 })); l.renderOrder = 21; scene.add(l); l.visible = false; return l; };
    FLX.guide = dash(); FLX.guide2 = dash(); FLX.track = dash();
    FLX.ribbon = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x36c9f2, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })); FLX.ribbon.renderOrder = 18;
    FLX.hover = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x8fdcf5, side: THREE.DoubleSide, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })); FLX.hover.renderOrder = 18;
    scene.add(FLX.grp, FLX.ribbon, FLX.hover); FLX.grp.visible = false; FLX.ribbon.visible = false; FLX.hover.visible = false;
  }
  const pill = (id, cls) => { const d = document.createElement(cls === 'button' ? 'button' : 'div'); d.id = id; d.className = 'fil-pill'; d.hidden = true; document.body.appendChild(d); return d; };
  const filLabel = pill('fil-label'), filLabel2 = pill('fil-label2'), filType = pill('fil-type', 'button'), filRho = pill('fil-rho'), filGear = pill('fil-gear', 'button');
  { const st = document.createElement('style'); st.textContent = `
    .fil-pill { position: fixed; transform: translate(0, -50%); font: 600 12.5px ui-monospace, Menlo, Consolas, monospace; color: var(--fg); background: var(--panel); border: 1.5px solid #2f6fed; padding: 2px 8px; border-radius: 7px; white-space: nowrap; z-index: 6; }
    .fil-pill[hidden] { display: none; }
    #fil-label { cursor: pointer; text-decoration: underline dotted; } #fil-label.live { text-decoration: none; }
    #fil-label input { width: 70px; font: inherit; border: 0; background: transparent; color: var(--fg); outline: none; }
    #fil-type, #fil-gear { font-family: inherit; cursor: pointer; border-color: #8a93a3; } #fil-gear { border-radius: 50%; width: 28px; height: 28px; padding: 0; text-align: center; font-size: 15px; }
    #fil-rho { border-color: #8a93a3; font-size: 11.5px; }
    .fil-status { font-weight: 600; margin-right: 6px; }`; document.head.appendChild(st); }
  // the session belongs to one body; if that body is gone (deleted, undone, replaced elsewhere) the session simply ends
  const filAlive = () => { if (FL && !S.bodies.some(b => b.id === FL.bodyId)) filDrop(); return !!FL; };
  const filActive = () => filAlive() && S.tool === 'select';
  const filChains = () => FL ? C.edgeChains(FL.base.md) : [];
  const filSel = () => { const all = filChains(); return FL ? FL.sel.map(i => all[i]).filter(Boolean) : []; };
  /** The type actually built: Auto follows the last stroke (curved = fillet, straight = chamfer). */
  const flFit = () => { const bb = FL ? FL.base.man.boundingBox() : null; const d = bb ? Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) : 1; return fitWpp(d, 80, FL && FL.frame ? FL.frame.p : null, 40); };
  function filEffType() { return !FL ? null : FL.type === 'auto' ? (FL.autoType || 'fillet') : FL.type; }
  /** Curved or straight? The stroke so far against its chord (at least 10 px or 15 % of the chord off the line = curved). */
  function classifyStroke(path) {
    if (path.length < 3) return null; const a = path[0], b = path[path.length - 1]; const dx = b.x - a.x, dy = b.y - a.y; const L = Math.hypot(dx, dy); if (L < 12) return null;
    let dev = 0; for (const q of path) dev = Math.max(dev, Math.abs((q.x - a.x) * dy - (q.y - a.y) * dx) / L);
    return dev > Math.max(10, 0.15 * L) ? 'fillet' : 'chamfer';
  }
  /** Where the handles sit: the chain frame at the point of the first selected edge that best faces the camera. */
  function filFrame() {
    const ch = filSel()[0]; if (!ch) return null; const b = FL.base; const cp = camera.position; let best = null;
    const fs = ch.closed ? Array.from({ length: 24 }, (_, i) => i / 24) : [0.5];
    for (const f of fs) { const fr = C.chainFrame(b.md, ch, f); if (!fr) continue; const to = v3norm([cp.x - fr.p[0], cp.y - fr.p[1], cp.z - fr.p[2]]); const sc = to[0] * fr.dir[0] + to[1] * fr.dir[1] + to[2] * fr.dir[2]; if (!best || sc > best.sc) best = { fr, sc }; }
    return best ? best.fr : null;
  }
  function filOpts(finalize) {
    const eff = filEffType();
    return { type: eff, r: FL.value, r2: eff === 'chamfer' && FL.cham === 'two' ? FL.value2 : 0, angle: eff === 'chamfer' && FL.cham === 'angle' ? FL.angle : 0, rho: eff === 'fillet' && FL.shape === 'conic' ? FL.rho : 0, live: !finalize };
  }
  /** Rebuilds the fillet/chamfer from the body as it was, with the current settings. */
  function applyFil(finalize = !(FL && FL.drag)) {
    if (!FL) return; const sel = filSel(); const key = JSON.stringify([FL.sel, filOpts(finalize)]); if (key === FL.lastKey) return; FL.lastKey = key;
    const setBody = rec => { S.bodies = S.bodies.map(x => x.id === FL.bodyId ? rec : x); };
    if (!sel.length || !(FL.value > 1e-9)) { FL.invalid = null; FL.warn = false; setBody(FL.base); syncSceneLight(); return; }
    let res = null, err = null; try { res = C.filletEdges(FL.base.man, FL.base.md, sel, filOpts(finalize)); } catch (e) { err = (e && e.message) || 'Geometry error'; }
    let md = null; if (res) { try { md = C.meshData(res.solid); } catch (e) { err = 'Geometry error'; } }
    if (err) { FL.invalid = err; const now = performance.now(); if (now - lastFilToast > 1600) { lastFilToast = now; toast(err); } syncSceneLight(); return; }
    if (!FL.recorded) { record('Fillet'); FL.recorded = true; FL.feat = { kind: 'fillet', name: 'Fillet', body: FL.base.id, p: {}, pre: S.bodies }; }
    relabelLast(`${filEffType() === 'chamfer' ? 'Chamfer' : 'Fillet'} ${FL.sel.length} edge${FL.sel.length === 1 ? '' : 's'} ${filEffType() === 'chamfer' ? 'D' : 'R'}${+FL.value.toFixed(2)}`);
    setBody({ ...FL.base, man: res.solid, md }); FL.invalid = null;
    if (FL.feat) { const cen = ch => { const P = ch.pts; let x = 0, y = 0, z = 0; for (const p of P) { x += p[0]; y += p[1]; z += p[2]; } return [x / P.length, y / P.length, z / P.length]; }; FL.feat.name = filEffType() === 'chamfer' ? 'Chamfer' : 'Fillet'; FL.feat.p = { opts: { ...filOpts(true) }, edges: sel.map(ch => ({ c: cen(ch), n: ch.pts.length, len: ch.length })) }; if (!(S.feats || []).includes(FL.feat)) S.feats = [...(S.feats || []), FL.feat]; FL.feat.post = S.bodies; } FL.good = { value: FL.value, value2: FL.value2, angle: FL.angle, rho: FL.rho, type: FL.type, autoType: FL.autoType };
    if (res.warn && !FL.warn) { const now = performance.now(); if (now - lastFilToast > 1600) { lastFilToast = now; toast('Adjoining edge not blended.'); } }
    FL.warn = !!res.warn; syncSceneLight();
  }
  /** After an invalid size: back to the last one that built. */
  function filRevert() { if (!FL || !FL.invalid) return; const g = FL.good; if (g) Object.assign(FL, g); else FL.value = 0; FL.invalid = null; FL.lastKey = null; applyFil(true); }
  function startFil(body, index) {
    if (FL) commitFil(false);
    if (SESSION) endSession(); if (MV) endMove();
    FL = { bodyId: body.id, base: body, sel: [index], type: filPrefs.type, autoType: null, value: 0, value2: filPrefs.value2, angle: filPrefs.angle, cham: filPrefs.cham, shape: 'circular', rho: filPrefs.rho, showOpts: filPrefs.showOpts, drag: null, path: [], recorded: false, warn: false, invalid: null, lastKey: null };
    S.selectedId = body.id; S.selectedFace = null; S.faceTool = false; S.scaleTool = false; FL.frame = filFrame(); syncScene();
  }
  function filToggle(index) {
    const i = FL.sel.indexOf(index); if (i >= 0) FL.sel.splice(i, 1); else FL.sel.push(index);
    if (!FL.sel.length) { cancelFil(); return; }
    FL.frame = filFrame(); FL.lastKey = null; applyFil(true); syncScene();
  }
  /** Keeps the result (one undo step) and closes the tool. */
  function commitFil(sync = true) {
    if (!FL) return; if (FL.drag) { FL.drag = null; } if (FL.invalid) filRevert();
    if (FL.recorded) { FL.lastKey = null; applyFil(true); }
    Object.assign(filPrefs, { type: FL.type, cham: FL.cham, shape: FL.shape, value2: FL.value2, angle: FL.angle, rho: FL.rho, showOpts: FL.showOpts });
    const wasWarn = FL.warn; FL = null; filEditing = false; for (const e of [filLabel, filLabel2, filType, filRho, filGear]) e.hidden = true; save();
    if (sync) syncScene(); return wasWarn;
  }
  /** Puts the body back as it was. */
  function cancelFil() {
    if (!FL) return; const f = FL; FL = null; filEditing = false; for (const e of [filLabel, filLabel2, filType, filRho, filGear]) e.hidden = true;
    S.bodies = S.bodies.map(x => x.id === f.bodyId ? f.base : x); if (f.recorded && H.past.length) H.past.pop(); save(); syncScene();
  }
  /** Nearest drawn edge (chain) under a screen point, if it is within reach and not hidden behind a surface. */
  function edgeAt(x, y, tolPx = 15, onlyBody = null) {
    let best = null; const hit = pick(rayAt(x, y)); const cp = camera.position;
    for (const b of (onlyBody ? [onlyBody] : S.bodies)) {
      { // skip a body whose box on screen is not near the point (cheap; most bodies are far from a finger)
        const bb = b.man.boundingBox(); let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, ok = true;
        for (const px of [bb.min[0], bb.max[0]]) for (const py of [bb.min[1], bb.max[1]]) for (const pz of [bb.min[2], bb.max[2]]) { const q = project([px, py, pz]); if (!q.ok && !isFinite(q.x)) { ok = false; break; } x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
        if (ok && (x < x0 - tolPx || x > x1 + tolPx || y < y0 - tolPx || y > y1 + tolPx)) continue; }
      const md = FL && FL.bodyId === b.id ? FL.base.md : b.md; let chains; try { chains = C.edgeChains(md); } catch (e) { continue; }
      chains.forEach((ch, index) => {
        const pts = ch.closed ? [...ch.pts, ch.pts[0]] : ch.pts;
        for (let i = 1; i < pts.length; i++) {
          const A = project(pts[i - 1]), B = project(pts[i]); if (!A.ok || !B.ok) continue; const dx = B.x - A.x, dy = B.y - A.y; const L2 = dx * dx + dy * dy || 1;
          const u = Math.max(0, Math.min(1, ((x - A.x) * dx + (y - A.y) * dy) / L2)); const d = Math.hypot(A.x + dx * u - x, A.y + dy * u - y); if (d > tolPx || (best && d >= best.d)) continue;
          const a = pts[i - 1], c = pts[i]; const q = [a[0] + (c[0] - a[0]) * u, a[1] + (c[1] - a[1]) * u, a[2] + (c[2] - a[2]) * u];
          const dq = Math.hypot(q[0] - cp.x, q[1] - cp.y, q[2] - cp.z);
          if (hit && hit.distance < dq - Math.max(0.02 * dq, 6 * worldPerPx())) continue;   // a surface is in front of this edge
          best = { body: b, index, d, q };
        }
      });
    }
    return best;
  }
  /** A tap in the Select tool while editing edges: an edge toggles, a face of the same body adds its edges. True if used. */
  /** Screen distance from a point to a chain. */
  function chainScreenDist(ch, x, y) {
    const pts = ch.closed ? [...ch.pts, ch.pts[0]] : ch.pts; let d = Infinity;
    for (let i = 1; i < pts.length; i++) { const A = project(pts[i - 1]), B = project(pts[i]); if (!A.ok || !B.ok) continue; const dx = B.x - A.x, dy = B.y - A.y; const L2 = dx * dx + dy * dy || 1; const u = Math.max(0, Math.min(1, ((x - A.x) * dx + (y - A.y) * dy) / L2)); d = Math.min(d, Math.hypot(A.x + dx * u - x, A.y + dy * u - y)); }
    return d;
  }
  function filTap(x, y) {
    filAlive();
    // Just outside a body, next to its outline, an edge within 15 px is picked. On a face an edge wins only for a tap close
    // to its line: within 8 px and nearer to it than to the rest of the face's outline (under 30 % of the way across), so the
    // middle of any face, however small or far away, still picks the face.
    const onBody = pick(rayAt(x, y)); let e = edgeAt(x, y, onBody ? 8 : 15);
    if (e && onBody && onBody.faceId != null) {
      const md = FL && FL.bodyId === onBody.body.id ? FL.base.md : onBody.body.md; const ray = rayAt(x, y); const h = C.rayMesh(md, ray.o, ray.d);
      if (h && h.faceId != null) { const surf = C.surfOfFace(md, h.faceId); const ds = C.edgeChains(md).filter(ch => ch.sA === surf || ch.sB === surf).map(ch => chainScreenDist(ch, x, y)).sort((a, b) => a - b);
        if (ds.length >= 2 && !(e.d < 0.3 * (ds[0] + ds[1]))) e = null; }
    }
    if (e) { if (FL && FL.bodyId === e.body.id) filToggle(e.index); else startFil(FL && FL.bodyId === e.body.id ? FL.base : e.body, e.index); return true; }
    if (!FL) return false;
    const ray = rayAt(x, y); const h = C.rayMesh(FL.base.md, ray.o, ray.d);
    if (h && h.faceId != null) {
      const surf = C.surfOfFace(FL.base.md, h.faceId); const all = filChains(); let added = 0;
      all.forEach((ch, i) => { if ((ch.sA === surf || ch.sB === surf) && !FL.sel.includes(i)) { FL.sel.push(i); added++; } });
      if (added) { FL.frame = filFrame(); FL.lastKey = null; applyFil(true); syncScene(); return true; }
    }
    commitFil(); return false;   // anywhere else: keep the result, then the tap selects as usual
  }
  // ---- handles
  function filHandles() {
    if (!filActive() || !FL.frame || filEditing && false) return null; const fr = FL.frame; const wpp = flFit().wpp; const eff = filEffType();
    const lift = (n, k) => [n[0] * k * wpp, n[1] * k * wpp, n[2] * k * wpp];
    const at = (d, v, l) => [fr.p[0] + d[0] * v + l[0], fr.p[1] + d[1] * v + l[1], fr.p[2] + d[2] * v + l[2]];
    const minV = 26 * wpp; const v = Math.max(FL.value, minV);
    const two = eff === 'chamfer' && FL.cham !== 'equal';
    const size = two ? { pos: at(fr.dA, v, lift(fr.nA, 10)), axis: fr.dA } : { pos: at(fr.dir, v, [0, 0, 0]), axis: fr.dir };
    const size2 = eff === 'chamfer' && FL.cham === 'two' ? { pos: at(fr.dB, Math.max(FL.value2, minV), lift(fr.nB, 10)), axis: fr.dB } : null;
    // the shape track: an arc of 44 px around the size handle in the plane of the edge and the handle axis
    let rho = null, track = null;
    if (eff === 'fillet') {
      const Rw = 44 * wpp; const e1 = fr.t, e2 = size.axis; const on = a => [size.pos[0] + Rw * (Math.cos(a) * e1[0] + Math.sin(a) * e2[0]), size.pos[1] + Rw * (Math.cos(a) * e1[1] + Math.sin(a) * e2[1]), size.pos[2] + Rw * (Math.cos(a) * e1[2] + Math.sin(a) * e2[2])];
      const a0 = -70 * Math.PI / 180, a1 = 70 * Math.PI / 180; track = []; for (let i = 0; i <= 28; i++) track.push(on(a0 + (a1 - a0) * i / 28));
      const circ = (() => { const w = Math.cos((Math.PI - fr.opening) / 2); return w / (1 + w); })();
      const r0 = FL.shape === 'conic' ? FL.rho : circ; rho = { pos: on(a0 + (a1 - a0) * (r0 - 0.05) / 0.9), value: r0, circ, a0, a1, on };
    }
    return { size, size2, rho, track, fr };
  }
  function filHandleScreen(kind) { const h = filHandles(); const w = h && h[kind] && h[kind].pos; return w ? project(w) : null; }
  function hitFil(x, y) {
    const h = filHandles(); if (!h) return null; const near = (w, r) => { if (!w) return false; const c = project(w); return c.ok && Math.hypot(c.x - x, c.y - y) < r; };
    if (h.rho && near(h.rho.pos, 20)) return 'rho';
    if (h.size2 && near(h.size2.pos, 28)) return 'size2';
    if (near(h.size.pos, 30)) return 'size';
    return null;
  }
  function beginFilDrag(kind, x, y) {
    if (!FL) return false; const h = filHandles(); if (!h) return false; FL.drag = kind; FL.path = [{ x, y }];
    if (kind === 'size' || kind === 'size2') { const hh = h[kind]; const ray = rayAt(x, y); FL.axis = hh.axis; FL.t0 = axisParam(ray, FL.frame.p, hh.axis) - (kind === 'size' ? FL.value : FL.value2); }
    return true;
  }
  function moveFilDrag(x, y) {
    if (!FL || !FL.drag) return; const ray = rayAt(x, y); FL.path.push({ x, y });
    if (FL.drag === 'size' || FL.drag === 'size2') {
      const raw = axisParam(ray, FL.frame.p, FL.axis) - FL.t0; const v = Math.max(0, Math.round(raw * 20) / 20);
      if (FL.drag === 'size') FL.value = v; else FL.value2 = Math.max(0.05, v);
      if (FL.type === 'auto' && FL.drag === 'size') { const k = classifyStroke(FL.path); if (k) FL.autoType = k; }
    } else if (FL.drag === 'rho') {
      const h = filHandles(); if (!h || !h.rho) return; let best = 0, bd = Infinity;
      for (let i = 0; i <= 56; i++) { const a = h.rho.a0 + (h.rho.a1 - h.rho.a0) * i / 56; const c = project(h.rho.on(a)); const d = Math.hypot(c.x - x, c.y - y); if (d < bd) { bd = d; best = i / 56; } }
      FL.shape = 'conic'; FL.rho = Math.round((0.05 + 0.9 * best) * 1000) / 1000;
    }
    applyFil(false);
  }
  function endFilDrag() { if (!FL || !FL.drag) return; FL.drag = null; FL.lastKey = null; applyFil(true); if (FL && FL.invalid) filRevert(); syncScene(); }
  /** Screen-facing strip along 3D segments (WebGL lines are 1 px), width in px. */
  function ribbonGeometry(segs, px) {
    const wpp = worldPerPx(); const cp = camera.position; const pos = [];
    for (const [a, b] of segs) {
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; const to = v3norm([cp.x - mid[0], cp.y - mid[1], cp.z - mid[2]]);
      const side = v3norm(v3cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], to)); const w = px * wpp / 2, lift = 1.5 * wpp;
      const o = k => [side[0] * w * k + to[0] * lift, side[1] * w * k + to[1] * lift, side[2] * w * k + to[2] * lift];
      const A1 = o(1), A2 = o(-1);
      pos.push(a[0] + A1[0], a[1] + A1[1], a[2] + A1[2], b[0] + A1[0], b[1] + A1[1], b[2] + A1[2], b[0] + A2[0], b[1] + A2[1], b[2] + A2[2], a[0] + A1[0], a[1] + A1[1], a[2] + A1[2], b[0] + A2[0], b[1] + A2[1], b[2] + A2[2], a[0] + A2[0], a[1] + A2[1], a[2] + A2[2]);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); return g;
  }
  const chainSegs = chs => { const out = []; for (const ch of chs) { const pts = ch.closed ? [...ch.pts, ch.pts[0]] : ch.pts; for (let i = 1; i < pts.length; i++) out.push([pts[i - 1], pts[i]]); } return out; };
  const placePill = (elp, w, dx = 22, dy = 0) => { const c = project(w); elp.hidden = !c.ok; if (!c.ok) return; const ww = elp.offsetWidth || 60; elp.style.left = Math.max(6, Math.min(innerWidth - ww - 6, c.x + dx)) + 'px'; elp.style.top = Math.max(90, Math.min(innerHeight - 200, c.y + dy)) + 'px'; };
  /** Each frame: handles, guide lines, edge highlight and the value pills. */
  function syncFillet() {
    const hideAll = () => { FLX.grp.visible = false; FLX.guide.visible = FLX.guide2.visible = FLX.track.visible = false; FLX.ribbon.visible = false; if (!filEditing) filLabel.hidden = true; filLabel2.hidden = filType.hidden = filRho.hidden = filGear.hidden = true; };
    // hover highlight (mouse)
    if (filHover && S.tool === 'select' && filHover.chs.length) { FLX.hover.geometry.dispose(); FLX.hover.geometry = ribbonGeometry(chainSegs(filHover.chs), 4); FLX.hover.visible = true; } else FLX.hover.visible = false;
    const h = filHandles(); if (!h) { hideAll(); return; }
    const wpp = flFit().wpp; const eff = filEffType(); const fr = h.fr;
    FLX.grp.visible = true; FLX.grp.position.set(0, 0, 0);
    const orient = (obj, pos, axis) => { obj.position.set(pos[0], pos[1], pos[2]); obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(axis[0], axis[1], axis[2])); obj.scale.set(wpp, wpp, wpp); };
    // the arrows lie across the view: along the drag direction as it appears on screen, so they read as arrows even when
    // the drag itself points at the camera (a rim seen from the front)
    const vd = new THREE.Vector3(); camera.getWorldDirection(vd); const view = [vd.x, vd.y, vd.z];
    const onScreen = axis => { const k = axis[0] * view[0] + axis[1] * view[1] + axis[2] * view[2]; let a = [axis[0] - k * view[0], axis[1] - k * view[1], axis[2] - k * view[2]]; if (Math.hypot(a[0], a[1], a[2]) < 0.05) a = v3cross(view, fr.t); return v3norm(a); };
    orient(FLX.size, h.size.pos, onScreen(h.size.axis)); FLX.size.visible = true;
    FLX.dot.visible = true; FLX.dot.position.set(fr.p[0], fr.p[1], fr.p[2]); FLX.dot.scale.set(wpp, wpp, wpp);
    FLX.size2.visible = !!h.size2; if (h.size2) orient(FLX.size2, h.size2.pos, onScreen(h.size2.axis));
    FLX.rho.visible = !!h.rho; if (h.rho) orient(FLX.rho, h.rho.pos, fr.t);
    const line = (L, a, b) => { L.geometry.dispose(); L.geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]); L.computeLineDistances(); L.material.dashSize = 6 * wpp; L.material.gapSize = 4 * wpp; L.visible = true; };
    line(FLX.guide, fr.p, h.size.pos); if (h.size2) line(FLX.guide2, fr.p, h.size2.pos); else FLX.guide2.visible = false;
    if (h.track) { FLX.track.geometry.dispose(); FLX.track.geometry = new THREE.BufferGeometry().setFromPoints(h.track.map(q => new THREE.Vector3(...q))); FLX.track.computeLineDistances(); FLX.track.material.dashSize = 3 * wpp; FLX.track.material.gapSize = 3 * wpp; FLX.track.visible = true; } else FLX.track.visible = false;
    // selected edges in cyan until the preview shows the fillet itself
    if (!(FL.value > 1e-9) || FL.invalid) { FLX.ribbon.geometry.dispose(); FLX.ribbon.geometry = ribbonGeometry(chainSegs(filSel()), 3.5); FLX.ribbon.visible = true; } else FLX.ribbon.visible = false;
    // pills: value, second value, type, shape, options
    if (!filEditing) {
      const v = FL.value; let text = eff === 'fillet' ? `R${fmtDim(v)}` : fmtDim(v); if (eff === 'chamfer' && FL.cham === 'angle') text += ` · ${FL.angle}°`;
      if (FL.invalid) text += ' · too big'; filLabel.textContent = text; filLabel.className = 'fil-pill' + (FL.drag ? ' live' : ''); placePill(filLabel, h.size.pos, 26, 0);
    }
    if (h.size2) { filLabel2.textContent = fmtDim(FL.value2); placePill(filLabel2, h.size2.pos, 26, 0); } else filLabel2.hidden = true;
    filType.textContent = (FL.type === 'auto' ? `Auto · ${eff === 'fillet' ? 'Fillet' : 'Chamfer'}` : eff === 'fillet' ? 'Fillet' : 'Chamfer') + ' ⌄'; placePill(filType, h.size.pos, 26, -30);
    if (h.rho && (FL.shape === 'conic' || FL.drag === 'rho')) { filRho.textContent = String(Math.round(h.rho.value * 1000) / 1000); placePill(filRho, h.rho.pos, -58, -16); } else filRho.hidden = true;
    const gp = [fr.p[0] - fr.dir[0] * 0, fr.p[1], fr.p[2]]; placePill(filGear, gp, -44, 30); filGear.textContent = '⚙';
  }
  filType.onclick = () => { if (!FL) return; const order = ['auto', 'fillet', 'chamfer']; FL.type = order[(order.indexOf(FL.type) + 1) % 3]; FL.lastKey = null; applyFil(true); syncScene(); };
  filGear.onclick = () => { if (!FL) return; FL.showOpts = !FL.showOpts; renderUI(); };
  /** Tap the value to type the exact radius or distance. */
  const editPill = (elp, get, set) => {
    if (!FL || FL.drag) return; filEditing = true; elp.className = 'fil-pill live';
    const inp = document.createElement('input'); inp.type = 'number'; inp.step = 'any'; inp.inputMode = 'decimal'; inp.value = Math.round(get() * 1000) / 1000; elp.replaceChildren(inp);
    const done = ok => { if (!filEditing) return; filEditing = false; const v = parseFloat(inp.value); if (ok && !isNaN(v) && FL) { set(Math.max(0, v)); FL.lastKey = null; applyFil(true); if (FL && FL.invalid) filRevert(); } elp.textContent = ''; syncScene(); requestRender(); };
    inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') done(false); };
    inp.onblur = () => done(true); setTimeout(() => { inp.focus(); inp.select(); }, 0);
  };
  filLabel.onclick = () => { if (filEditing) return; editPill(filLabel, () => FL.value, v => { FL.value = v; }); };
  filLabel2.onclick = () => { if (filEditing) return; editPill(filLabel2, () => FL.value2, v => { FL.value2 = Math.max(0.05, v); }); };
  /** Switches to Move/Rotate with a face of the selected body already picked (from the Select tool's panel). */
  function startMoveFace(b, faceId) { const surf = C.surfOfFace(b.md, faceId); setTool('move'); S.selectedId = b.id; S.moveSurf = surf >= 0 ? surf : null; syncScene(); }

  // ---------- Edit tool: select regions, drag sketch points ----------
  /**
   * Reshaping a sketch works in every sketch tool, not only in Edit sketch: a press on a point or a line, then a drag, moves
   * it. In Line and Polyline a free line end (one line) still starts a new line from it, and while a shape is being drawn
   * the drawing tool keeps every press. Returns 'vertex', 'eline' or null.
   */
  /** Circles in the sketch: closed loops (of 24 points or more) whose points all sit at one distance from their middle. */
  function circlesIn(segs) {
    const key = p => p[0].toFixed(9) + ',' + p[1].toFixed(9); const adj = new Map();
    segs.forEach((l, i) => { for (const [p, q] of [[l[0], l[1]], [l[1], l[0]]]) { const k = key(p); if (!adj.has(k)) adj.set(k, []); adj.get(k).push({ q, i }); } });
    const used = new Set(), out = [];
    segs.forEach((l, i0) => {
      if (used.has(i0)) return; const idx = [i0], pts = [l[0]]; used.add(i0); let cur = l[1], prev = i0, ok = true;
      while (key(cur) !== key(l[0])) { const all = adj.get(key(cur)) || []; const nb = all.filter(e => e.i !== prev && !used.has(e.i)); if (all.length !== 2 || nb.length !== 1) { ok = false; break; } pts.push(cur); used.add(nb[0].i); idx.push(nb[0].i); prev = nb[0].i; cur = nb[0].q; if (idx.length > 20000) { ok = false; break; } }
      if (!ok || pts.length < 24) return; const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]); const rs = pts.map(p => Math.hypot(p[0] - c[0], p[1] - c[1])); const r = rs.reduce((a, x) => a + x, 0) / rs.length;
      if (r > 0 && rs.every(x => Math.abs(x - r) <= 1e-4 * Math.max(1e-3, r))) out.push({ c, r, idx, n: pts.length });
    });
    return out;
  }
  const allSketchSegs = () => sketchSegments();   // (already includes a closed shape's closing edge)
  /** The circle whose centre is under a screen point (within 18 px), or null. */
  function circleCentreAt(x, y) { let best = null; for (const cc of circlesIn(allSketchSegs())) { const q = project(to3(cc.c)); if (!q.ok) continue; const d = Math.hypot(q.x - x, q.y - y); if (d < 22 && (!best || d < best.d)) best = { d, cc }; } return best ? best.cc : null; }
  /** The circle a sketch point belongs to (one of its own points), or null. */
  function circleThrough(p) { for (const cc of circlesIn(allSketchSegs())) if (Math.abs(Math.hypot(p[0] - cc.c[0], p[1] - cc.c[1]) - cc.r) <= 1e-6 * Math.max(1, cc.r)) return cc; return null; }
  /** The circle whose edge is under a screen point, or null. */
  function circleEdgeAt(x, y) { const ray = rayAt(x, y); const q = C.planeHit2D(plane(), ray.o, ray.d); if (!q) return null; const tol = 16 * worldPerPx(to3(q)); let best = null;
    for (const cc of circlesIn(allSketchSegs())) { const d = Math.abs(Math.hypot(q[0] - cc.c[0], q[1] - cc.c[1]) - cc.r); if (d < tol && (!best || d < best.d)) best = { d, cc }; } return best ? best.cc : null; }
  // Circle drag: 'ccentre' moves the whole circle (its centre snaps to other points), 'cradius' changes its radius
  let CDRAG = null; const diaEl = document.createElement('div'); diaEl.className = 'fil-pill sk-dia'; diaEl.hidden = true; document.body.appendChild(diaEl);
  const to2 = w => { const f = plane(); const d = [w[0] - f.origin[0], w[1] - f.origin[1], w[2] - f.origin[2]]; return [d[0] * f.u[0] + d[1] * f.u[1] + d[2] * f.u[2], d[0] * f.v[0] + d[1] * f.v[1] + d[2] * f.v[2]]; };
  const bodySnapCache = new WeakMap();
  /** Where a moved circle's centre may snap: other sketch points and circle centres, the origin, and body points lying on the plane. */
  function centreSnap(q, skip) {
    const f = plane(); const tol = 16 * worldPerPx(to3(q)); const cands = [];
    const segs = allSketchSegs().filter((_, i) => !skip.has(i)); for (const c of C.notablePoints(segs)) cands.push(c.p);
    for (const cc of circlesIn(segs)) cands.push(cc.c);
    for (const c of planeSnapExtras()) cands.push(c.p);
    const onPlane = w => Math.abs((w[0] - f.origin[0]) * f.n[0] + (w[1] - f.origin[1]) * f.n[1] + (w[2] - f.origin[2]) * f.n[2]) <= 1e-6 * Math.max(1, Math.hypot(...w));
    if (onPlane([0, 0, 0])) cands.push(to2([0, 0, 0]));
    for (const b of S.bodies) { let pts = bodySnapCache.get(b.md); if (!pts) { pts = C.scaleSnapPoints(b.md).map(s2 => s2.p || s2); bodySnapCache.set(b.md, pts); } for (const w of pts) if (onPlane(w)) cands.push(to2(w)); }
    let best = null; for (const c of cands) { const d = Math.hypot(c[0] - q[0], c[1] - q[1]); if (d < tol && (!best || d < best.d)) best = { d, c }; }
    if (best) { S.lastSnap = 'point'; return [best.c[0], best.c[1]]; }
    S.lastSnap = S.snap ? 'grid' : null; return snap(q);
  }
  function circleSegs(c, r, n) { const pts = Array.from({ length: n }, (_, i) => { const t = 2 * Math.PI * i / n; return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]; }); return pts.map((p, i) => [p, pts[(i + 1) % n]]); }
  /** The circle whose centre is selected (S.selCentre), or null. */
  function selectedCircle() { if (!S.selCentre || !isSketchTool(S.tool) || !S.plane) return null; return circlesIn(allSketchSegs()).find(cc => Math.hypot(cc.c[0] - S.selCentre[0], cc.c[1] - S.selCentre[1]) < 1e-6 * Math.max(1, cc.r)) || null; }
  function selectCentre(cc) { S.selCentre = [cc.c[0], cc.c[1]]; S.selRegion = -1; S.selSeg = null; S.selVertex = null; S.selHole = null; syncScene(); renderUI(); }
  /** Moves / resizes the selected circle to typed values (one undo step); the centre stays selected. */
  function applyCircleValues(nc, nr) {
    const cc0 = selectedCircle(); if (!cc0) return; const c = [isFinite(nc[0]) ? nc[0] : cc0.c[0], isFinite(nc[1]) ? nc[1] : cc0.c[1]]; const r = isFinite(nr) && nr > 0 ? nr : cc0.r;
    step(() => { flattenSketch(); const circ = circlesIn(S.sketchLines).find(q => Math.hypot(q.c[0] - cc0.c[0], q.c[1] - cc0.c[1]) < 1e-6 * Math.max(1, q.r)); if (!circ) return;
      const segs = circleSegs(c, r, circ.n); const L = S.sketchLines.slice(); circ.idx.forEach((i, k) => { L[i] = segs[k]; }); S.sketchLines = L; S.selCentre = c; syncScene(); }, 'Move circle');
    renderUI();
  }
  function deleteSelectedCircle() { const cc0 = selectedCircle(); if (!cc0) return;
    step(() => { flattenSketch(); const circ = circlesIn(S.sketchLines).find(q => Math.hypot(q.c[0] - cc0.c[0], q.c[1] - cc0.c[1]) < 1e-6 * Math.max(1, q.r)); if (circ) { const drop = new Set(circ.idx); S.sketchLines = S.sketchLines.filter((_, i) => !drop.has(i)); } S.selCentre = null; syncScene(); }, 'Delete circle');
    renderUI(); toast('Circle deleted · Undo brings it back'); }
  /** The panel for a selected circle: X, Y and radius to type (kept in the action row, so it shows when the panel is folded). */
  function circlePanel() {
    const cc = selectedCircle(); if (!cc) { if (S.selCentre) S.selCentre = null; return; }
    panelEl.replaceChildren(); panelEl.hidden = false;
    const top = el('div', 'row scroll'); top.append(el('span', 'fil-status', 'Circle'), chip('Deselect', () => { S.selCentre = null; syncScene(); renderUI(); }), chip('Delete circle', deleteSelectedCircle)); panelEl.append(top);
    panelEl.append(el('div', 'note', 'Drag the centre to move the circle (it snaps to other points), drag its edge to change the radius, or type exact values.'));
    const act = el('div', 'row scroll'); const fmt = v => String(Math.round(v * 1000) / 1000);
    const field = (name, label, v) => { const w = el('label', 'note', label + ' '); const inp = document.createElement('input'); inp.type = 'number'; inp.step = 'any'; inp.className = 'num'; inp.dataset.field = name; inp.value = fmt(v); inp.style.width = '64px'; w.append(inp); return w; };
    act.append(field('x', 'X', cc.c[0]), field('y', 'Y', cc.c[1]), field('r', 'Radius', cc.r));
    act.append(chip('Apply', () => { const get = n => parseFloat((panelEl.querySelector(`input[data-field='${n}']`) || {}).value); applyCircleValues([get('x'), get('y')], get('r')); }, true));
    panelEl.append(act);
  }
  function beginCircleDrag(mode, x, y) {
    const hit = mode === 'ccentre' ? (circleCentreAt(x, y) || selectedCircle()) : (circleEdgeAt(x, y) || (() => { const v0 = vertexAt(x, y); return v0 ? circleThrough(v0.p) : null; })()); if (!hit) return false;
    flattenSketch(); const circ = circlesIn(S.sketchLines).find(cc => Math.hypot(cc.c[0] - hit.c[0], cc.c[1] - hit.c[1]) < 1e-9 && Math.abs(cc.r - hit.r) < 1e-9); if (!circ) return false;
    record(mode === 'ccentre' ? 'Move circle' : 'Resize circle');
    CDRAG = { mode, idx: circ.idx, c: circ.c.slice(), r: circ.r, n: circ.n, skip: new Set(circ.idx) }; showSkGhost(circ.idx.map(i => [S.sketchLines[i][0], S.sketchLines[i][1]])); return true;
  }
  function moveCircleDrag(x, y) {
    if (!CDRAG) return; const ray = rayAt(x, y); const q = C.planeHit2D(plane(), ray.o, ray.d); if (!q) return;
    if (CDRAG.mode === 'ccentre') CDRAG.c = centreSnap(q, CDRAG.skip); else { const r = Math.hypot(q[0] - CDRAG.c[0], q[1] - CDRAG.c[1]); CDRAG.r = Math.max(1e-3, S.snap ? Math.max(0.1, Math.round(r * 10) / 10) : r); }
    const segs = circleSegs(CDRAG.c, CDRAG.r, CDRAG.n); const L = S.sketchLines.slice(); CDRAG.idx.forEach((i, k) => { L[i] = segs[k]; }); S.sketchLines = L;
    const top = project(to3([CDRAG.c[0], CDRAG.c[1] + CDRAG.r])); const d = Math.round(2 * CDRAG.r * 1000) / 1000;
    diaEl.textContent = `⌀ ${d} mm`; diaEl.hidden = !top.ok; if (top.ok) { diaEl.style.left = top.x + 'px'; diaEl.style.top = (top.y - 20) + 'px'; diaEl.style.transform = 'translate(-50%, -50%)'; }
    syncScene();
  }
  function endCircleDrag() { if (!CDRAG) return; if (CDRAG.mode === 'ccentre' || S.selCentre) S.selCentre = [CDRAG.c[0], CDRAG.c[1]]; CDRAG = null; showSkGhost(null); diaEl.hidden = true; syncScene(); renderUI(); }
  // every circle shows its centre (a point to grab) while sketching
  const selCentreMark = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xff9a2e, size: 14, sizeAttenuation: false, depthTest: false })); selCentreMark.renderOrder = 13;
  const centreMarks = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0x7fb3ff, size: 8, sizeAttenuation: false, depthTest: false })); centreMarks.renderOrder = 12;
  const bodyCentreMarks = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffffff, size: 11, sizeAttenuation: false, depthTest: true })); bodyCentreMarks.renderOrder = 12;
  function syncCircleCentres() {
    const on = (isSketchTool(S.tool) || S.tool === 'move') && S.plane; let cs = []; try { cs = on ? circlesIn(allSketchSegs()) : []; } catch (e) { cs = []; }
    centreMarks.geometry.dispose(); centreMarks.geometry = new THREE.BufferGeometry().setFromPoints(cs.map(cc => new THREE.Vector3(...to3(cc.c, 0.02))));
    centreMarks.visible = cs.length > 0; centreMarks.userData.count = cs.length; if (!centreMarks.parent) scene.add(centreMarks);
    // the centre of every round edge of the bodies (cylinder tops and bottoms, hole mouths), a hair off its face on the open side
    const showB = (isSketchTool(S.tool) || S.tool === 'move') && C.circleCentres; const bp = [];
    if (showB) for (const b of S.bodies) { let cl = []; try { cl = C.circleCentres(b.md); } catch (e) { cl = []; } for (const cc of cl) { const e = 0.004 * Math.max(cc.r, 1e-3); bp.push(new THREE.Vector3(cc.p[0] + cc.o[0] * e, cc.p[1] + cc.o[1] * e, cc.p[2] + cc.o[2] * e)); } }
    bodyCentreMarks.geometry.dispose(); bodyCentreMarks.geometry = new THREE.BufferGeometry().setFromPoints(bp); bodyCentreMarks.visible = bp.length > 0; if (!bodyCentreMarks.parent) scene.add(bodyCentreMarks);
    mvSnapMark.geometry.dispose(); mvSnapMark.geometry = new THREE.BufferGeometry().setFromPoints(mvSnapAt ? [new THREE.Vector3(...mvSnapAt)] : []); mvSnapMark.visible = !!mvSnapAt; if (!mvSnapMark.parent) scene.add(mvSnapMark);
    const sc = on && S.selCentre ? cs.find(cc => Math.hypot(cc.c[0] - S.selCentre[0], cc.c[1] - S.selCentre[1]) < 1e-6 * Math.max(1, cc.r)) : null;
    selCentreMark.geometry.dispose(); selCentreMark.geometry = new THREE.BufferGeometry().setFromPoints(sc ? [new THREE.Vector3(...to3(sc.c, 0.03))] : []); selCentreMark.visible = !!sc; if (!selCentreMark.parent) scene.add(selCentreMark);
  }
  function sketchReshapeAt(x, y) {
    if (!S.plane || S.imported || !isSketchTool(S.tool)) return null;
    const drawingTool = S.tool !== 'edit';
    if (drawingTool && (S.drawing || S.lineStart || (S.sketch.length && !S.sketchClosed))) return null;
    if (circleCentreAt(x, y)) return 'ccentre';   // (a drag moves the circle; a plain tap still goes to the tool — the Circle tool starts a new circle there)
    if (circleEdgeAt(x, y)) return 'cradius';
    { const v0 = vertexAt(x, y); if (v0 && circleThrough(v0.p)) return 'cradius'; }   // (one of a circle's own points: the circle, not the point)
    const v = vertexAt(x, y);
    if (v) { if (!drawingTool || S.tool === 'rect' || S.tool === 'circle' || S.tool === 'polygon') return 'vertex';
      const deg = sketchSegments().filter(([a, b]) => skEq(a, v.p) || skEq(b, v.p)).length; return deg >= 2 ? 'vertex' : null; }
    return lineAt(x, y) ? 'eline' : null;
  }
  function vertexAt(x, y) {
    const tol = 18; let best = null;
    const consider = (pt, ref) => { const c = project(to3(pt, 0.02)); const d = Math.hypot(c.x - x, c.y - y); if (d < tol && (!best || d < best.d)) best = { d, p: pt }; };
    for (const l of S.sketchLines) { consider(l[0]); consider(l[1]); }
    for (const q of S.sketch) consider(q);
    if (!best) return null;
    const refs = []; const same = q => Math.hypot(q[0] - best.p[0], q[1] - best.p[1]) < 1e-9;
    S.sketchLines.forEach((l, i) => { if (same(l[0])) refs.push({ set: v => { S.sketchLines[i][0] = v; } }); if (same(l[1])) refs.push({ set: v => { S.sketchLines[i][1] = v; } }); });
    S.sketch.forEach((q, i) => { if (same(q)) refs.push({ set: v => { S.sketch[i] = v; } }); });
    return { p: [best.p[0], best.p[1]], refs };
  }
  // ---------- Editing sketch lines and corners (Shapr3D-style) ----------
  const skEq = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9;
  /** The rectangle (4 sides at right angles, a closed loop) that the given point lies on as a corner, or null. */
  function rectAtCorner(pt) {
    const L = S.sketchLines; const inc = q => L.filter(l => skEq(l[0], q) || skEq(l[1], q));
    const other = (l, q) => skEq(l[0], q) ? l[1] : l[0];
    const P = [pt]; let prev = null, cur = pt;
    for (let k = 0; k < 4; k++) { const es = inc(cur); if (es.length !== 2) return null; const e = es.find(l => !prev || !skEq(other(l, cur), prev)) || es[0]; const nx = other(e, cur); prev = cur; cur = nx; if (k < 3) { if (P.some(q => skEq(q, nx))) return null; P.push(nx); } }
    if (!skEq(cur, pt) || P.length !== 4) return null;
    for (let i = 0; i < 4; i++) { const a = P[(i + 3) % 4], b = P[i], c = P[(i + 1) % 4]; const u = [a[0] - b[0], a[1] - b[1]], v = [c[0] - b[0], c[1] - b[1]]; const lu = Math.hypot(...u), lv = Math.hypot(...v); if (lu < 1e-9 || lv < 1e-9 || Math.abs(u[0] * v[0] + u[1] * v[1]) > 1e-6 * lu * lv) return null; }
    return P;
  }
  /** Moves every line end sitting at `from` to `to` (joined lines follow). */
  function skMovePoint(from, to) { for (const l of S.sketchLines) { if (skEq(l[0], from)) l[0] = [to[0], to[1]]; if (skEq(l[1], from)) l[1] = [to[0], to[1]]; } }
  /** The lines connected to a line or point (the shape being edited), for the length labels; null if too many. */
  function skShapeOf(seed) {
    const L = S.sketchLines; if (!L.length) return null; const start = L.filter(l => (seed.length === 2 && Array.isArray(seed[0])) ? (skEq(l[0], seed[0]) && skEq(l[1], seed[1])) || (skEq(l[0], seed[1]) && skEq(l[1], seed[0])) : skEq(l[0], seed) || skEq(l[1], seed));
    if (!start.length) return null; const seen = new Set(start); const stack = [...start];
    while (stack.length) { const l = stack.pop(); for (const m of L) if (!seen.has(m) && (skEq(m[0], l[0]) || skEq(m[0], l[1]) || skEq(m[1], l[0]) || skEq(m[1], l[1]))) { seen.add(m); stack.push(m); } if (seen.size > 16) return null; }
    return [...seen];
  }
  /** The orange band on the selected (or dragged) sketch line. */
  function placeSelSegBand() {
    selSegLine.geometry.dispose(); const g = S.selSeg && (S.tool === 'edit' || LDRAG) ? S.selSeg : null; selSegLine.geometry = new THREE.BufferGeometry();
      if (g) { const dx = g[1][0] - g[0][0], dy = g[1][1] - g[0][1]; const L = Math.hypot(dx, dy) || 1; const mid = to3([(g[0][0] + g[1][0]) / 2, (g[0][1] + g[1][1]) / 2]); const hw = 3 * worldPerPx(mid); const ox = -dy / L * hw, oy = dx / L * hw;
        const c = [[g[0][0] + ox, g[0][1] + oy], [g[1][0] + ox, g[1][1] + oy], [g[1][0] - ox, g[1][1] - oy], [g[0][0] - ox, g[0][1] - oy]].map(q => to3(q, 0.03));
        selSegLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute([...c[0], ...c[1], ...c[2], ...c[0], ...c[2], ...c[3]], 3)); }
      selSegLine.visible = !!g; if (!selSegLine.parent) scene.add(selSegLine); 
  }
  let LDRAG = null; // line drag: { idx, a0, b0, rect, p0, start (all lines at the start) }
  let skGhost = null;
  function showSkGhost(lines) {
    if (skGhost) { scene.remove(skGhost); skGhost.geometry.dispose(); skGhost = null; } if (!lines) { requestRender(); return; }
    const pts = []; for (const [a, b] of lines) pts.push(new THREE.Vector3(...to3(a, 0.01)), new THREE.Vector3(...to3(b, 0.01)));
    skGhost = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x8fa7c8, transparent: true, opacity: 0.45, depthTest: false })); skGhost.renderOrder = 8; scene.add(skGhost); requestRender();
  }
  function beginLineDrag(x, y) {
    const g = lineAt(x, y); if (!g) return false; const ray = rayAt(x, y); const p0 = C.planeHit2D(plane(), ray.o, ray.d); if (!p0) return false;
    record('Move sketch line'); flattenSketch();
    const idx = S.sketchLines.findIndex(l => sameSeg(l, g)); if (idx < 0) return false;
    const [a0, b0] = [S.sketchLines[idx][0].slice(), S.sketchLines[idx][1].slice()];
    const rect = rectAtCorner(a0); const start = S.sketchLines.map(l => [l[0].slice(), l[1].slice()]);
    LDRAG = { idx, a0, b0, rect: !!(rect && rect.some(q => skEq(q, b0))), rectPts: rect, p0, start, cur: [a0, b0] };
    S.selSeg = [a0.slice(), b0.slice()]; S.selVertex = null; S.selRegion = -1; showSkGhost(start); return true;
  }
  function moveLineDrag(x, y) {
    if (!LDRAG) return; const ray = rayAt(x, y); const p = C.planeHit2D(plane(), ray.o, ray.d); if (!p) return;
    S.sketchLines = LDRAG.start.map(l => [l[0].slice(), l[1].slice()]);
    let d = [p[0] - LDRAG.p0[0], p[1] - LDRAG.p0[1]];
    const { a0, b0 } = LDRAG;
    if (LDRAG.rect) { // a rectangle side slides along its own normal only; the sides next to it stretch
      const dx = b0[0] - a0[0], dy = b0[1] - a0[1]; const L = Math.hypot(dx, dy) || 1; const n = [-dy / L, dx / L];
      // keep at least a sliver of width: the side may not pass the opposite side
      const opp = LDRAG.rectPts.filter(q => !skEq(q, a0) && !skEq(q, b0))[0]; const w = (opp[0] - a0[0]) * n[0] + (opp[1] - a0[1]) * n[1];
      let t = snapDist(d[0] * n[0] + d[1] * n[1]); const minW = 1e-3 * Math.max(1, L); if (w > 0) t = Math.min(t, w - minW); else t = Math.max(t, w + minW);
      d = [n[0] * t, n[1] * t];
    } else d = [snapDist(d[0]), snapDist(d[1])];
    const a1 = [a0[0] + d[0], a0[1] + d[1]], b1 = [b0[0] + d[0], b0[1] + d[1]];
    skMovePoint(a0, a1); skMovePoint(b0, b1); LDRAG.cur = [a1, b1]; S.selSeg = [a1.slice(), b1.slice()];
    syncLines(); placeSelSegBand(); requestRender();
  }
  /** After a reshape in a drawing tool the reshaped shape stays selected, so its Extrude / Make profile panel stays. */
  function keepShapeSelected(q) {
    if (S.tool === 'edit' || !q) return; syncScene();
    const on = L => L.some(p => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6); const i = regionCache.findIndex(r => on(r.outer) || (r.holes || []).some(on));
    if (i >= 0) { S.selRegion = i; syncScene(); }
  }
  function endLineDrag() { if (!LDRAG) return; const q = LDRAG.cur && LDRAG.cur[0]; LDRAG = null; showSkGhost(null); if (S.tool !== 'edit') S.selSeg = null; syncScene(); keepShapeSelected(q); }
  /** A rectangle corner drag (as in Shapr3D): the opposite corner stays and the rectangle keeps its own directions; it only
   *  resizes, the dragged corner following the finger. A side never shrinks to nothing (dragging across flips it over). */
  function rectCornerTo(r, np) {
    const i = r.corner; const A = r.P0[(i + 2) % 4], B0 = r.P0[(i + 1) % 4], D0 = r.P0[(i + 3) % 4];
    const lb = Math.hypot(B0[0] - A[0], B0[1] - A[1]), ld = Math.hypot(D0[0] - A[0], D0[1] - A[1]); if (lb < 1e-9 || ld < 1e-9) return;
    const e1 = [(B0[0] - A[0]) / lb, (B0[1] - A[1]) / lb], e2 = [(D0[0] - A[0]) / ld, (D0[1] - A[1]) / ld];
    const minW = 1e-3 * Math.max(1, lb, ld); const keep = (t, t0) => Math.abs(t) >= minW ? t : (t0 >= 0 ? minW : -minW);
    const w = keep(snapDist((np[0] - A[0]) * e1[0] + (np[1] - A[1]) * e1[1]), lb), h = keep(snapDist((np[0] - A[0]) * e2[0] + (np[1] - A[1]) * e2[1]), ld);
    const B = [A[0] + e1[0] * w, A[1] + e1[1] * w], D = [A[0] + e2[0] * h, A[1] + e2[1] * h], Cn = [A[0] + e1[0] * w + e2[0] * h, A[1] + e1[1] * w + e2[1] * h];
    S.sketchLines = r.start.map(l => [l[0].slice(), l[1].slice()]);
    skMovePoint(r.P0[i], Cn); skMovePoint(B0, B); skMovePoint(D0, D);
  }
  // side lengths of the shape being edited, as labels on each side (the selected side's label can be tapped to type a length)
  const skLenEls = []; let skLenEditing = false;
  { const st = document.createElement('style'); st.textContent = `.sk-len { font-size: 11px; padding: 2px 6px; cursor: default; pointer-events: none; } .sk-len.sel { pointer-events: auto; cursor: pointer; border-color: var(--accent); text-decoration: underline dotted; } .sk-len input { width: 56px; font: inherit; border: 0; background: transparent; color: var(--fg); outline: none; }`; document.head.appendChild(st); }
  function skShapeSegs() {
    if (!S.plane || (S.tool !== 'edit' && !LDRAG && !(VDRAG && VDRAG.cur))) return null; const seed = LDRAG ? LDRAG.cur : VDRAG && VDRAG.cur ? VDRAG.cur : S.selSeg || S.selVertex; if (!seed) return null;
    const all = sketchSegments(); const isSeg = Array.isArray(seed[0]);
    const touches = (l, q) => skEq(l[0], q) || skEq(l[1], q); const start = all.filter(l => isSeg ? sameSeg(l, seed) : touches(l, seed)); if (!start.length) return null;
    const seen = new Set(start), stack = [...start]; while (stack.length) { const l = stack.pop(); for (const m of all) if (!seen.has(m) && (touches(m, l[0]) || touches(m, l[1]))) { seen.add(m); stack.push(m); } if (seen.size > 16) return null; }
    return [...seen];
  }
  function placeSkLengths() {
    const segs = skLenEditing ? null : skShapeSegs(); const n = segs ? segs.length : 0;
    while (skLenEls.length < n) { const d = document.createElement('div'); d.className = 'fil-pill sk-len'; document.body.appendChild(d); d.onclick = () => { if (d.dataset.sel === '1') typeSkLength(d); }; skLenEls.push(d); }
    if (skLenEditing) return;
    const cen = n ? segs.reduce((a, l) => [a[0] + (l[0][0] + l[1][0]) / (2 * n), a[1] + (l[0][1] + l[1][1]) / (2 * n)], [0, 0]) : null;
    skLenEls.forEach((d, i) => { if (i >= n) { d.hidden = true; return; } const [a, b] = segs[i]; const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const o = [m[0] - cen[0], m[1] - cen[1]]; const lo = Math.hypot(...o) || 1; const off = 14 * worldPerPx(to3(m)); const at = [m[0] + o[0] / lo * off, m[1] + o[1] / lo * off];
      const c = project(to3(at, 0.02)); if (!c.ok) { d.hidden = true; return; } d.hidden = false; d.textContent = fmtDim(len); const sel = !!(S.selSeg && sameSeg([a, b], S.selSeg)); d.classList.toggle('sel', sel); d.dataset.sel = sel ? '1' : '0';
      d.dataset.i = String(i); d.style.left = c.x + 'px'; d.style.top = c.y + 'px'; d.style.transform = 'translate(-50%, -50%)'; });
  }
  /** Type the selected side's length: on a rectangle the far side moves with it (still a rectangle); on a polyline its end moves. */
  function typeSkLength(d) {
    if (skLenEditing || !S.selSeg) return; skLenEditing = true; const g = S.selSeg.map(q => q.slice());
    const inp = document.createElement('input'); inp.type = 'number'; inp.step = 'any'; inp.inputMode = 'decimal'; inp.value = (+Math.hypot(g[1][0] - g[0][0], g[1][1] - g[0][1]).toFixed(4)).toString(); d.replaceChildren(inp);
    const done = ok => { if (!skLenEditing) return; skLenEditing = false; const v = parseFloat(inp.value); if (ok && v > 1e-6) setSkLength(g, v); else syncScene(); };
    inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') done(false); }; inp.onblur = () => done(true); setTimeout(() => { inp.focus(); inp.select(); }, 0);
  }
  function setSkLength(g, L) {
    step(() => { flattenSketch(); const idx = S.sketchLines.findIndex(l => sameSeg(l, g)); if (idx < 0) return; const a = S.sketchLines[idx][0].slice(), b = S.sketchLines[idx][1].slice();
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len]; const dl = L - len; const P = rectAtCorner(a);
      if (P && P.some(q => skEq(q, b))) { const bi = P.findIndex(q => skEq(q, b)); const nb = [P[(bi + 1) % 4], P[(bi + 3) % 4]].find(q => !skEq(q, a)); const nb1 = [nb[0] + u[0] * dl, nb[1] + u[1] * dl];
        const b1 = [b[0] + u[0] * dl, b[1] + u[1] * dl]; skMovePoint(b, b1); skMovePoint(nb, nb1); S.selSeg = [a, b1]; }
      else { const b1 = [a[0] + u[0] * L, a[1] + u[1] * L]; skMovePoint(b, b1); S.selSeg = [a, b1]; }
    }, 'Set length');
    syncScene();
  }
  let VDRAG = null;
  function beginVertexDrag(x, y) {
    const v = vertexAt(x, y); if (!v) return false; record('Move sketch point');
    if (isSketchTool(S.tool)) { flattenSketch(); const v2 = vertexAt(x, y) || v; const P = rectAtCorner(v2.p);
      if (P) { v2.rect = { P0: P.map(q => q.slice()), corner: P.findIndex(q => skEq(q, v2.p)), start: S.sketchLines.map(l => [l[0].slice(), l[1].slice()]) }; showSkGhost(v2.rect.start); }
      else showSkGhost(S.sketchLines.map(l => [l[0].slice(), l[1].slice()]));   // the faint original, for any point
      const hadMark = !!(S.selSeg || S.selVertex); VDRAG = v2; S.selVertex = null; S.selSeg = null; if (hadMark) syncScene();   // old highlights go at once; the point is marked again where it lands
      return true; }
    VDRAG = v; const had = !!S.selVertex; S.selVertex = null; if (had) syncScene(); return true;
  }
  function moveVertexDrag(x, y) {
    if (!VDRAG) return; const ray = rayAt(x, y); const p = C.planeHit2D(plane(), ray.o, ray.d); if (!p) return;
    const orig = VDRAG.p; const segs = snapCandidateSegments().filter(([a, b]) => Math.hypot(a[0] - orig[0], a[1] - orig[1]) > 1e-9 && Math.hypot(b[0] - orig[0], b[1] - orig[1]) > 1e-9 && !(VDRAG.cur && (Math.hypot(a[0] - VDRAG.cur[0], a[1] - VDRAG.cur[1]) < 1e-9 || Math.hypot(b[0] - VDRAG.cur[0], b[1] - VDRAG.cur[1]) < 1e-9)));
    const np = snapPointWith(p, segs, null); VDRAG.cur = np; showSnapTip(np, S.lastSnap, null);
    if (VDRAG.rect) { rectCornerTo(VDRAG.rect, np); syncLines(); requestRender(); return; }
    for (const r of VDRAG.refs) r.set([np[0], np[1]]);
    if (S.lineStart && Math.hypot(S.lineStart[0] - orig[0], S.lineStart[1] - orig[1]) < 1e-9) S.lineStart = [np[0], np[1]];
    syncLines(); requestRender();
  }
  function endVertexDrag() { if (!VDRAG) return; const moved = VDRAG.cur; showSkGhost(null); S.selVertex = S.tool !== 'edit' ? null : moved ? [moved[0], moved[1]] : VDRAG.p; VDRAG = null; if (moved) setTimeout(() => keepShapeSelected(moved), 0); if (moved) showSnapTip(moved, S.lastSnap, 1200); syncScene(); }
  /** Turns the current closed outline (the shape just drawn) into ordinary lines, so single lines can be removed. */
  function flattenSketch() {
    const P = S.sketch; if (P.length >= 2) { for (let i = 0; i + 1 < P.length; i++) S.sketchLines.push([P[i].slice(), P[i + 1].slice()]); if (S.sketchClosed && P.length >= 3) S.sketchLines.push([P[P.length - 1].slice(), P[0].slice()]); }
    S.sketch = []; S.sketchClosed = false; S.circle = null; S.lineStart = null; S.lastLine = -1;
  }
  const samePt = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9;
  const sameSeg = (l, g) => (samePt(l[0], g[0]) && samePt(l[1], g[1])) || (samePt(l[0], g[1]) && samePt(l[1], g[0]));
  /** The sketch line under a screen point (within 14 px), as [a, b], or null. */
  function lineAt(x, y) {
    let best = null;
    // a line counts wherever it is in front of the camera: a long line running off the screen edge can still be tapped
    for (const [a, b] of sketchSegments()) { const A = projectFront(to3(a)), B = projectFront(to3(b)); if (!A.ok || !B.ok) continue; const dx = B.x - A.x, dy = B.y - A.y; const L2 = dx * dx + dy * dy || 1; const u = Math.max(0, Math.min(1, ((x - A.x) * dx + (y - A.y) * dy) / L2)); const d = Math.hypot(A.x + dx * u - x, A.y + dy * u - y);
      if (d < 14 && (!best || d < best.d)) best = { d, seg: [a.slice(), b.slice()] }; }
    return best ? best.seg : null;
  }
  function deleteSelectedLine() {
    const g = S.selSeg; if (!g) return;
    step(() => { flattenSketch(); S.sketchLines = S.sketchLines.filter(l => !sameSeg(l, g)); S.selSeg = null; S.selRegion = -1; S.selVertex = null; syncScene(); }, 'Delete line');
    toast('Line deleted · Undo brings it back');
  }
  const pointInPoly = (p, L) => { let inside = false; for (let i = 0, j = L.length - 1; i < L.length; j = i++) { const a = L[i], b = L[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; } return inside; };
  /** A hole of a shape under a sketch point (a circle drawn inside a rectangle), as { region, hole } or null. */
  function holeAt(p) { for (let i = 0; i < regionCache.length; i++) { const hs = regionCache[i].holes || []; for (let k = 0; k < hs.length; k++) if (pointInPoly(p, hs[k])) return { region: i, hole: k }; } return null; }
  /**
   * Deletes a closed shape's outer outline (its holes stay: a circle drawn inside becomes a shape of its own), or the hole
   * picked by tapping inside it. An edge shared with a neighbouring shape's outline stays, so that shape stays closed.
   */
  function deleteSelectedShape() {
    const sh = S.selHole; const r = sh ? regionCache[sh.region] : regionCache[S.selRegion]; if (!r) return;
    const onLoop = (p, L) => { for (let i = 0; i < L.length; i++) { const a = L[i], b = L[(i + 1) % L.length]; const dx = b[0] - a[0], dy = b[1] - a[1]; const L2 = dx * dx + dy * dy || 1; const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)); if (Math.hypot(a[0] + dx * u - p[0], a[1] + dy * u - p[1]) < 1e-6) return true; } return false; };
    const onLoops = (l, loops) => { const m = [(l[0][0] + l[1][0]) / 2, (l[0][1] + l[1][1]) / 2]; return loops.some(L => onLoop(l[0], L) && onLoop(l[1], L) && onLoop(m, L)); };
    const mine = sh ? [r.holes[sh.hole]] : [r.outer]; const otherOuters = regionCache.filter(o => o !== r).map(o => o.outer);
    step(() => { flattenSketch(); S.sketchLines = S.sketchLines.filter(l => !(onLoops(l, mine) && !onLoops(l, otherOuters))); S.selRegion = -1; S.selHole = null; S.selSeg = null; S.selVertex = null; syncScene(); }, 'Delete shape');
    toast('Shape deleted · Undo brings it back');
  }
  function deleteSelectedVertex() {
    const v = S.selVertex; if (!v) return;
    named('Delete point', () => step(() => { const same = q => Math.hypot(q[0] - v[0], q[1] - v[1]) < 1e-9; S.sketchLines = S.sketchLines.filter(l => !same(l[0]) && !same(l[1])); if (S.sketch.some(same)) { S.sketch = S.sketch.filter(q => !same(q)); if (S.sketch.length < 3) S.sketchClosed = false; } S.selVertex = null; S.lastLine = -1; syncScene(); }));
  }
  // the selected sketch line: an orange band ~6 px wide lying in the sketch plane (WebGL draws plain lines 1 px thin)
  const selSegLine = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xff9a2e, depthTest: false, side: THREE.DoubleSide, transparent: true, opacity: 0.95 })); selSegLine.renderOrder = 13;
  const selVertexPt = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xff9a2e, size: 14, sizeAttenuation: false, depthTest: false })); selVertexPt.renderOrder = 13; scene.add(selVertexPt);

  // ---------- actions ----------
  function replaceBody(body, man, keepFace = false) {
    pushUndo();
    let md; try { md = C.meshData(man); } catch (e) { toast('Operation produced invalid geometry'); return false; }
    S.bodies = S.bodies.map(b => b.id === body.id ? { ...b, man, md } : b);
    if (!keepFace) S.selectedFace = null;
    commit(); return true;
  }
  // ---------- Profiles and Loft (Shapr3D-style): flat shapes kept in the scene, lofted in the order they are tapped ----------
  const profGroup = new THREE.Group(); scene.add(profGroup); let profKey = null; const profMeshes = [];
  const profLabelEls = [];
  const profById = id => S.profiles.find(q => q.id === id);
  const profCentre = q => { const L = q.outer; const c = L.reduce((a, p) => [a[0] + p[0] / L.length, a[1] + p[1] / L.length], [0, 0]); return C.frameToWorld(q.frame, c[0], c[1], 0); };
  function profMatrix(f) { const m = new THREE.Matrix4(); m.set(f.u[0], f.v[0], f.n[0], f.origin[0], f.u[1], f.v[1], f.n[1], f.origin[1], f.u[2], f.v[2], f.n[2], f.origin[2], 0, 0, 0, 1); return m; }
  /** Profiles are drawn as see-through sheets with an outline; selected ones are brighter and numbered in tap order. */
  function syncProfiles() {
    const exId = SESSION && SESSION.target && SESSION.target.kind === 'region' && SESSION.target.profId != null && Math.abs(SESSION.value || 0) > 1e-9 ? SESSION.target.profId : null;
    const key = S.profiles.map(q => (q.hidden ? 'h' : '') + q.id + '@' + q.frame.origin.join(',') + '/' + q.frame.n.join(',') + '#' + q.outer.length).join(';') + '|' + S.selProfiles.join(',') + '|' + (dark() ? 1 : 0) + '|x' + exId;
    if (key !== profKey) {
      profKey = key; for (const c of [...profGroup.children]) { profGroup.remove(c); c.geometry && c.geometry.dispose(); } profMeshes.length = 0;
      for (const q of S.profiles) { if (q.hidden) continue;
        const sel = S.selProfiles.includes(q.id); const shape = new THREE.Shape(q.outer.map(p => new THREE.Vector2(p[0], p[1])));
        for (const h of q.holes || []) shape.holes.push(new THREE.Path(h.map(p => new THREE.Vector2(p[0], p[1]))));
        const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: sel ? 0x38bdf0 : 0x8fd8ee, transparent: true, opacity: q.id === exId ? 0.06 : (sel ? 0.7 : 0.32), side: THREE.DoubleSide, depthWrite: false }));
        mesh.matrixAutoUpdate = false; mesh.matrix.copy(profMatrix(q.frame)); mesh.userData.profId = q.id; mesh.renderOrder = 3; profGroup.add(mesh); profMeshes.push(mesh);
        for (const L of [q.outer, ...(q.holes || [])]) { const pts = L.map(p => new THREE.Vector3(p[0], p[1], 0)); pts.push(pts[0].clone()); const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: sel ? 0x1a8fc0 : 0x5fb8d6 })); line.matrixAutoUpdate = false; line.matrix.copy(profMatrix(q.frame)); line.renderOrder = 4; profGroup.add(line); }
      }
    }
    placeProfileBadges();
  }
  /** The tap order, as small numbered badges on the profiles; placed every frame so they follow the view. */
  function placeProfileBadges() {
    while (profLabelEls.length < S.selProfiles.length) { const d = document.createElement('div'); d.className = 'fil-pill prof-num'; document.body.appendChild(d); profLabelEls.push(d); }
    profLabelEls.forEach((d, i) => { const q = profById(S.selProfiles[i]); if (!q || (LF == null && S.tool !== 'select' && S.tool !== 'move')) { d.hidden = true; return; } const c = project(profCentre(q)); if (!c.ok) { d.hidden = true; return; } d.hidden = false; d.textContent = String(i + 1); d.style.left = (c.x + 16) + 'px'; d.style.top = (c.y - 16) + 'px'; d.style.transform = 'translate(-50%, -50%)'; d.style.pointerEvents = 'none'; });   // (beside the centre point, and never in the way of a finger)
  }
  // every profile shows its centre (a point to grab) in Select and Move/Rotate
  const profCentreMarks = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0x7fb3ff, size: 9, sizeAttenuation: false, depthTest: false })); profCentreMarks.renderOrder = 12;
  function syncProfCentres() {
    const on = (S.tool === 'select' || S.tool === 'move') && !LF; const ps = on ? (S.profiles || []) : [];
    profCentreMarks.geometry.dispose(); profCentreMarks.geometry = new THREE.BufferGeometry().setFromPoints(ps.map(q => new THREE.Vector3(...profCentre(q))));
    profCentreMarks.visible = ps.length > 0; profCentreMarks.userData.count = ps.length; if (!profCentreMarks.parent) scene.add(profCentreMarks);
  }
  /** The profile whose centre is under a screen point (within 22 px), or null. */
  function profCentreAt(x, y) { let best = null; for (const q of S.profiles || []) { const c = project(profCentre(q)); if (!c.ok) continue; const d = Math.hypot(c.x - x, c.y - y); if (d < 22 && (!best || d < best.d)) best = { d, q }; } return best ? best.q : null; }
  /** Points a moved profile's centre can snap onto: path points, other profiles' centres, body points, sketch points, the origin. */
  function profSnapTargets(skipId) {
    const T = [[0, 0, 0]];
    for (const q of S.paths || []) for (const p of q.pts) T.push(C.frameToWorld(q.frame, p[0], p[1], 0));
    for (const q of S.profiles || []) if (q.id !== skipId) T.push(profCentre(q));
    for (const b of S.bodies) for (const w of C.scaleSnapPoints(b.md)) T.push(w.p || w);
    if (S.plane) for (const c of C.notablePoints(sketchSegments())) T.push(to3(c.p));
    return T;
  }
  // Profile centre drag: the profile slides in its own plane (a plane facing the camera when seen edge-on), keeping its
  // orientation; within 22 px of one of those points its centre lands exactly on it
  let PCD = null;
  // while a profile is dragged by its centre, its original outline stays faintly where it was
  let profGhost = null;
  function showProfGhost(q) {
    if (profGhost) { scene.remove(profGhost); profGhost.geometry.dispose(); profGhost = null; } if (!q) { requestRender(); return; }
    const pts = []; for (const L of [q.outer, ...(q.holes || [])]) for (let i = 0; i < L.length; i++) { const a = L[i], b = L[(i + 1) % L.length]; pts.push(new THREE.Vector3(...C.frameToWorld(q.frame, a[0], a[1], 0)), new THREE.Vector3(...C.frameToWorld(q.frame, b[0], b[1], 0))); }
    profGhost = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x8fa7c8, transparent: true, opacity: 0.5, depthTest: false })); profGhost.renderOrder = 9; scene.add(profGhost); requestRender();
  }
  function beginProfDrag(id) { const q = profById(id); if (!q) return false; record(`Move ${q.name}`); PCD = { id, c0: profCentre(q), f0: q.frame, targets: profSnapTargets(id), snapped: false }; showProfGhost(q); return true; }
  function moveProfDrag(x, y) {
    if (!PCD) return; const ray = rayAt(x, y); let n = PCD.f0.n; let den = ray.d[0] * n[0] + ray.d[1] * n[1] + ray.d[2] * n[2];
    if (Math.abs(den) < 0.15) { const f = new THREE.Vector3(); camera.getWorldDirection(f); n = [f.x, f.y, f.z]; den = ray.d[0] * n[0] + ray.d[1] * n[1] + ray.d[2] * n[2]; }
    const c0 = PCD.c0; const t = ((c0[0] - ray.o[0]) * n[0] + (c0[1] - ray.o[1]) * n[1] + (c0[2] - ray.o[2]) * n[2]) / den; if (!(t > 0)) return;
    let c = [ray.o[0] + ray.d[0] * t, ray.o[1] + ray.d[1] * t, ray.o[2] + ray.d[2] * t]; let best = null;
    for (const w of PCD.targets) { const q2 = project(w); if (!q2.ok) continue; const d = Math.hypot(q2.x - x, q2.y - y); if (d < 22 && (!best || d < best.d)) best = { d, w }; }
    if (best) c = best.w.slice(); PCD.snapped = !!best;
    const o = [PCD.f0.origin[0] + c[0] - c0[0], PCD.f0.origin[1] + c[1] - c0[1], PCD.f0.origin[2] + c[2] - c0[2]];
    S.profiles = S.profiles.map(q => q.id === PCD.id ? { ...q, frame: { ...q.frame, origin: o } } : q); syncScene();
  }
  function endProfDrag() { if (!PCD) return; const id = PCD.id; PCD = null; showProfGhost(null); if (S.tool === 'select' && !S.selProfiles.includes(id)) S.selProfiles = [id]; syncScene(); renderUI(); }
  /** Places a profile so its centre is exactly at c (typed values); one undo step. */
  function setProfCentre(id, c) { const q = profById(id); if (!q || !c.every(isFinite)) return; const c0 = profCentre(q);
    step(() => { S.profiles = S.profiles.map(p => p.id === id ? { ...p, frame: { ...p.frame, origin: [p.frame.origin[0] + c[0] - c0[0], p.frame.origin[1] + c[1] - c0[1], p.frame.origin[2] + c[2] - c0[2]] } } : p); syncScene(); }, `Move ${q.name}`); renderUI(); }
  /** A selected profile's centre as X, Y, Z to type (an action row, so it stays in view when the panel is folded). */
  function profCentreRow(q) {
    if (!q) return; const c = profCentre(q); const act = el('div', 'row scroll'); const fmt = v => String(Math.round(v * 1000) / 1000);
    for (const [k, lab, v] of [['cx', 'X', c[0]], ['cy', 'Y', c[1]], ['cz', 'Z', c[2]]]) { const w = el('label', 'note', lab + ' '); const inp = document.createElement('input'); inp.type = 'number'; inp.step = 'any'; inp.className = 'num'; inp.dataset.field = k; inp.value = fmt(v); inp.style.width = '60px'; w.append(inp); act.append(w); }
    act.append(chip('Apply', () => { const g = k => parseFloat((panelEl.querySelector(`input[data-field='${k}']`) || {}).value); setProfCentre(q.id, [g('cx'), g('cy'), g('cz')]); }, true)); panelEl.append(act);
  }
  function pickProfile(ray) { raycaster.set(new THREE.Vector3(...ray.o), new THREE.Vector3(...ray.d)); const h = raycaster.intersectObjects(profMeshes, false)[0]; return h ? { id: h.object.userData.profId, distance: h.distance } : null; }
  /** A profile tap wins when it is in front of any body under the finger. */
  function profileUnder(ray) { const pp = pickProfile(ray); if (!pp) return null; const bh = pick(ray); if (!bh || pp.distance <= bh.distance + 1e-6) return pp;
    // a profile just under a face (moved a little into the body) can still be tapped through it: up to its own size deep
    const q = profById(pp.id); let r = 0; if (q && q.outer && q.outer.length) { const c = q.outer.reduce((a, p) => [a[0] + p[0] / q.outer.length, a[1] + p[1] / q.outer.length], [0, 0]); for (const p of q.outer) r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1])); }
    return pp.distance <= bh.distance + Math.max(1e-6, 2 * r) ? pp : null; }
  function newProfile(outer, holes, frame) { const id = S.nextProfileId++; return { id, name: `Profile ${id}`, frame: { origin: frame.origin.slice(), u: frame.u.slice(), v: frame.v.slice(), n: frame.n.slice() }, outer: outer.map(p => [p[0], p[1]]), holes: (holes || []).map(h => h.map(p => [p[0], p[1]])) }; }
  /** The drawn closed shape, or the tapped shape of a line sketch, becomes a profile (and leaves the sketch). */
  function makeProfileFromSketch() {
    const pl = plane(); let outer = null, holes = [];
    if (S.sketchClosed && S.sketch.length >= 3) outer = S.sketch;
    else if (S.selRegion >= 0 && regionCache[S.selRegion]) { const r = regionCache[S.selRegion]; outer = r.outer; holes = r.holes || []; }
    if (!outer) { toast('Close a shape first, or tap one'); return; }
    const q = newProfile(outer, holes, pl);
    step(() => {
      if (S.sketchClosed && S.sketch.length >= 3 && outer === S.sketch) { S.sketch = []; S.sketchClosed = false; S.circle = null; S.lineStart = null; }
      else { const keepSel = S.selRegion; S.selHole = null; deleteShapeLinesSilently(keepSel); }
      S.profiles = [...S.profiles, q]; S.selRegion = -1; S.selProfiles = [];
    }, 'Profile ' + q.id);
    commit(); toast(`${q.name} made · tap profiles in order, then Loft`);
  }
  function deleteShapeLinesSilently(ri) { const prev = S.selRegion; S.selRegion = ri; const r = regionCache[ri]; if (!r) return;
    const onLoop = (p, L) => { for (let i = 0; i < L.length; i++) { const a = L[i], b = L[(i + 1) % L.length]; const dx = b[0] - a[0], dy = b[1] - a[1]; const L2 = dx * dx + dy * dy || 1; const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)); if (Math.hypot(a[0] + dx * u - p[0], a[1] + dy * u - p[1]) < 1e-6) return true; } return false; };
    const onLoops = (l, loops) => { const m = [(l[0][0] + l[1][0]) / 2, (l[0][1] + l[1][1]) / 2]; return loops.some(L => onLoop(l[0], L) && onLoop(l[1], L) && onLoop(m, L)); };
    const mine = [r.outer, ...(r.holes || [])]; const otherOuters = regionCache.filter(o => o !== r).map(o => o.outer);
    flattenSketch(); S.sketchLines = S.sketchLines.filter(l => !(onLoops(l, mine) && !onLoops(l, otherOuters))); S.selRegion = prev; }
  /** Revolve a profile: it opens as a sketch on its own plane and the revolve waits for its axis line. */
  function revolveProfile(id) { editProfile(id); setTool('select', true); let regs = []; try { regs = lineRegions(); } catch (e) { regs = []; } S.selRegion = regs.length ? 0 : -1; syncScene(); if (regs.length) startRevolvePick([regs[0]]); else toast('Tap the shape, then the revolve button'); }
  /** Opens a profile as a sketch on its own plane (to change its size or shape); Make profile turns it back. */
  function editProfile(id) {
    const q = profById(id); if (!q) return; if (LF) lfDrop();
    step(() => {
      S.plane = { origin: q.frame.origin.slice(), u: q.frame.u.slice(), v: q.frame.v.slice(), n: q.frame.n.slice(), name: `${q.name} plane` };
      flattenSketch(); S.sketchLines = []; for (const L of [q.outer, ...(q.holes || [])]) for (let i = 0; i < L.length; i++) S.sketchLines.push([[L[i][0], L[i][1]], [L[(i + 1) % L.length][0], L[(i + 1) % L.length][1]]]);
      S.profiles = S.profiles.filter(x => x.id !== id); S.selProfiles = [];
    }, 'Edit ' + q.name);
    setTool('edit'); commit(); toast('Editing the profile as a sketch · tap it, then Make profile to keep it');
  }
  function deleteSelectedProfiles() { const ids = S.selProfiles.slice(); if (!ids.length) return; if (LF) lfDrop(); step(() => { S.profiles = S.profiles.filter(q => !ids.includes(q.id)); S.selProfiles = []; }, `Delete ${ids.length === 1 ? (profById(ids[0]) || {}).name : ids.length + ' profiles'}`); commit(); toast('Deleted · Undo brings it back'); }
  // Loft session: live preview (a see-through body, the guide lines through matching corners, dots on every corner)
  let LF = null; const lfGroup = new THREE.Group(); scene.add(lfGroup);
  const lfSections = ids => ids.map(profById).filter(Boolean).map(q => ({ frame: q.frame, outer: q.outer, holes: q.holes || [] }));
  function lfDrop() { if (!LF) return; for (const c of [...lfGroup.children]) { lfGroup.remove(c); c.geometry && c.geometry.dispose(); } LF = null; }
  function lfBuild() {
    for (const c of [...lfGroup.children]) { lfGroup.remove(c); c.geometry && c.geometry.dispose(); } LF.error = null; LF.preview = null; LF.guides = null; LF.dots = null; LF.volume = null;
    try {
      const secs = lfSections(LF.ids); const solid = C.loft(secs, { smooth: LF.smooth, steps: 10 }); const md = C.meshData(solid); LF.volume = solid.volume();
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(md.positions, 3)); g.setIndex(new THREE.BufferAttribute(md.indices, 1)); g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, new THREE.MeshPhongMaterial({ color: 0xf2f4f8, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false })); mesh.renderOrder = 5; lfGroup.add(mesh); LF.preview = mesh;
      const gd = C.loftGuides(secs, { smooth: LF.smooth }); LF.guides = gd.corners; LF.dots = gd.dots;
      for (const G of gd.corners) { const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(G.map(p => new THREE.Vector3(...p))), new THREE.LineBasicMaterial({ color: 0x5b6472, depthTest: false })); line.renderOrder = 6; lfGroup.add(line); }
      const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(gd.dots.map(p => new THREE.Vector3(...p))), new THREE.PointsMaterial({ color: 0xffffff, size: 9, sizeAttenuation: false, depthTest: false })); dots.renderOrder = 7; lfGroup.add(dots);
    } catch (e) { LF.error = e.message || String(e); }
    requestRender();
  }
  function startLoft() { if (S.selProfiles.length < 2) { toast('Tap at least two profiles, in the order the loft passes through them'); return; } LF = { ids: S.selProfiles.slice(), smooth: true }; lfBuild(); renderUI(); }
  function applyLoft() {
    if (!LF) return; let man; try { man = C.loft(lfSections(LF.ids), { smooth: LF.smooth }); } catch (e) { toast(e.message || String(e)); return; }
    const ids = LF.ids; const name = `Loft ${S.nextId}`;
    step(() => { const b = makeBodyRecord('Loft', man); S.bodies = [...S.bodies, b]; S.selectedId = b.id; S.profiles = S.profiles.filter(q => !ids.includes(q.id)); S.selProfiles = []; }, `Loft through ${ids.length} profiles${LF.smooth ? '' : ' (straight)'}`);
    lfDrop(); commit(); toast(`${name} made from ${ids.length} profiles`);
  }
  // ---------- Paths and Sweep (Shapr3D-style): an open chain of sketch lines kept in the scene; a profile swept along it ----------
  const pathGroup = new THREE.Group(); scene.add(pathGroup);
  const pathById = id => S.paths.find(q => q.id === id);
  const pathW = q => q.pts.map(p => C.frameToWorld(q.frame, p[0], p[1], 0));
  const pathSegCount = q => q.closed ? q.pts.length : q.pts.length - 1;
  /** Paths are drawn as teal lines; the edges picked for a sweep as a brighter band. */
  function syncPaths() {
    for (const c of [...pathGroup.children]) { pathGroup.remove(c); c.geometry && c.geometry.dispose(); }
    for (const q of S.paths) {
      const W = pathW(q); const pts = W.map(p => new THREE.Vector3(...p)); if (q.closed) pts.push(pts[0].clone());
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x31c1b4, depthTest: false })); line.renderOrder = 8; pathGroup.add(line);
      if (S.selPath && S.selPath.id === q.id) for (const i of S.selPath.segs) {
        const a = W[i], b = W[(i + 1) % W.length]; const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; const hw = 3 * worldPerPx(mid);
        const d = v3norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]); const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); let o = v3norm(v3cross(d, [fwd.x, fwd.y, fwd.z])); o = o.map(x => x * hw);
        const c4 = [[a[0] + o[0], a[1] + o[1], a[2] + o[2]], [b[0] + o[0], b[1] + o[1], b[2] + o[2]], [b[0] - o[0], b[1] - o[1], b[2] - o[2]], [a[0] - o[0], a[1] - o[1], a[2] - o[2]]];
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([...c4[0], ...c4[1], ...c4[2], ...c4[0], ...c4[2], ...c4[3]], 3));
        const band = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x38bdf0, side: THREE.DoubleSide, depthTest: false })); band.renderOrder = 9; pathGroup.add(band);
      }
    }
  }
  /** The path edge under a screen point (within 14 px): { id, i } or null. */
  function pathSegAt(x, y) {
    let best = null;
    for (const q of S.paths) { const W = pathW(q); const k = pathSegCount(q);
      for (let i = 0; i < k; i++) { const A = project(W[i]), B = project(W[(i + 1) % W.length]); if (!A.ok || !B.ok) continue; const dx = B.x - A.x, dy = B.y - A.y; const L2 = dx * dx + dy * dy || 1; const u = Math.max(0, Math.min(1, ((x - A.x) * dx + (y - A.y) * dy) / L2)); const d = Math.hypot(A.x + dx * u - x, A.y + dy * u - y);
        if (d < 14 && (!best || d < best.d)) best = { d, id: q.id, i }; } }
    return best;
  }
  /** The chain of connected sketch lines through a seed line (ordered points; closed when it comes back round). */
  function chainThrough(segs, seed) {
    const key = p => p[0].toFixed(9) + ',' + p[1].toFixed(9); const at = new Map();
    segs.forEach((sg, i) => { for (const p of sg) { const k = key(p); if (!at.has(k)) at.set(k, []); at.get(k).push(i); } });
    const used = new Set([seed]); let pts = [segs[seed][0], segs[seed][1]];
    const grow = (end, front) => { for (;;) { const k = key(end); const nx = (at.get(k) || []).filter(i => !used.has(i)); if (nx.length !== 1 || at.get(k).length !== 2) return; const i = nx[0]; used.add(i); const sg = segs[i]; const other = key(sg[0]) === k ? sg[1] : sg[0]; if (front) pts.unshift(other); else pts.push(other); end = other; } };
    grow(pts[pts.length - 1], false); grow(pts[0], true);
    let closed = false; if (pts.length > 3 && key(pts[0]) === key(pts[pts.length - 1])) { pts.pop(); closed = true; }
    return { pts, closed, used };
  }
  /** Keeps an open chain of the sketch as a path: the chain being drawn, the one through the selected line, or the longest. */
  function makePathFromSketch() {
    const pl = plane(); let pts = null, closed = false, lines = null;
    if (S.sketch.length >= 2 && !S.sketchClosed) pts = S.sketch.map(p => [p[0], p[1]]);
    else {
      const segs = S.sketchLines.map(l => [l[0], l[1]]); if (!segs.length) { toast('Draw a chain of lines first'); return; }
      let seed = S.selSeg ? segs.findIndex(l => sameSeg(l, S.selSeg)) : -1; let ch = null;
      if (seed >= 0) ch = chainThrough(segs, seed); else { for (let i = 0; i < segs.length; i++) { const c2 = chainThrough(segs, i); if (!ch || c2.pts.length > ch.pts.length) ch = c2; } }
      pts = ch.pts.map(p => [p[0], p[1]]); closed = ch.closed; lines = ch.used;
    }
    const id = S.nextPathId++; const q = { id, name: `Path ${id}`, frame: { origin: pl.origin.slice(), u: pl.u.slice(), v: pl.v.slice(), n: pl.n.slice() }, pts, closed };
    step(() => { if (lines) S.sketchLines = S.sketchLines.filter((_, i) => !lines.has(i)); else { S.sketch = []; S.sketchClosed = false; S.lineStart = null; } S.paths = [...S.paths, q]; S.selSeg = null; S.selRegion = -1; }, q.name);
    commit(); toast(`${q.name} made · tap a profile and the path's edges, then Sweep`);
  }
  const selPathLength = () => { const sp = S.selPath; const q = sp && pathById(sp.id); if (!q) return 0; const W = pathW(q); return sp.segs.reduce((t, i) => { const a = W[i], b = W[(i + 1) % W.length]; return t + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); }, 0); };
  /** The picked edges as one run along the path: its points in order (closed when the whole closed path is picked), or null. */
  function selRun() {
    const sp = S.selPath; const q = sp && pathById(sp.id); if (!q || !sp.segs.length) return null; const k = pathSegCount(q); const set = new Set(sp.segs); const W = pathW(q);
    if (q.closed && set.size === k) return { pts: W, closed: true };
    let s0 = -1; for (const i of set) if (!set.has(q.closed ? (i - 1 + k) % k : i - 1)) { s0 = i; break; } if (s0 < 0) return null;
    const pts = [W[s0]]; let n = 0; for (let i = s0; set.has(i) && n < k; i = q.closed ? (i + 1) % k : i + 1, n++) pts.push(W[(i + 1) % W.length]);
    return n === set.size ? { pts, closed: false } : null;
  }
  // Sweep session: live preview of the profile carried along the picked edges
  let SW = null; const swGroup = new THREE.Group(); scene.add(swGroup);
  function swDrop() { if (!SW) return; for (const c of [...swGroup.children]) { swGroup.remove(c); c.geometry && c.geometry.dispose(); } SW = null; }
  function swBuild() {
    for (const c of [...swGroup.children]) { swGroup.remove(c); c.geometry && c.geometry.dispose(); } SW.error = null; SW.preview = null; SW.volume = null;
    try {
      const q = profById(SW.profileId); const run = SW.run; const solid = C.sweep({ frame: q.frame, outer: q.outer, holes: q.holes || [] }, run, { round: SW.round }); const md = C.meshData(solid); SW.volume = solid.volume(); SW.solid = solid;
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(md.positions, 3)); g.setIndex(new THREE.BufferAttribute(md.indices, 1)); g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, new THREE.MeshPhongMaterial({ color: 0xf2f4f8, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false })); mesh.renderOrder = 5; swGroup.add(mesh); SW.preview = mesh;
    } catch (e) { SW.error = e.message || String(e); SW.solid = null; }
    requestRender();
  }
  function startSweep() {
    if (S.selProfiles.length !== 1 || !S.selPath) { toast('Tap one profile and the path edges to sweep it along'); return; }
    const run = selRun(); if (!run) { toast('The picked edges must join up one after another'); return; }
    SW = { profileId: S.selProfiles[0], pathId: S.selPath.id, run, edges: S.selPath.segs.length, round: 0 }; swBuild(); renderUI();
  }
  function applySweep() {
    if (!SW || !SW.solid) return;   // (the panel already says why)
    let man; try { man = C.sweep({ frame: profById(SW.profileId).frame, outer: profById(SW.profileId).outer, holes: profById(SW.profileId).holes || [] }, SW.run, { round: SW.round }); } catch (e) { toast(e.message || String(e)); return; }
    const pid = SW.profileId, k = SW.edges;
    step(() => { const b = makeBodyRecord('Sweep', man); S.bodies = [...S.bodies, b]; S.selectedId = b.id; S.profiles = S.profiles.filter(q => q.id !== pid); S.selProfiles = []; S.selPath = null; }, `Sweep along ${k} edge${k === 1 ? '' : 's'}`);
    swDrop(); commit(); toast('Swept');
  }
  function addBody(name, man) { pushUndo(); const b = makeBodyRecord(name, man); S.bodies = [...S.bodies, b]; S.selectedId = b.id; S.selectedFace = null; commit(); return b; }
  function tryGeom(fn) { try { return fn(); } catch (e) { toast((e && e.message) || 'Geometry error'); return null; } }

  // ---------- Active highlight: what a tap would pick, in its own colour (mouse: on hover; finger: while pressed) ----------
  // pre-highlight in its own colour (warm yellow), distinct from the blue bodies and the cyan selection — like Shapr3D's hover
  const HOVER_COL = 0xffc53d, HOVER_REGION = 0xff9a2e; const hoverGroup = new THREE.Group(); hoverGroup.renderOrder = 14; scene.add(hoverGroup);
  let HOV = null, hovKey = null; const outlineCache = new WeakMap();
  /** Boundary segments of one surface of a mesh (its outline), welded by position. */
  function surfaceOutline(md, surf) {
    let per = outlineCache.get(md); if (!per) { per = new Map(); outlineCache.set(md, per); } if (per.has(surf)) return per.get(surf);
    const P = md.positions, I = md.indices, key = k => P[k].toFixed(5) + ',' + P[k + 1].toFixed(5) + ',' + P[k + 2].toFixed(5); const cnt = new Map();
    for (let t = 0; t < I.length / 3; t++) { if (md.surfID[t] !== surf) continue; for (let e = 0; e < 3; e++) { const a = I[t * 3 + e] * 3, b = I[t * 3 + (e + 1) % 3] * 3; const ka = key(a), kb = key(b); const k = ka < kb ? ka + '|' + kb : kb + '|' + ka; const c = cnt.get(k); if (c) c.n++; else cnt.set(k, { n: 1, a, b }); } }
    const segs = []; for (const v of cnt.values()) if (v.n === 1) segs.push([[P[v.a], P[v.a + 1], P[v.a + 2]], [P[v.b], P[v.b + 1], P[v.b + 2]]]); per.set(surf, segs); return segs;
  }
  function hoverTargetAt(x, y) {
    if (TR) return null; const ray = rayAt(x, y);
    if (isSketchTool(S.tool) && S.plane) {
      const cc = circleCentreAt(x, y); if (cc) return { kind: 'centre', c: cc.c.slice() };
      const sg = lineAt(x, y); if (sg) return { kind: 'sketchline', seg: sg };
      raycaster.set(new THREE.Vector3(...ray.o), new THREE.Vector3(...ray.d)); const rm = raycaster.intersectObjects(regionMeshes, false)[0];
      if (rm) return { kind: 'region', index: rm.object.userData.index };
      return null;
    }
    if (S.tool === 'select' || S.tool === 'move') {
      if (S.tool === 'select' && (S.kept || []).length) { const ki = keptAt(x, y); if (ki >= 0) return { kind: 'kept', i: ki };
        const inAct = S.plane && S.sketchLines.length && (() => { raycaster.set(new THREE.Vector3(...ray.o), new THREE.Vector3(...ray.d)); return !!raycaster.intersectObjects(regionMeshes, false)[0] || !!lineAt(x, y); })();
        if (!inAct) { const kr = keptRegionAt(x, y); if (kr) { const hb = pick(ray); if (!hb || kr.d < Math.hypot(hb.point[0] - ray.o[0], hb.point[1] - ray.o[1], hb.point[2] - ray.o[2])) return { kind: 'kept', i: kr.i }; } } }
      // sketch left on the plane (Select): its lines and closed regions light up like faces and edges do
      if (S.tool === 'select' && S.plane && S.sketchLines.length) {
        const sg = lineAt(x, y); if (sg) return { kind: 'sketchline', seg: sg };
        raycaster.set(new THREE.Vector3(...ray.o), new THREE.Vector3(...ray.d)); const rm = raycaster.intersectObjects(regionMeshes, false)[0];
        if (rm) { const hb = pick(ray); const hbD = hb ? Math.hypot(hb.point[0] - ray.o[0], hb.point[1] - ray.o[1], hb.point[2] - ray.o[2]) : Infinity; if (rm.distance < hbD) return { kind: 'region', index: rm.object.userData.index }; }
      }
      const pp = typeof profileUnder === 'function' ? profileUnder(ray) : null; if (pp) return { kind: 'profile', id: pp.id };
      const ps = typeof pathSegAt === 'function' ? pathSegAt(x, y) : null; if (ps) return { kind: 'pathedge', id: ps.id, i: ps.i };
      // as a tap decides: over a face an edge wins only within 8 px (a finger's width off a face's middle stays the face)
      const h = pick(ray); const e = edgeAt(x, y, h ? 8 : 12, h ? h.body : null); if (e) return { kind: 'edge', bodyId: e.body.id, index: e.index };
      if (h && h.triangle != null) return { kind: 'face', bodyId: h.body.id, surf: h.body.md.surfID[h.triangle] };
    }
    return null;
  }
  function clearHover() { if (!HOV && !hoverGroup.children.length) return; HOV = null; hovKey = null; for (const c of [...hoverGroup.children]) { hoverGroup.remove(c); c.traverse(o => { o.geometry && o.geometry.dispose(); }); } requestRender(); }
  function setHover(h) {
    const k = h ? JSON.stringify(h) : null; if (k === hovKey) return; clearHover(); if (!h) return; HOV = h; hovKey = k;
    const lineMat = () => new THREE.LineBasicMaterial({ color: HOVER_COL, depthTest: false, transparent: true, opacity: 0.95 });
    // thick highlight: every segment becomes a thin tube about 3 px wide on screen (WebGL lines are always 1 px)
    const segsObj = (segs, px = 1.6) => {
      const grp = new THREE.Group(); grp.renderOrder = 14; const mat = new THREE.MeshBasicMaterial({ color: HOVER_COL, depthTest: false, transparent: true, opacity: 0.98 });
      const fov = (camera.fov || 50) * Math.PI / 180, vh = Math.max(1, renderer.domElement.clientHeight || innerHeight); const up = new THREE.Vector3(0, 1, 0);
      for (const [a, b] of segs) {
        const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b); const len = A.distanceTo(B); if (len < 1e-9) continue;
        const mid = A.clone().add(B).multiplyScalar(0.5); const wpp = 2 * camera.position.distanceTo(mid) * Math.tan(fov / 2) / vh;
        const m = new THREE.Mesh(new THREE.CylinderGeometry(px * wpp, px * wpp, len, 6, 1, true), mat); m.position.copy(mid);
        m.quaternion.setFromUnitVectors(up, B.clone().sub(A).normalize()); m.renderOrder = 14; grp.add(m);
      }
      return grp;
    };
    if (h.kind === 'face') { const b = S.bodies.find(q => q.id === h.bodyId); if (!b) return; const md = b.md; const P = md.positions, I = md.indices; const pos = [];
      for (let t = 0; t < I.length / 3; t++) if (md.surfID[t] === h.surf) for (let e = 0; e < 3; e++) { const k = I[t * 3 + e] * 3; pos.push(P[k], P[k + 1], P[k + 2]); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const m = new THREE.Mesh(g, frontBias(new THREE.MeshBasicMaterial({ color: HOVER_COL, transparent: true, opacity: 0.36, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }), 2.5e-4)); m.renderOrder = 13; hoverGroup.add(m);
      hoverGroup.add(segsObj(surfaceOutline(md, h.surf))); }
    else if (h.kind === 'edge') { const b = S.bodies.find(q => q.id === h.bodyId); let ch = null; try { ch = C.edgeChains(b.md)[h.index]; } catch (e) { /* none */ } if (!ch) return; const pts = ch.closed ? [...ch.pts, ch.pts[0]] : ch.pts; const segs = []; for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]); hoverGroup.add(segsObj(segs)); }
    else if (h.kind === 'sketchline') hoverGroup.add(segsObj([[to3(h.seg[0], 0.02), to3(h.seg[1], 0.02)]]));
    else if (h.kind === 'kept') { const k = (S.kept || [])[h.i]; if (!k) return; hoverGroup.add(segsObj(k.lines.map(([a, b]) => [C.frameToWorld(k.plane, a[0], a[1], 0.02), C.frameToWorld(k.plane, b[0], b[1], 0.02)]))); }
    else if (h.kind === 'region') { const r = regionCache[h.index]; if (!r) return; const shape = new THREE.Shape(r.outer.map(p => new THREE.Vector2(p[0], p[1]))); for (const hh of r.holes || []) shape.holes.push(new THREE.Path(hh.map(p => new THREE.Vector2(p[0], p[1]))));
      const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: HOVER_REGION, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false })); const f = plane(); m.quaternion.copy(basisQuat(f)); m.position.set(f.origin[0] + f.n[0] * 0.015, f.origin[1] + f.n[1] * 0.015, f.origin[2] + f.n[2] * 0.015); m.renderOrder = 13; hoverGroup.add(m); }
    else if (h.kind === 'centre') { const o = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...to3(h.c, 0.03))]), new THREE.PointsMaterial({ color: HOVER_COL, size: 16, sizeAttenuation: false, depthTest: false })); o.renderOrder = 14; hoverGroup.add(o); }
    else if (h.kind === 'profile') { const q = profById(h.id); if (!q) return; const segs = []; for (const L of [q.outer, ...(q.holes || [])]) for (let i = 0; i < L.length; i++) segs.push([C.frameToWorld(q.frame, L[i][0], L[i][1], 0), C.frameToWorld(q.frame, L[(i + 1) % L.length][0], L[(i + 1) % L.length][1], 0)]); hoverGroup.add(segsObj(segs)); }
    else if (h.kind === 'pathedge') { const q = pathById(h.id); if (!q) return; const W = pathW(q); hoverGroup.add(segsObj([[W[h.i], W[(h.i + 1) % W.length]]])); }
    requestRender();
  }
  { let hq = null, touchDown = null;
    canvas.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') { if (touchDown && Math.hypot(e.clientX - touchDown.x, e.clientY - touchDown.y) > 8) { clearHover(); touchDown = null; } if (TR && touchDown) trMove(e.clientX, e.clientY); return; }
      if (e.buttons) { clearHover(); return; } if (TR) { trMove(e.clientX, e.clientY); return; }
      if (hq) return; hq = requestAnimationFrame(() => { hq = null; try { setHover(hoverTargetAt(e.clientX, e.clientY)); } catch (err) { clearHover(); } }); });
    let pressTimer = null;
    canvas.addEventListener('pointerdown', e => { if (e.pointerType !== 'touch' || window.__noHover) return; const x = e.clientX, y = e.clientY; touchDown = { x, y };
      // shown only once the finger has rested a moment: a quick tap or the start of a gesture does no picking work here
      clearTimeout(pressTimer); pressTimer = setTimeout(() => { pressTimer = null; if (!touchDown || Math.hypot(touchDown.x - x, touchDown.y - y) > 8) return; if (TR) { trMove(x, y); return; } try { setHover(hoverTargetAt(x, y)); } catch (err) { clearHover(); } }, 150); });
    const up = e => { if (e.pointerType === 'touch') { touchDown = null; clearTimeout(pressTimer); pressTimer = null; clearHover(); } };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up); canvas.addEventListener('pointerleave', () => clearHover()); }
  // ---------- Translate, point to point: a start point on the body, an end point anywhere; Done moves it exactly ----------
  let TR = null; const trGroup = new THREE.Group(); trGroup.renderOrder = 15; scene.add(trGroup);
  const trLen = document.createElement('div'); trLen.className = 'fil-pill tr-len'; trLen.hidden = true; document.body.appendChild(trLen);
  function trPoints(phase) {
    const b = S.bodies.find(q => q.id === TR.bodyId); const pts = [];
    const add = (w, what) => pts.push({ w, what });
    if (phase === 'start') { if (b) for (const w of C.scaleSnapPoints(b.md)) add(w.p || w, 'point'); return pts; }
    for (const o of S.bodies) for (const w of C.scaleSnapPoints(o.md)) add(w.p || w, 'point');
    for (const q of S.profiles || []) add(profCentre(q), 'profile centre');
    for (const q of S.paths || []) for (const w of pathW(q)) add(w, 'path point');
    for (const [a, c] of sketchSegments()) { add(to3(a), 'sketch point'); add(to3(c), 'sketch point'); }
    add([0, 0, 0], 'origin'); return pts;
  }
  /** The point a tap at (x, y) picks: the nearest snap point within 24 px, else the surface under the finger. */
  function trPickAt(x, y, phase) {
    let best = null; for (const q of trPoints(phase)) { const s2 = project(q.w); if (!s2.ok) continue; const d = Math.hypot(s2.x - x, s2.y - y); if (d < 24 && (!best || d < best.d)) best = { d, w: q.w.slice(), snapped: true }; }
    if (best) return best; const h = pick(rayAt(x, y)); if (!h) return null; if (phase === 'start' && h.body.id !== TR.bodyId) return null; return { w: h.point.slice(), snapped: false };
  }
  function trDraw() {
    for (const c of [...trGroup.children]) { trGroup.remove(c); c.geometry && c.geometry.dispose(); } trLen.hidden = true; if (!TR) { requestRender(); return; }
    const dot = (w, col, size) => { const o = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...w)]), new THREE.PointsMaterial({ color: col, size, sizeAttenuation: false, depthTest: false })); o.renderOrder = 16; trGroup.add(o); };
    if (TR.start) dot(TR.start, 0x2fd26a, 14);
    const to = TR.end || TR.cand; TR.lineShown = false;
    if (TR.start && to) { dot(to, TR.end ? 0x2fd26a : HOVER_COL, 12);
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...TR.start), new THREE.Vector3(...to)]); const l = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xe8ebf0, dashSize: 6 * worldPerPx(TR.start), gapSize: 4 * worldPerPx(TR.start), depthTest: false })); l.computeLineDistances(); l.renderOrder = 15; trGroup.add(l); TR.lineShown = true;
      const d = Math.hypot(to[0] - TR.start[0], to[1] - TR.start[1], to[2] - TR.start[2]); const m = project([(to[0] + TR.start[0]) / 2, (to[1] + TR.start[1]) / 2, (to[2] + TR.start[2]) / 2]);
      if (m.ok) { trLen.hidden = false; trLen.textContent = `${Math.round(d * 1000) / 1000} mm`; trLen.style.left = m.x + 'px'; trLen.style.top = m.y + 'px'; trLen.style.transform = 'translate(-50%, -50%)'; } }
    if (TR.end) { const b = S.bodies.find(q => q.id === TR.bodyId); if (b) { const dv = [TR.end[0] - TR.start[0], TR.end[1] - TR.start[1], TR.end[2] - TR.start[2]]; const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(b.md.positions, 3)); g.setIndex(new THREE.BufferAttribute(b.md.indices, 1));
      const ghost = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x38bdf0, transparent: true, opacity: 0.25, depthWrite: false })); ghost.position.set(...dv); ghost.renderOrder = 12; trGroup.add(ghost); } }
    requestRender();
  }
  function startTranslate(b) { if (!b) return; if (MV) endMove(); filHover = null; TR = { bodyId: b.id, start: null, end: null, cand: null, copy: false }; clearHover(); trDraw(); renderUI(); }
  function trMove(x, y) { if (!TR || !TR.start || TR.end) return; const q = trPickAt(x, y, 'end'); TR.cand = q ? q.w : null; trDraw(); }
  function trTap(x, y) {
    if (!TR) return false; if (TR.end) return true;
    const q = trPickAt(x, y, TR.start ? 'end' : 'start'); if (!q) { toast(TR.start ? 'Tap a point to move to' : 'Tap a point on the selected body'); return true; }
    if (!TR.start) TR.start = q.w; else { TR.end = q.w; TR.cand = null; } trDraw(); renderUI(); return true;
  }
  function trDone() {
    if (!TR || !TR.start || !TR.end) return; const b = S.bodies.find(q => q.id === TR.bodyId); if (!b) { trCancel(); return; }
    const dv = [TR.end[0] - TR.start[0], TR.end[1] - TR.start[1], TR.end[2] - TR.start[2]]; const man = b.man.translate(dv); const copy = TR.copy;
    step(() => { if (copy) { const nb = makeBodyRecord(b.name + ' copy', man); S.bodies = [...S.bodies, nb]; S.selectedId = nb.id; } else { const md = C.meshData(man); S.bodies = S.bodies.map(q => q.id === b.id ? { ...q, man, md } : q); } }, `Translate ${b.name}${copy ? ' (copy)' : ''}`);
    TR = null; trDraw(); commit(); toast(`Moved by ${Math.round(Math.hypot(...dv) * 1000) / 1000} mm`);
  }
  function trCancel() { TR = null; trDraw(); renderUI(); }
  function trPanel() {
    panelEl.replaceChildren(); panelEl.hidden = false; const b = S.bodies.find(q => q.id === TR.bodyId);
    const top = el('div', 'row scroll'); const d = TR.start && TR.end ? Math.round(Math.hypot(TR.end[0] - TR.start[0], TR.end[1] - TR.start[1], TR.end[2] - TR.start[2]) * 1000) / 1000 : null;
    top.append(el('span', 'fil-status', `Translate${b ? ' ' + b.name : ''}${d != null ? ` · ${d} mm` : ''}`)); panelEl.append(top);
    panelEl.append(el('div', 'note', !TR.start ? 'Tap the start point on the body: corners, edge middles and face centres snap.' : !TR.end ? 'Tap the end point: a corner, edge middle or face centre of any body (or a sketch, path or profile point).' : 'Done moves the body so the start point sits exactly on the end point.'));
    const act = el('div', 'row scroll'); if (TR.end) act.append(chip('Done', trDone, true)); act.append(chip('Copy', () => { TR.copy = !TR.copy; renderUI(); }, TR.copy), chip('Cancel', trCancel)); panelEl.append(act);
  }
  function onTap(x, y) {
    { let r = false; try { r = xtTap(x, y); } catch (e) { console.warn(e); r = false; } if (r) return; }
    if (TR) { trTap(x, y); return; }
    // Scale (uniform or non-uniform): a tap on empty space — no body, no scale handle under it — keeps the scale and leaves the
    // operation, the same as Apply (nothing scaled yet: it just closes)
    if (SCF) { const ray0 = rayAt(x, y); const onHandle = (typeof hitHoleScale === 'function' && hitHoleScale(x, y)) || (typeof hitGizmo === 'function' && hitGizmo(x, y));
      if (!pick(ray0) && !onHandle) { const changed = [SCF.sx, SCF.sy, SCF.sz == null ? 1 : SCF.sz].some(v => v != null && Math.abs(v - 1) > 1e-9); if (changed) scApply(); else scCancel(); renderUI(); requestRender(); return; } }
    // right after an extrusion (live arrows still showing): a tap on empty space keeps the result and leaves the command too
    if (SESSION && isSketchTool(S.tool) && S.tool !== 'edit') { const ray0 = rayAt(x, y); if (!pick(ray0) && !(typeof hitGizmo === 'function' && hitGizmo(x, y))) { const cutT = SESSION.cutThrough; endSession(); setTool('select'); S.selRegion = -1; syncScene(); renderUI(); toast(cutT ? 'Done · the sketch was pushed through the body and cut it' : 'Done · the new body is kept'); return; } }
    // a finished shape with its extrude arrows: a tap on empty space (not the shape, not a body) leaves the command, like Shapr3D —
    // the arrows go, the shape turns back to blue and stays on the plane, ready to be tapped again
    if (!SESSION && S.plane && ((['rect', 'circle', 'polygon', 'polyline'].includes(S.tool) && S.sketchClosed && S.sketch.length >= 3) || (S.tool === 'line' && !S.lineStart && S.selRegion >= 0))) {
      const ray0 = rayAt(x, y); const q = C.planeHit2D(plane(), ray0.o, ray0.d);
      const onShape = q && ((S.sketchClosed && S.sketch.length >= 3 && pip(q, S.sketch)) || (() => { raycaster.set(new THREE.Vector3(...ray0.o), new THREE.Vector3(...ray0.d)); return !!raycaster.intersectObjects(regionMeshes, false)[0]; })() || lineAt(x, y));
      if (!onShape && !pick(ray0) && !(typeof hitGizmo === 'function' && hitGizmo(x, y))) { setTool('select'); S.selRegion = -1; syncScene(); renderUI(); toast('Out of the command · tap the shape again to extrude or revolve it'); return; }
    }
    if (S.selCentre) { S.selCentre = null; syncScene(); }   // a tap elsewhere lets go of a selected circle centre
    const ray = rayAt(x, y);
    if (S.tool === 'move') {
      if (MV) endMove();
      S.moveCircle = null;
      if (S.plane || (S.kept || []).length) { let cs = []; try { cs = S.plane ? circlesIn(allSketchSegs()) : []; } catch (e) { cs = []; } const p2 = S.plane ? C.planeHit2D(plane(), ray.o, ray.d) : null; let best = null;
        for (const cc of cs) { const P = project(to3(cc.c)); const dc = P.ok ? Math.hypot(P.x - x, P.y - y) : Infinity; const inside = p2 && Math.hypot(p2[0] - cc.c[0], p2[1] - cc.c[1]) <= cc.r; if ((dc < 26 || inside) && (!best || cc.r < best.r)) best = cc; }
        if (!best) (S.kept || []).forEach((k, ki) => { if (best) return; let kc = []; try { kc = circlesIn(k.lines); } catch (e) { kc = []; } const q2 = C.planeHit2D(k.plane, ray.o, ray.d);   // a circle of a closed sketch: open that sketch again
          for (const cc of kc) { const P = project(C.frameToWorld(k.plane, cc.c[0], cc.c[1], 0)); const dc = P.ok ? Math.hypot(P.x - x, P.y - y) : Infinity; const inside = q2 && Math.hypot(q2[0] - cc.c[0], q2[1] - cc.c[1]) <= cc.r; if (dc < 26 || inside) { activateKept(ki); best = cc; return; } } });
        if (best) { S.moveCircle = [best.c[0], best.c[1]]; S.selectedId = null; S.moveSurf = null; S.selectedFace = null; S.selProfiles = []; toast('Circle selected — the gizmo moves it'); commitLight(); return; } }
      if (S.plane && (pick(ray) || profileUnder(ray))) { archiveSketch(); S.sketchLines = []; S.plane = null; S.lineStart = null; S.lastLine = -1; S.selRegion = -1; }   // picking something else leaves the sketch (it stays on screen)
      { const pp = profileUnder(ray); if (pp) { S.selProfiles = [pp.id]; S.selectedId = null; S.moveSurf = null; S.selectedFace = null; S.moveGizmo = null; commitLight(); return; } }
      const hit = pick(ray);
      if (!hit) { S.selectedId = null; S.moveSurf = null; S.selectedFace = null; S.selProfiles = [];
        if (S.plane) { step(() => { archiveSketch(); S.sketchLines = []; S.plane = null; S.lineStart = null; S.lastLine = -1; S.selRegion = -1; S.moveCircle = null; syncScene(); }, 'Close sketch'); toast('Out of the sketch · tap a shape to extrude or revolve it'); }
        if (typeof setTool === 'function') { setTool('select'); renderUI && renderUI(); }
        commitLight(); return; }
      S.selProfiles = [];
      if (hit.body.id === S.selectedId) { const surf = C.surfOfFace(hit.body.md, hit.faceId); S.moveSurf = (S.moveSurf === surf) ? null : surf; toast(S.moveSurf == null ? 'Whole body selected' : 'Face selected — the gizmo now moves just this face'); }
      else { S.selectedId = hit.body.id; S.moveSurf = null; }
      S.selectedFace = null; S.faceTool = false; commitLight(); return;
    }
    if (S.tool === 'select') {
      if (SESSION) endSession();   // a tap anywhere finishes a live push/pull (its result is already in place)
      if (S.pendingBool) {
        const hit = pick(ray);
        if (hit && hit.body.id !== S.selectedId) applyBoolean(hit.body); else if (!hit) { S.pendingBool = null; renderUI(); }
        return;
      }
      if (scActive()) { const h0 = pick(ray); if (h0 && h0.body.id === SC.bodyId) return; scDrop(); }
      if (LF || SW) return;   // while a loft or sweep is being set up, taps do not change what it is made of
      { const pp = profileUnder(ray); if (pp) { if (FL) commitFil(false); const i = S.selProfiles.indexOf(pp.id); S.selProfiles = i >= 0 ? S.selProfiles.filter(id => id !== pp.id) : [...S.selProfiles, pp.id]; S.selectedId = null; S.selectedFace = null; S.faceTool = false; commitLight(); return; } }
      { const ps = pathSegAt(x, y); if (ps) { if (FL) commitFil(false); const sp = S.selPath && S.selPath.id === ps.id ? S.selPath : null;
          if (!sp) S.selPath = { id: ps.id, segs: [ps.i] }; else if (sp.segs.includes(ps.i)) { const rest = sp.segs.filter(i => i !== ps.i); S.selPath = rest.length ? { id: ps.id, segs: rest } : null; } else S.selPath = { id: ps.id, segs: [...sp.segs, ps.i] };
          S.selectedId = null; S.selectedFace = null; S.faceTool = false; commitLight(); return; } }
      // sketch left on the plane: a tap inside a closed region selects it (orange); with a region selected, a tap on a line revolves around it
      // a body in front of the sketch wins: the sketch lies on its plane, so compare the body hit with where the ray meets that plane
      const bodyFirst = (() => { const hb = pick(ray); if (!hb) return false; const hbD = Math.hypot(hb.point[0] - ray.o[0], hb.point[1] - ray.o[1], hb.point[2] - ray.o[2]);
        const planeD = f => { const n = f.n, den = n[0] * ray.d[0] + n[1] * ray.d[1] + n[2] * ray.d[2]; if (Math.abs(den) < 1e-9) return Infinity; const t = (n[0] * (f.origin[0] - ray.o[0]) + n[1] * (f.origin[1] - ray.o[1]) + n[2] * (f.origin[2] - ray.o[2])) / den; return t > 0 ? t : Infinity; };
        const ds = [S.plane && S.sketchLines.length ? planeD(S.plane) : Infinity, ...(S.kept || []).map(k => planeD(k.plane))]; return hbD < Math.min(...ds) - 1e-3; })();
      if (!bodyFirst && (S.kept || []).length && !FL && !RV && !OF && !(S.plane && S.sketchLines.length && lineAt(x, y))) {
        const ki = keptAt(x, y); if (ki >= 0) { activateKept(ki); return; }
        // a tap inside a kept sketch's shape brings that sketch back and selects the shape, as if it were the active one
        const inActive = (() => { if (!S.plane || !S.sketchLines.length) return false; raycaster.set(new THREE.Vector3(...ray.o), new THREE.Vector3(...ray.d)); return !!raycaster.intersectObjects(regionMeshes, false)[0]; })();
        const kr = !inActive && keptRegionAt(x, y); const hb0 = kr && pick(ray);
        if (kr && (!hb0 || kr.d < Math.hypot(hb0.point[0] - ray.o[0], hb0.point[1] - ray.o[1], hb0.point[2] - ray.o[2]))) {
          activateKept(kr.i); const idx = regionCache.findIndex(r => pip(kr.pt, r.outer)); if (idx >= 0) { S.selRegion = idx; syncScene(); renderUI(); } return; }
      }
      if (!bodyFirst && S.plane && S.sketchLines.length && !FL && !RV && !OF) {
        const Lr = lineAt(x, y);
        if (Lr && S.selRegion >= 0 && regionCache[S.selRegion]) { const same = RVLINE && RVLINE.every((p, i) => Math.hypot(p[0] - Lr[i][0], p[1] - Lr[i][1]) < 1e-9); RVLINE = same ? null : [Lr[0].slice(), Lr[1].slice()]; rvLineSync(); renderUI(); return; }   // region + line selected: Revolve waits for the user
        raycaster.set(new THREE.Vector3(...ray.o), new THREE.Vector3(...ray.d)); const rm = raycaster.intersectObjects(regionMeshes, false)[0];
        const hb = pick(ray); const hbD = hb ? Math.hypot(hb.point[0] - ray.o[0], hb.point[1] - ray.o[1], hb.point[2] - ray.o[2]) : Infinity;
        if (rm && rm.distance < hbD) { const idx = rm.object.userData.index; S.selRegion = S.selRegion === idx ? -1 : idx; RVLINE = null; rvLineSync(); S.selectedId = null; S.selectedFace = null; S.faceTool = false; S.selProfiles = []; S.selPath = null; syncScene(); renderUI(); return; }
        if (Lr && !hb) { toast('Tap inside the closed shape first, then this line to revolve around it'); return; }
      }
      if (RV) return;   // while a revolve is being set up, taps do not change the selection
      if (OF) { const h = pick(ray); if (h && h.body && h.body.id === OF.id && h.faceId != null) { const i = OF.faces.indexOf(h.faceId); if (i >= 0) { if (OF.faces.length > 1) OF.faces.splice(i, 1); } else OF.faces.push(h.faceId); ofPreview(); renderUI(); } return; }
      // edges first: a tap on (or next to) a drawn edge starts Chamfer/Fillet; while it runs, faces add their edges
      if (C.filletEdges && filTap(x, y)) return;
      const hit = pick(ray);
      if (!hit) { S.selectedId = null; S.selectedFace = null; S.faceTool = false; S.scaleTool = false; S.selProfiles = []; S.selPath = null; S.selRegion = -1; RVLINE = null; rvLineSync(); commitLight(); return; }
      S.selProfiles = []; S.selPath = null;
      if (hit.body.id === S.selectedId && C.booleans) { S.selectedFace = hit.faceId; S.faceTool = C.isPlanarFace(hit.body.md, hit.faceId); S.value = 1; if (!S.faceTool) toast('Curved face — push/pull works on flat faces. Move/Rotate can move or turn it.'); }
      else if (hit.body.id === S.selectedId) { toast('Push/pull needs the geometry engine, which this browser blocked'); }
      else { S.selectedId = hit.body.id; S.scaleTool = false; if (C.booleans && hit.faceId != null) { S.selectedFace = hit.faceId; S.faceTool = C.isPlanarFace(hit.body.md, hit.faceId); S.value = 1; } else { S.selectedFace = null; S.faceTool = false; } }   // Shapr3D: one tap picks the face; a double tap picks the whole body
      commitLight(); return;
    }
    if (SESSION) { endSession(); if (!isSketchTool(S.tool)) return; }
    if (S.tool === 'edit' && S.plane) {
      const sg = lineAt(x, y); if (sg) { S.selSeg = sg; S.selRegion = -1; S.selHole = null; S.selVertex = null; syncScene(); return; }
      S.selSeg = null; S.selHole = null;
      { const q = C.planeHit2D(plane(), ray.o, ray.d); const hh = q && holeAt(q); if (hh) { S.selHole = hh; S.selRegion = -1; S.selVertex = null; syncScene(); return; } }
      const rm = raycaster.intersectObjects(regionMeshes, false)[0];
      if (rm) { S.selRegion = rm.object.userData.index; S.selVertex = null; syncScene(); return; }
      const hit = pick(ray);
      if (hit && hit.faceId != null && !(onFace() && S.plane.bodyId === hit.body.id && S.plane.faceId === hit.faceId)) { setSketchPlane(hit); return; }
      if (!hit && !(typeof hitGizmo === 'function' && hitGizmo(x, y))) {   // Edit sketch: a tap in empty space (no line, region, hole or body) leaves the sketch and returns to Select
        step(() => { archiveSketch(); S.sketchLines = []; S.plane = null; S.lineStart = null; S.lastLine = -1; S.selRegion = -1; S.selVertex = null; S.selSeg = null; S.selHole = null; S.moveCircle = null; S.sketch = []; S.sketchClosed = false; S.circle = null; syncScene(); }, 'Close sketch');
        setTool('select'); renderUI(); toast('Out of the sketch'); return; }
      S.selRegion = -1; S.selVertex = null; syncScene(); return;
    }
    if (isSketchTool(S.tool) && !S.sketch.length && !S.sketchClosed && !S.lineStart) {
      const hit = pick(ray);
      if (hit && hit.faceId != null && !(onFace() && S.plane.bodyId === hit.body.id && S.plane.faceId === hit.faceId)) {
        const onCurrentPlane = S.plane && Math.abs((hit.point[0] - S.plane.origin[0]) * S.plane.n[0] + (hit.point[1] - S.plane.origin[1]) * S.plane.n[1] + (hit.point[2] - S.plane.origin[2]) * S.plane.n[2]) < 16 * worldPerPx();
        if (!onCurrentPlane && !S.plane) { setSketchPlane(hit); return; }   // once a plane is chosen, taps draw on it even over a body (to sketch on a face: Change plane, then tap it — or a face's Sketch button)
      }
      if (!S.plane && !hit) {
        const card = raycaster.intersectObjects(pickerCards, false)[0];
        if (card) setPrincipalPlane(card.object.userData.key); else toast('Choose a sketch plane first: tap Top, Front or Side at the origin, or a body face');
        return;
      }
      if (S.imported) return; // import preview is showing: taps only choose the plane
    }
    if (isSketchTool(S.tool) && !S.plane) { toast('Choose a sketch plane first'); return; }
    // sketching on a body's face: a tap in empty space (off every body, with nothing half-drawn) leaves the sketch and goes back
    // to Select — no trip to the Select button needed; lines already drawn stay on screen as a kept sketch
    if (isSketchTool(S.tool) && S.plane && S.plane.bodyId != null && S.tool !== 'edit' && !S.drawing && !S.lineStart && !(S.circle && S.circle.c) && !(S.sketch && S.sketch.length && !S.sketchClosed) && !pick(ray) && !(typeof hitGizmo === 'function' && hitGizmo(x, y))) {
      step(() => { archiveSketch(); S.sketchLines = []; S.plane = null; S.lineStart = null; S.lastLine = -1; S.selRegion = -1; S.moveCircle = null; S.sketch = []; S.sketchClosed = false; S.circle = null; syncScene(); }, 'Close sketch');
      setTool('select'); renderUI(); toast('Out of the sketch'); return; }
    const p = isSketchTool(S.tool) ? C.planeHit2D(plane(), ray.o, ray.d) : planeHit(ray); if (!p) return;
    const sp = isSketchTool(S.tool) ? snapPoint(p) : snap(p);
    if (isSketchTool(S.tool)) showSnapTip(sp, S.lastSnap, 1400);
    if (S.tool === 'line') { lineTap(sp); return; }
    if (S.tool === 'box') { if (!(X.on && X.oc && xTool('box', sp[0], sp[1]))) { const m = tryGeom(() => C.box(4, 4, 4, sp[0], sp[1])); if (m) addBody('Box', m); } }
    else if (S.tool === 'cylinder') { if (!(X.on && X.oc && xTool('cylinder', sp[0], sp[1]))) { const m = tryGeom(() => C.cylinder(2, 4, sp[0], sp[1])); if (m) addBody('Cylinder', m); } }
    else if (S.tool === 'sphere') { const m = tryGeom(() => C.sphere(2, sp[0], sp[1])); if (m) addBody('Sphere', m); }
    else sketchTap(sp);
  }
  function commitLight() { syncScene(); }

  function sketchTap(p) {
    if (S.sketchClosed) return;
    step(() => {
    if (S.tool === 'polyline') {
      if (S.sketch.length >= 3 && Math.hypot(p[0] - S.sketch[0][0], p[1] - S.sketch[0][1]) < 0.6) S.sketchClosed = true;
      else if (!S.sketch.length || S.sketch[S.sketch.length - 1][0] !== p[0] || S.sketch[S.sketch.length - 1][1] !== p[1]) S.sketch.push(p);
    } else if (S.tool === 'rect') {
      if (!S.sketch.length) S.sketch = [p];
      else { const a = S.sketch[0]; if (a[0] !== p[0] && a[1] !== p[1]) { S.sketch = [a, [p[0], a[1]], p, [a[0], p[1]]]; S.sketchClosed = true; } }
    } else if (S.tool === 'polygon') {
      if (!S.sketch.length) S.sketch = [p];
      else { const c = S.sketch[0]; if (Math.hypot(p[0] - c[0], p[1] - c[1]) > 1e-3) { S.polygon = polySnapRot(polyFrom(c, p)); S.sketch = polyPts(S.polygon); S.sketchClosed = true; } }
    } else if (S.tool === 'circle') {
      if (!S.sketch.length) S.sketch = [p];
      else { const c = S.sketch[0], r = Math.hypot(p[0] - c[0], p[1] - c[1]); if (r > 1e-3) { S.circle = { c: [c[0], c[1]], r }; S.sketch = Array.from({ length: CIRCLE_SEG }, (_, i) => { const t = 2 * Math.PI * i / CIRCLE_SEG; return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]; }); S.sketchClosed = true; } }
    }
    syncScene();
    });
  }
  /** mode: 'new' (separate body), 'join' (union with the face's body), 'cut' (subtract from it). */
  function extrudeSketch(mode = 'new') { step(() => extrudeSketchInner(mode)); }
  function extrudeSketchInner(mode) {
    const h = Math.max(0.01, Math.abs(S.height)), eps = BOOL_EPS;
    const host = onFace() ? S.bodies.find(b => b.id === S.plane.bodyId) : null;
    if (!onFace()) { const m = tryGeom(() => C.placeInFrame(S.flip === 'both' ? C.extrude(S.sketch, h).translate([0, 0, -h / 2]) : S.flip ? C.extrude(S.sketch, h).translate([0, 0, -h]) : C.extrude(S.sketch, h), plane())); if (!m) return; addBody('Extrusion', m); clearSketch(); return; }
    if ((mode === 'join' || mode === 'cut') && (!host || !C.booleans)) mode = 'new';
    const local = tryGeom(() => {
      if (mode === 'cut') return C.extrude(S.sketch, h + eps + skinReach(host.man, len => [C.extrude(S.sketch, len)], plane(), 1)).translate([0, 0, -h]);   // + reach through a hair-thin lid over the pocket
      if (mode === 'join') return C.extrude(S.sketch, h + eps).translate([0, 0, -eps]);
      return C.extrude(S.sketch, h);
    });
    if (!local) return;
    const solid = tryGeom(() => C.placeInFrame(local, plane())); if (!solid) return;
    if (mode === 'new') { addBody('Extrusion', solid); clearSketch(); return; }
    const result = tryGeom(() => C.fuse(host.man, solid, mode)); if (!result) return;
    if (result.volume() < 1e-9) { toast('Cut removed the whole body — try a smaller depth'); return; }
    if (replaceBody(host, result)) { toast(mode === 'cut' ? 'Cut into ' + host.name : 'Added to ' + host.name); clearSketch(); }
  }
  /** Revolve turns the sketch about the plane's vertical axis (its v direction through the plane origin), in the plane
   * itself — like Shapr3D: a half-profile drawn on the Front plane becomes a turned part standing on the grid. */
  /** After Extrude / Add / Cut / New body from the panel, once the sketch is consumed the command ends and Select is back (Shapr3D-style). */
  const doneToSelect = fn => () => { fn(); if (!S.sketchClosed && !S.sketch.length && !lineRegions().length && !SESSION) setTool('select'); };
  /** Extrude direction chip: front → back → both (symmetric, Shapr3D-style: half the distance each side of the plane). */
  function dirChip() { return chip(S.flip === 'both' ? 'Direction: both' : S.flip ? 'Direction: back' : 'Direction: front', () => { S.flip = S.flip === 'both' ? false : S.flip ? 'both' : true; renderUI(); requestRender(); }); }
  // ---------- Parametric History (Shapr3D History › Edit, kettle video 8:00 and 9:30) ----------
  // Each editable step is kept as a feature { kind, name, body, p (its settings + references), pre (bodies before), post (bodies after) }.
  // Editing one replays it and every later feature from its own settings; faces and edges are found again by position.
  function pushFeat(f) { f.post = S.bodies; S.feats = [...(S.feats || []), f]; renderHistory(); }
  function mapBody(bs, id, fn) { const b = bs.find(x => x.id === id); if (!b) throw new Error('A body this step used is gone'); const m = fn(b); return bs.map(x => x.id === id ? { ...x, man: m, md: C.meshData(m) } : x); }
  function findFace(b, ref) {   // the flat face of b with this normal nearest to this point
    let best = null, bd = Infinity; const n = (b.md.surfs || []).length || 400;
    for (let id = 0; id < n + 50; id++) { let f; try { f = C.faceFrame(b.md, id); } catch (e) { f = null; } if (!f || !f.n) continue;
      if (f.n[0] * ref.n[0] + f.n[1] * ref.n[1] + f.n[2] * ref.n[2] < 0.999) continue; const d = Math.abs(ref.n[0] * (f.origin[0] - ref.p[0]) + ref.n[1] * (f.origin[1] - ref.p[1]) + ref.n[2] * (f.origin[2] - ref.p[2])); if (d < bd) { bd = d; best = f; } }
    if (!best) throw new Error('A face this step used is gone'); return best;
  }
  function findEdges(b, refs) {   // the edge chains nearest to the remembered ones (by centre, then by length)
    const chains = C.edgeChains(b.md); const out = [];
    const cen = ch => { const P = ch.pts; let x = 0, y = 0, z = 0; for (const p of P) { x += p[0]; y += p[1]; z += p[2]; } return [x / P.length, y / P.length, z / P.length]; };
    for (const r of refs) { let best = null, bd = Infinity; for (const ch of chains) { const c = cen(ch); const d = Math.hypot(c[0] - r.c[0], c[1] - r.c[1], c[2] - r.c[2]) + 0.25 * Math.abs((ch.length || 0) - (r.len || 0)); if (d < bd) { bd = d; best = ch; } }
      if (best && !out.includes(best)) out.push(best); }
    if (!out.length) throw new Error('The edges this step used are gone'); return out;
  }
  const FEAT = {
    shell: (bs, f) => mapBody(bs, f.body, b => { const face = findFace(b, f.p.open); return C.shell(b.man, f.p.t, { n: face.n, p: face.origin }); }),   // the open face is found again (it may have moved)
    offsetFace: (bs, f) => mapBody(bs, f.body, b => offsetFacesSolid(b, f.p.faces.map(r => findFace(b, r)), f.p.d)),
    fillet: (bs, f) => mapBody(bs, f.body, b => { const r = C.filletEdges(b.man, b.md, findEdges(b, f.p.edges), { ...f.p.opts, live: false }); if (!r || !r.solid) throw new Error('The fillet no longer fits'); return r.solid; }),
    material: (bs, f) => applyMaterial(bs, f.body, f.p.key),
    xf: (bs, f) => { const b = bs.find(x => x.id === f.body); if (!b) throw new Error('A body this step used is gone'); const res = xfSolidsFor(b.man, f.p); const ids = f.p.outIds || [];
      if (f.p.kind === 'rotate') return mapBody(bs, f.body, () => res[0]);
      if (f.p.kind === 'pattern') { const keep = bs.filter(x => !ids.includes(x.id)); return [...keep, ...res.map((m, k) => ({ ...makeBodyRecord(b.name + ' copy', m), id: ids[k] != null ? ids[k] : S.nextId++ }))]; }
      const keep = bs.filter(x => x.id !== b.id); return [...keep, ...res.map((m, k) => ({ ...makeBodyRecord(b.name, m), id: ids[k] != null ? ids[k] : S.nextId++ }))]; },
  };
  /** A feature can be edited when nothing that is not replayable happened after it. */
  const sameBodies = (a, b) => a === b || (a && b && a.length === b.length && a.every(x => { const y = b.find(z => z.id === x.id); return y && y.man === x.man && (y.material || '') === (x.material || ''); }));
  function featEditable(i) { const F = S.feats || []; if (!F[i]) return false; for (let j = i + 1; j < F.length; j++) if (!sameBodies(F[j].pre, F[j - 1].post)) return false; return sameBodies(F[F.length - 1].post, S.bodies); }
  function featSummary(f) { const p = f.p || {}; if (f.kind === 'shell') return `wall ${+p.t.toFixed(2)}`; if (f.kind === 'offsetFace') return `${p.faces.length} face${p.faces.length > 1 ? 's' : ''} · ${+p.d.toFixed(2)}`;
    if (f.kind === 'fillet') return `${p.edges ? p.edges.length : 0} edge${p.edges && p.edges.length === 1 ? '' : 's'} · ${+(p.opts ? p.opts.r : 0).toFixed(2)}`; if (f.kind === 'material') return p.key ? MATS[p.key].name : 'Default';
    if (f.kind === 'xf') return p.kind === 'pattern' ? `${p.count} × ${+p.gap.toFixed(2)}` : p.kind === 'rotate' ? `${+p.angle.toFixed(0)}°` : `at ${Math.round(p.at * 100)}%`; return ''; }
  let FE = null;   // { i, p }  — the feature being edited and its new settings
  function openFeat(i) { if (!featEditable(i)) { toast('A later step cannot be replayed yet (sketch, extrude, boolean…) — edit the steps after it first'); return; } const f = S.feats[i]; FE = { i, p: JSON.parse(JSON.stringify(f.p)) }; histSheet.hidden = true; S.selectedId = null; S.selectedFace = null; S.faceTool = false; syncScene(); renderUI(); }
  function feRebuild() { return named('Edit ' + S.feats[FE.i].name, () => {
    const F = S.feats.map(f => ({ ...f })); F[FE.i].p = FE.p; let bs = F[FE.i].pre;
    try { for (let j = FE.i; j < F.length; j++) { F[j].pre = bs; bs = FEAT[F[j].kind](bs, F[j]); F[j].post = bs; } }
    catch (e) { toast((e && e.message) || 'That change does not rebuild'); return; }
    pushUndo(); S.bodies = bs; S.feats = F; FE = null; commit(); toast(F.length - 1 > 0 ? 'Rebuilt from that step' : 'Step updated'); renderUI(); }); }
  const featBox = document.createElement('div'); featBox.className = 'feat-box';
  { const st = document.createElement('style'); st.textContent = '.feat-box{padding:6px 12px 8px;border-bottom:1px solid rgba(127,127,127,.25)}.feat-box h4{margin:4px 0 6px;font:600 13px system-ui}.feat-row{display:flex;justify-content:space-between;gap:8px;padding:8px 10px;margin:4px 0;border-radius:10px;background:rgba(47,111,237,.10);cursor:pointer;font:14px system-ui}.feat-row.locked{opacity:.45}.feat-row b{font-weight:600}'; document.head.appendChild(st); }
  function renderFeats() { const list = document.getElementById('hist-list'); if (!list) return; if (featBox.parentNode !== list.parentNode) list.parentNode.insertBefore(featBox, list);
    const F = S.feats || []; featBox.replaceChildren(); featBox.hidden = !F.length; if (!F.length) return; const h = document.createElement('h4'); h.textContent = 'Edit a step (the model rebuilds)'; featBox.appendChild(h);
    F.forEach((f, i) => { const d = document.createElement('div'); d.className = 'feat-row' + (featEditable(i) ? '' : ' locked'); d.innerHTML = '<span>✎ <b></b></span><span></span>'; d.querySelector('b').textContent = f.kind === 'fillet' && f.p && f.p.opts ? (f.p.opts.type === 'chamfer' ? 'Chamfer' : 'Fillet') : f.name; d.lastChild.textContent = featSummary(f); d.onclick = () => openFeat(i); featBox.appendChild(d); }); }
  // ---------- Material picker and reference images ----------
  let MT = null;   // { id }
  function setMaterial(key) { const b = MT && S.bodies.find(x => x.id === MT.id); if (!b) return; const pre = S.bodies; step(() => { S.bodies = applyMaterial(S.bodies, b.id, key); }, 'Material'); if (S.bodies !== pre) pushFeat({ kind: 'material', name: 'Material', body: b.id, p: { key: key || null }, pre }); syncScene(); renderUI(); }
  const applyMaterial = (bs, id, key) => bs.map(x => x.id !== id ? x : { ...x, material: key || undefined, color: key ? MATS[key].color : x.baseColor || x.color, baseColor: x.baseColor || x.color });
  let IMG = null; const refImgs = [];   // { mesh, plane, w, h, du, dv, size, opacity }
  function refPlace(r) { const f = r.plane; const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.u), new THREE.Vector3(...f.v), new THREE.Vector3(...f.n));
    const o = C.frameToWorld(f, r.du, r.dv, -0.01); m.setPosition(new THREE.Vector3(...o)); r.mesh.matrixAutoUpdate = false; r.mesh.matrix.copy(m).multiply(new THREE.Matrix4().makeScale(r.size, r.size * r.h / r.w, 1)); r.mesh.material.opacity = r.opacity; requestRender(); }
  const imgInput = document.createElement('input'); imgInput.type = 'file'; imgInput.accept = 'image/*'; imgInput.style.display = 'none'; document.body.appendChild(imgInput);
  imgInput.addEventListener('change', () => { const file = imgInput.files && imgInput.files[0]; imgInput.value = ''; if (!file) return; const fr = new FileReader();
    fr.onload = () => { const img = new Image(); img.onload = () => { const tex = new THREE.Texture(img); tex.needsUpdate = true; if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false })); mesh.renderOrder = -1; scene.add(mesh);
      const r = { mesh, plane: { ...plane() }, w: img.width || 1, h: img.height || 1, du: 0, dv: 0, size: 10, opacity: 0.6 }; refImgs.push(r); refPlace(r); IMG = r; renderUI(); toast('Reference image placed on the sketch plane · set its size and position'); }; img.src = fr.result; };
    fr.readAsDataURL(file); });
  function pickImage() { if (!S.plane) { toast('Pick a sketch plane first'); return; } imgInput.click(); }
  // ---------- Scale a face (Shapr3D Scale on a face: uniform or non-uniform) ----------
  let SCF = null;   // { id, face, sx, sy, uniform }
  /** Scale about a hole's own middle, in its own frame: across it (sx, sy) and along its axis (sz). */
  function holeScaleMatrix(q, sx, sy, sz) { const { u, v, a, c } = q; const B = [u, v, a], k = [sx, sy, sz]; const L = new Array(16).fill(0); L[15] = 1;
    for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) { let x = 0; for (let i = 0; i < 3; i++) x += B[i][row] * k[i] * B[i][col]; L[col * 4 + row] = x; }
    const t = [0, 1, 2].map(r => c[r] - (L[r] * c[0] + L[4 + r] * c[1] + L[8 + r] * c[2])); L[12] = t[0]; L[13] = t[1]; L[14] = t[2]; return L; }
  const keepRow = e => { e.classList.add('pc-keep'); return e; };
  // ---------- hole scale gizmo: drag an axis handle (that direction only), a plane square (two directions) or the centre (uniform) ----------
  const HSG = { grp: new THREE.Group(), L: 58, PQ: 26, parts: [] }; HSG.grp.visible = false; scene.add(HSG.grp);
  { const mk = () => new THREE.MeshBasicMaterial({ color: 0xf4f6fa, depthTest: false, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
    for (let k = 0; k < 3; k++) { const m = mk(); const g = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.BoxGeometry(3.2, HSG.L - 18, 3.2), m); shaft.position.y = 12 + (HSG.L - 18) / 2;
      const tip = new THREE.Mesh(new THREE.BoxGeometry(11, 11, 11), m); tip.position.y = HSG.L; g.add(shaft, tip);
      if (k === 0) g.rotation.z = -Math.PI / 2; else if (k === 2) g.rotation.x = Math.PI / 2; HSG.grp.add(g); HSG.parts.push({ kind: 'axis', k, m }); }
    for (const [i, j] of [[0, 1], [1, 2], [0, 2]]) { const m = mk(); const sq = new THREE.Mesh(new THREE.PlaneGeometry(11, 11), m); const q = [0, 0, 0]; q[i] = HSG.PQ; q[j] = HSG.PQ; sq.position.set(...q);
      const nn = [0, 0, 0]; nn[3 - i - j] = 1; sq.lookAt(new THREE.Vector3(q[0] + nn[0], q[1] + nn[1], q[2] + nn[2])); HSG.grp.add(sq); HSG.parts.push({ kind: 'plane', pair: [i, j], m }); }
    const cm = mk(); HSG.grp.add(new THREE.Mesh(new THREE.TorusGeometry(5, 1.6, 8, 20), cm)); HSG.parts.push({ kind: 'centre', m: cm });
    HSG.grp.traverse(o => { o.renderOrder = 22; }); }
  const hsgEl = (() => { const d = document.createElement('div'); d.id = 'hsg-label'; d.hidden = true; d.style.cssText = 'position:fixed;z-index:30;pointer-events:none;background:#fff;color:#111;font:600 12px ui-monospace,Menlo,monospace;padding:2px 7px;border-radius:6px;border:1px solid #2f6fed;box-shadow:0 1px 4px rgba(0,0,0,.25)'; document.body.appendChild(d); return d; })();
  let HSD = null;   // the drag: { h, x0, y0, s0 }
  function hsgFrame() { if (!SCF || !(SCF.hole || SCF.wall)) return null; const q = SCF.hole || SCF.wall; const wpp = fitWpp(2 * q.r, 2 * (HSG.L + 14), q.c, 60).wpp; return { q, wpp, ax: [q.u, q.v, q.a] }; }
  function syncHoleScaleGizmo() {
    const F = hsgFrame(); if (!F) { HSG.grp.visible = false; hsgEl.hidden = true; return; } const { q, wpp, ax } = F;
    HSG.grp.position.set(q.c[0], q.c[1], q.c[2]); HSG.grp.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...ax[0]), new THREE.Vector3(...ax[1]), new THREE.Vector3(...ax[2]))); HSG.grp.scale.set(wpp, wpp, wpp); HSG.grp.visible = true;
    for (const p of HSG.parts) { const on = HSD && HSD.h.kind === p.kind && (p.kind !== 'axis' || HSD.h.k === p.k) && (p.kind !== 'plane' || (HSD.h.pair[0] === p.pair[0] && HSD.h.pair[1] === p.pair[1])); p.m.color.setHex(on ? 0xffd54a : 0xf4f6fa); p.m.opacity = HSD && !on ? 0.3 : 0.95; }
    if (HSD) { const s3 = [SCF.sx, SCF.sy, SCF.sz || 1]; const k = HSD.h.kind === 'axis' ? HSD.h.k : HSD.h.kind === 'plane' ? HSD.h.pair[0] : 0;
      const f0 = s3[k] / (HSD.s0[k] || 1);
      const tipW = HSD.h.kind === 'axis' ? [q.c[0] + ax[k][0] * HSG.L * wpp, q.c[1] + ax[k][1] * HSG.L * wpp, q.c[2] + ax[k][2] * HSG.L * wpp] : q.c; const P = project(tipW);
      hsgEl.textContent = '×' + (+(SCF.uniform || HSD.h.kind === 'centre' ? f0 : s3[k]).toFixed(2)); hsgEl.hidden = !P.ok; hsgEl.style.left = (P.x + 16) + 'px'; hsgEl.style.top = (P.y - 10) + 'px'; } else hsgEl.hidden = true;
  }
  function hitHoleScale(x, y) {
    const F = hsgFrame(); if (!F) return null; const { q, wpp, ax } = F; const c = q.c; let best = null; const consider = (d, lim, h) => { if (d < lim && (!best || d < best.d)) best = { d, ...h }; };
    const P = project(c); consider(Math.hypot(P.x - x, P.y - y), 16, { kind: 'centre' });
    for (let k = 0; k < 3; k++) { const T = project([c[0] + ax[k][0] * HSG.L * wpp, c[1] + ax[k][1] * HSG.L * wpp, c[2] + ax[k][2] * HSG.L * wpp]); if (T.ok) consider(Math.hypot(T.x - x, T.y - y) - 2, 22, { kind: 'axis', k }); }   // the cube tip (a finger-sized target)
    for (const [i, j] of [[0, 1], [1, 2], [0, 2]]) { const Q = project([c[0] + (ax[i][0] + ax[j][0]) * HSG.PQ * wpp, c[1] + (ax[i][1] + ax[j][1]) * HSG.PQ * wpp, c[2] + (ax[i][2] + ax[j][2]) * HSG.PQ * wpp]); if (Q.ok) consider(Math.hypot(Q.x - x, Q.y - y), 16, { kind: 'plane', pair: [i, j] }); }
    return best;
  }
  function hsgBegin(h, x, y) { HSD = { h, x0: x, y0: y, s0: [SCF.sx, SCF.sy, SCF.sz || 1] }; requestRender(); }
  let hsgQueued = false;
  function hsgMove(x, y) {
    if (!HSD) return; const F = hsgFrame(); if (!F) return; const { q, wpp, ax } = F; const P0 = project(q.c); const h = HSD.h; const s0 = HSD.s0;
    const along = dirW => { const P1 = project([q.c[0] + dirW[0] * HSG.L * wpp, q.c[1] + dirW[1] * HSG.L * wpp, q.c[2] + dirW[2] * HSG.L * wpp]); let dx = P1.x - P0.x, dy = P1.y - P0.y; const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len; return Math.max(0.05, 1 + ((x - HSD.x0) * dx + (y - HSD.y0) * dy) / len); };
    const snap = f => { const r = Math.round(f * 100) / 100; return Math.abs(r - 1) < 0.03 ? 1 : r; };
    let s3 = s0.slice();
    const f = h.kind === 'axis' ? along(ax[h.k]) : h.kind === 'plane' ? along(v3norm([ax[h.pair[0]][0] + ax[h.pair[1]][0], ax[h.pair[0]][1] + ax[h.pair[1]][1], ax[h.pair[0]][2] + ax[h.pair[1]][2]])) : Math.max(0.05, 1 + ((x - HSD.x0) - (y - HSD.y0)) / 90);
    if (SCF.uniform || h.kind === 'centre') s3 = s0.map(v => +(v * f).toFixed(4));   // Uniform: every handle scales all directions together, on top of the shape so far
    else if (h.kind === 'axis') s3[h.k] = snap(s0[h.k] * f);
    else { const [i, j] = h.pair; s3[i] = snap(s0[i] * f); s3[j] = snap(s0[j] * f); }
    SCF.sx = s3[0]; SCF.sy = s3[1]; SCF.sz = s3[2];
    if (!hsgQueued) { hsgQueued = true; requestAnimationFrame(() => { hsgQueued = false; if (SCF) scPreview(); }); }
  }
  function hsgEnd() { HSD = null; if (SCF) { xAfterDrag = true; scPreview(); renderUI(); } requestRender(); }   // scale sliders stay visible when the panel is folded
  function scSolid() { const b = SCF && S.bodies.find(x => x.id === SCF.id); if (!b) return null;
    if (SCF.hole && C.moveCylinderFace) {   // a hole scales as a feature (Plasticity): filled, then cut again wider, narrower or oval — still running through the body
      const surf = C.surfOfFace(b.md, SCF.face); const q = SCF.hole; const sx = SCF.sx, sy = SCF.sy, sz = SCF.sz || 1;   // Uniform / Non-uniform only change how the gizmo drags: the shape so far is kept
      const r = C.moveCylinderFace(b.man, b.md, surf, holeScaleMatrix(q, sx, sy, sz), {}); if (!r) throw new Error('This hole could not be scaled'); if (!r.ok) throw new Error("Operation failed because the resulting body wouldn't be valid"); return r.solid; }
    if (SCF.wall) { const M = holeScaleMatrix(SCF.wall, SCF.sx, SCF.uniform ? SCF.sx : SCF.sy, 1); const surf = C.surfOfFace(b.md, SCF.face);
      if (C.scaleWall) { const w = C.scaleWall(b.man, b.md, surf, M, SCF.wall); if (w && w.ok) { wallAxisOf.set(w.solid, [SCF.wall, ...(wallAxisOf.get(b.man) || [])].slice(0, 4)); return w.solid; } if (w && !w.ok) throw new Error("Operation failed because the resulting body wouldn't be valid"); }   // points move, nothing is rebuilt
      const r0 = C.transformSurface(b.man, b.md, surf, M); const r = r0 || (SCF.cyl ? C.moveOuterCylinder(b.man, SCF.cyl, M) : null); if (!r) throw new Error('This wall could not be scaled'); return r; }
    if (SCF.cyl) { const c = SCF.cyl; const pivot = [c.a[0] + c.d[0] * (c.t0 + c.t1) / 2, c.a[1] + c.d[1] * (c.t0 + c.t1) / 2, c.a[2] + c.d[2] * (c.t0 + c.t1) / 2]; const M = C.scaleAbout(pivot, [SCF.sx, SCF.sx, SCF.sx]); if (c.inward) return C.moveHole(b.man, c, M); const r0 = C.transformSurface(b.man, b.md, C.surfOfFace(b.md, SCF.face), M); return r0 || C.moveOuterCylinder(b.man, c, M); }
    if (SCF.curved) { const bb2 = b.man.boundingBox(); const pivot = [(bb2.min[0] + bb2.max[0]) / 2, (bb2.min[1] + bb2.max[1]) / 2, (bb2.min[2] + bb2.max[2]) / 2]; const r0 = C.transformSurface(b.man, b.md, C.surfOfFace(b.md, SCF.face), C.scaleAbout(pivot, [SCF.sx, SCF.sx, SCF.sx])); if (!r0) throw new Error('This wall is not on the outside of the body'); return r0; }
    const r = C.scaleFaceConvex(b.man, b.md, SCF.face, SCF.sx, SCF.uniform ? SCF.sx : SCF.sy); if (!r) throw new Error('Scale face works on flat faces of convex bodies (a box, a cylinder, a prism)'); return r; }
  let scHidden = null;   // the body hidden while its scaled preview shows in its place
  function scShowBody() { if (scHidden != null) { const o = objects.get(scHidden); if (o) for (const k of ['mesh', 'lines', 'faceMesh']) if (o[k]) o[k].visible = true; scHidden = null; } }
  function scPreview() { ofClear(); scShowBody(); if (!SCF) { requestRender(); return; } let m = null, xmd = null;
    // an exact body: once the finger is up the preview is the exact result (true faces, smooth edges); the quick mesh preview
    // shows first and the exact one replaces it a moment later, so the screen never freezes while it is built
    { const bx = S.bodies.find(x => x.id === SCF.id); if (!HSD && X.on && X.oc && xValid(bx) && (SCF.hole || SCF.wall)) { const key = xScaleKey(bx);
        if (xPrev && xPrev.key === key && xPrev.man === bx.man) { m = xPrev.res.man; xmd = xPrev.res.md; }
        else setTimeout(() => { if (!SCF || HSD) return; const b2 = S.bodies.find(x => x.id === SCF.id); if (b2 && xScaleKey(b2) === key && xApplyScale(b2, true)) { const changed = Math.abs(SCF.sx - 1) > 1e-9 || (!SCF.uniform && Math.abs(SCF.sy - 1) > 1e-9); if (xAfterDrag && changed) { xAfterDrag = false; scApply(); } else scPreview(); } }, 60); } }   // after a drag: applied right away, as in Shapr3D
    if (!m) try { m = scSolid(); } catch (e) { toast(e.message || String(e)); }
    if (m && (SCF.hole || SCF.wall)) { const o = objects.get(SCF.id); if (o) { for (const k of ['mesh', 'lines', 'faceMesh']) if (o[k]) o[k].visible = false; scHidden = SCF.id; } }   // a hole scale previews in place: the result replaces the body on screen
    if (m) { const md = xmd || C.meshData(m); const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(md.positions), 3)); g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(md.normals), 3)); g.setIndex(Array.from(md.indices));
      const hole = SCF && SCF.hole; let mesh;
      if (hole) {   // Plasticity: the body keeps its own colour, only the face being scaled turns blue
        const bb = S.bodies.find(x => x.id === SCF.id); let hs = -1, hd = Infinity;
        (md.surfs || []).forEach((sf, i) => { if (sf.planar) return; let ok = false; try { ok = !!(C.boreFrame && C.boreFrame(m, md, i)); } catch (e) { ok = false; } if (!ok) return; const d = Math.hypot(sf.c[0] - hole.c[0], sf.c[1] - hole.c[1], sf.c[2] - hole.c[2]); if (d < hd) { hd = d; hs = i; } });
        const I = md.indices, rest = [], face = []; for (let t = 0; t < I.length / 3; t++) (md.surfID && md.surfID[t] === hs ? face : rest).push(I[t * 3], I[t * 3 + 1], I[t * 3 + 2]);
        g.setIndex([...rest, ...face]); g.clearGroups(); g.addGroup(0, rest.length, 0); g.addGroup(rest.length, face.length, 1);
        const base = bb ? bodyMaterial(bb.color, bb.material) : new THREE.MeshStandardMaterial({ color: 0x9aa3ad });
        const blue = new THREE.MeshStandardMaterial({ color: 0x1ea7d8, roughness: 0.45, metalness: 0.05, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
        mesh = new THREE.Mesh(g, [base, blue]);
        if (face.length) { const gx = new THREE.BufferGeometry(); gx.setAttribute('position', g.getAttribute('position')); gx.setIndex(face.slice());   // the scaled face also shows through the body (x-ray), as when selected
          const xr = new THREE.Mesh(gx, new THREE.MeshBasicMaterial({ color: 0x5cc8ee, transparent: true, opacity: 0.38, depthTest: false, depthWrite: false, side: THREE.DoubleSide })); xr.renderOrder = 15; ofGroup.add(xr); }
        if (face.length) { const fg = new THREE.BufferGeometry(); fg.setAttribute('position', g.getAttribute('position')); fg.setIndex(face); const xr = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: 0x5cc8ee, transparent: true, opacity: 0.38, depthTest: false, depthWrite: false, side: THREE.DoubleSide })); xr.renderOrder = 15; ofGroup.add(xr); }
      } else mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x3fb950, transparent: true, opacity: 0.5, roughness: 0.6, depthWrite: false, side: THREE.DoubleSide }));
      mesh.renderOrder = 12; ofGroup.add(mesh);
      if (hole && md.edges && md.edges.length) { const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(md.edges), 3)); const el2 = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x1b2a3a })); el2.renderOrder = 13; ofGroup.add(el2); } } requestRender(); }
  /**
   * The axis frame { c, u, v, a, r } of an outer wall that runs round an axis — a cylinder, a cone, an oval left by a
   * non-uniform scale — so Scale face can scale it across that axis while its ends stay put. A true cylinder gives its
   * own frame; else a fitted cylinder; else the flat face the wall ends on (its normal is the axis, the middle of the
   * edge they share is the centre). null when none of these applies.
   */
  const wallAxisOf = new WeakMap();   // body solid → the axis frames its walls were last scaled about
  /**
   * The axis of a wall from its own facets: the scatter of its (area-weighted) normals has one odd principal direction —
   * the least for a straight wall (normals all across the axis), the most for a cone (all leaning by the same angle).
   * Centre: the middle of its points across that axis. null when the wall has no clear axis.
   */
  function normalAxis(md, surf) {
    const P = md.positions, I = md.indices; const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; let tot = 0; const pts = [];
    for (let t = 0; t < md.surfID.length; t++) { if (md.surfID[t] !== surf) continue; const A = [0, 1, 2].map(e => [P[I[t * 3 + e] * 3], P[I[t * 3 + e] * 3 + 1], P[I[t * 3 + e] * 3 + 2]]);
      const u = [A[1][0] - A[0][0], A[1][1] - A[0][1], A[1][2] - A[0][2]], v = [A[2][0] - A[0][0], A[2][1] - A[0][1], A[2][2] - A[0][2]]; const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const l = Math.hypot(n[0], n[1], n[2]); if (l < 1e-12) continue;
      const w = l / 2; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i][j] += w * n[i] * n[j] / (l * l); tot += w; pts.push(...A); }
    if (!(tot > 0) || pts.length < 9) return null; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i][j] /= tot;
    // eigen-decomposition of the 3×3 symmetric matrix (Jacobi)
    const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]; const A = S.map(r => r.slice());
    for (let sweep = 0; sweep < 30; sweep++) { let off = 0; for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += A[p][q] * A[p][q]; if (off < 1e-24) break;
      for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) { if (Math.abs(A[p][q]) < 1e-30) continue; const th = (A[q][q] - A[p][p]) / (2 * A[p][q]); const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)); const c = 1 / Math.sqrt(t * t + 1), s2 = t * c;
        for (let k = 0; k < 3; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s2 * akq; A[k][q] = s2 * akp + c * akq; } for (let k = 0; k < 3; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s2 * aqk; A[q][k] = s2 * apk + c * aqk; }
        for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s2 * vkq; V[k][q] = s2 * vkp + c * vkq; } } }
    const ev = [0, 1, 2].map(i => ({ l: A[i][i], v: [V[0][i], V[1][i], V[2][i]] })).sort((x, y) => x.l - y.l);
    // the odd one: whichever end eigenvalue stands further from the middle one (the other two are about equal for a round wall)
    const odd = (ev[1].l - ev[0].l) > (ev[2].l - ev[1].l) ? ev[0] : ev[2]; const gap = Math.max(ev[1].l - ev[0].l, ev[2].l - ev[1].l);
    if (!(gap > 0.05)) return null; const a = v3norm(odd.v);
    let cx = 0, cy = 0, cz = 0; for (const p of pts) { cx += p[0]; cy += p[1]; cz += p[2]; } const n = pts.length; return { a, c: [cx / n, cy / n, cz / n] };
  }
  function wallFrame(b, surf, cyl) {
    const md = b.md; const q0 = C.surfCylinder ? C.surfCylinder(md, surf) : null; if (q0) return q0.hole ? null : q0;
    // a wall scaled before: the same axis again (an oval or a cone fits no circle, but its axis has not changed)
    { const L = wallAxisOf.get(b.man); if (L) { const P = md.positions, I = md.indices; for (const f of L) { let ok = 0, n = 0; for (let t = 0; t < md.surfID.length; t++) { if (md.surfID[t] !== surf) continue; n++; const k = I[t * 3] * 3; const w = [P[k] - f.c[0], P[k + 1] - f.c[1], P[k + 2] - f.c[2]]; const h = w[0] * f.a[0] + w[1] * f.a[1] + w[2] * f.a[2]; const rr = Math.hypot(w[0] - f.a[0] * h, w[1] - f.a[1] * h, w[2] - f.a[2] * h); if (rr > 1e-6 && rr < 4 * (f.r || 1)) ok++; } if (n && ok > 0.95 * n) return f; } } }
    const cr = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
    const basis = a => { const t = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; const u = v3norm(cr(a, t)); return { u, v: cr(a, u) }; };
    if (cyl && cyl.d) { const a = v3norm(cyl.d); const m = (cyl.t0 + cyl.t1) / 2; const c = [cyl.a[0] + a[0] * m, cyl.a[1] + a[1] * m, cyl.a[2] + a[2] * m]; return { c, a, ...basis(a), r: cyl.r || 1, hole: false }; }
    // the flat faces this wall ends on: edges shared between the wall and a planar surface
    const P = md.positions, I = md.indices, sid = md.surfID; const vk = i => P[i * 3].toFixed(5) + ',' + P[i * 3 + 1].toFixed(5) + ',' + P[i * 3 + 2].toFixed(5);
    const edgeSurf = new Map(); for (let t = 0; t < sid.length; t++) for (let e = 0; e < 3; e++) { const i = I[t * 3 + e], j = I[t * 3 + (e + 1) % 3]; const ka = vk(i), kb = vk(j); const k = ka < kb ? ka + '|' + kb : kb + '|' + ka; let L = edgeSurf.get(k); if (!L) { L = { s: new Set(), i, j }; edgeSurf.set(k, L); } L.s.add(sid[t]); }
    const rim = new Map();   // planar surface → { len, pts }
    for (const L of edgeSurf.values()) { if (!L.s.has(surf) || L.s.size !== 2) continue; const other = [...L.s].find(x => x !== surf); const sf = md.surfs[other]; if (!sf || !sf.planar) continue;
      const p = [P[L.i * 3], P[L.i * 3 + 1], P[L.i * 3 + 2]], q = [P[L.j * 3], P[L.j * 3 + 1], P[L.j * 3 + 2]]; let R = rim.get(other); if (!R) { R = { len: 0, sum: [0, 0, 0] }; rim.set(other, R); } const l = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]); R.len += l; for (let k = 0; k < 3; k++) R.sum[k] += (p[k] + q[k]) / 2 * l; }
    // a round neighbour (the cylinder below a cone, the hole a lifted cone runs up to) shares the wall's axis
    const nb = new Set(); for (const L of edgeSurf.values()) if (L.s.has(surf) && L.s.size === 2) for (const x of L.s) if (x !== surf && md.surfs[x] && !md.surfs[x].planar) nb.add(x);
    let axis = null; for (const x of nb) { const q = C.surfCylinder(md, x); if (q && (!axis || q.r > axis.r)) axis = q; }
    let best = null; for (const [k, R] of rim) if (!best || R.len > best.R.len) best = { k, R };
    let a, c0;
    if (axis) { a = v3norm(axis.a); c0 = axis.c; }
    else if (best && md.surfs[best.k].n) { a = v3norm(md.surfs[best.k].n); c0 = best.R.sum.map(x => x / best.R.len); }
    else { const f = normalAxis(md, surf); if (!f) return null; a = f.a; c0 = f.c; }
    // centre half way along the wall, on the axis through the rim's centre
    let lo = Infinity, hi = -Infinity, rr = 0, cnt = 0; for (let t = 0; t < sid.length; t++) { if (sid[t] !== surf) continue; for (let e = 0; e < 3; e++) { const i = I[t * 3 + e]; const w = [P[i * 3] - c0[0], P[i * 3 + 1] - c0[1], P[i * 3 + 2] - c0[2]]; const h = w[0] * a[0] + w[1] * a[1] + w[2] * a[2]; lo = Math.min(lo, h); hi = Math.max(hi, h); rr += Math.hypot(w[0] - a[0] * h, w[1] - a[1] * h, w[2] - a[2] * h); cnt++; } }
    const m = (lo + hi) / 2; return { c: [c0[0] + a[0] * m, c0[1] + a[1] * m, c0[2] + a[2] * m], a, ...basis(a), r: cnt ? rr / cnt : 1, hole: false };
  }
  /**
   * An exact body's face, matched to its recipe: the round or elliptic wall (the body's own outline, or a hole cut into it)
   * whose surface its points lie on. Its frame — centre on the axis, the axis, the outline's own directions — drives the
   * scale gizmo, so the second and later scales of an ellipse stay exact (a circle fitted to the mesh would not find it).
   */
  function xFrameForFace(b, face) {
    if (!xValid(b)) return null; const md = b.md, P = md.positions, I = md.indices; const pts = [];
    for (let t = 0; t < md.faceID.length && pts.length < 600; t++) if (md.faceID[t] === face) for (let e = 0; e < 3; e++) { const k = I[t * 3 + e] * 3; pts.push([P[k], P[k + 1], P[k + 2]]); }
    if (pts.length < 6) return null; const rec = b.occ; const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    const cands = [{ it: rec.base, i: -1, kind: 'wall' }]; xOps(rec).forEach((o, i) => { if (o.kind === 'cut') cands.push({ it: o, i, kind: 'hole' }); });
    let best = null, bs = 0;
    for (const c of cands) { if (c.it.prof.type !== 'ell') continue; const f = c.it.frame, L = c.it.prof.L; const det = L[0] * L[3] - L[1] * L[2]; if (Math.abs(det) < 1e-12) continue; const c0 = xP(f, c.it.prof.c, 0); let ok = 0;
      for (const p of pts) { const w = [p[0] - c0[0], p[1] - c0[1], p[2] - c0[2]]; const x = dot(w, f.u), y = dot(w, f.v); const a = (L[3] * x - L[1] * y) / det, bb = (-L[2] * x + L[0] * y) / det; if (Math.abs(Math.hypot(a, bb) - 1) < 3e-3) ok++; }
      const sc = ok / pts.length; if (sc > bs) { bs = sc; best = c; } }
    if (!best || bs < 0.9) return null;
    const it = best.it, f = it.frame, L = it.prof.L; const zm = it.z0 + it.h / 2; const r = Math.sqrt(Math.abs(L[0] * L[3] - L[1] * L[2]));
    return { kind: best.kind, i: best.i, q: { c: xP(f, it.prof.c, zm), a: f.n.slice(), u: f.u.slice(), v: f.v.slice(), r, hole: best.kind === 'hole', h0: -Math.abs(it.h) / 2, h1: Math.abs(it.h) / 2 } };
  }
  function startScaleFace(b, face) {
    if (X.on && X.oc && xValid(b)) { const xf = xFrameForFace(b, face); if (xf) { OF = null; OE = null; oePreview();
        SCF = { id: b.id, face, sx: 1, sy: 1, sz: 1, uniform: true, cyl: null, hole: xf.kind === 'hole' ? xf.q : null, wall: xf.kind === 'wall' ? xf.q : null, curved: false, xItem: xf.i };
        S.faceTool = false; S.selectedFace = null; scPreview(); renderUI(); toast(xf.kind === 'hole' ? 'Scale the hole · exact' : 'Scale the wall · exact'); return; } } const f = C.isPlanarFace(b.md, face) ? C.faceFrame(b.md, face) : null; let cyl = null; if (!f || !f.n) { cyl = tryGeom(() => C.fitCylinder(b.md, C.surfOfFace(b.md, face))) || null; } const curved = !f || !f.n; OF = null; OE = null; oePreview();
    let hole = null; if (curved && (C.boreFrame || C.surfCylinder)) { const sf = C.surfOfFace(b.md, face); const q = C.boreFrame ? C.boreFrame(b.man, b.md, sf) : C.surfCylinder(b.md, sf); if (q && q.hole) hole = q; }
    let wall = null; if (curved && !hole) wall = wallFrame(b, C.surfOfFace(b.md, face), cyl);   // an outer wall round an axis (cylinder, cone, oval): same gizmo as a hole, scaled across the axis
    SCF = { id: b.id, face, sx: 1, sy: 1, sz: 1, uniform: true, cyl, hole, wall, curved: curved && !cyl && !hole }; S.faceTool = false; S.selectedFace = null; scPreview(); renderUI(); toast(wall ? 'Scale the wall across its axis · its ends stay where they are' : cyl ? 'Scale the cylinder wall · uniform changes its radius' : 'Scale face · the walls follow the new outline'); }
  function scCancel() { SCF = null; HSD = null; ofClear(); scShowBody(); renderUI(); requestRender(); }
  function scApply() { return named('Scale face', () => { const b = SCF && S.bodies.find(x => x.id === SCF.id); if (!b) { scCancel(); return; } if (X.on && X.oc && xValid(b) && xApplyScale(b)) return; const m = tryGeom(() => scSolid()); if (!m) return; const wasHole = SCF.hole; SCF = null; HSD = null; ofClear(); scShowBody();
    if (replaceBody(b, m)) { toast('Face scaled'); if (wasHole) { const nb = S.bodies.find(x => x.id === b.id); const md = nb && nb.md; let fi = null;
      if (md && md.surfs) { let bi = -1, bd = Infinity; md.surfs.forEach((sf, i) => { if (sf.planar) return; let isHole = false; try { isHole = !!(C.boreFrame && C.boreFrame(nb.man, md, i)); } catch (e) { isHole = false; } if (!isHole) return; const d = Math.hypot(sf.c[0] - wasHole.c[0], sf.c[1] - wasHole.c[1], sf.c[2] - wasHole.c[2]); if (d < bd) { bd = d; bi = i; } }); if (bi >= 0) for (let t = 0; t < md.surfID.length; t++) if (md.surfID[t] === bi) { fi = md.faceID[t]; break; } }
      if (fi != null) { S.selectedId = b.id; S.selectedFace = fi; S.faceTool = false; syncScene(); } } }
    renderUI(); }); }
  // ---------- Offset construction plane (Shapr3D Construct › Offset plane, kettle video 10:55–11:31) ----------
  let OP = null;   // { base: frame, d, size }
  const opMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }));
  const opEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineBasicMaterial({ color: 0x0891b2 })); opMesh.add(opEdge); opMesh.visible = false; opMesh.renderOrder = 13; scene.add(opMesh);
  function opFrame() { const f = OP.base, n = f.n; return { origin: [f.origin[0] + n[0] * OP.d, f.origin[1] + n[1] * OP.d, f.origin[2] + n[2] * OP.d], u: f.u.slice(), v: f.v.slice(), n: n.slice() }; }
  function opPreview() {
    if (!OP) { opMesh.visible = false; requestRender(); return; } const f = opFrame();
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.u), new THREE.Vector3(...f.v), new THREE.Vector3(...f.n)); m.setPosition(new THREE.Vector3(...f.origin));
    opMesh.matrixAutoUpdate = false; opMesh.matrix.copy(m).multiply(new THREE.Matrix4().makeScale(OP.size, OP.size, 1)); opMesh.visible = true; requestRender();
  }
  /** Starts from a flat face (its plane, centred on the face) or from the current sketch plane. */
  function startOffsetPlane(base, size) { OF = null; ofClear(); OE = null; oePreview(); OP = { base, d: 1, size: Math.max(2, size || 10) }; opPreview(); renderUI(); toast('Offset plane · set the distance, then Sketch on it'); }
  function startOffsetPlaneFromFace(b, face) { const f = C.faceFrame(b.md, face); if (!f || !f.n) { toast('Pick a flat face'); return; }
    let c = f.origin, ext = 6; if (f.loops && f.loops.length) { const L = f.loops[0]; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of L) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      c = C.frameToWorld(f, (x0 + x1) / 2, (y0 + y1) / 2, 0); ext = Math.max(x1 - x0, y1 - y0) * 1.4; }
    S.faceTool = false; S.selectedFace = null; startOffsetPlane({ origin: c, u: f.u, v: f.v, n: f.n }, ext); }
  function opCancel() { OP = null; opPreview(); renderUI(); }
  function opSketch() { if (!OP) return; const f = opFrame(); const d = OP.d; OP = null; opPreview();
    setTool('line'); step(() => { archiveSketch(); S.plane = { key: 'offset', name: `Offset plane (${+d.toFixed(2)} mm)`, origin: f.origin, u: f.u, v: f.v, n: f.n, bodyId: null }; S.sketchLines = []; S.lineStart = null; S.lastLine = -1; S.selRegion = -1; syncScene(); }, 'Offset plane');
    lookAtPlane(); renderUI(); toast('Sketching on the offset plane'); }
  // ---------- Offset Face (several faces at once) and Offset Edge (inset / outset an outline) — Shapr3D, kettle video ----------
  let OF = null;   // { id, faces: [faceId], d }
  let OE = null;   // { loops: [[x,y]...], d, plane }  — outline to offset, in the plane's 2D coordinates
  const ofGroup = new THREE.Group(); ofGroup.renderOrder = 12; scene.add(ofGroup);
  function ofClear() { for (const c of [...ofGroup.children]) { ofGroup.remove(c); c.geometry && c.geometry.dispose(); if (c.material) for (const mm of [].concat(c.material)) mm && mm.dispose && mm.dispose(); } }
  function ofSolid() {
    const b = OF && S.bodies.find(x => x.id === OF.id); if (!b) return null;
    const flat = [], holes = [];
    for (const face of OF.faces) { const f = C.faceFrame(b.md, face); if (f && f.n) { flat.push(f); continue; }
      let surf = -1; for (let t = 0; t < b.md.faceID.length; t++) if (b.md.faceID[t] === face) { surf = b.md.surfID[t]; break; }
      const cyl = surf >= 0 ? C.fitCylinder(b.md, surf) : null; if (!cyl) throw new Error('Offset Face works on flat faces and round holes');
      if (!cyl.inward) throw new Error('Offset Face on a round boss is not there yet — use Scale or Move/Rotate on the body'); holes.push(cyl); }
    let m = flat.length ? offsetFacesSolid(b, flat, OF.d) : b.man;
    for (const cyl of holes) m = C.offsetHole(m, cyl, OF.d);   // positive pushes the wall into the material: a smaller hole
    return m;
  }
  function offsetFacesSolid(b, frames, d) {
    let m = b.man; if (!d) return m; const eps = 1e-4;
    const exact = C.offsetConvexFaces(m, frames.map(f => ({ n: f.n, p: f.origin, d })));   // convex body: corners stretch and meet exactly
    if (exact) return exact;
    for (const f of frames) {
      if (!f.loops || !f.loops.length) continue;
      const regions = [{ outer: f.loops[0], holes: f.loops.slice(1) }];
      const pr = C.extrudeRegions(regions, Math.abs(d) + eps).map(p => C.placeInFrame(d > 0 ? p.translate([0, 0, -eps]) : p.translate([0, 0, d]), f));
      for (const p of pr) m = d > 0 ? m.add(p) : m.subtract(p);
    }
    return m;
  }
  function ofPreview() {
    ofClear(); if (!OF) { requestRender(); return; } let m = null; try { m = ofSolid(); } catch (e) { toast(e.message || String(e)); }
    if (m) { const md = C.meshData(m); const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(md.positions), 3)); g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(md.normals), 3)); g.setIndex(Array.from(md.indices));
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x3fb950, transparent: true, opacity: 0.5, roughness: 0.6, depthWrite: false, side: THREE.DoubleSide })); mesh.renderOrder = 12; ofGroup.add(mesh); }
    requestRender();
  }
  function startOffsetFace(b, face) { OE = null; OF = { id: b.id, faces: [face], d: 0.5 }; S.faceTool = false; S.selectedFace = null; ofPreview(); renderUI(); toast('Offset Face · tap more faces to add them, set the distance, Apply'); }
  function ofCancel() { OF = null; ofClear(); renderUI(); requestRender(); }
  function ofApply() { return named('Offset Face', () => { const b = OF && S.bodies.find(x => x.id === OF.id); if (!b) { ofCancel(); return; } const m = tryGeom(() => ofSolid()); if (!m) return; const n = OF.faces.length; const fp = { d: OF.d, faces: OF.faces.map(face => { const f = C.faceFrame(b.md, face); return { n: f.n.slice(), p: f.origin.slice() }; }) }; OF = null; ofClear(); const pre = S.bodies; if (replaceBody(b, m)) { toast(`Offset ${n} face${n > 1 ? 's' : ''}`); pushFeat({ kind: 'offsetFace', name: 'Offset Face', body: b.id, p: fp, pre }); } renderUI(); }); }
  // Offset Edge
  const oeLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x16a34a, depthTest: false })); oeLines.renderOrder = 15; scene.add(oeLines);
  function oeResult() { if (!OE || !OE.d) return []; try { return C.offsetLoops(OE.loops, OE.d); } catch (e) { return []; } }
  function oePreview() {
    const arr = []; if (OE) for (const L of oeResult()) for (let i = 0; i < L.length; i++) { const a = L[i], b = L[(i + 1) % L.length]; arr.push(...C.frameToWorld(OE.plane, a[0], a[1], 0.03), ...C.frameToWorld(OE.plane, b[0], b[1], 0.03)); }
    oeLines.geometry.dispose(); oeLines.geometry = new THREE.BufferGeometry(); oeLines.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3)); oeLines.visible = arr.length > 0; requestRender();
  }
  /** Offset Edge on a sketch region (loops already on the active plane) or on a flat face (its outline, on a sketch plane made from the face). */
  function startOffsetEdge(loops) { OF = null; ofClear(); OE = { loops, d: -0.3, plane: plane() }; oePreview(); renderUI(); toast('Offset Edge · negative = inside, positive = outside · Apply adds the new outline to the sketch'); }
  function startOffsetEdgeOnFace(b, face) { const f = C.faceFrame(b.md, face); if (!f || !f.loops || !f.loops.length) { toast('Pick a flat face'); return; } setTool('line'); setSketchPlane({ body: b, faceId: face }); startOffsetEdge(plane().loops || f.loops); }
  function oeCancel() { OE = null; oePreview(); renderUI(); }
  function oeApply() { const res = oeResult(); if (!res.length) { toast('That offset leaves nothing — make it smaller'); return; }
    step(() => { for (const L of res) for (let i = 0; i < L.length; i++) S.sketchLines.push([L[i].slice(), L[(i + 1) % L.length].slice()]); S.selRegion = -1; S.lastLine = -1; syncScene(); }, 'Offset Edge');
    OE = null; oePreview(); renderUI(); toast('Offset outline added · tap inside it to extrude'); }
  // ---------- Pattern (linear), Rotate around axis and Split body — Shapr3D Transform / Tools on a selected body ----------
  // XF: { kind: 'pattern' | 'rotate' | 'split', id, axis: 0|1|2, count, gap, angle, at }   — a translucent preview until Apply
  let XF = null; const xfGroup = new THREE.Group(); xfGroup.renderOrder = 12; scene.add(xfGroup);
  const AX = ['X', 'Y', 'Z'];
  function xfClear() { for (const c of [...xfGroup.children]) { xfGroup.remove(c); c.geometry && c.geometry.dispose(); if (c.material) for (const mm of [].concat(c.material)) mm && mm.dispose && mm.dispose(); } }
  function xfBody() { return XF && S.bodies.find(b => b.id === XF.id); }
  function xfCentre(m) { const bb = m.boundingBox(); return [0, 1, 2].map(i => (bb.min[i] + bb.max[i]) / 2); }
  function xfSize(m, i) { const bb = m.boundingBox(); return bb.max[i] - bb.min[i]; }
  /** The solids the current settings would make (new copies for a pattern, the replacement(s) otherwise). */
  function xfSolids() { const b = xfBody(); if (!b) return null; return xfSolidsFor(b.man, XF); }
  function xfSolidsFor(m, XF) {
    const i = XF.axis;
    if (XF.kind === 'pattern') { const out = []; for (let k = 1; k < XF.count; k++) { const v = [0, 0, 0]; v[i] = k * XF.gap; out.push(m.translate(v)); } return out; }
    if (XF.kind === 'rotate') { const c = xfCentre(m); const r = [0, 0, 0]; r[i] = XF.angle; return [m.translate(c.map(x => -x)).rotate(r).translate(c)]; }
    if (XF.kind === 'split') { const n = [0, 0, 0]; n[i] = 1; const bb = m.boundingBox(); const off = bb.min[i] + (bb.max[i] - bb.min[i]) * XF.at;
      const parts = m.splitByPlane(n, off); const arr = Array.isArray(parts) ? parts : [parts[0], parts[1]]; return arr.filter(p => p && p.volume() > 1e-9); }
    return null;
  }
  function xfPreview() {
    xfClear(); if (!XF) { requestRender(); return; } let res; try { res = xfSolids(); } catch (e) { toast(e.message || String(e)); res = null; }
    if (res) for (const m of res) { const md = C.meshData(m); const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(md.positions), 3)); g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(md.normals), 3)); g.setIndex(Array.from(md.indices));
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: XF.kind === 'split' ? 0xf59e0b : 0x3fb950, transparent: true, opacity: 0.45, roughness: 0.6, depthWrite: false, side: THREE.DoubleSide })); mesh.renderOrder = 12; xfGroup.add(mesh); }
    requestRender();
  }
  function startXf(kind, b) { const m = b.man; XF = { kind, id: b.id, axis: kind === 'rotate' ? 2 : 0, count: 3, gap: +(xfSize(m, 0) * 1.25).toFixed(2), angle: 90, at: 0.5 }; xfPreview(); renderUI(); }
  function xfCancel() { if (!XF) return; XF = null; xfClear(); renderUI(); requestRender(); }
  function xfApply() { return named(XF.kind === 'pattern' ? 'Pattern' : XF.kind === 'rotate' ? 'Rotate around axis' : 'Split body', () => {
    const b = xfBody(); if (!b) { xfCancel(); return; } const res = tryGeom(() => xfSolids()); if (!res || !res.length) return; const kind = XF.kind; const fp = { kind, axis: XF.axis, count: XF.count, gap: XF.gap, angle: XF.angle, at: XF.at }; XF = null; xfClear(); const pre = S.bodies; const idsBefore = new Set(S.bodies.map(x => x.id));
    if (kind === 'pattern') { pushUndo(); for (const m of res) { const rec = makeBodyRecord(b.name + ' copy', m); S.bodies = [...S.bodies, rec]; } commit(); toast(`${res.length + 1} bodies in a row`); }
    else if (kind === 'rotate') { if (replaceBody(b, res[0])) toast('Rotated ' + b.name); }
    else { if (res.length < 2) { toast('The plane does not cross the body'); renderUI(); return; } pushUndo(); S.bodies = S.bodies.filter(x => x.id !== b.id); for (const m of res) { const rec = makeBodyRecord(b.name, m); S.bodies = [...S.bodies, rec]; } S.selectedId = null; commit(); toast(`Split into ${res.length} bodies`); }
    if (S.bodies !== pre) { fp.outIds = S.bodies.filter(x => !idsBefore.has(x.id)).map(x => x.id); pushFeat({ kind: 'xf', name: kind === 'pattern' ? 'Pattern' : kind === 'rotate' ? 'Rotate around axis' : 'Split body', body: b.id, p: fp, pre }); }
    renderUI();
  }); }
  // ---------- Trim and Arc (Shapr3D sketch tools), as modes of the Line tool ----------
  let TM = null, AR = null;   // TM: {} while trimming · AR: { pts: [] } while placing a 3-point arc
  let SY = null;   // Symmetry: { axis: [[x,y],[x,y]] | null } — tap the mirror line, then the lines to mirror across it
  function startSymmetry() { if (!S.sketchLines.length) { toast('Draw some lines first'); return; } TM = null; AR = null; SY = { axis: null }; renderUI(); toast('Symmetry · tap the line to mirror across'); }
  const mirrorAcross = (q, A, B) => { const dx = B[0] - A[0], dy = B[1] - A[1]; const L2 = dx * dx + dy * dy; const t = ((q[0] - A[0]) * dx + (q[1] - A[1]) * dy) / L2; const f = [A[0] + dx * t, A[1] + dy * t]; return [2 * f[0] - q[0], 2 * f[1] - q[1]]; };
  const segSame = (l, a, b) => { const e = (P, Q) => Math.hypot(P[0] - Q[0], P[1] - Q[1]) < 1e-7; return (e(l[0], a) && e(l[1], b)) || (e(l[0], b) && e(l[1], a)); };
  function mirrorLines(segs) { const [A, B] = SY.axis; let n = 0; step(() => { for (const g of segs) { if (segSame(g, A, B)) continue; const m = [mirrorAcross(g[0], A, B), mirrorAcross(g[1], A, B)]; if (S.sketchLines.some(l => segSame(l, m[0], m[1]))) continue; S.sketchLines.push(m); n++; } syncScene(); }, 'Symmetry'); toast(n ? `Mirrored ${n} line${n === 1 ? '' : 's'}` : 'Already symmetric'); renderUI(); }
  function symTap(x, y) {
    const L = lineAt(x, y); if (!L) { toast(SY.axis ? 'Tap a line to mirror it' : 'Tap the line to mirror across'); return; }
    if (!SY.axis) { SY.axis = L; S.selSeg = L; syncScene(); renderUI(); toast('Mirror line chosen · tap lines to mirror, or Mirror all'); return; }
    mirrorLines([L]);
  }
  function endSymmetry() { SY = null; S.selSeg = null; syncScene(); renderUI(); requestRender(); }
  /** Exact lines: a start point, then lines of a typed length and angle (0° along the plane's first axis, counter-clockwise). */
  function typedStart() { const q = [S.tyX || 0, S.tyY || 0]; step(() => { S.lineStart = q; syncScene(); }, 'Line start'); toast(`Start point ${fmt(q[0])}, ${fmt(q[1])}`); renderUI(); }
  function typedLine() {
    const st = S.lineStart || (S.lastLine >= 0 && S.sketchLines[S.lastLine] ? S.sketchLines[S.lastLine][1] : null); if (!st) { toast('Set a start point first'); return; }
    const L = S.tyLen || 0, a = (S.tyAng || 0) * Math.PI / 180; if (!(L > 0)) { toast('Type a length'); return; }
    const r6 = v => Math.round(v * 1e6) / 1e6; const end = [r6(st[0] + L * Math.cos(a)), r6(st[1] + L * Math.sin(a))];
    step(() => { S.sketchLines.push([st.slice(), end]); S.lastLine = S.sketchLines.length - 1; S.lineStart = end; syncScene(); }, 'Line'); renderUI();
  }
  function planePt(x, y) { const ray = rayAt(x, y); return C.planeHit2D(plane(), ray.o, ray.d); }
  function startTrim() { if (!S.sketchLines.length) { toast('Draw some lines first'); return; } AR = null; TM = {}; renderUI(); toast('Tap the piece of a line to cut away'); }
  function startArc() { if (!S.plane) { toast('Pick a sketch plane first'); return; } TM = null; AR = { pts: [] }; renderUI(); toast('Tap the arc start point'); }
  function endModes() { TM = null; AR = null; renderUI(); requestRender(); }
  /** Trim: cuts the tapped piece of a line back to the nearest crossings with other lines (or its own ends). */
  function trimAt(x, y) {
    const L = lineAt(x, y); if (!L) { toast('Tap the piece of a line to cut away'); return; }
    const same = (P, Q) => Math.hypot(P[0] - Q[0], P[1] - Q[1]) < 1e-9;
    const idx = S.sketchLines.findIndex(l => (same(l[0], L[0]) && same(l[1], L[1])) || (same(l[0], L[1]) && same(l[1], L[0])));
    if (idx < 0) { toast('Only drawn lines can be trimmed'); return; }
    const [a, b] = S.sketchLines[idx]; const q = planePt(x, y); if (!q) return;
    const dx = b[0] - a[0], dy = b[1] - a[1]; const L2 = dx * dx + dy * dy; if (L2 < 1e-18) return;
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2));
    const cuts = [0, 1];
    S.sketchLines.forEach((m, j) => { if (j === idx) return; const X = C.segIntersect(a, b, m[0], m[1]); if (X && X.t > 1e-6 && X.t < 1 - 1e-6 && X.u > -1e-6 && X.u < 1 + 1e-6) cuts.push(X.t); });
    cuts.sort((p, r) => p - r); let lo = 0, hi = 1; for (let k = 0; k + 1 < cuts.length; k++) if (t >= cuts[k] && t <= cuts[k + 1]) { lo = cuts[k]; hi = cuts[k + 1]; break; }
    const P = u => [a[0] + dx * u, a[1] + dy * u]; const keep = []; if (lo > 1e-6) keep.push([a, P(lo)]); if (hi < 1 - 1e-6) keep.push([P(hi), b]);
    step(() => { S.sketchLines = [...S.sketchLines.slice(0, idx), ...keep, ...S.sketchLines.slice(idx + 1)]; S.selRegion = -1; S.lastLine = -1; syncScene(); }, 'Trim');
    toast(keep.length ? 'Trimmed back to the crossing' : 'Line removed'); if (!S.sketchLines.length) endModes();
  }
  /** Straight pieces of the circular arc from A to B through M (null when the three points are in a line). */
  function arcSegs(A, B, M) {
    const [ax, ay] = A, [bx, by] = B, [cx, cy] = M; const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by)); if (Math.abs(d) < 1e-12) return null;
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
    const r = Math.hypot(ax - ux, ay - uy); const T = 2 * Math.PI, norm = v => ((v % T) + T) % T;
    const a0 = Math.atan2(ay - uy, ax - ux), a1 = Math.atan2(by - uy, bx - ux), am = Math.atan2(cy - uy, cx - ux);
    let sweep = norm(a1 - a0); if (norm(am - a0) > sweep) sweep -= T;   // go the way that passes through M
    const n = Math.max(8, Math.ceil(Math.abs(sweep) / T * 72)); const pts = [A];
    for (let i = 1; i < n; i++) { const th = a0 + sweep * i / n; pts.push([ux + r * Math.cos(th), uy + r * Math.sin(th)]); }
    pts.push(B); const out = []; for (let i = 1; i < pts.length; i++) out.push([pts[i - 1], pts[i]]); return out;
  }
  function arcTap(x, y) {
    const q0 = planePt(x, y); if (!q0) return; const q = snapPoint(q0); AR.pts.push(q.slice());
    if (AR.pts.length === 3) { const [A, B, M] = AR.pts; const segs = arcSegs(A, B, M); AR.pts = [];
      if (!segs) { toast('Those points are in a line — tap a point off the line for the curve'); renderUI(); return; }
      step(() => { S.sketchLines = [...S.sketchLines, ...segs]; S.lastLine = -1; syncScene(); }, 'Arc'); toast('Arc added · tap the next start point, or Done'); }
    else toast(AR.pts.length === 1 ? 'Tap the arc end point' : 'Tap a point the arc passes through');
    renderUI();
  }
  // ---------- Move/Rotate a sketch (Shapr3D: select the shape, Move/Rotate, drag the arrows and rings) ----------
  let MS = null;   // { base: plane, c: [x,y,z] pivot, dx, dy, dz, rx, ry, rz }
  function msFrame() {
    const b = MS.base; const rad = d => d * Math.PI / 180; const [cx, sx] = [Math.cos(rad(MS.rx)), Math.sin(rad(MS.rx))], [cy, sy] = [Math.cos(rad(MS.ry)), Math.sin(rad(MS.ry))], [cz, sz] = [Math.cos(rad(MS.rz)), Math.sin(rad(MS.rz))];
    const R = v => { let [x, y, z] = v; [y, z] = [cx * y - sx * z, sx * y + cx * z]; [x, z] = [cy * x + sy * z, -sy * x + cy * z]; [x, y] = [cz * x - sz * y, sz * x + cz * y]; return [x, y, z]; };
    const o = R([b.origin[0] - MS.c[0], b.origin[1] - MS.c[1], b.origin[2] - MS.c[2]]);
    return { ...b, origin: [MS.c[0] + o[0] + MS.dx, MS.c[1] + o[1] + MS.dy, MS.c[2] + o[2] + MS.dz], u: R(b.u), v: R(b.v), n: R(b.n), bodyId: null, faceId: undefined, loops: undefined, key: 'moved', name: 'Moved sketch plane' };
  }
  function msPreview() { if (!MS) return; S.plane = msFrame(); syncScene(); requestRender(); }
  function startMoveSketch() { const c = sketchCentreWorld(); if (!c || !S.plane) { toast('Select a sketch shape first'); return; } MS = { base: { ...S.plane, origin: S.plane.origin.slice(), u: S.plane.u.slice(), v: S.plane.v.slice(), n: S.plane.n.slice() }, c, dx: 0, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0 }; renderUI(); toast('Move/Rotate the sketch · set the sliders, then Apply'); }
  function msCancel() { if (!MS) return; S.plane = MS.base; MS = null; syncScene(); renderUI(); }
  function msApply() { if (!MS) return; const f = msFrame(); S.plane = MS.base; MS = null; step(() => { S.plane = f; syncScene(); }, 'Move sketch'); toast('Sketch moved'); renderUI(); }
  // ---------- Revolve about a line (Shapr3D-style): select the closed region and the line, see the preview, set the angle, Done ----------
  // the line picked as the revolve axis while a region is selected (Select tool): shown thick and cyan until Revolve is tapped
  let RVLINE = null; const rvLineGroup = new THREE.Group(); rvLineGroup.renderOrder = 14; scene.add(rvLineGroup); let rvLineKey = null;
  function rvLineSync() {
    const k = RVLINE && S.plane ? JSON.stringify(RVLINE) : null; if (k === rvLineKey) return; rvLineKey = k;
    for (const c of [...rvLineGroup.children]) { rvLineGroup.remove(c); c.geometry && c.geometry.dispose(); c.material && c.material.dispose(); }
    if (k) { const A = new THREE.Vector3(...to3(RVLINE[0], 0.03)), B = new THREE.Vector3(...to3(RVLINE[1], 0.03)); const len = A.distanceTo(B);
      if (len > 1e-9) { const mid = A.clone().add(B).multiplyScalar(0.5); const wpp = 2 * camera.position.distanceTo(mid) * Math.tan(camera.fov * Math.PI / 360) / Math.max(1, renderer.domElement.clientHeight || innerHeight);
        const m = new THREE.Mesh(new THREE.CylinderGeometry(2 * wpp, 2 * wpp, len, 6, 1, true), new THREE.MeshBasicMaterial({ color: 0x22d3ee, depthTest: false }));
        m.position.copy(mid); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize()); m.renderOrder = 14; rvLineGroup.add(m); } }
    requestRender();
  }
  let RV = null;   // { angle, axis: [[x,y],[x,y]] | null, only: [region] | null }
  const rvGroup = new THREE.Group(); rvGroup.renderOrder = 12; scene.add(rvGroup);
  function rvClearPreview() { for (const c of [...rvGroup.children]) { rvGroup.remove(c); c.geometry && c.geometry.dispose(); if (c.material) for (const mm of [].concat(c.material)) mm && mm.dispose && mm.dispose(); } }
  function startRevolvePick(only) { const regs = only || lineRegions(); if (!regs.length) { toast('Draw a closed shape first'); return; } RV = { angle: RV && RV.angle || 360, height: RV && RV.height || 0, axis: null, only: only || null }; rvClearPreview(); renderUI(); toast('Tap the line to revolve around'); }
  function revolveCancel() { if (!RV) return; RV = null; rvClearPreview(); renderUI(); requestRender(); }   // the selected region and line stay, so Revolve can be tapped again
  /** The solids made by turning the regions about the line L = [[x, y], [x, y]] (sketch-plane coordinates), or a message. */
  function revolveSolids(L, regs, ang) {
    const f = plane(); const [A, B] = L; let d = [B[0] - A[0], B[1] - A[1]]; const dl = Math.hypot(d[0], d[1]); if (dl < 1e-9) return 'That line is too short'; d = [d[0] / dl, d[1] / dl];
    const W2 = (x, y) => [f.u[0] * x + f.v[0] * y, f.u[1] * x + f.v[1] * y, f.u[2] * x + f.v[2] * y];
    let p = [-d[1], d[0]]; const all = regs.flatMap(r => r.outer);
    const side = all.reduce((t, q) => t + ((q[0] - A[0]) * p[0] + (q[1] - A[1]) * p[1]), 0); if (side < 0) p = [-p[0], -p[1]];
    const toLocal = loop => loop.map(q => [(q[0] - A[0]) * p[0] + (q[1] - A[1]) * p[1], (q[0] - A[0]) * d[0] + (q[1] - A[1]) * d[1]]);
    const tol = 1e-6 * Math.max(1, ...all.map(q => Math.abs(q[0]) + Math.abs(q[1])));
    if (regs.some(r => toLocal(r.outer).some(q => q[0] < -tol))) return 'The shape crosses the line — keep it on one side of the axis';
    const o = W2(A[0], A[1]); const origin = [f.origin[0] + o[0], f.origin[1] + o[1], f.origin[2] + o[2]];
    const U = W2(p[0], p[1]), N = W2(d[0], d[1]); const V = [N[1] * U[2] - N[2] * U[1], N[2] * U[0] - N[0] * U[2], N[0] * U[1] - N[1] * U[0]];
    const frame = { ...f, origin, u: U, v: V, n: N }; const out = [];
    for (const r of regs) {
      try { const hgt = (RV && RV.height) || 0; const turn = loop => { if (hgt || Math.abs(ang) > 360) { if (!C.helix) throw new Error('Revolve with a height needs the Manifold engine'); return C.helix(loop, ang, hgt); } const a = Math.abs(ang); const m = C.revolve(loop, a, true); return ang < 0 ? m.mirror([0, 1, 0]) : m; };
        let sol = turn(toLocal(r.outer)); for (const h of r.holes || []) sol = sol.subtract(turn(toLocal(h))); out.push(C.placeInFrame(sol, frame)); }
      catch (e) { return e.message || String(e); }
    }
    return out;
  }
  /** With a height the revolve is a helix: its turns, pitch and hand (a thread). */
  function rvHelixNote() { if (!RV || !RV.height) return 'Height 0: a plain revolve · give it a height for a helix (a thread)'; const turns = Math.abs(RV.angle) / 360; return `Helix · ${fmt(turns)} turns · pitch ${fmt(Math.abs(RV.height) / Math.max(1e-9, turns))} · ${(RV.angle > 0) === (RV.height > 0) ? 'right' : 'left'}-hand`; }
  /** Shows the revolve as a translucent green solid while the angle is set. */
  function rvPreview() {
    { const hn = document.getElementById('rv-helix-note'); if (hn) hn.textContent = rvHelixNote(); }
    rvClearPreview(); if (!RV || !RV.axis) { requestRender(); return; }
    const regs = RV.only || lineRegions(); const res = revolveSolids(RV.axis, regs, RV.angle);
    if (typeof res === 'string') { toast(res); requestRender(); return; }
    for (const m of res) { const md = C.meshData(m); const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(md.positions), 3)); g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(md.normals), 3)); g.setIndex(Array.from(md.indices));
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x3fb950, transparent: true, opacity: 0.5, roughness: 0.6, depthWrite: false, side: THREE.DoubleSide })); mesh.renderOrder = 12; rvGroup.add(mesh); }
    requestRender();
  }
  /** Picks the axis: shows the preview; Done makes the bodies. */
  function revolveAboutLine(L, only) {
    if (!RV) RV = { angle: 360, axis: null, only: only || null }; if (only) RV.only = only;
    RV.axis = L; rvPreview(); renderUI();
  }
  function revolveDone() { return named('Revolve', () => step(() => {
    if (!RV || !RV.axis) return; const regs = RV.only || lineRegions(); const res = revolveSolids(RV.axis, regs, RV.angle);
    if (typeof res === 'string') { toast(res); return; }
    rvClearPreview(); RV = null; RVLINE = null; rvLineSync(); let made = 0; for (const m of res) { addBody('Revolve', m); made++; }
    S.selRegion = -1; toast(made === 1 ? 'Revolved around the line' : `Revolved ${made} shapes around the line`); renderUI();
  })); }
  function revolveFrame(f) { return { ...f, u: f.u, v: [-f.n[0], -f.n[1], -f.n[2]], n: f.v }; }
  function revolveSketch() { named('Revolve', () => step(() => { const m = tryGeom(() => C.placeInFrame(C.revolve(S.sketch, 360, true), revolveFrame(plane()))); if (!m) return; addBody('Revolve', m); clearSketch(); })); }
  function clearSketch() { if (!S.sketch.length && !S.sketchClosed) return; step(() => { S.sketch = []; S.sketchClosed = false; S.circle = null; S.polygon = null; syncScene(); }, 'Clear sketch'); }
  function undoPoint() { if (!S.sketch.length) return; step(() => { if (S.sketchClosed && S.tool === 'polyline') S.sketchClosed = false; else if (S.sketchClosed) { S.sketch = S.circle ? [S.circle.c] : S.sketch.slice(0, 1); S.sketchClosed = false; S.circle = null; } else S.sketch.pop(); syncScene(); }, 'Remove last point'); }

  /**
   * Extrude mode for a flat face: grows (v > 0) or cuts (v < 0) a straight prism from the face outline — optionally
   * drafted — and leaves the rest of the body exactly as it is (Stretch mode moves the face and bends the walls instead).
   */
  function extrudeFaceBody(man, md, faceId, v, dr = 0, loops = null, frame = null) {
    const f = frame || C.faceFrame(md, faceId); const h = Math.abs(v);
    const regions = window.CadIO.loopsToRegions((loops || f.loops).map(l => l.slice()));
    const locals = C.extrudeRegions(regions, h + BOOL_EPS, dr);
    const placed = locals.map(l => C.placeInFrame(v < 0 ? l.mirror([0, 0, 1]).translate([0, 0, BOOL_EPS]) : l.translate([0, 0, -BOOL_EPS]), f));
    let m = man; for (const sld of placed) m = C.fuse(m, sld, v < 0 ? 'cut' : 'join'); return m;
  }
  const extrudeMode = () => S.faceOp === 'extrude';
  function setFaceOp(op) { S.faceOp = op; if (SESSION && SESSION.target.kind === 'face') { SESSION.lastKey = null; applySession(); } syncScene(); }
  /** The History name of a push/pull or face extrusion by distance v on body b. */
  const faceOpName = (b, v) => `${extrudeMode() ? (v > 0 ? 'Extrude face' : 'Cut into face') : (v > 0 ? 'Pull face' : 'Push face')} of ${b.name} ${fmtDim(Math.abs(v))}`;
  function applyPushPull() {
    const b0 = selected(); if (!b0 || S.selectedFace == null) return;
    return named(faceOpName(b0, S.value), applyPushPullInner);
  }
  function applyPushPullInner() {
    const b = selected(); if (!b || S.selectedFace == null) return;
    const m = tryGeom(() => extrudeMode() ? extrudeFaceBody(b.man, b.md, S.selectedFace, S.value) : C.pushPull(b.man, b.md, S.selectedFace, S.value)); if (!m) return;
    if (m.volume() < 1e-9) { toast('That would remove the whole body'); return; }
    if (replaceBody(b, m)) { S.faceTool = false; toast(extrudeMode() ? (S.value > 0 ? 'Extruded face' : 'Cut into face') : (S.value > 0 ? 'Pulled face' : 'Pushed face')); }
  }
  function applyBoolean(other) { const op = S.pendingBool && S.pendingBool.op; return named(op === 'subtract' ? 'Subtract' : op === 'intersect' ? 'Intersect' : 'Union', () => applyBooleanInner(other)); }
  function applyBooleanInner(other) {
    const a = selected(); if (!a) return; const op = S.pendingBool; S.pendingBool = null;
    const m = tryGeom(() => C.clean(op === 'union' ? a.man.add(other.man) : op === 'subtract' ? a.man.subtract(other.man) : a.man.intersect(other.man)));
    if (!m) { renderUI(); return; }
    if (m.volume() < 1e-9) { toast('Result is empty (bodies do not overlap)'); renderUI(); return; }
    pushUndo();
    S.bodies = S.bodies.filter(b => b.id !== other.id).map(b => b.id === a.id ? { ...b, man: m, md: C.meshData(m) } : b);
    S.selectedFace = null; commit();
  }
  // ---------- Shell (Shapr3D-style): hollow a body, leaving the tapped flat face open ----------
  let SH = null;   // { id, face, t, base, n, p }
  let shellTimer = null;
  function shellPreview() { clearTimeout(shellTimer); shellTimer = setTimeout(shellPreviewNow, 220); }
  function shellPreviewNow() {
    if (!SH) return; const m = tryGeom(() => C.shell(SH.base.man, SH.t, { n: SH.n, p: SH.p }));
    const man = m || SH.base.man; S.bodies = S.bodies.map(x => x.id === SH.id ? { ...x, man, md: m ? C.meshData(m) : SH.base.md } : x); syncScene(); requestRender();
  }
  function startShell(b, face) {
    if (!C.shell) { toast('Shell needs the Manifold engine'); return; }
    let f; try { f = C.faceFrame(b.md, face); } catch (e) { f = null; } if (!f) { toast('Tap a flat face to open first'); return; }
    const o = f.origin || f.p || [0, 0, 0];
    SH = { id: b.id, face, t: SH && SH.t || 0.5, base: b, n: f.n, p: o }; S.faceTool = false; S.selectedFace = null; shellPreview(); renderUI();
  }
  function shellRestore() { if (!SH) return; const base = SH.base; S.bodies = S.bodies.map(x => x.id === SH.id ? base : x); }
  function shellCancel() { if (!SH) return; shellRestore(); SH = null; syncScene(); renderUI(); }
  function shellApply() { return named('Shell', () => { if (!SH) return; const m = tryGeom(() => C.shell(SH.base.man, SH.t, { n: SH.n, p: SH.p })); if (!m) return; const base = SH.base; const fp = { t: SH.t, open: { n: SH.n.slice(), p: SH.p.slice() } }; shellRestore(); SH = null; const pre = S.bodies; if (replaceBody(base, m)) { toast('Shelled ' + base.name); pushFeat({ kind: 'shell', name: 'Shell', body: base.id, p: fp, pre }); } renderUI(); }); }
  function mirrorSelected() { return named('Mirror', mirrorSelectedInner); }
  function mirrorSelectedInner() { const b = selected(); if (!b) return; const m = tryGeom(() => b.man.mirror([1, 0, 0])); if (m) { addBody('Mirror', m); toast('Mirrored across the green axis'); } }
  function duplicateSelected() { return named('Duplicate', duplicateSelectedInner); }
  function duplicateSelectedInner() { const b = selected(); if (!b) return; const bb = b.man.boundingBox(); const dx = bb.max[0] - bb.min[0] + 1; const m = tryGeom(() => b.man.translate([dx, 0, 0])); if (m) addBody('Copy', m); }

  function deleteSelected() { if (FL) commitFil(false); if (SC) scDrop(); const b = selected(); if (!b) return; if (MV) endMove(); pushUndo('Delete ' + b.name); S.moveSurf = null; S.bodies = S.bodies.filter(x => x.id !== b.id); S.selectedId = null; S.selectedFace = null; S.faceTool = false; S.pendingBool = null; commit(); toast(`Deleted ${b.name} · Undo brings it back`); }
  function clearAll() { if (FL) commitFil(false); if (!S.bodies.length && !S.sketch.length && !S.sketchLines.length) return; named('Clear all', () => step(() => { S.bodies = []; S.selectedId = null; S.selectedFace = null; S.faceTool = false; S.pendingBool = null; S.sketchLines = []; S.lineStart = null; S.imported = null; clearSketch(); commit(); toast('Cleared — Undo brings it back'); })); }
  function zoomTo(body) {
    const bb = body ? body.man.boundingBox() : null;
    if (bb) { cam.target.set((bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2); cam.dist = Math.max(0.01, Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) * 1.8); }
    else { cam.target.set(0, 0, 1.5); cam.dist = 28; cam.yaw = -0.9; cam.pitch = 0.5; }
    requestRender();
  }

  async function exportModel() {
    if (!S.bodies.length) { toast('Nothing to export yet'); return; }
    const mds = S.bodies.map(b => b.md);
    const zip = C.zipStore([{ name: 'model.stl', data: C.stlBinary(mds) }, { name: 'model.obj', data: new TextEncoder().encode(C.objText(mds)) }]);
    const dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null;
    if (dl) {
      try { await dl.save({ filename: 'solidsketch-model.zip', data: new Blob([zip]) }); toast('Saved solidsketch-model.zip (STL + OBJ inside)'); }
      catch (e) { if (e && e.code !== 'declined') toast('Export failed: ' + (e.message || e.code)); }
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([zip], { type: 'application/zip' })); a.download = 'solidsketch-model.zip'; a.click();
    }
  }

  // ---------- DXF / DWG import ----------
  let dwgLib = null;
  async function getDwgLib() {
    if (dwgLib) return dwgLib;
    if (!window.__DWG || typeof WebAssembly === 'undefined') throw new Error('The DWG reader needs WebAssembly, which this browser blocked. Save the drawing as DXF instead.');
    toast('Unpacking the DWG reader (first time only)…', 4000);
    await new Promise(r => setTimeout(r, 30));
    const dwgEl = $('dwg-wasm-b64'); let b64 = dwgEl.textContent.trim();
    if (!b64 && dwgEl.dataset.src) { const res = await withTimeout(fetch(dwgEl.dataset.src), 60000, 'DWG reader download'); if (!res.ok) throw new Error('Could not download the DWG reader (' + res.status + '). Save the drawing as DXF instead.'); b64 = (await res.text()).trim(); dwgEl.textContent = b64; }   // the published page keeps the reader outside the page and fetches it on first use
    if (!b64) throw new Error('The DWG reader is not in this copy. Save the drawing as DXF instead.');
    const gz = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
    const wasm = window.__DWG.pako.ungzip(gz);
    const inst = await withTimeout(window.__DWG.createModule({ wasmBinary: wasm, locateFile: () => 'libredwg-web.wasm', print: () => {}, printErr: () => {} }), 40000, 'DWG reader');
    dwgLib = window.__DWG.LibreDwg.createByWasmInstance(inst);
    return dwgLib;
  }
  async function importDrawing(name, buffer) {
    const head = new TextDecoder('latin1').decode(new Uint8Array(buffer.slice(0, 64)));
    const isDwg = /^AC1\d{3}/.test(head) || /\.dwg$/i.test(name);
    let entities, blocks, insunits = 0;
    if (isDwg) {
      const lib = await getDwgLib();
      const dwg = lib.dwg_read_data(buffer, window.__DWG.Dwg_File_Type.DWG);
      const db = lib.convert(dwg); try { lib.dwg_free(dwg); } catch (e) {}
      entities = (db.entities || []).filter(e => !e.isInPaperSpace); blocks = {};
      for (const b of ((db.tables && db.tables.BLOCK_RECORD && db.tables.BLOCK_RECORD.entries) || [])) blocks[b.name] = b;
      insunits = (db.header && db.header.INSUNITS) || 0;
    } else {
      const text = new TextDecoder().decode(new Uint8Array(buffer));
      if (!/SECTION/.test(text.slice(0, 4000))) throw new Error('This does not look like a DXF or DWG file');
      const parsed = window.CadIO.parseDxf(text); entities = parsed.entities; blocks = parsed.blocks; insunits = parsed.insunits;
    }
    const conv = window.CadIO.curvesFromEntities(entities, blocks);
    const ch = window.CadIO.chainCurves(conv.curves);
    if (!ch.closed.length && !ch.open.length) throw new Error('No lines, arcs, circles or polylines found in the drawing');
    const bounds = window.CadIO.bounds([...ch.closed, ...ch.open]);
    const size = Math.max(bounds.w, bounds.h) || 1;
    record();
    if (!S.plane) S.plane = { ...PRINCIPAL.top, bodyId: null };
    S.imported = { name, closed: ch.closed, open: ch.open, bounds, unitName: window.CadIO.UNIT_NAMES[insunits] || 'unknown units', scale: 20 / size, center: true, skipped: conv.skipped, height: 2 };
    S.sketch = []; S.sketchClosed = false;
    if (!isSketchTool(S.tool)) { S.tool = 'polyline'; }
    toast(`Imported ${ch.closed.length} closed shape${ch.closed.length === 1 ? '' : 's'} and ${ch.open.length} open curve${ch.open.length === 1 ? '' : 's'}`);
    syncScene();
  }
  const fileInput = $('file-in');
  fileInput.onchange = async () => {
    const f = fileInput.files && fileInput.files[0]; fileInput.value = ''; if (!f) return;
    try { await importDrawing(f.name, await f.arrayBuffer()); } catch (e) { toast('Import failed: ' + ((e && e.message) || e), 5000); }
  };
  function importFromText(text) { importDrawing('pasted.dxf', new TextEncoder().encode(text).buffer).catch(e => toast('Import failed: ' + ((e && e.message) || e), 5000)); }
  function cancelImport() { if (!S.imported) return; step(() => { S.imported = null; syncScene(); }, 'Cancel import'); }
  function importUseAsSketch() {
    const { closed } = importedLoops(); if (closed.length !== 1) { toast('Use as sketch needs exactly one closed shape — use Extrude all instead'); return; }
    step(() => { S.sketch = closed[0].map(q => [q[0], q[1]]); S.sketchClosed = true; S.imported = null; syncScene(); });
  }
  function importExtrude(mode = 'new') { step(() => importExtrudeInner(mode)); }
  function importExtrudeInner(mode) {
    const im = S.imported; if (!im) return; const { closed } = importedLoops(); if (!closed.length) { toast('No closed shapes to extrude'); return; }
    const regions = window.CadIO.loopsToRegions(closed); const h = Math.max(0.01, im.height), eps = BOOL_EPS;
    const host = onFace() ? S.bodies.find(b => b.id === S.plane.bodyId) : null;
    if ((mode === 'join' || mode === 'cut') && (!host || !C.booleans)) mode = 'new';
    const skin = mode === 'cut' ? skinReach(host.man, len => C.extrudeRegions(regions, len), plane(), 1) : 0;   // reach through a hair-thin lid over the pocket
    const locals = tryGeom(() => C.extrudeRegions(regions, mode === 'new' ? h : h + eps + skin)); if (!locals) return;
    const placed = tryGeom(() => locals.map(l => C.placeInFrame(mode === 'cut' ? l.translate([0, 0, -h]) : mode === 'join' ? l.translate([0, 0, -eps]) : (S.flip === 'both' && !onFace()) ? l.translate([0, 0, -h / 2]) : (S.flip && !onFace()) ? l.translate([0, 0, -h]) : l, plane()))); if (!placed) return;
    if (mode === 'new') { pushUndo(); for (const sld of placed) { const rec = makeBodyRecord('Import', sld); S.bodies = [...S.bodies, rec]; S.selectedId = rec.id; } S.selectedFace = null; S.imported = null; commit(); toast(`Created ${placed.length} bod${placed.length === 1 ? 'y' : 'ies'}`); return; }
    let man = host.man; for (const sld of placed) { const r = tryGeom(() => C.fuse(man, sld, mode)); if (!r) return; man = r; }
    if (man.volume() < 1e-9) { toast('Cut removed the whole body — try a smaller depth'); return; }
    if (replaceBody(host, man)) { S.imported = null; syncScene(); toast(mode === 'cut' ? 'Cut into ' + host.name : 'Added to ' + host.name); }
  }

  // ---------- DXF export ----------
  async function exportDxf() {
    const items = [];
    for (const b of S.bodies) {
      const ol = C.outline ? tryGeom(() => C.outline(b.man)) : null;
      if (ol) for (const poly of ol) items.push({ layer: 'OUTLINE_' + b.name.replace(/\s+/g, '_'), kind: 'polyline', pts: poly.map(q => [q[0], q[1], 0]), closed: true });
      const e = b.md.edges; for (let i = 0; i < e.length; i += 6) items.push({ layer: 'EDGES_' + b.name.replace(/\s+/g, '_'), kind: 'line', pts: [[e[i], e[i + 1], e[i + 2]], [e[i + 3], e[i + 4], e[i + 5]]] });
    }
    if (S.sketch.length >= 2) items.push({ layer: 'SKETCH', kind: 'polyline', pts: S.sketch.map(q => to3(q, 0)), closed: S.sketchClosed });
    const { closed, open } = importedLoops(); for (const l of closed) items.push({ layer: 'IMPORT', kind: 'polyline', pts: l.map(q => to3(q, 0)), closed: true }); for (const l of open) items.push({ layer: 'IMPORT', kind: 'polyline', pts: l.map(q => to3(q, 0)), closed: false });
    if (!items.length) { toast('Nothing to export yet'); return; }
    const dxf = window.CadIO.writeDxf(items);
    const zip = C.zipStore([{ name: 'drawing.dxf', data: new TextEncoder().encode(dxf) }]);
    const dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null;
    if (dl) { try { await dl.save({ filename: 'solidsketch-drawing.zip', data: new Blob([zip]) }); toast('Saved solidsketch-drawing.zip (drawing.dxf inside) — open it in AutoCAD and save as DWG if needed'); } catch (e) { if (e && e.code !== 'declined') toast('Export failed: ' + (e.message || e.code)); } }
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([zip], { type: 'application/zip' })); a.download = 'solidsketch-drawing.zip'; a.click(); }
  }

  // ---------- gestures ----------
  const pointers = new Map(); let gesture = 'none', moved = false, down = null, last = null, lastDist = 0, lastMid = null, dragBody = null, dragStart = null, lastTapTime = 0, lastTapPos = null;
  let pendingHandle = null; // move-gizmo handle under the finger at pointerdown, before we know if it is a tap or a drag
  const slop = 9;
  canvas.addEventListener('pointerdown', e => {
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not every browser can capture every pointer */ } pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType, button: e.button });
    if (pointers.size === 1) {
      gesture = 'one'; moved = false; down = { x: e.clientX, y: e.clientY, t: performance.now() }; last = { x: e.clientX, y: e.clientY }; dragBody = null;
      if (typeof SCF !== 'undefined' && SCF && (SCF.hole || SCF.wall) && e.button === 0) { const hh = hitHoleScale(e.clientX, e.clientY); if (hh) { hsgBegin(hh, e.clientX, e.clientY); gesture = 'hsg'; return; } }
      if ((TM || AR || SY) && e.button === 0) { gesture = 'rvpick'; if (SY) symTap(e.clientX, e.clientY); else if (TM) trimAt(e.clientX, e.clientY); else arcTap(e.clientX, e.clientY); return; }
      if (RV && !RV.axis && e.button === 0) { const L = lineAt(e.clientX, e.clientY); if (L) { gesture = 'rvpick'; revolveAboutLine(L); return; } }
      if (S.tool === 'select' && e.button === 0 && !LF && !SW && S.selProfiles.length === 1 && S.selectedId == null) { const gz0 = hitGizmo(e.clientX, e.clientY); if (gz0 && beginGizmo(gz0, e.clientX, e.clientY)) { gesture = 'gizmo'; return; } }   // a selected profile: its extrude arrow wins over dragging the profile
      if ((S.tool === 'select' || S.tool === 'move') && e.button === 0 && !LF && !SW) { const pc = profCentreAt(e.clientX, e.clientY); if (pc) { pendingProf = pc.id; gesture = 'pcentre'; return; } }
      const mg = (S.tool === 'move' && e.button === 0) ? hitMoveGizmo(e.clientX, e.clientY) : null;
            if (mg) { pendingHandle = mg; gesture = 'mgizmo'; return; }   // the session starts on the first real movement (a plain tap falls through to selection)
      const sh = (S.tool === 'select' && SC && e.button === 0) ? hitSc(e.clientX, e.clientY) : null;
      if (sh) { pendingSc = sh; gesture = 'sc'; return; }
      const fh = (S.tool === 'select' && FL && e.button === 0) ? hitFil(e.clientX, e.clientY) : null;
      if (fh) { pendingFil = fh; gesture = 'fil'; return; }   // a drag starts on the first movement; a plain tap on the shape handle resets it
      // right on a circle's centre (10 px) the press moves the circle, even where the extrude arrow starts from that centre
      if (e.button === 0 && isSketchTool(S.tool) && S.plane) { const cc = circleCentreAt(e.clientX, e.clientY); if (cc) { const q = project(to3(cc.c)); if (q.ok && Math.hypot(q.x - e.clientX, q.y - e.clientY) < 22 && sketchReshapeAt(e.clientX, e.clientY) === 'ccentre') { gesture = 'ccentre'; return; } }
        // a selected centre can be grabbed from a little further away
        const sc = selectedCircle(); if (sc) { const q2 = project(to3(sc.c)); if (q2.ok && Math.hypot(q2.x - e.clientX, q2.y - e.clientY) < 40) { gesture = 'ccentre'; return; } } }
      const gz = e.button === 0 ? hitGizmo(e.clientX, e.clientY) : null;
      if (gz) { if (beginGizmo(gz, e.clientX, e.clientY)) { gesture = 'gizmo'; return; } }
      { const rs = e.button === 0 ? sketchReshapeAt(e.clientX, e.clientY) : null; if (rs) { gesture = rs; return; } }
      const canDraw = DRAG_TOOLS.includes(S.tool) && S.plane && !S.imported && e.button === 0 && (e.pointerType === 'pen' || S.fingerDraws);
      if (canDraw) gesture = 'draw';
    }
    else if (pointers.size === 2) { const [a, b] = [...pointers.values()]; if (gesture === 'draw') cancelDraw(); if (gesture === 'gizmo') endGizmoDrag(); if (gesture === 'fil') { pendingFil = null; endFilDrag(); } if (gesture === 'sc') { pendingSc = null; endScDrag(); } if (gesture === 'mgizmo') { pendingHandle = null; if (MV && MV.drag) endMoveDrag(); } if (gesture === 'vertex') endVertexDrag(); gesture = 'two'; lastDist = Math.max(PINCH_MIN_PX, Math.hypot(a.x - b.x, a.y - b.y)); lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; updateCamera(); pinchAt = pointUnder(lastMid.x, lastMid.y); if (dragBody) endBodyDrag(); }
    else if (pointers.size === 3) { const pts = [...pointers.values()]; gesture = 'three'; threeStart = { x: (pts[0].x + pts[1].x + pts[2].x) / 3, t: performance.now() }; }
  });
  let threeStart = null;
  canvas.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId); if (!p) return; p.x = e.clientX; p.y = e.clientY;
    if (gesture === 'gizmo') { if (!moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 2) moved = true; if (moved) moveGizmo(e.clientX, e.clientY); return; }
    if (gesture === 'sc') { if (!moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) { moved = true; if (!pendingSc || !beginScDrag(pendingSc, down.x, down.y)) { pendingSc = null; gesture = 'one'; return; } } if (moved) moveScDrag(e.clientX, e.clientY); return; }
    if (gesture === 'fil') { if (!moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) { moved = true; if (!pendingFil || !beginFilDrag(pendingFil, down.x, down.y)) { pendingFil = null; gesture = 'one'; return; } } if (moved) moveFilDrag(e.clientX, e.clientY); return; }
    if (gesture === 'hsg') { moved = true; hsgMove(e.clientX, e.clientY); return; }
    if (gesture === 'gzr') { if (!moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) { moved = true; if (!pendingHandle || !beginGizmoRelocate(pendingHandle, down.x, down.y)) { pendingHandle = null; gesture = 'one'; return; } } if (moved) moveGizmoRelocate(e.clientX, e.clientY); return; }
    if (gesture === 'mgizmo') { if (!moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) { moved = true; if (!pendingHandle || !beginMoveDrag(pendingHandle, down.x, down.y)) { pendingHandle = null; gesture = 'one'; return; } pendingHandle = null; } if (moved && MV && MV.drag) moveMoveDrag(e.clientX, e.clientY); return; }
    if (location.hash === '#debug') { window.__gestures = window.__gestures || []; if (window.__gestures[window.__gestures.length - 1] !== gesture) window.__gestures.push(gesture); }
    if (gesture === 'pcentre') { if (!moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > slop) { moved = true; if (MV) endMove(); if (!beginProfDrag(pendingProf)) { gesture = 'one'; return; } } if (moved) moveProfDrag(e.clientX, e.clientY); return; }
    if (gesture === 'ccentre' || gesture === 'cradius') { if (!moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > slop) { moved = true; if (!beginCircleDrag(gesture, down.x, down.y)) { gesture = 'one'; return; } } if (moved) moveCircleDrag(e.clientX, e.clientY); return; }
    if (gesture === 'eline') { if (!moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > slop) { moved = true; if (!beginLineDrag(down.x, down.y)) { gesture = 'one'; return; } } if (moved) moveLineDrag(e.clientX, e.clientY); return; }
    if (gesture === 'vertex') { if (!moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > slop) { moved = true; if (!beginVertexDrag(down.x, down.y)) { gesture = 'one'; return; } } if (moved) moveVertexDrag(e.clientX, e.clientY); return; }
    if (gesture === 'draw') {
      if (!moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > slop) { moved = true; if (!beginDraw(down.x, down.y)) { gesture = 'one'; last = { x: e.clientX, y: e.clientY }; return; } }
      if (moved) moveDraw(e.clientX, e.clientY);
      last = { x: e.clientX, y: e.clientY };
    } else if (gesture === 'one') {
      const tapSlop = p.type === 'touch' && performance.now() - (down.t || 0) < 220 ? 16 : slop;   // a finger on glass drifts during a quick tap
      if (!moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > tapSlop) { moved = true; startDrag(down.x, down.y, p); }
      if (moved) {
        const dx = e.clientX - last.x, dy = e.clientY - last.y;
        if (dragBody) moveBodyDrag(e.clientX, e.clientY);
        else if (p.button === 2 || p.button === 1) pan(dx, dy);
        else { if (!orbitAbout) { updateCamera(); orbitAbout = orbitPivot(down.x, down.y); orbitBody = null;
            if (orbitAbout) { const r = canvas.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const hc = pickPoint(cx, cy), hf = pickPoint(down.x, down.y);
              const near = (q, h2) => h2 && Math.hypot(q[0] - h2[0], q[1] - h2[1], q[2] - h2[2]) < 1e-9 * Math.max(1, Math.hypot(...q));
              orbitBody = near(orbitAbout, hc) ? bodyAt(cx, cy) : near(orbitAbout, hf) ? bodyAt(down.x, down.y) : null;
              // only when the camera starts outside that body (never trap a view that is already inside it)
              if (orbitBody) { const cp = camera.position; if (insideBody(orbitBody.md, [cp.x, cp.y, cp.z])) orbitBody = null; }
              // very close to the pivot's surface (under 2 % of the body's size): its plane also holds the camera in front
              orbitSurfN = null; orbitCloseIn = false;
              if (orbitBody) { const bb = orbitBody.man.boundingBox(); const size = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]); const cp = camera.position; const dP = Math.hypot(cp.x - orbitAbout[0], cp.y - orbitAbout[1], cp.z - orbitAbout[2]);
                if (dP < 0.02 * size) { orbitSurfN = near(orbitAbout, hc) ? surfaceNormalAt(cx, cy) : surfaceNormalAt(down.x, down.y); if (orbitSurfN) { const d = [cp.x - orbitAbout[0], cp.y - orbitAbout[1], cp.z - orbitAbout[2]]; if (d[0] * orbitSurfN[0] + d[1] * orbitSurfN[1] + d[2] * orbitSurfN[2] <= 0) orbitSurfN = null; } orbitCloseIn = !!orbitSurfN; } } }
            // At a normal distance, turn about the body's middle, not the surface point: on the view line at the depth of the
            // body's centre (never nearer than its surface). The camera then keeps its distance and circles the body; around a
            // surface point every drag re-picks a nearer face and the camera spirals in.
            if (orbitAbout && orbitBody && !orbitCloseIn) { const r2 = canvas.getBoundingClientRect(); const cx2 = r2.left + r2.width / 2, cy2 = r2.top + r2.height / 2; const hc2 = pickPoint(cx2, cy2);
              if (hc2 && Math.hypot(orbitAbout[0] - hc2[0], orbitAbout[1] - hc2[1], orbitAbout[2] - hc2[2]) < 1e-9 * Math.max(1, Math.hypot(...hc2))) {
                const bb = orbitBody.man.boundingBox(); const c = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2]; const ray = rayAt(cx2, cy2);
                const tc = (c[0] - ray.o[0]) * ray.d[0] + (c[1] - ray.o[1]) * ray.d[1] + (c[2] - ray.o[2]) * ray.d[2], th = (hc2[0] - ray.o[0]) * ray.d[0] + (hc2[1] - ray.o[1]) * ray.d[1] + (hc2[2] - ray.o[2]) * ray.d[2];
                const tt = Math.max(th, tc); orbitAbout = [ray.o[0] + ray.d[0] * tt, ray.o[1] + ray.d[1] * tt, ray.o[2] + ray.d[2] * tt]; } }
            reanchorOnAxis(orbitAbout); } orbit(dx, dy); }
      }
      last = { x: e.clientX, y: e.clientY };
    } else if (gesture === 'two' && pointers.size >= 2) {
      // two finger pads cannot be closer than about a finger's width: smaller gaps are noise and must not blow up the ratio
      const [a, b] = [...pointers.values()]; const d = Math.max(PINCH_MIN_PX, Math.hypot(a.x - b.x, a.y - b.y)); const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (lastDist > 0) { updateCamera(); pinchAt = zoomAt(mid.x, mid.y, lastDist / d, pinchAt) || pinchAt; }
      updateCamera(); pan(mid.x - lastMid.x, mid.y - lastMid.y, pinchAt); lastDist = d; lastMid = mid; requestRender();
    }
  });
  const endPointer = e => {
    pointers.delete(e.pointerId); if (!pointers.size) { orbitAbout = null; orbitBody = null; orbitSurfN = null; orbitCloseIn = false; } if (pointers.size < 2) pinchAt = null;
    if (gesture === 'gizmo') { endGizmoDrag(); gesture = 'none'; return; }
    if (gesture === 'sc') { if (moved) endScDrag(); else if (SC && pendingSc === 'pivot') { const bb = scBody().man.boundingBox(); SC.pivot = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2]; requestRender(); } else if (SC) scLabel.onclick(); pendingSc = null; gesture = 'none'; return; }
    if (gesture === 'fil') {
      // a plain tap on a handle never reaches what lies behind it: the arrows open their value, the shape handle resets
      if (moved) endFilDrag();
      else if (FL && pendingFil === 'rho') { FL.shape = 'circular'; FL.lastKey = null; applyFil(true); syncScene(); toast('Circular fillet'); }
      else if (FL && pendingFil === 'size2') filLabel2.onclick(); else if (FL) filLabel.onclick();
      pendingFil = null; gesture = 'none'; return;
    }
    if (gesture === 'hsg') { hsgEnd(); gesture = 'none'; return; }
    if (gesture === 'gzr') { if (moved) endGizmoRelocate(); pendingHandle = null; gesture = 'none'; return; }
    if (gesture === 'mgizmo') { if (moved) endMoveDrag(); else { pendingHandle = null; onTap(e.clientX, e.clientY); lastTapTime = performance.now(); lastTapPos = { x: e.clientX, y: e.clientY }; } gesture = 'none'; return; }
    if (gesture === 'pcentre') { if (moved) endProfDrag(); else onTap(e.clientX, e.clientY); pendingProf = null; gesture = 'none'; return; }
    if (gesture === 'ccentre' || gesture === 'cradius') { if (moved) endCircleDrag(); else { const cc = gesture === 'ccentre' && S.tool !== 'circle' ? (circleCentreAt(e.clientX, e.clientY) || selectedCircle()) : null; if (cc) selectCentre(cc); else onTap(e.clientX, e.clientY); } gesture = 'none'; return; }
    if (gesture === 'eline') { if (moved) endLineDrag(); else onTap(e.clientX, e.clientY); gesture = 'none'; return; }
    if (gesture === 'vertex') { if (moved) endVertexDrag(); else if (S.tool !== 'edit') onTap(e.clientX, e.clientY); else { const v = vertexAt(e.clientX, e.clientY); S.selVertex = v ? v.p : null; S.selRegion = -1; syncScene(); } gesture = 'none'; return; }
    if (gesture === 'draw') {
      if (moved) { moveDraw(e.clientX, e.clientY); endDraw(); }
      else { const now = performance.now(); if (false) { /* double-tap while sketching never moves the camera */ } else { onTap(e.clientX, e.clientY); lastTapTime = now; lastTapPos = { x: e.clientX, y: e.clientY }; } }
      gesture = 'none';
    } else if (gesture === 'one') {
      if (!moved) {
        const now = performance.now();
        const dbl = lastTapPos && now - lastTapTime < 320 && Math.hypot(e.clientX - lastTapPos.x, e.clientY - lastTapPos.y) < 30; const dHit = dbl && S.tool === 'select' ? pick(rayAt(e.clientX, e.clientY)) : null;
        if (dHit) { if (FL) commitFil(false); S.selectedId = dHit.body.id; S.selectedFace = null; S.faceTool = false; S.scaleTool = false; S.selProfiles = []; S.selPath = null; S.selRegion = -1; commitLight(); toast('Whole body selected'); lastTapTime = 0; }   // Shapr3D: double-tap a body selects all of it; double-tap on empty space is just a tap
        else { onTap(e.clientX, e.clientY); lastTapTime = now; lastTapPos = { x: e.clientX, y: e.clientY }; }
      }
      if (dragBody) endBodyDrag();
      gesture = 'none';
    } else if (gesture === 'two') { gesture = pointers.size ? 'settle' : 'none'; }
    else if (gesture === 'three') {
      if (threeStart && pointers.size === 2) { const pts = [...pointers.values(), { x: e.clientX }]; const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length; const dx = mx - threeStart.x; if (performance.now() - threeStart.t < 900) { if (dx < -50) { undo(); toast('Undo'); } else if (dx > 50) { redo(); toast('Redo'); } } threeStart = null; }
      gesture = pointers.size ? 'settle' : 'none';
    }
    else if (!pointers.size) gesture = 'none';
  };
  canvas.addEventListener('pointerup', endPointer); canvas.addEventListener('pointercancel', endPointer);
  // mouse hover: the edge under the pointer lights up (Select tool), so it is clear what a click will pick
  canvas.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || pointers.size || S.tool !== 'select' || !C.filletEdges || (typeof TR !== 'undefined' && TR)) { if (filHover) { filHover = null; requestRender(); } return; }   // (not while Translate picks points)
    const h = edgeAt(e.clientX, e.clientY, 10); let nh = null;
    if (h) { const md = FL && FL.bodyId === h.body.id ? FL.base.md : h.body.md; const mine = FL && FL.bodyId === h.body.id && FL.sel.includes(h.index); if (!mine) nh = { key: h.body.id + ':' + h.index, chs: [C.edgeChains(md)[h.index]] }; }
    else if (FL) { // while editing, a face under the pointer previews the edges a tap would add
      const ray = rayAt(e.clientX, e.clientY); const f = C.rayMesh(FL.base.md, ray.o, ray.d);
      if (f && f.faceId != null) { const surf = C.surfOfFace(FL.base.md, f.faceId); const chs = []; C.edgeChains(FL.base.md).forEach((ch, i) => { if ((ch.sA === surf || ch.sB === surf) && !FL.sel.includes(i)) chs.push(ch); }); if (chs.length) nh = { key: 'face:' + surf, chs }; }
    }
    if ((nh && nh.key) !== (filHover && filHover.key)) { filHover = nh; requestRender(); }
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => { e.preventDefault(); updateCamera(); zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.1 : 1 / 1.1); /* out and back in by the same step */ }, { passive: false });
  /** The camera's axes (right, up, back) for a yaw / pitch, as three.js lookAt builds them with Z up. */
  function camBasis(yaw, pitch) {
    const cp = Math.cos(pitch); const z = [cp * Math.cos(yaw), cp * Math.sin(yaw), Math.sin(pitch)];
    const x = v3norm(v3cross([0, 0, 1], z)); const y = v3cross(z, x); return [x, y, z];
  }
  /** The point of a body under a screen point, or null. */
  function pickPoint(x, y) { const h = pick(rayAt(x, y)); return h ? h.point.slice() : null; }
  /** Every line drawn in the scene, in world space: paths, profile outlines and the sketch's lines. */
  function worldLines() {
    const segs = [];
    for (const q of S.paths || []) { const W = pathW(q); for (let i = 0; i + 1 < W.length; i++) segs.push([W[i], W[i + 1]]); if (q.closed && W.length > 2) segs.push([W[W.length - 1], W[0]]); }
    for (const q of S.profiles || []) for (const L of [q.outer, ...(q.holes || [])]) for (let i = 0; i < L.length; i++) segs.push([C.frameToWorld(q.frame, L[i][0], L[i][1], 0), C.frameToWorld(q.frame, L[(i + 1) % L.length][0], L[(i + 1) % L.length][1], 0)]);
    for (const [a, b] of sketchSegments()) segs.push([to3(a), to3(b)]);
    return segs;
  }
  /** A picker over those lines, their screen positions worked out once: the line point under a screen point (within 14 px). */
  function linePicker() {
    // screen positions of both ends, also when an end is off screen (project() only calls points on screen ok); a segment is
    // cut where it passes behind the camera
    const r = canvas.getBoundingClientRect(); const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); const cp = camera.position; const nearD = Math.max(camera.near, 1e-9);
    const depth = w => (w[0] - cp.x) * fwd.x + (w[1] - cp.y) * fwd.y + (w[2] - cp.z) * fwd.z;
    const scr = w => { const v = new THREE.Vector3(w[0], w[1], w[2]).project(camera); return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height }; };
    const P2 = [];
    for (let [a, b] of worldLines()) { let da = depth(a), db = depth(b); if (da <= nearD && db <= nearD) continue;
      if (da <= nearD || db <= nearD) { const t = (nearD * 1.001 - da) / (db - da); const m = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; if (da <= nearD) a = m; else b = m; }
      P2.push({ a, b, A: scr(a), B: scr(b) }); }
    return (x, y) => {
      if (!P2.length) return null; const ray = rayAt(x, y); let best = null;
      for (const q of P2) { const dx = q.B.x - q.A.x, dy = q.B.y - q.A.y; const L2 = dx * dx + dy * dy || 1; const u = Math.max(0, Math.min(1, ((x - q.A.x) * dx + (y - q.A.y) * dy) / L2)); const d = Math.hypot(q.A.x + dx * u - x, q.A.y + dy * u - y); if (d > 14) continue;
        // the point of the segment closest to the finger's ray
        const e = [q.b[0] - q.a[0], q.b[1] - q.a[1], q.b[2] - q.a[2]], w = [q.a[0] - ray.o[0], q.a[1] - ray.o[1], q.a[2] - ray.o[2]]; const A = e[0] * e[0] + e[1] * e[1] + e[2] * e[2], B = e[0] * ray.d[0] + e[1] * ray.d[1] + e[2] * ray.d[2], Cc = ray.d[0] * ray.d[0] + ray.d[1] * ray.d[1] + ray.d[2] * ray.d[2];
        const D = e[0] * w[0] + e[1] * w[1] + e[2] * w[2], E = ray.d[0] * w[0] + ray.d[1] * w[1] + ray.d[2] * w[2]; const den = A * Cc - B * B; let sgm = den > 1e-18 ? (B * E - Cc * D) / den : 0; sgm = Math.max(0, Math.min(1, sgm));
        const pt = [q.a[0] + e[0] * sgm, q.a[1] + e[1] * sgm, q.a[2] + e[2] * sgm]; const depth = (pt[0] - ray.o[0]) * ray.d[0] + (pt[1] - ray.o[1]) * ray.d[1] + (pt[2] - ray.o[2]) * ray.d[2];
        if (depth > 0 && (!best || d < best.d - 0.5 || (Math.abs(d - best.d) <= 0.5 && depth < best.depth))) best = { d, pt, depth }; }
      return best;
    };
  }
  /**
   * What the camera zooms toward and turns about: the nearest of the body under the finger, a profile sheet under it, or a
   * line near it (a path, a profile outline, a sketch line). Lines count like bodies, so zooming or orbiting on them never
   * rushes toward a body far behind.
   */
  function camPick(x, y, lp, only) {
    const ray = rayAt(x, y); let best = null; const take = (depth, pt) => { if (depth > 0 && (!best || depth < best.depth)) best = { depth, pt }; };
    const bh = pick(ray, only); if (bh) take(bh.distance, bh.point.slice());
    const ph = typeof pickProfile === 'function' ? pickProfile(ray) : null; if (ph) take(ph.distance, [ray.o[0] + ray.d[0] * ph.distance, ray.o[1] + ray.d[1] * ph.distance, ray.o[2] + ray.d[2] * ph.distance]);
    const lh = (lp || linePicker())(x, y); if (lh) take(lh.depth, lh.pt);
    return best ? best.pt : null;
  }
  /**
   * Where an orbit turns about (Shapr3D keeps what you look at in place): the model at the middle of the view, else the
   * model under the finger, else the centre of the visible body nearest the middle of the view; null keeps the old centre.
   */
  /** World centre of the selected sketch shape, else of everything drawn on the active plane; null when there is no sketch. */
  function sketchCentreWorld() {
    if (!S.plane) return null; let pts = [];
    if (S.selRegion >= 0 && regionCache[S.selRegion]) pts = regionCache[S.selRegion].outer; else pts = sketchSegments().flat();
    if (!pts.length) return null; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const q of pts) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
    return C.frameToWorld(plane(), (x0 + x1) / 2, (y0 + y1) / 2, 0);
  }
  function orbitPivot(fx, fy) {
    const r = canvas.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const lp = linePicker(); const p = camPick(cx, cy, lp) || (fx != null ? camPick(fx, fy, lp) : null); if (p) return p;
    // a selected sketch shape, else the active sketch, is the pivot: turning the view keeps the drawing in the middle (Shapr3D)
    const sc = sketchCentreWorld(); if (sc) return sc;
    let best = null;
    for (const b of S.bodies) { const bb = b.man.boundingBox(); const c = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2]; const q = project(c);
      if (!q.ok || q.x < r.left || q.x > r.right || q.y < r.top || q.y > r.bottom) continue; const d = Math.hypot(q.x - cx, q.y - cy); if (!best || d < best.d) best = { c, d }; }
    return best ? best.c : null;
  }
  let pendingProf = null;  // a profile whose centre was pressed (dragged once the finger moves)
  let orbitAbout = null;   // pivot of the current orbit drag
  let orbitBody = null;    // the body the pivot lies on: the orbit never swings the camera inside it
  let orbitSurfN = null, orbitCloseIn = false;   // right against a surface: its outward normal, and that the close-in rule applies
  function surfaceNormalAt(x, y) {
    const h = pick(rayAt(x, y)); if (!h || h.triangle == null) return null; const P = h.body.md.positions, I = h.body.md.indices; const t = h.triangle;
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3; const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const l = Math.hypot(...n); return l > 0 ? n.map(q => q / l) : null;
  }
  /** Is point q inside the body? (a ray from q crosses its surface an odd number of times) */
  function insideBody(md, q) {
    const P = md.positions, I = md.indices, d = [0.5773502, 0.5773567, 0.5773437]; let n = 0;
    for (let t = 0; t < I.length / 3; t++) {
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2], e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x; const det = e1x * px + e1y * py + e1z * pz; if (Math.abs(det) < 1e-18) continue;
      const inv = 1 / det, sx = q[0] - P[a], sy = q[1] - P[a + 1], sz = q[2] - P[a + 2]; const u = (sx * px + sy * py + sz * pz) * inv; if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x; const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv; if (v < 0 || u + v > 1) continue;
      if ((e2x * qx + e2y * qy + e2z * qz) * inv > 0) n++;
    }
    return n % 2 === 1;
  }
  const bodyAt = (x, y) => { const h = pick(rayAt(x, y)); return h ? h.body : null; };
  /** If p lies on the view axis, make it the orbit centre: the view does not move, and zoom and depth follow the model. */
  function reanchorOnAxis(p) {
    if (!p) return; const cp = camera.position; const f = new THREE.Vector3(); camera.getWorldDirection(f);
    const v = [p[0] - cp.x, p[1] - cp.y, p[2] - cp.z]; const along = v[0] * f.x + v[1] * f.y + v[2] * f.z; if (!(along > 0)) return;
    const off = Math.hypot(v[0] - f.x * along, v[1] - f.y * along, v[2] - f.z * along); if (off > 1e-6 * Math.max(1, along)) return;
    cam.target.set(p[0], p[1], p[2]); cam.dist = along; updateCamera();
  }
  let pinchAt = null;      // the model point held under the fingers during a pinch
  const PINCH_MIN_PX = 60;   // about one finger width
  /** Orbit: the camera and its centre turn together about the pivot, so the pivot stays exactly where it is on screen. */
  function orbit(dx, dy) {
    const y0 = cam.yaw, p0 = cam.pitch, t0 = cam.target.clone(); const P = orbitAbout;
    const tryStep = (yaw, pitch) => {
      cam.yaw = yaw; cam.pitch = pitch; cam.target.copy(t0);
      if (P) {
        const B1 = camBasis(y0, p0), B2 = camBasis(yaw, pitch); const t = [t0.x - P[0], t0.y - P[1], t0.z - P[2]];
        const loc = [0, 1, 2].map(k => B1[k][0] * t[0] + B1[k][1] * t[1] + B1[k][2] * t[2]);   // the centre in the old camera axes …
        const out = [0, 1, 2].map(i => B2[0][i] * loc[0] + B2[1][i] * loc[1] + B2[2][i] * loc[2]);   // … placed the same in the new ones
        cam.target.set(P[0] + out[0], P[1] + out[1], P[2] + out[2]);
      }
      if (!P || !orbitBody) return true;
      // turn freely all the way around; only a step that would put the camera inside the body under the pivot is refused.
      // Zoomed right against a surface (closer than 2 % of the body), the inside test is too coarse, so there the camera
      // must also stay in front of that surface's plane; a turn about a point on it would otherwise swing into the body.
      const cp = Math.cos(pitch); const c = [cam.target.x + cam.dist * cp * Math.cos(yaw), cam.target.y + cam.dist * cp * Math.sin(yaw), cam.target.z + cam.dist * Math.sin(pitch)];
      if (insideBody(orbitBody.md, c)) return false;
      if (orbitSurfN && orbitCloseIn) { const d = [c[0] - P[0], c[1] - P[1], c[2] - P[2]]; const l = Math.hypot(...d) || 1; return (d[0] * orbitSurfN[0] + d[1] * orbitSurfN[1] + d[2] * orbitSurfN[2]) / l > 0.05; }
      return true;
    };
    const y1 = y0 - dx * 0.006, p1 = Math.min(1.5, Math.max(-1.5, p0 + dy * 0.006));
    if (!tryStep(y1, p1) && !tryStep(y1, p0) && !tryStep(y0, p1)) tryStep(y0, p0);   // slide along the edge rather than go through
    requestRender();
  }
  /**
   * The point a zoom scales about: the model under the screen point; else a point on that same ray at the depth of the model
   * nearest to it on screen (fingers just beside a small object zoom toward the object, not toward whatever lies far behind);
   * else at the depth of the nearest body in view; only in an empty view the plane through the orbit centre.
   */
  function pointUnder(x, y) {
    const lp = linePicker(); const hit = camPick(x, y, lp); if (hit) return hit;
    const ray = rayAt(x, y); const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); const cp = camera.position;
    const depthOf = p => (p[0] - cp.x) * fwd.x + (p[1] - cp.y) * fwd.y + (p[2] - cp.z) * fwd.z;
    const atDepth = z => { const along = ray.d[0] * fwd.x + ray.d[1] * fwd.y + ray.d[2] * fwd.z; if (!(along > 1e-9) || !(z > 0)) return null; const tt = z / along; return [ray.o[0] + ray.d[0] * tt, ray.o[1] + ray.d[1] * tt, ray.o[2] + ray.d[2] * tt]; };
    // only bodies whose box on screen comes within the rings' reach are tried (most of a big scene is far from the fingers)
    const nearB = S.bodies.filter(b => { const bb = b.man.boundingBox(); let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const px of [bb.min[0], bb.max[0]]) for (const py of [bb.min[1], bb.max[1]]) for (const pz of [bb.min[2], bb.max[2]]) { const q = project([px, py, pz]); if (!isFinite(q.x) || !isFinite(q.y)) return true; x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
      return !(x < x0 - 130 || x > x1 + 130 || y < y0 - 130 || y > y1 + 130); });
    for (const rad of [16, 32, 56, 88, 120]) {           // rings around the fingers, nearest first
      let best = null; for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8; const h = camPick(x + Math.cos(a) * rad, y + Math.sin(a) * rad, lp, nearB); if (h) { const z = depthOf(h); if (z > 0 && (!best || z < best)) best = z; } }
      if (best) { const q = atDepth(best); if (q) return q; }
    }
    { const r = canvas.getBoundingClientRect(); let best = null;
      for (const b of S.bodies) { const bb = b.man.boundingBox(); const c = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2]; const q = project(c); const z = depthOf(c);
        if (!q.ok || z <= 0 || q.x < r.left || q.x > r.right || q.y < r.top || q.y > r.bottom) continue; const d = Math.hypot(q.x - x, q.y - y); if (!best || d < best.d) best = { d, z }; }
      if (best) { const q = atDepth(best.z); if (q) return q; } }
    const n = camBasis(cam.yaw, cam.pitch)[2]; const den = ray.d[0] * n[0] + ray.d[1] * n[1] + ray.d[2] * n[2]; if (Math.abs(den) < 1e-9) return null;
    const tt = ((cam.target.x - ray.o[0]) * n[0] + (cam.target.y - ray.o[1]) * n[1] + (cam.target.z - ray.o[2]) * n[2]) / den; return tt > 0 ? [ray.o[0] + ray.d[0] * tt, ray.o[1] + ray.d[1] * tt, ray.o[2] + ray.d[2] * tt] : null;
  }
  /** Zoom by k (k < 1 closer) about the point under screen (x, y): that point stays under the fingers / cursor. */
  let sceneSizeKey = null, sceneSizeVal = 0;
  /** Diagonal of the box around every body (0 without bodies), cached per bodies list. */
  function sceneSize() {
    { const sb = sceneBounds(); return sb ? 2 * sb.r : 0; }   // (bodies, profiles, paths and sketch lines)
    if (sceneSizeKey === S.bodies) return sceneSizeVal; let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const b of S.bodies) { const bb = b.man.boundingBox(); for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], bb.min[k]); mx[k] = Math.max(mx[k], bb.max[k]); } }
    sceneSizeKey = S.bodies; sceneSizeVal = isFinite(mn[0]) ? Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) : 0; return sceneSizeVal;
  }
  /** If the camera is inside a body, move it on along d out of that body (just past its far side). */
  function exitBody(d, reach) {
    const cp = camera.position; const p0 = [cp.x, cp.y, cp.z]; const inB = bodyContaining(p0); if (!inB) return false;
    const h = C.rayMesh(inB.md, p0, d); if (!h) return false; const t = h.distance + Math.max(1e-6, 0.25 * reach);
    cam.target.set(cam.target.x + d[0] * t, cam.target.y + d[1] * t, cam.target.z + d[2] * t); updateCamera(); return true;
  }
  function zoomAt(x, y, k, about) {
    // no zoom limit either way (only the float range); a fast pinch is kept sane by the finger-width rule instead
    // range relative to the model: 10 000x its size out (it is long a speck by then, and Fit all brings it back) down to a
    // millionth of it in; beyond that floating point breaks the view. Without a model, a fixed wide range.
    // Out: no limit (only the float range; Fit all brings a speck back). In: toward the point under the fingers, down to a
    // millionth of the model.
    const sbz = sceneBounds(); const size = sbz ? sbz.r : 1; const lo = size * 1e-6;
    const Q = about || pointUnder(x, y);
    // Close to a surface (within 2 % of the model's size) zooming in no longer creeps toward it forever: the view moves
    // straight on at a steady pace, through the surface, and shows what lies behind it.
    if (k < 1 && Q) { const cp = camera.position; const dq = [Q[0] - cp.x, Q[1] - cp.y, Q[2] - cp.z]; const dQ = Math.hypot(...dq); const reach = 0.02 * size;
      if (dQ < reach) { const ray = rayAt(x, y); const step = (1 - k) * reach; cam.target.set(cam.target.x + ray.d[0] * step, cam.target.y + ray.d[1] * step, cam.target.z + ray.d[2] * step);
        updateCamera(); exitBody(ray.d, reach); requestRender(); const ahead = camera.position; return [ahead.x + ray.d[0] * 2 * reach, ahead.y + ray.d[1] * 2 * reach, ahead.z + ray.d[2] * 2 * reach]; } }
    // zooming out from very close (after passing through a body, say) backs away at the same steady pace, not by a tiny fraction
    if (k > 1) { const cp = camera.position; const dQ = Q ? Math.hypot(Q[0] - cp.x, Q[1] - cp.y, Q[2] - cp.z) : 0; const reach = 0.02 * size;
      if ((!Q || dQ < reach) && cam.dist < reach) { const ray = rayAt(x, y); const step = (k - 1) * reach; cam.target.set(cam.target.x - ray.d[0] * step, cam.target.y - ray.d[1] * step, cam.target.z - ray.d[2] * step); updateCamera(); exitBody([-ray.d[0], -ray.d[1], -ray.d[2]], reach); requestRender(); return Q || about || null; } }
    let nd = cam.dist * k; if (k < 1) nd = Math.max(nd, Math.min(lo, cam.dist)); nd = Math.min(nd, 1e15);
    k = nd / cam.dist; if (!isFinite(k) || k <= 0 || Math.abs(k - 1) < 1e-12) return Q || about || null;
    if (Q) cam.target.set(Q[0] + (cam.target.x - Q[0]) * k, Q[1] + (cam.target.y - Q[1]) * k, Q[2] + (cam.target.z - Q[2]) * k);
    cam.dist = nd; requestRender(); return Q;
  }
  /** Pan by a screen distance; at: the point that should follow the fingers exactly (its depth sets the scale). */
  function pan(dx, dy, at) {
    const fwd = new THREE.Vector3().subVectors(cam.target, camera.position).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 0, 1)).normalize(); const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    const k = worldPerPx(at || null);
    cam.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k); requestRender();
  }
  function startDrag(x, y, p) {
    if (S.tool !== 'select' || S.pendingBool || p.button !== 0) return;
    let b = selected(); if (!b) return;
    const ray = rayAt(x, y); const hit = C.rayMesh(b.md, ray.o, ray.d); if (!hit) return;
    const g = planeHit(ray, hit.point[2]); if (!g) return;
    if (FL) { commitFil(false); b = selected(); if (!b) return; }
    if (SC) scDrop();
    dragBody = b; dragStart = { plane: g, z: hit.point[2], dx: 0, dy: 0 };
  }
  function moveBodyDrag(x, y) {
    const g = planeHit(rayAt(x, y), dragStart.z); if (!g) return;
    let dx = g[0] - dragStart.plane[0], dy = g[1] - dragStart.plane[1];
    if (S.snap) { dx = Math.round(dx * 2) / 2; dy = Math.round(dy * 2) / 2; }
    dragStart.dx = dx; dragStart.dy = dy;
    const o = objects.get(dragBody.id); if (o) { o.mesh.position.set(dx, dy, 0); o.lines.position.set(dx, dy, 0); if (o.faceMesh) o.faceMesh.position.set(dx, dy, 0); }
    requestRender();
  }
  function endBodyDrag() {
    const b = dragBody, { dx, dy } = dragStart; dragBody = null;
    const o = objects.get(b.id); if (o) { o.mesh.position.set(0, 0, 0); o.lines.position.set(0, 0, 0); if (o.faceMesh) o.faceMesh.position.set(0, 0, 0); }
    if (dx || dy) replaceBody(b, b.man.translate([dx, dy, 0]), true); else requestRender();
  }

  // ---------- UI ----------
  const TOOLS = [['select', 'Select'], ['move', 'Move/Rotate'], ['line', 'Line'], ['polyline', 'Polyline'], ['rect', 'Rectangle'], ['circle', 'Circle'], ['polygon', 'Polygon'], ['edit', 'Edit sketch'], ['box', 'Box'], ['cylinder', 'Cylinder'], ['sphere', 'Sphere']];
  const toolsEl = $('tools'), panelEl = $('panel'), hintEl = $('hint'), countEl = $('count');
  // Keep sketch when leaving (⋮ menu): on by default, the lines stay (visible) when you switch to Select or Move/Rotate
  let keepSketch = (() => { try { return localStorage.getItem('ss.keepSketch') !== '0'; } catch (e) { return true; } })();
  // Leaving a sketch never deletes its lines silently: with keeping off, a choice appears first (Keep / Discard)
  const keepPrompt = document.createElement('div'); keepPrompt.id = 'keep-prompt'; keepPrompt.hidden = true; document.body.appendChild(keepPrompt);
  { const st = document.createElement('style'); st.textContent = `#keep-prompt { position: fixed; left: 50%; bottom: 150px; transform: translateX(-50%); z-index: 40; background: var(--panel); color: var(--fg); border: 1px solid var(--border); border-radius: 14px; padding: 12px 14px; box-shadow: 0 6px 24px rgba(0,0,0,.35); font: inherit; font-size: 14px; max-width: 92vw; }
      #keep-prompt .kp-row { display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end; } #keep-prompt button { font: inherit; font-size: 14px; font-weight: 600; border-radius: 999px; padding: 8px 14px; border: 1px solid var(--border); background: transparent; color: var(--fg); cursor: pointer; }
      #keep-prompt button.kp-keep { background: var(--accent); color: #fff; border-color: var(--accent); }`; document.head.appendChild(st); }
  function askKeepSketch(t) {
    const n = S.sketchLines.length + (S.sketch.length >= 2 ? S.sketch.length - (S.sketchClosed ? 0 : 1) : 0);
    keepPrompt.replaceChildren(); keepPrompt.append(el('div', '', `Keep your ${n} sketch line${n === 1 ? '' : 's'}?`), el('div', 'note', 'Leaving the sketch would remove them.'));
    const row = document.createElement('div'); row.className = 'kp-row';
    const keepB = document.createElement('button'); keepB.className = 'kp-keep'; keepB.textContent = 'Keep';
    keepB.onclick = () => { keepPrompt.hidden = true; keepSketch = true; try { localStorage.setItem('ss.keepSketch', '1'); } catch (e) { /* private mode */ } setTool(t); toast('Lines kept · sketches are now kept when you leave them (⋮ menu to change)'); };
    const dropB = document.createElement('button'); dropB.textContent = 'Discard'; dropB.onclick = () => { keepPrompt.hidden = true; setTool(t, true); toast('Lines removed · Undo brings them back'); };
    row.append(dropB, keepB); keepPrompt.append(row); keepPrompt.hidden = false;
  }
  function setTool(t, discardOk) {
    if (PJ || UB || IMP || XI) xtCancelAll();
    if (['line', 'polyline', 'rect', 'circle', 'polygon'].includes(t) && S.plane && !(S.sketch && S.sketch.length)) {
      const n = S.plane.n || [0, 0, 1]; const square = Math.max(Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])) > 1 - 1e-6;   // parallel to Top, Front or Side
      if (S.plane.key === 'moved' || (!square && S.plane.bodyId == null)) { if (S.sketchLines && S.sketchLines.length) archiveSketch(); S.sketchLines = []; S.plane = null; S.selRegion = -1; S.moveCircle = null; }
    }
    if (S.tool === 'move' && t !== 'move' && S.plane && S.plane.key === 'moved') { archiveSketch(); S.sketchLines = []; S.plane = null; S.selRegion = -1; S.moveCircle = null; }   // leaving Move/Rotate: a moved sketch stays where it went, and the next one starts on Top / Front / Side
    if (MS) msCancel();
    if (SH) shellCancel();
    if (TM || AR) { TM = null; AR = null; }
    if (RVLINE) { RVLINE = null; rvLineSync(); }
    if (XF) { XF = null; xfClear(); }
    if (OF) { OF = null; ofClear(); }
    if (SCF) { SCF = null; ofClear(); }
    if (OP) { OP = null; opPreview(); }
    MT = null; FE = null;
    if (RV) revolveCancel();
    if (SY) { SY = null; S.selSeg = null; }
    if (t === S.tool) return;
    if (!keepPrompt.hidden) keepPrompt.hidden = true;
    if (typeof TR !== 'undefined' && TR) { TR = null; trDraw(); } clearHover();
    const clears = !isSketchTool(t) && isSketchTool(S.tool) && !keepSketch;
    if (clears && !discardOk && (S.sketchLines.length || S.sketch.length >= 2)) { askKeepSketch(t); return; }
    if ((S.sketch.length && (clears || isSketchTool(t))) || S.imported || (clears && (S.sketchLines.length || S.plane))) record();
    H.depth++; try { setToolInner(t); } finally { H.depth--; }
    if (keepSketch && !isSketchTool(t) && (S.sketchLines.length || S.sketch.length)) save();   // the kept sketch is saved as it is now
  }
  function setToolInner(t) {
    if (SESSION) endSession(); if (MV) endMove(); if (FL) commitFil(false); if (SC) scDrop(); S.moveSurf = null; S.moveGizmoEdit = false; S.moveGizmo = null;
    const wasSketching = isSketchTool(S.tool); const staying = wasSketching && isSketchTool(t);
    if (((staying) || (wasSketching && !isSketchTool(t) && keepSketch)) && S.sketch.length >= 2) { const n = S.sketch.length; for (let i = 0; i + 1 < n + (S.sketchClosed ? 1 : 0); i++) S.sketchLines.push([S.sketch[i], S.sketch[(i + 1) % n]]); S.sketch = []; S.sketchClosed = false; }
    if (typeof lfDrop === 'function') lfDrop(); if (typeof swDrop === 'function') swDrop(); if (t !== S.tool) { S.selProfiles = []; S.selPath = null; }   // Select keeps an ordered pick for a loft, Move/Rotate one profile: a new tool starts afresh
    const keepRegion = t === 'move' && S.tool === 'select' && S.selRegion >= 0;   // Move/Rotate keeps the selected shape (orange fill and edges) while it moves
    S.tool = t; S.drawing = null; S.lastLine = -1; S.snapTip = null; S.selRegion = keepRegion ? S.selRegion : -1; S.selVertex = null; S.selSeg = null; S.selHole = null; S.selCentre = null; S.moveCircle = null; S.circle = null; if (!staying) clearSketch(); else { S.sketch = []; S.sketchClosed = false; } S.pendingBool = null; S.faceTool = false; S.scaleTool = false;
    const sketching = isSketchTool(t);
    if (!sketching || !wasSketching) { S.lineStart = null; }
    if (!sketching) { S.selectedId = (t === 'select' || t === 'move') ? S.selectedId : null; S.selectedFace = null; if (!keepSketch || !wasSketching) { if (!keepSketch) { S.plane = null; S.sketchLines = []; S.imported = null; } } }   // (Keep sketch when leaving: the lines and their plane stay)
    else if (S.plane) { S.selectedId = S.plane.bodyId; S.selectedFace = S.plane.faceId; }
    else { S.selectedId = null; S.selectedFace = null; }
    syncScene();
  }
  const hint_session = () => SESSION && SESSION.drag === 'draft' ? `${SESSION.draft}° · rotate on the arc: shrink or grow the pulled face` : SESSION && SESSION.drag ? `${fmtDim(Math.abs(SESSION.value))} · ${SESSION.value < 0 ? 'pushing in' : 'pulling out'} · release, then tap elsewhere to finish` : 'Drag the arrow to adjust the distance · drag the small arrow along the arc to tilt the wall · tap elsewhere to finish';
  function hint() {
    const b = selected();
    if (TR) return !TR.start ? 'Translate · tap the start point on the body' : !TR.end ? 'Translate · tap the end point (it snaps to corners, edge middles, face centres)' : 'Translate · Done moves it there · Copy keeps the original';
    if (S.selCentre && isSketchTool(S.tool) && selectedCircle()) return 'Circle selected by its centre · drag the centre to move it (it snaps) · or type X, Y and radius';
    if (SW) return SW.error ? 'This sweep cannot be made · the panel says why' : `Sweep along ${SW.edges} edge${SW.edges === 1 ? '' : 's'} · Round corners to bend smoothly · Apply to make the body`;
    if (S.tool === 'select' && !b && S.selPath && !S.selProfiles.length) return 'Path edges picked · tap a profile, then Sweep';
    if (S.tool === 'select' && !b && S.selPath && S.selProfiles.length === 1) {   // like Shapr3D: "5 edges & 1 face · 58.137 mm"
      return `${S.selPath.segs.length} edge${S.selPath.segs.length === 1 ? '' : 's'} & 1 profile · ${(Math.round(selPathLength() * 1000) / 1000).toString()} mm · tap more edges along the path, then Sweep`;
    }
    if (LF) return LF.error ? LF.error : `Loft through ${LF.ids.length} profiles · ${LF.smooth ? 'Smooth' : 'Straight'} · Apply to make the body`;
    if (S.tool === 'select' && !b && S.selProfiles.length) return `${S.selProfiles.length} profile${S.selProfiles.length === 1 ? '' : 's'} · tap more in order, then Loft`;
    if (filActive()) {
      const n = FL.sel.length; const eff = filEffType();
      if (FL.drag === 'rho') return `Shape ${Math.round(FL.rho * 1000) / 1000} · lower is flatter, higher is sharper · tap the handle for a circular fillet`;
      if (FL.drag) return `${eff === 'fillet' ? 'R' : ''}${fmtDim(FL.drag === 'size2' ? FL.value2 : FL.value)}${FL.type === 'auto' ? ` · Auto: ${eff === 'fillet' ? 'curved stroke → fillet' : 'straight stroke → chamfer'}` : ''}${FL.invalid ? ' · too big here' : ''} · release to set`;
      return `${n} edge${n === 1 ? '' : 's'} · drag the arrow${FL.type === 'auto' ? ' (curve it for a fillet, keep it straight for a chamfer)' : ''} · tap edges or faces to add · tap empty space to finish`;
    }
    if (S.pendingBool) return `Tap the second body to ${S.pendingBool}`;
    if (S.tool === 'move') {
      if (MV && MV.drag) return MV.mode === 'rot' ? `${MV.value}°${MV.invalid ? ' · not valid here' : ''} · release to set` : `${fmtDim(MV.mode === 'plane' ? Math.hypot(MV.du, MV.dv) : Math.abs(MV.value))}${MV.invalid ? ' · not valid here' : ''} · release to set`;
      if (!b) return 'Move/Rotate · tap a body to select it · drag empty space to orbit';
      if (S.moveGizmoEdit || GZR) return 'Move gizmo · drag its centre (snaps to corners, edge middles, face centres), slide it on an arrow, turn its axes with a ring · the body does not change';
      return S.moveSurf != null ? 'Face selected · arrows move it, arcs rotate it · tap the face again to go back to the whole body' : `${b.name} · arrows move, arcs rotate, centre slides · tap a face to move just that face`;
    }
    if (S.faceTool && S.selectedFace != null) return SESSION ? hint_session() : (extrudeMode() ? 'Face selected · drag the blue arrow to extrude a straight block (or set a distance and Apply)' : 'Face selected · drag the blue arrow to push or pull it (or set a distance and Apply) · Extrude face keeps the body\'s shape');
    if (S.tool === 'select' && S.selectedFace != null) return 'Curved face selected · Move/Rotate can move or turn it · tap elsewhere to deselect';
    if (scActive()) return SC.drag === 'pivot' ? 'Move the pivot · it snaps to corners, edge middles and face centres' : SC.drag ? `${fmtFactor(scDragFactor())} · release to set` : (SC.mode === 'uniform' ? 'Scale · drag the knob to scale evenly · drag the green pivot to scale about another point' : 'Scale · knobs: one axis · plates: two axes · drag the green pivot to scale about another point');
    if (S.tool === 'select') return b ? (C.booleans ? `${b.name}${xValid(b) ? ' (exact)' : ''} selected · tap a face to push/pull · drag to move` : `${b.name} selected · drag to move`) : 'Tap a body to select · drag to orbit · pinch to zoom';
    if (['box', 'cylinder', 'sphere'].includes(S.tool)) return `Tap the grid to place a ${S.tool}`;
    if (S.imported) return onFace() ? 'Imported drawing on the face · Add, Cut or Extrude all' : 'Imported drawing on the ' + S.plane.name + ' plane · tap a face to move it there, or Extrude all';
    if (!S.plane) return 'Choose a sketch plane: tap Top, Front or Side at the origin (or the chips below), or tap a body face';
    const where = onFace() ? 'the face' : 'the plane'; const start = '';
    const snapNote = S.lastSnap && S.lastSnap !== 'grid' ? ` · snapped to ${S.lastSnap}` : '';
    if (SESSION && SESSION.drag) return SESSION.drag === 'draft' ? `${SESSION.draft}° · the wall rotates about the base edge: shrink or grow the top` : `${fmtDim(Math.abs(SESSION.value))} · ${SESSION.value < 0 ? (SESSION.target.hostId != null ? 'cutting into the body' : 'extruding backwards') : 'extruding'} · release, then tap elsewhere to finish`;
    if (SESSION) return 'Drag the big arrow to change the distance' + (SESSION.target.draftable && Math.abs(SESSION.value) > 1e-9 ? ' · drag the small tilted arrow on the rim to shrink or grow the top' : '') + ' · tap elsewhere to finish';
    if (S.tool === 'edit' && S.selSeg) return 'Line selected · drag it to move it · tap its length to type it · Delete line removes it';
    if (S.tool === 'edit') return S.selVertex ? 'Point selected · drag it to move it (connected lines follow) · Delete point removes its lines' : S.selRegion >= 0 ? 'Region selected · drag the blue arrow to extrude, the white arrow to taper the walls' : regionCache.length ? 'Tap a filled region to extrude it · drag any point to move it' : 'Drag any sketch point to move it · tap a region to extrude it';
    if (S.drawing) return `${S.tool === 'circle' ? 'R ' : ''}${fmtDim(Math.hypot(S.drawing.end[0] - S.drawing.start[0], S.drawing.end[1] - S.drawing.start[1]))}${snapNote} · release to place`;
    if (S.tool === 'line') {
      const regs = lineRegions().length;
      const how = S.fingerDraws ? 'Drag' : 'Tap-tap (or drag with a stylus)';
      if (!S.lineStart) return S.sketchLines.length ? `${S.sketchLines.length} line${S.sketchLines.length === 1 ? '' : 's'} · ${regs} closed region${regs === 1 ? '' : 's'} · ${how} to draw the next line · tap the length to type it` : `${how} on ${where} to draw a line · snaps to endpoints, midpoints, intersections`;
      return `Tap the next point${snapNote} · tap the start point to finish`;
    }
    if (S.tool === 'polyline') return S.sketchClosed ? (onFace() ? 'Profile closed · Add, Cut or New body' : 'Profile closed · Extrude or Revolve') : !S.sketch.length ? `${S.fingerDraws ? 'Drag or tap' : 'Tap'} on ${where} to start a polyline${start}` : S.sketch.length < 3 ? `${S.sketch.length} point(s)${snapNote} · keep going · tap the length to type it` : `${S.sketch.length} points${snapNote} · tap the first point to close · tap the length to type it`;
    if (S.tool === 'polygon') return S.sketchClosed ? `Polygon · ${S.polygon ? S.polygon.n : S.polySides || 6} sides · tap the size to type the distance across flats · Extrude or Revolve` : !S.sketch.length ? `${S.fingerDraws ? 'Drag from the centre to a corner' : 'Tap the centre'} on ${where}${start} · ${S.polySides || 6} sides` : 'Tap a corner of the polygon';
    if (S.tool === 'rect') return S.sketchClosed ? (onFace() ? 'Rectangle ready · Add, Cut or New body' : 'Rectangle ready · Extrude or Revolve') : !S.sketch.length ? `Tap the first corner on ${where}${start}` : 'Tap the opposite corner';
    return S.sketchClosed ? (onFace() ? 'Circle ready · tap R to type the radius · Add, Cut or New body' : 'Circle ready · tap R to type the radius · Extrude') : !S.sketch.length ? `${S.fingerDraws ? 'Drag from the centre' : 'Tap the centre'} on ${where}${start}` : 'Tap a point on the circle';
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const chip = (label, on, sel = false) => { const c = el('button', 'chip' + (sel ? ' sel' : ''), label); c.onclick = on; return c; };
  const sliderRange = new Map();   // a range widened by a typed value stays widened while the panel is rebuilt during a drag
  const slider = (label, min, max, step, get, set) => {
    const wrap = el('div', 'slider');
    const lab = el('div', 'lab'); const name = el('span', null, label + ': '); const val = el('button', 'val', fmt(get())); lab.append(name, val);
    const inp = el('input'); inp.type = 'range'; inp.min = min; inp.max = sliderRange.has(label) ? sliderRange.get(label) : max; inp.step = step;   // a typed top (bigger or smaller than the default) stays the top
    // a typed value becomes the top of the slider: the thumb sits at the right end and a drag slides down from it
    const fit = v => { if (!isFinite(v)) return; if (v > parseFloat(inp.max)) { inp.max = v; sliderRange.set(label, v); } if (v < parseFloat(inp.min)) inp.min = v; };
    const typed = v => { if (!isFinite(v) || v <= parseFloat(inp.min)) { fit(v); return; } inp.max = v; sliderRange.set(label, v); };
    fit(get()); inp.value = get();
    inp.oninput = () => { set(parseFloat(inp.value)); val.textContent = fmt(get()); };
    // Tap the value to type an exact number (Shapr3D-style dimension label)
    val.onclick = () => {
      const num = el('input', 'num'); num.type = 'number'; num.step = 'any'; num.value = get(); num.inputMode = 'decimal';
      const done = () => { const v = parseFloat(num.value); if (!isNaN(v)) { set(v); typed(get()); inp.value = get(); } val.textContent = fmt(get()); num.replaceWith(val); };
      num.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); num.blur(); } if (e.key === 'Escape') { num.value = get(); num.blur(); } };
      num.onblur = done; val.replaceWith(num); num.focus(); num.select();
    };
    wrap.append(lab, inp); return wrap;
  };
  const fmt = v => (Math.round(v * 100) / 100).toString();
  let panelOpen = (() => { try { return localStorage.getItem('ss.panelOpen') === '1'; } catch (e) { return false; } })();
  // Drop-down tool panel. Folded (the default), it shows a slim handle bar holding the hint, the panel's first row when that
  // row has buttons (the mode and selection controls: Uniform / Non-uniform, Whole body ...) and its action row (the last row
  // with buttons: Apply / Cancel, Done ...); opened, everything. The handle has a row of its own, so it
  // never lies on top of another control. The choice is remembered.
  { const st = document.createElement('style'); st.textContent = `#panel .pc-hide { display: none !important; }
      #panel-more { align-self: stretch; display: flex; align-items: center; justify-content: center; gap: 8px; border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 12px; font-weight: 600; padding: 0 0 2px; margin: -6px 0 -2px; min-height: 22px; cursor: pointer; }
      #panel-more::before { content: ''; width: 36px; height: 4px; border-radius: 2px; background: var(--border); }
      #panel-more span { color: var(--accent); flex: none; } #panel-more em { font-style: normal; min-width: 0; flex: 1; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--fg); opacity: .75; font-weight: 500; }
      #panel-more.folded::before { display: none; } #hint.pc-gone { display: none !important; }`; document.head.appendChild(st); }
  function foldPanel() {
    const old = document.getElementById('panel-more'); if (old) old.remove();
    const kids = [...panelEl.children]; for (const k of kids) k.classList.remove('pc-hide');
    // the action row: the last row that holds buttons (a closing note after it does not count)
    let act = -1; for (let i = kids.length - 1; i >= 0; i--) if (kids[i].querySelector && kids[i].querySelector('.chip')) { act = i; break; }
    const foldable = !panelEl.hidden && kids.length > 2 && act >= 0; hintEl.classList.toggle('pc-gone', foldable && !panelOpen);   // folded: the hint moves into the handle bar
    if (!foldable) return;
    const btn = document.createElement('button'); btn.id = 'panel-more'; btn.title = panelOpen ? 'Fold the options away' : 'Show all options';
    btn.className = panelOpen ? '' : 'folded'; btn.innerHTML = panelOpen ? '<span>Less ▴</span>' : '<em></em><span>More ▾</span>'; if (!panelOpen) btn.querySelector('em').textContent = hintEl.textContent;
    btn.onclick = () => { panelOpen = !panelOpen; try { localStorage.setItem('ss.panelOpen', panelOpen ? '1' : '0'); } catch (e) { /* private mode */ } foldPanel(); requestRender(); };
    panelEl.prepend(btn);
    const first = kids.findIndex(k => k.querySelector && k.querySelector('.chip'));   // the first row with buttons stays too
    if (!panelOpen) kids.forEach((k, i) => { if (i !== act && i !== first && !k.classList.contains('pc-keep')) k.classList.add('pc-hide'); });   // (an error note always stays)
  }
  function renderUI() { renderUIInner(); try { xtPanel(); } catch (e) { console.warn(e); } if (S.selCentre && isSketchTool(S.tool)) circlePanel(); if (TR) trPanel(); foldPanel(); }
  function renderUIInner() {
    hintEl.textContent = hint(); countEl.textContent = `${S.bodies.length} ${S.bodies.length === 1 ? 'body' : 'bodies'}`;
    $('undo').disabled = !H.past.length; $('redo').disabled = !redoable(); $('del').disabled = !selected();
    toolsEl.replaceChildren(...TOOLS.map(([id, label]) => chip(label, () => setTool(id), S.tool === id)), chip('Grid snap', () => { S.snap = !S.snap; renderUI(); }, S.snap));
    if (isSketchTool(S.tool)) toolsEl.append(chip(S.fingerDraws ? 'Finger: draw' : 'Finger: orbit', () => { S.fingerDraws = !S.fingerDraws; renderUI(); toast(S.fingerDraws ? 'One finger draws · two fingers pan and zoom' : 'One finger orbits · tap to place points'); }, S.fingerDraws));
    panelEl.replaceChildren(); panelEl.hidden = true;
    const b = selected();
    const sketching = isSketchTool(S.tool);
    if (S.imported) {
      const im = S.imported; panelEl.hidden = false;
      const b = im.bounds; const size = Math.max(b.w, b.h) * im.scale;
      panelEl.append(el('div', 'note', `${im.name}: ${im.closed.length} closed shape${im.closed.length === 1 ? '' : 's'}, ${im.open.length} open · file units: ${im.unitName} · drawing spans ${fmt(b.w)} × ${fmt(b.h)}${im.skipped ? ` · ${im.skipped} unsupported entit${im.skipped === 1 ? 'y' : 'ies'} skipped` : ''}`));
      panelEl.append(slider(`Scale (result ≈ ${fmt(size)} grid units wide)`, 0.01, 5, 0.01, () => im.scale, v => { im.scale = v; syncSketch(); requestRender(); }));
      const presets = el('div', 'row scroll');
      presets.append(chip('Fit to 20', () => { im.scale = 20 / (Math.max(b.w, b.h) || 1); renderUI(); syncSketch(); requestRender(); }), chip('1 : 1', () => { im.scale = 1; renderUI(); syncSketch(); requestRender(); }), chip('mm → cm (0.1)', () => { im.scale = 0.1; renderUI(); syncSketch(); requestRender(); }), chip(im.center ? 'Centred' : 'Original position', () => { im.center = !im.center; renderUI(); syncSketch(); requestRender(); }, im.center));
      panelEl.append(presets);
      panelEl.append(el('div', 'note', 'Sketch plane: ' + planeLabel() + (onFace() ? '' : ' — tap a body face to import onto it instead')));
      panelEl.append(slider('Extrude height', 0.25, 20, 0.25, () => im.height, v => { im.height = v; }));
      const row = el('div', 'row scroll');
      if (onFace() && C.booleans) row.append(chip('Add to body', () => importExtrude('join'), true), chip('Cut into body', () => importExtrude('cut')));
      row.append(chip('Extrude all', () => importExtrude('new'), !(onFace() && C.booleans)), chip('Use as sketch', importUseAsSketch), chip('Cancel', cancelImport));
      panelEl.append(row);
    } else if (sketching && !S.plane) {
      panelEl.hidden = false;
      panelEl.append(el('div', 'note', 'Choose the sketch plane. The grid moves onto it; extrusions go perpendicular to it.'));
      const row = el('div', 'row scroll');
      row.append(chip('Top (horizontal)', () => setPrincipalPlane('top')), chip('Front (elevation)', () => setPrincipalPlane('front')), chip('Side (elevation)', () => setPrincipalPlane('side')));
      panelEl.append(row, el('div', 'note', S.bodies.length ? 'Or tap any face of a body to sketch on that face.' : 'You can also sketch on any face of a body once you have one.'));
    } else if (S.tool === 'edit' && S.plane) {
      panelEl.hidden = false;
      const planeRow = el('div', 'row scroll'); planeRow.append(el('span', 'note', 'Sketch plane: ' + planeLabel()), chip('View plane', lookAtPlane), chip('Change plane', changePlane), chip('Image', pickImage), chip('Offset plane', () => { const f = plane(); startOffsetPlane({ origin: f.origin.slice(), u: f.u, v: f.v, n: f.n }, 10); })); panelEl.append(planeRow);
      if (S.selVertex) { const row = el('div', 'row scroll'); row.append(chip('Delete point', deleteSelectedVertex), chip('Deselect', () => { S.selVertex = null; syncScene(); })); panelEl.append(row); }
      else if (S.selHole) { const row = el('div', 'row scroll'); row.append(el('span', 'note', 'Inner shape'), chip('Delete shape', deleteSelectedShape), chip('Deselect', () => { S.selHole = null; syncScene(); })); panelEl.append(row); }
      else if (S.selSeg) { const row = el('div', 'row scroll'); row.append(chip('Make path', makePathFromSketch), chip('Delete line', deleteSelectedLine), chip('Deselect', () => { S.selSeg = null; syncScene(); })); panelEl.append(row, el('div', 'note', 'Drag the line to move it: a rectangle side slides straight out or in and the rectangle stays a rectangle; on a polyline the joined lines follow. Tap its length (underlined) to type it.')); }
      else if (S.selRegion >= 0 && regionCache.length) {
        panelEl.append(slider(onFace() ? 'Extrude distance' : 'Extrude height', 0.5, 20, 0.5, () => S.height, v => { S.height = v; }));
        const row = el('div', 'row scroll');
        const one = () => [regionCache[S.selRegion]];
        if (onFace() && C.booleans) row.append(chip('Add', doneToSelect(() => extrudeRegionsAction(one(), 'join')), true), chip('Cut', doneToSelect(() => extrudeRegionsAction(one(), 'cut'))), chip('New body', doneToSelect(() => extrudeRegionsAction(one(), 'new'))));
        else row.append(chip('Extrude', doneToSelect(() => extrudeRegionsAction(one(), 'new')), true), dirChip());
        row.append(chip('Make profile', makeProfileFromSketch), chip('Delete shape', deleteSelectedShape));
        panelEl.append(row, el('div', 'note', 'Or drag the blue arrow on the region to extrude live; the white arrow tapers the walls (draft angle). Tap a single line to delete just that line.'));
      } else panelEl.append(el('div', 'note', regionCache.length ? `${regionCache.length} closed region${regionCache.length === 1 ? '' : 's'} — tap one to extrude it. Drag any point to move it; connected lines follow.` : 'Drag any sketch point to move it. Close a shape with Line or Polyline to get a region you can extrude.'));
      if (S.sketchLines.length || S.sketch.length) { const row2 = el('div', 'row scroll'); row2.append(chip('Clear sketch', () => { clearLines(); clearSketch(); })); panelEl.append(row2); }
    } else if (FE) {
      panelEl.hidden = false; const f = S.feats[FE.i]; const p = FE.p;
      panelEl.append(el('div', 'note', `Edit ${f.name} · change it, then Rebuild — every later step is replayed`));
      if (f.kind === 'shell') panelEl.append(slider('Wall thickness', 0.05, 5, 0.05, () => p.t, v => { p.t = Math.max(0.05, v); }));
      if (f.kind === 'offsetFace') panelEl.append(slider('Distance', -10, 10, 0.05, () => p.d, v => { p.d = v; }));
      if (f.kind === 'fillet') panelEl.append(slider(p.opts.type === 'chamfer' ? 'Distance' : 'Radius', 0.02, 10, 0.02, () => p.opts.r, v => { p.opts.r = Math.max(0.02, v); }));
      if (f.kind === 'xf' && p.kind === 'pattern') { panelEl.append(slider('Count', 2, 20, 1, () => p.count, v => { p.count = Math.max(2, Math.round(v)); })); panelEl.append(slider('Spacing', 0.1, 50, 0.1, () => p.gap, v => { p.gap = v; })); }
      if (f.kind === 'xf' && p.kind === 'rotate') panelEl.append(slider('Angle °', -180, 180, 5, () => p.angle, v => { p.angle = v; }));
      if (f.kind === 'xf' && p.kind === 'split') panelEl.append(slider('Position %', 1, 99, 1, () => Math.round(p.at * 100), v => { p.at = Math.min(0.99, Math.max(0.01, v / 100)); }));
      if (f.kind === 'material') { const mr = el('div', 'row scroll'); mr.append(chip('Default', () => { p.key = null; renderUI(); }, !p.key)); for (const k in MATS) mr.append(chip(MATS[k].name, () => { p.key = k; renderUI(); }, p.key === k)); panelEl.append(mr); }
      const row = el('div', 'row scroll'); row.append(chip('Rebuild', feRebuild, true), chip('Cancel', () => { FE = null; renderUI(); })); panelEl.append(row);
    } else if (MT) {
      panelEl.hidden = false; const bm = S.bodies.find(x => x.id === MT.id);
      panelEl.append(el('div', 'note', 'Material · ' + (bm ? bm.name : '') + ' — metals reflect a soft studio, like a render'));
      const row = el('div', 'row scroll'); row.append(chip('Default', () => setMaterial(null), !(bm && bm.material))); for (const k in MATS) row.append(chip(MATS[k].name, () => setMaterial(k), bm && bm.material === k)); panelEl.append(row);
      const row2 = el('div', 'row scroll'); row2.append(chip('Done', () => { MT = null; renderUI(); }, true)); panelEl.append(row2);
    } else if (IMG) {
      panelEl.hidden = false;
      panelEl.append(el('div', 'note', 'Reference image · trace over it with the sketch tools'));
      panelEl.append(slider('Size', 0.5, 100, 0.1, () => IMG.size, v => { IMG.size = v; refPlace(IMG); }));
      panelEl.append(slider('Move across', -100, 100, 0.1, () => IMG.du, v => { IMG.du = v; refPlace(IMG); }));
      panelEl.append(slider('Move up', -100, 100, 0.1, () => IMG.dv, v => { IMG.dv = v; refPlace(IMG); }));
      panelEl.append(slider('Opacity', 0.05, 1, 0.05, () => IMG.opacity, v => { IMG.opacity = v; refPlace(IMG); }));
      const row = el('div', 'row scroll'); row.append(chip('Done', () => { IMG = null; renderUI(); }, true), chip('Remove image', () => { const i = refImgs.indexOf(IMG); if (i >= 0) refImgs.splice(i, 1); scene.remove(IMG.mesh); IMG.mesh.geometry.dispose(); IMG.mesh.material.map.dispose(); IMG.mesh.material.dispose(); IMG = null; renderUI(); requestRender(); }), chip(refImgs.length > 1 ? 'Hide images' : 'Hide image', () => { for (const r of refImgs) r.mesh.visible = !r.mesh.visible; requestRender(); })); panelEl.append(row);
    } else if (OP) {
      panelEl.hidden = false;
      panelEl.append(el('div', 'note', 'Offset plane · a new sketch plane parallel to the face or plane — set the distance, then Sketch'));
      panelEl.append(slider('Distance', -50, 50, 0.1, () => OP.d, v => { OP.d = v; opPreview(); }));
      const row = el('div', 'row scroll'); row.append(chip('Sketch', opSketch, true), chip('Cancel', opCancel)); panelEl.append(row);
    } else if (SCF) {
      panelEl.hidden = false;
      panelEl.append(el('div', 'note', 'Scale face · ' + (SCF.uniform ? 'uniform' : 'non-uniform') + ' — the green preview shows the body with the face scaled about its centre'));
      const mr = el('div', 'row scroll'); mr.append(chip('Uniform', () => { SCF.uniform = true; scPreview(); renderUI(); }, SCF.uniform)); if (SCF.hole || SCF.wall || (!SCF.cyl && !SCF.curved)) mr.append(chip('Non-uniform', () => { SCF.uniform = false; scPreview(); renderUI(); }, !SCF.uniform)); panelEl.append(mr);
      if (SCF.wall) panelEl.append(keepRow(el('div', 'note', SCF.uniform ? 'Uniform · drag any handle of the gizmo to change the wall\'s radius' : 'Non-uniform · drag an axis handle (one direction across the wall) or the square between them; the ends stay where they are')));
      else if (SCF.hole) panelEl.append(keepRow(el('div', 'note', SCF.uniform ? 'Uniform · drag any handle of the gizmo to scale the hole evenly' : 'Non-uniform · drag an axis handle (one direction) or a square (two directions); the centre scales evenly')));   // no sliders for a hole: the gizmo does it
      else if (false) { panelEl.append(keepRow(slider('Across X %', 10, 300, 1, () => Math.round(SCF.sx * 100), v => { SCF.sx = v / 100; scPreview(); }))); panelEl.append(keepRow(slider('Across Y %', 10, 300, 1, () => Math.round(SCF.sy * 100), v => { SCF.sy = v / 100; scPreview(); }))); panelEl.append(keepRow(slider('Along axis %', 10, 300, 1, () => Math.round((SCF.sz || 1) * 100), v => { SCF.sz = v / 100; scPreview(); }))); }
      else if (SCF.uniform || SCF.cyl || SCF.curved) panelEl.append(keepRow(slider('Scale %', 10, 300, 1, () => Math.round(SCF.sx * 100), v => { SCF.sx = v / 100; scPreview(); })));
      else { panelEl.append(keepRow(slider('Scale X %', 10, 300, 1, () => Math.round(SCF.sx * 100), v => { SCF.sx = v / 100; scPreview(); }))); panelEl.append(keepRow(slider('Scale Y %', 10, 300, 1, () => Math.round(SCF.sy * 100), v => { SCF.sy = v / 100; scPreview(); }))); }
      const row = el('div', 'row scroll'); row.append(chip('Apply', scApply, true), chip('Cancel', scCancel)); panelEl.append(row);
    } else if (OF) {
      panelEl.hidden = false;
      panelEl.append(el('div', 'note', `Offset Face · ${OF.faces.length} face${OF.faces.length > 1 ? 's' : ''} · tap faces of the body to add or remove them`));
      panelEl.append(slider('Distance', -10, 10, 0.05, () => OF.d, v => { OF.d = v; ofPreview(); }));
      const row = el('div', 'row scroll'); row.append(chip('Apply', ofApply, true), chip('Cancel', ofCancel)); panelEl.append(row);
    } else if (OE) {
      panelEl.hidden = false;
      panelEl.append(el('div', 'note', 'Offset Edge · the green outline is the offset — negative goes inside, positive outside'));
      panelEl.append(slider('Distance', -10, 10, 0.05, () => OE.d, v => { OE.d = v; oePreview(); }));
      const row = el('div', 'row scroll'); row.append(chip('Apply', oeApply, true), chip('Cancel', oeCancel)); panelEl.append(row);
    } else if (XF) {
      panelEl.hidden = false; const m = xfBody() && xfBody().man;
      panelEl.append(el('div', 'note', XF.kind === 'pattern' ? 'Linear pattern · copies in a row along an axis — set the count and spacing, then Apply' : XF.kind === 'rotate' ? 'Rotate around axis · turns the body about an axis through its centre' : 'Split body · cuts it in two with a plane across the chosen axis'));
      const axRow = el('div', 'row scroll'); AX.forEach((n, i) => axRow.append(chip((XF.kind === 'split' ? 'Across ' : 'Axis ') + n, () => { XF.axis = i; if (XF.kind === 'pattern' && m) XF.gap = +(xfSize(m, i) * 1.25).toFixed(2); xfPreview(); renderUI(); }, XF.axis === i))); panelEl.append(axRow);
      if (XF.kind === 'pattern') { panelEl.append(slider('Count', 2, 20, 1, () => XF.count, v => { XF.count = Math.max(2, Math.round(v)); xfPreview(); })); panelEl.append(slider('Spacing', 0.1, 50, 0.1, () => XF.gap, v => { XF.gap = v; xfPreview(); })); }
      if (XF.kind === 'rotate') panelEl.append(slider('Angle °', -180, 180, 5, () => XF.angle, v => { XF.angle = v; xfPreview(); }));
      if (XF.kind === 'split') panelEl.append(slider('Position %', 1, 99, 1, () => Math.round(XF.at * 100), v => { XF.at = Math.min(0.99, Math.max(0.01, v / 100)); xfPreview(); }));
      const row = el('div', 'row scroll'); row.append(chip('Apply', xfApply, true), chip('Cancel', xfCancel)); panelEl.append(row);
    } else if (SY) {
      panelEl.hidden = false;
      panelEl.append(el('div', 'note', SY.axis ? 'Symmetry · tap each line to mirror across the orange line, or Mirror all' : 'Symmetry · tap the line to mirror across (a construction line works)'));
      const row = el('div', 'row scroll'); if (SY.axis) row.append(chip('Mirror all', () => mirrorLines(S.sketchLines.slice())), chip('Other line', () => { SY.axis = null; S.selSeg = null; syncScene(); renderUI(); })); row.append(chip('Done', endSymmetry, true)); panelEl.append(row);
    } else if (TM || AR) {
      panelEl.hidden = false;
      panelEl.append(el('div', 'note', TM ? 'Trim · tap the piece of a line to cut away — it is cut back to the nearest crossing' : `Arc · tap the start, the end, then a point on the curve (${AR.pts.length} of 3)`));
      const row = el('div', 'row scroll'); row.append(chip('Done', endModes, true)); panelEl.append(row);
    } else if (MS) {
      panelEl.hidden = false;
      panelEl.append(el('div', 'note', 'Move/Rotate sketch · the whole drawing moves with its plane — along X, Y, Z, or turned about them'));
      panelEl.append(slider('Move X', -20, 20, 0.1, () => MS.dx, v => { MS.dx = v; msPreview(); })); panelEl.append(slider('Move Y', -20, 20, 0.1, () => MS.dy, v => { MS.dy = v; msPreview(); })); panelEl.append(slider('Move Z', -20, 20, 0.1, () => MS.dz, v => { MS.dz = v; msPreview(); }));
      panelEl.append(slider('Rotate X °', -180, 180, 5, () => MS.rx, v => { MS.rx = v; msPreview(); })); panelEl.append(slider('Rotate Y °', -180, 180, 5, () => MS.ry, v => { MS.ry = v; msPreview(); })); panelEl.append(slider('Rotate Z °', -180, 180, 5, () => MS.rz, v => { MS.rz = v; msPreview(); }));
      const row = el('div', 'row scroll'); row.append(chip('Apply', msApply, true), chip('Cancel', msCancel)); panelEl.append(row);
    } else if (RV) {
      panelEl.hidden = false;
      panelEl.append(el('div', 'note', RV.axis ? 'Revolve · 1 region & 1 line · set the angle, then Done' : 'Revolve · tap the line to turn the shape around (an edge of the shape works too), or use the vertical axis'));
      panelEl.append(slider('Angle °', 10, 360, 5, () => RV.angle, v => { RV.angle = Math.abs(v) < 0.01 ? 360 : Math.max(-360000, Math.min(360000, v)); rvPreview(); }));
      panelEl.append(slider('Height', 0, 20, 0.05, () => RV.height || 0, v => { RV.height = isFinite(v) ? v : 0; rvPreview(); }));
      { const hn = el('div', 'note'); hn.id = 'rv-helix-note'; hn.textContent = rvHelixNote(); panelEl.append(hn); }
      const row = el('div', 'row scroll');
      if (RV.axis) row.append(chip('Done', revolveDone, true), chip('Cancel', revolveCancel));
      else row.append(chip('Vertical axis', () => revolveAboutLine([[0, 0], [0, 1]])), chip('Cancel', revolveCancel));
      panelEl.append(row);
    } else if (S.tool === 'select' && S.plane && S.selRegion >= 0 && regionCache[S.selRegion] && S.selectedId == null) {
      panelEl.hidden = false; const reg = regionCache[S.selRegion];
      panelEl.append(el('div', 'note', RVLINE ? '1 region & 1 line selected · tap Revolve to turn the region around the line' : 'Sketch region selected · Extrude it, or tap a line to use as the revolve axis'));
      const row = el('div', 'row scroll');
      const oeChip = chip('Offset Edge', () => startOffsetEdge([reg.outer, ...(reg.holes || [])]));
      const mvChip = chip('Move/Rotate', () => setTool('move'));
      const editChip = chip('Sketch', () => { setTool('edit'); toast('Editing the sketch · drag a line or corner, tap a length to type it'); });
      if (RVLINE) row.append(chip('Revolve', () => revolveAboutLine(RVLINE, [reg]), true), chip('Extrude', () => { extrudeRegionsAction([reg], 'new'); S.selRegion = -1; RVLINE = null; rvLineSync(); }), chip('Deselect line', () => { RVLINE = null; rvLineSync(); renderUI(); }));
      else row.append(chip('Extrude', () => { extrudeRegionsAction([reg], 'new'); S.selRegion = -1; }, true), dirChip(), chip('Revolve', () => startRevolvePick([reg])), mvChip, oeChip, editChip, chip('Deselect', () => { S.selRegion = -1; syncScene(); renderUI(); }));
      if (RVLINE) row.append(editChip);
      panelEl.append(row);
    } else if (S.tool === 'line' && (S.sketchLines.length || S.lineStart || S.plane)) {
      panelEl.hidden = false;
      const planeRow = el('div', 'row scroll'); planeRow.append(el('span', 'note', 'Sketch plane: ' + planeLabel()), chip('View plane', lookAtPlane), chip('Change plane', changePlane), chip('Image', pickImage), chip('Offset plane', () => { const f = plane(); startOffsetPlane({ origin: f.origin.slice(), u: f.u, v: f.v, n: f.n }, 10); })); panelEl.append(planeRow);
      const regs = lineRegions();
      if (regs.length) {
        panelEl.append(slider(onFace() ? 'Extrude distance' : 'Extrude height', 0.5, 20, 0.5, () => S.height, v => { S.height = v; }));
        const row = el('div', 'row scroll');
        if (onFace() && C.booleans) row.append(chip('Add', doneToSelect(() => extrudeLineRegions('join')), true), chip('Cut', doneToSelect(() => extrudeLineRegions('cut'))), chip('New body', doneToSelect(() => extrudeLineRegions('new'))));
        else row.append(chip('Extrude', doneToSelect(() => extrudeLineRegions('new')), true), dirChip(), chip('Revolve', startRevolvePick));
        panelEl.append(row);
        panelEl.append(el('div', 'note', `${regs.length} closed region${regs.length === 1 ? '' : 's'} found — lines that cross, meet, or run edge to edge across the face split it into regions automatically.`));
      }
      const row2 = el('div', 'row scroll');
      if (S.lineStart) row2.append(chip('Finish line', finishLine, true));
      if (S.sketchLines.length || S.lineStart) row2.append(chip('Undo line', undoLine), chip('Clear lines', clearLines));
      row2.append(chip('Arc', startArc)); if (S.sketchLines.length) row2.append(chip('Trim', startTrim), chip('Symmetry', startSymmetry));
      row2.append(chip(S.typeLines ? 'Hide numbers' : 'Type numbers', () => { S.typeLines = !S.typeLines; renderUI(); }));
      panelEl.append(row2);
      if (S.typeLines) {
        panelEl.append(slider('Start X', -50, 50, 0.01, () => S.tyX || 0, v => { S.tyX = v; }), slider('Start Y', -50, 50, 0.01, () => S.tyY || 0, v => { S.tyY = v; }));
        const r3 = el('div', 'row scroll'); r3.append(chip('Start here', typedStart)); panelEl.append(r3);
        panelEl.append(slider('Length', 0, 20, 0.01, () => S.tyLen || 0, v => { S.tyLen = v; }), slider('Angle °', -360, 360, 1, () => S.tyAng || 0, v => { S.tyAng = v; }));
        const r4 = el('div', 'row scroll'); r4.append(chip('Add line', typedLine, true)); panelEl.append(r4, el('div', 'note', 'Angle 0° points along the plane\'s first axis, 90° along its second; each line starts where the last one ended.'));
      }
    } else if (sketching && (S.sketch.length || S.plane)) {
      panelEl.hidden = false;
      const planeRow = el('div', 'row scroll');
      planeRow.append(el('span', 'note', 'Sketch plane: ' + planeLabel()), chip('View plane', lookAtPlane), chip('Change plane', changePlane), chip('Image', pickImage), chip('Offset plane', () => { const f = plane(); startOffsetPlane({ origin: f.origin.slice(), u: f.u, v: f.v, n: f.n }, 10); }));
      panelEl.append(planeRow);
      if (S.tool === 'polygon') { const row = el('div', 'row scroll'); row.append(el('span', 'note', 'Sides'));
        for (const n of [3, 4, 5, 6, 8, 10, 12]) row.append(chip(String(n), () => { S.polySides = n; if (S.polygon && S.sketchClosed) setPolygon({ ...S.polygon, n }, 'Polygon sides'); renderUI(); }, (S.polySides || 6) === n));
        panelEl.append(row);
        if (S.polygon && S.sketchClosed) panelEl.append(slider('Across flats', 0.5, 50, 0.1, () => S.polygon.af, v => { if (v > 0) { S.polygon = { ...S.polygon, af: v }; S.sketch = polyPts(S.polygon); syncScene(); } })); }
      if (S.sketchClosed) {
        panelEl.append(slider(onFace() ? 'Extrude distance' : 'Extrude height', 0.5, 20, 0.5, () => S.height, v => { S.height = v; }));
        const row = el('div', 'row scroll');
        if (onFace()) {
          if (C.booleans) row.append(chip('Add', doneToSelect(() => extrudeSketch('join')), true), chip('Cut', doneToSelect(() => extrudeSketch('cut'))));
          row.append(chip('New body', doneToSelect(() => extrudeSketch('new')), !C.booleans), chip('Undo point', undoPoint), chip('Cancel', clearSketch));
          panelEl.append(row, el('div', 'note', C.booleans ? 'Add grows the body outward from the face; Cut removes material into it.' : 'Add and Cut need the boolean engine; New body still works.'));
        } else {
          row.append(chip('Extrude', doneToSelect(() => extrudeSketch('new')), true), dirChip(), chip('Revolve', revolveSketch), chip('Make profile', makeProfileFromSketch), chip('Undo point', undoPoint), chip('Cancel', clearSketch));
          panelEl.append(row, el('div', 'note', 'Extrude goes perpendicular to the plane (flip the direction if needed). Revolve spins the profile around the plane\'s vertical axis; draw it to the right of that axis.'));
        }
      } else if (S.sketch.length) {
        const row = el('div', 'row');
        if (S.tool === 'polyline' && S.sketch.length >= 3) row.append(chip('Close profile', () => step(() => { S.sketchClosed = true; syncScene(); }), true));
        if (!S.sketchClosed && S.sketch.length >= 2) row.append(chip('Make path', makePathFromSketch));
        row.append(chip('Undo point', undoPoint), chip('Cancel', clearSketch)); panelEl.append(row);
      } else if (S.selRegion >= 0 && regionCache[S.selRegion]) {
        // a shape of lines is selected (just reshaped, or tapped): the same actions as in Edit sketch
        panelEl.append(slider(onFace() ? 'Extrude distance' : 'Extrude height', 0.5, 20, 0.5, () => S.height, v => { S.height = v; }));
        const row = el('div', 'row scroll'); const one = () => [regionCache[S.selRegion]];
        if (onFace() && C.booleans) row.append(chip('Add', doneToSelect(() => extrudeRegionsAction(one(), 'join')), true), chip('Cut', doneToSelect(() => extrudeRegionsAction(one(), 'cut'))), chip('New body', doneToSelect(() => extrudeRegionsAction(one(), 'new'))));
        else row.append(chip('Extrude', doneToSelect(() => extrudeRegionsAction(one(), 'new')), true), dirChip());
        row.append(chip('Make profile', makeProfileFromSketch), chip('Delete shape', deleteSelectedShape)); panelEl.append(row);
      }
    } else if (S.tool === 'move') {
      panelEl.hidden = false;
      const mprof = moveProfile(); const mt = moveTargetBase();
      if (!b && !mprof && mt && mt.kind === 'scircle') panelEl.append(el('div', 'note', 'Moving the circle · drag the centre or an arrow to slide it across its sketch plane — its centre snaps to circle and face centres (orange dot) · tap empty space to finish'));
      else if (!b && !mprof && mt && mt.kind === 'sketch') panelEl.append(el('div', 'note', 'Moving the sketch · drag an arrow to slide it along its plane or lift it, drag a ring to turn or tilt it (tap the value to type it) · tap empty space to finish'));
      else if (!b && !mprof) panelEl.append(el('div', 'note', 'Tap a body to move or rotate it. Tap it again to pick one face: the gizmo then moves just that face and the neighbouring faces stretch to follow. Tap a profile to move, turn or copy it.'));
      else {
        const face = b && S.moveSurf != null && b.md.surfs ? b.md.surfs[S.moveSurf] : null;
        const row = el('div', 'row scroll');
        row.append(el('span', 'note', mprof ? `${mprof.name} (profile)` : face ? `Face of ${b.name}${face.planar ? '' : ' (curved)'}` : `${b.name}${xValid(b) ? ' · exact' : ''} · whole body`));
        if (face) row.append(chip('Whole body', () => { if (MV) endMove(); S.moveSurf = null; syncScene(); }));
        else row.append(chip('Copy', () => { if (MV) endMove(); S.moveCopy = !S.moveCopy; renderUI(); toast(S.moveCopy ? 'Copy on: the original stays, a copy moves' : 'Copy off'); }, S.moveCopy));
        if (mprof) row.append(chip('Delete', deleteSelectedProfiles)); else if (!face) row.append(chip('Translate', () => startTranslate(b)), chip('Delete', deleteSelected));
        if (b) row.append(chip('Zoom to', () => zoomTo(b)));
        panelEl.append(row);
        const axisRow = el('div', 'row scroll'); const names = face ? ['Along', 'Across', 'Normal'] : ['X', 'Y', 'Z'];
        axisRow.append(el('span', 'note', 'Type a value · axis:'));
        for (let k = 0; k < 3; k++) axisRow.append(chip(names[k], () => { S.moveAxis = k; renderUI(); }, S.moveAxis === k));
        const typed = el('div', 'row scroll');
        const num = el('input', 'num'); num.type = 'number'; num.step = 'any'; num.inputMode = 'decimal'; num.value = S.moveTyped; num.oninput = () => { S.moveTyped = parseFloat(num.value) || 0; }; num.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); num.blur(); } };
        typed.append(num, chip('Move ' + S.unit, () => typedMove('axis')), chip('Rotate °', () => typedMove('rot')));
        panelEl.append(axisRow, typed, el('div', 'note', 'Drag an arrow to move, an arc to rotate, the centre to slide in the plane. Values snap to 0.1 and 1° (15° steps nearby); tap the value after a drag to type it exactly.'));
      }
    } else if (S.tool === 'select' && !b && (LF || SW || S.selProfiles.length || S.selPath)) {
      panelEl.hidden = false;
      if (SW) {
        const top = el('div', 'row scroll'); top.append(el('span', 'fil-status', `Sweep · ${SW.edges} edge${SW.edges === 1 ? '' : 's'}`));
        // Sharp / Round stay in view when the panel is folded; Round picks a bend that suits the profile (2.5x its radius)
        const profR = () => { const q = profById(SW.profileId); if (!q) return 0.1; const c = q.outer.reduce((a, p) => [a[0] + p[0] / q.outer.length, a[1] + p[1] / q.outer.length], [0, 0]); return Math.max(...q.outer.map(p => Math.hypot(p[0] - c[0], p[1] - c[1]))); };
        top.append(chip('Sharp', () => { SW.round = 0; swBuild(); renderUI(); }, !(SW.round > 0)), chip('Round', () => { if (!(SW.round > 0)) SW.round = Math.max(0.1, Math.round(2.5 * profR() * 1000) / 1000); swBuild(); renderUI(); }, SW.round > 0));
        panelEl.append(top);
        panelEl.append(slider('Round corners', 0, 10, 0.1, () => SW.round, v => { SW.round = v; swBuild(); }));
        panelEl.append((() => { const d = el('div', 'note', SW.error ? SW.error : 'The profile travels along the picked edges and keeps its place relative to the path start. Round corners turns sharp corners into arcs (0 = sharp, mitred).'); if (SW.error) { d.classList.add('pc-keep'); d.style.color = 'var(--warn, #f0b35a)'; } return d; })());
        const act = el('div', 'row scroll'); const ap = chip('Apply', applySweep, true); if (!SW.solid) { ap.disabled = true; ap.classList.add('disabled'); ap.style.opacity = '0.45'; } act.append(ap, chip('Cancel', () => { swDrop(); renderUI(); })); panelEl.append(act);
      } else if (!LF && (S.selPath || S.selProfiles.length)) {
        const n = S.selProfiles.length, sp = S.selPath, k = sp ? sp.segs.length : 0; const parts = [];
        if (k) parts.push(`${k} edge${k === 1 ? '' : 's'}`); if (n) parts.push(`${n} profile${n === 1 ? '' : 's'}`);
        const top = el('div', 'row scroll'); top.append(el('span', 'fil-status', parts.join(' & ') + (k ? ` · ${(Math.round(selPathLength() * 1000) / 1000).toString()} mm` : '')));
        if (n === 1 && k) top.append(chip('Sweep', startSweep, true));
        if (n >= 2 && !k) top.append(chip('Loft', startLoft, true));
        if (k) { const q = pathById(sp.id); if (q && k < pathSegCount(q)) top.append(chip('Whole path', () => { S.selPath = { id: q.id, segs: Array.from({ length: pathSegCount(q) }, (_, i) => i) }; syncScene(); })); }
        if (n === 1 && !k) top.append(chip('Move/Rotate', () => setTool('move')), chip('Edit sketch', () => editProfile(S.selProfiles[0])));
        top.append(chip('Delete', () => { const pid = sp && sp.id; if (n) deleteSelectedProfiles(); if (pid && !n) { step(() => { S.paths = S.paths.filter(q => q.id !== pid); S.selPath = null; }, 'Delete path'); commit(); } }), chip('Deselect', () => { S.selProfiles = []; S.selPath = null; syncScene(); })); panelEl.append(top);
        panelEl.append(el('div', 'note', k && !n ? 'Tap a profile to sweep along these edges. Tap more edges of the path, or Whole path.' : n === 1 && !k ? 'Tap edges of a path to sweep this profile along them, or more profiles to loft through them (in order).' : n >= 2 ? 'The numbers show the order the loft passes through. Tap a profile again to take it out.' : 'Tap edges one after another along the path; Sweep carries the profile along them.'));
        if (n === 1 && !k) profCentreRow(profById(S.selProfiles[0]));
      } else if (LF) {
        const top = el('div', 'row scroll'); top.append(el('span', 'fil-status', `Loft · ${LF.ids.length} profiles`), chip('Smooth', () => { LF.smooth = true; lfBuild(); renderUI(); }, LF.smooth), chip('Straight', () => { LF.smooth = false; lfBuild(); renderUI(); }, !LF.smooth)); panelEl.append(top);
        panelEl.append(el('div', 'note', LF.error ? LF.error : (LF.smooth ? 'Smooth: the body passes smoothly through every profile, in the order you tapped them (numbers). The lines join matching corners.' : 'Straight: flat between neighbouring profiles, with a crease at each one.')));
        const act = el('div', 'row scroll'); act.append(chip('Apply', applyLoft, true), chip('Cancel', () => { lfDrop(); renderUI(); })); panelEl.append(act);
      } else {
        const n = S.selProfiles.length; const top = el('div', 'row scroll'); top.append(el('span', 'fil-status', `${n} profile${n === 1 ? '' : 's'}`));
        if (n >= 2) top.append(chip('Loft', startLoft, true));
        if (n === 1) top.append(chip('Move/Rotate', () => setTool('move')), chip('Edit sketch', () => editProfile(S.selProfiles[0])));
        top.append(chip('Delete', deleteSelectedProfiles), chip('Deselect', () => { S.selProfiles = []; syncScene(); })); panelEl.append(top);
        panelEl.append(el('div', 'note', n < 2 ? 'Tap more profiles, in the order the loft should pass through them, then Loft. Drag a profile by its centre point to move it: the centre snaps onto path ends, other centres and body points.' : 'The numbers show the order the loft passes through. Tap a profile again to take it out.'));
        if (n === 1) profCentreRow(profById(S.selProfiles[0]));
      }
    } else if (S.tool === 'select' && b) {
      panelEl.hidden = false;
      if (filActive()) {
        const sel = filSel(); const len = sel.reduce((a, ch) => a + ch.length, 0); const eff = filEffType();
        const top = el('div', 'row scroll'); top.append(el('span', 'fil-status', `${sel.length} edge${sel.length === 1 ? '' : 's'} · ~${fmtDim(len)}`), chip('Deselect all', () => { commitFil(); S.selectedId = null; syncScene(); }), chip(FL.showOpts ? 'Options ⌃' : 'Options ⚙', () => { FL.showOpts = !FL.showOpts; renderUI(); }));
        panelEl.append(top);
        const types = el('div', 'row scroll'); const setType = t => { FL.type = t; FL.lastKey = null; applyFil(true); if (FL && FL.invalid) filRevert(); syncScene(); };
        types.append(chip('Auto', () => setType('auto'), FL.type === 'auto'), chip('Fillet', () => setType('fillet'), FL.type === 'fillet'), chip('Chamfer', () => setType('chamfer'), FL.type === 'chamfer'), el('span', 'note', FL.type === 'auto' ? 'curved stroke = fillet · straight = chamfer' : ''));
        panelEl.append(types);
        const maxV = Math.max(2, Math.round(C.bboxDiag ? C.bboxDiag(FL.base.md.positions) : 10));
        const re = () => { FL.lastKey = null; applyFil(true); if (FL && FL.invalid) filRevert(); requestRender(); };
        panelEl.append(slider(eff === 'fillet' ? 'Radius' : FL.cham === 'equal' ? 'Distance' : 'Distance 1', 0, maxV, 0.05, () => FL.value, v => { FL.value = Math.max(0, v); re(); }));
        if (FL.showOpts) {
          const opt = el('div', 'row scroll'); const setO = (k, v) => { FL[k] = v; re(); renderUI(); };
          if (eff === 'chamfer') {
            opt.append(chip('Equal distance', () => setO('cham', 'equal'), FL.cham === 'equal'), chip('Two distances', () => setO('cham', 'two'), FL.cham === 'two'), chip('Distance + angle', () => setO('cham', 'angle'), FL.cham === 'angle'));
            panelEl.append(opt);
            if (FL.cham === 'two') panelEl.append(slider('Distance 2', 0.05, maxV, 0.05, () => FL.value2, v => { FL.value2 = Math.max(0.05, v); re(); }));
            if (FL.cham === 'angle') panelEl.append(slider('Angle °', 5, 85, 1, () => FL.angle, v => { FL.angle = Math.max(5, Math.min(85, v)); re(); }));
          } else {
            opt.append(chip('Circular', () => setO('shape', 'circular'), FL.shape === 'circular'), chip('Conic', () => setO('shape', 'conic'), FL.shape === 'conic'), el('span', 'note', 'or drag the small handle on the arc'));
            panelEl.append(opt);
            if (FL.shape === 'conic') panelEl.append(slider('Shape (rho)', 0.05, 0.95, 0.01, () => FL.rho, v => { FL.rho = Math.max(0.05, Math.min(0.95, v)); re(); }));
          }
        }
        const row = el('div', 'row scroll'); row.append(chip('Apply', () => { if (!FL.recorded || !(FL.value > 1e-9)) { toast('Set a size first: drag the arrow or type a value'); return; } const w = commitFil(); toast(w ? 'Applied · adjoining edge not blended.' : eff === 'fillet' ? 'Filleted' : 'Chamfered'); }, true), chip('Cancel', cancelFil)); panelEl.append(row);
        if (FL.warn) panelEl.append(el('div', 'note', 'Adjoining edge not blended: the fillet runs into a neighbouring edge that is not selected.'));
      } else if (SH) {
        panelEl.append(el('div', 'note', 'Shell · the tapped face is opened and the body is hollowed to the wall thickness'));
        panelEl.append(slider('Wall thickness', 0.1, 3, 0.05, () => SH.t, v => { SH.t = Math.max(0.05, v); shellPreview(); }));
        const row = el('div', 'row scroll'); row.append(chip('Apply', shellApply, true), chip('Cancel', shellCancel)); panelEl.append(row);
      } else if (S.faceTool && S.selectedFace != null) {
        const modes = el('div', 'row scroll'); modes.append(chip('Stretch body', () => setFaceOp('stretch'), !extrudeMode()), chip('Extrude face', () => setFaceOp('extrude'), extrudeMode()), el('span', 'note', extrudeMode() ? 'a straight block grows from the face (a push cuts one in); the body keeps its shape' : 'the face moves and the walls bend with it; tilting leans the walls from the base')); panelEl.append(modes);
        panelEl.append(slider(extrudeMode() ? 'Extrude distance' : 'Push/Pull distance', -8, 8, 0.25, () => S.value, v => { S.value = v; }));
        const row = el('div', 'row scroll'); row.append(chip('Apply', applyPushPull, true), chip('Move/Rotate face', () => startMoveFace(b, S.selectedFace)), chip('Shell', () => startShell(b, S.selectedFace)), chip('Offset Face', () => startOffsetFace(b, S.selectedFace)), chip('Scale face', () => startScaleFace(b, S.selectedFace)), chip('Offset plane', () => startOffsetPlaneFromFace(b, S.selectedFace)), chip('Offset Edge', () => startOffsetEdgeOnFace(b, S.selectedFace)), chip('Sketch', () => { const face = S.selectedFace; setTool('line'); setSketchPlane({ body: b, faceId: face }); renderUI(); }), chip('Cancel', () => { S.faceTool = false; S.selectedFace = null; syncScene(); })); panelEl.append(row);
      } else if (S.selectedFace != null) {
        const row = el('div', 'row scroll'); row.append(el('span', 'note', 'Curved face selected'), chip('Move/Rotate face', () => startMoveFace(b, S.selectedFace), true), chip('Scale face', () => startScaleFace(b, S.selectedFace)), chip('Offset Face', () => startOffsetFace(b, S.selectedFace)), chip('Whole body', () => { S.selectedFace = null; S.faceTool = false; syncScene(); }), chip('Deselect', () => { S.selectedId = null; S.selectedFace = null; syncScene(); })); panelEl.append(row);
        panelEl.append(el('div', 'note', 'Push/pull works on flat faces. Move/Rotate can move or turn this surface, or the whole body.'));
      } else if (scActive()) {
        const modes = el('div', 'row scroll'); modes.append(chip('Uniform', () => scSetMode('uniform'), SC.mode === 'uniform'), chip('Non-uniform', () => scSetMode('non'), SC.mode === 'non'), chip(SC.copy ? 'Copy: on' : 'Copy', () => { SC.copy = !SC.copy; renderUI(); requestRender(); }, SC.copy)); panelEl.append(modes);
        panelEl.append(el('div', 'note', SC.mode === 'uniform' ? 'Drag the knob to scale evenly about the green pivot; drag the pivot to another point of the body (it snaps to corners, edge middles and face centres). Tap the value to type it.' : 'Knobs scale along X, Y or Z; the small plates scale two axes at once. Drag the pivot to scale about another point. Tap a value to type it.'));
        const typed = el('div', 'row scroll'); const mk = (label, key) => { const inp = el('input', 'num'); inp.type = 'number'; inp.step = 'any'; inp.inputMode = 'decimal'; inp.value = '1'; inp.style.width = '64px'; inp.dataset.key = key; const w = el('span', 'note', label + ' '); w.append(inp); return w; };
        if (SC.mode === 'uniform') typed.append(mk('Factor', 'u')); else typed.append(mk('X', 'x'), mk('Y', 'y'), mk('Z', 'z'));
        typed.append(chip('Apply', () => { const vals = {}; for (const inp of typed.querySelectorAll('input')) { const v = parseFloat(inp.value); vals[inp.dataset.key] = isNaN(v) || v <= 0.001 ? 1 : v; } const sv = SC.mode === 'uniform' ? [vals.u, vals.u, vals.u] : [vals.x, vals.y, vals.z]; if (sv.some(v => Math.abs(v - 1) > 1e-9)) scBodyApply(sv); }, true));
        panelEl.append(typed);
        const row = el('div', 'row scroll'); row.append(chip('Pivot → centre', () => { const bb = scBody().man.boundingBox(); SC.pivot = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2]; requestRender(); }), chip('Done', () => { scDrop(); syncScene(); })); panelEl.append(row);
      } else {
        const row = el('div', 'row scroll');
        if (C.booleans) row.append(chip('Union', () => startUB('union')), chip('Subtract', () => startUB('subtract')), chip('Intersect', () => startUB('intersect')));
        row.prepend(chip('Move/Rotate', () => setTool('move'), true));
        row.append(chip('Mirror', mirrorSelected), chip('Duplicate', duplicateSelected), chip('Material', () => { MT = { id: b.id }; renderUI(); }), chip('Pattern', () => startXf('pattern', b)), chip('Rotate axis', () => startXf('rotate', b)), chip('Split', () => startXf('split', b)), chip('Scale', () => startScale(b)), chip('Translate', () => startTranslate(b)), chip('Zoom to', () => zoomTo(b)), chip('Delete', deleteSelected));
        panelEl.append(row);
      }
    }
  }
  // ===================== v22 · Shapr3D knurl video: Project / Imprint / Offset & Extrude imprint / multi-body booleans / Items / status =====================
  // (var, not let: syncScene and renderUI call into this block, and can run before it has executed)
  var PJ = null;     // Project: { items: [{outer, holes, frame, key}], target: {bodyId, faceId} | null, type: 'imprint' | 'sketch' }
  var XI = null;     // selected imprint: { bodyId, idx }
  var IMP = null;    // imprint op: { bodyId, idx, mode: 'offset' | 'extrude', d, op: 'new' | 'union' | 'subtract' | 'intersect' }
  var UB = null;     // multi-body boolean: { op, ids: [...] (union/intersect: all; subtract: targets), tools: [...], keep }
  var ITEMS = false; // Items panel open
  var xtGroup = null, xtPrevMesh = null, xtPrevTimer = null;
  const xv = { sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s], dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], len: a => Math.hypot(a[0], a[1], a[2]), norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; } };
  const xtNum = (v, dp = 3) => { const s = (Math.round(v * 10 ** dp) / 10 ** dp).toFixed(dp).replace(/\.?0+$/, ''); const [i, f] = s.split('.'); return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : ''); };
  /** Column-major 4x4 from axis columns and a translation. */
  const xtMat = (X, Y, Z, T) => [X[0], X[1], X[2], 0, Y[0], Y[1], Y[2], 0, Z[0], Z[1], Z[2], 0, T[0], T[1], T[2], 1];
  const xtBody = id => S.bodies.find(b => b.id === id) || null;
  /** Imprints still valid on a body: an imprint belongs to the exact solid it was made on (any edit of the body drops it). */
  const xtImprints = b => (b && b.imprints ? b.imprints.filter(im => im.man === b.man) : []);
  // ---------- surfaces an imprint can sit on ----------
  function xtSurfOf(b, faceId) {
    let surf = -1; try { surf = C.surfOfFace(b.md, faceId); } catch (e) { surf = -1; }
    if (surf >= 0 && C.surfCylinder) { let cy = null; try { cy = C.surfCylinder(b.md, surf); } catch (e) { cy = null; }
      if (cy) return { kind: 'cyl', a: cy.a, c: cy.c, r: cy.r, h0: cy.h0, h1: cy.h1, hole: !!cy.hole, n: cy.n || 0, phase: cy.phase || 0, u: cy.u, v: cy.v, surf }; }
    if (C.isPlanarFace(b.md, faceId)) { const f = C.faceFrame(b.md, faceId); return { kind: 'plane', origin: f.origin, u: f.u, v: f.v, n: f.n, loops: f.loops, surf }; }
    return null;
  }
  /** Where a point of the source plane lands on the surface, moved along the source normal (the near side of a cylinder). */
  function xtLand(src, x, y, sf) {
    const W = C.frameToWorld(src.frame, x, y, 0), n = src.frame.n;
    if (sf.kind === 'plane') { const den = xv.dot(n, sf.n); if (Math.abs(den) < 1e-7) return null; const t = xv.dot(xv.sub(sf.origin, W), sf.n) / den; return xv.add(W, xv.mul(n, t)); }
    const a = sf.a, w = xv.sub(W, sf.c); const wp = xv.sub(w, xv.mul(a, xv.dot(w, a))), dp = xv.sub(n, xv.mul(a, xv.dot(n, a)));
    const A = xv.dot(dp, dp), B = 2 * xv.dot(wp, dp), Cc = xv.dot(wp, wp) - sf.r * sf.r; const disc = B * B - 4 * A * Cc; if (A < 1e-12 || disc < 0) return null;
    const sq = Math.sqrt(disc); const ts = [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
    const side = xtNearDir(src, sf); let best = null;
    for (const t of ts) { const p = xv.add(W, xv.mul(n, t)); const q = xv.sub(p, sf.c); const h = xv.dot(q, a); if (h < sf.h0 - 1e-6 || h > sf.h1 + 1e-6) continue; if (xv.dot(q, side) < -1e-9) continue; if (!best || Math.abs(t) < Math.abs(best.t)) best = { t, p }; }
    return best ? best.p : null;
  }
  /** The direction, across the cylinder's axis, that faces the plane the items were drawn on. */
  function xtNearDir(src, sf) {
    const n = src.frame.n, a = sf.a; const s = xv.sub(src.frame.origin, sf.c); const sign = xv.dot(s, n) >= 0 ? 1 : -1;
    let w = xv.mul(n, sign); w = xv.sub(w, xv.mul(a, xv.dot(w, a))); if (xv.len(w) < 1e-9) { w = xv.sub(s, xv.mul(a, xv.dot(s, a))); }
    return xv.norm(w);
  }
  /** The imprint's outline on the surface, as world polylines (edges densified so they follow the curve). */
  function xtOutline(im) {
    const out = []; const sf = im.surf; const loops = [im.src.outer, ...(im.src.holes || [])];
    const step = sf.kind === 'cyl' ? Math.max(1e-3, sf.r * 0.03) : Infinity;
    for (const L of loops) { let run = [];
      for (let i = 0; i < L.length; i++) { const p = L[i], q = L[(i + 1) % L.length]; const len = Math.hypot(q[0] - p[0], q[1] - p[1]); const k = Math.max(1, Math.min(200, Math.ceil(len / step)));
        for (let j = 0; j < k; j++) { const t = j / k; const w = xtLand(im.src, p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, sf); if (w) run.push(w); else if (run.length) { if (run.length > 1) out.push(run); run = []; } } }
      if (run.length) { const first = xtLand(im.src, L[0][0], L[0][1], sf); if (first) run.push(first); if (run.length > 1) out.push(run); } }
    return out;
  }
  /** Is a point on the body inside the imprint (on its surface, inside its outline)? */
  function xtInside(im, p) {
    const sf = im.surf, f = im.src.frame; const d = xv.sub(p, f.origin); const q = [xv.dot(d, f.u), xv.dot(d, f.v)];
    if (!pip(q, im.src.outer) || (im.src.holes || []).some(h => pip(q, h))) return false;
    if (sf.kind === 'plane') return Math.abs(xv.dot(xv.sub(p, sf.origin), sf.n)) < 1e-3 * (1 + xv.len(d));
    const w = xv.sub(p, sf.c); const h = xv.dot(w, sf.a); const rad = xv.len(xv.sub(w, xv.mul(sf.a, h)));
    return Math.abs(rad - sf.r) < 0.03 * sf.r + 1e-4 && xv.dot(w, xtNearDir(im.src, sf)) > -1e-6;
  }
  // ---------- the solid an imprint grows or cuts ----------
  function xtPrism(src, z0, z1) {
    const m = C.extrudeRegions([{ outer: src.outer, holes: src.holes || [] }], Math.max(1e-4, z1 - z0))[0];
    const f = src.frame; return C.transformSolid(m, xtMat(f.u, f.v, f.n, xv.add(f.origin, xv.mul(f.n, z0))));
  }
  /** Solid of the imprint pushed out (d > 0, to add) or in (d < 0, to cut) by |d| across the surface. */
  function xtTool(b, im, d) {
    const sf = im.surf; if (Math.abs(d) < 1e-6) throw new Error('Set a distance first');
    const bb = b.man.boundingBox(); const corners = []; for (const x of [bb.min[0], bb.max[0]]) for (const y of [bb.min[1], bb.max[1]]) for (const z of [bb.min[2], bb.max[2]]) corners.push([x, y, z]);
    const f = im.src.frame; const zs = corners.map(p => xv.dot(xv.sub(p, f.origin), f.n)); const pad = Math.abs(d) + 1 + 0.1 * Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
    const prism = xtPrism(im.src, Math.min(...zs) - pad, Math.max(...zs) + pad);
    if (sf.kind === 'cyl') {
      if (d < 0 && sf.r + d <= 1e-4) throw new Error('That would cut past the axis of the cylinder');
      const H = sf.h1 - sf.h0, e = Math.max(1e-3, 0.02 * H);
      const rIn = d > 0 ? sf.r * 0.96 : sf.r + d, rOut = d > 0 ? sf.r + d : sf.r * 1.04 + 1e-3;
      const hIn = d > 0 ? H + 2 * e : H + 4 * e, hOut = d > 0 ? H : H + 2 * e, zOut = d > 0 ? 0 : -e;
      let ring = C.cylinder(rOut, hOut).translate([0, 0, zOut]).subtract(C.cylinder(rIn, hIn).translate([0, 0, -2 * e]));
      const ph = sf.phase || 0; const X = xv.add(xv.mul(sf.u, Math.cos(ph)), xv.mul(sf.v, Math.sin(ph))), Y = xv.cross(sf.a, X);
      ring = C.transformSolid(ring, xtMat(X, Y, sf.a, xv.add(sf.c, xv.mul(sf.a, sf.h0))));
      const w = xtNearDir(im.src, sf), p1 = xv.norm(xv.cross(w, Math.abs(w[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0])), p2 = xv.cross(w, p1); const L = 4 * (sf.r + Math.abs(d) + H) + 10;
      const half = C.transformSolid(C.box(L, L, L), xtMat(p1, p2, w, sf.c));
      return ring.intersect(prism).intersect(half);
    }
    // a flat face: the outline moved onto the face plane, pushed along the face normal, kept inside the face
    const map = L => L.map(p => { const w = xtLand(im.src, p[0], p[1], sf); const q = xv.sub(w, sf.origin); return [xv.dot(q, sf.u), xv.dot(q, sf.v)]; });
    const fr = { origin: sf.origin, u: sf.u, v: sf.v, n: sf.n }; const e = 1e-3 * (1 + Math.abs(d));
    const z0 = d > 0 ? -e : d, z1 = d > 0 ? d : e;
    let tool = xtPrism({ frame: fr, outer: map(im.src.outer), holes: (im.src.holes || []).map(map) }, z0, z1);
    try { const regs = window.CadIO.loopsToRegions(sf.loops); if (regs.length) { let face = null; for (const r of regs) { const m = xtPrism({ frame: fr, outer: r.outer, holes: r.holes }, z0 - e, z1 + e); face = face ? face.add(m) : m; } tool = tool.intersect(face); } } catch (er) { /* keep the whole outline */ }
    return tool;
  }
  /** The host body after the op, or the new body (op 'new'). */
  function xtResult(b, im, d, op) {
    const tool = xtTool(b, im, d); if (tool.volume() < 1e-10) throw new Error('The imprint does not reach the body there');
    if (op === 'new') return tool;
    return C.clean(op === 'subtract' ? b.man.subtract(tool) : op === 'intersect' ? b.man.intersect(tool) : b.man.add(tool));
  }
  // ---------- drawing: imprint outlines, project items, target face, previews ----------
  function xtSync() {
    if (!xtGroup) { xtGroup = new THREE.Group(); scene.add(xtGroup); }
    for (const c of [...xtGroup.children]) { xtGroup.remove(c); c.geometry && c.geometry.dispose(); }
    const lineMat = (col, top) => { const m = new THREE.LineBasicMaterial({ color: col, depthTest: !top, transparent: !!top }); return m; };
    const addPoly = (pts, col, top, order = 9) => { const g = new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(p[0], p[1], p[2]))); const l = new THREE.Line(g, lineMat(col, top)); l.renderOrder = order; xtGroup.add(l); };
    for (const b of S.bodies) { if (b.hidden) continue; xtImprints(b).forEach((im, i) => {
      const sel = XI && XI.bodyId === b.id && XI.idx === i; const col = sel ? 0x0b7fbf : 0x13525e;
      for (const run of xtOutline(im)) { const lift = run.map(p => { if (im.surf.kind === 'cyl') { const w = xv.sub(p, im.surf.c); const h = xv.dot(w, im.surf.a); const r = xv.norm(xv.sub(w, xv.mul(im.surf.a, h))); return xv.add(p, xv.mul(r, 2e-3 * im.surf.r)); } return xv.add(p, xv.mul(im.surf.n, 1e-3)); }); addPoly(lift, col, false); }
      if (sel || (IMP && IMP.bodyId === b.id && IMP.idx === i)) xtFill(im, 0x1ea7d8, 0.55); }); }
    if (PJ) {
      for (const it of PJ.items) for (const L of [it.outer, ...(it.holes || [])]) { const W = L.map(p => C.frameToWorld(it.frame, p[0], p[1], 0.02)); W.push(W[0]); addPoly(W, 0x18c46a, true, 12); xtFill({ src: it, surf: null }, 0x18c46a, 0.35); }
      const tb = PJ.target && xtBody(PJ.target.bodyId);
      if (tb) { const sf = xtSurfOf(tb, PJ.target.faceId); if (sf) { const sub = []; const { indices, surfID } = tb.md; for (let t = 0; t < surfID.length; t++) if (surfID[t] === sf.surf) sub.push(indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]);
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(tb.md.positions, 3)); g.setIndex(new THREE.BufferAttribute(new Uint32Array(sub), 1)); if (tb.md.normals) g.setAttribute('normal', new THREE.BufferAttribute(tb.md.normals, 3));
        const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xb04df0, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })); m.renderOrder = 3; xtGroup.add(m); } }
    }
    // bodies picked for a multi-body Union / Subtract / Intersect turn blue (tools of a subtract turn red)
    for (const [id, o] of objects) { const b = xtBody(id); if (!b) continue; o.mesh.visible = !b.hidden; o.lines.visible = !b.hidden; if (o.faceMesh) o.faceMesh.visible = !b.hidden;
      if (!UB && ((XI && XI.bodyId === id) || (IMP && IMP.bodyId === id))) { o.mesh.material.color.setHex(b.color); o.mesh.material.emissive.setHex(0); }
      if (UB) { const inT = UB.ids.includes(id), inS = (UB.tools || []).includes(id); if (inT || inS) { o.mesh.material.color.setHex(inS ? 0xf0566a : 0x38bdf0); o.mesh.material.emissive.setHex(inS ? 0x4a1018 : 0x143a4a); } else { o.mesh.material.color.setHex(b.color); o.mesh.material.emissive.setHex(0); } } }
    xtStatus();
  }
  /** A see-through fill of an outline: on its own plane (src only) or laid onto the surface. */
  function xtFill(im, col, op) {
    try {
      const v2 = L => L.map(p => new THREE.Vector2(p[0], p[1]));
      // densify so a curved fill hugs the cylinder
      const dens = L => { if (!im.surf || im.surf.kind !== 'cyl') return L; const st = im.surf.r * 0.05; const o = []; for (let i = 0; i < L.length; i++) { const p = L[i], q = L[(i + 1) % L.length]; const k = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / st)); for (let j = 0; j < k; j++) o.push([p[0] + (q[0] - p[0]) * j / k, p[1] + (q[1] - p[1]) * j / k]); } return o; };
      const outer = dens(im.src.outer), holes = (im.src.holes || []).map(dens); const all = [...outer, ...holes.flat()];
      const tris = THREE.ShapeUtils.triangulateShape(v2(outer), holes.map(v2));
      const pos = []; const W = all.map(p => im.surf ? xtLand(im.src, p[0], p[1], im.surf) : C.frameToWorld(im.src.frame, p[0], p[1], 0.02));
      for (const t of tris) { if (t.some(i => !W[i])) continue; for (const i of t) pos.push(...W[i]); }
      if (!pos.length) return; const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: op, side: THREE.DoubleSide, depthTest: false, depthWrite: false })); m.renderOrder = 14; xtGroup.add(m);
    } catch (e) { /* a fill is only a highlight */ }
  }
  function xtClearPreview() { if (xtPrevMesh) { scene.remove(xtPrevMesh); xtPrevMesh.geometry.dispose(); xtPrevMesh = null; } }
  function xtPreview() {
    clearTimeout(xtPrevTimer); xtPrevTimer = setTimeout(() => {
      xtClearPreview(); if (!IMP) { requestRender(); return; } const b = xtBody(IMP.bodyId); const im = b && xtImprints(b)[IMP.idx]; if (!im) return;
      let tool = null; try { tool = xtTool(b, im, IMP.d); } catch (e) { IMP.err = e.message; renderUI(); requestRender(); return; } IMP.err = null;
      const md = C.meshData(tool); const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(md.positions, 3)); g.setIndex(new THREE.BufferAttribute(md.indices, 1)); g.computeVertexNormals();
      const sub = IMP.mode === 'offset' ? IMP.d < 0 : IMP.op === 'subtract';
      xtPrevMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: sub ? 0xf0566a : 0x3ddc84, transparent: true, opacity: 0.7, roughness: 0.5, depthTest: !sub, side: THREE.DoubleSide })); xtPrevMesh.renderOrder = sub ? 16 : 4;
      scene.add(xtPrevMesh); requestRender();
    }, 120);
  }
  // ---------- status line (Shapr3D's bottom bar: what is selected and how big it is) ----------
  const xtStatusEl = (() => { const e = document.createElement('div'); e.id = 'xt-status'; e.hidden = true; document.body.appendChild(e);
    const st = document.createElement('style'); st.textContent = `#xt-status { position: fixed; left: 50%; transform: translateX(-50%); top: calc(env(safe-area-inset-top, 0px) + 68px); z-index: 4; background: var(--panel); border: 1px solid var(--border); border-radius: 999px; padding: 4px 12px; font: 600 12px ui-monospace, Menlo, Consolas, monospace; color: var(--fg); white-space: nowrap; max-width: 94vw; overflow: hidden; text-overflow: ellipsis; pointer-events: none; box-shadow: 0 2px 10px rgba(0,0,0,.08); }
      #xt-status[hidden] { display: none; } #xt-status b { color: var(--accent); font-weight: 700; }
      #xt-items { position: fixed; left: 10px; top: calc(env(safe-area-inset-top, 0px) + 104px); width: min(300px, 82vw); max-height: 60vh; overflow: auto; z-index: 7; background: var(--panel); border: 1px solid var(--border); border-radius: 16px; box-shadow: 0 8px 30px rgba(0,0,0,.22); padding: 8px; backdrop-filter: blur(8px); }
      #xt-items[hidden] { display: none; } #xt-items .ih { display: flex; align-items: center; justify-content: space-between; font-weight: 700; font-size: 15px; padding: 4px 6px 8px; }
      #xt-items .it { display: flex; align-items: center; gap: 10px; padding: 9px 8px; border-radius: 10px; cursor: pointer; } #xt-items .it:hover { background: var(--chip); } #xt-items .it.sel { background: rgba(56,189,240,.18); }
      #xt-items .it .nm { flex: 1; min-width: 0; } #xt-items .it .nm b { display: block; font-size: 14px; font-weight: 500; } #xt-items .it .nm small { color: var(--muted); font-size: 11px; } #xt-items .it.off .nm { opacity: .45; }
      #xt-items .ic { width: 22px; text-align: center; } #xt-items .eye { border: 0; background: transparent; color: var(--fg); font-size: 16px; width: 34px; height: 30px; border-radius: 8px; cursor: pointer; } #xt-items .eye:hover { background: var(--chip); }
      #xt-items .x { border: 0; background: var(--chip); color: var(--fg); width: 30px; height: 30px; border-radius: 50%; cursor: pointer; font-size: 15px; }
      .xt-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; } .xt-grid .chip { border-radius: 12px; padding: 10px 8px; }`;
    document.head.appendChild(st); return e; })();
  function xtFaceArea(md, surf) { const P = md.positions, I = md.indices, sid = md.surfID; let A = 0; for (let t = 0; t < sid.length; t++) { if (sid[t] !== surf) continue; const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3; A += xv.len(xv.cross([P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]])) / 2; } return A; }
  function xtBodyArea(md) { const P = md.positions, I = md.indices; let A = 0; for (let t = 0; t < I.length / 3; t++) { const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3; A += xv.len(xv.cross([P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]])) / 2; } return A; }
  function xtStatusText() {
    const u = S.unit || 'mm';
    if (PJ) return '';
    if (UB) { const n = UB.ids.length + (UB.tools || []).length; return n ? `${n} bod${n === 1 ? 'y' : 'ies'}` : ''; }
    if (XI) { const b = xtBody(XI.bodyId); const im = b && xtImprints(b)[XI.idx]; if (im) { const A = Math.abs(C.signedArea ? C.signedArea(im.src.outer) : 0); return `1 imprinted face · outline ${xtNum(A)} ${u}²` + (im.surf.kind === 'cyl' ? ` · on R ${xtNum(im.surf.r)} ${u}` : ''); } }
    const b = selected(); if (!b) return '';
    const surfSel = S.tool === 'move' && S.moveSurf != null ? S.moveSurf : S.selectedFace != null ? C.surfOfFace(b.md, S.selectedFace) : null;
    if (surfSel != null && surfSel >= 0) {
      const A = xtFaceArea(b.md, surfSel); let cy = null; try { cy = C.surfCylinder(b.md, surfSel); } catch (e) { cy = null; }
      return cy ? `1 face · R ${xtNum(cy.r)} ${u} · Ø ${xtNum(2 * cy.r)} ${u} · ${xtNum(A)} ${u}²` : `1 face · ${xtNum(A)} ${u}²`;
    }
    let V = 0; try { V = Math.abs(b.man.volume()); } catch (e) { V = 0; }
    return `1 body · ${xtNum(xtBodyArea(b.md))} ${u}² · ${xtNum(V)} ${u}³`;
  }
  function xtStatus() { const t = xtStatusText(); xtStatusEl.textContent = t; xtStatusEl.hidden = !t; }
  // ---------- Items panel (Shapr3D "All Items": sketch planes and bodies, with eyes) ----------
  const xtItemsEl = (() => { const e = document.createElement('div'); e.id = 'xt-items'; e.hidden = true; document.body.appendChild(e); return e; })();
  { const bt = document.createElement('button'); bt.className = 'btn icon'; bt.id = 'xt-items-btn'; bt.title = 'Items: sketches and bodies, show / hide'; bt.setAttribute('aria-label', 'Items'); bt.textContent = '◫';
    const ref = $('undo'); ref.parentNode.insertBefore(bt, ref); bt.onclick = () => { ITEMS = !ITEMS; xtItems(); }; }
  function xtItems() {
    xtItemsEl.hidden = !ITEMS; if (!ITEMS) return; xtItemsEl.replaceChildren();
    const head = el('div', 'ih'); head.append(el('span', null, '◈ All Items')); const x = el('button', 'x', '✕'); x.onclick = () => { ITEMS = false; xtItems(); }; head.append(x); xtItemsEl.append(head);
    const row = (icon, name, sub, on, onEye, onTap, sel) => { const r = el('div', 'it' + (on ? '' : ' off') + (sel ? ' sel' : '')); const ic = el('span', 'ic', icon); const nm = el('div', 'nm'); nm.append(el('b', null, name)); if (sub) nm.append(el('small', null, sub));
      const eye = el('button', 'eye', on ? '👁' : '⊘'); eye.title = on ? 'Hide' : 'Show'; eye.onclick = ev => { ev.stopPropagation(); onEye(); }; r.onclick = onTap; r.append(ic, nm, eye); xtItemsEl.append(r); };
    const sketches = [...(S.kept || []).map((k, i) => ({ k, i })), ...(S.plane && S.sketchLines.length ? [{ k: { plane: S.plane, lines: S.sketchLines, hidden: false }, i: -1 }] : [])];
    sketches.forEach(({ k, i }, j) => row('✎', `Sketch plane ${String(j + 1).padStart(2, '0')}`, `${k.lines.length} line${k.lines.length === 1 ? '' : 's'}`, !k.hidden,
      () => { if (i < 0) { step(() => { archiveSketch(); S.sketchLines = []; S.plane = null; S.lineStart = null; S.lastLine = -1; S.selRegion = -1; const n = S.kept.length - 1; S.kept = S.kept.map((q, m) => m === n ? { ...q, hidden: true } : q); }, 'Hide sketch'); syncKept(); syncScene(); xtItems(); return; } S.kept = S.kept.map((q, m) => m === i ? { ...q, hidden: !q.hidden } : q); syncKept(); syncScene(); xtItems(); },
      () => { if (i >= 0 && !k.hidden) { activateKept(i); xtItems(); } }));
    S.profiles.forEach(q => row('▱', q.name, 'profile', !q.hidden, () => { S.profiles = S.profiles.map(p => p.id === q.id ? { ...p, hidden: !p.hidden } : p); syncScene(); xtItems(); }, () => { if (!q.hidden) { S.selProfiles = [q.id]; setTool('select'); syncScene(); } }, S.selProfiles.includes(q.id)));
    S.bodies.forEach(b => row('⬢', b.name, (b.material ? MATS[b.material].name + ' · ' : '') + `${xtImprints(b).length ? xtImprints(b).length + ' imprint' + (xtImprints(b).length === 1 ? '' : 's') : 'solid'}`, !b.hidden,
      () => { S.bodies = S.bodies.map(q => q.id === b.id ? { ...q, hidden: !q.hidden } : q); if (b.id === S.selectedId && !b.hidden) { S.selectedId = null; S.selectedFace = null; } save(); syncScene(); xtItems(); },
      () => { if (b.hidden) return; if (S.tool !== 'select' && S.tool !== 'move') setTool('select'); S.selectedId = b.id; S.selectedFace = null; syncScene(); xtItems(); }, b.id === S.selectedId));
    if (!sketches.length && !S.bodies.length && !S.profiles.length) xtItemsEl.append(el('div', 'note', 'Nothing yet — sketch something or add a body.'));
  }
  // ---------- Project (Shapr3D: Select items to project → Select projection plane → Done) ----------
  const xtKey = it => JSON.stringify([it.frame.origin.map(v => +v.toFixed(5)), it.frame.n.map(v => +v.toFixed(5)), it.outer.slice(0, 4).map(p => p.map(v => +v.toFixed(5))), it.outer.length]);
  function startProject() {
    if (!C.booleans) { toast('Project needs the geometry engine, which this browser blocked'); return; }
    const items = [];
    if (S.selRegion >= 0 && regionCache[S.selRegion]) { const r = regionCache[S.selRegion]; const pl = plane(); items.push({ outer: r.outer.map(p => p.slice()), holes: (r.holes || []).map(h => h.map(p => p.slice())), frame: { origin: pl.origin.slice(), u: pl.u.slice(), v: pl.v.slice(), n: pl.n.slice() } }); }
    for (const id of S.selProfiles) { const q = profById(id); if (q) items.push({ outer: q.outer, holes: q.holes || [], frame: q.frame }); }
    items.forEach(it => { it.key = xtKey(it); });
    const b = selected(); const target = b && S.selectedFace != null ? { bodyId: b.id, faceId: S.selectedFace } : null;
    if (FL) commitFil(false); if (SESSION) endSession();
    PJ = { items, target, type: 'imprint' }; XI = null; IMP = null; UB = null; S.selRegion = -1; S.selProfiles = []; S.selectedId = null; S.selectedFace = null; S.faceTool = false;
    syncScene(); toast('Project · tap the closed sketch shapes to project, then the face to project them onto');
  }
  function xtProjectTap(x, y) {
    const ray = rayAt(x, y); const hb = pick(ray); const hbD = hb ? xv.len(xv.sub(hb.point, ray.o)) : Infinity;
    // 1. a closed shape of the open sketch, of a kept sketch, or a profile (whichever is in front of any body)
    let it = null, itD = Infinity;
    if (S.plane && S.sketchLines.length) { raycaster.set(new THREE.Vector3(...ray.o), new THREE.Vector3(...ray.d)); const rm = raycaster.intersectObjects(regionMeshes, false)[0];
      if (rm && regionCache[rm.object.userData.index]) { const r = regionCache[rm.object.userData.index]; const pl = plane(); it = { outer: r.outer.map(p => p.slice()), holes: (r.holes || []).map(h => h.map(p => p.slice())), frame: { origin: pl.origin.slice(), u: pl.u.slice(), v: pl.v.slice(), n: pl.n.slice() } }; itD = rm.distance; } }
    if (!it) { const kr = keptRegionAt(x, y); if (kr) { const k = S.kept[kr.i]; if (k && !k.hidden) { let regs = []; try { regs = window.CadIO.loopsToRegions(C.planarRegions(k.lines.map(l => [l[0], l[1]]))); } catch (e) { regs = []; }
      const r = regs.find(g => pip(kr.pt, g.outer) && !(g.holes || []).some(h => pip(kr.pt, h))) || regs.find(g => pip(kr.pt, g.outer)); if (r) { it = { outer: r.outer, holes: r.holes || [], frame: { origin: k.plane.origin.slice(), u: k.plane.u.slice(), v: k.plane.v.slice(), n: k.plane.n.slice() } }; itD = kr.d; } } } }
    if (!it) { const pp = pickProfile(ray); if (pp) { const q = profById(pp.id); if (q && !q.hidden) { it = { outer: q.outer, holes: q.holes || [], frame: q.frame }; itD = pp.distance; } } }
    if (it && itD <= hbD + 1e-6) { it.key = xtKey(it); const i = PJ.items.findIndex(q => q.key === it.key); if (i >= 0) PJ.items.splice(i, 1); else PJ.items.push(it); syncScene(); return true; }
    if (hb) { PJ.target = PJ.target && PJ.target.bodyId === hb.body.id && C.surfOfFace(hb.body.md, PJ.target.faceId) === C.surfOfFace(hb.body.md, hb.faceId) ? null : { bodyId: hb.body.id, faceId: hb.faceId }; syncScene(); return true; }
    if (it) { it.key = xtKey(it); const i = PJ.items.findIndex(q => q.key === it.key); if (i >= 0) PJ.items.splice(i, 1); else PJ.items.push(it); syncScene(); return true; }
    return true;   // a tap on empty space does nothing while projecting
  }
  function xtProjectDone() {
    if (!PJ || !PJ.items.length) { toast('Select items to project first: tap a closed sketch shape'); return; }
    const b = PJ.target && xtBody(PJ.target.bodyId); if (!b) { toast('Select the projection plane: tap a face of a body'); return; }
    const sf = xtSurfOf(b, PJ.target.faceId); if (!sf) { toast('Project works onto flat faces and round (cylindrical) faces'); return; }
    if (sf.kind === 'cyl' && sf.hole) { toast('Projecting into a bore is not supported yet — pick an outer face'); return; }
    if (PJ.type === 'sketch') {
      if (sf.kind !== 'plane') { toast('Sketches can be projected onto a flat face — use Imprinted Body Edges for a round face'); return; }
      const fr = { origin: sf.origin.slice(), u: sf.u.slice(), v: sf.v.slice(), n: sf.n.slice(), name: 'Projected sketch' }; const lines = [];
      for (const it of PJ.items) for (const L of [it.outer, ...(it.holes || [])]) { const P2 = L.map(p => { const w = xtLand(it, p[0], p[1], sf); const q = xv.sub(w, sf.origin); return [xv.dot(q, sf.u), xv.dot(q, sf.v)]; }); for (let i = 0; i < P2.length; i++) lines.push([P2[i], P2[(i + 1) % P2.length]]); }
      step(() => { S.kept = [...(S.kept || []), { plane: fr, lines }]; }, 'Project sketch'); PJ = null; commit(); toast(`Projected as a sketch on the face · ${lines.length} lines`); return;
    }
    const made = []; for (const it of PJ.items) { const im = { man: b.man, src: { outer: it.outer.map(p => p.slice()), holes: (it.holes || []).map(h => h.map(p => p.slice())), frame: it.frame }, surf: sf, faceId: PJ.target.faceId }; if (xtOutline(im).length) made.push(im); }
    if (!made.length) { toast('The items do not land on that face — project along the sketch plane\'s normal'); return; }
    step(() => { S.bodies = S.bodies.map(q => q.id === b.id ? { ...q, imprints: [...xtImprints(q), ...made] } : q); }, `Project onto ${b.name}`);
    PJ = null; S.selectedId = b.id; S.selectedFace = null; XI = { bodyId: b.id, idx: xtImprints(xtBody(b.id)).length - made.length };
    commit(); toast(`Imprinted ${made.length} region${made.length === 1 ? '' : 's'} on ${b.name} · now Offset Face or Extrude it`);
  }
  // ---------- imprint ops ----------
  function startImp(mode) { if (!XI) return; IMP = { bodyId: XI.bodyId, idx: XI.idx, mode, d: mode === 'offset' ? 1 : -1, op: mode === 'offset' ? null : 'subtract', err: null }; renderUI(); xtPreview(); }
  function xtImpApply() {
    if (!IMP) return; const b = xtBody(IMP.bodyId); const im = b && xtImprints(b)[IMP.idx]; if (!im) { IMP = null; renderUI(); return; }
    const op = IMP.mode === 'offset' ? (IMP.d > 0 ? 'union' : 'subtract') : IMP.op; const d = IMP.d;
    const m = tryGeom(() => xtResult(b, im, d, op)); if (!m) return; if (m.volume() < 1e-9) { toast(op === 'intersect' ? 'Nothing is left: the imprint and the body do not overlap' : 'That would remove the whole body'); return; }
    const label = IMP.mode === 'offset' ? `Offset Face ${d > 0 ? '+' : ''}${xtNum(d)} ${S.unit}` : `Extrude imprint · ${op === 'new' ? 'New Body' : op[0].toUpperCase() + op.slice(1)}`;
    step(() => { if (op === 'new') { const nb = makeBodyRecord('Body', m); S.bodies = [...S.bodies, nb]; } else S.bodies = S.bodies.map(q => q.id === b.id ? { ...q, man: m, md: C.meshData(m) } : q); }, label);
    IMP = null; XI = null; xtClearPreview(); S.selectedId = b.id; S.selectedFace = null; commit(); toast(label);
  }
  function xtImpCancel() { IMP = null; xtClearPreview(); renderUI(); requestRender(); }
  // ---------- multi-body Union / Subtract / Intersect (Keep Originals) ----------
  function startUB(op) { const b = selected(); UB = { op, ids: b ? [b.id] : [], tools: [], keep: false }; S.selectedFace = null; S.faceTool = false; S.pendingBool = null; PJ = null; XI = null; IMP = null; syncScene();
    toast(op === 'union' ? 'Union · tap the intersecting bodies to unite, then Done' : op === 'subtract' ? 'Subtract · tap the bodies to subtract from this one, then Done' : 'Intersect · tap the bodies to intersect, then Done'); }
  function xtUBTap(x, y) {
    const h = pick(rayAt(x, y)); if (!h) return true; const id = h.body.id;
    if (UB.op === 'subtract') { if (UB.ids.includes(id)) { if (UB.ids.length > 1) UB.ids = UB.ids.filter(q => q !== id); } else UB.tools = UB.tools.includes(id) ? UB.tools.filter(q => q !== id) : [...UB.tools, id]; if (!UB.ids.length) UB.ids = [id]; }
    else UB.ids = UB.ids.includes(id) ? UB.ids.filter(q => q !== id) : [...UB.ids, id];
    syncScene(); return true;
  }
  function xtUBDone() {
    const bs = UB.ids.map(xtBody).filter(Boolean), ts = (UB.tools || []).map(xtBody).filter(Boolean);
    if (UB.op === 'subtract' ? !(bs.length && ts.length) : bs.length < 2) { toast(UB.op === 'subtract' ? 'Tap at least one body to subtract' : 'Tap at least two bodies'); return; }
    const op = UB.op;
    const m = tryGeom(() => { let r;
      if (op === 'union') { r = Manifold_batch(bs.map(b => b.man), 'union'); }
      else if (op === 'intersect') { r = bs[0].man; for (const b of bs.slice(1)) r = r.intersect(b.man); }
      else { const tool = ts.length === 1 ? ts[0].man : Manifold_batch(ts.map(b => b.man), 'union'); r = bs.length === 1 ? bs[0].man.subtract(tool) : null; if (!r) return null; }
      return C.clean(r); });
    if (!m) return; if (m.volume() < 1e-9) { toast(op === 'intersect' ? 'Result is empty: the bodies do not overlap' : 'Result is empty'); return; }
    const label = `${op[0].toUpperCase() + op.slice(1)} ${bs.length + ts.length} bodies${UB.keep ? ' (keep originals)' : ''}`;
    step(() => {
      if (UB.keep) { const nb = makeBodyRecord(op[0].toUpperCase() + op.slice(1), m); S.bodies = [...S.bodies, nb]; S.selectedId = nb.id; }
      else { const first = bs[0]; const gone = new Set([...bs.slice(1), ...ts].map(b => b.id)); S.bodies = S.bodies.filter(b => !gone.has(b.id)).map(b => b.id === first.id ? { ...b, man: m, md: C.meshData(m) } : b); S.selectedId = first.id; }
    }, label);
    UB = null; S.selectedFace = null; commit(); toast(label);
  }
  /** Unites many solids at once (pairwise, balanced: much faster than one by one for a ring of copies). */
  function Manifold_batch(list, op) { if (C.batchUnion && list.length > 2) { try { const r = C.batchUnion(list); if (r) return r; } catch (e) { /* pairwise below */ } } let a = list.slice(); while (a.length > 1) { const nx = []; for (let i = 0; i < a.length; i += 2) nx.push(i + 1 < a.length ? a[i].add(a[i + 1]) : a[i]); a = nx; } return a[0]; }
  /** Shapr3D greys the screen with a spinner while a long boolean runs: the same here, so the app never looks frozen. */
  const xtBusyEl = (() => { const e = document.createElement('div'); e.id = 'xt-busy'; e.hidden = true; e.innerHTML = '<div><i></i><span></span></div>'; document.body.appendChild(e);
    const st = document.createElement('style'); st.textContent = `#xt-busy { position: fixed; inset: 0; z-index: 40; background: rgba(40,44,52,.38); display: grid; place-items: center; } #xt-busy[hidden] { display: none; }
      #xt-busy div { background: var(--panel); border-radius: 14px; padding: 14px 18px; display: flex; align-items: center; gap: 12px; font-size: 14px; box-shadow: 0 8px 30px rgba(0,0,0,.25); }
      #xt-busy i { width: 22px; height: 22px; border-radius: 50%; border: 3px solid var(--chip); border-top-color: var(--accent); animation: xtspin .8s linear infinite; } @keyframes xtspin { to { transform: rotate(360deg); } }`; document.head.appendChild(st); return e; })();
  function xtBusy(label, fn) { xtBusyEl.querySelector('span').textContent = label; xtBusyEl.hidden = false; requestAnimationFrame(() => setTimeout(() => { try { fn(); } finally { xtBusyEl.hidden = true; } }, 30)); }
  function xtCancelAll() { PJ = null; XI = null; IMP = null; UB = null; xtClearPreview(); }
  // ---------- taps ----------
  function xtTap(x, y) {
    if (UB) return xtUBTap(x, y);
    if (PJ) return xtProjectTap(x, y);
    if (IMP) { const h = pick(rayAt(x, y)); if (!h) { xtImpCancel(); } return true; }   // while an imprint op is open, taps do not change the selection
    if (S.tool !== 'select' || TR || SCF || OF || RV || LF || SW || FL || SH) return false;
    const ray = rayAt(x, y); const h = pick(ray);
    if (h && !h.body.hidden) { const ims = xtImprints(h.body); for (let i = ims.length - 1; i >= 0; i--) if (xtInside(ims[i], h.point)) {
        if (XI && XI.bodyId === h.body.id && XI.idx === i) XI = null; else { XI = { bodyId: h.body.id, idx: i }; S.selectedId = h.body.id; S.selectedFace = null; S.faceTool = false; S.selProfiles = []; S.selPath = null; S.selRegion = -1; }
        syncScene(); return true; } }
    if (XI) { XI = null; }
    return false;
  }
  // ---------- panels ----------
  function xtPanel() {
    // drop modes whose bodies went away (an Undo, say)
    if (XI && !(xtBody(XI.bodyId) && xtImprints(xtBody(XI.bodyId))[XI.idx])) XI = null;
    if (IMP && !(xtBody(IMP.bodyId) && xtImprints(xtBody(IMP.bodyId))[IMP.idx])) { IMP = null; xtClearPreview(); }
    if (UB) { UB.ids = UB.ids.filter(xtBody); UB.tools = (UB.tools || []).filter(xtBody); }
    if (PJ && PJ.target && !xtBody(PJ.target.bodyId)) PJ.target = null;
    const keep = n => { n.classList.add('pc-keep'); return n; };
    if (PJ) {
      panelEl.replaceChildren(); panelEl.hidden = false;
      hintEl.textContent = !PJ.items.length ? 'Project · select items to project (tap closed sketch shapes)' : !PJ.target ? 'Project · select projection plane (tap a body face)' : 'Project · Done imprints the shapes on the face';
      const steps = keep(el('div', 'note')); steps.innerHTML = `<b>Project</b> &nbsp; ${PJ.items.length ? '✅' : '①'} Select items to project <b>(${PJ.items.length})</b> &nbsp; ${PJ.target ? '✅' : '②'} Select projection plane`; panelEl.append(steps);
      const tr = keep(el('div', 'row scroll')); tr.append(el('span', 'note', 'Projection Type:'), chip('Imprinted Body Edges', () => { PJ.type = 'imprint'; renderUI(); }, PJ.type === 'imprint'), chip('Sketches', () => { PJ.type = 'sketch'; renderUI(); }, PJ.type === 'sketch')); panelEl.append(tr);
      const row = el('div', 'row scroll'); row.append(chip('Done', xtProjectDone, !!(PJ.items.length && PJ.target)), chip('Cancel', () => { PJ = null; syncScene(); })); panelEl.append(row);
    } else if (UB) {
      panelEl.replaceChildren(); panelEl.hidden = false; const nm = UB.op[0].toUpperCase() + UB.op.slice(1);
      hintEl.textContent = UB.op === 'subtract' ? `Subtract · ${UB.tools.length ? 'tap more bodies to subtract, or Done' : 'tap the bodies to subtract (they turn red)'}` : `${nm} · select intersecting bodies to ${UB.op === 'union' ? 'unite' : 'intersect'} (${UB.ids.length})`;
      panelEl.append(keep(el('div', 'note', UB.op === 'subtract' ? `Blue: kept body · Red: ${UB.tools.length} bod${UB.tools.length === 1 ? 'y' : 'ies'} to cut away` : `${UB.ids.length} bod${UB.ids.length === 1 ? 'y' : 'ies'} selected — tap a body to add or remove it`)));
      const row = el('div', 'row scroll'); row.append(chip('Done', () => { const n = UB.ids.length + (UB.tools || []).length; if (n > 3) xtBusy(`${UB.op === 'union' ? 'Uniting' : UB.op === 'subtract' ? 'Subtracting' : 'Intersecting'} ${n} bodies…`, xtUBDone); else xtUBDone(); }, true), chip(`Keep Originals: ${UB.keep ? 'On' : 'Off'}`, () => { UB.keep = !UB.keep; renderUI(); }, UB.keep), chip('Select all', () => { const all = S.bodies.filter(b => !b.hidden).map(b => b.id); if (UB.op === 'subtract') UB.tools = all.filter(id => !UB.ids.includes(id)); else UB.ids = all; syncScene(); }), chip('Cancel', () => { UB = null; syncScene(); })); panelEl.append(row);
    } else if (IMP) {
      panelEl.replaceChildren(); panelEl.hidden = false; const b = xtBody(IMP.bodyId); const im = xtImprints(b)[IMP.idx]; const cyl = im.surf.kind === 'cyl';
      hintEl.textContent = IMP.mode === 'offset' ? 'Offset Face · drag the slider or type a value; positive raises the imprint, negative sinks it' : 'Extrude · choose New Body, Union, Subtract or Intersect and the distance';
      if (IMP.mode === 'extrude') { const g = keep(el('div', 'xt-grid')); for (const [k, lab] of [['new', '⬢ New Body'], ['union', '⊕ Union'], ['subtract', '⊖ Subtract'], ['intersect', '⊗ Intersect']]) g.append(chip(lab, () => { IMP.op = k; renderUI(); xtPreview(); }, IMP.op === k)); panelEl.append(g); }
      panelEl.append(keep(slider(IMP.mode === 'offset' ? 'Offset distance' : 'Extrude distance', -10, 10, 0.1, () => IMP.d, v => { IMP.d = v; xtPreview(); if (rIn) rIn.value = xtNum(im.surf.r + IMP.d, 3); })));
      let rIn = null;
      if (cyl) { const w = keep(el('div', 'row')); const lab = el('span', 'note', 'CYLINDER RADIUS '); rIn = el('input', 'num'); rIn.type = 'number'; rIn.step = 'any'; rIn.inputMode = 'decimal'; rIn.value = xtNum(im.surf.r + IMP.d, 3); rIn.style.width = '90px';
        rIn.onchange = () => { const v = parseFloat(rIn.value); if (isFinite(v) && v > 0) { IMP.d = v - im.surf.r; renderUI(); xtPreview(); } }; lab.append(rIn); w.append(lab, el('span', 'note', `face radius ${xtNum(im.surf.r)} ${S.unit}`)); panelEl.append(w); }
      if (IMP.err) panelEl.append(keep(el('div', 'note', '⚠ ' + IMP.err)));
      const row = el('div', 'row scroll'); row.append(chip('Apply', xtImpApply, true), chip('Cancel', xtImpCancel)); panelEl.append(row);
    } else if (XI) {
      panelEl.replaceChildren(); panelEl.hidden = false; const b = xtBody(XI.bodyId);
      hintEl.textContent = 'Imprinted face selected · Offset Face raises or sinks it, Extrude makes a body, a union, a cut or an intersection';
      const row = el('div', 'row scroll'); row.append(chip('Offset Face', () => startImp('offset'), true), chip('Extrude', () => startImp('extrude')), chip('Remove imprint', () => { const i = XI.idx; step(() => { S.bodies = S.bodies.map(q => q.id === b.id ? { ...q, imprints: xtImprints(q).filter((_, j) => j !== i) } : q); }, 'Remove imprint'); XI = null; commit(); }), chip('Deselect', () => { XI = null; syncScene(); })); panelEl.append(row);
    } else if (S.tool === 'select' && !FE && !MT && !IMG && !OP && !SCF && !SH && !FL && !RV && !LF && !SW && !TR && !OF && !S.imported && (S.selRegion >= 0 || S.selProfiles.length || selected())) {
      const row = el('div', 'row scroll'); row.append(chip('Project', startProject)); const b = selected();
      if (b && xtImprints(b).length) row.append(el('span', 'note', `${xtImprints(b).length} imprint${xtImprints(b).length === 1 ? '' : 's'} · tap one to offset or extrude it`));
      panelEl.hidden = false; panelEl.append(row);
    }
    xtStatus(); if (ITEMS) xtItems();
  }
  // ===================== v23 · Move/Rotate as in the video (0:58–1:16): relocate the gizmo, on-screen Copy, live rotating copy, keypad =====================
  var xtGh = null;
  /** The copy that turns with the finger while Copy is on (the original stays put): the body's own mesh, drawn again with the live matrix. */
  function xtGhost(host, M) {
    if (xtGh) { scene.remove(xtGh); xtGh.userData.mat && xtGh.userData.mat.dispose(); xtGh = null; }
    if (!host) { requestRender(); return; } const o = objects.get(host.id); if (!o) return;
    const mat = o.mesh.material.clone(); mat.color.setHex(host.color); if (mat.emissive) mat.emissive.setHex(0);
    o.mesh.material.color.setHex(host.color); if (o.mesh.material.emissive) o.mesh.material.emissive.setHex(0);   // while a copy is dragged off, the original shows as it is
    const g = new THREE.Group(); g.add(new THREE.Mesh(o.mesh.geometry, mat), new THREE.LineSegments(o.lines.geometry, o.lines.material)); g.userData.mat = mat;
    g.matrixAutoUpdate = false; g.matrix.fromArray(M); g.matrixWorldNeedsUpdate = true; scene.add(g); xtGh = g; requestRender();
  }
  // the gizmo's own buttons, drawn under its centre like Shapr3D: the relocate dot (drag it to move the gizmo) and Copy ⧉
  const XG_OFF = 54;
  const xgReloc = (() => { const b = document.createElement('button'); b.id = 'xt-reloc'; b.title = 'Drag to move the gizmo (snaps to circle centres, corners, edge middles, face centres)'; b.setAttribute('aria-label', 'Move gizmo'); b.hidden = true; document.body.appendChild(b); return b; })();
  const xgCopy = (() => { const b = document.createElement('button'); b.id = 'xt-copy'; b.title = 'Copy: the move or rotation makes a copy and leaves the original'; b.setAttribute('aria-label', 'Copy'); b.hidden = true; b.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15V7a2 2 0 0 1 2-2h8" fill="none" stroke="currentColor" stroke-width="2"/></svg>'; document.body.appendChild(b); return b; })();
  { const st = document.createElement('style'); st.textContent = `#xt-reloc, #xt-copy { position: fixed; z-index: 7; transform: translate(-50%, -50%); border-radius: 50%; cursor: pointer; padding: 0; touch-action: none; }
    #xt-reloc { width: 26px; height: 26px; border: 0; background: transparent; } #xt-reloc::after { content: ''; position: absolute; left: 50%; top: 50%; width: 12px; height: 12px; transform: translate(-50%, -50%); border-radius: 50%; background: #fff; border: 2.5px solid #2b3140; box-shadow: 0 1px 4px rgba(0,0,0,.3); }
    #xt-reloc.on::after { background: #f29a2e; } #xt-reloc[hidden], #xt-copy[hidden] { display: none; }
    #xt-copy { width: 30px; height: 30px; display: grid; place-items: center; border: 1.5px solid #8a93a3; background: var(--panel); color: var(--fg); box-shadow: 0 1px 5px rgba(0,0,0,.2); } #xt-copy.on { background: #2f6fed; border-color: #2f6fed; color: #fff; }
    #xt-kp { position: fixed; z-index: 30; width: 188px; background: #fffaf0; color: #1a1d24; border-radius: 10px; box-shadow: 0 10px 34px rgba(0,0,0,.28); overflow: hidden; font-family: ui-monospace, Menlo, Consolas, monospace; user-select: none; }
    #xt-kp[hidden] { display: none; } #xt-kp .t { font-size: 11px; letter-spacing: .06em; padding: 8px 10px 0; color: #5b6270; } #xt-kp .v { font-size: 22px; padding: 0 10px 6px; min-height: 30px; }
    #xt-kp .g { display: grid; grid-template-columns: repeat(4, 1fr); grid-template-rows: repeat(4, 40px); border-top: 1px solid #eadfca; }
    #xt-kp button { border: 0; border-right: 1px solid #eadfca; border-bottom: 1px solid #eadfca; background: transparent; font: inherit; font-size: 16px; color: #1a1d24; cursor: pointer; } #xt-kp button:active { background: #f1e6d0; }
    #xt-kp .ok { grid-column: 4; grid-row: 2 / span 3; background: #2fe07a; color: #0e3d22; font-size: 20px; } #xt-kp .c { color: #d0342c; }`; document.head.appendChild(st); }
  /** Shapr3D's number pad: title, the value as typed, ✓ applies (Enter too), C clears, ± flips the sign. */
  const xtKp = (() => { const d = document.createElement('div'); d.id = 'xt-kp'; d.hidden = true; document.body.appendChild(d); return d; })();
  let xtKpState = null;
  function xtKeypad(title, value, unit, at, onOk, onCancel) {
    xtKpState = { s: String(Math.round(value * 1000) / 1000), fresh: true, unit, onOk, onCancel };
    xtKp.replaceChildren(); const t = el('div', 't', title); const v = el('div', 'v'); const g = el('div', 'g'); xtKp.append(t, v, g);
    const show = () => { if (xtKpState) v.textContent = (xtKpState.s || '0') + (xtKpState.unit || ''); };
    const key = (lab, fn, cls) => { const b = el('button', cls || '', lab); b.onclick = ev => { ev.stopPropagation(); fn(); show(); }; g.append(b); return b; };
    const digit = k => () => { if (xtKpState.fresh) { xtKpState.s = ''; xtKpState.fresh = false; } if (k === '.' && xtKpState.s.includes('.')) return; xtKpState.s += k; };
    key('7', digit('7')); key('8', digit('8')); key('9', digit('9')); key('±', () => { xtKpState.fresh = false; xtKpState.s = xtKpState.s.startsWith('-') ? xtKpState.s.slice(1) : '-' + xtKpState.s; });
    key('4', digit('4')); key('5', digit('5')); key('6', digit('6')); key('✓', xtKpOk, 'ok');
    key('1', digit('1')); key('2', digit('2')); key('3', digit('3'));
    key('.', digit('.')); key('0', digit('0')); key('C', () => { xtKpState.s = ''; xtKpState.fresh = false; }, 'c');
    show(); xtKp.hidden = false; const w = 188, h = xtKp.offsetHeight || 220;
    xtKp.style.left = Math.max(8, Math.min(innerWidth - w - 8, at.x + 12)) + 'px'; xtKp.style.top = Math.max(70, Math.min(innerHeight - h - 8, at.y - h / 2)) + 'px';
  }
  function xtKpOk() { const st = xtKpState; if (!st) return; xtKp.hidden = true; xtKpState = null; const v = parseFloat(st.s); if (isFinite(v)) st.onOk(v); else if (st.onCancel) st.onCancel(); }
  function xtKpClose() { if (!xtKpState) return; const st = xtKpState; xtKp.hidden = true; xtKpState = null; if (st.onCancel) st.onCancel(); }
  addEventListener('keydown', e => { if (!xtKpState) return; if (/^[0-9.]$/.test(e.key)) { if (xtKpState.fresh) { xtKpState.s = ''; xtKpState.fresh = false; } if (!(e.key === '.' && xtKpState.s.includes('.'))) xtKpState.s += e.key; }
    else if (e.key === 'Backspace') { xtKpState.fresh = false; xtKpState.s = xtKpState.s.slice(0, -1); } else if (e.key === '-') { xtKpState.s = xtKpState.s.startsWith('-') ? xtKpState.s.slice(1) : '-' + xtKpState.s; } else if (e.key === 'Enter') { e.preventDefault(); xtKpOk(); return; } else if (e.key === 'Escape') { xtKpClose(); return; } else return;
    e.preventDefault(); xtKp.querySelector('.v').textContent = (xtKpState.s || '0') + (xtKpState.unit || ''); }, true);
  document.addEventListener('pointerdown', e => { if (xtKpState && !xtKp.contains(e.target) && e.target !== moveEl && e.target !== gizmoEl) xtKpClose(); }, true);
  // the value label after a drag opens the keypad (ROTATION 25° → type 20 → ✓)
  moveEl.onclick = () => {
    if (!MV || MV.drag || MV.mode === 'plane') return; const m = MV; const v0 = m.value; moveEditing = true; moveEl.className = 'live';
    const r = moveEl.getBoundingClientRect();
    xtKeypad(m.mode === 'rot' ? 'ROTATION' : 'DISTANCE', Math.abs(v0), m.mode === 'rot' ? '°' : ' ' + S.unit, { x: r.right, y: r.top + r.height / 2 }, v => {
      moveEditing = false; if (MV !== m) { syncScene(); return; } m.value = (v0 < 0 ? -1 : 1) * v; m.raw = m.value; m.lastKey = ''; applyMove(true);
      if (m.invalid) { toast("Operation failed because the resulting body wouldn't be valid"); m.value = v0; m.raw = v0; m.lastKey = ''; applyMove(true); }
      save(); syncScene(); requestRender(); }, () => { moveEditing = false; syncScene(); requestRender(); });
  };
  /** Places the relocate dot and the Copy button under the gizmo (every frame, from syncMoveGizmo). */
  function xtGizmoUi(t) {
    if (MV && MV.drag) { const v = MV.mode === 'rot' ? `${MV.value}°` : fmtDim(MV.mode === 'plane' ? Math.hypot(MV.du, MV.dv) : Math.abs(MV.value)); hintEl.textContent = `${v}${S.moveCopy && MV.target.kind === 'body' ? ' · Copy' : ''} · lift your finger or pen to set it`; }
    const show = S.tool === 'move' && t && (t.kind === 'body' || t.kind === 'face' || t.kind === 'profile') && MVX.grp.visible && !(histSheet && !histSheet.hidden);
    if (!show) { xgReloc.hidden = true; xgCopy.hidden = true; return; }
    const P = project(t.center); if (!P.ok) { xgReloc.hidden = true; xgCopy.hidden = true; return; }
    const y = Math.min(innerHeight - 200, P.y + XG_OFF);
    xgReloc.hidden = false; xgReloc.style.left = P.x + 'px'; xgReloc.style.top = y + 'px'; xgReloc.classList.toggle('on', !!GZR);
    const copyOk = t.kind === 'body' || t.kind === 'profile'; xgCopy.hidden = !copyOk || !!GZR; xgCopy.style.left = (P.x + 40) + 'px'; xgCopy.style.top = y + 'px'; xgCopy.classList.toggle('on', !!S.moveCopy);
  }
  xgCopy.onpointerdown = e => { e.stopPropagation(); };
  xgCopy.onclick = e => { e.stopPropagation(); if (MV && !MV.drag) endMove(); S.moveCopy = !S.moveCopy; toast(S.moveCopy ? 'Copy ON' : 'Copy OFF', 1400); renderUI(); requestRender(); };
  { let rd = null;
    xgReloc.onpointerdown = e => { e.preventDefault(); e.stopPropagation(); try { xgReloc.setPointerCapture(e.pointerId); } catch (er) { /* fine */ } if (MV) endMove();
      const t = liveTarget(); if (!t) return; rd = { id: e.pointerId, started: false, x: e.clientX, y: e.clientY }; };
    xgReloc.onpointermove = e => { if (!rd || e.pointerId !== rd.id) return; const x = e.clientX, y = e.clientY - XG_OFF;
      if (!rd.started) { if (Math.hypot(e.clientX - rd.x, e.clientY - rd.y) < 3) return; if (!beginGizmoRelocate({ mode: 'plane' }, rd.x, rd.y - XG_OFF)) { rd = null; return; } rd.started = true; }
      moveGizmoRelocate(x, y); requestRender(); };
    const up = e => { if (!rd || e.pointerId !== rd.id) return; const was = rd.started; rd = null; if (was) { const snapped = mvSnapAt; endGizmoRelocate(); mvSnapAt = null; showMvSnap(); toast(snapped ? 'Gizmo moved · it snapped onto the point — rotations now turn about it' : 'Gizmo moved · rotations now turn about it', 1800); } };
    xgReloc.onpointerup = up; xgReloc.onpointercancel = up; }
  /** Centres of the ends of every round wall (a cylinder's top and bottom on its axis), even where a rib breaks its rim circle. */
  function xtAxisCentres(md) { const out = []; if (!md.surfs || !C.surfCylinder) return out;
    md.surfs.forEach((sf, i) => { if (sf.planar) return; let q = null; try { q = C.surfCylinder(md, i); } catch (e) { q = null; } if (!q || !(q.r > 0)) return; for (const h of [q.h0, q.h1, (q.h0 + q.h1) / 2]) out.push([q.c[0] + q.a[0] * h, q.c[1] + q.a[1] * h, q.c[2] + q.a[2] * h]); });
    return out; }
  // the extrusion's distance label opens the EXTRUSION keypad (video 0:20: type 33 → ✓)
  { const st = document.createElement('style'); st.textContent = '#gizmo-label.xt-tap { pointer-events: auto; cursor: pointer; text-decoration: underline dotted; }'; document.head.appendChild(st); }
  setInterval(() => { try { gizmoEl.classList.toggle('xt-tap', !!(SESSION && !SESSION.drag && !gizmoEl.hidden && SESSION.drag !== 'draft')); } catch (e) { /* not ready */ } }, 200);
  gizmoEl.onclick = ev => { ev.stopPropagation(); if (!SESSION || SESSION.drag) return; const s0 = SESSION; const v0 = s0.value || 0; const r = gizmoEl.getBoundingClientRect();
    xtKeypad('EXTRUSION', Math.abs(v0), ' ' + S.unit, { x: r.right, y: r.top + r.height / 2 }, v => { if (SESSION !== s0) return; s0.value = (v0 < 0 ? -1 : 1) * Math.abs(v); s0.lastKey = ''; applySession(true); syncScene(); requestRender(); }); };
  // ---------- History: pick the body a step made ----------
  function xtStepBodies(i) {
    const now = snapshot(); const before = H.past[i]; const after = H.past[i + 1] || now; if (!before || !after) return [];
    const old = new Map(before.bodies.map(b => [b.id, b])); return after.bodies.filter(b => !old.has(b.id) || old.get(b.id).man !== b.man).map(b => b.id).filter(id => S.bodies.some(q => q.id === id && !q.hidden));
  }
  function xtHistBtn(rowEl, i) {
    if (i >= H.past.length) return; const ids = xtStepBodies(i); if (!ids.length) return;
    const b = document.createElement('button'); b.className = 'xt-hsel'; b.textContent = ids.length === 1 ? 'Select' : `Select ${ids.length}`; b.title = 'Select the body this step made or changed';
    b.onclick = ev => { ev.stopPropagation(); const id = ids[ids.length - 1]; const keepMove = S.tool === 'move'; if (!keepMove && S.tool !== 'select') setTool('select');
      if (MV) endMove(); S.selectedId = id; S.selectedFace = null; S.moveSurf = null; S.faceTool = false; S.selProfiles = []; histSheet.hidden = true; syncScene(); renderUI(); toast(`${(S.bodies.find(q => q.id === id) || { name: 'Body' }).name} selected`); };
    rowEl.append(b);
  }
  { const st = document.createElement('style'); st.textContent = `.xt-hsel { margin-left: auto; border: 1px solid #5c9eed; background: transparent; color: #5c9eed; border-radius: 999px; font: inherit; font-size: 12.5px; font-weight: 600; padding: 3px 10px; cursor: pointer; } .hist-item.current .xt-hsel { color: #fff; border-color: #fff; }`; document.head.appendChild(st); }

  if (location.hash === '#debug') window.__xt = { S, C, get PJ() { return PJ; }, get XI() { return XI; }, get IMP() { return IMP; }, get UB() { return UB; }, startProject, xtProjectDone, startImp, xtImpApply, startUB, xtUBDone, xtTap, xtTool, xtResult, xtSurfOf, xtImprints, syncScene, setTool, renderUI, project, setIMP: (k, v) => { IMP[k] = v; xtPreview(); renderUI(); }, pjAdd: it => { it.key = xtKey(it); PJ.items.push(it); syncScene(); }, pjTarget: (bodyId, faceId) => { PJ.target = { bodyId, faceId }; syncScene(); }, cam: () => cam, get MV() { return MV; }, get GZR() { return GZR; }, liveTarget, hitMoveGizmo, xtKeypad, xtKpOk, addBody, fitAll, onTap, pick, rayAt, makeBodyRecord, commit };

  $('undo').onclick = undo; $('redo').onclick = redo; $('del').onclick = deleteSelected;
  const menu = $('menu'); $('more').onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener('click', e => { if (!menu.contains(e.target) && e.target !== $('more')) menu.hidden = true; });
  $('m-export').onclick = () => { menu.hidden = true; exportModel(); };
  $('m-export-dxf').onclick = () => { menu.hidden = true; exportDxf(); };
  $('m-import').onclick = () => { menu.hidden = true; fileInput.click(); };
  $('m-paste').onclick = () => { menu.hidden = true; $('paste').hidden = false; $('paste-text').value = ''; $('paste-text').focus(); };
  $('paste-go').onclick = () => { const t = $('paste-text').value; $('paste').hidden = true; if (t.trim()) importFromText(t); };
  $('paste-cancel').onclick = () => { $('paste').hidden = true; };
  $('m-clear').onclick = () => { menu.hidden = true; clearAll(); };
  { const bt = document.createElement('button'); bt.id = 'm-keepsketch'; const ref = $('m-clear'); bt.className = ref.className; const label = () => { bt.textContent = `Keep sketch when leaving: ${keepSketch ? 'on' : 'off'}`; }; label();
    bt.onclick = () => { keepSketch = !keepSketch; try { localStorage.setItem('ss.keepSketch', keepSketch ? '1' : '0'); } catch (e) { /* private mode */ } label(); menu.hidden = true; toast(keepSketch ? 'Your sketch lines stay when you switch to Select or Move/Rotate' : 'Leaving the sketch tools now clears the sketch (Undo brings it back)'); };
    ref.parentNode.insertBefore(bt, ref); }
  // ---------- Exact engine (OpenCascade, beta) ----------
  // An exact body keeps a recipe: a base prism (a circle, ellipse or polygon on a plane, pushed a height along the plane's
  // normal) and the prisms cut from it. OpenCascade builds it as true surfaces (a cylinder is a cylinder), which are then
  // meshed very finely for display, and its edges are drawn from the exact curves. The recipe is valid only while the body
  // still holds the solid it produced: any other tool changes the solid, and the body simply carries on as a mesh body.
  const X = { on: false, oc: null, loading: null };
  /**
   * One way of calling OpenCascade for every build. The full OCCT 7.6 build (opencascade.js) names each overload with a
   * number — gp_Pnt_3, TopoDS.Face_1, shape.Orientation_1 — where the slim build has one plain name. Where only numbered
   * names exist, the plain name becomes a dispatcher that tries each numbered one in turn: the bindings check the argument
   * count and types before running anything, so the first that accepts the arguments is the right overload.
   */
  function occCompat(oc) {
    const variants = (obj, name) => { const v = []; for (let i = 1; i <= 24; i++) { const f = obj[name + '_' + i]; if (typeof f === 'function') v.push(f); } return v; };
    const tryAll = (fs, call) => { let last; for (const f of fs) { try { return call(f); } catch (e) { last = e; } } throw last || new Error('No matching OpenCascade call'); };
    const keys = Object.keys(oc); const numbered = new Set(); for (const k of keys) { const m = /^(.+)_(\d+)$/.exec(k); if (m) numbered.add(m[1]); }
    for (const base of numbered) { const vs = variants(oc, base); if (!vs.length) continue; const orig = oc[base];
      const D = function (...a) { return tryAll(vs, V => new V(...a)); }; if (orig && orig.prototype) D.prototype = orig.prototype; else D.prototype = vs[0].prototype;
      if (orig) for (const sk of Object.getOwnPropertyNames(orig)) { if (!(sk in D)) { try { D[sk] = orig[sk]; } catch (e) { /* read-only */ } } }
      try { oc[base] = D; } catch (e) { /* keep */ } }
    const patchMethods = obj => { if (!obj) return; const names = Object.getOwnPropertyNames(obj); const bases = new Set(); for (const n of names) { const m = /^(.+)_(\d+)$/.exec(n); if (m) bases.add(m[1]); }
      for (const b of bases) { if (typeof obj[b] === 'function') continue; const vs = variants(obj, b); if (!vs.length) continue; try { Object.defineProperty(obj, b, { value: function (...a) { return tryAll(vs, f => f.apply(this, a)); }, configurable: true, writable: true }); } catch (e) { /* keep */ } } };
    for (const k of keys) { const c = oc[k]; if (typeof c !== 'function') continue; patchMethods(c); if (c.prototype) patchMethods(c.prototype); }
    return oc;
  }
  async function xLoad() {
    if (X.oc) return X.oc; if (X.loading) return X.loading;
    X.loading = (async () => { const txt = document.getElementById('occ-wasm-b64').textContent.trim(); const bin = atob(txt); const raw = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
      const buf = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      for (let i = 0; i < 200 && !window.__occModule; i++) await new Promise(r => setTimeout(r, 50)); if (!window.__occModule) throw new Error('The exact engine did not load');
      X.oc = occCompat(await window.__occModule({ wasmBinary: new Uint8Array(buf) })); return X.oc; })();
    try { return await X.loading; } catch (e) { X.loading = null; throw e; }
  }
  const xValid = b => !!(b && b.occ && b.occ.man === b.man);
  const xP = (f, p, z = 0) => [f.origin[0] + f.u[0] * p[0] + f.v[0] * p[1] + f.n[0] * z, f.origin[1] + f.u[1] * p[0] + f.v[1] * p[1] + f.n[1] * z, f.origin[2] + f.u[2] * p[0] + f.v[2] * p[1] + f.n[2] * z];
  const xD = (f, d) => [f.u[0] * d[0] + f.v[0] * d[1], f.u[1] * d[0] + f.v[1] * d[1], f.u[2] * d[0] + f.v[2] * d[1]];
  /** A profile from sketch points: a circle (as an ellipse c + L·(cos t, sin t)) when they all lie on one, else a polygon. */
  function xProfile(pts) {
    if (!pts || pts.length < 3) return null; let cx = 0, cy = 0; for (const p of pts) { cx += p[0]; cy += p[1]; } cx /= pts.length; cy /= pts.length;
    const ds = pts.map(p => Math.hypot(p[0] - cx, p[1] - cy)); const r = ds.reduce((a, b) => a + b, 0) / ds.length;
    if (pts.length >= 24 && ds.every(d => Math.abs(d - r) < 2e-3 * r)) return { type: 'ell', c: [cx, cy], L: [r, 0, 0, r] };
    return { type: 'poly', pts: pts.map(p => [p[0], p[1]]) };
  }
  function xWire(oc, f, prof, z, xdir = null) {
    if (prof.type === 'ell') { const [a, b, c, d] = prof.L; const p = a * a + b * b, q = a * c + b * d, r = c * c + d * d; const m = (p + r) / 2, dd = Math.sqrt(((p - r) / 2) ** 2 + q * q);
      const s1 = Math.sqrt(m + dd), s2 = Math.sqrt(Math.max(0, m - dd)); if (!(s2 > 1e-9)) throw new Error('That flattens the shape'); const ang = 0.5 * Math.atan2(2 * q, p - r);
      let xd = xD(f, [Math.cos(ang), Math.sin(ang)]); if (xdir && Math.abs(s1 - s2) < 1e-9 * s1) { const k = xdir[0] * f.n[0] + xdir[1] * f.n[1] + xdir[2] * f.n[2]; const w = [xdir[0] - f.n[0] * k, xdir[1] - f.n[1] * k, xdir[2] - f.n[2] * k]; const l = Math.hypot(w[0], w[1], w[2]); if (l > 1e-9) xd = w.map(x => x / l); }   // a circle can start anywhere: line it up with the other outline
      const ax = new oc.gp_Ax2(new oc.gp_Pnt(...xP(f, prof.c, z)), new oc.gp_Dir(...f.n), new oc.gp_Dir(...xd));
      const e = Math.abs(s1 - s2) < 1e-9 * s1 ? new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Circ(ax, s1)).Edge() : new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Elips(ax, s1, s2)).Edge();
      return new oc.BRepBuilderAPI_MakeWire(e).Wire(); }
    const mw = new oc.BRepBuilderAPI_MakeWire(); const P = prof.pts;
    for (let i = 0; i < P.length; i++) { const A = xP(f, P[i], z), B = xP(f, P[(i + 1) % P.length], z); if (Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]) < 1e-9) continue; mw.Add(new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Pnt(...A), new oc.gp_Pnt(...B)).Edge()); }
    if (!mw.IsDone()) throw new Error('The outline is not closed'); return mw.Wire();
  }
  /** A prism: the profile on the plane at z0 along its normal, pushed h (either way). */
  function xPrism(oc, it) { const lo = Math.min(it.z0, it.z0 + it.h), hi = Math.max(it.z0, it.z0 + it.h); const face = new oc.BRepBuilderAPI_MakeFace(xWire(oc, it.frame, it.prof, lo), true).Face();
    return new oc.BRepPrimAPI_MakePrism(face, new oc.gp_Vec(it.frame.n[0] * (hi - lo), it.frame.n[1] * (hi - lo), it.frame.n[2] * (hi - lo)), false, true).Shape(); }
  const xOps = rec => rec.ops || (rec.cuts || []).map(c => ({ kind: 'cut', ...c }));
  /** The major-axis direction an ellipse outline starts from (in world space). */
  function xStartDir(f, prof) { if (prof.type !== 'ell') return null; const [a, b, c, d] = prof.L; const p = a * a + b * b, q = a * c + b * d, r = c * c + d * d; const ang = 0.5 * Math.atan2(2 * q, p - r); return xD(f, [Math.cos(ang), Math.sin(ang)]); }
  /** A ruled loft between two outlines (the cone a lift makes, from the body's rim to the raised hole). */
  function xLoft(oc, op) { const d1 = xStartDir(op.f1, op.p1); const w0 = xWire(oc, op.f0, op.p0, op.z0, d1), w1 = xWire(oc, op.f1, op.p1, op.z1, d1);
    const ts = new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6); ts.AddWire(w0); ts.AddWire(w1); const pr = new oc.Message_ProgressRange(); ts.Build(pr); if (!ts.IsDone()) throw new Error('The exact lift could not be built'); return ts.Shape(); }
  function xShape(rec) { const oc = X.oc; let sh = xPrism(oc, rec.base);
    for (const o of xOps(rec)) { const pr = new oc.Message_ProgressRange(); const op = o.kind === 'loft' ? new oc.BRepAlgoAPI_Fuse(sh, xLoft(oc, o), pr) : new oc.BRepAlgoAPI_Cut(sh, xPrism(oc, o), pr); op.Build(pr); if (!op.IsDone()) throw new Error('The exact ' + (o.kind === 'loft' ? 'lift' : 'cut') + ' failed'); sh = op.Shape(); }
    try { const u = new oc.ShapeUpgrade_UnifySameDomain(sh, true, true, false); u.Build(); sh = u.Shape(); } catch (e) { /* keep as is */ }
    return sh; }
  /** Build a recipe: { man, md } — a fine display mesh (true surfaces, sagitta ≤ 0.02% of the size) and exact edges. */
  function xMake(rec) {
    const oc = X.oc; const sh = xShape(rec);
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    const grow = p => { for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; } };
    { const pts = [xP(rec.base.frame, [0, 0], rec.base.z0), xP(rec.base.frame, [0, 0], rec.base.z0 + rec.base.h)]; if (rec.base.prof.type === 'ell') { const L = rec.base.prof.L; const R = Math.hypot(L[0], L[1]) + Math.hypot(L[2], L[3]); for (const sx of [-R, R]) for (const sy of [-R, R]) pts.push(xP(rec.base.frame, [rec.base.prof.c[0] + sx, rec.base.prof.c[1] + sy], rec.base.z0)); } else for (const q of rec.base.prof.pts) pts.push(xP(rec.base.frame, q, rec.base.z0));
      for (const o of xOps(rec)) if (o.kind === 'loft') pts.push(xP(o.f1, o.p1.type === 'ell' ? o.p1.c : o.p1.pts[0], o.z1)); pts.forEach(grow); }
    const size = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
    new oc.BRepMesh_IncrementalMesh(sh, 2e-4 * size, false, 0.03, false);
    const vp = [], tv = [], fidL = []; let fno = 0; const ex = new oc.TopExp_Explorer(sh, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; ex.More(); ex.Next(), fno++) { const face = oc.TopoDS.Face(ex.Current()); const loc = new oc.TopLoc_Location(); const h = oc.BRep_Tool.Triangulation(face, loc, 0); if (!h || (h.IsNull && h.IsNull())) continue; const T = typeof h.get === 'function' ? h.get() : h; const tr = loc.Transformation();
      const base = vp.length / 3; for (let i = 1; i <= T.NbNodes(); i++) { const q = T.Node(i).Transformed(tr); vp.push(q.X(), q.Y(), q.Z()); }
      const rev = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      for (let i = 1; i <= T.NbTriangles(); i++) { const t = T.Triangle(i); const a = t.Value(1) - 1, b = t.Value(2) - 1, c = t.Value(3) - 1; if (rev) tv.push(base + a, base + c, base + b); else tv.push(base + a, base + b, base + c); fidL.push(fno); } }
    const man = C.fromTriangles(new Float32Array(vp), new Uint32Array(tv), new Uint32Array(fidL)); const md = C.meshData(man);
    // faces are the exact engine's own faces: each true CAD face is one face here, whatever its shape
    try { C.facesByID(man, md); } catch (e) { console.warn('exact faces', e); }
    // edges from the exact curves, finely sampled
    const E = []; const ee = new oc.TopExp_Explorer(sh, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); const seen = new Set();
    for (const edge of xDrawEdges(oc, sh)) { let g; try { g = new oc.GCPnts_TangentialDeflection(new oc.BRepAdaptor_Curve(edge), 0.02, 5e-5 * size, 2, 1e-9, 1e-7); } catch (e) { continue; } const n = g.NbPoints(); if (n < 2) continue;
      const P = []; for (let i = 1; i <= n; i++) { const q = g.Value(i); P.push([q.X(), q.Y(), q.Z()]); } const k = P[0].map(x => x.toFixed(5)).join() + '|' + P[n - 1].map(x => x.toFixed(5)).join() + '|' + n; if (seen.has(k)) continue; seen.add(k);
      for (let i = 0; i + 1 < n; i++) E.push(...P[i], ...P[i + 1]); }
    if (E.length) md.edges = new Float32Array(E);
    xShapes.set(man, { sh, size });   // kept: the display is re-meshed finer from it when zoomed in
    return { man, md };
  }
  /** The edges worth drawing: each once, and not the seam where a round face's surface closes on itself (an edge met twice
   *  inside one face) — that is bookkeeping, not an edge of the body, and CAD apps never draw it. */
  function xDrawEdges(oc, sh) {
    const keyOf = e => { const ad = new oc.BRepAdaptor_Curve(e); const a = ad.FirstParameter(), b = ad.LastParameter(); const P = [a, (a + b) / 2, b].map(u => { const p = ad.Value(u); return [p.X(), p.Y(), p.Z()].map(x => x.toFixed(4)).join(','); }); const ends = [P[0], P[2]].sort(); return ends[0] + '|' + P[1] + '|' + ends[1]; };
    const seam = new Set(); const fx = new oc.TopExp_Explorer(sh, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; fx.More(); fx.Next()) { const cnt = new Map(); const ex = new oc.TopExp_Explorer(fx.Current(), oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); for (; ex.More(); ex.Next()) { let k; try { k = keyOf(oc.TopoDS.Edge(ex.Current())); } catch (e) { continue; } cnt.set(k, (cnt.get(k) || 0) + 1); } for (const [k, c] of cnt) if (c > 1) seam.add(k); }
    const out = [], seen = new Set(); const ee = new oc.TopExp_Explorer(sh, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; ee.More(); ee.Next()) { const e = oc.TopoDS.Edge(ee.Current()); let k; try { k = keyOf(e); } catch (er) { out.push(e); continue; } if (seam.has(k) || seen.has(k)) continue; seen.add(k); out.push(e); }
    return out;
  }
  const xShapes = new WeakMap();   // body solid → the exact OpenCascade solid behind it
  /** Display geometry from the exact solid at deflection defl: faces meshed separately (smooth inside a face, crisp at
   *  its edges) and edges sampled from the exact curves to the same tolerance. */
  function xFine(sh, defl, size) {
    const oc = X.oc; const ang = Math.min(0.03, Math.max(0.002, 2 * Math.sqrt(2 * defl / (0.05 * size))));   // the angle limit shrinks with the zoom too
    try { oc.BRepTools.Clean(sh, true); } catch (e) { try { oc.BRepTools.Clean(sh); } catch (e2) { /* keep */ } }
    new oc.BRepMesh_IncrementalMesh(sh, defl, false, ang, false);
    const pos = [], idx = []; const ex = new oc.TopExp_Explorer(sh, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; ex.More(); ex.Next()) { const face = oc.TopoDS.Face(ex.Current()); const loc = new oc.TopLoc_Location(); const h = oc.BRep_Tool.Triangulation(face, loc, 0); if (!h || (h.IsNull && h.IsNull())) continue; const T = typeof h.get === 'function' ? h.get() : h; const tr = loc.Transformation();
      const base = pos.length / 3; for (let i = 1; i <= T.NbNodes(); i++) { const q = T.Node(i).Transformed(tr); pos.push(q.X(), q.Y(), q.Z()); } const rev = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      for (let i = 1; i <= T.NbTriangles(); i++) { const t = T.Triangle(i); const a = t.Value(1) - 1, b = t.Value(2) - 1, c = t.Value(3) - 1; if (rev) idx.push(base + a, base + c, base + b); else idx.push(base + a, base + b, base + c); } }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3)); g.setIndex(idx.length > 65535 ? new THREE.BufferAttribute(new Uint32Array(idx), 1) : new THREE.BufferAttribute(new Uint16Array(idx), 1)); g.computeVertexNormals();
    const E = []; const ee = new oc.TopExp_Explorer(sh, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (const edgeD of xDrawEdges(oc, sh)) { let gd; try { gd = new oc.GCPnts_TangentialDeflection(new oc.BRepAdaptor_Curve(edgeD), ang, defl, 2, 1e-9, 1e-7); } catch (e) { continue; } const n = gd.NbPoints(); let prev = null; for (let i = 1; i <= n; i++) { const q = gd.Value(i); const cur = [q.X(), q.Y(), q.Z()]; if (prev) E.push(...prev, ...cur); prev = cur; } }
    return { g, edges: new Float32Array(E), tris: idx.length / 3 };
  }
  /** After the camera settles: each exact body on screen is re-meshed so its error stays under about half a pixel. */
  let xRefineTimer = 0, xRefining = false;
  function xScheduleRefine() { if (!X.oc || xRefining) return; clearTimeout(xRefineTimer); xRefineTimer = setTimeout(xRefine, 350); }
  function xRefine() {
    if (!X.oc) return; xRefining = true;
    try { for (const b of S.bodies) { if (!xValid(b)) continue; const o = objects.get(b.id); const ent = xShapes.get(b.man); if (!o || !ent) continue;
        const bb = b.man.boundingBox(); const c = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2]; const cp = camera.position;
        const dist = Math.max(1e-3 * ent.size, Math.hypot(cp.x - c[0], cp.y - c[1], cp.z - c[2]) - ent.size / 2); const wpp = 2 * dist * Math.tan((camera.fov || 45) * Math.PI / 360) / Math.max(1, innerHeight);
        const defl = Math.min(2e-4 * ent.size, Math.max(2e-6 * ent.size, 0.5 * wpp)); if (o.xDefl && defl > 0.7 * o.xDefl && defl < 2.5 * o.xDefl) continue;
        // one meshing, not trial and error: triangles grow about as 1/detail, so the last mesh says how fine the budget allows
        const n0 = o.xTris || (b.md.surfID ? b.md.surfID.length : 0), d0 = o.xDefl || 2e-4 * ent.size; let dd = defl; if (n0 > 0) dd = Math.max(defl, d0 * n0 / 120000);
        if (o.xDefl && dd > 0.8 * o.xDefl && dd < 1.25 * o.xDefl) continue;
        let f = xFine(ent.sh, dd, ent.size); if (f.tris > 150000) { f.g.dispose(); dd *= 1.8 * f.tris / 150000; f = xFine(ent.sh, dd, ent.size); }   // a phone budget
        if (f.tris > 150000) { f.g.dispose(); continue; } if (o.xDefl && Math.abs(dd - o.xDefl) < 0.05 * o.xDefl) { f.g.dispose(); continue; }
        o.mesh.geometry.dispose(); o.mesh.geometry = f.g; o.lines.geometry.dispose(); const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(f.edges, 3)); o.lines.geometry = lg; o.xDefl = dd; o.xTris = f.tris; } }
    catch (e) { console.warn('exact refine', e); /* the coarser display stays */ }
    xRefining = false; requestRender();
  }
  /** Lift: a round hole of an exact body moved straight out of the face it was cut from. The ring round it becomes a cone
   *  (a ruled loft from the body's rim to the raised hole) and the hole goes up with its floor — the same length. */
  function xMoveCapture() { if (!X.on || !X.oc || !MV || MV.target.kind !== 'face') return null; const host = MV.before.find(b => b.id === MV.target.bodyId); if (!xValid(host)) return null; return { host, surf: MV.target.surf, M: deltaMatrix(MV) }; }
  function xAfterMove(info) {
    const { host, M, surf } = info; if ([M[0] - 1, M[5] - 1, M[10] - 1, M[1], M[2], M[4], M[6], M[8], M[9]].some(v => Math.abs(v) > 1e-9)) return;   // a turn: not a lift
    const T = [M[12], M[13], M[14]]; if (!(Math.hypot(T[0], T[1], T[2]) > 1e-9)) return; const rec = xRec(host); const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    const sf = host.md.surfs && host.md.surfs[surf]; const sc = sf ? sf.c : null; let best = -1, bd = Infinity;
    rec.ops.forEach((o, i) => { if (o.kind !== 'cut' || o.prof.type !== 'ell') return; const n = o.frame.n; const d = dot(T, n); const lat = Math.hypot(T[0] - n[0] * d, T[1] - n[1] * d, T[2] - n[2] * d); if (!(d > 0) || lat > 1e-6 * Math.abs(d)) return;
      let dd = 0; if (sc) { const c3 = xP(o.frame, o.prof.c); const w = [sc[0] - c3[0], sc[1] - c3[1], sc[2] - c3[2]]; const h = dot(w, n); dd = Math.hypot(w[0] - n[0] * h, w[1] - n[1] * h, w[2] - n[2] * h); } if (dd < bd) { bd = dd; best = i; } });
    if (best < 0) return; const op = rec.ops[best], B = rec.base; const n = op.frame.n; if (dot(B.frame.n, n) < 0.999999) return;
    const topB = dot(B.frame.origin, n) + Math.max(B.z0, B.z0 + B.h), plane = dot(op.frame.origin, n); if (Math.abs(topB - plane) > 1e-6 * Math.max(1, Math.abs(topB))) return;   // the hole must start on the top it lifts
    const d = dot(T, n); const loft = { kind: 'loft', f0: B.frame, p0: B.prof, z0: Math.max(B.z0, B.z0 + B.h), f1: op.frame, p1: op.prof, z1: d };
    rec.ops.splice(best, 1, loft, { ...op, z0: op.z0 + d });
    let res; try { res = xMake(rec); } catch (e) { toast('Exact lift: ' + ((e && e.message) || 'failed') + ' · kept the mesh result'); return; }
    xSet(host.id, rec, res); syncScene(); toast('Exact lift');
  }
  /** Put an exact result on a body (its recipe remembers the solid it made). */
  function xSet(id, rec, res) { S.bodies = S.bodies.map(b => b.id === id ? { ...b, man: res.man, md: res.md, occ: { ...rec, man: res.man } } : b); }
  const xRec = b => ({ base: b.occ.base, ops: xOps(b.occ).slice() });
  /** After an extrusion: a new body or a cut into an exact body is rebuilt exactly. */
  function xCapture() { if (!X.on || !X.oc || !SESSION || SESSION.target.kind !== 'region' || !(Math.abs(SESSION.value) > 1e-9)) return null; return { t: SESSION.target, v: SESSION.value, newIds: SESSION.newIds, before: SESSION.before, cutThrough: SESSION.cutThrough, didCut: SESSION.didCut }; }
  function xAfterExtrude(info) {
    const { t, v } = info; const regs = t.regions || []; if (regs.length !== 1 || (regs[0].holes && regs[0].holes.length)) return; const prof = xProfile(regs[0].outer); if (!prof || !t.frame) return;
    const frame = { origin: t.frame.origin, u: t.frame.u, v: t.frame.v, n: t.frame.n }; let done = 0;
    try {
      if (t.hostId == null && info.newIds && !info.cutThrough) { for (const id of info.newIds) { if (!S.bodies.some(b => b.id === id)) continue; const rec = { base: { frame, prof, z0: 0, h: v }, ops: [] }; xSet(id, rec, xMake(rec)); done++; } }
      else { const eps = 1e-4 * Math.abs(v); const targets = t.hostId != null ? [t.hostId] : info.before.map(b => b.id);
        for (const id of targets) { const old = info.before.find(b => b.id === id), now = S.bodies.find(b => b.id === id); if (!xValid(old) || !now || now.man === old.man || v > 0) continue;
          const rec = xRec(old); rec.ops.push({ kind: 'cut', frame, prof, z0: t.hostId != null ? eps : 0, h: t.hostId != null ? v - eps : v }); xSet(id, rec, xMake(rec)); done++; } }
    } catch (e) { toast('Exact engine: ' + ((e && e.message) || 'failed') + ' · kept the mesh result'); return; }
    if (done) { syncScene(); toast('Exact result'); }
  }
  /** Scale face on an exact body's round hole or wall: its circle or ellipse is scaled exactly (an ellipse stays an ellipse). */
  /** The exact scale result last built for the preview (Apply uses it when nothing has changed since). */
  let xPrev = null, xAfterDrag = false; const xScaleKey = b => b.id + '|' + SCF.sx + '|' + SCF.sy + '|' + SCF.uniform + '|' + (SCF.hole ? 'h' : 'w');
  function xApplyScale(b, preview = false) {
    const q = SCF.hole || SCF.wall; if (!q || !xValid(b)) return false; const rec = xRec(b);
    const pool = SCF.hole ? rec.ops.map((c, i) => ({ it: c, i })).filter(x => x.it.kind === 'cut') : [{ it: rec.base, i: -1 }];
    const a = q.a; let best = null, bd = Infinity;
    for (const { it, i } of pool) { if (it.prof.type !== 'ell') continue; const n = it.frame.n; if (Math.abs(n[0] * a[0] + n[1] * a[1] + n[2] * a[2]) < 0.999) continue; const c3 = xP(it.frame, it.prof.c); const w = [c3[0] - q.c[0], c3[1] - q.c[1], c3[2] - q.c[2]]; const h = w[0] * a[0] + w[1] * a[1] + w[2] * a[2]; const d = Math.hypot(w[0] - a[0] * h, w[1] - a[1] * h, w[2] - a[2] * h); if (d < bd) { bd = d; best = { it, i }; } }
    if (SCF.xItem !== undefined) { best = { it: SCF.xItem < 0 ? rec.base : rec.ops[SCF.xItem], i: SCF.xItem }; bd = 0; }   // the recipe item the tapped face was matched to
    if (!best || bd > 0.25 * (q.r || 1)) return false;
    const M = holeScaleMatrix(q, SCF.sx, SCF.uniform ? SCF.sx : SCF.sy, 1); const lin = d => [M[0] * d[0] + M[4] * d[1] + M[8] * d[2], M[1] * d[0] + M[5] * d[1] + M[9] * d[2], M[2] * d[0] + M[6] * d[1] + M[10] * d[2]];
    const f = best.it.frame; const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2]; const Lu = lin(f.u), Lv = lin(f.v); const S2 = [dot(f.u, Lu), dot(f.u, Lv), dot(f.v, Lu), dot(f.v, Lv)];
    const L = best.it.prof.L; const L2 = [S2[0] * L[0] + S2[1] * L[2], S2[0] * L[1] + S2[1] * L[3], S2[2] * L[0] + S2[3] * L[2], S2[2] * L[1] + S2[3] * L[3]];
    const am = (x, y, z) => [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]]; const c3 = am(...xP(f, best.it.prof.c)); const w = [c3[0] - f.origin[0], c3[1] - f.origin[1], c3[2] - f.origin[2]];
    const nit = { ...best.it, prof: { type: 'ell', c: [dot(w, f.u), dot(w, f.v)], L: L2 } };
    if (best.i < 0) rec.base = nit; else rec.ops[best.i] = nit;
    const key = xScaleKey(b); let res = xPrev && xPrev.key === key && xPrev.man === b.man ? xPrev.res : null;
    if (!res) { try { res = xMake(rec); } catch (e) { if (!preview) toast('Exact engine: ' + ((e && e.message) || 'failed')); return false; } }
    if (preview) { xPrev = { key, man: b.man, res }; return res; }
    pushUndo(); xSet(b.id, rec, res); SCF = null; HSD = null; ofClear(); scShowBody(); S.selectedFace = null; commit(); toast('Face scaled · exact'); renderUI(); return true;
  }
  /** Cylinder and Box tools: exact bodies when the exact engine is on. */
  function xTool(kind, x, y) { const frame = { origin: [x, y, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
    const rec = kind === 'cylinder' ? { base: { frame, prof: { type: 'ell', c: [0, 0], L: [2, 0, 0, 2] }, z0: 0, h: 4 }, ops: [] } : { base: { frame, prof: { type: 'poly', pts: [[-2, -2], [2, -2], [2, 2], [-2, 2]] }, z0: 0, h: 4 }, ops: [] };
    const res = tryGeom(() => xMake(rec)); if (!res) return false; const b = addBody(kind === 'cylinder' ? 'Cylinder' : 'Box', res.man); xSet(b.id, rec, res); syncScene(); return true; }
  $('m-exact').onclick = async () => { menu.hidden = true;
    if (X.on) { X.on = false; try { localStorage.setItem('ss-exact', 'off'); } catch (e) { /* private mode */ } $('m-exact').textContent = $('m-exact').textContent.replace(/: on$/, ': off'); toast('Exact engine off · new work uses the mesh engine'); return; }
    try { if (!X.oc) toast('Loading the exact engine… (a few seconds the first time)'); await xLoad(); X.on = true; try { localStorage.setItem('ss-exact', 'on'); } catch (e) { /* private mode */ } $('m-exact').textContent = $('m-exact').textContent.replace(/: off$/, ': on'); toast('Exact engine on · cylinders, boxes, extrusions, hole cuts and Scale face are exact'); }
    catch (e) { toast('The exact engine could not start: ' + ((e && e.message) || e)); } };
  $('m-reset').onclick = () => { menu.hidden = true; zoomTo(null); };
  $('m-section').onclick = () => { menu.hidden = true; toggleSection(); };
  $('m-help').onclick = () => { menu.hidden = true; $('help').hidden = false; };
  $('help-close').onclick = () => { $('help').hidden = true; };
  addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && e.shiftKey) { e.preventDefault(); redo(); return; } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); } if (e.key === 'Delete' || e.key === 'Backspace') { if (document.activeElement === document.body) deleteSelected(); } if (e.key === 'Escape') { if (MV) endMove(); S.pendingBool = null; S.faceTool = false; S.selectedFace = null; if (S.drawing) cancelDraw(); else if (S.lineStart) finishLine(); else clearSketch(); } });

  load();
  // The exact engine starts by itself (in the background: the mesh engine works meanwhile). Turning it off in ⋮ is remembered.
  { let want = true; try { want = localStorage.getItem('ss-exact') !== 'off'; } catch (e) { /* private mode */ }
    if (want) setTimeout(() => { xLoad().then(() => { X.on = true; const m = $('m-exact'); if (m) m.textContent = m.textContent.replace(/: off$/, ': on'); toast('Exact engine ready · new shapes are exact'); renderUI(); }).catch(() => { /* stays on the mesh engine */ }); }, 600); }
  syncScene();
  requestRender();
  if (location.hash === '#debug') window.__ss = { scaleFaceTest: (id, face) => startScaleFace(S.bodies.find(b => b.id === id), face), xPrevInfo: () => xPrev ? { faces: xPrev.res.md.surfs.length } : null, xLiftTest: (id, surf, dz) => { const host = S.bodies.find(b => b.id === id); xAfterMove({ host, surf, M: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,dz,1] }); const nb = S.bodies.find(b => b.id === id); return { exact: xValid(nb), faces: nb.md.surfs.length, vol: +nb.man.volume().toFixed(3) }; }, X: () => X, xRefine, xShapes: () => xShapes, xLoad, xMake, xValid, xProfile, scfProbe: (sx, sy) => { if (!SCF || !SCF.wall) return 'no wall'; const b = S.bodies.find(x => x.id === SCF.id); const surf = C.surfOfFace(b.md, SCF.face); const M = holeScaleMatrix(SCF.wall, sx, sy, 1); let w; try { w = C.scaleWall(b.man, b.md, surf, M, SCF.wall); } catch (e) { return 'throw ' + e.message; } const cnt = m => m && m.ok ? C.meshData(m.solid).surfs.length : (m ? 'refused' : 'null'); const up = { ...SCF.wall, a: SCF.wall.a.map(x => -x) }; const Mx = [sx,0,0,0, 0,sy,0,0, 0,0,1,0, 0,0,0,1]; return { appFrame: cnt(w), flippedAxis: cnt(C.scaleWall(b.man, b.md, surf, M, up)), plainXY: cnt(C.scaleWall(b.man, b.md, surf, Mx, up)), M: Array.from(M).map(x => +(+x).toFixed(3)).join(','), u: SCF.wall.u.map(x => +x.toFixed(3)), frame: { c: SCF.wall.c.map(x => +x.toFixed(2)), a: SCF.wall.a.map(x => +x.toFixed(3)) } }; }, hsgCentre: () => { const F = hsgFrame(); return F ? project(F.q.c) : null; }, hsgTips: () => { const F = hsgFrame(); if (!F) return null; const { q, wpp, ax } = F; return ax.map(d => project([q.c[0] + d[0] * HSG.L * wpp, q.c[1] + d[1] * HSG.L * wpp, q.c[2] + d[2] * HSG.L * wpp])); }, scf: () => SCF ? { wall: !!SCF.wall, hole: !!SCF.hole, cyl: !!SCF.cyl, curved: !!SCF.curved, sx: SCF.sx, sy: SCF.sy } : null,  disableHover: () => { window.__noHover = true; }, frameParts: () => { const t = f => { const t0 = performance.now(); f(); return +(performance.now() - t0).toFixed(1); }; return { updateCamera: t(updateCamera), syncGizmo: t(syncGizmo), render: t(() => renderer.render(scene, camera)), updateOverlays: t(updateOverlays) }; }, edgeAtNow: (x, y, t) => edgeAt(x, y, t), pointUnder: (x, y) => pointUnder(x, y), sceneBoundsNow: () => sceneBounds(), hoverTargetAt: (x, y) => hoverTargetAt(x, y), get TR() { return TR; }, hoverInfo: () => HOV ? { ...HOV } : null, hoverColour: () => '#' + HOVER_COL.toString(16), selectionColour: '#38bdf0', save: () => save(), sketchLinesShown: () => looseLines.visible || true ? (looseLines.geometry.attributes.position ? looseLines.geometry.attributes.position.count / 2 : 0) : 0, profGhostShown: () => !!profGhost, profCentreAtDbg: (x, y) => { const q = profCentreAt(x, y); return q ? q.id : null; }, profCentreMarks: () => profCentreMarks.visible ? profCentreMarks.userData.count : 0, circleEdgeAt: (x, y) => { const c = circleEdgeAt(x, y); return c && { c: c.c, r: c.r }; }, circleCentreAt: (x, y) => { const c = circleCentreAt(x, y); return c && { c: c.c, r: c.r }; }, selCentreShown: () => selCentreMark.visible, worldLines: () => worldLines(), linePick: (x, y) => linePicker()(x, y), camPick: (x, y) => camPick(x, y), circlesFound: () => circlesIn(allSketchSegs()).map(c => ({ c: c.c.map(v => +v.toFixed(3)), r: +c.r.toFixed(3), n: c.n })), circleCentreMarks: () => centreMarks.visible ? centreMarks.userData.count : 0, reshapeAt: (x, y) => sketchReshapeAt(x, y), pathSegAt: (x, y) => pathSegAt(x, y), get SW() { return SW; }, swBuild: () => swBuild(), orbitState: () => ({ pivot: orbitAbout, body: orbitBody ? orbitBody.name : null }), camInside: () => { const cp = camera.position; return S.bodies.filter(b => insideBody(b.md, [cp.x, cp.y, cp.z])).map(b => b.name); }, insideBody: (md, q) => insideBody(md, q), get renderer() { return renderer; }, get camera() { return camera; }, get scene() { return scene; }, skGhostShown: () => !!skGhost, selBand: () => { const P = selSegLine.geometry.attributes.position; if (!P || !selSegLine.visible) return null; let x = 0, y = 0; for (let k = 0; k < P.count; k++) { x += P.getX(k) / P.count; y += P.getY(k) / P.count; } return [x, y]; }, skGhost: () => !!skGhost, vertexAt: (x, y) => vertexAt(x, y), lineAt: (x, y) => lineAt(x, y), profileAt: (x, y) => { const pp = profileUnder(rayAt(x, y)); return pp ? pp.id : null; }, get LF() { return LF; }, step: (fn, label) => step(fn, label), setPanelOpen: v => { panelOpen = !!v; foldPanel(); }, get H() { return H; }, step: fn => step(fn), sketchSegs: () => sketchSegments(), regionCache: () => regionCache, pickPoint, rayAt, GZ, worldPerPx, hitMoveGizmo: (x, y) => hitMoveGizmo(x, y), renderUI: () => renderUI(), handleReach: tool => {
      const far = (c, pts) => { const P = project(c); let m = 0; for (const q of pts) { const Q = project(q); if (Q.ok) m = Math.max(m, Math.hypot(Q.x - P.x, Q.y - P.y)); } return 2 * m; };
      if (tool === 'move') { const t = liveTarget(); if (!t) return null; const F = mvFit(t); const L = (MVX.L + 20) * F.wpp; return { px: far(t.center, t.axes.flatMap(a => [[t.center[0] + a[0] * L, t.center[1] + a[1] * L, t.center[2] + a[2] * L], [t.center[0] - a[0] * MVX.R * F.wpp, t.center[1] - a[1] * MVX.R * F.wpp, t.center[2] - a[2] * MVX.R * F.wpp]])), f: F.f, atMin: F.f <= F.fMin + 1e-9 }; }
      if (tool === 'pushpull') { const t = gizmoTarget(); if (!t) return null; const F = gzFit(t); const n = t.frame.n; const L = GZ_REACH / 2 * F.wpp; return { px: far(t.center, [[t.center[0] + n[0] * L, t.center[1] + n[1] * L, t.center[2] + n[2] * L]]), f: F.f, atMin: F.f <= F.fMin + 1e-9 }; }
      if (tool === 'scale') { const hs = scHandles(); if (!hs) return null; const F = scFit(); return { px: far(SC.pivot, Object.keys(hs).map(k => hs[k].pos)), f: F.f, atMin: F.f <= F.fMin + 1e-9 }; }
      if (tool === 'fillet') { const h = filHandles(); if (!h) return null; const F = flFit(); const pts = [h.size.pos]; if (h.rho) pts.push(h.rho.pos, ...h.track); return { px: far(h.fr.p, pts) / 2, f: F.f, atMin: F.f <= F.fMin + 1e-9 }; }
      return null; }, liveTarget: () => liveTarget(), get FL() { return FL; }, get SC() { return SC; }, scHandleScreen, hitSc, scPlateScreen: h => typeof scPlateScreen === 'function' ? scPlateScreen(h) : null, H, FLX, THREE, filHandleScreen, filEffType, edgeAt, classifyStroke, S, get MV() { return MV; }, get SESSION() { return SESSION; }, hitGizmo, gizmoTarget, draftHandleWorld, GZ, hitMoveGizmo, project, liveTarget, worldPerPx, C, objects, rayAt, pick, MVX, syncScene, addBody, cam, zoomTo, requestRender, renderer, scene, camera, to3, plane, setTool, renderUI, animateCamera, setHeightTop: v => { S.height = v; } };
})();