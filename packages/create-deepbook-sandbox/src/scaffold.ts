// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_URL = 'https://github.com/MystenLabs/deepbook-sandbox.git';

function getLatestTag(): string {
	const output = execFileSync('git', ['ls-remote', '--tags', '--sort=-v:refname', REPO_URL], {
		encoding: 'utf-8',
	});

	// Tags look like: <sha>\trefs/tags/v0.2.0
	// Skip ^{} entries (annotated tag dereferences)
	for (const line of output.trim().split('\n')) {
		const ref = line.split('\t')[1];
		if (ref && !ref.endsWith('^{}') && ref.startsWith('refs/tags/v')) {
			return ref.replace('refs/tags/', '');
		}
	}

	throw new Error('No release tags found in the repository.');
}

export function scaffold(targetDir: string): void {
	const fullPath = resolve(targetDir);

	if (existsSync(fullPath)) {
		console.error(`\nError: directory "${fullPath}" already exists.`);
		console.error('Pick a different name or remove it first.\n');
		process.exit(1);
	}

	const tag = getLatestTag();
	console.log(`\nCloning deepbook-sandbox@${tag} into ${fullPath}...\n`);
	execFileSync(
		'git',
		['clone', '--recurse-submodules', '--branch', tag, '--', REPO_URL, fullPath],
		{ stdio: 'inherit' },
	);
}
