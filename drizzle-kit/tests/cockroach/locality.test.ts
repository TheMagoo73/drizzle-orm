import { cockroachTable, int4, locality } from 'drizzle-orm/cockroach-core';
import { createDDL } from 'src/dialects/cockroach/ddl';
import { snapshotValidator } from 'src/dialects/cockroach/snapshot';
import { ddlToTypeScript } from 'src/dialects/cockroach/typescript';
import { upToV2 } from 'src/dialects/cockroach/versions';
import { validatorForDialect } from 'src/utils/utils-node';
import { describe, expect } from 'vitest';
import { clusterHasRegions, diff, diffIntrospect, push, test } from './mocks';

// A version-1 snapshot, written before tables had a locality.
const snapshotV1 = {
	version: '1',
	dialect: 'cockroach',
	id: '7f3a1d2e-0000-4000-8000-000000000001',
	prevIds: ['00000000-0000-0000-0000-000000000000'],
	ddl: [
		{ entityType: 'schemas', name: 'public' },
		{ entityType: 'tables', schema: 'public', name: 'users', isRlsEnabled: false },
	],
	renames: [],
};

describe('snapshot', () => {
	// The strict validator rejects a row without `locality`, so the snapshot version went to 2 with an upgrade.
	test('a table row without locality fails the latest validator', () => {
		expect(snapshotValidator.parse({ ...snapshotV1, version: '2' }).success).toBe(false);
	});

	test('a version-1 snapshot without locality still loads, with the default locality', () => {
		expect(validatorForDialect('cockroach')(snapshotV1)).toStrictEqual({ status: 'valid' });

		const snapshot = snapshotValidator.strict(upToV2(snapshotV1));
		const ddl = createDDL();
		for (const entity of snapshot.ddl) ddl.entities.push(entity);

		expect(snapshot.version).toBe('2');
		expect(ddl.tables.one({ name: 'users' })?.locality).toBeNull();
	});
});

describe('diff', () => {
	test('create table with global() emits inline LOCALITY GLOBAL', async () => {
		const to = {
			users: cockroachTable('users', { id: int4().primaryKey() }, () => [locality.global()]),
		};

		const { sqlStatements } = await diff({}, to, []);

		expect(sqlStatements).toStrictEqual([
			'CREATE TABLE "users" (\n\t"id" int4 PRIMARY KEY\n) LOCALITY GLOBAL;\n',
		]);
	});

	test('create table with regionalByTable({ in }) emits inline LOCALITY REGIONAL BY TABLE IN region', async () => {
		const to = {
			users: cockroachTable('users', { id: int4().primaryKey() }, () => [
				locality.regionalByTable({ in: 'us-east1' }),
			]),
		};

		const { sqlStatements } = await diff({}, to, []);

		expect(sqlStatements).toStrictEqual([
			'CREATE TABLE "users" (\n\t"id" int4 PRIMARY KEY\n) LOCALITY REGIONAL BY TABLE IN "us-east1";\n',
		]);
	});

	test('create table with regionalByTable() and no region has no LOCALITY clause', async () => {
		const to = {
			users: cockroachTable('users', { id: int4().primaryKey() }, () => [locality.regionalByTable()]),
		};

		const { sqlStatements } = await diff({}, to, []);

		expect(sqlStatements).toStrictEqual(['CREATE TABLE "users" (\n\t"id" int4 PRIMARY KEY\n);\n']);
	});

	// Each pair of the three table localities this slice covers, in both directions: one SET LOCALITY statement.
	const localities = {
		default: () => [],
		global: () => [locality.global()],
		inRegion: () => [locality.regionalByTable({ in: 'us-east1' })],
	};
	const setLocality = {
		default: 'ALTER TABLE "users" SET LOCALITY REGIONAL BY TABLE IN PRIMARY REGION;',
		global: 'ALTER TABLE "users" SET LOCALITY GLOBAL;',
		inRegion: 'ALTER TABLE "users" SET LOCALITY REGIONAL BY TABLE IN "us-east1";',
	};
	const transitions = [
		['default', 'global'],
		['default', 'inRegion'],
		['global', 'default'],
		['global', 'inRegion'],
		['inRegion', 'default'],
		['inRegion', 'global'],
	] as const;

	test.each(transitions)('%s -> %s emits one SET LOCALITY statement', async (from, to) => {
		const { sqlStatements } = await diff(
			{ users: cockroachTable('users', { id: int4().primaryKey() }, localities[from]) },
			{ users: cockroachTable('users', { id: int4().primaryKey() }, localities[to]) },
			[],
		);

		expect(sqlStatements).toStrictEqual([setLocality[to]]);
	});

	test('unset and regionalByTable() with no region have no diff', async () => {
		const unset = { users: cockroachTable('users', { id: int4().primaryKey() }) };
		const explicit = {
			users: cockroachTable('users', { id: int4().primaryKey() }, () => [locality.regionalByTable()]),
		};

		expect((await diff(unset, explicit, [])).sqlStatements).toStrictEqual([]);
		expect((await diff(explicit, unset, [])).sqlStatements).toStrictEqual([]);
	});

	test('a region change on a regionalByTable table emits one SET LOCALITY statement', async () => {
		const { sqlStatements } = await diff(
			{
				users: cockroachTable('users', { id: int4().primaryKey() }, () => [
					locality.regionalByTable({ in: 'us-east1' }),
				]),
			},
			{
				users: cockroachTable('users', { id: int4().primaryKey() }, () => [
					locality.regionalByTable({ in: 'us-west1' }),
				]),
			},
			[],
		);

		expect(sqlStatements).toStrictEqual(['ALTER TABLE "users" SET LOCALITY REGIONAL BY TABLE IN "us-west1";']);
	});
});

describe.skipIf(!(await clusterHasRegions()))('push', () => {
	test('create tables with global() and regionalByTable({ in }), then a second push is a no-op', async ({ mrdb }) => {
		const to = {
			countries: cockroachTable('countries', { id: int4().primaryKey() }, () => [locality.global()]),
			orders: cockroachTable('orders', { id: int4().primaryKey() }, () => [
				locality.regionalByTable({ in: mrdb.primaryRegion }),
			]),
		};

		const { sqlStatements } = await push({ db: mrdb, to });

		expect(sqlStatements).toStrictEqual([
			'CREATE TABLE "countries" (\n\t"id" int4 PRIMARY KEY\n) LOCALITY GLOBAL;\n',
			`CREATE TABLE "orders" (\n\t"id" int4 PRIMARY KEY\n) LOCALITY REGIONAL BY TABLE IN "${mrdb.primaryRegion}";\n`,
		]);
		// push() runs a second push and expects it to be empty.
	});

	test('default -> global -> in region -> default applies one SET LOCALITY per push', async ({ mrdb }) => {
		const table = (
			extra: () => [] | [ReturnType<typeof locality.global>] | [
				ReturnType<typeof locality.regionalByTable>,
			],
		) => ({ users: cockroachTable('users', { id: int4().primaryKey() }, extra) });

		await push({ db: mrdb, to: table(() => []) });

		const toGlobal = await push({ db: mrdb, to: table(() => [locality.global()]) });
		const toRegion = await push({
			db: mrdb,
			to: table(() => [locality.regionalByTable({ in: mrdb.primaryRegion })]),
		});
		const toDefault = await push({ db: mrdb, to: table(() => []) });

		expect(toGlobal.sqlStatements).toStrictEqual(['ALTER TABLE "users" SET LOCALITY GLOBAL;']);
		expect(toRegion.sqlStatements).toStrictEqual([
			`ALTER TABLE "users" SET LOCALITY REGIONAL BY TABLE IN "${mrdb.primaryRegion}";`,
		]);
		expect(toDefault.sqlStatements).toStrictEqual([
			'ALTER TABLE "users" SET LOCALITY REGIONAL BY TABLE IN PRIMARY REGION;',
		]);
	});
});

describe.skipIf(!(await clusterHasRegions()))('pull', () => {
	test('global() round-trips', async ({ mrdb }) => {
		const schema = {
			countries: cockroachTable('countries', { id: int4().primaryKey() }, () => [locality.global()]),
		};

		const { pushSqlStatements, generateSqlStatements, ddlAfterPull } = await diffIntrospect(
			mrdb,
			schema,
			'locality-global',
		);

		expect(ddlAfterPull.tables.one({ name: 'countries' })?.locality).toStrictEqual({
			type: 'global',
			region: null,
			as: null,
		});
		expect(pushSqlStatements).toStrictEqual([]);
		expect(generateSqlStatements).toStrictEqual([]);
	});

	test('regionalByTable({ in }) round-trips', async ({ mrdb }) => {
		const schema = {
			orders: cockroachTable('orders', { id: int4().primaryKey() }, () => [
				locality.regionalByTable({ in: mrdb.primaryRegion }),
			]),
		};

		const { pushSqlStatements, generateSqlStatements, ddlAfterPull } = await diffIntrospect(
			mrdb,
			schema,
			'locality-regional-by-table-in',
		);

		expect(ddlAfterPull.tables.one({ name: 'orders' })?.locality).toStrictEqual({
			type: 'regionalByTable',
			region: mrdb.primaryRegion,
			as: null,
		});
		expect(pushSqlStatements).toStrictEqual([]);
		expect(generateSqlStatements).toStrictEqual([]);
	});

	test('a table with the default locality pulls with no locality', async ({ mrdb }) => {
		const schema = { users: cockroachTable('users', { id: int4().primaryKey() }) };

		const { pushSqlStatements, generateSqlStatements, ddlAfterPull } = await diffIntrospect(
			mrdb,
			schema,
			'locality-default',
		);

		expect(ddlAfterPull.tables.one({ name: 'users' })?.locality).toBeNull();
		expect(ddlToTypeScript(ddlAfterPull, [], 'camel').file).not.toContain('locality');
		expect(pushSqlStatements).toStrictEqual([]);
		expect(generateSqlStatements).toStrictEqual([]);
	});
});
