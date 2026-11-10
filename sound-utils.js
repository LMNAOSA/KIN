import {frameFeatures,makeSignature} from './voice-recognition.js';
/** Keep the active event, not the silence before or after it. Supports brief transients. */
export function makeSoundSignature(frames){
  if(!Array.isArray(frames)||!frames.length)return null;
  const peak=Math.max(...frames.map(f=>f?.rms||0));
  if(peak<.006)return null;
  const cutoff=Math.max(.005,peak*.17);
  const indices=frames.flatMap((f,i)=>f?.rms>=cutoff?[i]:[]);
  if(!indices.length)return null;
  const start=Math.max(0,indices[0]-2),end=Math.min(frames.length,indices.at(-1)+3);
  return makeSignature(frames.slice(start,end),1);
}
/** Simple radix-2 real FFT used solely to extract features from imported audio. */
export function spectrumDb(samples){
  const n=samples.length;if(n<2||(n&(n-1)))throw Error('FFT length must be power of two.');
  const re=Float64Array.from(samples,(x,i)=>x*(.5-.5*Math.cos(2*Math.PI*i/(n-1))));
  const im=new Float64Array(n);
  for(let i=1,j=0;i<n;i++){
    let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;
    if(i<j){const tmp=re[i];re[i]=re[j];re[j]=tmp;}
  }
  for(let len=2;len<=n;len<<=1){const ang=-2*Math.PI/len,wr0=Math.cos(ang),wi0=Math.sin(ang);
    for(let i=0;i<n;i+=len){let wr=1,wi=0;
      for(let j=0;j<len/2;j++){
        const x=i+j,y=x+len/2,tr=wr*re[y]-wi*im[y],ti=wr*im[y]+wi*re[y];
        re[y]=re[x]-tr;im[y]=im[x]-ti;re[x]+=tr;im[x]+=ti;
        const nr=wr*wr0-wi*wi0;wi=wr*wi0+wi*wr0;wr=nr;
      }
    }
  }
  const output=new Float32Array(n/2);
  for(let i=0;i<output.length;i++)output[i]=Math.max(-120,Math.min(0,20*Math.log10(Math.hypot(re[i],im[i])/(n/4)+1e-9)));
  return output;
}
export function soundFramesFromPcm(pcm,rate,limit=12){
  const size=2048,step=Math.max(1,Math.round(rate*.05)),frames=[];
  const end=Math.min(pcm.length,Math.floor(rate*limit));
  for(let offset=0;offset+size<end;offset+=step){
    const wave=Float32Array.from(pcm.subarray(offset,offset+size));
    frames.push(frameFeatures(wave,spectrumDb(wave),rate));
  }
  return frames;
}
