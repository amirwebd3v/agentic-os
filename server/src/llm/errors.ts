import { APIUserAbortError } from '@anthropic-ai/sdk';

export type LlmErrorKind = 'auth' | 'rate_limit' | 'overloaded' | 'bad_request' | 'network' | 'aborted';

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number | undefined;

  constructor(kind: LlmErrorKind, message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = status;
  }
}

const kindOf = (status: number | undefined): LlmErrorKind => {
  if (status === undefined) return 'network';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'overloaded'; // 529 overloaded, plus other upstream 5xx: all transient
  return 'bad_request';
};

/**
 * Maps SDK errors (or anything with a numeric `status`) to a typed LlmError. No status means a network failure.
 * Without a status the error is local (connection, or parsing truncated model output), and its message may quote
 * model text, i.e. personal data. So only its type name is kept, and no `cause`, because the message flows into
 * `llm_calls.error`, the job's error and the log.
 */
export function mapError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof APIUserAbortError) {
    return new LlmError('aborted', 'request aborted', undefined, { cause: err });
  }
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') {
    return new LlmError('network', `${err instanceof Error ? err.name : 'error'} (no response from provider)`);
  }
  const message = err instanceof Error ? err.message.slice(0, 300) : `provider error ${status}`;
  return new LlmError(kindOf(status), message, status, { cause: err });
}
