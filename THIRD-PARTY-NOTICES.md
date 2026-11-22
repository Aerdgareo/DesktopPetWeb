# 第三方组件与素材声明（Third-Party Notices）

> 本文件对应 **`tauri` 分支**（Tauri v2 单 exe 绿色版，仅 Windows）。
> 本分支下 `web/vendor/live2d.min.js`、`web/vendor/live2dcubismcore.min.js`（Live2D 内核）**不入库**，
> 由 `npm run fetch-vendor`（`scripts/fetch-vendor.mjs`）按需拉取；本分支仅随附 `肥牛-cubism4` 一个角色模型。
> 其余条款与主仓库一致。

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

## 5. 雨声 / 雷声音效（`web/assets/audio/`，**两个文件均为 CC0-1.0，可自由再分发**）
- 文件：
  - `web/assets/audio/rain-loop.flac` —— 全屏雨效的**循环雨声**（15.00 s，44.1 kHz 立体声 FLAC，863,830 字节）
  - `web/assets/audio/thunder.wav` —— 雷雨档的**雷声**（4.00 s，单声道 32000 Hz 16 bit PCM，256,044 字节）
- **`rain-loop.flac`：真实录音，CC0-1.0**
  - **来源**：Freesound 素材 `rain_18_20_16.wav`（sound id `205958`）——
    <https://freesound.org/people/bitkar/sounds/205958/>
    下载直链为 Freesound 官方 HQ 预览 `205958_3358948-hq.mp3`
    （<https://cdn.freesound.org/previews/205/205958_3358948-hq.mp3>，44.1 kHz / 立体声 / MP3）；
    预览仅为母素材的降质编码版本，母素材本体许可即 **CC0-1.0**，故预览及其衍生片段同属 CC0-1.0。
  - **作者**：**bitkar**（Freesound 用户；CC0-1.0 **不强制署名**，此处仅为善意的来源标注）。
  - **许可**：**CC0-1.0**（Creative Commons Zero 1.0 Universal，公共领域贡献宣告）
    <https://creativecommons.org/publicdomain/zero/1.0/legalcode.zh-Hans>；
    任何人可无条件使用、修改、商用与再分发，**无需署名**。
  - **处理**：从原素材 78.762 s 中截取 **20.000–36.500 s**（16.5 s，该段响度范围仅 1.7 LU，
    无爆音/静音/人声/交通事件）→ **+14 dB** 增益（母录音 `-49.6 LUFS`，成品 `-35.5 LUFS`）
    → **1.5 s 等功率（sin/cos）交叉淡化** → 15.000 s **无缝循环** → FLAC 44.1 kHz / 立体声 / 16 bit。
  - 该文件为**真实环境录音**，**不含人声、音乐或任何未经授权的第三方作品音轨**。
- **`thunder.wav`：项目内自制，CC0-1.0**
  - **来源**：无外部来源，由 `scripts/generate-rain-audio.mjs`（Node，无第三方依赖，固定随机种子
    `0x7e3b9f21`）程序化合成，**不包含任何外部采样、循环包或第三方录音片段**。
  - **作者**：DesktopPetTauri 项目组（本项目自行合成）。
  - **许可**：**CC0-1.0**（CC0 1.0 Universal，公共领域贡献宣告）
    <https://creativecommons.org/publicdomain/zero/1.0/legalcode.zh-Hans>；
    本项目据此放弃对该文件的全部著作权及相关邻接权，任何人可无条件使用、修改与再分发。
  - **生成日期**：2026-11-22（未从网络下载，因此无"下载日期"）。
- **SHA-256**（实算值，用于核对发布物与再生成结果）：

  | 文件 | SHA-256 | 许可 / 可再分发 |
  | --- | --- | --- |
  | `rain-loop.flac` | `ed56ac2723c6337943ff4a044cc7b793ef74a706f05e7eca2fe86fdb2bb1fcc4` | CC0-1.0 —— **是** |
  | `thunder.wav` | `105fba55e52c99930ed440591d3e9cf6f4c546249ba5f6e3c27bd47369b95f15` | CC0-1.0 —— 是 |

- **再分发声明**：
  - `thunder.wav`：允许在 **GPL-3.0-or-later** 项目中随二进制再分发（CC0-1.0 无附加条件，
    与本项目自身源码的 GPL-3.0-or-later 兼容，不构成额外限制）。
  - `rain-loop.flac`：**允许再分发**。素材为 CC0-1.0（公共领域贡献宣告），
    不保留署名、商用或衍生限制，可随本项目二进制/安装包自由分发。
- **复现与校验**：

  ```bash
  # 校验现有文件（rain-loop.flac 由 CC0 录音裁剪，无法字节级复现；thunder.wav 可复现）
  sha256sum web/assets/audio/rain-loop.flac web/assets/audio/thunder.wav

  # 重新生成雷声（固定种子 → 字节与上表 SHA-256 一致）
  node scripts/generate-rain-audio.mjs --only thunder

  # 如需重新处理雨声：从上面的 Freesound CDN 直链下载后按 LICENSES.md §1「处理流程」裁剪
  ```

- **完整记录**：文件名、来源、作者、许可文本、获取/生成日期、SHA-256、再分发声明与技术参数
  的逐文件记录见 `web/assets/audio/LICENSES.md`；如替换音频，须同步更新该文件与本节的 SHA-256。
- **打包方式**：音频位于 `web/` 之下，随 Tauri 的 `frontendDist`（`../web`）内嵌进单 exe，
  无需额外分发文件；两份音频均为 CC0-1.0，可随发布出来的单 exe 自由分发。

## 建议做法（公开发行前）
1. 本仓库**随附**角色模型（`web/models/`）与源码；`web/vendor/*` 的 Live2D Core 仍由 `npm run fetch-vendor` 拉取、**不入库**。
   - 随附模型为「按原样」提供，版权归各自原作者，本项目不对其授权作任何担保；如你在自己的分支再发布，请自行评估并遵守各模型许可（见第 2 节）。
   - 离线运行所需的 Live2D Core 请自行拉取，并**同时**附上 Live2D 的许可文件与标识声明。
2. 将可执行安装包（Windows/macOS/Linux）放到 **GitHub Releases**，不要提交进 Git 历史；
   - **GPLv3 合规**：随 Release **同时提供对应源码**（给出源码仓库链接，或附上对应版本的源码归档），以满足“分发二进制须提供对应源码”的义务。
3. 在 README 的「致谢 / Credits」中列出 Live2D、Electron、PixiJS 及模型作者。