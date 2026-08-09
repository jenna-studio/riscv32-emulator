#!/bin/sh
# Regression check: every example must assemble, run to completion without a
# fault, and (where the program uses the 0x10000 answer marker) report success.
#
#   ./run_examples.sh            run all examples
#   ./run_examples.sh sort       run one
#
# Exit status is non-zero if any example fails, so this is safe to use in CI.

set -u

EMU=obj/emulator
DIR=examples
TIMEOUT=60

# Programs that write their verdict to the 0x10000 marker word (0 == correct),
# paired with the source line of the hcf where the verdict is final.
marker_line() {
    case "$1" in
        reduction) echo 29 ;;
        sort)      echo 17 ;;
        sudoku)    echo 43 ;;
        *)         echo "" ;;
    esac
}

if [ ! -x "$EMU" ]; then
    echo "Building $EMU..."
    make || exit 1
fi

if [ $# -gt 0 ]; then
    PROGRAMS="$*"
else
    PROGRAMS="reduction sort graph sudoku"
fi

failures=0

# Instruction-semantics check. tests/isa_smoke.s exercises the cases the example
# programs do not: unsigned vs signed compares, shift-amount masking, logical vs
# arithmetic right shift, x0 staying zero, and load sign/zero extension.
run_isa_smoke() {
    src=tests/isa_smoke.s
    [ -f "$src" ] || return 0

    dump=$(printf 'c\n' | timeout "$TIMEOUT" "$EMU" "$src" 2>&1 \
        | grep -oE 'x[0-9]{2}: [0-9a-f]{8}' | tr -d ' ')

    bad=0
    for want in x07:00000001 x28:00000000 x30:00000000 x31:00000001 \
                x12:00000002 x14:7ffffff8 x15:fffffff8 x00:00000000 \
                x17:ffffffff x18:000000ff; do
        if ! printf '%s\n' "$dump" | grep -qx "$want"; then
            got=$(printf '%s\n' "$dump" | grep "^${want%%:*}:" | tail -1)
            echo "FAIL isa_smoke: expected $want, got ${got:-nothing}"
            bad=$((bad + 1))
        fi
    done

    if [ $bad -eq 0 ]; then
        echo "PASS isa_smoke: instruction semantics correct"
    fi
    failures=$((failures + bad))
}

run_isa_smoke

for name in $PROGRAMS; do
    src="$DIR/$name.s"
    if [ ! -f "$src" ]; then
        echo "FAIL $name: $src not found"
        failures=$((failures + 1))
        continue
    fi

    out=$(printf 'c\n' | timeout "$TIMEOUT" "$EMU" "$src" 2>&1)
    status=$?

    if [ $status -eq 124 ]; then
        echo "FAIL $name: timed out after ${TIMEOUT}s"
        failures=$((failures + 1))
        continue
    fi

    if [ $status -ne 0 ]; then
        echo "FAIL $name: emulator exited with status $status"
        failures=$((failures + 1))
        continue
    fi

    # The ">> " prompt carries no newline, so it can prefix the line that follows it.
    reason=$(printf '%s\n' "$out" | sed -n 's/.*PROGRAM_EXIT: //p' | tail -1)
    if [ "$reason" != "halted" ]; then
        echo "FAIL $name: expected a clean halt, got '${reason:-no PROGRAM_EXIT line}'"
        printf '%s\n' "$out" | grep -E 'FAULT:' | head -3
        failures=$((failures + 1))
        continue
    fi

    retired=$(printf "%s\n" "$out" | sed -n "s/.*Instructions retired: //p" | tail -1)

    line=$(marker_line "$name")
    if [ -n "$line" ]; then
        marker=$(printf 'b%s\nc\nm0x10000 1\nq\n' "$line" \
            | timeout "$TIMEOUT" "$EMU" "$src" 2>&1 \
            | sed -n 's/.*0x10000: //p' | tail -1)
        case "$marker" in
            "00 00 00 00"*)
                echo "PASS $name: correct answer, ${retired} instructions retired" ;;
            "")
                echo "FAIL $name: could not read the answer marker at 0x10000"
                failures=$((failures + 1)) ;;
            *)
                echo "FAIL $name: answer marker at 0x10000 is '$marker', expected zero"
                failures=$((failures + 1)) ;;
        esac
    else
        echo "PASS $name: halted cleanly, ${retired} instructions retired (no answer marker)"
    fi
done

echo
if [ $failures -eq 0 ]; then
    echo "All checks passed."
else
    echo "$failures check(s) failed."
fi
exit $failures
