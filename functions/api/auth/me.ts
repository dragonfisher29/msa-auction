import { CloudflareContext, getAuthenticatedUser, json } from '../../lib/cloudflare';

export async function onRequestGet({ request, env }: CloudflareContext) {
  const authHeader = request.headers.get('authorization');
  const user = await getAuthenticatedUser(env, authHeader);

  if (!user) {
    return json({ error: 'Not authenticated' }, 401);
  }

  return json({
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      token: user.token,
    },
  });
}
