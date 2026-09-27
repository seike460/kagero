# PoC 手順書

- 目的: 設計の前提を AWS の実機で確かめ、その結果で ADR を決めます。
- M0（PoC ゲート）の対象は、PoC-01〜05 です。M0 を通るまで、実装コードは書きません（実装は先行済み。逸脱の記録は [ADR-012](../decisions.md)。PoC の役割は「作る前の確認」から「動くものの検証」に変わります）。
- 最終更新: 2026-09-26

## 一覧

| # | 題名 | 優先 | 決まること | 状態 |
|---|---|---|---|---|
| 01 | [実行環境](01-runtime-environment.md) | P0 | ADR-011、CloudWatch への送り方、配布の方法 | 未実施 |
| 02 | [フックの振る舞い](02-hook-contract.md) | P0 | ADR-004 | 未実施 |
| 03 | [スナップショットの安全性](03-snapshot-safety.md) | P0 | ADR-005 | 未実施 |
| 04 | [送り切りと収集器](04-flush-and-collector.md) | P0 | ADR-006、ADR-007 | 未実施 |
| 05 | [バックエンドの違い](05-backend-parity.md) | P0 | ADR-002、ADR-008、ADR-010 | 未実施 |
| 06 | [ダッシュボードの配布](06-dashboard-delivery.md) | P1 | ADR-010 | 未実施 |
| 07 | [Lambda 関数のデータ](07-functions-data.md) | P1 | モジュール B のデータ経路 | 未実施 |
| 08 | [Durable の組み立て](08-durable-stitching.md) | P1 | モジュール D の方式 | 未実施 |
| 09 | [コストの照合](09-cost-reconciliation.md) | P1 | ADR-009 | 未実施 |
| 10 | [k6 と eBPF](10-k6-and-ebpf.md) | P2 | モジュール C の設計、eBPF の扱い | 未実施 |

## 共通の安全策

- 検証専用の AWS アカウントを使います。本番のアカウントでは行いません。
- リージョンは東京（ap-northeast-1）にします。
- 予算アラートを $30 に設定し、50% に達したら通知します。
- すべてのリソースに、`project=kagero`・`poc=<番号>`・`ttl=<削除予定日>` のタグを付けます。
- MicroVM の `maximumDurationInSeconds` は、1800 以下にします。
- 秘密情報は、ダミーだけを使います。
- LGTM 側は、Grafana Cloud の無料枠を使います。AWS から届かないローカルの環境は、simulator の確認だけに使います。
- 結果の生データは `poc-output/` に置きます。このディレクトリは Git の対象外です。
- 要約には、AWS アカウント ID、エンドポイントの URL、トークンを書きません。必要なら伏せ字にします。
- 費用の目安は、us-east-1 の ARM の単価で計算しています。東京の単価は PoC-09 で確かめます。

## 後片付けチェックリスト

PoC を終えるたびに、次をすべて確かめます。

- [ ] 起動中・停止中の MicroVM がありません（`aws lambda-microvms list-microvms`）。
- [ ] MicroVM のイメージとバージョンを消しました。
- [ ] network connector を消しました。
- [ ] Lambda 関数、Durable Functions、Step Functions、EventBridge のルールを消しました。
- [ ] Firehose のストリームを消しました。
- [ ] CloudTrail のデータイベントの設定を、元に戻しました。
- [ ] Transaction Search を有効にした場合は、元の設定に戻しました。
- [ ] CloudWatch のロググループ（`/aws/lambda-microvms/*` など）を消しました。
- [ ] Amazon Managed Grafana のワークスペースを消しました。
- [ ] Secrets Manager のダミーの秘密情報を消しました。
- [ ] IAM ロールと S3 バケットを消しました。
- [ ] タグ `project=kagero` で検索し、残り物がないことを確かめました。

タグでの検索の例です。MicroVMs の資源がこの API で見えるかは未確認なので、上の一覧も必ず確かめます。

```sh
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=project,Values=kagero \
  --region ap-northeast-1
```

## 結果の書式

各手順書の「結果」に、次の書式で追記します。

```markdown
### 結果（YYYY-MM-DD 実施）

- 判定: 合格 / 不合格 / 保留
- 環境: リージョン、各部品の版（kagero、収集器、ランタイム、AWS CLI）
- 数値: 合格条件に対応する値
- 分かったこと:
- ADR への反映: ADR-NNN をどう変えたか
- 後片付け: チェックリストをすべて確認しました（確認した日時）
```
