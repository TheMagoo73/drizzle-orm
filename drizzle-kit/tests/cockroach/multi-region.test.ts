import { composeHint, requireEnv } from '@drizzle/test-utils';
import { Pool } from 'pg';
import { afterAll, describe, expect } from 'vitest';
import { clusterHasRegions, test } from './mocks';

describe.skipIf(!(await clusterHasRegions()))('multi-region database fixture', () => {
	const usedDatabases: string[] = [];

	// Runs after the fixture's teardown, so the databases the tests used must be gone by now.
	afterAll(async () => {
		const urls = requireEnv('COCKROACH_CONNECTION_STRING', composeHint('cockroach')).split(';').filter(Boolean);
		const remaining: string[] = [];
		for (const connectionString of urls) {
			const pool = new Pool({ connectionString, max: 1 });
			try {
				const { rows } = await pool.query<{ database_name: string }>('SHOW DATABASES;');
				remaining.push(...rows.map((it) => it.database_name).filter((it) => usedDatabases.includes(it)));
			} finally {
				await pool.end();
			}
		}
		expect(remaining).toStrictEqual([]);
	});

	test('creates a REGIONAL BY ROW table in its own multi-region database, dropped after the test', async ({ mrdb }) => {
		usedDatabases.push(mrdb.name);

		await mrdb.query('CREATE TABLE "users" ("id" int4 PRIMARY KEY, "email" string) LOCALITY REGIONAL BY ROW;');

		const [table] = await mrdb.query<{ locality: string }>(
			`SELECT locality FROM [SHOW TABLES] WHERE table_name = 'users';`,
		);
		expect(table?.locality).toBe('REGIONAL BY ROW');
	});
});
