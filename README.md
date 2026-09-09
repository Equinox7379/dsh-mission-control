# DSH Mission Control · 任务指挥台

**Turn AI conversations into work you can track.**

[![CI](https://github.com/Equinox7379/dsh-mission-control/actions/workflows/ci.yml/badge.svg)](https://github.com/Equinox7379/dsh-mission-control/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A local task console for **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)**. Define the outcome, bind a conversation, preview the exact request, and send it once. Follow the model's output and tool activity, then decide whether the task is actually done.

It is useful when your work spans several AI conversations and you need to keep the objective, execution, and verification together.

[Quick start](#quick-start) · [Compatibility](#compatibility) · [Development](#development) · [中文说明](#中文说明)

![Mission Control interface rendered with synthetic demonstration data](https://raw.githubusercontent.com/Equinox7379/dsh-mission-control/main/docs/mission-control-demo.png)

*The actual plugin interface, rendered with synthetic projects, tasks, and execution data. No real model was called for this screenshot; a finished model turn and human acceptance are separate states.*

## What you can do

- **Organize work by project.** Give each task an objective, acceptance criteria, priority, and plan.
- **Execute through an existing DSH conversation.** Bind a session, inspect its working directory, model, and outgoing prompt, then explicitly confirm the dispatch.
- **Follow the actual run.** See output, tool-call counts, tool errors, and execution state. Reopening the console does not resend the task.
- **Keep review separate from execution.** Record a plan, approvals, validation evidence, and final acceptance. A completed model turn is not automatically a completed task.
- **Export a Markdown report.** Keep project and task context available outside the UI.

Mission Control uses DSH's existing session engine and configured model. It does not require a separate model API key or replace the conversation transcript.

## Compatibility

| Component | Current support |
| --- | --- |
| Mission Control | `0.2.1` |
| DSH runtime | **`0.1.3-alpha.2`** — the peer dependencies are pinned to this version |
| Node.js | 22 or newer; CI runs on Node 22, local verification also uses Node 24 |
| Package manager | pnpm 11 |
| Verified platform | Windows; the CI workflow builds and tests on `windows-latest` |
| Interface | Chinese UI, desktop browser layout; narrow screens are read-only |
| Desktop integration | Optional Desktop Bridge support for a compatible DshDesktop build |

Use a running DSH **Web** profile on `127.0.0.1`. Install and configure DSH first. Compatibility with other DSH releases or operating systems is not currently certified.

## Quick start

### 1. Build the plugin

```sh
git clone https://github.com/Equinox7379/dsh-mission-control.git
cd dsh-mission-control
pnpm install --frozen-lockfile
pnpm run build
```

Build before installing: the repository contains source code, and the generated `lib/` directory is intentionally not committed.

### 2. Add it to your DSH Web profile

From the repository directory, in **PowerShell**:

```powershell
$pluginPath = (Get-Location).Path
dsh plugin --profile web add "file:$pluginPath"
```

Use an absolute path: DSH runs its package operation from the profile directory. Restart DSH Web through your usual launcher, then reload the page. The plugin's bundle registers itself; no manual `cordis.patch.yml` insertion is needed.

### 3. Run your first task

1. Open **任务指挥台** in DSH.
2. Create a project and a task. Write a concrete objective and acceptance criteria.
3. In the task's **会话** section, open **会话工具**, refresh the list, and click **绑定** beside the conversation you want to use. You can also choose **新建并绑定**.
4. Click **交给 DSH 执行**, check the directory, model, and prompt, then choose **确认发送一次**.
5. Follow the output and tool activity. Verify the result before marking the task complete.

The expandable manual workflow is optional. Use it when you need plan approval, evidence, or an explicit handoff.

## Data and behavior

- Plugin state is stored under the DSH home directory in `storages/dsh-mission-control/`. Task state and execution metadata use separate JSON files.
- The original conversation remains in DSH's own session storage.
- Execution uses the selected session's model and permission policy. Model usage follows that session's existing provider configuration and costs.
- Stop requests are limited to the task's own queued message or still-owned live turn. Uncertain execution states remain visible instead of being reported as success.
- Markdown exports default to `Documents/DshMissionControlExports`. Set `DSH_MISSION_CONTROL_EXPORT_DIR` to choose another export directory.

## Development

After installing dependencies, build and run the existing checks. In PowerShell:

```powershell
$env:DSH_MC_TEST_TMP = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-mission-control-tests'
pnpm run build
pnpm test
pnpm exec playwright install chromium
pnpm run test:browser
```

The browser health check uses an isolated local server. `test:execution-browser` is a separate, opt-in integration check: it requires a dedicated DSH Lab, creates a demo task, and sends a real model request. Its required `DSH_MC_LAB_*` variables are listed at the top of [the script](tests/execution-browser-smoke.mjs).

To create a distributable package from an existing build:

```powershell
$env:DSH_MC_LIB_DIR = (Resolve-Path lib).Path
$packRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-mc-pack-' + [guid]::NewGuid())
$env:DSH_MC_PACK_STAGE = Join-Path $packRoot 'stage'
$env:DSH_MC_PACK_DEST = Join-Path $packRoot 'packages'
npm run pack:built
```

This produces a `.tgz` with the built plugin, bundled protocol files, README, and license. The [CI workflow](.github/workflows/ci.yml) checks the build, unit tests, browser health route, and package creation.

### Project layout

| Location | Purpose |
| --- | --- |
| `src/client.tsx` | Project and task UI |
| `src/domain.ts`, `src/storage.ts` | Task workflow and persistent state |
| `src/execution/` | Dispatch, run observation, stop handling, and execution UI |
| `src/bridge.ts`, `src/rpc-contracts.ts` | Optional Desktop Bridge integration |
| `protocol-vendor/` | Pinned protocol schemas and fixtures |
| `tests/` | Domain, API, persistence, compatibility, and browser checks |

## Feedback and contributions

[Open an issue](https://github.com/Equinox7379/dsh-mission-control/issues) with the DSH version, plugin version, operating system, steps to reproduce, and expected versus actual behavior. Use a small example that does not contain credentials or private conversation data.

Focused fixes and concrete workflow suggestions are welcome. For a larger feature, describe the use case in an issue first. If this console helps your work, a star helps other DSH users find it.

## 中文说明

**任务指挥台让你把 AI 对话整理成可以跟进、验证和交接的工作。**

在项目中建立任务，写明目标与验收标准，绑定一个已有的 DSH 会话；确认工作目录、模型和待发送内容后，再交给 DSH 执行。执行输出、工具调用和任务状态集中显示，模型回合结束与人工验收保持分开。

当前版本为 `0.2.1`，适配 **DSH `0.1.3-alpha.2`**，采用中文界面，已在 Windows 验证。普通浏览器即可使用任务界面，Desktop Bridge 是可选集成；窄屏仅供查看。

安装时先按上面的步骤克隆并构建，再使用绝对路径添加到 DSH Web profile，重启后打开「任务指挥台」。源代码仓库不包含生成的 `lib/`，因此不要跳过构建直接安装 GitHub 源码地址。

欢迎提交可复现的问题、实际使用反馈和范围清楚的修复。项目独立开发，不是 DeepSeek 官方产品。

## License

[MIT](LICENSE) © 2026 Equinox7379. Independent community software; not an official DeepSeek product. Third-party dependencies retain their own licenses.
