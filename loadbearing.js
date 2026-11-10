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

const W = 256, H = 64;            // scene units; drawn as vectors at the canvas's real size
const SEG = 4, NSEG = 50, X0 = 28; // 50 deck segments of 4px between the cliffs
const DECK = 40, WATER = 54;
const PIERS = [5, 10, 15, 20, 25, 30, 35, 40, 45];
const PIERSET = new Set(PIERS);
const TOTAL = NSEG + PIERS.length; // every deck piece and every pier is one task
const LAMPS = [2, 12, 22, 32, 42];
const STEP = 1 / 60;

const HAT = '#ffc93c', SKIN = '#f6d2b0', PANTS = '#1d2238';
const SHIRTS = ['#ef6f5a', '#2fa8a0', '#8b7cf6'];
const BEAM = '#c98d52';

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
  [0.0, [120, 170, 200], [255, 214, 170]],
  [0.3, [84, 178, 196], [214, 240, 226]],
  [0.65, [90, 180, 200], [240, 236, 206]],
  [0.82, [240, 140, 110], [255, 208, 140]],
  [0.92, [86, 62, 130], [240, 128, 112]],
  [1.0, [20, 26, 66], [70, 64, 140]],
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

  /* ---------- rendering: flat vector shapes, drawn at the canvas's real resolution ---------- */

  draw() {
    const s = this, g = s.g, f = s.f, t = s.t;
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const want = clamp(Math.round(((s.c.clientWidth || (W * 4) / dpr) * dpr) / 4) * 4, W * 2, W * 10);
    if (s.c.width !== want) { s.c.width = s.fg.width = want; s.c.height = s.fg.height = want / 4; }
    const k = s.c.width / W;
    g.setTransform(k, 0, 0, k, 0, 0);
    f.setTransform(k, 0, 0, k, 0, 0);
    g.lineCap = f.lineCap = 'round';
    g.lineJoin = f.lineJoin = 'round';

    const box = (c, x, y, w, h, r, fill) => { c.fillStyle = fill; c.beginPath(); c.roundRect(x, y, w, h, r); c.fill(); };
    const dot = (c, x, y, r, fill) => { c.fillStyle = fill; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); };
    const line = (c, x1, y1, x2, y2, w, col) => { c.strokeStyle = col; c.lineWidth = w; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); };
    const glow = (c, x, y, r, col, a) => {
      const gr = c.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, css(col, a)); gr.addColorStop(1, css(col, 0));
      c.fillStyle = gr; c.fillRect(x - r, y - r, r * 2, r * 2);
    };
    const [top, bot] = skyAt(s.sp);
    const night = smooth(0.8, 1, s.sp);
    const fx = X0 + s.D * SEG;
    const INK = '#1d2238';

    // --- sky ---
    let gr = g.createLinearGradient(0, 0, 0, WATER);
    gr.addColorStop(0, css(top)); gr.addColorStop(1, css(bot));
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    if (s.flash > 0) { g.fillStyle = css([255, 255, 255], s.flash * 0.14); g.fillRect(0, 0, W, WATER); }
    if (night > 0) for (const [x, y, ph] of s.stars) dot(g, x + 0.5, y + 0.5, 0.3 + (ph % 1) * 0.3, css([255, 250, 225], night * (0.5 + 0.5 * Math.sin(t * 3 + ph))));
    const sunX = 30 + s.sp * 200, sunY = 34 - Math.sin(s.sp * Math.PI) * 26 + Math.max(0, s.sp - 0.8) * 70;
    const sunC = mix([255, 244, 200], [255, 140, 96], smooth(0.55, 0.95, s.sp));
    glow(g, sunX, sunY, 20, sunC, 0.45);
    dot(g, sunX, sunY, 5.5, css(sunC));
    if (night > 0) {
      const my = 10 + (1 - night) * 24;
      glow(g, 150, my, 14, [220, 225, 255], 0.25 * night);
      g.save(); g.beginPath(); g.arc(150, my, 4.2, 0, 7); g.clip();
      g.fillStyle = css([244, 244, 255], night); g.fillRect(140, my - 8, 20, 16); dot(g, 152.2, my - 1.2, 3.7, css(mix(top, bot, my / WATER)));
      g.restore();
    }
    for (const c of s.clouds) {
      const col = css(mix([255, 255, 255], top, 0.1 + night * 0.6), 0.9);
      box(g, c.x, c.y + 1.2, c.w, 3, 1.5, col);
      dot(g, c.x + c.w * 0.36, c.y + 0.8, c.w * 0.17, col); dot(g, c.x + c.w * 0.62, c.y + 0.2, c.w * 0.22, col);
    }
    for (const q of s.birds) {
      const a = Math.sin(t * 12 + q.y) * 1.1;
      g.strokeStyle = INK; g.lineWidth = 0.5; g.beginPath();
      g.moveTo(q.x - 2.2, q.y + a); g.quadraticCurveTo(q.x - 1, q.y - 1, q.x, q.y); g.quadraticCurveTo(q.x + 1, q.y - 1, q.x + 2.2, q.y + a); g.stroke();
    }

    // --- scenery (gets the night tint) ---
    f.clearRect(0, 0, W, H);
    s.mid ||= s.far.map((_, x) => 8 + 4 * Math.sin(x * 0.034 + 4) + 3 * Math.sin(x * 0.09 + 1));
    const ridge = (hs, col, lift) => {
      f.fillStyle = col; f.beginPath(); f.moveTo(0, WATER);
      for (let x = 0; x < W; x += 2) f.lineTo(x, WATER - hs[x] - lift);
      f.lineTo(W, WATER - hs[W - 1] - lift); f.lineTo(W, WATER); f.fill();
    };
    ridge(s.far, css(mix(bot, [96, 112, 160], 0.45)), 2);
    ridge(s.mid, css(mix(bot, [58, 104, 128], 0.62)), 0);
    ridge(s.near, css(mix(bot, [36, 84, 92], 0.8)), -1);

    const waterC = mix([36, 120, 150], top, 0.3);
    gr = f.createLinearGradient(0, WATER, 0, H);
    gr.addColorStop(0, css(mix(waterC, bot, 0.35))); gr.addColorStop(1, css(mix(waterC, [10, 30, 60], 0.35)));
    f.fillStyle = gr; f.fillRect(0, WATER, W, H - WATER);
    for (let r = 0; r < 5; r++) for (let j = 0; j < 7; j++) {
      const x = (((j * 41 + r * 17 + t * (4 + r * 2.5) * (r % 2 ? 1 : -1)) % (W + 10)) + W + 10) % (W + 10) - 5, y = WATER + 1.3 + r * 2;
      line(f, x, y, x + 3 + (j % 2) * 2.5, y, 0.4, css([255, 255, 255], 0.28));
    }
    if (sunY < WATER - 6) for (let r = 0; r < 5; r++) { const w = 3.2 - r * 0.4 + Math.sin(t * 3 + r) * 0.6; line(f, sunX - w, WATER + 1.3 + r * 2, sunX + w, WATER + 1.3 + r * 2, 0.6, css(sunC, 0.75)); }
    for (const q of s.fish) {
      const x = q.x + q.dir * 12 * q.u, y = WATER - Math.sin(q.u * Math.PI) * 11, a = Math.atan2(-Math.cos(q.u * Math.PI) * 11 * Math.PI, 12) * q.dir;
      f.save(); f.translate(x, y); f.rotate(a); f.scale(q.dir, 1);
      f.fillStyle = '#ff9a52'; f.beginPath(); f.ellipse(0, 0, 2.4, 1.2, 0, 0, 7); f.fill();
      f.beginPath(); f.moveTo(-2, 0); f.lineTo(-4, -1.5); f.lineTo(-4, 1.5); f.fill();
      dot(f, 1.2, -0.3, 0.3, INK); f.restore();
    }

    // viaduct: stone piers, arches under the finished deck
    const STONE = '#c9c2b4', STONE2 = '#a69f93';
    const pier = (x, h) => { box(f, x, H - h, 4, h + 2, 0.8, STONE); box(f, x, H - h, 1.2, h + 2, 0.6, '#ddd7cb'); box(f, x - 0.6, WATER - 0.4, 5.2, 1, 0.5, css([255, 255, 255], 0.7)); };
    for (const p of s.piers) pier(X0 + p * SEG, 21);
    const bg = s.barge;
    if (bg.build) pier(X0 + bg.build.k * SEG, 21 * bg.build.p);
    f.save(); f.beginPath(); f.rect(0, 0, fx, H); f.clip();
    f.fillStyle = STONE2;
    for (let i = 0; i < 10; i++) {
      const a = X0 + i * 20 + (i ? 4 : 0), b = X0 + (i + 1) * 20, m = (a + b) / 2;
      f.beginPath(); f.moveTo(a, 43); f.lineTo(b, 43); f.lineTo(b, 51); f.bezierCurveTo(b, 44.5, a, 44.5, a, 51); f.fill();
      void m;
    }
    f.restore();
    {
      const x = bg.x, y = WATER - 2 + Math.sin(t * 2) * 0.5;
      f.fillStyle = '#ef6f5a'; f.beginPath(); f.moveTo(x - 0.5, y); f.lineTo(x + 16.5, y); f.lineTo(x + 14.5, y + 3.6); f.lineTo(x + 1.5, y + 3.6); f.fill();
      box(f, x + 1.2, y - 4.2, 5.2, 4.4, 1, '#fbf1dc'); box(f, x + 2.2, y - 3.2, 2.2, 1.8, 0.5, '#7fd0d8');
      dot(f, x + 8.2, y - 2.6, 1.1, SKIN); box(f, x + 7.2, y - 1.6, 2, 1.8, 0.6, '#2f6fd0'); f.fillStyle = HAT; f.beginPath(); f.arc(x + 8.2, y - 2.9, 1.2, Math.PI, 0); f.fill();
      line(f, x + 11.5, y, x + 11.5, y - 5.6, 0.8, '#ffc93c'); line(f, x + 11.5, y - 5.6, x + 19, y - 5.6, 0.8, '#ffc93c');
      line(f, x + 18.6, y - 5.6, x + 18.6, y - (bg.build ? 3.4 + Math.sin(t * 14) * 0.5 : 2.8), 0.35, INK);
    }

    // cliffs, tree, signal, house, platform
    gr = f.createLinearGradient(0, DECK, 0, H);
    gr.addColorStop(0, '#8a6f5c'); gr.addColorStop(1, '#5d4a45');
    f.fillStyle = gr;
    f.beginPath(); f.moveTo(0, DECK + 0.6); f.lineTo(X0, DECK + 0.6); f.quadraticCurveTo(X0 - 0.5, 52, X0 - 7, H); f.lineTo(0, H); f.fill();
    f.beginPath(); f.moveTo(W, DECK + 0.6); f.lineTo(228, DECK + 0.6); f.quadraticCurveTo(228.5, 52, 235, H); f.lineTo(W, H); f.fill();
    box(f, -2, DECK + 0.4, X0 + 2, 1.8, 0.9, '#6fbf73'); box(f, 228, DECK + 0.4, 30, 1.8, 0.9, '#6fbf73');
    line(f, 0, DECK + 0.3, X0, DECK + 0.3, 0.5, '#e8e4da'); line(f, 228, DECK + 0.3, W, DECK + 0.3, 0.5, '#e8e4da');
    line(f, 8, 40, 8, 33, 1.1, '#6b4a3a'); dot(f, 8, 30.5, 4.2, '#3f9a6a'); dot(f, 10.2, 28.6, 2.8, '#5ab77f'); dot(f, 6, 28.4, 2.4, '#4ca874');
    line(f, 22.5, 40, 22.5, 29.5, 0.6, INK); box(f, 21.2, 25.6, 2.6, 4.4, 1.1, INK);
    box(f, 238, 31, 12, 9.4, 0.8, '#fbf1dc');
    f.fillStyle = '#ef6f5a'; f.beginPath(); f.moveTo(236.4, 31.4); f.lineTo(244, 25.4); f.lineTo(251.6, 31.4); f.fill();
    box(f, 246, 35.2, 2.8, 5.2, 0.8, '#8a5a3c'); box(f, 240, 33.2, 3, 3, 0.6, '#7fd0d8'); box(f, 247.2, 25.6, 1.6, 3.4, 0.3, '#a69f93');
    box(f, 229, 36, 20, 4.6, 0.8, '#b98a62'); box(f, 229, 36, 20, 1.1, 0.5, '#d9b48c');

    // deck, railings, lamps
    if (s.D > 0) {
      let settled = s.D;
      while (settled > 0 && t - (s.placeT[settled - 1] ?? -9) < 0.14) settled--;
      box(f, X0, DECK + 0.6, settled * SEG, 2.4, 0.4, INK);
      line(f, X0, DECK + 0.3, X0 + settled * SEG, DECK + 0.3, 0.5, '#e8e4da');
      for (let i = settled; i < s.D; i++) { const yo = -(1 - (t - s.placeT[i]) / 0.14) * 3.5; box(f, X0 + i * SEG, DECK + 0.6 + yo, SEG, 2.4, 0.4, '#ffc93c'); }
    }
    const railed = s.finale ? NSEG : Math.max(0, s.D - 2);
    if (railed > 0) {
      const col = css([255, 255, 255], 0.75);
      line(f, X0, 36.8, X0 + railed * SEG, 36.8, 0.45, col);
      f.strokeStyle = col; f.lineWidth = 0.3; f.beginPath();
      for (let i = 0; i <= railed; i += 1) { f.moveTo(X0 + i * SEG, 36.8); f.lineTo(X0 + i * SEG, 40); }
      f.stroke();
    }
    for (const L of LAMPS) if (L < s.D - 1) {
      const x = X0 + L * SEG + 1;
      f.strokeStyle = INK; f.lineWidth = 0.55; f.beginPath(); f.moveTo(x, 40); f.lineTo(x, 31.5); f.quadraticCurveTo(x, 30, x + 2, 30.2); f.stroke();
      dot(f, x + 2.2, 30.8, 0.8, '#f4efe2');
    }
    {
      const x = s.wagon.x, a = s.wagon.x / 1.6;
      if (!s.finale) { box(f, x + 1, 33.6, 10, 1.6, 0.6, BEAM); box(f, x + 2, 31.8, 8, 1.6, 0.6, '#e0a868'); }
      box(f, x, 35.4, 12, 2.2, 0.8, '#6b4a3a');
      for (const wx of [x + 2.6, x + 9.4]) { dot(f, wx, 38.4, 1.6, INK); line(f, wx - Math.cos(a) * 1.1, 38.4 - Math.sin(a) * 1.1, wx + Math.cos(a) * 1.1, 38.4 + Math.sin(a) * 1.1, 0.35, '#c9c2b4'); }
    }
    const tint = (a) => {
      f.globalCompositeOperation = 'source-atop';
      f.fillStyle = css([12, 16, 56], a); f.fillRect(0, 0, W, H);
      f.globalCompositeOperation = 'source-over';
      g.drawImage(s.fg, 0, 0, W, H);
      f.clearRect(0, 0, W, H);
    };
    tint(night * 0.34);

    // --- actors (barely tinted, so they stay readable at night) ---
    {
      const cx = s.bal.x, ty = 3.5 + s.bal.oy + Math.sin(t * 1.4) * 1.2;
      line(f, cx - 4.6, ty + 13, cx - 2.2, ty + 18, 0.3, INK); line(f, cx + 4.6, ty + 13, cx + 2.2, ty + 18, 0.3, INK);
      f.save(); f.beginPath(); f.arc(cx, ty + 8, 8, Math.PI, 0); f.bezierCurveTo(cx + 8, ty + 13, cx + 3.5, ty + 15, cx + 2.4, ty + 17); f.lineTo(cx - 2.4, ty + 17); f.bezierCurveTo(cx - 3.5, ty + 15, cx - 8, ty + 13, cx - 8, ty + 8); f.clip();
      f.fillStyle = '#ef6f5a'; f.fillRect(cx - 9, ty - 1, 18, 19);
      f.fillStyle = '#fbf1dc'; for (const o of [-5.4, 0, 5.4]) { f.beginPath(); f.ellipse(cx + o, ty + 8, 1.5 - Math.abs(o) * 0.08, 10, 0, 0, 7); f.fill(); }
      f.fillStyle = css([0, 0, 0], 0.1); f.fillRect(cx + 2, ty - 1, 8, 19);
      f.restore();
      dot(f, cx, ty + 17.6, 0.7 + Math.sin(t * 20) * 0.2, '#ffb347');
      box(f, cx - 2.6, ty + 18, 5.2, 3.2, 0.9, '#8a5a3c');
    }

    const person = (c, x, feet, dir, shirt, pose, swing, mood) => {
      const Y = feet - 9;
      if (pose === 'sit') {
        line(c, x - 0.8, Y + 7.6, x + dir * 3.2, Y + 8.4, 1.2, PANTS);
      } else {
        const a = pose === 'walk' ? Math.sin(swing) * 1.7 : 0;
        line(c, x - 0.9, Y + 6.6, x - 0.9 + a, Y + 8.5, 1.2, PANTS); line(c, x + 0.9, Y + 6.6, x + 0.9 - a, Y + 8.5, 1.2, PANTS);
      }
      box(c, x - 2.2, Y + 3.2, 4.4, 4.2, 1.9, shirt);
      const arm = (side, tx2, ty2) => line(c, x + side * 2, Y + 4.3, x + tx2, Y + ty2, 0.95, SKIN);
      if (pose === 'carry') { arm(-1, -2.6, 0.4); arm(1, 2.6, 0.4); }
      else if (pose === 'cheer') { const w = Math.sin(t * 11 + x) * 0.8; arm(-1, -3.4 + w, 0.8); arm(1, 3.4 - w, 0.8); }
      else if (pose === 'sit') { arm(dir, dir * 3.6, 5); arm(-dir, -dir * 2.4, 6.6); }
      else { const a = pose === 'walk' ? Math.sin(swing) * 1.2 : 0; arm(-1, -2.6 - a * 0.3, 6.8); arm(1, 2.6 + a * 0.3, 6.8); }
      dot(c, x, Y + 2.1, 1.95, SKIN);
      c.fillStyle = HAT; c.beginPath(); c.arc(x, Y + 1.7, 2.15, Math.PI, 0); c.fill();
      box(c, x - 2.5 + dir * 0.7, Y + 1.3, 5, 0.8, 0.4, HAT);
      if (mood === 'asleep') line(c, x + dir * 0.5, Y + 2.6, x + dir * 1.4, Y + 2.6, 0.3, INK);
      else dot(c, x + dir * 0.95, Y + 2.5, 0.36, INK);
    };

    const trainOn = s.finale && s.finale.phase === 1, tr = s.train;
    const extras = [];
    for (const c of s.crew) {
      const sit = !s.finale && c.state === 'wait' && c.idle > 1.2, asleep = sit && c.idle > 1.9;
      const carry = c.state === 'go' || c.state === 'place';
      const feet = DECK + 0.4 + c.jy - (s.finale && c.x >= 229 ? 4.4 : 0) + (sit ? 0.6 : 0);
      const pose = sit ? 'sit' : carry ? 'carry' : s.finale && c.at ? 'cheer' : c.moving ? 'walk' : 'stand';
      person(f, c.x, feet, c.dir, c.shirt, pose, c.x * 1.25, asleep ? 'asleep' : '');
      if (carry) { const o = c.state === 'place' ? 3 * c.dir : 0, by = feet - 9 + (c.state === 'place' ? 2 : -1.4); box(f, c.x - 4 + o, by, 8, 1.6, 0.6, '#e0a868'); }
      if (sit) {
        const mx = c.x + c.dir * 4.2, my = feet - 4.4;
        box(f, mx - 0.9, my, 1.8, 1.9, 0.4, '#fff'); 
        for (let i = 0; i < 2; i++) { const u = (t * 0.7 + i * 0.5 + c.x) % 1; dot(f, mx + Math.sin(u * 6 + i) * 0.5, my - 0.6 - u * 3, 0.35 + u * 0.3, css([255, 255, 255], 0.6 * (1 - u))); }
        if (asleep) extras.push(['snore', c.x + c.dir * 2.3, feet - 6.2, c.x]);
      }
      if (c.bub > 0) extras.push([c.bubType, c.x, feet - 12.5, c.bub]);
    }
    {
      const d = s.dog, x = d.x, y = DECK + 0.4 + d.jy - (s.finale && d.x >= 229 ? 4.4 : 0), a = d.moving ? Math.sin(d.x * 1.6) * 1.1 : 0;
      line(f, x - 1.6, y - 1.6, x - 1.6 + a, y - 0.2, 0.7, '#e9d5b0'); line(f, x + 1.6, y - 1.6, x + 1.6 - a, y - 0.2, 0.7, '#e9d5b0');
      box(f, x - 2.8, y - 4, 5.6, 2.6, 1.3, '#fbf1dc');
      line(f, x - d.dir * 2.6, y - 3.4, x - d.dir * 3.8, y - 4.8 + Math.sin(t * 16) * 0.5, 0.6, '#fbf1dc');
      dot(f, x + d.dir * 2.9, y - 4.4, 1.5, '#fbf1dc'); dot(f, x + d.dir * 2.3, y - 5.5, 0.7, '#c9a26b');
      dot(f, x + d.dir * 3.4, y - 4.6, 0.3, INK); dot(f, x + d.dir * 4.3, y - 4, 0.35, INK);
    }
    if (trainOn) {
      const x0 = tr.x - 24, a = tr.x / 1.8;
      const wheel = (wx) => { dot(f, wx, 38.4, 1.75, INK); line(f, wx - Math.cos(a) * 1.2, 38.4 - Math.sin(a) * 1.2, wx + Math.cos(a) * 1.2, 38.4 + Math.sin(a) * 1.2, 0.35, '#c9c2b4'); };
      for (let j = 0; j < 2; j++) {
        const cx = x0 - 21 - j * 21;
        line(f, cx + 19, 36, cx + 21, 36, 0.6, INK);
        box(f, cx, 28.4, 19, 8.8, 2, j ? '#ffc93c' : '#2fa8a0'); box(f, cx, 28.4, 19, 1.6, 0.8, j ? '#d9a21c' : '#1f7f79');
        wheel(cx + 3.5); wheel(cx + 15.5);
      }
      box(f, x0 + 17, 25.4, 3, 6, 0.6, INK); box(f, x0 + 16.2, 24.8, 4.6, 1.4, 0.7, INK);
      box(f, x0 + 7, 30.4, 16.5, 6.8, 3, '#ef6f5a'); dot(f, x0 + 12.5, 30.4, 1.5, '#ffc93c');
      box(f, x0, 26.8, 9.5, 10.4, 1.4, '#c9503f'); box(f, x0 - 1, 26, 11.5, 1.5, 0.75, INK);
      f.fillStyle = '#c9c2b4'; f.beginPath(); f.moveTo(x0 + 23, 36.4); f.lineTo(x0 + 26.4, 40); f.lineTo(x0 + 23, 40); f.fill();
      wheel(x0 + 3); wheel(x0 + 10); wheel(x0 + 17);
    }
    for (const q of s.parts) if (q.type === 'dust' || q.type === 'splash' || q.type === 'smoke') {
      if (q.type === 'smoke') dot(f, q.x, q.y, 1 + (1.1 - q.life) * 2.4, css([240, 242, 248], clamp(q.life * 0.7, 0, 0.7)));
      else dot(f, q.x, q.y, q.type === 'dust' ? 0.55 : 0.45, css(q.type === 'dust' ? [233, 220, 200] : [235, 248, 255], clamp(q.life * 3, 0, 1)));
    }
    tint(night * 0.06);

    // --- lights and effects ---
    if (night > 0.25) {
      const a = smooth(0.25, 0.7, night);
      for (const L of LAMPS) if (L < s.D - 1) { const x = X0 + L * SEG + 3.2; glow(g, x, 31, 9, [255, 226, 150], 0.5 * a); dot(g, x, 30.8, 0.8, css([255, 246, 210], a)); }
      box(g, 240, 33.2, 3, 3, 0.6, css([255, 214, 110], a)); glow(g, 241.5, 34.7, 7, [255, 214, 110], 0.35 * a);
    }
    const green = s.finale && s.finale.phase >= 1, sy = green ? 28.6 : 27;
    glow(g, 22.5, sy, 3.5, green ? [77, 255, 136] : [255, 84, 84], 0.6); dot(g, 22.5, sy, 0.75, green ? '#4dff88' : '#ff5454');
    if (trainOn) {
      const x0 = tr.x - 24;
      box(g, x0 + 2, 28.8, 4.6, 3.2, 0.8, '#ffe9a0');
      for (let j = 0; j < 2; j++) for (let n = 0; n < 4; n++) box(g, x0 - 21 - j * 21 + 2 + n * 4.1, 30.8, 3, 3, 0.7, '#ffe9a0');
      gr = g.createLinearGradient(x0 + 24, 0, x0 + 46, 0);
      gr.addColorStop(0, css([255, 244, 190], 0.55)); gr.addColorStop(1, css([255, 244, 190], 0));
      g.fillStyle = gr; g.beginPath(); g.moveTo(x0 + 24, 32.6); g.lineTo(x0 + 46, 28); g.lineTo(x0 + 46, 40); g.lineTo(x0 + 24, 34.2); g.fill();
      dot(g, x0 + 24, 33.4, 0.9, '#fff8d0');
    }
    g.globalCompositeOperation = 'lighter';
    for (const q of s.parts) if (q.type === 'fire') {
      g.globalAlpha = clamp(q.life * 1.6, 0, 1);
      line(g, q.x, q.y, q.x - q.vx * 0.07, q.y - q.vy * 0.07, 0.7, q.c);
      dot(g, q.x, q.y, 0.55, '#fff');
    }
    g.globalCompositeOperation = 'source-over';
    for (const q of s.parts) if (q.type === 'confetti') { g.globalAlpha = clamp(q.life * 2, 0, 1); box(g, q.x, q.y, 1.1, 0.7, 0.2, q.c); }
    g.globalAlpha = 1;
    for (const [type, x, y, v] of extras) {
      if (type === 'snore') { const r = 0.9 + Math.sin(t * 2.2 + v) * 0.8; g.strokeStyle = css([255, 255, 255], 0.9); g.lineWidth = 0.3; g.fillStyle = css([190, 230, 255], 0.5); g.beginPath(); g.arc(x + Math.sign(x - v) * r, y, Math.max(0.2, r), 0, 7); g.fill(); g.stroke(); }
      else if (type === 'heart') { g.fillStyle = '#ff5d73'; g.beginPath(); g.moveTo(x, y + 2.6); g.bezierCurveTo(x - 3.4, y, x - 1.4, y - 2, x, y - 0.4); g.bezierCurveTo(x + 1.4, y - 2, x + 3.4, y, x, y + 2.6); g.fill(); }
      else for (const a of [-0.6, 0, 0.6]) line(g, x + Math.sin(a) * 1.4, y + 2.2 - Math.cos(a) * 1.4, x + Math.sin(a) * 3.2, y + 2.2 - Math.cos(a) * 3.2, 0.6, '#ffd23f');
    }
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
