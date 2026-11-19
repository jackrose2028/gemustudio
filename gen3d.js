/* 3D rebuild: turns a ROM's own tiles, palettes and (optionally) a BRR sound into a self-contained, playable first-person 3D game (.html).
   It does NOT convert the original game's logic: it builds a new game out of the ROM's art. Extends SnesCore. */
(function (root) {
'use strict';
const Core = root.SnesCore || (typeof require !== 'undefined' ? require('./core.js') : null);
const G3 = {};
G3.ROLES = [['wall', 'Walls'], ['floor', 'Floor'], ['ceil', 'Ceiling'], ['gem', 'Pickup (collect all)'], ['enemy', 'Enemy'], ['exit', 'Exit door'], ['player', 'Player']];
const fmtOf = (platform, fmt) => (platform === 'nes' ? 'nes2bpp' : fmt);
// Palette -> array of [r,g,b] for the given format
G3.palette = function (rom, platform, fmt, palOff, sub) {
  const n = 1 << Core.FORMATS[fmtOf(platform, fmt)].bpp, out = [];
  if (platform === 'nes') { for (let i = 0; i < n; i++) { const v = palOff == null ? [0x0F, 0x16, 0x27, 0x30][i] : rom[palOff + (sub || 0) * 4 + i]; out.push(Core.NES.PALETTE[(v === undefined ? 0 : v) & 63]); } return out; }
  if (palOff == null) { for (let i = 0; i < n; i++) { const v = Math.round(i * 255 / (n - 1)); out.push([v, v, v]); } return out; }
  for (let i = 0; i < n; i++) out.push(palOff + i * 2 + 1 < rom.length ? Core.readColor(rom, palOff + i * 2) : [255, 0, 255]);
  return out;
};
// Indexed pixels of a size x size block (size 8 or 16; 16 = tiles t, t+1, t+16, t+17)
G3.blockPixels = function (rom, base, fmt, size) {
  const tb = Core.FORMATS[fmt].bytes, px = new Uint8Array(size * size), nt = size / 8;
  for (let ty = 0; ty < nt; ty++) for (let tx = 0; tx < nt; tx++) {
    const off = base + (ty * 16 + tx) * tb; if (off < 0 || off + tb > rom.length) continue;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px[(ty * 8 + y) * size + tx * 8 + x] = Core.getPixel(rom, off, fmt, x, y);
  }
  return px;
};
G3.blockRGBA = function (rom, base, fmt, pal, size, transparent) {
  const px = G3.blockPixels(rom, base, fmt, size), out = new Uint8Array(size * size * 4);
  for (let i = 0; i < px.length; i++) { const c = pal[px[i]] || [255, 0, 255]; out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = transparent && px[i] === 0 ? 0 : 255; }
  return out;
};
// How tile-like is a region read as `fmt`? Real graphics have large flat areas, so neighbouring pixels often match (both across and down).
G3.coherence = function (data, off, len, fmt) {
  const tb = Core.FORMATS[fmt].bytes, n = Math.min(Math.floor(len / tb), 256); if (n < 16) return { coh: 0, filled: 0 }; let s = 0, c = 0;
  for (let t = 0; t < n; t++) {
    let nz = 0, hh = 0, vv = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const p = Core.getPixel(data, off + t * tb, fmt, x, y); if (p) nz++; if (x < 7 && p === Core.getPixel(data, off + t * tb, fmt, x + 1, y)) hh++; if (y < 7 && p === Core.getPixel(data, off + t * tb, fmt, x, y + 1)) vv++; }
    if (nz < 4) continue; s += (hh / 56 + vv / 56) / 2; c++;
  }
  return { coh: c ? s / c : 0, filled: c / n };
};
// Best SNES colour depth for a buffer: 3bpp or 4bpp (2bpp always looks "flat", so it is only used when chosen by hand)
G3.bestFormat = function (data, off, len) { let best = null; for (const f of ['3bpp', '4bpp']) { const r = G3.coherence(data, off, len, f); if (!best || r.coh > best.coh) best = { fmt: f, coh: r.coh, filled: r.filled }; } return best; };
// Candidate graphics sources: raw ROM regions and (when known) decoded compressed streams. Sorted best first.
G3.findSources = function (rom, platform, info, game, o) {
  o = o || {}; const out = [];
  if (platform === 'nes') {
    const s = info.chrSize ? info.chrOff : info.prgOff, e = info.chrSize ? info.chrOff + info.chrSize : info.prgOff + info.prgSize;
    for (let a = s; a + 4096 <= e; a += 4096) { const r = G3.coherence(rom, a, 4096, 'nes2bpp'); if (r.coh > 0.45 && r.filled > 0.5) out.push({ label: 'CHR/PRG data at $' + a.toString(16).toUpperCase(), data: rom, off: a, fmt: 'nes2bpp', score: r.coh * r.filled }); }
  } else {
    for (const r of Core.Capture.dataRuns(rom, 8)) for (let a = r.off; a + 4096 <= r.off + r.len; a += 2048) { const b = G3.bestFormat(rom, a, 8192); if (b.coh > 0.5 && b.filled > 0.6) out.push({ label: 'ROM data at $' + a.toString(16).toUpperCase(), data: rom, off: a, fmt: b.fmt, score: b.coh * b.filled }); }
    const K = Core.Codec;
    if (K && game && game.n === 1 && o.streams !== false) { // Super Mario World: verified pointer table
      const mp = o.mapping || 'LoROM', f = (a) => Core.snesToFile(a, mp, rom.length), lo = f(0xB992), hi = f(0xB9C4), bk = f(0xB9F6);
      for (let i = 0; i < 0x32; i++) { try { const r = K.decode(rom, f(rom[lo + i] | rom[hi + i] << 8 | rom[bk + i] << 16), 'lz2be', 0x10000), b = G3.bestFormat(r.data, 0, r.data.length); if (b.filled > 0.4) out.push({ label: 'SMW graphics file ' + i.toString(16).toUpperCase().padStart(2, '0') + ' (decompressed)', data: r.data, off: 0, fmt: b.fmt, score: b.coh * b.filled + 0.05 }); } catch (e) { /* skip */ } }
    } else if (K && game && game.codec && o.scanCodec) {
      for (const x of K.scan(rom, game.codec, { minOut: 2048, maxOut: 0x8000, maxIn: 0x3000 }).filter((h) => h.ratio >= 1.3).slice(0, 80)) { try { const r = K.decode(rom, x.off, game.codec, 0x10000), b = G3.bestFormat(r.data, 0, r.data.length); if (b.coh > 0.5 && b.filled > 0.5) out.push({ label: 'Compressed stream at $' + x.off.toString(16).toUpperCase() + ' (candidate)', data: r.data, off: 0, fmt: b.fmt, score: b.coh * b.filled }); } catch (e) { /* skip */ } }
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, o.max || 40);
};
// Pick the palette that makes the chosen tiles look best: wide brightness spread, not too dark or washed out, several hues.
G3.bestPalette = function (rom, platform, pals, data, off, fmt, picks) {
  const ft = fmtOf(platform, fmt), tb = Core.FORMATS[ft].bytes; let best = null;
  const roles = ['wall', 'floor', 'gem', 'enemy'], blocks = roles.map((r) => G3.blockPixels(data, off + picks[r] * tb, ft, 16));
  for (const p of pals) {
    const pal = G3.palette(rom, platform, fmt, p.off, 0); let sc = 0;
    blocks.forEach((px, bi) => { let n = 0, sum = 0, sq = 0, hue = new Set(); for (let i = 0; i < px.length; i++) { if (!px[i] && bi > 1) continue; const c = pal[px[i]] || [0, 0, 0], l = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]; n++; sum += l; sq += l * l; hue.add(Math.round(Math.atan2(c[1] - c[2], c[0] - c[1]) * 2)); } if (!n) return; const m = sum / n, sd = Math.sqrt(Math.max(0, sq / n - m * m)); sc += Math.min(sd, 60) + hue.size * 2 - Math.abs(m - 110) * 0.4; });
    if (!best || sc > best.sc) best = { sc, off: p.off };
  }
  return best ? best.off : null;
};
// Choose tiles for each role by looking at fill and colour variety of 16x16 blocks.
G3.autoPicks = function (rom, off, fmt) {
  const tb = Core.FORMATS[fmt].bytes, cand = [], nTiles = Math.min(Math.floor((rom.length - off) / tb), 512);
  for (let t = 0; t + 17 < nTiles; t++) {
    if (t % 16 === 15) continue; const px = G3.blockPixels(rom, off + t * tb, fmt, 16); let nz = 0, same = 0; const set = new Set();
    for (let i = 0; i < 256; i++) { if (px[i]) nz++; set.add(px[i]); if (i % 16 < 15 && px[i] === px[i + 1]) same++; }
    cand.push({ t, fill: nz / 256, colors: set.size, coh: same / 240 });
  }
  const used = new Set(), take = (fn, key) => { const c = cand.filter((x) => !used.has(x.t) && fn(x)).sort((a, b) => key(b) - key(a))[0]; if (c) { used.add(c.t); used.add(c.t + 1); used.add(c.t - 1); } return c ? c.t : null; };
  const p = {};
  p.wall = take((x) => x.fill > 0.97 && x.colors >= 3, (x) => x.colors * x.coh);
  p.floor = take((x) => x.fill > 0.97 && x.colors >= 2, (x) => -x.colors + x.coh);
  p.ceil = take((x) => x.fill > 0.97 && x.colors >= 2, (x) => x.coh);
  p.gem = take((x) => x.fill > 0.3 && x.fill < 0.8 && x.colors >= 3, (x) => x.colors + x.coh);
  p.enemy = take((x) => x.fill > 0.4 && x.fill < 0.9 && x.colors >= 4, (x) => x.colors);
  p.player = take((x) => x.fill > 0.4 && x.fill < 0.9 && x.colors >= 4, (x) => x.colors + x.coh);
  p.exit = take((x) => x.fill > 0.5 && x.colors >= 3, (x) => x.coh);
  const fall = cand.filter((x) => x.fill > 0.1).map((x) => x.t); let k = 0;
  for (const r of G3.ROLES) if (p[r[0]] == null) p[r[0]] = fall.length ? fall[(k++ * 7) % fall.length] : 0;
  return p;
};
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64'); };
// ---------------- the game engine (runs inside the generated page) ----------------
function engine(CFG) {
  'use strict';
  const W = 256, H = 224, T = CFG.T, cv = document.getElementById('screen'), ctx = cv.getContext('2d'); cv.width = W; cv.height = H;
  const img = ctx.createImageData(W, H), buf = new Uint32Array(img.data.buffer), zbuf = new Float32Array(W);
  const dec = (s) => { const a = atob(s), u = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) u[i] = a.charCodeAt(i); return u; };
  const tex = {}; for (const k in CFG.tex) tex[k] = new Uint32Array(dec(CFG.tex[k]).buffer);
  const shade = (p, f) => (0xFF000000 | (((p >>> 16) & 255) * f << 16) | (((p >>> 8) & 255) * f << 8) | ((p & 255) * f)) >>> 0;
  let seed = CFG.seed >>> 0; const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const g = { state: 'title', level: 0, hp: 5, score: 0, gems: 0, need: 0, msg: '', msgT: 0, map: null, GW: 0, sprites: [], px: 1.5, py: 1.5, dx: 1, dy: 0, plx: 0, ply: 0.66, hurtT: 0, keys: {}, flash: 0, mini: true, t: 0 };
  const tints = [[1, 1, 1], [1, 0.8, 0.8], [0.8, 0.9, 1], [0.9, 1, 0.8], [1, 0.9, 0.7]];
  function genLevel(n) {
    const c = CFG.size + n, GW = c * 2 + 1; g.GW = GW; const m = new Uint8Array(GW * GW).fill(1); const st = [[0, 0]]; m[1 * GW + 1] = 0; const seen = new Set(['0,0']);
    while (st.length) { const [cx, cy] = st[st.length - 1], nb = []; for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = cx + ax, ny = cy + ay; if (nx >= 0 && ny >= 0 && nx < c && ny < c && !seen.has(nx + ',' + ny)) nb.push([nx, ny, ax, ay]); } if (!nb.length) { st.pop(); continue; } const [nx, ny, ax, ay] = nb[Math.floor(rnd() * nb.length)]; seen.add(nx + ',' + ny); m[(cy * 2 + 1 + ay) * GW + cx * 2 + 1 + ax] = 0; m[(ny * 2 + 1) * GW + nx * 2 + 1] = 0; st.push([nx, ny]); }
    for (let i = 0; i < c * 2; i++) { const x = 1 + Math.floor(rnd() * (GW - 2)), y = 1 + Math.floor(rnd() * (GW - 2)); if (m[y * GW + x] && (x % 2 !== y % 2)) m[y * GW + x] = 0; } // knock out a few walls so it is not a perfect maze
    g.map = m; const open = []; for (let y = 1; y < GW - 1; y++) for (let x = 1; x < GW - 1; x++) if (!m[y * GW + x]) open.push([x, y]);
    const dist = new Int16Array(GW * GW).fill(-1); const q = [[1, 1]]; dist[GW + 1] = 0; for (let i = 0; i < q.length; i++) { const [x, y] = q[i]; for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + ax, ny = y + ay; if (!m[ny * GW + nx] && dist[ny * GW + nx] < 0) { dist[ny * GW + nx] = dist[y * GW + x] + 1; q.push([nx, ny]); } } }
    let far = open[0]; for (const o of open) if (dist[o[1] * GW + o[0]] > dist[far[1] * GW + far[0]]) far = o;
    g.sprites = [{ x: far[0] + 0.5, y: far[1] + 0.5, type: 'exit', alive: true }];
    const pick = (minD) => { for (let k = 0; k < 400; k++) { const o = open[Math.floor(rnd() * open.length)]; if (dist[o[1] * GW + o[0]] >= minD) return o; } return open[open.length - 1]; };
    const ng = 3 + n * 2; for (let i = 0; i < ng; i++) { const o = pick(4); g.sprites.push({ x: o[0] + 0.5, y: o[1] + 0.5, type: 'gem', alive: true, ph: rnd() * 6 }); }
    const ne = Math.min(CFG.enemies + n, 14); for (let i = 0; i < ne; i++) { const o = pick(8); g.sprites.push({ x: o[0] + 0.5, y: o[1] + 0.5, type: 'enemy', alive: true, ang: rnd() * 6.28, hp: 1 }); }
    g.need = ng; g.gems = 0; g.px = 1.5; g.py = 1.5; g.dx = 1; g.dy = 0; g.plx = 0; g.ply = 0.66;
  }
  const solid = (x, y) => { const ix = Math.floor(x), iy = Math.floor(y); return ix < 0 || iy < 0 || ix >= g.GW || iy >= g.GW || g.map[iy * g.GW + ix] !== 0; };
  const canMove = (x, y, r) => !solid(x - r, y - r) && !solid(x + r, y - r) && !solid(x - r, y + r) && !solid(x + r, y + r);
  const rotate = (a) => { const c = Math.cos(a), s = Math.sin(a), ox = g.dx, px = g.plx; g.dx = ox * c - g.dy * s; g.dy = ox * s + g.dy * c; g.plx = px * c - g.ply * s; g.ply = px * s + g.ply * c; };
  let actx = null, musicNode = null;
  function audio() { if (actx) return actx; try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; } return actx; }
  function beep(f, d, type, v) { const a = audio(); if (!a) return; try { const o = a.createOscillator(), gn = a.createGain(); o.type = type || 'square'; o.frequency.value = f; gn.gain.value = v || 0.06; o.connect(gn); gn.connect(a.destination); o.start(); gn.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + d); o.stop(a.currentTime + d); } catch (e) { /* no sound */ } }
  function startMusic() { const a = audio(); if (!a || !CFG.music || musicNode) return; try { a.decodeAudioData(dec(CFG.music).buffer.slice(0), (b) => { musicNode = a.createBufferSource(); musicNode.buffer = b; musicNode.loop = true; const gn = a.createGain(); gn.gain.value = 0.35; musicNode.connect(gn); gn.connect(a.destination); musicNode.start(); }, () => {}); } catch (e) { /* no music */ } }
  function say(m) { g.msg = m; g.msgT = 2.5; }
  function start() { g.level = 0; g.hp = 5; g.score = 0; seed = CFG.seed >>> 0; genLevel(0); g.state = 'play'; startMusic(); beep(660, 0.15); }
  function fire() {
    beep(220, 0.12, 'sawtooth'); let best = null, bd = 1e9;
    for (const s of g.sprites) { if (s.type !== 'enemy' || !s.alive) continue; const sx = s.x - g.px, sy = s.y - g.py, d = Math.hypot(sx, sy), cr = (sx * g.dy - sy * g.dx) / d, dot = (sx * g.dx + sy * g.dy) / d; if (dot > 0.5 && Math.abs(cr * d) < 0.45 && d < 8 && d < bd && !wallBetween(g.px, g.py, s.x, s.y)) { best = s; bd = d; } }
    if (best) { best.alive = false; g.score += 50; g.flash = 0.1; beep(120, 0.2, 'square', 0.09); }
  }
  function wallBetween(x0, y0, x1, y1) { const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 8); for (let i = 1; i < n; i++) { if (solid(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n)) return true; } return false; }
  function update(dt) {
    g.t += dt; if (g.msgT > 0) g.msgT -= dt; if (g.flash > 0) g.flash -= dt; if (g.hurtT > 0) g.hurtT -= dt;
    if (g.state !== 'play') return; const k = g.keys, sp = 3 * dt;
    const turn = ((k.ArrowRight ? 1 : 0) - (k.ArrowLeft ? 1 : 0) + (k.e ? 1 : 0) - (k.q ? 1 : 0)) * 2.4 * dt; if (turn) rotate(turn);
    let fx = 0, fy = 0; const fw = (k.w || k.ArrowUp ? 1 : 0) - (k.s || k.ArrowDown ? 1 : 0), st = (k.d ? 1 : 0) - (k.a ? 1 : 0);
    fx = g.dx * fw + g.plx * st * 1.2; fy = g.dy * fw + g.ply * st * 1.2;
    if (fx || fy) { if (canMove(g.px + fx * sp, g.py, 0.2)) g.px += fx * sp; if (canMove(g.px, g.py + fy * sp, 0.2)) g.py += fy * sp; }
    for (const s of g.sprites) {
      if (!s.alive) continue; const d = Math.hypot(s.x - g.px, s.y - g.py);
      if (s.type === 'gem' && d < 0.5) { s.alive = false; g.gems++; g.score += 100; beep(880, 0.12, 'triangle', 0.1); if (g.gems === g.need) say('All collected! Find the exit'); }
      else if (s.type === 'exit' && d < 0.6) { if (g.gems >= g.need) { g.level++; g.score += 250; if (g.level >= CFG.levels) { g.state = 'win'; beep(990, 0.4, 'triangle', 0.1); } else { genLevel(g.level); say('Level ' + (g.level + 1)); beep(740, 0.25, 'triangle', 0.1); } return; } else if (g.msgT <= 0) say('Collect all gems first (' + g.gems + '/' + g.need + ')'); }
      else if (s.type === 'enemy') {
        const chase = d < 6 && !wallBetween(s.x, s.y, g.px, g.py); if (chase) s.ang = Math.atan2(g.py - s.y, g.px - s.x); else if (rnd() < dt * 0.8) s.ang += (rnd() - 0.5) * 3;
        const vx = Math.cos(s.ang) * (chase ? 1.3 : 0.6) * dt, vy = Math.sin(s.ang) * (chase ? 1.3 : 0.6) * dt; if (canMove(s.x + vx, s.y, 0.2)) s.x += vx; else s.ang += 2; if (canMove(s.x, s.y + vy, 0.2)) s.y += vy; else s.ang += 2;
        if (d < 0.45 && g.hurtT <= 0) { g.hp--; g.hurtT = 1; g.flash = 0.2; beep(90, 0.3, 'sawtooth', 0.1); if (g.hp <= 0) { g.state = 'over'; } }
      }
    }
  }
  function render() {
    const tint = tints[g.level % tints.length], wt = tex.wall, ft = tex.floor, ct = tex.ceil;
    for (let y = H / 2 | 0; y < H; y++) { // floor and ceiling
      const p = y - H / 2 + 0.5, rd = (H * 0.5) / p, fxs = g.px + rd * (g.dx - g.plx), fys = g.py + rd * (g.dy - g.ply), stx = rd * 2 * g.plx / W, sty = rd * 2 * g.ply / W, f = Math.min(1, 1.6 / (1 + rd * 0.35));
      let fx = fxs, fy = fys; for (let x = 0; x < W; x++) { const tx = ((fx - Math.floor(fx)) * T) | 0, ty = ((fy - Math.floor(fy)) * T) | 0; buf[y * W + x] = shade(ft[ty * T + tx], f * tint[0]); buf[(H - 1 - y) * W + x] = shade(ct[ty * T + tx], f * 0.8 * tint[2]); fx += stx; fy += sty; }
    }
    for (let x = 0; x < W; x++) {
      const cx = 2 * x / W - 1, rx = g.dx + g.plx * cx, ry = g.dy + g.ply * cx; let mx = Math.floor(g.px), my = Math.floor(g.py); const ddx = Math.abs(1 / (rx || 1e-9)), ddy = Math.abs(1 / (ry || 1e-9));
      let sx = rx < 0 ? -1 : 1, sy = ry < 0 ? -1 : 1, sdx = (rx < 0 ? g.px - mx : mx + 1 - g.px) * ddx, sdy = (ry < 0 ? g.py - my : my + 1 - g.py) * ddy, side = 0, hit = false, n = 0;
      while (!hit && n++ < 200) { if (sdx < sdy) { sdx += ddx; mx += sx; side = 0; } else { sdy += ddy; my += sy; side = 1; } if (mx < 0 || my < 0 || mx >= g.GW || my >= g.GW || g.map[my * g.GW + mx]) hit = true; }
      const pd = Math.max(0.05, side === 0 ? sdx - ddx : sdy - ddy); zbuf[x] = pd; const lh = (H / pd) | 0, ds = Math.max(0, (H - lh) >> 1), de = Math.min(H - 1, (H + lh) >> 1);
      let wx = side === 0 ? g.py + pd * ry : g.px + pd * rx; wx -= Math.floor(wx); let tx = (wx * T) | 0; if ((side === 0 && rx > 0) || (side === 1 && ry < 0)) tx = T - 1 - tx;
      const f = Math.min(1, 2 / (1 + pd * 0.45)) * (side ? 0.75 : 1), step = T / lh; let tp = (ds - (H - lh) / 2) * step;
      for (let y = ds; y <= de; y++) { buf[y * W + x] = shade(wt[(tp | 0) % T * T + tx], f * tint[1]); tp += step; }
    }
    const inv = 1 / (g.plx * g.dy - g.dx * g.ply), vis = g.sprites.filter((s) => s.alive).map((s) => ({ s, d: (s.x - g.px) ** 2 + (s.y - g.py) ** 2 })).sort((a, b) => b.d - a.d);
    for (const { s, d } of vis) {
      const sx = s.x - g.px, sy = s.y - g.py, tx = inv * (g.dy * sx - g.dx * sy), ty = inv * (-g.ply * sx + g.plx * sy); if (ty < 0.1) continue;
      const scr = ((W / 2) * (1 + tx / ty)) | 0, size = Math.abs((H / ty) | 0) * (s.type === 'exit' ? 1 : 0.7), bob = s.type === 'gem' ? Math.sin(g.t * 3 + s.ph) * size * 0.06 : 0, vo = s.type === 'exit' ? 0 : size * 0.15 + bob, t = tex[s.type], f = Math.min(1, 2 / (1 + ty * 0.45));
      const y0 = ((H - size) / 2 + vo) | 0, x0 = (scr - size / 2) | 0;
      for (let x = Math.max(0, x0); x < Math.min(W, x0 + size); x++) { if (ty >= zbuf[x]) continue; const txx = (((x - x0) * T / size) | 0); for (let y = Math.max(0, y0); y < Math.min(H, y0 + size); y++) { const p = t[(((y - y0) * T / size) | 0) * T + txx]; if (p >>> 24) buf[y * W + x] = shade(p, f); } }
    }
    ctx.putImageData(img, 0, 0);
    if (g.flash > 0) { ctx.fillStyle = 'rgba(255,60,60,' + Math.min(0.5, g.flash * 2) + ')'; ctx.fillRect(0, 0, W, H); }
    if (g.mini && g.state === 'play') { const s = 3, ox = 4, oy = 16; ctx.globalAlpha = 0.7; for (let y = 0; y < g.GW; y++) for (let x = 0; x < g.GW; x++) { ctx.fillStyle = g.map[y * g.GW + x] ? '#335' : '#000'; ctx.fillRect(ox + x * s, oy + y * s, s, s); } ctx.globalAlpha = 1; for (const q of g.sprites) if (q.alive) { ctx.fillStyle = q.type === 'gem' ? '#ff0' : q.type === 'enemy' ? '#f33' : '#3f3'; ctx.fillRect(ox + q.x * s - 1, oy + q.y * s - 1, 3, 3); } ctx.fillStyle = '#fff'; ctx.fillRect(ox + g.px * s - 1, oy + g.py * s - 1, 3, 3); }
    ctx.font = 'bold 8px monospace'; ctx.textBaseline = 'top';
    const txt = (s, x, y, c) => { ctx.fillStyle = '#000'; ctx.fillText(s, x + 1, y + 1); ctx.fillStyle = c || '#fff'; ctx.fillText(s, x, y); };
    if (g.state === 'play') { txt('LEVEL ' + (g.level + 1) + '/' + CFG.levels + '   GEMS ' + g.gems + '/' + g.need + '   SCORE ' + g.score, 4, 3); for (let i = 0; i < 5; i++) { ctx.fillStyle = i < g.hp ? '#e33' : '#422'; ctx.fillRect(W - 12 - i * 11, 4, 9, 7); } if (g.msgT > 0) { ctx.textAlign = 'center'; txt(g.msg, W / 2, H - 22, '#ff8'); ctx.textAlign = 'left'; } }
    else { ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(0, 0, W, H); ctx.textAlign = 'center'; ctx.font = 'bold 16px monospace'; txt(g.state === 'title' ? CFG.title : g.state === 'win' ? 'YOU WIN!' : 'GAME OVER', W / 2, 52, '#ffd84a'); ctx.font = 'bold 8px monospace'; if (g.state !== 'title') txt('SCORE ' + g.score, W / 2, 80); txt(g.state === 'title' ? 'PRESS ENTER TO START' : 'PRESS ENTER TO PLAY AGAIN', W / 2, 150); if (g.state === 'title') { txt('WASD move   Q/E or arrows turn   SPACE shoot   M map', W / 2, 168, '#aaa'); txt('Collect every gem, avoid enemies, reach the door', W / 2, 180, '#aaa'); const ic = [['gem', 70], ['enemy', 120], ['exit', 170]]; for (const [n, x] of ic) { const c = document.createElement('canvas'); c.width = c.height = T; const cc = c.getContext('2d'), id = cc.createImageData(T, T); new Uint32Array(id.data.buffer).set(tex[n]); cc.putImageData(id, 0, 0); ctx.imageSmoothingEnabled = false; ctx.drawImage(c, x, 90, 36, 36); } } ctx.textAlign = 'left'; }
  }
  let last = performance.now(); function loop(now) { const dt = Math.min(0.05, (now - last) / 1000); last = now; update(dt); render(); requestAnimationFrame(loop); } requestAnimationFrame(loop);
  window.addEventListener('keydown', (e) => { const k = e.key.length === 1 ? e.key.toLowerCase() : e.key; g.keys[k] = true; if (k === 'Enter' && g.state !== 'play') start(); if (k === ' ' && g.state === 'play') fire(); if (k === 'm') g.mini = !g.mini; if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(k)) e.preventDefault(); });
  window.addEventListener('keyup', (e) => { const k = e.key.length === 1 ? e.key.toLowerCase() : e.key; g.keys[k] = false; });
  cv.addEventListener('click', () => { if (cv.requestPointerLock) try { cv.requestPointerLock(); } catch (e) { /* ignore */ } if (g.state === 'play') fire(); });
  document.addEventListener('mousemove', (e) => { if (document.pointerLockElement === cv && g.state === 'play') rotate(e.movementX * 0.003); });
  window.__g = g; window.__start = start; window.__update = update; window.__genLevel = genLevel;
}
// ---------------- 2.5D side-view engine (runs inside the generated page) ----------------
function engineSide(CFG) {
  'use strict';
  const W = 256, H = 224, T = CFG.T, B = 24, ROWS = 16, cv = document.getElementById('screen'), ctx = cv.getContext('2d'); cv.width = W; cv.height = H;
  const dec = (s) => { const a = atob(s), u = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) u[i] = a.charCodeAt(i); return u; };
  const tc = {}, avg = {}, dark = {};
  const mk = (rgba) => { const c = document.createElement('canvas'); c.width = c.height = T; const x = c.getContext('2d'), id = x.createImageData(T, T); id.data.set(rgba); x.putImageData(id, 0, 0); return c; };
  for (const k in CFG.tex) { const r = dec(CFG.tex[k]); tc[k] = mk(r); let n = 0, R = 0, G = 0, Bl = 0; for (let i = 0; i < r.length; i += 4) if (r[i + 3]) { n++; R += r[i]; G += r[i + 1]; Bl += r[i + 2]; } avg[k] = n ? [R / n, G / n, Bl / n] : [80, 80, 80]; }
  const col = (c, f, a) => 'rgba(' + Math.min(255, c[0] * f | 0) + ',' + Math.min(255, c[1] * f | 0) + ',' + Math.min(255, c[2] * f | 0) + ',' + (a == null ? 1 : a) + ')';
  const tints = [[1, 1, 1], [1.15, 0.9, 0.85], [0.85, 0.95, 1.2], [0.95, 1.15, 0.9], [1.15, 1, 0.8]];
  let seed = CFG.seed >>> 0; const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const darkTex = (k, f, tintCol, a) => { const c = document.createElement('canvas'); c.width = c.height = T; const x = c.getContext('2d'); x.drawImage(tc[k], 0, 0); x.globalCompositeOperation = 'source-atop'; x.fillStyle = col(tintCol, 1, a); x.fillRect(0, 0, T, T); return c; };
  const g = { state: 'title', level: 0, hp: 5, score: 0, gems: 0, need: 0, msg: '', msgT: 0, cols: 0, grid: null, hh: null, sprites: [], px: 40, py: 0, vx: 0, vy: 0, face: 1, ground: false, coyote: 0, inv: 0, cx: 0, cy: 0, keys: {}, shots: [], t: 0, flash: 0, safe: [40, 0], walk: 0 };
  let glowC = null, deco = null, tint = tints[0], sky = [[10, 14, 40], [30, 60, 80]];
  const solid = (c, r) => (c < 0 || c >= g.cols) ? true : (r < 0 || r >= ROWS) ? false : g.grid[r * g.cols + c] !== 0;
  function genLevel(n) {
    const cols = 70 + n * 25; g.cols = cols; g.grid = new Uint8Array(cols * ROWS); g.hh = new Int8Array(cols); tint = tints[n % tints.length];
    const ac = avg.ceil, af = avg.floor; sky = [[ac[0] * 0.10 * tint[0] + 6, ac[1] * 0.10 * tint[1] + 8, ac[2] * 0.14 * tint[2] + 24], [ac[0] * 0.30 * tint[0] + af[0] * 0.15, ac[1] * 0.30 * tint[1] + af[1] * 0.2, ac[2] * 0.36 * tint[2] + af[2] * 0.2 + 20]];
    let h = 4, pit = 0; for (let c = 0; c < cols; c++) { if (c > 6 && c < cols - 8 && rnd() < 0.14) h = Math.max(2, Math.min(6, h + (rnd() < 0.5 ? -1 : 1) * (rnd() < 0.3 ? 2 : 1))); if (c > 10 && c < cols - 10 && !pit && rnd() < 0.05) pit = 2; if (pit > 0) { g.hh[c] = 0; pit--; } else g.hh[c] = h; }
    for (let c = 0; c < cols; c++) { const hh = g.hh[c]; for (let r = ROWS - hh; r < Math.min(ROWS, ROWS - hh + 3); r++) g.grid[r * cols + c] = r === ROWS - hh ? 1 : 2; }
    const plats = []; for (let c = 12; c < cols - 12; c += 6 + Math.floor(rnd() * 6)) { if (rnd() < 0.7) { const len = 2 + Math.floor(rnd() * 3), row = ROWS - Math.max(g.hh[c], 2) - 4; if (row > 1) { for (let k = 0; k < len && c + k < cols; k++) { if (g.hh[c + k] && ROWS - g.hh[c + k] <= row + 1) continue; g.grid[row * cols + c + k] = 1; } plats.push([c, row, len]); } } }
    g.sprites = []; const need = 8 + n * 3; g.need = need; let placed = 0;
    for (const [c, row, len] of plats) if (placed < need) { g.sprites.push({ type: 'gem', x: (c + len / 2) * B, y: (row - 0.8) * B, alive: true, ph: rnd() * 6 }); placed++; }
    while (placed < need) { const c = 6 + Math.floor(rnd() * (cols - 14)); g.sprites.push({ type: 'gem', x: (c + 0.5) * B, y: (ROWS - Math.max(g.hh[c], 3) - 1.6) * B, alive: true, ph: rnd() * 6 }); placed++; }
    const ne = Math.min(CFG.enemies + n * 2, 16); for (let i = 0; i < ne; i++) { let c = 14 + Math.floor(rnd() * (cols - 24)), tries = 0; while ((!g.hh[c] || !g.hh[c + 1] || !g.hh[c - 1]) && tries++ < 30) c = 14 + Math.floor(rnd() * (cols - 24)); g.sprites.push({ type: 'enemy', x: (c + 0.5) * B, y: (ROWS - g.hh[c]) * B - 11, w: 16, h: 18, vx: rnd() < 0.5 ? -28 : 28, alive: true }); }
    g.sprites.push({ type: 'exit', x: (cols - 4 + 0.5) * B, y: (ROWS - g.hh[cols - 4] - 1) * B, alive: true });
    g.px = 3.5 * B; g.py = (ROWS - g.hh[3]) * B; g.vx = g.vy = 0; g.safe = [g.px, g.py]; g.cx = 0; g.cy = Math.max(0, Math.min(ROWS * B - H, g.py - H * 0.62)); g.shots = [];
    const d = { stars: [], clouds: [], sky: [], ruins: [], fg: [] }; const span = cols * B;
    for (let i = 0; i < 90; i++) d.stars.push([rnd() * (W + span * 0.05), rnd() * H * 0.6, rnd()]);
    for (let i = 0; i < 9; i++) d.clouds.push([rnd() * (W + span * 0.15), 10 + rnd() * 80, 60 + rnd() * 90, 8 + rnd() * 10]);
    for (let x = 0; x < W + span * 0.35; x += 10 + rnd() * 26) d.sky.push([x, 24 + rnd() * 70, 10 + rnd() * 22, rnd()]);
    for (let x = 0; x < W + span * 0.6; x += 70 + rnd() * 140) d.ruins.push([x, 2 + Math.floor(rnd() * 4), 1 + Math.floor(rnd() * 2)]);
    for (let x = 0; x < W + span * 1.6; x += 150 + rnd() * 260) d.fg.push([x, 20 + rnd() * 60, 8 + rnd() * 10]);
    deco = d; if (!tc.wallBg) { tc.wallBg = darkTex('wall', 1, sky[1], 0.62); tc.wallFar = darkTex('wall', 1, sky[1], 0.82); tc.floorFg = darkTex('floor', 1, [4, 6, 14], 0.72); tc.wallFg = darkTex('wall', 1, [4, 6, 14], 0.78); }
  }
  // ---- audio (same helpers as the maze engine)
  let actx = null, musicNode = null;
  function audio() { if (actx) return actx; try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; } return actx; }
  function beep(f, d, type, v) { const a = audio(); if (!a) return; try { const o = a.createOscillator(), gn = a.createGain(); o.type = type || 'square'; o.frequency.value = f; gn.gain.value = v || 0.06; o.connect(gn); gn.connect(a.destination); o.start(); gn.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + d); o.stop(a.currentTime + d); } catch (e) { /* no sound */ } }
  function startMusic() { const a = audio(); if (!a || !CFG.music || musicNode) return; try { a.decodeAudioData(dec(CFG.music).buffer.slice(0), (b) => { musicNode = a.createBufferSource(); musicNode.buffer = b; musicNode.loop = true; const gn = a.createGain(); gn.gain.value = 0.35; musicNode.connect(gn); gn.connect(a.destination); musicNode.start(); }, () => {}); } catch (e) { /* no music */ } }
  const say = (m) => { g.msg = m; g.msgT = 2.5; };
  function start() { g.level = 0; g.hp = 5; g.score = 0; seed = CFG.seed >>> 0; genLevel(0); g.gems = 0; g.state = 'play'; startMusic(); beep(660, 0.15); }
  function hurt() { if (g.inv > 0) return; g.hp--; g.inv = 1.2; g.flash = 0.25; beep(90, 0.3, 'sawtooth', 0.1); if (g.hp <= 0) g.state = 'over'; }
  const hitsSolid = (x, y, hw, hh) => { const c0 = Math.floor((x - hw) / B), c1 = Math.floor((x + hw - 0.01) / B), r0 = Math.floor((y - hh) / B), r1 = Math.floor((y - 0.01) / B); for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (solid(c, r)) return true; return false; };
  function update(dt) {
    g.t += dt; if (g.msgT > 0) g.msgT -= dt; if (g.flash > 0) g.flash -= dt; if (g.inv > 0) g.inv -= dt;
    if (g.state !== 'play') return; const k = g.keys, HW = 7, HH = 22;
    const dir = (k.d || k.ArrowRight ? 1 : 0) - (k.a || k.ArrowLeft ? 1 : 0); const tv = dir * 118, acc = g.ground ? 900 : 600;
    if (dir) g.face = dir; g.vx += Math.max(-acc * dt, Math.min(acc * dt, tv - g.vx)); if (!dir && g.ground) g.vx *= 0.8; if (g.vx && g.ground) g.walk += Math.abs(g.vx) * dt * 0.12;
    g.vy = Math.min(700, g.vy + 1800 * dt); if (g.ground) g.coyote = 0.1; else g.coyote -= dt;
    if ((k.w || k.ArrowUp || k[' ']) && g.coyote > 0 && !g.jumpHeld) { g.vy = -600; g.coyote = 0; g.ground = false; g.jumpHeld = true; beep(520, 0.1, 'square', 0.05); }
    if (!(k.w || k.ArrowUp || k[' '])) { g.jumpHeld = false; if (g.vy < -220) g.vy *= 0.55; }
    let nx = g.px + g.vx * dt; if (hitsSolid(nx, g.py, HW, HH)) { let step = Math.sign(g.vx) * 0.5; nx = g.px; while (!hitsSolid(nx + step, g.py, HW, HH) && Math.abs(nx - g.px) < 8) nx += step; g.vx = 0; } g.px = Math.max(HW, nx);
    let ny = g.py + g.vy * dt; g.ground = false;
    if (hitsSolid(g.px, ny, HW, HH)) { const st = Math.sign(g.vy) * 0.5; ny = g.py; while (!hitsSolid(g.px, ny + st, HW, HH) && Math.abs(ny - g.py) < 14) ny += st; if (g.vy > 0) g.ground = true; g.vy = 0; }
    g.py = ny; if (g.ground && hitsSolid(g.px + 14 * g.face, g.py + 2, 1, 1)) g.safe = [g.px, g.py];
    if (g.py > ROWS * B + 70) { hurt(); if (g.state === 'play') { g.px = g.safe[0]; g.py = g.safe[1] - 2; g.vx = g.vy = 0; g.inv = 1.5; } }
    for (const s of g.shots) { s.x += s.vx * dt; s.life -= dt; if (solid(Math.floor(s.x / B), Math.floor(s.y / B))) s.life = 0; } g.shots = g.shots.filter((s) => s.life > 0);
    for (const s of g.sprites) {
      if (!s.alive) continue;
      if (s.type === 'gem') { if (Math.hypot(s.x - g.px, s.y - (g.py - 11)) < 14) { s.alive = false; g.gems++; g.score += 100; beep(880, 0.1, 'triangle', 0.1); } }
      else if (s.type === 'exit') { if (Math.abs(s.x - g.px) < 14 && Math.abs(s.y - g.py) < 30) { g.level++; g.score += 250 + g.gems * 10; if (g.level >= CFG.levels) { g.state = 'win'; beep(990, 0.4, 'triangle', 0.1); } else { const sc = g.score, hp = g.hp; genLevel(g.level); g.gems = 0; g.score = sc; g.hp = hp; say('Level ' + (g.level + 1)); beep(740, 0.25, 'triangle', 0.1); } return; } }
      else if (s.type === 'enemy') {
        const nx2 = s.x + s.vx * dt, ahead = nx2 + Math.sign(s.vx) * 9, fc = Math.floor(ahead / B), fr = Math.floor((s.y + 4) / B), wr = Math.floor((s.y - 6) / B);
        if (solid(fc, wr) || !solid(fc, fr)) s.vx = -s.vx; else s.x = nx2;
        for (const sh of g.shots) if (Math.abs(sh.x - s.x) < 11 && Math.abs(sh.y - (s.y - 9)) < 13) { s.alive = false; sh.life = 0; g.score += 50; beep(150, 0.15, 'square', 0.09); }
        if (s.alive && Math.abs(g.px - s.x) < 13 && g.py > s.y - 20 && g.py < s.y + 12) { if (g.vy > 80 && g.py < s.y - 6) { s.alive = false; g.vy = -380; g.score += 75; beep(300, 0.12, 'square', 0.09); } else hurt(); }
      }
    }
    const tx = g.px - W / 2 + g.face * 22, ty = g.py - H * 0.62; g.cx += (Math.max(0, Math.min(g.cols * B - W, tx)) - g.cx) * Math.min(1, dt * 6); g.cy += (Math.max(0, Math.min(ROWS * B - H, ty)) - g.cy) * Math.min(1, dt * 4);
  }
  // ---- drawing
  const VX = W / 2, VY = H * 0.40, DEPTH = 0.72;
  const pt = (x, y, s) => [VX + (x - VX) * s, VY + (y - VY) * s];
  function face(a, b, c2, d2, tk, vertical, shadeF) { // a,b front edge (left,right or top,bottom), c2,d2 back edge; textured in 4x5 cells
    const ct = tc[tk], px = ct.__px || (ct.__px = ct.getContext('2d').getImageData(0, 0, T, T).data), NA = 4, ND = 5;
    for (let j = 0; j < ND; j++) for (let i = 0; i < NA; i++) {
      const u0 = i / NA, u1 = (i + 1) / NA, v0 = j / ND, v1 = (j + 1) / ND, lp = (A, Bp, C, D, u, v) => [(A[0] + (Bp[0] - A[0]) * u) * (1 - v) + (C[0] + (D[0] - C[0]) * u) * v, (A[1] + (Bp[1] - A[1]) * u) * (1 - v) + (C[1] + (D[1] - C[1]) * u) * v];
      const p0 = lp(a, b, c2, d2, u0, v0), p1 = lp(a, b, c2, d2, u1, v0), p2 = lp(a, b, c2, d2, u1, v1), p3 = lp(a, b, c2, d2, u0, v1);
      const tx = Math.min(T - 1, Math.floor((vertical ? v0 : u0 + 0.12) * T)), ty = Math.min(T - 1, Math.floor((vertical ? u0 : v0 + 0.1) * T)), o = (ty * T + tx) * 4, fog = 1 - v0 * 0.35;
      ctx.fillStyle = 'rgb(' + (px[o] * shadeF * fog | 0) + ',' + (px[o + 1] * shadeF * fog | 0) + ',' + (px[o + 2] * shadeF * fog | 0) + ')'; ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.lineTo(p3[0], p3[1]); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }
  function drawBlock(c, r, kind, sx, sy, front) {
    const tk = kind === 1 ? 'floor' : 'wall';
    if (front) { ctx.drawImage(tc[tk], sx, sy, B, B); if (kind === 1 && !solid(c, r - 1)) { ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(sx, sy, B, 2); } if (!solid(c, r + 1) || !solid(c + 1, r)) { ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(sx, sy + B - 2, B, 2); } return; }
    const f = [[sx, sy], [sx + B, sy], [sx, sy + B], [sx + B, sy + B]], b = f.map((q) => pt(q[0], q[1], DEPTH));
    if (sy > VY && !solid(c, r - 1)) face(f[0], f[1], b[0], b[1], tk, false, 1.18);
    if (sy + B < VY && !solid(c, r + 1)) face(f[2], f[3], b[2], b[3], tk, false, 0.5);
    if (sx + B < VX && !solid(c + 1, r)) face(f[1], f[3], b[1], b[3], tk, true, 0.62);
    if (sx > VX && !solid(c - 1, r)) face(f[0], f[2], b[0], b[2], tk, true, 0.62);
  }
  function sprite(k, x, y, w, h, flip, sq, outline) { ctx.save(); ctx.translate(x, y); ctx.scale(flip ? -1 : 1, 1); if (outline) { if (!tc[k + 'O']) { const c = document.createElement('canvas'); c.width = c.height = T; const q = c.getContext('2d'); q.drawImage(tc[k], 0, 0); q.globalCompositeOperation = 'source-atop'; q.fillStyle = '#000'; q.fillRect(0, 0, T, T); tc[k + 'O'] = c; } for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) ctx.drawImage(tc[k + 'O'], -w / 2 + ox, -h * sq + oy, w, h * sq); } ctx.drawImage(tc[k], -w / 2, -h * sq, w, h * sq); ctx.restore(); }
  function render() {
    const cx = g.cx, cy = g.cy, S = tint;
    let gr = ctx.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, col(sky[0], 1)); gr.addColorStop(1, col(sky[1], 1)); ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
    if (!deco) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); return; }
    for (const [x, y, b] of deco.stars) { const sx = ((x - cx * 0.03) % (W + 40) + W + 40) % (W + 40) - 10; ctx.fillStyle = 'rgba(255,255,255,' + (0.35 + 0.55 * Math.abs(Math.sin(g.t * 1.5 + b * 9))) + ')'; ctx.fillRect(sx | 0, (y - cy * 0.02) | 0, b > 0.85 ? 2 : 1, b > 0.85 ? 2 : 1); }
    for (const [x, y, w, hh] of deco.clouds) { const sx = ((x - cx * 0.12 + g.t * 3) % (W + 220) + W + 220) % (W + 220) - 110, sy = y - cy * 0.08; const rg = ctx.createRadialGradient(sx, sy, 2, sx, sy, w); rg.addColorStop(0, col([sky[1][0] * 2.2 + 30, sky[1][1] * 2.4 + 60, sky[1][2] * 2 + 80], 1, 0.75)); rg.addColorStop(1, col(sky[1], 1, 0)); ctx.save(); ctx.translate(0, sy); ctx.scale(1, hh / w); ctx.translate(0, -sy); ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(sx, sy, w, 0, 6.3); ctx.fill(); ctx.restore(); ctx.globalAlpha = 0.28; ctx.drawImage(tc.ceil, sx - w * 0.6, sy - hh * 0.3, w * 1.2, hh * 0.6); ctx.globalAlpha = 1; }
    const horizon = H - 62 - (cy * 0.35); ctx.fillStyle = col(sky[1], 0.55);
    for (const [x, hgt, w, r] of deco.sky) { const sx = ((x - cx * 0.28) % (W + 200) + W + 200) % (W + 200) - 40; const top = horizon - hgt - r * 18; ctx.fillRect(sx | 0, top | 0, w | 0, H - top); ctx.fillStyle = col(avg.gem, 0.5, 0.35); if (r > 0.5) ctx.fillRect((sx + 3) | 0, (top + 6) | 0, 2, 2); ctx.fillStyle = col(sky[1], 0.55); }
    ctx.fillStyle = col(sky[1], 0.8); ctx.fillRect(0, horizon + 4, W, H);
    for (const [x, rows, wd] of deco.ruins) { const sx = ((x - cx * 0.55) % (W + 360) + W + 360) % (W + 360) - 60; for (let r = 0; r < rows; r++) for (let c = 0; c < wd; c++) ctx.drawImage(tc.wallBg, (sx + c * 16) | 0, (horizon + 6 - r * 16 - cy * 0.1) | 0, 16, 16); }
    // gameplay plane: extruded blocks
    const c0 = Math.max(0, Math.floor(cx / B) - 1), c1 = Math.min(g.cols - 1, Math.ceil((cx + W) / B) + 1), r0 = Math.max(0, Math.floor(cy / B) - 1), r1 = Math.min(ROWS - 1, Math.ceil((cy + H) / B) + 1), list = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const kd = g.grid[r * g.cols + c]; if (kd) { const sx = c * B - cx, sy = r * B - cy; list.push([Math.abs(sx + B / 2 - VX) + Math.abs(sy + B / 2 - VY), c, r, kd, sx | 0, sy | 0]); } }
    list.sort((a, b) => b[0] - a[0]); for (const q of list) drawBlock(q[1], q[2], q[3], q[4], q[5], false); for (const q of list) drawBlock(q[1], q[2], q[3], q[4], q[5], true);
    const sc = (x, y) => [x - cx, y - cy];
    for (const s of g.sprites) { if (!s.alive) continue; const [x, y] = sc(s.x, s.y); if (x < -40 || x > W + 40) continue;
      if (s.type === 'gem') { const bob = Math.sin(g.t * 3 + s.ph) * 3; ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(x, y + 12, 6, 2, 0, 0, 6.3); ctx.fill(); sprite('gem', x, y + bob + 10, 20, 20, false, 1); }
      else if (s.type === 'enemy') { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(x, y + 1, 9, 3, 0, 0, 6.3); ctx.fill(); sprite('enemy', x, y + 1, 26, 26, s.vx > 0, 1 + Math.sin(g.t * 8 + s.x) * 0.04, true); }
      else { ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(x - 14, y + B - 2, 28, 3); sprite('exit', x, y + B, 32, 32, false, 1); } }
    for (const sh of g.shots) { const [x, y] = sc(sh.x, sh.y); ctx.fillStyle = '#fff'; ctx.fillRect(x - 3, y - 1, 6, 3); ctx.fillStyle = col(avg.gem, 1.6, 0.6); ctx.fillRect(x - 5, y - 2, 10, 5); }
    { const [x, y] = sc(g.px, g.py); ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.beginPath(); ctx.ellipse(x, y, 9, 3, 0, 0, 6.3); ctx.fill(); if (g.inv <= 0 || Math.floor(g.t * 14) % 2) sprite('player', x, y + 1, 34, 34, g.face < 0, g.ground ? 1 + (Math.abs(g.vx) > 10 ? Math.sin(g.walk * 6) * 0.05 : 0) : g.vy < 0 ? 1.1 : 0.94, true); }
        for (const [x, y, w] of deco.fg) { const sx = ((x - cx * 1.5) % (W + 420) + W + 420) % (W + 420) - 60; ctx.globalAlpha = 0.6; ctx.drawImage(tc.wallFg, sx | 0, (H - 40 - cy * 0.15) | 0, w * 1.6, 60); ctx.globalAlpha = 0.7; ctx.drawImage(tc.floorFg, (sx - 14) | 0, (H - 20 - cy * 0.2) | 0, w * 2.2, 18); }
    { if (!glowC) { glowC = document.createElement('canvas'); glowC.width = 64; glowC.height = 56; } const gx = glowC.getContext('2d'); gx.imageSmoothingEnabled = true; gx.drawImage(cv, 0, 0, 64, 56); ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.34; ctx.imageSmoothingEnabled = true; ctx.drawImage(glowC, 0, 0, W, H); ctx.restore(); ctx.imageSmoothingEnabled = false; }
    const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, H * 0.85); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.5)'); ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    if (g.flash > 0) { ctx.fillStyle = 'rgba(255,60,60,' + Math.min(0.4, g.flash * 1.5) + ')'; ctx.fillRect(0, 0, W, H); }
    ctx.font = 'bold 8px monospace'; ctx.textBaseline = 'top'; const txt = (s, x, y, c) => { ctx.fillStyle = '#000'; ctx.fillText(s, x + 1, y + 1); ctx.fillStyle = c || '#fff'; ctx.fillText(s, x, y); };
    if (g.state === 'play') {
      txt('P', 8, 6, '#fff'); for (let i = 0; i < 10; i++) { ctx.fillStyle = '#000'; ctx.fillRect(20 + i * 6, 5, 5, 9); ctx.fillStyle = i < g.hp * 2 ? '#e8e8e8' : '#3a3a44'; ctx.fillRect(21 + i * 6, 6, 3, 7); }
      txt('G', 8, 20, '#fff'); const seg = Math.min(14, g.need); for (let i = 0; i < seg; i++) { ctx.fillStyle = '#000'; ctx.fillRect(20 + i * 6, 19, 5, 9); ctx.fillStyle = i < Math.round(g.gems / g.need * seg) ? col(avg.gem, 1.5) : '#2a3a4a'; ctx.fillRect(21 + i * 6, 20, 3, 7); }
      txt('LV ' + (g.level + 1) + '/' + CFG.levels + '  SCORE ' + g.score, W - 112, 6); if (g.msgT > 0) { ctx.textAlign = 'center'; txt(g.msg, W / 2, H - 20, '#ff8'); ctx.textAlign = 'left'; }
    } else { ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, 0, W, H); ctx.textAlign = 'center'; ctx.font = 'bold 16px monospace'; txt(g.state === 'title' ? CFG.title : g.state === 'win' ? 'YOU WIN!' : 'GAME OVER', W / 2, 50, '#ffd84a'); ctx.font = 'bold 8px monospace'; if (g.state !== 'title') txt('SCORE ' + g.score, W / 2, 80);
      txt(g.state === 'title' ? 'PRESS ENTER TO START' : 'PRESS ENTER TO PLAY AGAIN', W / 2, 150); if (g.state === 'title') { txt('A/D move   W or SPACE jump   X shoot   C scanlines', W / 2, 168, '#aaa'); txt('Stomp enemies, grab gems, reach the door', W / 2, 180, '#aaa'); for (const [n, x] of [['player', 80], ['gem', 120], ['enemy', 160], ['exit', 200]]) { ctx.imageSmoothingEnabled = false; ctx.drawImage(tc[n], x - 16, 88, 32, 32); } } ctx.textAlign = 'left'; }
  }
  ctx.imageSmoothingEnabled = false;
  let last = performance.now(); function loop(now) { const dt = Math.min(0.05, (now - last) / 1000); last = now; update(dt); render(); requestAnimationFrame(loop); }
  genLevel(0); g.state = 'title'; requestAnimationFrame(loop);
  const shoot = () => { if (g.state === 'play' && g.shots.length < 2) { g.shots.push({ x: g.px + g.face * 10, y: g.py - 12, vx: g.face * 260, life: 0.9 }); beep(300, 0.08, 'sawtooth', 0.05); } };
  window.addEventListener('keydown', (e) => { const k = e.key.length === 1 ? e.key.toLowerCase() : e.key; g.keys[k] = true; if (k === 'Enter' && g.state !== 'play') start(); if (k === 'x' || k === 'f' || k === 'j') shoot(); if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(k)) e.preventDefault(); });
  window.addEventListener('keyup', (e) => { const k = e.key.length === 1 ? e.key.toLowerCase() : e.key; g.keys[k] = false; });
  cv.addEventListener('click', shoot);
  window.__g = g; window.__start = start; window.__update = update; window.__genLevel = genLevel;
}
// Build the final single-file page
G3.buildHtml = function (cfg) {
  const tex = {}; for (const k of Object.keys(cfg.textures)) tex[k] = b64(cfg.textures[k]);
  const C = { mode: cfg.mode, title: cfg.title, T: cfg.T, tex, music: cfg.music ? b64(cfg.music) : null, levels: cfg.levels, size: cfg.size, enemies: cfg.enemies, seed: cfg.seed };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(cfg.title) + ' ' + (cfg.mode === 'maze' ? '3D' : '2.5D') + '</title>\n<style>html,body{margin:0;height:100%;background:#000;color:#9aa;font:13px system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center}canvas{image-rendering:pixelated;width:100%;height:100%;display:block;background:#000;outline:none}.wrap{position:relative;width:min(100vw,calc((100vh - 40px)*256/224));aspect-ratio:256/224}.wrap:after{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(to bottom,rgba(0,0,0,.2) 0,rgba(0,0,0,.2) 1px,transparent 1px,transparent 3px)}body.nocrt .wrap:after{display:none}p{margin:6px;text-align:center}</style></head>\n<body><div class="wrap"><canvas id="screen" tabindex="0"></canvas></div><p>' + esc(cfg.title) + ' &middot; 3D rebuild made from the ROM&rsquo;s own art by SNES Studio &middot; personal use only</p>\n<script>\n(' + (cfg.mode === 'maze' ? engine : engineSide).toString() + ')(' + JSON.stringify(C) + ');\nwindow.addEventListener("keydown",function(e){if(e.key==="c"||e.key==="C")document.body.classList.toggle("nocrt");});\n</script></body></html>';
};
// Turn UI choices into a build config
G3.makeConfig = function (rom, o) {
  const data = o.data || rom, fmt = fmtOf(o.platform, o.fmt), tb = Core.FORMATS[fmt].bytes, pal = G3.palette(rom, o.platform, o.fmt, o.palOff, o.palSub), T = o.size === 8 ? 8 : 16, tex = {};
  for (const [role] of G3.ROLES) { const base = o.off + (o.picks[role] || 0) * tb; tex[role] = G3.blockRGBA(data, base, fmt, pal, T, role === 'gem' || role === 'enemy' || role === 'exit' || role === 'player'); }
  return { title: (o.title || 'MY 3D GAME').slice(0, 24), T, textures: tex, music: o.music || null, levels: o.levels || 3, size: o.mazeSize || 4, enemies: o.enemies == null ? 3 : o.enemies, seed: o.seed || 12345, mode: o.mode === 'maze' ? 'maze' : 'side' };
};
Core.Game3D = G3;
if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof window !== 'undefined' ? window : globalThis);
