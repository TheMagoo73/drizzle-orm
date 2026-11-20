import type { Equal } from 'type-tests/utils.ts';
import { Expect } from 'type-tests/utils.ts';
import {
	cockroachEnum,
	type CockroachLocality,
	cockroachTable,
	crdbRegion,
	getTableConfig,
	locality,
	text,
	uuid,
} from '~/cockroach-core/index.ts';

{
	const accounts = cockroachTable('accounts', {
		id: uuid().primaryKey(),
		region: crdbRegion().notNull(),
	}, (t) => [locality.regionalByRow({ as: t.region })]);

	Expect<Equal<typeof accounts.region._.data, string>>;
	Expect<Equal<typeof accounts.$inferSelect, { id: string; region: string }>>;
	Expect<Equal<typeof accounts.$inferInsert, { id: string; region: string }>>;

	const config = getTableConfig(accounts);
	Expect<Equal<typeof config.locality, CockroachLocality | undefined>>;
}

{
	cockroachTable('accounts', {
		id: uuid().primaryKey(),
		regions: crdbRegion().array().notNull(),
	}, (t) => [
		// @ts-expect-error `as` takes a single region, not an array of regions
		locality.regionalByRow({ as: t.regions }),
	]);
}

{
	// Builders that take no column are valid without arguments
	cockroachTable('a', { id: uuid() }, () => [locality.global()]);
	cockroachTable('b', { id: uuid() }, () => [locality.regionalByTable()]);
	cockroachTable('c', { id: uuid() }, () => [locality.regionalByTable({ in: 'us-west1' })]);
	cockroachTable('d', { id: uuid() }, () => [locality.regionalByRow()]);
	cockroachTable('e', { id: uuid() }, () => [locality.regionalByRow({})]);
}

{
	// `as` accepts a nullable crdbRegion() column too: Cockroach, not Drizzle, rejects it at migrate time
	cockroachTable('accounts', { region: crdbRegion() }, (t) => [locality.regionalByRow({ as: t.region })]);
}

{
	cockroachTable('accounts', {
		id: uuid().primaryKey(),
		region: text().notNull(),
	}, (t) => [
		// @ts-expect-error `as` only accepts crdbRegion() columns
		locality.regionalByRow({ as: t.region }),
	]);
}

{
	const regionEnum = cockroachEnum('region', ['us-east1', 'us-west1']);

	cockroachTable('accounts', {
		id: uuid().primaryKey(),
		region: regionEnum().notNull(),
	}, (t) => [
		// @ts-expect-error `as` only accepts crdbRegion() columns, not a user enum
		locality.regionalByRow({ as: t.region }),
	]);
}

{
	// @ts-expect-error `in` is a region name
	locality.regionalByTable({ in: 1 });
}
