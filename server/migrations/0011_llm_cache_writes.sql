-- Cache writes cost more than plain input, and `input_tokens` doesn't include them (#96).
ALTER TABLE llm_calls ADD COLUMN cache_write_tokens INTEGER;
