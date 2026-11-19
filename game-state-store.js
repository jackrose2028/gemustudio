const DB_NAME="press-start-state-saves";
const STORE="states";
let databasePromise;
function openDatabase(){
 if(databasePromise)return databasePromise;
 databasePromise=new Promise((resolve,reject)=>{
  if(!("indexedDB" in window)){reject(new Error("This browser cannot store game states."));return;}
  const request=indexedDB.open(DB_NAME,1);
  request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:"id"});};
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error||new Error("Could not open game-state storage."));
  request.onblocked=()=>reject(new Error("Game-state storage is busy in another tab."));
 });
 return databasePromise;
}
export async function saveGameState(id,state){
 const db=await openDatabase(),savedAt=new Date().toISOString();
 const bytes=state instanceof Uint8Array?state.slice():ArrayBuffer.isView(state)?new Uint8Array(state.buffer,state.byteOffset,state.byteLength).slice():new Uint8Array(state);
 return new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,"readwrite");
  tx.objectStore(STORE).put({id,state:bytes,savedAt});
  tx.oncomplete=()=>resolve(savedAt);
  tx.onerror=()=>reject(tx.error||new Error("Could not save this game state."));
  tx.onabort=()=>reject(tx.error||new Error("Could not save this game state."));
 });
}
export async function clearAllGameStates(){const db=await openDatabase();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,"readwrite");tx.objectStore(STORE).clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error||new Error("Could not clear saved game states."));tx.onabort=()=>reject(tx.error||new Error("Could not clear saved game states."));});}
export async function loadGameState(id){
 const db=await openDatabase();
 return new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,"readonly"),request=tx.objectStore(STORE).get(id);
  request.onsuccess=()=>resolve(request.result||null);
  request.onerror=()=>reject(request.error||new Error("Could not read the saved game state."));
 });
}
