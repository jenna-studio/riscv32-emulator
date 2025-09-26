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

const fileMapping = {
    "graph.s": { assembly: "./example_questions/graph.s", c: "./example_questions/graph.c" },
    "reduction.s": {
        assembly: "./example_questions/reduction.s",
        c: "./example_questions/reduction.c",
    },
    "sort.s": { assembly: "./example_questions/sort.s", c: "./example_questions/sort.c" },
    "sudoku.s": { assembly: "./example_questions/sudoku.s", c: "./example_questions/sudoku.c" },
};

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
            { token: "comment", foreground: "B3B1B3" },
            { token: "comment.todo", foreground: "F6C177" },
            { token: "keyword", foreground: "F181C4" },
            { token: "keyword.control", foreground: "F181C4" },
            { token: "keyword.directive", foreground: "00B2C9" },
            { token: "keyword.operator", foreground: "E5C147" },
            { token: "meta", foreground: "9795F1" },
            { token: "variable", foreground: "1DE9B6" },
            { token: "variable.predefined", foreground: "2DBA77" },
            { token: "variable.parameter", foreground: "FE90AF" },
            { token: "variable.other", foreground: "D8D7CB" },
            { token: "variable.language", foreground: "F181C4" },
            { token: "identifier", foreground: "3DC7B9" },
            { token: "identifier.constant", foreground: "BD93F9" },
            { token: "identifier.label", foreground: "FF8F6D" },
            { token: "type", foreground: "00B6CD" },
            { token: "type.identifier", foreground: "00B6CD" },
            { token: "storage.type", foreground: "00B6CD" },
            { token: "support.function", foreground: "3DC7B9" },
            { token: "support.type", foreground: "00B6CD" },
            { token: "support.variable", foreground: "75DFBB" },
            { token: "string", foreground: "8288FA" },
            { token: "string.escape", foreground: "FFAAE1" },
            { token: "string.invalid", foreground: "EB5BCB" },
            { token: "number", foreground: "BD93F9" },
            { token: "number.hex", foreground: "BD93F9" },
            { token: "number.octal", foreground: "BD93F9" },
            { token: "number.binary", foreground: "BD93F9" },
            { token: "number.float", foreground: "BD93F9" },
            { token: "operator", foreground: "9EA09C" },
            { token: "delimiter", foreground: "F0EFE2" },
            { token: "delimiter.bracket", foreground: "F0EFE2" },
            { token: "delimiter.parenthesis", foreground: "F0EFE2" },
            { token: "delimiter.square", foreground: "F0EFE2" },
            { token: "delimiter.angle", foreground: "F0EFE2" },
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
        padding: { top: 12, bottom: 6, left: 8 },
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
        showNotification(`Saved: ${asmPath.split("/").pop()}`, "success");
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
    Object.keys(fileMapping).forEach((fileName) => {
        const item = document.createElement("div");
        item.className = "file-item";
        item.innerHTML = `<i class="fas fa-file-code"></i> ${fileName}`;
        item.style.cursor = "pointer";
        item.addEventListener("click", () => loadFilePair(fileName));
        examplesList.appendChild(item);
    });
    console.log("✅ Example files loaded");
}

async function sendCommand(command) {
    try {
        const result = await window.api.sendCmd(command);
        if (result.ok) {
            terminal.writeln(`>> ${command}`);

            // CPUlator-style command processing
            if (
                command === "s" ||
                command === "s1" ||
                command === "s100" ||
                command === "c" ||
                command.startsWith("stepi")
            ) {
                await updateProgramStatus();

                // Add to instruction trace
                const currentPC = getCurrentPC();
                const instruction = await getCurrentInstruction();
                addToTrace(instruction, currentPC, currentRegisterValues);
            }

            // Handle register display commands
            if (command.startsWith("info registers") || command === "r") {
                // The output should be processed to update register display
                setTimeout(async () => {
                    const regResult = await window.api.sendCmd("info registers");
                    if (regResult.ok) {
                        updateRegisterDisplay(regResult.output);
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
    // Extract PC from current state - this would need integration with emulator
    return parseInt(currentRegisterValues["pc"] || "0", 16);
}

async function getCurrentInstruction() {
    try {
        // Get current program counter and instruction from emulator
        const result = await window.api.sendCmd("info program");
        if (result.ok && result.output) {
            // Parse the output to extract current instruction
            const lines = result.output.split('\n');
            for (const line of lines) {
                // Look for instruction format like "Next: addi x1, x0, 10"
                if (line.includes('Next:')) {
                    const instruction = line.replace('Next:', '').trim();
                    if (instruction) return instruction;
                }
                // Also look for current PC instruction
                if (line.includes('inst:') && line.includes('pc:')) {
                    // Extract instruction from debug output
                    const parts = line.split('src line');
                    if (parts.length > 1) {
                        // Try to get the instruction from source
                        return extractInstructionFromDebug(line);
                    }
                }
            }
        }

        // Fallback: try to get instruction from current PC by reading source
        if (monacoEditor && currentRegisterValues['pc']) {
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
    let instruction = sourceLine.split('#')[0].trim(); // Remove comments
    instruction = instruction.split('//')[0].trim(); // Remove C++ style comments

    // Skip labels and directives
    if (instruction.endsWith(':') || instruction.startsWith('.')) {
        return "nop";
    }

    // Extract just the instruction part
    const parts = instruction.split(/\s+/);
    if (parts.length > 0 && parts[0]) {
        return instruction; // Return the full instruction
    }

    return "nop";
}

async function updateProgramStatus() {
    try {
        // Get current program counter and highlight current line
        await sendCommand("info registers pc");
        await sendCommand("list");
        await updateBreakpointDisplay();
    } catch (error) {
        console.error("Failed to update program status:", error);
    }
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
            const buildRes = await window.api.buildEmu();
            if (buildRes.code !== 0) {
                terminal.writeln("Build failed!");
                terminal.writeln(buildRes.out);
                showNotification("Build failed!", "error");
                ideState.emulatorRunning = false;
                return;
            }
            terminal.writeln("✓ Emulator built successfully");

            const runRes = await window.api.runEmu(asmPath);
            if (runRes.ok) {
                terminal.writeln("✅ Assembly loaded!");
                showNotification("Assembly loaded!", "success");
                await syncBreakpoints();
                ideState.emulatorRunning = true;
            } else {
                terminal.writeln(`Error: ${runRes.error}`);
                showNotification("Failed to load assembly", "error");
                ideState.emulatorRunning = false;
            }
        } catch (error) {
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
        } else {
            showNotification("Failed to reload assembly", "error");
            ideState.emulatorRunning = false;
        }
        updateButtonStates();
    });

    document.getElementById("stop").addEventListener("click", async () => {
        if (document.getElementById("stop").enabled) return;

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
        const result = await window.api.sendCmd(command);

        if (result.ok) {
            // Display in terminal
            terminal.writeln(`>> ${command}`);
            terminal.writeln(result.output);

            // Update CPUlator-style memory display
            updateMemoryDisplay(
                result.output,
                parseInt(addr.replace("0x", ""), 16),
                parseInt(length)
            );
        } else {
            terminal.writeln(`Error: ${result.error}`);
        }
    });

    // CPUlator-style memory display enhancement
    function updateMemoryDisplay(memoryOutput, startAddr, length) {
        const memoryDisplay = document.getElementById("memoryDisplay");
        if (!memoryDisplay) return;

        let html = "";
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
        try {
            const result = await window.api.sendCmd("info symbols");
            if (result.ok) {
                updateSymbolsDisplay(result.output);
                showNotification("Symbols refreshed", "success");
            }
        } catch (error) {
            showNotification("Failed to refresh symbols", "error");
        }
    });

    // Disassembly refresh button
    document.getElementById("disasmRefresh").addEventListener("click", () => {
        const addr = document.getElementById("disasmAddr").value.trim();
        const count = document.getElementById("disasmCount").value.trim() || "10";
        if (addr) {
            sendCommand(`disassemble ${addr} ${count}`);
        }
    });

    // Callstack refresh button
    document.getElementById("refreshCallstack").addEventListener("click", () => {
        sendCommand("info stack");
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
        btn.addEventListener("click", () => {
            const cmd = btn.getAttribute("data-cmd");
            if (cmd === "q") {
                // Use the same logic as the main stop button
                document.getElementById("stop").click();
            } else {
                sendCommand(cmd);
            }
        });
    });

    console.log("✅ Button handlers set up");
}

function formatRISCVAssembly(code) {
    return code
        .split("\n")
        .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return ""; // Empty lines
            if (trimmed.startsWith("#") || trimmed.startsWith("//")) {
                return trimmed; // Comments
            }
            if (trimmed.startsWith(".")) {
                return trimmed; // Directives
            }
            if (trimmed.endsWith(":")) {
                return trimmed; // Labels
            }

            // Instructions - add proper indentation
            const parts = trimmed.split(/\s+/);
            if (parts.length > 0) {
                const instruction = parts[0];
                const operands = parts.slice(1).join(" ");

                if (operands) {
                    // Align operands with proper spacing
                    return `    ${instruction.padEnd(8)} ${operands}`;
                } else {
                    return `    ${instruction}`;
                }
            }

            return line;
        })
        .join("\n");
}

window.api.onOutput((chunk) => {
    if (terminal) {
        terminal.write(chunk);
    }
});

// CPUlator-style register tracking
let previousRegisterValues = {};
let currentRegisterValues = {};
let instructionTrace = [];
let performanceCounters = {
    cycles: 0,
    instructions: 0,
    branches: 0,
    memAccess: 0,
};

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

    // Keep only last 1000 entries
    if (instructionTrace.length > 1000) {
        instructionTrace.shift();
    }

    updateTraceDisplay();
    updatePerformanceCounters();
}

function updateTraceDisplay() {
    const tracePanel = document.getElementById("trace-content");
    if (!tracePanel) return;

    let html =
        '<div class="trace-header"><span>Cycle</span><span>PC</span><span>Instruction</span></div>';

    // Show last 20 instructions
    const recentTrace = instructionTrace.slice(-20);
    recentTrace.forEach((entry, index) => {
        html += `<div class="trace-entry ${index === recentTrace.length - 1 ? "current" : ""}">
            <span class="trace-cycle">${entry.cycle}</span>
            <span class="trace-pc">0x${entry.pc.toString(16).padStart(8, "0")}</span>
            <span class="trace-instruction">${entry.instruction}</span>
        </div>`;
    });

    tracePanel.innerHTML = html;
    tracePanel.scrollTop = tracePanel.scrollHeight;
}

function updatePerformanceCounters() {
    performanceCounters.instructions++;

    document.getElementById("statInstructions").textContent = performanceCounters.instructions;
    document.getElementById("statCycles").textContent = performanceCounters.cycles;
    document.getElementById("statPC").textContent = `0x${
        currentRegisterValues["pc"] || "00000000"
    }`;
    document.getElementById("statSP").textContent = `0x${
        currentRegisterValues["x2"] || "00000000"
    }`;
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

    // Enhance existing symbols panel with CPUlator-style functionality
    enhanceSymbolsPanel();

    // Add instruction lookup functionality
    document.addEventListener("click", (e) => {
        if (e.target && e.target.id === "clearTrace") {
            instructionTrace = [];
            performanceCounters.cycles = 0;
            performanceCounters.instructions = 0;
            updateTraceDisplay();
            updatePerformanceCounters();
            showNotification("Instruction trace cleared", "info");
        }

        if (e.target && e.target.id === "searchInstruction") {
            const searchTerm = document.getElementById("instructionSearch").value.trim().toLowerCase();
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

    console.log("✅ Features initialized");
}

function enhanceSymbolsPanel() {
    const refreshButton = document.getElementById("refreshSymbols");
    if (refreshButton) {
        refreshButton.addEventListener("click", async () => {
            try {
                // Get symbol information from emulator
                const result = await window.api.sendCmd("info symbols");
                if (result.ok) {
                    updateSymbolsDisplay(result.output);
                }
            } catch (error) {
                console.error("Failed to refresh symbols:", error);
            }
        });
    }
}

function updateSymbolsDisplay(symbolData) {
    const symbolsContent = document.getElementById("symbolsContent");
    if (!symbolsContent) return;

    let html = "";
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
        const matches = Object.keys(riscvInstructions).filter(key =>
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
                    ${matches.map(match => `
                        <div class="suggestion-item" onclick="displayInstructionInfo('${match}')">
                            <strong>${match}</strong> - ${riscvInstructions[match].name}
                        </div>
                    `).join("")}
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

document.addEventListener("DOMContentLoaded", initializeIDE);
