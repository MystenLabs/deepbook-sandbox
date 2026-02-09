import { execFileSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { SuiClient } from '@mysten/sui/client';
import type { Keypair } from '@mysten/sui/cryptography';
import type {
	SuiObjectChangeCreated,
	SuiTransactionBlockResponse,
} from '@mysten/sui/client';

const PACKAGES_BASE = '../external/deepbook/packages';

function getSandboxRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

export interface DeploymentResult {
	packageId: string;
	createdObjects: SuiObjectChangeCreated[];
	transactionDigest: string;
	result: SuiTransactionBlockResponse;
}

export interface PackageInfo {
	name: string;
	path: string;
	deps: string[];
}

/** Parse packageId, transactionDigest, and created objects from `sui client publish` output. */
function parsePublishOutput(output: string): {
	packageId: string;
	transactionDigest: string;
	createdObjects: SuiObjectChangeCreated[];
} {
	const packageIdMatch = output.match(/PackageID:\s*(0x[a-fA-F0-9]+)/);
	const packageId = packageIdMatch?.[1];
	if (!packageId) {
		throw new Error('Could not parse PackageID from sui client publish output');
	}

	const effectsDigestMatch = output.match(/Transaction Effects[\s\S]*?Digest:\s*([A-Za-z0-9]+)/);
	const transactionDigest = effectsDigestMatch?.[1];
	if (!transactionDigest) {
		throw new Error('Could not parse transaction Digest from sui client publish output');
	}

	const createdObjects: SuiObjectChangeCreated[] = [];
	const objectChangesSection = output.match(/Object Changes[\s\S]*?Created Objects:([\s\S]*?)(?=Mutated Objects:|Published Objects:|$)/)?.[1] ?? '';
	const objectIds = [...objectChangesSection.matchAll(/ObjectID:\s*(0x[a-fA-F0-9]+)/g)].map((m) => m[1]);
	const objectTypes = [...objectChangesSection.matchAll(/ObjectType:\s*(.+)$/gm)].map((m) =>
		m[1].replace(/\s*│\s*$/g, '').trim(),
	);
	for (let i = 0; i < objectIds.length && i < objectTypes.length; i++) {
		createdObjects.push({
			type: 'created',
			objectId: objectIds[i],
			objectType: objectTypes[i],
			owner: { Shared: { initial_shared_version: '' } },
		} as SuiObjectChangeCreated);
	}

	return { packageId, transactionDigest, createdObjects };
}

export class MoveDeployer {
	private suiBinary: string;

	constructor(
		private client: SuiClient,
		private signer: Keypair,
	) {
		this.suiBinary = process.env.SUI_BINARY || 'sui';
	}

	async deployPackage(packagePath: string, packageName: string): Promise<DeploymentResult> {
		console.log(`    Publishing ${packageName} (sui client publish)...`);

		const resolvedPath = path.resolve(process.cwd(), packagePath);
		let output: string;
		try {
			output = execFileSync(this.suiBinary, ['client', 'publish', resolvedPath], {
				encoding: 'utf-8',
				stdio: ['inherit', 'pipe', 'inherit'],
			}) as string;
		} catch (err: unknown) {
			const out = err && typeof err === 'object' && 'stdout' in err ? String((err as { stdout: unknown }).stdout) : '';
			throw new Error(
				`Failed to publish ${packageName}. ${out ? `Output: ${out.slice(-500)}` : String(err)}`,
			);
		}

		const { packageId, transactionDigest, createdObjects } = parsePublishOutput(output);

		console.log(`    ✅ ${packageName} deployed: ${packageId}`);

		const result: SuiTransactionBlockResponse = {
			digest: transactionDigest,
			effects: { status: { status: 'success' } },
			objectChanges: createdObjects,
		} as SuiTransactionBlockResponse;

		return {
			packageId,
			createdObjects,
			transactionDigest,
			result,
		};
	}

	async deployAll(): Promise<Map<string, DeploymentResult>> {
		const chainId = await this.client.getChainIdentifier();
		const sandboxRoot = getSandboxRoot();
		const pythPath = path.join(sandboxRoot, 'packages', 'pyth');

		const packages: PackageInfo[] = [
			{ name: 'token', path: `${PACKAGES_BASE}/token`, deps: [] },
			{ name: 'deepbook', path: `${PACKAGES_BASE}/deepbook`, deps: ['token'] },
			{ name: 'pyth', path: pythPath, deps: [] },
			{ name: 'deepbook_margin', path: `${PACKAGES_BASE}/deepbook_margin`, deps: ['token', 'deepbook', 'pyth'] },
			{ name: 'margin_liquidation', path: `${PACKAGES_BASE}/margin_liquidation`, deps: ['deepbook_margin'] },
		];

		const deployed = new Map<string, DeploymentResult>();
		const publishedTomlBackups = new Map<string, string>();
		const moveLockBackups = new Map<string, string>();

		const needsPublishedTomlRemoveRestore = ['deepbook', 'deepbook_margin', 'margin_liquidation'];

		for (const pkg of packages) {
			const needsMovePatch =
				pkg.name === 'token' ||
				pkg.name === 'deepbook' ||
				pkg.name === 'pyth' ||
				pkg.name === 'deepbook_margin' ||
				pkg.name === 'margin_liquidation';

			if (needsMovePatch) {
				this.patchMoveTOML(pkg, deployed, chainId);
			}

			if (pkg.name === 'token' || pkg.name === 'deepbook' || pkg.name === 'pyth' || pkg.name === 'deepbook_margin' || pkg.name === 'margin_liquidation') {
				this.backupMoveLock(pkg, moveLockBackups);
				this.removeMoveLock(pkg);
			}
			if (needsPublishedTomlRemoveRestore.includes(pkg.name)) {
				this.backupPublishedToml(pkg, publishedTomlBackups);
				this.removePublishedToml(pkg);
			}

			const result = await this.deployPackage(pkg.path, pkg.name);
			deployed.set(pkg.name, result);
			await new Promise((r) => setTimeout(r, 2000));
		}

		for (const pkg of packages) {
			if (
				pkg.name === 'token' ||
				pkg.name === 'deepbook' ||
				pkg.name === 'pyth' ||
				pkg.name === 'deepbook_margin' ||
				pkg.name === 'margin_liquidation'
			) {
				this.restoreMoveTOML(pkg);
			}
			if (pkg.name === 'token' || pkg.name === 'deepbook' || pkg.name === 'pyth' || pkg.name === 'deepbook_margin' || pkg.name === 'margin_liquidation') {
				this.restoreMoveLock(pkg, moveLockBackups);
			}
			if (needsPublishedTomlRemoveRestore.includes(pkg.name)) {
				this.restorePublishedToml(pkg, publishedTomlBackups);
			}
			if (pkg.name === 'pyth') {
				this.removePublishedToml(pkg);
			}
		}

		this.removeTokenPublishedToml();

		return deployed;
	}

	private patchMoveTOML(
		pkg: PackageInfo,
		deployed: Map<string, DeploymentResult>,
		chainId: string,
	): void {
		const tomlPath = path.join(path.resolve(process.cwd(), pkg.path), 'Move.toml');
		const original = readFileSync(tomlPath, 'utf-8');
		writeFileSync(`${tomlPath}.backup`, original);

		let patched = original;
		const envBlock = `[environments]\nlocalnet = "${chainId}"\n`;

		if (pkg.name === 'token') {
			patched = patched.replace(
				/\[addresses\]\s*\n\s*token\s*=\s*"0x0"\s*/,
				envBlock,
			);
		}

		if (pkg.name === 'deepbook') {
			patched = patched.replace(
				/token\s*=\s*\{[^}]*git[^}]*\}/g,
				'token = { local = "../token" }',
			);
			patched = patched.replace(
				/\[addresses\]\s*\n\s*deepbook\s*=\s*"0x0"\s*/,
				envBlock,
			);
		}

		if (pkg.name === 'deepbook_margin') {
			patched = patched.replace(
				/token\s*=\s*\{[^}]*git[^}]*\}/g,
				'token = { local = "../token" }',
			);
			patched = patched.replace(
				/deepbook\s*=\s*\{[^}]*local[^}]*\}/g,
				'deepbook = { local = "../deepbook" }',
			);
			patched = patched.replace(
				/Pyth\s*=\s*\{[^}]*git[^}]*\}/g,
				'pyth = { local = "../../../../sandbox/packages/pyth" }',
			);
			patched = patched.replace(
				/\[addresses\]\s*\n\s*deepbook_margin\s*=\s*"0x0"\s*/,
				envBlock,
			);
		}

		if (pkg.name === 'margin_liquidation') {
			patched = patched.replace(
				/deepbook_margin\s*=\s*\{\s*local\s*=\s*"\.\.\/deepbook_margin"\s*\}/,
				'deepbook_margin = { local = "../deepbook_margin" }\ndeepbook = { local = "../deepbook" }\npyth = { local = "../../../../sandbox/packages/pyth" }',
			);
			patched = patched.replace(
				/\[addresses\]\s*\n\s*margin_liquidation\s*=\s*"0x0"\s*/,
				envBlock,
			);
		}

		if (pkg.name === 'pyth') {
			patched = patched.replace(
				/localnet\s*=\s*"[^"]*"/,
				`localnet = "${chainId}"`,
			);
		}

		writeFileSync(tomlPath, patched);
	}

	private restoreMoveTOML(pkg: PackageInfo): void {
		const tomlPath = path.join(path.resolve(process.cwd(), pkg.path), 'Move.toml');
		const backupPath = `${tomlPath}.backup`;
		try {
			const backup = readFileSync(backupPath, 'utf-8');
			writeFileSync(tomlPath, backup);
			unlinkSync(backupPath);
		} catch (error) {
			console.warn(`    Warning: Could not restore Move.toml for ${pkg.name}`);
		}
	}

	private getTokenPath(): string {
		return path.resolve(process.cwd(), PACKAGES_BASE, 'token');
	}

	private getPackageDir(pkg: PackageInfo): string {
		return path.resolve(process.cwd(), pkg.path);
	}

	private removeTokenPublishedToml(): void {
		const publishedPath = path.join(this.getTokenPath(), 'Published.toml');
		if (existsSync(publishedPath)) {
			unlinkSync(publishedPath);
		}
	}

	private backupPublishedToml(pkg: PackageInfo, backups: Map<string, string>): void {
		const publishedPath = path.join(this.getPackageDir(pkg), 'Published.toml');
		if (existsSync(publishedPath)) {
			backups.set(pkg.name, readFileSync(publishedPath, 'utf-8'));
		}
	}

	private removePublishedToml(pkg: PackageInfo): void {
		const publishedPath = path.join(this.getPackageDir(pkg), 'Published.toml');
		if (existsSync(publishedPath)) {
			unlinkSync(publishedPath);
		}
	}

	private backupMoveLock(pkg: PackageInfo, backups: Map<string, string>): void {
		const lockPath = path.join(this.getPackageDir(pkg), 'Move.lock');
		if (existsSync(lockPath)) {
			backups.set(pkg.name, readFileSync(lockPath, 'utf-8'));
		}
	}

	private removeMoveLock(pkg: PackageInfo): void {
		const lockPath = path.join(this.getPackageDir(pkg), 'Move.lock');
		if (existsSync(lockPath)) {
			unlinkSync(lockPath);
		}
	}

	private restoreMoveLock(pkg: PackageInfo, backups: Map<string, string>): void {
		const content = backups.get(pkg.name);
		if (!content) return;
		const lockPath = path.join(this.getPackageDir(pkg), 'Move.lock');
		writeFileSync(lockPath, content);
		backups.delete(pkg.name);
	}

	private restorePublishedToml(pkg: PackageInfo, backups: Map<string, string>): void {
		const content = backups.get(pkg.name);
		if (!content) return;
		const publishedPath = path.join(this.getPackageDir(pkg), 'Published.toml');
		writeFileSync(publishedPath, content);
		backups.delete(pkg.name);
	}
}
