; DesktopPetWeb —— Inno Setup 打包脚本（方案：用其它打包工具满足“选目录后地址栏可见补 DesktopPet”）
; 用 win-unpacked（electron-builder 产出的解包目录）作为载荷。

#define AppVer "1.0.4"

[Setup]
AppId={{9F1C6D2E-3A4B-4C5D-8E7F-0A1B2C3D4E5F}
AppName=DesktopPetWeb
AppVersion={#AppVer}
AppPublisher=Aerdgareo
DefaultDirName=D:\DesktopPet
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\DesktopPetWeb.exe
OutputDir=..\dist-inno
OutputBaseFilename=DesktopPetWeb.Setup.{#AppVer}.x64
Compression=lzma2
SolidCompression=yes
SetupIconFile=icon.ico
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "chinese"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加图标："

[Files]
Source: "..\dist\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\DesktopPetWeb"; Filename: "{app}\DesktopPetWeb.exe"
Name: "{autodesktop}\DesktopPetWeb"; Filename: "{app}\DesktopPetWeb.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\DesktopPetWeb.exe"; Description: "启动 DesktopPetWeb"; Flags: nowait postinstall skipifsilent

[Code]
var
  InDirChange: Boolean;

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
  WizardForm.DirEdit.Text := 'D:\DesktopPet';
  WizardForm.DirEdit.OnChange := @DirChanged;
end;