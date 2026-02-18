import ora, { type Ora } from "ora";
import pc from "picocolors";

// ─── TTY / CI Detection ────────────────────────────────────────────

const isTTY = process.stdout.isTTY === true;
const isCI = Boolean(process.env.CI);
const useSpinners = isTTY && !isCI;
const isVerbose = Boolean(process.env.VERBOSE || process.env.LOG_VERBOSE);

// ─── Color Helpers ─────────────────────────────────────────────────

export const c = {
    bold: (s: string) => pc.bold(s),
    dim: (s: string) => pc.dim(s),
    green: (s: string) => pc.green(s),
    red: (s: string) => pc.red(s),
    yellow: (s: string) => pc.yellow(s),
    cyan: (s: string) => pc.cyan(s),
    magenta: (s: string) => pc.magenta(s),
    gray: (s: string) => pc.gray(s),
};

// ─── Symbols (fallback to ASCII when not TTY) ──────────────────────

const symbols = {
    success: isTTY ? pc.green("✔") : "[OK]",
    error: isTTY ? pc.red("✖") : "[ERR]",
    warning: isTTY ? pc.yellow("⚠") : "[WARN]",
    info: isTTY ? pc.blue("ℹ") : "[INFO]",
    bullet: isTTY ? pc.dim("•") : "-",
};

// ─── Core Logger ────────────────────────────────────────────────────

let activeSpinner: Ora | null = null;

function stopSpinner(): void {
    if (activeSpinner?.isSpinning) {
        activeSpinner.stop();
    }
    activeSpinner = null;
}

/**
 * Boxed title header.
 */
export function banner(title: string): void {
    stopSpinner();
    const line = c.dim("─".repeat(50));
    console.log(`\n${line}`);
    console.log(`  ${c.bold(title)}`);
    console.log(`${line}\n`);
}

/**
 * Phase/section header — cyan bold text.
 */
export function phase(label: string): void {
    stopSpinner();
    console.log(`\n${c.cyan(c.bold(label))}`);
}

/**
 * Start a spinner for an in-progress async operation.
 */
export function spin(text: string): Ora {
    stopSpinner();
    activeSpinner = ora({
        text,
        indent: 2,
        stream: process.stdout,
        isEnabled: useSpinners,
    }).start();
    return activeSpinner;
}

/**
 * Checkmark + message. Finalizes active spinner if one exists.
 */
export function success(text: string): void {
    if (activeSpinner?.isSpinning) {
        activeSpinner.succeed(text);
        activeSpinner = null;
    } else {
        console.log(`  ${symbols.success} ${text}`);
    }
}

/**
 * Cross mark + message. Finalizes active spinner if one exists.
 */
export function fail(text: string): void {
    if (activeSpinner?.isSpinning) {
        activeSpinner.fail(text);
        activeSpinner = null;
    } else {
        console.error(`  ${symbols.error} ${text}`);
    }
}

/**
 * Warning symbol + message.
 */
export function warn(text: string): void {
    if (activeSpinner?.isSpinning) {
        activeSpinner.warn(text);
        activeSpinner = null;
    } else {
        console.warn(`  ${symbols.warning} ${text}`);
    }
}

/**
 * Info line (does NOT stop an active spinner).
 */
export function info(text: string): void {
    if (activeSpinner?.isSpinning) {
        activeSpinner.stop();
        console.log(`  ${symbols.info} ${text}`);
        activeSpinner.start();
    } else {
        console.log(`  ${symbols.info} ${text}`);
    }
}

/**
 * Dimmed indented sub-line — for config values, object IDs, etc.
 * Only shown when VERBOSE=1 or LOG_VERBOSE=1 is set.
 */
export function detail(text: string): void {
    if (!isVerbose) return;
    if (activeSpinner?.isSpinning) {
        activeSpinner.stop();
        console.log(`    ${c.dim(text)}`);
        activeSpinner.start();
    } else {
        console.log(`    ${c.dim(text)}`);
    }
}

/**
 * Bold label + value pair for summary lists.
 */
export function bullet(label: string, value: string): void {
    console.log(`  ${symbols.bullet} ${c.bold(label)}  ${value}`);
}

/**
 * Key-value summary block with title.
 */
export function summary(title: string, entries: Array<{ label: string; value: string }>): void {
    stopSpinner();
    console.log(`\n${c.green(c.bold(title))}\n`);
    const maxLabel = Math.max(...entries.map((e) => e.label.length));
    for (const { label, value } of entries) {
        console.log(`  ${c.bold(label.padEnd(maxLabel))}  ${value}`);
    }
    console.log();
}

// ─── Step Counter ───────────────────────────────────────────────────

let stepCount = 0;

export function resetSteps(): void {
    stepCount = 0;
}

/**
 * Auto-numbered step with spinner.
 */
export function step(text: string): Ora {
    stepCount++;
    return spin(`${c.bold(String(stepCount))}. ${text}`);
}

// ─── Loop Logger (long-running services) ────────────────────────────

/**
 * Timestamped log line for loop-based services (no spinner).
 */
export function loop(text: string): void {
    const ts = c.dim(new Date().toISOString());
    console.log(`${ts}  ${text}`);
}

/**
 * Indented loop sub-line. Only shown when VERBOSE=1 or LOG_VERBOSE=1 is set.
 */
export function loopDetail(text: string): void {
    if (!isVerbose) return;
    console.log(`  ${c.dim(text)}`);
}

export function loopSuccess(text: string): void {
    console.log(`  ${symbols.success} ${text}`);
}

export function loopError(text: string, error?: unknown): void {
    const msg = error ? (error instanceof Error ? error.message : String(error)) : "";
    if (text) {
        console.error(`  ${symbols.error} ${text}`);
        if (msg) console.error(`    ${c.dim(msg)}`);
    } else if (msg) {
        console.error(`  ${symbols.error} ${msg}`);
    }
}

// ─── Default Export ─────────────────────────────────────────────────

export const log = {
    banner,
    phase,
    spin,
    success,
    fail,
    warn,
    info,
    detail,
    bullet,
    summary,
    resetSteps,
    step,
    loop,
    loopDetail,
    loopSuccess,
    loopError,
    c,
    symbols,
};

export default log;
