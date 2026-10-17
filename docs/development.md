# SapLink 开发与构建指南

本指南面向修改源码、运行测试和制作安装包的开发者。普通用户请阅读 [Windows 安装指南](windows-installer.md)；已安装应用的日常操作统一使用 [运维手册](operations.md) 中的 `saplink` 命令。

## 从源码运行

需要 Windows、Node.js 22+ 和 npm。在项目根目录的 PowerShell 执行：

```powershell
npm ci --ignore-scripts
npm run build
node dist/cli.js --help
```

这些是源码开发命令，不是安装包用户的前置步骤。后续源码 CLI 调用统一使用 `node dist/cli.js`，例如：

```powershell
node dist/cli.js ui
node dist/cli.js status --json
node dist/cli.js doctor --json
node dist/cli.js update check --json
```

`node dist/cli.js ui` 在前台运行，保持终端开启，用 Ctrl+C 正常退出；关闭浏览器不会结束进程。`start-ui.cmd` 是源码目录的便捷入口。源码与已安装应用默认共用用户配置目录，不要同时启动；需要隔离测试时使用专用 `SAPLINK_CONFIG_DIR` 和 `SAPLINK_LOG_DIR`。

运维手册中的 `saplink <参数>` 对应项目目录内的 `node dist/cli.js <参数>`。`npm start -- <参数>` 也是项目脚本入口，但不用于用户运维示例；自动化优先直接运行 Node CLI，避免 npm 附加输出影响 JSON 解析。

## 测试与接口维护

版本检查模块为 `src/updates.ts`，当前版本取自 `package.json`，更新来源固定为 `OneOFF-ive/saplink` 的 GitHub `releases/latest` 接口。正式标签须为语义版本（可带 `v` 前缀）；仅提示版本更高的正式发布，同号正式版高于本地预发布版。不是按字符串或发布时间比较版本；GitHub latest 指定的版本也不一定是所有标签中的最大版本。

检查使用独立的 `update-check.json` 缓存，不获取 runtime/config 锁。HTTP 请求不携带 SAP 或 MCP 凭据、不跟随重定向，设置 8 秒超时；不执行安装文件。模块允许注入 fetch 和时间供离线测试，覆盖比较、缓存与强制刷新、错误响应及 CLI 文本/JSON 输出。

CLI postAction 为成功启动的 `ui`、`serve`、`service _run` 接入自动检查器；定时器 unref，不单独维持进程。同一进程避免检查重叠，启动时异步检查，随后每 24 小时执行并复用缓存；SIGINT/SIGTERM 取消请求并清理定时器。`SAPLINK_AUTO_UPDATE_CHECK=0` 禁用。自动失败静默，不影响 SAP；相同新版本只通知一次。受保护的 `/api/state` 暴露最近成功的自动检查结果，Web 每分钟刷新可见页面的更新提示，不触发 GitHub 查询。不注册 MCP tool。

构建后可单独运行 `node --import tsx --test tests/updates.test.ts`。模拟测试不证明真实 GitHub 可达；发布前还需在可联网环境验证 `node dist/cli.js update check --force --json`，并确认新安装包已包含该功能。

```powershell
npm run build
npm test
```

自动化测试主要使用模拟 SAP，不等于真实系统验收。可选浏览器检查及工具实现细节见 [技术参考](technical-reference.md)。

工具 schema 和描述位于 `src/tool-definitions.ts`，注册位于 `src/server.ts`，业务行为位于 `src/operations.ts`。写操作分类集中在 `src/tool-policy.ts`，MCP annotations 与业务层写保护共用该集合；初始化客户端指引位于 `src/client-guidance.ts`。修改接口时同步核对客户端手册示例。

架构与模块职责见 [架构文档](architecture.md)，源码接口与历史实现细节见 [技术参考](technical-reference.md)。

## Windows 安装包构建与验证

程序图标原图保存在 `packaging/windows/assets/app-icon.png`。构建会从原图生成 16、24、32、48、64、128、256 像素的 Windows ICO，并写入启动器、安装程序及卸载程序。托盘直接读取安装目录的 `saplink.ico`；快捷方式和应用列表明确引用带内容哈希的 `saplink-<hash>.ico`，安装后通知 Windows 刷新图标。管理页面引用 `web/app-icon-<hash>.png` 作为侧栏标识及浏览器图标；更换原图时文件名随内容变化，避免继续命中旧缓存。`web/app-icon.png` 保留为兼容资源，构建时同步生成并自动更新页面引用。

在 Windows 项目目录先执行 `npm ci --ignore-scripts`，然后执行 `npm run package:windows`。构建需要 Node.js/npm、Windows 自带的 .NET Framework C# 编译器和 PowerShell 5.1。首次构建需要联网；用户安装生成的包时无需联网。

构建会运行测试，下载 `packaging/windows/download-lock.json` 固定 SHA256 的 Node.js、NSIS 和微软 VC 运行库，并验证微软运行库及所选 DLL 的有效微软签名。VC 包只作为 CAB 数据解包，不执行其安装程序，不安装全局组件。发布时更新版本与下载锁，不关闭哈希校验。微软动态下载 URL 如果变更，构建会拒绝新哈希，需显式审核并更新锁文件。

```powershell
npm run package:windows
# 只构建一个处理器版本（已完成测试时可用 -SkipTests）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packaging/windows/build.ps1 -Architecture x64
# 在本机可运行对应架构时验证安装、命令、升级与卸载
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packaging/windows/smoke-test.ps1 -Architecture x64
# 单独验证安装前检查：失效锁、PID 复用、活动锁、门锁与损坏锁
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packaging/windows/preflight-test.ps1
# 验证隐藏依赖、点文件、空目录清理，以及未知文件保留和路径边界
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packaging/windows/payload-test.ps1
```

### 更新版本并打包

使用发布脚本传入目标版本即可同步更新 `package.json`、`package-lock.json`，执行项目测试并生成安装包：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File packaging/windows/release.ps1 -Version 1.0.1
# x64 构建机只打包 x64
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File packaging/windows/release.ps1 -Version 1.0.1 -Architecture x64
# 已完成测试时，重新编译并打包，跳过测试
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File packaging/windows/release.ps1 -Version 1.0.1 -Architecture x64 -SkipTests
```

脚本按自身路径定位项目，从其他目录调用时请传入脚本的完整路径。项目位于普通盘符路径时，也可使用简写 `npm run release:windows -- 1.0.1`；项目位于 `\\psf\...` 等 UNC 共享目录时，使用上面的 PowerShell 命令，避免 `npm.cmd` 因 CMD 不支持 UNC 工作目录而找不到项目。

版本必须为 `主版本.次版本.修订号`，例如 `1.0.1`，每段为 0–65535 的整数；不接受 `v` 前缀、前导零或预发布后缀。默认构建 x64、ARM64，执行平台要求见下文。产物放入 `outputs/installers/<version>/`，并核对 SHA256；同版本可重新打包，不改动其他版本目录。

脚本不创建 Git 提交或标签，不运行 npm 版本生命周期钩子，也不上传发布。构建失败时保留已更新的版本号，修复错误后可使用同一命令重试；目录内存在部分文件不代表发布成功，应以脚本成功结束为准。完整安装、升级和卸载验证仍使用上面的 `smoke-test.ps1` 单独执行，发布说明需按实际变更和验证结果编写。

发布脚本自身的隔离回归检查如下。检查使用临时项目、真实 npm 版本更新和模拟构建，不更改本项目版本，也不生成真实安装包：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File packaging/windows/release-test.ps1
```

发布产物按 `package.json` 的版本号输出到 `outputs/installers/<version>/`，例如 `outputs/installers/1.0.0/`。每种架构只生成一个标准名称安装包及对应 `.sha256`，对应版本的发布说明也放在该目录；不同版本分别保留，同版本重打包只更新自己的目录，不影响其他版本。不再生成图标后缀副本。公开分发的文件保持版本唯一；更换图标或程序后更新版本号，避免覆盖同版本文件引起缓存混淆。安装包只包含明确选定的应用文件和生产依赖；源码、测试、本地连接配置、凭据、缓存均不打包。第三方许可随包提供：Node 位于 `runtime/LICENSE`，VC 运行库与 NSIS 位于 `licenses`，依赖许可位于各 `app/node_modules` 包中。

测试安装包单独输出到 `.saplink/installer-build/tests`，不进入发布目录。隔离安装测试使用专用临时目录和 `HKCU\Software\SapLinkInstallerTest`，不修改真实用户 PATH 或桌面；测试快捷方式放在测试安装目录内。测试会保留临时文件用于排错，不应将 `-test-setup.exe` 作为发行包分发。不同架构的测试依次执行，因为它们使用同一个测试注册表位置。

构建包含目标 Node 与原生凭据模块的执行检查。x64 Windows 不能执行 ARM64 检查，因此在 x64 构建机选择 `-Architecture x64`，ARM64 产物在 ARM64 构建机生成。ARM64 Windows 11 可以在支持 x64 模拟的环境生成并检查两个版本。
