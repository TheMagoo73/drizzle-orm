import type { CockroachSnapshot } from './snapshot';

export const latestVersion = '2';

// Version 2 adds the tables' `locality`. A version-1 snapshot has none, and every table in it had CockroachDB's
// default locality (`null`), so the upgrade only fills that in. Kit upgrades version-1 snapshots when it reads
// them, so a folder written by an older drizzle-kit keeps working without `drizzle-kit up`.
export const upToV2 = (it: Record<string, any>): CockroachSnapshot => {
	if (it['version'] !== '1' || !Array.isArray(it['ddl'])) return it as CockroachSnapshot;

	const ddl = (it['ddl'] as Record<string, unknown>[]).map((entity) =>
		entity['entityType'] === 'tables' && !('locality' in entity) ? { ...entity, locality: null } : entity
	);
	return { ...it, version: latestVersion, ddl } as CockroachSnapshot;
};
