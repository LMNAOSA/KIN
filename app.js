import { CUES, getCue, extractFeatures, featureVector, classify, HoldDetector } from './recognition.js';

const $ = id => document.getElementById(id);
const SDK_VERSION = '1.2.2';
const SDK_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${SDK_VERSION}/vision_bundle.mjs`;
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${SDK_VERSION}/wasm`;
const MODEL_FACE = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const MODEL_HAND = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const STORAGE_KEY = 'kin.persona.v1';
const holdDetector = new HoldDetector();
const camera = $('camera');
const importVideo = $('importVideo');
const overlay = $('overlay');
const overlayCtx = overlay.getContext('2d');
let templates = readTemplates();
let messages = [];
let modelsPromise = null;
let faceModel = null;
let handModel = null;
let cameraStream = null;
let facingMode = 'user';
let isImporting = false;
let isStarting = false;
let lastFrameAt = 0;
let lastTs = 0;
let animationId = 0;
let training = null;
let toastHandle = 0;

function readTemplates() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return sanitiseTemplates(parsed);
  } catch { return {}; }
}
function sanitiseTemplates(obj) {
  const result = {};
  for (const cue of CUES) {
    result[cue.id] = (Array.isArray(obj?.[cue.id]) ? obj[cue.id] : [])
      .filter(v => Array.isArray(v) && v.length === 9 && v.every(n => Number.isFinite(n) && Math.abs(n) < 15))
      .slice(-96);
  }
  return result;
}
function saveTemplates() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(templates)); }
  catch { toast('Browser storage is unavailable. Export your profile to keep it.'); }
  renderTraining(); updateModeIndicator();
}
function addTemplates(cueId, features) {
  const valid = features.map(featureVector).filter(Boolean);
  if (valid.length === 0) return 0;
  templates[cueId] = [...(templates[cueId] || []), ...valid].slice(-96);
  saveTemplates();
  return valid.length;
}
function updateModeIndicator() {
  const trainedCues = CUES.filter(c => templates[c.id]?.length).length;
  $('modeIndicator').textContent = trainedCues ? `PERSONALISED ${trainedCues}/4` : 'STARTER RULES';
  $('teachStatus').innerHTML = `<span class="status-led"></span> ${trainedCues ? `${trainedCues} of 4 cues have personalised reference data. Add more clips and test with non-gestures.` : 'Starter location-based rules are ready. Add personalised examples to improve recognition.'}`;
}
function toast(message) {
  const el = $('toast');
  el.textContent = message; el.classList.add('is-visible');
  clearTimeout(toastHandle);
  toastHandle = setTimeout(() => el.classList.remove('is-visible'), 3400);
}
function showTab(tab) {
  for (const nav of document.querySelectorAll('.nav-link')) {
    const current = nav.dataset.tab === tab;
    nav.classList.toggle('is-active', current);
    if (current) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
  }
  for (const panel of document.querySelectorAll('.tab-panel')) panel.hidden = panel.dataset.panel !== tab;
  try { history.replaceState(null, '', `#${tab}`); } catch { /* location may be locked */ }
}
function renderCues() {
  $('liveCueGrid').innerHTML = CUES.map(c => `<button class="cue-btn" data-preview="${c.id}" style="--cue-accent:${c.accent}" aria-label="Preview ${c.full}"><span class="cue-icon">${c.symbol}</span><span class="cue-text"><strong>${c.label}</strong><span>${c.full}</span></span></button>`).join('');
  document.querySelectorAll('[data-preview]').forEach(button => button.addEventListener('click', () => {
    const cue = getCue(button.dataset.preview);
    if (cue) confirmMessage(cue, 'Preview (manual)', null);
  }));
}
function renderTraining() {
  $('trainingGrid').innerHTML = CUES.map((cue, index) => {
    const count = (templates[cue.id] || []).length;
    return `<article class="training-card" style="--cue-accent:${cue.accent}">
      <div class="training-card-top"><div class="training-symbol" style="background:${cue.accent}">${cue.symbol}</div><div><div class="small-label">CUE 0${index + 1}</div><h3>${cue.label}</h3><p class="cue-description">${cue.detail}</p></div></div>
      <div class="training-meta"><span>${count ? 'SAVED FEATURE SAMPLES' : 'LOCATION-BASED STARTER RULE'}</span><strong>${count ? `${count} SAMPLES` : 'NOT TRAINED'}</strong></div>
      <div class="training-card-actions"><button class="btn primary" data-teach="${cue.id}">◉ TEACH WITH CAMERA</button><label class="btn ghost upload-label">↑ VIDEO FILE<input type="file" data-upload="${cue.id}" accept="video/*,.mp4,.mov,.webm" hidden /></label></div>
    </article>`;
  }).join('');
  document.querySelectorAll('[data-teach]').forEach(button => button.addEventListener('click', () => startTraining(button.dataset.teach)));
  document.querySelectorAll('[data-upload]').forEach(input => input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file) await processVideoFile(input.dataset.upload, file);
    input.value = '';
  }));
}
function renderHistory() {
  if (!messages.length) {
    $('historyList').innerHTML = '<div class="empty-history">No messages yet. Start the camera, or preview a cue in Live.</div>';
    return;
  }
  $('historyList').innerHTML = messages.map(m => {
    const c = getCue(m.id);
    const date = new Date(m.time).toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const confidence = m.score == null ? '' : ` · match ${Math.round(m.score * 100)}% (experimental)`;
    return `<div class="history-item" style="--cue-accent:${c.accent}"><div class="history-glyph">${c.symbol}</div><div class="history-copy"><strong>${c.full}</strong><span>${m.source}${confidence}</span></div><div class="history-time">${date}</div></div>`;
  }).join('');
}
function confirmMessage(cue, source, score) {
  const output = $('bigTranslation');
  output.classList.add('is-message');
  output.textContent = cue.full;
  output.style.color = cue.accent;
  $('outputEyebrow').textContent = source.startsWith('Preview') ? 'MANUAL PREVIEW — NOT CAMERA DETECTION' : 'CONFIRMED GESTURE';
  $('confidenceText').textContent = `${source} · message delivered to partner`;
  $('confidenceNum').textContent = score == null ? 'MANUAL' : `${Math.round(score * 100)}% match`;
  $('confidenceBar').style.width = '100%';
  messages.unshift({ id:cue.id, source, score, time:Date.now() });
  messages = messages.slice(0, 250);
  renderHistory();
  if ($('voiceToggle').checked && 'speechSynthesis' in window) {
    try {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(cue.speech);
      utterance.lang = 'en-AU'; utterance.rate = .92;
      speechSynthesis.speak(utterance);
    } catch { /* Some browsers restrict programmatic speech. */ }
  }
}
async function ensureModels() {
  if (modelsPromise) return modelsPromise;
  modelsPromise = (async () => {
    const { FilesetResolver, FaceLandmarker, HandLandmarker } = await import(SDK_URL);
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    // CPU is slower but more predictable on iOS Safari and older computers.
    faceModel = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_FACE, delegate: 'CPU' }, runningMode: 'VIDEO', numFaces: 1,
      outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false
    });
    handModel = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_HAND, delegate: 'CPU' }, runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: .52, minHandPresenceConfidence: .5, minTrackingConfidence: .5
    });
    return true;
  })();
  try { return await modelsPromise; }
  catch (err) { modelsPromise = null; faceModel = null; handModel = null; throw err; }
}
function timestamp() { lastTs = Math.max(performance.now(), lastTs + 1); return lastTs; }
function detectMediaFrame(media) {
  if (!faceModel || !handModel) return null;
  const ts = timestamp();
  const faces = faceModel.detectForVideo(media, ts).faceLandmarks;
  const hands = handModel.detectForVideo(media, ts + .001).landmarks;
  const features = extractFeatures(faces?.[0], hands);
  return { faces:faces?.[0], hands, features };
}
function drawTracking(detection) {
  const stage = $('cameraStage');
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const ratio = window.devicePixelRatio || 1;
  overlay.width = Math.round(w * ratio); overlay.height = Math.round(h * ratio);
  overlayCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
  overlayCtx.clearRect(0, 0, w, h);
  if (!detection?.features || !camera.videoWidth) return;
  const scale = Math.max(w / camera.videoWidth, h / camera.videoHeight);
  const offsetX = (w - camera.videoWidth * scale) / 2;
  const offsetY = (h - camera.videoHeight * scale) / 2;
  const map = p => ({ x:p.x * camera.videoWidth * scale + offsetX, y:p.y * camera.videoHeight * scale + offsetY });
  const hand = detection.features.rawHand;
  const chains = [[0,1,2,3,4],[0,5,6,7,8],[5,9,10,11,12],[9,13,14,15,16],[13,17,18,19,20],[0,17]];
  overlayCtx.lineWidth = 2.2; overlayCtx.strokeStyle = '#c9fa7b';
  for (const chain of chains) {
    overlayCtx.beginPath();
    chain.forEach((idx, i) => { const p = map(hand[idx]); if (i === 0) overlayCtx.moveTo(p.x,p.y); else overlayCtx.lineTo(p.x,p.y); });
    overlayCtx.stroke();
  }
  overlayCtx.fillStyle = '#e9ffc8';
  for (const p of hand) { const q = map(p); overlayCtx.beginPath(); overlayCtx.arc(q.x,q.y,2.4,0,Math.PI * 2); overlayCtx.fill(); }
  const face = detection.faces;
  if (face) for (const i of [10, 13, 14, 152, 234, 454, 33, 263]) {
    const q = map(face[i]); overlayCtx.beginPath(); overlayCtx.arc(q.x,q.y,3.1,0,Math.PI * 2); overlayCtx.fill();
  }
}
function setTrackingText(text) { $('trackStatus').textContent = text; }
function liveLoop(now) {
  if (!cameraStream) return;
  animationId = requestAnimationFrame(liveLoop);
  if (isImporting || camera.readyState < 2 || now - lastFrameAt < 95) return;
  lastFrameAt = now;
  let detected;
  try { detected = detectMediaFrame(camera); }
  catch (err) { setTrackingText('TRACKING ERROR'); console.warn('KIN inference failed', err); return; }
  drawTracking(detected);
  if (training) {
    if (now < training.prepareUntil) {
      $('trainingCountdown').textContent = String(Math.max(1, Math.ceil((training.prepareUntil - now) / 1000)));
      $('trainingProgress').style.width = '0%';
      return;
    }
    if (!training.started) { training.started = now; training.ends = now + 3000; }
    const remaining = Math.max(0, training.ends - now);
    $('trainingCountdown').textContent = (remaining / 1000).toFixed(1);
    $('trainingProgress').style.width = `${100 * (1 - remaining / 3000)}%`;
    if (detected?.features && now - training.lastSample > 160) {
      training.samples.push(detected.features); training.lastSample = now;
    }
    if (now >= training.ends) finishTraining();
    return;
  }
  if (!detected?.features) {
    setTrackingText(detected?.faces ? 'PLACE HAND NEAR FACE' : 'LOOKING FOR FACE');
    holdDetector.update(null, now);
    $('confidenceText').textContent = 'Show a hand gesture near the face';
    $('confidenceNum').textContent = '—';
    $('confidenceBar').style.width = '0%';
    return;
  }
  setTrackingText('FACE + HAND TRACKED');
  const result = classify(detected.features, templates);
  const hold = holdDetector.update(result, now, {
    holdMs: Number($('holdRange').value), threshold: .68, margin: .07
  });
  if (hold.fired) {
    confirmMessage(hold.fired, `Camera (${result.source})`, result.best.score);
  } else if (hold.candidate) {
    $('confidenceText').textContent = `Possible ${hold.candidate.label} · keep holding`;
    $('confidenceNum').textContent = `${Math.round(result.best.score * 100)}% match`;
    $('confidenceBar').style.width = `${Math.round(hold.progress * 100)}%`;
  } else {
    $('confidenceText').textContent = 'Movement seen · no clear match';
    $('confidenceNum').textContent = '—';
    $('confidenceBar').style.width = '0%';
  }
}
async function startCamera() {
  if (isStarting) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Camera access requires HTTPS or localhost in a supported browser.'); return;
  }
  isStarting = true;
  $('cameraBtn').disabled = true; $('cameraBtn').textContent = '◌  LOADING VISION MODELS…';
  try {
    await ensureModels();
    const stream = await navigator.mediaDevices.getUserMedia({ audio:false, video:{ facingMode:{ ideal:facingMode }, width:{ ideal:1280 }, height:{ ideal:720 } } });
    cameraStream = stream;
    camera.srcObject = stream;
    await camera.play();
    $('cameraStage').classList.add('is-on');
    $('cameraStatus').classList.add('is-on');
    $('cameraStatus').innerHTML = '<span class="status-led"></span> LIVE TRACKING';
    $('cameraBtn').textContent = '■  STOP CAMERA';
    $('flipBtn').disabled = false;
    camera.classList.toggle('is-back-camera', facingMode === 'environment');
    overlay.classList.toggle('is-back-camera', facingMode === 'environment');
    setTrackingText('STARTING VISION');
    holdDetector.reset();
    cancelAnimationFrame(animationId);
    animationId = requestAnimationFrame(liveLoop);
    toast('Camera ready. Hold one of your four gestures in view.');
  } catch (err) {
    console.error('KIN camera/model setup error', err);
    cameraStream?.getTracks().forEach(t => t.stop()); cameraStream = null;
    $('cameraBtn').textContent = '↗  START CAMERA';
    $('flipBtn').disabled = true;
    const denial = err?.name === 'NotAllowedError';
    toast(denial ? 'Camera permission was denied. Allow camera access in browser settings.' : 'Could not start the camera/models. Check internet, HTTPS and browser support.');
  } finally { isStarting = false; $('cameraBtn').disabled = false; }
}
function stopCamera() {
  cancelAnimationFrame(animationId);
  if (training) cancelTraining();
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = null; camera.srcObject = null;
  overlayCtx.clearRect(0,0,overlay.width,overlay.height);
  $('cameraStage').classList.remove('is-on');
  $('cameraStatus').classList.remove('is-on');
  $('cameraStatus').innerHTML = '<span class="status-led"></span> CAMERA OFF';
  $('cameraBtn').textContent = '↗  START CAMERA'; $('flipBtn').disabled = true;
  $('trackStatus').textContent = 'AWAITING CAMERA';
  holdDetector.reset();
}
function startTraining(cueId) {
  if (training || isImporting) return;
  if (!cameraStream) { showTab('live'); toast('Start the camera first, then return to Teach.'); return; }
  const cue = getCue(cueId); if (!cue) return;
  const now = performance.now();
  training = { cueId, prepareUntil:now + 2000, started:null, ends:null, lastSample:0, samples:[] };
  $('trainingTitle').textContent = `Show: ${cue.full}`;
  $('trainingDetail').textContent = `${cue.detail}. Hold naturally for 3 seconds.`;
  $('trainingCountdown').textContent = '2';
  const preview = $('trainingPreview');
  preview.srcObject = cameraStream;
  preview.classList.toggle('is-back-camera', facingMode === 'environment');
  preview.play().catch(() => {});
  $('trainingProgress').style.width = '0%';
  $('trainingModal').classList.add('is-open');
  $('trainingModal').setAttribute('aria-hidden', 'false');
}
function cancelTraining() {
  $('trainingPreview').pause();
  $('trainingPreview').srcObject = null;
  training = null;
  $('trainingModal').classList.remove('is-open');
  $('trainingModal').setAttribute('aria-hidden', 'true');
}
function finishTraining() {
  const completed = training;
  cancelTraining();
  if (!completed || completed.samples.length < 5) {
    toast('Could not see a clear face and hand. Try again with better lighting.'); return;
  }
  const count = addTemplates(completed.cueId, completed.samples);
  toast(`Saved ${count} new landmark examples for ${getCue(completed.cueId).full}.`);
  holdDetector.reset();
}
async function awaitVideoEvent(video, name, ms = 10000) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Video ${name} timed out`)); }, ms);
    const ok = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('Could not decode video')); };
    const cleanup = () => { clearTimeout(timer); video.removeEventListener(name, ok); video.removeEventListener('error', fail); };
    video.addEventListener(name, ok, { once:true });
    video.addEventListener('error', fail, { once:true });
  });
}
async function moveVideoTo(video, seconds) {
  const requested = Math.max(0, Math.min(Math.max(0,video.duration - .05),seconds));
  if (Math.abs(video.currentTime - requested) <= .025 && video.readyState >= 2) return;
  const promise = awaitVideoEvent(video, 'seeked', 7000);
  video.currentTime = requested;
  await promise;
}
async function processVideoFile(cueId, file) {
  if (isImporting || training) { toast('Finish the current training operation first.'); return; }
  if (!file.type.startsWith('video/') && !/\.(mov|mp4|webm)$/i.test(file.name)) { toast('Please select a video clip.'); return; }
  if (file.size > 150 * 1024 * 1024) { toast('Please use a video under 150 MB.'); return; }
  isImporting = true;
  const cue = getCue(cueId);
  const url = URL.createObjectURL(file);
  $('teachStatus').textContent = `PROCESSING ${cue.label} — analysing video locally. The raw video will not be saved.`;
  try {
    await ensureModels();
    importVideo.src = url;
    importVideo.load();
    if (importVideo.readyState < 1) await awaitVideoEvent(importVideo,'loadedmetadata',12000);
    if (!Number.isFinite(importVideo.duration) || importVideo.duration <= .3) throw new Error('Video duration not available');
    const samples = [];
    for (let i=0; i<17; i++) {
      const portion = .15 + .70 * (i / 16);
      await moveVideoTo(importVideo, importVideo.duration * portion);
      const result = detectMediaFrame(importVideo);
      if (result?.features) samples.push(result.features);
      $('teachStatus').textContent = `PROCESSING ${cue.label} — ${i+1} / 17 frames checked, ${samples.length} usable.`;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    if (samples.length < 3) {
      toast('Not enough face-and-hand frames detected. Try a brighter, clearer clip.');
    } else {
      const count = addTemplates(cueId, samples);
      toast(`Learned ${count} gesture samples from your ${cue.label} video.`);
    }
  } catch (err) {
    console.warn('KIN video import failed', err);
    toast('Could not process the clip. MP4/H.264 in Safari or Chrome is recommended.');
  } finally {
    importVideo.pause();
    importVideo.removeAttribute('src'); importVideo.load();
    URL.revokeObjectURL(url);
    isImporting = false;
    updateModeIndicator();
    holdDetector.reset();
  }
}
function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportProfile() {
  const payload = { application:'KIN', version:1, exportedAt:new Date().toISOString(), features:'relative face/hand landmarks, no raw image data', templates };
  download('kin-personalised-gestures.json', JSON.stringify(payload,null,2), 'application/json');
  toast('Profile exported. Keep the file private.');
}
async function importProfile(file) {
  if (file.size > 300000) { toast('Profile file too large.'); return; }
  try {
    const raw = JSON.parse(await file.text());
    if (raw.application !== 'KIN' || raw.version !== 1 || !raw.templates || typeof raw.templates !== 'object') throw Error('Not a supported KIN profile');
    templates = sanitiseTemplates(raw.templates);
    saveTemplates(); toast('Personalised gesture profile imported.');
  } catch { toast('This is not a valid KIN profile.'); }
}
function exportHistory() {
  const encode = v => `"${String(v ?? '').replace(/"/g,'""')}"`;
  const rows = [['Time','Meaning','Source','Experimental match score'], ...[...messages].reverse().map(m=>[new Date(m.time).toISOString(),getCue(m.id)?.full,m.source,m.score == null ? '':(m.score*100).toFixed(0)])];
  download('kin-session.csv', rows.map(row=>row.map(encode).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  toast('Session exported as CSV.');
}
function wireEvents() {
  document.querySelectorAll('.nav-link').forEach(link=>link.addEventListener('click',()=>showTab(link.dataset.tab)));
  $('cameraBtn').addEventListener('click', () => cameraStream ? stopCamera() : startCamera());
  $('flipBtn').addEventListener('click', async () => {
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    stopCamera(); await startCamera();
  });
  $('holdRange').addEventListener('input', e=>$('holdLabel').textContent=`${(Number(e.target.value)/1000).toFixed(1)}s`);
  $('cancelTraining').addEventListener('click', cancelTraining);
  $('exportProfile').addEventListener('click',exportProfile);
  $('importProfile').addEventListener('change', async e=>{ if(e.target.files?.[0])await importProfile(e.target.files[0]);e.target.value=''; });
  $('resetTraining').addEventListener('click',()=>{if(confirm('Delete all saved KIN gesture samples from this browser?')){templates=sanitiseTemplates({});saveTemplates();toast('Personalised training cleared. Starter rules remain.');}});
  $('exportSession').addEventListener('click',exportHistory);
  $('clearSession').addEventListener('click',()=>{messages=[];renderHistory();toast('This session log has been cleared.');});
  window.addEventListener('beforeunload', () => cameraStream?.getTracks().forEach(t=>t.stop()));
  document.addEventListener('visibilitychange', () => { if(document.hidden && cameraStream && training) cancelTraining(); });
}
renderCues(); renderTraining(); renderHistory(); updateModeIndicator(); wireEvents();
const initialTab = location.hash.replace('#','');
if (['live','teach','history'].includes(initialTab)) showTab(initialTab);
