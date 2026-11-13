// Corrected fixture: enforce the admin role for protected resources.
export function canAccess(user, resource) {
  if (!user || !user.id) return false;
  return user.role === "admin";
}

export function auditLabel(user) {
  return user && user.role === "admin" ? "privileged" : "standard";
}
