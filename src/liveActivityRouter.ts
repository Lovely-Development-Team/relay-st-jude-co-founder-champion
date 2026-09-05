import { IRequestStrict, Router, status, StatusError } from 'itty-router';
import { z } from 'zod';
import { checkPushTokenAuthentication } from './auth';

type LiveActivityRequest = Request & IRequestStrict;

const router = Router<LiveActivityRequest, [Env, ExecutionContext]>({ base: '/api/push-tokens' });

const PUSH_TOKEN_TYPES = ['widget', 'liveActivityStart', 'liveActivityUpdate'] as const;

const tokenEntrySchema = z.object({
	scopeId: z.string(),
	token: z.string().min(3),
	environment: z.enum(['sandbox', 'production']).default('production'),
})

const batchTokenEntriesSchema = z.array(tokenEntrySchema).min(1);

router.put('/:deviceId/:tokenType', async (request, env: Env, ctx: ExecutionContext) => {
	const deviceId = request.params['deviceId'];
	const tokenTypeResult = z.enum(PUSH_TOKEN_TYPES).safeParse(request.params['tokenType']);
	if (!tokenTypeResult.success) {
		throw new StatusError(422, tokenTypeResult.error.message);
	}
	const tokenType = tokenTypeResult.data;

	const parseResult = batchTokenEntriesSchema.safeParse(await request.json());
	if (!parseResult.success) {
		throw new StatusError(422, parseResult.error.message);
	}
	const entries = parseResult.data;
	const now = new Date().toISOString();

	const deleteStatement = env.WIDGET_PUSH_TOKENS.prepare(
		`DELETE FROM push_tokens WHERE device_id = ?1 AND token_type = ?2`
	).bind(deviceId, tokenType);
	const insertStatements = entries.map((entry) =>
		env.WIDGET_PUSH_TOKENS.prepare(
			`INSERT INTO push_tokens (device_id, token_type, scope_id, token, updated_at, environment)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
		).bind(deviceId, tokenType, entry.scopeId, entry.token, now, entry.environment)
	);

	await env.WIDGET_PUSH_TOKENS.batch([deleteStatement, ...insertStatements]);

	return status(204);
});

router.delete('/:deviceId/:tokenType', checkPushTokenAuthentication, async (request, env: Env, ctx: ExecutionContext) => {
	const deviceId = request.params['deviceId'];
	const tokenTypeResult = z.enum(PUSH_TOKEN_TYPES).safeParse(request.params['tokenType']);
	if (!tokenTypeResult.success) {
		throw new StatusError(422, tokenTypeResult.error.message);
	}

	await env.WIDGET_PUSH_TOKENS.prepare(
		`DELETE FROM push_tokens WHERE device_id = ?1 AND token_type = ?2`
	).bind(deviceId, tokenTypeResult.data).run();

	return status(204);
});

export default router;
