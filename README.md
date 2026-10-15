# SAP MCP

函数接口提示：`create_function_module` 的返回结果提供 `interface_help.example_source`，使用实际函数名演示 IMPORTING、EXPORTING 和 TABLES 的 ADT 声明格式。示例仅作参考，不会自动写入；按 next_action 读取真实源码和 revision 后再调用 update_source。TABLES 使用 `TYPE BAPIRET2`，不使用旧式 `STRUCTURE`；EXCEPTIONS 声明仅列名称，不使用 CALL FUNCTION 的 `name = 1` 写法。定义区可能被 SAP 重建，持久注释放在函数体中。

读取 `inactive` 返回 `VERSION_UNAVAILABLE` 时，错误中提供 `details.next_action`，明确建议读取同一对象的 `active` 版本。服务不会静默切换或编造 revision；客户端需查看 active 源码再决定修改。缺少 inactive 版本本身不能单独证明激活成功，认证失败等其他错误也不会被改成该建议。

保存及激活后的内容校验忽略纯空行（包括只有空格或 Tab 的行）及 CRLF/LF 差异；非空行的内容、顺序、缩进、注释和字符串仍严格比较，多行字面量中的空行保留。原始源码 hash/revision 不变。函数组整体激活先按单对象请求格式依次激活快照中的未激活成员，再激活组本身，并对快照全部成员读回验证。它不是原子事务；失败结果保留已完成成员，不自动重试，也不回滚已激活对象。

Windows 本地 Web 管理界面 + Streamable HTTP MCP 服务，通过 HTTP ADT 访问 SAP ABAP，不依赖 VS Code、SAP GUI 或数据库；同时保留 CLI。

支持多连接管理、对象搜索、源码读取、Program、Include、Function Group 与 Function Module 创建，以及主源码修改、语法检查和激活。写入默认关闭，可按连接启用。

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

## 图形界面启动

安装 Node.js 22 或更新版本后，双击项目根目录的 `start-ui.cmd`。脚本会在缺少依赖时安装依赖、构建项目，然后打开本地管理界面。保持启动窗口开启，关闭窗口会结束服务进程。

管理界面默认使用 `http://127.0.0.1:8766/`，提供系统连接的添加、编辑、删除与测试，连接写入开关，MCP 令牌创建与撤销，以及 MCP 服务启停。MCP 默认端口仍为 8765，可在界面中设置。

启动时浏览器自动获得独立的管理会话凭据；只输入裸地址会显示未授权。管理会话保存在当前标签页的 sessionStorage，页面 URL 中的会话片段会立即移除。令牌明文仅在创建窗口中显示，关闭窗口后清空；管理凭据和 MCP Bearer 令牌互不通用。

先添加系统连接并测试，再创建 MCP 令牌，然后在 MCP 服务页启动服务。停止 MCP 后可编辑连接，管理界面仍可使用。管理界面不提供程序编辑或 SAP 业务执行。

也可通过命令启动：

```powershell
npm start -- ui
```

已有 CLI 服务运行时，请先停止它再启动图形界面。UI 与 CLI 共用连接配置和凭据，不能同时拥有同一配置目录的运行锁。关闭浏览器不会自动停止 MCP；通过页面停止 MCP，或在启动窗口按 Ctrl+C 退出整个管理进程。

高级选项：`ui --port <管理端口>` 修改管理端口；`ui --no-open` 不自动打开浏览器，并在终端输出含会话凭据的管理地址，请勿分享该地址。

## CLI 配置与启动

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

缓存的 SAP 会话发生认证、CSRF、网络或其他 ADT 错误时，只读操作会重建会话并重试一次；首次新会话失败不会循环重试。写操作和锁状态不确定的会话不会自动重放或重建。

每个新写请求在加锁或提交业务变更前建立新会话，通过 ADT discovery 验证登录后才继续。预检失败不加锁、不写入，并丢弃该会话。锁状态异常的连接仍禁止写入，不通过重建会话绕过保护。结果中的 `write_dispatched` 表示是否已尝试提交业务变更，不代表提交成功；为 true 且结果不确定时，应查询 SAP 核实。预检之后仍可能断线，写入不自动重试；相同 request_id 返回原结果，显式重新尝试需新 ID。

客户端 URL 必须使用 `127.0.0.1`，不能替换为 `localhost`：当前 Host 校验会拒绝后者。未提供有效令牌返回 401，Host 不匹配或携带 Origin 返回 403。

`serve` 在前台运行，用 Ctrl+C 停止。CLI 服务运行期间不能添加、编辑或删除 SAP 连接；令牌可创建或撤销，撤销立即影响后续请求。MCP 端点拒绝浏览器 Origin 请求。独立 Web 管理端口仅允许本机、同源且经过管理认证的 API 调用。

```powershell
npm start -- connection edit <连接名称>
npm start -- connection remove <连接名称>
npm start -- token revoke <令牌ID>
```

`<令牌ID>` 替换为 `token create` 输出的 `id`，不是令牌明文；执行时不保留尖括号。

## 读写控制

添加或编辑连接时，`Enable program writes?` 决定该连接的 `write_enabled`。默认关闭；关闭时仍可读取、搜索、浏览、语法检查和查询传输请求，但服务端拒绝创建、修改和激活。启用后由 SAP 检查用户权限、锁、系统可修改状态及传输任务。

没有单独的读取开关，也没有按令牌区分读写或系统的权限。所有有效 MCP 令牌都能访问已配置连接，并受连接写入开关及 SAP 权限约束。agent 不能通过 tools 修改本地权限设置。Web 界面编辑连接前停止 MCP，编辑后重新启动；CLI 编辑前退出运行进程。

## Tools 与工作流程

已注册：`list_connections`、`get_capabilities`、`search_objects`、`list_package_objects`、`read_source`、`create_program`、`create_function_group`、`create_function_module`、`list_function_group_members`、`get_function_group`、`update_source`、`syntax_check`、`activate_objects`、`list_transport_requests`、`create_transport_request`。

`search_objects` 的完整类型如 `PROG/P` 会精确过滤，类型族如 `PROG` 返回该族对象；`limit` 默认 100，最大 500。精确类型搜索在后端类型族结果中最多扫描 501 条，`truncated=true` 表示结果可能不完整，可缩小搜索条件。包列表排除没有 `OBJECT_URI` 的分类节点，先过滤再限量；返回后端节点字段，不提供分页游标。读取仅支持对象发现的主源码，不支持任意 include 片段选择。

1. 调用 `list_connections` 获取稳定 `connection_id`。
2. 搜索对象，使用返回的相对 `object_uri` 读取 active 或 inactive 主源码。
3. 在本地连接配置中明确启用写入。连接不限定包，实际读写权限由 SAP 用户权限决定。
4. 创建程序壳，或读取目标源码的 `revision` 后修改。
5. 修改时提交 `source_uri`、源码、`expected_revision` 和唯一 `request_id`。是否需要传输任务由 SAP CTS 检查决定。
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

创建名称仅允许 Z/Y 开头的大写程序名，长度不超过 30。创建时指定目标包，不需要在连接配置中预先登记。连接不限定包；服务端通过 `write_enabled` 控制写操作，具体对象的访问和修改权限由 SAP 用户权限决定，SAP 要求记录变更时需提供传输任务。已有 inactive 草稿时，不能从 active revision 直接覆盖，应先读取 inactive。源码版本使用连接、URI、版本与内容哈希生成，并在 SAP 对象锁内重新核对。

修改支持 `/sap/bc/adt/programs/programs/<名称>/source/main` 与 `/sap/bc/adt/programs/includes/<名称>/source/main`，包括已有模块池等非 REPORT Program。服务检查对象元数据类型与路径一致，并遵循 SAP 权限、锁和传输任务要求。Include 语法或激活依赖主程序上下文时，以 SAP 后端诊断为准；服务不自动激活未指定的父程序。

`create_program` 的 `program_kind` 可选 `report`（默认）、`include`、`module_pool` 或 `subroutine_pool`。创建后读回元数据核对所选类型，仅创建对象壳，不自动写入业务源码或激活。模块池的屏幕、GUI 状态等资源需要另外维护，本工具不生成。实际类型支持由目标 SAP 决定；创建后的核对失败不自动删除对象，应检查返回的对象 URI 或通过搜索确认。

例如创建 Include：

```json
{
  "connection_id": "由 list_connections 返回的 UUID",
  "name": "ZEXAMPLE_INCLUDE",
  "description": "Example include",
  "package_name": "$TMP",
  "program_kind": "include",
  "request_id": "create-example-include-001"
}
```

重复 `request_id` 在本次服务运行期间返回原操作的精简结果，不重复执行；源码不保留在重复请求缓存中，需要时使用 `read_source` 获取。缓存最多 512 条，每条序列化结果不超过 32 KiB，超大的附加详情省略并返回 `CACHED_DETAILS_OMITTED`。缓存满时拒绝新的写请求，不淘汰旧 ID；确认在途操作后可重启服务。修改参数需使用新 ID。结果 `unknown` 时必须查询 SAP，不直接重试。锁清理失败后，该连接的后续写入会被阻止，需核实 SAP 锁状态后再重启。

保存和激活后的源码读回比较允许 SAP 移除末尾换行，其他字符差异仍报 `VERIFY_FAILED`；revision 使用后端实际返回文本计算，不忽略换行。激活列表最多 20 个对象，顺序处理，失败即停止，不回滚先前已完成对象。

## 函数组与函数模块

| Tool | 用途 |
| --- | --- |
| `create_function_group` | 在指定包创建函数组（FUGR/F），返回 object_uri |
| `create_function_module` | 指定 function_group_uri，在组锁下创建空函数模块（FUGR/FF） |
| `list_function_group_members` | 列出组内函数模块和 Include（FUGR/I），默认最多 100，最大 500 |
| `get_function_group` | 读取成员源码版本并生成组快照 revision，用于整体激活 |

函数组名称创建时要求 Z/Y 开头、大写且不超过 26 字符；函数模块名称不超过 30 字符。函数模块继承函数组的包，SAP 要求记录变更时需提交 transport_task。创建组后使用返回的 URI 指定父组，不按同名 Program 推断。

函数模块及组内 Include 复用 `read_source`、`update_source`、`syntax_check` 和 `activate_objects`。函数模块修改使用模块自身的 ADT 锁，组内 Include 当前使用父组锁。成员 URI 示例：

```text
/sap/bc/adt/functions/groups/zexample/fmodules/zexample_function
/sap/bc/adt/functions/groups/zexample/includes/lzexampletop
```

成员修改与激活使用其源码 revision；函数组是容器，不通过 update_source 修改。整体激活函数组时，先调用 get_function_group，再向 activate_objects 提交组 URI 和快照 revision。组快照检查全部返回成员的 inactive 或 active 源码，超过 500 个成员时拒绝生成快照。在组锁内校验快照、解锁后再次校验，再发起激活，并读回各成员的 active 源码核对。整体激活会影响组内成员；无跨 SAP 请求的原子性保证。

当前没有结构化的函数参数维护工具。但在支持源码式接口声明的 SAP 系统中，read_source 返回的 FUNCTION 定义区可以包含参数，通过 update_source 保存、检查和激活可更新接口。可选 IMPORTING 整型参数和 TABLES 的 BAPIRET2 参数已完成保存、检查、激活与恢复验证；其他接口特性需要分别验证。不要把旧式 Local Interface 注释等同于可编辑声明。本服务不执行函数模块，也不自动生成 RFC/BAPI 属性。

`list_connections` 返回连接名称、`connection_id`、`base_url`、`client`、`language`、`username` 和 `write_enabled`，不返回密码或令牌。写入前应确认目标系统和 Client，不能仅凭连接名称判断。

### 创建传输请求

先调用 `list_transport_requests` 检查是否已有合适的可修改任务。确认需要新请求后，使用 `create_transport_request`，例如：

```json
{
  "connection_id": "由 list_connections 返回的 UUID",
  "object_uri": "/sap/bc/adt/programs/programs/z_example",
  "package_name": "Z_DEVELOP",
  "description": "Example program development",
  "request_id": "new-request-unique-id"
}
```

`object_uri` 指向已存在或计划创建的受支持 ABAP 对象，不是 `source/main`；`package_name` 为该对象的目标包。工具面向仓库对象开发请求，传输属性由 SAP CTS 决定，不支持任意指定 Customizing 或复制请求类型。连接必须启用写入，CTS 必须确认需要记录变更；本地包无需记录或检查不明确时，不创建请求。

返回的 `transport_number` 是 SAP 创建接口返回的编号，可能是请求号或任务号；`request_number` 是读回确认的可修改 Workbench 父请求号，`tasks` 列出当前用户的任务号、所有者及 SAP 状态（最多 20 条，另有 `tasks_truncated`）。先确认任务可修改，再把任务号传入后续创建或更新的 `transport_task`；不自动选择任务，也不保证 SAP 一定创建了当前用户的任务。工具不会创建程序、修改源码或释放请求。

`TRANSPORT_VERIFY_FAILED` 表示创建已获 SAP 接受，但读回未能确认；错误详情保留已返回编号及查询指引。网络结果未知或 `TRANSPORT_RESPONSE_INVALID` 时，可能已产生请求，必须先查询再决定后续操作，不能直接换 `request_id` 重建。同一个 `request_id` 仅在本次服务进程内防止重复创建；重启后须重新核实实际状态。本功能已通过模拟 SAP 测试，实际后端兼容性需在目标系统验证。

是否需要 `transport_task` 由 SAP 的变更记录要求决定，不能仅看包名。`$TMP` 可省略；其他包在省略任务时，会先调用只读 ADT CTS 检查：成功且明确无需记录变更时允许继续，明确需要时返回 `TRANSPORT_REQUIRED`，失败、字段缺失或结果不明确时返回 `TRANSPORT_CHECK_UNAVAILABLE`，均不会试写。已显式提供任务时直接交由 SAP 校验。服务不自动选择、记忆或继承任务；需要记录时每次创建和 `update_source` 都应显式提交。先用 `list_transport_requests` 查询任务，有歧义时询问用户，不把父请求号直接当成任务号。

创建程序或函数模块后，按返回的 `data.next_action.tool` 和 `data.next_action.arguments` 调用 `read_source`，获取 SAP 元数据中发现的真实 `source_uri` 和 revision，不要自行拼接源码路径。初始读取请求为 inactive；如果该版本不存在，应明确读取 active，不假定两个版本相同。函数组容器没有主源码，创建后指引调用 `get_function_group` 获取组快照。

`update_source` 接受 `object_uri` 或已有的 `source_uri`，至少提供一个；同时提供时必须指向同一对象和后端发现的主源码。只提供 `object_uri` 时，服务在锁内读取元数据并确定源码地址。两种入口都必须提供先前 `read_source` 返回的 `expected_revision`，不会跳过草稿保护。

`VERSION_CONFLICT` 的 `error.details` 附对象、实际读到的 active/inactive revision、下一步读取调用和操作指引。未读到的 revision 不返回。先读取并审阅当前内容，再决定如何合并或修改；不要只替换 revision 后自动重试。草稿不存在且 active 已变化时，会指引读取 active。

`update_source` 的 `source_save` 独立说明保存与校验状态，即使顶层 `status=error` 也必须检查：

- `saved=false`：尚未发出源码保存请求；`saved="unknown"`：已发出，但未确认 SAP 接受；`saved=true`：SAP 已接受保存，不代表内容校验通过，也不代表已激活。
- `verification` 为 `not_run`、`pending`、`passed`、`failed` 或 `unavailable`，分别表示未运行、待完成、通过、不一致或读回失败。
- 成功读回时提供 `inactive_revision`，并附对象与源码 URI。该 revision 不是自动重试令牌；遇到 `VERIFY_FAILED` 或未知结果，应先用 `read_source(version="inactive")` 核实草稿，必要时对比 active，再决定编辑或激活。重复原 `request_id` 仅返回已记录的结果，不代表当前实时状态。

函数定义区的 `EXCEPTIONS` 只列异常名，例如 `INVALID_INPUT.`，不能写 `INVALID_INPUT = 1`；返回码映射属于 `CALL FUNCTION` 调用语法。定义区注释可能被 SAP 重建或删除，实现区自定义注释不要使用保留前缀 `*"` 或 `*"---`。函数模块遇到 HTTP 400 的接口扫描错误时，响应附 `error.details.hints` 列出排查建议，保留 SAP 错误码和脱敏消息，不自动修改源码，也不将通用错误固定解释为某一原因。

TABLES 参数使用 ADT 源码式声明，不使用旧式 `STRUCTURE BAPIRET2` 写法。下面的声明已在测试系统验证；修改已有模块时应保留其他参数和实现代码：

```abap
FUNCTION Z_EXAMPLE
  TABLES
    T_RETURN TYPE BAPIRET2 OPTIONAL.

  " Existing implementation
ENDFUNCTION.
```

定义区在最后一个参数声明后以句点结束。SAP 会从持久化接口重新生成定义区，可能调整格式。函数模块保存和激活验证可接受已支持定义区的空格、换行和标识符大小写变化，但参数名称、顺序、方向、传值方式、类型、可选性、默认值与异常声明必须一致；字符串字面量保留原文。实现区沿用原有校验，不全局折叠空格或忽略注释。语法参考 [SAP ADT Definition Part](https://help.sap.com/docs/SAP_NETWEAVER_750/c238d694b825421f940829321ffa326a/93351be1742d4ead9addd9f5d0b05b7e.html)。

当定义区经等价比较通过时，`source_save.normalization_applied=true`。定义区注释变化返回 `FUNCTION_DEFINITION_COMMENTS_CHANGED` 警告，不承诺保留注释。无法解析的语法退回原有校验，不猜测等价；校验失败的 `source_save.difference` 区分 `interface`、`implementation`、`unsupported_definition` 或其他对象的 `source`。复杂表类型、组件路径、pragma、字符串模板默认值等暂不做等价解析；返回的源码和 revision 始终来自实际回读，不使用规范化源码替代。

后端操作失败时，`error.details` 按可用信息返回 `http_status`、脱敏的 `sap_message`、`sap_error_type`、`sap_message_id` 和 `sap_message_number`。不返回原始响应、请求头或认证信息，消息中的锁句柄等敏感值被替换。`get_capabilities` 的 `source_lock_policy.function_module` 应为 `module`，可用于确认服务已加载函数模块自身锁的实现。重试写操作需使用新的 request_id；旧 ID 返回缓存结果。

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

Web 管理接口测试覆盖独立认证、跨站请求拒绝、密码与配置管理、令牌撤销以及服务生命周期。可选浏览器检查使用 Playwright，构建后运行 `node scripts/browser-check.mjs`；通过 `PLAYWRIGHT_MODULE`、`BROWSER_EXECUTABLE` 指定已有 Playwright 模块和浏览器。该检查使用独立临时配置和模拟 SAP，截图输出到忽略目录 `.sap-mcp/browser-check`。

包浏览不实现分页。语法诊断位置仍保留后端原始 line 和 offset，`position_format` 标明后端原生格式，没有统一转换成 1-based 行列。客户端取消或断开连接不保证 SAP 操作停止，应通过读回核实；应用没有实现主动取消后端写入。更换 SAP 系统或用户后，应重新进行连接与工作流程验证。

依赖审计存在 `abap-adt-api` 的传递依赖 `sprintf-js` 中等风险公告。当前使用点的格式模板来自库内固定常量，不接受 agent 输入格式字符串。可通过 `npm audit` 检查当前依赖公告。

锁回收竞态保护、异常门锁恢复步骤和依赖告警说明见 [安全说明](docs/security.md)。升级后首次启动前，请先关闭所有旧版本 SAP MCP 进程。

详细设计见 [架构文档](docs/architecture.md)。
