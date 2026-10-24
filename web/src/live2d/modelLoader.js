/**
 * modelLoader.js —— Live2D 模型加载 / 切换 / 适配
 *
 * 关键点：
 *  - 统一的入口是 PIXI.live2d.Live2DModel.from(url)，插件会依据
 *    .model.json（Cubism 2.1 / .moc）与 .model3.json（Cubism 3/4 / .moc3）
 *    自动识别并选择对应运行时（要求 live2d.min.js 与 live2dcubismcore.min.js 均已就绪）。
 *  - 对外暴露：loadModel / currentModel / getModelOptions，另有 switchModel、fitToWindow 等。
 *  - 表情/动作组 API（供设置面板）：getExpressionNames / selectExpression / nextExpression /
 *    getExpressionIndex、getPoseNames / selectPose / nextPose / getPoseIndex。
 *    注意：pixi-live2d-display 无 Cubism "pose3 互斥组" 直接 API，故「姿势(动作)」按
 *    「动作组(motion groups, 如 Idle/Tap)」呈现。
 *  - 点击反应：reactTap()（可见表情（含扫描发现 exp3）→ Tap 动作组 → 非嘴部参数反应 → 缩放兜底）。
 *  - 目录资源补齐：加载前经 bridge.scanModelResources 发现「目录里存在但入口清单未声明」的
 *    *.motion3.json / *.exp3.json / *.pose3.json，注入 ModelSettings 后再创建模型（见 buildInjectedSettings）。
 *  - 待机降频：关闭 pld 内置自动待机，改由本模块按 idleIntervalMs（3~6s）驱动播放（见 setupIdleScheduler）。
 */

import { bridge } from '../bridge.js';

/** 默认加载与适配参数（可外部覆盖） */
const DEFAULT_OPTIONS = {
  // —— 加载选项 ——
  autoUpdate: true,       // 由插件 Ticker 驱动逐帧更新（含待机动作/自动眨眼）
  autoInteract: false,    // 关闭插件内置命中事件，改由 petInteraction 精确控制
  idleMotionGroup: '',    // 空 = 使用插件默认（Cubism2: 'idle'，Cubism4: 'Idle'）

  // —— 待机节奏（降速降频，解决「待机动画太快、太频繁」）——
  idleIntervalMs: 4000,   // 每次待机播放后，间隔多久再播下一次（限制在 3000~6000ms）
  idleSpeed: 0.5,         // 目标播放速度；本工程 pld 构建无 motion speed API，仅记录，实际由间隔降频

  // —— 适配选项 ——
  anchor: { x: 0.5, y: 1.0 },        // 模型内部锚点：底部居中
  screenAnchor: { x: 0.5, y: 1.0 },  // 模型锚点在屏幕上的落点比例（底部居中）
  heightRatio: 0.9,                  // 基准：模型高度占用窗口高度比例
  widthRatio: 1.0,                   // 基准：模型宽度占用窗口宽度比例
  minScale: 0.05,
  maxScale: 20,
  scalePercent: 100,                 // 用户缩放（百分比）
  alpha: 1,                          // 用户透明度 0~1
  bottomMarginPx: 0                  // 距窗口底部像素（越大越靠上）

  // —— 点击/拖拽候选动作组（供 petInteraction 使用）——
  // tapMotionGroups: ['Tap', 'tap_body', 'tap_head', 'flick_head', 'shake']
};

/** 模块内部状态 */
const state = {
  app: null,          // PIXI.Application
  model: null,        // 当前 Live2DModel
  lastModelKind: '未知', // 最近一次加载模型的 Cubism 版本（运行时判定）
  options: { ...DEFAULT_OPTIONS, tapMotionGroups: ['Tap', 'tap_body', 'tap_head', 'flick_head', 'shake'] },
  loading: null,      // 正在进行的加载 Promise（防并发切换竞态）
  expressionIndex: -1, // 当前已选表情索引（0 基；-1 = 未选/无）
  poseIndex: -1,        // 当前已选动作组索引（0 基；-1 = 未选/无）
  lastPlayedExpr: -1,   // 最近一次点击反应播放的表情索引（用于避免连点重复同一表情）
  reactionUntil: 0,     // 点击反应锁截止时间戳（重入保护；reactTap 与待机调度共用）
  idle: null,           // 待机调度状态 { idleGroup, interval, speed, playCount }
  idleTick: null        // 待机调度在 app.ticker 上的回调引用（用于停用）
};

/** 关闭 pld 内置自动待机时，给 motionManager.groups.idle 填的「不存在的组名」 */
const IDLE_DISABLED_GROUP = '__idle_disabled__';

/** 点击反应锁时长（ms）：反应进行中忽略新的点击，避免叠加/嘴部残留 */
const REACTION_LOCK_MS = 1200;

/** 取 PIXI.live2d 命名空间（可能为 null） */
function getLive2dFactory() {
  return (typeof window !== 'undefined' && window.PIXI && window.PIXI.live2d) || null;
}

/** 高精度时间戳（无 performance 时退回 Date.now） */
function perfNow() {
  return (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
}

/** 取统一桥（模块单例；测试/独立使用时回退到 window.petApp.bridge） */
function getBridge() {
  if (bridge && typeof bridge.scanModelResources === 'function') return bridge;
  if (typeof window !== 'undefined' && window.petApp && window.petApp.bridge) return window.petApp.bridge;
  return null;
}

function getPixi() {
  const pixi = typeof window !== 'undefined' ? window.PIXI : null;
  if (!pixi) throw new Error('PIXI 未加载，请先引入 pixi.js 与 pixi-live2d-display。');
  return pixi;
}

function getLive2DModelClass() {
  const pixi = getPixi();
  const cls = pixi.live2d && pixi.live2d.Live2DModel;
  if (!cls) throw new Error('PIXI.live2d.Live2DModel 不可用（pixi-live2d-display 未加载？）');
  return cls;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 绑定渲染应用。必须在加载模型前调用一次。
 * @param {object} app PIXI.Application 实例
 * @param {object} [options] 覆盖默认选项
 */
function init(app, options) {
  if (!app) throw new Error('modelLoader.init 需要一个 PIXI.Application 实例');
  state.app = app;
  if (options) configure(options);
}

/** 合并配置项（可热调） */
function configure(patch) {
  if (!patch) return getModelOptions();
  state.options = { ...state.options, ...patch };
  return getModelOptions();
}

/** 返回当前配置的浅拷贝 */
function getModelOptions() {
  const o = state.options;
  return {
    ...o,
    anchor: { ...o.anchor },
    screenAnchor: { ...o.screenAnchor },
    tapMotionGroups: Array.isArray(o.tapMotionGroups) ? o.tapMotionGroups.slice() : []
  };
}

/** 返回当前模型实例（可能为 null） */
function currentModel() {
  return state.model;
}

/** 销毁并移除当前模型 */
function destroyCurrentModel() {
  const model = state.model;
  stopIdleScheduler();
  state.reactionUntil = 0;
  if (!model) return;

  // 先停止逐帧更新：避免销毁瞬间仍被 Ticker 驱动 update/draw
  // （否则 Cubism 核心会抛出 "call update() before draw()" 类告警）
  try { model.autoUpdate = false; } catch (_) { /* 忽略 */ }

  try {
    if (state.app && state.app.stage && model.parent === state.app.stage) {
      state.app.stage.removeChild(model);
    }
  } catch (err) {
    console.warn('[modelLoader] 移除旧模型失败:', err);
  }
  try {
    model.destroy({ children: true, texture: false, baseTexture: false });
  } catch (err) {
    console.warn('[modelLoader] 销毁旧模型失败:', err);
  }
  state.model = null;
  state.lastModelKind = '未知';
  state.expressionIndex = -1;
  state.poseIndex = -1;
  state.lastPlayedExpr = -1;

}

/**
 * 把模型按窗口尺寸缩放并锚定（默认底部居中）。
 * @param {{ preservePosition?: boolean }} [opts]
 *        preservePosition = true 时不重置 x/y（拖拽后自适应窗口时用）
 */
function fitToWindow(opts = {}) {
  const model = state.model;
  const app = state.app;
  if (!model || !app) return;

  const screen = app.renderer.screen;
  const W = Math.max(1, screen.width);
  const H = Math.max(1, screen.height);
  const o = state.options;

  // 先复位缩放，读取模型基准尺寸
  model.scale.set(1);

  // 基准尺寸来源：
  //  - 定义了 hit areas 的模型（内置 shizuku/haru）：沿用「整块画布」尺寸（既有已验收行为）；
  //  - 无 hit areas 的模型（导入的 lafei_4/重音/樱花miku）：改用「绘制内容包围盒」，
  //    因其实测内容超出声明画布（如 樱花miku 内容 388x786 vs 画布 306x778）→ 按画布适配会偏大/裁切。
  const useContent = !modelHasHitAreas(model);
  let content = null;
  if (useContent) {
    try { content = getContentBounds(model, true); } catch (_) { content = null; }
  }

  let baseW = 1;
  let baseH = 1;
  if (content && content.width > 0 && content.height > 0) {
    baseW = Math.max(1, content.width);
    baseH = Math.max(1, content.height);
  } else {
    try {
      const bounds = model.getBounds();
      baseW = Math.max(1, bounds.width);
      baseH = Math.max(1, bounds.height);
    } catch (err) {
      console.warn('[modelLoader] 读取模型尺寸失败，退回内部画布尺寸:', err);
      const im = model.internalModel || {};
      baseW = Math.max(1, im.width || 1);
      baseH = Math.max(1, im.height || 1);
    }
  }

  const targetW = W * o.widthRatio;
  const targetH = H * o.heightRatio;
  // 以「完整可见」为准取较小缩放，避免超出窗口
  let scale = Math.min(targetW / baseW, targetH / baseH);
  scale = clamp(scale, o.minScale, o.maxScale);
  scale *= o.scalePercent / 100;
  model.scale.set(scale);

  if (!opts.preservePosition) {
    if (content && content.width > 0 && content.height > 0) {
      // 以「内容」而非「画布」定锚：内容中心对齐 screenAnchor.x，内容底边对齐窗口底部（留 bottomMargin）
      // （content 在 scale=1 时测得，偏移量随缩放等比放大）
      const offsetCx = (content.x + content.width / 2) - model.x;
      const offsetBottom = (content.y + content.height) - model.y;
      model.x = W * o.screenAnchor.x - offsetCx * scale;
      model.y = (H * o.screenAnchor.y - o.bottomMarginPx) - offsetBottom * scale;
    } else {
      model.x = W * o.screenAnchor.x;
      model.y = H * o.screenAnchor.y - o.bottomMarginPx;
    }
  } else {
    // 保留位置，但夹取到窗口内，避免缩放/窗口变化后人物跑出屏幕
    model.x = clamp(model.x, 0, W);
    model.y = clamp(model.y, 0, H);
  }

  // 缩放/位置改变 → 内容包围盒缓存失效，强制下次重算
  try { contentBoundsCache.delete(model); } catch (_) { /* 忽略 */ }

  model.alpha = o.alpha;
}

/**
 * 设置透明度（0~1）。
 * @param {number} alpha
 */
function setAlpha(alpha) {
  state.options.alpha = clamp(Number(alpha), 0, 1);
  if (state.model) state.model.alpha = state.options.alpha;
}

/**
 * 设置缩放百分比（相对基准自适应尺寸）。
 * @param {number} percent 50~300 常用
 */
function setScalePercent(percent) {
  state.options.scalePercent = clamp(Number(percent) || 0, 1, 1000);
  fitToWindow({ preservePosition: false });
}

/** 读取当前缩放百分比（供滚轮缩放等增量调节使用） */
function getScalePercent() {
  return Number(state.options.scalePercent) || 0;
}

/**
 * 加载模型（自动识别 Cubism 2 / Cubism 4）。
 * @param {string} url 模型清单地址（.model.json 或 .model3.json，也可为对象 URL）
 * @param {object} [loadOptions] 覆盖本次加载的插件选项
 * @returns {Promise<object>} Live2DModel
 */
function loadModel(url, loadOptions) {
  if (!url) return Promise.reject(new Error('loadModel 需要模型 URL'));

  // 串行化：避免快速切换时的竞态
  const task = (state.loading || Promise.resolve())
    .catch(() => { /* 忽略上一次失败，继续本次加载 */ })
    .then(() => doLoad(url, loadOptions));

  state.loading = task.catch(() => { /* 仅用于队列，不阻塞下一次 */ });
  return task;
}

async function doLoad(url, loadOptions) {
  const app = state.app;
  if (!app) throw new Error('请先调用 modelLoader.init(app)');
  const Live2DModel = getLive2DModelClass();
  const o = state.options;

  const modelOptions = {
    autoUpdate: o.autoUpdate,
    autoInteract: o.autoInteract,
    ...(loadOptions || {})
  };
  if (o.idleMotionGroup) modelOptions.idleMotionGroup = o.idleMotionGroup;

  // 先销毁旧模型，再加载新模型
  destroyCurrentModel();

  // ① 目录资源补齐：先扫描目录（外壳能力），再「先取 settings → 注入扫描结果 → 再创建模型」
  const scan = await scanResourcesSafe(url);

  let model = null;
  let injectedSettings = null;
  try {
    injectedSettings = await buildInjectedSettings(url, scan);
  } catch (err) {
    console.warn('[modelLoader] 构建注入 settings 失败，回退常规加载:', err);
    injectedSettings = null;
  }

  if (injectedSettings) {
    try {
      model = await Live2DModel.from(injectedSettings, modelOptions);
    } catch (err) {
      console.warn('[modelLoader] 以注入 settings 加载模型失败，回退常规加载:', err);
      model = null;
    }
  }

  if (!model) {
    try {
      model = await Live2DModel.from(url, modelOptions);
    } catch (err) {
      throw new Error(`模型加载失败：${url}\n${err && err.message ? err.message : err}`);
    }
    // 回退路径：加载后再把扫描结果补进既有 manager（pld 已在 from 后建好 manager）
    if (scan) applyDiscoveredToModel(model, scan);
  }

  // 应用锚点、加入舞台
  try {
    model.anchor.set(o.anchor.x, o.anchor.y);
  } catch (err) {
    console.warn('[modelLoader] 设置 anchor 失败（已忽略）:', err);
  }
  model.autoUpdate = o.autoUpdate;
  app.stage.addChild(model);

  state.model = model;

  // 未声明 Expressions 的 Cubism4 模型：由伴生 vtube.json 发现并挂载可用表情（声明/扫描优先，回退不阻断显示）
  await attachDiscoveredExpressions(model);

  // ② 待机降频：关闭 pld 内置自动待机，改由本模块按间隔驱动
  setupIdleScheduler(model);

  // 适配尺寸并应用透明度
  fitToWindow({ preservePosition: false });

  // 记录并按运行时类型判定 Cubism 版本（供日志与设置面板标注；不依赖清单字段猜测）
  state.lastModelKind = detectCubismKind(model);
  try {
    const internalModel = model.internalModel || {};
    const settings = internalModel.settings || {};
    console.info(
      `[modelLoader] 已加载模型 "${settings.name || url}"（${state.lastModelKind}）` +
      `，画布 ${internalModel.width || '?'}x${internalModel.height || '?'}`
    );
  } catch (_) { /* 仅日志，忽略 */ }

  return model;
}

// ---------------- ① 目录资源扫描 / 注入（补齐入口清单未声明的动作、表情、姿势） ----------------
//
// 背景：pixi-live2d-display 只依据 .model3.json（或 .model.json）里声明的 Motions/Expressions
// 建 motionManager/expressionManager；目录里存在但未被清单引用的 *.motion3.json / *.exp3.json
// 永远取不到（实测 lafei_4 / feiniu 等）。渲染进程在 file:// 下无法枚举目录，故由外壳主进程
// 扫描（bridge.scanModelResources）回传「相对模型目录」的资源路径。
//
// 做法（实测可行）：先自行取入口 JSON → 依运行时构造 ModelSettings → 把扫描到的资源注入
// settings.motions / settings.expressions / settings.pose → 再 Live2DModel.from(settings)。
// 这样 MotionManager/ExpressionManager 在建 manager 时就已包含全部资源（无需事后重建）。

/**
 * 安全获取扫描结果。
 * 外壳未提供该能力 / 入参失败 → 返回 null（调用方据此跳过补齐，不阻断模型显示）。
 * @param {string} url 模型入口 URL
 * @returns {Promise<{ok:true,motions:string[],expressions:string[],poses:string[],modelDirRel:string}|null>}
 */
async function scanResourcesSafe(url) {
  try {
    const b = getBridge();
    if (!b || typeof b.scanModelResources !== 'function') return null;
    const res = await b.scanModelResources(url);
    if (res && res.ok) return res;
    if (res && res.ok === false) console.info('[modelLoader] 目录扫描未命中:', res.error);
    return null;
  } catch (err) {
    console.warn('[modelLoader] 目录扫描失败（忽略，不阻断模型显示）:', err);
    return null;
  }
}

/**
 * 取模型入口 JSON（先 fetch，失败再退回 XMLHttpRequest —— 后者与 pld 内部取法一致，兼容 file://）。
 * @param {string} url
 * @returns {Promise<object|null>}
 */
async function loadModelJson(url) {
  if (typeof fetch === 'function') {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res && res.ok) return await res.json();
    } catch (_) { /* 退回 XHR */ }
  }
  if (typeof XMLHttpRequest === 'undefined') return null;
  return new Promise((resolve) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'text';
      xhr.onload = () => {
        if ((xhr.status === 200 || xhr.status === 0) && xhr.responseText) {
          try { resolve(JSON.parse(xhr.responseText)); } catch (_) { resolve(null); }
        } else resolve(null);
      };
      xhr.onerror = () => resolve(null);
      xhr.send();
    } catch (_) { resolve(null); }
  });
}

/** 归一化相对路径：反斜杠转正斜杠，去掉开头的 './' */
function normalizeRelPath(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/** 取「文件名（去扩展名）」，作为组名 / 表情名 */
function fileBaseName(rel, extRe) {
  const file = normalizeRelPath(rel).split('/').pop() || '';
  return file.replace(extRe, '');
}

/**
 * 判定 ModelSettings 是否为 Cubism 4（决定 motions/expressions 的字段大小写：File/Name 与 file/name）。
 * 优先运行时类型判定，其次字段探测，最后按入口 URL 后缀兜底。
 */
function isCubism4Settings(settings) {
  const L = getLive2dFactory();
  try {
    if (L) {
      if (typeof L.Cubism4ModelSettings === 'function' && settings instanceof L.Cubism4ModelSettings) return true;
      if (typeof L.Cubism2ModelSettings === 'function' && settings instanceof L.Cubism2ModelSettings) return false;
    }
    const motions = settings.motions || {};
    for (const g of Object.keys(motions)) {
      const arr = motions[g];
      if (Array.isArray(arr) && arr[0]) return ('File' in arr[0]) || ('Name' in arr[0]);
    }
    if (Array.isArray(settings.expressions) && settings.expressions[0]) return 'Name' in settings.expressions[0];
  } catch (_) { /* 忽略 */ }
  return /\.model3\.json(\?|#|$)/i.test(String(settings.url || ''));
}

/**
 * 把扫描结果注入 ModelSettings。
 * 规则：
 *  - 动作：为每个扫描文件建一个「以文件名（去扩展）命名的组」（每组 1 个动作），
 *    便于设置面板列出「目录内全部动作」按名选择；与既有声明组名冲突则保留声明。
 *  - 表情：追加声明中尚未包含（按文件路径去重）的 exp3，Name 取文件名（去扩展）。
 *  - 姿势：settings.pose 为空时取扫描到的第一个 pose3。
 * @returns {{motions:number, expressions:number, pose:number}} 各维度新增数量
 */
function injectDiscoveredResources(settings, scan, isC4) {
  const result = { motions: 0, expressions: 0, pose: 0 };
  if (!settings || !scan) return result;

  const motionKey = isC4 ? 'File' : 'file';
  const exprNameKey = isC4 ? 'Name' : 'name';
  const exprFileKey = isC4 ? 'File' : 'file';

  // —— 动作 ——
  if (!settings.motions || typeof settings.motions !== 'object') settings.motions = {};
  const motions = settings.motions;
  for (const rel of (Array.isArray(scan.motions) ? scan.motions : [])) {
    const group = fileBaseName(rel, /\.motion3\.json$/i);
    if (!group) continue;
    if (Object.prototype.hasOwnProperty.call(motions, group)) continue; // 组名冲突 → 保留原声明
    motions[group] = [isC4 ? { File: normalizeRelPath(rel) } : { file: normalizeRelPath(rel) }];
    result.motions += 1;
  }

  // —— 表情 ——
  if (!Array.isArray(settings.expressions)) settings.expressions = [];
  const seen = new Set();
  for (const e of settings.expressions) {
    seen.add(normalizeRelPath(e && (e[exprFileKey] || e.File || e.file)));
  }
  for (const rel of (Array.isArray(scan.expressions) ? scan.expressions : [])) {
    const relNorm = normalizeRelPath(rel);
    if (seen.has(relNorm)) continue;
    const name = fileBaseName(rel, /\.(exp3|exp)\.json$/i) || relNorm;
    settings.expressions.push(isC4 ? { Name: name, File: relNorm } : { name, file: relNorm });
    seen.add(relNorm);
    result.expressions += 1;
  }

  // —— 姿势 ——
  if (!settings.pose && Array.isArray(scan.poses) && scan.poses.length) {
    settings.pose = normalizeRelPath(scan.poses[0]);
    result.pose += 1;
  }

  return result;
}

/**
 * 「先取 settings → 注入扫描结果 → 再创建模型」：构造带补齐资源的 ModelSettings。
 * 扫描为空 / 取 JSON 失败 / 无法构造 → 返回 null（调用方回退常规 from(url) 加载）。
 * @param {string} url 模型入口 URL
 * @param {object|null} scan 扫描结果
 * @returns {Promise<object|null>} ModelSettings 实例（可传给 Live2DModel.from）
 */
async function buildInjectedSettings(url, scan) {
  if (!scan) return null;
  const L = getLive2dFactory();
  const json = await loadModelJson(url);
  if (!json || typeof json !== 'object') return null;
  json.url = url; // ModelSettings 构造函数要求 url 为字符串，且相对资源据此解析

  let settings = null;
  const factory = L && L.Live2DFactory;
  if (factory && typeof factory.findRuntime === 'function' && typeof factory.findRuntime(json) === 'object') {
    const runtime = factory.findRuntime(json);
    if (runtime && typeof runtime.createModelSettings === 'function') settings = runtime.createModelSettings(json);
  }
  if (!settings && L) {
    // 依入口后缀兜底构造（findRuntime 不可用时）
    if (/\.model3\.json(\?|#|$)/i.test(url) && typeof L.Cubism4ModelSettings === 'function') {
      settings = new L.Cubism4ModelSettings(json);
    } else if (/\.model\.json(\?|#|$)/i.test(url) && typeof L.Cubism2ModelSettings === 'function') {
      settings = new L.Cubism2ModelSettings(json);
    }
  }
  if (!settings) return null;

  const isC4 = isCubism4Settings(settings);
  const added = injectDiscoveredResources(settings, scan, isC4);
  console.info(
    `[modelLoader] 目录资源补齐：动作 +${added.motions}，表情 +${added.expressions}，姿势 +${added.pose}` +
    `（扫描：动作 ${(scan.motions || []).length} / 表情 ${(scan.expressions || []).length} / 姿势 ${(scan.poses || []).length}）`
  );
  return settings;
}

/**
 * 回退路径：pld 已在 from(url) 之后建好 manager，此时把扫描结果补进既有实例。
 *  - 动作：注入 settings.motions 后调用 motionManager.setupMotions 重建 motionGroups；
 *  - 表情：注入 settings.expressions 后重建 expressionManager。
 */
function applyDiscoveredToModel(model, scan) {
  try {
    const internalModel = model && model.internalModel;
    if (!internalModel || !scan) return;
    const settings = internalModel.settings || {};
    const isC4 = isCubism4Settings(settings);
    const added = injectDiscoveredResources(settings, scan, isC4);

    const mm = internalModel.motionManager;
    if (mm && added.motions > 0 && typeof mm.setupMotions === 'function') {
      try { mm.setupMotions({ motionPreload: 'NONE' }); } catch (err) {
        console.warn('[modelLoader] 重建 motionGroups 失败:', err);
      }
    }
    if (mm && added.expressions > 0) rebuildExpressionManager(model, isC4);
    if (added.motions || added.expressions || added.pose) {
      console.info(`[modelLoader] 后置补齐：动作 +${added.motions}，表情 +${added.expressions}，姿势 +${added.pose}`);
    }
  } catch (err) {
    console.warn('[modelLoader] 后置补齐资源失败（忽略）:', err);
  }
}

/** 依据 settings.expressions 重建表情管理器（新增表情后用） */
function rebuildExpressionManager(model, isC4) {
  const L = getLive2dFactory();
  if (!L) return false;
  const internalModel = model && model.internalModel;
  const mm = internalModel && internalModel.motionManager;
  const settings = internalModel && internalModel.settings;
  if (!mm || !settings || !Array.isArray(settings.expressions) || !settings.expressions.length) return false;
  const Cls = isC4 ? L.Cubism4ExpressionManager : L.Cubism2ExpressionManager;
  if (typeof Cls !== 'function') return false;
  try {
    mm.expressionManager = new Cls(settings, mm);
    return true;
  } catch (err) {
    console.warn('[modelLoader] 重建表情管理器失败:', err);
    return false;
  }
}

/**
 * 判定模型的 Cubism 版本 —— 以「真实运行时对象类型」为准。
 *
 * 为什么不能靠清单字段猜测：Cubism 2 代的清单（.model.json）里同样存在真值字段
 * `moc`（如 "shizuku.moc"），若把 `settings.moc` 当作 Cubism 3/4 的判据，2 代模型会被误判为 3/4 代。
 *
 * 依据：pixi-live2d-display 为 2 代 / 4 代分别实例化 `Cubism2InternalModel` / `Cubism4InternalModel`
 * （`dist/index.js` 中 `exports2.Cubism2InternalModel`、`exports2.Cubism4InternalModel` 均已导出），
 * 因此可从 `PIXI.live2d` 取到构造器做 instanceof 判定；压缩构建下"属性名"保留，instanceof 依然可靠。
 *
 * @param {object} model Live2DModel 实例
 * @returns {'Cubism 2.1'|'Cubism 4'|'未知'}
 */
function detectCubismKind(model) {
  try {
    const internalModel = model && model.internalModel;
    if (!internalModel) return '未知';

    const live2d = (typeof window !== 'undefined' && window.PIXI && window.PIXI.live2d) || null;

    if (live2d) {
      // 首选：内部模型（InternalModel）实例判定
      if (typeof live2d.Cubism2InternalModel === 'function' && internalModel instanceof live2d.Cubism2InternalModel) {
        return 'Cubism 2.1';
      }
      if (typeof live2d.Cubism4InternalModel === 'function' && internalModel instanceof live2d.Cubism4InternalModel) {
        return 'Cubism 4';
      }
      // 次选：模型设置（ModelSettings）实例判定
      const settings = internalModel.settings;
      if (settings) {
        if (typeof live2d.Cubism2ModelSettings === 'function' && settings instanceof live2d.Cubism2ModelSettings) {
          return 'Cubism 2.1';
        }
        if (typeof live2d.Cubism4ModelSettings === 'function' && settings instanceof live2d.Cubism4ModelSettings) {
          return 'Cubism 4';
        }
      }
    }

    // 兜底：构造器名（仅未压缩构建下有效，压缩构建类名可能被改写）
    const ctorName = internalModel.constructor && internalModel.constructor.name;
    if (ctorName === 'Cubism2InternalModel') return 'Cubism 2.1';
    if (ctorName === 'Cubism4InternalModel') return 'Cubism 4';
  } catch (err) {
    console.warn('[modelLoader] 判定 Cubism 版本失败:', err);
  }
  return '未知';
}

/**
 * 返回当前模型运行时判定的 Cubism 版本（供日志 / 设置面板标注使用）。
 * @returns {'Cubism 2.1'|'Cubism 4'|'未知'}
 */
function getModelKind() {
  return state.model ? detectCubismKind(state.model) : (state.lastModelKind || '未知');
}

/**
 * 切换模型（loadModel 的语义别名，便于设置面板调用）。
 * @param {string} url
 */
function switchModel(url) {
  return loadModel(url);
}

/**
 * 只读运行时调试状态（供实机验证 / 排障；不改变行为）。
 * @returns {{kind:string, idle:{idleGroup:string|null, interval:number, speed:number, playCount:number}|null,
 *   reactionUntil:number, expressionIndex:number, poseIndex:number, idleAutoDisabled:boolean}}
 */
function getDebugState() {
  const mm = state.model && state.model.internalModel && state.model.internalModel.motionManager;
  return {
    kind: getModelKind(),
    idle: state.idle ? { ...state.idle } : null,
    reactionUntil: state.reactionUntil,
    expressionIndex: state.expressionIndex,
    poseIndex: state.poseIndex,
    idleAutoDisabled: !!(mm && mm.groups && mm.groups.idle === IDLE_DISABLED_GROUP)
  };
}

/** 重新适配当前模型（窗口 resize 时调用） */
function refreshFit(opts) {
  fitToWindow(opts);
}

/** 卸载当前模型 */
function unloadModel() {
  destroyCurrentModel();
}

// ---------------- 命中区域：hit areas 优先，无则用「绘制内容包围盒」 ----------------
//
// 说明（实机取证结论）：
//  - `model.getBounds()` 返回的是「整块画布」矩形（Cubism 的 width×height），并非人物实际范围，
//    对画布留白大的模型会让可交互区明显偏大 / 偏移（用户反馈「可交互矩形明显偏大/偏移」）；
//  - 模型作者在清单中定义的 hit areas（`model.hitTest` 内部即基于它）最贴合轮廓，优先使用；
//  - 但部分模型（实测导入的 lafei_4 / 重音 / 樱花miku）**完全没有 HitAreas**，`model.hitTest`
//    恒返回 []，只能用「实际绘制内容包围盒」（所有 drawable 顶点并集）作为退化的可点矩形。
//
// 内容包围盒实现：遍历所有 drawable 的 `internalModel.getDrawableBounds(i)`（局部坐标并集），
// 再经 `internalModel.localTransform` → `model.worldTransform` 映射到屏幕坐标（同 model.hitTest
// 的坐标链，保证与渲染一致）。Cubism2/4 均有该基类方法（实测 shizuku 131 / haru 84 / lafei 327 /
// 重音 513 / miku 490 个 drawable 均可取到包围盒）。

/** 内容包围盒缓存：model -> { local, global, at }（TTL 防止每帧全量重算） */
const contentBoundsCache = new WeakMap();
const CONTENT_BOUNDS_TTL_MS = 250;

/** 解析模型定义的 hit areas 数量（数组或对象形式） */
function getHitAreaCount(model) {
  try {
    const settings = (model && model.internalModel && model.internalModel.settings) || {};
    const hitAreas = settings.hitAreas;
    if (Array.isArray(hitAreas)) return hitAreas.length;
    if (hitAreas && typeof hitAreas === 'object') return Object.keys(hitAreas).length;
  } catch (_) { /* 忽略 */ }
  return 0;
}

/** 模型是否定义了 hit areas（作者声明的交互区域） */
function modelHasHitAreas(model) {
  return getHitAreaCount(model) > 0;
}

/** 取模型的 drawable 数量（Cubism4：core.getDrawableCount；Cubism2：internalModel.getDrawableIDs） */
function getDrawableCountOf(model) {
  const im = (model && model.internalModel) || {};
  const core = im.coreModel;
  try { if (core && typeof core.getDrawableCount === 'function') return core.getDrawableCount(); } catch (_) { /* 忽略 */ }
  try {
    if (typeof im.getDrawableIDs === 'function') {
      const ids = im.getDrawableIDs();
      if (ids && typeof ids.length === 'number') return ids.length;
    }
  } catch (_) { /* 忽略 */ }
  return 0;
}

/** 计算模型「绘制内容」在内部模型局部坐标系的包围盒（所有 drawable 顶点并集） */
function computeLocalContentBounds(model) {
  const im = (model && model.internalModel) || {};
  if (typeof im.getDrawableBounds !== 'function') return null;
  const count = getDrawableCountOf(model);
  if (count <= 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const out = { x: 0, y: 0, width: 0, height: 0 };
  for (let i = 0; i < count; i += 1) {
    let b;
    try { b = im.getDrawableBounds(i, out); } catch (_) { continue; }
    if (!b) continue;
    if (!isFinite(b.x) || !isFinite(b.y) || !isFinite(b.width) || !isFinite(b.height)) continue;
    if (b.width <= 0 && b.height <= 0) continue;
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    const rx = b.x + b.width;
    const ry = b.y + b.height;
    if (rx > maxX) maxX = rx;
    if (ry > maxY) maxY = ry;
  }
  if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 模型「绘制内容」在屏幕（stage 全局）坐标系的包围盒。
 *
 * 坐标链与 `model.hitTest` 一致：全局 = model.worldTransform * internalModel.localTransform * 局部点。
 * 结果带 TTL 缓存（默认 250ms），避免 mousemove 高频调用时每帧全量遍历 drawable。
 *
 * @param {object} [model] 模型实例（默认当前模型）
 * @param {boolean} [force] 强制忽略缓存重算
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
function getContentBounds(model, force) {
  const m = model || state.model;
  if (!m) return null;

  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  let entry = contentBoundsCache.get(m);
  if (force || !entry || !entry.global || (now - entry.at) > CONTENT_BOUNDS_TTL_MS) {
    // 关键：force（适配时）需先刷新世界变换，否则可能读到「上一次的 scale/位置」（PIXI 懒更新）
    if (force) {
      try {
        if (typeof m._recursivePostUpdateTransform === 'function') m._recursivePostUpdateTransform();
        if (m.parent && typeof m.displayObjectUpdateTransform === 'function') m.displayObjectUpdateTransform();
      } catch (_) { /* 忽略 */ }
    }
    const im = m.internalModel || {};
    const lt = im.localTransform;
    const wt = m.worldTransform;
    if (!lt || !wt) return entry && entry.global ? entry.global : null;

    const local = computeLocalContentBounds(m);
    if (!local) return entry && entry.global ? entry.global : null;
    // 局部 → 全局：先 localTransform 再 worldTransform（取四角以兼容旋转/斜切）
    const toGlobal = (lx, ly) => {
      const px = lt.a * lx + lt.c * ly + lt.tx;
      const py = lt.b * lx + lt.d * ly + lt.ty;
      return { x: wt.a * px + wt.c * py + wt.tx, y: wt.b * px + wt.d * py + wt.ty };
    };
    const corners = [
      toGlobal(local.x, local.y),
      toGlobal(local.x + local.width, local.y),
      toGlobal(local.x, local.y + local.height),
      toGlobal(local.x + local.width, local.y + local.height)
    ];
    let gx1 = Infinity; let gy1 = Infinity; let gx2 = -Infinity; let gy2 = -Infinity;
    for (const c of corners) {
      if (c.x < gx1) gx1 = c.x;
      if (c.y < gy1) gy1 = c.y;
      if (c.x > gx2) gx2 = c.x;
      if (c.y > gy2) gy2 = c.y;
    }
    entry = { local, global: { x: gx1, y: gy1, width: gx2 - gx1, height: gy2 - gy1 }, at: now };
    contentBoundsCache.set(m, entry);
  }
  return entry.global;
}

// ---------------- 表情 / 动作组（"姿势"语义说明） ----------------
//
// 语义说明：pixi-live2d-display 并未暴露 Cubism 的 "pose3 互斥组" 直接 API，
// 因此本模块把「姿势(动作)」按「动作组(motion groups)」呈现——即
// model.internalModel.motionManager.definitions 的各组名（如 Idle / Tap / TapBody ...）。
// selectPose/nextPose 播放对应组内的随机动作。若模型未定义动作组则列表为空、选择返回 false。

function isThenable(v) {
  return v && typeof v.then === 'function';
}

/**
 * 取当前模型的「表情管理器」。
 *
 * 重要：pixi-live2d-display 的 Cubism2/Cubism4 内部模型把表情管理器挂在
 * **motionManager.expressionManager** 上（而不是 internalModel.expressionManager）。
 * 之前只读 internalModel.expressionManager → 恒为 undefined → 只能靠 settings 兜底；
 * 此处两者都尝试，优先运动管理器上的实例（其 definitions 顺序与 expression(index) 一致）。
 */
function getExpressionManager(model) {
  const internalModel = (model && model.internalModel) || {};
  const motionManager = internalModel.motionManager;
  return (motionManager && motionManager.expressionManager) || internalModel.expressionManager || null;
}

/**
 * 由模型清单 URL 派生「同目录伴生清单」URL（把 `<name>.model3.json` 换成 `<name>.<suffix>`）。
 * @param {string} url 模型清单 URL（可为相对 / 绝对）
 * @param {string} suffix 伴生文件后缀（如 'vtube.json'）
 * @returns {string|null}
 */
function deriveSiblingUrl(url, suffix) {
  const s = String(url || '');
  if (!/\.model3\.json(\?|#|$)/i.test(s)) return null;
  return s.replace(/\.model3\.json(\?|#|$)/i, `.${suffix}$1`);
}

/**
 * 【未声明资源回退】为「未声明 Expressions」的 Cubism4 模型发现并挂载可用表情。
 *
 * 背景：导入的模型（实测 重音 / 樱花miku）`model3.json` 只声明 Moc/Textures/Physics/DisplayInfo，
 * 目录里确有 `*.exp3.json` 却未被清单引用 → 界面「无表情」、点击无表情可用。
 *
 * 为什么不是「扫描目录」：本工程渲染进程运行在 Electron file:// 沙箱（contextIsolation=true /
 * nodeIntegration=false），**无法枚举目录**（实测 fetch/XHR/iframe 访问 `models/<id>/` 目录 URL 均失败：
 * `ERR_FILE_NOT_FOUND` / `Failed to fetch`）。故改用等效的「由清单文件名派生的伴生清单发现」：
 *   VTube Studio 导出的模型会在**同目录**保留 `<name>.vtube.json`，其中 `Hotkeys[].{Name,File}`
 *   完整记录了 `*.exp3.json` 列表 → 由此得到声明缺失的表情文件（相对路径喂入既有表情管理器）。
 *
 * 实现：写入 `settings.expressions`（定义数组），并按 pixi-live2d-display 的构造约定
 * `new Cubism4ExpressionManager(settings, motionManager)` 创建表情管理器挂到 `motionManager`，
 * 之后 `getExpressionNames / model.expression(i) / reactTap` 全部可直接使用（懒加载）。
 *
 * @param {object} model Live2DModel
 * @returns {Promise<number>} 新挂载的表情数量（0 = 无回退）
 */
async function attachDiscoveredExpressions(model) {
  try {
    const internalModel = model && model.internalModel;
    if (!internalModel) return 0;
    if (detectCubismKind(model) !== 'Cubism 4') return 0; // 该回退仅面向 Cubism4（.exp3.json）

    const settings = internalModel.settings || {};
    const motionManager = internalModel.motionManager || null;

    // 清单已声明表情（或已存在表情管理器）→ 不介入，保持「声明优先」
    if (motionManager && motionManager.expressionManager) return 0;
    if (Array.isArray(settings.expressions) && settings.expressions.length) return 0;

    const vtubeUrl = deriveSiblingUrl(settings.url, 'vtube.json');
    if (!vtubeUrl || typeof fetch !== 'function') return 0;

    let defs = [];
    try {
      const res = await fetch(vtubeUrl, { cache: 'no-store' });
      if (!res || !res.ok) return 0;
      const json = await res.json();
      const hotkeys = Array.isArray(json && json.Hotkeys) ? json.Hotkeys : [];
      defs = hotkeys
        .filter((h) => h && typeof h.File === 'string' && /\.exp3\.json$/i.test(h.File))
        .map((h) => ({ Name: String(h.Name || h.File.replace(/\.exp3\.json$/i, '')), File: h.File }));
    } catch (err) {
      console.warn('[modelLoader] 读取伴生 vtube.json 失败（忽略，不阻断模型显示）:', err);
      return 0;
    }
    if (!defs.length) return 0;

    // 去重 + 稳定排序，保证表情索引跨机器一致（与经验库「扫描回退需显式排序」一致）
    const seen = new Set();
    defs = defs.filter((d) => {
      if (seen.has(d.File)) return false;
      seen.add(d.File);
      return true;
    }).sort((a, b) => a.File.localeCompare(b.File));

    const Factory = (typeof window !== 'undefined' && window.PIXI && window.PIXI.live2d) || null;
    const ExpressionManagerClass = Factory && Factory.Cubism4ExpressionManager;
    if (typeof ExpressionManagerClass !== 'function') return 0;

    settings.expressions = defs;
    const em = new ExpressionManagerClass(settings, motionManager);
    if (motionManager) motionManager.expressionManager = em;

    console.info(`[modelLoader] 未声明表情回退：由伴生 vtube.json 发现并挂载 ${defs.length} 个表情（${defs.map((d) => d.Name).join(' / ')}）`);
    return defs.length;
  } catch (err) {
    console.warn('[modelLoader] 挂载未声明表情失败（忽略）:', err);
    return 0;
  }
}

/** 从 definitions（Map / 数组 / 普通对象）解析出名字列表；无法解析返回 null */
function collectNamesFromDefinitions(defs) {
  if (!defs) return null;

  // Map<name, def>
  if (defs instanceof Map) {
    if (defs.size === 0) return null;
    return Array.from(defs.keys()).map((k) => String(k));
  }

  // 数组（Cubism4 的 definitions 常为 ExpressionDefinition[]）
  if (Array.isArray(defs)) {
    if (defs.length === 0) return null;
    return defs.map((d, i) => {
      if (typeof d === 'string') return d;
      return (d && (d.Name || d.name || d.File || d.file)) || `Expression${i}`;
    });
  }

  // 普通对象：数字索引（数组式）取值内 Name；否则直接取键
  if (typeof defs === 'object') {
    const keys = Object.keys(defs);
    if (keys.length === 0) return null;
    const indexed = keys.every((k) => /^\d+$/.test(k));
    if (indexed) {
      return keys.map((k) => {
        const d = defs[k];
        if (typeof d === 'string') return d;
        return (d && (d.Name || d.name)) || `Expression${k}`;
      });
    }
    return keys.slice();
  }

  return null;
}

/** 当前模型可用表情名（0 基索引与 definitions / settings.expressions 顺序一致）；无则 [] */
function getExpressionNames() {
  const model = state.model;
  if (!model) return [];
  try {
    const internalModel = model.internalModel || {};
    const manager = getExpressionManager(model);
    if (manager) {
      // 首选运行时的 definitions（顺序与 expression(index) 的索引一致）
      const fromDefs = collectNamesFromDefinitions(manager.definitions);
      if (fromDefs && fromDefs.length) return fromDefs;
    }
    // 兜底：模型清单中的 expressions 数组
    const settings = internalModel.settings || {};
    if (Array.isArray(settings.expressions)) {
      return settings.expressions.map((e, i) => (e && (e.Name || e.name)) || `Expression${i}`);
    }
  } catch (err) {
    console.warn('[modelLoader] 读取表情列表失败:', err);
  }
  return [];
}

/**
 * 选择第 index 个表情（0 基）。
 * @returns {boolean} 越界 / 无表情 / 播放失败 → false
 */
function selectExpression(index) {
  const model = state.model;
  if (!model) return false;
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0) return false;
  const names = getExpressionNames();
  if (i >= names.length) return false;
  try {
    let ok;
    if (typeof model.expression === 'function') {
      ok = model.expression(i);            // pixi-live2d-display 支持按索引选择
    } else if (typeof model.setExpression === 'function') {
      ok = model.setExpression(names[i]);
    }
    if (isThenable(ok)) ok = true;         // 异步实现视为已下发
    if (ok) state.expressionIndex = i;
    return !!ok;
  } catch (err) {
    console.warn('[modelLoader] 选择表情失败:', err);
    return false;
  }
}

/** 轮换到下一个表情（循环）；无表情 → false */
function nextExpression() {
  const names = getExpressionNames();
  if (!names.length) return false;
  const next = (state.expressionIndex + 1) % names.length; // 初始 -1 → 0
  return selectExpression(next);
}

/** 当前表情索引（无则 -1） */
function getExpressionIndex() {
  if (!state.model) return -1;
  const names = getExpressionNames();
  if (!names.length) return -1;
  return (state.expressionIndex >= 0 && state.expressionIndex < names.length) ? state.expressionIndex : -1;
}

/** 以「动作组」呈现的姿势名列表（motionManager.definitions 组名）；无则 [] */
function getPoseNames() {
  const model = state.model;
  if (!model) return [];
  try {
    const manager = model.internalModel && model.internalModel.motionManager;
    const defs = manager && manager.definitions;
    if (defs instanceof Map) return Array.from(defs.keys());
    if (defs && typeof defs === 'object') return Object.keys(defs);
  } catch (err) {
    console.warn('[modelLoader] 读取动作组列表失败:', err);
  }
  return [];
}

/**
 * 播放第 index 个动作组（0 基）。
 * @returns {boolean} 越界 / 无动作组 / 播放失败 → false
 */
function selectPose(index) {
  const model = state.model;
  if (!model) return false;
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0) return false;
  const names = getPoseNames();
  if (i >= names.length) return false;
  const group = names[i];
  try {
    const manager = model.internalModel && model.internalModel.motionManager;
    let ok;
    if (manager && typeof manager.startRandomMotion === 'function') {
      // MotionPriority.NORMAL = 2；同步返回是否成功启动
      ok = manager.startRandomMotion(group, 2);
    } else if (typeof model.motion === 'function') {
      const r = model.motion(group);
      ok = isThenable(r) ? true : r;
    }
    if (ok) state.poseIndex = i;
    return !!ok;
  } catch (err) {
    console.warn('[modelLoader] 播放动作组失败:', err);
    return false;
  }
}

/** 轮换到下一个动作组（循环）；无动作组 → false */
function nextPose() {
  const names = getPoseNames();
  if (!names.length) return false;
  const next = (state.poseIndex + 1) % names.length; // 初始 -1 → 0
  return selectPose(next);
}

/** 当前动作组索引（无则 -1） */
function getPoseIndex() {
  if (!state.model) return -1;
  const names = getPoseNames();
  if (!names.length) return -1;
  return (state.poseIndex >= 0 && state.poseIndex < names.length) ? state.poseIndex : -1;
}

// ---------------- ② 待机降频（解决「待机动画太快、太频繁」） ----------------
//
// 现象：pld 的 MotionManager 在当前动作结束后会「立即」请求下一个 idle 动作
//（update 中 `state.shouldRequestIdleMotion() && startRandomMotion(groups.idle, IDLE)`），
// 若 idle 动作较短便形成高频循环，观感「太快、太频繁」。
//
// 做法：
//  1) 把 motionManager.groups.idle 指到一个不存在的组名，关闭 pld 内置自动待机；
//  2) 由本模块在 app.ticker 上按 idleIntervalMs（3~6s）驱动「播一次 → 等待 → 再播」；
//  3) 交互动作（NORMAL=2）进行中或点击反应锁定期内一律让位，不抢占；
//  4) 本工程 pld 构建无 motion speed API，idleSpeed 仅记录（实际降频由间隔控制）。

/** idle 间隔限制在 3000~6000ms（缺省 4000ms） */
function clampIdleInterval(ms) {
  const n = Number(ms);
  if (!isFinite(n)) return 4000;
  return Math.min(6000, Math.max(3000, n));
}

/** idle 目标速度限制在 0.1~2（缺省 0.5；仅记录用） */
function clampIdleSpeed(s) {
  const n = Number(s);
  if (!isFinite(n) || n <= 0) return 0.5;
  return Math.min(2, Math.max(0.1, n));
}

/** 动作组是否含「有效动作文件」（用于跳过 lafei_4 里 File:"" 的坏 Idle 组） */
function groupHasPlayableMotion(model, group) {
  try {
    const mm = model.internalModel && model.internalModel.motionManager;
    const defs = mm && mm.definitions && mm.definitions[group];
    if (!Array.isArray(defs) || !defs.length) return false;
    return defs.some((d) => d && String(d.File || d.file || '').trim() !== '');
  } catch (_) {
    return false;
  }
}

/** 选取可用的 idle 动作组名：优先名字含 idle 且含有效动作文件的组；无则 null */
function findIdleGroupName(model) {
  const names = getPoseNames().filter((n) => /idle/i.test(String(n)));
  for (const n of names) {
    if (groupHasPlayableMotion(model, n)) return n;
  }
  return null;
}

/** 停止待机调度（模型销毁 / 切换前调用） */
function stopIdleScheduler() {
  const app = state.app;
  if (state.idleTick && app && app.ticker && typeof app.ticker.remove === 'function') {
    try { app.ticker.remove(state.idleTick); } catch (_) { /* 忽略 */ }
  }
  state.idleTick = null;
  state.idle = null;
}

/**
 * 装配待机调度：关闭 pld 内置自动待机，改由本模块按 idleIntervalMs 驱动。
 * @param {object} model Live2DModel
 */
function setupIdleScheduler(model) {
  stopIdleScheduler();
  if (!model) return;
  const mm = model.internalModel && model.internalModel.motionManager;
  if (!mm) return;

  const idleGroup = findIdleGroupName(model);
  const interval = clampIdleInterval(state.options.idleIntervalMs);
  const speed = clampIdleSpeed(state.options.idleSpeed);
  state.idle = { idleGroup, interval, speed, playCount: 0 };

  const ticker = state.app && state.app.ticker;
  if (!idleGroup || !ticker || typeof ticker.add !== 'function') {
    console.info(
      `[modelLoader] 待机调度未启用（idle 组=${idleGroup || '无'}；Ticker=${!!ticker}）：` +
      '该模型无可播 idle 动作，保持现有行为'
    );
    return;
  }

  // 关闭 pld 内置自动待机：动作结束后不再「立刻」重播 idle
  try { mm.groups.idle = IDLE_DISABLED_GROUP; } catch (_) { /* 忽略 */ }

  let lastAt = null; // null = 尚未起算（从加载完成起计时，避免加载后立即播放）
  const step = () => {
    const now = perfNow();
    // 点击反应进行中：让位并顺延计时
    if (now < state.reactionUntil) { lastAt = now; return; }
    // 有动作正在播放（含交互动作）：让位并顺延计时（不与其他动作抢占）
    if (mm.playing === true) { lastAt = now; return; }
    if (lastAt == null) { lastAt = now; return; }
    if (now - lastAt < interval) return;
    lastAt = now;
    try {
      const started = mm.startRandomMotion(idleGroup, 1); // MotionPriority.IDLE = 1（不会抢占 NORMAL）
      if (isThenable(started) && typeof started.catch === 'function') started.catch(() => { /* 静默 */ });
      state.idle.playCount += 1;
    } catch (_) { /* 忽略 */ }
  };
  ticker.add(step);
  state.idleTick = step;

  console.info(
    `[modelLoader] 待机降频：组=${idleGroup}，间隔=${interval}ms，目标速度=${speed}` +
    '（本构建无 motion speed API，速度仅记录；实际由「播一次→等待间隔→再播」控制频率）'
  );
}

// ---------------- ④ 抑制视线跟随引发的「整体左右晃动」 ----------------
//
// 根因：petInteraction 每帧 model.focus(x,y) 会驱动 InternalModel.updateFocus() 把
// 「躯干」参数（Cubism4: ParamBodyAngleX/Z；Cubism2: PARAM_BODY_ANGLE_X/Z）以**加性**方式
// 加到核心参数上（`addParameterValueById` / `addToParamFloat`），且该帧末尾 `loadParam()`
// 会复原参数 → 若仅在 focus 之后「读值再写回」，会被下一帧复原而**实测无效**。
//
// 做法（实测有效）：包裹 `internalModel.updateFocus`，在原始实现之后、`coreModel.update()` 计算
// 绘制数据之前，把躯干参数就地缩放到 factor 倍（默认 ~0.25）。只动 body 参数、不动
// ParamAngleX/Y/Z 与眼球参数 → 不影响头部/视线跟随。

/** 取 Cubism4 核心模型的参数 ID 列表（权威判据；getParameterIndex 对不存在 ID 会误报） */
function getCubism4ParamIds(core) {
  try {
    const m = typeof core.getModel === 'function' ? core.getModel() : null;
    const ids = m && m.parameters && m.parameters.ids;
    return ids ? Array.from(ids) : null;
  } catch (_) {
    return null;
  }
}

/** 包裹标记：记录已安装的躯干抑制信息（避免每帧重复包裹） */
const BODY_DAMPING_KEY = '__petBodySwayDamping';

/** 就地缩放躯干参数（由包裹后的 updateFocus 每帧调用） */
function scaleBodyNow(core, info) {
  if (!core || !info) return;
  const k = info.factor;
  for (const id of info.body4) {
    try { core.setParameterValueById(id, (Number(core.getParameterValueById(id)) || 0) * k); } catch (_) { /* 忽略 */ }
  }
  for (const id of info.body2) {
    try { core.setParamFloat(id, (Number(core.getParamFloat(id)) || 0) * k); } catch (_) { /* 忽略 */ }
  }
}

/**
 * 安装「焦点躯干抑制」：包裹 internalModel.updateFocus（幂等，重复调用仅更新系数）。
 * @returns {boolean} 是否已安装（true 表示抑制生效）
 */
function installFocusBodyDamping(model, factor) {
  const m = model || state.model;
  const im = m && m.internalModel;
  if (!im || typeof im.updateFocus !== 'function') return false;
  const k = isFinite(Number(factor)) ? Math.min(1, Math.max(0, Number(factor))) : 0.25;

  const existing = im[BODY_DAMPING_KEY];
  if (existing) { existing.factor = k; return true; }

  const core = im.coreModel || {};
  const canC4 = typeof core.getParameterValueById === 'function' && typeof core.setParameterValueById === 'function';
  const canC2 = typeof core.getParamFloat === 'function' && typeof core.setParamFloat === 'function';
  const ids4 = canC4 ? getCubism4ParamIds(core) : null;
  const body4 = canC4 ? ['ParamBodyAngleX', 'ParamBodyAngleZ'].filter((id) => !ids4 || ids4.indexOf(id) >= 0) : [];
  const body2 = canC2 ? ['PARAM_BODY_ANGLE_X', 'PARAM_BODY_ANGLE_Z'] : [];
  if (!body4.length && !body2.length) return false;

  const info = { factor: k, body4, body2 };
  const orig = im.updateFocus.bind(im);
  im.updateFocus = function updateFocusWithBodyDamping() {
    const r = orig();
    scaleBodyNow(im.coreModel, info);
    return r;
  };
  im[BODY_DAMPING_KEY] = info;
  return true;
}

/**
 * 抑制视线跟随引起的整体左右晃动（由 petInteraction 每帧在 focus 后调用）。
 * 幂等：首次调用安装包裹，后续仅更新系数；若无法包裹 updateFocus 则退回「读值缩放写回」。
 * @param {object} [model] 模型实例（缺省当前模型）
 * @param {number} [factor=0.25] 缩放系数（0~1，越小越不晃）
 * @returns {boolean} 是否实际生效
 */
function suppressBodySway(model, factor = 0.25) {
  const m = model || state.model;
  if (!m) return false;
  if (installFocusBodyDamping(m, factor)) return true;

  // 退化路径：无法包裹 updateFocus（非标准内部模型）→ 直接对当前躯干参数缩放一次
  const core = (m.internalModel && m.internalModel.coreModel) || null;
  if (!core) return false;
  const k = isFinite(Number(factor)) ? Math.min(1, Math.max(0, Number(factor))) : 0.25;
  scaleBodyNow(core, {
    factor: k,
    body4: typeof core.getParameterValueById === 'function' ? ['ParamBodyAngleX', 'ParamBodyAngleZ'] : [],
    body2: typeof core.getParamFloat === 'function' ? ['PARAM_BODY_ANGLE_X', 'PARAM_BODY_ANGLE_Z'] : []
  });
  return true;
}

// ---------------- 点击反应（目标：每次点击都产生「肉眼可见」反馈） ----------------
//
// 用户反馈：点击对所有模型（内置 + 导入）都看不出效果。实测根因：
//  - 内置模型常落到「随机表情」并抽到中性表情（shizuku 首个 f01、haru 首个 f00）→ 视觉无变化；
//  - 导入模型（lafei_4 / 重音 / 樱花miku）未声明 Expressions/Motions，且动作组名不在候选列表
//    （lafei 的动作组是 `TapBody`，候选却是 `Tap/tap_body`）→ 几乎无可执行项；
//  - 旧 code 在 `model.expression()`（无参=随机表情）上即使「0 个表情」也会 resolve 为真 → 假成功。
//
// 故重排为「可见优先」的兜底链，并新增两层保证：
//   1) 可见动作组（组名模糊匹配 + 排除 idle）—— 实测 lafei 的 `TapBody` 由此可播；
//   2) 面部反应（脸红表情 / 参数驱动可见反应 / 参数脸红）—— 无动作模型的可见保证；
//   3) 随机「非中性、非贴图类」表情；
//   4) 缩放脉冲兜底 —— 即使核心无任何可用参数，也保证「点一下有反应」。
//
// 备注：本工程内置的 pixi-live2d-display 构建下，实测「表情」对导入模型可能不改变参数
//（表达式被下发但参数无变化），故「参数驱动的可见反应」作为表情/动作之后的一层兜底，
// 直接写核心参数并在 0.9s 内缓动复位，稳定可见。

/** 常见脸红参数名（依次探测） */
const BLUSH_PARAM_NAMES = ['ParamCheek', 'ParamBlush', 'ParamFaceRed', 'ParamCheekRed', 'ParamShy', 'ParamBlushLevel'];

/** 「贴图/水印/场景」类表情：视觉上近乎透明，随机时应跳过（如导入模型的「水印」） */
const SUBTLE_EXPRESSION_RE = /水印|watermark|logo|图标|场景|scene|背景|background/i;

/** 中性/默认表情名（跳过以免「点了像没点」） */
const NEUTRAL_EXPRESSION_RE = /^(default|normal|neutral|base|素体|ノーマル|通常)$/i;

/**

 * Cubism4 参数存在性判定 —— 直接查核心模型「参数 ID 数组」，避免 getParameterIndex 的误报。
 *
 * 实测（本工程 vendor/pixi-live2d-display.min.js 内置框架）：
 *   core.getParameterIndex(id) 对「不存在的 ID」并不会返回 -1（会返回一个越界/无效值），
 *   用它做存在性判据会误命中 → 之前「脸红参数」对不含该参数的花脸模型也会“成功”。
 * 而 core.getModel().parameters.ids 是权威的参数 ID 列表（普通 Array），可直接 indexOf。
 *
 * @param {object} core Cubism4 核心模型
 * @param {string} id 参数 ID
 * @returns {boolean}
 */
function cubism4HasParameter(core, id) {
  try {
    const model = typeof core.getModel === 'function' ? core.getModel() : null;
    const ids = model && model.parameters && model.parameters.ids;
    if (!ids) return false;
    return Array.prototype.indexOf.call(ids, id) >= 0;
  } catch (_) {
    return false;
  }
}


/** 归一化动作组名：小写 + 去除非字母数字（`TapBody`/`tap_body` → `tapbody`，用于模糊匹配） */
function normalizeGroupName(name) {
  return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * 从模型「已声明的动作组」中挑出最合适的可播组名。
 * 顺序：精确匹配候选 → 包含匹配候选 → 语义兜底（含 tap/touch/body/head… 且非 idle）。
 * @param {object} model
 * @param {string[]} candidates 候选组名（来自 tapMotionGroups）
 * @returns {string|null}
 */
function findMotionGroupName(model, candidates) {
  const groups = getPoseNames();
  if (!groups.length) return null;
  const normalized = groups.map((g) => ({ group: g, key: normalizeGroupName(g) }));

  for (const c of candidates) {
    const key = normalizeGroupName(c);
    if (!key) continue;
    const hit = normalized.find((x) => x.key === key);
    if (hit) return hit.group;
  }
  for (const c of candidates) {
    const key = normalizeGroupName(c);
    if (!key) continue;
    const hit = normalized.find((x) => x.key.includes(key));
    if (hit) return hit.group;
  }
  // 语义兜底：非 idle 的交互类动作组（TapBody / touch_head / flick_head …）
  const semantic = /tap|touch|body|head|flick|shake|pinch|special|click|flick/;
  const hit = normalized.find((x) => x.key !== 'idle' && semantic.test(x.key));
  return hit ? hit.group : null;
}

/**
 * 播放「可见动作组」。动作组名经模糊匹配；找不到可播组则返回 false。
 * @returns {Promise<boolean>}
 */
async function playVisibleMotion(model) {
  const candidates = Array.isArray(state.options.tapMotionGroups) && state.options.tapMotionGroups.length
    ? state.options.tapMotionGroups
    : ['Tap', 'tap_body', 'tap_head', 'flick_head', 'shake', 'TapBody'];
  const group = findMotionGroupName(model, candidates);
  if (!group) return false;
  try {
    const manager = model.internalModel && model.internalModel.motionManager;
    let started;
    if (manager && typeof manager.startRandomMotion === 'function') {
      // MotionPriority.NORMAL = 2；返回是否成功启动
      started = manager.startRandomMotion(group, 2);
    } else if (typeof model.motion === 'function') {
      started = model.motion(group);
    } else {
      return false;
    }
    if (isThenable(started)) started = await started;
    return !!started;
  } catch (_) {
    return false;
  }
}

/**
 * 挑选一个「非中性、非贴图类」的随机表情索引（无可用时退回任意非 0 索引）。
 * @param {number} [excludeIndex=-1] 需排除的索引（避免连点重复同一表情）
 * @returns {number} -1 = 无表情
 */
function pickRandomExpressionIndex(excludeIndex = -1) {
  const names = getExpressionNames();
  if (!names.length) return -1;
  const pool = [];
  names.forEach((name, i) => {
    if (i === 0) return; // 跳过首个（多为默认/中性）
    if (i === excludeIndex) return;
    const s = String(name);
    if (NEUTRAL_EXPRESSION_RE.test(s)) return;
    if (SUBTLE_EXPRESSION_RE.test(s)) return;
    pool.push(i);
  });
  if (!pool.length) {
    for (let i = 1; i < names.length; i += 1) {
      if (i !== excludeIndex) pool.push(i);
    }
  }
  if (!pool.length) pool.push(0);
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * 播放一个随机「可见」表情（含扫描发现的 exp3）。
 * 下发即视为已反应、异步失败静默；避免与上一次反应播放同一索引。
 * @returns {boolean}
 */
function playVisibleExpression(model) {
  const idx = pickRandomExpressionIndex(state.lastPlayedExpr);
  if (idx < 0) return false;
  try {
    let ok;
    if (typeof model.expression === 'function') ok = model.expression(idx);
    else if (typeof model.setExpression === 'function') ok = model.setExpression(getExpressionNames()[idx]);
    if (isThenable(ok)) {
      if (typeof ok.catch === 'function') ok.catch(() => { /* 加载失败静默 */ });
      ok = true;
    }
    if (!ok) return false;
    state.expressionIndex = idx;
    state.lastPlayedExpr = idx;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 参数驱动的「可见反应」（仅 Cubism4）：眼笑 / 脸颊(脸红) / 身体小幅摆动，
 * 先升到峰值再缓动回原值（约 0.9s）。仅在模型无可用表情/动作时作为兜底。
 *
 * ③ 关键变更：**不再写「张嘴」参数**（ParamMouthOpenY / ParamMouthForm），
 *    以修「对有 .vtube.json 的模型只会张嘴、双击不闭嘴」的问题——嘴部不再被本层驱动，
 *    自然回落到模型自身默认值，不会残留“张嘴”。
 *
 * 选参原则：避开「视线跟随（ParamAngleX/Y/Z、ParamEyeBallX/Y）」「眨眼（ParamEyeLOpen/ROpen）」
 * 与「嘴部（ParamMouth*）」，改用 ParamEyeLSmile/RSmile / ParamCheek / ParamBodyAngleZ
 * 这类不被 focus / 眨眼每帧覆盖的参数。
 *
 * @returns {boolean} 是否存在任意可用参数（true = 已下发反应）
 */
function playParameterReaction(model) {
  const core = model.internalModel && model.internalModel.coreModel;
  if (!core || typeof core.setParameterValueById !== 'function' || typeof core.getModel !== 'function') return false;

  const channels = [
    { ids: ['ParamEyeLSmile', 'ParamEyeRSmile'], peak: 1, key: 'eyeSmile' },
    { ids: BLUSH_PARAM_NAMES, peak: 1, key: 'cheek' },
    { ids: ['ParamBodyAngleZ'], peak: 6, key: 'bodyZ' }
  ];

  const active = [];
  for (const ch of channels) {
    const id = ch.ids.find((x) => cubism4HasParameter(core, x));
    if (!id) continue;
    let base = 0;
    try { base = Number(core.getParameterValueById(id)) || 0; } catch (_) { base = 0; }
    active.push({ id, peak: ch.peak, base });
  }
  if (!active.length) return false;

  const ticker = state.app && state.app.ticker;
  const apply = (k) => {
    for (const a of active) {
      try { core.setParameterValueById(a.id, a.base + (a.peak - a.base) * k); } catch (_) { /* 忽略 */ }
    }
  };
  // 无 Ticker：直接给一次峰值后立即复位（不可见也无副作用）
  if (!ticker || typeof ticker.add !== 'function') {
    apply(1);
    apply(0);
    return true;
  }

  const DUR_MS = 900;
  let elapsed = 0;
  const step = () => {
    try {
      const dt = typeof ticker.deltaMS === 'number' ? ticker.deltaMS : 16.6667;
      elapsed += dt;
      const p = Math.min(1, elapsed / DUR_MS);
      let k; // 0→1→0 的钟形曲线
      if (p < 0.25) k = p / 0.25;
      else if (p < 0.65) k = 1;
      else k = Math.max(0, (1 - p) / 0.35);
      // 身体摆动叠加一次左右摇摆，增强「动态感」
      const rock = 1 + Math.sin(p * Math.PI * 3) * 0.35;
      apply(k * (elapsed < DUR_MS * 0.65 ? rock : 1));
      if (p >= 1) {
        apply(0);
        ticker.remove(step);
      }
    } catch (_) {
      try { ticker.remove(step); } catch (_e) { /* 忽略 */ }
    }
  };
  ticker.add(step);
  return true;
}

/**
 * 最终兜底：缩放脉冲（约 0.36s「弹一下」），不依赖任何核心参数，保证「点一下有反应」。
 * 结束后复位到脉冲前的缩放，不影响用户缩放。
 * @returns {boolean}
 */
function playScaleBounce(model) {
  const ticker = state.app && state.app.ticker;
  const baseX = Number(model.scale && model.scale.x) || 1;
  const baseY = Number(model.scale && model.scale.y) || 1;
  if (!ticker || typeof ticker.add !== 'function') {
    try { model.scale.set(baseX * 1.05, baseY * 1.05); } catch (_) { /* 忽略 */ }
    return true;
  }
  const DUR_MS = 360;
  let elapsed = 0;
  const step = () => {
    try {
      const dt = typeof ticker.deltaMS === 'number' ? ticker.deltaMS : 16.6667;
      elapsed += dt;
      const p = Math.min(1, elapsed / DUR_MS);
      const k = p < 0.4 ? p / 0.4 : Math.max(0, (1 - p) / 0.6);
      const f = 1 + 0.06 * k;
      model.scale.set(baseX * f, baseY * f);
      if (p >= 1) {
        model.scale.set(baseX, baseY);
        ticker.remove(step);
      }
    } catch (_) {
      try { model.scale.set(baseX, baseY); ticker.remove(step); } catch (_e) { /* 忽略 */ }
    }
  };
  ticker.add(step);
  return true;
}

/**
 * 点击反应：按「可见优先级」尝试，保证「点一下有肉眼可见反应」。
 *
 * 顺序（③ 变更后）：
 *   1) 可见表情（含扫描发现的 exp3；优先、避免连点重复同一表情）；
 *   2) 可见动作组（Tap / touch / body / head… 模糊匹配 + 排除 idle）；
 *   3) 非嘴部参数反应（眼笑 / 脸颊 / 身体小幅摆动）——无表情无动作模型的可见保证；
 *   4) 缩放脉冲兜底（不依赖任何核心参数）。
 *
 * 重入保护：以 state.reactionUntil 为锁，反应进行中忽略新的点击（快速连点只触发一次），
 * 保证「不会残留张嘴、双击也能正确收尾」。全程 try/catch，不阻断眨眼/视线/待机。
 *
 * @returns {Promise<boolean>}
 */
async function reactTap() {
  const model = state.model;
  if (!model) return false;

  // 重入保护：反应进行中忽略新的点击（返回 true 表示「已在反应中」）
  const now = perfNow();
  if (now < state.reactionUntil) return true;
  state.reactionUntil = now + REACTION_LOCK_MS;

  // 1) 可见表情（含扫描发现的 exp3）
  try { if (playVisibleExpression(model)) return true; } catch (_) { /* 忽略 */ }

  // 2) 可见动作组（动态、可靠可见）
  try { if (await playVisibleMotion(model)) return true; } catch (_) { /* 忽略 */ }

  // 3) 非嘴部参数反应（直接写核心参数并在 0.9s 内缓动复位，稳定可见）
  try { if (playParameterReaction(model)) return true; } catch (_) { /* 忽略 */ }

  // 4) 缩放脉冲兜底（不依赖核心参数）
  try { if (playScaleBounce(model)) return true; } catch (_) { /* 忽略 */ }

  return false;
}

export {
  init,
  configure,
  loadModel,
  switchModel,
  currentModel,
  getModelKind,
  getDebugState,
  getModelOptions,
  fitToWindow,
  refreshFit,
  setAlpha,
  setScalePercent,
  getScalePercent,
  unloadModel,
  getExpressionNames,
  selectExpression,
  nextExpression,
  getExpressionIndex,
  getPoseNames,
  selectPose,
  nextPose,
  getPoseIndex,
  getContentBounds,
  modelHasHitAreas,
  suppressBodySway,
  reactTap
};

export default {
  init,
  configure,
  loadModel,
  switchModel,
  currentModel,
  getModelKind,
  getDebugState,
  getModelOptions,
  fitToWindow,
  refreshFit,
  setAlpha,
  setScalePercent,
  getScalePercent,
  unloadModel,
  getExpressionNames,
  selectExpression,
  nextExpression,
  getExpressionIndex,
  getPoseNames,
  selectPose,
  nextPose,
  getPoseIndex,
  getContentBounds,
  modelHasHitAreas,
  suppressBodySway,
  reactTap
};