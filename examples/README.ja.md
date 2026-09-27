# kagero サンプル

アプリ側の契約（docs/design/microvms.md §10）を最小構成で示す 2 つの
MicroVM イメージです。本番の負荷には使いません。アプリが何を持ち、
何を持たないかを正確に見せるためのものです。

- `node/` — Node.js アプリ（`index.mjs`、依存なし）
- `python/` — Python アプリ（`main.py`、標準ライブラリのみ）
- `kagero.env.example` — 秘密でない環境変数の契約。
  `KageroMicrovmImage`（packages/cdk）とエージェントの `config.rs`
  の両方と一致させています

## アプリが受け入れる 3 つの契約

1. **OTLP の出口。** テレメトリは MicroVM 内の収集器
   `127.0.0.1:$KAGERO_OTLP_PORT`（既定 4318、HTTP）に送ります。
   バックエンドには直接送りません。収集器が識別属性を付けるので、
   アプリが `kagero.*` の識別値を自分で送ることはありません
   （送っても上書きされます）。
2. **フックの受け口は loopback のみ。**
   `127.0.0.1:$KAGERO_APP_HOOK_PORT`（既定 2019）で
   `POST /aws/lambda-microvms/runtime/v1/<hook>` を受けます。
   エージェントは**すべて**のフックを中継します — ビルド時の
   `ready`/`validate` と実行時の
   `run`/`resume`/`suspend`/`terminate` です。6 つ全部を受けるか、
   使わないものは 404 を返してください（未実装は安全です）。
   `suspend` と `terminate` はアプリが先に呼ばれます。テレメトリが
   実際にプロセスを出てから 200 を返してください。エージェントの
   送信はその後に動きます。
3. **識別は受け取るもので、自分で作らない。** `run` のフックには
   `runHookPayload` と一緒に ID が届きます。イメージの情報は
   環境変数に入ります。以後のフックは `{}` です。秘密情報は
   ペイロードにもイメージの環境変数にも入りません（ADR-011）。
   `KAGERO_SECRET_ARN` を設定すると、エージェントが `run` の時点で
   Secrets Manager から解決します。

## 資格情報について

同梱の LGTM Alloy テンプレートは basic 認証の組を必要とし、
**ないと fail closed になります**。Secrets Manager に
`{"username":"...","password":"..."}` の JSON を入れて
`KAGERO_SECRET_ARN` を設定してください。設定がないと収集器は
何も出力しません（`kagero.lifecycle.degraded` イベントだけが
出ます）。ローカルで認証なしに試すときは、
`otelcol.auth.basic` を持たないテンプレートに差し替えてください
（`collector/README.md` 参照）。

## ビルド

`COPY --from=ghcr.io/seike460/kagero:0.1` は公開済みイメージを
前提にします。v0.1 が出るまでは、エージェントをローカルで
ビルドして context にコピーしてください
（`cargo build --release && cp target/release/kagero kagero`）。
その行を `COPY kagero /usr/local/bin/kagero` に置き換えます
（`target/` は dockerignore されているため、バイナリは
context のルートに置きます）。

リポジトリのルートで実行します（収集器のテンプレートを context
に含めるため）。

```sh
docker build -f examples/node/Dockerfile -t kagero-example-node .
docker build -f examples/python/Dockerfile -t kagero-example-python .
```

収集器の Alloy は `grafana/alloy:v1.20.0` にピンしています。
`KAGERO_OTLP_ENDPOINT_LGTM`（または `_CLOUDWATCH`）は実際の
エンドポイントに変えてください。`https://otlp.invalid` は
分かりやすく失敗するプレースホルダーです。`localhost:4318` に
すると、テレメトリが収集器自身の受信口にループします。

## デプロイ

`AWS::Lambda::MicrovmImage` の code artifact は、Dockerfile と
ビルド context をまとめた zip です（イメージのビルドは Lambda
側で行われます）。`KageroMicrovmImage`（packages/cdk）を使うと、
同じ契約から `Hooks.Port`・フックの時間上限・`KAGERO_*` 環境変数を
まとめて出します。自分で環境変数を書く場合は
`kagero.env.example` を使ってください。

## AWS なしでの確認

`packages/sim` が実際のエージェントバイナリをモック収集器に対して
駆動します（`pnpm --filter @kagero/sim test`）。このサンプルが
前提にしているフックの順序と送り切りの契約を、end to end で
検証しています。
