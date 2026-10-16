Unicode true
RequestExecutionLevel user
SetCompressor /SOLID zlib
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

!ifndef APP_VERSION
  !error "APP_VERSION is required"
!endif
!ifndef STAGE_DIR
  !error "STAGE_DIR is required"
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE is required"
!endif
!ifdef TEST_MODE
  !define PRODUCT_KEY "Software\SAPMCPInstallerTest"
  !define UNINSTALL_KEY "Software\SAPMCPInstallerTest\Uninstall"
  !define TEST_FLAG " -TestMode"
!else
  !define PRODUCT_KEY "Software\SAPMCP"
  !define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\SAPMCP"
  !define TEST_FLAG ""
!endif

Name "SAP MCP ${APP_VERSION} (${TARGET_ARCH})"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\SAPMCP"
InstallDirRegKey HKCU "${PRODUCT_KEY}" "InstallDir"
Icon "${STAGE_DIR}\sapmcp.ico"
UninstallIcon "${STAGE_DIR}\sapmcp.ico"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "SAP MCP"
VIAddVersionKey "FileDescription" "SAP MCP Windows Installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "SAP MCP project"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\bin\sapmcp-gui.exe"
!define MUI_FINISHPAGE_RUN_TEXT "打开 SAP MCP 图形管理界面"
!define MUI_FINISHPAGE_TEXT "安装完成。请重新打开终端后使用 sapmcp 命令。$\r$\n$\r$\n图形界面启动后可从系统托盘重新打开或正常退出。卸载时保留连接配置、日志和 Windows 凭据。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Var StartMenuDirectory
Var DesktopShortcut

Function .onInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "需要 Windows 10 或 Windows 11。" /SD IDOK
    Abort
  ${EndIf}
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ${If} $0 < 17763
    MessageBox MB_ICONSTOP "需要 Windows 10 1809 或更新版本，或 Windows 11。" /SD IDOK
    Abort
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "需要 64 位 Windows 10 或 Windows 11，不支持 32 位 Windows。" /SD IDOK
    Abort
  ${EndIf}
  !if "${TARGET_ARCH}" == "arm64"
    ReadEnvStr $0 PROCESSOR_ARCHITECTURE
    ReadEnvStr $1 PROCESSOR_ARCHITEW6432
    ${If} $0 != "ARM64"
    ${AndIf} $1 != "ARM64"
      MessageBox MB_ICONSTOP "这是 ARM64 安装包。普通 Intel/AMD 电脑请选择 x64 安装包。" /SD IDOK
      Abort
    ${EndIf}
  !endif
FunctionEnd

Section "SAP MCP 主程序（内置 Node.js，离线安装）" Core
  SectionIn RO
  ReadRegStr $0 HKCU "${PRODUCT_KEY}" "InstallDir"
  ${If} $0 != ""
  ${AndIf} $0 != $INSTDIR
    MessageBox MB_ICONSTOP "更改安装目录前请先卸载旧版本；连接配置和凭据会保留。" /SD IDOK
    Abort
  ${EndIf}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=installer-control.ps1 "${STAGE_DIR}\installer-control.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-control.ps1" -Action Check -InstallDirectory "$INSTDIR"${TEST_FLAG}'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "无法安装到此目录。请关闭 SAP MCP 管理界面（托盘退出）及后台服务；不要覆盖其他文件夹。运行锁或门锁仍存在时请先核实进程状态。错误码：$0" /SD IDOK
    SetErrorLevel 10
    Abort
  ${EndIf}
  IfFileExists "$INSTDIR\install-manifest.json" 0 fresh_install
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-control.ps1" -Action RemovePayload -InstallDirectory "$INSTDIR"${TEST_FLAG}'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "旧版本文件无法安全更新，请保持现状并重试或修复安装。" /SD IDOK
    Abort
  ${EndIf}
  fresh_install:
  SetOutPath "$INSTDIR"
  File /r "${STAGE_DIR}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${PRODUCT_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "SAP MCP"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\bin\sapmcp-gui.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  SetShellVarContext current
  !ifdef TEST_MODE
    StrCpy $StartMenuDirectory "$INSTDIR\test-shortcuts\Start Menu\SAP MCP"
    StrCpy $DesktopShortcut "$INSTDIR\test-shortcuts\Desktop\SAP MCP.lnk"
    CreateDirectory "$INSTDIR\test-shortcuts\Desktop"
  !else
    StrCpy $StartMenuDirectory "$SMPROGRAMS\SAP MCP"
    StrCpy $DesktopShortcut "$DESKTOP\SAP MCP.lnk"
  !endif
  CreateDirectory "$StartMenuDirectory"
  CreateShortcut "$StartMenuDirectory\SAP MCP 管理界面.lnk" "$INSTDIR\bin\sapmcp-gui.exe"
  CreateShortcut "$StartMenuDirectory\卸载 SAP MCP.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

Section "将 sapmcp 加入当前用户 PATH（重新打开终端生效）" UserPath
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\installer-control.ps1" -Action AddPath -InstallDirectory "$INSTDIR"${TEST_FLAG}'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "PATH 设置失败。可从开始菜单启动，或修复安装后重试。" /SD IDOK
    SetErrorLevel 11
  ${EndIf}
SectionEnd

Section "创建桌面快捷方式" DesktopIcon
  CreateShortcut "$DesktopShortcut" "$INSTDIR\bin\sapmcp-gui.exe"
SectionEnd

Section "Uninstall"
  InitPluginsDir
  CopyFiles /SILENT "$INSTDIR\installer-control.ps1" "$PLUGINSDIR\installer-control.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-control.ps1" -Action Check -InstallDirectory "$INSTDIR"${TEST_FLAG}'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "请先通过托盘退出图形管理界面，并正常停止后台 MCP 服务，再卸载。不会强制结束 SAP 操作。" /SD IDOK
    SetErrorLevel 10
    Abort
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-control.ps1" -Action RemovePath -InstallDirectory "$INSTDIR"${TEST_FLAG}'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "无法清理本程序添加的 PATH，请检查当前用户权限后重试。" /SD IDOK
    Abort
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-control.ps1" -Action RemovePayload -InstallDirectory "$INSTDIR"${TEST_FLAG}'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "部分程序文件无法移除；配置及凭据未删除。请关闭占用程序后重试。" /SD IDOK
    Abort
  ${EndIf}
  SetShellVarContext current
  !ifdef TEST_MODE
    Delete "$INSTDIR\test-shortcuts\Start Menu\SAP MCP\SAP MCP 管理界面.lnk"
    Delete "$INSTDIR\test-shortcuts\Start Menu\SAP MCP\卸载 SAP MCP.lnk"
    Delete "$INSTDIR\test-shortcuts\Desktop\SAP MCP.lnk"
    RMDir "$INSTDIR\test-shortcuts\Start Menu\SAP MCP"
    RMDir "$INSTDIR\test-shortcuts\Start Menu"
    RMDir "$INSTDIR\test-shortcuts\Desktop"
    RMDir "$INSTDIR\test-shortcuts"
  !else
    Delete "$SMPROGRAMS\SAP MCP\SAP MCP 管理界面.lnk"
    Delete "$SMPROGRAMS\SAP MCP\卸载 SAP MCP.lnk"
    RMDir "$SMPROGRAMS\SAP MCP"
    Delete "$DESKTOP\SAP MCP.lnk"
  !endif
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegValue HKCU "${PRODUCT_KEY}" "InstallDir"
  DeleteRegKey /ifempty HKCU "${PRODUCT_KEY}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
