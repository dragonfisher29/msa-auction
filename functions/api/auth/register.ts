import { CloudflareContext, getAuthenticatedUser, hashSecret, json } from '../../lib/cloudflare';

export async function onRequestPost({ request, env }: CloudflareContext) {
  try {
    const body = await request.json();
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!username || !name || !password.trim()) {
      return json({ error: 'Username, name, and password are required.' }, 400);
    }

    const existing = await env.DB.prepare('SELECT id FROM users WHERE LOWER(username) = ?').bind(username).first();
    if (existing) {
      return json({ error: 'Username is already taken. Please choose another.' }, 409);
    }

    const passwordHash = await hashSecret(password);
    const id = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const token = `tok_${crypto.randomUUID()}`;

    await env.DB.prepare(`
      INSERT INTO users (id, name, username, passwordHash, token, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, name, username, passwordHash, token, Date.now()).run();

    return json({
      user: {
        id,
        name,
        username,
        token,
      },
    }, 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Registration failed.' }, 500);
  }
}
