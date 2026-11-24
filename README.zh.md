# Ciallo App

[English](README.md) | 中文

Ciallo App 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与 [Cordis](https://github.com/cordiverse/cordis) 插件架构打造的开源桌面端与 Web AI Agent 工作台，针对多模型服务商工作流、内置 CialloAPI 支持以及与官方 DeepSeek Harness 同机并行共存做了专项定制。

运行本地智能体工具前，请先阅读[安全说明](SAFETY.zh.md)。

## 核心特性

- **内置 CialloAPI 与多服务商路由**：默认集成 CialloAPI 分组，并兼容 OpenAI、Anthropic、Google Gemini 与自定义端点，提供单层模型菜单、按模型配置默认推理档位以及 Claude Prompt Cache 时长与会话粘性支持。
- **独立桌面身份与数据目录隔离**：桌面端以 `Ciallo` 独立身份及 `ciallo://` 协议运行，Electron 状态目录位于 `%APPDATA%\Ciallo`，数据根目录默认为 `~/.ciallo`（支持通过 `$DSH_HOME` 覆盖），可与官方版 DeepSeek Harness 同机并行使用而互不冲突。
- **非破坏性一键迁移 `~/.dsh`**：首次启动引导与「设置 → 模型」会自动检测本机已有的 `~/.dsh` 目录，支持一键导入历史会话（含标题与工作区关联）、附件、技能、`AGENTS.md` 以及可选的已保存 API 密钥引用，同时保持原 `~/.dsh` 目录只读。
- **完整插件化 Harness 能力**：保留多工作区管理、子智能体、Plan 模式、文件与终端工具，以及可从源码复现的桌面安装包构建链。

<a id="run"></a>

## 运行

### 桌面安装包

Windows 预构建安装程序（`ciallo-app-<version>-win-x64.exe`）发布于 [GitHub Releases](https://github.com/xxTvTxx/ciallo-app/releases)；如需在本地从源码构建完全一致的安装包，请参考 [BUILD_WINDOWS.md](BUILD_WINDOWS.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/xxTvTxx/ciallo-app.git
cd ciallo-app
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm dsh web` 默认会在 `http://127.0.0.1:3080` 启动 Web UI（可按需传入 `--no-open` 或 `--port 0`，详见 [Web UI 指南](docs/user/guide/index.zh.md)），运行 `pnpm run dev:desktop` 可在开发模式下启动 Electron 桌面端。

## 开发

Windows 打包与上游同步流程见 [BUILD_WINDOWS.md](BUILD_WINDOWS.md)，其余开发与架构资料见[开发指南](docs/development.zh.md)、[架构文档](docs/architecture.zh.md)、[CONTRIBUTING.md](CONTRIBUTING.zh.md) 与 [AGENTS.md](AGENTS.md)。

## 致谢与许可证

本项目基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（由 [DeepSeek AI](https://deepseek.com) 开源）构建。

采用 [MIT](LICENSE) 许可证发布；第三方依赖及其许可证声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
