const fmtT = s => Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');

// ─── SHARED AUDIO STATE ───────────────────────────────────────────────────────
let audioCtx, analyser, gainNode, source, audioBuffer, micStream, sysStream;
let playing = false, animFrame = null;
let envelopeAmp = 0, currentFilter = 'all';
let currentMode = 'scrub', depthDir = 'reveal', depthLock = 'all';
const barIds = ['vb0','vb1','vb2','vb3','vb4','vb5','vb6','vb7','vb8','vb9','vba','vbb','vbc','vbd','vbe','vbf'];

// Beat tracker
let beatPhase=0, beatInterval=500, lastBeatTime=0, beatTimes=[], prevFluxVal=0;
let beatCount=0, rollingEnergy=0, rollingPeak=1, autoTuneTimer=0, btInitialized=false;

// Alive
let lfoPhase=0, lastVidTime=0, lastVidChangeAt=Date.now(), bounceDir=1, stuckNudgeDir=1;

// Flicker state
let flickerActive=false, flickerTimer=0, flickerDir=1, peakHeldFor=0;
const PEAK_THRESHOLD = 0.92;  // t value considered "at max"
const PEAK_HOLD_MS = 400;     // how long at max before flicker kicks in

// Channel switch state
let _chSwitchProgress = 0;    // 0=idle, 0→1=animating
let _chSwitchStart = 0;       // performance.now() when started
let _chSwitchDuration = 1000; // ms
let _chSwitchActive = false;
let _chSwitchClipPending = false; // delay clip swap to mid-static

// Scrub video
const vid = document.getElementById('vid');
let videoUnlocked = false;

// Clip pool
let clipPool = []; // [{name, file, url, cleaned, cleanedUrl}]
let activeClipIdx = -1;
let lastClipIdx = -1; // for no-repeat

// Depth videos — pair 1
const dBgVid = document.createElement('video');
const dOvVid = document.createElement('video');
const dDpVid = document.createElement('video');
// Depth videos — pair 2
const dOv2Vid = document.createElement('video');
const dDp2Vid = document.createElement('video');
[dBgVid,dOvVid,dDpVid,dOv2Vid,dDp2Vid].forEach(v=>{ v.muted=true; v.preload='auto'; v.playsInline=true; v.loop=true; });
let dBgReady=false, dOvReady=false, dDpReady=false, dOv2Ready=false, dDp2Ready=false, depthUnlocked=false;
let depthDir2 = 'reveal';

// Preloaded frame arrays (ImageBitmap[]) — null means not preloaded, use video fallback
const preloadedFrames = { bg:null, ov:null, dp:null, ov2:null, dp2:null };
const PRELOAD_FPS = 30;

// Timeline
let waveformData=null, tlZoom=1, tlOffset=0, tlDragging=null, tlAudioDuration=0;

// Bake
let mediaRecorder=null, recordedChunks=[], bakeAudioDest=null, bakeAnimFrame=null, bakeStartTime=null;
let dMediaRecorder=null, dRecordedChunks=[], dBakeAnimFrame=null, dBakeStartTime=null;

// Sidebar
let sidebarVisible=true, toastTimer=null, currentTab='scrub';

// ─── UTILS ───────────────────────────────────────────────────────────────────
function updateSlider(id,valId,fmt){ const v=parseFloat(document.getElementById(id).value); document.getElementById(valId).textContent=fmt?fmt(v):v; }
function setSlider(id,valId,val,fmt){ document.getElementById(id).value=val; document.getElementById(valId).textContent=fmt?fmt(val):val; }
function g(id){ return document.getElementById(id); }
function gv(id){ const el=g(id); return el ? parseFloat(el.value) : 0; }

// ─── TAB SWITCHING ────────────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  ['scrub','depth','layers'].forEach(t => {
    g('tab-'+t).classList.toggle('active', t===tab);
    g('ws-'+t).style.display = t===tab ? 'grid' : 'none';
  });
  // Reset CRT state when leaving scrub
  if (tab!=='scrub') {
    vid.style.visibility='visible'; vid.style.opacity='1';
    g('crtCanvas').style.display='none';
    window._ampSpikeHold=0; window._cbSpikeHold=0;
  }
  if (tab==='depth') drawDepthFrame();
  if (tab==='layers') lyDrawPreview();
}

// ─── SCRUB VIDEO ─────────────────────────────────────────────────────────────
function unlockVideo() {
  vid.muted = true; vid.volume = 0;
  vid.play().then(()=>{ vid.pause(); vid.currentTime=0; videoUnlocked=true; g('unlockOverlay').style.display='none'; }).catch(()=>{});
}
function loadVideo(input) {
  const f=input.files[0]; if(!f) return;
  vid.src=URL.createObjectURL(f); vid.muted=true; vid.load();
  vid.onloadedmetadata=()=>{ g('unlockOverlay').style.display='flex'; videoUnlocked=false; };
  g('vidBtn').textContent=f.name.replace(/\.[^.]+$/,''); g('vidBtn').classList.add('loaded');
  input.value='';
}

// ─── DEPTH VIDEOS ────────────────────────────────────────────────────────────
// Preload key maps type → preloadedFrames key
const preloadKey = {bg:'bg', overlay:'ov', depth:'dp', overlay2:'ov2', depth2:'dp2'};

function loadDepthVid(type, input) {
  console.log('[depth] loadDepthVid called:', type, input.files);
  const f=input.files[0]; if(!f) { console.warn('[depth] no file selected for', type); return; }
  const url=URL.createObjectURL(f);
  const map={
    bg:[dBgVid,'dBgBtn','dBgStatus',()=>{dBgReady=true;updateDepthStatus();}],
    overlay:[dOvVid,'dOverlayBtn','dOverlayStatus',()=>{dOvReady=true;updateDepthStatus();}],
    depth:[dDpVid,'dDepthBtn','dDepthStatus',()=>{dDpReady=true;updateDepthStatus();}],
    overlay2:[dOv2Vid,'dOverlay2Btn','dOverlay2Status',()=>{dOv2Ready=true;updateDepthStatus();}],
    depth2:[dDp2Vid,'dDepth2Btn','dDepth2Status',()=>{dDp2Ready=true;updateDepthStatus();}],
  };
  if(!map[type]) { console.error('[depth] unknown type:', type); return; }
  const [v,btn,status,cb]=map[type];
  console.log('[depth] mapping:', type, '→ btn:', btn, 'status:', status);
  // Clear old preloaded frames for this slot
  const pk=preloadKey[type];
  if(preloadedFrames[pk]){ preloadedFrames[pk].forEach(b=>b.close()); preloadedFrames[pk]=null; }
  v.src=url; v.load();
  v.onloadedmetadata=()=>{
    console.log(`[depth] loaded ${type}: ${f.name} (${v.videoWidth}x${v.videoHeight}, ${fmtT(v.duration)})`);
    cb();
    g(btn).textContent=f.name.replace(/\.[^.]+$/,'');
    g(btn).classList.add('loaded');
    g(status).textContent='extracting...';
    console.log(`[depth] extracting frames for ${type} (key: ${pk})...`);
    extractFrames(v, pk).then(count=>{
      console.log(`[depth] extracted ${count} frames for ${type}`);
      g(status).textContent=fmtT(v.duration)+' · '+count+'f';
    }).catch(err=>{
      console.warn(`[depth] frame extraction failed for ${type}:`, err);
      g(status).textContent=fmtT(v.duration)+' · live';
    });
  };
  input.value='';
}

// Extract all frames from a video into ImageBitmap array
async function extractFrames(video, key) {
  const duration=video.duration;
  if(!duration||duration>120) { console.log(`[depth] skipping extraction for ${key}: duration=${duration}s (max 120s)`); return 0; }
  const totalFrames=Math.ceil(duration*PRELOAD_FPS);
  const frames=[];
  const tmpCanvas=document.createElement('canvas');
  tmpCanvas.width=video.videoWidth; tmpCanvas.height=video.videoHeight;
  const tmpCtx=tmpCanvas.getContext('2d');

  for(let i=0;i<totalFrames;i++){
    const targetTime=i/PRELOAD_FPS;
    await seekTo(video,targetTime);
    tmpCtx.drawImage(video,0,0,tmpCanvas.width,tmpCanvas.height);
    const bmp=await createImageBitmap(tmpCanvas);
    frames.push(bmp);
  }
  preloadedFrames[key]=frames;
  return frames.length;
}

function seekTo(video,time){
  return new Promise(resolve=>{
    video.currentTime=Math.min(video.duration-0.01,Math.max(0,time));
    video.onseeked=()=>resolve();
    // Fallback timeout in case onseeked doesn't fire
    setTimeout(resolve,200);
  });
}
function updateDepthStatus() {
  console.log('[depth] updateDepthStatus: bg=%s ov=%s dp=%s ov2=%s dp2=%s', dBgReady, dOvReady, dDpReady, dOv2Ready, dDp2Ready);
  console.log('[depth] preloaded:', Object.entries(preloadedFrames).map(([k,v])=>k+':'+(v?v.length:'null')).join(' '));
  // If all loaded videos have preloaded frames, auto-unlock (no play/pause needed)
  const allPreloaded = (!dBgReady||preloadedFrames.bg) && (!dOvReady||preloadedFrames.ov) && (!dDpReady||preloadedFrames.dp) && (!dOv2Ready||preloadedFrames.ov2) && (!dDp2Ready||preloadedFrames.dp2);
  console.log('[depth] allPreloaded:', allPreloaded);
  if(allPreloaded && (dBgReady||dOvReady||dDpReady||dOv2Ready||dDp2Ready)) {
    depthUnlocked=true;
    g('dUnlockOverlay').style.display='none';
    console.log('[depth] auto-unlocked (all frames preloaded)');
    if(analyser) startLoop();
  } else if (dBgReady||dOvReady||dDpReady||dOv2Ready||dDp2Ready) {
    g('dUnlockOverlay').style.display='flex';
    console.log('[depth] showing unlock button (not all preloaded yet)');
  }
  resizeDepthCanvas();
}
function unlockDepthVids() {
  const allVids=[dBgVid,dOvVid,dDpVid,dOv2Vid,dDp2Vid];
  const allReady=[dBgReady,dOvReady,dDpReady,dOv2Ready,dDp2Ready];
  const vids=allVids.filter((_,i)=>allReady[i]);
  console.log('[depth] unlocking', vids.length, 'videos...');
  Promise.all(vids.map(v=>v.play().then(()=>{ v.pause(); v.currentTime=0; }))).then(()=>{
    depthUnlocked=true;
    g('dUnlockOverlay').style.display='none';
    console.log('[depth] unlocked ✓');
    startLoop();
  }).catch(err=>console.error('[depth] unlock failed:', err));
}
function resizeDepthCanvas() {
  const canvas=g('depthCanvas');
  const ref=dBgReady?dBgVid:dOvReady?dOvVid:dOv2Ready?dOv2Vid:null;
  if (!ref||!ref.videoWidth) return;
  canvas.width=ref.videoWidth; canvas.height=ref.videoHeight;
}
function setDepthDir(d) {
  depthDir=d;
  ['Reveal','Hide','Pulse'].forEach(n=>g('dDir'+n).classList.remove('active'));
  g('dDir'+d.charAt(0).toUpperCase()+d.slice(1)).classList.add('active');
}
function setDepthDir2(d) {
  depthDir2=d;
  ['Reveal','Hide','Pulse'].forEach(n=>g('d2Dir'+n).classList.remove('active'));
  g('d2Dir'+d.charAt(0).toUpperCase()+d.slice(1)).classList.add('active');
}
function setDepthLock(l) {
  depthLock=l;
  g('dLockAll').classList.toggle('active',l==='all');
  g('dLockIndep').classList.toggle('active',l==='indep');
}

// ─── AUDIO ───────────────────────────────────────────────────────────────────
function setVolume(val) {
  const pct = parseFloat(val) / 100;
  g('vVolume').textContent = Math.round(pct*100) + '%';
  if (gainNode) gainNode.gain.setTargetAtTime(pct, audioCtx.currentTime, 0.01);
}

function setupAnalyser() {
  analyser=audioCtx.createAnalyser(); analyser.fftSize=2048; analyser.smoothingTimeConstant=0.5;
  gainNode=audioCtx.createGain(); gainNode.gain.value=1.0;
  gainNode.connect(analyser); analyser.connect(audioCtx.destination);
}
// Audio pool
let audioPool = []; // [{name, buffer}]
let activeAudioIdx = -1;

function loadAudio(input) {
  const files = Array.from(input.files);
  if(!files.length) return;
  if(!audioCtx) audioCtx=new AudioContext();
  if(!analyser) setupAnalyser();
  let loaded = 0;
  files.forEach(f => {
    const reader = new FileReader();
    reader.onload = e => audioCtx.decodeAudioData(e.target.result, buf => {
      audioPool.push({ name: f.name.replace(/\.[^.]+$/,''), buffer: buf });
      loaded++;
      if(loaded === files.length) {
        renderAudioList();
        if(activeAudioIdx === -1) activateAudio(0);
      }
    }, () => { loaded++; }); // skip failed decodes
    reader.readAsArrayBuffer(f);
  });
  input.value='';
}

function activateAudio(idx) {
  if(idx < 0 || idx >= audioPool.length) return;
  // Stop current playback
  if(playing) { if(source){try{source.stop();}catch(e){} source=null;} playing=false; }
  activeAudioIdx = idx;
  const item = audioPool[idx];
  audioBuffer = item.buffer;
  tlAudioDuration = item.buffer.duration;
  g('audioStatus').textContent = item.name;
  g('dAudioStatus').textContent = item.name;
  g('playBtn').classList.remove('disabled');
  g('dPlayBtn').classList.remove('disabled');
  buildWaveform(item.buffer);
  renderAudioList();
  startLoop();
}

function removeAudio(idx) {
  audioPool.splice(idx, 1);
  if(activeAudioIdx === idx) {
    activeAudioIdx = audioPool.length ? 0 : -1;
    if(activeAudioIdx >= 0) activateAudio(0);
    else { audioBuffer = null; g('audioStatus').textContent='no audio'; }
  } else if(activeAudioIdx > idx) activeAudioIdx--;
  renderAudioList();
}

function playNextAudio() {
  if(audioPool.length <= 1) return;
  const next = (activeAudioIdx + 1) % audioPool.length;
  activateAudio(next);
  // Channel switch on audio track change
  if (CRT.isEnabled() && clipPool.length > 1) triggerChannelSwitch(1000);
  // Auto-play
  if(!playing) togglePlay();
}

function renderAudioList() {
  const list = g('audioList');
  if(!list) return;
  if(!audioPool.length) { list.innerHTML = ''; return; }
  list.innerHTML = audioPool.map((a, i) => `
    <div class="clip-item ${i===activeAudioIdx?'active':''}" data-aidx="${i}">
      <span class="clip-name">${a.name}</span>
      <span class="clip-status">${fmtT(a.buffer.duration)}</span>
      <span class="clip-remove" data-aremove="${i}">&times;</span>
    </div>
  `).join('');
  list.querySelectorAll('.clip-item').forEach(el => {
    el.addEventListener('click', e => {
      if(e.target.dataset.aremove !== undefined) return;
      activateAudio(parseInt(el.dataset.aidx));
    });
  });
  list.querySelectorAll('.clip-remove').forEach(el => {
    el.addEventListener('click', () => removeAudio(parseInt(el.dataset.aremove)));
  });
}

// Depth tab audio loader - same engine
function loadAudio2(input) {
  const f=input.files[0]; if(!f) return;
  g('dAudioStatus').textContent=f.name;
  g('audioStatus').textContent=f.name;
  if(!audioCtx) audioCtx=new AudioContext();
  if(!analyser) setupAnalyser();
  const reader=new FileReader();
  reader.onload=e=>audioCtx.decodeAudioData(e.target.result,buf=>{
    audioBuffer=buf; tlAudioDuration=buf.duration;
    g('playBtn').classList.remove('disabled');
    g('dPlayBtn').classList.remove('disabled');
    buildWaveform(buf); startLoop();
  });
  reader.readAsArrayBuffer(f); input.value='';
}
function togglePlay() {
  const btn=g('playBtn');
  [vid, dBgVid, dOvVid, dDpVid].forEach(v => { v.muted = true; v.volume = 0; });
  if(playing){
    if(source){try{source.stop();}catch(e){} source=null;}
    playing=false;
    btn.textContent='play'; btn.classList.remove('active');
  } else {
    if(!audioCtx){audioCtx=new AudioContext();setupAnalyser();}
    source=audioCtx.createBufferSource(); source.buffer=audioBuffer; source.connect(gainNode);
    source._startTime=audioCtx.currentTime;
    // Auto-advance to next track when finished (if pool > 1), else loop
    if(audioPool.length > 1) {
      source.loop=false;
      source.onended=()=>{ if(playing) playNextAudio(); };
    } else {
      source.loop=true;
    }
    source.start();
    playing=true; btn.textContent='stop'; btn.classList.add('active'); startLoop();
  }
}
async function toggleMic() {
  const btn=g('micBtn');
  if(micStream){micStream.getTracks().forEach(t=>t.stop());micStream=null;btn.classList.remove('active');btn.textContent='mic';return;}
  try {
    if(!audioCtx){audioCtx=new AudioContext();setupAnalyser();}
    micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
    audioCtx.createMediaStreamSource(micStream).connect(gainNode);
    btn.classList.add('active'); btn.textContent='mic on'; g('audioStatus').textContent='microphone active'; startLoop();
  } catch(e){g('audioStatus').textContent='mic denied';}
}
async function toggleSysAudio() {
  const btn=g('sysBtn');
  if(sysStream){sysStream.getTracks().forEach(t=>t.stop());sysStream=null;btn.classList.remove('active');btn.textContent='sys';g('audioStatus').textContent='stopped';try{analyser.connect(audioCtx.destination);}catch(e){}return;}
  try {
    if(!audioCtx){audioCtx=new AudioContext();setupAnalyser();}
    sysStream=await navigator.mediaDevices.getDisplayMedia({audio:{echoCancellation:false,noiseSuppression:false},video:true});
    sysStream.getVideoTracks().forEach(t=>t.stop());
    const tracks=sysStream.getAudioTracks(); if(!tracks.length){g('audioStatus').textContent='no audio — check share audio';sysStream=null;return;}
    const sysSource=audioCtx.createMediaStreamSource(sysStream);
    sysSource.connect(analyser);
    // Disconnect analyser from speakers to prevent echo
    try { analyser.disconnect(audioCtx.destination); } catch(e) {}
    btn.classList.add('active'); btn.textContent='sys on'; g('audioStatus').textContent=tracks[0].label||'system active';
    tracks[0].addEventListener('ended',()=>{sysStream=null;btn.classList.remove('active');btn.textContent='sys';try{analyser.connect(audioCtx.destination);}catch(e){}});
    startLoop();
  } catch(e){g('audioStatus').textContent=e.name==='NotAllowedError'?'cancelled':'error: '+e.message;}
}

// ─── FILTER / MODE ───────────────────────────────────────────────────────────
function setFilter(f) {
  currentFilter=f;
  document.querySelectorAll('.filter-btn[id^="fb"]').forEach(b=>b.classList.remove('active'));
  g('fb'+f.charAt(0).toUpperCase()+f.slice(1)).classList.add('active');
}
function setMode(m) {
  currentMode=m;
  document.querySelectorAll('.mode-btn').forEach(b=>b.classList.remove('active'));
  g('mode'+m.charAt(0).toUpperCase()+m.slice(1)).classList.add('active');
  const d={scrub:'amplitude → position. quiet=start, loud=end.',pingpong:'drives forward, silence reverses.',freeze:'loud=advance. quiet=hold.'};
  g('modeDesc').textContent=d[m];
}
function getBandAmp(data) {
  const len=data.length;
  const bands={all:[0,len],sub:[0,Math.floor(len*0.04)],bass:[Math.floor(len*0.04),Math.floor(len*0.15)],mids:[Math.floor(len*0.15),Math.floor(len*0.5)],high:[Math.floor(len*0.5),len]};
  const [s,e]=bands[currentFilter]; let sum=0; for(let i=s;i<e;i++) sum+=data[i]; return sum/(e-s);
}
function applyComp(val,ratio){ if(ratio<=1)return val; const k=100; return val<=k?val:k+(val-k)/ratio; }

// ─── BEAT TRACKER ────────────────────────────────────────────────────────────
function detectBeat(data) {
  const bassEnd=Math.floor(data.length*0.15); let flux=0;
  for(let i=0;i<bassEnd;i++){const d=data[i]-prevFluxVal;if(d>0)flux+=d;}
  prevFluxVal=Array.from(data.slice(0,bassEnd)).reduce((a,b)=>a+b,0)/bassEnd;
  rollingEnergy=rollingEnergy*0.95+flux*0.05;
  const now=performance.now();
  if(flux>rollingEnergy*1.8&&(now-lastBeatTime)>300&&flux>20){
    lastBeatTime=now; beatTimes.push(now); if(beatTimes.length>16)beatTimes.shift(); beatCount++;
    if(beatTimes.length>=4){
      const ivs=[]; for(let i=1;i<beatTimes.length;i++) ivs.push(beatTimes[i]-beatTimes[i-1]);
      const med=ivs.slice().sort((a,b)=>a-b)[Math.floor(ivs.length/2)];
      const clean=ivs.filter(v=>Math.abs(v-med)/med<0.5);
      if(clean.length>=2){ beatInterval=clean.reduce((a,b)=>a+b,0)/clean.length; const bpm=Math.round(60000/beatInterval); if(bpm>40&&bpm<250){g('btBPM').textContent=bpm;g('btStatus').textContent='locked';g('btStatus').style.color='#4ade80';btInitialized=true;} }
    }
    autoTuneTimer++; if(autoTuneTimer>=4){autoTuneTimer=0;runAutoTune(data);}
    return true;
  }
  return false;
}
function updateBeatPhase() {
  if(!btInitialized||lastBeatTime===0)return;
  beatPhase=Math.min(1,(performance.now()-lastBeatTime)/beatInterval);
  drawBeatRing(beatPhase); g('beatPhasebar').style.width=Math.round(beatPhase*100)+'%';
}
function drawBeatRing(phase) {
  const c=g('beatRing');if(!c)return; const ctx=c.getContext('2d'); const cx=20,cy=20,r=16;
  ctx.clearRect(0,0,40,40);
  ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.strokeStyle='#1a1a1a';ctx.lineWidth=4;ctx.stroke();
  ctx.beginPath();ctx.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+phase*Math.PI*2);ctx.strokeStyle=phase<0.25?'#4ade80':phase<0.75?'#facc15':'#f87171';ctx.lineWidth=4;ctx.stroke();
  const a=-Math.PI/2+phase*Math.PI*2;ctx.beginPath();ctx.arc(cx+r*Math.cos(a),cy+r*Math.sin(a),3,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();
}
function runAutoTune(data) {
  if(!btInitialized)return;
  const sorted=Array.from(data).sort((a,b)=>a-b);
  const floor=sorted[Math.floor(sorted.length*0.10)], p95=sorted[Math.floor(sorted.length*0.95)];
  const dr=p95/Math.max(floor,1); rollingPeak=rollingPeak*0.9+p95*0.1;
  const ng=Math.round(Math.min(10,Math.max(0.5,180/Math.max(rollingPeak,1)))*2)/2;
  const ngt=Math.min(80,Math.round(floor*1.5));
  const nc=Math.round(Math.max(1,Math.min(8,8/Math.max(dr,1)))*2)/2;
  const bpm=60000/beatInterval;
  const na=bpm>140?1:bpm>100?2:bpm>70?3:5, nr=bpm>140?8:bpm>100?12:bpm>70?15:18;
  setSlider('sGain','vGain',ng); setSlider('sGate','vGate',ngt); setSlider('sComp','vComp',nc); setSlider('sAttack','vAttack',na); setSlider('sRelease','vRelease',nr);
  g('btEnergy').textContent=Math.round(p95/255*100)+'%'; g('btDynamic').textContent=dr.toFixed(1)+'x';
  ['atGain','atGate','atComp','atMode'].forEach(id=>g(id).classList.add('lit'));
  g('atGain').textContent='gain '+ng; g('atGate').textContent='gate '+ngt; g('atComp').textContent='comp '+nc;
  g('atMode').textContent=bpm<80&&p95/255<0.4?'pingpong':bpm<60?'freeze':'scrub';
}

// ─── DEPTH COMPOSITE (WebGL) ─────────────────────────────────────────────────
const dCanvas=document.getElementById('depthCanvas');
let gl=null, glProgram=null, glTextures={}, glUniforms={}, glReady=false;

// Frame source helpers (shared by both WebGL and fallback)
function getFrameSource(key, vid, t, range) {
  const frames=preloadedFrames[key];
  if(frames&&frames.length) {
    const normPos=(t/255)*range/100;
    const idx=Math.max(0,Math.min(frames.length-1,Math.round(normPos*(frames.length-1))));
    return frames[idx];
  }
  if(vid.duration&&depthUnlocked) {
    const pct=(t/255)*range/100;
    vid.currentTime=Math.max(0,Math.min(vid.duration-0.01,pct*vid.duration));
  }
  return vid;
}

function getPairSource(ovKey, dpKey, ovVid, dpVid, t, range) {
  const ovFrames=preloadedFrames[ovKey], dpFrames=preloadedFrames[dpKey];
  if(ovFrames&&ovFrames.length&&dpFrames&&dpFrames.length) {
    const count=Math.min(ovFrames.length,dpFrames.length);
    const normPos=(t/255)*range/100;
    const idx=Math.max(0,Math.min(count-1,Math.round(normPos*(count-1))));
    return [ovFrames[idx], dpFrames[idx]];
  }
  const normPos=(t/255)*range/100;
  if(ovVid.duration&&depthUnlocked) ovVid.currentTime=Math.max(0,Math.min(ovVid.duration-0.01,normPos*ovVid.duration));
  if(dpVid.duration&&depthUnlocked) dpVid.currentTime=Math.max(0,Math.min(dpVid.duration-0.01,normPos*dpVid.duration));
  return [ovVid, dpVid];
}

function calcThresh(baseThresh, dir, t, audioDrive) {
  let eff;
  if(dir==='reveal') eff=baseThresh+(t*audioDrive);
  else if(dir==='hide') eff=baseThresh-(t*audioDrive);
  else eff=baseThresh+Math.sin(beatPhase*Math.PI*2)*64*audioDrive;
  return Math.max(0,Math.min(255,eff));
}

// ─── WebGL setup ─────────────────────────────────────────────────────────────
const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  vUv.y = 1.0 - vUv.y;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_SRC = `
precision mediump float;
varying vec2 vUv;

uniform sampler2D uBg;
uniform sampler2D uOv1;
uniform sampler2D uDp1;
uniform sampler2D uOv2;
uniform sampler2D uDp2;

uniform float uThresh1;
uniform float uFeather1;
uniform float uMix1;
uniform float uThresh2;
uniform float uFeather2;
uniform float uMix2;

uniform bool uPair1Active;
uniform bool uPair2Active;

void main() {
  vec4 color = texture2D(uBg, vUv);

  if (uPair1Active) {
    float depth1 = texture2D(uDp1, vUv).r;
    float alpha1 = smoothstep(uThresh1 - uFeather1, uThresh1 + uFeather1, depth1) * uMix1;
    vec4 ov1 = texture2D(uOv1, vUv);
    color = mix(color, ov1, alpha1);
  }

  if (uPair2Active) {
    float depth2 = texture2D(uDp2, vUv).r;
    float alpha2 = smoothstep(uThresh2 - uFeather2, uThresh2 + uFeather2, depth2) * uMix2;
    vec4 ov2 = texture2D(uOv2, vUv);
    color = mix(color, ov2, alpha2);
  }

  gl_FragColor = vec4(color.rgb, 1.0);
}`;

function initWebGL() {
  console.log('[depth] initWebGL: attempting WebGL context on', dCanvas);
  gl = dCanvas.getContext('webgl', {premultipliedAlpha:false, preserveDrawingBuffer:true});
  if(!gl) { console.warn('[depth] WebGL unavailable, using canvas2D fallback'); return false; }
  console.log('[depth] WebGL context acquired:', gl.getParameter(gl.VERSION));

  // Compile shaders
  const vs=gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, VERT_SRC); gl.compileShader(vs);
  if(!gl.getShaderParameter(vs,gl.COMPILE_STATUS)){console.error('[depth] vertex shader error:', gl.getShaderInfoLog(vs));return false;}
  console.log('[depth] vertex shader compiled');

  const fs=gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, FRAG_SRC); gl.compileShader(fs);
  if(!gl.getShaderParameter(fs,gl.COMPILE_STATUS)){console.error('[depth] fragment shader error:', gl.getShaderInfoLog(fs));return false;}
  console.log('[depth] fragment shader compiled');

  glProgram=gl.createProgram();
  gl.attachShader(glProgram,vs); gl.attachShader(glProgram,fs);
  gl.linkProgram(glProgram);
  if(!gl.getProgramParameter(glProgram,gl.LINK_STATUS)){console.error('[depth] program link error:', gl.getProgramInfoLog(glProgram));return false;}
  gl.useProgram(glProgram);
  console.log('[depth] shader program linked');

  // Full-screen quad
  const buf=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const aPos=gl.getAttribLocation(glProgram,'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos,2,gl.FLOAT,false,0,0);

  // Create textures for each input
  ['bg','ov1','dp1','ov2','dp2'].forEach((name,i)=>{
    const tex=gl.createTexture();
    gl.activeTexture(gl.TEXTURE0+i);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    // Init with 1x1 black pixel
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([0,0,0,255]));
    glTextures[name]={tex, unit:i};
    gl.uniform1i(gl.getUniformLocation(glProgram,'u'+name.charAt(0).toUpperCase()+name.slice(1)), i);
  });

  // Cache uniform locations
  glUniforms={};
  ['uThresh1','uFeather1','uMix1','uPair1Active','uThresh2','uFeather2','uMix2','uPair2Active'].forEach(name=>{
    glUniforms[name]=gl.getUniformLocation(glProgram,name);
  });

  console.log('[depth] textures created:', Object.keys(glTextures));
  console.log('[depth] uniforms cached:', Object.keys(glUniforms));

  glReady=true;
  console.log('[depth] WebGL init complete ✓');
  return true;
}

function uploadTexture(name, source) {
  if(!gl||!source) return;
  const t=glTextures[name];
  gl.activeTexture(gl.TEXTURE0+t.unit);
  gl.bindTexture(gl.TEXTURE_2D, t.tex);
  try {
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE, source);
  } catch(e) {
    console.warn('[depth] texture upload failed for', name, ':', e.message);
  }
}

function drawDepthFrameGL() {
  const W=dCanvas.width||1920, H=dCanvas.height||1080;
  gl.viewport(0,0,W,H);

  const t=envelopeAmp;

  // Upload background
  if(dBgReady) uploadTexture('bg', getFrameSource('bg', dBgVid, t, gv('dBgRange')));

  // Pair 1
  const p1Active=dOvReady&&dDpReady;
  if(p1Active) {
    const [ov1,dp1]=getPairSource('ov','dp',dOvVid,dDpVid,t,gv('dOvRange'));
    uploadTexture('ov1',ov1);
    uploadTexture('dp1',dp1);
  }
  const thresh1=calcThresh(gv('dThresh'), depthDir, t, gv('dAudioDrive')/10)/255;
  const feather1=Math.max(1,gv('dFeather'))/255;
  gl.uniform1f(glUniforms.uThresh1, thresh1);
  gl.uniform1f(glUniforms.uFeather1, feather1);
  gl.uniform1f(glUniforms.uMix1, gv('dMix')/10);
  gl.uniform1i(glUniforms.uPair1Active, p1Active?1:0);

  // Pair 2
  const p2Active=dOv2Ready&&dDp2Ready;
  if(p2Active) {
    const [ov2,dp2]=getPairSource('ov2','dp2',dOv2Vid,dDp2Vid,t,gv('dOv2Range'));
    uploadTexture('ov2',ov2);
    uploadTexture('dp2',dp2);
  }
  const thresh2=calcThresh(gv('d2Thresh'), depthDir2, t, gv('d2AudioDrive')/10)/255;
  const feather2=Math.max(1,gv('d2Feather'))/255;
  gl.uniform1f(glUniforms.uThresh2, thresh2);
  gl.uniform1f(glUniforms.uFeather2, feather2);
  gl.uniform1f(glUniforms.uMix2, gv('d2Mix')/10);
  gl.uniform1i(glUniforms.uPair2Active, p2Active?1:0);

  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
}

// ─── Canvas2D fallback ───────────────────────────────────────────────────────
let fallbackCtx=null, fallbackOff=null, fallbackOffCtx=null;

function initFallback() {
  fallbackCtx=dCanvas.getContext('2d',{willReadFrequently:true});
  fallbackOff=document.createElement('canvas');
  fallbackOffCtx=fallbackOff.getContext('2d',{willReadFrequently:true});
}

function drawDepthFrameFallback() {
  const W=dCanvas.width||1920, H=dCanvas.height||1080;
  fallbackOff.width=W; fallbackOff.height=H;
  const t=envelopeAmp;

  fallbackCtx.clearRect(0,0,W,H);
  if(dBgReady) fallbackCtx.drawImage(getFrameSource('bg',dBgVid,t,gv('dBgRange')),0,0,W,H);

  const result=fallbackCtx.getImageData(0,0,W,H);

  if(dOvReady&&dDpReady) {
    const [ov1,dp1]=getPairSource('ov','dp',dOvVid,dDpVid,t,gv('dOvRange'));
    const thresh1=calcThresh(gv('dThresh'),depthDir,t,gv('dAudioDrive')/10);
    fallbackComposite(result,ov1,dp1,thresh1,Math.max(1,gv('dFeather')),gv('dMix')/10,W,H);
  }
  if(dOv2Ready&&dDp2Ready) {
    const [ov2,dp2]=getPairSource('ov2','dp2',dOv2Vid,dDp2Vid,t,gv('dOv2Range'));
    const thresh2=calcThresh(gv('d2Thresh'),depthDir2,t,gv('d2AudioDrive')/10);
    fallbackComposite(result,ov2,dp2,thresh2,Math.max(1,gv('d2Feather')),gv('d2Mix')/10,W,H);
  }
  fallbackCtx.putImageData(result,0,0);
}

function fallbackComposite(result,ovSrc,dpSrc,thresh,feather,mix,W,H) {
  fallbackOffCtx.drawImage(dpSrc,0,0,W,H);
  const depthData=fallbackOffCtx.getImageData(0,0,W,H);
  fallbackOffCtx.drawImage(ovSrc,0,0,W,H);
  const ovData=fallbackOffCtx.getImageData(0,0,W,H);
  for(let i=0;i<result.data.length;i+=4) {
    const depth=depthData.data[i];
    let alpha;
    const lo=thresh-feather, hi=thresh+feather;
    if(depth<=lo) alpha=0;
    else if(depth>=hi) alpha=1;
    else { const x=(depth-lo)/(hi-lo); alpha=x*x*(3-2*x); }
    alpha*=mix;
    const ia=1-alpha;
    result.data[i]  =result.data[i]*ia  +ovData.data[i]*alpha;
    result.data[i+1]=result.data[i+1]*ia+ovData.data[i+1]*alpha;
    result.data[i+2]=result.data[i+2]*ia+ovData.data[i+2]*alpha;
    result.data[i+3]=255;
  }
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────
let depthRendererInit=false;

let _depthDrawCount=0;
function drawDepthFrame() {
  if(!dBgReady&&!dOvReady&&!dOv2Ready)return;

  if(!depthRendererInit) {
    depthRendererInit=true;
    console.log('[depth] initializing renderer...');
    console.log('[depth] canvas size:', dCanvas.width, 'x', dCanvas.height);
    console.log('[depth] state: bg=%s ov=%s dp=%s ov2=%s dp2=%s unlocked=%s',
      dBgReady, dOvReady, dDpReady, dOv2Ready, dDp2Ready, depthUnlocked);
    console.log('[depth] preloaded:', Object.entries(preloadedFrames).map(([k,v])=>k+':'+(v?v.length:'null')).join(' '));
    if(!initWebGL()) {
      console.log('[depth] WebGL failed, using canvas2D fallback');
      initFallback();
    }
  }

  if(_depthDrawCount<3 || _depthDrawCount%300===0) {
    console.log(`[depth] draw #${_depthDrawCount} | renderer=${glReady?'webgl':'canvas2d'} | amp=${Math.round(envelopeAmp)} | p1=${dOvReady&&dDpReady} p2=${dOv2Ready&&dDp2Ready}`);
  }
  _depthDrawCount++;

  if(glReady) drawDepthFrameGL();
  else drawDepthFrameFallback();
}

// ─── TIMELINE ────────────────────────────────────────────────────────────────
function buildWaveform(buffer) {
  const pcm=buffer.getChannelData(0), W=272, spp=Math.floor(pcm.length/W);
  waveformData=new Float32Array(W);
  for(let i=0;i<W;i++){let max=0;const s=i*spp;for(let j=s;j<s+spp;j++){const a=Math.abs(pcm[j]);if(a>max)max=a;}waveformData[i]=max;}
  drawTimeline();
}
function drawTimeline(){drawAudioTL();drawVideoTL();updateTlTimes();}
function drawAudioTL(){
  const canvas=g('tlAudio');if(!canvas)return;
  const W=canvas.offsetWidth||272,H=36,dpr=window.devicePixelRatio||1;
  canvas.width=W*dpr;canvas.height=H*dpr;
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  ctx.fillStyle='#111';ctx.fillRect(0,0,W,H);
  if(!waveformData){ctx.fillStyle='#2a2a2a';ctx.font='10px sans-serif';ctx.textAlign='center';ctx.fillText('load audio',W/2,H/2+4);return;}
  const dur=tlAudioDuration,visDur=dur/tlZoom,visEnd=Math.min(dur,tlOffset+visDur);
  const sp=Math.floor((tlOffset/dur)*waveformData.length),ep=Math.ceil((visEnd/dur)*waveformData.length);
  ctx.fillStyle='#1a2a1a';ctx.fillRect(0,0,W,H);
  for(let x=0;x<W;x++){const idx=Math.floor(sp+(x/W)*(ep-sp));const val=waveformData[Math.min(idx,waveformData.length-1)]||0;const bh=val*(H-4);ctx.fillStyle='#4ade80';ctx.fillRect(x,(H-bh)/2,1,bh);}
  const inX=((gv('sVidStart')/100*dur-tlOffset)/visDur)*W,outX=((gv('sVidEnd')/100*dur-tlOffset)/visDur)*W;
  ctx.fillStyle='rgba(96,165,250,0.1)';ctx.fillRect(inX,0,outX-inX,H);
  ctx.strokeStyle='#60a5fa';ctx.lineWidth=1.5;ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(inX,0);ctx.lineTo(inX,H);ctx.stroke();
  ctx.strokeStyle='#facc15';ctx.beginPath();ctx.moveTo(outX,0);ctx.lineTo(outX,H);ctx.stroke();
  const gs=visDur<=30?5:visDur<=120?15:30,fg=Math.ceil(tlOffset/gs)*gs;
  ctx.strokeStyle='#222';ctx.lineWidth=0.5;
  for(let t=fg;t<visEnd;t+=gs){const x=((t-tlOffset)/visDur)*W;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
}
function drawVideoTL(){
  const canvas=g('tlVideo');if(!canvas)return;
  const W=canvas.offsetWidth||272,H=20,dpr=window.devicePixelRatio||1;
  canvas.width=W*dpr;canvas.height=H*dpr;
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  ctx.fillStyle='#111';ctx.fillRect(0,0,W,H);
  if(!vid.duration){ctx.fillStyle='#2a2a2a';ctx.font='9px sans-serif';ctx.textAlign='center';ctx.fillText('load video',W/2,H/2+4);return;}
  const ref=tlAudioDuration||vid.duration,visDur=ref/tlZoom;
  ctx.fillStyle='#1a1a2a';ctx.fillRect(0,0,W,H);
  ctx.fillStyle='#2a2a4a';ctx.fillRect(0,8,W,6);
  const vt=vid.currentTime*(ref/vid.duration),vx=((vt-tlOffset)/visDur)*W;
  ctx.fillStyle='#4ade8033';ctx.fillRect(0,8,Math.max(0,vx),6);
  ctx.fillStyle='#4ade80';ctx.fillRect(vx-1,2,2,16);
  ctx.beginPath();ctx.moveTo(vx-4,2);ctx.lineTo(vx+4,2);ctx.lineTo(vx,8);ctx.closePath();ctx.fill();
}
function updateTlTimes(){
  const dur=tlAudioDuration||vid.duration||0;if(!dur)return;
  const visDur=dur/tlZoom,visEnd=Math.min(dur,tlOffset+visDur);
  g('tlStart').textContent=fmtT(tlOffset);g('tlMid').textContent=fmtT(tlOffset+visDur/2);g('tlEnd').textContent=fmtT(visEnd);
}
function tlSetupEvents(){
  const ac=g('tlAudio');if(!ac)return;
  ac.addEventListener('mousedown',e=>{
    const rect=ac.getBoundingClientRect(),x=e.clientX-rect.left,W=rect.width;
    const dur=tlAudioDuration||1,visDur=dur/tlZoom;
    const inX=((gv('sVidStart')/100*dur-tlOffset)/visDur)*W,outX=((gv('sVidEnd')/100*dur-tlOffset)/visDur)*W;
    if(Math.abs(x-inX)<8)tlDragging='in'; else if(Math.abs(x-outX)<8)tlDragging='out';
  });
  ac.addEventListener('mousemove',e=>{
    if(!tlDragging)return;
    const rect=ac.getBoundingClientRect(),x=e.clientX-rect.left,W=rect.width;
    const dur=tlAudioDuration||1,visDur=dur/tlZoom;
    const t=tlOffset+(x/W)*visDur,pct=Math.round(Math.max(0,Math.min(100,(t/dur)*100)));
    if(tlDragging==='in')setSlider('sVidStart','vVidStart',pct,v=>v+'%');
    if(tlDragging==='out')setSlider('sVidEnd','vVidEnd',pct,v=>v+'%');
    drawAudioTL();
  });
  ac.addEventListener('mouseup',()=>tlDragging=null);
  ac.addEventListener('mouseleave',()=>tlDragging=null);
  ac.addEventListener('wheel',e=>{e.preventDefault();tlZoom=Math.max(1,Math.min(20,tlZoom+(e.deltaY>0?-0.2:0.2)*tlZoom));const dur=tlAudioDuration||1;tlOffset=Math.max(0,Math.min(dur-dur/tlZoom,tlOffset));drawTimeline();},{passive:false});
}

// ─── BAKE SCRUB ──────────────────────────────────────────────────────────────
function startBake(){
  if(!vid.duration){alert('Load a video first');return;}
  if(!analyser){alert('Load audio first');return;}
  const bc=document.createElement('canvas'); bc.width=1920; bc.height=1080;
  const bctx=bc.getContext('2d');
  const cs=bc.captureStream(30);
  if(!audioCtx){alert('No audio context');return;}
  bakeAudioDest=audioCtx.createMediaStreamDestination(); analyser.connect(bakeAudioDest);
  bakeAudioDest.stream.getAudioTracks().forEach(t=>cs.addTrack(t));
  const mt=MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')?'video/webm;codecs=vp9,opus':'video/webm';
  recordedChunks=[]; mediaRecorder=new MediaRecorder(cs,{mimeType:mt,videoBitsPerSecond:8000000});
  mediaRecorder.ondataavailable=e=>{if(e.data.size>0)recordedChunks.push(e.data);};
  mediaRecorder.onstop=finaliseBake; mediaRecorder.start(100);
  bakeStartTime=Date.now();
  g('bakeBtn').classList.add('disabled'); g('stopBakeBtn').classList.remove('disabled');
  g('recInd').textContent='⬤ REC'; g('recInd').style.color='#f87171';
  function bakeDraw(){
    if(!mediaRecorder||mediaRecorder.state==='inactive')return;
    bakeAnimFrame=requestAnimationFrame(bakeDraw);
    // Capture CRT output if active, otherwise raw video
    if(CRT.isEnabled() && window._crtOC) {
      window._crtOCtx.drawImage(vid,0,0,1920,1080);
      const bakeRatio = gv('cGlitchRatio') / 100;
      const bakeClean = Math.random() >= bakeRatio;
      if (bakeClean) { for (let i = 0; i < _glitchKeys.length; i++) CRT.setParam(_glitchKeys[i], 0); }
      try { CRT.render(window._crtOC, 1920, 1080); } catch(e){}
      if (bakeClean) { for (let i = 0; i < _glitchKeys.length; i++) CRT.setParam(_glitchKeys[i], _glitchSaved[i]); }
      bctx.drawImage(g('crtCanvas'),0,0,1920,1080);
    } else {
      bctx.drawImage(vid,0,0,bc.width,bc.height);
    }
    if(audioBuffer){const el=(Date.now()-bakeStartTime)/1000;g('bakeProgress').style.width=Math.min(100,(el/audioBuffer.duration)*100)+'%';g('recInd').textContent='⬤ REC '+fmtT(el);if(el>=audioBuffer.duration)stopBake();}
  }
  bakeDraw();
}
function stopBake(){
  if(mediaRecorder&&mediaRecorder.state!=='inactive')mediaRecorder.stop();
  if(bakeAnimFrame)cancelAnimationFrame(bakeAnimFrame);
  if(bakeAudioDest){try{analyser.disconnect(bakeAudioDest);}catch(e){} bakeAudioDest=null;}
  g('bakeBtn').classList.remove('disabled'); g('stopBakeBtn').classList.add('disabled');
  g('recInd').textContent='saving...'; g('recInd').style.color='#facc15';
}
function finaliseBake(){
  const blob=new Blob(recordedChunks,{type:'video/webm'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='scrub-'+new Date().toISOString().slice(0,19).replace(/:/g,'-')+'.webm'; a.click();
  g('recInd').textContent='downloaded'; g('recInd').style.color='#4ade80';
  g('bakeProgress').style.width='0%'; recordedChunks=[]; mediaRecorder=null;
}

// ─── BAKE DEPTH ───────────────────────────────────────────────────────────────
function startDepthBake(){
  if(!dBgReady&&!dOvReady){alert('Load depth videos first');return;}
  const cs=dCanvas.captureStream(30);
  if(audioCtx){ const ad=audioCtx.createMediaStreamDestination(); analyser.connect(ad); ad.stream.getAudioTracks().forEach(t=>cs.addTrack(t)); }
  const mt=MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')?'video/webm;codecs=vp9,opus':'video/webm';
  dRecordedChunks=[]; dMediaRecorder=new MediaRecorder(cs,{mimeType:mt,videoBitsPerSecond:8000000});
  dMediaRecorder.ondataavailable=e=>{if(e.data.size>0)dRecordedChunks.push(e.data);};
  dMediaRecorder.onstop=finaliseDepthBake; dMediaRecorder.start(100);
  dBakeStartTime=Date.now();
  g('dBakeBtn').classList.add('disabled'); g('dStopBakeBtn').classList.remove('disabled');
  g('dRecInd').textContent='⬤ REC'; g('dRecInd').style.color='#f87171';
  function dd(){
    if(!dMediaRecorder||dMediaRecorder.state==='inactive')return;
    dBakeAnimFrame=requestAnimationFrame(dd);
    drawDepthFrame();
    if(audioBuffer){const el=(Date.now()-dBakeStartTime)/1000;g('dBakeProgress').style.width=Math.min(100,(el/audioBuffer.duration)*100)+'%';g('dRecInd').textContent='⬤ REC '+fmtT(el);if(el>=audioBuffer.duration)stopDepthBake();}
  }
  dd();
}
function stopDepthBake(){
  if(dMediaRecorder&&dMediaRecorder.state!=='inactive')dMediaRecorder.stop();
  if(dBakeAnimFrame)cancelAnimationFrame(dBakeAnimFrame);
  g('dBakeBtn').classList.remove('disabled'); g('dStopBakeBtn').classList.add('disabled');
  g('dRecInd').textContent='saving...'; g('dRecInd').style.color='#facc15';
}
function finaliseDepthBake(){
  const blob=new Blob(dRecordedChunks,{type:'video/webm'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='depth-'+new Date().toISOString().slice(0,19).replace(/:/g,'-')+'.webm'; a.click();
  g('dRecInd').textContent='downloaded'; g('dRecInd').style.color='#4ade80';
  g('dBakeProgress').style.width='0%'; dRecordedChunks=[]; dMediaRecorder=null;
}

// ─── SIDEBAR / FULLSCREEN / HOTKEYS ──────────────────────────────────────────
function toggleSidebar(){
  sidebarVisible=!sidebarVisible;
  ['sidebar','sidebarDepth','sidebarLayers'].forEach(id=>{ const el=g(id); if(el) el.classList.toggle('hidden',!sidebarVisible); });
  ['ws-scrub','ws-depth','ws-layers'].forEach(id=>{ const el=g(id); if(el) el.classList.toggle('sidebar-hidden',!sidebarVisible); });
  const btn=g('hideBtn');
  if(sidebarVisible){btn.textContent='✕ hide';btn.classList.remove('hm');hideToast();}
  else{btn.innerHTML='&#9776; show';btn.classList.add('hm');showToast();}
}
function showToast(){const t=g('toast');t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),3000);}
function hideToast(){g('toast').classList.remove('show');}
function toggleFullscreen(){
  if(!document.fullscreenElement){document.documentElement.requestFullscreen();}
  else{document.exitFullscreen();}
}
document.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT')return;
  switch(e.key.toLowerCase()){
    case 'h':toggleSidebar();break; case 'f':toggleFullscreen();break;
    case ' ':e.preventDefault();if(audioBuffer)togglePlay();break;
    case '1':switchTab('scrub');break; case '2':switchTab('depth');break; case '3':switchTab('layers');break;
    case 'm':g('modeScrub').click();break; case 'p':g('modePingpong').click();break; case 'z':g('modeFreeze').click();break;
    case 'arrowleft':e.preventDefault();if(vid.duration)vid.currentTime=Math.max(0,vid.currentTime-5);break;
    case 'arrowright':e.preventDefault();if(vid.duration)vid.currentTime=Math.min(vid.duration,vid.currentTime+5);break;
  }
});

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────
function startLoop(){
  if(animFrame)return;
  const data=new Uint8Array(analyser.frequencyBinCount);

  let _loopFrame = 0;
  function loop(){
    animFrame=requestAnimationFrame(loop);
    _loopFrame++;
    analyser.getByteFrequencyData(data);
    detectBeat(data); updateBeatPhase();

    const gate=gv('sGate'),gain=gv('sGain'),comp=gv('sComp'),attack=gv('sAttack'),release=gv('sRelease');
    const raw=getBandAmp(data),gated=raw<gate?0:raw,gained=Math.min(gated*gain,255),compressed=applyComp(gained,comp);
    if(compressed>envelopeAmp) envelopeAmp=envelopeAmp*(attack/20)+compressed*(1-attack/20);
    else envelopeAmp=envelopeAmp*(release/20)+compressed*(1-release/20);
    const t=Math.min(envelopeAmp/255,1);

    g('ampNum').textContent=Math.round(envelopeAmp);
    const col=t>0.85?'#f87171':t>0.6?'#facc15':'#4ade80';
    ['gainFill','gainFill2'].forEach(id=>{g(id).style.width=Math.round(t*100)+'%';g(id).style.background=col;});

    const step=Math.floor(data.length/16);
    barIds.forEach((id,i)=>{const b=g(id);if(!b)return;const val=data[i*step]/255;b.style.height=Math.round(val*24)+'px';b.style.background=val>0.75?'#f87171':val>0.4?'#4ade80':'#2a2a2a';});
    // Mirror to depth tab VU
    const dVuIds=['dvb0','dvb1','dvb2','dvb3','dvb4','dvb5','dvb6','dvb7','dvb8','dvb9','dvba','dvbb','dvbc','dvbd','dvbe','dvbf'];
    dVuIds.forEach((id,i)=>{const b=g(id);if(!b)return;const val=data[i*step]/255;b.style.height=Math.round(val*20)+'px';b.style.background=val>0.75?'#f87171':val>0.4?'#4ade80':'#2a2a2a';});
    if(g('dAmpNum')) g('dAmpNum').textContent=Math.round(envelopeAmp);
    if(g('dGainFill')){g('dGainFill').style.width=Math.round(t*100)+'%';g('dGainFill').style.background=col;}
    // Mirror to layers tab VU
    const lyVuIds=['lyvb0','lyvb1','lyvb2','lyvb3','lyvb4','lyvb5','lyvb6','lyvb7'];
    const lyStep=Math.floor(data.length/8);
    lyVuIds.forEach((id,i)=>{const b=g(id);if(!b)return;const val=data[i*lyStep]/255;b.style.height=Math.round(val*24)+'px';b.style.background=val>0.75?'#f87171':val>0.4?'#4ade80':'#2a2a2a';});
    // Sync play button states across tabs
    if(g('dPlayBtn')) g('dPlayBtn').textContent=playing?'stop':'play';
    if(g('lyPlayBtn')) g('lyPlayBtn').textContent=playing?'stop':'play';

    // Alive
    const aliveLevel=gv('sAlive'),lfoSpeed=gv('sLFO'),lfoDepth=gv('sLFODepth'),driftSpeed=gv('sDrift'),stuckAfter=gv('sStuck')*1000;
    lfoPhase+=lfoSpeed/1000;
    const noise=(Math.random()-0.5)*0.002*aliveLevel,minDrift=(driftSpeed/5000)*(aliveLevel/10);
    const now2=Date.now();
    if(Math.abs(vid.currentTime-lastVidTime)>0.01){lastVidChangeAt=now2;lastVidTime=vid.currentTime;}
    const isStuck=(now2-lastVidChangeAt)>stuckAfter&&aliveLevel>0;
    const ind=g('aliveInd');
    if(isStuck){ind.textContent='⬤ unstuck';ind.style.color='#f87171';}else if(aliveLevel>0){ind.textContent='⬤ alive';ind.style.color='#4ade80';}else{ind.textContent='⬤ idle';ind.style.color='#333';}
    const fInd=g('flickerInd');
    if(flickerActive){fInd.textContent='⬤ flicker';fInd.style.color='#f87171';}else if(t>=PEAK_THRESHOLD){fInd.textContent='⬤ peak';fInd.style.color='#facc15';}else{fInd.textContent='◯ flicker';fInd.style.color='#333';}

    const beatSync=gv('sBeatSync')/10;
    const tAlive=Math.max(0,Math.min(1,t+noise+(isStuck?stuckNudgeDir*0.05:0)));

    // Scrub video
    if(vid.readyState>=2&&vid.duration&&videoUnlocked){
      const rs=vid.duration*gv('sVidStart')/100,re=vid.duration*gv('sVidEnd')/100,range=Math.max(re-rs,0.01);
      const audioPos=rs+tAlive*range,beatPos=btInitialized?rs+beatPhase*range:audioPos;
      const blended=audioPos*(1-beatSync)+beatPos*beatSync;
      const lfoSec=Math.sin(lfoPhase)*(lfoDepth/10)*range*(aliveLevel/10);
      let nextTime=vid.currentTime;
      if(isStuck&&aliveLevel>0){
        // Fully override — sweep across the range at a visible speed
        const sweepSpeed = (driftSpeed / 10) * (range / 60); // covers range in ~60 frames at speed 10
        nextTime = vid.currentTime + sweepSpeed * bounceDir;
      } else if(currentMode==='scrub'){
        if(aliveLevel>0 && t<0.15){
          // Low amplitude + alive — drift rather than snap to start
          nextTime = vid.currentTime + (driftSpeed/200)*bounceDir + lfoSec*0.5;
        } else {
          nextTime = blended + lfoSec + noise*range;
        }
      }
      else if(currentMode==='pingpong'){ nextTime=vid.currentTime+(tAlive-0.5)*0.4+minDrift*bounceDir; }
      else if(currentMode==='freeze'){ if(tAlive>0.3||aliveLevel>0) nextTime=vid.currentTime+0.033*(tAlive>0.3?1:0.3)*bounceDir+minDrift*bounceDir; }
      if(currentMode==='pingpong' && range>0.01){
        // Loop: modulo wrap
        if(nextTime>=re) nextTime=rs+((nextTime-rs)%(range));
        else if(nextTime<rs) nextTime=re-((rs-nextTime)%(range));
      } else if(currentMode!=='pingpong') {
        if(nextTime>=re){bounceDir=-1;stuckNudgeDir=-1;nextTime=re-0.01;}else if(nextTime<=rs){bounceDir=1;stuckNudgeDir=1;nextTime=rs+0.01;}
      }

      // ── Flicker at peak ──────────────────────────────────────────────────
      const now3 = Date.now();
      if (t >= PEAK_THRESHOLD) {
        peakHeldFor += 16; // ~1 frame at 60fps
        if (peakHeldFor >= PEAK_HOLD_MS) {
          flickerActive = true;
          // Oscillate between neighbouring frames rapidly
          flickerTimer += 16;
          const flickerSpeed = (21 - gv('sFlicker')) * 12; // ms per flicker, inverted so high=fast
          if (flickerTimer >= flickerSpeed) {
            flickerTimer = 0;
            flickerDir *= -1;
          }
          const flickerRange = range * (gv('sFlickerRange') / 100);
          nextTime = nextTime + flickerDir * flickerRange;
          nextTime = Math.max(rs, Math.min(re, nextTime));
        }
      } else {
        peakHeldFor = Math.max(0, peakHeldFor - 32); // decay
        if (peakHeldFor === 0) flickerActive = false;
      }
      // ────────────────────────────────────────────────────────────────────

      vid.currentTime=nextTime;
      const pos=(vid.currentTime-rs)/range,pct=Math.round(Math.max(0,Math.min(1,pos))*100);
      g('scrubFill').style.width=pct+'%'; g('scrubHead').style.left=pct+'%';
      g('timeDisplay').textContent=fmtT(vid.currentTime)+' / '+fmtT(vid.duration);
    }

    // CRT post-process on scrub video
    if(currentTab==='scrub' && CRT.isEnabled() && vid.videoWidth) {
      const crtC = g('crtCanvas');
      vid.style.visibility = 'visible';
      vid.style.opacity = '0';
      // Fill entire view area
      crtC.style.left = '0';
      crtC.style.top = '0';
      crtC.style.width = '100%';
      crtC.style.height = '100%';
      crtC.style.display = 'block';
      // Draw video to offscreen 2D canvas (always works, even during seek)
      if(!window._crtOC) {
        window._crtOC = document.createElement('canvas');
        window._crtOCtx = window._crtOC.getContext('2d');
      }
      const oc = window._crtOC;
      const CRT_W = 1920, CRT_H = 1080;
      if(oc.width !== CRT_W || oc.height !== CRT_H) {
        oc.width = CRT_W; oc.height = CRT_H;
      }
      // Aspect-correct fill (cover, crop edges)
      const ctx = window._crtOCtx;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, CRT_W, CRT_H);
      const vw = vid.videoWidth, vh = vid.videoHeight;
      const scale = Math.max(CRT_W / vw, CRT_H / vh);
      const dw = vw * scale, dh = vh * scale;
      ctx.drawImage(vid, (CRT_W - dw) / 2, (CRT_H - dh) / 2, dw, dh);
      // Auto-randomize intensity
      updateAutoIntensity();
      // Amplitude-driven glitch — also updates sliders
      if(crtAmpGlitch) {
        const ampRaw = envelopeAmp / 255;
        // Exponential curve: slider 0-200 → multiplier 0.01-4.0
        // Low end = fine control, high end = dramatic
        const ampI = Math.pow(gv('cAmpIntensity') / 100, 2.0);
        const amp = Math.min(ampRaw * ampI, 1.0);
        const rand = Math.random();
        // Spike hold: sustain glitch, retrigger continuously while loud
        if(!window._ampSpikeHold) window._ampSpikeHold = 0;
        if(!window._ampSpikeRand) window._ampSpikeRand = Math.random();
        if(!window._ampSpikeAmt) window._ampSpikeAmt = 0;
        if(!window._ampCooldownUntil) window._ampCooldownUntil = 0;
        const ampThresh = Math.max(0.1, 0.6 - ampI * 0.3);
        const triggerChance = Math.min(ampI * 0.3, 0.9);
        const now = performance.now();
        // Cooldown in seconds: 25%=2-4s, 50%=1-2s, 100%=0.3-0.8s, 200%=0s
        const cooldownMs = Math.max(0, (1.0 - ampI) * 3000 + Math.random() * 1500);
        if(now < window._ampCooldownUntil) { /* cooling down */ }
        else if(amp > ampThresh && rand < triggerChance && window._ampSpikeHold <= 0) {
          window._ampSpikeHold = 8 + Math.floor(Math.random() * 18);
          window._ampSpikeRand = Math.random();
          window._ampSpikeAmt = amp;
          window._ampCooldownUntil = now + cooldownMs;
        }
        if(window._ampSpikeHold > 0) window._ampSpikeHold--;
        // Smooth decay: spike strength fades over hold duration
        const holdFade = window._ampSpikeHold > 0 ? Math.min(1, window._ampSpikeHold / 8) : 0;
        const spike = holdFade > 0;
        const sRand = window._ampSpikeRand;
        const sAmp = window._ampSpikeAmt * holdFade;
        const vals = {
          glitchIntensity: spike ? sAmp * 0.8 + sRand * 0.2 : amp * 0.05,
          chromatic:       spike ? sAmp * 5 : amp * 0.5,
          jitter:          spike ? sAmp * 0.8 : amp * 0.02,
          rgbShift:        spike ? sAmp * 3 + sRand * 2 : 0,
          distortion:      spike ? sAmp * 2 : 0,
          distortion2:     spike ? sAmp * 1.5 : 0,
          screenTear:      spike ? sRand * holdFade : 0,
          noise:           spike ? sAmp * 0.15 : amp * 0.01,
          glitchSpeed:     1 + amp * 4,
          colorBleed:      spike ? sAmp * 0.5 : amp * 0.05,
          rollSpeed:       spike ? sAmp * 0.3 : 0,
          rollLine:        spike ? 0.4 : 0,
          vSyncWobble:     spike ? sAmp * 0.5 : amp * 0.02,
          hSyncLoss:       spike ? sAmp * 0.4 : 0,
          dataBend:        spike ? sAmp * 0.5 : 0,
          pixelate:        spike && sRand > 0.8 ? sAmp * 0.3 : 0,
          pixelStretch:    spike ? sAmp * 0.5 : 0,
          clockSkew:       spike ? sAmp * 0.6 : 0,
          bitCrush:        spike ? sAmp * 0.4 : 0,
          lineCorrupt:     spike ? sAmp * 0.4 : amp * 0.01,
          colorDrift:      amp * 0.3,
          feedback:        amp * 0.3,
          staticBurst:     spike ? sRand * holdFade * 0.5 : 0,
          channelSwap:     spike && sRand > 0.7 ? Math.floor(sRand * 5) : 0,
          linesSkip:       spike ? sAmp * 0.2 : 0,
          shockwave:       spike ? sAmp * 0.3 : 0,
          ghosting:        amp * 0.5 + (spike ? holdFade * 0.3 : 0),
          ruttEtra:        spike ? sAmp * 0.3 : 0,
          vCollapse:       spike && sRand > 0.9 ? sAmp * 0.3 : 0,
          sCurve:          spike ? sAmp * 0.3 : 0,
          emi:             spike ? sAmp * 0.4 : amp * 0.02,
          humBar:          amp * 0.2,
          zoomBlur:        spike ? sAmp * 0.3 : 0,
          lumaDisplace:    spike ? sAmp * 0.4 : amp * 0.02,
          noiseDisplace:   spike ? sAmp * 0.3 : 0,
          solarize:        spike && sRand > 0.85 ? sAmp * 0.4 : 0,
          posterize:       spike && sRand > 0.9 ? sAmp * 0.3 : 0,
          invert:          spike && sRand > 0.95 ? holdFade : 0,
          vortex:          spike && sRand > 0.9 ? sAmp * 0.2 : 0,
          waveDistort:     spike ? sAmp * 0.3 : 0,
          mirror:          spike && sRand > 0.95 ? Math.floor(sRand * 6) + 2 : 0,
          flicker:         spike ? sAmp * 0.06 : amp * 0.01,
          tapeWow:         amp * 0.3,
          tapeFlutter:     spike ? sAmp * 0.4 : amp * 0.05,
          headClog:        spike && sRand > 0.85 ? sAmp * 0.5 : 0,
          vhsPause:        spike && sRand > 0.9 ? sAmp * 0.4 : 0,
          colorFade:       amp * 0.2,
          chromaLoss:      spike ? sAmp * 0.3 : 0,
          gateWeave:       amp * 0.15,
          scanRainbow:     spike && sRand > 0.8 ? sAmp * 0.4 : 0,
          edgeGlow:        spike ? sAmp * 0.3 : amp * 0.03,
          bayerDither:     spike && sRand > 0.85 ? sAmp * 0.3 : 0,
          ringing:         spike ? sAmp * 0.3 : amp * 0.05,
          interlace:       amp * 0.3,
          cornerPurity:    amp * 0.2,
          degauss:         spike && sRand > 0.9 ? sAmp * 0.5 : 0,
        };
        for (const k in vals) CRT.setParam(k, vals[k]);
        if (_loopFrame % 6 === 0) syncCRTSliders();
      }
      // Circuit bend — amplitude drives data corruption effects
      if(crtCircuitBend) {
        const ampRaw = envelopeAmp / 255;
        const bendI = Math.pow(gv('cBendIntensity') / 100, 2.0);
        const amp = Math.min(ampRaw * bendI, 1.0);
        const rand = Math.random();
        const phase = beatPhase;
        // Spike hold for circuit bend — retrigger while loud
        if(!window._cbSpikeHold) window._cbSpikeHold = 0;
        if(!window._cbSpikeRand) window._cbSpikeRand = Math.random();
        if(!window._cbSpikeAmt) window._cbSpikeAmt = 0;
        if(!window._cbCooldownUntil) window._cbCooldownUntil = 0;
        const cbThresh = Math.max(0.1, 0.6 - bendI * 0.3);
        const cbTriggerChance = Math.min(bendI * 0.3, 0.9);
        const cbNow = performance.now();
        const cbCooldownMs = Math.max(0, (1.0 - bendI) * 3000 + Math.random() * 1500);
        if(cbNow < window._cbCooldownUntil) { /* cooling down */ }
        else if(amp > cbThresh && rand < cbTriggerChance && window._cbSpikeHold <= 0) {
          window._cbSpikeHold = 10 + Math.floor(Math.random() * 20);
          window._cbSpikeRand = Math.random();
          window._cbSpikeAmt = amp;
          window._cbCooldownUntil = cbNow + cbCooldownMs;
        }
        if(window._cbSpikeHold > 0) window._cbSpikeHold--;
        const cbFade = window._cbSpikeHold > 0 ? Math.min(1, window._cbSpikeHold / 8) : 0;
        const hit = cbFade > 0;
        const cbAmp = window._cbSpikeAmt * cbFade;
        const cbVals = {
          clockSkew:      hit ? cbAmp * 0.8 : amp * 0.05,
          dataBend:       hit ? cbAmp * 0.7 + rand * 0.3 : amp * 0.03,
          bitCrush:       hit ? cbAmp * 0.6 : 0,
          lineCorrupt:    hit ? cbAmp * 0.5 : amp * 0.02,
          pixelStretch:   hit ? cbAmp * 0.7 : 0,
          colorDrift:     amp * 0.6 + Math.sin(phase * 6.28) * 0.2,
          channelSwap:    hit ? Math.floor(rand * 5) : 0,
          feedback:       amp * 0.4,
          linesSkip:      hit ? cbAmp * 0.3 : 0,
          shockwave:      hit ? cbAmp * 0.5 : 0,
          staticBurst:    hit ? rand * cbFade * 0.6 : 0,
          ruttEtra:       hit ? cbAmp * 0.5 : amp * 0.05,
          vCollapse:      hit ? cbAmp * 0.3 : 0,
          sCurve:         amp * 0.4 + Math.sin(phase * 3.14) * 0.2,
          emi:            hit ? cbAmp * 0.6 : amp * 0.05,
          humBar:         amp * 0.3,
          zoomBlur:       hit ? cbAmp * 0.4 : 0,
          lumaDisplace:   hit ? cbAmp * 0.5 : amp * 0.03,
          noiseDisplace:  hit ? cbAmp * 0.4 : 0,
          ghosting:       amp * 0.6 + (hit ? cbFade * 0.3 : 0),
          tapeWow:        hit ? cbAmp * 0.5 : amp * 0.1,
          tapeFlutter:    hit ? cbAmp * 0.6 : amp * 0.05,
          headClog:       hit ? cbAmp * 0.4 : 0,
          vhsPause:       hit && rand > 0.8 ? cbAmp * 0.5 : 0,
          colorFade:      amp * 0.3,
          chromaLoss:     hit ? cbAmp * 0.4 : 0,
          gateWeave:      amp * 0.2,
          scanRainbow:    hit ? cbAmp * 0.3 : 0,
          edgeGlow:       hit ? cbAmp * 0.2 : 0,
          bayerDither:    hit ? cbAmp * 0.4 : 0,
          ringing:        hit ? cbAmp * 0.4 : amp * 0.05,
          interlace:      amp * 0.4,
          cornerPurity:   amp * 0.25,
          degauss:        hit && rand > 0.85 ? cbAmp * 0.6 : 0,
        };
        for (const k in cbVals) CRT.setParam(k, cbVals[k]);
        if (_loopFrame % 6 === 0) syncCRTSliders();
      }
      // Channel switch override (takes priority over amp glitch)
      updateChannelSwitch();
      const glitchRatio = gv('cGlitchRatio') / 100;
      const isCleanFrame = !_chSwitchActive && Math.random() >= glitchRatio;
      if (isCleanFrame) {
        // Zero glitch params, keep CRT aesthetic (scanlines, bloom, etc)
        for (let i = 0; i < _glitchKeys.length; i++) CRT.setParam(_glitchKeys[i], 0);
      }
      try { CRT.render(oc, CRT_W, CRT_H); } catch(e) { console.warn('[crt] render error:', e); }
      if (isCleanFrame) {
        // Restore glitch params for next frame
        for (let i = 0; i < _glitchKeys.length; i++) CRT.setParam(_glitchKeys[i], _glitchSaved[i]);
      } else {
        // Save current glitch params for restore on clean frames
        for (let i = 0; i < _glitchKeys.length; i++) _glitchSaved[i] = CRT.getParam(_glitchKeys[i]);
      }
    } else if(currentTab==='scrub') {
      vid.style.visibility = 'visible';
      vid.style.opacity = '1';
      g('crtCanvas').style.display = 'none';
    }

    // Depth composite (only if on that tab)
    if(currentTab==='depth'&&(dBgReady||dOvReady||dOv2Ready)) drawDepthFrame();

    // Layers tab (only if on that tab)
    if(currentTab==='layers'&&lyLayers.length) lyDrawPreview();

    // Timeline (throttled)
    if(beatCount%3===0){drawAudioTL();drawVideoTL();}
  }
  loop();
}

// ─── CHANNEL SWITCH EFFECT ──────────────────────────────────────────────────
// Authentic TV channel-change: static burst → clip swap at peak → signal lock
// Ported from crt-player by John Hargreaves

function playChannelSwitchSound(duration = 0.8) {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const dur = Math.max(0.3, duration);
  const sr = audioCtx.sampleRate;

  // FM-demodulated noise (slightly blue/high-frequency biased)
  const buf = audioCtx.createBuffer(1, sr * dur, sr);
  const d = buf.getChannelData(0);
  let prev = 0;
  for (let i = 0; i < d.length; i++) {
    const white = Math.random() * 2 - 1;
    prev = prev * 0.3 + white * 0.7;
    d[i] = white * 0.6 + (white - prev) * 0.4;
  }
  const src = audioCtx.createBufferSource();
  src.buffer = buf;

  // TV speaker bandwidth: 80Hz–9kHz with 3kHz resonance peak
  const hp = audioCtx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 80;
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 9000;
  const peak = audioCtx.createBiquadFilter();
  peak.type = 'peaking'; peak.frequency.value = 3000; peak.Q.value = 1.0; peak.gain.value = 4;

  // Envelope: instant attack, hold during static, quick fade as signal locks
  const gain = audioCtx.createGain();
  const vol = gainNode ? gainNode.gain.value : 0.5;
  const attackEnd = now + 0.01;
  const holdEnd = now + dur * 0.5;
  const fadeEnd = now + dur * 0.85;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(vol * 0.12, attackEnd);
  gain.gain.setValueAtTime(vol * 0.1, attackEnd + 0.01);
  gain.gain.setValueAtTime(vol * 0.1, holdEnd);
  gain.gain.exponentialRampToValueAtTime(0.001, fadeEnd);
  gain.gain.setValueAtTime(0, fadeEnd + 0.01);

  src.connect(hp); hp.connect(lp); lp.connect(peak); peak.connect(gain);
  gain.connect(audioCtx.destination);
  src.start(now); src.stop(now + dur);

  // Mains hum (60Hz sawtooth)
  const humOsc = audioCtx.createOscillator();
  humOsc.type = 'sawtooth'; humOsc.frequency.value = 60;
  const humGain = audioCtx.createGain();
  humGain.gain.setValueAtTime(0, now);
  humGain.gain.linearRampToValueAtTime(vol * 0.008, attackEnd);
  humGain.gain.setValueAtTime(vol * 0.006, holdEnd);
  humGain.gain.exponentialRampToValueAtTime(0.0001, fadeEnd);
  humOsc.connect(humGain); humGain.connect(audioCtx.destination);
  humOsc.start(now); humOsc.stop(now + dur);

  // Tuner relay click at start
  const clickBuf = audioCtx.createBuffer(1, Math.floor(sr * 0.005), sr);
  const cd = clickBuf.getChannelData(0);
  for (let i = 0; i < cd.length; i++) cd[i] = (i < 3 ? 0.8 : -0.3) * Math.exp(-i / (sr * 0.001));
  const clickSrc = audioCtx.createBufferSource(); clickSrc.buffer = clickBuf;
  const clickGain = audioCtx.createGain(); clickGain.gain.value = vol * 0.15;
  clickSrc.connect(clickGain); clickGain.connect(audioCtx.destination);
  clickSrc.start(now);

  setTimeout(() => {
    try { gain.disconnect(); lp.disconnect(); hp.disconnect(); peak.disconnect(); } catch {}
    try { humGain.disconnect(); } catch {}
    try { clickGain.disconnect(); } catch {}
  }, (dur + 0.2) * 1000);
}

function triggerChannelSwitch(durationMs = 1000) {
  _chSwitchActive = true;
  _chSwitchStart = performance.now();
  _chSwitchDuration = durationMs;
  _chSwitchProgress = 0;
  _chSwitchClipPending = true;
  playChannelSwitchSound(durationMs / 1000);
}

// Called each frame from render loop — overrides CRT params during switch
function updateChannelSwitch() {
  if (!_chSwitchActive) return;
  const elapsed = performance.now() - _chSwitchStart;
  const t = Math.min(elapsed / _chSwitchDuration, 1);
  _chSwitchProgress = t;

  // Swap clip at peak static (40% through)
  if (_chSwitchClipPending && t >= 0.4) {
    _chSwitchClipPending = false;
    if (clipPool.length > 1) pickRandomClip();
  }

  // Three-phase CRT override:
  // Phase 1 (0–0.4): full static burst — PLL retuning
  // Phase 2 (0.4–0.7): static fading, image emerging with sync issues
  // Phase 3 (0.7–1.0): AGC settling, color lock stabilizing
  let staticEnv, rollAmt, syncErr, monoFlash, agcBright;
  if (t < 0.15) {
    // Fast attack
    staticEnv = t / 0.15;
  } else if (t < 0.4) {
    // Full static hold
    staticEnv = 1.0;
  } else if (t < 0.75) {
    // Decay
    staticEnv = 1.0 - (t - 0.4) / 0.35;
  } else {
    staticEnv = 0;
  }
  rollAmt = t < 0.4 ? t * 2.5 : Math.max(0, (0.7 - t) * 3.3);
  syncErr = t < 0.5 ? t * 2 : Math.max(0, (0.8 - t) * 3.3);
  monoFlash = (t > 0.3 && t < 0.8) ? Math.sin((t - 0.3) * 6.28) * 0.5 + 0.5 : 0;
  agcBright = (t > 0.6 && t < 0.9) ? 1.0 + Math.sin((t - 0.6) * 50) * 0.15 * (0.9 - t) / 0.3 : 1.0;

  const csVals = {
    staticBurst:   staticEnv * 0.9,
    noise:         staticEnv * 0.25,
    rollSpeed:     rollAmt * 0.6,
    rollLine:      rollAmt > 0.1 ? 0.5 : 0,
    vSyncWobble:   syncErr * 0.7,
    hSyncLoss:     syncErr * 0.5,
    jitter:        staticEnv * 0.6,
    chromatic:     staticEnv * 4 + syncErr * 2,
    rgbShift:      staticEnv * 3,
    distortion:    staticEnv * 2,
    distortion2:   staticEnv * 1.5,
    glitchIntensity: staticEnv * 0.6,
    glitchSpeed:   2 + staticEnv * 3,
    screenTear:    syncErr * 0.5,
    colorBleed:    staticEnv * 0.4,
    humBar:        staticEnv * 0.5,
    saturation:    1.0 - monoFlash * 0.8,
    brightness:    agcBright,
    flicker:       staticEnv * 0.08,
    feedback:      staticEnv * 0.3,
    dataBend:      staticEnv * 0.3,
    pixelStretch:  staticEnv * 0.4,
  };
  for (const k in csVals) CRT.setParam(k, csVals[k]);

  if (t >= 1) {
    _chSwitchActive = false;
    _chSwitchProgress = 0;
    // Restore preset values for all overridden keys
    CRT.restorePresetParams(Object.keys(csVals));
    syncCRTSliders();
  }
}

// ─── CLIP POOL ──────────────────────────────────────────────────────────────
let serverAvailable = null;

async function checkServer() {
  if (serverAvailable !== null) return serverAvailable;
  try {
    const r = await fetch('/preprocess', { method: 'HEAD' });
    serverAvailable = r.status !== 404;
  } catch(e) { serverAvailable = false; }
  return serverAvailable;
}

async function handleVideoFiles(input) {
  const files = Array.from(input.files);
  input.value = '';
  for (const f of files) {
    const url = URL.createObjectURL(f);
    clipPool.push({ name: f.name.replace(/\.[^.]+$/,''), file: f, url, cleaned: false, cleanedUrl: null });
  }
  renderClipList();
  if (activeClipIdx === -1 && clipPool.length) activateClip(0);
  if (clipPool.length) g('batchCleanBtn').style.display = '';
}

function activateClip(idx) {
  if (idx < 0 || idx >= clipPool.length) return;
  activeClipIdx = idx;
  const clip = clipPool[idx];
  const url = clip.cleanedUrl || clip.url;
  vid.src = url; vid.muted = true; vid.load();
  vid.onloadedmetadata = () => {
    // Auto-unlock: play then immediately pause to enable seeking
    vid.play().then(() => {
      vid.pause(); vid.currentTime = 0;
      videoUnlocked = true;
      g('unlockOverlay').style.display = 'none';
    }).catch(() => {
      // Fallback: show manual unlock if autoplay blocked
      g('unlockOverlay').style.display = 'flex';
      videoUnlocked = false;
    });
  };
  renderClipList();
}

function removeClip(idx) {
  if (clipPool[idx].url) URL.revokeObjectURL(clipPool[idx].url);
  if (clipPool[idx].cleanedUrl) URL.revokeObjectURL(clipPool[idx].cleanedUrl);
  clipPool.splice(idx, 1);
  if (activeClipIdx === idx) {
    activeClipIdx = clipPool.length ? 0 : -1;
    if (activeClipIdx >= 0) activateClip(0);
  } else if (activeClipIdx > idx) {
    activeClipIdx--;
  }
  renderClipList();
}

function pickRandomClip() {
  if (clipPool.length === 0) return;
  if (clipPool.length === 1) { activateClip(0); return; }
  let idx;
  do { idx = Math.floor(Math.random() * clipPool.length); } while (idx === lastClipIdx);
  lastClipIdx = idx;
  activateClip(idx);
}

function renderClipList() {
  const list = g('clipList');
  g('clipCount').textContent = clipPool.length ? clipPool.length + ' clip' + (clipPool.length > 1 ? 's' : '') : '';
  const hasUncleaned = clipPool.some(c => !c.cleaned);
  const hint = g('cleanHint');
  if (hint) hint.style.display = (clipPool.length && hasUncleaned) ? 'block' : 'none';
  if (!clipPool.length) { list.innerHTML = ''; return; }
  list.innerHTML = clipPool.map((c, i) => `
    <div class="clip-item ${i === activeClipIdx ? 'active' : ''}" data-idx="${i}">
      <span class="clip-name">${c.name}</span>
      <span class="clip-status ${c.cleaned ? 'cleaned' : ''}">${c.cleaned ? 'cleaned' : 'raw'}</span>
      <span class="clip-remove" data-remove="${i}">&times;</span>
    </div>
  `).join('');
  list.querySelectorAll('.clip-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.dataset.remove !== undefined) return;
      activateClip(parseInt(el.dataset.idx));
    });
  });
  list.querySelectorAll('.clip-remove').forEach(el => {
    el.addEventListener('click', () => removeClip(parseInt(el.dataset.remove)));
  });
}

// ─── Batch clean ────────────────────────────────────────────────────────────
let ffmpegInstance = null;
let ffmpegLoaded = false;

async function batchClean() {
  const btn = g('batchCleanBtn');
  btn.classList.add('disabled');
  const uncleaned = clipPool.filter(c => !c.cleaned);
  if (!uncleaned.length) { btn.classList.remove('disabled'); return; }

  const hasServer = await checkServer();
  g('processBox').style.display = 'block';

  for (let i = 0; i < clipPool.length; i++) {
    if (clipPool[i].cleaned) continue;
    const total = clipPool.length;
    const num = i + 1;
    g('processStatus').textContent = `cleaning ${num}/${total}: ${clipPool[i].name}`;
    g('processProgress').style.width = Math.round((i / total) * 100) + '%';
    g('processProgress').style.background = '#60a5fa';
    try {
      let url;
      if (hasServer) {
        url = await cleanOneClipServer(clipPool[i].file);
      } else {
        url = await cleanOneClipWasm(clipPool[i].file, num, total);
      }
      clipPool[i].cleanedUrl = url;
      clipPool[i].cleaned = true;
      if (i === activeClipIdx) activateClip(i);
      renderClipList();
    } catch(e) {
      console.warn('clean failed for', clipPool[i].name, e);
      g('processStatus').textContent = `failed: ${clipPool[i].name} — ${e.message}`;
    }
  }
  g('processProgress').style.width = '100%';
  g('processProgress').style.background = '#4ade80';
  g('processStatus').textContent = 'all clips cleaned';
  btn.classList.remove('disabled');
}

async function cleanOneClipServer(file) {
  const formData = new FormData();
  formData.append('file', file);
  const resp = await fetch('/preprocess', { method: 'POST', body: formData });
  if (!resp.ok) throw new Error('server returned ' + resp.status);
  const { job_id } = await resp.json();

  await new Promise((resolve, reject) => {
    const es = new EventSource(`/preprocess/${job_id}/stream`);
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.status === 'done') { es.close(); resolve(); }
      else if (data.status === 'error') { es.close(); reject(new Error(data.error)); }
    };
    es.onerror = () => { es.close(); reject(new Error('SSE lost')); };
  });

  const dlResp = await fetch(`/preprocess/${job_id}/download`);
  if (!dlResp.ok) throw new Error('download failed');
  const blob = await dlResp.blob();
  return URL.createObjectURL(blob);
}

async function ensureFFmpeg() {
  if (ffmpegLoaded) return;
  const { FFmpeg } = FFmpegWASM;

  if (!ffmpegInstance) {
    ffmpegInstance = new FFmpeg();
    ffmpegInstance.on('progress', ({ progress }) => {
      g('processProgress').style.width = Math.round(10 + progress * 85) + '%';
    });
  }

  g('processStatus').textContent = 'loading ffmpeg (first time ~30MB)...';
  g('processProgress').style.width = '5%';

  // Convert cross-origin core files to blob URLs (same-origin Workers)
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.4/dist/umd';
  const coreJS = await fetch(baseURL + '/ffmpeg-core.js').then(r => r.blob()).then(b => URL.createObjectURL(b));
  const coreWasm = await fetch(baseURL + '/ffmpeg-core.wasm').then(r => r.blob()).then(b => URL.createObjectURL(b));

  await ffmpegInstance.load({ coreURL: coreJS, wasmURL: coreWasm });
  ffmpegLoaded = true;
}

async function cleanOneClipWasm(file, num, total) {
  await ensureFFmpeg();
  const { fetchFile } = FFmpegUtil;

  g('processStatus').textContent = `cleaning ${num}/${total}: ${file.name} (wasm)`;
  g('processProgress').style.width = '10%';

  const inputName = 'input.' + (file.name.split('.').pop() || 'mp4');
  const outputName = 'cleaned.mp4';

  await ffmpegInstance.writeFile(inputName, await fetchFile(file));

  await ffmpegInstance.exec([
    '-i', inputName,
    '-vf', 'fps=30',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '18',
    '-g', '1',
    '-keyint_min', '1',
    '-an',
    outputName
  ]);

  const data = await ffmpegInstance.readFile(outputName);
  const blob = new Blob([data.buffer], { type: 'video/mp4' });

  // Clean up temp files
  try { await ffmpegInstance.deleteFile(inputName); } catch(e) {}
  try { await ffmpegInstance.deleteFile(outputName); } catch(e) {}

  return URL.createObjectURL(blob);
}

// ─── LAYERS TAB (daisy) ──────────────────────────────────────────────────────
const lyCanvas = document.getElementById('lyPreview');
const lyCtx = lyCanvas.getContext('2d');
let lyLayers = [];
let lyDragSrc = null;

function lyAddImages(input) {
  const files = Array.from(input.files);
  files.forEach(f => {
    const img = new Image();
    const url = URL.createObjectURL(f);
    img.onload = () => {
      lyLayers.push({ img, name: f.name.replace(/\.[^.]+$/, ''), reactive: true, url });
      lyRenderLayerList();
      lyDrawPreview();
      if(!animFrame && analyser) startLoop();
    };
    img.src = url;
  });
  input.value = '';
}

function lyRenderLayerList() {
  const list = g('lyLayerList');
  if (!lyLayers.length) { list.innerHTML = '<div class="ly-empty-state">no layers yet</div>'; return; }
  list.innerHTML = '';
  [...lyLayers].reverse().forEach((l, ri) => {
    const i = lyLayers.length - 1 - ri;
    const div = document.createElement('div');
    div.className = 'ly-layer-item';
    div.draggable = true;
    div.dataset.idx = i;
    div.innerHTML = `
      <span class="ly-drag-handle">&#8942;&#8942;</span>
      <img class="ly-layer-thumb" src="${l.url}">
      <span class="ly-layer-name">${l.name}</span>
      <button class="ly-toggle-btn ${l.reactive ? 'on' : 'off'}" onclick="lyToggleReactive(${i})" title="${l.reactive ? 'reactive' : 'static'}"></button>
    `;
    div.addEventListener('dragstart', () => { lyDragSrc = i; div.classList.add('dragging'); });
    div.addEventListener('dragend', () => div.classList.remove('dragging'));
    div.addEventListener('dragover', e => { e.preventDefault(); div.classList.add('drag-over'); });
    div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
    div.addEventListener('drop', e => {
      e.preventDefault();
      div.classList.remove('drag-over');
      if (lyDragSrc !== null && lyDragSrc !== i) {
        const tmp = lyLayers[lyDragSrc]; lyLayers[lyDragSrc] = lyLayers[i]; lyLayers[i] = tmp;
        lyDragSrc = null; lyRenderLayerList(); lyDrawPreview();
      }
    });
    list.appendChild(div);
  });
}

function lyToggleReactive(i) {
  lyLayers[i].reactive = !lyLayers[i].reactive;
  lyRenderLayerList();
}

function lyDrawPreview() {
  const W = lyCanvas.width, H = lyCanvas.height;
  lyCtx.clearRect(0, 0, W, H);
  lyCtx.fillStyle = '#1a1a1a';
  lyCtx.fillRect(0, 0, W, H);
  const sens = gv('lySens');
  const thresh = gv('lyThresh');
  const dir = gv('lyDir');
  const stag = gv('lyStag');
  lyLayers.forEach((l, i) => {
    if (!l.reactive) { lyDrawLayer(l, 1); return; }
    const offset = i * stag;
    const effectiveAmp = envelopeAmp * sens;
    const triggered = effectiveAmp > (thresh + offset);
    const visible = dir > 0 ? triggered : !triggered;
    lyDrawLayer(l, visible ? 1 : 0);
  });
}

function lyDrawLayer(l, opacity) {
  if (opacity === 0) return;
  lyCtx.globalAlpha = opacity;
  const ar = l.img.width / l.img.height;
  const car = lyCanvas.width / lyCanvas.height;
  let dx, dy, dw, dh;
  if (ar > car) { dh = lyCanvas.height; dw = dh * ar; dx = (lyCanvas.width - dw) / 2; dy = 0; }
  else { dw = lyCanvas.width; dh = dw / ar; dx = 0; dy = (lyCanvas.height - dh) / 2; }
  lyCtx.drawImage(l.img, dx, dy, dw, dh);
  lyCtx.globalAlpha = 1;
}

// ─── EVENT BINDING ───────────────────────────────────────────────────────────
// Helper: button triggers hidden file input
function bindFileBtn(btnId, inputId) { g(btnId).addEventListener('click', ()=>g(inputId).click()); }
// Helper: slider auto-update display
function bindSlider(sliderId, displayId, fmt) {
  g(sliderId).addEventListener('input', ()=>updateSlider(sliderId, displayId, fmt));
}

// Top bar
g('fullscreenBtn').addEventListener('click', toggleFullscreen);
g('hideBtn').addEventListener('click', toggleSidebar);

// Tabs
document.querySelectorAll('[data-tab]').forEach(el=>{
  el.addEventListener('click', ()=>switchTab(el.dataset.tab));
});

// ─── Scrub tab ───
g('unlockBtn').addEventListener('click', unlockVideo);
bindFileBtn('vidBtn','vidInput');
g('vidInput').addEventListener('change', function(){ handleVideoFiles(this); });
g('batchCleanBtn').addEventListener('click', batchClean);

bindFileBtn('audioBtn','audioInput');
g('audioInput').addEventListener('change', function(){ loadAudio(this); });
g('playBtn').addEventListener('click', togglePlay);
g('micBtn').addEventListener('click', toggleMic);
g('sysBtn').addEventListener('click', toggleSysAudio);
bindSlider('sVolume','vVolume',v=>Math.round(v)+'%');
g('sVolume').addEventListener('input', function(){ setVolume(this.value); });

bindSlider('sBeatSync','vBeatSync');

// Frequency filter buttons
g('filterRow').addEventListener('click', e=>{
  const btn=e.target.closest('[data-filter]');
  if(btn) setFilter(btn.dataset.filter);
});

// Signal sliders
bindSlider('sGain','vGain');
bindSlider('sGate','vGate');
bindSlider('sComp','vComp');
bindSlider('sAttack','vAttack');
bindSlider('sRelease','vRelease');

// Mode buttons
g('modeRow').addEventListener('click', e=>{
  const btn=e.target.closest('[data-mode]');
  if(btn) setMode(btn.dataset.mode);
});

// Video range
bindSlider('sVidStart','vVidStart',v=>v+'%');
bindSlider('sVidEnd','vVidEnd',v=>v+'%');

// Keep alive
bindSlider('sAlive','vAlive');
bindSlider('sLFO','vLFO');
bindSlider('sLFODepth','vLFODepth');
bindSlider('sDrift','vDrift');
bindSlider('sStuck','vStuck',v=>v+'s');

// Bake
g('bakeBtn').addEventListener('click', startBake);
g('stopBakeBtn').addEventListener('click', stopBake);

// ─── Depth tab ───
bindFileBtn('dAudioBtn','dAudioInput');
g('dAudioInput').addEventListener('change', function(){ loadAudio2(this); });
g('dPlayBtn').addEventListener('click', togglePlay);
g('dMicBtn').addEventListener('click', toggleMic);
g('dSysBtn').addEventListener('click', toggleSysAudio);

// Depth video uploads
bindFileBtn('dBgBtn','dBgInput');
g('dBgInput').addEventListener('change', function(){ loadDepthVid('bg',this); });
bindFileBtn('dOverlayBtn','dOverlayInput');
g('dOverlayInput').addEventListener('change', function(){ loadDepthVid('overlay',this); });
bindFileBtn('dDepthBtn','dDepthInput');
g('dDepthInput').addEventListener('change', function(){ loadDepthVid('depth',this); });
bindFileBtn('dOverlay2Btn','dOverlay2Input');
g('dOverlay2Input').addEventListener('change', function(){ loadDepthVid('overlay2',this); });
bindFileBtn('dDepth2Btn','dDepth2Input');
g('dDepth2Input').addEventListener('change', function(){ loadDepthVid('depth2',this); });

g('dUnlockBtn').addEventListener('click', unlockDepthVids);

// Depth 1 controls
bindSlider('dThresh','vThresh');
bindSlider('dFeather','vFeather');
bindSlider('dMix','vMix');
bindSlider('dAudioDrive','vAudioDrive');
g('depthDirRow').addEventListener('click', e=>{
  const btn=e.target.closest('[data-dir]');
  if(btn) setDepthDir(btn.dataset.dir);
});

// Depth 2 controls
bindSlider('d2Thresh','v2Thresh');
bindSlider('d2Feather','v2Feather');
bindSlider('d2Mix','v2Mix');
bindSlider('d2AudioDrive','v2AudioDrive');
g('depthDir2Row').addEventListener('click', e=>{
  const btn=e.target.closest('[data-dir2]');
  if(btn) setDepthDir2(btn.dataset.dir2);
});

// Depth scrub ranges
bindSlider('dBgRange','vBgRange',v=>v+'%');
bindSlider('dOvRange','vOvRange',v=>v+'%');
bindSlider('dOv2Range','vOv2Range',v=>v+'%');

// Depth bake
g('dBakeBtn').addEventListener('click', startDepthBake);
g('dStopBakeBtn').addEventListener('click', stopDepthBake);

// ─── Layers tab ───
bindFileBtn('lyImgBtn','lyImgInput');
g('lyImgInput').addEventListener('change', function(){ lyAddImages(this); });
bindFileBtn('lyAudioBtn','lyAudioInput');
g('lyAudioInput').addEventListener('change', function(){ loadAudio(this); });
g('lyPlayBtn').addEventListener('click', togglePlay);
g('lyMicBtn').addEventListener('click', toggleMic);
g('lySysBtn').addEventListener('click', toggleSysAudio);
bindSlider('lySens','vLySens');
bindSlider('lyThresh','vLyThresh');
bindSlider('lyDir','vLyDir',v=>v>0?'loud=show':'loud=hide');
bindSlider('lyStag','vLyStag');

// ─── Update setFilter/setMode to use data attributes ─────────────────────────
// Override to work with data-attribute buttons instead of ID-based
const _origSetFilter = setFilter;
setFilter = function(f) {
  currentFilter=f;
  document.querySelectorAll('#filterRow [data-filter]').forEach(b=>b.classList.toggle('active',b.dataset.filter===f));
};

const _origSetMode = setMode;
setMode = function(m) {
  currentMode=m;
  document.querySelectorAll('#modeRow [data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===m));
  const d={scrub:'amplitude → position. quiet=start, loud=end.',pingpong:'drives forward, silence reverses.',freeze:'loud=advance. quiet=hold.'};
  g('modeDesc').textContent=d[m];
};

// Override depth dir setters for data-attribute buttons
setDepthDir = function(d) {
  depthDir=d;
  document.querySelectorAll('#depthDirRow [data-dir]').forEach(b=>b.classList.toggle('active',b.dataset.dir===d));
};
setDepthDir2 = function(d) {
  depthDir2=d;
  document.querySelectorAll('#depthDir2Row [data-dir2]').forEach(b=>b.classList.toggle('active',b.dataset.dir2===d));
};

// ─── SPOTIFY ────────────────────────────────────────────────────────────────
const SPOTIFY_CLIENT_ID = 'a8a5fb0a10df43958dd52137e4051344';
const SPOTIFY_REDIRECT = window.location.origin + '/callback';
const SPOTIFY_SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state user-read-recently-played';

let spotifyToken = localStorage.getItem('spotify_token');
let spotifyExpires = parseInt(localStorage.getItem('spotify_expires') || '0');
let spotifyPoller = null;
let spotifyCurrentTrackId = null;
let spotifyFeatures = null;
let spotifyIsPlaying = false;
let spotifyProgressMs = 0;
let spotifyDurationMs = 0;

// PKCE helpers
function generateRandomString(len) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('').slice(0, len);
}

async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function spotifyAuth() {
  const verifier = generateRandomString(64);
  const challenge = await generateCodeChallenge(verifier);
  localStorage.setItem('spotify_verifier', verifier);

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: SPOTIFY_REDIRECT,
    scope: SPOTIFY_SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge
  });
  window.location.href = 'https://accounts.spotify.com/authorize?' + params.toString();
}

function spotifyLogout() {
  localStorage.removeItem('spotify_token');
  localStorage.removeItem('spotify_expires');
  spotifyToken = null;
  spotifyExpires = 0;
  spotifyCurrentTrackId = null;
  spotifyFeatures = null;
  if (spotifyPoller) { clearInterval(spotifyPoller); spotifyPoller = null; }
  updateSpotifyUI(null);
}

function isSpotifyConnected() {
  return spotifyToken && Date.now() < spotifyExpires;
}

let _refreshLock = null;
async function refreshSpotifyToken() {
  if (_refreshLock) return _refreshLock;
  _refreshLock = _doRefreshToken();
  const result = await _refreshLock;
  _refreshLock = null;
  return result;
}
async function _doRefreshToken() {
  const refresh = localStorage.getItem('spotify_refresh');
  if (!refresh) return false;
  try {
    const resp = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: SPOTIFY_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refresh
      })
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    spotifyToken = data.access_token;
    spotifyExpires = Date.now() + (data.expires_in || 3600) * 1000;
    localStorage.setItem('spotify_token', spotifyToken);
    localStorage.setItem('spotify_expires', spotifyExpires.toString());
    if (data.refresh_token) localStorage.setItem('spotify_refresh', data.refresh_token);
    return true;
  } catch(e) { return false; }
}

async function spotifyFetch(endpoint) {
  if (!isSpotifyConnected()) {
    const refreshed = await refreshSpotifyToken();
    if (!refreshed) return null;
  }
  const resp = await fetch('https://api.spotify.com/v1' + endpoint, {
    headers: { 'Authorization': 'Bearer ' + spotifyToken }
  });
  if (resp.status === 401) {
    const refreshed = await refreshSpotifyToken();
    if (refreshed) return spotifyFetch(endpoint);
    spotifyLogout(); return null;
  }
  if (resp.status === 204 || resp.status === 403) return null;
  if (!resp.ok) return null;
  return resp.json();
}

async function pollNowPlaying() {
  const data = await spotifyFetch('/me/player/currently-playing');
  if (!data || !data.item) {
    updateSpotifyUI(null);
    return;
  }

  const track = data.item;
  const trackId = track.id;
  const changed = trackId !== spotifyCurrentTrackId;
  spotifyIsPlaying = data.is_playing || false;
  spotifyProgressMs = data.progress_ms || 0;
  spotifyDurationMs = track.duration_ms || 0;

  if (changed) {
    spotifyCurrentTrackId = trackId;
    onTrackChange(track, null);
  }

  updateSpotifyUI(track);
}

let _ltTimer = null;
let _ltMode = 'none'; // none, slide, on
let _ltLang = 'english'; // english, greek
let _ltLastTrack = null;

// Fake Greek fallback (Latin → Greek lookalikes)
const _fakeGreek = {A:'Α',B:'Β',C:'Ψ',D:'Δ',E:'Ε',F:'Φ',G:'Γ',H:'Η',I:'Ι',J:'Ξ',K:'Κ',L:'Λ',M:'Μ',N:'Ν',O:'Ο',P:'Π',Q:'Θ',R:'Ρ',S:'Σ',T:'Τ',U:'Υ',V:'Β',W:'Ω',X:'Χ',Y:'Ψ',Z:'Ζ',
  a:'α',b:'β',c:'ψ',d:'δ',e:'ε',f:'φ',g:'γ',h:'η',i:'ι',j:'ξ',k:'κ',l:'λ',m:'μ',n:'ν',o:'ο',p:'π',q:'θ',r:'ρ',s:'σ',t:'τ',u:'υ',v:'β',w:'ω',x:'χ',y:'ψ',z:'ζ'};
function fakeGreek(str) { return str.split('').map(c => _fakeGreek[c] || c).join(''); }

// Google Translate free endpoint, fake Greek fallback
let _translateCache = {};
async function translateToGreek(text) {
  if (!text) return text;
  if (_translateCache[text]) return _translateCache[text];
  try {
    const resp = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=el&dt=t&q=' + encodeURIComponent(text));
    const data = await resp.json();
    const result = data[0].map(s => s[0]).join('');
    _translateCache[text] = result;
    return result;
  } catch(e) { return fakeGreek(text); }
}

document.querySelectorAll('[data-ltmode]').forEach(btn => {
  btn.addEventListener('click', function() {
    _ltMode = this.dataset.ltmode;
    document.querySelectorAll('[data-ltmode]').forEach(b => b.classList.toggle('active', b.dataset.ltmode === _ltMode));
    if (_ltMode === 'none') { g('lowerThird').style.display = 'none'; if(_ltTimer) clearTimeout(_ltTimer); }
    if (_ltMode !== 'none' && _ltLastTrack) showLowerThird(_ltLastTrack);
  });
});
document.querySelectorAll('[data-ltlang]').forEach(btn => {
  btn.addEventListener('click', function() {
    _ltLang = this.dataset.ltlang;
    document.querySelectorAll('[data-ltlang]').forEach(b => b.classList.toggle('active', b.dataset.ltlang === _ltLang));
    if (_ltMode !== 'none' && _ltLastTrack) showLowerThird(_ltLastTrack);
  });
});

async function showLowerThird(track) {
  if (!track || _ltMode === 'none') return;
  _ltLastTrack = track;
  const lt = g('lowerThird');
  const art = g('ltArt');
  const song = g('ltSong');
  const artist = g('ltArtist');
  const album = g('ltAlbum');
  const songText = track.name || '';
  const artistText = track.artists ? track.artists.map(a => a.name).join(', ') : '';
  const albumText = (track.album && track.album.name) ? track.album.name : '';
  if (_ltLang === 'greek') {
    const translatedSong = await translateToGreek(songText);
    song.textContent = '\u201C' + ((translatedSong === songText) ? fakeGreek(songText) : translatedSong) + '\u201D';
    const translatedArtist = await translateToGreek(artistText);
    // If Google Translate returned proper nouns unchanged, force transliteration
    artist.textContent = (translatedArtist === artistText) ? fakeGreek(artistText) : translatedArtist;
    if (albumText) {
      const translatedAlbum = await translateToGreek(albumText);
      album.textContent = (translatedAlbum === albumText) ? fakeGreek(albumText) : translatedAlbum;
    }
  } else {
    song.textContent = '\u201C' + songText + '\u201D';
    artist.textContent = artistText;
    album.textContent = albumText;
  }
  if (track.album && track.album.images && track.album.images.length) {
    art.src = (track.album.images[1] || track.album.images[0]).url;
    art.style.display = 'block';
  } else { art.style.display = 'none'; }
  lt.classList.remove('lt-out');
  lt.style.display = 'flex';
  const dog = document.querySelector('.channel-dog');
  if (dog) dog.classList.add('dog-visible');
  if (_ltTimer) clearTimeout(_ltTimer);
  if (_ltMode === 'slide') {
    _ltTimer = setTimeout(() => {
      lt.classList.add('lt-out');
      if (dog) dog.classList.remove('dog-visible');
      setTimeout(() => { lt.style.display = 'none'; }, 600);
    }, 8000);
  }
  // 'on' stays visible permanently
}

function onTrackChange(track, features) {
  // Channel switch effect — clip swap happens at peak static (40% through)
  if (CRT.isEnabled() && clipPool.length > 1) {
    triggerChannelSwitch(1000);
  } else if (clipPool.length > 1) {
    pickRandomClip();
  }
  // Show lower third (after brief delay so it appears with new clip)
  setTimeout(() => showLowerThird(track), CRT.isEnabled() ? 450 : 0);

  if (!features) return;

  // Apply BPM from Spotify if beat tracker hasn't locked
  if (features.tempo && !btInitialized) {
    const bpm = Math.round(features.tempo);
    beatInterval = 60000 / bpm;
    g('btBPM').textContent = bpm;
    g('btStatus').textContent = 'spotify';
    g('btStatus').style.color = '#1db954';
  }

  // Show energy/valence as hints
  const energy = Math.round((features.energy || 0) * 100);
  const valence = Math.round((features.valence || 0) * 100);
  const el = g('spFeatures');
  if (el) el.textContent = 'energy ' + energy + '% · valence ' + valence + '%';
}

function updateSpotifyUI(track) {
  const btn = g('spConnectBtn');
  const info = g('spTrackInfo');
  const art = g('spArt');
  const infoRow = g('spInfo');
  const hint = g('spHint');
  const controls = g('spControls');
  const progFill = g('spProgFill');
  const progTime = g('spProgTime');

  if (!isSpotifyConnected()) {
    btn.textContent = 'connect spotify';
    btn.classList.remove('sp-connected');
    if (infoRow) infoRow.style.display = 'none';
    if (hint) hint.style.display = 'none';
    if (controls) controls.style.display = 'none';
    if (g('spFeatures')) g('spFeatures').textContent = '';
    return;
  }

  btn.textContent = 'disconnect';
  btn.classList.add('sp-connected');
  if (hint) hint.style.display = 'block';
  if (controls) controls.style.display = 'flex';

  // Progress bar
  if (progFill && spotifyDurationMs > 0) {
    progFill.style.width = Math.round((spotifyProgressMs / spotifyDurationMs) * 100) + '%';
  }
  if (progTime) {
    progTime.textContent = fmtT(spotifyProgressMs / 1000) + ' / ' + fmtT(spotifyDurationMs / 1000);
  }

  if (track) {
    const artist = track.artists.map(a => a.name).join(', ');
    const name = track.name;
    if (infoRow) infoRow.style.display = 'flex';
    if (info) info.textContent = name + ' — ' + artist;
    if (art && track.album && track.album.images && track.album.images.length) {
      art.src = (track.album.images[1] || track.album.images[0]).url;
      art.style.display = 'block';
    }
  } else {
    if (infoRow) infoRow.style.display = 'flex';
    if (info) info.textContent = 'nothing playing';
    if (art) art.style.display = 'none';
  }
}

// ─── Spotify playback controls ──────────────────────────────────────────────
async function spotifyPut(endpoint) {
  if (!isSpotifyConnected()) return;
  await fetch('https://api.spotify.com/v1' + endpoint, {
    method: 'PUT', headers: { 'Authorization': 'Bearer ' + spotifyToken }
  });
  setTimeout(pollNowPlaying, 300);
}
async function spotifyPost(endpoint) {
  if (!isSpotifyConnected()) return;
  await fetch('https://api.spotify.com/v1' + endpoint, {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + spotifyToken }
  });
  setTimeout(pollNowPlaying, 300);
}

function spNext() { spotifyPost('/me/player/next'); }
function spPrev() { spotifyPost('/me/player/previous'); }

function startSpotifyPoller() {
  if (spotifyPoller) clearInterval(spotifyPoller);
  pollNowPlaying();
  spotifyPoller = setInterval(pollNowPlaying, 3000);
}

// Pause Spotify polling when tab backgrounded
document.addEventListener('visibilitychange', () => {
  if (document.hidden && spotifyPoller) {
    clearInterval(spotifyPoller); spotifyPoller = null;
  } else if (!document.hidden && isSpotifyConnected() && !spotifyPoller) {
    startSpotifyPoller();
  }
});

// Spotify UI binding
g('spConnectBtn').addEventListener('click', () => {
  if (isSpotifyConnected()) spotifyLogout();
  else spotifyAuth();
});
g('spPrevBtn').addEventListener('click', spPrev);
g('spNextBtn').addEventListener('click', spNext);

// ─── CRT ────────────────────────────────────────────────────────────────────
CRT.init(g('crtCanvas'));

const crtSliderMap = {
  cScanlines:   ['scanlines', 100],
  cCurvature:   ['curvature', 1],
  cChromatic:   ['chromatic', 10],
  cBloom:       ['bloom', 100],
  cNoise:       ['noise', 100],
  cVignette:    ['vignette', 100],
  cDistortion:  ['distortion', 10],
  cJitter:      ['jitter', 100],
  cGlitch:      ['glitchIntensity', 100],
  cRGBShift:    ['rgbShift', 10],
  cRoll:        ['rollSpeed', 100],
  cColorBleed:  ['colorBleed', 100],
  cSaturation:  ['saturation', 100],
  cClockSkew:   ['clockSkew', 100],
  cDataBend:    ['dataBend', 100],
  cBitCrush:    ['bitCrush', 100],
  cLineCorrupt: ['lineCorrupt', 100],
  cPixelStretch:['pixelStretch', 100],
  cColorDrift:  ['colorDrift', 100],
  cFeedback:    ['feedback', 100],
  cStaticBurst: ['staticBurst', 100],
  cShockwave:   ['shockwave', 100],
  cRuttEtra:    ['ruttEtra', 100],
  cZoomBlur:    ['zoomBlur', 100],
  cLumaDisplace:['lumaDisplace', 100],
  cNoiseDisplace:['noiseDisplace', 100],
  cVCollapse:   ['vCollapse', 100],
  cSCurve:      ['sCurve', 100],
  cEmi:         ['emi', 100],
  cHumBar:      ['humBar', 100],
  cGhosting:    ['ghosting', 100],
  cTapeWow:     ['tapeWow', 100],
  cTapeFlutter: ['tapeFlutter', 100],
  cHeadClog:    ['headClog', 100],
  cVhsPause:    ['vhsPause', 100],
  cColorFade:   ['colorFade', 100],
  cChromaLoss:  ['chromaLoss', 100],
  cGateWeave:   ['gateWeave', 100],
  cScanRainbow: ['scanRainbow', 100],
  cEdgeGlow:    ['edgeGlow', 100],
  cBayerDither: ['bayerDither', 100],
  cRinging:     ['ringing', 100],
  cInterlace:   ['interlace', 100],
  cCornerPurity:['cornerPurity', 100],
  cDegauss:     ['degauss', 100],
};

function syncCRTSliders() {
  Object.entries(crtSliderMap).forEach(([sliderId, [param, div]]) => {
    const el = g(sliderId);
    if (el) {
      el.value = Math.round((CRT.getParam(param) || 0) * div);
      const vId = 'vC' + sliderId.slice(1);
      const vEl = g(vId);
      if (vEl) vEl.textContent = el.value;
    }
  });
}

g('crtPreset').addEventListener('change', function() {
  CRT.setPreset(this.value);
  g('crtControls').style.display = this.value === 'off' ? 'none' : 'block';
  g('crtRatioRow').style.display = this.value === 'off' ? 'none' : 'block';
  g('crtCanvas').style.display = this.value === 'off' ? 'none' : 'block';
  if (this.value === 'off') vid.style.display = 'block';
  else vid.style.display = 'block'; // keep video visible underneath
  syncCRTSliders();
});

Object.entries(crtSliderMap).forEach(([sliderId, [param, div]]) => {
  const el = g(sliderId);
  if (el) el.addEventListener('input', () => {
    CRT.setParam(param, parseFloat(el.value) / div);
    const vId = 'vC' + sliderId.slice(1);
    const vEl = g(vId);
    if (vEl) vEl.textContent = el.value;
  });
});

// Guillotine toggle
g('cGuillotine').addEventListener('click', function() {
  const on = this.textContent.includes('off');
  this.textContent = on ? 'guillotine: on' : 'guillotine: off';
  this.classList.toggle('active', on);
  g('guillotineControls').style.display = on ? 'block' : 'none';
  CRT.setParam('chromaKey', on ? 1.0 : 0.0);
  if (!on) syncCRTSliders();
});

// Guillotine sliders
const chromaSliders = {
  cChromaKey:['chromaKey',100], cChromaGreen:['chromaGreen',100], cChromaSimilarity:['chromaSimilarity',100],
  cChromaSmoothness:['chromaSmoothness',100], cChromaSpill:['chromaSpill',100],
  cChromaNoiseSpeed:['chromaNoiseSpeed',100], cChromaNoiseScale:['chromaNoiseScale',100]
};
Object.entries(chromaSliders).forEach(([id,[param,div]]) => {
  const el = g(id);
  if(el) el.addEventListener('input', () => {
    CRT.setParam(param, parseFloat(el.value)/div);
    const vEl = g('vC'+id.slice(1));
    if(vEl) vEl.textContent = el.value;
  });
});

// Intensity sliders
g('cAmpIntensity').addEventListener('input', function(){ g('vCAmpIntensity').textContent = this.value + '%'; });
g('cBendIntensity').addEventListener('input', function(){ g('vCBendIntensity').textContent = this.value + '%'; });
g('cGlitchRatio').addEventListener('input', function(){ g('vCGlitchRatio').textContent = this.value + '%'; });

// Intensity mode: none / peak / auto
let intensityMode = 'none';
let _aiAmpTarget = 100, _aiBendTarget = 100;
let _aiAmpCurrent = 100, _aiBendCurrent = 100;
let _aiNextChange = 0;

document.querySelectorAll('[data-intmode]').forEach(btn => {
  btn.addEventListener('click', function() {
    intensityMode = this.dataset.intmode;
    document.querySelectorAll('[data-intmode]').forEach(b => b.classList.toggle('active', b.dataset.intmode === intensityMode));
  });
});

function updateAutoIntensity() {
  if (intensityMode === 'none') return;
  const now = performance.now();

  if (intensityMode === 'peak') {
    // Peak mode: amplitude directly drives intensity (loud = more intense)
    const amp = envelopeAmp / 255;
    const ampVal = Math.round(30 + amp * 170); // 30-200%
    const bendVal = Math.round(30 + amp * 170);
    g('cAmpIntensity').value = ampVal;
    g('vCAmpIntensity').textContent = ampVal + '%';
    g('cBendIntensity').value = bendVal;
    g('vCBendIntensity').textContent = bendVal + '%';
  }

  if (intensityMode === 'auto') {
    // Auto mode: random drift targets every 3-8 seconds
    if (now > _aiNextChange) {
      _aiAmpTarget = 20 + Math.floor(Math.random() * 180);
      _aiBendTarget = 20 + Math.floor(Math.random() * 180);
      _aiNextChange = now + 3000 + Math.random() * 5000;
    }
    _aiAmpCurrent += (_aiAmpTarget - _aiAmpCurrent) * 0.02;
    _aiBendCurrent += (_aiBendTarget - _aiBendCurrent) * 0.02;
    const ampVal = Math.round(_aiAmpCurrent);
    const bendVal = Math.round(_aiBendCurrent);
    g('cAmpIntensity').value = ampVal;
    g('vCAmpIntensity').textContent = ampVal + '%';
    g('cBendIntensity').value = bendVal;
    g('vCBendIntensity').textContent = bendVal + '%';
  }
}

// Glitch ratio: params zeroed on "clean" frames (aesthetic CRT params kept)
const _glitchKeys = [
  'distortion','distortion2','glitchIntensity','glitchSpeed','jitter','rgbShift',
  'rollSpeed','rollLine','screenTear','vSyncWobble','hSyncLoss','dataBend',
  'clockSkew','lineCorrupt','linesSkip','pixelStretch','channelSwap','shockwave',
  'staticBurst','solarize','posterize','invert','vortex','waveDistort','mirror',
  'feedback','ruttEtra','vCollapse','sCurve','emi','zoomBlur','lumaDisplace',
  'noiseDisplace','tapeWow','tapeFlutter','headClog','vhsPause','chromaLoss',
  'gateWeave','degauss','ghosting','colorDrift','bitCrush','pixelate'
];
const _glitchSaved = new Array(_glitchKeys.length).fill(0);

// Amplitude-driven random glitch
let crtAmpGlitch = false;
const ampGlitchParams = Object.keys(CRT.DEFAULTS);
g('cAmpGlitch').addEventListener('click', function() {
  crtAmpGlitch = !crtAmpGlitch;
  this.textContent = crtAmpGlitch ? 'amp glitch: on' : 'amp glitch: off';
  this.classList.toggle('active', crtAmpGlitch);
  if (!crtAmpGlitch) CRT.restorePresetParams(ampGlitchParams);
  syncCRTSliders();
});

// Circuit bend — amplitude drives circuit bending effects
let crtCircuitBend = false;
const circuitBendParams = Object.keys(CRT.DEFAULTS);
g('cCircuitBend').addEventListener('click', function() {
  crtCircuitBend = !crtCircuitBend;
  this.textContent = crtCircuitBend ? 'circuit bend: on' : 'circuit bend: off';
  this.classList.toggle('active', crtCircuitBend);
  if (!crtCircuitBend) CRT.restorePresetParams(circuitBendParams);
  syncCRTSliders();
});

// ─── INIT ────────────────────────────────────────────────────────────────────
[vid, dBgVid, dOvVid, dDpVid, dOv2Vid, dDp2Vid].forEach(v => { v.muted = true; v.volume = 0; });
drawBeatRing(0);
drawAudioTL();
drawVideoTL();
tlSetupEvents();

// Auto-start Spotify poller if token exists
if (isSpotifyConnected()) startSpotifyPoller();

// ─── PARTY WATCHDOG ─────────────────────────────────────────────────────────
// Keeps everything alive for hours-long playback
setInterval(() => {
  // Restart animation loop if died
  if (!animFrame && analyser) {
    console.log('[watchdog] restarting loop');
    startLoop();
  }
  // Restart Spotify poller if token valid but poller stopped
  if (isSpotifyConnected() && !spotifyPoller && !document.hidden) {
    console.log('[watchdog] restarting spotify poller');
    startSpotifyPoller();
  }
  // Recover WebGL context loss
  if (CRT.isEnabled()) {
    const crtC = g('crtCanvas');
    const testGL = crtC.getContext('webgl');
    if (testGL && testGL.isContextLost()) {
      console.log('[watchdog] WebGL context lost, reinitializing CRT');
      CRT.init(crtC);
    }
  }
  // Refresh Spotify token proactively (5min before expiry)
  if (isSpotifyConnected() && spotifyExpires - Date.now() < 300000) {
    console.log('[watchdog] proactive token refresh');
    refreshSpotifyToken();
  }
}, 30000); // Check every 30s
