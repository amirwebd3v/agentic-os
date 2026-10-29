import { onMounted, onUnmounted } from 'vue';

/** True when a key press belongs to a field or a browser shortcut, so single-key shortcuts must leave it alone. */
export const typing = (e: KeyboardEvent): boolean => {
  const t = e.target as HTMLElement | null;
  return e.ctrlKey || e.metaKey || e.altKey || !!t?.closest('input, textarea, select, [contenteditable], dialog');
};

/** Single-key shortcuts for as long as the calling component is mounted. */
export function useKeys(map: Record<string, (e: KeyboardEvent) => void>): void {
  const onKey = (e: KeyboardEvent) => {
    if (typing(e)) return;
    const fn = map[e.key];
    if (!fn) return;
    e.preventDefault();
    fn(e);
  };
  onMounted(() => window.addEventListener('keydown', onKey));
  onUnmounted(() => window.removeEventListener('keydown', onKey));
}
