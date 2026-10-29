// Shared GLSL chunks. Simplex noise after Ashima Arts / Stefan Gustavson (MIT).
export const NOISE = /* glsl */ `
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v){
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

float fbm(vec3 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 10; i++){
    if (i >= oct) break;
    s += a * snoise(p); n += a;
    p = p * 2.03 + vec3(1.31, 7.17, 4.73);
    a *= 0.5;
  }
  return s / n;
}

float ridged(vec3 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0, w = 1.0;
  for (int i = 0; i < 10; i++){
    if (i >= oct) break;
    float r = 1.0 - abs(snoise(p));
    r *= r; r *= w;
    w = clamp(r * 1.6, 0.0, 1.0);
    s += a * r; n += a;
    p = p * 2.11 + vec3(3.7, 1.9, 8.3);
    a *= 0.5;
  }
  return s / n;
}

vec3 hash33(vec3 p){
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}

vec3 rotateAxis(vec3 v, vec3 k, float a){
  float c = cos(a), s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}

vec2 raySphere(vec3 ro, vec3 rd, float r){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(-1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}
`;

// Cloud field shared by the cloud shell and the surface (for cloud shadows).
export const CLOUDS = /* glsl */ `
uniform vec3 uCloudSeed;
uniform float uCover;
uniform float uTime;
float cloudField(vec3 d, int oct){
  vec3 p = d * 3.1 + uCloudSeed;
  float w = fbm(p * 0.8 + vec3(0.0, uTime * 0.006, 0.0), 3);
  p += w * 0.75;
  // latitude bias: drier subtropics, stormy mid-latitudes
  float lat = abs(d.y);
  float bias = 0.08 * sin(lat * 9.0);
  float n = fbm(p + vec3(uTime * 0.004), oct) * 0.5 + 0.5 + bias;
  n += (fbm(p * 4.0 - vec3(uTime * 0.01), 2)) * 0.06;
  float t = 0.86 - uCover * 0.42;
  return smoothstep(t - 0.05, t + 0.2, n);
}
`;
