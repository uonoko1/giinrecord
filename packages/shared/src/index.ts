/**
 * Shared data model for 議会ログ.
 * Every record carries `sourceUrl` — the primary source it was transcribed from.
 * The site renders facts only; nothing here encodes an evaluation.
 */

export type House = "sangiin" | "shugiin";

/* ---------- 議会（Assembly、Issue #156。docs/research/local-assemblies.md「DATA_CONTRACT 拡張の素案」を正式化） ---------- */

/**
 * 議会の階層。`House` は国会の院の意味のまま残し（既存 JSON の後方互換）、地方議会は `House` を増やさず Assembly で表す。
 * national: 国会（参議院・衆議院）、prefectural: 都道府県議会、municipal: 市区町村議会。
 */
export type AssemblyKind = "national" | "prefectural" | "municipal";

/** 国会の2議会の id。`diet-${House}`。 */
export type DietAssemblyId = "diet-sangiin" | "diet-shugiin";

/**
 * 議会 id。国会は `diet-sangiin` / `diet-shugiin`、都道府県は `pref-{団体コード上2桁}`（例 pref-04 宮城）、
 * 市区町村は `city-{団体コード5桁}`（例 city-33100 岡山市）。団体コードは `districts/municipalities.json` の code と同じ体系。
 * URL は `/assemblies/{assemblyId}/`。
 */
export type AssemblyId = DietAssemblyId | `pref-${string}` | `city-${string}`;

/** `data/assemblies/index.json` の1行。名称・出典は議会の公式サイトの原文。評価は持たない。 */
export interface Assembly {
  id: AssemblyId;
  kind: AssemblyKind;
  /** 議会の名称（例「参議院」「宮城県議会」「岡山市議会」） */
  name: string;
  /** 都道府県の団体コード上2桁（prefectural / municipal のとき）。national には無い */
  prefCode?: string;
  /** 議会の公式ページ（名簿・会議結果の入口）。地方議会のレコードはこのホストを sourceUrl に持つ */
  sourceUrl: string;
}

/**
 * Stable internal id. Never derived from name (names change).
 * 参院は名簿のプロフィール id（例 "m_000123"）、衆院は "h_" 接頭辞の id（例 "h_000123"、#71）。接頭辞で院が分かる。
 */
export type MemberId = string; // e.g. "m_000123" (参院), "h_000123" (衆院)。地方議会は "p_{prefCode}_…"（#156）で id 空間を分ける

export interface Member {
  id: MemberId;
  name: string;        // 公式表記（例: "藤川 政人"）。通称使用者は通称（投票ページの表記と一致）
  legalName?: string;  // 通称使用者の本名（名簿の "[本名]" 行）。通称と同じなら省略
  kana: string;        // ふりがな
  house: House;
  /** 所属議会（#156）。国会の名簿パーサは付けず、集約（buildDataset）が house から `diet-{house}` を補う。地方議会の名簿は必ず付ける */
  assemblyId?: AssemblyId;
  /** Membership periods; a member can move between groups/houses. */
  terms: MemberTerm[];
  /** 最新回次の名簿に載っているか（辞職・任期満了で名簿から消えた人は false）。回次をまたいで統合したときに付く。 */
  current?: boolean;
  sourceUrl: string;   // 衆参の議員一覧・プロフィール
}

/** Lightweight row for `data/members/index.json` (search / list). See docs/DATA_CONTRACT.md. */
export interface MemberSummary {
  id: MemberId;
  name: string;
  kana: string;
  house: House;
  /** 所属議会（`assemblies/index.json` の id。国会は `diet-{house}`）。#156 */
  assemblyId: AssemblyId;
  group: string;       // 名簿上の会派表記（参院は略称）
  district: string;
  termEnd?: string;    // ISO date
  /** 最新回次の名簿に載っているか。false は元職（辞職・任期満了）。事実であって評価ではない。 */
  current: boolean;
  counts: { rollcalls: number; bills: number; speeches: number; questions: number };
}

export interface MemberTerm {
  house: House;
  group: string;       // 会派（例: "自由民主党・無所属の会"）
  district: string;    // 選挙区（例: "愛知", "比例"）
  from: string;        // ISO date
  to?: string;         // ISO date, undefined = current
  sessionFrom: number; // 国会回次
  sessionTo?: number;
  /** 当選回数（衆院名簿「当選回数」列。参院名簿には無い）。その院での回数の数値 */
  timesElected?: number;
  /** 当選回数欄の原文が数値だけでないとき（例「1（参2）」= 他院での当選を併記）。数値だけなら省略 */
  timesElectedText?: string;
}

export type BillKind = "閣法" | "衆法" | "参法" | "予算" | "条約" | "承認" | "決議" | "その他";

/**
 * 議案（衆参の議案情報から）。`data/bills/{session}/{id}.json`（docs/DATA_CONTRACT.md）。
 * 氏名・会派名・議決はすべて議案ページの原文。`shugiinGroupStance` だけが会派単位の記録（推定）で、
 * 個人の賛否を表すものではない。RollCall には入れない。
 */
export interface Bill {
  id: string;          // `{提出回次}-{種別原文}-{番号}`（例 "221-衆法-1"）。番号の無い議案（決算・承諾など）は番号の代わりに経過ページの id
  session: number;     // 提出回次
  kind: BillKind;
  /** 議案情報の種別の原文（例「決算」「ＮＨＫ決算」「承諾」）。kind に対応が無く その他 にしたとき原文を残す。kind と同じなら省略 */
  kindText?: string;
  number?: number;
  title: string;
  /** この議案ページを公開している院（sourceUrl のドメインと一致） */
  house: House;
  submitters?: MemberId[];   // 議員立法の提出者（事実。名簿に名寄せできた人だけ）
  supporters?: MemberId[];   // 議員立法の賛成者（事実。名簿に名寄せできた人だけ）
  submitterText?: string;    // 「議案提出者」欄の原文（例: "落合　貴之君外四名", "内閣", "国土交通委員長"）
  /** 「議案提出者一覧」の氏名（原文から「君」を除いたもの。事実）。欄が無い（閣法・参法）なら省略 */
  submitterNames?: string[];
  /** 「議案提出の賛成者」の氏名（同上）。欄はあるが空なら [] */
  supporterNames?: string[];
  /** 「議案提出会派」（原文の会派名） */
  submitterGroups?: string[];
  /** 議案受理年月日（各院）。ISO */
  received?: { shugiin?: string; sangiin?: string };
  /** 一覧ページの「審議状況」の原文（例「成立」「衆議院で閉会中審査」「本院議了」） */
  status?: string;
  /** 各院の審議結果の原文（可決・否決・修正・承認・閉会中審査 …）と公布日・法律番号 */
  result?: { sangiin?: string; shugiin?: string; promulgated?: string; lawNumber?: string };
  /**
   * 【推定】衆議院審議時の会派態度（経過ページ「衆議院審議時会派態度／賛成会派／反対会派」の原文）。
   * 衆議院は個人別の投票記録を公開していないため、個人の賛否はここから推定するしかない。事実（参院の個人票）とは型で分ける。
   */
  shugiinGroupStance?: ShugiinGroupStance;
  sourceUrl: string;
}

/** 会派単位の態度（推定の材料）。会派名は原文。`unanimous` はページが「全会一致」と書いているときだけ true（反対会派が空でも推論しない）。 */
export interface ShugiinGroupStance {
  /** 「衆議院審議時会派態度」の原文（多数・少数・全会一致） */
  stanceText: string;
  yes: string[];
  no: string[];
  unanimous?: boolean;
}

/** Row of `data/bills/index.json`（議案一覧用）. */
export interface BillSummary {
  id: string;
  session: number;
  kind: BillKind;
  house: House;
  title: string;
  status?: string;
  sourceUrl: string;
}

export type VoteValue = "賛成" | "反対" | "投票なし";

/**
 * 地方議会の表決値（#156）。国会の `VoteValue` には触れず、凡例（○×議欠－棄白、簡易／起立 …）を**原文のまま**保持する。
 * - `raw`: 表決結果表のセルの原文（例「○」「×」「欠」「－」「議」）。
 * - `legend`: その議会の凡例での意味の原文（例「賛成」「反対」「欠席」「議場に不在」「議長」「棄権」「白票」）。
 * - `mapped`: 国会の VoteValue に機械的に対応づけられるときだけ（○→賛成、×→反対、欠席・退席・除斥・議長など「票を投じていない」ことが凡例から読めるとき→投票なし）。
 *   凡例から読めなければ省略し、推定しない。表示は必ず raw と legend を添え、mapped だけを出さない（欠席と棄権を区別している事実を消さない）。
 */
export interface LocalVote {
  raw: string;
  legend: string;
  mapped?: VoteValue;
}

/** One roll-call vote in the House of Councillors plenary. */
export interface RollCall {
  id: string;          // e.g. "221-0724-v001"
  session: number;
  date: string;        // ISO date
  title: string;       // 案件名（原文）
  billId?: string;
  totals: { total: number; yes: number; no: number };
  /** Per-group tallies as published (事実). */
  groups: { group: string; size: number; yes: number; no: number }[];
  /** Per-member votes (事実). */
  votes: { memberId: MemberId; nameText: string; group: string; value: VoteValue }[];
  sourceUrl: string;
}

export interface Speech {
  id: string;          // NDL speechID
  memberId?: MemberId;
  speakerText: string;
  group?: string;
  position?: string;
  house: House;
  meeting: string;     // 会議名
  date: string;
  excerpt: string;     // 冒頭の抜粋（要約はしない）
  chars: number;
  sourceUrl: string;   // 会議録の該当発言URL
}

/**
 * 質問主意書（衆参の質問答弁情報から。Issue #106）。事実のみ: 提出者・件名・提出日・答弁書受領日・本文URL はページの原文。
 * 衆院は経過ページ（itdb_shitsumon.nsf/html/shitsumon/{回次}{番号3桁}.htm、Shift_JIS）、参院は詳細ページ（joho1/kousei/syuisyo/{回次}/meisai/m{回次}{番号3桁}.htm）。
 * ファイルには書かず、名寄せ済みの提出者の timeline（QuestionEntry）にだけなる。
 */
export interface Question {
  /** `{回次}-{house}-{番号}`（例 "221-shugiin-1", "221-sangiin-12"）。衆参で番号が独立なので house を含める */
  id: string;
  session: number;
  number: number;
  house: House;
  title: string;
  /** 提出日（衆院「質問主意書提出年月日」／参院「提出日」）。ISO */
  date: string;
  /** 提出者欄の原文（例「緒方 林太郎君」）。全角空白は半角1つに寄せる */
  submitterText: string;
  /** 提出者の氏名（原文から「君」を除いたもの）。両院とも現行ページでは1人 */
  submitterNames: string[];
  /** 名簿に名寄せできた提出者（memberId）。できなければ省略 */
  submitters?: MemberId[];
  /** 衆院 経過ページの「会派名」（原文。同姓同名の分離に使う）。参院の詳細ページには無い */
  group?: string;
  /** 衆院 一覧・経過ページの「経過状況」の原文（例「答弁受理」）。参院には無い */
  status?: string;
  /** 答弁書受領日（衆院「答弁書受領年月日」／参院「答弁書受領日」）。ISO。空欄なら省略（推定しない） */
  answerDate?: string;
  /** 質問本文（HTML）の URL */
  questionUrl?: string;
  /** 答弁本文（HTML）の URL。答弁書が無ければ省略 */
  answerUrl?: string;
  /** 衆院 経過ページ／参院 詳細ページ */
  sourceUrl: string;
}

export interface DatasetMeta {
  fetchedAt: string;   // ISO datetime
  sources: { name: string; url: string; fetchedAt: string }[];
  sessions: number[];
}

/** `data/members/{id}.json`: the member plus every record of theirs, newest first (docs/DATA_CONTRACT.md). */
export interface MemberDetail extends Member {
  timeline: TimelineEntry[];
}

export type VoteEntry = {
  kind: "vote";
  date: string;
  rollCallId: string;
  title: string;
  value: VoteValue;
  /** 公表された集計をそのまま文字列にしたもの（例: "賛成 150・反対 90"）。可否の判定・評価はしない。 */
  result: string;
  /** その採決でその会派の多数票（賛成票>反対票なら賛成、同数なら undefined）。 */
  groupValue?: VoteValue;
  sourceUrl: string;
};
/** 議員立法でのその人の立場（議案ページの原文に基づく事実）。参法の「発議者」は 提出者。 */
export type BillRole = "提出者" | "賛成者";
export type BillEntry = {
  kind: "bill";
  /** 参議院への提出日（議案ページ「提出日」）。 */
  date: string;
  billId: string;
  title: string;
  role: BillRole;
  /** 議案ページ「発議者」欄の原文（例「打越さく良君 外9名」）。外N名の氏名は公表されていないので、人数の事実だけをここで示す。 */
  submitterText?: string;
  /** 審議状況（議案ページの経過のうち最新のものを「段階名 議決の原文」で）。 */
  status?: string;
  sourceUrl: string;
};
export type SpeechEntry = {
  kind: "speech";
  date: string;
  speechId: string;
  meeting: string;
  excerpt: string;
  chars: number;
  /** 会議録の speakerPosition をそのまま（例: "議長", "国土交通大臣", "財政金融委員長"）。議員としてではなく役職として行った発言の事実。無ければ省略 */
  position?: string;
  sourceUrl: string;
};
/**
 * 【推定】所属会派の態度（衆院のみ）。衆議院は個人の投票記録を公開していないので、Bill.shugiinGroupStance（経過ページの
 * 「賛成会派／反対会派」の原文）のうち、その議員がその回次に所属していた会派が載っている議案だけを行にする。
 * 記録されるのは会派（group）の態度であり、本人の賛否ではない。`estimated: true` を常に持ち、VoteEntry（事実）とは型で分ける。
 */
export type StanceEntry = {
  kind: "stance";
  estimated: true;
  /** 衆議院の議案受理年月日（Bill.received.shugiin）。 */
  date: string;
  billId: string;
  title: string;
  /** その議員が所属していた会派（名簿の正式名称。賛成会派／反対会派の原文と同じ表記）。 */
  group: string;
  /** 会派が「賛成会派」「反対会派」のどちらに載っていたか。 */
  stance: "賛成" | "反対";
  /** 「衆議院審議時会派態度」の原文（多数・少数・全会一致）。 */
  stanceText: string;
  /** 一覧ページの「審議状況」の原文。 */
  status?: string;
  sourceUrl: string;
};
/** 質問主意書の提出（事実。衆参の質問答弁情報から。Issue #106）。date は提出日。 */
export type QuestionEntry = {
  kind: "question";
  date: string;
  questionId: string;
  title: string;
  /** 提出者欄の原文（例「緒方 林太郎君」）。 */
  submitterText?: string;
  /** 衆院「経過状況」の原文（例「答弁受理」）。参院には無い。 */
  status?: string;
  /** 答弁書受領日（ISO）。無ければ省略。 */
  answerDate?: string;
  /** 答弁本文（HTML）の URL。無ければ省略。 */
  answerUrl?: string;
  /** 衆院 経過ページ／参院 詳細ページ。 */
  sourceUrl: string;
};
export type TimelineEntry = VoteEntry | BillEntry | SpeechEntry | StanceEntry | QuestionEntry;

/** Row of `data/rollcalls/index.json` (採決一覧用). */
/* ---------- 選挙区（data/districts/、Issue #111 / #112） ---------- */

/** `districts/by-zip.json` の値。名簿の district と同じ表記（"東京" / "鳥取・島根"、"東京4" / "北海道12"）。分割市区町村は候補を全部並べる（推定しない）。 */
export interface ZipDistricts {
  sangiin: string[];
  shugiin: string[];
  /** KEN_ALL の都道府県＋市区町村（「東京都千代田区」、団体コード順。複数にまたがる郵便番号は全部）。#120 より前の月次 ETL の出力には無いので省略可。 */
  municipalities?: string[];
}

/** `districts/municipalities.json` の1行（団体コード順）。`split === shugiin.length > 1`。 */
export interface DistrictMunicipality {
  code: string;
  pref: string;
  city: string;
  shugiin: string[];
  split: boolean;
}

/** `districts/meta.json`（日次の meta.json とは別）。 */
export interface DistrictsMeta {
  fetchedAt: string;
  /** 基準日: KEN_ALL の更新日／区割り改定法の施行日（2022-12-28） */
  asOf: { kenAll: string; shugiinDistricts: string };
  sources: { name: string; url: string; fetchedAt: string }[];
  counts: { zips: number; municipalities: number; shugiinDistricts: number; splitMunicipalities: number };
  splitMunicipalities: { code: string; pref: string; city: string; shugiin: string[] }[];
}

export interface RollCallSummary {
  id: string;
  session: number;
  date: string;
  title: string;
  totals: { total: number; yes: number; no: number };
  result: string;
  sourceUrl: string;
}
