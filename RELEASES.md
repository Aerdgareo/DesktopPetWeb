# 版本与产物（Releases）

本文件汇总各版本的**源码**与**发行产物**，便于对照下载与合规核对。

---

## v1.0.0

- **Release 页**：https://github.com/Aerdgareo/DesktopPetWeb/releases/tag/v1.0.0
- **源码**
  - Git tag：`v1.0.0`
  - 对应提交：`27889cf`（含 lite 打包配置与 macOS `arm64+x64` 交叉构建）
  - GitHub 自动附带源码归档：`Source code (zip)` / `Source code (tar.gz)`
  - 许可：**GPL-3.0-or-later**（按 GPLv3，分发二进制须同时提供对应源码）
- **发行产物（7 个附件）**

  | 平台 | 文件 | 大小（字节） | 说明 |
  |---|---|---:|---|
  | Windows · x64 | `DesktopPetLite.Setup.1.0.0.x64.exe` | 83,196,672 | NSIS 安装器（lite，外部 `models/` 仅「肥牛」） |
  | Windows · x86（32 位） | `DesktopPetLite.Setup.1.0.0.x86.exe` | 78,097,431 | NSIS 安装器（lite，32 位系统） |
  | Linux | `DesktopPetWeb-1.0.0.AppImage` | 112,053,654 | AppImage（lite） |
  | Linux | `desktop-pet-web_1.0.0_amd64.deb` | 79,117,086 | deb（lite） |
  | macOS · Apple Silicon | `DesktopPetWeb-1.0.0-arm64.dmg` | 101,230,411 | arm64 dmg（lite） |
  | macOS · Intel | `DesktopPetWeb-1.0.0.dmg` | 107,270,565 | x64 dmg（lite） |
  | 模型包 | `DesktopPetModels-Setup.exe` | 189,483,408 | 含 24 个 Live2D 模型，**手动上传**到同一 Release |

- **构建方式**
  - Linux / macOS：GitHub Actions CI 构建（macOS 一次出 **arm64 + x64** 两个架构）
  - Windows：CI 的 `windows` job 目前失败 → 由**本机**构建后手动上传（`dist-slim/DesktopPetLite Setup 1.0.0.exe`）
  - 模型包：不进仓库、不在 CI 构建，人工上传
- **发布形态**：**同一次 Release 承载「主程序安装包 + 模型安装包」**（详见 `.github/RELEASE.md`）

---

## 发布约定（后续版本）

1. 打 tag 触发 CI：`git tag vX.Y.Z && git push origin vX.Y.Z`
2. CI 产物：Windows NSIS / Linux AppImage+deb / macOS dmg（arm64 + x64）
3. 模型包 `DesktopPetModels-Setup.exe` 由人工上传到**同一个** Release
4. 在本文件顶部**追加**新版本小节，记录「源码 tag/commit + 产物清单 + 大小」