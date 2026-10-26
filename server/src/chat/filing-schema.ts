import { z } from 'zod';

/** Claude's structured answer for one session: where it belongs, and the summary note's content. */
export const SessionFiling = z.object({
  area_slug: z.string().nullable(), // an active top-level area, or null
  subarea: z.object({ slug: z.string(), name: z.string(), existing: z.boolean() }).nullable(),
  propose_top_level: z.object({ name: z.string(), description: z.string(), reason: z.string() }).nullable(),
  tags: z.array(z.string()),
  title: z.string(),
  summary: z.string(), // 3-6 sentences
  decisions: z.array(z.string()),
  todos: z.array(z.object({ text: z.string(), due: z.string().nullable() })),
  facts_about_me: z.array(z.string()),
  preferences: z.array(z.string()),
  open_questions: z.array(z.string()),
  lessons: z.array(z.string()),
});

export type SessionFiling = z.infer<typeof SessionFiling>;
