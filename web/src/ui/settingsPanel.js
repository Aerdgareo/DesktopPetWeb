/**
 * settingsPanel.js —— 桌宠设置面板（DOM 浮层）
 *
 * 设计约束：
 *  - 页面整体透明，面板自带半透明底（不污染人物后方区域）；
 *  - 固定在屏幕右下角，避免遮挡底部居中的角色；
 *  - 模型列表可滚动；面板可通过标题栏拖动；
 *  - 提供 isPointerOverUI(x,y)，与交互层联动实现「鼠标悬停面板时窗口可点」。
 *
 * 能力项：缩放滑条、模型切换列表、置顶开关、穿透开关、导入模型、退出、关闭。
 */

const STYLE_ID = 'pet-settings-style';

/** 注入面板专用样式（幂等） */
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
  .pet-panel, .pet-panel * { box-sizing: border-box; }

  .pet-panel {
    position: fixed;
    right: 16px;
    bottom: 16px;
    width: 272px;
    max-height: calc(100vh - 36px);   /* 尽量延长背景以容纳全部按钮；仍超高时面板内滚动 */
    overflow-y: auto;          /* 内容超出时在面板内滚动，绝不让按钮溢出背景 */
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 12px 14px;
    border-radius: 14px;
    background: rgba(18, 20, 28, 0.74);
    border: 1px solid rgba(255, 255, 255, 0.14);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    color: #e8e8f0;
    font-size: 12px;
    line-height: 1.5;
    z-index: 9998;
    user-select: none;
  }
  .pet-panel[hidden] { display: none; }

  .pet-panel__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    cursor: move;
  }
  .pet-panel__title { font-size: 13px; font-weight: 600; letter-spacing: 0.5px; }
  .pet-panel__close {
    width: 22px; height: 22px; line-height: 20px; text-align: center;
    border-radius: 6px; cursor: pointer;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: #e8e8f0; font-size: 13px; padding: 0;
  }
  .pet-panel__close:hover { background: rgba(255, 90, 90, 0.35); }

  .pet-section { display: flex; flex-direction: column; gap: 6px; flex: 0 0 auto; }
  /* 竖向分区内的直接子元素不参与弹性压缩（否则按钮会被压扁 → 只剩文字可点） */
  .pet-section > * { flex: 0 0 auto; }
  /* 直接位于分区内的「整行按钮」：占满宽度，整个按钮盒都可点击 */
  .pet-section > .pet-btn { width: 100%; }
  .pet-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .pet-label { color: #b9bccb; }
  .pet-value { color: #e8e8f0; font-variant-numeric: tabular-nums; }
  /* 长路径：单行省略，避免撑破固定宽度面板（完整路径经 title 提示） */
  .pet-path { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .pet-range { width: 100%; accent-color: #5b9dff; }

  .pet-list {
    max-height: 168px;
    overflow-y: auto;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(0, 0, 0, 0.18);
  }
  .pet-list::-webkit-scrollbar { width: 8px; }
  .pet-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.22); border-radius: 4px; }
  .pet-list::-webkit-scrollbar-track { background: transparent; }

  .pet-list__item {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    width: 100%; padding: 7px 10px; cursor: pointer;
    background: transparent; border: 0; color: #dfe2ec;
    font-size: 12px; text-align: left;
  }
  .pet-list__item:hover { background: rgba(255, 255, 255, 0.07); }
  .pet-list__item.is-active { background: rgba(91, 157, 255, 0.22); color: #fff; }
  .pet-list__badge {
    flex: none; padding: 1px 6px; border-radius: 999px; font-size: 10px;
    background: rgba(255, 255, 255, 0.1); color: #b9bccb;
  }
  .pet-list__empty { padding: 10px; color: #9aa0b3; text-align: center; }

  .pet-select {
    width: 100%; padding: 6px 8px; border-radius: 9px;
    background: rgba(0, 0, 0, 0.28);
    border: 1px solid rgba(255, 255, 255, 0.14);
    color: #e8e8f0; font-size: 12px;
  }
  .pet-select:disabled { opacity: 0.5; cursor: not-allowed; }
  .pet-select option { background: #12141c; color: #e8e8f0; }

  .pet-switch { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .pet-switch input { width: 15px; height: 15px; accent-color: #5b9dff; }
  .pet-switch[data-disabled="1"] { opacity: 0.45; cursor: not-allowed; }

  .pet-btn {
    flex: 1; padding: 7px 10px; border-radius: 9px; cursor: pointer;
    background: rgba(91, 157, 255, 0.22);
    border: 1px solid rgba(91, 157, 255, 0.45);
    color: #e8f0ff; font-size: 12px;
    white-space: nowrap; text-align: center;
  }
  .pet-btn:hover { background: rgba(91, 157, 255, 0.34); }
  .pet-btn:disabled { opacity: 0.4; cursor: not-allowed; background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.12); }
  .pet-btn--danger { background: rgba(255, 90, 90, 0.2); border-color: rgba(255, 90, 90, 0.45); color: #ffdede; }
  .pet-btn--danger:hover { background: rgba(255, 90, 90, 0.32); }
  /* 行内「删除」小按钮：不参与 flex 伸展，文字不截断 */
  .pet-btn--mini { flex: none; padding: 4px 8px; font-size: 11px; border-radius: 7px; }

  /* 外部地址列表：行内展示路径（单行省略）+ 删除按钮，防溢出 */
  .pet-extlist {
    display: flex; flex-direction: column;
    border-radius: 10px; overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(0, 0, 0, 0.18);
  }
  .pet-extlist[hidden] { display: none; }
  .pet-extrow {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 6px 8px;
  }
  .pet-extrow + .pet-extrow { border-top: 1px solid rgba(255, 255, 255, 0.08); }
  .pet-extpath {
    flex: 1 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: #dfe2ec;
  }

  .pet-status { color: #9aa0b3; font-size: 11px; word-break: break-all; }

  .pet-fab {
    position: fixed; right: 16px; bottom: 16px; width: 40px; height: 40px;
    border-radius: 50%; cursor: pointer; z-index: 9998;
    background: rgba(18, 20, 28, 0.74);
    border: 1px solid rgba(255, 255, 255, 0.16);
    color: #e8e8f0; font-size: 18px; line-height: 1;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
  }
  .pet-fab:hover { background: rgba(91, 157, 255, 0.3); }
  .pet-fab[hidden] { display: none; }
  `;
  document.head.appendChild(style);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (typeof text === 'string') node.textContent = text;
  return node;
}

/** 面板拖拽时至少需保留的可见面积比例（低于此值将缓动回弹，避免被"拖没"） */
const MIN_VISIBLE_RATIO = 0.06;

/** 计算某一维度在窗口 [0, max] 裁剪后的可见长度 */
function visibleLength(pos, len, max) {
  const start = Math.max(pos, 0);
  const end = Math.min(pos + len, max);
  return Math.max(0, end - start);
}

/** 使该维度「完全」落入窗口的贴边位置（回弹候选之一） */
function fitAxis(pos, len, max) {
  if (pos < 0) return 0;
  if (pos + len > max) return max - len;
  return pos;
}

/** 调整该维度位置，使可见长度不低于 need（允许面板继续越界，故不做硬钳制） */
function ensureAxisVisible(pos, len, max, need) {
  if (visibleLength(pos, len, max) >= need) return pos;
  if (pos < 0) return Math.min(max - len, need - len);   // 左侧/顶部越界 → 往窗口内移
  return Math.max(0, max - need);                        // 右侧/底部越界 → 往窗口内移
}

/**
 * 计算面板拖拽松手后的「回弹目标位置」。
 *
 * 规则：
 *  - 当前可见面积比例 >= minVisibleRatio 时返回 null（保持原位，允许继续越界被裁剪）；
 *  - 否则在「水平方向贴边完全可见」与「垂直方向贴边完全可见」两个候选中，
 *    取移动量最小者，保证可见面积不低于阈值 —— 面板不会被拖到无法再次抓取。
 *
 * @param {{left:number, top:number}} pos 当前位置（视口坐标）
 * @param {{w:number, h:number}} size 面板尺寸
 * @param {{W:number, H:number}} win 视口尺寸
 * @param {number} [minVisibleRatio=MIN_VISIBLE_RATIO]
 * @returns {{left:number, top:number}|null} 达标返回 null
 */
function computeBounceTarget(pos, size, win, minVisibleRatio = MIN_VISIBLE_RATIO) {
  const left = pos.left;
  const top = pos.top;
  const w = Math.max(1, size.w);
  const h = Math.max(1, size.h);
  const W = Math.max(1, win.W);
  const H = Math.max(1, win.H);

  const visibleW = visibleLength(left, w, W);
  const visibleH = visibleLength(top, h, H);
  const targetArea = minVisibleRatio * w * h;
  if (visibleW * visibleH >= targetArea) return null;

  // 若某一维度完全可见，另一维度至少需要保留的长度
  const needHWhenFullW = Math.min(h, Math.ceil(targetArea / w));
  const needWWhenFullH = Math.min(w, Math.ceil(targetArea / h));

  const candidates = [
    { left: fitAxis(left, w, W), top: ensureAxisVisible(top, h, H, needHWhenFullW) },
    { left: ensureAxisVisible(left, w, W, needWWhenFullH), top: fitAxis(top, h, H) }
  ];

  let best = null;
  let bestCost = Infinity;
  for (const c of candidates) {
    const cost = Math.abs(c.left - left) + Math.abs(c.top - top);
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  return best;
}

/**
 * 创建设置面板。
 *
 * @param {{
 *   modelLoader: object,
 *   bridge: object,
 *   models?: Array,                       // [{ id, name, url, type }]
 *   currentModelUrl?: string,
 *   onSwitchModel?: (url:string, model:object)=>void,
 *   onImportModel?: ()=>void,
 *   onRefreshModels?: ()=>Promise<any>|any,   // 重新加载模型清单（切换外部模型文件夹后调用）
 *   onQuit?: ()=>void,
 *   onInteractiveModeChange?: (auto:boolean)=>void,  // 勾选=自动穿透
 *   onAlwaysOnTopChange?: (value:boolean)=>void,

 *   scalePercent?: number
 * }} deps
 */
function createSettingsPanel(deps) {
  const modelLoader = deps.modelLoader;
  const bridge = deps.bridge;
  const caps = (bridge && bridge.capabilities) || {};

  ensureStyle();

  let models = Array.isArray(deps.models) ? deps.models.slice() : [];
  let currentUrl = deps.currentModelUrl || '';
  let currentKind = '';   // 当前模型「运行时判定」的 Cubism 版本（优先于清单声明）

  // ---------------- DOM ----------------

  const panel = el('div', 'pet-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '桌宠设置');

  const header = el('div', 'pet-panel__header');
  const title = el('div', 'pet-panel__title', '桌宠设置');
  const closeBtn = el('button', 'pet-panel__close', '×');
  closeBtn.type = 'button';
  closeBtn.title = '关闭设置面板';
  header.appendChild(title);
  header.appendChild(closeBtn);


  // 缩放
  const scaleSection = el('div', 'pet-section');
  const scaleRow = el('div', 'pet-row');
  const scaleLabel = el('span', 'pet-label', '缩放');
  const scaleValue = el('span', 'pet-value', '100%');
  scaleRow.appendChild(scaleLabel);
  scaleRow.appendChild(scaleValue);
  const scaleInput = el('input', 'pet-range');
  scaleInput.type = 'range';
  scaleInput.min = '10';
  scaleInput.max = '300';
  scaleInput.step = '1';
  scaleInput.value = String(deps.scalePercent != null ? deps.scalePercent : 100);
  scaleSection.appendChild(scaleRow);
  scaleSection.appendChild(scaleInput);

  // 模型列表
  const listSection = el('div', 'pet-section');
  const listLabel = el('span', 'pet-label', '模型');
  const list = el('div', 'pet-list');
  listSection.appendChild(listLabel);
  listSection.appendChild(list);

  // 表情 / 姿势动作（可选能力：依赖 modelLoader 暴露的循环切换 API）
  //  - 命名一次「读取候选名 + 当前索引」，点击时调用 next 方法循环切换；
  //  - 模型未提供数据时按钮置灰并给出提示，切换模型后由 setCurrentModel 触发刷新。

  /** 读取候选名称列表（modelLoader 未提供该 API 时返回空数组） */
  function readCycleNames(ctl) {
    const loader = modelLoader || {};
    const fn = loader[ctl.namesMethod];
    if (typeof fn !== 'function') return [];
    try {
      const names = fn.call(loader);
      return Array.isArray(names) ? names : [];
    } catch (err) {
      console.warn(`[settingsPanel] 读取「${ctl.title}」列表失败:`, err);
      return [];
    }
  }

  /** 读取当前索引（非法值回退 0） */
  function readCycleIndex(ctl) {
    const loader = modelLoader || {};
    const fn = loader[ctl.indexMethod];
    if (typeof fn !== 'function') return 0;
    try {
      const idx = fn.call(loader);
      return Number.isFinite(idx) && idx >= 0 ? idx : 0;
    } catch (err) {
      console.warn(`[settingsPanel] 读取「${ctl.title}」索引失败:`, err);
      return 0;
    }
  }

  /** 依据当前数据刷新控件：可用性 / 当前名称 / 选择列表 / 空数据提示 */
  function refreshCycleControl(ctl) {
    const names = readCycleNames(ctl);
    const available = names.length > 0;
    ctl.btn.disabled = !available;
    ctl.btn.title = available ? '' : ctl.emptyHint;

    // 选择列表：可用则填充候选（选中当前项），不可用则置灰并给出占位选项
    ctl.select.textContent = '';
    if (!available) {
      ctl.select.disabled = true;
      const opt = el('option', undefined, '（无）');
      opt.value = '';
      ctl.select.appendChild(opt);
      ctl.select.value = '';
      ctl.value.textContent = '—';
      ctl.hint.textContent = ctl.emptyHint;
      return;
    }
    ctl.select.disabled = false;
    const idx = readCycleIndex(ctl);
    names.forEach((name, i) => {
      const opt = el('option', undefined, String(name));
      opt.value = String(i);
      if (i === idx) opt.selected = true;
      ctl.select.appendChild(opt);
    });
    ctl.select.value = String(idx);
    ctl.value.textContent = names[idx] != null ? String(names[idx]) : String(idx);
    ctl.hint.textContent = '';
  }

  /** 创建一组「循环切换 + 选择列表」控件（标题 + 当前值 + 选择列表 + 按钮 + 提示） */
  function createCycleControl(opts) {
    const section = el('div', 'pet-section');

    const row = el('div', 'pet-row');
    row.appendChild(el('span', 'pet-label', opts.title));
    const value = el('span', 'pet-value', '—');
    row.appendChild(value);

    // 选择列表：选中即切换到该项（保留原「切换（下一个）」按钮）
    const select = el('select', 'pet-select');
    select.setAttribute('aria-label', `${opts.title}选择列表`);
    select.title = `选择${opts.title}`;

    const btnRow = el('div', 'pet-row');
    const btn = el('button', 'pet-btn', opts.buttonText);
    btn.type = 'button';
    btnRow.appendChild(btn);

    const hint = el('div', 'pet-status');

    section.appendChild(row);
    section.appendChild(select);
    section.appendChild(btnRow);
    section.appendChild(hint);

    const ctl = {
      section, btn, value, hint, select,
      title: opts.title,
      emptyHint: opts.emptyHint,
      namesMethod: opts.namesMethod,
      indexMethod: opts.indexMethod,
      nextMethod: opts.nextMethod,
      selectMethod: opts.selectMethod
    };

    // 选择列表：选择某项后直接切换到该项
    select.addEventListener('change', () => {
      const loader = modelLoader || {};
      const sel = loader[ctl.selectMethod];
      const idx = Number(select.value);
      let ok = false;
      if (Number.isInteger(idx) && idx >= 0 && typeof sel === 'function') {
        try {
          ok = !!sel.call(loader, idx);
        } catch (err) {
          console.warn(`[settingsPanel] 选择「${ctl.title}」失败:`, err);
        }
      }
      refreshCycleControl(ctl);
      if (ok) {
        const names = readCycleNames(ctl);
        const nowIdx = readCycleIndex(ctl);
        const name = names[nowIdx];
        setStatus(name != null ? `${ctl.title}：${name}` : '已选择');
      } else {
        setStatus(ctl.emptyHint);
      }
    });

    btn.addEventListener('click', () => {
      const loader = modelLoader || {};
      const next = loader[ctl.nextMethod];
      let ok = false;
      if (typeof next === 'function') {
        try {
          ok = !!next.call(loader);
        } catch (err) {
          console.warn(`[settingsPanel] 切换「${ctl.title}」失败:`, err);
        }
      }
      refreshCycleControl(ctl);
      if (ok) {
        const names = readCycleNames(ctl);
        const idx = readCycleIndex(ctl);
        const name = names[idx];
        setStatus(name != null ? `${ctl.title}：${name}` : '已切换');
      } else {
        setStatus(ctl.emptyHint);
      }
    });

    return ctl;
  }

  const exprCtl = createCycleControl({
    title: '表情',
    buttonText: '切换表情',
    emptyHint: '当前模型无表情数据',
    namesMethod: 'getExpressionNames',
    indexMethod: 'getExpressionIndex',
    nextMethod: 'nextExpression',
    selectMethod: 'selectExpression'
  });

  const poseCtl = createCycleControl({
    title: '姿势/动作',
    buttonText: '切换姿势/动作',
    emptyHint: '当前模型无动作数据',
    namesMethod: 'getPoseNames',
    indexMethod: 'getPoseIndex',
    nextMethod: 'nextPose',
    selectMethod: 'selectPose'
  });

  /** 刷新两组控件的可用性与名称（模型切换后调用） */
  function refreshCycleControls() {
    refreshCycleControl(exprCtl);
    refreshCycleControl(poseCtl);
  }

  // 开关
  const switchSection = el('div', 'pet-section');

  const topSwitch = el('label', 'pet-switch');
  const topCheckbox = el('input');
  topCheckbox.type = 'checkbox';
  topCheckbox.checked = true;
  topSwitch.appendChild(topCheckbox);
  topSwitch.appendChild(el('span', undefined, '窗口置顶'));

  const penetrateSwitch = el('label', 'pet-switch');
  const penetrateCheckbox = el('input');
  penetrateCheckbox.type = 'checkbox';
  penetrateCheckbox.checked = true;
  penetrateSwitch.appendChild(penetrateCheckbox);
  penetrateSwitch.appendChild(el('span', undefined, '鼠标穿透（悬停命中模型/面板才可点）'));

  switchSection.appendChild(topSwitch);
  switchSection.appendChild(penetrateSwitch);

  if (!caps.alwaysOnTop) {
    topSwitch.dataset.disabled = '1';
    topCheckbox.disabled = true;
  }
  // 外壳不具备 mousemove 转发能力（如 Tauri）时，无法实现「悬停自动穿透」
  const penetrateSupported = deps.penetrateSupported !== false;
  if (!caps.interactive || !penetrateSupported) {
    penetrateSwitch.dataset.disabled = '1';
    penetrateCheckbox.disabled = true;
    if (!penetrateSupported) penetrateCheckbox.checked = false;
  }

  // 操作按钮
  const actions = el('div', 'pet-section pet-row');
  const importBtn = el('button', 'pet-btn', '导入模型');
  importBtn.type = 'button';
  if (!caps.importModel) {
    // 外壳未提供 importModel：直接禁用并说明原因，避免"按钮启用却空操作"
    importBtn.disabled = true;
    importBtn.title = '当前外壳不支持导入';
  }
  const quitBtn = el('button', 'pet-btn pet-btn--danger', '退出');
  quitBtn.type = 'button';
  if (!caps.quit) quitBtn.disabled = true;
  actions.appendChild(importBtn);
  actions.appendChild(quitBtn);

  // 外部模型地址（可多个；与内置 models/ 并存并合并进模型列表）
  //  - 无地址：主按钮「选择外部模型文件夹」，点击直接选择（追加）；
  //  - 有地址：主按钮变「查看外部模型地址」，点击展开 / 收起地址列表；
  //            列表每行显示路径 + 「删除」；列表下方「添加外部模型文件夹」（追加）。
  const extSection = el('div', 'pet-section');
  const extTitleRow = el('div', 'pet-row');
  extTitleRow.appendChild(el('span', 'pet-label', '外部模型文件夹'));
  const extCountEl = el('span', 'pet-value', '0 个');
  extTitleRow.appendChild(extCountEl);

  const extMainBtn = el('button', 'pet-btn', '选择外部模型文件夹');
  extMainBtn.type = 'button';

  const extList = el('div', 'pet-extlist');
  extList.hidden = true;

  const extAddBtn = el('button', 'pet-btn', '添加外部模型文件夹');
  extAddBtn.type = 'button';
  extAddBtn.hidden = true; // 无地址时隐藏（选择由主按钮负责）

  const extHint = el('div', 'pet-status', '');

  extSection.appendChild(extTitleRow);
  extSection.appendChild(extMainBtn);
  extSection.appendChild(extList);
  extSection.appendChild(extAddBtn);
  extSection.appendChild(extHint);

  const extSupported = !!caps.externalModelsDir;
  if (!extSupported) {
    // 外壳未提供该能力：禁用按钮并说明原因（避免"启用却空操作"）
    extMainBtn.disabled = true;
    extAddBtn.disabled = true;
    extMainBtn.title = '当前外壳不支持外部模型文件夹';
    extAddBtn.title = '当前外壳不支持外部模型文件夹';
  }

  // 重置模型位置（放在不常用位置：面板靠底部）
  const resetSection = el('div', 'pet-section');
  const resetBtn = el('button', 'pet-btn', '重置模型位置');
  resetBtn.type = 'button';
  resetBtn.title = '将人物恢复到默认位置（底部居中）';
  resetBtn.addEventListener('click', () => {
    if (modelLoader && typeof modelLoader.resetModelPosition === 'function') modelLoader.resetModelPosition();
  });
  resetSection.appendChild(resetBtn);

  // 状态行
  const status = el('div', 'pet-status', '就绪');

  panel.appendChild(header);

  panel.appendChild(scaleSection);
  panel.appendChild(listSection);
  panel.appendChild(exprCtl.section);
  panel.appendChild(poseCtl.section);
  panel.appendChild(switchSection);
  panel.appendChild(actions);
  panel.appendChild(extSection);
  panel.appendChild(resetSection);
  panel.appendChild(status);
  document.body.appendChild(panel);

  // 悬浮开关按钮（面板隐藏时显示）
  const fab = el('button', 'pet-fab', '⚙');
  fab.type = 'button';
  fab.title = '打开设置面板';
  fab.hidden = true;
  document.body.appendChild(fab);

  // ---------------- 模型列表渲染 ----------------

  function normalizeModel(m) {
    if (!m) return null;
    if (typeof m === 'string') return { id: m, name: m, url: m, type: '' };
    return {
      id: m.id || m.url || m.name || '',
      name: m.name || m.id || m.url || '未命名模型',
      url: m.url || '',
      type: m.type || ''
    };
  }

  function renderList() {
    list.textContent = '';
    if (!models.length) {
      list.appendChild(el('div', 'pet-list__empty', '暂无可用模型'));
      return;
    }
    models.forEach((raw) => {
      const m = normalizeModel(raw);
      if (!m || !m.url) return;

      const item = el('button', 'pet-list__item');
      item.type = 'button';
      item.title = m.url;

      const nameSpan = el('span', undefined, m.name);
      item.appendChild(nameSpan);
      // 当前模型优先显示「运行时判定」的版本，避免清单里手写/缺失 type 造成误标
      const badgeText = (m.url === currentUrl && currentKind) ? currentKind : m.type;
      if (badgeText) item.appendChild(el('span', 'pet-list__badge', badgeText));

      if (m.url === currentUrl) item.classList.add('is-active');
      item.addEventListener('click', () => {
        if (m.url === currentUrl) return;
        currentUrl = m.url;
        setStatus(`正在切换：${m.name}…`);
        renderList();
        if (typeof deps.onSwitchModel === 'function') {
          deps.onSwitchModel(m.url, m);
        } else if (modelLoader && modelLoader.switchModel) {
          modelLoader.switchModel(m.url);
        }
      });

      list.appendChild(item);
    });
  }

  function setStatus(text) {
    status.textContent = text || '';
  }

  // ---------------- 交互绑定 ----------------


  scaleInput.addEventListener('input', () => {
    const percent = Number(scaleInput.value);
    scaleValue.textContent = `${percent}%`;
    if (modelLoader && modelLoader.setScalePercent) modelLoader.setScalePercent(percent);
    if (typeof deps.onScaleChange === 'function') deps.onScaleChange(percent);
  });

  topCheckbox.addEventListener('change', () => {
    const value = topCheckbox.checked;
    if (typeof deps.onAlwaysOnTopChange === 'function') {
      deps.onAlwaysOnTopChange(value);
    } else if (bridge && bridge.setAlwaysOnTop) {
      bridge.setAlwaysOnTop(value);
    }
  });

penetrateCheckbox.addEventListener('change', () => {
    const auto = penetrateCheckbox.checked;
    if (typeof deps.onInteractiveModeChange === 'function') deps.onInteractiveModeChange(auto);
  });

  importBtn.addEventListener('click', () => {
    if (typeof deps.onImportModel === 'function') deps.onImportModel();
  });

  quitBtn.addEventListener('click', () => {
    if (typeof deps.onQuit === 'function') deps.onQuit();
    else if (bridge && bridge.quit) bridge.quit();
  });

  // —— 外部模型地址：读取全部 / 选择（追加）/ 展开列表 / 删除（增删后刷新模型列表）——
  let extDirs = [];         // 当前已添加地址数组 [{id,path}]
  let extListOpen = false;  // 地址列表是否展开

  /** 重绘：主按钮文案 + 计数 + 地址列表内容 */
  function renderExtUi() {
    const has = extDirs.length > 0;
    extCountEl.textContent = has ? `${extDirs.length} 个` : '0 个';

    if (!extSupported) {
      extMainBtn.disabled = true;
      extList.hidden = true;
      extAddBtn.hidden = true;
      return;
    }

    // 主按钮：无地址 → 直接选择；有地址 → 展开 / 收起
    extMainBtn.textContent = has ? '查看外部模型地址' : '选择外部模型文件夹';
    extAddBtn.hidden = !has;

    extList.textContent = '';
    if (!has || !extListOpen) {
      extList.hidden = true;
      return;
    }
    extList.hidden = false;
    extDirs.forEach((dir) => {
      const row = el('div', 'pet-extrow');
      const pathEl = el('span', 'pet-extpath', dir && dir.path ? dir.path : '(无效路径)');
      if (dir && dir.path) pathEl.title = dir.path;
      const delBtn = el('button', 'pet-btn pet-btn--danger pet-btn--mini', '删除');
      delBtn.type = 'button';
      delBtn.title = dir && dir.path ? `删除该外部地址：${dir.path}` : '删除该外部地址';
      delBtn.addEventListener('click', () => { removeExtDir(dir); });
      row.appendChild(pathEl);
      row.appendChild(delBtn);
      extList.appendChild(row);
    });
  }

  /** 读取并展示全部外部模型地址（未设置 / 不可用为空数组） */
  async function refreshExternalDir() {
    if (!extSupported || !bridge || typeof bridge.getExternalModelsDirs !== 'function') {
      extDirs = [];
      extListOpen = false;
      extHint.textContent = extSupported ? '未添加外部模型文件夹' : '当前外壳不支持外部模型文件夹';
      renderExtUi();
      return;
    }
    try {
      const dirs = await bridge.getExternalModelsDirs();
      extDirs = Array.isArray(dirs) ? dirs : [];
    } catch (err) {
      console.warn('[settingsPanel] 读取外部模型地址失败:', err);
      extDirs = [];
    }
    if (extDirs.length === 0) extListOpen = false; // 删空后自动收起，按钮文案回到「选择外部模型文件夹」
    renderExtUi();
    extHint.textContent = extDirs.length ? '' : '未添加外部模型文件夹';
  }

  /** 触发上层重新加载模型清单（含外部目录），使新模型立即出现在列表 */
  async function refreshModels() {
    if (typeof deps.onRefreshModels === 'function') {
      try {
        await deps.onRefreshModels();
      } catch (err) {
        console.warn('[settingsPanel] 刷新模型列表失败:', err);
      }
    }
  }

  /** 选择外部模型文件夹（追加到列表，不覆盖已有），成功后刷新地址与模型列表 */
  async function pickExtDir() {
    if (!extSupported || !bridge || typeof bridge.pickExternalModelsDir !== 'function') return;
    setStatus('请选择外部模型文件夹…');
    let dirs = null;
    try {
      dirs = await bridge.pickExternalModelsDir();
    } catch (err) {
      console.warn('[settingsPanel] 选择外部模型文件夹失败:', err);
      setStatus('选择外部模型文件夹失败');
      return;
    }
    if (!Array.isArray(dirs)) {
      setStatus('已取消选择');
      return;
    }
    setStatus(`已添加外部模型文件夹（共 ${dirs.length} 个）`);
    await refreshExternalDir();
    await refreshModels();
  }

  /** 删除一个外部地址，成功后刷新地址与模型列表 */
  async function removeExtDir(dir) {
    if (!extSupported || !bridge || typeof bridge.removeExternalModelsDir !== 'function') return;
    const key = dir && (dir.id || dir.path);
    if (!key) return;
    let dirs = null;
    try {
      dirs = await bridge.removeExternalModelsDir(key);
    } catch (err) {
      console.warn('[settingsPanel] 删除外部地址失败:', err);
    }
    if (!Array.isArray(dirs)) {
      setStatus('删除外部地址失败');
      return;
    }
    setStatus(`已删除外部地址：${(dir && dir.path) || key}`);
    await refreshExternalDir();
    await refreshModels();
  }

  extMainBtn.addEventListener('click', async () => {
    if (extDirs.length === 0) {
      await pickExtDir();           // 无地址：直接选择（追加）
    } else {
      extListOpen = !extListOpen;   // 有地址：展开 / 收起列表
      renderExtUi();
    }
  });

  extAddBtn.addEventListener('click', () => { pickExtDir(); });

  // 兼容旧接口：清空全部地址（外部数据变更后刷新地址与模型列表）
  async function clearExternalDirs() {
    if (!extSupported || !bridge || typeof bridge.clearExternalModelsDirs !== 'function') return false;
    let ok = false;
    try {
      ok = await bridge.clearExternalModelsDirs();
    } catch (err) {
      console.warn('[settingsPanel] 清空外部地址失败:', err);
    }
    await refreshExternalDir();
    await refreshModels();
    return ok;
  }

  closeBtn.addEventListener('click', () => hide());

  // 标题栏拖动：允许拖出窗口边缘（越出即被窗口裁剪），
  // 仅在松手时可见面积比例低于 MIN_VISIBLE_RATIO 时缓动回弹，避免面板被"拖没"。
  (function enableDrag() {
    /** 回弹缓动时长（ms） */
    const BOUNCE_DURATION = 180;

    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;
    let bounceRaf = 0;   // 回弹动画句柄

    function cancelBounce() {
      if (bounceRaf) {
        cancelAnimationFrame(bounceRaf);
        bounceRaf = 0;
      }
    }

    /** 把面板缓动到目标位置（easeOutCubic） */
    function animateTo(targetLeft, targetTop) {
      const startLeft = panel.offsetLeft;
      const startTop = panel.offsetTop;
      const dx = targetLeft - startLeft;
      const dy = targetTop - startTop;
      if (dx === 0 && dy === 0) return;

      // 拖动/回弹后统一改为绝对定位
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';

      const reduceMotion = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduceMotion || typeof requestAnimationFrame !== 'function') {
        panel.style.left = `${targetLeft}px`;
        panel.style.top = `${targetTop}px`;
        return;
      }

      const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const startTime = now();
      const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

      const step = () => {
        const t = Math.min(1, (now() - startTime) / BOUNCE_DURATION);
        const k = easeOutCubic(t);
        panel.style.left = `${startLeft + dx * k}px`;
        panel.style.top = `${startTop + dy * k}px`;
        bounceRaf = t < 1 ? requestAnimationFrame(step) : 0;
      };
      bounceRaf = requestAnimationFrame(step);
    }

    const onDown = (e) => {
      if (e.button !== 0) return;
      cancelBounce();
      dragging = true;
      const rect = panel.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp, { once: true });
    };

    const onMove = (e) => {
      if (!dragging) return;
      // 允许拖出窗口边缘（越出部分由窗口裁剪），不做硬钳制
      const left = e.clientX - offsetX;
      const top = e.clientY - offsetY;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };

    const onUp = () => {
      dragging = false;
      window.removeEventListener('mousemove', onMove);

      // 松手时若可见比例过低，缓动弹回至满足最小可见比例的位置
      const target = computeBounceTarget(
        { left: panel.offsetLeft, top: panel.offsetTop },
        { w: panel.offsetWidth, h: panel.offsetHeight },
        { W: window.innerWidth, H: window.innerHeight }
      );
      if (target) animateTo(target.left, target.top);
    };

    header.addEventListener('mousedown', onDown);
  })();

  // ---------------- 显隐 / UI 命中 ----------------

  function show() {
    panel.hidden = false;
    fab.hidden = true;
  }

  function hide() {
    panel.hidden = true;
    fab.hidden = false;
  }

  function isOpen() {
    return !panel.hidden;
  }

  function toggle() {
    if (isOpen()) hide();
    else show();
  }

  fab.addEventListener('click', show);

  /**
   * 判断坐标是否落在面板 UI 上（交互层用于决定是否让窗口可点）。
   * @returns {boolean}
   */
  function isPointerOverUI(x, y) {
    const nodes = [panel, fab];
    for (const node of nodes) {
      if (!node || node.hidden) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
    }
    return false;
  }

  // 初始渲染
  renderList();
  refreshCycleControls();
  refreshExternalDir();
  // 默认打开面板（方便首次使用；外壳也可调用 hide()）
  show();

  return {
    element: panel,
    fabElement: fab,
    show,
    hide,
    toggle,
    isOpen,
    isPointerOverUI,
    setStatus,
    /** 更新模型清单 */
    setModels(nextModels, nextCurrentUrl) {
      models = Array.isArray(nextModels) ? nextModels.slice() : [];
      if (typeof nextCurrentUrl === 'string') currentUrl = nextCurrentUrl;
      renderList();
    },
    /** 标记当前模型（切换完成后调用）；kind 为运行时判定的 Cubism 版本 */
    setCurrentModel(url, displayName, kind) {
      currentUrl = url || '';
      if (typeof kind === 'string' && kind) currentKind = kind;
      renderList();
      // 模型切换后，表情/动作数据随之变化 → 刷新两组控件的可用性与名称
      refreshCycleControls();
      if (displayName) {
        setStatus(`当前模型：${displayName}${currentKind ? `（${currentKind}）` : ''}`);
      }
    },
    /** 同步缩放滑条为指定值 */
    setScaleValue(percent) {
      const p = percent != null ? percent : 100;
      scaleInput.value = String(p);
      scaleValue.textContent = `${p}%`;
    },
    /** 穿透开关勾选状态（true = 自动穿透） */
    setPenetrateChecked(auto) {
      penetrateCheckbox.checked = !!auto;
    },
    setAlwaysOnTopChecked(value) {
      topCheckbox.checked = !!value;
    },
    /** 重新读取表情/动作数据并刷新两组控件（模型切换或外部数据变更后调用） */
    refreshCycleControls,
    /** 重新读取并展示外部模型地址列表（切换外部目录后调用） */
    refreshExternalDir,
    /** 清空全部外部模型地址（兼容能力，供外部调用） */
    clearExternalDirs,
    destroy() {
      panel.remove();
      fab.remove();
    }
  };
}

export { createSettingsPanel, computeBounceTarget, visibleLength, MIN_VISIBLE_RATIO };
export default createSettingsPanel;