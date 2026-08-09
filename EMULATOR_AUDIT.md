# RISC-V 32 Emulator IDE — Feature Audit and Fix Plan

**Date:** 2026-08-09
**Scope:** `emulator.cpp`, `cachesim.cpp`/`.h`, `renderer.js`, `main.js`, `preload.js`, `index.html`, `README.md`, `example_questions/`
**Method:** Five independent read-throughs of the codebase, cross-checked against the emulator's actual `printf` formats, plus empirical runs of the compiled binary (`g++ -o emu cachesim.cpp emulator.cpp -std=c++11`) driven with piped stdin. Every finding below cites a file and line; claims marked *verified* were reproduced by executing the code.

---

## Executive summary

The IDE shell is in much better shape than the thing it is a shell for. The editor, file management, syntax highlighting, terminal rendering, and panel layout all work. The **emulation core and the data pipeline between the core and the panels are substantially broken**, in ways that produce confidently-displayed wrong answers rather than visible errors.

Three findings dominate everything else:

1. **The four shipped example programs do not run.** `graph.s` and `sort.s` crash with SIGBUS, `sudoku.s` hangs, and `reduction.s` completes with garbage registers. The root cause is a single line: memory operands written with ABI register names — `12(sp)`, `0(a0)` — resolve their base register to the wrong number, usually `x0`. Since every one of the examples is compiler output that uses this syntax exclusively (`graph.s` alone has 100 such operands), the project's own on-ramp is non-functional.
2. **Register values shown in the UI are wrong.** The emulator prints registers in unprefixed hex (`x02: 00010000`); the renderer parses them as decimal. `0x10000` displays as `0x2710`, and any value containing a hex letter is truncated at that letter. Separately, x0–x9 are looked up under a key that never exists, so **ra, sp, gp, tp, t0–t2, s0, s1 permanently display 0**.
3. **Several panels present fabricated data as measurement.** The Call Stack synthesizes frames in JavaScript (including one labelled "hypothetical caller" in the source) because no backtrace command exists. The Symbol Table parses the editor buffer, not the loaded program, with hardcoded base addresses that are off by 0x400000. Four of the eight statistics tiles are wired to a parser branch keyed on a string the emulator never prints, so they read 0 forever. The cache simulator is unreferenced dead code whose "hit" counters are printed to the user as zeros.

Counts: **14 critical**, **21 major**, **30 minor**. The critical list is dominated by one-to-three-line fixes with disproportionate impact — the disassembly panel, for instance, is empty for the entire program because of a `sizeof` applied to a pointer.

---

## A. Instruction set and assembler (`emulator.cpp`)

### A1 — CRITICAL — Memory operands ignore ABI register names

[emulator.cpp:132](emulator.cpp#L132)

```cpp
*imm = signextend(strtol(in, NULL, 0), bits);
*reg = atoi(lpar+2);
```

`lpar+2` skips `(` *and one more character*, which is only correct for the `x<N>` spelling. The resulting mapping is not merely wrong, it is arbitrary: `0(sp)` → `atoi("p")` → **x0**; `0(a0)` → **x0**; `0(t1)` → **x1** (the return-address register); `0(t4)` → **x4**. `parse_reg` ([emulator.cpp:203-234](emulator.cpp#L203-L234)) already knows every ABI alias — `parse_mem` simply never calls it.

*Verified.* This is the direct cause of all four example programs failing. Combined with A2 and A4, stack traffic lands in the text segment or past the end of the arena.

**Fix:** null-terminate at `)` (already done) and call `parse_reg(lpar+1, line)`. Route the displacement through `parse_imm` rather than a bare `strtol`.

### A2 — CRITICAL — The stack pointer is never initialized

[emulator.cpp:771-774](emulator.cpp#L771-L774) zeroes all 32 registers and nothing sets `x2`. The universal prologue `addi sp, sp, -16` therefore yields `0xFFFFFFF0`, and the following `sw ra, 12(sp)` writes ~4 GB into a 64 KB buffer. No stack region is reserved anywhere in the layout: text is `[0, 32768)`, data is `[32768, …)`, and nothing is set aside above it.

**Fix:** set `rf[2] = MEM_BYTES` (or a defined stack top) after the zeroing loop, and document the memory map.

### A3 — CRITICAL — `sltu` performs addition

[emulator.cpp:947](emulator.cpp#L947)

```cpp
case SLTU: rf[i.a1.reg] = rf[i.a2.reg] + rf[i.a3.reg]; break;
```

*Verified:* `sltu t4, t1, t1` with `t1 = 0x2222` yields `0x4444`; the correct result is 0. `slt` immediately above it and `sltiu` below it are both correct, so this is an isolated typo — but it is a silent wrong-answer bug in unsigned bounds checks, carry detection, and multi-word arithmetic.

**Fix:** `rf[i.a1.reg] = rf[i.a2.reg] < rf[i.a3.reg] ? 1 : 0;`

### A4 — CRITICAL — No bounds checking on any data memory access

[cachesim.cpp:119-160](cachesim.cpp#L119-L160). `mem_read`/`mem_write` index `mem[addr]` and `*(uint32_t*)(mem+addr)` with zero validation, while `addr = rf[base] + imm` ([emulator.cpp:966](emulator.cpp#L966), [:973](emulator.cpp#L973)) is an unconstrained 32-bit value. Out-of-range access reads or writes arbitrary heap and eventually SIGBUSes with no reference to the offending instruction. *Verified:* `m 0x7ffffff0` crashes the process with rc=138.

**Fix:** validate `addr + size <= MEM_BYTES` in both functions and raise an emulator-level fault naming the pc and source line. Also check alignment (see A11).

### A5 — CRITICAL — `parse_reg` accepts `x32`, writing past the register file

[emulator.cpp:195](emulator.cpp#L195) tests `ri < 0 || ri > 32`, off by one. `rf` is a 32-entry stack array in `execute` ([emulator.cpp:766](emulator.cpp#L766)), so `rf[32]` corrupts adjacent locals — `rf_mirror`, `pc`, `inst_cnt`. *Verified:* `r x32` prints `rf[32] = 0xa2d00e8` from an adjacent stack slot. Trailing junk is also unchecked (`x1abc` parses as `x1`).

**Fix:** `ri > 31`, and reject non-numeric remainders.

### A6 — CRITICAL — Instruction fetch is unbounded

[emulator.cpp:782-783](emulator.cpp#L782-L783) computes `iid = pc/4` and reads `imem[iid]`, but `pc` is only wrapped to `MEM_BYTES` ([emulator.cpp:1017](emulator.cpp#L1017)) while `imem` holds `DATA_OFFSET/4` = 8192 entries. `iid` can reach 16383 — a 2× overread of a struct containing a `char*` that is then passed to `printf("%s")`. Reachable from any jump into the data segment, i.e. from A1 or A2.

**Fix:** fault when `iid >= DATA_OFFSET/4` before the fetch.

### A7 — CRITICAL — `imem` is `malloc`'d, so constructors never run

[emulator.cpp:1135](emulator.cpp#L1135) allocates with `malloc`; the init loop at [:1147-1152](emulator.cpp#L1147-L1152) sets only `op` and three `type` fields. `instr`'s constructor ([emulator.cpp:73](emulator.cpp#L73)) — which would set `psrc = NULL`, `breakpoint = false`, `orig_line = -1` — never runs. So `i.breakpoint` ([:786](emulator.cpp#L786)) is read from uninitialized memory, and `i.psrc` is dereferenced at [:1010](emulator.cpp#L1010) and [:1021](emulator.cpp#L1021).

It already produces a live bug: untouched entries read `orig_line == 0`, so *verified* `b0` prints "Break point added to line 0" **8,190 times** and arms a breakpoint on every empty slot.

**Fix:** `new instr[DATA_OFFSET/4]` and delete the partial init loop.

### A8 — MAJOR — Shift amounts are not masked to 5 bits

[emulator.cpp:951-953](emulator.cpp#L951-L953), [:961-963](emulator.cpp#L961-L963). RV32I defines the shift amount as `rs2[4:0]`; here a shift of 33 is C++ undefined behavior. x86 masks to 5 bits by accident, ARM64 yields 0 — so **results differ by build host**. The immediate forms are worse: `i.a3.imm` is a sign-extended 12-bit value, so `srli x1, x2, -1` shifts by `0xFFFFFFFF`.

**Fix:** `& 0x1f` on every shift amount; reject `slli/srli/srai` immediates outside 0–31 at parse time.

### A9 — MAJOR — `jalr` does not clear bit 0 and mishandles `rd == rs1`

[emulator.cpp:992](emulator.cpp#L992)

```cpp
case JALR: rf[i.a1.reg] = pc + 4; pc_next = rf[i.a2.reg] + i.a3.imm; break;
```

The spec requires `pc_next = (rs1 + imm) & ~1`. And `rd` is written **before** `rs1` is read, so the common `jalr ra, 0(ra)` jumps to `pc+4` instead of the intended target.

**Fix:** compute the target into a temporary, mask bit 0, then write the link register.

### A10 — MAJOR — Unknown mnemonics assemble silently

[emulator.cpp:189](emulator.cpp#L189) returns `UNIMPL` for anything unrecognized, and [:633-635](emulator.cpp#L633-L635) accepts it. A typo (`addd`), a genuinely missing RV32I instruction (`ecall`, `ebreak`, `fence`), or an unsupported pseudo-instruction produces **no assembler diagnostic at all** — it reserves a slot and fails at runtime, and only if that path is reached. Dead code containing typos is never reported.

Confirmed-absent pseudo-instructions: `neg`, `not`, `seqz`, `snez`, `sltz`, `sgtz`, `bgez`, `blez`, `bltz`, `bgtz`, `bgtu`, `bleu`, `tail`, and the one-operand `jalr rs`.

**Fix:** call `print_syntax_error(line, "Unknown instruction")` in the `UNIMPL` case of the parsing path, keeping the enum only as the never-assembled sentinel.

### A11 — MAJOR — Missing assembler directives; unknown ones only warn

[emulator.cpp:324-346](emulator.cpp#L324-L346). Supported: `.text`, `.data`, `.byte`, `.half`, `.word`, `.zero`. Absent: `.globl`, `.align`, `.asciiz`, `.string`, `.ascii`, `.space`, `.section`, `.equ`. The `exit(3)` on an unknown directive is commented out, so the near-universal `.globl main` prints a scary error and continues. **There is no way to place a string in memory at all.**

Compounding this, [emulator.cpp:326](emulator.cpp#L326) matches with `memcmp(ftok, ".text", strlen(ftok))` — the length comes from the *input*, so `.t` matches `.text` and a bare `.` resets `memoff` to 0.

**Fix:** implement `.space`/`.align`/`.asciiz`/`.string`/`.ascii`, accept-and-ignore `.globl`/`.section`, use exact `strcmp`, and make genuinely unknown directives fatal.

### A12 — MAJOR — Section switches reset to fixed constants

[emulator.cpp:331](emulator.cpp#L331) and [:335](emulator.cpp#L335) set `memoff` to `TEXT_OFFSET`/`DATA_OFFSET` with no per-section cursor. The idiomatic `.data … .text … .data …` layout overwrites the first data block, and labels recorded for it then point at the second block's bytes.

### A13 — MAJOR — Data memory is never zeroed

[emulator.cpp:1134](emulator.cpp#L1134) `malloc`s 64 KB with no `memset`. Uninitialized `.data` and the notional stack contain allocator residue, so a `lw` from an untouched address returns nondeterministic values. *Verified:* `reduction.s` finishes with registers holding `0xcccccccc` — the parser's instruction-word filler, read back as data.

### A14 — MAJOR — `lui` rejects the upper half of its legal range

[emulator.cpp:685](emulator.cpp#L685) → `parse_imm(o2, 20, line)` treats the field as signed, accepting only `[-524288, 524287]`. `lui a0, 0x80000` — an ordinary way to build `0x80000000` — is rejected. The internal `li`/`la` expansions bypass `parse_imm` and use the full unsigned range, so hand-written `lui` is stricter than generated `lui`.

### A15 — MAJOR — `parse_imm` accepts malformed input

[emulator.cpp:241-251](emulator.cpp#L241-L251) validates only the first character and discards `strtol`'s `endptr`, so `12abc` → 12 and `0x` → 0, silently. `errno`/`ERANGE` is never consulted; a leading `+` is rejected outright.

### A16 — MAJOR — Branch/jump range checks are wrong

[emulator.cpp:1104](emulator.cpp#L1104) uses `1<<13` for the B-type range (correct is ±4 KiB, `1<<12`). At [:1071-1073](emulator.cpp#L1071-L1073) the `JAL` check reads `ii->a3.imm`, but `jal`'s target lives in `a2` — so it measures distance from 0 and never meaningfully fires.

### Minor (instruction set)

| Ref | Issue |
|---|---|
| [:1018](emulator.cpp#L1018) | `x0` is writable for the duration of one instruction; restored afterwards, so only observable via A9's `rd == rs1` path. |
| [:304](emulator.cpp#L304) | `.byte -300` passes the range check — only positive overflow is caught (`vs > 0 && vs != -1`). |
| [:310](emulator.cpp#L310), [:320](emulator.cpp#L320) | `.word`/`.zero` can write past the 64 KB buffer; a bare `.zero` dereferences NULL. |
| [:255](emulator.cpp#L255), [:263](emulator.cpp#L263) | `sprintf` into a 256-byte stack buffer from a 1024-byte line — stack smash driven by `.s` file contents. Use `snprintf`. |
| [:416](emulator.cpp#L416), [:454](emulator.cpp#L454) | Dead error handling: the `if (reg < 0) return 0` fallback is unreachable because `parse_reg` defaults to `strict = true` and exits. `sw rd, label` also silently clobbers t0. |
| [:290](emulator.cpp#L290) | `label_addr` has no return on the not-found path; safe only because `print_syntax_error` exits. Mark it `[[noreturn]]`. |
| [:30](emulator.cpp#L30) | `signextend` shifts a negative value (UB pre-C++20). |
| [:727](emulator.cpp#L727) | `loop:add x1,x2,x3` (no space after the colon) parses as a mnemonic and silently becomes `UNIMPL`. |
| [:716](emulator.cpp#L716) | The whole line is lowercased before parsing — makes labels case-insensitive and will destroy string literals once `.asciiz` exists. |
| [:569](emulator.cpp#L569), [:581](emulator.cpp#L581), [:513](emulator.cpp#L513) | `append_source` renders `bnez`/`beqz`/`ret` operands in the wrong order; listing output misleads, execution is unaffected. |
| cachesim.cpp:130 | Unaligned `lw`/`sw` is UB rather than a trap; real RV32I faults. |

### What is correct

Worth recording, because the coverage is genuinely broad: all computational, memory, branch, jump, and upper-immediate opcodes parse and execute; signed-vs-unsigned comparison is right everywhere except A3 (including the subtle `sltiu` case); `sra`/`srl` are properly distinguished; load sign-extension and store widths are clean and table-driven; `lui`/`auipc` immediate placement is correct; the link register gets `pc+4`; `li`/`la` expansion is arithmetically correct for all 32-bit values; forward label references resolve; ABI aliases are complete in `parse_reg`; comment stripping handles `#`, `;` and `//`; operand-count validation is per-class with line-numbered errors.

**Missing from RV32I:** `ecall`, `ebreak`, `fence`, `fence.i`, and all Zicsr. **There is no syscall mechanism of any kind** — the only termination primitive is the non-standard `hcf`. The README's "system calls" statistics counter therefore counts something that cannot occur.

---

## B. Debugger REPL and I/O protocol (`emulator.cpp`)

### Command inventory (verified by execution)

| Command | Behavior |
|---|---|
| *(empty)* | Single step; prints `Executed: <src>` plus register diffs. |
| `s` | Single step; does **not** print `Executed:` — a different protocol from Enter. |
| `sN` | Executes exactly N. No off-by-one. |
| `c` | Run to breakpoint or end — unless stale `stepcnt` (B4). |
| `q` | `exit(0)` immediately, without the `Execution done!` sentinel. |
| `b` / `bN` / `BN` | List / set / delete breakpoints. |
| `r` / `rx5` | Full or single register dump. `r5` does not work. |
| `m` | Broken (B5). |
| `d` / `disassemble` | Broken (B2). |
| `l` | Source listing plus `CURRENT_LINE:`. Works. |
| anything else | **Silently ignored.** No error, no `help`. |

Dispatch is on `keybuf[0]` only, via sequential `if`s. So `list`→`l`, `run`→`r`, `clear`→`c`, `step`→`s`, and — see D6 — `stack`→`s`.

### B1 — CRITICAL — Unchecked `fgets` at EOF spins forever

[emulator.cpp:797](emulator.cpp#L797). The return value is discarded and `keybuf` is never initialized ([:778](emulator.cpp#L778)). At EOF `fgets` returns NULL and leaves the buffer untouched, so the previous command re-executes forever; `r`/`m`/`l`/`b`/`d` don't break the inner loop.

*Verified:* `./emu t.s < /dev/null` emitted **6,295,305 lines in 3 seconds** and never exited. If the Electron main process dies or closes stdin, the orphaned emulator pins a core indefinitely.

**Fix:** `char keybuf[128] = {0};` and exit cleanly when `fgets` returns NULL.

### B2 — CRITICAL — `sizeof` on a pointer empties the disassembly panel

[emulator.cpp:909](emulator.cpp#L909)

```cpp
if (current_addr < sizeof(mem)) {   // mem is uint8_t* — sizeof is 8
```

Only addresses 0 and 4 are ever emitted. *Verified:* `disassemble 0x0,+20` — the exact form [renderer.js:2245](renderer.js#L2245) sends — returns **two lines**, and once `pc >= 8` the panel is permanently empty.

**Fix:** `if (current_addr + 3 < MEM_BYTES)`.

### B3 — CRITICAL — Disassembly opcodes are filler, not machine code

The assembler never encodes instructions; it writes `0xcccccccc` into every instruction word ([emulator.cpp:750](emulator.cpp#L750), [:759](emulator.cpp#L759)), and the disassembler reads those bytes back. The UI renders the column as if it were a real encoding: `00000000: cccccccc    lui x02, …`.

**Fix:** emit real encodings, or drop the column from both the emulator and [renderer.js:3706](renderer.js#L3706).

### B4 — MAJOR — A breakpoint hit does not reset `stepcnt`, so `c` degrades into `sN`

[emulator.cpp:786-788](emulator.cpp#L786-L788) enters the debug loop without clearing `stepcnt`, and [:1035-1040](emulator.cpp#L1035-L1040) keeps decrementing it. If a breakpoint fires part-way through an `sN`, the residual count survives and forces the *next* `c` to stop early.

*Verified* with `b6`, `s5`, `c`: the breakpoint hit after 3 of 5 steps, then `c` stopped after exactly the 2 residual steps at a line with no breakpoint. Continue is non-deterministic after any breakpoint hit mid-run.

**Fix:** `stepcnt = 0;` immediately after `stepping = true;` at [:789](emulator.cpp#L789).

### B5 — MAJOR — `m` parses the same token as both address and count

[emulator.cpp:874-889](emulator.cpp#L874-L889) reads the address from `keybuf+1`, then takes the count from the second `strtok` token — but the first token is `"m"` and the second is the *address*. So the count becomes the address and the real length argument is discarded. There is also no bounds check before `mem[addr+(w*4)+i]`.

*Verified* against the exact form the renderer sends:

| Input | Expected | Actual |
|---|---|---|
| `m0` | 1 word @0 | 1 word @0 ✓ |
| `m 0 3` | 3 words @0 | **nothing** (count = 0) |
| `m 0x8000 16` | 16 words | **32,768 rows**, reading ~98 KB past the buffer |
| `m 0x7ffffff0` | error | **SIGBUS, rc=138** |

The syntax the emulator actually wants is `m0x1000 16`, with no space — which is exactly what the command box's own placeholder ([index.html:429](index.html#L429)) tells the user.

**Fix:** tokenize once for the address and once for the count; clamp both to `MEM_BYTES`. Then change the renderer to send `m${addr} ${len}` (D3).

### B6 — MAJOR — `s0`, `s-2`, and `sgarbage` become an uninterruptible free-run

[emulator.cpp:816-823](emulator.cpp#L816-L823) parses the count with `strict = false`, so `s0`, `sfoo` and `sabc` all yield 0 and `s-2` yields −2. The decrement guard requires `stepcnt > 0`, so `stepping` stays false forever and the program runs to termination with no output and no way to interrupt. *Verified* for all three inputs.

### B7 — MAJOR — `\r` is not stripped, breaking Windows input

[emulator.cpp:801-803](emulator.cpp#L801-L803) strips only `\n`, while [main.js:417](main.js#L417) writes `${line}${os.EOL}` — CRLF on Windows. *Verified* by feeding CRLF directly: `s\r\n` free-runs instead of stepping, and a bare Enter matches no handler and does nothing. CRT text-mode translation usually masks this, but the debugger is one `setmode` away from being fully broken on Windows.

**Fix:** `keybuf[strcspn(keybuf, "\r\n")] = '\0';`

### Minor (REPL)

- **Three incompatible status-line formats.** The prompt prints `[inst: %4d, pc: %4d, src: %4d]` ([:793](emulator.cpp#L793)); the halt paths print the same fields **without brackets** ([:1000](emulator.cpp#L1000), [:1012](emulator.cpp#L1012)); and three renderer parsers expect a fourth format that the C++ never emits (see D4). Emit one canonical machine-readable line from a single helper.
- **`inst:` is off by one** at the prompt — `inst_cnt++` happens before execution.
- **Termination is ambiguous.** All three exits use `exit(0)`. Falling off the end of a program without `hcf` reports `Reached an unimplemented instruction!`, which looks like an error; `q` omits the `Execution done!` sentinel entirely. `main.js` cannot distinguish clean halt from quit from run-off-end.
- **No completion event for run-to-end.** `main.js` finalizes a command when the buffer ends with `">> "`; when `c` runs to termination no further prompt is emitted, so the command always hits the 2 s timeout. (`fflush` pairing is otherwise correct — no hang is attributable to buffering.)
- **Unknown commands are silently ignored** — no error, no `help`. `info program` and `info stack`, both sent by the renderer, return empty output that the UI renders as blank panels.
- `bN` reports once per expanded pseudo-instruction, so `b3` on `li x1, 0x12345` prints twice.
- Input longer than 127 characters is split into spurious follow-up commands.
- Typo, user-visible: `"Listing compiled isntructions"` ([:923](emulator.cpp#L923)).

---

## C. Cache simulator (`cachesim.cpp` / `.h`)

### C1 — MAJOR — The cache simulator is dead code, and its statistics are structurally always zero

`cache_read`, `cache_write`, `cache_init`, and `cache_print_stats` have **zero call sites**. The first two aren't even declared in `cachesim.h`, so `emulator.cpp` could not call them. Loads and stores go directly to `mem_read`/`mem_write` ([cachesim.cpp:119](cachesim.cpp#L119), [:143](cachesim.cpp#L143)), which are plain byte-array accessors that touch no cache structure.

Worse, the two counters the emulator *prints* to the user — `cache_read_hits` and `cache_write_hits` at [emulator.cpp:1002-1003](emulator.cpp#L1002-L1003) — are never incremented anywhere in the repo (`cache_read`/`cache_write` increment a different variable, `g_cache_hits`). *Verified:* every run prints `Cache read 0/2 Cache write 0/1` and `Cache flush words: 0`.

Even if it were wired up, it would not work: the valid bit is **never set anywhere in the file**, so every line stays invalid and the hit rate is permanently 0%; there is no replacement policy (the comments admit this); and `cache_read` returns 0 on a miss, which would corrupt loaded data if used as the data path. The index/tag/offset arithmetic is, for what it's worth, correct.

The UI side doesn't exist either: [renderer.js:3618-3626](renderer.js#L3618-L3626) looks up `statCacheHits` and `statCacheMisses`, neither of which appears in `index.html`.

**Decision required:** implement allocate-on-miss + LRU + writeback and route loads/stores through it, or delete the module and the misleading `printf`s. Printing counters that cannot be nonzero is the worst of the three options.

### C2 — MAJOR — Configuration macros are silently overridden

[cachesim.h:9-11](cachesim.h#L9-L11) says "Change these to configure the cache", then [cachesim.cpp:6-8](cachesim.cpp#L6-L8) redefines them **after** the include, with conflicting values (WAYS 3 vs 0). The build emits five `-Wmacro-redefined` warnings. Editing the header as documented has no effect.

---

## D. IDE display panels (`renderer.js`)

### Reference: what the emulator actually prints

| Command | Format | Source |
|---|---|---|
| `r` | `x%02d: %08x` ×4 per line — **hex, no `0x` prefix, no PC** | [:111](emulator.cpp#L111) |
| prompt | `[inst: %4d, pc: %4d, src: %4d]` — **pc/src decimal** | [:793](emulator.cpp#L793) |
| reg change | `>> rf[x%02d] %x -> %x` — **hex, unprefixed** | [:1029](emulator.cpp#L1029) |
| `m` | `0x%04x: ` + `%02x ` ×4 | [:883-888](emulator.cpp#L883-L888) |
| `d` | `%08x: %08x    %s` | [:918](emulator.cpp#L918) |
| `l` | `%c%8d: %s` plus `CURRENT_LINE: %d` | [:930-935](emulator.cpp#L930-L935) |

There is **no** `info registers`, `info program`, `info stack`, `backtrace`, `bt`, `where`, `stack`, `Next:`, symbol, or statistics command. The renderer sends several of them anyway.

### D1 — CRITICAL — Register values are parsed as decimal but printed as hex

[renderer.js:163](renderer.js#L163) and [:140-156](renderer.js#L140-L156). `normalizeRegisterValue` only uses base 16 when the text carries a literal `0x` prefix, which `%08x` never emits. Feeding the real binary's output through this exact code:

| Emulator prints | UI displays | Truth |
|---|---|---|
| `x02: 00010000` | `0x00002710` | 65536 |
| `x03: 00000010` | `0x0000000a` | 16 |
| `x01: 0000dead` | `0x00000000` | 57005 |

Values containing `a`–`f` are truncated at the first hex letter, because the regex's `\d+` alternative stops there. Every non-trivial register in the panel is wrong, and so are `statSP`, the SP-derived memory address, and the return-address readout. The register-change parser at [:3871](renderer.js#L3871) has the identical defect, so it corrupts the state even after the dump parser is fixed.

**Fix:** parse register-dump and `rf[…]` values with base 16 unconditionally; keep base 10 only for the banner's `pc`/`src` fields. Cleanest is two separate parsers.

### D2 — CRITICAL — x0–x9 permanently display 0

The parser captures the emulator's zero-padded `x00`…`x09`, but the renderer looks them up unpadded at [renderer.js:4761](renderer.js#L4761) (`` `x${i}` `` → `"x0"`, `"x1"`, …). Those keys never exist, so the code falls back to `"0"`. **ra, sp, gp, tp, t0–t2, s0 and s1 always render as zero** and never highlight as changed. x10–x31 happen to match.

**Fix:** canonicalize keys to `x${parseInt(n, 10)}` at ingest and use one form everywhere.

### D3 — CRITICAL — The memory panel sends a command form the emulator cannot parse

[renderer.js:2276](renderer.js#L2276) sends `` `m ${addr} ${len}` ``. Per B5 the count is then taken from the address token, so the panel's default `m 0x1000 64` requests **4096 words ≈ 130 KB** — guaranteed to blow the 2 s command timeout and desynchronize every subsequent command's output (see E4).

**Fix:** send `m${addr} ${len}` (no space), alongside the emulator-side fix in B5.

### D4 — MAJOR — The shared status-line regex matches a format that does not exist

[renderer.js:3827](renderer.js#L3827), and identically at [:1498](renderer.js#L1498) and [:3948](renderer.js#L3948):

```js
/\[inst:\s*(\d+)\s+pc:\s*(\d+),\s*src line\s*(\d+)\]/
```

This expects `[inst: 1 pc: 0, src line 4]`; the emulator prints `[inst:    1, pc:    0, src:    3]`. *Verified* null. So in the streamed-output path, PC tracking, instruction counting, current-line tracking and the statistics refresh are all dead. `performSingleStep`'s own copy at [:2371](renderer.js#L2371) uses the correct pattern — which is precisely why stepping works and nothing else does.

Related: the renderer keys several behaviors on a `Next:` line ([:3848](renderer.js#L3848), [:2421](renderer.js#L2421)). The emulator prints `Executed:`, never `Next:`.

**Fix:** one shared regex, and parse `Executed:`.

### D5 — MAJOR — Statistics are computed in JavaScript, not measured

- "Instructions Executed" increments in `updatePerformanceCounters` ([renderer.js:5049](renderer.js#L5049)), which is called on **every panel sync** — it counts UI refreshes. The emulator's true count sits unread in the banner.
- "Cycles" is `performanceCounters.cycles++` in `addToTrace` ([:4945](renderer.js#L4945)) — a duplicate of the instruction count, not a cycle model.
- `statBranches`, `statMemAccess`, `statArithmetic`, `statSyscalls` are incremented only by `analyzeInstructionType`, whose sole call site is inside the dead `Next:` branch. **They read 0 forever.** The syscall tile is doubly meaningless — the ISA has no `ecall`.

The core does maintain real numbers (`inst_cnt`, `mem_read_reqs`, `mem_write_reqs`) but only prints them at `hcf`, and nothing parses them.

### D6 — MAJOR — The call stack is fabricated, and probing for it can destroy the session

`refreshCallStackPanel` ([renderer.js:5326](renderer.js#L5326)) probes `info stack`, then `backtrace`, `bt`, `where`, `stack`. None exist, and because dispatch is first-character-only:

- `backtrace` / `bt` hit the **breakpoint** handler → `Invalid line number: acktrace`.
- **`stack` hits the step handler.** `stepcnt = parse_imm("tack") = 0`, `stepping = false`, `break` — so the debug loop exits with no step budget and **the program free-runs to completion**. *Verified.* Since `syncAllPanels` refreshes the call stack automatically, a routine panel sync can silently run the user's program to `hcf`.

What is actually displayed comes from `buildCallStackFromCurrentState` ([:5359](renderer.js#L5359)), which invents one frame from a label-name heuristic, fills the return-address column with the **stack-pointer value**, and appends a frame the source itself comments as a "hypothetical caller". Meanwhile `updateCallStackDisplayFromEntries` ([:5893](renderer.js#L5893)) is a no-op, so most of that computation is discarded anyway.

**Fix:** delete the probe list immediately — the `stack` entry is actively destructive. For a real call stack, add a backtrace command to the emulator or walk `sp`/`ra`.

### D7 — MAJOR — The symbol table is parsed from the editor with fabricated addresses

`refreshSymbolsPanel` ([renderer.js:5307](renderer.js#L5307)) never talks to the emulator. `parseAssemblySymbols` hardcodes `0x400000` for `.text` and `0x10000000` for `.data`; the real bases are 0 and 32768. **Every address in the panel is off by 0x400000**, and those fake addresses also feed the call stack's PC→function matching, which therefore never resolves. Symbols reflect the editor buffer, not the loaded program.

**Fix:** add a `sym` command dumping the emulator's existing `labels[]` table ([emulator.cpp:737](emulator.cpp#L737)).

### D8 — MAJOR — The memory format selector is read and discarded

[renderer.js:2129](renderer.js#L2129) reads `memFormat` into a `const` that is never referenced again. Hex, Decimal, Unsigned, Binary and Char all render identically, because `updateMemoryDisplay` hardcodes hex + ASCII and the emulator's `m` takes no format argument. The README advertises this as a feature.

### D9 — MAJOR — The current-instruction highlight never matches

[renderer.js:3051](renderer.js#L3051) compares an unpadded PC (`"4"`) against `dataset.address`, which holds the emulator's 8-digit `%08x` form (`"00000004"`). The current row is never highlighted and the auto-scroll never fires. Same defect at [:3700](renderer.js#L3700) and [:2620](renderer.js#L2620).

### D10 — MAJOR — SP auto-population produces a malformed address and persists it

[renderer.js:2265](renderer.js#L2265): `` `0x${(spValue - 64).toString(16)}` ``. With SP at 0 (which, per A2, is always at reset) this yields the literal string `"0x-40"`, which is then written into the address input and reused on every later sync. `strtol` parses it as 0.

### D11 — MAJOR — PC is not shown in the registers panel

`updateRegistersFromCurrentValues` loops 0–31 only ([renderer.js:4760](renderer.js#L4760)); the grid has no PC row despite `currentRegisterValues["pc"]` being tracked. PC appears only in the Statistics tab.

### D12 — MAJOR — The execution trace grows without bound and re-renders O(n²)

`addToTrace` ([renderer.js:4939](renderer.js#L4939)) pushes a full 32-register snapshot per entry under an explicit "Keep all entries - no limit" comment, and `updateTraceDisplay` rebuilds the entire table's `innerHTML` on every step. A few thousand steps is tens of megabytes and visibly janky. `entry.pc.toString(16)` also throws whenever PC is missing.

### Minor (panels)

- **Binary display silently truncates to 16 bits** ([renderer.js:1330](renderer.js#L1330): `num & 0xffff`) with no indication.
- **Disassembly regex mis-splits `add`** ([:3694](renderer.js#L3694)) — `a` and `d` are hex digits, so the opcode group swallows the mnemonic. Anchor to `([0-9a-fA-F]{8})`.
- **Elements referenced but absent from `index.html`:** `registers` (the real id is `registersGrid`, so `resetEmulatorState` never clears the panel), `statCacheHits`, `statCacheMisses`, `statBranchPredictions`, `statBranchMispredictions`.
- **Two competing highlight classes** — `current-line` and `current-pc` — and in `performSingleStep` the order is inverted, so the class is wiped immediately after being applied.
- **Source view injects unescaped file text** into `innerHTML` via `highlightRiscVAssembly` ([:3490-3532](renderer.js#L3490-L3532)).
- `memoryLen` is labelled "Number of bytes" but the emulator counts **words** — a 4× discrepancy independent of D3.
- Register highlight alternation is mis-ordered (`s[0-9]|s1[01]` matches `s1` before `s10`).
- **Dead code, zero call sites:** `highlightChangedRegisters`, `parseCurrentLineFromList`, `isExecutableLine`, `createPlaceholderDisassembly`, `parseMemoryOutput`, `disassembleMemoryData` — and with it the entire ~200-line JavaScript instruction decoder (`disassembleInstruction` and its nine helpers) — plus `updateSymbolsDisplay`, `addConditionalBreakpoint` (so conditional breakpoints never exist), `getCurrentPC`, `getCurrentInstruction` and its three helpers.

---

## E. Execution control, IPC, and lifecycle (`renderer.js`, `main.js`)

### E1 — CRITICAL — The Run button does not run anything

[index.html:102](index.html#L102) is `data-cmd="r"` with the title "Run program from beginning". No handler special-cases `r`, so it reaches `sendCommand("r")` — and the emulator's `r` is **register dump**. Nothing executes. `sendCommand` then compounds it by classifying `r` as an execution command ([renderer.js:1396](renderer.js#L1396)) and re-issuing it on a timer, so one click produces **three register dumps, zero instructions**, plus a full panel resync implying the program advanced. F5 is bound to the same button.

**Fix:** `data-cmd="c"`, or a real restart handler that stops and respawns; and drop `r` from the execution-command test.

### E2 — CRITICAL — Continue runs exactly 100 steps and stops silently

[index.html:98](index.html#L98) sends `s100`. The emulator has a genuine `c` that honors breakpoints and has no step budget. As shipped, Continue stops after 100 instructions with no indication that it was a budget rather than a breakpoint, makes any breakpoint past instruction 100 unreachable from that button, and floods the terminal with a register-diff line per step.

**Fix:** send `c`. If a bounded run is genuinely wanted, keep `s100` under a "Run 100 Steps" label and add a separate Continue.

### E3 — CRITICAL — Saving while the C view is active overwrites the assembly file

[renderer.js:1145-1156](renderer.js#L1145-L1156) reads `currentEditor.getValue()` — the *currently displayed* model — and writes it to `asmPath`, which is always the `.s` path. Switching to the C view, editing, and pressing Save writes C source into the `.s` file, destroying the assembly with **no warning and no backup**. The `.c` file is never saved at all.

**Fix:** save to the path matching the active view, or disable Save in C view.

### E4 — CRITICAL — Command timeouts report success and misattribute later output

[main.js:16](main.js#L16), [:41-43](main.js#L41-L43), [:53-83](main.js#L53-L83). Completion is detected by the buffer ending in `">> "`, with a 2 s inactivity fallback that resolves `{ok: true, timedOut: true}`. Two consequences:

1. **Timeout looks like success.** Every caller branches on `result.ok`, so a truncated or empty result is parsed as a genuine register dump, disassembly, or memory dump.
2. **Output is credited to the wrong command.** Finalizing pops the pending queue head, but the stream handler unconditionally appends later chunks to the new head. The abandoned command's output is prepended to the next command's buffer.

This is not theoretical for `c`: during a real continue the emulator emits nothing until a breakpoint, so any continue lasting over 2 s times out and its eventual banner is swallowed by the `r` that `syncAllPanels` issues next — corrupting the register panel.

**Fix:** return `ok: false` on timeout; make the timeout unbounded for `c`/`sN`; and mark the entry "draining" so orphaned output is discarded rather than credited.

### E5 — CRITICAL — Emulator output is rendered through `innerHTML`

[renderer.js:322-325](renderer.js#L322-L325) and [:384-386](renderer.js#L384-L386). Any line matching `name.ext:123` gets a `<span>` injected, which flips the whole line onto the raw `innerHTML` path — including the attacker-controlled remainder. A `.s` file containing `# foo.s:1 <img src=x onerror=…>`, echoed back by the `l` command, executes script in the renderer. The safe `escapeHtml` path exists two lines below and is bypassed. Aggravated by `webSecurity: false` ([main.js:197](main.js#L197)) and by a preload bridge that grants `readFile`/`saveFile`/`openPath` on arbitrary absolute paths with no validation. (`contextIsolation` and `nodeIntegration` are set correctly.)

### E6 — MAJOR — Breakpoints set while running never reach the emulator

`toggleBreakpoint` ([renderer.js:576-585](renderer.js#L576-L585)) — the only path from the gutter click and from the Set/Del buttons — updates a local `Set` and the Monaco glyph and nothing else. The sole transmitter is `syncBreakpoints()`, called only after compile-and-load and reload. A breakpoint added mid-session shows a red dot and **execution runs straight past it**.

The command syntax itself is fine; the emulator's `b`/`B` handlers work and match on `orig_line`, consistent with editor line numbers.

### E7 — MAJOR — The "Del" breakpoint button can create a breakpoint

[renderer.js:1951-1964](renderer.js#L1951-L1964) calls `toggleBreakpoint` and then unconditionally reports "Breakpoint removed". If no breakpoint exists at that line, it **adds** one. The emulator's removal command `B<line>` is never emitted anywhere in the codebase.

### E8 — MAJOR — Loading a file discards unsaved edits without prompting

`loadFile` ([renderer.js:1092](renderer.js#L1092)) never checks `editorDirty`. Reachable from the Open dialog, every workspace tree item, and every example. `loadFilePair` and `clearEditor` have the same gap.

### E9 — MAJOR — A stale emulator binary is reused forever

[main.js:234-248](main.js#L234-L248) runs `make` only when `obj/emulator` is **absent**, defeating the Makefile's own dependency tracking. Since the binary exists in the tree, the build step is effectively dead code and the UI reports "✅ Emulator built successfully" while running a binary of unknown vintage — so an edit to `emulator.cpp` silently does not take effect. Separately, the button says "Compile and Load" but compiles the C++ emulator, not the user's assembly.

*(Missing-compiler handling is correct: the spawn error is caught and surfaced actionably.)*

### E10 — MAJOR — Reload race nulls the newly spawned child

[main.js:428-454](main.js#L428-L454) stops with fixed sleeps and returns, while the `close` handler ([:376-385](main.js#L376-L385)) fires asynchronously with no identity check and sets the module-global `child = null`. If it lands after the new spawn, it orphans the fresh emulator — every later command returns "Not running" and the process leaks — and emits `[process exited]`, which the renderer reads as the *new* emulator dying.

**Fix:** capture the process in a local and guard `if (child === thisProc)`; await the actual `close` event.

### E11 — MAJOR — Zombie emulator when the window closes

`window-all-closed` is the only lifecycle hook, and there is no `before-quit`, no `window.on("closed")`, and no `child.kill()` outside `stop-emu`. On macOS, closing the window leaves both the app and the emulator alive, blocked on `fgets`; a second window then hits "Emulator already running" and the IDE is unusable until the process is killed by hand. The stream handlers also call `webContents.send` with no destroyed-window guard.

### E12 — MAJOR — Every command's output is delivered and parsed twice

`main.js` both streams each chunk via `emu-output` and accumulates it for the `send-cmd` reply; several call sites then write `result.output` to the terminal on top of the stream. Memory dumps appear twice. It is also double-*parsed* — `parseEmulatorOutputForTrace` runs on both channels — so instruction-type statistics double-count every step.

### E13 — MAJOR — Step Into is enabled with no emulator running

[renderer.js:214-224](renderer.js#L214-L224) gates `s` on `fileLoaded` rather than `emulatorRunning`, so clicking it before compile-and-load prints `❌ Step failed: Not running`. The Breakpoints group has the same mismatch.

### Minor (control/IPC)

- `">> "` is not a unique sentinel — the register-diff line also begins with it, so a pipe read splitting at the wrong byte terminates a command early.
- Typed commands are echoed twice (once before send, once after).
- `info program` is a no-op; the Status button switches tabs and never sends anything.
- The command queue cannot deadlock (the runner is fully wrapped), but a hung emulator produces an endless stream of fake-successful 2 s results rather than surfacing a stall.
- Windows path handling: `filePath.split("/")` breaks on backslashes, so the label shows a full path and the file mapping never matches.
- Filenames are injected into the file tree via `innerHTML`.
- The terminal DOM grows without bound; `clear()` is manual only.
- No `window.onerror` / `unhandledrejection` handlers; several floating promises fail silently.

*Negative finding, recorded deliberately:* `suppressTerminalOutput` and the compile/stop spinners **are** correctly restored in `finally` blocks on every path checked. No stuck-spinner bug exists.

---

## F. Documentation vs. reality (`README.md`)

| Claim | Verdict | Note |
|---|---|---|
| "Full implementation of RV32I" | **FALSE** | No `ecall`/`ebreak`/`fence`; `sltu` computes addition (A3). |
| "Cache Simulation: built-in cache performance modeling" | **FALSE** | Dead code; printed counters are structurally always 0 (C1). |
| "Memory Management: examination **and manipulation**" | **PARTIAL** | No write-memory command exists in the REPL or the UI. |
| "Memory Inspector: hex, decimal, binary, char" | **FALSE** | The format selector is read and discarded (D8). |
| "Disassembly Viewer" | **PARTIAL** | Capped at 2 instructions (B2); opcode column is filler (B3). |
| "Call Stack Tracking" | **FALSE** | Synthesized in JS, including a "hypothetical" frame (D6). |
| "Symbol Table: complete symbol and label information" | **PARTIAL** | Parsed from the editor; addresses off by 0x400000 (D7). |
| "Execution Statistics: instructions, cycles, branches, memory accesses" | **MOSTLY FALSE** | Instructions counts UI refreshes; cycles duplicates it; the rest are 0 (D5). |
| "Instruction Categorization" | **FALSE** | Always 0 — gated on a string never printed (D5). |
| "Breakpoint Management" | **PARTIAL** | UI breakpoints don't reach a running emulator (E6, E7). |
| "Run: execute program from the beginning" | **FALSE** | Sends the register-dump command (E1). |
| "Terminal Interface: full GDB-style command interface" | **PARTIAL** | Five commands are translated; `break`, `print`, `delete`, `x/`, `frame` all fail — some dangerously, since dispatch is first-character-only. |
| "xterm.js: terminal emulator" | **FALSE** | Never imported; the terminal is a hand-rolled `<div>`. The dependency is declared and packaged. |
| "linenoise.hpp: command-line interface library" | **FALSE** | Commented out in the source with a "corruption" note. |
| "Dual View Support" | **PARTIAL** | Only 4 hardcoded filenames; the tree lists `.s` only; C is display-only. |
| "Monaco Editor" | **PARTIAL** | Loaded from cdnjs, not the bundled dependency — the packaged app needs internet. |
| "MIT License — see the LICENSE file" | **FALSE** | No LICENSE file exists. |
| `npm run build:mac # macOS DMG` | **FALSE** | The script passes `--dir`, which suppresses DMG creation. |
| Setup instructions (`npm install`, `make`, `npm start`) | **TRUE** | Verified; the build succeeds (with 46 warnings). |
| Keyboard shortcuts | **UNDOCUMENTED** | Ctrl+1–5, F5, Shift+F5, F10, Esc all exist but appear nowhere in the README. |

---

## Fix plan

Ordered so that each phase makes the next one verifiable. The guiding principle: **restore truthfulness before adding capability** — several panels currently present invented data as measurement, which is worse for a teaching tool than showing nothing.

### Phase 0 — Make the examples run (highest value, ~1 day)

Nothing else can be validated while the shipped programs crash. All six are small, local changes in `emulator.cpp`.

| # | Fix | Ref |
|---|---|---|
| 0.1 | `parse_mem` → call `parse_reg` instead of `atoi(lpar+2)` | A1 |
| 0.2 | Initialize `rf[2]` to a defined stack top | A2 |
| 0.3 | Bounds-check `mem_read`/`mem_write`; fault with pc + source line | A4 |
| 0.4 | `sltu` → unsigned comparison | A3 |
| 0.5 | `imem` → `new instr[…]`; drop the partial init loop | A7 |
| 0.6 | `parse_reg` bound → `> 31` | A5 |

**Exit criterion:** all four `example_questions/*.s` run to `hcf` and produce correct output. Add them as a regression script — there is no test harness of any kind today, and that absence is why these went unnoticed.

### Phase 1 — Make the debugger protocol correct and self-describing

| # | Fix | Ref |
|---|---|---|
| 1.1 | Guard `fgets` against EOF; initialize `keybuf` | B1 |
| 1.2 | `sizeof(mem)` → `MEM_BYTES` in the disassembler | B2 |
| 1.3 | Fix `m` argument tokenization; clamp address and count | B5 |
| 1.4 | Reset `stepcnt` on debug-loop entry; reject `sN` where N ≤ 0 | B4, B6 |
| 1.5 | Strip `\r` as well as `\n` | B7 |
| 1.6 | Emit one canonical status line from a single helper on all three paths; add a `PROGRAM_EXIT: <reason>` sentinel with distinct exit codes | B minor |
| 1.7 | Error on unknown commands; add `h`/`help` | B minor |
| 1.8 | Bound instruction fetch to the text segment | A6 |

1.6 is the keystone: three of the renderer's parsers are dead purely because the formats drift, and a real completion sentinel removes the timeout guesswork in E4.

### Phase 2 — Repair the data pipeline into the panels

| # | Fix | Ref |
|---|---|---|
| 2.1 | Parse register values as hex; canonicalize `x0`–`x9` keys | D1, D2 |
| 2.2 | Send `m${addr} ${len}` | D3 |
| 2.3 | Adopt the Phase-1 canonical regex; parse `Executed:` not `Next:` | D4 |
| 2.4 | **Delete the `"stack"` probe** — it silently runs the program to completion | D6 |
| 2.5 | Zero-pad both sides of every PC/address comparison | D9 |
| 2.6 | Fix SP auto-population (`Math.max(0, …)`, align, skip when SP is 0) | D10 |
| 2.7 | Honor `memFormat`, or remove the selector | D8 |
| 2.8 | Add a PC row to the register grid | D11 |

2.4 is a one-line deletion and should go in immediately regardless of the rest of the phase — it is the only finding that can destroy a user's debugging session as a side effect of a routine refresh.

### Phase 3 — Fix the controls and stop the data-loss paths

| # | Fix | Ref |
|---|---|---|
| 3.1 | Save to the path matching the active view | E3 |
| 3.2 | Run button → `c` (or a real restart); drop `r` from the execution-command test | E1 |
| 3.3 | Continue → `c`; relabel `s100` if kept | E2 |
| 3.4 | Send `b`/`B` on every breakpoint toggle; make Del actually delete | E6, E7 |
| 3.5 | `ok: false` on timeout; unbounded timeout for `c`/`sN`; discard orphaned output | E4 |
| 3.6 | Escape before injecting markup; remove `webSecurity: false`; constrain the file bridge to the workspace | E5 |
| 3.7 | Identity-guard the `close` handler; add `before-quit` kill; guard `webContents.send` | E10, E11 |
| 3.8 | Prompt on unsaved edits before load/clear | E8 |
| 3.9 | Always run `make`; relabel the button | E9 |
| 3.10 | Gate Step Into on `emulatorRunning` | E13 |
| 3.11 | Pick one output channel — stream or reply, not both | E12 |

### Phase 4 — Replace fabricated data with measured data (or remove it)

Each of these is a genuine decision, not a bug fix. The data mostly already exists in the core and needs a command to expose it.

- **Statistics:** add a `stats` command dumping `inst_cnt`, `mem_read_reqs`, `mem_write_reqs`, and per-category counters (which need adding to the execute loop). Until then, hide the four permanently-zero tiles rather than displaying them.
- **Symbols:** add a `sym` command dumping the existing `labels[]` table; delete the editor-parsing path and its hardcoded bases.
- **Call stack:** either implement a real backtrace in the emulator or remove the panel. The current synthetic version is actively misleading — it puts the stack pointer in the return-address column.
- **Cache simulator:** implement allocate-on-miss, LRU and writeback and route loads/stores through it, or delete the module. Either way, stop printing counters that cannot be nonzero, and fix the macro override so the documented configuration knobs work (C2).
- **Disassembly opcodes:** emit real encodings or drop the column (B3).

### Phase 5 — Completeness and hygiene

- Instruction set: mask shift amounts (A8), fix `jalr` (A9), error on unknown mnemonics (A10), add the missing directives and exact directive matching (A11), per-section cursors (A12), zero data memory (A13), `lui` range (A14), `parse_imm` validation (A15), branch/jump range checks (A16).
- Add `ecall`/`ebreak` with a small syscall set (print int/string, read, exit) — the statistics panel already has a tile for syscalls that can never fire, and no program can do I/O today.
- Replace `sprintf` with `snprintf` throughout (A minor); the 256-byte buffer is reachable from file contents.
- Cap the execution trace and append rows instead of re-rendering (D12); cap the terminal DOM.
- Delete the ~200-line dead JavaScript disassembler and the other zero-call-site functions listed in D minor.
- Correct the README claim by claim per section F; add a LICENSE file; fix `build:mac` to drop `--dir`; document the existing keyboard shortcuts; either bundle Monaco and xterm.js or stop listing them as key technologies.

### Suggested sequencing

Phases 0 and 1 are prerequisites for trusting anything else and together are roughly two to three days of work. Phase 2 is small and mechanical once Phase 1 fixes the formats. Phase 3 is the largest engineering block. Phase 4 is where scope decisions live and should be sized separately.

Two items are worth pulling forward out of order because they are one-liners with outsized consequences: **2.4** (the `stack` probe that runs the program to completion) and **3.1** (saving C source over the `.s` file, which destroys user work irrecoverably).
