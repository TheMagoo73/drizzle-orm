import { entityKind, is } from '~/entity.ts';
import type { CrdbRegionExtraConfigColumn } from './columns/common.ts';

export type CockroachLocalityType = 'global' | 'regionalByTable' | 'regionalByRow';

export interface CockroachRegionalByTableConfig {
	/** The region the table lives in. Leave it out for the database's primary region. */
	in?: string;
}

export interface CockroachRegionalByRowConfig {
	/** A `crdbRegion()` column that holds each row's region. Leave it out for CockroachDB's hidden `crdb_region` column. */
	as?: CrdbRegionExtraConfigColumn;
}

/**
 * A table's CockroachDB locality, as returned by `getTableConfig(table).locality`.
 *
 * Declare one with the `locality` builders in the table's extra config.
 */
export class CockroachLocality<TType extends CockroachLocalityType = CockroachLocalityType> {
	static readonly [entityKind]: string = 'CockroachLocality';
	static [Symbol.hasInstance](value: unknown): boolean {
		return is(value, this);
	}

	/** The region of a `regionalByTable` table. Undefined means the database's primary region. */
	readonly in?: string;
	/** The region column of a `regionalByRow` table. Undefined means CockroachDB's hidden `crdb_region` column. */
	readonly as?: CrdbRegionExtraConfigColumn;

	constructor(readonly type: TType, config?: CockroachRegionalByTableConfig & CockroachRegionalByRowConfig) {
		if (type === 'regionalByTable') this.in = config?.in;
		if (type === 'regionalByRow') this.as = config?.as;
	}
}

/**
 * CockroachDB table localities, for multi-region databases. Return one from the table's extra config:
 *
 * ```ts
 * cockroachTable('countries', { code: text().primaryKey() }, () => [locality.global()]);
 * cockroachTable('orders', { id: uuid().primaryKey() }, () => [locality.regionalByTable({ in: 'us-east1' })]);
 * cockroachTable('accounts', {
 * 	id: uuid().primaryKey(),
 * 	region: crdbRegion().notNull(),
 * }, (t) => [locality.regionalByRow({ as: t.region })]);
 * ```
 *
 * A table without a locality gets CockroachDB's default, `REGIONAL BY TABLE IN PRIMARY REGION`.
 * The database must have a primary region before a table can have a locality.
 */
export const locality = {
	/** `LOCALITY GLOBAL`: fast reads from every region, slower writes */
	global(): CockroachLocality<'global'> {
		return new CockroachLocality('global');
	},
	/** `LOCALITY REGIONAL BY TABLE [IN region]`: the table lives in one region, the primary region by default */
	regionalByTable(config?: CockroachRegionalByTableConfig): CockroachLocality<'regionalByTable'> {
		return new CockroachLocality('regionalByTable', config);
	},
	/** `LOCALITY REGIONAL BY ROW [AS column]`: each row lives in the region its region column names */
	regionalByRow(config?: CockroachRegionalByRowConfig): CockroachLocality<'regionalByRow'> {
		return new CockroachLocality('regionalByRow', config);
	},
};
