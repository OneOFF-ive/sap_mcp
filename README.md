# SAP MCP

Windows CLI + Streamable HTTP MCP 服务，通过 HTTP ADT 访问 SAP ABAP，不依赖 VS Code、SAP GUI 或数据库。

支持多连接管理、对象搜索、源码读取，以及可执行 REPORT 程序的创建、修改、语法检查和激活。写入默认关闭，可按连接启用。

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

项目使用 PowerShell 执行 npm 脚本，支持 UNC 共享目录。上述安装命令禁用依赖生命周期脚本。

以下示例直接使用 `npm`，命令需在项目目录中执行。

## 配置与启动

```powershell
npm start -- connection add <连接名称>
npm start -- connection list
npm start -- connection test <连接名称>
npm start -- token create
npm start -- serve --port 8765
```

`connection add` 交互询问 HTTP URL、三位 Client、用户名、语言和密码。例如 URL 使用 `http://sap-host:8000`，也接受以 `/sap/bc/adt` 结尾的地址。当前不支持自定义代理路径、HTTPS、RFC 或 SSO。

`<连接名称>` 是占位符，执行前替换为自定义名称，不要输入尖括号。实际名称仅允许英文字母、数字、下划线和连字符，例如 `sap_system_01`；添加与测试时使用同一个名称。支持多个连接，各名称必须唯一。

`connection add <连接名称>` 仅保存配置与凭据；`connection test <连接名称>` 按名称选取对应配置，登录并获取 ADT discovery，结束后退出测试会话，不建立永久连接。测试成功不代表具有所有对象的读写权限。MCP 操作使用 `list_connections` 返回的 `connection_id` 选择系统，不按名称自动判断系统用途。

服务地址为 `http://127.0.0.1:8765/mcp`。MCP 客户端选择 Streamable HTTP，并配置 `Authorization: Bearer <token>`。`token create` 返回令牌 ID 和一次性显示的令牌明文；配置文件只存校验哈希。客户端的凭据应按客户端支持的方式管理，不放进项目源码。

客户端 URL 必须使用 `127.0.0.1`，不能替换为 `localhost`：当前 Host 校验会拒绝后者。未提供有效令牌返回 401，Host 不匹配或携带 Origin 返回 403。

`serve` 在前台运行，用 Ctrl+C 停止。服务运行期间不能添加、编辑或删除 SAP 连接；令牌可创建或撤销，撤销立即影响后续请求。浏览器 Origin 请求全部拒绝，服务仅供本机 MCP 客户端访问。

```powershell
npm start -- connection edit <连接名称>
npm start -- connection remove <连接名称>
npm start -- token revoke <令牌ID>
```

`<令牌ID>` 替换为 `token create` 输出的 `id`，不是令牌明文；执行时不保留尖括号。

## 读写控制

添加或编辑连接时，`Enable program writes?` 决定该连接的 `write_enabled`。默认关闭；关闭时仍可读取、搜索、浏览、语法检查和查询传输请求，但服务端拒绝创建、修改和激活。启用后由 SAP 检查用户权限、锁、系统可修改状态及传输任务。

没有单独的读取开关，也没有按令牌区分读写或系统的权限。所有有效 MCP 令牌都能访问已配置连接，并受连接写入开关及 SAP 权限约束。agent 不能通过 tools 修改本地权限设置。修改连接需停止服务，完成后重启。

## Tools 与工作流程

已注册：`list_connections`、`get_capabilities`、`search_objects`、`list_package_objects`、`read_source`、`create_program`、`update_source`、`syntax_check`、`activate_objects`、`list_transport_requests`。

`search_objects` 的完整类型如 `PROG/P` 会精确过滤，类型族如 `PROG` 返回该族对象；`limit` 默认 100，最大 500。精确类型搜索在后端类型族结果中最多扫描 501 条，`truncated=true` 表示结果可能不完整，可缩小搜索条件。包列表排除没有 `OBJECT_URI` 的分类节点，先过滤再限量；返回后端节点字段，不提供分页游标。读取仅支持对象发现的主源码，不支持任意 include 片段选择。

1. 调用 `list_connections` 获取稳定 `connection_id`。
2. 搜索对象，使用返回的相对 `object_uri` 读取 active 或 inactive 主源码。
3. 在本地连接配置中明确启用写入。连接不限定包，实际读写权限由 SAP 用户权限决定。
4. 创建程序壳，或读取目标源码的 `revision` 后修改。
5. 修改时提交 `source_uri`、源码、`expected_revision` 和唯一 `request_id`。非 `$TMP` 包还需要传输任务。
6. 检查 inactive 源码。激活时提交对象 URI 和 inactive revision，再读回 active 确认。

激活前在编辑锁内校验版本，然后释放编辑锁、再次校验版本，再交由 SAP 激活接口获取所需锁；持有编辑锁会阻挡部分系统的激活。释放锁到发出请求之间仍有短暂并发窗口，激活后读回校验用于发现结果差异，不承诺远程原子性。

例如 `read_source` 的参数为：

```json
{
  "connection_id": "由 list_connections 返回的 UUID",
  "object_uri": "/sap/bc/adt/programs/programs/ztest",
  "version": "active"
}
```

创建名称仅允许 Z/Y 开头的大写程序名，长度不超过 30。创建时指定目标包，不需要在连接配置中预先登记。旧配置中的 `allowed_packages` 字段加载时自动忽略，再次保存配置时移除，无需重新添加连接。已有 inactive 草稿时，不能从 active revision 直接覆盖，应先读取 inactive。源码版本使用连接、URI、版本与内容哈希生成，并在 SAP 对象锁内重新核对。

重复 `request_id` 在本次服务运行期间返回同一结果，不重复执行；修改参数需使用新 ID。结果 `unknown` 时必须查询 SAP，不直接重试。锁清理失败后，该连接的后续写入会被阻止，需核实 SAP 锁状态后再重启。

保存和激活后的源码读回比较允许 SAP 移除末尾换行，其他字符差异仍报 `VERIFY_FAILED`；revision 使用后端实际返回文本计算，不忽略换行。激活列表最多 20 个对象，顺序处理，失败即停止，不回滚先前已完成对象。

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

测试使用模拟 SAP，覆盖官方 MCP HTTP 客户端、认证、URL 限制、ADT cookie/CSRF、源码读写、检查与激活，以及重复请求、版本冲突、传输任务要求、旧配置兼容、日志失败和解锁失败。

包浏览不实现分页。语法诊断位置仍保留后端原始 line 和 offset，`position_format` 标明后端原生格式，没有统一转换成 1-based 行列。客户端取消或断开连接不保证 SAP 操作停止，应通过读回核实；应用没有实现主动取消后端写入。更换 SAP 系统或用户后，应重新进行连接与工作流程验证。

依赖审计存在 `abap-adt-api` 的传递依赖 `sprintf-js` 中等风险公告。当前使用点的格式模板来自库内固定常量，不接受 agent 输入格式字符串。可通过 `npm audit` 检查当前依赖公告。

详细设计见 [架构文档](docs/architecture.md)。
