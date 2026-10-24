/* ══════════════════════════════════════════════════════════
   独立仪式页 v3  ――  DOM + transform，不用 canvas

   为什么换掉 canvas：78 张牌每帧重设 shadowBlur，canvas 的阴影是
   软件模糊，一秒都撑不住。CSS 的 box-shadow + translate3d 走合成器，
   这才是「丝滑」的来源。

   0 选牌阵 → 1 长按拖拽洗牌 → 2 五档厚度切牌 → 3 固定窗口内拖动牌扇选牌、抽齐后统一翻面
   ══════════════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);
const clawbot = window.__CLAWBOT_RITUAL ?? null;
function setQuestionHeading() {
  const question = String(clawbot?.session?.question ?? '').replace(/\s+/g, ' ').trim();
  const label = question || '想一想你要问的事';
  const el = $('spread-name');
  if (!el) return;
  el.textContent = label;
  el.setAttribute('aria-label', question ? `本次问题：${question}` : label);
  if (question) el.title = question;
  else el.removeAttribute('title');
}
const cardApiUrl = new URL('/api/cards', window.__CLAWBOT_API_BASE__ ?? location.origin);
const cardCatalogPromise = fetch(cardApiUrl)
  .then((res) => res.ok ? res.json() : Promise.reject(new Error('牌面资料不可用')))
  .then((data) => Array.isArray(data.cards) ? data.cards : [])
  .catch(() => []);

const TOTAL = 78;
const W_SOFT = 10;      // 归位弹簧角频率
const W_FIRM = 20;      // 拖拽中
const ZETA = 1.0;       // 临界阻尼，不振荡
const CUT_MOVES = [12, 24, 39, 54, 66]; // 五档：薄、偏薄、一半、偏厚、厚

const SPREADS = [
  { id: 'single', name: '单张指引', n: 1, dims: ['此刻的指引'], tag: '快速' },
  { id: 'three', name: '三牌阵', n: 3, dims: ['过去', '现在', '未来'], tag: '常用' },
  { id: 'dim3', name: '三维关系牌阵', n: 3, dims: ['现状', '阻碍', '走向'], tag: '常用' },
  { id: 'dim4', name: '四维关系牌阵', n: 4, dims: ['你的现状', '对方的真实想法', '阻碍因素', '可能走向'], tag: '推荐' },
  { id: 'dim5', name: '五维事业牌阵', n: 5, dims: ['现状', '优势', '阻力', '机会', '走向'], tag: '' },
  { id: 'horseshoe', name: '马蹄形牌阵', n: 7, dims: ['过去', '现在', '隐藏', '障碍', '他人', '建议', '结果'], tag: '深度' },
  { id: 'celtic', name: '凯尔特十字', n: 10, dims: ['现状', '挑战', '根源', '近期', '意识', '潜意识', '建议', '环境', '期望', '结果'], tag: '深度' },
];

const S = {
  stage: 0,
  spread: SPREADS[3],
  cards: [],
  els: [],
  order: [],
  home: [],
  stir: 0,
  shuffleDurationMs: 0,
  cuts: 0,
  cutAt: [],
  cutAnim: null,
  shuffleTrace: [],
  shuffleStroke: null,
  picks: [],
  pickIndexes: [],
  pendingPick: null,
  drawError: false,
  deckBuilt: null,
  drag: null,
  pointer: null,
  gridDrag: null,
  gridMomentum: { x: 0, y: 0 },
  fanGeometry: null,
  pickedSeats: [],
  revealStarted: false,
  revealed: false,
};

const stage = $('stage');
const table = $('table');
const slots = $('slots');
const fanViewport = $('fan-viewport');
const fanLabelLayer = $('fan-label-layer');
const transitLayer = $('transit-layer');
let W = 0; let H = 0; let cx = 0; let cy = 0;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (t, a, b) => { const x = clamp((t - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };

// ══ 建牌 ══════════════════════════════════════════════════
for (let i = 0; i < TOTAL; i++) {
  const el = document.createElement('div');
  el.className = 'tcard';
  table.appendChild(el);
  S.els.push(el);
  S.cards.push({
    x: 0, y: 0, rot: 0, sc: 0.5, a: 1,
    vx: 0, vy: 0, vrot: 0, vsc: 0, va: 0,
    dead: false,
  });
}

function measure() {
  const r = stage.getBoundingClientRect();
  W = r.width; H = r.height; cx = W / 2; cy = H / 2;
}

function apply(i) {
  const b = S.cards[i];
  const el = S.els[i];
  if (b.dead) return;
  el.style.transform =
    `translate3d(${b.x.toFixed(2)}px, ${b.y.toFixed(2)}px, 0) rotate(${b.rot.toFixed(4)}rad) scale(${b.sc.toFixed(3)})`;
  el.style.opacity = clamp(b.a, 0, 1).toFixed(3);
}

// ══ 临界阻尼弹簧（dt 归一化）══════════════════════════════
function spring(b, target, omega, dt, keys) {
  const f = 1 + 2 * dt * ZETA * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const det = 1 / (f + hhoo);
  for (const k of keys) {
    const vk = `v${k}`;
    const x = b[k]; const v = b[vk]; const t = target[k];
    b[k] = (f * x + dt * v + hhoo * t) * det;
    b[vk] = (v + hoo * (t - x)) * det;
  }
}

// ══ 阶段 1：长按 + 拖拽洗牌 ═══════════════════════════════
function makeScatter() {
  S.home = [];
  const padX = Math.min(80, W * 0.24);
  const padY = Math.min(80, H * 0.22);
  for (let i = 0; i < TOTAL; i++) {
    const r = Math.pow(Math.random(), 0.6);
    const th = Math.random() * Math.PI * 2;
    S.home.push({
      x: cx + Math.cos(th) * r * Math.max(0, W / 2 - padX),
      y: cy + Math.sin(th) * r * Math.max(0, H / 2 - padY),
      rot: (Math.random() - 0.5) * 1.8,
      sc: 0.92 + Math.random() * 0.14,
    });
  }
}

/**
 * 关键改动：把「径向推开」换成「跟着手指走」。
 * 上一版给牌的是一个和距离成正比的小推力，推完就弹回去 —— 手感像轻轻碰了一下。
 * 现在是指针范围内的牌，速度向「手指速度」靠拢，
 * 就像手掌推着这堆牌走，牌真的会被带走。
 */
function physicsScatter(dt) {
  const p = S.pointer;
  const R = 110;

  for (let i = 0; i < TOTAL; i++) {
    const b = S.cards[i];
    const h = S.home[i];

    if (p) {
      const dx = b.x - p.x;
      const dy = b.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d < R) {
        const infl = 1 - d / R;                     // 越近影响越大
        const k = infl * 16 * dt;                   // 速度向手指速度收敛
        b.vx += (p.vx * 1.05 - b.vx) * k;
        b.vy += (p.vy * 1.05 - b.vy) * k;
        // 顺带把它们挤开一点，免得叠在一起
        if (d > 0.5) {
          b.vx += (dx / d) * infl * 90 * dt;
          b.vy += (dy / d) * infl * 90 * dt;
        }
      }
    }

    // 很弱的回中，只防止搅久了全飘到边上
    b.vx += (h.x - b.x) * 0.55 * dt;
    b.vy += (h.y - b.y) * 0.55 * dt;

    const fr = Math.exp(-1.9 * dt);
    b.vx *= fr; b.vy *= fr;

    b.x += b.vx * dt;
    b.y += b.vy * dt;
    // 移动方向的切向旋转，像牌在桌面上被蹭着转
    b.rot += (b.vx * 0.0009) * dt * 60;
    b.rot *= Math.exp(-0.35 * dt);

    // 软回推提前减速；最终安全区按整张卡面与阴影计算，不会再把牌裁掉。
    const mx = 27; const my = 46; const edge = 52;
    if (b.x < mx + edge) b.vx += ((mx + edge - b.x) / edge) ** 2 * 1800 * dt;
    if (b.x > W - mx - edge) b.vx -= ((b.x - (W - mx - edge)) / edge) ** 2 * 1800 * dt;
    if (b.y < my + edge) b.vy += ((my + edge - b.y) / edge) ** 2 * 1800 * dt;
    if (b.y > H - my - edge) b.vy -= ((b.y - (H - my - edge)) / edge) ** 2 * 1800 * dt;

    // 安全夹限按整张牌的外沿计算：触到桌边会停住，但不会让牌面被舞台裁掉。
    const safeX = Math.min(80, W / 2);
    const safeY = Math.min(80, H / 2);
    if (b.x < safeX) { b.x = safeX; if (b.vx < 0) b.vx = 0; }
    if (b.x > W - safeX) { b.x = W - safeX; if (b.vx > 0) b.vx = 0; }
    if (b.y < safeY) { b.y = safeY; if (b.vy < 0) b.vy = 0; }
    if (b.y > H - safeY) { b.y = H - safeY; if (b.vy > 0) b.vy = 0; }

    // 尺寸/透明度用弹簧收敛
    spring(b, { sc: h.sc, a: 1 }, W_SOFT, dt, ['sc', 'a']);
    apply(i);
  }
}

// ══ 阶段 2：分开两摞，再让下摞清楚地翻到上层 ═══════════════
const STACK_STEP = 0.72;

function cutLayer(i) {
  const { t, oldOrder, newOrder } = S.cutAnim;
  const oldIdx = oldOrder.indexOf(i);
  const newIdx = newOrder.indexOf(i);
  return oldIdx + (newIdx - oldIdx) * ease(t, 0.30, 0.77);
}

function cutTarget(i) {
  const { t, split, oldOrder } = S.cutAnim;
  const oldIdx = oldOrder.indexOf(i);
  const layer = cutLayer(i);
  const wasUpper = oldIdx >= TOTAL - split;
  const opening = ease(t, 0.04, 0.30);
  const closing = ease(t, 0.67, 0.98);
  const apart = opening * (1 - closing);
  const side = wasUpper ? -1 : 1;
  return {
    x: cx + side * W * 0.18 * apart + ((i % 3) - 1) * 1.4,
    y: cy - layer * STACK_STEP - 6 + (wasUpper ? -18 : 18) * apart,
    rot: ((i % 5) - 2) * 0.013,
    sc: 1, a: 1,
  };
}

function stackTarget(i) {
  const idx = S.order.indexOf(i);
  return {
    x: cx + ((i % 3) - 1) * 1.4,
    y: cy - idx * STACK_STEP - 6,
    rot: ((i % 5) - 2) * 0.013,
    sc: 1, a: 1,
  };
}

// ══ 阶段 3：固定窗口内的重叠牌扇，窗口只展示当前牌段 ═══════
function layoutFanViewport() {
  if (S.stage !== 3) return;
  const stageRect = stage.getBoundingClientRect();
  const slotsTop = slots.getBoundingClientRect().top - stageRect.top;
  const top = 12;
  const available = slotsTop - top - 12;
  const height = Math.max(0, Math.min(available, H * 0.70));
  fanViewport.style.top = `${top}px`;
  fanViewport.style.height = `${height}px`;
  fanLabelLayer.style.top = `${top}px`;
  fanLabelLayer.style.left = '12px';
  fanLabelLayer.style.right = '12px';
  fanLabelLayer.style.height = `${height}px`;
}

function configureFanStrip() {
  const viewportWidth = fanViewport.clientWidth;
  const viewportHeight = fanViewport.clientHeight;
  if (!viewportWidth || !viewportHeight) return;
  const cardWidth = clamp(60, W * 0.12, 96);
  const cardHeight = cardWidth * 5 / 3;
  const step = cardWidth * 0.36;
  const padding = 16;
  const trackWidth = padding * 2 + cardWidth + step * Math.max(0, TOTAL - S.picks.length - 1);
  const arcDepth = Math.min(viewportHeight * 0.24, cardWidth * 0.66);
  table.style.width = `${trackWidth}px`;
  table.style.height = `${viewportHeight}px`;
  S.fanGeometry = { viewportWidth, viewportHeight, cardWidth, cardHeight, step, padding, trackWidth, arcDepth };
  updateFanShape();
}

function updateFanShape() {
  const g = S.fanGeometry;
  if (!g || S.stage !== 3) return;
  const scrollLeft = fanViewport.scrollLeft;
  const focusWorldX = scrollLeft + g.viewportWidth / 2;
  const halfSpan = Math.max(2, (g.viewportWidth / 2 + g.cardWidth / 2) / g.step);
  const baseY = Math.max(0, (g.viewportHeight - g.cardHeight - g.arcDepth) / 2);
  const labels = fanLabelLayer.children;
  const remaining = Math.max(1, S.order.length - S.picks.length);
  const trackWidth = g.padding * 2 + g.cardWidth + g.step * (remaining - 1);
  table.style.width = `${trackWidth}px`;
  let visiblePosition = 0;

  for (let position = 0; position < S.order.length; position++) {
    const id = S.order[position];
    const el = S.els[id];
    const label = labels[position];
    if (S.picks.includes(id)) {
      el.style.display = 'none';
      if (label) label.style.display = 'none';
      continue;
    }
    el.style.display = 'block';
    el.classList.toggle('is-pending', S.pendingPick === id);
    const x = g.padding + visiblePosition * g.step;
    const centerX = x + g.cardWidth / 2;
    const t = clamp((centerX - focusWorldX) / (halfSpan * g.step), -1.25, 1.25);
    const y = baseY + g.arcDepth * t * t;
    const rotation = t * 0.46;
    el.style.width = `${g.cardWidth}px`;
    el.style.height = `${g.cardHeight}px`;
    el.style.left = '0px';
    el.style.top = '0px';
    el.style.zIndex = String(100 + visiblePosition);
    el.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${rotation}rad)`;

    if (label) {
      label.style.left = `${x - scrollLeft + 1 + g.cardWidth / 2}px`;
      label.style.top = `${y + 5}px`;
      label.style.zIndex = String(100 + visiblePosition);
      label.style.display = 'grid';
    }
    visiblePosition++;
  }
}

function targetFor(i) {
  if (S.stage === 2) return S.cutAnim ? cutTarget(i) : stackTarget(i);
  return { x: cx, y: cy, rot: 0, sc: 0.55, a: 1 };
}

// ══ 主循环 ════════════════════════════════════════════════
let lastT = performance.now();

function frame(now) {
  const dt = clamp((now - lastT) / 1000, 0.001, 0.033);
  lastT = now;

  if (S.stage === 1) {
    if (S.pointer) {
      const slow = Math.exp(-12 * dt);
      S.pointer.vx *= slow;
      S.pointer.vy *= slow;
    }
    physicsScatter(dt);
    if (S.pointer) updateUI();
  } else if (S.stage === 3) {
    if (!S.gridDrag) {
      const friction = Math.exp(-7.2 * dt);
      const maxLeft = Math.max(0, fanViewport.scrollWidth - fanViewport.clientWidth);
      fanViewport.scrollLeft = clamp(fanViewport.scrollLeft + S.gridMomentum.x * dt, 0, maxLeft);
      S.gridMomentum.x *= friction;
      if (Math.abs(S.gridMomentum.x) < 6) S.gridMomentum.x = 0;
      S.gridMomentum.y = 0;
    }
    updateFanShape();
  } else {
    for (let i = 0; i < TOTAL; i++) {
      const b = S.cards[i];
      if (b.dead) continue;
      const grabbed = S.drag && S.drag.i === i;
      const t = grabbed
        ? { x: S.drag.x, y: S.drag.y, rot: 0, sc: 1.16, a: 1 }
        : targetFor(i);
      spring(b, t, grabbed ? W_FIRM : W_SOFT, dt, ['x', 'y', 'rot', 'sc', 'a']);
      if (S.stage === 2) {
        const layer = S.cutAnim ? cutLayer(i) : S.order.indexOf(i);
        S.els[i].style.zIndex = String(100 + Math.round(layer));
      }
      apply(i);
    }
    if (S.cutAnim) {
      S.cutAnim.t += dt * 1.45;
      if (S.cutAnim.t >= 1) {
        S.order = S.cutAnim.newOrder;
        S.cutAnim = null;
        delete stage.dataset.cutBand;
        updateUI();
      }
    }
  }

  requestAnimationFrame(frame);
}

// ══ 手势 ══════════════════════════════════════════════════
function lp(e) {
  const r = stage.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function appendShuffleSample(p, speed = 0) {
  if (!S.shuffleStroke) return;
  const point = [
    Math.round(clamp(p.x / Math.max(W, 1), 0, 1) * 63),
    Math.round(clamp(p.y / Math.max(H, 1), 0, 1) * 63),
    Math.round(clamp(speed / 360, 0, 7)),
  ];
  const stroke = S.shuffleStroke;
  const last = stroke[stroke.length - 1];
  if (last && Math.abs(point[0] - last[0]) + Math.abs(point[1] - last[1]) < 2
      && Math.abs(point[2] - last[2]) < 2) return;
  if (stroke.length >= 96) {
    const compact = [stroke[0], ...stroke.slice(1, -1).filter((_, i) => i % 2 === 0), stroke[stroke.length - 1]];
    stroke.splice(0, stroke.length, ...compact);
  }
  stroke.push(point);
}

function onDown(e) {
  const p = lp(e);

  if (S.stage === 1) {
    try { stage.setPointerCapture?.(e.pointerId); } catch { /* 窗口兜底 */ }
    const startedAt = performance.now();
    S.pointer = { x: p.x, y: p.y, px: p.x, py: p.y, vx: 0, vy: 0, t: startedAt, startedAt };
    S.shuffleStroke = [];
    appendShuffleSample(p);
    stage.style.cursor = 'grabbing';
    return;
  }
  if (S.stage === 2) {
    try { stage.setPointerCapture?.(e.pointerId); } catch { /* 窗口兜底 */ }
    doCut(p);
    return;
  }
  if (S.stage === 3) {
    if (!fanViewport.contains(e.target)) return;
    const card = e.target.closest?.('.tcard.fan-card:not(.clone)');
    S.gridDrag = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      startX: p.x, startY: p.y,
      lastX: p.x, lastY: p.y,
      lastT: performance.now(),
      startScrollLeft: fanViewport.scrollLeft,
      moved: 0, axis: null,
      cardId: card ? Number(card.dataset.cardId) : -1,
    };
    fanViewport.classList.add('is-dragging');
    S.gridMomentum = { x: 0, y: 0 };
    if (e.pointerType !== 'touch') {
      try { fanViewport.setPointerCapture?.(e.pointerId); } catch { /* 窗口兜底 */ }
    }
    return;
  }
}

function onMove(e) {
  const p = lp(e);

  if (S.stage === 1 && S.pointer) {
    const now = performance.now();
    const dt = Math.max(8, now - S.pointer.t);
    S.pointer.vx = clamp((p.x - S.pointer.px) / dt * 1000, -2200, 2200); // px/s
    S.pointer.vy = clamp((p.y - S.pointer.py) / dt * 1000, -2200, 2200);
    // 搅动量 = 手指实际走过的路程
    S.stir += Math.hypot(p.x - S.pointer.px, p.y - S.pointer.py);
    appendShuffleSample(p, Math.hypot(S.pointer.vx, S.pointer.vy));
    S.pointer.px = p.x; S.pointer.py = p.y; S.pointer.t = now;
    S.pointer.x = p.x; S.pointer.y = p.y;
    return;
  }

  if (S.stage === 3) {
    if (S.gridDrag) {
      const drag = S.gridDrag;
      const now = performance.now();
      const totalX = p.x - drag.startX;
      const totalY = p.y - drag.startY;
      drag.moved = Math.max(drag.moved, Math.hypot(totalX, totalY));
      const elapsed = Math.max(8, now - drag.lastT);
      if (drag.pointerType !== 'touch' && drag.moved >= 6) {
        if (!drag.axis) drag.axis = Math.abs(totalX) > Math.abs(totalY) ? 'x' : 'y';
        if (drag.axis === 'x') {
          fanViewport.scrollLeft = clamp(drag.startScrollLeft - totalX, 0,
            Math.max(0, fanViewport.scrollWidth - fanViewport.clientWidth));
          S.gridMomentum.x = clamp(-(p.x - drag.lastX) / elapsed * 1000, -1600, 1600);
          S.gridMomentum.y = 0;
        }
        if (e.cancelable) e.preventDefault();
      }
      drag.lastX = p.x; drag.lastY = p.y; drag.lastT = now;
      updateFanShape();
      return;
    }
    return;
  }

  if (S.drag) {
    S.drag.x = p.x; S.drag.y = p.y;
  }
}

function onUp(e, cancelled = false) {
  if (S.stage === 1 && S.pointer) {
    S.shuffleDurationMs += Math.max(0, performance.now() - S.pointer.startedAt);
    if (S.shuffleStroke?.length) {
      S.shuffleTrace.push(S.shuffleStroke.map((point) => [...point]));
      if (S.shuffleTrace.length > 24) S.shuffleTrace.shift();
    }
    S.shuffleStroke = null;
    S.pointer = null;
    stage.style.cursor = 'grab';
    updateUI();
    return;
  }

  if (S.stage === 3 && S.gridDrag) {
    const drag = S.gridDrag;
    S.gridDrag = null;
    fanViewport.classList.remove('is-dragging');
    if (drag.pointerType !== 'touch') {
      try { fanViewport.releasePointerCapture?.(drag.pointerId); } catch { /* 已释放 */ }
    }
    if (!cancelled && drag.moved < 8 && drag.cardId >= 0) {
      setPendingPick(drag.cardId);
    } else if (cancelled || drag.pointerType === 'touch') {
      S.gridMomentum = { x: 0, y: 0 };
    }
    return;
  }
}

stage.addEventListener('pointerdown', onDown);
window.addEventListener('pointermove', onMove);
window.addEventListener('pointerup', onUp);
window.addEventListener('pointercancel', (e) => onUp(e, true));
stage.addEventListener('contextmenu', (e) => e.preventDefault());
fanViewport.addEventListener('scroll', updateFanShape, { passive: true });
fanViewport.addEventListener('wheel', (e) => {
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (!delta) return;
  fanViewport.scrollLeft = clamp(fanViewport.scrollLeft + delta,
    0, Math.max(0, fanViewport.scrollWidth - fanViewport.clientWidth));
  S.gridMomentum = { x: 0, y: 0 };
  updateFanShape();
  if (e.cancelable) e.preventDefault();
}, { passive: false });
fanViewport.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  fanViewport.scrollLeft = clamp(fanViewport.scrollLeft + (e.key === 'ArrowRight' ? 150 : -150),
    0, Math.max(0, fanViewport.scrollWidth - fanViewport.clientWidth));
  updateFanShape();
  e.preventDefault();
});

// ══ 起牌：克隆牌背飞进编号牌位，所有牌在选齐后统一翻面 ═══════
function slotPos(k) {
  const slot = slots.querySelector(`[data-slot-index="${k}"] .draw-slot-card`);
  if (slot) {
    const r = slot.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    return { x: r.left - sr.left + r.width / 2, y: r.top - sr.top + r.height / 2 };
  }
  const n = S.spread.n;
  const gap = Math.min(74, (W - 48) / Math.max(1, n));
  const totalW = gap * (n - 1);
  return { x: cx - totalW / 2 + k * gap, y: H - 82 };
}

function renderSlots() {
  slots.dataset.count = String(S.spread.n);
  slots.style.setProperty('--slot-columns', String(Math.min(S.spread.n, 5)));
  slots.innerHTML = S.spread.dims.map((label, i) => `
    <div class="draw-slot" data-slot-index="${i}">
      <div class="draw-slot-card"><span class="slot-number">${i + 1}</span></div>
      <div class="draw-slot-label">${label}</div>
    </div>`).join('');
}

function renderFan() {
  layoutFanViewport();
  const alreadyRendered = table.classList.contains('card-fan-strip');
  table.classList.remove('card-grid', 'card-ring', 'card-grid-scroll');
  table.classList.add('card-fan', 'card-fan-strip');
  fanViewport.appendChild(table);
  if (!alreadyRendered) {
    fanViewport.scrollLeft = 0;
    fanLabelLayer.replaceChildren();
    S.order.forEach((id, position) => {
      const el = S.els[id];
      el.classList.remove('wheel', 'picked');
      el.classList.add('fan-card');
      el.style.removeProperty('transform');
      el.style.removeProperty('opacity');
      el.style.removeProperty('z-index');
      el.style.removeProperty('width');
      el.style.removeProperty('height');
      el.style.removeProperty('left');
      el.style.removeProperty('top');
      el.style.removeProperty('margin-left');
      el.style.removeProperty('margin-top');
      el.style.removeProperty('display');
      el.innerHTML = '';
      el.dataset.cardId = String(id);
      el.dataset.position = String(position + 1).padStart(2, '0');
      el.setAttribute('aria-label', `第 ${position + 1} 张牌背，可在框内浏览后轻触选择`);
      table.appendChild(el);

      const label = document.createElement('span');
      label.className = 'fan-index';
      label.dataset.cardId = String(id);
      label.textContent = String(position + 1).padStart(2, '0');
      fanLabelLayer.appendChild(label);
    });
  }
  configureFanStrip();
}

function clearFan() {
  table.classList.remove('card-grid', 'card-ring', 'card-fan', 'card-grid-scroll', 'card-fan-strip');
  if (table.parentElement !== stage) stage.insertBefore(table, fanViewport.nextSibling);
  fanViewport.scrollTop = 0;
  fanViewport.scrollLeft = 0;
  table.style.removeProperty('width');
  table.style.removeProperty('height');
  fanLabelLayer.replaceChildren();
  transitLayer.replaceChildren();
  S.gridDrag = null;
  S.gridMomentum = { x: 0, y: 0 };
  fanViewport.classList.remove('is-dragging');
  fanViewport.classList.remove('is-reflowing');
  S.pendingPick = null;
  S.fanGeometry = null;
  for (const el of S.els) {
    el.classList.remove('fan-card', 'wheel', 'picked', 'is-pending');
    el.style.removeProperty('order');
    el.style.removeProperty('transform');
    el.style.removeProperty('opacity');
    el.style.removeProperty('z-index');
    el.style.removeProperty('width');
    el.style.removeProperty('height');
    el.style.removeProperty('margin-left');
    el.style.removeProperty('margin-top');
    el.style.removeProperty('border-radius');
    el.style.removeProperty('--wheel-number-size');
    el.style.removeProperty('--fan-number-size');
    el.style.removeProperty('--wheel-counter-rotation');
    el.style.removeProperty('display');
    el.innerHTML = '';
    delete el.dataset.cardId;
    delete el.dataset.position;
    el.removeAttribute('aria-label');
  }
}

function markSlot(k) {
  const slot = slots.querySelector(`[data-slot-index="${k}"]`);
  if (!slot) return;
  slot.classList.add('filled');
}

async function revealPickedCards() {
  if (S.revealStarted || S.picks.length < S.spread.n
      || S.pickedSeats.filter(Boolean).length < S.spread.n) return;
  S.revealStarted = true;

  let officialDraw = null;
  if (clawbot) {
    clawbot.clearNotice?.();
    clawbot.showNotice?.('牌已选齐，正在把牌序交给 ClawBot…');
    let response;
    try {
      response = await clawbot.draw(S.pickIndexes);
    } catch (error) {
      S.revealStarted = false;
      S.drawError = true;
      clawbot.showNotice?.(error.message ?? '连接 ClawBot 失败，请重试。', 'red');
      updateUI();
      return;
    }
    if (!response.ok) {
      S.revealStarted = false;
      S.drawError = true;
      clawbot.showNotice?.(response.data?.error ?? '提交抽牌结果失败，请重试。', 'red');
      updateUI();
      return;
    }
    officialDraw = response.data;
    if (!Array.isArray(officialDraw.cards) || officialDraw.cards.length !== S.spread.n) {
      S.revealStarted = false;
      S.drawError = true;
      clawbot.showNotice?.('ClawBot 返回的牌阵数量不正确，请重试。', 'red');
      updateUI();
      return;
    }
  }
  const catalog = officialDraw ? [] : await cardCatalogPromise;
  const imageLoads = [];
  S.pickedSeats.forEach((seat, k) => {
    const card = officialDraw
      ? (officialDraw.cards.find((item) => item.positionIndex === k) ?? officialDraw.cards[k])
      : catalog[S.picks[k]];
    const img = seat.querySelector('.ritual-picked-front img');
    const name = seat.querySelector('.ritual-picked-name');
    const reversed = officialDraw
      ? Boolean(card?.reversed)
      : Boolean(S.deckBuilt?.reversals?.[S.picks[k]]);
    seat.classList.toggle('is-reversed', reversed);
    if (!card) {
      name.textContent = `第 ${k + 1} 张`;
      seat.classList.add('image-missing');
      return;
    }
    name.textContent = card.name ?? '';
    img.alt = card.name ?? `第 ${k + 1} 张塔罗牌`;
    if (card.img) {
      img.src = new URL(`../deck/${encodeURIComponent(card.img)}`, import.meta.url).href;
      img.onerror = () => seat.classList.add('image-missing');
      imageLoads.push(img.decode().catch(() => seat.classList.add('image-missing')));
    } else {
      seat.classList.add('image-missing');
    }
  });
  await Promise.all(imageLoads);

  requestAnimationFrame(() => {
    if (S.stage !== 3 || S.picks.length < S.spread.n) return;
    S.pickedSeats.forEach((seat) => seat.classList.add('is-revealed'));
    S.revealed = true;
    $('spread-desc').textContent = '牌阵已完整揭晓';
    clawbot?.clearNotice?.();
    updateUI();
    if (officialDraw && clawbot?.afterReveal) {
      Promise.resolve(clawbot.afterReveal(officialDraw)).catch((error) => {
        clawbot.showNotice?.(error.message ?? '解读生成失败，请重试。', 'red');
      });
    }
  });
}

function setPendingPick(i) {
  if (S.stage !== 3 || S.picks.includes(i) || S.picks.length >= S.spread.n) return;
  if (S.pendingPick !== null) S.els[S.pendingPick]?.classList.remove('is-pending');
  S.pendingPick = i;
  S.els[i]?.classList.add('is-pending');
  updateUI();
}

function cancelPendingPick() {
  if (S.pendingPick === null) return;
  S.els[S.pendingPick]?.classList.remove('is-pending');
  S.pendingPick = null;
  updateUI();
}

function pickCard(i) {
  if (S.pendingPick !== i) return;
  if (S.picks.length >= S.spread.n) return;
  if (S.picks.includes(i)) return;
  const k = S.picks.length;
  const sourceEl = S.els[i];
  const sourceRect = sourceEl.getBoundingClientRect();
  const sourceW = sourceEl.offsetWidth || sourceRect.width || 54;
  const sourceH = sourceEl.offsetHeight || sourceRect.height || 92;
  const slot = slots.querySelector(`[data-slot-index="${k}"] .draw-slot-card`);
  if (!slot) return;
  const pickIndex = Number(sourceEl.dataset.position);
  if (!Number.isInteger(pickIndex) || pickIndex < 1 || pickIndex > TOTAL) return;
  S.pendingPick = null;
  sourceEl.classList.remove('is-pending');
  const sr = stage.getBoundingClientRect();
  const slotRect = slot.getBoundingClientRect();
  const from = {
    x: sourceRect.left - sr.left + sourceRect.width / 2,
    y: sourceRect.top - sr.top + sourceRect.height / 2,
  };
  const to = {
    x: slotRect.left - sr.left + slotRect.width / 2,
    y: slotRect.top - sr.top + slotRect.height / 2,
  };
  const targetScale = Math.min(slotRect.width / sourceW, slotRect.height / sourceH);
  S.picks.push(i);
  S.pickIndexes.push(pickIndex);
  fanViewport.classList.add('is-reflowing');
  setTimeout(() => fanViewport.classList.remove('is-reflowing'), 320);
  // 原牌从扇面撤走并补齐空位；飞行克隆保持牌背朝上。
  S.els[i].classList.add('picked');
  sourceEl.style.opacity = '0';

  const source = S.cards[i];
  source.x = from.x; source.y = from.y; source.rot = 0; source.a = 0;
  const clone = document.createElement('div');
  clone.className = 'tcard fan-card clone';
  clone.dataset.position = String(k + 1).padStart(2, '0');
  clone.style.width = `${sourceW}px`;
  clone.style.height = `${sourceH}px`;
  clone.style.marginLeft = `${-sourceW / 2}px`;
  clone.style.marginTop = `${-sourceH / 2}px`;
  clone.style.setProperty('--fan-number-size', '9px');
  clone.style.transform = `translate3d(${from.x}px, ${from.y}px, 0) rotate(0rad)`;
  clone.style.opacity = '1';
  clone.style.zIndex = '300';
  transitLayer.appendChild(clone);

  requestAnimationFrame(() => {
    clone.style.transition = 'transform .66s cubic-bezier(.17,.67,.25,1)';
    clone.style.transform =
      `translate3d(${to.x}px, ${to.y}px, 0) rotate(0rad) scale(${targetScale})`;
  });

  setTimeout(() => {
    clone.remove();
    const seat = document.createElement('div');
    seat.className = 'ritual-picked clone';
    seat.dataset.cardId = String(i);
    seat.dataset.pickIndex = String(k + 1);
    seat.style.width = `${sourceW * targetScale}px`;
    seat.style.height = `${sourceH * targetScale}px`;
    seat.style.marginLeft = `${-sourceW * targetScale / 2}px`;
    seat.style.marginTop = `${-sourceH * targetScale / 2}px`;
    seat.style.transform = `translate3d(${to.x}px, ${to.y}px, 0)`;
    seat.style.zIndex = String(250 + k);
    seat.innerHTML = `<div class="ritual-picked-inner">
      <div class="ritual-picked-back"></div>
      <div class="ritual-picked-front"><img alt=""><span class="ritual-picked-name"></span></div>
    </div><span class="ritual-picked-index">${k + 1}</span>`;
    transitLayer.appendChild(seat);
    S.pickedSeats[k] = seat;
    markSlot(k);
    revealPickedCards();
  }, 660);

  navigator.vibrate?.(12);
  if (S.picks.length >= S.spread.n) onAllPicked();
  else updateUI();
}

// ══ 切牌 ══════════════════════════════════════════════════
function doCut(p) {
  if (S.cutAnim) return;
  const stackTop = cy - (TOTAL - 1) * STACK_STEP - 52;
  const stackHeight = (TOTAL - 1) * STACK_STEP + 98;
  if (Math.abs(p.x - cx) > 80 || p.y < stackTop - 12 || p.y > stackTop + stackHeight + 12) return;
  const band = clamp(Math.floor((p.y - stackTop) / (stackHeight / CUT_MOVES.length)), 0, CUT_MOVES.length - 1);
  stage.dataset.cutBand = String(band);
  const moveCount = CUT_MOVES[band];
  const split = TOTAL - moveCount;
  const oldOrder = [...S.order];
  const upper = oldOrder.slice(moveCount);
  const lower = oldOrder.slice(0, moveCount);
  S.cutAt.push(moveCount);
  S.cuts++;
  if (S.deckBuilt) {
    S.deckBuilt.gesture.cuts = S.cuts;
    S.deckBuilt.gesture.cutAt = [...S.cutAt];
  }
  // 五档厚度按 12/24/39/54/66 张取下摞；动画和最终数组做同一段旋转。
  S.cutAnim = { t: 0, split, oldOrder, newOrder: [...upper, ...lower] };
  updateUI();
}

// ══ 手势 → 牌序 ══════════════════════════════════════════
function hashSeed(str) {
  let h1 = 0x811c9dc5; let h2 = 0x1000193;
  for (let i = 0; i < str.length; i++) {
    h1 ^= str.charCodeAt(i); h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (Math.imul(h2 ^ str.charCodeAt(i), 2246822519) + i) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function buildDeck() {
  const gesture = {
    stir: Math.round(S.stir),
    strokes: S.shuffleTrace.map((stroke) => stroke.map((point) => [...point])),
  };
  const seed = hashSeed(JSON.stringify(gesture));
  let s = parseInt(seed.slice(0, 8), 16) || 0x6d2b79f5;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  let deck = [...Array(TOTAL).keys()];
  const strokes = gesture.strokes.filter((stroke) => stroke.length > 1);
  const passes = clamp(2 + Math.floor(gesture.stir / 500) + strokes.length, 3, 16);
  for (let pass = 0; pass < passes; pass++) {
    const stroke = strokes[pass % Math.max(1, strokes.length)];
    const point = stroke?.[Math.floor(rnd() * stroke.length)];
    const bias = point ? point[0] / 63 : rnd();
    const split = clamp(Math.round(8 + bias * (TOTAL - 16) + (rnd() - 0.5) * 8), 1, TOTAL - 1);
    const left = deck.slice(0, split);
    const right = deck.slice(split);
    const mixed = [];
    let takeLeft = rnd() < 0.5;
    while (left.length || right.length) {
      if (!left.length) takeLeft = false;
      else if (!right.length) takeLeft = true;
      const packet = takeLeft ? left : right;
      const count = 1 + Math.floor(rnd() * Math.min(4, packet.length));
      mixed.push(...packet.splice(0, count));
      if (left.length && right.length) takeLeft = rnd() < 0.5;
    }
    deck = mixed;
  }
  let reverseState = parseInt(hashSeed(`${seed}|orientation`).slice(0, 8), 16) || 0x9e3779b9;
  const reverseRnd = () => {
    reverseState ^= reverseState << 13; reverseState >>>= 0;
    reverseState ^= reverseState >> 17; reverseState >>>= 0;
    reverseState ^= reverseState << 5; reverseState >>>= 0;
    return reverseState / 4294967296;
  };
  const reversals = Array.from({ length: TOTAL }, () => reverseRnd() < 0.35);
  return { deck, seed, gesture: { ...gesture, cuts: 0, cutAt: [] }, reversals };
}

// ══ 阶段流转 ══════════════════════════════════════════════
function gotoStage(n) {
  S.stage = n;
  stage.dataset.stage = String(n);
  delete stage.dataset.cutBand;
  document.body.dataset.playStage = String(n);
  table.querySelectorAll('.clone').forEach((c) => c.remove());
  for (const el of S.els) {
    el.classList.remove('gone', 'lifted', 'picked', 'is-pending', 'fan-card', 'wheel');
  }
  if (n === 3) {
    renderSlots();
    renderFan();
    $('spread-desc').textContent = '轻触预选，确认落位或撤回重选；选齐后一起揭晓';
  } else {
    clearFan();
    slots.innerHTML = '';
  }
  updateUI();
}

function resetGesture() {
  S.stir = 0; S.cuts = 0; S.cutAt = []; S.picks = [];
  S.shuffleDurationMs = 0; S.shuffleSubmitting = false; S.pickIndexes = [];
  S.drawError = false;
  S.pendingPick = null;
  S.cutAnim = null; S.shuffleTrace = []; S.shuffleStroke = null;
  S.gridDrag = null; S.gridMomentum = { x: 0, y: 0 };
  S.fanGeometry = null;
  S.deckBuilt = null;
  S.pickedSeats = []; S.revealStarted = false; S.revealed = false;
  S.order = [...Array(TOTAL).keys()];
  S.cards.forEach((c, i) => {
    c.dead = false; c.a = 1; c.dead = false;
    S.els[i].classList.remove('gone', 'picked', 'is-pending');
  });
  slots.innerHTML = '';
}

function onAllPicked() {
  const built = S.deckBuilt;
  if (built) {
    built.finalDeck = [...S.order];
    built.gesture.cuts = S.cuts;
    built.gesture.cutAt = [...S.cutAt];
    built.drawn = S.picks.map((cardId, positionIndex) => ({
      positionIndex,
      cardId,
      pickIndex: S.pickIndexes[positionIndex] ?? (S.order.indexOf(cardId) + 1),
      reversed: Boolean(built.reversals[cardId]),
    }));
  }
  $('float-top').textContent = '';
  $('float-bottom').textContent = '';
  $('spread-desc').textContent = '全部选定，牌面将一起揭晓';
  updateUI();
  if (built) console.log('[仪式] 手势 → 牌序', { gesture: built.gesture, seed: built.seed });
}

function beginShuffle() {
  resetGesture();
  measure();
  makeScatter();
  gotoStage(1);
  $('spread-desc').textContent = '静下心，来回洗牌';
  S.cards.forEach((card, i) => {
    const home = S.home[i];
    card.x = home.x + (Math.random() - 0.5) * 18;
    card.y = home.y + (Math.random() - 0.5) * 18;
    card.rot = home.rot + (Math.random() - 0.5) * 0.16;
    card.sc = home.sc;
    card.vx = (Math.random() - 0.5) * 20;
    card.vy = (Math.random() - 0.5) * 20;
    card.vrot = 0;
  });
  $('float-top').textContent = '';
  $('float-bottom').textContent = '';
}

$('btn-main').addEventListener('click', async () => {
  if (S.stage === 0) {
    beginShuffle();
  } else if (S.stage === 1) {
    if (S.stir < 700) return;
    S.deckBuilt = buildDeck();
    S.deckBuilt.initialDeck = [...S.deckBuilt.deck];
    S.order = [...S.deckBuilt.deck];
    gotoStage(2);
    $('spread-desc').textContent = '点牌堆选厚度，让下摞翻到上面';
    $('float-top').textContent = '';
    $('float-bottom').textContent = '';
  } else if (S.stage === 2) {
    if (S.cuts < 1 || S.cutAnim || S.shuffleSubmitting) return;
    if (clawbot) {
      S.shuffleSubmitting = true;
      updateUI();
      let response;
      try {
        response = await clawbot.shuffle({
          rounds: Math.max(1, S.shuffleTrace.length),
          durationMs: Math.round(S.shuffleDurationMs),
          cutPile: S.cutAt.at(-1) ?? null,
          picks: [...S.cutAt],
        });
      } catch (error) {
        S.shuffleSubmitting = false;
        clawbot.showNotice?.(error.message ?? '连接 ClawBot 失败，请重试。', 'red');
        updateUI();
        return;
      }
      S.shuffleSubmitting = false;
      if (!response.ok) {
        clawbot.showNotice?.(response.data?.error ?? '保存洗牌结果失败，请重试。', 'red');
        updateUI();
        return;
      }
      clawbot.clearNotice?.();
    }
    S.deckBuilt.finalDeck = [...S.order];
    S.deckBuilt.gesture.cuts = S.cuts;
    S.deckBuilt.gesture.cutAt = [...S.cutAt];
    measure();
    gotoStage(3);
    $('float-top').textContent = '';
    $('float-bottom').textContent = '';
  } else if (S.stage === 3) {
    if (S.pendingPick !== null) pickCard(S.pendingPick);
    else if (S.drawError && S.picks.length >= S.spread.n) {
      S.drawError = false;
      S.revealStarted = false;
      revealPickedCards();
    } else if (S.revealed && !clawbot) location.reload();
  } else {
    return;
  }
});

function updateUI() {
  const btn = $('btn-main');
  const cancelBtn = $('btn-cancel-pick');
  cancelBtn.hidden = true;
  cancelBtn.disabled = true;
  if (S.stage === 0) {
    btn.hidden = false;
    btn.disabled = false; btn.textContent = '开始洗牌';
    $('stat').textContent = '';
    return;
  }
  if (S.stage === 1) {
    btn.hidden = false;
    const enough = S.stir >= 700;
    $('stat').textContent = '';
    btn.disabled = !enough;
    btn.textContent = enough ? '洗好了，去切牌' : '来回拖动洗牌';
    return;
  }
  if (S.stage === 2) {
    btn.hidden = false;
    $('stat').textContent = '';
    btn.disabled = S.cuts < 1 || Boolean(S.cutAnim) || S.shuffleSubmitting;
    btn.textContent = S.shuffleSubmitting ? '正在连接 ClawBot…'
      : S.cutAnim ? '切牌中…' : S.cuts ? '切好了，去起牌' : '点一下切牌';
    return;
  }
  const done = S.revealed;
  const hasPending = S.pendingPick !== null;
  const pendingPosition = hasPending ? S.els[S.pendingPick]?.dataset.position : '';
  const canRetryDraw = S.drawError && S.picks.length >= S.spread.n;
  $('stat').textContent = '';
  btn.hidden = (!done && !hasPending && !canRetryDraw) || (done && Boolean(clawbot));
  btn.disabled = !done && !hasPending && !canRetryDraw;
  btn.textContent = done ? '重新开始'
    : hasPending ? `确认第 ${String(pendingPosition).padStart(2, '0')} 张`
      : canRetryDraw ? '重试提交给 ClawBot' : '';
  cancelBtn.hidden = !hasPending;
  cancelBtn.disabled = !hasPending;
}

$('btn-cancel-pick').addEventListener('click', cancelPendingPick);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.pendingPick !== null) {
    cancelPendingPick();
    e.preventDefault();
  }
});

// ══ 牌阵抽屉 ══════════════════════════════════════════════
function renderSpreads() {
  const list = $('spread-list');
  if (!list) return;
  list.innerHTML = SPREADS.map((s) => `
    <button class="spread-opt ${s.id === S.spread.id ? 'on' : ''}" data-id="${s.id}">
      <span class="badge-n">${s.n}</span>
      <span class="txt">
        <span class="nm">${s.name}</span>
        <span class="ds">${s.dims.join(' · ')}</span>
      </span>
      ${s.tag ? `<span class="tag">${s.tag}</span>` : ''}
    </button>`).join('');

  for (const b of list.querySelectorAll('.spread-opt')) {
    b.addEventListener('click', () => {
      S.spread = SPREADS.find((s) => s.id === b.dataset.id);
      $('spread-kind').textContent = `当前牌阵：${S.spread.name}`;
      setQuestionHeading();
      $('spread-desc').textContent = '静下心，准备洗牌';
      closeSheet();
      resetGesture();
      gotoStage(0);
      $('float-top').textContent = '';
      $('float-bottom').textContent = '';
    });
  }
}

const openSheet = () => {
  if (!$('sheet') || !$('backdrop')) return;
  $('sheet').scrollTop = 0;
  $('sheet').classList.add('on');
  $('backdrop').classList.add('on');
};
const closeSheet = () => { $('sheet')?.classList.remove('on'); $('backdrop')?.classList.remove('on'); };
$('btn-spread')?.addEventListener('click', openSheet);
$('backdrop')?.addEventListener('click', closeSheet);

// ══ 调试钩子 ══════════════════════════════════════════════
window.__play = {
  debug: () => {
    const r = stage.getBoundingClientRect();
    const viewportRect = fanViewport.getBoundingClientRect();
    const live = [];
    if (S.stage === 3) {
      for (const i of S.order) {
        const el = S.els[i];
        const card = el.getBoundingClientRect();
        const opacity = Number(getComputedStyle(el).opacity);
        if (S.picks.includes(i) || opacity < 0.99 || card.bottom <= viewportRect.top
            || card.top >= viewportRect.bottom || card.right <= viewportRect.left
            || card.left >= viewportRect.right || card.top < viewportRect.top
            || card.bottom > viewportRect.bottom || card.left < viewportRect.left
            || card.right > viewportRect.right) continue;
        live.push({
          i, x: card.left + card.width / 2, y: card.top + card.height / 2,
          a: opacity, position: Number(S.els[i].dataset.position),
        });
      }
    } else {
      for (let i = 0; i < TOTAL; i++) {
        const b = S.cards[i];
        if (b.dead || S.picks.includes(i) || b.a < 0.35) continue;
        live.push({ i, x: r.left + b.x, y: r.top + b.y, a: Number(b.a.toFixed(2)) });
      }
    }
    if (S.stage === 3) live.sort((a, b) => a.position - b.position);
    const selectableCards = live.slice(0, 5).map((cardInfo) => {
      if (S.stage !== 3) return cardInfo;
      const el = S.els[cardInfo.i];
      const card = el.getBoundingClientRect();
      const frame = fanViewport.getBoundingClientRect();
      const left = Math.max(card.left + 2, frame.left + 2);
      const right = Math.min(card.right - 2, frame.right - 2);
      const top = Math.max(card.top + 2, frame.top + 2);
      const bottom = Math.min(card.bottom - 2, frame.bottom - 2);
      let point = null;
      for (let y = top; y < bottom && !point; y += 7) {
        for (let x = left; x < right; x += 5) {
          const hit = document.elementFromPoint(x, y);
          if (hit === el || el.contains(hit)) { point = { x, y }; break; }
        }
      }
      return { ...cardInfo, ...(point ?? {}) };
    });
    return {
      stage: S.stage, stir: Math.round(S.stir), cuts: S.cuts,
      fanVelocity: Number(Math.abs(S.gridMomentum.x).toFixed(2)), revealed: S.revealed,
      seatCount: S.pickedSeats.filter(Boolean).length, cutAt: [...S.cutAt], cutChoices: [...CUT_MOVES],
      visibleCards: live.length,
      fanCards: table.querySelectorAll('.tcard.fan-card:not(.clone)').length,
      picks: [...S.picks], pickIndexes: [...S.pickIndexes], pendingPick: S.pendingPick,
      spread: S.spread.id, spreadN: S.spread.n,
      seed: S.deckBuilt?.seed ?? null,
      fanBounds: S.stage === 3 ? { top: viewportRect.top, bottom: viewportRect.bottom,
        left: viewportRect.left, right: viewportRect.right } : null,
      fanLayout: S.stage === 3 && table.classList.contains('card-fan-strip') ? 'overlap-strip' : null,
      fanRows: S.stage === 3 ? 1 : 0,
      fanLabelCount: fanLabelLayer.querySelectorAll('.fan-index').length,
      fanScrollLeft: fanViewport.scrollLeft,
      fanScrollWidth: fanViewport.scrollWidth,
      fanClientWidth: fanViewport.clientWidth,
      fanScrollHeight: fanViewport.scrollHeight,
      fanClientHeight: fanViewport.clientHeight,
      fanTrackWidth: table.scrollWidth,
      fanCardWidth: S.fanGeometry?.cardWidth ?? 0,
      fanCardStep: S.fanGeometry?.step ?? 0,
      shuffleTracePoints: S.shuffleTrace.reduce((count, stroke) => count + stroke.length, 0),
      gestureCuts: S.deckBuilt?.gesture?.cuts ?? 0,
      reversalCount: S.deckBuilt?.reversals?.filter(Boolean).length ?? 0,
      reversalFlags: S.deckBuilt ? [...S.deckBuilt.reversals] : [],
      finalDeck: S.deckBuilt?.finalDeck ? [...S.deckBuilt.finalDeck] : null,
      stageRect: { x: r.left, y: r.top, w: r.width, h: r.height },
      order: [...S.order],
      slots: [...slots.querySelectorAll('.draw-slot')].map((el) => ({
        index: Number(el.dataset.slotIndex),
        filled: el.classList.contains('filled'),
      })),
      selectableCards,
    };
  },
};

// ══ 启动 ══════════════════════════════════════════════════
new ResizeObserver(() => {
  measure();
  if (S.stage <= 1) makeScatter();
  else if (S.stage === 3) renderFan();
}).observe(stage);
measure();
stage.dataset.stage = String(S.stage);
document.body.dataset.playStage = String(S.stage);
resetGesture();
if (clawbot?.session?.spread) {
  const remote = clawbot.session.spread;
  const positions = Array.isArray(remote.positions) ? remote.positions : [];
  S.spread = {
    id: remote.id,
    name: remote.name,
    n: Number(remote.count) || positions.length,
    dims: positions.map((position) => position.label),
    tag: '',
  };
  $('spread-kind').textContent = `当前牌阵：${S.spread.name}`;
  setQuestionHeading();
  $('btn-spread').hidden = true;
  beginShuffle();
} else {
  renderSpreads();
  updateUI();
}
requestAnimationFrame(frame);
