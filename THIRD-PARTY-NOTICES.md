# 第三方组件与素材声明（Third-Party Notices）

本仓库源码（`electron/`、`web/src/` 等）以 **MIT** 授权（见 `LICENSE`）。
但本项目**运行与展示依赖以下第三方组件/素材**，它们**不适用 MIT**，各自遵循其原始许可。
分发（尤其是打包发行版）时请**保留**这些声明，并遵守各自条款。

## 1. Live2D Cubism 运行库（**专有许可，务必阅读**）
- `web/vendor/live2dcubismcore.min.js` —— **Live2D Cubism Core（Cubism 4/5）**
- `web/vendor/live2d.min.js` —— **Live2D Cubism 2.1 Core**
- 许可：Live2D Cubism SDK 的**专有许可**（Live2D Proprietary Software License Agreement）。
  - 使用/再分发前须**同意并遵守** Live2D 的 SDK 许可与「标识显示」等要求：
    - 官网：https://www.live2d.com/  「SDK 许可 / License」
    - 建议在「关于/设置」界面或 README 中标注 Live2D 标识与版权声明。
  - **不建议**把 `live2dcubismcore.min.js` / `live2d.min.js` 视为"可自由再分发的开源文件"；若你要公开发行，请自行确认已满足 Live2D 的许可要求。

## 2. Live2D 官方示例模型（若有随仓库分发）
- 目录：`web/models/shizuku/`（Cubism 2.1 示例）、`web/models/haru/`（Cubism 4 示例）
- 来源：Live2D 官方示例模型（经 `pixi-live2d-display` 仓库测试素材获取）。
- 许可：**Live2D 示例模型使用条款**（Sample Model Terms）。示例模型通常**仅允许在遵守其条款的前提下**用于评估/演示；**再分发存在限制**。
- 建议：开源仓库中**不要内置**示例模型；改为在 Release/文档中给出官方下载链接，由用户自行获取。

## 3. 用户导入的角色模型（`web/models/*-cubism2|cubism4/*`）
- 由用户自行导入的角色模型**版权归其各自作者/发行方**，可能有严格的使用与再分发限制。
- **切勿**将他人拥有版权的模型提交到公开仓库。建议：
  - 用 `.gitignore` 排除个人导入模型（本仓库已可这么配置）；
  - 发行版中**不要预置**这些模型；改由「模型安装包」由用户自行导入。

## 4. 前端/运行时依赖（开源）
| 组件 | 许可 | 说明 |
|---|---|---|
| Electron | MIT | 桌面外壳运行时 |
| pixi.js 6.5.x | MIT | 2D 渲染引擎 |
| pixi-live2d-display 0.4.0 | MIT | Live2D 的 Pixi 适配层（含 Cubism2 兼容） |
| electron-builder | MIT | 打包工具（仅开发期） |

> 上述开源依赖的完整许可文本随其发行包提供（如 `LICENSES.chromium.html`、`LICENSE.electron.txt` 等）。

## 建议做法（公开发行前）
1. 仓库中**只保留源码 + 构建脚本**，**不内置**第三方 Core（`web/vendor/*` 视情况）与任何**未获授权**的模型；
   - 若必须内置 Live2D Core 以便离线运行，请**同时**附上 Live2D 的许可文件与标识声明。
2. 将可执行安装包（Windows/macOS/Linux）放到 **GitHub Releases**，不要提交进 Git 历史。
3. 在 README 的「致谢 / Credits」中列出 Live2D、Electron、PixiJS 及模型作者。