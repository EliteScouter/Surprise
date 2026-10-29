// A living planet: GPU-baked cubemap terrain, procedural surface shading, animated clouds,
// a raymarched scattering atmosphere, rings, moons, megastructures and a genesis sequence.
import * as THREE from 'three';
import { NOISE, CLOUDS } from './glsl.js';
import { paletteFor } from './dna.js';

const TYPE_ID = { terran: 0, ocean: 1, desert: 2, ice: 3, lava: 4, gas: 5, barren: 6, toxic: 7 };

// ------------------------------------------------------------------ bake
const BAKE_FRAG = /* glsl */ `
${NOISE}
uniform int uFace;
uniform float uSize;
uniform vec3 uSeed;
uniform float uScale, uWarp, uMountains, uRough, uCraters;

float craterField(vec3 d){
  float total = 0.0;
  for (int o = 0; o < 3; o++){
    float sc = 3.0 * pow(2.3, float(o));
    vec3 p = d * sc + uSeed * 0.013 + float(o) * 17.3;
    vec3 ip = floor(p); vec3 fp = fract(p);
    float acc = 0.0;
    for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
      vec3 g = vec3(float(i), float(j), float(k));
      vec3 hsh = hash33(ip + g);
      if (hsh.z > 0.55) continue;           // sparse cells
      vec3 r = g + hsh - fp;
      float rad = 0.18 + 0.32 * fract(hsh.x * 7.31);
      float x = length(r) / rad;
      if (x > 1.7) continue;
      float bowl = x < 1.0 ? (x * x - 1.0) * 0.9 + 0.3 * smoothstep(0.6, 1.0, x) : 0.3 * exp(-(x - 1.0) * (x - 1.0) * 10.0);
      acc += bowl * rad;
    }
    total += acc / pow(1.6, float(o));
  }
  return total * 0.22;
}

void main(){
  vec2 st = gl_FragCoord.xy / uSize * 2.0 - 1.0;
  float s = st.x, t = st.y;
  vec3 d;
  if (uFace == 0) d = vec3(1.0, -t, -s);
  else if (uFace == 1) d = vec3(-1.0, -t, s);
  else if (uFace == 2) d = vec3(s, 1.0, t);
  else if (uFace == 3) d = vec3(s, -1.0, -t);
  else if (uFace == 4) d = vec3(s, -t, 1.0);
  else d = vec3(-s, -t, -1.0);
  d = normalize(d);

  vec3 p = d * uScale + uSeed;
  vec3 q = vec3(fbm(p + vec3(1.7, 9.2, 3.1), 4), fbm(p + vec3(8.3, 2.8, 5.5), 4), fbm(p + vec3(4.1, 6.3, 1.9), 4));
  float cont = fbm(p + q * uWarp, 7);
  float ridge = ridged(d * uScale * 2.4 + uSeed * 1.7 + q * 0.6, 7);
  float mmask = smoothstep(-0.05, 0.35, cont);
  float h = cont + ridge * ridge * uMountains * mmask * 0.6;
  h += fbm(d * 16.0 + uSeed, 4) * 0.07 * uRough;
  if (uCraters > 0.001) h += craterField(d) * uCraters;
  float height = clamp(h * 0.8 + 0.5, 0.0, 1.0);
  float moist = clamp(fbm(d * 1.7 + uSeed * 0.7 + 31.0, 5) * 0.9 + 0.5, 0.0, 1.0);
  float detail = clamp(fbm(d * 11.0 + uSeed * 1.3 + 77.0, 4) * 0.9 + 0.5, 0.0, 1.0);
  float crack = (1.0 - abs(snoise(d * 14.0 + uSeed + q * 2.0))) * (1.0 - abs(snoise(d * 5.0 + uSeed * 0.5)));
  gl_FragColor = vec4(height, moist, detail, crack);
}
`;

// ------------------------------------------------------------------ surface
const SURFACE_VERT = /* glsl */ `
uniform samplerCube uHeight;
uniform float uSea, uDisp, uForm;
varying vec3 vDir;
varying vec3 vWorldPos;
void main(){
  vDir = normalize(position);
  float h = textureLod(uHeight, vDir, 0.0).r;
  float sea = uSea * smoothstep(0.3, 0.85, uForm);
  float lift = max(h - sea, 0.0) * uDisp;
  vec3 pos = vDir * (1.0 + lift);
  vec4 wp = modelMatrix * vec4(pos, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SURFACE_FRAG = /* glsl */ `
${NOISE}
${CLOUDS}
uniform samplerCube uHeight;
uniform float uTexel, uSea, uDisp, uForm, uTemp, uHumid, uCiv, uType, uBands, uStorm, uClouds;
uniform vec3 cDeep, cShallow, cBeach, cLush, cDry, cRock, cSnow;
uniform vec3 uSeed;
uniform vec3 uSunDir, uSunColor, uSun2Dir, uSun2Color;
uniform float uBinary;
uniform mat3 uToCloud;
uniform mat3 uModelRot;
varying vec3 vDir;
varying vec3 vWorldPos;

vec3 gasGiant(vec3 d){
  // a vortex: twist the lookup around a storm centre
  vec3 sc = normalize(vec3(0.6, -0.32, 0.74));
  float dist = acos(clamp(dot(d, sc), -1.0, 1.0));
  float sr = 0.12 + 0.18 * uStorm;
  vec3 dd = rotateAxis(d, sc, 4.0 * uStorm * exp(-dist * dist / (sr * sr)) + uTime * 0.05 * exp(-dist * dist / (sr * sr)));
  float lat = dd.y;
  float ang = uTime * 0.012 * (1.0 + 0.8 * sin(lat * uBands * 0.5));
  dd = rotateAxis(dd, vec3(0.0, 1.0, 0.0), ang);
  float turb = fbm(dd * vec3(2.5, 11.0, 2.5) + uSeed * 0.01, 6);
  float b = lat * uBands + turb * 2.2 + fbm(dd * 1.5 + uSeed * 0.02, 3) * 2.5;
  float band = sin(b) * 0.5 + 0.5;
  float band2 = sin(b * 2.37 + 1.3) * 0.5 + 0.5;
  vec3 col = mix(cDeep, cShallow, smoothstep(0.15, 0.85, band));
  col = mix(col, cBeach, smoothstep(0.55, 1.0, band2) * 0.65);
  col = mix(col, cLush, smoothstep(0.3, 0.9, turb * 0.5 + 0.5) * 0.35);
  float eye = exp(-dist * dist / (sr * sr * 0.35));
  col = mix(col, cLush * 1.15, eye * uStorm * 0.8);
  return col;
}

void main(){
  vec3 dir = normalize(vDir);
  vec3 gN = normalize(uModelRot * dir);
  vec3 V = normalize(cameraPosition - vWorldPos);
  float ndlGeo = dot(gN, uSunDir);
  float forming = 1.0 - smoothstep(0.0, 0.75, uForm);

  vec3 albedo; vec3 emiss = vec3(0.0); float spec = 0.0; vec3 N = gN;
  vec4 s = texture(uHeight, dir);
  float sea = uSea * smoothstep(0.3, 0.85, uForm);

  if (uType > 4.5 && uType < 5.5){
    albedo = gasGiant(dir);
    float mu = max(dot(gN, V), 0.0);
    albedo *= 0.65 + 0.35 * pow(mu, 0.4); // limb darkening
  } else {
    float h = s.r;
    vec3 up = abs(dir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 T = normalize(cross(up, dir));
    vec3 B = cross(dir, T);
    float e = uTexel * 1.5;
    float hT = texture(uHeight, normalize(dir + T * e)).r;
    float hB = texture(uHeight, normalize(dir + B * e)).r;
    float hc = max(h, sea);
    vec3 nObj = normalize(dir - (T * (max(hT, sea) - hc) + B * (max(hB, sea) - hc)) * uDisp * 1.1 / e);
    N = normalize(uModelRot * nObj);

    float lat = abs(dir.y);
    float elev = (h - sea) / max(1.0 - sea, 0.001);
    float temp = uTemp * 0.85 + 0.35 - pow(lat, 1.5) * 1.05 - max(elev, 0.0) * 0.9 + (s.b - 0.5) * 0.18;
    float moist = clamp(s.g + (uHumid - 0.5) * 0.9 - max(temp - 0.45, 0.0) * 0.8, 0.0, 1.0);

    if (h < sea){
      float depth = (sea - h) / max(sea, 0.001);
      albedo = mix(cShallow, cDeep, smoothstep(0.0, 0.22, depth));
      spec = 1.0;
      if (uType > 3.5 && uType < 4.5){                      // lava seas
        emiss = mix(cShallow, cDeep, smoothstep(0.0, 0.25, depth)) * (0.9 + 0.5 * s.a);
        albedo *= 0.1; spec = 0.0;
      } else {
        float ice = smoothstep(-0.36, -0.5, temp);
        albedo = mix(albedo, cSnow * 0.92, ice);
        spec *= 1.0 - ice;
      }
    } else {
      vec3 c = mix(cDry, cLush, smoothstep(0.3, 0.62, moist));
      c = mix(c, cRock, smoothstep(0.22, 0.62, elev + (s.b - 0.5) * 0.25));
      if (sea > 0.01) c = mix(cBeach, c, smoothstep(0.0, 0.025, elev));
      float snow = smoothstep(-0.18, -0.32, temp);
      c = mix(c, cSnow, snow);
      c *= 0.82 + s.b * 0.36;
      albedo = c;
      if (uType > 3.5 && uType < 4.5){                      // glowing fissures
        float crack = pow(s.a, 7.0);
        emiss += cShallow * crack * 2.2 * (1.0 - smoothstep(0.0, 0.6, elev));
      }
      // cities on the night side
      if (uCiv > 0.0 && temp > -0.25 && temp < 0.6){
        float n1 = snoise(dir * 34.0 + uSeed * 0.01) * 0.5 + 0.5;
        float n2 = snoise(dir * 190.0) * 0.5 + 0.5;
        float coast = 1.0 + 1.6 * smoothstep(0.08, 0.0, elev);
        float thr = 1.0 - uCiv * 0.5;
        float city = smoothstep(thr, thr + 0.07, n1 * coast * 0.8) * smoothstep(0.4, 0.85, n2) * (1.0 - smoothstep(0.3, 0.5, elev));
        float night = smoothstep(0.05, -0.2, ndlGeo);
        emiss += vec3(1.0, 0.6, 0.26) * city * night * 2.4 * uForm;
        albedo = mix(albedo, vec3(0.32), city * 0.35);
      }
    }
    // molten genesis
    albedo = mix(albedo, vec3(0.04, 0.03, 0.03), forming);
    emiss = mix(emiss, vec3(1.0, 0.32, 0.05) * (0.5 + 2.8 * pow(s.a, 3.0)) + vec3(1.0, 0.7, 0.3) * forming * 0.4, forming);
  }

  // lighting
  float term = smoothstep(-0.12, 0.12, ndlGeo);
  float diff = max(dot(N, uSunDir), 0.0) * term;
  float diff2 = max(dot(N, uSun2Dir), 0.0) * smoothstep(-0.12, 0.12, dot(gN, uSun2Dir)) * uBinary;

  float shadow = 1.0;
  if (uClouds > 0.01){
    vec3 cd = normalize(uToCloud * (dir + (transpose(uModelRot) * uSunDir) * 0.012));
    shadow = 1.0 - cloudField(cd, 3) * 0.55;
  }

  vec3 H = normalize(uSunDir + V);
  float sp = pow(max(dot(gN, H), 0.0), 140.0) * 1.6 + pow(max(dot(gN, H), 0.0), 18.0) * 0.06;
  float fres = pow(1.0 - max(dot(gN, V), 0.0), 5.0);

  vec3 col = albedo * (uSunColor * diff * shadow + uSun2Color * diff2 + vec3(0.012, 0.014, 0.02));
  col += uSunColor * sp * spec * term * shadow * (0.6 + fres);
  col += emiss;
  gl_FragColor = vec4(col, 1.0);
}
`;

// ------------------------------------------------------------------ clouds
const CLOUD_VERT = /* glsl */ `
varying vec3 vDir; varying vec3 vN;
void main(){
  vDir = normalize(position);
  vN = normalize(mat3(modelMatrix) * vDir);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const CLOUD_FRAG = /* glsl */ `
${NOISE}
${CLOUDS}
uniform vec3 uSunDir, uSunColor, uCloudColor, uSun2Dir, uSun2Color;
uniform float uForm, uBinary, uOpacity;
varying vec3 vDir; varying vec3 vN;
void main(){
  float c = cloudField(normalize(vDir), 6);
  float ndl = dot(normalize(vN), uSunDir);
  float lit = smoothstep(-0.18, 0.35, ndl);
  vec3 sunset = vec3(1.0, 0.42, 0.16) * smoothstep(0.3, 0.0, abs(ndl - 0.03)) * 0.55;
  vec3 col = uCloudColor * (uSunColor * lit + sunset * lit) + uCloudColor * uSun2Color * smoothstep(-0.1, 0.4, dot(normalize(vN), uSun2Dir)) * uBinary * 0.6;
  col += vec3(0.008, 0.01, 0.016);
  gl_FragColor = vec4(col, c * uOpacity * smoothstep(0.55, 1.0, uForm));
}
`;

// ------------------------------------------------------------------ atmosphere
const ATMO_VERT = /* glsl */ `
varying vec3 vWorldPos;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const ATMO_FRAG = /* glsl */ `
${NOISE}
uniform vec3 uCenter, uSunDir, uSun2Dir, uBeta, uAxis, uAuroraColor;
uniform float uRadius, uAtmoR, uDensity, uSunPower, uBinary, uAurora, uTime, uForm;
varying vec3 vWorldPos;

const int VIEW_STEPS = 14;
const int LIGHT_STEPS = 5;
const float HR = 0.032;
const float HM = 0.014;

vec2 densities(vec3 p){
  float h = max(length(p) - 1.0, 0.0);
  return vec2(exp(-h / HR), exp(-h / HM));
}

void main(){
  vec3 ro = (cameraPosition - uCenter) / uRadius;
  vec3 rd = normalize(vWorldPos - cameraPosition);
  vec2 a = raySphere(ro, rd, uAtmoR);
  if (a.y < 0.0) discard;
  vec2 g = raySphere(ro, rd, 0.999);
  float t0 = max(a.x, 0.0);
  float t1 = g.x > 0.0 ? min(a.y, g.x) : a.y;
  float ds = (t1 - t0) / float(VIEW_STEPS);
  vec3 betaM = vec3(0.35) * uDensity;
  vec3 betaR = uBeta * uDensity;

  vec3 sumR = vec3(0.0), sumM = vec3(0.0), aur = vec3(0.0);
  vec2 od = vec2(0.0);
  float mu = dot(rd, uSunDir);
  for (int i = 0; i < VIEW_STEPS; i++){
    vec3 p = ro + rd * (t0 + ds * (float(i) + 0.5));
    vec2 dens = densities(p) * ds;
    od += dens;
    // light march
    vec2 ls = raySphere(p, uSunDir, uAtmoR);
    float lds = ls.y / float(LIGHT_STEPS);
    vec2 odl = vec2(0.0);
    for (int j = 0; j < LIGHT_STEPS; j++){
      vec3 q = p + uSunDir * lds * (float(j) + 0.5);
      odl += densities(q) * lds;
    }
    float shadow = smoothstep(-0.3, 0.2, dot(normalize(p), uSunDir));
    vec3 tau = betaR * (od.x + odl.x) + betaM * 1.1 * (od.y + odl.y);
    vec3 att = exp(-tau) * shadow;
    sumR += dens.x * att;
    sumM += dens.y * att;

    if (uAurora > 0.5){
      vec3 n = normalize(p);
      float lat = abs(dot(n, uAxis));
      float ring = smoothstep(0.78, 0.86, lat) * smoothstep(0.97, 0.9, lat);
      float hh = length(p) - 1.0;
      float band = smoothstep(0.004, 0.02, hh) * smoothstep(0.09, 0.03, hh);
      float curtain = smoothstep(0.1, 0.7, snoise(n * 9.0 + vec3(0.0, uTime * 0.12, uTime * 0.05)) * 0.5 + 0.5 + snoise(n * 31.0 + uTime * 0.3) * 0.25);
      float dark = 1.0 - smoothstep(-0.25, 0.2, dot(n, uSunDir)) * 0.85;
      aur += uAuroraColor * ring * band * curtain * dark * ds * 34.0 * mix(1.0, 0.4, hh * 10.0);
    }
  }
  float pr = 3.0 / (16.0 * 3.14159) * (1.0 + mu * mu);
  float gg = 0.76;
  float pm = 3.0 / (8.0 * 3.14159) * ((1.0 - gg * gg) * (1.0 + mu * mu)) / ((2.0 + gg * gg) * pow(1.0 + gg * gg - 2.0 * gg * mu, 1.5));
  vec3 col = uSunPower * (sumR * betaR * pr + sumM * betaM * pm);
  if (uBinary > 0.5){
    float mu2 = dot(rd, uSun2Dir);
    col += uSunPower * 0.35 * sumR * betaR * (3.0 / (16.0 * 3.14159) * (1.0 + mu2 * mu2)) * vec3(1.0, 0.6, 0.5);
  }
  col += aur;
  col *= smoothstep(0.5, 1.0, uForm);
  gl_FragColor = vec4(col, 1.0);
}
`;

// ------------------------------------------------------------------ rings
const RING_VERT = /* glsl */ `
varying vec3 vLocal; varying vec3 vWorldPos;
void main(){
  vLocal = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const RING_FRAG = /* glsl */ `
${NOISE}
uniform float uInner, uOuter, uSeedR, uAmount, uRadius, uForm;
uniform vec3 uColA, uColB, uSunDir, uSunColor, uCenter, uNormal;
varying vec3 vLocal; varying vec3 vWorldPos;
void main(){
  float r = length(vLocal.xy);
  float t = (r - uInner) / (uOuter - uInner);
  if (t < 0.0 || t > 1.0) discard;
  float d1 = snoise(vec3(t * 9.0, uSeedR, 0.0)) * 0.5 + 0.5;
  float d2 = snoise(vec3(t * 55.0, uSeedR, 3.0)) * 0.5 + 0.5;
  float d3 = snoise(vec3(t * 180.0, uSeedR, 7.0)) * 0.5 + 0.5;
  float dens = smoothstep(0.15, 0.7, d1) * (0.55 + 0.45 * d2) * (0.75 + 0.25 * d3);
  dens *= smoothstep(0.0, 0.06, t) * smoothstep(1.0, 0.85, t);
  dens *= smoothstep(0.0, 0.02, abs(t - 0.62)) ; // a cassini-like gap
  vec3 col = mix(uColA, uColB, d2);
  // planet shadow
  vec2 hit = raySphere((vWorldPos - uCenter) / uRadius, uSunDir, 1.0);
  float shadow = hit.x > 0.0 ? 0.06 : 1.0;
  float lit = 0.35 + 0.65 * abs(dot(uNormal, uSunDir));
  gl_FragColor = vec4(col * uSunColor * lit * shadow, dens * uAmount * smoothstep(0.6, 1.0, uForm));
}
`;

// ------------------------------------------------------------------ moons
const MOON_FRAG = /* glsl */ `
${NOISE}
uniform vec3 uSunDir, uSunColor, uCenter, uTint;
uniform float uRadius, uSeedM;
varying vec3 vDir; varying vec3 vN; varying vec3 vWorldPos;
void main(){
  vec3 d = normalize(vDir);
  float n = fbm(d * 3.0 + uSeedM, 5) * 0.5 + 0.5;
  float c = ridged(d * 6.0 + uSeedM * 2.0, 4);
  vec3 col = uTint * (0.45 + 0.55 * n) * (0.8 + 0.3 * c);
  float ndl = max(dot(normalize(vN), uSunDir), 0.0);
  vec2 hit = raySphere((vWorldPos - uCenter) / uRadius, uSunDir, 1.0);
  float eclipse = hit.x > 0.0 ? 0.03 : 1.0;
  gl_FragColor = vec4(col * uSunColor * ndl * eclipse + col * 0.01, 1.0);
}
`;
const MOON_VERT = /* glsl */ `
varying vec3 vDir; varying vec3 vN; varying vec3 vWorldPos;
void main(){
  vDir = normalize(position);
  vN = normalize(mat3(modelMatrix) * vDir);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const MEGA_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uTime, uForm;
uniform vec3 uColor;
void main(){
  float a = vUv.x;
  float seg = step(0.5, fract(a * 240.0 + uTime * 0.2));
  float pulse = 0.6 + 0.4 * sin(a * 6.2831 * 3.0 - uTime * 2.0);
  vec3 col = uColor * (0.4 + seg * 2.6 * pulse);
  gl_FragColor = vec4(col * smoothstep(0.8, 1.0, uForm), 1.0);
}
`;

// ------------------------------------------------------------------ accretion particles
const ACC_VERT = /* glsl */ `
attribute vec3 aSeed;
uniform float uProgress, uTime, uPixel;
varying float vAlpha;
void main(){
  float r0 = 2.2 + aSeed.x * 5.5;
  float k = clamp(uProgress * (1.0 + aSeed.y * 0.6), 0.0, 1.0);
  float r = mix(r0, 0.0, k * k);
  float ang = aSeed.z * 6.2831 + uTime * (0.4 + 2.5 / (r + 0.4));
  float y = (aSeed.y - 0.5) * 0.35 * r * (1.0 - k);
  vec3 pos = vec3(cos(ang) * r, y, sin(ang) * r);
  vAlpha = (1.0 - k) * smoothstep(0.0, 0.1, uProgress + 0.02);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = uPixel * (1.5 + aSeed.x * 3.0) * (6.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;
const ACC_FRAG = /* glsl */ `
varying float vAlpha;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(vec3(1.0, 0.55, 0.2) * 2.0 * a * vAlpha, a * vAlpha);
}
`;

const ease = {
  outElastic: x => x === 0 ? 0 : x === 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * (2 * Math.PI) / 3) + 1,
  inOut: x => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2,
  out: x => 1 - Math.pow(1 - x, 3),
};

export class Planet {
  constructor(renderer, { quality = 'high' } = {}) {
    this.renderer = renderer;
    this.group = new THREE.Group();          // system root
    this.tilt = new THREE.Group();
    this.group.add(this.tilt);
    this.time = 0;
    this.genesisT = 1e9;
    this.sunDir = new THREE.Vector3(1, 0.22, 0.32).normalize();
    this.sun2Dir = new THREE.Vector3(-0.8, 0.35, 0.3).normalize();

    const size = quality === 'low' ? 384 : quality === 'mid' ? 640 : 1024;
    const gl = renderer.getContext();
    const canFloat = renderer.capabilities.isWebGL2 && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
    this.cubeRT = new THREE.WebGLCubeRenderTarget(size, {
      type: canFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat, generateMipmaps: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
    });
    this.cubeSize = size;
    this.cubeLow = new THREE.WebGLCubeRenderTarget(192, {
      type: this.cubeRT.texture.type, format: THREE.RGBAFormat, generateMipmaps: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
    });

    this.bakeMat = new THREE.ShaderMaterial({
      fragmentShader: BAKE_FRAG,
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      uniforms: {
        uFace: { value: 0 }, uSize: { value: size }, uSeed: { value: new THREE.Vector3() },
        uScale: { value: 1 }, uWarp: { value: 0.5 }, uMountains: { value: 0.5 }, uRough: { value: 0.5 }, uCraters: { value: 0 },
      },
      depthTest: false, depthWrite: false,
    });
    this.bakeScene = new THREE.Scene();
    this.bakeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bakeMat));
    this.bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const shared = {
      uSunDir: { value: this.sunDir }, uSun2Dir: { value: this.sun2Dir },
      uSunColor: { value: new THREE.Color(1, 0.96, 0.9).multiplyScalar(1.15) },
      uSun2Color: { value: new THREE.Color(1, 0.55, 0.45) },
      uBinary: { value: 0 }, uTime: { value: 0 }, uForm: { value: 1 },
      uCloudSeed: { value: new THREE.Vector3() }, uCover: { value: 0.5 },
    };
    this.shared = shared;

    const detail = quality === 'low' ? 72 : quality === 'mid' ? 110 : 150;
    this.surfaceMat = new THREE.ShaderMaterial({
      vertexShader: SURFACE_VERT, fragmentShader: SURFACE_FRAG,
      uniforms: {
        ...shared,
        uHeight: { value: this.cubeRT.texture }, uTexel: { value: 1 / size },
        uSea: { value: 0.5 }, uDisp: { value: 0.035 }, uTemp: { value: 0 }, uHumid: { value: 0.5 }, uCiv: { value: 0 },
        uType: { value: 0 }, uBands: { value: 12 }, uStorm: { value: 0.5 }, uClouds: { value: 0.5 },
        uSeed: { value: new THREE.Vector3() }, uToCloud: { value: new THREE.Matrix3() }, uModelRot: { value: new THREE.Matrix3() },
        cDeep: { value: new THREE.Color() }, cShallow: { value: new THREE.Color() }, cBeach: { value: new THREE.Color() },
        cLush: { value: new THREE.Color() }, cDry: { value: new THREE.Color() }, cRock: { value: new THREE.Color() }, cSnow: { value: new THREE.Color() },
      },
    });
    this.surface = new THREE.Mesh(new THREE.IcosahedronGeometry(1, detail), this.surfaceMat);
    this.tilt.add(this.surface);

    this.cloudMat = new THREE.ShaderMaterial({
      vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG, transparent: true, depthWrite: false,
      uniforms: { ...shared, uCloudColor: { value: new THREE.Color(1, 1, 1) }, uOpacity: { value: 0.88 } },
    });
    this.clouds = new THREE.Mesh(new THREE.IcosahedronGeometry(1.018, Math.round(detail / 3)), this.cloudMat);
    this.tilt.add(this.clouds);

    this.atmoMat = new THREE.ShaderMaterial({
      vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uSunDir: shared.uSunDir, uSun2Dir: shared.uSun2Dir, uBinary: shared.uBinary, uTime: shared.uTime, uForm: shared.uForm,
        uCenter: { value: new THREE.Vector3() }, uBeta: { value: new THREE.Vector3(1, 2, 4) }, uAxis: { value: new THREE.Vector3(0, 1, 0) },
        uAuroraColor: { value: new THREE.Color(0.2, 1, 0.55) },
        uRadius: { value: 1 }, uAtmoR: { value: 1.13 }, uDensity: { value: 1 }, uSunPower: { value: 9 }, uAurora: { value: 0 },
      },
    });
    this.atmo = new THREE.Mesh(new THREE.IcosahedronGeometry(1.13, 24), this.atmoMat);
    this.atmo.renderOrder = 2;
    this.group.add(this.atmo);

    this.ringMat = new THREE.ShaderMaterial({
      vertexShader: RING_VERT, fragmentShader: RING_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: {
        uSunDir: shared.uSunDir, uSunColor: shared.uSunColor, uForm: shared.uForm,
        uInner: { value: 1.45 }, uOuter: { value: 2.5 }, uSeedR: { value: 0 }, uAmount: { value: 0 }, uRadius: { value: 1 },
        uColA: { value: new THREE.Color() }, uColB: { value: new THREE.Color() }, uCenter: { value: new THREE.Vector3() }, uNormal: { value: new THREE.Vector3(0, 1, 0) },
      },
    });
    this.rings = new THREE.Mesh(new THREE.RingGeometry(1.45, 2.5, 256, 4), this.ringMat);
    this.rings.rotation.x = -Math.PI / 2;
    this.rings.renderOrder = 3;
    this.tilt.add(this.rings);

    this.megaMat = new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: MEGA_FRAG, uniforms: { uTime: shared.uTime, uForm: shared.uForm, uColor: { value: new THREE.Color(0.3, 0.9, 1.0) } },
    });
    this.mega = new THREE.Group();
    const t1 = new THREE.Mesh(new THREE.TorusGeometry(1.24, 0.0045, 6, 512), this.megaMat);
    const t2 = new THREE.Mesh(new THREE.TorusGeometry(1.255, 0.002, 6, 512), this.megaMat);
    t1.rotation.x = t2.rotation.x = Math.PI / 2;
    this.mega.add(t1, t2);
    // spokes
    for (let i = 0; i < 6; i++) {
      const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.0015, 0.0015, 0.23, 4), this.megaMat);
      const a = i / 6 * Math.PI * 2;
      sp.position.set(Math.cos(a) * 1.13, 0, Math.sin(a) * 1.13);
      sp.rotation.z = Math.PI / 2; sp.rotation.y = -a;
      this.mega.add(sp);
    }
    this.tilt.add(this.mega);

    this.moons = [];
    this.moonGroup = new THREE.Group();
    this.group.add(this.moonGroup);

    // accretion swirl for the genesis sequence
    const N = quality === 'low' ? 2500 : 6000;
    const seeds = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) seeds[i] = Math.random();
    const accGeo = new THREE.BufferGeometry();
    accGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    accGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    this.accMat = new THREE.ShaderMaterial({
      vertexShader: ACC_VERT, fragmentShader: ACC_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uProgress: { value: 1 }, uTime: shared.uTime, uPixel: { value: Math.min(2, window.devicePixelRatio) } },
    });
    this.accretion = new THREE.Points(accGeo, this.accMat);
    this.accretion.frustumCulled = false;
    this.accretion.visible = false;
    this.group.add(this.accretion);

    // shockwave
    this.shockMat = new THREE.SpriteMaterial({ map: makeRingTexture(), color: 0xffb070, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 });
    this.shock = new THREE.Sprite(this.shockMat);
    this.group.add(this.shock);

    this.dna = null;
    this.bakeKey = '';
  }

  bake(dna, preview = false) {
    const key = [dna.seedX, dna.seedY, dna.seedZ, dna.continentScale, dna.warp, dna.mountains, dna.roughness, dna.craters].map(v => (+v).toFixed(4)).join('|') + (preview ? 'p' : '');
    if (key === this.bakeKey) return;
    this.bakeKey = key;
    const target = preview ? this.cubeLow : this.cubeRT;
    const res = preview ? 192 : this.cubeSize;
    this.surfaceMat.uniforms.uHeight.value = target.texture;
    this.surfaceMat.uniforms.uTexel.value = 1 / res;
    const u = this.bakeMat.uniforms;
    u.uSize.value = res;
    u.uSeed.value.set(dna.seedX % 200, dna.seedY % 200, dna.seedZ % 200);
    u.uScale.value = dna.continentScale; u.uWarp.value = dna.warp; u.uMountains.value = dna.mountains;
    u.uRough.value = dna.roughness; u.uCraters.value = dna.craters;
    const prev = this.renderer.getRenderTarget();
    const prevAuto = this.renderer.autoClear;
    for (let f = 0; f < 6; f++) {
      u.uFace.value = f;
      this.renderer.setRenderTarget(target, f);
      this.renderer.render(this.bakeScene, this.bakeCam);
    }
    this.renderer.setRenderTarget(prev);
    this.renderer.autoClear = prevAuto;
  }

  setDNA(dna, { genesis = false, preview = false } = {}) {
    this.dna = { ...dna };
    if (dna.type !== 'gas') this.bake(dna, preview);
    const pal = paletteFor(dna);
    const shift = dna.hueShift || 0;
    const col = (hex, target) => { target.set(hex); if (shift) target.offsetHSL(shift, 0, 0); return target; };
    const s = this.surfaceMat.uniforms;
    const isGas = dna.type === 'gas';
    if (isGas) {
      col(pal[0], s.cDeep.value); col(pal[1], s.cShallow.value); col(pal[2], s.cBeach.value); col(pal[3], s.cLush.value);
    } else {
      [s.cDeep, s.cShallow, s.cBeach, s.cLush, s.cDry, s.cRock, s.cSnow].forEach((u, i) => col(pal[i], u.value));
    }
    s.uType.value = TYPE_ID[dna.type];
    s.uSea.value = dna.seaLevel;
    s.uDisp.value = isGas ? 0 : 0.03 + dna.mountains * 0.025;
    s.uTemp.value = dna.temperature;
    s.uHumid.value = dna.humidity;
    s.uCiv.value = dna.civ;
    s.uBands.value = dna.bands;
    s.uStorm.value = dna.storm;
    s.uClouds.value = isGas ? 0 : dna.clouds;
    s.uSeed.value.set(dna.seedX % 200, dna.seedY % 200, dna.seedZ % 200);

    this.shared.uCover.value = dna.clouds;
    this.shared.uCloudSeed.value.set(dna.seedZ % 97, dna.seedX % 97, dna.seedY % 97);
    this.shared.uBinary.value = dna.binary ? 1 : 0;
    this.clouds.visible = !isGas && dna.clouds > 0.01;
    const cc = this.cloudMat.uniforms.uCloudColor.value;
    if (dna.type === 'lava') cc.setRGB(0.18, 0.15, 0.14);
    else if (dna.type === 'toxic') cc.set('#e8f0c8').offsetHSL(dna.atmoHue - 0.2, 0, 0);
    else if (dna.type === 'desert') cc.set('#f2e2cc');
    else cc.setRGB(0.92, 0.93, 0.95);

    // atmosphere: scattering coefficients biased toward the chosen sky colour
    const a = this.atmoMat.uniforms;
    const sky = new THREE.Color().setHSL(dna.atmoHue, 0.85, 0.55);
    a.uBeta.value.set(0.15 + sky.r * 3.2, 0.15 + sky.g * 3.2, 0.15 + sky.b * 3.2);
    a.uDensity.value = Math.pow(dna.atmosphere, 1.3) * (isGas ? 1.4 : 1.15);
    a.uAtmoR.value = isGas ? 1.09 : 1.13;
    this.atmo.visible = dna.atmosphere > 0.02;
    a.uAurora.value = dna.aurora ? 1 : 0;
    a.uAuroraColor.value.setHSL((0.38 + dna.ringHue * 0.5) % 1, 0.9, 0.55);

    // rings
    const r = this.ringMat.uniforms;
    this.rings.visible = dna.rings > 0.01;
    r.uAmount.value = Math.min(1, 0.35 + dna.rings * 0.75);
    const inner = isGas ? 1.3 : 1.4, outer = inner + 0.6 + dna.rings * 1.2;
    r.uInner.value = inner; r.uOuter.value = outer;
    this.rings.geometry.dispose();
    this.rings.geometry = new THREE.RingGeometry(inner, outer, 256, 4);
    r.uSeedR.value = (dna.seedX % 50);
    r.uColA.value.setHSL(dna.ringHue, 0.35, 0.72);
    r.uColB.value.setHSL((dna.ringHue + 0.08) % 1, 0.25, 0.5);

    this.mega.visible = !!dna.megastructure;
    this.megaMat.uniforms.uColor.value.setHSL((dna.atmoHue + 0.5) % 1, 0.8, 0.6);

    this.tilt.rotation.z = dna.tilt;
    this.buildMoons(dna);

    if (genesis) this.startGenesis();
  }

  buildMoons(dna) {
    for (const m of this.moons) { m.mesh.geometry.dispose(); m.mesh.material.dispose(); this.moonGroup.remove(m.pivot); }
    this.moons = [];
    const n = Math.round(dna.moons);
    for (let i = 0; i < n; i++) {
      const rr = (k) => { const x = Math.sin((dna.seedX + i * 13.7 + k * 7.1) * 12.9898) * 43758.5453; return x - Math.floor(x); };
      const size = 0.06 + rr(1) * 0.12;
      const mat = new THREE.ShaderMaterial({
        vertexShader: MOON_VERT, fragmentShader: MOON_FRAG,
        uniforms: {
          uSunDir: this.shared.uSunDir, uSunColor: this.shared.uSunColor, uCenter: { value: new THREE.Vector3() }, uRadius: { value: 1 },
          uTint: { value: new THREE.Color().setHSL(rr(2), 0.15 + rr(3) * 0.2, 0.45 + rr(4) * 0.25) }, uSeedM: { value: rr(5) * 100 },
        },
      });
      const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 12), mat);
      const pivot = new THREE.Group();
      pivot.rotation.x = (rr(6) - 0.5) * 0.5 + dna.tilt * 0.5;
      pivot.rotation.z = (rr(7) - 0.5) * 0.4;
      const dist = 2.2 + i * 0.75 + rr(8) * 0.5 + (dna.rings > 0 ? 1.0 + dna.rings : 0);
      mesh.position.set(dist, 0, 0);
      pivot.add(mesh);
      this.moonGroup.add(pivot);
      this.moons.push({ pivot, mesh, speed: 0.25 / Math.pow(dist, 1.5) * (rr(9) > 0.15 ? 1 : -1), phase: rr(10) * Math.PI * 2 });
    }
  }

  startGenesis() {
    this.genesisT = 0;
    this.accretion.visible = true;
  }

  get isForming() { return this.genesisT < 6; }

  // a shockwave ring without re-forming the planet (used to celebrate a claim)
  pulse() { this.pulseT = 0; }

  update(dt) {
    this.time += dt;
    const sh = this.shared;
    sh.uTime.value = this.time;
    const dna = this.dna;
    if (!dna) return;

    // genesis timeline
    if (this.genesisT < 1e8) {
      this.genesisT += dt;
      const t = this.genesisT;
      this.accMat.uniforms.uProgress.value = Math.min(1, t / 1.6);
      const sc = t < 0.9 ? 0.0001 : 0.08 + 0.92 * ease.outElastic(Math.min(1, (t - 0.9) / 1.8));
      this.group.scale.setScalar(Math.max(0.0001, sc));
      // accretion particles live in unscaled space, counter-scale them
      this.accretion.scale.setScalar(1 / Math.max(0.0001, sc));
      sh.uForm.value = Math.min(1, Math.max(0, (t - 1.2) / 4.2));
      const k = Math.max(0, t - 0.95);
      this.shockMat.opacity = k > 0 ? Math.max(0, 1 - k / 1.4) * 0.9 : 0;
      this.shock.scale.setScalar((0.5 + k * 9) / Math.max(0.08, sc));
      if (t > 1.7) this.accretion.visible = false;
      if (t > 6) { this.genesisT = 1e9; this.group.scale.setScalar(1); sh.uForm.value = 1; this.shockMat.opacity = 0; }
    }

    if (this.pulseT !== undefined && this.pulseT < 1.6) {
      this.pulseT += dt;
      this.shockMat.opacity = Math.max(0, 1 - this.pulseT / 1.6) * 0.8;
      this.shock.scale.setScalar(1 + this.pulseT * 9);
    }

    const spin = dna.spin * 0.06;
    this.surface.rotation.y += spin * dt;
    this.clouds.rotation.y += spin * 1.18 * dt;
    this.mega.rotation.y -= dt * 0.02;

    this.group.updateMatrixWorld(true);
    // cloud-space transform for shadows
    const pm = new THREE.Matrix4().copy(this.surface.matrixWorld);
    const cmInv = new THREE.Matrix4().copy(this.clouds.matrixWorld).invert();
    this.surfaceMat.uniforms.uToCloud.value.setFromMatrix4(cmInv.multiply(pm));
    this.surfaceMat.uniforms.uModelRot.value.setFromMatrix4(this.surface.matrixWorld);

    const center = new THREE.Vector3().setFromMatrixPosition(this.group.matrixWorld);
    const radius = this.group.scale.x;
    const a = this.atmoMat.uniforms;
    a.uCenter.value.copy(center); a.uRadius.value = radius;
    a.uAxis.value.set(0, 1, 0).applyQuaternion(this.tilt.getWorldQuaternion(new THREE.Quaternion()));
    this.atmo.scale.setScalar(a.uAtmoR.value / 1.13);
    const r = this.ringMat.uniforms;
    r.uCenter.value.copy(center); r.uRadius.value = radius; r.uNormal.value.copy(a.uAxis.value);

    for (const m of this.moons) {
      m.pivot.rotation.y = m.phase + this.time * m.speed;
      m.mesh.rotation.y += dt * 0.05;
      m.mesh.material.uniforms.uCenter.value.copy(center);
      m.mesh.material.uniforms.uRadius.value = radius;
    }
  }

  dispose() {
    this.cubeRT.dispose(); this.cubeLow.dispose();
    this.group.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); });
  }
}

function makeRingTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 60, 128, 128, 128);
  grd.addColorStop(0, 'rgba(255,255,255,0)');
  grd.addColorStop(0.75, 'rgba(255,255,255,0.0)');
  grd.addColorStop(0.9, 'rgba(255,255,255,1)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function makeGlowTexture(inner = 'rgba(255,255,255,1)', mid = 'rgba(255,220,180,0.35)') {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.08, inner);
  grd.addColorStop(0.25, mid);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
