// Vercel entry point: every /api/* request is rewritten here and handled by the same code as the local server.
export { handler as default } from '../server.mjs';
