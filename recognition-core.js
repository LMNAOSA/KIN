/** KIN 0.3: transparent, experimental per-person sound and movement template recognition.
 * Similarity is NOT probability and a match is NOT proof of meaning.
 */
import { validSignature as validAudio, signatureDistance } from './voice-recognition.js';
export const MOTION_DIM=55;
export const MOTION_BINS=5;
export const MOTION_SIG_LENGTH=MOTION_DIM*MOTION_BINS;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const pt=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;
const uid=()=>globalThis.crypto?.randomUUID?.()||'id-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9);
export {uid};

export function extractMotionFrame(face,hands=[],pose){
  const f=Array.isArray(face)&&face.length>454?face:null;
  const p=Array.isArray(pose)&&pose.length>24?pose:null;
  const hs=(Array.isArray(hands)?hands:[]).filter(h=>Array.isArray(h)&&h.length>=21).slice(0,2).sort((a,b)=>a[0].x-b[0].x);
  if(!f&&!p&&!hs.length)return null;
  let root={x:.5,y:.5},scale=.30;
  if(p && (p[11].visibility??1)>.35 && (p[12].visibility??1)>.35){root=pt(p[11],p[12]);scale=Math.max(.10,dist(p[11],p[12]));}
  else if(f){root=pt(f[234],f[454]);scale=Math.max(.08,dist(f[234],f[454]));}
  const xy=q=>q?[clamp((q.x-root.x)/scale,-4,4),clamp((q.y-root.y)/scale,-4,4)]:[0,0];
  const v=[f?1:0,p?1:0,hs[0]?1:0,hs[1]?1:0];
  if(f){
    const faceWidth=Math.max(.001,dist(f[33],f[263]));
    v.push(...xy(f[1]), clamp(dist(f[13],f[14])/faceWidth*3,0,3),clamp(dist(f[159],f[145])/faceWidth*3,0,3),clamp(dist(f[386],f[374])/faceWidth*3,0,3),clamp(dist(f[70],f[159])/faceWidth*2,0,3),clamp(dist(f[300],f[386])/faceWidth*2,0,3));
  }else v.push(...Array(7).fill(0));
  for(const i of [11,12,13,14,15,16,23,24,0])v.push(...xy(p?.[i]));
  for(let h=0;h<2;h++){
    const hand=hs[h];
    if(!hand){v.push(...Array(13).fill(0));continue;}
    for(const j of [0,4,8,12,20,9])v.push(...xy(hand[j]));
    const span=mean([4,8,12,20].map(i=>dist(hand[i],hand[0])))/Math.max(.001,mean([5,9,13,17].map(i=>dist(hand[i],hand[0]))));
    v.push(clamp(span,0,3));
  }
  return v.length===MOTION_DIM?v:null;
}

/** Temporal windows preserve motion order (e.g. head up then down vs down then up). */
export function makeMotionSignature(frames){
  const vectors=(frames||[]).filter(v=>Array.isArray(v)&&v.length===MOTION_DIM&&v.every(Number.isFinite));
  if(vectors.length<7)return null;
  let out=[];
  for(let b=0;b<MOTION_BINS;b++){
    const start=Math.floor(vectors.length*b/MOTION_BINS),end=Math.max(start+1,Math.floor(vectors.length*(b+1)/MOTION_BINS));
    for(let k=0;k<MOTION_DIM;k++)out.push(mean(vectors.slice(start,end).map(v=>v[k])));
  }
  return out;
}
export function validMotion(sig){return Array.isArray(sig)&&sig.length===MOTION_SIG_LENGTH&&sig.every(v=>Number.isFinite(v)&&Math.abs(v)<=5);}
export function motionDistance(a,b){
  if(!validMotion(a)||!validMotion(b))return Infinity;
  let sum=0,weights=0;
  for(let i=0;i<a.length;i++){
    const k=i%MOTION_DIM;
    const w=k<4?4:k<11?0.6:k<29?1.05:1.3;
    sum+=w*(a[i]-b[i])**2; weights+=w;
  }
  return Math.sqrt(sum/weights);
}
export function normaliseScene(vec){
  if(!vec||vec.length<32||vec.length>4096)return null;
  const v=Array.from(vec);if(!v.every(Number.isFinite))return null;
  const length=Math.hypot(...v);if(!length||!Number.isFinite(length))return null;
  return v.map(x=>x/length);
}
export function sceneDistance(a,b){
  if(!validScene(a)||!validScene(b)||a.length!==b.length)return Infinity;
  const normA=Math.hypot(...a),normB=Math.hypot(...b);
  let dot=0;for(let i=0;i<a.length;i++)dot+=a[i]*b[i];
  return 1-clamp(dot/(normA*normB),-1,1);
}
export function validScene(vec){return Array.isArray(vec)&&vec.length>=32&&vec.length<=4096&&vec.every(v=>Number.isFinite(v)&&Math.abs(v)<=5)&&Math.hypot(...vec)>.1;}
export function makeSceneSignature(frames){
  const usable=(frames||[]).filter(validScene);
  if(usable.length<3)return null;
  const dims=usable[0].length,consistent=usable.filter(v=>v.length===dims);
  if(consistent.length<3)return null;
  return normaliseScene(Array.from({length:dims},(_,i)=>mean(consistent.map(v=>v[i]))));
}
export function exampleValid(mode,sig){return mode==='sound'?validAudio(sig):mode==='movement'?validMotion(sig):mode==='scene'?validScene(sig):false;}
export function matchInput(mode,sig,cues){
  if(!exampleValid(mode,sig))return {status:'invalid'};
  const eligible=(cues||[]).filter(c=>c.mode===mode&&Array.isArray(c.examples)&&c.examples.filter(e=>exampleValid(mode,e.sig)).length>=3);
  if(eligible.length<2)return {status:'not-ready', detail:'Train at least two signals (or one signal and an Ignore signal) with 3 examples each.'};
  const distanceFn=mode==='sound'?signatureDistance:mode==='scene'?sceneDistance:motionDistance;
  const scored=eligible.map(c=>{
    const samples=c.examples.filter(e=>exampleValid(mode,e.sig)).map(e=>e.sig);
    const distances=samples.map(v=>distanceFn(sig,v)).sort((a,b)=>a-b);
    const n=Math.min(3,distances.length);
    const near=mean(distances.slice(0,n));
    // Intra-class variation is an approximate local tolerance, bounded conservatively.
    const self=samples.slice(0,Math.min(16,samples.length)).map((s,i)=>{
      const others=samples.filter((_,j)=>j!==i).map(x=>distanceFn(s,x)).sort((a,b)=>a-b);
      return mean(others.slice(0,Math.min(3,others.length)));
    }).sort((a,b)=>a-b);
    const centre=self[Math.floor(self.length/2)]||0;
    const limit=mode==='sound'?clamp(.095+centre*1.2,.12,.19):mode==='scene'?clamp(.11+centre*1.6,.19,.39):clamp(.10+centre*1.45,.16,.50);
    return {cue:c,dist:near,limit};
  }).sort((a,b)=>a.dist-b.dist);
  const best=scored[0],next=scored[1];
  const margin=mode==='sound'?.028:mode==='scene'?.075:.065;
  if(best.dist>best.limit || next.dist-best.dist<margin)return {status:'unknown',candidate:best.cue.phrase};
  if(best.cue.ignore)return {status:'ignored'};
  return {status:'candidate',cueId:best.cue.id,phrase:best.cue.phrase,modality:mode};
}

export function safeProfile(raw){
  if(!raw||typeof raw!=='object'||typeof raw.id!=='string')return null;
  const known=new Set();
  const cues=(Array.isArray(raw.cues)?raw.cues:[]).slice(0,90).filter(c=>{
    if(!c||typeof c.id!=='string'||known.has(c.id)||!['sound','movement','scene'].includes(c.mode))return false;
    known.add(c.id);return true;
  }).map(c=>({
    id:c.id.slice(0,90),phrase:String(c.phrase||'').slice(0,120).trim(),mode:c.mode,ignore:Boolean(c.ignore),
    note:String(c.note||'').slice(0,240), examples:(Array.isArray(c.examples)?c.examples:[]).filter(e=>e&&exampleValid(c.mode,e.sig)).slice(-80).map(e=>({id:String(e.id||uid()).slice(0,90),sig:e.sig,at:String(e.at||'').slice(0,36)}))
  })).filter(c=>c.phrase);
  return {id:raw.id.slice(0,100),name:String(raw.name||'Person').slice(0,70),cues};
}
export function starterProfile(){return {id:uid(),name:'Example person',cues:[
  {id:uid(),phrase:'No',mode:'movement',note:'Fingers over mouth',ignore:false,examples:[]},
  {id:uid(),phrase:'Yes',mode:'movement',note:'Hand beneath chin',ignore:false,examples:[]},
  {id:uid(),phrase:'Go away / Not interested',mode:'movement',note:'Hand over upper face',ignore:false,examples:[]},
  {id:uid(),phrase:'Repeat / One more time',mode:'movement',note:'Hand towards ear',ignore:false,examples:[]}
]};}
