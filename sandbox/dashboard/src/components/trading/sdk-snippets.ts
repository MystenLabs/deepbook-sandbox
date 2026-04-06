/**
 * SDK code snippet templates for each trading action.
 *
 * Each function takes the actual parameters used and returns a code string
 * showing the exact DeepBook SDK call. Displayed in the UI so developers
 * can copy-paste or learn the SDK patterns.
 */

const DOCS_BASE = "https://docs.sui.io/standards/deepbookv3-sdk";

export const SDK_DOCS = {
    balanceManager: `${DOCS_BASE}/balance-manager`,
    orders: `${DOCS_BASE}/orders`,
    pools: `${DOCS_BASE}/pools`,
} as const;

/* eslint-disable no-irregular-whitespace */

export function depositSnippet(coinKey: string, amount: number): string {
    return [
        'import { Transaction } from "@mysten/sui/transactions";',
        "",
        "const tx = new Transaction();",
        "client.deepbook.balanceManager.depositIntoManager(",
        '    "MANAGER_1",  // balance manager key',
        `    "${coinKey}",         // coin key`,
        `    ${amount},          // amount in human units`,
        ")(tx);",
        "",
        "await client.core.signAndExecuteTransaction({",
        "    transaction: tx,",
        "    signer,",
        "    include: { effects: true },",
        "});",
    ].join("\n");
}

export function withdrawSnippet(coinKey: string, amount: number): string {
    return [
        'import { Transaction } from "@mysten/sui/transactions";',
        "",
        "const tx = new Transaction();",
        "client.deepbook.balanceManager.withdrawFromManager(",
        '    "MANAGER_1",       // balance manager key',
        `    "${coinKey}",              // coin key`,
        `    ${amount},               // amount in human units`,
        "    recipientAddress,  // recipient address",
        ")(tx);",
        "",
        "await client.core.signAndExecuteTransaction({",
        "    transaction: tx,",
        "    signer,",
        "    include: { effects: true },",
        "});",
    ].join("\n");
}

export function placeLimitOrderSnippet(
    poolKey: string,
    price: number,
    quantity: number,
    isBid: boolean,
): string {
    return [
        'import { OrderType, SelfMatchingOptions } from "@mysten/deepbook-v3";',
        'import { Transaction } from "@mysten/sui/transactions";',
        "",
        "const tx = new Transaction();",
        "client.deepbook.deepBook.placeLimitOrder({",
        `    poolKey: "${poolKey}",`,
        '    balanceManagerKey: "MANAGER_1",',
        "    clientOrderId: String(Date.now()),",
        `    price: ${price},`,
        `    quantity: ${quantity},`,
        `    isBid: ${isBid},`,
        "    orderType: OrderType.NO_RESTRICTION,",
        "    selfMatchingOption: SelfMatchingOptions.SELF_MATCHING_ALLOWED,",
        "    payWithDeep: false,",
        "})(tx);",
        "",
        "await client.core.signAndExecuteTransaction({",
        "    transaction: tx,",
        "    signer,",
        "    include: { effects: true },",
        "});",
    ].join("\n");
}

export function placeMarketOrderSnippet(poolKey: string, quantity: number, isBid: boolean): string {
    return [
        'import { SelfMatchingOptions } from "@mysten/deepbook-v3";',
        'import { Transaction } from "@mysten/sui/transactions";',
        "",
        "const tx = new Transaction();",
        "client.deepbook.deepBook.placeMarketOrder({",
        `    poolKey: "${poolKey}",`,
        '    balanceManagerKey: "MANAGER_1",',
        "    clientOrderId: String(Date.now()),",
        `    quantity: ${quantity},`,
        `    isBid: ${isBid},`,
        "    selfMatchingOption: SelfMatchingOptions.SELF_MATCHING_ALLOWED,",
        "    payWithDeep: false,",
        "})(tx);",
        "",
        "await client.core.signAndExecuteTransaction({",
        "    transaction: tx,",
        "    signer,",
        "    include: { effects: true },",
        "});",
    ].join("\n");
}

export function cancelOrderSnippet(poolKey: string, orderId: string): string {
    return [
        'import { Transaction } from "@mysten/sui/transactions";',
        "",
        "const tx = new Transaction();",
        "client.deepbook.deepBook.cancelOrder(",
        `    "${poolKey}",`,
        '    "MANAGER_1",',
        `    "${orderId}",`,
        ")(tx);",
        "",
        "await client.core.signAndExecuteTransaction({",
        "    transaction: tx,",
        "    signer,",
        "    include: { effects: true },",
        "});",
    ].join("\n");
}

export function cancelAllOrdersSnippet(poolKey: string): string {
    return [
        'import { Transaction } from "@mysten/sui/transactions";',
        "",
        "const tx = new Transaction();",
        "client.deepbook.deepBook.cancelAllOrders(",
        `    "${poolKey}",`,
        '    "MANAGER_1",',
        ")(tx);",
        "",
        "await client.core.signAndExecuteTransaction({",
        "    transaction: tx,",
        "    signer,",
        "    include: { effects: true },",
        "});",
    ].join("\n");
}
