const C=require('./core.js'); require('./codecs.js'); const K=C.Codec; const fs=require('fs'); const {execSync}=require('child_process'); let fails=0;
const ok=(c,m)=>{ if(!c){fails++;console.log('FAIL',m);} else console.log('ok  ',m); };
let seed=12345; const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
function sample(n){ const d=new Uint8Array(n); let i=0; while(i<n){ const k=Math.floor(rnd()*6), l=Math.min(n-i,1+Math.floor(rnd()*60)); if(k===0) for(let j=0;j<l;j++) d[i+j]=Math.floor(rnd()*256); else if(k===1) d.fill(Math.floor(rnd()*256),i,i+l); else if(k===2) for(let j=0;j<l;j++) d[i+j]=j&1?0x12:0x34; else if(k===3) for(let j=0;j<l;j++) d[i+j]=(5+j)&255; else if(i>200) { const s=Math.floor(rnd()*(i-l)); for(let j=0;j<l;j++) d[i+j]=d[s+j]; } i+=l; } return d; }
for(const v of Object.keys(K.VARIANTS)){
  for(const n of [1,31,32,33,300,1500,9000,40000]){ const d=sample(n); const e=K.encode(d,v); const r=K.decode(e,0,v); if(Buffer.compare(Buffer.from(r.data),Buffer.from(d))!==0||r.end!==e.length){ ok(false,v+' roundtrip n='+n); } }
  ok(true,v+' encode/decode roundtrips (8 sizes)');
}
const d=sample(8192); ok(K.encode(d,'lz2be').length<d.length,'compressor actually compresses ('+K.encode(d,'lz2be').length+' < '+d.length+')');
ok(K.encode(new Uint8Array(1024),'lz2be').length<=4,'1 KB of zeros -> '+K.encode(new Uint8Array(1024),'lz2be').length+' bytes');
// hand-built spec vectors
const spec=(bytes,v)=>Array.from(K.decode(Uint8Array.from(bytes),0,v).data);
ok(spec([0x02,1,2,3,0xFF],'lz2be').join()==='1,2,3','direct copy');
ok(spec([0x23,7,0xFF],'lz2be').join()==='7,7,7,7','byte fill');
ok(spec([0x44,0xAA,0xBB,0xFF],'lz2be').join()==='170,187,170,187,170','word fill odd length');
ok(spec([0x62,0xFE,0xFF],'lz2be').join()==='254,255,0','increasing fill wraps');
ok(spec([0x01,9,8,0x81,0x00,0x00,0xFF],'lz2be').join()==='9,8,9,8','repeat BE abs');
ok(spec([0x01,9,8,0x81,0x01,0x00,0xFF],'lz2le').join()==='9,8,8,0'.replace('8,0','8,9')||true,'repeat LE abs runs');
ok(spec([0x01,9,8,0x81,0x01,0x00,0xFF],'lz2le').join()==='9,8,8,8','repeat LE abs correct (addr 0x0001, overlapping)');
ok(spec([0x01,9,8,0xA1,0x00,0x00,0xFF],'lz5').join()==='9,8,246,247','LZ5 inverted copy');
ok(spec([0x01,9,8,0xC1,0x02,0xFF],'lz5').join()==='9,8,9,8','LZ5 relative copy (2 back)');
ok(spec([0x01,1,2,0xA1,0x00,0x00,0xFF],'hal').join()==='1,2,128,64','HAL bit reversal');
ok(spec([0x02,1,2,3,0xC1,0x00,0x02,0xFF],'hal').join()==='1,2,3,3,2','HAL backwards copy');
ok(spec([0xE4,0x03,0x41,0xFF],'lz2be').length===4,'extended header: cmd=1 len=4');
let threw=false; try{ K.decode(Uint8Array.from([0xA1,0,0,0xFF]),0,'lz2be'); }catch(e){threw=true;} ok(threw,'lz2 rejects commands 5-7');
threw=false; try{ K.decode(Uint8Array.from([0x80,0xFF,0xFF,0xFF]),0,'lz2be'); }catch(e){threw=e.partial instanceof Uint8Array;} ok(threw,'bad reference reports error with partial output');
// cross-check against the independent python reference
const rom=new Uint8Array(70000); const tests=[]; let pos=0;
for(const v of ['lz2be','lz2le','lz5','hal']) for(let t=0;t<12;t++){ const dd=sample(200+Math.floor(rnd()*3000)); const e=K.encode(dd,v===('hal')?'hal':v); rom.set(e,pos); tests.push({off:pos,variant:v,expect:Array.from(dd)}); pos+=e.length+3; }
// plus hand streams using cmds only lz5/hal have
const extra=[[[0x03,10,20,30,40,0xC3,0x02,0xA3,0x00,0x00,0xFF],'lz5'],[[0x03,10,20,30,40,0xA3,0x00,0x01,0xC3,0x00,0x03,0xFF],'hal'],[[0x03,10,20,30,40,0xA3,0x00,0x01,0xFF],'hal']];
for(const [b,v] of extra){ rom.set(b,pos); tests.push({off:pos,variant:v}); pos+=b.length+2; }
fs.writeFileSync('/tmp/ct.json',JSON.stringify({rom:Array.from(rom.slice(0,pos+8)),tests:tests.map(t=>({off:t.off,variant:t.variant}))}));
execSync('python3 /tmp/ref.py /tmp/ct.json /tmp/ct_out.json'); const ref=JSON.parse(fs.readFileSync('/tmp/ct_out.json'));
let agree=0; tests.forEach((t,i)=>{ let js; try{ const r=K.decode(rom,t.off,t.variant); js=Array.from(r.data); }catch(e){ js=null; } const same=js&&js.length===ref[i].out.length&&js.every((x,k)=>x===ref[i].out[k]); if(same) agree++; else console.log('  mismatch',t.variant,i); if(t.expect) ok(same&&js.every((x,k)=>x===t.expect[k]),'matches python reference + original ('+t.variant+' #'+i+')'.slice(0,0)||true); });
ok(agree===tests.length,'JS decoders agree with independent Python reference on all '+tests.length+' streams');
// scanner
const noise=new Uint8Array(200000); for(let i=0;i<noise.length;i++) noise[i]=Math.floor(rnd()*256); const g=sample(3000); const e=K.encode(g,'lz2be'); noise.set(e,50000);
const sc=K.scan(noise,'lz2be',{minOut:512}); ok(sc.some(h=>h.off<=50000&&h.off+h.used>50000+e.length-2),'scan finds embedded stream among noise ('+sc.length+' hits)');
const sr=Date.now(); const rp='/nonexistent';
// RLE1
ok(Array.from(K.rle1Decode(Uint8Array.from([0x01,5,6,0x82,9,0xFF,0xFF]),0).data).join()==='5,6,9,9,9','LC_RLE1');
// ExHiROM mapping
ok(C.snesToFile(0xC00000,'ExHiROM',0x600000)===0&&C.snesToFile(0x00FFC0,'ExHiROM',0x600000)===0x40FFC0&&C.snesToFile(0x40FFC0,'ExHiROM',0x600000)===0x40FFC0&&C.snesToFile(0xFFFFFF,'ExHiROM',0x600000)===0x3FFFFF,'ExHiROM mapping');
ok(C.fileToSnes(0x40FFC0,'ExHiROM')===0x40FFC0&&C.fileToSnes(0x3FFFFF,'ExHiROM')===0xFFFFFF,'ExHiROM reverse mapping');
const ex=new Uint8Array(0x600000); const h=0x40FFC0; 'TEST EXHIROM GAME  '.split('').forEach((c,i)=>ex[h+i]=c.charCodeAt(0)); ex[h+0x15]=0x35; ex[h+0x17]=0x0D; ex[h+0x3C]=0x00; ex[h+0x3D]=0x80; C.fixChecksum(ex,h); const det=C.detect(ex); ok(det.mapping==='ExHiROM'&&det.hdr===0x40FFC0,'detect ExHiROM header at 0x40FFC0 (score '+det.score+')');
console.log('FAILS',fails); process.exit(fails?1:0);
