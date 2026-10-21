-- Fix Supabase linter: policy_exists_rls_disabled + rls_disabled_in_public
ALTER TABLE public.scheduler_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on scheduler_state" ON public.scheduler_state;
CREATE POLICY "Service role full access on scheduler_state"
  ON public.scheduler_state
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS scheduler_state_all ON public.scheduler_state;
CREATE POLICY scheduler_state_all
  ON public.scheduler_state
  FOR ALL
  TO anon, authenticated, service_role
  USING (true)
  WITH CHECK (true);

grant select, insert, update, delete on public.scheduler_state to anon, authenticated, service_role;
