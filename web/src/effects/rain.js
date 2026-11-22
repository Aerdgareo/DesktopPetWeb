/**
 * rain.js —— 全屏雨效渲染层 + 雨声 / 雷声音频控制
 *
 * 契约：C-RAIN-VISUAL@1 + C-RAIN-AUDIO@1（见计划 2.2.9 / 2.2.10）
 *
 * 设计要点：
 *  - 独立 canvas 雨层（默认 id="pet-rain-canvas"，position:fixed + inset:0 + pointer-events:none + z-index:9997），
 *    与 Live2D 舞台互不干扰，鼠标事件直接穿透到下层；
 *  - 36ms 门控 requestAnimationFrame（用「距上次绘制」的差值门控，**不是**每帧刷新 lastTime），
 *    约 27fps，低端设备也能稳定运行；
 *  - 只用 2D 基础线段；每滴预生成 rgba 颜色字符串，禁止 shadowBlur / filter；
 *  - 四档（light / moderate / heavy / thunder）参数严格落在 2.2.9 表格区间内；
 *  - `prefers-reduced-motion: reduce` → 不启动绘制、不播放音频；
 *  - 音频走 HTMLAudioElement（非 Web Audio），按 ogg → mp3 → flac → wav 顺序探测；
 *    首个 play() 被自动播放策略拒绝时置 blocked=true，并注册一次性手势监听重试。
 *
 * 本模块不依赖其它项目源码，可单独 `node --check` 与在 Node 中做 DOM 桩冒烟测试
 * （所有 DOM / window 访问都发生在函数体内）。
 */

/* ------------------------------------------------------------------ */
/* 常量                                                               */
/* ------------------------------------------------------------------ */

const DEFAULT_CANVAS_ID = 'pet-rain-canvas';
const DEFAULT_Z_INDEX = 9997;
/** 绘制节流间隔（ms）：参考 R:\mywallpaper\code\effects.js */
const FRAME_INTERVAL_MS = 36;
/** DPR 上限：高分屏收益递减，1.75 已足够且省掉大量填充带宽 */
const MAX_DPR = 1.75;
/** 闪电持续时长（ms） */
const FLASH_DURATION_MS = 250;
/** 闪电起始白度 */
const FLASH_PEAK_ALPHA = 0.55;
/** 音频相对 web/index.html 的目录（Tauri 下为普通相对 URL，不使用 asset 协议） */
const AUDIO_BASE = 'assets/audio/';
/** 探测顺序：ogg → mp3 → flac → wav（flac 先于 wav：当前发布的循环雨声即 .flac） */
const AUDIO_EXTS = ['ogg', 'mp3', 'flac', 'wav'];
/** 单个候选文件探测超时（ms）：文件缺失时 error 会立即触发，超时只用于兜底 */
const AUDIO_PROBE_TIMEOUT_MS = 4000;
/** 雷声音量（固定） */
const THUNDER_VOLUME = 0.8;

/**
 * 档位参数表（2.2.9，±15% 验收容差）。
 * count = clamp(round(w * h / pxPer), min, max)
 *
 * @typedef {Object} RainLevelSpec
 * @property {string} label
 * @property {number} pxPer
 * @property {number} min
 * @property {number} max
 * @property {[number, number]} vy      每帧下落像素
 * @property {[number, number]} len     雨滴长度（px）
 * @property {[number, number]} vx      每帧横向漂移（px）
 * @property {[number, number]} alpha   不透明度
 * @property {number} volume            雨声音量
 * @property {[number, number]|null} thunder 闪电间隔（ms），无则为 null
 */
const LEVELS = {
  light: {
    label: '小雨',
    pxPer: 16000,
    min: 60,
    max: 110,
    vy: [7, 11],
    len: [8, 14],
    vx: [0, 0],
    alpha: [0.3, 0.55],
    volume: 0.25,
    thunder: null
  },
  moderate: {
    label: '中雨',
    pxPer: 8000,
    min: 130,
    max: 220,
    vy: [11, 16],
    len: [12, 20],
    vx: [0, 0],
    alpha: [0.35, 0.65],
    volume: 0.4,
    thunder: null
  },
  heavy: {
    label: '大雨',
    pxPer: 4500,
    min: 260,
    max: 380,
    vy: [16, 23],
    len: [18, 28],
    vx: [0, 0],
    alpha: [0.4, 0.75],
    volume: 0.6,
    thunder: null
  },
  thunder: {
    label: '雷雨',
    pxPer: 3800,
    min: 300,
    max: 430,
    vy: [17, 25],
    len: [20, 32],
    vx: [0, 0],
    alpha: [0.45, 0.8],
    volume: 0.55,
    thunder: [6000, 14000]
  }
};

/** @typedef {'light'|'moderate'|'heavy'|'thunder'} RainLevel */

/**
 * @typedef {Object} RainConfig
 * @property {boolean} enabled
 * @property {RainLevel} level
 * @property {boolean} soundEnabled
 */

/* ------------------------------------------------------------------ */
/* 运行时状态                                                          */
/* ------------------------------------------------------------------ */

const state = {
  /** @type {RainConfig} */
  config: { enabled: false, level: 'moderate', soundEnabled: false },
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
  /** @type {RainDrop[]} */
  items: [],
  /** @type {{start:number, until:number}|null} */
  flash: null,
  /** 下一次闪电的时间戳（ms），0 = 尚未排期 */
  nextThunderAt: 0,
  reducedMotion: false,
  /** window / document 监听是否已挂（幂等） */
  listenersBound: false,
  /** @type {MediaQueryList|null} */
  motionQuery: null
};

/**
 * @typedef {Object} RainDrop
 * @property {number} x
 * @property {number} y
 * @property {number} vy
 * @property {number} vx
 * @property {number} len
 * @property {number} a
 * @property {number} lw
 * @property {string} color 预生成的 rgba 字符串
 */

/**
 * 音频运行时状态。
 *  - switchOn：setAudioEnabled 的显式开关（与 config.soundEnabled 取与）；
 *  - detected：是否已完成资源探测（无论成功与否）；
 *  - blocked：自动播放被拒 / 资源缺失；
 */
const audio = {
  /** @type {HTMLAudioElement|null} */
  rain: null,
  /** @type {HTMLAudioElement|null} */
  thunder: null,
  /** @type {string|null} */
  rainSrc: null,
  /** @type {string|null} */
  thunderSrc: null,
  /** @type {Promise<void>|null} */
  detecting: null,
  detected: false,
  blocked: false,
  /** 控制台只警告一次 */
  warnedRain: false,
  warnedThunder: false,
  /** 一次性手势监听是否已注册 */
  gestureBound: false,
  switchOn: true,
  /** 雷声元素尚未就绪时暂存一次请求 */
  pendingThunder: false
};

/* ------------------------------------------------------------------ */
/* 小工具                                                             */
/* ------------------------------------------------------------------ */

function rand(min, max) {
  return min + Math.random() * (max - min);
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

/** 是否允许绘制（已启用 + 未减少动画 + 页面可见） */
function canRender() {
  if (!state.canvas || !state.ctx) return false;
  if (!state.config.enabled) return false;
  if (state.reducedMotion) return false;
  if (typeof document !== 'undefined' && document.hidden === true) return false;
  return true;
}

/** 当前是否期望播放雨声 */
function wantRainSound() {
  if (!state.config.enabled) return false;
  if (!state.config.soundEnabled) return false;
  if (!audio.switchOn) return false;
  if (state.reducedMotion) return false;
  return true;
}

function volumeForLevel(level) {
  const spec = LEVELS[level] || LEVELS.moderate;
  return spec.volume;
}

/* ------------------------------------------------------------------ */
/* 粒子                                                                */
/* ------------------------------------------------------------------ */

/**
 * 就地重置一滴雨的参数（避免每帧分配对象）。
 * @param {RainDrop} drop
 * @param {RainLevelSpec} spec
 * @param {boolean} initial 首次填充：随机纵向分布；否则从顶部上方落下
 * @returns {RainDrop}
 */
function resetDrop(drop, spec, initial) {
  const w = state.w;
  const h = state.h;
  drop.x = rand(-40, w + 40);
  drop.y = initial ? rand(0, h) : rand(-40, -6);
  drop.vy = rand(spec.vy[0], spec.vy[1]);
  drop.vx = rand(spec.vx[0], spec.vx[1]);
  drop.len = rand(spec.len[0], spec.len[1]);
  drop.a = rand(spec.alpha[0], spec.alpha[1]);
  drop.lw = Math.round(rand(1, 1.6) * 10) / 10;
  // 每滴预生成颜色串，绘制时不再做字符串拼接
  drop.color = 'rgba(200,225,255,' + drop.a.toFixed(3) + ')';
  return drop;
}

/**
 * 按当前档位重建粒子集合。
 * 关闭（或减少动画 / 已销毁）时清空 —— 保证 getRainRuntimeState().particleCount === 0。
 */
function rebuildParticles() {
  const items = state.items;
  items.length = 0;
  if (!canRender()) return;

  const spec = LEVELS[state.config.level] || LEVELS.moderate;
  const target = clamp(Math.round((state.w * state.h) / spec.pxPer), spec.min, spec.max);

  for (let i = 0; i < target; i++) {
    const drop = {
      x: 0,
      y: 0,
      vy: 0,
      vx: 0,
      len: 0,
      a: 0,
      lw: 1,
      color: ''
    };
    items.push(resetDrop(drop, spec, true));
  }
}

/* ------------------------------------------------------------------ */
/* 绘制                                                                */
/* ------------------------------------------------------------------ */

/**
 * 单次绘制（已由 tick 完成 36ms 门控）。
 * @param {number} now rAF 时间戳（ms）
 */
function drawFrame(now) {
  const ctx = state.ctx;
  if (!ctx) return;

  const w = state.w;
  const h = state.h;
  ctx.clearRect(0, 0, w, h);

  const spec = LEVELS[state.config.level] || LEVELS.moderate;
  const items = state.items;

  for (let i = 0; i < items.length; i++) {
    const drop = items[i];
    drop.x += drop.vx;
    drop.y += drop.vy;

    // 出界 → 从顶部重生（本帧不绘制，与参考实现一致）
    if (drop.y > h + 60 || drop.x < -60 || drop.x > w + 60) {
      resetDrop(drop, spec, false);
      continue;
    }

    ctx.strokeStyle = drop.color;
    ctx.lineWidth = drop.lw;
    ctx.beginPath();
    ctx.moveTo(drop.x, drop.y);
    ctx.lineTo(drop.x - drop.vx * drop.len * 0.45, drop.y - drop.len);
    ctx.stroke();
  }

  drawFlash(now);
}

/**
 * 雷雨白闪：0.25s 内从 0.55 线性衰减到 0（全屏填充）。
 * @param {number} now
 */
function drawFlash(now) {
  const flash = state.flash;
  if (!flash) return;
  const ctx = state.ctx;
  if (!ctx) return;

  if (now >= flash.until) {
    state.flash = null;
    return;
  }
  const progress = (now - flash.start) / FLASH_DURATION_MS;
  const k = FLASH_PEAK_ALPHA * (1 - clamp(progress, 0, 1));
  ctx.fillStyle = 'rgba(255,255,255,' + k.toFixed(3) + ')';
  ctx.fillRect(0, 0, state.w, state.h);
}

/** 触发一次白闪，并按需播放雷声 */
function triggerFlash(now) {
  state.flash = { start: now, until: now + FLASH_DURATION_MS };
  if (wantRainSound()) playThunder();
}

/** 安排下一次闪电（thunder 档 6–14s，其余档不排期） */
function scheduleNextThunder(now) {
  const spec = LEVELS[state.config.level] || LEVELS.moderate;
  if (!spec.thunder) {
    state.nextThunderAt = 0;
    return;
  }
  state.nextThunderAt = now + rand(spec.thunder[0], spec.thunder[1]);
}

/**
 * 每帧检查是否到闪电时间。
 * @param {number} now
 */
function maybeTriggerThunder(now) {
  const spec = LEVELS[state.config.level] || LEVELS.moderate;
  if (!spec.thunder) return;
  if (!state.nextThunderAt) {
    scheduleNextThunder(now);
    return;
  }
  if (now < state.nextThunderAt) return;
  triggerFlash(now);
  scheduleNextThunder(now);
}

/* ------------------------------------------------------------------ */
/* 渲染循环                                                            */
/* ------------------------------------------------------------------ */

/** @param {number} now */
function tick(now) {
  if (!state.running) return;
  const ts = typeof now === 'number' && now > 0 ? now : nowMs();

  // 36ms 门控：用「距上次绘制」的差值判断，未达间隔只续帧、不更新 lastFrameTime
  if (ts - state.lastFrameTime >= FRAME_INTERVAL_MS) {
    state.lastFrameTime = ts;
    maybeTriggerThunder(ts);
    drawFrame(ts);
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

  state.flash = null;
  state.nextThunderAt = 0;
}

/* ------------------------------------------------------------------ */
/* 音频探测与播放                                                       */
/* ------------------------------------------------------------------ */

/**
 * 按 ogg → mp3 → flac → wav 顺序探测某个音频资源。
 * 用 `new Audio(src)` + canplaythrough/loadeddata/error 判定，缺失即继续下一个候选。
 *
 * @param {string} baseName 不含扩展名，例如 'rain-loop'
 * @param {{ loop: boolean, volume: number }} options
 * @returns {Promise<{ element: HTMLAudioElement, src: string }|null>}
 */
function loadAudioElement(baseName, options) {
  return new Promise((resolve) => {
    let index = 0;

    const attemptNext = () => {
      if (index >= AUDIO_EXTS.length) {
        resolve(null);
        return;
      }
      const src = AUDIO_BASE + baseName + '.' + AUDIO_EXTS[index++];

      let element;
      try {
        if (typeof Audio !== 'function') {
          resolve(null);
          return;
        }
        element = new Audio();
      } catch (err) {
        resolve(null);
        return;
      }

      element.preload = 'auto';
      element.loop = options.loop === true;
      element.volume = clamp(options.volume, 0, 1);

      let settled = false;
      let timer = 0;

      const finish = (ok) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        element.removeEventListener('canplaythrough', onReady);
        element.removeEventListener('loadeddata', onReady);
        element.removeEventListener('error', onError);

        if (ok) {
          resolve({ element, src });
          return;
        }
        // 释放探测失败的元素，继续下一个扩展名
        try {
          element.src = '';
        } catch (err) {
          /* 忽略 */
        }
        attemptNext();
      };

      const onReady = () => finish(true);
      const onError = () => finish(false);

      element.addEventListener('canplaythrough', onReady);
      element.addEventListener('loadeddata', onReady);
      element.addEventListener('error', onError);
      timer = setTimeout(() => finish(false), AUDIO_PROBE_TIMEOUT_MS);

      try {
        element.src = src;
        element.load();
      } catch (err) {
        finish(false);
      }
    };

    attemptNext();
  });
}

/**
 * 首次需要播放时探测并创建音频元素（幂等）。
 * 缺失资源 → src = null、blocked = true、console.warn 一次，不抛错（雨照常渲染）。
 * @returns {Promise<void>}
 */
function ensureAudio() {
  if (audio.detected) return Promise.resolve();
  if (audio.detecting) return audio.detecting;

  audio.detecting = (async () => {
    const rainResult = await loadAudioElement('rain-loop', {
      loop: true,
      volume: volumeForLevel(state.config.level)
    });
    const thunderResult = await loadAudioElement('thunder', { loop: false, volume: THUNDER_VOLUME });

    audio.rain = rainResult ? rainResult.element : null;
    audio.rainSrc = rainResult ? rainResult.src : null;
    audio.thunder = thunderResult ? thunderResult.element : null;
    audio.thunderSrc = thunderResult ? thunderResult.src : null;

    if (!rainResult) {
      if (!audio.warnedRain) {
        audio.warnedRain = true;
        console.warn(
          '[rain] 未找到可播放的雨声资源（' + AUDIO_BASE + 'rain-loop.ogg|mp3|flac|wav）；雨效继续渲染，音频静音'
        );
      }
      audio.blocked = true;
    }
    if (!thunderResult && !audio.warnedThunder) {
      audio.warnedThunder = true;
      console.warn(
        '[rain] 未找到可播放的雷声资源（' + AUDIO_BASE + 'thunder.ogg|mp3|flac|wav）；雷雨档仅保留白闪'
      );
    }

    // 元素音量按当前档位同步（探测期间档位可能已变化）
    applyVolume();
    audio.detected = true;

    // 探测完成后补播一次被延迟的雷声
    if (audio.pendingThunder) {
      audio.pendingThunder = false;
      playThunder();
    }
    // 探测完成后若仍期望播放雨声，再尝试一次
    if (wantRainSound()) {
      startRainSound();
    }
  })();

  return audio.detecting;
}

/** 把当前档位音量写到雨声元素 */
function applyVolume() {
  if (!audio.rain) return;
  try {
    audio.rain.volume = clamp(volumeForLevel(state.config.level), 0, 1);
  } catch (err) {
    /* 元素可能已释放 */
  }
}

/**
 * 注册一次性手势监听（pointerdown / keydown，capture）用于绕过自动播放限制。
 * 触发后调用 unlockAudio() 重试。
 */
function bindGestureUnlock() {
  if (audio.gestureBound) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

  audio.gestureBound = true;

  const handler = () => {
    window.removeEventListener('pointerdown', handler, true);
    window.removeEventListener('keydown', handler, true);
    audio.gestureBound = false;
    unlockAudio().catch(() => {
      /* unlockAudio 内部已把状态写回 blocked */
    });
  };

  window.addEventListener('pointerdown', handler, { once: true, capture: true });
  window.addEventListener('keydown', handler, { once: true, capture: true });
}

/** 播放失败处理：置 blocked 并挂手势重试 */
function handlePlayFailure() {
  audio.blocked = true;
  bindGestureUnlock();
}

/** 尝试启动雨声循环（不判断配置，由调用方保证语义） */
function startRainSound() {
  const element = audio.rain;
  if (!element) {
    audio.blocked = true;
    return;
  }
  applyVolume();
  try {
    const result = element.play();
    if (result && typeof result.then === 'function') {
      result.then(
        () => {
          audio.blocked = false;
        },
        () => {
          handlePlayFailure();
        }
      );
    } else {
      audio.blocked = false;
    }
  } catch (err) {
    handlePlayFailure();
  }
}

/** 暂停雨声并归零 */
function stopRainSound() {
  const element = audio.rain;
  if (!element) return;
  try {
    element.pause();
    element.currentTime = 0;
  } catch (err) {
    /* 元素未加载 metadata 时设置 currentTime 可能抛错，忽略 */
  }
}

/** 依据配置同步雨声播放状态（异步等探测完成） */
function syncAudio() {
  if (!wantRainSound()) {
    stopRainSound();
    return;
  }
  if (!audio.detected) {
    ensureAudio().catch(() => {
      /* ensureAudio 内部已处理缺失 */
    });
    return;
  }
  startRainSound();
}

/* ------------------------------------------------------------------ */
/* 对外：音频接口                                                       */
/* ------------------------------------------------------------------ */

/**
 * 底层音频开关（与 config.soundEnabled 取与）。
 * @param {boolean} enabled
 */
export function setAudioEnabled(enabled) {
  audio.switchOn = enabled === true;
  if (!audio.switchOn) {
    stopRainSound();
  } else {
    syncAudio();
  }
}

/**
 * 按档位设置雨声音量。
 * @param {RainLevel} level
 */
export function setAudioVolumeForLevel(level) {
  if (!LEVELS[level]) return;
  applyVolume();
}

/**
 * 播放一次雷声（雷雨档触发）。soundEnabled=false / 未启用 / 减少动画时 no-op。
 * 连续触发时重置 currentTime 后播放，不叠加多个雷声。
 */
export function playThunder() {
  if (!state.config.enabled) return;
  if (!state.config.soundEnabled) return;
  if (state.reducedMotion) return;
  if (!audio.switchOn) return;

  const element = audio.thunder;
  if (!element) {
    // 资源尚未探测完成：等探测结束后补播一次
    if (!audio.detected) {
      audio.pendingThunder = true;
      ensureAudio().catch(() => {
        /* 缺失资源已在 ensureAudio 中告警 */
      });
    }
    return;
  }

  try {
    element.volume = THUNDER_VOLUME;
    if (element.readyState >= 1) element.currentTime = 0;
  } catch (err) {
    /* 元数据未就绪，直接 play */
  }

  try {
    const result = element.play();
    if (result && typeof result.then === 'function') {
      result.then(
        () => {
          /* 雷声播放成功不改变雨声的 blocked 语义 */
        },
        () => {
          handlePlayFailure();
        }
      );
    }
  } catch (err) {
    handlePlayFailure();
  }
}

/**
 * 只读音频状态。
 * @returns {{ playing: boolean, blocked: boolean, src: string|null }}
 */
export function getAudioState() {
  const element = audio.rain;
  let playing = false;
  if (element) {
    try {
      playing = element.paused === false && element.ended !== true;
    } catch (err) {
      playing = false;
    }
  }
  return {
    playing: playing,
    blocked: audio.blocked,
    src: audio.rainSrc
  };
}

/**
 * 用户手势后调用：解锁并启动循环雨声。
 * @returns {Promise<boolean>} 成功播放返回 true
 */
export async function unlockAudio() {
  await ensureAudio();

  if (!audio.rain) {
    audio.blocked = true;
    return false;
  }
  if (!wantRainSound()) {
    return false;
  }

  try {
    applyVolume();
    await audio.rain.play();
    audio.blocked = false;
    return true;
  } catch (err) {
    audio.blocked = true;
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 对外：雨层接口                                                       */
/* ------------------------------------------------------------------ */

/**
 * 初始化雨层（幂等）。自建 canvas 并挂到 body。
 * @param {{ canvasId?: string, zIndex?: number }} [options]
 * @returns {{ element: HTMLCanvasElement|null, destroyed: boolean }}
 */
export function initRain(options) {
  const opts = options || {};

  if (typeof document === 'undefined' || !document.body) {
    // 非浏览器环境：返回空句柄，调用方可安全 no-op
    state.destroyed = true;
    return { element: null, destroyed: true };
  }

  if (!state.canvas) {
    const canvasId = opts.canvasId || DEFAULT_CANVAS_ID;
    const zIndex = Number.isFinite(opts.zIndex) ? Number(opts.zIndex) : DEFAULT_Z_INDEX;

    let canvas = document.getElementById(canvasId);
    if (!canvas || canvas.tagName !== 'CANVAS') {
      canvas = document.createElement('canvas');
      canvas.id = canvasId;
    }

    // 固定样式：全屏覆盖 + 鼠标穿透（z-index 位于 Live2D 舞台与 UI 之上，但不拦截事件）
    canvas.style.position = 'fixed';
    canvas.style.inset = '0';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = String(zIndex);
    canvas.style.opacity = '0';
    canvas.style.background = 'transparent';
    canvas.style.display = 'block';
    canvas.setAttribute('aria-hidden', 'true');

    if (!canvas.parentNode) document.body.appendChild(canvas);

    state.canvas = canvas;
    state.ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  }

  state.destroyed = false;
  bindListeners();

  state.reducedMotion = readReducedMotion();
  resizeRain();
  applyConfig();
  return { element: state.canvas, destroyed: state.destroyed };
}

/**
 * 合并配置并应用（任何字段变化都会重建粒子 / 同步音频 / 启停渲染）。
 * @param {Partial<RainConfig>} patch
 * @returns {RainConfig}
 */
export function configureRain(patch) {
  const next = patch || {};
  const prevLevel = state.config.level;


  if (typeof next.enabled === 'boolean') state.config.enabled = next.enabled;
  if (typeof next.soundEnabled === 'boolean') state.config.soundEnabled = next.soundEnabled;
  if (typeof next.level === 'string') {
    if (LEVELS[next.level]) {
      state.config.level = /** @type {RainLevel} */ (next.level);
    } else {
      console.warn('[rain] 未知雨效档位：' + next.level + '（已忽略，保持 ' + state.config.level + '）');
    }
  }

  // 未初始化时按需初始化（destroyRain 后再次 configureRain 可恢复）
  if (!state.canvas && typeof document !== 'undefined' && document.body) {
    initRain();
    return getRainConfig();
  }

  state.reducedMotion = readReducedMotion();

  // 档位变化：重置闪电排期（粒子在下面按需重建）
  const levelChanged = state.config.level !== prevLevel;
  if (levelChanged) {
    state.flash = null;
    state.nextThunderAt = 0;
  }

  // 按目标态收敛（幂等）：
  //  - 启用且允许动画 → 保证粒子存在 + 渲染循环在跑；
  //  - 其它（关闭 / 减少动画 / 页面隐藏）→ 停绘 + 清屏 + 清空粒子（particleCount = 0）。
  if (state.config.enabled && !state.reducedMotion) {
    if (levelChanged || !state.items.length) rebuildParticles();
    startRender();
    if (!state.nextThunderAt) scheduleNextThunder(nowMs());
  } else {
    stopRender();
    state.items.length = 0;
  }

  applyVolume();
  // syncAudio 内部幂等：不期望播放即暂停归零，期望播放则等探测完成后起播
  syncAudio();

  state.destroyed = false;
  return getRainConfig();
}

/**
 * @param {boolean} enabled
 * @returns {RainConfig}
 */
export function setRainEnabled(enabled) {
  return configureRain({ enabled: enabled === true });
}

/**
 * @param {RainLevel} level
 * @returns {RainConfig}
 */
export function setRainLevel(level) {
  return configureRain({ level: level });
}

/**
 * @param {boolean} enabled
 * @returns {RainConfig}
 */
export function setRainSoundEnabled(enabled) {
  return configureRain({ soundEnabled: enabled === true });
}

/**
 * @returns {RainConfig} 配置快照（调用方改动不影响内部状态）
 */
export function getRainConfig() {
  return {
    enabled: state.config.enabled,
    level: state.config.level,
    soundEnabled: state.config.soundEnabled
  };
}

/**
 * 窗口尺寸变化：重建 DPR 与粒子。
 */
export function resizeRain() {
  const canvas = state.canvas;
  if (!canvas) return;

  const winW = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 0;
  const winH = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 0;
  const w = Math.max(1, Math.round(winW));
  const h = Math.max(1, Math.round(winH));
  const dpr = Math.min(
    (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
    MAX_DPR
  );

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
  rebuildParticles();
  state.flash = null;
  state.nextThunderAt = 0;
  if (state.config.enabled && state.running) scheduleNextThunder(nowMs());
}

/**
 * 停止绘制、清空画布、停止音频（可再次 configureRain 恢复）。
 */
export function destroyRain() {
  stopRender();
  state.items.length = 0;
  stopRainSound();
  state.destroyed = true;
}

/**
 * 只读运行态（验收用）。
 * @returns {{
 *   running: boolean,
 *   particleCount: number,
 *   level: RainLevel,
 *   audioPlaying: boolean,
 *   audioBlocked: boolean,
 *   reducedMotion: boolean
 * }}
 */
export function getRainRuntimeState() {
  const audioState = getAudioState();
  return {
    running: state.running,
    particleCount: state.items.length,
    level: state.config.level,
    audioPlaying: audioState.playing,
    audioBlocked: audioState.blocked,
    reducedMotion: state.reducedMotion
  };
}

/* ------------------------------------------------------------------ */
/* 内部：配置应用与监听                                                 */
/* ------------------------------------------------------------------ */

/** 依据当前配置启动/停止（initRain / 恢复时统一入口） */
function applyConfig() {
  state.reducedMotion = readReducedMotion();

  if (!state.config.enabled || state.reducedMotion) {
    stopRender();
    state.items.length = 0;
  } else {
    if (!state.items.length) rebuildParticles();
    startRender();
    if (!state.nextThunderAt) scheduleNextThunder(nowMs());
  }

  if (state.config.enabled && state.config.soundEnabled) {
    syncAudio();
  } else {
    stopRainSound();
  }
}

/** 挂 resize / visibilitychange / 减少动画偏好监听（幂等） */
function bindListeners() {
  if (state.listenersBound) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  state.listenersBound = true;

  window.addEventListener('resize', () => {
    resizeRain();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden === true) {
      // 隐藏：停止绘制（不销毁粒子），并暂停雨声
      stopRender();
      stopRainSound();
      return;
    }
    // 恢复可见：按配置继续
    if (!state.config.enabled || state.reducedMotion) return;
    if (!state.items.length) rebuildParticles();
    startRender();
    if (!state.nextThunderAt) scheduleNextThunder(nowMs());
    syncAudio();
  });

  // 跟随系统「减少动画」偏好实时切换
  try {
    const mq = state.motionQuery || window.matchMedia('(prefers-reduced-motion: reduce)');
    state.motionQuery = mq;
    const onChange = () => {
      state.reducedMotion = mq.matches === true;
      if (state.reducedMotion) {
        stopRender();
        state.items.length = 0;
        stopRainSound();
      } else if (state.config.enabled) {
        if (!state.items.length) rebuildParticles();
        startRender();
        scheduleNextThunder(nowMs());
        syncAudio();
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
/* 默认导出                                                            */
/* ------------------------------------------------------------------ */

const rainApi = {
  initRain,
  configureRain,
  setRainEnabled,
  setRainLevel,
  setRainSoundEnabled,
  getRainConfig,
  resizeRain,
  destroyRain,
  getRainRuntimeState,
  setAudioEnabled,
  setAudioVolumeForLevel,
  playThunder,
  getAudioState,
  unlockAudio
};

export default rainApi;