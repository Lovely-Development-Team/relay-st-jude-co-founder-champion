import { IRequestStrict, Router, status, StatusError } from 'itty-router';
import { z } from 'zod';

// Barring a dramatic upheaval, I think we're safe to hardcode this.
export const CO_FOUNDERS = ['myke', 'stephen'] as const;

type ScoreRequest = Request & IRequestStrict & { coFounder?: typeof CO_FOUNDERS[number] }

// now let's create a router (note the lack of "new")
const router = Router<ScoreRequest, [Env]>();

export function makeScoreKey(coFounder: string | undefined) {
	return `score|${coFounder}`;
}

function checkAuthentication(request: ScoreRequest, env: Env) {
	const authHeader = request.headers.get("authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		throw new StatusError(401);
	}
	const token = authHeader.substring(7, authHeader.length);
	if (token !== env.ST_JUDE_SCOREBOARD_KEY) {
		throw new StatusError(403);
	}
}

router.get('/api/co-founders', async (request, env: Env) => {
	const [mykeScoreString, stephenScoreString] = await Promise.all(
		[env.RELAY_FOR_ST_JUDE.get(makeScoreKey('myke')),
			env.RELAY_FOR_ST_JUDE.get(makeScoreKey('stephen'))]
	);
	const mykeScore = mykeScoreString !== null ? Number.parseFloat(mykeScoreString) : 0;
	const stephenScore = stephenScoreString !== null ? Number.parseFloat(stephenScoreString) : 0;
	return {
		myke: {
			score: mykeScore
		},
		stephen: {
			score: stephenScore
		}
	};
});

export function isCoFounder(name: string): name is typeof CO_FOUNDERS[number] {
	return CO_FOUNDERS.includes(name as typeof CO_FOUNDERS[number]);
}

const checkCoFounder = (request: ScoreRequest) => {
	const coFounder = request.params['cofounder'].toLowerCase();
	if (!isCoFounder(coFounder)) {
		if (coFounder === 'cathy') {
			throw new StatusError(418, `Unicorns are always winners`);
		}
		throw new StatusError(400, `Who is "${coFounder}"? Smells like a coup!`);
	}
	request.coFounder = coFounder;
};

router.get('/api/co-founders/:cofounder', checkCoFounder, async (request, env: Env) => {
	const stringScore = await env.RELAY_FOR_ST_JUDE.get(makeScoreKey(request.coFounder));
	if (!stringScore) {
		return { score: 0 };
	}
	const score = Number.parseFloat(stringScore) || 0;
	return {
		score
	};
});

router.put('/api/co-founders/:cofounder', checkAuthentication, checkCoFounder, async (request, env: Env) => {
	const body = await request.json<{ score?: unknown }>();
	// Empty strings and non-existent values are disallowed, but zero is allowed
	if (!body.score && body.score != 0) {
		throw new StatusError(422, 'Updates must include a score');
	}
	if (!(typeof body.score === 'number')) {
		throw new StatusError(422, 'Scores must be a number');
	}
	await env.RELAY_FOR_ST_JUDE.put(makeScoreKey(request.coFounder), String(body.score));
	return status(204);
});

const PUSH_TOKEN_TYPES = ['widget', 'liveActivityStart', 'liveActivityUpdate'] as const;

const updateTokenRequestSchema = z.object({
	tokenType: z.enum(PUSH_TOKEN_TYPES),
	scopeId: z.string(),
	token: z.string().min(3),
})

router.put('/api/push-tokens/:deviceId', checkAuthentication, async (request, env: Env) => {
	const deviceId = request.params['deviceId'];
	const body = updateTokenRequestSchema.parse(await request.json());

	await env.WIDGET_PUSH_TOKENS.prepare(
		`INSERT INTO push_tokens (device_id, token_type, scope_id, token, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5)
		 ON CONFLICT(device_id, token_type, scope_id) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at`
	).bind(deviceId, body.tokenType, body.scopeId, body.token, new Date().toISOString()).run();

	return status(204);
});

// 404 for everything else
router.all('*', () => {
	throw new StatusError(404, ' Not Found.');
});

export default router;
