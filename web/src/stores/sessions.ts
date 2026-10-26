import { defineStore } from 'pinia';
import { ref } from 'vue';
import * as api from '../api';
import { useProviderStore } from './provider';

type Open = { session: api.SessionSummary; messages: api.Message[]; error: string | null };

export const useSessionsStore = defineStore('sessions', () => {
  const list = ref<api.SessionSummary[]>([]);
  const current = ref<Open | null>(null);
  /** One reply streams at a time; `open` is its live session, reused if you navigate away and back. */
  const streaming = ref<{ open: Open; ctrl: AbortController } | null>(null);
  let openSeq = 0;

  const syncCurrent = () => {
    const s = current.value && list.value.find((x) => x.id === current.value!.session.id);
    if (s) current.value!.session = s;
  };
  const load = async () => {
    list.value = await api.listSessions();
    syncCurrent();
  };
  const open = async (id: number) => {
    const seq = ++openSeq;
    if (streaming.value?.open.session.id === id) {
      current.value = streaming.value.open;
      return;
    }
    const r = await api.getSession(id);
    if (seq === openSeq) current.value = { ...r, error: null }; // a later open() wins
  };
  const create = async (mode: api.SessionMode) => {
    const s = await api.createSession(mode);
    list.value.unshift(s);
    return s;
  };
  const update = async (id: number, patch: { title?: string; area_id?: number }) => {
    const s = await api.patchSession(id, patch);
    list.value = list.value.map((x) => (x.id === s.id ? s : x));
    syncCurrent();
  };

  /** Sends a message and streams the reply. Returns false if it never reached the model (restore the input). */
  async function send(content: string): Promise<boolean> {
    const cur = current.value;
    if (!cur || streaming.value) return false;
    cur.error = null;
    const now = new Date().toISOString();
    cur.messages.push(
      { id: -1, role: 'user', content, status: 'done', created_at: now },
      { id: -2, role: 'assistant', content: '', status: 'streaming', created_at: now },
    );
    // Mutate through the reactive array so the view sees each delta.
    const user = cur.messages[cur.messages.length - 2]!;
    const reply = cur.messages[cur.messages.length - 1]!;
    const ctrl = new AbortController();
    streaming.value = { open: cur, ctrl };
    try {
      const end = await api.streamMessage(cur.session.id, content, {
        start: (ids) => {
          user.id = ids.user_message_id;
          reply.id = ids.assistant_message_id;
        },
        delta: (text) => {
          reply.content += text;
        },
      }, ctrl.signal);
      reply.status = end.kind === 'done' ? 'done' : end.kind === 'aborted' ? 'aborted' : 'error';
      if (end.kind === 'error') cur.error = `The model call failed (${end.error}).`;
      return true;
    } catch (err) {
      cur.messages.splice(cur.messages.indexOf(user), 2);
      const notConfigured = err instanceof api.ApiError && err.status === 409;
      cur.error = notConfigured ? 'No provider is configured.' : 'Sending failed.';
      if (notConfigured) await useProviderStore().load().catch(() => {});
      return false;
    } finally {
      streaming.value = null;
      await load().catch(() => {}); // titles and activity order change after a reply
    }
  }

  const stop = () => streaming.value?.ctrl.abort();

  return { list, current, streaming, load, open, create, update, send, stop };
});
