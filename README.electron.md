# DesktopPetWeb · Electron 外壳

跨平台桌面宠物应用的外壳层。本目录承载 Electron 主进程与根 `package.json`，负责创建
**透明、无边框、置顶、铺满主显示器工作区、鼠标逐区穿透** 的窗口，并加载前端 `web/index.html`。

> 前端（`web/`）与本外壳解耦、可独立调试；外壳不包含任何业务 UI。
> Tauri 外壳已拆分到独立工程 **`D:\ICT\DesktopPetTauri`**（自带一份 `web/` 副本，自包含）。

## 目录结构

```
DesktopPetWeb/
├── package.json          # 根 package.json（仅本外壳维护）
├── .gitignore
├── electron/
│   ├── main.js           # 主进程：窗口 / 穿透 / 置顶 / 托盘 / IPC / 模型导入
│   └── preload.js        # contextBridge 暴露 window.petAPI
└── web/                  # 前端（Electron 工程自带一份；Tauri 工程另有独立副本）
    ├── index.html
    ├── src/              # 前端源码（bridge.js / interaction / live2d / ui）
    └── models/           # 模型清单与模型文件（models.json + <id>/）
                          #   开发态：即此处；打包态：提取为「安装目录根部 models/」（见下）
```

## 安装与运行

```bash
cd DesktopPetWeb
npm install        # 安装 electron / electron-builder（需联网下载 Electron 二进制）
npm start          # 等价于：electron electron/main.js
```

## 打包

```bash
npm run dist       # 使用 electron-builder 打包（Windows → NSIS 安装包）
```

打包产物输出到 `dist/`（已在 `.gitignore` 中忽略）。

## 实现原理

### 窗口铺满主显示器工作区

窗口按**主显示器工作区**定位并铺满，而非固定尺寸：

```js
const { x, y, width, height } = require('electron').screen.getPrimaryDisplay().workArea;
new BrowserWindow({ x, y, width, height, transparent: true, frame: false, /* ... */ });
```

- `workArea` 已排除任务栏 / 停靠栏 / 系统菜单栏，因此窗口不会被任务栏遮挡；
- 同时采用 `workArea` 的左上角 `(x, y)`，兼容主显示器原点非 `(0,0)` 的多屏布局；
- 窗口铺满后**不应再由前端移动整个窗口**：`moveWindow` / `moveWindowTo` 仍保留以兼容旧版前端，
  但正常情况下只应移动场景中的「人物 / 面板」，而非窗口本身；
- 窗口仍为 `resizable: false`，避免用户误拖拽改变布局。

### 透明窗口

`new BrowserWindow({ transparent: true, frame: false, hasShadow: false, backgroundColor: '#00000000' })`。
窗口不绘制背景与边框，仅渲染网页中实际绘制的像素，因此可以实现「只有宠物可见、其余区域透明」的效果。
关闭 `hasShadow` 是为了避免透明窗口边缘出现灰色投影。

### 鼠标逐区穿透

窗口默认对鼠标完全穿透：

```js
win.setIgnoreMouseEvents(true, { forward: true });
```

- `forward: true` 让窗口在穿透状态下**仍然接收 `mousemove` 事件**（仅转发移动事件，不拦截点击），
  前端可据此做命中检测。
- 前端判断光标是否落在宠物身上后，通过 IPC 动态切换：

  ```js
  window.petAPI.setInteractive(true);   // 进入宠物区域：关闭穿透，可交互
  window.petAPI.setInteractive(false);  // 离开宠物区域：恢复整窗穿透
  ```

这样既保证透明区域下方窗口可正常点击，又保证宠物本身可被交互。

### 置顶

构造参数 `alwaysOnTop: true`，并可通过 `pet:set-always-on-top` 或托盘「置顶」菜单项随时切换。
置顶状态变化会通过 `pet:always-on-top-changed` 事件回推给前端，便于 UI 同步。

### 系统托盘

托盘菜单提供：

- **显示 / 隐藏**：文案随窗口可见状态实时更新（左键单击托盘图标亦可快速切换）；
- **置顶**：勾选状态与窗口实际置顶状态同步；
- **退出**：结束进程。

窗口关闭请求（如前端调用 `window.close()`）默认改为「隐藏到托盘」，进程保持常驻；
只有托盘「退出」或 `pet:quit` 才会真正退出。

## 渲染进程 API（`window.petAPI`）

由 `electron/preload.js` 通过 `contextBridge` 暴露（`contextIsolation: true` / `nodeIntegration: false`）：

| 方法 | 说明 |
| --- | --- |
| `setInteractive(bool)` | 切换鼠标交互（`false` = 整窗穿透） |
| `setAlwaysOnTop(bool)` | 切换窗口置顶 |
| `moveWindow(dx, dy)` | 相对移动窗口（像素） |
| `moveWindowTo(x, y)` | 将窗口左上角移动到绝对坐标 |
| `setVisible(bool)` / `toggleVisible()` | 显示 / 隐藏窗口 |
| `setAutoLaunch(bool)` | 设置开机自启（可选） |
| `quit()` | 退出应用 |
| `importModel()` | 打开文件选择器导入 Live2D 模型；成功返回 `{ id, name, url, type }`，取消/失败返回 `null` |
| `getModelList()` | 读取外壳登记的模型清单，返回数组（不可用返回 `null`） |
| `getModelsDir()` | 模型存放目录的绝对路径（可选能力） |
| `modelsBaseUrl` | 外部模型协议基址（`'petmodels://local/'`），渲染层据此解析模型 URL |
| `onAlwaysOnTopChanged(cb)` | 订阅置顶状态变化，返回取消订阅函数 |

接口命名与共享前端 `web/src/bridge.js` 的约定保持一致。

### 模型导入与存放位置

外壳提供模型导入能力，前端经 `web/src/bridge.js` 调用：

```js
const model = await bridge.importModel();   // 成功 → { id, name, url, type }；取消/失败 → null
const list  = await bridge.getModelList();  // → [{ id, name, url, type }] 或 null
```

导入流程（`electron/main.js` 的 `handleImportModel`）：

1. `dialog.showOpenDialog` 选择 `.model3.json`（Cubism4）/ `.model.json`（Cubism2）；
   用户取消时主进程返回 `{ ok:false, canceled:true }`（preload 已抹平为 `null`）。
2. 以「类型前缀 + 时间戳」生成唯一 `id`（同名冲突追加序号），并将**所选文件所在目录整体**
   复制到 `MODELS_DIR/<id>/`（`fs.cpSync(sourceDir, destDir, { recursive: true })`，
   保留贴图 / 动作 / 物理 / 表情等全部伴随资源）。
3. 在 `MODELS_DIR/models.json` 中追加或更新条目：

   ```json
   { "id": "<id>", "name": "<模型目录名>", "url": "models/<id>/<入口文件名>", "type": "Cubism4" }
   ```

   JSON 缺失或损坏时重建为 `{ "models": [ ... ] }`；若已有同名 `id` 则覆盖该条，其余条目保持。
4. 返回 `{ ok:true, model }`。

> **返回值契约**：主进程 IPC（`pet:import-model`）返回结构化
> `{ ok, model }` / `{ ok:false, canceled }` / `{ ok:false, error }`；`preload` 将其**抹平**
> 为 `bridge.js` 期望的形状 —— 成功返回模型对象、取消/失败返回 `null`；`getModelList`
> 亦由 `{ ok, models }` 解包为数组，以匹配 bridge 内部的 `Array.isArray` 校验。

> **存放路径与打包**：模型统一存放在「外部模型目录 `MODELS_DIR`」，**不再压入 `app.asar`**：
> - 打包态：`path.dirname(app.getPath('exe')) + '/models'`，即**安装目录根部的 `models/`**
>   （`win-unpacked/models`、NSIS 安装根 `models/`）——由 electron-builder `extraFiles`
>   将 `web/models/` 提取到此处，`files` 已排除 `web/models/**`；
> - 开发态：`path.join(WEB_ROOT, 'models')`，即源码 `web/models/`。
>
> 该目录为进程外真实文件夹，**可直接放入 / 删除模型文件夹、编辑 `models.json`**，无需重新打包。

> **安全**：导入时拒绝选择应用自身的模型目录（防止自引用导致的无限递归与巨量副本）。

### 外部模型目录与 `petmodels://` 协议

模型以「普通文件」形式放在安装目录根部 `models/` 下，脱离只读的 `app.asar`：

```
<安装目录>/
├── DesktopPetWeb.exe
├── resources/app.asar      # 前端与外壳代码（不含模型）
└── models/                 # ← 外部模型目录（可手动增删）
    ├── models.json         # 清单：{ id?, name?, url, type? }，url 相对本目录
    └── <模型文件夹>/        # 每个模型一整目录（入口 *.model3.json / *.model.json + 贴图/动作/物理等）
```

- **自动发现**：启动 / 刷新时主进程扫描 `models/` 的**一级子目录**，凡含 `*.model3.json`
  （Cubism4）或 `*.model.json`（Cubism2）入口者，若尚未登记则自动追加到 `models.json`
  （幂等；忽略以 `.` 开头或无入口文件的目录）。因此「往 `models/` 丢一个模型文件夹 → 重启/刷新
  即在列表中出现」，也可手工编辑 `models.json` 精确控制名称、顺序与类型。
- **`petmodels://` 自定义协议**：渲染进程运行在 `file://` 页面，无法直接读取 asar 外的目录，
  故主进程注册标准协议 `petmodels`（`registerSchemesAsPrivileged` + `protocol.handle`），
  将 `petmodels://local/models/<dir>/<file>` 映射到 `MODELS_DIR` 下的真实文件
  （`net.fetch(pathToFileURL(...))`，含路径越权校验与中文 / 空格解码）。
- **相对资源解析**：模型入口 URL 采用协议形式
  （如 `petmodels://local/models/cubism4-.../feiniu.model3.json`），pixi-live2d-display
  内部对贴图 / `.moc3` / 动作 / 物理等**相对资源**的解析基于模型 URL 的目录进行，
  故这些资源会自动走同一协议（已实测确认）。
- 渲染层 `web/src/bridge.js` 暴露 `modelsBaseUrl`（`'petmodels://local/'`，无则为空串）与
  能力位 `capabilities.externalModels`；`web/src/main.js` 的 `resolveModelUrl` 据此拼接相对路径，
  协议不可用（浏览器直开）时退回相对路径。

## 已知限制

- **多显示器 / 缩放**：透明窗口在跨不同 DPI 缩放的显示器间移动时，命中检测坐标可能产生偏差；
  建议前端按 `window.devicePixelRatio` 校正。
- **Windows 透明窗口性能**：透明窗口（尤其配合 `transparent: true`）在 Windows 上无法使用 GPU 硬件加速的
  部分合成路径，全屏刷新率与动画性能低于普通窗口；高频动画（如逐帧粒子）可能出现掉帧或 CPU 占用偏高。
- **点击穿透下的命中检测**：因默认整窗穿透，只有 `mousemove` 会转发到页面；若前端停用事件监听，
  窗口将完全不可交互（需通过托盘隐藏/退出兜底）。
- **Linux**：部分桌面环境对 `transparent` / `alwaysOnTop` 支持不完整，表现可能与 Windows/macOS 不一致。
- **`skipTaskbar: false`**：为便于找回窗口，窗口会在任务栏保留入口；如需完全无任务栏入口，可将其改为 `true`。
- **铺满工作区的透明窗口**：窗口覆盖整个主显示器工作区且默认整窗穿透，未命中宠物时点击会穿透到下层应用；
  任务栏位于工作区之外，不受遮挡。若前端停用「悬停穿透」逻辑，则整个工作区将拦截鼠标（需依赖托盘隐藏/退出兜底）。
- **模型导入与外部目录**：模型已提取到安装目录根部 `models/`（外部、可写、可手动增删），
  `files` 已排除 `web/models/**`，故打包态导入不再因 asar 只读而失败。

## 自测

```bash
node --check electron/main.js      # 主进程语法检查
node --check electron/preload.js   # 预加载语法检查
node -e "require('./package.json')" # package.json 合法性校验
```

## 常见问题（Troubleshooting）

- **启动报 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`**：
  说明 `require('electron')` 未返回 Electron API，通常是环境变量 `ELECTRON_RUN_AS_NODE=1` 使 Electron 退化为
  纯 Node 模式。请清除该变量后再运行（Linux/macOS：`env -u ELECTRON_RUN_AS_NODE npm start`）。
- **`npm install` 后 Electron 二进制未下载（`node_modules/electron/dist` 为空）**：
  npm 12+ 默认拦截依赖的 install 脚本。可手动执行
  `node node_modules/electron/install.js`；国内网络可加镜像
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。
- **启动后只看到提示页而非宠物**：属预期行为 —— `web/index.html` 尚未产出时外壳会加载内联提示页，
  待前端任务产出 `web/` 后重启即可。

---

> 说明：前端 `web/` 的说明文档见 `README.md`；本文件专述外壳层，避免与前端文档互相覆盖。