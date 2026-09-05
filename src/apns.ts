import { importPKCS8, SignJWT } from 'jose';
import { makeScoreKey } from './router';

type ApnsEnvironment = 'sandbox' | 'production';
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
	console.error(`APNs push failed: ${response.status} ${body.reason ?? ''} (device ${deviceToken})`);
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
		`SELECT device_id, token_type, scope_id, token, environment FROM push_tokens WHERE token_type IN ('widget', 'liveActivityUpdate')`
	).all<PushTokenRow>();

	const results = await Promise.allSettled(rows.map((row) => {
		if (row.token_type === 'widget') {
			return sendApnsPush(env, row.token, row.environment, 'background', env.APNS_BUNDLE_ID, { aps: { 'content-changed': 1 } }, 5)
		} else {
			return sendApnsPush(
				env,
				row.token,
				row.environment,
				'liveactivity',
				`${env.APNS_BUNDLE_ID}.push-type.liveactivity`,
				{
					aps: {
						timestamp: Math.floor(Date.now() / 1000),
						event: 'update',
						'content-state': scores
					}
				},
				10
			)
		}
}));

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
}

// Not wired into notifyScoreChange — push-to-start should be triggered explicitly
// (e.g. a manual admin action), not on every score change.
export async function startLiveActivity(
	env: Env,
	deviceToken: string,
	environment: ApnsEnvironment,
	attributes: unknown
): Promise<{ ok: true } | { ok: false; status: number; reason?: string }> {
	const [mykeStored, stephenStored] = await Promise.all([
		env.RELAY_FOR_ST_JUDE.get(makeScoreKey('myke')),
		env.RELAY_FOR_ST_JUDE.get(makeScoreKey('stephen')),
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
				'attributes-type': env.APNS_LIVE_ACTIVITY_ATTRIBUTES_TYPE,
				attributes,
				'content-state': scores,
			},
		},
		10
	);
}
