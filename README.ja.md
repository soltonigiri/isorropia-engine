# Isorropía Engine

[English](README.md)

Isorropía Engineは、キュレーション済みのSCP EN記事から組み合わせを探す、決定論的なCLIです。次の3モードがあります。

- `cycle`：互いの効果が打ち消し、制限、均衡につながるか
- `breach`：一方が他方の収容違反を悪化させるか
- `double-feature`：続けて読む価値があるか

結果は本文根拠に基づく仮説であり、SCPの公式設定ではありません。

## 起動

Node.js 24以降が必要です。

```sh
npm ci
npm run build
node dist/cli.js pair scp-3984 --mode cycle
```

主なコマンドは次のとおりです。

```sh
node dist/cli.js catalog --query death
node dist/cli.js pair scp-008 --mode breach --with scp-015
node dist/cli.js pair scp-4010 --mode double-feature --explain
node dist/cli.js pair scp-008 --mode breach --json
node dist/cli.js validate
```

初期設定では、レビュー済みの候補を5件まで返します。`--setting rough`では、ルールから得た弱い手掛かりも確認できます。採点根拠と記事内の位置は`--explain`で表示します。`--json`で同じ結果をJSONとして取得できます。

データの範囲と採点は[DATASET.md](DATASET.md)、コードやデータの修正方法は[CONTRIBUTING.md](CONTRIBUTING.md)を参照してください。

## 開発

```sh
npm run check
```

## ライセンス

コードは[MIT License](LICENSE)、SCP由来のプロファイル・引用・メタデータは[CC BY-SA 3.0](LICENSE.content.md)で提供します。SCP Wikiの非公式プロジェクトです。
