'use strict';

/**
 * Electron 预加载脚本（Preload）
 *
 * 通过 contextBridge 向 web/ 前端暴露一个受限的、白名单式的 IPC 桥 `window.petAPI`。
 * 该命名与接口签名需与共享前端 `web/src/bridge.js` 的约定保持一致：
 *   - setInteractive(bool)   —— 切换「整窗穿透 / 可交互」，用于鼠标逐区命中
 *   - setAlwaysOnTop(bool)   —— 切换窗口置顶
 *   - quit()                 —— 退出应用
 *   - importModel()          —— 通过文件选择器导入 Live2D 模型（成功返回模型对象，取消/失败返回 null）
 *   - getModelList()         —— 读取外壳登记的模型清单（数组；不可用返回 null）
 *   - getModelsDir()         —— 模型存放目录的绝对路径（可选能力）
 *   - pickExternalModelsDir()  —— 弹目录选择器挑选「外部模型文件夹」（追加；返回地址数组或 null）
 *   - getExternalModelsDirs()  —— 当前全部外部模型地址（数组 [{id,path}]）
 *   - removeExternalModelsDir(idOrPath) —— 删除指定外部地址（返回删除后的数组）
 *   - clearExternalModelsDirs() —— 清空全部外部地址（返回布尔）
 *   - getExternalModelsDir() / clearExternalModelsDir() —— 兼容旧接口（第一个 path / 清空）
 *   - scanModelResources(u)  —— 扫描模型入口目录下的动作/表情/姿势资源（可选能力）
 *   - modelsBaseUrl          —— 外部模型协议基址（'petmodels://local/'），供渲染层解析模型 URL
 *
 * 渲染进程运行在 contextIsolation=true / nodeIntegration=false 下，
 * 因此前端无法直接访问 ipcRenderer，只能使用此处显式导出的方法。
 */

const { contextBridge, ipcRenderer } = require('electron');

/** 将任意输入规整为布尔值，避免前端传入非布尔导致主进程逻辑异常 */
function toBool(value) {
  return value === true || value === 1 || value === '1';
}

/** 将任意输入规整为有限数字，非法值回退为 0 */
function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

contextBridge.exposeInMainWorld('petAPI', {
  // 外部模型协议基址：模型/贴图/动作等资源经该协议读取外部 models/ 目录。
  // 开发态与打包态均注册该协议，故恒为可用（非空字符串）。
  modelsBaseUrl: 'petmodels://local/',

  // —— 核心接口（与 bridge.js 约定一致）——

  /** 切换鼠标交互：true=可交互（关闭穿透），false=整窗穿透（点击穿透到下层窗口） */
  setInteractive: (interactive) => ipcRenderer.send('pet:set-interactive', toBool(interactive)),

  /** 切换窗口置顶 */
  setAlwaysOnTop: (flag) => ipcRenderer.send('pet:set-always-on-top', toBool(flag)),

  /** 退出应用（等价于托盘「退出」） */
  quit: () => ipcRenderer.send('pet:quit'),

  // —— 窗口位置 / 显示 相关（可选能力，供前端按需使用）——

  /** 相对移动窗口：以当前左上角为基准偏移 (dx, dy) 像素 */
  moveWindow: (dx, dy) => ipcRenderer.send('pet:move-window', { dx: toNumber(dx), dy: toNumber(dy) }),

  /** 绝对移动窗口：将窗口左上角移动到 (x, y) */
  moveWindowTo: (x, y) => ipcRenderer.send('pet:move-window', { x: toNumber(x), y: toNumber(y) }),

  /** 显示 / 隐藏窗口 */
  setVisible: (visible) => ipcRenderer.send('pet:set-visible', toBool(visible)),

  /** 切换窗口显示状态 */
  toggleVisible: () => ipcRenderer.send('pet:toggle-visible'),

  /** 设置开机自启（可选） */
  setAutoLaunch: (enabled) => ipcRenderer.send('pet:set-auto-launch', toBool(enabled)),

  // —— 模型相关（与 bridge.js 契约对齐后的返回值形状）——

  /**
   * 通过文件选择器导入 Live2D 模型（.model3.json / .model.json）。
   *
   * 主进程 IPC 返回结构化结果 { ok, model } / { ok:false, canceled } / { ok:false, error }，
   * 这里抹平为 bridge.js 契约所需的形状：
   *   - 成功 → 模型对象 { id, name, url, type }
   *   - 用户取消 / 失败 → null
   *
   * @returns {Promise<{id:string,name:string,url:string,type:string}|null>}
   */
  importModel: async () => {
    const res = await ipcRenderer.invoke('pet:import-model');
    return res && res.ok === true && res.model && typeof res.model === 'object' ? res.model : null;
  },

  /**
   * 读取外壳登记的模型清单。
   * bridge.js 期望数组（内部以 Array.isArray 校验），故此处解包主进程的 { ok, models }。
   * @returns {Promise<Array|null>}
   */
  getModelList: async () => {
    const res = await ipcRenderer.invoke('pet:get-model-list');
    return res && res.ok === true && Array.isArray(res.models) ? res.models : null;
  },

  /**
   * 模型文件的存放目录（绝对路径）。可选能力，便于前端向用户提示。
   * @returns {Promise<string|null>}
   */
  getModelsDir: async () => {
    const res = await ipcRenderer.invoke('pet:get-models-dir');
    return res && res.ok === true ? res.dir : null;
  },

  // —— 外部模型地址（可多个，与内置 models/ 并存；由主进程持久化于 userData/config.json）——

  /**
   * 弹出目录选择器，选择「外部模型文件夹」（追加到已添加列表，不覆盖已有）。
   * 主进程返回 { ok:true, dirs:[{id,path}] } / { ok:false, canceled:true } / { ok:false, error }，
   * 这里抹平为数组：成功 → 地址数组；取消 / 失败 → null。
   * @returns {Promise<Array<{id:string,path:string}>|null>}
   */
  pickExternalModelsDir: async () => {
    const res = await ipcRenderer.invoke('pet:pick-external-models-dir');
    return res && res.ok === true && Array.isArray(res.dirs) ? res.dirs : null;
  },

  /**
   * 读取当前全部外部模型地址（未添加 / 不可用为 []）。
   * @returns {Promise<Array<{id:string,path:string}>>}
   */
  getExternalModelsDirs: async () => {
    const res = await ipcRenderer.invoke('pet:get-external-models-dirs');
    return res && res.ok === true && Array.isArray(res.dirs) ? res.dirs : [];
  },

  /**
   * 删除指定外部模型地址（入参为稳定 id 或绝对路径）。
   * @param {string} idOrPath
   * @returns {Promise<Array<{id:string,path:string}>>} 删除后的地址数组
   */
  removeExternalModelsDir: async (idOrPath) => {
    // 同时带上 id / path，主进程任选其一匹配即可
    const res = await ipcRenderer.invoke('pet:remove-external-models-dir', {
      id: idOrPath,
      path: idOrPath
    });
    return res && res.ok === true && Array.isArray(res.dirs) ? res.dirs : [];
  },

  /**
   * 清空全部外部模型地址（持久化置空）。
   * @returns {Promise<boolean>} 是否成功清空
   */
  clearExternalModelsDirs: async () => {
    const res = await ipcRenderer.invoke('pet:clear-external-models-dirs');
    return !!(res && res.ok === true);
  },

  /**
   * （兼容旧接口）读取第一个外部模型地址的路径。
   * @returns {Promise<string|null>}
   */
  getExternalModelsDir: async () => {
    const res = await ipcRenderer.invoke('pet:get-external-models-dir');
    return res && res.ok === true && typeof res.dir === 'string' && res.dir ? res.dir : null;
  },

  /**
   * （兼容旧接口）清除全部已设置的外部模型地址（持久化置空）。
   * @returns {Promise<boolean>} 是否成功清除
   */
  clearExternalModelsDir: async () => {
    const res = await ipcRenderer.invoke('pet:clear-external-models-dir');
    return !!(res && res.ok === true);
  },

  /**
   * 扫描模型入口所在目录，列出全部动作 / 表情 / 姿势资源（含未在 .model3.json 中声明的）。
   *
   * 渲染进程在 file:// 下无法枚举目录，故由主进程读盘后回传。返回主进程的结构化结果：
   *   { ok:true, motions, expressions, poses, modelDirRel } 或 { ok:false, error }
   * 各数组元素为「相对模型目录」的 POSIX 路径（如 "motions/mission.motion3.json"）。
   *
   * @param {string} modelUrlOrPath 模型入口 URL / 相对 web/ 的路径
   * @returns {Promise<{ok:boolean, motions?:string[], expressions?:string[], poses?:string[], modelDirRel?:string, error?:string}|null>}
   */
  scanModelResources: async (modelUrlOrPath) => {
    try {
      const res = await ipcRenderer.invoke('pet:scan-model-resources', modelUrlOrPath);
      return res && typeof res === 'object' ? res : null;
    } catch (err) {
      // 主进程异常时兜底为空结果，避免渲染端 unhandled rejection
      return { ok: false, error: String((err && err.message) || err) };
    }
  },

  // —— 主进程 -> 渲染进程 事件订阅 ——

  /**
   * 订阅「置顶状态变化」事件（托盘开关或其它来源触发时同步前端状态）。
   * @param {(flag:boolean)=>void} callback
   * @returns {()=>void} 取消订阅函数
   */
  onAlwaysOnTopChanged: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, flag) => callback(toBool(flag));
    ipcRenderer.on('pet:always-on-top-changed', listener);
    return () => ipcRenderer.removeListener('pet:always-on-top-changed', listener);
  }
});