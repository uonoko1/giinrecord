import { useEffect, useState } from "react";

export const THEME_STORAGE_KEY = "seiji-kiroku:theme";

/** "system" = OS 追従（data-theme を付けない） */
export type Theme = "system" | "light" | "dark";

const OPTIONS: { value: Theme; label: string }[] = [
  { value: "system", label: "OS に合わせる" },
  { value: "light", label: "昼" },
  { value: "dark", label: "夜" },
];

function readStored(): Theme {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  try {
    if (theme === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* storage unavailable (private mode etc.) — the attribute still applies for this page */
  }
}

export function ThemeToggle() {
  // SSR/プリレンダー時は常に system。マウント後に保存値を読む。
  const [theme, setTheme] = useState<Theme>("system");
  // プリレンダー HTML に <input> を出さない（Issue 365）。JS が無い環境では
  // ラジオを押しても何も起きないので、**動かない操作子を置かない**。
  // InstallLink（Issue 191）と同じく、マウント後にだけ描画する。
  // home.test.tsx の「プリレンダーの HTML に <input> を含まない」がこれを検査している。
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const stored = readStored();
    if (stored !== "system") {
      setTheme(stored);
      applyTheme(stored);
    }
  }, []);

  if (!mounted) return null;

  const choose = (t: Theme) => {
    setTheme(t);
    applyTheme(t);
  };

  return (
    <fieldset style={{ display: "inline-flex", gap: 4, margin: 0, padding: 2, border: "1px solid var(--rule)", borderRadius: 4 }}>
      <legend style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>表示テーマ</legend>
      {OPTIONS.map((o) => {
        const checked = o.value === theme;
        return (
          <label
            key={o.value}
            style={{
              // Issue 413（WCAG 2.5.8）: 押せる範囲を 24px 以上に。12px の文字（行の高さ ≒14.4px）+ 上下 5px
              padding: "5px 10px",
              borderRadius: 3,
              fontSize: 12,
              cursor: "pointer",
              background: checked ? "var(--ink)" : "transparent",
              color: checked ? "var(--paper)" : "var(--muted)",
            }}
          >
            <input
              type="radio"
              name="theme"
              value={o.value}
              checked={checked}
              onChange={() => choose(o.value)}
              style={{ position: "absolute", opacity: 0, width: 1, height: 1 }}
            />
            {o.label}
          </label>
        );
      })}
    </fieldset>
  );
}
