// The only code that talks to Gmail with a token (plan-review M6): four GET calls and nothing else.
// test/mail-oauth.test.ts fails if this file gains a call that sends or modifies. The scope is read-only as well, but
// that alone isn't trusted.
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** `auth`: reconnect needed. `not_found`: gone, or a history cursor too old. `rate`, `server`, `network`: try later. */
export class GmailError extends Error {
  constructor(
    readonly kind: 'auth' | 'not_found' | 'rate' | 'server' | 'network' | 'bad_request',
    readonly reason?: string,
  ) {
    super(`gmail ${kind}`); // fixed text: never a Gmail response or mail content
    this.name = 'GmailError';
  }
}

export interface GmailHeader { name: string; value: string }
export interface GmailPart { mimeType?: string; headers?: GmailHeader[]; body?: { data?: string }; parts?: GmailPart[] }
export interface GmailMessage { id: string; labelIds?: string[]; internalDate?: string; payload?: GmailPart }
export interface GmailHistory { history?: { messagesAdded?: { message: { id: string } }[]; messagesDeleted?: { message: { id: string } }[]; labelsAdded?: { message: { id: string }; labelIds?: string[] }[]; labelsRemoved?: { message: { id: string }; labelIds?: string[] }[] }[]; historyId?: string; nextPageToken?: string }

export function createGmail(getAccessToken: () => Promise<string>, base = BASE) {
  async function get<T>(path: string, params: Record<string, string | string[] | undefined> = {}): Promise<T> {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) for (const one of v === undefined ? [] : [v].flat()) query.append(k, one);
    const url = `${base}${path}${query.size ? `?${query}` : ''}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { authorization: `Bearer ${await getAccessToken()}` }, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      if (err instanceof GmailError) throw err;
      throw new GmailError('network');
    }
    if (res.ok) return (await res.json()) as T;
    const body = (await res.json().catch(() => null)) as { error?: { errors?: { reason?: string }[] } } | null;
    const reason = body?.error?.errors?.[0]?.reason;
    if (res.status === 401) throw new GmailError('auth', reason);
    if (res.status === 404) throw new GmailError('not_found', reason);
    if (res.status === 429 || (res.status === 403 && /rate|quota|limit/i.test(reason ?? ''))) throw new GmailError('rate', reason);
    if (res.status >= 500) throw new GmailError('server', reason);
    throw new GmailError('bad_request', reason);
  }

  return {
    getProfile: () => get<{ emailAddress: string; historyId: string }>('/profile'),
    listMessages: (q: string, pageToken?: string) => get<{ messages?: { id: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>('/messages', { q, pageToken, maxResults: '100' }),
    listHistory: (startHistoryId: string, pageToken?: string) => get<GmailHistory>('/history', { startHistoryId, pageToken }),
    getMessage: (id: string) => get<GmailMessage>(`/messages/${encodeURIComponent(id)}`, { format: 'full' }),
    /** Labels and a few headers, no body: enough to file a known Personal or Noise sender without reading the mail. */
    getMessageHeaders: (id: string) => get<GmailMessage>(`/messages/${encodeURIComponent(id)}`, { format: 'metadata', metadataHeaders: ['From', 'Message-ID', 'List-Unsubscribe', 'List-Id'] }),
  };
}
export type Gmail = ReturnType<typeof createGmail>;
