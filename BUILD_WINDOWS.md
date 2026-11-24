# Ciallo App Windows 桌面端可复现构建与开发指南

2026-11-24 · Carbon 整理

> 本指南单独存放于 `BUILD_WINDOWS.md`，不改动上游 `README.md`、`README.zh.md` 或 `.i18n.yaml`，以免后续同步官方更新时产生文档与翻译配对冲突。

## 1. 环境要求（与官方 Release 构建一致）

- **操作系统**：Windows 10 / 11 x64（建议使用短路径如 `C:\src\ciallo-app`，并开启 `git config core.longpaths true`）
- **Node.js**：`^24.22.3 || >=26.13.1`
- **pnpm**：`11.28.5`（由 `package.json` 的 `packageManager` 自动选择，或通过 Corepack 启用）
- **构建工具链**：Git、PowerShell 7（`pwsh`）、Windows 内置 `tar`、Python 3、Visual Studio 2022 C++ 生成工具及 Windows SDK（含 `Microsoft.VisualStudio.Component.VC.Tools.x86.x64`）

## 2. 从零复现 Windows 安装包（与 GitHub Release 同构）

1. **克隆仓库**（如需复现指定 Release 版本，可切换到对应标签如 `v0.1`）：

```powershell
git clone -c core.longpaths=true https://github.com/xxTvTxx/ciallo-app.git C:\src\ciallo-app
cd C:\src\ciallo-app
# 如需复现指定版本（如 v0.1）：git checkout v0.1
```

2. **安装锁定依赖**（所有 npm 包与内置 Python/Node 运行时均通过仓库内 lockfile 锁定哈希）：

```powershell
pnpm install --frozen-lockfile
```

3. **生成本地打包配置文件 `apps/desktop/.env.windows`**（已被 `.gitignore` 忽略，以下为 Release 实际使用的公开非敏感参数，模板见 `apps/desktop/.env.windows.example`）：

```powershell
@"
DSH_DESKTOP_APP_ID=com.xxtvtxx.ciallo-app
DSH_DESKTOP_AUTO_UPDATE_ENV=production
DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN=https://harness.deepseek.com
DSH_DESKTOP_WINDOWS_COMPRESSION_LEVEL=3
"@ -replace "`r`n", "`n" | Set-Content -NoNewline -Encoding utf8 apps/desktop/.env.windows
```

4. **运行预检并打包未签名 Windows x64 安装器**：

```powershell
pnpm run package:desktop:win:x64:unsigned --check
pnpm run package:desktop:win:x64:unsigned
```

产物位于 `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/`，打包末尾会自动执行离线运行时与 Office 组件 smoke 验收。

## 3. 本地日常开发与同机并行（不打安装包）

- **默认数据与安装隔离（v0.2+）**：
  - **独立数据根目录**：默认使用 `~/.ciallo`（仍可通过 `DSH_HOME` 覆盖），避免与官方版 DeepSeek Harness 的 `~/.dsh` 产生配置与插件清单冲突。
  - **独立桌面运行时目录**：桌面端使用产品名 `Ciallo`（可安装程序 `Ciallo.exe`、自定义协议 `ciallo://`），并将 Electron `userData` 隔离在 `%APPDATA%\Ciallo`，可与官方版 `DeepSeek Harness.exe` 同机同时安装和并行运行，互不抢占单实例锁。
  - **一键从 `~/.dsh` 迁移**：首次启动引导弹窗（以及 `设置 → 模型`）会自动检测本机是否存在 `~/.dsh`，提供一键非破坏性导入历史会话、附件、技能、`AGENTS.md` 与已保存 API 密钥（可选），原 `~/.dsh` 目录保持只读且不被修改。
- **Web 预览**：`pnpm run build:artifacts` 后运行 `pnpm run start:web`（或使用热更新循环 `pnpm run dev:web`）
- **桌面端开发态**：`pnpm run dev:desktop`
- **免安装目录版**：`pnpm run package:desktop:win:x64:dir`
- **全仓类型检查**：`pnpm run typecheck`

## 4. 持续开发与跟进上游流程（维护者参考）

- **主干与分支**：`origin`（`xxTvTxx/ciallo-app`）以 `master` 作为唯一主干分支；日常新特性从 `master` 切出 `feat/*` 开发验证后合回 `master`，发版时在 `master` 打 `v*` 标签。
- **跟踪上游更新**：添加 `upstream`（`https://github.com/deepseek-ai/deepseek-harness.git`）并禁用向其推送：

```powershell
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
git remote set-url --push upstream DISABLE
git fetch upstream --tags
git switch master
git merge dsh-v<目标版本号>
```

- **常见合并冲突处理**：
  - `pnpm-lock.yaml` 冲突时取上游版本后重装依赖：`git checkout --theirs pnpm-lock.yaml && pnpm install`
  - `.i18n.yaml` / 文档配对钩子报错时按提示运行：`pnpm run verify-translation-pairing --write <文件>`

## 5. 变更记录

- 2026-11-24，Carbon：更新 v0.2 默认 `~/.ciallo` 数据根目录、Electron `%APPDATA%\Ciallo` 隔离、`Ciallo.exe` 独立身份及一键 `~/.dsh` 迁移说明。
- 2026-11-24，Carbon：面向公开仓库整理 Windows 桌面端可复现构建、本地调试与上游同步指南。
