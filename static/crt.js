// ─── CRT Post-Processing Module ─────────────────────────────────────────────
// Ported from crt-player by John Hargreaves
// WebGL post-process: scanlines, mask, barrel warp, chromatic aberration,
// bad TV distortion, glitch blocks, jitter, bloom, vignette, noise

var CRT = (() => {

let gl, program, fb, fbTex, quadBuf, uniforms = {};
let canvas, enabled = false, preset = 'off';
let prevFrameTex = null, prevFBO = null, prevW = 0, prevH = 0;
let params = {};
const DEFAULTS = {
  scanlines: 0.0,       // 0-1 scanline darkness
  scanShape: 0,         // 0=gaussian, 1=linear, 2=box, 3=off
  maskType: 2,          // 0=aperture, 1=slot, 2=off, 3=shadow
  maskScale: 1.0,       // mask pixel scale
  maskDark: 0.5,        // dark phosphor level
  maskLight: 1.5,       // bright phosphor level
  curvature: 0.0,       // barrel warp 0-30
  chromatic: 0.0,       // chromatic aberration 0-5
  convergence: 0.0,     // RGB convergence error 0-1
  distortion: 0.0,      // bad TV thick distort 0-3
  distortion2: 0.0,     // bad TV fine distort 0-3
  glitchIntensity: 0.0, // glitch block displacement 0-1
  glitchSpeed: 1.0,     // glitch temporal speed
  jitter: 0.0,          // horizontal line jitter 0-1
  rgbShift: 0.0,        // RGB channel separation 0-5
  noise: 0.0,           // static noise 0-0.3
  bloom: 0.0,           // bloom glow 0-1
  vignette: 0.0,        // edge darkening 0-1
  brightness: 1.0,      // overall brightness
  saturation: 1.0,      // color saturation
  flicker: 0.0,         // brightness flicker 0-0.1
  rollSpeed: 0.0,       // vertical roll 0-1
  rollLine: 0.0,        // roll bar width
  colorBleed: 0.0,      // horizontal color smear 0-1
  persistence: 0.0,     // phosphor persistence 0-1
  screenTear: 0.0,      // horizontal tear lines 0-1
  solarize: 0.0,        // solarize effect 0-1
  posterize: 0.0,       // posterize levels 0-1
  invert: 0.0,          // color invert 0-1
  vSyncWobble: 0.0,     // vsync instability 0-1
  hSyncLoss: 0.0,       // hsync loss 0-1
  dataBend: 0.0,        // data corruption 0-1
  pixelate: 0.0,        // block mosaic 0-1
  vortex: 0.0,          // spiral distort 0-1
  waveDistort: 0.0,     // sine wave horizontal 0-1
  mirror: 0.0,          // kaleidoscope 0-8
  pixelStretch: 0.0,    // horizontal stretch bands 0-1
  colorDrift: 0.0,      // RGB phase drift 0-1
  clockSkew: 0.0,       // per-line horizontal stretch 0-1
  bitCrush: 0.0,        // bit depth reduction 0-1
  lineCorrupt: 0.0,     // per-line corruption 0-1
  feedback: 0.0,        // zoom feedback echo 0-1
  channelSwap: 0.0,     // RGB channel permutation 0-5
  linesSkip: 0.0,       // dropped scanlines 0-1
  shockwave: 0.0,       // radial ripple 0-1
  staticBurst: 0.0,     // full-screen static bursts 0-1
  ruttEtra: 0.0,        // luma displaces Y (video synth) 0-1
  zoomBlur: 0.0,        // radial zoom blur 0-1
  lumaDisplace: 0.0,    // brightness warps X 0-1
  noiseDisplace: 0.0,   // organic pixel warp 0-1
  vCollapse: 0.0,       // vertical deflection collapse 0-1
  sCurve: 0.0,          // capacitor ripple distort 0-1
  emi: 0.0,             // electromagnetic interference 0-1
  humBar: 0.0,          // AC mains hum bars 0-1
  ghosting: 0.0,        // frame ghosting / persistence 0-1
};

const PRESETS = {
  off: {},
  vhs: {
    scanlines:0.2, curvature:10, bloom:0.4, chromatic:2, vignette:0.4,
    brightness:0.95, saturation:0.9, maskType:1, noise:0.06, distortion:1.5,
    distortion2:0.8, colorBleed:0.25, jitter:0.2, rollLine:0.3, persistence:0.3,
    flicker:0.04
  },
  arcade: {
    scanlines:0.5, curvature:15, bloom:0.4, chromatic:1.5, vignette:0.55,
    brightness:1.15, saturation:1.35, maskType:1, maskScale:0.9, noise:0.025,
    convergence:0.08, persistence:0.18, flicker:0.015
  },
  broadcast: {
    scanlines:0.35, curvature:5, bloom:0.25, chromatic:0.8, vignette:0.3,
    brightness:1.05, saturation:1.0, maskType:0, maskScale:0.7, noise:0.01,
    flicker:0.005, persistence:0.1
  },
  glitch: {
    scanlines:0.15, curvature:3, bloom:0.35, chromatic:3, vignette:0.2,
    glitchIntensity:0.7, glitchSpeed:1.5, rgbShift:2, jitter:0.6, noise:0.03,
    persistence:0.08
  },
  cctv: {
    scanlines:0.4, curvature:8, bloom:0.15, chromatic:0.5, vignette:0.6,
    brightness:0.9, saturation:0.3, maskType:2, noise:0.08, jitter:0.1,
    flicker:0.03
  },
  busted: {
    scanlines:0.3, curvature:12, bloom:0.5, chromatic:4, vignette:0.5,
    distortion:2.5, distortion2:1.5, jitter:0.8, noise:0.1, rollSpeed:0.3,
    rollLine:0.5, vSyncWobble:0.6, hSyncLoss:0.3, glitchIntensity:0.4,
    glitchSpeed:2, colorBleed:0.4, flicker:0.08, screenTear:0.5
  },
  dreamy: {
    scanlines:0.1, curvature:2, bloom:0.7, chromatic:1.5, vignette:0.3,
    brightness:1.1, saturation:1.2, persistence:0.5, flicker:0.01, noise:0.01
  },
  acidTrip: {
    scanlines:0.1, chromatic:4, rgbShift:3, solarize:0.5, vortex:0.3,
    waveDistort:0.4, bloom:0.5, saturation:1.5, flicker:0.02, noise:0.02,
    glitchIntensity:0.3, glitchSpeed:3
  },
  circuitBend: {
    scanlines:0.2, chromatic:2.5, bloom:0.3, noise:0.04,
    clockSkew:0.5, dataBend:0.6, bitCrush:0.3, lineCorrupt:0.4,
    channelSwap:2, colorDrift:0.5, pixelStretch:0.4, linesSkip:0.2,
    glitchIntensity:0.3, glitchSpeed:2, jitter:0.3, rgbShift:1.5,
    staticBurst:0.3, feedback:0.3
  },
  dataCorrupt: {
    dataBend:0.8, clockSkew:0.7, lineCorrupt:0.6, pixelStretch:0.6,
    bitCrush:0.5, noise:0.06, glitchIntensity:0.5, glitchSpeed:3,
    chromatic:2, linesSkip:0.3, staticBurst:0.4
  }
};

// ─── GLSL ───────────────────────────────────────────────────────────────────

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  vUv.y = 1.0 - vUv.y;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform float uTime;

// Params
uniform float uScanlines;
uniform float uScanShape;
uniform float uMaskType;
uniform float uMaskScale;
uniform float uMaskDark;
uniform float uMaskLight;
uniform float uCurvature;
uniform float uChromatic;
uniform float uConvergence;
uniform float uDistortion;
uniform float uDistortion2;
uniform float uGlitchIntensity;
uniform float uGlitchSpeed;
uniform float uJitter;
uniform float uRGBShift;
uniform float uNoise;
uniform float uBloom;
uniform float uVignette;
uniform float uBrightness;
uniform float uSaturation;
uniform float uFlicker;
uniform float uRollSpeed;
uniform float uRollLine;
uniform float uColorBleed;
uniform float uPersistence;
uniform float uScreenTear;
uniform float uSolarize;
uniform float uPosterize;
uniform float uInvert;
uniform float uVSyncWobble;
uniform float uHSyncLoss;
uniform float uDataBend;
uniform float uPixelate;
uniform float uVortex;
uniform float uWaveDistort;
uniform float uMirror;
uniform float uPixelStretch;
uniform float uColorDrift;
uniform float uClockSkew;
uniform float uBitCrush;
uniform float uLineCorrupt;
uniform float uFeedback;
uniform float uChannelSwap;
uniform float uLinesSkip;
uniform float uShockwave;
uniform float uStaticBurst;
uniform float uRuttEtra;
uniform float uZoomBlur;
uniform float uLumaDisplace;
uniform float uNoiseDisplace;
uniform float uVCollapse;
uniform float uSCurve;
uniform float uEmi;
uniform float uHumBar;
uniform float uGhosting;
uniform sampler2D uPrevFrame;

// ─── Helpers ────────────────────────────────────────────────────────────────

float hash1(float n) { return fract(sin(n) * 43758.5453123); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }

// Simplex-ish noise
float snoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f*f*(3.0-2.0*f);
  float a=hash2(i), b=hash2(i+vec2(1,0)), c=hash2(i+vec2(0,1)), d=hash2(i+vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}

// ─── Barrel Warp ────────────────────────────────────────────────────────────

vec2 Warp(vec2 uv) {
  if (uCurvature <= 0.0) return uv;
  vec2 p = uv * 2.0 - 1.0;
  float warp = uCurvature / 1000.0;
  p *= vec2(1.0 + p.y*p.y*warp, 1.0 + p.x*p.x*warp);
  p /= vec2(1.0 + warp, 1.0 + warp);
  return p * 0.5 + 0.5;
}

// ─── Bad TV Distortion ──────────────────────────────────────────────────────

float badTV(vec2 uv, float t) {
  float d = 0.0;
  float lineY = floor(uv.y * 480.0) / 480.0;

  if (uDistortion > 0.0) {
    float psRipple = sin(t * 120.0 * 6.28318) * 0.25;
    float drift = snoise(vec2(lineY * 4.0, t * 0.5));
    float stepped = snoise(vec2(lineY * 8.0, t * 0.7 + 31.0));
    float standingWave = sin(uv.y * 40.0 + t * 50.0) * 0.2;
    float linePhase = sin(lineY * 2.0) * psRipple;
    float lineHash = hash1(lineY * 137.0 + floor(t * 60.0 * 0.13));
    d += uDistortion * (mix(drift, stepped, 0.7) * 0.35
      + standingWave * 0.25 + linePhase * 0.2
      + snoise(vec2(lineY * 16.0, t * 1.2)) * 0.15
      + (lineHash - 0.5) * 0.05);
  }

  if (uDistortion2 > 0.0) {
    float lineJitter = hash1(lineY * 293.0 + floor(t * 60.0 * 0.25));
    float oscDrift = sin(t * 3.2 + lineY * 20.0) * 0.03;
    d += uDistortion2 * (snoise(vec2(lineY * 40.0, t * 3.0)) * 0.1
      + (lineJitter - 0.5) * 0.06 + oscDrift
      + snoise(vec2(lineY * 100.0, t * 5.0)) * 0.04);
  }
  return d;
}

// ─── Glitch Blocks ──────────────────────────────────────────────────────────

vec2 glitchOffset(vec2 uv, float t) {
  if (uGlitchIntensity <= 0.0) return vec2(0.0);
  float gt = floor(t * uGlitchSpeed * 5.0);
  float trigger = step(0.85 - uGlitchIntensity * 0.3, hash1(gt * 1.3));
  if (trigger < 0.5) return vec2(0.0);
  float blockY = floor(uv.y * (4.0 + uGlitchIntensity * 12.0));
  float blockHash = hash1(blockY + gt * 7.7);
  float blockOn = step(0.5, blockHash);
  float shift = (hash1(blockY * 3.3 + gt * 11.1) - 0.5) * uGlitchIntensity * 0.15;
  return vec2(shift * blockOn, 0.0);
}

// ─── Phosphor Mask ──────────────────────────────────────────────────────────

vec3 Mask(vec2 pos) {
  if (uMaskType > 1.5 && uMaskType < 2.5) return vec3(1.0); // off
  float scale = max(uMaskScale, 0.25);
  pos /= scale;
  vec3 mask = vec3(uMaskDark);

  if (uMaskType < 0.5) {
    // Aperture grille (Trinitron)
    float col = fract(pos.x / 3.0) * 3.0;
    float tw = 0.08;
    mask.r = mix(uMaskDark, uMaskLight, smoothstep(0.0-tw,0.0+tw,col)*smoothstep(1.0+tw,1.0-tw,col));
    mask.g = mix(uMaskDark, uMaskLight, smoothstep(1.0-tw,1.0+tw,col)*smoothstep(2.0+tw,2.0-tw,col));
    mask.b = mix(uMaskDark, uMaskLight, smoothstep(2.0-tw,2.0+tw,col));
  } else if (uMaskType < 1.5) {
    // Slot mask
    float slotRow = floor(pos.y);
    pos.x += mod(slotRow, 2.0) * 1.5;
    float col = fract(pos.x / 3.0) * 3.0;
    float tw = 0.08;
    mask.r = mix(uMaskDark, uMaskLight, smoothstep(0.0-tw,0.0+tw,col)*smoothstep(1.0+tw,1.0-tw,col));
    mask.g = mix(uMaskDark, uMaskLight, smoothstep(1.0-tw,1.0+tw,col)*smoothstep(2.0+tw,2.0-tw,col));
    mask.b = mix(uMaskDark, uMaskLight, smoothstep(2.0-tw,2.0+tw,col));
  } else if (uMaskType > 2.5) {
    // Shadow mask (dot triad)
    float triW = 3.0, triH = triW * 0.866;
    float row = floor(pos.y / triH);
    float xOff = mod(row, 2.0) * 1.5;
    float cx = mod(pos.x + xOff, triW) - triW * 0.5;
    float cy = mod(pos.y, triH) - triH * 0.5;
    float dist = sqrt(cx*cx + cy*cy);
    float dotR = triW * 0.38;
    float dot = smoothstep(dotR, dotR * 0.55, dist);
    float phase = fract((pos.x + xOff) / triW);
    if (phase < 0.333) mask.r = mix(uMaskDark, uMaskLight, dot);
    else if (phase < 0.666) mask.g = mix(uMaskDark, uMaskLight, dot);
    else mask.b = mix(uMaskDark, uMaskLight, dot);
  }
  return mask;
}

// ─── Scanline Weight ────────────────────────────────────────────────────────

float scanWeight(float y, float scanCount) {
  if (uScanlines <= 0.0) return 1.0;
  float line = y * scanCount;
  float frac = fract(line);
  float w;
  if (uScanShape > 2.5) { w = 1.0; }
  else if (uScanShape > 1.5) { w = step(0.5, frac) > 0.0 ? 1.0 : 1.0 - uScanlines; } // box
  else if (uScanShape > 0.5) { w = 1.0 - uScanlines * (1.0 - abs(frac - 0.5) * 2.0); } // linear
  else { w = 1.0 - uScanlines * exp(-pow((frac-0.5)*4.0, 2.0) * 2.0); w = max(w, 1.0 - uScanlines); } // gaussian
  return w;
}

// ─── Main ───────────────────────────────────────────────────────────────────

void main() {
  vec2 uv = vUv;
  float t = uTime;
  vec2 res = uResolution;
  float scanCount = 480.0;

  // ── Mirror / Kaleidoscope ──
  if (uMirror > 0.5) {
    vec2 c = uv - 0.5;
    float angle = atan(c.y, c.x);
    float r = length(c);
    float n = max(2.0, floor(uMirror));
    float seg = 6.28318 / n;
    angle = mod(angle, seg);
    if (angle > seg * 0.5) angle = seg - angle;
    uv = vec2(cos(angle), sin(angle)) * r + 0.5;
  }

  // ── Vortex ──
  if (uVortex > 0.0) {
    vec2 c = uv - 0.5;
    float r = length(c);
    float a = atan(c.y, c.x) + uVortex * (1.0 - r) * 3.0;
    uv = vec2(cos(a), sin(a)) * r + 0.5;
  }

  // ── Wave distortion ──
  if (uWaveDistort > 0.0) {
    float lineY = floor(uv.y * scanCount) / scanCount;
    uv.x += sin(lineY * 30.0 + t * 5.0) * uWaveDistort * 0.02;
  }

  // ── Barrel warp ──
  uv = Warp(uv);

  // ── V-Sync wobble ──
  if (uVSyncWobble > 0.0) {
    float wobble = sin(t * 3.7) * 0.5 + sin(t * 7.3) * 0.3 + sin(t * 13.1) * 0.2;
    uv.y += wobble * uVSyncWobble * 0.01;
  }

  // ── H-Sync loss ──
  if (uHSyncLoss > 0.0) {
    float lineY = floor(uv.y * scanCount) / scanCount;
    float barber = sin(lineY * 50.0 + t * 20.0);
    float loss = smoothstep(0.3, 0.8, barber) * uHSyncLoss;
    uv.x += loss * 0.05;
  }

  // ── Vertical roll ──
  if (uRollSpeed > 0.0) {
    uv.y = fract(uv.y + t * uRollSpeed * 0.1);
    float rollPos = fract(t * uRollSpeed * 0.1);
    float rollBar = smoothstep(0.0, uRollLine * 0.1, abs(uv.y - rollPos));
    // darken at roll bar
    // applied later
  }

  // ── Bad TV ──
  float btv = badTV(uv, t);
  uv.x += btv * 0.02;

  // ── Glitch blocks ──
  uv += glitchOffset(uv, t);

  // ── Data bend ──
  if (uDataBend > 0.0) {
    float lineY = floor(uv.y * scanCount) / scanCount;
    float bend = hash1(lineY * 173.0 + floor(t * 8.0) * 7.7);
    if (bend > 0.85) uv.x += (bend - 0.85) * uDataBend * 0.3;
  }

  // ── Jitter ──
  if (uJitter > 0.0) {
    float lineY = floor(uv.y * scanCount) / scanCount;
    float j = (hash1(lineY * 211.0 + floor(t * 60.0)) - 0.5) * 2.0;
    j += sin(lineY * 15.0 + t * 8.0) * 0.5;
    uv.x += j * uJitter * 0.005;
  }

  // ── Screen tear ──
  if (uScreenTear > 0.0) {
    float tearY1 = fract(t * 0.7) * 0.8 + 0.1;
    float tearY2 = fract(t * 1.1 + 0.5) * 0.8 + 0.1;
    if (abs(uv.y - tearY1) < 0.003) uv.x += uScreenTear * 0.03;
    if (abs(uv.y - tearY2) < 0.002) uv.x -= uScreenTear * 0.02;
  }

  // ── S-Curve distortion (capacitor failure) ──
  if (uSCurve > 0.0) {
    float drift = t * 0.15;
    float ripple = sin(uv.y * 6.28318 * 2.0 + drift * 6.28318) * 0.5
                 + sin(uv.y * 6.28318 * 4.0 + drift * 6.28318 * 1.3) * 0.25;
    uv.x += ripple * uSCurve * 0.02;
  }

  // ── V-Collapse (vertical deflection failing) ──
  if (uVCollapse > 0.0) {
    float collapse = uVCollapse * uVCollapse;
    uv.y = 0.5 + (uv.y - 0.5) * (1.0 - collapse * 0.95);
  }

  // ── Rutt-Etra (luma displaces Y) ──
  if (uRuttEtra > 0.0) {
    float reLuma = dot(texture2D(uTexture, uv).rgb, vec3(0.299, 0.587, 0.114));
    uv.y -= reLuma * uRuttEtra * 0.15;
  }

  // ── Zoom blur ──
  if (uZoomBlur > 0.0) {
    vec2 zbC = uv - 0.5;
    float zbD = length(zbC);
    uv = 0.5 + zbC * (1.0 + zbD * uZoomBlur * 0.5);
  }

  // ── Luma displace (brightness warps X) ──
  if (uLumaDisplace > 0.0) {
    float ldLuma = dot(texture2D(uTexture, uv).rgb, vec3(0.299, 0.587, 0.114));
    uv.x += (ldLuma - 0.5) * uLumaDisplace * 0.06;
  }

  // ── Noise displace (organic warp) ──
  if (uNoiseDisplace > 0.0) {
    float nd1 = snoise(uv * 8.0 + vec2(t * 0.3, 0.0));
    float nd2 = snoise(uv * 8.0 + vec2(0.0, t * 0.37));
    uv += (vec2(nd1, nd2) - 0.5) * uNoiseDisplace * 0.03;
  }

  // ── Pixelate ──
  if (uPixelate > 0.0) {
    float blocks = mix(256.0, 16.0, uPixelate);
    uv = floor(uv * blocks) / blocks;
  }

  // ── Pixel stretch ──
  if (uPixelStretch > 0.0) {
    float lineY = floor(uv.y * scanCount) / scanCount;
    float band = snoise(vec2(lineY * 5.0, t * 0.5));
    if (band > 0.7) {
      float stretchAmt = (band - 0.7) * uPixelStretch * 3.0;
      uv.x = mix(uv.x, 0.5, stretchAmt * 0.3);
    }
  }

  // ── Clock skew ──
  if (uClockSkew > 0.0) {
    float lineY = floor(uv.y * scanCount) / scanCount;
    float skew = sin(lineY * 50.0 + t * 3.0) * uClockSkew * 0.05;
    uv.x = 0.5 + (uv.x - 0.5) * (1.0 + skew);
  }

  // ── Shockwave ──
  if (uShockwave > 0.0) {
    vec2 c = uv - 0.5;
    float r = length(c);
    float wave = sin(r * 30.0 - t * 8.0) * uShockwave * 0.02;
    float lineY = floor(uv.y * scanCount) / scanCount;
    uv += normalize(c + 0.001) * wave * smoothstep(0.5, 0.0, r);
  }

  // ── Line corrupt ──
  if (uLineCorrupt > 0.0) {
    float lineY = floor(uv.y * scanCount);
    float corrupt = hash1(lineY * 73.0 + floor(t * 15.0));
    if (corrupt > 1.0 - uLineCorrupt * 0.15) {
      uv.x += (hash1(lineY * 31.0 + t * 100.0) - 0.5) * 0.2;
    }
  }

  // ── Lines skip ──
  if (uLinesSkip > 0.0) {
    float lineY = floor(uv.y * scanCount);
    float skip = hash1(lineY * 41.0 + floor(t * 8.0));
    if (skip > 1.0 - uLinesSkip * 0.1) {
      uv.y += 1.0 / scanCount;
    }
  }

  // ── Out of bounds check ──
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // ── Sample with chromatic aberration + RGB shift ──
  vec3 col;
  float ca = uChromatic / res.x;
  float shift = uRGBShift / res.x;
  vec2 dir = (uv - 0.5);
  float dist = length(dir);

  // Convergence offset
  vec2 convR = vec2( 0.5, -0.3) * uConvergence * 0.003;
  vec2 convB = vec2(-0.3,  0.5) * uConvergence * 0.003;

  vec2 rOff = dir * ca * dist + vec2(shift, 0.0) + convR;
  vec2 bOff = -dir * ca * dist - vec2(shift, 0.0) + convB;

  col.r = texture2D(uTexture, uv + rOff).r;
  col.g = texture2D(uTexture, uv).g;
  col.b = texture2D(uTexture, uv + bOff).b;

  // ── Color bleed ──
  if (uColorBleed > 0.0) {
    float px = 1.0 / res.x;
    vec3 bleed = vec3(0.0);
    bleed += texture2D(uTexture, uv - vec2(px, 0.0)).rgb;
    bleed += texture2D(uTexture, uv - vec2(px*2.0, 0.0)).rgb;
    bleed += texture2D(uTexture, uv - vec2(px*3.0, 0.0)).rgb;
    bleed += texture2D(uTexture, uv - vec2(px*4.0, 0.0)).rgb;
    col = mix(col, bleed / 4.0, uColorBleed * 0.3);
  }

  // ── Color drift (RGB phase separation over time) ──
  if (uColorDrift > 0.0) {
    float drift = uColorDrift * 0.003;
    col.r = texture2D(uTexture, uv + vec2(sin(t * 1.1) * drift, cos(t * 0.7) * drift)).r;
    col.b = texture2D(uTexture, uv + vec2(cos(t * 1.3) * drift, sin(t * 0.9) * drift)).b;
  }

  // ── Channel swap ──
  if (uChannelSwap > 0.5 && uChannelSwap < 1.5) col = col.rbg;
  else if (uChannelSwap >= 1.5 && uChannelSwap < 2.5) col = col.grb;
  else if (uChannelSwap >= 2.5 && uChannelSwap < 3.5) col = col.gbr;
  else if (uChannelSwap >= 3.5 && uChannelSwap < 4.5) col = col.brg;
  else if (uChannelSwap >= 4.5) col = col.bgr;

  // ── Bit crush ──
  if (uBitCrush > 0.0) {
    float levels = max(2.0, floor(256.0 * (1.0 - uBitCrush)));
    col = floor(col * levels) / levels;
  }

  // ── Static burst ──
  if (uStaticBurst > 0.0) {
    float burst = step(0.95 - uStaticBurst * 0.2, hash1(floor(t * 4.0) * 7.7));
    if (burst > 0.5) {
      float st = hash2(uv * res + vec2(t * 5000.0));
      col = mix(col, vec3(st), uStaticBurst * 0.8);
    }
  }

  // ── Feedback (zoom echo) ──
  if (uFeedback > 0.0) {
    vec2 fbUv = (uv - 0.5) * (1.0 - uFeedback * 0.05) + 0.5;
    vec3 fb = texture2D(uTexture, fbUv).rgb;
    col = mix(col, max(col, fb * 0.9), uFeedback * 0.4);
  }

  // ── Solarize ──
  if (uSolarize > 0.0) {
    vec3 s = step(vec3(0.5), col);
    vec3 sol = col * (1.0 - s) + (1.0 - col) * s;
    col = mix(col, sol, uSolarize);
  }

  // ── Posterize ──
  if (uPosterize > 0.0) {
    float levels = mix(256.0, 4.0, uPosterize);
    col = floor(col * levels) / levels;
  }

  // ── Invert ──
  col = mix(col, 1.0 - col, uInvert);

  // ── Saturation ──
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(luma), col, uSaturation);

  // ── Scanlines ──
  float sw = scanWeight(uv.y, scanCount);
  col *= sw;

  // ── Phosphor mask ──
  vec2 fragCoord = uv * res;
  col *= Mask(fragCoord);

  // ── Bloom (simple glow approximation) ──
  if (uBloom > 0.0) {
    float px = 3.0/res.x, py = 3.0/res.y;
    vec3 bloomCol = texture2D(uTexture, uv).rgb
      + texture2D(uTexture, uv + vec2(px, 0.0)).rgb
      + texture2D(uTexture, uv - vec2(px, 0.0)).rgb
      + texture2D(uTexture, uv + vec2(0.0, py)).rgb
      + texture2D(uTexture, uv - vec2(0.0, py)).rgb
      + texture2D(uTexture, uv + vec2(px, py)).rgb
      + texture2D(uTexture, uv - vec2(px, py)).rgb
      + texture2D(uTexture, uv + vec2(px, -py)).rgb
      + texture2D(uTexture, uv - vec2(px, -py)).rgb;
    bloomCol /= 9.0;
    vec3 bright = max(bloomCol - 0.5, 0.0) * 2.0;
    col += bright * uBloom;
  }

  // ── Noise ──
  if (uNoise > 0.0) {
    float n = hash2(uv * res + vec2(t * 1000.0)) - 0.5;
    col += vec3(n) * uNoise;
  }

  // ── EMI (electromagnetic interference herringbone) ──
  if (uEmi > 0.0) {
    float scanPx = vUv.y * 480.0;
    float herring1 = sin(scanPx * 0.8 + vUv.x * res.x * 0.3 + t * 120.0) * 0.5;
    float herring2 = sin(scanPx * 1.2 - vUv.x * res.x * 0.2 + t * 97.0) * 0.3;
    float emival = herring1 + herring2;
    col += vec3(emival * uEmi * 0.08);
    float burst = smoothstep(0.95, 1.0, sin(t * 0.3)) * 3.0;
    col += vec3(emival * uEmi * 0.05 * burst);
  }

  // ── Hum bar (AC mains) ──
  if (uHumBar > 0.0) {
    float humPhase = vUv.y * 6.28318 + t * 6.28318 * 0.5;
    float hum = sin(humPhase) * 0.5 + 0.5;
    hum = hum * hum;
    col *= 1.0 - uHumBar * 0.15 * (1.0 - hum);
  }

  // ── V-Collapse glow ──
  if (uVCollapse > 0.0) {
    float yDist = abs(vUv.y - 0.5);
    float collapseFade = 1.0 - uVCollapse * uVCollapse * 0.95;
    float lineGlow = exp(-yDist * yDist / max(0.01, collapseFade * 0.5));
    col *= 1.0 + uVCollapse * lineGlow * 2.0;
  }

  // ── Flicker ──
  if (uFlicker > 0.0) {
    float fl = 1.0 + (sin(t * 120.0) * 0.5 + sin(t * 37.0) * 0.3 + sin(t * 7.0) * 0.2) * uFlicker;
    col *= fl;
  }

  // ── Vertical roll bar darkening ──
  if (uRollSpeed > 0.0) {
    float rollPos = fract(t * uRollSpeed * 0.1);
    float rollBar = smoothstep(0.0, max(uRollLine * 0.1, 0.01), abs(uv.y - rollPos));
    col *= mix(0.3, 1.0, rollBar);
  }

  // ── Vignette ──
  if (uVignette > 0.0) {
    vec2 vig = vUv * (1.0 - vUv);
    float v = pow(vig.x * vig.y * 15.0, uVignette * 0.5);
    col *= clamp(v, 0.0, 1.0);
  }

  // ── Frame ghosting ──
  if (uGhosting > 0.0) {
    vec2 prevUv = vec2(vUv.x, 1.0 - vUv.y);
    vec3 prev = texture2D(uPrevFrame, prevUv).rgb;
    col = max(col, prev * uGhosting);
  }

  // ── Brightness ──
  col *= uBrightness;

  // ── Clamp ──
  col = clamp(col, 0.0, 1.0);

  gl_FragColor = vec4(col, 1.0);
}
`;

// ─── WebGL Setup ────────────────────────────────────────────────────────────

function init(targetCanvas) {
  canvas = targetCanvas;
  gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) { console.warn('[crt] WebGL unavailable'); return false; }

  // Compile shaders
  const vs = compileShader(gl.VERTEX_SHADER, VERT);
  const fs = compileShader(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return false;

  program = gl.createProgram();
  gl.attachShader(program, vs); gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[crt] link error:', gl.getProgramInfoLog(program)); return false;
  }
  gl.useProgram(program);

  // Fullscreen quad
  quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  // Input texture
  fbTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, fbTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.uniform1i(gl.getUniformLocation(program, 'uTexture'), 0);

  // Cache uniform locations
  const names = Object.keys(DEFAULTS);
  const uNames = ['uTexture','uResolution','uTime',
    ...names.map(k => 'u' + k.charAt(0).toUpperCase() + k.slice(1))];
  uNames.forEach(n => { uniforms[n] = gl.getUniformLocation(program, n); });

  // Previous frame texture for ghosting
  prevFrameTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, prevFrameTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,255]));
  gl.uniform1i(gl.getUniformLocation(program, 'uPrevFrame'), 1);

  // FBO for capturing current frame → prev
  prevFBO = gl.createFramebuffer();

  // Set defaults
  params = { ...DEFAULTS };
  console.log('[crt] init OK, program:', !!program, 'uniforms:', Object.keys(uniforms).length);
  return true;
}

function compileShader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    console.error('[crt] shader compile FAILED (' + (type === gl.VERTEX_SHADER ? 'vert' : 'frag') + '):', log);
    // Show first error line
    const lines = src.split('\n');
    const match = log.match(/(\d+):(\d+)/);
    if (match) console.error('[crt] near line ' + match[2] + ':', lines[parseInt(match[2])-1]);
    return null;
  }
  console.log('[crt] shader compiled OK (' + (type === gl.VERTEX_SHADER ? 'vert' : 'frag') + ')');
  return s;
}

// ─── Render ─────────────────────────────────────────────────────────────────

function render(source, width, height) {
  if (!gl || !enabled || !program) return;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width; canvas.height = height;
    // Rebind state after resize
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    const aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  }
  gl.viewport(0, 0, width, height);

  // Upload source texture
  gl.useProgram(program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, fbTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); }
  catch(e) { console.warn('[crt] texImage2D failed:', e.message); return; }
  gl.uniform1i(uniforms.uTexture, 0);

  // Set uniforms
  gl.uniform2f(uniforms.uResolution, width, height);
  gl.uniform1f(uniforms.uTime, performance.now() / 1000.0);

  Object.keys(DEFAULTS).forEach(key => {
    const uName = 'u' + key.charAt(0).toUpperCase() + key.slice(1);
    if (uniforms[uName] !== undefined && uniforms[uName] !== null) {
      gl.uniform1f(uniforms[uName], params[key] !== undefined ? params[key] : DEFAULTS[key]);
    }
  });

  // Bind previous frame texture
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, prevFrameTex);
  gl.uniform1i(gl.getUniformLocation(program, 'uPrevFrame'), 1);

  // Ensure quad bound
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  const aP = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(aP);
  gl.vertexAttribPointer(aP, 2, gl.FLOAT, false, 0, 0);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // Copy current output to prevFrameTex for next frame ghosting
  if (params.ghosting > 0) {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, prevFrameTex);
    gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, width, height, 0);
  }
}

// ─── Preset Management ──────────────────────────────────────────────────────

function setPreset(name) {
  preset = name;
  params = { ...DEFAULTS };
  if (PRESETS[name]) Object.assign(params, PRESETS[name]);
  enabled = name !== 'off';
}

function setParam(key, val) {
  if (key in DEFAULTS) params[key] = val;
}

function getParam(key) { return params[key]; }
function getPresetNames() { return Object.keys(PRESETS); }
function isEnabled() { return enabled; }
function setEnabled(v) { enabled = v; }

return { init, render, setPreset, setParam, getParam, getPresetNames, isEnabled, setEnabled, DEFAULTS, PRESETS };
})();
