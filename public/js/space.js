// Deep-space backdrop for the planet view: starfield with a milky band, a nebula shell, and the suns.
import * as THREE from 'three';
import { NOISE } from './glsl.js';
import { makeGlowTexture } from './planet.js';

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
  }

  configure(dna, sunDir, sun2Dir, hue) {
    this.nebU.uColA.value.setHSL(hue, 0.7, 0.45);
    this.nebU.uColB.value.setHSL((hue + 0.18 + (dna.seedY % 1 + 1) % 1 * 0.3) % 1, 0.7, 0.4);
    this.nebU.uSeed.value = dna.seedX % 37;
    this.sun.position.copy(sunDir).multiplyScalar(600);
    this.sun2.position.copy(sun2Dir).multiplyScalar(600);
    this.sun2.visible = !!dna.binary;
    const starTint = { lava: 0xffc8a0, ice: 0xd8e8ff, desert: 0xfff0d0 }[dna.type] || 0xffffff;
    this.sun.material.color.set(starTint);
  }

  update(dt, camera) {
    this.time += dt;
    this.starU.uTime.value = this.time;
    this.group.position.copy(camera.position);   // background at infinity
  }
}
