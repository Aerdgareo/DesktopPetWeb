/**
 * instancePanel.js —— 「已显示模型」设置区块（R3）
 *
 * 职责：展示当前窗口内同时显示的模型实例列表（模型1…模型N），
 *       高亮活动实例、点击切换活动实例、两段式「仅从窗口移除」（不删磁盘文件），
 *       并在标题行显示 `n/limit` 计数（上限默认 6）。
 *
 * 设计约束：
 *  - 独立模块（禁止在 settingsPanel.js 内实现），由设置面板创建后挂载；
 *  - 本模块只负责渲染与交互，数据真源为宿主（instances 存储 / modelLoader），
 *    **禁止**调用 modelLoader、**禁止**读写 localStorage；
 *  - DOM 契约（供测试与后续任务按选择器定位）：
 *      [data-role="instance-section"]  根元素（class="pet-section"，class 含 pet-instance-section）
 *      [data-role="instance-count"]    计数显示（.pet-value，文本 `${n}/${limit}`）
 *      [data-role="instance-list"]     列表容器（class="pet-list"）
 *      [data-role="instance-item"]     条目按钮（class="pet-list__item"；data-instance-id；active → .is-active）
 *      [data-role="instance-remove"]   移除按钮（class="pet-btn pet-btn--danger pet-btn--mini"，两段式）
 *      [data-role="instance-status"]   提示行（class="pet-status"；说明"仅从窗口移除"）
 *  - 样式完全复用设置面板注入的 .pet-list* / .pet-btn--mini 等既有类，
 *    本文件**不注入**任何样式表。
 */

const DEFAULT_LIMIT = 6;
/** 两段式移除的待命时长（毫秒）：超时未确认则复位为「移除」 */
const ARM_TIMEOUT_MS = 3000;

const TEXT_TITLE = '已显示模型';
const TEXT_EMPTY = '尚未显示任何模型';
const TEXT_REMOVE = '移除';
const TEXT_CONFIRM_REMOVE = '确认移除';
const TEXT_REMOVE_HINT = '仅从窗口移除，不删除模型文件';
const TEXT_REMOVE_DONE = '已从窗口移除：';
const TEXT_REMOVE_SUFFIX = '（不删除模型文件）';

/**
 * @typedef {Object} InstanceView
 * @property {string} id
 * @property {string} name
 * @property {boolean} [active]
 * @property {string} [kind]
 */

/** 创建带类名与文本的元素 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (typeof text === 'string') node.textContent = text;
  return node;
}

/** 把任意异常转为可读文案（宿主回调可能抛字符串或对象） */
function toErrorMessage(err) {
  if (err && typeof err === 'object' && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  return String(err);
}

/** 归一上限：仅接受 ≥1 的有限数，其余回退到 fallback */
function normalizeLimit(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

/**
 * 归一实例条目：非法（无 id）→ null；name 缺失时回退为 id，保证条目总有可读文本。
 *
 * @param {*} raw
 * @returns {InstanceView|null}
 */
function normalizeInstance(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;

  const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name : id;
  const kind = typeof raw.kind === 'string' && raw.kind.trim().length > 0 ? raw.kind : '';
  const inst = { id, name, active: raw.active === true };
  if (kind) inst.kind = kind;
  return inst;
}

/**
 * 解析活动实例 id：
 *  - 传入字符串 → 仅当其存在于列表时才生效（避免悬空高亮）；
 *  - 传入 null → 明确「无活动项」；
 *  - undefined（未提供）→ 由列表内 active 字段推断。
 *
 * @param {InstanceView[]} list
 * @param {string|null|undefined} activeId
 * @returns {string|null}
 */
function resolveActiveId(list, activeId) {
  if (typeof activeId === 'string') {
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].id === activeId) return activeId;
    }
    return null;
  }
  if (activeId === null) return null;

  for (let i = 0; i < list.length; i += 1) {
    if (list[i].active === true) return list[i].id;
  }
  return null;
}

/**
 * @typedef {Object} InstancePanelDeps
 * @property {InstanceView[]} [instances]        初始实例列表（可选）
 * @property {string|null} [activeId]            初始活动实例 id（省略时按列表 active 字段推断）
 * @property {number} [limit]                    同显上限（默认 6）
 * @property {(id: string) => void} [onSelect]   选中实例回调
 * @property {(id: string) => void} [onRemove]   移除实例回调（仅从窗口移除）
 */

/**
 * 创建「已显示模型」区块。
 *
 * @param {InstancePanelDeps} deps
 * @returns {{
 *   element: HTMLElement,
 *   setInstances: (list: InstanceView[], activeId?: string|null) => void,
 *   setLimit: (n: number) => void,
 *   destroy: () => void
 * }}
 */
export function createInstancePanel(deps) {
  const cfg = deps && typeof deps === 'object' ? deps : {};
  const onSelect = typeof cfg.onSelect === 'function' ? cfg.onSelect : null;
  const onRemove = typeof cfg.onRemove === 'function' ? cfg.onRemove : null;

  // ---------------- DOM 结构 ----------------

  const root = el('div', 'pet-section pet-instance-section');
  root.dataset.role = 'instance-section';
  // 根元素提示：整块语义即「仅影响窗口内显示」
  root.title = TEXT_REMOVE_HINT;

  const titleRow = el('div', 'pet-row');
  titleRow.appendChild(el('span', 'pet-label', TEXT_TITLE));
  const countEl = el('span', 'pet-value', '0/' + DEFAULT_LIMIT);
  countEl.dataset.role = 'instance-count';
  countEl.title = '当前显示数量 / 上限';
  titleRow.appendChild(countEl);

  const listEl = el('div', 'pet-list');
  listEl.dataset.role = 'instance-list';

  const statusEl = el('div', 'pet-status', TEXT_REMOVE_HINT);
  statusEl.dataset.role = 'instance-status';

  root.appendChild(titleRow);
  root.appendChild(listEl);
  root.appendChild(statusEl);

  // ---------------- 内部状态 ----------------

  let limit = normalizeLimit(cfg.limit, DEFAULT_LIMIT);
  /** @type {InstanceView[]} */
  let currentList = [];
  /** @type {string|null} */
  let currentActiveId = null;
  let destroyed = false;
  /** 每次渲染挂出的 3s 复位定时器；重建列表或销毁时统一清理，避免闭包泄漏 */
  const armTimers = new Set();

  function clearArmTimers() {
    armTimers.forEach((timer) => clearTimeout(timer));
    armTimers.clear();
  }

  /** 输出提示到本区块状态行（不改动宿主面板状态） */
  function setStatus(message) {
    statusEl.textContent = message == null || message === '' ? TEXT_REMOVE_HINT : String(message);
  }

  /** 按当前列表与上限刷新计数显示 */
  function updateCount() {
    countEl.textContent = currentList.length + '/' + limit;
  }

  /** 依据 id 取显示名（不存在 → 回退 id 本身） */
  function nameOf(id) {
    for (let i = 0; i < currentList.length; i += 1) {
      if (currentList[i].id === id) return currentList[i].name;
    }
    return id;
  }

  /**
   * 通知宿主「选中实例」；已 active 的条目不会走到这里（见 handleSelect）。
   * 回调异常（含 Promise reject）只记录，不影响面板可用性。
   */
  function emitSelect(id) {
    if (!onSelect) return;
    try {
      const ret = onSelect(id);
      if (ret && typeof ret.then === 'function') {
        ret.catch((err) => console.warn('[instancePanel] onSelect 回调失败:', err));
      }
    } catch (err) {
      console.warn('[instancePanel] onSelect 回调失败:', err);
    }
  }

  /**
   * 通知宿主「移除实例」；回调异常只记录。
   * 无论成功与否都恢复按钮可用，避免宿主异常导致按钮永久禁用。
   */
  function emitRemove(id, button) {
    if (!onRemove) {
      button.disabled = false;
      return;
    }
    try {
      const ret = onRemove(id);
      if (ret && typeof ret.then === 'function') {
        ret.catch((err) => {
          console.warn('[instancePanel] onRemove 回调失败:', err);
          button.disabled = false;
          setStatus('移除失败：' + toErrorMessage(err));
        });
      } else {
        button.disabled = false;
      }
    } catch (err) {
      console.warn('[instancePanel] onRemove 回调失败:', err);
      button.disabled = false;
      setStatus('移除失败：' + toErrorMessage(err));
    }
  }

  // ---------------- 交互处理 ----------------

  /** 点击条目：已 active 不重复回调；否则本地乐观高亮并通知宿主 */
  function handleSelect(id) {
    if (destroyed) return;
    if (id === currentActiveId) return;

    currentActiveId = id;
    render();
    setStatus('已切换到：' + nameOf(id));
    emitSelect(id);
  }

  /**
   * 创建两段式「移除」按钮：
   *  首次点击 → 文案「确认移除」+ .is-armed，3 秒后自动复位；
   *  再次点击 → 复位并调用 onRemove(id)（仅从窗口移除，不删磁盘文件）。
   *
   * @param {InstanceView} inst
   * @returns {HTMLButtonElement}
   */
  function createRemoveButton(inst) {
    const btn = el('button', 'pet-btn pet-btn--danger pet-btn--mini', TEXT_REMOVE);
    btn.type = 'button';
    btn.dataset.role = 'instance-remove';
    btn.dataset.instanceId = inst.id;
    btn.title = '仅从窗口移除「' + inst.name + '」（不删除模型文件）';

    let armed = false;
    let timer = 0;

    function reset() {
      armed = false;
      if (timer) {
        clearTimeout(timer);
        armTimers.delete(timer);
        timer = 0;
      }
      btn.textContent = TEXT_REMOVE;
      btn.classList.remove('is-armed');
    }

    btn.addEventListener('click', (ev) => {
      // 移除按钮与条目按钮并排：必须阻止冒泡，避免顺带触发选中
      ev.stopPropagation();
      if (destroyed || btn.disabled) return;

      if (!armed) {
        armed = true;
        btn.textContent = TEXT_CONFIRM_REMOVE;
        btn.classList.add('is-armed');
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          armTimers.delete(timer);
          timer = 0;
          reset();
        }, ARM_TIMEOUT_MS);
        armTimers.add(timer);
        return;
      }

      reset();
      btn.disabled = true;
      setStatus(TEXT_REMOVE_DONE + inst.name + TEXT_REMOVE_SUFFIX);
      emitRemove(inst.id, btn);
    });

    return btn;
  }

  // ---------------- 渲染 ----------------

  /** 全量重建列表：条目顺序即「模型1…模型N」的顺序 */
  function render() {
    if (destroyed) return;

    // 重建会丢弃旧按钮节点，其 3s 复位定时器必须同时作废
    clearArmTimers();
    updateCount();
    listEl.textContent = '';

    if (!currentList.length) {
      listEl.appendChild(el('div', 'pet-list__empty', TEXT_EMPTY));
      return;
    }

    currentList.forEach((inst, index) => {
      const row = el('div', 'pet-list__row');

      const item = el('button', 'pet-list__item');
      item.type = 'button';
      item.dataset.role = 'instance-item';
      item.dataset.instanceId = inst.id;
      item.title = inst.name + '（模型' + (index + 1) + '）\n点击切换到此模型';

      // 契约文本：`${index+1}. ${name}`（序号从 1 开始）
      item.appendChild(el('span', 'pet-list__name', (index + 1) + '. ' + inst.name));
      if (inst.kind) item.appendChild(el('span', 'pet-list__badge', inst.kind));

      if (inst.id === currentActiveId) {
        item.classList.add('is-active');
        item.setAttribute('aria-current', 'true');
      }

      item.addEventListener('click', () => handleSelect(inst.id));

      row.appendChild(item);
      row.appendChild(createRemoveButton(inst));
      listEl.appendChild(row);
    });
  }

  // ---------------- 对外方法 ----------------

  /**
   * 用宿主给出的权威列表刷新显示。
   *
   * @param {InstanceView[]} list                   实例列表（非法条目被忽略）
   * @param {string|null} [activeId]                活动实例 id；省略时按条目 active 字段推断
   */
  function setInstances(list, activeId) {
    if (destroyed) return;

    const next = [];
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i += 1) {
        const inst = normalizeInstance(list[i]);
        if (inst) next.push(inst);
      }
    }

    currentList = next;
    currentActiveId = resolveActiveId(next, activeId);
    render();
  }

  /**
   * 设置同显上限（默认 6），只影响计数显示，不裁剪已存在的条目。
   *
   * @param {number} n
   */
  function setLimit(n) {
    if (destroyed) return;
    limit = normalizeLimit(n, limit);
    updateCount();
  }

  /** 幂等销毁：清理定时器与 DOM（无自有样式表需要移除） */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearArmTimers();
    currentList = [];
    currentActiveId = null;
    listEl.textContent = '';
    if (root.parentNode) root.parentNode.removeChild(root);
    else if (typeof root.remove === 'function') root.remove();
  }

  // ---------------- 初始渲染 ----------------

  if (Array.isArray(cfg.instances)) {
    setInstances(cfg.instances, cfg.activeId);
  } else {
    render();
  }

  return {
    element: root,
    setInstances,
    setLimit,
    destroy
  };
}