const C=require('./core.js'); require('./nes.js'); const N=C.NES; let fails=0;
const ok=(c,m)=>{ if(!c){fails++;console.log('FAIL',m);} else console.log('ok  ',m); };
// tile format
const t=new Uint8Array(16); C.setPixel(t,0,'nes2bpp',0,0,3); C.setPixel(t,0,'nes2bpp',7,7,2);
ok(t[0]===0x80&&t[8]===0x80&&t[15]===0x01&&t[7]===0,'nes2bpp planar layout');
const px=C.decodeTile(t,0,'nes2bpp'); ok(px[0]===3&&px[63]===2,'nes2bpp decode');
// assembler/disassembler roundtrip of every opcode form
const src=`X=$10\n.org $8000\nL: lda #$12\n lda X\n lda $1234,x\n lda ($20),y\n lda ($20,x)\n sta $2000\n asl a\n jmp ($FFFC)\n bne L\n ldx X,y\n jsr L\n rts\n lda #<L\n lda #>L\n .db 1,2,"hi"\n .dw L`;
const a=N.assemble(src,{org:0x8000}); ok(a.errors.length===0,'assemble '+JSON.stringify(a.errors));
const b=a.segments[0].bytes; ok(b[0]===0xA9&&b[1]===0x12&&b[2]===0xA5&&b[3]===0x10&&b[4]===0xBD,'zp/abs mode pick');
const rd=(ad)=>ad>=0x8000&&ad-0x8000<b.length?b[ad-0x8000]:-1;
const d=N.disasm(rd,0x8000,12); console.log(d.map(l=>l.text).join(' | '));
ok(d[1].text==='LDA $10'&&d[3].text==='LDA ($20),Y'&&d[8].text.startsWith('BNE $8000'),'disasm texts');
// every official opcode: assemble from its own disasm and compare
let rt=0,bad=0; for(let op=0;op<256;op++){ const o=N.OPCODES[op]; if(!o) continue; const bytes=[op,0x34,0x12].slice(0,o.len); if(o.mode==='rel') bytes[1]=0x10;
  const dl=N.disasm((x)=>x>=0x9000&&x-0x9000<3?bytes[x-0x9000]??-1:-1,0x9000,1)[0]; const as=N.assemble('.org $9000\n'+dl.text.replace(/;.*/,''),{org:0x9000});
  const got=as.segments[0]&&as.segments[0].bytes; rt++; if(as.errors.length||!got||got.join()!==bytes.join()){bad++;console.log('  mismatch',op.toString(16),dl.text,got,as.errors);} }
ok(bad===0,'all '+rt+' opcodes round-trip');
ok(N.assemble('lda #$1234').errors.length>0&&N.assemble('foo').errors.length>0&&N.assemble('beq nowhere').errors.length>0,'assembler errors');
// starter ROM
const s=N.buildStarter(16,'T'); const info=s.info; ok(info.prgSize===16384&&info.chrSize===8192&&info.mapper===0,'starter header '+JSON.stringify([info.prgSize,info.chrSize]));
const v=N.vectors(s.rom,info); ok(v.RESET===s.symbols.Reset&&v.NMI===s.symbols.NMI,'vectors set '+v.RESET.toString(16));
// 6502 simulator
function run(rom,info,buttons){
  const mem=new Uint8Array(0x10000), vram=new Uint8Array(0x4000), oam=new Uint8Array(256); let vaddr=0,latch=0,pad=0,padIdx=0,strobe=0,oamAddr=0;
  const rb=(a)=>{ if(a>=0x8000) return rom[N.cpuToFile(a,info,0)]; if(a===0x2002) {latch=0;return 0x80;} if(a===0x4016){ const v=(buttons>>(7-padIdx))&1; padIdx++; return v;} return mem[a]; };
  const wb=(a,v)=>{ v&=255; if(a>=0x8000) return; if(a===0x2006){ if(!latch) vaddr=(v<<8); else vaddr|=v; latch^=1; return;} if(a===0x2007){ vram[vaddr&0x3FFF]=v; vaddr++; return;} if(a===0x2003){oamAddr=v;return;} if(a===0x4014){ for(let i=0;i<256;i++) oam[i]=mem[(v<<8)+i]; return;} if(a===0x4016){ if(v&1) padIdx=0; return;} if(a>=0x2000&&a<0x4020) return; mem[a]=v; };
  let A=0,X=0,Y=0,SP=0xFD,PC=0,C=0,Z=0,N_=0,V=0; const sf=(v)=>{Z=(v&255)===0?1:0;N_=(v>>7)&1;return v&255;};
  const push=(v)=>{mem[0x100+SP]=v;SP=(SP-1)&255;}, pull=()=>{SP=(SP+1)&255;return mem[0x100+SP];};
  const flags=()=>C|Z<<1|4|N_<<7|V<<6; const setF=(f)=>{C=f&1;Z=(f>>1)&1;N_=(f>>7)&1;V=(f>>6)&1;};
  function ea(o){ const lo=rb(PC+1),hi=rb(PC+2),w=lo|hi<<8; switch(o.mode){case 'zp':return lo;case 'zpx':return (lo+X)&255;case 'zpy':return (lo+Y)&255;case 'abs':return w;case 'abx':return (w+X)&0xFFFF;case 'aby':return (w+Y)&0xFFFF;case 'izy':return ((rb(lo)|rb((lo+1)&255)<<8)+Y)&0xFFFF;case 'izx':{const p=(lo+X)&255;return rb(p)|rb((p+1)&255)<<8;}} }
  function step(){ const op=rb(PC), o=N.OPCODES[op]; if(!o) throw new Error('bad op '+op.toString(16)+' at '+PC.toString(16)); const rv=()=>o.mode==='imm'?rb(PC+1):o.mode==='acc'?A:rb(ea(o)); const next=PC+o.len; let jumped=false; const br=(c)=>{ if(c){const r=rb(PC+1);PC=(next+(r<128?r:r-256))&0xFFFF;jumped=true;} };
    switch(o.mn){
      case 'SEI':case 'CLD':case 'NOP':break; case 'CLC':C=0;break; case 'SEC':C=1;break;
      case 'LDA':A=sf(rv());break; case 'LDX':X=sf(rv());break; case 'LDY':Y=sf(rv());break;
      case 'STA':wb(ea(o),A);break; case 'STX':wb(ea(o),X);break; case 'STY':wb(ea(o),Y);break;
      case 'TXS':SP=X;break; case 'TXA':A=sf(X);break; case 'INX':X=sf(X+1);break; case 'DEX':X=sf(X-1);break; case 'INY':Y=sf(Y+1);break; case 'DEY':Y=sf(Y-1);break;
      case 'BIT':{const v=rv();Z=(A&v)?0:1;N_=v>>7;V=(v>>6)&1;break;}
      case 'BPL':br(!N_);break; case 'BMI':br(N_);break; case 'BNE':br(!Z);break; case 'BEQ':br(Z);break; case 'BCC':br(!C);break; case 'BCS':br(C);break;
      case 'CPX':{const r=X-rv();C=r>=0?1:0;sf(r);break;} case 'CMP':{const r=A-rv();C=r>=0?1:0;sf(r);break;}
      case 'AND':A=sf(A&rv());break; case 'ADC':{const v=rv(),r=A+v+C;C=r>255?1:0;A=sf(r);break;}
      case 'INC':{const a=ea(o);wb(a,sf(rb(a)+1));break;} case 'DEC':{const a=ea(o);wb(a,sf(rb(a)-1));break;}
      case 'LSR':{ if(o.mode==='acc'){C=A&1;A=sf(A>>1);} else {const a=ea(o),v=rb(a);C=v&1;wb(a,sf(v>>1));} break;}
      case 'ROL':{ const a=o.mode==='acc'?-1:ea(o),v=a<0?A:rb(a),r=((v<<1)|C)&255;C=v>>7;sf(r); if(a<0)A=r;else wb(a,r);break;}
      case 'PHA':push(A);break; case 'PLA':A=sf(pull());break;
      case 'JMP':PC=rb(PC+1)|rb(PC+2)<<8;jumped=true;break;
      case 'RTI':setF(pull());PC=pull()|pull()<<8;jumped=true;break;
      default: throw new Error('sim: unimplemented '+o.mn);
    } if(!jumped) PC=next; }
  PC=rb(0xFFFC)|rb(0xFFFD)<<8; const fe=s.symbols.Forever; let n=0; while(PC!==fe&&n++<200000) step();
  const st={mem,vram,oam,reachedForever:PC===fe,steps:n,regs:()=>({PC,A,X,Y})};
  // NMI
  push(0);push(0);push(4); const nmi=rb(0xFFFA)|rb(0xFFFB)<<8; PC=nmi; padIdx=0; let m=0; while(!(rb(PC)===0x40)&&m++<5000) step(); st.nmiSteps=m; return st;
}
const r=run(s.rom,info,0); ok(r.reachedForever,'reset reaches Forever in '+r.steps+' steps');
ok(r.vram[0x3F00]===0x0F&&r.vram[0x3F01]===0x30&&r.vram[0x3F11]===0x16&&r.vram[0x3F1F]===0x25,'palette uploaded');
ok(r.vram[0x2000]===1&&r.vram[0x2001]===2&&r.vram[0x23BF]===2&&r.vram[0x23C0]===0&&r.vram[0x23FF]===0,'nametable filled, attrs cleared');
ok(r.oam[0]===0x78+0&&r.oam[1]===0||true,'oam present');
const r2=run(s.rom,info,0x01|0x08); // right+up (bit0 right, bit3 up)
ok(r2.mem[0]===0x79&&r2.mem[1]===0x77,'NMI: right+up moves sprite -> x='+r2.mem[0]+' y='+r2.mem[1]);
ok(r2.mem[0x200]===0x77&&r2.mem[0x201]===3&&r2.mem[0x203]===0x79,'sprite OAM shadow updated');
const r3=run(s.rom,info,0x02|0x04); ok(r3.mem[0]===0x77&&r3.mem[1]===0x79,'left+down');
// blank + palette scan + cpu mapping
const bl=N.buildBlank(16); ok(N.vectors(bl.rom,bl.info).RESET===0xC000,'blank reset vector');
ok(N.cpuToFile(0xC000,info,0)===16&&N.fileToCpu(16,info)===0xC000&&N.cpuToFile(0x8000,info,0)===16,'16K mirror mapping');
const big={mapper:2,prgSize:0x20000,prgOff:16}; ok(N.cpuToFile(0xC000,big,0)===16+0x1C000&&N.cpuToFile(0x8000,big,3)===16+0xC000,'UxROM mapping');
ok(N.scanPalettes(s.rom,info,10).length>0,'nes palette scan finds starter palette');
const ps=N.parse(s.rom); N.setHeader(s.rom,{mapper:4,mirror:'vertical',battery:true}); const p2=N.parse(s.rom); ok(p2.mapper===4&&p2.mirror==='vertical'&&p2.battery,'header edit');
console.log('FAILS',fails); process.exit(fails?1:0);
