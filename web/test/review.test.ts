import { createApp } from 'vue';
import { expect, test, vi } from 'vitest';
import type { Approval } from '../src/api';
import ApprovalCard from '../src/components/ApprovalCard.vue';
import { lineDiff } from '../src/diff';

test('lineDiff keeps common lines and marks the rest', () => {
  expect(lineDiff('a\nb\nc', 'a\nx\nc\nd')).toEqual([
    { op: ' ', text: 'a' },
    { op: '+', text: 'x' },
    { op: '-', text: 'b' },
    { op: ' ', text: 'c' },
    { op: '+', text: 'd' },
  ]);
  expect(lineDiff('same', 'same')).toEqual([{ op: ' ', text: 'same' }]);
});

const mount = (approval: Approval, onDecide = vi.fn()) => {
  const el = document.createElement('div');
  createApp(ApprovalCard, { approval, busy: false, onDecide }).mount(el);
  return el;
};
const base = { id: 1, proposed_by: 'app', created_at: '2026-10-26T00:00:00Z', original_text: null };

test('payload text renders as text, never as HTML', () => {
  const evil = '<img src=x onerror="alert(1)">';
  const conflict = mount({ ...base, action_type: 'vault_conflict', payload: { path: evil, current_hash: null, content: evil }, current_text: evil });
  // A type this UI doesn't know yet falls back to raw JSON, also as text.
  const unknown = mount({ ...base, action_type: evil, payload: { note: evil } } as unknown as Approval);
  for (const e of [conflict, unknown]) {
    expect(e.querySelector('img')).toBeNull();
    expect(e.textContent).toContain(evil);
  }
});

test('Approve and Reject emit the decision', () => {
  const onDecide = vi.fn();
  const el = mount({ ...base, action_type: 'vault_conflict', payload: { path: 'a.md', current_hash: null, content: 'x' }, current_text: 'y' }, onDecide);
  const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
  button('Approve').click();
  button('Reject').click();
  expect(onDecide.mock.calls).toEqual([['approve'], ['reject']]);
});
