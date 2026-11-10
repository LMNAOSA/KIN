import test from 'node:test';import assert from 'node:assert/strict';
import {makeSoundSignature,spectrumDb,soundFramesFromPcm} from '../sound-utils.js';
import {VOICE_FEATURES,VOICE_SIGNATURE_LENGTH} from '../voice-recognition.js';
const frame=(rms)=>({rms,centroid:.3,spectral:Array(VOICE_FEATURES).fill(.12)});
test('sound templates trim surrounding silence',()=>{const a=makeSoundSignature([...Array(25).fill(frame(.001)),...Array(5).fill(frame(.08)),...Array(25).fill(frame(.001))]);assert.equal(a.length,VOICE_SIGNATURE_LENGTH);assert.ok(a[48]<.6);});
test('isolated transient still forms a tentative signature',()=>{const a=makeSoundSignature([...Array(10).fill(frame(.001)),frame(.11),...Array(10).fill(frame(.001))]);assert.equal(a.length,VOICE_SIGNATURE_LENGTH);});
test('silent sound abstains',()=>{assert.equal(makeSoundSignature(Array(15).fill(frame(.0004))),null);});
test('offline FFT provides 1024 finite frequency bins',()=>{const x=Float32Array.from({length:2048},(_,i)=>Math.sin(2*Math.PI*100*i/2048));const a=spectrumDb(x);assert.equal(a.length,1024);assert.ok(a.every(Number.isFinite));});
test('PCM analysis produces sound frames',()=>{const samples=Float32Array.from({length:24000},(_,i)=>.1*Math.sin(2*Math.PI*250*i/48000));const frames=soundFramesFromPcm(samples,48000);assert.ok(frames.length>4);assert.equal(frames[0].spectral.length,16);});
