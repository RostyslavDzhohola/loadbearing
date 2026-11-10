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

const W = 256, H = 64;            // logical pixels (CSS scales them up)
const SEG = 4, NSEG = 50, X0 = 28; // 50 deck segments of 4px between the cliffs
const DECK = 40, WATER = 54;
const PIERS = [5, 10, 15, 20, 25, 30, 35, 40, 45];
const PIERSET = new Set(PIERS);
const TOTAL = NSEG + PIERS.length; // every deck piece and every pier is one task
const LAMPS = [2, 12, 22, 32, 42];
const STEP = 1 / 60;

const HAT = '#f7c531', SKIN = '#f3c9a0', PANTS = '#2c3550', BOOT = '#1a1f30';
const SHIRTS = ['#e8503a', '#3aa0e8', '#58b368'];
const BEAM = '#b9793f', BEAM2 = '#8f5a2c';

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
  [0.0, [108, 140, 200], [255, 196, 160]],
  [0.3, [70, 150, 230], [170, 220, 250]],
  [0.65, [80, 150, 225], [200, 225, 240]],
  [0.82, [120, 130, 200], [255, 180, 110]],
  [0.92, [60, 50, 120], [235, 120, 100]],
  [1.0, [24, 32, 84], [78, 76, 150]],
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

const FONT = {
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111',
  4: '101101111001001', 5: '111100111001111', 6: '111100111101111', 7: '111001010010010',
  8: '111101111101111', 9: '111101111001111', '%': '101001010100101', '!': '010010010000010',
  z: '111001010100111',
};

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
    this.fg = document.createElement('canvas');
    this.fg.width = W;
    this.fg.height = H;
    this.f = this.fg.getContext('2d');
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
    this.specks = Array.from({ length: 46 }, () => [Math.floor(r() * 30), 44 + Math.floor(r() * 20), r() < 0.5]);

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

  /* ---------- rendering ---------- */

  draw() {
    const s = this, g = s.g, f = s.f, t = s.t;
    const R = (ctx, x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); };
    const disc = (ctx, cx, cy, r, c) => {
      ctx.fillStyle = c;
      for (let dy = -r; dy <= r; dy++) {
        const hw = Math.floor(Math.sqrt(r * r + r * 0.6 - dy * dy));
        ctx.fillRect(Math.round(cx) - hw, Math.round(cy) + dy, hw * 2 + 1, 1);
      }
    };
    const text = (ctx, str, x, y, c) => {
      ctx.fillStyle = c;
      for (const ch of String(str)) {
        const bits = FONT[ch];
        if (bits) for (let i = 0; i < 15; i++) if (bits[i] === '1') ctx.fillRect(x + (i % 3), y + ((i / 3) | 0), 1, 1);
        x += 4;
      }
    };
    const [top, bot] = skyAt(s.sp);
    const night = smooth(0.8, 1, s.sp);
    const fx = X0 + s.D * SEG;

    // --- sky (never darkened) ---
    for (let y = 0; y < WATER; y += 2) R(g, 0, y, W, 2, css(mix(top, bot, y / WATER)));
    if (s.flash > 0) R(g, 0, 0, W, WATER, css([255, 255, 255], s.flash * 0.16));
    if (night > 0) for (const [x, y, ph] of s.stars) R(g, x, y, 1, 1, css([255, 255, 230], night * (0.55 + 0.45 * Math.sin(t * 3 + ph))));
    const sunX = 30 + s.sp * 200, sunY = 34 - Math.sin(s.sp * Math.PI) * 26 + Math.max(0, s.sp - 0.8) * 70;
    const sunC = mix([255, 246, 196], [255, 150, 90], smooth(0.6, 0.95, s.sp));
    disc(g, sunX, sunY, 5, css(sunC));
    if (night > 0) {
      const my = 11 + (1 - night) * 24;
      g.fillStyle = css([240, 240, 255], night);
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        if (dx * dx + dy * dy <= 18 && (dx - 2) ** 2 + (dy + 1) ** 2 > 11) g.fillRect(150 + dx, Math.round(my) - 2 + dy, 1, 1);
      }
    }
    for (const c of s.clouds) {
      const col = css(mix([255, 255, 255], top, 0.12 + night * 0.62));
      R(g, c.x + 3, c.y - 2, c.w - 8, 2, col);
      R(g, c.x + 1, c.y, c.w - 3, 2, col);
      R(g, c.x, c.y + 2, c.w, 2, col);
    }
    for (const q of s.birds) {
      const up = Math.sin(t * 14 + q.y) > 0;
      R(g, q.x - 2, q.y + (up ? -1 : 0), 2, 1, '#2a3044');
      R(g, q.x, q.y + (up ? 0 : -1), 1, 1, '#2a3044');
      R(g, q.x + 1, q.y + (up ? -1 : 0), 2, 1, '#2a3044');
    }

    // --- scene (darkened as night falls) ---
    f.clearRect(0, 0, W, H);
    const farC = css(mix(bot, [70, 90, 140], 0.55)), nearC = css(mix(bot, [66, 128, 92], 0.72));
    for (let x = 0; x < W; x++) R(f, x, WATER - s.far[x], 1, s.far[x], farC);
    for (let x = 0; x < W; x++) R(f, x, WATER - s.near[x], 1, s.near[x], nearC);

    // balloon carrying the percentage (drawn in the bright layer below)
    const drawBalloon = () => {
      const cx = Math.round(s.bal.x), ty = Math.round(4 + s.bal.oy + Math.sin(t * 1.4) * 1.2);
      const hw = [4, 6, 8, 9, 9, 9, 9, 9, 9, 8, 7, 5, 4, 3];
      hw.forEach((h, r) => {
        if (r >= 3 && r <= 9) return R(f, cx - h, ty + r, h * 2, 1, '#fff8e8');
        for (let dx = -h; dx < h; dx++) R(f, cx + dx, ty + r, 1, 1, Math.floor((dx + 20) / 4) % 2 ? '#e8503a' : '#f6c94c');
      });
      const label = s.percent + '%', lw = label.length * 4 - 1;
      text(f, label, cx - Math.ceil(lw / 2), ty + 4, '#1c2230');
      R(f, cx - 3, ty + 14, 1, 2, '#4a4a4a'); R(f, cx + 2, ty + 14, 1, 2, '#4a4a4a');
      R(f, cx - 1, ty + 14, 2, 1, Math.sin(t * 20) > 0 ? '#ff9a3c' : '#ffd23f');
      R(f, cx - 3, ty + 16, 6, 3, '#8a5a3c'); R(f, cx - 3, ty + 16, 6, 1, '#a9744b');
    };

    // water
    const waterC = mix([44, 112, 186], top, 0.35);
    R(f, 0, WATER, W, H - WATER, css(waterC));
    const waveC = css(mix(waterC, [255, 255, 255], 0.3));
    for (let r = 0; r < 5; r++) for (let j = 0; j < 7; j++) {
      const x = (((j * 41 + r * 17 + t * (5 + r * 3) * (r % 2 ? 1 : -1)) % W) + W) % W;
      R(f, x, WATER + 1 + r * 2, 3 + (j % 2) * 2, 1, waveC);
    }
    if (sunY < WATER - 6) for (let r = 0; r < 5; r++) R(f, sunX - 2 + (Math.floor(t * 2 + r) % 2), WATER + 1 + r * 2, 4 - (r % 2), 1, css(sunC, 0.7));
    for (const q of s.fish) {
      const x = q.x + q.dir * 12 * q.u, y = WATER - Math.sin(q.u * Math.PI) * 11;
      R(f, x - 2, y, 4, 2, '#ff9a3c'); R(f, x - q.dir * 3, y - 1, 1, 4, '#ff9a3c'); R(f, x + q.dir, y, 1, 1, '#1c2230');
    }

    // piers
    for (const k of s.piers) {
      const x = X0 + k * SEG;
      R(f, x, 43, 4, 21, '#7d8590'); R(f, x, 43, 1, 21, '#9aa2ad'); R(f, x - 1, 43, 6, 2, '#666d78'); R(f, x - 1, WATER, 6, 1, '#e6f6ff');
    }
    const bg = s.barge;
    if (bg.build) {
      const x = X0 + bg.build.k * SEG, h = Math.round(21 * bg.build.p);
      R(f, x, H - h, 4, h, '#7d8590'); R(f, x, H - h, 1, h, '#9aa2ad');
    }
    {
      const x = Math.round(bg.x), y = WATER - 2 + Math.round(Math.sin(t * 2) * 0.6);
      R(f, x, y, 16, 3, '#b5543a'); R(f, x + 1, y + 3, 14, 1, '#7c3626');
      R(f, x + 1, y - 4, 5, 4, '#f1e3c6'); R(f, x + 2, y - 3, 2, 2, '#5aa9e6');
      R(f, x + 7, y - 4, 2, 1, HAT); R(f, x + 7, y - 3, 2, 3, '#2f6fd0');
      R(f, x + 11, y - 5, 1, 5, '#f2c230'); R(f, x + 11, y - 6, 8, 1, '#f2c230');
      R(f, x + 18, y - 5, 1, bg.build ? 2 + (Math.floor(t * 12) % 2) : 3, '#2b2b2b');
    }

    // cliffs, tree, signal post, house
    for (let y = DECK; y < H; y++) {
      const inset = (y - DECK) >> 2;
      R(f, 0, y, X0 - inset, 1, '#8a6a4a'); R(f, 228 + inset, y, W - 228 - inset, 1, '#8a6a4a');
    }
    for (const [x, y, dark] of s.specks) {
      const c = dark ? '#735539' : '#9c7b58';
      if (x < X0 - ((y - DECK) >> 2) - 1) R(f, x, y, 2, 1, c);
      if (W - x > 228 + ((y - DECK) >> 2) + 2) R(f, W - x - 2, y, 2, 1, c);
    }
    R(f, 0, DECK + 1, X0, 2, '#5fae4e'); R(f, 228, DECK + 1, 28, 2, '#5fae4e');
    R(f, 0, DECK, X0, 1, '#9aa3ad'); R(f, 228, DECK, 28, 1, '#9aa3ad');
    R(f, 7, 33, 2, 7, '#7c4a2a'); disc(f, 8, 30, 4, '#3f8f4a'); R(f, 6, 27, 3, 2, '#58b368');
    R(f, 22, 29, 1, 11, '#3b4250'); R(f, 21, 26, 3, 4, '#1c2230');
    R(f, 238, 31, 12, 9, '#e9d8b8'); R(f, 237, 28, 14, 3, '#b5543a'); R(f, 239, 26, 10, 2, '#b5543a');
    R(f, 246, 35, 3, 5, '#7c4a2a'); R(f, 240, 33, 3, 3, '#5aa9e6'); R(f, 247, 23, 2, 3, '#7d8590');
    R(f, 229, 36, 20, 4, '#8a5a3c'); R(f, 229, 36, 20, 1, '#c79a6b'); // station platform, behind the track

    // deck: rail on top, sleepers, steel beam, truss
    for (let i = 0; i < s.D; i++) {
      const x = X0 + i * SEG, age = t - (s.placeT[i] ?? -9), yo = age < 0.12 ? -Math.round((1 - age / 0.12) * 3) : 0;
      R(f, x, DECK + yo, 4, 1, '#9aa3ad');
      R(f, x, DECK + 1 + yo, 4, 1, i % 2 ? '#8a5a3c' : '#a9744b');
      R(f, x, DECK + 2 + yo, 4, 1, '#4b5563');
      R(f, x, DECK + 3 + yo, 1, 1, '#4b5563'); R(f, x + 1, DECK + 4 + yo, 2, 1, '#4b5563'); R(f, x + 3, DECK + 3 + yo, 1, 1, '#4b5563');
    }
    const railed = s.finale ? NSEG : s.D - 2;
    for (let i = 0; i < railed; i++) {
      const x = X0 + i * SEG;
      R(f, x, 36, 4, 1, '#d6dbe2');
      if (i % 2 === 0) R(f, x, 37, 1, 3, '#b9c0ca');
    }
    for (const L of LAMPS) if (L < s.D - 1) { const x = X0 + L * SEG + 1; R(f, x, 30, 1, 10, '#3b4250'); R(f, x, 30, 3, 1, '#3b4250'); R(f, x + 2, 31, 1, 1, '#cfd6e0'); }

    // wagon
    {
      const x = Math.round(s.wagon.x), spin = Math.floor(s.wagon.x / 2) % 2;
      if (!s.finale) { R(f, x + 1, 34, 10, 2, BEAM); R(f, x + 2, 32, 8, 2, BEAM2); R(f, x + 1, 34, 10, 1, '#d09050'); }
      R(f, x, 36, 12, 2, '#6b4a2e'); R(f, x, 35, 1, 1, '#6b4a2e'); R(f, x + 11, 35, 1, 1, '#6b4a2e');
      for (const wx of [x + 1, x + 8]) { R(f, wx, 38, 3, 2, '#1c2230'); R(f, wx + (spin ? 0 : 2), 38 + spin, 1, 1, '#9aa3ad'); }
    }

    // Scenery gets the full night tint; the actors below stay readable.
    const tint = (a) => {
      f.globalCompositeOperation = 'source-atop';
      R(f, 0, 0, W, H, css([10, 14, 46], a));
      f.globalCompositeOperation = 'source-over';
      g.drawImage(s.fg, 0, 0);
      f.clearRect(0, 0, W, H);
    };
    tint(night * 0.3);
    drawBalloon();

    // train
    const tr = s.train, trainOn = s.finale && s.finale.phase === 1;
    const drawTrain = () => {
      const x0 = Math.round(tr.x) - 24, spin = Math.floor(tr.x / 2) % 2;
      const wheel = (wx) => { R(f, wx, 37, 3, 3, '#1c2230'); R(f, wx + 1, 38, 1, 1, spin ? '#cfd6e0' : '#6b727c'); };
      for (let j = 0; j < 2; j++) {
        const cx = x0 - 21 - j * 21;
        R(f, cx, 29, 19, 8, j ? '#e0a030' : '#2a7f86'); R(f, cx, 28, 19, 1, j ? '#a8731c' : '#1d5a5f'); R(f, cx, 35, 19, 1, '#f6e7c8');
        R(f, cx + 19, 36, 2, 1, '#1c2230');
        wheel(cx + 2); wheel(cx + 14);
      }
      R(f, x0 + 8, 31, 14, 6, '#c0392b'); R(f, x0 + 8, 31, 14, 1, '#e05a48');
      R(f, x0, 27, 9, 10, '#962d22'); R(f, x0 - 1, 26, 11, 1, '#1c2230');
      R(f, x0 + 17, 26, 3, 5, '#1c2230'); R(f, x0 + 16, 25, 5, 1, '#1c2230');
      R(f, x0 + 12, 29, 3, 2, '#f2c230'); R(f, x0 + 22, 32, 2, 5, '#1c2230');
      R(f, x0, 37, 23, 1, '#1c2230'); R(f, x0 + 23, 37, 2, 2, '#7d8590'); R(f, x0 + 24, 39, 2, 1, '#7d8590');
      wheel(x0 + 2); wheel(x0 + 9); wheel(x0 + 16);
    };

    // crew
    const bubbles = [];
    for (const c of s.crew) {
      const sit = !s.finale && c.state === 'wait' && c.idle > 1.2;
      const carry = c.state === 'go' || c.state === 'place';
      const cheer = s.finale && c.at;
      const X = Math.round(c.x) - 3, Y = DECK + Math.round(c.jy) - 9 + (sit ? 2 : 0) - (s.finale && c.x >= 229 ? 4 : 0);
      const fr = c.moving ? Math.floor(c.x / 2.5) & 1 : 0;
      R(f, X + 1, Y, 4, 1, HAT); R(f, c.dir > 0 ? X + 1 : X, Y + 1, 5, 1, HAT);
      R(f, X + 1, Y + 2, 4, 2, SKIN); R(f, c.dir > 0 ? X + 4 : X + 1, Y + 2, 1, 1, BOOT);
      R(f, X + 1, Y + 4, 4, 3, c.shirt);
      if (carry) {
        R(f, X, Y + 1, 1, 4, SKIN); R(f, X + 5, Y + 1, 1, 4, SKIN);
        const by = c.state === 'place' ? Y + 2 : Y - 1;
        R(f, X - 1 + (c.state === 'place' ? 3 * c.dir : 0), by, 8, 2, BEAM); R(f, X - 1 + (c.state === 'place' ? 3 * c.dir : 0), by, 8, 1, '#d09050');
      } else if (cheer) {
        const up = c.jy < 0 || Math.sin(t * 10 + c.x) > 0;
        R(f, X, Y + (up ? 1 : 4), 1, 3, SKIN); R(f, X + 5, Y + (up ? 1 : 4), 1, 3, SKIN);
      } else {
        R(f, X, Y + 4 + fr, 1, 2, SKIN); R(f, X + 5, Y + 5 - fr, 1, 2, SKIN);
      }
      if (sit) {
        R(f, X + 1, Y + 6, 5, 1, PANTS); R(f, X + 5, Y + 6, 1, 1, BOOT);
        R(f, X + 6, Y + 4, 2, 2, '#fff'); // coffee
        if (Math.floor(t * 3 + c.x) % 2) R(f, X + 6, Y + 2, 1, 1, '#e9eef5');
        if (c.idle > 1.9) bubbles.push([X + 2, Y - 7 - (Math.floor(t * 2 + c.x) % 3), 'z']);
      } else {
        R(f, X + 1, Y + 7, 4, 1, PANTS);
        if (c.moving && fr) { R(f, X, Y + 8, 1, 1, BOOT); R(f, X + 5, Y + 8, 1, 1, BOOT); }
        else if (c.moving) { R(f, X + 2, Y + 8, 2, 1, BOOT); }
        else { R(f, X + 1, Y + 8, 1, 1, BOOT); R(f, X + 4, Y + 8, 1, 1, BOOT); }
      }
      if (c.bub > 0) bubbles.push([X + 2, Y - 7, c.bubType]);
    }

    // dog
    {
      const d = s.dog, X = Math.round(d.x), Y = DECK + Math.round(d.jy) - (s.finale && d.x >= 229 ? 4 : 0), fr = d.moving ? Math.floor(d.x / 2) & 1 : 0;
      R(f, X - 2, Y - 3, 4, 2, '#f1e3c6'); R(f, X + d.dir * 2 - (d.dir < 0 ? 1 : 0), Y - 5, 2, 3, '#f1e3c6');
      R(f, X + (d.dir > 0 ? 3 : -3), Y - 4, 1, 1, '#1c2230'); R(f, X - d.dir * 3 + (d.dir < 0 ? -1 : 0), Y - 4 - (Math.floor(t * 8) % 2), 1, 1, '#c9a26b');
      R(f, X - 2 + fr, Y - 1, 1, 1, '#c9a26b'); R(f, X + 1 - fr, Y - 1, 1, 1, '#c9a26b');
    }

    if (trainOn) drawTrain();

    for (const q of s.parts) if (q.type === 'dust' || q.type === 'splash' || q.type === 'smoke') {
      const sz = q.type === 'smoke' ? 2 + Math.round((1.1 - q.life) * 3) : 1;
      f.globalAlpha = q.type === 'smoke' ? clamp(q.life, 0, 0.8) : 1;
      R(f, q.x, q.y, sz, sz, q.c);
      f.globalAlpha = 1;
    }

    tint(night * 0.08);

    // --- lights and effects (drawn over the darkness) ---
    if (night > 0.25) {
      const a = smooth(0.25, 0.7, night);
      for (const L of LAMPS) if (L < s.D - 1) {
        const x = X0 + L * SEG + 3;
        disc(g, x, 32, 7, css([255, 233, 160], 0.1 * a)); disc(g, x, 32, 4, css([255, 233, 160], 0.16 * a));
        R(g, x, 31, 1, 1, css([255, 244, 200], a));
      }
      R(g, 240, 33, 3, 3, css([255, 214, 110], a));
      disc(g, 241, 34, 5, css([255, 214, 110], 0.12 * a));
    }
    const green = s.finale && s.finale.phase >= 1;
    R(g, 22, green ? 28 : 27, 1, 1, green ? '#4dff88' : '#ff4a4a');
    disc(g, 22, green ? 28 : 27, 2, green ? 'rgba(77,255,136,.22)' : 'rgba(255,74,74,.22)');
    if (trainOn) {
      const x0 = Math.round(tr.x) - 24;
      R(g, x0 + 2, 29, 4, 3, '#ffe9a0');
      for (let j = 0; j < 2; j++) for (let n = 0; n < 4; n++) R(g, x0 - 21 - j * 21 + 2 + n * 4, 31, 3, 3, '#ffe9a0');
      R(g, x0 + 24, 33, 1, 2, '#fff8d0');
      for (let d = 1; d < 18; d++) R(g, x0 + 24 + d, 33 - Math.floor(d / 5), 1, 2 + 2 * Math.floor(d / 5), css([255, 244, 190], 0.3 * (1 - d / 18)));
    }
    for (const q of s.parts) if (q.type === 'confetti' || q.type === 'fire') {
      g.globalAlpha = clamp(q.life * 2, 0, 1);
      R(g, q.x, q.y, q.type === 'fire' && q.life > 0.5 ? 2 : 1, q.type === 'fire' && q.life > 0.5 ? 2 : 1, q.c);
      if (q.type === 'fire' && q.life > 0.75) R(g, q.x - q.vx * 0.04, q.y - q.vy * 0.04, 1, 1, '#fff');
      g.globalAlpha = 1;
    }
    for (const [x, y, type] of bubbles) {
      if (type === 'heart') { R(g, x - 1, y, 1, 2, '#ff5d73'); R(g, x + 1, y, 1, 2, '#ff5d73'); R(g, x, y + 1, 1, 2, '#ff5d73'); }
      else text(g, type, x - 1, y - 1, type === 'z' ? '#fff' : '#ffd23f');
    }
    if (s.fade > 0) R(g, 0, 0, W, H, css([12, 14, 22], s.fade));
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
        canvas{display:block;width:100%;height:100%;image-rendering:pixelated}
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
