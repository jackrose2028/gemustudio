// Run against the full 325-ROM set in /tmp/roms_all
const C=require('./core.js'); require('./codecs.js'); require('./games.js'); const G=C.Games; const fs=require('fs'); let fails=0;
const ok=(c,m)=>{ if(!c){fails++;console.log('FAIL',m);} else console.log('ok  ',m); };
const files=fs.readdirSync('/tmp/roms_all'); let chk=0,ident=0,unm=[],mapBad=[];
const dumps=new Set(); G.LIST.forEach(g=>g.dumps.forEach(d=>dumps.add(d.crc)));
for(const f of files){ const d=new Uint8Array(fs.readFileSync('/tmp/roms_all/'+f)); const det=C.detect(d); if(C.checksumOk(d,det.hdr)) chk++; const r=G.identify(d,det.hdr,f); if(r.confidence==='exact') ident++; else unm.push(f.slice(0,50)); if(r.game&&r.game.mappingVerified&&r.game.dumps.length===1&&r.game.mapping!==det.mapping) mapBad.push(f); }
ok(chk===files.length,'checksum valid on all '+files.length+' ROMs');
ok(ident===dumps.size||ident>=dumps.size,'exact-CRC identified '+ident+' ROMs (profile dumps: '+dumps.size+')');
ok(mapBad.length===0,'profile mapping == detected mapping for all single-dump profiles '+mapBad.join(','));
// every requested game 51..150 with a dump identifies to its own number (patched copy too)
let wrong=[]; for(const g of G.LIST.filter(x=>x.n>=51&&x.dumps.length)){ const f=g.dumps[0].file.replace(/\.sfc$/,'')+'.sfc'; const p='/tmp/roms_all/'+f; if(!fs.existsSync(p)){wrong.push('nofile '+g.n);continue;} const d=new Uint8Array(fs.readFileSync(p)); const det=C.detect(d); const r=G.identify(d,det.hdr,'x.sfc'); if(!r.game||r.game.n!==g.n) wrong.push(g.n+'->'+(r.game&&r.game.n)); d[0x2000]^=0x55; const r2=G.identify(d,det.hdr,'x.sfc'); if(!r2.game||(r2.game.n!==g.n)) wrong.push('patched '+g.n+'->'+(r2.game&&r2.game.n)); }
ok(wrong.length===0,'games 51-150 (with dumps) identify correctly, also when patched: '+wrong.join(' '));
console.log('with dumps in 51-150:',G.LIST.filter(x=>x.n>=51&&x.dumps.length).length,'(games 51-300); title-only:',G.LIST.filter(x=>x.n>=51&&!x.dumps.length).length);
console.log('FAILS',fails); process.exit(fails?1:0);
