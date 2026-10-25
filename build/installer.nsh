; ============================================================================
; DesktopPetLite 自定义 NSIS 安装/卸载逻辑（electron-builder 的 nsis.include）
;
; 注意：本文件在模板 include 之前被插入，若用到 ${If}/${FileExists} 等，
;       需在此处自行 include LogicLib / FileFunc / StrContains。
;
; 模板调用时机（app-builder-lib/templates/nsis/）：
;   customInit                -> installer.nsi .onInit（initMultiUser 之后）
;   customPageAfterChangeDir  -> assistedInstaller.nsh（目录页位置）
;   customInstall             -> installSection.nsh（文件/注册表/快捷方式完成后）
;   customUnInit              -> uninstaller.nsh 的 un.onInit（checkAppRunning 之后）
;   customUnInstall           -> uninstaller.nsh 的 un.install 段末
;   customCheckAppRunning     -> include/allowOnlyOneInstallerInstance.nsh（可覆盖默认实现）
; ============================================================================
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WinMessages.nsh"
!include "nsDialogs.nsh"


; ---------------------------------------------------------------------------
; 默认安装目录：默认 D:\DesktopPet（D 盘不存在回退 C:\DesktopPet）
;   · GUI：在目录页 PRE（PetDirPagePre）里设置（位于“安装模式页”之后，才不会被覆盖）
;   · 静默：customInit 仅在 $INSTDIR 为空时兜底；
;           —— 绝不覆盖 NSIS 由命令行 /D 预设的值（NSIS 会消费 /D 并从 $CMDLINE 移除，
;              故不能再用 ${StdUtils.GetParameter} 取；只能看 $INSTDIR 是否已被填）
; ---------------------------------------------------------------------------
!macro customInit
  ${If} $INSTDIR == ""
    ${If} ${FileExists} "D:\*.*"
      StrCpy $INSTDIR "D:\DesktopPet"
    ${Else}
      StrCpy $INSTDIR "C:\DesktopPet"
    ${EndIf}
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
Var PetDirDefaulted
Var PetDirField
Var PetSpaceLabel

; 目录页（方案 B）：自定义页，尽量贴近标准观感；选中/输入已存在目录后**在地址栏就地补** \DesktopPet（可见）。
;   安装前再用 PetInstFilesPre 兜底（幂等）。
!macro customPageAfterChangeDir
  Page custom PetDirPageCreate PetDirPageLeave
  !define MUI_PAGE_CUSTOMFUNCTION_PRE PetInstFilesPre
!macroend

Function PetDirPageCreate
  ; 默认目录：升级→沿用注册表上次安装目录；全新→D:\DesktopPet（无 D 盘回退 C:）
  ${If} $PetDirDefaulted != "1"
    StrCpy $PetDirDefaulted "1"
    ReadRegStr $0 HKCU "Software\DesktopPet" "InstallDir"
    ${If} $0 == ""
      ReadRegStr $0 HKLM "Software\DesktopPet" "InstallDir"
    ${EndIf}
    ${If} $0 != ""
      StrCpy $INSTDIR "$0"
    ${Else}
      ${If} ${FileExists} "D:\*.*"
        StrCpy $INSTDIR "D:\DesktopPet"
      ${Else}
        StrCpy $INSTDIR "C:\DesktopPet"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; 页面头部标题（覆盖上一页残留）；MUI2 头部控件 id 为 1034(标题)/1035(副标题)
  GetDlgItem $0 $HWNDPARENT 1034
  SendMessage $0 ${WM_SETTEXT} 0 "STR:选择安装位置"
  GetDlgItem $0 $HWNDPARENT 1035
  SendMessage $0 ${WM_SETTEXT} 0 "STR:安装到所选目录下的 DesktopPet 子目录"

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 12u "安装目录（若末级不是 DesktopPet，会自动补上）："
  Pop $1

  ${NSD_CreateDirRequest} 0 12u 100% 12u "$INSTDIR"
  Pop $PetDirField
  ${NSD_OnChange} $PetDirField PetDirOnChange

  ${NSD_CreateButton} 0 28u 62u 12u "浏览..."
  Pop $2
  ${NSD_OnClick} $2 PetDirBrowse

  ${NSD_CreateLabel} 0 44u 100% 10u ""
  Pop $PetSpaceLabel
  Call PetDirUpdateSpace

  nsDialogs::Show
FunctionEnd

; 显示所选分区剩余空间（可选提示）
Function PetDirUpdateSpace
  ${GetRoot} "$INSTDIR" $0
  ${DriveSpace} "$0" "/D=F /S=M" $1
  ${If} $1 != ""
    ${NSD_SetText} $PetSpaceLabel "所选分区剩余空间：$1 MB"
  ${EndIf}
FunctionEnd

; 独立“浏览...”按钮：选目录后在地址栏就地补 \DesktopPet
Function PetDirBrowse
  nsDialogs::SelectFolderDialog "选择安装目录" "$INSTDIR"
  Pop $0
  ${If} $0 != error
    StrCpy $INSTDIR "$0"
    ${GetFileName} $1 "$INSTDIR"
    ${If} $1 != "DesktopPet"
      ${If} ${FileExists} "$INSTDIR\*.*"
        StrCpy $INSTDIR "$INSTDIR\DesktopPet"
      ${EndIf}
    ${EndIf}
    ${NSD_SetText} $PetDirField "$INSTDIR"
    Call PetDirUpdateSpace
  ${EndIf}
FunctionEnd

; 地址栏变更时：若值已是「存在的目录」且末级名不是 DesktopPet，则就地补 \DesktopPet 并写回地址栏
Function PetDirOnChange
  ${NSD_GetText} $PetDirField $0
  ${If} $0 == ""
    Return
  ${EndIf}
  ${GetFileName} $1 "$0"
  ${If} $1 != "DesktopPet"
    ${If} ${FileExists} "$0\*.*"
      StrCpy $0 "$0\DesktopPet"
      ${NSD_SetText} $PetDirField "$0"
      StrCpy $INSTDIR "$0"
      Call PetDirUpdateSpace
    ${EndIf}
  ${EndIf}
FunctionEnd

Function PetDirPageLeave
  ${NSD_GetText} $PetDirField $0
  ${If} $0 != ""
    ${GetFileName} $1 "$0"
    ${If} $1 == "DesktopPet"
      StrCpy $INSTDIR "$0"
    ${Else}
      StrCpy $INSTDIR "$0\DesktopPet"
    ${EndIf}
  ${EndIf}
FunctionEnd

; 安装前兜底：若所选路径末级名不是 DesktopPet，则补 \DesktopPet（幂等）
;   （例：R:\ → R:\DesktopPet；D:\Games → D:\Games\DesktopPet；D:\DesktopPet → 保持不变）
Function PetInstFilesPre
  ${GetFileName} $0 "$INSTDIR"
  ${If} $0 != "DesktopPet"
    StrCpy $INSTDIR "$INSTDIR\DesktopPet"
  ${EndIf}
FunctionEnd
!endif

; ---------------------------------------------------------------------------
; 安装完成后记录安装位置（供“模型安装包”自动定位）
; ---------------------------------------------------------------------------
!macro customInstall
  WriteRegStr HKCU "Software\DesktopPet" "InstallDir" "$INSTDIR"
  ClearErrors
  WriteRegStr HKLM "Software\DesktopPet" "InstallDir" "$INSTDIR"
!macroend

; ---------------------------------------------------------------------------
; 【关键修复】覆盖默认的“应用正在运行”检查（安装器 + 卸载器都生效）
;
; 模板默认实现（allowOnlyOneInstallerInstance.nsh / extractAppPackage.nsh / installUtil.nsh）
; 在应用仍在运行（或文件被占用）时会 MessageBox“无法关闭…重试/取消”并阻塞。
; 这里改为：**循环强杀并确认进程已退出**，不弹窗、不阻塞；避免解包阶段因文件仍被占用再次弹框。
; ---------------------------------------------------------------------------
!macro customCheckAppRunning
  DetailPrint "结束正在运行的 ${APP_EXECUTABLE_FILENAME}（若有）…"
  ; 多次强杀 + 等待，确保进程退出、文件锁释放（避免解包阶段再弹“无法关闭”）。
  ; 说明：不用循环标签/StrContains（其在卸载器段会因 Call 前缀问题编译失败），改为展开式。
  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 400
  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 400
  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 400
  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 900
!macroend

; ---------------------------------------------------------------------------
; 延迟清理：写一个隐藏运行的 VBS，待卸载器进程退出后再彻底删除安装目录。
;   解决两类残留：① 卸载器自身的 Uninstall*.exe 占用导致 $INSTDIR 删不掉；
;                ② 应用/文件被占用导致 RMDir 失败。
; ---------------------------------------------------------------------------
!macro PetScheduleCleanup
  ClearErrors
  FileOpen $9 "$TEMP\DesktopPetLite-cleanup.vbs" w
  ; 注意：NSIS 以逗号分隔参数，凡含逗号的行必须整体用双引号包裹；内层引号转义为 $\"
  FileWrite $9 "Set fso = CreateObject($\"Scripting.FileSystemObject$\")$\r$\n"
  FileWrite $9 "Set sh = CreateObject($\"WScript.Shell$\")$\r$\n"
  FileWrite $9 "WScript.Sleep 4000$\r$\n"
  FileWrite $9 "n = 0$\r$\n"
  ; 卸载器进程退出前其自身文件仍占用安装目录，删除会失败 —— 循环重试直到目录消失
  FileWrite $9 "Do While n < 40 And fso.FolderExists($\"$INSTDIR$\")$\r$\n"
  FileWrite $9 "  sh.Run $\"cmd /c rmdir /s /q $\"$\"$INSTDIR$\"$\"$\", 0, True$\r$\n"
  FileWrite $9 "  WScript.Sleep 1000$\r$\n"
  FileWrite $9 "  n = n + 1$\r$\n"
  FileWrite $9 "Loop$\r$\n"
  FileWrite $9 "fso.DeleteFile WScript.ScriptFullName$\r$\n"
  FileClose $9
  Exec '"$SYSDIR\wscript.exe" "$TEMP\DesktopPetLite-cleanup.vbs"'
!macroend

; 卸载初始化阶段：仅尽力结束残留进程
;   注意：此刻 $INSTDIR 尚未被 initMultiUser 设置（un.onInit 第 1 行 SetOutPath $INSTDIR 早于它），
;   故不能在这里排“延迟清理任务”（会拿到错误路径）。清理统一放到 customUnInstall。
!macro customUnInit
  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 300
!macroend

; 卸载段末：常规清理 + 再次登记延迟清理（幂等）
!macro customUnInstall
  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 300

  ; 关键：卸载器 un.onInit 会把“当前目录”设为 $INSTDIR，而 NSIS 无法删除当前目录
  ;       （RMDir 会失败）→ 必须先切到 $TEMP 再删安装目录，否则必然残留一个空文件夹。
  SetOutPath "$TEMP"

  ; 模型目录（extraFiles 安装到安装根）+ 安装根目录
  RMDir /r "$INSTDIR\models"
  RMDir /r "$INSTDIR"
  RMDir "$INSTDIR"

  ; 清理本安装器写入的注册表键
  DeleteRegKey HKCU "Software\DesktopPet"
  ClearErrors
  DeleteRegKey HKLM "Software\DesktopPet"

  !insertmacro PetScheduleCleanup
!macroend