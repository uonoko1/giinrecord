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
 * ## #1052 で塞いだ 7 通り（**#1034 のレビュアーが挙げた 8 通りを、1 つずつ再現して測った**）
 *
 * **8 通りすべてが実際に素通りした**（**実測 2026-09-27。`comparatorsIn` に直接当て、
 * `reason === null` か、そもそも 0 件しか返らないことを確かめた。
 * 「issue に書いてあるから」ではなく自分で再現している**）:
 *
 * | # | 綴り | #1034 | #1052 |
 * |---|---|---|---|
 * | B1 | `b.y - a.y > t ? 1 : -1` | **素通り（明示的に許していた）** | 落とす |
 * | B2 | `xs["sort"](cmp)` | **0 件（見つからない）** | 落とす |
 * | B3 | `Array.prototype.sort.call(xs, cmp)` | **0 件** | 落とす |
 * | B4 | 同名の安全な定義をファイルの後ろに置く | **素通り** | 落とす（ambiguous） |
 * | B5 | `(b.y / t) \| 0` / `~~(b.y / t)` | **素通り** | 落とす |
 * | B6 | `parseInt(String(b.y / t), 10)` | **素通り** | 落とす |
 * | B7 | `Number((b.y / t).toFixed(0))` | **素通り** | 落とす |
 * | B8 | 先行する `.map()` の中で丸める | **素通り** | **塞げない（下に残す）** |
 *
 * **いちばん悪かったのは B1 である**——**「見落とし」ではなく「間違って許可した」形。**
 * **`isNonZeroTernary` は「枝が非ゼロのリテラルか」だけを見ていたので、
 * 条件が `差 > 閾値` でも許していた。** **実測: `cmp(a,b)` も `cmp(b,a)` も `-1` を返し
 * （反対称でない）、同じ y の 4 要素 `ABCD` は `DCBA` に並べ替わる。**
 *
 * **なぜ「0 にならない三項」を許していたのか**（**塞ぐ前に調べた**）:
 * **佐賀の 3 か所（`saga/index.ts:83,207,208`。実測 grep）が
 * `a.sessionId < b.sessionId ? 1 : -1` を文字列の同点崩しに使っている。これは正当である**——
 * **条件の両辺が `a` / `b` を入れ替えた鏡なので、入れ替えれば必ず向きが反転する。**
 * **だから「三項を丸ごと禁じる」は既存の正しいコードを殺す。**
 * **代わりに「条件が鏡になっているか」を要求した**（`isAntisymmetricCondition`）。
 * **偽陽性の実測: `etl/src` の比較関数 143 個、リポジトリ全体で 582 個を
 * 旧実装と新実装の両方に通し、判定が変わったものは 0 件**である。
 *
 * ## 捕まえられない形（**塞げないと分かっていて残す**）
 *
 * - **`sort` / `toSorted` を経由しない自前の並べ替え**（挿入ソート・`reduce` など）。
 *   **共有層はこれを振る舞いの検査（`joinVertical`）が押さえるが、県ごとの写しは押さえない。**
 * - **B8: 比較関数の手前で `.map()` の中で丸める形**（**#1052 で唯一塞げなかった**）:
 *   ```js
 *   const rs = xs.map((i) => ({ ...i, y: Math.round(i.y / t) }));
 *   rs.sort((a, b) => b.y - a.y || a.x - b.x);   // ← 比較関数そのものは完全に正しい
 *   ```
 *   **塞ぐには「`sort` に渡っている配列がどこで作られたか」を追う必要があり、
 *   データフロー解析になる**（この道具の設計＝「1 つの比較関数を構文で見る」の外）。
 *   **県のファイルには `.map(` が 276 か所ある**（実測）ので、
 *   **「`.map` の中に丸めが在ったら落とす」にすると丸めと無関係な写しを大量に殺す。**
 * - **比較関数を別ファイルに置いて import する形**（この道具は 1 ファイルずつ見る）。
 *   **ただし `sort(CMP)` のように「識別子を渡す」形は、同じファイルの中に定義があれば追う。
 *   追えなければ `unresolved` として落とす**（＝黙って通らない）。
 *   **同名の宣言が 2 つ以上あれば `ambiguous` として落とす**（#1052。**スコープは見ていない**）。
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

/**
 * **「丸め」の呼び出しの名前**（行に丸める＝許容差そのもの）。
 *
 * **#1034 は `Math.*` の 4 つだけを見ていた**が、**#1052 で
 * `parseInt` / `toFixed` / `toPrecision` が同じことをできると実測した**ので足した
 * （**`parseInt(String(b.y / t), 10)` と `Number((b.y / t).toFixed(0))` は
 * どちらも `reason: null` で素通りしていた**）。
 */
const ROUNDING = new Set([
  "round", "floor", "ceil", "trunc",
  // **#1052 で足した分**（**`Math.` の名前だけを見ていたので当たらなかった**）
  "parseInt", "toFixed", "toPrecision",
]);

function isRoundingCall(n: ts.Node): boolean {
  if (!ts.isCallExpression(n)) return false;
  const e = n.expression;
  if (ts.isPropertyAccessExpression(e) && ROUNDING.has(e.name.text)) return true;
  if (ts.isIdentifier(e) && ROUNDING.has(e.text)) return true;
  return false;
}

/**
 * **ビット演算による整数への切り捨て**か（**#1052。`Math.*` ではないので名前では当たらない**）。
 *
 * **`(b.y / t) | 0` と `~~(b.y / t)` は `Math.trunc` と同じ**——
 * **どちらも「行に丸めてから差を取る」を書ける**（実測: #1034 はどちらも素通りした）。
 * **`>> 0` / `>>> 0` / `& -1` / `^ 0` も同じ効果なので一緒に落とす。**
 *
 * **偽陽性の心配**: **県のファイルの比較関数 103 個に、ビット演算を使っているものは 1 つも無い**
 * （実測。`pnpm test` が緑であることで固定している）。
 */
function isBitwiseTruncation(n: ts.Node): boolean {
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.TildeToken) return true;
  if (!ts.isBinaryExpression(n)) return false;
  switch (n.operatorToken.kind) {
    case ts.SyntaxKind.BarToken:
    case ts.SyntaxKind.AmpersandToken:
    case ts.SyntaxKind.CaretToken:
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
    case ts.SyntaxKind.LessThanLessThanToken:
      return true;
    default:
      return false;
  }
}

/**
 * 部分木のどこかに丸めがあるか（`Math.round(b.y / t) - …` を拾う）。
 * **#1052 で「ビット演算による切り捨て」も丸めとして拾うようにした。**
 */
function hasRounding(n: ts.Node): boolean {
  if (isRoundingCall(n) || isBitwiseTruncation(n)) return true;
  let found = false;
  ts.forEachChild(n, (c) => { if (!found && hasRounding(c)) found = true; });
  return found;
}

/** 比較関数の 2 つの引数に束縛された識別子の名前（分割代入も展開する）。 */
type Params = { readonly left: ReadonlySet<string>; readonly right: ReadonlySet<string> };

/** 1 つの引数に束縛される識別子を全部集める（`a` / `{ y: ay, x: ax }` / `[k]` のどれでも）。 */
function bindingNames(p: ts.ParameterDeclaration | undefined): Set<string> {
  const out = new Set<string>();
  if (!p) return out;
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) { out.add(n.text); return; }
    if (ts.isBindingElement(n)) { walk(n.name); return; }
    ts.forEachChild(n, walk);
  };
  walk(p.name);
  return out;
}

function paramsOf(fn: ts.ArrowFunction | ts.FunctionExpression): Params {
  return { left: bindingNames(fn.parameters[0]), right: bindingNames(fn.parameters[1]) };
}

/**
 * **式を「引数の役割」だけに正規化した綴り**にする。
 * **`a` に束縛された名前は `@L`、`b` に束縛された名前は `@R` に置き換える**ので、
 * **`a.sessionId` と `b.sessionId` は `@L.sessionId` / `@R.sessionId` になる。**
 */
function normalized(n: ts.Node, sf: ts.SourceFile, ps: Params, swap: boolean): string {
  let out = "";
  const emit = (x: ts.Node): void => {
    if (ts.isIdentifier(x)) {
      const isL = ps.left.has(x.text);
      const isR = ps.right.has(x.text);
      if (isL || isR) { out += (isL !== swap) ? "@L" : "@R"; return; }
      out += x.text;
      return;
    }
    if (x.getChildCount(sf) === 0) { out += x.getText(sf).replace(/\s+/g, ""); return; }
    x.forEachChild(emit);
    // 子を持つノードでも、演算子などのトークンは `forEachChild` に来ないので原文から補う
    if (ts.isBinaryExpression(x)) out += `#${x.operatorToken.kind}`;
    if (ts.isPropertyAccessExpression(x)) out += "#.";
    if (ts.isElementAccessExpression(x)) out += "#[]";
    if (ts.isCallExpression(x)) out += "#()";
    if (ts.isPrefixUnaryExpression(x)) out += `#u${x.operator}`;
  };
  emit(n);
  return out;
}

/**
 * **条件が反対称と言える形か**（**#1052。ここが `b.y - a.y > t ? 1 : -1` を落とす規則である**）。
 *
 * **`<` / `>` / `<=` / `>=` の両辺が、2 つの引数をそのまま入れ替えた対になっていること**を要求する。
 * **`a.sessionId < b.sessionId` は入れ替えれば `b.sessionId < a.sessionId` になり向きが必ず反転する**ので許す。
 * **`b.y - a.y > t` は右辺が `t`（引数を含まない）なので鏡になっていない**ので落とす——
 * **実測（2026-09-27）: `cmp(a,b)` も `cmp(b,a)` も `-1` を返し、
 * 同じ y の 4 要素 `ABCD` は `DCBA` に並べ替わった。**
 *
 * **`<=` / `>=` を許すのは、`@L <= @R ? 1 : -1` が
 * 「等しいときに 1、逆向きでも 1」＝反対称ではないからではない**——
 * **確かに等しいときは両方 1 になるので厳密には反対称でない。**
 * **しかし「等しい 2 つを入れ替えても結果の文字列は変わらない」ので実害が無く、
 * V8 の契約違反としても「同値の扱いが不定」の範囲に収まる。**
 * **ここで落とすべきなのは「等しくない 2 つで向きが反転しない」形であり、それは鏡の検査が押さえる。**
 */
function isAntisymmetricCondition(cond: ts.Expression, sf: ts.SourceFile, ps: Params): boolean {
  let c: ts.Expression = cond;
  while (ts.isParenthesizedExpression(c)) c = c.expression;
  if (!ts.isBinaryExpression(c)) return false;
  switch (c.operatorToken.kind) {
    case ts.SyntaxKind.LessThanToken:
    case ts.SyntaxKind.GreaterThanToken:
    case ts.SyntaxKind.LessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanEqualsToken:
      break;
    default:
      return false;
  }
  // **両辺が引数を含むこと**（**片側が閾値だと鏡にならない＝許容差**）
  const usesParam = (n: ts.Node): boolean => normalized(n, sf, ps, false).includes("@");
  if (!usesParam(c.left) || !usesParam(c.right)) return false;
  // **左辺の `a`/`b` を入れ替えたものが右辺と一致すること**
  return normalized(c.left, sf, ps, true) === normalized(c.right, sf, ps, false);
}

/**
 * 0 にならない三項か（`a.k < b.k ? 1 : -1`。佐賀の文字列の同点崩し 3 か所がこの形）。
 *
 * **#1034 は「枝が非ゼロのリテラル」しか見ていなかった**ので、
 * **`b.y - a.y > t ? 1 : -1` を明示的に許していた**（#1052 で実測）。
 * **#1052 で「条件が反対称な形か」も要求する。**
 */
function isNonZeroTernary(n: ts.Expression, sf: ts.SourceFile, ps: Params): boolean {
  if (!ts.isConditionalExpression(n)) return false;
  const lit = (e: ts.Expression): boolean => {
    const t = ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken ? e.operand : e;
    return ts.isNumericLiteral(t) && Number(t.text) !== 0;
  };
  if (!lit(n.whenTrue) || !lit(n.whenFalse)) return false;
  return isAntisymmetricCondition(n.condition, sf, ps);
}

/**
 * 比較の**式**が allowlist の文法に合うか。合わなければ理由を返す。
 * 文法: `E := E - E | E || E | (E) | 非ゼロ三項 | 丸めを含まない任意の算術`
 */
function checkExpr(n: ts.Expression, sf: ts.SourceFile, ps: Params): string | null {
  if (ts.isParenthesizedExpression(n)) return checkExpr(n.expression, sf, ps);
  if (ts.isBinaryExpression(n)) {
    const op = n.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken) return checkExpr(n.left, sf, ps) ?? checkExpr(n.right, sf, ps);
    if (op === ts.SyntaxKind.MinusToken) {
      // `Math.round(b.y / t) - Math.round(a.y / t)` は文法には合うが、行への丸め＝許容差
      // **#1052 で `parseInt` / `toFixed` / `| 0` / `~~` も丸めとして数えるようにした**
      if (hasRounding(n)) return "差の中に丸め（Math.round / parseInt / toFixed / `|0` など）がある＝行に丸めている";
      return null;
    }
    if (op === ts.SyntaxKind.QuestionQuestionToken) return "`??` で繋いでいる（左が 0 でも右に落ちないので全順序にならない）";
    return `許していない演算子 ${ts.tokenToString(n.operatorToken.kind) ?? op}`;
  }
  if (ts.isConditionalExpression(n)) {
    return isNonZeroTernary(n, sf, ps)
      ? null
      : "三項で、枝が非ゼロのリテラルでない、または条件が反対称な形（`a.k < b.k`）でない（許容差を書ける形）";
  }
  return "差（`-`）でも `||` の連鎖でもない式";
}

/** 比較関数の**本体**が allowlist の文法に合うか。 */
function checkBody(fn: ts.ArrowFunction | ts.FunctionExpression, sf: ts.SourceFile): string | null {
  const ps = paramsOf(fn);
  const body = fn.body;
  if (!ts.isBlock(body)) return checkExpr(body, sf, ps);
  // ブロック本体は `return <式>;` 1 つだけを許す（`if` で早期 return する形を落とす）
  const stmts = body.statements.filter((s) => !ts.isEmptyStatement(s));
  if (stmts.length !== 1) return `本体が文 ${stmts.length} 個（許すのは \`return <式>;\` 1 つだけ。if で早期 return する形は許容差を書けるので落とす）`;
  const only = stmts[0];
  // **この行だけを `if (false)` にしても検査は赤くならない**（#1008 で実測。**等価変異**）——
  // **`if (…) return 0;` の `only.expression` は `if` の条件式になり、
  // 下の `checkExpr` が「差でも `||` でもない式」として落とすから**である。
  // **二重になっているだけで、無効な行ではない**（**`checkExpr` の既定を通す側に倒されたときの保険**）。
  if (!ts.isReturnStatement(only) || !only.expression) return "本体の唯一の文が `return <式>;` ではない";
  return checkExpr(only.expression, sf, ps);
}

/**
 * 同じファイルの中で、識別子に束縛された比較関数を探す（`sort(CMP)` を追う）。
 *
 * **#1034 はファイル全体を歩いて、同名が見つかるたびに上書きしていた**ので、
 * **「最後に出てきた定義」が勝っていた**（#1052 で実測）:
 *
 * ```js
 * function f(){ const CMP = (a, b) => Math.abs(a.y - b.y) <= t ? 0 : b.y - a.y; xs.sort(CMP); }
 * function g(){ const CMP = (a, b) => b.y - a.y || a.x - b.x; ys.sort(CMP); }
 * // → #1034 では 2 件とも `reason: null`（素通り）。危険な側が安全な側に隠された
 * ```
 *
 * **つまり「同名の安全な定義をファイルの後ろに置く」だけで検査を黙って無効化できた。**
 * **allowlist を騙せるので、#1008 が直した「denylist の列挙漏れ」より質が悪い。**
 *
 * **どう直したか**: **見つかった宣言を全部集め、2 つ以上あったら
 * 「どれを指しているか決められない」として `ambiguous` を返す**（**#569 の
 * 「分からないものは通さない」側に倒す**）。
 * **スコープの解決そのものはやらない**——
 * **`ts.createSourceFile` だけでは束縛を解決できず、`ts.Program` を作ると
 * 検査が型解決に依存して遅くなるためである。**
 * **同名が 1 つだけなら今までどおり追う**（**県のファイルの実在する `sort(CMP)` は落とさない**）。
 */
type Resolved =
  | { readonly kind: "fn"; readonly fn: ts.ArrowFunction | ts.FunctionExpression }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly count: number };

function resolveLocal(sf: ts.SourceFile, name: string): Resolved {
  const found: (ts.ArrowFunction | ts.FunctionExpression)[] = [];
  let sameNameDecls = 0;
  const walk = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      sameNameDecls++;
      const init = n.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) found.push(init);
    }
    // **`function CMP(a, b) { … }` の宣言も「同名」として数える**
    // （**関数宣言で影を作って、変数の側の判定を隠すのを防ぐ**）。
    //
    // **この 1 行を消しても検査は赤くならない**（#1052 で実測。**等価変異である**）——
    // **`found` に入るのはアロー関数と関数式だけで、関数宣言は最初から入らない**ので、
    // **「安全な関数宣言」が「危険な const」の判定を置き換えることは、この行が無くても起きない**
    // （**実測: 安全な `function CMP` ＋ 危険な `const CMP` は、この行を消しても
    //   `三項で、枝が非ゼロのリテラルでない…` として落ちる。理由が変わるだけである**）。
    // **残すのは、`found` に関数宣言を入れるように変えたときの保険**である。
    if (ts.isFunctionDeclaration(n) && n.name && n.name.text === name) sameNameDecls++;
    ts.forEachChild(n, walk);
  };
  walk(sf);
  if (sameNameDecls > 1) return { kind: "ambiguous", count: sameNameDecls };
  const only = found[0];
  return only ? { kind: "fn", fn: only } : { kind: "none" };
}

/**
 * **`sort` / `toSorted` の「呼び出し方」を見つける**（**#1052**）。
 *
 * **#1034 は `ts.isPropertyAccessExpression`（`xs.sort(...)`）だけを見ていた**ので、
 * **次の 4 通りは「並べ替え」と気づかれず、`comparatorsIn` が 0 件を返していた**（実測）:
 *
 * | 綴り | #1034 |
 * |---|---|
 * | `xs["sort"](cmp)` | **0 件（見つからない）** |
 * | `xs["toSorted"](cmp)` | **0 件** |
 * | `Array.prototype.sort.call(xs, cmp)` | **0 件** |
 * | `Array.prototype.sort.apply(xs, [cmp])` | **0 件** |
 *
 * **`0 件` は「違反が無い」と区別できない**ので、**検査としては素通りと同じである。**
 *
 * **返すのは「メソッド名」と「比較関数が何番目の引数か」**
 * （**`call` は第 1 引数が `this` なので、比較関数は 2 番目**）。
 */
const SORT_METHODS = new Set(["sort", "toSorted"]);

function sortCallOf(n: ts.CallExpression, sf: ts.SourceFile): { method: string; argIndex: number; spread: boolean } | null {
  const e = n.expression;
  // `xs.sort(cmp)` / `xs.toSorted(cmp)`
  if (ts.isPropertyAccessExpression(e) && SORT_METHODS.has(e.name.text)) return { method: e.name.text, argIndex: 0, spread: false };
  // **`xs["sort"](cmp)`**（**文字列リテラルの添字**）
  if (ts.isElementAccessExpression(e) && e.argumentExpression && ts.isStringLiteralLike(e.argumentExpression)
      && SORT_METHODS.has(e.argumentExpression.text)) {
    return { method: e.argumentExpression.text, argIndex: 0, spread: false };
  }
  // **`….sort.call(xs, cmp)` / `….sort.apply(xs, [cmp])`**（**`this` を差し替える形**）
  if (ts.isPropertyAccessExpression(e) && (e.name.text === "call" || e.name.text === "apply")) {
    const inner = e.expression;
    const innerName = ts.isPropertyAccessExpression(inner) ? inner.name.text
      : ts.isElementAccessExpression(inner) && inner.argumentExpression && ts.isStringLiteralLike(inner.argumentExpression)
        ? inner.argumentExpression.text : null;
    if (innerName && SORT_METHODS.has(innerName)) {
      return { method: `${innerName}.${e.name.text}`, argIndex: 1, spread: e.name.text === "apply" };
    }
  }
  void sf;
  return null;
}

/**
 * 1 ファイルの中の `sort` / `toSorted` の比較関数を全部返す。
 * **引数なしの `sort()`（文字列の既定順）は比較関数を持たないので、対象にしない。**
 */
export function comparatorsIn(fileName: string, code: string): Comparator[] {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.ESNext, true);
  const out: Comparator[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const call = sortCallOf(n, sf);
      if (call) {
        let arg: ts.Expression | undefined = n.arguments[call.argIndex];
        // **`apply` は比較関数が配列リテラルの中に入る**（`sort.apply(xs, [cmp])`）
        if (arg && call.spread && ts.isArrayLiteralExpression(arg)) arg = arg.elements[0];
        if (arg) {
          const line = sf.getLineAndCharacterOfPosition(arg.getStart(sf)).line + 1;
          const text = arg.getText(sf).replace(/\s+/g, " ");
          let reason: string | null;
          if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) reason = checkBody(arg, sf);
          else if (ts.isIdentifier(arg)) {
            const r = resolveLocal(sf, arg.text);
            reason = r.kind === "fn" ? checkBody(r.fn, sf)
              : r.kind === "ambiguous"
                ? `同名の宣言が ${r.count} 個あり、どれを指しているか決められない（ambiguous。スコープは見ていないので通さない）`
                : "比較関数が同じファイルの中で見つからない（unresolved。追えないものは通さない）";
          } else {
            reason = "比較関数が同じファイルの中で見つからない（unresolved。追えないものは通さない）";
          }
          out.push({ method: call.method, line, text, reason });
        }
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}
