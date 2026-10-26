; DesktopPet Tauri 版 —— Inno Setup 打包脚本（沿用 Electron 版 Installer 需求）
; 载荷：src-tauri/target/release/desktop-pet-tauri.exe（x64）或 target/i686-pc-windows-msvc/release/...（x86）

#define AppVer "0.1.0"
#ifndef SRC
  #define SRC "target\release"
#endif
#ifndef ARCH
  #define ARCH "x64"
#endif
#ifndef EXE
  #define EXE "desktop-pet-tauri.exe"
#endif

[Setup]
AppId={{C3D4E5F6-A7B8-4C9D-9E0F-1A2B3C4D5E6F}
AppName=DesktopPet (Tauri)
AppVersion={#AppVer}
AppPublisher=Aerdgareo
VersionInfoVersion=0.1.0.0
VersionInfoProductVersion=0.1.0
VersionInfoProductName=DesktopPet (Tauri)
VersionInfoCompany=Aerdgareo
VersionInfoDescription=DesktopPet Tauri 版安装程序
DefaultDirName=D:\DesktopPet
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
DisableDirPage=no
UninstallDisplayIcon={app}\{#EXE}
OutputDir=..\dist-inno
OutputBaseFilename=DesktopPetTauri.Setup.{#AppVer}.{#ARCH}
Compression=lzma2
SolidCompression=yes
SetupIconFile=..\src-tauri\icons\icon.ico
WizardStyle=modern

[Languages]
Name: "chinese"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加图标："

[Files]
Source: "..\src-tauri\{#SRC}\{#EXE}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\DesktopPet"; Filename: "{app}\{#EXE}"
Name: "{autodesktop}\DesktopPet"; Filename: "{app}\{#EXE}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#EXE}"; Description: "启动 DesktopPet"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{cmd}"; Parameters: "/c taskkill /f /im {#EXE}"; Flags: runhidden; RunOnceId: "KillDesktopPetOnUninstall"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Registry]
; 供「模型安装包」定位主程序目录（与 Electron 版同一键）
Root: HKCU; Subkey: "Software\DesktopPet"; ValueType: string; ValueName: "InstallDir"; ValueData: "{app}"; Flags: uninsdeletevalue

[Code]
var
  InDirChange: Boolean;
  PrevAppDir: String;
  UsePrevDir: Boolean;

{ 目录页变更：选中已存在目录且末级名不是 DesktopPet → 地址栏就地补 \DesktopPet（可见） }
procedure DirChanged(Sender: TObject);
var s: string;
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

{ 检测旧版：Inno（Electron 版 或 本 Tauri 版）或 NSIS(electron-builder) 装的 }
function InitializeSetup(): Boolean;
var
  Uninst: String; ResultCode: Integer; D: String; IsNsis: Boolean; S: String;
begin
  Result := True; UsePrevDir := False; PrevAppDir := ''; IsNsis := False;

  { ① Inno 卸载项（Electron 版 GUID 或 本 Tauri 版 GUID）}
  S := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{9F1C6D2E-3A4B-4C5D-8E7F-0A1B2C3D4E5F}_is1';
  if RegQueryStringValue(HKCU, S, 'UninstallString', Uninst) or RegQueryStringValue(HKLM, S, 'UninstallString', Uninst) then
    RegQueryStringValue(HKCU, 'Software\DesktopPet', 'InstallDir', PrevAppDir)
  else
  begin
    S := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{C3D4E5F6-A7B8-4C9D-9E0F-1A2B3C4D5E6F}_is1';
    RegQueryStringValue(HKCU, S, 'UninstallString', Uninst);
    if Uninst = '' then RegQueryStringValue(HKLM, S, 'UninstallString', Uninst);
  end;

  { ② NSIS(electron-builder) 装的旧版：Software\DesktopPet\InstallDir + 其卸载器 }
  if Uninst = '' then
  begin
    D := '';
    if not RegQueryStringValue(HKCU, 'Software\DesktopPet', 'InstallDir', D) then
      RegQueryStringValue(HKLM, 'Software\DesktopPet', 'InstallDir', D);
    if D <> '' then
    begin
      if FileExists(AddBackslash(D) + 'Uninstall DesktopPetWeb.exe') then
      begin Uninst := AddBackslash(D) + 'Uninstall DesktopPetWeb.exe'; PrevAppDir := D; IsNsis := True; end
      else if FileExists(AddBackslash(D) + 'Uninstall DesktopPetLite.exe') then
      begin Uninst := AddBackslash(D) + 'Uninstall DesktopPetLite.exe'; PrevAppDir := D; IsNsis := True; end;
    end;
  end;

  if Uninst <> '' then
  begin
    if MsgBox('检测到已安装 DesktopPet（旧版）。' + #13#10 + '是否先卸载已安装的版本，然后再安装本版本？', mbConfirmation, MB_YESNO) = IDYES then
    begin
      if IsNsis then
        Exec(Uninst, '/S', '', SW_SHOW, ewWaitUntilTerminated, ResultCode)
      else
        Exec(RemoveQuotes(Uninst), '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', '', SW_SHOW, ewWaitUntilTerminated, ResultCode);
      Sleep(2000);
      if PrevAppDir <> '' then
        if MsgBox('是否使用上次的安装目录？' + #13#10 + PrevAppDir, mbConfirmation, MB_YESNO) = IDYES then
          UsePrevDir := True;
    end;
  end;
end;

procedure KillDesktopPet();
var ResultCode: Integer;
begin
  Exec('cmd.exe', '/c taskkill /f /im {#EXE}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(600);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    if UninstallSilent then
      KillDesktopPet()
    else if MsgBox('要彻底删除本应用，需先关闭正在运行的 DesktopPet（它会占用文件）。' + #13#10 + '是否现在终止它并继续卸载？', mbConfirmation, MB_YESNO) = IDYES then
      KillDesktopPet();
  end;
end;