-- ===========================================================================
-- BizPilot — 0006 internal function ACL fixes
--
-- WHY THIS MIGRATION EXISTS
--   Migration 0003 revoked EXECUTE on the three internal helper functions
--   from PUBLIC only:
--
--     revoke all on function public.write_audit_log(...) from public;
--     revoke all on function public.assert_can_write(uuid) from public;
--     revoke all on function public.assert_can_manage(uuid) from public;
--
--   That is not sufficient. PUBLIC is a pseudo-role: privileges granted to
--   PUBLIC apply to all roles. Revoking from PUBLIC removes that shared grant,
--   but does NOT remove a separate privilege granted directly to a named role
--   such as authenticated. The effective-privilege assertions in
--   supabase/tests/03_invoice_engine_v2_test.sql (section 7f) showed that
--   `authenticated` could still execute these helpers.
--
--   These are INTERNAL helpers. They are called only from inside SECURITY
--   DEFINER RPCs, which run as the function owner (postgres) and therefore do
--   not need a grant on the caller's behalf. No client role should ever be
--   able to call them directly.
--
-- WHAT THIS MIGRATION DOES
--   Revokes EXECUTE from PUBLIC, anon and authenticated on exactly these
--   three functions, using their exact signatures. Nothing else is touched:
--   there is deliberately no mass revoke across the public schema, because
--   the client-facing RPCs (create_invoice, issue_invoice, void_invoice,
--   record_payment, reverse_payment, log_reminder, create_business_with_owner,
--   confirm_gst_scheme, next_invoice_number and the can_* / is_* predicates)
--   must keep their existing grants.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   * It does not change ownership. The functions stay owned by postgres.
--   * It does not touch service_role. service_role is a trusted server-side
--     role and keeps whatever privileges it holds; it is not a client role.
--   * It does not alter SECURITY DEFINER, the fixed search_path, or any
--     function body. The RPCs that call these helpers keep working because
--     they execute as the owner, not as the caller.
--   * It does not weaken RLS, audit triggers or immutability triggers.
--   * It contains no BEGIN/COMMIT: the Supabase CLI runs each migration file
--     inside its own transaction.
--   * It contains no remote or deployment commands.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. public.write_audit_log — internal audit writer.
--
--    Called by every RPC that records an audit row. Exposing it to clients
--    would let a caller forge audit entries for arbitrary entities.
-- ---------------------------------------------------------------------------
revoke all on function public.write_audit_log(
  uuid, text, uuid, public.audit_action, jsonb, jsonb
) from public;
revoke all on function public.write_audit_log(
  uuid, text, uuid, public.audit_action, jsonb, jsonb
) from anon;
revoke all on function public.write_audit_log(
  uuid, text, uuid, public.audit_action, jsonb, jsonb
) from authenticated;

-- ---------------------------------------------------------------------------
-- 2. public.assert_can_write — internal authorization guard.
--
--    Raises 28000 when unauthenticated and 42501 when the caller lacks
--    financial-write rights. It is a building block for the RPCs, not an API.
-- ---------------------------------------------------------------------------
revoke all on function public.assert_can_write(uuid) from public;
revoke all on function public.assert_can_write(uuid) from anon;
revoke all on function public.assert_can_write(uuid) from authenticated;

-- ---------------------------------------------------------------------------
-- 3. public.assert_can_manage — internal authorization guard.
--
--    Same reasoning as assert_can_write, for owner/admin-only operations.
-- ---------------------------------------------------------------------------
revoke all on function public.assert_can_manage(uuid) from public;
revoke all on function public.assert_can_manage(uuid) from anon;
revoke all on function public.assert_can_manage(uuid) from authenticated;

-- ---------------------------------------------------------------------------
-- 4. Post-condition: fail the migration if any client role can still execute
--    one of the helpers.
--
--    A silent no-op here would leave the privilege hole open while the
--    migration reported success, so this raises instead of warning.
-- ---------------------------------------------------------------------------
do $$
declare
  v_leaks text;
begin
  select string_agg(format('%s -> %s', r, f), ', ' order by r, f)
    into v_leaks
  from (
    values
      ('anon', 'public.write_audit_log(uuid,text,uuid,public.audit_action,jsonb,jsonb)'),
      ('anon', 'public.assert_can_write(uuid)'),
      ('anon', 'public.assert_can_manage(uuid)'),
      ('authenticated', 'public.write_audit_log(uuid,text,uuid,public.audit_action,jsonb,jsonb)'),
      ('authenticated', 'public.assert_can_write(uuid)'),
      ('authenticated', 'public.assert_can_manage(uuid)')
  ) as t(r, f)
  where has_function_privilege(t.r::name, t.f, 'EXECUTE');

  if v_leaks is not null then
    raise exception
      'Internal helper functions are still executable by a client role: %', v_leaks
      using errcode = '42501';
  end if;
end;
$$;
