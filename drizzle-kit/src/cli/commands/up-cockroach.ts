import chalk from 'chalk';
import { readFileSync, writeFileSync } from 'fs';
import { latestVersion, upToV2 } from '../../dialects/cockroach/versions';
import { prepareOutFolder } from '../../utils/utils-node';
import { outputFormat } from '../context';

// Kit reads version-1 snapshots as they are, so this only rewrites them to the latest version on disk.
export const upCockroachHandler = (out: string): string[] => {
	const { snapshots } = prepareOutFolder(out);

	const upgraded: string[] = [];
	for (const path of snapshots) {
		const raw = JSON.parse(readFileSync(path).toString());
		if (raw.version === latestVersion) continue;

		const { snapshot } = upToV2(raw);
		if (snapshot.version !== latestVersion) continue;

		if (outputFormat() === 'text') console.log(`[${chalk.green('✓')}] ${path}`);
		writeFileSync(path, JSON.stringify(snapshot, null, 2));
		upgraded.push(path);
	}

	if (outputFormat() === 'text') console.log("Everything's fine 🐶🔥");

	return upgraded;
};
