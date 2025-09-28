#include <stdint.h>
#include <stdbool.h>

// Memory-mapped I/O address used by the harness
#define MMIO_ADDR ((volatile uint32_t *)0x10000)

// Globals corresponding to the .data section
int32_t inputcnt = 16;

int8_t inputs[16] = {
    -1,  4,  3,  1,
     1,  3, -4,  2,
    -4,  2,  1,  3,
     3,  1, -2,  4
};

int8_t masks[16] = {
    1, 1, 0, 1,
    0, 0, 1, 0,
    1, 0, 0, 0,
    1, 1, 1, 1
};

int32_t answer    = 2;
int32_t submitted = 0;

// submit(a0): store result to 'submitted'
static inline void submit(int32_t value) {
    submitted = value;
}

// solve(a0=inputcnt, a1=&inputs[0], a2=&masks[0])
void solve(int32_t n, const int8_t *in, const int8_t *mask) {
    int32_t sum = 0;
    for (int32_t i = 0; i < n; ++i) {
        if (mask[i]) {
            sum += in[i];  // sign-extended byte add
        }
    }
    submit(sum);
}

int main(void) {
    // In the assembly, SP is set to 0x10000, then solve is called.
    // Here we just call solve with the prepared globals.
    solve(inputcnt, inputs, masks);

    // Compare 'answer' vs 'submitted' and write result to MMIO:
    // 0 => correct, 1 => wrong (matches correct_answer/wrong_answer blocks)
    if (answer == submitted) {
        *MMIO_ADDR = 0;
    } else {
        *MMIO_ADDR = 1;
    }

    // hcf: halt-and-catch-fire; emulate by stopping here.
    for (;;)
        ;

    return 0;
}