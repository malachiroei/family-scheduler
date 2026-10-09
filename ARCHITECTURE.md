# Architecture

Family scheduler: Next.js (App Router) + Postgres (Supabase/Neon/any), deployed on Vercel.
The UI is a single client page (`app/page.tsx`) plus a floating AI chat (`app/components/AgentChat.tsx`).

## Database

Connection is resolved in `app/lib/db.ts` (first non-empty of `SUPABASE_POSTGRES_URL`, `SUPABASE_DATABASE_URL`,
`POSTGRES_URL`, `DATABASE_URL`). `sql` is a tagged template returning `{ rows, rowCount }`.

| Table | Purpose |
|---|---|
| `schedule` | All events/tasks. Columns: `id TEXT PK`, `title TEXT`, `"date" TEXT` (`YYYY-MM-DD`), `metadata JSONB`. |
| `family_learned_patterns` | Agent memory (see "Learning"). |
| push tables (`app/lib/push.ts`) | Web-push subscriptions and user identity, created on demand. |

`schedule.metadata` (typed in `app/lib/scheduleTable.ts`): `dayIndex` (0=Sun..6=Sat), `time` (`HH:mm`), `child`
(`ravid|amit|alin|amit_alin|alin_ravid|amit_ravid`), `type` (`dog|gym|sport|lesson|dance`), `isRecurring`,
`recurringTemplateId`, `completed`, `sendNotification`, `requireConfirmation`/`needsAck`, `reminderLeadMinutes`,
`userId`, `notified`. `ensureScheduleMetadataColumn()` creates the table/column if missing.

Johnny's built-in walks are not stored: they are generated in `app/page.tsx` (`buildJohnnyEvents`). Deleting one
stores a tombstone row titled `__JOHNNY_SUPPRESSED__` so it stays hidden after refetch.

## APIs (`app/api/*`)

| Route | Role |
|---|---|
| `schedule` | CRUD for `schedule` (GET list, POST create/bulk/text-import, PUT upsert, PATCH confirm/unconfirm, DELETE with password `DELETE_PASSWORD`, default `2101`). Triggers push + reminder sweep. |
| `agent` | AI scheduling agent (below). |
| `push/*`, `notifications/*` | Web-push subscribe, test, remind, confirm; notification check/ack. |
| `presence`, `state` | Lightweight shared UI state. |
| `debug/subscriptions` | Diagnostics. |

## Agent data flow (`POST /api/agent`)

1. Client (`AgentChat`) sends `{ text, imageBase64?, history, draft }`. `draft` is the server's last partial result.
2. Short replies to a pending question ("עמית", "כן, עבור רביד", bare "כן") are resolved locally with no LLM call.
   Otherwise the prompt (today's date, learned patterns, draft, history) goes to OpenAI if `OPENAI_API_KEY` is set,
   else Gemini (`gemini-2.5-flash`, fallback `gemini-2.0-flash`). Output is JSON:
   `{ sender_or_group, child_name, events: [{ date, time, title, type, keyword }] }`. A screenshot can yield many events.
3. The server merges with the draft and decides the child (see below).
4. Missing data -> `{ success: false, missing_fields, question, draft, quick_replies }`. Missing only the child
   produces one question for the whole batch, with buttons.
5. Complete -> inserts every event into `schedule`, sends one push, learns, returns `{ success: true, message, events }`.

## Learning

Table `family_learned_patterns`, unique on `(keyword, sender_or_group, child_name)`:
`confirmations_count`, `auto_assign`, `hits`, `event_type`, `updated_at`. `keyword = '*'` is a source-level row
("anything from this group").

- Every saved batch counts as one confirmation for each event keyword/title and for the source `*` row.
- Matching uses keyword AND the same `sender_or_group`.
- A match only **suggests** a child ("לשבץ עבור רביד?" with buttons). Silent assignment happens only when
  `auto_assign = true`, which is set at 3 confirmations for one known source and child (never for an empty source).
- A child named explicitly in the input is trusted and saved directly.

## Saturday rotation for Johnny

`getSaturdayJohnnyAssignment` in `app/page.tsx`: 3-week cycle (weeks since `ROTATION_ANCHOR_WEEK_START`, mod 3).
Saturday 1: amit morning (08:00), ravid afternoon (13:00), alin free. Saturday 2: alin / amit, ravid free.
Saturday 3: ravid / alin, amit free.
