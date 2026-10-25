; DesktopPetWeb —— Inno Setup 打包脚本（方案：用其它打包工具满足“选目录后地址栏可见补 DesktopPet”）
; 用 win-unpacked（electron-builder 产出的解包目录）作为载荷。

#define AppVer "1.0.4"

; 可用 ISCC /DSRC=... /DARCH=... 覆盖（默认 x64）；x86 用 /DSRC=win-ia32-unpacked /DARCH=x86
#ifndef SRC
  #define SRC "win-unpacked"
#endif
#ifndef ARCH
  #define ARCH "x64"
#endif

[Setup]
AppId={{9F1C6D2E-3A4B-4C5D-8E7F-0A1B2C3D4E5F}
AppName=DesktopPetWeb
AppVersion={#AppVer}
AppPublisher=Aerdgareo
VersionInfoVersion=1.0.4.0
VersionInfoProductVersion=1.0.4
VersionInfoProductName=DesktopPetWeb
VersionInfoCompany=Aerdgareo
VersionInfoDescription=DesktopPetWeb 安装程序
DefaultDirName=D:\DesktopPet
DisableProgramGroupPage=yes
DisableDirPage=no
UninstallDisplayIcon={app}\DesktopPetWeb.exe
OutputDir=..\dist-inno
OutputBaseFilename=DesktopPetWeb.Setup.{#AppVer}.{#ARCH}
Compression=lzma2
SolidCompression=yes
SetupIconFile=icon.ico
CloseApplications=yes
RestartApplications=no
WizardStyle=modern


[Languages]
Name: "chinese"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加图标："

[Files]
Source: "..\dist\{#SRC}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\DesktopPetWeb"; Filename: "{app}\DesktopPetWeb.exe"
Name: "{autodesktop}\DesktopPetWeb"; Filename: "{app}\DesktopPetWeb.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\DesktopPetWeb.exe"; Description: "启动 DesktopPetWeb"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; 卸载开始前强杀正在运行的应用（避免文件被占用导致残留）
Filename: "{cmd}"; Parameters: "/c taskkill /f /im DesktopPetWeb.exe"; Flags: runhidden; RunOnceId: "KillDesktopPetOnUninstall"

[UninstallDelete]
; 强制清理（含旧版 NSIS 安装残留的 resources/ 等）：递归删除安装目录
Type: filesandordirs; Name: "{app}\resources"
Type: filesandordirs; Name: "{app}\models"
Type: filesandordirs; Name: "{app}\locales"
Type: filesandordirs; Name: "{app}\swiftshader"
Type: filesandordirs; Name: "{app}"

[Registry]
; 供「模型安装包」自动定位主程序安装目录（与 NSIS 版同一键；卸载时删除该值）
Root: HKCU; Subkey: "Software\DesktopPet"; ValueType: string; ValueName: "InstallDir"; ValueData: "{app}"; Flags: uninsdeletevalue

[Code]
var
  InDirChange: Boolean;
  PrevAppDir: String;   // 旧版本安装目录（若检测到）
  UsePrevDir: Boolean;  // 用户是否选择沿用上次目录

{ 地址栏变更：若所选/输入的目录是“已存在目录”且末级名不是 DesktopPet，则就地补 \DesktopPet（可见） }
procedure DirChanged(Sender: TObject);
var
  s: string;
begin
  if InDirChange then Exit;
  s := WizardForm.DirEdit.Text;
  if (s <> '') and DirExists(s) and (CompareText(ExtractFileName(s), 'DesktopPet') <> 0) then
  begin
    InDirChange := True;
    WizardForm.DirEdit.Text := AddBackslash(s) + 'DesktopPet';
    InDirChange := False;
  end;
end;

procedure InitializeWizard();
begin
  if UsePrevDir and (PrevAppDir <> '') then
    WizardForm.DirEdit.Text := PrevAppDir
  else
    WizardForm.DirEdit.Text := 'D:\DesktopPet';
  WizardForm.DirEdit.OnChange := @DirChanged;
end;
{ 结束正在运行的桌宠（静默卸载时直接杀；交互式卸载时先确认） }
procedure KillDesktopPet();
var
  ResultCode: Integer;
begin
  Exec('cmd.exe', '/c taskkill /f /im DesktopPetWeb.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(600);
end;

{ 卸载前：确保能完全删除（否则文件被占用会残留） }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    if UninstallSilent then
      KillDesktopPet()
    else if MsgBox('要彻底删除本应用，需先关闭正在运行的 DesktopPetWeb（它会占用文件）。' + #13#10 + '是否现在终止它并继续卸载？', mbConfirmation, MB_YESNO) = IDYES then
      KillDesktopPet();
  end;
end;

{ 在 HKCU / HKLM 中查找本程序旧版的卸载命令（Inno 卸载项按 AppId+_is1 命名） }
function FindPrevUninstall(): String;
var
  S: String;
begin
  Result := '';
  S := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{9F1C6D2E-3A4B-4C5D-8E7F-0A1B2C3D4E5F}_is1';
  if RegQueryStringValue(HKCU, S, 'UninstallString', Result) then Exit;
  if RegQueryStringValue(HKLM, S, 'UninstallString', Result) then Exit;
  if RegQueryStringValue(HKCU, S, 'QuietUninstallString', Result) then Exit;
  RegQueryStringValue(HKLM, S, 'QuietUninstallString', Result);
end;

{ 安装前：检测旧版本（Inno 或 NSIS 装的都算）；询问是否先卸载，卸载后再问是否沿用上次目录 }
function InitializeSetup(): Boolean;
var
  Uninst: String;
  ResultCode: Integer;
  S: String;
  D: String;
  IsNsis: Boolean;
begin
  Result := True;
  UsePrevDir := False;
  PrevAppDir := '';
  IsNsis := False;

  { ① Inno 装的旧版：查 Inno 卸载项的 InstallLocation }
  S := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{9F1C6D2E-3A4B-4C5D-8E7F-0A1B2C3D4E5F}_is1';
  RegQueryStringValue(HKCU, S, 'InstallLocation', PrevAppDir);
  if PrevAppDir = '' then
    RegQueryStringValue(HKLM, S, 'InstallLocation', PrevAppDir);
  Uninst := FindPrevUninstall();

  { ② NSIS(electron-builder) 装的旧版(v1.0.0/1.0.1/1.0.2)：查 Software\DesktopPet\InstallDir + 其卸载器 }
  if Uninst = '' then
  begin
    D := '';
    if not RegQueryStringValue(HKCU, 'Software\DesktopPet', 'InstallDir', D) then
      RegQueryStringValue(HKLM, 'Software\DesktopPet', 'InstallDir', D);
    if D <> '' then
    begin
      if FileExists(AddBackslash(D) + 'Uninstall DesktopPetWeb.exe') then
      begin
        Uninst := AddBackslash(D) + 'Uninstall DesktopPetWeb.exe';
        PrevAppDir := D;
        IsNsis := True;
      end
      else if FileExists(AddBackslash(D) + 'Uninstall DesktopPetLite.exe') then
      begin
        Uninst := AddBackslash(D) + 'Uninstall DesktopPetLite.exe';
        PrevAppDir := D;
        IsNsis := True;
      end;
    end;
  end;

  if Uninst <> '' then
  begin
    if MsgBox('检测到已安装 DesktopPetWeb（旧版）。' + #13#10 + '是否先卸载已安装的版本，然后再安装本版本？', mbConfirmation, MB_YESNO) = IDYES then
    begin
      if IsNsis then
        Exec(Uninst, '/S', '', SW_SHOW, ewWaitUntilTerminated, ResultCode)
      else
        Exec(RemoveQuotes(Uninst), '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', '', SW_SHOW, ewWaitUntilTerminated, ResultCode);
      Sleep(2000);
      { 卸载完成后：提示是否沿用上次的安装目录 }
      if PrevAppDir <> '' then
      begin
        if MsgBox('是否使用上次的安装目录？' + #13#10 + PrevAppDir, mbConfirmation, MB_YESNO) = IDYES then
          UsePrevDir := True;
      end;
    end;
  end;
end;