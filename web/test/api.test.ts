import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, decideApproval, getProvider, needsLogin } from '../src/api';

afterEach(() => vi.unstubAllGlobals());

test('requests send the cookie, the X-AOS header and a JSON body', async () => {
  const fetch = vi.fn(async () => Response.json({ id: 3, status: 'approved' }));
  vi.stubGlobal('fetch', fetch);
  expect(await decideApproval(3, 'approve')).toEqual({ id: 3, status: 'approved' });
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/api/approvals/3/decide');
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"decision":"approve"}' });
  expect(init.headers).toMatchObject({ 'X-AOS': '1', 'Content-Type': 'application/json' });
});

test('a 409 throws ApiError with the server text, and a 401 flags the login prompt', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ error: 'provider_not_configured' }, { status: 409 }));
  await expect(getProvider()).rejects.toBeInstanceOf(ApiError);
  await expect(getProvider()).rejects.toMatchObject({ status: 409, detail: 'provider_not_configured' });
  vi.stubGlobal('fetch', async () => Response.json({ error: 'not logged in' }, { status: 401 }));
  await expect(getProvider()).rejects.toMatchObject({ status: 401 });
  expect(needsLogin.value).toBe(true);
});
