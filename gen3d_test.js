const C=require('./core.js'); ['nes','audio','codecs','games','capture','gen3d'].forEach(n=>require('./'+n+'.js')); const G3=C.Game3D; const fs=require('fs'); let fails=0;
const ok=(c,m)=>{ if(!c){fails++;console.log('FAIL',m);} else console.log('ok  ',m); };
const d=new Uint8Array(0x40000); for(let i=0;i<d.length;i++) d[i]=(i*7+(i>>5))&255;
const cfg=G3.makeConfig(d,{platform:'snes',fmt:'4bpp',off:0,palOff:null,picks:{wall:0,floor:2,ceil:4,gem:6,enemy:8,exit:10,player:12},size:16,title:'T'});
ok(Object.keys(cfg.textures).length===7&&Object.values(cfg.textures).every(t=>t.length===16*16*4),'seven 16x16 RGBA textures');
const html=G3.buildHtml(cfg); ok(html.startsWith('<!DOCTYPE html>')&&html.includes('window.__g'),'builds a page');
const script=html.split('<script>')[1].split('</script>')[0]; let syn=true; try{ new Function(script);}catch(e){syn=false;console.log(e.message);} ok(syn,'generated script is valid JavaScript');
ok(!/https?:\/\//.test(script),'generated game makes no network references');
ok(G3.palette(d,'snes','4bpp',null).length===16&&G3.palette(d,'snes','3bpp',null).length===8,'greyscale palettes sized by depth');
const t=Buffer.from(d.slice(0,32)); const px=G3.blockPixels(d,0,'4bpp',16); ok(px.length===256,'16x16 block is 256 pixels');
// SMW sources include decoded pointer-table files
const smw=new Uint8Array(fs.readFileSync('/tmp/roms_all/Super Mario World (USA).sfc')); const det=C.detect(smw); const g=C.Games.identify(smw,det.hdr,'x').game;
const src=G3.findSources(smw,'snes',null,g,{mapping:det.mapping}); ok(src.some(s=>s.label.includes('SMW graphics file'))&&src.length>10,'SMW offers decompressed graphics sources ('+src.length+')');
const pk=G3.autoPicks(src[0].data,src[0].off,src[0].fmt); ok(G3.ROLES.every(([r])=>Number.isInteger(pk[r])),'auto-pick fills every role');
for(const mode of ['side','maze']){ const h2=G3.buildHtml(Object.assign({},cfg,{mode})); const sc=h2.split('<script>')[1].split('</script>')[0]; let v=true; try{new Function(sc);}catch(e){v=false;console.log(e.message);} ok(v&&!/https?:\/\//.test(sc),mode+' page script valid, no network references'); }
console.log('FAILS',fails); process.exit(fails?1:0);
