import type { CockroachSnapshot } from './snapshot';

export const latestVersion = '2';

// Version 2 adds the tables' `locality`. A version-1 snapshot has none, and every table in it had CockroachDB's
// default locality (`null`), so the upgrade only fills that in. Kit upgrades version-1 snapshots when it reads
// them, so a folder written by an older drizzle-kit keeps working without `drizzle-kit up`. Returns the same shape as
// the other dialects' upgrades; this one never has hints.
export const upToV2 = (it: Record<string, any>): { snapshot: CockroachSnapshot; hints: string[] } => {
	if (it['version'] !== '1' || !Array.isArray(it['ddl'])) return { snapshot: it as CockroachSnapshot, hints: [] };

	const ddl = (it['ddl'] as Record<string, unknown>[]).map((entity) =>
		entity['entityType'] === 'tables' && !('locality' in entity) ? { ...entity, locality: null } : entity
	);
	return { snapshot: { ...it, version: latestVersion, ddl } as CockroachSnapshot, hints: [] };
};
