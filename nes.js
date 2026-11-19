/* NES support for SNES Studio: iNES parsing, 6502 disassembler/assembler, starter project. Extends SnesCore. */
(function (root) {
'use strict';
const Core = root.SnesCore || (typeof require !== 'undefined' ? require('./core.js') : null);
const hex = Core.hex;
const NES = {};

/* ---------- iNES container ---------- */
NES.MAPPERS = { 0: 'NROM', 1: 'MMC1', 2: 'UxROM', 3: 'CNROM', 4: 'MMC3', 5: 'MMC5', 7: 'AxROM', 9: 'MMC2', 10: 'MMC4', 11: 'Color Dreams', 19: 'Namco 163', 21: 'VRC4', 22: 'VRC2', 23: 'VRC2/4', 24: 'VRC6', 25: 'VRC4', 26: 'VRC6', 34: 'BNROM/NINA-001', 66: 'GxROM', 69: 'Sunsoft FME-7', 71: 'Camerica' };
NES.isNes = (b) => b.length >= 16 && b[0] === 0x4E && b[1] === 0x45 && b[2] === 0x53 && b[3] === 0x1A;
NES.parse = function (d) {
  if (!NES.isNes(d)) return null;
  const nes2 = (d[7] & 0x0C) === 8;
  let prgUnits = d[4], chrUnits = d[5];
  if (nes2) { prgUnits |= (d[9] & 0x0F) << 8; chrUnits |= (d[9] >> 4) << 8; }
  const trainer = (d[6] & 4) ? 512 : 0;
  const prgOff = 16 + trainer, prgSize = prgUnits * 16384, chrOff = prgOff + prgSize, chrSize = chrUnits * 8192;
  const mapper = (d[6] >> 4) | (d[7] & 0xF0) | (nes2 ? (d[8] & 0x0F) << 8 : 0);
  const warn = [];
  if (nes2 && ((d[9] & 0x0F) === 0x0F || (d[9] >> 4) === 0x0F)) warn.push('NES 2.0 exponent-size ROM not supported');
  if (chrOff + chrSize > d.length) warn.push('file is shorter than the header claims');
  return { nes2, trainer: !!trainer, prgOff, prgSize, chrOff, chrSize, chrRam: chrUnits === 0, mapper, mapperName: NES.MAPPERS[mapper] || 'mapper ' + mapper,
    mirror: (d[6] & 8) ? 'four-screen' : (d[6] & 1) ? 'vertical' : 'horizontal', battery: !!(d[6] & 2), warn, total: d.length };
};
NES.setHeader = function (d, o) {
  if (o.mapper !== undefined) { d[6] = (d[6] & 0x0F) | ((o.mapper & 0x0F) << 4); d[7] = (d[7] & 0x0F) | (o.mapper & 0xF0); }
  if (o.mirror !== undefined) d[6] = (d[6] & ~9) | (o.mirror === 'vertical' ? 1 : 0) | (o.mirror === 'four-screen' ? 8 : 0);
  if (o.battery !== undefined) d[6] = o.battery ? d[6] | 2 : d[6] & ~2;
};
NES.makeFile = function (prg, chr, o) {
  o = o || {};
  const d = new Uint8Array(16 + prg.length + chr.length);
  d.set([0x4E, 0x45, 0x53, 0x1A, prg.length >> 14, chr.length >> 13, 0, 0]);
  NES.setHeader(d, { mapper: o.mapper || 0, mirror: o.mirror || 'horizontal', battery: !!o.battery });
  d.set(prg, 16); d.set(chr, 16 + prg.length);
  return d;
};

/* ---------- CPU address <-> file offset ---------- */
// Bank-switched mappers are approximated: the lower window shows the bank you choose, the fixed window shows the last bank.
NES.cpuToFile = function (a, info, bank) {
  if (a < 0x8000 || a > 0xFFFF) return null;
  bank = bank || 0; const m = info.mapper, ps = info.prgSize;
  if (ps === 0) return null;
  let rel;
  if (m === 4) { // MMC3: 8K windows
    const n = ps >> 13, win = (a - 0x8000) >> 13, off = a & 0x1FFF;
    const b = win === 0 ? bank % n : win === 1 ? (bank + 1) % n : win === 2 ? n - 2 : n - 1;
    rel = (b & 0xFFFF) * 0x2000 + off;
  } else if (ps <= 0x8000 && (m === 0 || m === 3 || m === 13 || ps === 0x4000)) rel = ps === 0x4000 ? (a & 0x3FFF) : a - 0x8000;
  else if (m === 7 || m === 34 || m === 66 || m === 11) rel = ((bank * 0x8000) % ps) + (a - 0x8000);
  else { const n = ps >> 14; rel = a < 0xC000 ? ((bank % n) * 0x4000) + (a - 0x8000) : (n - 1) * 0x4000 + (a - 0xC000); }
  rel %= ps; return info.prgOff + rel;
};
NES.fileToCpu = function (f, info) {
  const rel = f - info.prgOff; if (rel < 0 || rel >= info.prgSize) return null;
  if (info.prgSize === 0x4000) return 0xC000 + rel;
  if (info.prgSize === 0x8000) return 0x8000 + rel;
  return (rel >= info.prgSize - 0x4000 ? 0xC000 : 0x8000) + (rel & 0x3FFF);
};
NES.describe = function (f, info) {
  if (f < 16) return 'iNES header';
  if (f >= info.prgOff && f < info.prgOff + info.prgSize) {
    const rel = f - info.prgOff, a = NES.fileToCpu(f, info);
    return 'PRG ' + (info.prgSize > 0x8000 ? 'bank ' + (rel >> 14) + ' ' : '') + '$' + hex(a, 4);
  }
  if (info.chrSize && f >= info.chrOff && f < info.chrOff + info.chrSize) return 'CHR $' + hex(f - info.chrOff, 4) + ' (tile ' + ((f - info.chrOff) >> 4) + ')';
  if (f < info.prgOff) return 'trainer';
  return 'trailing data';
};
NES.vectors = function (d, info) {
  const o = info.prgOff + info.prgSize - 6; if (info.prgSize < 6) return { NMI: 0, RESET: 0, IRQ: 0 };
  return { NMI: d[o] | d[o + 1] << 8, RESET: d[o + 2] | d[o + 3] << 8, IRQ: d[o + 4] | d[o + 5] << 8, at: o };
};

/* ---------- master palette (2C02, commonly used approximation) ---------- */
const PAL_HEX = '626262 001FB2 2404C8 5200B2 730076 800024 730B00 522800 244400 005700 005C00 005324 003C76 000000 000000 000000 ABABAB 0D57FF 4B30FF 8A13FF BC08D6 D21269 C72E00 9D5400 607B00 209800 00A300 009942 007DB4 000000 000000 000000 FFFFFF 53AEFF 9085FF D365FF FF57FF FF5DCF FF7757 FA9E00 BDC700 7AE700 43F611 26EF7E 2CD5F6 4E4E4E 000000 000000 FFFFFF B6E1FF CED1FF E9C3FF FFBCFF FFBDF4 FFC6C3 FFD59A E9E681 CEF481 B6FB9A A9FAC3 A9F0F4 B8B8B8 000000 000000';
NES.PALETTE = PAL_HEX.split(' ').map((h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]);
// Candidate PPU palettes in PRG/CHR: 16 or 32 bytes, every value < $40, and entries 0,4,8,12 equal (shared backdrop colour).
NES.scanPalettes = function (d, info, max) {
  const out = [], end = Math.min(d.length, info.chrSize ? info.chrOff : info.prgOff + info.prgSize);
  for (let o = info.prgOff; o + 16 <= end; o++) {
    let good = true;
    for (let i = 0; i < 16; i++) if (d[o + i] >= 0x40) { good = false; break; }
    if (!good) continue;
    if (!(d[o] === d[o + 4] && d[o] === d[o + 8] && d[o] === d[o + 12])) continue;
    const distinct = new Set(Array.from(d.subarray(o, o + 16))).size;
    if (distinct < 4) continue;
    let score = distinct + (d[o] === 0x0F ? 4 : 0) + (o + 32 <= end && d.subarray(o + 16, o + 32).every((v, i) => v < 0x40 && (i % 4 || v === d[o])) ? 6 : 0);
    out.push({ off: o, score }); o += 15;
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max || 60);
};

/* ---------- 6502 opcode table ---------- */
const MODES = ['imp', 'acc', 'imm', 'zp', 'zpx', 'zpy', 'abs', 'abx', 'aby', 'ind', 'izx', 'izy', 'rel'];
const SIZE = { imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, abs: 3, abx: 3, aby: 3, ind: 3, izx: 2, izy: 2, rel: 2 };
const T = {}; // mnemonic -> {mode: opcode}
const def = (mn, str) => { T[mn] = {}; str.split(' ').forEach((p) => { const [m, o] = p.split(':'); T[mn][m] = parseInt(o, 16); }); };
def('ADC', 'imm:69 zp:65 zpx:75 abs:6D abx:7D aby:79 izx:61 izy:71'); def('AND', 'imm:29 zp:25 zpx:35 abs:2D abx:3D aby:39 izx:21 izy:31');
def('ASL', 'acc:0A zp:06 zpx:16 abs:0E abx:1E'); def('BIT', 'zp:24 abs:2C'); def('BRK', 'imp:00');
def('BPL', 'rel:10'); def('BMI', 'rel:30'); def('BVC', 'rel:50'); def('BVS', 'rel:70'); def('BCC', 'rel:90'); def('BCS', 'rel:B0'); def('BNE', 'rel:D0'); def('BEQ', 'rel:F0');
def('CLC', 'imp:18'); def('CLD', 'imp:D8'); def('CLI', 'imp:58'); def('CLV', 'imp:B8');
def('CMP', 'imm:C9 zp:C5 zpx:D5 abs:CD abx:DD aby:D9 izx:C1 izy:D1'); def('CPX', 'imm:E0 zp:E4 abs:EC'); def('CPY', 'imm:C0 zp:C4 abs:CC');
def('DEC', 'zp:C6 zpx:D6 abs:CE abx:DE'); def('DEX', 'imp:CA'); def('DEY', 'imp:88');
def('EOR', 'imm:49 zp:45 zpx:55 abs:4D abx:5D aby:59 izx:41 izy:51');
def('INC', 'zp:E6 zpx:F6 abs:EE abx:FE'); def('INX', 'imp:E8'); def('INY', 'imp:C8');
def('JMP', 'abs:4C ind:6C'); def('JSR', 'abs:20');
def('LDA', 'imm:A9 zp:A5 zpx:B5 abs:AD abx:BD aby:B9 izx:A1 izy:B1'); def('LDX', 'imm:A2 zp:A6 zpy:B6 abs:AE aby:BE'); def('LDY', 'imm:A0 zp:A4 zpx:B4 abs:AC abx:BC');
def('LSR', 'acc:4A zp:46 zpx:56 abs:4E abx:5E'); def('NOP', 'imp:EA');
def('ORA', 'imm:09 zp:05 zpx:15 abs:0D abx:1D aby:19 izx:01 izy:11');
def('PHA', 'imp:48'); def('PHP', 'imp:08'); def('PLA', 'imp:68'); def('PLP', 'imp:28');
def('ROL', 'acc:2A zp:26 zpx:36 abs:2E abx:3E'); def('ROR', 'acc:6A zp:66 zpx:76 abs:6E abx:7E');
def('RTI', 'imp:40'); def('RTS', 'imp:60');
def('SBC', 'imm:E9 zp:E5 zpx:F5 abs:ED abx:FD aby:F9 izx:E1 izy:F1');
def('SEC', 'imp:38'); def('SED', 'imp:F8'); def('SEI', 'imp:78');
def('STA', 'zp:85 zpx:95 abs:8D abx:9D aby:99 izx:81 izy:91'); def('STX', 'zp:86 zpy:96 abs:8E'); def('STY', 'zp:84 zpx:94 abs:8C');
def('TAX', 'imp:AA'); def('TAY', 'imp:A8'); def('TSX', 'imp:BA'); def('TXA', 'imp:8A'); def('TXS', 'imp:9A'); def('TYA', 'imp:98');
const OP = new Array(256).fill(null);
for (const mn in T) for (const m in T[mn]) OP[T[mn][m]] = { mn, mode: m, len: SIZE[m] };
NES.OPCODES = OP;
const REGS = { 0x2000: 'PPUCTRL', 0x2001: 'PPUMASK', 0x2002: 'PPUSTATUS', 0x2003: 'OAMADDR', 0x2004: 'OAMDATA', 0x2005: 'PPUSCROLL', 0x2006: 'PPUADDR', 0x2007: 'PPUDATA', 0x4014: 'OAMDMA', 0x4015: 'APUSTATUS', 0x4016: 'JOY1', 0x4017: 'JOY2/APUFRAME' };
NES.REGS = REGS;

/* ---------- disassembler ---------- */
// read(addr) returns a byte or -1 when the address is not backed by ROM
NES.disasm = function (read, addr, count) {
  const out = [];
  for (let n = 0; n < count && addr <= 0xFFFF; n++) {
    const b = read(addr); if (b < 0) break;
    const o = OP[b]; const line = { addr, bytes: [b], mn: '.db', opd: '', target: null, len: 1 };
    if (!o) { line.text = '.db $' + hex(b); out.push(line); addr++; continue; }
    const bytes = [b]; let ok = true;
    for (let i = 1; i < o.len; i++) { const v = read(addr + i); if (v < 0) { ok = false; break; } bytes.push(v); }
    if (!ok) break;
    const lo = bytes[1], w = bytes[1] | (bytes[2] << 8), z = (v) => '$' + hex(v, 2), a = (v) => '$' + hex(v, 4);
    let opd = '', target = null, cm = '';
    switch (o.mode) {
      case 'imm': opd = '#' + z(lo); break; case 'zp': opd = z(lo); break; case 'zpx': opd = z(lo) + ',X'; break; case 'zpy': opd = z(lo) + ',Y'; break;
      case 'abs': opd = a(w); target = w; if (REGS[w]) cm = REGS[w]; break; case 'abx': opd = a(w) + ',X'; break; case 'aby': opd = a(w) + ',Y'; break;
      case 'ind': opd = '(' + a(w) + ')'; break; case 'izx': opd = '(' + z(lo) + ',X)'; break; case 'izy': opd = '(' + z(lo) + '),Y'; break;
      case 'acc': opd = 'A'; break;
      case 'rel': { const t = (addr + 2 + (lo < 128 ? lo : lo - 256)) & 0xFFFF; opd = a(t); target = t; break; }
    }
    if ((o.mode === 'abx' || o.mode === 'aby') && REGS[w]) cm = REGS[w];
    if ((o.mode === 'abs' || o.mode === 'abx' || o.mode === 'aby') && REGS[w]) cm = REGS[w];
    if (o.mn !== 'JMP' && o.mn !== 'JSR' && o.mode === 'abs' && !(w >= 0x8000)) { /* data access, no jump target */ target = null; }
    Object.assign(line, { bytes, mn: o.mn, opd, target, len: o.len, text: o.mn + (opd ? ' ' + opd : '') + (cm ? ' ; ' + cm : '') });
    out.push(line); addr += o.len;
  }
  return out;
};

/* ---------- assembler ---------- */
function evalExpr(src, syms) {
  let s = src.trim(), unknown = false;
  const toks = []; const re = /\s*(\$[0-9A-Fa-f]+|%[01]+|0x[0-9A-Fa-f]+|\d+|'.'|[A-Za-z_.][\w.]*|[<>+\-*\/|&^()])/y; let m; re.lastIndex = 0;
  while (re.lastIndex < s.length && (m = re.exec(s))) toks.push(m[1]);
  if (re.lastIndex < s.replace(/\s+$/, '').length) throw new Error('bad expression: ' + src);
  let i = 0;
  const prim = () => {
    const t = toks[i++]; if (t === undefined) throw new Error('bad expression: ' + src);
    if (t === '(') { const v = or(); if (toks[i++] !== ')') throw new Error('missing )'); return v; }
    if (t === '<') return prim() & 255; if (t === '>') return (prim() >> 8) & 255; if (t === '-') return -prim();
    if (t[0] === '$') return parseInt(t.slice(1), 16); if (t[0] === '%') return parseInt(t.slice(1), 2); if (t.startsWith('0x')) return parseInt(t, 16);
    if (/^\d/.test(t)) return parseInt(t, 10); if (t[0] === "'") return t.charCodeAt(1);
    if (t in syms) return syms[t]; unknown = true; return 0;
  };
  const mul = () => { let v = prim(); while (toks[i] === '*' || toks[i] === '/') { const o = toks[i++], r = prim(); v = o === '*' ? v * r : Math.trunc(v / (r || 1)); } return v; };
  const add = () => { let v = mul(); while (toks[i] === '+' || toks[i] === '-') { const o = toks[i++], r = mul(); v = o === '+' ? v + r : v - r; } return v; };
  const or = () => { let v = add(); while (toks[i] === '|' || toks[i] === '&' || toks[i] === '^') { const o = toks[i++], r = add(); v = o === '|' ? v | r : o === '&' ? v & r : v ^ r; } return v; };
  const v = or(); if (i < toks.length) throw new Error('bad expression: ' + src);
  return { v, unknown };
}
NES.assemble = function (text, opts) {
  opts = opts || {}; const errors = [], syms = Object.assign({}, opts.symbols || {}), stmts = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    let line = raw.replace(/;.*$/, '').trim(); if (!line) return; let mt;
    // strip comments only outside of quotes is not needed: ascii strings use ; rarely; keep simple
    while ((mt = /^([A-Za-z_]\w*):\s*/.exec(line))) { stmts.push({ ln: idx + 1, kind: 'label', name: mt[1] }); line = line.slice(mt[0].length); }
    if (!line) return;
    if ((mt = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(line))) { stmts.push({ ln: idx + 1, kind: 'equ', name: mt[1], expr: mt[2] }); return; }
    if (line[0] === '.') { const p = /^(\.\w+)\s*(.*)$/.exec(line); stmts.push({ ln: idx + 1, kind: 'dir', name: p[1].toLowerCase(), arg: p[2] }); return; }
    const p = /^([A-Za-z]{3})\s*(.*)$/.exec(line); if (!p) { errors.push({ ln: idx + 1, msg: 'cannot parse: ' + line }); return; }
    stmts.push({ ln: idx + 1, kind: 'ins', mn: p[1].toUpperCase(), arg: p[2].trim() });
  });
  const modeChoice = new Map(); // stmt -> mode chosen in pass 1 (keeps sizes stable)
  function parseOperand(arg) {
    let m;
    if (!arg) return { mode: 'imp' };
    if (/^a$/i.test(arg)) return { mode: 'acc' };
    if (arg[0] === '#') return { mode: 'imm', e: arg.slice(1) };
    if ((m = /^\(\s*(.+?)\s*,\s*x\s*\)$/i.exec(arg))) return { mode: 'izx', e: m[1] };
    if ((m = /^\(\s*(.+?)\s*\)\s*,\s*y$/i.exec(arg))) return { mode: 'izy', e: m[1] };
    if ((m = /^\(\s*(.+)\s*\)$/.exec(arg))) return { mode: 'ind', e: m[1] };
    if ((m = /^(.+?)\s*,\s*x$/i.exec(arg))) return { mode: 'abx', e: m[1] };
    if ((m = /^(.+?)\s*,\s*y$/i.exec(arg))) return { mode: 'aby', e: m[1] };
    return { mode: 'abs', e: arg };
  }
  function pass(n) {
    const segs = []; let seg = null, pc = opts.org !== undefined ? opts.org : 0x8000;
    const start = () => { seg = { addr: pc, bytes: [] }; segs.push(seg); }; start();
    const emit = (b) => { seg.bytes.push(b & 255); pc++; };
    for (const st of stmts) {
      try {
        if (st.kind === 'label') { syms[st.name] = pc; continue; }
        if (st.kind === 'equ') { syms[st.name] = evalExpr(st.expr, syms).v; continue; }
        if (st.kind === 'dir') {
          const a = st.arg;
          if (st.name === '.org') { pc = evalExpr(a, syms).v; start(); }
          else if (st.name === '.db' || st.name === '.byte') { for (const part of splitArgs(a)) { if (/^".*"$/.test(part)) for (const c of part.slice(1, -1)) emit(c.charCodeAt(0)); else { const r = evalExpr(part, syms); if (n === 2 && r.unknown) throw new Error('undefined symbol in ' + part); emit(r.v); } } }
          else if (st.name === '.dw' || st.name === '.word') { for (const part of splitArgs(a)) { const r = evalExpr(part, syms); if (n === 2 && r.unknown) throw new Error('undefined symbol in ' + part); emit(r.v); emit(r.v >> 8); } }
          else if (st.name === '.ds') { const [c, f] = splitArgs(a); const cnt = evalExpr(c, syms).v, fv = f ? evalExpr(f, syms).v : 0; for (let i = 0; i < cnt; i++) emit(fv); }
          else if (st.name === '.ascii') { const mm = /^"(.*)"$/.exec(a.trim()); if (!mm) throw new Error('.ascii needs "text"'); for (const c of mm[1]) emit(c.charCodeAt(0)); }
          else throw new Error('unknown directive ' + st.name);
          continue;
        }
        const tab = T[st.mn]; if (!tab) throw new Error('unknown instruction ' + st.mn);
        let op = parseOperand(st.arg), mode = op.mode, val = 0, unk = false;
        if (op.e !== undefined) { const r = evalExpr(op.e, syms); val = r.v; unk = r.unknown; }
        if (tab.rel !== undefined) { // branch
          if (mode !== 'abs') throw new Error('bad branch operand');
          const d = val - (pc + 2); if (n === 2 && unk) throw new Error('undefined label');
          if (n === 2 && (d < -128 || d > 127)) throw new Error('branch out of range (' + d + ')');
          emit(tab.rel); emit(d); continue;
        }
        if (mode === 'abs' || mode === 'abx' || mode === 'aby') {
          const zm = mode === 'abs' ? 'zp' : mode === 'abx' ? 'zpx' : 'zpy';
          if (n === 1) { const useZp = tab[zm] !== undefined && !unk && val >= 0 && val < 256; modeChoice.set(st, useZp ? zm : mode); }
          mode = modeChoice.get(st) || mode;
        }
        if (mode === 'acc' && tab.acc === undefined) mode = 'imp';
        if (tab[mode] === undefined) throw new Error(st.mn + ' does not support this addressing mode (' + mode + ')');
        if (n === 2 && unk) throw new Error('undefined symbol in ' + st.arg);
        if (mode === 'imm' && n === 2 && (val > 255 || val < -128)) throw new Error('immediate value does not fit in 8 bits');
        emit(tab[mode]);
        const sz = SIZE[mode]; if (sz >= 2) emit(val); if (sz === 3) emit(val >> 8);
      } catch (e) { if (n === 2) errors.push({ ln: st.ln, msg: e.message }); }
    }
    return segs;
  }
  function splitArgs(a) { const parts = []; let cur = '', q = false; for (const c of a) { if (c === '"') q = !q; if (c === ',' && !q) { parts.push(cur.trim()); cur = ''; } else cur += c; } if (cur.trim()) parts.push(cur.trim()); return parts; }
  pass(1); const segs = pass(2);
  return { segments: segs.filter((s) => s.bytes.length), symbols: syms, errors };
};

/* ---------- starter project ---------- */
NES.starterSource = function () {
  return `; NES starter: NROM-128, 16 KB PRG at $C000 (mirrored at $8000), 8 KB CHR.
; D-pad moves the sprite. Edit tiles in Graphics, colours in Palettes.
PPUCTRL = $2000
PPUMASK = $2001
PPUSTATUS = $2002
OAMADDR = $2003
PPUSCROLL = $2005
PPUADDR = $2006
PPUDATA = $2007
OAMDMA = $4014
JOY1 = $4016
JOY2 = $4017
px = $00        ; sprite X
py = $01        ; sprite Y
pad = $02       ; buttons: A B Sel Start Up Down Left Right (bit7..bit0)

.org $C000
Reset:
    sei
    cld
    ldx #$40
    stx JOY2
    ldx #$FF
    txs
    inx
    stx PPUCTRL
    stx PPUMASK
Wait1:
    bit PPUSTATUS
    bpl Wait1
    lda #$00
    ldx #$00
ClearRam:
    sta $0000,x
    sta $0100,x
    sta $0300,x
    sta $0400,x
    sta $0500,x
    sta $0600,x
    sta $0700,x
    inx
    bne ClearRam
    lda #$FE
    ldx #$00
HideOam:
    sta $0200,x
    inx
    bne HideOam
Wait2:
    bit PPUSTATUS
    bpl Wait2
    ; palettes
    lda PPUSTATUS
    lda #$3F
    sta PPUADDR
    lda #$00
    sta PPUADDR
    ldx #$00
LoadPal:
    lda Palette,x
    sta PPUDATA
    inx
    cpx #$20
    bne LoadPal
    ; background: alternate tile 1 and 2 across the nametable
    lda #$20
    sta PPUADDR
    lda #$00
    sta PPUADDR
    ldy #$04
    ldx #$00
FillNt:
    txa
    and #$01
    clc
    adc #$01
    sta PPUDATA
    inx
    bne FillNt
    dey
    bne FillNt
    ; attribute table back to zero
    lda #$23
    sta PPUADDR
    lda #$C0
    sta PPUADDR
    lda #$00
    ldx #$40
ClearAttr:
    sta PPUDATA
    dex
    bne ClearAttr
    lda #$78
    sta px
    sta py
    lda #$00
    sta PPUSCROLL
    sta PPUSCROLL
    lda #$80
    sta PPUCTRL
    lda #$1E
    sta PPUMASK
Forever:
    jmp Forever

NMI:
    pha
    lda #$00
    sta OAMADDR
    lda #$02
    sta OAMDMA
    ; read controller
    lda #$01
    sta JOY1
    lda #$00
    sta JOY1
    ldx #$08
ReadPad:
    lda JOY1
    lsr a
    rol pad
    dex
    bne ReadPad
    lda pad
    and #$08
    beq NotUp
    dec py
NotUp:
    lda pad
    and #$04
    beq NotDown
    inc py
NotDown:
    lda pad
    and #$02
    beq NotLeft
    dec px
NotLeft:
    lda pad
    and #$01
    beq NotRight
    inc px
NotRight:
    lda py
    sta $0200
    lda #$03
    sta $0201
    lda #$00
    sta $0202
    lda px
    sta $0203
    lda #$00
    sta PPUSCROLL
    sta PPUSCROLL
    pla
    rti

IRQ:
    rti

Palette:
    .db $0F,$30,$10,$00, $0F,$06,$16,$26, $0F,$09,$19,$29, $0F,$02,$12,$22
    .db $0F,$16,$27,$30, $0F,$0A,$1A,$2A, $0F,$01,$11,$21, $0F,$05,$15,$25

.org $FFFA
    .dw NMI, Reset, IRQ
`;
};
function tile(rows) { // rows: 8 strings of digits 0-3 -> 16 bytes
  const b = new Uint8Array(16);
  rows.forEach((r, y) => { for (let x = 0; x < 8; x++) { const c = +r[x]; if (c & 1) b[y] |= 0x80 >> x; if (c & 2) b[8 + y] |= 0x80 >> x; } });
  return b;
}
NES.starterChr = function (sizeKB) {
  const chr = new Uint8Array((sizeKB || 8) * 1024);
  const tiles = [
    ['00000000', '00000000', '00000000', '00000000', '00000000', '00000000', '00000000', '00000000'],
    ['22222222', '21111111', '21111111', '21111111', '22222222', '11121111', '11121111', '11121111'],
    ['33333330', '30000000', '30000000', '30000000', '33333330', '00003000', '00003000', '00003000'],
    ['00111100', '01222210', '12122121', '12222221', '12122121', '12211221', '01222210', '00111100']
  ];
  tiles.forEach((t, i) => chr.set(tile(t), i * 16));
  return chr;
};
NES.buildStarter = function (prgKB, title) {
  prgKB = prgKB || 16; const prg = new Uint8Array(prgKB * 1024);
  const asm = NES.assemble(NES.starterSource(), { org: 0xC000 }); if (asm.errors.length) throw new Error('starter assembly failed: ' + asm.errors[0].msg);
  const info0 = { mapper: 0, prgSize: prg.length, prgOff: 16 };
  for (const s of asm.segments) { const f = NES.cpuToFile(s.addr, info0, 0) - 16; prg.set(s.bytes, f); }
  if (prgKB === 32) { for (let i = 0; i < 0x4000; i++) prg[i] = 0; } // 32K: first half empty; code lives in the upper half via $C000
  const rom = NES.makeFile(prg, NES.starterChr(8), { mapper: 0, mirror: 'horizontal' });
  return { rom, info: NES.parse(rom), symbols: asm.symbols };
};
NES.buildBlank = function (prgKB) {
  prgKB = prgKB || 16; const prg = new Uint8Array(prgKB * 1024);
  const asm = NES.assemble('.org $C000\nReset:\n    sei\n    cld\n    ldx #$FF\n    txs\nLoop:\n    jmp Loop\nNMI:\n    rti\nIRQ:\n    rti\n.org $FFFA\n    .dw NMI, Reset, IRQ\n', { org: 0xC000 });
  const info0 = { mapper: 0, prgSize: prg.length, prgOff: 16 };
  for (const s of asm.segments) prg.set(s.bytes, NES.cpuToFile(s.addr, info0, 0) - 16);
  const rom = NES.makeFile(prg, new Uint8Array(8192), { mapper: 0 });
  return { rom, info: NES.parse(rom), symbols: asm.symbols };
};

Core.NES = NES;
if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof window !== 'undefined' ? window : globalThis);
