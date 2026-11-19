/* Asset capture: pulls everything the studio can recognise out of a SNES ROM into a list of files. No DOM. Extends SnesCore. */
(function (root) {
'use strict';
const Core = root.SnesCore || (typeof require !== 'undefined' ? require('./core.js') : null);
const Cap = {};
// --- minimal PNG writer (uncompressed deflate blocks; no zlib needed) ---
const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b, s) => { let c = s === undefined ? 0xFFFFFFFF : s; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8); return c >>> 0; };
Cap.png = function (w, h, rgba) {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1); }
  const blocks = []; let a = 1, b = 0;
  for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
  blocks.push(Uint8Array.of(0x78, 1));
  for (let i = 0; i < raw.length; i += 65535) { const n = Math.min(65535, raw.length - i), last = i + n >= raw.length ? 1 : 0; blocks.push(Uint8Array.of(last, n & 255, n >> 8, ~n & 255, (~n >> 8) & 255), raw.subarray(i, i + n)); }
  const ad = new Uint8Array(4); new DataView(ad.buffer).setUint32(0, ((b << 16) | a) >>> 0); blocks.push(ad);
  const idat = cat(blocks);
  const chunk = (type, data) => { const o = new Uint8Array(12 + data.length), dv = new DataView(o.buffer); dv.setUint32(0, data.length); for (let i = 0; i < 4; i++) o[4 + i] = type.charCodeAt(i); o.set(data, 8); dv.setUint32(8 + data.length, (crc(o.subarray(4, 8 + data.length)) ^ 0xFFFFFFFF) >>> 0); return o; };
  const ih = new Uint8Array(13), iv = new DataView(ih.buffer); iv.setUint32(0, w); iv.setUint32(4, h); ih[8] = 8; ih[9] = 6;
  return cat([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', ih), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]);
};
function cat(arr) { let n = 0; for (const a of arr) n += a.length; const o = new Uint8Array(n); let p = 0; for (const a of arr) { o.set(a, p); p += a.length; } return o; }
const enc = (s) => new TextEncoder().encode(s);
const hx = (n, w) => n.toString(16).toUpperCase().padStart(w || 6, '0');
// Contact-sheet PNG of tiles (greyscale or from a 16-colour palette)
Cap.tileSheet = function (data, off, len, fmt, pal) {
  const tb = Core.FORMATS[fmt].bytes, n = Math.min(Math.floor(len / tb), 1024), cols = 16, rows = Math.max(1, Math.ceil(n / cols)), W = cols * 8, H = rows * 8, img = new Uint8Array(W * H * 4), lv = (1 << Core.FORMATS[fmt].bpp) - 1;
  for (let t = 0; t < n; t++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const c = Core.getPixel(data, off + t * tb, fmt, x, y), i = ((Math.floor(t / cols) * 8 + y) * W + (t % cols) * 8 + x) * 4;
    const col = pal && pal[c] ? pal[c] : [Math.round(c * 255 / lv), Math.round(c * 255 / lv), Math.round(c * 255 / lv)];
    img[i] = col[0]; img[i + 1] = col[1]; img[i + 2] = col[2]; img[i + 3] = 255;
  }
  return Cap.png(W, H, img);
};
// Runs of consecutive 512-byte cells that look like tile/table data
Cap.dataRuns = function (rom, minCells) {
  const runs = []; let s = -1; const n = Math.ceil(rom.length / 512);
  for (let i = 0; i <= n; i++) {
    const c = i < n ? Core.classifyBlock(rom, i * 512, 512) : 'x';
    if (c === 'data') { if (s < 0) s = i; } else if (s >= 0) { if (i - s >= (minCells || 8)) runs.push({ off: s * 512, len: (i - s) * 512 }); s = -1; }
  }
  return runs;
};
Cap.run = function (rom, det, game, o) {
  o = o || {}; const files = [], rep = { palettes: 0, graphicsRuns: 0, graphicsBytes: 0, sheets: 0, samples: 0, sampleBytes: 0, strings: 0, streams: 0, code: 0, notes: [] };
  const add = (name, data) => files.push({ name, data: typeof data === 'string' ? enc(data) : data });
  const hdr = Core.readHeader(rom, det.hdr), mapping = det.mapping;
  // header
  const Games = Core.Games, chip = Games ? Games.chipFromHeader(hdr.cartType, rom[det.hdr - 1]).chip : '?';
  add('header.json', JSON.stringify({ title: hdr.title, mapping, hdrOffset: det.hdr, sizeBytes: rom.length, cartType: hdr.cartType, chip, checksum: hdr.checksum, checksumOk: Core.checksumOk(rom, det.hdr), vectors: hdr.vectors, game: game ? { n: game.n, name: game.name } : null }, null, 1));
  // palettes
  const pals = Core.scanPalettes(rom, 400); rep.palettes = pals.length;
  const palJson = pals.map((p) => ({ off: p.off, score: p.score, colors: Array.from({ length: 16 }, (_, i) => { const c = Core.readColor(rom, p.off + i * 2); return '#' + c.map((v) => hx(v, 2)).join(''); }) }));
  add('palettes/palettes.json', JSON.stringify(palJson));
  if (pals.length) { // palette sheet png: 16 swatches per row
    const W = 16 * 8, H = Math.min(pals.length, 200) * 8, img = new Uint8Array(W * H * 4);
    for (let r = 0; r < H / 8; r++) for (let i = 0; i < 16; i++) { const c = Core.readColor(rom, pals[r].off + i * 2); for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const k = ((r * 8 + y) * W + i * 8 + x) * 4; img[k] = c[0]; img[k + 1] = c[1]; img[k + 2] = c[2]; img[k + 3] = 255; } }
    add('palettes/palettes.png', Cap.png(W, H, img));
  }
  // graphics
  const runs = Cap.dataRuns(rom, 8).sort((a, b) => b.len - a.len).slice(0, o.maxRuns || 24).sort((a, b) => a.off - b.off);
  rep.graphicsRuns = runs.length; const pal0 = null; // greyscale: a guessed palette would give misleading colours
  for (const r of runs) {
    const len = Math.min(r.len, 0x10000); rep.graphicsBytes += len;
    add('graphics/raw_' + hx(r.off) + '.bin', rom.slice(r.off, r.off + len));
    if (rep.sheets < (o.maxSheets || 16)) { add('graphics/sheet4bpp_' + hx(r.off) + '.png', Cap.tileSheet(rom, r.off, len, '4bpp', pal0)); add('graphics/sheet2bpp_' + hx(r.off) + '.png', Cap.tileSheet(rom, r.off, len, '2bpp', null)); rep.sheets++; }
  }
  // audio
  const A = Core.Audio; if (A) {
    const br = A.scanBrr(rom, {}).slice(0, o.maxSamples || 300); rep.samples = br.length;
    for (const s of br) { const dec = A.brrDecode(rom, s.off, s.blocks); rep.sampleBytes += s.bytes; add('audio/brr_' + hx(s.off) + '.wav', A.writeWav(dec.pcm, 32000, s.loop ? { start: 0, end: dec.pcm.length - 1 } : null)); add('audio/brr_' + hx(s.off) + '.brr', rom.slice(s.off, s.off + s.bytes)); }
  }
  // text
  const strs = Core.scanStrings(rom, 6).slice(0, 5000); rep.strings = strs.length;
  add('text/strings.txt', strs.map((s) => '$' + hx(s.off) + '\t' + s.text).join('\n'));
  // code
  try { const m = hdr.vectors; const lines = []; for (const [k, a] of Object.entries(m)) lines.push(k + ' = $' + hx(a, 4)); const d = Core.disasm(rom, mapping, m.RESET, 96, 1, 1); rep.code = d.length; add('code/vectors_and_reset.asm', lines.join('\n') + '\n\n; first 96 instructions from RESET\n' + d.map((l) => '$' + hx(l.addr, 6) + '  ' + l.text).join('\n')); } catch (e) { rep.notes.push('disassembly failed: ' + e.message); }
  // decoded compressed streams
  const K = Core.Codec;
  if (K && o.streams !== false) {
    if (game && game.n === 1 && mapping === 'LoROM') { // Super Mario World ExGFX pointer table (verified)
      const f = (a) => Core.snesToFile(a, mapping, rom.length), lo = f(0xB992), hi = f(0xB9C4), bk = f(0xB9F6);
      for (let i = 0; i < 0x32; i++) { try { const a = rom[lo + i] | rom[hi + i] << 8 | rom[bk + i] << 16, r = K.decode(rom, f(a), 'lz2be', 0x10000); add('graphics/decoded/smw_gfx' + hx(i, 2) + '.bin', r.data); add('graphics/decoded/smw_gfx' + hx(i, 2) + '.png', Cap.tileSheet(r.data, 0, r.data.length, i < 0x28 || i > 0x2b ? '3bpp' : '4bpp', pal0)); rep.streams++; } catch (e) { rep.notes.push('SMW gfx ' + i + ' failed'); } }
    } else if (game && game.codec && game.codecStatus !== 'none' && o.scanCodec !== false) {
      const hits = K.scan(rom, game.codec, { minOut: 1024, maxOut: 0x8000, maxIn: 0x3000 }).filter((x) => x.ratio >= 1.3).slice(0, o.maxStreams || 100);
      for (const x of hits) { try { const r = K.decode(rom, x.off, game.codec, 0x10000); add('graphics/decoded/candidate_' + hx(x.off) + '.bin', r.data); rep.streams++; } catch (e) { /* skip */ } }
      rep.notes.push('Decoded streams are scan candidates (' + game.codecStatus + '), not confirmed.');
    }
  }
  add('README.txt', 'Asset capture for ' + hdr.title + (game ? ' (profile #' + game.n + ' ' + game.name + ')' : '') + '\n\n' +
    'palettes/   candidate 16-colour BGR555 palettes (' + rep.palettes + ') as JSON and a swatch PNG\n' +
    'graphics/   largest tile-like regions as raw .bin plus 4bpp and 2bpp greyscale preview sheets (apply a palette from palettes/ in the Graphics tab). Bit depth is a guess: check the sheet that looks right\n' +
    'audio/      BRR samples found by structure (' + rep.samples + ') as .wav and raw .brr\n' +
    'text/       readable ASCII strings (' + rep.strings + '); many games use their own text encoding, which this scan cannot read\n' +
    'code/       vectors and first instructions at RESET\n' + (rep.streams ? 'graphics/decoded/  ' + rep.streams + ' decompressed streams\n' : '') +
    '\nEverything here is found by heuristics from the raw ROM; a file existing does not prove it is a game asset.\n');
  return { files, report: rep };
};
Core.Capture = Cap;
if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof window !== 'undefined' ? window : globalThis);
