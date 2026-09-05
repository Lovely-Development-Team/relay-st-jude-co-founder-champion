import { importPKCS8, SignJWT } from 'jose';
import { StatusError } from 'itty-router';
import { cache } from 'cloudflare:workers';
import { CO_FOUNDER_SCORES_CACHE_TAG, makeScoreKey } from './router';

export type ApnsEnvironment = 'sandbox' | 'production';
type ApnsPushType = 'background' | 'liveactivity';

const cachedTokens: Partial<Record<ApnsEnvironment, { jwt: string; expiresAt: number }>> = {};

// Sandbox and production use separate Auth Keys
function apnsCredentials(env: Env, environment: ApnsEnvironment): { authKey: string; keyId: string; teamId: string } {
	return environment === 'sandbox'
		? { authKey: env.APNS_AUTH_KEY_SANDBOX, keyId: env.APNS_KEY_ID_SANDBOX, teamId: env.APNS_TEAM_ID }
		: { authKey: env.APNS_AUTH_KEY_PRODUCTION, keyId: env.APNS_KEY_ID_PRODUCTION, teamId: env.APNS_TEAM_ID };
}

async function getApnsJwt(env: Env, environment: ApnsEnvironment): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	// Apple tokens are valid up to 1h; module-level cache is a cheap way to avoid repeatedly
	// re-signing under load.
	const cached = cachedTokens[environment];
	if (cached && cached.expiresAt > now) {
		return cached.jwt;
	}

	const { authKey, keyId, teamId } = apnsCredentials(env, environment);
	const key = await importPKCS8(authKey, 'ES256');
	const jwt = await new SignJWT({ iss: teamId })
		.setProtectedHeader({ alg: 'ES256', kid: keyId })
		.setIssuedAt(now)
		.sign(key);

	cachedTokens[environment] = { jwt, expiresAt: now + 55 * 60 };
	return jwt;
}

async function sendApnsPush(
	env: Env,
	deviceToken: string,
	environment: ApnsEnvironment,
	pushType: ApnsPushType,
	topic: string,
	payload: unknown,
	priority: 5 | 10
): Promise<{ ok: true } | { ok: false; status: number; reason?: string }> {
	// wrangler dev doesn't support outbound HTTP/2, which APNs requires — this fetch only
	// succeeds against a deployed Worker (see https://github.com/cloudflare/workerd/issues/4841).
	const host = environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
	const jwt = await getApnsJwt(env, environment);

	const response = await fetch(`https://${host}/3/device/${deviceToken}`, {
		method: 'POST',
		headers: {
			authorization: `bearer ${jwt}`,
			'apns-topic': topic,
			'apns-push-type': pushType,
			'apns-priority': String(priority),
			'content-type': 'application/json',
		},
		body: JSON.stringify(payload),
	});

	if (response.ok) {
		return { ok: true };
	}

	const body = await response.json<{ reason?: string }>().catch((): { reason?: string } => ({}));
	let errMsg = `APNs push failed: ${response.status} ${body.reason ?? ''} (device ${deviceToken})`;
	if (response.status === 410 && body.reason === 'BadDeviceToken') {
		console.log(errMsg);
	} else {
		console.error(errMsg);
	}
	return { ok: false, status: response.status, reason: body.reason };
}

export function makeChannelKey(environment: string) {
	return `channel|${environment}`;
}

export function liveActivityChannelCacheTag(environment: ApnsEnvironment): string {
	return `live-activity-channel-${environment}`;
}

function channelManagementHost(environment: ApnsEnvironment): string {
	return environment === 'sandbox'
		? 'api-manage-broadcast.sandbox.push.apple.com:2195'
		: 'api-manage-broadcast.push.apple.com:2196';
}

export async function createChannel(env: Env, environment: ApnsEnvironment): Promise<string> {
	const jwt = await getApnsJwt(env, environment);
	const response = await fetch(`https://${channelManagementHost(environment)}/1/apps/${env.APNS_BUNDLE_ID}/channels`, {
		method: 'POST',
		headers: {
			authorization: `bearer ${jwt}`,
			'content-type': 'application/json',
		},
		// message-storage-policy is a number: 0 = no message stored (right for frequent score
		// updates), 1 = most recent message stored (for offline devices, up to 8h).
		body: JSON.stringify({ 'push-type': 'LiveActivity', 'message-storage-policy': 0 }),
	});

	if (response.status !== 201) {
		throw new StatusError(502, `Failed to create APNs channel: ${response.status}`);
	}
	const channelId = response.headers.get('apns-channel-id');
	if (!channelId) {
		throw new StatusError(502, 'APNs channel creation response missing apns-channel-id header');
	}
	return channelId;
}

// Reads the current channel ID for an environment, creating and storing one if none exists yet.
// Purges the channel's cache tag on creation so a stale (or previously deleted) cached response
// can't keep serving an old/dead channel ID after a new one is created.
export async function getOrCreateChannel(env: Env, environment: ApnsEnvironment): Promise<string> {
	const existingChannelId = await env.RELAY_FOR_ST_JUDE.get(makeChannelKey(environment));
	if (existingChannelId) {
		return existingChannelId;
	}

	const channelId = await createChannel(env, environment);
	await env.RELAY_FOR_ST_JUDE.put(makeChannelKey(environment), channelId);

	try {
		const purgeResult = await cache.purge({ tags: [liveActivityChannelCacheTag(environment)] });
		if (!purgeResult.success) {
			console.error(`Failed to purge Live Activity channel cache for ${environment}`, purgeResult.errors);
		}
	} catch (err) {
		console.error(`Threw while purging Live Activity channel cache for ${environment}`, err);
	}

	return channelId;
}

async function sendBroadcastPush(
	env: Env,
	channelId: string,
	environment: ApnsEnvironment,
	payload: unknown
): Promise<{ ok: true } | { ok: false; status: number; reason?: string }> {
	const host = environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
	const jwt = await getApnsJwt(env, environment);

	// Broadcast requests take no apns-topic — the channel ID is the addressing mechanism.
	const response = await fetch(`https://${host}/4/broadcasts/apps/${env.APNS_BUNDLE_ID}`, {
		method: 'POST',
		headers: {
			authorization: `bearer ${jwt}`,
			'apns-channel-id': channelId,
			'apns-push-type': 'liveactivity',
			'apns-priority': '10',
			'apns-expiration': '0',
			'content-type': 'application/json',
		},
		body: JSON.stringify(payload),
	});

	if (response.ok) {
		return { ok: true };
	}

	const body = await response.json<{ reason?: string }>().catch((): { reason?: string } => ({}));
	const errMsg = `APNs broadcast failed: ${response.status} ${body.reason ?? ''} (channel ${channelId})`;
	// A dead channel is an expected, handled case, not a fault — same treatment as BadDeviceToken.
	if (body.reason === 'ChannelNotRegistered') {
		console.log(errMsg);
	} else {
		console.error(errMsg);
	}
	return { ok: false, status: response.status, reason: body.reason };
}

type PushTokenRow = { device_id: string; token_type: string; scope_id: string; token: string; environment: ApnsEnvironment };

export async function notifyScoreChange(
	env: Env,
	updatedScores: { myke: number; stephen: number } | undefined = undefined
): Promise<void> {
	const scores = updatedScores ?? {
		myke: Number.parseInt(await env.RELAY_FOR_ST_JUDE.get(makeScoreKey('myke')) ?? '0', 10),
		stephen: Number.parseInt(await env.RELAY_FOR_ST_JUDE.get(makeScoreKey('stephen')) ?? '0', 10) };

	const { results: rows } = await env.WIDGET_PUSH_TOKENS.prepare(
		`SELECT device_id, token_type, scope_id, token, environment FROM push_tokens WHERE token_type = 'widget'`
	).all<PushTokenRow>();

	console.log('Sending notifications for new scores', scores);

	try {
		const purgeResult = await cache.purge({ tags: [CO_FOUNDER_SCORES_CACHE_TAG] });
		if (!purgeResult.success) {
			console.error('Failed to purge co-founder scores cache', purgeResult.errors);
		}
	} catch (err) {
		console.error('Threw while purging co-founder scores cache', err);
	}

	const results = await Promise.allSettled(rows.map((row) =>
		sendApnsPush(env, row.token, row.environment, 'background', env.APNS_BUNDLE_ID, { aps: { 'content-changed': 1 } }, 5)
	));

	await Promise.all(results.map(async (result, i) => {
		if (result.status === 'rejected') {
			console.error(`APNs push threw for device ${rows[i].device_id}`, result.reason);
			return;
		}
		if (result.value.ok) return;
		// Only these two reasons mean the token itself is dead — a bare 400 can also mean
		// BadTopic, BadPriority, etc., which say nothing about the token and must not delete it.
		if (result.value.status === 410 || result.value.reason === 'BadDeviceToken') {
			const row = rows[i];
			await env.WIDGET_PUSH_TOKENS.prepare(
				`DELETE FROM push_tokens WHERE device_id = ?1 AND token_type = ?2 AND scope_id = ?3 AND environment = ?4 AND token = ?5`
			).bind(row.device_id, row.token_type, row.scope_id, row.environment, row.token).run();
		}
	}));

	const environments: ApnsEnvironment[] = ['sandbox', 'production'];
	await Promise.all(environments.map(async (environment) => {
		const channelId = await env.RELAY_FOR_ST_JUDE.get(makeChannelKey(environment));
		if (!channelId) return;

		const result = await sendBroadcastPush(env, channelId, environment, {
			aps: {
				timestamp: Math.floor(Date.now() / 1000),
				event: 'update',
				'content-state': scores,
			},
		});
		if (result.ok) return;

		if (result.reason === 'ChannelNotRegistered') {
			await env.RELAY_FOR_ST_JUDE.delete(makeChannelKey(environment));
			try {
				const purgeResult = await cache.purge({ tags: [liveActivityChannelCacheTag(environment)] });
				if (!purgeResult.success) {
					console.error(`Failed to purge Live Activity channel cache for ${environment}`, purgeResult.errors);
				}
			} catch (err) {
				console.error(`Threw while purging Live Activity channel cache for ${environment}`, err);
			}
			console.log(`Live Activity channel for ${environment} is gone; existing activities are orphaned until the app relaunches and fetches a new channel`);
		}
	}));
}

// Not wired into notifyScoreChange — push-to-start should be triggered explicitly
// (e.g. a manual admin action), not on every score change.
// This has to be per-device and not a broadcast, but we can then update it using a channel.
export async function startLiveActivity(
	env: Env,
	deviceToken: string,
	environment: ApnsEnvironment,
	attributes: unknown
): Promise<{ ok: true } | { ok: false; status: number; reason?: string }> {
	const [mykeStored, stephenStored, channelId] = await Promise.all([
		env.RELAY_FOR_ST_JUDE.get(makeScoreKey('myke')),
		env.RELAY_FOR_ST_JUDE.get(makeScoreKey('stephen')),
		getOrCreateChannel(env, environment),
	]);
	const scores = {
		myke: mykeStored !== null ? Number.parseFloat(mykeStored) : 0,
		stephen: stephenStored !== null ? Number.parseFloat(stephenStored) : 0,
	};

	return sendApnsPush(
		env,
		deviceToken,
		environment,
		'liveactivity',
		`${env.APNS_BUNDLE_ID}.push-type.liveactivity`,
		{
			aps: {
				timestamp: Math.floor(Date.now() / 1000),
				event: 'start',
				'input-push-channel': channelId,
				'attributes-type': env.APNS_LIVE_ACTIVITY_ATTRIBUTES_TYPE,
				attributes,
				'content-state': scores,
			},
		},
		10
	);
}
