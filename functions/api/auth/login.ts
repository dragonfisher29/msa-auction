import { CloudflareContext, hashSecret, json } from '../../lib/cloudflare';

export async function onRequestPost({ request, env }: CloudflareContext) {
  try {
    const body = await request.json();
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!username || !password) {
      return json({ error: 'Username and password are required.' }, 400);
    }

    const passwordHash = await hashSecret(password);
    const user = await env.DB.prepare('SELECT * FROM users WHERE LOWER(username) = ? AND passwordHash = ?').bind(username, passwordHash).first();

    if (!user) {
      return json({ error: 'Invalid username or password.' }, 401);
    }

    const token = `tok_${crypto.randomUUID()}`;
    await env.DB.prepare('UPDATE users SET token = ? WHERE id = ?').bind(token, user.id).run();

    return json({
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        token,
      },
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Login failed.' }, 500);
  }
}
