/**
 * main.js —— 桌宠 Web 渲染前端入口（Electron / Tauri 共用）
 *
 * 编排：PIXI.Application（全屏透明）→ 模型加载 → 设置面板 → 交互（视线/拖拽/点击/穿透）→ 外壳桥。
 */

import { bridge } from './bridge.js';
import * as modelLoader from './live2d/modelLoader.js';
import { createPetInteraction } from './interaction/petInteraction.js';
import { createSettingsPanel } from './ui/settingsPanel.js';

/** localStorage 键名 */
const LS = {
  modelUrl: 'pet.modelUrl',
  alpha: 'pet.alpha',
  scale: 'pet.scalePercent',
  alwaysOnTop: 'pet.alwaysOnTop'
};

/** 内置演示模型（官方向 pixi-live2d-display 测试资源，需联网）：
 *  - shizuku：Cubism 2.1（.model.json / .moc / .mtn / .exp.json）
 *  - haru   ：Cubism 4  （.model3.json / .moc3）
 *  两者分别覆盖「2 代 / 4 代自动识别」两条路径。
 */
const DEMO_MODELS = [
  {
    id: 'shizuku',
    name: 'Shizuku（Cubism 2.1 演示）',
    url: 'https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display@v0.4.0/test/assets/shizuku/shizuku.model.json',
    type: 'Cubism2'
  },
  {
    id: 'haru',
    name: 'Haru（Cubism 4 演示）',
    url: 'https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display@v0.4.0/test/assets/haru/haru_greeter_t03.model3.json',
    type: 'Cubism4'
  }
];

// ---------------- 工具 ----------------

function readStoredNumber(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    const value = raw == null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch (_) {
    return fallback;
  }
}

function storeNumber(key, value) {
  try { localStorage.setItem(key, String(value)); } catch (_) { /* 忽略隐私模式等异常 */ }
}

/**
 * 解析模型 URL（跨外壳统一）：
 *  - 已是完整地址（http(s)/file/data/blob/petmodels/asset）→ 原样返回；
 *  - 绝对磁盘路径（Windows 盘符 / UNC）：经外壳 asset 协议转换为可加载 URL
 *    （Tauri：convertFileSrc→asset://；Electron / 浏览器：原样返回）；
 *  - 相对路径：有协议基址（Electron：'petmodels://local/'）则拼接；
 *    否则退回 document.baseURI（Tauri 内置 models / 浏览器直开，保持本地可预览）。
 */
function resolveModelUrl(url) {
  if (!url) return '';
  // 已是完整 URL（含协议）→ 原样返回
  if (/^(https?:|file:|data:|petmodels:|asset:|blob:|tauri:)/i.test(url)) return url;
  // 绝对磁盘路径 → 外壳可加载 URL（Tauri asset 协议；其它外壳原样返回）
  if (/^[a-zA-Z]:[\\/]/.test(url) || /^\\\\/.test(url)) {
    return bridge.toAssetUrl ? bridge.toAssetUrl(url) : url;
  }
  // 相对路径：优先协议基址拼接，否则退回相对 baseURI
  const base = bridge.modelsBaseUrl;
  const rel = String(url).replace(/^\.?\//, '');
  if (base) return base + rel;
  try { return new URL(url, document.baseURI).href; } catch (_) { return url; }
}

function guessModelType(url) {
  if (/\.model3\.json(\?|$)/i.test(url)) return 'Cubism4';
  if (/\.model\.json(\?|$)/i.test(url)) return 'Cubism2';
  return 'Model';
}

/**
 * 归一化模型清单。
 * 同时保留 `rawUrl`（外壳返回的**原始** url：内置为相对路径、导入/外部为绝对磁盘路径），
 * 供「删除模型」时向 Rust 传递可解析的磁盘路径 —— 因为 `url` 会被 resolveModelUrl
 * 转成 asset:// 协议地址，Rust 无法据此定位目录。
 */
function normalizeList(list, source) {
  return (Array.isArray(list) ? list : [])
    .map((raw) => {
      const m = typeof raw === 'string' ? { url: raw } : (raw || {});
      const rawUrl = m.url ? String(m.url) : '';
      const url = resolveModelUrl(m.url);
      if (!url) return null;
      return {
        id: m.id || url,
        name: m.name || m.id || url,
        url,
        rawUrl,
        type: m.type || guessModelType(url),
        source: m.source || source
      };
    })
    .filter(Boolean);
}

let toastTimer = 0;
function showToast(text, ms = 2600) {
  const node = document.getElementById('pet-toast');
  if (!node) { console.info('[pet]', text); return; }
  node.textContent = text;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), ms);
}

// ---------------- 模型清单 ----------------

async function loadCatalog() {
  // 汇总去重（按 url）：外壳清单 ＋ 本地 models.json ＋ 内置演示模型。
  // 说明：Tauri 外壳只扫描「外部模型目录」，内置模型仍来自本地 models/models.json，
  //       故此处采用「合并去重」而非「外壳优先覆盖」，确保内置与外部模型都进入列表；
  //       对 Electron（外壳已返回内置+外部完整清单）而言，合并结果与原来等价。
  const merged = [];
  const seen = new Set();
  const collect = (list, source) => {
    for (const m of normalizeList(list, source)) {
      if (seen.has(m.url)) continue;
      seen.add(m.url);
      merged.push(m);
    }
  };

  // 1) 外壳提供的清单（仅当外壳确实提供该能力时才调用，避免"启用却空操作"与误导）
  if (bridge.capabilities.modelList) {
    try {
      const fromShell = await bridge.getModelList();
      collect(fromShell, 'shell');
    } catch (err) {
      console.warn('[main] 读取外壳模型清单失败:', err);
    }
  } else {
    console.debug('[main] 外壳未提供模型清单能力，跳过（回退 models.json / 内置演示模型）');
  }

  // 2) 本地 models/models.json（用户可自行编辑）
  //    经外部模型协议基址读取（Electron：petmodels://local/models/models.json），
  //    无协议时退回相对路径（Tauri / 浏览器直开）。
  try {
    const manifestUrl = bridge.modelsBaseUrl
      ? (bridge.modelsBaseUrl + 'models/models.json')
      : 'models/models.json';
    const res = await fetch(manifestUrl, { cache: 'no-store' });
    if (res.ok) {
      const json = await res.json();
      const list = Array.isArray(json) ? json : (json && json.models) || [];
      collect(list, 'local');
    }
  } catch (err) {
    console.warn('[main] 读取 models/models.json 失败（将退回内置演示模型）:', err);
  }

  // 3) 内置演示模型（兜底，保证列表非空）
  if (merged.length === 0) collect(DEMO_MODELS, 'demo');

  return merged;
}

// ---------------- 启动 ----------------

async function start() {
  const canvas = document.getElementById('pet-canvas');
  if (!canvas) throw new Error('缺少 #pet-canvas 画布元素');
  if (!window.PIXI || !window.PIXI.Application) throw new Error('PIXI 未就绪');

  // 全屏透明应用：backgroundAlpha=0 保证窗口主体透明
  const app = new window.PIXI.Application({
    view: canvas,
    backgroundAlpha: 0,
    transparent: true,
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    powerPreference: 'high-performance'
  });

  const initialAlpha = readStoredNumber(LS.alpha, 1);
  const initialScale = readStoredNumber(LS.scale, 100);

  modelLoader.init(app, { alpha: initialAlpha, scalePercent: initialScale });

  // 模型清单与初始模型
  const catalog = await loadCatalog();
  const params = new URLSearchParams(window.location.search);
  const queryModel = resolveModelUrl(params.get('model'));
  const storedModel = (() => {
    try { return localStorage.getItem(LS.modelUrl) || ''; } catch (_) { return ''; }
  })();

  let initialUrl = queryModel || storedModel || (catalog[0] && catalog[0].url) || '';

  // —— 先创建设置面板（交互层需要其 UI 命中判定）——
  const panel = createSettingsPanel({
    modelLoader,
    bridge,
    models: catalog,
    currentModelUrl: initialUrl,
    alpha: initialAlpha,
    scalePercent: initialScale,
    penetrateSupported: !!(bridge.canForwardMouseMove || bridge.canPollCursor),
    onSwitchModel(url, model) {
      switchTo(url, model, false).catch((err) => {
        console.error(err);
        showToast('模型切换失败：' + (err && err.message ? err.message : err));
      });
    },

    onImportModel() {
      importModelFlow().catch((err) => {
        console.error(err);
        showToast('导入模型失败：' + (err && err.message ? err.message : err));
      });
    },
    onDeleteModel(model) {
      deleteModelFlow(model).catch((err) => {
        console.error(err);
        showToast('删除模型失败：' + (err && err.message ? err.message : err));
      });
    },
    onRefreshModels() {
      return refreshModelList();
    },
    onQuit() {
      bridge.quit().then((ok) => {
        if (!ok) showToast('当前环境不支持退出');
      });
    },
    onInteractiveModeChange(auto) {
      applyInteractiveMode(auto);
    },
    onAlwaysOnTopChange(value) {
      storeNumber(LS.alwaysOnTop, value ? 1 : 0);
      bridge.setAlwaysOnTop(value);
    },
    onAlphaChange(alpha) {
      storeNumber(LS.alpha, alpha);
    },
    onScaleChange(percent) {
      storeNumber(LS.scale, percent);
    }
  });

  /**
   * 重新加载模型清单（内置 + 外部目录）并刷新设置面板列表。
   * 供设置面板在切换/清除「外部模型文件夹」后调用，使新模型立即出现。
   * 注意：就地更新 catalog（保持引用），避免其它持有该数组引用的逻辑失效。
   * @returns {Promise<Array>} 重新加载后的归一化模型清单
   */
  async function refreshModelList() {
    const next = await loadCatalog();
    catalog.length = 0;
    catalog.push(...next);
    panel.setModels(catalog);
    return catalog;
  }

  // —— 交互（视线跟随 / 拖拽 / 点击 / 穿透）——
  const interaction = createPetInteraction({
    app,
    modelLoader,
    bridge,
    isPointerOverUI: panel.isPointerOverUI,
    // 滚轮缩放：持久化到本地并同步设置面板滑条，避免面板与滚轮状态不一致
    options: {
      onScaleChange(percent) {
        storeNumber(LS.scale, percent);
        panel.setScaleValue(percent);
      }
    }
  });
  interaction.attach();

  // 持久化的置顶状态恢复
  if (readStoredNumber(LS.alwaysOnTop, 1) === 1) {
    bridge.setAlwaysOnTop(true);
    panel.setAlwaysOnTopChecked(true);
  }

  // —— 初始模型加载 ——
  if (!initialUrl) {
    panel.setStatus('未找到可用模型，请编辑 web/models/models.json');
    showToast('未找到可用模型，请检查 models/models.json');
  } else {
    try {
      panel.setStatus('正在加载模型…');
      const model = await modelLoader.loadModel(initialUrl);
      storeNumber(LS.modelUrl, initialUrl);
      const meta = catalog.find((m) => m.url === initialUrl);
      const name = (meta && meta.name) || describeModel(model);
      const kind = modelLoader.getModelKind();   // 运行时判定的 Cubism 版本
      panel.setCurrentModel(initialUrl, name, kind);
      panel.setStatus(`已加载：${name}（${kind}）`);
    } catch (err) {
      console.error(err);
      panel.setStatus('模型加载失败');
      showToast('模型加载失败：' + (err && err.message ? err.message : err));
    }
  }

  // —— 对外暴露（便于外壳/调试/自动化自测）——
  // 注意：必须在 applyInteractiveMode 之前赋值，后者会通过 window.petApp 访问交互控制器。
  window.petApp = {
    app,
    modelLoader,
    bridge,
    panel,
    interaction,
    switchModel: (url) => switchTo(url, null, true),
getModels: () => catalog.slice(),
    /**
     * 追加/合并模型到当前清单，并同步刷新设置面板列表（导入成功后调用）。
     * 同 URL 视为同一模型：以新信息覆盖旧条目，避免列表重复。
     * @returns {object|null} 归一化后的模型对象
     */
    appendModel(raw) {
      const [normalized] = normalizeList([raw], 'imported');
      if (!normalized) return null;
      const idx = catalog.findIndex((m) => m.url === normalized.url);
      if (idx >= 0) catalog[idx] = { ...catalog[idx], ...normalized };
      else catalog.push(normalized);
      panel.setModels(catalog, normalized.url);
      return normalized;
    },
    /** 导入模型流程（暴露便于外壳/自动化调用） */
    importModel: importModelFlow,
    /** 删除模型流程（暴露便于外壳/自动化调用） */
    deleteModel: deleteModelFlow,
    /** 重新加载模型清单（内置 + 外部）并刷新面板（暴露便于外壳/自动化调用） */
    refreshModelList,
    showToast
  };

  // —— 穿透初始状态 ——
  // Electron（mousemove 转发）/ Tauri（光标轮询）：均默认进入穿透态，交互层在悬停命中时开启可点。
  // 其它外壳（浏览器等）不具备悬停探测能力：改为常驻可点。
  applyInteractiveMode(interaction.isAutoPenetration());

  // —— 窗口尺寸变化：重新适配模型 ——
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      modelLoader.refreshFit({ preservePosition: true });
    });
  });

  console.info(
    `[DesktopPetWeb] 渲染前端就绪 · runtime=${bridge.runtime} · 模型数=${catalog.length}`
  );
}

function describeModel(model) {
  try {
    const settings = (model && model.internalModel && model.internalModel.settings) || {};
    return settings.name || '未命名模型';
  } catch (_) {
    return '未命名模型';
  }
}

/** 切换模型并更新 UI / 持久化 */
async function switchTo(url, modelMeta, fromExternal) {
  if (!url) return null;
  const resolved = resolveModelUrl(url);
  await modelLoader.loadModel(resolved);
  storeNumber(LS.modelUrl, resolved);
  const meta = modelMeta || { name: resolved };
  const kind = modelLoader.getModelKind();   // 运行时判定的 Cubism 版本
  const panel = window.petApp && window.petApp.panel;
  if (panel) {
    panel.setCurrentModel(resolved, meta.name, kind);
    panel.setStatus(`已加载：${meta.name}（${kind}）`);
  }
  if (!fromExternal) showToast(`已切换：${meta.name}（${kind}）`);
  return resolved;
}

/**
 * 通过外壳导入模型（Tauri：复制进 exe 同级 models/；Electron：复制进内置 models/）。
 *  - 成功：把返回的 {id,name,url,type} 并入当前清单并刷新列表 → 切换到新模型 → 提示成功；
 *  - 取消：提示「已取消导入」；
 *  - 失败：展示 error 信息；
 *  - 外壳不具备 importModel 能力：提示不支持（按钮侧亦不渲染）。
 *
 * 说明：bridge.importModel 对「用户取消」与「内部失败」均以 null 返回，
 * 因此 null 统一按「已取消导入」处理；若外壳将来改为抛错，则在此展示 error。
 *
 * @returns {Promise<{ok:boolean, reason?:string, model?:object, error?:Error}>}
 */
async function importModelFlow() {
  if (!bridge.capabilities.importModel) {
    showToast('当前外壳不支持导入');
    return { ok: false, reason: 'unsupported' };
  }

  let imported;
  try {
    imported = await bridge.importModel();
  } catch (err) {
    // 外壳在导入过程中抛出异常（选择器/拷贝/解析失败等）
    showToast('导入模型失败：' + (err && err.message ? err.message : err));
    return { ok: false, reason: 'error', error: err };
  }

  if (!imported || !imported.url) {
    // 用户取消（或外壳内部失败但未抛错）→ 明确提示取消
    showToast('已取消导入');
    return { ok: false, reason: 'cancelled' };
  }

  const [normalized] = normalizeList([imported], 'imported');
  if (!normalized) {
    showToast('导入的模型信息无效');
    return { ok: false, reason: 'invalid' };
  }

  // 1) 并入当前模型清单并刷新设置面板列表
  const app = window.petApp;
  if (app && typeof app.appendModel === 'function') {
    app.appendModel(normalized);
  } else if (app && app.panel) {
    app.panel.setModels([...app.getModels(), normalized], normalized.url);
  }

  // 2) 切换到刚导入的模型
  //    fromExternal=true 抑制 switchTo 自身的 toast，改由本流程统一给出「导入成功」提示
  await switchTo(normalized.url, normalized, true);
  if (app && app.panel) app.panel.setStatus(`导入成功：${normalized.name}`);
  showToast(`导入成功：${normalized.name}`);
  return { ok: true, model: normalized };
}

/**
 * 删除模型流程（Tauri：删除 exe 同级 models/<模型>，或外部根内模型目录）。
 * 前置：设置面板已做「二次确认」（两段式防误删）。
 *
 * 删除成功后：
 *   1) 重新加载清单（get_model_list 已不含该目录）→ 列表与磁盘一致；
 *   2) 若删除的是当前正加载的模型 → 切换到列表首个可用模型（无则提示）。
 *
 * @param {object} model 被删模型（{ id, name, url, source }）
 * @returns {Promise<{ok:boolean, reason?:string, error?:Error}>}
 */
async function deleteModelFlow(model) {
  if (!bridge.capabilities.deleteModel) {
    showToast('当前外壳不支持删除模型');
    return { ok: false, reason: 'unsupported' };
  }
  // 优先传「原始磁盘路径」（rawUrl）：Rust 侧据此解析模型目录。
  // 注意：绝不能用 resolveModelUrl 后的 url（Tauri 下已被转成 asset:// 协议地址，
  // Rust 侧无法定位磁盘目录 → 删除必然失败）。缺失时回退目录名 id / 原始 url。
  const key = model && (model.rawUrl || model.id || model.url);
  if (!key) {
    showToast('无法确定要删除的模型');
    return { ok: false, reason: 'invalid' };
  }

  let ok = false;
  try {
    ok = await bridge.deleteModel(key);
  } catch (err) {
    showToast('删除模型失败：' + (err && err.message ? err.message : err));
    return { ok: false, reason: 'error', error: err };
  }
  if (!ok) {
    showToast('删除模型失败（目录可能被占用或不允许删除）');
    return { ok: false, reason: 'failed' };
  }

  const app = window.petApp;

  // 1) 重新加载清单（catalog 就地更新，被删模型不再出现）
  if (app && typeof app.refreshModelList === 'function') {
    try { await app.refreshModelList(); } catch (err) { console.warn('[main] 删除后刷新清单失败:', err); }
  }

  // 2) 若删除的是当前加载模型 → 切换到首个可用模型
  const stored = (() => { try { return localStorage.getItem(LS.modelUrl) || ''; } catch (_) { return ''; } })();
  if (model.url && stored === model.url) {
    const list = (app && typeof app.getModels === 'function') ? app.getModels() : [];
    const next = list[0];
    if (next && next.url) {
      try {
        await switchTo(next.url, next, true);
      } catch (err) {
        console.warn('[main] 删除后切换模型失败:', err);
      }
    } else if (app && app.panel) {
      app.panel.setStatus('已删除模型，当前无可用模型');
    }
  }

  showToast(`已删除模型：${model.name || key}`);
  return { ok: true };
}

/** 应用「自动穿透 / 常驻可点」模式 */
function applyInteractiveMode(auto) {
  const interaction = window.petApp && window.petApp.interaction;
  // Electron 经 mousemove 转发、Tauri 经光标轮询，均支持「悬停自动穿透」
  const supported = !!(bridge.canForwardMouseMove || bridge.canPollCursor);

  if (auto && supported) {
    if (interaction) interaction.setAutoPenetration(true);
    // 初始进入穿透态；随后由（Electron）mousemove 或（Tauri）光标轮询命中时开启可点
    bridge.setInteractive(false);
  } else {
    if (interaction) interaction.setAutoPenetration(false);
    // 常驻可点（外壳不具备悬停探测能力时的安全默认）
    bridge.setInteractive(true);
  }
}

// ---------------- 引导 ----------------

start().catch((err) => {
  console.error('[DesktopPetWeb] 启动失败:', err);
  showToast('启动失败：' + (err && err.message ? err.message : err));
  const status = document.getElementById('boot-status');
  if (status) {
    status.textContent = '桌宠前端启动失败：' + (err && err.message ? err.message : err);
    status.classList.remove('hidden');
    status.classList.add('error');
  }
});