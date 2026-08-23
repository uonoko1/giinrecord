import { useState } from "react";
import { useInstallPrompt } from "../lib/install-prompt";
import "../styles/pages.css";

export const INSTALL_LABEL = "ホーム画面に追加";
/** iOS Safari 向けの手順（1行）。beforeinstallprompt が無いので案内だけ出す。 */
export const IOS_HINT = "Safari の「共有」から「ホーム画面に追加」を選ぶと追加できます。";

/**
 * 「ホーム画面に追加」の控えめなテキストリンク（Issue 191）。
 * 描画はマウント後の判定に従う：非対応ブラウザ／インストール済みでは何も出さない（プリレンダー HTML に DOM を出さない）。
 * ボタンなのは prompt() を呼ぶだけで遷移先が無いため。見た目はリンクと揃える（tokens のみ）。
 */
export function InstallLink() {
  const { state, install } = useInstallPrompt();
  const [hint, setHint] = useState(false);

  if (state.kind === "none") return null;

  const onClick = () => {
    if (state.kind === "ios") setHint(true);
    else void install();
  };

  return (
    <span className="install-link">
      <button type="button" className="install-link__button" onClick={onClick}>
        {INSTALL_LABEL}
      </button>
      {hint && (
        <span role="status" className="install-link__hint">
          {IOS_HINT}
        </span>
      )}
    </span>
  );
}
