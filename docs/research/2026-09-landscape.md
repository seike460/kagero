# Grafana × AWS Lambda ファミリーの現状調査（2026-09）

- 調査日: 2026-09-26
- 対象: AWS Lambda の各実行形態（関数・Managed Instances・Durable Functions・MicroVMs）と、Grafana のエコシステムです。
- 目的: kagero が埋めるべき空白を、根拠つきで示します。

## 結論

- Lambda の新しい実行形態が、1 年で 3 つ出ました。どれも「1 回の呼び出しごとに見る」従来の見方が通用しません。
- Grafana で Lambda を見る道具は、CloudWatch API（GetMetricData）頼みのまま止まっています。OTel・PromQL・Loki・Tempo を前提にした公開ダッシュボードはありません。
- Lambda MicroVMs の公式な監視は、ログと CloudTrail だけです。メトリクスも OTel 連携もありません。Grafana 公式の手順も見つかりませんでした。

## 調べ方

- 公式ドキュメント、AWS What's New、各社のブログ、GitHub（stars と最終更新）、grafana.com（ダウンロード数）を調べました。
- 日付は YYYY-MM-DD で書きます。日付のない公式ページは、2026-09-26 に閲覧した内容です。
- stars やダウンロード数は、調査日時点の値です。
- 確かめられなかった事項は「未確認」と書きます。確かめる PoC は [8 章](#8-未確認事項と-poc-の対応) に示します。

## 1. AWS Lambda MicroVMs

### 1-1. 概要

- 2026-06-22 に発表されました。発表文は「available today」で、プレビューの表記はありません。
- 開始時のリージョンは、バージニア北部・オハイオ・オレゴン・アイルランド・東京の 5 つです。2026-08 に、ムンバイ・シンガポール・シドニー・フランクフルト・ストックホルムが加わりました。
- 2026-08 に PrivateLink にも対応しました。
- 中身は Firecracker の VM です。Dockerfile からイメージを作り、初期化を終えた状態をスナップショットにします。起動は、このスナップショットから行います。
- アプリは、Amazon Linux 2023 の VM の中で、コンテナとして動きます。
- 1 台は最長 8 時間動きます（`maximumDurationInSeconds` は 1〜28,800 秒）。停止（suspend）と再開（resume）の間も、メモリとディスクを保ちます。
- 公式の用途例は、AI が生成したコードの実行、対話型の開発環境、マルチテナントの CI、脆弱性スキャンなどです。
- Claude Managed Agents のセルフホスト型サンドボックスとして、公式の連携手順があります。
- 実測例（2026-06-25 の記事）: 起動 API は 1.17 秒、RUNNING まで約 12 秒、初回リクエストは 911ms、停止から再開までは 1.86 秒でした。

### 1-2. 大きさと料金

- baseline（基本の割り当て）は 0.5〜8 GB から選びます。2 GB あたり 1 vCPU です。
- 負荷が高いときは、baseline の最大 4 倍まで自動で増えます。
- 起動中は baseline の分を払います。baseline を超えて使った分は、使った秒数だけ払います。
- 停止中は計算の料金がかからず、保存の料金だけがかかります。
- 料金ページには ARM の単価だけが載っています（us-east-1）。

| 項目 | 単価 |
|---|---|
| メモリ | $0.0000036667 / GB 秒 |
| vCPU | $0.0000276944 / vCPU 秒 |
| 起動時のスナップショット読み込み | $0.00155 / GB |
| 停止時のスナップショット書き込み | $0.0038 / GB |
| 停止中の保存、イメージの保存 | $0.08 / GB 月 |

- 東京リージョンの単価は、料金ページで確かめられませんでした（未確認）。
- バースト分の測り方（何を「使った」と数えるか）は、未確認です。

### 1-3. ライフサイクルフック

- フックは、アプリが公開する HTTP エンドポイントです。Lambda が節目ごとに POST します。
- パスは `/aws/lambda-microvms/runtime/v1/<フック名>` です。
- フックを受けるポートは、1 つだけ設定できます。

| フック | 呼ばれる時点 | 主な用途 |
|---|---|---|
| `/ready` | ビルド中、アプリの起動後 | 「スナップショットを撮ってよい」と伝えます。503 を返すと再試行されます |
| `/validate` | ビルド後、新しい MicroVM で | 再開後の動作を確かめます。スナップショットの先読みの最適化にも使われます |
| `/run` | スナップショットから起動した直後 | `microvmId` と `runHookPayload`（16KB まで）を受け取ります。200 を返すまで、外からの通信は届きません |
| `/suspend` | 停止の直前 | 書き込みの flush や接続の切断に使います |
| `/resume` | 再開の直後 | 接続の張り直しや資格情報の更新に使います。フックが返るまで SUSPENDED のままです |
| `/terminate` | 終了の直前 | データの flush や外部への通知に使います |

- ビルド時のフックの時間上限は 1〜3,600 秒です。
- CloudFormation の定義では、実行時のフックを個別に有効化できます。時間上限は 1〜60 秒です。
- 自動停止は、エンドポイントへの通信が途絶えた時間で判断されます（`maxIdleDurationSeconds`）。自動再開は、通信が届いたときに起きます。

### 1-4. スナップショットの注意

- スナップショットには、全プロセスのメモリ、ディスク、開いた接続やファイル記述子が写ります。
- 同じイメージのバージョンから起動した MicroVM は、すべて同じ初期状態を共有します。
- 公式は、一意の ID・秘密情報・乱数の種をビルド時に作らず、`/run` で作り直すよう案内しています。
- 暗号用の乱数は、`/dev/urandom` から取る実装を使うよう案内しています。OpenSSL は、AWS が用意したスナップショット対応版を勧めています。
- イメージの環境変数（最大 50 個）はビルド時に設定され、すべての MicroVM で共有されます。

### 1-5. 通信と権限

- 受信: MicroVM ごとに HTTPS エンドポイントが割り当てられます。JWE 形式のトークン（`X-aws-proxy-auth`）が必須で、トークンごとに許可するポートを指定します。
- 受信で使えるプロトコルは、HTTP/1.1、HTTP/2、WebSocket、gRPC、SSE です。帯域は大きさに比例し、1〜16 MB/s です。
- 送信: 既定でインターネットに出られます。VPC の network connector を付けると、VPC 経由になります。
- 実行時の IAM ロールは、`run-microvm` の `--execution-role-arn` で渡します。Claude Managed Agents の連携ページには、IMDSv2 経由で短期の資格情報を使うと書かれています。
- `additionalOsCapabilities: ["ALL"]` を付けると、eBPF、ファイルシステムのマウント、ネットワーク名前空間が使えます。影響は VM の中に限られます。

### 1-6. 公式の監視機能

- CloudWatch Logs: ビルドのログと、実行時の stdout・stderr を送ります。既定のロググループは `/aws/lambda-microvms/<イメージ名>` で、ストリーム名は MicroVM の ID です。送り先の変更と無効化ができます。
- CloudTrail: 管理イベントは既定で記録されます。`RunMicrovm`・`SuspendMicrovm`・`ResumeMicrovm`・`TerminateMicrovm` などはデータイベントで、有効化が必要です。
- `get-microvm` の `stateReason`: 予期しない終了の理由が入ります。
- 監視のページに、CloudWatch メトリクス、EventBridge イベント、OpenTelemetry の記載はありません。
- 自動停止・自動再開が CloudTrail に残るかは、未確認です。

### 1-7. IaC

- CloudFormation に `AWS::Lambda::MicrovmImage` と `AWS::Lambda::NetworkConnector` があります。
- `MicrovmImage` には、Hooks・Logging・AdditionalOsCapabilities・EnvironmentVariables・Resources などの項目があります。
- MicroVM の起動（`run-microvm`）は実行時の API です。CloudFormation では扱いません。

### 1-8. 先行例と競合

- SigNoz は、イメージの中に OTel Collector を置く手順を公開しています。ただし、`/run` での個体識別の実装、停止前の送り切り、コスト、ダッシュボード、eBPF は扱っていません。停止中はメトリクスが途切れる、と明記しています。
- `ewhauser/eve-extensions` の PR #126（2026-09-17 マージ、2 stars）は、制御面のライフサイクルを OTel の span にします。
- AWS 公式サンプル（Claude Managed Agents 連携、49 stars）には、OTel・メトリクス・ダッシュボードがありません。コストは Cost Explorer 任せです。
- Grafana 公式の MicroVMs 向け手順は、見つかりませんでした。

## 2. Lambda 関数・Managed Instances・Durable Functions

### 2-1. 課金とログの変化

- 2025-08-01 から、INIT（初期化）フェーズも課金対象になりました。対象は、マネージドランタイムの ZIP 形式でオンデマンドの関数です。
- REPORT 行の Billed Duration に、INIT が含まれます。AWS は、INIT は呼び出しの 1% 未満で起きると説明しています。
- 2025-05-01 から、Lambda のログを S3 や Amazon Data Firehose に直接送れます。単価は $0.25/GB から、量に応じて $0.05/GB まで下がります。
- この経路のログは「Delivery」クラスになり、Logs Insights と Live Tail は使えません。Firehose は最大 300 秒まで溜めてから送ります。
- CloudWatch Logs の Intelligent-Tiering が、2026-07-15 に出ました。

### 2-2. OpenTelemetry for Lambda の現状

- `opentelemetry-lambda`（433 stars）は、6〜10 週ごとにリリースされています。collector layer 0.23.0 は 2026-08-10 のリリースです。
- collector layer は約 210MB あり、上限の 250MB に近づいています（#1733）。
- 計装と collector を入れると、Python のコールドスタートは p95 で 322ms から 2,270ms に延びました。Java は 1,730ms から 7,910ms でした（2026-04-06 の計測）。
- `telemetryapi` receiver は alpha です。起動に 3 秒以上かかるという報告があります（#2100）。
- この receiver は、2026-01 から `faas.coldstarts`・`faas.errors`・`faas.timeouts`・`faas.init_duration` などを出すようになりました。コストの指標は出しません。
- OTel の FaaS セマンティック規約は、まだ Development の段階です。
- decouple processor を使うと、関数は送信を待たずに返ります。ただし課金される時間は延び、データが数分遅れることがあります。
- SQS や EventBridge をまたぐと trace が切れる問題が、長く未解決です（#1787）。凍結と解凍で時刻がずれる問題もあります（#2263）。
- AWS は、collector を含まない「AWS Lambda Layer for OpenTelemetry」を勧めています。これは CloudWatch Application Signals の土台です。
- X-Ray の SDK とデーモンは、2026-02-25 から保守モードです。

### 2-3. 軽量な代替と商用製品

- Rotel（Rust 製）の Lambda extension は v0.1.6（2026-08-03）です。OTLP・ClickHouse・Kafka・Datadog・X-Ray・EMF へ送れます。
- serverless-otlp-forwarder は、関数が OTLP を標準出力に書き、別の Lambda が転送する方式です。まだ実験段階です。
- Datadog は Rust 製の extension で、コールドスタートの上乗せを約 450ms から 70ms に減らしました（2025-04-09）。推定コスト、コールドスタートのタグ、OOM とタイムアウトの数を出します。Durable Functions の追跡にも対応しました（2026-08-18）。
- Dash0 は、タイムアウトや OOM で終わった呼び出しを、合成の span で見せます（2026-07-20）。2026-02-04 に Lumigo を買収しました。
- OSS には、推定コストやコールドスタートの費用といった「計算済みの指標」がありません。

### 2-4. Lambda Managed Instances（2025-11-30）

- 1 つの実行環境で、複数のリクエストを同時に処理します。
- 料金は、EC2 インスタンスの料金、その 15% の管理料、100 万リクエストあたり $0.20 の合計です。実行時間の課金はありません。
- extension は SHUTDOWN しか受けられません。Telemetry API の `platform.report` には `durationMs` しか入りません。
- 実行環境ごとの同時実行数・CPU・メモリと、スロットリングの理由を示すメトリクスが加わりました。
- 1 回の呼び出しごとの実行時間やメモリは、意味を持ちにくくなりました。

### 2-5. Lambda Durable Functions（2025-12-02。Java は 2026-04-21 に GA）

- `DurableExecution*` という新しいメトリクスがあります。
- 標準の Invocations と Duration は、再実行（replay）のたびに数えられます。
- 状態の変化は EventBridge に届きます。実行の履歴は `GetDurableExecutionHistory` で取れます。
- 公式の OTel プラグインは、実験段階です。X-Ray 以外（Tempo など）へ送ると、span が落ちたり、根のない span になったりします（#929、2026-09-24）。
- CloudWatch は span link を描きません。
- 料金は、100 万オペレーションあたり $8 です。

### 2-6. その他

- テナント分離モード（2025-11-19）: tenantId が JSON ログに入り、テナントごとにログストリームが分かれます。テナントごとのメトリクスの次元は、未確認です。
- SnapStart: Python と .NET が 23 リージョンに広がりました（2025-06-17）。2026 年にはコンテナイメージにも対応しました。
- ランタイム: Java 25 と Rust の正式サポート（2025-11-14）、Python 3.14（2025-11-18）、Node.js 24（2025-11-25）が出ました。
- Powertools の Tracer は、まだ X-Ray SDK に依存しています。OTel への移行は、RFC の段階です。
- eBPF は Lambda 関数では動きません（AWS 公式ブログ、2025-05-05）。

## 3. CloudWatch の OTLP 受信と PromQL

- OTel メトリクスの受信と、PromQL での問い合わせが、2026-06-16 に GA になりました。プレビューは 2026-04-02 でした。
- 取り込みは $0.50/GB です。API からの問い合わせは、走査した 100 万サンプルあたり $0.01 です。コンソールからの問い合わせは無料です。
- 上限は、1 クエリ 500 系列、期間 7 日です。
- Lambda の標準メトリクス（`AWS/Lambda`）は、リソースタグを付けて PromQL で問い合わせられます。
- Grafana からは、Amazon Managed Prometheus のデータソースで `sigv4Service=monitoring` を指定して問い合わせます。Amazon Managed Grafana では、12.4 と AMP プラグイン 3.0.0 以上が必要です。
- OTLP のエンドポイントは、traces が X-Ray（SigV4 と Transaction Search が必要）、logs が CloudWatch Logs、metrics が CloudWatch です。いずれも HTTP だけで、gRPC は使えません。
- Transaction Search の span は `aws/spans` に入ります。取り込みは $0.35/GB（段階制）で、索引付けは最初の 1% が無料です。
- 比較: GetMetricData は 1,000 メトリクスあたり $0.01 で、無料枠がありません。500 メトリクスを毎分更新すると、月に約 $216 かかります。
- PromQL の問い合わせの方が GetMetricData より安くなるかは、未確認です。

## 4. Grafana と Amazon Managed Grafana

### 4-1. Lambda 向けの公式資産

- `pyroscope-lambda-extension` は、2026-06-05 にアーカイブされました。後継は示されていません。
- `lambda-promtail` は、2025-07 に Loki のリポジトリから独立しました（11 stars、v1.0.1 は 2026-07-23）。Issue に保守者の返答が少なく、Loki の送信手段の一覧からも外れました。
- Promtail 本体は 2026-03-02 にサポートを終えました。`lambda-promtail` はこの対象外です。
- `grafana/collector-lambda-extension` は 6 stars で、最新は v0.138.0+grafana（2025-10-29）です。本家より約 19 バージョン遅れています。
- Alloy を Lambda extension として動かす取り組みは、見つかりませんでした。Firehose を OTLP で受けるコンポーネントの要望（#287）は「Likely Decline」です。
- Grafana Cloud の Lambda 監視は、CloudWatch メトリクスが中心です。取り込みは、YACE による取得か、Firehose 経由の metric streams（2025-08-26 GA）です。
- Lambda の計装手順は、ブログ記事にしかありません。公式ドキュメントに Lambda の章はありません。
- Lambda を呼び出すデータソースのプラグインはありません。Infinity プラグインと SigV4 で代用する方法だけがあります。

### 4-2. プラットフォームの流れ

- Grafana 13（2026-04-21）で、dashboard schema v2 と Git Sync が GA になりました。v1 のダッシュボードは自動で移行されます。
- Grafana 13.2 で React 19 に移りました。プラグインと Scenes は、React 19 への対応が必要です。
- `grafanactl` は廃止予定です。後継の gcx が GA になりました（2026-07-28、747 stars）。
- Grafana Foundation SDK（261 stars）は、schema v2 への対応を進めています。サーバーレスの例はありません。
- SQL expressions が GA になりました（2026-07-15）。
- Grafana Assistant は、2025-10-08 に GA になりました。mcp-grafana は 3,497 stars で、最新は v1.6.0（2026-09-25）です。
- CloudWatch データソースは、独立したリポジトリで開発されています。2026-07 に PromQL のエディタを備えました。
- X-Ray データソースは「AWS Application Signals」に名前が変わりました。
- Alloy の最新は v1.20.0（2026-09-25）です。
- Beyla は OpenTelemetry に寄贈され、OBI（OpenTelemetry eBPF Instrumentation）になりました。
- Grafana OnCall OSS は、2026-03-24 にアーカイブされました。

### 4-3. Amazon Managed Grafana

- 最新は 12.4 です。新規作成は 2026-04-17 から、10.4 からの更新は 2026-05-15 からできます。13 はありません。
- 12 では、Angular のプラグインと API キーが廃止されました。サービスアカウントのトークンを使います。
- 2026-02-18 に、利用者が管理する KMS キーに対応しました。

## 5. k6 と負荷試験

- k6 1.0 は 2025-05-06 に、k6 2.0 は 2026-05 に出ました。2.0 は OTel の出力をネイティブで持ちます。最新は v2.3.0（2026-09-21）です。
- Lambda で k6 を分散実行する、保守中の OSS はありません。唯一の layer は、2020 年から更新がありません。
- Artillery は、Lambda での実行を標準で備えています。
- AWS の「Distributed Load Testing on AWS」は、Fargate で k6 を動かします。Grafana への出力はありません。
- Lambda 関数の上限は 15 分です。Managed Instances の 90 分は、非同期とイベントソース経由に限られます。
- 国内でも、k6 を Lambda で動かす自作例が出ています（2025-05、2025-06）。
- k6 の Prometheus 向けダッシュボード（#18030）は、107 万ダウンロードあります。
- k6 のライセンスは AGPL-3.0 です。同梱するときは、改変せずにライセンス表示を付ける必要があります。

## 6. 既存 OSS と空白地帯

| 分野 | 既存のもの | 空白 |
|---|---|---|
| MicroVMs の監視 | SigNoz の手順、eve-extensions の PR | Grafana 向けの手順、個体識別、送り切り、コスト、ダッシュボード |
| Lambda 関数のダッシュボード | grafana.com の 7 件。すべて CloudWatch API が前提で、最多の #593 は 2,339 万ダウンロード | OTel・PromQL・Loki・Tempo を前提にしたもの、コストのダッシュボード、mixin |
| コールドスタートと INIT の費用 | 商用製品（Datadog など） | OSS の計算済み指標 |
| Durable Functions の追跡 | Datadog、AWS の実験的なプラグイン | Tempo でもつながる trace、再実行の可視化 |
| k6 の分散実行 | Artillery、AWS の Fargate 版 | Lambda と MicroVMs で動き、Grafana に結果を出すもの |
| IaC | Terraform provider（公式）、cdk-monitoring-constructs（CloudWatch 専用、554 stars） | Grafana 向けの CDK constructs（既存は 0〜4 stars） |

見送る分野:
- Lambda を呼ぶデータソース: 需要の兆しがありません。
- Grafana を Lambda で動かすこと: アラートの評価に常駐プロセスが要ります。共有ファイルシステム上の SQLite も、ロック競合を起こしやすいです。
- AI SRE: OpenSRE（11,222 stars）、HolmesGPT、AWS DevOps Agent、Grafana Assistant で混雑しています。

## 7. 国内の状況

- Qiita で Grafana と Lambda の両方のタグが付いた記事は、累計 2 件です（2022 年と 2023 年）。
- DevelopersIO には、Grafana・Tempo・Loki の構築記事があります（2026-02-06）。ただし ECS 上の構成で、Lambda ではありません。
- JAWS-UG 山梨 #13 で、OTel のメトリクスを CloudWatch に送り、PromQL で見る登壇がありました（2026-09-11）。
- ServerlessDays Tokyo 2026 の可観測性の登壇は、Datadog が土台でした。
- Grafana Labs は 2025-11-12 に日本法人を設立し、東京リージョンで Grafana Cloud を提供しています。
- 作者（seike460）も、ADOT と CloudWatch Application Signals をテーマに登壇しています（2026-08-22）。

## 8. 未確認事項と PoC の対応

| 未確認事項 | 確かめる PoC |
|---|---|
| MicroVM のコンテナ内で、実行ロールの資格情報をどう取れるか | [PoC-01](../poc/01-runtime-environment.md) |
| `runHookPayload` が CloudTrail に残るか | [PoC-01](../poc/01-runtime-environment.md) |
| 自動停止・自動再開が CloudTrail に残るか | [PoC-02](../poc/02-hook-contract.md) |
| フックのポートが外から届くか | [PoC-02](../poc/02-hook-contract.md) |
| 各言語の OTel SDK の乱数が、複製の間で重なるか | [PoC-03](../poc/03-snapshot-safety.md) |
| 同期送信の設定で、停止の直前のデータが届くか | [PoC-04](../poc/04-flush-and-collector.md) |
| Alloy と Rotel のメモリと起動時間 | [PoC-04](../poc/04-flush-and-collector.md) |
| CloudWatch PromQL でのメトリクス名とラベルの変換 | [PoC-05](../poc/05-backend-parity.md) |
| PromQL の問い合わせが GetMetricData より安いか | [PoC-05](../poc/05-backend-parity.md) |
| 生成したダッシュボードが AMG 12.4 で動くか | [PoC-06](../poc/06-dashboard-delivery.md) |
| `platform.report` から INIT を含む費用を正しく出せるか | [PoC-07](../poc/07-functions-data.md) |
| Durable の実行履歴から、Tempo と X-Ray に同じ trace を組めるか | [PoC-08](../poc/08-durable-stitching.md) |
| MicroVMs のバースト課金の測り方と、東京リージョンの単価 | [PoC-09](../poc/09-cost-reconciliation.md) |
| ALL 権限で OBI（Beyla）が動くか | [PoC-10](../poc/10-k6-and-ebpf.md) |

## 9. 出典

### Lambda MicroVMs

- https://aws.amazon.com/about-aws/whats-new/2026/06/aws-lambda-microvms/
- https://aws.amazon.com/about-aws/whats-new/2026/08/lambda-microvms-5-additional-regions/
- https://aws.amazon.com/about-aws/whats-new/2026/08/lambda-microvms-supports-privatelink/
- https://aws.amazon.com/blogs/aws/run-isolated-sandboxes-with-full-lifecycle-control-aws-lambda-introduces-microvms/
- https://aws.amazon.com/blogs/compute/announcing-lambda-microvms-serverless-compute-environments-with-vm-level-isolation-and-near-instant-startup/
- https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html
- https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html
- https://docs.aws.amazon.com/lambda/latest/dg/microvms-images-snapshots.html
- https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html
- https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html
- https://docs.aws.amazon.com/lambda/latest/dg/microvms-monitoring.html
- https://docs.aws.amazon.com/lambda/latest/dg/microvms-best-practices.html
- https://docs.aws.amazon.com/lambda/latest/dg/microvms-integrations-claude-managed-agents.html
- https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-microvmimage.html
- https://aws.amazon.com/lambda/pricing/
- https://github.com/aws-samples/sample-lambda-microvm-claude-managed-agents
- https://signoz.io/docs/aws-monitoring/lambda-microvms/
- https://github.com/ewhauser/eve-extensions/pull/126
- https://dev.to/aws-builders/aws-lambda-microvms-i-tested-the-new-stateful-serverless-primitive-40jf

### Lambda 関数・Managed Instances・Durable Functions

- https://aws.amazon.com/blogs/compute/aws-lambda-standardizes-billing-for-init-phase/
- https://aws.amazon.com/about-aws/whats-new/2025/05/amazon-cloudwatch-tiered-pricing-additional-destinations-aws-lambda-logs
- https://aws.amazon.com/blogs/compute/aws-lambda-introduces-tiered-pricing-for-amazon-cloudwatch-logs-and-additional-logging-destinations
- https://aws.amazon.com/about-aws/whats-new/2026/07/amazon-cloudwatch-intelligent-tiering/
- https://docs.aws.amazon.com/lambda/latest/dg/telemetry-api.html
- https://docs.aws.amazon.com/lambda/latest/dg/telemetry-schema-reference.html
- https://github.com/open-telemetry/opentelemetry-lambda
- https://github.com/open-telemetry/opentelemetry-lambda/releases
- https://github.com/open-telemetry/opentelemetry-lambda/issues/1733
- https://github.com/open-telemetry/opentelemetry-lambda/issues/1787
- https://github.com/open-telemetry/opentelemetry-lambda/issues/2100
- https://github.com/open-telemetry/opentelemetry-lambda/issues/2263
- https://github.com/open-telemetry/opentelemetry-lambda/pull/2066
- https://opentelemetry.io/docs/specs/semconv/faas/faas-metrics/
- https://github.com/monodot/otel-bench-lambda/
- https://docs.aws.amazon.com/xray/latest/devguide/xray-sdk-migration.html
- https://docs.aws.amazon.com/xray/latest/devguide/xray-sdk-daemon-timeline.html
- https://github.com/streamfold/rotel-lambda-extension
- https://github.com/dev7a/serverless-otlp-forwarder
- https://www.datadoghq.com/blog/engineering/datadog-lambda-extension-rust/
- https://docs.datadoghq.com/serverless/aws_lambda/metrics/
- https://www.datadoghq.com/blog/trace-aws-lambda-durable-functions/
- https://www.dash0.com/blog/see-every-lambda-invocation-even-the-ones-that-never-finish
- https://aws.amazon.com/about-aws/whats-new/2025/11/aws-lambda-managed-instances/
- https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-monitoring-metrics.html
- https://docs.aws.amazon.com/lambda/latest/dg/durable-monitoring.html
- https://docs.aws.amazon.com/durable-execution/sdk-reference/observability/opentelemetry/
- https://github.com/aws/aws-durable-execution-sdk-js/issues/929
- https://aws.amazon.com/blogs/compute/building-multi-tenant-saas-applications-with-aws-lambdas-new-tenant-isolation-mode/
- https://github.com/aws-powertools/powertools-lambda/discussions/90
- https://aws.amazon.com/blogs/compute/monitoring-network-traffic-in-aws-lambda-functions/

### CloudWatch

- https://aws.amazon.com/about-aws/whats-new/2026/06/amazon-cloudwatch-otel-metrics/
- https://aws.amazon.com/blogs/mt/introducing-opentelemetry-promql-support-in-amazon-cloudwatch/
- https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-PromQL.html
- https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-PromQL-Grafana.html
- https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTelEnrichment-SupportedMetrics.html
- https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html
- https://aws.amazon.com/cloudwatch/pricing/
- https://grafana.com/docs/grafana/latest/datasources/aws-cloudwatch/

### Grafana と Amazon Managed Grafana

- https://github.com/grafana-cold-storage/pyroscope-lambda-extension
- https://github.com/grafana/lambda-promtail/releases
- https://github.com/grafana/loki/pull/18531
- https://grafana.com/docs/loki/latest/send-data/
- https://github.com/grafana/collector-lambda-extension/releases
- https://github.com/grafana/alloy/issues/287
- https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-infrastructure/monitor-cloud-provider/aws/logs/
- https://grafana.com/whats-new/2025-08-26-amazon-cloudwatch-metric-streams-for-cloud-provider-observability/
- https://grafana.com/blog/how-to-observe-aws-lambda-functions-using-the-opentelemetry-collector-and-grafana-cloud/
- https://grafana.com/blog/grafana-13-release-all-the-latest-features/
- https://grafana.com/whats-new/2026-07-28-gcx--the-cli-for-you-and-your-ai-agents--now-generally-available/
- https://github.com/grafana/grafana-foundation-sdk
- https://github.com/grafana/mcp-grafana
- https://github.com/grafana/grafana-cloudwatch-datasource/releases
- https://grafana.com/blog/opentelemetry-ebpf-instrumentation-beyla-donation/
- https://aws.amazon.com/about-aws/whats-new/2026/04/amazon-managed-grafana-v12-create/
- https://docs.aws.amazon.com/grafana/latest/userguide/version-differences.html
- https://docs.aws.amazon.com/grafana/latest/userguide/cloudwatch-promql.html

### k6

- https://grafana.com/blog/k6-2-0-release/
- https://www.artillery.io/docs/load-testing-at-scale/aws-lambda
- https://github.com/aws-solutions/distributed-load-testing-on-aws
- https://zenn.dev/aws_japan/articles/lambda-90-minutes-timeout
- https://grafana.com/grafana/dashboards/18030

### 既存 OSS と国内の状況

- https://grafana.com/grafana/dashboards/593-aws-lambda/
- https://github.com/cdklabs/cdk-monitoring-constructs
- https://github.com/grafana/terraform-provider-grafana
- https://github.com/Tracer-Cloud/opensre
- https://dev.classmethod.jp/articles/aws-o11y-grafana-tempo-loki-amp/
- https://speakerdeck.com/ota1022/opentelemetry-no-o-cloudwatch-ni-oku-te-promql-de-mi-te-mita
- https://speakerdeck.com/seike460/seeing-through-serverless-observability-for-aws-lambda-with-adot-and-cloudwatch-application-signals
- https://thinkit.co.jp/article/38681
