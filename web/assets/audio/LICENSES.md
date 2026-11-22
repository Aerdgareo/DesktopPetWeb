# 音频资源许可与来源（web/assets/audio）

本目录存放「全屏下雨」特效所需的雨声与雷声音频（契约 `C-RAIN-AUDIO@1`）。
当前只有两个文件，**许可状况完全不同**，请务必分别看待：

| 文件 | 用途 | 来源 | 许可 | 可再分发 |
| --- | --- | --- | --- | --- |
| `rain-loop.flac` | 循环雨声 | 外部素材（视频音轨提取） | **未知 / 非 CC0** | **否（有版权风险）** |
| `thunder.wav` | 雷雨档雷声 | 项目内程序化生成 | CC0-1.0 | 是 |

> ⚠️ **重要提醒**：`rain-loop.flac` **不是** CC0，也不是公共领域素材。
> 它来自第三方视频作品的音轨，**本项目未取得任何再分发授权**。
> 若你要公开发布或再分发本仓库的二进制/资源，**必须先移除或替换 `rain-loop.flac`**，
> 否则可能构成对原作品权利人的侵权。

---

## 1. rain-loop.flac（**外部来源，非 CC0，不可再分发**）

- **文件名**：`web/assets/audio/rain-loop.flac`
- **来源**：从 Windows 桌面美化工程 **WE（Wallpaper Engine）**的主题素材中提取。
  - 具体来源视频：`devushka-zasypaet-u-okna_…/窗外下着雨.mp4`
    （WE 主题包内文件；主题归类为 **VSTHEMES**）
  - 提取方式：取该 mp4 的音轨，转封装/编码为 FLAC（无损压缩），再裁剪为可循环的 30 s 片段。
- **作者**：**未知**（无法确认该视频/音轨的原始作者与授权状态；未取得原作者书面许可）。
- **许可**：**未知**。**不适用 CC0 / CC-BY / 公共领域**。
  - 本项目**不授予**该文件任何使用、修改或再分发权利，也无法代表权利人授予。
- **再分发风险**：**高**。该音频源自第三方作品，随本项目（GPL-3.0-or-later）的二进制一并分发
  **可能侵犯原作品权利人的著作权/邻接权**。
  - **强烈建议**：**仅限个人自用**（本地编译、本地运行）；公开发布前请删除本文件并改用
    可确认 CC0/PD 或已获授权的替代素材（见下文「替代方案」）。
- **获取日期**：2026-11-22（自本地 WE 主题工程提取，非从本项目官方渠道下载）。
- **SHA-256**：`181ac8801e330aa45d203fdf9dec9ae7aa119a48750693e049ee4ee973664150`
- **技术参数**：FLAC / 44.1 kHz / 立体声（2 ch）/ 时长 30.00 s / 2,496,309 字节
- **循环说明**：已按 30 s 截取，播放端以 `loop` 属性循环；接缝处未做额外的交叉淡化处理，
  长时间播放可能出现轻微不连续感。

### 替代方案（公开发行前）

1. 使用可确认 **CC0-1.0 / Public Domain** 的雨声录音（需保留来源与许可证据）；
2. 或运行仓库内生成脚本重新合成雨声（`node scripts/generate-rain-audio.mjs --only rain`），
   产物为自制 CC0-1.0 的 `rain-loop.wav`（注意：`.flac` 若仍存在会被优先探测，
   因此替换时需**同时删除** `rain-loop.flac`）；
3. 替换后请同步更新本文件、`THIRD-PARTY-NOTICES.md` 第 5 节以及 README 中的音频说明。

---

## 2. thunder.wav（**项目内自制，CC0-1.0**）

- **文件名**：`web/assets/audio/thunder.wav`
- **来源 URL**：无外部来源（项目内程序化生成；生成器 `scripts/generate-rain-audio.mjs`）
- **作者**：DesktopPetTauri 项目组（本项目自行合成）
- **许可**：CC0-1.0
- **许可文本**：CC0 1.0 Universal（公共领域贡献宣告）全文见
  <https://creativecommons.org/publicdomain/zero/1.0/legalcode.zh-Hans>；
  本项目据此放弃对该音频的全部著作权及相关邻接权，任何人可无条件使用、修改与再分发。
- **下载日期**：不适用（本文件未从网络下载）；**生成日期**：2026-11-22
- **SHA-256**：`105fba55e52c99930ed440591d3e9cf6f4c546249ba5f6e3c27bd47369b95f15`
- **再分发声明**：允许在 GPL-3.0-or-later 项目中随二进制再分发（CC0 无附加条件）。
- **技术参数**：单声道 / 32000 Hz / 16 bit PCM / 256,044 字节 / 时长 4.00 s / 峰值 0.85
- **合成方式**：白噪声经时变二阶低通（1200 Hz → 120 Hz）做雷声主体，
  叠加 38/57/83 Hz 低频隆隆与 4 段滚雷次爆，主爆包络为 5 ms 起音 + 指数衰减，单次触发不叠加。

> 该文件为固定种子（`0x7e3b9f21`）程序化合成，重跑脚本应得到**字节完全一致**的产物，
> 因此上表 SHA-256 可被第三方独立校验。

---

## 复现与校验

```bash
# 校验现有文件的 SHA-256（Windows Git Bash 下）
sha256sum web/assets/audio/rain-loop.flac web/assets/audio/thunder.wav

# 重新生成雷声（覆盖 thunder.wav，字节与上表 SHA-256 一致）
node scripts/generate-rain-audio.mjs --only thunder

# 生成自制 CC0 雨声（rain-loop.wav；如需使用请先删除 rain-loop.flac）
node scripts/generate-rain-audio.mjs --only rain
```

> 注意：`rain-loop.flac` **无法**由脚本复现（外部素材），只有 `thunder.wav` 属于可复现产物。

## 编码约定

- 播放端按 `ogg → mp3 → flac → wav` 顺序探测（`web/src/effects/rain.js` 常量 `AUDIO_EXTS`）。
  当前目录提供 `rain-loop.flac`（命中第 3 个候选）与 `thunder.wav`（命中第 4 个候选）。
- 若后续新增更小体积的 `.ogg`/`.mp3` 同名文件，会被**优先**探测并覆盖当前效果，无需改代码，
  但须同步更新本文件。
- 建议指标（替换素材时参照）：雨声 ≥ 8 s 可无缝循环、体积 ≤ 1.5 MB；雷声单次 ≤ 5 s、体积 ≤ 1 MB。
  当前 `rain-loop.flac` 体积约 2.38 MB，**超出**上述体积建议值（FLAC 无损编码所致）。