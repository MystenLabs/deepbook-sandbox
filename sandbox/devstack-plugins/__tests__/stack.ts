// Single source of truth for the e2e stack name, shared by the fixture
// (devstack.config.ts), the vitest global-setup (boots this stack), and the
// e2e vitest config (reads its manifest under the same name).
export const STACK_NAME = "deep-funding-itest";
