import type { LocalMember } from "@seiji-kiroku/shared";

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

/** 名簿に寄せた結果。`memberId` が "" なら ETL は選んでいない（候補は運用者が見る）。 */
export interface NameMatch {
  memberId: string;
  candidates: { id: string; name: string }[];
}

const asCandidates = (ms: readonly LocalMember[]): { id: string; name: string }[] => ms.map((m) => ({ id: m.id, name: m.name }));
const decide = (hits: readonly LocalMember[]): NameMatch => ({ memberId: hits.length === 1 ? hits[0].id : "", candidates: asCandidates(hits) });

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
export function matchByExact(nameText: string, roster: readonly LocalMember[]): NameMatch {
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
export function matchBySubsequence(nameText: string, roster: readonly LocalMember[]): NameMatch {
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
export function matchBySurnamePrefix(nameText: string, roster: readonly LocalMember[]): NameMatch {
  const key = localNameKey(nameText).replace(/議員$/, "");
  if (key === "") return { memberId: "", candidates: [] };
  return decide(roster.filter((m) => localNameKey(m.name).startsWith(key)));
}
