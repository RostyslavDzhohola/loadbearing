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

const SHIRTS = ['#d9634c', '#4f8fb0', '#f1ede0'];
const LINE = '#4a3428', SKIN = '#f3cfa8';

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

// Light by progress: one colour multiplied over the painting. Dawn, day, golden hour, dusk, night.
const GRADE = [[0, [255, 226, 206]], [0.2, [255, 255, 255]], [0.65, [255, 255, 255]], [0.82, [255, 200, 156]], [0.92, [196, 146, 176]], [1, [100, 108, 180]]];
function gradeAt(p) {
  for (let i = 1; i < GRADE.length; i++) if (p <= GRADE[i][0]) { const a = GRADE[i - 1], b = GRADE[i]; return mix(a[1], b[1], (p - a[0]) / (b[0] - a[0])); }
  return GRADE[GRADE.length - 1][1];
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

  /* ---------- rendering: a painted backdrop (towering clouds, green hills) with cel-style figures on top ---------- */

  draw() {
    const s = this, g = s.g, t = s.t;
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const want = clamp(Math.round(((s.c.clientWidth || (W * 4) / dpr) * dpr) / 4) * 4, W * 2, W * 10);
    if (s.c.width !== want || s.c.height !== want / 4) { s.c.width = want; s.c.height = want / 4; s.back = null; }
    const k = s.c.width / W;
    if (!s.back) paintLayers(s, k);
    g.setTransform(k, 0, 0, k, 0, 0);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    g.lineCap = g.lineJoin = 'round';
    const { P, dot, oval, rect, ln, puff } = (s.pen ||= pen(g));
    const glow = (x, y, r, col, a) => {
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, css(col, a)); gr.addColorStop(1, css(col, 0));
      g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
    };

    const grade = gradeAt(s.sp);
    const night = smooth(0.84, 1, s.sp), dusk = smooth(0.6, 0.82, s.sp) * (1 - smooth(0.9, 1, s.sp)), dawn = 1 - smooth(0, 0.2, s.sp);
    const fx = X0 + s.D * SEG, bg = s.barge;
    const WOODC = '#b98a62', WOODL = '#e0bb90', DARK = '#5c463c', RED = '#d9634c', CREAM = '#f4e9d2', STRAW = '#e6c46e';
    const CLOUD = ['#a7bfdf', '#e6edf6', '#ffffff'];

    // --- sky ---
    let gr = g.createLinearGradient(0, 0, 0, WATER);
    gr.addColorStop(0, '#2f7fc6'); gr.addColorStop(0.6, '#8ec8ea'); gr.addColorStop(1, '#dcf0f2');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    if (dusk > 0 || dawn > 0) {
      gr = g.createLinearGradient(0, 6, 0, WATER);
      const warm = dusk > 0 ? [255, 160, 84] : [255, 186, 170], a = dusk > 0 ? 0.8 * dusk : 0.55 * dawn;
      gr.addColorStop(0, css(warm, 0)); gr.addColorStop(1, css(warm, a));
      g.fillStyle = gr; g.fillRect(0, 0, W, WATER);
    }
    const sunX = 30 + s.sp * 200, sunY = 34 - Math.sin(s.sp * Math.PI) * 26 + Math.max(0, s.sp - 0.8) * 70;
    glow(sunX, sunY, 30, [255, 248, 214], 0.75); dot(sunX, sunY, 4.6, '#fffbe6');
    const off = (t * 0.5) % W;
    g.drawImage(s.cloudL, off, 0, W, H); g.drawImage(s.cloudL, off - W, 0, W, H);
    for (const { x, y, w } of s.clouds) puff([[x + w * 0.2, y + 2.6, w * 0.16], [x + w * 0.42, y + 1.4, w * 0.22], [x + w * 0.66, y + 2, w * 0.19], [x + w * 0.86, y + 3, w * 0.13]], CLOUD);
    for (const q of s.birds) { const a = Math.sin(t * 12 + q.y) * 1.1; P([q.x - 2.2, q.y + a, q.x - 1, q.y - 1, q.x, q.y, q.x + 1, q.y - 1, q.x + 2.2, q.y + a], { soft: true, w: 0.35, line: '#3b3440' }); }

    // --- hills (painted once) and water ---
    g.drawImage(s.back, 0, 0, W, H);
    gr = g.createLinearGradient(0, WATER, 0, H);
    gr.addColorStop(0, '#8fcbdc'); gr.addColorStop(1, '#3f86b8');
    g.fillStyle = gr; g.fillRect(0, WATER, W, H - WATER);
    g.save(); g.beginPath(); g.rect(0, WATER, W, H - WATER); g.clip();
    g.globalAlpha = 0.3; g.translate(0, 2 * WATER); g.scale(1, -1); g.drawImage(s.back, 0, 0, W, H);
    g.restore();
    for (let r = 0; r < 4; r++) for (let j = 0; j < 7; j++) {
      const x = ((((j * 41 + r * 17 + t * (4 + r * 2.5) * (r % 2 ? 1 : -1)) % (W + 10)) + W + 10) % (W + 10)) - 5, y = WATER + 1.6 + r * 2.3;
      ln(x, y, x + 3 + (j % 3) * 1.6, y, 0.4, 'rgba(255,255,255,0.4)');
    }
    for (let i = 0; i < 40; i++) { const a = Math.sin(t * 4 + i * 2.4); if (a > 0.5) { const x = (i * 67.3) % W, y = WATER + 1 + ((i * 3.7) % 9); ln(x - 0.6, y, x + 0.6, y, 0.3, css([255, 255, 255], (a - 0.5) * 1.8)); } }
    if (sunY < DECK - 4) for (let r = 0; r < 4; r++) { const w = 3.6 - r * 0.5 + Math.sin(t * 3 + r) * 0.7, y = WATER + 1.6 + r * 2.3; ln(sunX - w, y, sunX + w, y, 0.6, 'rgba(255,250,220,0.85)'); }
    ln(0, WATER + 0.2, W, WATER + 0.2, 0.3, 'rgba(255,255,255,0.55)');
    for (const q of s.fish) {
      const x = q.x + q.dir * 12 * q.u, y = WATER - Math.sin(q.u * Math.PI) * 11, a = Math.atan2(-Math.cos(q.u * Math.PI) * 11 * Math.PI, 12) * q.dir;
      g.save(); g.translate(x, y); g.rotate(a); g.scale(q.dir, 1);
      P([-1.8, 0, -3.9, -1.6, -3.9, 1.6], { fill: '#f0a060', w: 0.25 });
      oval(0, 0, 2.4, 1.25, { fill: '#f0a060', w: 0.25 }); oval(0.2, 0.4, 1.6, 0.5, { fill: '#fde3c0', line: null }); dot(1.2, -0.3, 0.28, LINE);
      g.restore();
    }

    // --- timber trestles ---
    const beam = (x1, y1, x2, y2, w = 0.75) => { ln(x1, y1, x2, y2, w + 0.45, LINE); ln(x1, y1, x2, y2, w, '#9a6f4e'); };
    const trestle = (x, p) => {
      g.save(); g.beginPath(); g.rect(x - 4, H - 21 * p, 12, 30); g.clip();
      beam(x + 0.5, 44.6, x + 4, 49, 0.4); beam(x + 3.5, 44.6, x, 49, 0.4);
      beam(x + 0.1, 49.8, x + 4.3, 53.6, 0.4); beam(x + 3.9, 49.8, x - 0.3, 53.6, 0.4);
      beam(x + 0.7, 43, x - 0.6, H + 1); beam(x + 3.3, 43, x + 4.6, H + 1); beam(x - 0.1, 49.3, x + 4.1, 49.3, 0.5);
      g.restore();
      oval(x + 2, WATER + 0.7, 3.8, 0.6, { line: 'rgba(255,255,255,0.8)', w: 0.3 });
    };
    for (const p of PIERS) if (s.piers.has(p)) trestle(X0 + p * SEG, 1);
    if (bg.build) trestle(X0 + bg.build.k * SEG, bg.build.p);
    for (const p of PIERS) if (s.piers.has(p) && p + 2 <= s.D) { const x = X0 + p * SEG; beam(x - 3, 43.2, x + 0.6, 46.4, 0.4); beam(x + 7, 43.2, x + 3.4, 46.4, 0.4); }
    {
      const x = bg.x, y = WATER - 2 + Math.sin(t * 2) * 0.5;
      ln(x + 11.8, y, x + 11.8, y - 6.2, 0.6, DARK); ln(x + 11.8, y - 6.2, x + 19.4, y - 5.5, 0.6, DARK); ln(x + 11.8, y - 2.6, x + 15.4, y - 5.8, 0.3, DARK);
      ln(x + 18.8, y - 5.5, x + 18.8, y - (bg.build ? 3.2 + Math.sin(t * 14) * 0.5 : 2.6), 0.25, LINE);
      P([x - 0.5, y, x + 16.5, y, x + 14.5, y + 3.6, x + 1.5, y + 3.6], { fill: RED });
      ln(x + 0.2, y + 0.9, x + 15.9, y + 0.9, 0.5, CREAM);
      rect(x + 1.2, y - 4.2, 5.2, 4.2, { fill: CREAM }); rect(x + 2.3, y - 3.2, 2.2, 1.7, { fill: '#9ccbe0', w: 0.25 });
      rect(x + 0.8, y - 4.9, 6, 0.9, { fill: '#4f8fb0', w: 0.25 });
      oval(x + 8.6, y - 1.9, 1.2, 1.2, { fill: SKIN, w: 0.25 }); oval(x + 8.6, y - 2.8, 1.9, 0.5, { fill: STRAW, w: 0.25 });
    }

    // --- cliffs, tree, station (painted once) ---
    g.drawImage(s.front, 0, 0, W, H);

    // --- deck, railing, lamps ---
    if (s.D > 0) {
      let settled = s.D;
      while (settled > 0 && t - (s.placeT[settled - 1] ?? -9) < 0.14) settled--;
      if (settled > 0) {
        const x2 = X0 + settled * SEG;
        rect(X0, 40.6, x2 - X0, 2.4, { fill: WOODC, r: 0.2 });
        ln(X0 + 0.4, 41.1, x2 - 0.4, 41.1, 0.3, WOODL);
        g.strokeStyle = 'rgba(74,52,40,0.45)'; g.lineWidth = 0.18; g.beginPath();
        for (let i = 1; i < settled; i++) { g.moveTo(X0 + i * SEG, 41.4); g.lineTo(X0 + i * SEG, 42.8); }
        g.stroke();
      }
      for (let i = settled; i < s.D; i++) rect(X0 + i * SEG, 40.6 - (1 - (t - s.placeT[i]) / 0.14) * 3.5, SEG, 2.4, { fill: '#f4d27a', r: 0.2 });
    }
    const railed = s.finale ? NSEG : Math.max(0, s.D - 2);
    if (railed > 0) {
      g.strokeStyle = DARK; g.lineWidth = 0.28; g.beginPath();
      for (let i = 0; i <= railed; i++) { g.moveTo(X0 + i * SEG, 36.9); g.lineTo(X0 + i * SEG, 40.5); }
      g.stroke();
      ln(X0, 36.8, X0 + railed * SEG, 36.8, 0.45, DARK);
    }
    for (const L of LAMPS) if (L < s.D - 1) { const x = X0 + L * SEG + 1; P([x, 40.4, x, 32, x + 0.6, 30.4, x + 2.2, 30.2], { soft: true, w: 0.5, line: '#3b3440' }); oval(x + 2.4, 31, 0.9, 0.9, { fill: '#fdf6dc', w: 0.25 }); }

    const wheel = (wx, wy, r, a, col = DARK) => { oval(wx, wy, r, r, { fill: col, w: 0.3 }); ln(wx - Math.cos(a) * r * 0.7, wy - Math.sin(a) * r * 0.7, wx + Math.cos(a) * r * 0.7, wy + Math.sin(a) * r * 0.7, 0.25, STRAW); dot(wx, wy, r * 0.28, STRAW); };
    {
      const x = s.wagon.x, a = x / 1.6;
      if (!s.finale) { rect(x + 1, 33.6, 10, 1.7, { fill: '#d9a66b', w: 0.25 }); rect(x + 2, 31.9, 8, 1.7, { fill: '#e3b77e', w: 0.25 }); }
      P([x - 0.4, 35.4, x + 12.4, 35.4, x + 11.4, 37.8, x + 0.6, 37.8], { fill: '#8a5a3c' });
      ln(x + 0.2, 35.9, x + 11.8, 35.9, 0.3, '#b07a55');
      wheel(x + 2.6, 38.6, 1.6, a); wheel(x + 9.4, 38.6, 1.6, a);
    }
    {
      const cx = s.bal.x, ty = 3.5 + s.bal.oy + Math.sin(t * 1.4) * 1.2;
      const body = [cx - 9, ty + 8, cx - 7.4, ty + 1.6, cx, ty - 1.4, cx + 7.4, ty + 1.6, cx + 9, ty + 8, cx + 6.4, ty + 14, cx + 2.6, ty + 17.6, cx - 2.6, ty + 17.6, cx - 6.4, ty + 14];
      ln(cx - 4.4, ty + 14, cx - 2.2, ty + 18.4, 0.22, LINE); ln(cx + 4.4, ty + 14, cx + 2.2, ty + 18.4, 0.22, LINE);
      g.save(); P(body, { soft: true, fill: RED, line: null }); g.clip();
      P([cx - 1.2, ty - 1, cx - 4.6, ty + 8, cx - 1.6, ty + 18, cx + 1.6, ty + 18, cx + 4.6, ty + 8, cx + 1.2, ty - 1], { soft: true, fill: CREAM, line: null });
      g.fillStyle = 'rgba(70,30,70,0.2)'; g.fillRect(cx + 2.6, ty - 2, 8, 22);
      oval(cx - 3.6, ty + 5, 1.1, 2.6, { fill: 'rgba(255,255,255,0.35)', line: null });
      g.restore();
      P(body, { soft: true, close: true });
      rect(cx - 2.6, ty + 18.2, 5.2, 3.2, { fill: '#a8754c', r: 0.5 }); ln(cx - 2.4, ty + 19.3, cx + 2.4, ty + 19.3, 0.2, DARK);
    }

    // --- the crew: straw hats, cel shading ---
    const person = (x, feet, dir, shirt, pose, swing, asleep) => {
      const Y = feet - 9, TR = '#44597a';
      if (pose === 'sit') { ln(x, Y + 7.4, x + dir * 2.6, Y + 7.3, 1.2, TR); ln(x + dir * 2.6, Y + 7.3, x + dir * 3, Y + 8.6, 1.1, TR); dot(x + dir * 3.3, Y + 8.8, 0.62, LINE); }
      else { const a = pose === 'walk' ? Math.sin(swing) * 1.7 : 0.8; for (const sg of [-1, 1]) { ln(x + sg * 0.5, Y + 6.6, x + sg * a, Y + 8.5, 1.15, TR); dot(x + sg * a + dir * 0.25, Y + 8.75, 0.62, LINE); } }
      rect(x - 1.7, Y + 3.6, 3.4, 3.7, { fill: shirt, r: 1.2, w: 0.25 });
      const arm = (side, tx, ty) => { ln(x + side * 1.3, Y + 4.6, x + tx, Y + ty, 0.9, shirt); dot(x + tx, Y + ty, 0.5, SKIN); };
      if (pose === 'carry') { arm(-1, -2.6, 0.6); arm(1, 2.6, 0.6); }
      else if (pose === 'cheer') { const w = Math.sin(t * 11 + x) * 0.8; arm(-1, -3.4 + w, 0.8); arm(1, 3.4 - w, 0.8); }
      else if (pose === 'sit') { arm(dir, dir * 3.4, 5.2); arm(-dir, -dir * 2, 6.8); }
      else { const a = pose === 'walk' ? Math.sin(swing) * 1.3 : 0; arm(-1, -2.2 - a * 0.4, 7); arm(1, 2.2 + a * 0.4, 7); }
      dot(x - dir * 0.5, Y + 2, 1.8, '#5a3d2e');
      oval(x + dir * 0.1, Y + 2.2, 1.65, 1.65, { fill: SKIN, w: 0.25 });
      dot(x + dir * 1, Y + 2.9, 0.42, 'rgba(240,120,110,0.55)');
      if (asleep) ln(x + dir * 0.5, Y + 2.4, x + dir * 1.3, Y + 2.4, 0.25, LINE);
      else dot(x + dir * 0.9, Y + 2.2, 0.3, LINE);
      oval(x, Y + 0.9, 2.8, 0.75, { fill: STRAW, w: 0.25 });
      P([x - 1.5, Y + 0.8, x - 1.3, Y - 0.3, x, Y - 0.8, x + 1.3, Y - 0.3, x + 1.5, Y + 0.8], { soft: false, fill: '#f0d488', w: 0.25 });
      ln(x - 1.4, Y + 0.6, x + 1.4, Y + 0.6, 0.32, RED);
    };

    const trainOn = s.finale && s.finale.phase === 1, tr = s.train;
    const extras = [];
    for (const c of s.crew) {
      const sit = !s.finale && c.state === 'wait' && c.idle > 1.2, asleep = sit && c.idle > 1.9;
      const carry = c.state === 'go' || c.state === 'place';
      const feet = DECK + 0.4 + c.jy - (s.finale && c.x >= 229 ? 4.4 : 0) + (sit ? 0.6 : 0);
      const pose = sit ? 'sit' : carry ? 'carry' : s.finale && c.at ? 'cheer' : c.moving ? 'walk' : 'stand';
      person(c.x, feet, c.dir, c.shirt, pose, c.x * 1.25, asleep);
      if (carry) { const o = c.state === 'place' ? 3 * c.dir : 0, by = feet - 9 + (c.state === 'place' ? 2 : -1.6); rect(c.x - 4 + o, by, 8, 1.7, { fill: '#e3b77e', w: 0.25 }); }
      if (sit) {
        const mx = c.x + c.dir * 4.2, my = feet - 4.6;
        rect(mx - 0.9, my, 1.8, 1.9, { fill: '#fff', w: 0.22, r: 0.3 });
        for (let j = 0; j < 2; j++) { const u = (t * 0.7 + j * 0.5 + c.x) % 1; dot(mx + Math.sin(u * 6 + j) * 0.5, my - 0.6 - u * 3, 0.35 + u * 0.3, css([255, 255, 255], 0.7 * (1 - u))); }
        if (asleep) extras.push(['snore', c.x + c.dir * 2.3, feet - 6.2, c.x]);
      }
      if (c.bub > 0) extras.push([c.bubType, c.x, feet - 12.5, c.bub]);
    }
    {
      const d = s.dog, x = d.x, y = DECK + 0.4 + d.jy - (s.finale && d.x >= 229 ? 4.4 : 0), a = d.moving ? Math.sin(d.x * 1.6) * 1.1 : 0;
      for (const sg of [-1, 1]) { ln(x + sg * 1.6, y - 1.6, x + sg * (1.6 - a), y - 0.2, 0.95, LINE); ln(x + sg * 1.6, y - 1.6, x + sg * (1.6 - a), y - 0.2, 0.5, '#fff'); }
      ln(x - d.dir * 2.6, y - 3.2, x - d.dir * 3.9, y - 4.9 + Math.sin(t * 16) * 0.5, 0.9, LINE); ln(x - d.dir * 2.6, y - 3.2, x - d.dir * 3.9, y - 4.9 + Math.sin(t * 16) * 0.5, 0.45, '#fff');
      oval(x, y - 2.8, 2.8, 1.4, { fill: '#fff', w: 0.25 });
      oval(x + d.dir * 2.9, y - 4.4, 1.45, 1.35, { fill: '#fff', w: 0.25 });
      oval(x + d.dir * 2.1, y - 5.2, 0.7, 0.95, { fill: '#b07a55', w: 0.22 });
      dot(x - d.dir * 0.6, y - 3.1, 0.8, '#b07a55');
      dot(x + d.dir * 3.3, y - 4.6, 0.28, LINE); dot(x + d.dir * 4.3, y - 4.1, 0.34, LINE);
    }
    if (trainOn) {
      const x0 = tr.x - 24, a = tr.x / 1.8;
      for (let j = 0; j < 2; j++) {
        const cx = x0 - 21 - j * 21;
        ln(cx + 19, 36, cx + 21, 36, 0.6, LINE);
        rect(cx, 28.6, 19, 8.2, { fill: j ? CREAM : '#4f8fb0', r: 0.8 });
        ln(cx + 0.4, 35, cx + 18.6, 35, 0.6, j ? RED : CREAM);
        rect(cx - 0.4, 27.6, 19.8, 1.6, { fill: DARK, r: 0.7, w: 0.25 });
        for (let w = 0; w < 4; w++) rect(cx + 2 + w * 4.1, 30.4, 3, 3, { fill: '#bfe0ee', w: 0.25, r: 0.4 });
        wheel(cx + 3.5, 38.5, 1.75, a); wheel(cx + 15.5, 38.5, 1.75, a);
      }
      P([x0 + 17.2, 30.6, x0 + 17, 25.6, x0 + 16.4, 24.6, x0 + 20.6, 24.6, x0 + 20, 25.6, x0 + 19.8, 30.6], { fill: '#3b3440' });
      rect(x0 + 7, 30.2, 16.5, 6.8, { fill: '#2f6f58', r: 2.2 });
      ln(x0 + 9, 31.4, x0 + 21.5, 31.4, 0.4, '#6fae7c'); oval(x0 + 12.5, 30.2, 1.5, 1.3, { fill: STRAW, w: 0.25 });
      rect(x0, 26.8, 9.5, 10.2, { fill: '#3d8452', r: 0.5 }); rect(x0 + 2, 28.8, 4.6, 3.2, { fill: '#bfe0ee', w: 0.25, r: 0.4 });
      rect(x0 - 1, 25.8, 11.5, 1.5, { fill: DARK, r: 0.7, w: 0.25 });
      ln(x0 + 0.3, 35, x0 + 23, 35, 0.5, RED);
      P([x0 + 23.6, 36.4, x0 + 26.8, 40.2, x0 + 23, 40.2], { fill: RED, w: 0.25 });
      wheel(x0 + 3, 38.5, 1.75, a, '#c9503f'); wheel(x0 + 10, 38.5, 1.75, a, '#c9503f'); wheel(x0 + 17, 38.5, 1.75, a, '#c9503f');
    }
    for (const q of s.parts) {
      if (q.type === 'smoke') { g.globalAlpha = clamp(q.life * 0.9, 0, 0.9); puff([[q.x, q.y, 1.2 + (1.1 - q.life) * 2.6]], ['#b9c2cf', '#eef1f6', '#ffffff']); }
      else if (q.type === 'dust') dot(q.x, q.y, 0.6, css([240, 228, 205], clamp(q.life * 2.5, 0, 0.9)));
      else if (q.type === 'splash') dot(q.x, q.y, 0.45, css([255, 255, 255], clamp(q.life * 3, 0, 1)));
      g.globalAlpha = 1;
    }
    // seeds drifting on the wind
    if (night < 1) for (let i = 0; i < 14; i++) {
      const x = ((i * 53.7 + t * (5 + (i % 4) * 2)) % (W + 10)) - 5, y = 8 + ((i * 37) % 30) + Math.sin(t * 1.3 + i) * 2.5;
      dot(x, y, 0.26, css([255, 255, 255], 0.85 * (1 - night)));
    }

    // --- time of day: one colour multiplied over the whole painting, then the lights on top ---
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = css(grade); g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
    if (night > 0) {
      const hidden = (x, y) => s.blobs.some(([bx, by, br]) => { let dx = Math.abs(((bx + off) % W) - x); dx = Math.min(dx, W - dx); return dx * dx + (by - y) * (by - y) < (br + 0.8) * (br + 0.8); })
        || s.clouds.some((c) => x > c.x - 1 && x < c.x + c.w + 1 && y > c.y - 3 && y < c.y + 6) || Math.abs(x - s.bal.x) < 11;
      for (const [x, y, ph] of s.stars) if (y < 26 && !hidden(x, y)) {
        const a = night * (0.55 + 0.45 * Math.sin(t * 3 + ph)), r = 0.4 + (ph % 1) * 0.45;
        glow(x, y, r * 3, [200, 215, 255], a * 0.5); dot(x, y, r * 0.55, css([255, 252, 235], a));
      }
      const my = 9 + (1 - night) * 24;
      glow(132, my, 16, [210, 225, 255], 0.4 * night); dot(132, my, 4.2, css([250, 248, 232], night));
      dot(130.6, my - 1, 0.9, css([226, 226, 214], night * 0.8)); dot(133.4, my + 1.4, 0.6, css([226, 226, 214], night * 0.8));
    }
    if (s.flash > 0) { g.fillStyle = css([255, 255, 255], s.flash * 0.1); g.fillRect(0, 0, W, WATER); }
    if (night > 0.25) {
      const a = smooth(0.25, 0.7, night);
      for (const L of LAMPS) if (L < s.D - 1) { const x = X0 + L * SEG + 3.4; glow(x, 31, 10, [255, 214, 130], 0.6 * a); dot(x, 31, 0.8, css([255, 246, 210], a)); }
      g.fillStyle = css([255, 214, 110], a); g.fillRect(240.2, 33.4, 2.6, 2.6); glow(241.5, 34.7, 8, [255, 204, 110], 0.45 * a);
    }
    const green = s.finale && s.finale.phase >= 1, sy = green ? 28.8 : 26.9;
    glow(22.5, sy, 3.5, green ? [77, 255, 136] : [255, 84, 84], 0.6); dot(22.5, sy, 0.75, green ? '#4dff88' : '#ff5454');
    if (trainOn && night > 0) {
      const x0 = tr.x - 24;
      g.fillStyle = css([255, 226, 150], night * 0.95);
      g.fillRect(x0 + 2.3, 29.1, 4, 2.6);
      for (let j = 0; j < 2; j++) for (let w = 0; w < 4; w++) g.fillRect(x0 - 21 - j * 21 + 2.3 + w * 4.1, 30.7, 2.4, 2.4);
      gr = g.createLinearGradient(x0 + 24, 0, x0 + 48, 0);
      gr.addColorStop(0, css([255, 240, 180], 0.55 * night)); gr.addColorStop(1, css([255, 240, 180], 0));
      g.fillStyle = gr; g.beginPath(); g.moveTo(x0 + 24, 32.6); g.lineTo(x0 + 48, 27); g.lineTo(x0 + 48, 40); g.lineTo(x0 + 24, 34.2); g.fill();
      dot(x0 + 24, 33.4, 0.9, '#fff8d0');
    }
    g.globalCompositeOperation = 'lighter';
    for (const q of s.parts) if (q.type === 'fire') {
      g.globalAlpha = clamp(q.life * 1.6, 0, 1);
      ln(q.x, q.y, q.x - q.vx * 0.08, q.y - q.vy * 0.08, 0.7, q.c);
      dot(q.x, q.y, 0.5, '#fff');
    }
    g.globalCompositeOperation = 'source-over';
    for (const q of s.parts) if (q.type === 'confetti') { g.globalAlpha = clamp(q.life * 2, 0, 1); rect(q.x, q.y, 1.1, 0.7, { fill: q.c, line: null, r: 0.2 }); }
    g.globalAlpha = 1;
    for (const [type, x, y, v] of extras) {
      if (type === 'snore') { const r = Math.max(0.3, 0.9 + Math.sin(t * 2.2 + v) * 0.8); oval(x + Math.sign(x - v) * r, y, r, r, { fill: css([210, 238, 255], 0.6), line: 'rgba(255,255,255,0.9)', w: 0.25 }); }
      else if (type === 'heart') { g.fillStyle = '#ff6b81'; g.beginPath(); g.moveTo(x, y + 2.6); g.bezierCurveTo(x - 3.4, y, x - 1.4, y - 2, x, y - 0.4); g.bezierCurveTo(x + 1.4, y - 2, x + 3.4, y, x, y + 2.6); g.fill(); }
      else for (const a of [-0.6, 0, 0.6]) ln(x + Math.sin(a) * 1.4, y + 2.2 - Math.cos(a) * 1.4, x + Math.sin(a) * 3.2, y + 2.2 - Math.cos(a) * 3.2, 0.6, '#ffd23f');
    }

    // paint grain
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'multiply'; g.globalAlpha = 0.6; g.drawImage(s.paper, 0, 0);
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    g.setTransform(k, 0, 0, k, 0, 0);
    if (s.fade > 0) { g.fillStyle = css([12, 14, 22], s.fade); g.fillRect(0, 0, W, H); }
  }
}

/* ---------- drawing helpers ---------- */

function pen(c) {
  const path = (pts, close, soft) => {
    const m = pts.length >> 1;
    c.beginPath();
    if (m < 2) return;
    const X = (i) => pts[(i % m) * 2], Y = (i) => pts[(i % m) * 2 + 1];
    if (!soft) { c.moveTo(X(0), Y(0)); for (let i = 1; i < m; i++) c.lineTo(X(i), Y(i)); if (close) c.closePath(); }
    else if (close) {
      c.moveTo((X(m - 1) + X(0)) / 2, (Y(m - 1) + Y(0)) / 2);
      for (let i = 0; i < m; i++) c.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2);
      c.closePath();
    } else {
      c.moveTo(X(0), Y(0));
      for (let i = 1; i < m - 1; i++) c.quadraticCurveTo(X(i), Y(i), i === m - 2 ? X(i + 1) : (X(i) + X(i + 1)) / 2, i === m - 2 ? Y(i + 1) : (Y(i) + Y(i + 1)) / 2);
      if (m === 2) c.lineTo(X(1), Y(1));
    }
  };
  const paint = (o) => {
    if (o.fill) { c.fillStyle = o.fill; c.fill(); }
    if (o.line !== null) { c.strokeStyle = o.line || LINE; c.lineWidth = o.w ?? 0.3; c.stroke(); }
  };
  // P(points, { fill, line, w, soft, close }): `line: null` for no outline. The path stays current, so it can be clipped to.
  const P = (pts, o = {}) => { path(pts, o.close || !!o.fill, o.soft); paint(o); };
  const oval = (x, y, rx, ry, o = {}) => { c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, 7); paint(o); };
  const rect = (x, y, w, h, o = {}) => { c.beginPath(); c.roundRect(x, y, w, h, o.r ?? 0.3); paint(o); };
  const dot = (x, y, r, fill) => { c.fillStyle = fill; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); };
  const ln = (x1, y1, x2, y2, w, col) => { c.strokeStyle = col; c.lineWidth = w; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); };
  // Billowing mass (cloud, foliage, smoke) from [x, y, r] blobs: shadow, body, then highlights, each as one layer.
  const puff = (blobs, [dark, body, light]) => {
    for (const [x, y, r] of blobs) dot(x, y + r * 0.22, r, dark);
    for (const [x, y, r] of blobs) dot(x - r * 0.12, y - r * 0.1, r * 0.88, body);
    for (const [x, y, r] of blobs) dot(x - r * 0.28, y - r * 0.3, r * 0.52, light);
  };
  return { P, oval, rect, dot, ln, puff };
}

// The parts of the picture that never move are painted once per canvas size: cloud bank, hills, cliffs.
function paintLayers(s, k) {
  const layer = () => {
    const cv = document.createElement('canvas');
    cv.width = s.c.width; cv.height = s.c.height;
    const c = cv.getContext('2d');
    c.setTransform(k, 0, 0, k, 0, 0); c.lineCap = c.lineJoin = 'round';
    return [cv, c, pen(c)];
  };
  const r = rng(11);
  const FOLIAGE = ['#2c6b4a', '#4c9a5c', '#9ccf6e'];
  {
    const [cv, , p] = layer();
    s.blobs = [];
    for (const [cx, base, w, hgt, nb] of [[60, 47, 56, 31, 36], [200, 47, 64, 34, 42], [128, 47, 30, 12, 14]]) for (let i = 0; i < nb; i++) {
      const u = r(), a = r() ** 1.5;
      s.blobs.push([cx + (u - 0.5) * w * (1 - a * 0.65), base - a * hgt * (1 - Math.abs(u - 0.5) * 0.9), (3 + r() * 3.2) * (1 - a * 0.35) * (w / 56)]);
    }
    p.puff(s.blobs, ['#a7bfdf', '#e6edf6', '#ffffff']);
    s.cloudL = cv;
  }
  {
    const [cv, c, p] = layer();
    s.mid = s.far.map((_, x) => 8 + 4 * Math.sin(x * 0.034 + 4) + 3 * Math.sin(x * 0.09 + 1));
    const ridge = (hs, lift, c1, c2, n, light, dark) => {
      const pts = [-3, WATER + 2];
      for (let x = -3; x <= W + 3; x += 3) pts.push(x, WATER - hs[clamp(x, 0, W - 1)] - lift);
      pts.push(W + 3, WATER + 2);
      const gr = c.createLinearGradient(0, WATER - 24, 0, WATER);
      gr.addColorStop(0, c1); gr.addColorStop(1, c2);
      c.save(); p.P(pts, { soft: true, fill: gr, line: null }); c.clip();
      for (let i = 0; i < n; i++) p.oval(r() * W, WATER - r() * 26, 1.2 + r() * 3, 0.35 + r() * 0.6, { fill: r() < 0.5 ? light : dark, line: null });
      c.restore();
    };
    const trees = (hs, lift, n, size) => { for (let i = 0; i < n; i++) { const x = Math.floor(r() * W), y = WATER - hs[x] - lift + 0.4 + r() * 3, z = size * (0.7 + r() * 0.6); p.puff([[x - z * 0.7, y + z * 0.2, z * 0.8], [x + z * 0.7, y + z * 0.25, z * 0.75], [x, y - z * 0.4, z]], FOLIAGE); } };
    ridge(s.far, 2, '#7ea6c8', '#bcd6e2', 120, 'rgba(255,255,255,0.10)', 'rgba(60,90,140,0.10)');
    ridge(s.mid, 0, '#6fae7c', '#93c79c', 220, 'rgba(200,230,140,0.22)', 'rgba(40,100,80,0.16)');
    trees(s.mid, 0, 30, 1.1);
    ridge(s.near, -1, '#58a55c', '#3d8452', 260, 'rgba(205,232,110,0.28)', 'rgba(30,90,60,0.2)');
    trees(s.near, -1, 22, 1.4);
    s.back = cv;
  }
  {
    const [cv, c, p] = layer();
    const cliff = (pts, xa, xb) => {
      const gr = c.createLinearGradient(0, DECK, 0, H);
      gr.addColorStop(0, '#a98466'); gr.addColorStop(1, '#6f5750');
      c.save(); p.P(pts, { fill: gr }); c.clip();
      for (let i = 0; i < 46; i++) { const x = xa + r() * (xb - xa), y = 41 + r() * 23; p.ln(x, y, x + 1 + r() * 2, y + 2 + r() * 2.5, 0.55, r() < 0.5 ? 'rgba(244,220,186,0.26)' : 'rgba(60,40,44,0.22)'); }
      c.restore();
      const grass = [];
      for (let x = xa; x <= xb; x += 1.25) grass.push([x, 41.5 + r() * 0.5, 1.15 + r() * 0.5]);
      grass.push([xa === 0 ? xb - 0.4 : xa + 0.4, 42.9, 0.9]);
      p.puff(grass, ['#2f7a48', '#4fa257', '#a6d46a']);
      for (let i = 0; i < 12; i++) p.dot(xa + r() * (xb - xa), 40.9 + r() * 0.9, 0.3, ['#ffffff', '#ffe36e', '#ff9db0'][i % 3]);
    };
    const tree = (x, y, sx, sy, n, z) => { const b = []; for (let i = 0; i < n; i++) { const a = r() * 6.2832, d = Math.sqrt(r()); b.push([x + Math.cos(a) * d * sx, y + Math.sin(a) * d * sy, z * (0.75 + r() * 0.5)]); } p.puff(b, FOLIAGE); };
    cliff([-3, 40.6, X0, 40.6, X0 - 1.2, 47, X0 - 4, 53, X0 - 7, H + 3, -3, H + 3], 0, X0);
    cliff([W + 3, 40.6, 228, 40.6, 229.2, 47, 232, 53, 235, H + 3, W + 3, H + 3], 228, W);
    p.P([7, 41.2, 7.9, 35, 7.5, 30, 9.5, 30, 9.7, 35, 10.8, 41.2], { fill: '#7a5540' });
    tree(8.8, 26.4, 5.2, 4.4, 20, 2.5);
    tree(253, 29, 3, 4, 10, 2);
    p.ln(22.5, 40.8, 22.5, 30, 0.5, '#3b3440'); p.rect(21.2, 25.6, 2.6, 4.6, { fill: '#3b3440', r: 0.8 });
    p.rect(247.2, 25.2, 1.8, 4.4, { fill: '#b0705a' });
    p.rect(238, 31, 12, 9.6, { fill: '#f4e9d2' });
    p.rect(246.6, 31.2, 3.3, 9.3, { fill: 'rgba(110,90,120,0.2)', line: null, r: 0 });
    p.P([236.2, 31.6, 244, 25.2, 251.8, 31.6], { fill: '#d9634c' });
    p.ln(237.8, 30.9, 244, 25.9, 0.35, 'rgba(255,220,190,0.6)');
    p.rect(246, 35.2, 2.8, 5.4, { fill: '#8a5a3c', w: 0.25 }); p.rect(240, 33.2, 3, 3, { fill: '#9ccbe0', w: 0.25 });
    p.ln(241.5, 33.2, 241.5, 36.2, 0.2, LINE);
    p.puff([[238.4, 39.6, 1], [238.2, 38, 0.8], [239.6, 40, 0.8]], FOLIAGE);
    p.rect(229, 36, 20, 4.6, { fill: '#b98a62' }); p.ln(229.5, 36.6, 248.5, 36.6, 0.3, '#e0bb90');
    s.front = cv;
  }
  { // grain, multiplied over the finished frame
    const cv = (s.paper = document.createElement('canvas')), q = rng(5);
    cv.width = s.c.width; cv.height = s.c.height;
    const pc = cv.getContext('2d');
    pc.fillStyle = '#fff'; pc.fillRect(0, 0, cv.width, cv.height);
    for (let i = 0; i < (cv.width * cv.height) / 50; i++) { const z = (0.5 + q() * 1.5) * (k / 4); pc.fillStyle = `rgba(90,70,40,${0.03 + q() * 0.07})`; pc.fillRect(q() * cv.width, q() * cv.height, z, z); }
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
