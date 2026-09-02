import { useEffect, useRef, useState } from "react";

/**
 * 折りたたみの「さらに表示」（Issue 393）。ボタンと、押した後のフォーカスの移り先を**一緒に**持つ。
 *
 * ボタンは押すと消える（残りが 0 件になるので押す理由が無い）。そのままだと**フォーカスが
 * `<body>` に落ちる**ので、キーボードやスクリーンリーダーの利用者は文書の先頭へ戻される。
 * 本番で実測した（`/members/`）:
 *
 *     押す前: activeElement = BUTTON.members-more-button
 *     押した後: activeElement = BODY、rows 229 → 997、ボタンは DOM から消えている
 *
 * **押した人ほど不利になる**——展開するほど、戻された先から続きまでが遠くなる。
 *
 * ボタンの跡地に「続きを表示しました」を残し、そこへフォーカスを移す。
 * ここは**続きの手前**なので、そのまま読み進められる。
 * 移り先は `tabIndex={-1}`（クリックでは拾わず `.focus()` でだけ受け取る）。
 *
 * ボタンと移り先を1つの部品にしているのは、**呼び出し側がフォーカスを書き忘れられないようにする**ため。
 * 直す前は3箇所すべてで書き忘れていた（`grep -rn '\.focus()'` で該当ゼロ）。
 */
export function MoreButton({
  hidden,
  unit,
  onExpand,
  className,
  controls,
}: {
  /** 残り件数。0 以下なら、まだ押されていなければ何も描かない */
  hidden: number;
  /** 「残り12件」の「件」。議員一覧は「名」 */
  unit: string;
  onExpand: () => void;
  /** 既存の見た目を保つための接頭辞（members / rollcalls / member） */
  className: string;
  /** 展開される領域の id（aria-controls） */
  controls?: string;
}) {
  const doneRef = useRef<HTMLParagraphElement>(null);
  const [pressed, setPressed] = useState(false);

  // 押したときだけ移す。**依存配列が [pressed] であること**が「押していない再描画で
  // 勝手にフォーカスを奪わない」を担保している（配列を外すと利用者が移したフォーカスを
  // 毎回引き戻してしまう。テストで固定してある）。
  useEffect(() => {
    if (pressed) doneRef.current?.focus();
  }, [pressed]);

  if (hidden <= 0) {
    if (!pressed) return null;
    return (
      <p className={`${className}-more ${className}-more-done`} ref={doneRef} tabIndex={-1} role="status">
        続きを表示しました。
      </p>
    );
  }

  return (
    <p className={`${className}-more`}>
      <button
        type="button"
        className={`${className}-more-button`}
        aria-controls={controls}
        onClick={() => {
          setPressed(true);
          onExpand();
        }}
      >
        さらに表示（残り{hidden.toLocaleString("ja-JP")}
        {unit}）
      </button>
    </p>
  );
}
