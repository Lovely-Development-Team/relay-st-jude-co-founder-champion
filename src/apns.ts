import { importPKCS8, SignJWT } from 'jose';
import { StatusError } from 'itty-router';
import { cache } from 'cloudflare:workers';
import { CO_FOUNDER_SCORES_CACHE_TAG, getScores } from './router';
import { ONE_HOUR } from './constants';

export type ApnsEnvironment = 'sandbox' | 'production';
type ApnsPushType = 'background' | 'liveactivity';

/**
 * Indicates that the channel is no longer recognised by APNS and a new one needs to be created
 */
export class ChannelInvalidatedError extends Error {
	constructor(public readonly environment: ApnsEnvironment) {
		super(`Live Activity channel for ${environment} is no longer registered with APNs`);
		this.name = 'ChannelInvalidatedError';
	}
}

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

type ApnsPushResult = { ok: true } | { ok: false; status: number; reason?: string };
async function sendApnsPush(
	env: Env,
	deviceToken: string,
	environment: ApnsEnvironment,
	pushType: ApnsPushType,
	topic: string,
	payload: unknown,
	priority: 5 | 10
): Promise<ApnsPushResult> {
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
export async function getOrCreateChannel(env: Env, environment: ApnsEnvironment, ctx: ExecutionContext): Promise<string> {
	const existingChannelId = await env.RELAY_FOR_ST_JUDE.get(makeChannelKey(environment));
	if (existingChannelId) {
		return existingChannelId;
	}

	const channelId = await createChannel(env, environment);

	// Concurrent first-requests can each get past the read above and create their own channel.
	// Re-check right before writing so only the first writer's channel ID is kept — the losers'
	// freshly-created channels are simply left unregistered in KV rather than orphaning a
	// caller who already received the winning ID.
	// This is not a perfect fix, given the limited guarantees of KV, but it's "good enough" in practice.
	const raceWinnerChannelId = await env.RELAY_FOR_ST_JUDE.get(makeChannelKey(environment));
	if (raceWinnerChannelId) {
		return raceWinnerChannelId;
	}
	await env.RELAY_FOR_ST_JUDE.put(makeChannelKey(environment), channelId);

	ctx.waitUntil(
		cache.purge({ tags: [liveActivityChannelCacheTag(environment)] })
			.then((purgeResult) => {
				if (!purgeResult.success) {
					console.error(`Failed to purge Live Activity channel cache for ${environment}`, purgeResult.errors);
				}
			})
			.catch((err) => {
				console.error(`Threw while purging Live Activity channel cache for ${environment}`, err);
			})
	);

	return channelId;
}

async function sendBroadcastPush(
	env: Env,
	channelId: string,
	environment: ApnsEnvironment,
	payload: unknown
): Promise<ApnsPushResult> {
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

// Deletes a row's token only on 410 or reason=BadDeviceToken — a bare 400 can also mean
// BadTopic, BadPriority, etc., which say nothing about the token and must not delete it.
async function deleteDeadPushTokens(
	env: Env,
	rows: PushTokenRow[],
	results: PromiseSettledResult<ApnsPushResult>[]
): Promise<void> {
	const deadRows: PushTokenRow[] = [];
	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		if (result.status === 'rejected') {
			console.error(`APNs push threw for device ${rows[i].device_id}`, result.reason);
			continue;
		}
		if (result.value.ok) continue;
		if (result.value.status === 410 || result.value.reason === 'BadDeviceToken') {
			deadRows.push(rows[i]);
		}
	}

	if (deadRows.length === 0) return;

	await env.WIDGET_PUSH_TOKENS.batch(deadRows.map((row) =>
		env.WIDGET_PUSH_TOKENS.prepare(
			`DELETE FROM push_tokens WHERE device_id = ?1 AND token_type = ?2 AND scope_id = ?3 AND environment = ?4 AND token = ?5`
		).bind(row.device_id, row.token_type, row.scope_id, row.environment, row.token)
	));
}

export async function notifyScoreChange(
	env: Env,
	updatedScores: { myke: number; stephen: number } | undefined = undefined
): Promise<void> {
	const scores = updatedScores ?? await getScores(env);

	const { results: rows } = await env.WIDGET_PUSH_TOKENS.prepare(
		`SELECT device_id, token_type, scope_id, token, environment FROM push_tokens WHERE token_type = 'widget'`
	).all<PushTokenRow>();

	console.log('Sending notifications for new scores', scores);

	const purgePromise = cache.purge({ tags: [CO_FOUNDER_SCORES_CACHE_TAG] })
		.then((purgeResult) => {
			if (!purgeResult.success) {
				console.error('Failed to purge co-founder scores cache', purgeResult.errors);
			}
		})
		.catch((err) => {
			console.error('Threw while purging co-founder scores cache', err);
		});

	const [, results] = await Promise.all([
		purgePromise,
		Promise.allSettled(rows.map((row) =>
			sendApnsPush(env, row.token, row.environment, 'background', env.APNS_BUNDLE_ID, { aps: { 'content-changed': 1 } }, 5)
		)),
	]);

	await deleteDeadPushTokens(env, rows, results);

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

const LIVE_ACTIVITY_LAST_START_KEY = 'live-activity-last-start';

/**
 * Reads LIVE_ACTIVITY_RESTART_INTERVAL_HOURS from the environment (configured in wrangler.toml).
 * iOS force-ends a Live Activity after ~8h, so it needs restarting periodically for the rest of the
 * event — this must stay comfortably under that OS cap.
 */
function liveActivityRestartIntervalMs(env: Env): number {
	return Number.parseInt(env.LIVE_ACTIVITY_RESTART_INTERVAL_HOURS, 10) * ONE_HOUR * 1000;
}

async function sendBroadcastEnd(env: Env, environment: ApnsEnvironment, channelId: string, scores: { myke: number; stephen: number }): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	const result = await sendBroadcastPush(env, channelId, environment, {
		aps: {
			timestamp: now,
			event: 'end',
			'content-state': scores,
			'dismissal-date': now,
		},
	});
	if (result.ok) return;

	if (result.reason !== 'ChannelNotRegistered') {
		throw new Error(`Live Activity end broadcast failed for ${environment}: ${result.status} ${result.reason ?? ''}`);
	}

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
	throw new ChannelInvalidatedError(environment);
}

/**
 * Runs sendLiveActivityStarts at most once per LIVE_ACTIVITY_RESTART_INTERVAL_MS, guarded by a KV
 * timestamp.
 *
 * If there is an existing activity, it will end that activity before creating a new one.
 */
export async function sendLiveActivityStartsOnce(env: Env, ctx: ExecutionContext): Promise<void> {
	const lastStartString = await env.RELAY_FOR_ST_JUDE.get(LIVE_ACTIVITY_LAST_START_KEY);
	const lastStart = lastStartString !== null ? Number.parseInt(lastStartString, 10) : null;
	const now = Date.now();
	if (lastStart !== null && now - lastStart < liveActivityRestartIntervalMs(env)) return;

	const isFirstRun = lastStart === null;
	await env.RELAY_FOR_ST_JUDE.put(LIVE_ACTIVITY_LAST_START_KEY, String(now));

	const scores = await getScores(env);
	const channelIds = await env.RELAY_FOR_ST_JUDE.get([makeChannelKey('sandbox'), makeChannelKey('production')]);
	const environments: ApnsEnvironment[] = ['sandbox', 'production'];

	// Nothing has been started yet on the very first run, so there's nothing to end.
	if (!isFirstRun) {
		const invalidated = await Promise.all(environments.map(async (environment) => {
			const channelId = channelIds.get(makeChannelKey(environment));
			if (!channelId) return false;
			try {
				await sendBroadcastEnd(env, environment, channelId, scores);
				return false;
			} catch (err) {
				if (err instanceof ChannelInvalidatedError) return true;
				// A genuine send failure isn't a signal the channel is dead — keep it and let the
				// restart below proceed with it as normal.
				console.error(`Threw while sending Live Activity end broadcast for ${environment}`, err);
				return false;
			}
		}));
		await Promise.all(environments.map(async (environment, i) => {
			if (!invalidated[i]) return;
			const newChannelId = await getOrCreateChannel(env, environment, ctx);
			channelIds.set(makeChannelKey(environment), newChannelId);
		}));
	}

	await sendLiveActivityStarts(env, scores, channelIds);
}

// Sends a push-to-start for every stored liveActivityStart token whose device hasn't opted out
// via device_settings (absent row defaults to opted in), per environment.
// Skips an environment with no channel in KV yet.
async function sendLiveActivityStarts(
	env: Env,
	scores: { myke: number; stephen: number },
	channelIds: Map<string, string | null>
): Promise<void> {
	const { results: startRows } = await env.WIDGET_PUSH_TOKENS.prepare(
		`SELECT push_tokens.device_id, push_tokens.token_type, push_tokens.scope_id, push_tokens.token, push_tokens.environment
		 FROM push_tokens
		 LEFT JOIN device_settings ON device_settings.device_id = push_tokens.device_id
		 WHERE push_tokens.token_type = 'liveActivityStart'
		 AND COALESCE(device_settings.auto_start_live_activity, 1) = 1`
	).all<PushTokenRow>();

	const startResults = (await Promise.allSettled(startRows.map((row) =>
		{
			const channelId = channelIds.get(makeChannelKey(row.environment));
			if (!channelId) {
				return Promise.resolve<ApnsPushResult>({ ok: false, status: 0, reason: 'No channel for environment' });
			}
			return startLiveActivity(env, row.token, row.environment, {}, scores, channelId);}
	)));
	console.log(`Starting live activity for ${startRows.length} devices`)

	await deleteDeadPushTokens(env, startRows, startResults);
}

// Per-device push-to-star, as we can only use broadcast channels for updates.
export async function startLiveActivity(
	env: Env,
	deviceToken: string,
	environment: ApnsEnvironment,
	attributes: unknown,
	scores: { myke: number; stephen: number },
	channelId: string
): Promise<ApnsPushResult> {
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
				"alert": {
					"title": "Relay Podcastathon",
					"body": "Starting now!"
				}
			},
		},
		10
	);
}
