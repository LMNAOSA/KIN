import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CUES, getCue, heuristicScores, featureVector, classify, HoldDetector, vectorDistance } from '../recognition.js';

function specimen(x, y, tipX=x, tipY=y) {
  return { palm:{x,y}, tips:{x:tipX,y:tipY}, wrist:{x,y:y+.2}, spread:.6, spanX:.4, spanY:.5,
    anchor:{ mouth:{x:0,y:.62},chin:{x:0,y:1}, eyes:{x:0,y:.39}, leftEar:{x:-.5,y:.4},rightEar:{x:.5,y:.4} } };
}
for (const [id, pose] of [
  ['no',specimen(0,.64,0,.62)],
  ['yes',specimen(0,.90,0,1.05)],
  ['away',specimen(0,.35,0,.25)],
  ['repeat',specimen(.52,.37,.56,.37)]
]) {
  test(`Starter rules detect synthetic ${id} pose`, () => {
    const prediction = classify(pose, {});
    assert.equal(prediction.best.cue.id, id, JSON.stringify(prediction.alternatives.map(a=>[a.cue.id,a.score])));
  });
}
test('All four messages are included in the vocabulary',()=>assert.deepEqual(CUES.map(c=>c.id), ['no','yes','away','repeat']));
test('Unknown cues return null',()=>assert.equal(getCue('bogus'),null));
test('Vector distance is zero for same sample',()=>assert.equal(vectorDistance(featureVector(specimen(0,.5)),featureVector(specimen(0,.5))),0));
test('Personal sample helps matched input',()=>{
 const yes = specimen(0,.9);
 const samples = { yes:[featureVector(yes),featureVector(yes)] };
 const result = classify(yes,samples);
 assert.equal(result.best.cue.id,'yes');
 assert.equal(result.source,'personalised');
});
test('Hold detector fires once after continuous confirmed gesture',()=>{
 const detector = new HoldDetector();
 const result={best:{cue:getCue('yes'),score:.9},second:{cue:getCue('no'),score:.3}};
 assert.equal(detector.update(result,1000,{holdMs:700}).fired,null);
 assert.equal(detector.update(result,1500,{holdMs:700}).fired,null);
 assert.equal(detector.update(result,1750,{holdMs:700}).fired?.id,'yes');
 assert.equal(detector.update(result,2600,{holdMs:700}).fired,null);
 detector.update(null,3200,{holdMs:700});
 detector.update(null,3700,{holdMs:700});
 assert.equal(detector.update(result,3800,{holdMs:700}).fired,null);
 assert.equal(detector.update(result,4600,{holdMs:700}).fired?.id,'yes');
});
