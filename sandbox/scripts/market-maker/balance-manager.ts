import type { SuiClient, SuiObjectChangeCreated } from "@mysten/sui/client";
import type { Keypair } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";

export interface BalanceManagerInfo {
    balanceManagerId: string;
    transactionDigest: string;
}

export class BalanceManagerService {
    constructor(
        private client: SuiClient,
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
            options: {
                showEffects: true,
                showObjectChanges: true,
            },
        });

        if (result.effects?.status.status !== "success") {
            throw new Error(
                `Failed to create BalanceManager: ${result.effects?.status.error || "Unknown error"}`,
            );
        }

        // Find the created BalanceManager object
        const bmCreated = result.objectChanges?.find(
            (obj): obj is SuiObjectChangeCreated =>
                obj.type === "created" &&
                obj.objectType.includes("::balance_manager::BalanceManager"),
        );

        if (!bmCreated) {
            throw new Error("BalanceManager object not found in transaction result");
        }

        return {
            balanceManagerId: bmCreated.objectId,
            transactionDigest: result.digest,
        };
    }

    /**
     * Deposit coins into a BalanceManager.
     * The coins must already be in the signer's wallet.
     */
    async deposit(balanceManagerId: string, coinType: string, amount: bigint): Promise<string> {
        const signerAddress = this.signer.getPublicKey().toSuiAddress();

        // Get coins of the specified type
        const coins = await this.client.getCoins({
            owner: signerAddress,
            coinType,
        });

        if (coins.data.length === 0) {
            throw new Error(`No coins of type ${coinType} found for ${signerAddress}`);
        }

        const tx = new Transaction();

        // For SUI, we need to handle gas coin specially
        const isSui = coinType === "0x2::sui::SUI";

        let coinToDeposit;
        if (isSui) {
            // Split from gas coin
            coinToDeposit = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
        } else {
            // For other coins, merge if needed and split
            const coinIds = coins.data.map((c) => c.coinObjectId);
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
            options: {
                showEffects: true,
            },
        });

        if (result.effects?.status.status !== "success") {
            throw new Error(
                `Failed to deposit: ${result.effects?.status.error || "Unknown error"}`,
            );
        }

        return result.digest;
    }

    /**
     * Get the balance of a specific coin type in a BalanceManager.
     */
    async getBalance(balanceManagerId: string, coinType: string): Promise<bigint> {
        // Use devInspect to call balance_manager::balance
        const tx = new Transaction();
        tx.moveCall({
            target: `${this.packageId}::balance_manager::balance`,
            typeArguments: [coinType],
            arguments: [tx.object(balanceManagerId)],
        });

        const result = await this.client.devInspectTransactionBlock({
            transactionBlock: tx,
            sender: this.signer.getPublicKey().toSuiAddress(),
        });

        if (result.effects.status.status !== "success") {
            return 0n;
        }

        // Parse the return value (u64)
        const returnValues = result.results?.[0]?.returnValues;
        if (!returnValues || returnValues.length === 0) {
            return 0n;
        }

        const [bytes] = returnValues[0];
        // u64 is 8 bytes, little-endian
        let value = 0n;
        for (let i = 0; i < 8; i++) {
            value |= BigInt(bytes[i]) << BigInt(i * 8);
        }
        return value;
    }
}
