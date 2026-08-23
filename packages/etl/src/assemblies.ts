import type { AssemblyId, DietAssemblyId, House, Member } from "@seiji-kiroku/shared";

/** 国会の2議会の id（`assemblies/index.json`、#156）。院 → 議会 id。 */
export const DIET_ASSEMBLY_IDS: Readonly<Record<House, DietAssemblyId>> = { sangiin: "diet-sangiin", shugiin: "diet-shugiin" };

/** 議員の所属議会。名簿が assemblyId を持てばそれ（地方議会）、無ければ国会の院から `diet-{house}`。 */
export const assemblyIdOf = (m: Pick<Member, "house" | "assemblyId">): AssemblyId => m.assemblyId ?? DIET_ASSEMBLY_IDS[m.house];
