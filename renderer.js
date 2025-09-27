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
let performanceCounters = {
    cycles: 0,
    instructions: 0,
    branches: 0,
    memAccess: 0,
};

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

    const regRegex = /(x(?:[0-2]?\d|3[01])|pc)\s*[:=]\s*([-+]?0x[0-9a-fA-F]+|[-+]?\d+)/gi;
    let match;
    let capturedPc = null;

    while ((match = regRegex.exec(registerOutput))) {
        const name = match[1].toLowerCase();
        const normalized = normalizeRegisterValue(match[2]);

        if (name === "pc") {
            capturedPc = normalized;
            currentRegisterValues["pc"] = normalized;
        } else {
            currentRegisterValues[name] = normalized;
        }
    }

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
        const label = group.querySelector(".group-label").textContent;
        const controls = group.querySelectorAll("button, input");
        let disable = false;
        if (["Debug Control", "View", "Memory"].includes(label)) {
            disable = !emulatorRunning;
        } else if (["Breakpoints", "Navigation"].includes(label)) {
            disable = !fileLoaded;
        }
        // Display Options are always enabled.
        if (label !== "Display Options") {
            controls.forEach((c) => (c.disabled = disable));
        }
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
        if (/(error|failed|cannot|fatal|❌|✖)/i.test(trimmed)) return "error";
        if (/(warn|warning|⚠)/i.test(trimmed)) return "warning";
        if (/(success|passed|done|ok|✅|✓)/i.test(trimmed)) return "success";
        return "info";
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
            const sanitized = escapeHtml(content);
            const temp = document.createElement("div");
            temp.innerHTML = sanitized;
            appendTokenizedContent(line, temp.textContent || "");
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

    terminal.writeln("# RISC-V IDE Terminal");
    terminal.writeln("# Ready for emulation");
    terminal.writeln("");
    console.log("✅ Terminal initialized");
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
                    /[a-zA-Z.][\w.]*/,
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
            lineComment: "//",
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

async function sendCommand(command) {
    try {
        const result = await enqueueEmulatorCommand(command);
        if (result.ok) {
            terminal.writeln(`>> ${command}`);

            // CPUlator-style command processing - sync all panels for execution commands
            if (
                command === "s" ||
                command === "s1" ||
                command === "s100" ||
                command === "c" ||
                command === "r" ||
                command.startsWith("stepi")
            ) {
                // Use the comprehensive sync function for all execution commands
                await updateAfterExecution(command);

                // For step commands, also switch to registers panel to show changes
                // Keep data synchronized but don't auto-switch panels
                // User requested no automatic panel switching
            }

            // Handle register display commands
            if (command.startsWith("info registers") || command === "r") {
                // The output should be processed to update register display
                setTimeout(async () => {
                    const regResult = await enqueueEmulatorCommand("info registers");
                    if (regResult.ok) {
                        ingestRegisterDump(regResult.output);
                        updateRegistersFromCurrentValues();
                    }
                }, 100);
            }
        } else {
            terminal.writeln(`Error: ${result.error}`);
        }
    } catch (error) {
        terminal.writeln(`Error: ${error.message}`);
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
        { cmd: "info registers", desc: "Show all registers" },
        { cmd: "info program", desc: "Show program status" },
        { cmd: "disassemble $pc, $pc+40", desc: "Disassemble around PC" },
        { cmd: "list", desc: "Show source code" },
        { cmd: "backtrace", desc: "Show call stack" },
    ];

    // Add to command history or suggestions
    window.quickCommands = quickCommands;
}

async function syncBreakpoints() {
    for (const lineNum of breakpoints) {
        await sendCommand(`b ${lineNum}`);
    }
}

function setupButtonHandlers() {
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
        if (document.getElementById("compileAndLoad").disabled) return;

        const btn = document.getElementById("compileAndLoad");
        const originalText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Compiling...';

        try {
            terminal.writeln("> Compiling and Loading...");

            // Build step
            const buildRes = await window.api.buildEmu();

            if (buildRes.code !== 0) {
                terminal.writeln("❌ Build failed!");
                terminal.writeln(buildRes.out || "No build output");
                showNotification("Build failed!", "error");
                ideState.emulatorRunning = false;
                return;
            }
            if (buildRes.out && buildRes.out.includes("Nothing to be done")) {
                terminal.writeln("✓ Emulator already built (up to date)");
            } else {
                terminal.writeln("✓ Emulator built successfully");
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
                terminal.writeln("✅ Assembly loaded and emulator started!");
                terminal.writeln(
                    "🎯 Ready for debugging - use Step Into, Continue, or send commands"
                );
                terminal.writeln(
                    "💡 The emulator is now waiting for your input in step-by-step mode"
                );
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
            } else {
                showNotification(`Failed to stop: ${result.error || "Unknown error"}`, "error");
            }
        } catch (error) {
            showNotification(`Error stopping emulator: ${error.message}`, "error");
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

    // Enhanced memory examination with format support
    document.getElementById("memBtn").addEventListener("click", async () => {
        const addr = document.getElementById("memAddr").value.trim();
        const format = document.getElementById("memFormat").value;
        const length = document.getElementById("memLen").value.trim() || "16";

        if (!addr) {
            showNotification("Please enter a memory address", "error");
            return;
        }

        const command = `x/${length}${format} ${addr}`;
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

    // CPUlator-style memory display enhancement
    function updateMemoryDisplay(memoryOutput) {
        const memoryDisplay = document.getElementById("memoryDisplay");
        if (!memoryDisplay) return;

        let html = "";
        if (!memoryOutput) {
            memoryDisplay.innerHTML = '<div class="empty-message">No memory data available</div>';
            return;
        }
        const lines = memoryOutput.split("\n");

        lines.forEach((line) => {
            if (line.includes(":") && line.match(/[0-9a-fA-F]/)) {
                const parts = line.split(":");
                if (parts.length >= 2) {
                    const address = parts[0].trim();
                    const hexData = parts[1].trim().split(/\s+/);

                    // Convert hex to ASCII
                    let ascii = "";
                    hexData.forEach((hex) => {
                        if (hex.match(/^[0-9a-fA-F]+$/)) {
                            const value = parseInt(hex, 16);
                            ascii += value >= 32 && value <= 126 ? String.fromCharCode(value) : ".";
                        }
                    });

                    html += `<div class="memory-row">
                        <span class="memory-address">${address}:</span>
                        <span class="memory-hex">${hexData.join(" ")}</span>
                        <span class="memory-ascii">${ascii}</span>
                    </div>`;
                }
            }
        });

        if (html) {
            memoryDisplay.innerHTML = html;
        }
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

    // GoTo button
    document.getElementById("gotoBtn").addEventListener("click", async () => {
        const address = document.getElementById("gotoAddress").value.trim();
        if (address) {
            await sendCommand(`goto ${address}`);
            document.getElementById("gotoAddress").value = "";
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
    document.getElementById("memoryRefresh").addEventListener("click", () => {
        const addr = document.getElementById("memoryAddr").value.trim();
        const len = document.getElementById("memoryLen").value.trim() || "64";
        if (addr) {
            sendCommand(`x/${len}x ${addr}`);
        }
    });

    // Symbols refresh button
    document.getElementById("refreshSymbols").addEventListener("click", async () => {
        await refreshSymbolsPanel();
        showNotification("Symbols refreshed", "success");
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
            } else if (cmd === "s1") {
                // Step Into: use simple "s" command to execute one instruction
                sendCommand("s");
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
            document.querySelector('[data-cmd="s1"]')?.click();
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

    console.log("✅ Button handlers set up");
}

// Central synchronization function to update all panels
async function syncAllPanels(reason = "update") {
    try {
        console.log(`🔄 Syncing all panels (${reason})...`);

        let pcHex = null;

        const registersResult = await enqueueEmulatorCommand("info registers");
        if (registersResult.ok) {
            const { pc } = ingestRegisterDump(registersResult.output);
            if (pc) {
                pcHex = pc;
            }
            updateRegistersFromCurrentValues();
            updatePerformanceCounters();
            updateInstructionTypeStats();
        }

        const listResult = await enqueueEmulatorCommand("list");
        if (listResult.ok) {
            const currentLine = parseCurrentLineFromList(listResult.output);
            if (currentLine) {
                currentExecutionLine = currentLine.lineNumber;
            }
            updateSourceDisplay();
            highlightCurrentSourceLine();
        }

        if (!pcHex && currentRegisterValues["pc"]) {
            pcHex = currentRegisterValues["pc"];
        }

        if (pcHex) {
            // Get broader disassembly context around current PC
            const disasmResult = await enqueueEmulatorCommand(`disassemble 0x${pcHex},+20`);
            if (disasmResult.ok) {
                updateDisassemblyDisplay(disasmResult.output);
                highlightCurrentInstructionInDisassembly(pcHex);
            }
        }

        const memoryAddr = document.getElementById("memoryAddr")?.value;
        if (memoryAddr && memoryAddr.trim()) {
            const memoryLen = document.getElementById("memoryLen")?.value || "64";
            const memResult = await enqueueEmulatorCommand(`x/${memoryLen}xb ${memoryAddr}`);
            if (memResult.ok) {
                updateMemoryDisplay(memResult.output);
            }
        }

        // Update symbols with fallback
        try {
            await refreshSymbolsPanel();
        } catch (error) {
            console.error("Error refreshing symbols panel:", error);
            terminal.writeln(`⚠️  Symbol panel warning: ${error.message}`);
        }

        // Update call stack with fallback
        try {
            await refreshCallStackPanel();
        } catch (error) {
            console.error("Error refreshing call stack panel:", error);
            terminal.writeln(`⚠️  Call stack panel warning: ${error.message}`);
        }

        try {
            updateBreakpointDisplay();
        } catch (error) {
            console.error("Error updating breakpoint display:", error);
        }

        console.log(`✅ All panels synced (${reason})`);
    } catch (error) {
        console.error("Error syncing panels:", error);
        terminal.writeln(`⚠️  Panel sync warning: ${error.message}`);
    }
}

// Enhanced update function for execution commands
async function updateAfterExecution(commandType = "execution") {
    // Allow the emulator a brief moment to flush output before querying state
    await new Promise((resolve) => setTimeout(resolve, 60));
    await syncAllPanels(commandType);
}

// VIEW panel button handlers
async function handleViewRegisters() {
    try {
        terminal.writeln(">> Refreshing registers view...");

        // Then sync all panels for comprehensive update
        await syncAllPanels("view registers");

        terminal.writeln("✅ All panels synced from registers view");
    } catch (error) {
        terminal.writeln(`❌ Error updating registers: ${error.message}`);
    }
}

async function handleViewSource() {
    try {
        terminal.writeln(">> Refreshing source view...");

        // Then sync all panels for comprehensive update
        await syncAllPanels("view source");

        terminal.writeln("✅ All panels synced from source view");
    } catch (error) {
        terminal.writeln(`❌ Error updating source: ${error.message}`);
    }
}

async function handleViewDisassembly() {
    try {
        terminal.writeln(">> Refreshing disassembly view...");
        // Get current PC for disassembly
        const pcValue = currentRegisterValues["pc"];
        const startAddr = pcValue ? `0x${pcValue}` : "0x400000";
        await refreshDisassemblyPanel(startAddr, 20);
        terminal.writeln("✅ Disassembly view updated");
    } catch (error) {
        terminal.writeln(`❌ Error updating disassembly: ${error.message}`);
    }
}

async function refreshDisassemblyPanel(startAddr, count = 20) {
    try {
        // If no start address provided, use current PC or default
        if (!startAddr) {
            const pcValue = currentRegisterValues["pc"];
            startAddr = pcValue ? `0x${pcValue}` : "0x400000";
        }

        // Normalize address to hex format
        let address = startAddr;
        if (!address.startsWith("0x")) {
            address = `0x${address}`;
        }

        // Convert to integer for calculations
        const baseAddr = parseInt(address, 16);
        const bytesToRead = count * 4; // 4 bytes per RISC-V instruction

        // Read memory from the emulator
        const memResult = await enqueueEmulatorCommand(`m${address} ${bytesToRead}`);

        if (memResult.ok && memResult.output) {
            // Parse memory output and disassemble
            const memoryData = parseMemoryOutput(memResult.output);
            const disassembly = disassembleMemoryData(memoryData, baseAddr, count);
            updateDisassemblyDisplay(disassembly);
        } else {
            // Create placeholder disassembly
            createPlaceholderDisassembly(baseAddr, count);
        }
    } catch (error) {
        console.error("Error refreshing disassembly panel:", error);
        const disasmContent = document.getElementById("disasmContent");
        if (disasmContent) {
            disasmContent.innerHTML = `<div class="disasm-error">Error: ${error.message}</div>`;
        }
    }
}

function parseMemoryOutput(output) {
    const memoryData = [];
    const lines = output.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Parse hex memory output format
        // Expected format: address: value value value ...
        const match = trimmed.match(/^([0-9a-fA-F]+):\s*(.+)$/);
        if (match) {
            const [, addr, values] = match;
            const address = parseInt(addr, 16);
            const hexValues = values.split(/\s+/).filter(v => v && /^[0-9a-fA-F]+$/.test(v));

            for (let i = 0; i < hexValues.length; i++) {
                memoryData.push({
                    address: address + (i * 4),
                    instruction: parseInt(hexValues[i], 16)
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
        const addressHex = `0x${address.toString(16).padStart(8, '0')}`;
        const opcodeHex = `0x${instruction.toString(16).padStart(8, '0')}`;

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

function disassembleInstruction(instruction) {
    // Basic RISC-V instruction decoding
    const opcode = instruction & 0x7F;

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
        case 0x6F: // JAL
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
    const rd = (instruction >> 7) & 0x1F;
    const funct3 = (instruction >> 12) & 0x7;
    const rs1 = (instruction >> 15) & 0x1F;
    const rs2 = (instruction >> 20) & 0x1F;
    const funct7 = (instruction >> 25) & 0x7F;

    const rdName = getRegisterName(rd);
    const rs1Name = getRegisterName(rs1);
    const rs2Name = getRegisterName(rs2);

    if (funct7 === 0x00) {
        switch (funct3) {
            case 0x0: return `add ${rdName}, ${rs1Name}, ${rs2Name}`;
            case 0x4: return `xor ${rdName}, ${rs1Name}, ${rs2Name}`;
            case 0x6: return `or ${rdName}, ${rs1Name}, ${rs2Name}`;
            case 0x7: return `and ${rdName}, ${rs1Name}, ${rs2Name}`;
            case 0x1: return `sll ${rdName}, ${rs1Name}, ${rs2Name}`;
            case 0x5: return `srl ${rdName}, ${rs1Name}, ${rs2Name}`;
            case 0x2: return `slt ${rdName}, ${rs1Name}, ${rs2Name}`;
            case 0x3: return `sltu ${rdName}, ${rs1Name}, ${rs2Name}`;
        }
    } else if (funct7 === 0x20) {
        switch (funct3) {
            case 0x0: return `sub ${rdName}, ${rs1Name}, ${rs2Name}`;
            case 0x5: return `sra ${rdName}, ${rs1Name}, ${rs2Name}`;
        }
    }

    return `r-type (0x${instruction.toString(16)})`;
}

function disassembleIType(instruction) {
    const rd = (instruction >> 7) & 0x1F;
    const funct3 = (instruction >> 12) & 0x7;
    const rs1 = (instruction >> 15) & 0x1F;
    const imm = (instruction >> 20) & 0xFFF;
    const signExtImm = imm > 0x7FF ? imm - 0x1000 : imm;

    const rdName = getRegisterName(rd);
    const rs1Name = getRegisterName(rs1);

    switch (funct3) {
        case 0x0: return `addi ${rdName}, ${rs1Name}, ${signExtImm}`;
        case 0x2: return `slti ${rdName}, ${rs1Name}, ${signExtImm}`;
        case 0x3: return `sltiu ${rdName}, ${rs1Name}, ${signExtImm}`;
        case 0x4: return `xori ${rdName}, ${rs1Name}, ${signExtImm}`;
        case 0x6: return `ori ${rdName}, ${rs1Name}, ${signExtImm}`;
        case 0x7: return `andi ${rdName}, ${rs1Name}, ${signExtImm}`;
        case 0x1: return `slli ${rdName}, ${rs1Name}, ${imm & 0x1F}`;
        case 0x5:
            if ((imm >> 5) === 0x00) return `srli ${rdName}, ${rs1Name}, ${imm & 0x1F}`;
            if ((imm >> 5) === 0x20) return `srai ${rdName}, ${rs1Name}, ${imm & 0x1F}`;
            break;
    }

    return `i-type (0x${instruction.toString(16)})`;
}

function disassembleLoadType(instruction) {
    const rd = (instruction >> 7) & 0x1F;
    const funct3 = (instruction >> 12) & 0x7;
    const rs1 = (instruction >> 15) & 0x1F;
    const imm = (instruction >> 20) & 0xFFF;
    const signExtImm = imm > 0x7FF ? imm - 0x1000 : imm;

    const rdName = getRegisterName(rd);
    const rs1Name = getRegisterName(rs1);

    switch (funct3) {
        case 0x0: return `lb ${rdName}, ${signExtImm}(${rs1Name})`;
        case 0x1: return `lh ${rdName}, ${signExtImm}(${rs1Name})`;
        case 0x2: return `lw ${rdName}, ${signExtImm}(${rs1Name})`;
        case 0x4: return `lbu ${rdName}, ${signExtImm}(${rs1Name})`;
        case 0x5: return `lhu ${rdName}, ${signExtImm}(${rs1Name})`;
    }

    return `load (0x${instruction.toString(16)})`;
}

function disassembleStoreType(instruction) {
    const funct3 = (instruction >> 12) & 0x7;
    const rs1 = (instruction >> 15) & 0x1F;
    const rs2 = (instruction >> 20) & 0x1F;
    const imm = ((instruction >> 25) << 5) | ((instruction >> 7) & 0x1F);
    const signExtImm = imm > 0x7FF ? imm - 0x1000 : imm;

    const rs1Name = getRegisterName(rs1);
    const rs2Name = getRegisterName(rs2);

    switch (funct3) {
        case 0x0: return `sb ${rs2Name}, ${signExtImm}(${rs1Name})`;
        case 0x1: return `sh ${rs2Name}, ${signExtImm}(${rs1Name})`;
        case 0x2: return `sw ${rs2Name}, ${signExtImm}(${rs1Name})`;
    }

    return `store (0x${instruction.toString(16)})`;
}

function disassembleBranchType(instruction) {
    const funct3 = (instruction >> 12) & 0x7;
    const rs1 = (instruction >> 15) & 0x1F;
    const rs2 = (instruction >> 20) & 0x1F;

    const rs1Name = getRegisterName(rs1);
    const rs2Name = getRegisterName(rs2);

    switch (funct3) {
        case 0x0: return `beq ${rs1Name}, ${rs2Name}, <offset>`;
        case 0x1: return `bne ${rs1Name}, ${rs2Name}, <offset>`;
        case 0x4: return `blt ${rs1Name}, ${rs2Name}, <offset>`;
        case 0x5: return `bge ${rs1Name}, ${rs2Name}, <offset>`;
        case 0x6: return `bltu ${rs1Name}, ${rs2Name}, <offset>`;
        case 0x7: return `bgeu ${rs1Name}, ${rs2Name}, <offset>`;
    }

    return `branch (0x${instruction.toString(16)})`;
}

function disassembleJType(instruction) {
    const rd = (instruction >> 7) & 0x1F;
    const rdName = getRegisterName(rd);
    return `jal ${rdName}, <offset>`;
}

function disassembleJALR(instruction) {
    const rd = (instruction >> 7) & 0x1F;
    const rs1 = (instruction >> 15) & 0x1F;
    const imm = (instruction >> 20) & 0xFFF;
    const signExtImm = imm > 0x7FF ? imm - 0x1000 : imm;

    const rdName = getRegisterName(rd);
    const rs1Name = getRegisterName(rs1);

    return `jalr ${rdName}, ${rs1Name}, ${signExtImm}`;
}

function disassembleLUI(instruction) {
    const rd = (instruction >> 7) & 0x1F;
    const imm = instruction >> 12;
    const rdName = getRegisterName(rd);

    return `lui ${rdName}, 0x${imm.toString(16)}`;
}

function disassembleAUIPC(instruction) {
    const rd = (instruction >> 7) & 0x1F;
    const imm = instruction >> 12;
    const rdName = getRegisterName(rd);

    return `auipc ${rdName}, 0x${imm.toString(16)}`;
}

function getRegisterName(regNum) {
    const regNames = [
        "zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2",
        "s0", "s1", "a0", "a1", "a2", "a3", "a4", "a5",
        "a6", "a7", "s2", "s3", "s4", "s5", "s6", "s7",
        "s8", "s9", "s10", "s11", "t3", "t4", "t5", "t6"
    ];

    return regNames[regNum] || `x${regNum}`;
}

function createPlaceholderDisassembly(baseAddr, count) {
    const disasmContent = document.getElementById("disasmContent");
    if (!disasmContent) return;

    let html = "";
    for (let i = 0; i < count; i++) {
        const address = baseAddr + (i * 4);
        const addressHex = `0x${address.toString(16).padStart(8, '0')}`;

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
        terminal.writeln(">> Refreshing program status...");

        // Then sync all panels for comprehensive update
        await syncAllPanels("view status");

        terminal.writeln("✅ All panels synced from status view");
    } catch (error) {
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

// Log step execution to trace panel
function logStepToTrace() {
    const pc = currentRegisterValues["pc"];
    if (pc) {
        const pcHex = "0x" + parseInt(pc, 16).toString(16).padStart(8, "0").toUpperCase();
        const instruction = `Step executed at PC: ${pcHex}`;

        // Add to instruction trace
        addToTrace(instruction, parseInt(pc, 16), { ...currentRegisterValues });

        // Update trace display
        updateTraceDisplay();
    }
}

// Highlight current instruction in disassembly panel
function highlightCurrentInstructionInDisassembly(pcHex) {
    // Remove previous highlights
    const disasmLines = document.querySelectorAll(".disasm-line");
    disasmLines.forEach((line) => line.classList.remove("current-pc"));

    // Find and highlight current instruction
    const currentPCElement = document.querySelector(`[data-address="${pcHex}"]`);
    if (currentPCElement) {
        currentPCElement.classList.add("current-pc");
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
    if (typeof disasmOutput === 'string' && disasmOutput.includes('<div class="disasm-line">')) {
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
            const addr = `0x${address}`;
            const isCurrentPC = currentRegisterValues["pc"] === address;

            html += `<div class="disasm-line ${isCurrentPC ? "current-pc" : ""}">
                <span class="disasm-addr">${addr}</span>
                <span class="disasm-opcode">${opcode.trim()}</span>
                <span class="disasm-instr">${escapeHtml(instruction)}</span>
                <span class="disasm-comment"></span>
            </div>`;
        } else if (trimmedLine.includes(":") && !trimmedLine.startsWith("Dump")) {
            // Alternative format parsing
            const parts = trimmedLine.split(":");
            if (parts.length >= 2) {
                const address = parts[0].trim();
                const rest = parts[1].trim();
                const addr = address.startsWith("0x") ? address : `0x${address}`;
                const isCurrentPC = currentRegisterValues["pc"] === address.replace("0x", "");

                html += `<div class="disasm-line ${isCurrentPC ? "current-pc" : ""}">
                    <span class="disasm-addr">${addr}</span>
                    <span class="disasm-opcode">--</span>
                    <span class="disasm-instr">${escapeHtml(rest)}</span>
                    <span class="disasm-comment"></span>
                </div>`;
            }
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

        // Parse instruction execution info: [inst: 1 pc: 0, src line 4]
        const instMatch = trimmedLine.match(/\[inst:\s*(\d+)\s+pc:\s*(\d+),\s*src line\s*(\d+)\]/);
        if (instMatch) {
            const [, instCount, pc, srcLine] = instMatch;

            // Store the current execution context
            currentRegisterValues["pc"] = parseInt(pc).toString(16);
            performanceCounters.instructions = parseInt(instCount);

            // Update current execution line and refresh source panel
            const rawLineNumber = parseInt(srcLine, 10);
            const executableLine = Number.isNaN(rawLineNumber)
                ? null
                : findNearestExecutableLine(rawLineNumber);
            currentExecutionLine = executableLine ?? currentExecutionLine;
            updateSourceDisplay();
        }

        // Parse "Next:" instruction line
        const nextMatch = trimmedLine.match(/^Next:\s*(.+)$/);
        if (nextMatch) {
            const instruction = nextMatch[1].trim();
            const pc = currentRegisterValues["pc"] ? parseInt(currentRegisterValues["pc"], 16) : 0;

            // Add to trace and analyze instruction type
            addToTrace(instruction, pc, { ...currentRegisterValues });
            analyzeInstructionType(instruction);
        }

        // Parse register changes: >> rf[x02] 0 -> 10000
        const regMatch = trimmedLine.match(
            /^>>\s*rf\[(\w+)\]\s*[0-9a-fA-Fx]+\s*->\s*([0-9a-fA-Fx]+)$/
        );
        if (regMatch) {
            const [, regName, newValue] = regMatch;
            // Convert to hex string for consistency
            const hexValue = parseInt(newValue, newValue.startsWith("0x") ? 16 : 10).toString(16);
            currentRegisterValues[regName] = hexValue;

            // Update registers display automatically
            updateRegistersFromCurrentValues();
        }
    }
}

window.api.onOutput((chunk) => {
    if (terminal) {
        // Format the output before displaying
        const formattedChunk = formatTerminalOutput(chunk);
        terminal.write(formattedChunk);
    }

    // Parse emulator output for trace information
    parseEmulatorOutputForTrace(chunk);
});

// Format terminal output for better readability
function formatTerminalOutput(chunk) {
    if (!chunk) return chunk;

    // Replace the verbose format [inst: X pc: Y, src line Z] with cleaner [inst:X, pc:Y, src:Z]
    return chunk.replace(
        /\[inst:\s*(\d+)\s+pc:\s*(\d+),\s*src line\s*(\d+)\]/g,
        "[inst:$1, pc:$2, src:$3]"
    );
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
    lbu: {
        name: "Load Byte Unsigned",
        format: "lbu rd, offset(rs1)",
        category: "RV32I",
        description:
            "Loads a 8-bit value from memory and zero-extends to 32-bits before storing in rd.",
        implementation: "x[rd] = M[x[rs1] + sext(offset)][7:0]",
        encoding: "imm[11:0] rs1 100 rd 0000011",
        example: "lbu x1, 4(x2)  # x1 = zero_extend(mem[x2 + 4])",
    },
    lhu: {
        name: "Load Halfword Unsigned",
        format: "lhu rd, offset(rs1)",
        category: "RV32I",
        description:
            "Loads a 16-bit value from memory and zero-extends to 32-bits before storing in rd.",
        implementation: "x[rd] = M[x[rs1] + sext(offset)][15:0]",
        encoding: "imm[11:0] rs1 101 rd 0000011",
        example: "lhu x1, 4(x2)  # x1 = zero_extend(mem[x2 + 4])",
    },
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
    bltu: {
        name: "Branch Less Than Unsigned",
        format: "bltu rs1, rs2, offset",
        category: "RV32I",
        description: "Takes the branch if rs1 < rs2 (unsigned comparison).",
        implementation: "if (x[rs1] <u x[rs2]) pc += sext(offset)",
        encoding: "imm[12|10:5] rs2 rs1 110 imm[4:1|11] 1100011",
        example: "bltu x1, x2, loop  # if x1 <u x2, goto loop",
    },
    bgeu: {
        name: "Branch Greater Equal Unsigned",
        format: "bgeu rs1, rs2, offset",
        category: "RV32I",
        description: "Takes the branch if rs1 >= rs2 (unsigned comparison).",
        implementation: "if (x[rs1] >=u x[rs2]) pc += sext(offset)",
        encoding: "imm[12|10:5] rs2 rs1 111 imm[4:1|11] 1100011",
        example: "bgeu x1, x2, loop  # if x1 >=u x2, goto loop",
    },
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
    },

    // Additional Load/Store Instructions
    lbu: {
        name: "Load Byte Unsigned",
        format: "lbu rd, offset(rs1)",
        category: "RV32I",
        description: "Load 8-bit value from memory and zero-extend to 32-bits before storing in rd.",
        implementation: "x[rd] = zext(M[x[rs1] + sext(offset)][7:0])",
        encoding: "imm[11:0] rs1 100 rd 0000011",
        example: "lbu x1, 0(x2)  # x1 = zero_extend(memory[x2])",
    },
    lhu: {
        name: "Load Halfword Unsigned",
        format: "lhu rd, offset(rs1)",
        category: "RV32I",
        description: "Load 16-bit value from memory and zero-extend to 32-bits before storing in rd.",
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
        description: "Shift rs1 right by the number of bits specified in the lower 5 bits of rs2, preserving sign.",
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
        implementation: "if (valid_reservation(x[rs1])) { M[x[rs1]] = x[rs2]; x[rd] = 0 } else x[rd] = 1",
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

// CPUlator-style register display with change highlighting
function updateRegisterDisplay(registerData) {
    const registersGrid = document.getElementById("registersGrid");
    if (!registersGrid || !registerData) return;

    // Parse register data and highlight changes
    const registerLines = registerData.split("\n");
    let html = '<div class="register-table">';

    registerLines.forEach((line) => {
        if (line.includes("x")) {
            const matches = line.match(/x(\d+):\s*([0-9a-fA-F]+)/g);
            if (matches) {
                matches.forEach((match) => {
                    const [reg, value] = match.split(": ");
                    const regNum = parseInt(reg.substring(1));
                    const newValue = value.trim();

                    const changed = previousRegisterValues[reg] !== newValue;
                    if (changed && previousRegisterValues[reg] !== undefined) {
                        currentRegisterValues[reg] = newValue;
                    }

                    html += `<div class="register-item ${changed ? "changed" : ""}">
                        <span class="reg-name">${reg}</span>
                        <span class="reg-value">${newValue}</span>
                        <span class="reg-alias">${getRegisterAlias(regNum)}</span>
                    </div>`;

                    previousRegisterValues[reg] = newValue;
                });
            }
        }
    });

    html += "</div>";
    registersGrid.innerHTML = html;

    // Remove highlighting after animation
    setTimeout(() => {
        const changed = registersGrid.querySelectorAll(".changed");
        changed.forEach((el) => el.classList.remove("changed"));
    }, 1500);
}

// Update registers display from current values
function updateRegistersFromCurrentValues() {
    const registersGrid = document.getElementById("registersGrid");
    if (!registersGrid) return;

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

        previousRegisterValues[regName] = currentValue;
    }

    html += "</div>";
    registersGrid.innerHTML = html;

    // Remove highlighting after animation
    setTimeout(() => {
        const changed = registersGrid.querySelectorAll(".changed");
        changed.forEach((el) => el.classList.remove("changed"));
    }, 1500);
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

    // Keep all entries - no limit (make scrollable instead)

    updateTraceDisplay();
    updatePerformanceCounters();
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
        const spValue = currentRegisterValues["x2"] || currentRegisterValues["sp"] || "0";
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
            performanceCounters.cycles = 0;
            performanceCounters.instructions = 0;

            // Reset instruction stats
            instructionStats.branches = 0;
            instructionStats.memAccess = 0;
            instructionStats.arithmetic = 0;
            instructionStats.syscalls = 0;

            updateTraceDisplay();
            updatePerformanceCounters();
            showNotification("Instruction trace and statistics cleared", "info");
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

    console.log("✅ Features initialized");
}

// Helper functions for refreshing panels with fallbacks
async function refreshSymbolsPanel() {
    try {
        // Try GDB-style command first
        let result = await enqueueEmulatorCommand("info symbols");
        if (result.ok && result.output && result.output.trim()) {
            updateSymbolsDisplay(result.output);
            return;
        }

        // Fallback: try alternative commands
        const fallbackCommands = ["symbols", "nm", "objdump -t"];
        for (const cmd of fallbackCommands) {
            result = await enqueueEmulatorCommand(cmd);
            if (result.ok && result.output && result.output.trim()) {
                updateSymbolsDisplay(result.output);
                return;
            }
        }

        // If no command works, show empty state
        updateSymbolsDisplay("");
    } catch (error) {
        updateSymbolsDisplay("");
    }
}

async function refreshCallStackPanel() {
    try {
        // Try GDB-style command first
        let result = await enqueueEmulatorCommand("info stack");
        if (result.ok && result.output && result.output.trim()) {
            updateCallStackDisplay(result.output);
            return;
        }

        // Fallback: try alternative commands
        const fallbackCommands = ["backtrace", "bt", "where", "stack"];
        for (const cmd of fallbackCommands) {
            result = await enqueueEmulatorCommand(cmd);
            if (result.ok && result.output && result.output.trim()) {
                updateCallStackDisplay(result.output);
                return;
            }
        }

        // If no command works, create a basic call stack from current state
        const fakeStackOutput = `Current frame: main @ ${
            currentRegisterValues["pc"] || "0x00000000"
        }`;
        updateCallStackDisplay(fakeStackOutput);
    } catch (error) {
        const fakeStackOutput = `Current frame: main @ 0x00000000`;
        updateCallStackDisplay(fakeStackOutput);
    }
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
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 3) {
                const [name, address, type, size = "", section = ""] = parts;
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
                <h2>${instruction.name}</h2>
                <span class="instruction-category">${instruction.category}</span>
            </div>

            <div class="instruction-section">
                <h3>Format</h3>
                <code class="instruction-format">${instruction.format}</code>
            </div>

            <div class="instruction-section">
                <h3>Description</h3>
                <div class="instruction-description">${instruction.description}</div>
            </div>

            <div class="instruction-section">
                <h3>Implementation</h3>
                <code class="instruction-implementation">${instruction.implementation}</code>
            </div>

            <div class="instruction-section">
                <h3>Encoding</h3>
                <code class="instruction-encoding">${instruction.encoding}</code>
            </div>

            <div class="instruction-section">
                <h3>Example</h3>
                <code class="instruction-example">${instruction.example}</code>
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
    if (!window.conditionalBreakpoints) {
        window.conditionalBreakpoints = new Map();
    }

    window.conditionalBreakpoints.set(lineNumber, breakpoint);

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

function updateCallStackDisplay(stackOutput) {
    const callstackContent = document.getElementById("callstackContent");
    const callDepth = document.getElementById("callDepth");

    if (!callstackContent) return;

    // Parse stack information (basic implementation)
    let html = "";
    if (!stackOutput) {
        callstackContent.innerHTML = '<div class="empty-message">No call stack available</div>';
        if (callDepth) callDepth.textContent = "0";
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
        // If no parsed entries, create a basic current frame
        const currentPC = currentRegisterValues["pc"] || "0";
        stackEntries.push({
            function: "main",
            address: `0x${parseInt(currentPC, 16).toString(16).padStart(8, "0")}`,
            returnAddr: "0x00000000",
            srcLine: currentExecutionLine || "?",
        });
    }

    callStack = stackEntries;

    // Update call depth
    if (callDepth) {
        callDepth.textContent = callStack.length;
    }

    // Generate HTML
    if (callStack.length === 0) {
        html =
            '<div class="callstack-empty"><i class="fas fa-info-circle"></i> No active function calls</div>';
    } else {
        callStack.forEach((frame, index) => {
            html += `<div class="callstack-frame ${index === 0 ? "current-frame" : ""}">
                <span class="callstack-func">${escapeHtml(frame.function)}</span>
                <span class="callstack-addr">${frame.address}</span>
                <span class="callstack-ret">${frame.returnAddr}</span>
                <span class="callstack-line">${frame.srcLine}</span>
            </div>`;
        });
    }

    callstackContent.innerHTML = html;
}

document.addEventListener("DOMContentLoaded", initializeIDE);
