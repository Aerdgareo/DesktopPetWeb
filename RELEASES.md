# 版本与产物（Releases）

本文件汇总各版本的**源码**与**发行产物**，便于对照下载与合规核对。

---

## v1.0.4

- **Release 页**：https://github.com/Aerdgareo/DesktopPetWeb/releases/tag/v1.0.4
- **源码**：Git tag `v1.0.4`（提交 `f98fdf6`）
- **发行产物（7 个附件）**

  | 平台 | 文件 | 大小（字节） | 说明 |
  |---|---|---:|---|
  | Windows · x64 | `DesktopPetWeb.Setup.1.0.4.x64.exe` | 85,954,006 | **Inno Setup**；选目录后地址栏可见补 `DesktopPet`、安装前检测旧版并询问先卸载、卸载确认杀进程 + 清残留 |
  | Windows · x86（32 位） | `DesktopPetWeb.Setup.1.0.4.x86.exe` | 81,603,807 | **Inno Setup**（同上；x64/x86 同脚本双架构产出） |
  | Linux | `DesktopPetWeb-1.0.4.AppImage` | 112,053,xxx | CI（electron-builder）；免安装 |
  | Linux | `desktop-pet-web_1.0.4_amd64.deb` | 79,2xx,xxx | CI；装到 `/opt/DesktopPetWeb` |
  | macOS · Apple Silicon | `DesktopPetWeb-1.0.4-arm64.dmg` | 101,236,366 | CI（dmg 需 macOS 构建） |
  | macOS · Intel | `DesktopPetWeb-1.0.4.dmg` | 107,263,955 | CI |
  | 模型包 | `DesktopPetModels-Setup.exe` | 191,332,063 | **Inno Setup**（重构版）；导入到主程序目录下 `models\<模型名>\` |

- **构建方式**：**Windows = Inno Setup（本机脚本 `build/inno-desktop-pet.iss`，`/D` 参数出 x64/x86）**；**Linux / macOS = CI**（`electron-builder`）。
- **本版修复/要点**：
  1. Windows 安装器改为 Inno：**选目录后地址栏可见补 `DesktopPet`**、**检测已装旧版**（Inno 或 NSIS 装的 1.0.0/1.0.1/1.0.2）并询问先卸载、卸载确认杀进程 + 强制清理残留；
  2. 主安装器写入 `HKCU\Software\DesktopPet\InstallDir`，供**模型包自动定位**；
  3. **模型包重构为 Inno Setup**（同目录 `inno-models.iss`），仍装到主程序目录下 `models\<模型名>\`；
  4. 切换模型不再跳位、设置面板新增「重置模型位置」。
- **默认安装路径**：**仅 Windows** 有"选目录 / 默认 `D:\DesktopPet`（无 D 盘退 `C:\DesktopPet`）"；**Linux（AppImage 免安装；deb 装到 `/opt/DesktopPetWeb`）、macOS（dmg 拖入「应用程序」）** 均**无此概念**。

---

## v1.0.1

- **Release 页**：https://github.com/Aerdgareo/DesktopPetWeb/releases/tag/v1.0.1
- **源码**
  - Git tag：`v1.0.1`
  - 对应提交：`bb7fb7d`
  - 许可：**GPL-3.0-or-later**
- **发行产物（7 个附件）**

  | 平台 | 文件 | 大小（字节） | 说明 |
  |---|---|---:|---|
  | Windows · x64 | `DesktopPetWeb.Setup.1.0.1.x64.exe` | 83,203,653 | NSIS 安装器（lite，外部 `models/` 仅「肥牛」） |
  | Windows · x86（32 位） | `DesktopPetWeb.Setup.1.0.1.x86.exe` | 78,104,110 | NSIS 安装器（lite，32 位系统） |
  | Linux | `DesktopPetWeb-1.0.1.AppImage` | 112,053,761 | AppImage（lite） |
  | Linux | `desktop-pet-web_1.0.1_amd64.deb` | 79,267,846 | deb（lite） |
  | macOS · Apple Silicon | `DesktopPetWeb-1.0.1-arm64.dmg` | 101,258,716 | arm64 dmg（lite） |
  | macOS · Intel | `DesktopPetWeb-1.0.1.dmg` | 107,309,643 | x64 dmg（lite） |
  | 模型包 | `DesktopPetModels-Setup.exe` | 189,483,408 | 含 24 个 Live2D 模型，**手动上传**到同一 Release |

- **本版修复**
  1. **缩放不再把人物拉回屏幕中心**（改为围绕人物可见中心缩放）；
  2. **安装时选其它路径会自动补 `DesktopPet` 子目录**；
  3. **CI 修复**：Windows 构建从失败恢复 → 现三平台全自动；Windows **拆分为 x64/x86 两个独立安装包**。
- **构建方式**：**全部由 GitHub Actions CI 自动构建**（tag `v1.0.1` 触发）；Windows 两个 job（x64 / x86）、macOS 一次出 arm64+x64、Linux AppImage+deb。模型包由人工补传。

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