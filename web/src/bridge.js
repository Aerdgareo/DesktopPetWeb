/**
 * bridge.js —— 桌宠外壳统一桥（Electron / Tauri / 浏览器降级）
 *
 * 目标：让 Web 渲染层用一套接口同时驱动 Electron 与 Tauri 两套外壳，
 * 浏览器直开（纯前端调试）时全部降级为 no-op，保证本地无需外壳即可预览。
 *
 * 外壳约定（由外壳侧提供，缺失即降级）：
 *   Electron (preload 注入 window.petAPI)：
 *     - setInteractive(bool)                  高级语义：true = 窗口可点，false = 鼠标穿透
 *     - 或 setIgnoreMouseEvents(bool, opts)   低级语义：true = 穿透
 *     - setAlwaysOnTop(bool)
 *     - quit()
 *     - getModelList() -> Promise<Array>      可选（外壳登记 + 外部目录合并清单）
 *     - importModel()  -> Promise<Object|null> 可选
 *     - scanModelResources(url) -> Promise<Object|null> 可选（主进程扫描模型目录资源）
 *     - pickExternalModelsDir()/getExternalModelsDirs()/removeExternalModelsDir()/clearExternalModelsDirs() 可选（外部模型地址，多根）
 *     - modelsBaseUrl                        外部模型协议基址（如 'petmodels://local/'）
 *     - 兼容旧接口 getExternalModelsDir()/clearExternalModelsDir()
 *   Tauri (window.__TAURI__)：
 *     - 主窗口 setIgnoreCursorEvents(bool) / setAlwaysOnTop(bool) / close()
 *     - 自定义命令（见 src-tauri/src/lib.rs）：
 *         invoke('get_model_list') / invoke('import_model') / invoke('delete_model', { idOrPath })
 *         invoke('poll_cursor') / invoke('set_interactive', { interactive })
 *         invoke('get_external_models_dirs') / invoke('pick_external_models_dir')
 *         invoke('remove_external_models_dir', { idOrPath }) / invoke('clear_external_models_dirs')
 *     - 外部模型资源经 Tauri asset 协议（convertFileSrc）暴露给 WebView
 *     - 模型来源三条：内置 models/（随前端分发）＋「导入到 exe 同级 models/」＋「引用外部文件夹」。
 *
 * 穿透语义说明（重要）：
 *   - Electron：`setIgnoreMouseEvents(true, { forward: true })` 穿透时仍能收到 mousemove，
 *     故直接由 mousemove 做「悬停命中判定」→ `canForwardMouseMove = true`。
 *   - Tauri：`setIgnoreCursorEvents(true)` 不转发 mousemove，无法悬停探测，故改为
 *     「Rust 侧读取窗口内光标（`poll_cursor`）→ 前端命中判定」的轮询方案 → `canPollCursor = true`。
 *   两者都能实现「鼠标在人物/设置面板上可点，其余区域点击穿透到桌面」。
 *
 * 双外壳共存说明（重要）：
 *   本文件同时服务于 Electron 与 Tauri：优先取 `window.petAPI`（Electron preload），
 *   否则取 `window.__TAURI__` 并走 invoke 命令。两种运行时的能力分支并存，互不干扰。
 */

const ELECTRON_API_KEYS = ['petAPI', 'desktopPetAPI', 'electronAPI'];

/** @returns {Object|null} Electron preload 暴露的 API 对象 */
function getElectronApi() {
  if (typeof window === 'undefined') return null;
  for (const key of ELECTRON_API_KEYS) {
    const api = window[key];
    if (api && typeof api === 'object') return api;
  }
  return null;
}

/** @returns {Object|null} Tauri 全局对象 */
function getTauriGlobal() {
  if (typeof window === 'undefined') return null;
  return window.__TAURI__ || null;
}

/**
 * 外部模型协议基址（Electron 外壳经 preload 暴露，如 'petmodels://local/'）。
 * 渲染层据此把相对模型路径解析到外部 models/ 目录；
 * Tauri 下无此基址（内置模型走相对路径、外部模型走 asset 协议），故为空串。
 * @returns {string}
 */
function getModelsBaseUrl() {
  const api = getElectronApi();
  const v = api && api.modelsBaseUrl;
  return typeof v === 'string' && v.length > 0 ? v : '';
}

const modelsBaseUrl = getModelsBaseUrl();

/** @returns {Object|null} Tauri 当前窗口对象（兼容 v1 / v2） */
function getTauriWindow() {
  const tauri = getTauriGlobal();
  if (!tauri) return null;
  const ns = tauri.window || tauri.webviewWindow || tauri.webview;
  if (!ns) return null;
  try {
    // Tauri v2: getCurrentWindow()；Tauri v1: getCurrent()
    if (typeof ns.getCurrentWindow === 'function') return ns.getCurrentWindow();
    if (typeof ns.getCurrent === 'function') return ns.getCurrent();
  } catch (err) {
    console.warn('[bridge] 获取 Tauri 窗口失败:', err);
  }
  // 某些构建直接暴露 appWindow
  return ns.appWindow || null;
}

/** 调用 Tauri 命令（不存在则返回 null） */
async function tauriInvoke(command, args) {
  const tauri = getTauriGlobal();
  if (!tauri) return null;
  // v2: __TAURI__.core.invoke；v1: __TAURI__.invoke
  const core = tauri.core || tauri;
  const invoke = core && core.invoke;
  if (typeof invoke !== 'function') return null;
  try {
    return await invoke(command, args);
  } catch (err) {
    console.warn(`[bridge] Tauri 命令 ${command} 不可用:`, err && err.message);
    return null;
  }
}

/**
 * 调用 Tauri 命令（严格模式：失败时**抛出**，由调用方捕获并展示具体错误）。
 *
 * 用于「导入模型 / 删除模型 / 外部目录增删」等用户可见操作：
 * 这些操作失败时必须让用户看到原因（例如目标目录不可写、被占用、越界），
 * 若沿用 [`tauriInvoke`] 的「吞错返回 null」，前端只能显示含糊的「已取消 / 失败」，
 * 表现为「点了没反应」。故此处单独提供严格版本。
 *
 * @param {string} command
 * @param {object} [args]
 * @throws {Error} 环境不支持 / 命令执行失败
 */
async function tauriInvokeStrict(command, args) {
  const tauri = getTauriGlobal();
  if (!tauri) throw new Error('当前环境不支持 Tauri 命令（未检测到 window.__TAURI__）');
  const core = tauri.core || tauri;
  const invoke = core && core.invoke;
  if (typeof invoke !== 'function') throw new Error('Tauri invoke 不可用');
  try {
    return await invoke(command, args);
  } catch (err) {
    // Tauri invoke 的错误可能是字符串或对象；统一转成可读 Error
    const msg = err && typeof err === 'object' && err.message ? err.message : String(err);
    throw new Error(msg);
  }
}

/** Tauri 是否提供 convertFileSrc（asset 协议 URL 转换） */
function getTauriConvertFileSrc() {
  const tauri = getTauriGlobal();
  if (!tauri) return null;
  const core = tauri.core || tauri;
  const conv = core && core.convertFileSrc;
  return typeof conv === 'function' ? conv : null;
}

/**
 * 将「绝对磁盘路径」解析为 WebView 可加载的 URL。
 *   - Tauri：经 convertFileSrc（asset 协议）转换；缺失时原样返回（由调用方降级）。
 *   - Electron / 浏览器：原样返回（Electron 侧模型统一经 petmodels:// 基址解析）。
 * @param {string} p 绝对路径（如 D:\\models\\foo\\foo.model3.json）
 * @returns {string}
 */
function toAssetUrl(p) {
  if (!p) return '';
  const s = String(p);
  // 已是完整 URL（http/https/asset/tauri/petmodels/data/blob/file…）→ 原样返回；
  // 但排除 Windows 盘符（D:\ 形如 "D:"，会被协议正则误判）。
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (runtime === 'tauri') {
    const conv = getTauriConvertFileSrc();
    if (conv) {
      try {
        // Windows：convertFileSrc 会把 Windows 路径分隔符 `\` 编码为 `%5C`，
        // 使 asset URL 仅剩「一段」路径（除首斜杠外无分隔符）。而
        // pixi-live2d-display 用 url.resolve 解析相对子资源（moc3/贴图/motion3…），
        // 单段 URL 会导致解析后**丢掉整个目录** → 子资源 404/Network error。
        // 故把编码分隔符还原为 `/`，恢复正常的 URL 层级（Tauri 侧会 percent-decode
        // 回 `D:/…` 正斜杠路径，Windows 文件访问同样有效）。
        return conv(s).replace(/%5C/gi, '/').replace(/%2F/gi, '/');
      } catch (_) { /* 回退原路径 */ }
    }
  }
  return s;
}

/** 统一把同步/异步返回值都收敛为 Promise，避免调用方区分 */
function toPromise(value) {
  return value && typeof value.then === 'function' ? value : Promise.resolve(value);
}

function detectRuntime() {
  if (getElectronApi()) return 'electron';
  if (getTauriGlobal()) return 'tauri';
  return 'browser';
}

const runtime = detectRuntime();

/**
 * 依据「外壳真实提供的方法」派生能力集，避免出现"按钮被启用却空操作"。
 *
 * 关键：不能只凭 runtime 判定能力（例如 Electron 未必暴露 importModel/getModelList），
 * 必须逐个检测对应方法是否真实存在于外壳暴露的 API 上。
 *
 * @returns {{interactive:boolean, alwaysOnTop:boolean, quit:boolean, modelList:boolean, importModel:boolean, scanResources:boolean, externalModels:boolean, externalModelsDir:boolean}}
 */
function deriveCapabilities() {
  if (runtime === 'electron') {
    const api = getElectronApi() || {};
    return {
      interactive: typeof api.setInteractive === 'function' || typeof api.setIgnoreMouseEvents === 'function',
      alwaysOnTop: typeof api.setAlwaysOnTop === 'function',
      quit: typeof api.quit === 'function',
      // 仅当 preload 确实暴露了对应方法时才为 true
      modelList: typeof api.getModelList === 'function',
      importModel: typeof api.importModel === 'function',
      // 删除模型（外壳提供删除方法时才为 true；Electron 侧如有 deleteModel 即可用）
      deleteModel: typeof api.deleteModel === 'function',
      // 主进程目录扫描（补齐未声明的 motion3/exp3/pose3）
      scanResources: typeof api.scanModelResources === 'function',
      // 外部模型协议可用（模型脱离 asar，经 petmodels:// 读取）
      externalModels: modelsBaseUrl.length > 0,
      // 外部模型地址（多根：挑选追加 / 读取全部 / 删除 / 清空）；
      // 新接口优先，兼容旧单目录接口（pickExternalModelsDir + getExternalModelsDir）
      externalModelsDir: typeof api.pickExternalModelsDir === 'function'
        && (typeof api.getExternalModelsDirs === 'function' || typeof api.getExternalModelsDir === 'function')
    };
  }

  if (runtime === 'tauri') {
    const tauri = getTauriGlobal() || {};
    const core = tauri.core || tauri;
    const hasInvoke = typeof core.invoke === 'function';
    const win = getTauriWindow();
    // 外部模型经 Tauri asset 协议（convertFileSrc）暴露；命令侧由 lib.rs 实现
    const hasAsset = typeof core.convertFileSrc === 'function';
    return {
      // Tauri 外壳实现的自定义命令（src-tauri/src/lib.rs）：
      // set_interactive / set_always_on_top / quit + 模型/外部目录相关命令
      interactive: hasInvoke || !!(win && typeof win.setIgnoreCursorEvents === 'function'),
      alwaysOnTop: hasInvoke || !!(win && typeof win.setAlwaysOnTop === 'function'),
      quit: hasInvoke
        || !!(win && typeof win.close === 'function')
        || !!(tauri.app && typeof tauri.app.exit === 'function'),
      // 以下能力由 lib.rs 的对应命令提供（见 src-tauri/src/lib.rs）：
      // get_model_list / import_model / delete_model / *external_models_dir*
      modelList: hasInvoke,
      importModel: hasInvoke,
      deleteModel: hasInvoke,
      scanResources: false, // 目录资源扫描命令暂未在 Tauri 侧实现（前端据此跳过补齐）
      externalModels: hasAsset,
      externalModelsDir: hasInvoke,
      // 光标轮询（lib.rs 的 poll_cursor 命令）：Tauri 的 setIgnoreCursorEvents 不转发
      // mousemove，故以「Rust 侧读取窗口内光标 → 前端命中判定」实现「逐区穿透」。
      pollCursor: hasInvoke
    };
  }

  // 浏览器直开：全部不可用（降级 no-op）
  return {
    interactive: false,
    alwaysOnTop: false,
    quit: false,
    modelList: false,
    importModel: false,
    deleteModel: false,
    scanResources: false,
    externalModels: false,
    externalModelsDir: false
  };
}

const capabilities = deriveCapabilities();

// 记录最近一次的交互状态，避免每次 mousemove 都跨进程通信
let lastInteractive = null;

/**
 * 是否让窗口接收鼠标点击。
 * @param {boolean} interactive true = 窗口可点；false = 鼠标穿透
 * @returns {Promise<boolean>} 实际是否成功应用（浏览器降级返回 true）
 */
async function setInteractive(interactive) {
  const value = !!interactive;
  if (lastInteractive === value) return true;
  lastInteractive = value;

  if (runtime === 'electron') {
    const api = getElectronApi();
    try {
      if (typeof api.setInteractive === 'function') {
        await toPromise(api.setInteractive(value));
        return true;
      }
      if (typeof api.setIgnoreMouseEvents === 'function') {
        // Electron 约定：ignore=true 即穿透；forward 保证穿透时仍能收到 mousemove
        await toPromise(api.setIgnoreMouseEvents(!value, { forward: true }));
        return true;
      }
    } catch (err) {
      console.warn('[bridge] setInteractive 失败:', err);
    }
    return false;
  }

  if (runtime === 'tauri') {
    // 优先走**自定义命令** `set_interactive`（lib.rs 实现，不受前端 ACL 限制，最可靠）。
    // 原因：Tauri 的 `core:window:default` 并不包含 `allow-set-ignore-cursor-events`，
    // 直接调用 `window.setIgnoreCursorEvents` 会被权限系统拒绝并抛错；本项目通过
    // 自定义 IPC 命令在两端口径一致地切换穿透。
    const tauri = getTauriGlobal();
    const core = tauri && (tauri.core || tauri);
    if (core && typeof core.invoke === 'function') {
      await tauriInvoke('set_interactive', { interactive: value });
      return true;
    }
    // 回退：极少数无 invoke 的环境 → 尝试窗口对象方法（需 window 权限）
    const win = getTauriWindow();
    try {
      if (win && typeof win.setIgnoreCursorEvents === 'function') {
        await toPromise(win.setIgnoreCursorEvents(!value));
        return true;
      }
    } catch (err) {
      console.warn('[bridge] setIgnoreCursorEvents 失败:', err && err.message);
    }
    return false;
  }

  // 浏览器：窗口本就接收全部事件，无需处理
  return true;
}

/**
 * 设置窗口是否置顶。
 * @param {boolean} alwaysOnTop
 * @returns {Promise<boolean>}
 */
async function setAlwaysOnTop(alwaysOnTop) {
  const value = !!alwaysOnTop;

  if (runtime === 'electron') {
    const api = getElectronApi();
    try {
      if (typeof api.setAlwaysOnTop === 'function') {
        await toPromise(api.setAlwaysOnTop(value));
        return true;
      }
    } catch (err) {
      console.warn('[bridge] setAlwaysOnTop 失败:', err);
    }
    return false;
  }

  if (runtime === 'tauri') {
    // 优先走自定义命令 set_always_on_top（同样不受前端 ACL 限制），并回退窗口方法
    const tauri = getTauriGlobal();
    const core = tauri && (tauri.core || tauri);
    if (core && typeof core.invoke === 'function') {
      await tauriInvoke('set_always_on_top', { enabled: value });
      return true;
    }
    const win = getTauriWindow();
    try {
      if (win && typeof win.setAlwaysOnTop === 'function') {
        await toPromise(win.setAlwaysOnTop(value));
        return true;
      }
    } catch (err) {
      console.warn('[bridge] setAlwaysOnTop 失败:', err && err.message);
    }
    return false;
  }

  return false;
}

/** 退出桌宠外壳。浏览器降级为尝试关闭当前页。 */
async function quit() {
  if (runtime === 'electron') {
    const api = getElectronApi();
    if (typeof api.quit === 'function') {
      await toPromise(api.quit());
      return true;
    }
    return false;
  }

  if (runtime === 'tauri') {
    // 优先走 lib.rs 的 quit 命令真正退出应用；
    // 注意：window.close() 会被外壳的 CloseRequested 处理拦截为「隐藏到托盘」，故仅作兜底。
    const win = getTauriWindow();
    if (!win || typeof win.close !== 'function') {
      const app = getTauriGlobal() && getTauriGlobal().app;
      if (app && typeof app.exit === 'function') {
        await toPromise(app.exit(0));
        return true;
      }
    }
    await tauriInvoke('quit');
    return true;
  }

  // 浏览器：仅做提示，避免直接关闭用户标签页
  console.info('[bridge] 浏览器环境不支持 quit()，已忽略。');
  return false;
}

/**
 * 获取外壳提供的可用模型清单（可空）。
 * @returns {Promise<Array|null>} [{ id, name, url, type, source }] 或 null
 */
async function getModelList() {
  // 外壳未提供该能力：直接返回 null，不发起无谓调用（避免"启用却空操作"）
  if (!capabilities.modelList) return null;

  if (runtime === 'electron') {
    const api = getElectronApi();
    if (typeof api.getModelList === 'function') {
      try {
        const list = await toPromise(api.getModelList());
        return Array.isArray(list) ? list : null;
      } catch (err) {
        console.warn('[bridge] getModelList 失败:', err);
      }
    }
    return null;
  }

  if (runtime === 'tauri') {
    const list = await tauriInvoke('get_model_list');
    return Array.isArray(list) ? list : null;
  }

  return null;
}

/**
 * 通过外壳的文件选择器导入模型（可空）。
 * @returns {Promise<Object|null>} 模型描述对象 { id, name, url, type } 或 null
 */
async function importModel() {
  // 外壳未提供该能力：直接返回 null（调用方据此禁用按钮/给出提示）
  if (!capabilities.importModel) return null;

  if (runtime === 'electron') {
    const api = getElectronApi();
    if (typeof api.importModel === 'function') {
      try {
        const model = await toPromise(api.importModel());
        return model && typeof model === 'object' ? model : null;
      } catch (err) {
        console.warn('[bridge] importModel 失败:', err);
      }
    }
    return null;
  }

  if (runtime === 'tauri') {
    // 严格模式：导入失败（选择器异常 / 目录无入口 / 复制失败）会抛错，
    // 由 main.js 的 importModelFlow 捕获并给出可见提示，不再静默为「已取消」。
    // 返回 null 仅表示用户在两次选择器中均取消。
    const model = await tauriInvokeStrict('import_model');
    return model && typeof model === 'object' ? model : null;
  }

  // 浏览器：不提供导入模型能力（capabilities.importModel = false，上方已提前返回）
  return null;
}

/**
 * 扫描指定模型入口目录下的动作 / 表情 / 姿势资源（可空）。
 *
 * 用途：渲染进程在 file:// 下无法枚举目录，改由主进程读盘；用于补齐
 * 「目录里存在但未在入口 .model3.json 中声明」的 motion3 / exp3 / pose3。
 * 外壳不具备该能力时返回 null，调用方据此跳过补齐逻辑。
 *
 * @param {string} modelUrl 模型入口 URL 或相对 web/ 的路径（如 models/xxx/yyy.model3.json）
 * @returns {Promise<Object|null>} { ok, motions, expressions, poses, modelDirRel }（或 { ok:false, error }）；不可用为 null
 */
async function scanModelResources(modelUrl) {
  // 外壳未提供该能力：直接返回 null（不发起无谓调用，避免"启用却空操作"）
  if (!capabilities.scanResources) return null;

  if (runtime === 'electron') {
    const api = getElectronApi();
    if (typeof api.scanModelResources === 'function') {
      try {
        const res = await toPromise(api.scanModelResources(modelUrl));
        return res && typeof res === 'object' ? res : null;
      } catch (err) {
        console.warn('[bridge] scanModelResources 失败:', err);
      }
    }
    return null;
  }

  // Tauri / 浏览器：未实现该能力
  return null;
}

/**
 * 挑选「外部模型文件夹」（追加到已添加列表，可空）。
 * 用途：让用户指定任意磁盘上的模型目录，与内置 models/ 并存并合并进模型列表。
 * 外壳不具备该能力（浏览器 / 旧 Electron）时返回 null。
 *
 * @returns {Promise<Array<{id:string,path:string}>|null>} 成功返回地址数组；取消 / 不可用返回 null
 */
async function pickExternalModelsDir() {
  if (!capabilities.externalModelsDir) return null;

  if (runtime === 'electron') {
    const api = getElectronApi();
    if (typeof api.pickExternalModelsDir === 'function') {
      try {
        const dirs = await toPromise(api.pickExternalModelsDir());
        if (Array.isArray(dirs)) return dirs;
        // 兼容旧外壳：返回字符串路径 → 包成单元素数组
        if (typeof dirs === 'string' && dirs) return [{ id: 'r1', path: dirs }];
      } catch (err) {
        console.warn('[bridge] pickExternalModelsDir 失败:', err);
      }
    }
    return null;
  }

  if (runtime === 'tauri') {
    // lib.rs: pick_external_models_dir → 弹目录选择器、追加并返回全部地址
    const dirs = await tauriInvokeStrict('pick_external_models_dir');
    return Array.isArray(dirs) ? dirs : null;
  }

  return null;
}

/**
 * 读取当前全部外部模型地址（数组，可空）。
 * @returns {Promise<Array<{id:string,path:string}>>} 地址数组；不可用返回 []
 */
async function getExternalModelsDirs() {
  if (!capabilities.externalModelsDir) return [];

  if (runtime === 'electron') {
    const api = getElectronApi();
    try {
      if (typeof api.getExternalModelsDirs === 'function') {
        const dirs = await toPromise(api.getExternalModelsDirs());
        return Array.isArray(dirs) ? dirs : [];
      }
      // 兼容旧外壳：只有单一 getExternalModelsDir → 包成数组
      if (typeof api.getExternalModelsDir === 'function') {
        const dir = await toPromise(api.getExternalModelsDir());
        return typeof dir === 'string' && dir ? [{ id: 'r1', path: dir }] : [];
      }
    } catch (err) {
      console.warn('[bridge] getExternalModelsDirs 失败:', err);
    }
    return [];
  }

  if (runtime === 'tauri') {
    const dirs = await tauriInvoke('get_external_models_dirs');
    return Array.isArray(dirs) ? dirs : [];
  }

  return [];
}

/**
 * 删除指定外部模型地址（入参为稳定 id 或绝对路径，可空）。
 * @param {string} idOrPath
 * @returns {Promise<Array<{id:string,path:string}>>} 删除后的地址数组；不可用返回 []
 */
async function removeExternalModelsDir(idOrPath) {
  if (!capabilities.externalModelsDir) return [];

  if (runtime === 'electron') {
    const api = getElectronApi();
    if (typeof api.removeExternalModelsDir === 'function') {
      try {
        const dirs = await toPromise(api.removeExternalModelsDir(idOrPath));
        return Array.isArray(dirs) ? dirs : [];
      } catch (err) {
        console.warn('[bridge] removeExternalModelsDir 失败:', err);
      }
    }
    return [];
  }

  if (runtime === 'tauri') {
    const dirs = await tauriInvokeStrict('remove_external_models_dir', { idOrPath });
    return Array.isArray(dirs) ? dirs : [];
  }

  return [];
}

/**
 * 清空全部外部模型地址（可空）。
 * @returns {Promise<boolean>} 是否成功清空；不可用 / 失败返回 false
 */
async function clearExternalModelsDirs() {
  if (!capabilities.externalModelsDir) return false;

  if (runtime === 'electron') {
    const api = getElectronApi();
    if (typeof api.clearExternalModelsDirs === 'function') {
      try {
        return !!(await toPromise(api.clearExternalModelsDirs()));
      } catch (err) {
        console.warn('[bridge] clearExternalModelsDirs 失败:', err);
      }
    }
    // 兼容旧外壳：无新方法时退回旧 clearExternalModelsDir
    if (typeof api.clearExternalModelsDir === 'function') {
      try {
        return !!(await toPromise(api.clearExternalModelsDir()));
      } catch (err) {
        console.warn('[bridge] clearExternalModelsDir 失败:', err);
      }
    }
    return false;
  }

  if (runtime === 'tauri') {
    const ok = await tauriInvokeStrict('clear_external_models_dirs');
    return !!ok;
  }

  return false;
}

/**
 * （兼容旧接口）读取第一个外部模型地址的路径。
 * @returns {Promise<string|null>}
 */
async function getExternalModelsDir() {
  if (!capabilities.externalModelsDir) return null;
  if (runtime === 'electron') {
    const api = getElectronApi();
    if (typeof api.getExternalModelsDir === 'function') {
      try {
        const dir = await toPromise(api.getExternalModelsDir());
        return typeof dir === 'string' && dir ? dir : null;
      } catch (err) {
        console.warn('[bridge] getExternalModelsDir 失败:', err);
      }
    }
    return null;
  }
  if (runtime === 'tauri') {
    const dirs = await getExternalModelsDirs();
    return dirs.length ? dirs[0].path : null;
  }
  return null;
}

/**
 * （兼容旧接口）清空全部外部模型地址（等价 clearExternalModelsDirs）。
 * @returns {Promise<boolean>}
 */
async function clearExternalModelsDir() {
  return clearExternalModelsDirs();
}

/**
 * 删除模型（可空）。删除外壳管理的模型目录（Tauri：exe 同级 models/<模型>；
 * 外部文件夹内的模型目录亦可）。调用方须已作二次确认。
 *
 * @param {string} idOrPath 模型 id（目录名）或入口文件绝对路径（优先传 url）
 * @returns {Promise<boolean>} 是否实际删除；不可用 / 失败返回 false
 */
async function deleteModel(idOrPath) {
  if (!capabilities.deleteModel) return false;
  if (!idOrPath) return false;

  if (runtime === 'electron') {
    const api = getElectronApi();
    if (typeof api.deleteModel === 'function') {
      try {
        return !!(await toPromise(api.deleteModel(idOrPath)));
      } catch (err) {
        console.warn('[bridge] deleteModel 失败:', err);
      }
    }
    return false;
  }

  if (runtime === 'tauri') {
    // lib.rs: delete_model(app, id_or_path) → 删除目录；严格模式让「不允许删除 / 被占用」
    // 等失败原因透传到前端提示，而非静默为 false。
    return !!(await tauriInvokeStrict('delete_model', { idOrPath }));
  }

  return false;
}

/**
 * 读取当前光标在窗口内的位置（逻辑像素）—— Tauri 专用「逐区穿透」探测接口。
 *
 * Tauri 的 `setIgnoreCursorEvents(true)` 不会像 Electron `forward:true` 那样把 mousemove
 * 转发给 WebView，穿透态下前端收不到任何鼠标事件。故交互层以约 30fps 轮询本接口，
 * 拿到「光标在窗口内的逻辑坐标」后自行做命中判定：
 *   命中模型 / 设置面板 → 关闭穿透（可点）；否则 → 开启穿透（点击下传到桌面）。
 *
 * 说明：Rust 侧 `window.cursor_position()` 为「相对窗口」的坐标，窗口穿透不影响读取
 * （其读的是系统光标与窗口位置之差）。读取失败返回 null，由交互层降级处理。
 *
 * @returns {Promise<{x:number,y:number,physicalX:number,physicalY:number}|null>}
 */
async function pollCursor() {
  if (!capabilities.pollCursor) return null;
  // 读取失败不是致命错误：返回 null，交互层据此降级（保持穿透 / 计数兜底）
  const pos = await tauriInvoke('poll_cursor');
  if (!pos || typeof pos !== 'object') return null;
  const x = Number(pos.x);
  const y = Number(pos.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x,
    y,
    physicalX: Number(pos.physicalX),
    physicalY: Number(pos.physicalY)
  };
}

/**
 * 统一桥对象（导出给渲染层使用）。
 */
export const bridge = {
  /** 'electron' | 'tauri' | 'browser' */
  runtime,
  /** 是否运行在桌面外壳中 */
  isDesktop: runtime !== 'browser',
  /**
   * 外壳能否在「穿透」状态下转发 mousemove。
   * 仅 Electron(forward:true) 具备；决定交互层是否启用「悬停自动穿透」。
   */
  canForwardMouseMove: runtime === 'electron',

  /**
   * 外壳能否轮询「窗口内光标位置」（Tauri 的 poll_cursor 命令）。
   * Tauri 无 mousemove 转发，改用「光标轮询 + 前端命中判定」实现逐区穿透。
   */
  canPollCursor: !!capabilities.pollCursor,

  setInteractive,
  setAlwaysOnTop,
  quit,
  getModelList,
  importModel,
  deleteModel,
  pollCursor,
  scanModelResources,
  pickExternalModelsDir,
  getExternalModelsDirs,
  removeExternalModelsDir,
  clearExternalModelsDirs,
  // 兼容旧接口
  getExternalModelsDir,
  clearExternalModelsDir,

  /** 外部模型协议基址（Electron：'petmodels://local/'；Tauri / 浏览器为空串） */
  modelsBaseUrl,

  /** 将绝对磁盘路径转为外壳可加载的 URL（Tauri：asset 协议；其它：原样） */
  toAssetUrl,

  /** 能力探测（按外壳真实方法派生），供设置面板决定按钮是否可用/置灰 */
  capabilities,

  /** 当前记录的交互状态（null = 尚未设置） */
  getInteractiveState() {
    return lastInteractive;
  }
};

// 便于诊断外壳契约：打印一次运行环境与派生出的能力集（verbose 级别）
console.debug('[bridge] runtime=%s capabilities=%o', runtime, capabilities);

export default bridge;