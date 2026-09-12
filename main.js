import { app, BrowserWindow, ipcMain, dialog, screen, shell } from "electron";
import { spawn } from "child_process";
import { readFile, writeFile, readdir, stat, copyFile, mkdir, chmod, rm } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let win = null;
let child = null;
let extractedEmulatorPath = null;

// The renderer may only read/write inside the app directory and directories the
// user explicitly picked through a dialog.
const allowedRoots = new Set();

function appRootPath() {
    return app.isPackaged ? app.getAppPath() : __dirname;
}

function registerAllowedRoot(dir) {
    if (!dir) return;
    allowedRoots.add(path.resolve(dir));
}

function isPathAllowed(candidate) {
    const resolved = path.resolve(candidate);
    const roots = [appRootPath(), ...allowedRoots];
    if (app.isPackaged) {
        // Resources live next to app.asar in a packaged build.
        roots.push(path.dirname(appRootPath()));
    }

    return roots.some((root) => {
        const resolvedRoot = path.resolve(root);
        return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
    });
}

function resolveWorkspacePath(filePath) {
    const resolved = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(appRootPath(), filePath);

    if (!isPathAllowed(resolved)) {
        throw new Error(`Access denied outside the workspace: ${resolved}`);
    }
    return resolved;
}

function sendToRenderer(channel, payload) {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, payload);
    }
}

function killChildProcess() {
    if (!child) return;
    const proc = child;
    child = null;
    try {
        proc.kill("SIGKILL");
    } catch {}
}

// `proc.killed` only records that a signal was *sent*, not that the process
// died, so it can never gate an escalation. exitCode/signalCode are the fields
// that actually flip once the process is reaped.
function isProcessAlive(proc) {
    return Boolean(proc) && proc.exitCode === null && proc.signalCode === null;
}

function waitForExit(proc, timeoutMs) {
    if (!isProcessAlive(proc)) return Promise.resolve(true);

    return new Promise((resolve) => {
        let settled = false;
        const finish = (exited) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            proc.removeListener("exit", onExit);
            resolve(exited);
        };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        proc.once("exit", onExit);
    });
}

const COMMAND_TIMEOUT_MS = 2000;
// "c" and "s<n>" can legitimately produce no output for a long time; a short
// inactivity timeout would abandon them mid-run.
const EXECUTION_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const pendingCommandQueue = [];
// Output belonging to commands we already gave up on must not be credited to the
// next command's buffer.
let abandonedCommandCount = 0;
let drainBuffer = "";

function commandTimeoutFor(command) {
    const trimmed = String(command ?? "").trim();
    if (trimmed === "" || trimmed === "c" || /^s\d*$/i.test(trimmed)) {
        return EXECUTION_COMMAND_TIMEOUT_MS;
    }
    return COMMAND_TIMEOUT_MS;
}

function hasTrailingPrompt(buffer) {
    return buffer.endsWith(">> ");
}

function stripTrailingPrompt(text) {
    if (text.endsWith(">> ")) {
        let trimmed = text.slice(0, -3);
        if (trimmed.endsWith("\r\n")) {
            return trimmed.slice(0, -2);
        }
        if (trimmed.endsWith("\n") || trimmed.endsWith("\r")) {
            return trimmed.slice(0, -1);
        }
        return trimmed;
    }
    return text;
}

function resetPendingCommandTimeout(entry) {
    if (entry.timeout) {
        clearTimeout(entry.timeout);
    }
    entry.timeout = setTimeout(() => {
        finalizePendingCommand(entry, { timedOut: true });
    }, commandTimeoutFor(entry.command));
}

function removePendingEntry(entry) {
    const index = pendingCommandQueue.indexOf(entry);
    if (index !== -1) {
        pendingCommandQueue.splice(index, 1);
    }
}

function finalizePendingCommand(entry, { timedOut = false, error = null } = {}) {
    if (!entry || entry.completed) return;

    entry.completed = true;

    if (entry.timeout) {
        clearTimeout(entry.timeout);
        entry.timeout = null;
    }

    removePendingEntry(entry);

    let output = entry.buffer;
    if (!timedOut && !error) {
        output = stripTrailingPrompt(output);
    }
    output = output.trimEnd();

    if (error) {
        entry.resolve({ ok: false, error, output, timedOut });
        return;
    }

    if (timedOut) {
        // A timeout is a failure, not a truncated success: callers must not parse
        // the partial buffer as a register dump / memory dump / disassembly.
        abandonedCommandCount++;
        drainBuffer = "";
        entry.resolve({
            ok: false,
            error: `Command "${entry.command}" timed out`,
            output,
            timedOut: true,
        });
        return;
    }

    if (entry.hadStdErr) {
        const errorMessage = output.length > 0 ? output : "Command reported errors";
        entry.resolve({ ok: false, error: errorMessage, output, timedOut });
        return;
    }

    entry.resolve({ ok: true, output, timedOut });
}

function flushPendingCommands({ errorMessage = null, exitCode = null } = {}) {
    abandonedCommandCount = 0;
    drainBuffer = "";

    while (pendingCommandQueue.length > 0) {
        const entry = pendingCommandQueue.shift();
        if (!entry) continue;

        if (entry.timeout) {
            clearTimeout(entry.timeout);
            entry.timeout = null;
        }

        entry.completed = true;
        let output = stripTrailingPrompt(entry.buffer).trimEnd();

        if (errorMessage) {
            entry.resolve({ ok: false, error: errorMessage, output, exitCode, timedOut: false });
        } else if (entry.hadStdErr) {
            const errorMessage = output.length > 0 ? output : "Command reported errors";
            entry.resolve({ ok: false, error: errorMessage, output, exitCode, timedOut: false });
        } else {
            entry.resolve({ ok: true, output, exitCode, timedOut: false });
        }
    }
}

function handleEmulatorStreamChunk(chunk, { isError = false } = {}) {
    // Swallow the tail of every abandoned command before crediting anything again.
    while (abandonedCommandCount > 0 && chunk.length > 0) {
        drainBuffer += chunk;
        const promptIndex = drainBuffer.indexOf(">> ");
        if (promptIndex === -1) {
            return;
        }
        const consumed = promptIndex + 3;
        chunk = drainBuffer.slice(consumed);
        drainBuffer = "";
        abandonedCommandCount--;
    }

    if (abandonedCommandCount > 0 || chunk.length === 0) {
        return;
    }

    if (!pendingCommandQueue.length) {
        return;
    }

    const entry = pendingCommandQueue[0];
    if (!entry || entry.completed) {
        return;
    }

    entry.buffer += chunk;

    if (isError) {
        entry.hadStdErr = true;
    }

    resetPendingCommandTimeout(entry);

    if (hasTrailingPrompt(entry.buffer)) {
        finalizePendingCommand(entry);
    }
}

// The Windows cross-build produces emulator.exe; every other platform ships a
// bare "emulator". Resolve the name once so all four lookups below agree.
const EMULATOR_BIN = process.platform === "win32" ? "emulator.exe" : "emulator";

async function extractEmulatorIfNeeded() {
    if (!app.isPackaged) {
        // In development, use the emulator directly
        return path.join(__dirname, "obj", EMULATOR_BIN);
    }

    // In packaged app, use the unpacked binary directly
    // app.getAppPath() returns path to app.asar, so get parent directory for app.asar.unpacked
    const resourcesPath = path.dirname(app.getAppPath());
    const unpackedEmulator = path.join(resourcesPath, "app.asar.unpacked", "obj", EMULATOR_BIN);

    if (existsSync(unpackedEmulator)) {
        console.log(`Using unpacked emulator: ${unpackedEmulator}`);
        return unpackedEmulator;
    }

    // Fallback: extract from asar if unpacked version not available
    if (extractedEmulatorPath && existsSync(extractedEmulatorPath)) {
        return extractedEmulatorPath;
    }

    try {
        // Create temp directory for emulator
        const tempDir = path.join(os.tmpdir(), "riscv-emulator");
        if (!existsSync(tempDir)) {
            mkdirSync(tempDir, { recursive: true });
        }

        const sourceEmulator = path.join(app.getAppPath(), "obj", EMULATOR_BIN);
        const targetEmulator = path.join(tempDir, EMULATOR_BIN);

        // Copy emulator to temp location
        await copyFile(sourceEmulator, targetEmulator);

        // Make it executable
        await chmod(targetEmulator, 0o755);

        extractedEmulatorPath = targetEmulator;
        console.log(`Emulator extracted to: ${extractedEmulatorPath}`);
        return extractedEmulatorPath;
    } catch (error) {
        console.error("Failed to extract emulator:", error);
        throw error;
    }
}

function createWindow() {
    // Get screen dimensions
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

    // Calculate window size (90% of screen for good UX)
    const windowWidth = Math.min(Math.max(Math.round(screenWidth * 0.9), 1000), screenWidth);
    const windowHeight = Math.min(Math.max(Math.round(screenHeight * 0.9), 700), screenHeight);

    win = new BrowserWindow({
        width: windowWidth,
        height: windowHeight,
        minWidth: 800,
        minHeight: 600,
        center: true,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    // Maximize on ultra-wide screens
    if (screenWidth >= 2560) {
        win.maximize();
    }

    win.on("closed", () => {
        win = null;
        killChildProcess();
    });

    win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
    createWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    killChildProcess();
    if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
    killChildProcess();
});

ipcMain.handle("pick-asm", async () => {
    const res = await dialog.showOpenDialog(win, {
        title: "Open assembly or C source",
        // Single file only - bundles/packages stay navigable rather than selectable.
        properties: ["openFile", "treatPackageAsDirectory"],
        filters: [
            { name: "Assembly / C", extensions: ["s", "S", "asm", "c", "h"] },
            { name: "Assembly", extensions: ["s", "S", "asm"] },
            { name: "C", extensions: ["c", "h"] },
        ],
    });
    if (res.canceled || res.filePaths.length === 0) return null;

    const picked = res.filePaths[0];
    try {
        if ((await stat(picked)).isDirectory()) {
            return null;
        }
    } catch (e) {
        console.error("Failed to inspect picked path:", e);
        return null;
    }

    registerAllowedRoot(path.dirname(picked));
    return picked;
});

ipcMain.handle("build-emu", async () => {
    // Use app.getAppPath() for packaged apps, __dirname for development
    const appPath = app.isPackaged ? app.getAppPath() : __dirname;
    const exe = path.join(appPath, "obj", "emulator");
    const isPackaged = app.isPackaged;

    // A packaged app ships a prebuilt binary and has no toolchain; in development
    // always defer to the Makefile so an edited emulator.cpp actually takes effect.
    if (isPackaged) {
        if (existsSync(exe)) {
            return {
                code: 0,
                out: "✅ Emulator binary found.\nBuild skipped in packaged application.\n",
            };
        }
        const error =
            "❌ Emulator executable not found in packaged application. This is a packaging error.";
        console.error(error);
        return {
            code: 1,
            out: error + "\nThe application should include a pre-compiled emulator binary.\n",
        };
    }

    return new Promise((resolve) => {
        console.log("Running make...");
        // Use app.getAppPath() for packaged apps, __dirname for development
        const appPath = app.isPackaged ? app.getAppPath() : __dirname;
        // Run make in the current directory where Makefile is located
        const proc = spawn(process.platform === "win32" ? "make.exe" : "make", [], {
            cwd: appPath,
        });
        let out = "";

        proc.stdout.on("data", (d) => {
            out += d.toString();
        });

        proc.stderr.on("data", (d) => {
            out += d.toString();
        });

        proc.on("error", (error) => {
            console.error("Build process error:", error);
            out += `❌ Build process error: ${error.message}\n`;
            out += `This may happen if development tools (make, g++) are not available.\n`;
            out += `Please install the necessary build tools or use a pre-compiled version.\n`;
            resolve({ code: 1, out });
        });

        proc.on("close", (code) => {
            if (code === 0) {
                out = "✅ " + out + "\n🎉 Emulator compiled successfully!\n";
            } else {
                out = "❌ " + out + "\n💥 Emulator compilation failed!\n";
            }
            resolve({ code, out });
        });
    });
});

ipcMain.handle("run-emu", async (_evt, asmPath) => {
    if (child) return { ok: false, error: "Emulator already running" };

    try {
        // Extract emulator if needed (for packaged apps)
        const exe = await extractEmulatorIfNeeded();

        // Check if the executable exists
        if (!existsSync(exe)) {
            const error = `Emulator executable not found: ${exe}`;
            console.error("Emulator executable not found:", error);
            return { ok: false, error };
        }

        // For file resolution:
        // - In development: use __dirname
        // - In packaged app: use app.getAppPath() which points to app.asar
        //   (files inside asar are accessible via Electron's fs, but not by spawned processes)
        const appPath = app.isPackaged ? app.getAppPath() : __dirname;

        // Resolve assembly file path relative to app path if not absolute
        let absolutePath = path.isAbsolute(asmPath) ? asmPath : path.resolve(appPath, asmPath);

        // Check if the assembly file exists
        if (!existsSync(absolutePath)) {
            const error = `Assembly file not found: ${absolutePath}`;
            console.error("Assembly file not found:", error);
            return { ok: false, error };
        }

        // In packaged apps, the emulator (spawned process) can't read files inside asar
        // Extract to temp directory first
        if (app.isPackaged && absolutePath.includes('.asar')) {
            const tempDir = path.join(os.tmpdir(), "riscv-emulator-files");
            if (!existsSync(tempDir)) {
                mkdirSync(tempDir, { recursive: true });
            }

            const tempFilePath = path.join(tempDir, path.basename(absolutePath));
            const fileContent = await readFile(absolutePath, 'utf8');
            await writeFile(tempFilePath, fileContent, 'utf8');

            console.log(`Extracted ${absolutePath} to ${tempFilePath}`);
            absolutePath = tempFilePath;
        }

        console.log(`Starting emulator with file: ${asmPath}`);
        console.log(`Absolute path: ${absolutePath}`);
        console.log(`App path: ${appPath}`);
        console.log(`Executable path: ${exe}`);
        console.log(`File exists check (absolute): ${existsSync(absolutePath)}`);
        console.log(`Is packaged: ${app.isPackaged}`);

        // For cwd, we need an actual directory, not app.asar
        const cwdPath = app.isPackaged ? path.dirname(appPath) : appPath;
        const thisProc = spawn(exe, [absolutePath], { cwd: cwdPath });
        child = thisProc;
        thisProc.stdout.setEncoding("utf8");
        thisProc.stderr.setEncoding("utf8");

        thisProc.stdout.on("data", (chunk) => {
            if (child !== thisProc) return;
            const text = chunk.toString();
            handleEmulatorStreamChunk(text);
            sendToRenderer("emu-output", text);
        });
        thisProc.stderr.on("data", (chunk) => {
            if (child !== thisProc) return;
            const text = chunk.toString();
            handleEmulatorStreamChunk(text, { isError: true });
            sendToRenderer("emu-output", text);
        });
        thisProc.on("error", (error) => {
            console.error("Emulator process error:", error);
            // A dying process must never clear a newly spawned one.
            if (child !== thisProc) return;
            flushPendingCommands({ errorMessage: error?.message || "Emulator process error" });
            sendToRenderer("emu-output", `Error: ${error.message}\n`);
            child = null;
        });
        thisProc.on("close", (code, signal) => {
            console.log(`Emulator process exited with code: ${code}, signal: ${signal}`);
            if (child !== thisProc) return;
            // A signal death reports code === null; saying "code null" gives the
            // renderer nothing it can match on.
            const detail = code === null ? `signal ${signal}` : `code ${code}`;
            const errorMessage = code === 0 ? null : `Emulator exited with ${detail}`;
            flushPendingCommands({ errorMessage, exitCode: code });
            sendToRenderer("emu-output", `\n[process exited with ${detail}]\n`);
            child = null;
        });

        return { ok: true };
    } catch (error) {
        console.error("Failed to start emulator:", error);
        return { ok: false, error: error.message };
    }
});

ipcMain.handle("send-cmd", async (_evt, line) => {
    if (!child || child.killed || !child.stdin) {
        return { ok: false, error: "Not running" };
    }

    return new Promise((resolve) => {
        const entry = {
            command: line,
            buffer: "",
            hadStdErr: false,
            completed: false,
            timeout: null,
            resolve,
        };

        pendingCommandQueue.push(entry);
        resetPendingCommandTimeout(entry);

        const finalizeWithError = (message) => {
            finalizePendingCommand(entry, { error: message });
        };

        try {
            child.stdin.write(`${line}${os.EOL}`, (writeError) => {
                if (writeError) {
                    finalizeWithError(writeError.message || String(writeError));
                }
            });
        } catch (error) {
            finalizeWithError(error?.message || String(error));
        }
    });
});

ipcMain.handle("stop-emu", async () => {
    const proc = child;
    if (!proc) {
        return { ok: true, message: "No emulator process running" };
    }

    try {
        // Escalate only as far as needed, and wait for the process to actually
        // be reaped at each step rather than for a fixed delay.
        if (proc.stdin && !proc.stdin.destroyed) {
            proc.stdin.write("q\n");
        }
        let exited = await waitForExit(proc, 500);

        if (!exited) {
            proc.kill("SIGTERM");
            exited = await waitForExit(proc, 500);
        }

        if (!exited) {
            proc.kill("SIGKILL");
            exited = await waitForExit(proc, 1000);
        }

        flushPendingCommands({ errorMessage: "Emulator stopped" });

        if (!exited) {
            // Keep the handle: dropping it here would orphan a live process
            // with no way to reach it again, and "run-emu" must not pretend the
            // slot is free.
            const error = `Emulator process ${proc.pid} survived SIGKILL and is still running`;
            console.error(error);
            return { ok: false, error };
        }

        if (child === proc) child = null;
        return { ok: true, message: "Emulator stopped successfully" };
    } catch (error) {
        console.error("Error stopping emulator:", error);
        // Force cleanup even if there was an error
        killChildProcess();
        flushPendingCommands({ errorMessage: "Emulator stopped" });
        return { ok: false, error: error.message };
    }
});

ipcMain.handle("read-file", async (_evt, filePath) => {
    try {
        const resolvedPath = resolveWorkspacePath(filePath);

        // Check if path exists and is a file (not a directory)
        const stats = await stat(resolvedPath);
        if (stats.isDirectory()) {
            throw new Error(`Cannot read directory as file: ${resolvedPath}`);
        }

        const content = await readFile(resolvedPath, "utf8");
        return content;
    } catch (error) {
        console.error("Failed to read file:", error);
        throw error;
    }
});

ipcMain.handle("save-file", async (_evt, filePath, content) => {
    try {
        const resolvedPath = resolveWorkspacePath(filePath);
        await writeFile(resolvedPath, content, "utf8");
        return { ok: true };
    } catch (error) {
        console.error("Failed to save file:", error);
        throw error;
    }
});

ipcMain.handle("new-file", async (_evt, defaultName = "untitled.s", content = "") => {
    const res = await dialog.showSaveDialog(win, {
        title: "Create new assembly or C source",
        defaultPath: defaultName,
        buttonLabel: "Create",
        filters: [
            { name: "Assembly / C", extensions: ["s", "S", "asm", "c", "h"] },
            { name: "Assembly", extensions: ["s", "S", "asm"] },
            { name: "C", extensions: ["c", "h"] },
        ],
        properties: [],
    });
    if (res.canceled || !res.filePath) return null;
    const filePath = res.filePath;
    registerAllowedRoot(path.dirname(filePath));
    try {
        await writeFile(filePath, content ?? "", "utf8");
        return filePath;
    } catch (error) {
        console.error("Failed to create new file:", error);
        throw error;
    }
});

ipcMain.handle("pick-folder", async () => {
    const res = await dialog.showOpenDialog(win, {
        title: "Choose workspace folder",
        properties: ["openDirectory"],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const dir = res.filePaths[0];
    registerAllowedRoot(dir);
    return dir;
});

// Same set the open/save dialogs accept, so the workspace tree does not hide
// files the user can otherwise open.
const SOURCE_EXTENSIONS = [".s", ".asm", ".c", ".h"];

function isSourceFileName(name) {
    const lower = name.toLowerCase();
    return SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

async function buildFileTree(dir, relBase = null) {
    const base = relBase || dir;
    const entries = await readdir(dir, { withFileTypes: true });
    const tree = [];

    for (const ent of entries) {
        const full = path.join(dir, ent.name);

        if (ent.isDirectory()) {
            if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;

            const children = await buildFileTree(full, base);
            // Always include directories, even if empty or no .s files
            tree.push({
                path: full,
                name: ent.name,
                type: "directory",
                children: children,
                expanded: false,
            });
        } else if (ent.isFile() && isSourceFileName(ent.name)) {
            tree.push({
                path: full,
                name: ent.name,
                type: "file",
            });
        }
    }

    // Sort directories first, then files
    tree.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === "directory" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });

    return tree;
}

ipcMain.handle("list-s-files", async (_evt, dir) => {
    try {
        const base = path.resolve(dir);
        if (!isPathAllowed(base)) {
            console.error("Refusing to list files outside the workspace:", base);
            return [];
        }
        const tree = await buildFileTree(base);
        return tree;
    } catch (e) {
        console.error("Failed to list files:", e);
        return [];
    }
});

ipcMain.handle("list-examples", async () => {
    try {
        const dir = path.join(appRootPath(), "examples");
        const entries = await readdir(dir, { withFileTypes: true });
        const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));

        return [...names]
            .filter((name) => name.toLowerCase().endsWith(".s"))
            .sort((a, b) => a.localeCompare(b))
            .map((name) => {
                const cName = `${name.slice(0, -2)}.c`;
                return {
                    name,
                    assembly: `./examples/${name}`,
                    c: names.has(cName) ? `./examples/${cName}` : null,
                };
            });
    } catch (e) {
        console.error("Failed to list examples:", e);
        return [];
    }
});

// ---------------------------------------------------------------------------
// C -> RISC-V assembly
//
// clang emits standard rv32 assembly; this emulator accepts a subset of it.
// The rewrite below closes the gap: relocation syntax, unsupported pseudo
// instructions, section names, and the halt convention.
// ---------------------------------------------------------------------------

const CLANG_CANDIDATES = [
    "/opt/homebrew/opt/llvm/bin/clang",
    "/usr/local/opt/llvm/bin/clang",
    "clang",
];

const DROPPED_DIRECTIVES = new Set([
    ".attribute",
    ".file",
    ".ident",
    ".addrsig",
    ".addrsig_sym",
    ".type",
    ".size",
    ".option",
    ".cfi_startproc",
    ".cfi_endproc",
]);

const DATA_SECTION_PREFIXES = [".data", ".sdata", ".rodata", ".srodata", ".bss", ".sbss"];

// Pseudo-instructions clang emits that the emulator does not implement.
function expandPseudoInstruction(text) {
    const match = text.match(/^([a-z][a-z0-9.]*)\s+(.*)$/);
    if (!match) return text;

    const op = match[1];
    const a = match[2].split(/\s*,\s*/);

    switch (op) {
        case "blez": return `bge zero, ${a[0]}, ${a[1]}`;
        case "bgez": return `bge ${a[0]}, zero, ${a[1]}`;
        case "bltz": return `blt ${a[0]}, zero, ${a[1]}`;
        case "bgtz": return `blt zero, ${a[0]}, ${a[1]}`;
        case "bgtu": return `bltu ${a[1]}, ${a[0]}, ${a[2]}`;
        case "bleu": return `bgeu ${a[1]}, ${a[0]}, ${a[2]}`;
        case "seqz": return `sltiu ${a[0]}, ${a[1]}, 1`;
        case "snez": return `sltu ${a[0]}, zero, ${a[1]}`;
        case "sltz": return `slt ${a[0]}, ${a[1]}, zero`;
        case "sgtz": return `slt ${a[0]}, zero, ${a[1]}`;
        case "neg": return `sub ${a[0]}, zero, ${a[1]}`;
        case "not": return `xori ${a[0]}, ${a[1]}, -1`;
        case "sext.w": return `addi ${a[0]}, ${a[1]}, 0`;
        case "tail": return `j ${a[0]}`;
        default: return text;
    }
}

function rewriteCompilerAssembly(asm, sourceName) {
    const out = [
        `# Generated from ${sourceName} by clang, rewritten for this emulator.`,
        `# Edits here are overwritten the next time you generate.`,
        "",
        ".text",
        "_start:",
        "\tli sp, 0x10000",
        "\tcall main",
        "\thcf",
        "",
    ];

    for (const rawLine of asm.split("\n")) {
        const line = rawLine.replace(/#.*$/, "").trim();
        if (!line) continue;

        const first = line.split(/[\s,]+/)[0];
        if (DROPPED_DIRECTIVES.has(first)) continue;

        // Linkage aliases for merged globals ("inputs = .L_MergedGlobals+8").
        // The code addresses the merged block directly, so these can go.
        if (/^[A-Za-z_.$][\w.$]*\s*=/.test(line)) continue;

        // ".comm sym, size, align" declares zeroed storage; spell it out.
        const comm = line.match(/^\.l?comm\s+([\w.$]+)\s*,\s*(\d+)/);
        if (comm) {
            out.push(".data", `${comm[1]}:`, `\t.zero ${comm[2]}`);
            continue;
        }

        if (first === ".section") {
            const name = line.split(/[\s,]+/)[1] || "";
            out.push(DATA_SECTION_PREFIXES.some((p) => name.startsWith(p)) ? ".data" : ".text");
            continue;
        }
        if (first === ".text" || DATA_SECTION_PREFIXES.includes(first)) {
            out.push(first === ".text" ? ".text" : ".data");
            continue;
        }

        // The emulator's alignment directives take a single operand.
        if (first === ".p2align" || first === ".align" || first === ".balign") {
            out.push(`\t${first} ${line.split(/[\s,]+/)[1]}`);
            continue;
        }

        // lui rd, %hi(sym) [+ addi rd, rd, %lo(sym)] is just "la rd, sym" here.
        const hi = line.match(/^lui\s+(\w+),\s*%hi\((.+)\)$/);
        if (hi) {
            out.push(`\tla ${hi[1]}, ${hi[2]}`);
            continue;
        }
        const loAddi = line.match(/^addi\s+(\w+),\s*(\w+),\s*%lo\((.+)\)$/);
        if (loAddi) {
            if (loAddi[1] !== loAddi[2]) out.push(`\tmv ${loAddi[1]}, ${loAddi[2]}`);
            continue;
        }
        const loMem = line.match(/^(\w+)\s+(\w+),\s*%lo\((.+)\)\((\w+)\)$/);
        if (loMem) {
            out.push(`\t${loMem[1]} ${loMem[2]}, 0(${loMem[4]})`);
            continue;
        }

        const expanded = expandPseudoInstruction(line);

        // "L: j L" is how C spells a halt (for(;;);) - use the real instruction
        // so the program stops instead of spinning.
        const selfJump = expanded.match(/^j\s+(\S+)$/);
        if (selfJump && out[out.length - 1]?.trim() === `${selfJump[1]}:`) {
            out.push("\thcf");
            continue;
        }

        out.push(expanded.endsWith(":") ? expanded : `\t${expanded}`);
    }

    return out.join("\n") + "\n";
}

function runClang(clang, args) {
    return new Promise((resolve) => {
        const proc = spawn(clang, args);
        let stderr = "";
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.on("error", (e) => resolve({ code: -1, stderr: String(e) }));
        proc.on("close", (code) => resolve({ code, stderr }));
    });
}

ipcMain.handle("generate-asm", async (_evt, cPath) => {
    let tempOut = null;
    try {
        const resolved = resolveWorkspacePath(cPath);
        tempOut = path.join(os.tmpdir(), `rv32ide-${Date.now()}.s`);

        const args = [
            "--target=riscv32",
            "-march=rv32i",
            "-mabi=ilp32",
            "-S",
            "-O1",
            "-fno-pic",
            "-ffreestanding",
            "-fno-builtin",
            "-o",
            tempOut,
            resolved,
        ];

        let result = null;
        for (const clang of CLANG_CANDIDATES) {
            result = await runClang(clang, args);
            if (result.code !== -1) break;
        }

        if (!result || result.code === -1) {
            return {
                ok: false,
                error:
                    "No clang with a RISC-V target found. Install LLVM (brew install llvm) " +
                    "and try again.",
            };
        }
        if (result.code !== 0) {
            return { ok: false, error: result.stderr.trim() || `clang exited with ${result.code}` };
        }

        const generated = await readFile(tempOut, "utf8");
        return { ok: true, asm: rewriteCompilerAssembly(generated, path.basename(resolved)) };
    } catch (error) {
        return { ok: false, error: String(error.message || error) };
    } finally {
        if (tempOut) {
            try {
                await rm(tempOut, { force: true });
            } catch {}
        }
    }
});

ipcMain.handle("open-path", async (_evt, p) => {
    try {
        if (!p) return { ok: false, error: "No path" };
        const resolved = resolveWorkspacePath(p);
        await shell.openPath(resolved);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
});
