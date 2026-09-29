# PLAN.md — 稳定化与清扫（按你的决定修订）

基线：`6318b27cb`（工作树 `candy-dev-tree-01`）
你的决定（原文答复，已固化到本计划）：Q1=B、Q2=删 classifier / containerization+docker / images API / Bedrock / Azure、Q3=B、Q4=A、Q5=不加任何静态检查门禁、性能不作为代码硬约束、Q6=第 2 步整段不做、Q7=删 `.zcodeignore` 与无引用脚本。

因此本计划只有 **一个执行阶段（原 Step 1：地基清扫）**；原 Step 2 整段取消，仅在 §3 留档（含"取消后仍未做"的清单，供你之后自行处理）。§6 记录决策，并有一处需要你确认的歧义。

---

## 0. 硬规则

1. **先删后加**。新抽象必须有 ≥2 个真实调用者。个人项目，不需要兼容层。
2. **不留兼容层**：删除即删除（入口、导出、测试、文档、CHANGELOG `Unreleased` 一起删）。禁止 deprecate 包装、禁止平行实现、禁止 `export *` 转口。
3. **单一事实源**：同一行为只能有一个生产实现。发现第二份就删第二份。
4. **每批全绿**：`npm run check` + 该批相关测试。不提交红灯。
5. **不新增过程负担**：**不往 `npm run check` 加任何新检查脚本**，不做棘轮，不把性能写成代码里的硬约束/断言。度量只放在 §2.0 的人工命令里，每批把 affected 数字记回 §1。
6. **不碰 `modes/interactive` 的重构**（第 2 步取消的连带结果）：只允许删除死文件与其测试，不做搬迁、不做拆分。

---

## 1. 基线（人工记录 before/after）

| 指标 | 当前值 | 测量命令 |
|---|---|---|
| src / test 行数 coding-agent | 62,718 / 59,243 | `find packages/coding-agent/src -name '*.ts' \| xargs wc -l` |
| src / test 行数 ai / tui | 24,188 / 37,943；19,262 / 18,689 | 同上换目录 |
| 测试用例数 coding-agent / ai / tui | 2283 / 1362 / 949 | `grep -rho "^\s*\(it\|test\)(" packages/X/test \| wc -l` |
| 最大文件 | `interactive-mode.ts` 5991、`agent-session.ts` 3621、`tui/components/editor.ts` 2433 | `wc -l` |
| `any` / 空 `catch {}` | ai 26/7、agent 27/0、coding-agent 69/9 | `grep -rho` |
| TUI 帧耗时（2500 组件 / 47,503 行 / 80×50） | steady 0.455、scroll 0.447、streaming 0.620、**resize 183.020 ms/frame** | `packages/tui/scripts/alt-screen-large-transcript-bench.ts` |
| TUI 每帧分配 | static 49.3 KiB、editor 83.7 KiB | `packages/tui/scripts/render-churn-bench.ts` |
| CLI 启动模块图（`--version`） | **1436 模块**（workspace 441 / node_modules 995）、**39 个 catalog JSON ≈913 KB** | §2.0 的 module load hook 脚本 |
| 各 check 步耗时 | biome 1.9s、ts-imports 1.7s、architecture 1.1s、entry-graphs 0.6s、shrinkwrap 0.6s | 见 §2.0 |

---

## 2. 唯一执行阶段：地基清扫

### 2.0 验证方式（不做门禁）

每批按需跑，不写进 `npm run check`：

- 正确性：`npm run check`（用现有检查，不加新的）、`./test.sh`、相关包的聚焦测试。
- 死代码/重复：临时脚本（写到系统临时目录，跑完删除），做法与本次分析相同：从 `packages/*/package.json` 的 `exports`/`bin` 做可达性；注意 `import "./x.ts"` 裸导入与字符串路径引用（如 `source-resolver.ts`）；函数体规范化哈希找重复。
- 启动模块图：`registerHooks({ load })` 统计 `/packages/`、`/node_modules/`、`.json`，对比 `--version` 的模块数与 JSON 数。
- 渲染：两条 TUI bench 直接跑（`alt-screen-large-transcript-bench.ts` 约 2.5s，`render-churn-bench.ts` 约 0.2s）。
- 交互：`node scripts/interactive-smoke.mjs`（Windows 真实 PTY；Linux tmux，见 `.candy/skills/interactive-testing.md`）。

### 2.1 删除无引用与死代码

已逐条 grep 验证，直接删（连带导出、测试、文档与 CHANGELOG 条目）：

- `packages/coding-agent/src/core/index.ts` —— 无任何导入者的 barrel。
- `packages/coding-agent/test/test-harness.ts`（476 行）+ `test/test-harness.test.ts`（335 行）—— 只有自测引用；`test/suite/README.md` 已声明不要用。
- 遗留 pi 别名：`packages/coding-agent/vitest.config.ts:25-30` 与 `vitest.e2e.config.ts:25-30` 的 `@mariozechner/*`、`@earendil-works/pi-*`；`packages/ai/vitest.config.ts:18`、`vitest.e2e.config.ts:23` 的 `@earendil-works/pi-telemetry`；`packages/evals/vitest.evals.config.ts:41` 的 `@earendil-works/coding-agent`；`packages/tui/test/native-module-path.test.ts:9` 的 `@earendil-works/pi-tui` fixture 路径。
- `tui-plan.md`（根目录 1001 行，对应功能已实现）。
- `packages/agent/src/index.ts` 第 1–34 行的 telemetry 类型转口与 `uuidv7` 转口：仓库内无消费者（`TelemetryContext` 等由 `@candy/telemetry` 直接导入，如 `packages/ai/src/types.ts:1`；`uuidv7` 由 `@candy/ai` 直接导入，如 `compaction.ts:17`）。改为显式导出，禁用 `export *`。
- `packages/agent/src/types.ts:353` 的 `@mariozechner/agent` 注释示例。
- 根目录无引用脚本（每个删除前再精确 grep 一次，排除子串误报）：`auto-candy.sh`、`edit-tool-stats.mjs`、`read-tool-stats.mjs`、`session-context-stats.mjs`、`session-transcripts.ts`、`tool-stats.ts`、`generate-thinking-capabilities.mjs`、`update-source-imports-to-ts.sh`、`cost.ts`。
- `.zcodeignore`（与 `.gitignore` 大量重复，且错误忽略了仓库真实内容 `packages/ai/src/providers/data/`）。

保留（已核实不是死代码）：`packages/coding-agent/src/utils/source-resolver.ts`（测试用 `--import` 引用）、`packages/ai/src/providers/images/register-builtins.ts`（在 §2.2 随 images 一起删）、`packages/tui/src/editor-component.ts`（`EditorComponent`/`EditorFactory` 是扩展 API 类型）。

### 2.2 产品面裁撤（你指定删除的 5 项）

每项都列"删什么 / 连带面 / 易错点"。执行时按顺序做，每项单独一个 commit。

#### (a) classifier API

删除：`models.classify`、`ClassifierModel`/`ClassifierApi`/`ClassifierOptions`/`Classifier*Question|Answer` 等类型、`CLASSIFIER_MODELS`、`model-catalog.ts` 的 `ClassifierModelCatalog`、`models.ts` 的 classifier store/register、`provider-composer.ts` 的 classifier 装配、`model-runtime.ts` 的 `classify`。

连带（分类专用，一并删）：`api/cloudflare-workers-ai-system-one.ts`(43) + `.lazy.ts`、`api/typesafe-system-one.ts`(21) + `.lazy.ts`、`api/system-one-shared.ts`(207)、`providers/cloudflare-stream.ts` 的 `classifier.classify` 分支、`providers/typesafe.ts` 的分类装配、`api/cloudflare-ai-binding.ts`（仅测试引用）。

数据与生成器：`packages/ai/scripts/generate-models.ts` 里的 openRouter classifiers + `CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS`；`scripts/model-data.ts:18` 的正则（当前硬编码要求 `*_CLASSIFIER_MODELS`、`*_IMAGE_MODELS`、`*_MODELS` 三个导入同时存在）；`providers/*.models.ts` 与 `providers/data/*.json` 里的 classifier 段；然后 `npm run generate:models` 重生成 `models.generated.ts`，`npm run check:model-data` 必须过。

测试：`test/classifier-models.test.ts`、system-one / cloudflare 系列分类断言（约 138 行 + 相关用例）。

#### (b) images API（图像**生成**）

删除：`images.ts`(26)、`images-api-registry.ts`(53)、`api/openrouter-images.ts`(198) + `.lazy.ts`、`providers/images/register-builtins.ts`(57) 与整个 `providers/images/` 目录、`models.generateImages`、`models.ts` 的 images API、`model-catalog.ts` 的 `ImageModelCatalog`、`IMAGE_MODELS`、`provider-composer.ts` 的 images 装配、`model-runtime.ts:699 generateImages`、`utils/model-operations.ts` 的 images 分支、`providers/openrouter.ts` 的 images 装配、`types.ts` 的 `ImageApi`/`ImageModel`/`ImagesContext`/`ImagesOptions`/`AssistantImages` 等（保留 `ImageContent`）。

**易错点（必须保留）**：`ImageContent`、剪贴板图片、`utils/image-*.ts`、`image-resize-worker.ts`、工具结果里的图片（`e2e/image-tool-result.test.ts` 属于输入图片，保留）。只删"生成"，不删"输入/显示"。

数据与生成器：openRouter 的 images 抓取与 `IMAGE_MODELS` 发射（`generate-models.ts`、`model-data.ts` 正则）、各 provider JSON 的 image 段、`generate:models` 重生成。

测试：图像生成相关约 1500 行（`*image*.test.ts`、`e2e/images.test.ts`、`openrouter-images.test.ts`、`telemetry-options.test.ts` 中的 images 部分），保留输入图片相关用例。

#### (c) Bedrock

删除：`api/bedrock-converse-stream.ts`(1345) + `.lazy.ts`、`providers/amazon-bedrock.ts`(90) + `.models.ts`、**`bedrock-provider.ts`（`@candy/ai` 的 `./bedrock-provider` 入口）**、`api/streams.ts` 的 `bedrock-converse-stream` case、`types.ts` 的 Bedrock 类型、`providers/all.ts` 的 provider 注册、`env-api-keys.ts` 的 AWS_* 键、`auth/helpers.ts` 与 `utils/{error-body,overflow,retry}.ts` 的 Bedrock 分支、`providers/data/amazon-bedrock.json`(89 KB) + `.manifest.json` 条目、生成器里的 Bedrock 定义。

连带：`packages/coding-agent/src/bun/runtime-setup.ts`（`setBedrockProviderModule`/`bedrockProviderModule`）、`packages/coding-agent/src/cli/args.ts:402-406` 的 AWS 环境变量帮助文本；依赖 `@aws-sdk/client-bedrock-runtime@3.1127.0`、`@smithy/node-http-handler@4.12.1` 从 `packages/ai/package.json` 删除（node_modules 里两者合计约 11 MB），更新 lockfile 与 coding-agent shrinkwrap。

测试：11 个 bedrock 测试文件（2008 行）+ e2e bedrock 用例。

#### (d) Azure OpenAI Responses

删除：`api/azure-openai-responses.ts`(351) + `.lazy.ts`、`providers/azure-openai-responses.ts`(14) + `.models.ts`、`api/streams.ts` 的 case、`providers/all.ts` 注册、`env-api-keys.ts` 的 AZURE_* 键、`types.ts` 的 `AzureOpenAIResponsesOptions`、`index.ts` 的类型导出、`providers/data/azure-openai-responses.json`(19.8 KB) + manifest、生成器定义。

连带：`packages/coding-agent/src/cli/args.ts:370-374` 的 AZURE 环境变量帮助、`packages/coding-agent/src/core/model-resolver.ts:16` 的默认模型映射条目（`"azure-openai-responses": "gpt-5.4"`）。

测试：3 个 azure 测试文件（491 行）。

#### (e) containerization / docker

删除：`packages/evals/docker/`（Dockerfile、entrypoint.ts、install-runtime.mjs 等）、`packages/evals/src/docker.ts`(177)、`packages/evals/src/cli.ts`(192)（docker CLI 入口）、`packages/evals/evals/*.docs.eval.ts`（6 个，靠 docker runner 执行）、`vitest.evals.config.ts` 的 `CANDY_EVAL_CONTAINER` 分支与 `docs` 项目、根 `eval`/`eval:docs` 脚本、`packages/coding-agent/docs/containerization.md`(151) 与 `docs.json` 导航项、`docs/index.md:35` 与 `docs/security.md:23` 的链接、CI 的 `apt-get install libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev`（在 `canvas` 依赖被删后已是死步骤）。

连带（一并修）：`packages/coding-agent/package.json:32` 的 `files` 里列了 `"containerization.md"`，但该文件在仓库里根本不存在（`packages/coding-agent/containerization.md` 路径无此文件）。

保留：`packages/evals/evals/*.eval.ts`（in-process 评测，`eval:host` 直接用 vitest）与其 `vitest.test.config.ts` 已有的单元测试。

裁撤后要做的收口：重生成 coding-agent shrinkwrap（`node scripts/generate-coding-agent-shrinkwrap.mjs`），`npm run check` 必须过（含 `check:shrinkwrap`、`check:runtime-deps`）。

### 2.3 单一事实源 I：token / context 估算

现状：`packages/ai/src/utils/estimate.ts`(155) 与 `packages/coding-agent/src/core/compaction/compaction.ts:154-352` 各一份 `calculateContextTokens`/`estimateContextTokens`/`estimateTokens`/`estimateTextAndImageContentChars`，魔数（`CHARS_PER_TOKEN = 4`、`ESTIMATED_IMAGE_CHARS = 4800`）与 system 段处理各写一遍。

动作：`@candy/ai` 为唯一所有者（接收结构化消息，兼容 `Message` 与 `AgentMessage` 的 system 分段）；`compaction.ts` 删本地副本改消费它（`estimateProjectedContextTokens` 是投影逻辑，保留）；补一个一致性断言测试（同一 transcript 下运行时值与压缩判定值相等）。

### 2.4 单一事实源 II：abort / sleep 原语

现状：`packages/ai/src/utils/abort.ts` 与 `packages/coding-agent/src/utils/abort.ts` 是同一份（签名不同）；`sleep` 两份且语义不一致（ai 用 `signal.throwIfAborted()` 以 `signal.reason` reject，coding-agent reject `new Error("Aborted")`）。

动作：统一到 `@candy/ai/utils`，确定唯一契约（`operationSignal(signal?)`、`raceWithAbortSignal(promise, signal?)`、`sleep(ms, signal?)` 以 `signal.reason` reject，无 reason 时 `AbortError`）；删除 coding-agent 的两份，改写所有调用点；审计 `catch` 里的 abort 判定，统一 `isAbortError`，禁止 `error.message === "Aborted"` 这类字符串比较。

### 2.5 单一事实源 III：持久化文件层

现状：三份逐行雷同的"JSON + `proper-lockfile` + 自旋忙等"：`core/auth-storage.ts:70-106`、`core/settings-storage.ts:24-52`、`core/trust-manager.ts:143-165`（都是 `maxAttempts=10`、`delayMs=20`、`while (Date.now() - start < delayMs) {}`）。另有 `core/models-store.ts` 复用 `FileAuthStorageBackend`（把通用加锁后端命名成 auth），并重抄了 `@candy/ai` 已有的 `InMemoryModelsStore`。JSONL 写入散在 `session-manager.ts:800,861,871,1540`，`session-export.ts:22` 又是另一套序列化。

动作：新增唯一所有者 `packages/coding-agent/src/core/storage/json-file.ts`（加锁：异步指数退避、无忙等；原子写；revision；BOM 剥离；带路径的解析错误类型）；迁移 auth / settings / trust / models-store 到它，删除三份自旋重试与 auth 命名的通用后端；`InMemoryCodingAgentModelsStore` 删除、统一用 ai 的实现。JSONL 单点：`core/session-jsonl.ts` 独占读写与序列化，`session-manager`/`session-export` 只调用。

### 2.6 单一事实源 IV：workspace 别名解析

现状：同一映射 7 处手写：`tsconfig.json` `paths`、`vitest.base.ts`、4 个 vitest 配置内联 alias、`check-entry-graphs.mjs` 的 `WORKSPACE`、`check-architecture-boundaries.mjs` 的 `WORKSPACE`、`interactive-smoke.mjs` 的 `aliases`、`src/utils/source-resolver.ts`。

动作：以 `tsconfig.json` 为唯一来源，加 `scripts/lib/workspace-paths.mjs`（读 tsconfig → 包名/源码根/alias），前述各处以它为输入；`source-resolver.ts` 已是"读 tsconfig"，保留为运行时正典，其它地方不得再手写表。删除 §2.1 列出的遗留别名。

### 2.7 TUI 渲染性能（做，但不设硬约束）

现状（实测）：`Container.render()`（`tui/src/tui.ts:366-378`）渲染全部子组件、`ScrollView` 事后切片，无视口裁剪 → 2500 组件时 resize **183 ms/frame**；稳定帧仍每帧分配 49.3 KiB（编辑器 83.7 KiB）。`withBuiltInRenderers` 每次调用新建 8 个 renderer（`presentation/tool-renderers/index.ts` 的 `createAllToolRenderers()`，调用点 `interactive-mode.ts:1842`）。

动作：`ScrollView`/`Container` 加视口裁剪（只渲染视口 ± overscan，维护可失效高度索引，宽度变化不整体重排）；`createAllToolRenderers()` 改模块级常量；渲染路径内去掉逐帧 `new Map()`/数组拷贝级分配。

验收方式（人工，非门禁）：跑两条 bench 记录 before/after；目标 resize 从 183 ms 降到 30 ms 以内、稳定帧分配显著下降。**不写阈值断言进代码。**

### 2.8 死测试删除（Q3=B：只删死测）

删除：legacy harness 及其测试（§2.1 已列）、纯 fixture 测试（如 `test/plan-mode-utils.test.ts` 只测 `test/fixtures/plan-mode/utils.ts`）、不导入任何 `packages/*/src` 的测试、以及随 §2.2 裁撤一起消失的测试（bedrock/azure/images/classifier/docker 相关）。

不做：不改比例门槛、不合并 76 个 regression 文件、不重写既有测试结构（那是已取消的第 2 步）。

### 2.9 顺带的一行修复（属清扫，建议一起做）

这 4 条不是重构，是当前代码里的错误指向；除非你说不要，我按默认一起修：

1. `packages/coding-agent/src/utils/changelog.ts:11` `GITHUB_REPO = "earendil-works/pi"` → 你的仓库（现在应用内 changelog 拉的是上游仓库）。
2. `packages/coding-agent/src/migrations.ts:14,82` 两条 `earendil-works/pi` / `pi-mono` 文档 URL。
3. CI 里 `canvas` 时代留下的 apt 依赖（随 §2.2(e) 删）。
4. 6 个包的 `package.json` `repository` 仍指 `github.com/earendil-works/pi`（元数据错误，影响发布信息）；`packages/coding-agent/package.json` 的 `files` 列了不存在的 `containerization.md`。

### 2.10 出口标准

- §2.1、§2.2 的删除项全部消失，`grep` 不再命中；依赖从 `packages/ai/package.json` 移除，lockfile 与 shrinkwrap 一致（`check:shrinkwrap` 过）。
- §2.3–2.6 的重复实现消失：`grep -rn "proper-lockfile" packages/coding-agent/src` 只命中 `storage/json-file.ts`；`grep -rn "Date.now() - start" packages/coding-agent/src` 为空；abort/sleep/estimate 各只有一份。
- `npm run check`、`./test.sh` 全绿；`npm run generate:models` 生成的产物与 `check:model-data` 一致。
- TUI bench 记录 before/after（目标 resize ≤30 ms）。
- 基线表回填 after 列。

---

## 3. Step 2 —— 已取消（留档）

按你的决定，应用层（`packages/coding-agent`）的下列工作**不做**，记录在此以便你之后自行处理或再开一轮：

- `core/agent-session.ts`（3621 行 / 133 方法）拆分：状态机 / agent 桥 / 队列 / 工具装载 / prompt 投影 / 压缩编排。
- `modes/interactive/interactive-mode.ts`（5991 行 / 187 方法）拆分，以及旁边骨架文件（`interactive-presentation.ts` 693、`interactive-page-controller.ts` 76、`session-presentation.ts` 77、`tui-renderer.ts` 76）的落地——这是你正在进行中的重构，我不碰。
- headless 模式统一：`print-mode.ts:76-115`、`rpc/rpc-mode.ts:310-352` 与 json 分支重复的 `bindExtensions` + 6 个 `commandContextActions` + 订阅/反压样板，应收进一个 host。
- 队列两处真相：`packages/agent/src/agent.ts` 的 steer/followUp 队列与 `core/agent-input-queue.ts` 的镜像数组（`markStarted`/`withdraw` 手工同步）。
- 启动性能：`candy --version` 仍会加载 1436 模块 / 39 个 catalog JSON（入口链 `cli.ts → main.ts → core/model-runtime.ts:55 → @candy/ai/providers/all`），以及 highlight.js / grok-mermaid / yaml / undici 的提前加载。**这一条是唯一我建议你之后单独做的**，因为它直接决定启动手感。
- 选择器交互契约收敛、扩展系统按文档切分公开/内部、行为一致性清单（空 catch、包边界 `any`）、文档审计（37 个文件 / 5905 行）、CHANGELOG 与文档一致性。

---

## 4. 批次顺序（每批一个可提交单元）

1. §2.0 度量脚本（临时，不入库）+ 基线记录
2. §2.1 死代码删除
3. §2.6 别名解析统一（为后续铺路）
4. §2.4 + §2.3（abort/sleep、estimate）
5. §2.5 持久化层统一
6. §2.2(a)(b) classifier + images API
7. §2.2(c)(d) Bedrock + Azure（含依赖删除与 shrinkwrap 重生成）
8. §2.2(e) docker/containerization（含 CI 与文档收口）
9. §2.7 TUI 视口裁剪 + 分配削减（记录 before/after）
10. §2.8 死测试删除
11. §2.9 一行修复 + 各包 CHANGELOG `Unreleased`

每批结束：`npm run check` + 相关聚焦测试；受影响指标记回 §1。

---

## 5. 禁止事项

- 不新增 CI 门禁/静态检查脚本，不做棘轮、不做性能断言。
- 不引入新框架/注册表/通用表单协议/新 TUI 原语。
- 不保留 `@mariozechner/*`、`@earendil-works/*`、`pi-*` 别名或 shim。
- 不做"两套实现并存 + 开关切换"。
- 不为让测试通过而保留已判定无用的生产代码。
- 不在同一 commit 混合"搬迁"与"行为变更"。
- 不碰 `modes/interactive` 的重构与 `agent-session.ts` 的拆分（第 2 步已取消）。

---

## 6. 决策记录与一处待确认

**已固化**

| 编号 | 你的决定 | 计划中的落地 |
|---|---|---|
| Q1 | B（个人项目，无扩展） | 只删"仓库零引用 **且** 文档未提及"的导出；`@candy/tui` 的 `exports` map 与扩展宿主模块表不动；`Provider*ModelConfig` 重复类型、`agent-core` 的 telemetry/`uuidv7` 转口照删（与兼容无关） |
| Q2 | 删 classifier、containerization/docker、images API、Bedrock、Azure | §2.2(a)–(e)，含连带面与易错点（输入图片 `ImageContent` 必须保留） |
| Q3 | B | §2.8 只删死测；不做比例门槛、不重构测试结构 |
| Q4 | A | 机器无关指标（模块数/JSON 数）+ Windows 严格/CI 宽松阈值——但按 Q5 降级为**人工记录**，不写成断言 |
| Q5 | 不加静态检查；性能不作硬约束 | §0.5、§2.0、§2.7、§5；`npm run check` 保持现状 |
| Q6 | 第 2 步整段不做 | §3 留档；§0.6 禁止触碰 `modes/interactive` 与 `agent-session.ts` |
| Q7 | 删 `.zcodeignore` 与无引用脚本 | §2.1 |

**唯一待确认（歧义）**：Q6 我按字面理解为"**整个第 2 步取消**"，因此 §3 全部不做。如果你的本意只是"`§2.2`（interactive 层）不做"，请说一句，我会恢复：`agent-session.ts` 拆分、headless 模式统一、启动性能、行为一致性清单、文档审计与 CHANGELOG 收口（`modes/interactive` 与 `interactive-presentation` 那条仍然不动）。默认按"第 2 步整段取消"执行。
