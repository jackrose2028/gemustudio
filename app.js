/* SNES Studio UI. Depends on core.js (window.SnesCore). */
(function () {
'use strict';
const Core = window.SnesCore, hex = Core.hex;
const $ = (s, r) => (r || document).querySelector(s);

/* ---------- tiny DOM helper ---------- */
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in (attrs || {})) {
    const v = attrs[k];
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'value') e.value = v;
    else if (k === 'checked') e.checked = !!v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- state ---------- */
const S = {
  rom: null, orig: null, src: null, name: '', mapping: 'LoROM', hdr: 0x7FC0, hadCopier: false,
  platform: 'snes', nes: null, ext: '.sfc', hist: [], redo: [], group: null, lib: [], base: null, cls: null, clsDirty: new Set(), diffCount: 0, libId: 1
};
window.__studio = S; // handy for debugging in the console
const CELL = 512;

const toast = (msg, ms) => { const t = $('#toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = 'none'), ms || 2600); };
const setStatus = (m) => { $('#statusMsg').textContent = m; };
const NES = Core.NES;
const isNes = () => S.platform === 'nes';
const snes = (f) => (isNes() ? NES.fileToCpu(f, S.nes) : Core.fileToSnes(f, S.mapping));
const fmtSnes = (f) => { if (isNes()) return NES.describe(f, S.nes); const a = snes(f); return hex(a >> 16, 2) + ':' + hex(a & 0xFFFF, 4); };
const mapLabel = () => (isNes() ? 'NES · ' + S.nes.mapperName : S.mapping);
const projLabel = () => S.name + ' · ' + mapLabel() + ' · ' + (S.rom.length >> 10) + ' KB';
const isEmptyHdr = () => false;
const hasRom = () => !!S.rom;
function needRom() { if (!S.rom) { toast('Open a ROM or start a new project first.'); return false; } return true; }

/* location parsing: "C0:8000" = SNES address, anything else = hex file offset */
function parseLoc(str) {
  str = String(str).trim();
  if (!str) return null;
  let m;
  if (isNes() && (m = /^cpu:\$?([0-9a-f]{1,4})$/i.exec(str))) return NES.cpuToFile(parseInt(m[1], 16), S.nes, CD.bank || 0);
  if (isNes()) { str = str.replace(/^(\$|0x|@)/i, ''); if (!/^[0-9a-f]+$/i.test(str)) return null; const v = parseInt(str, 16); return v < S.rom.length ? v : null; }
  if ((m = /^\$?([0-9a-f]{1,2}):([0-9a-f]{1,4})$/i.exec(str))) {
    const f = Core.snesToFile((parseInt(m[1], 16) << 16) | parseInt(m[2], 16), S.mapping, S.rom.length);
    return f;
  }
  str = str.replace(/^(\$|0x|@)/i, '');
  if (!/^[0-9a-f]+$/i.test(str)) return null;
  const v = parseInt(str, 16);
  return v < S.rom.length ? v : null;
}
function parseCpu(str) {
  str = String(str).trim().replace(/^\$/, '');
  if (isNes()) { if (!/^[0-9a-f]{1,4}$/i.test(str)) return null; return parseInt(str, 16); }
  let m;
  if ((m = /^([0-9a-f]{1,2}):([0-9a-f]{1,4})$/i.exec(str))) return (parseInt(m[1], 16) << 16) | parseInt(m[2], 16);
  if (!/^[0-9a-f]+$/i.test(str)) return null;
  let v = parseInt(str, 16);
  if (v <= 0xFFFF) v |= (S.mapping === 'HiROM' ? 0xC00000 : 0);
  return v;
}

/* ---------- undoable writes ---------- */
function markCells(off, len) { for (let c = Math.floor(off / CELL); c <= Math.floor((off + len - 1) / CELL); c++) S.clsDirty.add(c); }
function write(off, bytes, label) {
  if (!S.rom) return false;
  bytes = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (off < 0 || off >= S.rom.length) return false;
  if (off + bytes.length > S.rom.length) bytes = bytes.slice(0, S.rom.length - off);
  const old = S.rom.slice(off, off + bytes.length);
  let same = true; for (let i = 0; i < bytes.length; i++) if (old[i] !== bytes[i]) { same = false; break; }
  if (same) return true;
  S.rom.set(bytes, off);
  if (isNes() && off < 16) S.nes = NES.parse(S.rom) || S.nes;
  markCells(off, bytes.length);
  const ch = { off, old, nw: bytes.slice() };
  if (S.group) S.group.changes.push(ch);
  else { S.hist.push({ label: label || 'Edit', changes: [ch] }); if (S.hist.length > 400) S.hist.shift(); }
  S.redo.length = 0;
  notify();
  return true;
}
function beginGroup(label) { S.group = { label, changes: [] }; }
function endGroup() {
  const g = S.group; S.group = null;
  if (g && g.changes.length) { S.hist.push(g); if (S.hist.length > 400) S.hist.shift(); }
  notify();
}
function undo() {
  const e = S.hist.pop(); if (!e) return toast('Nothing to undo');
  for (let i = e.changes.length - 1; i >= 0; i--) { const c = e.changes[i]; S.rom.set(c.old, c.off); markCells(c.off, c.old.length); }
  if (isNes()) S.nes = NES.parse(S.rom) || S.nes;
  S.redo.push(e); setStatus('Undid: ' + e.label); notify();
}
function redo() {
  const e = S.redo.pop(); if (!e) return toast('Nothing to redo');
  for (const c of e.changes) { S.rom.set(c.nw, c.off); markCells(c.off, c.nw.length); }
  if (isNes()) S.nes = NES.parse(S.rom) || S.nes;
  S.hist.push(e); setStatus('Redid: ' + e.label); notify();
}

let notifyQueued = false;
function notify() {
  if (notifyQueued) return; notifyQueued = true;
  requestAnimationFrame(() => { notifyQueued = false; refreshAll(); });
}
function countDiff() {
  if (!S.rom || !S.orig) return 0;
  let n = 0; const a = S.rom, b = S.orig, m = Math.max(a.length, b.length);
  for (let i = 0; i < m; i++) if (a[i] !== b[i]) n++;
  return n;
}

/* ---------- ROM loading ---------- */
function setProject(rom, o) {
  S.rom = rom; S.orig = rom.slice(); S.name = o.name; S.mapping = o.mapping; S.hdr = o.hdr; S.hadCopier = !!o.hadCopier;
  GM.rebuild = null; R3.key = null; AU.mode = null; AU.pcm = null; AU.scan = []; AU.inited = false; AU.sel = null; AU.hist = []; try { if (AU.src) AU.src.stop(); } catch (e) { /* stopped */ } AU.src = null; AU.off = 0; AU.len = 0; AU.dest = null; AU.loopBlock = -1; R.builtFor = null; R.inited = false; R.manual = ''; R.nes.ntFill = false;
  S.platform = o.platform || 'snes'; S.nes = o.nes || null; S.ext = o.ext || (S.platform === 'nes' ? '.nes' : '.sfc'); CD.reset = true;
  if (S.platform === 'nes' && Core.FORMATS[G.fmt] && !Core.FORMATS[G.fmt].nes) { G.fmt = 'nes2bpp'; G.cols = 16; G.rows = 16; G.pal = 'gray'; G.palSub = 0; G.color = Math.min(G.color, 3); }
  if (S.platform !== 'nes' && G.fmt === 'nes2bpp') { G.fmt = '4bpp'; G.pal = 'gray'; }
  S.hist = []; S.redo = []; S.group = null; S.base = o.base; S.cls = null; S.clsDirty = new Set();
  if (o.keepSrc !== true) S.src = o.src || rom.slice();
  H.base = 0; H.a = H.b = 0; G.off = 0; P.off = 0; P.sel = 0; textCache = null; palCache = null;
  Object.assign(CD, { addr: null, back: [], sel: null });
  $('#projname').textContent = projLabel();
}
function loadNes(bytes, name) {
  const info = NES.parse(bytes); const data = bytes.slice();
  setProject(data, { name, mapping: 'NES', hdr: 0, platform: 'nes', nes: info, ext: '.nes', base: { kind: 'rom', platform: 'nes', size: data.length, sum: Core.sumBytes(data) } });
  Object.assign(G, { fmt: 'nes2bpp', cols: 16, rows: 16, pal: 'gray', palSub: 0, tile: 0, off: info.chrSize ? info.chrOff : info.prgOff, zoom: 3 });
  const pals = NES.scanPalettes(data, info, 1); if (pals.length) { P.off = pals[0].off; G.palOff = pals[0].off; }
  ensureClass(); showTab('overview'); CD.addr = null;
  toast('Loaded NES ROM ' + name + ' · mapper ' + info.mapper + ' (' + info.mapperName + '), ' + (info.prgSize >> 10) + ' KB PRG, ' + (info.chrSize ? (info.chrSize >> 10) + ' KB CHR' : 'CHR-RAM') + (info.warn.length ? ' · ' + info.warn.join('; ') : ''), 5200);
  setStatus('Loaded ' + name + ' as NES'); notify();
}
function loadRomBytes(bytes, name) {
  if (NES.isNes(bytes)) return loadNes(bytes, name);
  const { data, hadHeader } = Core.stripCopierHeader(bytes);
  if (data.length < 0x8000 + 0x40) return toast('That file is not a recognised SNES (.sfc/.smc) or NES (.nes) ROM.');
  const det = Core.detect(data);
  setProject(data, { name, mapping: det.mapping, hdr: det.hdr, hadCopier: hadHeader, ext: (hadHeader || /\.smc$/i.test(name)) ? '.smc' : '.sfc', base: { kind: 'rom', size: data.length, sum: Core.sumBytes(data) } });
  // pick a likely tile area to start in
  ensureClass();
  const first = S.cls.findIndex((c) => c === 'data');
  if (first >= 0) G.off = Math.min(first * CELL, Math.max(0, S.rom.length - 0x2000));
  const warnings = [];
  if (det.score < 10) warnings.push('header looks unusual (score ' + det.score + ')');
  if (!Core.isPow2(data.length)) warnings.push('size is not a power of two');
  if (!Core.checksumOk(data, det.hdr)) warnings.push('header checksum does not match the data');
  showTab('overview');
  toast('Loaded ' + name + (hadHeader ? ' (removed 512-byte copier header)' : '') + (warnings.length ? ' · ' + warnings.join('; ') : ''), 4200);
  setStatus('Loaded ' + name + ' as ' + det.mapping);
  notify();
}
function openRomFile(file) {
  const r = new FileReader();
  r.onload = () => loadRomBytes(new Uint8Array(r.result), file.name);
  r.onerror = () => toast('Could not read that file.');
  r.readAsArrayBuffer(file);
}

/* ---------- classification cache for the asset map ---------- */
function ensureClass() {
  const cells = Math.ceil(S.rom.length / CELL);
  if (!S.cls || S.cls.length !== cells) { S.cls = new Array(cells); for (let i = 0; i < cells; i++) S.cls[i] = Core.classifyBlock(S.rom, i * CELL, CELL); S.clsDirty.clear(); return; }
  for (const c of S.clsDirty) if (c < cells) S.cls[c] = Core.classifyBlock(S.rom, c * CELL, CELL);
  S.clsDirty.clear();
}

/* =========================================================
   TABS
   ========================================================= */
const tabs = [];
function defineTab(id, title, build, refresh, needsRom) {
  const el = h('div', { class: 'panel', id: 'tab-' + id });
  const msg = h('div', { class: 'card' }, 'Open a ROM or start a new project to use this tool.');
  const body = h('div'); msg.style.display = 'none'; el.append(msg, body);
  tabs.push({ id, title, el, body, msg, build, refresh, needsRom: !!needsRom, built: false });
  return el;
}
function refreshTab(t) {
  const blocked = t.needsRom && !S.rom;
  t.msg.style.display = blocked ? 'block' : 'none'; t.body.style.display = blocked ? 'none' : 'block';
  if (!blocked && t.built && t.refresh) t.refresh();
}
let activeTab = 'overview';
function showTab(id) {
  activeTab = id;
  for (const t of tabs) {
    t.el.classList.toggle('active', t.id === id);
    if (t.id === id && !t.built) { t.build(t.body); t.built = true; }
  }
  endNib();
  for (const b of document.querySelectorAll('#nav button[data-tab]')) b.classList.toggle('active', b.dataset.tab === id);
  const t = tabs.find((x) => x.id === id); if (t) refreshTab(t);
}
function refreshAll() {
  if (S.rom) { S.diffCount = countDiff(); }
  $('#btnUndo').disabled = !S.hist.length; $('#btnRedo').disabled = !S.redo.length;
  for (const id of ['btnSave', 'btnIps']) $('#' + id).disabled = !S.rom;
  $('#btnSave').textContent = S.rom ? (isNes() ? 'Save .nes' : 'Save ROM') : 'Save ROM';
  const st = $('#navstat');
  if (st) st.innerHTML = S.rom ? `<b>${S.diffCount.toLocaleString()}</b> bytes changed<br>${S.hist.length} edit${S.hist.length === 1 ? '' : 's'} in history` : 'No project';
  $('#statusInfo').textContent = S.rom ? S.name + ' · ' + mapLabel() + ' · ' + (S.rom.length >> 10) + ' KB · ' + S.diffCount.toLocaleString() + ' bytes changed' : '';
  const t = tabs.find((x) => x.id === activeTab); if (t) refreshTab(t);
}
function noRomMsg(el) { el.replaceChildren(h('div', { class: 'card' }, 'Open a ROM or start a new project to use this tool.')); }

/* =========================================================
   OVERVIEW
   ========================================================= */
const CLASS_COLORS = { empty: '#20242c', text: '#fbbf24', packed: '#a78bfa', code: '#4cc2ff', data: '#4ade80', gfx: '#2dd4bf', header: '#f472b6' };
const CLASS_NAMES = { empty: 'Empty / fill', text: 'Text-like', packed: 'Compressed or high-entropy', code: 'Likely 65816 code', data: 'Likely tiles, maps or tables', gfx: 'CHR graphics (NES)', header: 'iNES header / trainer' };
function cellClass(i) {
  if (isNes()) { const o = i * CELL, n = S.nes; if (o < n.prgOff) return 'header'; if (n.chrSize && o + CELL > n.chrOff && o < n.chrOff + n.chrSize && S.cls[i] !== 'empty') return 'gfx'; }
  return S.cls[i];
}
const OV = { el: null };
defineTab('overview', 'Overview', (el) => { OV.el = el; }, () => {
  const el = OV.el;
  if (!S.rom) {
    el.replaceChildren(h('div', { class: 'hero' },
      h('h1', {}, 'SNES Studio'),
      h('p', {}, 'Load a Super Nintendo (.sfc / .smc) or NES (.nes) ROM you own, see every asset in it, edit graphics, palettes, text and code, then package a modded ROM or a patch. Or start a brand-new SNES or NES game from a working starter engine.'),
      h('p', {}, 'Everything runs in your browser. Nothing is uploaded.'),
      h('div', { class: 'big' }, h('button', { class: 'primary', onclick: () => $('#fileRom').click() }, 'Open ROM…'), h('button', { onclick: newProjectDialog }, 'New project…')),
      h('p', { class: 'muted' }, 'You can also drag a .sfc / .smc file onto this window.'),
      h('p', { class: 'muted', style: 'font-size:12px' }, 'Use only ROMs you are entitled to use. To share a mod, export an IPS patch instead of the ROM itself.')));
    return;
  }
  ensureClass();
  const hd = isNes() ? null : Core.readHeader(S.rom, S.hdr);
  const csOk = isNes() ? true : Core.checksumOk(S.rom, S.hdr);
  const v = isNes() ? null : hd.vectors;
  const vecBtn = (name, a) => h('button', { class: 'small', title: 'Disassemble ' + name, onclick: () => gotoCode(isNes() ? a : ((S.mapping === 'HiROM' ? 0xC0 : 0) << 16) | a) }, name + ' $' + hex(a, 4));
  const nv = isNes() ? NES.vectors(S.rom, S.nes) : null, nn = S.nes;
  const info = isNes() ? h('div', { class: 'card' }, h('h2', {}, 'NES cartridge (iNES' + (nn.nes2 ? ' 2.0' : '') + ')'),
    h('div', { class: 'kv' },
      h('span', {}, 'Mapper'), h('span', {}, nn.mapper + ' · ' + nn.mapperName),
      h('span', {}, 'PRG ROM'), h('span', {}, (nn.prgSize >> 10) + ' KB (' + (nn.prgSize >> 14) + ' × 16 KB) at file $' + hex(nn.prgOff, 5)),
      h('span', {}, 'CHR'), h('span', {}, nn.chrSize ? (nn.chrSize >> 10) + ' KB ROM (' + (nn.chrSize >> 13) + ' × 8 KB) at file $' + hex(nn.chrOff, 5) : 'none: uses CHR-RAM, tiles are in PRG code'),
      h('span', {}, 'Mirroring'), h('span', {}, nn.mirror), h('span', {}, 'Battery save'), h('span', {}, nn.battery ? 'yes' : 'no'),
      h('span', {}, 'Trainer'), h('span', {}, nn.trainer ? '512 bytes' : 'none')),
    nn.warn.length ? h('p', { class: 'warn' }, nn.warn.join('; ')) : null,
    nn.mapper > 4 && nn.mapper !== 7 ? h('p', { class: 'muted', style: 'font-size:12px' }, 'This mapper switches banks in ways Studio only approximates: the Code tab shows the bank you pick at $8000 and the last bank at $C000.') : null,
    h('h3', {}, 'Entry points'),
    h('div', { class: 'row' }, vecBtn('RESET', nv.RESET), vecBtn('NMI', nv.NMI), vecBtn('IRQ', nv.IRQ)))
  : h('div', { class: 'card' }, h('h2', {}, 'Cartridge'),
    h('div', { class: 'kv' },
      h('span', {}, 'Title'), h('span', { class: 'mono' }, hd.title || '(blank)'),
      h('span', {}, 'Mapping'), h('span', {}, S.mapping + ' (map mode $' + hex(hd.mapMode) + ')'),
      h('span', {}, 'Size'), h('span', {}, (S.rom.length / 1024) + ' KB (' + (S.rom.length / 32768) + ' LoROM banks)'),
      h('span', {}, 'Cartridge type'), h('span', {}, '$' + hex(hd.cartType) + (hd.cartType === 0 ? ' ROM only' : hd.cartType === 1 ? ' ROM + RAM' : hd.cartType === 2 ? ' ROM + RAM + battery' : hd.cartType >= 3 ? ' coprocessor' : '')),
      h('span', {}, 'Save RAM'), h('span', {}, hd.ramSizeCode ? (1 << hd.ramSizeCode) + ' KB' : 'none'),
      h('span', {}, 'Region / version'), h('span', {}, '$' + hex(hd.region) + ' / ' + hd.version),
      h('span', {}, 'Header checksum'), h('span', { class: csOk ? 'ok' : 'warn' }, csOk ? 'valid' : 'does not match (Save .sfc can fix it)'),
      h('span', {}, 'Copier header'), h('span', {}, S.hadCopier ? 'was present, removed on load' : 'none'),
      h('span', {}, 'Header at'), h('span', { class: 'mono' }, '$' + hex(S.hdr, 4) + ' (file)')),
    h('h3', {}, 'Entry points'),
    h('div', { class: 'row' }, vecBtn('RESET', v.RESET), vecBtn('NMI', v.NMIn), vecBtn('IRQ', v.IRQn), vecBtn('NMI(e)', v.NMIe)));
  const cv = h('canvas', { id: 'assetmap' });
  const tip = h('div', { class: 'muted mono', style: 'min-height:20px;margin-top:4px' }, 'Hover the map for details; click to open the hex view.');
  const counts = {}; for (let i = 0; i < S.cls.length; i++) { const c = cellClass(i); counts[c] = (counts[c] || 0) + 1; }
  const legend = h('div', { class: 'legend' }, Object.keys(CLASS_COLORS).filter((k) => counts[k] || !/^(gfx|header)$/.test(k)).map((k) => h('span', {}, h('i', { style: 'background:' + CLASS_COLORS[k] }), CLASS_NAMES[k] + ' (' + Math.round(100 * (counts[k] || 0) / S.cls.length) + '%)')), h('span', {}, h('i', { style: 'background:#fff' }), 'edited'));
  const map = h('div', { class: 'card' }, h('h2', {}, 'Asset map'),
    h('p', { class: 'muted' }, 'Each square is 512 bytes; each row is one 32 KB bank. Colours are heuristics from byte statistics, not a guarantee.'), cv, tip, legend);
  el.replaceChildren(h('div', { class: 'cols' }, h('div', { style: 'flex:1 1 360px;min-width:300px' }, info, guideCard()), h('div', { style: 'flex:1 1 520px' }, map)));
  drawAssetMap(cv, tip);
});
function guideCard() {
  return h('div', { class: 'card' }, h('h2', {}, 'Workflow'),
    h('ol', { style: 'margin:0;padding-left:18px' },
      h('li', {}, h('b', {}, 'Find'), ' assets: map above, Palettes ▸ Scan, Text ▸ Scan.'),
      h('li', {}, h('b', {}, 'Edit'), ' tiles in Graphics, colours in Palettes, strings in Text, bytes in Hex, code in Code.'),
      h('li', {}, h('b', {}, 'Borrow'), ' pieces into the Library and insert them elsewhere or into a new project.'),
      h('li', {}, h('b', {}, 'Package'), ' in Export: fix the checksum, resize, then Save .sfc or an IPS patch.')),
    h('p', { class: 'muted', style: 'margin:8px 0 0;font-size:12px' }, 'Tip: Ctrl+Z / Ctrl+Y undo and redo every edit. Compressed assets appear purple and cannot be edited as tiles until decompressed by game code.'));
}
function drawAssetMap(cv, tip) {
  const cols = 64, rows = Math.ceil(S.cls.length / cols), px = 8;
  cv.width = cols * px; cv.height = rows * px;
  const ctx = cv.getContext('2d');
  // modified cells
  const mod = new Set(); const a = S.rom, b = S.orig;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) mod.add(Math.floor(i / CELL));
  S.cls.forEach((c0, i) => {
    const c = cellClass(i);
    const x = (i % cols) * px, y = Math.floor(i / cols) * px;
    ctx.fillStyle = CLASS_COLORS[c]; ctx.fillRect(x, y, px - 1, px - 1);
    if (mod.has(i)) { ctx.fillStyle = '#fff'; ctx.fillRect(x + 2, y + 2, px - 5, px - 5); }
  });
  const cellAt = (e) => { const r = cv.getBoundingClientRect(); const x = Math.floor((e.clientX - r.left) / r.width * cols), y = Math.floor((e.clientY - r.top) / r.height * rows); return y * cols + x; };
  cv.onmousemove = (e) => { const i = cellAt(e); if (i >= 0 && i < S.cls.length) tip.textContent = 'file $' + hex(i * CELL, 6) + ' · ' + fmtSnes(i * CELL) + ' · ' + CLASS_NAMES[cellClass(i)]; };
  cv.onclick = (e) => { const i = cellAt(e); if (i >= 0 && i < S.cls.length) { hexGoto(i * CELL); showTab('hex'); } };
}

/* =========================================================
   HEX
   ========================================================= */
const H = { base: 0, a: 0, b: 0, nib: null, rows: 24, el: null, view: null, info: null };
defineTab('hex', 'Hex', (el) => {
  H.el = el;
  H.view = h('div', { id: 'hexview', tabindex: '0' });
  H.info = h('div', { class: 'muted mono', style: 'margin:6px 0' });
  const go = h('input', { type: 'text', id: 'hexgo', placeholder: 'C0:8000 or 1F2A0', size: 14 });
  const find = h('input', { type: 'text', id: 'hexfind', placeholder: 'hex "A9 00" or text', size: 18 });
  const fill = h('input', { type: 'text', id: 'hexfill', value: '00', size: 3 });
  el.append(
    h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('label', {}, 'Go to'), go, h('button', { onclick: () => { const f = parseLoc(go.value); if (f == null) return toast('Use C0:8000 (SNES) or a hex file offset'); hexGoto(f); } }, 'Go'),
        h('span', { class: 'sep' }), h('label', {}, 'Find'), find, h('button', { onclick: () => hexFind(find.value) }, 'Find next'),
        h('span', { class: 'sep' }), h('button', { onclick: () => { H.base = Math.max(0, H.base - 16 * H.rows); renderHex(); } }, '◀ Page'), h('button', { onclick: () => { H.base = Math.min(S.rom.length - 16, H.base + 16 * H.rows); renderHex(); } }, 'Page ▶')),
      h('div', { class: 'row' }, h('label', {}, 'Selection'),
        h('button', { onclick: copySel }, 'Copy hex'),
        h('label', {}, 'Fill with'), fill, h('button', { onclick: () => { const v = parseInt(fill.value, 16); if (isNaN(v)) return; const [a, b] = selRange(); write(a, new Uint8Array(b - a + 1).fill(v & 255), 'Fill'); } }, 'Fill'),
        h('button', { onclick: () => { const [a] = selRange(); gotoCode(snes(a)); } }, 'Disassemble here'),
        h('button', { onclick: () => { const [a] = selRange(); G.off = a; showTab('gfx'); } }, 'View as tiles'),
        h('button', { onclick: () => { const [a, b] = selRange(); LB.offset = a; LB.len = b - a + 1; showTab('lib'); } }, 'Add to library…'))),
    H.view, H.info,
    h('p', { class: 'muted', style: 'font-size:12px' }, 'Click a byte, then type hex digits to overwrite. Shift-click extends the selection. Arrows, PageUp/PageDown, Delete (= 00), Ctrl+C work. Gold = changed from the original.'));
  H.view.addEventListener('click', (e) => { const o = e.target.dataset && e.target.dataset.o; if (o == null) return; endNib(); const n = +o; if (e.shiftKey) H.b = n; else H.a = H.b = n; renderHex(); H.view.focus(); });
  H.view.addEventListener('wheel', (e) => { e.preventDefault(); H.base = Math.max(0, Math.min(S.rom.length - 16, H.base + Math.sign(e.deltaY) * 48)); renderHex(); }, { passive: false });
  H.view.addEventListener('keydown', hexKey);
  find.addEventListener('keydown', (e) => { if (e.key === 'Enter') hexFind(find.value); });
  go.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const f = parseLoc(go.value); if (f != null) hexGoto(f); } });
}, () => { renderHex(); }, true);
function selRange() { return [Math.min(H.a, H.b), Math.max(H.a, H.b)]; }
function hexGoto(f) { H.a = H.b = f; H.base = Math.floor(f / 16) * 16 - 16 * 3; if (H.base < 0) H.base = 0; endNib(); if (activeTab === 'hex') renderHex(); }
function endNib() { if (H.nib !== null) { H.nib = null; if (S.group) endGroup(); } }
function ensureVisible() {
  const row = Math.floor(H.b / 16) * 16;
  if (row < H.base) H.base = row; else if (row >= H.base + 16 * H.rows) H.base = row - 16 * (H.rows - 1);
  H.base = Math.max(0, Math.min(Math.floor((S.rom.length - 1) / 16) * 16, H.base));
}
function renderHex() {
  if (!S.rom || !H.view) return;
  const [sa, sb] = selRange(); const rom = S.rom, orig = S.orig; let out = '';
  for (let r = 0; r < H.rows; r++) {
    const o = H.base + r * 16; if (o >= rom.length) break;
    let b = '', a = '';
    for (let i = 0; i < 16 && o + i < rom.length; i++) {
      const p = o + i, v = rom[p];
      const cls = (p !== orig[p] && !(p >= orig.length && v === 0) ? ' mod' : '') + (p >= sa && p <= sb ? ' sel' : '') + (p === H.b ? ' cur' : '');
      b += `<span class="${cls.trim()}" data-o="${p}">${hex(v)}</span>`;
      const c = v >= 32 && v < 127 ? esc(String.fromCharCode(v)) : '·';
      a += `<i class="${p >= sa && p <= sb ? 'sel' : ''}" data-o="${p}">${c}</i>`;
    }
    out += `<div class="hexrow"><span class="off">${hex(o, 6)}</span><span class="bytes">${b}</span><span class="asc">${a}</span></div>`;
  }
  H.view.innerHTML = out;
  const v = S.rom[H.b];
  H.info.textContent = 'cursor $' + hex(H.b, 6) + ' · ' + fmtSnes(H.b) + ' · value $' + hex(v) + ' = ' + v + ' · ' + (sa === sb ? '1 byte' : (sb - sa + 1) + ' bytes selected') + (H.nib !== null ? ' · typing high nibble ' + H.nib.toString(16).toUpperCase() : '');
}
function hexKey(e) {
  if (!S.rom) return;
  const k = e.key; let handled = true;
  const move = (d) => { endNib(); H.b = Math.max(0, Math.min(S.rom.length - 1, H.b + d)); if (!e.shiftKey) H.a = H.b; ensureVisible(); };
  if (e.ctrlKey || e.metaKey) { if (k.toLowerCase() === 'c') copySel(); else handled = false; }
  else if (k === 'ArrowRight') move(1); else if (k === 'ArrowLeft') move(-1); else if (k === 'ArrowDown') move(16); else if (k === 'ArrowUp') move(-16);
  else if (k === 'PageDown') move(16 * H.rows); else if (k === 'PageUp') move(-16 * H.rows);
  else if (k === 'Home') move(-H.b); else if (k === 'End') move(S.rom.length);
  else if (k === 'Delete' || k === 'Backspace') { const [a, b] = selRange(); write(a, new Uint8Array(b - a + 1), 'Clear bytes'); }
  else if (/^[0-9a-fA-F]$/.test(k) && !e.altKey) {
    const d = parseInt(k, 16); const cur = S.rom[H.b];
    if (H.nib === null) { beginGroup('Hex edit'); write(H.b, [(d << 4) | (cur & 15)]); H.nib = d; }
    else { write(H.b, [(H.nib << 4) | d]); endNib(); H.b = Math.min(S.rom.length - 1, H.b + 1); H.a = H.b; ensureVisible(); }
  } else handled = false;
  if (handled) { e.preventDefault(); renderHex(); }
}
function copySel() { const [a, b] = selRange(); const t = Array.from(S.rom.slice(a, b + 1), (x) => hex(x)).join(' '); (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Copied ' + (b - a + 1) + ' bytes'), () => toast('Clipboard unavailable here')); }
function hexFind(q) {
  if (!needRom()) return; q = q.trim(); if (!q) return;
  let pat;
  if (/^([0-9a-f]{2}[\s,]*)+$/i.test(q)) pat = (q.match(/[0-9a-f]{2}/gi) || []).map((x) => parseInt(x, 16));
  else pat = Array.from(q, (c) => c.charCodeAt(0) & 255);
  let i = Core.findBytes(S.rom, pat, H.b + 1); if (i < 0) i = Core.findBytes(S.rom, pat, 0);
  if (i < 0) return toast('Not found');
  hexGoto(i); H.b = i + pat.length - 1; renderHex(); toast('Found at $' + hex(i, 6));
}

/* =========================================================
   GRAPHICS
   ========================================================= */
const G = { off: 0, fmt: '4bpp', cols: 16, rows: 16, zoom: 3, pal: 'gray', palOff: 0, palSub: 0, tile: 0, tool: 'pencil', color: 1, grid: true, clip: null, el: null };
const tileBytes = () => Core.FORMATS[G.fmt].bytes;
const colorCount = () => 1 << Core.FORMATS[G.fmt].bpp;
function gfxPalette() {
  const n = colorCount(), p = [];
  if (G.pal === 'rom' && S.rom && isNes()) {
    for (let i = 0; i < n; i++) { const o = G.palOff + G.palSub * 4 + i; p.push(i < 4 && o < S.rom.length ? NES.PALETTE[S.rom[o] & 63] : [255, 0, 255]); }
  } else if (G.pal === 'rom' && S.rom) {
    const base = G.palOff + (n > 16 ? 0 : G.palSub * n * 2);
    for (let i = 0; i < n; i++) p.push(base + i * 2 + 1 < S.rom.length ? Core.readColor(S.rom, base + i * 2) : [255, 0, 255]);
  } else for (let i = 0; i < n; i++) { const v = Math.round(i * 255 / (n - 1)); p.push([v, v, v]); }
  return p;
}
const rgb = (c) => 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
let gfx = {};
defineTab('gfx', 'Graphics', (el) => {
  G.el = el;
  const num = (id, lbl, val, min, max, on) => [h('label', { for: id }, lbl), h('input', { type: 'number', id, value: val, min, max, onchange: (e) => { on(+e.target.value); drawGfx(); } })];
  gfx.off = h('input', { type: 'text', id: 'gfxoff', size: 9, onchange: (e) => { const f = parseLoc(e.target.value); if (f != null) { G.off = f; drawGfx(); } } });
  gfx.fmt = h('select', { id: 'gfxfmt', onchange: (e) => { G.fmt = e.target.value; G.color = Math.min(G.color, colorCount() - 1); drawGfx(); } }, Object.keys(Core.FORMATS).map((k) => h('option', { value: k, selected: k === G.fmt }, k === 'mode7' ? 'Mode 7 (8bpp linear)' : k === 'nes2bpp' ? 'NES 2bpp (CHR)' : k.toUpperCase().replace('BPP', 'bpp'))));
  gfx.zoom = h('select', { id: 'gfxzoom', onchange: (e) => { G.zoom = +e.target.value; drawGfx(); } }, [2, 3, 4, 6, 8].map((z) => h('option', { value: z, selected: z === G.zoom }, z + '×')));
  gfx.pal = h('select', { id: 'gfxpal', onchange: (e) => { G.pal = e.target.value; drawGfx(); } }, h('option', { value: 'gray' }, 'Grayscale'), h('option', { value: 'rom' }, 'Palette from ROM'));
  gfx.palOff = h('input', { type: 'text', id: 'gfxpaloff', size: 8, onchange: (e) => { const f = parseLoc(e.target.value); if (f != null) { G.palOff = f; drawGfx(); } } });
  gfx.palSub = h('input', { type: 'number', id: 'gfxpalsub', min: 0, max: 15, value: 0, onchange: (e) => { G.palSub = +e.target.value; drawGfx(); } });
  gfx.grid = h('input', { type: 'checkbox', id: 'gfxgrid', checked: true, onchange: (e) => { G.grid = e.target.checked; drawGfx(); } });
  gfx.cv = h('canvas', { id: 'gfxcanvas' });
  gfx.scroll = h('input', { type: 'range', id: 'gfxscroll', min: 0, max: 100, value: 0, title: 'Scroll through the ROM', style: 'writing-mode:vertical-lr;width:22px;height:auto;min-height:200px;cursor:pointer', oninput: (e) => { G.off = Math.min(S.rom.length - 1, +e.target.value * G.cols * tileBytes()); drawGfx(true); } });
  gfx.strip = h('div', { id: 'gfxstripbox', class: 'row', style: 'align-items:center;margin:6px 0' }, h('label', {}, 'Sub-palettes'), h('canvas', { id: 'gfxstrip', height: 24, style: 'cursor:pointer;border:1px solid var(--line);border-radius:4px;max-width:100%' }), h('span', { class: 'muted', id: 'gfxstriphint', style: 'font-size:12px' }, 'click to choose'));
  gfx.strip.querySelector('canvas').addEventListener('click', (e) => { const cv = e.target, r = cv.getBoundingClientRect(), n = colorCount(); const sw = 8, gap = 6, per = n * sw + gap; const idx = Math.floor((e.clientX - r.left) * (cv.width / r.width) / per); if (G.pal === 'rom' && idx >= 0 && idx < 16) { G.palSub = idx; drawGfx(); } });
  gfx.tile = h('canvas', { id: 'tilecanvas', width: 224, height: 224 });
  gfx.sw = h('div', { class: 'swatches' });
  gfx.info = h('div', { class: 'muted mono', style: 'min-height:34px;font-size:12px' });
  gfx.tools = h('div', { class: 'row toolbtns' }, [['pencil', 'Pencil'], ['fill', 'Fill'], ['pick', 'Pick']].map(([k, l]) => h('button', { 'data-tool': k, class: k === G.tool ? 'active' : '', onclick: () => { G.tool = k; refreshTools(); } }, l)));
  const act = (label, fn, title) => h('button', { class: 'small', title, onclick: () => editTile(label, fn) }, label);
  el.append(h('div', { class: 'cols' },
    h('div', { style: 'flex:1 1 520px;min-width:0' },
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('label', {}, 'Offset'), gfx.off, h('label', {}, 'Format'), gfx.fmt, ...num('gfxcols', 'Tiles/row', G.cols, 1, 64, (v) => (G.cols = Math.max(1, Math.min(64, v || 16)))), ...num('gfxrows', 'Rows', G.rows, 1, 64, (v) => (G.rows = Math.max(1, Math.min(64, v || 16)))), h('label', {}, 'Zoom'), gfx.zoom),
        h('div', { class: 'row' }, h('label', {}, 'Colours'), gfx.pal, h('label', {}, 'Palette offset'), gfx.palOff, h('label', {}, 'Sub-palette'), gfx.palSub, h('label', {}, h('input', { type: 'checkbox', id: 'gfxgrid2', checked: true, onchange: (e) => { G.grid = e.target.checked; drawGfx(); } }), ' grid')),
        h('div', { class: 'row' },
          h('button', { onclick: () => step(-G.cols * G.rows * tileBytes()) }, '◀ Page'), h('button', { onclick: () => step(-G.cols * tileBytes()) }, '▲ Row'), h('button', { onclick: () => step(G.cols * tileBytes()) }, '▼ Row'), h('button', { onclick: () => step(G.cols * G.rows * tileBytes()) }, 'Page ▶'),
          h('button', { onclick: () => step(-1) }, '−1 byte'), h('button', { onclick: () => step(1) }, '+1 byte'),
          h('span', { class: 'sep' }), h('button', { onclick: exportPng }, 'Export PNG'), h('button', { onclick: () => $('#filePng').click() }, 'Import PNG…'))),
      gfx.strip,
      h('div', { class: 'row', style: 'align-items:stretch;flex-wrap:nowrap;gap:6px' }, h('div', { id: 'gfxwrap', tabindex: '0', style: 'flex:1;min-width:0' }, gfx.cv), gfx.scroll),
      h('p', { class: 'muted', style: 'font-size:12px' }, 'Tip: the wrong format makes tiles look like noise. Try 2bpp, 3bpp and 4bpp, and scroll by single bytes to find the alignment. Mouse wheel scrolls rows.')),
    h('div', { style: 'flex:0 0 260px' },
      h('div', { class: 'card' }, h('h2', {}, 'Tile editor'), gfx.tile, gfx.info,
        h('h3', {}, 'Colour'), gfx.sw,
        h('h3', {}, 'Tool'), gfx.tools,
        h('h3', {}, 'Transform'),
        h('div', { class: 'row' }, act('Flip H', (px) => { for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) { const a = y * 8 + x, b = y * 8 + 7 - x; [px[a], px[b]] = [px[b], px[a]]; } }), act('Flip V', (px) => { for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) { const a = y * 8 + x, b = (7 - y) * 8 + x; [px[a], px[b]] = [px[b], px[a]]; } }), act('Rotate', (px) => { const c = px.slice(); for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px[x * 8 + (7 - y)] = c[y * 8 + x]; })),
        h('div', { class: 'row' }, ['←', '→', '↑', '↓'].map((a, i) => act('Shift ' + a, (px) => { const c = px.slice(); const dx = [-1, 1, 0, 0][i], dy = [0, 0, -1, 1][i]; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px[((y + dy + 8) % 8) * 8 + ((x + dx + 8) % 8)] = c[y * 8 + x]; }))),
        h('div', { class: 'row' }, act('Clear', (px) => px.fill(0)), h('button', { class: 'small', onclick: () => { G.clip = Core.decodeTile(S.rom, tileOff(), G.fmt); toast('Tile copied'); } }, 'Copy'), h('button', { class: 'small', onclick: () => { if (!G.clip) return toast('Nothing copied'); editTile('Paste tile', (px) => px.set(G.clip.map((v) => Math.min(v, colorCount() - 1)))); } }, 'Paste')),
        h('div', { class: 'row' }, h('button', { class: 'small', onclick: () => { const pc = Math.min(colorCount(), 256); const off = G.palOff; PL.off = G.pal === 'rom' ? off : PL.off; showTab('pal'); } }, 'Open palettes'))))));
  el.append(h('input', { type: 'file', id: 'filePng', accept: 'image/*', hidden: true, onchange: (e) => { if (e.target.files[0]) importPng(e.target.files[0]); e.target.value = ''; } }));
  // canvas interactions
  gfx.cv.addEventListener('click', (e) => {
    const r = gfx.cv.getBoundingClientRect(); const x = Math.floor((e.clientX - r.left) / r.width * G.cols), y = Math.floor((e.clientY - r.top) / r.height * G.rows);
    if (x >= 0 && y >= 0 && x < G.cols && y < G.rows) { G.tile = y * G.cols + x; drawGfx(); }
  });
  gfx.cv.addEventListener('mousemove', (e) => {
    const r = gfx.cv.getBoundingClientRect(); const x = Math.floor((e.clientX - r.left) / r.width * G.cols), y = Math.floor((e.clientY - r.top) / r.height * G.rows);
    if (x >= 0 && y >= 0 && x < G.cols && y < G.rows) { const o = G.off + (y * G.cols + x) * tileBytes(); setStatus('tile ' + (y * G.cols + x) + ' · file $' + hex(o, 6) + ' · ' + (o < S.rom.length ? fmtSnes(o) : '')); }
  });
  $('#gfxwrap', el).addEventListener('keydown', (e) => { const rb = G.cols * tileBytes(); const k = e.key; if (k === 'PageDown') step(rb * G.rows); else if (k === 'PageUp') step(-rb * G.rows); else if (k === 'ArrowDown') step(rb); else if (k === 'ArrowUp') step(-rb); else if (k === 'Home') { G.off = 0; drawGfx(); } else if (k === 'End') { G.off = Math.max(0, S.rom.length - rb * G.rows); drawGfx(); } else return; e.preventDefault(); });
  $('#gfxwrap', el).addEventListener('wheel', (e) => { e.preventDefault(); step(Math.sign(e.deltaY) * 3 * G.cols * tileBytes()); }, { passive: false });
  $('#gfxwrap', el).addEventListener('wheelOLD', (e) => { if (e.shiftKey) return; if ($('#gfxwrap', el).scrollHeight > $('#gfxwrap', el).clientHeight + 2) return; e.preventDefault(); step(Math.sign(e.deltaY) * G.cols * tileBytes()); }, { passive: false });
  // tile editor pointer handling
  let drawing = false;
  const pt = (e) => { const r = gfx.tile.getBoundingClientRect(); return [Math.floor((e.clientX - r.left) / r.width * 8), Math.floor((e.clientY - r.top) / r.height * 8)]; };
  const apply = (e) => {
    const [x, y] = pt(e); if (x < 0 || y < 0 || x > 7 || y > 7) return;
    const off = tileOff(); if (off + tileBytes() > S.rom.length) return;
    if (G.tool === 'pick') { G.color = Core.getPixel(S.rom, off, G.fmt, x, y); G.tool = 'pencil'; refreshTools(); drawGfx(); return; }
    if (G.tool === 'fill') {
      const px = Core.decodeTile(S.rom, off, G.fmt), from = px[y * 8 + x]; if (from === G.color) return;
      const st = [[x, y]]; while (st.length) { const [cx, cy] = st.pop(); if (cx < 0 || cy < 0 || cx > 7 || cy > 7 || px[cy * 8 + cx] !== from) continue; px[cy * 8 + cx] = G.color; st.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]); }
      const nb = S.rom.slice(off, off + tileBytes()); Core.encodeTile(nb, 0, G.fmt, px); write(off, nb, 'Fill'); return;
    }
    const nb = S.rom.slice(off, off + tileBytes()); Core.setPixel(nb, 0, G.fmt, x, y, G.color); write(off, nb, 'Draw pixel');
  };
  gfx.tile.addEventListener('pointerdown', (e) => { if (!S.rom) return; drawing = true; gfx.tile.setPointerCapture(e.pointerId); beginGroup('Draw'); apply(e); });
  gfx.tile.addEventListener('pointermove', (e) => { if (drawing && G.tool === 'pencil') apply(e); });
  const up = () => { if (drawing) { drawing = false; endGroup(); } };
  gfx.tile.addEventListener('pointerup', up); gfx.tile.addEventListener('pointercancel', up);
}, () => { drawGfx(); }, true);
const tileOff = () => G.off + G.tile * tileBytes();
function step(d) { G.off = Math.max(0, Math.min(S.rom.length - 1, G.off + d)); drawGfx(); }
function refreshTools() { for (const b of G.el.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === G.tool); }
function editTile(label, fn) {
  if (!needRom()) return; const off = tileOff(); if (off + tileBytes() > S.rom.length) return;
  const px = Core.decodeTile(S.rom, off, G.fmt); fn(px);
  const nb = S.rom.slice(off, off + tileBytes()); Core.encodeTile(nb, 0, G.fmt, px); write(off, nb, label);
}
function drawGfx(fromSlider) {
  if (!S.rom || !gfx.cv) return;
  const tb = tileBytes(), W = G.cols * 8, Hh = G.rows * 8, pal = gfxPalette();
  const img = new ImageData(W, Hh);
  for (let ty = 0; ty < G.rows; ty++) for (let tx = 0; tx < G.cols; tx++) {
    const o = G.off + (ty * G.cols + tx) * tb, ok = o + tb <= S.rom.length;
    const px = ok ? Core.decodeTile(S.rom, o, G.fmt) : null;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const i = ((ty * 8 + y) * W + tx * 8 + x) * 4;
      if (!px) { const c = (x + y) & 1 ? 40 : 24; img.data[i] = img.data[i + 1] = img.data[i + 2] = c; } else { const col = pal[px[y * 8 + x]] || [255, 0, 255]; img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; }
      img.data[i + 3] = 255;
    }
  }
  const off = document.createElement('canvas'); off.width = W; off.height = Hh; off.getContext('2d').putImageData(img, 0, 0);
  const z = G.zoom; gfx.cv.width = W * z; gfx.cv.height = Hh * z;
  const ctx = gfx.cv.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(off, 0, 0, W * z, Hh * z);
  if (G.grid) {
    ctx.strokeStyle = 'rgba(76,194,255,.25)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = 0; x <= G.cols; x++) { ctx.moveTo(x * 8 * z + .5, 0); ctx.lineTo(x * 8 * z + .5, Hh * z); }
    for (let y = 0; y <= G.rows; y++) { ctx.moveTo(0, y * 8 * z + .5); ctx.lineTo(W * z, y * 8 * z + .5); }
    ctx.stroke();
  }
  const sx = (G.tile % G.cols) * 8 * z, sy = Math.floor(G.tile / G.cols) * 8 * z;
  if (G.tile < G.cols * G.rows) { ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2; ctx.strokeRect(sx + 1, sy + 1, 8 * z - 2, 8 * z - 2); }
  // sync inputs
  gfx.off.value = hex(G.off, 6); gfx.fmt.value = G.fmt; gfx.zoom.value = G.zoom; gfx.pal.value = G.pal; gfx.palOff.value = hex(G.palOff, 6); gfx.palSub.value = G.palSub;
  $('#gfxcols', G.el).value = G.cols; $('#gfxrows', G.el).value = G.rows; $('#gfxgrid2', G.el).checked = G.grid;
  drawTileEditor(pal);
  const rb = G.cols * tileBytes(); gfx.scroll.max = Math.max(1, Math.floor((S.rom.length - 1) / rb)); if (!fromSlider) gfx.scroll.value = Math.floor(G.off / rb);
  gfx.scroll.style.height = Math.min(600, Math.max(200, G.rows * 8 * G.zoom)) + 'px';
  drawGfxStrip();
}
function drawGfxStrip() {
  const cv = gfx.strip.querySelector('canvas'), n = colorCount(), sw = 8, gap = 6, per = n * sw + gap, rom = G.pal === 'rom';
  const count = rom ? (isNes() ? 8 : n > 16 ? 1 : 8) : 0; cv.width = Math.max(10, count * per); cv.style.display = rom ? '' : 'none'; $('#gfxstriphint', G.el).textContent = rom ? 'click to choose the sub-palette (currently ' + G.palSub + ')' : 'choose "Palette from ROM" to browse sub-palettes';
  if (!rom) return; const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height);
  for (let p = 0; p < count; p++) {
    for (let i = 0; i < n; i++) { let col; if (isNes()) { const o = G.palOff + p * 4 + i; col = i < 4 && o < S.rom.length ? NES.PALETTE[S.rom[o] & 63] : [40, 40, 40]; } else { const o = G.palOff + p * n * 2 + i * 2; col = o + 1 < S.rom.length ? Core.readColor(S.rom, o) : [40, 40, 40]; } ctx.fillStyle = rgb(col); ctx.fillRect(p * per + i * sw, 2, sw - 1, 20); }
    if (p === G.palSub || (n > 16 && p === 0)) { ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2; ctx.strokeRect(p * per + 1, 1, n * sw - 2, 22); }
  }
}
function drawTileEditor(pal) {
  const ctx = gfx.tile.getContext('2d'), off = tileOff(), tb = tileBytes();
  ctx.clearRect(0, 0, 224, 224);
  const ok = off + tb <= S.rom.length;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const c = ok ? Core.getPixel(S.rom, off, G.fmt, x, y) : 0;
    ctx.fillStyle = ok ? rgb(pal[c] || [255, 0, 255]) : '#222'; ctx.fillRect(x * 28, y * 28, 28, 28);
  }
  ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); for (let i = 0; i <= 8; i++) { ctx.moveTo(i * 28 + .5, 0); ctx.lineTo(i * 28 + .5, 224); ctx.moveTo(0, i * 28 + .5); ctx.lineTo(224, i * 28 + .5); } ctx.stroke();
  gfx.info.textContent = 'tile #' + G.tile + ' · file $' + hex(off, 6) + (ok ? ' · ' + fmtSnes(off) : '') + ' · ' + tb + ' bytes';
  const n = colorCount(); gfx.sw.className = 'swatches' + (n > 16 ? ' big' : ''); gfx.sw.replaceChildren();
  G.color = Math.min(G.color, n - 1);
  for (let i = 0; i < n; i++) gfx.sw.append(h('div', { class: 'sw' + (i === G.color ? ' sel' : ''), title: 'colour ' + i, style: 'background:' + rgb(pal[i]), onclick: () => { G.color = i; drawTileEditor(pal); } }));
}
function exportPng() {
  if (!needRom()) return; const pal = gfxPalette(), tb = tileBytes(), W = G.cols * 8, Hh = G.rows * 8;
  const c = document.createElement('canvas'); c.width = W; c.height = Hh; const ctx = c.getContext('2d'); const img = ctx.createImageData(W, Hh);
  for (let ty = 0; ty < G.rows; ty++) for (let tx = 0; tx < G.cols; tx++) { const o = G.off + (ty * G.cols + tx) * tb; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const v = o + tb <= S.rom.length ? Core.getPixel(S.rom, o, G.fmt, x, y) : 0, col = pal[v] || [0, 0, 0], i = ((ty * 8 + y) * W + tx * 8 + x) * 4; img.data.set([col[0], col[1], col[2], 255], i); } }
  ctx.putImageData(img, 0, 0); c.toBlob((b) => download(b, 'tiles_' + hex(G.off, 6) + '.png'));
}
function importPng(file) {
  if (!needRom()) return;
  const url = URL.createObjectURL(file), im = new Image();
  im.onload = () => {
    const w = Math.floor(im.width / 8) * 8, hgt = Math.floor(im.height / 8) * 8;
    if (!w || !hgt) return toast('Image must be at least 8×8 pixels.');
    const c = document.createElement('canvas'); c.width = w; c.height = hgt; const ctx = c.getContext('2d'); ctx.drawImage(im, 0, 0);
    const data = ctx.getImageData(0, 0, w, hgt).data, pal = gfxPalette(), tb = tileBytes(), tw = w / 8, th = hgt / 8, n = colorCount();
    const nearest = (r, g, b) => { let best = 0, bd = 1e9; for (let i = 0; i < n; i++) { const p = pal[i], d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2; if (d < bd) { bd = d; best = i; } } return best; };
    beginGroup('Import PNG'); let tiles = 0;
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
      const idx = ty * G.cols + tx, o = G.off + idx * tb; if (tx >= G.cols || o + tb > S.rom.length) continue;
      const nb = S.rom.slice(o, o + tb);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const i = ((ty * 8 + y) * w + tx * 8 + x) * 4; const ci = data[i + 3] < 128 ? 0 : nearest(data[i], data[i + 1], data[i + 2]); Core.setPixel(nb, 0, G.fmt, x, y, ci); }
      write(o, nb); tiles++;
    }
    endGroup(); URL.revokeObjectURL(url);
    toast('Imported ' + tiles + ' tiles using the current palette' + (tw > G.cols ? ' (image was wider than ' + G.cols + ' tiles per row; extra columns skipped)' : ''), 4000);
  };
  im.onerror = () => toast('Could not read that image.'); im.src = url;
}

/* =========================================================
   PALETTES
   ========================================================= */
const P = { off: 0, rows: 16, sel: 0, el: null };
const PL = P; let palCache = null;
defineTab('pal', 'Palettes', (el) => {
  P.el = el;
  P.cv = h('canvas', { id: 'palcanvas' });
  P.offIn = h('input', { type: 'text', id: 'paloff', size: 9, onchange: (e) => { const f = parseLoc(e.target.value); if (f != null) { P.off = isNes() ? f : f & ~1; P.sel = 0; drawPal(); } } });
  P.rowsIn = h('input', { type: 'number', id: 'palrows', value: 16, min: 1, max: 32, onchange: (e) => { P.rows = Math.max(1, Math.min(32, +e.target.value || 16)); drawPal(); } });
  P.pick = h('input', { type: 'color', id: 'palcolor', onchange: (e) => { const v = e.target.value; setSel(parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)); } });
  P.r = h('input', { type: 'number', id: 'palr', min: 0, max: 31, onchange: () => setSelRaw() }); P.g = h('input', { type: 'number', id: 'palg', min: 0, max: 31, onchange: () => setSelRaw() }); P.b = h('input', { type: 'number', id: 'palb', min: 0, max: 31, onchange: () => setSelRaw() });
  P.info = h('div', { class: 'muted mono' });
  P.master = h('canvas', { id: 'nesmaster', width: 320, height: 80, style: 'cursor:pointer' });
  P.masterBox = h('div', { style: 'display:none' }, h('p', { class: 'muted', style: 'font-size:12px;margin:6px 0' }, 'NES palette entries are one byte each (0-63). Click a colour to set the selected entry:'), P.master);
  P.master.addEventListener('click', (e) => { const r = P.master.getBoundingClientRect(); const x = Math.floor((e.clientX - r.left) / r.width * 16), y = Math.floor((e.clientY - r.top) / r.height * 4); write(P.off + P.sel, [y * 16 + x], 'Edit NES colour'); });
  P.scan = h('div', { class: 'list', style: 'display:none' });
  el.append(h('div', { class: 'cols' },
    h('div', { style: 'flex:0 0 auto' },
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('label', {}, 'Offset'), P.offIn, h('label', {}, 'Rows of 16'), P.rowsIn),
        h('div', { class: 'row' }, h('button', { onclick: () => { P.off = Math.max(0, P.off - (isNes() ? 16 : 32) * P.rows); drawPal(); } }, '◀ Page'), h('button', { onclick: () => { P.off = Math.min(S.rom.length - 2, P.off + (isNes() ? 16 : 32) * P.rows); drawPal(); } }, 'Page ▶'), h('button', { onclick: () => { P.off = Math.max(0, P.off - (isNes() ? 1 : 2)); drawPal(); } }, '−2'), h('button', { onclick: () => { P.off += isNes() ? 1 : 2; drawPal(); } }, '+2')),
        P.cv, h('p', { class: 'muted', style: 'font-size:12px' }, 'SNES: 15-bit BGR, 2 bytes per colour, 16 colours per row. NES: 1 byte per colour (index into the 64-colour master palette), 4 colours per sub-palette.'))),
    h('div', { style: 'flex:1 1 300px' },
      h('div', { class: 'card' }, h('h2', {}, 'Selected colour'), P.info,
        (P.snesCtl = h('div', { class: 'row' }, h('label', {}, 'Pick'), P.pick, h('label', {}, 'R'), P.r, h('label', {}, 'G'), P.g, h('label', {}, 'B'), P.b, h('span', { class: 'muted' }, '(0–31)'))), P.masterBox,
        h('div', { class: 'row' }, h('button', { onclick: () => { const rowStart = P.off + Math.floor(P.sel / 16) * (isNes() ? 16 : 32); G.pal = 'rom'; G.palOff = rowStart; G.palSub = isNes() ? (P.sel % 16) >> 2 : 0; toast('Graphics tab now uses the row at $' + hex(rowStart, 6)); showTab('gfx'); } }, 'Use this row in Graphics'),
          h('button', { onclick: () => { if (isNes()) return copyText('$' + hex(S.rom[P.off + P.sel])); const t = P.off + P.sel * 2; const v = S.rom[t] | (S.rom[t + 1] << 8); copyText('$' + hex(v, 4)); } }, 'Copy value'))),
      h('div', { class: 'card' }, h('h2', {}, 'Palette finder'),
        h('p', { class: 'muted', style: 'font-size:12px;margin-top:0' }, 'Scans for 16-colour runs that look like palettes. Results are guesses.'),
        h('div', { class: 'row' }, h('button', { id: 'btnScanPal', onclick: scanPal }, 'Scan ROM')), P.scan))));
  P.cv.addEventListener('click', (e) => { const r = P.cv.getBoundingClientRect(); const x = Math.floor((e.clientX - r.left) / r.width * 16), y = Math.floor((e.clientY - r.top) / r.height * P.rows); P.sel = y * 16 + x; drawPal(); });
}, () => { drawPal(); }, true);
function copyText(t) { (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Copied ' + t), () => toast(t)); }
function setSel(r, g, b) { const t = P.off + P.sel * 2; if (t + 1 >= S.rom.length) return; const nb = new Uint8Array(2); Core.writeColor(nb, 0, r, g, b); write(t, nb, 'Edit colour'); }
function setSelRaw() { const r = Math.max(0, Math.min(31, +P.r.value | 0)), g = Math.max(0, Math.min(31, +P.g.value | 0)), b = Math.max(0, Math.min(31, +P.b.value | 0)); const t = P.off + P.sel * 2; const v = r | (g << 5) | (b << 10); write(t, [v & 255, v >> 8], 'Edit colour'); }
function drawPal() {
  const cell = 22, cv = P.cv, nes = isNes(), per = nes ? 1 : 2; cv.width = 16 * cell; cv.height = P.rows * cell; const ctx = cv.getContext('2d');
  P.snesCtl.style.display = nes ? 'none' : ''; P.masterBox.style.display = nes ? 'block' : 'none';
  for (let i = 0; i < 16 * P.rows; i++) {
    const o = P.off + i * per, x = (i % 16) * cell, y = Math.floor(i / 16) * cell;
    if (o + per - 1 >= S.rom.length) { ctx.fillStyle = '#111'; ctx.fillRect(x, y, cell, cell); continue; }
    ctx.fillStyle = rgb(nes ? NES.PALETTE[S.rom[o] & 63] : Core.readColor(S.rom, o)); ctx.fillRect(x, y, cell - 1, cell - 1);
    if (S.rom[o] !== S.orig[o] || (!nes && S.rom[o + 1] !== S.orig[o + 1])) { ctx.fillStyle = '#fff'; ctx.fillRect(x + 1, y + 1, 4, 4); }
  }
  if (nes) { ctx.fillStyle = 'rgba(255,255,255,.55)'; for (let sx = 4; sx < 16; sx += 4) ctx.fillRect(sx * cell - 1, 0, 1, P.rows * cell); }
  const sx = (P.sel % 16) * cell, sy = Math.floor(P.sel / 16) * cell; ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2; ctx.strokeRect(sx + 1, sy + 1, cell - 3, cell - 3);
  P.offIn.value = hex(P.off, 6); P.rowsIn.value = P.rows;
  const t = P.off + P.sel * per;
  if (nes) {
    const mc = P.master.getContext('2d'); for (let i = 0; i < 64; i++) { mc.fillStyle = rgb(NES.PALETTE[i]); mc.fillRect((i % 16) * 20, Math.floor(i / 16) * 20, 19, 19); }
    if (t < S.rom.length) P.info.textContent = 'entry ' + P.sel + ' (sub-palette ' + (P.sel >> 2) + ', index ' + (P.sel & 3) + ') · file $' + hex(t, 6) + ' · value $' + hex(S.rom[t]) + (S.rom[t] >= 0x40 ? ' (>= $40, shown as ' + hex(S.rom[t] & 63) + ')' : '');
  } else if (t + 1 < S.rom.length) {
    const c = Core.readColor(S.rom, t), v = S.rom[t] | (S.rom[t + 1] << 8);
    P.info.textContent = 'entry ' + P.sel + ' (row ' + Math.floor(P.sel / 16) + ', index ' + (P.sel % 16) + ') · file $' + hex(t, 6) + ' · BGR555 $' + hex(v, 4);
    P.pick.value = '#' + c.map((n) => hex(n)).join('').toLowerCase(); const ae = document.activeElement; if (ae !== P.r && ae !== P.g && ae !== P.b) { P.r.value = v & 31; P.g.value = (v >> 5) & 31; P.b.value = (v >> 10) & 31; }
  }
}
function scanPal() {
  if (!needRom()) return;
  setStatus('Scanning for palettes…');
  setTimeout(() => {
    const res = isNes() ? NES.scanPalettes(S.rom, S.nes, 80) : Core.scanPalettes(S.rom, 80); palCache = res;
    P.scan.style.display = 'block'; P.scan.replaceChildren(h('table', {}, h('tr', {}, h('th', {}, 'File'), h('th', {}, 'SNES'), h('th', {}, 'Score'), h('th', {}, ''), h('th', {}, '')),
      res.map((r) => h('tr', { class: 'hit' }, h('td', { class: 'mono' }, '$' + hex(r.off, 6)), h('td', { class: 'mono' }, fmtSnes(r.off)), h('td', {}, r.score), h('td', {}, h('button', { class: 'small', onclick: () => { P.off = r.off; P.sel = 0; drawPal(); } }, 'Open')), h('td', {}, h('button', { class: 'small', onclick: () => { G.pal = 'rom'; G.palOff = r.off; G.palSub = 0; toast('Graphics uses this palette'); } }, 'Use'))))));
    setStatus('Found ' + res.length + ' palette candidates');
  }, 20);
}

/* =========================================================
   TEXT
   ========================================================= */
let textCache = null;
const TX = { el: null };
defineTab('text', 'Text', (el) => {
  TX.el = el;
  TX.min = h('input', { type: 'number', id: 'txmin', value: 6, min: 3, max: 40 });
  TX.filter = h('input', { type: 'text', id: 'txfilter', placeholder: 'filter…', size: 14, oninput: () => renderStrings() });
  TX.list = h('div', { class: 'list', style: 'max-height:50vh' });
  TX.rel = h('input', { type: 'text', id: 'txrel', placeholder: 'a word you can see in-game, e.g. START', size: 22 });
  TX.relOut = h('div', { class: 'list', style: 'max-height:240px;margin-top:6px' });
  el.append(h('div', { class: 'card' }, h('h2', {}, 'ASCII strings'),
    h('div', { class: 'row' }, h('label', {}, 'Min length'), TX.min, h('button', { id: 'btnScanText', onclick: scanText }, 'Scan ROM'), h('label', {}, 'Filter'), TX.filter, h('span', { id: 'txcount', class: 'muted' })), TX.list,
    h('p', { class: 'muted', style: 'font-size:12px' }, 'Editing keeps the same length (shorter text is padded with spaces; longer text is cut).')),
    h('div', { class: 'card' }, h('h2', {}, 'Find text in a custom encoding'),
      h('p', { class: 'muted', style: 'font-size:12px;margin-top:0' }, 'Many games use their own character table. Enter a word you know appears; this finds bytes whose spacing matches the letters (a "relative search"), which reveals the table.'),
      h('div', { class: 'row' }, TX.rel, h('button', { id: 'btnRel', onclick: relSearch }, 'Search')), TX.relOut));
}, () => { if (textCache) renderStrings(); }, true);
function scanText() {
  if (!needRom()) return; setStatus('Scanning strings…');
  setTimeout(() => { textCache = Core.scanStrings(S.rom, Math.max(3, +TX.min.value || 6)); renderStrings(); setStatus('Found ' + textCache.length + ' strings'); }, 20);
}
function renderStrings() {
  if (!textCache) return; const f = TX.filter.value.toLowerCase();
  // reflect current ROM bytes (strings may have been edited)
  const items = []; for (const s of textCache) { let t = ''; for (let i = 0; i < s.len; i++) { const c = S.rom[s.off + i]; t += c >= 32 && c < 127 ? String.fromCharCode(c) : '?'; } if (!f || t.toLowerCase().includes(f)) items.push({ off: s.off, len: s.len, text: t }); }
  $('#txcount', TX.el).textContent = items.length + ' shown';
  TX.list.replaceChildren(h('table', {}, h('tr', {}, h('th', {}, 'File'), h('th', {}, 'Len'), h('th', {}, 'Text'), h('th', {}, '')),
    items.slice(0, 400).map((s) => h('tr', { class: 'hit' }, h('td', { class: 'mono' }, '$' + hex(s.off, 6)), h('td', {}, s.len),
      h('td', {}, h('input', { type: 'text', class: 'mono', value: s.text, maxlength: s.len, size: Math.min(60, s.len + 2), onchange: (e) => { const t = (e.target.value + ' '.repeat(s.len)).slice(0, s.len); write(s.off, Array.from(t, (c) => c.charCodeAt(0) & 255), 'Edit text'); } })),
      h('td', {}, h('button', { class: 'small', onclick: () => { hexGoto(s.off); showTab('hex'); } }, 'Hex'))))), items.length > 400 ? h('p', { class: 'muted' }, 'Showing first 400. Use the filter.') : null);
}
function relSearch() {
  if (!needRom()) return; const w = TX.rel.value.trim(); if (w.length < 3) return toast('Enter at least 3 letters');
  const hits = Core.relativeSearch(S.rom, w);
  TX.relOut.replaceChildren(hits.length ? h('table', {}, h('tr', {}, h('th', {}, 'File'), h('th', {}, 'Bytes'), h('th', {}, 'Implied "a" ='), h('th', {}, '')), hits.slice(0, 100).map((x) => h('tr', { class: 'hit' }, h('td', { class: 'mono' }, '$' + hex(x.off, 6)), h('td', { class: 'mono' }, Array.from(S.rom.slice(x.off, x.off + w.length), (b) => hex(b)).join(' ')), h('td', { class: 'mono' }, '$' + hex(x.mapA & 255)), h('td', {}, h('button', { class: 'small', onclick: () => { hexGoto(x.off); showTab('hex'); } }, 'Hex'))))) : h('p', { class: 'muted', style: 'padding:8px' }, 'No matches. Try a longer word, or one that appears in a menu.'));
}

/* =========================================================
   CODE
   ========================================================= */
const CD = { addr: null, m: 1, x: 1, back: [], sel: null, el: null };
defineTab('code', 'Code', (el) => {
  CD.el = el;
  CD.addrIn = h('input', { type: 'text', id: 'codeaddr', size: 10, onkeydown: (e) => { if (e.key === 'Enter') gotoCode(parseCpu(CD.addrIn.value)); } });
  CD.dis = h('div', { class: 'list', style: 'max-height:56vh' });
  CD.vec = h('div', { class: 'row' });
  CD.asm = h('textarea', { id: 'asmsrc', class: 'asmbox', spellcheck: 'false' });
  CD.org = h('input', { type: 'text', id: 'asmorg', size: 9, value: '008000' });
  CD.out = h('pre', { class: 'out', id: 'asmout' }, 'Assembler output appears here.');
  CD.free = h('div', { class: 'list', style: 'display:none;max-height:200px' });
  CD.flags = { m: 1, x: 1 };
  const mchk = h('input', { type: 'checkbox', id: 'cm', checked: true, onchange: (e) => { CD.flags.m = e.target.checked ? 1 : 0; renderDis(); } });
  const xchk = h('input', { type: 'checkbox', id: 'cx', checked: true, onchange: (e) => { CD.flags.x = e.target.checked ? 1 : 0; renderDis(); } });
  el.append(h('div', { class: 'cols' },
    h('div', { style: 'flex:1 1 520px;min-width:0' },
      h('div', { class: 'card' }, h('h2', {}, 'Disassembler (' + '65816 / 6502)'),
        h('div', { class: 'row' }, h('label', {}, 'Address'), CD.addrIn, h('button', { onclick: () => gotoCode(parseCpu(CD.addrIn.value)) }, 'Go'), h('button', { onclick: () => { const b = CD.back.pop(); if (b != null) { CD.addr = b; renderDis(); } } }, '← Back'),
          h('label', { class: 'snesonly' }, mchk, ' A 8-bit'), h('label', { class: 'snesonly' }, xchk, ' X/Y 8-bit'), h('label', { class: 'nesonly', style: 'display:none', title: 'Which PRG bank appears at $8000 (bank-switched mappers)' }, 'PRG bank ', h('input', { type: 'number', id: 'codebank', min: 0, max: 255, value: 0, style: 'width:60px', onchange: (e) => { CD.bank = Math.max(0, +e.target.value || 0); renderDis(); } })), h('button', { onclick: () => { CD.addr = nextAddr(); renderDis(); } }, 'Next page ▶')),
        CD.vec, CD.dis,
        h('p', { class: 'muted', style: 'font-size:12px' }, 'The A/X width flags only matter at the start; REP/SEP instructions are tracked automatically. Click an address to put it in the assembler; "NOP" blanks an instruction.')),
      h('div', { class: 'card' }, h('h2', {}, 'Free space'), h('div', { class: 'row' }, h('label', {}, 'At least'), h('input', { type: 'number', id: 'freemin', value: 256, min: 16 }), h('label', {}, 'bytes'), h('button', { onclick: findFree }, 'Find')), CD.free)),
    h('div', { style: 'flex:1 1 440px;min-width:0' },
      h('div', { class: 'card' }, h('h2', {}, 'Assembler'),
        h('p', { class: 'muted', style: 'font-size:12px;margin-top:0' }, 'Labels (name:), constants (NAME = $10), .org .db .dw .ds .ascii, #<label and #>label. SNES also: .dl, .a8/.a16/.i8/.i16, lda.l forcing. NES: 6502 official opcodes. Comments start with ;'),
        CD.asm,
        h('div', { class: 'row' }, h('label', {}, 'Default .org'), CD.org, h('button', { id: 'btnAsm', onclick: () => runAsm(false) }, 'Assemble (preview)'), h('button', { id: 'btnAsmWrite', class: 'primary', onclick: () => runAsm(true) }, 'Write into ROM'), h('button', { onclick: loadStarterSource }, 'Load starter source')),
        CD.out))));
}, () => {
  const nes = isNes(), bank = !nes && S.mapping === 'HiROM' ? 0xC00000 : 0;
  const vv = nes ? NES.vectors(S.rom, S.nes) : Core.readHeader(S.rom, S.hdr).vectors;
  const vl = nes ? [['RESET', vv.RESET], ['NMI', vv.NMI], ['IRQ', vv.IRQ]] : [['RESET', vv.RESET], ['NMI', vv.NMIn], ['IRQ', vv.IRQn]];
  if (CD.addr == null || CD.reset) CD.addr = bank | vl[0][1];
  CD.vec.replaceChildren(h('label', {}, 'Jump to'), ...vl.map(([n, a]) => h('button', { class: 'small', onclick: () => gotoCode(bank | a) }, n + ' $' + hex(a, 4))));
  for (const e of CD.el.querySelectorAll('.snesonly')) e.style.display = nes ? 'none' : ''; for (const e of CD.el.querySelectorAll('.nesonly')) e.style.display = nes ? '' : 'none';
  if (!CD.asm.value || CD.reset) { const k = S.base && S.base.kind; CD.asm.value = k === 'nes-starter' ? NES.starterSource() : k === 'starter' ? Core.starterSource() : nes ? '; Your code here. Example:\n.org $C000\n    lda #$1E\n    sta $2001\n' : '; Your code here. Example:\n.org $' + hex(CD.addr & 0xFFFFFF, 6) + '\n.a8\n.i16\n    lda #$0F\n    sta $2100\n'; CD.reset = false; }
  renderDis();
}, true);
function nextAddr() { const l = CD.lastLines; if (!l || !l.length) return CD.addr; const e = l[l.length - 1]; return isNes() ? (e.addr + e.len) & 0xFFFF : (e.addr & 0xFF0000) | ((e.addr + e.len) & 0xFFFF); }
function gotoCode(addr) {
  if (addr == null) return toast(isNes() ? 'That is not in PRG ROM. Enter an address like C000.' : 'Enter an address like 00:8000 or $8000');
  if (!needRom()) return; if (CD.addr != null) CD.back.push(CD.addr); CD.addr = addr;
  showTab('code');
}
const fmtCpu = (a) => (isNes() ? hex(a, 4) : hex(a >> 16, 2) + ':' + hex(a & 0xFFFF, 4));
const cpuFile = (a) => (isNes() ? NES.cpuToFile(a, S.nes, CD.bank || 0) : Core.snesToFile(a, S.mapping, S.rom.length));
function renderDis() {
  if (!S.rom || !CD.dis) return;
  const nes = isNes();
  if (cpuFile(CD.addr) === null) { CD.dis.replaceChildren(h('p', { class: 'muted', style: 'padding:10px' }, nes ? 'That address is not in PRG ROM. Pick an address in $8000–$FFFF.' : 'That address is not in ROM (it is RAM or a register). Pick an address in ' + (S.mapping === 'HiROM' ? 'C0:0000–FF:FFFF' : '00:8000–7D:FFFF') + '.')); return; }
  const lines = nes ? NES.disasm((a) => { const f = NES.cpuToFile(a, S.nes, CD.bank || 0); return f == null || f >= S.rom.length ? -1 : S.rom[f]; }, CD.addr, 72) : Core.disasm(S.rom, S.mapping, CD.addr, 72, CD.flags.m, CD.flags.x); CD.lastLines = lines;
  CD.addrIn.value = fmtCpu(CD.addr);
  CD.dis.replaceChildren(h('table', { class: 'dis' }, lines.map((l) => {
    const f = cpuFile(l.addr);
    return h('tr', { class: 'hit' + (CD.sel === l.addr ? ' sel' : '') },
      h('td', { class: 'addr', title: 'Use as .org in the assembler', onclick: () => { CD.sel = l.addr; CD.org.value = nes ? hex(l.addr, 4) : hex(l.addr, 6); renderDis(); } }, fmtCpu(l.addr)),
      h('td', { class: 'bytes', title: 'Open in hex', onclick: () => { hexGoto(f); showTab('hex'); } }, l.bytes.map((b) => hex(b)).join(' ')),
      h('td', { class: 'txt' }, l.target != null && (nes ? (l.mn === 'JMP' || l.mn === 'JSR' || l.opd.startsWith('$') && l.len === 2 && l.mn[0] === 'B' && l.mn !== 'BIT' && l.mn !== 'BRK') : true) ? [l.mn + ' ', h('a', { onclick: () => gotoCode(l.target) }, l.text.slice(l.mn.length + 1))] : l.text),
      h('td', {}, h('button', { class: 'small', title: 'Replace with NOP', onclick: () => { write(f, new Uint8Array(l.len).fill(0xEA), 'NOP out ' + l.mn); } }, 'NOP')));
  })));
}
function loadStarterSource() { CD.asm.value = isNes() ? NES.starterSource() : Core.starterSource(); toast('Starter source loaded'); }
function runAsm(doWrite) {
  if (!needRom()) return; const nes = isNes();
  const org = parseCpu(CD.org.value); const res = nes ? NES.assemble(CD.asm.value, { org: org == null ? 0x8000 : org }) : Core.assemble(CD.asm.value, { org: org == null ? 0x8000 : org, m: 1, x: 1 });
  let out = '';
  if (res.errors.length) out += res.errors.map((e) => 'line ' + e.ln + ': ' + e.msg).join('\n') + '\n\n';
  const total = res.segments.reduce((n, s) => n + s.bytes.length, 0);
  out += total + ' bytes in ' + res.segments.length + ' segment(s)\n';
  for (const s of res.segments) out += '  ' + fmtCpu(s.addr) + '  ' + s.bytes.length + ' bytes: ' + s.bytes.slice(0, 24).map((b) => hex(b)).join(' ') + (s.bytes.length > 24 ? ' …' : '') + '\n';
  const names = Object.keys(res.symbols).filter((k) => !/^\./.test(k)).slice(0, 40);
  if (names.length) out += '\nsymbols: ' + names.map((n) => n + '=$' + hex(res.symbols[n], 4)).join('  ');
  if (doWrite) {
    if (res.errors.length) { CD.out.textContent = out + '\n\nNothing written: fix the errors first.'; return; }
    for (const s of res.segments) { // validate before touching the ROM
      const f = cpuFile(s.addr), e = cpuFile(s.addr + s.bytes.length - 1);
      if (f == null || e == null) { CD.out.textContent = out + '\n\nNothing written: ' + fmtCpu(s.addr) + ' is not a ROM address.'; return; }
      if (nes && e - f !== s.bytes.length - 1) { CD.out.textContent = out + '\n\nNothing written: the segment at $' + hex(s.addr, 4) + ' crosses a bank boundary. Split it with another .org.'; return; }
    }
    let overwritten = 0; beginGroup('Assemble');
    for (const s of res.segments) {
      const f = cpuFile(s.addr);
      for (let i = 0; i < s.bytes.length; i++) { const c = S.rom[f + i]; if (c !== 0 && c !== 0xFF && c !== s.bytes[i]) overwritten++; }
      write(f, s.bytes, 'Assemble');
    }
    endGroup(); out += '\n\nWritten to ROM.' + (overwritten ? ' ' + overwritten + ' non-empty bytes were overwritten (Ctrl+Z to undo).' : '');
    toast('Assembled ' + total + ' bytes into the ROM');
  }
  CD.out.textContent = out;
}
function undoLast() { if (S.hist.length) undo(); }
function findFree() {
  if (!needRom()) return; const min = Math.max(16, +$('#freemin', CD.el).value || 256);
  const fr = Core.freeSpace(S.rom, min).sort((a, b) => b.len - a.len).slice(0, 60);
  CD.free.style.display = 'block';
  CD.free.replaceChildren(fr.length ? h('table', {}, h('tr', {}, h('th', {}, 'File'), h('th', {}, 'SNES'), h('th', {}, 'Bytes'), h('th', {}, '')), fr.map((r) => h('tr', { class: 'hit' }, h('td', { class: 'mono' }, '$' + hex(r.off, 6)), h('td', { class: 'mono' }, fmtSnes(r.off)), h('td', {}, r.len), h('td', {}, h('button', { class: 'small', onclick: () => { const a = snes(r.off); if (a == null) return toast('That space is not in PRG ROM'); CD.org.value = isNes() ? hex(a, 4) : hex(a, 6); hexGoto(r.off); toast('.org set to ' + fmtSnes(r.off)); } }, 'Use'))))) : h('p', { class: 'muted', style: 'padding:8px' }, 'No runs of 00/FF that long. Expand the ROM in Export to create space.'));
}

/* =========================================================
   LIBRARY
   ========================================================= */
const LB = { offset: 0, len: 256, el: null };
defineTab('lib', 'Library', (el) => { LB.el = el; }, () => {
  const el = LB.el; if (!S.rom) return noRomMsg(el);
  const fromSel = h('select', { id: 'libfrom' }, h('option', { value: 'work' }, 'Working ROM'), h('option', { value: 'src' }, 'Source ROM (as first loaded)'));
  const name = h('input', { type: 'text', id: 'libname', value: 'asset ' + S.libId, size: 16 });
  const off = h('input', { type: 'text', id: 'liboff', value: hex(LB.offset, 6), size: 9 });
  const len = h('input', { type: 'text', id: 'liblen', value: hex(LB.len, 4), size: 7 });
  const kind = h('select', { id: 'libkind' }, ['tiles', 'palette', 'tilemap', 'text', 'code', 'data'].map((k) => h('option', { value: k }, k)));
  const add = () => {
    const f = parseInt(off.value, 16), n = parseInt(len.value, 16); const srcRom = fromSel.value === 'src' ? S.src : S.rom;
    if (isNaN(f) || isNaN(n) || n <= 0 || f + n > srcRom.length) return toast('Offset/length out of range (both in hex)');
    S.lib.push({ id: S.libId++, name: name.value || 'asset', kind: kind.value, fmt: G.fmt, data: srcRom.slice(f, f + n) }); LB.offset = f; LB.len = n; toast('Added ' + n + ' bytes to the library'); renderLib();
  };
  const body = h('div', { id: 'liblist' });
  const importBin = h('input', { type: 'file', id: 'libbin', hidden: true, onchange: (e) => { const fl = e.target.files[0]; if (!fl) return; const r = new FileReader(); r.onload = () => { S.lib.push({ id: S.libId++, name: fl.name, kind: 'data', fmt: G.fmt, data: new Uint8Array(r.result) }); renderLib(); }; r.readAsArrayBuffer(fl); e.target.value = ''; } });
  el.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Asset library'),
    h('p', { class: 'muted', style: 'margin-top:0' }, 'Copy regions out of the working ROM or the original source ROM, then insert them anywhere in your project. Great for moving graphics between games or into a new project.'),
    h('div', { class: 'row' }, h('label', {}, 'Copy from'), fromSel, h('label', {}, 'file offset'), off, h('label', {}, 'length (hex)'), len, h('label', {}, 'name'), name, h('label', {}, 'type'), kind, h('button', { id: 'btnLibAdd', onclick: add }, 'Add to library'), h('button', { onclick: () => importBin.click() }, 'Import .bin…'), importBin)), h('div', { class: 'card' }, body));
  renderLib();
});
function renderLib() {
  const body = $('#liblist'); if (!body) return;
  if (!S.lib.length) { body.replaceChildren(h('p', { class: 'muted' }, 'The library is empty.')); return; }
  body.replaceChildren(h('table', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', {}, 'Bytes'), h('th', {}, 'Insert at (file offset, hex)'), h('th', {}, '')),
    S.lib.map((it) => { const at = h('input', { type: 'text', value: hex(LB.offset, 6), size: 9, class: 'libat' });
      return h('tr', { class: 'hit' }, h('td', {}, it.name), h('td', {}, it.kind), h('td', {}, it.data.length), h('td', {}, at, ' ', h('button', { class: 'small', onclick: () => { const f = parseInt(at.value, 16); if (isNaN(f) || f + it.data.length > S.rom.length) return toast('Does not fit in the ROM at that offset'); write(f, it.data, 'Insert ' + it.name); LB.offset = f; toast('Inserted ' + it.data.length + ' bytes at $' + hex(f, 6)); } }, 'Insert')),
        h('td', {}, h('button', { class: 'small', onclick: () => download(new Blob([it.data]), it.name.replace(/[^\w.-]+/g, '_') + '.bin') }, 'Download'), ' ', h('button', { class: 'small', onclick: () => { S.lib.splice(S.lib.indexOf(it), 1); renderLib(); } }, 'Delete'))); })));
}

/* =========================================================
   EXPORT
   ========================================================= */
const EX = { el: null };
defineTab('export', 'Export', (el) => { EX.el = el; }, () => {
  const el = EX.el; if (!S.rom) return noRomMsg(el);
  if (isNes()) return renderExportNes(el);
  const hd = Core.readHeader(S.rom, S.hdr);
  const f = {};
  f.title = h('input', { type: 'text', id: 'hdrtitle', value: hd.title, maxlength: 21, size: 24 });
  f.version = h('input', { type: 'number', id: 'hdrver', value: hd.version, min: 0, max: 255 });
  f.region = h('select', { id: 'hdrregion' }, [[0, 'Japan'], [1, 'North America'], [2, 'Europe'], [3, 'Sweden'], [4, 'Finland'], [5, 'Denmark'], [6, 'France'], [7, 'Netherlands'], [8, 'Spain'], [9, 'Germany'], [10, 'Italy'], [11, 'China'], [13, 'Korea'], [15, 'Canada'], [16, 'Brazil'], [17, 'Australia']].map(([v, t]) => h('option', { value: v, selected: v === hd.region }, v + ' · ' + t)));
  f.ram = h('select', { id: 'hdrram' }, [[0, 'None'], [1, '2 KB'], [2, '4 KB'], [3, '8 KB'], [4, '16 KB'], [5, '32 KB'], [6, '64 KB'], [7, '128 KB']].map(([v, t]) => h('option', { value: v, selected: v === hd.ramSizeCode }, t)));
  f.type = h('select', { id: 'hdrtype' }, [[0, 'ROM only'], [1, 'ROM + RAM'], [2, 'ROM + RAM + battery']].map(([v, t]) => h('option', { value: v, selected: v === hd.cartType }, t)));
  f.size = h('select', { id: 'exsize' }, [128, 256, 512, 1024, 2048, 3072, 4096].filter((k) => Core.isPow2(k * 1024)).map((k) => h('option', { value: k, selected: k * 1024 === S.rom.length }, k >= 1024 ? k / 1024 + ' MB' : k + ' KB')));
  if (!Core.isPow2(S.rom.length)) f.size.prepend(h('option', { value: S.rom.length / 1024, selected: true }, (S.rom.length / 1024) + ' KB (current)'));
  f.fix = h('input', { type: 'checkbox', id: 'exfix', checked: true });
  f.copier = h('input', { type: 'checkbox', id: 'excopier', checked: S.hadCopier });
  const applyHdr = () => {
    const tmp = S.rom.slice(S.hdr, S.hdr + 0x40); const shadow = new Uint8Array(S.hdr + 0x40); shadow.set(tmp, S.hdr);
    Core.writeHeader(shadow, S.hdr, { title: f.title.value, region: +f.region.value, version: +f.version.value, ramSizeCode: +f.ram.value, cartType: +f.type.value });
    shadow[S.hdr + 0x17] = tmp[0x17];
    write(S.hdr, shadow.slice(S.hdr, S.hdr + 0x40), 'Edit header'); toast('Header updated');
  };
  const applySize = () => {
    const nk = +f.size.value; if (nk * 1024 === S.rom.length) return toast('Already that size');
    if (nk * 1024 < S.rom.length) { const tail = S.rom.slice(nk * 1024); if (tail.some((b) => b !== 0 && b !== 0xFF) && !confirm('Shrinking will cut off data that is not empty. Continue?')) return; }
    S.rom = Core.resizeRom(S.rom, nk * 1024); Core.writeHeader(S.rom, S.hdr, {}); S.hist = []; S.redo = []; S.cls = null; textCache = null; ensureClass();
    $('#projname').textContent = projLabel(); toast('ROM resized to ' + nk + ' KB (undo history cleared)'); notify();
  };
  const sumOk = Core.checksumOk(S.rom, S.hdr);
  const dl = () => saveRom();
  el.replaceChildren(h('div', { class: 'cols' },
    h('div', { style: 'flex:1 1 420px' },
      h('div', { class: 'card' }, h('h2', {}, 'Header'),
        h('div', { class: 'row' }, h('label', {}, 'Title (21 chars)'), f.title), h('div', { class: 'row' }, h('label', {}, 'Region'), f.region, h('label', {}, 'Version'), f.version),
        h('div', { class: 'row' }, h('label', {}, 'Cartridge'), f.type, h('label', {}, 'Save RAM'), f.ram), h('div', { class: 'row' }, h('button', { id: 'btnHdr', onclick: applyHdr }, 'Apply header changes'))),
      h('div', { class: 'card' }, h('h2', {}, 'Size'), h('div', { class: 'row' }, f.size, h('button', { id: 'btnResize', onclick: applySize }, 'Resize ROM'), h('span', { class: 'muted' }, 'Expanding adds empty space (00) you can fill with new assets.')))),
    h('div', { style: 'flex:1 1 420px' },
      h('div', { class: 'card' }, h('h2', {}, 'Package'),
        h('div', { class: 'kv' }, h('span', {}, 'Checksum now'), h('span', { class: sumOk ? 'ok' : 'warn' }, sumOk ? 'valid' : 'out of date'), h('span', {}, 'Changed bytes'), h('span', {}, S.diffCount.toLocaleString()), h('span', {}, 'Size'), h('span', {}, (S.rom.length / 1024) + ' KB')),
        h('div', { class: 'row' }, h('label', {}, f.fix, ' Fix header checksum when saving')), h('div', { class: 'row' }, h('label', {}, f.copier, ' Save as .smc (adds a 512-byte copier header)')),
        h('div', { class: 'row' }, h('button', { id: 'btnSave2', class: 'primary', onclick: dl }, 'Save .sfc'), h('button', { id: 'btnIps2', onclick: saveIps }, 'Export IPS patch'), h('button', { onclick: () => $('#fileIps').click() }, 'Apply IPS…'), h('input', { type: 'file', id: 'fileIps', hidden: true, onchange: (e) => { if (e.target.files[0]) applyIpsFile(e.target.files[0]); e.target.value = ''; } })),
        h('p', { class: 'muted', style: 'font-size:12px' }, 'An IPS patch contains only your changes, so you can share a mod without sharing the original ROM.')),
      h('div', { class: 'card' }, h('h2', {}, 'Project'),
        h('div', { class: 'row' }, h('button', { id: 'btnProjSave', onclick: saveProject }, 'Save project (.json)'), h('button', { onclick: () => $('#fileProj').click() }, 'Load project…'), h('input', { type: 'file', id: 'fileProj', accept: '.json', hidden: true, onchange: (e) => { if (e.target.files[0]) loadProject(e.target.files[0]); e.target.value = ''; } })),
        h('div', { class: 'row' }, h('button', { class: 'danger', onclick: () => { if (!confirm('Discard all changes and return to the original?')) return; S.rom = S.orig.slice(); S.hist = []; S.redo = []; S.cls = null; textCache = null; ensureClass(); toast('Reverted to original'); notify(); } }, 'Revert everything')),
        h('p', { class: 'muted', style: 'font-size:12px' }, 'A project file stores your changes (as a patch), the library, and which base it applies to. Load the same base ROM first, then the project.')))));
  EX.f = f;
});
function renderExportNes(el) {
  const n = S.nes, f = { nes: true };
  f.mapper = h('input', { type: 'number', id: 'nesmapper', min: 0, max: 255, value: n.mapper, style: 'width:70px' });
  f.mirror = h('select', { id: 'nesmirror' }, ['horizontal', 'vertical', 'four-screen'].map((m) => h('option', { value: m, selected: m === n.mirror }, m)));
  f.battery = h('input', { type: 'checkbox', id: 'nesbattery', checked: n.battery });
  const apply = () => { beginGroup('Edit iNES header'); const hd = S.rom.slice(0, 16); NES.setHeader(hd, { mapper: +f.mapper.value, mirror: f.mirror.value, battery: f.battery.checked }); write(0, hd, 'Edit iNES header'); endGroup(); toast('Header updated'); };
  EX.f = f;
  el.replaceChildren(h('div', { class: 'cols' },
    h('div', { style: 'flex:1 1 420px' },
      h('div', { class: 'card' }, h('h2', {}, 'iNES header'),
        h('div', { class: 'row' }, h('label', {}, 'Mapper'), f.mapper, h('span', { class: 'muted', id: 'mappername' }, n.mapperName)),
        h('div', { class: 'row' }, h('label', {}, 'Mirroring'), f.mirror, h('label', {}, f.battery, ' battery-backed save RAM')),
        h('div', { class: 'row' }, h('button', { id: 'btnHdr', onclick: apply }, 'Apply header changes')),
        h('p', { class: 'muted', style: 'font-size:12px' }, 'PRG ' + (n.prgSize >> 10) + ' KB, CHR ' + (n.chrSize >> 10) + ' KB. Changing the PRG/CHR size is not supported yet; bytes inside the existing banks are all editable. Changing the mapper only changes the header, so it must match the game code.'))),
    h('div', { style: 'flex:1 1 420px' },
      h('div', { class: 'card' }, h('h2', {}, 'Package'),
        h('div', { class: 'kv' }, h('span', {}, 'Changed bytes'), h('span', {}, S.diffCount.toLocaleString()), h('span', {}, 'Size'), h('span', {}, (S.rom.length / 1024) + ' KB'), h('span', {}, 'Checksum'), h('span', {}, 'not used by NES ROMs')),
        h('div', { class: 'row' }, h('button', { id: 'btnSave2', class: 'primary', onclick: saveRom }, 'Save .nes'), h('button', { id: 'btnIps2', onclick: saveIps }, 'Export IPS patch'), h('button', { onclick: () => $('#fileIps').click() }, 'Apply IPS…'), h('input', { type: 'file', id: 'fileIps', hidden: true, onchange: (e) => { if (e.target.files[0]) applyIpsFile(e.target.files[0]); e.target.value = ''; } })),
        h('p', { class: 'muted', style: 'font-size:12px' }, 'An IPS patch contains only your changes, so you can share a mod without sharing the original ROM.')),
      projectCard())));
}
function projectCard() {
  return h('div', { class: 'card' }, h('h2', {}, 'Project'),
    h('div', { class: 'row' }, h('button', { id: 'btnProjSave', onclick: saveProject }, 'Save project (.json)'), h('button', { onclick: () => $('#fileProj').click() }, 'Load project…'), h('input', { type: 'file', id: 'fileProj', accept: '.json', hidden: true, onchange: (e) => { if (e.target.files[0]) loadProject(e.target.files[0]); e.target.value = ''; } })),
    h('div', { class: 'row' }, h('button', { class: 'danger', onclick: () => { if (!confirm('Discard all changes and return to the original?')) return; S.rom = S.orig.slice(); if (isNes()) S.nes = NES.parse(S.rom); S.hist = []; S.redo = []; S.cls = null; textCache = null; ensureClass(); toast('Reverted to original'); notify(); } }, 'Revert everything')),
    h('p', { class: 'muted', style: 'font-size:12px' }, 'A project file stores your changes (as a patch), the library, and which base it applies to. Load the same base ROM first, then the project.'));
}
let dlCap;
function download(blob, name) {
  if (window.claude && window.claude.use) {
    (dlCap || (dlCap = window.claude.use('downloads'))).then((d) => {
      if (!d) return anchorDownload(blob, name);
      return d.save({ filename: name, data: blob }).catch((e) => { if (e && /declin|cancel|denied/i.test(String(e.message || e))) return; anchorDownload(blob, name); });
    }, () => anchorDownload(blob, name));
    return;
  }
  anchorDownload(blob, name);
}
function anchorDownload(blob, name) { const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
function baseName() { return (S.name || 'project').replace(/\.[^.]+$/, ''); }
function copierHeader(size) { const hd = new Uint8Array(512); const blocks = Math.ceil(size / 8192); hd[0] = blocks & 255; hd[1] = (blocks >> 8) & 255; hd[8] = 0xAA; hd[9] = 0xBB; hd[10] = 4; return hd; }
function buildOutput() {
  if (isNes()) return { data: S.rom.slice(), fixed: false, ext: '.nes' };
  const out = S.rom.slice(); const fix = !EX.f || !EX.f.fix || EX.f.fix.checked, copier = EX.f && EX.f.copier ? EX.f.copier.checked : S.hadCopier;
  if (fix) Core.fixChecksum(out, S.hdr);
  if (copier) { const t = new Uint8Array(out.length + 512); t.set(copierHeader(out.length), 0); t.set(out, 512); return { data: t, fixed: fix, ext: '.smc' }; }
  return { data: out, fixed: fix, ext: '.sfc' };
}
function saveRom() {
  if (!needRom()) return; const { data, fixed, ext } = buildOutput();
  download(new Blob([data], { type: 'application/octet-stream' }), baseName().replace(/_mod$/, '') + '_mod' + ext);
  setStatus('Saved ROM (' + Math.round(data.length / 102.4) / 10 + ' KB' + (fixed ? ', checksum fixed' : '') + ')'); toast('ROM saved as ' + ext);
}
function saveIps() {
  if (!needRom()) return; const cur = S.rom.slice(); if (!isNes()) Core.fixChecksum(cur, S.hdr);
  const base = S.orig.slice(); const ips = Core.makeIPS(base, cur);
  if (ips.length <= 8) return toast('No changes to export yet.');
  download(new Blob([ips]), baseName() + '.ips'); toast('IPS patch saved (' + ips.length.toLocaleString() + ' bytes)');
}
function applyIpsFile(file) {
  if (!needRom()) return; const r = new FileReader();
  r.onload = () => { try { const patched = Core.applyIPS(S.rom, new Uint8Array(r.result)); beginGroup('Apply IPS'); if (patched.length !== S.rom.length) { S.rom = Core.resizeRom(patched, patched.length); S.hist = []; S.cls = null; } else write(0, patched, 'Apply IPS'); endGroup(); toast('IPS applied'); notify(); } catch (e) { toast('IPS failed: ' + e.message); } };
  r.readAsArrayBuffer(file);
}
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const r = atob(s), u = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) u[i] = r.charCodeAt(i); return u; };
function saveProject() {
  if (!needRom()) return; const ips = Core.makeIPS(S.orig, S.rom);
  const proj = { format: 'snes-studio-project', v: 1, platform: S.platform, name: S.name, mapping: S.mapping, base: S.base, patch: b64(ips), library: S.lib.map((l) => ({ name: l.name, kind: l.kind, fmt: l.fmt, data: b64(l.data) })), size: S.rom.length };
  download(new Blob([JSON.stringify(proj)], { type: 'application/json' }), baseName() + '.studio.json'); toast('Project saved');
}
function loadProject(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const p = JSON.parse(r.result); if (p.format !== 'snes-studio-project') throw new Error('not a SNES Studio project');
      let base;
      if (p.platform === 'nes' && p.base.kind !== 'rom' || p.base.kind === 'nes-starter' || p.base.kind === 'nes-blank') {
        const b = p.base.kind === 'nes-starter' ? NES.buildStarter(p.base.sizeKB) : NES.buildBlank(p.base.sizeKB);
        setProject(b.rom, { name: p.name, mapping: 'NES', hdr: 0, platform: 'nes', nes: b.info, base: p.base });
      } else if (p.base.kind === 'starter') base = Core.buildStarter(p.base.sizeKB, p.base.title);
      else if (p.base.kind === 'blank') base = Core.buildBlank(p.base.sizeKB, p.base.title);
      if (base) setProject(base.rom, { name: p.name, mapping: 'LoROM', hdr: base.hdr, base: p.base });
      else if (p.base.kind === 'rom') {
        if ((p.platform || 'snes') !== S.platform) throw new Error('this project is for a ' + (p.platform || 'snes').toUpperCase() + ' ROM but a ' + S.platform.toUpperCase() + ' ROM is loaded');
        if (!S.orig || !S.base || S.base.kind !== 'rom' || S.base.size !== p.base.size || S.base.sum !== p.base.sum) { if (!confirm('The loaded ROM does not match the project\'s base ROM (size/checksum). Apply anyway?')) return; }
        S.name = p.name || S.name;
      }
      S.rom = Core.applyIPS(S.orig, unb64(p.patch)); if (isNes()) S.nes = NES.parse(S.rom) || S.nes; S.hist = []; S.redo = []; S.cls = null; textCache = null; ensureClass();
      S.lib = (p.library || []).map((l) => ({ id: S.libId++, name: l.name, kind: l.kind, fmt: l.fmt, data: unb64(l.data) }));
      $('#projname').textContent = projLabel();
      toast('Project loaded'); showTab('overview'); notify();
    } catch (e) { toast('Could not load project: ' + e.message, 4000); }
  };
  r.readAsText(file);
}

/* =========================================================
   NEW PROJECT
   ========================================================= */
function modal(content) { const m = $('#modal'); $('#modalBox').replaceChildren(content); m.classList.add('open'); }
function closeModal() { $('#modal').classList.remove('open'); }
function newProjectDialog() {
  const plat = h('select', { id: 'npplat' }, h('option', { value: 'snes' }, 'Super Nintendo (SNES, .sfc / .smc)'), h('option', { value: 'nes' }, 'Nintendo (NES, .nes)'));
  const size = h('select', { id: 'npsize' });
  const title = h('input', { type: 'text', id: 'nptitle', value: 'MY SNES GAME', maxlength: 21, size: 24 });
  const kind = h('select', { id: 'npkind' });
  const titleRow = h('div', { class: 'row' }, h('label', {}, 'Title'), title);
  const fill = () => {
    const nes = plat.value === 'nes';
    kind.replaceChildren(h('option', { value: 'starter' }, nes ? 'Starter game (playable: coloured background + sprite you move)' : 'Starter game (playable: scrolling background + sprite you move)'), h('option', { value: 'blank' }, nes ? 'Blank (reset loop, empty graphics)' : 'Blank (header and a reset loop only)'));
    size.replaceChildren(...(nes ? [16, 32] : [128, 256, 512, 1024, 2048]).map((k, i) => h('option', { value: k, selected: i === 0 }, nes ? k + ' KB PRG + 8 KB CHR' : k >= 1024 ? k / 1024 + ' MB' : k + ' KB')));
    titleRow.style.display = nes ? 'none' : ''; title.value = nes ? 'my_nes_game' : 'MY SNES GAME';
  };
  plat.onchange = fill; fill();
  modal(h('div', {}, h('h2', {}, 'New project'),
    h('p', { class: 'muted', style: 'margin-top:0' }, 'Create a ROM from scratch. The starter includes source code, graphics, palettes and a tile map you can edit here and run in any emulator. If you loaded a ROM first it stays available as a source for borrowing assets via the Library.'),
    h('div', { class: 'row' }, h('label', {}, 'Platform'), plat), h('div', { class: 'row' }, h('label', {}, 'Template'), kind), titleRow, h('div', { class: 'row' }, h('label', {}, 'ROM size'), size),
    h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { onclick: closeModal }, 'Cancel'), h('button', { id: 'npcreate', class: 'primary', onclick: () => { createProject(kind.value, +size.value, title.value, plat.value); closeModal(); } }, 'Create'))));
}
function createProject(kind, sizeKB, title, platform) {
  const keepSrc = S.rom ? S.src : null;
  if (platform === 'nes') {
    const b = kind === 'starter' ? NES.buildStarter(sizeKB) : NES.buildBlank(sizeKB); const nm = (title || 'my_nes_game').toLowerCase().replace(/\W+/g, '_') + '.nes';
    setProject(b.rom, { name: nm, mapping: 'NES', hdr: 0, platform: 'nes', nes: b.info, base: { kind: 'nes-' + kind, sizeKB }, src: keepSrc || b.rom.slice() });
    Object.assign(G, { fmt: 'nes2bpp', off: b.info.chrOff, cols: 16, rows: 4, pal: 'rom', palSub: 0, tile: 1, zoom: 4 });
    if (kind === 'starter') { const pf = NES.cpuToFile(b.symbols.Palette, b.info, 0); G.palOff = pf; P.off = pf; }
    H.base = b.info.chrOff; CD.addr = null; CD.reset = true;
    showTab(kind === 'starter' ? 'gfx' : 'overview'); notify();
    return toast(kind === 'starter' ? 'NES starter ready: edit tiles in Graphics, colours in Palettes, code in Code, then Save .nes.' : 'Blank NES project ready.', 5000);
  }
  title = (title || 'MY SNES GAME').toUpperCase();
  const b = kind === 'starter' ? Core.buildStarter(sizeKB, title) : Core.buildBlank(sizeKB, title);
  setProject(b.rom, { name: title.toLowerCase().replace(/\W+/g, '_') + '.sfc', mapping: 'LoROM', hdr: b.hdr, base: { kind, sizeKB, title }, src: keepSrc || b.rom.slice() });
  const f = (a) => Core.snesToFile(a, 'LoROM', b.rom.length), SS = Core.STARTER;
  if (kind === 'starter') { Object.assign(G, { fmt: '4bpp', off: f(SS.TILES_BG), cols: 16, rows: 4, pal: 'rom', palOff: f(SS.PAL_BG), palSub: 0, tile: 1 }); P.off = f(SS.PAL_BG); H.base = f(SS.TILEMAP) - 64; }
  CD.addr = null; CD.reset = true;
  showTab(kind === 'starter' ? 'gfx' : 'overview'); notify();
  toast(kind === 'starter' ? 'Starter project ready: edit tiles in Graphics, colours in Palettes, code in Code, then Save .sfc.' : 'Blank project ready.', 5000);
}

/* =========================================================
   RENDER (compose a scene from tiles + palettes + tilemaps + sprites)
   ========================================================= */
const R = { el: null, builtFor: null, zoom: 2, showBg: true, showObj: true, manual: '',
  snes: { bgTiles: 0, objTiles: 0, fmt: '4bpp', map: 0, mapW: 32, mapH: 32, palBg: 0, palObj: 0, oam: -1, size: '8,16' },
  nes: { bgChr: 0, spChr: 0, nt: 0, pal: 0, oam: -1, tall: false, mapAt: 0 } };
const OBJ_SIZES = { '8,16': [8, 16], '8,32': [8, 32], '8,64': [8, 64], '16,32': [16, 32], '16,64': [16, 64], '32,64': [32, 64] };
defineTab('scene', 'Render', (el) => { R.el = el; }, () => {
  if (R.builtFor !== S.platform) { buildScene(); R.builtFor = S.platform; }
  drawScene();
}, true);
function offInput(id, obj, key, w) {
  return h('input', { type: 'text', id, size: w || 8, value: hex(obj[key] < 0 ? 0 : obj[key], 6), onchange: (e) => { const t = e.target.value.trim(); if (t === '-' || t === '') { obj[key] = -1; } else { const f = parseLoc(t); if (f == null) return toast('Not a valid offset'); obj[key] = f; } drawScene(); } });
}
function buildScene() {
  const el = R.el, nes = isNes(), o = nes ? R.nes : R.snes;
  if (!R.inited) { R.inited = true; if (!nes) { R.snes.bgTiles = R.snes.objTiles = G.off; if (G.pal === 'rom') R.snes.palBg = R.snes.palObj = G.palOff; } else { R.nes.bgChr = R.nes.spChr = S.nes.chrOff || S.nes.prgOff; R.nes.pal = G.palOff; } }
  R.cv = h('canvas', { id: 'scenecv', style: 'image-rendering:pixelated;background:#000;border:1px solid var(--line);max-width:100%' });
  R.info = h('div', { class: 'muted mono', style: 'font-size:12px;margin-top:6px;min-height:34px' });
  R.manualIn = h('textarea', { id: 'scenesprites', rows: 4, spellcheck: 'false', placeholder: 'x y tile pal [hflip] [vflip] [large]  (one sprite per line)', style: 'width:100%;font-family:var(--mono,monospace)', oninput: (e) => { R.manual = e.target.value; drawScene(); } }, R.manual);
  const chk = (id, lbl, key) => h('label', {}, h('input', { type: 'checkbox', id, checked: R[key], onchange: (e) => { R[key] = e.target.checked; drawScene(); } }), ' ' + lbl);
  const zoom = h('select', { id: 'scenezoom', onchange: (e) => { R.zoom = +e.target.value; drawScene(); } }, [1, 2, 3, 4].map((z) => h('option', { value: z, selected: z === R.zoom }, z + '×')));
  const row = (...k) => h('div', { class: 'row' }, ...k);
  const lab = (t, tip) => h('label', { title: tip || '' }, t);
  const ctrls = nes ? [
    row(lab('Nametable at', 'file offset of 960 tile bytes followed by 64 attribute bytes'), offInput('rnt', o, 'nt'), lab('BG patterns at', 'file offset of the 4 KB CHR table used by the background'), offInput('rbg', o, 'bgChr')),
    row(lab('Sprite patterns at'), offInput('rsp', o, 'spChr'), lab('Palettes at', '32 bytes: 16 background then 16 sprite'), offInput('rpal', o, 'pal'), h('label', {}, h('input', { type: 'checkbox', id: 'rtall', checked: o.tall, onchange: (e) => { o.tall = e.target.checked; drawScene(); } }), ' 8×16 sprites')),
    row(lab('OAM table at', '256 bytes (64 sprites) in the ROM; type - for none'), offInput('roam', o, 'oam'), h('span', { class: 'muted' }, '(optional)'))
  ] : [
    row(lab('BG tiles at'), offInput('rbg', o, 'bgTiles'), lab('Format'), h('select', { id: 'rfmt', onchange: (e) => { o.fmt = e.target.value; drawScene(); } }, ['2bpp', '4bpp', '8bpp'].map((f) => h('option', { value: f, selected: f === o.fmt }, f)))),
    row(lab('Tilemap at', '2 bytes per tile: tile, palette, priority, flips'), offInput('rmap', o, 'map'), lab('Size'), h('select', { id: 'rmapsz', onchange: (e) => { const [w, hh] = e.target.value.split('x').map(Number); o.mapW = w; o.mapH = hh; drawScene(); } }, ['32x32', '64x32', '32x64', '64x64'].map((v) => h('option', { value: v, selected: v === o.mapW + 'x' + o.mapH }, v.replace('x', ' × ') + ' tiles')))),
    row(lab('BG palette at'), offInput('rpbg', o, 'palBg'), lab('Sprite tiles at'), offInput('rsp', o, 'objTiles'), lab('Sprite palette at'), offInput('rpobj', o, 'palObj')),
    row(lab('OAM table at', '544 bytes in the ROM; type - for none'), offInput('roam', o, 'oam'), lab('Sprite sizes'), h('select', { id: 'rsize', onchange: (e) => { o.size = e.target.value; drawScene(); } }, Object.keys(OBJ_SIZES).map((v) => h('option', { value: v, selected: v === o.size }, v.replace(',', ' / ') + ' px'))))
  ];
  const presets = [h('button', { id: 'rfromgfx', onclick: () => { if (nes) { R.nes.bgChr = R.nes.spChr = G.off; if (G.pal === 'rom') R.nes.pal = G.palOff; } else { R.snes.bgTiles = R.snes.objTiles = G.off; R.snes.fmt = ['2bpp', '4bpp', '8bpp'].includes(G.fmt) ? G.fmt : '4bpp'; if (G.pal === 'rom') R.snes.palBg = R.snes.palObj = G.palOff; } buildScene(); drawScene(); } }, 'Copy tile + palette from Graphics tab')];
  if (S.base && (S.base.kind === 'starter' || S.base.kind === 'nes-starter')) presets.push(h('button', { id: 'rstarter', class: 'primary', onclick: () => { applyScenePreset(); buildScene(); drawScene(); } }, 'Use starter project layout'));
  el.replaceChildren(h('div', { class: 'cols' },
    h('div', { style: 'flex:0 0 440px;min-width:300px' }, h('div', { class: 'card' }, h('h2', {}, 'Scene sources'),
      h('p', { class: 'muted', style: 'font-size:12px;margin-top:0' }, 'Point each layer at its data in the ROM and the scene is built from the real tiles, palettes, tilemap and sprites, updating live as you edit. Offsets are file offsets in hex.'),
      ...ctrls, row(chk('rbgon', 'background', 'showBg'), chk('robjon', 'sprites', 'showObj'), lab('Zoom'), zoom), row(...presets),
      h('h3', {}, 'Extra sprites'), R.manualIn,
      h('p', { class: 'muted', style: 'font-size:12px' }, 'Lines like "120 100 3 0" place tile 3 using sprite palette 0 at x=120, y=100. Optional hflip / vflip / large as 0 or 1.'))),
    h('div', { style: 'flex:1 1 400px;min-width:0' }, h('div', { class: 'card' }, h('h2', {}, 'Rendered scene'), R.cv, R.info, h('div', { class: 'row' }, h('button', { id: 'rpng', onclick: () => R.cv.toBlob((b) => download(b, 'scene.png')) }, 'Export PNG'))))));
}
function applyScenePreset() {
  if (isNes()) {
    const n = S.nes, f = (a) => NES.cpuToFile(a, n, 0); const sym = (() => { try { return NES.assemble(NES.starterSource(), { org: 0xC000 }).symbols; } catch (e) { return {}; } })();
    Object.assign(R.nes, { bgChr: n.chrOff, spChr: n.chrOff, pal: f(sym.Palette), nt: -1 });
    R.manual = '120 120 3 0'; R.nes.ntFill = true;
  } else {
    const SS = Core.STARTER, f = (a) => Core.snesToFile(a, 'LoROM', S.rom.length);
    Object.assign(R.snes, { bgTiles: f(SS.TILES_BG), objTiles: f(SS.TILES_OBJ), fmt: '4bpp', map: f(SS.TILEMAP), mapW: 32, mapH: 32, palBg: f(SS.PAL_BG), palObj: f(SS.PAL_OBJ), oam: f(SS.OAM), size: '8,16' });
    R.manual = '';
  }
}
function tileToImg(img, W, H, x0, y0, off, fmt, pal, hf, vf, transp) {
  const tb = Core.FORMATS[fmt].bytes; if (off < 0 || off + tb > S.rom.length) return;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const c = Core.getPixel(S.rom, off, fmt, hf ? 7 - x : x, vf ? 7 - y : y); if (transp && c === 0) continue;
    const px = x0 + x, py = y0 + y; if (px < 0 || py < 0 || px >= W || py >= H) continue;
    const col = pal[c] || [255, 0, 255], i = (py * W + px) * 4; img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
  }
}
const snesPal = (off, n) => { const p = []; for (let i = 0; i < n; i++) p.push(off >= 0 && off + i * 2 + 1 < S.rom.length ? Core.readColor(S.rom, off + i * 2) : [255, 0, 255]); return p; };
function parseManual(txt) { return txt.split(/\n/).map((l) => l.trim().split(/[\s,]+/).map(Number)).filter((a) => a.length >= 4 && a.every((v, i) => i < 4 ? !isNaN(v) : true)).map((a) => ({ x: a[0], y: a[1], tile: a[2], pal: a[3], h: !!a[4], v: !!a[5], large: !!a[6], nt: 0 })); }
function drawScene() {
  if (!S.rom || !R.cv) return; const nes = isNes();
  let W, H, notes = [];
  if (nes) { W = 256; H = 240; } else { W = R.snes.mapW * 8; H = R.snes.mapH * 8; }
  const img = new ImageData(W, H);
  for (let i = 0; i < W * H; i++) img.data[i * 4 + 3] = 255;
  if (nes) {
    const o = R.nes, pal = []; for (let i = 0; i < 32; i++) pal.push(o.pal + i < S.rom.length ? S.rom[o.pal + i] & 63 : 0x0F);
    const back = NES.PALETTE[pal[0]]; for (let i = 0; i < W * H; i++) { img.data[i * 4] = back[0]; img.data[i * 4 + 1] = back[1]; img.data[i * 4 + 2] = back[2]; }
    const col = (base, p) => [back, NES.PALETTE[pal[base + p * 4 + 1]], NES.PALETTE[pal[base + p * 4 + 2]], NES.PALETTE[pal[base + p * 4 + 3]]];
    if (R.showBg) {
      let nt = o.nt; const fill = o.ntFill && nt < 0;
      for (let ty = 0; ty < 30; ty++) for (let tx = 0; tx < 32; tx++) {
        let idx, at;
        if (fill) { idx = ((tx & 1) ? 2 : 1); at = 0; } else { if (nt < 0 || nt + 1024 > S.rom.length) { notes.push('nametable offset is outside the ROM'); ty = 99; break; } idx = S.rom[nt + ty * 32 + tx]; at = S.rom[nt + 960 + (ty >> 2) * 8 + (tx >> 2)]; }
        const p = (at >> (((ty >> 1) & 1) * 4 + ((tx >> 1) & 1) * 2)) & 3;
        tileToImg(img, W, H, tx * 8, ty * 8, o.bgChr + idx * 16, 'nes2bpp', col(0, p), false, false, true);
      }
      if (fill) notes.push('background = the starter\'s startup pattern (tiles 1 and 2 alternate; the game writes it at runtime)');
    }
    if (R.showObj) {
      const sp = []; if (o.oam >= 0 && o.oam + 256 <= S.rom.length) for (let i = 0; i < 64; i++) { const b = o.oam + i * 4; if (S.rom[b] < 0xEF) sp.push({ y: S.rom[b], tile: S.rom[b + 1], pal: S.rom[b + 2] & 3, h: !!(S.rom[b + 2] & 0x40), v: !!(S.rom[b + 2] & 0x80), x: S.rom[b + 3] }); }
      for (const m of parseManual(R.manual)) sp.push({ ...m });
      for (const s of sp.reverse()) {
        const c = col(16, s.pal), y = s.y + 1;
        if (o.tall) { const base = (s.tile & 1) * 0x1000, t = s.tile & 0xFE; const top = s.v ? t + 1 : t, bot = s.v ? t : t + 1; tileToImg(img, W, H, s.x, y, o.spChr + base + top * 16, 'nes2bpp', c, s.h, s.v, true); tileToImg(img, W, H, s.x, y + 8, o.spChr + base + bot * 16, 'nes2bpp', c, s.h, s.v, true); }
        else tileToImg(img, W, H, s.x, y, o.spChr + s.tile * 16, 'nes2bpp', c, s.h, s.v, true);
      }
      notes.push('NES sprites are built at runtime in RAM; list them here or point at an OAM table to preview');
    }
  } else {
    const o = R.snes, fmt = o.fmt, tb = Core.FORMATS[fmt].bytes, cc = 1 << Core.FORMATS[fmt].bpp;
    const back = snesPal(o.palBg, 1)[0]; for (let i = 0; i < W * H; i++) { img.data[i * 4] = back[0]; img.data[i * 4 + 1] = back[1]; img.data[i * 4 + 2] = back[2]; }
    if (R.showBg) {
      if (o.map + o.mapW * o.mapH * 2 > S.rom.length) notes.push('tilemap runs past the end of the ROM');
      for (let ty = 0; ty < o.mapH; ty++) for (let tx = 0; tx < o.mapW; tx++) {
        const sc = (ty >= 32 ? (o.mapW === 64 ? 2 : 1) : 0) + (tx >= 32 ? 1 : 0), p = o.map + (sc * 1024 + (ty & 31) * 32 + (tx & 31)) * 2; if (p + 1 >= S.rom.length) continue;
        const e = S.rom[p] | S.rom[p + 1] << 8, num = e & 0x3FF, pl = (e >> 10) & 7;
        const pal = snesPal(o.palBg + (cc === 256 ? 0 : pl * cc * 2), cc);
        tileToImg(img, W, H, tx * 8, ty * 8, o.bgTiles + num * tb, fmt, pal, !!(e & 0x4000), !!(e & 0x8000), false);
      }
    }
    if (R.showObj) {
      const [sw, lw] = OBJ_SIZES[o.size]; const sp = [];
      if (o.oam >= 0 && o.oam + 544 <= S.rom.length) for (let i = 0; i < 128; i++) { const b = o.oam + i * 4, hi = (S.rom[o.oam + 512 + (i >> 2)] >> ((i & 3) * 2)) & 3; let x = S.rom[b] | ((hi & 1) << 8); if (x > 255) x -= 512; const a = S.rom[b + 3]; if (S.rom[b + 1] < 0xE0 || x > -64) sp.push({ x, y: S.rom[b + 1], tile: S.rom[b + 2], nt: a & 1, pal: (a >> 1) & 7, h: !!(a & 0x40), v: !!(a & 0x80), large: !!(hi & 2) }); }
      for (const m of parseManual(R.manual)) sp.push({ ...m });
      for (const s of sp.reverse()) {
        const dim = s.large ? lw : sw, wt = dim / 8, ht = (s.large ? OBJ_SIZES[o.size][1] : OBJ_SIZES[o.size][0]) / 8;
        const wTiles = Math.max(1, wt), hTiles = wTiles; // square sprites
        const pal = snesPal(o.palObj + s.pal * 32, 16);
        for (let ty = 0; ty < hTiles; ty++) for (let tx = 0; tx < wTiles; tx++) {
          const c0 = s.tile & 15, r0 = (s.tile >> 4) & 15, num = (((r0 + ty) & 15) << 4) | ((c0 + tx) & 15) + (s.nt ? 256 : 0);
          const dx = (s.h ? wTiles - 1 - tx : tx) * 8, dy = (s.v ? hTiles - 1 - ty : ty) * 8;
          tileToImg(img, W, H, s.x + dx, s.y + 1 + dy, o.objTiles + num * 32, '4bpp', pal, s.h, s.v, true);
        }
      }
      if (o.oam < 0) notes.push('SNES sprites come from the OAM table (544 bytes) that the game uploads; set its offset or list sprites by hand');
    }
  }
  R.cv.width = W; R.cv.height = H; R.cv.getContext('2d').putImageData(img, 0, 0); R.cv.style.width = W * R.zoom + 'px';
  R.info.textContent = W + '×' + H + ' px · ' + (notes.join(' · ') || 'ready');
}

/* =========================================================
   AUDIO
   ========================================================= */
const Au = Core.Audio;
const AU = { el: null, mode: null, off: 0, len: 0, rate: 32000, pcm: null, loopBlock: -1, hist: [], scan: [], dpcmIdx: 15, rawFmt: 's16', sel: null, speed: 1, ctx: null, src: null, loopPlay: false, dest: null, srcBytes: 0, ended: false };
defineTab('audio', 'Audio', (el) => { AU.el = el; buildAudio(); }, () => { if (!AU.mode) buildAudio(); refreshAudioInfo(); }, true);
const dur = () => (AU.pcm ? AU.pcm.length / AU.rate : 0);
function auPush() { AU.hist.push({ pcm: AU.pcm.slice(), loop: AU.loopBlock }); if (AU.hist.length > 25) AU.hist.shift(); }
function auModeDefault() { return isNes() ? 'dpcm' : 'brr'; }
function auLoadFromRom() {
  if (!needRom()) return; auStop();
  try {
    if (AU.mode === 'brr') { const d = Au.brrDecode(S.rom, AU.off); if (!d.pcm.length) return toast('Nothing to decode at that offset'); AU.pcm = d.pcm; AU.srcBytes = d.bytes; AU.len = d.bytes; AU.loopBlock = d.loop ? 0 : -1; AU.ended = d.ended; if (!d.ended) toast('No end-flag block found; decoded ' + d.blocks + ' blocks. This may not be a sample.', 4000); }
    else if (AU.mode === 'dpcm') { const len = Math.max(1, Math.min(AU.len || 1025, S.rom.length - AU.off)); AU.pcm = Au.dpcmDecode(S.rom, AU.off, len); AU.srcBytes = len; AU.len = len; AU.rate = Math.round(Au.dpcmRate(AU.dpcmIdx)); }
    else { const len = Math.max(2, Math.min(AU.len || 8192, S.rom.length - AU.off)); AU.pcm = Au.rawDecode(S.rom, AU.off, len, AU.rawFmt); AU.srcBytes = len; AU.len = len; }
  } catch (e) { return toast('Decode failed: ' + e.message); }
  AU.hist = []; AU.sel = null; AU.dest = AU.off; buildAudio(); drawWave();
}
function auPlay() {
  if (!AU.pcm) return toast('Load a sample first'); auStop();
  try {
    const C = window.AudioContext || window.webkitAudioContext; if (!AU.ctx) AU.ctx = new C(); if (AU.ctx.state === 'suspended') AU.ctx.resume();
    let a = 0, b = AU.pcm.length; if (AU.sel && AU.sel[1] - AU.sel[0] > 16) { a = AU.sel[0]; b = AU.sel[1]; }
    const buf = AU.ctx.createBuffer(1, b - a, Math.max(3000, Math.min(96000, AU.rate))); const ch = buf.getChannelData(0); for (let i = a; i < b; i++) ch[i - a] = AU.pcm[i] / 32768;
    const src = AU.ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = AU.speed;
    if (AU.loopPlay) { src.loop = true; if (AU.mode === 'brr' && AU.loopBlock >= 0 && a === 0) { src.loopStart = AU.loopBlock * 16 / buf.sampleRate; src.loopEnd = buf.duration; } }
    src.connect(AU.ctx.destination); src.onended = () => { if (AU.src === src) AU.src = null; }; src.start(); AU.src = src; setStatus('Playing ' + (b - a) + ' samples');
  } catch (e) { toast('Audio playback is not available here: ' + e.message); }
}
function auStop() { try { if (AU.src) AU.src.stop(); } catch (e) { /* already stopped */ } AU.src = null; }
function drawWave() {
  const cv = $('#wave', AU.el); if (!cv) return; const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.fillStyle = '#0b0d11'; ctx.fillRect(0, 0, W, H);
  if (!AU.pcm || !AU.pcm.length) return; const n = AU.pcm.length;
  ctx.strokeStyle = '#26303d'; ctx.beginPath(); ctx.moveTo(0, H / 2 + .5); ctx.lineTo(W, H / 2 + .5); ctx.stroke();
  if (AU.sel) { ctx.fillStyle = 'rgba(76,194,255,.22)'; ctx.fillRect(AU.sel[0] / n * W, 0, (AU.sel[1] - AU.sel[0]) / n * W, H); }
  ctx.fillStyle = '#4ade80';
  for (let x = 0; x < W; x++) { const a = Math.floor(x / W * n), b = Math.max(a + 1, Math.floor((x + 1) / W * n)); let mn = 32767, mx = -32768; for (let i = a; i < b && i < n; i++) { const v = AU.pcm[i]; if (v < mn) mn = v; if (v > mx) mx = v; } const y1 = H / 2 - mx / 32768 * (H / 2 - 2), y2 = H / 2 - mn / 32768 * (H / 2 - 2); ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1)); }
  if (AU.mode === 'brr' && AU.loopBlock >= 0) { const x = AU.loopBlock * 16 / n * W; ctx.strokeStyle = '#fbbf24'; ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, H); ctx.stroke(); }
}
function refreshAudioInfo() {
  const el = $('#auinfo', AU.el); if (!el) return;
  if (!AU.pcm) { el.textContent = 'No sample loaded. Choose an offset and press Load, or scan for samples.'; return; }
  const blocks = Math.ceil(AU.pcm.length / 16), enc = AU.mode === 'brr' ? ' · re-encoded size ' + blocks * 9 + ' bytes (' + blocks + ' blocks)' : '';
  el.textContent = AU.pcm.length.toLocaleString() + ' samples · ' + dur().toFixed(2) + ' s at ' + AU.rate + ' Hz' + enc + ' · original ' + AU.srcBytes + ' bytes' + (AU.sel ? ' · selection ' + (AU.sel[1] - AU.sel[0]) + ' samples' : '');
}
function auEdit(label, fn) { if (!AU.pcm) return toast('Load a sample first'); auPush(); let r; if (AU.sel && AU.sel[1] - AU.sel[0] > 1 && label !== 'Resample' && label !== 'Trim' && label !== 'Delete') { const [a, b] = AU.sel; r = AU.pcm.slice(); r.set(fn(AU.pcm.slice(a, b)), a); } else r = fn(AU.pcm); AU.pcm = r; if (label === 'Resample' || label === 'Trim' || label === 'Delete') AU.sel = null; drawWave(); refreshAudioInfo(); setStatus(label + ' applied'); }
async function auImport(file) {
  const bytes = new Uint8Array(await file.arrayBuffer()); let pcm, rate, loop = -1;
  try { const w = Au.readWav(bytes); if (w) { pcm = w.pcm; rate = w.rate; loop = w.loopStart; } } catch (e) { return toast(e.message); }
  if (!pcm) { try { const C = window.AudioContext || window.webkitAudioContext; if (!AU.ctx) AU.ctx = new C(); const ab = await AU.ctx.decodeAudioData(bytes.buffer.slice(0)); const f = ab.getChannelData(0); pcm = Int16Array.from(f, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)))); rate = ab.sampleRate; } catch (e) { return toast('Could not decode that audio file (use WAV, MP3, OGG or FLAC).'); } }
  const target = AU.rate || 32000; if (AU.pcm) auPush();
  if (rate !== target) pcm = Au.resample(pcm, target / rate);
  AU.pcm = pcm; AU.sel = null; if (loop >= 0 && AU.mode === 'brr') AU.loopBlock = Math.floor((loop * target / rate) / 16); buildAudio(); drawWave(); refreshAudioInfo(); toast('Imported ' + (pcm.length / target).toFixed(2) + ' s of audio at ' + target + ' Hz. Press "Write to ROM" to store it.', 4500);
}
function auWrite() {
  if (!AU.pcm || !needRom()) return; const dest = AU.dest == null ? AU.off : AU.dest;
  let bytes;
  if (AU.mode === 'brr') { bytes = Au.brrEncode(AU.pcm, { loopStart: AU.loopBlock >= 0 ? AU.loopBlock * 16 : -1 }); }
  else if (AU.mode === 'dpcm') { const n = AU.len || AU.srcBytes || 1025; bytes = Au.dpcmEncode(AU.pcm, n); }
  else { const w = Au.RAW[AU.rawFmt].bytes; bytes = Au.rawEncode(AU.pcm, AU.rawFmt, Math.min(AU.pcm.length, Math.floor((AU.len || AU.srcBytes) / w))); }
  if (dest + bytes.length > S.rom.length) return toast('That does not fit in the ROM at $' + hex(dest, 6));
  const fits = dest !== AU.off || !AU.srcBytes || bytes.length <= AU.srcBytes; let msg = '';
  if (!fits && !confirm('The edited sample needs ' + bytes.length + ' bytes but the original used ' + AU.srcBytes + '. Writing will overwrite ' + (bytes.length - AU.srcBytes) + ' bytes after it. Continue?')) return;
  write(dest, bytes, 'Write ' + AU.mode.toUpperCase() + ' audio');
  msg = 'Wrote ' + bytes.length + ' bytes at $' + hex(dest, 6) + (AU.mode === 'brr' ? '. If you moved or lengthened it, update the game\'s sample directory.' : '');
  toast(msg, 5000); AU.off = dest; AU.srcBytes = bytes.length; if (AU.mode !== 'raw') AU.len = bytes.length; refreshAudioInfo();
}
function crc32(b) { let c, crc = -1; for (let i = 0; i < b.length; i++) { c = (crc ^ b[i]) & 255; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ -1) >>> 0; }
function makeZip(files) {
  const parts = [], cen = []; let off = 0;
  for (const f of files) { const name = new TextEncoder().encode(f.name), crc = crc32(f.data), lh = new Uint8Array(30 + name.length), dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint32(14, crc, true); dv.setUint32(18, f.data.length, true); dv.setUint32(22, f.data.length, true); dv.setUint16(26, name.length, true); lh.set(name, 30); parts.push(lh, f.data);
    const ch = new Uint8Array(46 + name.length), cv = new DataView(ch.buffer); cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint32(16, crc, true); cv.setUint32(20, f.data.length, true); cv.setUint32(24, f.data.length, true); cv.setUint16(28, name.length, true); cv.setUint32(42, off, true); ch.set(name, 46); cen.push(ch); off += lh.length + f.data.length; }
  const cs = cen.reduce((n, c) => n + c.length, 0), end = new Uint8Array(22), ev = new DataView(end.buffer); ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, cs, true); ev.setUint32(16, off, true);
  return new Blob([...parts, ...cen, end], { type: 'application/zip' });
}
function buildAudio() {
  const el = AU.el; if (!el) return; if (!AU.mode) AU.mode = auModeDefault();
  const brr = AU.mode === 'brr', dp = AU.mode === 'dpcm';
  if (!AU.inited) { AU.inited = true; AU.rate = brr ? 32000 : dp ? Math.round(Au.dpcmRate(AU.dpcmIdx)) : 11025; }
  const num = (id, v, on, w, extra) => h('input', Object.assign({ type: 'number', id, value: v, style: 'width:' + (w || 80) + 'px', onchange: (e) => on(+e.target.value) }, extra || {}));
  const modeSel = h('select', { id: 'aumode', onchange: (e) => { AU.mode = e.target.value; AU.pcm = null; if (AU.mode === 'brr') AU.rate = 32000; else if (AU.mode === 'dpcm') AU.rate = Math.round(Au.dpcmRate(AU.dpcmIdx)); else AU.rate = 11025; buildAudio(); } },
    h('option', { value: 'brr', selected: brr }, 'SNES BRR sample'), h('option', { value: 'dpcm', selected: dp }, 'NES DPCM sample'), h('option', { value: 'raw', selected: AU.mode === 'raw' }, 'Raw PCM (any ROM)'));
  const offIn = h('input', { type: 'text', id: 'auoff', size: 9, value: hex(AU.off, 6), onchange: (e) => { const f = parseLoc(e.target.value); if (f == null) return toast('Not a valid offset'); AU.off = f; AU.dest = f; } });
  const lenIn = h('input', { type: 'number', id: 'aulen', value: AU.len || (dp ? 1025 : 8192), min: 1, style: 'width:90px', onchange: (e) => { AU.len = Math.max(1, +e.target.value | 0); } });
  const rateIn = dp ? h('select', { id: 'aurate', onchange: (e) => { AU.dpcmIdx = +e.target.value; AU.rate = Math.round(Au.dpcmRate(AU.dpcmIdx)); refreshAudioInfo(); } }, Au.DPCM_PERIODS.map((p, i) => h('option', { value: i, selected: i === AU.dpcmIdx }, i + ' · ' + Math.round(Au.dpcmRate(i)) + ' Hz')))
    : num('aurate', AU.rate, (v) => { AU.rate = Math.max(1000, Math.min(96000, v | 0 || 32000)); refreshAudioInfo(); }, 80);
  const fmtSel = AU.mode === 'raw' ? h('select', { id: 'aufmt', onchange: (e) => { AU.rawFmt = e.target.value; } }, [['s16', '16-bit signed LE'], ['s8', '8-bit signed'], ['u8', '8-bit unsigned']].map(([v, t]) => h('option', { value: v, selected: v === AU.rawFmt }, t))) : null;
  const scanBox = h('div', { class: 'list', id: 'auscan', style: 'display:' + (AU.scan.length ? 'block' : 'none') + ';max-height:230px;margin-top:6px' });
  const fillScan = () => {
    scanBox.style.display = 'block';
    scanBox.replaceChildren(h('table', {}, h('tr', {}, h('th', {}, 'File'), h('th', {}, 'Where'), h('th', {}, 'Blocks'), h('th', {}, 'Length @32k'), h('th', {}, 'Loop'), h('th', {}, 'Smooth'), h('th', {}, '')), AU.scan.slice(0, 300).map((r) => h('tr', { class: 'hit' }, h('td', { class: 'mono' }, '$' + hex(r.off, 6)), h('td', { class: 'mono' }, fmtSnes(r.off)), h('td', {}, r.blocks), h('td', {}, (r.blocks * 16 / 32000).toFixed(2) + ' s'), h('td', {}, r.loop ? 'yes' : ''), h('td', {}, Math.round(r.score * 100) + '%'),
      h('td', {}, h('button', { class: 'small', onclick: () => { AU.off = r.off; AU.dest = r.off; auLoadFromRom(); auPlay(); } }, 'Load + play'))))), AU.scan.length > 300 ? h('p', { class: 'muted' }, 'Showing the first 300 of ' + AU.scan.length) : null);
  };
  const scanBtn = brr ? h('button', { id: 'auscanbtn', onclick: () => { setStatus('Scanning for BRR samples…'); setTimeout(() => { AU.scan = Au.scanBrr(S.rom, { minBlocks: +$('#aumin', AU.el).value || 24 }); fillScan(); setStatus('Found ' + AU.scan.length + ' BRR candidates'); }, 20); } }, 'Scan ROM for samples') : null;
  const zipBtn = brr ? h('button', { id: 'auzip', onclick: () => { if (!AU.scan.length) return toast('Scan first'); const files = []; for (const r of AU.scan.slice(0, 400)) { const d = Au.brrDecode(S.rom, r.off); const nm = 'sample_' + hex(r.off, 6); files.push({ name: nm + '.wav', data: Au.writeWav(d.pcm, 32000, null) }); const raw = S.rom.slice(r.off, r.off + r.bytes), brrf = new Uint8Array(raw.length + 2); brrf.set(raw, 2); files.push({ name: nm + '.brr', data: brrf }); } download(makeZip(files), baseName() + '_samples.zip'); toast('Exported ' + files.length / 2 + ' samples (WAV + BRR)'); } }, 'Export all found (zip)') : null;
  const speed = h('input', { type: 'range', id: 'auspeed', min: 25, max: 200, value: AU.speed * 100, style: 'width:120px', oninput: (e) => { AU.speed = e.target.value / 100; if (AU.src) AU.src.playbackRate.value = AU.speed; $('#auspeedv', AU.el).textContent = Math.round(AU.speed * 100) + '%'; } });
  const wave = h('canvas', { id: 'wave', width: 860, height: 140, style: 'width:100%;max-width:860px;height:140px;border:1px solid var(--line);border-radius:6px;cursor:crosshair' });
  let dragging = null;
  const sx = (e) => { const r = wave.getBoundingClientRect(); return Math.max(0, Math.min(AU.pcm.length, Math.round((e.clientX - r.left) / r.width * AU.pcm.length))); };
  wave.addEventListener('pointerdown', (e) => { if (!AU.pcm) return; dragging = sx(e); wave.setPointerCapture(e.pointerId); AU.sel = null; drawWave(); });
  wave.addEventListener('pointermove', (e) => { if (dragging == null) return; const x = sx(e); AU.sel = [Math.min(dragging, x), Math.max(dragging, x)]; drawWave(); });
  wave.addEventListener('pointerup', () => { dragging = null; if (AU.sel && AU.sel[1] - AU.sel[0] < 8) AU.sel = null; drawWave(); refreshAudioInfo(); });
  const btn = (id, label, fn, cls) => h('button', { id, class: cls || '', onclick: fn }, label);
  const g = h('input', { type: 'number', id: 'augain', value: 150, style: 'width:64px' }), fadeN = h('input', { type: 'number', id: 'aufade', value: 800, style: 'width:70px' }), rs = h('input', { type: 'number', id: 'aures', value: 50, style: 'width:64px' });
  const loopIn = brr ? h('input', { type: 'number', id: 'auloop', min: -1, value: AU.loopBlock, style: 'width:64px', onchange: (e) => { AU.loopBlock = Math.max(-1, Math.min(Math.ceil((AU.pcm ? AU.pcm.length : 0) / 16) - 1, +e.target.value | 0)); drawWave(); } }) : null;
  const destIn = h('input', { type: 'text', id: 'audest', size: 9, value: hex(AU.dest == null ? AU.off : AU.dest, 6), onchange: (e) => { const f = parseLoc(e.target.value); if (f != null) AU.dest = f; else toast('Not a valid offset'); } });
  el.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Audio extraction and editing'),
    h('p', { class: 'muted', style: 'font-size:12px;margin-top:0' }, brr ? 'SNES samples are BRR blocks (9 bytes = 16 samples). Music sequences and the sample directory live in game-specific SPC700 data and are not parsed; this tool extracts, edits and re-encodes the samples themselves.' : dp ? 'NES DMC samples are 1-bit delta streams, usually near $C000-$FFFF. NES music is code-driven and not parsed here; this tool handles the sample data.' : 'Reads any ROM region as uncompressed PCM.'),
    h('div', { class: 'row' }, h('label', {}, 'Type'), modeSel, h('label', {}, 'Offset'), offIn, !brr ? h('label', {}, 'Bytes') : null, !brr ? lenIn : null, fmtSel, h('label', {}, dp ? 'Rate' : 'Rate Hz'), rateIn, btn('auload', 'Load from ROM', auLoadFromRom, 'primary')),
    brr ? h('div', { class: 'row' }, scanBtn, h('label', {}, 'min blocks'), h('input', { type: 'number', id: 'aumin', value: 24, min: 4, style: 'width:60px' }), zipBtn, h('span', { class: 'muted' }, 'Heuristic: finds chains of valid BRR blocks that end with an end flag and decode to a smooth waveform.')) : null, scanBox),
    h('div', { class: 'card' }, wave, h('div', { class: 'mono muted', id: 'auinfo', style: 'margin:6px 0;font-size:12px' }),
      h('div', { class: 'row' }, btn('auplay', '▶ Play', auPlay, 'primary'), btn('austop', '■ Stop', auStop), h('label', {}, h('input', { type: 'checkbox', id: 'auloopplay', checked: AU.loopPlay, onchange: (e) => { AU.loopPlay = e.target.checked; } }), ' loop'), h('label', {}, 'Speed'), speed, h('span', { id: 'auspeedv', class: 'muted' }, Math.round(AU.speed * 100) + '%'), h('span', { class: 'muted' }, 'Drag on the waveform to select a range (edits then apply to it).')),
      h('h3', {}, 'Manipulate'),
      h('div', { class: 'row' }, h('label', {}, 'Gain %'), g, btn('augainbtn', 'Apply', () => auEdit('Gain', (p) => Au.gain(p, (+g.value || 100) / 100))), btn('aunorm', 'Normalize', () => auEdit('Normalize', (p) => Au.normalize(p, 30000))), btn('aurev', 'Reverse', () => auEdit('Reverse', Au.reverse)),
        h('label', {}, 'Fade samples'), fadeN, btn('aufadebtn', 'Fade in+out', () => auEdit('Fade', (p) => Au.fade(p, +fadeN.value || 0, +fadeN.value || 0)))),
      h('div', { class: 'row' }, h('label', {}, 'Resample to %'), rs, btn('auresbtn', 'Apply', () => { const r = (+rs.value || 100) / 100; if (r <= 0 || r > 8) return toast('Pick a ratio between 1% and 800%'); auEdit('Resample', (p) => Au.resample(p, r)); }), h('span', { class: 'muted' }, '(shorter = smaller and higher pitched)'),
        btn('autrim', 'Trim to selection', () => { if (!AU.sel) return toast('Select a range first'); auEdit('Trim', (p) => p.slice(AU.sel[0], AU.sel[1])); }), btn('audel', 'Delete selection', () => { if (!AU.sel) return toast('Select a range first'); auEdit('Delete', (p) => { const o = new Int16Array(p.length - (AU.sel[1] - AU.sel[0])); o.set(p.slice(0, AU.sel[0])); o.set(p.slice(AU.sel[1]), AU.sel[0]); return o; }); }),
        btn('auundo', 'Undo edit', () => { const e = AU.hist.pop(); if (!e) return toast('Nothing to undo'); AU.pcm = e.pcm; AU.loopBlock = e.loop; AU.sel = null; drawWave(); refreshAudioInfo(); })),
      brr ? h('div', { class: 'row' }, h('label', { title: 'BRR block where the loop restarts; -1 = one-shot' }, 'Loop starts at block'), loopIn, h('span', { class: 'muted' }, '-1 = no loop. The loop point itself lives in the game\'s sample directory, so keep it in sync there.')) : null),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Import, export, write back'),
      h('div', { class: 'row' }, btn('auwav', 'Export WAV', () => { if (!AU.pcm) return toast('Load a sample first'); download(new Blob([Au.writeWav(AU.pcm, AU.rate, AU.mode === 'brr' && AU.loopBlock >= 0 ? { start: AU.loopBlock * 16 } : null)], { type: 'audio/wav' }), 'audio_' + hex(AU.off, 6) + '.wav'); }),
        brr ? btn('aubrr', 'Export .brr', () => { if (!AU.pcm) return toast('Load a sample first'); const e = Au.brrEncode(AU.pcm, { loopStart: AU.loopBlock >= 0 ? AU.loopBlock * 16 : -1 }), o = new Uint8Array(e.length + 2); const lp = AU.loopBlock >= 0 ? AU.loopBlock * 9 : 0; o[0] = lp & 255; o[1] = lp >> 8; o.set(e, 2); download(new Blob([o]), 'sample_' + hex(AU.off, 6) + '.brr'); }) : null,
        btn('aubin', 'Export raw bytes', () => { if (!AU.srcBytes) return toast('Load a sample first'); download(new Blob([S.rom.slice(AU.off, AU.off + AU.srcBytes)]), 'audio_' + hex(AU.off, 6) + '.bin'); }),
        btn('auimp', 'Import audio file…', () => $('#auimpfile').click()), h('input', { type: 'file', id: 'auimpfile', accept: 'audio/*,.wav,.mp3,.ogg,.flac', hidden: true, onchange: (e) => { if (e.target.files[0]) auImport(e.target.files[0]); e.target.value = ''; } })),
      h('div', { class: 'row' }, h('label', {}, 'Write to offset'), destIn, btn('auwrite', 'Write to ROM', auWrite, 'primary'), h('span', { class: 'muted' }, 'Importing converts to the rate above first. Writing encodes with the codec for the selected type; Ctrl+Z undoes it.'))));
  drawWave(); refreshAudioInfo(); if (AU.scan.length) fillScan();
}

/* =========================================================
   WIRING
   ========================================================= */
function init() {
  const nav = $('#nav');
  for (const t of tabs) { $('#content').append(t.el); nav.append(h('button', { 'data-tab': t.id, onclick: () => showTab(t.id) }, t.title)); }
  nav.append(h('div', { class: 'stat', id: 'navstat' }, 'No project'));
  $('#btnOpen').onclick = () => $('#fileRom').click();
  $('#fileRom').onchange = (e) => { if (e.target.files[0]) openRomFile(e.target.files[0]); e.target.value = ''; };
  $('#btnNew').onclick = newProjectDialog;
  $('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
  $('#btnSave').onclick = saveRom;
  $('#btnIps').onclick = saveIps;
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase(); const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    if ((e.ctrlKey || e.metaKey) && !typing) {
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); } else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) { e.preventDefault(); redo(); } else if (e.key.toLowerCase() === 's') { e.preventDefault(); if (S.rom) saveRom(); }
    }
    if (e.key === 'Escape') closeModal();
  });
  let dragN = 0; const dz = $('#dropzone');
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragN++; dz.style.display = 'flex'; });
  window.addEventListener('dragleave', () => { dragN = Math.max(0, dragN - 1); if (!dragN) dz.style.display = 'none'; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); dragN = 0; dz.style.display = 'none'; const f = e.dataTransfer.files[0]; if (f) openRomFile(f); });
  showTab('overview'); refreshAll();
}
/* =========================================================
   GAME TAB: game identification, support matrix, compression explorer
   ========================================================= */
const Games = Core.Games, Codec = Core.Codec;
const GM = { el: null, game: null, how: '', conf: '', codec: 'lz2be', addr: '', out: null, used: 0, fmt: '3bpp', scanning: false, hits: [], table: [], lastDecoded: null };
function detectGame() {
  GM.game = null; GM.how = ''; GM.conf = '';
  if (!S.rom || isNes()) return;
  const r = Games.identify(S.rom, S.hdr, S.name);
  GM.game = r.game; GM.how = r.how; GM.conf = r.confidence; GM.crc = r.crc;
  if (r.game && r.game.codec) GM.codec = r.game.codec;
}
function gmDecode(addrStr) {
  const f = parseLoc(addrStr); if (f == null) return toast('Enter an address like 0F:8D9F or a hex file offset.');
  try { const r = Codec.decode(S.rom, f, GM.codec); GM.out = r.data; GM.used = r.used; GM.off = f; GM.err = null; }
  catch (e) { GM.out = e.partial && e.partial.length ? e.partial : null; GM.used = 0; GM.off = f; GM.err = e.message; }
  drawGm();
}
function drawGm() {
  const info = $('#gminfo'), cv = $('#gmcanvas'); if (!info) return;
  if (!GM.out) { info.textContent = GM.err ? 'Could not decode: ' + GM.err : 'Nothing decoded yet.'; cv.width = 8; cv.height = 8; return; }
  const ratio = GM.used ? (GM.out.length / GM.used).toFixed(2) : '–';
  info.textContent = (GM.err ? 'Partial output before error (' + GM.err + '): ' : '') + GM.out.length.toLocaleString() + ' bytes' + (GM.used ? ' from ' + GM.used + ' compressed bytes (' + ratio + '×), stream ends at $' + hex(GM.off + GM.used, 6) : '');
  const fmt = GM.fmt, tb = Core.FORMATS[fmt].bytes, n = Math.min(Math.floor(GM.out.length / tb), 1024), cols = 16, rows = Math.max(1, Math.ceil(n / cols)), z = 2;
  cv.width = cols * 8 * z; cv.height = rows * 8 * z; const ctx = cv.getContext('2d'); const img = ctx.createImageData(cols * 8, rows * 8);
  const levels = 1 << Core.FORMATS[fmt].bpp;
  for (let t = 0; t < n; t++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const c = Core.getPixel(GM.out, t * tb, fmt, x, y), v = Math.round(c * 255 / (levels - 1)), i = ((Math.floor(t / cols) * 8 + y) * cols * 8 + (t % cols) * 8 + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  const tmp = document.createElement('canvas'); tmp.width = cols * 8; tmp.height = rows * 8; tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false; ctx.drawImage(tmp, 0, 0, cv.width, cv.height);
}
function gmRecompress(data) {
  if (GM.off == null || !GM.used) return toast('Decode a stream first; it is replaced in place.');
  let enc; try { enc = Codec.encode(data, GM.codec); } catch (e) { return toast(e.message); }
  if (enc.length > GM.used) return toast('The recompressed data is ' + enc.length + ' bytes but only ' + GM.used + ' fit in place (' + (enc.length - GM.used) + ' too many). Edit less, or use Library to relocate.', 5200);
  const pad = new Uint8Array(GM.used); pad.set(enc); for (let i = enc.length; i < GM.used; i++) pad[i] = 0xFF;
  write(GM.off, pad, 'Recompress stream at $' + hex(GM.off, 6)); toast('Wrote ' + enc.length + ' bytes (' + (GM.used - enc.length) + ' spare, filled with $FF).'); gmDecode('$' + hex(GM.off, 6));
}
function gmScan() {
  if (GM.scanning) { GM.scanning = false; return; }
  const a = parseLoc($('#gmscanA').value) || 0, b = parseLoc($('#gmscanB').value) || S.rom.length, minOut = Math.max(16, parseInt($('#gmminout').value, 16) || 0x400);
  GM.scanning = true; GM.hits = []; const codec = GM.codec; let p = a; const btn = $('#gmscanbtn'); btn.textContent = 'Stop';
  const step = () => {
    if (!GM.scanning || codec !== GM.codec) { GM.scanning = false; btn.textContent = 'Scan'; return renderScan(); }
    const end = Math.min(b, p + 0x4000); const hs = Codec.scan(S.rom, codec, { start: p, end, minOut, maxOut: 0x8000, maxIn: 0x3000 });
    for (const x of hs) if (x.ratio >= 1.2) GM.hits.push(x);
    p = hs.length ? Math.max(end, hs[hs.length - 1].off + hs[hs.length - 1].used) : end;
    $('#gmscanstat').textContent = 'Scanning… $' + hex(p, 6) + ' of $' + hex(b, 6) + ' · ' + GM.hits.length + ' candidates';
    if (p >= b || GM.hits.length >= 3000) { GM.scanning = false; btn.textContent = 'Scan'; return renderScan(); }
    setTimeout(step, 0);
  };
  step();
}
function renderScan() {
  const el = $('#gmscanout'); if (!el) return; el.replaceChildren();
  $('#gmscanstat').textContent = GM.hits.length + ' candidate streams (decode cleanly, ≥1.2× compression). Candidates are guesses until you see sensible tiles or data.';
  const rows = GM.hits.slice(0, 400).map((x) => h('tr', { onclick: () => { $('#gmaddr').value = fmtSnes(x.off); gmDecode('$' + hex(x.off, 6)); } }, h('td', null, '$' + hex(x.off, 6)), h('td', null, fmtSnes(x.off)), h('td', null, x.used + ' B'), h('td', null, '0x' + x.out.toString(16)), h('td', null, x.ratio + '×')));
  el.append(h('table', { class: 'tbl' }, h('tr', null, ['File', 'SNES', 'Packed', 'Unpacked', 'Ratio'].map((t) => h('th', null, t))), rows));
}
function gmTable() {
  const g = (id) => parseLoc($('#' + id).value), lo = g('gmtlo'), hi = g('gmthi'), bk = g('gmtbk'), n = Math.max(1, Math.min(512, parseInt($('#gmtn').value, 10) || 1));
  if (lo == null || hi == null || bk == null) return toast('Enter the three table addresses (low, high, bank bytes).');
  GM.table = []; const out = [];
  for (let i = 0; i < n; i++) {
    const a = (S.rom[bk + i] << 16) | (S.rom[hi + i] << 8) | S.rom[lo + i], f = Core.snesToFile(a, S.mapping, S.rom.length); let row = { i, a, f };
    if (f != null) try { const r = Codec.decode(S.rom, f, GM.codec, 0x10000); row.out = r.data.length; row.used = r.used; } catch (e) { row.err = true; }
    out.push(row);
  }
  GM.table = out; const el = $('#gmtout'); el.replaceChildren();
  const okN = out.filter((r) => r.out != null).length;
  el.append(h('div', { class: 'hint' }, okN + ' of ' + out.length + ' entries decoded cleanly with ' + Codec.VARIANTS[GM.codec].name + '.'));
  el.append(h('table', { class: 'tbl' }, h('tr', null, ['#', 'Address', 'Packed', 'Unpacked'].map((t) => h('th', null, t))), out.map((r) => h('tr', { class: r.err || r.f == null ? 'bad' : '', onclick: () => { if (r.f != null) { $('#gmaddr').value = hex(r.a >> 16, 2) + ':' + hex(r.a & 0xFFFF, 4); gmDecode('$' + hex(r.f, 6)); } } }, h('td', null, r.i.toString(16).toUpperCase()), h('td', null, hex(r.a >> 16, 2) + ':' + hex(r.a & 0xFFFF, 4)), h('td', null, r.used != null ? r.used + ' B' : '–'), h('td', null, r.out != null ? '0x' + r.out.toString(16) : 'error')))));
}
function gmCapture() {
  const st = $('#gmcapstat'), btn = $('#gmcapture'); btn.disabled = true; st.textContent = 'Capturing… large ROMs can take up to a minute.';
  setTimeout(() => {
    try {
      const r = Core.Capture.run(S.rom, { mapping: S.mapping, hdr: S.hdr }, GM.game, { scanCodec: !!($('#gmcapcodec') && $('#gmcapcodec').checked) }), p = r.report;
      download(makeZip(r.files), baseName() + '_assets.zip');
      st.textContent = 'Captured ' + r.files.length + ' files: ' + p.palettes + ' palette candidates, ' + p.graphicsRuns + ' graphics regions, ' + p.samples + ' sounds, ' + p.strings + ' text strings' + (p.streams ? ', ' + p.streams + ' decoded streams' : '') + '. Everything is found by heuristics, so check the preview sheets.';
    } catch (e) { st.textContent = 'Capture failed: ' + e.message; }
    btn.disabled = false;
  }, 30);
}
function buildGame() {
  const el = GM.el; el.replaceChildren();
  if (isNes()) return el.append(h('div', { class: 'card' }, h('h2', null, 'Game profiles'), 'The 300 game profiles are for SNES ROMs. The loaded ROM is an NES ROM, so the Hex, Graphics, Palettes, Audio, Text and Code tabs are the tools to use.'));
  const g = GM.game, det = { mapping: S.mapping, hdr: S.hdr };
  const sel = h('select', { id: 'gmpick', onchange: (e) => { const n = +e.target.value; GM.game = n ? Games.LIST.find((x) => x.n === n) : null; GM.how = n ? 'chosen manually' : ''; GM.conf = n ? 'manual' : ''; if (GM.game && GM.game.codec) GM.codec = GM.game.codec; buildGame(); } },
    h('option', { value: 0 }, '— not in the list —'), Games.LIST.map((x) => h('option', { value: x.n, selected: g && g.n === x.n }, x.n + '. ' + x.name)));
  const checks = Games.check(S.rom, det, g);
  const tier = g ? g.codecStatus : 'none';
  el.append(
    h('div', { class: 'card' }, h('h2', null, 'Game profile'),
      h('div', { class: 'hint', id: 'gmdetected' }, g ? 'Detected: ' + g.n + '. ' + g.name + ' — ' + GM.how + (GM.conf === 'exact' ? ' (confidence: exact)' : '') : 'This ROM does not match any of the 300 profiled games. The generic tools still work.'),
      h('div', { class: 'row' }, h('label', { for: 'gmpick' }, 'Profile'), sel),
      h('ul', { class: 'checks' }, checks.map((c) => h('li', { class: c.ok ? 'ok' : 'warn' }, (c.ok ? '✓ ' : '⚠ ') + c.text))),
      g ? h('div', { class: 'note' }, g.notes) : null,
      g ? h('div', { class: 'hint' }, g.mappingVerified ? 'Mapping and size in this profile were measured on a real dump.' : 'No real dump of this game was available, so its mapping and size are expectations only.') : null),
    h('div', { class: 'card' }, h('h2', null, 'What is supported for this game'),
      h('table', { class: 'tbl', id: 'gmmatrix' }, h('tr', null, ['Capability', 'Status'].map((t) => h('th', null, t))),
        [['Open, header, mapping, checksum, save as .sfc/.smc', 'Works for every ROM (checked against all 325 supplied dumps)'],
         ['Hex editing, tile/graphics view and editing, palettes, text scan, 65816 code, audio scan (BRR), Render tab, IPS export', 'Works on the raw data of any game, including this one'],
         ['Compressed graphics/data', g && g.codec ? Games.TIERS[tier] + ' (' + Codec.VARIANTS[g.codec].name + ')' : 'No decoder for this game; raw tools only'],
         ['Enhancement chip', g ? g.chip : '–'],
         ['Game-specific editors (level, enemy, item editors)', 'Not included: these need per-game structure maps that were not available to verify']].map((r) => h('tr', null, h('td', null, r[0]), h('td', null, r[1]))))),
    h('div', { class: 'card' }, h('h2', null, 'Compressed data explorer'),
      h('div', { class: 'hint' }, 'Decode a compressed stream at an address, preview it as tiles, export it, or edit it and write it back (only if the result is no larger than the original).'),
      h('div', { class: 'row' },
        h('label', { for: 'gmcodec' }, 'Codec'), h('select', { id: 'gmcodec', onchange: (e) => { GM.codec = e.target.value; } }, Object.keys(Codec.VARIANTS).map((k) => h('option', { value: k, selected: k === GM.codec }, Codec.VARIANTS[k].name + ' — ' + Codec.VARIANTS[k].games))),
        h('label', { for: 'gmaddr' }, 'Address'), h('input', { type: 'text', id: 'gmaddr', size: 10, value: GM.addr, placeholder: '0F:8D9F', onchange: (e) => { GM.addr = e.target.value; } }),
        h('button', { id: 'gmdecode', onclick: () => gmDecode($('#gmaddr').value) }, 'Decode'),
        h('label', { for: 'gmfmt' }, 'View as'), h('select', { id: 'gmfmt', onchange: (e) => { GM.fmt = e.target.value; drawGm(); } }, ['2bpp', '3bpp', '4bpp', '8bpp'].map((k) => h('option', { value: k, selected: k === GM.fmt }, k)))),
      h('div', { class: 'hint', id: 'gminfo' }, 'Nothing decoded yet.'),
      h('canvas', { id: 'gmcanvas', class: 'pix' }),
      h('div', { class: 'row' },
        h('button', { id: 'gmexport', onclick: () => { if (!GM.out) return toast('Decode something first.'); download(new Blob([GM.out]), 'decoded_' + hex(GM.off, 6) + '.bin'); } }, 'Export decoded .bin'),
        h('button', { id: 'gmwrite', onclick: () => { if (!GM.out) return toast('Decode something first.'); gmRecompress(GM.out); } }, 'Recompress & write back'),
        h('label', { class: 'btn' }, 'Import .bin and write back', h('input', { type: 'file', id: 'gmimport', style: 'display:none', onchange: (e) => { const f = e.target.files[0]; if (!f) return; f.arrayBuffer().then((b) => { gmRecompress(new Uint8Array(b)); }); e.target.value = ''; } })))),
    h('div', { class: 'card' }, h('h2', null, 'Capture assets'),
      h('div', { class: 'hint' }, 'Pulls everything the studio can recognise into one .zip: palettes (JSON and swatch picture), the largest graphics regions as raw files and preview sheets, BRR sounds as .wav, readable text, the header and the first instructions at the reset vector.' + (g && g.n === 1 ? ' For Super Mario World it also decodes all 50 compressed graphics files.' : '')),
      h('div', { class: 'row' }, h('label', null, h('input', { type: 'checkbox', id: 'gmcapcodec', disabled: !(g && g.codec && g.n !== 1) }), ' Also decode candidate compressed streams (slow, unconfirmed)'), h('button', { id: 'gmcapture', onclick: gmCapture }, 'Capture assets (.zip)')),
      h('div', { class: 'hint', id: 'gmcapstat' })),
    h('div', { class: 'card' }, h('h2', null, 'Pointer table'),
      h('div', { class: 'hint' }, 'Games like Super Mario World store pointers as three parallel byte tables (low, high, bank). The preset below was verified on a real Super Mario World dump: all 50 entries decode.'),
      h('div', { class: 'row' },
        h('label', null, 'Low'), h('input', { type: 'text', id: 'gmtlo', size: 9, placeholder: '00:B992' }), h('label', null, 'High'), h('input', { type: 'text', id: 'gmthi', size: 9, placeholder: '00:B9C4' }), h('label', null, 'Bank'), h('input', { type: 'text', id: 'gmtbk', size: 9, placeholder: '00:B9F6' }),
        h('label', null, 'Count'), h('input', { type: 'text', id: 'gmtn', size: 4, value: '50' }),
        h('button', { id: 'gmtpreset', onclick: () => { GM.codec = 'lz2be'; $('#gmcodec').value = 'lz2be'; $('#gmtlo').value = '00:B992'; $('#gmthi').value = '00:B9C4'; $('#gmtbk').value = '00:B9F6'; $('#gmtn').value = '50'; gmTable(); } }, 'Super Mario World GFX preset'),
        h('button', { id: 'gmtgo', onclick: gmTable }, 'Read table')),
      h('div', { id: 'gmtout' })),
    h('div', { class: 'card' }, h('h2', null, 'Scan for compressed streams'),
      h('div', { class: 'hint' }, 'Tries the selected codec at every offset and lists places that decode cleanly. This is how the studio finds data for games without a known pointer table; a candidate is only a guess until the decoded tiles look right.'),
      h('div', { class: 'row' }, h('label', null, 'From'), h('input', { type: 'text', id: 'gmscanA', size: 8, value: '0' }), h('label', null, 'To'), h('input', { type: 'text', id: 'gmscanB', size: 8, value: S.rom.length.toString(16) }), h('label', null, 'Min size (hex)'), h('input', { type: 'text', id: 'gmminout', size: 5, value: '400' }), h('button', { id: 'gmscanbtn', onclick: gmScan }, 'Scan')),
      h('div', { class: 'hint', id: 'gmscanstat' }),
      h('div', { id: 'gmscanout', class: 'scroll' })));
  if (GM.hits.length) renderScan();
  drawGm();
}
defineTab('game', 'Game', (el) => { GM.el = el; }, () => { if (GM.rebuild !== S.rom) { GM.rebuild = S.rom; detectGame(); GM.out = null; GM.hits = []; } buildGame(); }, true);
/* =========================================================
   GUIDE TAB: 50 steps to make your own game (works without a ROM)
   ========================================================= */
const GD = { n: 1, answers: {}, el: null, loaded: false };
const gdKey = 'snes-studio-guide-v1';
function gdLoad() { if (GD.loaded) return; GD.loaded = true; try { const v = JSON.parse(localStorage.getItem(gdKey) || '{}'); if (v.answers) { GD.answers = v.answers; GD.n = v.n || 1; } } catch (e) { /* storage unavailable */ } }
function gdSave() { try { localStorage.setItem(gdKey, JSON.stringify({ answers: GD.answers, n: GD.n })); } catch (e) { /* storage unavailable: answers stay in memory */ } }
function gdDone() { return Core.Guide.STEPS.filter((s) => GD.answers[s.n] && GD.answers[s.n].done).length; }
function gdAction(a) {
  if (a.tab === 'open') return $('#fileRom').click();
  if (a.tab === 'new') return newProjectDialog();
  const t = tabs.find((x) => x.id === a.tab); if (!t) return;
  if (t.needsRom && !S.rom) return toast('This step needs a ROM first: use step 12 or 13 to open one or start a new project.', 4200);
  showTab(a.tab);
}
function buildGuide() {
  gdLoad(); const el = GD.el, Gd = Core.Guide, step = Gd.STEPS[GD.n - 1], ans = GD.answers[step.n] || {}, done = gdDone();
  el.replaceChildren();
  const list = h('div', { class: 'gdlist', id: 'gdlist' });
  Gd.PHASES.forEach((ph, pi) => {
    list.append(h('div', { class: 'gdphase' }, (pi + 1) + '. ' + ph));
    for (const s of Gd.STEPS) if (s.phase === pi) list.append(h('button', { class: 'gdstep' + (s.n === GD.n ? ' active' : '') + (GD.answers[s.n] && GD.answers[s.n].done ? ' done' : ''), 'data-step': s.n, onclick: () => { GD.n = s.n; gdSave(); buildGuide(); } }, h('span', { class: 'gdnum' }, String(s.n)), s.title));
  });
  const ta = h('textarea', { id: 'gdtext', rows: 6, placeholder: 'Type your answer here. It is saved in this browser and goes into your design notes.', oninput: (e) => { (GD.answers[step.n] = GD.answers[step.n] || {}).text = e.target.value; gdSave(); } }); ta.value = ans.text || '';
  const move = (d) => { GD.n = Math.max(1, Math.min(50, GD.n + d)); gdSave(); buildGuide(); };
  const detail = h('div', { class: 'gddetail' },
    h('div', { class: 'gdmeta' }, 'Phase ' + (step.phase + 1) + ' of 5: ' + Gd.PHASES[step.phase] + ' · Step ' + step.n + ' of 50'),
    h('h2', { id: 'gdtitle' }, step.title),
    h('p', { class: 'gdwhy' }, step.why),
    h('div', { class: 'note', id: 'gdprompt' }, h('b', null, 'Your prompt: '), step.prompt),
    ta,
    h('div', { class: 'row' },
      step.action ? h('button', { id: 'gdaction', class: 'primary', onclick: () => gdAction(step.action) }, step.action.label) : null,
      h('button', { id: 'gdcopy', onclick: () => { copyText(Gd.aiPrompt(step, GD.answers)); } }, 'Copy a prompt for an AI helper'),
      h('label', { class: 'gdcheck' }, h('input', { type: 'checkbox', id: 'gddone', checked: !!ans.done, onchange: (e) => { (GD.answers[step.n] = GD.answers[step.n] || {}).done = e.target.checked; gdSave(); buildGuide(); } }), ' Mark this step done')),
    h('div', { class: 'row' }, h('button', { id: 'gdprev', disabled: GD.n === 1, onclick: () => move(-1) }, '← Previous'), h('button', { id: 'gdnext', disabled: GD.n === 50, onclick: () => move(1) }, 'Next →'),
      h('button', { id: 'gdnextopen', onclick: () => { const nx = Gd.STEPS.find((s) => !(GD.answers[s.n] && GD.answers[s.n].done)); if (nx) { GD.n = nx.n; gdSave(); buildGuide(); } else toast('All 50 steps are done. Well done!'); } }, 'Jump to next unfinished step')));
  el.append(h('div', { class: 'card' }, h('h2', null, 'Make your own game in 50 steps'),
    h('div', { class: 'hint' }, 'Each step explains one idea in plain language and asks you a question. Your answers become a design document you can save. You can do the steps in order, or jump around. Nothing here needs a ROM until the art and code steps.'),
    h('div', { class: 'gdprog' }, h('div', { class: 'gdbar' }, h('div', { id: 'gdfill', style: 'width:' + (done * 2) + '%' })), h('span', { id: 'gdcount' }, done + ' of 50 steps done')),
    h('div', { class: 'row' }, h('button', { id: 'gdexport', onclick: () => download(new Blob([Gd.brief(GD.answers)], { type: 'text/markdown' }), 'my_game_design_notes.md') }, 'Save my design notes (.md)'),
      h('button', { id: 'gdreset', onclick: () => { if (confirm('Clear all your answers and progress?')) { GD.answers = {}; GD.n = 1; gdSave(); buildGuide(); } } }, 'Start over'))),
    h('div', { class: 'gdwrap' }, list, detail));
}
defineTab('guide', 'Make a Game', (el) => { GD.el = el; buildGuide(); }, null, false);
/* =========================================================
   3D REBUILD TAB
   ========================================================= */
const G3 = Core.Game3D;
const R3 = { mode: 'side', el: null, src: [], si: 0, fmt: '4bpp', pals: [], pi: 0, gray: false, picks: null, role: 'wall', page: 0, title: '', levels: 3, maze: 4, enemies: 3, seed: 12345, music: null, musicList: [], musicOn: false, key: null };
const r3Platform = () => (isNes() ? 'nes' : 'snes');
const r3Src = () => R3.src[R3.si] || null;
function r3Pal() { const p = R3.pals[R3.pi]; return G3.palette(S.rom, r3Platform(), R3.fmt, R3.gray || !p ? null : p.off, 0); }
function r3Init() {
  if (S.rom && !isNes()) detectGame();
  R3.key = S.rom; R3.src = []; R3.si = 0; R3.pals = []; R3.pi = 0; R3.picks = null; R3.page = 0; R3.music = null; R3.musicList = []; R3.musicOn = false;
  R3.title = isNes() ? 'MY NES 3D' : (Core.readHeader(S.rom, S.hdr).title || 'MY 3D GAME');
  R3.pals = isNes() ? NES.scanPalettes(S.rom, S.nes, 60) : Core.scanPalettes(S.rom, 400);
  R3.src = G3.findSources(S.rom, r3Platform(), S.nes, GM.game, { mapping: S.mapping });
  if (!R3.src.length) { R3.src = [{ label: 'ROM start (nothing graphics-like found; pick an offset in the Graphics tab)', data: S.rom, off: 0, fmt: isNes() ? 'nes2bpp' : '4bpp', score: 0 }]; }
  r3UseSource(0);
}
function r3UseSource(i) {
  R3.si = i; const s = r3Src(); R3.fmt = s.fmt; R3.picks = G3.autoPicks(s.data, s.off, isNes() ? 'nes2bpp' : s.fmt);
  const best = G3.bestPalette(S.rom, r3Platform(), R3.pals.slice(0, 120), s.data, s.off, s.fmt, R3.picks); const k = R3.pals.findIndex((p) => p.off === best); R3.pi = k >= 0 ? k : 0; R3.page = 0;
}
function r3Block(role, zoom) {
  const s = r3Src(), fmt = isNes() ? 'nes2bpp' : R3.fmt, pal = r3Pal(), px = G3.blockPixels(s.data, s.off + R3.picks[role] * Core.FORMATS[fmt].bytes, fmt, 16), c = document.createElement('canvas'); c.width = c.height = 16 * zoom; const x = c.getContext('2d'); const id = x.createImageData(16, 16);
  for (let i = 0; i < 256; i++) { const col = pal[px[i]] || [255, 0, 255], transp = (role === 'gem' || role === 'enemy' || role === 'exit') && px[i] === 0; id.data[i * 4] = col[0]; id.data[i * 4 + 1] = col[1]; id.data[i * 4 + 2] = col[2]; id.data[i * 4 + 3] = transp ? 0 : 255; }
  const t = document.createElement('canvas'); t.width = t.height = 16; t.getContext('2d').putImageData(id, 0, 0); x.imageSmoothingEnabled = false; x.drawImage(t, 0, 0, 16 * zoom, 16 * zoom); return c;
}
function r3Draw() {
  const s = r3Src(); if (!s) return; const fmt = isNes() ? 'nes2bpp' : R3.fmt, tb = Core.FORMATS[fmt].bytes, pal = r3Pal(), cv = $('#r3atlas'); if (!cv) return;
  const z = 3, cols = 16, rows = 16; cv.width = cols * 8 * z; cv.height = rows * 8 * z; const id = new ImageData(cols * 8, rows * 8);
  for (let t = 0; t < 256; t++) { const ti = R3.page * 256 + t, off = s.off + ti * tb; if (off + tb > s.data.length) continue; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const c = pal[Core.getPixel(s.data, off, fmt, x, y)] || [255, 0, 255], i = (((t >> 4) * 8 + y) * cols * 8 + (t & 15) * 8 + x) * 4; id.data[i] = c[0]; id.data[i + 1] = c[1]; id.data[i + 2] = c[2]; id.data[i + 3] = 255; } }
  const tmp = document.createElement('canvas'); tmp.width = cols * 8; tmp.height = rows * 8; tmp.getContext('2d').putImageData(id, 0, 0); const cx = cv.getContext('2d'); cx.imageSmoothingEnabled = false; cx.drawImage(tmp, 0, 0, cv.width, cv.height);
  const pk = R3.picks[R3.role] - R3.page * 256; if (pk >= 0 && pk < 256) { cx.strokeStyle = '#4cc2ff'; cx.lineWidth = 2; cx.strokeRect((pk & 15) * 8 * z, (pk >> 4) * 8 * z, 16 * z, 16 * z); }
  for (const [role] of G3.ROLES) { const slot = $('#r3slot-' + role); if (slot) { slot.replaceChildren(r3Block(role, 3)); slot.classList.toggle('active', role === R3.role); const inp = $('#r3idx-' + role); if (inp && document.activeElement !== inp) inp.value = R3.picks[role]; } }
  const pc = $('#r3pal'); if (pc) { pc.width = 16 * 12; pc.height = 12; const px = pc.getContext('2d'); pal.forEach((c, i) => { px.fillStyle = rgb(c); px.fillRect(i * 12, 0, 12, 12); }); }
  $('#r3palinfo').textContent = R3.gray || !R3.pals.length ? 'Greyscale' : 'Palette ' + (R3.pi + 1) + ' of ' + R3.pals.length + ' at $' + hex(R3.pals[R3.pi].off, 6);
  $('#r3page').textContent = 'Tiles ' + R3.page * 256 + '–' + (R3.page * 256 + 255);
}
function r3Config() {
  const s = r3Src(), fmt = isNes() ? 'nes2bpp' : R3.fmt, p = R3.pals[R3.pi];
  return G3.makeConfig(S.rom, { platform: r3Platform(), fmt: isNes() ? '4bpp' : R3.fmt, data: s.data, off: s.off, palOff: R3.gray || !p ? null : p.off, palSub: 0, picks: R3.picks, size: 16, title: R3.title, mode: R3.mode, music: R3.musicOn ? R3.music : null, levels: R3.levels, mazeSize: R3.maze, enemies: R3.enemies, seed: R3.seed });
}
function r3Html() { return G3.buildHtml(r3Config()); }
function r3Launch() {
  const html = r3Html(), box = $('#modalBox'); box.style.width = 'min(980px,96vw)';
  const fr = h('iframe', { id: 'r3frame', style: 'width:100%;height:min(76vh,720px);border:1px solid var(--line);border-radius:8px;background:#000', allow: 'autoplay; fullscreen' }); fr.srcdoc = html;
  box.replaceChildren(h('div', { class: 'row' }, h('b', null, R3.title + (R3.mode === 'maze' ? ' (3D)' : ' (2.5D)')), h('span', { class: 'hint' }, 'Press Enter to start. Keys are shown on the title screen.'), h('button', { id: 'r3close', onclick: () => { box.style.width = ''; closeModal(); box.replaceChildren(); } }, 'Close')), fr);
  $('#modal').classList.add('open'); setTimeout(() => { try { fr.contentWindow.focus(); } catch (e) { /* ignore */ } }, 300);
}
function r3FindMusic() {
  const st = $('#r3musicstat'); st.textContent = 'Scanning for sounds…'; setTimeout(() => {
    const hits = Core.Audio.scanBrr(S.rom, {}).sort((a, b) => b.bytes - a.bytes).slice(0, 40); R3.musicList = hits; const sel = $('#r3music'); sel.replaceChildren(h('option', { value: '' }, '— none —'), ...hits.map((x, i) => h('option', { value: i }, '$' + hex(x.off, 6) + ' · ' + (x.bytes / 9 * 16 / 32000).toFixed(1) + ' s' + (x.loop ? ' · loops' : ''))));
    st.textContent = hits.length ? hits.length + ' sounds found. Longest first. A looping sound makes the best music.' : 'No BRR sounds found (this ROM may store audio compressed or in another format).';
  }, 30);
}
function buildR3() {
  const el = R3.el; el.replaceChildren();
  if (R3.key !== S.rom) r3Init();
  const nes = isNes(), game = GM.game;
  const srcSel = h('select', { id: 'r3src', onchange: (e) => { r3UseSource(+e.target.value); buildR3(); } }, R3.src.map((s, i) => h('option', { value: i, selected: i === R3.si }, s.label + ' · ' + s.fmt + (s.score ? ' · ' + Math.round(s.score * 100) + '%' : ''))));
  const num = (id, label, val, min, max, on) => [h('label', { for: id }, label), h('input', { type: 'number', id, min, max, value: val, style: 'width:70px', onchange: (e) => { on(Math.max(min, Math.min(max, +e.target.value | 0))); } })];
  el.append(
    h('div', { class: 'card' }, h('h2', null, 'Rebuild as a 2.5D or 3D game'),
      h('div', { class: 'hint' }, 'This builds a new game out of this ROM’s own art and sound and gives you one .html file that runs in any browser. 2.5D side view: a scrolling platformer with layered parallax backgrounds, extruded 3D blocks, glow and scanlines. 3D maze: a first-person maze. Neither converts the original game’s rules or levels, and neither is a .sfc/.nes: a console cannot run this kind of game. The ROM stays as it is.'),
      h('div', { class: 'row' }, h('label', { for: 'r3mode' }, 'Style'), h('select', { id: 'r3mode', onchange: (e) => { R3.mode = e.target.value; } }, h('option', { value: 'side', selected: R3.mode === 'side' }, '2.5D side view (platformer)'), h('option', { value: 'maze', selected: R3.mode === 'maze' }, '3D first-person maze'))),
      h('div', { class: 'row' }, h('label', { for: 'r3src' }, 'Art from'), srcSel),
      h('div', { class: 'row' }, nes ? null : [h('label', { for: 'r3fmt' }, 'Colour depth'), h('select', { id: 'r3fmt', onchange: (e) => { R3.fmt = e.target.value; r3Draw(); } }, ['2bpp', '3bpp', '4bpp'].map((k) => h('option', { value: k, selected: k === R3.fmt }, k)))],
        h('button', { id: 'r3pprev', onclick: () => { R3.gray = false; R3.pi = (R3.pi + R3.pals.length - 1) % Math.max(1, R3.pals.length); r3Draw(); } }, '◀ Palette'), h('button', { id: 'r3pnext', onclick: () => { R3.gray = false; R3.pi = (R3.pi + 1) % Math.max(1, R3.pals.length); r3Draw(); } }, 'Palette ▶'),
        h('label', null, h('input', { type: 'checkbox', id: 'r3gray', checked: R3.gray, onchange: (e) => { R3.gray = e.target.checked; r3Draw(); } }), ' Greyscale'), h('canvas', { id: 'r3pal', style: 'image-rendering:pixelated;border:1px solid var(--line)' }), h('span', { class: 'hint', id: 'r3palinfo' })),
      !nes && game && game.codec && game.n !== 1 ? h('div', { class: 'row' }, h('button', { id: 'r3scan', onclick: () => { const b = $('#r3scan'); b.disabled = true; b.textContent = 'Scanning…'; setTimeout(() => { const more = G3.findSources(S.rom, 'snes', null, game, { mapping: S.mapping, scanCodec: true }).filter((x) => x.label.indexOf('Compressed') === 0); R3.src = R3.src.concat(more).sort((a, c) => c.score - a.score); R3.si = 0; r3UseSource(0); buildR3(); toast(more.length + ' compressed graphics candidates added (unconfirmed).'); }, 30); } }, 'Also look for compressed graphics (slow, unconfirmed)')) : null),
    h('div', { class: 'card' }, h('h2', null, 'Choose the tiles'),
      h('div', { class: 'hint' }, 'Click a role, then click a tile on the sheet. Each role uses a 16×16 block (that tile plus the three after it). Auto-pick chose a first guess; change anything that looks wrong.'),
      h('div', { class: 'r3roles' }, G3.ROLES.map(([role, label]) => h('div', { class: 'r3role' }, h('div', { class: 'hint' }, label), h('div', { class: 'r3slot', id: 'r3slot-' + role, onclick: () => { R3.role = role; r3Draw(); } }),
        h('input', { type: 'number', id: 'r3idx-' + role, min: 0, max: 4095, value: R3.picks[role], style: 'width:64px', onchange: (e) => { R3.picks[role] = Math.max(0, +e.target.value | 0); R3.role = role; r3Draw(); } })))),
      h('div', { class: 'row' }, h('button', { id: 'r3auto', onclick: () => { r3UseSource(R3.si); buildR3(); } }, 'Auto-pick tiles & palette'), h('button', { id: 'r3pgprev', onclick: () => { R3.page = Math.max(0, R3.page - 1); r3Draw(); } }, '◀'), h('span', { id: 'r3page', class: 'hint' }), h('button', { id: 'r3pgnext', onclick: () => { R3.page++; r3Draw(); } }, '▶')),
      h('canvas', { id: 'r3atlas', class: 'pix', style: 'cursor:crosshair', onclick: (e) => { const cv = e.target, r = cv.getBoundingClientRect(), x = Math.floor((e.clientX - r.left) / r.width * 16), y = Math.floor((e.clientY - r.top) / r.height * 16); R3.picks[R3.role] = R3.page * 256 + y * 16 + x; r3Draw(); } })),
    h('div', { class: 'card' }, h('h2', null, 'Game settings'),
      h('div', { class: 'row' }, h('label', { for: 'r3title' }, 'Title'), h('input', { type: 'text', id: 'r3title', size: 24, maxlength: 24, value: R3.title, onchange: (e) => { R3.title = e.target.value.toUpperCase(); } }),
        num('r3levels', 'Levels', R3.levels, 1, 5, (v) => { R3.levels = v; }), num('r3maze', 'Maze size (maze style)', R3.maze, 3, 8, (v) => { R3.maze = v; }), num('r3enemies', 'Enemies', R3.enemies, 0, 10, (v) => { R3.enemies = v; }), num('r3seed', 'Seed', R3.seed, 1, 99999, (v) => { R3.seed = v; })),
      h('div', { class: 'row' }, h('label', null, h('input', { type: 'checkbox', id: 'r3musicon', checked: R3.musicOn, onchange: (e) => { R3.musicOn = e.target.checked; } }), ' Play a sound from this ROM as music'),
        h('button', { id: 'r3findmusic', onclick: r3FindMusic }, 'Find sounds'), h('select', { id: 'r3music', onchange: (e) => { const i = e.target.value; if (i === '') { R3.music = null; return; } const x = R3.musicList[+i], dec = Core.Audio.brrDecode(S.rom, x.off, x.blocks); R3.music = Core.Audio.writeWav(dec.pcm, 32000, null); R3.musicOn = true; $('#r3musicon').checked = true; } }, h('option', { value: '' }, '— none —')), h('span', { class: 'hint', id: 'r3musicstat' }))),
    h('div', { class: 'card' }, h('h2', null, 'Launch or download'),
      h('div', { class: 'row' }, h('button', { id: 'r3launch', class: 'primary', onclick: r3Launch }, 'Launch game now'), h('button', { id: 'r3download', onclick: () => download(new Blob([r3Html()], { type: 'text/html' }), baseName() + (R3.mode === 'maze' ? '_3d.html' : '_2_5d.html')) }, 'Download game (.html)')),
      h('div', { class: 'hint' }, 'The downloaded file is self-contained: double-click it to play, or open it in any browser or on any device. It contains art taken from the ROM, so keep it for personal use and do not share it publicly.')));
  r3Draw();
}
defineTab('rebuild3d', '3D Rebuild', (el) => { R3.el = el; }, () => { buildR3(); }, true);
// tab order
tabs.sort((a, b) => ['overview', 'guide', 'game', 'rebuild3d', 'hex', 'gfx', 'scene', 'pal', 'audio', 'text', 'code', 'lib', 'export'].indexOf(a.id) - ['overview', 'guide', 'game', 'rebuild3d', 'hex', 'gfx', 'scene', 'pal', 'audio', 'text', 'code', 'lib', 'export'].indexOf(b.id));
const TITLES = { overview: 'Overview', guide: 'Make a Game', game: 'Game', rebuild3d: '3D Rebuild', hex: 'Hex', gfx: 'Graphics', scene: 'Render', pal: 'Palettes', audio: 'Audio', text: 'Text', code: 'Code', lib: 'Library', export: 'Export' };
for (const t of tabs) t.title = TITLES[t.id];
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
