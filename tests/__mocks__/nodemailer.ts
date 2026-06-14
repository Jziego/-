// Stub: nodemailer is never called at runtime — auth.ts overrides
// sendVerificationRequest with Resend. This mock exists so Vitest
// can resolve the import from @auth/core/providers/nodemailer.js.
export default {};
