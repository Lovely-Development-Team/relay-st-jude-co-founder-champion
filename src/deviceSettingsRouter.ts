import { IRequestStrict, Router, status, StatusError } from 'itty-router';
import { cache } from 'cloudflare:workers';
import { z } from 'zod';
import { ONE_DAY, ONE_HOUR } from './constants';

type DeviceSettingsRequest = Request & IRequestStrict;

const router = Router<DeviceSettingsRequest, [Env, ExecutionContext]>({ base: '/api/device-settings' });

const deviceSettingsSchema = z.object({
	autoStartLiveActivity: z.boolean(),
});

export function deviceSettingsCacheTag(deviceId: string): string {
	return `device-settings-${deviceId}`;
}

router.put('/:deviceId', async (request, env: Env, ctx: ExecutionContext) => {
	const deviceId = request.params['deviceId'];

	const parseResult = deviceSettingsSchema.safeParse(await request.json());
	if (!parseResult.success) {
		throw new StatusError(422, parseResult.error.message);
	}
	const { autoStartLiveActivity } = parseResult.data;
	const now = new Date().toISOString();

	await env.WIDGET_PUSH_TOKENS.prepare(
		`INSERT INTO device_settings (device_id, auto_start_live_activity, updated_at)
		 VALUES (?1, ?2, ?3)
		 ON CONFLICT(device_id) DO UPDATE SET auto_start_live_activity = ?2, updated_at = ?3`
	).bind(deviceId, autoStartLiveActivity ? 1 : 0, now).run();

	ctx.waitUntil((async () => {
		try {
			const purgeResult = await cache.purge({ tags: [deviceSettingsCacheTag(deviceId)] });
			if (!purgeResult.success) {
				console.error(`Failed to purge device settings cache for ${deviceId}`, purgeResult.errors);
			}
		} catch (err) {
			console.error(`Threw while purging device settings cache for ${deviceId}`, err);
		}
	})());

	return status(204);
});

router.get('/:deviceId', async (request, env: Env, ctx: ExecutionContext) => {
	const deviceId = request.params['deviceId'];

	const row = await env.WIDGET_PUSH_TOKENS.prepare(
		`SELECT auto_start_live_activity FROM device_settings WHERE device_id = ?1`
	).bind(deviceId).first<{ auto_start_live_activity: number }>();

	return new Response(JSON.stringify({ autoStartLiveActivity: row ? row.auto_start_live_activity === 1 : true }), {
		headers: {
			'content-type': 'application/json',
			'cdn-cache-control': `public, max-age=${ONE_HOUR}, stale-while-revalidate=${ONE_DAY}`,
			'cache-tag': deviceSettingsCacheTag(deviceId),
		},
	});
});

export default router;
