# rules2hooks

[English](README.md)

Claude が Read ツールを使わず Bash や python でファイルを読み書きするようになり、`.claude/rules` が守られなくなったときのための Claude Code のスキルです。ルールをガイダンスファイルへ移し、どのツール経由でも、対象のファイルに触れたセッションにフックがそのファイルを読ませます。

## 何が起きているか

`paths: src/**/*.tsx` を付けた `.claude/rules/frontend.md` を書くと、しばらくは守られます。やがて出力がそのルールを無視し始めます。ファイルは残っていて frontmatter も正しく、エラーも出ません。

Claude Code は、`paths:` を持つルールを、Read ツールが該当ファイルを開いたときに読み込みます（[ドキュメント](https://code.claude.com/docs/en/memory)）。いまのモデルは Read を使わず、シェル経由で作業することがよくあります。

```
> UserCard にローディング状態を足して

● Bash(sed -n 1,80p src/components/UserCard.tsx)
● Bash(python3 - <<'EOF'
       p = Path("src/components/UserCard.tsx")
       p.write_text(p.read_text().replace(...))
       EOF)
● 完了しました。読み込み中は UserCard にスケルトンを表示します。
```

Read の呼び出しがないので、このセッションの文脈に `frontend.md` は一度も入っていません。Bash 経由の作業が増えるほどルールが届くセッションは減り、外からはモデルが指示を無視しているように見えます。

`paths:` を持たないルールは逆で、起動のたびに全文が読み込まれます。コミットメッセージの書き方のルールは一度もコミットしないセッションでも文脈を占め、かといって `paths:` を付ければ上の問題に当たります。

## フックでプロンプトに足す

フックはフォーマッタを走らせたり、コマンドを止めたりする用途でよく使われます。モデルが読む文脈に文章を足すこともできます。`PreToolUse`、`PostToolUse`、`UserPromptSubmit` のフックが次の JSON を出力すると、Claude Code はその呼び出しと一緒に `additionalContext` の文字列をモデルの文脈に入れます（[ドキュメント](https://code.claude.com/docs/en/hooks)）。

```json
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "Read .claude/hooks/guidance/frontend.md before continuing."}}
```

フックは、モデルがどのツールを選んだかに関係なく、matcher に合う呼び出しのたびに走り、呼び出しの引数を受け取ります。Read や Edit ならファイルパス、Bash ならコマンド全体です。上のセッションなら、フックは `sed -n 1,80p src/components/UserCard.tsx` を見て `src/**/*.tsx` にあたるパスを見つけ、モデルにルールを読むよう伝えます。ルールが読み込まれるかどうかが、モデルが Read を選ぶかどうかに左右されなくなります。

考え方だけなら数行のシェルで書けます。

```sh
#!/bin/sh
# PreToolUse: point at frontend.md whenever a call mentions a .tsx file
if jq -r '.tool_input | .file_path // .command // ""' | grep -q '\.tsx'; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Read .claude/hooks/guidance/frontend.md before continuing."}}'
fi
```

この版は `.tsx` に触れる呼び出しのたびに同じ 1 行を出し、ルールも 1 本しか知りません。このスキルが入れるスクリプトは、各ルールの frontmatter からきっかけを読み、ルールごとにセッション（と subagent）で 1 回だけ案内し、Bash の後に git が変更ありと挙げたファイルも見て、パスだけでなくコマンドやプロンプトもきっかけにできます。

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

## もっと簡単な方法ではだめか

**CLAUDE.md や AGENTS.md に書く。** これらは起動のたびに全文が読み込まれるので、Bash を使うセッションにも届きます。代わりに、すべてのルールがすべてのセッションに載ります。マイグレーションを直すセッションに React の規約が、一度もコミットしないセッションにコミットの書き方が載ります。そこに置くのは、どのターンでも守るべきこと（たいてい数文）に留めるのが合います。スキルの手順 3 は、そうした原則をそちらへ移し、残りをフックに回します。

**ルールごとにスキルにする。** スキルは、モデルが説明文を作業に合うと判断したときに読み込まれます。規約が効くかどうかがモデルの判断に左右されます。ルールは、ファイルに触れたことをきっかけに効いてほしいものです。スキルが多いと Claude Code は一覧を予算に収めるために説明文を削り、削られた説明文は照合されません（[ドキュメント](https://code.claude.com/docs/en/skills)）。スキルはユーザーが頼む手順（「デプロイして」「マイグレーションを書いて」）に、フックで届けるガイダンスは特定のファイルへの編集すべてにかかる制約に向いています。

**常に Read を使えと指示する。** それもモデルが従わないことのある指示の 1 つで、このスキルはまさにその種の取りこぼしのためにあります。フックはモデルがどのツールを選んでも走ります。

**PreToolUse フックで Bash による編集を止める。** 動きますが、そのたびに呼び出しが拒否されてやり直しになり、モデルが得意な python による複数ファイルの編集も使えなくなります。このスキルは文脈を足すだけで、呼び出しには手を出しません。

**フックからルールの本文を入れる。** 10,000 文字を超える `additionalContext` はファイルに保存され、モデルにはプレビューしか見えません。同じファイルにかかるルールが数本あれば簡単に超えます。ファイル名を渡す方式なら、ルールごとにセッションで 1 回の Read で全文が届きます。

**リンターを使う。** リンター、フォーマッタ、型検査で確かめられるルールはそちらで確かめるべきで、スキルの手順 3 はツールがすでに強制しているルールを削ります。ガイダンスファイルは、ツールでは確かめられない判断のためのものです。

**そのうち Claude Code が直すのでは。** Bash でのアクセスでも `paths` 付きのルールが読み込まれるようになったら、ファイルごとの `git mv` と `.claude/settings.json` の 3 項目の削除で戻せます。`paths` の書き方は同じです。

**モデルは案内に従うのか。** 指示なので保証はありません。この README を書くために行った通しの試験では、モデルは案内の直後にガイダンスファイルを `cat` で読み、規約を守りました。根拠はいまのところその 1 回だけです。`measure.mjs` で、いまのルールが自分のプロジェクトでどれだけ届いていないかを数え、移行する価値があるかを判断できます。

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
