#include <cstdint>
#include <cstdint>

#ifndef CACHESIM_H__
#define CACHESIM_H__

// Change these to configure the cache.
// Values are logarithmic, so CACHE_WAYS_SZ of 0 results in 1 way!
#define CACHE_SETS_SZ 8
#define CACHE_WAYS_SZ 0
#define CACHE_LINE_WORD_SZ 0

//extern uint32_t g_cache[CACHE_SETS][CACHE_WAYS][CACHE_LINE_WORD];
//extern uint32_t g_tags[CACHE_SETS][CACHE_WAYS];

/// DO NOT EDIT
#define CACHE_SETS (1<<CACHE_SETS_SZ)
#define CACHE_WAYS (1<<CACHE_WAYS_SZ)
#define CACHE_LINE_WORD (1<<CACHE_LINE_WORD_SZ)


// Stats
extern uint32_t mem_read_reqs;
extern uint32_t mem_write_reqs;
extern uint32_t cache_read_hits;
extern uint32_t cache_write_hits;
extern uint32_t mem_flush_words;


// Functions
void cache_init();
uint32_t mem_read(uint8_t* mem, uint32_t addr, uint32_t size);
void mem_write(uint8_t* mem, uint32_t addr, uint32_t data, uint32_t size);

#endif
