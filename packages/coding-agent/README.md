<p align="center">
  <a href="https://www.npmjs.com/package/@candy/coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@candy/coding-agent?style=flat-square&logo=npm&logoColor=white" /></a>
</p>

# candy

Candy is an agent harness for daily work in the terminal. Its interface brings model selection, session history, agent resources, and explicit commands into a consistent workflow. Skills, prompt templates, and extensions adapt it to specialized work.

Its fullscreen interface shows assistant text, thinking, and tool activity in a shared conversation. The Powerbar handles model and thinking selection; its Sources, Details, History, and Agent pages handle the surrounding tasks. Type `/` in an empty editor to search commands and settings. Read the [terminal guide](docs/usage.md) for the current controls.

Ask candy to create the prompt templates, skills, extensions, and themes you need, or install a candy package. Use candy directly, automate it in print, JSON, or RPC mode, or build applications with the TypeScript SDK.

## Getting started

Install the command-line interface with npm:

```bash
npm install -g --ignore-scripts @candy/coding-agent
```

This requires Node.js 22.19 or newer. candy does not require dependency lifecycle scripts for a normal npm installation.

Start candy in the directory where you want it to work:

```bash
cd /path/to/project
candy
```

For a built-in AI provider, open Model → Sources to connect a subscription or API key. Then give candy a task.

See the [documentation](docs/index.md) for full setup and usage instructions.

## Development

Clone this repository, install its dependencies, and run candy from source:

```bash
git clone <this repository>
cd Candy
npm install --ignore-scripts
npm run build
```

Before submitting changes, run:

```bash
npm run check
./test.sh
```

Read [CONTRIBUTING.md](../../CONTRIBUTING.md) for development philosophy and contribution expectations, [DESIGN.md](../../DESIGN.md) for product and interaction design, and [AGENTS.md](../../AGENTS.md) for implementation, testing, dependency, and release rules.

## License

MIT
