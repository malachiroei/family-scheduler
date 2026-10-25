import { sql } from "@/app/lib/db";

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const trySql = async (label: string, run: () => Promise<unknown>) => {
  try {
    await run();
    return true;
  } catch (error) {
    console.warn(`[scheduler-state] ${label}:`, getErrorMessage(error));
    return false;
  }
};

/**
 * One-off grants + RLS for public.scheduler_state.
 * Do not call this from request handlers: concurrent GRANT/ALTER/CREATE POLICY
 * locks the catalog and starves /api/schedule (DB timeout).
 */
export const applySchedulerStateAccess = async () => {
  await trySql("grant postgres", () => sql`GRANT ALL ON TABLE public.scheduler_state TO postgres`);
  await trySql(
    "grant data api roles",
    () =>
      sql`GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduler_state TO anon, authenticated, service_role`,
  );
  await trySql(
    "enable rls",
    () => sql`ALTER TABLE public.scheduler_state ENABLE ROW LEVEL SECURITY`,
  );
  await trySql(
    "drop service role policy",
    () =>
      sql`DROP POLICY IF EXISTS "Service role full access on scheduler_state" ON public.scheduler_state`,
  );
  await trySql(
    "create service role policy",
    () => sql`
      CREATE POLICY "Service role full access on scheduler_state"
      ON public.scheduler_state
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true)
    `,
  );
  await trySql(
    "drop scheduler_state_all",
    () => sql`DROP POLICY IF EXISTS scheduler_state_all ON public.scheduler_state`,
  );
  await trySql(
    "create scheduler_state_all",
    () => sql`
      CREATE POLICY scheduler_state_all
      ON public.scheduler_state
      FOR ALL
      TO anon, authenticated, service_role
      USING (true)
      WITH CHECK (true)
    `,
  );
};
