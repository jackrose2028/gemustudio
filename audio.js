/* Audio support for SNES Studio: SNES BRR, NES DPCM, raw PCM, WAV. Extends SnesCore. No DOM. */
(function (root) {
'use strict';
const Core = root.SnesCore || (typeof require !== 'undefined' ? require('./core.js') : null);
const A = {};
const clamp16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);
const wrap15 = (v) => ((v & 0x7FFF) ^ 0x4000) - 0x4000;

/* ---------- BRR (SNES) ---------- */
// filter prediction in the 15-bit domain used by the S-DSP
function pred(f, p1, p2) {
  switch (f) {
    case 1: return p1 + ((-p1) >> 4);
    case 2: return (p1 << 1) + ((-(p1 * 3)) >> 5) - p2 + (p2 >> 4);
    case 3: return (p1 << 1) + ((-(p1 * 13)) >> 6) - p2 + ((p2 * 3) >> 4);
    default: return 0;
  }
}
// Decode one chain starting at off. Stops at an end-flag block or after maxBlocks.
A.brrDecode = function (d, off, maxBlocks) {
  maxBlocks = maxBlocks || 20000; const out = []; let p1 = 0, p2 = 0, n = 0, loop = false, end = false;
  while (n < maxBlocks && off + n * 9 + 9 <= d.length) {
    const o = off + n * 9, h = d[o], range = h >> 4, f = (h >> 2) & 3;
    for (let i = 0; i < 16; i++) {
      const b = d[o + 1 + (i >> 1)]; let s = (i & 1) ? b & 15 : b >> 4; if (s > 7) s -= 16;
      s = range <= 12 ? (s << range) >> 1 : (s < 0 ? -2048 : 0);
      s = wrap15(clamp16(s + pred(f, p1, p2))); p2 = p1; p1 = s; out.push(s * 2);
    }
    n++; if (h & 1) { loop = !!(h & 2); end = true; break; }
  }
  return { pcm: Int16Array.from(out), blocks: n, loop, ended: end, bytes: n * 9 };
};
// Encode 16-bit PCM to BRR. opts: {loopStart: sample index or -1, filter: 'auto'|0..3}
A.brrEncode = function (pcm, opts) {
  opts = opts || {}; const loopStart = opts.loopStart >= 0 ? opts.loopStart : -1;
  const nBlocks = Math.max(1, Math.ceil(pcm.length / 16)), out = new Uint8Array(nBlocks * 9); let p1 = 0, p2 = 0;
  const loopBlock = loopStart >= 0 ? Math.floor(loopStart / 16) : -1;
  for (let b = 0; b < nBlocks; b++) {
    const t = new Int32Array(16); for (let i = 0; i < 16; i++) t[i] = (pcm[b * 16 + i] || 0) >> 1; // 15-bit targets
    const forceF0 = b === 0 || b === loopBlock;
    const fl = forceF0 ? [0] : opts.filter !== undefined && opts.filter !== 'auto' ? [opts.filter] : [0, 1, 2, 3];
    let best = null;
    for (const f of fl) for (let range = 0; range <= 12; range++) {
      let q1 = p1, q2 = p2, err = 0; const nib = new Int8Array(16);
      for (let i = 0; i < 16; i++) {
        const pr = pred(f, q1, q2); let n = Math.round(((t[i] - pr) * 2) / (1 << range)); n = n > 7 ? 7 : n < -8 ? -8 : n;
        const dv = wrap15(clamp16(((n << range) >> 1) + pr)); const e = t[i] - dv; err += e * e; nib[i] = n; q2 = q1; q1 = dv;
      }
      if (!best || err < best.err) best = { err, f, range, nib, q1, q2 };
    }
    const o = b * 9; out[o] = (best.range << 4) | (best.f << 2);
    for (let i = 0; i < 16; i += 2) out[o + 1 + (i >> 1)] = ((best.nib[i] & 15) << 4) | (best.nib[i + 1] & 15);
    p1 = best.q1; p2 = best.q2;
  }
  out[(nBlocks - 1) * 9] |= 1 | (loopStart >= 0 ? 2 : 0);
  return out;
};
// Find plausible BRR samples. Heuristic: valid header chain ending in an end flag, first block filter 0, and a smooth-ish decoded waveform.
A.scanBrr = function (d, opts) {
  opts = opts || {}; const minBlocks = opts.minBlocks || 24, maxRough = opts.maxRough || 0.7, maxBlocks = opts.maxBlocks || 4000, res = [];
  for (let o = 0; o + minBlocks * 9 <= d.length; o++) {
    const h0 = d[o]; if ((h0 >> 4) > 12 || ((h0 >> 2) & 3) !== 0 || (h0 & 1)) continue;
    let n = 0, ok = true, f13 = 0; const need = Math.min(maxBlocks, Math.floor((d.length - o) / 9));
    for (; n < need; n++) { const h = d[o + n * 9]; if ((h >> 4) > 12) { ok = false; break; } if (((h >> 2) & 3) !== 0) f13++; if (h & 1) { n++; break; } }
    if (!ok || n < minBlocks || !(d[o + (n - 1) * 9] & 1)) continue;
    if (f13 < n * 0.15) continue; // real encoders use filters 1-3 a lot
    const dec = A.brrDecode(d, o, n); const pcm = dec.pcm; let sa = 0, sd = 0, clip = 0, peak = 0;
    for (let i = 1; i < pcm.length; i++) { sa += Math.abs(pcm[i]); sd += Math.abs(pcm[i] - pcm[i - 1]); const a = Math.abs(pcm[i]); if (a > peak) peak = a; if (a >= 32000) clip++; }
    if (peak < 300 || clip / pcm.length > 0.02) continue;
    const rough = sd / (sa + 1); if (rough > maxRough) continue; // white-ish noise is almost always not audio
    res.push({ off: o, blocks: n, bytes: n * 9, loop: !!(d[o + (n - 1) * 9] & 2), peak, rough: +rough.toFixed(3), score: +(1 - rough).toFixed(3) });
    o += n * 9 - 1;
  }
  return res;
};

/* ---------- DPCM (NES DMC) ---------- */
A.DPCM_PERIODS = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];
A.dpcmRate = (idx) => 1789773 / A.DPCM_PERIODS[idx & 15];
A.dpcmDecode = function (d, off, len, start) {
  let c = start === undefined ? 64 : start; const out = new Int16Array(len * 8);
  for (let i = 0; i < len; i++) { const b = d[off + i]; for (let k = 0; k < 8; k++) { if ((b >> k) & 1) { if (c <= 125) c += 2; } else if (c >= 2) c -= 2; out[i * 8 + k] = (c - 64) * 512; } }
  return out;
};
A.dpcmEncode = function (pcm, bytes) {
  let c = 64; const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) { let v = 0; for (let k = 0; k < 8; k++) { const t = (pcm[i * 8 + k] || 0) / 512 + 64; if (c + 2 <= 127 && (t > c + 1 || c < 2)) { v |= 1 << k; c += 2; } else if (c >= 2) c -= 2; else { v |= 1 << k; c += 2; } } out[i] = v; }
  return out;
};

/* ---------- raw PCM ---------- */
A.RAW = { u8: { bytes: 1 }, s8: { bytes: 1 }, s16: { bytes: 2 } };
A.rawDecode = function (d, off, len, fmt) {
  const w = A.RAW[fmt].bytes, n = Math.floor(len / w), out = new Int16Array(n);
  for (let i = 0; i < n; i++) { const o = off + i * w; out[i] = fmt === 'u8' ? (d[o] - 128) * 256 : fmt === 's8' ? ((d[o] << 24) >> 24) * 256 : ((d[o] | d[o + 1] << 8) << 16) >> 16; }
  return out;
};
A.rawEncode = function (pcm, fmt, count) {
  const w = A.RAW[fmt].bytes, out = new Uint8Array(count * w);
  for (let i = 0; i < count; i++) { const v = pcm[i] || 0; if (fmt === 'u8') out[i] = Math.max(0, Math.min(255, Math.round(v / 256) + 128)); else if (fmt === 's8') out[i] = Math.max(-128, Math.min(127, Math.round(v / 256))) & 255; else { out[i * 2] = v & 255; out[i * 2 + 1] = (v >> 8) & 255; } }
  return out;
};

/* ---------- WAV ---------- */
A.writeWav = function (pcm, rate, loop) {
  const smpl = loop && loop.start >= 0 ? 68 : 0, dl = pcm.length * 2, buf = new Uint8Array(44 + dl + smpl), dv = new DataView(buf.buffer);
  const tag = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + dl + smpl, true); tag(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); tag(36, 'data'); dv.setUint32(40, dl, true);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, pcm[i], true);
  if (smpl) { const o = 44 + dl; tag(o, 'smpl'); dv.setUint32(o + 4, 60, true); dv.setUint32(o + 8, 0, true); dv.setUint32(o + 12, 0, true); dv.setUint32(o + 16, Math.round(1e9 / rate), true); dv.setUint32(o + 20, 60, true); dv.setUint32(o + 36, 1, true); dv.setUint32(o + 52, loop.start, true); dv.setUint32(o + 56, pcm.length - 1, true); }
  return buf;
};
A.readWav = function (b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (b.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let o = 12, fmt = null, data = null, loop = -1;
  while (o + 8 <= b.length) { const id = tag(o), sz = dv.getUint32(o + 4, true), body = o + 8;
    if (id === 'fmt ') fmt = { code: dv.getUint16(body, true), ch: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    else if (id === 'data') data = { o: body, n: Math.min(sz, b.length - body) };
    else if (id === 'smpl' && sz >= 60 && dv.getUint32(body + 28, true) > 0) loop = dv.getUint32(body + 44, true);
    o = body + sz + (sz & 1); }
  if (!fmt || !data) return null;
  if (!(fmt.code === 1 || fmt.code === 3 || fmt.code === 0xFFFE)) throw new Error('unsupported WAV encoding ' + fmt.code);
  const bps = fmt.bits >> 3, frames = Math.floor(data.n / (bps * fmt.ch)), out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) { let acc = 0; for (let c = 0; c < fmt.ch; c++) { const p = data.o + (i * fmt.ch + c) * bps; let v;
      if (fmt.code === 3 && fmt.bits === 32) v = dv.getFloat32(p, true) * 32767; else if (fmt.bits === 8) v = (b[p] - 128) * 256; else if (fmt.bits === 16) v = dv.getInt16(p, true); else if (fmt.bits === 24) v = ((b[p] | b[p + 1] << 8 | b[p + 2] << 16) << 8 >> 8) / 256; else if (fmt.bits === 32) v = dv.getInt32(p, true) / 65536; else throw new Error('unsupported bit depth ' + fmt.bits);
      acc += v; } out[i] = Math.max(-32768, Math.min(32767, Math.round(acc / fmt.ch))); }
  return { pcm: out, rate: fmt.rate, loopStart: loop };
};

/* ---------- editing helpers ---------- */
A.resample = function (pcm, ratio) { // ratio = newLen/oldLen
  const n = Math.max(1, Math.round(pcm.length * ratio)), out = new Int16Array(n);
  for (let i = 0; i < n; i++) { const x = i / ratio, i0 = Math.floor(x), f = x - i0, a = pcm[Math.min(i0, pcm.length - 1)], b = pcm[Math.min(i0 + 1, pcm.length - 1)]; out[i] = Math.round(a + (b - a) * f); }
  return out;
};
A.gain = (pcm, g) => pcm.map((v) => Math.max(-32768, Math.min(32767, Math.round(v * g))));
A.reverse = (pcm) => Int16Array.from(pcm).reverse();
A.normalize = (pcm, peak) => { let m = 1; for (const v of pcm) if (Math.abs(v) > m) m = Math.abs(v); return A.gain(pcm, (peak || 30000) / m); };
A.fade = function (pcm, inN, outN) { const o = Int16Array.from(pcm), n = o.length; for (let i = 0; i < Math.min(inN, n); i++) o[i] = Math.round(o[i] * i / inN); for (let i = 0; i < Math.min(outN, n); i++) o[n - 1 - i] = Math.round(o[n - 1 - i] * i / outN); return o; };
A.snr = (a, b) => { let s = 0, e = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) { s += a[i] * a[i]; e += (a[i] - b[i]) ** 2; } return 10 * Math.log10((s + 1) / (e + 1)); };

Core.Audio = A;
if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof window !== 'undefined' ? window : globalThis);
