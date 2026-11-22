/**
 * effects.js —— 全屏氛围特效层（下雪 / 樱花 / 群星 / 音符）
 *
 * 移植自 `R:\mywallpaper\code\effects.js`（503 行；共用 canvas、36ms 帧差值门控、
 * kinds = snow / sakura / stars / notes），按桌宠形态改造：
 *  - 自建全屏 canvas（`#pet-effects-canvas`，position:fixed + inset:0 + pointer-events:none
 *    + z-index:9996，位于雨层 9997 之下），与 Live2D 舞台互不干扰，鼠标事件直接穿透；
 *  - 36ms **差值门控** requestAnimationFrame：仅在真正绘制时更新 lastFrameTime
 *    （60Hz 下前后帧差恒小于 36ms，用帧差判断会永远不画）；
 *  - DPR 上限 1.75；`prefers-reduced-motion: reduce` 不启动；
 *  - `visibilitychange` 隐藏时停绘、恢复可见时续绘；resize 重建粒子；
 *  - 只用 2D 基础图形（arc / quadraticCurveTo / fillText），禁用 shadowBlur / filter。
 *
 * 参考实现里的全部观感参数（粒子密度、风速与阵风包络、流星与星空重排排期、
 * 雪花/星星/音符/花瓣的生成与绘制）均按原值保留，仅把模块级变量收敛进 `state`。
 *
 * 本模块不依赖其它项目源码，可单独 `node --check` 与在 Node 中做 DOM 桩冒烟测试
 * （所有 DOM / window 访问都发生在函数体内）。
 */

/* ------------------------------------------------------------------ */
/* 常量                                                               */
/* ------------------------------------------------------------------ */

const DEFAULT_CANVAS_ID = 'pet-effects-canvas';
const DEFAULT_Z_INDEX = 9996;
/** 绘制节流间隔（ms）：与参考实现 / rain.js 一致 */
const FRAME_INTERVAL_MS = 36;
/** DPR 上限：高分屏收益递减，1.75 已足够且省掉大量填充带宽 */
const MAX_DPR = 1.75;
/** 默认主色（音符 / 涟漪） */
const DEFAULT_COLOR = '#a78bfa';

/** 支持的特效类型（'none' = 不渲染） */
const KINDS = ['none', 'snow', 'sakura', 'stars', 'notes'];

/** 樱花花瓣配色（参考实现原值） */
const PETAL_COLORS = ['#ffd6e3', '#ffc2d6', '#ffb0c8', '#ffe6ef', '#ff9fb8'];
/** 音符字形（参考实现原值） */
const NOTE_GLYPHS = ['♪', '♫', '♩', '♬'];

/** 群星每隔这么多帧重新排布一次位置（约 23~36 秒） */
const STAR_SHUFFLE_MIN = 650;
const STAR_SHUFFLE_MAX = 1000;
/** 单颗星的淡出 / 淡入速度（每帧） */
const STAR_FADE_OUT = 0.075;
const STAR_FADE_IN = 0.055;

/** 樱花：隔一阵子来一股风（约 9~22 秒一次），单阵持续 2.5~4.7 秒 */
const GUST_GAP_MIN = 260;
const GUST_GAP_MAX = 620;
const GUST_LIFE_MIN = 70;
const GUST_LIFE_MAX = 130;
/** 风推花瓣的每帧位移上限（峰值，px/帧） */
const WIND_PUSH = 1.7;

/* ------------------------------------------------------------------ */
/* 运行时状态                                                          */
/* ------------------------------------------------------------------ */

/**
 * @typedef {'none'|'snow'|'sakura'|'stars'|'notes'} EffectKind
 *
 * @typedef {Object} EffectsConfig
 * @property {boolean} enabled
 * @property {EffectKind} kind
 * @property {string} color 音符 / 涟漪主色
 */

const state = {
  /** @type {EffectsConfig} */
  config: { enabled: false, kind: 'none', color: DEFAULT_COLOR },
  /** @type {HTMLCanvasElement|null} */
  canvas: null,
  /** @type {CanvasRenderingContext2D|null} */
  ctx: null,
  running: false,
  destroyed: false,
  /** @type {number} */
  rafId: 0,
  /** 上次实际绘制的 rAF 时间戳（0 = 下一帧立即绘制） */
  lastFrameTime: 0,
  w: 1,
  h: 1,
  dpr: 1,
  /** 逻辑帧计数（仅在真正绘制的帧递增，驱动星空重排 / 流星 / 涟漪排期） */
  clock: 0,
  /** @type {Array<object>} 粒子集合（雪花 / 星星 / 音符 / 花瓣） */
  items: [],
  /** @type {Array<{x:number,y:number,age:number,life:number,max:number}>} 音符涟漪 */
  ripples: [],
  /** @type {{x:number,y:number,len:number,age:number,life:number}|null} 流星 */
  shooting: null,
  /** 下一次流星的时间（clock 计） */
  nextShoot: 0,
  /** 下一次星空重排的时间（clock 计） */
  nextShuffle: 0,
  /** @type {{str:number,age:number,life:number}|null} 当前阵风 */
  gust: null,
  /** 当前风力（带符号，px/帧 的乘子） */
  wind: 0,
  /** 下一次阵风的时间（clock 计） */
  nextGust: 0,
  reducedMotion: false,
  /** window / document 监听是否已挂（幂等） */
  listenersBound: false,
  /** @type {MediaQueryList|null} */
  motionQuery: null
};

/* ------------------------------------------------------------------ */
/* 小工具                                                             */
/* ------------------------------------------------------------------ */

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/** 按面积换算目标粒子数（下限 / 上限钳制，参数与参考实现一致） */
function countByArea(perPoint, min, max) {
  const n = Math.round((state.w * state.h) / perPoint);
  return clamp(n, min, max);
}

/**
 * 读取系统「减少动画」偏好；任何异常都退化为 false（保持功能可用）。
 * @returns {boolean}
 */
function readReducedMotion() {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    state.motionQuery = mq;
    return mq.matches === true;
  } catch (err) {
    return false;
  }
}

/**
 * 是否允许绘制：画布就绪 + 已启用 + 类型非 none + 未减少动画 + 页面可见。
 * @returns {boolean}
 */
function canRender() {
  if (!state.canvas || !state.ctx) return false;
  if (!state.config.enabled) return false;
  if (state.config.kind === 'none') return false;
  if (state.reducedMotion) return false;
  if (typeof document !== 'undefined' && document.hidden === true) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* 粒子生成（参数与参考实现完全一致）                                    */
/* ------------------------------------------------------------------ */

function makeSnow(initial) {
  const r = rand(0.8, 2.6);
  return {
    x: rand(0, state.w),
    y: initial ? rand(0, state.h) : rand(-40, -6),
    r: r,
    vy: rand(0.35, 1.35) * (r > 2 ? 0.8 : 1),
    vx: rand(-0.12, 0.12),
    ph: rand(0, 6.283),
    amp: rand(0.2, 0.85),
    a: rand(0.45, 0.95)
  };
}

function makeStar(initial) {
  const big = Math.random() < 0.16;
  return {
    x: rand(0, state.w),
    y: initial ? rand(0, state.h) : rand(-30, -4),
    r: big ? rand(1.5, 2.3) : rand(0.5, 1.3),
    ph: rand(0, 6.283),
    sp: rand(0.008, 0.032),
    a: rand(0.2, 0.85),
    vy: rand(0.01, 0.05),
    big: big,
    fade: initial ? 1 : 0,
    state: initial ? 'live' : 'in',
    hold: 0
  };
}

/** 换一个位置重新排这颗星（保留淡入，看不出来是瞬移） */
function respawnStar(p) {
  const big = Math.random() < 0.16;
  p.x = rand(0, state.w);
  p.y = rand(0, state.h);
  p.r = big ? rand(1.5, 2.3) : rand(0.5, 1.3);
  p.ph = rand(0, 6.283);
  p.sp = rand(0.006, 0.034);
  p.a = rand(0.2, 0.85);
  p.vy = rand(0.01, 0.05);
  p.big = big;
}

function makeNote(initial) {
  return {
    x: rand(state.w * 0.06, state.w * 0.94),
    y: initial ? rand(state.h * 0.06, state.h * 0.98) : state.h + rand(10, 90),
    vy: rand(-1.25, -0.55),
    vx: rand(-0.22, 0.22),
    ph: rand(0, 6.283),
    size: rand(14, 26),
    glyph: pick(NOTE_GLYPHS),
    a: rand(0.36, 0.8),
    fade: 0,
    life: initial ? Math.round(rand(60, 320)) : 0,
    span: rand(420, 880)
  };
}

function makePetal(initial) {
  return {
    x: rand(-20, state.w + 20),
    y: initial ? rand(0, state.h) : rand(-40, -8),
    r: rand(5, 9.6),
    vy: rand(0.5, 1.05),
    vx: rand(-0.15, 0.5),
    ph: rand(0, 6.283),
    amp: rand(0.4, 1.1),
    rot: rand(0, 6.283),
    spin: rand(0.006, 0.022) * (Math.random() < 0.5 ? -1 : 1),
    squash: rand(0.45, 0.8),
    color: pick(PETAL_COLORS),
    a: rand(0.45, 0.92),
    // 每片花瓣迎风的敏感度不同，一阵风里不会被吹得一样快
    windK: rand(0.55, 1.45)
  };
}

/**
 * 按类型生成一个粒子。
 * @param {EffectKind} kind
 * @param {boolean} initial 首次填充：随机铺满全屏；否则从视口外进入
 * @returns {object|null}
 */
function spawn(kind, initial) {
  if (kind === 'snow') return makeSnow(initial);
  if (kind === 'stars') return makeStar(initial);
  if (kind === 'notes') return makeNote(initial);
  if (kind === 'sakura') return makePetal(initial);
  return null;
}

/** 当前类型的目标粒子数（密度参数与参考实现一致） */
function targetCount() {
  const kind = state.config.kind;
  if (kind === 'snow') return countByArea(12000, 55, 150);
  if (kind === 'stars') return countByArea(13000, 55, 160);
  if (kind === 'notes') return countByArea(40000, 14, 28);
  if (kind === 'sakura') return countByArea(34000, 18, 38);
  return 0;
}

/**
 * 让粒子集合与目标数量一致（就地增删，不整场重置）。
 */
function ensureItems() {
  const n = targetCount();
  if (state.items.length > n) state.items.length = n;
  while (state.items.length < n) {
    const p = spawn(state.config.kind, true);
    if (!p) break;
    state.items.push(p);
  }
  if (state.config.kind !== 'notes') state.ripples.length = 0;
}

/**
 * 整场重置：类型切换 / 初始化时的统一入口。
 * 参考实现的 `setEffect` 在 kind 变化时执行同样的清理与重新排期。
 */
function resetScene() {
  state.items.length = 0;
  state.ripples.length = 0;
  state.shooting = null;
  state.nextShoot = state.clock + 200;
  state.nextShuffle = state.clock + Math.round(rand(STAR_SHUFFLE_MIN, STAR_SHUFFLE_MAX));
  state.gust = null;
  state.wind = 0;
  state.nextGust = state.clock + Math.round(rand(GUST_GAP_MIN, GUST_GAP_MAX));
}

/* ------------------------------------------------------------------ */
/* 绘制                                                                */
/* ------------------------------------------------------------------ */

function drawSnow(ctx, p) {
  // 亮背景（比如白天立绘）上纯白看不清，先垫一层很淡的暗色底
  ctx.fillStyle = 'rgba(30,48,80,1)';
  ctx.globalAlpha = p.a * 0.3;
  ctx.beginPath();
  ctx.arc(p.x, p.y + 0.5, p.r + 0.7, 0, 6.2832);
  ctx.fill();

  ctx.fillStyle = '#d7e9ff';
  ctx.globalAlpha = p.a;
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.r, 0, 6.2832);
  ctx.fill();
  if (p.r > 2) {
    ctx.globalAlpha = p.a * 0.16;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * 2.6, 0, 6.2832);
    ctx.fill();
  }
}

function drawStar(ctx, p) {
  const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(state.clock * p.sp * 3.2 + p.ph));
  const base = p.a * tw * p.fade;
  ctx.fillStyle = '#f4f7ff';
  ctx.strokeStyle = '#f4f7ff';
  ctx.globalAlpha = base;
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.r, 0, 6.2832);
  ctx.fill();
  if (p.big) {
    const arm = p.r * (3.4 + tw * 2.2);
    ctx.globalAlpha = base * 0.55;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(p.x - arm, p.y);
    ctx.lineTo(p.x + arm, p.y);
    ctx.moveTo(p.x, p.y - arm);
    ctx.lineTo(p.x, p.y + arm);
    ctx.stroke();
  }
}

function drawNote(ctx, p) {
  ctx.font = p.size + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 先画一层暗色描影，亮背景上也能看清
  ctx.fillStyle = 'rgba(12,16,30,1)';
  ctx.globalAlpha = p.a * p.fade * 0.22;
  ctx.fillText(p.glyph, p.x + 1, p.y + 1);
  ctx.fillStyle = state.config.color;
  ctx.globalAlpha = p.a * p.fade;
  ctx.fillText(p.glyph, p.x, p.y);
}

/** 单片花瓣的贝塞尔轮廓（以原点为花柄，向上舒展） */
function petalPath(ctx, r) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(-r, -r * 0.72, 0, -r * 2);
  ctx.quadraticCurveTo(r, -r * 0.72, 0, 0);
}

function drawPetal(ctx, p) {
  const r = p.r;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rot);
  ctx.scale(1, p.squash + (1 - p.squash) * Math.abs(Math.cos(p.rot * 1.7)));

  // 暗色底衬，浅色立绘上也能看出花瓣轮廓
  ctx.fillStyle = 'rgba(72,28,46,1)';
  ctx.globalAlpha = p.a * 0.22;
  ctx.save();
  ctx.translate(0.9, 0.9);
  petalPath(ctx, r);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = p.color;
  ctx.globalAlpha = p.a;
  petalPath(ctx, r);
  ctx.fill();
  ctx.restore();
}

/** 音符涟漪：由内向外扩散并淡出 */
function drawRipples(ctx) {
  if (!state.ripples.length) return;
  ctx.strokeStyle = state.config.color;
  for (let i = state.ripples.length - 1; i >= 0; i--) {
    const r = state.ripples[i];
    r.age += 1;
    const k = r.age / r.life;
    if (k >= 1) {
      state.ripples.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = (1 - k) * 0.5;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(r.x, r.y, 6 + k * r.max, 0, 6.2832);
    ctx.stroke();
  }
}

/** 群星里的流星：按排期生成，划过一段后消失 */
function drawShooting(ctx) {
  if (!state.shooting) {
    if (state.clock > state.nextShoot && state.config.kind === 'stars') {
      state.shooting = {
        x: rand(state.w * 0.1, state.w * 0.8),
        y: rand(0, state.h * 0.42),
        len: rand(70, 130),
        age: 0,
        life: rand(26, 40)
      };
      state.nextShoot = state.clock + rand(420, 900);
    }
    return;
  }
  state.shooting.age += 1;
  const k = state.shooting.age / state.shooting.life;
  if (k >= 1) {
    state.shooting = null;
    return;
  }
  const x = state.shooting.x + k * 120;
  const y = state.shooting.y + k * 62;
  const tail = state.shooting.len * (1 - k * 0.5);
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.5 * (1 - k) * (k < 0.2 ? k / 0.2 : 1);
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - tail * 0.62, y - tail * 0.36);
  ctx.stroke();
  ctx.globalAlpha = 0.75 * (1 - k);
  ctx.beginPath();
  ctx.arc(x, y, 1.6, 0, 6.2832);
  ctx.fill();
}

/** 音符涟漪的生成排期（每 26 帧一次机会，最多同时 6 圈） */
function rippleTick() {
  if (state.config.kind !== 'notes') return;
  if (state.clock % 26 === 0 && state.ripples.length < 6) {
    state.ripples.push({
      x: rand(state.w * 0.14, state.w * 0.86),
      y: rand(state.h * 0.18, state.h * 0.82),
      age: 0,
      life: rand(48, 76),
      max: rand(52, 108)
    });
  }
}

/**
 * 单粒子的运动学更新（1 帧步长）。
 * @param {object} p
 */
function step(p) {
  // 风只作用于樱花：横向推、摆动加快、略微托起 → 像被风带着走
  const kind = state.config.kind;
  const gustX = kind === 'sakura' ? state.wind * (p.windK || 1) : 0;

  p.x += (p.vx || 0) + gustX * WIND_PUSH + (p.amp ? Math.sin(p.ph) * 0.18 * p.amp : 0);
  p.ph += 0.012 + Math.abs(gustX) * 0.06;
  p.y += (p.vy || 0) - Math.abs(gustX) * 0.12;

  if (kind === 'stars') {
    if (p.state === 'out') {
      if (p.hold > 0) {
        p.hold -= 1;
      } else {
        p.fade -= STAR_FADE_OUT;
        if (p.fade <= 0) {
          p.fade = 0;
          respawnStar(p);
          p.state = 'in';
        }
      }
    } else if (p.state === 'in') {
      p.fade += STAR_FADE_IN;
      if (p.fade >= 1) {
        p.fade = 1;
        p.state = 'live';
      }
    }
  }

  if (kind === 'sakura') p.rot += p.spin * (1 + Math.abs(gustX) * 1.6);
  if (kind === 'notes') {
    p.life += 1;
    const k = p.life / p.span;
    p.fade = k < 0.15 ? k / 0.15 : (k > 0.75 ? Math.max(0, (1 - k) / 0.25) : 1);
  }
}

/** 樱花的风：长时间无风，偶尔来一阵，起风快、落风慢 */
function updateWind() {
  if (state.config.kind !== 'sakura') {
    state.wind = 0;
    state.gust = null;
    return;
  }
  if (!state.gust) {
    if (state.clock > state.nextGust) {
      const dir = Math.random() < 0.26 ? -1 : 1;
      state.gust = {
        str: rand(0.7, 1.5) * dir,
        age: 0,
        life: Math.round(rand(GUST_LIFE_MIN, GUST_LIFE_MAX))
      };
      state.nextGust = state.clock + Math.round(rand(GUST_GAP_MIN, GUST_GAP_MAX));
    } else {
      state.wind = 0;
      return;
    }
  }
  state.gust.age += 1;
  const k = state.gust.age / state.gust.life;
  // 前 18% 拉满，之后按 1.5 次幂衰减，尾巴长一点才像风停
  const env = k < 0.18 ? k / 0.18 : Math.pow(Math.max(0, 1 - (k - 0.18) / 0.82), 1.5);
  state.wind = state.gust.str * env;
  if (state.gust.age >= state.gust.life) {
    state.gust = null;
    state.wind = 0;
  }
}

/** 全星图错峰熄灭 → 换位 → 淡入，看起来像「换了一片星空」而不是硬切 */
function shuffleStars() {
  for (let i = 0; i < state.items.length; i++) {
    const p = state.items[i];
    if (p.state === 'live') {
      p.state = 'out';
      p.hold = Math.floor(Math.random() * 32);
    }
  }
  state.nextShuffle = state.clock + Math.round(rand(STAR_SHUFFLE_MIN, STAR_SHUFFLE_MAX));
}

/** 是否已离开可视范围（音符按生命周期判定） */
function outOfView(p) {
  if (state.config.kind === 'notes') return p.life > p.span || p.y < -40;
  return p.x < -60 || p.x > state.w + 60 || p.y < -60 || p.y > state.h + 60;
}

/** 单次绘制（已由 tick 完成 36ms 门控） */
function drawFrame() {
  const ctx = state.ctx;
  if (!ctx) return;

  const w = state.w;
  const h = state.h;
  const kind = state.config.kind;

  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = 1;

  if (kind === 'stars' && state.clock > state.nextShuffle) shuffleStars();
  updateWind();

  const items = state.items;
  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    step(p);
    if (outOfView(p)) {
      const fresh = spawn(kind, false);
      if (!fresh) continue;
      items[i] = fresh;
      continue;
    }
    if (kind === 'snow') drawSnow(ctx, p);
    else if (kind === 'stars') drawStar(ctx, p);
    else if (kind === 'notes') drawNote(ctx, p);
    else if (kind === 'sakura') drawPetal(ctx, p);
  }

  rippleTick();
  drawRipples(ctx);
  drawShooting(ctx);

  ctx.globalAlpha = 1;
}

/* ------------------------------------------------------------------ */
/* 渲染循环                                                            */
/* ------------------------------------------------------------------ */

/** @param {number} now rAF 时间戳（ms） */
function tick(now) {
  if (!state.running) return;
  const ts = typeof now === 'number' && now > 0 ? now : nowMs();

  // 36ms 门控：用「距上次绘制」的差值判断，未达间隔只续帧、不更新 lastFrameTime
  if (ts - state.lastFrameTime >= FRAME_INTERVAL_MS) {
    state.lastFrameTime = ts;
    state.clock += 1;
    drawFrame();
  }
  if (state.running) {
    state.rafId = requestAnimationFrame(tick);
  }
}

function startRender() {
  if (state.running) return;
  if (!canRender()) return;
  if (typeof requestAnimationFrame !== 'function') return;

  state.running = true;
  state.lastFrameTime = 0; // 首帧立即绘制
  if (state.canvas) state.canvas.style.opacity = '1';
  state.rafId = requestAnimationFrame(tick);
}

/**
 * 停止绘制并清屏（不销毁 canvas / 不丢弃监听，可再次 startRender 恢复）。
 */
function stopRender() {
  state.running = false;
  if (state.rafId && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(state.rafId);
  }
  state.rafId = 0;

  const ctx = state.ctx;
  const canvas = state.canvas;
  if (ctx && canvas) {
    // setTransform(dpr, …) 下清除物理像素范围，确保整屏透明
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  if (canvas) canvas.style.opacity = '0';

  state.shooting = null;
}

/**
 * 按目标态收敛（幂等）：
 *  - 允许渲染 → 保证粒子存在 + 渲染循环在跑；
 *  - 其它（关闭 / 类型 none / 减少动画 / 页面隐藏）→ 停绘 + 清屏 + 清空粒子。
 *
 * @param {boolean} [force] 为 true 时强制重建粒子（类型已变化）
 */
function syncScene(force) {
  state.reducedMotion = readReducedMotion();

  if (!canRender()) {
    stopRender();
    state.items.length = 0;
    state.ripples.length = 0;
    state.shooting = null;
    return;
  }
  if (force || !state.items.length) ensureItems();
  startRender();
}

/* ------------------------------------------------------------------ */
/* 对外：配置与渲染控制                                                  */
/* ------------------------------------------------------------------ */

/**
 * 初始化特效层（幂等）。未传 el 时自建全屏 canvas 并挂到 body。
 *
 * @param {HTMLCanvasElement} [el] 显式传入画布（供 mywallpaper 等宿主复用）
 * @returns {{ element: HTMLCanvasElement|null, destroyed: boolean }}
 */
export function initEffects(el) {
  if (typeof document === 'undefined' || !document.body) {
    // 非浏览器环境：返回空句柄，调用方可安全 no-op
    state.destroyed = true;
    return { element: null, destroyed: true };
  }

  if (!state.canvas) {
    let canvas = el && typeof el === 'object' ? el : null;

    if (canvas && typeof canvas.getContext !== 'function') {
      // 显式传入的对象不是可用画布 → 安全降级
      state.destroyed = true;
      return { element: null, destroyed: true };
    }

    if (!canvas) {
      canvas = document.getElementById(DEFAULT_CANVAS_ID);
      if (!canvas || typeof canvas.getContext !== 'function') {
        canvas = document.createElement('canvas');
        canvas.id = DEFAULT_CANVAS_ID;
      }
      // 自建 / 复用自己的画布才应用全屏样式（显式传入时尊重宿主布局）
      canvas.style.position = 'fixed';
      canvas.style.inset = '0';
      canvas.style.left = '0';
      canvas.style.top = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.pointerEvents = 'none';
      canvas.style.zIndex = String(DEFAULT_Z_INDEX);
      canvas.style.background = 'transparent';
      canvas.style.display = 'block';
      canvas.style.opacity = '0';
      canvas.setAttribute('aria-hidden', 'true');
    }

    if (!canvas.parentNode) document.body.appendChild(canvas);

    state.canvas = canvas;
    state.ctx = canvas.getContext('2d');
  }

  state.destroyed = false;
  bindListeners();

  state.reducedMotion = readReducedMotion();
  resizeEffects();
  syncScene(true);
  return { element: state.canvas, destroyed: state.destroyed };
}

/**
 * 合并配置并应用（启用 / 类型 / 颜色变化都会收敛渲染态）。
 *
 * @param {Partial<EffectsConfig>} patch
 * @returns {EffectsConfig} 合并后的完整配置
 */
export function configureEffects(patch) {
  const next = patch && typeof patch === 'object' ? patch : {};
  const prevKind = state.config.kind;

  if (typeof next.enabled === 'boolean') state.config.enabled = next.enabled;

  if (typeof next.kind === 'string') {
    if (KINDS.includes(next.kind)) {
      state.config.kind = /** @type {EffectKind} */ (next.kind);
    } else {
      console.warn('[effects] 未知特效类型：' + next.kind + '（已忽略，保持 ' + state.config.kind + '）');
    }
  }

  if (typeof next.color === 'string' && next.color.trim()) {
    state.config.color = next.color.trim();
  }

  // 未初始化时按需初始化（destroyEffects 后再次 configureEffects 可恢复）
  if (!state.canvas) {
    initEffects();
    return getEffectsConfig();
  }

  const kindChanged = state.config.kind !== prevKind;
  if (kindChanged) resetScene();

  state.destroyed = false;
  syncScene(kindChanged);
  return getEffectsConfig();
}

/**
 * @param {boolean} enabled
 * @returns {EffectsConfig}
 */
export function setEffectsEnabled(enabled) {
  return configureEffects({ enabled: enabled === true });
}

/**
 * @param {EffectKind} kind
 * @returns {EffectsConfig}
 */
export function setEffectKind(kind) {
  return configureEffects({ kind: kind });
}

/**
 * @returns {EffectsConfig} 配置快照（调用方改动不影响内部状态）
 */
export function getEffectsConfig() {
  return {
    enabled: state.config.enabled,
    kind: state.config.kind,
    color: state.config.color
  };
}

/**
 * 窗口尺寸变化：重建 DPR 与粒子。
 */
export function resizeEffects() {
  const canvas = state.canvas;
  if (!canvas) return;

  const winW = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 0;
  const winH = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 0;
  const w = Math.max(1, Math.round(winW));
  const h = Math.max(1, Math.round(winH));
  const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, MAX_DPR);

  state.w = w;
  state.h = h;
  state.dpr = dpr;

  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  if (state.ctx) {
    state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // resize 重建粒子（关闭状态下保持为空）
  state.items.length = 0;
  state.ripples.length = 0;
  if (canRender()) ensureItems();
}

/**
 * 停止绘制、清空画布与粒子（可再次 configureEffects 恢复）。
 */
export function destroyEffects() {
  stopRender();
  state.items.length = 0;
  state.ripples.length = 0;
  state.gust = null;
  state.wind = 0;
  state.destroyed = true;
}

/**
 * 只读运行态（验收用）。
 * @returns {{ enabled: boolean, kind: EffectKind, running: boolean, itemCount: number }}
 */
export function getEffectsRuntimeState() {
  return {
    enabled: state.config.enabled,
    kind: state.config.kind,
    running: state.running,
    itemCount: state.items.length
  };
}

/**
 * 启动渲染（若当前配置不允许渲染则 no-op）。
 * @returns {void}
 */
export function start() {
  if (!canRender()) return;
  if (!state.items.length) ensureItems();
  startRender();
}

/**
 * 停止渲染并清屏（保留 canvas 与粒子，可再次 start 恢复）。
 * @returns {void}
 */
export function stop() {
  stopRender();
}

/* ------------------------------------------------------------------ */
/* 内部：监听绑定                                                       */
/* ------------------------------------------------------------------ */

/** 挂 resize / visibilitychange / 减少动画偏好监听（幂等） */
function bindListeners() {
  if (state.listenersBound) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  state.listenersBound = true;

  window.addEventListener('resize', () => {
    resizeEffects();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden === true) {
      // 隐藏：停止绘制（不销毁粒子），恢复可见时可续绘
      stopRender();
      return;
    }
    // 恢复可见：按配置继续
    if (!state.config.enabled || state.reducedMotion) return;
    if (!canRender()) return;
    if (!state.items.length) ensureItems();
    startRender();
  });

  // 跟随系统「减少动画」偏好实时切换
  try {
    const mq = state.motionQuery
      || (typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null);
    if (!mq) return;
    state.motionQuery = mq;
    const onChange = () => {
      state.reducedMotion = mq.matches === true;
      if (state.reducedMotion) {
        stopRender();
        state.items.length = 0;
        state.ripples.length = 0;
      } else if (state.config.enabled) {
        syncScene(true);
      }
    };
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
    } else if (typeof mq.addListener === 'function') {
      mq.addListener(onChange);
    }
  } catch (err) {
    /* 不支持 matchMedia 的环境忽略 */
  }
}

/* ------------------------------------------------------------------ */
/* 默认导出（与具名导出一一对应，供两种引入方式复用）                     */
/* ------------------------------------------------------------------ */

const effectsApi = {
  initEffects,
  configureEffects,
  setEffectsEnabled,
  setEffectKind,
  getEffectsConfig,
  resizeEffects,
  destroyEffects,
  getEffectsRuntimeState,
  start,
  stop
};

export default effectsApi;