// Playwright helpers that drive SolidSketch through its real UI (used by bolt-nut.mjs).
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch (e) { pw = await import(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright/index.mjs'); }
const { chromium } = pw;
const APP = process.env.APP || fileURLToPath(new URL('../../build/solidsketch.html', import.meta.url));
export async function open(opts = {}) {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, ...(opts.ctx || {}) });
  const p = await ctx.newPage();
  p.on('console', m => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 300)); });
  p.on('pageerror', e => console.log('PAGEERR', e.message));
  await p.goto(pathToFileURL(APP).href + '#debug');
  await p.waitForFunction(() => window.__ss && window.__ss.S, null, { timeout: 60000 });
  await p.evaluate(() => window.__ss.setPanelOpen && window.__ss.setPanelOpen(true));
  await p.waitForTimeout(opts.settle || 3000);
  return { b, ctx, p };
}
export const scr = (p, pt) => p.evaluate(q => { const s = window.__ss; const w = q.length === 3 ? q : s.to3(q); const r = s.project(w); return [r.x, r.y]; }, pt);
export async function drag(p, a, c, steps = 20) { const A = await scr(p, a), B = await scr(p, c); if (REC) { await p.mouse.move(A[0], A[1], { steps: 14 }); await p.waitForTimeout(300); } await p.mouse.move(A[0], A[1]); await p.mouse.down(); for (let i = 1; i <= steps; i++) { await p.mouse.move(A[0] + (B[0] - A[0]) * i / steps, A[1] + (B[1] - A[1]) * i / steps); await p.waitForTimeout(15); } await p.mouse.up(); await p.waitForTimeout(200); }
export async function tap(p, a) { const A = await scr(p, a); if (REC) { await p.mouse.move(A[0], A[1], { steps: 14 }); await p.waitForTimeout(250); } await p.mouse.click(A[0], A[1]); await p.waitForTimeout(REC ? 600 : 200); }
export async function chip(p, text, where = '#panel, #tools, #bottom') { const loc = p.locator(`${where.split(',').map(w => w.trim() + ' button').join(', ')}`).filter({ hasText: new RegExp('^\\s*' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$') }).first(); if (REC) { await loc.scrollIntoViewIfNeeded(); const bb = await loc.boundingBox(); if (bb) { await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 12 }); await p.waitForTimeout(250); } } await loc.click(); await p.waitForTimeout(REC ? 700 : 300); }
const REC = !!process.env.REC;
export async function typeSlider(p, label, v) { const lab = p.locator('#panel .slider .lab').filter({ hasText: label + ':' }).first(); await lab.locator('button.val').scrollIntoViewIfNeeded(); await lab.locator('button.val').click(); const n = p.locator('#panel input.num'); if (REC) { await n.fill(''); await p.waitForTimeout(250); await n.pressSequentially(String(v), { delay: 110 }); await p.waitForTimeout(450); } else await n.fill(String(v)); await n.press('Enter'); await p.waitForTimeout(REC ? 600 : 300); }
export const panelText = p => p.evaluate(() => [...document.querySelectorAll('#panel button, #panel .note, #panel .lab, #hint')].map(x => x.textContent.trim()).join(' | '));
export const state = p => p.evaluate(() => { const S = window.__ss.S; return { tool: S.tool, bodies: S.bodies.map(b => ({ id: b.id, name: b.name, vol: +b.man.volume().toFixed(3), bb: (bb => [...bb.min, ...bb.max].map(v => +v.toFixed(3)))(b.man.boundingBox()) })), sketch: S.sketch.length, closed: S.sketchClosed, poly: S.polygon, lines: S.sketchLines.length }; });
// camera: yaw/pitch in degrees, target world point, dist
export async function camTo(p, yaw, pitch, target, dist, ms = 900) { await p.evaluate(([y, pi, t, d, ms]) => window.__ss.animateCamera(y * Math.PI / 180, pi * Math.PI / 180, t, ms, d), [yaw, pitch, target, dist, ms]); await p.waitForTimeout(ms + 150); }
export const fold = (p, open) => p.evaluate(o => window.__ss.setPanelOpen(o), open);
// tap px pixels beyond a world point, away from a centre point (to pick an outline edge from outside the body)
export async function tapOut(p, pt, centre, px = 6) { const A = await scr(p, pt), C = await scr(p, centre); const d = Math.hypot(A[0] - C[0], A[1] - C[1]) || 1; const x = A[0] + (A[0] - C[0]) / d * px, y = A[1] + (A[1] - C[1]) / d * px; await p.mouse.click(x, y); await p.waitForTimeout(250); }
