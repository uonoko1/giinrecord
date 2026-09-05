**main の保護設定を読めなかった。** 設定が弱いかどうかは**判定できていない**（#540）。

```
fail branch-protection: main の保護設定を読めなかった（設定が弱いかどうかは判定できていない）
  理由はこの run のログ（stderr）に出ている。Issue 本文には出さない: 認証情報が混ざりうる
  権限が足りない場合の直し方: docs/ops/deploy.md「main の保護設定」
```

- run: https://github.com/uonoko1/giinrecord/actions/runs/1

**理由は run のログ（stderr）にある。** 認証情報が混ざりうるのでここには転記しない。
よくある原因は権限で、branch protection の読み取りには `administration: read` が要る。
それでも読めない場合は PAT が要る（**人間の作業**）。手順は `docs/ops/deploy.md`「main の保護設定」。
読めるようになれば、この Issue は自動で閉じる。
