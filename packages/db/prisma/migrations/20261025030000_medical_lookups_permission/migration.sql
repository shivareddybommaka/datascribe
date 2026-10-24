-- D-129: the `medical_lookups` permission module (§9 lookups). Idempotent.
-- 1. Catalogue rows for every action x scope, like ALL_PERMISSIONS (so the role editor can offer them).
INSERT INTO "Permission" ("id", "module", "action", "scope", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'medical_lookups', a.action, s.scope, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM unnest(ARRAY['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage']) AS a(action)
CROSS JOIN unnest(ARRAY['all', 'firm', 'assigned', 'own']) AS s(scope)
ON CONFLICT ("module", "action", "scope") DO NOTHING;

-- 2. Built-in roles get the defaults from DEFAULT_ROLE_PERMISSIONS. super_admin holds every
--    action on every module; the staff roles that code or review get `view`. Custom roles untouched.
INSERT INTO "RolePermission" ("roleId", "permissionId", "createdAt", "updatedAt")
SELECT r."id", p."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Role" r
JOIN "Permission" p ON p."module" = 'medical_lookups' AND p."scope" = 'all'
WHERE r."isSystem"
  AND (
    r."key" = 'super_admin'
    OR (r."key" IN ('ops_manager', 'case_manager', 'summarizer', 'qa_reviewer') AND p."action" = 'view')
  )
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
