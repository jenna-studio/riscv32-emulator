#include <stdint.h>

#define MMIO_ADDR ((volatile uint32_t *)0x10000)

/* .data */
static const int32_t inputcnt = 3;

static int8_t inputs[3][16] = {
    {0, 4, 3, 0, 0, 0, 4, 2, 0, 2, 0, 0, 3, 0, 0, 0},
    {0, 0, 3, 0, 0, 4, 0, 2, 0, 0, 2, 0, 0, 2, 0, 3},
    {0, 3, 0, 4, 0, 0, 2, 0, 4, 0, 3, 0, 0, 0, 0, 2}
};

static const int8_t answers[3][16] = {
    {2, 4, 3, 1, 1, 3, 4, 2, 4, 2, 1, 3, 3, 1, 2, 4},
    {2, 1, 3, 4, 3, 4, 1, 2, 4, 3, 2, 1, 1, 2, 4, 3},
    {2, 3, 1, 4, 1, 4, 2, 3, 4, 2, 3, 1, 3, 1, 4, 2}
};

/* solve(a0 = pointer to the current 16-byte block, a1 = 0, unused)

   Constraint propagation on a 4x4 grid stored row-major: for every empty cell,
   start from the candidate set {1,2,3,4} (bits 1..4, i.e. 0b11110), clear every
   value already present in the cell's row and column, and fill the cell when
   exactly one candidate remains. Repeat the sweep until a pass fills nothing. */
static void solve(int8_t *block, int unused_arg_zero) {
    (void)unused_arg_zero;

    int filled_any;
    do {
        filled_any = 0;

        for (int cell = 0; cell < 16; ++cell) {
            if (block[cell] != 0) continue;

            uint32_t candidates = 0x1E; /* bits for values 1..4 */

            /* Values already used in this cell's row */
            int row_start = cell & ~3;
            for (int k = 0; k < 4; ++k) {
                uint8_t value = (uint8_t)block[row_start + k];
                if (value != 0) candidates &= ~(1u << value);
            }

            /* Values already used in this cell's column */
            int column = cell & 3;
            for (int k = 0; k < 4; ++k) {
                uint8_t value = (uint8_t)block[(k << 2) + column];
                if (value != 0) candidates &= ~(1u << value);
            }

            /* More than one bit left means the cell is still ambiguous */
            if ((candidates & (candidates - 1)) != 0) continue;

            /* No candidate at all is a contradiction; unreachable for these
               puzzles, and the assembly spins forever if it ever happens. */
            if (candidates == 0) continue;

            int value = 0;
            while (candidates != 1) {
                candidates >>= 1;
                value++;
            }

            block[cell] = (int8_t)value;
            filled_any = 1;
        }
    } while (filled_any);
}

int main(void) {
    /* For each input block, call solve(a0 = &inputs[i][0], a1 = 0). */
    for (int i = 0; i < inputcnt; ++i) {
        solve(&inputs[i][0], 0);
    }

    /* After solve calls, compare each 16-byte block to the corresponding answers row.
       Count how many positions differ and write that count to MMIO (0x10000) once per row. */
    for (int i = 0; i < inputcnt; ++i) {
        int diff_count = 0;
        for (int j = 0; j < 16; ++j) {
            if (inputs[i][j] != answers[i][j]) {
                diff_count += 1;
            }
        }
        *MMIO_ADDR = (uint32_t)diff_count;
    }

    /* hcf: halt */
    for (;;)
        ;
}