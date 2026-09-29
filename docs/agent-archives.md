# Agent 配置包

高级设置支持导出 ZIP，以及导入 ZIP、TAR.GZ、TGZ（最大 64 MiB）。导入先预览，再确认覆盖全部自定义文件和 skills；缺失项清空。资料、模型、权限、渠道和个人记忆保持不变。

## 导出结构（version 2）

```text
agent.json
README.md
SOUL.md
IDENTITY.md
AGENTS.md
…其他已保存的自定义文件
skills/
  <技能名称>/
    SKILL.md
    scripts/…
    references/…
```

`agent.json` 包含格式标识 `douchat-agent`、版本、资料元数据、自定义文件清单和技能元数据（包括启用状态）。资料元数据用于描述配置包，导入不会覆盖当前联系人资料。技能目录名经过路径清理；重名追加数字后缀。

## 兼容导入

- Foundry：兼容 version 1（`customize/` 和编号技能目录）、version 2，以及外层包装目录。
- 通用 agent 目录包：识别根目录或 `agent/` 等包装目录中的自定义 Markdown、`skills/<名称>/SKILL.md`。支持 `skills/*.zip` 和根目录名称含 `skill` 的 ZIP 技能包，最多展开一层。同名技能优先使用解压目录版本。
- OpenClaw：识别压缩包中的工作空间自定义 Markdown 和 skills。包含多个工作空间时先选择，不自动合并。仅有数据库快照的备份不能导入；不执行 OpenClaw 全量恢复。
- Hermes：识别 profile / distribution 目录中的自定义 Markdown 和 skills。没有非空 `AGENTS.md` 时，将 `system_prompt.md` 映射到它。`distribution.yaml` / `config.yaml` 仅用于识别，不执行其中的配置。

仅迁移 Foundry 支持的自定义文件和技能；不迁移 USER.md、MEMORY.md、memories、会话、凭据、模型配置、MCP、插件和定时任务。技能内的脚本和资源原样保留，导入期间不执行。自定义文件中手写的敏感内容不会自动脱敏。

压缩包路径必须安全且唯一，不接受符号链接或硬链接。总解包内容限制为 64 MiB、2,000 个文件，内嵌技能 ZIP 的展开内容也计入限制。技能数量最多 50 个。
