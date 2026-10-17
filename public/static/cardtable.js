/* ══════════════════════════════════════════════════════════
   Canvas 卡片物理台

   不是「加载动画」，是真的物理：
   - 78 张牌按弧形排开，手指左右拖 = 扫过整副牌
   - 从牌堆里把牌拖出来，牌跟手指走，带弹簧滞后
   - 甩出去有惯性，松手回弹
   - 拖出牌堆区域松手 = 抽中

   每张牌是独立刚体：位置/速度/角度都在积分，不是 CSS 补间。
   ══════════════════════════════════════════════════════════ */

const CARD_W = 78;
const CARD_H = 134;

// 弹簧参数：k 越大越"硬"，d 越小越晃
const SPRING = 0.22;
const DAMP = 0.76;

// 松手后判定为「抽中」的高度比例（相对 canvas）
const DRAW_ZONE = 0.42;

export function createCardTable({ canvas, total = 78, onDraw, onScroll }) {
  const ctx = canvas.getContext('2d');
  let W = 0;
  let H = 0;
  let dpr = 1;

  // 扇形几何
  const ARC_PER_CARD = 0.058;   // 每张牌之间的夹角
  const RADIUS = 400;
  let pivotY = 0;
  let pivotX = 0;

  let scroll = 0;               // 扇形滚动位置（以牌序号为单位）
  let scrollVel = 0;
  let dragging = null;          // { index, x, y, vx, vy, px, py, t }
  let taken = new Set();        // 已经抽走的序号
  let pointerDown = null;       // { x, y, id, moved }
  let raf = null;
  let destroyed = false;

  // 每张牌的物理状态，惰性创建
  const bodies = new Map();

  function body(i) {
    if (!bodies.has(i)) {
      const p = fanTarget(i);
      bodies.set(i, { x: p.x, y: p.y, rot: p.rot, scale: 1, vx: 0, vy: 0, vr: 0, vs: 0, alpha: 1, lift: 0 });
    }
    return bodies.get(i);
  }

  function fanTarget(i) {
    // 已经抽走的牌不占位置 —— 剩下的牌自动往中间靠拢。
    // 少了这一步，抽走中间的牌后扇形会留个洞，用户按老位置就抓空了。
    const a = (fanIndex(i) - scroll) * ARC_PER_CARD;
    return {
      x: pivotX + RADIUS * Math.sin(a),
      y: pivotY - RADIUS * Math.cos(a),
      rot: a,
      // 离中心越远越暗越小，做出纵深
      depth: Math.min(1, Math.abs(a) / 0.85),
    };
  }

  /** 把「牌的真实序号」映射成「在扇形里的第几个位置」（已抽走的不计） */
  function fanIndex(i) {
    let k = i;
    for (const t of taken) if (t < i) k--;
    return k;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    W = rect.width;
    H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    pivotX = W / 2;
    pivotY = H + RADIUS - CARD_H * 0.52;   // 牌堆底部露在画布下沿
  }

  // ══ 绘制 ══════════════════════════════════════════════════
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawBack(w, h, dim) {
    // 牌背：米白 + 金边 + 中央菱形
    const g = ctx.createLinearGradient(0, 0, w * 0.6, h);
    g.addColorStop(0, '#fffdf8');
    g.addColorStop(1, '#f2e9d6');
    ctx.fillStyle = g;
    roundRect(-w / 2, -h / 2, w, h, 8);
    ctx.fill();

    ctx.strokeStyle = `rgba(176,138,62,${0.5 - dim * 0.2})`;
    ctx.lineWidth = 1;
    ctx.stroke();

    // 内描边
    ctx.strokeStyle = `rgba(176,138,62,${0.22 - dim * 0.1})`;
    roundRect(-w / 2 + 5, -h / 2 + 5, w - 10, h - 10, 5);
    ctx.stroke();

    // 中央菱形
    const d = w * 0.22;
    ctx.save();
    ctx.rotate(Math.PI / 4);
    ctx.strokeStyle = `rgba(176,138,62,${0.55 - dim * 0.25})`;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(-d / 2, -d / 2, d, d);
    ctx.restore();
  }

  function drawCard(i, b, isDragging) {
    const p = fanTarget(i);
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.rot);
    ctx.scale(b.scale, b.scale);
    ctx.globalAlpha = b.alpha;

    const dim = p.depth * 0.35;
    const w = CARD_W;
    const h = CARD_H;

    // 阴影：拖拽时更重更远
    const sy = isDragging ? 22 : 6;
    const sb = isDragging ? 26 : 10;
    ctx.shadowColor = `rgba(59,51,80,${(isDragging ? 0.30 : 0.14) - dim * 0.06})`;
    ctx.shadowBlur = sb;
    ctx.shadowOffsetY = sy * 0.35;

    drawBack(w, h, dim);

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.restore();
  }

  /** 扇形可见范围：抽走的牌越多，需要往后多取几张来填满 */
  function halfRange() {
    return Math.ceil(Math.min(total, 30) / 2) + 2 + taken.size;
  }

  // 命中测试：从上层（序号大的、拖拽中的）往下找
  function hitTest(x, y) {
    const order = [];
    const half = halfRange();
    for (let i = Math.round(scroll) - half; i <= Math.round(scroll) + half; i++) {
      if (i < 0 || i >= total || taken.has(i)) continue;
      order.push(i);
    }
    // 越靠近中心越靠上（后画）
    order.sort((a, b) => Math.abs(a - scroll) - Math.abs(b - scroll));
    for (let k = order.length - 1; k >= 0; k--) {
      const i = order[k];
      const b = body(i);
      const dx = x - b.x;
      const dy = y - b.y;
      const c = Math.cos(-b.rot);
      const s = Math.sin(-b.rot);
      const lx = dx * c - dy * s;
      const ly = dx * s + dy * c;
      if (Math.abs(lx) <= CARD_W / 2 && Math.abs(ly) <= CARD_H / 2) return i;
    }
    return -1;
  }

  // ══ 主循环 ════════════════════════════════════════════════
  function step() {
    if (destroyed) return;

    // 扇形滚动惯性
    if (!pointerDown && !dragging) {
      scroll += scrollVel;
      scrollVel *= 0.88;
      if (Math.abs(scrollVel) < 0.001) scrollVel = 0;
      scroll = Math.max(0, Math.min(total - 1, scroll));
    }

    // 每张牌朝目标弹簧
    const half = halfRange();
    for (let i = Math.round(scroll) - half; i <= Math.round(scroll) + half; i++) {
      if (i < 0 || i >= total) continue;
      const b = body(i);

      // 已被抽走的牌：继续往上飞并淡出，不再受扇形弹簧约束
      if (taken.has(i)) {
        b.vy -= 0.55;
        b.x += b.vx;
        b.y += b.vy;
        b.rot += b.vr * 0.5;
        b.alpha *= 0.90;
        b.scale *= 0.986;
        continue;
      }

      const isDrag = dragging && dragging.index === i;
      const p = fanTarget(i);

      const tx = isDrag ? dragging.x : p.x;
      const ty = isDrag ? dragging.y : p.y;
      const tr = isDrag ? 0 : p.rot;
      const ts = isDrag ? 1.12 : 1;

      b.vx += (tx - b.x) * SPRING;
      b.vy += (ty - b.y) * SPRING;
      b.vr += (tr - b.rot) * SPRING * 0.9;
      b.vs += (ts - b.scale) * SPRING;

      b.vx *= DAMP; b.vy *= DAMP; b.vr *= DAMP; b.vs *= DAMP;
      b.x += b.vx; b.y += b.vy; b.rot += b.vr; b.scale += b.vs;
    }

    ctx.clearRect(0, 0, W, H);

    // 从远到近画
    const order = [];
    for (let i = Math.round(scroll) - half; i <= Math.round(scroll) + half; i++) {
      if (i < 0 || i >= total || taken.has(i)) continue;
      order.push(i);
    }
    order.sort((a, b) => Math.abs(b - scroll) - Math.abs(a - scroll));
    for (const i of order) drawCard(i, body(i), dragging?.index === i);

    raf = requestAnimationFrame(step);
  }

  // ══ 指针交互 ══════════════════════════════════════════════
  function localPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onDown(e) {
    const p = localPoint(e);
    pointerDown = { x: p.x, y: p.y, moved: false };
    // setPointerCapture 在某些环境会抛 NotFoundError（指针已不活跃），
    // 一旦抛出后面的 hitTest 就跑不到 —— 必须包起来
    try { canvas.setPointerCapture?.(e.pointerId); } catch { /* 交给 window 兜底 */ }

    const i = hitTest(p.x, p.y);
    if (i >= 0) {
      const b = body(i);
      dragging = { index: i, x: p.x, y: p.y, vx: 0, vy: 0, px: p.x, py: p.y, t: performance.now() };
      b.scale = 1.12;
      canvas.style.cursor = 'grabbing';
    }
  }

  function onMove(e) {
    const p = localPoint(e);

    if (dragging) {
      const now = performance.now();
      const dt = Math.max(8, now - dragging.t);
      dragging.vx = (p.x - dragging.px) / dt * 16;
      dragging.vy = (p.y - dragging.py) / dt * 16;
      dragging.px = p.x; dragging.py = p.y; dragging.t = now;
      dragging.x = p.x; dragging.y = p.y;
      pointerDown.moved = true;

      // 拖出画布上沿 —— 视觉反馈：稍微放大、回暖
      const out = p.y < H * DRAW_ZONE;
      dragging.out = out;
      canvas.style.cursor = out ? 'copy' : 'grabbing';
      return;
    }

    if (pointerDown) {
      const dx = p.x - pointerDown.x;
      if (Math.abs(dx) > 0.5) {
        scrollVel = -dx * 0.012;
        scroll = Math.max(0, Math.min(total - 1, scroll - dx * 0.012));
        pointerDown.x = p.x;
        pointerDown.moved = true;
        onScroll?.(scroll);
      }
    }
  }

  function onUp(e) {
    const p = e && typeof e.clientX === 'number' ? localPoint(e) : { x: 0, y: -999 };

    if (dragging) {
      const idx = dragging.index;
      const b = body(idx);
      const drawnOut = p.y < H * DRAW_ZONE;

      if (drawnOut) {
        // 抽中：牌往上飞走
        taken.add(idx);
        b.vy = -26;
        b.scale = 0.6;
        b.alpha = 0;
        onDraw?.(idx);
      } else {
        // 没抽，松手回弹（带甩出的惯性）
        b.vx = dragging.vx * 0.9;
        b.vy = dragging.vy * 0.9;
      }
      dragging = null;
      canvas.style.cursor = 'grab';
    }

    pointerDown = null;
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  // 兜底：拖到画布外面松手时，事件可能落在 window 上
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

  // ══ 洗牌动画：两半互相穿插 ═════════════════════════════════
  function playShuffle(durationMs = 900) {
    const start = performance.now();
    const frames = Math.ceil(durationMs / 90);
    let n = 0;

    const tick = () => {
      if (destroyed || n >= frames) {
        // 归位
        for (let i = 0; i < Math.min(total, 30); i++) {
          const b = body(i);
          b.vx += (0 - b.rot) * 0.3;
        }
        return;
      }
      const t = n / frames;
      const wave = Math.sin(t * Math.PI * 6) * (1 - t);
      for (let i = 0; i < Math.min(total, 30); i++) {
        const b = body(i);
        b.vx += (i % 2 ? 1 : -1) * wave * 5.5;
        b.vy += -Math.abs(wave) * 3.2;
      }
      n++;
      setTimeout(tick, 90);
    };
    tick();
  }

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  raf = requestAnimationFrame(step);
  canvas.style.cursor = 'grab';

  return {
    playShuffle,
    getScroll: () => scroll,
    // 调试用：让自动化测试能看到内部状态
    debug: () => ({
      scroll, scrollVel, W, H, pivotX, pivotY,
      dragging: dragging ? { index: dragging.index, x: dragging.x, y: dragging.y } : null,
      pointerDown,
      taken: [...taken],
      centerCard: fanTarget(Math.round(scroll)),
      hitAtCenter: hitTest(pivotX, fanTarget(Math.round(scroll)).y),
    }),
    reset() { taken.clear(); bodies.clear(); scroll = 0; scrollVel = 0; },
    destroy() { destroyed = true; cancelAnimationFrame(raf); ro.disconnect(); },
  };
}
