/* Compression codecs documented by the SNES romhacking community. Extends SnesCore. No DOM.
   Sources: SMW-Editor docs / MushROMs (LC_LZ2), yaze + ZSpriteMaker notes (ALttP), SnesLab + b.bradsmith SimCity decoder (LZ5),
   Data Crystal EarthBound ASM page + exhal (HAL). Decoders follow those descriptions; none was verified against a retail ROM here. */
(function (root) {
'use strict';
const Core = root.SnesCore || (typeof require !== 'undefined' ? require('./core.js') : null);
const K = {};
K.VARIANTS = {
  lz2be: { name: 'LC_LZ2 (big-endian repeat address)', games: 'Super Mario World, Yoshi\'s Island', addr: 'be', cmds: 5 },
  lz2le: { name: 'LC_LZ2 (little-endian repeat address)', games: 'A Link to the Past', addr: 'le', cmds: 5 },
  lz5: { name: 'LZ5 (extended Nintendo LZ)', games: 'Super Metroid, Super Mario Kart, SimCity', addr: 'le', cmds: 8 },
  hal: { name: 'HAL Laboratory compression', games: 'Kirby Super Star', addr: 'be', cmds: 8 }
};
const rev8 = (b) => { let r = 0; for (let i = 0; i < 8; i++) if (b & (1 << i)) r |= 0x80 >> i; return r; };
// Decode one stream. Returns {data, end (offset after terminator), used}. Throws Error with .partial on malformed data.
K.decode = function (rom, off, variant, maxOut) {
  const V = K.VARIANTS[variant]; if (!V) throw new Error('unknown codec ' + variant);
  maxOut = maxOut || (1 << 20); const out = []; let p = off;
  const fail = (msg) => { const e = new Error(msg + ' at $' + Core.hex(p, 6)); e.partial = Uint8Array.from(out); throw e; };
  const rd = () => { if (p >= rom.length) fail('ran off the end of the ROM'); return rom[p++]; };
  for (;;) {
    const ctl = rd(); if (ctl === 0xFF) break;
    let mode = ctl >> 5, len = (ctl & 31) + 1;
    if (mode === 7) { mode = (ctl >> 2) & 7; len = (((ctl & 3) << 8) | rd()) + 1; }
    if (out.length + len > maxOut) fail('output too large');
    switch (mode) {
      case 0: for (let i = 0; i < len; i++) out.push(rd()); break;
      case 1: { const b = rd(); for (let i = 0; i < len; i++) out.push(b); break; }
      case 2: { const a = rd(), b = rd(); for (let i = 0; i < len; i++) out.push(i & 1 ? b : a); break; }
      case 3: { let b = rd(); for (let i = 0; i < len; i++) { out.push(b); b = (b + 1) & 255; } break; }
      default: {
        if (mode > 4 && V.cmds === 5) fail('command ' + mode + ' is not part of this format');
        if (variant === 'lz5' && mode >= 6) { // relative: distance back from the current end
          const d = rd(), ref = out.length - d; if (ref < 0) fail('relative reference before start of output');
          for (let i = 0; i < len; i++) out.push(out[ref + i] ^ (mode === 7 ? 0xFF : 0));
          break;
        }
        const a = rd(), b = rd(), ref = V.addr === 'be' ? (a << 8) | b : a | (b << 8);
        if (variant === 'hal' && mode === 6) { // backwards copy
          for (let i = 0; i < len; i++) { const q = ref - i; if (q < 0 || q >= out.length) fail('backwards reference out of range'); out.push(out[q]); }
          break;
        }
        const inv = variant === 'lz5' && mode === 5, rv = variant === 'hal' && mode === 5;
        if (ref >= out.length) fail('reference past end of output');
        for (let i = 0; i < len; i++) { if (ref + i >= out.length) fail('reference overruns output'); let v = out[ref + i]; if (inv) v ^= 0xFF; if (rv) v = rev8(v); out.push(v); }
      }
    }
  }
  return { data: Uint8Array.from(out), end: p, used: p - off };
};
// Greedy compressor using only commands 0-4 (valid for every variant above). Output <= 64 KB because repeat addresses are 16-bit.
K.encode = function (data, variant) {
  const V = K.VARIANTS[variant]; if (!V) throw new Error('unknown codec ' + variant); if (data.length > 0x10000) throw new Error('data is larger than 64 KB');
  const out = [], lit = []; const be = V.addr === 'be';
  const head = (cmd, len) => { if (len <= 32) out.push((cmd << 5) | (len - 1)); else out.push(0xE0 | (cmd << 2) | ((len - 1) >> 8), (len - 1) & 255); };
  const flush = () => { let i = 0; while (i < lit.length) { const n = Math.min(1024, lit.length - i); head(0, n); for (let k = 0; k < n; k++) out.push(lit[i + k]); i += n; } lit.length = 0; };
  const hash = new Map(); const key = (i) => data[i] | data[i + 1] << 8 | data[i + 2] << 16;
  const cost = (len) => (len <= 32 ? 1 : 2);
  let i = 0;
  const addHash = (j) => { if (j + 2 < data.length) { const k = key(j); let a = hash.get(k); if (!a) hash.set(k, a = []); a.push(j); if (a.length > 48) a.shift(); } };
  let hashed = 0;
  while (i < data.length) {
    while (hashed < i) addHash(hashed++);
    const rem = Math.min(1024, data.length - i); let best = { sav: 0 };
    // byte fill
    let r = 1; while (r < rem && data[i + r] === data[i]) r++; if (r - 1 - cost(r) > best.sav) best = { sav: r - 1 - cost(r), cmd: 1, len: r, bytes: [data[i]] };
    // word fill
    if (i + 1 < data.length) { r = 2; while (r < rem && data[i + r] === data[i + (r & 1)]) r++; if (r - 2 - cost(r) > best.sav) best = { sav: r - 2 - cost(r), cmd: 2, len: r, bytes: [data[i], data[i + 1]] }; }
    // increasing fill
    r = 1; while (r < rem && data[i + r] === ((data[i] + r) & 255)) r++; if (r - 1 - cost(r) > best.sav) best = { sav: r - 1 - cost(r), cmd: 3, len: r, bytes: [data[i]] };
    // repeat from earlier output
    if (i + 2 < data.length) { const c = hash.get(key(i)); if (c) for (let n = c.length - 1; n >= 0; n--) { const j = c[n]; let l = 0; while (l < rem && data[j + l] === data[i + l]) l++; if (l >= 3 && l - 2 - cost(l) > best.sav) best = { sav: l - 2 - cost(l), cmd: 4, len: l, bytes: be ? [j >> 8, j & 255] : [j & 255, j >> 8] }; } }
    if (best.sav > 0) { flush(); head(best.cmd, best.len); out.push(...best.bytes); i += best.len; } else { lit.push(data[i]); i++; }
  }
  flush(); out.push(0xFF); return Uint8Array.from(out);
};
// Find offsets where a stream decodes cleanly to a plausible size.
K.scan = function (rom, variant, o) {
  o = o || {}; const minOut = o.minOut || 128, maxOut = o.maxOut || 0x10000, maxIn = o.maxIn || 0x4000, hits = []; const end = o.end || rom.length;
  for (let p = o.start || 0; p < end; p++) {
    const c = rom[p]; if (c === 0xFF || c === 0) continue; // 0 would be a 1-byte literal: far too common
    let r; try { r = K.decode(rom, p, variant, maxOut); } catch (e) { continue; }
    if (r.used > maxIn || r.data.length < minOut) continue;
    if (r.used * 1.1 > r.data.length && r.data.length < 512) continue; // barely compressed tiny things are noise
    hits.push({ off: p, used: r.used, out: r.data.length, ratio: +(r.data.length / r.used).toFixed(2) }); p += r.used - 1;
  }
  return hits;
};
// SMW's LC_RLE1 (per SMW-Editor docs): FLLLLLLL; F=1 repeat next byte, F=0 copy; "FF FF" ends the data.
K.rle1Decode = function (rom, off) {
  const out = []; let p = off;
  for (;;) { if (p + 1 >= rom.length) throw new Error('ran off the end'); const c = rom[p++]; if (c === 0xFF && rom[p] === 0xFF) { p++; break; } const len = (c & 0x7F) + 1; if (c & 0x80) { const b = rom[p++]; for (let i = 0; i < len; i++) out.push(b); } else for (let i = 0; i < len; i++) out.push(rom[p++]); if (out.length > 1 << 20) throw new Error('output too large'); }
  return { data: Uint8Array.from(out), end: p, used: p - off };
};
Core.Codec = K;
if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof window !== 'undefined' ? window : globalThis);
