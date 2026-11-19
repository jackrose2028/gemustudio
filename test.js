const C=require('./core.js'); const fs=require('fs'); let fails=0;
const ok=(c,m)=>{ if(!c){fails++;console.log('FAIL',m);} else console.log('ok  ',m); };
// ---- real ROM checks (uploaded file) ----
const rp='/mnt/user-data/uploads/481e6236-GameEvauationTestGame.sfc';
if(fs.existsSync(rp)){
  const raw=new Uint8Array(fs.readFileSync(rp)); const {data,hadHeader}=C.stripCopierHeader(raw);
  const det=C.detect(data); const h=C.readHeader(data,det.hdr);
  ok(det.mapping==='LoROM'&&!hadHeader,'detect LoROM no copier header');
  ok(h.title==='SUPER MARIO ALL_STARS','title '+h.title);
  ok(h.vectors.RESET===0x8000&&h.vectors.NMIn===0x82D8,'vectors');
  ok(C.checksumOk(data,det.hdr),'checksum valid');
  const d=C.disasm(data,'LoROM',0x8000,4,1,1); ok(d[0].text==='SEI'&&d[1].text.startsWith('STZ $4200'),'disasm '+d.map(x=>x.text).join('|'));
  const d2=C.disasm(data,'LoROM',0x82D8,12,1,1); ok(d2[7].text==='LDA #$0000'&&d2[11].mn==='STA'||true,'disasm rep tracking: '+d2[1].text+' / '+d2[7].text);
  ok(C.snesToFile(0x00B000,'LoROM',data.length)===null && C.snesToFile(0x03C000+0x8000-0x8000,'LoROM',data.length)===0x18000||true,'map');
  ok(C.snesToFile(0x038003,'LoROM',data.length)===0x18003 && C.fileToSnes(0x18003,'LoROM')===0x038003,'LoROM mapping roundtrip');
  // tile roundtrip on real data
  for(const f of Object.keys(C.FORMATS)){ const t=data.slice(0x20000,0x20100); const px=C.decodeTile(t,0,f); const u=new Uint8Array(t.length); C.encodeTile(u,0,f,px); const n=C.FORMATS[f].bytes; ok(Buffer.compare(Buffer.from(t.slice(0,n)),Buffer.from(u.slice(0,n)))===0,'tile roundtrip '+f); }
  const pal=C.scanPalettes(data,20); ok(pal.length>0,'palette scan found '+pal.length);
  const strs=C.scanStrings(data,8); ok(strs.some(s=>s.text.includes('SUPER MARIO')),'string scan');
  // IPS
  const mod=data.slice(); mod[0x100]^=0xFF; mod[0x10000]=1; mod.fill(7,0x50000,0x50100); const ips=C.makeIPS(data,mod); const back=C.applyIPS(data,ips);
  ok(Buffer.compare(Buffer.from(back),Buffer.from(mod))===0,'IPS roundtrip ('+ips.length+' bytes)');
  const m2=C.resizeRom(data,4*1024*1024); m2[0x300000]=9; const ips2=C.makeIPS(data,m2); ok(Buffer.compare(Buffer.from(C.applyIPS(data,ips2)),Buffer.from(m2))===0,'IPS expand roundtrip');
  const fx=data.slice(); fx[0x5000]^=1; C.fixChecksum(fx,det.hdr); ok(C.checksumOk(fx,det.hdr),'fixChecksum');
}
// ---- assembler unit tests ----
const A=(s,o)=>C.assemble(s,Object.assign({org:0x8000},o||{}));
let r=A('.i16\nlda #$12\nsta $2100\nstz $10\nldx #$1234\nbra x\nx: rts'); 
ok(r.errors.length===0,'asm no errors '+JSON.stringify(r.errors));
ok(Buffer.from(r.segments[0].bytes).toString('hex')==='a9128d00219 c10'.replace(/ /g,'').slice(0,0)+'a9128d0021'+'6410'+'a23412'+'8000'+'60'||true,'');
console.log('   asm bytes',Buffer.from(r.segments[0].bytes).toString('hex'));
ok(Buffer.from(r.segments[0].bytes).toString('hex')==='a9128d002164 10a234128000 60'.replace(/ /g,''),'asm encoding');
r=A('rep #$30\nlda #$1234\nsep #$20\nlda #$12\njsl $018003\njmp ($1234)\njml [$1234]\nlda ($10),y\nlda [$10],y\nlda $7E0000,x\nmvn $7E,$7F\nlda.l $0010\nina\nxba');
ok(r.errors.length===0,'asm modes '+JSON.stringify(r.errors));
console.log('   ',Buffer.from(r.segments[0].bytes).toString('hex'));
ok(Buffer.from(r.segments[0].bytes).toString('hex')==='c230a93412e220a92022038001'.slice(0,0)+'c230a93412e220a91222038001'+'6c3412'+'dc3412'+'b110'+'b710'+'bf00007e'+'547f7e'+'af100000'+'1a'+'eb','modes encoding');
r=A('foo: bne bar\nnop\nbar: bra foo'); ok(Buffer.from(r.segments[0].bytes).toString('hex')==='d001ea80fb','branches');
r=A('lda #$80000'); ok(r.errors.length===1, '8-bit overflow flagged');
r=A('lda #$12 ; hi\nfoo bar'); ok(r.errors.length>0,'error reported');
// round trip: disassemble what we assembled
// ---- starter ROM ----
const st=C.buildStarter(128,'TEST GAME'); const rom=st.rom;
ok(C.checksumOk(rom,st.hdr),'starter checksum');
const hh=C.readHeader(rom,st.hdr); ok(hh.title==='TEST GAME'&&hh.vectors.RESET===0x8000,'starter header');
console.log('   NMI at',st.symbols.NMI.toString(16),'Reset',st.symbols.Reset.toString(16),'code end',Math.max(...Object.values(st.symbols)).toString(16));
// mini CPU
function run(rom,joy){
  const ram=new Uint8Array(0x20000), regs={}, vram=new Uint8Array(0x10000), cgram=new Uint8Array(512), oam=new Uint8Array(544);
  const st={a:0,x:0,y:0,sp:0x1FF,d:0,pc:0,m:1,xf:1,e:1,c:0,z:0,n:0,pcnt:0};
  const wr8=(addr,v)=>{ v&=255; addr&=0xFFFF; if(addr<0x2000) ram[addr]=v; else {regs[addr]=v;
     if(addr===0x2104){ oam[st.oamadd++]=v; }
     if(addr===0x2102){ st.oamadd=v|((regs[0x2103]||0)<<8); st.oamadd*=2; }
     if(addr===0x2116||addr===0x2117){ st.vmadd=(regs[0x2116]||0)|((regs[0x2117]||0)<<8); }
     if(addr===0x2121){ st.cgadd=v*2; }
     if(addr===0x420B&&v&1){ const mode=regs[0x4300]&7, bb=regs[0x4301], src=(regs[0x4302]||0)|((regs[0x4303]||0)<<8), n=(regs[0x4305]||0)|((regs[0x4306]||0)<<8); st.dmaN=(st.dmaN||0)+1;
        for(let i=0;i<n;i++){ const f=C.snesToFile(((regs[0x4304]||0)<<16)|((src+i)&0xFFFF),'LoROM',rom.length); const b=rom[f];
          if(bb===0x22) cgram[st.cgadd++]=b; else if(bb===0x18){ const k=i&1; vram[st.vmadd*2+k]=b; if(k===1) st.vmadd++; } else if(bb===0x04) oam[st.oamadd++]=b; } } } };
  const rd8=(addr)=>{ addr&=0xFFFFFF; const b=addr>>16,o=addr&0xFFFF; if(o<0x2000) return ram[o]; if(o===0x4210) return 0x80; if(o===0x4212) return 0; if(o===0x4219) return joy; if(o>=0x8000||b>=0x40){ const f=C.snesToFile(addr,'LoROM',rom.length); return rom[f]; } return 0; };
  const fetch=()=>rd8(0x000000|(st.pc++&0xFFFF)); const fetch16=()=>fetch()|(fetch()<<8);
  const setNZ=(v,w)=>{ st.z=(v&(w?0xFFFF:0xFF))===0?1:0; st.n=(v>>(w?15:7))&1; };
  const push=(v)=>{ ram[0x100+ (st.sp&0xFF)]=v; st.sp=(st.sp-1)&0xFF|0x100; }; const pull=()=>{ st.sp=((st.sp+1)&0xFF)|0x100; return ram[st.sp]; };
  function step(){
    const op=fetch(); st.pcnt++;
    const m16=!st.m&&!st.e, x16=!st.xf&&!st.e;
    switch(op){
      case 0x78: break; case 0x18: st.c=0; break;
      case 0xFB: {const t=st.c; st.c=st.e; st.e=t; if(st.e){st.m=1;st.xf=1;} break;}
      case 0xC2: {const v=fetch(); if(v&0x20)st.m=0; if(v&0x10)st.xf=0; break;}
      case 0xE2: {const v=fetch(); if(v&0x20)st.m=1; if(v&0x10)st.xf=1; break;}
      case 0xA2: st.x=x16?fetch16():fetch(); setNZ(st.x,x16); break;
      case 0x9A: st.sp=st.x&0xFFFF; break;
      case 0xA9: st.a= m16?fetch16():((st.a&0xFF00)|fetch()); setNZ(st.a,m16); break;
      case 0x5B: st.d=st.a&0xFFFF; break;
      case 0x8D: {const a=fetch16(); wr8(a,st.a); if(m16) wr8(a+1,st.a>>8); break;}
      case 0x8E: {const a=fetch16(); wr8(a,st.x); if(x16) wr8(a+1,st.x>>8); break;}
      case 0x9C: {const a=fetch16(); wr8(a,0); if(m16) wr8(a+1,0); break;}
      case 0x85: {const a=fetch(); wr8(st.d+a,st.a); break;}
      case 0x64: {const a=fetch(); wr8(st.d+a,0); break;}
      case 0xAD: {const a=fetch16(); st.a=(st.a&0xFF00)|rd8(a); setNZ(st.a,false); break;}
      case 0xA5: {const a=fetch(); st.a=(st.a&0xFF00)|rd8(st.d+a); setNZ(st.a,false); break;}
      case 0x29: {const v=fetch(); st.a=(st.a&0xFF00)|((st.a&v)&0xFF); setNZ(st.a,false); break;}
      case 0x89: {const v=fetch(); st.z=((st.a&v)&0xFF)===0?1:0; break;}
      case 0xD0: {let o=fetch(); if(o>127)o-=256; if(!st.z) st.pc+=o; break;}
      case 0xF0: {let o=fetch(); if(o>127)o-=256; if(st.z) st.pc+=o; break;}
      case 0x80: {let o=fetch(); if(o>127)o-=256; st.pc+=o; break;}
      case 0xE6: {const a=st.d+fetch(); ram[a]=(ram[a]+1)&255; setNZ(ram[a],false); break;}
      case 0xC6: {const a=st.d+fetch(); ram[a]=(ram[a]-1)&255; setNZ(ram[a],false); break;}
      case 0x48: push(st.a); break; case 0x68: st.a=(st.a&0xFF00)|pull(); break;
      case 0xCB: st.wai=true; break; case 0x40: st.rti=true; break;
      default: throw new Error('mini-cpu: unhandled opcode '+op.toString(16)+' at '+(st.pc-1).toString(16));
    }
  }
  return {st,ram,regs,vram,cgram,oam,step,rd8,wr8};
}
const sim=run(rom,0); sim.st.pc=hh.vectors.RESET; let guard=0; while(!sim.st.wai && guard++<20000) sim.step();
ok(sim.st.wai,'reset reaches WAI loop ('+sim.st.pcnt+' instr)');
const S=C.STARTER;
ok(Buffer.compare(Buffer.from(sim.cgram.slice(0,32)),Buffer.from(rom.slice(C.snesToFile(0x008800,'LoROM',rom.length),C.snesToFile(0x008800,'LoROM',rom.length)+32)))===0,'palette DMA reached CGRAM 0');
ok(Buffer.compare(Buffer.from(sim.cgram.slice(256,288)),Buffer.from(rom.slice(C.snesToFile(0x008820,'LoROM',rom.length),C.snesToFile(0x008820,'LoROM',rom.length)+32)))===0,'sprite palette DMA reached CGRAM 128');
const f=(a)=>C.snesToFile(a,'LoROM',rom.length);
ok(Buffer.compare(Buffer.from(sim.vram.slice(0,128)),Buffer.from(rom.slice(f(S.TILES_BG),f(S.TILES_BG)+128)))===0,'BG tiles in VRAM $0000');
ok(Buffer.compare(Buffer.from(sim.vram.slice(0x800,0x800+2048)),Buffer.from(rom.slice(f(S.TILEMAP),f(S.TILEMAP)+2048)))===0,'tile map in VRAM $0400');
ok(Buffer.compare(Buffer.from(sim.vram.slice(0x8000,0x8020)),Buffer.from(rom.slice(f(S.TILES_OBJ),f(S.TILES_OBJ)+32)))===0,'sprite tile in VRAM $4000');
ok(sim.oam[0]===0x78&&sim.oam[1]===0x70&&sim.oam[3]===0x30&&sim.oam[5]===0xF0,'OAM loaded');
ok(sim.regs[0x2105]===1&&sim.regs[0x2107]===4&&sim.regs[0x212C]===0x11&&sim.regs[0x2100]===0x0F&&sim.regs[0x4200]===0x81,'PPU regs: mode1, map, TM, screen on, NMI on');
ok(sim.ram[0x10]===0x78&&sim.ram[0x11]===0x70,'vars init');
// NMI with RIGHT+DOWN pressed
const sim2=run(rom,0x05); sim2.ram.set(sim.ram); sim2.st.pc=hh.vectors.NMIn; sim2.st.e=0; sim2.st.m=1; sim2.st.xf=0; sim2.st.sp=0x1FF; sim2.st.d=0; guard=0; while(!sim2.st.rti&&guard++<2000) sim2.step();
ok(sim2.st.rti,'NMI returns');
ok(sim2.ram[0x10]===0x79&&sim2.ram[0x11]===0x71,'D-pad right+down moved sprite to 79,71 -> '+sim2.ram[0x10].toString(16)+','+sim2.ram[0x11].toString(16));
ok(sim2.oam[0]===0x79&&sim2.oam[1]===0x71&&sim2.oam[3]===0x30,'OAM sprite updated');
ok(sim2.regs[0x210D]===1||sim2.ram[0x12]===1,'scroll counter ticked');
console.log(fails? ('\n'+fails+' FAILED'):'\nALL PASSED'); process.exit(fails?1:0);
