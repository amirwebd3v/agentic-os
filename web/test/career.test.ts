import { createPinia, setActivePinia } from 'pinia';
import { afterEach, expect, test, vi } from 'vitest';
import { FAIL_TEXT, POLL_MS, useCareerStore } from '../src/stores/career';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const detail = (status: string, step: string | null, fail_code: string | null = null) => ({ id: 1, status, step, fail_code });

test('polls while a step runs, stops on any other state, and says why it failed', async () => {
  vi.useFakeTimers();
  const states = [detail('processing', 'intake'), detail('processing', 'match'), detail('failed', 'match', 'internal')];
  const fetch = vi.fn(async () => Response.json(states.shift()));
  vi.stubGlobal('fetch', fetch);
  setActivePinia(createPinia());
  const store = useCareerStore();

  await store.open(1);
  expect(store.current?.step).toBe('intake');
  await vi.advanceTimersByTimeAsync(POLL_MS);
  expect(store.current?.step).toBe('match');
  await vi.advanceTimersByTimeAsync(POLL_MS);
  expect(store.current?.status).toBe('failed');
  expect(store.failure).toBe(FAIL_TEXT.internal);
  await vi.advanceTimersByTimeAsync(POLL_MS * 3);
  expect(fetch).toHaveBeenCalledTimes(3);
});

test('a final application polls while it renders, then stops', async () => {
  vi.useFakeTimers();
  const states = [detail('final', 'render'), detail('final', null)];
  const fetch = vi.fn(async () => Response.json(states.shift()));
  vi.stubGlobal('fetch', fetch);
  setActivePinia(createPinia());
  const store = useCareerStore();
  await store.open(1);
  await vi.advanceTimersByTimeAsync(POLL_MS * 3);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(store.failure).toBeNull();
});
