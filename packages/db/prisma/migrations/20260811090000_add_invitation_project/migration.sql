-- Which project an invited member is attached to on accept.
--
-- Before this, accepting an invitation CREATED a project per member
-- (`ensureMemberDefaultProject`, one named "Default" per user), so an org
-- accumulated a project per person and invitees never landed anywhere shared.
-- The admin now chooses at invite time; null means "the organization's oldest
-- project", resolved at accept.
--
-- Nullable with ON DELETE SET NULL: a pending invitation must not block
-- deleting a project, and must not be orphaned by it either — it simply falls
-- back to the org default.
ALTER TABLE "invitations" ADD COLUMN "project_id" TEXT;

ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "invitations_project_id_idx" ON "invitations"("project_id");
