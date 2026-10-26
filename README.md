# DesktopPetTauri · Tauri v2 外壳（独立工程）

Tauri v2 桌面外壳，**自带一份 `web/` 前端副本**（自包含、可独立构建运行），实现 **透明 / 无边框 / 置顶** 的桌宠窗口、
**系统托盘**、**逐区鼠标穿透** 与 **IPC 桥**。与本机另一处的 Electron 外壳工程
（`D:\ICT\DesktopPetWeb`）**各自独立**；两者前端与外壳的接口契约（`bridge.js` ↔ 外壳）保持一致。

> 构建需 **Rust 工具链 + WebView2 + MSVC Build Tools**（见下方「构建前置」）。
> 本工程已在 Windows（Rust 1.99.1 + Tauri CLI 2.12.4）**本机构建通过**，产出单 exe 绿色版。

---

## 目录结构

```
DesktopPetTauri/
├── package.json                # 仅用于本地拉起 Tauri CLI（@tauri-apps/cli）
├── README.md                   # 本文件
├── .gitignore
├── web/                        # 前端（本工程自带副本，自包含）
└── src-tauri/
    ├── Cargo.toml              # Tauri v2 依赖（tauri / tauri-build / serde / serde_json）
    ├── build.rs                # tauri_build::build()
    ├── tauri.conf.json         # 产物/窗口/打包配置，frontendDist 指向 ../web
    ├── capabilities/
    │   └── default.json        # 权限能力集（核心 event/window API）
    ├── icons/                  # 打包与托盘图标（占位图，可替换为正式图标）
    │   ├── 32x32.png
    │   ├── 128x128.png
    │   ├── 128x128@2x.png
    │   └── icon.ico
    └── src/
        ├── main.rs             # 入口：app_lib::run()
        └── lib.rs              # 窗口 / 托盘 / IPC 命令 / run()
```

---

## 构建前置

| 依赖 | 说明 |
| --- | --- |
| **Rust 工具链** | 安装 [rustup](https://rustup.rs/)，需 `rustc` / `cargo`（Tauri v2 要求 Rust ≥ 1.77.2）。 |
| **WebView2 Runtime** | Windows 10/11 通常已内置；若缺失，安装 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。 |
| **Node.js** | 仅用于运行 Tauri CLI（`@tauri-apps/cli`），建议 Node ≥ 18。 |
| **C++ 生成工具** | Windows 上编译 Rust 需要 MSVC Build Tools（勾选「使用 C++ 的桌面开发」）。 |

> 本工程已在 Windows 本机用 `cargo` / `tauri` **编译并打包成功**（单 exe 绿色版；详见文末「构建 / 分发说明」）。

---

## 快速开始

```bash
# 1) 进入外壳目录（Tauri 独立工程根）
cd D:\ICT\DesktopPetTauri

# 2) 安装 Tauri CLI（本地开发依赖）
npm i -D @tauri-apps/cli
# 或：pnpm i -D @tauri-apps/cli

# 3) 开发运行（会自动读取 ../web 作为前端）
npx tauri dev
#   等价：npm run dev

# 4) 打包发布
npx tauri build
#   等价：npm run build
```

**前端目录要求**：`tauri.conf.json` 的 `build.frontendDist` 指向 `../web`（相对 `src-tauri/`），
即本工程根下的 **`DesktopPetTauri/web/`** 需存在并包含入口 `index.html`（已随工程自带）。

- 若 `web/` 是 **纯静态页面**（含 `index.html`）：直接如上运行即可，Tauri 会在 dev 模式下
  以内置静态资源方式提供该目录。
- 若 `web/` 是 **需要构建的前端工程**（如 Vite），请在 `tauri.conf.json` 的 `build` 中补充：

  ```json
  "build": {
    "beforeDevCommand": "npm --prefix ../web run dev",
    "beforeBuildCommand": "npm --prefix ../web run build",
    "devUrl": "http://localhost:5173",
    "frontendDist": "../web/dist"
  }
  ```

  并把 `devUrl` 改成前端实际端口；此时窗口 URL 仍为 `index.html`（由 dev server 提供）。

---

## 关键实现说明

### 1. 透明 / 无边框 / 置顶窗口
- 窗口在 `tauri.conf.json` 的 `app.windows[0]` 中声明：
  `transparent: true`、`decorations: false`、`alwaysOnTop: true`、`skipTaskbar: true`、`shadow: false`。
- `src/lib.rs` 的 `ensure_main_window()` 优先复用该声明；若配置未声明窗口，则用
  `WebviewWindowBuilder::new(...).transparent(true).decorations(false).always_on_top(true).build()`
  以等价属性创建（两条路径属性保持一致）。
- 透明背景需前端页面自身 `background: transparent`（WebView 的 body 不能有不透明底色）。

### 2. 置顶
- 初始置顶由窗口配置保证；运行时通过命令 `set_always_on_top` 或托盘「切换置顶」调整。
- 每次变更都会广播 `always-on-top-changed` 事件，供前端同步 UI 状态。

### 3. 系统托盘
- 使用 `tauri = { features = ["tray-icon"] }` 的 `TrayIconBuilder`。
- 菜单项：**显示桌宠** / **切换置顶** / **退出**；左键单击托盘图标直接显示并聚焦窗口。
- 点击窗口关闭按钮 **不会退出应用**，而是隐藏到托盘（`CloseRequested` → `prevent_close` + `hide`），
  符合桌宠常驻使用习惯。真正退出走托盘「退出」或 `quit` 命令。

### 4. IPC 桥
- `tauri.conf.json` 设置 `app.withGlobalTauri: true`，使前端可通过 `window.__TAURI__`
  访问 `core.invoke` / `event.listen` 等 API。
- 自定义命令通过 `tauri::generate_handler!` 注册（自定义命令不受 ACL 限制；核心 API 由
  `capabilities/default.json` 的 `core:default` 授权）。

### 5. 鼠标穿透（含联动方案与限制）

**Tauri v2 的 `setIgnoreCursorEvents` 没有 Electron 那种 `forward` 语义**——开启穿透后
WebView 收不到任何鼠标事件，也没有「穿透时继续上报鼠标位置」的开关。因此本外壳采用
「**前端上报命中 + Rust 读取光标**」的联动方案：

- Rust 侧命令：
  - `set_interactive(interactive: bool)` → `window.set_ignore_cursor_events(!interactive)`
  - `poll_cursor()` → 返回光标相对窗口左上角的逻辑/物理坐标（读不到时返回 `null`）
- 前端侧联动（约 30fps）：
  1. 当窗口处于 **可交互** 状态时，定时 `invoke('poll_cursor')`；
  2. 用返回值判断光标是否落在 **模型/UI 命中区**（前端最了解自身坐标，例如 Live2D/图片
     的 alpha 命中或 DOM 命中测试）；
  3. 命中 → `invoke('set_interactive', { interactive: true })`（可交互）；
     未命中 → `invoke('set_interactive', { interactive: false })`（整窗穿透）。

**限制与注意**：

- 穿透期间前端无法收到真实鼠标事件，命中判定完全依赖 `poll_cursor` 的坐标 + 前端几何，
  因此前端需要有一套「即使不接收事件也能计算命中」的模型/UI 区域描述。
- 前后端存在 1 帧（约 16–33ms）的判定延迟；快速划过边缘时可能有极短的穿透/命中抖动。
  可通过在命中区外扩几像素的「滞后带（hysteresis）」缓解。
- `poll_cursor` 在光标不可查询时返回 `null`；此时前端应 **退化为整窗穿透**，避免窗口意外
  吸附鼠标导致下层无法点击。
- 若前端选择「始终可交互（不穿透）」的简化模式，可完全不调用 `set_interactive`。

---

## 与前端 `web/src/bridge.js` 的契约

前端 `bridge.js` 通过检测 `window.__TAURI__`（Tauri）或 `window.petAPI`（Electron）选择后端。
下表是本外壳对 Tauri 环境暴露的映射（与 Electron 工程 `D:\ICT\DesktopPetWeb\electron\preload.js`
的 `petAPI` 语义对齐；两工程各自独立）：

| bridge.js 能力（Electron `petAPI`） | Tauri 调用方式 |
| --- | --- |
| `setInteractive(b)` | `invoke('set_interactive', { interactive: b })` |
| `setAlwaysOnTop(b)` | `invoke('set_always_on_top', { enabled: b })` |
| `quit()` | `invoke('quit')` |
| `moveWindow(dx, dy)` | `invoke('move_window', { dx, dy })` |
| `moveWindowTo(x, y)` | `invoke('move_window', { x, y })` |
| `setVisible(b)` | `invoke('set_visible', { visible: b })` |
| `toggleVisible()` | `invoke('toggle_visible')` |
| `onAlwaysOnTopChanged(cb)` | `listen('always-on-top-changed', e => cb(e.payload))` |
| （Tauri 新增）读取光标 | `invoke('poll_cursor')` → `{ x, y, physicalX, physicalY } \| null` |
| `setAutoLaunch(b)` | **未实现**（见「未实现 / 可选能力」） |

### 前端调用示例（供 `bridge.js` 参考）

```js
// 环境检测
const isTauri = typeof window !== 'undefined' && !!window.__TAURI__;
const invoke = isTauri ? window.__TAURI__.core.invoke : null;
const listen = isTauri ? window.__TAURI__.event.listen : null;

// 切换穿透 / 可交互
await invoke('set_interactive', { interactive: true });   // 可交互（关闭穿透）
await invoke('set_interactive', { interactive: false });  // 整窗穿透

// 置顶
await invoke('set_always_on_top', { enabled: true });

// 订阅置顶状态变化（托盘触发时同步前端）
const unlisten = await listen('always-on-top-changed', (e) => {
  console.log('alwaysOnTop =', e.payload); // payload 为布尔值
});

// 逐区穿透联动（示例：30fps 轮询）
setInterval(async () => {
  const pos = await invoke('poll_cursor');
  if (!pos) { await invoke('set_interactive', { interactive: false }); return; }
  const overPet = isPointOverModelOrUI(pos.x, pos.y); // 前端自身的命中判定
  await invoke('set_interactive', { interactive: overPet });
}, 33);

// 退出
await invoke('quit');
```

> 注：`withGlobalTauri: true` 时 `window.__TAURI__` 会注入全部 JS API，
> `core.invoke` 与 `event.listen` 分别为核心调用与事件订阅入口。

---

## 未实现 / 可选能力

- **开机自启 `setAutoLaunch`**：Tauri 官方方案是 [`tauri-plugin-autostart`](https://v2.tauri.app/plugin/autostart/)。
  为避免在本机无法验证的情况下引入未经编译的插件 API，本外壳 **默认未启用**。若需要，
  在 `Cargo.toml` 增加依赖并用 `.plugin(tauri_plugin_autostart::init(...))` 注册，再补一个
  `set_auto_launch` 命令转发到 `app.autolaunch().enable()/disable()` 即可。
- **窗口圆角 / 阴影**：桌面端透明窗口已设 `shadow: false`，如需圆角请在 **前端页面** 用
  `border-radius` + 透明背景实现（Windows 窗口级圆角由 DWM 控制，非 Tauri 配置项）。

---

## 构建与自检

本工程已在 Windows 本机构建通过（Rust 1.99.1 + Tauri CLI 2.12.4）：

- **编译验证**：`cargo check` 通过；`tauri build --no-bundle`（x64 与 x86）均**构建成功**，产出单 exe。
- **配置/资源自检**：`tauri.conf.json`、`capabilities/default.json`、`package.json`、`icons/*`
  为合法 JSON / PNG / ICO；`Cargo.toml` 为合法 TOML；Rust 源码括号 / `use` / 宏完整。
- **未覆盖**：运行时行为（透明 / 穿透 / 托盘）的**自动化实测**——需在真实桌面环境人工验证。

> 本目录现已纳入 git 版本管理，并推送至本仓库的 `tauri` 分支（详见下节）。

---

## 构建 / 分发说明（tauri 分支）

本分支 `tauri` 为 **独立的 Tauri v2 桌面外壳**，与主仓库的 Electron 版本并行维护。

1. **先拉取 Live2D 内核，再构建**。Live2D 运行时库（`web/vendor/live2d.min.js`、
   `web/vendor/live2dcubismcore.min.js`）属 Live2D **专有许可**，**不随本仓库分发**（已被
   `.gitignore` 排除）。克隆后请先执行：

   ```bash
   npm run fetch-vendor   # 等价于 node scripts/fetch-vendor.mjs
   ```

   该脚本会从上游 CDN 把内核下载到 `web/vendor/`。若下载失败，请手动获取并放入该目录
   （许可与致谢详见 `THIRD-PARTY-NOTICES.md`）。完成后即可构建：

   ```bash
   npm run build          # 等价于 npx tauri build
   ```

2. **平台限制：仅 Windows**。本分支为 **Tauri v2 单 exe 绿色版**，仅支持 Windows
   （透明窗口 / 逐区穿透 / 托盘等实现依赖 Win32 API，未做跨平台适配）。

3. **发布物**：构建产物为单文件绿色版可执行程序，命名如下（无需安装，解压即用）：

   - `DesktopPetTauri.1.0.4.x64.exe`（64 位）
   - `DesktopPetTauri.1.0.4.x86.exe`（32 位）

   以上已在 [Releases](https://github.com/Aerdgareo/DesktopPetWeb/releases) 的 **v1.0.4** 提供下载。

> 二进制发布物请放到 GitHub Releases，**不要提交进 Git 历史**（`dist/` 已在 `.gitignore` 中排除）。
> 依 GPLv3，随 Release 须同时提供对应源码（给出本仓库链接即可）。