import { open, drag, tap, tapOut, chip, typeSlider, panelText, state, camTo, fold, scr } from './lib.mjs';
// Builds the M12 bolt & nut of the Shapr3D video through SolidSketch's UI. REC=1 records a captioned video into $OUT/rec.
// Usage: python3 tools/build.py build/solidsketch.html && REC=1 node tools/demo/bolt-nut.mjs
import { mkdirSync } from 'node:fs';
const SP = process.env.OUT || 'demo-out'; mkdirSync(SP, { recursive: true }); const REC = !!process.env.REC; const STOP = process.env.STOP || '';
const { b, ctx, p } = await open(REC ? { ctx: { recordVideo: { dir: SP + '/rec', size: { width: 1280, height: 800 } } } } : {});
const log = async m => console.log(m, JSON.stringify((await state(p)).bodies.map(x => [x.name, x.vol, x.bb])));
const wait = ms => p.waitForTimeout(REC ? ms : Math.min(ms, 150));
await p.evaluate(() => { const d = document.createElement('div'); d.id = 'cap'; Object.assign(d.style, { position: 'fixed', left: '20px', top: '80px', maxWidth: '460px', padding: '10px 14px', background: 'rgba(15,20,30,0.82)', color: '#fff', font: '600 20px/1.3 -apple-system,Segoe UI,Roboto,sans-serif', borderRadius: '10px', zIndex: 99999, pointerEvents: 'none', whiteSpace: 'pre-line' }); d.hidden = true; document.body.append(d); });
await p.evaluate(() => {
  const c = document.createElement('div'); c.id = 'fakecur'; Object.assign(c.style, { position: 'fixed', width: '22px', height: '22px', marginLeft: '-11px', marginTop: '-11px', borderRadius: '50%', background: 'rgba(255,90,60,0.35)', border: '2px solid rgba(255,90,60,0.95)', zIndex: 100000, pointerEvents: 'none', left: '-50px', top: '-50px', transition: 'transform 0.12s' }); document.body.append(c);
  const mv = e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; };
  addEventListener('pointermove', mv, true); addEventListener('pointerdown', e => { mv(e); c.style.transform = 'scale(0.6)'; c.style.background = 'rgba(255,90,60,0.8)'; }, true); addEventListener('pointerup', () => { c.style.transform = ''; c.style.background = 'rgba(255,90,60,0.35)'; }, true);
  const t = document.createElement('div'); t.id = 'card'; Object.assign(t.style, { position: 'fixed', inset: '0', background: 'rgba(14,20,32,0.94)', color: '#fff', zIndex: 100001, display: 'none', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', font: '600 30px/1.4 -apple-system,Segoe UI,Roboto,sans-serif', whiteSpace: 'pre-line', pointerEvents: 'none' }); document.body.append(t); });
const card = async (t, ms = 3500) => { await p.evaluate(t => { const d = document.getElementById('card'); d.textContent = t; d.style.display = t ? 'flex' : 'none'; }, t); if (t) await wait(ms); };
const cap = async (t, ms = 1800) => { await p.evaluate(t => { const d = document.getElementById('cap'); d.textContent = t; d.hidden = !t; }, t); await wait(ms); };
const selBody = i => p.evaluate(i => { const s = window.__ss; s.S.selectedId = s.S.bodies[i].id; s.S.selectedFace = null; s.syncScene(); s.renderUI(); }, i);
const start = async (x, y) => { await typeSlider(p, 'Start X', x); await typeSlider(p, 'Start Y', y); await chip(p, 'Start here'); };
const line = async (L, a) => { await typeSlider(p, 'Length', L); await typeSlider(p, 'Angle °', a); await chip(p, 'Add line'); await wait(300); };

// 1. head
await card('SolidSketch v24\nM12 bolt & nut · pitch 1.75\n\nEvery step of the Shapr3D video\n"Bolt M12 2D to 3D drawing"\nredone in SolidSketch', 5000); await card('From the drawing: hex 19 across flats · head 8\nshank Ø12 × 80 · thread 60 mm, pitch 1.75\nnut 19 across flats × 7 · 30° chamfers', 4500); await card(''); await cap('SolidSketch · M12 bolt & nut, pitch 1.75', 1500);
await cap('1 · Polygon tool, 6 sides, on the Front plane  (video 0:40)'); await chip(p, 'Polygon'); await chip(p, 'Front (elevation)'); await wait(800);
await drag(p, [0, 0], [0, 10], 30); await chip(p, '6'); await cap('Across flats = 19 mm');
await typeSlider(p, 'Across flats', 19); await wait(600);
await cap('Extrude 8 mm → the hex head'); await typeSlider(p, 'Extrude height', 8); await chip(p, 'Extrude'); await wait(900); await log('head');
await camTo(p, -35, 22, [0, 0, 0], 60);
// 2. shank
await cap('2 · Circle Ø12 at the centre, extrude 80 mm  (video 1:00)'); await chip(p, 'Circle'); await drag(p, [0, 0], [6, 0], 25);
await chip(p, 'Direction: front'); await typeSlider(p, 'Extrude height', 80); await chip(p, 'Extrude'); await wait(900);
await camTo(p, -35, 22, [0, 36, 0], 140);
await cap('Union head + shank'); await selBody(0); await chip(p, 'Union'); await tap(p, [0, 40, 0]); await chip(p, 'Done'); await wait(900); await log('union');
if (STOP === 'union') process.exit(0);
// 3. end chamfer 1 mm
await cap('3 · Chamfer the shank end 1 mm  (video 1:20)'); await chip(p, 'Select', '#tools'); await camTo(p, -50, 20, [0, 80, 0], 40);
await tapOut(p, [0, 80, 6], [0, 80, 0], 5);
await chip(p, 'Chamfer'); await typeSlider(p, 'Distance', 1); await wait(700); await chip(p, 'Apply'); await wait(1200); await log('endchamfer');
// 4. head chamfer 30° by revolve + subtract
await cap('4 · Top plane: axis line and a 30° triangle\nat the head corner  (video 1:30)'); await chip(p, 'Line', '#tools'); await chip(p, 'Change plane'); await chip(p, 'Top (horizontal)'); await wait(600);
await camTo(p, -90, 89, [4, 40, 0], 150);
await chip(p, 'Type numbers');
await start(0, 99); await line(5, 90); await chip(p, 'Finish line');
await camTo(p, -90, 89, [10, -4, 0], 26);
await start(8.5, -8.2887); await line(3.5, 0); await line(2.0207, 90); await line(4.0415, 210); await chip(p, 'Finish line'); await chip(p, 'Hide numbers'); await log('tri');
await cap('Select the triangle, then the axis line → Revolve 360°'); await chip(p, 'Select', '#tools'); await tap(p, [11.3, -7.8]);
await camTo(p, -90, 89, [6, 50, 0], 160); await tap(p, [0, 101.5]); await chip(p, 'Revolve'); await wait(800); await chip(p, 'Done'); await wait(900); await log('ring');
await camTo(p, -35, 22, [0, 0, 0], 60);
await cap('Subtract the ring from the bolt → 30° head chamfer'); await selBody(0); await chip(p, 'Subtract'); await chip(p, 'Select all'); await chip(p, 'Done'); await wait(1500); await log('headchamfer');
if (STOP === 'head') { await p.screenshot({ path: SP + '/b4.png' }); process.exit(0); }
// 5. thread
await cap('5 · Thread profile on the Top plane  (video 2:10)\n60° V, pitch 1.75, depth 1.17'); await chip(p, 'Line', '#tools'); await wait(400);
await camTo(p, -90, 89, [5.6, 87.2, 0], 7); await chip(p, 'Type numbers');
await start(6.189, 88); await line(0.875, 90); await line(1.35, 210); await line(0.2, 270); await chip(p, 'Finish line');
await cap('Construction line for the symmetry'); await start(4.5, 88); await line(2.2, 0); await chip(p, 'Finish line'); await chip(p, 'Hide numbers');
await cap('Symmetry: tap the mirror line, then each side'); await chip(p, 'Symmetry'); await tap(p, [6.5, 88]);
for (const q of [[6.189, 88.4], [5.6, 88.537], [5.0199, 88.1]]) { await tap(p, q); await wait(300); }
await chip(p, 'Done'); await cap('Delete the construction line'); await chip(p, 'Edit sketch'); await tap(p, [4.75, 88]); await chip(p, 'Delete line'); await log('profile');
await cap('Revolve with a height = helix\n60 / 1.75 = 34.3 turns, 360 × 34.3 = 12348°'); await chip(p, 'Select', '#tools'); await tap(p, [5.6, 88]);
await camTo(p, -90, 89, [6, 60, 0], 120); await tap(p, [0, 101.5]); await chip(p, 'Revolve');
await typeSlider(p, 'Angle °', -12348); await typeSlider(p, 'Height', -60); await wait(800);
await camTo(p, -35, 22, [0, 58, 0], 70); await cap('Right-hand thread: angle −12348°, height −60 mm', 1500); await chip(p, 'Done'); await wait(1200); await log('helix');
await cap('Subtract the helix from the bolt'); await selBody(0); await chip(p, 'Subtract'); await chip(p, 'Select all'); await chip(p, 'Done'); await wait(2500); await log('thread');
await camTo(p, -60, 18, [0, 75, 0], 40); await wait(1500);
await cap('Section view (⋮ menu) to check the thread'); await p.click('#more'); await wait(400); await p.click('#m-section'); await wait(500); await camTo(p, 0, 55, [0, 40, 0], 120); await wait(2500);
await p.click('#more'); await p.click('#m-section'); await p.click('#more'); await p.click('#m-section'); await p.click('#more'); await p.click('#m-section'); await wait(300);
if (STOP === 'thread') process.exit(0);
// 6. nut
await chip(p, 'Select', '#tools'); await p.evaluate(() => { const s = window.__ss; s.S.selectedId = null; s.syncScene(); });
await cap('6 · Nut: offset plane 10 mm from the bolt end  (video 4:40)'); await camTo(p, 55, 25, [0, 80, 0], 45);
await tap(p, [0, 80, 0]); await tap(p, [0, 80, 0]); await chip(p, 'Offset plane');
await typeSlider(p, 'Distance', 10); await wait(800); await chip(p, 'Sketch'); await wait(600);
await cap('Polygon, 6 sides, centre locked on the axis'); await chip(p, 'Polygon'); await camTo(p, 90, 5, [0, 90, 0], 60);
await drag(p, [0, 90, 0], [0, 90, 10.97], 30); await typeSlider(p, 'Across flats', 19); await wait(500);
await cap('Extrude 7 mm → the nut'); await typeSlider(p, 'Extrude height', 7); for (let i = 0; i < 3 && !(await panelText(p)).includes('Direction: front'); i++) { const t = (await panelText(p)).match(/Direction: \w+/)[0]; await chip(p, t); } await chip(p, 'Extrude'); await wait(1000); await log('nut');
await camTo(p, -35, 22, [0, 50, 0], 150); await wait(800);
// 7. nut thread: tap rod (cylinder − helix), chamfer rings
await cap('7 · Nut thread  (video 5:40)\nTop plane: axis, a Ø12 tap profile and the same 60° V'); await chip(p, 'Line', '#tools'); await chip(p, 'Change plane'); await chip(p, 'Top (horizontal)'); await wait(600);
await camTo(p, -90, 89, [6, 94, 0], 26); await chip(p, 'Type numbers');
await start(0, 99); await line(5, 90); await chip(p, 'Finish line');
await start(0, 89); await line(6, 0); await line(9, 90); await line(6, 180); await line(9, 270); await chip(p, 'Finish line');
await start(6.189, 98.625); await line(1.75, 90); await line(1.35, 210); await line(0.4, 270); await line(1.35, 330); await chip(p, 'Finish line');
await cap('30° chamfer triangles for both nut faces (Symmetry)'); await start(8.5, 89.7113); await line(3.5, 0); await line(2.0207, 90); await line(4.0415, 210); await chip(p, 'Finish line');
await start(13, 93.5); await line(1.5, 0); await chip(p, 'Finish line'); await chip(p, 'Hide numbers');
await chip(p, 'Symmetry'); await tap(p, [13.7, 93.5]); for (const q of [[10.25, 89.7113], [12, 90.7], [10.25, 90.722]]) { await tap(p, q); await wait(250); } await chip(p, 'Done'); await log('nutlines');
const items = async open => { const vis = await p.evaluate(() => !document.getElementById('xt-items').hidden); if (vis !== open) { await p.click('#xt-items-btn'); await wait(400); } };
const eye = async name => { await p.locator('#xt-items .it').filter({ has: p.locator('b', { hasText: new RegExp('^' + name + '$') }) }).locator('button.eye').click(); await wait(500); };
const pickItem = async name => { await p.locator('#xt-items .it').filter({ has: p.locator('b', { hasText: new RegExp('^' + name + '$') }) }).click(); await wait(400); };
const bodyName = async test => (await state(p)).bodies.find(x => test(x.bb)).name;
const BOLT = await bodyName(bb => bb[1] < -7), NUT = await bodyName(bb => bb[1] > 89.9 && bb[0] < -9);
await cap('Hide the bolt and the nut for now (Items ◫ → eye)'); await items(true); await eye(BOLT); await eye(NUT); await items(false);
const revolve = async (pt, ang, h) => { await chip(p, 'Select', '#tools'); await tap(p, pt); await tap(p, [0, 102]); await chip(p, 'Revolve'); if (ang !== 360) await typeSlider(p, 'Angle °', ang); if (h) await typeSlider(p, 'Height', h); await wait(700); await chip(p, 'Done'); await wait(900); };
await cap('Revolve the tap profile 360° → Ø12 cylinder'); await revolve([3, 93.5], 360, 0);
await cap('Revolve the V with a height: −1800°, −8.75 mm\n(5 turns of 1.75)'); await revolve([5.6, 99.5], -1800, -8.75); await log('tapparts');
await camTo(p, -35, 22, [0, 94, 0], 45);
const CYL = await bodyName(bb => Math.abs(bb[1] - 89) < 0.01 && Math.abs(bb[4] - 98) < 0.01);
await cap('Tap = cylinder − helix (Subtract)'); await items(true); await pickItem(CYL); await items(false);
await chip(p, 'Subtract'); await chip(p, 'Select all'); await chip(p, 'Done'); await wait(2000); await log('taprod');
await camTo(p, -90, 89, [7, 94, 0], 30);
await cap('Revolve both 30° triangles → chamfer rings'); await revolve([11.5, 90.3], 360, 0); await revolve([11.5, 96.7], 360, 0); await log('rings');
await cap('Show the nut, then Subtract the tap and the rings'); await items(true); await eye(NUT); await pickItem(NUT); await items(false);
await camTo(p, -35, 22, [0, 94, 0], 50);
await chip(p, 'Subtract'); await chip(p, 'Select all'); await wait(800); await chip(p, 'Done'); await wait(2500); await log('nutdone');
await cap('Show the bolt again'); await items(true); await eye(BOLT); await items(false);
await p.evaluate(() => { const s = window.__ss; s.S.selectedId = null; s.S.selectedFace = null; s.syncScene(); });
await cap('Hide the construction sketches (Items ◫ → eye)'); await items(true);
for (let i = 0; i < 6; i++) { const r = p.locator('#xt-items .it').filter({ has: p.locator('.ic', { hasText: '✎' }) }).filter({ has: p.locator('button.eye', { hasText: '👁' }) }).first(); if (!(await r.count())) break; await r.locator('button.eye').click(); await wait(500); }
await items(false);
await cap('Material: Brushed steel (grey metal, like the video)');
for (const nm of [BOLT, NUT]) { await items(true); await pickItem(nm); await items(false); await chip(p, 'Material'); await chip(p, 'Brushed steel'); await wait(600); await chip(p, 'Done'); }
await p.evaluate(() => { const s = window.__ss; s.S.selectedId = null; s.S.selectedFace = null; s.syncScene(); });
await cap('Done · M12 bolt & nut, pitch 1.75', 600); await camTo(p, -30, 20, [0, 45, 0], 150, 1500); await wait(1500);
await p.screenshot({ path: SP + '/final1.png' });
await camTo(p, 30, 15, [0, 88, 0], 45, 1500); await wait(1500); await p.screenshot({ path: SP + '/final2.png' });
await camTo(p, 100, 10, [0, 40, 0], 140, 2500); await wait(1500); await p.screenshot({ path: SP + '/final3.png' });
await cap(''); await card('SolidSketch v24 · new tools used in this video:\nPolygon · Revolve with a height (helix)\nSymmetry · Type numbers (start, length, angle)\nSection view', 5000);
console.log('DONE');
await ctx.close(); await b.close();
