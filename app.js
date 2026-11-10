import {starterProfile, safeProfile, uid, extractMotionFrame, makeMotionSignature, matchInput} from './recognition-core.js';
import {CUES, extractFeatures, classify, HoldDetector} from './starter-gestures.js';
import {frameFeatures} from './voice-recognition.js';
import {makeSoundSignature, soundFramesFromPcm} from './sound-utils.js';
import {readLocalData, writeLocalData, writeCommunicationEvent} from './storage.js';

const $=id=>document.getElementById(id);
const encode=s=>String(s??'').replace(/[&<>"']/g,k=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[k]));
const KEY='kin.personal.v4', OLD='kin.studio.profiles.v3';
const now=()=>performance.now();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const isSampleReady=c=>c.examples.length>=3;
const matchesMode=c=>c.mode===state.mode;
function loadProfiles(){
  for(const key of [KEY,OLD]){
    try{const arr=JSON.parse(localStorage.getItem(key)||'null');const cleaned=(Array.isArray(arr)?arr:[]).map(safeProfile).filter(Boolean);if(cleaned.length)return cleaned;}catch{}
  }
  const starter=starterProfile();starter.name='Example person';return [starter];
}
const state={profiles:loadProfiles(),activeId:null,mode:'movement',step:'messages',chosen:null,guide:'face',busy:false,toast:0,events:[],candidate:null};
state.activeId=state.profiles[0].id;
const person=()=>state.profiles.find(p=>p.id===state.activeId)||state.profiles[0];
const cues=()=>person().cues.filter(matchesMode);
const chosen=()=>person().cues.find(c=>c.id===state.chosen&&matchesMode(c));
const starterProfileSelected=()=>person().name==='Example person'&&person().cues.length>=4&&['No','Yes','Go away / Not interested','Repeat / One more time'].every(s=>person().cues.some(c=>c.mode==='movement'&&c.phrase===s));
const originalMap={'no':'No','yes':'Yes','away':'Go away / Not interested','repeat':'Repeat / One more time'};
let stream=null,micStream=null,faceModel=null,handModel=null,poseModel=null,modelPromise=null,raf=0,lastVideo=0,visionTs=0,motionWindow=[],lastMotion=0,lastSuggestion=0,stable={id:null,start:0},starterHold=new HoldDetector();
let audioContext=null,source=null,analyser=null,audioTimer=0,audioTime=null,audioFreq=null,soundFrames=[],soundPreroll=[],soundStarted=0,lastLoud=0,noise=.007,lastAudioSuggestion=0;
let recording=null,recordTimer=0,importing=false;
const SDK='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.2/vision_bundle.mjs';
const WASM='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.2/wasm';
const FACE='https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const HAND='https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const POSE='https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
function toast(message){$('toast').textContent=message;$('toast').classList.add('open');clearTimeout(state.toast);state.toast=setTimeout(()=>$('toast').classList.remove('open'),4000);}
let persistenceQueue=Promise.resolve();
let databaseAvailable=true;
function queueDatabaseSave(){
  // Queue immutable snapshots to prevent older, slower writes overwriting new training.
  const snapshot=structuredClone(state.profiles),selected=state.activeId;
  persistenceQueue=persistenceQueue.catch(()=>{}).then(()=>writeLocalData(snapshot,selected));
  persistenceQueue.catch(err=>{databaseAvailable=false;console.error('KIN local database:',err);toast('Saving failed. Export a profile backup.');});
}
function save(){
  // Maintain the legacy key during migration so an existing offline installation can roll back.
  try{localStorage.setItem(KEY,JSON.stringify(state.profiles));}catch{}
  if(databaseAvailable)queueDatabaseSave();
  render();
}
async function initialiseDatabase(){
  try{
    const stored=await readLocalData();
    const profiles=(stored.profiles||[]).map(safeProfile).filter(Boolean);
    if(profiles.length){
      state.profiles=profiles;
      state.activeId=profiles.some(p=>p.id===stored.activeId)?stored.activeId:profiles[0].id;
    }else{
      // First launch: migrate valid v0.3/v0.4 browser profiles into IndexedDB.
      await writeLocalData(state.profiles,state.activeId);
    }
  }catch(err){databaseAvailable=false;console.warn('KIN database unavailable; using browser fallback',err);toast('Local database unavailable. Export your profiles regularly.');}
}

function setProgress(percent,label,explanation){$('mappingBar').style.width=`${Math.round(Math.max(0,Math.min(100,percent)))}%`;$('mappingPercent').textContent=`${Math.round(Math.max(0,Math.min(100,percent)))}%`;$('mappingLabel').textContent=label;$('mappingExplain').textContent=explanation;}
function showCandidate(c,method){if(state.candidate||Date.now()-lastSuggestion<5000)return;const cue=person().cues.find(s=>s.id===c.id);if(!cue||cue.ignore)return;state.candidate={id:c.id,phrase:c.phrase,method};lastSuggestion=Date.now();$('resultPhrase').textContent=c.phrase;$('resultNote').textContent=`Possible ${method.toLowerCase()} match. Confirm with the person before speaking.`;$('confirmButton').disabled=false;$('dismissButton').disabled=false;setProgress(100,'Possible signal mapped','The bar shows detection progress, not certainty about meaning.');}
function clearCandidate(){state.candidate=null;$('resultPhrase').textContent='Nothing recognised yet';$('resultNote').textContent='A suggested meaning appears here for confirmation.';$('confirmButton').disabled=true;$('dismissButton').disabled=true;setProgress(0,'Waiting for input',state.mode==='movement'?'Start the camera to see live movement mapping.':'Start the microphone to see sound activity.');}
function resetWindows(){motionWindow=[];soundFrames=[];soundPreroll=[];stable={id:null,start:0};starterHold.reset();lastMotion=0;clearCandidate();}
function render(){const p=person();$('profileSelect').innerHTML=state.profiles.map(x=>`<option value="${encode(x.id)}" ${x.id===p.id?'selected':''}>${encode(x.name)}</option>`).join('');
  for(const b of document.querySelectorAll('[data-mode]')){b.classList.toggle('active',b.dataset.mode===state.mode);b.setAttribute('aria-pressed',String(b.dataset.mode===state.mode));}
  for(const b of document.querySelectorAll('[data-step]')){b.classList.toggle('active',b.dataset.step===state.step);b.setAttribute('aria-current',b.dataset.step===state.step?'step':'false');}
  $('cameraStage').hidden=state.mode!=='movement';$('soundStage').hidden=state.mode!=='sound';
  const info={messages:['Choose a message','Select one from the list, or add a new message for this person.'],teach:['Teach a signal','Record examples of a sound or movement this person already uses.'],test:['Live communication','Watch recognition happen, then verify any suggested message.']};
  $('panelKicker').textContent=`STEP ${['messages','teach','test'].indexOf(state.step)+1} OF 3`;$('panelTitle').textContent=info[state.step][0];$('panelDescription').textContent=info[state.step][1];
  $('asideTitle').textContent='Personal messages';$('asideCaption').textContent=`${state.mode.toUpperCase()} / VOCABULARY`;$('asideDescription').textContent=state.mode==='sound'?'Sounds and the meanings you have taught.':'Movements and the meanings you have taught.';
  $('messageDetails').hidden=state.step!=='messages';$('teachDetails').hidden=state.step!=='teach';$('testDetails').hidden=state.step!=='test';
  $('trainingMask').hidden=!(state.mode==='movement'&&state.step==='teach');$('maskFace').hidden=state.guide!=='face';$('maskUpper').hidden=state.guide!=='upper';$('maskCaption').textContent=state.guide==='face'?'Position face and hands inside the guide':'Keep head, shoulders and hands in frame';
  $('stageMode').textContent=state.step==='teach'?'TEACHING VIEW':state.step==='test'?'LIVE MAPPING':'LIVE PREVIEW';
  $('sensorButton').innerHTML=state.mode==='movement'?(stream?'■ Stop camera':'<span class="button-dot"></span> Start camera'):(micStream?'■ Stop microphone':'<span class="button-dot"></span> Start microphone');
  $('sensorState').classList.toggle('on',!!(stream||micStream));$('sensorState').innerHTML=`<span class="small-led"></span> ${stream?'Camera on':micStream?'Microphone on':'Sensor off'}`;
  $('flipButton').hidden=state.mode==='sound';$('flipButton').disabled=!stream;$('sensitivityControl').hidden=state.mode!=='sound';
  $('connectionHint').textContent=(stream||micStream)?'Processing happens on this device.':'The sensor starts only when you press the button.';
  $('movementGuide').hidden=state.mode==='sound';
  $('trainingHint').textContent=state.mode==='sound'?'Start the microphone. Record the natural sound several times, leaving a pause between each example.':'Start the camera, position the face or upper body in the guide, and demonstrate the natural gesture.';
  $('uploadLabel').childNodes[0].textContent=state.mode==='movement'?'Upload a video':'Upload an audio file';$('fileInput').accept=state.mode==='movement'?'video/*,.mp4,.mov,.webm':'audio/*,.wav,.mp3,.m4a,.ogg,.aac';
  let list=cues();$('signalList').innerHTML=list.length?list.map((c,i)=>`<div class="signal-row"><button type="button" class="signal-item ${c.id===state.chosen?'active':''} ${c.ignore?'ignored':''}" data-pick="${encode(c.id)}"><span class="signal-icon">${c.ignore?'–':String(i+1).padStart(2,'0')}</span><span class="signal-body"><strong>${encode(c.phrase)}</strong><small>${c.ignore?'Ignore / not communication · ':''}${c.examples.length} example${c.examples.length===1?'':'s'}</small></span><span class="signal-chevron">›</span></button><button class="delete-signal" type="button" data-delete="${encode(c.id)}" aria-label="Delete ${encode(c.phrase)}" title="Delete message">×</button></div>`).join(''):'<div class="empty-list">No messages yet. Add the first one above.</div>';
  let c=chosen();$('selectedMessage').textContent=c?c.phrase:'No message selected';$('detailCount').textContent=c?`${c.examples.length} examples`:'—';$('detailNote').textContent=c?`${c.ignore?'This signal is marked as not communicating.': 'Selected for teaching and testing.'} ${c.note||''}`:'Select a message in the left panel.';
  $('goTeach').disabled=!c;$('teachTitle').textContent=c?`Teach “${c.phrase}”`:'Choose a message first';$('exampleCounter').textContent=c?`${c.examples.length} recorded`:'0 recorded';$('trainingCountLabel').textContent=c?`${Math.min(5,c.examples.length)} of 5`:'0 of 5';$('trainingBar').style.width=`${Math.min(100,(c?.examples.length||0)*20)}%`;['recordButton','fileInput','removeExample'].forEach(id=>{const el=$(id);el.disabled=id==='removeExample'?!c||!c.examples.length:!c;});
  $('modelReadiness').textContent= readiness();$('starterNote').textContent=starterProfileSelected()&&state.mode==='movement'?'Example profile: four anatomical starter rules are available before training. They are demonstrations, not personalised recognition. Custom gestures still need recorded examples.':'For personalised recognition, teach at least two distinct signals in this mode, with three examples each. Add Ignore examples to reduce false detections.';
  $('soundStatus').textContent=micStream?'Listening for this person’s sounds':'Microphone is off';
}
function readiness(){const total=cues().filter(isSampleReady).length;if(total>=2)return `${total} trained signals ready to test`;if(starterProfileSelected()&&state.mode==='movement')return 'Starter gesture rules ready';return `${total} of 2 trained signals ready`;}
function setMode(mode){if(mode===state.mode)return;if(recording){toast('Finish recording first.');return;}stopCamera();stopMicrophone();state.mode=mode;state.chosen=null;resetWindows();render();}
function setStep(step){if(recording){toast('Finish recording first.');return;}state.step=step;resetWindows();render();}
function addCue(e){e.preventDefault();const phrase=$('messageInput').value.trim();if(!phrase)return;if(person().cues.length>=90){toast('The profile supports up to 90 messages.');return;}const c={id:uid(),phrase:phrase.slice(0,120),mode:state.mode,note:'',ignore:$('ignoreInput').checked,examples:[]};person().cues.push(c);state.chosen=c.id;$('messageInput').value='';$('ignoreInput').checked=false;save();setStep('teach');toast('Message added. Teach a few examples next.');}
function deleteCue(id){const c=person().cues.find(x=>x.id===id);if(!c)return;if(!confirm(`Delete “${c.phrase}” and its training examples?`))return;person().cues=person().cues.filter(x=>x.id!==id);if(state.chosen===id)state.chosen=null;save();clearCandidate();}
function addProfile(){const name=prompt('Name this communication profile:');if(!name?.trim())return;const p={id:uid(),name:name.trim().slice(0,70),cues:[]};state.profiles.push(p);switchProfile(p.id);save();toast(`Created ${p.name}'s profile.`);}
function switchProfile(id){if(recording)return;if(!state.profiles.some(p=>p.id===id))return;stopCamera();stopMicrophone();state.activeId=id;state.chosen=null;resetWindows();render();}
function manageProfiles(){const p=person();const choice=prompt(`Profile: ${p.name}\nType R to rename, D to delete, or press Cancel.`, 'R');if(!choice)return;if(choice.toLowerCase()==='r'){const name=prompt('New profile name:',p.name);if(name?.trim()){p.name=name.trim().slice(0,70);save();}}else if(choice.toLowerCase()==='d'){if(!confirm(`Delete ${p.name}'s profile and its examples?`))return;state.profiles=state.profiles.filter(x=>x.id!==p.id);if(!state.profiles.length)state.profiles=[{id:uid(),name:'New person',cues:[]}];switchProfile(state.profiles[0].id);save();}}
function download(name,content,mime='application/json'){const url=URL.createObjectURL(new Blob([content],{type:mime})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);}
function exportProfile(){download(`KIN-${person().name.replace(/[^a-z\d-]/gi,'-')}-profile.json`,JSON.stringify({format:'kin-profile',version:4,profile:person(),exportedAt:new Date().toISOString()},null,2));toast('Profile exported. Store the file securely.');}
async function importProfile(e){const file=e.target.files?.[0];e.target.value='';if(!file)return;try{if(file.size>6000000)throw Error('Profile too large.');const raw=JSON.parse(await file.text()),p=safeProfile(raw.profile||raw);if(!p)throw Error('Unsupported profile format.');p.id=uid();state.profiles.push(p);switchProfile(p.id);save();toast(`Imported ${p.name}'s profile.`);}catch(err){toast(`Could not import: ${err.message}`);}}
function saveExample(id,mode,sig){const c=person().cues.find(x=>x.id===id&&x.mode===mode);if(!c)return;c.examples.push({id:uid(),at:new Date().toISOString(),sig});c.examples=c.examples.slice(-80);save();toast(`Saved example ${c.examples.length} for “${c.phrase}”.`);}
async function ensureModels(){if(modelPromise)return modelPromise;modelPromise=(async()=>{const {FilesetResolver,FaceLandmarker,HandLandmarker,PoseLandmarker}=await import(SDK);const f=await FilesetResolver.forVisionTasks(WASM);faceModel=await FaceLandmarker.createFromOptions(f,{baseOptions:{modelAssetPath:FACE,delegate:'CPU'},runningMode:'VIDEO',numFaces:1});handModel=await HandLandmarker.createFromOptions(f,{baseOptions:{modelAssetPath:HAND,delegate:'CPU'},runningMode:'VIDEO',numHands:2});try{poseModel=await PoseLandmarker.createFromOptions(f,{baseOptions:{modelAssetPath:POSE,delegate:'CPU'},runningMode:'VIDEO',numPoses:1});}catch(e){console.warn('Optional body tracking unavailable',e);}return true;})();try{return await modelPromise;}catch(e){modelPromise=null;faceModel=handModel=poseModel=null;throw e;}}
function setLandmarkText(face,hands,pose){$('landmarkInfo').textContent=`Face ${face?'✓':'—'}    Hands ${hands||'—'}    Body ${pose?'✓':'—'}`;$('trackingState').textContent=face||hands?'TRACKING':'POSITION PERSON';}
function drawTracking(face,hands,pose){const canvas=$('trackingCanvas'),stage=$('cameraStage'),ctx=canvas.getContext('2d');const bounds=stage.getBoundingClientRect();if(!bounds.width||!bounds.height)return;const dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(bounds.width*dpr);canvas.height=Math.round(bounds.height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,bounds.width,bounds.height);if(!$('camera').videoWidth)return;const vw=$('camera').videoWidth,vh=$('camera').videoHeight,scale=Math.max(bounds.width/vw,bounds.height/vh),offx=(bounds.width-vw*scale)/2,offy=(bounds.height-vh*scale)/2;const map=p=>({x:p.x*vw*scale+offx,y:p.y*vh*scale+offy});function chain(points,idxs,color,width=1.25){ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();idxs.forEach((i,j)=>{if(!points[i])return;const p=map(points[i]);j?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y);});ctx.stroke();}
  if(face?.length>454){const meshColor='rgba(103,227,207,.48)',strong='rgba(158,246,228,.91)';// Representative mesh connections, including facial oval, eyes, brows and lips.
    for(let row=0;row<face.length;row+=7){const p=face[row],q=face[row+1];if(!q)continue;const a=map(p),b=map(q);ctx.strokeStyle=meshColor;ctx.lineWidth=.65;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}
    [[10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109,10],[33,160,158,133,153,144,33],[263,387,385,362,380,373,263],[61,40,37,0,267,270,291,321,314,17,84,91,61],[70,63,105,66,107],[300,293,334,296,336]].forEach(ch=>chain(face,ch,strong,1.1));
    ctx.fillStyle='rgba(161,244,230,.92)';for(let k=0;k<face.length;k+=8){const p=map(face[k]);ctx.beginPath();ctx.arc(p.x,p.y,1.05,0,Math.PI*2);ctx.fill();}
  }
  const handChains=[[0,1,2,3,4],[0,5,6,7,8],[5,9,10,11,12],[9,13,14,15,16],[13,17,18,19,20],[0,17]];
  for(const h of hands||[]){for(const c of handChains)chain(h,c,'rgba(121,255,213,.95)',2.1);ctx.fillStyle='#e2fff2';for(const pt of h){const p=map(pt);ctx.beginPath();ctx.arc(p.x,p.y,2.25,0,2*Math.PI);ctx.fill();}}
  if(pose?.length>24){for(const [a,b] of [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24]])chain(pose,[a,b],'rgba(126,231,210,.69)',1.5);}
}
async function startCamera(){if(!navigator.mediaDevices?.getUserMedia)throw Error('Open on localhost or HTTPS.');$('trackingState').textContent='STARTING CAMERA';stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:state.facing||'user',width:{ideal:960},height:{ideal:720}},audio:false});$('camera').srcObject=stream;await $('camera').play();$('cameraEmpty').hidden=true;render();$('trackingState').textContent='LOADING TRACKER';raf=requestAnimationFrame(cameraTick);try{await ensureModels();$('trackingState').textContent='LOOKING FOR PERSON';}catch(err){stopCamera();throw err;}}
function stopCamera(){cancelAnimationFrame(raf);raf=0;stream?.getTracks().forEach(t=>t.stop());stream=null;$('camera').srcObject=null;$('cameraEmpty').hidden=false;const canvas=$('trackingCanvas');canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);$('trackingState').textContent='NOT STARTED';$('landmarkInfo').textContent='Face —   Hands —';resetWindows();render();}
async function toggleCamera(){if(stream){stopCamera();return;}try{await startCamera();toast('Camera ready. Show a gesture in the frame.');}catch(e){toast(`Camera error: ${e.message}`);}}
async function flipCamera(){if(!stream)return;state.facing=(state.facing||'user')==='user'?'environment':'user';stopCamera();try{await startCamera();}catch(e){toast(e.message);}}
function updateMotion(now){if(!stream||!faceModel||!handModel||$('camera').readyState<2||state.mode!=='movement')return;const timestamp=visionTs=Math.max(performance.now(),visionTs+1);let f,h,p;try{f=faceModel.detectForVideo($('camera'),timestamp).faceLandmarks?.[0];h=handModel.detectForVideo($('camera'),timestamp+.001).landmarks||[];p=poseModel?.detectForVideo($('camera'),timestamp+.002).landmarks?.[0];}catch(e){console.warn('Tracking error',e);$('trackingState').textContent='TRACKER ERROR';return;}
  drawTracking(f,h,p);setLandmarkText(Boolean(f),h.length,Boolean(p));if(state.step==='teach')$('maskCaption').textContent=state.guide==='face'?(f?'Face detected — show the gesture inside the guide':'Move closer until your face is visible'):(p?'Upper body visible — keep hands inside the guide':'Position head and shoulders inside the guide');const vec=extractMotionFrame(f,h,p);
  if(recording?.mode==='movement'){if(vec)recording.frames.push(vec);return;}
  if(state.step!=='test'||state.candidate)return;
  if(!vec){motionWindow=[];starterHold.reset();setProgress(0,'Looking for person','Keep the face and hands visible to the camera.');return;}
  motionWindow.push({t:now,vec});motionWindow=motionWindow.filter(x=>now-x.t<3100);
  const ready=cues().filter(isSampleReady).length>=2;
  if(ready){const scanned=Math.min(88,Math.round((now-motionWindow[0].t)/2500*88));setProgress(scanned,'Mapping learned movement',`${motionWindow.length} tracked frames collected. Keep demonstrating the movement.`);
    if(now-lastMotion<500||motionWindow.length<9||now-motionWindow[0].t<2250)return;lastMotion=now;const sig=makeMotionSignature(motionWindow.map(x=>x.vec));if(!sig)return;const result=matchInput('movement',sig,cues());
    if(result.status==='candidate'){if(stable.id===result.cueId&&now-stable.start<1800){showCandidate({id:result.cueId,phrase:result.phrase},'Movement');stable={id:null,start:0};motionWindow=[];}else stable={id:result.cueId,start:now};setProgress(90,`Possible: ${result.phrase}`,'Confirming a repeated match before suggesting it.');}
    else{stable={id:null,start:0};if(result.status==='unknown')setProgress(45,'Movement not recognised','No clear trained match. Nothing will be spoken.');else if(result.status==='ignored')setProgress(30,'Known non-message movement','This movement is marked as Ignore.');}
  }else if(starterProfileSelected()){
    const features=extractFeatures(f,h),classification=classify(features,{}),r=starterHold.update(classification,now,{holdMs:1100,threshold:.72,margin:.07});
    setProgress(r.candidate?Math.round(r.progress*100):Math.min(20,h.length*10),r.candidate?`Mapping: ${r.candidate.full}`:'Hand and face mapping active',r.candidate?'Hold the position until the bar completes.':'Move one hand towards the mouth, chin, eyes or ear.');
    if(r.fired){const phrase=originalMap[r.fired.id],c=person().cues.find(x=>x.mode==='movement'&&x.phrase===phrase);if(c)showCandidate({id:c.id,phrase},'Starter gesture rule');}
  }else setProgress(25,'Tracking movement','Teach at least two signals with three examples each to enable personalised recognition.');
}
function cameraTick(t){if(!stream)return;raf=requestAnimationFrame(cameraTick);if(t-lastVideo<125)return;lastVideo=t;updateMotion(t);}
function snapshot(){analyser.getFloatTimeDomainData(audioTime);analyser.getFloatFrequencyData(audioFreq);return frameFeatures(audioTime,audioFreq,audioContext.sampleRate);}
function audioLoop(){if(!analyser||state.mode!=='sound')return;const frame=snapshot(),level=Math.min(100,Math.round(frame.rms*1100));$('soundLevelFill').style.width=level+'%';$('soundLevelText').textContent=level+'%';const bars=$('soundBars').children;for(let i=0;i<bars.length;i++){const n=Math.floor(i*audioFreq.length/bars.length);const d=Math.max(-100,Math.min(-15,audioFreq[n]||-100));bars[i].style.height=`${Math.max(7,7+(d+100)*.53)}px`;}
  if(recording?.mode==='sound'){recording.frames.push(frame);return;}
  if(state.step!=='test'||state.candidate){soundFrames=[];return;}
  const threshold=Math.max(Number($('sensitivityRange').value)/1000,noise*2.6);if(frame.rms<threshold)noise=Math.max(.001,Math.min(.03,noise*.985+frame.rms*.015));const t=Date.now();
  setProgress(level,'Listening for a sound',`Input level ${level}%. A distinct vocalisation will be analysed after it ends.`);
  if(frame.rms>=threshold){if(!soundFrames.length){soundFrames=[...soundPreroll];soundStarted=t;}soundFrames.push(frame);lastLoud=t;}
  else if(soundFrames.length){soundFrames.push(frame);if(t-lastLoud>320||t-soundStarted>3100){const items=soundFrames;soundFrames=[];if(t-soundStarted<110)return;const sig=makeSoundSignature(items);if(sig){const result=matchInput('sound',sig,cues());if(result.status==='candidate'){showCandidate({id:result.cueId,phrase:result.phrase},'Sound');}else if(result.status==='not-ready')setProgress(0,'More training required',result.detail);else if(result.status==='unknown')setProgress(0,'Sound not recognised','Nothing was translated. Add examples or record an Ignore class.');else if(result.status==='ignored')setProgress(0,'Known non-message sound','No translation produced.');}}}
  if(frame.rms<threshold)soundPreroll=[...soundPreroll.slice(-2),frame];
}
async function startMicrophone(){if(!navigator.mediaDevices?.getUserMedia)throw Error('Open on localhost or HTTPS.');micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});audioContext=new (window.AudioContext||window.webkitAudioContext)();await audioContext.resume();source=audioContext.createMediaStreamSource(micStream);analyser=audioContext.createAnalyser();analyser.fftSize=2048;analyser.smoothingTimeConstant=.33;source.connect(analyser);audioTime=new Float32Array(analyser.fftSize);audioFreq=new Float32Array(analyser.frequencyBinCount);audioTimer=setInterval(audioLoop,50);soundFrames=[];soundPreroll=[];noise=.007;render();}
async function stopMicrophone(){clearInterval(audioTimer);audioTimer=0;micStream?.getTracks().forEach(t=>t.stop());micStream=null;try{source?.disconnect();await audioContext?.close();}catch{}source=null;analyser=null;audioContext=null;soundFrames=[];$('soundLevelFill').style.width='0%';$('soundLevelText').textContent='0%';render();}
async function toggleMicrophone(){if(micStream){await stopMicrophone();return;}try{await startMicrophone();toast('Microphone ready. Make a sound to test it.');}catch(e){toast(`Microphone error: ${e.message}`);await stopMicrophone();}}
function sensorToggle(){if(state.mode==='movement')toggleCamera();else toggleMicrophone();}
function openRecord(c){$('recordModal').hidden=false;$('recordTitle').textContent=`Teach “${c.phrase}”`;$('recordDescription').textContent=c.mode==='movement'?'Make the movement naturally. The live camera and positioning guide remain visible behind this counter.':'Make the sound naturally during the recording.';}
function closeRecord(){clearInterval(recordTimer);recordTimer=0;$('recordModal').hidden=true;}
function finishRecord(){if(!recording)return;const r=recording;recording=null;closeRecord();const sig=r.mode==='movement'?makeMotionSignature(r.frames):makeSoundSignature(r.frames);if(!sig){toast('Not enough usable frames were captured. Adjust position or microphone level.');render();return;}saveExample(r.id,r.mode,sig);render();}
function cancelRecord(){recording=null;closeRecord();render();toast('Recording cancelled.');}
function startRecord(){if(recording||importing)return;const c=chosen();if(!c){toast('Choose a message first.');return;}if(c.mode==='movement'&&!stream){toast('Start camera first.');return;}if(c.mode==='sound'&&!micStream){toast('Start microphone first.');return;}recording={id:c.id,mode:c.mode,frames:[],started:Date.now()};openRecord(c);recordTimer=setInterval(()=>{if(!recording)return;const elapsed=Date.now()-recording.started;$('countdownText').textContent=Math.max(0,(3000-elapsed)/1000).toFixed(1);$('captureBar').style.width=Math.min(100,elapsed/30)+'%';if(elapsed>=3000)finishRecord();},60);}
async function importSample(e){const file=e.target.files?.[0];e.target.value='';const c=chosen();if(!file||!c||importing)return;if(file.size>(c.mode==='sound'?25000000:140000000)){toast('File too large.');return;}importing=true;$('recordButton').disabled=true;try{
  if(c.mode==='sound'){let ctx=new (window.AudioContext||window.webkitAudioContext)();try{const sound=await ctx.decodeAudioData(await file.arrayBuffer());if(sound.duration>25)throw Error('Choose audio shorter than 25 seconds.');let pcm=sound.getChannelData(0);if(sound.numberOfChannels>1)pcm=Float32Array.from(pcm,(_,i)=>Array.from({length:sound.numberOfChannels},(_,j)=>sound.getChannelData(j)[i]).reduce((a,b)=>a+b,0)/sound.numberOfChannels);const sig=makeSoundSignature(soundFramesFromPcm(pcm,sound.sampleRate,12));if(!sig)throw Error('No usable sound detected.');saveExample(c.id,c.mode,sig);}finally{await ctx.close().catch(()=>{});}}
  else{await ensureModels();const video=$('importVideo'),url=URL.createObjectURL(file),frames=[];try{video.src=url;await new Promise((yes,no)=>{video.onloadedmetadata=yes;video.onerror=()=>no(Error('Cannot read this video.'));});if(!Number.isFinite(video.duration)||video.duration>45)throw Error('Use a video under 45 seconds.');await video.play();let last=0,start=now();while(!video.ended&&now()-start<47000){const t=now();if(video.readyState>=2&&t-last>130){last=t;const ts=visionTs=Math.max(t,visionTs+1);const f=faceModel.detectForVideo(video,ts).faceLandmarks?.[0],h=handModel.detectForVideo(video,ts+.001).landmarks||[],p=poseModel?.detectForVideo(video,ts+.002).landmarks?.[0],v=extractMotionFrame(f,h,p);if(v)frames.push(v);}await sleep(50);}const sig=makeMotionSignature(frames);if(!sig)throw Error('No usable motion frames. Keep face or hands in view.');saveExample(c.id,c.mode,sig);}finally{video.pause();video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}}
}catch(e){toast(`Import failed: ${e.message}`);}finally{importing=false;render();}}
function confirmCandidate(yes){const c=state.candidate;if(!c)return;if(yes&&$('speakCheckbox').checked&&'speechSynthesis' in window){const text=c.phrase;try{speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(text);utterance.lang='en-AU';utterance.rate=.93;speechSynthesis.speak(utterance);}catch{}}
  toast(yes?`Message confirmed: ${c.phrase}`:'Suggestion dismissed');const event={at:new Date().toISOString(),profileId:state.activeId,cueId:c.id,phrase:c.phrase,method:c.method,confirmed:yes};state.events.unshift(event);if(databaseAvailable)writeCommunicationEvent(event).catch(err=>console.warn('Could not save recognition event',err));clearCandidate();stable={id:null,start:0};motionWindow=[];soundFrames=[];}
function renderAudioBars(){$('soundBars').innerHTML=Array.from({length:36},()=>'<i></i>').join('');}
function wire(){document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));document.querySelectorAll('[data-step]').forEach(b=>b.addEventListener('click',()=>setStep(b.dataset.step)));
  document.querySelectorAll('[data-guide]').forEach(b=>b.addEventListener('click',()=>{state.guide=b.dataset.guide;document.querySelectorAll('[data-guide]').forEach(x=>x.classList.toggle('active',x===b));render();}));
  $('profileSelect').addEventListener('change',e=>switchProfile(e.target.value));$('addProfileBtn').addEventListener('click',addProfile);$('manageBtn').addEventListener('click',manageProfiles);$('messageForm').addEventListener('submit',addCue);
  $('signalList').addEventListener('click',e=>{const del=e.target.closest('[data-delete]');if(del){deleteCue(del.dataset.delete);return;}const btn=e.target.closest('[data-pick]');if(btn){state.chosen=btn.dataset.pick;render();}});
  $('goTeach').addEventListener('click',()=>setStep('teach'));$('sensorButton').addEventListener('click',sensorToggle);$('flipButton').addEventListener('click',flipCamera);$('recordButton').addEventListener('click',startRecord);$('cancelRecord').addEventListener('click',cancelRecord);$('fileInput').addEventListener('change',importSample);$('removeExample').addEventListener('click',()=>{const c=chosen();if(c?.examples.length){c.examples.pop();save();toast('Removed the last training example.');}});
  $('confirmButton').addEventListener('click',()=>confirmCandidate(true));$('dismissButton').addEventListener('click',()=>confirmCandidate(false));$('exportBtn').addEventListener('click',exportProfile);$('importInput').addEventListener('change',importProfile);
  $('sensitivityRange').addEventListener('input',e=>$('sensitivityLabel').textContent=e.target.value);$('helpBtn').addEventListener('click',()=>$('helpModal').hidden=false);$('closeHelp').addEventListener('click',()=>$('helpModal').hidden=true);$('helpDone').addEventListener('click',()=>$('helpModal').hidden=true);$('helpModal').addEventListener('click',e=>{if(e.target===$('helpModal'))$('helpModal').hidden=true;});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){if(recording)cancelRecord();if(stream)stopCamera();if(micStream)stopMicrophone();}});
  window.addEventListener('pagehide',()=>{stream?.getTracks().forEach(t=>t.stop());micStream?.getTracks().forEach(t=>t.stop());});
}
// Directly mounted DOM controls, with no background media activation.
await initialiseDatabase();
renderAudioBars();wire();state.chosen=cues()[0]?.id||null;render();resetWindows();
