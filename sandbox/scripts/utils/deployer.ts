import { execFileSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import type { SuiClient } from '@mysten/sui/client';
import type { Keypair } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import type {
	SuiObjectChangeCreated,
	SuiObjectChangePublished,
	SuiTransactionBlockResponse,
} from '@mysten/sui/client';
import { getNetwork } from './config';

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

const PACKAGES_BASE = '../external/deepbook/packages';

export class MoveDeployer {
	private suiBinary: string;
	/** Backup of deepbook/Published.toml when removed for testnet (restored after deploy). */
	private deepbookPublishedTomlBackup: string | null = null;
	/** Backup of token/Move.lock when removed for testnet (restored after deploy). */
	private tokenMoveLockBackup: string | null = null;

	constructor(
		private client: SuiClient,
		private signer: Keypair,
	) {
		this.suiBinary = process.env.SUI_BINARY || 'sui';
	}

	async deployPackage(packagePath: string, packageName: string): Promise<DeploymentResult> {
		console.log(`    Building ${packageName}...`);

		// Build Move package (cwd must be package dir so local deps like ../token resolve)
		const resolvedPath = path.resolve(process.cwd(), packagePath);
		const command = getNetwork() === "localnet" ? [
			'move', 
			'build', 
			'--dump-bytecode-as-base64', 
			'--with-unpublished-dependencies',
			"-e", 
			"localnet", 
			'--path', 
			resolvedPath
		] : ['move', 'build', '--dump-bytecode-as-base64', '--with-unpublished-dependencies', '--path', resolvedPath];
		const buildResult = execFileSync(this.suiBinary, command, { encoding: 'utf-8' });

		const { modules, dependencies } = JSON.parse(buildResult);
		console.log(modules);
		console.log(dependencies);
		console.log(`    Publishing ${packageName}...`);

		// Create publish transaction
		const tx = new Transaction();
		const cap = tx.publish({
			modules,
			dependencies,
		});

		// Transfer upgrade capability to sender
		tx.transferObjects([cap], tx.pure.address(this.signer.getPublicKey().toSuiAddress()));

		// Execute transaction
		const result = await this.client.signAndExecuteTransaction({
			transaction: tx,
			signer: this.signer,
			options: {
				showEffects: true,
				showObjectChanges: true,
				showEvents: true,
			},
		});

		// Check for errors
		if (result.effects?.status.status !== 'success') {
			throw new Error(
				`Failed to publish ${packageName}: ${result.effects?.status.error || 'Unknown error'}`,
			);
		}

		// Extract package ID
		const published = result.objectChanges?.find(
			(obj): obj is SuiObjectChangePublished => obj.type === 'published',
		);

		if (!published) {
			throw new Error(`No package ID found for ${packageName}`);
		}

		const packageId = published.packageId;

		// Extract created objects
		const createdObjects = result.objectChanges?.filter(
			(obj): obj is SuiObjectChangeCreated => obj.type === 'created',
		) || [];

		console.log(`    ✅ ${packageName} deployed: ${packageId}`);

		return {
			packageId,
			createdObjects,
			transactionDigest: result.digest,
			result,
		};
	}

	async deployAll(): Promise<Map<string, DeploymentResult>> {
		const baseDir = PACKAGES_BASE;

		// Define deployment order with dependencies
		const packages: PackageInfo[] = [
			{ name: 'deepbook', path: `${baseDir}/deepbook`, deps: ['token'] },
		];

		const deployed = new Map<string, DeploymentResult>();

		for (const pkg of packages) {
			// Handle dependency resolution for deepbook package
			if (pkg.name === 'deepbook') {
				const chainId = await this.client.getChainIdentifier();
				this.patchMoveTOML(pkg, deployed, chainId);
			}

			try {
				const result = await this.deployPackage(pkg.path, pkg.name);
				deployed.set(pkg.name, result);

				// Wait a bit between deployments
				await new Promise((resolve) => setTimeout(resolve, 2000));
			} finally {
				// Restore original Move.toml
				if (pkg.name === 'deepbook') {
					this.restoreMoveTOML(pkg);
				}
			}
		}

		return deployed;
	}

	private patchMoveTOML(pkg: PackageInfo, deployed: Map<string, DeploymentResult>, chainId: string): void {
		const tomlPath = `${pkg.path}/Move.toml`;
		const original = readFileSync(tomlPath, 'utf-8');

		// Backup original
		writeFileSync(`${tomlPath}.backup`, original);

		let patched = original;

		// Replace git dependencies with local paths
		if (pkg.name === 'deepbook') {
			// Replace token git dependency with local path
			patched = patched.replace(
				/token\s*=\s*\{[^}]*git[^}]*\}/g,
				'token = { local = "../token" }',
			);
			if (getNetwork() === "localnet") {
				// Replace [addresses] with [environments] for deployment (restored from backup after)
				patched = patched.replace(
					/\[addresses\]\s*\n\s*deepbook\s*=\s*"0x0"\s*/,
					`[environments]\nlocalnet = "${chainId}"\n`,
				);
			} else {
				// Testnet: remove deepbook Published.toml and token Move.lock so dependencies resolve correctly (restored after deploy)
				this.removeDeepbookPublishedToml();
				this.removeTokenMoveLock();
			}
		}

		if (pkg.name === 'deepbook_margin') {
			// Replace token and deepbook dependencies
			patched = patched.replace(
				/token\s*=\s*\{[^}]*git[^}]*\}/g,
				'token = { local = "../token" }',
			);
			patched = patched.replace(
				/deepbook\s*=\s*\{[^}]*local[^}]*\}/g,
				'deepbook = { local = "../deepbook" }',
			);
		}
		writeFileSync(tomlPath, patched);
	}

	private restoreMoveTOML(pkg: PackageInfo): void {
		const tomlPath = `${pkg.path}/Move.toml`;
		const backupPath = `${tomlPath}.backup`;

		try {
			const backup = readFileSync(backupPath, 'utf-8');
			writeFileSync(tomlPath, backup);
			unlinkSync(backupPath);
		} catch (error) {
			console.warn(`    Warning: Could not restore Move.toml for ${pkg.name}`);
		}
		if (getNetwork() === "testnet") {
			this.restoreDeepbookPublishedToml();
			this.restoreTokenMoveLock();
		}
	}

	private getTokenMoveLockPath(): string {
		return path.resolve(process.cwd(), PACKAGES_BASE, 'token', 'Move.lock');
	}

	private removeTokenMoveLock(): void {
		const lockPath = this.getTokenMoveLockPath();
		if (!existsSync(lockPath)) return;
		this.tokenMoveLockBackup = readFileSync(lockPath, 'utf-8');
		unlinkSync(lockPath);
	}

	private restoreTokenMoveLock(): void {
		if (this.tokenMoveLockBackup === null) return;
		const lockPath = this.getTokenMoveLockPath();
		writeFileSync(lockPath, this.tokenMoveLockBackup);
		this.tokenMoveLockBackup = null;
	}

	private getDeepbookPublishedTomlPath(): string {
		return path.resolve(process.cwd(), PACKAGES_BASE, 'deepbook', 'Published.toml');
	}

	private removeDeepbookPublishedToml(): void {
		const publishedPath = this.getDeepbookPublishedTomlPath();
		if (!existsSync(publishedPath)) return;
		this.deepbookPublishedTomlBackup = readFileSync(publishedPath, 'utf-8');
		unlinkSync(publishedPath);
	}

	private restoreDeepbookPublishedToml(): void {
		if (this.deepbookPublishedTomlBackup === null) return;
		const publishedPath = this.getDeepbookPublishedTomlPath();
		writeFileSync(publishedPath, this.deepbookPublishedTomlBackup);
		this.deepbookPublishedTomlBackup = null;
	}
}
