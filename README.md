# Isorropía Engine

[日本語](README.ja.md)

Isorropía Engine is a deterministic CLI for exploring pairs of curated SCP EN articles. It supports three questions:

- `cycle`: could the anomalies counteract or constrain each other?
- `breach`: could one materially worsen the other's containment failure?
- `double-feature`: are the articles worth reading together?

Results are evidence-backed hypotheses, not SCP canon.

## Start

Node.js 24 or newer is required.

```sh
npm ci
npm run build
node dist/cli.js pair scp-3984 --mode cycle
```

Useful commands:

```sh
node dist/cli.js catalog --query death
node dist/cli.js pair scp-008 --mode breach --with scp-015
node dist/cli.js pair scp-4010 --mode double-feature --explain
node dist/cli.js pair scp-008 --mode breach --json
node dist/cli.js validate
```

The default setting returns up to five reviewed results. `--setting rough` also includes weaker rule-based signals. `--explain` shows the scoring basis and source locations; `--json` returns the same results as JSON.

For dataset scope and scoring, see [DATASET.md](DATASET.md). For code and data corrections, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

```sh
npm run check
```

## License

Code is available under the [MIT License](LICENSE). SCP-derived profiles, quotations, and metadata are distributed under [CC BY-SA 3.0](LICENSE.content.md). This is an unofficial SCP Wiki project.
