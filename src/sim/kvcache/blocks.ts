/**
 * Paged KV cache: memory is handed out in fixed-size blocks, as an operating system hands out pages.
 *
 * Source: Kwon et al., SOSP 2023 (PagedAttention), section 4.1. A sequence's KV cache is stored in
 * non-contiguous blocks of `B` tokens each and a block is allocated only when the previous one is
 * full, so the memory wasted per sequence is bounded by one block.
 *
 * Example: a 3,000-token context needs ceil(3000 / 16) = 188 blocks; the last block holds 8 tokens
 * and wastes room for 8.
 */

/** Tokens per KV block. 16 is vLLM's long-standing default `block_size` on CUDA. */
export const BLOCK_TOKENS = 16;

/** Blocks needed to hold `tokens` tokens of context. */
export const blocksFor = (tokens: number, blockTokens: number = BLOCK_TOKENS): number => Math.ceil(tokens / blockTokens);
