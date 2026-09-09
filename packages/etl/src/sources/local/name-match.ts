/**
 * 地方議会の表決 PDF の氏名 → 名簿の突き合わせ（Issue #636）。
 *
 * ここに来る前は 7 県それぞれが `nameKey` / `matchName` を書いており、規則が 4 通りに分かれていた
 * （#581／PR #588 の `name-normalization-table.test.ts` が表として固定した状態）。
 * 後から入った改善（#617 異体字セレクタ、字形違いを寄せる、部分列一致）が古い県に伝わらず、
 * 未実装県を足すときにどれを写すかも決まらないので、実装を 1 か所にまとめた。
 *
 * ## 統一した／しなかったこと（#636 で判断。#581 が保留した判断をここで行う）
 *
 * **突合キー（localNameKey）は 7 県で統一した。** 畳む対象を増やす側の変更なので、増やして安全かを実データで測った:
 *   - 本番 `data/assemblies/pref-<code>/rollcalls/` 以下 が記録している (nameText → memberId) の判定 290 件を
 *     まとめる前の県別規則で再現できることを確かめた上で（対照: 差分 0 件）、統一鍵で同じ 290 件を引き直して差分 0 件。
 *   - 統一鍵で名簿の中に新しく衝突する（同じキーになる）組が生まれないことを 285 名で確認（0 件）。
 *     キーが変わる名簿の氏名は宮城「髙橋 伸二」の 1 名だけで、同じ議会の 高橋啓／高橋克也／高橋宗也 とは
 *     名で区別が付くので衝突しない。
 *
 * **国会（`match-votes.ts` の `normalizeName`）は統一に含めない。** 規則が違うのには理由があり、寄せると
 * どちらかが壊れる:
 *   - 国会の表（髙﨑德濵邊邉）は「参院名簿と投票ページで実際にぶれた字」から育ったもので、
 *     地方に無い 濵邊邉 を含む。地方に持ち込むと、地方の名簿で「渡邊」と「渡辺」が別人でも同じキーになる。
 *   - 地方の表（髙﨑𠮷德⾧）は PDF の文字層に由来する 𠮷（BMP 外）と ⾧（康熙部首 U+2FA7）を含む。
 *     国会は HTML なのでこの 2 字がぶれた記録が無い。根拠の無い字を国会の表に足さない。
 *   - 国会は NFKC を掛けるが、地方の実データ 290 件・名簿 285 名は NFKC で 1 文字も変わらない（実測）ので、
 *     地方に NFKC を入れても入れなくても今の突き合わせは変わらない。効かない正規化を足さない。
 *   出どころの違う 2 つの表を「同じに見える」という理由だけで畳むと、根拠が無い字が両側に増える。
 *   #569「迷ったら出さない側に倒す」に従い、国会は国会の実測で育てる。
 *
 * **完全一致が無いときの扱いは、鳥取だけ分ける。** PDF の書式が違うため:
 *   - 鳥取以外の 6 県: PDF の氏名はフルネーム。完全一致 → 無ければ部分列一致（`matchBySubsequence`）。
 *     文字層から字が落ちる列があるため（奈良の外字「芦」・「均」、高知も同様）。
 *   - 鳥取: PDF の氏名は「○○議員」＝姓だけ（同姓は「浜田一議員」のように名の 1 文字付き）。
 *     フルネームではないので完全一致は最初から当たらず、部分列にすると「議員」の 2 字まで
 *     名簿と突き合わせてしまう。実測で、部分列にすると前方一致で決まっていた 35 人全員が決まらなくなる。
 *     よって鳥取は前方一致（`matchBySurnamePrefix`）を残す。
 *
 * ## 部分列一致を 4 県に広げてよいか（#569 を緩めていないか）
 * 名簿の氏名から 1 文字だけ落とした全通りを、鳥取以外の 6 県 250 名で作って引き直した:
 *   母数 988 通り → 本人に正しく寄る 975 ／ 決められない 13 ／ **別人に決まる 0**。
 * 「決められない」は同姓同名に近い組（宮城の高橋 3 名など）で、候補を列挙して memberId は "" のまま。
 * 「別人に決まる」が 0 なので、広げても「利用者から検出できない虚偽」は増えない。
 */

/**
 * 字形違い（異体字）を寄せる表。**人名用の別字（澤/沢・寛/寬・邊/辺 など）は寄せない**——
 * 別字を畳むと別人の記録を作る（#569）。増やすときは、その字が実データでぶれた記録を根拠に足すこと。
 *   髙 U+9AD9 / 﨑 U+FA11 / 𠮷 U+20BB7（BMP 外）/ 德 U+5FB7 / ⾧ U+2FA7（康熙部首。NFKC でも 長 になる）
 */
const ITAIJI: Readonly<Record<string, string>> = { "髙": "高", "﨑": "崎", "𠮷": "吉", "德": "徳", "⾧": "長" };

/**
 * 氏名の突合キー: 空白（全角含む）と異体字セレクタ（U+FE00–FE0F の SVS、U+E0100–E01EF の IVS）を除き、
 * 上の表の字形違いを寄せる。異体字セレクタは幅 0 で目に見えないのに文字列としては違う（#617）。
 * 文字ごとに畳むので、BMP 外の 𠮷（サロゲートペア）も 1 文字として扱う（`[...s]` で分ける）。
 */
export const localNameKey = (s: string): string =>
  [...s.replace(/[\s　]/g, "").replace(/[︀-️\u{E0100}-\u{E01EF}]/gu, "")].map((c) => ITAIJI[c] ?? c).join("");

/**
 * 突き合わせに要る名簿の最小限（`LocalMember` はこれを満たす）。
 * 突き合わせに使わない欄（会派・選挙区など）を型で要求しないので、テストが本物の名簿を組み立てずに済む。
 */
export interface RosterEntry {
  id: string;
  name: string;
}

/** 名簿に寄せた結果。`memberId` が "" なら ETL は選んでいない（候補は運用者が見る）。 */
export interface NameMatch {
  memberId: string;
  candidates: { id: string; name: string }[];
}

const asCandidates = (ms: readonly RosterEntry[]): { id: string; name: string }[] => ms.map((m) => ({ id: m.id, name: m.name }));
const decide = (hits: readonly RosterEntry[]): NameMatch => ({ memberId: hits.length === 1 ? hits[0].id : "", candidates: asCandidates(hits) });

/** a の文字が順序どおり b に現れるか（部分列）。 */
const isSubsequence = (a: string, b: string): boolean => {
  let i = 0;
  for (const c of b) if (i < a.length && c === a[i]) i++;
  return i === a.length;
};

/**
 * 完全一致（`localNameKey`）が 1 人ならその人。0 人・2 人以上は memberId "" で候補を返す（選ばない）。
 * PDF の氏名がフルネームで、文字層に落ちる字が無い議会向け（島根 #221）。
 */
export function matchByExact(nameText: string, roster: readonly RosterEntry[]): NameMatch {
  const key = localNameKey(nameText);
  if (key === "") return { memberId: "", candidates: [] };
  return decide(roster.filter((m) => localNameKey(m.name) === key));
}

/**
 * 完全一致が 1 人ならその人。**完全一致が 0 人のときだけ**、「名簿の氏名に PDF の氏名が順序どおり
 * 部分列として含まれる」議員が 1 人に決まれば寄せる（高知 #220・奈良 #202。文字層に落ちる字があるため）。
 * どちらも 2 人以上なら memberId "" で候補を全部返す（選ばない）。
 *
 * **完全一致が 2 人以上のときに部分列へ落とさない**のが要点——完全一致で割れているものを、より緩い規則で
 * 1 人に絞ったように見せてはいけない。
 * **1 文字は部分列に落とさない**——当たりすぎて別人に決まりうるため。
 */
export function matchBySubsequence(nameText: string, roster: readonly RosterEntry[]): NameMatch {
  const key = localNameKey(nameText);
  if (key === "") return { memberId: "", candidates: [] };
  const exact = roster.filter((m) => localNameKey(m.name) === key);
  if (exact.length > 0) return decide(exact);
  if ([...key].length < 2) return { memberId: "", candidates: [] };
  return decide(roster.filter((m) => isSubsequence(key, localNameKey(m.name))));
}

/**
 * PDF の「○○議員」（姓だけ。同姓は「浜田一議員」のように名の 1 文字付き）→ 名簿（鳥取 #184）。
 * 「議員」を落とした文字列で始まる議員がちょうど 1 人なら memberId、それ以外は "" で候補を全部返す。
 * **この議会だけ書式が違うので前方一致を残している**（理由はファイル冒頭）。
 */
export function matchBySurnamePrefix(nameText: string, roster: readonly RosterEntry[]): NameMatch {
  const key = localNameKey(nameText).replace(/議員$/, "");
  if (key === "") return { memberId: "", candidates: [] };
  return decide(roster.filter((m) => localNameKey(m.name).startsWith(key)));
}

/**
 * 氏名として現れうる文字か（Issue #680）。**allowlist であって denylist ではない。**
 * 「化ける先の記号を並べる」形にすると、次に別の記号で化けたときに素通りする
 * （`□` だけを名指しする守りは、`◇` で化けた PDF に対して無力）。
 *
 * 何を許すかは**本番データの実測で決めた**（2026-09-09）:
 *   - `data/members/index.json` の 1,057 名の氏名 → 異なり 672 文字。CJK 統合漢字 602／ひらがな 50／
 *     カタカナ 18／CJK 互換漢字 1（滋賀と同じ `隆` U+F9DC 系）／`々` 1。**記号は 0 文字。**
 *   - `data/assemblies/*​/rollcalls/` の 45,054 票の `nameText` → 異なり 374 文字。
 *     漢字・かな以外は 空白 25,662・`々` 777・異体字セレクタ U+E0100 453 の 3 種だけ。**記号は 0 文字。**
 * よって「漢字・かな・々・長音・中黒・空白・異体字セレクタ以外が氏名に混じっていたら壊れている」は、
 * **本番の 45,054 票と 1,057 名に対して偽陽性 0 件**。
 *
 * CJK 拡張 A・B（`𠮷` U+20BB7 は拡張 B）と CJK 互換漢字（`隆` U+F9DC）を含めるのは、
 * **どちらも本番の氏名に実在するから**（`ITAIJI` と同じ根拠の取り方）。
 *
 * **康熙部首（`⾧` U+2FA7、島根 #221）はここに書かない。**`localNameKey` が `ITAIJI` で `長` に寄せた後に
 * 見るので、この表と `ITAIJI` の両方に同じ字を書くと、片方だけ増やしたときに食い違う。
 * 判定の入口を `localNameKey` に一本化する（**根拠の置き場を 2 つにしない**）。
 */
const NAME_CHAR = /[々぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿\u{20000}-\u{2A6DF}ーー・\s　]/u;

/**
 * 氏名に混じった「名前になれない字」を出た順に返す（重複は 1 回だけ）。壊れていなければ空配列。
 *
 * **ここは「元の字が何だったか」を推定しない。**`□` を `辻` と読むのは字形を寄せることではなく推定で、
 * 別人の記録を作る側（#569／#674）。**返すのは「壊れている」という事実だけ**で、直す手掛かりは返さない。
 *
 * 異体字セレクタは `localNameKey` と同じく先に落とす（幅 0 で目に見えないので、
 * 「名前になれない字」として報告すると壊れていない氏名まで壊れて見える。#617）。
 */
export function nonNameCharacters(nameText: string): string[] {
  const out: string[] = [];
  // localNameKey と同じ畳み方を通してから見る（異体字セレクタを落とし、ITAIJI を寄せる）
  for (const c of localNameKey(nameText)) {
    if (NAME_CHAR.test(c) || out.includes(c)) continue;
    out.push(c);
  }
  return out;
}

/**
 * 名簿の中に、この氏名と**ちょうど 1 文字だけ違う**議員が居れば、その議員を出た順に返す（Issue #711）。
 *
 * ## 何のためか——**一次資料どうしが氏名で食い違った**ことを名指しするため
 *
 * 実例（佐賀、#670 の実測）: 令和8年6月版 PDF が `猪村理恵子`（理 U+7406）、
 * 令和6年2月版 PDF と議員一覧ページが `猪村利恵子`（利 U+5229）。
 * **NFC でも異体字セレクタでもない、別の漢字である。** だから `localNameKey` は畳まないし、
 * **畳んではいけない**（別字を畳むと別人の記録を作る。`ITAIJI` の docblock と #569）。
 *
 * ## **返り値を突き合わせに使ってはいけない**
 *
 * **「1 文字違い＝同一人物」ではない。** 実測（2026-09-09、本番の地方名簿 285 名）——
 * **現職どうしで 1 文字違いの組が 3 組ある**:
 *   宮城 `高橋 克也` / `高橋 宗也`、三重 `喜田 健児` / `津田 健児`、高知 `西森 美和` / `西森 雅和`。
 * この 3 組のどれかに寄せた瞬間、**利用者から検出できない虚偽**になる（#569）。
 * ここが返すのは**事実（1 文字違いの氏名が名簿に在る）だけ**で、**どちらが正しいかは決めない。**
 *
 * ## なぜ「1 文字」だけか（緩めない理由）
 *
 * 2 文字以上違えば「食い違い」と言う根拠が無い（別人でありうる）。**長さが違う場合も見ない**——
 * それは字が落ちた側の話で、`matchBySubsequence`（部分列一致。#617/#648）が既に扱っている。
 * 完全一致は当然この関数の対象外（食い違っていない）。
 *
 * 比較は `localNameKey` を通した後で行う（空白・異体字セレクタ・`ITAIJI` の差は食い違いではない）。
 */
export function conflictingRosterNames(nameText: string, roster: readonly RosterEntry[]): { id: string; name: string }[] {
  const key = [...localNameKey(nameText)];
  if (key.length === 0) return [];
  return asCandidates(roster.filter((m) => {
    const other = [...localNameKey(m.name)];
    if (other.length !== key.length) return false;
    let diff = 0;
    for (let i = 0; i < key.length; i++) if (key[i] !== other[i] && ++diff > 1) return false;
    return diff === 1;
  }));
}

/**
 * 名簿に寄せられなかった氏名が「なぜ寄せられなかったか」（`LocalUnmatchedName.reason`。#680／#711）。
 *
 * **区別したいのは 3 つの別の出来事**——
 *   - **名簿に無い議員**（会期の途中で入れ替わった、名簿の取得が古い）→ `undefined`（これまでどおり）
 *   - **PDF の中で氏名の字が壊れている** → `"brokenGlyph"`（#680）
 *   - **一次資料どうしが氏名で食い違っている** → `"sourceConflict"`（#711。佐賀 猪村理恵子/利恵子）
 * どれも `unmatched.json` に落ちる（**落とす側は変えない。#569 のまま**）が、
 * **`unmatched.json` を見る運用者にとっては全く違う話**で、
 * 1 つ目は名簿を直す、2 つ目は文字層を疑う、3 つ目は**どちらが正しいかを議会に確かめる**。
 * 理由を書かないと、後ろの 2 つが 1 つ目に見える（#680 の案A の欠点）。
 *
 * **`brokenGlyph` が先。** 字が壊れた氏名はたまたま名簿と 1 文字違いになりうる（`□村利恵子`）が、
 * それは食い違いではなく文字化けで、**問い合わせる先が違う。**
 *
 * `roster` を渡さなければ（空配列）氏名だけで決まる `brokenGlyph` しか見ない。
 */
export function unmatchedReason(nameText: string, roster: readonly RosterEntry[] = []): "brokenGlyph" | "sourceConflict" | undefined {
  if (nonNameCharacters(nameText).length > 0) return "brokenGlyph";
  return conflictingRosterNames(nameText, roster).length > 0 ? "sourceConflict" : undefined;
}
