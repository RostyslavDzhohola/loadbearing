/*!
 * loadbearing — a loading bar built by a tiny bridge crew.
 * Zero dependencies. One file. MIT License.
 *
 *   <script type="module" src="loadbearing.js"></script>
 *   <load-bearing id="bar"></load-bearing>
 *   bar.progress = 0.42   // 0..1, whenever your real progress changes
 *
 * The crew only builds as far as your progress allows. If progress stalls,
 * they sit down for a coffee. At 100% the train crosses the bridge.
 */

const W = 256, H = 64;            // scene units; drawn at the canvas's real size
const SEG = 4, NSEG = 50, X0 = 28; // 50 deck segments of 4px between the cliffs
const DECK = 40, WATER = 54;
const PIERS = [5, 10, 15, 20, 25, 30, 35, 40, 45];
const PIERSET = new Set(PIERS);
const TOTAL = NSEG + PIERS.length; // every deck piece and every pier is one task
const LAMPS = [2, 12, 22, 32, 42];
const STEP = 1 / 60;

const SHIRTS = ['#ef6f5a', '#2fa8a0', '#8b7cf6'];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const approach = (v, target, d) => (v < target ? Math.min(target, v + d) : Math.max(target, v - d));
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sky colour by progress: dawn, day, golden hour, dusk, night.
const SKY = [
  [0.0, [248, 208, 184], [252, 236, 212]],
  [0.3, [172, 212, 230], [240, 240, 222]],
  [0.65, [168, 208, 228], [248, 236, 204]],
  [0.82, [244, 168, 128], [252, 222, 168]],
  [0.92, [186, 150, 196], [250, 190, 168]],
  [1.0, [150, 146, 214], [214, 180, 214]],
];
function skyAt(p) {
  for (let i = 1; i < SKY.length; i++) {
    if (p <= SKY[i][0]) {
      const a = SKY[i - 1], b = SKY[i], t = (p - a[0]) / (b[0] - a[0]);
      return [mix(a[1], b[1], t), mix(a[2], b[2], t)];
    }
  }
  return [SKY[SKY.length - 1][1], SKY[SKY.length - 1][2]];
}

// The fake download the demo plays: quick start, a stall, then a rush to the end.
const DEMO = [[0, 0], [0.6, 0], [8, 0.44], [11.5, 0.62], [16.5, 0.62], [22.5, 1]];
function demoCurve(t) {
  for (let i = 1; i < DEMO.length; i++) {
    if (t <= DEMO[i][0]) {
      const a = DEMO[i - 1], b = DEMO[i];
      return a[1] + (b[1] - a[1]) * ((t - a[0]) / (b[0] - a[0]));
    }
  }
  return 1;
}

export class LoadBearing {
  constructor(canvas, options = {}) {
    this.o = { seed: 7, demo: false, loop: true, autoplay: true, ...options };
    this.c = canvas;
    canvas.width = W;
    canvas.height = H;
    this.g = canvas.getContext('2d');
    this.handlers = {};
    this.ac = null;

    // Static scenery, the same for every run.
    const r = rng(99);
    this.far = [], this.near = [];
    for (let x = 0; x < W; x++) {
      this.far.push(Math.round(11 + 6 * Math.sin(x * 0.05 + 1) + 4 * Math.sin(x * 0.11 + 2) + 2 * Math.sin(x * 0.31)));
      this.near.push(Math.round(5 + 3 * Math.sin(x * 0.08) + 2 * Math.sin(x * 0.21 + 1)));
    }
    this.stars = Array.from({ length: 34 }, () => [Math.floor(r() * W), Math.floor(r() * 30), r() * 6]);

    this.reset();

    canvas.addEventListener('pointerdown', (e) => {
      const b = canvas.getBoundingClientRect();
      this.tap(((e.clientX - b.left) / b.width) * W, ((e.clientY - b.top) / b.height) * H);
    });

    if (this.o.autoplay) this.start();
  }

  /** Start the animation loop (done for you unless `autoplay: false`). */
  start() {
    if (this.raf) return;
    // With "reduce motion" on, the scene only redraws when progress changes: a still picture per step.
    const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)');
    let last = 0, acc = 0, shown = -1;
    const frame = (now) => {
      acc += Math.min(0.1, (now - (last || now)) / 1000);
      last = now;
      while (acc >= STEP) { this.step(STEP); acc -= STEP; }
      const key = this.done() + (this.finale ? this.finale.phase + 1 : 0) * 1000;
      if (!calm?.matches || key !== shown) { shown = key; this.draw(); }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }
  stop() { cancelAnimationFrame(this.raf); this.raf = 0; }

  /* ---------- public API ---------- */

  /** Tell the crew how far the real work has got, 0..1. */
  setProgress(p) { this.target = clamp(Number.isFinite(+p) ? +p : 0, 0, 1); }
  get percent() { return Math.floor((this.done() / TOTAL) * 100); }
  on(type, fn) { (this.handlers[type] ||= []).push(fn); return this; }

  /** Call from a click or key press; browsers only start audio on a gesture. */
  enableSound(on = true) {
    if (!on) { this.ac?.suspend(); this.muted = true; return; }
    this.muted = false;
    this.ac ||= new (window.AudioContext || window.webkitAudioContext)();
    this.ac.resume();
  }

  reset() {
    this.rand = rng(this.o.seed);
    this.t = 0;
    this.target = 0;
    this.D = 0;                 // deck segments placed
    this.piers = new Set();
    this.reserved = 0;          // beams being carried right now
    this.lastGo = -1;
    this.placeT = [];
    this.sp = 0;                // smoothed progress, drives the sky
    this.mult = 1;
    this.stalled = false;
    this.finale = null;
    this.flash = 0;
    this.fade = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1;
    this.events = [];
    this.crew = SHIRTS.map((shirt, i) => ({ x: 19 + i * 3, state: 'wait', k: 0, timer: 0, idle: 0, dir: 1, jy: 0, vy: 0, bub: 0, bubType: '!', shirt, moving: false, at: false }));
    this.wagon = { x: 6 };
    this.barge = { x: X0 + PIERS[0] * SEG - 17, build: null };
    this.dog = { x: 12, tx: 12, timer: 1, dir: 1, moving: false, jy: 0, vy: 0 };
    this.bal = { x: 46, oy: 0, v: 0 };
    this.train = { x: -100 };
    this.clouds = [[20, 8, 16, 2.2], [90, 14, 12, 1.4], [150, 6, 18, 1.8], [215, 16, 12, 1.2]].map(([x, y, w, sp]) => ({ x, y, w, sp }));
    this.parts = [];
    this.fish = [];
    this.birds = [];
    for (const fn of this.handlers.reset || []) fn();
  }

  done() { return this.D + this.piers.size; }

  emit(type, data) {
    this.events.push({ t: this.t, type, data });
    if (this.ac && !this.muted) playSound(this.ac, this.ac.destination, type, this.ac.currentTime, data);
    for (const fn of this.handlers[type] || []) fn(data);
  }

  /** Poke the scene at logical coordinates (the canvas wires this to pointerdown). */
  tap(x, y) {
    const b = this.bal, top = 4 + b.oy;
    if (Math.abs(x - b.x) <= 11 && y >= top - 1 && y <= top + 20) {
      b.v = -38;
      this.burst(b.x, top + 8, 14, 'confetti');
      return this.emit('tap', 'balloon');
    }
    if (y >= WATER - 1) {
      this.fish.push({ x, u: 0, dir: this.rand() < 0.5 ? -1 : 1 });
      this.burst(x, WATER, 6, 'splash');
      return this.emit('splash');
    }
    const d = this.dog;
    if (Math.abs(x - d.x) <= 5 && y >= DECK - 8 && y <= DECK + 3 && d.jy === 0) {
      d.vy = -70;
      return this.emit('tap', 'dog');
    }
    let best = null;
    for (const c of this.crew) if (Math.abs(x - c.x) <= 6 && y >= DECK - 14 && y <= DECK + 3 && (!best || Math.abs(x - c.x) < Math.abs(x - best.x))) best = c;
    if (best) {
      if (best.jy === 0) best.vy = -80;
      best.bub = 0.8;
      best.bubType = 'heart';
      return this.emit('tap', 'crew');
    }
    this.birds.push({ x, y: Math.min(y, 30), vx: x < W / 2 ? 30 : -30 });
    for (const c of this.crew) if (c.jy === 0) c.vy = -42;
    this.emit('tap', 'sky');
  }

  burst(x, y, n, type, color = '#fff') {
    const R = this.rand;
    for (let i = 0; i < n; i++) {
      const a = R() * Math.PI * 2, v = R();
      if (type === 'dust') this.parts.push({ type, x: x + R() * 4 - 2, y, vx: (R() - 0.5) * 16, vy: -R() * 10, g: 0, life: 0.3 + R() * 0.2, c: '#e9dcc8' });
      else if (type === 'splash') this.parts.push({ type, x: x + R() * 4 - 2, y, vx: (R() - 0.5) * 26, vy: -14 - R() * 26, g: 110, life: 0.5, c: '#e6f6ff' });
      else if (type === 'confetti') this.parts.push({ type, x, y, vx: Math.cos(a) * 26 * v, vy: Math.sin(a) * 22 * v - 12, g: 40, life: 1 + R() * 0.8, c: ['#ff5d73', '#ffd23f', '#3ddc97', '#5ab1ff', '#fff'][i % 5] });
      else if (type === 'fire') this.parts.push({ type, x, y, vx: Math.cos(a) * (i % 2 ? 44 : 14 + 22 * v), vy: Math.sin(a) * (i % 2 ? 44 : 14 + 22 * v), g: 20, life: 0.8 + R() * 0.6, c: color });
    }
  }

  /* ---------- simulation ---------- */

  step(dt) {
    const s = this;
    s.t += dt;
    s.fade = Math.max(0, s.fade - dt * 2.5);
    s.flash = Math.max(0, s.flash - dt * 5);
    if (s.o.demo) s.target = demoCurve(s.t);
    const allowed = Math.floor(s.target * TOTAL + 1e-6);
    const inflight = () => s.reserved + (s.barge.build ? 1 : 0);
    const m = (s.mult = s.finale ? 1.5 : clamp(0.85 + (allowed - s.done()) * 0.2, 0.85, 3.2));
    const fx = X0 + s.D * SEG;

    // Supply wagon trails the front of the bridge.
    s.wagon.x = approach(s.wagon.x, s.finale ? W + 24 : clamp(fx - 32, 6, W), (s.finale ? 50 : 24) * m * dt);

    // Crane barge builds the next pier a little ahead of the deck.
    const b = s.barge, next = PIERS.find((k) => !s.piers.has(k));
    if (b.build) {
      b.build.p += (dt * m) / 0.8;
      if (b.build.p >= 1) {
        s.piers.add(b.build.k);
        s.burst(X0 + b.build.k * SEG + 2, WATER, 7, 'splash');
        s.emit('pier', b.build.k);
        b.build = null;
      }
    } else if (next !== undefined) {
      const tx = X0 + next * SEG - 17;
      b.x = approach(b.x, tx, 18 * m * dt);
      if (Math.abs(b.x - tx) < 0.5 && next <= s.D + s.reserved + 3 && s.done() + inflight() < allowed) b.build = { k: next, p: 0 };
    }

    // The crew: fetch a beam from the wagon, carry it to the front, place it.
    let allIdle = true;
    s.crew.forEach((c, i) => {
      const speed = 34 * m;
      c.bub = Math.max(0, c.bub - dt);
      if (c.jy < 0 || c.vy) { c.vy += 300 * dt; c.jy += c.vy * dt; if (c.jy >= 0) { c.jy = 0; c.vy = 0; } }
      const walk = (tx) => {
        if (Math.abs(c.x - tx) < 0.6) { c.moving = false; return true; }
        c.dir = tx > c.x ? 1 : -1;
        c.x = approach(c.x, tx, speed * dt);
        c.moving = true;
        return false;
      };
      if (s.finale) {
        c.at = walk(232 + i * 6);
        if (c.at) { c.dir = -1; if (c.jy === 0 && s.rand() < dt * 2.4) c.vy = -58; }
        return;
      }
      if (c.state === 'wait') {
        if (walk(Math.min(s.wagon.x + 15 + i * 7, fx - 3))) {
          c.dir = 1;
          const k = s.D + s.reserved;
          if (k < NSEG && s.done() + inflight() < allowed && (!PIERSET.has(k) || s.piers.has(k)) && s.t - s.lastGo > 0.16 / m) {
            if (c.idle > 1.2) { c.bub = 0.5; c.bubType = '!'; }
            c.state = 'go'; c.k = k; c.idle = 0; s.reserved++; s.lastGo = s.t;
          } else c.idle += dt;
        } else c.idle = 0;
      } else if (c.state === 'go') {
        if (walk(X0 + c.k * SEG - 3) && c.k === s.D) { c.state = 'place'; c.timer = 0.14; }
      } else if (c.state === 'place') {
        c.timer -= dt * m;
        if (c.timer <= 0) {
          s.placeT[c.k] = s.t;
          s.D++; s.reserved--;
          s.burst(X0 + c.k * SEG + 2, DECK, 3, 'dust');
          s.emit('place', c.k);
          c.state = 'wait';
        }
      }
      if (c.idle < 1.2) allIdle = false;
    });

    const stalled = allIdle && !s.finale && !b.build && s.done() < TOTAL && s.done() > 0;
    if (stalled !== s.stalled) { s.stalled = stalled; s.emit(stalled ? 'stall' : 'resume'); }

    // The site dog.
    const d = s.dog;
    if (d.jy < 0 || d.vy) { d.vy += 300 * dt; d.jy += d.vy * dt; if (d.jy >= 0) { d.jy = 0; d.vy = 0; } }
    d.timer -= dt;
    const lo = s.wagon.x + 14, hi = fx - 5;
    if (s.finale) d.tx = 250;
    else if (d.timer <= 0) { d.timer = 1 + s.rand() * 2.5; d.tx = hi - lo > 6 && !s.stalled ? lo + s.rand() * (hi - lo) : Math.min(lo, hi); }
    if (!s.finale) d.tx = clamp(d.tx, 3, Math.max(3, hi));
    d.moving = Math.abs(d.x - d.tx) > 0.6;
    if (d.moving) { d.dir = d.tx > d.x ? 1 : -1; d.x = approach(d.x, d.tx, 46 * m * dt); }

    // Finale: everyone clears the deck, then the train comes through.
    if (!s.finale && s.done() === TOTAL) { s.finale = { t: 0, phase: 0, chug: 0, fw: 0.2, t2: 0 }; s.emit('done'); }
    if (s.finale) {
      const f = s.finale;
      f.t += dt;
      if (f.phase === 0 && f.t > 1 && (f.t > 3.4 || (s.crew.every((c) => c.at) && s.wagon.x > W + 14))) {
        f.phase = 1; s.train.x = -2; s.emit('whistle');
      }
      if (f.phase >= 1) {
        f.fw -= dt;
        if (f.fw <= 0 && (f.phase === 1 || f.t2 < 1.6)) {
          f.fw = 0.32 + s.rand() * 0.3;
          const c = ['#ff5d73', '#ffd23f', '#3ddc97', '#5ab1ff', '#ff9bf5'][Math.floor(s.rand() * 5)];
          s.burst(30 + s.rand() * 196, 5 + s.rand() * 12, 44, 'fire', c);
          s.flash = 1;
          s.emit('firework');
        }
      }
      if (f.phase === 1) {
        s.train.x += 78 * dt;
        f.chug -= dt;
        if (f.chug <= 0) {
          f.chug = 0.15;
          s.parts.push({ type: 'smoke', x: s.train.x - 6, y: 24, vx: -8, vy: -9, g: 0, life: 1.1, c: '#eef1f6' });
          s.emit('chug');
        }
        if (s.train.x - 68 > W) { f.phase = 2; s.emit('arrived'); }
      } else if (f.phase === 2) {
        f.t2 += dt;
        if (s.o.demo && s.o.loop && f.t2 > 3.2) return s.reset();
      }
    }

    // Ambient life.
    for (const c of s.clouds) { c.x += c.sp * dt; if (c.x > W + 4) c.x = -c.w - 4; }
    const bl = s.bal;
    bl.x += (clamp(fx + 8, 46, 210) - bl.x) * Math.min(1, dt * 2);
    bl.v += (-bl.oy * 60 - bl.v * 5) * dt;
    bl.oy += bl.v * dt;
    if (s.sp < 0.85 && s.rand() < dt * 0.12) s.birds.push({ x: -4, y: 6 + s.rand() * 18, vx: 22 + s.rand() * 10 });
    for (const q of s.birds) q.x += q.vx * dt;
    s.birds = s.birds.filter((q) => q.x > -8 && q.x < W + 8);
    for (const q of s.fish) { q.u += dt / 0.7; if (q.u >= 1) s.burst(q.x + q.dir * 12, WATER, 5, 'splash'); }
    s.fish = s.fish.filter((q) => q.u < 1);
    for (const q of s.parts) { q.vy += q.g * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.life -= dt; }
    s.parts = s.parts.filter((q) => q.life > 0);
    s.sp += (s.done() / TOTAL - s.sp) * Math.min(1, dt * 3);
  }

  /* ---------- rendering: a sketchbook page. Wobbly ink lines redrawn 8 times a second ("boiling"), loose washes of colour ---------- */

  draw() {
    const s = this, g = s.g, t = s.t;
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const want = clamp(Math.round(((s.c.clientWidth || (W * 4) / dpr) * dpr) / 4) * 4, W * 2, W * 10);
    if (s.c.width !== want || s.c.height !== want / 4) { s.c.width = want; s.c.height = want / 4; s.paper = null; }
    const k = s.c.width / W;
    if (!s.paper) { // paper grain, multiplied over the finished drawing
      const p = (s.paper = document.createElement('canvas')), r = rng(5);
      p.width = s.c.width; p.height = s.c.height;
      const pc = p.getContext('2d');
      pc.fillStyle = '#fff'; pc.fillRect(0, 0, p.width, p.height);
      for (let i = 0; i < (p.width * p.height) / 50; i++) { const z = (0.5 + r() * 1.5) * (k / 4); pc.fillStyle = `rgba(90,70,40,${0.03 + r() * 0.07})`; pc.fillRect(r() * p.width, r() * p.height, z, z); }
      pc.strokeStyle = 'rgba(90,70,40,0.07)'; pc.lineWidth = k * 0.1;
      for (let i = 0; i < 140; i++) { const x = r() * p.width, y = r() * p.height, a = r() * 7; pc.beginPath(); pc.moveTo(x, y); pc.lineTo(x + Math.cos(a) * k * 3, y + Math.sin(a) * k * 3); pc.stroke(); }
    }
    g.setTransform(k, 0, 0, k, 0, 0);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    g.lineCap = g.lineJoin = 'round';

    const INK = '#2a2733', PAPER = '#fbf6e8', RED = '#e4604e', YEL = '#f4c95d', TEAL = '#6dbcb0', BLUE = '#8fb8e0', WOOD = '#e2bd8a', BROWN = '#b98a62', GREEN = '#a5cc8f';
    const pale = (a) => css([42, 39, 51], a); // the same ink, lighter pressure

    // Every stroke gets its own wobble, and the wobble changes with `boil`.
    const boil = Math.floor(t * 8);
    let n = 0;
    const h = (i) => { let x = Math.imul(i + boil * 7919, 0x9e3779b1); x ^= x >>> 15; x = Math.imul(x, 0x85ebca6b); x ^= x >>> 13; return (x >>> 0) / 2147483648 - 1; };
    const wob = (pts, close, soft, amp) => {
      const id = (n += 131), m = pts.length >> 1, q = [];
      g.beginPath();
      if (m < 2) return;
      const add = (x, y, corner) => { const e = id + q.length * 2; q.push([x + h(e) * amp, y + h(e + 1) * amp, corner]); };
      for (let i = 0; i < (close ? m : m - 1); i++) {
        const x1 = pts[i * 2], y1 = pts[i * 2 + 1], j = ((i + 1) % m) * 2, x2 = pts[j], y2 = pts[j + 1];
        const parts = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / 2.5));
        for (let u = 0; u < parts; u++) add(x1 + ((x2 - x1) * u) / parts, y1 + ((y2 - y1) * u) / parts, u === 0 && !soft);
      }
      if (!close) add(pts[m * 2 - 2], pts[m * 2 - 1], true);
      const L = q.length, mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      g.beginPath();
      if (close) {
        const st = q[0][2] ? q[0] : mid(q[L - 1], q[0]);
        g.moveTo(st[0], st[1]);
        for (let i = q[0][2] ? 1 : 0; i < L; i++) {
          const p = q[i], nx = q[(i + 1) % L];
          if (p[2]) g.lineTo(p[0], p[1]);
          else { const e = nx[2] ? nx : mid(p, nx); g.quadraticCurveTo(p[0], p[1], e[0], e[1]); }
        }
        g.closePath();
      } else {
        g.moveTo(q[0][0], q[0][1]);
        for (let i = 1; i < L; i++) {
          const p = q[i];
          if (p[2] || i === L - 1) g.lineTo(p[0], p[1]);
          else { const nx = q[i + 1], e = nx[2] ? nx : mid(p, nx); g.quadraticCurveTo(p[0], p[1], e[0], e[1]); }
        }
      }
    };
    // ink(points, { fill, col, w, amp, soft, close }): the wash is painted loosely, then outlined.
    const ink = (pts, o = {}) => {
      const amp = o.amp ?? 0.2;
      if (o.fill) { wob(pts, true, o.soft, amp * 1.6); g.fillStyle = o.fill; g.fill(); }
      if (o.col !== null) { wob(pts, o.close || !!o.fill, o.soft, amp); g.strokeStyle = o.col || INK; g.lineWidth = o.w ?? 0.42; g.stroke(); }
    };
    const ln = (x1, y1, x2, y2, o) => ink([x1, y1, x2, y2], o);
    const rect = (x, y, w, hh, o) => ink([x, y, x + w, y, x + w, y + hh, x, y + hh], { close: true, ...o });
    const oval = (x, y, rx, ry, o = {}) => {
      const m = Math.max(5, Math.round((rx + ry) * 1.2)), pts = [];
      for (let i = 0; i < m; i++) pts.push(x + Math.cos((i / m) * 6.2832) * rx, y + Math.sin((i / m) * 6.2832) * ry);
      ink(pts, { soft: true, close: true, amp: Math.min(0.18, (rx + ry) * 0.04), ...o });
    };
    const dot = (x, y, r, fill) => { g.fillStyle = fill; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); };
    const raw = (x1, y1, x2, y2, w, col) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
    const glow = (x, y, r, col, a) => {
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, css(col, a)); gr.addColorStop(1, css(col, 0));
      g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
    };

    const [top, bot] = skyAt(s.sp);
    const night = smooth(0.84, 1, s.sp);
    const fx = X0 + s.D * SEG, bg = s.barge;

    // --- sky: one big wash with blooms in it ---
    let gr = g.createLinearGradient(0, 0, 0, WATER);
    gr.addColorStop(0, css(top)); gr.addColorStop(1, css(bot));
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    for (const [x, y, r, a] of [[36, 12, 34, 0.3], [118, 26, 46, 0.26], [204, 8, 40, 0.3], [70, 34, 26, -0.12], [168, 14, 34, -0.12]]) glow(x, y, r, a > 0 ? [255, 255, 255] : top.map((v) => v * 0.8), Math.abs(a));

    n = 1e5;
    const sunX = 30 + s.sp * 200, sunY = 34 - Math.sin(s.sp * Math.PI) * 26 + Math.max(0, s.sp - 0.8) * 70;
    const sunC = mix([246, 200, 80], [238, 116, 78], smooth(0.55, 0.95, s.sp));
    for (let i = 0; i < 10; i++) { const a = i * 0.628 + boil * 0.07, r2 = 9.4 + (i % 2) * 1.2; ln(sunX + Math.cos(a) * 7.4, sunY + Math.sin(a) * 7.4, sunX + Math.cos(a) * r2, sunY + Math.sin(a) * r2, { col: css(sunC), w: 0.5 }); }
    oval(sunX, sunY, 5.4, 5.4, { fill: css(sunC, 0.92) });

    n = 2e5;
    for (const { x, y, w } of s.clouds) ink([x, y + 4, x + w * 0.08, y + 1.6, x + w * 0.28, y + 1.9, x + w * 0.42, y - 0.8, x + w * 0.64, y - 0.4, x + w * 0.76, y + 1.6, x + w * 0.94, y + 2, x + w, y + 4], { soft: true, fill: css([255, 255, 255], 0.8), col: pale(0.55), w: 0.32 });
    for (const q of s.birds) { const a = Math.sin(t * 12 + q.y) * 1.1; ink([q.x - 2.2, q.y + a, q.x - 1, q.y - 1, q.x, q.y, q.x + 1, q.y - 1, q.x + 2.2, q.y + a], { soft: true, w: 0.4 }); }

    // --- hills and water ---
    n = 3e5;
    const ridge = (hs, lift, fill) => {
      const pts = [-3, WATER + 3];
      for (let x = -3; x <= W + 3; x += 7) pts.push(x, WATER - hs[clamp(x, 0, W - 1)] - lift);
      pts.push(W + 3, WATER + 3);
      ink(pts, { soft: true, fill, col: pale(0.4), w: 0.3 });
    };
    ridge(s.far, 2, css(mix(bot, [150, 170, 205], 0.55)));
    for (const x of [44, 52, 96, 131, 138, 187, 212]) { const y = WATER - s.far[x] - 1.6, o = { col: pale(0.45), w: 0.3 }; ln(x, y, x, y - 3.4, o); ink([x - 1.3, y - 0.8, x, y - 3.6, x + 1.3, y - 0.8], o); }
    ridge(s.near, -1, css(mix(bot, [140, 185, 140], 0.6)));

    n = 4e5;
    g.fillStyle = css(mix([150, 200, 220], top, 0.3)); g.fillRect(0, WATER, W, H - WATER);
    ln(-2, WATER, W + 2, WATER, { col: pale(0.45), w: 0.3 });
    for (let r = 0; r < 4; r++) for (let j = 0; j < 7; j++) {
      const x = ((((j * 41 + r * 17 + t * (4 + r * 2.5) * (r % 2 ? 1 : -1)) % (W + 10)) + W + 10) % (W + 10)) - 5, y = WATER + 2 + r * 2.3;
      ink([x, y, x + 1.6, y - 0.7, x + 3.2, y, x + 4.8, y - 0.7], { soft: true, col: pale(0.35), w: 0.28, amp: 0.1 });
    }
    if (sunY < DECK - 4) for (let r = 0; r < 4; r++) { const w = 3.2 - r * 0.5 + Math.sin(t * 3 + r) * 0.6, y = WATER + 2 + r * 2.3; ln(sunX - w, y, sunX + w, y, { col: css(sunC, 0.85), w: 0.55 }); }

    // --- the bridge: timber trestles ---
    n = 5e5;
    const trestle = (x, p) => {
      g.save(); g.beginPath(); g.rect(x - 4, H - 21 * p, 12, 30); g.clip();
      ln(x + 0.7, 43, x - 0.6, H + 1); ln(x + 3.3, 43, x + 4.6, H + 1);
      ln(x + 0.5, 44.6, x + 4, 49, { w: 0.34 }); ln(x + 3.5, 44.6, x, 49, { w: 0.34 }); ln(x - 0.1, 49.3, x + 4.1, 49.3, { w: 0.34 });
      ln(x + 0.1, 49.8, x + 4.3, 53.6, { w: 0.34 }); ln(x + 3.9, 49.8, x - 0.3, 53.6, { w: 0.34 });
      g.restore();
      oval(x + 2, WATER + 0.7, 3.6, 0.6, { col: css([255, 255, 255], 0.85), w: 0.3 });
    };
    for (const p of PIERS) if (s.piers.has(p)) trestle(X0 + p * SEG, 1);
    if (bg.build) trestle(X0 + bg.build.k * SEG, bg.build.p);
    for (const p of PIERS) if (s.piers.has(p) && p + 2 <= s.D) { const x = X0 + p * SEG; ln(x - 3, 43.2, x + 0.6, 46.4, { w: 0.34 }); ln(x + 7, 43.2, x + 3.4, 46.4, { w: 0.34 }); }

    n = 6e5;
    for (const q of s.fish) {
      const x = q.x + q.dir * 12 * q.u, y = WATER - Math.sin(q.u * Math.PI) * 11, a = Math.atan2(-Math.cos(q.u * Math.PI) * 11 * Math.PI, 12) * q.dir;
      g.save(); g.translate(x, y); g.rotate(a); g.scale(q.dir, 1);
      ink([-1.8, 0, -3.9, -1.6, -3.9, 1.6], { fill: '#f0a060', w: 0.35 });
      oval(0, 0, 2.4, 1.25, { fill: '#f0a060', w: 0.35 }); dot(1.2, -0.3, 0.28, INK);
      g.restore();
    }
    n = 6.5e5;
    {
      const x = bg.x, y = WATER - 2 + Math.sin(t * 2) * 0.5;
      ln(x + 11.8, y, x + 11.8, y - 6.2); ln(x + 11.8, y - 6.2, x + 19.4, y - 5.5); ln(x + 11.8, y - 2.6, x + 15.4, y - 5.8, { w: 0.3 });
      ln(x + 18.8, y - 5.5, x + 18.8, y - (bg.build ? 3.2 + Math.sin(t * 14) * 0.5 : 2.6), { w: 0.3 });
      ink([x - 0.5, y, x + 16.5, y, x + 14.5, y + 3.6, x + 1.5, y + 3.6], { fill: RED });
      rect(x + 1.2, y - 4.2, 5.2, 4.2, { fill: PAPER }); rect(x + 2.3, y - 3.2, 2.2, 1.7, { fill: BLUE, w: 0.3 });
      oval(x + 8.6, y - 1.9, 1.2, 1.2, { fill: PAPER, w: 0.35 });
      ink([x + 7.2, y - 2.3, x + 7.7, y - 3.5, x + 8.6, y - 3.9, x + 9.5, y - 3.5, x + 10, y - 2.3], { fill: YEL, w: 0.35, amp: 0.08 });
    }

    // --- cliffs, tree, signal, station ---
    n = 7e5;
    ink([-3, 40.6, X0, 40.6, X0 - 1.2, 47, X0 - 4, 53, X0 - 7, H + 3, -3, H + 3], { fill: '#dcb994' });
    ink([W + 3, 40.6, 228, 40.6, 229.2, 47, 232, 53, 235, H + 3, W + 3, H + 3], { fill: '#dcb994' });
    for (let i = 0; i < 5; i++) { const x = 2 + i * 4.4, y = 45 + (i % 2) * 5 + (i % 3) * 2, o = { col: pale(0.45), w: 0.3 }; ln(x, y, x + 2.2, y + 3, o); ln(W - x, y, W - x - 2.2, y + 3, o); }
    for (let x = 0.6; x < X0 - 2; x += 3.2) ink([x, 40.6, x + 0.6, 39.2, x + 1.1, 40.6, x + 1.8, 39.4], { col: '#5f9a5a', w: 0.35, amp: 0.12 });
    for (let x = 250.4; x < W; x += 3.2) ink([x, 40.6, x + 0.6, 39.2, x + 1.1, 40.6, x + 1.8, 39.4], { col: '#5f9a5a', w: 0.35, amp: 0.12 });
    ln(7.6, 40.4, 7.8, 33.4, { w: 0.6 });
    ink([3.6, 30.5, 5, 26.8, 8.4, 25.6, 11.8, 27.2, 12.6, 30.6, 10.6, 33.6, 6, 33.8], { soft: true, fill: GREEN });
    ink([5.8, 30, 7.2, 28.6, 8.4, 30], { soft: true, col: pale(0.5), w: 0.3 }); ink([8.6, 31.8, 9.8, 30.6, 10.8, 31.8], { soft: true, col: pale(0.5), w: 0.3 });
    ln(22.5, 40.4, 22.5, 30); rect(21.2, 25.6, 2.6, 4.4, { fill: '#4a4654' });
    rect(247.2, 25.6, 1.6, 4, { fill: BROWN, w: 0.3 });
    rect(238, 31, 12, 9.4, { fill: PAPER });
    ink([236.4, 31.4, 244, 25.4, 251.6, 31.4], { fill: RED });
    rect(246, 35.2, 2.8, 5.2, { fill: BROWN, w: 0.35 }); rect(240, 33.2, 3, 3, { fill: BLUE, w: 0.35 });
    rect(229, 36, 20, 4.6, { fill: WOOD }); ln(229.4, 37.5, 248.6, 37.5, { col: pale(0.4), w: 0.25 });

    // --- deck, railing, lamps ---
    n = 8e5;
    if (s.D > 0) {
      let settled = s.D;
      while (settled > 0 && t - (s.placeT[settled - 1] ?? -9) < 0.14) settled--;
      if (settled > 0) {
        const x2 = X0 + settled * SEG;
        ink([X0, 40.6, x2, 40.6, x2, 43, X0, 43], { fill: WOOD });
        g.strokeStyle = pale(0.5); g.lineWidth = 0.25; g.beginPath();
        for (let i = 1; i < settled; i++) { const x = X0 + i * SEG + h(i * 5 + 900001) * 0.3; g.moveTo(x, 41); g.lineTo(x + 0.3, 42.7); }
        g.stroke();
      }
      for (let i = settled; i < s.D; i++) rect(X0 + i * SEG, 40.6 - (1 - (t - s.placeT[i]) / 0.14) * 3.5, SEG, 2.4, { fill: YEL });
    }
    const railed = s.finale ? NSEG : Math.max(0, s.D - 2);
    if (railed > 0) {
      ln(X0, 36.8, X0 + railed * SEG, 36.8, { w: 0.32, col: pale(0.8) });
      g.strokeStyle = pale(0.7); g.lineWidth = 0.28; g.beginPath();
      for (let i = 0; i <= railed; i++) { const x = X0 + i * SEG; g.moveTo(x + h(i * 3 + 800001) * 0.25, 36.8); g.lineTo(x + h(i * 3 + 800002) * 0.25, 40.5); }
      g.stroke();
    }
    n = 8.5e5;
    for (const L of LAMPS) if (L < s.D - 1) { const x = X0 + L * SEG + 1; ink([x, 40.4, x, 32, x + 0.6, 30.4, x + 2.2, 30.2], { soft: true, w: 0.45 }); oval(x + 2.4, 31, 0.9, 0.9, { fill: PAPER, w: 0.3 }); }

    n = 9e5;
    {
      const x = s.wagon.x, a = x / 1.6;
      if (!s.finale) { rect(x + 1, 33.6, 10, 1.7, { fill: WOOD, w: 0.35 }); rect(x + 2, 31.9, 8, 1.7, { fill: WOOD, w: 0.35 }); }
      ink([x - 0.4, 35.4, x + 12.4, 35.4, x + 11.4, 37.8, x + 0.6, 37.8], { fill: BROWN });
      for (const wx of [x + 2.6, x + 9.4]) { oval(wx, 38.6, 1.6, 1.6, { fill: PAPER }); ln(wx - Math.cos(a) * 1.2, 38.6 - Math.sin(a) * 1.2, wx + Math.cos(a) * 1.2, 38.6 + Math.sin(a) * 1.2, { w: 0.3, amp: 0 }); }
    }

    n = 10e5;
    {
      const cx = s.bal.x, ty = 3.5 + s.bal.oy + Math.sin(t * 1.4) * 1.2;
      ln(cx - 4.4, ty + 14, cx - 2.2, ty + 18.4, { w: 0.28 }); ln(cx + 4.4, ty + 14, cx + 2.2, ty + 18.4, { w: 0.28 });
      ink([cx - 8, ty + 8, cx - 6.4, ty + 2.6, cx, ty, cx + 6.4, ty + 2.6, cx + 8, ty + 8, cx + 5.6, ty + 13.4, cx + 2.2, ty + 16.6, cx - 2.2, ty + 16.6, cx - 5.6, ty + 13.4], { soft: true, fill: RED });
      ink([cx - 1, ty + 0.6, cx - 3.8, ty + 8, cx - 1.4, ty + 16.2, cx + 1.4, ty + 16.2, cx + 3.8, ty + 8, cx + 1, ty + 0.6], { soft: true, fill: PAPER, w: 0.3 });
      rect(cx - 2.6, ty + 18.2, 5.2, 3.2, { fill: BROWN });
    }

    // --- the crew: stick figures in hard hats ---
    const person = (x, feet, dir, shirt, pose, swing, asleep) => {
      const Y = feet - 9, o = { w: 0.45, amp: 0.12 };
      if (pose === 'sit') ink([x, Y + 7.3, x + dir * 2.4, Y + 7.1, x + dir * 3, Y + 8.9], o);
      else { const a = pose === 'walk' ? Math.sin(swing) * 1.8 : 0.9; ln(x, Y + 6.8, x - a, Y + 9, o); ln(x, Y + 6.8, x + a, Y + 9, o); }
      const arm = (side, tx, ty) => ln(x + side * 1.2, Y + 4.5, x + tx, Y + ty, o);
      if (pose === 'carry') { arm(-1, -2.6, 0.6); arm(1, 2.6, 0.6); }
      else if (pose === 'cheer') { const w = Math.sin(t * 11 + x) * 0.8; arm(-1, -3.4 + w, 0.8); arm(1, 3.4 - w, 0.8); }
      else if (pose === 'sit') { arm(dir, dir * 3.4, 5.2); arm(-dir, -dir * 2, 6.8); }
      else { const a = pose === 'walk' ? Math.sin(swing) * 1.3 : 0; arm(-1, -2.4 - a * 0.4, 7); arm(1, 2.4 + a * 0.4, 7); }
      ink([x - 1.5, Y + 3.9, x + 1.5, Y + 3.9, x + 1.2, Y + 7, x - 1.2, Y + 7], { fill: shirt, w: 0.4, amp: 0.1 });
      oval(x, Y + 2.2, 1.75, 1.75, { fill: PAPER, w: 0.4 });
      ink([x - 2, Y + 1.7, x - 1.5, Y + 0.3, x, Y - 0.4, x + 1.5, Y + 0.3, x + 2, Y + 1.7], { fill: YEL, w: 0.4, amp: 0.08 });
      ln(x - 2.5 + dir * 0.7, Y + 1.7, x + 2.5 + dir * 0.7, Y + 1.7, { w: 0.45, amp: 0.08 });
      if (asleep) raw(x + dir * 0.4, Y + 2.8, x + dir * 1.3, Y + 2.8, 0.28, INK);
      else dot(x + dir * 0.9, Y + 2.7, 0.32, INK);
    };

    const trainOn = s.finale && s.finale.phase === 1, tr = s.train;
    const extras = [];
    s.crew.forEach((c, i) => {
      n = 11e5 + i * 5000;
      const sit = !s.finale && c.state === 'wait' && c.idle > 1.2, asleep = sit && c.idle > 1.9;
      const carry = c.state === 'go' || c.state === 'place';
      const feet = DECK + 0.4 + c.jy - (s.finale && c.x >= 229 ? 4.4 : 0) + (sit ? 0.6 : 0);
      const pose = sit ? 'sit' : carry ? 'carry' : s.finale && c.at ? 'cheer' : c.moving ? 'walk' : 'stand';
      person(c.x, feet, c.dir, c.shirt, pose, c.x * 1.25, asleep);
      if (carry) { const o = c.state === 'place' ? 3 * c.dir : 0, by = feet - 9 + (c.state === 'place' ? 2 : -1.6); rect(c.x - 4 + o, by, 8, 1.7, { fill: WOOD, w: 0.35 }); }
      if (sit) {
        const mx = c.x + c.dir * 4.2, my = feet - 4.6;
        rect(mx - 0.9, my, 1.8, 1.9, { fill: PAPER, w: 0.3, amp: 0.06 });
        for (let j = 0; j < 2; j++) { const u = (t * 0.7 + j * 0.5 + c.x) % 1, y = my - 0.6 - u * 3; ink([mx, y, mx + 0.5, y - 0.8, mx - 0.2, y - 1.6], { soft: true, col: pale(0.55 * (1 - u)), w: 0.28, amp: 0.06 }); }
        if (asleep) extras.push(['snore', c.x + c.dir * 2.3, feet - 6.2, c.x]);
      }
      if (c.bub > 0) extras.push([c.bubType, c.x, feet - 12.5, c.bub]);
    });
    n = 12e5;
    {
      const d = s.dog, x = d.x, y = DECK + 0.4 + d.jy - (s.finale && d.x >= 229 ? 4.4 : 0), a = d.moving ? Math.sin(d.x * 1.6) * 1.1 : 0, o = { w: 0.4, amp: 0.1 };
      ln(x - 1.6, y - 1.6, x - 1.6 + a, y - 0.1, o); ln(x + 1.6, y - 1.6, x + 1.6 - a, y - 0.1, o);
      ln(x - d.dir * 2.6, y - 3.2, x - d.dir * 3.9, y - 4.9 + Math.sin(t * 16) * 0.5, o);
      oval(x, y - 2.8, 2.8, 1.4, { fill: PAPER, w: 0.4 });
      oval(x + d.dir * 2.9, y - 4.4, 1.45, 1.35, { fill: PAPER, w: 0.4 });
      oval(x + d.dir * 2.1, y - 5.3, 0.7, 0.9, { fill: BROWN, w: 0.3 });
      dot(x + d.dir * 3.3, y - 4.6, 0.28, INK); dot(x + d.dir * 4.3, y - 4.1, 0.34, INK);
    }
    n = 13e5;
    if (trainOn) {
      const x0 = tr.x - 24, a = tr.x / 1.8;
      const wheel = (wx) => { oval(wx, 38.5, 1.75, 1.75, { fill: PAPER }); ln(wx - Math.cos(a) * 1.3, 38.5 - Math.sin(a) * 1.3, wx + Math.cos(a) * 1.3, 38.5 + Math.sin(a) * 1.3, { w: 0.3, amp: 0 }); };
      for (let j = 0; j < 2; j++) {
        const cx = x0 - 21 - j * 21;
        ln(cx + 19, 36, cx + 21, 36);
        rect(cx, 28.4, 19, 8.6, { fill: j ? YEL : TEAL });
        for (let w = 0; w < 4; w++) rect(cx + 2 + w * 4.1, 30.6, 3, 3, { fill: PAPER, w: 0.3, amp: 0.1 });
        wheel(cx + 3.5); wheel(cx + 15.5);
      }
      rect(x0 + 17, 24.8, 3, 6, { fill: '#4a4654' });
      ink([x0 + 7, 30.4, x0 + 22, 30.4, x0 + 23.6, 33.4, x0 + 23.6, 37, x0 + 7, 37], { fill: RED });
      rect(x0, 26.8, 9.5, 10.2, { fill: '#c9503f' }); rect(x0 + 2, 28.8, 4.6, 3.2, { fill: PAPER, w: 0.3 });
      ln(x0 - 1, 26.6, x0 + 10.5, 26.6, { w: 0.7 });
      ink([x0 + 23.6, 36.4, x0 + 26.8, 40.2, x0 + 23, 40.2], { fill: PAPER, w: 0.35 });
      wheel(x0 + 3); wheel(x0 + 10); wheel(x0 + 17);
    }
    n = 14e5;
    for (const q of s.parts) {
      if (q.type === 'smoke') { const a = clamp(q.life * 0.9, 0, 0.9), r = 1 + (1.1 - q.life) * 2.4; oval(q.x, q.y, r, r, { fill: css([255, 255, 255], a), col: pale(a * 0.6), w: 0.3 }); }
      else if (q.type === 'dust') raw(q.x, q.y, q.x - q.vx * 0.05, q.y - q.vy * 0.05 - 0.4, 0.3, pale(clamp(q.life * 2.5, 0, 0.8)));
      else if (q.type === 'splash') { g.globalAlpha = clamp(q.life * 3, 0, 1); dot(q.x, q.y, 0.5, '#fff'); g.strokeStyle = pale(0.6); g.lineWidth = 0.18; g.stroke(); g.globalAlpha = 1; }
    }

    // --- nightfall: a violet wash over the whole page, then the lights on top ---
    if (night > 0) {
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = css(mix([255, 255, 255], [168, 164, 216], night)); g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'source-over';
      n = 15e5;
      for (const [x, y, ph] of s.stars) if (y < 26 && Math.abs(x - s.bal.x) > 10) {
        const a = night * (0.55 + 0.45 * Math.sin(t * 3 + ph)), r = 0.5 + (ph % 1) * 0.5, col = css([255, 252, 230], a);
        raw(x - r, y, x + r, y, 0.26, col); raw(x, y - r, x, y + r, 0.26, col);
      }
      const my = 10 + (1 - night) * 24, moon = [];
      for (let i = 0; i <= 8; i++) { const a = ((50 + i * 32.5) * Math.PI) / 180; moon.push(150 + Math.cos(a) * 4.4, my + Math.sin(a) * 4.4); }
      for (const d of [280, 230, 180, 130, 80]) { const a = (d * Math.PI) / 180; moon.push(152.4 + Math.cos(a) * 3.5, my + Math.sin(a) * 3.5); }
      glow(150, my, 14, [240, 240, 255], 0.3 * night);
      ink(moon, { soft: true, fill: css([255, 250, 228], night), col: pale(0.5 * night), w: 0.3, amp: 0.1 });
    }
    if (s.flash > 0) { g.fillStyle = css([255, 255, 255], s.flash * 0.12); g.fillRect(0, 0, W, WATER); }
    if (night > 0.25) {
      const a = smooth(0.25, 0.7, night);
      for (const L of LAMPS) if (L < s.D - 1) { const x = X0 + L * SEG + 3.4; glow(x, 31, 9, [255, 226, 150], 0.55 * a); dot(x, 31, 0.8, css([255, 246, 210], a)); }
      g.fillStyle = css([255, 214, 110], a); g.fillRect(240.2, 33.4, 2.6, 2.6); glow(241.5, 34.7, 7, [255, 214, 110], 0.4 * a);
    }
    const green = s.finale && s.finale.phase >= 1, sy = green ? 28.8 : 26.9;
    glow(22.5, sy, 3.5, green ? [77, 255, 136] : [255, 84, 84], 0.6); dot(22.5, sy, 0.75, green ? '#4dff88' : '#ff5454');
    if (trainOn && night > 0) {
      const x0 = tr.x - 24;
      g.fillStyle = css([255, 233, 160], night * 0.9);
      g.fillRect(x0 + 2.3, 29.1, 4, 2.6);
      for (let j = 0; j < 2; j++) for (let w = 0; w < 4; w++) g.fillRect(x0 - 21 - j * 21 + 2.3 + w * 4.1, 30.9, 2.4, 2.4);
      gr = g.createLinearGradient(x0 + 24, 0, x0 + 46, 0);
      gr.addColorStop(0, css([255, 244, 190], 0.5 * night)); gr.addColorStop(1, css([255, 244, 190], 0));
      g.fillStyle = gr; g.beginPath(); g.moveTo(x0 + 24, 32.6); g.lineTo(x0 + 46, 28); g.lineTo(x0 + 46, 40); g.lineTo(x0 + 24, 34.2); g.fill();
    }
    for (const q of s.parts) if (q.type === 'fire') {
      g.globalAlpha = clamp(q.life * 1.6, 0, 1);
      raw(q.x, q.y, q.x - q.vx * 0.08, q.y - q.vy * 0.08, 0.7, q.c);
      dot(q.x, q.y, 0.5, '#fff');
    }
    for (const q of s.parts) if (q.type === 'confetti') { g.globalAlpha = clamp(q.life * 2, 0, 1); raw(q.x, q.y, q.x + q.vx * 0.04 + 0.6, q.y + 0.5, 0.6, q.c); }
    g.globalAlpha = 1;
    n = 16e5;
    for (const [type, x, y, v] of extras) {
      if (type === 'snore') { const r = Math.max(0.3, 0.9 + Math.sin(t * 2.2 + v) * 0.8); oval(x + Math.sign(x - v) * r, y, r, r, { fill: css([200, 232, 255], 0.6), w: 0.28 }); }
      else if (type === 'heart') ink([x, y + 2.8, x - 2.7, y + 0.2, x - 1.5, y - 1.7, x, y - 0.5, x + 1.5, y - 1.7, x + 2.7, y + 0.2], { fill: RED, w: 0.35, amp: 0.08 });
      else for (const a of [-0.6, 0, 0.6]) ln(x + Math.sin(a) * 1.4, y + 2.2 - Math.cos(a) * 1.4, x + Math.sin(a) * 3.2, y + 2.2 - Math.cos(a) * 3.2, { w: 0.55, col: RED });
    }

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'multiply'; g.drawImage(s.paper, 0, 0); g.globalCompositeOperation = 'source-over';
    g.setTransform(k, 0, 0, k, 0, 0);
    if (s.fade > 0) { g.fillStyle = css([12, 14, 22], s.fade); g.fillRect(0, 0, W, H); }
  }
}

/* ---------- sound: tiny synth, no audio files ---------- */

const noiseBuffers = new WeakMap();
function noise(ac) {
  let b = noiseBuffers.get(ac);
  if (!b) {
    b = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = b.getChannelData(0);
    let s = 1234567;
    for (let i = 0; i < d.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = s / 2147483648 - 1; }
    noiseBuffers.set(ac, b);
  }
  return b;
}
function tone(ac, out, type, f0, f1, t, dur, vol, attack = 0.004) {
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.02);
}
function hiss(ac, out, kind, f0, f1, t, dur, vol) {
  const src = ac.createBufferSource(), flt = ac.createBiquadFilter(), g = ac.createGain();
  src.buffer = noise(ac);
  src.loop = true;
  flt.type = kind;
  flt.frequency.setValueAtTime(f0, t);
  flt.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(flt).connect(g).connect(out);
  src.start(t, (t * 7.3) % 0.9);
  src.stop(t + dur + 0.02);
}
const PENTA = [0, 2, 4, 7, 9];
const note = (step) => 196 * 2 ** ((12 * Math.floor(step / 5) + PENTA[step % 5]) / 12);

/** Play one event on any AudioContext (live or offline) at time t. */
export function playSound(ac, out, type, t, data) {
  switch (type) {
    case 'place': { // each beam is the next note of a slowly rising tune
      const f = note(Math.floor(data / 4) + [0, 2, 1, 3][data % 4]);
      tone(ac, out, 'sine', f, f, t, 0.3, 0.22);
      tone(ac, out, 'sine', f * 4, f * 4, t, 0.06, 0.05);
      break;
    }
    case 'pier':
      tone(ac, out, 'sine', 120, 50, t, 0.3, 0.5);
      tone(ac, out, 'square', 523, 523, t, 0.07, 0.04);
      hiss(ac, out, 'bandpass', 1400, 500, t, 0.25, 0.12);
      break;
    case 'tap': tone(ac, out, 'sine', 520, 940, t, 0.09, 0.16); break;
    case 'splash': hiss(ac, out, 'bandpass', 1800, 420, t, 0.32, 0.3); tone(ac, out, 'sine', 700, 300, t, 0.12, 0.08); break;
    case 'stall': tone(ac, out, 'triangle', 330, 311, t, 0.28, 0.12, 0.02); tone(ac, out, 'triangle', 262, 233, t + 0.26, 0.5, 0.12, 0.02); break;
    case 'resume': tone(ac, out, 'triangle', 392, 392, t, 0.1, 0.12); tone(ac, out, 'triangle', 587, 587, t + 0.09, 0.16, 0.12); break;
    case 'done': [523, 659, 784, 1047].forEach((f, i) => tone(ac, out, 'triangle', f, f, t + i * 0.09, i === 3 ? 0.7 : 0.16, 0.16)); break;
    case 'whistle':
      for (const f of [370, 466, 554]) {
        tone(ac, out, 'triangle', f * 0.97, f, t, 0.32, 0.1, 0.04);
        tone(ac, out, 'triangle', f * 0.97, f, t + 0.42, 1.1, 0.1, 0.05);
      }
      break;
    case 'chug': hiss(ac, out, 'lowpass', 1100, 500, t, 0.08, 0.16); break;
    case 'firework': hiss(ac, out, 'highpass', 1800, 3200, t, 0.4, 0.13); tone(ac, out, 'sine', 900, 180, t, 0.22, 0.07); break;
    case 'arrived': [784, 1047, 1319].forEach((f) => tone(ac, out, 'triangle', f, f, t, 1.2, 0.09, 0.02)); break;
  }
}

/* ---------- <load-bearing> custom element ---------- */

if (typeof customElements !== 'undefined' && !customElements.get('load-bearing')) {
  customElements.define('load-bearing', class extends HTMLElement {
    static observedAttributes = ['progress'];
    disconnectedCallback() { this.loader?.stop(); }
    connectedCallback() {
      if (this.loader) { if (!this.hasAttribute('manual')) this.loader.start(); return; }
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
        :host{display:block;aspect-ratio:4/1;border-radius:9999px;position:relative;cursor:pointer;
          -webkit-tap-highlight-color:transparent;touch-action:manipulation;user-select:none;
          padding:var(--lb-frame-width,2.4%);background:var(--lb-frame,linear-gradient(#3a4257,#161b28));
          box-shadow:0 1px 0 rgba(255,255,255,.18) inset,0 30px 60px -20px rgba(0,0,0,.6),0 0 0 1px rgba(0,0,0,.5)}
        div{width:100%;height:100%;border-radius:9999px;overflow:hidden;position:relative;background:#0c0e16;
          box-shadow:0 0 0 1px rgba(0,0,0,.6)}
        div::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
          box-shadow:inset 0 6px 14px rgba(0,0,0,.35),inset 0 -2px 6px rgba(255,255,255,.08)}
        canvas{display:block;width:100%;height:100%}
      </style><div><canvas role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="Loading"></canvas></div>`;
      const canvas = root.querySelector('canvas');
      const L = (this.loader = new LoadBearing(canvas, {
        demo: this.hasAttribute('demo'),
        loop: !this.hasAttribute('once'),
        autoplay: !this.hasAttribute('manual'),
        seed: +this.getAttribute('seed') || 7,
      }));
      // A value set before the element was upgraded or attached still counts.
      const early = Object.hasOwn(this, 'progress') ? this.progress : this._early;
      delete this.progress;
      if (early !== undefined) L.setProgress(early);
      else if (this.hasAttribute('progress')) L.setProgress(this.getAttribute('progress'));
      canvas.setAttribute('aria-valuenow', L.percent);
      const fire = (name) => this.dispatchEvent(new CustomEvent(name, { detail: { percent: L.percent, stalled: L.stalled } }));
      for (const type of ['place', 'pier']) L.on(type, () => { canvas.setAttribute('aria-valuenow', L.percent); fire('progress'); });
      L.on('reset', () => { canvas.setAttribute('aria-valuenow', 0); fire('progress'); });
      for (const type of ['stall', 'resume', 'done', 'arrived']) L.on(type, () => fire(type));
      L.draw();
    }
    attributeChangedCallback(name, _, value) { if (name === 'progress') this.loader?.setProgress(value); }
    get progress() { return this.loader?.target ?? this._early ?? 0; }
    set progress(p) { if (this.loader) this.loader.setProgress(p); else this._early = p; }
    get percent() { return this.loader?.percent ?? 0; }
    enableSound(on) { this.loader?.enableSound(on); }
  });
}
