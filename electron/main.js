'use strict';

/**
 * Electron 主进程入口 —— 桌面宠物外壳
 *
 * 职责：
 *   1. 创建「透明 / 无边框 / 置顶 / 不可缩放」的窗口，窗口铺满主显示器工作区，
 *      承载共享的 web/ 前端；
 *   2. 默认整窗鼠标穿透（setIgnoreMouseEvents(true, { forward: true })），
 *      由前端通过 mousemove 做命中检测后调用 IPC 动态开关交互；
 *   3. 提供 IPC 桥（穿透切换、置顶、移动、显示/隐藏、退出、开机自启、模型导入）；
 *   4. 提供系统托盘（显示/隐藏、置顶开关、退出）。
 *
 * 说明：本文件仅负责「外壳」，不承载任何业务 UI；UI 全部来自 web/index.html。
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { fileURLToPath, pathToFileURL } = require('url');

// 内嵌 32x32 托盘图标（PNG base64），避免依赖外部资源文件缺失
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbklEQVR4nO3UsQ0AIAhEUfd0Jte11QFUIsKBRi6h/q8ipdeWS23UuUShmNO4GCENiyDacRYCFd9GuALQcRJhFV8i/gZYxwdEAAIQAHeA+yMKgDViGrdCkPErAEjEVhyFYMU1IcdhDYRKnIuBRJHrl4EClTWrshMAAAAASUVORK5CYII=';

// Web 前端根目录（web/ 与 electron/ 平级）；相对路径入参均以此为基准解析
const WEB_ROOT = path.join(__dirname, '..', 'web');

// Web 前端入口（由并行任务产出，与外壳解耦）
const WEB_INDEX = path.join(WEB_ROOT, 'index.html');

// ---------------------------------------------------------------------------
// 外部模型目录（模型以普通文件形式放在磁盘上，可手动增删，不压入 app.asar）
// ---------------------------------------------------------------------------
// 打包态：模型目录位于「安装目录根部」models/（exe 同级），由 electron-builder
//         extraFiles 将 web/models/ 提取到此处（win-unpacked/models、NSIS 安装根 models）。
// 开发态：models/ 仍位于 web/models/，与源码同目录，便于 `npm start` 直接调试。
const isPackaged = app.isPackaged;
let MODELS_DIR;
try {
  MODELS_DIR = isPackaged
    // macOS：electron-builder 的 extraFiles 落在 `<App>.app/Contents/` 下，
    //   而可执行文件位于 `<App>.app/Contents/MacOS/` → 模型目录取上一级 `Contents/models`。
    // Windows / Linux：extraFiles 落在安装根（与 exe 同级）→ `dirname(exe)/models`。
    ? (process.platform === 'darwin'
        ? path.join(path.dirname(app.getPath('exe')), '..', 'models')
        : path.join(path.dirname(app.getPath('exe')), 'models'))
    : path.join(WEB_ROOT, 'models');
} catch (_err) {
  MODELS_DIR = path.join(WEB_ROOT, 'models'); // 极端兜底：无法解析 exe 路径时退回 web/models
}
const MODELS_MANIFEST = path.join(MODELS_DIR, 'models.json');

// 协议映射根：使 URL 中的 `models/<dir>/<file>` 直接解析到 MODELS_DIR（其父目录即此根）。
// 由 `petmodels://local/<...>` 映射而来，见下方 registerPetModelsProtocol。
const MODELS_PARENT = path.dirname(MODELS_DIR);

// ---------------------------------------------------------------------------
// 应用配置持久化（userData/config.json）
// ---------------------------------------------------------------------------
// 持久化「外部模型地址」列表（可多个）：externalModels = [{ id, path }, ...]。
// 每个地址与内置 models/ 并存：启动/刷新时扫描各自一级子目录，把发现的外部模型
// 与内置模型合并进模型列表（外部项不写入 models.json，见 readModelsManifest）。
// id 为稳定标识（形如 r1 / r2），用于协议 URL `petmodels://external/<id>/...` 定位根。
// 空数组表示未添加任何外部地址。
let EXTERNAL_MODELS = [];

// 「模型存放目录」（导入根目录）：string | null。
// 设置后，用户导入的模型复制到 <importRoot>/<模型目录名>/，并以
// `petmodels://importroot/...` 直达；未设置时回退到内置 MODELS_DIR。
// 该字段为 config.json 的 importRoot，是唯一真源（前端不得写入 localStorage）。
let IMPORT_ROOT = null;

/** 配置文件绝对路径（userData/config.json）；依赖 app ready 后的应用路径解析 */
function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

/**
 * 规整外部地址路径：去首尾空白、去尾部斜杠 / 反斜杠。
 * 盘符根（如 `D:\`）被裁剪为 `D:` 时补回分隔符，避免误判为相对路径。
 * @param {*} p
 * @returns {string} 规整后的路径；非法（非字符串 / 空）返回 ''
 */
function normalizeRootPath(p) {
  if (typeof p !== 'string') return '';
  let s = p.trim();
  if (!s) return '';
  s = s.replace(/[\\/]+$/, '');
  if (/^[a-zA-Z]:$/.test(s)) s += path.sep; // 裸盘符 → 补回根分隔符
  return s;
}

/** 判断两个外部地址是否指向同一目录（大小写不敏感、忽略尾部斜杠） */
function sameRootPath(a, b) {
  const na = normalizeRootPath(a);
  const nb = normalizeRootPath(b);
  if (!na || !nb) return false;
  return na.toLowerCase() === nb.toLowerCase();
}

/**
 * 规整外部地址数组：逐项校验（path 为字符串且非空）、按 path 去重、
 * 补齐缺失 / 冲突的稳定 id（形如 r<n>）。
 * @param {Array<{id?:string,path:string}>} items
 * @returns {Array<{id:string,path:string}>}
 */
function normalizeRoots(items) {
  const out = [];
  const seenPaths = new Set();
  const usedIds = new Set();
  let maxId = 0;

  const list = Array.isArray(items) ? items : [];
  for (const it of list) {
    const np = normalizeRootPath(it && it.path);
    if (!np) continue; // path 非法 → 丢弃
    const key = np.toLowerCase();
    if (seenPaths.has(key)) continue; // 同路径去重
    seenPaths.add(key);

    let id = it && typeof it.id === 'string' ? it.id.trim() : '';
    if (id) {
      const m = /^r(\d+)$/.exec(id);
      if (m) maxId = Math.max(maxId, Number(m[1]));
      if (usedIds.has(id)) id = ''; // id 冲突 → 重新分配
    }
    if (id) usedIds.add(id);
    out.push({ id, path: np });
  }

  // 第二遍：为缺失 / 冲突的项分配稳定新 id
  for (const item of out) {
    if (item.id) continue;
    do { maxId += 1; } while (usedIds.has(`r${maxId}`));
    item.id = `r${maxId}`;
    usedIds.add(item.id);
  }

  return out.map(({ id, path: p }) => ({ id, path: p })); // 剥离内部临时字段
}

/** 生成不与现存 id 冲突的下一个稳定 id（`r<max+1>`） */
function nextRootId() {
  let max = 0;
  for (const r of EXTERNAL_MODELS) {
    const m = /^r(\d+)$/.exec((r && r.id) || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  let id = `r${max + 1}`;
  while (EXTERNAL_MODELS.some((r) => r && r.id === id)) {
    max += 1;
    id = `r${max + 1}`;
  }
  return id;
}

/** 按稳定 id 查找外部地址；未找到返回 null */
function findRoot(id) {
  if (typeof id !== 'string' || !id) return null;
  const found = EXTERNAL_MODELS.find((r) => r && r.id === id);
  return found ? { id: found.id, path: found.path } : null;
}

/**
 * 追加一个外部地址（按 path 去重，大小写不敏感、忽略尾部斜杠）。
 * 已存在则不重复添加，返回已存在项；path 非法（空 / 非字符串）返回 null。
 * 新增成功时持久化配置。
 * @param {string} p
 * @returns {{id:string,path:string}|null}
 */
function addExternalRoot(p) {
  const np = normalizeRootPath(p);
  if (!np) return null;
  const exist = EXTERNAL_MODELS.find((r) => r && sameRootPath(r.path, np));
  if (exist) return { id: exist.id, path: exist.path };
  const item = { id: nextRootId(), path: np };
  EXTERNAL_MODELS.push(item);
  saveConfig();
  return { id: item.id, path: item.path };
}

/**
 * 删除一个外部地址（入参可为 {id} / {path} 对象，或直接传字符串——先按 id、再按 path 匹配）。
 * 删除成功时持久化配置。
 * @param {*} arg
 * @returns {boolean} 是否实际删除
 */
function removeExternalRoot(arg) {
  let id = null;
  let p = null;
  if (arg && typeof arg === 'object') {
    if (typeof arg.id === 'string') id = arg.id;
    if (typeof arg.path === 'string') p = arg.path;
  } else if (typeof arg === 'string') {
    id = arg;
  }

  let idx = -1;
  if (id) idx = EXTERNAL_MODELS.findIndex((r) => r && r.id === id);
  if (idx < 0 && p) idx = EXTERNAL_MODELS.findIndex((r) => r && sameRootPath(r.path, p));

  if (idx < 0) return false;
  EXTERNAL_MODELS.splice(idx, 1);
  saveConfig();
  return true;
}

/** 清空全部外部地址（并持久化） */
function clearExternalRoots() {
  EXTERNAL_MODELS = [];
  saveConfig();
}

/**
 * 载入配置（须在 app ready 之后调用）。
 * 文件缺失 / JSON 损坏 / 字段非法 → 回退为默认值，绝不抛错。
 * 兼容迁移：读到旧格式 `externalModelsDir`（string）时转成 [{ id:'r1', path }] 并写回新格式（仅一次）。
 * @returns {Array<{id:string,path:string}>} 生效的外部地址列表
 */
function loadConfig() {
  EXTERNAL_MODELS = [];
  IMPORT_ROOT = null;
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      // importRoot：仅接受非空字符串（原样保留，不 trim 存储，避免改动用户真实路径）
      if (typeof parsed.importRoot === 'string' && parsed.importRoot.trim().length > 0) {
        IMPORT_ROOT = parsed.importRoot;
      }
      if (Array.isArray(parsed.externalModels)) {
        EXTERNAL_MODELS = normalizeRoots(parsed.externalModels);
      } else if (typeof parsed.externalModelsDir === 'string' && parsed.externalModelsDir.trim()) {
        // 旧单目录字段 → 数组，并立即写回新格式（迁移一次）
        EXTERNAL_MODELS = normalizeRoots([{ id: 'r1', path: parsed.externalModelsDir }]);
        saveConfig();
      }
    }
  } catch (_err) {
    // 文件不存在 / 损坏：保持默认值（空外部列表 + 未设置 importRoot）
  }
  return EXTERNAL_MODELS;
}

/**
 * 写回配置（确保 userData 目录存在）。
 * 同时保留既有 `externalModels` 与新增 `importRoot`，不得丢弃任一字段。
 * @returns {boolean} 是否成功写盘（失败仅记录日志，调用方可据此决定是否上报错误）
 */
function saveConfig() {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify(
        {
          externalModels: EXTERNAL_MODELS.map((r) => ({ id: r.id, path: r.path })),
          importRoot: IMPORT_ROOT // string | null
        },
        null,
        2
      ),
      'utf8'
    );
    return true;
  } catch (err) {
    console.error('[main] 保存配置失败：', err);
    return false;
  }
}

// 自定义协议 `petmodels`：渲染进程通过它读取外部 models/ 下的模型与贴图/动作等资源。
// 必须在 app ready 之前登记为 privileged，才能作为「标准协议」参与相对 URL 解析、
// fetch 与子资源加载（贴图、moc3、物理、动作等）。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'petmodels',
    privileges: {
      standard: true,        // 标准协议：支持 host/path 语义与相对 URL 解析
      secure: true,          // 视为安全来源，规避混合内容 / 安全告警
      supportFetchAPI: true, // 允许 fetch('petmodels://...')
      stream: true,          // 允许流式响应（大贴图 / 模型资源）
      bypassCSP: true        // 不受页面 CSP 限制（本工程页面无 CSP，防御性开启）
    }
  }
]);

let mainWindow = null;
let tray = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// 单实例：桌面宠物同时只允许运行一个实例，二次启动时唤回已有窗口
// ---------------------------------------------------------------------------
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

// Windows 透明窗口下，默认层级（'floating'）的 alwaysOnTop 实测不生效，
// 必须显式指定更高层级；实测 'pop-up-menu' 起生效，且比 'screen-saver' 干扰更小。
const ALWAYS_ON_TOP_LEVEL = 'pop-up-menu';

function createWindow() {
  // 铺满主显示器「工作区」（workArea 已排除任务栏 / 停靠栏 / 系统菜单栏），
  // 同时保留 workArea 的左上角偏移，兼容主屏原点不为 (0,0) 的多显示器场景。
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;

  mainWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,        // 透明背景，仅绘制宠物像素
    frame: false,             // 无边框
    resizable: false,         // 固定尺寸，避免误拖拽改变布局
    hasShadow: false,         // 透明窗口关闭阴影，防止出现灰边
    alwaysOnTop: true,        // 置顶
    skipTaskbar: false,       // 保留任务栏入口，便于找回窗口
    fullscreenable: false,
    show: false,              // 就绪后再显示，减少启动闪白
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // 默认整窗穿透。forward:true 让页面在穿透状态下仍能收到 mousemove 事件，
  // 前端据此判断光标是否落在宠物身上，再通过 pet:set-interactive 动态恢复交互。
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  // 真正置顶：构造项的 alwaysOnTop 与不带层级的 setAlwaysOnTop 在 Windows 透明窗口下
  // 均不生效（isAlwaysOnTop() 仍为 false），必须显式指定层级。
  mainWindow.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);

  // 加载共享前端。若前端尚未产出（并行任务未完成 / 文件缺失），
  // 退化加载一个内联提示页，保证外壳本身可独立启动、便于自测。
  mainWindow.loadFile(WEB_INDEX).catch((err) => {
    console.error('[main] 加载 web/index.html 失败：', err && err.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(
        'data:text/html;charset=utf-8,' + encodeURIComponent(buildFallbackHtml())
      );
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  // 置顶状态由外部（如系统）变化时，同步托盘勾选状态
  mainWindow.on('always-on-top-changed', () => updateTrayMenu());

  // 关闭请求（如前端调用 window.close()）默认改为「隐藏到托盘」，
  // 仅当真正退出（托盘/菜单退出、before-quit）时才销毁窗口。
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
    updateTrayMenu();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    updateTrayMenu();
  });
}

/** 前端缺失时的兜底提示页（纯内联 HTML，不依赖任何外部资源） */
function buildFallbackHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>Desktop Pet</title>
<style>
  html, body { margin: 0; height: 100%; background: rgba(20, 24, 34, 0.85);
    font-family: "Microsoft YaHei", system-ui, sans-serif; color: #e6e9f0; }
  .wrap { height: 100%; display: flex; flex-direction: column; align-items: center;
    justify-content: center; text-align: center; padding: 24px; box-sizing: border-box; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  code { background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; }
  p { margin: 6px 0; font-size: 13px; line-height: 1.6; color: #b9c0cf; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>桌面宠物外壳已启动</h1>
    <p>未找到前端入口：<code>web/index.html</code></p>
    <p>请先由 web 前端任务产出页面后重启（<code>npm start</code>）。</p>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
  // 鼠标交互开关：interactive=true 关闭穿透，false 恢复整窗穿透
  ipcMain.on('pet:set-interactive', (_event, interactive) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setIgnoreMouseEvents(!interactive, { forward: true });
  });

  // 置顶开关
  ipcMain.on('pet:set-always-on-top', (_event, flag) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setAlwaysOnTop(!!flag, ALWAYS_ON_TOP_LEVEL);
    updateTrayMenu();
    // 回推给渲染进程，便于前端同步 UI 状态
    if (!mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('pet:always-on-top-changed', !!flag);
    }
  });

  // 移动窗口：优先绝对坐标 (x, y)，否则按 (dx, dy) 相对偏移。
  // 注意：窗口现已铺满主显示器工作区，前端只应移动「人物 / 面板」而非整窗，
  // 故本能力予以保留以兼容旧版前端，但正常情况下不应被调用。
  ipcMain.on('pet:move-window', (_event, payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { dx, dy, x, y } = payload || {};
    if (typeof x === 'number' && typeof y === 'number') {
      mainWindow.setPosition(Math.round(x), Math.round(y));
    } else {
      const [currentX, currentY] = mainWindow.getPosition();
      mainWindow.setPosition(
        Math.round(currentX + (Number(dx) || 0)),
        Math.round(currentY + (Number(dy) || 0))
      );
    }
  });

  // 显示 / 隐藏
  ipcMain.on('pet:set-visible', (_event, visible) => setWindowVisible(!!visible));
  ipcMain.on('pet:toggle-visible', () => toggleWindowVisible());

  // 开机自启（可选能力，默认不开启）
  ipcMain.on('pet:set-auto-launch', (_event, enabled) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enabled });
    } catch (err) {
      console.error('[main] 设置开机自启失败：', err && err.message);
    }
  });

  // 退出
  ipcMain.on('pet:quit', () => quitApp());

  // —— 模型相关（invoke / handle，返回结构化结果对象）——

  // 导入模型：弹出文件选择器 → 复制模型目录 → 登记清单 → 返回 { ok, model }
  ipcMain.handle('pet:import-model', (event) => handleImportModel(event));

  // 读取模型清单：返回 { ok, models }
  ipcMain.handle('pet:get-model-list', () => {
    try {
      return { ok: true, models: readModelsManifest().models };
    } catch (err) {
      console.error('[main] 读取模型清单失败：', err);
      return { ok: false, models: [], error: String((err && err.message) || err) };
    }
  });

  // 模型存放目录：返回 { ok, dir }（可选能力，便于前端向用户提示位置）
  ipcMain.handle('pet:get-models-dir', () => {
    try {
      fs.mkdirSync(MODELS_DIR, { recursive: true });
      return { ok: true, dir: MODELS_DIR };
    } catch (err) {
      console.error('[main] 获取模型目录失败：', err);
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // —— 外部模型地址（可多个，与内置 models/ 并存，持久化于 userData/config.json）——
  // 选择：弹目录选择器 → 追加到列表并持久化；取消 → { ok:false, canceled:true }
  ipcMain.handle('pet:pick-external-models-dir', (event) => handlePickExternalModelsDir(event));
  // 读取全部地址（数组）
  ipcMain.handle('pet:get-external-models-dirs', () => ({ ok: true, dirs: EXTERNAL_MODELS.slice() }));
  // 读取第一个地址的 path（兼容旧接口；未设置时为 null）
  ipcMain.handle('pet:get-external-models-dir', () => ({
    ok: true,
    dir: EXTERNAL_MODELS.length ? EXTERNAL_MODELS[0].path : null
  }));
  // 删除指定地址（入参 `{ id }` 或 `{ path }`，任选其一）
  ipcMain.handle('pet:remove-external-models-dir', (_event, arg) => {
    removeExternalRoot(arg);
    return { ok: true, dirs: EXTERNAL_MODELS.slice() };
  });
  // 清空全部地址
  ipcMain.handle('pet:clear-external-models-dirs', () => {
    clearExternalRoots();
    return { ok: true, dirs: [] };
  });
  // 兼容旧接口：清空全部地址
  ipcMain.handle('pet:clear-external-models-dir', () => {
    clearExternalRoots();
    return { ok: true };
  });

  // —— 模型存放目录（importRoot；持久化于 userData/config.json）——

  // 读取当前值（未设置时为 null；读取失败降级为 { ok:false, error }）
  ipcMain.handle('pet:get-import-root', () => {
    try {
      return { ok: true, dir: typeof IMPORT_ROOT === 'string' && IMPORT_ROOT ? IMPORT_ROOT : null };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 选择：弹目录选择器 → 持久化；取消 → { ok:true, dir:当前值, canceled:true }
  ipcMain.handle('pet:pick-import-root', (event) => handlePickImportRoot(event));

  // 恢复默认：IMPORT_ROOT = null（幂等）→ { ok:true, dir:null }
  ipcMain.handle('pet:clear-import-root', () => {
    const prev = IMPORT_ROOT;
    try {
      IMPORT_ROOT = null;
      if (!saveConfig()) {
        IMPORT_ROOT = prev; // 写盘失败 → 回滚内存态，避免显示与实际不一致
        return { ok: false, error: '保存配置失败（无法写入 config.json）' };
      }
      return { ok: true, dir: null };
    } catch (err) {
      IMPORT_ROOT = prev;
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 扫描模型目录资源：渲染进程在 file:// 下无法枚举目录，改由主进程读取磁盘后回传清单。
  // 入参为模型入口的 URL 或相对 web/ 的路径（如 models/xxx/yyy.model3.json / file:///...）
  // 返回 { ok, motions, expressions, poses, modelDirRel }；失败 { ok:false, error }。
  ipcMain.handle('pet:scan-model-resources', (_event, modelUrlOrPath) =>
    handleScanModelResources(modelUrlOrPath)
  );
}

// ---------------------------------------------------------------------------
// 模型导入（Live2D）
// ---------------------------------------------------------------------------
// 模型文件与清单统一存放在「外部模型目录」MODELS_DIR 下（见文件顶部定义）：
//   MODELS_DIR/models.json   —— 模型清单（可手动编辑）
//   MODELS_DIR/<id>/         —— 单个模型（整目录复制自用户所选模型所在目录）
//
// 打包态该目录位于安装目录根部（exe 同级 models/），不压入 asar，故可写、可手动增删；
// 开发态退回源码 web/models/。清单路径 MODELS_MANIFEST 亦随之变化。

/** 确保外部模型目录存在；首次运行（无 models.json）时写入空清单，便于用户直接编辑 */
function ensureModelsDir() {
  try {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    if (!fs.existsSync(MODELS_MANIFEST)) {
      writeModelsManifest({
        _readme:
          '桌宠外部模型目录清单。可直接在本目录放入/删除模型文件夹；' +
          '字段：id(可选)、name(显示名)、url(必填，相对本目录，如 models/xxx/yyy.model3.json)、' +
          'type(可选，Cubism2/Cubism4，留空按运行时自动识别)。' +
          '未登记但含 *.model3.json / *.model.json 的子目录会在启动时被自动发现并追加。',
        models: []
      });
    }
  } catch (err) {
    console.error('[main] 初始化模型目录失败：', err);
  }
}

/**
 * 扫描单个模型根目录的一级子目录，发现其中的 Live2D 入口文件。
 * 抽为公共实现，供「内置根」与「外部根」复用。
 *
 * 规则：
 *   - 仅看一级子目录；忽略以 `.` 开头的目录；
 *   - 入口优先级：`*.model3.json`（Cubism4）> `*.model.json`（Cubism2）；
 *   - url 由 makeUrl(dirName, entryFile) 生成（内置为相对清单路径，外部为绝对协议 URL）。
 *
 * @param {string} rootDir 模型根目录绝对路径（为空则返回空数组）
 * @param {string} source  'local' | 'external'
 * @param {(dirName:string, entryFile:string)=>string} makeUrl 生成模型 url
 * @returns {Array<{id:string,name:string,url:string,type:string,source:string}>}
 */
function scanModelsInRoot(rootDir, source, makeUrl) {
  const found = [];
  if (!rootDir) return found;

  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (_err) {
    return found; // 目录不存在 / 不可读 → 视为无新模型
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    if (dirName.startsWith('.')) continue; // 忽略隐藏目录

    let files;
    try {
      files = fs.readdirSync(path.join(rootDir, dirName), { withFileTypes: true });
    } catch (_err) {
      continue;
    }

    let entryFile = null;
    for (const f of files) {
      if (f.isFile() && /\.model3\.json$/i.test(f.name)) { entryFile = f.name; break; }
    }
    if (!entryFile) {
      for (const f of files) {
        if (f.isFile() && /\.model\.json$/i.test(f.name)) { entryFile = f.name; break; }
      }
    }
    if (!entryFile) continue; // 无入口文件 → 跳过（幂等：不产生噪声条目）

    found.push({
      id: dirName,
      name: dirName,
      url: makeUrl(dirName, entryFile),
      type: detectModelType(entryFile),
      source
    });
  }
  return found;
}

/**
 * 扫描「内置模型目录」MODELS_DIR 的一级子目录（source='local'）。
 * url 统一为 `models/<目录名>/<入口文件名>`（相对模型根，与清单既有格式一致）。
 * @returns {Array<{id:string,name:string,url:string,type:string,source:string}>}
 */
function scanLocalModels() {
  return scanModelsInRoot(MODELS_DIR, 'local', (dirName, entryFile) => `models/${dirName}/${entryFile}`);
}

/**
 * 扫描「外部模型目录」全部根的一级子目录（source='external'）。
 * 每根 url 为绝对协议 URL：`petmodels://external/<id>/<目录名>/<入口文件名>`；
 * id 为该根的稳定 id（用于协议回定位根），目录名 / 文件名做 URL 编码，
 * 故含中文、空格等特殊字符也能被注册的 petmodels 协议正确解析。
 * 结果按 url 去重（多根之间同名前缀不会互相覆盖）。根缺失 / 不存在 → 跳过该根。
 * @returns {Array<{id:string,name:string,url:string,type:string,source:string}>}
 */
function scanExternalRootModels() {
  const found = [];
  const seen = new Set();
  for (const root of EXTERNAL_MODELS) {
    if (!root || !root.path) continue;
    const id = root.id;
    const items = scanModelsInRoot(
      root.path,
      'external',
      (dirName, entryFile) =>
        `petmodels://external/${encodeURIComponent(id)}/${encodeURIComponent(dirName)}/${encodeURIComponent(entryFile)}`
    );
    for (const item of items) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      found.push(item);
    }
  }
  return found;
}

/**
 * 扫描「模型存放目录」（importRoot）的一级子目录（source='imported'）。
 * 未设置 importRoot，或 importRoot 与内置 MODELS_DIR 相同时返回空数组
 * （后者已由 scanLocalModels 覆盖，跳过可避免重复项）。
 * url 形如 `petmodels://importroot/<编码目录名>/<编码入口文件名>`。
 * 目录不存在 / 不可读 → 跳过，不抛错。
 * @returns {Array<{id:string,name:string,url:string,type:string,source:string}>}
 */
function scanImportRootModels() {
  if (typeof IMPORT_ROOT !== 'string' || !IMPORT_ROOT.trim()) return [];
  if (isBuiltinModelsRoot(IMPORT_ROOT)) return [];
  const items = scanModelsInRoot(
    IMPORT_ROOT,
    'imported',
    (dirName, entryFile) =>
      `petmodels://importroot/${encodeURIComponent(dirName)}/${encodeURIComponent(entryFile)}`
  );
  // 显示名：去 Cubism 型号 / 尾部分版本号，保留 ` (n)` 冲突序号（R5-4）
  return items.map((item) => ({ ...item, name: deriveDisplayName(item.name) }));
}

/**
 * 扫描「内置 + 外部（全部根）」模型目录，返回全部发现项（已按 url 去重）。
 * 内置项 url 形如 `models/<dir>/<file>`；外部项 url 形如 `petmodels://external/<id>/<dir>/<file>`。
 * @returns {Array<{id:string,name:string,url:string,type:string,source:string}>}
 */
function scanExternalModels() {
  return [...scanLocalModels(), ...scanExternalRootModels()];
}

/**
 * 读取模型清单：文件缺失 / JSON 损坏时回退为空清单；随后合并外部目录扫描结果
 * （把用户手动放入但尚未登记的模型文件夹纳入清单，并把变化写回 models.json）。
 * @returns {{models:Array}} 合并后的清单
 */
function readModelsManifest() {
  ensureModelsDir();

  let manifest = { models: [] };
  try {
    const raw = fs.readFileSync(MODELS_MANIFEST, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.models)) manifest = parsed;
  } catch (_err) {
    // 交由后续扫描结果重建（写回时保留 _readme 说明）
    manifest = {
      _readme:
        '桌宠外部模型目录清单。可直接在本目录放入/删除模型文件夹；' +
        'url 为相对本目录的路径（如 models/xxx/yyy.model3.json）。',
      models: []
    };
  }

  // 仅「内置目录发现项」会被持久化到 models.json（外部发现项改为只在内存合并，
  // 避免更换/清除外部目录后清单里残留已失效的 petmodels://external/... 条目）。
  // 一并剔除历史遗留的外部条目（早期版本可能写入过）。
  const cleaned = manifest.models.filter(
    (m) =>
      !(
        m &&
        typeof m.url === 'string' &&
        (m.url.startsWith('petmodels://external/') || m.url.startsWith('petmodels://importroot/'))
      )
  );
  let changed = cleaned.length !== manifest.models.length;
  manifest.models = cleaned;

  // 合并内置目录发现：按 url 判重，另按「一级目录名」判重避免同目录不同入口文件产生重复项。
  const existingUrls = new Set();
  const existingDirs = new Set();
  for (const m of manifest.models) {
    if (!m || typeof m.url !== 'string') continue;
    existingUrls.add(m.url);
    const seg = m.url.split('/');
    if (seg.length >= 3 && seg[0] === 'models') existingDirs.add(seg[1]);
  }

  for (const model of scanLocalModels()) {
    const dirName = model.url.split('/')[1];
    if (existingUrls.has(model.url) || existingDirs.has(dirName)) continue;
    manifest.models.push(model);
    existingUrls.add(model.url);
    existingDirs.add(dirName);
    changed = true;
  }

  if (changed) {
    try {
      writeModelsManifest(manifest);
    } catch (err) {
      console.error('[main] 写回模型清单失败（忽略，仅影响持久化）：', err);
    }
  }

  // —— 内存合并「模型存放目录」与外部目录发现项（均不写入 models.json）——
  // 顺序：内置（清单 + 目录扫描）→ importRoot → 各外部根；按 url 去重。
  const models = manifest.models.slice();
  const usedIds = new Set(models.map((m) => m && m.id).filter(Boolean));
  const mergedUrls = new Set(
    models.filter((m) => m && typeof m.url === 'string').map((m) => m.url)
  );

  /**
   * 合并一组扫描结果：url 已存在则跳过；id 冲突时加前缀（`import-` / `ext-`），
   * 若仍冲突再追加 `-2/-3`…，保证列表内 id 唯一。
   * @param {Array<{id:string,name:string,url:string,type:string,source:string}>} items
   * @param {string} prefix
   */
  const mergeScanned = (items, prefix) => {
    for (const item of items) {
      if (mergedUrls.has(item.url)) continue;
      let id = item.id;
      if (usedIds.has(id)) {
        let candidate = `${prefix}${id}`;
        let n = 2;
        while (usedIds.has(candidate)) { candidate = `${prefix}${id}-${n}`; n += 1; }
        id = candidate;
      }
      usedIds.add(id);
      mergedUrls.add(item.url);
      models.push({ ...item, id });
    }
  };

  mergeScanned(scanImportRootModels(), 'import-');
  mergeScanned(scanExternalRootModels(), 'ext-');

  return { ...manifest, models };
}

/** 写回模型清单（确保目录存在，带缩进便于人工查看与版本比对） */
function writeModelsManifest(manifest) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  fs.writeFileSync(MODELS_MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');
}

/** 依据入口文件名判定 Live2D 运行时版本 */
function detectModelType(entryFileName) {
  const lower = String(entryFileName).toLowerCase();
  if (lower.endsWith('.model3.json')) return 'Cubism4';
  if (lower.endsWith('.model.json')) return 'Cubism2';
  return 'Cubism4'; // 兜底：未知后缀按 Cubism4 处理
}

/** 依据入口文件名判定 Cubism 大版本号（2 / 4），供目录命名使用 */
function detectCubismVersion(entryFileName) {
  const lower = String(entryFileName).toLowerCase();
  if (lower.endsWith('.model.json')) return 2;
  return 4; // .model3.json 及其它未知后缀均按 Cubism4 处理
}

/**
 * 生成「导入模型」的目标文件夹 / id 名：`<原文件夹名>-cubism<2|4>`。
 *
 * 规则（保留中文等 Unicode 字符，仅剔除会造成路径或展示问题的字符）：
 *   1. 去除 Windows 非法字符 `\ / : * ? " < > |` 及控制字符；
 *   2. 去除首尾空白后，将内部连续空白压缩为单个连字符 `-`；
 *   3. 去除首尾的点（Windows 不接受以点结尾的目录名）；
 *   4. 基础名长度上限 40（截断后再清理一次尾部点 / 空白）。
 *
 * 示例：`lafei_4` → `lafei_4-cubism4`；`樱花miku` → `樱花miku-cubism4`。
 * 抽为纯函数（无 IO、无全局依赖），便于单元断言。
 *
 * @param {string} folderName 原始文件夹名
 * @param {number} version    2 = Cubism2，4 = Cubism4（其它值按 4 处理）
 * @returns {string} 安全的目标 id / 目录名
 */
function sanitizeModelFolderName(folderName, version) {
  const v = version === 2 ? 2 : 4;
  let base = String(folderName == null ? '' : folderName)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '') // 非法字符 + 控制字符：直接移除
    .trim()                                     // 去首尾空白
    .replace(/\s+/g, '-');                      // 内部连续空白 → 单个连字符
  base = base.replace(/^[.\s]+/, '').replace(/[.\s]+$/, ''); // 去首尾点 / 空白
  base = base.slice(0, 40).replace(/[.\s]+$/, '');           // 截断后再清一次尾部
  if (!base) base = 'model';                                 // 极端情况下兜底
  return `${base}-cubism${v}`;
}

/**
 * 判断给定根目录是否就是内置模型目录 MODELS_DIR（大小写不敏感）。
 * @param {string} root
 * @returns {boolean}
 */
function isBuiltinModelsRoot(root) {
  if (typeof root !== 'string' || !root.trim()) return false;
  return path.resolve(root).toLowerCase() === path.resolve(MODELS_DIR).toLowerCase();
}

/**
 * 判断 target 是否位于 root 之内（含相等；大小写不敏感）。
 * @param {string} target
 * @param {string} root
 * @returns {boolean}
 */
function isPathInside(target, root) {
  if (typeof target !== 'string' || typeof root !== 'string' || !target || !root) return false;
  const t = path.resolve(target).toLowerCase();
  const r = path.resolve(root).toLowerCase();
  if (t === r) return true;
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return t.startsWith(prefix);
}

/**
 * 返回「实际导入根」：已设置 importRoot（可创建）否则内置 MODELS_DIR。
 * 目录会被递归创建，故调用方可直接复制文件进去。
 * @returns {string} 实际导入根绝对路径
 * @throws {Error} 目录创建失败（磁盘 / 权限）时抛出
 */
function getEffectiveImportRoot() {
  if (typeof IMPORT_ROOT === 'string' && IMPORT_ROOT.trim()) {
    fs.mkdirSync(IMPORT_ROOT, { recursive: true });
    return IMPORT_ROOT;
  }
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  return MODELS_DIR;
}

// ---------------------------------------------------------------------------
// 导入命名规则（与 Tauri `src-tauri/src/lib.rs` 的同名函数一一对应）
// ---------------------------------------------------------------------------
// 目标：不再给导入目录追加 `-cubism4`，而是剥离源目录名尾部的
//   「Cubism 型号」/「Windows 复制序号 (n)」/「版本号（v1.2 等）」，
// 同名冲突改用 `base (2)` … `base (99)`，绝不覆盖既有目录。

/** 目录名长度上限（与 resolveImportTargetDir 的截断策略一致） */
const MODEL_NAME_MAX_LEN = 40;
/** 冲突序号上限：`(2)` … `(99)` */
const COPY_SUFFIX_MAX = 99;
/** `<base> (99)` 的总长度上限，用于截断 base 以保证加序号后仍不超长 */
const NAME_WITH_SUFFIX_MAX_LEN = 44;

/**
 * 净化目录名：移除 Windows 非法字符与控制字符；连续空白压缩为 `-`；
 * 去首尾点 / 空白；超 40 字符截断后再清一次尾部；空则回退 `model`。
 * @param {string} name 源目录名
 * @returns {string} 安全目录名
 */
function sanitizeModelName(name) {
  let s = String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]+/g, '') // Windows 非法字符 + C0/C1 控制字符
    .trim()
    .replace(/\s+/g, '-'); // 连续空白 → 单个连字符
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  // 按 Unicode 码点计长（与 Rust `chars().count()` 一致，避免截断代理对）
  const chars = Array.from(s);
  if (chars.length > MODEL_NAME_MAX_LEN) {
    s = chars.slice(0, MODEL_NAME_MAX_LEN).join('').replace(/[.\s]+$/, '');
  }
  return s || 'model';
}

/**
 * 是否为 Cubism 型号片段（cubism2/3/4/5，大小写不敏感）。
 * @param {string} seg
 * @returns {boolean}
 */
function isCubismMarker(seg) {
  const s = String(seg == null ? '' : seg).toLowerCase();
  return s === 'cubism2' || s === 'cubism3' || s === 'cubism4' || s === 'cubism5';
}

/**
 * 是否为版本号片段：可选 `v`/`V` 前缀 + 以 `.` 分隔的全 ASCII 数字段。
 * 例：`2` / `03` / `v2` / `V1.0` / `1.2.3` → true；`t03` / `v` / `1.` → false。
 * 注意 `t03` 这类带字母前缀的编号不视为版本号（避免误伤 `haru_greeter_t03`）。
 * @param {string} seg
 * @returns {boolean}
 */
function isVersionSegment(seg) {
  let s = String(seg == null ? '' : seg);
  if (!s) return false;
  if (s[0] === 'v' || s[0] === 'V') s = s.slice(1);
  if (!s) return false;
  const parts = s.split('.');
  if (parts.some((p) => p.length === 0)) return false; // `1.` / `.1` / `v..1` 均非法
  return parts.every((p) => /^[0-9]+$/.test(p));
}

/**
 * 循环剥离尾部片段：以 `-` / `_` / 空格为分隔符，若最后一段满足谓词则截断，
 * 直到不满足为止（每轮先去掉尾部 `.` / 空白）。
 * @param {string} name
 * @param {(seg:string)=>boolean} predicate
 * @returns {string}
 */
function stripTailSegments(name, predicate) {
  let cur = String(name == null ? '' : name);
  for (let guard = 0; guard < 100; guard += 1) {
    cur = cur.replace(/[.\s]+$/, '');
    let sepIndex = -1;
    for (let i = cur.length - 1; i >= 0; i -= 1) {
      const ch = cur[i];
      if (ch === '-' || ch === '_' || ch === ' ') {
        sepIndex = i;
        break;
      }
    }
    if (sepIndex < 0) return cur;
    const seg = cur.slice(sepIndex + 1);
    if (!seg || !predicate(seg)) return cur;
    cur = cur.slice(0, sepIndex);
  }
  return cur;
}

/**
 * 循环剥离尾部「Windows 复制序号」：`(1)` … `(999)`（全角/半角括号均支持）。
 * 要求 `(` 之前存在非空 head；剥离后一并去掉 head 尾部的 `-` / `_` / 空白。
 * @param {string} name
 * @returns {string}
 */
function stripCopySuffix(name) {
  // 与 Rust 一致：先去掉尾部的点 / 空白
  let cur = String(name == null ? '' : name).replace(/[.\s]+$/, '');
  for (let guard = 0; guard < 100; guard += 1) {
    const m = /^(.*)[(（](\d{1,3})[)）]$/.exec(cur);
    if (!m) break;
    const head = m[1].replace(/[\s_-]+$/, '');
    if (!head) break;
    cur = head;
  }
  return cur;
}

/**
 * 由源目录名派生「导入目录名」：净化 → 最多 8 轮剥离复制序号 / Cubism 型号 / 版本号。
 * 例：`lafei_4` → `lafei`；`肥牛-cubism4` → `肥牛`；`x-v1.2` → `x`；`foo (1)` → `foo`。
 * @param {string} raw 源目录名
 * @returns {string} 导入目录名
 */
function deriveBaseModelName(raw) {
  let name = sanitizeModelName(raw);
  for (let i = 0; i < 8; i += 1) {
    const before = name;
    name = stripCopySuffix(name);
    name = stripTailSegments(name, isCubismMarker);
    name = stripTailSegments(name, isVersionSegment);
    name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    if (!name) name = 'model';
    if (name === before) break;
  }
  return name || 'model';
}

/**
 * 由导入后的实际目录名派生「显示名」：仅剥离 Cubism 型号与版本号，
 * **保留** `(n)` 冲突序号（便于区分同名副本）；不做 sanitize。
 * @param {string} dirName 实际目录名
 * @returns {string} 显示名
 */
function deriveDisplayName(dirName) {
  let name = String(dirName == null ? '' : dirName).trim();
  for (let i = 0; i < 8; i += 1) {
    const before = name;
    name = stripTailSegments(name, isCubismMarker);
    name = stripTailSegments(name, isVersionSegment);
    name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    if (!name) name = 'model';
    if (name === before) break;
  }
  return name || 'model';
}

/**
 * 判断两个路径是否指向同一物理目录（先 realpath 解析，失败退化为绝对路径小写比较）。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function isSamePhysicalDir(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch (_err) {
      return path.resolve(p);
    }
  };
  return real(a).toLowerCase() === real(b).toLowerCase();
}

/**
 * 解析导入目标目录：
 *   1. 不存在 → `<root>/<base>`；
 *   2. 已存在且与源目录为同一物理目录 → 复用（幂等重复导入）；
 *   3. 已存在但来源不同 → 依次尝试 `<base 截断 39> (2)` … `(99)`，绝不覆盖；
 *   4. 全部占用 → 抛错。
 * @param {string} root 导入根目录
 * @param {string} srcDir 源目录（用户所选模型的所在目录）
 * @param {string} base 由 deriveBaseModelName 得到的目录名
 * @returns {{destDir:string, actualName:string}}
 * @throws {Error} 同名模型过多时抛出
 */
function resolveImportTargetDir(root, srcDir, base) {
  const safeBase = String(base == null ? '' : base).trim() || 'model';
  const primary = path.join(root, safeBase);

  if (!fs.existsSync(primary)) {
    return { destDir: primary, actualName: safeBase };
  }
  if (isSamePhysicalDir(srcDir, primary)) {
    // 源目录即目标目录：幂等复用，不复制、不删除
    return { destDir: primary, actualName: safeBase };
  }

  // 加序号前把 base 截断到「44 - ' (99)'.length」字符（按码点，与 Rust 一致），并清尾部易混字符
  const maxBaseLen = NAME_WITH_SUFFIX_MAX_LEN - ' (99)'.length;
  let truncated = Array.from(safeBase).slice(0, maxBaseLen).join('').replace(/[.\s_-]+$/, '');
  if (!truncated) truncated = 'model';

  for (let n = 2; n <= COPY_SUFFIX_MAX; n += 1) {
    const candidateName = `${truncated} (${n})`;
    const candidateDir = path.join(root, candidateName);
    if (!fs.existsSync(candidateDir)) {
      return { destDir: candidateDir, actualName: candidateName };
    }
  }
  throw new Error('同名模型过多（已存在 base (2)…(99)）');
}

/**
 * 生成导入模型的 url：
 *   - 内置根 → `models/<目录名>/<入口文件名>`（与既有清单格式一致，路径段不编码）；
 *   - 自定义根 → `petmodels://importroot/<编码目录名>/<编码文件名>`。
 * @param {string} root 实际导入根
 * @param {string} dirName 导入后的目录名
 * @param {string} entryFileName 模型入口文件名
 * @returns {string}
 */
function makeImportedModelUrl(root, dirName, entryFileName) {
  if (isBuiltinModelsRoot(root)) {
    return `models/${dirName}/${entryFileName}`;
  }
  return `petmodels://importroot/${encodeURIComponent(dirName)}/${encodeURIComponent(entryFileName)}`;
}

/**

 * 处理「导入模型」：
 *   选择 .model3.json / .model.json → 复制其所在目录到 web/models/<id>/
 *   → 追加/更新 web/models/models.json → 返回 { ok:true, model:{ id, name, url, type } }。
 * 用户取消：{ ok:false, canceled:true }；失败：{ ok:false, error }。
 * @param {Electron.IpcMainInvokeEvent} event
 */
async function handleImportModel(event) {
  try {
    const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow || undefined;

    const result = await dialog.showOpenDialog(owner, {
      title: '选择 Live2D 模型',
      filters: [
        { name: 'Live2D 模型', extensions: ['json'] },
        { name: '全部', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }

    const entryPath = result.filePaths[0];
    const sourceDir = path.dirname(entryPath);
    const entryFileName = path.basename(entryPath);

    // 导入落点：importRoot（已设置）否则内置 MODELS_DIR
    let root;
    try {
      root = getEffectiveImportRoot();
    } catch (err) {
      return { ok: false, error: `创建模型目录失败: ${String((err && err.message) || err)}` };
    }

    const type = detectModelType(entryFileName);
    const folderName = path.basename(sourceDir) || path.basename(entryPath, path.extname(entryPath));
    const base = deriveBaseModelName(folderName);
    const { destDir, actualName } = resolveImportTargetDir(root, sourceDir, base);
    const model = {
      id: actualName,
      name: deriveDisplayName(actualName),
      url: makeImportedModelUrl(root, actualName, entryFileName),
      type
    };

    // 幂等：源目录即目标目录（重复导入同一目录）→ 不复制、不删除，直接返回既有条目。
    // 必须先于自引用防御：从模型库内部再次导入同一个模型属于合法幂等操作。
    if (isSamePhysicalDir(sourceDir, destDir)) {
      return { ok: true, model };
    }

    // 防御：禁止从应用自身的模型根（内置 models / importRoot / 各外部根）搬移其它目录，
    // 否则会把模型库里的副本再次复制进模型库（递归副本 / 巨量磁盘占用）。
    const selfRoots = [MODELS_DIR];
    if (typeof IMPORT_ROOT === 'string' && IMPORT_ROOT.trim()) selfRoots.push(IMPORT_ROOT);
    for (const r of EXTERNAL_MODELS) {
      if (r && r.path) selfRoots.push(r.path);
    }
    if (selfRoots.some((r) => isPathInside(sourceDir, r))) {
      return { ok: false, error: '不能导入应用自身的模型目录（models）' };
    }

    // 整目录复制（保留贴图、动作、物理、表情等全部伴随资源）
    fs.cpSync(sourceDir, destDir, { recursive: true });

    if (isBuiltinModelsRoot(root)) {
      // 内置根：沿用既有清单持久化（同 id 覆盖，其余条目保持原样）
      const manifest = readModelsManifest();
      const existingIndex = manifest.models.findIndex((m) => m && m.id === actualName);
      if (existingIndex >= 0) {
        manifest.models[existingIndex] = model;
      } else {
        manifest.models.push(model);
      }
      writeModelsManifest(manifest);
    }
    // 自定义 importRoot：不写 models.json，模型清单由扫描（readModelsManifest）合并

    return { ok: true, model };
  } catch (err) {
    console.error('[main] 导入模型失败：', err);
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * 处理「选择外部模型文件夹」：弹目录选择器 → 追加该路径（按 path 去重，不覆盖已有）并持久化。
 * 该目录与内置 models/ 并存，扫描时合并进模型列表。
 * 用户取消：{ ok:false, canceled:true }；失败：{ ok:false, error }。
 * @param {Electron.IpcMainInvokeEvent} event
 */
async function handlePickExternalModelsDir(event) {
  try {
    const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow || undefined;
    const result = await dialog.showOpenDialog(owner, {
      title: '选择外部模型文件夹',
      properties: ['openDirectory']
    });

    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }

    const added = addExternalRoot(result.filePaths[0]);
    if (!added) return { ok: false, error: '无效的文件夹路径' };
    return { ok: true, dirs: EXTERNAL_MODELS.slice(), added };
  } catch (err) {
    console.error('[main] 选择外部模型文件夹失败：', err);
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// ---------------------------------------------------------------------------
// 模型存放目录（importRoot）选择
// ---------------------------------------------------------------------------

/**
 * 处理「选择模型存放目录」：弹目录选择器 → 持久化 importRoot → 返回当前值。
 * 取消时**不修改**配置，返回 `{ ok:true, dir:当前值, canceled:true }`；
 * 写盘失败时回滚内存态并返回 `{ ok:false, error }`（调用方可展示失败原因）。
 * @param {Electron.IpcMainInvokeEvent} event
 * @returns {Promise<{ok:true,dir:string|null,canceled?:boolean}|{ok:false,error:string}>}
 */
async function handlePickImportRoot(event) {
  try {
    const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow || undefined;
    const result = await dialog.showOpenDialog(owner, {
      title: '选择模型存放目录',
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return { ok: true, dir: IMPORT_ROOT, canceled: true };
    }

    const prev = IMPORT_ROOT;
    IMPORT_ROOT = result.filePaths[0]; // 原样保存用户所选绝对路径
    if (!saveConfig()) {
      IMPORT_ROOT = prev;
      return { ok: false, error: '保存模型存放目录失败（无法写入 config.json）' };
    }
    return { ok: true, dir: IMPORT_ROOT };
  } catch (err) {
    console.error('[main] 选择模型存放目录失败：', err);
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// ---------------------------------------------------------------------------
// 模型资源扫描（供渲染进程补齐「未在 .model3.json 声明」的动作 / 表情 / 姿势）
// ---------------------------------------------------------------------------
// 背景：渲染进程运行在 file:// 协议下无法枚举目录（fetch('models/xxx/') 会 Failed to fetch），
// 而模型目录内常存在未被入口清单声明的 *.motion3.json / *.exp3.json / *.pose3.json。
// 故由主进程读取磁盘、列出全部候选资源，以「相对模型目录的 POSIX 路径」回传给前端。

/** 递归扫描的最大深度（模型资源通常位于 modelDir 或 modelDir/motions|expressions 一层） */
const SCAN_MAX_DEPTH = 3;

/**
 * 将模型入口的 URL / 路径解析为磁盘绝对路径。
 * 支持四类入参：
 *   1. petmodels:// URL（外壳自定义协议）：
 *        - `petmodels://local/models/xxx/yyy.model3.json`              → 解析到内置目录 MODELS_DIR 下；
 *        - `petmodels://external/<id>/<dir>/yyy.model3.json`           → 按稳定 id 定位外部根并拼接剩余段；
 *          （根不存在 / 未找到时抛错，由调用方捕获为 { ok:false, error }）；
 *   2. file:// URL（含中文 / 空格等需解码字符）→ fileURLToPath；
 *   3. 绝对路径（Windows 盘符或 POSIX）→ 直接规范化；
 *   4. 相对 web/ 的路径（如 `models/xxx/yyy.model3.json`）→ 相对 WEB_ROOT 解析。
 * @param {string} modelUrlOrPath
 * @returns {string} 磁盘绝对路径
 * @throws {Error} 入参为空 / 外部根未找到时抛错（由调用方捕获为 { ok:false, error }）
 */
function resolveModelEntryPath(modelUrlOrPath) {
  const raw = String(modelUrlOrPath == null ? '' : modelUrlOrPath).trim();
  if (!raw) throw new Error('缺少模型入口路径');

  if (raw.startsWith('petmodels:')) {
    const u = new URL(raw);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    if (u.hostname === 'external') {
      const segs = rel.split('/');
      const id = segs.shift(); // 第一段为稳定 id
      const root = findRoot(id);
      if (!root) throw new Error('未设置对应的外部模型地址');
      return path.join(root.path, segs.join('/'));
    }
    if (u.hostname === 'importroot') {
      // 模型存放目录：petmodels://importroot/<目录名>/<入口文件名>
      if (typeof IMPORT_ROOT !== 'string' || !IMPORT_ROOT.trim()) {
        throw new Error('未设置模型存放目录（importRoot）');
      }
      const base = path.resolve(IMPORT_ROOT);
      const target = path.resolve(path.join(base, rel));
      // 安全校验：必须落在 importRoot 之内，禁止 `..` 逃逸
      const basePrefix = base.endsWith(path.sep) ? base : base + path.sep;
      if (target !== base && !target.startsWith(basePrefix)) {
        throw new Error('非法的模型存放目录路径');
      }
      return target;
    }
    return path.join(MODELS_PARENT, rel);
  }
  if (raw.startsWith('file:')) {
    return fileURLToPath(raw);
  }
  if (path.isAbsolute(raw)) {
    return path.normalize(raw);
  }
  return path.resolve(WEB_ROOT, raw);
}

/**
 * 递归收集模型目录内的资源文件（仅收集，不做去重 / 排序）。
 * 命中规则（大小写不敏感）：
 *   - `*.motion3.json`                 → motions
 *   - `*.exp3.json` / `*.exp.json`     → expressions（后者用于 Cubism2 / 旧格式）
 *   - `*.pose3.json`                   → poses
 * 读取失败（权限 / 竞态）按空目录处理，保证调用方总能拿到结构完整的结果。
 *
 * @param {string} dir    待扫描目录绝对路径
 * @param {number} depth  当前递归深度（从 0 起）
 * @returns {{motions:string[], expressions:string[], poses:string[]}} 绝对路径数组
 */
function collectModelResources(dir, depth) {
  const motions = [];
  const expressions = [];
  const poses = [];
  if (depth > SCAN_MAX_DEPTH) return { motions, expressions, poses };

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_err) {
    return { motions, expressions, poses }; // 目录不可读：视为空
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = collectModelResources(full, depth + 1);
      motions.push(...sub.motions);
      expressions.push(...sub.expressions);
      poses.push(...sub.poses);
    } else if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (lower.endsWith('.motion3.json')) {
        motions.push(full);
      } else if (lower.endsWith('.exp3.json') || lower.endsWith('.exp.json')) {
        expressions.push(full);
      } else if (lower.endsWith('.pose3.json')) {
        poses.push(full);
      }
    }
  }
  return { motions, expressions, poses };
}

/**
 * 扫描指定模型入口所在目录，返回资源清单（IPC `pet:scan-model-resources` 的实现）。
 *
 * @param {string} modelUrlOrPath 模型入口 URL / 绝对路径 / 相对 web/ 的路径
 * @returns {{ok:true, motions:string[], expressions:string[], poses:string[], modelDirRel:string}
 *           | {ok:false, error:string}} 扫描结果（结构化，绝不抛未捕获异常）
 *   - 各数组元素为「相对模型目录」的 POSIX 风格路径（`/` 分隔、不以 `./` 开头），并按字典序稳定排序；
 *   - modelDirRel 为模型目录相对 web/ 的 POSIX 路径，便于渲染端拼接。
 */
function handleScanModelResources(modelUrlOrPath) {
  try {
    const entryPath = resolveModelEntryPath(modelUrlOrPath);
    if (!fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) {
      return { ok: false, error: `模型入口文件不存在：${entryPath}` };
    }

    const modelDir = path.dirname(entryPath);
    const found = collectModelResources(modelDir, 0);

    // 绝对路径 → 相对模型目录的 POSIX 路径；path.relative 不会以 './' 开头
    const toRel = (p) => path.relative(modelDir, p).split(path.sep).join('/');
    const modelDirRel = path.relative(WEB_ROOT, modelDir).split(path.sep).join('/');

    return {
      ok: true,
      motions: found.motions.map(toRel).sort(),
      expressions: found.expressions.map(toRel).sort(),
      poses: found.poses.map(toRel).sort(),
      modelDirRel
    };
  } catch (err) {
    console.error('[main] 扫描模型资源失败：', err);
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// ---------------------------------------------------------------------------
// 自定义协议 petmodels:// —— 把外部 models/ 以标准协议暴露给渲染进程
// ---------------------------------------------------------------------------
// 渲染进程（file:// 页面）通过本协议读取磁盘上的模型，便于模型脱离 asar、可手动增删。
// pixi-live2d-display 对贴图 / moc3 / 动作 / 物理等相对资源的解析会基于「模型入口 URL」
// 的目录进行，故只要模型入口用本协议，其相对资源也会自动走同一协议。
//
// 按 host 分流：
//   - petmodels://local/<rel>              → 解析到 MODELS_PARENT（内置：URL 形如 local/models/<dir>/<file>）；
//   - petmodels://external/<id>/<rel>      → 按稳定 id 定位外部根，剩余段拼到该根下
//                                            （URL 形如 external/r1/<dir>/<file>）；
//   - petmodels://importroot/<rel>         → 解析到「模型存放目录」IMPORT_ROOT
//                                            （URL 形如 importroot/<dir>/<file>；未设置 → 404）；
//   - 未找到对应根 / 其它 host → 404。
// 各分支均做「解析后必须落在对应根之内」的越权校验。
function registerPetModelsProtocol() {
  protocol.handle('petmodels', (request) => {
    try {
      const u = new URL(request.url);
      const host = u.hostname;
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');

      let root;
      let sub = rel;
      if (host === 'local') {
        root = path.resolve(MODELS_PARENT);
      } else if (host === 'external') {
        const segs = rel.split('/');
        const id = segs.shift(); // 第一段为稳定 id
        const found = findRoot(id);
        if (!found || !found.path) return new Response('Not Found', { status: 404 });
        root = path.resolve(found.path);
        sub = segs.join('/');
        if (!fs.existsSync(root)) return new Response('Not Found', { status: 404 });
      } else if (host === 'importroot') {
        // 模型存放目录：petmodels://importroot/<目录名>/<入口文件名>（未设置 → 404）
        if (typeof IMPORT_ROOT !== 'string' || !IMPORT_ROOT.trim()) {
          return new Response('Not Found', { status: 404 });
        }
        root = path.resolve(IMPORT_ROOT);
        sub = rel;
        if (!fs.existsSync(root)) return new Response('Not Found', { status: 404 });
      } else {
        return new Response('Not Found', { status: 404 });
      }

      const abs = path.join(root, sub);
      // 安全校验：解析后的绝对路径必须落在对应根之内，防止 `..` 越权读取
      const resolved = path.resolve(abs);
      const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
      if (resolved !== root && !resolved.startsWith(rootPrefix)) {
        return new Response('Forbidden', { status: 403 });
      }

      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return new Response('Not Found', { status: 404 });
      }

      // 交由 Electron net 读取本地文件并推断 Content-Type（支持 file: 协议）
      return net.fetch(pathToFileURL(resolved).toString());
    } catch (err) {
      console.error('[main] petmodels 协议请求处理失败：', err);
      return new Response('Bad Request', { status: 400 });
    }
  });
}

// ---------------------------------------------------------------------------
// 窗口显示控制
// ---------------------------------------------------------------------------
function setWindowVisible(visible) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (visible) {
    mainWindow.show();
  } else {
    mainWindow.hide();
  }
  updateTrayMenu();
}

function toggleWindowVisible() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
  }
  updateTrayMenu();
}

// ---------------------------------------------------------------------------
// 系统托盘
// ---------------------------------------------------------------------------
function createTray() {
  // 托盘图标：优先使用 build/tray.png（由 build/icon 同源图裁切而来）；
  // 文件缺失（如未随包分发）时回退到内嵌的 TRAY_ICON_DATA_URL。
  let icon = null;
  try {
    const trayPath = path.join(__dirname, '..', 'build', 'tray.png');
    if (fs.existsSync(trayPath)) icon = nativeImage.createFromPath(trayPath);
  } catch (_err) {
    // 忽略，走内嵌回退
  }
  if (!icon || icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  }
  tray = new Tray(icon);
  tray.setToolTip('Desktop Pet');
  // 左键单击：快速显示 / 隐藏
  tray.on('click', () => toggleWindowVisible());
  updateTrayMenu();
}

/** 重建托盘菜单，保持「显示/隐藏」文案与「置顶」勾选状态实时同步 */
function updateTrayMenu() {
  if (!tray) return;

  const hasWindow = !!mainWindow && !mainWindow.isDestroyed();
  const visible = hasWindow && mainWindow.isVisible();
  const alwaysOnTop = hasWindow && mainWindow.isAlwaysOnTop();

  const menu = Menu.buildFromTemplate([
    {
      label: visible ? '隐藏' : '显示',
      click: () => toggleWindowVisible()
    },
    {
      label: '置顶',
      type: 'checkbox',
      checked: alwaysOnTop,
      click: (item) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.setAlwaysOnTop(item.checked, ALWAYS_ON_TOP_LEVEL);
        if (!mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send('pet:always-on-top-changed', item.checked);
        }
        updateTrayMenu();
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => quitApp()
    }
  ]);

  tray.setContextMenu(menu);
}

// ---------------------------------------------------------------------------
// 退出
// ---------------------------------------------------------------------------
function quitApp() {
  isQuitting = true;
  app.quit();
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  loadConfig();                 // 载入 userData/config.json（外部模型目录等，须在 ready 后）
  registerPetModelsProtocol();  // 注册 petmodels://（须在窗口加载前完成）
  ensureModelsDir();            // 确保外部模型目录与首份清单存在
  registerIpc();
  createWindow();
  createTray();

  app.on('activate', () => {
    // macOS：点击 Dock 图标时若无窗口则重建，否则唤回
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });
});

// 托盘常驻：所有窗口关闭后不自动退出，仅由托盘「退出」或 pet:quit 结束进程
app.on('window-all-closed', () => {
  // 有意留空：阻止非 macOS 平台在窗口关闭时自动退出
});

app.on('before-quit', () => {
  isQuitting = true;
});

// 防御性：未捕获异常不静默崩溃（便于定位前端/外壳问题）
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
});
// 仅供自动化断言使用的内部导出（Electron 运行时不读取该导出，无副作用）：
// 命名规则纯函数与扫描实现，便于在不弹窗的情况下做单元式断言。
module.exports = {
  sanitizeModelFolderName,
  detectCubismVersion,
  detectModelType,
  handleScanModelResources,
  handleImportModel,
  // 外部模型地址相关（便于自动化探针断言，无运行时副作用）
  scanExternalModels,
  readModelsManifest,
  getModelsDir: () => MODELS_DIR,
  getModelsParent: () => MODELS_PARENT,
  // 模型存放目录（importRoot）相关：命名纯函数与扫描（便于单元式断言）
  sanitizeModelName,
  isCubismMarker,
  isVersionSegment,
  stripTailSegments,
  stripCopySuffix,
  deriveBaseModelName,
  deriveDisplayName,
  resolveImportTargetDir,
  getEffectiveImportRoot,
  scanImportRootModels,
  /** 当前 importRoot（未设置为 null） */
  getImportRoot: () => (typeof IMPORT_ROOT === 'string' && IMPORT_ROOT ? IMPORT_ROOT : null),
  /** 返回全部外部地址（数组） */
  getExternalModels: () => EXTERNAL_MODELS.slice(),
  /** 返回第一个外部地址的 path（未设置时为 null，兼容旧接口） */
  getExternalModelsDir: () => (EXTERNAL_MODELS.length ? EXTERNAL_MODELS[0].path : null),
  /** 载入配置（探针可在改 config.json 后手动调用以验证迁移） */
  loadConfig,
  /**
   * 测试钩子：清空后设为单个外部地址 [{ id:'r1', path:dir }]（不写配置文件），
   * 供 headless 探针绕过系统目录对话框。保留原方法名以兼容既有验证脚本。
   */
  __setExternalModelsDir: (dir) => {
    EXTERNAL_MODELS = dir ? [{ id: 'r1', path: normalizeRootPath(dir) }] : [];
    return EXTERNAL_MODELS.slice();
  },
  /** 测试钩子：直接设置整个外部地址数组（不写配置文件） */
  __setExternalModels: (dirsArray) => {
    EXTERNAL_MODELS = normalizeRoots(dirsArray);
    return EXTERNAL_MODELS.slice();
  },
  /** 测试钩子：直接设置 importRoot（不写配置文件），返回生效值 */
  __setImportRoot: (dir) => {
    IMPORT_ROOT = typeof dir === 'string' && dir.trim() ? dir : null;
    return IMPORT_ROOT;
  }
};