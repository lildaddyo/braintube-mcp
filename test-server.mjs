import { createMcpServer } from './dist/server.js';

try {
  const s = createMcpServer({ userId: 'test-user', email: 'test@test.com', authMethod: 'jwt' });
  console.log('createMcpServer: OK — no crash during tool registration');
} catch (e) {
  console.error('CRASH during createMcpServer:', e.message);
  console.error(e.stack);
}
