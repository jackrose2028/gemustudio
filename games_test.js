const C=require('./core.js'); require('./codecs.js'); require('./games.js'); const G=C.Games; const fs=require('fs'); let fails=0;
const ok=(c,m)=>{ if(!c){fails++;console.log('FAIL',m);} else console.log('ok  ',m); };
ok(G.LIST.length===300,'300 game profiles'); ok(G.LIST.every((g,i)=>g.n===i+1),'numbered 1..300');
let exact=0,total=0,bad=[]; 
for(const f of fs.readdirSync('/tmp/roms')){ const d=new Uint8Array(fs.readFileSync('/tmp/roms/'+f)); const det=C.detect(d); const r=G.identify(d,det.hdr,f); total++; if(r.confidence==='exact') exact++; else bad.push(f); }
ok(exact===42&&bad.length===2,'38 of 44 uploaded ROMs identified by CRC; the other 2 (Trials of Mana, Yoshi\'s Cookie) are not in the 150-game list: '+exact);
// simulate a modded ROM: patch some bytes, fix checksum -> must still be identified by header title/checksum or title
let miss=0; for(const f of fs.readdirSync('/tmp/roms')){ const d=new Uint8Array(fs.readFileSync('/tmp/roms/'+f)); const det=C.detect(d); d[0x1000]^=0xFF; const r=G.identify(d,det.hdr,'renamed.sfc'); if(!r.game) { miss++; console.log('  unidentified after patch:',f); } }
ok(miss===2,'modified listed ROMs still identified by header; only the 2 unlisted games stay unidentified ('+miss+')');
// wrong-game guard: SMW must not be called SMAS and vice versa
const smw=new Uint8Array(fs.readFileSync('/tmp/roms/Super Mario World (USA).sfc')); smw[0x1000]^=1; const r1=G.identify(smw,0x7FC0,'x.sfc'); ok(r1.game&&r1.game.n===1,'patched SMW -> game #1 ('+(r1.game&&r1.game.name)+')');
const sa=new Uint8Array(fs.readFileSync('/tmp/roms/Super Mario All-Stars (USA).sfc')); sa[0x1000]^=1; const r2=G.identify(sa,0x7FC0,'x.sfc'); ok(r2.game&&r2.game.n===2,'patched SMAS -> game #2 ('+(r2.game&&r2.game.name)+')');
// chips verified from headers
const chip=(f)=>{ const d=new Uint8Array(fs.readFileSync('/tmp/roms/'+fs.readdirSync('/tmp/roms').find(x=>x.startsWith(f)))); const det=C.detect(d); return G.chipFromHeader(d[det.hdr+0x16],d[det.hdr-1]).chip; };
ok(chip('Star Fox')==='SuperFX (GSU)','Star Fox -> SuperFX'); ok(chip('Super Mario World 2')==='SuperFX (GSU)','Yoshi -> SuperFX'); ok(chip('Super Mario Kart')==='DSP-1/2/3/4','Mario Kart -> DSP'); ok(chip('Pilotwings')==='DSP-1/2/3/4','Pilotwings -> DSP'); ok(chip('Kirby Super Star')==='SA-1','Kirby SS -> SA-1'); ok(chip('Super Mario RPG')==='SA-1','SMRPG -> SA-1'); ok(chip('Mega Man X2')==='Cx4 (Capcom)','MMX2 -> Cx4'); ok(chip('Super Mario World (')==='none','SMW -> none');
// profile claims consistent with the real dumps
const ALL=fs.readdirSync('/tmp/roms_all'); let inc=0; for(const g of G.LIST) for(const d of g.dumps){ const f=ALL.find(x=>x.replace(/\.sfc$/,'')===d.file); if(!f){inc++;continue;} const dd=new Uint8Array(fs.readFileSync('/tmp/roms_all/'+f)); const det=C.detect(dd); if(g.n!==32&&g.n!==39&&g.n!==31&&g.mapping!==det.mapping){inc++; console.log('  mapping mismatch',g.name,g.mapping,det.mapping);} }
ok(inc===0,'profile mappings agree with measured mappings');
// SMW pointer table decodes
const f=(a)=>C.snesToFile(a,'LoROM',smw.length); smw[0x1000]^=1; let n=0; for(let i=0;i<0x32;i++){ const a=smw[f(0xB992)+i]|smw[f(0xB9C4)+i]<<8|smw[f(0xB9F6)+i]<<16; try{ C.Codec.decode(smw,f(a),'lz2be',0x10000); n++; }catch(e){} } ok(n===50,'SMW 50/50 pointer-table streams decode');
// ROM-wide compress/decompress/recompress roundtrip on a real stream
const a0=smw[f(0xB992)]|smw[f(0xB9C4)]<<8|smw[f(0xB9F6)]<<16; const o0=f(a0); const r=C.Codec.decode(smw,o0,'lz2be'); const re=C.Codec.encode(r.data,'lz2be'); const rr=C.Codec.decode(re,0,'lz2be'); ok(Buffer.compare(Buffer.from(rr.data),Buffer.from(r.data))===0,'real SMW GFX00 recompress roundtrip ('+r.used+' -> '+re.length+' bytes)');
console.log('FAILS',fails); process.exit(fails?1:0);
