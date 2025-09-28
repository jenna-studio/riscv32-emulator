#include "cachesim.h"
#include <stdio.h>
#include <stdint.h>

// Cache configuration
#define CACHE_SETS_SZ 8 // 2^8 = 256 sets
#define CACHE_WAYS_SZ 3 // 2^3 = 8 ways
#define CACHE_LINE_WORD_SZ 4 // 2^4 = 16 words per cache line (64 bytes)

#define CACHE_SETS (1 << CACHE_SETS_SZ)
#define CACHE_WAYS (1 << CACHE_WAYS_SZ)
#define CACHE_LINE_WORD (1 << CACHE_LINE_WORD_SZ)

// Cache data storage
uint32_t g_cache[CACHE_SETS][CACHE_WAYS][CACHE_LINE_WORD] = {0};
uint32_t g_tags[CACHE_SETS][CACHE_WAYS] = {0};
uint8_t g_flags[CACHE_SETS][CACHE_WAYS] = {0}; // Bit 0: Valid, Bit 1: Dirty

// Cache statistics
uint32_t g_cache_hits = 0;
uint32_t g_cache_misses = 0;
uint32_t g_cache_accesses = 0;

// External variables for emulator compatibility
uint32_t mem_read_reqs = 0;
uint32_t mem_write_reqs = 0;
uint32_t cache_read_hits = 0;
uint32_t cache_write_hits = 0;
uint32_t mem_flush_words = 0;

// Function to calculate cache set index
uint32_t cache_calc_idx(uint32_t addr) {
    return ((addr>>(CACHE_LINE_WORD_SZ+2)) & ((1<<CACHE_SETS_SZ)-1));
}

// Function to calculate cache tag
uint32_t cache_calc_tag(uint32_t addr) {
    return (addr >> (CACHE_SETS_SZ+CACHE_LINE_WORD_SZ+2));
}

// Function to calculate word index within a cache line
uint32_t cache_calc_word_idx(uint32_t addr) {
    return ((addr>>2)&((1<<CACHE_LINE_WORD_SZ)-1));
}

// Function to initialize the cache
void cache_init() {
    for (int i = 0; i < CACHE_SETS; ++i) {
        for (int j = 0; j < CACHE_WAYS; ++j) {
            g_flags[i][j] = 0; // Mark all cache lines as invalid
            g_tags[i][j] = 0;
            for (int k = 0; k < CACHE_LINE_WORD; ++k) {
                g_cache[i][j][k] = 0;
            }
        }
    }
    g_cache_hits = 0;
    g_cache_misses = 0;
    g_cache_accesses = 0;
}

// Function to read from cache
uint32_t cache_read(uint32_t addr) {
    g_cache_accesses++;
    uint32_t set_idx = cache_calc_idx(addr);
    uint32_t tag = cache_calc_tag(addr);
    uint32_t word_idx = cache_calc_word_idx(addr);

    for (int i = 0; i < CACHE_WAYS; ++i) {
        if ((g_flags[set_idx][i] & 0x1) && (g_tags[set_idx][i] == tag)) {
            g_cache_hits++;
            return g_cache[set_idx][i][word_idx]; // Cache hit
        }
    }

    g_cache_misses++;
    // Cache miss: In a real cache, we would fetch the block from main memory
    // For this simulation, we'll just return 0 and not update the cache.
    // A more complete simulation would implement a replacement policy (e.g., LRU).
    return 0; 
}

// Function to write to cache
void cache_write(uint32_t addr, uint32_t data) {
    g_cache_accesses++;
    uint32_t set_idx = cache_calc_idx(addr);
    uint32_t tag = cache_calc_tag(addr);
    uint32_t word_idx = cache_calc_word_idx(addr);

    for (int i = 0; i < CACHE_WAYS; ++i) {
        if ((g_flags[set_idx][i] & 0x1) && (g_tags[set_idx][i] == tag)) {
            g_cache_hits++;
            g_cache[set_idx][i][word_idx] = data;
            g_flags[set_idx][i] |= 0x2; // Mark as dirty
            return; // Cache hit
        }
    }

    g_cache_misses++;
    // Cache miss: In a real cache, we would fetch the block, update it,
    // and potentially write back a dirty block.
    // For this simulation, we'll just ignore the write for a miss.
    // A more complete simulation would implement a replacement policy.
}

// Function to print cache statistics
void cache_print_stats() {
    printf("Cache Statistics:\n");
    printf("  Total Accesses: %u\n", g_cache_accesses);
    printf("  Hits: %u\n", g_cache_hits);
    printf("  Misses: %u\n", g_cache_misses);
    if (g_cache_accesses > 0) {
        printf("  Hit Rate: %.2f%%\n", (double)g_cache_hits / g_cache_accesses * 100.0);
        printf("  Miss Rate: %.2f%%\n", (double)g_cache_misses / g_cache_accesses * 100.0);
    }
}

// Memory interface functions for emulator compatibility
uint32_t mem_read(uint8_t* mem, uint32_t addr, uint32_t size) {
    mem_read_reqs++;

    // Simple memory read implementation
    uint32_t value = 0;

    switch(size) {
        case 1: // byte
            value = mem[addr];
            break;
        case 2: // half word
            value = *(uint16_t*)(mem + addr);
            break;
        case 4: // word
            value = *(uint32_t*)(mem + addr);
            break;
        default:
            printf("Invalid memory read size: %u\n", size);
            break;
    }

    return value;
}

void mem_write(uint8_t* mem, uint32_t addr, uint32_t data, uint32_t size) {
    mem_write_reqs++;

    switch(size) {
        case 1: // byte
            mem[addr] = (uint8_t)data;
            break;
        case 2: // half word
            *(uint16_t*)(mem + addr) = (uint16_t)data;
            break;
        case 4: // word
            *(uint32_t*)(mem + addr) = data;
            break;
        default:
            printf("Invalid memory write size: %u\n", size);
            break;
    }
}
