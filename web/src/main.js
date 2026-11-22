/**
 * main.js —— 桌宠 Web 渲染前端入口（Electron / Tauri 共用）
 *
 * 编排：PIXI.Application（全屏透明）→ 模型加载 → 设置面板 → 交互（视线/拖拽/点击/穿透）→ 外壳桥。
 *
 * 本版本新增应用接线（提供契约 C-APP-SHELL@1）：
 *  1. 多模型实例：启动恢复（`app/instances.js`）→ 失败/为空回退单模型；切换=替换活动实例、
 *     「以新实例显示」= 新增实例；移除/选中/拖拽位置回写。
 *  2. 全屏雨效：启动读取 `pet.rain.*` 缓存 → 配置并初始化 `effects/rain.js`；面板变更持久化；
 *     resize 同步、退出清理。
 *  3. 氛围特效（下雪 / 樱花 / 群星 / 音符）：启动读取 `pet.effects.v1` → 初始化
 *     `effects/effects.js` → 应用；面板变更持久化；resize / 退出同步；
 *     与全屏雨效**互斥**（同一时刻只生效一种氛围特效，特效优先）。
 *  4. 导入根目录：读/刷新均经 `bridge.getImportRoot()`（数据真源在后端 config.json，**不写 localStorage**）。
 *
 * 降级原则（N2/N4）：任一新增模块缺失或初始化失败时，仅关闭该能力并 `console.warn`，
 * 既有「单模型 + 模型列表/切换/外部模型/穿透」行为必须保持不变。
 */

import { bridge } from './bridge.js';
import * as modelLoader from './live2d/modelLoader.js';
import { createPetInteraction } from './interaction/petInteraction.js';
import { createSettingsPanel } from './ui/settingsPanel.js';
import { createInstanceStore } from './app/instances.js';

/** localStorage 键名（实例键由 app/instances.js 独占，此处不得读写） */
const LS = {
  modelUrl: 'pet.modelUrl',
  alpha: 'pet.alpha',
  scale: 'pet.scalePercent',
  alwaysOnTop: 'pet.alwaysOnTop',
  // 雨效配置：计划 2.3.4 规定的三个独立键（T14 验收读取）
  rainEnabled: 'pet.rain.enabled',
  rainLevel: 'pet.rain.level',
  rainSound: 'pet.rain.sound',
  // 雨效配置：聚合对象键（兼容以该键持久化的实现，读写与上面三个键保持同值）
  rainV1: 'pet.rain.v1',
  // 氛围特效配置（下雪 / 樱花 / 群星 / 音符）：{enabled, kind}
  effectsV1: 'pet.effects.v1'
};

/** 实例数量上限（R3-1 / R3-8，与 modelLoader MAX_INSTANCES 一致） */
const INSTANCE_LIMIT = 6;

/** 雨效档位枚举（与 rain.js 的 RainLevel 一致） */
const RAIN_LEVELS = ['light', 'moderate', 'heavy', 'thunder'];

/** 雨效默认配置（决策 D5：默认关闭、小雨、音效开） */
const RAIN_DEFAULT = Object.freeze({ enabled: false, level: 'light', soundEnabled: true });

/** 雨效运行态降级值（模块不可用时的只读快照） */
const RAIN_STATE_DEFAULT = Object.freeze({
  running: false,
  particleCount: 0,
  level: 'light',
  audioPlaying: false,
  audioBlocked: false,
  reducedMotion: false
});

/** 氛围特效类型枚举（与 effects/effects.js 的 EffectKind 一致） */
const EFFECTS_KINDS = ['none', 'snow', 'sakura', 'stars', 'notes'];

/** 氛围特效默认配置（默认关闭、无类型） */
const EFFECTS_DEFAULT = Object.freeze({ enabled: false, kind: 'none' });

/** 氛围特效运行态降级值（模块不可用时的只读快照） */
const EFFECTS_STATE_DEFAULT = Object.freeze({
  enabled: false,
  kind: 'none',
  running: false,
  itemCount: 0
});

/** 内置演示模型（官方向 pixi-live2d-display 测试资源，需联网）：
 *  - shizuku：Cubism 2.1（.model.json / .moc / .mtn / .exp.json）
 *  - haru   ：Cubism 4  （.model3.json / .moc3）
 *  两者分别覆盖「2 代 / 4 代自动识别」两条路径。
 */
const DEMO_MODELS = [
  {
    id: 'shizuku',
    name: 'Shizuku（Cubism 2.1 演示）',
    url: 'https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display@v0.4.0/test/assets/shizuku/shizuku.model.json',
    type: 'Cubism2'
  },
  {
    id: 'haru',
    name: 'Haru（Cubism 4 演示）',
    url: 'https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display@v0.4.0/test/assets/haru/haru_greeter_t03.model3.json',
    type: 'Cubism4'
  }
];

/**
 * 实例面板刷新钩子：由 `start()` 注入。
 * 原因：`switchTo()` 等模块级函数无法访问 `start()` 的闭包（panel / instanceStore），
 *       通过该钩子把「刷新实例区块显示」的能力上提到模块级；未注入时为空操作。
 */
let refreshInstancePanel = () => {};

/**
 * 实例持久化钩子：由 `start()` 注入（`instanceStore` 位于其闭包内）。
 * 原因：切换模型后实例 rawUrl 已变更，必须立即落盘 —— 仅靠拖拽节流/退出前落盘不足以
 *       保证「切换即持久化」（R3-3：否则异常退出会按旧 rawUrl 恢复旧模型）。未注入时为空操作。
 */
let persistInstancesNow = () => {};

/**
 * 选出「切换模型」要写进实例 rawUrl 的原始路径（可持久化）。
 *
 * 取值口径与 `addFromCatalog` 同源（`meta.rawUrl || url`），并按可靠性依次回退：
 *   1) 清单条目自带 rawUrl；
 *   2) 按入参 url / 已解析 url 在当前模型清单中反查；
 *   3) 入参 url 本身（内置模型即相对路径）。
 * asset:// / blob: / data: 属外壳临时地址，重启后不可用 → 跳过；全部不可用则返回 undefined
 * （调用方不传 rawUrl，由 modelLoader 保留旧值并告警）。
 *
 * @param {string} url 切换目标（原始或已解析）
 * @param {object|null} modelMeta 清单条目（可能为空）
 * @param {string} [resolvedUrl] resolveModelUrl 后的可加载 URL（用于反查清单）
 * @returns {string|undefined}
 */
function pickSwitchRawUrl(url, modelMeta, resolvedUrl) {
  /** @type {Array<unknown>} */
  const candidates = [];
  if (modelMeta && typeof modelMeta === 'object') candidates.push(modelMeta.rawUrl);
  try {
    const list = (window.petApp && typeof window.petApp.getModels === 'function')
      ? window.petApp.getModels()
      : [];
    const hit = (Array.isArray(list) ? list : []).find((m) => m && (
      m.url === url || m.rawUrl === url ||
      (resolvedUrl && (m.url === resolvedUrl || m.rawUrl === resolvedUrl))
    ));
    if (hit) candidates.push(hit.rawUrl);
  } catch (err) {
    console.warn('[main] 反查模型原始路径失败（忽略）:', err);
  }
  candidates.push(url);

  for (const cand of candidates) {
    const raw = (typeof cand === 'string') ? cand.trim() : '';
    if (!raw) continue;
    // 外壳临时地址与会话内地址不可作为重启后的恢复路径
    if (/^(asset:|blob:|data:)/i.test(raw)) continue;
    return raw;
  }
  return undefined;
}

// ---------------- 工具 ----------------

function readStoredNumber(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    const value = raw == null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch (_) {
    return fallback;
  }
}

function storeNumber(key, value) {
  try { localStorage.setItem(key, String(value)); } catch (_) { /* 忽略隐私模式等异常 */ }
}

/** 读取原始字符串键；缺失/空串/访问异常 → null */
function readStoredRaw(key) {
  try {
    const raw = localStorage.getItem(key);
    return typeof raw === 'string' && raw ? raw : null;
  } catch (_) {
    return null;
  }
}

/**
 * 读取雨效配置（容错，非法值回落默认）。
 *
 * 读取顺序：
 *  1. 先读计划 2.3.4 的三个独立键（`pet.rain.enabled/level/sound`）—— T14 验收读取的口径；
 *  2. 任一字段缺失时，再用聚合对象 `pet.rain.v1`（{enabled,level,soundEnabled}）补齐；
 *  3. 仍缺失 → 默认值（关闭 / light / 音效开）。
 *
 * @returns {{enabled:boolean, level:string, soundEnabled:boolean}}
 */
function readRainConfig() {
  const cfg = { ...RAIN_DEFAULT };

  const enabledKey = readStoredRaw(LS.rainEnabled);
  const levelKey = readStoredRaw(LS.rainLevel);
  const soundKey = readStoredRaw(LS.rainSound);

  if (enabledKey !== null) cfg.enabled = enabledKey === '1' || enabledKey === 'true';
  if (levelKey !== null && RAIN_LEVELS.includes(levelKey)) cfg.level = levelKey;
  if (soundKey !== null) cfg.soundEnabled = soundKey === '1' || soundKey === 'true';

  if (enabledKey === null || levelKey === null || soundKey === null) {
    const text = readStoredRaw(LS.rainV1);
    if (text) {
      try {
        const obj = JSON.parse(text);
        if (obj && typeof obj === 'object') {
          if (enabledKey === null && typeof obj.enabled === 'boolean') cfg.enabled = obj.enabled;
          if (levelKey === null && RAIN_LEVELS.includes(obj.level)) cfg.level = obj.level;
          if (soundKey === null && typeof obj.soundEnabled === 'boolean') cfg.soundEnabled = obj.soundEnabled;
        }
      } catch (err) {
        console.warn('[main] 雨效配置 pet.rain.v1 解析失败，使用默认值:', err);
      }
    }
  }

  return cfg;
}

/**
 * 持久化雨效配置：三个独立键 + 聚合对象键同时写入**同一值**，避免两处来源不一致。
 * 所有写入包 try/catch：隐私模式/配额满时静默降级为「本次不持久化」。
 * @param {{enabled:boolean, level:string, soundEnabled:boolean}} cfg
 */
function persistRainConfig(cfg) {
  const safe = cfg || RAIN_DEFAULT;
  try {
    localStorage.setItem(LS.rainEnabled, safe.enabled ? '1' : '0');
    localStorage.setItem(LS.rainLevel, safe.level);
    localStorage.setItem(LS.rainSound, safe.soundEnabled ? '1' : '0');
  } catch (err) {
    console.warn('[main] 写入雨效配置失败（本次不持久化）:', err);
  }
  try {
    localStorage.setItem(LS.rainV1, JSON.stringify({
      enabled: !!safe.enabled,
      level: safe.level,
      soundEnabled: !!safe.soundEnabled
    }));
  } catch (_) {
    /* 忽略：已有独立键落盘，聚合键失败不影响恢复 */
  }
}

/**
 * 归一化雨效配置（合并 patch + 逐字段校验）。
 * @param {{enabled?:boolean, level?:string, soundEnabled?:boolean}} base
 * @param {object} [patch]
 * @returns {{enabled:boolean, level:string, soundEnabled:boolean}}
 */
function normalizeRainConfig(base, patch) {
  const merged = { ...RAIN_DEFAULT, ...(base || {}), ...(patch || {}) };
  return {
    enabled: !!merged.enabled,
    level: RAIN_LEVELS.includes(merged.level) ? merged.level : RAIN_DEFAULT.level,
    soundEnabled: merged.soundEnabled !== false
  };
}

/**
 * 动态加载雨效模块。
 *
 * 用动态 import 而非静态 import：`effects/rain.js` 由并行任务产出，
 * 静态 import 一旦文件缺失会让整个 main.js 模块解析失败（应用直接白屏）。
 * 跳过该模块只应导致「无雨效」，不得影响既有功能（计划 2.3.7 降级要求）。
 *
 * @returns {Promise<object|null>} 模块命名空间；不可用 → null
 */
async function loadRainModule() {
  try {
    const mod = await import('./effects/rain.js');
    if (!mod || typeof mod.initRain !== 'function') {
      console.warn('[main] 雨效模块缺少 initRain，按不可用降级');
      return null;
    }
    return mod;
  } catch (err) {
    console.warn('[main] 雨效模块加载失败，已降级为无雨效（不影响既有多模型/交互）:', err);
    return null;
  }
}

/**
 * 归一化氛围特效配置（合并 patch + 逐字段校验）。
 * @param {{enabled?:boolean, kind?:string}} [base]
 * @param {{enabled?:boolean, kind?:string}} [patch]
 * @returns {{enabled:boolean, kind:string}}
 */
function normalizeEffectsConfig(base, patch) {
  const merged = { ...EFFECTS_DEFAULT, ...(base || {}), ...(patch || {}) };
  return {
    enabled: !!merged.enabled,
    kind: EFFECTS_KINDS.includes(merged.kind) ? merged.kind : EFFECTS_DEFAULT.kind
  };
}

/**
 * 读取氛围特效配置（容错：缺失 / JSON 损坏 / 字段非法 → 回落默认值）。
 * @returns {{enabled:boolean, kind:string}}
 */
function readEffectsConfig() {
  const text = readStoredRaw(LS.effectsV1);
  if (!text) return { ...EFFECTS_DEFAULT };
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object') return normalizeEffectsConfig(obj);
    console.warn('[main] 氛围特效配置 pet.effects.v1 不是对象，使用默认值');
  } catch (err) {
    console.warn('[main] 氛围特效配置 pet.effects.v1 解析失败，使用默认值:', err);
  }
  return { ...EFFECTS_DEFAULT };
}

/**
 * 持久化氛围特效配置（`pet.effects.v1`）。写入失败（隐私模式 / 配额满）静默降级。
 * @param {{enabled:boolean, kind:string}} cfg
 */
function persistEffectsConfig(cfg) {
  const safe = normalizeEffectsConfig(cfg);
  try {
    localStorage.setItem(LS.effectsV1, JSON.stringify(safe));
  } catch (err) {
    console.warn('[main] 写入氛围特效配置失败（本次不持久化）:', err);
  }
}

/**
 * 动态加载氛围特效模块（失败 → null，仅关闭该能力）。
 * @returns {Promise<object|null>} 模块命名空间；不可用 → null
 */
async function loadEffectsModule() {
  try {
    const mod = await import('./effects/effects.js');
    if (!mod || typeof mod.initEffects !== 'function') {
      console.warn('[main] 氛围特效模块缺少 initEffects，按不可用降级');
      return null;
    }
    return mod;
  } catch (err) {
    console.warn('[main] 氛围特效模块加载失败，已降级为无特效（不影响既有功能）:', err);
    return null;
  }
}

/**
 * 解析模型 URL（跨外壳统一）：
 *  - 已是完整地址（http(s)/file/data/blob/petmodels/asset）→ 原样返回；
 *  - 绝对磁盘路径（Windows 盘符 / UNC）：经外壳 asset 协议转换为可加载 URL
 *    （Tauri：convertFileSrc→asset://；Electron / 浏览器：原样返回）；
 *  - 相对路径：有协议基址（Electron：'petmodels://local/'）则拼接；
 *    否则退回 document.baseURI（Tauri 内置 models / 浏览器直开，保持本地可预览）。
 */
function resolveModelUrl(url) {
  if (!url) return '';
  // 已是完整 URL（含协议）→ 原样返回
  if (/^(https?:|file:|data:|petmodels:|asset:|blob:|tauri:)/i.test(url)) return url;
  // 绝对磁盘路径 → 外壳可加载 URL（Tauri asset 协议；其它外壳原样返回）
  if (/^[a-zA-Z]:[\\/]/.test(url) || /^\\\\/.test(url)) {
    return bridge.toAssetUrl ? bridge.toAssetUrl(url) : url;
  }
  // 相对路径：优先协议基址拼接，否则退回相对 baseURI
  const base = bridge.modelsBaseUrl;
  const rel = String(url).replace(/^\.?\//, '');
  if (base) return base + rel;
  try { return new URL(url, document.baseURI).href; } catch (_) { return url; }
}

function guessModelType(url) {
  if (/\.model3\.json(\?|$)/i.test(url)) return 'Cubism4';
  if (/\.model\.json(\?|$)/i.test(url)) return 'Cubism2';
  return 'Model';
}

/**
 * 归一化模型清单。
 * 同时保留 `rawUrl`（外壳返回的**原始** url：内置为相对路径、导入/外部为绝对磁盘路径），
 * 供「删除模型」时向 Rust 传递可解析的磁盘路径 —— 因为 `url` 会被 resolveModelUrl
 * 转成 asset:// 协议地址，Rust 无法据此定位目录。
 */
function normalizeList(list, source) {
  return (Array.isArray(list) ? list : [])
    .map((raw) => {
      const m = typeof raw === 'string' ? { url: raw } : (raw || {});
      const rawUrl = m.url ? String(m.url) : '';
      const url = resolveModelUrl(m.url);
      if (!url) return null;
      return {
        id: m.id || url,
        name: m.name || m.id || url,
        url,
        rawUrl,
        type: m.type || guessModelType(url),
        source: m.source || source
      };
    })
    .filter(Boolean);
}

let toastTimer = 0;
function showToast(text, ms = 2600) {
  const node = document.getElementById('pet-toast');
  if (!node) { console.info('[pet]', text); return; }
  node.textContent = text;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), ms);
}

// ---------------- 模型清单 ----------------

async function loadCatalog() {
  // 汇总去重（按 url）：外壳清单 ＋ 本地 models.json ＋ 内置演示模型。
  // 说明：Tauri 外壳只扫描「外部模型目录」，内置模型仍来自本地 models/models.json，
  //       故此处采用「合并去重」而非「外壳优先覆盖」，确保内置与外部模型都进入列表；
  //       对 Electron（外壳已返回内置+外部完整清单）而言，合并结果与原来等价。
  const merged = [];
  const seen = new Set();
  const collect = (list, source) => {
    for (const m of normalizeList(list, source)) {
      if (seen.has(m.url)) continue;
      seen.add(m.url);
      merged.push(m);
    }
  };

  // 1) 外壳提供的清单（仅当外壳确实提供该能力时才调用，避免"启用却空操作"与误导）
  if (bridge.capabilities.modelList) {
    try {
      const fromShell = await bridge.getModelList();
      collect(fromShell, 'shell');
    } catch (err) {
      console.warn('[main] 读取外壳模型清单失败:', err);
    }
  } else {
    console.debug('[main] 外壳未提供模型清单能力，跳过（回退 models.json / 内置演示模型）');
  }

  // 2) 本地 models/models.json（用户可自行编辑）
  //    经外部模型协议基址读取（Electron：petmodels://local/models/models.json），
  //    无协议时退回相对路径（Tauri / 浏览器直开）。
  try {
    const manifestUrl = bridge.modelsBaseUrl
      ? (bridge.modelsBaseUrl + 'models/models.json')
      : 'models/models.json';
    const res = await fetch(manifestUrl, { cache: 'no-store' });
    if (res.ok) {
      const json = await res.json();
      const list = Array.isArray(json) ? json : (json && json.models) || [];
      collect(list, 'local');
    }
  } catch (err) {
    console.warn('[main] 读取 models/models.json 失败（将退回内置演示模型）:', err);
  }

  // 3) 内置演示模型（兜底，保证列表非空）
  if (merged.length === 0) collect(DEMO_MODELS, 'demo');

  return merged;
}

/**
 * 选出「单模型回退」要加载的目标（仅当多实例恢复为空时使用）。
 * 优先级与既有实现一致：`?model=` → `pet.modelUrl` → 清单首项。
 *
 * 注意 rawUrl 的选取：实例持久化禁止 asset:// 地址，故优先取清单里对应条目的原始路径；
 * 找不到时退回查询参数/存储原文（可能是 asset://，由 addFromCatalog 拒绝，调用方再降级）。
 *
 * @param {Array} catalog 归一化模型清单
 * @returns {{url:string, rawUrl:string, meta:object}|null}
 */
function pickInitialTarget(catalog) {
  const params = new URLSearchParams(window.location.search);
  const queryRaw = params.get('model');
  const storedRaw = readStoredRaw(LS.modelUrl);
  const findByUrl = (value) => (catalog || []).find((m) => m && (m.url === value || m.rawUrl === value)) || null;

  if (queryRaw) {
    const url = resolveModelUrl(queryRaw);
    const meta = findByUrl(url) || findByUrl(queryRaw);
    return {
      url,
      rawUrl: (meta && meta.rawUrl) || queryRaw,
      meta: meta || { name: queryRaw }
    };
  }

  if (storedRaw) {
    const meta = findByUrl(storedRaw);
    return {
      url: resolveModelUrl(storedRaw),
      rawUrl: (meta && meta.rawUrl) || storedRaw,
      meta: meta || { name: storedRaw }
    };
  }

  const first = (catalog || [])[0];
  if (first && first.url) {
    return { url: first.url, rawUrl: first.rawUrl || first.url, meta: first };
  }

  return null;
}

// ---------------- 启动 ----------------

async function start() {
  const canvas = document.getElementById('pet-canvas');
  if (!canvas) throw new Error('缺少 #pet-canvas 画布元素');
  if (!window.PIXI || !window.PIXI.Application) throw new Error('PIXI 未就绪');

  // 全屏透明应用：backgroundAlpha=0 保证窗口主体透明
  const app = new window.PIXI.Application({
    view: canvas,
    backgroundAlpha: 0,
    transparent: true,
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    powerPreference: 'high-performance'
  });

  const initialAlpha = readStoredNumber(LS.alpha, 1);
  const initialScale = readStoredNumber(LS.scale, 100);

  modelLoader.init(app, { alpha: initialAlpha, scalePercent: initialScale });

  // 模型清单
  const catalog = await loadCatalog();

  // ---------------- 雨效 / 氛围特效：读缓存 → 初始化（顺序固定，失败降级） ----------------
  let rainConfig = readRainConfig();
  // 氛围特效配置先读出（与雨效互斥判定需要），模块随后初始化
  let effectsConfig = readEffectsConfig();
  const rain = await loadRainModule();
  let rainReady = false;

  if (rain) {
    // 先登记配置（对「初始化时才读取配置」的实现同样有效）
    pushRainConfig(rain, rainConfig);
    try {
      rain.initRain();
      rainReady = true;
    } catch (err) {
      console.warn('[main] 初始化雨层失败，已降级为无雨效:', err);
    }
    if (rainReady) {
      // 初始化后再同步一次：保证实际渲染态与缓存的开关/档位/音效一致
      pushRainConfig(rain, rainConfig);
      bindAudioUnlock(rain);
    }
  } else if (rainConfig.enabled) {
    console.warn('[main] 雨效缓存为开启但模块不可用，本次不渲染雨（配置保留，模块恢复后生效）');
  }

  // ---------------- 氛围特效：初始化 → 应用启动配置（失败降级为无特效） ----------------
  const effects = await loadEffectsModule();
  let effectsReady = false;

  if (effects) {
    try {
      const handle = effects.initEffects();
      if (handle && handle.element === null) {
        console.warn('[main] 氛围特效画布不可用，已降级为无特效');
      } else {
        effectsReady = true;
      }
    } catch (err) {
      console.warn('[main] 初始化氛围特效失败，已降级为无特效:', err);
    }
    if (effectsReady) {
      // initEffects 内部已按默认配置收敛；这里再下发一次缓存配置，保证与启动配置一致
      pushEffectsConfig(effectsConfig);
    }
  } else if (effectsConfig.enabled && effectsConfig.kind !== 'none') {
    console.warn('[main] 特效缓存为开启但模块不可用，本次不渲染特效（配置保留，模块恢复后生效）');
  }

  /**
   * 把配置下发给雨层（模块/方法缺失或抛错时静默降级）。
   * @param {object|null} mod 雨效模块
   * @param {{enabled:boolean, level:string, soundEnabled:boolean}} cfg
   */
  function pushRainConfig(mod, cfg) {
    if (!mod || typeof mod.configureRain !== 'function') return;
    try {
      mod.configureRain(cfg);
    } catch (err) {
      console.warn('[main] 应用雨效配置失败（保持上一次生效配置）:', err);
    }
  }

  /**
   * 首次用户手势后解锁音频（R4-9）。
   * rain.js 内部已注册一次性重试监听；此处再补一次幂等调用，覆盖内部未实现的实现版本。
   * @param {object} mod 雨效模块
   */
  function bindAudioUnlock(mod) {
    if (!mod || typeof mod.unlockAudio !== 'function') return;
    const unlock = () => {
      try {
        const ret = mod.unlockAudio();
        if (ret && typeof ret.catch === 'function') ret.catch(() => {});
      } catch (_) { /* 音频解锁失败不影响雨渲染 */ }
    };
    try {
      window.addEventListener('pointerdown', unlock, { once: true, capture: true });
      window.addEventListener('keydown', unlock, { once: true, capture: true });
    } catch (err) {
      console.warn('[main] 注册音频解锁监听失败:', err);
    }
  }

  /**
   * 应用雨效补丁：合并校验 → 下发雨层 → 持久化。返回合并后的完整配置。
   * @param {{enabled?:boolean, level?:string, soundEnabled?:boolean}} patch
   * @returns {{enabled:boolean, level:string, soundEnabled:boolean}}
   */
  function applyRainPatch(patch) {
    rainConfig = normalizeRainConfig(rainConfig, patch);
    if (rainReady) pushRainConfig(rain, rainConfig);
    persistRainConfig(rainConfig);
    // 与氛围特效互斥：下雨开启 → 特效类型归零（保留特效开关位，仅停止渲染）
    if (rainConfig.enabled) silenceEffectsKind();
    // 同步面板控件（T7 的变更路径自身会 refresh；此处覆盖控制台/外部调用路径，setConfig 幂等）
    try {
      if (panel && typeof panel.setRainConfig === 'function') panel.setRainConfig({ ...rainConfig });
    } catch (err) {
      console.warn('[main] 同步雨效面板失败:', err);
    }
    return { ...rainConfig };
  }

  /** 当前雨效配置（优先取雨层真实配置，模块不可用时用本地缓存） */
  function getRainConfig() {
    if (rainReady && rain && typeof rain.getRainConfig === 'function') {
      try {
        const cfg = rain.getRainConfig();
        if (cfg && typeof cfg === 'object') return { ...RAIN_DEFAULT, ...cfg };
      } catch (err) {
        console.warn('[main] 读取雨效配置失败，使用本地缓存:', err);
      }
    }
    return { ...rainConfig };
  }

  /** 雨效运行态只读快照（验收用；模块不可用 → 降级值） */
  function getRainState() {
    if (rainReady && rain && typeof rain.getRainRuntimeState === 'function') {
      try {
        const st = rain.getRainRuntimeState();
        if (st && typeof st === 'object') return st;
      } catch (err) {
        console.warn('[main] 读取雨效运行态失败:', err);
      }
    }
    return { ...RAIN_STATE_DEFAULT, level: rainConfig.level };
  }

  // ---------------- 氛围特效：应用 / 互斥收敛 ----------------

  /**
   * 把配置下发给特效层（模块/方法缺失或抛错时静默降级）。
   * @param {{enabled:boolean, kind:string}} cfg
   */
  function pushEffectsConfig(cfg) {
    if (!effectsReady || !effects || typeof effects.configureEffects !== 'function') return;
    try {
      effects.configureEffects(cfg);
    } catch (err) {
      console.warn('[main] 应用氛围特效配置失败（保持上一次生效配置）:', err);
    }
  }

  /**
   * 同步特效面板控件（覆盖控制台 / 外部调用路径；setConfig 只渲染，幂等）。
   * @param {{enabled:boolean, kind:string}} cfg
   */
  function syncEffectsPanel(cfg) {
    try {
      if (panel && typeof panel.setEffectsConfig === 'function') panel.setEffectsConfig({ ...cfg });
    } catch (err) {
      console.warn('[main] 同步特效面板失败:', err);
    }
  }

  /**
   * 关闭特效类型（保留开关位）：开启下雨时调用，保证二者只生效一种。
   * @returns {boolean} 是否发生变更
   */
  function silenceEffectsKind() {
    if (effectsConfig.kind === 'none') return false;
    effectsConfig = normalizeEffectsConfig(effectsConfig, { kind: 'none' });
    pushEffectsConfig(effectsConfig);
    // 双保险：显式调用 setEffectKind('none')（等价于 configureEffects({kind:'none'})）
    if (effectsReady && effects && typeof effects.setEffectKind === 'function') {
      try {
        effects.setEffectKind('none');
      } catch (err) {
        console.warn('[main] 关闭特效类型失败:', err);
      }
    }
    persistEffectsConfig(effectsConfig);
    syncEffectsPanel(effectsConfig);
    return true;
  }

  /**
   * 氛围特效与「全屏下雨」互斥（特效优先）：
   * 特效开启且类型非 none → 关闭下雨并同步雨效面板。
   */
  function syncAmbienceExclusion() {
    const effectsActive = effectsConfig.enabled && effectsConfig.kind !== 'none';
    if (!effectsActive || !rainConfig.enabled) return;
    rainConfig = normalizeRainConfig(rainConfig, { enabled: false });
    if (rainReady) {
      pushRainConfig(rain, rainConfig);
      // 双保险：显式调用 setRainEnabled(false)（等价于 configureRain({enabled:false})）
      if (typeof rain.setRainEnabled === 'function') {
        try {
          rain.setRainEnabled(false);
        } catch (err) {
          console.warn('[main] 关闭下雨失败:', err);
        }
      }
    }
    persistRainConfig(rainConfig);
    try {
      if (panel && typeof panel.setRainConfig === 'function') panel.setRainConfig({ ...rainConfig });
    } catch (err) {
      console.warn('[main] 同步雨效面板失败:', err);
    }
  }

  /**
   * 应用氛围特效补丁：合并校验 → 下发特效层 → 持久化 → 与雨效互斥 → 同步面板。
   * @param {{enabled?:boolean, kind?:string}} patch
   * @returns {{enabled:boolean, kind:string}}
   */
  function applyEffectsPatch(patch) {
    effectsConfig = normalizeEffectsConfig(effectsConfig, patch);
    pushEffectsConfig(effectsConfig);
    persistEffectsConfig(effectsConfig);
    syncAmbienceExclusion();
    syncEffectsPanel(effectsConfig);
    return { ...effectsConfig };
  }

  /** 当前特效配置（优先取特效层真实配置，模块不可用时用本地缓存） */
  function getEffectsConfig() {
    if (effectsReady && effects && typeof effects.getEffectsConfig === 'function') {
      try {
        const cfg = effects.getEffectsConfig();
        if (cfg && typeof cfg === 'object') return { ...EFFECTS_DEFAULT, ...cfg };
      } catch (err) {
        console.warn('[main] 读取特效配置失败，使用本地缓存:', err);
      }
    }
    return { ...EFFECTS_DEFAULT, ...effectsConfig };
  }

  /** 特效运行态只读快照（验收用；模块不可用 → 降级值） */
  function getEffectsState() {
    if (effectsReady && effects && typeof effects.getEffectsRuntimeState === 'function') {
      try {
        const st = effects.getEffectsRuntimeState();
        if (st && typeof st === 'object') return st;
      } catch (err) {
        console.warn('[main] 读取特效运行态失败:', err);
      }
    }
    return { ...EFFECTS_STATE_DEFAULT, enabled: effectsConfig.enabled, kind: effectsConfig.kind };
  }

  // ---------------- 实例编排（多模型） ----------------
  // 创建失败（模块缺失/接口不匹配）→ instanceStore = null，全链路退回单模型模式。
  let instanceStore = null;
  try {
    instanceStore = createInstanceStore({
      modelLoader,
      resolveUrl: resolveModelUrl,
      notify: (msg, ms) => showToast(msg, ms)
    });
  } catch (err) {
    console.warn('[main] 实例编排模块不可用，退回单模型模式:', err);
  }

  const initialTarget = pickInitialTarget(catalog);

  // —— 设置面板（交互层需要其 UI 命中判定）——
  const panel = createSettingsPanel({
    modelLoader,
    bridge,
    models: catalog,
    currentModelUrl: initialTarget ? initialTarget.url : '',
    alpha: initialAlpha,
    scalePercent: initialScale,
    penetrateSupported: !!(bridge.canForwardMouseMove || bridge.canPollCursor),
    // —— 多实例（C-SETTINGS-PANEL@2 新增字段）——
    instances: instanceStore ? instanceStore.list() : modelLoader.getInstances(),
    instanceLimit: INSTANCE_LIMIT,
    // —— 雨效（C-RAIN-VISUAL@1；模块不可用时传 null，由区块自行降级）——
    rain: rainReady ? rain : null,
    // —— 氛围特效（effects/effects.js；模块不可用时返回 null，由区块自渲染「不可用」）——
    getEffects: () => (effectsReady ? effects : null),
    onSwitchModel(url, model) {
      switchTo(url, model, false).catch((err) => {
        console.error(err);
        showToast('模型切换失败：' + (err && err.message ? err.message : err));
      });
    },
    onImportModel() {
      importModelFlow().catch((err) => {
        console.error(err);
        showToast('导入模型失败：' + (err && err.message ? err.message : err));
      });
    },
    onDeleteModel(model) {
      deleteModelFlow(model).catch((err) => {
        console.error(err);
        showToast('删除模型失败：' + (err && err.message ? err.message : err));
      });
    },
    onRefreshModels() {
      return refreshModelList();
    },
    onQuit() {
      bridge.quit().then((ok) => {
        if (!ok) showToast('当前环境不支持退出');
      });
    },
    onInteractiveModeChange(auto) {
      applyInteractiveMode(auto);
    },
    onAlwaysOnTopChange(value) {
      storeNumber(LS.alwaysOnTop, value ? 1 : 0);
      bridge.setAlwaysOnTop(value);
    },
    onAlphaChange(alpha) {
      storeNumber(LS.alpha, alpha);
    },
    onScaleChange(percent) {
      storeNumber(LS.scale, percent);
    },
    /** 模型条目「＋以新实例显示」 */
    onAddInstance(url, model) {
      addInstanceFlow(url, model).catch(() => { /* 失败提示已在流程内给出 */ });
    },
    /** 实例区块：移除（仅从窗口移除，不删磁盘） */
    onRemoveInstance(id) {
      removeInstanceFlow(id);
    },
    /** 实例区块：选中（设为活动实例） */
    onSelectInstance(id) {
      selectInstanceFlow(id);
    },
    /** 雨效区块变更（T7 已先调用 rain.setRain*，此处负责持久化与二次同步） */
    onRainChange(patch) {
      try {
        // 合并校验 → 下发雨层 → 持久化 → 同步面板（见 applyRainPatch）
        applyRainPatch(patch);
      } catch (err) {
        console.warn('[main] 应用雨效变更失败:', err);
        showToast('雨效设置失败：' + (err && err.message ? err.message : err));
      }
    },
    /** 氛围特效区块变更（区块已先调用 effects.set*，此处负责持久化、互斥与二次同步） */
    onEffectsChange(patch) {
      try {
        applyEffectsPatch(patch);
      } catch (err) {
        console.warn('[main] 应用特效变更失败:', err);
        showToast('特效设置失败：' + (err && err.message ? err.message : err));
      }
    },
    /** 导入根目录变更（区块选择/恢复默认后）→ 刷新模型列表（不写 localStorage） */
    onImportRootChanged() {
      refreshImportRoot().catch(() => { /* 刷新失败不阻断 UI */ });
    }
  });

  /**
   * 重新加载模型清单（内置 + 外部目录 + 导入根目录）并刷新设置面板列表。
   * 供设置面板在切换/清除「外部模型文件夹」、变更导入根目录后调用。
   * 注意：就地更新 catalog（保持引用），避免其它持有该数组引用的逻辑失效。
   * @returns {Promise<Array>} 重新加载后的归一化模型清单
   */
  async function refreshModelList() {
    const next = await loadCatalog();
    catalog.length = 0;
    catalog.push(...next);
    panel.setModels(catalog);
    return catalog;
  }

  /**
   * 刷新「已显示模型」区块与上限（面板未实现新接口时静默跳过，兼容旧面板）。
   * @returns {void}
   */
  function refreshInstanceUI() {
    try {
      if (!panel || typeof panel.setInstances !== 'function') return;
      const list = instanceStore ? instanceStore.list() : modelLoader.getInstances();
      const activeId = instanceStore ? instanceStore.activeId() : modelLoader.getActiveInstanceId();
      panel.setInstances(list, activeId);
      if (typeof panel.setInstanceLimit === 'function') panel.setInstanceLimit(INSTANCE_LIMIT);
    } catch (err) {
      console.warn('[main] 刷新实例区块失败:', err);
    }
  }

  // 让模块级函数（switchTo 等）也能刷新实例区块
  refreshInstancePanel = refreshInstanceUI;

  // 让模块级函数（switchTo 等）能在切换模型后立即落盘（含新 rawUrl）
  persistInstancesNow = () => {
    if (!instanceStore) return;
    try {
      instanceStore.persistNow();
    } catch (err) {
      console.warn('[main] 持久化实例失败:', err);
    }
  };

  // 首帧同步实例区块（面板创建后即显示 0/6 或恢复前状态）
  refreshInstanceUI();

  // 启动时收敛「氛围特效 ↔ 全屏下雨」互斥（特效优先），避免缓存里两者同时开启
  try {
    syncAmbienceExclusion();
  } catch (err) {
    console.warn('[main] 收敛氛围特效互斥失败:', err);
  }

  // —— 交互（视线跟随 / 拖拽 / 点击 / 穿透）——
  const interaction = createPetInteraction({
    app,
    modelLoader,
    bridge,
    isPointerOverUI: panel.isPointerOverUI,
    options: {
      // 滚轮缩放：持久化到本地并同步设置面板滑条，避免面板与滚轮状态不一致
      onScaleChange(percent) {
        storeNumber(LS.scale, percent);
        panel.setScaleValue(percent);
      },
      // 拖拽结束（或回弹收敛）：按实例回写位置（节流落盘由 instances store 负责，R3-4）
      onInstanceMoved(id, x, y) {
        if (!instanceStore) return;
        try {
          instanceStore.rememberPosition(id, x, y);
        } catch (err) {
          console.warn(`[main] 回写实例 ${id} 位置失败:`, err);
        }
      }
    }
  });
  interaction.attach();

  // 持久化的置顶状态恢复
  if (readStoredNumber(LS.alwaysOnTop, 1) === 1) {
    bridge.setAlwaysOnTop(true);
    panel.setAlwaysOnTopChecked(true);
  }

  // ---------------- 启动恢复：多实例优先，为空则回退单模型 ----------------
  /** @type {Array} 成功恢复的实例快照 */
  let restored = [];
  if (instanceStore) {
    try {
      restored = await instanceStore.restoreAll();
    } catch (err) {
      console.warn('[main] 恢复多实例失败，回退单模型:', err);
      restored = [];
    }
  }

  if (restored.length > 0) {
    // 多实例恢复成功 → 不再走单模型路径
    refreshInstanceUI();
    const activeId = instanceStore ? instanceStore.activeId() : modelLoader.getActiveInstanceId();
    const activeSnap = activeId ? modelLoader.getInstance(activeId) : null;
    if (activeSnap) {
      storeNumber(LS.modelUrl, activeSnap.url);
      try {
        panel.setCurrentModel(activeSnap.url, activeSnap.name, activeSnap.kind);
      } catch (err) {
        console.warn('[main] 同步活动实例到面板失败:', err);
      }
    }
    const summary = `已恢复 ${restored.length} 个模型实例`;
    try { panel.setStatus(summary); } catch (_) { /* 忽略 */ }
    showToast(summary);
  } else if (!initialTarget || !initialTarget.url) {
    try { panel.setStatus('未找到可用模型，请编辑 web/models/models.json'); } catch (_) { /* 忽略 */ }
    showToast('未找到可用模型，请检查 models/models.json');
  } else {
    // 单模型回退：优先「新增为实例」（可继续多实例/位置持久化），失败再退回纯加载
    try {
      panel.setStatus('正在加载模型…');
    } catch (_) { /* 忽略 */ }
    let loaded = null;
    if (instanceStore) {
      try {
        loaded = await instanceStore.addFromCatalog(
          initialTarget.url,
          initialTarget.meta || { name: initialTarget.url },
          initialTarget.rawUrl
        );
        refreshInstanceUI();
        storeNumber(LS.modelUrl, loaded.url);
        panel.setCurrentModel(loaded.url, loaded.name, loaded.kind);
        panel.setStatus(`已加载：${loaded.name}（${loaded.kind}）`);
      } catch (err) {
        console.warn('[main] 默认模型实例化失败，退回单模型加载:', err);
        loaded = null;
      }
    }
    if (!loaded) {
      try {
        // 实例化失败时的纯加载回退：同样带上原始路径，避免实例 rawUrl 退化为 asset://（R3-3 同源）
        const fallbackRawUrl = pickSwitchRawUrl(initialTarget.url, initialTarget.meta || null, initialTarget.url);
        const model = await modelLoader.loadModel(initialTarget.url, { rawUrl: fallbackRawUrl });
        storeNumber(LS.modelUrl, initialTarget.url);
        const meta = initialTarget.meta || {};
        const name = meta.name || describeModel(model);
        const kind = modelLoader.getModelKind();   // 运行时判定的 Cubism 版本
        panel.setCurrentModel(initialTarget.url, name, kind);
        panel.setStatus(`已加载：${name}（${kind}）`);
        refreshInstanceUI();
      } catch (err) {
        console.error(err);
        panel.setStatus('模型加载失败');
        showToast('模型加载失败：' + (err && err.message ? err.message : err));
      }
    }
  }

  // ---------------- 实例相关流程（供面板回调 / window.petApp 复用） ----------------

  /**
   * 「以新实例显示」：新增实例（不替换既有实例）。
   * 超限/加载失败 → 抛错（供 petApp.instances.add 透传 reject），同时给出可见提示。
   * @param {string} url 模型 URL（已解析或原始路径）
   * @param {object} [meta] 清单条目（取 name / rawUrl）
   * @returns {Promise<object>} 新实例快照
   */
  async function addInstanceFlow(url, meta) {
    if (!instanceStore) {
      showToast('当前环境不支持多模型实例');
      throw new Error('实例编排模块不可用');
    }
    const m = meta || {};
    const rawUrl = m.rawUrl || url;
    try {
      const snap = await instanceStore.addFromCatalog(url, m, rawUrl);
      refreshInstanceUI();
      try {
        panel.setCurrentModel(snap.url, snap.name, snap.kind);
        panel.setStatus(`已新增实例：${snap.name}`);
      } catch (err) {
        console.warn('[main] 更新设置面板失败:', err);
      }
      storeNumber(LS.modelUrl, snap.url);
      showToast(`已新增：${snap.name}`);
      return snap;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      // 「最多同时显示 6 个模型」由实例 store 统一提示，避免重复 toast
      if (!msg.includes('最多同时显示')) showToast('新增实例失败：' + msg);
      console.warn('[main] 新增实例失败:', err);
      throw err;
    }
  }

  /**
   * 移除实例（仅移除显示与状态，不删磁盘模型文件）。
   * @param {string} id
   * @returns {boolean} 是否成功
   */
  function removeInstanceFlow(id) {
    if (!instanceStore) return false;
    try {
      const ok = instanceStore.remove(id);
      if (!ok) return false;
      refreshInstanceUI();
      // 面板同步失败不应被误判为「移除失败」（实例已实际移除）
      try {
        const activeId = instanceStore.activeId();
        const activeSnap = activeId ? modelLoader.getInstance(activeId) : null;
        if (activeSnap) {
          panel.setCurrentModel(activeSnap.url, activeSnap.name, activeSnap.kind);
          storeNumber(LS.modelUrl, activeSnap.url);
        } else {
          panel.setStatus('已从窗口移除全部模型实例');
        }
      } catch (err) {
        console.warn('[main] 移除实例后同步面板失败:', err);
      }
      showToast('已从窗口移除（不删除模型文件）');
      return true;
    } catch (err) {
      console.warn('[main] 移除实例失败:', err);
      showToast('移除实例失败：' + (err && err.message ? err.message : err));
      return false;
    }
  }

  /**
   * 选中实例（设为活动实例；不影响其它实例）。
   * @param {string} id
   * @returns {boolean} 是否成功
   */
  function selectInstanceFlow(id) {
    if (!instanceStore) return false;
    try {
      const ok = instanceStore.select(id);
      if (!ok) return false;
      refreshInstanceUI();
      try {
        const snap = modelLoader.getInstance(id);
        if (snap) {
          panel.setCurrentModel(snap.url, snap.name, snap.kind);
          storeNumber(LS.modelUrl, snap.url);
        }
      } catch (err) {
        console.warn('[main] 选中实例后同步面板失败:', err);
      }
      return true;
    } catch (err) {
      console.warn('[main] 选中实例失败:', err);
      return false;
    }
  }

  // ---------------- 导入根目录（数据真源：后端 config.json） ----------------

  /**
   * 读取当前导入根目录（未设置/外壳不支持 → null）。
   * 只读：**不写** localStorage（R2-1 的数据真源约束）。
   * @returns {Promise<string|null>}
   */
  async function readImportRoot() {
    try {
      if (!bridge || typeof bridge.getImportRoot !== 'function') return null;
      const value = await bridge.getImportRoot();
      return typeof value === 'string' && value.trim() ? value : null;
    } catch (err) {
      console.warn('[main] 读取导入根目录失败:', err);
      return null;
    }
  }

  /**
   * 重新读取导入根目录并刷新模型列表（导入根目录变化后新模型需出现在列表中，R2-4）。
   * @returns {Promise<string|null>} 当前导入根目录
   */
  async function refreshImportRoot() {
    const value = await readImportRoot();
    try {
      await refreshModelList();
    } catch (err) {
      console.warn('[main] 导入根目录变更后刷新模型列表失败:', err);
    }
    return value;
  }

  // ---------------- 对外暴露（便于外壳/调试/自动化自测） ----------------
  // 注意：必须在 applyInteractiveMode 之前赋值，后者会通过 window.petApp 访问交互控制器。
  window.petApp = {
    app,
    modelLoader,
    bridge,
    panel,
    interaction,
    switchModel: (url) => switchTo(url, null, true),
    getModels: () => catalog.slice(),
    /**
     * 追加/合并模型到当前清单，并同步刷新设置面板列表（导入成功后调用）。
     * 同 URL 视为同一模型：以新信息覆盖旧条目，避免列表重复。
     * @returns {object|null} 归一化后的模型对象
     */
    appendModel(raw) {
      const [normalized] = normalizeList([raw], 'imported');
      if (!normalized) return null;
      const idx = catalog.findIndex((m) => m.url === normalized.url);
      if (idx >= 0) catalog[idx] = { ...catalog[idx], ...normalized };
      else catalog.push(normalized);
      panel.setModels(catalog, normalized.url);
      return normalized;
    },
    /** 导入模型流程（暴露便于外壳/自动化调用） */
    importModel: importModelFlow,
    /** 删除模型流程（暴露便于外壳/自动化调用） */
    deleteModel: deleteModelFlow,
    /** 重新加载模型清单（内置 + 外部 + 导入根目录）并刷新面板（暴露便于外壳/自动化调用） */
    refreshModelList,

    // —— C-APP-SHELL@1 新增：实例 / 雨效 / 导入根目录（仅用于验收与控制台断言） ——
    instances: {
      /** 实例快照数组（按创建顺序） */
      list: () => (instanceStore ? instanceStore.list() : modelLoader.getInstances()),
      /** 活动实例 id */
      activeId: () => (instanceStore ? instanceStore.activeId() : modelLoader.getActiveInstanceId()),
      /**
       * 新增实例（等价「以新实例显示」）；超限 reject Error 并 toast。
       * @param {string} url
       * @param {object} [meta]
       */
      add: (url, meta) => addInstanceFlow(url, meta),
      /** 移除实例（不删磁盘） */
      remove: (id) => removeInstanceFlow(id),
      /** 选中实例 */
      select: (id) => selectInstanceFlow(id),
      /** 立即持久化实例列表与活动实例 */
      persist: () => {
        try {
          if (instanceStore) instanceStore.persistNow();
        } catch (err) {
          console.warn('[main] 持久化实例失败:', err);
        }
      }
    },
    rain: {
      /** 当前雨效配置 */
      config: () => getRainConfig(),
      /** 应用部分配置（返回合并后的完整配置，并持久化） */
      set: (patch) => applyRainPatch(patch),
      /** 只读运行态（验收用） */
      state: () => getRainState()
    },
    effects: {
      /** 当前氛围特效配置（{enabled, kind, color}） */
      config: () => getEffectsConfig(),
      /** 应用部分配置（{enabled?, kind?}；返回合并后的完整配置，并持久化） */
      set: (patch) => applyEffectsPatch(patch),
      /** 只读运行态（验收用） */
      state: () => getEffectsState()
    },
    importRoot: {
      /** 读取当前导入根目录（不写 localStorage） */
      get: () => readImportRoot(),
      /** 重新读取并刷新模型列表 */
      refresh: () => refreshImportRoot(),
      /**
       * 选择导入根目录（实际写入由后端 config.json 完成，前端不缓存）→ 刷新模型列表。
       * 供外壳/自动化调用；产品 UI 由 `ui/importRootPanel.js` 承担。
       * @returns {Promise<string|null>}
       */
      async pick() {
        if (!bridge || typeof bridge.pickImportRoot !== 'function') {
          throw new Error('当前外壳不支持设置导入根目录');
        }
        await bridge.pickImportRoot();
        return refreshImportRoot();
      },
      /**
       * 恢复默认导入落点（清空 importRoot）→ 刷新模型列表。
       * @returns {Promise<string|null>} 清空后恒为 null
       */
      async clear() {
        if (!bridge || typeof bridge.clearImportRoot !== 'function') {
          throw new Error('当前外壳不支持设置导入根目录');
        }
        await bridge.clearImportRoot();
        return refreshImportRoot();
      }
    },

    showToast
  };

  // —— 穿透初始状态 ——
  // Electron（mousemove 转发）/ Tauri（光标轮询）：均默认进入穿透态，交互层在悬停命中时开启可点。
  // 其它外壳（浏览器等）不具备悬停探测能力：改为常驻可点。
  applyInteractiveMode(interaction.isAutoPenetration());

  // —— 窗口尺寸变化：重新适配所有实例 + 重建雨滴 ——
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      try {
        if (typeof modelLoader.refreshFitAll === 'function') {
          modelLoader.refreshFitAll({ preservePosition: true });
        } else {
          // 旧版 modelLoader（无多实例 API）降级路径
          modelLoader.refreshFit({ preservePosition: true });
        }
      } catch (err) {
        console.warn('[main] 重新适配模型失败:', err);
      }
      if (rainReady && rain && typeof rain.resizeRain === 'function') {
        try {
          rain.resizeRain();
        } catch (err) {
          console.warn('[main] 重建雨滴失败:', err);
        }
      }
      if (effectsReady && effects && typeof effects.resizeEffects === 'function') {
        try {
          effects.resizeEffects();
        } catch (err) {
          console.warn('[main] 重建特效粒子失败:', err);
        }
      }
    });
  });

  // —— 退出前：实例位置立即落盘 + 雨效资源清理（停止绘制/音频/清画布） ——
  window.addEventListener('beforeunload', () => {
    try {
      if (instanceStore) instanceStore.persistNow();
    } catch (err) {
      console.warn('[main] 退出前持久化实例失败:', err);
    }
    if (rain && typeof rain.destroyRain === 'function') {
      try {
        rain.destroyRain();
      } catch (err) {
        console.warn('[main] 退出前清理雨效失败:', err);
      }
    }
    if (effects && typeof effects.destroyEffects === 'function') {
      try {
        effects.destroyEffects();
      } catch (err) {
        console.warn('[main] 退出前清理氛围特效失败:', err);
      }
    }
  });

  console.info(
    `[DesktopPetWeb] 渲染前端就绪 · runtime=${bridge.runtime} · 模型数=${catalog.length}` +
    ` · 实例数=${instanceStore ? instanceStore.list().length : modelLoader.getInstances().length}` +
    ` · 雨效=${rainReady ? (rainConfig.enabled ? rainConfig.level : 'off') : 'unavailable'}` +
    ` · 特效=${effectsReady ? (effectsConfig.enabled && effectsConfig.kind !== 'none' ? effectsConfig.kind : 'off') : 'unavailable'}`
  );
}

function describeModel(model) {
  try {
    const settings = (model && model.internalModel && model.internalModel.settings) || {};
    return settings.name || '未命名模型';
  } catch (_) {
    return '未命名模型';
  }
}

/**
 * 切换模型并更新 UI / 持久化。
 *
 * 语义（C-MODEL-INSTANCES@1）：`loadModel()` 在已有实例时**替换活动实例的模型**——
 * 因此本函数保持既有「点击列表=切换」心智，同时保留活动实例的位置与 id。
 *
 * @param {string} url 模型 URL（原始或已解析）
 * @param {object|null} modelMeta 清单条目（取 name）
 * @param {boolean} fromExternal 为 true 时不弹「已切换」toast（由调用方统一提示）
 * @returns {Promise<string|null>} 解析后的模型 URL
 */
async function switchTo(url, modelMeta, fromExternal) {
  if (!url) return null;
  const resolved = resolveModelUrl(url);
  // R3-3：一并把目标模型的原始路径交给 modelLoader，替换活动实例时同步更新实例 rawUrl
  // （缺省/不可持久化 → undefined，由 modelLoader 保留旧值并告警）
  const rawUrl = pickSwitchRawUrl(url, modelMeta, resolved);
  await modelLoader.loadModel(resolved, { rawUrl });
  storeNumber(LS.modelUrl, resolved);
  // 切换成功后立即落盘：实例 rawUrl 已指向新模型，让重启恢复与新模型一致（R3-3）
  try {
    persistInstancesNow();
  } catch (err) {
    console.warn('[main] 切换模型后持久化实例失败:', err);
  }
  const meta = modelMeta || { name: resolved };
  const kind = modelLoader.getModelKind();   // 运行时判定的 Cubism 版本
  const panel = window.petApp && window.petApp.panel;
  if (panel) {
    try {
      panel.setCurrentModel(resolved, meta.name, kind);
      panel.setStatus(`已加载：${meta.name}（${kind}）`);
    } catch (err) {
      console.warn('[main] 更新设置面板失败:', err);
    }
  }
  // 实例区块：活动实例的模型（及运行时类型）已变化 → 同步显示
  refreshInstancePanel();
  if (!fromExternal) showToast(`已切换：${meta.name}（${kind}）`);
  return resolved;
}

/**
 * 通过外壳导入模型（Tauri：复制进 `importRoot ?? exe/models`；Electron：复制进内置 models/）。
 *  - 成功：把返回的 {id,name,url,type,source} 并入当前清单并刷新列表 → **替换活动实例的模型**
 *    （决策 D1）→ 提示成功；若实际目录名与显示名不同（同名副本 `lafei (2)`）额外提示「已保存为」；
 *  - 取消：提示「已取消导入」；
 *  - 失败：展示 error 信息；
 *  - 外壳不具备 importModel 能力：提示不支持（按钮侧亦不渲染）。
 *
 * 说明：bridge.importModel 对「用户取消」与「内部失败」均以 null 返回，
 * 因此 null 统一按「已取消导入」处理；若外壳将来改为抛错，则在此展示 error。
 *
 * @returns {Promise<{ok:boolean, reason?:string, model?:object, error?:Error}>}
 */
async function importModelFlow() {
  if (!bridge.capabilities.importModel) {
    showToast('当前外壳不支持导入');
    return { ok: false, reason: 'unsupported' };
  }

  let imported;
  try {
    imported = await bridge.importModel();
  } catch (err) {
    // 外壳在导入过程中抛出异常（选择器/拷贝/解析失败等）
    showToast('导入模型失败：' + (err && err.message ? err.message : err));
    return { ok: false, reason: 'error', error: err };
  }

  if (!imported || !imported.url) {
    // 用户取消（或外壳内部失败但未抛错）→ 明确提示取消
    showToast('已取消导入');
    return { ok: false, reason: 'cancelled' };
  }

  const [normalized] = normalizeList([imported], 'imported');
  if (!normalized) {
    showToast('导入的模型信息无效');
    return { ok: false, reason: 'invalid' };
  }

  // 1) 并入当前模型清单并刷新设置面板列表
  const app = window.petApp;
  if (app && typeof app.appendModel === 'function') {
    app.appendModel(normalized);
  } else if (app && app.panel) {
    app.panel.setModels([...app.getModels(), normalized], normalized.url);
  }

  // 2) 替换活动实例的模型（决策 D1）
  //    fromExternal=true 抑制 switchTo 自身的 toast，改由本流程统一给出「导入成功」提示
  await switchTo(normalized.url, normalized, true);

  // 3) 同名副本（实际目录名 ≠ 显示名）时明确告知落盘名
  const savedAs = (imported && imported.id && imported.name && imported.id !== imported.name)
    ? String(imported.id)
    : '';
  const statusText = `导入成功：${normalized.name}${savedAs ? `（已保存为 ${savedAs}）` : ''}`;
  if (app && app.panel) app.panel.setStatus(statusText);
  showToast(statusText);
  return { ok: true, model: normalized };
}

/**
 * 删除模型流程（Tauri：删除 exe 同级 models/<模型>，或导入根目录/外部根内模型目录）。
 * 前置：设置面板已做「二次确认」（两段式防误删）。
 *
 * 删除成功后：
 *   1) 重新加载清单（get_model_list 已不含该目录）→ 列表与磁盘一致；
 *   2) 若删除的是当前正加载的模型 → 切换到列表首个可用模型（无则提示）。
 *
 * @param {object} model 被删模型（{ id, name, url, source }）
 * @returns {Promise<{ok:boolean, reason?:string, error?:Error}>}
 */
async function deleteModelFlow(model) {
  if (!bridge.capabilities.deleteModel) {
    showToast('当前外壳不支持删除模型');
    return { ok: false, reason: 'unsupported' };
  }
  // 优先传「原始磁盘路径」（rawUrl）：Rust 侧据此解析模型目录。
  // 注意：绝不能用 resolveModelUrl 后的 url（Tauri 下已被转成 asset:// 协议地址，
  // Rust 侧无法定位磁盘目录 → 删除必然失败）。缺失时回退目录名 id / 原始 url。
  const key = model && (model.rawUrl || model.id || model.url);
  if (!key) {
    showToast('无法确定要删除的模型');
    return { ok: false, reason: 'invalid' };
  }

  let ok = false;
  try {
    ok = await bridge.deleteModel(key);
  } catch (err) {
    showToast('删除模型失败：' + (err && err.message ? err.message : err));
    return { ok: false, reason: 'error', error: err };
  }
  if (!ok) {
    showToast('删除模型失败（目录可能被占用或不允许删除）');
    return { ok: false, reason: 'failed' };
  }

  const app = window.petApp;

  // 1) 重新加载清单（catalog 就地更新，被删模型不再出现）
  if (app && typeof app.refreshModelList === 'function') {
    try { await app.refreshModelList(); } catch (err) { console.warn('[main] 删除后刷新清单失败:', err); }
  }

  // 2) 若删除的是当前加载模型 → 切换到首个可用模型
  const stored = readStoredRaw(LS.modelUrl) || '';
  if (model.url && stored === model.url) {
    const list = (app && typeof app.getModels === 'function') ? app.getModels() : [];
    const next = list[0];
    if (next && next.url) {
      try {
        await switchTo(next.url, next, true);
      } catch (err) {
        console.warn('[main] 删除后切换模型失败:', err);
      }
    } else if (app && app.panel) {
      app.panel.setStatus('已删除模型，当前无可用模型');
    }
  }

  showToast(`已删除模型：${model.name || key}`);
  return { ok: true };
}

/** 应用「自动穿透 / 常驻可点」模式 */
function applyInteractiveMode(auto) {
  const interaction = window.petApp && window.petApp.interaction;
  // Electron 经 mousemove 转发、Tauri 经光标轮询，均支持「悬停自动穿透」
  const supported = !!(bridge.canForwardMouseMove || bridge.canPollCursor);

  if (auto && supported) {
    if (interaction) interaction.setAutoPenetration(true);
    // 初始进入穿透态；随后由（Electron）mousemove 或（Tauri）光标轮询命中时开启可点
    bridge.setInteractive(false);
  } else {
    if (interaction) interaction.setAutoPenetration(false);
    // 常驻可点（外壳不具备悬停探测能力时的安全默认）
    bridge.setInteractive(true);
  }
}

// ---------------- 引导 ----------------

start().catch((err) => {
  console.error('[DesktopPetWeb] 启动失败:', err);
  showToast('启动失败：' + (err && err.message ? err.message : err));
  const status = document.getElementById('boot-status');
  if (status) {
    status.textContent = '桌宠前端启动失败：' + (err && err.message ? err.message : err);
    status.classList.remove('hidden');
    status.classList.add('error');
  }
});