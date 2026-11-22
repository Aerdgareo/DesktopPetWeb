/**
 * instances.js —— 实例编排与持久化（提供契约 C-INSTANCE-STORE@1）
 *
 * 定位：`main.js` 与 `modelLoader` 之间**唯一**的实例状态管理者。main 只调用本模块，
 *       不直接读写实例相关的 localStorage 键。
 *
 * 职责：
 *  - restoreAll()        启动时按持久化记录逐项恢复实例（加载 → 回填位置 → 恢复活动实例）
 *  - addFromCatalog()    按上限新增实例（单调分配 id、默认排布、立即持久化）
 *  - remove() / select() 移除与选中，并同步持久化
 *  - rememberPosition()  拖拽结束位置回写（200ms 节流）
 *  - persistNow()        取消防抖，立即落盘
 *  - list() / activeId() / canAdd() / destroy()
 *
 * 持久化键（固定，见计划 2.3.4）：
 *  - `pet.instances.v1`       JSON 数组 `PersistedInstance[]`，顺序 = 创建顺序
 *  - `pet.instances.activeId` `inst-<n>` 或空串
 *
 * 关键约束：
 *  1. 一律持久化**原始路径 rawUrl**，禁止把 `asset://` URL 写进 localStorage：
 *     asset 协议地址由外壳即时转换，重启/换会话后可能失效，加载时必须重新 resolve。
 *  2. 所有 localStorage 访问均包 try/catch：隐私模式、配额写满、禁用存储时静默降级为
 *     "不持久化"，绝不能让异常中断启动流程或抛给调用方。
 *  3. 持久化数据损坏 / 非数组 / 缺必填字段 → 跳过该项（console.warn），不影响其它项；
 *     超过 6 项只取前 6 项。
 */

/** 实例数量上限（R3-1） */
const MAX_INSTANCES = 6;

/** localStorage 键（固定，禁止改名） */
const KEY_LIST = 'pet.instances.v1';
const KEY_ACTIVE = 'pet.instances.activeId';

/** 位置回写节流窗口（ms） */
const PERSIST_THROTTLE_MS = 200;

/**
 * 新实例默认位置（窗口宽高的比例表）。
 * 序号 n = 当前实例数 + 1（夹到 1..6），与计划 2.2.8 的表严格一致：
 *   1 → (0.50W, 1.00H)  2 → (0.28W, 0.96H)  3 → (0.72W, 0.96H)
 *   4 → (0.15W, 0.92H)  5 → (0.85W, 0.92H)  6 → (0.50W, 0.88H)
 */
const DEFAULT_POSITION_RATIO = [
  [0.50, 1.00],
  [0.28, 0.96],
  [0.72, 0.96],
  [0.15, 0.92],
  [0.85, 0.92],
  [0.50, 0.88]
];

/**
 * @typedef {Object} PersistedInstance
 * @property {string} id     实例标识（"inst-<n>"，单调分配、删除后不复用）
 * @property {string} rawUrl 原始模型路径（禁止 asset://）
 * @property {string} name   显示名
 * @property {number} x      窗口内 CSS 像素坐标
 * @property {number} y      窗口内 CSS 像素坐标
 */

/**
 * @typedef {Object} InstanceSnapshot
 * @property {string} id
 * @property {string} url      已解析的可加载 URL
 * @property {string} rawUrl   原始路径
 * @property {string} name     显示名
 * @property {string} kind     'Cubism 2.1' | 'Cubism 4' | '未知'
 * @property {number} x
 * @property {number} y
 * @property {boolean} active  是否活动实例
 */

/**
 * @typedef {Object} InstanceStoreDeps
 * @property {object} modelLoader                  需实现 C-MODEL-INSTANCES@1
 *   （addInstance / getInstances / getInstance / setInstancePosition /
 *     getInstancePosition / setActiveInstance / getActiveInstanceId / removeInstance）
 * @property {(rawUrl: string) => string} resolveUrl 原始路径 → 可加载 URL（= main.js 的 resolveModelUrl）
 * @property {(msg: string, ms?: number) => void} [notify] toast 提示（超限等），缺省静默
 */

/**
 * @typedef {Object} InstanceStore
 * @property {() => Promise<Array<InstanceSnapshot>>} restoreAll
 * @property {(url: string, meta: {name?: string}, rawUrl?: string) => Promise<InstanceSnapshot>} addFromCatalog
 * @property {(id: string) => boolean} remove
 * @property {(id: string) => boolean} select
 * @property {(id: string, x: number, y: number) => void} rememberPosition
 * @property {() => void} persistNow
 * @property {() => Array<InstanceSnapshot>} list
 * @property {() => (string|null)} activeId
 * @property {() => boolean} canAdd
 * @property {() => void} destroy
 */

// ---------------- 通用小工具 ----------------

/** 取错误可读文案（仅用于日志） */
function describeError(err) {
  if (err && typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}

/**
 * 归一化实例 id（非字符串 / 空白 → 空串）。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 归一化有限数（不可用 → 返回 fallback）。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/** 取 localStorage（不可用 → null；隐私模式访问本身可能抛错） */
function getStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (_) {
    return null;
  }
}

/** 窗口可视尺寸（CSS 像素；下限 1，避免除零/零尺寸布局） */
function viewportSize() {
  const read = (value) => {
    const num = Number(value);
    return Number.isFinite(num) && num > 1 ? num : 1;
  };
  if (typeof window === 'undefined') return { W: 1, H: 1 };
  return { W: read(window.innerWidth), H: read(window.innerHeight) };
}

/** 按「第 n 个实例」取默认位置（n = 实例数 + 1，夹到 1..6） */
function defaultPositionFor(instanceCount) {
  const rawN = Math.floor(Number(instanceCount)) + 1;
  const n = Math.min(MAX_INSTANCES, Math.max(1, Number.isFinite(rawN) ? rawN : 1));
  const ratio = DEFAULT_POSITION_RATIO[n - 1];
  const { W, H } = viewportSize();
  return { x: ratio[0] * W, y: ratio[1] * H };
}

/** 从 "inst-12" 解析序号；非法 → 0 */
function parseInstanceSeq(id) {
  const match = /^inst-(\d+)$/.exec(normalizeId(id));
  if (!match) return 0;
  const num = Number(match[1]);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

/**
 * 校验一条持久化记录是否可用。
 * 必填：id 与 rawUrl 均为非空字符串；rawUrl 不得是 asset://（不可持久化的外壳地址）。
 * @param {unknown} raw
 * @returns {boolean}
 */
function isValidPersistedEntry(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (raw);
  const id = normalizeId(record.id);
  const rawUrl = normalizeId(record.rawUrl);
  if (!id || !rawUrl) return false;
  if (/^asset:/i.test(rawUrl)) return false;
  return true;
}

/**
 * 把合法记录归一为内存条目。
 * 可选字段缺失时的降级（避免因一个可选字段丢掉整个实例）：
 *  - name 缺失 → 用 id（真正显示名由 modelLoader 依据 URL 派生并回写）
 *  - x/y 缺失或非有限数 → 该下标对应的默认位置
 * @param {Record<string, unknown>} raw
 * @param {number} index 在截断后的数组中的下标
 * @returns {PersistedInstance}
 */
function toPersistedEntry(raw, index) {
  const id = normalizeId(raw.id);
  const rawUrl = normalizeId(raw.rawUrl);
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id;
  const fallback = defaultPositionFor(index);
  return {
    id,
    rawUrl,
    name,
    x: normalizeNumber(raw.x, fallback.x),
    y: normalizeNumber(raw.y, fallback.y)
  };
}

// ---------------- 工厂 ----------------

/**
 * 创建实例编排与持久化 store。
 * @param {InstanceStoreDeps} deps
 * @returns {InstanceStore}
 * @throws {TypeError} deps.modelLoader 缺失或未实现 addInstance
 */
export function createInstanceStore(deps) {
  const modelLoader = deps && deps.modelLoader;
  if (!modelLoader || typeof modelLoader.addInstance !== 'function') {
    throw new TypeError('createInstanceStore 需要 modelLoader（需实现 C-MODEL-INSTANCES@1 的 addInstance）');
  }
  /** 原始路径 → 可加载 URL（缺省视为恒等，便于单测/降级） */
  const resolveUrl = (typeof deps.resolveUrl === 'function') ? deps.resolveUrl : (rawUrl) => rawUrl;
  /** toast 提示（缺省静默） */
  const notify = (typeof deps.notify === 'function') ? deps.notify : () => {};

  /**
   * 闭包内部状态。
   *  - entries：内存镜像的持久化数组（顺序 = 创建顺序）
   *  - activeId：活动实例 id（空串 = 无），与 localStorage 键同义
   *  - seq：本会话已分配过的最大序号（保证删除后不复用）
   *  - timer：节流定时器句柄（null = 无待写任务）
   */
  const state = {
    entries: /** @type {PersistedInstance[]} */ ([]),
    activeId: '',
    seq: 0,
    timer: /** @type {ReturnType<typeof setTimeout>|null} */ (null),
    destroyed: false
  };

  // -------- 安全调用 modelLoader（任何异常都不上抛给调用方） --------

  /**
   * 读取实例快照数组；异常 → 空数组（silent=false 时 warn 一次）。
   * @param {{ silent?: boolean }} [opts]
   * @returns {Array<InstanceSnapshot>}
   */
  function readInstances(opts) {
    try {
      const arr = modelLoader.getInstances();
      return Array.isArray(arr) ? arr : [];
    } catch (err) {
      if (!(opts && opts.silent)) {
        console.warn('[instances] 读取实例列表失败：', describeError(err));
      }
      return [];
    }
  }

  /**
   * 读取单个实例快照；不存在/异常 → null。
   * @param {string} id
   * @returns {InstanceSnapshot|null}
   */
  function readInstance(id) {
    const key = normalizeId(id);
    if (!key || typeof modelLoader.getInstance !== 'function') return null;
    try {
      const snap = modelLoader.getInstance(key);
      return snap && typeof snap === 'object' ? snap : null;
    } catch (_) {
      return null;
    }
  }

  /** 写入位置（内部已夹取到窗口范围）；异常 → false */
  function applyPosition(id, x, y) {
    if (typeof modelLoader.setInstancePosition !== 'function') return false;
    try {
      return modelLoader.setInstancePosition(id, x, y) === true;
    } catch (err) {
      console.warn(`[instances] 设置实例 ${id} 位置失败：`, describeError(err));
      return false;
    }
  }

  /** 读取位置；异常 → null */
  function readPosition(id) {
    if (typeof modelLoader.getInstancePosition !== 'function') return null;
    try {
      const pos = modelLoader.getInstancePosition(id);
      return pos && typeof pos === 'object' ? pos : null;
    } catch (_) {
      return null;
    }
  }

  /** 设置活动实例；异常 → false */
  function applyActive(id) {
    if (typeof modelLoader.setActiveInstance !== 'function') return false;
    try {
      return modelLoader.setActiveInstance(id) === true;
    } catch (err) {
      console.warn(`[instances] 设置活动实例 ${id} 失败：`, describeError(err));
      return false;
    }
  }

  /** 读取 modelLoader 当前活动实例 id；无/异常 → 空串 */
  function readLoaderActiveId() {
    if (typeof modelLoader.getActiveInstanceId !== 'function') return '';
    try {
      return normalizeId(modelLoader.getActiveInstanceId());
    } catch (_) {
      return '';
    }
  }

  /** 移除实例（不删磁盘）；异常 → false */
  function applyRemove(id) {
    if (typeof modelLoader.removeInstance !== 'function') return false;
    try {
      return modelLoader.removeInstance(id) === true;
    } catch (err) {
      console.warn(`[instances] 移除实例 ${id} 失败：`, describeError(err));
      return false;
    }
  }

  /** 原始路径 → 可加载 URL（resolveUrl 抛出/返回空 → 退回原始值） */
  function toLoadableUrl(rawUrl) {
    const raw = normalizeId(rawUrl);
    if (!raw) return '';
    try {
      const resolved = resolveUrl(raw);
      return typeof resolved === 'string' && resolved ? resolved : raw;
    } catch (err) {
      console.warn(`[instances] 解析模型路径失败，改用原始值：${raw}`, describeError(err));
      return raw;
    }
  }

  // -------- localStorage 读写（全部 try/catch） --------

  /** 读取原始字符串键；不可用 → null */
  function readKey(key) {
    const storage = getStorage();
    if (!storage) return null;
    try {
      return storage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  /** 写入字符串键；失败仅 warn（不抛错） */
  function writeKey(key, value) {
    const storage = getStorage();
    if (!storage) return;
    try {
      storage.setItem(key, value);
    } catch (err) {
      console.warn(`[instances] 写入 localStorage ${key} 失败（本次不持久化）：`, describeError(err));
    }
  }

  /**
   * 读取持久化实例数组（容错解析）。
   * 规则：JSON 损坏/非数组 → []；超过 6 项先截断到前 6；非法项跳过；重复 id 跳过。
   * @returns {PersistedInstance[]}
   */
  function readPersistedList() {
    const text = readKey(KEY_LIST);
    if (!text) return [];

    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      console.warn('[instances] 持久化实例 JSON 损坏，按空列表处理：', describeError(err));
      return [];
    }
    if (!Array.isArray(parsed)) {
      console.warn('[instances] 持久化实例不是数组，按空列表处理');
      return [];
    }

    // 严格「超过 6 项只取前 6」：先截断再逐项校验，不从第 7 项回补
    const head = parsed.slice(0, MAX_INSTANCES);
    /** @type {PersistedInstance[]} */
    const out = [];
    const seen = new Set();
    for (let i = 0; i < head.length; i += 1) {
      const raw = head[i];
      if (!isValidPersistedEntry(raw)) {
        console.warn(`[instances] 跳过第 ${i + 1} 条无效持久化实例（缺 id/rawUrl 或为 asset:// 地址）`);
        continue;
      }
      const entry = toPersistedEntry(/** @type {Record<string, unknown>} */ (raw), i);
      if (seen.has(entry.id)) {
        console.warn(`[instances] 跳过重复的持久化实例 id：${entry.id}`);
        continue;
      }
      seen.add(entry.id);
      out.push(entry);
    }
    return out;
  }

  /** 读取持久化的活动实例 id；无/异常 → 空串 */
  function readPersistedActiveId() {
    const value = readKey(KEY_ACTIVE);
    return normalizeId(value);
  }

  /** 立即写入活动实例键（空 → 写空串，不删键） */
  function writeActiveId() {
    writeKey(KEY_ACTIVE, state.activeId || '');
  }

  /** 立即写入实例列表键（过滤掉不可持久化的 asset:// 项，遵守约束 1） */
  function writeList(entries) {
    /** @type {PersistedInstance[]} */
    const payload = [];
    for (const entry of entries) {
      if (!entry || !normalizeId(entry.rawUrl)) continue;
      if (/^asset:/i.test(normalizeId(entry.rawUrl))) {
        console.warn(`[instances] 实例 ${entry.id} 的原始路径为 asset:// 地址，禁止持久化，已跳过`);
        continue;
      }
      payload.push({
        id: entry.id,
        rawUrl: entry.rawUrl,
        name: entry.name,
        x: normalizeNumber(entry.x, 0),
        y: normalizeNumber(entry.y, 0)
      });
    }
    writeKey(KEY_LIST, JSON.stringify(payload));
  }

  // -------- 持久化调度 --------

  /** 清除待写定时器（幂等） */
  function clearTimer() {
    if (state.timer === null) return;
    try {
      clearTimeout(state.timer);
    } catch (_) { /* 忽略 */ }
    state.timer = null;
  }

  /**
   * 以 modelLoader 的实例列表为权威，校准内存条目并落盘。
   * - 实例存在：rawUrl/name 优先取快照（回退缓存），位置取快照真实坐标（回退缓存）
   * - 实例不存在：内存条目一并丢弃（持久化与"当前显示的实例"保持一致）
   * - modelLoader 无实例但内存有条目（加载中/全部卸载）：保留缓存，不丢用户数据
   * @returns {PersistedInstance[]}
   */
  function collectEntries() {
    const snapshots = readInstances();
    if (!snapshots.length) return state.entries.slice();

    /** @type {Map<string, PersistedInstance>} */
    const cachedById = new Map(state.entries.map((entry) => [entry.id, entry]));
    /** @type {PersistedInstance[]} */
    const out = [];
    for (const snap of snapshots) {
      const id = normalizeId(snap && snap.id);
      if (!id) continue;
      const cached = cachedById.get(id);
      const rawUrl = normalizeId(snap.rawUrl) || (cached ? normalizeId(cached.rawUrl) : '');
      if (!rawUrl) {
        console.warn(`[instances] 实例 ${id} 缺少原始路径 rawUrl，本次不写入持久化`);
        continue;
      }
      const name = (typeof snap.name === 'string' && snap.name.trim())
        ? snap.name.trim()
        : ((cached && cached.name) || id);
      // 位置：以内存条目（rememberPosition 显式回写的最新意图）优先，快照坐标兜底
      const snapX = normalizeNumber(snap.x, 0);
      const snapY = normalizeNumber(snap.y, 0);
      const x = cached ? normalizeNumber(cached.x, snapX) : snapX;
      const y = cached ? normalizeNumber(cached.y, snapY) : snapY;
      out.push({ id, rawUrl, name, x, y });
    }
    return out;
  }

  /**
   * 立即落盘（并取消待执行的节流任务）。
   * 顺序：先校准内存条目 → 写列表 → 写活动实例。
   */
  function persistNow() {
    clearTimer();
    state.entries = collectEntries();
    writeList(state.entries);
    writeActiveId();
  }

  /** 200ms 节流落盘（拖拽位置高频回写时合并写操作） */
  function schedulePersist() {
    if (state.destroyed || state.timer !== null) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      persistNow();
    }, PERSIST_THROTTLE_MS);
  }

  // -------- id 分配 --------

  /**
   * 分配下一个实例 id：取「现存条目 / 当前实例 / 本会话已分配」中的最大序号 +1。
   * 本会话分配过的序号记入 state.seq，因此删除实例后不会复用该序号（R3-10）。
   * @returns {string}
   */
  function nextInstanceId() {
    let maxSeq = state.seq;
    const consider = (id) => {
      const seq = parseInstanceSeq(id);
      if (seq > maxSeq) maxSeq = seq;
    };
    for (const entry of state.entries) consider(entry.id);
    for (const snap of readInstances({ silent: true })) consider(snap && snap.id);
    const next = maxSeq + 1;
    state.seq = next;
    return `inst-${next}`;
  }

  // -------- 对外 API --------

  /**
   * 启动恢复：按持久化记录逐项恢复实例。
   * 每项：resolveUrl(rawUrl) → addInstance({id,url,rawUrl,name}) → setInstancePosition(id,x,y)；
   * 单项失败 console.warn 后继续；最后按持久化的 activeId 恢复活动实例（无效则取首个）。
   * @returns {Promise<Array<InstanceSnapshot>>} 成功恢复的实例快照（空 → []，不自行挑选默认模型）
   */
  async function restoreAll() {
    const persisted = readPersistedList();
    state.entries = [];

    /** @type {Array<InstanceSnapshot>} */
    const restored = [];
    for (let i = 0; i < persisted.length; i += 1) {
      const item = persisted[i];
      const url = toLoadableUrl(item.rawUrl);
      if (!url) {
        console.warn(`[instances] 跳过实例 ${item.id}：原始路径无法解析为可加载 URL`);
        continue;
      }
      /** @type {InstanceSnapshot} */
      let snap;
      try {
        snap = await modelLoader.addInstance({
          id: item.id,
          url,
          rawUrl: item.rawUrl,
          name: item.name
        });
      } catch (err) {
        console.warn(`[instances] 恢复实例 ${item.id} 失败，已跳过：`, describeError(err));
        continue;
      }

      // 位置：用持久化值；缺失时已在 toPersistedEntry 落下默认排布。
      // setInstancePosition 内部会把越界坐标夹取到当前窗口范围内（R3-11）。
      applyPosition(item.id, item.x, item.y);
      const pos = readPosition(item.id) || { x: item.x, y: item.y };
      const name = (typeof snap.name === 'string' && snap.name.trim()) ? snap.name.trim() : item.name;

      state.entries.push({
        id: item.id,
        rawUrl: item.rawUrl,
        name,
        x: normalizeNumber(pos.x, item.x),
        y: normalizeNumber(pos.y, item.y)
      });
      state.seq = Math.max(state.seq, parseInstanceSeq(item.id));

      restored.push(readInstance(item.id) || {
        id: item.id,
        url: (typeof snap.url === 'string' && snap.url) ? snap.url : url,
        rawUrl: item.rawUrl,
        name,
        kind: (typeof snap.kind === 'string' && snap.kind) ? snap.kind : '未知',
        x: normalizeNumber(pos.x, item.x),
        y: normalizeNumber(pos.y, item.y),
        active: false
      });
    }

    // 活动实例：按持久化值恢复；无效（不存在/为空）→ 取首个
    const ids = restored.map((snap) => snap.id);
    const storedActive = readPersistedActiveId();
    let active = ids.indexOf(storedActive) >= 0 ? storedActive : (ids[0] || '');
    if (active && !applyActive(active)) active = ids[0] || '';
    state.activeId = active;

    return restored;
  }

  /**
   * 从模型清单新增一个实例（不替换既有实例）。
   * @param {string} url   模型 URL（已解析的 asset:// 或原始路径均可）
   * @param {{ name?: string }} [meta] 清单条目（取显示名）
   * @param {string} [rawUrl] 原始路径（持久化用；缺省用 url）
   * @returns {Promise<InstanceSnapshot>}
   * @throws {Error} url 为空 / asset:// 缺 rawUrl / 已达上限 / modelLoader 加载失败
   */
  async function addFromCatalog(url, meta, rawUrl) {
    const givenUrl = normalizeId(url);
    if (!givenUrl) throw new Error('新增实例需要模型 URL');

    const rawInput = normalizeId(rawUrl);
    // 未显式给原始路径时，url 本身即持久化路径；但 asset:// 无法持久化 → 必须由调用方给 rawUrl
    if (!rawInput && /^asset:/i.test(givenUrl)) {
      throw new Error('实例持久化需要原始路径 rawUrl');
    }
    const persistRawUrl = rawInput || givenUrl;

    if (!canAdd()) {
      notify('最多同时显示 6 个模型');
      throw new Error('最多同时显示 6 个模型');
    }

    // 默认排布序号 = **新增前**的实例数 + 1（夹 1..6）；必须在 addInstance 之前取
    const countBefore = readInstances({ silent: true }).length;
    const id = nextInstanceId();
    const loadUrl = toLoadableUrl(givenUrl);
    const nameInput = (meta && typeof meta.name === 'string' && meta.name.trim()) ? meta.name.trim() : '';

    /** @type {InstanceSnapshot} */
    let snap;
    try {
      snap = await modelLoader.addInstance({
        id,
        url: loadUrl,
        rawUrl: persistRawUrl,
        name: nameInput || undefined
      });
    } catch (err) {
      // 并发/上限竞争时 modelLoader 也会拒绝；给出与 canAdd 一致的可见提示
      if (describeError(err).includes('最多同时显示 6 个模型')) {
        notify('最多同时显示 6 个模型');
      }
      throw err;
    }

    // 默认排布：第 countBefore+1 个实例的位置（夹 1..6）
    const defaultPos = defaultPositionFor(countBefore);
    applyPosition(id, defaultPos.x, defaultPos.y);
    const pos = readPosition(id) || defaultPos;

    const name = (typeof snap.name === 'string' && snap.name.trim()) ? snap.name.trim() : (nameInput || id);
    state.entries.push({
      id,
      rawUrl: persistRawUrl,
      name,
      x: normalizeNumber(pos.x, defaultPos.x),
      y: normalizeNumber(pos.y, defaultPos.y)
    });
    state.seq = Math.max(state.seq, parseInstanceSeq(id));

    // 成功后：设为活动实例并立即落盘
    applyActive(id);
    state.activeId = id;
    persistNow();

    return readInstance(id) || {
      id,
      url: loadUrl,
      rawUrl: persistRawUrl,
      name,
      kind: '未知',
      x: normalizeNumber(pos.x, defaultPos.x),
      y: normalizeNumber(pos.y, defaultPos.y),
      active: true
    };
  }

  /**
   * 移除实例（仅移除显示与状态，不删磁盘模型）。
   * modelLoader 移除成功后从持久化删除并立即落盘；删的是活动实例则 activeId 同步为新活动（无 → 空串）。
   * @param {string} id
   * @returns {boolean} 是否成功移除
   */
  function remove(id) {
    const key = normalizeId(id);
    if (!key) return false;
    if (!applyRemove(key)) return false;

    state.entries = state.entries.filter((entry) => entry.id !== key);
    // modelLoader.removeInstance 已把活动实例回退为剩余最上层实例（无 → null）
    const loaderActive = readLoaderActiveId();
    state.activeId = loaderActive || '';
    persistNow();
    return true;
  }

  /**
   * 选中（设为活动）实例。
   * @param {string} id
   * @returns {boolean} id 不存在 → false
   */
  function select(id) {
    const key = normalizeId(id);
    if (!key) return false;
    if (!applyActive(key)) return false;
    state.activeId = key;
    writeActiveId();
    return true;
  }

  /**
   * 回写单个实例位置（拖拽结束回调），200ms 节流落盘。
   * 无效坐标（非有限数）忽略，避免写坏持久化数据。
   * @param {string} id
   * @param {number} x 窗口内 CSS 像素
   * @param {number} y 窗口内 CSS 像素
   * @returns {void}
   */
  function rememberPosition(id, x, y) {
    const key = normalizeId(id);
    if (!key) return;
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
      console.warn(`[instances] 忽略实例 ${key} 的无效位置：`, x, y);
      return;
    }

    const entry = state.entries.find((item) => item.id === key);
    if (entry) {
      entry.x = nx;
      entry.y = ny;
    } else {
      // 未登记但确实存在的实例（外部直接 addInstance）：按快照补齐后再记录位置
      const snap = readInstance(key);
      if (!snap) return;
      state.entries.push({
        id: key,
        rawUrl: normalizeId(snap.rawUrl),
        name: (typeof snap.name === 'string' && snap.name) ? snap.name : key,
        x: nx,
        y: ny
      });
      state.seq = Math.max(state.seq, parseInstanceSeq(key));
    }
    schedulePersist();
  }

  /**
   * 当前实例快照（按创建顺序）。
   * @returns {Array<InstanceSnapshot>}
   */
  function list() {
    return readInstances();
  }

  /**
   * 当前活动实例 id。
   * @returns {string|null} 无 → null
   */
  function activeId() {
    return state.activeId || null;
  }

  /**
   * 是否还能新增实例（上限 6）。
   * @returns {boolean}
   */
  function canAdd() {
    try {
      return modelLoader.getInstances().length < MAX_INSTANCES;
    } catch (err) {
      console.warn('[instances] 读取实例数量失败，按内存条目判断上限：', describeError(err));
      return state.entries.length < MAX_INSTANCES;
    }
  }

  /**
   * 销毁 store：先立即落盘，再清定时器（不销毁模型，由调用方决定）。
   * 幂等。
   * @returns {void}
   */
  function destroy() {
    if (state.destroyed) {
      clearTimer();
      return;
    }
    persistNow();
    clearTimer();
    state.destroyed = true;
  }

  return {
    restoreAll,
    addFromCatalog,
    remove,
    select,
    rememberPosition,
    persistNow,
    list,
    activeId,
    canAdd,
    destroy
  };
}