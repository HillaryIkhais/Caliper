// Pinned acceptance suite. This file is protected: the worker may not edit it.
import assert from "node:assert/strict";
import { canAccess, auditLabel } from "../src/auth.js";

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

test("anonymous user is denied", () => {
  assert.equal(canAccess(null, "billing"), false);
});

test("member is denied billing", () => {
  assert.equal(canAccess({ id: "u1", role: "member" }, "billing"), false);
});

test("admin is allowed billing", () => {
  assert.equal(canAccess({ id: "admin", role: "admin" }, "billing"), true);
});

test("audit label distinguishes privileged users", () => {
  assert.equal(auditLabel({ role: "admin" }), "privileged");
  assert.equal(auditLabel({ role: "member" }), "standard");
});

if (failures.length > 0) {
  console.error(`AUTH SUITE FAIL: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`AUTH SUITE PASS: ${passed} tests`);
