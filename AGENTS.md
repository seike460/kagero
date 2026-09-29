# AGENTS.md — kagero

このファイルは、kagero のリポジトリで作業する AI エージェントと人のための約束です。

## このリポジトリ

- kagero は、Grafana で AWS Lambda ファミリーを見るための OSS です。
- 0.x のプレビューを公開しています。公開した版と変更点は `CHANGELOG.md` にあります。配布物は、エージェントのイメージ `ghcr.io/seike460/kagero` だけです。`packages/*` は npm に公開していません。
- 実装は `crates/` と `packages/` にあり、CI と simulator の E2E で検証しています。AWS の実機での PoC はまだです（逸脱の記録は ADR-012）。
- 設計の正本は `docs/` にあります。作業の前に、`docs/design/architecture.md` と `docs/decisions.md` を読みます。

## いまの段階でしてよいこと・しないこと

- 「提案」の ADR を、PoC の結果なしに「採用」に変えません。
- AWS のリソースを作る作業（PoC）は、利用者の明示の許可を得てから行います。
- PoC では、[共通の安全策](docs/poc/README.md#共通の安全策) を必ず守ります。
- PoC の結果は、各手順書の「結果」に書き、ADR に反映します。

## 言語と道具

- MicroVM の中で動くエージェントだけを Rust で書きます。それ以外は TypeScript（Node.js 24）で書きます（ADR-001）。
- Rust: `cargo fmt`、`cargo clippy -D warnings`、`cargo test` を通します。
- TypeScript: strict、ES modules、Biome、vitest、pnpm を使います。
- 道具の版は mise で固定します。

## 設計の約束（崩さないこと）

- すべての機能で、LGTM と CloudWatch の両方での動きを決めます。出せない場合は「非対応」と明示します（ADR-002）。
- MicroVM・テナント・セッション・リクエストの ID を、メトリクスのラベルに入れません（ADR-008）。
- 費用はすべて「推定」と表示します。単価をエージェントに埋め込みません（ADR-009）。
- 秘密情報を、イメージの環境変数や `runHookPayload` に入れません（ADR-011）。
- MicroVM の中のアプリは、信頼できないコードとして扱います。
- 実行時にエージェントが失敗しても、利用者の処理を止めません（ADR-004）。
- 設計を変えるときは、ADR を追加します。古い ADR は消しません。

## 文書の書き方

- README.md は英語で書きます。README.ja.md はその日本語版で、内容をそろえます。
- 設計書と PoC 手順書は日本語で書きます。v0.1 の前に、主要な設計書を英訳します。
- 日本語は、アナウンサーの原稿のような平易な文にします。一文一義で、結論を先に書き、「です・ます」でそろえます。
- 技術用語は英語のままでかまいません。初めて出るときに、意味を一言添えます。
- 事実には日付と出典を付けます。確かめていないことは「未確認」と書き、確かめる PoC を示します。

## 検証

- 修正は end-to-end で確かめます。部品だけを確かめて「完了」としません。
- 文書を変えたら、相対リンクとアンカーが切れていないことを確かめます。
- PoC のあとは、後片付けのチェックリストで、AWS の残り物がないことを確かめます。

## Git

- Conventional Commits（feat / fix / chore / docs / refactor / test）を使います。メッセージは日本語でかまいません。
- 機能ごとにブランチを切ります。
- 秘密情報を commit しません。

## リリース

- 版はモノレポ全体で 1 つです（[版の付け方](docs/roadmap.md#版の付け方)）。版は `Cargo.toml` の `[workspace.package]`、`Cargo.lock` の `kagero-agent`、ルートと `packages/*` の `package.json`、`CHANGELOG.md` の見出しにあります。
- `vX.Y.Z` の tag を push すると、`.github/workflows/release.yml` が動きます。tag を打った commit で CI の全 job を流し、tag と版の一致を確かめます。すべて通ったときだけ、`ghcr.io/seike460/kagero` に `X.Y.Z`・`X.Y`・`latest` を push します。
- GitHub Release は、手で作ります。

手順は次のとおりです。

1. 変更を PR で main に入れ、CI が通ったことを確かめます。
2. 版を上げる PR を作ります。
   - `Cargo.toml` の `version` と、9 個の `package.json` の `version` を `X.Y.Z` にします。
   - `cargo check --workspace` で、`Cargo.lock` の `kagero-agent` の版を更新します。CI とイメージのビルドは `--locked` なので、更新を忘れると失敗します。
   - `CHANGELOG.md` の `## [Unreleased]` を `## [X.Y.Z] — YYYY-MM-DD` に変え、その上に空の `## [Unreleased]` を足します。末尾のリンク定義も直します。`releases/tag/vX.Y.Z` を指す `[X.Y.Z]` の行を足し、`[Unreleased]` の行は `compare/vX.Y.Z...HEAD` に変えます。
   - README.md と README.ja.md の状態の記述を、公開する版に合わせます。
3. その PR を main に入れ、CI が通ったことを確かめます。
4. main のその commit に、注釈付きの tag を打って push します。

   ```sh
   git tag -a vX.Y.Z -m vX.Y.Z
   git push origin vX.Y.Z
   ```

5. `release.yml` が成功したら、公開したイメージを確かめます。`docker buildx imagetools inspect ghcr.io/seike460/kagero:X.Y.Z` で `linux/arm64` のイメージがあることを見ます。`X.Y` と `latest` が同じ digest を指すことも確かめます。
6. GitHub Release を作ります。本文は `CHANGELOG.md` の `[X.Y.Z]` の節です。

   ```sh
   gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes-file <節を書き出したファイル>
   ```

- `release.yml` がイメージの push より前に失敗したときは、何も公開されていません。tag を消して、直した commit に同じ版の tag を打ち直します。
- イメージを push した後は、その版の tag を打ち直しません。直した内容は、次の版で出します。

## 書いてはいけない情報

- AWS アカウント ID、エンドポイントの URL、トークン、認証情報
- 顧客や勤務先の、公開されていない情報。社内プロジェクトの固有情報も含みます。教訓は一般化して書きます。
