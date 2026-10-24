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
 *     - getModelList() -> Promise<Array>      可选
 *     - importModel()  -> Promise<Object|null> 可选
 *     - scanModelResources(url) -> Promise<Object|null> 可选（主进程扫描模型目录资源）
 *     - pickExternalModelsDir()/getExternalModelsDirs()/removeExternalModelsDir()/clearExternalModelsDirs() 可选（外部模型地址，多根）
 *     - 兼容旧接口 getExternalModelsDir()/clearExternalModelsDir()
 *   Tauri (window.__TAURI__)：
 *     - 主窗口 setIgnoreCursorEvents(bool) / setAlwaysOnTop(bool) / close()
 *     - 可选命令：invoke('get_model_list') / invoke('import_model')
 *
 * 穿透语义说明（重要）：
 *   - Electron 使用 setIgnoreMouseEvents(true, { forward: true }) 时仍能收到 mousemove，
 *     因此可以做到「悬停命中模型/面板才可点，离开即穿透」。
 *   - Tauri 的 setIgnoreCursorEvents(true) 不会转发 mousemove，无法做悬停探测，
 *     故本桥将其标记为 canForwardMouseMove = false，交互层会改为常驻可点（或由设置面板手动切换）。
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
 * 渲染层据此把相对模型路径解析到外部 models/ 目录；浏览器直开 / Tauri 下为空串。
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
    return {
      // Tauri 外壳实现的自定义命令（tauri/src-tauri/src/lib.rs）：
      // set_interactive / set_always_on_top / quit
      interactive: hasInvoke || !!(win && typeof win.setIgnoreCursorEvents === 'function'),
      alwaysOnTop: hasInvoke || !!(win && typeof win.setAlwaysOnTop === 'function'),
      quit: hasInvoke
        || !!(win && typeof win.close === 'function')
        || !!(tauri.app && typeof tauri.app.exit === 'function'),
      // Tauri 外壳未实现 get_model_list / import_model / 目录扫描 → 明确为 false，避免"启用却空操作"
      modelList: false,
      importModel: false,
      scanResources: false,
      externalModels: false,
      externalModelsDir: false
    };
  }

  // 浏览器直开：全部不可用（降级 no-op）
  return {
    interactive: false,
    alwaysOnTop: false,
    quit: false,
    modelList: false,
    importModel: false,
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
    const win = getTauriWindow();
    try {
      if (win && typeof win.setIgnoreCursorEvents === 'function') {
        await toPromise(win.setIgnoreCursorEvents(!value));
        return true;
      }
    } catch (err) {
      console.warn('[bridge] setIgnoreCursorEvents 失败:', err);
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
    const win = getTauriWindow();
    try {
      if (win && typeof win.setAlwaysOnTop === 'function') {
        await toPromise(win.setAlwaysOnTop(value));
        return true;
      }
    } catch (err) {
      console.warn('[bridge] setAlwaysOnTop 失败:', err);
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
    const win = getTauriWindow();
    if (win && typeof win.close === 'function') {
      await toPromise(win.close());
      return true;
    }
    const app = getTauriGlobal() && getTauriGlobal().app;
    if (app && typeof app.exit === 'function') {
      await toPromise(app.exit(0));
      return true;
    }
    return false;
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
    const model = await tauriInvoke('import_model');
    return model && typeof model === 'object' ? model : null;
  }

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
 * 外壳不具备该能力（Tauri / 浏览器 / 旧 Electron）时返回 null。
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

  setInteractive,
  setAlwaysOnTop,
  quit,
  getModelList,
  importModel,
  scanModelResources,
  pickExternalModelsDir,
  getExternalModelsDirs,
  removeExternalModelsDir,
  clearExternalModelsDirs,
  // 兼容旧接口
  getExternalModelsDir,
  clearExternalModelsDir,

  /** 外部模型协议基址（'petmodels://local/'；不可用为空串） */
  modelsBaseUrl,

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