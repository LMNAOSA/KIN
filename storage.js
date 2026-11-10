/** Persistent, on-device learning store. No camera/mic recordings are retained. */
const DB_NAME='kin-communication';
const DB_VERSION=1;
const PROFILE_STORE='profiles';
const EVENT_STORE='events';
const META_STORE='meta';
const MAX_EVENTS=500;
const open=()=>new Promise((resolve,reject)=>{
  if(!globalThis.indexedDB){reject(new Error('IndexedDB unavailable'));return;}
  const req=indexedDB.open(DB_NAME,DB_VERSION);
  req.onupgradeneeded=()=>{
    const db=req.result;
    if(!db.objectStoreNames.contains(PROFILE_STORE))db.createObjectStore(PROFILE_STORE,{keyPath:'id'});
    if(!db.objectStoreNames.contains(META_STORE))db.createObjectStore(META_STORE,{keyPath:'key'});
    if(!db.objectStoreNames.contains(EVENT_STORE)){
      const store=db.createObjectStore(EVENT_STORE,{keyPath:'id'});
      store.createIndex('profileId','profileId');
    }
  };
  req.onsuccess=()=>resolve(req.result);
  req.onerror=()=>reject(req.error||new Error('Cannot open local database'));
  req.onblocked=()=>reject(new Error('Database upgrade blocked by another tab'));
});
function request(req){return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function done(tx){return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Database write aborted'));});}
export async function readLocalData(){
 const db=await open();
 try{
  const tx=db.transaction([PROFILE_STORE,META_STORE],'readonly');
  const p=request(tx.objectStore(PROFILE_STORE).getAll());
  const m=request(tx.objectStore(META_STORE).get('activeProfile'));
  const [profiles,meta]=await Promise.all([p,m]);
  await done(tx);
  return {profiles,activeId:meta?.value||null};
 }finally{db.close();}
}
export async function writeLocalData(profiles,activeId){
 const db=await open();
 try{
  const tx=db.transaction([PROFILE_STORE,META_STORE],'readwrite');
  const store=tx.objectStore(PROFILE_STORE);
  store.clear();
  for(const p of profiles)store.put(p);
  tx.objectStore(META_STORE).put({key:'activeProfile',value:activeId||null});
  await done(tx);
 }finally{db.close();}
}
export async function writeCommunicationEvent(event){
 const db=await open();
 try{
  const tx=db.transaction(EVENT_STORE,'readwrite');
  const store=tx.objectStore(EVENT_STORE);
  store.put({...event,id:event.id||globalThis.crypto?.randomUUID?.()||`event-${Date.now()}-${Math.random()}`});
  const count=await request(store.count());
  if(count>MAX_EVENTS){
   let toDelete=count-MAX_EVENTS;
   const cursor=store.openCursor();
   cursor.onsuccess=()=>{const c=cursor.result;if(c&&toDelete-->0){c.delete();c.continue();}};
  }
  await done(tx);
 }finally{db.close();}
}
export async function readCommunicationEvents(profileId){
 const db=await open();
 try{
  const tx=db.transaction(EVENT_STORE,'readonly');
  const events=await request(tx.objectStore(EVENT_STORE).index('profileId').getAll(profileId));
  await done(tx);
  return events.sort((a,b)=>String(b.at).localeCompare(String(a.at)));
 }finally{db.close();}
}
