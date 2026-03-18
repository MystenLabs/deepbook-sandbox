import { execFileSync } from "child_process";
import { existsSync, mkdirSync, renameSync, readFileSync, writeFileSync, createWriteStream } from "fs";
import https from "https";
import http from "http";
import { tmpdir } from "os";
import { join } from "path";

const REPO_OWNER = "MystenLabs";
const REPO_NAME = "deepbook-sandbox";

/**
 * Main scaffolding function — downloads, extracts, installs, and optionally deploys.
 */
export async function scaffold({ projectName, version, deploy, network }) {
    const dest = join(process.cwd(), projectName);

    if (existsSync(dest)) {
        throw new Error(`Directory "${projectName}" already exists.`);
    }

    console.log(`\n  Creating DeepBook sandbox in ./${projectName}\n`);

    // 1. Check prerequisites
    checkPrerequisites();

    // 2. Resolve version
    const tag = await resolveVersion(version);
    console.log(`  Downloading release ${tag}...`);

    // 3. Download tarball
    const tarPath = await downloadTarball(tag);

    // 4. Extract
    console.log("  Extracting...");
    const extractedDir = extractTarball(tarPath, dest, tag);

    // 5. Rename extracted directory to project name
    if (extractedDir !== dest) {
        renameSync(extractedDir, dest);
    }

    // 6. Setup .env
    console.log("  Configuring environment...");
    setupEnv(dest);

    // 7. Install dependencies
    console.log("  Installing dependencies...\n");
    installDeps(dest);

    // 8. Optionally deploy
    if (deploy) {
        console.log("\n  Deploying DeepBook...\n");
        deployAll(dest, network);
    }

    // 9. Print success
    printSuccess(projectName, deploy);
}

function checkPrerequisites() {
    // Node version
    const [major] = process.versions.node.split(".").map(Number);
    if (major < 18) {
        throw new Error(`Node.js 18+ required (current: ${process.versions.node}). Install from https://nodejs.org`);
    }

    // Docker
    try {
        execFileSync("docker", ["info"], { stdio: "pipe" });
    } catch {
        throw new Error(
            "Docker is not running. Install from https://docs.docker.com/get-docker/ and start Docker Desktop.",
        );
    }

    // pnpm
    try {
        execFileSync("pnpm", ["--version"], { stdio: "pipe" });
    } catch {
        throw new Error("pnpm is not installed. Run: npm install -g pnpm");
    }
}

/**
 * Resolve "latest" to the actual tag name via GitHub API.
 */
async function resolveVersion(version) {
    if (version !== "latest") return version;

    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
    try {
        const data = await fetchJson(url);
        return data.tag_name;
    } catch {
        // Fallback: try the default branch tarball
        return "main";
    }
}

/**
 * Download the repo tarball for a given tag/branch.
 */
async function downloadTarball(tag) {
    const url =
        tag === "main"
            ? `https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/main.tar.gz`
            : `https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/tags/${tag}.tar.gz`;

    const tarPath = join(tmpdir(), `deepbook-sandbox-${Date.now()}.tar.gz`);

    await downloadFile(url, tarPath);
    return tarPath;
}

/**
 * Extract the tarball. GitHub tarballs contain a single top-level directory
 * named `{repo}-{tag}/`. We extract to a temp location then return the path.
 */
function extractTarball(tarPath, dest, tag) {
    const parent = join(dest, "..");
    mkdirSync(parent, { recursive: true });

    execFileSync("tar", ["xzf", tarPath, "-C", parent], { stdio: "pipe" });

    // GitHub tarballs extract to repo-tag/ or repo-branch/
    const dirName = tag.startsWith("v") ? `${REPO_NAME}-${tag.slice(1)}` : `${REPO_NAME}-${tag}`;
    const extracted = join(parent, dirName);

    if (!existsSync(extracted)) {
        // Try without 'v' prefix stripping
        const altName = `${REPO_NAME}-${tag}`;
        const altPath = join(parent, altName);
        if (existsSync(altPath)) return altPath;
        throw new Error(`Expected extracted directory "${dirName}" or "${altName}" not found in ${parent}`);
    }

    return extracted;
}

/**
 * Copy .env.example to .env with architecture-specific SUI_TOOLS_IMAGE.
 */
function setupEnv(projectDir) {
    const sandboxDir = join(projectDir, "sandbox");
    const examplePath = join(sandboxDir, ".env.example");
    const envPath = join(sandboxDir, ".env");

    if (!existsSync(examplePath)) {
        // No .env.example — skip env setup
        return;
    }

    let content = readFileSync(examplePath, "utf-8");

    // Set architecture-appropriate Docker image
    const image =
        process.arch === "arm64" ? "mysten/sui-tools:compat-arm64" : "mysten/sui-tools:compat";

    content = content.replace(
        /^SUI_TOOLS_IMAGE=.*$/m,
        `SUI_TOOLS_IMAGE=${image}`,
    );

    writeFileSync(envPath, content);
}

/**
 * Install npm dependencies in the sandbox directory.
 */
function installDeps(projectDir) {
    const sandboxDir = join(projectDir, "sandbox");
    execFileSync("pnpm", ["install"], {
        cwd: sandboxDir,
        stdio: "inherit",
    });
}

/**
 * Run pnpm deploy-all in the sandbox directory.
 */
function deployAll(projectDir, network) {
    const sandboxDir = join(projectDir, "sandbox");
    const args = ["deploy-all"];

    execFileSync("pnpm", args, {
        cwd: sandboxDir,
        stdio: "inherit",
        env: { ...process.env, NETWORK: network },
    });
}

function printSuccess(projectName, deployed) {
    const next = deployed
        ? `  Your sandbox is running! Open http://localhost:5173`
        : `  cd ${projectName}/sandbox\n  pnpm deploy-all`;

    console.log(`
  Done! DeepBook sandbox created in ./${projectName}

  Next steps:
${next}

  Useful commands:
    pnpm deploy-all          Start localnet and deploy contracts
    pnpm deploy-all --quick  Same, but skip building Rust images
    pnpm down                Full teardown

  Docs: https://github.com/${REPO_OWNER}/${REPO_NAME}#readme
`);
}

// --- HTTP helpers (zero dependencies) ---

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const get = url.startsWith("https") ? https.get : http.get;
        get(url, { headers: { "User-Agent": "create-deepbook-sandbox" } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchJson(res.headers.location).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
            }
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
            res.on("error", reject);
        }).on("error", reject);
    });
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const get = url.startsWith("https") ? https.get : http.get;
        get(url, { headers: { "User-Agent": "create-deepbook-sandbox" } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadFile(res.headers.location, dest).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`Failed to download: HTTP ${res.statusCode}`));
            }
            const file = createWriteStream(dest);
            const onError = (err) => {
                file.destroy();
                res.destroy();
                reject(err);
            };
            res.pipe(file);
            file.on("finish", () => file.close(resolve));
            file.on("error", onError);
            res.on("error", onError);
        }).on("error", reject);
    });
}
