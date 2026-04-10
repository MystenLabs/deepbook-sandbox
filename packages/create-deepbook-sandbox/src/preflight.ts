// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';

interface Check {
	name: string;
	file: string;
	args: string[];
	hint: string;
}

const checks: Check[] = [
	{
		name: 'Docker',
		file: 'docker',
		args: ['info'],
		hint: 'Install Docker Desktop: https://docs.docker.com/get-docker/',
	},
	{
		name: 'sui',
		file: 'sui',
		args: ['--version'],
		hint: 'Install the Sui CLI: https://docs.sui.io/guides/developer/getting-started/sui-install',
	},
	{
		name: 'pnpm',
		file: 'pnpm',
		args: ['--version'],
		hint: 'Install pnpm: npm install -g pnpm',
	},
	{
		name: 'git',
		file: 'git',
		args: ['--version'],
		hint: 'Install git: https://git-scm.com/downloads',
	},
];

export function runPreflight(): void {
	const failures: Check[] = [];

	for (const check of checks) {
		try {
			execFileSync(check.file, check.args, { stdio: 'ignore' });
		} catch {
			failures.push(check);
		}
	}

	if (failures.length > 0) {
		console.error('\nMissing dependencies:\n');
		for (const f of failures) {
			console.error(`  ✗ ${f.name} — ${f.hint}`);
		}
		console.error('');
		process.exit(1);
	}
}
