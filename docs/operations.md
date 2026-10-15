# 部署与运维手册

适用：Windows、Node.js 22+、SAP MCP 0.1.0。核对日期：2026-10-15。

## 1. 安装与启动

在项目目录的 PowerShell 执行：

```powershell
npm ci --ignore-scripts
npm run build
npm start -- --help
```

图形管理入口为 `start-ui.cmd`，也可执行 `npm start -- ui`。管理页面默认端口 8766，MCP 默认端口 8765，两者认证不同。启动终端输出的管理会话 URL 含敏感凭据，不分享；裸地址不能替代该 URL。关闭浏览器不停止进程，保留启动窗口。

页面操作顺序：添加连接 → 测试连接 → 按需要启用写入 → 创建 MCP 令牌 → 启动 MCP。编辑连接前先在页面停止 MCP。管理页面不提供源码编辑或 ABAP 执行。

## 2. CLI 操作

下面 `dev` 是示例连接名称，可替换为英文字母、数字、下划线和连字符组成的唯一名称。

```powershell
npm start -- connection add dev
npm start -- connection test dev
npm start -- connection list
npm start -- token create
npm start -- serve --port 8765
```

添加时填写 SAP HTTP/HTTPS 地址、三位 Client、用户名、语言和密码。HTTPS 使用默认 TLS 校验，不接受忽略证书开关，不自动降级。HTTP 明文传输凭据和数据，只在合适的受保护网络使用。SAP 密码由交互提示输入并保存到当前 Windows 用户的凭据管理器。

`serve` 前台运行，Ctrl+C 正常退出。UI 与 CLI 服务不能同时占用同一配置目录的运行锁。CLI 变更连接前停止占用配置目录的 UI/服务；在 UI 内变更时只需先停止其 MCP 子服务。

```powershell
npm start -- connection edit dev
npm start -- connection remove dev
npm start -- token revoke REPLACE_WITH_TOKEN_ID
```

撤销使用创建时返回的令牌 ID，不是令牌明文。令牌可在服务运行时创建或撤销，撤销对后续请求生效。配置改动后客户端应重新列出连接。

## 3. 客户端配置

| 配置项 | 值 |
| --- | --- |
| 传输 | Streamable HTTP |
| URL | `http://127.0.0.1:8765/mcp` |
| HTTP 请求头 | `Authorization: Bearer <创建时得到的令牌>` |

上表是与客户端产品无关的配置字段，不是可直接粘贴的产品配置文件。客户端若不能自定义认证头，不能按当前方式连接；具体格式以该客户端说明为准。端口变更后相应修改 URL。

必须使用 `127.0.0.1`，`localhost` 会被 Host 校验拒绝。MCP 拒绝带 Origin 的浏览器请求；不要把管理页面会话当作 MCP 令牌，也不要通过放宽校验让普通网页直接调用 MCP。客户端操作流程见 [操作手册](mcp-client-guide.md)。

## 4. 文件、权限与备份

| 数据 | 默认位置与行为 |
| --- | --- |
| 配置和令牌哈希 | `%APPDATA%\sap-mcp\config.json`；`SAP_MCP_CONFIG_DIR` 可覆盖目录 |
| SAP 密码 | Windows 凭据管理器，按连接 ID 保存 |
| JSONL 日志 | `%LOCALAPPDATA%\sap-mcp\logs`；`SAP_MCP_LOG_DIR` 可覆盖目录 |
| 操作去重 | 当前服务进程的内存；退出即清空 |

日志按 UTC 日期和约 5 MiB 大小轮转，不自动删除旧文件；每阶段追加一行，不是源码备份。查询文本、筛选值、数据结果和完整源码不写入操作日志。人工读日志时处理异常退出留下的不完整末行。

备份配置不包含 Windows 凭据；换机器或换 Windows 用户需要重新配置密码。配置包含系统地址、用户名及认证校验信息，应限制访问。不要将本地真实配置、令牌、日志和管理会话 URL 提交到仓库。

连接写入默认关闭；启用后不按包限制，也不按 MCP 令牌区分权限。所有有效令牌共用已配置 SAP 用户的权限，SAP 决定具体对象及数据访问权限。

## 5. 常见故障

| 现象 | 排查与处理 |
| --- | --- |
| HTTP 401 | 核对 MCP Bearer 令牌是否缺失、撤销或混用了管理凭据 |
| HTTP 403 | 核对是否用了 localhost、错误 Host 或携带 Origin；SAP tool 内部 403 需看其错误类别 |
| GET /mcp 返回 405 | 正常：当前没有 GET 事件流，使用支持 POST JSON 响应的 Streamable HTTP 客户端 |
| 无法添加/编辑连接 | 检查 UI/CLI 是否持有运行锁；先正常停止进程 |
| `WRITE_DISABLED` | 经用户授权后由管理员在本地启用该连接写入 |
| `AUTH_FAILED` | 更新 SAP 凭据，重新测试；勿反复重试错误密码 |
| HTTPS 证书错误 | 修复服务器证书或部署受信任的企业 CA，不禁用证书验证 |
| `SESSION_NEEDS_REVIEW` | 核实 SAP 对象锁及在途操作，确认后再重启，不能仅换连接绕过 |
| `LOG_UNAVAILABLE` | 检查日志目录访问权限和磁盘；写入前无法记日志时不会提交业务写入 |
| `REQUEST_LIMIT` | 当前进程最多记录 512 个写请求；核实在途操作后正常重启 |

`runtime.lock.guard` 或 `config.lock.guard` 异常残留的恢复必须遵循 [安全说明](security.md)；不可在其他进程可能运行时删除锁文件。

## 6. 升级与验证

先停止旧版 UI 和 CLI，等待在途操作结束，备份非敏感配置，再更新依赖与构建。升级前后保留 Windows 凭据引用，避免手工改连接 ID。不要使用强制依赖降级来消除审计告警。

```powershell
npm run build
npm test
```

这些测试使用模拟 SAP。部署后按连接测试、搜索、读取逐步验证；写入验证使用明确指定的测试对象和包，按客户端手册完成保存、语法检查、激活和读回。不要用实际生产变更测试连通性。
