// A living planet: GPU-baked cubemap terrain, procedural surface shading, animated clouds,
// a raymarched scattering atmosphere, rings, moons, megastructures and a genesis sequence.
import * as THREE from 'three';
import { NOISE, CLOUDS } from './glsl.js';
import { paletteFor, civLightColor } from './dna.js';

const TYPE_ID = { terran: 0, ocean: 1, desert: 2, ice: 3, lava: 4, gas: 5, barren: 6, toxic: 7 };

// where a singularity companion hangs in the sky (upper right of the opening shot, clear of the dossier)
export const BH_DIR = new THREE.Vector3(0.24, 0.13, -1).normalize();

// cellular noise on a sphere direction: x = distance to nearest cell, y = second nearest, z = cell hash
const VORONOI = /* glsl */ `
vec3 voronoi(vec3 p){
  vec3 b = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
    vec3 g = vec3(float(i), float(j), float(k));
    vec3 o = fract(sin(vec3(dot(b + g, vec3(127.1, 311.7, 74.7)), dot(b + g, vec3(269.5, 183.3, 246.1)), dot(b + g, vec3(113.5, 271.9, 124.6)))) * 43758.5453);
    float d = length(g + o - f);
    if (d < d1){ d2 = d1; d1 = d; id = fract(o.x * 7.13 + o.y * 3.71); } else if (d < d2) d2 = d;
  }
  return vec3(d1, d2, id);
}
`;

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
${VORONOI}
uniform samplerCube uHeight;
uniform float uSea, uDisp, uForm, uAnomaly, uTime;
uniform vec3 uSeed;
varying vec3 vDir;
varying vec3 vWorldPos;
void main(){
  vDir = normalize(position);
  vec3 look = vDir;
  if (uAnomaly > 2.5 && uAnomaly < 3.5) look = normalize(floor(vDir * 48.0) / 48.0 + 0.5 / 48.0);
  float h = textureLod(uHeight, look, 0.0).r;
  float sea = uSea * smoothstep(0.3, 0.85, uForm);
  float lift = max(h - sea, 0.0) * uDisp;
  if (uAnomaly > 1.5 && uAnomaly < 2.5){
    vec3 v = voronoi(vDir * 3.2 + uSeed * 0.01);
    lift -= (1.0 - smoothstep(0.0, 0.16, v.y - v.x)) * 0.06 * uForm;
  }
  vec3 pos = vDir * (1.0 + lift);
  if (uAnomaly > 2.5 && uAnomaly < 3.5){
    float tick = floor(uTime * 5.0);
    float jump = step(0.93, fract(sin(tick * 91.7) * 43758.5));
    float row = step(0.7, fract(sin(floor(vDir.y * 14.0) * 17.3 + tick) * 43758.5));
    pos.x += jump * row * 0.035;
  }
  vec4 wp = modelMatrix * vec4(pos, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SURFACE_FRAG = /* glsl */ `
${NOISE}
${CLOUDS}
${VORONOI}
uniform samplerCube uHeight;
uniform float uTexel, uSea, uDisp, uForm, uTemp, uHumid, uCiv, uType, uBands, uStorm, uClouds, uAnomaly;
uniform vec3 uCivColor;
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
  bool glitch = uAnomaly > 2.5 && uAnomaly < 3.5;
  if (glitch) dir = normalize(floor(dir * 48.0) / 48.0 + 0.5 / 48.0);
  vec3 gN = normalize(uModelRot * normalize(vDir));
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
      // ---- civilisation: grows from firelight to planet-spanning networks
      if (uCiv > 0.11 && temp > -0.3 && temp < 0.62){
        float night = smoothstep(0.08, -0.22, ndlGeo);
        float habitable = (1.0 - smoothstep(0.28, 0.5, elev)) * smoothstep(-0.3, -0.18, temp) * (1.0 - smoothstep(0.5, 0.62, temp));
        float coastal = smoothstep(0.07, 0.0, elev);
        // pixel footprint, to fade detail finer than a pixel instead of shimmering
        float px = length(fwidth(dir));
        float fine = 1.0 - smoothstep(0.0015, 0.005, px);

        // where people live: large-scale density favouring coasts and lowlands
        float d1 = snoise(dir * 9.0 + uSeed * 0.013) * 0.5 + 0.5;
        float d2 = snoise(dir * 27.0 + uSeed * 0.021) * 0.5 + 0.5;
        float density = (d1 * 0.62 + d2 * 0.38 + coastal * 0.32) * habitable;
        float thr = 0.86 - uCiv * 0.42;
        float region = smoothstep(thr, thr + 0.14, density);
        float core = smoothstep(thr + 0.12, thr + 0.3, density);

        // individual towns: two scales of speckle
        float s1 = snoise(dir * 150.0 + uSeed * 0.05) * 0.5 + 0.5;
        float s2 = snoise(dir * 430.0 - uSeed * 0.03) * 0.5 + 0.5;
        float towns = smoothstep(0.62, 0.9, s1) * 0.9 + smoothstep(0.66, 0.92, s2) * 0.75 * fine;
        float early = 1.0 - smoothstep(0.12, 0.3, uCiv);           // sparse campfires at first
        float specks = smoothstep(0.5, 0.66, density) * (smoothstep(0.84, 0.95, s1) * 0.9 + smoothstep(0.78, 0.94, s2) * 0.5 * fine);
        float lights = mix(region * towns, specks, early) + core * (0.12 + 0.55 * smoothstep(0.35, 0.85, s2 * fine + s1 * (1.0 - fine))) * (1.0 - early);

        // roads (planetary and beyond): thin glowing filaments between settlements
        float roads = 0.0;
        if (uCiv > 0.45){
          float r1 = 1.0 - smoothstep(0.0, 0.018, abs(snoise(dir * 13.0 + uSeed * 0.031)));
          float r2 = 1.0 - smoothstep(0.0, 0.014, abs(snoise(dir * 31.0 - uSeed * 0.017)));
          roads = max(r1, r2 * 0.7) * smoothstep(thr - 0.2, thr + 0.05, density) * smoothstep(0.45, 0.6, uCiv) * (0.55 + 0.45 * fine);
        }
        // spacefaring worlds light up whole continents
        float sprawl = smoothstep(0.68, 0.95, uCiv) * smoothstep(thr - 0.1, thr + 0.2, density) * 0.12 * (0.5 + s1);

        float glow = (lights * 2.1 + roads * 0.9 + sprawl) * night;
        emiss += uCivColor * glow * uForm;

        // daytime footprint: grey cities, farmland stripes, industrial haze
        float day = 1.0 - night;
        if (uCiv > 0.3){
          float farmBand = smoothstep(thr - 0.25, thr, density) * (1.0 - region) * smoothstep(0.3, 0.42, uCiv);
          float stripes = step(0.5, fract(dot(dir, vec3(91.0, 57.0, 73.0)) + snoise(dir * 18.0) * 0.6));
          albedo = mix(albedo, albedo * mix(vec3(1.18, 1.12, 0.78), vec3(0.82, 0.95, 0.7), stripes), farmBand * 0.45 * day);
          float haze = region * smoothstep(0.3, 0.45, uCiv) * (1.0 - smoothstep(0.75, 0.9, uCiv));
          albedo = mix(albedo, vec3(0.42, 0.38, 0.33), haze * 0.22 * day);
        }
        albedo = mix(albedo, vec3(0.3, 0.3, 0.32), (region * 0.3 + core * 0.3) * smoothstep(0.2, 0.5, uCiv));
      }
    }
    // shipping lanes across dark oceans
      if (uCiv > 0.5 && h < sea && uType < 3.5){
        float lane = 1.0 - smoothstep(0.0, 0.006, abs(snoise(dir * 3.2 + uSeed * 0.07)));
        lane *= smoothstep(0.15, 0.45, snoise(dir * 1.7 - uSeed * 0.05));        // only some routes
        float ships = smoothstep(0.7, 0.92, snoise(dir * 260.0 + vec3(uTime * 0.008)) * 0.5 + 0.5);
        float depthOk = 1.0 - smoothstep(0.3, 0.6, (sea - h) / max(sea, 0.001));
        float night = smoothstep(0.08, -0.22, ndlGeo);
        emiss += uCivColor * lane * (0.06 + ships * 1.6) * depthOk * night * smoothstep(0.5, 0.65, uCiv) * uForm;
      }
    // ---- anomalies
    if (uAnomaly > 0.5 && uAnomaly < 1.5){                 // crystal: faceted, prismatic, lit from within
      vec3 v = voronoi(dir * 12.0 + uSeed * 0.01);
      vec3 v2 = voronoi(dir * 4.0 - uSeed * 0.02);
      float seam = 1.0 - smoothstep(0.0, 0.035, v.y - v.x);
      float fresC = pow(1.0 - max(dot(gN, V), 0.0), 2.0);
      vec3 facet = hash33(vec3(v.z * 91.0, v2.z * 37.0, 3.1)) * 2.0 - 1.0;
      vec3 Nf = normalize(N + uModelRot * facet * 0.5);
      float hue = fract(v2.z * 0.35 + v.z * 0.12 + dot(Nf, V) * 0.9 + uTime * 0.01);
      vec3 irid = 0.5 + 0.5 * cos(6.2831 * (hue + vec3(0.0, 0.33, 0.67)));
      bool wet = h < sea;
      albedo = wet ? mix(vec3(0.05, 0.03, 0.12), irid * 0.2, 0.3) : mix(vec3(0.7, 0.76, 0.88), irid, 0.22 + 0.5 * fresC) * (0.75 + 0.25 * (1.0 - seam));
      spec = wet ? 1.0 : 0.0;
      if (!wet){
        N = Nf;
        vec3 Hf = normalize(uSunDir + V);
        float glint = pow(max(dot(Nf, Hf), 0.0), 90.0) * smoothstep(-0.05, 0.2, ndlGeo);
        emiss += (uSunColor * 1.6 + irid * 0.6) * glint * uForm;
      }
      float night = smoothstep(0.1, -0.25, ndlGeo);
      emiss += irid * (seam * 0.7 + 0.04) * (0.1 + 0.9 * night) * uForm;
    } else if (uAnomaly > 1.5 && uAnomaly < 2.5){          // shattered: plates split by glowing seams
      vec3 v = voronoi(dir * 3.2 + uSeed * 0.01);
      vec3 w = voronoi(dir * 11.0 - uSeed * 0.02);
      float big = 1.0 - smoothstep(0.0, 0.16, v.y - v.x);
      float core = 1.0 - smoothstep(0.0, 0.05, v.y - v.x);
      float fine = (1.0 - smoothstep(0.0, 0.035, w.y - w.x)) * (1.0 - smoothstep(0.0, 0.55, v.y - v.x));
      albedo = mix(albedo * 0.55, vec3(0.06, 0.03, 0.02), big);
      spec *= 1.0 - big;
      float pulse = 0.85 + 0.15 * sin(uTime * 1.3 + v.z * 20.0);
      emiss += (vec3(1.0, 0.3, 0.05) * big * 1.4 + vec3(1.0, 0.75, 0.4) * core * 2.6 + vec3(1.0, 0.4, 0.1) * fine * 0.9) * pulse * uForm;
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
  if (glitch){
    float tick = floor(uTime * 7.0);
    col = floor(col * 6.0 + 0.5) / 6.0;                                    // posterised
    float tear = fract(sin(floor(dir.y * 26.0) * 12.9898 + tick * 4.1) * 43758.5);
    if (tear > 0.9) col = col.gbr * 1.5;                                    // torn scanline bands
    vec3 q = floor(dir * 150.0);
    float chk = mod(q.x + q.y + q.z, 2.0);
    float lost = step(0.955, hash33(floor(dir * 7.0) + floor(uTime * 1.1)).y); // missing texture blocks
    col = mix(col, mix(vec3(0.02), vec3(1.2, 0.0, 1.1), chk), lost);
    vec3 g = abs(fract(normalize(vDir) * 48.0) - 0.5);
    float grid = smoothstep(0.46, 0.5, max(g.x, max(g.y, g.z)));
    col += vec3(0.0, 1.0, 0.85) * grid * (0.05 + 0.5 * smoothstep(0.05, -0.25, ndlGeo)) * uForm;
    col *= 0.86 + 0.14 * step(0.5, fract(gl_FragCoord.y * 0.5));
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

// shattered worlds: tumbling chunks of the planet's own crust
const DEBRIS_VERT = /* glsl */ `
${NOISE}
attribute vec4 aSpin;
attribute float aHot;
uniform float uTime;
varying vec3 vN; varying vec3 vWorldPos; varying float vHot;
void main(){
  float a = uTime * aSpin.w;
  vec3 k = normalize(aSpin.xyz);
  vec3 p = rotateAxis(position, k, a);
  vec3 n = rotateAxis(normal, k, a);
  vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * n);
  vHot = aHot;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const DEBRIS_FRAG = /* glsl */ `
${NOISE}
uniform vec3 uSunDir, uSunColor, uCenter;
uniform float uRadius, uForm;
varying vec3 vN; varying vec3 vWorldPos; varying float vHot;
void main(){
  vec3 N = normalize(vN);
  vec2 hit = raySphere(vWorldPos - uCenter, uSunDir, uRadius);
  float lit = hit.y > 0.0 ? 0.0 : 1.0;
  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 rock = vec3(0.32, 0.27, 0.24);
  vec3 col = rock * uSunColor * ndl * lit + rock * 0.02;
  col += vec3(1.0, 0.38, 0.08) * vHot * (0.6 + 0.4 * (1.0 - ndl)) * 1.6;
  gl_FragColor = vec4(col * smoothstep(0.7, 1.0, uForm), 1.0);
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

// ------------------------------------------------------------------ satellites and stations
// Each point orbits on its own inclined ring; it glints in sunlight and drops to a
// faint blinking beacon while it crosses the planet's shadow.
const SAT_VERT = /* glsl */ `
attribute vec4 aOrbit;    // radius, inclination, ascending node, phase
attribute vec2 aInfo;     // angular speed, kind (0 satellite, 1 station)
uniform float uTime, uPixel, uForm;
uniform vec3 uSunLocal;
varying float vLit; varying float vKind; varying float vBlink;

vec2 raySphereS(vec3 ro, vec3 rd, float r){
  float b = dot(ro, rd); float c = dot(ro, ro) - r * r; float h = b * b - c;
  if (h < 0.0) return vec2(-1.0); h = sqrt(h); return vec2(-b - h, -b + h);
}
void main(){
  float a = aOrbit.w + uTime * aInfo.x;
  vec3 p = vec3(cos(a), 0.0, sin(a)) * aOrbit.x;
  float ci = cos(aOrbit.y), si = sin(aOrbit.y);
  p = vec3(p.x, p.y * ci - p.z * si, p.y * si + p.z * ci);
  float cn = cos(aOrbit.z), sn = sin(aOrbit.z);
  p = vec3(p.x * cn + p.z * sn, p.y, -p.x * sn + p.z * cn);
  vec2 hit = raySphereS(p, uSunLocal, 1.0);
  vLit = hit.x > 0.0 ? 0.0 : 1.0;
  vKind = aInfo.y;
  vBlink = step(0.86, fract(uTime * (0.35 + aOrbit.w * 0.05) + aOrbit.w));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float size = aInfo.y > 0.5 ? 10.0 : 4.6;
  gl_PointSize = clamp(size * uPixel * (4.0 / -mv.z), 1.5 * uPixel, 24.0 * uPixel) * smoothstep(0.85, 1.0, uForm);
  gl_Position = projectionMatrix * mv;
}`;
const SAT_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vLit; varying float vKind; varying float vBlink;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float core = smoothstep(0.5, 0.0, d);
  vec3 col;
  float a;
  if (vKind > 0.5){
    // stations: a bright core with a cross-shaped glint
    float cross = (smoothstep(0.06, 0.0, abs(c.x)) + smoothstep(0.06, 0.0, abs(c.y))) * smoothstep(0.5, 0.1, d);
    col = mix(vec3(1.0, 0.85, 0.55), uColor, 0.3) * (core * 1.6 + cross) * mix(0.25, 1.6, vLit);
    a = clamp(core + cross, 0.0, 1.0);
  } else {
    col = vec3(0.85, 0.92, 1.0) * core * core * mix(0.22, 2.6, vLit) + vec3(1.0, 0.2, 0.15) * core * vBlink * (1.0 - vLit) * 1.2;
    a = core;
  }
  gl_FragColor = vec4(col, a);
}`;

// ------------------------------------------------------------------ rockets
// A handful of launches climbing from the surface on repeating, staggered schedules.
// Each rocket is a short trail of points sampled back along its own path.
const ROCKET_VERT = /* glsl */ `
attribute vec3 aSite;       // launch direction on the surface
attribute vec3 aPath;       // tangent the trajectory bends toward
attribute vec2 aTiming;     // schedule offset, trail index (0 = head)
uniform float uTime, uPixel, uForm;
varying float vHead; varying float vFade;
void main(){
  float period = 11.0;
  float t = mod(uTime + aTiming.x, period) - aTiming.y * 0.07;
  float k = clamp(t / 4.5, 0.0, 1.0);                 // 4.5 s climb, then quiet
  float alt = k * k * 0.42;
  vec3 p = normalize(aSite + aPath * k * k * 0.9) * (1.004 + alt);
  vHead = 1.0 - aTiming.y / 10.0;
  vFade = (t > 0.0 && t < 4.5 ? 1.0 : 0.0) * (1.0 - k * 0.6) * smoothstep(0.9, 1.0, uForm);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp((aTiming.y < 0.5 ? 7.0 : 4.0 * vHead) * uPixel * (4.0 / -mv.z), 1.0, 30.0);
  gl_Position = projectionMatrix * mv;
}`;
const ROCKET_FRAG = /* glsl */ `
varying float vHead; varying float vFade;
void main(){
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d) * vFade * vHead;
  vec3 col = mix(vec3(1.0, 0.45, 0.12), vec3(1.0, 0.95, 0.8), vHead * vHead) * 2.6;
  gl_FragColor = vec4(col * a, a);
}`;

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

const SUN2_DEFAULT = new THREE.Vector3(-0.8, 0.35, 0.3).normalize();
const SUN2_LIGHT = new THREE.Color(1, 0.55, 0.45);
const BH_LIGHT = new THREE.Color(1, 0.45, 0.16).multiplyScalar(0.45);

export class Planet {
  constructor(renderer, { quality = 'high' } = {}) {
    this.renderer = renderer;
    this.group = new THREE.Group();          // system root
    this.tilt = new THREE.Group();
    this.group.add(this.tilt);
    this.time = 0;
    this.genesisT = 1e9;
    this.sunDir = new THREE.Vector3(1, 0.22, 0.32).normalize();
    this.sun2Dir = SUN2_DEFAULT.clone();

    this.quality = quality;
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
      uSun2Color: { value: SUN2_LIGHT.clone() },
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
        uAnomaly: { value: 0 }, uType: { value: 0 }, uCivColor: { value: new THREE.Color(1, 0.62, 0.28) }, uBands: { value: 12 }, uStorm: { value: 0.5 }, uClouds: { value: 0.5 },
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

    this.civGroup = new THREE.Group();     // satellites orbit with the tilt, not the spin
    this.tilt.add(this.civGroup);
    this.civUniforms = { uTime: this.shared.uTime, uForm: this.shared.uForm, uPixel: { value: Math.min(2, window.devicePixelRatio) }, uSunLocal: { value: new THREE.Vector3(1, 0, 0) }, uColor: { value: new THREE.Color() } };
    this.civKey = '';

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
    s.uCivColor.value.setRGB(...civLightColor(dna));
    this.civUniforms.uColor.value.setRGB(...civLightColor(dna));
    s.uBands.value = dna.bands;
    s.uStorm.value = dna.storm;
    s.uClouds.value = isGas ? 0 : dna.clouds;
    s.uSeed.value.set(dna.seedX % 200, dna.seedY % 200, dna.seedZ % 200);

    this.shared.uCover.value = dna.clouds;
    this.shared.uCloudSeed.value.set(dna.seedZ % 97, dna.seedX % 97, dna.seedY % 97);
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

    // anomalies
    s.uAnomaly.value = dna.anomaly || 0;
    const sing = dna.anomaly === 4;
    this.sun2Dir.copy(sing ? BH_DIR : SUN2_DEFAULT);
    this.shared.uSun2Color.value.copy(sing ? BH_LIGHT : SUN2_LIGHT);
    this.shared.uBinary.value = dna.binary || sing ? 1 : 0;
    this.buildDebris(dna);

    this.tilt.rotation.z = dna.tilt;
    this.buildMoons(dna);
    this.buildCiv(dna);

    if (genesis) this.startGenesis();
  }

  // Spacefaring worlds get satellites, a few stations and regular launches.
  buildCiv(dna) {
    const level = dna.type === 'gas' ? 0 : dna.civ;
    const key = `${level.toFixed(2)}|${dna.seedX}`;
    if (key === this.civKey) return;
    this.civKey = key;
    for (const o of [...this.civGroup.children]) { o.geometry.dispose(); o.material.dispose(); this.civGroup.remove(o); }
    if (this.rockets) { this.rockets.geometry.dispose(); this.rockets.material.dispose(); this.surface.remove(this.rockets); this.rockets = null; }
    if (level < 0.7) return;

    let seed = Math.abs(Math.floor(dna.seedX * 1000)) + 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

    // satellites + stations
    const sats = Math.round(70 + (level - 0.7) * 700);
    const stations = level > 0.86 ? 5 : 2;
    const n = sats + stations;
    const orbit = new Float32Array(n * 4), info = new Float32Array(n * 2);
    const shells = [1.06, 1.1, 1.16, 1.3];           // low orbit bands plus a high band
    for (let i = 0; i < n; i++) {
      const station = i >= sats;
      const band = station ? 1.12 + rnd() * 0.08 : shells[Math.floor(rnd() * shells.length)] + rnd() * 0.03;
      const inc = station ? rnd() * 0.5 : (rnd() < 0.3 ? 1.4 + rnd() * 0.3 : rnd() * 1.1);   // some near-polar
      orbit.set([band, inc, rnd() * Math.PI * 2, rnd() * Math.PI * 2], i * 4);
      info.set([(0.22 / Math.pow(band, 1.5)) * (rnd() < 0.12 ? -1 : 1), station ? 1 : 0], i * 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aOrbit', new THREE.BufferAttribute(orbit, 4));
    g.setAttribute('aInfo', new THREE.BufferAttribute(info, 2));
    const satMat = new THREE.ShaderMaterial({ vertexShader: SAT_VERT, fragmentShader: SAT_FRAG, uniforms: this.civUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const satPoints = new THREE.Points(g, satMat);
    satPoints.frustumCulled = false;
    satPoints.renderOrder = 4;
    this.civGroup.add(satPoints);

    // rockets: launch sites scattered at mid latitudes, trails of 10 points each
    const rockets = level > 0.86 ? 6 : 3, trail = 10;
    const m = rockets * trail;
    const site = new Float32Array(m * 3), path = new Float32Array(m * 3), timing = new Float32Array(m * 2);
    for (let r = 0; r < rockets; r++) {
      const lat = (rnd() - 0.5) * 1.2, lon = rnd() * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
      const east = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
      const offset = rnd() * 11;
      for (let k = 0; k < trail; k++) {
        const i = r * trail + k;
        site.set([dir.x, dir.y, dir.z], i * 3);
        path.set([east.x, east.y, east.z], i * 3);
        timing.set([offset, k], i * 2);
      }
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m * 3), 3));
    rg.setAttribute('aSite', new THREE.BufferAttribute(site, 3));
    rg.setAttribute('aPath', new THREE.BufferAttribute(path, 3));
    rg.setAttribute('aTiming', new THREE.BufferAttribute(timing, 2));
    this.rockets = new THREE.Points(rg, new THREE.ShaderMaterial({ vertexShader: ROCKET_VERT, fragmentShader: ROCKET_FRAG, uniforms: this.civUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.rockets.frustumCulled = false;
    this.rockets.renderOrder = 4;
    this.surface.add(this.rockets);                    // launch sites turn with the planet
  }

  // a shattered world drags a river of its own crust around with it
  buildDebris(dna) {
    const want = dna.anomaly === 2 ? String(dna.seedX) : '';
    if (want === this.debrisKey) return;
    this.debrisKey = want;
    if (this.debris) { this.debris.geometry.dispose(); this.debris.material.dispose(); this.tilt.remove(this.debris); this.debris = null; }
    if (!want) return;
    let seed = Math.abs(Math.floor(dna.seedX * 977)) + 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const n = this.quality === 'low' ? 350 : 900;
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const spin = new Float32Array(n * 4), hot = new Float32Array(n);
    const mesh = new THREE.InstancedMesh(geo, new THREE.ShaderMaterial({
      vertexShader: DEBRIS_VERT, fragmentShader: DEBRIS_FRAG,
      uniforms: { uTime: this.shared.uTime, uForm: this.shared.uForm, uSunDir: this.shared.uSunDir, uSunColor: this.shared.uSunColor, uCenter: { value: new THREE.Vector3() }, uRadius: { value: 1 } },
    }), n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      // a lumpy torus, densest in the middle, with a few strays far out
      const a = rnd() * Math.PI * 2;
      const r = 1.35 + Math.pow(rnd(), 1.6) * 0.9 + (rnd() < 0.05 ? rnd() * 0.8 : 0);
      const y = (rnd() + rnd() + rnd() - 1.5) * 0.09 * r;
      p.set(Math.cos(a) * r, y, Math.sin(a) * r);
      const big = rnd() < 0.04;
      const s = big ? 0.03 + rnd() * 0.035 : 0.004 + Math.pow(rnd(), 2.5) * 0.02;
      sc.set(s * (0.6 + rnd() * 0.8), s * (0.5 + rnd() * 0.6), s * (0.6 + rnd() * 0.8));
      q.setFromAxisAngle(new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(), rnd() * 6.28);
      mesh.setMatrixAt(i, m.compose(p, q, sc));
      spin.set([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, (rnd() - 0.5) * (big ? 0.3 : 1.6)], i * 4);
      hot[i] = rnd() < 0.18 ? 0.3 + rnd() * 0.7 : 0;
    }
    geo.setAttribute('aSpin', new THREE.InstancedBufferAttribute(spin, 4));
    geo.setAttribute('aHot', new THREE.InstancedBufferAttribute(hot, 1));
    mesh.frustumCulled = false;
    this.debris = mesh;
    this.tilt.add(mesh);
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

    if (this.civGroup.children.length) {
      const q = this.civGroup.getWorldQuaternion(new THREE.Quaternion()).invert();
      this.civUniforms.uSunLocal.value.copy(this.sunDir).applyQuaternion(q).normalize();
    }

    const spin = dna.spin * 0.06;
    this.surface.rotation.y += spin * dt;
    this.clouds.rotation.y += spin * 1.18 * dt;
    this.mega.rotation.y -= dt * 0.02;
    if (this.debris) this.debris.rotation.y += dt * 0.035;

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

    if (this.debris) { this.debris.material.uniforms.uCenter.value.copy(center); this.debris.material.uniforms.uRadius.value = radius; }
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
