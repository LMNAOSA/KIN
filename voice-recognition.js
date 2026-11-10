/** KIN Voice Lab — experiment-only, person-specific acoustic template matching.
 *  Vectors deliberately contain no raw waveform; labels/recordings remain local.
 *  These scores are NOT probabilities, evidence of meaning, or clinical validation.
 */
export const VOICE_FEATURES = 16;
export const VOICE_SIGNATURE_LENGTH = VOICE_FEATURES * 3 + 5;

export function frameFeatures(timeData, freqDb, sampleRate) {
  const n = timeData.length;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += timeData[i] * timeData[i];
  const rms = Math.sqrt(energy / n);
  const nyquist = sampleRate / 2;
  const edges = Array.from({ length: VOICE_FEATURES + 1 }, (_, i) => 90 * Math.pow(Math.min(5600,nyquist*.92) / 90, i / VOICE_FEATURES));
  const powers = new Array(VOICE_FEATURES).fill(0);
  let total = 0, weighted = 0;
  for (let k = 1; k < freqDb.length; k++) {
    const hz = k * nyquist / freqDb.length;
    if (hz < edges[0] || hz >= edges[VOICE_FEATURES]) continue;
    const db = Number.isFinite(freqDb[k]) ? freqDb[k] : -120;
    const power = Math.pow(10, Math.max(-120, Math.min(0, db)) / 10);
    const index = Math.min(VOICE_FEATURES - 1, Math.floor(Math.log(hz/90) / Math.log(edges[VOICE_FEATURES]/90) * VOICE_FEATURES));
    powers[index] += power;
    total += power; weighted += power * hz;
  }
  // Log compression stabilises differences in recording level.
  const spectral = powers.map(p => Math.log1p(100 * (p / (total + 1e-16))) / Math.log(101));
  const centroid = total > 1e-13 ? Math.min(1, weighted / total / 5600) : 0;
  return { rms, spectral, centroid };
}

export function makeSignature(frames, minimum = 3) {
  const voiced = frames.filter(f => f && f.spectral?.length === VOICE_FEATURES && Number.isFinite(f.rms) && f.rms > 0.005);
  if (voiced.length < minimum) return null;
  // Three temporal sections distinguish similar grunts with different contours.
  const output = [];
  for (let part = 0; part < 3; part++) {
    let a = Math.floor(part * voiced.length / 3);
    let b = Math.max(a + 1, Math.floor((part+1) * voiced.length / 3));
    for (let band=0; band<VOICE_FEATURES; band++) {
      let sum=0;
      for(let j=a; j<b; j++) sum += voiced[j].spectral[band];
      output.push(sum/(b-a));
    }
  }
  const duration = (voiced.length * .05);
  const centroids = voiced.map(f => f.centroid);
  const rms = voiced.map(f => Math.min(1, f.rms));
  output.push(Math.min(1, duration/2.5));
  output.push(centroids.reduce((a,b)=>a+b,0)/centroids.length);
  output.push(centroids[centroids.length-1] - centroids[0]);
  output.push(Math.min(1, Math.log1p(rms.reduce((a,b)=>a+b,0)/rms.length*25)/4));
  output.push(Math.min(1, rms[rms.length-1]/(rms[0]+.0001)/4));
  return output.every(Number.isFinite) ? output : null;
}

export function validSignature(vec) {
  return Array.isArray(vec) && vec.length===VOICE_SIGNATURE_LENGTH && vec.every(v=>Number.isFinite(v)&&v>=-2&&v<=3);
}

export function signatureDistance(a,b) {
  if(!validSignature(a)||!validSignature(b))return Infinity;
  let sum=0;
  for(let i=0;i<VOICE_SIGNATURE_LENGTH;i++){
    const scale = i>=48 ? (i===48 ? 1.6 : .8) : 1;
    sum+=Math.pow((a[i]-b[i])*scale,2);
  }
  return Math.sqrt(sum/VOICE_SIGNATURE_LENGTH);
}

/** Abstains unless at least 2 classes contain >=3 independent examples each.
 *  Thresholds are intentionally provisional; must calibrate per person and recording environment.
 */
export function matchSignature(signature, vocabulary, options={}) {
  if (!validSignature(signature))return {status:'invalid'};
  const qualified = (vocabulary||[]).filter(v => v.examples?.filter(e=>validSignature(e.sig)).length>=3);
  if(qualified.length<2)return {status:'not-ready', detail:'Train at least two meanings with three separate examples each.'};
  const scores=qualified.map(v => {
    const distances = v.examples.filter(e=>validSignature(e.sig)).map(e=>signatureDistance(signature,e.sig)).sort((a,b)=>a-b);
    const closest=distances.slice(0, Math.min(3,distances.length));
    return {id:v.id,label:v.label,isNeutral:Boolean(v.isNeutral), distance:closest.reduce((a,b)=>a+b,0)/closest.length};
  }).sort((a,b)=>a.distance-b.distance);
  const best=scores[0], next=scores[1];
  const absolute=options.absolute ?? .15;
  const margin=options.margin ?? .027;
  if(best.distance>absolute || next.distance-best.distance<margin)return {status:'unknown',best:best.label, similarity:Math.max(0,1-best.distance/.4)};
  if(best.isNeutral)return {status:'ignored'};
  return {status:'match', id:best.id, label:best.label, similarity:Math.max(0,Math.min(1,1-best.distance/.4))};
}
