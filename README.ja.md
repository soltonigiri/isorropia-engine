# Isorropía Engine

[English](README.md)

相性のよさそうなSCP記事を探すコマンドラインツールです。

SCPを1つ指定すると、次の観点から組み合わせを提案します。

- 互いを封じたり、均衡したりする可能性
- 収容違反をさらに悪化させる可能性
- 2本続けて読むと面白そうな記事

各候補にはスコア、信頼度、短い理由、記事内の根拠が付きます。提案はあくまで仮説であり、SCPの公式設定ではありません。

<!-- ●●|●●●●●|●●|● -->

## 試し方

Node.js 24以降が必要です。

```sh
git clone https://github.com/soltonigiri/isorropia-engine.git
cd isorropia-engine
npm install
npm run build
node dist/cli.js pair scp-3984 --mode cycle
```

ほかの実行例：

```sh
node dist/cli.js pair scp-008 --mode breach --setting rough
node dist/cli.js pair scp-4010 --mode double-feature
node dist/cli.js pair scp-008 --mode breach --json
```

## モード

- `cycle`：互いを封じたり、均衡したりする組み合わせ
- `breach`：収容違反をさらに悪化させる組み合わせ
- `double-feature`：2本続けて読むと面白そうな組み合わせ

## 結果の見方

- **Score**：組み合わせそのものの強さ
- **Confidence**：表示された説明を記事内の根拠がどの程度支えているか

SCP-914設定で、表示する候補の厳しさを変えられます。初期設定は`1:1`です。

- `rough`：弱い候補も表示
- `coarse`、`1:1`、`fine`、`very-fine`：順に厳しくなる

通常のターミナルでは整形された表示になり、パイプへの出力や狭い画面では簡素な表示になります。

短縮した表示例：

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

## 開発

テストと同梱データの検証をまとめて実行できます。

```sh
npm run check
```

初期データには、レビュー済みのSCP EN記事が100件含まれます。

## ライセンス

コードは[MIT License](LICENSE)、SCP由来のプロファイル・引用・メタデータは[CC BY-SA 3.0](LICENSE.content.md)で提供します。このプロジェクトは非公式であり、SCP Wikiの承認を受けたものではありません。
