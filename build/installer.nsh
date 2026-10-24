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
; 允许用户修改安装目录且不追加应用名子目录
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_PRE PetDirPagePre
  !insertmacro MUI_PAGE_DIRECTORY
!macroend
Function PetDirPagePre
  ${If} $PetDirDefaulted != "1"
    StrCpy $PetDirDefaulted "1"
    ; 需求：向导默认目录固定为 D:\DesktopPet（用户仍可修改）
    ${If} ${FileExists} "D:\*.*"
      StrCpy $INSTDIR "D:\DesktopPet"
    ${Else}
      StrCpy $INSTDIR "C:\DesktopPet"
    ${EndIf}
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
; 【关键修复】覆盖默认的“应用正在运行”检查（仅卸载器构建）
;
; 模板默认实现（include/allowOnlyOneInstallerInstance.nsh:50-115）在静默模式下，
; 若判定“应用仍在运行且无法关闭”，会 MessageBox ... /SD IDCANCEL → Quit，
; 导致【整个 un.install 段不执行】——安装目录与注册表全部残留（已实测复现）。
; 这里改为：静默/交互都不弹窗、不 Quit，只尽力结束桌宠进程后继续卸载。
; ---------------------------------------------------------------------------
!ifdef BUILD_UNINSTALLER
!macro customCheckAppRunning
  DetailPrint "结束正在运行的 ${APP_EXECUTABLE_FILENAME}（若有）…"
  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 600
!macroend
!endif

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