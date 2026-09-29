# 収集器の設定

エージェントが `/run`（build-check では `/ready`）で描画するテンプレートです。
受け取りと加工は共通で、送り先（exporter と認証）だけを差し替えます（ADR-002、
architecture.md §5）。ADR-006 の同期送信のため、バッチ処理も送信キューも
使いません。アプリの flush が戻る時点で、バックエンドが受け取った状態です。

## 構成

| パス | 収集器 | バックエンド | 形式 |
|---|---|---|---|
| `lgtm/collector.yaml.tmpl` | contrib OTel collector | LGTM（Mimir/Loki/Tempo） | OTel YAML |
| `cloudwatch/collector.yaml.tmpl` | contrib OTel collector | Amazon CloudWatch | OTel YAML |
| `alloy/lgtm.alloy.tmpl` | Grafana Alloy（既定） | LGTM | river |
| `rotel/lgtm.env.tmpl` | Rotel | LGTM | env |
| `rotel/cloudwatch.env.tmpl` | Rotel | CloudWatch | env |

既定は Alloy（ADR-007）です。同梱の Alloy テンプレートは **LGTM 専用**
で、Alloy 版 CloudWatch はありません。CloudWatch には contrib collector の
YAML か Rotel の env テンプレートを使います。Rotel は軽量な比較対象です。
メモリ・起動時間・再読込の比較は PoC-04、バックエンドの等価性は PoC-05 で
確かめます。

LGTM のテンプレートは **3 シグナル共通の 1 エンドポイント** を前提にします。
`grafana/otel-lgtm` や Grafana Cloud の OTLP エンドポイントのような
統合 OTLP ゲートウェイです。Loki/Tempo/Mimir が分散している構成では
exporter を 3 つに分ける必要があります。その版はまだ同梱していません。

`KAGERO_BACKEND=both` は同梱テンプレートが**処理しない**印です。
ここにあるテンプレートはすべて単一バックエンドへ出力します。
両方へ出すには、両方の exporter を持つ独自の
`KAGERO_COLLECTOR_CONFIG_TEMPLATE` を載せます（エージェントは `both`
のときに警告します）。

## プレースホルダー契約

`crates/kagero-agent::collector::render_template` が置き換えます。
描画後に `{{KAGERO_*` が残る場合は失敗として扱い、書き出しません。

| プレースホルダー | 値 |
|---|---|
| `{{KAGERO_MICROVM_ID}}` | `/run` ボディの `microvmId` |
| `{{KAGERO_TENANT_ID}}` / `{{KAGERO_SESSION_ID}}` | JSON Pointer で取り出す任意の ID |
| `{{KAGERO_IMAGE_NAME}}` / `{{KAGERO_IMAGE_VERSION}}` / `{{KAGERO_SIZE}}` / `{{KAGERO_REGION}}` | イメージ環境変数の設定 |
| `{{KAGERO_OTLP_PORT}}` | loopback の OTLP/HTTP 受信ポート |
| `{{KAGERO_ENDPOINT_LGTM}}` / `{{KAGERO_ENDPOINT_CLOUDWATCH}}` | バックエンドの OTLP エンドポイント |
| `{{KAGERO_ENDPOINT_CW_METRICS}}` / `{{KAGERO_ENDPOINT_CW_LOGS}}` / `{{KAGERO_ENDPOINT_CW_TRACES}}` | CloudWatch OTLP の信号別エンドポイント。AWS の OTLP は信号ごとにホスト（`monitoring.`/`logs.`/`xray.`）と SigV4 サービス（`monitoring`/`logs`/`xray`）が異なります。解決順: 信号別 env（MicroVM エージェントでは `KAGERO_ENDPOINT_CW_*`、durable-stitcher Lambda では `KAGERO_OTLP_ENDPOINT_CLOUDWATCH_*`）→ 共有エンドポイント（`KAGERO_OTLP_ENDPOINT_CLOUDWATCH`。stitcher に CloudWatch ターゲットがある限り `KAGERO_OTLP_ENDPOINT` もフォールバックとして使えます）→ リージョンからの AWS 既定値 |
| `{{KAGERO_BACKEND}}` | `lgtm` / `cloudwatch` / `both` |
| `{{KAGERO_SECRET}}` | `/run` で取った SecretString 全体。キー指定と同じ安全性チェックがかかるため、引用符を含む JSON 文書は fail-closed で残ります。基本は `{{KAGERO_SECRET:key}}` を使ってください |
| `{{KAGERO_SECRET:key}}` | JSON SecretString の 1 キー |
| `{{KAGERO_RESOURCE_ATTRS}}` | ログ/trace 用の OTel `resource` アクション（ID を含む全識別属性） |
| `{{KAGERO_METRIC_ATTRS}}` | 同じリストの、レジストリ許可版（ADR-008） |

エンドポイントの値（`KAGERO_OTLP_ENDPOINT*`・`KAGERO_ENDPOINT_CW_*`）は、
二重引用符で囲んだ YAML・river の文字列と、シェルが source する env
ファイルへそのまま差し込みます。そのため、表示可能な ASCII でない値や、
`"`・`\`・`$`・バッククォートを含む値では、エージェントは起動しません。
これらの文字は URL の中でパーセントエンコードしてください。

### 秘密展開の安全性

`{{KAGERO_SECRET:...}}` と `{{KAGERO_SECRET}}` は **pristine なテンプレートに
だけ**展開します。`runHookPayload` 由来の信用できないスカラー値
（tenant/session ID）を差し込むより前の段階です。ID に紛れ込んだ
`{{KAGERO_SECRET:...}}` はそのまま文字として残り、fail-closed の残存
チェックに引っかかります。秘密の値そのものを再スキャンすることもありません。

## 秘密情報の形

`KAGERO_SECRET_ARN` は Secrets Manager の JSON シークレットを指します。
テンプレートは `username`/`password`（LGTM Basic 認証）または `basic_b64`
（Rotel の `Authorization` ヘッダー）のキーを想定します。秘密の値は YAML・
river・env ファイルへそのまま差し込むため、**表示可能な ASCII のみで、
`"`・`\`・`$`・バッククォート・改行を含まない**ものにしてください。
形式ごとのエスケープはしません。描画した env ファイルはシェルに
source されます。秘密の値に `{{KAGERO_` という文字列が含まれると
残存チェックが fail-closed で失敗します。その部分列を含まない
秘密を使ってください。CloudWatch 側は秘密を使いません。収集器の `sigv4auth` が
実行ロールで署名します（ADR-011）。

## CloudWatch の前提

CloudWatch のテンプレート（`cloudwatch/collector.yaml.tmpl` と
`rotel/cloudwatch.env.tmpl`）は、kagero が作らず、権限も付けない AWS の
リソースを使います。最初の `/run` より前に用意してください。用意がないと、
AWS は送信を拒みます。

- **ロググループとログストリーム。** CloudWatch Logs の OTLP エンドポイントは、
  既にあるロググループとログストリームにだけ書き込みます。ロググループ
  `/kagero/<image-name>`（`KAGERO_MICROVM_IMAGE_NAME`）と、その中のログストリーム
  `otlp` を作ります。同じイメージの MicroVM は、すべてこのストリームに書きます。
  OTel Collector のテンプレートは、resource 属性で MicroVM を見分けます。
  Rotel のテンプレートは見分けません（下の「未確認」を参照）。

## 識別属性のフィルタ（ADR-008）

ID はレコード単位ではなく **resource** 単位で刻印します（`resource`
プロセッサ / `otelcol.processor.transform` の `context = "resource"`）。
Prometheus 系の取り込みでラベルになるのは resource 属性だからです。メトリクスの pipeline はさらに、
アプリが自分の resource に主張した ID 形のキー（`service.instance.id`・
`faas.instance`・`kagero.tenant.id`・`kagero.session.id` など）を resource・
データポイント・scope の 3 つの段階で削除します（scope 属性は Prometheus
互換の取り込みで `otel_scope_*` ラベルになります）。ログと trace には
`upsert` で全識別属性を付け、アプリの自己申告を上書きします。

## 起動契約

`KAGERO_COLLECTOR_ARGS`（文字列の JSON 配列）が `KAGERO_COLLECTOR_BIN` の
後に続く argv です。`{config}` は `KAGERO_COLLECTOR_CONFIG_OUT` に置き換わり
ます。空でないリストに `{config}` が無ければ、設定パスを末尾に足します。
空のリストは argv なしを意味します。

| 収集器 | `KAGERO_COLLECTOR_BIN` | `KAGERO_COLLECTOR_ARGS` |
|---|---|---|
| Alloy | `alloy` | `["run","--storage.path=/run/kagero/collector-data","{config}"]`（既定） |
| contrib otelcol | `otelcol-contrib` | `["--config","{config}"]` |
| Rotel | `sh` | `["-c","set -a; . \"$0\"; exec rotel","{config}"]`（描画済み env を source して rotel を起動） |

## エージェントが読む環境変数

`KAGERO_COLLECTOR_BIN`、`KAGERO_COLLECTOR_ARGS`、
`KAGERO_COLLECTOR_CONFIG_TEMPLATE`、`KAGERO_COLLECTOR_CONFIG_OUT`、
`KAGERO_COLLECTOR_START`（`build`/`run`）、`KAGERO_COLLECTOR_RELOAD_URL`、
`KAGERO_BACKEND`、`KAGERO_SECRET_ARN`。

`KAGERO_COLLECTOR_START=build` にすると、スナップショットの前に収集器を起動します。
`KAGERO_SECRET_ARN` も設定した場合は、最初の起動を `/run` まで待ちます。
描画する設定に、`/run` で取る秘密情報が要るためです。

## 未確認（PoC）

- Alloy と Rotel のメモリ・起動時間・再読込の比較: PoC-04。
- CloudWatch OTLP の SigV4 サービス名とロググループ指定: PoC-05。
- Rotel の注意点: 内部バッチのため ADR-006 の同期性を完全には満たせません。
  `ROTEL_OTEL_RESOURCE_ATTRIBUTES` は全シグナルに付き、信号ごとの
  絞り込みはありません。ADR-008 を守るため、同梱の Rotel テンプレートは
  メトリクス安全な属性だけを付けます — **Rotel 経路では
  インスタンス・テナント・セッション ID を一切付けません**。そのため
  Rotel では MicroVM ごとのログ・トレース掘り下げができません。
  完全な識別には OTel Collector か Alloy のテンプレートを使います。
  Rotel の信号別サポートを広げる前に PoC-04 で再確認します。
