/* SNES Studio core: pure logic, no DOM. Works in browsers and in Node (for tests). */
(function (root) {
'use strict';
const Core = {};

/* ---------- small helpers ---------- */
const hex = (n, w) => (n >>> 0).toString(16).toUpperCase().padStart(w || 2, '0');
Core.hex = hex;
Core.isPow2 = (n) => n > 0 && (n & (n - 1)) === 0;
Core.nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

/* ---------- ROM loading, copier header, header detection ---------- */
Core.stripCopierHeader = function (bytes) {
  if (bytes.length % 1024 === 512) return { data: bytes.slice(512), hadHeader: true };
  return { data: bytes.slice(), hadHeader: false };
};

function scoreHeader(d, off, hiRom) {
  if (off + 0x40 > d.length) return -1e9;
  let s = 0;
  const cc = d[off + 0x1C] | (d[off + 0x1D] << 8), ck = d[off + 0x1E] | (d[off + 0x1F] << 8);
  if (((cc + ck) & 0xFFFF) === 0xFFFF) s += 8;
  const map = d[off + 0x15];
  if ((map & 0x10) === 0 && (map & 0xE0) === 0x20) s += 3;
  if (((map & 1) === 1) === hiRom) s += 4;
  let printable = 0;
  for (let i = 0; i < 21; i++) { const c = d[off + i]; if (c >= 32 && c < 127) printable++; }
  s += printable >= 18 ? 4 : printable >= 12 ? 1 : -4;
  const reset = d[off + 0x3C] | (d[off + 0x3D] << 8);
  s += reset >= 0x8000 ? 3 : -6;
  const rs = d[off + 0x17];
  if (rs >= 7 && rs <= 0x0E) s += 1;
  if (d[off + 0x18] <= 8) s += 1;
  return s;
}
Core.detect = function (d) {
  const lo = scoreHeader(d, 0x7FC0, false), hi = scoreHeader(d, 0xFFC0, true);
  const ex = d.length > 0x410000 ? scoreHeader(d, 0x40FFC0, true) : -1e9; // ExHiROM: header sits in the second 4 MB
  if (ex >= 12 && (ex > hi || (d[0x40FFC0 + 0x15] & 0x0F) === 5) && ex > lo) return { mapping: 'ExHiROM', hdr: 0x40FFC0, score: ex };
  if (hi > lo) return { mapping: 'HiROM', hdr: 0xFFC0, score: hi };
  return { mapping: 'LoROM', hdr: 0x7FC0, score: lo };
};
Core.readHeader = function (d, hdr) {
  const g = (o) => d[hdr + o];
  let title = '';
  for (let i = 0; i < 21; i++) { const c = g(i); title += c >= 32 && c < 127 ? String.fromCharCode(c) : '.'; }
  const w = (o) => g(o) | (g(o + 1) << 8);
  return {
    title: title.replace(/\s+$/, ''), mapMode: g(0x15), cartType: g(0x16), romSizeCode: g(0x17), ramSizeCode: g(0x18),
    region: g(0x19), maker: g(0x1A), version: g(0x1B), complement: w(0x1C), checksum: w(0x1E),
    vectors: { COPn: w(0x24), BRKn: w(0x26), ABORTn: w(0x28), NMIn: w(0x2A), IRQn: w(0x2E), COPe: w(0x34), ABORTe: w(0x38), NMIe: w(0x3A), RESET: w(0x3C), IRQe: w(0x3E) }
  };
};
Core.sumBytes = function (d) {
  // Non-power-of-two ROMs are checksummed as if the remainder were mirrored up to fill the next power of two.
  const n = d.length; let p = 1; while (p * 2 <= n) p *= 2;
  const range = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += d[i]; return s; };
  let total = range(0, p);
  if (n > p) { const rem = n - p; let tail = range(p, n), mult = 1; while (rem * mult < p) mult *= 2; total += tail * (p / rem >= 1 && Number.isInteger(p / rem) ? p / rem : mult); }
  return total & 0xFFFF;
};
Core.fixChecksum = function (d, hdr) {
  d[hdr + 0x1C] = 0xFF; d[hdr + 0x1D] = 0xFF; d[hdr + 0x1E] = 0; d[hdr + 0x1F] = 0;
  const sum = Core.sumBytes(d), comp = sum ^ 0xFFFF;
  d[hdr + 0x1C] = comp & 255; d[hdr + 0x1D] = comp >> 8; d[hdr + 0x1E] = sum & 255; d[hdr + 0x1F] = sum >> 8;
  return sum;
};
Core.checksumOk = function (d, hdr) {
  const t = d.slice(); const stored = t[hdr + 0x1E] | (t[hdr + 0x1F] << 8);
  t[hdr + 0x1C] = 0xFF; t[hdr + 0x1D] = 0xFF; t[hdr + 0x1E] = 0; t[hdr + 0x1F] = 0;
  if (Core.sumBytes(t) === stored) return true;
  let plain = 0; for (let i = 0; i < t.length; i++) plain += t[i]; // some 6 MB ExHiROM dumps use a plain sum
  return (plain & 0xFFFF) === stored;
};

/* ---------- address mapping ---------- */
Core.snesToFile = function (a, mapping, size) {
  const bank = (a >> 16) & 0xFF, off = a & 0xFFFF;
  if (bank === 0x7E || bank === 0x7F) return null;
  if (mapping === 'ExHiROM') {
    if (bank >= 0xC0) return (((bank - 0xC0) << 16) | off) % size;
    if (bank >= 0x80) { if (bank < 0xC0 && off < 0x8000) return null; return ((((bank - 0x80) << 16) | off)) % size; }
    if (bank >= 0x40) return (0x400000 + (((bank - 0x40) << 16) | off)) % size;
    if (off < 0x8000) return null; return (0x400000 + ((bank << 16) | off)) % size;
  }
  if (mapping === 'HiROM') {
    if ((bank & 0x7F) < 0x40 && off < 0x8000) return null;
    return (((bank & 0x3F) * 0x10000) + off) % size;
  }
  if (off < 0x8000) return null;
  return (((bank & 0x7F) * 0x8000) + (off - 0x8000)) % size;
};
Core.fileToSnes = function (f, mapping) {
  if (mapping === 'ExHiROM') return f < 0x400000 ? ((0xC0 + (f >> 16)) << 16) | (f & 0xFFFF) : ((0x40 + ((f - 0x400000) >> 16)) << 16) | (f & 0xFFFF);
  if (mapping === 'HiROM') return ((0xC0 + (f >> 16)) << 16) | (f & 0xFFFF);
  return ((f >> 15) << 16) | (0x8000 + (f & 0x7FFF));
};

/* ---------- tile codecs (SNES planar formats) ---------- */
Core.FORMATS = {
  '1bpp': { bpp: 1, bytes: 8 }, '2bpp': { bpp: 2, bytes: 16 }, '3bpp': { bpp: 3, bytes: 24 },
  '4bpp': { bpp: 4, bytes: 32 }, 'nes2bpp': { bpp: 2, bytes: 16, nes: true }, '8bpp': { bpp: 8, bytes: 64 }, 'mode7': { bpp: 8, bytes: 64 }
};
function planeIndex(bpp, plane, row, nes) {
  if (nes) return plane * 8 + row;
  switch (bpp) {
    case 1: return row;
    case 2: return row * 2 + plane;
    case 3: return plane < 2 ? row * 2 + plane : 16 + row;
    case 4: return plane < 2 ? row * 2 + plane : 16 + row * 2 + (plane - 2);
    default: return (plane >> 1) * 16 + row * 2 + (plane & 1);
  }
}
Core.getPixel = function (d, off, fmt, x, y) {
  const f = Core.FORMATS[fmt];
  if (off + f.bytes > d.length) return 0;
  if (fmt === 'mode7') return d[off + y * 8 + x];
  let v = 0;
  for (let p = 0; p < f.bpp; p++) v |= ((d[off + planeIndex(f.bpp, p, y, f.nes)] >> (7 - x)) & 1) << p;
  return v;
};
Core.setPixel = function (d, off, fmt, x, y, c) {
  const f = Core.FORMATS[fmt];
  if (off + f.bytes > d.length) return;
  if (fmt === 'mode7') { d[off + y * 8 + x] = c; return; }
  for (let p = 0; p < f.bpp; p++) {
    const i = off + planeIndex(f.bpp, p, y, f.nes), m = 1 << (7 - x);
    d[i] = (c >> p) & 1 ? d[i] | m : d[i] & ~m;
  }
};
Core.decodeTile = function (d, off, fmt) {
  const px = new Uint8Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px[y * 8 + x] = Core.getPixel(d, off, fmt, x, y);
  return px;
};
Core.encodeTile = function (d, off, fmt, px) {
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) Core.setPixel(d, off, fmt, x, y, px[y * 8 + x]);
};

/* ---------- palettes (BGR555) ---------- */
Core.readColor = function (d, off) {
  const v = (d[off] | (d[off + 1] << 8)) & 0x7FFF;
  const r = v & 31, g = (v >> 5) & 31, b = (v >> 10) & 31;
  return [Math.round(r * 255 / 31), Math.round(g * 255 / 31), Math.round(b * 255 / 31)];
};
Core.packColor = function (r, g, b) {
  return (Math.round(r * 31 / 255)) | (Math.round(g * 31 / 255) << 5) | (Math.round(b * 31 / 255) << 10);
};
Core.writeColor = function (d, off, r, g, b) {
  const v = Core.packColor(r, g, b); d[off] = v & 255; d[off + 1] = v >> 8;
};

/* ---------- asset analysis ---------- */
const CODE_OPS = new Set([0xA9, 0xA5, 0x85, 0x8D, 0xAD, 0x20, 0x22, 0x60, 0x6B, 0xC2, 0xE2, 0x18, 0x38, 0xF0, 0xD0, 0x80, 0xA2, 0xA0, 0xBD, 0x9D, 0x99, 0xB9, 0xAF, 0x8F, 0xC9, 0x48, 0x68, 0xAA, 0xA8, 0x9C, 0x64, 0xE6, 0xC6, 0x4C, 0x5C, 0xA6, 0x86, 0xEB, 0x0A, 0x4A, 0x29]);
Core.classifyBlock = function (d, off, len) {
  const end = Math.min(d.length, off + len), n = end - off;
  if (n <= 0) return 'empty';
  const cnt = new Uint32Array(256); let ascii = 0, code = 0;
  for (let i = off; i < end; i++) { const b = d[i]; cnt[b]++; if (b >= 32 && b < 127) ascii++; if (CODE_OPS.has(b)) code++; }
  if (cnt[0] === n || cnt[0xFF] === n || cnt[0] / n > 0.97 || cnt[0xFF] / n > 0.97) return 'empty';
  let e = 0; for (let i = 0; i < 256; i++) if (cnt[i]) { const p = cnt[i] / n; e -= p * Math.log2(p); }
  if (ascii / n > 0.7) return 'text';
  if (e > 6.7) return 'packed';
  if (code / n > 0.27 && e > 4.5) return 'code';
  return 'data';
};
Core.scanPalettes = function (d, max) {
  const out = [];
  for (let o = 0; o + 32 <= d.length; o += 2) {
    let ok = true, distinct = new Set(), diff = 0;
    for (let i = 0; i < 16; i++) {
      const v = d[o + i * 2] | (d[o + i * 2 + 1] << 8);
      if (v & 0x8000) { ok = false; break; }
      distinct.add(v);
      if (i) { const p = d[o + i * 2 - 2] | (d[o + i * 2 - 1] << 8); diff += Math.abs((v & 31) - (p & 31)) + Math.abs(((v >> 5) & 31) - ((p >> 5) & 31)) + Math.abs(((v >> 10) & 31) - ((p >> 10) & 31)); }
    }
    if (!ok || distinct.size < 6) continue;
    const first = d[o] | (d[o + 1] << 8);
    const score = distinct.size * 2 + (first === 0 ? 6 : 0) - diff / 20;
    if (score > 14) { out.push({ off: o, score: Math.round(score * 10) / 10 }); o += 30; }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, max || 60).sort((a, b) => a.off - b.off);
};
Core.scanStrings = function (d, minLen) {
  const out = []; let s = -1;
  for (let i = 0; i <= d.length; i++) {
    const c = i < d.length ? d[i] : 0, ok = c >= 32 && c < 127;
    if (ok) { if (s < 0) s = i; }
    else if (s >= 0) {
      if (i - s >= minLen) {
        let t = ''; for (let j = s; j < i; j++) t += String.fromCharCode(d[j]);
        if (/[A-Za-z]{3}/.test(t) && /[ A-Za-z]/.test(t[0]) && (t.match(/[A-Za-z ]/g) || []).length / t.length > 0.7) out.push({ off: s, len: i - s, text: t });
      }
      s = -1;
    }
  }
  return out;
};
/* "relative" search for text in unknown encodings */
Core.relativeSearch = function (d, word) {
  const w = word.toLowerCase(), rel = [];
  for (let i = 1; i < w.length; i++) rel.push(w.charCodeAt(i) - w.charCodeAt(i - 1));
  const hits = [];
  if (!rel.length) return hits;
  for (let i = 0; i + rel.length < d.length; i++) {
    let ok = true;
    for (let j = 0; j < rel.length; j++) if (((d[i + j + 1] - d[i + j]) | 0) !== rel[j]) { ok = false; break; }
    if (ok) {
      const base = d[i] - w.charCodeAt(0);
      hits.push({ off: i, mapA: base + 97 });
      if (hits.length > 200) break;
    }
  }
  return hits;
};
Core.findBytes = function (d, pat, from) {
  outer: for (let i = from || 0; i + pat.length <= d.length; i++) {
    for (let j = 0; j < pat.length; j++) if (d[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
};
Core.freeSpace = function (d, minLen, fill) {
  const out = []; let s = -1;
  for (let i = 0; i <= d.length; i++) {
    const free = i < d.length && (fill === undefined ? (d[i] === 0 || d[i] === 0xFF) : d[i] === fill);
    if (free) { if (s < 0) s = i; } else if (s >= 0) { if (i - s >= minLen) out.push({ off: s, len: i - s }); s = -1; }
  }
  return out;
};

/* ---------- 65816 opcode table ---------- */
const T = {
0x00:['BRK','b'],0x01:['ORA','(d,x)'],0x02:['COP','b'],0x03:['ORA','sr'],0x04:['TSB','d'],0x05:['ORA','d'],0x06:['ASL','d'],0x07:['ORA','[d]'],0x08:['PHP',''],0x09:['ORA','#m'],0x0A:['ASL','A'],0x0B:['PHD',''],0x0C:['TSB','a'],0x0D:['ORA','a'],0x0E:['ASL','a'],0x0F:['ORA','al'],
0x10:['BPL','r'],0x11:['ORA','(d),y'],0x12:['ORA','(d)'],0x13:['ORA','(sr,s),y'],0x14:['TRB','d'],0x15:['ORA','d,x'],0x16:['ASL','d,x'],0x17:['ORA','[d],y'],0x18:['CLC',''],0x19:['ORA','a,y'],0x1A:['INC','A'],0x1B:['TCS',''],0x1C:['TRB','a'],0x1D:['ORA','a,x'],0x1E:['ASL','a,x'],0x1F:['ORA','al,x'],
0x20:['JSR','a'],0x21:['AND','(d,x)'],0x22:['JSL','al'],0x23:['AND','sr'],0x24:['BIT','d'],0x25:['AND','d'],0x26:['ROL','d'],0x27:['AND','[d]'],0x28:['PLP',''],0x29:['AND','#m'],0x2A:['ROL','A'],0x2B:['PLD',''],0x2C:['BIT','a'],0x2D:['AND','a'],0x2E:['ROL','a'],0x2F:['AND','al'],
0x30:['BMI','r'],0x31:['AND','(d),y'],0x32:['AND','(d)'],0x33:['AND','(sr,s),y'],0x34:['BIT','d,x'],0x35:['AND','d,x'],0x36:['ROL','d,x'],0x37:['AND','[d],y'],0x38:['SEC',''],0x39:['AND','a,y'],0x3A:['DEC','A'],0x3B:['TSC',''],0x3C:['BIT','a,x'],0x3D:['AND','a,x'],0x3E:['ROL','a,x'],0x3F:['AND','al,x'],
0x40:['RTI',''],0x41:['EOR','(d,x)'],0x42:['WDM','b'],0x43:['EOR','sr'],0x44:['MVP','mv'],0x45:['EOR','d'],0x46:['LSR','d'],0x47:['EOR','[d]'],0x48:['PHA',''],0x49:['EOR','#m'],0x4A:['LSR','A'],0x4B:['PHK',''],0x4C:['JMP','a'],0x4D:['EOR','a'],0x4E:['LSR','a'],0x4F:['EOR','al'],
0x50:['BVC','r'],0x51:['EOR','(d),y'],0x52:['EOR','(d)'],0x53:['EOR','(sr,s),y'],0x54:['MVN','mv'],0x55:['EOR','d,x'],0x56:['LSR','d,x'],0x57:['EOR','[d],y'],0x58:['CLI',''],0x59:['EOR','a,y'],0x5A:['PHY',''],0x5B:['TCD',''],0x5C:['JML','al'],0x5D:['EOR','a,x'],0x5E:['LSR','a,x'],0x5F:['EOR','al,x'],
0x60:['RTS',''],0x61:['ADC','(d,x)'],0x62:['PER','a'],0x63:['ADC','sr'],0x64:['STZ','d'],0x65:['ADC','d'],0x66:['ROR','d'],0x67:['ADC','[d]'],0x68:['PLA',''],0x69:['ADC','#m'],0x6A:['ROR','A'],0x6B:['RTL',''],0x6C:['JMP','(a)'],0x6D:['ADC','a'],0x6E:['ROR','a'],0x6F:['ADC','al'],
0x70:['BVS','r'],0x71:['ADC','(d),y'],0x72:['ADC','(d)'],0x73:['ADC','(sr,s),y'],0x74:['STZ','d,x'],0x75:['ADC','d,x'],0x76:['ROR','d,x'],0x77:['ADC','[d],y'],0x78:['SEI',''],0x79:['ADC','a,y'],0x7A:['PLY',''],0x7B:['TDC',''],0x7C:['JMP','(a,x)'],0x7D:['ADC','a,x'],0x7E:['ROR','a,x'],0x7F:['ADC','al,x'],
0x80:['BRA','r'],0x81:['STA','(d,x)'],0x82:['BRL','rl'],0x83:['STA','sr'],0x84:['STY','d'],0x85:['STA','d'],0x86:['STX','d'],0x87:['STA','[d]'],0x88:['DEY',''],0x89:['BIT','#m'],0x8A:['TXA',''],0x8B:['PHB',''],0x8C:['STY','a'],0x8D:['STA','a'],0x8E:['STX','a'],0x8F:['STA','al'],
0x90:['BCC','r'],0x91:['STA','(d),y'],0x92:['STA','(d)'],0x93:['STA','(sr,s),y'],0x94:['STY','d,x'],0x95:['STA','d,x'],0x96:['STX','d,y'],0x97:['STA','[d],y'],0x98:['TYA',''],0x99:['STA','a,y'],0x9A:['TXS',''],0x9B:['TXY',''],0x9C:['STZ','a'],0x9D:['STA','a,x'],0x9E:['STZ','a,x'],0x9F:['STA','al,x'],
0xA0:['LDY','#x'],0xA1:['LDA','(d,x)'],0xA2:['LDX','#x'],0xA3:['LDA','sr'],0xA4:['LDY','d'],0xA5:['LDA','d'],0xA6:['LDX','d'],0xA7:['LDA','[d]'],0xA8:['TAY',''],0xA9:['LDA','#m'],0xAA:['TAX',''],0xAB:['PLB',''],0xAC:['LDY','a'],0xAD:['LDA','a'],0xAE:['LDX','a'],0xAF:['LDA','al'],
0xB0:['BCS','r'],0xB1:['LDA','(d),y'],0xB2:['LDA','(d)'],0xB3:['LDA','(sr,s),y'],0xB4:['LDY','d,x'],0xB5:['LDA','d,x'],0xB6:['LDX','d,y'],0xB7:['LDA','[d],y'],0xB8:['CLV',''],0xB9:['LDA','a,y'],0xBA:['TSX',''],0xBB:['TYX',''],0xBC:['LDY','a,x'],0xBD:['LDA','a,x'],0xBE:['LDX','a,y'],0xBF:['LDA','al,x'],
0xC0:['CPY','#x'],0xC1:['CMP','(d,x)'],0xC2:['REP','b'],0xC3:['CMP','sr'],0xC4:['CPY','d'],0xC5:['CMP','d'],0xC6:['DEC','d'],0xC7:['CMP','[d]'],0xC8:['INY',''],0xC9:['CMP','#m'],0xCA:['DEX',''],0xCB:['WAI',''],0xCC:['CPY','a'],0xCD:['CMP','a'],0xCE:['DEC','a'],0xCF:['CMP','al'],
0xD0:['BNE','r'],0xD1:['CMP','(d),y'],0xD2:['CMP','(d)'],0xD3:['CMP','(sr,s),y'],0xD4:['PEI','d'],0xD5:['CMP','d,x'],0xD6:['DEC','d,x'],0xD7:['CMP','[d],y'],0xD8:['CLD',''],0xD9:['CMP','a,y'],0xDA:['PHX',''],0xDB:['STP',''],0xDC:['JML','[a]'],0xDD:['CMP','a,x'],0xDE:['DEC','a,x'],0xDF:['CMP','al,x'],
0xE0:['CPX','#x'],0xE1:['SBC','(d,x)'],0xE2:['SEP','b'],0xE3:['SBC','sr'],0xE4:['CPX','d'],0xE5:['SBC','d'],0xE6:['INC','d'],0xE7:['SBC','[d]'],0xE8:['INX',''],0xE9:['SBC','#m'],0xEA:['NOP',''],0xEB:['XBA',''],0xEC:['CPX','a'],0xED:['SBC','a'],0xEE:['INC','a'],0xEF:['SBC','al'],
0xF0:['BEQ','r'],0xF1:['SBC','(d),y'],0xF2:['SBC','(d)'],0xF3:['SBC','(sr,s),y'],0xF4:['PEA','a'],0xF5:['SBC','d,x'],0xF6:['INC','d,x'],0xF7:['SBC','[d],y'],0xF8:['SED',''],0xF9:['SBC','a,y'],0xFA:['PLX',''],0xFB:['XCE',''],0xFC:['JSR','(a,x)'],0xFD:['SBC','a,x'],0xFE:['INC','a,x'],0xFF:['SBC','al,x']
};
Core.OPCODES = T;
const OPS = {};
for (const k of Object.keys(T)) { const [mn, mode] = T[k]; (OPS[mn] = OPS[mn] || {})[mode] = +k; }

Core.REGS = {
0x2100:'INIDISP',0x2101:'OBSEL',0x2102:'OAMADDL',0x2103:'OAMADDH',0x2104:'OAMDATA',0x2105:'BGMODE',0x2106:'MOSAIC',0x2107:'BG1SC',0x2108:'BG2SC',0x2109:'BG3SC',0x210A:'BG4SC',0x210B:'BG12NBA',0x210C:'BG34NBA',
0x210D:'BG1HOFS',0x210E:'BG1VOFS',0x210F:'BG2HOFS',0x2110:'BG2VOFS',0x2115:'VMAIN',0x2116:'VMADDL',0x2117:'VMADDH',0x2118:'VMDATAL',0x2119:'VMDATAH',0x2121:'CGADD',0x2122:'CGDATA',0x212C:'TM',0x212D:'TS',
0x2130:'CGWSEL',0x2131:'CGADSUB',0x2132:'COLDATA',0x2133:'SETINI',0x213F:'STAT78',0x2140:'APUIO0',0x2141:'APUIO1',0x2142:'APUIO2',0x2143:'APUIO3',0x2180:'WMDATA',0x2181:'WMADDL',0x2182:'WMADDM',0x2183:'WMADDH',
0x4016:'JOYSER0',0x4200:'NMITIMEN',0x4201:'WRIO',0x4202:'WRMPYA',0x4203:'WRMPYB',0x4204:'WRDIVL',0x4206:'WRDIVB',0x4207:'HTIMEL',0x4209:'VTIMEL',0x420B:'MDMAEN',0x420C:'HDMAEN',0x420D:'MEMSEL',
0x4210:'RDNMI',0x4211:'TIMEUP',0x4212:'HVBJOY',0x4218:'JOY1L',0x4219:'JOY1H',0x421A:'JOY2L',0x421B:'JOY2H',0x4300:'DMAP0',0x4301:'BBAD0',0x4302:'A1T0L',0x4304:'A1B0',0x4305:'DAS0L'
};

function operandLen(mode, m, x) {
  switch (mode) {
    case '#m': return m ? 1 : 2;
    case '#x': return x ? 1 : 2;
    case 'b': case 'd': case 'd,x': case 'd,y': case '(d)': case '(d,x)': case '(d),y': case '[d]': case '[d],y': case 'sr': case '(sr,s),y': case 'r': return 1;
    case 'a': case 'a,x': case 'a,y': case '(a)': case '(a,x)': case '[a]': case 'rl': case 'mv': return 2;
    case 'al': case 'al,x': return 3;
    default: return 0;
  }
}

/* ---------- disassembler ---------- */
Core.disasm = function (rom, mapping, cpuAddr, count, m, x) {
  const lines = []; let a = cpuAddr;
  const rd = (ad) => { const f = Core.snesToFile(ad, mapping, rom.length); return f === null ? 0 : rom[f]; };
  for (let n = 0; n < count; n++) {
    const bank = a & 0xFF0000;
    const op = rd(a), ent = T[op], mn = ent[0], mode = ent[1];
    const ln = 1 + operandLen(mode, m, x);
    const raw = []; for (let i = 0; i < ln; i++) raw.push(rd(bank | ((a + i) & 0xFFFF)));
    let v = 0; for (let i = ln - 1; i >= 1; i--) v = v * 256 + raw[i];
    let opd = '', target = null;
    const reg = (val) => Core.REGS[val] ? ' ; ' + Core.REGS[val] : '';
    switch (mode) {
      case '': opd = ''; break;
      case 'A': opd = 'A'; break;
      case '#m': case '#x': opd = '#$' + hex(v, ln === 2 ? 2 : 4); break;
      case 'b': opd = '#$' + hex(v, 2); break;
      case 'r': target = bank | ((a + 2 + (v > 127 ? v - 256 : v)) & 0xFFFF); opd = '$' + hex(target & 0xFFFF, 4); break;
      case 'rl': target = bank | ((a + 3 + (v > 32767 ? v - 65536 : v)) & 0xFFFF); opd = '$' + hex(target & 0xFFFF, 4); break;
      case 'd': opd = '$' + hex(v, 2); break;
      case 'd,x': opd = '$' + hex(v, 2) + ',x'; break;
      case 'd,y': opd = '$' + hex(v, 2) + ',y'; break;
      case '(d)': opd = '($' + hex(v, 2) + ')'; break;
      case '(d,x)': opd = '($' + hex(v, 2) + ',x)'; break;
      case '(d),y': opd = '($' + hex(v, 2) + '),y'; break;
      case '[d]': opd = '[$' + hex(v, 2) + ']'; break;
      case '[d],y': opd = '[$' + hex(v, 2) + '],y'; break;
      case 'sr': opd = '$' + hex(v, 2) + ',s'; break;
      case '(sr,s),y': opd = '($' + hex(v, 2) + ',s),y'; break;
      case 'a': opd = '$' + hex(v, 4) + reg(v); if (mn === 'JSR' || mn === 'JMP') target = bank | v; break;
      case 'a,x': opd = '$' + hex(v, 4) + ',x' + reg(v); break;
      case 'a,y': opd = '$' + hex(v, 4) + ',y' + reg(v); break;
      case '(a)': opd = '($' + hex(v, 4) + ')'; break;
      case '(a,x)': opd = '($' + hex(v, 4) + ',x)'; break;
      case '[a]': opd = '[$' + hex(v, 4) + ']'; break;
      case 'al': opd = '$' + hex(v, 6); if (mn === 'JSL' || mn === 'JML') target = v; break;
      case 'al,x': opd = '$' + hex(v, 6) + ',x'; break;
      case 'mv': opd = '$' + hex(raw[2], 2) + ',$' + hex(raw[1], 2); break;
    }
    lines.push({ addr: a, bytes: raw, mn, opd, text: (mn + ' ' + opd).trim(), target, len: ln, m, x });
    if (mn === 'REP') { if (v & 0x20) m = 0; if (v & 0x10) x = 0; }
    if (mn === 'SEP') { if (v & 0x20) m = 1; if (v & 0x10) x = 1; }
    a = bank | ((a + ln) & 0xFFFF);
  }
  return lines;
};

/* ---------- assembler ---------- */
function evalExpr(src, syms, pc) {
  let i = 0; const s = src.trim(); let unknown = false;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  function primary() {
    ws();
    const rest = s.slice(i);
    let mt;
    if ((mt = /^\$([0-9a-fA-F]+)/.exec(rest)) || (mt = /^0x([0-9a-fA-F]+)/.exec(rest))) { i += mt[0].length; return parseInt(mt[1], 16); }
    if ((mt = /^%([01]+)/.exec(rest))) { i += mt[0].length; return parseInt(mt[1], 2); }
    if ((mt = /^(\d+)/.exec(rest))) { i += mt[0].length; return parseInt(mt[1], 10); }
    if ((mt = /^'(.)'/.exec(rest))) { i += 3; return mt[1].charCodeAt(0); }
    if ((mt = /^([A-Za-z_.][\w.]*)/.exec(rest))) {
      i += mt[0].length;
      if (Object.prototype.hasOwnProperty.call(syms, mt[1])) return syms[mt[1]];
      unknown = true; return 0;
    }
    if (rest[0] === '*') { i++; return pc; }
    if (rest[0] === '(') { i++; const v = expr(); ws(); if (s[i] !== ')') throw new Error('missing )'); i++; return v; }
    throw new Error('bad expression: ' + src);
  }
  function unary() {
    ws();
    const c = s[i];
    if (c === '<') { i++; return unary() & 0xFF; }
    if (c === '>') { i++; return (unary() >> 8) & 0xFF; }
    if (c === '^') { i++; return (unary() >> 16) & 0xFF; }
    if (c === '-') { i++; return -unary(); }
    return primary();
  }
  function term() { let v = unary(); for (;;) { ws(); if (s[i] === '*' && /\S/.test(s.slice(i + 1))) { i++; v *= unary(); } else if (s[i] === '/') { i++; v = Math.floor(v / unary()); } else return v; } }
  function expr() { let v = term(); for (;;) { ws(); const c = s[i]; if (c === '+') { i++; v += term(); } else if (c === '-') { i++; v -= term(); } else if (c === '|') { i++; v |= term(); } else if (c === '&') { i++; v &= term(); } else return v; } }
  const v = expr(); ws();
  if (i < s.length) throw new Error('unexpected "' + s.slice(i) + '"');
  return { v, unknown };
}
Core.evalExpr = evalExpr;

const ALIASES = { INA: ['INC', 'A'], DEA: ['DEC', 'A'], BLT: 'BCC', BGE: 'BCS', SWA: 'XBA', TAD: 'TCD', TAS: 'TCS', TDA: 'TDC', TSA: 'TSC' };

Core.assemble = function (text, opts) {
  opts = opts || {};
  const errors = [], syms = Object.assign({}, opts.symbols || {});
  const stmts = []; // parsed statements, shared across passes
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    let line = raw.replace(/;.*$/, '').trim();
    if (!line) return;
    let mt;
    while ((mt = /^([A-Za-z_][\w]*):\s*/.exec(line))) { stmts.push({ ln: idx + 1, kind: 'label', name: mt[1] }); line = line.slice(mt[0].length); }
    if (!line) return;
    if ((mt = /^([A-Za-z_][\w]*)\s*=\s*(.+)$/.exec(line))) { stmts.push({ ln: idx + 1, kind: 'equ', name: mt[1], expr: mt[2] }); return; }
    if (line[0] === '.') {
      const p = /^(\.\w+)\s*(.*)$/.exec(line);
      stmts.push({ ln: idx + 1, kind: 'dir', name: p[1].toLowerCase(), arg: p[2] }); return;
    }
    const p = /^([A-Za-z]{2,4})(?:\.([bwl]))?\s*(.*)$/.exec(line);
    if (!p) { errors.push({ ln: idx + 1, msg: 'cannot parse: ' + line }); return; }
    stmts.push({ ln: idx + 1, kind: 'ins', mn: p[1].toUpperCase(), force: p[2], arg: p[3].trim() });
  });

  function runPass(pass) {
    const segs = []; let seg = null, pc = opts.org !== undefined ? opts.org : 0x8000, m = opts.m === undefined ? 1 : opts.m, x = opts.x === undefined ? 1 : opts.x;
    const listing = [];
    const startSeg = () => { seg = { addr: pc, bytes: [] }; segs.push(seg); };
    startSeg();
    const emit = (b) => { seg.bytes.push(b & 255); pc = (pc & 0xFF0000) | ((pc + 1) & 0xFFFF); };
    const err = (st, msg) => { if (pass === 2) errors.push({ ln: st.ln, msg }); };
    for (const st of stmts) {
      try {
        if (st.kind === 'label') { syms[st.name] = pc; continue; }
        if (st.kind === 'equ') { const r = evalExpr(st.expr, syms, pc); syms[st.name] = r.v; continue; }
        if (st.kind === 'dir') {
          const a = st.arg;
          switch (st.name) {
            case '.org': pc = evalExpr(a, syms, pc).v; startSeg(); break;
            case '.a8': m = 1; break; case '.a16': m = 0; break; case '.i8': x = 1; break; case '.i16': x = 0; break;
            case '.db': case '.byte': for (const e of splitArgs(a)) emit(evalExpr(e, syms, pc).v); break;
            case '.dw': case '.word': for (const e of splitArgs(a)) { const v = evalExpr(e, syms, pc).v; emit(v); emit(v >> 8); } break;
            case '.dl': for (const e of splitArgs(a)) { const v = evalExpr(e, syms, pc).v; emit(v); emit(v >> 8); emit(v >> 16); } break;
            case '.ds': { const p = splitArgs(a); const n = evalExpr(p[0], syms, pc).v, f = p[1] ? evalExpr(p[1], syms, pc).v : 0; for (let i = 0; i < n; i++) emit(f); break; }
            case '.ascii': case '.asciiz': { const q = /"([^"]*)"/.exec(a); if (!q) throw new Error('expected "text"'); for (const ch of q[1]) emit(ch.charCodeAt(0)); if (st.name === '.asciiz') emit(0); break; }
            default: throw new Error('unknown directive ' + st.name);
          }
          continue;
        }
        // instruction
        let mn = st.mn, arg = st.arg;
        const al = ALIASES[mn];
        if (al) { if (Array.isArray(al)) { mn = al[0]; arg = al[1]; } else mn = al; }
        const table = OPS[mn];
        if (!table) throw new Error('unknown instruction ' + mn);
        const startPc = pc;
        let mode = null, val = 0, unknown = false;
        const ev = (e) => { const r = evalExpr(e, syms, pc); if (r.unknown) unknown = true; return r.v; };
        let mt;
        if (arg === '' || /^a$/i.test(arg)) {
          if (arg === '' && table['']  !== undefined) mode = '';
          else if (table['A'] !== undefined) mode = 'A';
          else throw new Error(mn + ' needs an operand');
        } else if (arg[0] === '#') {
          val = ev(arg.slice(1));
          if (table['b'] !== undefined) mode = 'b';
          else if (table['#m'] !== undefined) mode = '#m';
          else if (table['#x'] !== undefined) mode = '#x';
          else throw new Error(mn + ' has no immediate mode');
        } else if (table['r'] !== undefined || table['rl'] !== undefined) {
          const t = ev(arg); mode = table['r'] !== undefined ? 'r' : 'rl'; val = t;
        } else if (table['mv'] !== undefined) {
          const pp = splitArgs(arg); mode = 'mv'; val = [ev(pp[0]), ev(pp[1])];
        } else if ((mt = /^\(\s*(.+?)\s*,\s*s\s*\)\s*,\s*y$/i.exec(arg))) { mode = '(sr,s),y'; val = ev(mt[1]); }
        else if ((mt = /^\(\s*(.+?)\s*,\s*x\s*\)$/i.exec(arg))) { val = ev(mt[1]); mode = table['(d,x)'] !== undefined && !(table['(a,x)'] !== undefined) ? '(d,x)' : (table['(a,x)'] !== undefined ? '(a,x)' : '(d,x)'); }
        else if ((mt = /^\(\s*(.+?)\s*\)\s*,\s*y$/i.exec(arg))) { mode = '(d),y'; val = ev(mt[1]); }
        else if ((mt = /^\(\s*(.+?)\s*\)$/.exec(arg)) && !/^\(.*\)\s*[-+*]/.test(arg)) { val = ev(mt[1]); mode = table['(a)'] !== undefined ? '(a)' : '(d)'; }
        else if ((mt = /^\[\s*(.+?)\s*\]\s*,\s*y$/i.exec(arg))) { mode = '[d],y'; val = ev(mt[1]); }
        else if ((mt = /^\[\s*(.+?)\s*\]$/.exec(arg))) { val = ev(mt[1]); mode = table['[a]'] !== undefined ? '[a]' : '[d]'; }
        else if ((mt = /^(.+?)\s*,\s*s$/i.exec(arg))) { mode = 'sr'; val = ev(mt[1]); }
        else {
          let idx = ''; let e = arg;
          if ((mt = /^(.+?)\s*,\s*([xy])$/i.exec(arg))) { idx = ',' + mt[2].toLowerCase(); e = mt[1]; }
          val = ev(e);
          const cands = [['b', 'd'], ['w', 'a'], ['l', 'al']];
          const fitsSize = (c) => c === 'd' ? (val >= 0 && val < 0x100) : c === 'a' ? (val >= 0 && val < 0x10000) : true;
          let pickList = cands.filter(c => table[c[1] + idx] !== undefined);
          if (st.force) pickList = pickList.filter(c => c[0] === st.force);
          else {
            if (pass === 1 && unknown) pickList = pickList.filter(c => c[1] !== 'd');
            if (pass === 2 && st.chosen) pickList = pickList.filter(c => c[1] === st.chosen);
            else pickList = pickList.filter(c => fitsSize(c[1]));
          }
          if (!pickList.length) {
            if (mn === 'JMP' && table['al'] === undefined) { mn = 'JML'; mode = 'al'; }
            else if (mn === 'JSR') { mn = 'JSL'; mode = 'al'; }
            else throw new Error('no addressing mode fits ' + st.mn + ' ' + arg);
          } else mode = pickList[0][1] + idx;
          if (mn === 'JMP' && val > 0xFFFF) { mn = 'JML'; mode = 'al'; }
          if (mn === 'JSR' && val > 0xFFFF) { mn = 'JSL'; mode = 'al'; }
          st.chosen = mode.replace(/,[xy]$/, '');
        }
        const opTable = OPS[mn]; const opc = opTable[mode];
        if (opc === undefined) throw new Error(mn + ' does not support that addressing mode');
        emit(opc);
        const w = (n, v) => { for (let i = 0; i < n; i++) emit((v >> (8 * i)) & 255); };
        switch (mode) {
          case '': case 'A': break;
          case '#m': if (pass === 2 && m && (val > 255 || val < -128)) throw new Error('value ' + val + ' does not fit 8-bit accumulator (use rep #$20 or .a16)'); w(m ? 1 : 2, val); break;
          case '#x': if (pass === 2 && x && (val > 255 || val < -128)) throw new Error('value ' + val + ' does not fit 8-bit index (use rep #$10 or .i16)'); w(x ? 1 : 2, val); break;
          case 'b': w(1, val); if (mn === 'REP') { if (val & 0x20) m = 0; if (val & 0x10) x = 0; } if (mn === 'SEP') { if (val & 0x20) m = 1; if (val & 0x10) x = 1; } break;
          case 'r': { const rel = val - ((startPc & 0xFFFF) + 2) - (startPc & 0xFF0000 ? 0 : 0); const t = (val & 0xFFFF) - ((startPc & 0xFFFF) + 2); if (pass === 2 && (t < -128 || t > 127)) throw new Error('branch out of range (' + t + ')'); w(1, t); void rel; break; }
          case 'rl': w(2, (val & 0xFFFF) - ((startPc & 0xFFFF) + 3)); break;
          case 'mv': emit(val[1]); emit(val[0]); break;
          case 'al': case 'al,x': w(3, val); break;
          case 'a': case 'a,x': case 'a,y': case '(a)': case '(a,x)': case '[a]': w(2, val); break;
          default: if (pass === 2 && (val < -128 || val > 255)) throw new Error('operand too large for 8-bit mode'); w(1, val);
        }
        if (pass === 2) listing.push({ ln: st.ln, addr: startPc, bytes: seg.bytes.slice(seg.bytes.length - (pc - startPc)) });
      } catch (e) { err(st, e.message); }
    }
    return { segs: segs.filter(s => s.bytes.length), listing };
  }
  runPass(1);
  const res = runPass(2);
  return { segments: res.segs, listing: res.listing, symbols: syms, errors };
};
function splitArgs(a) {
  const out = []; let depth = 0, cur = '', q = false;
  for (const c of a) {
    if (c === '"') q = !q;
    if (!q && (c === '(' || c === '[')) depth++;
    if (!q && (c === ')' || c === ']')) depth--;
    if (c === ',' && depth === 0 && !q) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

/* ---------- IPS patches ---------- */
Core.makeIPS = function (orig, mod) {
  const out = [0x50, 0x41, 0x54, 0x43, 0x48];
  const n = mod.length, differs = (i) => i >= orig.length || orig[i] !== mod[i];
  const put3 = (v) => out.push((v >> 16) & 255, (v >> 8) & 255, v & 255);
  const put2 = (v) => out.push((v >> 8) & 255, v & 255);
  let i = 0;
  while (i < n) {
    if (!differs(i)) { i++; continue; }
    let start = i, end = i + 1, gap = 0;
    while (end < n && gap <= 5) { if (differs(end)) gap = 0; else gap++; end++; }
    end -= gap;
    if (start === 0x454F46) start--; // offset would read as "EOF"
    for (let p = start; p < end;) {
      const len = Math.min(end - p, 0xFFFF);
      let uniform = len >= 9; for (let k = 1; uniform && k < len; k++) if (mod[p + k] !== mod[p]) uniform = false;
      put3(p);
      if (uniform) { put2(0); put2(len); out.push(mod[p]); }
      else { put2(len); for (let k = 0; k < len; k++) out.push(mod[p + k]); }
      p += len;
    }
    i = end;
  }
  out.push(0x45, 0x4F, 0x46);
  return new Uint8Array(out);
};
Core.applyIPS = function (rom, ips) {
  const sig = String.fromCharCode(...ips.slice(0, 5));
  if (sig !== 'PATCH') throw new Error('Not an IPS patch');
  let out = rom.slice(), p = 5;
  const ensure = (len) => { if (len > out.length) { const t = new Uint8Array(len); t.set(out); out = t; } };
  while (p + 3 <= ips.length) {
    if (ips[p] === 0x45 && ips[p + 1] === 0x4F && ips[p + 2] === 0x46) { p += 3; break; }
    const off = (ips[p] << 16) | (ips[p + 1] << 8) | ips[p + 2]; p += 3;
    const len = (ips[p] << 8) | ips[p + 1]; p += 2;
    if (len === 0) { const rl = (ips[p] << 8) | ips[p + 1]; const v = ips[p + 2]; p += 3; ensure(off + rl); out.fill(v, off, off + rl); }
    else { ensure(off + len); out.set(ips.slice(p, p + len), off); p += len; }
  }
  if (p + 3 <= ips.length) { const t = (ips[p] << 16) | (ips[p + 1] << 8) | ips[p + 2]; if (t < out.length) out = out.slice(0, t); }
  return out;
};

/* ---------- header writing / ROM building ---------- */
Core.writeHeader = function (d, hdr, o) {
  if (o.title !== undefined) { const t = (o.title.toUpperCase() + ' '.repeat(21)).slice(0, 21); for (let i = 0; i < 21; i++) d[hdr + i] = t.charCodeAt(i) & 0x7F; }
  if (o.mapMode !== undefined) d[hdr + 0x15] = o.mapMode;
  if (o.cartType !== undefined) d[hdr + 0x16] = o.cartType;
  d[hdr + 0x17] = Math.max(7, Math.min(0x0E, Math.round(Math.log2(d.length / 1024)) ));
  if (o.ramSizeCode !== undefined) d[hdr + 0x18] = o.ramSizeCode;
  if (o.region !== undefined) d[hdr + 0x19] = o.region;
  if (o.maker !== undefined) d[hdr + 0x1A] = o.maker;
  if (o.version !== undefined) d[hdr + 0x1B] = o.version;
};
Core.resizeRom = function (d, newSize) {
  if (newSize === d.length) return d;
  const t = new Uint8Array(newSize); t.set(d.slice(0, Math.min(d.length, newSize))); return t;
};

/* ---------- starter game (a complete tiny SNES program) ---------- */
Core.STARTER = { PAL_BG: 0x8800, PAL_OBJ: 0x8820, TILES_BG: 0x8900, TILES_OBJ: 0x8A00, TILEMAP: 0x9000, OAM: 0x9800 };

function tileRows(rows) { // rows: 8 strings of 8 chars '0'..'f' -> 4bpp bytes
  const d = new Uint8Array(32);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) Core.setPixel(d, 0, '4bpp', x, y, parseInt(rows[y][x], 16));
  return d;
}
Core.starterSource = function () {
  const S = Core.STARTER;
  const dma = (chan, mode, reg, addr, size) => [
    `    lda #$${hex(mode)}`, `    sta $43${chan}0`, `    lda #$${hex(reg)}`, `    sta $43${chan}1`,
    `    ldx #$${hex(addr, 4)}`, `    stx $43${chan}2`, `    lda #$00`, `    sta $43${chan}4`,
    `    ldx #$${hex(size, 4)}`, `    stx $43${chan}5`, `    lda #$01`, `    sta $420B`].join('\n');
  return `; ===== SNES Studio starter game =====
; A complete working program: a scrolling background and a sprite you move with the D-pad.
; Edit this source, then press Assemble in the Code tab (or change the graphics in the Graphics tab).
.org $8000
.a8
.i16
Reset:
    sei
    clc
    xce                ; native mode
    rep #$38           ; 16-bit A, X, Y; binary maths
    ldx #$1FFF
    txs
    lda #$0000
    tcd
    sep #$20           ; 8-bit A
    lda #$8F
    sta $2100          ; forced blank: screen off while we load graphics
    stz $4200          ; no interrupts yet
    stz $420B
    stz $420C
    lda #$01
    sta $2105          ; BG mode 1
    lda #$04
    sta $2107          ; BG1 tile map at VRAM $0400
    stz $210B          ; BG1 tiles at VRAM $0000
    lda #$02
    sta $2101          ; sprite tiles at VRAM $4000
    stz $210D
    stz $210D
    stz $210E
    stz $210E
    lda #$11
    sta $212C          ; show BG1 + sprites
    stz $212D
    stz $2121          ; --- background palette -> CGRAM 0
${dma('0', 2, 0x22, S.PAL_BG, 32)}
    lda #$80
    sta $2121          ; --- sprite palette -> CGRAM 128
${dma('0', 2, 0x22, S.PAL_OBJ, 32)}
    lda #$80
    sta $2115          ; VRAM increments after high byte
    ldx #$0000
    stx $2116          ; --- background tiles -> VRAM $0000
${dma('0', 1, 0x18, S.TILES_BG, 128)}
    ldx #$0400
    stx $2116          ; --- tile map -> VRAM $0400
${dma('0', 1, 0x18, S.TILEMAP, 2048)}
    ldx #$4000
    stx $2116          ; --- sprite tiles -> VRAM $4000
${dma('0', 1, 0x18, S.TILES_OBJ, 32)}
    stz $2102
    stz $2103          ; --- OAM table -> OAM
${dma('0', 0, 0x04, S.OAM, 544)}
    lda #$78
    sta $10            ; sprite X
    lda #$70
    sta $11            ; sprite Y
    stz $12            ; scroll counter
    lda #$0F
    sta $2100          ; screen on, full brightness
    lda #$81
    sta $4200          ; enable NMI + auto joypad read
Loop:
    wai                ; sleep until the next frame
    bra Loop

NMI:
    pha
    lda $4210          ; acknowledge NMI
WaitPad:
    lda $4212
    and #$01
    bne WaitPad        ; wait for joypad auto-read
    lda $4219          ; B Y Sel Start Up Down Left Right
    bit #$01
    beq NoRight
    inc $10
NoRight:
    bit #$02
    beq NoLeft
    dec $10
NoLeft:
    bit #$04
    beq NoDown
    inc $11
NoDown:
    bit #$08
    beq NoUp
    dec $11
NoUp:
    stz $2102
    stz $2103
    lda $10
    sta $2104          ; X
    lda $11
    sta $2104          ; Y
    stz $2104          ; tile 0
    lda #$30
    sta $2104          ; priority 3, palette 0
    inc $12
    lda $12
    sta $210D          ; scroll the background
    stz $210D
    pla
    rti

Stub:
    rti
`;
};
Core.buildStarter = function (sizeKB, title) {
  sizeKB = sizeKB || 128;
  const d = new Uint8Array(sizeKB * 1024), S = Core.STARTER;
  const put = (cpu, bytes) => { const f = Core.snesToFile(cpu, 'LoROM', d.length); d.set(bytes, f); };
  const asm = Core.assemble(Core.starterSource(), { org: 0x8000, m: 1, x: 1 });
  if (asm.errors.length) throw new Error('starter assembly failed: ' + JSON.stringify(asm.errors));
  for (const s of asm.segments) put(s.addr, s.bytes);
  const sym = asm.symbols;
  const codeEnd = Math.max(...asm.segments.map(s => s.addr + s.bytes.length));
  if (codeEnd > S.PAL_BG) throw new Error('starter code too large');
  // palettes (BGR555)
  const pal = (list) => { const b = new Uint8Array(32); list.forEach((c, i) => Core.writeColor(b, i * 2, c[0], c[1], c[2])); return b; };
  put(S.PAL_BG, pal([[0, 0, 24], [248, 248, 248], [64, 96, 200], [24, 40, 120], [200, 160, 64], [120, 80, 24], [255, 120, 120], [120, 255, 120]]));
  put(S.PAL_OBJ, pal([[0, 0, 0], [255, 220, 40], [255, 255, 255], [220, 80, 40], [40, 40, 40], [120, 200, 255]]));
  // background tiles: 0 blank, 1 border, 2 checker, 3 dots
  const bg = new Uint8Array(128);
  bg.set(tileRows(['00000000', '00000000', '00000000', '00000000', '00000000', '00000000', '00000000', '00000000']), 0);
  bg.set(tileRows(['11111111', '10000003', '10000003', '10000003', '10000003', '10000003', '10000003', '33333333']), 32);
  bg.set(tileRows(['22223333', '22223333', '22223333', '22223333', '33332222', '33332222', '33332222', '33332222']), 64);
  bg.set(tileRows(['00000000', '00040000', '00444000', '00040000', '00000000', '00000500', '00005550', '00000500']), 96);
  put(S.TILES_BG, bg);
  put(S.TILES_OBJ, tileRows(['00111100', '01222210', '12311321', '12222221', '12322321', '12233221', '01222210', '00111100']));
  // tile map 32x32: border around the edge, checker field, dots
  const map = new Uint8Array(2048);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    let t = 0;
    if (x === 0 || y === 0 || x === 31 || y === 31) t = 1;
    else if ((x + y) % 7 === 0) t = 3;
    else if (((x >> 1) + (y >> 1)) % 2 === 0) t = 2;
    map[(y * 32 + x) * 2] = t; map[(y * 32 + x) * 2 + 1] = 0;
  }
  put(S.TILEMAP, map);
  // OAM: sprite 0 on screen, 127 hidden; high table zero
  const oam = new Uint8Array(544);
  for (let i = 0; i < 128; i++) { oam[i * 4] = 0; oam[i * 4 + 1] = 0xF0; }
  oam[0] = 0x78; oam[1] = 0x70; oam[2] = 0; oam[3] = 0x30;
  put(S.OAM, oam);
  // header
  const hdr = Core.snesToFile(0xFFC0, 'LoROM', d.length);
  Core.writeHeader(d, hdr, { title: title || 'MY SNES GAME', mapMode: 0x20, cartType: 0x00, ramSizeCode: 0, region: 1, maker: 0, version: 0 });
  const vec = (a, v) => { d[hdr + (a - 0xFFC0)] = v & 255; d[hdr + (a - 0xFFC0) + 1] = v >> 8; };
  for (const a of [0xFFE4, 0xFFE6, 0xFFE8, 0xFFEC, 0xFFEE, 0xFFF4, 0xFFF8, 0xFFFE]) vec(a, sym.Stub);
  vec(0xFFEA, sym.NMI); vec(0xFFFA, sym.NMI); vec(0xFFFC, sym.Reset);
  Core.fixChecksum(d, hdr);
  return { rom: d, hdr, symbols: sym };
};

Core.buildBlank = function (sizeKB, title) {
  const d = new Uint8Array((sizeKB || 128) * 1024);
  const asm = Core.assemble('.org $8000\nReset:\n    sei\n    clc\n    xce\n    rep #$38\n    ldx #$1FFF\n    txs\n    sep #$20\n    lda #$8F\n    sta $2100\nLoop:\n    wai\n    bra Loop\nNMI:\n    rti\n', { org: 0x8000 });
  if (asm.errors.length) throw new Error('blank assembly failed');
  for (const s of asm.segments) d.set(s.bytes, Core.snesToFile(s.addr, 'LoROM', d.length));
  const hdr = Core.snesToFile(0xFFC0, 'LoROM', d.length);
  Core.writeHeader(d, hdr, { title: title || 'BLANK PROJECT', mapMode: 0x20, cartType: 0x00, ramSizeCode: 0, region: 1, maker: 0, version: 0 });
  const vec = (a, v) => { d[hdr + (a - 0xFFC0)] = v & 255; d[hdr + (a - 0xFFC0) + 1] = v >> 8; };
  for (const a of [0xFFE4, 0xFFE6, 0xFFE8, 0xFFEA, 0xFFEC, 0xFFEE, 0xFFF4, 0xFFF8, 0xFFFA, 0xFFFE]) vec(a, asm.symbols.NMI);
  vec(0xFFFC, asm.symbols.Reset);
  Core.fixChecksum(d, hdr);
  return { rom: d, hdr, symbols: asm.symbols };
};

root.SnesCore = Core;
if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof window !== 'undefined' ? window : globalThis);
