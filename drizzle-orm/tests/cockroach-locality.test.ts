import { describe, expect, test } from 'vitest';
import { cockroachTable, crdbRegion, getTableConfig, index, locality, text, uuid } from '~/cockroach-core/index.ts';

describe('cockroach table locality', () => {
	test('no locality declared', () => {
		const users = cockroachTable('users', { id: uuid().primaryKey() }, (t) => [index('users_id_idx').on(t.id)]);

		expect(getTableConfig(users).locality).toBeUndefined();
	});

	test('global', () => {
		const countries = cockroachTable('countries', { code: text().primaryKey() }, () => [locality.global()]);

		expect(getTableConfig(countries).locality).toEqual({ type: 'global' });
	});

	test('regional by table in the primary region', () => {
		const orders = cockroachTable('orders', { id: uuid().primaryKey() }, () => [locality.regionalByTable()]);

		expect(getTableConfig(orders).locality).toEqual({ type: 'regionalByTable', in: undefined });
	});

	test('regional by table in a named region', () => {
		const orders = cockroachTable('orders', { id: uuid().primaryKey() }, () => [
			locality.regionalByTable({ in: 'us-west1' }),
		]);

		expect(getTableConfig(orders).locality).toEqual({ type: 'regionalByTable', in: 'us-west1' });
	});

	test('regional by row with the default region column', () => {
		const users = cockroachTable('users', { id: uuid().primaryKey() }, () => [locality.regionalByRow()]);

		expect(getTableConfig(users).locality).toEqual({ type: 'regionalByRow', as: undefined });
	});

	test('regional by row with a custom region column', () => {
		const accounts = cockroachTable('accounts', {
			id: uuid().primaryKey(),
			homeRegion: crdbRegion('home_region').notNull(),
		}, (t) => [locality.regionalByRow({ as: t.homeRegion })]);

		const config = getTableConfig(accounts);

		expect(config.locality?.type).toBe('regionalByRow');
		expect(config.locality?.as?.name).toBe('home_region');
	});

	test('locality sits alongside indexes and constraints', () => {
		const users = cockroachTable('users', { id: uuid().primaryKey() }, (t) => [
			index('users_id_idx').on(t.id),
			locality.global(),
		]);

		const config = getTableConfig(users);

		expect(config.indexes).toHaveLength(1);
		expect(config.locality).toEqual({ type: 'global' });
	});

	test('two localities on one table throw', () => {
		const users = cockroachTable('users', { id: uuid().primaryKey() }, () => [
			locality.global(),
			locality.regionalByRow(),
		]);

		expect(() => getTableConfig(users)).toThrowError(/Table "users" declares more than one locality/);
	});
});

describe('crdbRegion column', () => {
	test('has SQL type crdb_internal_region', () => {
		const accounts = cockroachTable('accounts', {
			id: uuid().primaryKey(),
			region: crdbRegion().notNull(),
		});

		expect(accounts.region.getSQLType()).toBe('crdb_internal_region');
		expect(accounts.region.name).toBe('region');
	});

	test('is not tied to an enum entity', () => {
		const accounts = cockroachTable('accounts', { region: crdbRegion() });

		expect(accounts.region.enumValues).toBeUndefined();
	});
});
