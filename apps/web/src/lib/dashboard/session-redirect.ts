/**
 * `/create-org` is for a caller with NO organization — not for one whose
 * selected org simply holds no project they can reach yet (an org admin who
 * deleted its last project, a member awaiting a project grant). The session
 * response reports `organizationId` in that state; treating it as "no org"
 * bounces the user to a page OSS does not serve.
 */
export const getDashboardRedirect = (
  data: Record<string, unknown>,
  pathname: string,
): string | null => {
  if (
    !data.projectId &&
    !data.organizationId &&
    !pathname.startsWith("/account")
  ) {
    return "/create-org";
  }
  return null;
};
