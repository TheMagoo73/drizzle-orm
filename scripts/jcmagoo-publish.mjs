#!/usr/bin/env node
// Fork-only: publishes the built drizzle-orm and drizzle-kit as @jcmagoo/drizzle-orm and @jcmagoo/drizzle-kit,
// so the cockroach-locality work can be used before it lands upstream. Not for upstream PRs.
//
// Run after building both packages (pnpm turbo run build --filter drizzle-orm --filter drizzle-kit):
//   node scripts/jcmagoo-publish.mjs --suffix locality.<n> [--tag locality] [--dry-run]
//
// Each package's dist/package.json is renamed to @jcmagoo/<name> with version <upstream version>.<suffix>
// (e.g. 1.0.0-rc.5.locality.3, which sorts after 1.0.0-rc.5 and before 1.0.0-rc.6, so it satisfies
// drizzle-kit's `drizzle-orm >=1.0.0-rc.5` peer range). Consumers alias the packages back to their real names:
//   "drizzle-orm": "npm:@jcmagoo/drizzle-orm@locality", "drizzle-kit": "npm:@jcmagoo/drizzle-kit@locality"
// so every `import 'drizzle-orm'`, including drizzle-kit's own, resolves to the fork.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const SCOPE = '@jcmagoo';
const REPO = 'git+https://github.com/TheMagoo73/drizzle-orm.git';
const PACKAGES = ['drizzle-orm', 'drizzle-kit'];

const { values } = parseArgs({
	options: {
		suffix: { type: 'string' },
		tag: { type: 'string', default: 'locality' },
		'dry-run': { type: 'boolean', default: false },
	},
});
if (!values.suffix || !/^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$/.test(values.suffix)) {
	console.error('Pass --suffix <semver prerelease identifiers>, e.g. --suffix locality.3');
	process.exit(1);
}

const root = path.resolve(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args, opts = {}) =>
	execFileSync(npm, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });

for (const name of PACKAGES) {
	const pkgDir = path.join(root, name);
	const dist = path.join(pkgDir, 'dist');
	if (!existsSync(dist)) throw new Error(`${name}/dist is missing: build it first`);

	// drizzle-orm's build writes dist/package.json; drizzle-kit's `pack` script copies it in, so do the same here.
	if (!existsSync(path.join(dist, 'package.json'))) {
		copyFileSync(path.join(pkgDir, 'package.json'), path.join(dist, 'package.json'));
	}
	if (!existsSync(path.join(dist, 'README.md')) && existsSync(path.join(pkgDir, 'README.md'))) {
		copyFileSync(path.join(pkgDir, 'README.md'), path.join(dist, 'README.md'));
	}

	const manifestPath = path.join(dist, 'package.json');
	const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
	if (pkg.name !== name && pkg.name !== `${SCOPE}/${name}`) {
		throw new Error(`${manifestPath} is for ${pkg.name}, expected ${name}`);
	}
	const upstreamVersion = pkg.name === name
		? pkg.version
		: JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
	pkg.name = `${SCOPE}/${name}`;
	pkg.version = `${upstreamVersion}.${values.suffix}`;
	pkg.repository = { type: 'git', url: REPO, directory: name };
	pkg.bugs = { url: 'https://github.com/TheMagoo73/drizzle-orm/issues' };
	// The copied scripts include `"publish": "npm publish package.tgz"`, which npm would run as a lifecycle hook.
	delete pkg.scripts;
	delete pkg.devDependencies;
	// Provenance needs GitHub Actions' OIDC token; outside it (a local --dry-run) npm would refuse to publish.
	if (process.env.GITHUB_ACTIONS !== 'true' && pkg.publishConfig) delete pkg.publishConfig.provenance;
	writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);

	const spec = `${pkg.name}@${pkg.version}`;
	let published = false;
	try {
		execFileSync(npm, ['view', spec, 'version'], { stdio: 'pipe', shell: process.platform === 'win32' });
		published = true;
	} catch {}
	if (published) {
		console.log(`${spec} is already on npm; skipping`);
		continue;
	}

	console.log(`Publishing ${spec} with dist-tag ${values.tag}`);
	run(['publish', '--access', 'public', '--tag', values.tag, ...(values['dry-run'] ? ['--dry-run'] : [])], {
		cwd: dist,
	});
}
