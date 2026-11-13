// Protected CI check. It independently verifies the authorization boundary.
import { canAccess } from "../src/auth.js";

const memberAllowed = canAccess({ id: "u2", role: "member" }, "billing");
if (memberAllowed) {
  console.error("CI FAIL: member was allowed to access billing");
  process.exit(1);
}
console.log("CI PASS: authorization boundary holds");
