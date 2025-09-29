# RISC-V 32-bit Emulator IDE

A comprehensive RISC-V 32-bit processor emulator with an integrated development environment (IDE) built using Electron, featuring Monaco Editor and xterm.js for a modern debugging experience.

## References

This project was developed with reference to the [CPUlator Computer System Simulator](https://cpulator.01xz.net/?sys=rv32-spim), which provided valuable insights into RISC-V processor simulation and educational interface design.

**Note**: This repository is forked from an original implementation. Please refer to the git history and contributors for the complete development lineage.

## Features

### 🚀 Core Emulation

-   **RISC-V 32-bit ISA Support**: Full implementation of RV32I base instruction set
-   **Cache Simulation**: Built-in cache performance modeling
-   **Real-time Execution**: Step-by-step instruction execution with debugging capabilities
-   **Memory Management**: Complete memory examination and manipulation tools

### 💻 Integrated Development Environment

-   **Monaco Editor**: VS Code-style editor with syntax highlighting for RISC-V assembly
-   **Dual View Support**: Switch between Assembly (.s) and C (.c) files seamlessly
-   **File Management**: Workspace folder support with example programs included
-   **Syntax Highlighting**: Custom RISC-V assembly language support

### 🔧 Advanced Debugging Tools

-   **Real-time Register Display**: Live register values with role-based color coding
-   **Memory Inspector**: Examine memory contents with multiple display formats (hex, decimal, binary, char)
-   **Disassembly Viewer**: Interactive disassembly with current instruction highlighting
-   **Source Code Mapping**: Synchronized source code and execution views
-   **Call Stack Tracking**: Function call hierarchy visualization
-   **Symbol Table**: Complete symbol and label information display

### 📊 Performance Analysis

-   **Execution Statistics**: Track instructions executed, cycles, branches, and memory accesses
-   **Instruction Categorization**: Separate counters for arithmetic, branches, loads/stores, and system calls
-   **Performance Counters**: Real-time performance metrics and analysis

### 🎮 Interactive Controls

-   **Step Execution**: Single-step through instructions with "Step Into" functionality
-   **Breakpoint Management**: Set and manage breakpoints at specific line numbers
-   **Navigation Tools**: Quick jump to addresses, labels, or line numbers
-   **Memory Examination**: Direct memory access with configurable format and length
-   **Terminal Interface**: Full GDB-style command interface

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

## Usage

### Getting Started

1. **Load Assembly Files**: Use "Open .s" to load RISC-V assembly files or "New .s" to create new ones
2. **Compile and Load**: Click "Compile and Load" to prepare your program for execution
3. **Set Breakpoints**: Click on line numbers or use the breakpoint controls
4. **Execute**: Use "Step Into" for single-step debugging or "Continue" for running multiple instructions

### Debug Controls

-   **Step Into**: Execute one instruction at a time
-   **Continue**: Run 100 instructions (or until breakpoint)
-   **Run**: Execute program from the beginning
-   **Stop**: Halt execution

### Navigation

-   **Go Button**: Jump to specific line numbers, addresses, or labels
-   **Mem Button**: Examine memory at specific addresses
-   **Status Button**: View comprehensive program status

### Panel Overview

-   **Terminal**: Interactive command interface with GDB-style commands
-   **Registers**: Real-time register display with ABI names and roles
-   **Memory**: Formatted memory inspection with multiple display options
-   **Source**: Current source code with execution highlighting
-   **Disassembly**: Machine code disassembly with instruction details
-   **Statistics**: Performance metrics and instruction counters
-   **Symbol Table**: Program symbols, functions, and labels
-   **Call Stack**: Function call hierarchy and return addresses

## Example Programs

The IDE includes several example programs in the `example_questions/` directory:

-   **Graph Algorithms** (`graph.c/s`): Graph traversal and manipulation
-   **Array Reduction** (`reduction.c/s`): Parallel reduction operations
-   **Sorting Algorithms** (`sort.c/s`): Various sorting implementations
-   **Sudoku Solver** (`sudoku.c/s`): Constraint satisfaction problem solving

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
npm run build:mac    # macOS DMG
npm run build:win    # Windows NSIS installer
npm run build:linux  # Linux AppImage
```

### Build Process Details

Each build command now includes these steps:

1. **Prebuild**: Compiles the C++ emulator core (`make`)
2. **Package**: Creates the Electron application bundle
3. **Distribute**: Generates platform-specific installers


## Architecture

### Frontend (Electron + Web Technologies)

-   **main.js**: Electron main process, handles window management and IPC
-   **renderer.js**: Main application logic, UI interactions, and emulator communication
-   **preload.js**: Secure bridge between main and renderer processes
-   **index.html**: Application structure and layout
-   **styles.css**: Complete styling and responsive design

### Backend (C++ Emulator Core)

-   **emulator.cpp**: Main RISC-V processor emulation engine
-   **cachesim.cpp/h**: Cache simulation and performance modeling
-   **linenoise.hpp**: Command-line interface library

### Key Technologies

-   **Electron**: Cross-platform desktop application framework
-   **Monaco Editor**: VS Code editor component for code editing
-   **xterm.js**: Terminal emulator for interactive debugging
-   **C++11**: High-performance emulator core implementation

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
├── emulator.cpp            # RISC-V emulator core
├── cachesim.cpp/h          # Cache simulation
├── linenoise.hpp           # Command line interface
├── example_questions/      # Example RISC-V programs
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

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

-   [CPUlator Computer System Simulator](https://cpulator.01xz.net/?sys=rv32-spim) for reference and inspiration in RISC-V simulation design
-   RISC-V Foundation for the excellent ISA specification
-   Monaco Editor team for the powerful code editor
-   xterm.js team for the terminal emulator
-   Electron team for the cross-platform framework
-   Original repository contributors and maintainers


