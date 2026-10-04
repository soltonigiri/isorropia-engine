# Isorropía Engine — MVP仕様

- 表示名: **Isorropía Engine**
- リポジトリ名: `isorropia-engine`
- CLI名: `isorropia`

> SCPを1件指定すると、異常性の作用・発動条件・対象・制約を照合し、「封じ合う相方」「最悪の収容違反を起こす相方」「一緒に読む価値のある相方」を、非カノンの仮説として根拠付きで返すOSS。

## 対象

SCP ENのキュレーション済み100プロファイルを起点に、ローカルの固定データから組み合わせを計算する。CLIは3モードとJSON出力に対応し、データは圧縮JSON・SQLiteでも配布する。

データ更新では、SCP Data APIから新規・改稿記事を差分取得し、記事の作用・収容依存関係・読書特性と組み合わせの根拠を記録する。

## CLI仕様

### 基本コマンド

```bash
isorropia pair scp-3984 --mode cycle
isorropia pair scp-008 --mode breach --json
isorropia pair scp-4010 --mode double-feature
```

`pair` は指定したSCPを除く登録済みプロファイルから候補を取得し、デフォルトで信頼度0.50以上の上位5件までを返す。並び順はスコア降順、信頼度降順、`page_id` 昇順とする。弱いメタデータ信号は `--setting rough` でのみ表示する。

### モード

| モード | 判定内容 |
|---|---|
| `cycle` | 異常性が相互に打ち消し、制限し、または均衡させる可能性 |
| `breach` | 異常性の増幅や連鎖によって収容違反が悪化する可能性 |
| `double-feature` | 設定、構造、主題、読後感が補完または共鳴する可能性 |

### 出力

各結果に次を含める。

- 候補の `page_id` と記事タイトル
- スコア
- 0から1の信頼度。確率ではなく、表示した因果関係を記事根拠が支える度合いを表す
- 発火した判定ルール
- 入力側と候補側を1件以上ずつ含む、合計2件以上の根拠
- 根拠ごとの記事版ID、セクション、位置情報
- `Containment hypothesis — not canonical.` の固定表示

`--json` は人間向けの装飾を含めず、同じDB版と入力に対してバイト単位で同じ結果を返す。

### 信頼度設定

`--setting rough|coarse|1:1|fine|very-fine` を信頼度の最低値プリセットとして提供する。

| Setting | 最低信頼度 |
|---|---:|
| `rough` | 0.00 |
| `coarse` | 0.25 |
| `1:1` | 0.50 |
| `fine` | 0.70 |
| `very-fine` | 0.85 |

この指定は結果を絞り込むだけで、採点自体は変えない。指定した最低値を満たす候補が5件未満なら、該当件数だけを返す。

## データ仕様

```yaml
profile:
  page_id: scp-xxxx
  language: en
  revision: 42
  effects:
    - domain: memory
      operation: erase
      target: human_knowledge
      trigger: observation
      persistence: persistent
      constraints: [line_of_sight]
      evidence:
        section: description
        locator: "..."

edge:
  from: scp-xxxx
  to: tale-yyyy
  type: explicit_link
  evidence:
    revision: 42
    locator: "..."

interaction:
  id: breach:scp-008:scp-871
  pages: [scp-008, scp-871]
  mode: breach
  verdict: accepted
  mechanism: operational-cascade
  claim_refs:
    scp-008: [infectious-lethal-prion]
    scp-871: [continuous-consumption-containment]
  assumption: "both incidents affect the same containment operation"
  support: B
```

`edge.type` はMVPで `explicit_link` / `shared_entity` / `same_series` の3種類とする。取得した全文はGitにコミットせず、プロファイル、エッジ、ルール、Schema、帰属manifestだけを版管理する。

新しい意味プロファイルは、分析したソース範囲と方針版を保持する。組み合わせ判定はモード別の証明構造と意味データ版を保持し、根拠や方針が古い判定を検証で失効させる。

## 採点仕様

- 定性的な組み合わせ判定は列挙値のルーブリックとしてDBに保持し、数値は版管理された明示ルールで決定論的に計算する。
- 例: `erase × externalize → cycle`、`self-replicating × trigger-amplifier → breach`。
- ルールは根拠の存在を必須とし、根拠のないスコア加算を禁止する。
- タグの一致だけで高得点または通常の信頼度には到達させない。
- スコアは組み合わせの強さと発見価値、信頼度は根拠の充足度として分離する。
- 同じデータ、ルール、入力からは常に同じ順位を返す。
- ルール版には採点ポリシーと実行される採点・並べ替え契約を含める。

## 更新とGit運用

```text
メンテナ保守ジョブを週次または手動実行
  → 版IDで新規・変更ページを検出
  → メタデータと明示リンクを抽出
  → 該当記事の意味プロファイルを本文根拠付きで差分生成
  → 該当記事に接続する組み合わせ仮説を失効させ、影響候補を再評価
  → Schema・列挙値・根拠・版ID・重複・帰属を検証
  → 正例と負例のgolden testを実行
  → 決定論的に実行用ランキングを再生成
  → 許可された構造化データだけを含むDraft PRを作成
  → 人間が根拠と推薦内容をレビュー
  → merge後に圧縮JSONとSQLiteを生成
```

mainへの自動コミット、検証失敗時のPR作成、記事版が変わっていない既存の手書き値の自動上書きを禁止する。初期100件の定性レビューが完了するまでは新規記事を追加しない。以後は `selection-policy.json` の適格条件と多様性を含む重みで候補を決定し、1回に本文を分析する上限を100件とする。

## ライセンスと帰属

- コードはMIT Licenseで配布する。
- SCP由来の構造化データ、引用、説明文はコードから分離し、CC BY-SA 3.0と帰属情報を適用する。
- 帰属manifestには記事URL、タイトル、著者、取得した版IDを保持する。

## MVP完成条件

- SCP ENのキュレーション済み・構造検証済み初期プロファイルが100件以上ある。
- 3モードと誤検出防止を含むレビュー済みgolden pair testが10組以上ある。
- デフォルト設定では、品質基準を満たす候補のみを5件まで返す。
- 各結果は入力側と候補側の根拠を各1件以上表示する。
- 同じ入力、DB版、ルール版でJSON出力が一致する。
- 検証失敗時に自動PRを作らず、手書き値を自動上書きしないことをテストで確認する。
- 全ての通常出力に `Containment hypothesis — not canonical.` がある。
- 新規checkoutから文書化された手順でCLIを起動できる。
- 帰属付きの圧縮JSONとSQLiteを同じソースから再生成できる。

## 参考

- https://scp-wiki.wikidot.com/project-isorropia
- https://scp-wiki.wikidot.com/fragment%3Aketer-duty-1
- https://scp-wiki.wikidot.com/scp-914
- https://scp-wiki.wikidot.com/licensing-guide
