/**
 * rainPanel.js —— 「全屏下雨」设置区块（R4）
 *
 * 职责：提供全屏下雨开关、雨量档位（四档）与雨声音效开关，
 *       变更以「先写 rain.js，再通知宿主，最后重新同步」的顺序传播。
 *
 * 设计约束：
 *  - 独立模块（禁止在 settingsPanel.js 内实现），由设置面板创建后挂载；
 *  - 数据真源为 rain.js（C-RAIN-VISUAL@1）的内存运行态，本模块只读取用于渲染，
 *    **禁止**写 localStorage；
 *  - DOM 契约（供测试与后续任务按选择器定位）：
 *      [data-role="rain-section"]  根元素（class="pet-section"）
 *      [data-role="rain-toggle"]   开关行 `.pet-switch` 内的 checkbox（文案「全屏下雨」）
 *      [data-role="rain-options"]  折叠容器（class="pet-rain-options"；关闭时 hidden）
 *      [data-role="rain-level"]    档位 select（class="pet-select"，四档中文文本）
 *      [data-role="rain-sound"]    音效 checkbox（文案「雨声音效」）
 *  - 样式自带 `#pet-rain-style` 幂等注入，只作用于 `.pet-rain-*` 类，不覆盖设置面板规则。
 */

const STYLE_ID = 'pet-rain-style';

const TEXT_TITLE = '全屏下雨';
const TEXT_LEVEL = '雨量档位';
const TEXT_SOUND = '雨声音效';
const TEXT_SOUND_HINT = '雨声音效在下雨开启时播放';
const TEXT_UNAVAILABLE = '雨效模块不可用';
const TEXT_FAIL_PREFIX = '雨效操作失败：';

/**
 * @typedef {'light'|'moderate'|'heavy'|'thunder'} RainLevel
 * @typedef {Object} RainConfig
 * @property {boolean} enabled
 * @property {RainLevel} level
 * @property {boolean} soundEnabled
 */

/** 档位枚举与中文文案（值与 RainLevel 一一对应，顺序即下拉顺序） */
const RAIN_LEVELS = Object.freeze([
  { value: 'light', text: '小雨' },
  { value: 'moderate', text: '中雨' },
  { value: 'heavy', text: '大雨' },
  { value: 'thunder', text: '雷雨' }
]);

/** 默认档位（与 rain.js 的默认配置保持一致） */
const DEFAULT_LEVEL = 'moderate';

/** rain 对象必须实现的 C-RAIN-VISUAL@1 方法（缺任一即视为不可用） */
const REQUIRED_METHODS = ['getRainConfig', 'setRainEnabled', 'setRainLevel', 'setRainSoundEnabled'];

/** 创建带类名与文本的元素 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (typeof text === 'string') node.textContent = text;
  return node;
}

/** 把任意异常转为可读文案（音效/可视化层可能抛字符串或对象） */
function toErrorMessage(err) {
  if (err && typeof err === 'object' && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  return String(err);
}

/** 校验并归一档位值；非法值返回 null（调用方保持既有显示） */
function normalizeLevel(value) {
  for (let i = 0; i < RAIN_LEVELS.length; i += 1) {
    if (RAIN_LEVELS[i].value === value) return value;
  }
  return null;
}

/** 注入本区块专用样式（幂等：已存在则跳过） */
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
  /* 折叠容器：flex 布局会覆盖 hidden 的默认 display:none，需显式声明 */
  .pet-rain-options { display: flex; flex-direction: column; gap: 6px; }
  .pet-rain-options[hidden] { display: none; }
  /* 仅叠加「不可用」态的降透明度，不覆盖已有的 .pet-switch 规则 */
  .pet-rain-switch[data-disabled="1"] { opacity: 0.45; cursor: not-allowed; }
  `;
  document.head.appendChild(style);
}

/**
 * @typedef {Object} RainPanelDeps
 * @property {object} [rain]                         需实现 C-RAIN-VISUAL@1 的 set/get 方法
 * @property {(patch: {enabled?: boolean, level?: RainLevel, soundEnabled?: boolean}) => void} [onChange]
 *                                                   配置已变化回调（宿主据此持久化）
 * @property {(msg: string) => void} [setStatus]     面板状态行（由 settingsPanel 透传）
 */

/**
 * 创建「全屏下雨」设置区块。
 *
 * @param {RainPanelDeps} deps
 * @returns {{
 *   element: HTMLElement,
 *   refresh: () => void,
 *   setConfig: (cfg: RainConfig) => void,
 *   destroy: () => void
 * }}
 */
export function createRainPanel(deps) {
  const cfg = deps && typeof deps === 'object' ? deps : {};
  const rain = cfg.rain || null;
  const onChange = typeof cfg.onChange === 'function' ? cfg.onChange : null;
  const externalSetStatus = typeof cfg.setStatus === 'function' ? cfg.setStatus : null;

  // rain 缺失或缺任一必需方法 → 整块禁用（保留 DOM 契约，便于验收定位）
  const available = REQUIRED_METHODS.every((name) => !!rain && typeof rain[name] === 'function');

  ensureStyle();

  // ---------------- DOM 结构 ----------------

  const root = el('div', 'pet-section pet-rain-section');
  root.dataset.role = 'rain-section';

  // 开关行：label 包裹 checkbox，整行可点
  const toggleLabel = el('label', 'pet-switch pet-rain-switch');
  const toggleBox = el('input');
  toggleBox.type = 'checkbox';
  toggleBox.dataset.role = 'rain-toggle';
  toggleBox.title = '开启或关闭全屏下雨效果';
  toggleLabel.appendChild(toggleBox);
  toggleLabel.appendChild(el('span', undefined, TEXT_TITLE));

  // 折叠配置容器：下雨关闭时整体隐藏
  const optionsEl = el('div', 'pet-rain-options');
  optionsEl.dataset.role = 'rain-options';
  optionsEl.hidden = true;

  const levelRow = el('div', 'pet-row');
  levelRow.appendChild(el('span', 'pet-label', TEXT_LEVEL));
  const levelSelect = el('select', 'pet-select');
  levelSelect.dataset.role = 'rain-level';
  levelSelect.setAttribute('aria-label', TEXT_LEVEL + '选择列表');
  levelSelect.title = '选择下雨的雨量档位';
  for (let i = 0; i < RAIN_LEVELS.length; i += 1) {
    const item = RAIN_LEVELS[i];
    const option = el('option', undefined, item.text);
    option.value = item.value;
    levelSelect.appendChild(option);
  }
  levelSelect.value = DEFAULT_LEVEL;
  levelRow.appendChild(levelSelect);

  const soundLabel = el('label', 'pet-switch pet-rain-switch');
  const soundBox = el('input');
  soundBox.type = 'checkbox';
  soundBox.dataset.role = 'rain-sound';
  soundBox.title = '开启或关闭雨声音效';
  soundLabel.appendChild(soundBox);
  soundLabel.appendChild(el('span', undefined, TEXT_SOUND));

  const soundHint = el('div', 'pet-status', TEXT_SOUND_HINT);

  optionsEl.appendChild(levelRow);
  optionsEl.appendChild(soundLabel);
  optionsEl.appendChild(soundHint);

  const statusEl = el('div', 'pet-status');
  statusEl.dataset.role = 'rain-status';

  root.appendChild(toggleLabel);
  root.appendChild(optionsEl);
  root.appendChild(statusEl);

  // ---------------- 内部状态 ----------------

  let destroyed = false;

  /**
   * 输出提示：优先交给宿主面板的状态行（settingsPanel 透传），缺省写到本区块状态行。
   * setStatus 自身异常不应打断 UI 流程，故吞掉异常并回退本地行。
   */
  function publishStatus(message) {
    const text = message == null ? '' : String(message);
    if (externalSetStatus) {
      try {
        externalSetStatus(text);
        return;
      } catch (err) {
        console.warn('[rainPanel] setStatus 回调失败:', err);
      }
    }
    statusEl.textContent = text;
  }

  /**
   * 通知宿主配置已变化；回调异常（含返回 Promise 的 reject）只记录，不影响面板可用性。
   *
   * @param {{enabled?: boolean, level?: RainLevel, soundEnabled?: boolean}} patch
   */
  function emitChange(patch) {
    if (!onChange || destroyed) return;
    try {
      const ret = onChange(patch);
      if (ret && typeof ret.then === 'function') {
        ret.catch((err) => console.warn('[rainPanel] onChange 回调失败:', err));
      }
    } catch (err) {
      console.warn('[rainPanel] onChange 回调失败:', err);
    }
  }

  /** 把整块置为不可用态：控件禁用 + 折叠 + 提示（幂等） */
  function applyUnavailable() {
    root.dataset.disabled = '1';
    toggleBox.checked = false;
    toggleBox.disabled = true;
    levelSelect.disabled = true;
    soundBox.disabled = true;
    toggleLabel.dataset.disabled = '1';
    soundLabel.dataset.disabled = '1';
    optionsEl.hidden = true;
    statusEl.textContent = TEXT_UNAVAILABLE;
  }

  // ---------------- 对外方法 ----------------

  /**
   * 用给定配置同步控件显示（只渲染，不调用 rain 的写入方法）。
   *
   * @param {RainConfig|null} next 完整配置；非法值（null/非对象）时保持既有显示
   */
  function setConfig(next) {
    if (destroyed) return;
    if (!available) {
      applyUnavailable();
      return;
    }
    if (!next || typeof next !== 'object') {
      console.warn('[rainPanel] setConfig 收到非法配置，保持当前显示');
      return;
    }

    const enabled = next.enabled === true;
    toggleBox.checked = enabled;
    // 关闭时折叠配置项（hidden === true），开启时展开
    optionsEl.hidden = !enabled;

    const level = normalizeLevel(next.level);
    if (level) levelSelect.value = level;

    soundBox.checked = next.soundEnabled === true;
  }

  /** 重新读取 rain.js 运行态并同步控件；读取失败按「无变化」降级 */
  function refresh() {
    if (destroyed) return;
    if (!available) {
      applyUnavailable();
      return;
    }

    let current = null;
    try {
      current = rain.getRainConfig();
    } catch (err) {
      console.warn('[rainPanel] 读取雨效配置失败:', err && err.message);
      return;
    }
    setConfig(current);
  }

  /** 幂等销毁：解绑事件并移除 DOM（样式表保留，供其它实例复用） */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    toggleBox.removeEventListener('change', handleToggleChange);
    levelSelect.removeEventListener('change', handleLevelChange);
    soundBox.removeEventListener('change', handleSoundChange);
    if (root.parentNode) root.parentNode.removeChild(root);
    else if (typeof root.remove === 'function') root.remove();
  }

  // ---------------- 事件处理 ----------------

  /**
   * 写入雨效并广播变更（统一顺序：rain.setRain*() → onChange(patch) → refresh()）。
   * 写入失败时重新同步显示，避免 UI 与真源分叉。
   *
   * @param {() => (RainConfig|void)} write 对 rain.js 的写入调用
   * @param {{enabled?: boolean, level?: RainLevel, soundEnabled?: boolean}} patch
   */
  function commit(write, patch) {
    try {
      write();
    } catch (err) {
      console.warn('[rainPanel] 写入雨效配置失败:', err);
      publishStatus(TEXT_FAIL_PREFIX + toErrorMessage(err));
      refresh();
      return;
    }
    emitChange(patch);
    refresh();
  }

  /** 开关：勾选写 enabled；关闭后折叠容器 hidden=true（由 setConfig 统一处理） */
  function handleToggleChange() {
    if (destroyed || !available) return;
    const value = toggleBox.checked === true;
    commit(() => rain.setRainEnabled(value), { enabled: value });
  }

  /** 档位：仅在值落在 RainLevel 枚举内时才生效 */
  function handleLevelChange() {
    if (destroyed || !available) return;
    const level = normalizeLevel(levelSelect.value);
    if (!level) {
      refresh();
      return;
    }
    commit(() => rain.setRainLevel(level), { level });
  }

  /** 音效：独立开关，不影响雨效渲染 */
  function handleSoundChange() {
    if (destroyed || !available) return;
    const value = soundBox.checked === true;
    commit(() => rain.setRainSoundEnabled(value), { soundEnabled: value });
  }

  // ---------------- 绑定与初始渲染 ----------------

  toggleBox.addEventListener('change', handleToggleChange);
  levelSelect.addEventListener('change', handleLevelChange);
  soundBox.addEventListener('change', handleSoundChange);

  if (available) {
    // 初始按 rain.getRainConfig() 渲染（等价于 setConfig(rain.getRainConfig())）
    refresh();
  } else {
    applyUnavailable();
  }

  return {
    element: root,
    refresh,
    setConfig,
    destroy
  };
}