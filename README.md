# DesktopPetWeb · 跨平台桌面宠物

一个基于 **Electron + Web(pixi-live2d-display)** 的桌面宠物：透明、无边框、置顶、鼠标逐区穿透，
支持 **Live2D Cubism 2 代（`.moc`）与 4 代（`.moc3`）** 模型，可视线跟随、拖拽、点击反应、待机动作，
模型可放在**外部文件夹**随时增删。

> 为什么用 Web 而不是 Unity：Unity 的 Cubism SDK 5 **不支持 Cubism 2 代模型**；
> 而 `pixi-live2d-display` **一套代码同时支持 2 代与 4 代**。

## 功能特性
- 透明 / 无边框 / 置顶窗口；**鼠标逐区穿透**（仅人物与设置面板上可点，其余点击穿透到桌面）
- **同时支持 Cubism 2 代与 4 代**模型，自动识别
- 视线跟随（以人物**头部**为参照中心）、拖拽（仅命中模型本体）、点击反应（表情/动作）
- 待机动作（未声明动作时**扫描目录**自动补齐）
- **外部模型文件夹**：可添加**多个**外部目录，不改程序即可加载任意磁盘位置的模型
- 设置面板：缩放（10%–300%）、模型切换、表情/动作选择、置顶/穿透、导入模型、退出
- 系统托盘：显示/隐藏、置顶、开机自启、退出
- Windows 安装器：默认安装到 `D:\DesktopPet`；模型可提取到**安装目录外部 `models/`** 便于增删

## 环境要求
- Node.js ≥ 18（推荐 20），npm
- 无需联网运行（运行时库已本地化到 `web/vendor/`）

## 首次准备：拉取运行时库（Live2D 内核）
本仓库**不随附** Live2D Cubism 内核（专有许可，见 `THIRD-PARTY-NOTICES.md`）。首次开发/构建前执行：
```bash
npm run fetch-vendor      # 下载 live2dcubismcore.min.js / live2d.min.js 到 web/vendor/
```
（`pixi.min.js`、`pixi-live2d-display.min.js` 为 MIT，已随仓库提供。）

## 模型
本仓库**不随附任何第三方角色模型**。请把模型放入 `web/models/<名称>-cubism<2|4>/` 并在
`web/models/models.json` 登记，或直接在应用内使用「外部模型文件夹」。

## 本地开发运行
```bash
npm install
npm start
```
> 若终端设置了 `ELECTRON_RUN_AS_NODE`，请先清除：`env -u ELECTRON_RUN_AS_NODE npm start`

## 打包
```bash
npm run dist                 # 当前平台
npx electron-builder --win   # Windows (nsis)
npx electron-builder --linux AppImage deb
npx electron-builder --mac dmg      # 需在 macOS 上执行
```
> **跨平台注意**：`package.json` 里的 `build.electronDist` 指向本机 Windows 版 Electron（用于离线 Windows 构建）；
> 在 CI/非 Windows 平台构建时请**移除**该项，让 electron-builder 下载对应平台的 Electron（见 `.github/workflows/build.yml`）。
> macOS 安装包（dmg）**必须在 macOS 上**构建（签名/证书），Windows 无法交叉构建。

## 模型
- 内置位置：`web/models/<名称>-cubism<2|4>/`（由 `models.json` 登记）
- **外部模型文件夹**：应用内「设置 → 外部模型文件夹」可选择任意磁盘目录（可多个），增删即时生效
- 模型入口：`.model3.json`（Cubism 4）或 `.model.json`（Cubism 2）；未声明动作/表情时会自动扫描目录补齐

## 许可与第三方
- 本仓库**源码**：**MIT**（见 [`LICENSE`](LICENSE)）
- 运行依赖/素材：**不适用 MIT**，务必阅读 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)
  - **Live2D Cubism Core / Cubism 2 Core**：Live2D **专有许可**
  - **Live2D 示例模型**（如 shizuku/haru）：Live2D 示例模型条款，**再分发受限**
  - **用户导入的角色模型**：版权归原作者，请勿提交到公开仓库（本仓库已 `.gitignore` 排除）
- 其他开源依赖：Electron(MIT)、pixi.js(MIT)、pixi-live2d-display(MIT)

## 发布（GitHub Releases）
1. 打 tag 并推送：`git tag v1.0.0 && git push origin v1.0.0`
2. `.github/workflows/build.yml` 会在 **Windows / macOS / Linux** 三平台矩阵构建，并自动创建 Release 并附上安装包
3. 也可手动触发工作流（Actions → build → Run workflow）

## 致谢
- [Live2D Cubism](https://www.live2d.com/) · [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) · [PixiJS](https://pixijs.com/) · [Electron](https://www.electronjs.org/)