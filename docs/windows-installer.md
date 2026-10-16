# Windows 安装包

适用 SAP MCP 0.1.0，Windows 10 1809+ / Windows 11，64 位。

## 安装与首次使用

1. Intel / AMD 电脑选择 `SAPMCP-0.1.0-win-x64-setup.exe`；Windows ARM 电脑选择 `SAPMCP-0.1.0-win-arm64-setup.exe`。不支持 32 位 Windows。
2. 双击安装包。默认安装到 `%LOCALAPPDATA%\Programs\SAPMCP`，仅供当前用户使用。保留“加入 PATH”和“桌面快捷方式”两个默认选项。
3. 双击桌面或开始菜单中的 **SAP MCP 管理界面**（桌面名为 **SAP MCP**）。界面通过默认浏览器打开，运行期间右下角有托盘图标，没有常驻终端窗口。
4. 在页面添加 SAP 连接、测试连接、创建 MCP 令牌并启动 MCP。客户端使用 `http://127.0.0.1:8765/mcp`，配置对应 Bearer 令牌；详见 [部署与运维](operations.md)。

安装包已包含 Node.js、生产依赖、Windows 原生凭据模块和应用本地 VC 运行库。安装过程不需要联网，也不要求用户另装开发工具；访问 SAP 仍需要相应网络和权限。管理界面采用本地 Web 页面，电脑需要可用的默认浏览器。

关闭浏览器标签页后，进程继续运行。双击托盘图标或再次点击快捷方式可以重新打开页面。通过托盘菜单 **退出 SAP MCP 管理** 正常关闭管理进程及其 MCP 服务；退出会等待正在进行的操作。

## 在任意目录使用命令

安装后关闭并重新打开终端，再执行：

```powershell
sapmcp --help
sapmcp --version
sapmcp status --json
sapmcp doctor --json
```

如果终端由编辑器或 AI 客户端提供，也需要重启提供终端的应用，使其获得新 PATH。未选择 PATH 组件时，可以使用完整路径 `"$env:LOCALAPPDATA\Programs\SAPMCP\bin\sapmcp.exe"`，在 PowerShell 中在该路径前加 `&`。

`sapmcp ui` 保留前台命令行为；快捷方式使用独立托盘启动器。AI 客户端启动后台实例使用 `sapmcp service start --json`。界面与后台实例共用同一运行锁，应先正常退出当前所有者再切换模式。更多操作见 [AI 终端管理](ai-management.md)。

默认配置位于 `%APPDATA%\sap-mcp`，日志位于 `%LOCALAPPDATA%\sap-mcp\logs`，密码位于当前用户的 Windows 凭据管理器。程序目录与用户数据分开；`SAP_MCP_CONFIG_DIR` 自定义配置目录仍可使用。

## 升级与卸载

升级前先通过托盘退出管理界面，或用 `sapmcp service stop --json` 正常停止已管理的后台实例，再运行新安装包并使用原安装目录。安装程序发现运行中的程序、运行锁或无法确认的状态时会停止安装，不结束进程、不删除锁。存在异常锁时按 [安全说明](security.md) 核实进程后恢复。

从 Windows“设置 → 应用”或开始菜单的卸载入口移除程序。卸载会清理本程序添加的 PATH 项、快捷方式与登记的程序文件，保留连接配置、令牌、日志、凭据和未登记文件。若需清除个人数据，应另外明确选择要删除的内容。更改安装位置前先卸载旧位置，再重新安装。

本版本安装包尚未进行发布者代码签名。正式对外发行前应签名并在干净的 Windows 10/11 x64 与 ARM64 环境完成验收；当前开发机测试不能替代这一覆盖。

## 开发者构建与验证

在 Windows 项目目录先执行 `npm ci --ignore-scripts`，然后执行 `npm run package:windows`。构建需要 Node.js/npm、Windows 自带的 .NET Framework C# 编译器和 PowerShell 5.1。首次构建需要联网；用户安装生成的包时无需联网。

构建会运行测试，下载 `packaging/windows/download-lock.json` 固定 SHA256 的 Node.js、NSIS 和微软 VC 运行库，并验证微软运行库及所选 DLL 的有效微软签名。VC 包只作为 CAB 数据解包，不执行其安装程序，不安装全局组件。发布时更新版本与下载锁，不关闭哈希校验。微软动态下载 URL 如果变更，构建会拒绝新哈希，需显式审核并更新锁文件。

```powershell
npm run package:windows
# 只构建一个处理器版本（已完成测试时可用 -SkipTests）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packaging/windows/build.ps1 -Architecture x64
# 在本机可运行对应架构时验证安装、命令、升级与卸载
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packaging/windows/smoke-test.ps1 -Architecture x64
```

产物在 `outputs/installers`，每个 `.exe` 附带 `.sha256`。安装包只包含明确选定的应用文件和生产依赖；源码、测试、本地连接配置、凭据、缓存均不打包。第三方许可随包提供：Node 位于 `runtime/LICENSE`，VC 运行库与 NSIS 位于 `licenses`，依赖许可位于各 `app/node_modules` 包中。

隔离安装测试使用专用临时目录和 `HKCU\Software\SAPMCPInstallerTest`，不修改真实用户 PATH 或桌面；测试快捷方式放在测试安装目录内。测试会保留临时文件用于排错，不应将 `-test-setup.exe` 作为发行包分发。不同架构的测试依次执行，因为它们使用同一个测试注册表位置。

构建包含目标 Node 与原生凭据模块的执行检查。x64 Windows 不能执行 ARM64 检查，因此在 x64 构建机选择 `-Architecture x64`，ARM64 产物在 ARM64 构建机生成。ARM64 Windows 11 可以在支持 x64 模拟的环境生成并检查两个版本。
