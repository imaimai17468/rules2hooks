# rules2hooks

[English](README.md)

`.claude/rules/*.md` を、フックが読みに行かせるガイダンスファイルへ移す Claude Code のスキルです。Read ツールでファイルを開いたセッションだけでなく、Bash 経由で該当ファイルを編集するセッションにも規約が届くようになります。

## 何が起きているか

Claude Code は、frontmatter に `paths:` を持つルールを、Read ツールが該当ファイルを開いたときに読み込みます（[ドキュメント](https://code.claude.com/docs/en/memory)）。`sed -n 1,80p src/app/page.tsx`、`cat`、3 ファイルを書き換える python のヒアドキュメント、コード生成スクリプトのようにシェル経由で作業するセッションでは、ルールは読み込まれません。

`paths:` を持たないルールは逆で、起動のたびに全文が読み込まれます。コミットメッセージの書き方のルールは、一度もコミットしないセッションでも文脈を占めます。

## 何が変わるか

```
移行前                                  移行後
.claude/rules/frontend.md  (paths)      .claude/hooks/guidance/frontend.md  paths: src/**/*.tsx
.claude/rules/writing.md   (常時)       .claude/hooks/guidance/writing.md   paths: "**/*.md"
                                                                            commands: git commit, gh pr create
.claude/rules/replies.md   (常時)       .claude/hooks/guidance/replies.md   events: UserPromptSubmit
                                        .claude/hooks/scoped-guidance.mjs
```

起動時にガイダンスファイルを読み込む経路はありません。フックは Read、Edit、Write、Bash の呼び出しごとと、プロンプトごとに各ファイルの frontmatter を読みます。セッションがファイルの名指す対象に初めて触れたとき、モデルに次の 1 行を渡します。

```
.claude/hooks/guidance/frontend.md applies because this session reached src/app/page.tsx. Read .claude/hooks/guidance/frontend.md completely before continuing. This hook names it once per session.
```

| キー | 届く条件 |
|---|---|
| `paths` | ツール呼び出しが該当ファイルを名指したとき、Bash のコマンドに該当パスが含まれるとき、Bash の後に git が該当ファイルを変更ありと挙げたとき |
| `commands` | Bash がそのフレーズ（`git commit`、`gh pr create`）をコマンドとして実行したとき |
| `events` | `UserPromptSubmit`、`PreToolUse`、`PostToolUse` が発火したとき |

本文を貼らずにファイル名を渡すのは、10,000 文字を超える `additionalContext` はファイルに保存され、モデルにはプレビューしか見えないためです。同じファイルにかかるルールが数本あれば、合わせてこの上限を超えます。Read ならファイルを丸ごと返します。

## インストール

Claude Code のプラグインとして入れる場合:

```
/plugin marketplace add imaimai17468/rules2hooks
/plugin install rules2hooks@rules2hooks
```

[skills CLI](https://github.com/vercel-labs/skills) で入れる場合:

```sh
npx skills add imaimai17468/rules2hooks
```

`skills/rules2hooks/` を `~/.claude/skills/` かプロジェクトの `.claude/skills/` にコピーしても動きます。

## 使い方

移行したいプロジェクトで、次のように頼みます。

```
> .claude/rules をフックに移行して
```

スキルは 8 つの手順を順に進めます。ルールの棚卸し、各ルールが過去のセッションにどれだけ届いていなかったかの計測、ファイルごとのきっかけの決定、`git mv`、既存のフックを残したまま `.claude/settings.json` へフックを追加、`.claude/rules` を参照している箇所の付け替え、検証、報告です。詳細は [SKILL.md](skills/rules2hooks/SKILL.md) にあります。

計測だけを先に走らせることもできます。プロジェクトのルートで:

```sh
node <スキルのパス>/scripts/measure.mjs
```

`~/.claude/projects/` にあるそのプロジェクトのトランスクリプトを読み、`paths` を持つルールごとに、該当ファイルに触れたセッション数と、そのうち Read で一度も開かなかったセッション数を 1 行で出します。

## 動作条件と限界

- Node 20 以降と git が必要です。フックは `node:` の組み込みモジュールだけを使い、プロジェクトにコピーされるので、このスキルを消してもプロジェクトは動きます。
- フックの対象になるツール呼び出しのたびに Node が起動します。計測したマシンでは 1 回あたり約 67 ms でした。すべてのファイルを案内し終えたセッションでは、以後どのファイルも読まずに抜けます。
- フックは文脈を足すだけで、呼び出しを止めません。`git commit` で届くルールは、最初のコミットがすでに走っているときに届きます。そのため、コミットメッセージや PR 本文を書くワークフローに「書く前にガイダンスを読む」手順を足すところまでをスキルが行います。
- Bash のコマンドからのパス検出はパターン照合です。grep のパターンに書いたパスも触れたものとして数え、不要な案内が 1 行出ることがあります。
- フックが動くのは Claude Code だけです。Cursor や Codex などのエージェントには案内が届かないので、必要なガイダンスファイルを自分で開く必要があります。

詳しくは [references/pitfalls.md](skills/rules2hooks/references/pitfalls.md) にあります。

## 開発

```sh
node --test test/*.test.mjs
```

## ライセンス

MIT
