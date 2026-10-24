# 发布指南（RELEASE）

> 本文档描述 **DesktopPetWeb** 的正式发布流程：如何打 tag 触发 CI，以及如何让 **同一次 GitHub Release 承载“两个附件”**。

---

## 0. 发布形态总览：一次 Release，两个附件

每次发布（`vX.Y.Z`）对应**同一个 GitHub Release**，它承载两组附件：

| 附件 | 内容 | 体积（约） | 由谁产生 / 如何上传 |
|---|---|---|---|
| ① **主程序安装包** | Win NSIS `.exe`、macOS `.dmg`、Linux `.AppImage` / `.deb` | 每平台 ~75–110 MB | **CI 自动构建并上传**（`.github/workflows/build.yml`） |
| ② **模型安装包** | `DesktopPetModels-Setup.exe`（含 24 个 Live2D 模型） | ~189 MB | **不进仓库、CI 不构建**，由人工**手动上传到同一 Release** |

> 为什么模型包不自动构建：模型包体积大、且包含**第三方/个人 Live2D 模型**（版权受限，不宜入库），CI 环境内也**没有可用的模型源**。因此采用「CI 出主程序包 + 人工附模型包」的组合。

---

## 1. 发布前置条件（构建前提）

1. 仓库根存在 `LICENSE`（GPL-3.0-or-later）与 `THIRD-PARTY-NOTICES.md`。
2. `package.json` 中**不应**残留指向本机 dist 的 `build.electronDist`（跨平台 CI 会移除它；本仓库日常已不含该项）。
   - 注意：变体配置 `electron-builder.slim.json` 若仍保留 `electronDist`，**不要机械地全局删除**——只要本次发布构建不加载它即可。
3. `package.json` 中 `build.linux.target` 为 `["AppImage","deb"]`，`build.directories.output` 为 `dist`。
4. 运行时内核（Live2D Core）由 CI 内的 `npm run fetch-vendor` 拉取到 `web/vendor/`，**不随仓库分发**（专有许可）。

---

## 2. 打 tag 触发 CI（自动发布）

```bash
# 1) 确保工作区干净、版本号与 tag 一致（package.json 的 version 建议同步为 1.0.0 之类）
git status

# 2) 打 tag 并推送（tag 必须以 v 开头，触发 workflow 的 push.tags 规则）
git tag v1.0.0
git push origin v1.0.0
```

- 推送 `v*` tag 后，`.github/workflows/build.yml` 会被触发：
  1. `build` job 在 **windows-latest / macos-latest / ubuntu-latest** 三平台矩阵构建，各自上传 artifact；
  2. `release` job 下载全部 artifact，用 `softprops/action-gh-release@v2` 创建 **同名 tag 的 Release**，并自动附加主程序安装包。
- 也**可手动触发构建**：仓库 **Actions → build → Run workflow**。
  - 注意：手动触发**只会构建**，不会创建 Release（Release 仅在推送 `v*` tag 时创建）。

---

## 3. CI 产出物（平台 × 目标 × 文件名）

| 平台（runner） | electron-builder 目标 | 典型产物文件名 | 是否自动进 Release |
|---|---|---|---|
| `windows-latest` | `--win nsis` | `DesktopPetWeb Setup 1.0.0.exe` | ✅ 自动 |
| `macos-latest` | `--mac dmg` | `DesktopPetWeb-1.0.0.dmg` | ✅ 自动 |
| `ubuntu-latest` | `--linux AppImage deb` | `DesktopPetWeb-1.0.0.AppImage`、`desktop-pet-web_1.0.0_amd64.deb` | ✅ 自动 |

> Workflow 中 `files: artifacts/**/*` 会覆盖上述**全部**平台产物，并汇总到**同一个** Release。
> 中间文件（`*.blockmap`、`latest-linux.yml`、`builder-debug.yml` 等）不会被上传。

---

## 4. 模型安装包随同一 Release 发布的两种方式

模型安装包文件名固定为 **`DesktopPetModels-Setup.exe`**，本地生成位置通常为：

```
D:\ICT\DesktopPetModels\DesktopPetModels-Setup.exe
```

> 该包的构建脚本（本地、离线）在 `DesktopPetModels/` 目录（如 `build-models-installer.cmd`），**不属于本发布仓库**，也不会被提交。

### 方式 A：GitHub Web 界面手动上传（推荐给无命令行环境者）

1. 打开仓库的 **Releases** 页面，找到本次 tag（如 `v1.0.0`）对应的 Release。
2. 点右上角 **铅笔图标（Edit release）** 进入编辑页。
3. 在 **“Attach binaries by dropping them here or selecting them”** 区域：
   - 直接把 `DesktopPetModels-Setup.exe` **拖拽**进去，或点击选择该文件；
4. 等待上传完成（约 189 MB，视网速需要几分钟）。
5. 点 **“Update release”** 保存。

完成后该文件会出现在 Release 的 **Assets** 列表，与主程序安装包并列——即“同一次 Release 的两个附件”。

> 若 CI 尚未创建 Release，也可在 **Draft a new release** 里自选 tag 打草稿，一并上传主程序包与模型包。

### 方式 B：命令行 `gh release upload`

前置：安装并登录 [GitHub CLI](https://cli.github.com/)：

```bash
gh auth login
```

将模型包上传到**已存在**的 Release（tag 需与 Release 一致）：

```bash
# 语法：gh release upload <tag> <file...> [--repo <owner/repo>] [--clobber]
gh release upload v1.0.0 "D:/ICT/DesktopPetModels/DesktopPetModels-Setup.exe" \
  --repo Aerdgareo/DesktopPetWeb
```

- 若同名 asset 已存在，加 `--clobber` 覆盖：
  ```bash
  gh release upload v1.0.0 "D:/ICT/DesktopPetModels/DesktopPetModels-Setup.exe" --clobber
  ```
- 校验上传结果：
  ```bash
  gh release view v1.0.0 --repo Aerdgareo/DesktopPetWeb
  ```
- 也可在 **CI 之外**用 API/脚本上传；但**不要**把模型包提交进 git 历史。

> Windows 路径在 git-bash 下也可写成 `D:\ICT\DesktopPetModels\DesktopPetModels-Setup.exe`（引号包裹）。GitHub 单个 Release 附件上限为 **2 GB**，189 MB 完全满足。

---

## 5. GPLv3 合规：分发二进制须提供对应源码

本项目**自身源码**以 **GPL-3.0-or-later** 授权。依据 GPLv3 第 6 条，当你以安装包（二进制）形式对外分发时，**必须同时提供与之对应的完整源码**（Corresponding Source）。合规做法（任选其一或并用）：

1. **指向源码仓库**：在 Release 说明中给出源码地址
   `https://github.com/Aerdgareo/DesktopPetWeb`，并保证 **tag 名与产物版本一致**（如 `git tag v1.0.0` ↔ Release `v1.0.0`），即为“对应源码”。
2. **附源码归档**：直接使用 GitHub Release **自动附带**的 **Source code (zip) / (tar.gz)**（GitHub 会为每个 Release 自动生成对应 tag 的源码归档，无需额外操作）。

> CI 已在 Release 说明中包含一段“源码与许可”提示（自定义 `body` 会**前置**在自动生成的 notes 之前），提醒下载者取得对应源码。本仓库真实地址为 `https://github.com/Aerdgareo/DesktopPetWeb`，README 与 CI 生成的 Release 说明中均已使用该地址。

---

## 6. 模型包的第三方授权说明（重要）

模型安装包内含模型，**其版权与授权独立于本项目**，分发前请逐一确认：

| 内容 | 授权性质 | 分发边界 |
|---|---|---|
| **Live2D Cubism Core / Cubism 2.1 Core**（`web/vendor/*.js`，运行时内核，**不随仓库分发**，由 `fetch-vendor` 拉取） | Live2D **专有许可**（Proprietary Software License） | 需同意并遵守 Live2D SDK 许可；公开发行前自行确认满足其条款 |
| **Live2D 官方示例模型**（如 shizuku / haru） | **Sample Model Terms** | 再分发**受限**；建议不内置，改由用户自行获取 |
| **用户导入的角色模型** | 版权归各自**原作者/发行方** | 可能有严格限制；**切勿**把他人版权模型提交/公开分发 |
| **模型安装包内的 24 个模型** | 取决于其**取材来源** | **仅在取得合法分发权的前提下**随 Release 分发；若含未授权模型，则该安装包**不得公开分发** |

要点：
- 该模型包属**第三方/个人素材集合**，因此**不进 git 仓库**、由人工单独上传，便于你按授权情况决定是否公开发布。
- 分发时请保留 `THIRD-PARTY-NOTICES.md`，并在 Release 说明与 README「致谢」中标注 Live2D、PixiJS、Electron 及模型作者。
- 若某个模型的授权不允许公开再分发，请将其从公开模型包中剔除，或仅提供“用户自行导入”方式（应用支持外部模型文件夹）。

---

## 7. 发布核对清单（Checklist）

发布 `vX.Y.Z` 后逐项确认：

- [ ] 已推送 `vX.Y.Z` tag，`build` 工作流三平台全部成功
- [ ] Release `vX.Y.Z` 已创建，**主程序附件齐全**：Win `.exe`、macOS `.dmg`、Linux `.AppImage`、Linux `.deb`
- [ ] **模型安装包** `DesktopPetModels-Setup.exe` 已手动上传到**同一** Release 的 Assets
- [ ] Release 说明含**对应源码**链接（tag 与版本一致）或 Source code 归档
- [ ] 仓库真实地址（`https://github.com/Aerdgareo/DesktopPetWeb`）已在 README 与 Release 说明中正确使用
- [ ] `THIRD-PARTY-NOTICES.md` 已随源码提供；模型授权边界已确认
- [ ] `package.json` 无残留 `build.electronDist`（跨平台无冲突）
- [ ] `gh release view vX.Y.Z` 显示的 asset 数量 = 4（主程序）+ 1（模型包）= 5

---

## 8. 常见问题（FAQ）

**Q1. 为什么模型包不放进 CI 一起构建？**
A1. CI 内没有模型源（模型不入仓库），且模型属第三方/个人素材、体积大（~189 MB）。故采用人工上传，兼顾合规与灵活。

**Q2. 能否让 CI 自动下载并上传模型包？**
A2. 本仓库**不**采用该方案（否则需把模型/其来源与凭据交给 CI，且涉及授权风险）。workflow 中仅保留“手动步骤”的说明性注释，未引入任何非官方 action。

**Q3. 手动上传后没看到附件？**
A3. 确认上传后点了 **Update release**；或确认 `gh release upload` 的 `<tag>` 与 Release 完全一致。可 `gh release view <tag>` 复核。

**Q4. 主程序包只出现部分平台？**
A4. 某个平台构建失败时，该平台 artifact 缺失。检查 Actions 里对应矩阵 job 的日志（常见：macOS 签名、Linux 依赖）。`if-no-files-found: ignore` 会静默跳过缺失产物，需人工核对。

**Q5. macOS 能交叉构建吗？**
A5. 不能。`.dmg` 必须在 `macos-latest` runner 上构建，workflow 已在矩阵中固定该平台。

---

## 参考（经验来源）

本流程沉淀自工程经验库（复用时应保留来源）：

- `build-env/2026-10-24-docker-electron-builder-cross-platform-linux-artifacts.md` —— 跨平台构建须**移除 `build.electronDist`**、确认 `linux.target` 与 `directories.output`；变体 profile（`*.slim.json`）不要机械全局删除。
- `workflow/2026-10-24-open-source-clean-source-tree-release-export.md` —— **先分类再导出**：自有源码/脚本/CI/文档进源码树（A 类），许可受限的运行时内核/依赖靠 `fetch` 脚本按需拉取（B 类）。