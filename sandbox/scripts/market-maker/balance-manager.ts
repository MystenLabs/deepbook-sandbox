import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Keypair } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag } from "@mysten/sui/utils";

export interface BalanceManagerInfo {
    balanceManagerId: string;
    transactionDigest: string;
}

export class BalanceManagerService {
    constructor(
        private client: SuiGrpcClient,
        private signer: Keypair,
        private packageId: string,
    ) {}

    /**
     * Create a new BalanceManager object.
     */
    async createBalanceManager(): Promise<BalanceManagerInfo> {
        const tx = new Transaction();

        // Call balance_manager::new to create a BalanceManager
        const bm = tx.moveCall({
            target: `${this.packageId}::balance_manager::new`,
            arguments: [],
        });

        // Transfer the BalanceManager to the signer
        tx.transferObjects([bm], this.signer.getPublicKey().toSuiAddress());

        const result = await this.client.signAndExecuteTransaction({
            transaction: tx,
            signer: this.signer,
            include: { effects: true, objectTypes: true },
        });

        if (result.$kind === "FailedTransaction") {
            throw new Error(
                `Failed to create BalanceManager: ${result.FailedTransaction.status.error || "Unknown error"}`,
            );
        }

        const txData = result.Transaction!;
        const objectTypes = txData.objectTypes ?? {};
        const changedObjects = txData.effects?.changedObjects ?? [];

        // Find the created BalanceManager object
        const bmCreated = changedObjects.find(
            (obj) =>
                obj.idOperation === "Created" &&
                (objectTypes[obj.objectId] ?? "").includes("::balance_manager::BalanceManager"),
        );

        if (!bmCreated) {
            throw new Error("BalanceManager object not found in transaction result");
        }

        return {
            balanceManagerId: bmCreated.objectId,
            transactionDigest: txData.digest,
        };
    }

    /**
     * Deposit coins into a BalanceManager.
     * The coins must already be in the signer's wallet.
     */
    async deposit(balanceManagerId: string, coinType: string, amount: bigint): Promise<string> {
        const signerAddress = this.signer.getPublicKey().toSuiAddress();

        // Get coins of the specified type
        const coins = await this.client.listCoins({
            owner: signerAddress,
            coinType,
        });

        if (coins.objects.length === 0) {
            throw new Error(`No coins of type ${coinType} found for ${signerAddress}`);
        }

        const tx = new Transaction();

        // For SUI, we need to handle gas coin specially
        const isSui = normalizeStructTag(coinType) === normalizeStructTag("0x2::sui::SUI");

        let coinToDeposit;
        if (isSui) {
            // Split from gas coin
            coinToDeposit = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
        } else {
            // For other coins, merge if needed and split
            const coinIds = coins.objects.map((c) => c.objectId);
            if (coinIds.length === 1) {
                const [coin] = coinIds;
                coinToDeposit = tx.splitCoins(tx.object(coin), [tx.pure.u64(amount)]);
            } else {
                // Merge all coins first
                const [first, ...rest] = coinIds;
                const primaryCoin = tx.object(first);
                if (rest.length > 0) {
                    tx.mergeCoins(
                        primaryCoin,
                        rest.map((id) => tx.object(id)),
                    );
                }
                coinToDeposit = tx.splitCoins(primaryCoin, [tx.pure.u64(amount)]);
            }
        }

        // Call balance_manager::deposit
        tx.moveCall({
            target: `${this.packageId}::balance_manager::deposit`,
            typeArguments: [coinType],
            arguments: [tx.object(balanceManagerId), coinToDeposit],
        });

        const result = await this.client.signAndExecuteTransaction({
            transaction: tx,
            signer: this.signer,
            include: { effects: true },
        });

        if (result.$kind === "FailedTransaction") {
            throw new Error(
                `Failed to deposit: ${result.FailedTransaction.status.error || "Unknown error"}`,
            );
        }

        return result.Transaction!.digest;
    }

    /**
     * Get the balance of a specific coin type in a BalanceManager.
     */
    async getBalance(balanceManagerId: string, coinType: string): Promise<bigint> {
        // Use simulateTransaction to call balance_manager::balance
        const tx = new Transaction();
        tx.setSender(this.signer.getPublicKey().toSuiAddress());
        tx.moveCall({
            target: `${this.packageId}::balance_manager::balance`,
            typeArguments: [coinType],
            arguments: [tx.object(balanceManagerId)],
        });

        const result = await this.client.simulateTransaction({
            transaction: tx,
            checksEnabled: false,
            include: { commandResults: true },
        });

        if (result.$kind === "FailedTransaction") {
            return 0n;
        }

        // Parse the return value (u64)
        const bcsBytes = result.commandResults?.[0]?.returnValues?.[0]?.bcs;
        if (!bcsBytes || bcsBytes.length === 0) {
            return 0n;
        }

        // u64 is 8 bytes, little-endian
        let value = 0n;
        for (let i = 0; i < 8; i++) {
            value |= BigInt(bcsBytes[i]) << BigInt(i * 8);
        }
        return value;
    }
}
