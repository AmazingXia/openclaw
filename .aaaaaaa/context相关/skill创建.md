---
name: skill-creator
description: 创建有效技能的指南。当用户希望创建新技能（或更新现有技能）以用专业知识、工作流或工具集成扩展 Codex 能力时使用本技能。
metadata:
  short-description: 创建或更新技能
---

# Skill Creator（技能创建器）

本技能提供创建有效技能的指导。

## 关于技能（Skills）

技能是模块化、自包含的文件夹，通过提供专业知识、工作流和工具来扩展 Codex 的能力。可将其视为特定领域或任务的「入门指南」——它们把 Codex 从通用代理变成具备流程性知识的专项代理，而这些知识是单一模型无法完全拥有的。

### 技能提供什么

1. **专项工作流**：针对特定领域的多步骤流程
2. **工具集成**：与特定文件格式或 API 协作的说明
3. **领域专长**：公司专属知识、模式、业务逻辑
4. **捆绑资源**：用于复杂、重复任务的脚本、参考文档和素材

## 核心原则

### 简洁为王

上下文窗口是共享资源。技能与系统提示、对话历史、其他技能的元数据以及用户真实请求一起占用同一上下文。

**默认假设：Codex 已经足够聪明。** 只添加 Codex 尚未拥有的上下文。对每条信息都问：「Codex 真的需要这段解释吗？」「这段落是否对得起它的 token 成本？」

优先用简洁示例，而非冗长说明。

### 设定合适的自由度

根据任务的脆弱性和可变性匹配具体程度：

- **高自由度（文本式说明）**：多种做法都成立、决策依赖上下文、或由启发式引导时使用。
- **中自由度（伪代码或带参数的脚本）**：存在偏好模式、允许一定变化、或配置影响行为时使用。
- **低自由度（具体脚本、少量参数）**：操作脆弱易错、一致性关键、或必须按特定顺序执行时使用。

可把 Codex 想象成在探路：悬崖边的窄桥需要明确护栏（低自由度），开阔地则允许多条路线（高自由度）。

### 技能结构解剖

每个技能包含一个必需的 SKILL.md 文件及可选的捆绑资源：

```
skill-name/
├── SKILL.md （必需）
│   ├── YAML frontmatter 元数据（必需）
│   │   ├── name:（必需）
│   │   └── description:（必需）
│   └── Markdown 说明（必需）
├── agents/（推荐）
│   └── openai.yaml - 技能列表与芯片用的 UI 元数据
└── Bundled Resources（可选）
    ├── scripts/          - 可执行代码（Python/Bash 等）
    ├── references/       - 按需加载到上下文的文档
    └── assets/           - 用于输出的文件（模板、图标、字体等）
```

#### SKILL.md（必需）

每个 SKILL.md 包含：

- **Frontmatter（YAML）**：包含 `name` 和 `description` 字段。Codex 仅根据这两项判断何时使用该技能，因此必须清晰、完整地描述技能是什么以及何时使用。
- **正文（Markdown）**：使用该技能及其捆绑资源的说明与指导。**仅在技能被触发后才加载**（若有加载）。

#### Agents 元数据（推荐）

- 面向 UI 的元数据，用于技能列表和芯片展示
- 生成取值前请阅读 references/openai_yaml.md，并遵循其描述与约束
- 通过阅读技能内容创建面向人类的 `display_name`、`short_description` 和 `default_prompt`
- 通过 `--interface key=value` 传给 `scripts/generate_openai_yaml.py` 或 `scripts/init_skill.py` 以确定性生成
- 更新时：校验 `agents/openai.yaml` 是否仍与 SKILL.md 一致；若过时则重新生成
- 仅在用户明确提供时才包含其他可选接口字段（图标、品牌色等）
- 字段定义与示例见 references/openai_yaml.md

#### 捆绑资源（可选）

##### 脚本（`scripts/`）

需要确定性可靠或会被反复重写的任务，用可执行代码（Python/Bash 等）。

- **何时包含**：同一段代码被反复重写，或需要确定性可靠时
- **示例**：PDF 旋转任务用 `scripts/rotate_pdf.py`
- **好处**：省 token、可重复、可不读入上下文直接执行
- **注意**：脚本仍可能被 Codex 读取以打补丁或做环境相关调整

##### 参考（`references/`）

按需加载到上下文的文档与参考资料，用于支撑 Codex 的流程与思考。

- **何时包含**：Codex 在工作时需要查阅的文档
- **示例**：`references/finance.md` 财务模式、`references/mnda.md` 公司 NDA 模板、`references/policies.md` 公司政策、`references/api_docs.md` API 规范
- **用途**：数据库模式、API 文档、领域知识、公司政策、详细工作流指南
- **好处**：保持 SKILL.md 精简，仅在 Codex 认为需要时加载
- **实践**：若文件较大（>10k 词），在 SKILL.md 中提供 grep 搜索模式
- **避免重复**：信息只放在 SKILL.md 或 references 之一，不要两处都有。除非确属技能核心，否则详细内容优先放在 references——这样 SKILL.md 保持精简，信息可被发现又不占满上下文。SKILL.md 只保留必要的流程说明和工作流指引；详细参考、模式与示例移到 references。

##### 素材（`assets/`）

不打算读入上下文，而是在 Codex 产出结果时使用的文件。

- **何时包含**：技能需要会在最终输出中用到的文件时
- **示例**：`assets/logo.png` 品牌素材、`assets/slides.pptx` PPT 模板、`assets/frontend-template/` HTML/React 脚手架、`assets/font.ttf` 字体
- **用途**：模板、图片、图标、脚手架代码、字体、会被复制或修改的示例文档
- **好处**：把输出资源与文档分离，让 Codex 可直接使用文件而无需载入上下文

#### 技能中不要包含的内容

技能只应包含直接支撑其功能的必要文件。**不要**创建多余文档或辅助文件，例如：

- README.md
- INSTALLATION_GUIDE.md
- QUICK_REFERENCE.md
- CHANGELOG.md
- 等等

技能只应包含 AI 代理完成当前工作所需的信息。不应包含关于创建过程、搭建与测试流程、面向用户的文档等辅助上下文。额外文档只会增加噪音和混淆。

### 渐进式披露设计原则

技能通过三级加载来高效管理上下文：

1. **元数据（name + description）**：始终在上下文中（约 100 词）
2. **SKILL.md 正文**：技能触发时加载（<5k 词）
3. **捆绑资源**：由 Codex 按需加载（脚本可不读入上下文直接执行，故理论上不限）

#### 渐进式披露模式

将 SKILL.md 正文控制在要点以内、500 行以内，以减少上下文膨胀。接近该限制时把内容拆到独立文件。拆出时**务必**在 SKILL.md 中引用并清楚说明何时读取，让读者知道这些文件存在以及何时使用。

**关键原则**：当技能支持多种变体、框架或选项时，SKILL.md 只保留核心工作流和选择指引；把变体相关细节（模式、示例、配置）放到独立参考文件。

**模式 1：高层指南 + 参考链接**

```markdown
# PDF 处理

## 快速开始

用 pdfplumber 提取文本：
[代码示例]

## 高级功能

- **表单填写**：完整指南见 [FORMS.md](FORMS.md)
- **API 参考**：所有方法见 [REFERENCE.md](REFERENCE.md)
- **示例**：常见模式见 [EXAMPLES.md](EXAMPLES.md)
```

Codex 仅在需要时加载 FORMS.md、REFERENCE.md 或 EXAMPLES.md。

**模式 2：按领域组织**

多领域技能按领域组织，避免加载无关上下文：

```
bigquery-skill/
├── SKILL.md（概览与导航）
└── reference/
    ├── finance.md（收入、计费指标）
    ├── sales.md（商机、管线）
    ├── product.md（API 使用、功能）
    └── marketing.md（活动、归因）
```

用户问销售指标时，Codex 只读 sales.md。

类似地，支持多框架或变体的技能按变体组织：

```
cloud-deploy/
├── SKILL.md（工作流 + 厂商选择）
└── references/
    ├── aws.md（AWS 部署模式）
    ├── gcp.md（GCP 部署模式）
    └── azure.md（Azure 部署模式）
```

用户选 AWS 时，Codex 只读 aws.md。

**模式 3：条件性细节**

正文写基础内容，高级内容用链接：

```markdown
# DOCX 处理

## 创建文档

新文档用 docx-js。见 [DOCX-JS.md](DOCX-JS.md)。

## 编辑文档

简单编辑直接改 XML。

**修订与批注**：见 [REDLINING.md](REDLINING.md)
**OOXML 细节**：见 [OOXML.md](OOXML.md)
```

Codex 仅在用户需要这些功能时读取 REDLINING.md 或 OOXML.md。

**重要指引：**

- **避免深层嵌套引用**：引用相对 SKILL.md 只深一层，所有参考文件都从 SKILL.md 直接链接。
- **长参考文件要有结构**：超过 100 行的文件在顶部放目录，便于 Codex 预览时把握全貌。

## 技能创建流程

技能创建包含以下步骤：

1. 用具体示例理解技能
2. 规划可复用内容（脚本、参考、素材）
3. 初始化技能（运行 init_skill.py）
4. 编辑技能（实现资源并撰写 SKILL.md）
5. 校验技能（运行 quick_validate.py）
6. 根据实际使用迭代

按顺序执行，仅在明确不适用时才跳过某步。

### 技能命名

- 仅使用小写字母、数字和连字符；将用户提供的标题规范为 hyphen-case（如 "Plan Mode" → `plan-mode`）。
- 生成名称时，长度不超过 64 字符（字母、数字、连字符）。
- 优先使用简短、以动词开头的短语描述动作。
- 按工具命名空间在有助于清晰或触发时可使用（如 `gh-address-comments`、`linear-address-issue`）。
- 技能文件夹名与技能名完全一致。

### 步骤 1：用具体示例理解技能

仅当技能的用法已经非常清晰时可跳过。即便在改现有技能时，这一步仍有价值。

要做出有效技能，必须先清楚「这个技能会怎样被用」的具体例子。理解可来自用户直接举例，或你生成示例再经用户反馈确认。

例如，做 image-editor 技能时，可问：

- 「image-editor 技能应支持哪些功能？编辑、旋转，还有别的吗？」
- 「能举几个使用这个技能的例子吗？」
- 「我能想到用户会说『去掉这张图红眼』或『把这张图旋转一下』。你还想到哪些用法？」
- 「用户说什么话时应该触发这个技能？」

为避免一次问太多，先问最关键的一两个，再根据需要追问。

当对「技能应支持什么功能」有清晰认识时，可结束本步。

### 步骤 2：规划可复用的技能内容

把具体示例变成有效技能：对每个示例做两件事——

1. 思考从零执行该示例需要怎么做
2. 找出若反复执行这些工作流，哪些脚本、参考、素材会有帮助

示例：做 `pdf-editor` 技能处理「帮我旋转这个 PDF」时：

1. 旋转 PDF 每次都要重写相同代码
2. 在技能里放一个 `scripts/rotate_pdf.py` 会有帮助

示例：做 `frontend-webapp-builder` 处理「给我做个待办应用」或「做个记录步数的仪表盘」时：

1. 写前端每次都要同样的 HTML/React 脚手架
2. 在技能里放一个 `assets/hello-world/` 模板（含脚手架项目文件）会有帮助

示例：做 `big-query` 处理「今天有多少用户登录？」时：

1. 查 BigQuery 每次都要重新发现表结构和关系
2. 在技能里放一个记录表结构的 `references/schema.md` 会有帮助

通过对每个具体示例做上述分析，列出要包含的可复用资源：scripts、references、assets。

### 步骤 3：初始化技能

此时开始真正创建技能目录与文件。

仅当要开发的技能目录已存在时可跳过；否则进入下一步。

从零创建新技能时，**务必**运行 `init_skill.py`。该脚本会生成一个模板技能目录，自动带上技能所需的基础结构，让创建更高效、可靠。

用法：

```bash
scripts/init_skill.py <skill-name> --path <输出目录> [--resources scripts,references,assets] [--examples]
```

示例：

```bash
scripts/init_skill.py my-skill --path skills/public
scripts/init_skill.py my-skill --path skills/public --resources scripts,references
scripts/init_skill.py my-skill --path skills/public --resources scripts --examples
```

脚本会：

- 在指定路径创建技能目录
- 生成带正确 frontmatter 和 TODO 占位的 SKILL.md 模板
- 用通过 `--interface key=value` 传入的 `display_name`、`short_description`、`default_prompt` 创建 `agents/openai.yaml`
- 按 `--resources` 可选创建资源目录
- 在指定 `--examples` 时可选添加示例文件

初始化后，按需定制 SKILL.md 并添加资源。若用了 `--examples`，替换或删除占位文件。

先通过阅读技能内容生成 `display_name`、`short_description`、`default_prompt`，再通过 `--interface key=value` 传给 `init_skill.py`，或之后用下面命令重新生成：

```bash
scripts/generate_openai_yaml.py <技能目录路径> --interface key=value
```

仅在用户明确提供时才包含其他可选接口字段。完整字段说明与示例见 references/openai_yaml.md。

### 步骤 4：编辑技能

在编辑（新生成或已有）技能时，记住技能是给**另一个 Codex 实例**用的。只写对 Codex 有用且不那么显而易见的信息。考虑：哪些流程知识、领域细节或可复用素材能帮助另一个 Codex 更高效地执行这些任务。

#### 从可复用内容开始

实现时先做上面规划好的可复用资源：`scripts/`、`references/`、`assets/`。注意本步可能需要用户提供内容（例如做 `brand-guidelines` 时，用户需提供品牌素材或模板放进 `assets/`，或文档放进 `references/`）。

新增脚本必须实际运行测试，确保无 bug 且输出符合预期。若类似脚本很多，可只对代表性样本做测试，在完成时间与信心之间取得平衡。

若用了 `--examples`，删除技能不需要的占位文件。只创建真正会用到的资源目录。

#### 更新 SKILL.md

**写作规范**：始终使用祈使句/不定式。

##### Frontmatter

在 YAML frontmatter 中写 `name` 和 `description`：

- `name`：技能名称
- `description`：这是技能的主要触发依据，帮助 Codex 判断何时使用。
  - 既要写技能做什么，也要写**何时使用**的具体触发/场景。
  - 所有「何时使用」都写在这里——不要写在正文。正文只在触发后才加载，所以在正文里写「何时使用本技能」对 Codex 没有帮助。
  - 例如 docx 技能的 description：「支持修订、批注、格式保留与文本提取的文档创建、编辑与分析。当 Codex 需要处理专业文档（.docx）时使用，包括：(1) 创建新文档，(2) 修改或编辑内容，(3) 处理修订，(4) 添加批注，或其它文档类任务。」

YAML frontmatter 中不要包含其它字段。

##### 正文

写使用该技能及其捆绑资源的说明与指引。

### 步骤 5：校验技能

技能开发完成后，对技能目录做一次校验，尽早发现基础问题：

```bash
scripts/quick_validate.py <技能目录路径>
```

校验脚本会检查 YAML frontmatter 格式、必填字段和命名规则。若失败，按提示修复后再次运行。

### 步骤 6：迭代

技能经过测试后，用户可能会提出改进。这常发生在刚用过技能、对表现记忆犹新的时候。

**迭代流程：**

1. 在真实任务中使用技能
2. 发现卡点或低效之处
3. 确定应如何更新 SKILL.md 或捆绑资源
4. 实施修改并再次测试
