# Ciallo App

English | [中文](README.zh.md)

Ciallo App is an open-source desktop and Web AI agent workspace built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and the [Cordis](https://github.com/cordiverse/cordis) plugin architecture, customized for multi-provider workflows, built-in CialloAPI support, and side-by-side coexistence with official DeepSeek Harness installations.

Review the [safety notice](SAFETY.md) before running local agent tools.

## Highlights

- **Built-in CialloAPI and multi-provider routing**: Ships pre-configured CialloAPI groups alongside OpenAI, Anthropic, Google Gemini, and custom endpoints, with a flat single-layer model menu, per-model default reasoning effort, and Claude prompt-cache TTL and session stickiness.
- **Standalone desktop identity and data isolation**: Runs as `Ciallo` with the `ciallo://` protocol, keeps Electron state in `%APPDATA%\Ciallo`, and stores data in `~/.ciallo` by default (overridable via `$DSH_HOME`), coexisting alongside official DeepSeek Harness without lock or configuration collisions.
- **Non-destructive one-click `~/.dsh` migration**: Detects an existing `~/.dsh` directory in first-run onboarding and `Settings -> Models`, importing conversations (with cached titles and workspaces), attachments, skills, `AGENTS.md`, and optional stored API key references while leaving `~/.dsh` untouched.
- **Full plugin-based agent harness**: Preserves workspaces, subagents, plan mode, file/shell tools, and reproducible desktop packaging.

## Run

### Desktop installer

Prebuilt Windows installers (`ciallo-app-<version>-win-x64.exe`) are published on [GitHub Releases](https://github.com/xxTvTxx/ciallo-app/releases); see [BUILD_WINDOWS.md](BUILD_WINDOWS.md) to reproduce the identical installer locally from source.

### Run from source

To run from a source checkout:

```sh
git clone https://github.com/xxTvTxx/ciallo-app.git
cd ciallo-app
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm dsh web` starts the Web UI at `http://127.0.0.1:3080` by default (pass `--no-open` or `--port 0` as needed; see [Web UI guide](docs/user/guide/index.md)), and `pnpm run dev:desktop` launches the Electron desktop shell in development mode.

## Development

Refer to [BUILD_WINDOWS.md](BUILD_WINDOWS.md) for Windows packaging and upstream sync workflows, alongside the [development guide](docs/development.md), [architecture documentation](docs/architecture.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [AGENTS.md](AGENTS.md).

## Acknowledgments and License

Built on upstream [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) by [DeepSeek AI](https://deepseek.com).

Released under the [MIT](LICENSE) License; third-party dependencies and licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
