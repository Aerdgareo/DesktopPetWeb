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
 *  - 多实例（C-MODEL-INSTANCES@1）：实例注册表 `instances(Map)` + 绘制顺序 `order` + `activeId`；
 *    `state.model` 是活动实例的 legacy 镜像（恒等于 instances.get(activeId)?.model）。
 *    位置 / 表情 / 姿势 / 点击反应 / 待机调度按实例隔离；缩放百分比与透明度为全局设置（逐实例执行）。
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

/** 实例数量上限（R3-1：同一窗口最多同时显示 6 个模型） */
const MAX_INSTANCES = 6;

/**
 * @typedef {Object} ModelInstance 模块内部实例记录（不对外暴露 model 对象）
 * @property {string} id          实例标识（"inst-1"…，由调用方单调分配）
 * @property {string} url         已解析的可加载 URL（asset:// 或相对/绝对路径）
 * @property {string} rawUrl      原始路径（供持久化使用，禁止 asset://）
 * @property {string} name        显示名
 * @property {string} kind        'Cubism 2.1' | 'Cubism 4' | '未知'
 * @property {object|null} model  Live2DModel
 * @property {number} exprIndex   该实例当前表情索引（-1 = 未选）
 * @property {number} poseIndex   该实例当前动作组索引（-1 = 未选）
 * @property {number} lastPlayedExpr 该实例最近一次点击反应播放的表情索引
 * @property {number} reactionUntil  该实例点击反应锁截止时间戳
 * @property {object|null} idle   该实例待机调度状态 { idleGroup, interval, speed, playCount }
 * @property {Function|null} idleTick 该实例待机调度在 app.ticker 上的回调引用
 */

/**
 * 模块内部状态（多实例注册表 + 活动实例镜像）。
 *
 * 不变式：`state.model` 恒等于 `instances.get(activeId)?.model`，
 * 任何改变活动实例的操作（setActiveInstance / addInstance 首个 / removeInstance 回退 /
 * loadModel 替换 / unloadAll）之后都必须调用 `syncLegacyMirror()` 同步。
 */
const state = {
  app: null,            // PIXI.Application
  instances: new Map(), // id -> ModelInstance
  order: [],            // 创建顺序的 id（= stage 子节点绘制顺序，后者在上层）
  activeId: null,       // 活动实例 id（无实例 → null）
  model: null,          // legacy 镜像：=== instances.get(activeId)?.model
  lastModelKind: '未知', // legacy 镜像：活动实例的 Cubism 版本（运行时判定）
  options: { ...DEFAULT_OPTIONS, tapMotionGroups: ['Tap', 'tap_body', 'tap_head', 'flick_head', 'shake'] },
  loading: null         // 全局串行加载队列（防并发切换竞态）
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

// ---------------- 实例注册表基础操作 ----------------

/** 归一化实例 id（非字符串/空白 → 空串） */
function normalizeInstanceId(id) {
  return (typeof id === 'string' && id.trim()) ? id.trim() : '';
}

/**
 * 由模型 URL 派生显示名（取文件名并去掉 .model.json / .model3.json 后缀）。
 * @param {string} url
 * @returns {string}
 */
function deriveNameFromUrl(url) {
  const s = String(url || '');
  const file = s.split(/[\\/]/).pop() || '';
  const name = file.replace(/\.model3?\.json(\?|#|$)/i, '');
  return name || 'model';
}

/** 当前活动实例（无 → null） */
function getActiveInstance() {
  const id = state.activeId;
  return id ? (state.instances.get(id) || null) : null;
}

/** 当前活动实例的 model（无 → null；兜底 state.model 以兼容单实例期） */
function getActiveModel() {
  const inst = getActiveInstance();
  if (inst && inst.model) return inst.model;
  return state.model || null;
}

/**
 * 同步 legacy 镜像：state.model / state.lastModelKind。
 * 必须在任何改变 activity（或活动实例的模型）的操作之后调用。
 */
function syncLegacyMirror() {
  const inst = state.activeId ? (state.instances.get(state.activeId) || null) : null;
  state.model = (inst && inst.model) ? inst.model : null;
  state.lastModelKind = (inst && inst.kind) ? inst.kind : '未知';
}

/** 按 order 重建 stage 绘制顺序（后加入者在上层；移除后不重排其余实例相对顺序） */
function applyStageOrder() {
  const app = state.app;
  if (!app || !app.stage || !Array.isArray(app.stage.children)) return;
  for (const id of state.order) {
    const inst = state.instances.get(id);
    const model = inst && inst.model;
    if (!model) continue;
    try {
      const idx = app.stage.children.indexOf(model);
      if (idx < 0) continue;
      const last = app.stage.children.length - 1;
      if (idx !== last) app.stage.setChildIndex(model, last);
    } catch (_) { /* 忽略 */ }
  }
}

/** 取窗口（渲染 screen）尺寸，取不到时回退 window.innerWidth/Height；下限 1 */
function getScreenSize() {
  const app = state.app;
  const screen = app && app.renderer && app.renderer.screen;
  if (screen && isFinite(screen.width) && isFinite(screen.height)) {
    return { W: Math.max(1, screen.width), H: Math.max(1, screen.height) };
  }
  const w = (typeof window !== 'undefined') ? Number(window.innerWidth) : NaN;
  const h = (typeof window !== 'undefined') ? Number(window.innerHeight) : NaN;
  return {
    W: Math.max(1, isFinite(w) ? w : 1),
    H: Math.max(1, isFinite(h) ? h : 1)
  };
}

/**
 * 销毁一个 Live2DModel 对象（移除 stage + destroy），不影响实例注册表。
 * @param {object|null} model
 * @param {object|null} [app]
 */
function destroyModelObject(model, app) {
  if (!model) return;
  // 先停止逐帧更新：避免销毁瞬间仍被 Ticker 驱动 update/draw
  // （否则 Cubism 核心会抛出 "call update() before draw()" 类告警）
  try { model.autoUpdate = false; } catch (_) { /* 忽略 */ }

  try {
    if (app && app.stage && model.parent === app.stage) app.stage.removeChild(model);
  } catch (err) {
    console.warn('[modelLoader] 移除模型失败:', err);
  }
  try {
    model.destroy({ children: true, texture: false, baseTexture: false });
  } catch (err) {
    console.warn('[modelLoader] 销毁模型失败:', err);
  }
  try { contentBoundsCache.delete(model); } catch (_) { /* 忽略 */ }
}

/**
 * 销毁实例的模型并停止其待机调度（不改变注册表）。
 * 只操作该实例自己的 tick，不影响其它实例的待机。
 * @param {ModelInstance|null} inst
 */
function destroyInstanceModel(inst) {
  if (!inst) return;
  stopIdleScheduler(inst);
  inst.reactionUntil = 0;
  const model = inst.model;
  inst.model = null;
  if (model) destroyModelObject(model, state.app);
}

/** 返回当前模型实例（活动实例；可能为 null） */
function currentModel() {
  return state.model;
}

/** 生成实例快照（不含 model 对象） */
function snapshotOf(inst) {
  if (!inst) return null;
  return {
    id: inst.id,
    url: inst.url,
    rawUrl: inst.rawUrl,
    name: inst.name,
    kind: inst.kind || '未知',
    x: inst.model ? (Number(inst.model.x) || 0) : 0,
    y: inst.model ? (Number(inst.model.y) || 0) : 0,
    active: state.activeId === inst.id
  };
}

/**
 * 把「某个实例」的模型按窗口尺寸缩放并锚定（默认底部居中）。
 * @param {ModelInstance} inst 实例记录
 * @param {{ preservePosition?: boolean }} [opts]
 *        preservePosition = true 时不重置 x/y（拖拽后自适应窗口时用）
 */
function fitInstanceToWindow(inst, opts = {}) {
  const model = inst && inst.model;
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
 * 对全部实例重排：窗口 resize / 全局缩放时调用（单个实例异常不影响其它实例）。
 * @param {{ preservePosition?: boolean }} [opts]
 */
function refreshFitAll(opts = {}) {
  for (const id of state.order.slice()) {
    const inst = state.instances.get(id);
    if (!inst || !inst.model) continue;
    try { fitInstanceToWindow(inst, opts); } catch (err) {
      console.warn('[modelLoader] 适配实例失败（忽略）:', id, err);
    }
  }
}

/**
 * 对指定实例重新适配。
 * @param {string} id 实例 id
 * @param {{ preservePosition?: boolean }} [opts]
 */
function fitInstance(id, opts = {}) {
  const inst = state.instances.get(normalizeInstanceId(id));
  if (!inst || !inst.model) return;
  fitInstanceToWindow(inst, opts);
}

/**
 * 把「所有」模型按窗口尺寸缩放并锚定（既有导出；多实例下等价 refreshFitAll）。
 * @param {{ preservePosition?: boolean }} [opts]
 *        preservePosition = true 时不重置 x/y（拖拽后自适应窗口时用）
 */
function fitToWindow(opts = {}) {
  refreshFitAll(opts);
}

/**
 * 设置透明度（0~1）。全局设置：对所有实例生效。
 * @param {number} alpha
 */
function setAlpha(alpha) {
  state.options.alpha = clamp(Number(alpha), 0, 1);
  for (const id of state.order.slice()) {
    const inst = state.instances.get(id);
    if (!inst || !inst.model) continue;
    try { inst.model.alpha = state.options.alpha; } catch (_) { /* 忽略 */ }
  }
  if (state.model) state.model.alpha = state.options.alpha;
}

/**
 * 对单个实例执行「缩放以可见中心为原点、不改变屏幕位置」的调整。
 * @param {ModelInstance} inst
 */
function applyScaleToInstance(inst) {
  const model = inst && inst.model;
  const app = state.app;
  if (!model) return;

  const s0 = model.scale ? model.scale.x : 1;
  const x0 = model.x;
  const y0 = model.y;
  let c0 = null;
  try { c0 = getContentBounds(model, true); } catch (_) { c0 = null; }

  fitInstanceToWindow(inst, { preservePosition: true }); // 设定新 scale（x/y 暂被夹取，随后我们按中心回推）

  if (c0 && c0.width > 0 && c0.height > 0 && s0 > 0) {
    const centerX0 = c0.x + c0.width / 2;
    const centerY0 = c0.y + c0.height / 2;
    const s1 = model.scale ? model.scale.x : s0;
    const cLocalX = (centerX0 - x0) / s0;
    const cLocalY = (centerY0 - y0) / s0;
    model.x = centerX0 - cLocalX * s1;
    model.y = centerY0 - cLocalY * s1;
    const screen = app && app.renderer && app.renderer.screen;
    if (screen) {
      const W = Math.max(1, screen.width);
      const H = Math.max(1, screen.height);
      // 宽松夹取：允许小幅越界，避免又把人拉回而破坏「中心不动」
      model.x = clamp(model.x, -W, 2 * W);
      model.y = clamp(model.y, -H, 2 * H);
    }
  }

  try { if (typeof model.updateTransform === 'function') model.updateTransform(); } catch (_) { /* 忽略 */ }
  try { contentBoundsCache.delete(model); } catch (_) { /* 忽略 */ }
}

/**
 * 设置缩放百分比（相对基准自适应尺寸）。全局设置：逐实例保持「可见中心不动」。
 * @param {number} percent 50~300 常用
 */
function setScalePercent(percent) {
  state.options.scalePercent = clamp(Number(percent) || 0, 1, 1000);

  // 目标：缩放「以人物可见中心为原点、不改变人物屏幕位置」。
  // 做法：记录缩放前的人物可见中心（stage 全局）与旧缩放 s0、原点 (x0,y0)；
  //   内容中心相对原点的「局部偏移」cLocal = (center - 原点)/s0 不随缩放变化，
  //   故令新原点 = 原屏幕中心 - cLocal*s1，即可解析式保持屏幕中心不动（不依赖二次测量）。
  let any = false;
  for (const id of state.order.slice()) {
    const inst = state.instances.get(id);
    if (!inst || !inst.model) continue;
    any = true;
    try {
      applyScaleToInstance(inst);
    } catch (err) {
      console.warn('[modelLoader] 缩放实例失败（忽略）:', id, err);
    }
  }
  if (!any) refreshFitAll({ preservePosition: true });
}

/** 读取当前缩放百分比（供滚轮缩放等增量调节使用） */
function getScalePercent() {
  return Number(state.options.scalePercent) || 0;
}

/** 重置人物位置：恢复到默认锚点（底部居中），不改变缩放（作用于活动实例） */
function resetModelPosition() {
  const inst = getActiveInstance();
  if (!inst || !inst.model) return;
  fitInstanceToWindow(inst, { preservePosition: false });
}

/**
 * 全局串行加载队列（保持既有防竞态语义）：所有模型加载都经此排队。
 * @template T
 * @param {() => Promise<T>} worker
 * @returns {Promise<T>}
 */
function enqueueLoad(worker) {
  const task = (state.loading || Promise.resolve())
    .catch(() => { /* 忽略上一次失败，继续本次加载 */ })
    .then(() => worker());

  state.loading = task.catch(() => { /* 仅用于队列，不阻塞下一次 */ });
  return task;
}

/**
 * 在指定实例上加载模型（内部核心流程：扫描补齐 → 创建 → 入 stage → 待机 → 适配）。
 *
 * 失败原子性：任一步抛错时，实例 `inst.model` 保持原值（替换场景旧模型不会被销毁），
 * 也不会向 stage 之外的注册表写入任何状态 —— 由调用方决定是否登记该实例。
 *
 * @param {ModelInstance} inst 目标实例记录（尚未登记或已登记均可）
 * @param {object} [loadOptions] 透传 pixi-live2d-display 的加载选项
 * @param {{ preservePosition?: boolean, x?: number, y?: number }} [opts]
 * @returns {Promise<object>} Live2DModel
 */
async function loadIntoInstance(inst, loadOptions, opts = {}) {
  const app = state.app;
  if (!app) throw new Error('请先调用 modelLoader.init(app)');
  const Live2DModel = getLive2DModelClass();
  const o = state.options;
  const url = inst.url;
  const oldModel = inst.model || null;
  const oldKind = inst.kind;
  // 该实例加载前是否已在注册表中（用于检测「加载期间被移除」）
  const wasRegistered = state.instances.get(inst.id) === inst;

  const modelOptions = {
    autoUpdate: o.autoUpdate,
    autoInteract: o.autoInteract,
    ...(loadOptions || {})
  };
  if (o.idleMotionGroup) modelOptions.idleMotionGroup = o.idleMotionGroup;

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

  // 防御：加载期间该实例已被移除（并发 removeInstance）→ 丢弃刚创建的模型，不产生悬挂引用
  if (wasRegistered && state.instances.get(inst.id) !== inst) {
    destroyModelObject(model, app);
    throw new Error(`实例已移除：${inst.id}`);
  }

  app.stage.addChild(model);

  // 就位：切换实例的 model 引用（此后该实例的所有状态只作用于新模型）
  inst.model = model;
  inst.kind = detectCubismKind(model);

  try {
    // 未声明 Expressions 的 Cubism4 模型：由伴生 vtube.json 发现并挂载可用表情（声明/扫描优先，回退不阻断显示）
    await attachDiscoveredExpressions(model);

    // ② 待机降频：关闭 pld 内置自动待机，改由本模块按间隔驱动（只驱动该实例）
    setupIdleScheduler(model, inst);

    // 适配尺寸并应用透明度
    const preserve = opts.preservePosition === true;
    fitInstanceToWindow(inst, { preservePosition: preserve });
    if (preserve) {
      // 替换模型：回填该实例上一位置，并夹取到窗口内（R3-11：位置不得超出窗口导致不可见）
      const px = Number(opts.x);
      const py = Number(opts.y);
      if (isFinite(px) && isFinite(py)) {
        const { W, H } = getScreenSize();
        model.x = clamp(px, 0, W);
        model.y = clamp(py, 0, H);
        try { contentBoundsCache.delete(model); } catch (_) { /* 忽略 */ }
      }
    }

    // 按 order 重建绘制层级（替换下层实例时不得跑到最上层）
    applyStageOrder();

    // 替换场景：新模型全部就位后，才销毁旧模型（失败原子性）
    if (oldModel && oldModel !== model) destroyModelObject(oldModel, app);
  } catch (err) {
    // 回滚：丢弃新模型、恢复旧引用与该实例的待机调度（不留下半成品状态）
    stopIdleScheduler(inst);
    inst.model = oldModel;
    inst.kind = oldKind;
    destroyModelObject(model, app);
    if (oldModel) {
      try { setupIdleScheduler(oldModel, inst); } catch (_) { /* 忽略 */ }
    }
    throw err;
  }

  // 记录并按运行时类型判定 Cubism 版本（供日志与设置面板标注；不依赖清单字段猜测）
  try {
    const internalModel = model.internalModel || {};
    const settings = internalModel.settings || {};
    console.info(
      `[modelLoader] 已加载模型 "${settings.name || inst.name || url}"（${inst.kind}，实例 ${inst.id}）` +
      `，画布 ${internalModel.width || '?'}x${internalModel.height || '?'}`
    );
  } catch (_) { /* 仅日志，忽略 */ }

  return model;
}

/**
 * 新增一个模型实例（加载并加入 stage）。
 *
 * 契约（C-MODEL-INSTANCES@1）：
 *  - id 非空且未占用，否则 reject；实例数已达 MAX_INSTANCES → reject；
 *  - 加载失败 → 不占用 id、不写 order、不入 stage（调用方可直接用同一 id 重试）；
 *  - 首个实例自动成为活动实例；后续实例的激活由调用方显式 setActiveInstance。
 *
 * @param {{ id: string, url: string, rawUrl?: string, name?: string }} spec
 * @param {object} [loadOptions] 透传给 pixi-live2d-display
 * @returns {Promise<{id:string,url:string,rawUrl:string,name:string,kind:string,x:number,y:number,active:boolean}>}
 * @throws {Error} id 已存在 / 超过 6 个 / 加载失败 / 未 init
 */
async function addInstance(spec, loadOptions) {
  if (!state.app) throw new Error('请先调用 modelLoader.init(app)');

  const s = spec || {};
  const id = normalizeInstanceId(s.id);
  if (!id) throw new Error('addInstance 需要非空实例 id');
  const url = (typeof s.url === 'string' && s.url) ? s.url : '';
  if (!url) throw new Error('addInstance 需要模型 URL');

  // 快速失败（非权威校验；权威校验在串行队列内再做一次）
  if (state.instances.has(id)) throw new Error(`实例 id 已存在：${id}`);
  if (state.instances.size >= MAX_INSTANCES) throw new Error('最多同时显示 6 个模型');

  const inst = {
    id,
    url,
    rawUrl: (typeof s.rawUrl === 'string' && s.rawUrl) ? s.rawUrl : url,
    name: (typeof s.name === 'string' && s.name.trim()) ? s.name.trim() : deriveNameFromUrl(url),
    kind: '未知',
    model: null,
    exprIndex: -1,
    poseIndex: -1,
    lastPlayedExpr: -1,
    reactionUntil: 0,
    idle: null,
    idleTick: null
  };

  await enqueueLoad(async () => {
    // 串行区内再校验一次（并发 addInstance 也不会突破上限或重复 id）
    if (state.instances.has(id)) throw new Error(`实例 id 已存在：${id}`);
    if (state.instances.size >= MAX_INSTANCES) throw new Error('最多同时显示 6 个模型');
    return loadIntoInstance(inst, loadOptions);
  });

  const isFirst = state.instances.size === 0;
  state.instances.set(id, inst);
  state.order.push(id);
  if (isFirst || !state.activeId) state.activeId = id;
  syncLegacyMirror();
  applyStageOrder();

  return snapshotOf(inst);
}

/**
 * 实例快照数组（按创建顺序；不含 model 对象）。
 * @returns {Array<{id:string,url:string,rawUrl:string,name:string,kind:string,x:number,y:number,active:boolean}>}
 */
function getInstances() {
  const out = [];
  for (const id of state.order) {
    const inst = state.instances.get(id);
    if (inst) out.push(snapshotOf(inst));
  }
  return out;
}

/**
 * 单个实例快照；不存在 → null。
 * @param {string} id
 */
function getInstance(id) {
  const inst = state.instances.get(normalizeInstanceId(id));
  return inst ? snapshotOf(inst) : null;
}

/**
 * 设置活动实例（同步 legacy `state.model`）。
 * @param {string} id
 * @returns {boolean} id 不存在 → false
 */
function setActiveInstance(id) {
  const key = normalizeInstanceId(id);
  if (!key || !state.instances.has(key)) return false;
  state.activeId = key;
  syncLegacyMirror();
  return true;
}

/**
 * 当前活动实例 id；无 → null。
 * @returns {string|null}
 */
function getActiveInstanceId() {
  return state.activeId || null;
}

/**
 * 移除实例：销毁 model、移除 stage、停该实例的 idle 与状态；不删磁盘文件。
 * 若移除的是活动实例，活动实例回退为剩余实例中最上层者（order 末尾）；无剩余 → null。
 * @param {string} id
 * @returns {boolean} 是否实际移除
 */
function removeInstance(id) {
  const key = normalizeInstanceId(id);
  const inst = key ? state.instances.get(key) : null;
  if (!inst) return false;

  destroyInstanceModel(inst);
  state.instances.delete(key);

  const idx = state.order.indexOf(key);
  if (idx >= 0) state.order.splice(idx, 1);

  if (state.activeId === key) {
    state.activeId = state.order.length ? state.order[state.order.length - 1] : null;
  }
  syncLegacyMirror();
  return true;
}

/**
 * 恢复用：写入位置并夹取到窗口 [0,W]/[0,H]。
 * @param {string} id
 * @param {number} x 窗口内 CSS 像素
 * @param {number} y 窗口内 CSS 像素
 * @returns {boolean} 实例不存在 → false
 */
function setInstancePosition(id, x, y) {
  const inst = state.instances.get(normalizeInstanceId(id));
  if (!inst || !inst.model) return false;

  const { W, H } = getScreenSize();
  inst.model.x = clamp(Number(x) || 0, 0, W);
  inst.model.y = clamp(Number(y) || 0, 0, H);
  try { if (typeof inst.model.updateTransform === 'function') inst.model.updateTransform(); } catch (_) { /* 忽略 */ }
  try { contentBoundsCache.delete(inst.model); } catch (_) { /* 忽略 */ }
  return true;
}

/**
 * 设置实例的「原始路径」rawUrl（供持久化使用）。
 *
 * 为什么需要：`loadModel()` 只替换模型、不重新登记实例，调用方若手里有更准确的原始路径
 * （如导入/外部的磁盘路径），可在加载后用它直接校正实例 rawUrl，而不必重新加载模型。
 * 约束与 instances.js 一致：rawUrl 禁止为 asset:// 地址（外壳临时协议，重启后不可用）。
 *
 * @param {string} id 实例 id
 * @param {string} rawUrl 原始路径（非空字符串）
 * @returns {boolean} 实例不存在 / rawUrl 非空字符串校验失败 → false
 */
function setInstanceRawUrl(id, rawUrl) {
  const key = normalizeInstanceId(id);
  const inst = key ? state.instances.get(key) : null;
  if (!inst) return false;
  const raw = (typeof rawUrl === 'string') ? rawUrl.trim() : '';
  if (!raw) return false;
  inst.rawUrl = raw;
  return true;
}

/**
 * 读取实例位置（窗口内 CSS 像素）。
 * @param {string} id
 * @returns {{x:number,y:number}|null}
 */
function getInstancePosition(id) {
  const inst = state.instances.get(normalizeInstanceId(id));
  if (!inst || !inst.model) return null;
  return { x: Number(inst.model.x) || 0, y: Number(inst.model.y) || 0 };
}

/**
 * 销毁全部实例（应用退出/重载用）。
 */
function unloadAll() {
  for (const inst of Array.from(state.instances.values())) {
    destroyInstanceModel(inst);
  }
  state.instances.clear();
  state.order = [];
  state.activeId = null;
  syncLegacyMirror();
}

/**
 * 拆出 `loadOptions.rawUrl` 并返回其余「透传给 pixi-live2d-display」的选项。
 *
 * rawUrl 是本工程实例持久化专用的原始路径（禁止 asset://），不属于插件选项，
 * 因此必须从透传对象中剥离，避免污染 `Live2DModel.from(url, options)` 的入参。
 *
 * @param {object|null|undefined} loadOptions
 * @returns {{ rawUrl: string, options: object|undefined }}
 */
function splitRawUrlOption(loadOptions) {
  if (!loadOptions || typeof loadOptions !== 'object') return { rawUrl: '', options: loadOptions };
  const { rawUrl, ...rest } = loadOptions;
  const raw = (typeof rawUrl === 'string') ? rawUrl.trim() : '';
  const hasRest = Object.keys(rest).length > 0;
  return { rawUrl: raw, options: hasRest ? rest : undefined };
}

/**
 * 加载模型（自动识别 Cubism 2 / Cubism 4）。
 *
 * 语义（兼容既有单模型用法）：
 *  - 无实例 → 等价 `addInstance({ id: 'inst-1', url })`，自动成为活动实例；
 *  - 有实例 → **替换活动实例的模型**（保留该实例 id/name 与其位置 x/y）；
 *    旧模型在新模型成功就位后才销毁（加载失败不破坏现有实例）。
 *
 * rawUrl 同步（R3-3）：替换场景必须同步实例 rawUrl —— instances.js 持久化时优先取实例快照的
 * rawUrl，只更新 url 会让磁盘记录仍指向旧模型，重启后又恢复成旧模型。
 *  - `loadOptions.rawUrl` 为非空字符串 → 加载成功后同步写入实例；
 *  - 未提供 → 保留旧 rawUrl，并显式告警（不阻断加载，但重启可能恢复旧模型）。
 *
 * @param {string} url 模型清单地址（.model.json 或 .model3.json，也可为对象 URL）
 * @param {object} [loadOptions] 覆盖本次加载的插件选项；额外支持 `rawUrl`（实例持久化用原始路径）
 * @returns {Promise<object>} Live2DModel
 */
async function loadModel(url, loadOptions) {
  if (!url) throw new Error('loadModel 需要模型 URL');
  const target = String(url);
  const { rawUrl, options } = splitRawUrlOption(loadOptions);
  const active = getActiveInstance();

  if (!active) {
    // 首个实例：rawUrl 随 spec 一并登记（缺省时由 addInstance 退化为 url，行为不变）
    const spec = rawUrl ? { id: 'inst-1', url: target, rawUrl } : { id: 'inst-1', url: target };
    const snap = await addInstance(spec, options);
    const created = state.instances.get(snap.id);
    return created ? created.model : null;
  }

  const hadPrevModel = !!active.model;
  const prevX = hadPrevModel ? active.model.x : 0;
  const prevY = hadPrevModel ? active.model.y : 0;

  // 替换的是「模型」：实例 id / name 与其位置保持不变，仅切换可加载 URL
  const prevUrl = active.url;
  const prevRawUrl = active.rawUrl;
  active.url = target;
  try {
    await enqueueLoad(() => {
      // 串行等待期间活动实例可能被移除 → 明确失败，避免向已移除实例加载
      if (state.instances.get(active.id) !== active) {
        throw new Error(`实例已移除：${active.id}`);
      }
      return loadIntoInstance(active, options, {
        preservePosition: hadPrevModel,
        x: prevX,
        y: prevY
      });
    });
  } catch (err) {
    // 失败回滚：instance.url 恢复为上一次成功加载的地址，避免快照与模型不一致
    active.url = prevUrl;
    throw err;
  }

  // 仅在加载成功后同步 rawUrl（失败路径不改动，天然保持旧值）
  if (rawUrl) {
    active.rawUrl = rawUrl;
  } else {
    console.warn(
      `[modelLoader] loadModel 未提供 loadOptions.rawUrl，实例 ${active.id} 保留原 rawUrl` +
      `（${prevRawUrl || '空'}）→ 持久化后重启可能恢复为旧模型`
    );
  }

  syncLegacyMirror();
  return active.model;
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
  const model = getActiveModel();
  return model ? detectCubismKind(model) : (state.lastModelKind || '未知');
}

/**
 * 切换模型（loadModel 的语义别名，便于设置面板调用）。
 * 单实例时 = 换模型；多实例时 = 替换活动实例的模型。
 * @param {string} url
 * @param {object} [loadOptions] 同 loadModel（支持 rawUrl，用于同步实例原始路径）
 */
function switchModel(url, loadOptions) {
  return loadModel(url, loadOptions);
}

/**
 * 只读运行时调试状态（供实机验证 / 排障；不改变行为）。
 * 顶层字段为活动实例的镜像；`instances` 为全部实例的逐项状态（含各自待机 playCount）。
 * @returns {{kind:string,
 *   idle:{idleGroup:string|null, interval:number, speed:number, playCount:number}|null,
 *   reactionUntil:number, expressionIndex:number, poseIndex:number, idleAutoDisabled:boolean,
 *   activeId:string|null,
 *   instances:Array<{id:string,kind:string,active:boolean,x:number,y:number,
 *     idle:object|null,reactionUntil:number,expressionIndex:number,poseIndex:number}>}}
 */
function getDebugState() {
  const inst = getActiveInstance();
  const model = (inst && inst.model) || null;
  const mm = model && model.internalModel && model.internalModel.motionManager;

  const list = [];
  for (const id of state.order) {
    const it = state.instances.get(id);
    if (!it) continue;
    list.push({
      id: it.id,
      kind: it.kind || '未知',
      active: state.activeId === it.id,
      x: it.model ? (Number(it.model.x) || 0) : 0,
      y: it.model ? (Number(it.model.y) || 0) : 0,
      idle: it.idle ? { ...it.idle } : null,
      reactionUntil: it.reactionUntil,
      expressionIndex: it.exprIndex,
      poseIndex: it.poseIndex
    });
  }

  return {
    kind: getModelKind(),
    idle: (inst && inst.idle) ? { ...inst.idle } : null,
    reactionUntil: inst ? inst.reactionUntil : 0,
    expressionIndex: inst ? inst.exprIndex : -1,
    poseIndex: inst ? inst.poseIndex : -1,
    idleAutoDisabled: !!(mm && mm.groups && mm.groups.idle === IDLE_DISABLED_GROUP),
    activeId: state.activeId,
    instances: list
  };
}

/** 重新适配全部实例（窗口 resize 时调用） */
function refreshFit(opts) {
  refreshFitAll(opts);
}

/** 卸载当前（活动）模型；等同于移除活动实例，不删磁盘文件 */
function unloadModel() {
  if (!state.activeId) return;
  removeInstance(state.activeId);
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

/**
 * 取指定模型的可用表情名（0 基索引与 definitions / settings.expressions 顺序一致）；无则 []。
 * @param {object|null} model
 * @returns {string[]}
 */
function getExpressionNamesFor(model) {
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

/** 当前（活动实例）模型可用表情名；无则 [] */
function getExpressionNames() {
  return getExpressionNamesFor(getActiveModel());
}

/**
 * 为指定实例选择第 index 个表情（0 基）。
 * @param {ModelInstance|null} inst
 * @param {number} index
 * @returns {boolean} 越界 / 无表情 / 播放失败 → false
 */
function selectExpressionFor(inst, index) {
  const model = inst && inst.model;
  if (!model) return false;
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0) return false;
  const names = getExpressionNamesFor(model);
  if (i >= names.length) return false;
  try {
    let ok;
    if (typeof model.expression === 'function') {
      ok = model.expression(i);            // pixi-live2d-display 支持按索引选择
    } else if (typeof model.setExpression === 'function') {
      ok = model.setExpression(names[i]);
    }
    if (isThenable(ok)) ok = true;         // 异步实现视为已下发
    if (ok) inst.exprIndex = i;
    return !!ok;
  } catch (err) {
    console.warn('[modelLoader] 选择表情失败:', err);
    return false;
  }
}

/**
 * 选择活动实例的第 index 个表情（0 基）。
 * @returns {boolean} 越界 / 无表情 / 播放失败 → false
 */
function selectExpression(index) {
  return selectExpressionFor(getActiveInstance(), index);
}

/** 活动实例轮换到下一个表情（循环）；无表情 → false */
function nextExpression() {
  const inst = getActiveInstance();
  const names = getExpressionNamesFor(inst && inst.model);
  if (!names.length) return false;
  const next = ((inst ? inst.exprIndex : -1) + 1) % names.length; // 初始 -1 → 0
  return selectExpressionFor(inst, next);
}

/** 活动实例当前表情索引（无则 -1） */
function getExpressionIndex() {
  const inst = getActiveInstance();
  if (!inst || !inst.model) return -1;
  const names = getExpressionNamesFor(inst.model);
  if (!names.length) return -1;
  return (inst.exprIndex >= 0 && inst.exprIndex < names.length) ? inst.exprIndex : -1;
}

/**
 * 取指定模型的「动作组」名列表（motionManager.definitions 组名）；无则 []。
 * @param {object|null} model
 * @returns {string[]}
 */
function getMotionGroupNames(model) {
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

/** 以「动作组」呈现的姿势名列表（活动实例）；无则 [] */
function getPoseNames() {
  return getMotionGroupNames(getActiveModel());
}

/**
 * 为指定实例播放第 index 个动作组（0 基）。
 * @param {ModelInstance|null} inst
 * @param {number} index
 * @returns {boolean} 越界 / 无动作组 / 播放失败 → false
 */
function selectPoseFor(inst, index) {
  const model = inst && inst.model;
  if (!model) return false;
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0) return false;
  const names = getMotionGroupNames(model);
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
    if (ok) inst.poseIndex = i;
    return !!ok;
  } catch (err) {
    console.warn('[modelLoader] 播放动作组失败:', err);
    return false;
  }
}

/**
 * 播放活动实例的第 index 个动作组（0 基）。
 * @returns {boolean} 越界 / 无动作组 / 播放失败 → false
 */
function selectPose(index) {
  return selectPoseFor(getActiveInstance(), index);
}

/** 活动实例轮换到下一个动作组（循环）；无动作组 → false */
function nextPose() {
  const inst = getActiveInstance();
  const names = getMotionGroupNames(inst && inst.model);
  if (!names.length) return false;
  const next = ((inst ? inst.poseIndex : -1) + 1) % names.length; // 初始 -1 → 0
  return selectPoseFor(inst, next);
}

/** 活动实例当前动作组索引（无则 -1） */
function getPoseIndex() {
  const inst = getActiveInstance();
  if (!inst || !inst.model) return -1;
  const names = getMotionGroupNames(inst.model);
  if (!names.length) return -1;
  return (inst.poseIndex >= 0 && inst.poseIndex < names.length) ? inst.poseIndex : -1;
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
  const names = getMotionGroupNames(model).filter((n) => /idle/i.test(String(n)));
  for (const n of names) {
    if (groupHasPlayableMotion(model, n)) return n;
  }
  return null;
}

/**
 * 停止「指定实例」的待机调度（只移除该实例自己的 tick，不影响其它实例）。
 * @param {ModelInstance} [instance] 缺省为活动实例
 */
function stopIdleScheduler(instance) {
  const inst = instance || getActiveInstance();
  if (!inst) return;
  const app = state.app;
  if (inst.idleTick && app && app.ticker && typeof app.ticker.remove === 'function') {
    try { app.ticker.remove(inst.idleTick); } catch (_) { /* 忽略 */ }
  }
  inst.idleTick = null;
  inst.idle = null;
}

/**
 * 装配「指定实例」的待机调度：关闭 pld 内置自动待机，改由本模块按 idleIntervalMs 驱动。
 * 每个实例独立 tick（新增/移除实例不得停掉其它实例的待机）。
 * @param {object} model Live2DModel
 * @param {ModelInstance} [instance] 缺省为活动实例
 */
function setupIdleScheduler(model, instance) {
  const inst = instance || getActiveInstance();
  if (!inst) return;
  stopIdleScheduler(inst);
  if (!model) return;
  const mm = model.internalModel && model.internalModel.motionManager;
  if (!mm) return;

  const idleGroup = findIdleGroupName(model);
  const interval = clampIdleInterval(state.options.idleIntervalMs);
  const speed = clampIdleSpeed(state.options.idleSpeed);
  inst.idle = { idleGroup, interval, speed, playCount: 0 };

  const ticker = state.app && state.app.ticker;
  if (!idleGroup || !ticker || typeof ticker.add !== 'function') {
    console.info(
      `[modelLoader] 待机调度未启用（实例 ${inst.id}；idle 组=${idleGroup || '无'}；Ticker=${!!ticker}）：` +
      '该模型无可播 idle 动作，保持现有行为'
    );
    return;
  }

  // 关闭 pld 内置自动待机：动作结束后不再「立刻」重播 idle
  try { mm.groups.idle = IDLE_DISABLED_GROUP; } catch (_) { /* 忽略 */ }

  let lastAt = null; // null = 尚未起算（从加载完成起计时，避免加载后立即播放）
  const step = () => {
    const now = perfNow();
    // 点击反应进行中：让位并顺延计时（只读该实例自己的反应锁）
    if (now < inst.reactionUntil) { lastAt = now; return; }
    // 有动作正在播放（含交互动作）：让位并顺延计时（不与其他动作抢占）
    if (mm.playing === true) { lastAt = now; return; }
    if (lastAt == null) { lastAt = now; return; }
    if (now - lastAt < interval) return;
    lastAt = now;
    try {
      const started = mm.startRandomMotion(idleGroup, 1); // MotionPriority.IDLE = 1（不会抢占 NORMAL）
      if (isThenable(started) && typeof started.catch === 'function') started.catch(() => { /* 静默 */ });
      if (inst.idle) inst.idle.playCount += 1;
    } catch (_) { /* 忽略 */ }
  };
  ticker.add(step);
  inst.idleTick = step;

  console.info(
    `[modelLoader] 待机降频：实例 ${inst.id}，组=${idleGroup}，间隔=${interval}ms，目标速度=${speed}` +
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
  const groups = getMotionGroupNames(model);
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
 * @param {object} model 目标模型
 * @param {number} [excludeIndex=-1] 需排除的索引（避免连点重复同一表情）
 * @returns {number} -1 = 无表情
 */
function pickRandomExpressionIndex(model, excludeIndex = -1) {
  const names = getExpressionNamesFor(model);
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
 * 下发即视为已反应、异步失败静默；避免与上一次反应播放同一索引（按实例记录）。
 * @param {object} model 目标模型
 * @param {ModelInstance} [instance] 目标实例（缺省为活动实例）
 * @returns {boolean}
 */
function playVisibleExpression(model, instance) {
  const inst = instance || getActiveInstance();
  const lastPlayed = inst ? inst.lastPlayedExpr : -1;
  const idx = pickRandomExpressionIndex(model, lastPlayed);
  if (idx < 0) return false;
  try {
    let ok;
    if (typeof model.expression === 'function') ok = model.expression(idx);
    else if (typeof model.setExpression === 'function') ok = model.setExpression(getExpressionNamesFor(model)[idx]);
    if (isThenable(ok)) {
      if (typeof ok.catch === 'function') ok.catch(() => { /* 加载失败静默 */ });
      ok = true;
    }
    if (!ok) return false;
    if (inst) {
      inst.exprIndex = idx;
      inst.lastPlayedExpr = idx;
    }
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
 * 多实例：作用于指定实例（缺省为活动实例），重入锁与状态按实例隔离
 * （返回 true 表示「已在反应中」或已下发反应）。全程 try/catch，不阻断眨眼/视线/待机。
 *
 * @param {string} [instanceId] 目标实例 id；缺省 → 活动实例
 * @returns {Promise<boolean>} 实例不存在 → false
 */
async function reactTap(instanceId) {
  let inst;
  if (instanceId === undefined || instanceId === null || instanceId === '') {
    inst = getActiveInstance();
  } else {
    inst = state.instances.get(normalizeInstanceId(instanceId)) || null;
  }
  if (!inst || !inst.model) return false;
  const model = inst.model;

  // 重入保护：反应进行中忽略新的点击（返回 true 表示「已在反应中」）
  const now = perfNow();
  if (now < inst.reactionUntil) return true;
  inst.reactionUntil = now + REACTION_LOCK_MS;

  // 1) 可见表情（含扫描发现的 exp3）
  try { if (playVisibleExpression(model, inst)) return true; } catch (_) { /* 忽略 */ }

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
  resetModelPosition,
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
  reactTap,
  addInstance,
  getInstances,
  getInstance,
  setActiveInstance,
  getActiveInstanceId,
  removeInstance,
  setInstancePosition,
  setInstanceRawUrl,
  getInstancePosition,
  fitInstance,
  refreshFitAll,
  unloadAll
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
  resetModelPosition,
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
  reactTap,
  addInstance,
  getInstances,
  getInstance,
  setActiveInstance,
  getActiveInstanceId,
  removeInstance,
  setInstancePosition,
  setInstanceRawUrl,
  getInstancePosition,
  fitInstance,
  refreshFitAll,
  unloadAll
};