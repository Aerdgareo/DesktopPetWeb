# 音频资源许可与来源（web/assets/audio）

本目录存放「全屏下雨」特效所需的雨声与雷声音频（契约 `C-RAIN-AUDIO@1`）。
两个文件**均为可再分发素材**（CC0-1.0），可随本项目二进制一同分发：

| 文件 | 用途 | 来源 | 许可 | 可再分发 |
| --- | --- | --- | --- | --- |
| `rain-loop.flac` | 循环雨声 | Freesound 用户 **bitkar** 的现场录音 `rain_18_20_16.wav` | **CC0-1.0** | **是** |
| `thunder.wav` | 雷雨档雷声 | 项目内程序化生成 | CC0-1.0 | 是 |

> 说明：本文件由「真实录音（CC0）+ 无损裁剪/交叉淡化」构成，**不含人声、音乐或受版权保护的
> 第三方作品音轨**。CC0-1.0 允许在无署名、无附加条件的条件下使用、修改与再分发，
> 因此可安全地随 **GPL-3.0-or-later** 的安装包/单 exe 一起发布。

---

## 1. rain-loop.flac（**真实录音，CC0-1.0，可再分发**）

- **文件名**：`web/assets/audio/rain-loop.flac`
- **来源（素材页面）**：<https://freesound.org/people/bitkar/sounds/205958/>
  - 原始文件名：`rain_18_20_16.wav`（Freesound sound id `205958`）
  - 下载用的直链（Freesound 官方 HQ 预览，44.1 kHz / 立体声 / MP3 约 222 kbit/s）：
    <https://cdn.freesound.org/previews/205/205958_3358948-hq.mp3>
  - 「预览」仅为母素材的降质编码版本，**母素材本体的许可为 CC0-1.0**，
    因此该预览及其衍生片段同样处于 CC0-1.0 之下（不产生额外署名或限制）。
- **作者**：**bitkar**（Freesound 用户主页 <https://freesound.org/people/bitkar/>）
- **许可**：**CC0-1.0**（Creative Commons Zero 1.0 Universal，公共领域贡献宣告）
  - 素材页面标注为 "Creative Commons 0"；
  - 许可正文：<https://creativecommons.org/publicdomain/zero/1.0/legalcode.zh-Hans>
  - **不要求署名**（下方署名仅出于善意标注来源，不是许可义务）。
- **获取日期**：2026-11-22（对上述 CDN 直链直接下载，未经过登录或付费墙）。
- **处理流程（可复现）**：
  1. 从原素材 **78.762 s** 中截取 **20.000 s – 36.500 s** 区间（16.5 s）——
     该区间 1 s 粒度的 RMS 波动仅 ±1.7 LU（`LRA = 1.7 LU`），无爆音、无静音、无交通/人声事件；
  2. 整体施加 **+14 dB** 数字增益（母录音电平较低，`-49.6 LUFS / 峰值 -33.4 dBFS`），
     结果为 `-35.5 LUFS / 真峰值 -22.4 dBFS`，与雷声（峰值约 -1.4 dBFS）保持合理主次关系；
  3. **等功率交叉淡化**（equal-power crossfade）：把区间**末尾 1.5 s** 与**开头 1.5 s** 以
     `sin/cos`（功率恒定）曲线叠加，得到 **15.000 s** 的无缝循环片段——
     实测循环接缝处相邻样本差 `|Δ| = 81`，小于该文件平均相邻样本差 `121`，更远小于其
     最大相邻样本差 `1595`，即**接缝处不存在咔嗒/突变**；
  4. 编码为 **FLAC / 44.1 kHz / 立体声（2 ch）/ 16 bit**（无损，`-c:a flac`）。
- **SHA-256**：`ed56ac2723c6337943ff4a044cc7b793ef74a706f05e7eca2fe86fdb2bb1fcc4`
- **技术参数**：FLAC / 44.1 kHz / 立体声 / 16 bit / 时长 15.000 s / **863,830 字节**
  - 集成响度 `-35.5 LUFS`，真峰值 `-22.4 dBFS`，响度范围 `1.7 LU`（稳定）
- **循环说明**：已完成等功率交叉淡化，播放端 `loop` 属性循环时**首尾连续**，
  长时间播放无接缝感。
- **再分发声明**：**允许**。CC0-1.0 不保留任何权利，任何人可无条件使用、修改、
  商用与再分发（含随本项目 GPL-3.0-or-later 二进制/安装包分发），无需署名。

---

## 2. thunder.wav（**项目内自制，CC0-1.0**）

- **文件名**：`web/assets/audio/thunder.wav`
- **来源 URL**：无外部来源（项目内程序化生成；生成器 `scripts/generate-rain-audio.mjs`）
- **作者**：DesktopPet 项目组（本项目自行合成）
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

> `rain-loop.flac` 由外部 CC0 录音裁剪而成，**无法**由仓库内脚本字节级复现；
> 若需完全复现，请按上文「处理流程」对同一 CDN 直链重新处理（ffmpeg 命令见下）：
> `ffmpeg -i 205958_3358948-hq.mp3 -filter_complex "<裁剪 20~36.5s → +14dB → 1.5s 等功率交叉淡化>" -ar 44100 -ac 2 -c:a flac rain-loop.flac`
> （等功率交叉淡化 = 尾部 1.5 s 乘 `cos(π·t/3)`、头部 1.5 s 乘 `sin(π·t/3)` 后相加，再与中间 13.5 s 拼接。）

## 编码约定

- 播放端按 `ogg → mp3 → flac → wav` 顺序探测（`web/src/effects/rain.js` 常量 `AUDIO_EXTS`）。
  当前目录提供 `rain-loop.flac`（命中第 3 个候选）与 `thunder.wav`（命中第 4 个候选）。
- 若后续新增更小体积的 `.ogg`/`.mp3` 同名文件，会被**优先**探测并覆盖当前效果，无需改代码，
  但须同步更新本文件。
- 建议指标（替换素材时参照）：雨声 ≥ 8 s 可无缝循环、体积 ≤ 1.5 MB；雷声单次 ≤ 5 s、体积 ≤ 1 MB。
  当前 `rain-loop.flac` 为 15.000 s / **863,830 字节（约 0.82 MB）**，**符合**上述指标；
  `thunder.wav` 为 4.00 s / 256,044 字节，符合。