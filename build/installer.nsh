; ============================================================================
; DesktopPetLite 自定义 NSIS 安装/卸载逻辑（electron-builder 的 nsis.include）
;
; 注意：本文件在模板 include 之前被插入，若用到 ${If}/${FileExists} 等，
;       需在此处自行 include LogicLib / FileFunc。
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
Var PetDirField

; 允许用户修改安装目录；并在“选择目录”页上：一旦所选/输入的目录是**已存在目录**且末级名不是 DesktopPet，
; 就地在【地址栏】补上 \DesktopPet 子目录（可见）。安装前再用 PetInstFilesPre 兜底（幂等）。
!macro customPageAfterChangeDir
  Page custom PetDirPageCreate PetDirPageLeave
  ; 兜底：紧随本宏之后模板插入 MUI_PAGE_INSTFILES —— 定义其 PRE；届时 $INSTDIR 已是最终值
  !define MUI_PAGE_CUSTOMFUNCTION_PRE PetInstFilesPre
!macroend

Function PetDirPageCreate
  ; 全新安装：默认 D:\DesktopPet（无 D 盘回退 C:\DesktopPet）；升级：沿用注册表上次安装目录
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


  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 22u "请选择安装目录；选中其它目录后，地址栏会自动补上 DesktopPet 子目录。"
  Pop $1
  ${NSD_CreateDirRequest} 0 24u 100% 12u "$INSTDIR"
  Pop $PetDirField
  ${NSD_OnChange} $PetDirField PetDirOnChange
  nsDialogs::Show
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
; 模板默认实现（include/allowOnlyOneInstallerInstance.nsh）在应用仍在运行时，
; 若无法自动关闭会 MessageBox“无法关闭…重试/取消”并阻塞（安装/卸载都会卡住）。
; 这里改为：直接 taskkill /f 强杀正在运行的程序，不弹窗、不阻塞。
; ---------------------------------------------------------------------------
!macro customCheckAppRunning
  DetailPrint "结束正在运行的 ${APP_EXECUTABLE_FILENAME}（若有）…"
  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 600
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