# SAP MCP

Windows CLI + Streamable HTTP MCP 服务，通过 HTTP ADT 访问 SAP ABAP，不依赖 VS Code、SAP GUI 或数据库。

当前为第一版开发实现：已通过本地模拟测试，尚未完成真实 SAP 联调。写入默认关闭，仅支持可执行 REPORT 程序的主源码。

## 环境与安装

- Windows、Node.js 22 或更新版本、npm。
- SAP 系统启用 ADT，可访问 HTTP 地址，具备相应开发权限。
- 密码保存在当前 Windows 用户的凭据管理器；不用聊天或命令行参数传递密码。

在项目目录执行：

```powershell
npm ci --ignore-scripts
npm run build
npm start -- --help
```

项目设置 npm 使用 PowerShell 执行脚本，兼容 UNC 共享目录。安装禁用依赖生命周期脚本；当前依赖的 Windows 原生模块已验证可加载，合成凭据的写入、读取和删除也已通过。

## 配置与启动

```powershell
npm start -- connection add dev
npm start -- connection list
npm start -- connection test dev
npm start -- token create
npm start -- serve --port 8765
```

`connection add` 交互询问 HTTP URL、三位 Client、用户名、语言和密码。例如 URL 使用 `http://sap-host:8000`，也接受以 `/sap/bc/adt` 结尾的地址。第一版不支持自定义代理路径、HTTPS、RFC 或 SSO。

服务地址为 `http://127.0.0.1:8765/mcp`。MCP 客户端选择 Streamable HTTP，并配置 `Authorization: Bearer <token>`。`token create` 返回令牌 ID 和一次性显示的令牌明文；配置文件只存校验哈希。客户端的凭据应按客户端支持的方式管理，不放进项目源码。

`serve` 在前台运行，用 Ctrl+C 停止。服务运行期间不能添加、编辑或删除 SAP 连接；令牌可创建或撤销，撤销立即影响后续请求。浏览器 Origin 请求全部拒绝，第一版服务仅供本机 MCP 客户端访问。

```powershell
npm start -- connection edit dev
npm start -- connection remove dev
npm start -- token revoke <token-id>
```

## Tools 与工作流程

已注册：`list_connections`、`get_capabilities`、`search_objects`、`list_package_objects`、`read_source`、`create_program`、`update_source`、`syntax_check`、`activate_objects`、`list_transport_requests`。

1. 调用 `list_connections` 获取稳定 `connection_id`。
2. 搜索对象，使用返回的相对 `object_uri` 读取 active 或 inactive 主源码。
3. 在本地连接配置中明确启用写入并指定允许的包，例如 `$TMP`。
4. 创建程序壳，或读取目标源码的 `revision` 后修改。
5. 修改时提交 `source_uri`、源码、`expected_revision` 和唯一 `request_id`。非 `$TMP` 包还需要传输任务。
6. 检查 inactive 源码。激活时提交对象 URI 和 inactive revision，再读回 active 确认。

例如 `read_source` 的参数为：

```json
{
  "connection_id": "由 list_connections 返回的 UUID",
  "object_uri": "/sap/bc/adt/programs/programs/ztest",
  "version": "active"
}
```

创建名称仅允许 Z/Y 开头的大写程序名，长度不超过 30。包列表为精确匹配，不支持通配符。已有 inactive 草稿时，不能从 active revision 直接覆盖，应先读取 inactive。源码版本使用连接、URI、版本与内容哈希生成，并在 SAP 对象锁内重新核对。

重复 `request_id` 在本次服务运行期间返回同一结果，不重复执行；修改参数需使用新 ID。结果 `unknown` 时必须查询 SAP，不直接重试。锁清理失败后，该连接的后续写入会被阻止，需核实 SAP 锁状态后再重启。

## 数据与日志

- 配置：`%APPDATA%\sap-mcp\config.json`。
- SAP 密码：Windows 凭据管理器，服务名称 `sap-mcp`，按连接 ID 保存。
- 操作日志：`%LOCALAPPDATA%\sap-mcp\logs\operations-YYYY-MM-DD-N.jsonl`，UTC 日期，每阶段追加一行，单文件上限约 5 MiB。
- 可通过 `SAP_MCP_CONFIG_DIR` 和 `SAP_MCP_LOG_DIR` 设置自定义目录。

日志不保存源码、密码、cookie、CSRF token 或锁句柄，不自动删除历史文件。重启不重放日志或恢复重复请求索引。源码和操作状态以 SAP 为准，日志不是备份。

## 验证与限制

```powershell
npm run build
npm test
```

测试使用模拟 SAP，覆盖官方 MCP HTTP 客户端、认证、URL 限制、ADT cookie/CSRF、源码读写、检查与激活，以及重复请求、版本冲突、包策略、日志失败和解锁失败。

真实系统仍需验证：REPORT 创建默认属性、active/inactive 版本语义、锁内激活、传输任务和 discovery 兼容性。包浏览返回截断状态，不实现分页。语法诊断位置暂保留后端原始行和 offset，不能假定已完成跨版本位置映射。

依赖审计存在 `abap-adt-api` 的传递依赖 `sprintf-js` 中等风险公告。当前使用点的格式模板来自库内固定常量，不接受 agent 输入格式字符串；不通过大幅降级 ADT 库处理该公告，后续跟踪上游修复。

详细设计见 [架构文档](docs/architecture.md)。
