# AI 终端管理

适用于拥有本机终端执行能力的 AI 客户端。CLI 负责管理服务本身，MCP tools 负责 SAP 对象和数据操作；服务未启动时仍可调用 CLI。当前管理平台为 Windows、Node.js 22+。

## 机器可读入口

Windows 安装包用户重新打开终端后，在任意目录使用 `sapmcp`；无需安装系统 Node.js。源码方式在项目目录将下列 `sapmcp` 替换为 `node dist/cli.js`。直接使用 CLI 可避免 `npm start` 的额外输出影响 JSON 解析：

```powershell
sapmcp status --json
sapmcp doctor --json
sapmcp connection list --json
sapmcp token list --json
```

结果包含 `schema_version: 1`、`status`，以及 `data` 或 `error`；同时检查进程退出码。诊断完成但发现问题时，doctor 返回 `status=success`、`data.healthy=false` 并退出 1；这表示报告已成功生成，并非环境健康。未知参数、缺少必要输入或操作失败返回 `status=error` 并退出 1。`--help` / `--version` 仍为普通帮助文本。

status 不输出密码、MCP 令牌、后台控制令牌或进程命令行。doctor 检查 Node/Windows、构建、配置、目录写入、令牌、运行锁、空闲端口和当前用户凭据是否存在；只用临时目录探测可写性，不更改连接或权限。默认不访问 SAP。只有显式指定 `doctor --connection dev --json` 才测试该连接登录与 discovery，成功不等于拥有全部 SAP 权限。

## 安全配置连接

```powershell
sapmcp connection add dev --url https://sap-host:443 --client 001 --username SAPUSER --language EN --password-prompt --json
sapmcp connection edit dev --language ZH --disable-writes --json
sapmcp connection test dev --json
sapmcp connection remove dev --yes --json
```

`--password-prompt` 弹出本机 Windows 密码窗口，密码通过内部管道送入 Windows 凭据管理器，不出现在 AI 命令输出、参数、环境变量或配置文件里。窗口取消、不可用或超时会失败，不保存新密码。新连接及登录地址/Client/用户名变化时必须重新录入密码；未传该选项时，JSON 模式返回 `INTERACTION_REQUIRED`，不会卡在终端询问中。

新连接默认关闭写入，只有显式 `--enable-writes` 才开启；`--disable-writes` 可关闭。删除时 `--yes` 确认删除指定连接及凭据。登录身份不变的语言/写开关修改不需要读取或重新输入密码。旧的无选项交互式 add/edit 在真实终端中继续可用。

连接修改需要 runtime 停止。AI 应记住原端口，停止自己管理的实例后修改，再恢复服务。前台 UI/serve 不会被后台管理器自动关闭。不要在聊天里传密码；无桌面交互环境下应由用户打开原管理 UI 完成凭据录入。

## 后台服务

```powershell
sapmcp service start --port 8765 --json
sapmcp service status --json
sapmcp service restart --json
sapmcp service stop --json
```

start 要求至少一个 MCP 令牌。后台进程隐藏运行，不依赖发起命令的终端保持打开。重复启动相同端口的已管理实例会返回原状态；更改端口使用 restart 的 `--port`。不指定端口的 restart 保留当前已管理端口，停止状态则默认 8765。

| state | 含义 |
| --- | --- |
| `stopped` | 没有确认存活的 runtime；旧的普通租约可能已过期 |
| `running` | 租约身份匹配，且独立控制接口确认了后台实例 |
| `external` | 前台 UI、serve 或其他进程持有 runtime；管理器不停止它 |
| `unresponsive` | 后台进程身份存在，但控制接口未确认响应；不强杀 |
| `unknown` | 进程身份或锁文件无法确认；先诊断，不自动覆盖 |

还必须检查 `lease.guard_present`。门锁存在时不自动回收；人工恢复流程仍见 [安全说明](security.md)。启动前会实际探测本机 TCP 监听，已有端口不会被接管；探测不是原子预留，实际监听失败仍按错误处理。

stop 通过单独鉴权的 loopback 控制接口请求正常关闭，等待已有请求及 SAP 会话清理。它不调用 taskkill，也不会仅凭 PID 结束其他程序。启动确认最多等待 20 秒，停止确认最多等待 30 秒；返回 `SERVICE_START_UNKNOWN` / `SERVICE_STOP_UNKNOWN` 后必须先查 status，不能盲目重复或强杀。

背景管理不是 Windows Service 安装器，没有承诺开机启动或无人值守崩溃重启。`ui` 与 `serve` 保留前台行为，`--json` 不允许误将它们作为后台命令。

## 令牌及客户端参数

```powershell
sapmcp token create --out C:\Users\USER\AppData\Roaming\sap-mcp\client-token.json --json
sapmcp client-config --token-file C:\Users\USER\AppData\Roaming\sap-mcp\client-token.json --out C:\Users\USER\AppData\Roaming\sap-mcp\connection-parameters.json --json
sapmcp token revoke TOKEN_ID --json
```

替换示例路径与 ID。父目录需要已存在，输出文件必须是新文件，不覆盖已有文件。JSON 结果只返回 ID/路径，不返回明文令牌。JSON 或被重定向的 token create 必须提供 `--out`；真实交互终端仍可一次性显示令牌。

client-config 验证令牌属于当前配置且尚未撤销，再导出 `transport`、`url`、`headers.Authorization`。这只是产品无关连接参数，不是保证适用于 Codex、WorkBuddy 等所有客户端的完整设置文件；AI 应核对目标客户端已有配置格式，保留其他服务器，并在本地脚本内读写令牌，不打印或上传文件。创建参数文件不代表客户端已成功连接。令牌撤销不会删除已写入文件的副本。

## 管理 skill 与升级

项目附带 [sap-mcp-manager](../skills/sap-mcp-manager/SKILL.md)，为终端型 AI 提供安装、配置、启停、诊断、升级和卸载边界。它不要求 MCP 服务预先运行，也不会执行 SAP 业务写入。Codex 的个人安装位置为 `%USERPROFILE%\.codex\skills\sap-mcp-manager`；其他客户端按其 skill 导入方式使用这份说明。

升级由 AI 在用户指定版本和目录内完成：记录当前版本及本地改动、停止已管理实例、更新依赖和构建、测试后恢复原端口。不要强制丢弃未提交改动；构建失败应保留现场并报告真实运行状态。自动 Git 回滚、客户端专属配置写入、Windows Service 注册以及系统软件安装没有隐藏在这些 CLI 命令中。
