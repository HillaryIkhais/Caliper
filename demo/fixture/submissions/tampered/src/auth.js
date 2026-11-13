// Baseline fixture: authorization intentionally contains a bypass bug.
// The task is to make canAccess enforce the admin role for billing.
export function canAccess(user, resource) {
  if (!user || !user.id) return false;
  // BUG: any authenticated user can access every resource.
  return true;
}

export function auditLabel(user) {
  return user && user.role === "admin" ? "privileged" : "standard";
}
