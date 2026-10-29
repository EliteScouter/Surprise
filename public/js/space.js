// Deep-space backdrop for the planet view: starfield with a milky band, a nebula shell, and the suns.
import * as THREE from 'three';
import { NOISE } from './glsl.js';
import { makeGlowTexture, BH_DIR } from './planet.js';

const NEB_VERT = /* glsl */ `
varying vec3 vDir;
void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }
`;
const NEB_FRAG = /* glsl */ `
${NOISE}
uniform vec3 uColA, uColB; uniform float uSeed, uAmt;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  float band = exp(-pow(dot(d, normalize(vec3(0.3, 1.0, 0.2))), 2.0) * 9.0);
  float n = fbm(d * 2.2 + uSeed, 5) * 0.5 + 0.5;
  float m = fbm(d * 5.0 - uSeed, 4) * 0.5 + 0.5;
  float cloud = smoothstep(0.42, 0.85, n) * (0.4 + band);
  vec3 col = mix(uColA, uColB, m) * cloud * uAmt;
  col += vec3(0.6, 0.65, 0.8) * band * 0.012 * (0.5 + m);
  gl_FragColor = vec4(col, 1.0);
}
`;

// A black hole seen almost edge-on, drawn analytically on a camera-facing card:
// the shadow, the photon ring, the near half of the accretion disk crossing in
// front, and the far half lensed up over the top and under the bottom.
const BH_FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
const float RS = 0.15, RIN = 0.24, ROUT = 0.8, COSI = 0.17;
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm2(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * vnoise(p); p = p * 2.03 + 1.7; a *= 0.5; } return s; }
// emission of the disk at radius r and azimuth ang
vec3 disk(float r, float ang){
  if (r < RIN || r > ROUT) return vec3(0.0);
  float t = (r - RIN) / (ROUT - RIN);
  float a = ang - uTime * 0.35 / pow(r / RIN, 1.5);           // inner gas laps the outer
  float n = fbm2(vec2(cos(a), sin(a)) * (2.0 + r * 5.0) + r * 9.0);
  float lanes = 0.55 + 0.45 * sin(r * 70.0 + n * 7.0);
  float inten = pow(1.0 - t, 1.7) * (0.35 + 1.1 * n) * lanes;
  inten *= smoothstep(0.0, 0.06, r - RIN) * smoothstep(0.0, 0.2, ROUT - r);
  vec3 c = mix(vec3(1.0, 0.28, 0.05), vec3(1.0, 0.8, 0.55), pow(1.0 - t, 2.2));
  c = mix(c, vec3(1.0, 0.97, 0.92), pow(1.0 - t, 7.0));
  float doppler = 1.0 + 0.8 * cos(ang);                      // the approaching side burns brighter
  return c * inten * doppler * 2.4;
}
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float rr = length(p), th = atan(p.y, p.x);
  vec3 col = vec3(0.0);
  // soft halo
  col += vec3(1.0, 0.5, 0.2) * exp(-rr * 5.0) * 0.08;
  // far half of the disk, lensed into arcs above and below the shadow
  float up = smoothstep(-0.1, 0.7, sin(th)), down = smoothstep(0.1, -0.7, sin(th));
  float lr = mix(RIN, ROUT, clamp((rr - RS * 1.07) / (RS * 1.7), 0.0, 1.0));
  col += disk(lr, th) * up * step(RS * 1.07, rr) * (1.0 - smoothstep(RS * 2.6, RS * 2.9, rr));
  float lr2 = mix(RIN, ROUT, clamp((rr - RS * 1.05) / (RS * 0.45), 0.0, 1.0));
  col += disk(lr2, th) * down * 0.55 * step(RS * 1.05, rr) * (1.0 - smoothstep(RS * 1.45, RS * 1.55, rr));
  // far half of the flat disk where it peeks out beside the shadow
  vec2 dp = vec2(p.x, p.y / COSI);
  float dr = length(dp), da = atan(dp.y, -dp.x);
  if (p.y > 0.0 && rr > RS) col += disk(dr, da);
  // photon ring
  col += vec3(1.0, 0.85, 0.65) * exp(-pow((rr - RS * 1.03) / (RS * 0.035), 2.0)) * 2.2;
  // the shadow swallows everything behind it
  float shadow = 1.0 - smoothstep(RS * 0.97, RS * 1.0, rr);
  col *= 1.0 - shadow;
  // near half of the disk crosses in front of the shadow
  if (p.y <= 0.0) col += disk(dr, da);
  float edge = 1.0 - smoothstep(0.85, 1.0, rr);
  gl_FragColor = vec4(col * edge, shadow);
}
`;

export class Space {
  constructor({ quality = 'high' } = {}) {
    this.group = new THREE.Group();
    this.time = 0;

    const N = quality === 'low' ? 5000 : 12000;
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), seed = new Float32Array(N);
    const c = new THREE.Color();
    const bandN = new THREE.Vector3(0.3, 1.0, 0.2).normalize();
    for (let i = 0; i < N; i++) {
      let v = new THREE.Vector3().randomDirection();
      if (Math.random() < 0.45) { v.addScaledVector(bandN, -v.dot(bandN) * (0.85 + Math.random() * 0.15)).normalize(); }
      v.multiplyScalar(800);
      pos.set([v.x, v.y, v.z], i * 3);
      const t = Math.random();
      c.setHSL(t < 0.3 ? 0.6 : t < 0.8 ? 0.12 : 0.02, 0.45 * Math.random(), 0.65 + Math.random() * 0.3);
      col.set([c.r, c.g, c.b], i * 3);
      size[i] = Math.random() < 0.02 ? 3 + Math.random() * 2.5 : 0.6 + Math.random() * Math.random() * 2.0;
      seed[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.starU = { uPixel: { value: Math.min(2, window.devicePixelRatio) }, uTime: { value: 0 } };
    const m = new THREE.ShaderMaterial({
      uniforms: this.starU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute float aSize; attribute float aSeed; attribute vec3 aColor; uniform float uPixel, uTime; varying vec3 vC;
        void main(){ vC = aColor * (0.7 + 0.3 * sin(uTime * (0.5 + aSeed * 2.0) + aSeed * 50.0)); vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize * uPixel; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vC; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(vC * a * a * 1.4, a); }`,
    });
    this.stars = new THREE.Points(g, m);
    this.stars.frustumCulled = false;
    this.group.add(this.stars);

    this.nebU = { uColA: { value: new THREE.Color() }, uColB: { value: new THREE.Color() }, uSeed: { value: 0 }, uAmt: { value: 0.09 } };
    this.nebula = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), new THREE.ShaderMaterial({ vertexShader: NEB_VERT, fragmentShader: NEB_FRAG, uniforms: this.nebU, side: THREE.BackSide, depthWrite: false }));
    this.nebula.renderOrder = -10;
    this.group.add(this.nebula);

    this.sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeGlowTexture('rgba(255,255,255,1)', 'rgba(255,225,190,0.4)'), color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.sun.scale.setScalar(70);
    this.sun2 = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeGlowTexture('rgba(255,255,255,1)', 'rgba(255,140,110,0.4)'), color: 0xffb0a0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.sun2.scale.setScalar(40);
    this.group.add(this.sun, this.sun2);

    // Dyson swarm: thousands of collectors on tilted rings around the star,
    // twinkling as they turn their mirrors. Shown for stellar-engineer species.
    const S = 2600;
    const spos = new Float32Array(S * 3), seedS = new Float32Array(S);
    for (let i = 0; i < S; i++) {
      const ring = i % 5, a = Math.random() * Math.PI * 2;
      const r = 26 + ring * 3.2 + (Math.random() - 0.5) * 2.2;
      const tilt = ring * 0.62 + 0.2, spin = ring * 1.1;
      let x = Math.cos(a) * r, y = (Math.random() - 0.5) * 1.2, z = Math.sin(a) * r;
      [y, z] = [y * Math.cos(tilt) - z * Math.sin(tilt), y * Math.sin(tilt) + z * Math.cos(tilt)];
      [x, z] = [x * Math.cos(spin) + z * Math.sin(spin), -x * Math.sin(spin) + z * Math.cos(spin)];
      spos.set([x, y, z], i * 3);
      seedS[i] = Math.random();
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(spos, 3));
    sg.setAttribute('aSeed', new THREE.BufferAttribute(seedS, 1));
    this.swarmU = { uTime: this.starU.uTime, uPixel: this.starU.uPixel, uColor: { value: new THREE.Color(1, 0.85, 0.6) } };
    this.swarm = new THREE.Points(sg, new THREE.ShaderMaterial({
      uniforms: this.swarmU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute float aSeed; uniform float uTime, uPixel; varying float vT;
        void main(){ float t = sin(uTime * (0.6 + aSeed * 2.0) + aSeed * 60.0); vT = smoothstep(0.55, 1.0, t) * 2.2 + 0.18;
          vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = (1.2 + vT * 1.4) * uPixel; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uColor; varying float vT; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(uColor * a * vT, a); }`,
    }));
    this.swarm.frustumCulled = false;
    this.swarm.visible = false;
    this.group.add(this.swarm);

    // singularity companion
    this.bhU = { uTime: this.starU.uTime };
    this.bh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: this.bhU, transparent: true, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: BH_FRAG,
      // premultiplied: the disk adds light, the shadow blots out what is behind
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    }));
    this.bh.position.copy(BH_DIR).multiplyScalar(520);
    this.bh.scale.setScalar(135);
    this.bh.renderOrder = 1;                       // after the stars, so the shadow hides them
    this.bh.frustumCulled = false;
    this.bh.visible = false;
    this.group.add(this.bh);
  }

  configure(dna, sunDir, sun2Dir, hue) {
    this.nebU.uColA.value.setHSL(hue, 0.7, 0.45);
    this.nebU.uColB.value.setHSL((hue + 0.18 + (dna.seedY % 1 + 1) % 1 * 0.3) % 1, 0.7, 0.4);
    this.nebU.uSeed.value = dna.seedX % 37;
    this.sun.position.copy(sunDir).multiplyScalar(600);
    this.sun2.position.copy(sun2Dir).multiplyScalar(600);
    this.sun2.visible = !!dna.binary && dna.anomaly !== 4;
    this.bh.visible = dna.anomaly === 4;
    this.swarm.visible = dna.type !== 'gas' && dna.civ >= 0.86;
    this.swarm.position.copy(this.sun.position);
    this.swarm.lookAt(0, 0, 0);
    const starTint = { lava: 0xffc8a0, ice: 0xd8e8ff, desert: 0xfff0d0 }[dna.type] || 0xffffff;
    this.sun.material.color.set(starTint);
  }

  update(dt, camera) {
    this.time += dt;
    this.starU.uTime.value = this.time;
    this.group.position.copy(camera.position);   // background at infinity
    if (this.bh.visible) this.bh.quaternion.copy(camera.quaternion);
  }
}
