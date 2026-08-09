# RISC-V 32-bit Emulator IDE

A comprehensive RISC-V 32-bit processor emulator with an integrated development environment (IDE) built using Electron, featuring Monaco Editor and xterm.js for a modern debugging experience.

## References

This project was developed with reference to the [CPUlator Computer System Simulator](https://cpulator.01xz.net/?sys=rv32-spim), which provided valuable insights into RISC-V processor simulation and educational interface design.

**Note**: This repository is forked from an original implementation. Please refer to the git history and contributors for the complete development lineage.

## Features

### 🚀 Core Emulation

-   **RISC-V 32-bit ISA Support**: The RV32I computational, memory, branch, jump
    and upper-immediate instructions, plus the common pseudo-instructions
    (`li`, `la`, `mv`, `j`, `jr`, `ret`, `call`, `nop`, `beqz`, `bnez`, `bgt`,
    `ble`). See [Not implemented](#not-implemented) for the gaps.
-   **Real-time Execution**: Step-by-step instruction execution with debugging capabilities
-   **Memory Faults**: Out-of-range and misaligned accesses stop the program with
    a diagnostic naming the pc and source line, instead of corrupting memory
-   **Memory Examination**: Inspect any address in the 128 KB address space

### 💻 Integrated Development Environment

-   **Monaco Editor**: VS Code-style editor with syntax highlighting for RISC-V assembly
-   **Dual View Support**: Switch between Assembly (.s) and C (.c) files seamlessly
-   **File Management**: Workspace folder support with example programs included
-   **Syntax Highlighting**: Custom RISC-V assembly language support

### 🔧 Advanced Debugging Tools

-   **Real-time Register Display**: Live register values with role-based color coding
-   **Memory Inspector**: Examine memory contents with multiple display formats (hex, decimal, unsigned, binary, char)
-   **Disassembly Viewer**: Interactive disassembly with current instruction highlighting
-   **Source Code Mapping**: Synchronized source code and execution views
-   **Symbol Table**: Labels and symbols parsed from the current assembly buffer

### 📊 Performance Analysis

-   **Execution Statistics**: Instructions retired and memory reads/writes,
    counted by the emulator core and reported when a program halts
-   **Instruction Categorization**: Counters for arithmetic, branch, load/store
    and jump instructions, accumulated as you step

### 🎮 Interactive Controls

-   **Step Execution**: Single-step through instructions with "Step Into" functionality
-   **Breakpoint Management**: Set and remove breakpoints by source line, forwarded
    to the running emulator and replayed on restart
-   **Navigation Tools**: Quick jump to addresses, labels, or line numbers
-   **Memory Examination**: Direct memory access with configurable format and length
-   **Terminal Interface**: Command interface for the emulator's debugger — see
    [Debugger Commands](#debugger-commands)

### Not implemented

Called out so nobody goes looking for them:

-   **`ecall` / `ebreak` / `fence`, and any system-call mechanism.** Programs
    cannot do I/O; the only way to stop is the non-standard `hcf` instruction.
-   **String and alignment directives beyond the basics.** `.text`, `.data`,
    `.byte`, `.half`, `.word`, `.zero`/`.space`/`.skip`, and `.align` work;
    `.ascii`/`.asciiz`/`.string` do not. Metadata directives such as `.globl`
    and `.section` are accepted and ignored. Anything else is a hard error.
-   **Cache simulation.** `cachesim.cpp` contains an unfinished cache model that
    is *not* wired into the memory path — `mem_read`/`mem_write` go straight to
    the byte array. Its hit/miss counters therefore do not move, and the
    emulator no longer prints them.
-   **Call stack.** The core has no backtrace command, so the panel is derived
    heuristically from source text rather than from real stack state.
-   **Machine-code encoding.** The assembler builds an internal representation
    only; it never encodes instructions, so the disassembly view's opcode column
    is placeholder data.

## Installation

### Prerequisites

-   Node.js (v16 or higher)
-   npm or yarn
-   C++ compiler (for building the emulator core)
-   Make (for building the emulator binary)

### Setup

1. **Clone the repository**

    ```bash
    git clone https://github.com/jenna-studio/riscv32-emulator.git
    cd riscv32-emulator
    ```

2. **Install dependencies**

    ```bash
    npm install
    ```

3. **Build the emulator core**

    ```bash
    npm run build-emu
    # or manually:
    make
    ```

4. **Start the application**

    ```bash
    npm start
    # or for development with logging:
    npm run dev
    ```

5. **Run the test suite** (optional, but recommended after touching the core)

    ```bash
    ./run_examples.sh          # all checks
    ./run_examples.sh sort     # a single example
    ```

    This assembles and runs every example program, verifies that each halts
    cleanly rather than faulting, and checks the answer marker at `0x10000` for
    the programs that publish one. It also runs `tests/isa_smoke.s`, which pins
    down instruction semantics that the examples do not exercise (signed vs
    unsigned comparison, shift-amount masking, arithmetic vs logical right
    shift, `x0` staying zero, and load sign/zero extension). The script exits
    non-zero if anything fails.

## Usage

### Getting Started

1. **Load Assembly Files**: Use "Open .s" to load RISC-V assembly files or "New .s" to create new ones
2. **Compile and Load**: Click "Compile and Load" to prepare your program for execution
3. **Set Breakpoints**: Click on line numbers or use the breakpoint controls
4. **Execute**: Use "Step Into" for single-step debugging or "Continue" to run to the next breakpoint

### Debug Controls

-   **Step Into**: Execute one instruction at a time
-   **Continue**: Run until the next breakpoint, a fault, or program exit
-   **Run**: Restart the program from the beginning and run it
-   **Stop**: Halt execution

### Navigation

-   **Go Button**: Jump to specific line numbers, addresses, or labels
-   **Mem Button**: Examine memory at specific addresses
-   **Status Button**: Switch to the Statistics panel and refresh it

### Panel Overview

-   **Terminal**: Command interface for the emulator's debugger
-   **Registers**: Real-time register display with ABI names and roles
-   **Memory**: Formatted memory inspection with multiple display options
-   **Source**: Current source code with execution highlighting
-   **Disassembly**: Per-instruction listing with the current instruction highlighted
-   **Statistics**: Instruction and memory-access counters
-   **Symbol Table**: Labels and symbols from the current assembly buffer
-   **Call Stack**: Heuristic call/return log derived from source text

## Example Programs

The IDE includes several example programs in the `examples/` directory:

-   **Graph Algorithms** (`graph.c/s`): Graph traversal and manipulation
-   **Array Reduction** (`reduction.c/s`): Parallel reduction operations
-   **Sorting Algorithms** (`sort.c/s`): Various sorting implementations
-   **Sudoku Solver** (`sudoku.c/s`): Constraint satisfaction problem solving

`reduction`, `sort` and `sudoku` report their result by writing to the marker
word at `0x10000`, where zero means the computation was correct. `run_examples.sh`
checks that marker automatically.

## Debugger Commands

These are the commands the emulator core accepts, in the terminal panel or on
stdin. Dispatch is on the first character, so `s` and `step 3` differ from what
GDB would do — the list below is exhaustive.

| Command | Meaning |
| --- | --- |
| *(empty line)* | Step one instruction and print `Executed: <source>` |
| `s` / `s<N>` | Step one or N instructions. `N` must be a positive number |
| `c` | Continue to the next breakpoint, a fault, or program exit |
| `b` | List breakpoints |
| `b<line>` | Set a breakpoint on a source line |
| `B<line>` | Remove a breakpoint |
| `r` | Dump the register file |
| `r<reg>` | Dump one register, by number (`rx5`) or ABI name (`ra0`) |
| `m<addr> [n]` | Dump n words of memory. `m 0x8000 4` and `m0x8000 4` both work |
| `d<addr> [n]` | Disassemble n instructions |
| `l` | List the compiled program with a marker on the current instruction |
| `h` / `?` | Show the command list |
| `q` | Quit |

Anything else is reported as `Unknown command`. Every run ends with a
`PROGRAM_EXIT: <reason>` line — `halted`, `quit`, `unimplemented`, or `fault` —
which is the signal the IDE uses to detect that a program has finished.

### Memory map

| Range | Use |
| --- | --- |
| `0x00000`–`0x07fff` | Text segment (instructions) |
| `0x08000`–`0x1ffff` | Data segment |
| `0x10000` | Default stack top; the stack grows downward from here |
| `0x10000` | Also the answer marker word used by the example programs |

Data accesses outside `0x00000`–`0x1ffff`, and misaligned halfword/word
accesses, stop the program with a `FAULT:` line naming the pc and source line
rather than corrupting memory.

## Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `Ctrl+1` … `Ctrl+5` | Switch to Registers / Source / Disassembly / Memory / Statistics |
| `F5` | Run |
| `Shift+F5` | Stop |
| `F10` | Step Into |
| `Esc` | Focus the command box |

## Building for Distribution

### Development Build

```bash
npm run dev
```

### Production Builds

The build process automatically compiles the RISC-V emulator before packaging to ensure the latest version is included.

```bash
# Build for current platform (automatically runs prebuild)
npm run build

# Platform-specific builds (all include automatic prebuild)
npm run build:mac    # macOS, unpacked app bundle
npm run build:win    # Windows NSIS installer
npm run build:linux  # Linux AppImage
```

### Build Process Details

Each build command includes these steps:

1. **Prebuild**: Compiles the C++ emulator core (`make`)
2. **Package**: Creates the Electron application bundle

Note that `build` and `build:mac` pass `--dir` to electron-builder, which
produces an unpacked application directory rather than an installer. Drop
`--dir` from the script in `package.json` to get a DMG.


## Architecture

### Frontend (Electron + Web Technologies)

-   **main.js**: Electron main process, handles window management and IPC
-   **renderer.js**: Main application logic, UI interactions, and emulator communication
-   **preload.js**: Secure bridge between main and renderer processes
-   **index.html**: Application structure and layout
-   **styles.css**: Complete styling and responsive design

### Backend (C++ Emulator Core)

-   **emulator.cpp**: Assembler, RISC-V processor emulation engine, and debugger
-   **cachesim.cpp/h**: Memory accessors, plus an unfinished cache model that is
    not yet connected to them
-   **linenoise.hpp**: Present but unused; the debugger reads stdin with `fgets`

### Key Technologies

-   **Electron**: Cross-platform desktop application framework
-   **Monaco Editor**: VS Code editor component for code editing, loaded from a CDN
-   **C++11**: Emulator core implementation

The terminal panel is a purpose-built DOM renderer in `renderer.js`, not xterm.js.

## Development

### Project Structure

```
riscv32-emulator/
├── main.js                 # Electron main process
├── renderer.js             # Frontend application logic
├── preload.js              # IPC bridge
├── index.html              # Application UI structure
├── styles.css              # Styling and layout
├── package.json            # Dependencies and scripts
├── Makefile                # Emulator build configuration
├── emulator.cpp            # RISC-V assembler, emulator core and debugger
├── cachesim.cpp/h          # Memory accessors and an unfinished cache model
├── linenoise.hpp           # Unused
├── run_examples.sh         # Regression checks for the emulator core
├── examples/               # Example RISC-V programs
├── tests/                  # Instruction-semantics smoke test
├── obj/                   # Build output directory
└── dist/                  # Distribution builds
```

### Key Features Implementation

-   **Real-time Debugging**: Synchronized execution state across all panels
-   **Memory Management**: Comprehensive memory inspection with multiple formats
-   **Performance Monitoring**: Live instruction and performance counters
-   **Cross-platform**: Native builds for macOS, Windows, and Linux
-   **Extensible**: Modular design for easy feature additions


## License

This project is licensed under the MIT License. (No `LICENSE` file has been added
to the repository yet.)

## Acknowledgments

-   [CPUlator Computer System Simulator](https://cpulator.01xz.net/?sys=rv32-spim) for reference and inspiration in RISC-V simulation design
-   RISC-V Foundation for the excellent ISA specification
-   Monaco Editor team for the powerful code editor
-   xterm.js team for the terminal emulator
-   Electron team for the cross-platform framework
-   Original repository contributors and maintainers


