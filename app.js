import {starterProfile,safeProfile,uid,extractMotionFrame,makeMotionSignature,makeSceneSignature,normaliseScene,matchInput} from './recognition-core.js';
import {frameFeatures} from './voice-recognition.js';
import {makeSoundSignature,soundFramesFromPcm} from './sound-utils.js';

const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,k=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[k]));
const KEY='kin.studio.profiles.v3',ACTIVE='kin.studio.active.v3';
let profiles=loadProfiles(),activeId=localStorage.getItem(ACTIVE)||profiles[0].id;
if(!profiles.some(p=>p.id===activeId))activeId=profiles[0].id;
const selected=()=>profiles.find(p=>p.id===activeId)||profiles[0];
let selectedCue=null,tab='home',events=[],candidate=null,toastTimeout=0;
let cameraStream=null,cameraFacing='user',faceModel=null,handModel=null,poseModel=null,sceneModel=null,sceneTask=null,visionFiles=null,modelsTask=null,camRaf=0,prevInference=0,visualWindow=[],lastVisualClassified=0,visionStreak=null,visionLast=0,visualCooldown=0,sceneWindow=[],sceneLast=0,sceneStreak=null,sceneCooldown=0;
let micStream=null,audioCtx=null,source=null,analyser=null,micTick=0,timeData=null,freqData=null,noiseFloor=.007,preRoll=[],activeSound=[],lastSoundAt=0,soundStart=0,pausedAudioUntil=0;
let capture=null,captureTimer=0,importing=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function loadProfiles(){try{const val=JSON.parse(localStorage.getItem(KEY)||'');const clean=(Array.isArray(val)?val:[]).slice(0,30).map(safeProfile).filter(Boolean);if(clean.length)return clean;}catch{}return [starterProfile()];}
function save(){try{localStorage.setItem(KEY,JSON.stringify(profiles));localStorage.setItem(ACTIVE,activeId);}catch{toast('Browser storage full/unavailable. Export your profile.');}render();}
function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('open');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>t.classList.remove('open'),3800);}
function showTab(name){tab=name;for(const b of document.querySelectorAll('.tab')){const yes=b.dataset.tab===name;b.classList.toggle('active',yes);b.setAttribute('aria-current',yes?'page':'false');}for(const n of document.querySelectorAll('.panel'))n.hidden=n.id!==name;try{history.replaceState(null,'','#'+name);}catch{}if(name==='train'||name==='live')updateDeviceLabels();if(name==='live'&&cameraStream&&selected().cues.some(c=>c.mode==='scene'))ensureScene().catch(e=>toast('Scene model unavailable: '+e.message));}
function render(){
  const p=selected();$('profileSelect').innerHTML=profiles.map(a=>`<option value="${esc(a.id)}" ${a.id===activeId?'selected':''}>${esc(a.name)}</option>`).join('');
  $('currentPerson').textContent=p.name;$('cueCount').textContent=p.cues.filter(c=>!c.ignore).length;
  $('sampleCount').textContent=p.cues.reduce((n,c)=>n+c.examples.length,0);$('vocabHeading').textContent=`Signals for ${p.name}`;
  $('vocabulary').innerHTML=p.cues.length?p.cues.map(c=>{
    const count=c.examples.length;
    return `<article class="vocab-card"><div class="vocab-head"><strong>${esc(c.phrase)}</strong><span class="vocab-mode">${c.ignore?'IGNORE · ':''}${c.mode==='sound'?'SOUND':c.mode==='scene'?'VISUAL SCENE':'MOVEMENT'}</span></div><p>${esc(c.note||'Custom personal signal')}</p><div class="vocab-stats"><span>${count} TRAINING EXAMPLES</span><span>${count>=3?'MINIMUM SAMPLES MET':'MORE EXAMPLES NEEDED'}</span></div><div class="vocab-controls"><button class="button outline ${selectedCue===c.id?'selected':''}" data-select="${esc(c.id)}">${selectedCue===c.id?'✓ SELECTED':'+ TRAIN'}</button><button class="button outline" data-undo="${esc(c.id)}" ${count?'':'disabled'}>REMOVE LAST</button><button class="button outline delete" data-delete="${esc(c.id)}">DELETE</button></div></article>`;
  }).join(''):'<div class="empty">No signals yet. Create the first sound or movement above.</div>';
  const cue=p.cues.find(c=>c.id===selectedCue);
  $('captureHint').textContent=cue?`${cue.mode.toUpperCase()} · ${cue.phrase.slice(0,28)}`:'SELECT A SIGNAL';
  $('captureStatus').textContent=capture?`Capturing ${cue?.phrase||'signal'}…`:cue?`Selected: “${cue.phrase}”. Start the ${cue.mode==='sound'?'microphone':'camera'} and record examples.`:'Select a signal from the list below to begin training.';
  $('captureButton').disabled=!cue||Boolean(capture)||importing;
  $('captureButton').textContent=cue?`RECORD ${cue.mode==='sound'?'SOUND':cue.mode==='scene'?'VISUAL SCENE':'MOVEMENT'} · 3 SEC`:'SELECT A SIGNAL TO RECORD';
  $('videoUploadLabel').hidden=!cue||!['movement','scene'].includes(cue.mode);$('videoUploadLabel').childNodes[0].textContent=cue?.mode==='scene'?'IMPORT A SCENE VIDEO':'IMPORT A MOVEMENT VIDEO';
  $('audioUploadLabel').hidden=!cue||cue.mode!=='sound';
  if(candidate&&candidate.profileId!==activeId)clearCandidate();
}
function updateDeviceLabels(){
  $('cameraButton').textContent=cameraStream?'■ STOP CAMERA':'◉ START CAMERA';$('micButton').textContent=micStream?'■ STOP MICROPHONE':'◉ START MICROPHONE';
  $('cameraChip').textContent=cameraStream?'● CAMERA ACTIVE':'○ CAMERA OFF';$('cameraChip').classList.toggle('on',!!cameraStream);
  $('micChip').textContent=micStream?'● MICROPHONE ACTIVE':'○ MICROPHONE OFF';$('micChip').classList.toggle('on',!!micStream);
  $('liveDeviceState').textContent=[cameraStream?'CAMERA':null,micStream?'AUDIO':null].filter(Boolean).join(' + ')||'OFFLINE';
  $('previewEmpty').hidden=Boolean(cameraStream);$('previewStatus').textContent=cameraStream?(faceModel?'TRACKING READY':'LOADING MODELS'):'CAMERA NOT STARTED';
}
function editProfile(which){
  if(capture||importing){toast('Finish training before changing profile.');return;}
  if(which==='new'){const name=prompt('Name this communication profile:');if(!name?.trim())return;const p={id:uid(),name:name.trim().slice(0,70),cues:[]};profiles.push(p);activeId=p.id;selectedCue=null;clearCandidate();save();showTab('train');toast(`Created profile for ${p.name}`);}
  if(which==='rename'){const p=selected();const name=prompt('Profile name:',p.name);if(!name?.trim())return;p.name=name.trim().slice(0,70);save();}
  if(which==='delete'){const p=selected();if(!confirm(`Permanently delete ${p.name} and all saved signal templates from this browser?`))return;profiles=profiles.filter(x=>x.id!==p.id);if(!profiles.length)profiles=[{id:uid(),name:'New person',cues:[]}];activeId=profiles[0].id;selectedCue=null;clearCandidate();save();}
}
function addCue(ev){ev.preventDefault();const phrase=$('cuePhrase').value.trim();if(!phrase)return;const mode=$('cueMode').value,ignore=$('cueKind').value==='ignore';const p=selected();if(p.cues.length>=90){toast('Maximum 90 signals per profile.');return;}const c={id:uid(),phrase:phrase.slice(0,120),mode,ignore,note:$('cueNote').value.trim().slice(0,240),examples:[]};p.cues.push(c);selectedCue=c.id;$('cueForm').reset();save();toast(`Added “${c.phrase}”. Teach it some examples.`);}
function selectCue(id){selectedCue=id;render();$('captureStatus').scrollIntoView({behavior:'smooth',block:'center'});}
function alterCue(id,action){const p=selected(),c=p.cues.find(x=>x.id===id);if(!c)return;if(action==='delete'){if(!confirm(`Delete “${c.phrase}” and all of its learned examples?`))return;p.cues=p.cues.filter(x=>x.id!==id);if(selectedCue===id)selectedCue=null;}else if(action==='undo'){c.examples.pop();}save();}
function download(name,body,mime='application/json'){const b=new Blob([body],{type:mime});const url=URL.createObjectURL(b),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
function exportProfile(){const p=selected();download(`KIN-${p.name.replace(/[^a-z0-9]+/gi,'-').slice(0,30)}-profile.json`,JSON.stringify({format:'kin-profile',version:3,exportedAt:new Date().toISOString(),profile:p},null,2));toast('Exported learned feature templates (no raw audio/video).');}
async function importProfile(ev){const file=ev.target.files?.[0];ev.target.value='';if(!file)return;if(file.size>6e6){toast('Profile file is too large (6 MB max).');return;}try{const data=JSON.parse(await file.text()),p=safeProfile(data.profile||data);if(!p)throw Error('Not a valid KIN v0.3 profile file.');p.id=uid();profiles.push(p);activeId=p.id;selectedCue=null;save();toast(`Imported profile “${p.name}” with ${p.cues.length} signals.`);showTab('train');}catch(e){toast(`Import failed: ${e.message}`);}}
function saveExample(cueId,mode,signature){const cue=selected().cues.find(c=>c.id===cueId&&c.mode===mode);if(!cue){toast('Signal not found in current profile.');return;}cue.examples.push({id:uid(),at:new Date().toISOString(),sig:signature});cue.examples=cue.examples.slice(-80);save();toast(`Learned example ${cue.examples.length} for “${cue.phrase}”.`);}

// MediaPipe runs on the user's device. First use fetches the free public model files.
const SDK='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.2/vision_bundle.mjs';
const WASM='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.2/wasm';
const FACE='https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const HAND='https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const POSE='https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
async function ensureModels(){if(modelsTask)return modelsTask;modelsTask=(async()=>{
  const {FilesetResolver,FaceLandmarker,HandLandmarker,PoseLandmarker}=await import(SDK);
  const files=await FilesetResolver.forVisionTasks(WASM);visionFiles=files;
  faceModel=await FaceLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:FACE,delegate:'CPU'},runningMode:'VIDEO',numFaces:1});
  handModel=await HandLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:HAND,delegate:'CPU'},runningMode:'VIDEO',numHands:2});
  try{poseModel=await PoseLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:POSE,delegate:'CPU'},runningMode:'VIDEO',numPoses:1});}
  catch(e){console.warn('KIN: optional body pose model unavailable; hands and face continue.',e);poseModel=null;}
  updateDeviceLabels();return true;
})();try{return await modelsTask;}catch(e){modelsTask=null;throw e;}}
const SCENE_MODEL='https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_small/float32/1/mobilenet_v3_small.tflite';
async function ensureScene(){
  if(sceneModel)return true;if(sceneTask)return sceneTask;
  sceneTask=(async()=>{await ensureModels();const {ImageEmbedder}=await import(SDK);
    sceneModel=await ImageEmbedder.createFromOptions(visionFiles,{baseOptions:{modelAssetPath:SCENE_MODEL,delegate:'CPU'},runningMode:'VIDEO'});
    return true;
  })();try{return await sceneTask;}catch(e){sceneTask=null;throw e;}
}
function sceneFrame(media){if(!sceneModel)return null;const ts=modelTs=Math.max(performance.now(),modelTs+1);const emb=sceneModel.embedForVideo(media,ts).embeddings?.[0];return normaliseScene(emb?.floatEmbedding||emb?.quantizedEmbedding||null);}
let modelTs=0;function inferFrame(media){const stamp=modelTs=Math.max(performance.now(),modelTs+1);const f=faceModel.detectForVideo(media,stamp),h=handModel.detectForVideo(media,stamp+.001),p=poseModel?.detectForVideo(media,stamp+.002);return extractMotionFrame(f.faceLandmarks?.[0],h.landmarks,p?.landmarks?.[0]);}
async function startCamera(){if(!navigator.mediaDevices?.getUserMedia)throw Error('Use HTTPS or localhost to enable the camera.');cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:cameraFacing,width:{ideal:720},height:{ideal:540}},audio:false});$('video').srcObject=cameraStream;await $('video').play();updateDeviceLabels();$('previewStatus').textContent='DOWNLOADING CAMERA MODELS';try{await ensureModels();}catch(e){stopCamera();throw e;}visualWindow=[];sceneWindow=[];camRaf=requestAnimationFrame(cameraTick);if(selected().cues.some(c=>c.mode==='scene'))ensureScene().catch(e=>toast('Scene recognition unavailable: '+e.message));}
function stopCamera(){cancelAnimationFrame(camRaf);camRaf=0;cameraStream?.getTracks().forEach(t=>t.stop());cameraStream=null;$('video').srcObject=null;visualWindow=[];sceneWindow=[];updateDeviceLabels();}
async function toggleCamera(){if(cameraStream){stopCamera();return;}try{await startCamera();toast('Camera ready. Movement processing stays in this browser.');}catch(e){toast(`Camera error: ${e.message}`);}}
function cameraTick(now){if(!cameraStream)return;camRaf=requestAnimationFrame(cameraTick);if(importing||!faceModel||$('video').readyState<2||now-prevInference<150)return;prevInference=now;let vec;try{vec=inferFrame($('video'));}catch(e){console.warn('Camera inference:',e);return;}
  $('previewStatus').textContent=vec?'LANDMARKS FOUND':'LOOKING FOR A PERSON';
  if(sceneModel && (capture?.mode==='scene'||(tab==='live'&&selected().cues.some(c=>c.mode==='scene')))&&now-sceneLast>500){
    sceneLast=now;try{const sv=sceneFrame($('video'));if(sv){
      if(capture?.mode==='scene')capture.frames.push(sv);
      else if(tab==='live'){
        sceneWindow.push({t:now,sv});sceneWindow=sceneWindow.filter(x=>now-x.t<3500);
        if(now-sceneCooldown>6000&&sceneWindow.length>=5){
          const ss=makeSceneSignature(sceneWindow.map(x=>x.sv)),sm=ss&&matchInput('scene',ss,selected().cues);
          if(sm?.status==='candidate'){
            if(sceneStreak?.id===sm.cueId&&now-sceneStreak.at<2200){suggest(sm,'Camera / visual scene');sceneCooldown=now;sceneStreak=null;sceneWindow=[];}
            else sceneStreak={id:sm.cueId,at:now};
          }else sceneStreak=null;
        }
      }
    }}catch(e){console.warn('Scene embedding failed',e);}
  }
  if(capture?.mode==='scene')return;
  if(capture?.mode==='movement'){if(vec)capture.frames.push(vec);return;}
  if(!vec){visualWindow=[];visionStreak=null;return;}
  visualWindow.push({t:now,vec});visualWindow=visualWindow.filter(x=>now-x.t<3100);
  if(tab!=='live'||now-visualCooldown<5000||now-lastVisualClassified<700||visualWindow.length<10||now-visualWindow[0].t<2450)return;
  lastVisualClassified=now;const sig=makeMotionSignature(visualWindow.map(x=>x.vec));if(!sig)return;
  const result=matchInput('movement',sig,selected().cues);
  if(result.status!=='candidate'){visionStreak=null;return;}
  if(visionStreak?.id===result.cueId&&now-visionStreak.at<1300){suggest(result,'Camera / learned movement');visualCooldown=now;visionStreak=null;visualWindow=[];}
  else visionStreak={id:result.cueId,at:now};
}

// Sound: compact log-frequency and temporal features, not automatic speech transcription.
function audioSnapshot(){analyser.getFloatTimeDomainData(timeData);analyser.getFloatFrequencyData(freqData);return frameFeatures(timeData,freqData,audioCtx.sampleRate);}
function micLoop(){if(!analyser)return;const frame=audioSnapshot();$('audioLevel').style.width=`${Math.min(100,Math.round(frame.rms*1100))}%`;
  const threshold=Math.max(Number($('sensitivity').value)/1000,noiseFloor*2.8);
  if(frame.rms<threshold)noiseFloor=Math.min(.03,Math.max(.001,noiseFloor*.98+frame.rms*.02));
  if(capture?.mode==='sound'){capture.frames.push(frame);return;}
  if(Date.now()<pausedAudioUntil){activeSound=[];return;}
  if(tab!=='live'){activeSound=[];return;}
  const now=Date.now();
  if(frame.rms>=threshold){if(!activeSound.length){activeSound=[...preRoll];soundStart=now;}activeSound.push(frame);lastSoundAt=now;}
  else if(activeSound.length){activeSound.push(frame);if(now-lastSoundAt>360||now-soundStart>3000){const signal=activeSound;activeSound=[];if(now-soundStart>140){const sig=makeSoundSignature(signal);if(sig){const match=matchInput('sound',sig,selected().cues);if(match.status==='candidate')suggest(match,'Microphone / learned sound');else if(match.status==='unknown')$('candidateNote').textContent='Unrecognised sound. No translation was made.';}}}}
  if(frame.rms<threshold)preRoll=[...preRoll.slice(-2),frame];
}
async function startMic(){if(!navigator.mediaDevices?.getUserMedia)throw Error('Use HTTPS or localhost to enable the microphone.');micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:false,autoGainControl:true},video:false});audioCtx=new (window.AudioContext||window.webkitAudioContext)();await audioCtx.resume();source=audioCtx.createMediaStreamSource(micStream);analyser=audioCtx.createAnalyser();analyser.fftSize=2048;analyser.smoothingTimeConstant=.38;source.connect(analyser);timeData=new Float32Array(analyser.fftSize);freqData=new Float32Array(analyser.frequencyBinCount);noiseFloor=.007;preRoll=[];activeSound=[];micTick=setInterval(micLoop,50);updateDeviceLabels();}
async function stopMic(){clearInterval(micTick);micTick=0;micStream?.getTracks().forEach(t=>t.stop());micStream=null;try{source?.disconnect();await audioCtx?.close();}catch{}source=null;analyser=null;audioCtx=null;activeSound=[];$('audioLevel').style.width='0%';updateDeviceLabels();}
async function toggleMic(){if(micStream){await stopMic();return;}try{await startMic();toast('Microphone ready. Sound processing stays in this browser.');}catch(e){toast(`Microphone error: ${e.message}`);await stopMic();}}

function openCapture(cue){$('dialogShade').hidden=false;$('dialogTitle').textContent=`Teach: ${cue.phrase}`;$('dialogEyebrow').textContent=cue.mode==='sound'?'SOUND TRAINING':cue.mode==='scene'?'SCENE TRAINING':'MOVEMENT TRAINING';$('dialogDetail').textContent=`Make this person's natural ${cue.mode==='sound'?'sound':cue.mode==='scene'?'visual scene':'movement'} during the recording.`;$('dialogCountdown').textContent='3';$('captureProgress').style.width='0%';}
function closeCapture(){clearInterval(captureTimer);captureTimer=0;$('dialogShade').hidden=true;}
async function recordExample(){if(capture||importing)return;const c=selected().cues.find(x=>x.id===selectedCue);if(!c)return;
  if(c.mode==='sound'&&!micStream){toast('Start the microphone first.');return;}
  if(c.mode!=='sound'&&!cameraStream){toast('Start the camera first.');return;}
  if(c.mode==='scene')try{await ensureScene();}catch(e){toast('Could not load visual scene model: '+e.message);return;}
  capture={id:c.id,profileId:activeId,mode:c.mode,frames:[],at:Date.now(),seconds:3};openCapture(c);render();
  captureTimer=setInterval(()=>{if(!capture)return;const elapsed=Date.now()-capture.at;const remaining=Math.max(0,3-elapsed/1000);$('dialogCountdown').textContent=remaining.toFixed(1);$('captureProgress').style.width=`${Math.min(100,elapsed/30)}%`;if(remaining<=0)finishCapture();},80);
}
function finishCapture(){if(!capture)return;const x=capture;capture=null;closeCapture();let signature=x.mode==='sound'?makeSoundSignature(x.frames):x.mode==='scene'?makeSceneSignature(x.frames):makeMotionSignature(x.frames);
  if(x.profileId!==activeId){toast('Profile changed. Sample discarded.');render();return;}
  if(!signature){toast(x.mode==='sound'?'No clear sound captured. Try again a little closer to the microphone.':x.mode==='scene'?'Not enough scene frames. Keep the scene in view for the full three seconds.':'Not enough visible landmark frames. Keep the person in view.');render();return;}
  saveExample(x.id,x.mode,signature);render();}
function cancelCapture(){capture=null;closeCapture();render();toast('Training cancelled. No example was saved.');}
async function importVideo(ev){const file=ev.target.files?.[0];ev.target.value='';if(!file)return;const cue=selected().cues.find(c=>c.id===selectedCue&&['movement','scene'].includes(c.mode));if(!cue)return;if(importing||capture)return;
  if(file.size>140e6){toast('Video file too large; limit 140 MB.');return;}importing=true;$('captureStatus').textContent=`Preparing ${file.name}…`;$('captureButton').disabled=true;
  const vid=$('importVideo'),url=URL.createObjectURL(file),samples=[];
  try{
    await ensureModels();if(cue.mode==='scene')await ensureScene();vid.src=url;await new Promise((resolve,reject)=>{vid.onloadedmetadata=resolve;vid.onerror=()=>reject(Error('Could not read this video format.'));});
    if(!Number.isFinite(vid.duration)||vid.duration>45)throw Error('Use a video shorter than 45 seconds.');
    await vid.play();const start=performance.now();let last=0;
    while(!vid.ended&&performance.now()-start<47000){if(vid.readyState>=2&&performance.now()-last>140){last=performance.now();const v=cue.mode==='scene'?sceneFrame(vid):inferFrame(vid);if(v)samples.push(v);}$('captureStatus').textContent=`Analysing clip… ${samples.length} usable frames`;await sleep(45);}
    const signature=cue.mode==='scene'?makeSceneSignature(samples):makeMotionSignature(samples);
    if(!signature)throw Error('Too few usable video frames. Try a clearer clip.');
    saveExample(cue.id,cue.mode,signature);toast(`Imported one training example from ${file.name}.`);
  }catch(e){toast(`Could not import video: ${e.message}`);}
  finally{vid.pause();vid.removeAttribute('src');vid.load();URL.revokeObjectURL(url);importing=false;render();}
}
async function importAudio(ev){
  const file=ev.target.files?.[0];ev.target.value='';if(!file)return;
  const cue=selected().cues.find(c=>c.id===selectedCue&&c.mode==='sound');if(!cue||importing||capture)return;
  if(file.size>25e6){toast('Audio file too large; use a clip under 25 MB.');return;}
  importing=true;render();let ctx;
  try{
    ctx=new (window.AudioContext||window.webkitAudioContext)();
    const decoded=await ctx.decodeAudioData(await file.arrayBuffer());
    if(decoded.duration>25)throw Error('Use a recording shorter than 25 seconds.');
    let pcm=decoded.getChannelData(0);
    if(decoded.numberOfChannels>1){
      const channels=Array.from({length:decoded.numberOfChannels},(_,i)=>decoded.getChannelData(i));
      pcm=Float32Array.from(pcm,(_,i)=>channels.reduce((sum,c)=>sum+c[i],0)/channels.length);
    }
    const frames=soundFramesFromPcm(pcm,decoded.sampleRate,12);
    const sig=makeSoundSignature(frames);
    if(!sig)throw Error('No usable sound was detected in the recording.');
    saveExample(cue.id,'sound',sig);toast(`Imported one sound example from ${file.name}.`);
  }catch(e){toast(`Audio import failed: ${e.message}`);}
  finally{await ctx?.close().catch(()=>{});importing=false;render();}
}
function suggest(result,source){if(candidate)return;candidate={...result,source,profileId:activeId,at:Date.now()};$('candidateText').textContent=result.phrase;$('candidateMode').textContent=`POSSIBLE ${result.modality.toUpperCase()}`;$('candidateNote').textContent=`Learned signal detected through ${source}. A person should verify the meaning.`;$('approveButton').disabled=false;$('dismissButton').disabled=false;}
function clearCandidate(){candidate=null;$('candidateText').innerHTML='Listening for<br>a signal<span>.</span>';$('candidateMode').textContent='AWAITING INPUT';$('candidateNote').textContent="KIN won't guess an unknown sound or movement.";$('approveButton').disabled=true;$('dismissButton').disabled=true;}
function acknowledge(approved){if(!candidate)return;events.unshift({date:new Date().toISOString(),person:selected().name,phrase:candidate.phrase,source:candidate.source,outcome:approved?'Confirmed':'Dismissed'});events=events.slice(0,200);renderHistory();
  if(approved&&$('speechSetting').checked&&'speechSynthesis' in window){pausedAudioUntil=Date.now()+6000;try{speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(candidate.phrase);u.lang='en-AU';u.rate=.94;speechSynthesis.speak(u);}catch{}}
  toast(approved?`Confirmed: ${candidate.phrase}`:'Suggestion dismissed');clearCandidate();}
function renderHistory(){$('historyItems').innerHTML=events.length?events.map(e=>`<div class="history-event"><div><strong>${esc(e.phrase)}</strong><small>${esc(e.outcome)} · ${esc(e.source)}</small></div><small>${new Date(e.date).toLocaleTimeString('en-AU')}</small></div>`).join(''):'<p>No communication events in this session.</p>';}
function exportHistory(){const lines=[['Time','Person','Message','Source','Outcome'],...events.map(e=>[e.date,e.person,e.phrase,e.source,e.outcome])].map(row=>row.map(s=>'"'+String(s).replace(/"/g,'""')+'"').join(',')).join('\n');download('KIN-session.csv',lines,'text/csv');}
function wire(){
  document.querySelectorAll('.tab').forEach(n=>n.addEventListener('click',()=>showTab(n.dataset.tab)));
  document.querySelectorAll('[data-go]').forEach(n=>n.addEventListener('click',()=>showTab(n.dataset.go)));
  $('profileSelect').addEventListener('change',async e=>{if(capture){toast('Finish training before changing profile.');render();return;}activeId=e.target.value;selectedCue=null;clearCandidate();visualWindow=[];sceneWindow=[];activeSound=[];save();if(cameraStream&&selected().cues.some(c=>c.mode==='scene'))ensureScene().catch(e=>toast(e.message));});
  for(const [id,which] of [['newProfile','new'],['renameProfile','rename'],['deleteProfile','delete']])$(id).addEventListener('click',()=>editProfile(which));
  $('cueForm').addEventListener('submit',addCue);
  $('vocabulary').addEventListener('click',e=>{const n=e.target.closest('button');if(!n)return;if(n.dataset.select)selectCue(n.dataset.select);else if(n.dataset.delete)alterCue(n.dataset.delete,'delete');else if(n.dataset.undo)alterCue(n.dataset.undo,'undo');});
  $('exportProfile').addEventListener('click',exportProfile);$('importProfile').addEventListener('change',importProfile);
  $('cameraButton').addEventListener('click',toggleCamera);$('liveCamera').addEventListener('click',toggleCamera);
  $('micButton').addEventListener('click',toggleMic);$('liveMic').addEventListener('click',toggleMic);
  $('captureButton').addEventListener('click',recordExample);$('cancelCapture').addEventListener('click',cancelCapture);$('videoFile').addEventListener('change',importVideo);$('audioFile').addEventListener('change',importAudio);
  $('approveButton').addEventListener('click',()=>acknowledge(true));$('dismissButton').addEventListener('click',()=>acknowledge(false));
  $('exportHistory').addEventListener('click',exportHistory);$('clearHistory').addEventListener('click',()=>{events=[];renderHistory();});
  $('sensitivity').addEventListener('input',e=>$('sensitivityValue').textContent=`${e.target.value} / 1000`);
  document.addEventListener('visibilitychange',()=>{if(document.hidden){if(capture)cancelCapture();stopCamera();stopMic();}});
  window.addEventListener('beforeunload',()=>{cameraStream?.getTracks().forEach(t=>t.stop());micStream?.getTracks().forEach(t=>t.stop());});
}
wire();render();showTab(['home','train','live','log'].includes(location.hash.slice(1))?location.hash.slice(1):'home');renderHistory();
