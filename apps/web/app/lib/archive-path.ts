/** Where the bulk archive lives on the site (Issue #49). Browser-safe: no Node imports here. */
export const ARCHIVE_NAME = "data-archive.zip";
/** nginx serves /data/ with a 1h cache (the former host server block, Sprint 1-5). */
export const ARCHIVE_PATH = `/data/${ARCHIVE_NAME}`;
/** Same value as lib/dataset.ts REPO_URL; duplicated because dataset.ts uses import.meta.glob (Vite only) and archive.ts runs under plain tsx. */
export const REPO_URL = "https://github.com/uonoko1/giinrecord";
