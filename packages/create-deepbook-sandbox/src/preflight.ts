// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';

interface Failure {
	name: string;
	message: string;
}

interface Check {
	name: string;
	verify: () => Failure | null;
}

function simpleCheck(name: string, file: string, args: string[], hint: string): Check {
	return {
		name,
		verify: () => {
			try {
				execFileSync(file, args, { stdio: 'ignore' });
				return null;
			} catch {
				return { name, message: hint };
			}
		},
	};
}

function dockerCheck(): Check {
	const name = 'Docker';
	return {
		name,
		verify: () => {
			try {
				execFileSync('docker', ['--version'], { stdio: 'ignore' });
			} catch {
				return {
					name,
					message:
						'Docker is not installed. Install Docker Desktop: https://docs.docker.com/get-docker/',
				};
			}

			try {
				execFileSync('docker', ['info'], { stdio: 'ignore' });
			} catch {
				return {
					name,
					message:
						'Docker is installed but the daemon is not running. Start Docker Desktop and try again.',
				};
			}

			return null;
		},
	};
}

const checks: Check[] = [
	dockerCheck(),
	simpleCheck(
		'sui',
		'sui',
		['--version'],
		'Install the Sui CLI: https://docs.sui.io/guides/developer/getting-started/sui-install',
	),
	simpleCheck('pnpm', 'pnpm', ['--version'], 'Install pnpm: npm install -g pnpm'),
	simpleCheck('git', 'git', ['--version'], 'Install git: https://git-scm.com/downloads'),
];

export function runPreflight(): void {
	const failures: Failure[] = [];

	for (const check of checks) {
		const failure = check.verify();
		if (failure) {
			failures.push(failure);
		}
	}

	if (failures.length > 0) {
		console.error('\nMissing dependencies:\n');
		for (const f of failures) {
			console.error(`  ✗ ${f.name} — ${f.message}`);
		}
		console.error('');
		process.exit(1);
	}
}
