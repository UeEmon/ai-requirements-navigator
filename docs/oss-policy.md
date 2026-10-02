# OSS利用方針

本システムは、**再配布できる、または著作権表示をすれば利用できる** ライセンスのOSSだけを使います。
コンテナイメージとして配布・運用するため、利用者や組織がライセンス上の義務（ソース公開など）を負わないことを目的とします。

## 許可するライセンス

| ライセンス | 主な義務 | 例 |
| --- | --- | --- |
| MIT / ISC / 0BSD / MIT-0 | 著作権表示 | Hono, zod, pg, jose, Mermaid, Ollama |
| BSD-2-Clause / BSD-3-Clause | 著作権表示 | ― |
| Apache-2.0 | 著作権表示・NOTICE・変更点の明示 | AWS SDK, AWS CDK, Keycloak, TypeScript, pdfjs-dist（PDFの文字の取り出し） |
| PostgreSQL License | 著作権表示 | PostgreSQL |
| MPL-2.0 | 変更したファイルのみソース公開（ファイル単位） | DOMPurify（Apache-2.0とのデュアル） |
| BlueOak-1.0.0 / CC0-1.0 / Unlicense / Zlib / Python-2.0 | 表示のみ、または義務なし | ― |
| SIL Open Font License 1.1（フォント） | フォント単体での販売禁止・名称変更時の規定 | Noto Sans CJK（PDFの日本語表示） |

開発時だけ使うツール（配布物に入らないもの）に限り、CC-BY-4.0 などのデータライセンスも許可します。

## 使わないライセンス

| ライセンス | 理由 | 代わりに使うもの |
| --- | --- | --- |
| GPL / LGPL | 結合した配布物にソース公開義務が及ぶ | Pandoc（GPL）→ docx・pdfmake（MIT）で Word / PDF を生成 |
| AGPL | ネットワーク越しの提供でもソース公開義務 | MinIO → S3 / ローカルボリューム |
| SSPL / RSAL / BUSL | 利用条件に制限がある | Redis 7.4以降 → PostgreSQL上のジョブ表（ADR 0004） |
| 商用・独自ライセンス | 再配布不可 | ― |

PlantUML は GPL 版のサーバーを使わず、PlantUML 形式の **テキストを出力するだけ** にしています（描画は利用者側のツールで行う）。

## 仕組み

1. `npm run licenses` が `node_modules` を走査し、本番依存のライセンスを許可リストと照合します（外部パッケージ不要の自作スクリプト）。
2. CI では本番依存と開発用ツールの両方を検査し、許可リスト外があれば失敗します。
3. Dockerイメージのビルド時に、利用OSSの一覧とライセンス本文を `THIRD_PARTY_NOTICES.txt` として生成し、画面から `/THIRD_PARTY_NOTICES.txt` で参照できるようにしています。

## 新しいパッケージを追加するとき

1. パッケージと、その依存のライセンスを確認する（`npm run licenses`）。
2. 許可リスト外なら、同等の機能を持つ許可ライセンスのパッケージを探す。
3. どうしても必要な場合は、`docs/adr/` に判断理由を記録し、`scripts/check-licenses.mjs` の許可リストを変更するプルリクエストでレビューを受ける。

## コンテナイメージについて

ベースイメージ（`node:22-alpine`、`postgres:16-alpine`、`ollama/ollama`、`quay.io/keycloak/keycloak`）に含まれるOSのパッケージには、GPLのものも含まれます。
これらは独立したプログラムとして同梱されるもので、本システムのコードとは結合しません。イメージを社外へ再配布する場合は、各ベースイメージの配布元が公開しているソースの入手方法を案内してください。
