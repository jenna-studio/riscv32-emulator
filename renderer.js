console.log("🚀 IDE Loading...");

window.__rendererBooted = true;

let currentEditor = null;
let asmPath = null;
let terminal = null;
let currentViewMode = "assembly";
let currentFiles = {
    assembly: null,
    c: null,
};
let breakpoints = new Set();
let monacoEditor = null;
let monacoModels = {
    assembly: null,
    c: null,
};
let monacoLoaderPromise = null;
let breakpointDecorations = [];
let suppressEditorChange = false;
let riscvLanguageRegistered = false;
let compileButtonDefaultHTML = null;

let ideState = {
    fileLoaded: false,
    emulatorRunning: false,
    editorDirty: false,
    cFileAvailable: false,
};

let currentWorkspaceFolder = null;

let previousRegisterValues = {};
let currentRegisterValues = {};
let instructionTrace = [];
let suppressTerminalOutput = false;
let conditionalBreakpoints = new Map();
let performanceCounters = {
    cycles: 0,
    instructions: 0,
    branches: 0,
    memAccess: 0,
};
let stepExecutionInProgress = false;

const fileMapping = {
    "graph.s": { assembly: "./example_questions/graph.s", c: "./example_questions/graph.c" },
    "reduction.s": {
        assembly: "./example_questions/reduction.s",
        c: "./example_questions/reduction.c",
    },
    "sort.s": { assembly: "./example_questions/sort.s", c: "./example_questions/sort.c" },
    "sudoku.s": { assembly: "./example_questions/sudoku.s", c: "./example_questions/sudoku.c" },
};

const RISCV_EXECUTABLE_MNEMONICS = new Set([
    // Arithmetic
    "add",
    "addi",
    "sub",
    "mul",
    "div",
    "rem",
    // Logical
    "and",
    "andi",
    "or",
    "ori",
    "xor",
    "xori",
    "sll",
    "slli",
    "srl",
    "srli",
    "sra",
    "srai",
    // Memory
    "lb",
    "lh",
    "lw",
    "lbu",
    "lhu",
    "sb",
    "sh",
    "sw",
    // Branch
    "beq",
    "bne",
    "blt",
    "bge",
    "bltu",
    "bgeu",
    // Jump and flow
    "jal",
    "jalr",
    "j",
    "call",
    "tail",
    "ret",
    // Compare / set
    "slt",
    "slti",
    "sltu",
    "sltiu",
    // System
    "ecall",
    "ebreak",
    "fence",
    // Pseudo ops
    "mv",
    "li",
    "la",
    "nop",
]);

let commandQueue = Promise.resolve();

function enqueueEmulatorCommand(command) {
    const runner = async () => {
        try {
            const result = await window.api.sendCmd(command);
            if (!result || typeof result.ok === "undefined") {
                return { ok: false, error: "Invalid emulator response" };
            }
            if (result.timedOut) {
                console.warn(`Command \"${command}\" timed out waiting for prompt`);
            }
            return result;
        } catch (error) {
            console.error(`Command \"${command}\" failed:`, error);
            return { ok: false, error: error?.message ?? String(error) };
        }
    };

    commandQueue = commandQueue.then(runner, runner);
    return commandQueue;
}

function normalizeRegisterValue(rawValue) {
    if (rawValue === null || rawValue === undefined) return "0";
    const text = String(rawValue).trim();
    if (!text) return "0";

    const isHex = /^-?0x[0-9a-fA-F]+$/.test(text);
    const numeric = Number.parseInt(text, isHex ? 16 : 10);
    if (!Number.isNaN(numeric)) {
        return (numeric >>> 0).toString(16);
    }

    const sanitized = text.replace(/[^0-9a-fA-F]/g, "");
    if (!sanitized) return "0";
    const parsed = Number.parseInt(sanitized, 16);
    if (Number.isNaN(parsed)) return "0";
    return (parsed >>> 0).toString(16);
}

function ingestRegisterDump(registerOutput) {
    if (!registerOutput) return { pc: null };

    console.log("🔍 Ingesting register dump, output length:", registerOutput.length);

    const regRegex = /(x(?:[0-2]?\d|3[01])|pc)\s*[:=]\s*([-+]?0x[0-9a-fA-F]+|[-+]?\d+)/gi;
    let match;
    let capturedPc = null;
    let registerCount = 0;

    while ((match = regRegex.exec(registerOutput))) {
        const name = match[1].toLowerCase();
        const normalized = normalizeRegisterValue(match[2]);
        registerCount++;

        if (name === "pc") {
            capturedPc = normalized;
            currentRegisterValues["pc"] = normalized;
        } else {
            currentRegisterValues[name] = normalized;
        }
    }

    console.log(`✅ Ingested ${registerCount} registers, PC:`, capturedPc);
    return { pc: capturedPc };
}

function showNotification(message, type = "info") {
    console.log(`[${type.toUpperCase()}] ${message}`);
    if (terminal) {
        const prefix = type === "error" ? "❌" : type === "success" ? "✅" : "ℹ️";
        terminal.writeln(`${prefix} ${message}`);
    }
}

function updateButtonStates() {
    const { fileLoaded, emulatorRunning, editorDirty, cFileAvailable } = ideState;
    const editorHasContent = currentEditor && currentEditor.getValue().length > 0;

    // Toolbar
    document.getElementById("compileAndLoad").disabled = !fileLoaded || emulatorRunning;
    document.getElementById("reload").disabled = !emulatorRunning;
    document.getElementById("stop").disabled = !emulatorRunning;

    // Editor bar
    document.getElementById("saveFile").disabled = !fileLoaded || !editorDirty;
    document.getElementById("toggleView").disabled = !cFileAvailable;
    document.getElementById("clearEditor").disabled = !editorHasContent;
    document.getElementById("formatCode").disabled = !fileLoaded;

    // Quickbar
    document.querySelectorAll(".quickbar .control-group").forEach((group) => {
        const labelNode = group.querySelector(".group-label");
        const label = labelNode ? labelNode.textContent : "";
        const controls = group.querySelectorAll("button, input");

        if (label === "Debug Control") {
            controls.forEach((control) => {
                const cmd = control.getAttribute("data-cmd");
                if (cmd === "s") {
                    control.disabled = !fileLoaded;
                } else if (cmd === "q") {
                    control.disabled = !emulatorRunning;
                } else {
                    control.disabled = !emulatorRunning;
                }
            });
            return;
        }

        let disable = false;
        if (["View", "Memory"].includes(label)) {
            disable = !emulatorRunning;
        } else if (["Breakpoints", "Navigation"].includes(label)) {
            disable = !fileLoaded;
        }
        controls.forEach((c) => (c.disabled = disable));
    });

    // Cmdbar
    document.getElementById("send").disabled = !emulatorRunning;
    document.getElementById("cmd").disabled = !emulatorRunning;
}

function initTerminal() {
    const terminalContainer = document.getElementById("terminalContainer");
    if (!terminalContainer) {
        console.error("❌ Terminal container not found!");
        return;
    }

    terminalContainer.innerHTML = "";
    terminalContainer.style.height = "100%";
    terminalContainer.style.display = "flex";
    terminalContainer.style.flexDirection = "column";

    const log = document.createElement("div");
    log.className = "terminal-log";
    terminalContainer.appendChild(log);

    let lineBuffer = "";

    const escapeHtml = (value) =>
        value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");

    const classifyLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return "info";
        if (/^>>/.test(trimmed)) return "command";

        // Build Error Improvements
        if (/(error|failed|cannot|fatal|❌|✖)/i.test(trimmed)) return "error";
        if (/(warn|warning|⚠)/i.test(trimmed)) return "warning";

        // Runtime Error Improvements
        if (/(syntax error|parse error|unexpected token)/i.test(trimmed)) return "syntax-error";
        if (/(invalid command|unknown command|command not found)/i.test(trimmed))
            return "invalid-command";
        if (/(breakpoint|bp set|bp del)/i.test(trimmed)) return "breakpoint";
        if (/(segmentation fault|segfault|access violation|memory error)/i.test(trimmed))
            return "segfault";
        if (/(javascript error|system error|uncaught)/i.test(trimmed)) return "system-error";

        if (/(success|passed|done|ok|✅|✓)/i.test(trimmed)) return "success";
        return "info";
    };

    const enhanceErrorMessage = (text, severity) => {
        let enhanced = text;

        // Add emojis based on severity
        switch (severity) {
            case "error":
                if (!enhanced.includes("🔴")) enhanced = "🔴 " + enhanced;
                break;
            case "warning":
                if (!enhanced.includes("🟡")) enhanced = "🟡 " + enhanced;
                break;
            case "syntax-error":
                if (!enhanced.includes("🔴")) enhanced = "🔴 Syntax Error: " + enhanced;
                break;
            case "invalid-command":
                if (!enhanced.includes("❌")) enhanced = "❌ Invalid Command: " + enhanced;
                break;
            case "breakpoint":
                if (!enhanced.includes("🔵")) enhanced = "🔵 " + enhanced;
                break;
            case "segfault":
                if (!enhanced.includes("🟠")) enhanced = "🟠 Memory Error: " + enhanced;
                break;
            case "system-error":
                if (!enhanced.includes("🟠")) enhanced = "🟠 System Error: " + enhanced;
                break;
            case "success":
                if (!enhanced.includes("✅")) enhanced = "✅ " + enhanced;
                break;
        }

        // Highlight file references (file.ext:line:column or file.ext:line)
        enhanced = enhanced.replace(
            /(\w+\.\w+):(\d+)(?::(\d+))?/g,
            '<span class="file-ref">📁 $1</span>:<span class="line-ref">$2</span>$3'
        );

        return enhanced;
    };

    const appendTokenizedContent = (element, text) => {
        const tokenRegex = /0x[0-9a-fA-F]+|-?\d+(?:\.\d+)?/g;
        let lastIndex = 0;
        let match;

        while ((match = tokenRegex.exec(text))) {
            if (match.index > lastIndex) {
                element.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            }

            const span = document.createElement("span");
            span.className = match[0].startsWith("0x") ? "term-hex" : "term-number";
            span.textContent = match[0];
            element.appendChild(span);
            lastIndex = match.index + match[0].length;
        }

        if (lastIndex < text.length) {
            element.appendChild(document.createTextNode(text.slice(lastIndex)));
        }
    };

    const renderLine = (content) => {
        const line = document.createElement("div");
        const severity = classifyLine(content);
        line.className = `terminal-line terminal-${severity}`;

        const commandMatch = content.match(/^(\s*)>>\s*(.*)$/);

        if (commandMatch) {
            const leading = commandMatch[1] || "";
            if (leading) {
                line.appendChild(document.createTextNode(leading));
            }

            const prompt = document.createElement("span");
            prompt.className = "term-prompt";
            prompt.textContent = ">>";
            line.appendChild(prompt);

            const remainder = commandMatch[2] ?? "";
            if (remainder) {
                line.appendChild(document.createTextNode(" "));
                const cmdSpan = document.createElement("span");
                cmdSpan.className = "term-command";
                appendTokenizedContent(cmdSpan, remainder);
                line.appendChild(cmdSpan);
            }
        } else if (content.trim().length === 0) {
            line.innerHTML = "&nbsp;";
        } else {
            // Enhance error messages with emojis and formatting
            const enhancedContent = enhanceErrorMessage(content, severity);

            if (enhancedContent.includes("<span")) {
                // Content has HTML formatting, use innerHTML
                line.innerHTML = enhancedContent;
            } else {
                // Safe text content, use tokenized approach
                const sanitized = escapeHtml(enhancedContent);
                const temp = document.createElement("div");
                temp.innerHTML = sanitized;
                appendTokenizedContent(line, temp.textContent || "");
            }
        }

        return line;
    };

    const appendText = (text) => {
        lineBuffer += text;
        const segments = lineBuffer.split(/\r?\n/);
        lineBuffer = segments.pop() ?? "";

        segments.forEach((segment) => {
            const lineElement = renderLine(segment);
            log.appendChild(lineElement);
        });

        log.scrollTop = log.scrollHeight;
    };

    terminal = {
        writeln: (text) => {
            const cleanText = text.replace(/\x1b\[[0-9;]*m/g, "");
            appendText(`${cleanText}\n`);
        },
        write: (text) => {
            const cleanText = text.replace(/\x1b\[[0-9;]*m/g, "");
            appendText(cleanText);
        },
        clear: () => {
            log.innerHTML = "";
            lineBuffer = "";
        },
    };

    // Add interactive terminal input line
    const inputLine = document.createElement("div");
    inputLine.className = "terminal-input-line";
    inputLine.style.cssText = `
        display: flex;
    align-items: center;
    padding: 4px 8px;
    background: #f9f5ff;
    border: 3px solid #c0f7df;
    font-family: Consolas, Monaco, "Courier New", monospace;
    font-size: 13px;
    color: #777;
    font-weight: 500;
    border-radius: 8px;
    margin-bottom: 8px;
    `;

    const prompt = document.createElement("span");
    prompt.textContent = ">> ";
    prompt.style.cssText = "color: #01bb01; margin-right: 4px;";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "terminal-input";
    input.style.cssText = `
        flex: 1;
    background: transparent !important;
    border: none !important;
    outline: none !important;
    color: #777;
    font-family: inherit;
    font-size: inherit;
    font-weight: 600;
    box-shadow: none !important;
    `;
    input.placeholder = "Type a command...";

    inputLine.appendChild(prompt);
    inputLine.appendChild(input);
    terminalContainer.appendChild(inputLine);

    // Command history
    let commandHistory = [];
    let historyIndex = -1;
    let currentCommand = "";

    // Handle keyboard events for terminal input
    input.addEventListener("keydown", async (e) => {
        switch (e.key) {
            case "Enter":
                e.preventDefault();
                const command = input.value.trim();
                if (command) {
                    // Add to history
                    commandHistory.push(command);
                    historyIndex = commandHistory.length;

                    // Display command in terminal
                    terminal.writeln(`>> ${command}`);

                    // Execute command
                    await sendCommand(command);

                    // Clear input
                    input.value = "";
                    currentCommand = "";
                }
                break;

            case "ArrowUp":
                e.preventDefault();
                if (historyIndex > 0) {
                    if (historyIndex === commandHistory.length) {
                        currentCommand = input.value;
                    }
                    historyIndex--;
                    input.value = commandHistory[historyIndex];
                }
                break;

            case "ArrowDown":
                e.preventDefault();
                if (historyIndex < commandHistory.length) {
                    historyIndex++;
                    if (historyIndex === commandHistory.length) {
                        input.value = currentCommand;
                    } else {
                        input.value = commandHistory[historyIndex];
                    }
                }
                break;

            case "Tab":
                e.preventDefault();
                // Simple tab completion for common commands
                const partial = input.value.toLowerCase();
                const commonCommands = ["s", "c", "r", "l", "m", "b", "q"];
                const matches = commonCommands.filter((cmd) => cmd.startsWith(partial));
                if (matches.length === 1) {
                    input.value = matches[0];
                } else if (matches.length > 1) {
                    terminal.writeln(`Possible completions: ${matches.join(", ")}`);
                }
                break;
        }
    });

    // Focus the input when terminal is clicked
    terminalContainer.addEventListener("click", () => {
        input.focus();
    });

    // Auto-focus the input initially
    setTimeout(() => input.focus(), 100);

    terminal.writeln("# RISC-V IDE Terminal");
    terminal.writeln("# Ready for emulation - Type commands directly or use the input field below");
    terminal.writeln("");
    console.log("✅ Terminal initialized with interactive input");
}

function getModelForMode(mode) {
    if (mode === "c") {
        return monacoModels.c;
    }
    return monacoModels.assembly;
}

function updateBreakpointDecorations() {
    if (!monacoEditor || !window.monaco) return;

    if (currentViewMode !== "assembly") {
        breakpointDecorations = monacoEditor.deltaDecorations(breakpointDecorations, []);
        return;
    }

    const monacoRef = window.monaco;
    const decorations = Array.from(breakpoints).map((line) => ({
        range: new monacoRef.Range(line, 1, line, 1),
        options: {
            isWholeLine: true,
            glyphMarginClassName: "codicon codicon-debug-breakpoint",
            glyphMarginHoverMessage: { value: `Breakpoint at line ${line}` },
        },
    }));

    breakpointDecorations = monacoEditor.deltaDecorations(breakpointDecorations, decorations);
}

function toggleBreakpoint(lineNumber) {
    if (breakpoints.has(lineNumber)) {
        breakpoints.delete(lineNumber);
        showNotification(`Breakpoint removed at line ${lineNumber}`, "info");
    } else {
        breakpoints.add(lineNumber);
        showNotification(`Breakpoint set at line ${lineNumber}`, "info");
    }
    updateBreakpointDecorations();
}

function setEditorView(mode) {
    if (!monacoEditor) return;
    const nextModel = getModelForMode(mode);
    if (!nextModel) return;

    suppressEditorChange = true;
    monacoEditor.setModel(nextModel);
    suppressEditorChange = false;

    currentViewMode = mode;
    updateBreakpointDecorations();
    updateButtonStates();
}

function setModelContent(mode, value, markClean = false) {
    const model = getModelForMode(mode);
    if (!model) return;

    suppressEditorChange = true;
    model.setValue(value ?? "");
    suppressEditorChange = false;

    currentFiles[mode] = model.getValue();
    if (markClean) {
        ideState.editorDirty = false;
        updateButtonStates();
    }

    if (currentViewMode === mode) {
        updateBreakpointDecorations();
    }
}

function registerRiscvLanguage(monacoInstance) {
    if (riscvLanguageRegistered) return;

    const riscvMonarch = {
        defaultToken: "",
        ignoreCase: true,
        keywords: [
            "lui",
            "auipc",
            "jal",
            "jalr",
            "beq",
            "bne",
            "blt",
            "bge",
            "bltu",
            "bgeu",
            "lb",
            "lh",
            "lw",
            "lbu",
            "lhu",
            "sb",
            "sh",
            "sw",
            "addi",
            "slti",
            "sltiu",
            "xori",
            "ori",
            "andi",
            "slli",
            "srli",
            "srai",
            "add",
            "sub",
            "sll",
            "slt",
            "sltu",
            "xor",
            "srl",
            "sra",
            "or",
            "and",
            "fence",
            "fence.i",
            "ecall",
            "ebreak",
            "csrrw",
            "csrrs",
            "csrrc",
            "csrrwi",
            "csrrsi",
            "csrrci",
            "mul",
            "mulh",
            "mulhsu",
            "mulhu",
            "div",
            "divu",
            "rem",
            "remu",
            "lr.w",
            "sc.w",
            "amoswap.w",
            "amoadd.w",
            "amoxor.w",
            "amoand.w",
            "amoor.w",
            "amomin.w",
            "amomax.w",
            "amominu.w",
            "amomaxu.w",
            "nop",
            "li",
            "mv",
            "la",
            "neg",
            "not",
            "seqz",
            "snez",
            "sltz",
            "sgtz",
            "beqz",
            "bnez",
            "blez",
            "bgez",
            "bltz",
            "bgtz",
            "j",
            "jr",
            "ret",
            ".text",
            ".data",
            ".bss",
            ".rodata",
            ".globl",
            ".global",
            ".section",
            ".align",
            ".byte",
            ".half",
            ".word",
            ".dword",
            ".string",
            ".asciz",
            ".ascii",
        ],
        registers: [
            "zero",
            "ra",
            "sp",
            "gp",
            "tp",
            "t0",
            "t1",
            "t2",
            "t3",
            "t4",
            "t5",
            "t6",
            "s0",
            "s1",
            "s2",
            "s3",
            "s4",
            "s5",
            "s6",
            "s7",
            "s8",
            "s9",
            "s10",
            "s11",
            "a0",
            "a1",
            "a2",
            "a3",
            "a4",
            "a5",
            "a6",
            "a7",
            "pc",
            "x0",
            "x1",
            "x2",
            "x3",
            "x4",
            "x5",
            "x6",
            "x7",
            "x8",
            "x9",
            "x10",
            "x11",
            "x12",
            "x13",
            "x14",
            "x15",
            "x16",
            "x17",
            "x18",
            "x19",
            "x20",
            "x21",
            "x22",
            "x23",
            "x24",
            "x25",
            "x26",
            "x27",
            "x28",
            "x29",
            "x30",
            "x31",
        ],
        tokenizer: {
            root: [
                [/[#;].*$/, "comment"],
                [/\/\/.*$/, "comment"],
                [/\/\*/, { token: "comment", next: "@comment" }],
                [/^\s*[.\w$@][\w.$@]*:/, "type.identifier"],
                [
                    /\.[a-zA-Z._][\w.]*/,
                    {
                        cases: {
                            "@keywords": "keyword.directive",
                            "@default": "keyword.directive",
                        },
                    },
                ],
                [
                    /[a-zA-Z_.][\w.]*/,
                    {
                        cases: {
                            "@keywords": "keyword",
                            "@registers": "variable.predefined",
                            "@default": "identifier",
                        },
                    },
                ],
                [
                    /%?(x(?:[12]?\d|3[01])|zero|ra|sp|gp|tp|t[0-6]|s(?:[0-9]|1[01])|a[0-7]|pc)\b/,
                    "variable.predefined",
                ],
                [/0[xX][0-9a-fA-F_]+/, "number.hex"],
                [/0[bB][01_]+/, "number.binary"],
                [/0[oO][0-7_]+/, "number.octal"],
                [/-?\d+/, "number"],
                [/'([^'\\]|\\.)'/, "string"],
                [/"/, { token: "string.quote", next: "@string" }],
                [/[,:()\[\]]/, "delimiter"],
                [/[+\-*/%&|^~!<>=.]+/, "operator"],
                [/\s+/, "white"],
            ],
            comment: [
                [/[^\/*]+/, "comment"],
                [/\*\//, "comment", "@pop"],
                [/[\/*]/, "comment"],
            ],
            string: [
                [/[^"\\]+/, "string"],
                [/\\./, "string.escape"],
                [/"/, { token: "string.quote", next: "@pop" }],
            ],
        },
    };

    const riscvLanguageConfig = {
        comments: {
            lineComment: "#",
            blockComment: ["/*", "*/"],
        },
        brackets: [
            ["[", "]"],
            ["(", ")"],
        ],
        autoClosingPairs: [
            { open: "(", close: ")" },
            { open: "[", close: "]" },
            { open: '"', close: '"' },
            { open: "'", close: "'" },
        ],
        surroundingPairs: [
            { open: "(", close: ")" },
            { open: "[", close: "]" },
            { open: '"', close: '"' },
            { open: "'", close: "'" },
        ],
    };

    monacoInstance.languages.register({ id: "riscv" });
    monacoInstance.languages.setMonarchTokensProvider("riscv", riscvMonarch);
    monacoInstance.languages.setLanguageConfiguration("riscv", riscvLanguageConfig);

    monacoInstance.languages.registerCompletionItemProvider("riscv", {
        triggerCharacters: [".", "x", "a", "s", "t", "r"],
        provideCompletionItems: () => {
            const mk = (label, kind) => ({
                label,
                kind,
                insertText: label,
            });

            const directives = riscvMonarch.keywords
                .filter((k) => k.startsWith("."))
                .map((d) => mk(d, monacoInstance.languages.CompletionItemKind.Keyword));
            const regs = riscvMonarch.registers.map((r) =>
                mk(r, monacoInstance.languages.CompletionItemKind.Variable)
            );

            return { suggestions: [...directives, ...regs] };
        },
    });

    riscvLanguageRegistered = true;
}

async function ensureMonaco() {
    if (monacoLoaderPromise) return monacoLoaderPromise;

    if (typeof require === "undefined" || !require) {
        throw new Error(
            "Monaco AMD loader not found. Make sure loader.min.js is included before renderer.js."
        );
    }

    monacoLoaderPromise = new Promise((resolve, reject) => {
        require(["vs/editor/editor.main"], () => {
            registerRiscvLanguage(window.monaco);
            resolve(window.monaco);
        }, reject);
    });

    return monacoLoaderPromise;
}

async function initEditor() {
    const monacoInstance = await ensureMonaco();
    const editorContainer = document.getElementById("editorContainer");
    if (!editorContainer) {
        console.error("❌ Editor container not found!");
        return;
    }

    editorContainer.innerHTML = "";

    const defaultAssembly =
        "# Enter your RISC-V assembly code here\n.globl _start\n_start:\n    # Your code here\n    nop";

    monacoInstance.editor.defineTheme("cotton-candy", {
        base: "vs",
        inherit: true,
        rules: [
            { token: "comment", foreground: "B0B0B0" },
            { token: "comment.todo", foreground: "F6C177" },
            { token: "keyword", foreground: "FF7CB0" },
            { token: "keyword.control", foreground: "FF7CB0" },
            { token: "keyword.directive", foreground: "0FB3D7" },
            { token: "keyword.operator", foreground: "E5C147" },
            { token: "meta", foreground: "9795F1" },
            { token: "variable", foreground: "15B058" },
            { token: "variable.predefined", foreground: "2DBA77" },
            { token: "variable.parameter", foreground: "FE90AF" },
            { token: "variable.other", foreground: "D8D7CB" },
            { token: "variable.language", foreground: "F181C4" },
            { token: "identifier", foreground: "3DC7B9" },
            { token: "identifier.constant", foreground: "BD93F9" },
            { token: "identifier.label", foreground: "8878FF" },
            { token: "type", foreground: "00B6CD" },
            { token: "type.identifier", foreground: "00B6CD" },
            { token: "storage.type", foreground: "00B6CD" },
            { token: "support.function", foreground: "3DC7B9" },
            { token: "support.type", foreground: "00B6CD" },
            { token: "support.variable", foreground: "75DFBB" },
            { token: "string", foreground: "8998F8" },
            { token: "string.escape", foreground: "FFAAE1" },
            { token: "string.invalid", foreground: "EB5BCB" },
            { token: "number", foreground: "B283F4" },
            { token: "number.hex", foreground: "A777EA" },
            { token: "number.octal", foreground: "A777EA" },
            { token: "number.binary", foreground: "A777EA" },
            { token: "number.float", foreground: "BD93F9" },
            { token: "operator", foreground: "9EA09C" },
            { token: "delimiter", foreground: "B0B0B0" },
            { token: "delimiter.bracket", foreground: "B0B0B0" },
            { token: "delimiter.parenthesis", foreground: "B0B0B0" },
            { token: "delimiter.square", foreground: "B0B0B0" },
            { token: "delimiter.angle", foreground: "B0B0B0" },
            { token: "invalid", foreground: "F0827F" },
        ],
        colors: {
            "editor.foreground": "#27212e",
            "editor.background": "#ffffff",
            "editorCursor.foreground": "#9795f1",
            "editor.lineHighlightBackground": "#ac79f820",
            "editorLineNumber.foreground": "#888",
            "editorLineNumber.activeForeground": "#9795f1",
            "editor.selectionBackground": "#EBC8FF46",
            "editor.inactiveSelectionBackground": "#8beffa42",
            "editorWhitespace.foreground": "#44475a",
            "editorIndentGuide.background": "#EBC8FF8F",
            "editorGutter.background": "#bfbfbf39",
            "editor.selectionHighlightBackground": "#EBC8FF8F",
            "editor.wordHighlightBackground": "#EBC8FF45",
            "editor.wordHighlightStrongBackground": "#EBC8FF6A",
            "scrollbarSlider.background": "#8beffa42",
            "scrollbarSlider.hoverBackground": "#5ae9f942",
            "scrollbarSlider.activeBackground": "#5ae9f942",
            "editorSuggestWidget.background": "#fff7fc",
            "editorSuggestWidget.border": "#f3b7e0",
            "editorSuggestWidget.foreground": "#7b68ee",
            "editorSuggestWidget.highlightForeground": "#ff69b4",
            "editorSuggestWidget.selectedBackground": "#fdd7ef",
            "editorSuggestWidget.selectedForeground": "#2e223f",
            "editorSuggestWidget.focusHighlightForeground": "#a855c1",
            "editorSuggestWidget.iconForeground": "#c084fc",
            "editorSuggestWidget.selectedIconForeground": "#7c3aed",
            "editorSuggestWidgetStatus.foreground": "#8e7ba5",
            "editorHoverWidget.foreground": "#493966",
            "editorHoverWidget.border": "#f3b7e0",
        },
    });

    monacoModels.assembly = monacoInstance.editor.createModel(defaultAssembly, "riscv");
    monacoModels.c = monacoInstance.editor.createModel("", "cpp");

    monacoEditor = monacoInstance.editor.create(editorContainer, {
        model: monacoModels.assembly,
        theme: "cotton-candy",
        automaticLayout: true,
        glyphMargin: true,
        lineNumbersMinChars: 1,
        lineDecorationsWidth: 4,
        minimap: { enabled: false },
        fontFamily: 'Menlo, ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        fontWeight: "bold",
        tabSize: 4,
        insertSpaces: true,
        renderWhitespace: "none",
        padding: { top: 12, bottom: 6, left: 10 },
        scrollbar: {
            vertical: "visible",
            horizontal: "visible",
            useShadows: false,
            verticalScrollbarSize: 14,
            horizontalScrollbarSize: 14,
            arrowSize: 11,
        },
    });

    monacoInstance.editor.setTheme("cotton-candy");

    currentViewMode = "assembly";
    currentFiles.assembly = defaultAssembly;
    currentFiles.c = "";

    currentEditor = {
        getValue: () => monacoEditor?.getModel()?.getValue() ?? "",
    };

    monacoEditor.onDidChangeModelContent(() => {
        if (suppressEditorChange) return;
        const value = monacoEditor.getModel()?.getValue() ?? "";
        currentFiles[currentViewMode] = value;
        ideState.editorDirty = true;
        updateButtonStates();
    });

    monacoEditor.onMouseDown((event) => {
        if (currentViewMode !== "assembly") return;
        const monacoRef = window.monaco;
        if (!monacoRef) return;

        if (event.target.type === monacoRef.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
            const lineNumber = event.target.position?.lineNumber;
            if (lineNumber) {
                toggleBreakpoint(lineNumber);
                event.event.preventDefault();
            }
        }
    });

    updateBreakpointDecorations();
    console.log("✅ Monaco editor initialized");
}

function toggleFileView() {
    const toggleBtn = document.getElementById("toggleView");
    if (toggleBtn.disabled) return;

    const editorTitle = document.getElementById("editorTitle");

    if (currentViewMode === "assembly") {
        if (!currentFiles.c) {
            showNotification("No C file available for the current file.", "info");
            return;
        }
        setEditorView("c");
        toggleBtn.innerHTML = '<i class="fas fa-exchange-alt"></i> Switch to Assembly';
        editorTitle.textContent = "C Editor";
    } else {
        if (!currentFiles.assembly) {
            showNotification("No assembly file available for the current file.", "info");
            return;
        }
        setEditorView("assembly");
        toggleBtn.innerHTML = '<i class="fas fa-exchange-alt"></i> Switch to C';
        editorTitle.textContent = "Assembly Editor";
    }
}

async function loadFile(filePath) {
    console.log(`🔄 Loading file: ${filePath}`);
    try {
        const content = await window.api.readFile(filePath);
        const fileName = filePath.split("/").pop();

        if (fileMapping[fileName]) {
            await loadFilePair(fileName);
        } else {
            if (monacoEditor) {
                asmPath = filePath;
                document.getElementById("asmLabel").textContent = fileName;

                const editorTitle = document.getElementById("editorTitle");

                // Reset emulator state for clean file switching
                await resetEmulatorState();

                // Set the asmPath for the new file
                asmPath = filePath;

                if (fileName.endsWith(".s")) {
                    setModelContent("assembly", content, true);
                    setModelContent("c", "");
                    setEditorView("assembly");
                    editorTitle.textContent = "Assembly Editor";
                    document.getElementById("toggleView").innerHTML =
                        '<i class="fas fa-exchange-alt"></i> Switch to C';
                    breakpoints.clear();
                    updateBreakpointDecorations();
                } else if (fileName.endsWith(".c")) {
                    setModelContent("c", content, true);
                    setModelContent("assembly", "");
                    setEditorView("c");
                    editorTitle.textContent = "C Editor";
                    document.getElementById("toggleView").innerHTML =
                        '<i class="fas fa-exchange-alt"></i> Switch to Assembly';
                    breakpoints.clear();
                    updateBreakpointDecorations();
                }

                ideState.fileLoaded = true;
                ideState.editorDirty = false;
                ideState.cFileAvailable = false;
                updateButtonStates();
                showNotification(`Loaded: ${fileName}`, "success");
            }
        }
    } catch (error) {
        showNotification(`Failed to load file: ${error.message}`, "error");
    }
}

async function saveFile() {
    if (document.getElementById("saveFile").disabled) return;
    if (!currentEditor || !asmPath) {
        showNotification("No file to save", "error");
        return;
    }
    try {
        const content = currentEditor.getValue();
        await window.api.saveFile(asmPath, content);
        ideState.editorDirty = false;
        updateButtonStates();
        showNotification(`Saved: ${asmPath ? asmPath.split("/").pop() : "file"}`, "success");
    } catch (error) {
        showNotification(`Failed to save file: ${error.message}`, "error");
    }
}

async function loadFilePair(fileName) {
    const mapping = fileMapping[fileName];
    if (!mapping) return;

    const editorTitle = document.getElementById("editorTitle");

    try {
        const assemblyContent = await window.api.readFile(mapping.assembly);
        const cContent = await window.api.readFile(mapping.c);

        // Reset emulator state for clean file switching
        await resetEmulatorState();

        asmPath = mapping.assembly;
        document.getElementById("asmLabel").textContent = fileName;

        if (monacoEditor) {
            setModelContent("assembly", assemblyContent, true);
            setModelContent("c", cContent, true);
            setEditorView("assembly");
            editorTitle.textContent = "Assembly Editor";
            document.getElementById("toggleView").innerHTML =
                '<i class="fas fa-exchange-alt"></i> Switch to C';
            breakpoints.clear();
            updateBreakpointDecorations();
        }

        ideState.fileLoaded = true;
        ideState.editorDirty = false;
        ideState.cFileAvailable = true;
        updateButtonStates();
        showNotification(`Loaded: ${fileName} with C source`, "success");
    } catch (error) {
        showNotification(`Failed to load file pair: ${error.message}`, "error");
        ideState.cFileAvailable = false;
        updateButtonStates();
    }
}

async function loadExampleFiles() {
    const examplesList = document.getElementById("examplesList");
    if (!examplesList) return;

    examplesList.innerHTML = "";

    // Always load hardcoded examples
    Object.keys(fileMapping).forEach((fileName) => {
        const item = document.createElement("div");
        item.className = "file-item";
        item.innerHTML = `<i class="fas fa-file-code"></i> ${fileName}`;
        item.style.cursor = "pointer";
        item.addEventListener("click", () => loadFilePair(fileName));
        examplesList.appendChild(item);
    });
    console.log("✅ Example files loaded");

    // Load workspace files if workspace is set
    if (currentWorkspaceFolder) {
        await loadWorkspaceFiles();
    }
}

async function loadWorkspaceFiles() {
    const workspaceList = document.getElementById("workspaceList");
    if (!workspaceList || !currentWorkspaceFolder) return;

    // Clear workspace list
    workspaceList.innerHTML = "";

    try {
        const fileTree = await window.api.listSFiles(currentWorkspaceFolder);

        function renderFileTree(files, container, depth = 0) {
            files.forEach((file) => {
                const item = document.createElement("div");
                item.style.paddingLeft = `${depth * 20}px`;

                if (file.type === "directory") {
                    item.className = "folder-item";
                    item.innerHTML = `<i class="fas fa-folder"></i> ${file.name}`;
                    item.style.cursor = "pointer";
                    item.style.fontWeight = "bold";

                    // Toggle folder expansion
                    item.addEventListener("click", () => {
                        const childContainer = item.nextElementSibling;
                        if (
                            childContainer &&
                            childContainer.classList.contains("folder-children")
                        ) {
                            const isVisible = childContainer.style.display !== "none";
                            childContainer.style.display = isVisible ? "none" : "block";
                            const icon = item.querySelector("i");
                            icon.className = isVisible ? "fas fa-folder" : "fas fa-folder-open";
                        }
                    });

                    container.appendChild(item);

                    // Create container for children
                    if (file.children && file.children.length > 0) {
                        const childContainer = document.createElement("div");
                        childContainer.className = "folder-children";
                        childContainer.style.display = "block";
                        container.appendChild(childContainer);
                        renderFileTree(file.children, childContainer, depth + 1);
                    }
                } else if (file.type === "file") {
                    item.className = "file-item";
                    item.innerHTML = `<i class="fas fa-file-code"></i> ${file.name}`;
                    item.style.cursor = "pointer";

                    item.addEventListener("click", async () => {
                        try {
                            await loadFile(file.path);
                            showNotification(`Loaded: ${file.name}`, "success");
                        } catch (error) {
                            showNotification(
                                `Failed to load ${file.name}: ${error.message}`,
                                "error"
                            );
                        }
                    });

                    container.appendChild(item);
                }
            });
        }

        renderFileTree(fileTree, workspaceList);
        console.log(`✅ Loaded ${fileTree.length} workspace files from ${currentWorkspaceFolder}`);
    } catch (error) {
        console.error("Failed to load workspace files:", error);
        showNotification(`Failed to load workspace files: ${error.message}`, "error");
    }
}

function clearWorkspaceFiles() {
    const workspaceList = document.getElementById("workspaceList");
    if (workspaceList) {
        workspaceList.innerHTML = "";
    }
}

function formatNumberByDisplayOption(value) {
    if (!value) return value;

    const formatSelect = document.getElementById("numberFormat");
    const format = formatSelect ? formatSelect.value : "hex";

    // Convert hex string to number if needed
    let num;
    if (typeof value === "string" && value.startsWith("0x")) {
        num = parseInt(value, 16);
    } else if (typeof value === "string") {
        num = parseInt(value, 16); // Assume hex if string
    } else {
        num = value;
    }

    if (isNaN(num)) return value;

    // Convert to unsigned 32-bit for proper display
    num = num >>> 0;

    switch (format) {
        case "dec":
            return num.toString(10);
        case "bin":
            // Show only lower 16 bits for better display in registers panel
            const lower16 = num & 0xffff;
            return "0b" + lower16.toString(2).padStart(16, "0");
        case "oct":
            return "0o" + num.toString(8);
        case "hex":
        default:
            return "0x" + num.toString(16).padStart(8, "0");
    }
}

function normalizeDebuggerCommand(command) {
    const trimmed = command.trim();
    if (!trimmed) return trimmed;

    const [firstToken, ...restTokens] = trimmed.split(/\s+/);
    const lowerFirst = firstToken.toLowerCase();
    const restOriginal = restTokens.join(" ");
    const restSuffix = restOriginal ? ` ${restOriginal}` : "";

    if (lowerFirst === "info" && restTokens[0]?.toLowerCase() === "registers") {
        return "r";
    }

    if (lowerFirst === "list") {
        return "l";
    }

    if (lowerFirst === "step" || lowerFirst === "stepi") {
        const count = restOriginal.trim();
        return count ? `s${count}` : "s";
    }

    if (lowerFirst === "continue" || lowerFirst === "run") {
        return "c";
    }

    if (/^s\d*$/i.test(trimmed)) {
        return trimmed.toLowerCase();
    }

    const simpleMaps = new Set(["c", "r", "l", "q", "m", "b"]);
    if (simpleMaps.has(lowerFirst)) {
        return lowerFirst + restSuffix;
    }

    return trimmed;
}

async function sendCommand(command) {
    try {
        // Handle special commands that don't go to emulator
        if (command === "quit" || command === "q") {
            // Trigger stop button functionality
            document.getElementById("stop").click();
            return;
        }

        const commandToSend = normalizeDebuggerCommand(command);
        const result = await enqueueEmulatorCommand(commandToSend);
        if (result.ok) {
            terminal.writeln(`>> ${command}`);

            // CPUlator-style command processing - sync all panels for execution commands
            const isStepCommand = /^s\d*$/i.test(commandToSend);
            if (commandToSend === "c" || commandToSend === "r" || isStepCommand) {
                // Use the comprehensive sync function for all execution commands
                await updateAfterExecution(commandToSend);

                // For step commands, also switch to registers panel to show changes
                // Keep data synchronized but don't auto-switch panels
                // User requested no automatic panel switching
            }

            // Handle register display commands
            if (commandToSend === "r") {
                // The output should be processed to update register display
                setTimeout(async () => {
                    const regResult = await enqueueEmulatorCommand("r");
                    if (regResult.ok) {
                        ingestRegisterDump(regResult.output);
                        updateRegistersFromCurrentValues();
                    }
                }, 100);
            }
        } else {
            // Display emulator errors with proper formatting
            terminal.writeln(`>> ${command}`);

            if (result.error) {
                if (
                    result.error.includes("Syntax error") ||
                    result.error.includes("syntax error")
                ) {
                    terminal.writeln(`🔴 Syntax Error: ${result.error}`);
                } else if (result.error.includes("Invalid") || result.error.includes("invalid")) {
                    terminal.writeln(`❌ Invalid Command: ${result.error}`);
                } else if (
                    result.error.includes("breakpoint") ||
                    result.error.includes("Breakpoint")
                ) {
                    terminal.writeln(`🔵 Breakpoint: ${result.error}`);
                } else if (
                    result.error.includes("segmentation") ||
                    result.error.includes("Segmentation")
                ) {
                    terminal.writeln(`🟠 Segmentation Fault: ${result.error}`);
                } else {
                    terminal.writeln(`⚠️  ${result.error}`);
                }
            } else {
                terminal.writeln(`❌ Command failed: ${command}`);
            }
        }
    } catch (error) {
        terminal.writeln(`🟠 System Error: ${error.message}`);
    }
}

function getCurrentPC() {
    // Extract PC from current register values
    return parseInt(currentRegisterValues["pc"] || "0", 16);
}

async function getCurrentInstruction() {
    try {
        // Get current program counter and instruction from emulator
        const result = await enqueueEmulatorCommand("info program");
        if (result.ok && result.output) {
            // Parse the output to extract current instruction
            const lines = result.output.split("\n");
            for (const line of lines) {
                // Look for instruction format like "Next: addi x1, x0, 10"
                if (line.includes("Next:")) {
                    const instruction = line.replace("Next:", "").trim();
                    if (instruction) return instruction;
                }
                // Also look for current PC instruction
                if (line.includes("inst:") && line.includes("pc:")) {
                    // Extract instruction from debug output
                    const parts = line.split("src line");
                    if (parts.length > 1) {
                        // Try to get the instruction from source
                        return extractInstructionFromDebug(line);
                    }
                }
            }
        }

        // Fallback: try to get instruction from current PC by reading source
        if (monacoEditor && currentRegisterValues["pc"]) {
            const currentLine = getCurrentSourceLine();
            if (currentLine) {
                return parseInstructionFromSource(currentLine);
            }
        }

        return "nop"; // Default fallback
    } catch (error) {
        console.warn("Failed to get current instruction:", error);
        return "nop";
    }
}

function extractInstructionFromDebug(debugLine) {
    // Extract instruction from debug output like "[inst: 1 pc: 0, src line 1]"
    try {
        const match = debugLine.match(/\[inst:\s*\d+\s+pc:\s*\d+.*src line\s*(\d+)\]/);
        if (match && monacoEditor) {
            const lineNumber = parseInt(match[1]);
            const model = monacoEditor.getModel();
            if (model && lineNumber > 0) {
                const lineContent = model.getLineContent(lineNumber);
                return parseInstructionFromSource(lineContent);
            }
        }
    } catch (error) {
        console.warn("Failed to extract instruction from debug:", error);
    }
    return "nop";
}

function getCurrentSourceLine() {
    try {
        if (!monacoEditor) return null;

        const model = monacoEditor.getModel();
        if (!model) return null;

        // Try to get current line from PC mapping
        // This would need actual PC to source line mapping from emulator
        const position = monacoEditor.getPosition();
        if (position) {
            return model.getLineContent(position.lineNumber);
        }

        return null;
    } catch (error) {
        console.warn("Failed to get current source line:", error);
        return null;
    }
}

function parseInstructionFromSource(sourceLine) {
    if (!sourceLine) return "nop";

    // Clean up the source line (remove comments, extra whitespace)
    let instruction = sourceLine.split("#")[0].trim(); // Remove comments
    instruction = instruction.split("//")[0].trim(); // Remove C++ style comments

    // Skip labels and directives
    if (instruction.endsWith(":") || instruction.startsWith(".")) {
        return "nop";
    }

    // Extract just the instruction part
    const parts = instruction.split(/\s+/);
    if (parts.length > 0 && parts[0]) {
        return instruction; // Return the full instruction
    }

    return "nop";
}

function updateBreakpointDisplay() {
    // Update breakpoint decorations in Monaco Editor
    if (monacoEditor && currentViewMode === "assembly") {
        updateBreakpointDecorations();
    }
}

// CPUlator-style quick commands
function addQuickCommands() {
    const quickCommands = [
        { cmd: "r", desc: "Show all registers" },
        { cmd: "l", desc: "Show source code" },
        { cmd: "m <addr> <count>", desc: "Examine memory" },
        { cmd: "s", desc: "Step one instruction" },
        { cmd: "c", desc: "Continue execution" },
    ];

    // Add to command history or suggestions
    window.quickCommands = quickCommands;
}

async function syncBreakpoints() {
    for (const lineNum of breakpoints) {
        await sendCommand(`b ${lineNum}`);
    }
}

async function handleGotoNavigation(rawValue) {
    const value = rawValue.trim();
    if (!value) {
        showNotification("Enter a line number, label, or address to navigate", "error");
        return false;
    }

    const model = monacoEditor?.getModel();

    // Line number navigation
    if (/^\d+$/.test(value)) {
        if (!model) {
            showNotification("Editor is not ready yet", "error");
            return false;
        }

        const requestedLine = Number.parseInt(value, 10);
        const maxLine = model.getLineCount();
        const targetLine = Math.min(Math.max(requestedLine, 1), maxLine);
        monacoEditor.revealLineInCenter(targetLine);
        monacoEditor.setPosition({ lineNumber: targetLine, column: 1 });
        monacoEditor.focus();
        showNotification(`Jumped to line ${targetLine}`, "success");
        return true;
    }

    // Hex/decimal address navigation
    if (/^(?:0x)?[0-9a-f]+$/i.test(value)) {
        const sanitized = value.replace(/^0x/i, "");
        const numeric = Number.parseInt(sanitized, 16);
        if (Number.isNaN(numeric)) {
            showNotification(`Invalid address: ${value}`, "error");
            return false;
        }

        const normalizedHex = numeric.toString(16).padStart(8, "0");
        const displayAddress = `0x${normalizedHex}`;

        try {
            await refreshDisassemblyPanel(displayAddress, 20);
            highlightCurrentInstructionInDisassembly(normalizedHex);

            const disasmField = document.getElementById("disasmAddr");
            if (disasmField) disasmField.value = displayAddress;
            const quickMem = document.getElementById("memAddr");
            if (quickMem) quickMem.value = displayAddress;
            const panelMem = document.getElementById("memoryAddr");
            if (panelMem) panelMem.value = displayAddress;

            showNotification(`Focused disassembly at ${displayAddress}`, "success");
            return true;
        } catch (error) {
            console.error("Go navigation failed:", error);
            showNotification(`Failed to read disassembly at ${displayAddress}`, "error");
            return false;
        }
    }

    // Label navigation within the current editor model
    if (model) {
        const label = value.endsWith(":") ? value.slice(0, -1) : value;
        const labelPattern = new RegExp(`^\\s*${escapeRegExp(label)}\\s*:`, "i");
        const totalLines = model.getLineCount();

        for (let line = 1; line <= totalLines; line++) {
            if (labelPattern.test(model.getLineContent(line))) {
                monacoEditor.revealLineInCenter(line);
                monacoEditor.setPosition({ lineNumber: line, column: 1 });
                monacoEditor.focus();
                showNotification(`Jumped to label ${label}`, "success");
                return true;
            }
        }
    }

    showNotification(`Could not locate "${value}"`, "error");
    return false;
}

function setupButtonHandlers() {
    // Debug: Check if buttons exist
    console.log("Setting up button handlers...");
    console.log("gotoBtn exists:", !!document.getElementById("gotoBtn"));
    console.log("memBtn exists:", !!document.getElementById("memBtn"));

    const compileButton = document.getElementById("compileAndLoad");
    if (compileButton && compileButtonDefaultHTML === null) {
        compileButtonDefaultHTML = compileButton.innerHTML;
    }

    document.getElementById("pick").addEventListener("click", async () => {
        const filePath = await window.api.pickAsm();
        if (filePath) {
            await loadFile(filePath);
        }
    });

    document.getElementById("newFile").addEventListener("click", async () => {
        const template = `# RISC-V Assembly\n.globl _start\n_start:\n    nop`;
        const res = await window.api.newFile("untitled.s", template);
        if (res) {
            asmPath = res;
            document.getElementById("asmLabel").textContent = "untitled.s";
            if (monacoEditor) {
                setModelContent("assembly", template);
                setModelContent("c", "");
                setEditorView("assembly");
                breakpoints.clear();
                updateBreakpointDecorations();
            }

            document.getElementById("editorTitle").textContent = "Assembly Editor";
            document.getElementById("toggleView").innerHTML =
                '<i class="fas fa-exchange-alt"></i> Switch to C';

            ideState.fileLoaded = true;
            ideState.editorDirty = true; // New, unsaved file
            ideState.cFileAvailable = false;
            updateButtonStates();
            showNotification("New file created", "success");
        }
    });

    document.getElementById("saveFile").addEventListener("click", saveFile);

    document.getElementById("toggleView").addEventListener("click", toggleFileView);

    document.getElementById("clearEditor").addEventListener("click", () => {
        if (monacoEditor) {
            setModelContent(currentViewMode, "");
            updateButtonStates();
        }
    });

    document.getElementById("formatCode").addEventListener("click", () => {
        if (!monacoEditor) {
            showNotification("Editor not initialized", "error");
            return;
        }

        try {
            const code = monacoEditor.getValue();
            const formatted = formatRISCVAssembly(code);
            monacoEditor.setValue(formatted);
            ideState.editorDirty = true;
            updateButtonStates();
            showNotification("Code formatted!", "success");
        } catch (error) {
            showNotification(`Formatting failed: ${error.message}`, "error");
        }
    });

    document.getElementById("compileAndLoad").addEventListener("click", async () => {
        const compileBtn = document.getElementById("compileAndLoad");
        if (compileBtn.disabled) return;

        const originalText = compileButtonDefaultHTML ?? compileBtn.innerHTML;
        if (compileButtonDefaultHTML === null) {
            compileButtonDefaultHTML = originalText;
        }

        const btn = compileBtn;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Compiling...';

        try {
            terminal.writeln("> Compiling and Loading...");

            // Build step
            const buildRes = await window.api.buildEmu();

            if (buildRes.code !== 0) {
                terminal.writeln("❌ Build failed!");

                // Parse and display build errors line by line for better readability
                const buildOutput = buildRes.out || "No build output";
                const lines = buildOutput.split("\n");

                lines.forEach((line) => {
                    if (line.trim()) {
                        // Highlight error lines
                        if (line.includes("error:") || line.includes("Error:")) {
                            terminal.writeln(`🔴 ${line}`);
                        } else if (line.includes("warning:") || line.includes("Warning:")) {
                            terminal.writeln(`🟡 ${line}`);
                        } else if (
                            line.includes(":") &&
                            (line.includes(".s") || line.includes(".c"))
                        ) {
                            // File and line number references
                            terminal.writeln(`📁 ${line}`);
                        } else {
                            terminal.writeln(`   ${line}`);
                        }
                    }
                });

                showNotification("Build failed! Check terminal for details.", "error");
                ideState.emulatorRunning = false;
                return;
            }
            if (buildRes.out && buildRes.out.includes("Nothing to be done")) {
                terminal.writeln("✅ Emulator already built (up to date)");
            } else {
                terminal.writeln("✅ Emulator built successfully");
                if (buildRes.out) {
                    terminal.writeln(buildRes.out);
                }
            }

            // Check if we have a file loaded
            if (!asmPath) {
                terminal.writeln("❌ No assembly file loaded");
                showNotification("No assembly file loaded", "error");
                ideState.emulatorRunning = false;
                return;
            }

            // Run step
            const runRes = await window.api.runEmu(asmPath);

            if (runRes.ok) {
                showNotification("Emulator running - ready for debugging!", "success");
                await syncBreakpoints();
                ideState.emulatorRunning = true;

                // Sync all panels after loading
                setTimeout(async () => {
                    await syncAllPanels("compile and load");
                }, 300);
            } else {
                terminal.writeln(`❌ Error: ${runRes.error || "Unknown error"}`);
                showNotification(`Failed to load assembly: ${runRes.error}`, "error");
                ideState.emulatorRunning = false;
            }
        } catch (error) {
            console.error("Compile and load error:", error);
            terminal.writeln(`❌ Unexpected error: ${error.message}`);
            showNotification(`Error: ${error.message}`, "error");
            ideState.emulatorRunning = false;
        } finally {
            updateButtonStates();
            btn.innerHTML = originalText;
        }
    });

    document.getElementById("reload").addEventListener("click", async () => {
        if (document.getElementById("reload").disabled) return;
        await window.api.stopEmu();
        const runRes = await window.api.runEmu(asmPath);
        if (runRes.ok) {
            showNotification("Assembly reloaded!", "success");
            await syncBreakpoints();
            ideState.emulatorRunning = true;

            // Sync all panels after reload
            setTimeout(async () => {
                await syncAllPanels("reload");
            }, 300);
        } else {
            showNotification("Failed to reload assembly", "error");
            ideState.emulatorRunning = false;
        }
        updateButtonStates();
    });

    document.getElementById("stop").addEventListener("click", async () => {
        if (document.getElementById("stop").disabled) return;

        const btn = document.getElementById("stop");
        const originalText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Stopping...';

        try {
            const result = await window.api.stopEmu();
            if (result.ok) {
                showNotification("Emulator stopped", "success");
                ideState.emulatorRunning = false;

                // Clear execution state
                currentExecutionLine = null;
                // Store current values as previous before clearing (for proper reset)
                previousRegisterValues = { ...currentRegisterValues };
                currentRegisterValues = {};

                // Clear Monaco editor highlighting
                if (monacoEditor && window.currentLineDecorations) {
                    monacoEditor.deltaDecorations(window.currentLineDecorations, []);
                    window.currentLineDecorations = [];
                }

                // Clear terminal output
                terminal.writeln("✅ Emulator stopped");
            } else {
                showNotification(`Failed to stop: ${result.error || "Unknown error"}`, "error");
                // Even if stop "failed", assume emulator is stopped for UI consistency
                ideState.emulatorRunning = false;
            }
        } catch (error) {
            showNotification(`Error stopping emulator: ${error.message}`, "error");
            // Even if there was an exception, assume emulator is stopped
            ideState.emulatorRunning = false;
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
            updateButtonStates();
        }
    });

    document.getElementById("send").addEventListener("click", () => {
        const cmdInput = document.getElementById("cmd");
        const command = cmdInput.value.trim();
        if (command) {
            sendCommand(command);
            cmdInput.value = "";
        }
    });

    document.getElementById("cmd").addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            document.getElementById("send").click();
        }
    });

    const panelTabs = document.querySelector(".panel-tabs");
    if (panelTabs) {
        panelTabs.addEventListener("click", (event) => {
            const button = event.target.closest(".tab-btn");
            if (!button || !panelTabs.contains(button)) return;

            const targetPanel = button.dataset.panel;
            if (!targetPanel) return;

            panelTabs.querySelectorAll(".tab-btn").forEach((tab) => {
                tab.classList.toggle("active", tab === button);
            });

            const panelSelector = `${targetPanel}-panel`;
            document.querySelectorAll(".panel-content .panel").forEach((panel) => {
                panel.classList.toggle("active", panel.id === panelSelector);
            });
        });
    }

    document.getElementById("clearTerminal").addEventListener("click", () => {
        if (terminal) terminal.clear();
    });

    // Breakpoint buttons
    document.getElementById("bpSet").addEventListener("click", () => {
        const lineInput = document.getElementById("bpLine");
        const lineNumber = parseInt(lineInput.value.trim());

        if (isNaN(lineNumber) || lineNumber < 1) {
            showNotification("Please enter a valid line number", "error");
            return;
        }

        // Set breakpoint in Monaco editor
        if (monacoEditor) {
            toggleBreakpoint(lineNumber);
            lineInput.value = "";
            showNotification(`Breakpoint set at line ${lineNumber}`, "success");
        } else {
            showNotification("Editor not initialized", "error");
        }
    });

    document.getElementById("bpDel").addEventListener("click", () => {
        const lineInput = document.getElementById("bpLine");
        const lineNumber = parseInt(lineInput.value.trim());

        if (isNaN(lineNumber) || lineNumber < 1) {
            showNotification("Please enter a valid line number", "error");
            return;
        }

        // Remove breakpoint from Monaco editor
        if (monacoEditor) {
            toggleBreakpoint(lineNumber); // This function toggles, so calling it twice removes
            lineInput.value = "";
            showNotification(`Breakpoint removed from line ${lineNumber}`, "success");
        } else {
            showNotification("Editor not initialized", "error");
        }
    });

    // Allow Enter key in breakpoint line input
    document.getElementById("bpLine").addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            document.getElementById("bpSet").click();
        }
    });

    // Folder management
    document.getElementById("chooseFolder").addEventListener("click", async () => {
        const folder = await window.api.pickFolder();
        if (folder) {
            currentWorkspaceFolder = folder;
            showNotification(`Workspace folder set to: ${folder}`, "success");
            // Refresh file list
            document.getElementById("refreshFiles").click();
        }
    });

    document.getElementById("refreshFiles").addEventListener("click", async () => {
        showNotification("Refreshing file list...", "info");
        await loadExampleFiles();
    });

    // Memory refresh button
    document.getElementById("memoryRefresh").addEventListener("click", async () => {
        const addr = document.getElementById("memoryAddr").value.trim();
        const len = document.getElementById("memoryLen").value.trim() || "64";
        if (addr) {
            const result = await enqueueEmulatorCommand(`m ${addr} ${len}`);
            if (result.ok) {
                updateMemoryDisplay(result.output);
                showNotification("Memory panel updated", "success");
            } else {
                showNotification("Failed to read memory", "error");
            }
        }
    });

    // Symbols refresh button
    document.getElementById("refreshSymbols").addEventListener("click", async () => {
        await refreshSymbolsPanel();
        showNotification("Symbols refreshed", "success");
    });

    // Symbol filter dropdown
    document.getElementById("symbolFilter").addEventListener("change", async () => {
        await refreshSymbolsPanel();
    });

    // Disassembly refresh button
    document.getElementById("disasmRefresh").addEventListener("click", async () => {
        const addr = document.getElementById("disasmAddr").value.trim();
        const count = parseInt(document.getElementById("disasmCount").value.trim() || "20");
        try {
            await refreshDisassemblyPanel(addr, count);
            showNotification("Disassembly updated", "success");
        } catch (error) {
            terminal.writeln(`Error: ${error.message}`);
            showNotification("Failed to update disassembly", "error");
        }
    });

    // Callstack refresh button
    document.getElementById("refreshCallstack").addEventListener("click", async () => {
        await refreshCallStackPanel();
        showNotification("Call stack refreshed", "success");
    });

    // Add Enter key support for various input fields
    document.getElementById("gotoAddress").addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            document.getElementById("gotoBtn").click();
        }
    });

    document.getElementById("memoryAddr").addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            document.getElementById("memoryRefresh").click();
        }
    });

    document.getElementById("disasmAddr").addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            document.getElementById("disasmRefresh").click();
        }
    });

    document.querySelectorAll("[data-cmd]").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const cmd = btn.getAttribute("data-cmd");
            if (cmd === "q") {
                // Use the same logic as the main stop button
                document.getElementById("stop").click();
            } else if (cmd === "s") {
                await performSingleStep();
            } else if (cmd === "info registers") {
                // VIEW panel: Registers button
                await handleViewRegisters();
            } else if (cmd === "list") {
                // VIEW panel: Source button
                await handleViewSource();
            } else if (cmd === "disassemble") {
                // VIEW panel: Disassembly button
                await handleViewDisassembly();
            } else if (cmd === "info program") {
                // VIEW panel: Status button
                await handleViewStatus();
            } else {
                sendCommand(cmd);
            }
        });
    });

    // Display format dropdown handler
    document.getElementById("numberFormat").addEventListener("change", (e) => {
        const format = e.target.value;
        showNotification(`Display format changed to ${format}`, "info");
        // Refresh register display with new format
        updateRegistersFromCurrentValues();
        // Note: memory and disassembly displays handle their own formatting
    });

    // Add keyboard navigation
    document.addEventListener("keydown", (e) => {
        // Only handle when not focused on input elements
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

        // Ctrl+1-5 for panel switching
        if (e.ctrlKey && e.key >= "1" && e.key <= "5") {
            e.preventDefault();
            const panels = ["registers", "source", "disassembly", "memory", "statistics"];
            const panelIndex = parseInt(e.key) - 1;
            if (panels[panelIndex]) {
                switchToPanel(panels[panelIndex]);
            }
        }

        // F5 for run, F10 for step
        if (e.key === "F5" && !e.shiftKey) {
            e.preventDefault();
            document.querySelector('[data-cmd="r"]')?.click();
        } else if (e.key === "F10") {
            e.preventDefault();
            const stepButton = document.querySelector('[data-cmd="s"]');
            stepButton?.click();
        } else if (e.key === "F5" && e.shiftKey) {
            e.preventDefault();
            document.querySelector('[data-cmd="q"]')?.click();
        }

        // Escape to focus terminal command input
        if (e.key === "Escape") {
            const cmdInput = document.getElementById("cmd");
            if (cmdInput) {
                cmdInput.focus();
            }
        }
    });

    // Enhanced memory examination with format support
    document.getElementById("memBtn").addEventListener("click", async () => {
        const addr = document.getElementById("memAddr").value.trim();
        const format = document.getElementById("memFormat").value;
        const length = document.getElementById("memLen").value.trim() || "16";

        if (!addr) {
            showNotification("Please enter a memory address", "error");
            return;
        }

        const command = `m ${addr} ${length}`;
        const result = await enqueueEmulatorCommand(command);

        if (result.ok) {
            // Display in terminal
            terminal.writeln(`>> ${command}`);
            terminal.writeln(result.output);

            // Update CPUlator-style memory display
            updateMemoryDisplay(result.output);
        } else {
            terminal.writeln(`Error: ${result.error}`);
        }
    });

    // GoTo button
    document.getElementById("gotoBtn").addEventListener("click", async () => {
        const input = document.getElementById("gotoAddress");
        const value = input.value.trim();
        if (!value) {
            showNotification("Enter a line number, label, or address", "error");
            return;
        }

        const navigated = await handleGotoNavigation(value);
        if (navigated) {
            input.value = "";
        }
    });

    console.log("✅ Button handlers set up");
}

// Central synchronization function to update all panels
async function syncAllPanels(reason = "update") {
    try {
        console.log(`🔄 Syncing all panels (${reason})...`);

        let pcHex = null;

        // For single-step operations, use minimal updates to avoid terminal clutter
        if (reason === "single-step") {
            // Update registers silently - suppressTerminalOutput is already active from performSingleStep
            console.log("📤 Single-step: sending silent 'r' command...");
            const registersResult = await enqueueEmulatorCommand("r");

            if (registersResult.ok) {
                const { pc } = ingestRegisterDump(registersResult.output);
                if (pc) {
                    pcHex = pc;
                    console.log(`🎯 Updated PC: 0x${pc}`);
                }
                updateRegistersFromCurrentValues();
                updatePerformanceCounters();
                updateInstructionTypeStats();
            }

            // Skip list command for single-step to avoid clutter
            console.log("🔄 Single-step: skipping list command to minimize output");
        } else {
            // Normal operation for non-step commands
            console.log("📤 Sending 'r' command for register dump...");
            const registersResult = await enqueueEmulatorCommand("r");
            console.log("📥 register dump result:", registersResult.ok);
            if (registersResult.ok) {
                previousRegisterValues = { ...currentRegisterValues };

                const { pc } = ingestRegisterDump(registersResult.output);
                if (pc) {
                    pcHex = pc;
                    console.log(`🎯 Updated PC: 0x${pc}`);
                }

                // Force a small delay to ensure register values are properly updated
                await new Promise((resolve) => setTimeout(resolve, 10));
                updateRegistersFromCurrentValues();
                updatePerformanceCounters();
                updateInstructionTypeStats();
            }

            // Send list command to get current execution line info and parse it immediately
            console.log("📤 Sending 'l' command for source listing...");
            const listResult = await enqueueEmulatorCommand("l");
            if (listResult.ok && listResult.output) {
                console.log("📄 List command output:", listResult.output.substring(0, 200) + "...");
                // Parse immediately to update currentExecutionLine
                parseEmulatorOutputForTrace(listResult.output);
            }
        }

        // Ensure UI updates are refreshed after getting current line
        updateSourceDisplay();
        highlightCurrentSourceLine();
        highlightCurrentLineInEditor();

        if (!pcHex && currentRegisterValues["pc"]) {
            pcHex = currentRegisterValues["pc"];
        }

        // Update disassembly around current PC
        if (pcHex) {
            console.log(`📤 Getting disassembly around PC: 0x${pcHex}`);
            const disasmResult = await enqueueEmulatorCommand(`disassemble 0x${pcHex},+20`);
            if (disasmResult.ok) {
                updateDisassemblyDisplay(disasmResult.output);
                highlightCurrentInstructionInDisassembly(pcHex);
            }
        }

        // Update memory panel
        const memoryAddrInput = document.getElementById("memoryAddr");
        let memoryAddr = memoryAddrInput?.value;

        // Auto-populate with stack pointer if no address specified
        if (!memoryAddr || !memoryAddr.trim()) {
            const sp = currentRegisterValues["x02"] || currentRegisterValues["x2"] || currentRegisterValues["sp"];
            if (sp) {
                const spValue = parseInt(sp, 16);
                // Show memory around stack pointer (64 bytes before SP to see stack contents)
                memoryAddr = `0x${(spValue - 64).toString(16)}`;
                if (memoryAddrInput) {
                    memoryAddrInput.value = memoryAddr;
                }
            }
        }

        // Update memory display if we have an address
        if (memoryAddr && memoryAddr.trim()) {
            const memoryLen = document.getElementById("memoryLen")?.value || "64";
            console.log(`📤 Fetching memory at ${memoryAddr}, length ${memoryLen}`);
            const memResult = await enqueueEmulatorCommand(`m ${memoryAddr} ${memoryLen}`);
            if (memResult.ok) {
                updateMemoryDisplay(memResult.output);
                console.log("✅ Memory panel updated");
            }
        }

        // Update symbols with fallback
        try {
            await refreshSymbolsPanel();
        } catch (error) {
            console.error("Error refreshing symbols panel:", error);
        }

        // Update call stack with fallback
        try {
            console.log("🔄 Updating call stack panel...");
            await refreshCallStackPanel();
            console.log("✅ Call stack panel updated");
        } catch (error) {
            console.error("Error refreshing call stack panel:", error);
        }

        // Update breakpoint display
        try {
            updateBreakpointDisplay();
        } catch (error) {
            console.error("Error updating breakpoint display:", error);
        }

        console.log(
            `✅ All panels synced (${reason}) - Current line: ${currentExecutionLine}, PC: 0x${pcHex}`
        );
    } catch (error) {
        console.error("Error syncing panels:", error);
        showNotification("Error syncing panels", "error");
    }
}

// Enhanced update function for execution commands
async function updateAfterExecution(commandType = "execution") {
    // Allow the emulator a brief moment to flush output before querying state
    await new Promise((resolve) => setTimeout(resolve, 60));
    await syncAllPanels(commandType);
}

// Enhanced single-step execution for Step Into button with minimal terminal output
async function performSingleStep() {
    if (stepExecutionInProgress) {
        console.log("⏳ Step request ignored: another step in progress");
        return;
    }

    try {
        stepExecutionInProgress = true;
        console.log("🔍 Starting single step execution...");

        // Store previous register values for highlighting changes
        previousRegisterValues = { ...currentRegisterValues };

        // Suppress ALL terminal output during step operation
        suppressTerminalOutput = true;

        // Execute step command
        console.log("📤 Sending single 's' command to emulator...");
        console.log(
            "📊 Before step - PC:",
            currentRegisterValues["pc"],
            "Line:",
            currentExecutionLine
        );

        const result = await enqueueEmulatorCommand("s");
        console.log("📥 Step command result:", result.ok ? "success" : "failed");

        if (result.output) {
            console.log("📄 Raw emulator output length:", result.output.length);
            console.log("📄 Raw emulator output:", result.output.substring(0, 200) + "...");

            // Parse the step output immediately for current line tracking
            parseEmulatorOutputForTrace(result.output);
        }

        if (result.ok) {
            const stepCount = (window.stepCounter = (window.stepCounter || 0) + 1);

            // Parse step output to extract current state
            const output = result.output || "";
            const lines = output.split("\n");
            let currentState = null;

            // Look for the basic state info [inst: X, pc: Y, src: Z]
            for (const line of lines) {
                const stateMatch = line.match(/\[inst:\s*(\d+),\s*pc:\s*(\d+),\s*src:\s*(\d+)\]/);
                if (stateMatch) {
                    const [, inst, pc, src] = stateMatch;
                    currentState = { inst, pc, src };
                    break;
                }
            }

            // Update current execution line from step output
            if (currentState) {
                const rawLineNumber = parseInt(currentState.src, 10);
                const executableLine = Number.isNaN(rawLineNumber)
                    ? null
                    : findNearestExecutableLine(rawLineNumber);
                currentExecutionLine = executableLine ?? currentExecutionLine;
            }

            // Give emulator time to process
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Update all panels to reflect new state with register highlighting (still suppressed)
            console.log("🔄 Calling syncAllPanels directly for step...");
            await syncAllPanels("single-step");
            console.log(
                "📊 After sync - PC:",
                currentRegisterValues["pc"],
                "Line:",
                currentExecutionLine
            );

            // Force update all highlighting and displays
            updateRegistersFromCurrentValues();
            highlightCurrentLineInEditor();
            highlightCurrentSourceLine();
            updateSourceDisplay();

            // Update previousRegisterValues for next comparison after a delay to allow highlighting
            setTimeout(() => {
                // Copy current values to previous for next step comparison
                previousRegisterValues = { ...currentRegisterValues };
            }, 100);

            // Re-enable terminal output and show clean step output
            suppressTerminalOutput = false;

            // Show clean step output with next instruction info
            if (currentState) {
                // Look for "Next:" instruction in the output
                let nextInstruction = null;
                for (const line of lines) {
                    const nextMatch = line.match(/^Next:\s*(.+)$/);
                    if (nextMatch) {
                        nextInstruction = nextMatch[1].trim();
                        break;
                    }
                }

                // Show the next instruction and execution context
                if (nextInstruction) {
                    terminal.writeln(`Next: ${nextInstruction}`);

                    // Show instruction reference information
                    const instrInfo = getInstructionInfo(nextInstruction);
                    if (instrInfo) {
                        terminal.writeln(`  ${instrInfo.name} - ${instrInfo.description}`);
                    }
                }
                terminal.writeln(
                    `[inst: ${currentState.inst.padStart(7)}, pc: ${currentState.pc.padStart(
                        7
                    )}, src line: ${currentState.src.padStart(4)}]`
                );
            } else {
                terminal.writeln(`Step ${stepCount} executed`);
            }

            // Add to trace with source assembly instruction
            if (currentRegisterValues && Object.keys(currentRegisterValues).length > 0) {
                const pc = currentRegisterValues["pc"];
                const pcValue = parseInt(pc, 16);

                // Get the source assembly instruction from the current execution line
                let sourceInstruction = getSourceInstructionFromLine(currentExecutionLine);

                // Fallback if we can't get the source instruction
                if (!sourceInstruction) {
                    sourceInstruction = `Step ${stepCount}`;
                }

                addToTrace(sourceInstruction, pcValue, { ...currentRegisterValues });
            }
        } else {
            // Re-enable output for error messages
            suppressTerminalOutput = false;
            terminal.writeln(`❌ Step failed: ${result.error || "Unknown error"}`);
            showNotification("Step execution failed", "error");
        }
    } catch (error) {
        console.error("performSingleStep error:", error);
        // Re-enable output for error messages
        suppressTerminalOutput = false;
        terminal.writeln(`❌ Step error: ${error.message}`);
        showNotification(`Step error: ${error.message}`, "error");
    } finally {
        // Always ensure terminal output is re-enabled
        suppressTerminalOutput = false;
        stepExecutionInProgress = false;
    }
}

// VIEW panel button handlers
async function handleViewRegisters() {
    try {
        // Switch to registers panel
        switchToPanel("registers");

        // Sync all panels for comprehensive update (silent operation)
        await syncAllPanels("view registers");

        // Only show success message for explicit user action
        showNotification("Registers view updated", "success");
    } catch (error) {
        console.error("Error updating registers:", error);
        terminal.writeln(`❌ Error updating registers: ${error.message}`);
    }
}

async function handleViewSource() {
    try {
        // Switch to source panel
        switchToPanel("source");

        // Sync all panels for comprehensive update (silent operation)
        await syncAllPanels("view source");

        // Only show success message for explicit user action
        showNotification("Source view updated", "success");
    } catch (error) {
        console.error("Error updating source:", error);
        terminal.writeln(`❌ Error updating source: ${error.message}`);
    }
}

async function handleViewDisassembly() {
    try {
        // Switch to disassembly panel
        switchToPanel("disassembly");

        // Get current PC for disassembly
        const pcValue = currentRegisterValues["pc"];
        const startAddr = pcValue ? `0x${pcValue}` : "0x400000";
        await refreshDisassemblyPanel(startAddr, 20);

        // Only show success message for explicit user action
        showNotification("Disassembly view updated", "success");
    } catch (error) {
        console.error("Error updating disassembly:", error);
        terminal.writeln(`❌ Error updating disassembly: ${error.message}`);
    }
}

async function refreshDisassemblyPanel(startAddr, count = 20) {
    const parsedCount = Number.parseInt(count, 10);
    const normalizedCount = Number.isNaN(parsedCount) ? 20 : Math.max(1, parsedCount);
    let address = startAddr;

    if (!address) {
        const pcValue = currentRegisterValues["pc"];
        address = pcValue ? `0x${pcValue}` : "0x400000";
    }

    if (!address.startsWith("0x")) {
        address = `0x${address}`;
    }

    const baseAddr = parseInt(address, 16);
    const bytesToRead = normalizedCount * 4; // 4 bytes per RISC-V instruction

    try {
        if (Number.isNaN(baseAddr)) {
            throw new Error(`Invalid disassembly address '${address}'`);
        }

        const disasmResult = await enqueueEmulatorCommand(
            `disassemble ${address},+${normalizedCount}`
        );
        if (disasmResult.ok && disasmResult.output) {
            updateDisassemblyDisplay(disasmResult.output);
        } else {
            const disasmContent = document.getElementById("disasmContent");
            if (disasmContent) {
                disasmContent.innerHTML = '<div class="disasm-empty">No disassembly data available at this address.</div>';
            }
        }
    } catch (error) {
        console.error(`Error refreshing disassembly panel (${bytesToRead} bytes):`, error);
        const disasmContent = document.getElementById("disasmContent");
        if (disasmContent) {
            const message = error instanceof Error ? error.message : String(error);
            disasmContent.innerHTML = `<div class="disasm-error">Error reading ${bytesToRead} bytes: ${escapeHtml(
                message
            )}</div>`;
        }
    }
}

function parseMemoryOutput(output) {
    const memoryData = [];
    const lines = output.split("\n");

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Parse hex memory output format
        // Expected format: address: value value value ...
        const match = trimmed.match(/^([0-9a-fA-F]+):\s*(.+)$/);
        if (match) {
            const [, addr, values] = match;
            const address = parseInt(addr, 16);
            const hexValues = values.split(/\s+/).filter((v) => v && /^[0-9a-fA-F]+$/.test(v));

            for (let i = 0; i < hexValues.length; i++) {
                memoryData.push({
                    address: address + i * 4,
                    instruction: parseInt(hexValues[i], 16),
                });
            }
        }
    }

    return memoryData;
}

function disassembleMemoryData(memoryData, baseAddr, count) {
    let html = "";

    for (let i = 0; i < Math.min(count, memoryData.length); i++) {
        const data = memoryData[i];
        if (!data) continue;

        const address = data.address;
        const instruction = data.instruction;
        const addressHex = `0x${address.toString(16).padStart(8, "0")}`;
        const opcodeHex = `0x${instruction.toString(16).padStart(8, "0")}`;

        // Simple RISC-V disassembly
        const disasm = disassembleInstruction(instruction);
        const isCurrentPC = currentRegisterValues["pc"] === address.toString(16);

        html += `<div class="disasm-line ${isCurrentPC ? "current-pc" : ""}">
            <span class="disasm-addr">${addressHex}</span>
            <span class="disasm-opcode">${opcodeHex}</span>
            <span class="disasm-instr">${disasm}</span>
            <span class="disasm-comment"></span>
        </div>`;
    }

    return html;
}

function updateMemoryDisplay(memoryOutput) {
    const memoryDisplay = document.getElementById("memoryDisplay");
    if (!memoryDisplay) return;

    if (!memoryOutput || !memoryOutput.trim()) {
        memoryDisplay.innerHTML = '<div class="empty-message">No memory data available</div>';
        return;
    }

    const lines = memoryOutput.split(/\r?\n/);

    // Parse all memory data into a flat array
    let memoryData = [];
    let baseAddress = 0;

    lines.forEach((line) => {
        const match = line.match(/^\s*([^:]+):\s*(.+)$/);
        if (!match) return;

        const address = match[1].trim();
        const rawValues = match[2].trim().split(/\s+/).filter(Boolean);

        // Parse address
        const addr = parseInt(address.replace('0x', ''), 16);
        if (memoryData.length === 0) {
            baseAddress = addr;
        }

        // Parse bytes
        rawValues.forEach((token, index) => {
            const hexCandidate = token.startsWith("0x") ? token.slice(2) : token;
            let value = Number.parseInt(hexCandidate, 16);
            if (!Number.isNaN(value)) {
                memoryData.push({
                    address: addr + index,
                    value: value & 0xff
                });
            }
        });
    });

    if (memoryData.length === 0) {
        memoryDisplay.innerHTML = '<div class="empty-message">No memory data available</div>';
        return;
    }

    // Build CPUlator-style display: 16 bytes per row with word grouping
    let html = '<div class="memory-table">';

    // Header row
    html += '<div class="memory-header">';
    html += '<span class="mem-addr-header">Address</span>';
    html += '<span class="mem-hex-header">+0 +1 +2 +3  +4 +5 +6 +7  +8 +9 +A +B  +C +D +E +F</span>';
    html += '<span class="mem-ascii-header">ASCII</span>';
    html += '</div>';

    // Align to 16-byte boundaries
    const startAddr = Math.floor(baseAddress / 16) * 16;
    const endAddr = memoryData[memoryData.length - 1].address;

    for (let addr = startAddr; addr <= endAddr; addr += 16) {
        html += '<div class="memory-row">';

        // Address column
        html += `<span class="memory-address">0x${addr.toString(16).padStart(8, '0').toUpperCase()}</span>`;

        // Hex bytes column - grouped by 4 bytes (words)
        html += '<span class="memory-hex">';
        let ascii = '';

        for (let i = 0; i < 16; i++) {
            const byteAddr = addr + i;
            const memByte = memoryData.find(m => m.address === byteAddr);

            if (memByte) {
                const hexStr = memByte.value.toString(16).padStart(2, '0').toUpperCase();
                html += `<span class="mem-byte">${hexStr}</span>`;

                // ASCII representation
                const ch = memByte.value;
                ascii += (ch >= 32 && ch <= 126) ? String.fromCharCode(ch) : '·';
            } else {
                html += '<span class="mem-byte mem-empty">··</span>';
                ascii += '·';
            }

            // Add spacing every 4 bytes (word boundary)
            if ((i + 1) % 4 === 0 && i < 15) {
                html += '<span class="mem-spacer"> </span>';
            }
        }
        html += '</span>';

        // ASCII column
        html += `<span class="memory-ascii">${ascii}</span>`;

        html += '</div>';
    }

    html += '</div>';
    memoryDisplay.innerHTML = html;
}

function disassembleInstruction(instruction) {
    // Basic RISC-V instruction decoding
    const opcode = instruction & 0x7f;

    switch (opcode) {
        case 0x33: // R-type (add, sub, and, or, etc.)
            return disassembleRType(instruction);
        case 0x13: // I-type (addi, andi, ori, etc.)
            return disassembleIType(instruction);
        case 0x03: // Load instructions
            return disassembleLoadType(instruction);
        case 0x23: // Store instructions
            return disassembleStoreType(instruction);
        case 0x63: // Branch instructions
            return disassembleBranchType(instruction);
        case 0x6f: // JAL
            return disassembleJType(instruction);
        case 0x67: // JALR
            return disassembleJALR(instruction);
        case 0x37: // LUI
            return disassembleLUI(instruction);
        case 0x17: // AUIPC
            return disassembleAUIPC(instruction);
        default:
            return `unknown (0x${instruction.toString(16)})`;
    }
}

function disassembleRType(instruction) {
    const rd = (instruction >> 7) & 0x1f;
    const funct3 = (instruction >> 12) & 0x7;
    const rs1 = (instruction >> 15) & 0x1f;
    const rs2 = (instruction >> 20) & 0x1f;
    const funct7 = (instruction >> 25) & 0x7f;

    const rdName = getRegisterName(rd);
    const rs1Name = getRegisterName(rs1);
    const rs2Name = getRegisterName(rs2);

    if (funct7 === 0x00) {
        switch (funct3) {
            case 0x0:
                return `add ${rdName}, ${rs1Name}, ${rs2Name}`;
            case 0x4:
                return `xor ${rdName}, ${rs1Name}, ${rs2Name}`;
            case 0x6:
                return `or ${rdName}, ${rs1Name}, ${rs2Name}`;
            case 0x7:
                return `and ${rdName}, ${rs1Name}, ${rs2Name}`;
            case 0x1:
                return `sll ${rdName}, ${rs1Name}, ${rs2Name}`;
            case 0x5:
                return `srl ${rdName}, ${rs1Name}, ${rs2Name}`;
            case 0x2:
                return `slt ${rdName}, ${rs1Name}, ${rs2Name}`;
            case 0x3:
                return `sltu ${rdName}, ${rs1Name}, ${rs2Name}`;
        }
    } else if (funct7 === 0x20) {
        switch (funct3) {
            case 0x0:
                return `sub ${rdName}, ${rs1Name}, ${rs2Name}`;
            case 0x5:
                return `sra ${rdName}, ${rs1Name}, ${rs2Name}`;
        }
    }

    return `r-type (0x${instruction.toString(16)})`;
}

function disassembleIType(instruction) {
    const rd = (instruction >> 7) & 0x1f;
    const funct3 = (instruction >> 12) & 0x7;
    const rs1 = (instruction >> 15) & 0x1f;
    const imm = (instruction >> 20) & 0xfff;
    const signExtImm = imm > 0x7ff ? imm - 0x1000 : imm;

    const rdName = getRegisterName(rd);
    const rs1Name = getRegisterName(rs1);

    switch (funct3) {
        case 0x0:
            return `addi ${rdName}, ${rs1Name}, ${signExtImm}`;
        case 0x2:
            return `slti ${rdName}, ${rs1Name}, ${signExtImm}`;
        case 0x3:
            return `sltiu ${rdName}, ${rs1Name}, ${signExtImm}`;
        case 0x4:
            return `xori ${rdName}, ${rs1Name}, ${signExtImm}`;
        case 0x6:
            return `ori ${rdName}, ${rs1Name}, ${signExtImm}`;
        case 0x7:
            return `andi ${rdName}, ${rs1Name}, ${signExtImm}`;
        case 0x1:
            return `slli ${rdName}, ${rs1Name}, ${imm & 0x1f}`;
        case 0x5:
            if (imm >> 5 === 0x00) return `srli ${rdName}, ${rs1Name}, ${imm & 0x1f}`;
            if (imm >> 5 === 0x20) return `srai ${rdName}, ${rs1Name}, ${imm & 0x1f}`;
            break;
    }

    return `i-type (0x${instruction.toString(16)})`;
}

function disassembleLoadType(instruction) {
    const rd = (instruction >> 7) & 0x1f;
    const funct3 = (instruction >> 12) & 0x7;
    const rs1 = (instruction >> 15) & 0x1f;
    const imm = (instruction >> 20) & 0xfff;
    const signExtImm = imm > 0x7ff ? imm - 0x1000 : imm;

    const rdName = getRegisterName(rd);
    const rs1Name = getRegisterName(rs1);

    switch (funct3) {
        case 0x0:
            return `lb ${rdName}, ${signExtImm}(${rs1Name})`;
        case 0x1:
            return `lh ${rdName}, ${signExtImm}(${rs1Name})`;
        case 0x2:
            return `lw ${rdName}, ${signExtImm}(${rs1Name})`;
        case 0x4:
            return `lbu ${rdName}, ${signExtImm}(${rs1Name})`;
        case 0x5:
            return `lhu ${rdName}, ${signExtImm}(${rs1Name})`;
    }

    return `load (0x${instruction.toString(16)})`;
}

function disassembleStoreType(instruction) {
    const funct3 = (instruction >> 12) & 0x7;
    const rs1 = (instruction >> 15) & 0x1f;
    const rs2 = (instruction >> 20) & 0x1f;
    const imm = ((instruction >> 25) << 5) | ((instruction >> 7) & 0x1f);
    const signExtImm = imm > 0x7ff ? imm - 0x1000 : imm;

    const rs1Name = getRegisterName(rs1);
    const rs2Name = getRegisterName(rs2);

    switch (funct3) {
        case 0x0:
            return `sb ${rs2Name}, ${signExtImm}(${rs1Name})`;
        case 0x1:
            return `sh ${rs2Name}, ${signExtImm}(${rs1Name})`;
        case 0x2:
            return `sw ${rs2Name}, ${signExtImm}(${rs1Name})`;
    }

    return `store (0x${instruction.toString(16)})`;
}

function disassembleBranchType(instruction) {
    const funct3 = (instruction >> 12) & 0x7;
    const rs1 = (instruction >> 15) & 0x1f;
    const rs2 = (instruction >> 20) & 0x1f;

    const rs1Name = getRegisterName(rs1);
    const rs2Name = getRegisterName(rs2);

    switch (funct3) {
        case 0x0:
            return `beq ${rs1Name}, ${rs2Name}, <offset>`;
        case 0x1:
            return `bne ${rs1Name}, ${rs2Name}, <offset>`;
        case 0x4:
            return `blt ${rs1Name}, ${rs2Name}, <offset>`;
        case 0x5:
            return `bge ${rs1Name}, ${rs2Name}, <offset>`;
        case 0x6:
            return `bltu ${rs1Name}, ${rs2Name}, <offset>`;
        case 0x7:
            return `bgeu ${rs1Name}, ${rs2Name}, <offset>`;
    }

    return `branch (0x${instruction.toString(16)})`;
}

function disassembleJType(instruction) {
    const rd = (instruction >> 7) & 0x1f;
    const rdName = getRegisterName(rd);
    return `jal ${rdName}, <offset>`;
}

function disassembleJALR(instruction) {
    const rd = (instruction >> 7) & 0x1f;
    const rs1 = (instruction >> 15) & 0x1f;
    const imm = (instruction >> 20) & 0xfff;
    const signExtImm = imm > 0x7ff ? imm - 0x1000 : imm;

    const rdName = getRegisterName(rd);
    const rs1Name = getRegisterName(rs1);

    return `jalr ${rdName}, ${rs1Name}, ${signExtImm}`;
}

function disassembleLUI(instruction) {
    const rd = (instruction >> 7) & 0x1f;
    const imm = instruction >> 12;
    const rdName = getRegisterName(rd);

    return `lui ${rdName}, 0x${imm.toString(16)}`;
}

function disassembleAUIPC(instruction) {
    const rd = (instruction >> 7) & 0x1f;
    const imm = instruction >> 12;
    const rdName = getRegisterName(rd);

    return `auipc ${rdName}, 0x${imm.toString(16)}`;
}

function getRegisterName(regNum) {
    const regNames = [
        "zero",
        "ra",
        "sp",
        "gp",
        "tp",
        "t0",
        "t1",
        "t2",
        "s0",
        "s1",
        "a0",
        "a1",
        "a2",
        "a3",
        "a4",
        "a5",
        "a6",
        "a7",
        "s2",
        "s3",
        "s4",
        "s5",
        "s6",
        "s7",
        "s8",
        "s9",
        "s10",
        "s11",
        "t3",
        "t4",
        "t5",
        "t6",
    ];

    return regNames[regNum] || `x${regNum}`;
}

function createPlaceholderDisassembly(baseAddr, count) {
    const disasmContent = document.getElementById("disasmContent");
    if (!disasmContent) return;

    let html = "";
    for (let i = 0; i < count; i++) {
        const address = baseAddr + i * 4;
        const addressHex = `0x${address.toString(16).padStart(8, "0")}`;

        html += `<div class="disasm-line">
            <span class="disasm-addr">${addressHex}</span>
            <span class="disasm-opcode">????????</span>
            <span class="disasm-instr">nop</span>
            <span class="disasm-comment"># placeholder</span>
        </div>`;
    }

    disasmContent.innerHTML = html;
}

async function handleViewStatus() {
    try {
        // Switch to statistics panel for program status
        switchToPanel("statistics");

        // Sync all panels for comprehensive update (silent operation)
        await syncAllPanels("view status");

        // Only show success message for explicit user action
        showNotification("Program status updated", "success");
    } catch (error) {
        console.error("Error updating status:", error);
        terminal.writeln(`❌ Error updating status: ${error.message}`);
    }
}

// Highlight registers that changed during step execution
function highlightChangedRegisters(previousValues) {
    for (let i = 0; i < 32; i++) {
        const regName = `x${i}`;
        const currentValue = currentRegisterValues[regName] || "0";
        const previousValue = previousValues[regName] || "0";

        if (previousValue !== currentValue) {
            const registerElement = document.querySelector(`[data-register="${regName}"]`);
            if (registerElement) {
                registerElement.classList.add("changed");
                // Remove highlight after animation
                setTimeout(() => {
                    registerElement.classList.remove("changed");
                }, 2000);
            }
        }
    }
}

// Removed unused logStepToTrace function - trace entries are now handled in performSingleStep

// Highlight current instruction in disassembly panel
function highlightCurrentInstructionInDisassembly(pcHex) {
    const normalized = (pcHex || "").toString().replace(/^0x/i, "").toLowerCase();
    const disasmLines = document.querySelectorAll(".disasm-line");
    let target = null;

    disasmLines.forEach((line) => {
        line.classList.remove("current-pc");
        if (!target && line.dataset.address === normalized) {
            target = line;
        }
    });

    if (target) {
        target.classList.add("current-pc");
        target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
}

// Enhanced source panel highlighting
function highlightCurrentSourceLine() {
    // Remove previous highlights
    const sourceLines = document.querySelectorAll(".source-line");
    sourceLines.forEach((line) => line.classList.remove("current-pc"));

    // Highlight current execution line
    if (currentExecutionLine) {
        const currentLineElement = document.querySelector(`[data-line="${currentExecutionLine}"]`);
        if (currentLineElement) {
            currentLineElement.classList.add("current-pc");
        }
    }
}

// Add CSS styles for Monaco editor highlighting
function addMonacoHighlightStyles() {
    if (document.getElementById("monaco-highlight-styles")) return;

    const style = document.createElement("style");
    style.id = "monaco-highlight-styles";
    style.textContent = `
        .current-execution-line {
            background-color: rgba(255, 215, 0, 0.3) !important;
        }
        .current-execution-line-full {
            background-color: rgba(255, 215, 0, 0.2) !important;
            border-left: 3px solid #FFD700 !important;
        }
        .current-execution-glyph {
            background-color: #FFD700 !important;
            color: #000 !important;
            text-align: center !important;
        }
        .current-execution-glyph::before {
            content: "▶";
            color: #000 !important;
            font-weight: bold !important;
        }
        /* Monaco editor specific selectors */
        .monaco-editor .current-execution-line {
            background-color: rgba(255, 215, 0, 0.3) !important;
        }
        .monaco-editor .current-execution-line-full {
            background-color: rgba(255, 215, 0, 0.2) !important;
        }
        .monaco-editor .current-execution-glyph {
            background-color: #FFD700 !important;
        }
    `;
    document.head.appendChild(style);
}

// Monaco editor line highlighting for current execution
function highlightCurrentLineInEditor() {
    console.log("🔍 highlightCurrentLineInEditor called");
    console.log("  - monacoEditor available:", !!monacoEditor);
    console.log("  - currentExecutionLine:", currentExecutionLine);
    console.log("  - monacoEditor.getModel():", monacoEditor?.getModel()?.getLineCount(), "lines");

    if (!monacoEditor || !currentExecutionLine) {
        console.log(
            "❌ Cannot highlight: monacoEditor =",
            !!monacoEditor,
            "currentExecutionLine =",
            currentExecutionLine
        );
        return;
    }

    try {
        console.log(`🔍 Highlighting line ${currentExecutionLine} in Monaco editor`);

        // Ensure CSS styles are added
        addMonacoHighlightStyles();

        // Clear previous decorations
        if (window.currentLineDecorations) {
            monacoEditor.deltaDecorations(window.currentLineDecorations, []);
        }

        // Add new decoration for current execution line using inline styles
        window.currentLineDecorations = monacoEditor.deltaDecorations(
            [],
            [
                {
                    range: new monaco.Range(currentExecutionLine, 1, currentExecutionLine, 1),
                    options: {
                        isWholeLine: true,
                        linesDecorationsClassName: "current-execution-glyph",
                        inlineClassName: "current-execution-line",
                        className: "current-execution-line-full",
                        minimap: {
                            color: "#FFD700",
                            position: monaco.editor.MinimapPosition.Inline,
                        },
                        overviewRuler: {
                            color: "#FFD700",
                            position: monaco.editor.OverviewRulerLane.Full,
                        },
                    },
                },
            ]
        );

        // Scroll to the current line
        monacoEditor.revealLineInCenter(currentExecutionLine);
        console.log(`✅ Successfully highlighted line ${currentExecutionLine}`);
    } catch (error) {
        console.error("Failed to highlight current line in editor:", error);
    }
}

function stripSourceLine(rawContent) {
    if (typeof rawContent !== "string") return "";
    let line = rawContent;
    line = line.replace(/[#;].*$/, "");
    line = line.replace(/\/\/.*$/, "");

    const labelPattern = /^\s*[\w.$@]+:\s*/;
    while (labelPattern.test(line)) {
        line = line.replace(labelPattern, "");
    }

    return line.trim();
}

function isExecutableContent(rawContent) {
    const content = stripSourceLine(rawContent);
    if (!content) return false;

    if (content.startsWith(".")) return false;
    if (/^\.?(macro|func|endfunc|endm)\b/i.test(content)) return false;
    if (/^\.?(align|globl|global|weak|size|type|set|equ|equiv)\b/i.test(content)) return false;

    const mnemonicMatch = content.match(/^([A-Za-z.][\w.]*)/);
    if (!mnemonicMatch) return false;

    const mnemonic = mnemonicMatch[1].toLowerCase();
    if (mnemonic.startsWith(".")) return false;

    if (RISCV_EXECUTABLE_MNEMONICS.has(mnemonic)) {
        return true;
    }

    // Fallback: if the token is not a known directive and has operands, treat as executable
    return content.split(/\s+/).length > 1;
}

function findNearestExecutableLine(lineNumber) {
    if (!monacoEditor) return lineNumber;
    const model = monacoEditor.getModel();
    if (!model) return lineNumber;

    const totalLines = model.getLineCount();
    if (totalLines === 0) return lineNumber;

    const clamp = (value) => Math.min(Math.max(value, 1), totalLines);
    const startLine = clamp(lineNumber);

    const isExecutableAt = (line) => isExecutableContent(model.getLineContent(line));

    if (isExecutableAt(startLine)) {
        return startLine;
    }

    for (let ln = startLine + 1; ln <= totalLines; ln++) {
        if (isExecutableAt(ln)) {
            return ln;
        }
    }

    for (let ln = startLine - 1; ln >= 1; ln--) {
        if (isExecutableAt(ln)) {
            return ln;
        }
    }

    return startLine;
}

// Parse current line information from 'list' command output
function parseCurrentLineFromList(listOutput) {
    if (!listOutput) return null;
    const lines = listOutput.split("\n");

    console.log("🔍 parseCurrentLineFromList called with", lines.length, "lines");
    console.log("🔍 First 3 lines:", lines.slice(0, 3));
    console.log("🔍 Last 3 lines:", lines.slice(-3));

    // Look for the new CURRENT_LINE: format first
    for (const line of lines) {
        if (line.includes("CURRENT_LINE")) {
            console.log("🎯 Found CURRENT_LINE in line:", line);
        }
        const currentLineMatch = line.match(/^CURRENT_LINE:\s*(\d+)$/);
        if (currentLineMatch) {
            const lineNumber = parseInt(currentLineMatch[1], 10);
            console.log("🎯 Matched CURRENT_LINE format! Line number:", lineNumber);
            return { lineNumber, isCurrent: true, content: "" };
        }
    }

    const entries = [];

    for (const rawLine of lines) {
        const trimmed = rawLine.trimEnd();
        if (!trimmed) continue;

        const leadingMarkerMatch = trimmed.match(/^(\*|=>)\s*(\d+)\s*(.*)$/);
        const trailingMarkerMatch = trimmed.match(/^\s*(\d+)\s*(\*|=>)\s*(.*)$/);
        const plainMatch = trimmed.match(/^\s*(\d+)\s*(.*)$/);

        let markerToken = "";
        let lineNumber = null;
        let content = "";

        if (leadingMarkerMatch) {
            markerToken = leadingMarkerMatch[1];
            lineNumber = parseInt(leadingMarkerMatch[2], 10);
            content = leadingMarkerMatch[3] || "";
        } else if (trailingMarkerMatch) {
            lineNumber = parseInt(trailingMarkerMatch[1], 10);
            markerToken = trailingMarkerMatch[2];
            content = trailingMarkerMatch[3] || "";
        } else if (plainMatch) {
            lineNumber = parseInt(plainMatch[1], 10);
            content = plainMatch[2] || "";
        }

        if (lineNumber === null || Number.isNaN(lineNumber)) {
            continue;
        }

        entries.push({
            lineNumber,
            content: content.trim(),
            isCurrent: markerToken.includes("*") || markerToken.includes("=>"),
        });
    }

    if (entries.length === 0) {
        return null;
    }

    let currentIndex = entries.findIndex((entry) => entry.isCurrent);

    if (currentIndex === -1) {
        return null;
    }

    let selected = entries[currentIndex];

    if (!isExecutableContent(selected.content)) {
        for (let i = currentIndex + 1; i < entries.length; i++) {
            if (isExecutableContent(entries[i].content)) {
                selected = entries[i];
                break;
            }
        }
    }

    if (!isExecutableContent(selected.content)) {
        for (let i = currentIndex - 1; i >= 0; i--) {
            if (isExecutableContent(entries[i].content)) {
                selected = entries[i];
                break;
            }
        }
    }

    const adjustedLineNumber = findNearestExecutableLine(selected.lineNumber);
    let displayContent = selected.content;

    if (monacoEditor) {
        const model = monacoEditor.getModel();
        if (model) {
            const candidateContent = stripSourceLine(model.getLineContent(adjustedLineNumber));
            if (candidateContent) {
                displayContent = candidateContent;
            }
        }
    }

    return {
        lineNumber: adjustedLineNumber,
        content: displayContent,
    };
}

// Check if a line contains executable code (not comment or empty)
function isExecutableLine(lineInfo) {
    if (!lineInfo) return false;
    return isExecutableContent(lineInfo.content);
}

// Function to switch to a specific panel
function switchToPanel(panelName) {
    const panelTabs = document.querySelector(".panel-tabs");
    if (!panelTabs) return;

    const targetButton = panelTabs.querySelector(`[data-panel="${panelName}"]`);
    if (!targetButton) return;

    // Update tab buttons
    panelTabs.querySelectorAll(".tab-btn").forEach((tab) => {
        tab.classList.toggle("active", tab === targetButton);
    });

    // Update panels
    const panelSelector = `${panelName}-panel`;
    document.querySelectorAll(".panel-content .panel").forEach((panel) => {
        panel.classList.toggle("active", panel.id === panelSelector);
    });
}

// Source panel functionality
function updateSourceDisplay() {
    const sourceView = document.getElementById("sourceView");
    if (!sourceView) return;

    // Get the current assembly file content from Monaco editor
    if (typeof monaco !== "undefined" && monacoEditor) {
        const sourceCode = monacoEditor.getValue();
        const lines = sourceCode.split("\n");

        let html = '<div class="source-lines">';
        lines.forEach((line, index) => {
            const lineNumber = index + 1;
            const isCurrentLine = currentExecutionLine === lineNumber;
            const hasBreakpoint = breakpoints.has(lineNumber);

            html += `<div class="source-line ${isCurrentLine ? "current-line" : ""} ${
                hasBreakpoint ? "has-breakpoint" : ""
            }" data-line="${lineNumber}">`;
            html += `<span class="source-line-number">${lineNumber
                .toString()
                .padStart(4, " ")}</span>`;
            html += `<span class="source-line-content">${
                highlightRiscVAssembly(line) || "&nbsp;"
            }</span>`;
            html += "</div>";
        });
        html += "</div>";

        sourceView.innerHTML = html;

        // Scroll to current execution line
        if (currentExecutionLine) {
            const currentLineElement = sourceView.querySelector(
                `[data-line="${currentExecutionLine}"]`
            );
            if (currentLineElement) {
                currentLineElement.scrollIntoView({ behavior: "smooth", block: "center" });
            }
        }
    } else {
        sourceView.innerHTML =
            '<div class="source-empty">No source code available. Load an assembly file to see the source.</div>';
    }
}

// RISC-V Assembly syntax highlighting
function highlightRiscVAssembly(line) {
    if (!line.trim()) return "&nbsp;";

    // RISC-V instruction patterns
    const patterns = {
        // Comments (starts with # or //)
        comment: /^(\s*)(#.*|\/\/.*)$/,
        // Labels (ends with colon)
        label: /^(\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*(:)(.*)$/,
        // Directives (starts with .)
        directive: /^(\s*)(\.[a-zA-Z][a-zA-Z0-9_]*)\s*(.*)$/,
        // Instructions with operands
        instruction: /^(\s*)([a-zA-Z][a-zA-Z0-9_]*)\s+(.*)$/,
        // Registers (x0-x31, zero, ra, sp, gp, tp, t0-t6, s0-s11, a0-a7)
        register: /(x[0-9]+|zero|ra|sp|gp|tp|t[0-6]|s[0-9]|s1[01]|a[0-7]|fp)/g,
        // Immediate values (numbers, hex)
        immediate: /(-?0x[0-9a-fA-F]+|-?[0-9]+)/g,
        // Memory operands
        memory: /([0-9]+)\(([^)]+)\)/g,
        // String literals
        string: /"([^"\\]|\\.)*"/g,
    };

    let highlighted = line;

    // Check for comment line
    const commentMatch = highlighted.match(patterns.comment);
    if (commentMatch) {
        return `${commentMatch[1]}<span class="asm-comment">${escapeHtml(commentMatch[2])}</span>`;
    }

    // Check for label
    const labelMatch = highlighted.match(patterns.label);
    if (labelMatch) {
        let remainingText = labelMatch[4] ? labelMatch[4].trim() : "";
        let highlightedRemaining = "";

        if (remainingText) {
            // Check if the remaining text is a comment
            if (remainingText.startsWith("#") || remainingText.startsWith("//")) {
                highlightedRemaining = `<span class="asm-comment">${escapeHtml(
                    remainingText
                )}</span>`;
            } else {
                // Only recurse if it's not a comment
                highlightedRemaining = highlightRiscVAssembly(remainingText);
            }
        }

        return `${labelMatch[1]}<span class="asm-label">${escapeHtml(
            labelMatch[2]
        )}</span><span class="asm-punctuation">${labelMatch[3]}</span>${
            remainingText ? " " + highlightedRemaining : ""
        }`;
    }

    // Check for directive
    const directiveMatch = highlighted.match(patterns.directive);
    if (directiveMatch) {
        let rest = directiveMatch[3];
        rest = rest.replace(patterns.string, '<span class="asm-string">$&</span>');
        rest = rest.replace(patterns.immediate, '<span class="asm-immediate">$&</span>');
        return `${directiveMatch[1]}<span class="asm-directive">${escapeHtml(
            directiveMatch[2]
        )}</span> ${rest}`;
    }

    // Check for instruction
    const instructionMatch = highlighted.match(patterns.instruction);
    if (instructionMatch) {
        let operands = instructionMatch[3];

        // Highlight registers
        operands = operands.replace(patterns.register, '<span class="asm-register">$&</span>');

        // Highlight memory operands
        operands = operands.replace(
            patterns.memory,
            '<span class="asm-immediate">$1</span>(<span class="asm-register">$2</span>)'
        );

        // Highlight immediate values that aren't already wrapped in spans
        operands = operands.replace(
            /\b(-?0x[0-9a-fA-F]+|-?[0-9]+)\b/g,
            function (match, p1, offset, string) {
                // Check if this number is already inside a span
                const before = string.substring(0, offset);
                const afterLastSpan = before.lastIndexOf("</span>");
                const lastOpenSpan = before.lastIndexOf("<span");
                if (lastOpenSpan > afterLastSpan) {
                    return match; // Already inside a span
                }
                return `<span class="asm-immediate">${p1}</span>`;
            }
        );

        // Highlight commas and other punctuation
        operands = operands.replace(/([,()])/g, '<span class="asm-punctuation">$1</span>');

        return `${instructionMatch[1]}<span class="asm-instruction">${escapeHtml(
            instructionMatch[2]
        )}</span> ${operands}`;
    }

    // Fallback for other lines
    return escapeHtml(highlighted);
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Helper function to escape HTML
function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

// Track current execution line
let currentExecutionLine = null;

// Reset function for switching files - clears all emulator state
async function resetEmulatorState() {
    console.log("🔄 Resetting emulator state for new file...");

    // Stop any running emulator
    try {
        await window.api.stopEmu();
    } catch (error) {
        // Ignore errors when stopping (emulator might not be running)
    }

    // Clear all execution state
    currentExecutionLine = null;
    previousRegisterValues = {};
    currentRegisterValues = {};
    instructionTrace = [];
    callStack = [];
    callStackLog = [];
    conditionalBreakpoints.clear();

    // Reset IDE state flags
    ideState.emulatorRunning = false;

    // Reset performance counters
    performanceCounters = {
        instructions: 0,
        cycles: 0,
        cacheHits: 0,
        cacheMisses: 0,
        branchPredictions: 0,
        branchMispredictions: 0,
    };

    // Clear all panels
    if (terminal) {
        terminal.clear();
    }

    // Reset register panel
    const registersContainer = document.getElementById("registers");
    if (registersContainer) {
        registersContainer.innerHTML = '<div class="no-registers">No register data available</div>';
    }

    // Reset memory panel
    const memoryDisplay = document.getElementById("memoryDisplay");
    if (memoryDisplay) {
        memoryDisplay.innerHTML = '<div class="memory-empty">Memory not available</div>';
    }

    // Reset source panel
    updateSourceDisplay();

    // Reset disassembly panel
    const disasmContent = document.getElementById("disasmContent");
    if (disasmContent) {
        disasmContent.innerHTML = '<div class="disasm-empty">No disassembly available</div>';
    }

    // Reset statistics panel
    const statInstructions = document.getElementById("statInstructions");
    const statCycles = document.getElementById("statCycles");
    const statCacheHits = document.getElementById("statCacheHits");
    const statCacheMisses = document.getElementById("statCacheMisses");
    const statBranchPredictions = document.getElementById("statBranchPredictions");
    const statBranchMispredictions = document.getElementById("statBranchMispredictions");

    if (statInstructions) statInstructions.textContent = "0";
    if (statCycles) statCycles.textContent = "0";
    if (statCacheHits) statCacheHits.textContent = "0";
    if (statCacheMisses) statCacheMisses.textContent = "0";
    if (statBranchPredictions) statBranchPredictions.textContent = "0";
    if (statBranchMispredictions) statBranchMispredictions.textContent = "0";

    // Reset symbols panel
    const symbolsContent = document.getElementById("symbolsContent");
    if (symbolsContent) {
        symbolsContent.innerHTML = '<div class="no-symbols">No symbols available</div>';
    }

    // Reset call stack panel
    const callstackContent = document.getElementById("callstackContent");
    const callDepth = document.getElementById("callDepth");
    if (callstackContent) {
        callstackContent.innerHTML =
            '<div class="callstack-empty"><i class="fas fa-info-circle"></i> No active function calls</div>';
    }
    if (callDepth) {
        callDepth.textContent = "0";
    }

    // Reset trace panel
    const traceContent = document.getElementById("trace-content");
    const traceCount = document.getElementById("traceCount");
    if (traceContent) {
        traceContent.innerHTML =
            '<div class="trace-header"><span>Cycle</span><span>PC</span><span>Instruction</span></div><div class="trace-empty">No instructions executed yet. Start the emulator and use step/run commands to see the trace.</div>';
    }
    if (traceCount) {
        traceCount.textContent = "0";
    }

    // Reset IDE state flags
    ideState.built = false;
    ideState.running = false;

    // Update UI
    updateButtonStates();

    console.log("✅ Emulator state reset complete");
    showNotification("IDE refreshed for new file", "info");
}

// Disassembly panel functionality
function updateDisassemblyDisplay(disasmOutput) {
    const disasmContent = document.getElementById("disasmContent");
    if (!disasmContent) return;

    // If the output is already HTML, just set it directly
    if (typeof disasmOutput === "string" && disasmOutput.includes('<div class="disasm-line">')) {
        disasmContent.innerHTML = disasmOutput;
        // Scroll to current PC if visible
        const currentPCElement = disasmContent.querySelector(".current-pc");
        if (currentPCElement) {
            currentPCElement.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        return;
    }

    let html = "";
    if (!disasmOutput) {
        disasmContent.innerHTML = '<div class="empty-message">No disassembly data available</div>';
        return;
    }
    const lines = disasmOutput.split("\n");

    lines.forEach((line) => {
        const trimmedLine = line.trim();
        if (!trimmedLine) return;

        // Parse disassembly line format: address: opcode instruction
        const match = trimmedLine.match(/^([0-9a-fA-F]+):\s*([0-9a-fA-F\s]+)\s+(.+)$/);
        if (match) {
            const [, address, opcode, instruction] = match;
            const normalizedAddr = address.toLowerCase();
            const displayAddr = `0x${normalizedAddr}`;
            const isCurrentPC =
                (currentRegisterValues["pc"] || "").toLowerCase() === normalizedAddr;

            html += `<div class="disasm-line ${
                isCurrentPC ? "current-pc" : ""
            }" data-address="${normalizedAddr}">
                <span class="disasm-addr">${displayAddr}</span>
                <span class="disasm-opcode">${opcode.trim()}</span>
                <span class="disasm-instr">${escapeHtml(instruction)}</span>
                <span class="disasm-comment"></span>
            </div>`;
        }
    });

    if (!html) {
        html =
            '<div class="disasm-empty">No disassembly available. Try entering a start address and refresh.</div>';
    }

    disasmContent.innerHTML = html;

    // Scroll to current PC if visible
    const currentPCElement = disasmContent.querySelector(".current-pc");
    if (currentPCElement) {
        currentPCElement.scrollIntoView({ behavior: "smooth", block: "center" });
    }
}

function splitInstructionComment(line) {
    const commentMarkers = [
        { token: "//", index: line.indexOf("//") },
        { token: "#", index: line.indexOf("#") },
        { token: ";", index: line.indexOf(";") },
    ].filter(({ index }) => index !== -1);

    if (commentMarkers.length === 0) {
        return { code: line.trim(), comment: "" };
    }

    commentMarkers.sort((a, b) => a.index - b.index);
    const { index } = commentMarkers[0];
    const code = line.slice(0, index).trimEnd();
    const comment = line.slice(index).trim();
    return { code: code.trim(), comment };
}

function formatOperandList(operandsText) {
    if (!operandsText) return "";

    const hasComma = operandsText.includes(",");
    const rawOperands = hasComma
        ? operandsText.split(",").map((operand) => operand.trim())
        : operandsText.split(/\s+/).map((operand) => operand.trim());

    const operands = rawOperands.filter(Boolean);
    if (operands.length === 0) return "";

    return operands
        .map((operand, index) => (index < operands.length - 1 ? `${operand},` : operand))
        .join(" ");
}

function formatRISCVAssembly(code) {
    return code
        .split("\n")
        .map((line) => {
            const { code: instructionPart, comment } = splitInstructionComment(line);
            const trimmed = instructionPart.trim();

            if (!trimmed) {
                return comment || "";
            }

            if (trimmed.startsWith(".")) {
                return comment ? `${trimmed}  ${comment}` : trimmed;
            }

            if (trimmed.endsWith(":")) {
                return comment ? `${trimmed}  ${comment}` : trimmed;
            }

            const parts = trimmed.split(/\s+/);
            if (parts.length === 0) {
                return line.trim();
            }

            const mnemonic = parts[0];
            const operandText = trimmed.slice(mnemonic.length).trim();
            const formattedOperands = formatOperandList(operandText);

            let formattedLine = `    ${mnemonic.padEnd(8)}`;
            if (formattedOperands) {
                formattedLine += ` ${formattedOperands}`;
            }

            if (comment) {
                formattedLine += `  ${comment}`;
            }

            return formattedLine;
        })
        .join("\n");
}

// Parse emulator output for trace information
function parseEmulatorOutputForTrace(chunk) {
    if (!chunk) return;
    const lines = chunk.split("\n");

    for (const line of lines) {
        const trimmedLine = line.trim();

        // Parse CURRENT_LINE format from list command: CURRENT_LINE: 4
        const currentLineMatch = trimmedLine.match(/^CURRENT_LINE:\s*(\d+)$/);
        if (currentLineMatch) {
            const rawLineNumber = parseInt(currentLineMatch[1], 10);
            const executableLine = Number.isNaN(rawLineNumber)
                ? null
                : findNearestExecutableLine(rawLineNumber);
            currentExecutionLine = executableLine ?? currentExecutionLine;
            console.log(
                `🎯 CURRENT_LINE parsed: ${rawLineNumber} -> executable: ${executableLine}`
            );
            highlightCurrentLineInEditor();
            updateSourceDisplay();
        }

        // Parse instruction execution info: [inst: 1 pc: 0, src line 4]
        const instMatch = trimmedLine.match(/\[inst:\s*(\d+)\s+pc:\s*(\d+),\s*src line\s*(\d+)\]/);
        if (instMatch) {
            const [, instCount, pc, srcLine] = instMatch;

            // Always track the current PC even when terminal output is suppressed
            currentRegisterValues["pc"] = parseInt(pc, 10).toString(16);
            performanceCounters.instructions = parseInt(instCount);

            // Update current execution line and refresh source panel
            const rawLineNumber = parseInt(srcLine, 10);
            const executableLine = Number.isNaN(rawLineNumber)
                ? null
                : findNearestExecutableLine(rawLineNumber);
            currentExecutionLine = executableLine ?? currentExecutionLine;
            updateSourceDisplay();

            // Update statistics display (PC, SP, instruction count, etc.)
            updateStatisticsPanel();
        }

        // Parse "Next:" instruction line
        const nextMatch = trimmedLine.match(/^Next:\s*(.+)$/);
        if (nextMatch) {
            const instruction = nextMatch[1].trim();
            const pc = currentRegisterValues["pc"] ? parseInt(currentRegisterValues["pc"], 16) : 0;

            // Don't add duplicate trace entries during step operations
            // The step function will handle adding the trace entry with the executed instruction
            if (!suppressTerminalOutput) {
                // Only add trace entry if not during a step operation
                addToTrace(instruction, pc, { ...currentRegisterValues });
            }

            analyzeInstructionType(instruction);
            updateInstructionTypeStats();
        }

        // Parse register changes: >> rf[x02] 0 -> 10000
        const regMatch = trimmedLine.match(
            /^>>\s*rf\[(\w+)\]\s*[0-9a-fA-Fx]+\s*->\s*([0-9a-fA-Fx]+)$/
        );
        if (regMatch) {
            const [, regName, newValue] = regMatch;
            // Convert to hex string for consistency
            const hexValue = parseInt(newValue, newValue.startsWith("0x") ? 16 : 10).toString(16);

            // Always update register values, even when terminal output is suppressed
            currentRegisterValues[regName] = hexValue;

            // Update registers display automatically
            updateRegistersFromCurrentValues();
            updateStatisticsPanel();
        }
    }
}

window.api.onOutput((chunk) => {
    const textChunk = typeof chunk === "string" ? chunk : String(chunk ?? "");

    if (terminal && !suppressTerminalOutput) {
        // Format the output before displaying
        const formattedChunk = formatTerminalOutput(textChunk);
        terminal.write(formattedChunk);
    }

    const exitMatch = textChunk.match(/\[process exited with code\s*(-?\d+)\]/i);
    if (exitMatch) {
        const parsedCode = Number.parseInt(exitMatch[1], 10);
        const exitCode = Number.isNaN(parsedCode) ? null : parsedCode;
        const wasRunning = ideState.emulatorRunning;

        ideState.emulatorRunning = false;
        currentExecutionLine = null;

        if (monacoEditor && window.currentLineDecorations) {
            monacoEditor.deltaDecorations(window.currentLineDecorations, []);
            window.currentLineDecorations = [];
        }

        const compileBtn = document.getElementById("compileAndLoad");
        if (compileBtn) {
            if (compileButtonDefaultHTML !== null) {
                compileBtn.innerHTML = compileButtonDefaultHTML;
            }
            compileBtn.disabled = !ideState.fileLoaded;
        }

        updateButtonStates();

        if (wasRunning && (exitCode === null || exitCode !== 0)) {
            const message =
                exitCode === null
                    ? "Emulator process exited"
                    : `Emulator exited with code ${exitCode}`;
            const type = exitCode === null ? "info" : "error";
            showNotification(message, type);
        }
    }

    // Parse emulator output for trace information
    parseEmulatorOutputForTrace(textChunk);
});

// Format terminal output for better readability
function formatTerminalOutput(chunk) {
    if (!chunk) return chunk;

    const normalized = chunk.replace(
        /\[inst:\s*(\d+)\s+pc:\s*(\d+),\s*src line\s*(\d+)\]/g,
        "[inst:$1, pc:$2, src:$3]"
    );

    const lines = normalized.split(/\r?\n/);
    const filtered = lines.filter((line) => !/^\s*Next:\s*/.test(line));

    // Preserve trailing newline if the original chunk ended with one
    const endsWithNewline = /\r?\n$/.test(normalized);
    let result = filtered.join("\n");
    if (endsWithNewline && (result.length > 0 || filtered.length === 0)) {
        result += "\n";
    }

    return result;
}

// RISC-V Instruction Reference Database
const riscvInstructions = {
    // RV32I Base Integer Instructions
    add: {
        name: "ADD",
        format: "add rd, rs1, rs2",
        category: "RV32I",
        description:
            "Adds the registers rs1 and rs2 and stores the result in rd. Arithmetic overflow is ignored.",
        implementation: "x[rd] = x[rs1] + x[rs2]",
        encoding: "0000000 rs2 rs1 000 rd 0110011",
        example: "add x1, x2, x3  # x1 = x2 + x3",
    },
    addi: {
        name: "ADD Immediate",
        format: "addi rd, rs1, imm",
        category: "RV32I",
        description:
            "Adds the sign-extended 12-bit immediate to register rs1. Arithmetic overflow is ignored.",
        implementation: "x[rd] = x[rs1] + sext(immediate)",
        encoding: "imm[11:0] rs1 000 rd 0010011",
        example: "addi x1, x2, 100  # x1 = x2 + 100",
    },
    sub: {
        name: "SUB",
        format: "sub rd, rs1, rs2",
        category: "RV32I",
        description:
            "Subtracts register rs2 from rs1 and stores the result in rd. Arithmetic overflow is ignored.",
        implementation: "x[rd] = x[rs1] - x[rs2]",
        encoding: "0100000 rs2 rs1 000 rd 0110011",
        example: "sub x1, x2, x3  # x1 = x2 - x3",
    },
    and: {
        name: "AND",
        format: "and rd, rs1, rs2",
        category: "RV32I",
        description: "Performs bitwise AND on registers rs1 and rs2, stores result in rd.",
        implementation: "x[rd] = x[rs1] & x[rs2]",
        encoding: "0000000 rs2 rs1 111 rd 0110011",
        example: "and x1, x2, x3  # x1 = x2 & x3",
    },
    andi: {
        name: "AND Immediate",
        format: "andi rd, rs1, imm",
        category: "RV32I",
        description:
            "Performs bitwise AND on register rs1 and sign-extended 12-bit immediate, stores result in rd.",
        implementation: "x[rd] = x[rs1] & sext(immediate)",
        encoding: "imm[11:0] rs1 111 rd 0010011",
        example: "andi x1, x2, 0xFF  # x1 = x2 & 0xFF",
    },
    or: {
        name: "OR",
        format: "or rd, rs1, rs2",
        category: "RV32I",
        description: "Performs bitwise OR on registers rs1 and rs2, stores result in rd.",
        implementation: "x[rd] = x[rs1] | x[rs2]",
        encoding: "0000000 rs2 rs1 110 rd 0110011",
        example: "or x1, x2, x3  # x1 = x2 | x3",
    },
    ori: {
        name: "OR Immediate",
        format: "ori rd, rs1, imm",
        category: "RV32I",
        description:
            "Performs bitwise OR on register rs1 and sign-extended 12-bit immediate, stores result in rd.",
        implementation: "x[rd] = x[rs1] | sext(immediate)",
        encoding: "imm[11:0] rs1 110 rd 0010011",
        example: "ori x1, x2, 0x100  # x1 = x2 | 0x100",
    },
    xor: {
        name: "XOR",
        format: "xor rd, rs1, rs2",
        category: "RV32I",
        description: "Performs bitwise XOR on registers rs1 and rs2, stores result in rd.",
        implementation: "x[rd] = x[rs1] ^ x[rs2]",
        encoding: "0000000 rs2 rs1 100 rd 0110011",
        example: "xor x1, x2, x3  # x1 = x2 ^ x3",
    },
    xori: {
        name: "XOR Immediate",
        format: "xori rd, rs1, imm",
        category: "RV32I",
        description:
            "Performs bitwise XOR on register rs1 and sign-extended 12-bit immediate, stores result in rd.",
        implementation: "x[rd] = x[rs1] ^ sext(immediate)",
        encoding: "imm[11:0] rs1 100 rd 0010011",
        example: "xori x1, x2, -1  # x1 = ~x2 (bitwise NOT)",
    },
    sll: {
        name: "Shift Left Logical",
        format: "sll rd, rs1, rs2",
        category: "RV32I",
        description: "Performs logical left shift on rs1 by the amount in lower 5 bits of rs2.",
        implementation: "x[rd] = x[rs1] << x[rs2][4:0]",
        encoding: "0000000 rs2 rs1 001 rd 0110011",
        example: "sll x1, x2, x3  # x1 = x2 << x3",
    },
    slli: {
        name: "Shift Left Logical Immediate",
        format: "slli rd, rs1, shamt",
        category: "RV32I",
        description: "Performs logical left shift on rs1 by immediate amount (0-31).",
        implementation: "x[rd] = x[rs1] << shamt",
        encoding: "0000000 shamt rs1 001 rd 0010011",
        example: "slli x1, x2, 4  # x1 = x2 << 4",
    },
    srl: {
        name: "Shift Right Logical",
        format: "srl rd, rs1, rs2",
        category: "RV32I",
        description: "Performs logical right shift on rs1 by the amount in lower 5 bits of rs2.",
        implementation: "x[rd] = x[rs1] >> x[rs2][4:0]",
        encoding: "0000000 rs2 rs1 101 rd 0110011",
        example: "srl x1, x2, x3  # x1 = x2 >> x3",
    },
    srli: {
        name: "Shift Right Logical Immediate",
        format: "srli rd, rs1, shamt",
        category: "RV32I",
        description: "Performs logical right shift on rs1 by immediate amount (0-31).",
        implementation: "x[rd] = x[rs1] >> shamt",
        encoding: "0000000 shamt rs1 101 rd 0010011",
        example: "srli x1, x2, 4  # x1 = x2 >> 4",
    },
    sra: {
        name: "Shift Right Arithmetic",
        format: "sra rd, rs1, rs2",
        category: "RV32I",
        description: "Performs arithmetic right shift on rs1 by the amount in lower 5 bits of rs2.",
        implementation: "x[rd] = x[rs1] >>s x[rs2][4:0]",
        encoding: "0100000 rs2 rs1 101 rd 0110011",
        example: "sra x1, x2, x3  # x1 = x2 >>s x3",
    },
    srai: {
        name: "Shift Right Arithmetic Immediate",
        format: "srai rd, rs1, shamt",
        category: "RV32I",
        description: "Performs arithmetic right shift on rs1 by immediate amount (0-31).",
        implementation: "x[rd] = x[rs1] >>s shamt",
        encoding: "0100000 shamt rs1 101 rd 0010011",
        example: "srai x1, x2, 4  # x1 = x2 >>s 4",
    },
    slt: {
        name: "Set Less Than",
        format: "slt rd, rs1, rs2",
        category: "RV32I",
        description: "Sets rd to 1 if rs1 < rs2 (signed comparison), otherwise 0.",
        implementation: "x[rd] = (x[rs1] <s x[rs2]) ? 1 : 0",
        encoding: "0000000 rs2 rs1 010 rd 0110011",
        example: "slt x1, x2, x3  # x1 = (x2 < x3) ? 1 : 0",
    },
    slti: {
        name: "Set Less Than Immediate",
        format: "slti rd, rs1, imm",
        category: "RV32I",
        description: "Sets rd to 1 if rs1 < immediate (signed comparison), otherwise 0.",
        implementation: "x[rd] = (x[rs1] <s sext(immediate)) ? 1 : 0",
        encoding: "imm[11:0] rs1 010 rd 0010011",
        example: "slti x1, x2, 100  # x1 = (x2 < 100) ? 1 : 0",
    },
    sltu: {
        name: "Set Less Than Unsigned",
        format: "sltu rd, rs1, rs2",
        category: "RV32I",
        description: "Sets rd to 1 if rs1 < rs2 (unsigned comparison), otherwise 0.",
        implementation: "x[rd] = (x[rs1] <u x[rs2]) ? 1 : 0",
        encoding: "0000000 rs2 rs1 011 rd 0110011",
        example: "sltu x1, x2, x3  # x1 = (x2 <u x3) ? 1 : 0",
    },
    sltiu: {
        name: "Set Less Than Immediate Unsigned",
        format: "sltiu rd, rs1, imm",
        category: "RV32I",
        description: "Sets rd to 1 if rs1 < immediate (unsigned comparison), otherwise 0.",
        implementation: "x[rd] = (x[rs1] <u sext(immediate)) ? 1 : 0",
        encoding: "imm[11:0] rs1 011 rd 0010011",
        example: "sltiu x1, x2, 100  # x1 = (x2 <u 100) ? 1 : 0",
    },
    lb: {
        name: "Load Byte",
        format: "lb rd, offset(rs1)",
        category: "RV32I",
        description:
            "Loads a 8-bit value from memory and sign-extends to 32-bits before storing in rd.",
        implementation: "x[rd] = sext(M[x[rs1] + sext(offset)][7:0])",
        encoding: "imm[11:0] rs1 000 rd 0000011",
        example: "lb x1, 4(x2)  # x1 = sign_extend(mem[x2 + 4])",
    },
    lh: {
        name: "Load Halfword",
        format: "lh rd, offset(rs1)",
        category: "RV32I",
        description:
            "Loads a 16-bit value from memory and sign-extends to 32-bits before storing in rd.",
        implementation: "x[rd] = sext(M[x[rs1] + sext(offset)][15:0])",
        encoding: "imm[11:0] rs1 001 rd 0000011",
        example: "lh x1, 4(x2)  # x1 = sign_extend(mem[x2 + 4])",
    },
    lw: {
        name: "Load Word",
        format: "lw rd, offset(rs1)",
        category: "RV32I",
        description: "Loads a 32-bit value from memory into rd.",
        implementation: "x[rd] = M[x[rs1] + sext(offset)][31:0]",
        encoding: "imm[11:0] rs1 010 rd 0000011",
        example: "lw x1, 4(x2)  # x1 = mem[x2 + 4]",
    },
    // Removed duplicate lbu and lhu entries - kept the ones in the load/store section
    sb: {
        name: "Store Byte",
        format: "sb rs2, offset(rs1)",
        category: "RV32I",
        description: "Stores the lower 8 bits of rs2 to memory.",
        implementation: "M[x[rs1] + sext(offset)] = x[rs2][7:0]",
        encoding: "imm[11:5] rs2 rs1 000 imm[4:0] 0100011",
        example: "sb x2, 4(x1)  # mem[x1 + 4] = x2[7:0]",
    },
    sh: {
        name: "Store Halfword",
        format: "sh rs2, offset(rs1)",
        category: "RV32I",
        description: "Stores the lower 16 bits of rs2 to memory.",
        implementation: "M[x[rs1] + sext(offset)] = x[rs2][15:0]",
        encoding: "imm[11:5] rs2 rs1 001 imm[4:0] 0100011",
        example: "sh x2, 4(x1)  # mem[x1 + 4] = x2[15:0]",
    },
    sw: {
        name: "Store Word",
        format: "sw rs2, offset(rs1)",
        category: "RV32I",
        description: "Stores 32 bits of rs2 to memory.",
        implementation: "M[x[rs1] + sext(offset)] = x[rs2][31:0]",
        encoding: "imm[11:5] rs2 rs1 010 imm[4:0] 0100011",
        example: "sw x2, 4(x1)  # mem[x1 + 4] = x2",
    },
    beq: {
        name: "Branch Equal",
        format: "beq rs1, rs2, offset",
        category: "RV32I",
        description: "Takes the branch if registers rs1 and rs2 are equal.",
        implementation: "if (x[rs1] == x[rs2]) pc += sext(offset)",
        encoding: "imm[12|10:5] rs2 rs1 000 imm[4:1|11] 1100011",
        example: "beq x1, x2, loop  # if x1 == x2, goto loop",
    },
    bne: {
        name: "Branch Not Equal",
        format: "bne rs1, rs2, offset",
        category: "RV32I",
        description: "Takes the branch if registers rs1 and rs2 are not equal.",
        implementation: "if (x[rs1] != x[rs2]) pc += sext(offset)",
        encoding: "imm[12|10:5] rs2 rs1 001 imm[4:1|11] 1100011",
        example: "bne x1, x2, loop  # if x1 != x2, goto loop",
    },
    blt: {
        name: "Branch Less Than",
        format: "blt rs1, rs2, offset",
        category: "RV32I",
        description: "Takes the branch if rs1 < rs2 (signed comparison).",
        implementation: "if (x[rs1] <s x[rs2]) pc += sext(offset)",
        encoding: "imm[12|10:5] rs2 rs1 100 imm[4:1|11] 1100011",
        example: "blt x1, x2, loop  # if x1 < x2, goto loop",
    },
    bge: {
        name: "Branch Greater Equal",
        format: "bge rs1, rs2, offset",
        category: "RV32I",
        description: "Takes the branch if rs1 >= rs2 (signed comparison).",
        implementation: "if (x[rs1] >=s x[rs2]) pc += sext(offset)",
        encoding: "imm[12|10:5] rs2 rs1 101 imm[4:1|11] 1100011",
        example: "bge x1, x2, loop  # if x1 >= x2, goto loop",
    },
    // Removed duplicate bgeu entry - kept the one in the branch instructions section
    jal: {
        name: "Jump And Link",
        format: "jal rd, offset",
        category: "RV32I",
        description: "Jumps to address pc+offset and stores pc+4 in rd.",
        implementation: "x[rd] = pc+4; pc += sext(offset)",
        encoding: "imm[20|10:1|11|19:12] rd 1101111",
        example: "jal x1, function  # call function, return addr in x1",
    },
    jalr: {
        name: "Jump And Link Register",
        format: "jalr rd, rs1, offset",
        category: "RV32I",
        description: "Jumps to address rs1+offset and stores pc+4 in rd.",
        implementation: "t=pc+4; pc=(x[rs1]+sext(offset))&~1; x[rd]=t",
        encoding: "imm[11:0] rs1 000 rd 1100111",
        example: "jalr x0, x1, 0  # jump to address in x1",
    },
    lui: {
        name: "Load Upper Immediate",
        format: "lui rd, imm",
        category: "RV32I",
        description: "Loads 20-bit immediate into upper 20 bits of rd, zeros lower 12 bits.",
        implementation: "x[rd] = sext(immediate[31:12] << 12)",
        encoding: "imm[31:12] rd 0110111",
        example: "lui x1, 0x12345  # x1 = 0x12345000",
    },
    auipc: {
        name: "Add Upper Immediate to PC",
        format: "auipc rd, imm",
        category: "RV32I",
        description: "Adds 20-bit immediate shifted left 12 bits to pc and stores result in rd.",
        implementation: "x[rd] = pc + sext(immediate[31:12] << 12)",
        encoding: "imm[31:12] rd 0010111",
        example: "auipc x1, 0x12345  # x1 = pc + 0x12345000",
    },
    nop: {
        name: "No Operation",
        format: "nop",
        category: "RV32I",
        description: "Does nothing. Encoded as addi x0, x0, 0.",
        implementation: "// No operation",
        encoding: "000000000000 00000 000 00000 0010011",
        example: "nop  # do nothing",
    beqz: {
        name: "Branch if Equal to Zero",
        format: "beqz rs1, offset",
        category: "Pseudo",
        description: "Takes the branch if register rs1 equals zero. Pseudo-instruction for beq rs1, x0, offset.",
        implementation: "if (x[rs1] == 0) pc += sext(offset)",
        encoding: "beq rs1, x0, offset",
        example: "beqz x1, loop  # if x1 == 0, goto loop",
    },
    bnez: {
        name: "Branch if Not Equal to Zero",
        format: "bnez rs1, offset",
        category: "Pseudo",
        description: "Takes the branch if register rs1 is not equal to zero. Pseudo-instruction for bne rs1, x0, offset.",
        implementation: "if (x[rs1] != 0) pc += sext(offset)",
        encoding: "bne rs1, x0, offset",
        example: "bnez x1, loop  # if x1 != 0, goto loop",
    },
    ret: {
        name: "Return from subroutine",
        format: "ret",
        category: "Pseudo",
        description: "Returns from a subroutine. Pseudo-instruction for jalr x0, x1, 0 (jump to address in ra).",
        implementation: "pc = x[ra]",
        encoding: "jalr x0, x1, 0",
        example: "ret  # return from function",
    },
    j: {
        name: "Jump",
        format: "j offset",
        category: "Pseudo",
        description: "Unconditional jump. Pseudo-instruction for jal x0, offset.",
        implementation: "pc += sext(offset)",
        encoding: "jal x0, offset",
        example: "j loop  # jump to loop",
    },
    jr: {
        name: "Jump Register",
        format: "jr rs1",
        category: "Pseudo",
        description: "Jump to address in register. Pseudo-instruction for jalr x0, rs1, 0.",
        implementation: "pc = x[rs1]",
        encoding: "jalr x0, rs1, 0",
        example: "jr x1  # jump to address in x1",
    },
    call: {
        name: "Call subroutine",
        format: "call offset",
        category: "Pseudo",
        description: "Call a subroutine. Pseudo-instruction that expands to auipc+jalr.",
        implementation: "x[ra] = pc+4; pc += sext(offset)",
        encoding: "auipc/jalr sequence",
        example: "call function  # call function",
    },
    li: {
        name: "Load Immediate",
        format: "li rd, imm",
        category: "Pseudo",
        description: "Load immediate value into register. Expands to lui+addi or just addi for small values.",
        implementation: "x[rd] = immediate",
        encoding: "lui/addi sequence",
        example: "li x1, 0x12345  # x1 = 0x12345",
    },
    la: {
        name: "Load Address",
        format: "la rd, symbol",
        category: "Pseudo",
        description: "Load address of symbol. Expands to auipc+addi.",
        implementation: "x[rd] = address_of(symbol)",
        encoding: "auipc/addi sequence",
        example: "la x1, data  # x1 = address of data",
    },
    mv: {
        name: "Move",
        format: "mv rd, rs",
        category: "Pseudo",
        description: "Copy register. Pseudo-instruction for addi rd, rs, 0.",
        implementation: "x[rd] = x[rs]",
        encoding: "addi rd, rs, 0",
        example: "mv x1, x2  # x1 = x2",
    },
    },

    // Additional Load/Store Instructions
    lbu: {
        name: "Load Byte Unsigned",
        format: "lbu rd, offset(rs1)",
        category: "RV32I",
        description:
            "Load 8-bit value from memory and zero-extend to 32-bits before storing in rd.",
        implementation: "x[rd] = zext(M[x[rs1] + sext(offset)][7:0])",
        encoding: "imm[11:0] rs1 100 rd 0000011",
        example: "lbu x1, 0(x2)  # x1 = zero_extend(memory[x2])",
    },
    lhu: {
        name: "Load Halfword Unsigned",
        format: "lhu rd, offset(rs1)",
        category: "RV32I",
        description:
            "Load 16-bit value from memory and zero-extend to 32-bits before storing in rd.",
        implementation: "x[rd] = zext(M[x[rs1] + sext(offset)][15:0])",
        encoding: "imm[11:0] rs1 101 rd 0000011",
        example: "lhu x1, 0(x2)  # x1 = zero_extend(memory[x2:x2+1])",
    },

    // Shift Instructions
    sll: {
        name: "Shift Left Logical",
        format: "sll rd, rs1, rs2",
        category: "RV32I",
        description: "Shift rs1 left by the number of bits specified in the lower 5 bits of rs2.",
        implementation: "x[rd] = x[rs1] << x[rs2][4:0]",
        encoding: "0000000 rs2 rs1 001 rd 0110011",
        example: "sll x1, x2, x3  # x1 = x2 << (x3 & 0x1f)",
    },
    srl: {
        name: "Shift Right Logical",
        format: "srl rd, rs1, rs2",
        category: "RV32I",
        description: "Shift rs1 right by the number of bits specified in the lower 5 bits of rs2.",
        implementation: "x[rd] = x[rs1] >> x[rs2][4:0]",
        encoding: "0000000 rs2 rs1 101 rd 0110011",
        example: "srl x1, x2, x3  # x1 = x2 >> (x3 & 0x1f)",
    },
    sra: {
        name: "Shift Right Arithmetic",
        format: "sra rd, rs1, rs2",
        category: "RV32I",
        description:
            "Shift rs1 right by the number of bits specified in the lower 5 bits of rs2, preserving sign.",
        implementation: "x[rd] = x[rs1] >>> x[rs2][4:0]",
        encoding: "0100000 rs2 rs1 101 rd 0110011",
        example: "sra x1, x2, x3  # x1 = x2 >>> (x3 & 0x1f)",
    },
    srli: {
        name: "Shift Right Logical Immediate",
        format: "srli rd, rs1, shamt",
        category: "RV32I",
        description: "Shift rs1 right by immediate amount (0-31).",
        implementation: "x[rd] = x[rs1] >> shamt",
        encoding: "000000 shamt rs1 101 rd 0010011",
        example: "srli x1, x2, 4  # x1 = x2 >> 4",
    },
    srai: {
        name: "Shift Right Arithmetic Immediate",
        format: "srai rd, rs1, shamt",
        category: "RV32I",
        description: "Shift rs1 right by immediate amount (0-31), preserving sign.",
        implementation: "x[rd] = x[rs1] >>> shamt",
        encoding: "010000 shamt rs1 101 rd 0010011",
        example: "srai x1, x2, 4  # x1 = x2 >>> 4",
    },

    // Comparison Instructions
    slt: {
        name: "Set Less Than",
        format: "slt rd, rs1, rs2",
        category: "RV32I",
        description: "Set rd to 1 if rs1 < rs2 (signed), otherwise 0.",
        implementation: "x[rd] = (x[rs1] < x[rs2]) ? 1 : 0",
        encoding: "0000000 rs2 rs1 010 rd 0110011",
        example: "slt x1, x2, x3  # x1 = (x2 < x3) ? 1 : 0",
    },
    sltu: {
        name: "Set Less Than Unsigned",
        format: "sltu rd, rs1, rs2",
        category: "RV32I",
        description: "Set rd to 1 if rs1 < rs2 (unsigned), otherwise 0.",
        implementation: "x[rd] = (x[rs1] <u x[rs2]) ? 1 : 0",
        encoding: "0000000 rs2 rs1 011 rd 0110011",
        example: "sltu x1, x2, x3  # x1 = (x2 <u x3) ? 1 : 0",
    },
    slti: {
        name: "Set Less Than Immediate",
        format: "slti rd, rs1, imm",
        category: "RV32I",
        description: "Set rd to 1 if rs1 < sign-extended immediate (signed), otherwise 0.",
        implementation: "x[rd] = (x[rs1] < sext(immediate)) ? 1 : 0",
        encoding: "imm[11:0] rs1 010 rd 0010011",
        example: "slti x1, x2, 100  # x1 = (x2 < 100) ? 1 : 0",
    },
    sltiu: {
        name: "Set Less Than Immediate Unsigned",
        format: "sltiu rd, rs1, imm",
        category: "RV32I",
        description: "Set rd to 1 if rs1 < sign-extended immediate (unsigned), otherwise 0.",
        implementation: "x[rd] = (x[rs1] <u sext(immediate)) ? 1 : 0",
        encoding: "imm[11:0] rs1 011 rd 0010011",
        example: "sltiu x1, x2, 100  # x1 = (x2 <u 100) ? 1 : 0",
    },

    // Branch Instructions
    bltu: {
        name: "Branch Less Than Unsigned",
        format: "bltu rs1, rs2, offset",
        category: "RV32I",
        description: "Branch to PC+offset if rs1 < rs2 (unsigned comparison).",
        implementation: "if (x[rs1] <u x[rs2]) pc += sext(offset)",
        encoding: "imm[12|10:5] rs2 rs1 110 imm[4:1|11] 1100011",
        example: "bltu x1, x2, loop  # if x1 < x2 (unsigned) goto loop",
    },
    bgeu: {
        name: "Branch Greater Equal Unsigned",
        format: "bgeu rs1, rs2, offset",
        category: "RV32I",
        description: "Branch to PC+offset if rs1 >= rs2 (unsigned comparison).",
        implementation: "if (x[rs1] >=u x[rs2]) pc += sext(offset)",
        encoding: "imm[12|10:5] rs2 rs1 111 imm[4:1|11] 1100011",
        example: "bgeu x1, x2, done  # if x1 >= x2 (unsigned) goto done",
    },

    // M Extension - Multiplication and Division
    mul: {
        name: "Multiply",
        format: "mul rd, rs1, rs2",
        category: "RV32M",
        description: "Multiply rs1 and rs2, store lower 32 bits in rd.",
        implementation: "x[rd] = (x[rs1] * x[rs2])[31:0]",
        encoding: "0000001 rs2 rs1 000 rd 0110011",
        example: "mul x1, x2, x3  # x1 = (x2 * x3) & 0xFFFFFFFF",
    },
    mulh: {
        name: "Multiply High",
        format: "mulh rd, rs1, rs2",
        category: "RV32M",
        description: "Multiply rs1 and rs2 (signed), store upper 32 bits in rd.",
        implementation: "x[rd] = (x[rs1] * x[rs2])[63:32]",
        encoding: "0000001 rs2 rs1 001 rd 0110011",
        example: "mulh x1, x2, x3  # x1 = upper 32 bits of x2 * x3",
    },
    mulhu: {
        name: "Multiply High Unsigned",
        format: "mulhu rd, rs1, rs2",
        category: "RV32M",
        description: "Multiply rs1 and rs2 (unsigned), store upper 32 bits in rd.",
        implementation: "x[rd] = (x[rs1] *u x[rs2])[63:32]",
        encoding: "0000001 rs2 rs1 011 rd 0110011",
        example: "mulhu x1, x2, x3  # x1 = upper 32 bits of x2 *u x3",
    },
    mulhsu: {
        name: "Multiply High Signed-Unsigned",
        format: "mulhsu rd, rs1, rs2",
        category: "RV32M",
        description: "Multiply rs1 (signed) and rs2 (unsigned), store upper 32 bits in rd.",
        implementation: "x[rd] = (x[rs1] *su x[rs2])[63:32]",
        encoding: "0000001 rs2 rs1 010 rd 0110011",
        example: "mulhsu x1, x2, x3  # x1 = upper 32 bits of x2 *su x3",
    },
    div: {
        name: "Divide",
        format: "div rd, rs1, rs2",
        category: "RV32M",
        description: "Divide rs1 by rs2 (signed), store quotient in rd.",
        implementation: "x[rd] = x[rs1] / x[rs2]",
        encoding: "0000001 rs2 rs1 100 rd 0110011",
        example: "div x1, x2, x3  # x1 = x2 / x3",
    },
    divu: {
        name: "Divide Unsigned",
        format: "divu rd, rs1, rs2",
        category: "RV32M",
        description: "Divide rs1 by rs2 (unsigned), store quotient in rd.",
        implementation: "x[rd] = x[rs1] /u x[rs2]",
        encoding: "0000001 rs2 rs1 101 rd 0110011",
        example: "divu x1, x2, x3  # x1 = x2 /u x3",
    },
    rem: {
        name: "Remainder",
        format: "rem rd, rs1, rs2",
        category: "RV32M",
        description: "Remainder of rs1 divided by rs2 (signed), store in rd.",
        implementation: "x[rd] = x[rs1] % x[rs2]",
        encoding: "0000001 rs2 rs1 110 rd 0110011",
        example: "rem x1, x2, x3  # x1 = x2 % x3",
    },
    remu: {
        name: "Remainder Unsigned",
        format: "remu rd, rs1, rs2",
        category: "RV32M",
        description: "Remainder of rs1 divided by rs2 (unsigned), store in rd.",
        implementation: "x[rd] = x[rs1] %u x[rs2]",
        encoding: "0000001 rs2 rs1 111 rd 0110011",
        example: "remu x1, x2, x3  # x1 = x2 %u x3",
    },

    // A Extension - Atomic Instructions
    "lr.w": {
        name: "Load Reserved Word",
        format: "lr.w rd, (rs1)",
        category: "RV32A",
        description: "Load word from memory and register a reservation on the memory address.",
        implementation: "x[rd] = M[x[rs1]]; reserve(x[rs1])",
        encoding: "00010 aq rl 00000 rs1 010 rd 0101111",
        example: "lr.w x1, (x2)  # x1 = memory[x2], reserve x2",
    },
    "sc.w": {
        name: "Store Conditional Word",
        format: "sc.w rd, rs2, (rs1)",
        category: "RV32A",
        description: "Store word to memory if reservation is still valid.",
        implementation:
            "if (valid_reservation(x[rs1])) { M[x[rs1]] = x[rs2]; x[rd] = 0 } else x[rd] = 1",
        encoding: "00011 aq rl rs2 rs1 010 rd 0101111",
        example: "sc.w x1, x3, (x2)  # store x3 to memory[x2], x1 = success",
    },

    // F Extension - Single-Precision Floating-Point
    "fadd.s": {
        name: "Floating-Point Add Single",
        format: "fadd.s rd, rs1, rs2",
        category: "RV32F",
        description: "Add single-precision floating-point values.",
        implementation: "f[rd] = f[rs1] + f[rs2]",
        encoding: "0000000 rs2 rs1 rm rd 1010011",
        example: "fadd.s f1, f2, f3  # f1 = f2 + f3",
    },
    "fsub.s": {
        name: "Floating-Point Subtract Single",
        format: "fsub.s rd, rs1, rs2",
        category: "RV32F",
        description: "Subtract single-precision floating-point values.",
        implementation: "f[rd] = f[rs1] - f[rs2]",
        encoding: "0000100 rs2 rs1 rm rd 1010011",
        example: "fsub.s f1, f2, f3  # f1 = f2 - f3",
    },
    "fmul.s": {
        name: "Floating-Point Multiply Single",
        format: "fmul.s rd, rs1, rs2",
        category: "RV32F",
        description: "Multiply single-precision floating-point values.",
        implementation: "f[rd] = f[rs1] * f[rs2]",
        encoding: "0001000 rs2 rs1 rm rd 1010011",
        example: "fmul.s f1, f2, f3  # f1 = f2 * f3",
    },
    "fdiv.s": {
        name: "Floating-Point Divide Single",
        format: "fdiv.s rd, rs1, rs2",
        category: "RV32F",
        description: "Divide single-precision floating-point values.",
        implementation: "f[rd] = f[rs1] / f[rs2]",
        encoding: "0001100 rs2 rs1 rm rd 1010011",
        example: "fdiv.s f1, f2, f3  # f1 = f2 / f3",
    },

    // System Instructions
    ecall: {
        name: "Environment Call",
        format: "ecall",
        category: "RV32I",
        description: "Make a service request to the execution environment.",
        implementation: "RaiseException(EnvironmentCall)",
        encoding: "000000000000 00000 000 00000 1110011",
        example: "ecall  # system call",
    },
    ebreak: {
        name: "Environment Break",
        format: "ebreak",
        category: "RV32I",
        description: "Request transfer of control to a debugger.",
        implementation: "RaiseException(Breakpoint)",
        encoding: "000000000001 00000 000 00000 1110011",
        example: "ebreak  # debugger breakpoint",
    },
    fence: {
        name: "Fence",
        format: "fence pred, succ",
        category: "RV32I",
        description: "Synchronize memory and I/O operations.",
        implementation: "// Memory ordering constraint",
        encoding: "pred succ 00000 000 00000 0001111",
        example: "fence rw, rw  # memory barrier",
    },

    // B Extension - Bit Manipulation (ratified)
    andn: {
        name: "AND with Inverted Operand",
        format: "andn rd, rs1, rs2",
        category: "RV32B",
        description: "Bitwise AND rs1 with bitwise inverted rs2.",
        implementation: "x[rd] = x[rs1] & ~x[rs2]",
        encoding: "0100000 rs2 rs1 111 rd 0110011",
        example: "andn x1, x2, x3  # x1 = x2 & ~x3",
    },
    orn: {
        name: "OR with Inverted Operand",
        format: "orn rd, rs1, rs2",
        category: "RV32B",
        description: "Bitwise OR rs1 with bitwise inverted rs2.",
        implementation: "x[rd] = x[rs1] | ~x[rs2]",
        encoding: "0100000 rs2 rs1 110 rd 0110011",
        example: "orn x1, x2, x3  # x1 = x2 | ~x3",
    },
    xnor: {
        name: "Exclusive NOR",
        format: "xnor rd, rs1, rs2",
        category: "RV32B",
        description: "Bitwise exclusive NOR of rs1 and rs2.",
        implementation: "x[rd] = x[rs1] ^ ~x[rs2]",
        encoding: "0100000 rs2 rs1 100 rd 0110011",
        example: "xnor x1, x2, x3  # x1 = x2 ^ ~x3",
    },
    clz: {
        name: "Count Leading Zeros",
        format: "clz rd, rs",
        category: "RV32B",
        description: "Count the number of leading zero bits in rs.",
        implementation: "x[rd] = clz(x[rs])",
        encoding: "0110000 00000 rs 001 rd 0010011",
        example: "clz x1, x2  # x1 = count leading zeros in x2",
    },
    ctz: {
        name: "Count Trailing Zeros",
        format: "ctz rd, rs",
        category: "RV32B",
        description: "Count the number of trailing zero bits in rs.",
        implementation: "x[rd] = ctz(x[rs])",
        encoding: "0110000 00001 rs 001 rd 0010011",
        example: "ctz x1, x2  # x1 = count trailing zeros in x2",
    },
    cpop: {
        name: "Count Population",
        format: "cpop rd, rs",
        category: "RV32B",
        description: "Count the number of 1 bits in rs.",
        implementation: "x[rd] = popcount(x[rs])",
        encoding: "0110000 00010 rs 001 rd 0010011",
        example: "cpop x1, x2  # x1 = number of 1 bits in x2",
    },

    // Zicond Extension - Conditional Operations
    czero_eqz: {
        name: "Conditional Zero if Equal to Zero",
        format: "czero.eqz rd, rs1, rs2",
        category: "Zicond",
        description: "Set rd to zero if rs2 is zero, otherwise copy rs1 to rd.",
        implementation: "x[rd] = (x[rs2] == 0) ? 0 : x[rs1]",
        encoding: "0000111 rs2 rs1 101 rd 0110011",
        example: "czero.eqz x1, x2, x3  # x1 = x3 ? x2 : 0",
    },
    czero_nez: {
        name: "Conditional Zero if Not Equal to Zero",
        format: "czero.nez rd, rs1, rs2",
        category: "Zicond",
        description: "Set rd to zero if rs2 is not zero, otherwise copy rs1 to rd.",
        implementation: "x[rd] = (x[rs2] != 0) ? 0 : x[rs1]",
        encoding: "0000111 rs2 rs1 111 rd 0110011",
        example: "czero.nez x1, x2, x3  # x1 = x3 ? 0 : x2",
    },
};

// Removed unused updateRegisterDisplay function - using updateRegistersFromCurrentValues instead

// Update registers display from current values
function updateRegistersFromCurrentValues() {
    const registersGrid = document.getElementById("registersGrid");
    if (!registersGrid) {
        console.log("❌ Cannot update registers: registersGrid not found");
        return;
    }

    console.log("🔍 Updating registers from current values");
    console.log("Current values:", Object.keys(currentRegisterValues).length, "registers");
    console.log("Previous values:", Object.keys(previousRegisterValues).length, "registers");

    // Check if binary format is selected to use 2-column layout
    const formatSelect = document.getElementById("numberFormat");
    const format = formatSelect ? formatSelect.value : "hex";
    const isBinaryFormat = format === "bin";
    const tableClass = isBinaryFormat ? "register-table register-table-binary" : "register-table";

    let html = `<div class="${tableClass}">`;

    // Display all 32 RISC-V registers
    for (let i = 0; i < 32; i++) {
        const regName = `x${i}`;
        const currentValue = currentRegisterValues[regName] || "0";
        const previousValue = previousRegisterValues[regName];
        const changed = previousValue !== undefined && previousValue !== currentValue;

        // Debug logging for register changes
        if (changed) {
            console.log(`🔄 Register ${regName} changed: ${previousValue} → ${currentValue}`);
        }
        const roleClass = getRegisterRoleClass(i);
        const alias = getRegisterAlias(i);

        html += `<div class="register-item ${
            changed ? "changed" : ""
        } ${roleClass}" data-register="${regName}">
            <span class="reg-name">${regName}</span>
            <span class="reg-value ${changed ? "changed" : ""}">${formatNumberByDisplayOption(
            currentValue
        )}</span>
            <span class="reg-alias">${alias}</span>
        </div>`;

        // Don't update previousRegisterValues here - it breaks highlighting!
        // previousRegisterValues should only be updated when starting a new step
    }

    html += "</div>";
    registersGrid.innerHTML = html;

    // Remove highlighting after animation
    setTimeout(() => {
        const changed = registersGrid.querySelectorAll(".changed");
        changed.forEach((el) => el.classList.remove("changed"));
    }, 4000);
}

// Get RISC-V register aliases
function getRegisterAlias(regNum) {
    const aliases = {
        0: "zero",
        1: "ra",
        2: "sp",
        3: "gp",
        4: "tp",
        5: "t0",
        6: "t1",
        7: "t2",
        8: "s0/fp",
        9: "s1",
        10: "a0",
        11: "a1",
        12: "a2",
        13: "a3",
        14: "a4",
        15: "a5",
        16: "a6",
        17: "a7",
        18: "s2",
        19: "s3",
        20: "s4",
        21: "s5",
        22: "s6",
        23: "s7",
        24: "s8",
        25: "s9",
        26: "s10",
        27: "s11",
        28: "t3",
        29: "t4",
        30: "t5",
        31: "t6",
    };
    return aliases[regNum] || "";
}

// Get RISC-V register role classes for coloring
function getRegisterRoleClass(regNum) {
    const roleClasses = {
        0: "reg-role-zero", // x0 - constant value 0
        1: "reg-role-ra", // x1/ra - return address
        2: "reg-role-sp", // x2/sp - stack pointer
        3: "reg-role-gp", // x3/gp - global pointer
        4: "reg-role-tp", // x4/tp - thread pointer
        5: "reg-role-temp", // x5/t0 - temporary
        6: "reg-role-temp", // x6/t1 - temporary
        7: "reg-role-temp", // x7/t2 - temporary
        8: "reg-role-fp", // x8/s0/fp - saved/frame pointer
        9: "reg-role-saved", // x9/s1 - saved register
        10: "reg-role-argret", // x10/a0 - function argument/return value
        11: "reg-role-argret", // x11/a1 - function argument/return value
        12: "reg-role-arg", // x12/a2 - function argument
        13: "reg-role-arg", // x13/a3 - function argument
        14: "reg-role-arg", // x14/a4 - function argument
        15: "reg-role-arg", // x15/a5 - function argument
        16: "reg-role-arg", // x16/a6 - function argument
        17: "reg-role-arg", // x17/a7 - function argument
        18: "reg-role-saved", // x18/s2 - saved register
        19: "reg-role-saved", // x19/s3 - saved register
        20: "reg-role-saved", // x20/s4 - saved register
        21: "reg-role-saved", // x21/s5 - saved register
        22: "reg-role-saved", // x22/s6 - saved register
        23: "reg-role-saved", // x23/s7 - saved register
        24: "reg-role-saved", // x24/s8 - saved register
        25: "reg-role-saved", // x25/s9 - saved register
        26: "reg-role-saved", // x26/s10 - saved register
        27: "reg-role-saved", // x27/s11 - saved register
        28: "reg-role-temp", // x28/t3 - temporary
        29: "reg-role-temp", // x29/t4 - temporary
        30: "reg-role-temp", // x30/t5 - temporary
        31: "reg-role-temp", // x31/t6 - temporary
    };
    return roleClasses[regNum] || "reg-role-general";
}

// Get source assembly instruction from line number
function getSourceInstructionFromLine(lineNumber) {
    if (!monacoEditor || !lineNumber) {
        return null;
    }

    try {
        const model = monacoEditor.getModel();
        if (!model) return null;

        const lineContent = model.getLineContent(lineNumber);
        if (!lineContent) return null;

        // Remove comments and extra whitespace
        let instruction = lineContent.split("#")[0].trim();

        // Skip empty lines and labels (lines ending with :)
        if (!instruction || instruction.endsWith(":")) {
            return null;
        }

        // Remove labels from the same line (e.g., "start: li sp 0x10000" -> "li sp 0x10000")
        if (instruction.includes(":")) {
            const parts = instruction.split(":");
            if (parts.length > 1) {
                instruction = parts[1].trim();
            }
        }

        return instruction || null;
    } catch (error) {
        console.error("Error getting source instruction:", error);
        return null;
    }
}

// Get brief instruction info for terminal display
function getInstructionInfo(instructionText) {
    if (!instructionText) return null;

    // Extract the opcode (first word)
    const parts = instructionText
        .trim()
        .toLowerCase()
        .split(/[\s,]+/);
    const opcode = parts[0];

    // Look up in instruction database
    const instrInfo = riscvInstructions[opcode];
    if (!instrInfo) return null;

    return {
        name: instrInfo.name,
        format: instrInfo.format,
        description: instrInfo.description,
    };
}

// CPUlator-style instruction trace
function addToTrace(instruction, pc, registers) {
    const traceEntry = {
        timestamp: Date.now(),
        pc: pc,
        instruction: instruction,
        registers: { ...registers },
        cycle: performanceCounters.cycles++,
    };

    instructionTrace.push(traceEntry);

    // Detect and log call/return instructions for call stack
    detectCallReturnInstruction(instruction, pc, registers);

    // Keep all entries - no limit (make scrollable instead)

    updateTraceDisplay();
    updatePerformanceCounters();
}

// Detect JAL/JALR (calls) and RET (returns) for call stack logging
function detectCallReturnInstruction(instruction, pc, registers) {
    if (!instruction) return;

    const instr = instruction.trim().toLowerCase();
    const parts = instr.split(/[\s,]+/);
    const op = parts[0];

    // Detect function calls: JAL or JALR (excluding returns)
    if (op === "jal" && parts.length >= 2) {
        const rd = parts[1];
        const target = parts[2] || "";
        // jal ra, func or jal x1, func is a call
        if (rd === "ra" || rd === "x1" || rd === "x01") {
            logCallStackEvent(
                "call",
                target || "unknown",
                `0x${pc.toString(16).padStart(8, "0")}`,
                ""
            );
        }
    } else if (op === "jalr" && parts.length >= 2) {
        const rd = parts[1];
        // jalr ra, ... is a call (not a return)
        if ((rd === "ra" || rd === "x1" || rd === "x01") && parts.length >= 3) {
            logCallStackEvent("call", "indirect", `0x${pc.toString(16).padStart(8, "0")}`, "");
        }
        // jalr x0, x1, 0 or jalr zero, ra, 0 is a return
        else if (
            (rd === "zero" || rd === "x0" || rd === "x00") &&
            (parts[2] === "ra" || parts[2] === "x1" || parts[2] === "x01")
        ) {
            const ra = registers["x01"] || registers["x1"] || registers["ra"] || "0";
            logCallStackEvent(
                "return",
                "ret",
                `0x${parseInt(ra, 16).toString(16).padStart(8, "0")}`,
                ""
            );
        }
    } else if (op === "ret" || op === "jr") {
        // ret pseudo-instruction (expands to jalr x0, x1, 0)
        const ra = registers["x01"] || registers["x1"] || registers["ra"] || "0";
        logCallStackEvent(
            "return",
            "ret",
            `0x${parseInt(ra, 16).toString(16).padStart(8, "0")}`,
            ""
        );
    } else if (op === "call") {
        // call pseudo-instruction
        const target = parts[1] || "unknown";
        logCallStackEvent("call", target, `0x${pc.toString(16).padStart(8, "0")}`, "");
    }
}

function updateTraceDisplay() {
    const tracePanel = document.getElementById("trace-content");
    const traceCount = document.getElementById("traceCount");

    if (!tracePanel) return;

    // Update instruction count
    if (traceCount) {
        traceCount.textContent = instructionTrace.length;
    }

    let html =
        '<div class="trace-header"><span>Cycle</span><span>PC</span><span>Instruction</span></div>';

    if (instructionTrace.length === 0) {
        html +=
            '<div class="trace-empty">No instructions executed yet. Start the emulator and use step/run commands to see the trace.</div>';
    } else {
        // Show all instructions (make scrollable instead of cutting old entries)
        instructionTrace.forEach((entry, index) => {
            html += `<div class="trace-entry ${
                index === instructionTrace.length - 1 ? "current" : ""
            }">
                <span class="trace-cycle">${entry.cycle}</span>
                <span class="trace-pc">0x${entry.pc.toString(16).padStart(8, "0")}</span>
                <span class="trace-instruction">${entry.instruction}</span>
            </div>`;
        });
    }

    tracePanel.innerHTML = html;
    tracePanel.scrollTop = tracePanel.scrollHeight;
}

function updatePerformanceCounters() {
    performanceCounters.instructions++;
    updateStatisticsPanel();
}

// Update statistics panel display without incrementing counters
function updateStatisticsPanel() {
    // Update all statistics panel elements with better formatting
    const statInstructions = document.getElementById("statInstructions");
    if (statInstructions) {
        statInstructions.textContent = performanceCounters.instructions.toLocaleString();
    }

    const statCycles = document.getElementById("statCycles");
    if (statCycles) {
        statCycles.textContent = performanceCounters.cycles.toLocaleString();
    }

    const statPC = document.getElementById("statPC");
    if (statPC) {
        const pcValue = currentRegisterValues["pc"] || "0";
        statPC.textContent = `0x${parseInt(pcValue, 16)
            .toString(16)
            .padStart(8, "0")
            .toUpperCase()}`;
    }

    const statSP = document.getElementById("statSP");
    if (statSP) {
        const spValue =
            currentRegisterValues["x02"] ||
            currentRegisterValues["x2"] ||
            currentRegisterValues["sp"] ||
            "0";
        statSP.textContent = `0x${parseInt(spValue, 16)
            .toString(16)
            .padStart(8, "0")
            .toUpperCase()}`;
    }

    // Update instruction type counts
    updateInstructionTypeStats();
}

// Track different instruction types
let instructionStats = {
    branches: 0,
    memAccess: 0,
    arithmetic: 0,
    syscalls: 0,
};

function updateInstructionTypeStats() {
    const statBranches = document.getElementById("statBranches");
    if (statBranches) {
        statBranches.textContent = instructionStats.branches.toLocaleString();
    }

    const statMemAccess = document.getElementById("statMemAccess");
    if (statMemAccess) {
        statMemAccess.textContent = instructionStats.memAccess.toLocaleString();
    }

    const statArithmetic = document.getElementById("statArithmetic");
    if (statArithmetic) {
        statArithmetic.textContent = instructionStats.arithmetic.toLocaleString();
    }

    const statSyscalls = document.getElementById("statSyscalls");
    if (statSyscalls) {
        statSyscalls.textContent = instructionStats.syscalls.toLocaleString();
    }
}

// Analyze instruction to categorize it
function analyzeInstructionType(instruction) {
    if (!instruction) return;

    const instr = instruction.toLowerCase().split(/\s+/)[0];

    // Branch instructions
    if (["beq", "bne", "blt", "bge", "bltu", "bgeu", "jal", "jalr"].includes(instr)) {
        instructionStats.branches++;
    }
    // Load/Store instructions
    else if (["lb", "lh", "lw", "lbu", "lhu", "sb", "sh", "sw"].includes(instr)) {
        instructionStats.memAccess++;
    }
    // Arithmetic instructions
    else if (
        [
            "add",
            "addi",
            "sub",
            "mul",
            "div",
            "rem",
            "and",
            "andi",
            "or",
            "ori",
            "xor",
            "xori",
            "sll",
            "slli",
            "srl",
            "srli",
            "sra",
            "srai",
            "slt",
            "slti",
            "sltu",
            "sltiu",
        ].includes(instr)
    ) {
        instructionStats.arithmetic++;
    }
    // System calls
    else if (["ecall", "ebreak", "hcf"].includes(instr)) {
        instructionStats.syscalls++;
    }
}

async function initializeIDE() {
    console.log("🚀 Initializing IDE...");
    initTerminal();
    await initEditor();
    setupButtonHandlers();
    await loadExampleFiles();
    addQuickCommands();
    initCPUlatorFeatures();

    updateButtonStates();

    showNotification("IDE ready! Debugging enabled.", "success");
}

function initCPUlatorFeatures() {
    // Add instruction reference panel
    const instructionPanel = document.createElement("div");
    instructionPanel.className = "panel";
    instructionPanel.id = "instruction-panel";
    instructionPanel.innerHTML = `
        <div class="instruction-reference-container">
            <div class="instruction-search">
                <input id="instructionSearch" placeholder="Search instruction (e.g., add, addi, beq)" title="Search RISC-V instructions">
                <button id="searchInstruction" title="Search instruction">
                    <i class="fas fa-search"></i>
                </button>
            </div>
            <div id="instruction-details" class="instruction-details">
                <div class="instruction-welcome">
                    <h3>RISC-V Instruction Reference</h3>
                    <p>Type an instruction name above to see its documentation, encoding, and examples.</p>
                    <p><strong>Available:</strong> ${
                        Object.keys(riscvInstructions).length
                    } RV32I instructions</p>
                </div>
            </div>
        </div>
    `;

    // Add trace panel to the interface
    const tracePanel = document.createElement("div");
    tracePanel.className = "panel";
    tracePanel.id = "trace-panel";
    tracePanel.innerHTML = `
        <div class="trace-container">
            <div class="trace-controls">
                <button id="clearTrace" title="Clear instruction trace">
                    <i class="fas fa-trash"></i> Clear Trace
                </button>
                <span>Instructions: <span id="traceCount">0</span></span>
            </div>
            <div id="trace-content" class="trace-content"></div>
        </div>
    `;

    // Add tabs and panels
    const panelTabs = document.querySelector(".panel-tabs");
    const panelContent = document.querySelector(".panel-content");

    if (panelTabs && panelContent) {
        // Add instruction reference tab
        const instructionTab = document.createElement("button");
        instructionTab.className = "tab-btn";
        instructionTab.setAttribute("data-panel", "instruction");
        instructionTab.innerHTML = '<i class="fas fa-book"></i> ISA Reference';
        panelTabs.appendChild(instructionTab);

        // Add trace tab
        const traceTab = document.createElement("button");
        traceTab.className = "tab-btn";
        traceTab.setAttribute("data-panel", "trace");
        traceTab.innerHTML = '<i class="fas fa-list"></i> Trace';
        panelTabs.appendChild(traceTab);

        // Add panels to content
        panelContent.appendChild(instructionPanel);
        panelContent.appendChild(tracePanel);
    }

    // Note: Symbols panel functionality is now handled by the main event handlers

    // Add instruction lookup functionality
    document.addEventListener("click", (e) => {
        if (e.target && e.target.id === "clearTrace") {
            instructionTrace = [];
            callStackLog = [];
            performanceCounters.cycles = 0;
            performanceCounters.instructions = 0;

            // Reset instruction stats
            instructionStats.branches = 0;
            instructionStats.memAccess = 0;
            instructionStats.arithmetic = 0;
            instructionStats.syscalls = 0;

            updateTraceDisplay();
            updateCallStackLogDisplay();
            updatePerformanceCounters();
            showNotification("Instruction trace, call stack, and statistics cleared", "info");
        }

        if (e.target && e.target.id === "searchInstruction") {
            const searchTerm = document
                .getElementById("instructionSearch")
                .value.trim()
                .toLowerCase();
            if (searchTerm) {
                displayInstructionInfo(searchTerm);
            }
        }
    });

    // Add Enter key support for instruction search
    document.addEventListener("keypress", (e) => {
        if (e.target && e.target.id === "instructionSearch" && e.key === "Enter") {
            document.getElementById("searchInstruction").click();
        }
    });

    // Initialize trace display
    updateTraceDisplay();

    // Initialize source display
    updateSourceDisplay();

    // Initialize registers display
    updateRegistersFromCurrentValues();
    
    // Initialize call stack display
    updateCallStackLogDisplay();

    console.log("✅ Features initialized");
}

// Helper functions for refreshing panels with fallbacks
async function refreshSymbolsPanel() {
    try {
        // Parse symbols from the current assembly source code
        if (typeof monacoEditor !== "undefined" && monacoEditor) {
            const sourceCode = monacoEditor.getValue();
            const symbols = parseAssemblySymbols(sourceCode);
            updateSymbolsDisplayFromParsed(symbols);
        } else {
            updateSymbolsDisplayFromParsed([]);
        }
    } catch (error) {
        console.error("Error refreshing symbols panel:", error);
        updateSymbolsDisplayFromParsed([]);
    }
}

async function refreshCallStackPanel() {
    try {
        console.log("🔍 Refreshing call stack panel...");

        // Try emulator commands first for compatibility
        let result = await enqueueEmulatorCommand("info stack");
        if (result.ok && result.output && result.output.trim()) {
            console.log("✅ Got call stack from 'info stack'");
            updateCallStackDisplay(result.output);
            return;
        }

        // Fallback: try alternative commands
        const fallbackCommands = ["backtrace", "bt", "where", "stack"];
        for (const cmd of fallbackCommands) {
            console.log(`🔍 Trying command: ${cmd}`);
            result = await enqueueEmulatorCommand(cmd);
            if (result.ok && result.output && result.output.trim()) {
                console.log(`✅ Got call stack from '${cmd}'`);
                updateCallStackDisplay(result.output);
                return;
            }
        }

        // Create enhanced call stack from current state and symbols
        buildCallStackFromCurrentState();
    } catch (error) {
        console.error("Error refreshing call stack:", error);
        buildCallStackFromCurrentState();
    }
}

// Build call stack using current execution state and symbol information
function buildCallStackFromCurrentState() {
    console.log("🔍 Building call stack from current state");
    const stackEntries = [];
    const currentPC = currentRegisterValues["pc"];
    const currentSP = currentRegisterValues["sp"];

    console.log("Current PC:", currentPC, "Current SP:", currentSP);

    if (!currentPC) {
        updateCallStackDisplay(null);
        return;
    }

    // Convert PC to number for address calculations
    const pcValue = parseInt(currentPC, 16);

    // Find current function from symbols
    let currentFunction = "main";
    let currentLine = currentExecutionLine || "?";

    if (globalAssemblySymbols && globalAssemblySymbols.length > 0) {
        // Find the function containing the current PC
        const functionSymbols = globalAssemblySymbols.filter((sym) => sym.type === "function");

        for (const func of functionSymbols) {
            if (func.address && func.address <= pcValue) {
                // Check if PC is within reasonable function range (e.g., within 1KB)
                if (pcValue - func.address < 1024) {
                    currentFunction = func.name;
                    break;
                }
            }
        }
    }

    // Add current frame
    stackEntries.push({
        function: currentFunction,
        address: `0x${pcValue.toString(16).padStart(8, "0")}`,
        returnAddr: currentSP
            ? `0x${parseInt(currentSP, 16).toString(16).padStart(8, "0")}`
            : "0x00000000",
        srcLine: currentLine,
    });

    // Try to build a simple call stack based on register analysis
    // This is a simplified approach - in a real debugger we'd walk the stack
    if (currentFunction !== "main" && currentSP) {
        // Add a hypothetical caller (main function)
        const mainSymbol = globalAssemblySymbols?.find(
            (sym) => sym.type === "function" && (sym.name === "main" || sym.name === "_start")
        );

        if (mainSymbol) {
            stackEntries.push({
                function: mainSymbol.name,
                address: `0x${mainSymbol.address?.toString(16).padStart(8, "0") || "400000"}`,
                returnAddr: "0x00000000",
                srcLine: "?",
            });
        }
    }

    // Update the call stack display with our constructed stack
    callStack = stackEntries;
    updateCallStackDisplayFromEntries(stackEntries);
}

function updateSymbolsDisplay(symbolData) {
    const symbolsContent = document.getElementById("symbolsContent");
    if (!symbolsContent) return;

    let html = "";
    if (!symbolData) {
        symbolsContent.innerHTML = '<div class="empty-message">No symbols available</div>';
        return;
    }
    const lines = symbolData.split("\n");

    lines.forEach((line) => {
        if (line.trim() && line.includes(" ")) {
            const trimmedLine = line.trim();
            const parts = trimmedLine.split(/\s+/);

            if (parts.length >= 3) {
                // More robust parsing: find symbol name, address, and other fields
                // Symbol names can contain underscores, so we need to be careful
                let name,
                    address,
                    type,
                    size = "",
                    section = "";

                // Look for patterns: name address type [size] [section]
                // Address should be hex (0x...) or start with digit
                let addressIndex = -1;
                for (let i = 0; i < parts.length; i++) {
                    if (parts[i].match(/^(0x[0-9a-fA-F]+|[0-9]+)$/)) {
                        addressIndex = i;
                        break;
                    }
                }

                if (addressIndex > 0) {
                    // Everything before addressIndex is the symbol name
                    name = parts.slice(0, addressIndex).join("_");
                    address = parts[addressIndex];
                    type = parts[addressIndex + 1] || "";
                    size = parts[addressIndex + 2] || "";
                    section = parts[addressIndex + 3] || "";
                } else {
                    // Fallback to old parsing
                    [name, address, type, size = "", section = ""] = parts;
                }

                html += `<div class="symbol-entry">
                    <span class="symbol-name">${name}</span>
                    <span class="symbol-address">${address}</span>
                    <span class="symbol-type">${type}</span>
                    <span class="symbol-size">${size}</span>
                    <span class="symbol-section">${section}</span>
                </div>`;
            }
        }
    });

    if (html) {
        symbolsContent.innerHTML = html;
    } else {
        symbolsContent.innerHTML = '<div class="no-symbols">No symbols available</div>';
    }
}

function parseAssemblySymbols(sourceCode) {
    const symbols = [];
    const lines = sourceCode.split("\n");
    let currentAddress = 0x400000; // Default starting address for text section
    let inDataSection = false;
    let inTextSection = true;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith("#") || line.startsWith("//") || line.startsWith(";")) {
            continue; // Skip comments and empty lines
        }

        // Check for section directives
        if (line.startsWith(".")) {
            if (line.includes(".data")) {
                inDataSection = true;
                inTextSection = false;
                currentAddress = 0x10000000; // Default data section address
                continue;
            } else if (line.includes(".text")) {
                inDataSection = false;
                inTextSection = true;
                currentAddress = 0x400000; // Default text section address
                continue;
            } else if (line.includes(".section")) {
                // Handle custom sections
                const sectionMatch = line.match(/\.section\s+([^\s,]+)/);
                if (sectionMatch) {
                    const sectionName = sectionMatch[1];
                    inDataSection = sectionName.includes("data");
                    inTextSection = sectionName.includes("text") || sectionName.includes("code");
                }
                continue;
            }
        }

        // Check for labels (ending with colon)
        const labelMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):(.*)$/);
        if (labelMatch) {
            const labelName = labelMatch[1];
            const rest = labelMatch[2].trim();

            let symbolType = "label";
            let size = "4";
            let section = inDataSection ? ".data" : ".text";

            // Determine symbol type based on context
            if (inDataSection) {
                if (rest.includes(".word") || rest.includes(".dword") || rest.includes(".quad")) {
                    symbolType = "data";
                    size = rest.includes(".dword") ? "8" : rest.includes(".quad") ? "8" : "4";
                } else if (
                    rest.includes(".byte") ||
                    rest.includes(".ascii") ||
                    rest.includes(".string")
                ) {
                    symbolType = "data";
                    size = "1";
                } else if (rest.includes(".space") || rest.includes(".skip")) {
                    symbolType = "bss";
                    const spaceMatch = rest.match(/\.(?:space|skip)\s+(\d+)/);
                    size = spaceMatch ? spaceMatch[1] : "4";
                }
            } else if (inTextSection) {
                // Check if it's likely a function (followed by instructions)
                for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
                    const nextLine = lines[j].trim();
                    if (
                        nextLine &&
                        !nextLine.startsWith(".") &&
                        !nextLine.includes(":") &&
                        (nextLine.includes("addi") ||
                            nextLine.includes("li") ||
                            nextLine.includes("mv") ||
                            nextLine.includes("lw") ||
                            nextLine.includes("sw") ||
                            nextLine.includes("j"))
                    ) {
                        symbolType = "function";
                        break;
                    }
                }
            }

            symbols.push({
                name: labelName,
                address: `0x${currentAddress.toString(16).padStart(8, "0")}`,
                type: symbolType,
                size: size,
                section: section,
                line: i + 1,
            });

            // Advance address based on what follows the label
            if (rest && !rest.startsWith(".")) {
                currentAddress += 4; // Instructions are 4 bytes
            }
        } else {
            // Regular instruction or data declaration
            if (line.includes(".word") || line.includes(".dword") || line.includes(".quad")) {
                const count = (line.match(/,/g) || []).length + 1;
                currentAddress +=
                    line.includes(".dword") || line.includes(".quad") ? count * 8 : count * 4;
            } else if (line.includes(".byte")) {
                const count = (line.match(/,/g) || []).length + 1;
                currentAddress += count;
            } else if (line.includes(".ascii") || line.includes(".string")) {
                const stringMatch = line.match(/"([^"]*)"/);
                if (stringMatch) {
                    currentAddress += stringMatch[1].length + (line.includes(".string") ? 1 : 0);
                }
            } else if (line.includes(".space") || line.includes(".skip")) {
                const spaceMatch = line.match(/\.(?:space|skip)\s+(\d+)/);
                if (spaceMatch) {
                    currentAddress += parseInt(spaceMatch[1]);
                }
            } else if (!line.startsWith(".") && line.includes(" ")) {
                // Regular instruction
                currentAddress += 4;
            }
        }
    }

    return symbols;
}

function updateSymbolsDisplayFromParsed(symbols) {
    const symbolsContent = document.getElementById("symbolsContent");
    if (!symbolsContent) return;

    // Store symbols globally for other panels to use
    globalAssemblySymbols = symbols;

    // Apply current filter
    const filterSelect = document.getElementById("symbolFilter");
    const currentFilter = filterSelect ? filterSelect.value : "all";

    let filteredSymbols = symbols;
    if (currentFilter !== "all") {
        filteredSymbols = symbols.filter((symbol) => {
            switch (currentFilter) {
                case "functions":
                    return symbol.type === "function";
                case "labels":
                    return symbol.type === "label";
                case "data":
                    return symbol.type === "data" || symbol.type === "bss";
                default:
                    return true;
            }
        });
    }

    let html = "";
    if (filteredSymbols.length === 0) {
        html = '<div class="empty-message">No symbols found</div>';
    } else {
        filteredSymbols.forEach((symbol) => {
            const typeClass =
                symbol.type === "function"
                    ? "symbol-function"
                    : symbol.type === "data"
                    ? "symbol-data"
                    : symbol.type === "bss"
                    ? "symbol-bss"
                    : "symbol-label";

            html += `<div class="symbol-entry ${typeClass}">
                <span class="symbol-name" title="Line ${symbol.line}">${symbol.name}</span>
                <span class="symbol-address">${symbol.address}</span>
                <span class="symbol-type">${symbol.type}</span>
                <span class="symbol-size">${symbol.size}</span>
                <span class="symbol-section">${symbol.section}</span>
            </div>`;
        });
    }

    symbolsContent.innerHTML = html;

    // Add click handlers for navigation
    symbolsContent.querySelectorAll(".symbol-entry").forEach((entry) => {
        entry.addEventListener("click", () => {
            const symbolName = entry.querySelector(".symbol-name").textContent;
            const lineNumber = entry.querySelector(".symbol-name").getAttribute("title");
            if (lineNumber && monacoEditor) {
                const line = parseInt(lineNumber.replace("Line ", ""));
                monacoEditor.revealLineInCenter(line);
                monacoEditor.setPosition({ lineNumber: line, column: 1 });
                showNotification(`Navigated to ${symbolName}`, "info");
            }
        });
    });
}

function displayInstructionInfo(instructionName) {
    const detailsContainer = document.getElementById("instruction-details");
    if (!detailsContainer) return;

    const instruction = riscvInstructions[instructionName.toLowerCase()];

    if (!instruction) {
        // Search for partial matches
        const matches = Object.keys(riscvInstructions).filter(
            (key) =>
                key.includes(instructionName.toLowerCase()) ||
                riscvInstructions[key].name.toLowerCase().includes(instructionName.toLowerCase())
        );

        if (matches.length === 0) {
            detailsContainer.innerHTML = `
                <div class="instruction-not-found">
                    <h3>Instruction "${instructionName}" not found</h3>
                    <p>Available instructions: ${Object.keys(riscvInstructions).join(", ")}</p>
                </div>
            `;
        } else {
            detailsContainer.innerHTML = `
                <div class="instruction-suggestions">
                    <h3>Did you mean one of these?</h3>
                    ${matches
                        .map(
                            (match) => `
                        <div class="suggestion-item" onclick="displayInstructionInfo('${match}')">
                            <strong>${match}</strong> - ${riscvInstructions[match].name}
                        </div>
                    `
                        )
                        .join("")}
                </div>
            `;
        }
        return;
    }

    detailsContainer.innerHTML = `
        <div class="instruction-info">
            <div class="instruction-header">
                <h2>${escapeHtml(instruction.name)}</h2>
                <span class="instruction-category">${escapeHtml(instruction.category)}</span>
            </div>

            <div class="instruction-section">
                <h3>Format</h3>
                <code class="instruction-format">${escapeHtml(instruction.format)}</code>
            </div>

            <div class="instruction-section">
                <h3>Description</h3>
                <div class="instruction-description">${escapeHtml(instruction.description)}</div>
            </div>

            <div class="instruction-section">
                <h3>Implementation</h3>
                <code class="instruction-implementation">${escapeHtml(
                    instruction.implementation
                )}</code>
            </div>

            <div class="instruction-section">
                <h3>Encoding</h3>
                <code class="instruction-encoding">${escapeHtml(instruction.encoding)}</code>
            </div>

            <div class="instruction-section">
                <h3>Example</h3>
                <code class="instruction-example">${escapeHtml(instruction.example)}</code>
            </div>

            <div class="instruction-footer">
                <a href="https://msyksphinz-self.github.io/riscv-isadoc/" target="_blank" rel="noopener">
                    <i class="fas fa-external-link-alt"></i>
                    View full RISC-V ISA documentation
                </a>
            </div>
        </div>
    `;

    showNotification(`Loaded documentation for ${instruction.name}`, "success");
}

// CPUlator-style conditional breakpoints
function addConditionalBreakpoint(lineNumber, condition = null) {
    const breakpoint = {
        line: lineNumber,
        condition: condition,
        enabled: true,
        hitCount: 0,
    };

    // Store in enhanced breakpoint system
    conditionalBreakpoints.set(lineNumber, breakpoint);

    // Visual update in editor
    updateBreakpointDecorations();

    showNotification(
        condition
            ? `Conditional breakpoint set at line ${lineNumber}: ${condition}`
            : `Breakpoint set at line ${lineNumber}`,
        "success"
    );
}

// Call Stack panel functionality
let callStack = [];
let callStackLog = []; // Logs all call/return events for history

// Global symbols storage for cross-panel access
let globalAssemblySymbols = [];

function updateCallStackDisplay(stackOutput) {
    if (!stackOutput) {
        updateCallStackDisplayFromEntries([]);
        return;
    }

    const lines = stackOutput.split("\n");
    let stackEntries = [];

    lines.forEach((line) => {
        const trimmedLine = line.trim();
        if (trimmedLine && !trimmedLine.startsWith("#") && trimmedLine.includes(":")) {
            // Try to parse stack frame information
            const match = trimmedLine.match(/(\w+)\s*@\s*(0x[0-9a-fA-F]+)(?:\s+.*line\s+(\d+))?/);
            if (match) {
                const [, funcName, address, srcLine] = match;
                stackEntries.push({
                    function: funcName || "unknown",
                    address: address,
                    returnAddr: address,
                    srcLine: srcLine || "?",
                });
            }
        }
    });

    if (stackEntries.length === 0) {
        // If no parsed entries, use buildCallStackFromCurrentState
        buildCallStackFromCurrentState();
        return;
    }

    updateCallStackDisplayFromEntries(stackEntries);
}

// Add call/return event to log
function logCallStackEvent(type, functionName, address, returnAddr) {
    const event = {
        type: type, // 'call' or 'return'
        function: functionName,
        address: address,
        returnAddr: returnAddr,
        timestamp: Date.now(),
        cycle: performanceCounters.cycles,
    };

    callStackLog.push(event);
    updateCallStackLogDisplay();
}

// Updated function to display call stack log (similar to trace panel)
function updateCallStackLogDisplay() {
    const callstackContent = document.getElementById("callstackContent");
    const callDepth = document.getElementById("callDepth");

    if (!callstackContent) return;

    // Update call depth to show current stack depth
    const currentDepth =
        callStackLog.filter((e) => e.type === "call").length -
        callStackLog.filter((e) => e.type === "return").length;
    if (callDepth) {
        callDepth.textContent = Math.max(0, currentDepth);
    }

    // Generate HTML showing all logged events (like trace panel)
    let html =
        '<div class="callstack-header"><span>Cycle</span><span>Event</span><span>Function</span><span>Address</span></div>';

    if (callStackLog.length === 0) {
        html +=
            '<div class="callstack-empty">No call/return events yet. Start the emulator and use step/run commands to see the call stack log.</div>';
    } else {
        // Show all events in chronological order
        callStackLog.forEach((event, index) => {
            const eventIcon = event.type === "call" ? "→" : "←";
            const eventClass = event.type === "call" ? "callstack-call" : "callstack-return";
            html += `<div class="callstack-entry ${eventClass} ${
                index === callStackLog.length - 1 ? "current" : ""
            }">
                <span class="callstack-cycle">${event.cycle}</span>
                <span class="callstack-event">${eventIcon} ${event.type}</span>
                <span class="callstack-func">${escapeHtml(event.function)}</span>
                <span class="callstack-addr">${event.address}</span>
            </div>`;
        });
    }

    callstackContent.innerHTML = html;
    callstackContent.scrollTop = callstackContent.scrollHeight;
}

// Updated function to display call stack from stack entries array (keep for compatibility)
function updateCallStackDisplayFromEntries(stackEntries) {
    callStack = stackEntries;
    // Now just track current state but don't replace the log view
    // The log view is the primary display
}

document.addEventListener("DOMContentLoaded", initializeIDE);
