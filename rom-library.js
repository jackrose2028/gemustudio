const DB_NAME="press-start-imports";
const STORE="roms";
const META_STORE="library";
const ARCHIVE_STORE="archives";
let databasePromise;

function openDatabase(){
 if(databasePromise)return databasePromise;
 databasePromise=new Promise((resolve,reject)=>{
  if(!("indexedDB" in window)){reject(new Error("This browser cannot save imported games."));return;}
  const request=indexedDB.open(DB_NAME,3);
  request.onupgradeneeded=event=>{
   const db=request.result,tx=request.transaction;
   if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:"id"});
   if(!db.objectStoreNames.contains(ARCHIVE_STORE))db.createObjectStore(ARCHIVE_STORE,{keyPath:"id"});
   let metadata=db.objectStoreNames.contains(META_STORE)?tx.objectStore(META_STORE):db.createObjectStore(META_STORE,{keyPath:"id"});
   if(event.oldVersion===1){
    const cursorRequest=tx.objectStore(STORE).openCursor();
    cursorRequest.onsuccess=()=>{const cursor=cursorRequest.result;if(!cursor)return;const {rom,...record}=cursor.value;metadata.put(record);cursor.continue();};
   }
  };
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error||new Error("Could not open the local game library."));
  request.onblocked=()=>reject(new Error("The local game library is busy in another tab."));
 });
 return databasePromise;
}
function storeRequest(mode,method,value){
 return openDatabase().then(db=>new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,mode),store=tx.objectStore(STORE);
  const request=method==="getAll"?store.getAll():method==="get"?store.get(value):store.put(value);
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error||new Error("Could not access imported game data."));
  tx.onabort=()=>reject(tx.error||new Error("Could not save imported game data."));
 }));
}
function loadLibraryMetadata(){return openDatabase().then(db=>new Promise((resolve,reject)=>{const tx=db.transaction(META_STORE,"readonly"),request=tx.objectStore(META_STORE).getAll();request.onsuccess=()=>resolve(request.result||[]);request.onerror=()=>reject(request.error||new Error("Could not read the local game library."));tx.onabort=()=>reject(tx.error||new Error("Could not read the local game library."));}));}
function storeImportedRecord(record){return openDatabase().then(db=>new Promise((resolve,reject)=>{const tx=db.transaction([STORE,META_STORE],"readwrite"),{rom,...metadata}=record;tx.objectStore(STORE).put(record);tx.objectStore(META_STORE).put(metadata);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error||new Error("Could not save imported game data."));tx.onabort=()=>reject(tx.error||new Error("Could not save imported game data."));}));}
export async function loadImportedGames(){return (await loadLibraryMetadata()).sort((a,b)=>a.title.localeCompare(b.title));}
export async function clearImportedGames(){const db=await openDatabase();return new Promise((resolve,reject)=>{const tx=db.transaction([STORE,META_STORE,ARCHIVE_STORE],"readwrite");tx.objectStore(STORE).clear();tx.objectStore(META_STORE).clear();tx.objectStore(ARCHIVE_STORE).clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error||new Error("Could not clear the local game library."));tx.onabort=()=>reject(tx.error||new Error("Could not clear the local game library."));});}
export async function getImportedGame(id){return storeRequest("readonly","get",id);}
function storeImportedArchive(id,file){return openDatabase().then(db=>new Promise((resolve,reject)=>{const tx=db.transaction(ARCHIVE_STORE,"readwrite");tx.objectStore(ARCHIVE_STORE).put({id,name:file.name,blob:file});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error||new Error("Could not store source ZIP."));tx.onabort=()=>reject(tx.error||new Error("Could not store source ZIP."));}));}
export async function getImportedArchive(id){const db=await openDatabase();return new Promise((resolve,reject)=>{const tx=db.transaction(ARCHIVE_STORE,"readonly"),request=tx.objectStore(ARCHIVE_STORE).get(id);request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(request.error||new Error("Could not read source ZIP."));});}

function canonicalTitle(raw){
 let name=String(raw||"").split(/[\\/]/).pop().replace(/\.[^.]+$/g,"");
 name=name.replace(/(?:\s*(?:\([^)]*\)|\[[^\]]*\]))+$/g,"").replace(/_/g," ").replace(/\s+/g," ").trim();
 if(name.includes("~"))name=name.split("~").pop().trim();
 return name||"Untitled game";
}
function titleKey(value){return String(value||"").normalize("NFKD").toLowerCase().replace(/\bthe\b/g,"").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"");}
function slug(value){return titleKey(value).slice(0,80)||"game";}
function detectSystem(filename,folderHint,systems){
 const ext=(String(filename).match(/\.[^.\/]+$/)||[""])[0].toLowerCase();
 const hint=String(folderHint||"").toLowerCase().replace(/\\/g,"/");
 const extensionId={".gg":"gamegear",".nes":"nes",".sfc":"snes",".smc":"snes",".gb":"gb",".gbc":"gbc",".a26":"atari2600",".z64":"n64",".n64":"n64",".v64":"n64"}[ext];
 const parts=hint.split("/").map(part=>part.replace(/[^a-z0-9]+/g,"")).filter(Boolean);
 const folderAliases={atari2600:"atari2600","2600":"atari2600",atari:"atari2600",vcs:"atari2600",nes:"nes",nintendo:"nes",snes:"snes",supernintendo:"snes",gb:"gb",gameboy:"gb",gbc:"gbc",gameboycolor:"gbc",gameboycolour:"gbc",gamegear:"gamegear",gg:"gamegear",n64:"n64",nintendo64:"n64"};
 const folderId=[...parts].reverse().map(part=>folderAliases[part]).find(Boolean);
 const supported=[".gg",".nes",".sfc",".smc",".gb",".gbc",".a26",".z64",".n64",".v64",".bin",".rom"].includes(ext);
 if(!supported)return null;
 const id=folderId||extensionId;
 return systems.find(system=>system.id===id)||null;
}
function detectRegion(name){
 const groups=[...String(name).matchAll(/\(([^)]*)\)/g)].map(match=>match[1]).join(" ");
 const regions=["USA","Europe","Japan","World","Asia","Australia"].filter(region=>new RegExp("\\b"+region+"\\b","i").test(groups));
 return regions.join(" · ")||"Imported";
}
export async function importZipFolder(files,systems,isDuplicate,onProgress=()=>{},options={}){
 const allFiles=[...files],archives=allFiles.filter(file=>/\.zip$/i.test(file.name));
 const cueStems=new Set(allFiles.filter(file=>/\.cue$/i.test(file.name)).map(file=>String(file.romFolderPath||file.webkitRelativePath||file.name).replace(/\.cue$/i,"").toLowerCase()));
 const directFiles=allFiles.filter(file=>{
  if(/\.zip$/i.test(file.name))return false;
  const fullName=file.romFolderPath||file.webkitRelativePath||file.name;
  if(/\.bin$/i.test(file.name)&&cueStems.has(fullName.replace(/\.bin$/i,"").toLowerCase()))return false;
  return Boolean(detectSystem(file.name,fullName,systems));
 });
 const sources=[...archives.map(archive=>({type:"archive",file:archive})),...directFiles.map(file=>({type:"rom",file}))];
 if(!sources.length)return{added:[],duplicates:0,unsupported:0,errors:[],archives:0,sources:0};
 const JSZip=archives.length?((await import("https://esm.sh/jszip@3.10.1")).default):null;
 const saved=await loadImportedGames(),savedIds=new Set(saved.map(game=>game.id)),newKeys=new Set();
 const added=[],errors=[];let duplicates=0,unsupported=0,next=0,completed=0;
 async function addRom(blob,entryName,system,sourceFile,archiveName=null){
  const title=canonicalTitle(entryName),key=system.id+":"+titleKey(title),id="import-"+system.id+"-"+slug(title);
  if(newKeys.has(key)||savedIds.has(id)||isDuplicate(system.id,title)){duplicates++;return;}
  newKeys.add(key);savedIds.add(id);
  try{
   const extension=(entryName.match(/\.[^.\/]+$/)||[""])[0].slice(1).toUpperCase();
   const record={id,systemId:system.id,title,region:detectRegion(entryName),romName:entryName.split(/[\\/]/).pop(),romFormat:extension,originalZip:archiveName,originalZipId:archiveName?(sourceFile.romFolderPath||sourceFile.webkitRelativePath||sourceFile.name):null,relativePath:sourceFile.romFolderPath||sourceFile.webkitRelativePath||sourceFile.name,romSizeBytes:blob.size,addedAt:new Date().toISOString(),...(options.bundled?{bundled:true}:{}),rom:blob};
   await storeImportedRecord(record);added.push(record);
  }catch(error){newKeys.delete(key);savedIds.delete(id);throw error;}
 }
 async function worker(){
  while(next<sources.length){const {type,file}=sources[next++];
   try{
    if(type==="rom"){
     const system=detectSystem(file.name,file.romFolderPath||file.webkitRelativePath||file.name,systems);
     if(system)await addRom(file,file.name,system,file);
    }else{
     const zip=await JSZip.loadAsync(await file.arrayBuffer());
     const keepsSource=Object.keys(zip.files).some(name=>/\.(png|jpe?g|gif|webp|bmp|tga|wav|ogg|mp3|flac|mid|midi|mod|xm|it|s3m|tmx|map|csv|xml|json)$/i.test(name));
     if(keepsSource)try{await storeImportedArchive(file.romFolderPath||file.webkitRelativePath||file.name,file);}catch(error){console.warn("Could not preserve source ZIP:",file.name,error);}
     let found=0;
     for(const entryName in zip.files){
      const entry=zip.files[entryName];
      if(entry.dir||/^__MACOSX\//.test(entry.name))continue;
      const system=detectSystem(entry.name,(file.romFolderPath||file.webkitRelativePath||file.name)+"  "+entry.name,systems);
      if(!system)continue;
      found++;
      await addRom(await entry.async("blob"),entry.name,system,file,file.name);
     }
     if(!found)unsupported++;
    }
   }catch(error){errors.push({name:file.name,message:error?.message||"Unreadable ROM/archive"});}
   completed++;if(completed===sources.length||completed%8===0)onProgress(completed,sources.length);
  }
 }
 await Promise.all(Array.from({length:Math.min(4,sources.length)},worker));
 return{added,duplicates,unsupported,errors,archives:archives.length,sources:sources.length};
}
