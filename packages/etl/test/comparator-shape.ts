import ts from "typescript";

/**
 * **並べ替えの比較関数が「許容差つき」になっていないかを、構文木で見る道具**（Issue #1008）。
 *
 * ## なぜ正規表現をやめたか
 *
 * **#1000 が置いた検査は `/\.sort\(\s*\([^)]*\)\s*=>[^;]*?\?\s*0\s*:/` だった**——
 * **「三項で、リテラル `0` を返す」という 1 つの綴りだけを禁じる denylist** である。
 * **#1008 で 10 通りの綴りを、宮城の議員氏名の組み立て（`const nameText = joinVertical(chars);`）に
 * 実際に当てて、`pdf-row-order.test.ts` の 19 件が赤くなるかを測った**
 * （**当てるのは `scripts/dev/mutate.sh`。md5 で「当たったこと」を確かめている**）:
 *
 * | 変異（どれも宮城の氏名が 13 本で変わる） | 旧 denylist |
 * |---|---|
 * | `if (Math.abs(a.y-b.y) <= t) return a.x-b.x; return b.y-a.y;` | **素通り** |
 * | `Math.abs(a.y-b.y) <= t ? a.x-b.x : b.y-a.y`（`0` を書かない三項） | **素通り** |
 * | `Math.round(b.y/t) - Math.round(a.y/t) \|\| a.x-b.x` | **素通り** |
 * | `toSorted((a,b) => … ? 0 : …)` | **素通り** |
 * | 比較関数を定数に切り出す（`sort(CMP)`） | **素通り** |
 * | 分割代入 `({y: ay}, {y: by}) => …` | **素通り** |
 * | 添字 `a["y"]` | **素通り** |
 * | `?? ` で繋ぐ | **素通り** |
 * | 手書きの挿入ソート（`sort` を経由しない） | **素通り** |
 * | `Math.abs(a.y-b.y) <= t ? 0 : …`（**唯一これだけ**） | 捕まえる |
 *
 * **denylist は原理的に列挙漏れを塞げない**（#1022 で y 座標の denylist が
 * 分割代入で回避できることが実測された。**同じ型の穴**）。**だから allowlist にする。**
 *
 * ## 何を許すか（allowlist。**これ以外は全部落とす**）
 *
 * **全順序の比較関数は「差の `||` 連鎖」で書ける**——
 * **`A - B`**、**`A || B`**、**`(A)`、そして「0 にならない三項」**（`x < y ? 1 : -1` の形）。
 * **この文法から外れた比較関数は、名前も綴りも見ずに落とす。**
 *
 * **許容差は、この文法では書けない**——
 * **「近ければ同値」には必ず「比較の結果で分岐して、片方で順序を変える」が要る**ので、
 * **`?:`（リテラルでない枝）か `if` か `??` か `Math.round` の商**のどれかが現れる。
 * **`Math.round(b.y / t) - Math.round(a.y / t)` は `-` なので文法には合う**——
 * **だから `-` の両辺に「丸めの呼び出し」があるかも別に見る**（下の `roundish`）。
 *
 * ## 捕まえられない形（**塞げないと分かっていて残す**）
 *
 * - **`sort` / `toSorted` を経由しない自前の並べ替え**（挿入ソート・`reduce` など）。
 *   **共有層はこれを振る舞いの検査（`joinVertical`）が押さえるが、県ごとの写しは押さえない。**
 * - **比較関数を別ファイルに置いて import する形**（この道具は 1 ファイルずつ見る）。
 *   **ただし `sort(CMP)` のように「識別子を渡す」形は、同じファイルの中に定義があれば追う。
 *   追えなければ `unresolved` として落とす**（＝黙って通らない）。
 * - **県のディレクトリの外**（`pdf-table.ts` などの共有層）。**そちらは別の 2 つの検査が見る。**
 *
 * ## 倒れる向き（#569）——**「別人の記録が出る」側である**
 *
 * **ここが破られたとき起きるのは「記録が出ない」ではなく「別人の記録が出る」**である。
 * **`joinVertical` と県ごとの `cellText` は議員の氏名（`nameText`）を組み立てる**ので、
 * **比較が非推移的になると V8 の `sort` が要素数でアルゴリズムを変え、氏名が黙って別の順に組まれる。**
 * **落ちるのではなく、読めたまま中身が入れ替わる**ので、**利用者からは検出できない。**
 *
 * ## **ただし「今のデータで実害に届く」ことは確かめられていない**（#1008 の正直な限界）
 *
 * **11 県 127 本（`parseVotePdf` が通ったのは 110 本）で `joinVertical` の呼び出し 11,592 回を全部見て、
 * 「y の差が 3pt 以内で、かつ x では逆順」の対を数えたところ 0 組だった**
 * （**内訳: 秋田 543 / 青森 616 / 高知 795 / 三重 2,229 / 宮城 2,035 / 奈良 373 /
 * 佐賀 2,891 / 滋賀 984 / 島根 318 / 徳島 808 / 鳥取 0（未使用）**）。
 * **つまり今のフィクスチャでは、許容差 3pt までを入れても順序は変わらない＝等価変異になる。**
 * **上の 10 通りの変異で宮城の `nameText` が変わったのは、`joinVertical` の
 * 空白の挿入（`gap > step * 1.5`）を一緒に落としたためで、並べ替えの順序が変わったからではない**
 * （**空白の挿入を残して並べ替えだけ替えた変異を別に当てて、13 本すべてで出力が同じことを確かめた**）。
 *
 * **だからここが守っているのは「今のデータ」ではなく「これから来るデータと、これから書かれる県」である。**
 * **守られているのではなく、たまたまデータが揃っているだけ**——**#1008 が測って分かったのはそこである。**
 */

/** 見つかった比較関数 1 つぶん。 */
export type Comparator = {
  /** `sort` か `toSorted` か */
  readonly method: string;
  /** 1 始まりの行番号 */
  readonly line: number;
  /** 比較関数の原文（空白を潰したもの） */
  readonly text: string;
  /** allowlist から外れた理由。合格なら `null` */
  readonly reason: string | null;
};

/** `Math.round` / `Math.floor` などの「丸め」の呼び出しか（行に丸める＝許容差そのもの）。 */
const ROUNDING = new Set(["round", "floor", "ceil", "trunc"]);

function isRoundingCall(n: ts.Node): boolean {
  if (!ts.isCallExpression(n)) return false;
  const e = n.expression;
  if (ts.isPropertyAccessExpression(e) && ROUNDING.has(e.name.text)) return true;
  if (ts.isIdentifier(e) && ROUNDING.has(e.text)) return true;
  return false;
}

/** 部分木のどこかに丸めの呼び出しがあるか（`Math.round(b.y / t) - …` を拾う）。 */
function hasRounding(n: ts.Node): boolean {
  if (isRoundingCall(n)) return true;
  let found = false;
  ts.forEachChild(n, (c) => { if (!found && hasRounding(c)) found = true; });
  return found;
}

/** 0 にならない三項か（`a < b ? 1 : -1`。佐賀の文字列の同点崩しがこの形）。 */
function isNonZeroTernary(n: ts.Expression): boolean {
  if (!ts.isConditionalExpression(n)) return false;
  const lit = (e: ts.Expression): boolean => {
    const t = ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken ? e.operand : e;
    return ts.isNumericLiteral(t) && Number(t.text) !== 0;
  };
  return lit(n.whenTrue) && lit(n.whenFalse);
}

/**
 * 比較の**式**が allowlist の文法に合うか。合わなければ理由を返す。
 * 文法: `E := E - E | E || E | (E) | 非ゼロ三項 | 丸めを含まない任意の算術`
 */
function checkExpr(n: ts.Expression): string | null {
  if (ts.isParenthesizedExpression(n)) return checkExpr(n.expression);
  if (ts.isBinaryExpression(n)) {
    const op = n.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken) return checkExpr(n.left) ?? checkExpr(n.right);
    if (op === ts.SyntaxKind.MinusToken) {
      // `Math.round(b.y / t) - Math.round(a.y / t)` は文法には合うが、行への丸め＝許容差
      if (hasRounding(n)) return "差の中に丸め（Math.round など）がある＝行に丸めている";
      return null;
    }
    if (op === ts.SyntaxKind.QuestionQuestionToken) return "`??` で繋いでいる（左が 0 でも右に落ちないので全順序にならない）";
    return `許していない演算子 ${ts.tokenToString(n.operatorToken.kind) ?? op}`;
  }
  if (ts.isConditionalExpression(n)) {
    return isNonZeroTernary(n) ? null : "三項で、枝が非ゼロのリテラルではない（近ければ同値、を書ける形）";
  }
  return "差（`-`）でも `||` の連鎖でもない式";
}

/** 比較関数の**本体**が allowlist の文法に合うか。 */
function checkBody(fn: ts.ArrowFunction | ts.FunctionExpression): string | null {
  const body = fn.body;
  if (!ts.isBlock(body)) return checkExpr(body);
  // ブロック本体は `return <式>;` 1 つだけを許す（`if` で早期 return する形を落とす）
  const stmts = body.statements.filter((s) => !ts.isEmptyStatement(s));
  if (stmts.length !== 1) return `本体が文 ${stmts.length} 個（許すのは \`return <式>;\` 1 つだけ。if で早期 return する形は許容差を書けるので落とす）`;
  const only = stmts[0];
  // **この行だけを `if (false)` にしても検査は赤くならない**（#1008 で実測。**等価変異**）——
  // **`if (…) return 0;` の `only.expression` は `if` の条件式になり、
  // 下の `checkExpr` が「差でも `||` でもない式」として落とすから**である。
  // **二重になっているだけで、無効な行ではない**（**`checkExpr` の既定を通す側に倒されたときの保険**）。
  if (!ts.isReturnStatement(only) || !only.expression) return "本体の唯一の文が `return <式>;` ではない";
  return checkExpr(only.expression);
}

/** 同じファイルの中で、識別子に束縛された比較関数を探す（`sort(CMP)` を追う）。 */
function resolveLocal(sf: ts.SourceFile, name: string): ts.ArrowFunction | ts.FunctionExpression | null {
  let out: ts.ArrowFunction | ts.FunctionExpression | null = null;
  const walk = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      const init = n.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) out = init;
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

/**
 * 1 ファイルの中の `sort` / `toSorted` の比較関数を全部返す。
 * **引数なしの `sort()`（文字列の既定順）は比較関数を持たないので、対象にしない。**
 */
export function comparatorsIn(fileName: string, code: string): Comparator[] {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.ESNext, true);
  const out: Comparator[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      if (method === "sort" || method === "toSorted") {
        const arg = n.arguments[0];
        if (arg) {
          const line = sf.getLineAndCharacterOfPosition(arg.getStart(sf)).line + 1;
          const text = arg.getText(sf).replace(/\s+/g, " ");
          let fn: ts.ArrowFunction | ts.FunctionExpression | null = null;
          if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) fn = arg;
          else if (ts.isIdentifier(arg)) fn = resolveLocal(sf, arg.text);
          const reason = fn
            ? checkBody(fn)
            : "比較関数が同じファイルの中で見つからない（unresolved。追えないものは通さない）";
          out.push({ method, line, text, reason });
        }
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}
