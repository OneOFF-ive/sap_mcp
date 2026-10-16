# SAP MCP 文档导航

适用版本：0.1.0。核对日期：2026-10-15。文档依据本仓库实现；目标系统支持范围仍由 SAP 版本、服务配置及用户权限决定。

| 读者或目标 | 入口 |
| --- | --- |
| 首次安装与运行 | [项目 README](../README.md) |
| Windows 安装包、快捷方式与升级卸载 | [Windows 安装包](windows-installer.md) |
| agent 学习如何操作 SAP | [MCP 客户端 SAP 操作手册](mcp-client-guide.md) |
| 管理连接、令牌、服务与日志 | [部署与运维手册](operations.md) |
| 理解模块、会话、锁和版本保护 | [架构文档](architecture.md) |
| 了解安全边界与异常锁文件恢复 | [安全说明](security.md) |

## 建议阅读顺序

管理员先按运维手册启动服务并配置 MCP URL 和认证头。客户端读取操作手册的快速开始、SAP 概念及结果解释，再按具体任务选择流程。开发者修改接口时同步核对 `src/tool-definitions.ts` 的 schema、`src/server.ts` 的注册、`src/operations.ts` 的行为及客户端手册示例。

工具写入分类统一维护在 `src/tool-policy.ts`，MCP annotations 与业务层写保护共用该集合。新增写工具时必须同步该集合；初始化指引位于 `src/client-guidance.ts`。代码内部重构不等于客户端接口变化，先核对实际 schema 和行为再修改调用示例。

文档内连接 ID、对象 URI、revision、传输任务和令牌示例均不是现成环境配置；真实调用必须使用运行结果。安装和模拟测试通过不代表真实 SAP 联调通过。
