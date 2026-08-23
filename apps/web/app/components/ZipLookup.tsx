/**
 * Home の郵便番号入力（Issue 112）: 7 桁の郵便番号から参院選挙区・衆院小選挙区の候補を出し、
 * /members?district= へ送る。データは build/client/data/districts/zip/{上3桁}.json（scripts/shard-districts.ts）を
 * 実行時に fetch するのでクライアント専用。プリレンダーされた HTML（JS 無し）では /members へのリンクだけを出す。
 * 解決は市区町村の粒度。候補が複数なら全部並べ、どれかを選ばない（推定しない）。
 */
import { useEffect, useId, useState } from "react";
import { Link } from "react-router";
import type { DistrictsMeta, ZipDistricts } from "@seiji-kiroku/shared";
import { DISTRICTS_META_URL, ZIP_MULTIPLE, ZIP_NOT_FOUND, membersByDistrictUrl, normalizeZip, readJsonOrNull, splitMunicipalitiesOf, zipShardUrl } from "../lib/districts";
import { formatDate } from "../lib/format";

export const ZIP_INVALID = "郵便番号は7桁で入力してください";
export const ZIP_FETCH_FAILED = "取得に失敗しました";

export type ZipLookupFn = (zip: string) => Promise<ZipDistricts | null>;
export type DistrictsMetaLoader = () => Promise<DistrictsMeta | null>;

/**
 * 分割ファイルを fetch して 1 件引く。ファイルが無い（404）・200 でも JSON でない（SPA フォールバックの HTML など、Issue 120）・
 * その郵便番号が無い → null（「見つからない」）。5xx など他の失敗は例外（「取得に失敗しました」）。
 */
export async function fetchZipDistricts(zip: string): Promise<ZipDistricts | null> {
  const shard = await readJsonOrNull<Record<string, ZipDistricts>>(await fetch(zipShardUrl(zip)), zipShardUrl(zip));
  return shard?.[zip] ?? null;
}

export async function fetchDistrictsMeta(): Promise<DistrictsMeta | null> {
  return readJsonOrNull<DistrictsMeta>(await fetch(DISTRICTS_META_URL), DISTRICTS_META_URL);
}

type State =
  | { status: "idle" }
  | { status: "loading"; zip: string }
  | { status: "message"; text: string }
  | { status: "found"; zip: string; districts: ZipDistricts; meta: DistrictsMeta | null };

export function ZipLookup({ lookup = fetchZipDistricts, loadMeta = fetchDistrictsMeta }: { lookup?: ZipLookupFn; loadMeta?: DistrictsMetaLoader }) {
  const [mounted, setMounted] = useState(false);
  const [input, setInput] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });
  const inputId = useId();

  useEffect(() => setMounted(true), []);

  // JS が無い（プリレンダーのまま）なら一覧への入口だけ
  if (!mounted) {
    return (
      <Link className="entry__link" to="/members">
        選挙区からさがす
        <span className="entry__sub">　議員一覧で選挙区を選ぶ</span>
      </Link>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const zip = normalizeZip(input);
    if (zip === null) {
      setState({ status: "message", text: ZIP_INVALID });
      return;
    }
    setState({ status: "loading", zip });
    try {
      const [districts, meta] = await Promise.all([lookup(zip), loadMeta().catch(() => null)]);
      if (districts === null) setState({ status: "message", text: ZIP_NOT_FOUND });
      else setState({ status: "found", zip, districts, meta });
    } catch {
      setState({ status: "message", text: ZIP_FETCH_FAILED });
    }
  }

  return (
    <div className="zip">
      <form className="zip__form" onSubmit={submit}>
        <label className="zip__label" htmlFor={inputId}>
          郵便番号から選挙区をさがす
        </label>
        <div className="zip__row">
          <input
            id={inputId}
            className="zip__input"
            type="text"
            inputMode="numeric"
            autoComplete="postal-code"
            placeholder="例：100-0001"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit" className="zip__button">
            選挙区をさがす
          </button>
        </div>
      </form>
      {state.status === "loading" && (
        <p className="note" role="status">
          検索中…
        </p>
      )}
      {state.status === "message" && (
        <p className="note" role="status">
          {state.text}
        </p>
      )}
      {state.status === "found" && <ZipResult zip={state.zip} districts={state.districts} meta={state.meta} />}
    </div>
  );
}

function DistrictLinks({ names }: { names: string[] }) {
  return (
    <span className="zip__links">
      {names.map((name) => (
        <Link key={name} className="zip__district" to={membersByDistrictUrl(name)}>
          {name}
        </Link>
      ))}
    </span>
  );
}

function ZipResult({ zip, districts, meta }: { zip: string; districts: ZipDistricts; meta: DistrictsMeta | null }) {
  const multiple = districts.sangiin.length > 1 || districts.shugiin.length > 1;
  const municipalities = districts.municipalities ?? [];
  const split = meta ? splitMunicipalitiesOf(districts, meta) : [];
  const kenAll = meta?.sources.find((s) => s.name.includes("日本郵便"));
  const soumu = meta?.sources.find((s) => s.name.includes("総務省"));
  const title = `郵便番号 ${zip} の選挙区`;
  return (
    <section className="zip__result" aria-label={title}>
      <h3 className="zip__title">
        〒{zip.slice(0, 3)}-{zip.slice(3)}
      </h3>
      <dl className="zip__rows">
        {municipalities.length > 0 && (
          <div className="zip__item">
            <dt>市区町村</dt>
            <dd>{municipalities.join("、")}</dd>
          </div>
        )}
        <div className="zip__item">
          <dt>参議院</dt>
          <dd>
            <DistrictLinks names={districts.sangiin} />
          </dd>
        </div>
        <div className="zip__item">
          <dt>衆議院</dt>
          <dd>
            <DistrictLinks names={districts.shugiin} />
          </dd>
        </div>
      </dl>
      {multiple && (
        <p className="note">
          {ZIP_MULTIPLE}
          {split.length > 0 ? `（${split.join("、")}は複数の小選挙区にまたがります）` : ""}。候補：
          {[...districts.sangiin, ...districts.shugiin].join("、")}
        </p>
      )}
      <p className="note">
        出典：
        {kenAll ? (
          <a href={kenAll.url} rel="noreferrer">
            日本郵便 郵便番号データ
          </a>
        ) : (
          "日本郵便 郵便番号データ"
        )}
        {meta ? `（${formatDate(meta.asOf.kenAll)} 更新）` : ""}・
        {soumu ? (
          <a href={soumu.url} rel="noreferrer">
            総務省 衆議院小選挙区の区割り
          </a>
        ) : (
          "総務省 衆議院小選挙区の区割り"
        )}
        {meta ? `（${formatDate(meta.asOf.shugiinDistricts)} 施行）` : ""}
        。市区町村の単位で対応づけています。
      </p>
    </section>
  );
}
