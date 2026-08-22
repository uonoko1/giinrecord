import type { CSSProperties } from "react";

/** 判。賛成／反対は善悪ではなく「対」として色分けする（tokens の yes/no/none/act）。 */
export type StampValue = "賛成" | "反対" | "投票なし" | "発言" | "提出";

const tone: Record<StampValue, "yes" | "no" | "none" | "act"> = {
  賛成: "yes",
  反対: "no",
  投票なし: "none",
  発言: "act",
  提出: "act",
};

export function Stamp({ value }: { value: StampValue }) {
  const t = tone[value];
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 48,
    height: 26,
    padding: "0 8px",
    boxSizing: "border-box",
    borderRadius: 2,
    border: `1px solid var(--${t}-line)`,
    background: `var(--${t}-bg)`,
    color: `var(--${t}-fg)`,
    fontFamily: "var(--font-head)",
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: "0.08em",
    lineHeight: 1,
    whiteSpace: "nowrap",
  };
  return (
    <span role="img" aria-label={value} data-value={value} style={style}>
      {value}
    </span>
  );
}
