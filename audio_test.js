const C=require('./core.js'); require('./nes.js'); require('./audio.js'); const A=C.Audio; const fs=require('fs'); let fails=0;
const ok=(c,m)=>{ if(!c){fails++;console.log('FAIL',m);} else console.log('ok  ',m); };
// synthetic tone: sine + harmonic
const N=3200, pcm=new Int16Array(N); for(let i=0;i<N;i++) pcm[i]=Math.round(9000*Math.sin(i*2*Math.PI/64)+3000*Math.sin(i*2*Math.PI/21));
const enc=A.brrEncode(pcm,{}); ok(enc.length===N/16*9 && (enc[enc.length-9]&1)===1,'brr encode size/end flag');
const dec=A.brrDecode(enc,0); ok(dec.pcm.length===N&&dec.ended&&!dec.loop,'brr decode length');
const snr=A.snr(pcm,dec.pcm); ok(snr>25,'brr roundtrip SNR '+snr.toFixed(1)+' dB');
const encL=A.brrEncode(pcm,{loopStart:640}); const dl=A.brrDecode(encL,0); ok(dl.loop&&(encL[(N/16-1)*9]&3)===3&&(encL[40*9]>>2&3)===0,'loop flag set + loop block uses filter 0');
const f0=A.brrEncode(pcm,{filter:0}); ok(A.snr(pcm,A.brrDecode(f0,0).pcm)<snr,'forced filter0 worse than auto');
// known decode vector: silence and simple block
const blk=new Uint8Array(9); blk[0]=0x00|1; ok(A.brrDecode(blk,0).pcm.every(v=>v===0),'zero block decodes to silence');
const b2=new Uint8Array(9); b2[0]=(4<<4)|1; b2[1]=0x70; // first nibble 7 << 4 >> 1 = 56 *2 = 112
ok(A.brrDecode(b2,0).pcm[0]===112,'range shift math');
// wav
const w=A.writeWav(pcm,32000,{start:640}); const r=A.readWav(w); ok(r.rate===32000&&r.pcm.length===N&&r.pcm[100]===pcm[100]&&r.loopStart===640,'wav roundtrip + loop chunk');
ok(A.readWav(new Uint8Array(10))===null,'readWav rejects junk');
// dpcm
const dp=A.dpcmEncode(Int16Array.from({length:4096},(_, i)=>Math.round(8000*Math.sin(i*2*Math.PI/200))),512); const dd=A.dpcmDecode(dp,0,512);
const ref=Int16Array.from({length:4096},(_, i)=>Math.round(8000*Math.sin(i*2*Math.PI/200))); ok(A.snr(ref,dd)>8,'dpcm roundtrip snr '+A.snr(ref,dd).toFixed(1));
ok(Math.abs(A.dpcmRate(15)-33144)<5&&Math.abs(A.dpcmRate(0)-4181.7)<1,'dpcm rates');
// raw
for(const f of ['u8','s8','s16']){ const e=A.rawEncode(pcm,f,200); const dd2=A.rawDecode(e,0,e.length,f); ok(A.snr(pcm.slice(0,dd2.length),dd2)>35,'raw '+f); }
// edits
ok(A.reverse(Int16Array.of(1,2,3))[0]===3&&A.gain(Int16Array.of(30000),2)[0]===32767&&A.resample(Int16Array.of(0,100),2).length===4,'edit helpers');
// scanner on a synthetic ROM + the real ROM
const rom=new Uint8Array(65536); for(let i=0;i<rom.length;i++) rom[i]=(i*2654435761>>>13)&255; rom.set(enc,0x4000);
const sc=A.scanBrr(rom,{minBlocks:8}); ok(sc.some(s=>s.off===0x4000&&s.blocks===N/16),'scanner finds embedded sample among noise ('+sc.length+' hits)');
const rp='/mnt/user-data/uploads/481e6236-GameEvauationTestGame.sfc';
if(fs.existsSync(rp)){ const d=new Uint8Array(fs.readFileSync(rp)); const t=Date.now(); const s=A.scanBrr(d); console.log('real ROM scan: '+s.length+' candidates in '+(Date.now()-t)+' ms'); console.log(s.slice(0,8)); ok(true,'real-ROM scan ran'); }
console.log('FAILS',fails); process.exit(fails?1:0);
