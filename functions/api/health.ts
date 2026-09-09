import { json } from '../lib/cloudflare';

export async function onRequestGet() {
  return json({
    status: 'ok',
    provider: 'cloudflare-d1-r2',
    timestamp: Date.now(),
  });
}
