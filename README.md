# DesktopPetTauri · Tauri v2 外壳（独立工程）

Tauri v2 桌面外壳，**自带一份 `web/` 前端副本**（自包含、可独立构建运行），实现 **透明 / 无边框 / 置顶** 的桌宠窗口、
**系统托盘**、**逐区鼠标穿透** 与 **IPC 桥**。与本机另一处的 Electron 外壳工程
（`D:\ICT\DesktopPetWeb`）**各自独立**；两者前端与外壳的接口契约（`bridge.js` ↔ 外壳）保持一致。

在此之上还提供四项增强能力：**导入模型自动去版本号后缀**、**全局模型存放目录**、
**单窗口多模型同显（位置各自独立）** 与 **全屏雨效（四档 + 可开关音效）**，详见「功能特性」与「新增功能说明」。

> 构建需 **Rust 工具链 + WebView2 + MSVC Build Tools**（见下方「构建前置」）。
> 本工程已在 Windows（Rust 1.99.1 + Tauri CLI 2.12.4）**本机构建通过**，产出单 exe 绿色版。

---

## 功能特性

### 基础能力（既有）

- **全屏透明桌宠窗口**：无边框、置顶、不在任务栏显示，关闭按钮仅隐藏到托盘。
- **系统托盘**：显示桌宠 / 切换置顶 / 退出；左键单击托盘图标直接显示并聚焦窗口。
- **逐区鼠标穿透**：前端上报命中 + Rust 侧读取光标，只有命中模型/设置面板的区域可点，其余整窗穿透。
- **Live2D 渲染**：PixiJS 6.5 + pixi-live2d-display 0.4，同时支持 Cubism 2.1（`.model.json`）与 Cubism 3/4（`.model3.json`）。
- **设置面板**：透明度、缩放、模型列表、表情/姿势、置顶、穿透、导入模型、外部模型文件夹、退出。

### 本次新增能力

| 能力 | 说明 | 关键实现 |
| --- | --- | --- |
| **导入模型命名规范化** | 导入时自动去掉源目录名尾部的 Cubism 型号（`-cubism4`）、Windows 复制后缀（` (1)`）与版本号（`_4`、`-v1.2`）；列表显示同步净化。同名模型**不再覆盖**，改为新建 `名称 (2)`、`名称 (3)`… | `src-tauri/src/lib.rs` 的 `derive_base_model_name` / `derive_display_name` / `resolve_import_target_dir` |
| **全局模型存放目录** | 设置面板可指定「模型存放目录」，之后导入的模型落到 `<模型存放目录>/<基本模型名>/`；配置持久化在 `config.json` 的 `importRoot`，重启保持；可「恢复默认」回落到 exe 同级 `models/`。该能力**仅 Tauri 外壳可用**，Electron / 浏览器下按钮置灰并提示不支持 | `get_import_root` / `pick_import_root` / `clear_import_root` 命令；`web/src/bridge.js`、`web/src/ui/importRootPanel.js` |
| **单窗口多模型同显** | 同一窗口内最多同时显示 **6** 个模型实例；每个实例位置**各自独立**持久化，重启按原位置恢复。点模型条目的「＋」新增实例（`以新实例显示`）；切换模型 = 替换活动实例；移除实例只从窗口移除，**不删磁盘文件** | `web/src/live2d/modelLoader.js`（实例注册表）、`web/src/interaction/petInteraction.js`（按最上层命中）、`web/src/app/instances.js`（持久化）、`web/src/ui/instancePanel.js` |
| **全屏雨效** | 「全屏下雨」开关 + 四档（小雨 / 中雨 / 大雨 / 雷雨），雷雨档有周期性闪电；**雨声音效可独立开关**；关闭下雨时档位与音效选项自动折叠。雨层覆盖全窗口且**不拦截鼠标**，开关/档位/音效均持久化 | `web/src/effects/rain.js`、`web/src/ui/rainPanel.js`、`web/assets/audio/` |

> 以上新增能力的实机交互验收（多实例拖拽/重启恢复、雨效四档粒子数与音效播放等）由集成验收环节执行，本 README 仅描述实现语义，**不代表已完成运行时实测**。

---

## 目录结构

```
DesktopPetTauri/
├── package.json                # 仅用于本地拉起 Tauri CLI（@tauri-apps/cli）
├── README.md                   # 本文件
├── THIRD-PARTY-NOTICES.md      # 第三方组件与素材许可声明（含雨声/雷声音效）
├── .gitignore
├── scripts/
│   ├── fetch-vendor.mjs        # 拉取 Live2D 内核到 web/vendor/
│   └── generate-rain-audio.mjs # 生成雷声 WAV（项目内自制，CC0-1.0）；雨声为真实录音 FLAC（CC0-1.0）
├── web/                        # 前端（本工程自带副本，自包含；详见 web/README.md）
│   ├── assets/audio/           # rain-loop.flac（Freesound CC0 录音）/ thunder.wav（自制 CC0）+ LICENSES.md
│   └── src/                    # app/ effects/ interaction/ live2d/ ui/
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
cd D:\ICT\DesktopPetWeb\DesktopPetTauri\DesktopPetTauri

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
- 前端侧联动（约 20fps，轮询间隔 50ms）：
  1. 当窗口处于 **可交互** 状态时，定时 `invoke('poll_cursor')`；
  2. 用返回值判断光标是否落在 **模型/UI 命中区**（前端最了解自身坐标，例如 Live2D/图片
     的 alpha 命中或 DOM 命中测试）；
  3. 命中 → `invoke('set_interactive', { interactive: true })`（可交互）；
     未命中 → `invoke('set_interactive', { interactive: false })`（整窗穿透）。

**限制与注意**：

- 穿透期间前端无法收到真实鼠标事件，命中判定完全依赖 `poll_cursor` 的坐标 + 前端几何，
  因此前端需要有一套「即使不接收事件也能计算命中」的模型/UI 区域描述。
- 前后端存在 1 帧（约 16–50ms）的判定延迟；快速划过边缘时可能有极短的穿透/命中抖动。
  可通过在命中区外扩几像素的「滞后带（hysteresis）」缓解。
- `poll_cursor` 在光标不可查询时会返回 `null`；**连续失败达到阈值后**前端会停止轮询并降级为
  「常驻可点」（而不是保持整窗穿透），以保证用户始终能点到模型/设置面板。
- 若前端选择「始终可交互（不穿透）」的简化模式，可完全不调用 `set_interactive`。

---

## 新增功能说明（导入命名 / 模型存放目录 / 多模型 / 雨效）

> 以下描述均以当前源码实现为准；涉及交互体验的结论（拖拽手感、听感等）需在实机验收中确认。

### 1. 导入模型命名规则

导入模型时，目标目录名与列表显示名由**源目录名净化**得到，**不再带版本号/型号后缀**：

| 步骤 | 规则 | 示例 |
| --- | --- | --- |
| 1 | 过滤 Windows 非法字符与控制字符；连续空白合并为 `-`；裁掉首尾 `.`/空格 | 既有 `sanitize_model_name` 行为 |
| 2 | 去尾部 Windows 复制后缀 ` (1)`、` (2)` | `foo (1)` → `foo` |
| 3 | 循环去尾部 Cubism 型号 `-cubism2/3/4/5`、`_cubism4`、空格分隔形式（大小写不敏感） | `肥牛-cubism4` → `肥牛` |
| 4 | 循环去尾部分版本号（`_4`、`_5`、`-v2`、`_v1.0` 等） | `lafei_4` → `lafei`；`aierdeliqi_5` → `aierdeliqi`；`x-v1.2` → `x` |
| 5 | 净化后为空 → `model` | — |

- **不误伤**：末尾为「字母 + 数字」的标识（如 `haru_greeter_t03`）**保持原样**。
- **同名不覆盖**：若目标目录已存在且本次来源不是同一物理目录，改为新建 `名称 (2)`、`名称 (3)`…（最多到 `(99)`，全部占用则报错），**不再删除旧目录**。
- **幂等**：重复导入「同一个源目录」（源目录即目标目录）直接复用现有目录，不产生副本。
- **历史目录不改名**：已导入的磁盘目录保持原名，仅列表显示名做净化；`名称 (2)` 的冲突序号会保留在显示名中用于区分副本。

### 2. 全局「模型存放目录」

设置面板（「操作按钮」之后、「外部模型文件夹」之前）新增「模型存放目录」区块：

- 未设置时显示「默认（程序目录 models/）」，按钮为「选择模型存放目录」；已设置时显示完整路径（悬停可看全文），按钮变为「更改模型存放目录」并出现「恢复默认」。
- 设置后导入落点为 `<模型存放目录>/<基本模型名>/`；未设置时回落到 **exe 同级 `models/`**。
- 配置写入 `config.json` 的 `importRoot` 字段（与 `externalModels` 互不覆盖），重启后保持。
- 「恢复默认」只清空配置，**不删除、不迁移**任何已存在的模型。
- 目标目录无法创建/写入时，面板显示失败原因，配置保持原样，**不静默回退**到其它目录。
- 该能力**仅 Tauri 外壳可用**：Electron / 浏览器直开时 `bridge.capabilities.importRoot` 为 `false`，两个按钮置灰并提示「当前外壳不支持设置模型存放目录」。
- 模型存放目录下的模型与「外部模型文件夹」语义不同：前者由应用管理、可删除；后者显示「外源」徽标、不可删除。

### 3. 单窗口多模型同显

- 同一窗口内最多同时显示 **6** 个模型实例；达到上限时新增会被拒绝并提示「最多同时显示 6 个模型」。
- 模型列表每条右侧有「＋」按钮（悬停提示「以新实例显示（最多 6 个）」）：点击**新增**一个实例，不替换已有实例；直接点击列表条目仍是「切换模型」= **替换活动实例**的模型。
- 设置面板「已显示模型」区块显示 `n/6` 计数、活动实例高亮；点击条目切换活动实例；移除按钮为两段式（先变「确认移除」，3 秒内再点生效），**仅从窗口移除，不删除模型文件**。
- **位置独立**：每个实例各自记录窗口内坐标，拖拽只移动被拖拽的实例，松手后位置写回 `localStorage`（节流 200ms），重启按原位置恢复；越界位置会被夹取到窗口内。
- **全局设置**：缩放百分比与透明度对所有实例同时生效。
- **命中判定**：重叠区域以**最上层**（后创建的实例）为准；视线跟随对所有可见实例生效；实例全部移除或未加载时不抛错。
- 实例标识形如 `inst-<n>`，**单调分配、删除后不复用**，避免位置记录串到新实例。

### 4. 全屏雨效

- 设置面板「缩放」之后、「模型列表」之前新增「全屏下雨」区块：开关 + 「雨量档位」（**小雨 / 中雨 / 大雨 / 雷雨**）+ 「雨声音效」开关。
- **关闭下雨时，档位与音效选项折叠收起**（不可见、不可操作）；重新开启恢复上次档位。
- 四个档位在雨滴密度、下落速度/长度与音量上递增；**雷雨**档每 6–14 秒（源码随机区间）出现一次全屏白闪，音效开启时同时播放雷声。
- **音效可独立开关**：关闭音效后雨仍正常渲染；音频按 `ogg → mp3 → wav` 顺序探测实际存在的文件。
- 雨层是独立 canvas `#pet-rain-canvas`（`position: fixed`、`pointer-events: none`、`z-index: 9997`）：
  覆盖整个窗口、位于模型之上 / 设置面板之下，**不拦截鼠标**，空白处点击仍穿透到桌面。
- 性能相关：绘制按 36ms 门控（约 27fps），DPR 上限 1.75，仅用 2D 线段，不使用 `shadowBlur`/滤镜。
- 若系统启用 `prefers-reduced-motion: reduce`，雨效视为关闭：不启动绘制、也不播放音频。
- 关闭雨效时停止绘制、清空画布并停止音频；切到后台标签页（`document.hidden`）时暂停绘制。
- 首次 `play()` 被浏览器/WebView 自动播放策略拒绝时会标记为 blocked，并在**首次用户手势**后重试；雨渲染不等待手势。
- 资源缺失或不可播放时**不抛错**：雨照常渲染、音频静音并在控制台告警一次。
- 默认状态（未修改过设置）：**关闭**、档位「小雨」、音效开。

#### 雨声音频资源

| 文件 | 用途 | 时长 / 格式 | 来源 / 许可 |
| --- | --- | --- | --- |
| `web/assets/audio/rain-loop.flac` | 循环雨声 | 15.00 s / 44.1 kHz 立体声 FLAC | **真实录音：Freesound `205958`（作者 bitkar）· CC0-1.0，可再分发** |
| `web/assets/audio/thunder.wav` | 雷雨档雷声 | 4.00 s / 单声道 32000 Hz 16 bit PCM | 项目内自制（`scripts/generate-rain-audio.mjs` 固定种子合成）；**CC0-1.0** |

- 雨声 `rain-loop.flac` 取自 **Freesound** 的 CC0-1.0 现场录音（<https://freesound.org/people/bitkar/sounds/205958/>），
  经截取 16.5 s、+14 dB 增益与 1.5 s 等功率交叉淡化处理为 15.00 s **无缝循环**，**不含人声/音乐**；
  许可为 **CC0-1.0（公共领域贡献宣告）**，可随本项目二进制自由再分发（无需署名）。
- 雷声 `thunder.wav` 由 `scripts/generate-rain-audio.mjs` 以固定种子程序化合成，**不含任何外部采样**，可复现（重新生成字节一致）。
- 来源、作者、许可文本、生成日期与 **SHA-256** 的完整记录见 `web/assets/audio/LICENSES.md`；
  第三方声明汇总见 `THIRD-PARTY-NOTICES.md` 的「雨声 / 雷声音效」章节。
- 音频目录位于 `web/` 之下，随 `frontendDist` 一起内嵌进单 exe，**无需额外拷贝**。

### 5. 持久化与配置一览

| 存储位置 | 键 / 字段 | 含义 |
| --- | --- | --- |
| 后端 `config.json` | `externalModels` | 「外部模型文件夹」引用列表（既有） |
| 后端 `config.json` | `importRoot` | 全局模型存放目录；缺失 = 未设置（回落到 exe 同级 `models/`） |
| `localStorage` | `pet.modelUrl` | 最后加载的模型（既有键，保留兼容） |
| `localStorage` | `pet.instances.v1` | 实例数组（`id` / 原始路径 `rawUrl` / 显示名 / `x` / `y`），顺序 = 创建顺序 |
| `localStorage` | `pet.instances.activeId` | 活动实例 id（`inst-<n>` 或空串） |
| `localStorage` | `pet.rain.enabled` / `pet.rain.level` / `pet.rain.sound` | 雨效开关 / 档位（`light`/`moderate`/`heavy`/`thunder`）/ 音效开关（另有聚合键 `pet.rain.v1` 兼容读写） |
| `localStorage` | `pet.alpha` / `pet.scalePercent` / `pet.alwaysOnTop` | 既有全局外观设置 |

> 实例持久化只保存**原始路径 `rawUrl`**，不保存 `asset://` 地址（该协议地址在重启/换会话后可能失效，加载时重新解析）。
> 所有 `localStorage` 读取均做容错：数据损坏/字段缺失时跳过该项或回落到默认值，不中断启动。

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
| （Tauri 新增）模型库 | `invoke('get_model_list')` / `invoke('import_model')` / `invoke('delete_model')` |
| （Tauri 新增）模型存放目录 | `invoke('get_import_root')` / `invoke('pick_import_root')` / `invoke('clear_import_root')`（Electron / 浏览器下 `bridge.capabilities.importRoot === false`） |
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
- **新增功能自检**：前端新增模块（`app/instances.js`、`effects/rain.js`、`ui/rainPanel.js`、
  `ui/instancePanel.js`、`ui/importRootPanel.js`）可通过复制为 `.mjs` 后 `node --check` 做语法检查；
  Rust 侧命名规则（`derive_base_model_name` / `derive_display_name` / `resolve_import_target_dir`）
  为纯函数，保留可读断言用例。
- **音频随构建内嵌**：`tauri.conf.json` 的 `build.frontendDist` 为 `../web`，
  `web/assets/audio/rain-loop.flac` 与 `thunder.wav` 位于该目录之下，构建时**随前端资源一并内嵌**，
  无需额外拷贝步骤或外部路径配置。音频来源/许可/SHA-256 见 `web/assets/audio/LICENSES.md`
  与 `THIRD-PARTY-NOTICES.md`。
- **未覆盖**：运行时行为（透明 / 穿透 / 托盘 / 多实例同显与位置恢复 / 雨效四档与音效）
  的**自动化实测**——需在真实桌面环境人工验证。

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