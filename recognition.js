/**
 * KIN: transparent, personalisable prototype classifier.
 * Positions are normalised to the face, not the screen, so the camera
 * can move while the four anatomical regions remain meaningful.
 *
 * IMPORTANT: This is not a medically validated AAC classifier.
 */

export const CUES = Object.freeze([
  { id: 'no', label: 'NO', full: 'No', speech: 'No.', detail: 'Fingers resting over the mouth', anchor: 'mouth', symbol: '×', accent: '#ffac8d' },
  { id: 'yes', label: 'YES', full: 'Yes', speech: 'Yes.', detail: 'Hand resting beneath the chin', anchor: 'chin', symbol: '✓', accent: '#c9fa7b' },
  { id: 'away', label: 'GO AWAY', full: 'Go away / Not interested', speech: "Go away. I'm not interested.", detail: 'Hand covering the eyes or upper face', anchor: 'eyes', symbol: '↗', accent: '#c7bbff' },
  { id: 'repeat', label: 'REPEAT', full: 'Repeat / One more time', speech: 'Please repeat that.', detail: 'Hand moving towards the ear', anchor: 'ear', symbol: '↺', accent: '#8fddff' }
]);

export function getCue(id) { return CUES.find(c => c.id === id) || null; }
const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v));
const mean = xs => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const centre = points => ({ x: mean(points.map(p => p.x)), y: mean(points.map(p => p.y)) });

export function extractFeatures(faceLandmarks, handsLandmarks) {
  if (!Array.isArray(faceLandmarks) || faceLandmarks.length < 455 || !Array.isArray(handsLandmarks) || handsLandmarks.length === 0) return null;
  const face = faceLandmarks;
  const top = face[10];
  const bottom = face[152];
  const left = face[234];
  const right = face[454];
  const minX = Math.min(left.x, right.x);
  const maxX = Math.max(left.x, right.x);
  const minY = Math.min(top.y, bottom.y);
  const maxY = Math.max(top.y, bottom.y);
  const width = Math.max(0.09, maxX - minX);
  const height = Math.max(0.13, maxY - minY);
  const midX = (minX + maxX) / 2;
  const norm = p => ({ x: (p.x - midX) / width, y: (p.y - minY) / height });
  const anchor = {
    mouth: norm(centre([face[13], face[14]])),
    chin: norm(face[152]),
    eyes: norm(centre([face[33], face[263], face[159], face[386]])),
    leftEar: norm(face[234]),
    rightEar: norm(face[454])
  };
  let best = null;
  for (const hand of handsLandmarks) {
    if (!Array.isArray(hand) || hand.length < 21) continue;
    const palm = norm(centre([hand[0], hand[5], hand[9], hand[13], hand[17]]));
    const tips = norm(centre([hand[8], hand[12], hand[16], hand[20]]));
    const wrist = norm(hand[0]);
    const xs = hand.map(h => (h.x - midX) / width);
    const ys = hand.map(h => (h.y - minY) / height);
    const tipSpread = mean([8, 12, 16, 20].map(i => distance(hand[i], hand[0]))) /
      Math.max(0.001, mean([5, 9, 13, 17].map(i => distance(hand[i], hand[0]))));
    const candidate = {
      palm, tips, wrist,
      spread: clamp((tipSpread - 1.25) / 1.25),
      spanX: clamp((Math.max(...xs) - Math.min(...xs)) / 1.4),
      spanY: clamp((Math.max(...ys) - Math.min(...ys)) / 1.4),
      anchor,
      rawHand: hand,
      faceWidth: width,
      faceHeight: height
    };
    // Prefer hands nearest the face. Ignore unrelated/background hands.
    const faceDistance = Math.hypot(Math.max(0, Math.abs(palm.x) - 0.78), Math.max(0, palm.y - 1.23, -0.28 - palm.y));
    if (!best || faceDistance < best.faceDistance) best = { ...candidate, faceDistance };
  }
  if (!best || best.faceDistance > 0.26) return null;
  return best;
}

function gaussian(dx, dy, sx, sy) {
  return Math.exp(-0.5 * ((dx / sx) ** 2 + (dy / sy) ** 2));
}

/** Geometry rules directly encode the 4 confirmed human labels.
 *  They are useful as a starting point, but are not trained video templates. */
export function heuristicScores(features) {
  if (!features) return CUES.map(c => ({ cue: c, score: 0 }));
  const { palm, tips, anchor, spread } = features;
  const eyeY = anchor.eyes.y;
  const mouthY = anchor.mouth.y;
  const chinY = anchor.chin.y;
  const mouth = Math.max(
    gaussian(tips.x - anchor.mouth.x, tips.y - mouthY, .37, .20),
    gaussian(palm.x - anchor.mouth.x, palm.y - mouthY, .37, .21) * .89
  );
  const chin = gaussian(palm.x - anchor.chin.x, palm.y - (chinY - .12), .46, .27);
  const eyes = Math.max(
    gaussian(palm.x - anchor.eyes.x, palm.y - eyeY, .43, .24),
    gaussian(tips.x - anchor.eyes.x, tips.y - eyeY, .44, .27) * .93
  );
  const earX = (Math.abs(anchor.leftEar.x) + Math.abs(anchor.rightEar.x)) / 2;
  const ear = Math.max(
    gaussian(Math.abs(palm.x) - earX, palm.y - (eyeY + .02), .29, .31),
    gaussian(Math.abs(tips.x) - earX, tips.y - (eyeY + .02), .35, .36) * .88
  );
  // Subtle hand openness hints; geometry must dominate.
  const scores = { no: mouth * (.88 + .12 * spread), yes: chin * (1.03 - .09 * spread), away: eyes * (.89 + .11 * spread), repeat: ear };
  return CUES.map(c => ({ cue: c, score: clamp(scores[c.id] || 0) }));
}

export function featureVector(features) {
  if (!features) return null;
  const { palm, tips, wrist, spread, spanX, spanY } = features;
  return [palm.x, palm.y, tips.x, tips.y, wrist.x, wrist.y, spread, spanX, spanY];
}

export function vectorDistance(a, b) {
  const weights = [1.7, 1.8, 1, 1, .40, .40, .30, .18, .18];
  return Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2 * weights[i], 0));
}

export function classify(features, templates = {}) {
  if (!features) return { best: null, second: null, alternatives: [], source: 'none' };
  const ruleScores = heuristicScores(features);
  const vector = featureVector(features);
  const learned = CUES.map(c => {
    const samples = (templates[c.id] || []).filter(s => Array.isArray(s) && s.length === vector.length);
    if (!samples.length) return null;
    const nearest = samples.map(s => vectorDistance(s, vector)).sort((a, b) => a - b).slice(0, 3);
    const avgDist = mean(nearest);
    return { cue: c, score: Math.exp(-1.9 * avgDist), samples: samples.length };
  });
  const anyLearned = learned.some(Boolean);
  const alternatives = ruleScores.map((rule, i) => {
    const training = learned[i];
    return {
      cue: rule.cue,
      score: training ? (0.83 * training.score + 0.17 * rule.score) : (anyLearned ? rule.score * .78 : rule.score),
      trained: Boolean(training)
    };
  }).sort((a, b) => b.score - a.score);
  return { best: alternatives[0], second: alternatives[1], alternatives, source: alternatives[0]?.trained ? 'personalised' : 'starter rules' };
}

export class HoldDetector {
  constructor() { this.reset(); }
  reset() {
    this.current = null;
    this.since = 0;
    this.armed = true;
    this.lastFired = 0;
    this.lastSeen = 0;
  }
  update(result, now, { holdMs = 1100, threshold = .70, margin = .06 } = {}) {
    const best = result?.best;
    const second = result?.second;
    const accepted = best && best.score >= threshold && best.score - (second?.score || 0) >= margin;
    if (!accepted) {
      if (now - this.lastSeen > 420) { this.current = null; this.since = 0; this.armed = true; }
      return { candidate: null, progress: 0, fired: null };
    }
    this.lastSeen = now;
    if (this.current !== best.cue.id) {
      this.current = best.cue.id;
      this.since = now;
    }
    const progress = clamp((now - this.since) / holdMs);
    if (progress >= 1 && this.armed && (this.lastFired === 0 || now - this.lastFired > 1800)) {
      this.armed = false;
      this.lastFired = now;
      return { candidate: best.cue, progress, fired: best.cue, score: best.score };
    }
    return { candidate: best.cue, progress, fired: null, score: best.score };
  }
}
