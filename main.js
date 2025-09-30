import { app, BrowserWindow, ipcMain, dialog, screen, shell } from "electron";
import { spawn } from "child_process";
import { readFile, writeFile, readdir, stat, copyFile, mkdir, chmod } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let win = null;
let child = null;
let extractedEmulatorPath = null;

const COMMAND_TIMEOUT_MS = 2000;
const pendingCommandQueue = [];

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
    }, COMMAND_TIMEOUT_MS);
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

    if (entry.hadStdErr) {
        const errorMessage = output.length > 0 ? output : "Command reported errors";
        entry.resolve({ ok: false, error: errorMessage, output, timedOut });
        return;
    }

    entry.resolve({ ok: true, output, timedOut });
}

function flushPendingCommands({ errorMessage = null, exitCode = null } = {}) {
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

async function extractEmulatorIfNeeded() {
    if (!app.isPackaged) {
        // In development, use the emulator directly
        return path.join(__dirname, "obj", "emulator");
    }

    // In packaged app, use the unpacked binary directly
    // app.getAppPath() returns path to app.asar, so get parent directory for app.asar.unpacked
    const resourcesPath = path.dirname(app.getAppPath());
    const unpackedEmulator = path.join(resourcesPath, "app.asar.unpacked", "obj", "emulator");

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

        const sourceEmulator = path.join(app.getAppPath(), "obj", "emulator");
        const targetEmulator = path.join(tempDir, "emulator");

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
            webSecurity: false, // Allow module loading
        },
    });

    // Maximize on ultra-wide screens
    if (screenWidth >= 2560) {
        win.maximize();
    }

    win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
    createWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("pick-asm", async () => {
    const res = await dialog.showOpenDialog(win, {
        title: "Pick RISC-V assembly (.s)",
        properties: ["openFile"],
        filters: [{ name: "Assembly", extensions: ["s"] }],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
});

ipcMain.handle("build-emu", async () => {
    // Use app.getAppPath() for packaged apps, __dirname for development
    const appPath = app.isPackaged ? app.getAppPath() : __dirname;
    // Check if emulator executable already exists
    const exe = path.join(appPath, "obj", "emulator");
    const isPackaged = app.isPackaged;

    if (existsSync(exe)) {
        // In packaged app or emulator already built, skip compilation
        console.log("Emulator executable found, skipping compilation");
        return {
            code: 0,
            out:
                "✅ Emulator already compiled and ready to use.\n" +
                (isPackaged
                    ? "Build skipped in packaged application.\n"
                    : "Build not needed - emulator already exists.\n"),
        };
    }

    // If packaged but no emulator found, that's an error
    if (isPackaged) {
        const error =
            "❌ Emulator executable not found in packaged application. This is a packaging error.";
        console.error(error);
        return {
            code: 1,
            out: error + "\nThe application should include a pre-compiled emulator binary.\n",
        };
    }

    // Only try to compile if in development environment
    return new Promise((resolve) => {
        console.log("Attempting to compile emulator in development mode...");
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
        child = spawn(exe, [absolutePath], { cwd: cwdPath });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");

        child.stdout.on("data", (chunk) => {
            const text = chunk.toString();
            handleEmulatorStreamChunk(text);
            console.log("Emulator stdout:", text);
            win.webContents.send("emu-output", text);
        });
        child.stderr.on("data", (chunk) => {
            const text = chunk.toString();
            handleEmulatorStreamChunk(text, { isError: true });
            console.log("Emulator stderr:", text);
            win.webContents.send("emu-output", text);
        });
        child.on("error", (error) => {
            console.error("Emulator process error:", error);
            flushPendingCommands({ errorMessage: error?.message || "Emulator process error" });
            win.webContents.send("emu-output", `Error: ${error.message}\n`);
            child = null;
        });
        child.on("close", (code) => {
            console.log(`Emulator process exited with code: ${code}`);
            if (code !== 0) {
                console.error(`Emulator failed with exit code ${code}`);
            }
            const errorMessage = code === 0 ? null : `Emulator exited with code ${code}`;
            flushPendingCommands({ errorMessage, exitCode: code });
            win.webContents.send("emu-output", `\n[process exited with code ${code}]\n`);
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
    if (!child) {
        return { ok: true, message: "No emulator process running" };
    }

    try {
        // First try to send quit command gracefully
        if (child.stdin && !child.stdin.destroyed) {
            child.stdin.write("q\n");
        }

        // Give it a moment to quit gracefully
        await new Promise((resolve) => setTimeout(resolve, 500));

        // If still running, force kill
        if (child && !child.killed) {
            child.kill("SIGTERM");

            // Give it another moment, then force kill
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (child && !child.killed) {
                child.kill("SIGKILL");
            }
        }

        child = null;
        return { ok: true, message: "Emulator stopped successfully" };
    } catch (error) {
        console.error("Error stopping emulator:", error);
        // Force cleanup even if there was an error
        if (child) {
            try {
                child.kill("SIGKILL");
            } catch {}
            child = null;
        }
        return { ok: false, error: error.message };
    }
});

ipcMain.handle("read-file", async (_evt, filePath) => {
    try {
        // Use app.getAppPath() for packaged apps, __dirname for development
        const appPath = app.isPackaged ? app.getAppPath() : __dirname;
        // Resolve relative paths from the app directory
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(appPath, filePath);

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
        // Use app.getAppPath() for packaged apps, __dirname for development
        const appPath = app.isPackaged ? app.getAppPath() : __dirname;
        // Resolve relative paths from the app directory
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(appPath, filePath);
        await writeFile(resolvedPath, content, "utf8");
        return { ok: true };
    } catch (error) {
        console.error("Failed to save file:", error);
        throw error;
    }
});

ipcMain.handle("new-file", async (_evt, defaultName = "untitled.s", content = "") => {
    const res = await dialog.showSaveDialog(win, {
        title: "Create new RISC-V assembly (.s)",
        defaultPath: defaultName,
        buttonLabel: "Create",
        filters: [{ name: "Assembly", extensions: ["s"] }],
        properties: [],
    });
    if (res.canceled || !res.filePath) return null;
    const filePath = res.filePath;
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
    return dir;
});

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
        } else if (ent.isFile() && ent.name.toLowerCase().endsWith(".s")) {
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
        const tree = await buildFileTree(base);
        return tree;
    } catch (e) {
        console.error("Failed to list files:", e);
        return [];
    }
});

ipcMain.handle("open-path", async (_evt, p) => {
    try {
        if (!p) return { ok: false, error: "No path" };
        await shell.openPath(p);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
});
