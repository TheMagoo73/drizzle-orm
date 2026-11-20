import { sql } from 'drizzle-orm';
import {
	cockroachTable,
	crdbRegion,
	index,
	int4,
	locality,
	snakeCase,
	string,
	uniqueIndex,
} from 'drizzle-orm/cockroach-core';
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

		const snapshot = snapshotValidator.strict(upToV2(snapshotV1).snapshot);
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
	const unset = { users: cockroachTable('users', { id: int4().primaryKey() }) };
	const global = { users: cockroachTable('users', { id: int4().primaryKey() }, () => [locality.global()]) };
	const inRegion = {
		users: cockroachTable('users', { id: int4().primaryKey() }, () => [
			locality.regionalByTable({ in: 'us-east1' }),
		]),
	};

	test('default -> global() emits SET LOCALITY GLOBAL', async () => {
		const { sqlStatements } = await diff(unset, global, []);

		expect(sqlStatements).toStrictEqual(['ALTER TABLE "users" SET LOCALITY GLOBAL;']);
	});

	test('default -> regionalByTable({ in }) emits SET LOCALITY REGIONAL BY TABLE IN the region', async () => {
		const { sqlStatements } = await diff(unset, inRegion, []);

		expect(sqlStatements).toStrictEqual(['ALTER TABLE "users" SET LOCALITY REGIONAL BY TABLE IN "us-east1";']);
	});

	test('global() -> default emits SET LOCALITY REGIONAL BY TABLE IN PRIMARY REGION', async () => {
		const { sqlStatements } = await diff(global, unset, []);

		expect(sqlStatements).toStrictEqual(['ALTER TABLE "users" SET LOCALITY REGIONAL BY TABLE IN PRIMARY REGION;']);
	});

	test('global() -> regionalByTable({ in }) emits SET LOCALITY REGIONAL BY TABLE IN the region', async () => {
		const { sqlStatements } = await diff(global, inRegion, []);

		expect(sqlStatements).toStrictEqual(['ALTER TABLE "users" SET LOCALITY REGIONAL BY TABLE IN "us-east1";']);
	});

	test('regionalByTable({ in }) -> default emits SET LOCALITY REGIONAL BY TABLE IN PRIMARY REGION', async () => {
		const { sqlStatements } = await diff(inRegion, unset, []);

		expect(sqlStatements).toStrictEqual(['ALTER TABLE "users" SET LOCALITY REGIONAL BY TABLE IN PRIMARY REGION;']);
	});

	test('regionalByTable({ in }) -> global() emits SET LOCALITY GLOBAL', async () => {
		const { sqlStatements } = await diff(inRegion, global, []);

		expect(sqlStatements).toStrictEqual(['ALTER TABLE "users" SET LOCALITY GLOBAL;']);
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

// Moving a table to or from REGIONAL BY ROW rewrites its primary index. Push prints this warning, without a prompt,
// and generate writes it as a comment above the statement.
const rbrWarning = (table: string) =>
	`${table} moves to or from REGIONAL BY ROW, so CockroachDB rewrites its primary index in a schema change job. The table takes a schema change lock until it finishes.`;
const rbrComment = (table: string) => `-- ${rbrWarning(table)}\n`;

describe('diff REGIONAL BY ROW', () => {
	test('create table with regionalByRow() emits inline LOCALITY REGIONAL BY ROW', async () => {
		const to = {
			users: cockroachTable('users', { id: int4().primaryKey() }, () => [locality.regionalByRow()]),
		};

		const { sqlStatements } = await diff({}, to, []);

		expect(sqlStatements).toStrictEqual([
			'CREATE TABLE "users" (\n\t"id" int4 PRIMARY KEY\n) LOCALITY REGIONAL BY ROW;\n',
		]);
	});

	test('create table with regionalByRow({ as }) emits inline LOCALITY REGIONAL BY ROW AS the column', async () => {
		const to = {
			users: cockroachTable('users', { id: int4().primaryKey(), region: crdbRegion().notNull() }, (t) => [
				locality.regionalByRow({ as: t.region }),
			]),
		};

		const { sqlStatements } = await diff({}, to, []);

		expect(sqlStatements).toStrictEqual([
			'CREATE TABLE "users" (\n\t"id" int4 PRIMARY KEY,\n\t"region" crdb_internal_region NOT NULL\n) LOCALITY REGIONAL BY ROW AS "region";\n',
		]);
	});

	test('altering to regionalByRow() emits SET LOCALITY with the rewrite comment', async () => {
		const { sqlStatements } = await diff(
			{ users: cockroachTable('users', { id: int4().primaryKey() }) },
			{ users: cockroachTable('users', { id: int4().primaryKey() }, () => [locality.regionalByRow()]) },
			[],
		);

		expect(sqlStatements).toStrictEqual([
			`${rbrComment('"users"')}ALTER TABLE "users" SET LOCALITY REGIONAL BY ROW;`,
		]);
	});

	test('altering from regionalByRow() to global() emits SET LOCALITY with the rewrite comment', async () => {
		const { sqlStatements } = await diff(
			{ users: cockroachTable('users', { id: int4().primaryKey() }, () => [locality.regionalByRow()]) },
			{ users: cockroachTable('users', { id: int4().primaryKey() }, () => [locality.global()]) },
			[],
		);

		expect(sqlStatements).toStrictEqual([`${rbrComment('"users"')}ALTER TABLE "users" SET LOCALITY GLOBAL;`]);
	});

	test('a change that neither starts nor ends at REGIONAL BY ROW has no comment', async () => {
		const { sqlStatements } = await diff(
			{ users: cockroachTable('users', { id: int4().primaryKey() }) },
			{ users: cockroachTable('users', { id: int4().primaryKey() }, () => [locality.global()]) },
			[],
		);

		expect(sqlStatements).toStrictEqual(['ALTER TABLE "users" SET LOCALITY GLOBAL;']);
	});

	test('adding a crdbRegion() column and switching to regionalByRow({ as }) adds the column first', async () => {
		const { sqlStatements } = await diff(
			{ users: cockroachTable('users', { id: int4().primaryKey() }) },
			{
				users: cockroachTable('users', { id: int4().primaryKey(), region: crdbRegion().notNull() }, (t) => [
					locality.regionalByRow({ as: t.region }),
				]),
			},
			[],
		);

		expect(sqlStatements).toStrictEqual([
			'ALTER TABLE "users" ADD COLUMN "region" crdb_internal_region NOT NULL;',
			`${rbrComment('"users"')}ALTER TABLE "users" SET LOCALITY REGIONAL BY ROW AS "region";`,
		]);
	});

	test('switching away from regionalByRow({ as }) and dropping the column sets the locality first', async () => {
		const { sqlStatements } = await diff(
			{
				users: cockroachTable('users', { id: int4().primaryKey(), region: crdbRegion().notNull() }, (t) => [
					locality.regionalByRow({ as: t.region }),
				]),
			},
			{ users: cockroachTable('users', { id: int4().primaryKey() }) },
			[],
		);

		expect(sqlStatements).toStrictEqual([
			`${rbrComment('"users"')}ALTER TABLE "users" SET LOCALITY REGIONAL BY TABLE IN PRIMARY REGION;`,
			'ALTER TABLE "users" DROP COLUMN "region";',
		]);
	});

	test('moving regionalByRow({ as }) from an old column to a new one adds, sets the locality, then drops', async () => {
		const { sqlStatements } = await diff(
			{
				users: cockroachTable('users', { id: int4().primaryKey(), oldRegion: crdbRegion().notNull() }, (t) => [
					locality.regionalByRow({ as: t.oldRegion }),
				]),
			},
			{
				users: cockroachTable('users', { id: int4().primaryKey(), newRegion: crdbRegion().notNull() }, (t) => [
					locality.regionalByRow({ as: t.newRegion }),
				]),
			},
			[],
		);

		expect(sqlStatements).toStrictEqual([
			'ALTER TABLE "users" ADD COLUMN "newRegion" crdb_internal_region NOT NULL;',
			`${rbrComment('"users"')}ALTER TABLE "users" SET LOCALITY REGIONAL BY ROW AS "newRegion";`,
			'ALTER TABLE "users" DROP COLUMN "oldRegion";',
		]);
	});

	test('renaming the AS column keeps the locality on it, with no SET LOCALITY', async () => {
		const { sqlStatements } = await diff(
			{
				users: cockroachTable('users', { id: int4().primaryKey(), region: crdbRegion().notNull() }, (t) => [
					locality.regionalByRow({ as: t.region }),
				]),
			},
			{
				users: cockroachTable('users', { id: int4().primaryKey(), homeRegion: crdbRegion().notNull() }, (t) => [
					locality.regionalByRow({ as: t.homeRegion }),
				]),
			},
			['public.users.region->public.users.homeRegion'],
		);

		expect(sqlStatements).toStrictEqual(['ALTER TABLE "users" RENAME COLUMN "region" TO "homeRegion";']);
	});

	test('a crdbRegion() column never creates or drops the crdb_internal_region type', async () => {
		const withRegion = {
			users: cockroachTable('users', { id: int4().primaryKey(), region: crdbRegion().notNull() }, (t) => [
				locality.regionalByRow({ as: t.region }),
			]),
		};

		const created = await diff({}, withRegion, []);
		const dropped = await diff(withRegion, {}, []);

		expect(created.statements.map((it) => it.type)).toStrictEqual(['create_table']);
		expect(dropped.statements.map((it) => it.type)).toStrictEqual(['drop_table']);
	});

	test('regionalByRow({ as }) names the column by its database name under snake_case casing', async () => {
		const to = {
			users: snakeCase.table('users', { id: int4().primaryKey(), homeRegion: crdbRegion().notNull() }, (t) => [
				locality.regionalByRow({ as: t.homeRegion }),
			]),
		};

		const { sqlStatements } = await diff({}, to, []);

		expect(sqlStatements).toStrictEqual([
			'CREATE TABLE "users" (\n\t"id" int4 PRIMARY KEY,\n\t"home_region" crdb_internal_region NOT NULL\n) LOCALITY REGIONAL BY ROW AS "home_region";\n',
		]);
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

describe.skipIf(!(await clusterHasRegions()))('push REGIONAL BY ROW', () => {
	test('create tables with regionalByRow() and regionalByRow({ as }), then a second push is a no-op', async ({ mrdb }) => {
		const to = {
			users: cockroachTable('users', { id: int4().primaryKey() }, () => [locality.regionalByRow()]),
			orders: cockroachTable('orders', { id: int4().primaryKey(), region: crdbRegion().notNull() }, (t) => [
				locality.regionalByRow({ as: t.region }),
			]),
		};

		const { sqlStatements, hints, warnings } = await push({ db: mrdb, to });

		expect(sqlStatements).toStrictEqual([
			'CREATE TABLE "users" (\n\t"id" int4 PRIMARY KEY\n) LOCALITY REGIONAL BY ROW;\n',
			'CREATE TABLE "orders" (\n\t"id" int4 PRIMARY KEY,\n\t"region" crdb_internal_region NOT NULL\n) LOCALITY REGIONAL BY ROW AS "region";\n',
		]);
		// Creating a table rewrites nothing.
		expect(hints).toStrictEqual([]);
		expect(warnings).toStrictEqual([]);
	});

	test('altering to and from regionalByRow() warns without a prompt and has no SQL comment', async ({ mrdb }) => {
		const table = (rbr: boolean) => ({
			users: cockroachTable('users', { id: int4().primaryKey() }, () => rbr ? [locality.regionalByRow()] : []),
		});
		await push({ db: mrdb, to: table(false) });

		const toRbr = await push({ db: mrdb, to: table(true) });
		const fromRbr = await push({ db: mrdb, to: table(false) });

		expect(toRbr.sqlStatements).toStrictEqual(['ALTER TABLE "users" SET LOCALITY REGIONAL BY ROW;']);
		expect(toRbr.hints).toStrictEqual([]);
		expect(toRbr.warnings).toStrictEqual([rbrWarning('"users"')]);
		expect(fromRbr.sqlStatements).toStrictEqual([
			'ALTER TABLE "users" SET LOCALITY REGIONAL BY TABLE IN PRIMARY REGION;',
		]);
		expect(fromRbr.hints).toStrictEqual([]);
		expect(fromRbr.warnings).toStrictEqual([rbrWarning('"users"')]);
	});

	test('a locality change that does not touch REGIONAL BY ROW has no warning', async ({ mrdb }) => {
		await push({ db: mrdb, to: { users: cockroachTable('users', { id: int4().primaryKey() }) } });

		const { warnings } = await push({
			db: mrdb,
			to: { users: cockroachTable('users', { id: int4().primaryKey() }, () => [locality.global()]) },
		});

		expect(warnings).toStrictEqual([]);
	});

	test('adding a crdbRegion() column and switching to regionalByRow({ as }) in one push', async ({ mrdb }) => {
		await push({ db: mrdb, to: { users: cockroachTable('users', { id: int4().primaryKey() }) } });

		const { sqlStatements } = await push({
			db: mrdb,
			to: {
				users: cockroachTable('users', {
					id: int4().primaryKey(),
					region: crdbRegion().notNull().default(sql`gateway_region()`),
				}, (t) => [locality.regionalByRow({ as: t.region })]),
			},
		});

		expect(sqlStatements).toStrictEqual([
			'ALTER TABLE "users" ADD COLUMN "region" crdb_internal_region DEFAULT gateway_region()::crdb_internal_region NOT NULL;',
			'ALTER TABLE "users" SET LOCALITY REGIONAL BY ROW AS "region";',
		]);
	});

	test('switching away from regionalByRow({ as }) and dropping the column in one push', async ({ mrdb }) => {
		await push({
			db: mrdb,
			to: {
				users: cockroachTable('users', { id: int4().primaryKey(), region: crdbRegion().notNull() }, (t) => [
					locality.regionalByRow({ as: t.region }),
				]),
			},
		});

		const { sqlStatements } = await push({
			db: mrdb,
			to: { users: cockroachTable('users', { id: int4().primaryKey() }, () => [locality.global()]) },
		});

		expect(sqlStatements).toStrictEqual([
			'ALTER TABLE "users" SET LOCALITY GLOBAL;',
			'ALTER TABLE "users" DROP COLUMN "region";',
		]);
	});

	test('renaming the AS column keeps the table REGIONAL BY ROW on it', async ({ mrdb }) => {
		await push({
			db: mrdb,
			to: {
				users: cockroachTable('users', { id: int4().primaryKey(), region: crdbRegion().notNull() }, (t) => [
					locality.regionalByRow({ as: t.region }),
				]),
			},
		});

		const { sqlStatements } = await push({
			db: mrdb,
			to: {
				users: cockroachTable('users', { id: int4().primaryKey(), homeRegion: crdbRegion().notNull() }, (t) => [
					locality.regionalByRow({ as: t.homeRegion }),
				]),
			},
			renames: ['public.users.region->public.users.homeRegion'],
		});

		expect(sqlStatements).toStrictEqual(['ALTER TABLE "users" RENAME COLUMN "region" TO "homeRegion";']);
	});

	test('regionalByRow({ as }) on a computed crdbRegion() column creates the table, then a second push is a no-op', async ({ mrdb }) => {
		const regionFor = sql.raw(`CASE WHEN country = 'US' THEN '${mrdb.primaryRegion}' ELSE '${mrdb.primaryRegion}' END`);
		const to = {
			users: cockroachTable('users', {
				id: int4().primaryKey(),
				country: string().notNull(),
				region: crdbRegion().notNull().generatedAlwaysAs(regionFor),
			}, (t) => [locality.regionalByRow({ as: t.region })]),
		};

		const { sqlStatements } = await push({ db: mrdb, to });

		expect(sqlStatements).toStrictEqual([
			'CREATE TABLE "users" (\n\t"id" int4 PRIMARY KEY,\n\t"country" string NOT NULL,\n'
			+ `\t"region" crdb_internal_region GENERATED ALWAYS AS (CASE WHEN country = 'US' THEN '${mrdb.primaryRegion}' ELSE '${mrdb.primaryRegion}' END) STORED NOT NULL\n`
			+ ') LOCALITY REGIONAL BY ROW AS "region";\n',
		]);
		// push() runs a second push and expects it to be empty.
	});

	test("pushes keep a REGIONAL BY ROW table's keys and never touch crdb_internal_region or crdb_region", async ({ mrdb }) => {
		const schema = (rbr: boolean) => ({
			users: cockroachTable('users', {
				id: int4().primaryKey(),
				email: string().unique(),
				name: string(),
			}, (t) => [index('users_name_idx').on(t.name), ...(rbr ? [locality.regionalByRow()] : [])]),
		});
		await push({ db: mrdb, to: schema(false) });

		const toRbr = await push({ db: mrdb, to: schema(true) });
		const dropped = await push({ db: mrdb, to: {} });

		expect(toRbr.sqlStatements).toStrictEqual(['ALTER TABLE "users" SET LOCALITY REGIONAL BY ROW;']);
		expect(dropped.sqlStatements).toStrictEqual(['DROP TABLE "users";']);
		const touched = [...toRbr.sqlStatements, ...dropped.sqlStatements].filter((it) =>
			/crdb_(internal_)?region/.test(it)
		);
		expect(touched).toStrictEqual([]);
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

describe.skipIf(!(await clusterHasRegions()))('pull REGIONAL BY ROW', () => {
	test('regionalByRow() round-trips with its primary key, uniques and indexes', async ({ mrdb }) => {
		const schema = {
			users: cockroachTable('users', {
				id: int4().primaryKey(),
				email: string().unique(),
				firstName: string(),
				lastName: string(),
			}, (t) => [
				uniqueIndex('users_name_key').on(t.firstName, t.lastName),
				index('users_last_name_idx').on(t.lastName),
				locality.regionalByRow(),
			]),
		};

		const { pushSqlStatements, generateSqlStatements, ddlAfterPull } = await diffIntrospect(
			mrdb,
			schema,
			'locality-rbr-default',
		);

		expect(ddlAfterPull.tables.one({ name: 'users' })?.locality).toStrictEqual({
			type: 'regionalByRow',
			region: null,
			as: null,
		});
		// The hidden crdb_region column isn't modelled, and the keys have no region prefix.
		expect(ddlAfterPull.columns.list({ table: 'users' }).map((it) => it.name)).toStrictEqual([
			'id',
			'email',
			'firstName',
			'lastName',
		]);
		expect(ddlAfterPull.pks.list().map((it) => it.columns)).toStrictEqual([['id']]);
		expect(ddlAfterPull.indexes.list().map(({ name, columns }) => ({ name, columns: columns.map((c) => c.value) })))
			.toStrictEqual([
				{ name: 'users_email_key', columns: ['email'] },
				{ name: 'users_last_name_idx', columns: ['lastName'] },
				{ name: 'users_name_key', columns: ['firstName', 'lastName'] },
			]);
		expect(ddlAfterPull.enums.list()).toStrictEqual([]);
		expect(pushSqlStatements).toStrictEqual([]);
		expect(generateSqlStatements).toStrictEqual([]);
	});

	test('regionalByRow({ as }) round-trips with a crdbRegion() column, its default and its keys', async ({ mrdb }) => {
		const schema = {
			orders: cockroachTable('orders', {
				id: int4().primaryKey(),
				region: crdbRegion().notNull().default(sql`default_to_database_primary_region(gateway_region())`),
				sku: string().unique(),
				total: int4(),
			}, (t) => [index('orders_total_idx').on(t.total), locality.regionalByRow({ as: t.region })]),
		};

		const { pushSqlStatements, generateSqlStatements, ddlAfterPull } = await diffIntrospect(
			mrdb,
			schema,
			'locality-rbr-as',
		);

		expect(ddlAfterPull.tables.one({ name: 'orders' })?.locality).toStrictEqual({
			type: 'regionalByRow',
			region: null,
			as: 'region',
		});
		expect(ddlAfterPull.columns.one({ table: 'orders', name: 'region' })).toMatchObject({
			type: 'crdb_internal_region',
			typeSchema: null,
			notNull: true,
			default: 'default_to_database_primary_region(gateway_region())',
		});
		expect(ddlAfterPull.pks.list().map((it) => it.columns)).toStrictEqual([['id']]);
		expect(ddlAfterPull.indexes.list().map(({ name, columns }) => ({ name, columns: columns.map((c) => c.value) })))
			.toStrictEqual([
				{ name: 'orders_sku_key', columns: ['sku'] },
				{ name: 'orders_total_idx', columns: ['total'] },
			]);
		expect(ddlAfterPull.enums.list()).toStrictEqual([]);
		expect(pushSqlStatements).toStrictEqual([]);
		expect(generateSqlStatements).toStrictEqual([]);
	});

	test('a crdbRegion() column with a region literal default round-trips', async ({ mrdb }) => {
		const schema = {
			orders: cockroachTable('orders', {
				id: int4().primaryKey(),
				region: crdbRegion().notNull().default(mrdb.primaryRegion),
			}, (t) => [locality.regionalByRow({ as: t.region })]),
		};

		const { pushSqlStatements, generateSqlStatements, ddlAfterPull } = await diffIntrospect(
			mrdb,
			schema,
			'locality-rbr-as-literal-default',
		);

		expect(ddlAfterPull.columns.one({ table: 'orders', name: 'region' })?.default).toBe(`'${mrdb.primaryRegion}'`);
		expect(pushSqlStatements).toStrictEqual([]);
		expect(generateSqlStatements).toStrictEqual([]);
	});

	test('regionalByRow({ as }) round-trips with a computed crdbRegion() column', async ({ mrdb }) => {
		const regionFor = sql.raw(`CASE WHEN country = 'US' THEN '${mrdb.primaryRegion}' ELSE '${mrdb.primaryRegion}' END`);
		const schema = {
			users: cockroachTable('users', {
				id: int4().primaryKey(),
				country: string().notNull(),
				region: crdbRegion().notNull().generatedAlwaysAs(regionFor),
			}, (t) => [locality.regionalByRow({ as: t.region })]),
		};

		const { pushSqlStatements, generateSqlStatements, ddlAfterPull } = await diffIntrospect(
			mrdb,
			schema,
			'locality-rbr-as-computed',
		);

		expect(ddlAfterPull.tables.one({ name: 'users' })?.locality).toStrictEqual({
			type: 'regionalByRow',
			region: null,
			as: 'region',
		});
		expect(ddlAfterPull.columns.one({ table: 'users', name: 'region' })).toMatchObject({
			type: 'crdb_internal_region',
			typeSchema: null,
			notNull: true,
			generated: { type: 'stored' },
		});
		expect(ddlAfterPull.pks.list().map((it) => it.columns)).toStrictEqual([['id']]);
		expect(ddlAfterPull.enums.list()).toStrictEqual([]);
		expect(pushSqlStatements).toStrictEqual([]);
		expect(generateSqlStatements).toStrictEqual([]);
	});
});
