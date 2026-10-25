# 第三方组件与素材声明（Third-Party Notices）

本仓库源码（`electron/`、`web/src/` 等）以 **GPL-3.0-or-later**（GNU General Public License v3.0 or later）授权（见 `LICENSE`）。
但本项目**运行与展示依赖以下第三方组件/素材**，它们**不受 GPL-3.0-or-later 约束**，各自遵循其原始许可。
分发（尤其是打包发行版）时请**保留**这些声明，并遵守各自条款。

## 本项目自身源码的许可与分发义务（GPL-3.0-or-later）
- 本仓库**自身源码**（`electron/`、`web/src/` 等，**不含**下列第三方组件/素材）以 **GPL-3.0-or-later**（GNU General Public License v3.0 or later）授权，全文见 `LICENSE`。
- **分发二进制（安装包）须同时提供对应源码**：依据 GPLv3 第 3 条与第 6 条，当你以安装包、可执行文件等形式分发本项目（即“传达”目标代码）时，**必须一并提供其完整的“对应源码”（Corresponding Source）**，或以 GPLv3 允许的书面承诺方式提供之。
- **源码获取位置**：`https://github.com/Aerdgareo/DesktopPetWeb`。请在 Release 说明或安装包随附文档中给出该链接（或 `git clone` 地址），确保接收者能取得与二进制版本完全对应的源码。
- 上述分发义务**仅适用于本项目自身源码**；下列第三方组件/素材仍各自遵循其原始许可。

## 1. Live2D Cubism 运行库（**专有许可，务必阅读**）
- `web/vendor/live2dcubismcore.min.js` —— **Live2D Cubism Core（Cubism 4/5）**
- `web/vendor/live2d.min.js` —— **Live2D Cubism 2.1 Core**
- 许可：Live2D Cubism SDK 的**专有许可**（Live2D Proprietary Software License Agreement）。
  - 使用/再分发前须**同意并遵守** Live2D 的 SDK 许可与「标识显示」等要求：
    - 官网：https://www.live2d.com/  「SDK 许可 / License」
    - 建议在「关于/设置」界面或 README 中标注 Live2D 标识与版权声明。
  - **不建议**把 `live2dcubismcore.min.js` / `live2d.min.js` 视为"可自由再分发的开源文件"；若你要公开发行，请自行确认已满足 Live2D 的许可要求。

## 2. 随仓库分发的角色模型（`web/models/<名称>-cubism4/`）
- 目录：`web/models/`（共 **24 个**模型，清单见 `web/models/models.json`）。
- 版权：**归各自原作者 / 发行方所有**（其中既包含 Live2D 官方示例/授权模型，也包含第三方/个人创作的角色模型）。
- **模型来源致谢**：部分模型来自开源项目 [morettt/my-neuro](https://github.com/morettt/my-neuro) 及 B 站 UP 主 **玄宝酱**（[space.bilibili.com/131661224](https://space.bilibili.com/131661224)）。**版权归原作者**，本项目仅作开箱即用分发，特此致谢。
- 许可：**本项目不授予、也不代表原作者授予**这些模型的任何授权。各模型的使用与再分发受其**原作者条款**约束；本仓库**仅为演示与开箱即用**而随附，按「原样」（AS-IS）提供，不附带任何担保。
- 权利主张：如果你是某模型的权利人且不同意其出现在本仓库，请提交 Issue 联系我们，我们将**立即移除**相关目录。
- 建议：如对某模型许可存疑，请**不要**依赖本仓库获取该模型；改从原作者/官方渠道取得，或使用应用内「外部模型文件夹」导入你自有的模型。

## 3. 用户导入的角色模型（「外部模型文件夹」）
- 用户可通过应用内「外部模型文件夹」导入任意角色模型，其**版权归原作者/发行方**，**不由本仓库分发**，亦不受本仓库许可约束。
- 请自行确保所导入模型的使用与再分发符合其原作者条款。

## 4. 前端/运行时依赖（开源）
| 组件 | 许可 | 说明 |
|---|---|---|
| Electron | MIT | 桌面外壳运行时 |
| pixi.js 6.5.x | MIT | 2D 渲染引擎 |
| pixi-live2d-display 0.4.0 | MIT | Live2D 的 Pixi 适配层（含 Cubism2 兼容） |
| electron-builder | MIT | 打包工具（仅开发期） |

> 上述开源依赖的完整许可文本随其发行包提供（如 `LICENSES.chromium.html`、`LICENSE.electron.txt` 等）。

## 建议做法（公开发行前）
1. 本仓库**随附**角色模型（`web/models/`）与源码；`web/vendor/*` 的 Live2D Core 仍由 `npm run fetch-vendor` 拉取、**不入库**。
   - 随附模型为「按原样」提供，版权归各自原作者，本项目不对其授权作任何担保；如你在自己的分支再发布，请自行评估并遵守各模型许可（见第 2 节）。
   - 离线运行所需的 Live2D Core 请自行拉取，并**同时**附上 Live2D 的许可文件与标识声明。
2. 将可执行安装包（Windows/macOS/Linux）放到 **GitHub Releases**，不要提交进 Git 历史；
   - **GPLv3 合规**：随 Release **同时提供对应源码**（给出源码仓库链接，或附上对应版本的源码归档），以满足“分发二进制须提供对应源码”的义务。
3. 在 README 的「致谢 / Credits」中列出 Live2D、Electron、PixiJS 及模型作者。