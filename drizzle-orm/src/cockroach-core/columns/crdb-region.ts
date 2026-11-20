import { entityKind } from '~/entity.ts';
import type { AnyCockroachTable } from '../table.ts';
import { CockroachColumn, type CockroachColumnBaseConfig, CockroachColumnBuilder } from './common.ts';

export class CockroachCrdbRegionBuilder extends CockroachColumnBuilder<{
	dataType: 'string';
	data: string;
	driverParam: string;
	/** Lets `locality.regionalByRow({ as })` tell region columns apart in the types */
	crdbRegion: true;
}> {
	static override readonly [entityKind]: string = 'CockroachCrdbRegionBuilder';

	constructor(name: string) {
		super(name, 'string', 'CockroachCrdbRegion');
	}

	/** @internal */
	override build<TTableName extends string>(
		table: AnyCockroachTable<{ name: TTableName }>,
	) {
		return new CockroachCrdbRegion(
			table,
			this.config,
		);
	}
}

export class CockroachCrdbRegion<T extends CockroachColumnBaseConfig<'string'>> extends CockroachColumn<'string', T> {
	static override readonly [entityKind]: string = 'CockroachCrdbRegion';

	/** @internal */
	override readonly codec = 'enum';

	getSQLType(): string {
		return 'crdb_internal_region';
	}
}

/**
 * A column of CockroachDB's `crdb_internal_region` type, which holds the regions of a multi-region database.
 *
 * Use it as the region column of a `REGIONAL BY ROW` table with `locality.regionalByRow({ as: t.region })`.
 * CockroachDB owns the `crdb_internal_region` type, so the column isn't tied to a `cockroachEnum()`.
 */
export function crdbRegion(name?: string) {
	return new CockroachCrdbRegionBuilder(name ?? '');
}
