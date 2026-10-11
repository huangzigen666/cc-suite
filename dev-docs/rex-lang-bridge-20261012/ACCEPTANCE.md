# cc-suite / rex-lang-bridge 本机接入验收

范围：`/Users/huanghao/Developer/cc-suite`、当前安装的 cc-suite 2.5.4、本机 rex-lang-bridge 0.1.0 的代码 overlay，以及 23 个现有 Skill 根。初始阶段使用分支 `feat/rex-lang-bridge-delegation-20261012`，当时仅本机接入。用户随后授权 GitHub 留存及合并 `huangzigen666/cc-suite` 的 `main`；按仓库版本规则准备 `v2.6.0`。不写只读同步知识源，Hermes 不解冻。

## 事前判断与判别检查

在真实模型探测前记录：runner 在 transport 前调用桥接，可以覆盖前台、后台和续接；Claude MCP 需代理或显式预处理。初始置信度 0.8。主要不确定性是实际 Codex 子进程加载 Hook 后会否重复桥接，以及内部结构化输出是否受到摘要指令干扰。

可推翻判断的检查：模拟 transport 收不到双语提示；原文被替换；同一标记触发第二次模型调用；故障时任务丢失；原有工具权限被改写；真实 Codex 调用出现递归桥接或不能保持要求的 JSON。事实来自代码、子进程实际接收参数、负向 fixture、哈希与 inode 读回；不以模型意见作证明。

## 实现

- 十个 runner 共用 `prepareDelegation`；六个共用 job lifecycle，其余四个在执行入口调用。原文逐字保留，英文译文以 JSON 引号附加。
- 委派使用 `--delegation`，只翻译、不精炼、不写桥接历史、不加内部中文摘要。保留项目 auto_translate 开关、原模型/provider、原 sandbox 和 output schema。
- 标记与 `REX_LANG_BRIDGE_ACTIVE` 防重复和递归；单次 45 秒上限计入 job deadline。缺失 CLI、超时、错误 JSON、返回原文不匹配或翻译警告时报告状态并使用原文。
- 新生成的 Claude MCP 注册（Codex、AGY、多工具镜像、Qoder 与 advisor）统一通过 stdio adapter，其他参数和权限保持；既有 MCP 注册按已更新的七个 cc-suite Skill 调用 `cc-suite-prepare`。旧项目注册没有批量改写，避免跨项目覆盖。
- Claude 用户输入 Hook 同步接入；23 个 Skill 根指向唯一实际文件。同步脚本有完整只读计划、并发哈希检查、同目录快照与临时文件、校验后原子 rename。

## 验证记录

已验证事实：

- `npm test`：261 个普通测试 + 41 个进程生命周期测试通过（302）。最初沙箱内 4 个进程检查失败，沙箱外执行后全部通过；保留失败记录，不改业务代码来迎合环境。
- 最终桥接专项：14 个测试通过。真实 subprocess 验证双语 transport、MCP 其他字段与权限保留、递归/重复跳过、格式错误/失败/超时透传，以及各 MCP 生成器和非受管程序拒绝。
- 最终 `tests/integration.sh`：505 项通过；显式跳过联网 boot handshake（`CC_SUITE_SKIP_BOOT_TEST=1`），不能计为验证过 pin 的真实启动。第一次使用 `/usr/bin/python3` shim 留下 `xcrun_db`，换为同一个 Python 的真实路径后通过；未改原清理逻辑或验收断言。日志 `/private/tmp/cc-suite-lang-integration-final-20261012.log`。
- 已安装的 rex-lang-bridge `npm test`：40 项通过。共享 Skill YAML、代码围栏、表格、标题/description/changelog 的版本和新增能力一致性通过；最终 34 个不同目标及所有快照哈希读回一致，23 个 Skill 根唯一 inode 为 1。二次只读 plan：0 文件、0 链接待更新；`git diff --check` 通过。
- 真实合成任务：已安装 cc-suite runner → rex-lang-bridge → Codex `gpt-6.1-sol`、`low`、`read-only`，job `lang-bridge-canary-mv4bp1mw-wfdsdt` 完成。纯 JSON `{"marker":"CC_SUITE_LANG_OK"}` 可解析；运行日志桥接成功记录为 1，未出现工具调用事件。证据 `/private/tmp/cc-suite-lang-live-Qs5LpS/evidence.json`。另一次真实翻译探测确认中文原文保留、英文参考生成、内部摘要未追加。

边界与停止条件：其他模型后端及 23 个宿主的原生加载没有逐一真实调用，保持 `NOT_VERIFIED`；现存客户端须重开会话。无可核验 Skill 根的独立桌面对话不声称已接入原生 Hook，但凡通过本机 cc-suite runner/managed MCP 发出委派，都使用同一桥接实现。Hermes 仅文件可达，不调度、不重启、不恢复 cron。无法保留原文或返回结构损坏时透传并报告，时限已用尽则停止 backend；升级改变基线或出现并发写入时停止覆盖。

23 个现有根涵盖 Claude、Codex、共享 `.agents`、Hermes、Gemini 与 AGY、CodeBuddy、Qoder（含国内侧）、Grok、Qwen、Kimi Code、WorkBuddy（两侧）、ZCode、OpenClaw、Cursor、Trae、Roo、Continue、Kiro、AiderDesk、Goose。完整绝对路径在 receipt 与同步脚本中，不用不同副本冒充同源。

## 回滚与升级

本机变更 receipt：`/Users/huanghao/.local/state/cc-suite-lang-bridge/20261011211222200/receipt.json`；MCP 生成器补齐 receipt：`/Users/huanghao/.local/state/cc-suite-lang-bridge/20261011211840372/receipt.json`。其中记录每个目标、前后哈希与同目录 `.bak`。需要回滚时逆序处理两次 receipt，先确认当前哈希仍等于 after_sha256，再用同目录临时文件校验后恢复快照。只移除 receipt 中新增且仍指向预期目标的链接；保留既有链接、其他用户改动及冻结状态。

此前已验收的本机 overlay 保持 cc-suite 插件身份 2.5.4；本次仓库合并将 package、plugin 与 fork marketplace 版本同步为 2.6.0，不自动重装本机插件。rex-lang-bridge 插件身份保持 0.1.0；共享 Skill 单独记录 v0.2.0-local。`scripts/sync-lang-bridge.mjs` 的 2.5.4 检查仍是本机 overlay 的安全基线，不表示发布版本。上游安装/更新可能覆盖 overlay；更新后先执行 `node scripts/sync-lang-bridge.mjs --plan`，基线不兼容时停止，不静默套用。
