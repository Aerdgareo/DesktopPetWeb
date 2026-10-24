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
 * 解析模型 URL：
 *  - 已是绝对地址（http(s)/file/data/blob/petmodels）→ 原样返回；
 *  - 否则用外部模型协议基址拼接（Electron：petmodels://local/ + 相对路径），
 *    使模型及其相对资源（贴图/动作/物理等）都从外部 models/ 目录读取；
 *  - 协议基址为空（浏览器直开 / 旧外壳）→ 退回相对路径，保持本地可预览。
 */
function resolveModelUrl(url) {
  if (!url) return '';
  if (/^(https?:|file:|data:|petmodels:|blob:)/i.test(url)) return url;
  const base = bridge.modelsBaseUrl;
  const rel = String(url).replace(/^\.?\//, '');
  return base ? base + rel : rel;
}

function guessModelType(url) {
  if (/\.model3\.json(\?|$)/i.test(url)) return 'Cubism4';
  if (/\.model\.json(\?|$)/i.test(url)) return 'Cubism2';
  return 'Model';
}

/** 归一化模型清单 */
function normalizeList(list, source) {
  return (Array.isArray(list) ? list : [])
    .map((raw) => {
      const m = typeof raw === 'string' ? { url: raw } : (raw || {});
      const url = resolveModelUrl(m.url);
      if (!url) return null;
      return {
        id: m.id || url,
        name: m.name || m.id || url,
        url,
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
  // 1) 外壳提供的清单优先（仅当外壳确实提供该能力时才调用，避免"启用却空操作"与误导）
  if (bridge.capabilities.modelList) {
    try {
      const fromShell = await bridge.getModelList();
      const normalized = normalizeList(fromShell, 'shell');
      if (normalized.length) return normalized;
    } catch (err) {
      console.warn('[main] 读取外壳模型清单失败:', err);
    }
  } else {
    console.debug('[main] 外壳未提供模型清单能力，跳过（回退 models.json / 内置演示模型）');
  }

  // 2) 本地 models/models.json（用户可自行编辑）
  //    经外部模型协议基址读取（Electron：petmodels://local/models/models.json），
  //    无协议时退回相对路径（浏览器直开）。
  try {
    const manifestUrl = bridge.modelsBaseUrl
      ? (bridge.modelsBaseUrl + 'models/models.json')
      : 'models/models.json';
    const res = await fetch(manifestUrl, { cache: 'no-store' });
    if (res.ok) {
      const json = await res.json();
      const list = Array.isArray(json) ? json : (json && json.models) || [];
      const normalized = normalizeList(list, 'local');
      if (normalized.length) return normalized;
    }
  } catch (err) {
    console.warn('[main] 读取 models/models.json 失败（将退回内置演示模型）:', err);
  }

  // 3) 内置演示模型
  return normalizeList(DEMO_MODELS, 'demo');
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
    penetrateSupported: !!bridge.canForwardMouseMove,
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
    /** 重新加载模型清单（内置 + 外部）并刷新面板（暴露便于外壳/自动化调用） */
    refreshModelList,
    showToast
  };

  // —— 穿透初始状态 ——
  // Electron(能转发 mousemove)：默认穿透；交互层会在悬停命中时临时开启可点。
  // Tauri/浏览器(不能转发 mousemove)：无法悬停探测，改为常驻可点，由面板开关控制。
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
 * 通过外壳导入模型。
 *  - 成功：把返回的 {id,name,url,type} 并入当前清单并刷新列表 → 切换到新模型 → 提示成功；
 *  - 取消：提示「已取消导入」；
 *  - 失败：展示 error 信息；
 *  - 外壳不具备 importModel 能力：提示不支持（按钮侧亦已置灰）。
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

/** 应用「自动穿透 / 常驻可点」模式 */
function applyInteractiveMode(auto) {
  const interaction = window.petApp && window.petApp.interaction;
  const supported = !!bridge.canForwardMouseMove;

  if (auto && supported) {
    if (interaction) interaction.setAutoPenetration(true);
    // 初始进入穿透态，随后由 mousemove 悬停命中时开启可点
    bridge.setInteractive(false);
  } else {
    if (interaction) interaction.setAutoPenetration(false);
    // 常驻可点（无法悬停探测时的安全默认）
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