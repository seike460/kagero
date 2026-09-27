# PoC-10: k6 と eBPF

- 優先: P2
- 決まること: モジュール C の設計、eBPF の扱い（opt-in の条件）
- 関連: [関数・Durable・k6 の設計 3 章](../design/functions-durable-k6.md#3-モジュール-c-k6-負荷試験ランナー実験)

## 目的

2 つのことを確かめます。1 つ目は、k6 を Lambda で分散実行できるかです。2 つ目は、MicroVM の中で eBPF による計装ができるかです。

## 前提

- [共通の安全策](README.md#共通の安全策) を満たしています。
- k6 は 2.x の ARM64 版を使います。改変はしません。
- eBPF の確認には、`additionalOsCapabilities: ["ALL"]` を付けた MicroVM を使います。

## 手順

k6:
1. k6 のバイナリを、Lambda（コンテナイメージか layer）で動かします。
2. 10 のシャードを同時に起動し、指定した時刻に開始させます。開始のずれを測ります。
3. OTel の出力で Grafana Cloud へ、EMF で CloudWatch へ、結果を送ります。
4. 使った k6 の版で OTel 出力のフラグ名（`opentelemetry` か、古い `experimental-opentelemetry` か）を確かめます。
5. EMF 経路は実行後に json を一括変換します。長時間試験で metrics が遅れて届く問題があるかを確かめ、必要ならファイルの逐次 tail に切り替えます。
6. CloudWatch 側で `AWS/Logs` の `EMFParsingErrors` が 0 であることを確かめます。
7. Lambda のログ形式は EMF が生きるテキスト形式で動かします。JSON ログ形式だと stdout の EMF 行がラップされて認識されません。worker のログ設定を記録します。
8. 実行座標の名前が経路で分裂しています（OTLP では k6 タグの `run_id`/`shard_id`、EMF では semconv の `kagero.k6.run.id`/`kagero.k6.shard.id`）。k6 タグ名にドットが使えるかを確かめ、可能なら semconv 名に統一します。

eBPF:
9. MicroVM の中で、OBI（または Alloy の `beyla.ebpf`）を動かします。
10. 計装していない HTTP サーバーから、span が取れるかを確かめます。
11. 負荷の上乗せ（CPU とメモリ）を測ります。

## 合格条件

- k6 の開始のずれが、2 秒以内であること。
- k6 の結果が、両方のバックエンドに届くこと。
- eBPF で span が取れ、負荷の上乗せが 5% 未満であること。

## 費用と後片付け

- 費用の目安: k6 の短時間の実行と、2 GB の MicroVM を 30 分で、合計 $1 未満を見込みます。
- 後片付け: 関数、Step Functions、MicroVM を消します。[チェックリスト](README.md#後片付けチェックリスト) もすべて確かめます。

## 結果

未実施です。
