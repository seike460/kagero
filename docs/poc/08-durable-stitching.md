# PoC-08: Durable の組み立て

- 優先: P1
- 決まること: モジュール D の方式（完了後に組み立てるか、逐次に組み立てるか）
- 関連: [関数・Durable・k6 の設計 2 章](../design/functions-durable-k6.md#2-モジュール-d-durable-functions-の可視化実験)

## 目的

Durable Functions の実行履歴から、1 本の trace を組み立てられるかを確かめます。Tempo と X-Ray の両方で確かめます。

## 前提

- [共通の安全策](README.md#共通の安全策) を満たしています。
- X-Ray に OTLP で送るため、Transaction Search を有効にします。終わったら元に戻します。

## 手順

1. ステップ・待機・コールバック・再試行を含む Durable Function を用意します。
2. 実行して、EventBridge に届くイベントの中身を記録します。
3. `GetDurableExecutionHistory` で履歴を取り、中身と粒度を記録します。
4. 履歴から trace を組み立て、Tempo（Grafana Cloud）と X-Ray に送ります。
5. 同じ実行を 2 回組み立て、同じ trace になるかを確かめます。
6. 古い時刻（例: 数日前）の span を、Tempo と X-Ray が受け付けるかを確かめます。
7. `RUNNING` 通知と完了通知の間隔を記録し、完了通知時点で履歴 API が終端を返すかを確かめます（整合性レースの幅を測ります）。
8. X-Ray 側で、OTLP の trace ID 形式（16 バイト hex）がそのまま受け付けられるかを確かめます。
9. `kagero.durable.*` メトリクスの cumulative temporality が、Prometheus 系で `sum_over_time`/`count_over_time` で正しく集計できるかを確かめます（単一 writer 前提、`increase()` は使わない）。
10. リトライで失敗した handler の invocation が `InvocationCompleted` を出すかを確かめ、`replays = invocations − 1` の推定を検証します。
11. EventBridge は at-least-once 配送です。終端通知が重複したとき、trace は決定的 trace ID で重複除去されますが、メトリクスの data point は再送されるため `count_over_time` 系で二重に数えます。現状 dedupe store は持たないため、重複の実測頻度とメトリクスへの影響を記録します（大きければイベント `id` の dedupe を将来課題とします）。

## 合格条件

- 両方のバックエンドで、1 つの根の span の下に、実行の全体が並ぶこと。
- 再実行の回数が、span の属性として見えること。
- 組み立て直しても、同じ結果になること。

## 費用と後片付け

- 費用の目安: 実行は少量で、合計 $1 未満を見込みます。
- 後片付け: 関数、EventBridge のルールを消します。Transaction Search の設定を元に戻します。[チェックリスト](README.md#後片付けチェックリスト) もすべて確かめます。

## 結果

未実施です。
