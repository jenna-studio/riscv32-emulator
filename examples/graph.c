#include <stdint.h>
#include <stdbool.h>

#define N 64
#define INF 1024
#define MMIO_ADDR ((volatile uint32_t *)0x10000)

/* Globals mirroring the assembly .bss/.data */
static int32_t adjacency[N * N];   /* 64x64 adjacency matrix of weights (0 or 1) */
static int32_t dist[N];            /* distance array */
static uint8_t active[N];          /* current frontier */
static uint8_t new_active[N];      /* next frontier */
static volatile uint32_t *output = (volatile uint32_t *)65536; /* same as 0x10000 */

/* Edge list (128 undirected edges), as pairs (u, v) */
static const uint32_t edges[][2] = {
    {0,29},{0,52},
    {1,50},{1,13},{1,45},{1,15},
    {2,4},{2,61},
    {3,50},{3,14},
    {4,14},{4,38},{4,63},{4,53},
    {5,48},{5,21},{5,46},{5,62},
    {6,54},{6,8},{6,51},{6,38},{6,26},{6,57},{6,33},
    {7,30},{7,20},
    {8,27},{8,15},
    {9,18},{9,54},{9,31},{9,59},{9,58},{9,20},{9,10},
    {10,35},{10,34},{10,29},{10,63},{10,54},
    {11,30},{11,59},
    {12,40},{12,30},
    {13,37},
    {14,44},{14,37},{14,52},
    {15,21},{15,40},
    {16,49},{16,17},{16,36},
    {17,47},{17,60},{17,33},{17,21},{17,52},{17,35},
    {18,34},{18,20},{18,44},
    {19,40},{19,34},{19,27},{19,61},
    {20,49},{20,21},{20,39},{20,22},
    {21,27},{21,36},{21,29},{21,47},
    {22,49},{22,60},{22,57},{22,51},{22,38},{22,43},{22,45},
    {23,59},{23,61},
    {24,28},{24,54},{24,41},{24,53},
    {25,62},{25,56},
    {26,28},{26,45},
    {28,35},{28,38},{28,46},{28,31},
    {29,45},{29,37},{29,32},
    {30,47},{30,55},
    {31,55},
    {34,52},{34,58},
    {36,43},
    {38,51},{38,44},{38,45},
    {40,59},
    {41,47},
    {42,54},{42,43},{42,61},
    {43,44},{43,48},{43,45},
    {44,56},
    {45,49},
    {46,47},
    {48,56},{48,62},
    {49,61},
    {50,56},
    {52,53},
    {54,55},
    {57,61},{57,58},
    {60,61}
};

static inline void fill_adjacency_matrix(void) {
    /* zero adjacency */
    for (int i = 0; i < N * N; ++i) {
        adjacency[i] = 0;
    }
    /* add undirected edges with weight 1 */
    for (int i = 0; i <= 127; ++i) {
        uint32_t u = edges[i][0];
        uint32_t v = edges[i][1];
        adjacency[u * N + v] = 1;
        adjacency[v * N + u] = 1;
    }
}

static inline int any_active(void) {
    for (int i = 0; i <= 63; ++i) {
        if (active[i] != 0) return 1;
    }
    return 0;
}

/* Single-source shortest path on an unweighted graph using frontier relaxation */
static void calc_dist(int start) {
    /* mark start as active */
    active[start] = 1;

    /* initialize dist[] to INF, except dist[start] = 0 */
    for (int i = 0; i <= 63; ++i) dist[i] = INF;
    dist[start] = 0;

    /* iterative relaxation until no active vertices remain */
    while (any_active()) {
        /* clear next frontier */
        for (int i = 0; i <= 63; ++i) new_active[i] = 0;

        /* for every active u, relax all neighbors v */
        for (int u = 0; u <= 63; ++u) {
            if (!active[u]) continue;
            for (int v = 0; v <= 63; ++v) {
                int w = adjacency[u * N + v];
                if (w == 0) continue;
                int cand = dist[u] + w;
                if (cand < dist[v]) {
                    dist[v] = cand;
                    new_active[v] = 1;
                }
            }
        }

        /* swap new_active -> active */
        for (int i = 0; i <= 63; ++i) active[i] = new_active[i];
    }

    /* write out dist[i] to the fixed MMIO address (as in the assembly).
       Note: the assembly always writes to the same address without increment. */
    for (int i = 0; i <= 63; ++i) {
        *output = (uint32_t)dist[i];
    }
}

int main(void) {
    /* Prologue in assembly adjusts stack and calls these functions */
    fill_adjacency_matrix();
    calc_dist(58);

    /* hcf: halt; spin forever */
    for (;;)
        ;
}