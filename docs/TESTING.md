# 测试与验收

[返回首页](../README.md)

本页保留各版本的独立测试记录。0.3.3 引入新的项目名称与侧栏宽度自适应。安装清单允许 Zotero 7.0–10.0.x；清单范围不等于每个版本和操作系统都完成实测。

## 0.3.4 结果

- 单元测试 **121/121**：[结果](reports/unit-v034.json)。新增普通对话的同组正文、预算、取消、未分组隔离与证据保存验证。
- 官方 Linux Zotero 7.0.32 **73/73**：[报告](reports/native-zotero7-v034.json)。
- 官方 Linux Zotero 10.0.7 **73/73**：[报告](reports/native-zotero10-v034.json)。检查实际 HTTP 请求包含同组第二篇论文的正文和引用编号，并省略空批注与空 memory。
- 0.3.3 → 0.3.4 覆盖升级 **31/31**：[报告](reports/upgrade-from-v033-zotero10-v034.json)。设置、memory 和对话保留。

以上集成检查使用隔离文献库与本机模拟 API，均正常退出。Windows / macOS 原生运行及真实 DeepSeek 账户未实测。侧栏重建导致的早期测试中断已通过将虚构论文准备移到打开侧栏之前解决；上述报告均为完整通过的最终运行。

## 0.3.3 历史结果

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| Node.js 单元测试 | **115/115 通过** | [结果](reports/unit-v033.json)；AI 28、应用状态 15、数据 11、Markdown 28、Math 19、memory 14 |
| 官方 Linux Zotero 7.0.32 | **70/70 通过，退出码 0** | [原生报告](reports/native-zotero7-v033.json) |
| 官方 Linux Zotero 10.0.7 | **70/70 通过，退出码 0** | [原生报告](reports/native-zotero10-v033.json) |
| Research Companion 0.3.2 → LitThread 0.3.3 | **31/31 通过，退出码 0** | Linux Zotero 10.0.7，真实 AddonManager [覆盖升级报告](reports/upgrade-from-v032-zotero10.json) |

以上为 0.3.3 的实际执行结果。原生测试使用本机模拟 API，不代表真实 DeepSeek 账户连通性。该版正式 XPI 的运行文件与原生测试包相同，升级报告同时记录了被测 XPI 的 SHA-256。

## 测试方法

单元测试使用模拟数据与 API，不需要真实 Key：

```bash
npm test
```

覆盖 AI 请求及余额、应用状态、文献与路径、Markdown、MathML、memory 与保存。测试名称和断言是验证依据，不能用进程成功退出代替逐项结果检查。

原生检查需要官方 Linux Zotero 程序，为每次执行指定一个**尚不存在**的隔离目录：

```bash
python3 scripts/native-smoke.py /path/to/zotero --work-directory /tmp/litthread-native-run
```

脚本创建临时 profile、测试文献库、合成 PDF 和本机模拟 HTTP API，不使用日常 Zotero 配置。它会启动真实 Zotero，验证插件安装、界面、数据读取、问答、余额、卡片与 memory、Markdown / MathML、窗口变化和卸载清理，并保存 JSON 报告及截图。进程崩溃、超时或报告未完成均视为失败。

覆盖升级由独立 helper 插件驱动真实 AddonManager，保持前后两个正式 XPI 原样，在同一 Zotero 进程和隔离 profile 中检查替换：

```bash
python3 scripts/upgrade-smoke.py /path/to/zotero \
  --from-xpi /path/to/research-companion-0.3.2.xpi \
  --to-xpi dist/zotero-litthread-0.3.3.xpi \
  --work-directory /tmp/litthread-upgrade-run
```

旧版 XPI 需另行准备，源码包不附带历史二进制。上面的多行命令使用 POSIX shell 续行；也可写成一行。验证包括旧节点卸载、唯一的样式和菜单、新版 DOM，以及设置、模型、memory 和对话文件保留。

## 侧栏宽度回归

宽度测试通过 Zotero 自己的 context pane 宽度属性和更新接口改变阅读侧栏，保持窗口尺寸固定，使用与原生分隔线相同的布局路径。不会直接给插件根节点伪造宽度，也不会解除宿主的最小宽度限制。

Zotero 可能把请求的较小宽度钳制到其最小宽度。报告同时记录请求值和实际根节点宽度，按实际值检验 `narrow` / `normal` / `wide` 模式。检查重点为：

- 不触发窗口 resize，也能在侧栏缩放后更新布局。
- 任务、模型、发送和停止按钮在可用区域内，长标题和长模型名称不撑破布局。
- 代码、表格和长公式在自身区域滚动，不制造整个侧栏的横向溢出。
- 草稿、模型和对话保持；设置控件在窄宽之间切换后仍可使用。
- 销毁时停止观察尺寸，避免旧视图继续响应。

本轮固定窗口为 1280 × 1000。请求侧栏宽度 240、320、480、640、800、960，再缩窄和拉宽；两版 Zotero 的插件实际宽度覆盖 **292、371.7、457.8、527.9、586.2px**。小尺寸受 Zotero 宿主钳制，不能把 240px 请求当作实际 240px 验收。

长内容夹具包含 24 项分式的行内／独立公式、2200 字符的不换行代码和 12 列表格，均验证了实际 `scrollLeft` 可改变且外层不横向溢出。宽度变化过程中的草稿、模型和对话保持，设置返回及停止按钮可操作，关闭视图后观察器断开且不再排队。

## 截图

[公式](images/math.png) · [回到本轮提问](images/jump.png) · [设置](images/settings.png) · [窄侧栏](images/sidebar-narrow.png) · [宽侧栏](images/sidebar-wide.png)

截图来自隔离配置的真实 Zotero，使用合成论文、模型回答和余额。截图里的 **110 元不是实际用户账户余额**。没有真实论文或用户 API Key 被放入截图。

## 尚未验证

- Windows / macOS 原生运行与实际分隔线拖拽；Linux 中加载 Windows 样式规则不等同 Windows 实机。
- Zotero 8 / 9 的完整原生运行。
- 真实 DeepSeek Key、账户余额和服务端输出质量。
- 所有人工长时间使用场景、不同系统字体、屏幕缩放与极端磁盘故障。

Zotero 7 独立 PDF 窗口没有这个右侧栏，请使用主窗口阅读标签页。所有跨平台支持表述均受这些实际验证范围限制。
