# Isorropía Engine

[日本語](README.ja.md)

Find SCP articles that might work together in an interesting way.

Give it one SCP and choose what you want to find:

- an anomaly that may contain or balance it
- an anomaly that may make a breach worse
- an article that may make a good double feature

Each suggestion includes a score, confidence, a short reason, and source references. The suggestions are ideas, not SCP canon.

<!-- ●●|●●●●●|●●|● -->

## Quick start

Requires Node.js 24 or newer.

```sh
git clone https://github.com/soltonigiri/isorropia-engine.git
cd isorropia-engine
npm install
npm run build
node dist/cli.js pair scp-3984 --mode cycle
```

List the SCP articles included in the catalog:

```sh
node dist/cli.js catalog
```

Add `--json` for structured output.

More examples:

```sh
node dist/cli.js pair scp-008 --mode breach --setting rough
node dist/cli.js pair scp-4010 --mode double-feature
node dist/cli.js pair scp-008 --mode breach --json
```

## Modes

- `cycle`: may contain or balance each other
- `breach`: may make a containment failure worse
- `double-feature`: may be interesting to read together

## Reading the results

- **Score** shows how strong the pairing is.
- **Confidence** shows how well the article sources support the explanation.

SCP-914 settings control how strict the results are. The default is `1:1`.

- `rough`: includes weak matches
- `coarse`, `1:1`, `fine`, `very-fine`: become gradually stricter

Interactive terminals use a formatted layout. Pipes and narrow windows use simpler text.

Shortened example:

```text
╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮
┃  ISORROPÍA ENGINE                                                          ┃
┃  CYCLE ANALYSIS                                           TARGET SCP-3984  ┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯

 01  SCP-2935                                                        SCORE 100
     CONFIDENCE  ██████████████████░░  0.90
     ⇄  Universal death prevention and universal life termination form a
        direct, article-specific containment-cycle hypothesis.
     CONDITION   The SCP-2935 effect must cross into the reality affected by
                 SCP-3984.
     QUERY       rev.46 · Description › including humans, are unable to die
     MATCH       rev.93 · Description › all life ... within SCP-2935 ended

Containment hypothesis — not canonical.
```

## Development

Run the tests and validate the included data:

```sh
npm run check
```

The project starts with 100 reviewed SCP EN articles.

## License

The code is available under the [MIT License](LICENSE). SCP-derived profiles, quotations, and metadata are distributed under [CC BY-SA 3.0](LICENSE.content.md). This is an unofficial project and is not endorsed by the SCP Wiki.
