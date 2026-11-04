# 发布到 GitHub

[返回首页](../README.md)

## 建议的仓库信息

- **Repository name:** `zotero-litthread`
- **Description:** `AI reading companion for Zotero: paper chat, knowledge cards, and collection memory. 文献问答、知识卡片与分组研究脉络。`
- **Topics:** `zotero`, `zotero-plugin`, `research`, `deepseek`, `literature-review`, `knowledge-management`, `markdown`, `latex`
- **License:** MIT；仓库已包含项目许可证与 KaTeX 原许可证。

项目仓库为 [Ghostvulture/zotero-litthread](https://github.com/Ghostvulture/zotero-litthread)。下方初始化步骤仅适用于新建仓库；现有仓库后续发布从构建发行附件开始。

## 1. 建立空仓库

在自己的 GitHub 账户下创建 `zotero-litthread`，设为 Public。不要额外初始化 README、许可证或 `.gitignore`，因为这些文件已经在本地准备好。

使用终端时，在本目录运行：

```bash
git init -b main
git add .
git status
git commit -m "Prepare LitThread 0.3.4 for open source"
```

首次提交需要在自己的电脑配置 Git 提交身份。随后使用 GitHub 新仓库页面提供的真实地址添加远程并推送：

```text
git remote add origin <新仓库页面提供的 HTTPS 或 SSH 地址>
git push -u origin main
```

尖括号这一段需要替换，不能原样复制。也可以使用 GitHub Desktop 将这个目录添加为本地仓库后发布。

`.gitignore` 会排除 `dist/`、测试工作目录、缓存与本地设置。提交前核对 `git status`，仅纳入项目源码和随附文档；不要额外拷入自己的 Zotero profile、API Key、论文或知识目录。

## 2. 构建发行附件

```bash
npm test
python3 scripts/build.py
```

Windows 也可用 `py -3 scripts/build.py`。在 GitHub 创建 `v0.3.4` Release，附上：

```text
dist/zotero-litthread-0.3.4.xpi
dist/zotero-litthread-0.3.4-source.zip
dist/SHA256SUMS.txt
```

Release 标题建议为 **LitThread 0.3.4 · 研脉**。说明可采用下面的文本，并保留实际测试范围：

> LitThread（研脉）是 Research Companion 的开源名称。本版修复普通对话遗漏分组材料的问题，支持读取最多六篇同组论文的有限片段用于对照，并省略空记忆和空批注。
>
> 保留文章问答、Markdown / LaTeX、回到本轮提问、知识卡片和分组 memory。原有用户直接从文件安装新版 XPI 即可覆盖升级，插件 ID 与数据目录沿用旧版。
>
> 安装清单范围为 Zotero 7.0–10.0.x。实测结果见仓库 docs/TESTING.md；Windows / macOS 原生运行和真实 DeepSeek 账户仍需用户验证。

## 3. 后续版本

同步修改 `manifest.json` 与 `package.json` 中的版本，更新 CHANGELOG，执行与修改相称的测试，再构建 XPI 和发布对应版本标签。保留插件 ID `research-companion@local.zotero`，否则 Zotero 会把它识别成另一款插件。

目前是手动文件升级，**发布 GitHub Release 不会自动启用 Zotero 在线更新**。未来启用自动更新还需要公开托管 `updates.json`，填入真实的包下载地址、版本和兼容信息，再更新清单的 `update_url`。当前保留域名是占位用途，不能当作更新服务。

源码 ZIP 不包含构建输出或测试 profile。正式 XPI 只包含运行所需文件、项目 LICENSE 和第三方声明，测试脚本不会随插件安装执行。
