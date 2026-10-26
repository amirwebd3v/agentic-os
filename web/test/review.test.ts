import { createApp, nextTick } from 'vue';
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

test('payload text renders as text, never as HTML', () => {
  const evil = '<img src=x onerror="alert(1)">';
  const el = mount({
    id: 1, proposed_by: 'w1-10', created_at: '2026-10-26T00:00:00Z', original_text: evil,
    action_type: 'propose_category',
    payload: { slug: 'x', name: evil, description: evil, reason: evil, parent_slug: null, session_ids: [] },
  });
  const conflict = mount({
    id: 2, proposed_by: 'app', created_at: '2026-10-26T00:00:00Z', original_text: null,
    action_type: 'vault_conflict', payload: { path: 'a.md', current_hash: null, content: evil }, current_text: evil,
  });
  for (const e of [el, conflict]) {
    expect(e.querySelector('img')).toBeNull();
    expect(e.textContent).toContain(evil);
  }
  expect(conflict.querySelector('button:nth-child(2)')?.textContent).toBe('Reject'); // no Edit on non-editable items
});

test('Edit then approve sends the edited text', async () => {
  const onDecide = vi.fn();
  const el = mount({
    id: 3, proposed_by: 'w1-10', created_at: '2026-10-26T00:00:00Z', original_text: 'old',
    action_type: 'propose_category',
    payload: { slug: 'x', name: 'X', description: 'old', parent_slug: null, session_ids: [1] },
  }, onDecide);
  const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
  button('Edit').click();
  await nextTick();
  const area = el.querySelector('textarea')!;
  area.value = ' new text ';
  area.dispatchEvent(new Event('input'));
  button('Save & approve').click();
  expect(onDecide).toHaveBeenCalledWith('approve', 'new text');
});
