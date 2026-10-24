# DesktopPetWeb · Web 渲染前端

桌宠软件的 **Web 渲染层**，一套代码同时供 **Electron** 与 **Tauri** 两套外壳复用。

核心目标：用 `pixi-live2d-display` 在浏览器/WebView 中渲染 Live2D，并**同时支持 Cubism 2 代与 4 代**模型
（这也是本项目从 Unity 迁移到 Web 的原因——Unity 的 Cubism SDK 5 不再支持 2 代模型）。

- 渲染：PixiJS 6.5 + pixi-live2d-display 0.4（**自动识别** `.model.json` 与 `.model3.json`）
- 依赖：全部 **本地 vendor 直引**（`web/vendor/` 已内置运行时，**纯离线运行、无需联网**），不引入打包器、不占用根 `package.json`
- 交互：视线跟随、仅命中模型可拖拽、点击反应、设置面板浮层、鼠标穿透联动
- 外壳桥：统一 `bridge` 抽象，浏览器直开自动降级为 no-op

---

## 目录结构

```
web/
├─ index.html                     # 全屏透明 canvas + 设置面板浮层 + 本地运行时引导脚本
├─ vendor/                        # 本地化运行时库（离线可用，无需联网）
│  ├─ pixi.min.js
│  ├─ live2d.min.js
│  ├─ live2dcubismcore.min.js
│  └─ pixi-live2d-display.min.js
├─ models/
│  └─ models.json                 # 模型清单（可自行编辑；缺失则用内置演示模型）
├─ src/
│  ├─ main.js                     # 入口编排：创建 Application → 加载模型 → 面板 → 交互 → 外壳桥
│  ├─ bridge.js                   # Electron / Tauri / 浏览器 统一桥（含降级）
│  ├─ live2d/
│  │  └─ modelLoader.js           # 加载/切换模型、自动缩放居中、透明度/缩放（loadModel/currentModel/getModelOptions）
│  ├─ interaction/
│  │  └─ petInteraction.js        # 视线跟随 / 命中判定 / 拖拽（仅模型）/ 点击反应 / 穿透联动
│  └─ ui/
│     └─ settingsPanel.js         # 浮层设置面板（透明度、缩放、模型列表、置顶、穿透、导入、退出）
└─ README.md
```

---

## 一、用浏览器单独预览（本地调试）

ESM 模块不能通过 `file://` 直接打开，需要一个静态服务器（任选其一）：

```bash
# 方式 A：Node 生态
npx --yes http-server . -p 5173 -c-1

# 方式 B：Python
python -m http.server 5173

# 方式 C：VS Code Live Server 等
```

然后访问：

```
http://localhost:5173/index.html
```

指定初始模型（可选）：

```
http://localhost:5173/index.html?model=https://example.com/xxx/yyy.model3.json
```

浏览器直开时：

- 透明背景在浏览器里表现为「白底」，这是浏览器宿主决定的，**不影响外壳里的透明窗口**；
- `bridge` 全部降级为 no-op（不报错、不阻断），穿透开关自动禁用，模型加载、视线、拖拽、点击、设置面板均可正常调试。

---

## 二、用 Electron 外壳运行（推荐，支持「悬停自动穿透」）

窗口必须开启透明，并**默认开启鼠标穿透 + 转发 mousemove**（`forward: true`），
这样前端才能在「穿透态」下通过 `mousemove` 判断是否悬停命中模型/面板，命中时再临时开启可点。

`main.js`（主进程，示例）：

```js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 720,
    frame: false,
    transparent: true,          // 透明窗口
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // 默认穿透，且转发 mousemove（关键）
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'web/index.html'));
}

ipcMain.on('pet:set-interactive', (_e, interactive) => {
  // interactive=true → 可点；false → 穿透（并转发 mousemove）
  win.setIgnoreMouseEvents(!interactive, { forward: true });
});
ipcMain.on('pet:set-always-on-top', (_e, value) => win.setAlwaysOnTop(!!value, 'screen-saver'));
ipcMain.on('pet:quit', () => app.quit());
// 可选：模型清单 / 导入模型
ipcMain.handle('pet:get-model-list', async () => ([/* { id, name, url, type } */]));
ipcMain.handle('pet:import-model', async () => null);

app.whenReady().then(createWindow);
```

`preload.js`（示例，暴露 `window.petAPI`）：

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  setInteractive: (interactive) => ipcRenderer.send('pet:set-interactive', interactive),
  setAlwaysOnTop: (value) => ipcRenderer.send('pet:set-always-on-top', value),
  quit: () => ipcRenderer.send('pet:quit'),
  getModelList: () => ipcRenderer.invoke('pet:get-model-list'),
  importModel: () => ipcRenderer.invoke('pet:import-model')
});
```

> 桥也兼容低级命名：若 preload 暴露的是 `setIgnoreMouseEvents(ignore, { forward })`，桥会自动改用该接口
> （`setInteractive(true)` → `setIgnoreMouseEvents(false)`）。

---

## 三、用 Tauri 外壳运行

`tauri.conf.json` 窗口需开启透明：

```json
{
  "app": {
    "windows": [
      { "transparent": true, "decorations": false, "alwaysOnTop": true, "width": 420, "height": 720 }
    ]
  }
}
```

前端会自动探测 `window.__TAURI__`，并调用主窗口的 `setIgnoreCursorEvents` / `setAlwaysOnTop` / `close`。

可选命令（若外壳提供，则启用「导入模型 / 外壳模型清单」）：

```rust
#[tauri::command]
fn get_model_list() -> Vec<serde_json::Value> { vec![] }

#[tauri::command]
fn import_model() -> Option<serde_json::Value> { None }
```

> **重要限制**：Tauri 的 `setIgnoreCursorEvents(true)` **不会转发 `mousemove`**，因此无法实现「悬停命中才可点」的
> 自动穿透。本前端在 Tauri 下会**自动切换为「常驻可点」**，并把设置面板中的「鼠标穿透」开关置灰；
> 如需穿透，请在外壳侧自行实现（例如配合全局鼠标位置轮询后调用 `setIgnoreCursorEvents`）。

---

## 四、运行时依赖说明（已本地化，离线可用）

> **运行时库已本地化到 `web/vendor/`，无需联网**：`index.html` 通过相对路径直接引入 4 个运行时，
> 不再引用任何 CDN，断网环境亦可正常启动。

`index.html` 按以下顺序引入本地文件（顺序敏感，`PixiJS` 必须先于 `pixi-live2d-display`，因其 UMD 直接读取 `window.PIXI.utils`）：

| 依赖 | 本地文件 | 大小 | 作用 |
| --- | --- | --- | --- |
| PixiJS **6.5.10** | `vendor/pixi.min.js` | 460333 B | 渲染核心（pixi-live2d-display 0.4 依赖 Pixi 6） |
| Cubism 2.1 运行时 | `vendor/live2d.min.js` | 129056 B | `live2d.min.js`，加载 2 代 `.moc` |
| Cubism 4 核心 | `vendor/live2dcubismcore.min.js` | 207155 B | `live2dcubismcore.min.js`，加载 3/4 代 `.moc3` |
| pixi-live2d-display **0.4.0** | `vendor/pixi-live2d-display.min.js` | 126855 B | Live2D 集成，暴露 `PIXI.live2d.Live2DModel` |

**关于 `index.min.js`（而非 `cubism2.js` + `cubism4.js`）：**
pixi-live2d-display 官方文档明确说明——要同时支持 Cubism 2.1 与 4，必须使用 **`index.js`**，
**不可**组合 `cubism2.js + cubism4.js`（二者会互相覆盖 `PIXI.live2d`，只能保留一个运行时）。
`index.min.js` 内部同时注册了 Cubism2 与 Cubism4 两套运行时适配，配合两个运行时文件即可覆盖全部模型。
上表 4 个文件均已按官方 `dist/index.min.js` 版本本地化。

**依赖校验：** `index.html` 的引导脚本会逐个校验全局对象
（`PIXI` → `Live2D` → `Live2DCubismCore` → `PIXI.live2d.Live2DModel`），核心对象缺失时在页面中央显示红色错误提示
（并提示确认 `web/vendor/` 目录完整）。因全部为本地同步加载，无需任何 CDN 回退逻辑。

> 运行时缺失单个不影响另一个：缺 `live2d.min.js` 只影响 2 代，缺 `live2dcubismcore.min.js` 只影响 3/4 代（控制台给出告警）。

---

## 五、支持的模型格式

| | Cubism 2.1 | Cubism 3 / 4 |
| --- | --- | --- |
| 清单 | `.model.json` | `.model3.json` |
| 模型 | `.moc` | `.moc3` |
| 动作 | `.mtn` | `.motion3.json` |
| 表情 | `.exp.json` | `.exp3.json` |
| 物理 / 姿势 | `.physics.json` / `.pose.json` | `.physics3.json` / `.pose3.json` |

**自动识别**：`Live2DModel.from(url)` 会依据清单内容自动选择对应运行时，前端无需区分。
加载完成后 `modelLoader` 会在控制台打印识别到的模型名与画布尺寸，便于确认。

模型来源优先级：

1. 外壳提供的清单（Electron `petAPI.getModelList()` / Tauri `get_model_list`）
2. `web/models/models.json`（用户可编辑，见文件内 `_readme`）
3. 内置演示模型（`Shizuku` C2 / `Haru` C4，来自 pixi-live2d-display 官方测试资源，**需联网**；运行时库本身已本地化，不受影响）

---

## 六、关键行为说明

- **窗口透明**：`body{background:transparent}`，Pixi `Application({ backgroundAlpha: 0, transparent: true })`。
- **鼠标穿透联动**：
  - `petInteraction` 在 `mousemove` 上实时判定「命中模型（`hitTest` 精判，失败退化为包围盒）」或「命中设置面板 UI」，
    状态变化时调用 `bridge.setInteractive(bool)`（内部去抖，避免每次移动都跨进程通信）。
  - 命中 → 窗口可点；离开 → 恢复穿透。拖拽期间保持可点。
- **拖拽只移动模型**：命中且位移超过阈值（默认 8px）才进入拖拽，仅修改 `model.x / model.y`，**不移动也不裁剪窗口**。
- **点击反应**：命中模型且位移未超阈值的点击 → 依次尝试 `Tap / tap_body / tap_head / flick_head / shake`，
  均不存在时尝试随机表情，再无可静默（不做无意义报错）。拖拽与点击用位移阈值区分。
- **视线跟随**：`app.ticker` 每帧调用 `model.focus(mouseX, mouseY)`（Cubism2/4 均支持）。
- **设置面板**：固定屏幕右下角（避免遮挡底部居中的角色），可拖动、模型列表可滚动，含透明度/缩放滑条、
  模型切换、置顶开关、穿透开关、导入模型、退出。面板显示时同样纳入「可点」判定。
- **Cubism 版本标注**：以**运行时对象类型**判定
  （`internalModel instanceof PIXI.live2d.Cubism2InternalModel / Cubism4InternalModel`），
  **不靠清单字段猜测**——2 代 `.model.json` 里同样存在真值字段 `moc`，字段猜测会把 2 代误判为 3/4 代。
  面板模型条目的版本徽标与控制台日志同源（`modelLoader.getModelKind()`），保证两处一致。
- **外壳能力派生**：`bridge.capabilities` 按外壳**真实提供的方法**判定，而非仅凭 `runtime`；
  未提供 `importModel` / `getModelList` 时，"导入模型"按钮会被禁用并给出原因，
  模型清单自动回退 `models.json` / 内置演示模型，不再出现"按钮启用却空操作"。

---

## 七、自测步骤与结论

### 1. 语法检查（Node，无需浏览器）

```bash
# ESM 模块（Node 视为 ESM 需 .mjs 后缀，故复制后检查）
for f in bridge main; do cp src/$f.js /tmp/$f.mjs && node --check /tmp/$f.mjs; done
cp src/live2d/modelLoader.js /tmp/modelLoader.mjs && node --check /tmp/modelLoader.mjs
cp src/interaction/petInteraction.js /tmp/petInteraction.mjs && node --check /tmp/petInteraction.mjs
cp src/ui/settingsPanel.js /tmp/settingsPanel.mjs && node --check /tmp/settingsPanel.mjs

# index.html 内联脚本
node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');const re=/<script(?![^>]*\\ssrc=)[^>]*>([\\s\\S]*?)<\\/script>/gi;let m,i=0;while((m=re.exec(h))){fs.writeFileSync('/tmp/inline_'+(i++)+'.js',m[1]);}console.log('inline:',i)"
node --check /tmp/inline_0.js && node --check /tmp/inline_1.js
```

### 2. 行为冒烟（Node + 桩 DOM/PIXI）

- **bridge**：在 Node 环境下正确降级为 `runtime=browser`，`setInteractive` 返回 `true`（no-op），
  `setAlwaysOnTop/quit/getModelList/importModel` 全部安全返回，不抛异常。
- **petInteraction**：断言通过——悬停命中模型→可点、离开→穿透、精判命中（`hitTest` 返回命中区）→可点、
  悬停设置面板→可点、拖拽仅改变 `model.x/model.y`、拖拽结束不触发点击、小位移点击触发 `Tap`、
  `detach` 后不再联动。实际下发序列：`[false,true,false,true,false,true]`。
- **modelLoader**：断言通过——底部居中定位 `(x=屏宽×0.5, y=屏底)`、自动缩放取「完整可见」较小值、
  `setAlpha/setScalePercent` 生效、切换模型时旧模型被销毁并移出舞台、`resize` 后重新适配、
  `preservePosition` 下夹取位置到窗口内、`unloadModel` 清空当前模型。

### 3. 浏览器人工自测（有 GUI 时）

1. `npx --yes http-server . -p 5173 -c-1` 并打开 `http://localhost:5173/index.html`；
2. 确认两个演示模型（Cubism2 / Cubism4）均能加载，控制台打印识别结果；
3. 移动鼠标 → 人物视线跟随；在设置面板切换模型 → 人物替换且重新适配；
4. 在人物身上按住拖动 → **人物移动、窗口不动**；在空白处按住拖动 → 无反应（穿透）；
5. 在人物身上单击 → 播放 Tap 动作（或表情）；
6. 拖动透明度/缩放滑条 → 人物实时变化；关闭面板 → 右下角出现 ⚙ 悬浮按钮，点击可重新打开。

---

### 4. Electron 实机复验（缺陷修复后）

以真实外壳（`electron/preload.js` + `file://` 加载本页）复跑，结论：

| 项目 | 复验结果 |
| --- | --- |
| `bridge.runtime` | `electron` |
| `bridge.capabilities` | `{interactive:true, alwaysOnTop:true, quit:true, modelList:false, importModel:false}` |
| "导入模型"按钮 | 已禁用，`title` = "当前外壳不支持导入模型（外壳未提供 importModel）" |
| `bridge.importModel()` / `bridge.getModelList()` | 均返回 `null`（不再空操作/不再发起无谓调用） |
| 模型清单来源 | 回退本地 `models.json`（2 条，`source=local`） |
| 初始模型日志 | `已加载模型 "haru"（Cubism 4），画布 2400x4500` |
| 点击列表第 1 项（shizuku，2 代） | `getModelKind()` = **Cubism 2.1**；徽标 = `Cubism 2.1`；状态栏 = `已加载：Shizuku…（Cubism 2.1）` |
| 点击列表第 2 项（haru，4 代） | `getModelKind()` = **Cubism 4**；徽标 = `Cubism 4`；状态栏 = `已加载：Haru…（Cubism 4）` |

即：**2 代不再被误判为 3/4 代**，面板标注与 console 日志一致；能力派生与按钮行为自洽。

> 复跑命令（Windows，需清除 `ELECTRON_RUN_AS_NODE`）：
> `env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe <验证脚本>`

## 八、已知限制

1. **运行时已本地化**（`web/vendor/`，见「四、运行时依赖说明」），**无需联网即可启动**；但**内置演示模型**（来自官方测试资源的 `Shizuku`/`Haru`）仍需联网获取——若需完全离线，请把模型资源下载到本地并更新 `models/models.json`。
2. **Tauri 不支持「悬停自动穿透」**（其 `setIgnoreCursorEvents` 不转发 `mousemove`），已在桥中标记并在前端自动切换为常驻可点。
3. 本地预览必须走 HTTP（ESM 不支持 `file://`）。
4. 导入模型的具体实现取决于外壳：Web 层只调用 `bridge.importModel()`，返回 `{ id, name, url }` 即可接入。5. Electron 的 `setIgnoreMouseEvents(true, { forward: true })` 只转发 `mousemove`、不转发 `mousedown`；
   窗口由「穿透」切到「可点」依赖鼠标**先移动**到模型/面板上（正常使用必然满足）。
   若需要「零移动直接点击」的极致体验，需在外壳侧做更细粒度的命中转发（例如 Win32 `WM_NCHITTEST`）。6. 当前 Electron 外壳的 `preload.js` 未暴露 `importModel` / `getModelList`：因此"导入模型"按钮被**禁用**，
   模型清单回退到 `models.json`。若需启用该能力，请在外壳侧实现并暴露这两个方法（Web 层无需改动，
   `bridge.capabilities` 会自动识别并启用按钮）。Tauri 外壳同理（未实现 `get_model_list` / `import_model`）。7. Cubism 2.1 模型在切换后的首帧渲染时，`live2d.min.js` 可能输出一次
   `call update() before draw()` 告警（源于 `pixi-live2d-display` 的 Ticker 注册顺序），
   **不影响模型加载与显示**，属上游库行为。