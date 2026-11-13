# AGENTS.md — dualtran-joplin 协作者铁律

本文件对在本仓库工作的任何 agent/协作者生效。完整产品规范见
`DualTran-manage/host-conformance/SPEC.md` v2；本仓库的 `conformance.json` 声明了
宿主 id、payload 生成器与平台上限。

## 宿主一致性铁律（最高优先级）

任何翻译/设置 UI 改动必须满足五条产品规则：

1. 目标语言、AI provider、AI model 三处一律选择器；禁止让用户输语言代码/provider id/model id。
2. **provider 列表 = 内建 + models.dev 合并成单一字母序列表**；禁止 divider / disabled 分隔项 /
   `──── More ────`；别名去重；自定义 provider 最后。model 列表按 provider 联动、按标签排序，
   自定义 model 最后。
3. endpoint 的 **value**（不是 placeholder）随 provider 自动带入；用户改过的值不被覆盖。
4. 推理强度默认哨兵 `lowest`，请求前解析 `none → minimal → low`；模型未声明则不发参数。
5. 界面文字全部走 i18n；平台上限只能写进 `conformance.json` 的 `platformLimits` 并给证据。

## 面板门禁（webview 生命周期）

- `panels.setHtml` 实际是 `innerHTML` 赋值：HTML 里的 `<script>` 不会执行，重渲染也不会重新执行面板脚本；`addScript` 在 webview ready 时注入，通常早于 `setHtml`。面板脚本必须用 `init()` 绑定 + 常驻 `MutationObserver` 重新绑定，并给 form 打标记防止重复绑定；禁止在面板 HTML 里放 `<script>`。
- 控件的验收标准是 DOM 证据，不是“按钮看得见”：`#close` 上必须恰好有 1 个 click 监听，点击后面板项宽度为 0。`tests/panelDom.test.ts`（jsdom 执行 `dist/dualtran-panel.js`，覆盖“脚本先于 HTML”和重渲染两种顺序）是必需门禁。
- 改动 `src/panel.js`、`src/settingsPanel.ts`、`src/index.ts`，或发布前，必须跑真实 Joplin 冒烟：`node scripts/e2e/panel-smoke.mjs --port <cdp-port>`；截图不能作为通过依据。点击必须 fire-and-forget：面板隐藏会销毁 frame，await 该 evaluate 曾导致 “Renderer process gone”。
- 部署到 Windows 节点时必须清掉 `<profile>/cache/com.seigwen.dualtran` 和 `<profile>/cache/plugin-extraction-state.json`：Joplin 按 size/timestamp 判断是否重新解压，同尺寸重建会继续运行旧代码。

## 门禁

```bash
npm run verify                     # build → typecheck → tests（含 panelDom）→ conformance
npm run e2e:panel -- --port 9225   # 真实 Joplin（需 --remote-debugging-port）
```

- 改设置 UI 必须同时更新 payload 测试；禁止删除断言来“修绿”。
- `npm run conformance` 先跑 12 个内置反例（阴性对照），再校验真实控件；CI 必须运行。
- 旧分组「内建 → 分隔 → models.dev」已于 2026-11-11 被用户口径废止，不要恢复。
- 平台限制只能写在 `conformance.json`，不能口头豁免；新宿主没有 gate 不得发版。
