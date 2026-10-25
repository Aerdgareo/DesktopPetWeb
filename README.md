# DesktopPetWeb · 跨平台桌面宠物

一个基于 **Electron + Web(pixi-live2d-display)** 的桌面宠物：透明、无边框、置顶、鼠标逐区穿透，
支持 **Live2D Cubism 2 代（`.moc`）与 4 代（`.moc3`）** 模型，可视线跟随、拖拽、点击反应、待机动作，
模型可放在**外部文件夹**随时增删。

跨平台支持 **Windows / Linux / macOS**；就绪包（各平台**安装包** + **模型安装包**）见顶部 [Releases](https://github.com/Aerdgareo/DesktopPetWeb/releases)，**下载即用**。

> 为什么用 Web 而不是 Unity：Unity 的 Cubism SDK 5 **不支持 Cubism 2 代模型**；
> 而 `pixi-live2d-display` **一套代码同时支持 2 代与 4 代**。

---

## 食用发行版（普通用户）

> 只想直接使用桌宠、不涉及开发——看这一节就够了。

### 下载与安装

到本仓库 **[Releases](https://github.com/Aerdgareo/DesktopPetWeb/releases)** 页面下载对应平台安装包，**无需任何开发环境**：

| 平台 | 安装包 | 使用方式 |
|---|---|---|
| Windows（x64） | `DesktopPetLite.Setup.x.y.z.x64.exe`（NSIS） | 64 位 Windows 10/11（主流）；双击安装，默认装到 `D:\DesktopPet` |
| Windows（x86） | `DesktopPetLite.Setup.x.y.z.x86.exe`（NSIS） | 32 位 Windows（老设备） |
| Linux | `DesktopPetWeb-x.y.z.AppImage` / `desktop-pet-web_x.y.z_amd64.deb` | AppImage：`chmod +x` 后直接运行；deb：`sudo dpkg -i xxx.deb` |
| macOS（Apple 芯片） | `DesktopPetWeb-x.y.z-arm64.dmg` | 打开 dmg，将 App 拖入「应用程序」 |
| macOS（Intel） | `DesktopPetWeb-x.y.z.dmg` | 同上 |

> 同一个 Release 还附带**模型安装包 `DesktopPetModels-Setup.exe`**（内含一批 Live2D 模型）。

### 获取模型（来自 `DesktopPetModels-Setup.exe`）

- **Windows**：直接双击 `DesktopPetModels-Setup.exe` 安装，按向导把模型安装到目标目录（默认安装到程序目录外部的 `models/`）。
- **Linux / macOS**：**无需安装，用压缩软件（如 7-Zip / Keka / 归档实用工具）直接打开 `DesktopPetModels-Setup.exe`，从中提取 `model` 相关文件即可**——该安装包本质是可解压的归档，提取出的模型目录即可直接使用。

### 加载模型

启动应用后，打开**设置面板 →「外部模型文件夹」**，选择存放模型的目录（可添加多个，增删即时生效）即可显示模型。
模型入口为 `.model3.json`（Cubism 4）或 `.model.json`（Cubism 2）；未声明动作/表情时会自动扫描目录补齐。

### 常见问题（FAQ）
- **怎么换 / 加模型？** 主程序只内置「肥牛」一个模型；打开桌宠「设置」面板 →「外部模型文件夹」选择模型目录（可添加多个）即可，增删即时生效。
- **支持哪些模型？** Live2D **Cubism 2 代（`.moc`）与 4 代（`.moc3`）**，自动识别。
- **装哪个版本？** Windows 有 **x64（主流）** 与 **x86（32 位系统）**；Linux 用 AppImage/deb；macOS 按芯片选 `arm64` / `x64` dmg。
- **卸载后会残留吗？** 主程序卸载会一并清理其安装目录下的 `models`。
- **模型版权？** 随仓库/模型安装包附带的模型**版权归各自原作者**，详见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

---

## 源码版（开发者）

> 想从源码构建、二次开发或自行打包——看这一节。普通用户无需阅读。

### 环境要求
- Node.js ≥ 18（推荐 20），npm
- 无需联网运行（运行时库已本地化到 `web/vendor/`）

### 首次准备：拉取运行时库（Live2D 内核）
本仓库**不随附** Live2D Cubism 内核（专有许可，见 `THIRD-PARTY-NOTICES.md`）。首次开发/构建前执行：
```bash
npm run fetch-vendor      # 下载 live2dcubismcore.min.js / live2d.min.js 到 web/vendor/
```
（`pixi.min.js`、`pixi-live2d-display.min.js` 为 MIT，已随仓库提供。）

### 本地开发运行
```bash
npm install
npm start
```
> 若终端设置了 `ELECTRON_RUN_AS_NODE`，请先清除：`env -u ELECTRON_RUN_AS_NODE npm start`

### 打包
```bash
npm run dist                 # 当前平台
npx electron-builder --win   # Windows (nsis)
npx electron-builder --linux AppImage deb
npx electron-builder --mac dmg      # 需在 macOS 上执行
```
> **跨平台注意**：本发布仓库的 `package.json` **已移除** `build.electronDist`（该离线构建项仅保留在开发仓库 `DesktopPetWeb` 中）。
> 如需在本机进行离线 Windows 构建，请在开发仓库 `DesktopPetWeb` 中操作；本仓库 CI（见 `.github/workflows/build.yml`）由 electron-builder 自行下载对应平台的 Electron，**无需**该配置项。
> macOS 安装包（dmg）**必须在 macOS 上**构建（签名/证书），Windows 无法交叉构建。

---

## 功能特性
- 透明 / 无边框 / 置顶窗口；**鼠标逐区穿透**（仅人物与设置面板上可点，其余点击穿透到桌面）
- **同时支持 Cubism 2 代与 4 代**模型，自动识别
- 视线跟随（以人物**头部**为参照中心）、拖拽（仅命中模型本体）、点击反应（表情/动作）
- 待机动作（未声明动作时**扫描目录**自动补齐）
- **外部模型文件夹**：可添加**多个**外部目录，不改程序即可加载任意磁盘位置的模型
- 设置面板：缩放（10%–300%）、模型切换、表情/动作选择、置顶/穿透、导入模型、退出
- 系统托盘：显示/隐藏、置顶、开机自启、退出
- Windows 安装器：默认安装到 `D:\DesktopPet`；模型可提取到**安装目录外部 `models/`** 便于增删

## 模型
本仓库**随附一组角色模型**（位于 `web/models/`，共 24 个，已在 `web/models/models.json` 登记；**版权归各自原作者**，许可与再分发要求详见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)）。此外仍可通过应用内「外部模型文件夹」加载任意磁盘位置的模型。

- **内置位置**：`web/models/<名称>-cubism<2|4>/`（由 `models.json` 登记）
- **外部模型文件夹**：应用内「设置 → 外部模型文件夹」可选择任意磁盘目录（可多个），增删即时生效
- **模型入口**：`.model3.json`（Cubism 4）或 `.model.json`（Cubism 2）；未声明动作/表情时会自动扫描目录补齐

## 许可与第三方
- 本仓库**源码**：**GPL-3.0-or-later**（GNU General Public License v3.0 or later，见 [`LICENSE`](LICENSE)）
- 依据 GPLv3，**分发二进制（安装包）须同时提供对应源码**（详见下方「发布」一节的说明）
- 运行依赖/素材：**不受 GPL-3.0-or-later 约束**，务必阅读 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)
  - **Live2D Cubism Core / Cubism 2 Core**：Live2D **专有许可**
  - **Live2D 示例模型**（如 shizuku/haru）：Live2D 示例模型条款，**再分发受限**
  - **用户导入的角色模型**：版权归原作者，请勿提交到公开仓库（本仓库已 `.gitignore` 排除）
- 其他开源依赖：Electron(MIT)、pixi.js(MIT)、pixi-live2d-display(MIT)

## 发布（GitHub Releases）
1. 打 tag 并推送：`git tag v1.0.0 && git push origin v1.0.0`
2. `.github/workflows/build.yml` 会在 **Windows / macOS / Linux** 三平台矩阵构建，并自动创建 Release 并附上安装包
3. 也可手动触发工作流（Actions → build → Run workflow）
4. **GPLv3 合规——分发二进制须提供对应源码**：本项目以 **GPL-3.0-or-later** 授权，当你通过 GitHub Releases 分发安装包（二进制）时，**必须同时提供对应的完整源码**。
   - 源码获取位置：`https://github.com/Aerdgareo/DesktopPetWeb`。请在每个 Release 说明中给出该链接，并保证 tag 与安装包版本一致（如 `git tag v1.0.0` ↔ Release `v1.0.0`），即为“对应源码”。
   - 也可随 Release 附上对应版本的源码归档（GitHub 自动生成的 `Source code (zip/tar.gz)`），以满足 GPLv3 第 6 条的源码提供义务。

## 致谢
- [Live2D Cubism](https://www.live2d.com/) · [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) · [PixiJS](https://pixijs.com/) · [Electron](https://www.electronjs.org/)
- [Cutiei/-live2d](https://github.com/Cutiei/-live2d) —— 感谢其提供的 Live2D 相关资源 / 模型支持- [morettt/my-neuro](https://github.com/morettt/my-neuro) —— 感谢其提供的相关资源 / 模型支持
- **玄宝酱**（B 站）：[space.bilibili.com/131661224](https://space.bilibili.com/131661224) —— 感谢其提供的角色模型