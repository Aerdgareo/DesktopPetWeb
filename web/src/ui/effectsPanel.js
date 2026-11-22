/**
 * effectsPanel.js —— 「其他全屏特效」设置区块（下雪 / 樱花 / 群星 / 音符）
 *
 * 职责：提供氛围特效总开关与类型选择，变更以「先写 effects.js，再通知宿主，
 *       最后重新同步」的顺序传播。
 *
 * 设计约束：
 *  - 独立模块（禁止在 settingsPanel.js 内实现），由设置面板创建后挂载在雨效区块之后；
 *  - 数据真源为 effects/effects.js 的内存运行态，本模块只读取用于渲染，
 *    **禁止**写 localStorage（持久化由 main.js 统一负责 `pet.effects.v1`）；
 *  - DOM 契约（供测试与后续任务按选择器定位）：
 *      [data-role="effects-section"]  根元素（class="pet-section"）
 *      [data-role="effects-toggle"]   开关行 `.pet-switch` 内的 checkbox（文案「其他全屏特效」）
 *      [data-role="effects-options"]  折叠容器（class="pet-effects-options"；关闭时 hidden）
 *      [data-role="effects-kind"]     类型 select（class="pet-select"，五项中文文本）
 *      [data-role="effects-status"]   状态行（class="pet-status"）
 *  - 样式自带 `#pet-effects-style` 幂等注入，只作用于 `.pet-effects-*` 类，不覆盖设置面板规则。
 */

const STYLE_ID = 'pet-effects-style';

const TEXT_TITLE = '其他全屏特效';
const TEXT_KIND = '特效类型';
const TEXT_HINT = '与「全屏下雨」互斥：同一时刻只生效一种氛围特效';
const TEXT_UNAVAILABLE = '特效模块不可用';
const TEXT_FAIL_PREFIX = '特效操作失败：';

/**
 * @typedef {'none'|'snow'|'sakura'|'stars'|'notes'} EffectKind
 * @typedef {Object} EffectsConfig
 * @property {boolean} enabled
 * @property {EffectKind} kind
 */

/** 类型枚举与中文文案（值与 EffectKind 一一对应，顺序即下拉顺序） */
const EFFECT_KINDS = Object.freeze([
  { value: 'none', text: '无' },
  { value: 'snow', text: '下雪' },
  { value: 'sakura', text: '樱花' },
  { value: 'stars', text: '群星' },
  { value: 'notes', text: '音符' }
]);

/** 默认类型（与 effects.js 的默认配置保持一致） */
const DEFAULT_KIND = 'none';

/** effects 对象必须实现的方法（缺任一即视为不可用） */
const REQUIRED_METHODS = ['getEffectsConfig', 'setEffectsEnabled', 'setEffectKind'];

/** 创建带类名与文本的元素 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (typeof text === 'string') node.textContent = text;
  return node;
}

/** 把任意异常转为可读文案（可视化层可能抛字符串或对象） */
function toErrorMessage(err) {
  if (err && typeof err === 'object' && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  return String(err);
}

/** 校验并归一类型值；非法值返回 null（调用方保持既有显示） */
function normalizeKind(value) {
  for (let i = 0; i < EFFECT_KINDS.length; i += 1) {
    if (EFFECT_KINDS[i].value === value) return value;
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
  .pet-effects-options { display: flex; flex-direction: column; gap: 6px; }
  .pet-effects-options[hidden] { display: none; }
  /* 仅叠加「不可用」态的降透明度，不覆盖已有的 .pet-switch 规则 */
  .pet-effects-switch[data-disabled="1"] { opacity: 0.45; cursor: not-allowed; }
  `;
  document.head.appendChild(style);
}

/**
 * @typedef {Object} EffectsPanelDeps
 * @property {object} [effects]                       需实现 getEffectsConfig / setEffectsEnabled / setEffectKind
 * @property {(patch: {enabled?: boolean, kind?: EffectKind}) => void} [onChange]
 *                                                    配置已变化回调（宿主据此持久化与互斥收敛）
 * @property {(msg: string) => void} [setStatus]      面板状态行（由 settingsPanel 透传）
 */

/**
 * 创建「其他全屏特效」设置区块。
 *
 * @param {EffectsPanelDeps} deps
 * @returns {{
 *   element: HTMLElement,
 *   refresh: () => void,
 *   setConfig: (cfg: EffectsConfig) => void,
 *   destroy: () => void
 * }}
 */
export function createEffectsPanel(deps) {
  const cfg = deps && typeof deps === 'object' ? deps : {};
  const effects = cfg.effects || null;
  const onChange = typeof cfg.onChange === 'function' ? cfg.onChange : null;
  const externalSetStatus = typeof cfg.setStatus === 'function' ? cfg.setStatus : null;

  // effects 缺失或缺任一必需方法 → 整块禁用（保留 DOM 契约，便于验收定位）
  const available = REQUIRED_METHODS.every((name) => !!effects && typeof effects[name] === 'function');

  ensureStyle();

  // ---------------- DOM 结构 ----------------

  const root = el('div', 'pet-section pet-effects-section');
  root.dataset.role = 'effects-section';

  // 开关行：label 包裹 checkbox，整行可点
  const toggleLabel = el('label', 'pet-switch pet-effects-switch');
  const toggleBox = el('input');
  toggleBox.type = 'checkbox';
  toggleBox.dataset.role = 'effects-toggle';
  toggleBox.title = '开启或关闭其他全屏特效';
  toggleLabel.appendChild(toggleBox);
  toggleLabel.appendChild(el('span', undefined, TEXT_TITLE));

  // 折叠配置容器：特效关闭时整体隐藏
  const optionsEl = el('div', 'pet-effects-options');
  optionsEl.dataset.role = 'effects-options';
  optionsEl.hidden = true;

  const kindRow = el('div', 'pet-row');
  kindRow.appendChild(el('span', 'pet-label', TEXT_KIND));
  const kindSelect = el('select', 'pet-select');
  kindSelect.dataset.role = 'effects-kind';
  kindSelect.setAttribute('aria-label', TEXT_KIND + '选择列表');
  kindSelect.title = '选择氛围特效类型';
  for (let i = 0; i < EFFECT_KINDS.length; i += 1) {
    const item = EFFECT_KINDS[i];
    const option = el('option', undefined, item.text);
    option.value = item.value;
    kindSelect.appendChild(option);
  }
  kindSelect.value = DEFAULT_KIND;
  kindRow.appendChild(kindSelect);

  const hintEl = el('div', 'pet-status', TEXT_HINT);

  optionsEl.appendChild(kindRow);
  optionsEl.appendChild(hintEl);

  const statusEl = el('div', 'pet-status');
  statusEl.dataset.role = 'effects-status';

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
        console.warn('[effectsPanel] setStatus 回调失败:', err);
      }
    }
    statusEl.textContent = text;
  }

  /**
   * 通知宿主配置已变化；回调异常（含返回 Promise 的 reject）只记录，不影响面板可用性。
   *
   * @param {{enabled?: boolean, kind?: EffectKind}} patch
   */
  function emitChange(patch) {
    if (!onChange || destroyed) return;
    try {
      const ret = onChange(patch);
      if (ret && typeof ret.then === 'function') {
        ret.catch((err) => console.warn('[effectsPanel] onChange 回调失败:', err));
      }
    } catch (err) {
      console.warn('[effectsPanel] onChange 回调失败:', err);
    }
  }

  /** 把整块置为不可用态：控件禁用 + 折叠 + 提示（幂等） */
  function applyUnavailable() {
    root.dataset.disabled = '1';
    toggleBox.checked = false;
    toggleBox.disabled = true;
    kindSelect.disabled = true;
    toggleLabel.dataset.disabled = '1';
    optionsEl.hidden = true;
    statusEl.textContent = TEXT_UNAVAILABLE;
  }

  // ---------------- 对外方法 ----------------

  /**
   * 用给定配置同步控件显示（只渲染，不调用 effects 的写入方法）。
   *
   * @param {EffectsConfig|null} next 完整配置；非法值（null/非对象）时保持既有显示
   */
  function setConfig(next) {
    if (destroyed) return;
    if (!available) {
      applyUnavailable();
      return;
    }
    if (!next || typeof next !== 'object') {
      console.warn('[effectsPanel] setConfig 收到非法配置，保持当前显示');
      return;
    }

    const enabled = next.enabled === true;
    toggleBox.checked = enabled;
    // 关闭时折叠配置项（hidden === true），开启时展开
    optionsEl.hidden = !enabled;

    const kind = normalizeKind(next.kind);
    if (kind) kindSelect.value = kind;
  }

  /** 重新读取 effects.js 运行态并同步控件；读取失败按「无变化」降级 */
  function refresh() {
    if (destroyed) return;
    if (!available) {
      applyUnavailable();
      return;
    }

    let current = null;
    try {
      current = effects.getEffectsConfig();
    } catch (err) {
      console.warn('[effectsPanel] 读取特效配置失败:', err && err.message);
      return;
    }
    setConfig(current);
  }

  /** 幂等销毁：解绑事件并移除 DOM（样式表保留，供其它实例复用） */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    toggleBox.removeEventListener('change', handleToggleChange);
    kindSelect.removeEventListener('change', handleKindChange);
    if (root.parentNode) root.parentNode.removeChild(root);
    else if (typeof root.remove === 'function') root.remove();
  }

  // ---------------- 事件处理 ----------------

  /**
   * 写入特效配置并广播变更（统一顺序：effects.setEffects*() → onChange(patch) → refresh()）。
   * 写入失败时重新同步显示，避免 UI 与真源分叉。
   *
   * @param {() => (object|void)} write 对 effects.js 的写入调用
   * @param {{enabled?: boolean, kind?: EffectKind}} patch
   */
  function commit(write, patch) {
    try {
      write();
    } catch (err) {
      console.warn('[effectsPanel] 写入特效配置失败:', err);
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
    commit(() => effects.setEffectsEnabled(value), { enabled: value });
  }

  /** 类型：仅在值落在 EffectKind 枚举内时才生效 */
  function handleKindChange() {
    if (destroyed || !available) return;
    const kind = normalizeKind(kindSelect.value);
    if (!kind) {
      refresh();
      return;
    }
    commit(() => effects.setEffectKind(kind), { kind });
  }

  // ---------------- 绑定与初始渲染 ----------------

  toggleBox.addEventListener('change', handleToggleChange);
  kindSelect.addEventListener('change', handleKindChange);

  if (available) {
    // 初始按 effects.getEffectsConfig() 渲染
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

export default createEffectsPanel;