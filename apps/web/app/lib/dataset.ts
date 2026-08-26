import type { Assembly, AssemblyId, BillSummary, DatasetMeta, House, MemberId } from "@seiji-kiroku/shared";

/**
 * Read side of docs/DATA_CONTRACT.md. The summary shapes below mirror the
 * contract; they move to `@seiji-kiroku/shared` once the ETL side lands.
 */
export interface MemberSummary {
  id: MemberId;
  name: string;
  kana: string;
  house: House;
  /** 所属議会（#156）。無い（古いデータ）なら house から diet-{house} */
  assemblyId?: AssemblyId;
  group: string;
  district: string;
  termEnd?: string;
  /** 最新回次の名簿に載っているか。無い（古いデータ）なら現職として扱う */
  current?: boolean;
  counts: { rollcalls: number; bills: number; speeches: number; questions?: number };
}

export interface RollCallSummary {
  id: string;
  session: number;
  date: string;
  title: string;
  totals: { total: number; yes: number; no: number };
  result: string;
}

export interface Dataset {
  meta?: DatasetMeta;
  /** `assemblies/index.json`（#156）。無い（古いデータ）なら国会の2議会（DIET_ASSEMBLIES）として扱う */
  assemblies?: Assembly[];
  members: MemberSummary[];
  rollcalls: RollCallSummary[];
  /** `bills/index.json`（議案。衆院の会派態度の裏づけ）。無い（古い）データなら空 */
  bills?: BillSummary[];
}

/** `data/` is bundled at build time; a missing file simply yields an empty dataset. */
const metaFiles = import.meta.glob<DatasetMeta>("../../../../data/meta.json", { eager: true, import: "default" });
const assemblyFiles = import.meta.glob<Assembly[]>("../../../../data/assemblies/index.json", { eager: true, import: "default" });
const memberFiles = import.meta.glob<MemberSummary[]>("../../../../data/members/index.json", { eager: true, import: "default" });
const rollcallFiles = import.meta.glob<RollCallSummary[]>("../../../../data/rollcalls/index.json", { eager: true, import: "default" });
const billFiles = import.meta.glob<BillSummary[]>("../../../../data/bills/index.json", { eager: true, import: "default" });

function first<T>(files: Record<string, T>): T | undefined {
  return Object.values(files)[0];
}

export const dataset: Dataset = {
  meta: first(metaFiles),
  assemblies: first(assemblyFiles),
  members: first(memberFiles) ?? [],
  rollcalls: first(rollcallFiles) ?? [],
  bills: first(billFiles) ?? [],
};

/** [220, 221] → "第220—221回"、[221] → "第221回" */
export function formatSessions(sessions: number[]): string | undefined {
  if (sessions.length === 0) return undefined;
  const lo = Math.min(...sessions);
  const hi = Math.max(...sessions);
  return lo === hi ? `第${lo}回` : `第${lo}—${hi}回`;
}

export const REPO_URL = "https://github.com/uonoko1/giinrecord";
