# kagero

kagero は、Grafana で AWS Lambda ファミリーを見るための可観測性キットです。対象は Lambda MicroVMs・Lambda 関数・Durable Functions・k6 の負荷試験です。送り先は、LGTM と Amazon CloudWatch の両方に対応します。

**状態: プレビューです。** 最新のリリースは v0.1.1（2026-09-29）です。最初の MicroVMs プレビューである v0.1.0 は、2026-09-28 に公開しました。エージェントは、コンテナイメージ `ghcr.io/seike460/kagero`（linux/arm64）として配布しています。TypeScript のパッケージは npm に公開していません。このリポジトリを checkout して使います。下のモジュールは実装済みで、CI（ユニットテスト、実際のエージェントバイナリを駆動する simulator の E2E、型検査、lint、生成物の差分検査）を通っています。ただし、**AWS の実機での PoC はまだ実行していません**。実機でしか分からない性質（タイムアウトの実値・資格情報の到達範囲・料金の実額・スナップショットの実挙動）は未検証です。「PoC を先に」という決めごとからの逸脱は [ADR-012](docs/decisions.md) に記録しています。詳しくは[ロードマップ](docs/roadmap.md)と[変更履歴](CHANGELOG.md)をご覧ください。

[English README](README.md)

## なぜ作るのか

- **Lambda MicroVMs には、監視の手段がほとんどありません。** MicroVMs は 2026-06-22 に発表されました。公式に用意されているのは、CloudWatch Logs、CloudTrail、`stateReason` だけです。メトリクスも OpenTelemetry 連携もなく、Grafana の手順もありません。さらに、スナップショットからの起動と停止・再開は、計測の前提を崩します。複製はすべて同じメモリ状態から始まり、停止の前に溜まったデータは失われることがあります。
- **Grafana の Lambda 用ダッシュボードは、CloudWatch API 頼みのままです。** grafana.com にある Lambda 用の 7 件は、すべて `GetMetricData` が前提です。OpenTelemetry・PromQL・Loki・Tempo を使うものはなく、コストを見せるものもありません。一方で、Lambda は 2025-08-01 から INIT フェーズも課金しています。CloudWatch は 2026-06-16 から OTLP の受信と PromQL に対応しました。
- **新しい実行形態には、新しい見方が要ります。** Managed Instances と Durable Functions では、「1 回の呼び出し」の意味が変わります。OSS の道具は追いついていません。商用製品は、推定コストやコールドスタートの追跡といった計算済みの指標で、その穴を埋めています。

出典つきの詳しい調査は [docs/research/2026-09-landscape.md](docs/research/2026-09-landscape.md) にあります。

## モジュール

| モジュール | すること | 目標 | 実装 |
|---|---|---|---|
| A. MicroVMs | Rust 製の小さなエージェント `kagero` が、コンテナの起動役として動きます。フックを決まった順で中継し、MicroVM ごとに識別情報を付け、停止と終了の前にテレメトリを送り切り、コスト推定のための使用量を記録します | v0.1（プレビュー） | `crates/kagero-agent` — 実装済み。simulator の E2E で検証。実機 PoC は未実施 |
| B. Lambda 関数 | PromQL と OpenTelemetry を前提にしたダッシュボードとアラートを用意します。コールドスタートと INIT の費用も分析します。Managed Instances にも対応します | v0.2 | `packages/dashboards` + `packages/pricing` — MicroVM 概要のダッシュボード（両方のバックエンド）とアラート（LGTM のみ。CloudWatch 向けは「非対応」と示す manifest）は実装済みで、生成した v1 JSON を CI で検査。`docs/design/functions-durable-k6.md` の関数レベルのダッシュボード・アラート MVP は**まだ未実装** |
| D. Durable Functions | 再実行を含む 1 つの実行を、Tempo か X-Ray で 1 本の trace として見せます | v0.3（実験） | `packages/durable-stitcher` — 実装済み。API の形は AWS のドキュメントで裏付け。実イベントは未検証 |
| C. k6 | Lambda 関数（15 分以内の分割）と MicroVMs（最長 8 時間）で k6 を大規模に動かし、結果を送り先に届けます | v0.4（実験） | `packages/k6-runner` — 枠組みは実装済み（Distributed Map による分割、EMF/OTLP/annotation の出力）。長時間実行向けの MicroVM 起動経路は**まだ未実装**。実実行は未検証。k6 本体（AGPL-3.0）は同梱しません。`KageroK6Run` の worker に、`bin/k6` とテストのスクリプトを置く layer を足します |

支える部品は `packages/sim`（実際のエージェントを駆動するフック simulator）、`packages/secrets`（Secrets Manager の解決）、`packages/cdk`（`KageroMicrovmImage`・`KageroDurableStitcher`・`KageroK6Run`）、`collector/`（LGTM と CloudWatch 向けの Alloy・OTel テンプレート）、`semconv/` + `packages/semconv`（属性の正本と、Rust・TypeScript の定数を出す生成器）、`examples/`（Node.js と Python の MicroVM イメージ）です。

**既知の制約:** 同じイメージの MicroVM が 2 台以上同時に動くと、ダッシュボードのメトリクスのパネルは、実際より大きな値を示します。コストの推定も同じです。ADR-008 で ID をメトリクスのラベルから外したため、各台の累積カウンタが 1 つの系列に混ざります。`rate()` と `increase()` は、これをカウンタのリセットと読みます。直し方は PoC-05 で決めます。

## 送り先（バックエンド）

最初から、両方のバックエンドに対応します。`KAGERO_BACKEND=both` で durable-stitcher の Lambda は両方へ出力します。MicroVM 内の collector では、`both` には独自のテンプレートが必要です。同梱のテンプレートは単一バックエンドです（`collector/README.md` を参照）。

durable-stitcher は、メトリクス（`kagero.durable.*`）を delta temporality（前回からの増分）で送ります。実行をまたいで状態を持たないためです。LGTM 側では、これを cumulative（累積値）に変える必要があります。Prometheus が変換するのは、実験的な機能フラグ `otlp-deltatocumulative` を有効にしたときだけです。Mimir は、既定では delta のメトリクスを拒否します。このような送り先では、`deltatocumulative` processor を入れた collector を前段に置きます。実際の送り先での挙動は、PoC-05 と PoC-08 で確かめます。

| | LGTM | Amazon CloudWatch |
|---|---|---|
| 取り込み | Grafana Cloud か、自前の Loki・Tempo・Mimir へ OTLP で送ります | SigV4 つきの OTLP（HTTPS）で送ります |
| メトリクス | PromQL（Prometheus のデータソース） | PromQL（Amazon Managed Prometheus のデータソースで `sigv4Service=monitoring` を指定） |
| ログ | LogQL | CloudWatch Logs Insights |
| trace | TraceQL | X-Ray / Application Signals |

生成するダッシュボードは、v1 の JSON 形式にします。Grafana 13、Grafana Cloud、Amazon Managed Grafana 12.4 のどれでも使えるようにするためです。

## 設計の原則

1. **ビルド時は静止し、`/run` で起動します。** ID・乱数の種・接続・秘密情報を、スナップショットの前に作りません。
2. **フックは決まった順で中継します。** 1 つの起動役がフックを中継します。実行時には、エージェントの失敗で処理を止めません。
3. **送り切りは同期送信で担保します。** キューの数値を見て待つ方式は取りません。
4. **ID はメトリクスのラベルに入れません。** MicroVM・テナント・セッションの ID は、ログと trace にだけ付けます。
5. **使用量の事実だけを送り、単価はクエリ側で掛けます。** 費用は必ず「推定」と表示し、AWS の請求データと照合します。
6. **1 つの仕様から、2 つのバックエンド向けに生成します。** 片方で出せないものは、黙って消さずに「非対応」と表示します。
7. **秘密情報をイメージの環境変数に入れません。** `/run` の時点で、実行ロールを使って取得します。
8. **信頼できないコードと同居する前提で設計します。** 残る危険は[脅威モデル](docs/design/architecture.md#9-脅威モデル)にまとめています。たとえば `KAGERO_HOOK_ALLOWED_PEERS` を設定するまでは、アプリが MicroVM 自身の IP からフックを偽造できます。

## 言語

- **MicroVM の中は Rust です**（エージェント `kagero` だけ）。メモリとスナップショットを小さく保てます。どのイメージにも単一の静的バイナリで入れられます。プロセスと権限を直接操作できます。
- **それ以外は TypeScript（Node.js 24）です。** 制御用の Lambda、AWS CDK の constructs、Grafana Foundation SDK によるダッシュボード生成、フックの simulator が対象です。

## 使い方

エージェントは、`linux/arm64` 向けのイメージ `ghcr.io/seike460/kagero` として公開しています。リリースごとに、版と minor のタグが付きます（v0.1.0 では `0.1.0` と `0.1`）。`latest` は、リリースのたびに動きます。MicroVM のイメージにバイナリをコピーし、エントリポイントにします。アプリは、そのコマンドとして渡します。

```dockerfile
FROM public.ecr.aws/lambda/microvms:al2023-minimal
COPY --from=ghcr.io/seike460/kagero:0.1 /kagero /usr/local/bin/kagero
COPY . /app
ENTRYPOINT ["/usr/local/bin/kagero", "--"]
CMD ["/app/start"]
```

動かすには、収集器とその設定テンプレート、エージェントの設定も要ります。[`examples/`](examples/README.ja.md) に、Node.js と Python の完全なイメージがあります。設定の一覧は [`examples/kagero.env.example`](examples/kagero.env.example) にあります。エージェントのイメージには、`/LICENSE` と `/licenses` も入っています。バイナリに組み込んだコードのライセンス文です。自分のイメージを配布するときは、これもコピーしてください。

## 開発

道具の版は [mise](https://mise.jdx.dev/) で固定しています。

```sh
mise install          # node 24, pnpm, rust
pnpm install
pnpm build            # パッケージのビルド（テストの前に必要）
cargo build -p kagero-agent  # simulator の E2E に必要
pnpm test             # 単体テスト + simulator の E2E
# 任意: 実物の otelcol-contrib を通して E2E を実行し、
# collector 側の属性の削除を端から端まで確かめる
KAGERO_SIM_COLLECTOR_BIN=/path/to/otelcol-contrib pnpm --filter @kagero/sim sim:e2e
# 同じバイナリで、配布する collector/lgtm と collector/cloudwatch の
# テンプレートも vitest で動かす
KAGERO_SIM_COLLECTOR_BIN=/path/to/otelcol-contrib pnpm --filter @kagero/sim test
pnpm lint && pnpm typecheck
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings
pnpm generate         # semconv の定数とダッシュボードを再生成
```

## 文書

設計書は日本語が正本です。主要な設計書の英訳が、同じ場所に `*.en.md` としてあります。PoC 手順書の個別ファイルと調査文書は、まだ日本語のみです。

| 文書 | 中身 |
|---|---|
| [全体設計](docs/design/architecture.md) | 目的、バックエンド、属性とカーディナリティ、ダッシュボードの仕様、コストモデル、脅威モデル、テスト、リリース |
| [MicroVMs の設計](docs/design/microvms.md) | フックの中継、静止と起動、送り切り、識別、使用量の記録 |
| [関数・Durable・k6 の設計](docs/design/functions-durable-k6.md) | バックエンド別のデータ経路、MVP の範囲、未解決の問い |
| [設計判断の記録（ADR）](docs/decisions.md) | 採用済みと提案中の設計判断 |
| [ロードマップ](docs/roadmap.md) | 段階、合格条件、対象外のもの |
| [PoC 手順書](docs/poc/README.md) | AWS の実機での検証。安全策と後片付けのチェックリストつき |
| [調査](docs/research/2026-09-landscape.md) | 2026-09 時点の現状調査 |

## 対象外

- Grafana 本体を Lambda で動かすこと
- Lambda を呼び出すデータソースのプラグイン
- AI による障害対応（AI SRE）
- v1.0 より前の、独自の Lambda extension

## 名前の由来

kagero は、昆虫の「蜉蝣（カゲロウ）」から取りました。命が短いことで知られる虫です。数秒で終わる関数や、数時間で終わる MicroVM のような、短命な計算資源にちなんでいます。

## 免責

kagero は独立した OSS です。Amazon Web Services や Grafana Labs の公式のものではなく、提携や支援も受けていません。AWS、AWS Lambda、Amazon CloudWatch、Grafana、Loki、Tempo、Mimir、k6 は、それぞれの権利者の商標です。

## ライセンス

[Apache License 2.0](LICENSE)

作者: [seike460](https://github.com/seike460)
