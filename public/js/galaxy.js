// The shared galaxy: ~120k stars on four spiral arms, dust lanes, nebula glow,
// and one luminous marker for every world anyone has ever claimed.
import * as THREE from 'three';
import { galaxyPosition, TYPES } from './dna.js';
import { makeGlowTexture } from './planet.js';

const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

const STAR_VERT = /* glsl */ `
attribute float aSize; attribute float aSeed; attribute vec3 aColor;
uniform float uPixel, uTime;
varying vec3 vColor; varying float vTw;
void main(){
  vColor = aColor;
  vTw = 0.75 + 0.25 * sin(uTime * (1.0 + aSeed * 3.0) + aSeed * 40.0);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * uPixel * (220.0 / -mv.z), 0.0, 64.0);
  gl_Position = projectionMatrix * mv;
}
`;
const STAR_FRAG = /* glsl */ `
varying vec3 vColor; varying float vTw;
void main(){
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  a = a * a * (0.6 + 0.4 * smoothstep(0.15, 0.0, d) * 2.0);
  gl_FragColor = vec4(vColor * a * vTw, a);
}
`;
const PUFF_FRAG = /* glsl */ `
uniform sampler2D uMap; uniform float uDark;
varying vec3 vColor; varying float vTw;
void main(){
  float a = texture2D(uMap, gl_PointCoord).a;
  if (uDark > 0.5) gl_FragColor = vec4(vColor, a * 0.55);
  else gl_FragColor = vec4(vColor * a, a);
}
`;
const MARK_VERT = /* glsl */ `
attribute float aSize; attribute float aIndex; attribute vec3 aColor; attribute float aBirth;
uniform float uPixel, uTime, uHover, uSelected;
varying vec3 vColor; varying float vHot; varying float vBorn;
void main(){
  vColor = aColor;
  float hot = max(float(abs(aIndex - uHover) < 0.5), float(abs(aIndex - uSelected) < 0.5));
  vHot = hot;
  float since = uTime - aBirth;
  vBorn = since < 6.0 ? 1.0 - since / 6.0 : 0.0;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float pulse = 1.0 + 0.15 * sin(uTime * 2.0 + aIndex);
  gl_PointSize = clamp((aSize * pulse * (1.0 + hot * 1.2) + vBorn * 14.0) * uPixel * (900.0 / -mv.z), 14.0 * uPixel, 140.0 * uPixel);
  gl_Position = projectionMatrix * mv;
}
`;
const MARK_FRAG = /* glsl */ `
varying vec3 vColor; varying float vHot; varying float vBorn;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float core = smoothstep(0.12, 0.0, d);
  float halo = pow(smoothstep(0.5, 0.0, d), 2.0) * 0.8;
  float ring = smoothstep(0.03, 0.0, abs(d - 0.38)) * (0.35 + vHot * 0.65);
  float spike = (smoothstep(0.03, 0.0, abs(c.x)) + smoothstep(0.03, 0.0, abs(c.y))) * smoothstep(0.5, 0.0, d) * 0.5;
  vec3 col = vColor * (halo + ring + spike) + vec3(1.0) * core * 1.5;
  col += vec3(1.0, 0.9, 0.7) * vBorn * smoothstep(0.5, 0.0, d);
  float a = clamp(core + halo + ring + spike, 0.0, 1.0);
  gl_FragColor = vec4(col * 1.6, a);
}
`;

export class Galaxy {
  constructor({ quality = 'high' } = {}) {
    this.scene = new THREE.Scene();
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.time = 0;
    this.pixel = Math.min(2, window.devicePixelRatio);
    this.uniforms = { uPixel: { value: this.pixel }, uTime: { value: 0 } };

    this.buildStars(quality === 'low' ? 45000 : quality === 'mid' ? 80000 : 130000);
    this.buildPuffs(quality === 'low' ? 900 : 1800);
    this.buildCore();

    this.worlds = [];      // rows: {id, name, hue, type, stars}
    this.index = new Map();
    this.markerUniforms = { ...this.uniforms, uHover: { value: -1 }, uSelected: { value: -1 } };
    this.markers = null;

    // reticle for the not-yet-claimed name being typed
    const ret = makeReticleTexture();
    this.reticle = new THREE.Sprite(new THREE.SpriteMaterial({ map: ret, color: 0x9fd8ff, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, opacity: 0 }));
    this.reticle.scale.setScalar(9);
    this.group.add(this.reticle);
    this.reticleTarget = 0;

  }

  buildStars(N) {
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), seed = new Float32Array(N);
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      let x, y, z; const roll = Math.random();
      if (roll < 0.16) {                                   // bulge
        const r = Math.abs(gauss()) * 13;
        const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
        x = r * Math.sin(ph) * Math.cos(th); y = r * Math.cos(ph) * 0.55; z = r * Math.sin(ph) * Math.sin(th);
        c.setHSL(0.08 + Math.random() * 0.04, 0.7, 0.62 + Math.random() * 0.25);
        size[i] = 1.2 + Math.random() * 1.6;
      } else if (roll < 0.8) {                             // spiral arms
        const arm = Math.floor(Math.random() * 4);
        const t = Math.pow(Math.random(), 0.85);
        const radius = 12 + t * 172;
        const angle = arm * Math.PI / 2 + radius * 0.028 + gauss() * 0.16;
        const spread = 3 + t * 7;
        x = Math.cos(angle) * radius + gauss() * spread; z = Math.sin(angle) * radius + gauss() * spread;
        y = gauss() * (2.4 - t * 1.4);
        const k = Math.random();
        if (k < 0.04) c.setHSL(0.93 + Math.random() * 0.05, 0.85, 0.65);       // HII pink
        else if (k < 0.55) c.setHSL(0.6 + Math.random() * 0.05, 0.6, 0.7 + Math.random() * 0.2);
        else c.setHSL(0.1 + Math.random() * 0.06, 0.3, 0.75 + Math.random() * 0.2);
        size[i] = 0.6 + Math.random() * Math.random() * 3.2;
      } else {                                             // disc haze
        const r = Math.sqrt(Math.random()) * 200;
        const a = Math.random() * Math.PI * 2;
        x = Math.cos(a) * r; z = Math.sin(a) * r; y = gauss() * 3;
        c.setHSL(0.58 + Math.random() * 0.1, 0.25, 0.55 + Math.random() * 0.3);
        size[i] = 0.5 + Math.random() * 1.2;
      }
      pos.set([x, y, z], i * 3);
      c.multiplyScalar(0.9);
      col.set([c.r, c.g, c.b], i * 3);
      seed[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const m = new THREE.ShaderMaterial({ vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, uniforms: this.uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.stars = new THREE.Points(g, m);
    this.group.add(this.stars);
  }

  buildPuffs(N) {
    const tex = makeGlowTexture('rgba(255,255,255,0.6)', 'rgba(255,255,255,0.25)');
    const make = (count, dark) => {
      const pos = new Float32Array(count * 3), col = new Float32Array(count * 3), size = new Float32Array(count), seed = new Float32Array(count);
      const c = new THREE.Color();
      for (let i = 0; i < count; i++) {
        const arm = Math.floor(Math.random() * 4);
        const t = Math.pow(Math.random(), 0.9);
        const radius = 16 + t * 160;
        const angle = arm * Math.PI / 2 + radius * 0.028 + gauss() * 0.1 + (dark ? -0.1 : 0);
        pos.set([Math.cos(angle) * radius + gauss() * 4, gauss() * 1.2, Math.sin(angle) * radius + gauss() * 4], i * 3);
        if (dark) { c.setRGB(0.012, 0.008, 0.01); size[i] = 10 + Math.random() * 16; }
        else {
          const k = Math.random();
          c.setHSL(k < 0.45 ? 0.62 : k < 0.8 ? 0.92 : 0.76, 0.7, 0.5).multiplyScalar(0.055 + Math.random() * 0.06);
          size[i] = 20 + Math.random() * 40;
        }
        col.set([c.r, c.g, c.b], i * 3);
        seed[i] = 0;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      const m = new THREE.ShaderMaterial({
        vertexShader: STAR_VERT.replace('0.0, 64.0', '0.0, 512.0'), fragmentShader: PUFF_FRAG,
        uniforms: { ...this.uniforms, uMap: { value: tex }, uDark: { value: dark ? 1 : 0 } },
        transparent: true, depthWrite: false, blending: dark ? THREE.NormalBlending : THREE.AdditiveBlending,
      });
      const p = new THREE.Points(g, m);
      p.renderOrder = dark ? 1 : 0;
      return p;
    };
    this.nebula = make(N, false);
    this.dust = make(Math.round(N * 0.9), true);
    this.group.add(this.nebula, this.dust);
    this.stars.renderOrder = 2;
  }

  buildCore() {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeGlowTexture('rgba(255,240,220,1)', 'rgba(255,170,90,0.35)'), color: 0xffd9a8, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.scale.setScalar(110);
    s.material.opacity = 0.75;
    this.group.add(s);
  }

  setWorlds(rows) {
    this.worlds = rows.map(r => ({ id: r[0], name: r[1], hue: r[2], type: TYPES[r[3]] || 'terran', stars: r[4] || 0, birth: -100 }));
    this.rebuildMarkers();
  }

  addWorld(w) {
    if (this.index.has(w.id)) return;
    this.worlds.push({ id: w.id, name: w.name, hue: w.hue, type: w.type, stars: w.stars || 0, birth: this.time });
    this.rebuildMarkers();
  }

  setStars(id, stars) {
    const i = this.index.get(id);
    if (i === undefined) return;
    this.worlds[i].stars = stars;
    this.markers.geometry.attributes.aSize.array[i] = 2.2 + Math.min(4, Math.sqrt(stars) * 0.8);
    this.markers.geometry.attributes.aSize.needsUpdate = true;
  }

  rebuildMarkers() {
    const N = this.worlds.length;
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), idx = new Float32Array(N), birth = new Float32Array(N);
    const c = new THREE.Color();
    this.index.clear();
    this.worlds.forEach((w, i) => {
      this.index.set(w.id, i);
      pos.set(galaxyPosition(w.id), i * 3);
      c.setHSL(w.hue, 0.95, 0.6);
      col.set([c.r, c.g, c.b], i * 3);
      size[i] = 2.2 + Math.min(4, Math.sqrt(w.stars) * 0.8);
      idx[i] = i; birth[i] = w.birth;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aIndex', new THREE.BufferAttribute(idx, 1));
    g.setAttribute('aBirth', new THREE.BufferAttribute(birth, 1));
    if (this.markers) { this.markers.geometry.dispose(); this.markers.geometry = g; }
    else {
      const m = new THREE.ShaderMaterial({ vertexShader: MARK_VERT, fragmentShader: MARK_FRAG, uniforms: this.markerUniforms, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
      this.markers = new THREE.Points(g, m);
      this.markers.renderOrder = 5;
      this.markers.frustumCulled = false;
      this.group.add(this.markers);
    }
  }

  // world-space position of any id (claimed or not)
  positionOf(id, target = new THREE.Vector3()) {
    this.group.updateMatrixWorld();
    return target.fromArray(galaxyPosition(id)).applyMatrix4(this.group.matrixWorld);
  }

  showReticle(id) {
    if (!id) { this.reticleTarget = 0; return; }
    this.reticle.position.fromArray(galaxyPosition(id));
    this.reticleTarget = 1;
  }

  setHover(id) { this.markerUniforms.uHover.value = id != null && this.index.has(id) ? this.index.get(id) : -1; }
  setSelected(id) { this.markerUniforms.uSelected.value = id != null && this.index.has(id) ? this.index.get(id) : -1; }

  // screen-space picking: nearest projected marker within a finger-sized radius
  pick(ndc, camera, radiusPx = 22) {
    if (!this.markers || !this.worlds.length) return null;
    this.group.updateMatrixWorld();
    const v = new THREE.Vector3();
    const pos = this.markers.geometry.attributes.position.array;
    const hw = innerWidth / 2, hh = innerHeight / 2;
    let best = null, bestD = radiusPx * radiusPx;
    for (let i = 0; i < this.worlds.length; i++) {
      v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(this.group.matrixWorld).project(camera);
      if (v.z > 1) continue;
      const dx = (v.x - ndc.x) * hw, dy = (v.y - ndc.y) * hh;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = this.worlds[i]; }
    }
    return best;
  }

  update(dt) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    this.group.rotation.y += dt * 0.006;
    const m = this.reticle.material;
    m.opacity += (this.reticleTarget * 0.9 - m.opacity) * Math.min(1, dt * 4);
    this.reticle.material.rotation += dt * 0.6;
    this.reticle.scale.setScalar(8 + Math.sin(this.time * 3) * 0.8);
  }
}

function makeReticleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.strokeStyle = 'white'; g.lineWidth = 6;
  g.beginPath(); g.arc(128, 128, 90, 0, Math.PI * 2); g.globalAlpha = 0.5; g.stroke();
  g.globalAlpha = 1; g.lineWidth = 10;
  for (let i = 0; i < 4; i++) {
    g.beginPath(); g.arc(128, 128, 110, i * Math.PI / 2 + 0.2, i * Math.PI / 2 + 1.1); g.stroke();
  }
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 30);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
