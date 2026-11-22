/**
 * importRootPanel.js —— 「模型存放目录」设置区块（R2）
 *
 * 职责：展示后端配置的模型存放目录，并允许用户「选择 / 更改 / 恢复默认」。
 *
 * 设计约束：
 *  - 独立模块（禁止在 settingsPanel.js 内实现），由设置面板创建后挂载；
 *  - DOM 契约（供测试与后续任务按选择器定位）：
 *      [data-role="import-root-section"]  根元素（class="pet-section"）
 *      [data-role="import-root-path"]     路径显示（.pet-value.pet-path，title=完整路径）
 *      [data-role="import-root-pick"]     选择 / 更改按钮
 *      [data-role="import-root-clear"]    恢复默认按钮（仅已设置时可见）
 *  - 数据真源为后端 config.json（经 bridge 读取），**禁止**把路径写入 localStorage；
 *    本模块仅在内存里保留最近一次读取结果用于显示，销毁后即丢弃。
 *  - 样式依赖设置面板注入的 .pet-* 类（settingsPanel.ensureStyle），本文件不重复注入样式。
 */

const DEFAULT_PATH_TEXT = '默认（程序目录 models/）';
const BTN_PICK_UNSET = '选择模型存放目录';
const BTN_PICK_SET = '更改模型存放目录';
const BTN_CLEAR = '恢复默认';
const HINT_UNSET = '未设置：导入的模型将保存到程序目录 models/';
const HINT_SET = '导入的模型将保存到该目录下的子文件夹';
const HINT_UNSUPPORTED = '当前外壳不支持设置模型存放目录';

/** 创建带类名与文本的元素 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (typeof text === 'string') node.textContent = text;
  return node;
}

/** 把任意异常转为可读文案（Tauri 侧错误可能是字符串或对象） */
function toErrorMessage(err) {
  if (err && typeof err === 'object' && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  return String(err);
}

/**
 * @typedef {Object} ImportRootPanelDeps
 * @property {object} [bridge]                        bridge.js 导出的桥对象
 * @property {(msg: string) => void} [setStatus]       面板状态行（由 settingsPanel 透传）
 * @property {() => (Promise<void>|void)} [onChanged]  值变化后回调（宿主借此刷新模型列表）
 */

/**
 * 创建「模型存放目录」设置区块。
 *
 * @param {ImportRootPanelDeps} deps
 * @returns {{
 *   element: HTMLElement,
 *   refresh: () => Promise<string|null>,
 *   getPath: () => string|null,
 *   destroy: () => void
 * }}
 */
export function createImportRootPanel(deps) {
  const cfg = deps || {};
  const bridge = cfg.bridge || null;
  const externalSetStatus = typeof cfg.setStatus === 'function' ? cfg.setStatus : null;
  const onChanged = typeof cfg.onChanged === 'function' ? cfg.onChanged : null;

  const capabilities = (bridge && bridge.capabilities) || {};
  // 仅 Tauri 外壳提供模型存放目录命令；Electron / 浏览器着色为「不支持」
  const supported = capabilities.importRoot === true;

  // ---------------- DOM 结构 ----------------

  const root = el('div', 'pet-section');
  root.dataset.role = 'import-root-section';

  const row = el('div', 'pet-row');
  row.appendChild(el('span', 'pet-label', '模型存放目录'));

  const pathEl = el('span', 'pet-value pet-path', DEFAULT_PATH_TEXT);
  pathEl.dataset.role = 'import-root-path';
  pathEl.title = DEFAULT_PATH_TEXT;
  row.appendChild(pathEl);

  const pickBtn = el('button', 'pet-btn', BTN_PICK_UNSET);
  pickBtn.type = 'button';
  pickBtn.dataset.role = 'import-root-pick';
  pickBtn.title = '选择导入模型的保存目录';

  const clearBtn = el('button', 'pet-btn', BTN_CLEAR);
  clearBtn.type = 'button';
  clearBtn.dataset.role = 'import-root-clear';
  clearBtn.title = '清除自定义导入目录，恢复默认落点';
  clearBtn.hidden = true;

  const statusEl = el('div', 'pet-status', HINT_UNSET);

  root.appendChild(row);
  root.appendChild(pickBtn);
  root.appendChild(clearBtn);
  root.appendChild(statusEl);

  if (!supported) {
    // 外壳不支持：置灰并说明原因，避免「按钮可点却空操作」
    pickBtn.disabled = true;
    clearBtn.disabled = true;
    pickBtn.title = HINT_UNSUPPORTED;
    clearBtn.title = HINT_UNSUPPORTED;
  }

  // ---------------- 内部状态 ----------------

  /** 最近一次读取到的路径（仅用于显示，非持久化数据源） */
  let currentPath = null;
  let destroyed = false;
  /** 请求/回调进行中标记：阻止重复点击造成的并发写入 */
  let inFlight = false;

  /**
   * 输出提示：优先交给宿主面板的状态行（settingsPanel 透传），缺省写到本区块状态行。
   * 处理函数异常不应打断 UI 流程，故吞掉 setStatus 自身的异常并回退本地行。
   */
  function publishStatus(message) {
    const text = message == null ? '' : String(message);
    if (externalSetStatus) {
      try {
        externalSetStatus(text);
        return;
      } catch (err) {
        console.warn('[importRootPanel] setStatus 回调失败:', err);
      }
    }
    statusEl.textContent = text;
  }

  /**
   * 依据路径值刷新显示（路径文本 / title / 按钮文案 / 恢复默认可见性 / 提示文案）。
   * 只更新展示，不发起任何后端调用。
   *
   * @param {*} path 后端返回的路径（任意类型，内部统一归一）
   */
  function applyPath(path) {
    currentPath = typeof path === 'string' && path.trim().length > 0 ? path : null;

    if (!supported) {
      pathEl.textContent = DEFAULT_PATH_TEXT;
      pathEl.title = DEFAULT_PATH_TEXT;
      pickBtn.textContent = BTN_PICK_UNSET;
      clearBtn.hidden = true;
      statusEl.textContent = HINT_UNSUPPORTED;
      return;
    }

    if (currentPath) {
      pathEl.textContent = currentPath;
      // 长路径由 .pet-path 单行省略，完整路径经 title 展示
      pathEl.title = currentPath;
      pickBtn.textContent = BTN_PICK_SET;
      clearBtn.hidden = false;
      statusEl.textContent = HINT_SET;
      return;
    }

    pathEl.textContent = DEFAULT_PATH_TEXT;
    pathEl.title = DEFAULT_PATH_TEXT;
    pickBtn.textContent = BTN_PICK_UNSET;
    clearBtn.hidden = true;
    statusEl.textContent = HINT_UNSET;
  }

  /** 通知宿主「值已变化」（例如刷新模型列表）；回调异常只记录，不影响面板可用性 */
  async function notifyChanged() {
    if (!onChanged || destroyed) return;
    try {
      await Promise.resolve(onChanged());
    } catch (err) {
      console.warn('[importRootPanel] onChanged 回调失败:', err);
    }
  }

  // ---------------- 对外方法 ----------------

  /**
   * 从后端重新读取模型存放目录并刷新显示（读失败按「未设置」降级）。
   *
   * @returns {Promise<string|null>} 当前路径；未设置 / 不支持 / 已销毁 → null
   */
  async function refresh() {
    if (destroyed) return currentPath;

    if (!supported || !bridge || typeof bridge.getImportRoot !== 'function') {
      applyPath(null);
      return null;
    }

    let path = null;
    try {
      path = await bridge.getImportRoot();
    } catch (err) {
      // getImportRoot 自身吞错返回 null；此处仅防御自定义 bridge 实现抛错的情况
      console.warn('[importRootPanel] 读取模型存放目录失败:', err && err.message);
      path = null;
    }
    if (destroyed) return currentPath;

    applyPath(path);
    return currentPath;
  }

  /** 当前显示的模型存放目录（同步读取，不发起请求；未设置 / 不支持 → null） */
  function getPath() {
    return currentPath;
  }

  /** 选择 / 更改模型存放目录：成功后刷新显示并通知宿主 */
  async function handlePick() {
    if (destroyed || !supported || inFlight) return;
    if (!bridge || typeof bridge.pickImportRoot !== 'function') {
      publishStatus(HINT_UNSUPPORTED);
      return;
    }

    inFlight = true;
    let ok = false;
    try {
      // 严格模式：选择器异常 / 写配置失败会抛 Error
      await bridge.pickImportRoot();
      ok = true;
    } catch (err) {
      console.warn('[importRootPanel] 选择模型存放目录失败:', err);
      // 失败时保留既有显示（以配置为准），仅提示原因
      publishStatus('设置模型存放目录失败：' + toErrorMessage(err));
    } finally {
      inFlight = false;
    }
    if (!ok || destroyed) return;

    // 取消时后端返回当前值（未改动），统一重新读取避免分叉
    await refresh();
    await notifyChanged();
  }

  /** 恢复默认导入落点：成功后刷新显示并通知宿主 */
  async function handleClear() {
    if (destroyed || !supported || inFlight) return;
    if (!bridge || typeof bridge.clearImportRoot !== 'function') {
      publishStatus(HINT_UNSUPPORTED);
      return;
    }

    inFlight = true;
    let ok = false;
    try {
      await bridge.clearImportRoot();
      ok = true;
    } catch (err) {
      console.warn('[importRootPanel] 恢复默认导入位置失败:', err);
      publishStatus('恢复默认导入位置失败：' + toErrorMessage(err));
    } finally {
      inFlight = false;
    }
    if (!ok || destroyed) return;

    await refresh();
    await notifyChanged();
  }

  /** 幂等销毁：解绑事件并移除 DOM（重复调用无副作用） */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    pickBtn.removeEventListener('click', handlePick);
    clearBtn.removeEventListener('click', handleClear);
    currentPath = null;
    if (root.parentNode) root.parentNode.removeChild(root);
    else if (typeof root.remove === 'function') root.remove();
  }

  // ---------------- 事件绑定与初始渲染 ----------------

  pickBtn.addEventListener('click', handlePick);
  clearBtn.addEventListener('click', handleClear);

  if (supported) {
    // 首次进入即按后端配置渲染（失败已在 refresh 内降级，不会产生未捕获异常）
    refresh().catch((err) => {
      console.warn('[importRootPanel] 初始读取模型存放目录失败:', err);
    });
  } else {
    applyPath(null);
  }

  return {
    element: root,
    refresh,
    getPath,
    destroy
  };
}