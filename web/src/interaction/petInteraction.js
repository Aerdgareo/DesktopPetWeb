/**
 * petInteraction.js —— 桌宠交互：视线跟随 / 命中判定 / 拖拽（仅模型）/ 点击反应 / 穿透联动
 *
 * 交互契约（C-PET-INTERACTION@2，多实例）：
 *  1) 视线跟随：app.ticker 每帧对**所有可见实例**调用 model.focus(...)。参照中心不在画布中心，
 *     而是上移到「人物头部」：有 hit areas 的模型用画布包围盒上部 headAnchorRatio（≈25%）；
 *     无 hit areas 的导入模型改用「绘制内容包围盒」（水平中心 + 内容高度上部 headAnchorRatio），
 *     使视线中心落在人物头部（导入模型在画布中不居中）。单实例异常被隔离，不影响其它实例。
 *  2) 命中判定（hitTestInstance）：按 `modelLoader.getInstances()` **逆序**遍历（后创建者绘制在上层），
 *     逐个实例走「hit areas → 绘制内容包围盒 → 画布包围盒」三级判定，返回首个命中实例 id。
 *     `model.visible === false` 的实例跳过。`hitTestModel(x,y)` 保留既有签名，
 *     等价于 `hitTestInstance(x,y) !== null`（兼容既有单实例调用方）。
 *  3) 拖拽仅命中实例：pointerdown 命中的实例才进入拖拽（并切为活动实例），拖拽只改变该实例
 *     model.x / model.y（移动模型本体，不移动/裁剪窗口）。越出窗口导致「可见面积比例」低于
 *     minVisibleRatio（默认 0.06）时钳制到临界点，并由 ticker 以 spring 系数缓动弹回。
 *     拖拽稳定后（mouseup 未进入回弹，或回弹收敛）回调 options.onInstanceMoved(id,x,y) **恰好一次**。
 *  4) 点击反应：命中实例且位移未超过阈值的点击 → setActiveInstance(id) → modelLoader.reactTap(id)
 *     （可见表情 → 可见动作组 → 非嘴部参数反应 → 缩放脉冲兜底）。重入锁按实例隔离，
 *     同一实例反应进行中忽略新点击，不影响其它实例。
 *  5) 视线跟随抑制：每帧 model.focus() 之后调用 modelLoader.suppressBodySway(model, 0.25)，
 *     把躯干参数（ParamBodyAngleX/Z）缩放到 ~0.25 倍，避免鼠标悬停躯干时人物整体左右晃动。
 *  6) 滚轮缩放：光标悬停命中**任一实例**时，wheel 按 deltaY 每格 ±wheelZoomStep（默认 5%）
 *     全局缩放（所有实例同步，见 C-MODEL-INSTANCES@1 的 setScalePercent），并回调 onScaleChange；
 *     悬停在设置面板上时交还 DOM。
 *  7) 穿透联动：实时判断「命中任一实例 或 命中设置面板 UI」，变化时回调 bridge.setInteractive()。
 *     - Electron：在 mousemove 上判断（穿透态仍能收到 mousemove，forward:true）；
 *     - Tauri：以约 20fps 轮询 Rust 的 poll_cursor 拿到窗口内光标坐标后判断
 *       （setIgnoreCursorEvents 不转发 mousemove，故穿透态需靠轮询探测）。
 *     两分支共用同一套 `hitTestInstance || isPointerOverUI` 判定。
 */

const DEFAULT_OPTIONS = {
  dragThreshold: 8,          // 像素：区分点击与拖拽
  enableFocus: true,         // 是否开启视线跟随
  autoPenetration: null,     // null = 依据 bridge.canForwardMouseMove || bridge.canPollCursor 自动决定
  tapMotionGroups: ['Tap', 'tap_body', 'tap_head', 'flick_head', 'shake'],
  minVisibleRatio: 0.06,     // 拖拽时允许人物被裁到的最小「可见面积比例」，低于则回弹
  spring: 0.2,               // 回弹缓动系数（0~1，越大越快；逐帧 v += (target-v)*spring）
  headAnchorRatio: 0.25,     // 视线参照中心：人物高度上部 ~25% 处（≈头部），而非画布中心
  wheelZoomStep: 5,          // 滚轮每格缩放百分比
  minScalePercent: 10,       // 缩放百分比下限（已按需求下调）
  maxScalePercent: 300       // 缩放百分比上限
};

/**
 * 创建交互控制器。
 * @param {{
 *   app: object,                        // PIXI.Application
 *   modelLoader: object,               // 见 modelLoader.js（C-MODEL-INSTANCES@1）
 *   bridge: object,                    // 见 bridge.js
 *   isPointerOverUI?: (x:number,y:number)=>boolean, // 设置面板命中判定
 *   options?: {
 *     onScaleChange?: (percent:number)=>void,
 *     onInstanceMoved?: (id:string,x:number,y:number)=>void,
 *     [key:string]: any
 *   }
 * }} deps
 * @returns {{
 *   attach: () => void,
 *   detach: () => void,
 *   setEnabled: (v:boolean) => void,
 *   setAutoPenetration: (v:boolean) => void,
 *   isAutoPenetration: () => boolean,
 *   syncHover: (x:number,y:number) => void,
 *   hitTestInstance: (x:number,y:number) => string|null,
 *   hitTestModel: (x:number,y:number) => boolean,
 *   getState: () => object
 * }}
 */
function createPetInteraction(deps) {
  const app = deps.app;
  const modelLoader = deps.modelLoader;
  const bridge = deps.bridge;
  const isPointerOverUI = typeof deps.isPointerOverUI === 'function' ? deps.isPointerOverUI : () => false;
  const options = { ...DEFAULT_OPTIONS, ...(deps.options || {}) };

  // 未显式指定时：具备 mousemove 转发（Electron）或「光标轮询」（Tauri）能力的外壳，
  // 均可实现「悬停自动穿透」，故默认启用。
  const state = {
    enabled: true,
    autoPenetration: options.autoPenetration == null
      ? !!(bridge.canForwardMouseMove || bridge.canPollCursor)
      : !!options.autoPenetration,
    pending: false,                 // 已按下但尚未判定为拖拽
    dragging: false,
    draggingInstanceId: null,       // 当前拖拽的实例 id（按下命中的实例）
    moveNotified: false,            // 本轮拖拽是否已回调 onInstanceMoved（保证「恰好一次」）
    startPointer: { x: 0, y: 0 },
    dragStartModel: { x: 0, y: 0 },  // 拖拽起点时「被拖实例」的 model.x/model.y
    lastPointer: null,
    interactive: null,              // 最近一次下发的「可点」状态
    bounce: null                    // 回弹目标 { instanceId, targetX, targetY }，由 ticker 逐帧缓动收敛
  };

  let modelLoaderRef = modelLoader;

  // ---------------- 实例枚举 / 适配层（C-MODEL-INSTANCES@1） ----------------
  //
  // 契约里 getInstances() 只承诺「实例快照（不含 model 对象）」，而命中判定/拖拽/视线都必须
  // 拿到每个实例的 PIXI model。这里按优先级解析，不修改 modelLoader：
  //   1) 快照自带 model（若实现顺带返回）
  //   2) modelLoader.getInstanceModel(id)（若实现提供）
  //   3) modelLoader.getInstance(id)（可能返回快照或 model 本身）
  //   4) app.stage 子节点：契约保证 stage 子节点顺序 === 实例创建顺序，按索引对齐
  //   5) 全部不可用 → 退回单实例 currentModel()

  /** PIXI-Live2D 模型对象特征：一定带 internalModel */
  function looksLikeModel(v) {
    return !!(v && typeof v === 'object' && v.internalModel);
  }

  /** 实例 id 归一化（保证非空字符串；缺失时按创建序号兜底） */
  function normalizeId(raw, index) {
    if (typeof raw === 'string' && raw) return raw;
    if (typeof raw === 'number' && isFinite(raw)) return `inst-${raw}`;
    return `inst-${index + 1}`;
  }

  /** 当前活动实例 id（单实例退化时用于给条目命名） */
  function activeInstanceId() {
    try {
      if (typeof modelLoaderRef.getActiveInstanceId === 'function') {
        const id = modelLoaderRef.getActiveInstanceId();
        return typeof id === 'string' && id ? id : null;
      }
    } catch (_) { /* 忽略 */ }
    return null;
  }

  /** 安全读取 legacy 当前模型 */
  function currentModelSafe() {
    try {
      const m = typeof modelLoaderRef.currentModel === 'function' ? modelLoaderRef.currentModel() : null;
      return looksLikeModel(m) ? m : null;
    } catch (_) {
      return null;
    }
  }

  /** stage 上的模型节点（顺序 = 实例创建顺序） */
  function stageModels() {
    const stage = app && app.stage;
    if (!stage || !Array.isArray(stage.children)) return [];
    return stage.children.filter(looksLikeModel);
  }

  /** 单实例退化：无多实例 API 时用 currentModel() 当唯一实例 */
  function fallbackEntries() {
    const model = currentModelSafe();
    if (!model) return [];
    return [{ id: activeInstanceId() || 'inst-1', model }];
  }

  /**
   * 取全部实例条目 [{ id, model }]，按创建顺序。
   * 无实例 / 无多实例 API 时安全退化为单实例，绝不抛错。
   * @returns {Array<{id:string, model:object}>}
   */
  function getInstanceEntries() {
    if (!modelLoaderRef || typeof modelLoaderRef.getInstances !== 'function') return fallbackEntries();

    let list = null;
    try {
      list = modelLoaderRef.getInstances();
    } catch (_) {
      list = null;
    }
    if (!Array.isArray(list) || list.length === 0) return fallbackEntries();

    const staged = stageModels();
    const entries = [];
    for (let i = 0; i < list.length; i += 1) {
      const snap = list[i];
      if (!snap || typeof snap !== 'object') continue;
      const id = normalizeId(snap.id, i);

      let model = looksLikeModel(snap.model) ? snap.model : null;

      if (!model && typeof modelLoaderRef.getInstanceModel === 'function') {
        try { model = modelLoaderRef.getInstanceModel(id) || null; } catch (_) { model = null; }
      }
      if (!looksLikeModel(model) && typeof modelLoaderRef.getInstance === 'function') {
        try {
          const one = modelLoaderRef.getInstance(id);
          model = looksLikeModel(one) ? one : (one && looksLikeModel(one.model) ? one.model : null);
        } catch (_) { model = null; }
      }
      if (!looksLikeModel(model) && staged.length === list.length && looksLikeModel(staged[i])) {
        // 兜底：stage 子节点顺序 = 实例创建顺序（契约 acceptance ①）
        model = staged[i];
      }
      if (looksLikeModel(model)) entries.push({ id, model });
    }
    return entries.length ? entries : fallbackEntries();
  }

  /** 按 id 查 model；不存在 → null */
  function findInstanceModel(id) {
    if (!id) return null;
    const entries = getInstanceEntries();
    for (let i = 0; i < entries.length; i += 1) {
      if (entries[i].id === id) return entries[i].model;
    }
    return null;
  }

  /** 切换活动实例（失败不影响交互） */
  function activate(id) {
    if (!id || !modelLoaderRef || typeof modelLoaderRef.setActiveInstance !== 'function') return;
    try { modelLoaderRef.setActiveInstance(id); } catch (_) { /* 忽略 */ }
  }

  // ---------------- 命中判定 ----------------

  /**
   * 判断坐标是否落在**单个模型的**可点区域：
   * 1) model.hitTest（模型作者定义的 hit areas）
   * 2) 「绘制内容包围盒」（drawable 顶点并集，排除画布透明留白）
   * 3) 兜底画布包围盒 getBounds()
   * @param {object} model 目标模型
   * @param {number} x
   * @param {number} y
   * @returns {boolean}
   */
  function hitTestModelAt(model, x, y) {
    if (!model || model.visible === false) return false;

    // 1) 精判：Cubism2/4 的 model.hitTest 依据模型作者定义的 hit areas，返回命中的区域名数组
    if (typeof model.hitTest === 'function') {
      try {
        const areas = model.hitTest(x, y);
        if (Array.isArray(areas) && areas.length > 0) return true;
      } catch (_) { /* 部分模型无 hit areas 定义时可能抛错，忽略 */ }
    }

    const settings = (model.internalModel && model.internalModel.settings) || {};
    const hitAreas = settings.hitAreas;
    const hasHitAreas = Array.isArray(hitAreas)
      ? hitAreas.length > 0
      : !!(hitAreas && Object.keys(hitAreas).length > 0);

    // 2) 即便模型定义了 hit areas，也可能只覆盖局部（如「肥牛」的 HitArea 只圈住身体）。
    //    用户要求「整只可见人物」都可拖 → 不一刀切 return false，继续用「绘制内容包围盒」兜底。
    void hasHitAreas; // 保留语义（诊断/后续扩展用），命中判定改由内容包围盒兜底

    // 3)「绘制内容包围盒」（对声明/未声明 hit areas 的模型都生效），
    //    而非整块画布 getBounds()（画布含大量透明留白 → 可交互矩形明显偏大/偏移）。
    if (typeof modelLoaderRef.getContentBounds === 'function') {
      try {
        const cb = modelLoaderRef.getContentBounds(model);
        if (cb && cb.width > 0 && cb.height > 0) {
          return x >= cb.x && x <= cb.x + cb.width && y >= cb.y && y <= cb.y + cb.height;
        }
      } catch (_) { /* 忽略 */ }
    }

    // 4) 内容包围盒不可用 → 最后退回画布包围盒（getBounds 已含锚点与缩放）
    if (typeof model.getBounds === 'function') {
      try {
        const bounds = model.getBounds();
        if (bounds.contains(x, y)) return true;
      } catch (_) { /* 忽略 */ }
    }
    return false;
  }

  /**
   * 命中判定（多实例）：逆序遍历实例（后创建 = 上层），返回首个命中实例 id。
   * @param {number} x
   * @param {number} y
   * @returns {string|null}
   */
  function hitTestInstance(x, y) {
    const entries = getInstanceEntries();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (!entry || !entry.model || entry.model.visible === false) continue;
      if (hitTestModelAt(entry.model, x, y)) return entry.id;
    }
    return null;
  }

  /** 既有签名兼容：是否命中任一实例 */
  function hitTestModel(x, y) {
    return hitTestInstance(x, y) !== null;
  }

  // ---------------- 拖拽边缘可见比例 / 回弹 ----------------

  /** 视口尺寸：优先 window.innerWidth/Height（与 model.x/y 同系），无则退化为渲染画布尺寸 */
  function getViewport() {
    let width = 0;
    let height = 0;
    if (typeof window !== 'undefined') {
      width = window.innerWidth || 0;
      height = window.innerHeight || 0;
    }
    const screen = app && app.renderer && app.renderer.screen;
    if ((!width || !height) && screen) {
      width = screen.width || width;
      height = screen.height || height;
    }
    return { width, height };
  }

  /**
   * 计算模型置于 (mx,my) 时，其包围盒与窗口 [0,0,W,H] 相交的「可见面积比例」。
   * 说明：包围盒相对模型原点的偏移在纯平移下不变，故可用当前 getBounds() 推算任意目标位置的矩形，
   * 避免为试算而反复修改 model.x/y。
   */
  function visibleRatio(model, mx, my, W, H) {
    let bounds;
    try {
      bounds = model.getBounds();
    } catch (_) {
      return 1; // 无法获取包围盒时不做干预
    }
    if (!bounds || !bounds.width || !bounds.height) return 1;

    const offsetX = bounds.x - model.x;
    const offsetY = bounds.y - model.y;
    const rectX = mx + offsetX;
    const rectY = my + offsetY;
    const w = bounds.width;
    const h = bounds.height;

    const overlapX = Math.max(0, Math.min(rectX + w, W) - Math.max(rectX, 0));
    const overlapY = Math.max(0, Math.min(rectY + h, H) - Math.max(rectY, 0));
    const area = w * h;
    return area > 0 ? (overlapX * overlapY) / area : 0;
  }

  /**
   * 判断目标位置是否越出「最小可见比例」，越界则返回钳制后的位置（可见比例恰为 minVisibleRatio）。
   * 以 (safeX,safeY)（拖拽起点）为参照，沿 (safe→raw) 方向二分求临界点。
   * @returns {{x:number,y:number}|null} null = 未越界，无需钳制
   */
  function clampToMinVisible(model, safeX, safeY, rawX, rawY) {
    const minRatio = options.minVisibleRatio;
    if (!(minRatio > 0)) return null;
    const { width: W, height: H } = getViewport();
    if (W <= 0 || H <= 0) return null;

    const ratioAt = (mx, my) => visibleRatio(model, mx, my, W, H);

    if (ratioAt(rawX, rawY) >= minRatio) return null;              // 目标位置仍满足最小可见
    if (ratioAt(safeX, safeY) < minRatio) return { x: rawX, y: rawY }; // 参照点本身就越界：放弃钳制，避免抖动

    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 20; i += 1) {
      const mid = (lo + hi) / 2;
      if (ratioAt(safeX + (rawX - safeX) * mid, safeY + (rawY - safeY) * mid) >= minRatio) lo = mid;
      else hi = mid;
    }
    return { x: safeX + (rawX - safeX) * lo, y: safeY + (rawY - safeY) * lo };
  }

  /**
   * 位置回调（恰好一次）：本轮拖拽尚未回调过才发出。
   * @param {string|null} id 实例 id
   * @param {object|null} model 该实例模型（取其当前 x/y）
   */
  function notifyMovedOnce(id, model) {
    if (state.moveNotified) return;
    state.moveNotified = true;
    const target = model || findInstanceModel(id);
    if (!id || !target) return;
    if (typeof options.onInstanceMoved !== 'function') return;
    try {
      options.onInstanceMoved(id, target.x, target.y);
    } catch (_) { /* 回调异常不影响交互 */ }
  }

  /** 逐帧缓动：把**回弹所属实例**拉向回弹目标，收敛后停止并回调一次位置 */
  function applyBounce() {
    const b = state.bounce;
    if (!b) return;
    const model = findInstanceModel(b.instanceId) || (!b.instanceId ? currentModelSafe() : null);
    if (!model) {
      state.bounce = null;
      return;
    }
    const k = Math.min(1, Math.max(0, options.spring));
    model.x += (b.targetX - model.x) * k;
    model.y += (b.targetY - model.y) * k;
    if (Math.abs(b.targetX - model.x) < 0.5 && Math.abs(b.targetY - model.y) < 0.5) {
      model.x = b.targetX;
      model.y = b.targetY;
      state.bounce = null; // 收敛，停止回弹
      notifyMovedOnce(b.instanceId, model); // 回弹收敛 → 恰好一次位置回调
    }
  }

  // ---------------- 穿透联动 ----------------

  function setInteractive(want) {
    if (!state.autoPenetration) return;       // 未启用自动穿透（或用户关闭）时不做自动切换
    if (state.interactive === want) return;   // 去抖：状态未变化不跨进程通信
    state.interactive = want;
    bridge.setInteractive(want);
  }

  /**
   * 悬停判定（Electron mousemove 与 Tauri pollOnce 共用）：
   * 命中任一实例 或 命中设置面板 UI → 可点；否则穿透。
   */
  function updateHover(x, y) {
    const hit = hitTestInstance(x, y);
    const overUI = isPointerOverUI(x, y);
    setInteractive(!!hit || overUI);
  }

  /** 应用「悬停自动穿透」开关：开启且外壳支持轮询时启动轮询，关闭时停止。 */
  function applyAutoPenetration(value) {
    state.autoPenetration = !!value;
    if (!state.autoPenetration) {
      state.interactive = null; // 复位去抖状态，便于再次开启时正常下发
      stopPolling();
    } else if (canPoll()) {
      startPolling();
    }
  }

  // ---------------- 光标轮询（Tauri 逐区穿透） ----------------
  //
  // Tauri 的 setIgnoreCursorEvents(true) 不转发 mousemove，穿透态下前端收不到鼠标事件，
  // 无法用 mousemove 做悬停探测。故改为以固定间隔向 Rust 轮询「窗口内光标坐标」
  // （lib.rs 的 poll_cursor 命令），在前端完成命中判定后切换穿透：
  //   命中任一实例 / 设置面板 → 可点；其余区域 → 穿透（点击下传到桌面）。

  /** 轮询间隔（ms）：过高增加跨进程 IPC 频次，过低则进入/离开模型有可感延迟 */
  const POLL_INTERVAL_MS = 50;
  /** 连续读取失败（返回 null）达到该次数即停用轮询并降级为「常驻可点」，避免窗口永久不可交互 */
  const POLL_NULL_FAIL_LIMIT = 20;

  let pollTimer = 0;
  let pollInFlight = false;
  let pollNullStreak = 0;

  /** 是否具备「光标轮询」能力（Tauri 外壳） */
  function canPoll() {
    return !!(bridge && bridge.canPollCursor && typeof bridge.pollCursor === 'function');
  }

  /** 单次轮询：读取光标 → 命中判定 → 切换穿透（串行化，避免请求堆积） */
  async function pollOnce() {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const pos = await bridge.pollCursor();
      // 轮询期间状态可能已变化（关闭自动穿透 / 停用交互）：及时退出
      if (!state.enabled || !state.autoPenetration) return;

      // 拖拽 / 按下进行中：强制保持可点，避免轮询误判导致拖拽中断
      if (state.pending || state.dragging) {
        setInteractive(true);
        return;
      }

      if (!pos) {
        pollNullStreak += 1;
        // 连续读取失败：不可盲目常驻穿透（否则用户永远点不到），
        // 达到阈值后降级为「常驻可点」并停止轮询，保证可用性。
        if (pollNullStreak >= POLL_NULL_FAIL_LIMIT) {
          console.warn('[petInteraction] 光标轮询连续失败，降级为常驻可点');
          stopPolling();
          applyAutoPenetration(false);
          bridge.setInteractive(true);
        }
        return;
      }
      pollNullStreak = 0;

      // 光标不在窗口范围内：视为未命中 → 穿透，并清空视线参照
      const { width: W, height: H } = getViewport();
      const inside = pos.x >= 0 && pos.y >= 0
        && (W <= 0 || pos.x <= W) && (H <= 0 || pos.y <= H);
      if (!inside) {
        state.lastPointer = null;
        setInteractive(false);
        return;
      }

      // 更新视线跟随参照（穿透态下 mousemove 不可用，靠轮询驱动视线）
      state.lastPointer = { x: pos.x, y: pos.y };
      updateHover(pos.x, pos.y);
    } catch (_) {
      // 轮询异常不致命：保持当前穿透态，等待下一轮
      pollNullStreak += 1;
    } finally {
      pollInFlight = false;
    }
  }

  function startPolling() {
    if (pollTimer || !canPoll()) return;
    pollNullStreak = 0;
    pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = 0;
    }
  }

  // ---------------- 点击反应（按实例隔离重入锁） ----------------

  function isThenable(v) {
    return v && typeof v.then === 'function';
  }

  // 点击反应重入保护（按实例）：同一实例反应进行中忽略新点击（快速连点只触发一次），
  // 与 modelLoader.reactTap 内部的时间锁共同保证「不会叠加、不会残留张嘴、双击也能正确收尾」；
  // 不同实例互不影响。
  /** @type {Map<string, boolean>} */
  const reactionBusy = new Map();

  /**
   * 触发命中的实例的点击反应：先设为活动实例，再调用 reactTap(instanceId)。
   * @param {string|null} instanceId 命中的实例 id
   */
  async function triggerTapReaction(instanceId) {
    const id = instanceId || activeInstanceId() || 'inst-1';
    if (reactionBusy.get(id) === true) return false;
    reactionBusy.set(id, true);
    try {
      const model = findInstanceModel(id);
      if (!model) return false;
      activate(id); // 契约：点击反应只作用于命中实例，先切为活动实例
      return await doTriggerTapReaction(model, id);
    } finally {
      reactionBusy.set(id, false);
    }
  }

  async function doTriggerTapReaction(model, instanceId) {
    // 优先走 modelLoader.reactTap(id)：统一「可见表情 → 可见动作组 → 非嘴部参数反应 → 缩放兜底」的优先级
    if (modelLoaderRef && typeof modelLoaderRef.reactTap === 'function') {
      try {
        // 旧版单实例实现会忽略多余参数（缺省=活动实例），故传 id 对两者都安全
        const handled = instanceId
          ? await modelLoaderRef.reactTap(instanceId)
          : await modelLoaderRef.reactTap();
        if (handled) return true;
      } catch (_) {
        // reactTap 异常时走下方兜底
      }
    }

    // —— 兜底：依次尝试候选动作组，均无则随机表情，再无可静默（只作用于命中实例的模型）——
    const groups = options.tapMotionGroups || [];
    for (const group of groups) {
      try {
        const result = model.motion(group);
        const started = isThenable(result) ? await result : result;
        if (started) return true;
      } catch (_) {
        // 该组不存在或无法播放，继续尝试下一组
      }
    }

    return false;
  }

  // ---------------- 事件处理 ----------------

  function handleMove(x, y) {
    state.lastPointer = { x, y };

    if (state.pending) {
      if (!state.dragging) {
        const dx = x - state.startPointer.x;
        const dy = y - state.startPointer.y;
        if (Math.hypot(dx, dy) >= options.dragThreshold) state.dragging = true;
      }
      if (state.dragging) {
        // 拖拽：只移动「按下命中的实例」本体（不移动窗口、不影响其它实例）
        const model = findInstanceModel(state.draggingInstanceId) || currentModelSafe();
        if (model) {
          const rawX = state.dragStartModel.x + (x - state.startPointer.x);
          const rawY = state.dragStartModel.y + (y - state.startPointer.y);
          // 越出窗口到「最小可见比例」以下 → 钳制到临界点并缓动弹回
          const clamped = clampToMinVisible(model, state.dragStartModel.x, state.dragStartModel.y, rawX, rawY);
          if (clamped) {
            state.bounce = {
              instanceId: state.draggingInstanceId,
              targetX: clamped.x,
              targetY: clamped.y
            }; // 交给 ticker 逐帧缓动
          } else {
            state.bounce = null;
            model.x = rawX;
            model.y = rawY;
          }
        }
        setInteractive(true);   // 拖拽期间保持可点
        return;                 // 拖拽期间不刷新 hover，避免状态抖动
      }
    }

    updateHover(x, y);
  }

  function onMouseMove(e) {
    if (!state.enabled) return;
    handleMove(e.clientX, e.clientY);
  }

  function onMouseDown(e) {
    if (!state.enabled || e.button !== 0) return;

    const x = e.clientX;
    const y = e.clientY;

    // 命中设置面板等 UI：放行给 DOM，不拦截
    if (isPointerOverUI(x, y)) return;

    // 未命中任一实例：把事件「放行」给桌面（窗口此时应处于穿透态）
    const hitId = hitTestInstance(x, y);
    if (!hitId) return;

    const model = findInstanceModel(hitId) || currentModelSafe();
    if (!model) return;

    // 命中实例 → 切为活动实例（多实例下活动实例 = 最近一次交互的实例）
    activate(hitId);

    state.pending = true;
    state.dragging = false;
    state.draggingInstanceId = hitId;
    state.moveNotified = false;  // 新一轮拖拽：重置「位置回调」标记
    state.bounce = null;         // 新一次按下：中断上一轮回弹，避免目标位残留
    state.startPointer = { x, y };
    state.dragStartModel = { x: model.x, y: model.y };
    setInteractive(true);

    // 阻止默认行为，避免拖拽时选中文字/触发原生拖图
    if (typeof e.preventDefault === 'function') e.preventDefault();
  }

  function onMouseUp(e) {
    if (!state.enabled) return;
    const x = e.clientX;
    const y = e.clientY;
    finishInteraction(x, y);
  }

  /** 鼠标离开窗口（含穿透态下由外壳转发的 leave） */
  function onMouseLeave() {
    if (!state.enabled) return;
    state.lastPointer = null;
    if (!state.dragging) setInteractive(false);
  }

  function finishInteraction(x, y) {
    const wasPending = state.pending;
    const wasDragging = state.dragging;
    const hitId = state.draggingInstanceId;
    state.pending = false;
    state.dragging = false;

    // 点击（按下且几乎未移动）→ 触发命中实例的动作/表情
    if (wasPending && !wasDragging && hitId) {
      triggerTapReaction(hitId);
    }

    // 拖拽结束且未进入回弹 → 回弹收敛分支不适用时才在此回调（恰好一次）
    if (wasDragging && !state.bounce) {
      notifyMovedOnce(hitId, findInstanceModel(hitId));
    }

    state.draggingInstanceId = null;
    updateHover(x, y);
  }

  // ---------------- 视线跟随（逐帧，逐实例；参照中心 = 人物头部） ----------------

  /** 受限的头部锚点比例（0.05~0.6，默认 0.25） */
  function headRatio() {
    const n = Number(options.headAnchorRatio);
    return isFinite(n) ? Math.min(0.6, Math.max(0.05, n)) : 0.25;
  }

  /**
   * 计算传给 model.focus 的目标坐标。
   *
   * pixi-live2d-display 的 focus(x,y) 会把屏幕坐标换算到模型局部，再按模型宽高归一化，
   * 因此其「视线中位」固定在 **画布中心**（≈ 人物胸腹），并没有对准头部。
   * 这里做一次平移，把参照中心上移到人物头部（与 Unity 版思路一致：头 ≈ 模型高度的上部 ~25%）：
   *
   *   headRef = 画布包围盒的「水平中心 + 高度上部 headAnchorRatio 处」
   *   target  = 画布中心 + (鼠标 - headRef)
   *
   * 效果：鼠标落在头部参照点 → 视线居中；在头部上方 → 抬头，下方 → 低头；左右对应。
   */
  function computeFocusTarget(model, pointer) {
    let canvas = null;
    try {
      const b = model.getBounds();
      canvas = { x: b.x, y: b.y, width: b.width, height: b.height };
    } catch (_) { canvas = null; }
    if (!canvas || !(canvas.width > 0) || !(canvas.height > 0)) return null;

    const ratio = headRatio();

    // 头部参照框：无 hit areas 的模型（导入模型在画布中不居中）改用「绘制内容包围盒」，
    // 使视线中心落在人物头部；有 hit areas 的模型沿用画布（既有已验收行为）。
    let ref = canvas;
    const hasHitAreas = typeof modelLoaderRef.modelHasHitAreas === 'function'
      ? modelLoaderRef.modelHasHitAreas(model)
      : true;
    if (!hasHitAreas && typeof modelLoaderRef.getContentBounds === 'function') {
      try {
        const cb = modelLoaderRef.getContentBounds(model);
        if (cb && cb.width > 0 && cb.height > 0) ref = cb;
      } catch (_) { /* 保留画布参照 */ }
    }

    const headX = ref.x + ref.width / 2;
    const headY = ref.y + ref.height * ratio;
    // 中立点仍为「画布中心」：pixi-live2d-display 的 focus 按画布宽高归一化（中心=画布中心）
    const centerX = canvas.x + canvas.width / 2;
    const centerY = canvas.y + canvas.height / 2;

    return { x: centerX + (pointer.x - headX), y: centerY + (pointer.y - headY) };
  }

  /** 对单个实例执行焦点跟随（异常隔离，不影响其它实例） */
  function focusInstance(model, pointer) {
    if (!model || model.visible === false) return;
    try {
      // x/y 为窗口内像素坐标（stage 未做变换，等价于全局坐标）
      const target = computeFocusTarget(model, pointer);
      if (target) model.focus(target.x, target.y);
      else model.focus(pointer.x, pointer.y);
      // 抑制视线跟随引发的「整体左右晃动」：只把躯干参数（BodyAngleX/Z）缩放到 ~0.25 倍写回，
      // 不动 ParamAngleX/Y/Z 与眼球参数，故不影响头部/视线跟随。
      if (typeof modelLoaderRef.suppressBodySway === 'function') {
        modelLoaderRef.suppressBodySway(model, 0.25);
      }
    } catch (_) {
      // 单实例某个时刻 focus 不可用：忽略，继续处理其它实例
    }
  }

  function onTicker() {
    applyBounce();   // 回弹缓动始终生效（含拖拽进行中与松手后收敛）
    if (!state.enabled || !options.enableFocus) return;
    const pointer = state.lastPointer;
    if (!pointer) return;
    const entries = getInstanceEntries();
    for (let i = 0; i < entries.length; i += 1) {
      focusInstance(entries[i].model, pointer);
    }
  }

  // ---------------- 滚轮缩放（命中任一实例即全局缩放） ----------------

  function onWheel(e) {
    if (!state.enabled) return;

    const x = e.clientX;
    const y = e.clientY;

    // 悬停在设置面板等 UI 上：交还 DOM 处理面板内滚动，不做缩放
    if (isPointerOverUI(x, y)) return;

    // 仅当光标悬停在任一人物的可见区域才缩放，其余透明处滚轮不生效（可穿透给桌面）
    if (hitTestInstance(x, y) === null) return;

    const delta = Number(e.deltaY);
    if (!isFinite(delta) || delta === 0) return;

    const step = Math.max(1, Number(options.wheelZoomStep) || 5);
    const minP = Number(options.minScalePercent);
    const maxP = Number(options.maxScalePercent);
    const lo = isFinite(minP) ? minP : 10;
    const hi = isFinite(maxP) ? maxP : 300;

    const current = (typeof modelLoaderRef.getScalePercent === 'function')
      ? Number(modelLoaderRef.getScalePercent())
      : 100;
    const dir = delta < 0 ? 1 : -1; // 上滚（deltaY<0）放大，下滚缩小
    const next = Math.min(hi, Math.max(lo, (isFinite(current) ? current : 100) + dir * step));
    if (next === current) return;   // 已到上下限，吞掉事件但不再变更

    // 阻止页面默认滚动；已命中模型，缩放为预期行为
    if (typeof e.preventDefault === 'function') e.preventDefault();

    // 全局缩放：所有实例同步（C-MODEL-INSTANCES@1 的 setScalePercent）
    if (typeof modelLoaderRef.setScalePercent === 'function') {
      modelLoaderRef.setScalePercent(next);
    }
    if (typeof options.onScaleChange === 'function') {
      try { options.onScaleChange(next); } catch (_) { /* 回调异常不影响缩放 */ }
    }
    // 缩放后人物位置/尺寸变化，刷新一次悬停态避免交互区残留
    updateHover(x, y);
  }

  // ---------------- 装配 ----------------

  let attached = false;

  function attach() {
    if (attached) return;
    attached = true;
    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('mousedown', onMouseDown, { passive: false });
    window.addEventListener('mouseup', onMouseUp, { passive: true });
    window.addEventListener('mouseleave', onMouseLeave, { passive: true });
    window.addEventListener('wheel', onWheel, { passive: false }); // 需 preventDefault，故非 passive
    app.ticker.add(onTicker);

    // 初始应处于穿透态（由 main 统一下发，这里兜底再确认一次）
    setInteractive(false);

    // Tauri：启动光标轮询以驱动「逐区穿透」（穿透态下 mousemove 不可用）
    if (state.autoPenetration && canPoll()) startPolling();
  }

  function detach() {
    if (!attached) return;
    attached = false;
    state.bounce = null;
    state.draggingInstanceId = null;
    state.moveNotified = false;
    stopPolling();
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('mouseleave', onMouseLeave);
    window.removeEventListener('wheel', onWheel);
    app.ticker.remove(onTicker);
  }

  return {
    attach,
    detach,
    /** 运行时启停（隐藏/停用交互） */
    setEnabled(value) {
      state.enabled = !!value;
      if (!state.enabled) {
        state.pending = false;
        state.dragging = false;
        state.draggingInstanceId = null;
        state.moveNotified = false;
        state.lastPointer = null;
        state.bounce = null;
        stopPolling(); // 停用交互时无需轮询
      } else if (state.autoPenetration) {
        startPolling(); // 重新启用：恢复轮询
      }
    },
    /**
     * 切换「悬停自动穿透」。
     * true  = 悬停命中任一实例/面板才让窗口可点，离开即穿透
     *         （Electron 经 mousemove 转发；Tauri 经光标轮询）；
     * false = 停止自动切换（窗口常驻可点，由调用方决定）。
     */
    setAutoPenetration(value) {
      applyAutoPenetration(value);
    },
    isAutoPenetration() {
      return state.autoPenetration;
    },
    /** 外部（如模型切换/添加实例后）主动同步一次穿透态 */
    syncHover(x, y) {
      if (!state.enabled) return;
      updateHover(x, y);
    },
    hitTestInstance,
    hitTestModel,
    getState() {
      const instances = [];
      try {
        const entries = getInstanceEntries();
        for (let i = 0; i < entries.length; i += 1) {
          const entry = entries[i];
          if (!entry || !entry.model) continue;
          instances.push({ id: entry.id, x: entry.model.x, y: entry.model.y });
        }
      } catch (_) { /* 调试信息不影响主流程 */ }
      return {
        ...state,
        draggingInstanceId: state.draggingInstanceId || null,
        instances,
        options: { ...options }
      };
    }
  };
}

export { createPetInteraction };
export default createPetInteraction;