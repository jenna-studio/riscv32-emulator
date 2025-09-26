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

/* "solve" — to be implemented by the user.
   Assembly calls: a0 = pointer to current 16-byte input block, a1 = 0 (unused).
   Expected behavior: mutate the 16-byte block in-place so that it matches the
   corresponding row in 'answers'. The provided assembly stub was a no-op. */
static void solve(int8_t *block, int unused_arg_zero) {
    (void)unused_arg_zero;
    /* TODO: implement your transformation here.
       The benchmark’s assembly stub does nothing. */
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